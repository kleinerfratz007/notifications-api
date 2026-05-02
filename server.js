'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const nodemailer = require('nodemailer');

// ── Email-Transport (SMTP) ────────────────────────────────────────────────
// Mail-Whitelist: Notifications gehen NUR an Adressen, die in MAIL_WHITELIST stehen.
// Default: nur sartor.m@id-engineering.com (bis Mail-Lockdown aufgehoben wird).
const MAIL_WHITELIST = (process.env.MAIL_WHITELIST || 'sartor.m@id-engineering.com')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

const SERVICE_TOKEN = process.env.NOTIFICATIONS_SERVICE_TOKEN || '';

let mailTransport = null;
function getMailTransport() {
  if (mailTransport) return mailTransport;
  if (!process.env.MAIL_HOST) return null;
  mailTransport = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: parseInt(process.env.MAIL_PORT || '587', 10),
    secure: process.env.MAIL_SECURE === 'true',
    auth: process.env.MAIL_USER ? {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASSWORD,
    } : undefined,
  });
  return mailTransport;
}

const app = express();
const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || '/root/id-portal/notifications.db';
const AUTHENTIK_INTERNAL = process.env.AUTHENTIK_URL || 'http://127.0.0.1:9000';
const AUTHENTIK_HOST = process.env.AUTHENTIK_HOST || 'id-engineering-portal.com';

app.use(express.json());

// ── Database Schema ───────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS notification_preferences (
    id          TEXT PRIMARY KEY,
    username    TEXT NOT NULL,
    sourceApp   TEXT NOT NULL,           -- "lms"|"vacation"|"logistik"|...
    channel     TEXT NOT NULL,           -- "inbox"|"email"
    enabled     INTEGER NOT NULL DEFAULT 1,
    updatedAt   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(username, sourceApp, channel)
  );
  CREATE INDEX IF NOT EXISTS idx_notif_prefs_user ON notification_preferences(username);

  CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL DEFAULT 'INFO'
                  CHECK(type IN ('SYSTEM','ADMIN','APPROVAL','INFO')),
    title       TEXT NOT NULL,
    message     TEXT,
    sender      TEXT NOT NULL DEFAULT 'System',
    recipients  TEXT NOT NULL DEFAULT 'all',
    priority    INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'active'
                  CHECK(status IN ('active','approved','rejected','archived')),
    actionUrl   TEXT,
    actionLabel TEXT,
    approvalRole TEXT,
    createdAt   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS notification_reads (
    notificationId TEXT NOT NULL,
    username       TEXT NOT NULL,
    readAt         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (notificationId, username)
  );
  CREATE TABLE IF NOT EXISTS users (
    username     TEXT PRIMARY KEY,
    displayName  TEXT NOT NULL DEFAULT '',
    email        TEXT NOT NULL DEFAULT '',
    specialRoles TEXT NOT NULL DEFAULT '[]',
    updatedAt    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS admin_inbox (
    id           TEXT PRIMARY KEY,
    fromApp      TEXT NOT NULL,
    fromUserId   TEXT,
    fromUserName TEXT,
    type         TEXT NOT NULL,
    payload      TEXT NOT NULL,
    refUrl       TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    createdAt    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    reviewedAt   TEXT,
    reviewedBy   TEXT,
    reviewNote   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_admin_inbox_status ON admin_inbox(status, createdAt);
  CREATE INDEX IF NOT EXISTS idx_admin_inbox_app    ON admin_inbox(fromApp, type);
`);


// Migration: api_config table
try {
  db.exec(`
  CREATE TABLE IF NOT EXISTS api_config (
    key        TEXT PRIMARY KEY,
    enc_value  TEXT NOT NULL,
    label      TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);
} catch {}

// Migration: approvalRole column (für bestehende DBs)
try { db.exec(`ALTER TABLE notifications ADD COLUMN approvalRole TEXT`); } catch {}

// ── Sonderrollen-Definitionen ─────────────────────────────────────────────
const SPECIAL_ROLES = {
  VACATION_APPROVER:  'Urlaubsgenehmiger',
  ORDER_APPROVER:     'Bestellgenehmiger',
  EQUIPMENT_APPROVER: 'Gerätegenehmiger',
  IT_APPROVER:        'IT-Anfragengenehmiger',
  HR_APPROVER:        'HR-Genehmiger',
};

// ── Auth via Authentik-Session-Cookie ─────────────────────────────────────
async function authenticate(req, res, next) {
  const cookie = req.headers.cookie || '';
  if (!cookie) return res.status(401).json({ error: 'Nicht angemeldet' });
  try {
    const r = await fetch(`${AUTHENTIK_INTERNAL}/api/v3/core/users/me/`, {
      headers: { cookie, host: AUTHENTIK_HOST }
    });
    if (!r.ok) return res.status(401).json({ error: 'Sitzung ungültig' });
    const raw = await r.json(); const u = raw.user || raw;

    // Sonderrollen aus lokaler DB laden
    const dbUser = db.prepare('SELECT specialRoles FROM users WHERE username = ?').get(u.username);
    let specialRoles = [];
    if (dbUser) {
      try { specialRoles = JSON.parse(dbUser.specialRoles); } catch {}
    }

    // Nutzerprofil ggf. anlegen/aktualisieren (ohne Rollen zu überschreiben)
    // Robuster Fallback (Konvention §0.1 Security): Authentik kann je nach Backend
    // null-Werte für name/email liefern. Schema verlangt NOT NULL.
    const safeUsername    = u.username || u.email || `unknown-${Date.now()}`;
    const safeDisplayName = u.name || u.username || u.email || 'Unbekannt';
    const safeEmail       = u.email || '';
    db.prepare(`
      INSERT INTO users (username, displayName, email, specialRoles)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        displayName = excluded.displayName,
        email       = excluded.email,
        updatedAt   = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(safeUsername, safeDisplayName, safeEmail, JSON.stringify(specialRoles));

    req.user = {
      username:     u.username,
      email:        u.email,
      name:         u.name || u.username,
      isAdmin:      u.is_superuser === true,
      specialRoles,
    };
    next();
  } catch (err) {
    console.error('Auth-Fehler:', err.message);
    return res.status(503).json({ error: 'Auth-Dienst nicht erreichbar' });
  }
}

// ── Berechtigung: Kann dieser User eine APPROVAL-Nachricht aktionieren? ───
function canActOnApproval(user, notif) {
  if (user.isAdmin) return true;
  if (!notif.approvalRole) return false;
  return user.specialRoles.includes(notif.approvalRole);
}

// ── Sichtbarkeit: APPROVAL nur für Admins + Rolleninhaber ─────────────────
function isVisibleTo(notif, user) {
  const username = typeof user === 'string' ? user : user.username;
  if (notif.type === 'APPROVAL') {
    if (typeof user === 'object') {
      if (user.isAdmin) return true;
      if (notif.approvalRole && user.specialRoles?.includes(notif.approvalRole)) return true;
      return false;
    }
    return true; // Fallback (nur username bekannt)
  }
  if (notif.recipients === 'all') return true;
  try {
    return JSON.parse(notif.recipients).includes(username);
  } catch { return false; }
}

// ── GET /api/notifications ────────────────────────────────────────────────
app.get('/api/notifications', authenticate, (req, res) => {
  const { type, unread, limit = 50 } = req.query;
  const { username } = req.user;

  const rows = db.prepare(`
    SELECT n.*,
      CASE WHEN r.username IS NOT NULL THEN 1 ELSE 0 END AS isRead,
      r.readAt AS readAt
    FROM notifications n
    LEFT JOIN notification_reads r
      ON r.notificationId = n.id AND r.username = ?
    WHERE n.status IN ('active','approved','rejected')
    ORDER BY n.priority DESC, n.createdAt DESC
    LIMIT ?
  `).all(username, Math.min(parseInt(limit) || 50, 200));

  let result = rows
    .filter(row => isVisibleTo(row, req.user))
    .map(row => ({
      ...row,
      isRead:       row.isRead === 1,
      canAct:       row.type === 'APPROVAL' && row.status === 'active' && canActOnApproval(req.user, row),
    }));

  if (type) result = result.filter(r => r.type === type);
  if (unread === '1') result = result.filter(r => !r.isRead);

  res.json(result);
});

// ── GET /api/notifications/unread-count ──────────────────────────────────
app.get('/api/notifications/unread-count', authenticate, (req, res) => {
  const { username } = req.user;
  const rows = db.prepare(`
    SELECT n.id, n.recipients, n.type, n.approvalRole
    FROM notifications n
    LEFT JOIN notification_reads r
      ON r.notificationId = n.id AND r.username = ?
    WHERE n.status = 'active' AND r.username IS NULL
  `).all(username);
  const count = rows.filter(r => isVisibleTo(r, req.user)).length;
  res.json({ count });
});

// ── GET /api/notifications/roles ─────────────────────────────────────────
app.get('/api/notifications/roles', authenticate, (req, res) => {
  res.json(SPECIAL_ROLES);
});

// ── GET /api/notifications/me ─────────────────────────────────────────────
app.get('/api/notifications/me', authenticate, (req, res) => {
  res.json({
    username:     req.user.username,
    name:         req.user.name,
    isAdmin:      req.user.isAdmin,
    specialRoles: req.user.specialRoles,
  });
});

// ── POST /api/notifications (Admin only) ─────────────────────────────────
app.post('/api/notifications', authenticate, (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Nur Admins können Nachrichten erstellen' });
  }
  const {
    type = 'INFO', title, message,
    recipients = 'all', priority = 0,
    actionUrl, actionLabel, approvalRole
  } = req.body;

  if (!title?.trim()) return res.status(400).json({ error: 'Titel ist Pflicht' });

  const id = randomUUID();
  const recipientsStr = recipients === 'all' ? 'all' : JSON.stringify(recipients);
  db.prepare(`
    INSERT INTO notifications
      (id, type, title, message, sender, recipients, priority, actionUrl, actionLabel, approvalRole)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, type, title.trim(), message?.trim() || null,
     req.user.name, recipientsStr, priority,
     actionUrl || null, actionLabel || null,
     approvalRole || null);

  const notif = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
  res.status(201).json(notif);
});

// ── PATCH /api/notifications/read-all ────────────────────────────────────
app.patch('/api/notifications/read-all', authenticate, (req, res) => {
  const { username } = req.user;
  const rows = db.prepare(`
    SELECT n.id, n.recipients, n.type, n.approvalRole
    FROM notifications n
    LEFT JOIN notification_reads r
      ON r.notificationId = n.id AND r.username = ?
    WHERE n.status = 'active' AND r.username IS NULL
  `).all(username);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO notification_reads (notificationId, username) VALUES (?, ?)`
  );
  const insertAll = db.transaction((items) => {
    let count = 0;
    for (const row of items) {
      if (isVisibleTo(row, req.user)) { insert.run(row.id, username); count++; }
    }
    return count;
  });
  const marked = insertAll(rows);
  res.json({ ok: true, marked });
});

// ── PATCH /api/notifications/:id/read ────────────────────────────────────
app.patch('/api/notifications/:id/read', authenticate, (req, res) => {
  const { id } = req.params;
  const notif = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
  if (!notif) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!isVisibleTo(notif, req.user)) return res.status(403).json({ error: 'Kein Zugriff' });
  db.prepare(
    `INSERT OR IGNORE INTO notification_reads (notificationId, username) VALUES (?, ?)`
  ).run(id, req.user.username);
  res.json({ ok: true });
});

// ── PATCH /api/notifications/:id/action ──────────────────────────────────
app.patch('/api/notifications/:id/action', authenticate, (req, res) => {
  const { id } = req.params;
  const { action } = req.body; // 'approve' | 'reject'
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action muss approve oder reject sein' });
  }
  const notif = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
  if (!notif) return res.status(404).json({ error: 'Nicht gefunden' });
  if (notif.type !== 'APPROVAL') return res.status(400).json({ error: 'Keine Genehmigungsanfrage' });
  if (!canActOnApproval(req.user, notif)) {
    return res.status(403).json({ error: 'Keine Berechtigung für diese Genehmigung' });
  }
  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  db.prepare('UPDATE notifications SET status = ? WHERE id = ?').run(newStatus, id);
  db.prepare(
    `INSERT OR IGNORE INTO notification_reads (notificationId, username) VALUES (?, ?)`
  ).run(id, req.user.username);
  res.json({ ok: true, status: newStatus });
});

// ── DELETE /api/notifications/:id (Admin only) ───────────────────────────
app.delete('/api/notifications/:id', authenticate, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Nur Admins' });
  const info = db.prepare(`UPDATE notifications SET status = 'archived' WHERE id = ?`).run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json({ ok: true });
});

// ── Admin: GET /api/notifications/admin/users ────────────────────────────
app.get('/api/notifications/admin/users', authenticate, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Nur Admins' });
  const users = db.prepare(`SELECT username, displayName, email, specialRoles, updatedAt FROM users ORDER BY displayName`).all();
  res.json(users.map(u => ({
    ...u,
    specialRoles: (() => { try { return JSON.parse(u.specialRoles); } catch { return []; } })()
  })));
});

// ── Admin: PATCH /api/notifications/admin/users/:username/roles ───────────
app.patch('/api/notifications/admin/users/:username/roles', authenticate, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Nur Admins' });
  const { username } = req.params;
  const { specialRoles } = req.body;
  if (!Array.isArray(specialRoles)) return res.status(400).json({ error: 'specialRoles muss ein Array sein' });

  const valid = specialRoles.filter(r => Object.keys(SPECIAL_ROLES).includes(r));
  db.prepare(`
    INSERT INTO users (username, specialRoles)
    VALUES (?, ?)
    ON CONFLICT(username) DO UPDATE SET
      specialRoles = excluded.specialRoles,
      updatedAt    = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(username, JSON.stringify(valid));

  res.json({ ok: true, username, specialRoles: valid });
});


// ── AES-256-GCM Verschlüsselung für API-Keys ──────────────────────────────
const crypto = require('crypto');
const CONFIG_ENCRYPTION_KEY = Buffer.from(
  process.env.CONFIG_ENCRYPTION_KEY || '0'.repeat(64), 'hex'
);
const CONFIG_SERVICE_TOKEN = process.env.CONFIG_SERVICE_TOKEN || '';

const PROVIDERS = {
  google_vision:    { label: 'Google Cloud Vision API Key',   envKey: 'GOOGLE_VISION_API_KEY' },
  anthropic:        { label: 'Anthropic (Claude AI) API Key', envKey: 'ANTHROPIC_API_KEY'     },
  dhl:              { label: 'DHL API Key',                   envKey: 'DHL_API_KEY'           },
  ups_client_id:    { label: 'UPS Client ID',                 envKey: 'UPS_CLIENT_ID'         },
  ups_client_secret:{ label: 'UPS Client Secret',             envKey: 'UPS_CLIENT_SECRET'     },
};

function cfgEncrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CONFIG_ENCRYPTION_KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({
    iv:      iv.toString('hex'),
    tag:     cipher.getAuthTag().toString('hex'),
    data:    enc.toString('hex'),
  });
}

function cfgDecrypt(encJson) {
  const { iv, tag, data } = JSON.parse(encJson);
  const dec = crypto.createDecipheriv('aes-256-gcm', CONFIG_ENCRYPTION_KEY, Buffer.from(iv, 'hex'));
  dec.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([dec.update(Buffer.from(data, 'hex')), dec.final()]).toString('utf8');
}

function cfgMask(value) {
  if (!value || value.length <= 4) return '••••';
  return '•'.repeat(Math.min(value.length - 4, 12)) + value.slice(-4);
}

function cfgGetDecrypted(key) {
  const row = db.prepare('SELECT enc_value FROM api_config WHERE key = ?').get(key);
  if (!row) return null;
  try { return cfgDecrypt(row.enc_value); } catch { return null; }
}

function cfgGetOrEnv(key) {
  const fromDb = cfgGetDecrypted(key);
  if (fromDb && fromDb !== 'PLACEHOLDER') return fromDb;
  const envKey = PROVIDERS[key]?.envKey;
  return envKey ? (process.env[envKey] || null) : null;
}

async function cfgTestProvider(providerKey) {
  const value = cfgGetOrEnv(providerKey);
  if (!value || value === 'PLACEHOLDER') return { ok: false, message: 'Kein API-Key konfiguriert.' };
  try {
    if (providerKey === 'google_vision') {
      const r = await fetch(
        `https://vision.googleapis.com/v1/images:annotate?key=${value}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ image: { content: '' }, features: [{ type: 'TEXT_DETECTION', maxResults: 1 }] }] }) }
      );
      const body = await r.json();
      // Empty image error means auth worked
      if (r.status === 400 && body.error?.status === 'INVALID_ARGUMENT') return { ok: true, message: 'Key gültig (Google Vision erreichbar).' };
      if (r.status === 403) return { ok: false, message: 'Key ungültig oder API nicht aktiviert.' };
      return { ok: r.ok, message: `Status: ${r.status}` };
    }
    if (providerKey === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': value, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
      if (r.status === 401) return { ok: false, message: 'Key ungültig.' };
      if (r.ok || r.status === 400) return { ok: true, message: 'Key gültig (Anthropic erreichbar).' };
      return { ok: false, message: `Status: ${r.status}` };
    }
    if (providerKey === 'dhl') {
      const r = await fetch('https://api-eu.dhl.com/track/shipments?trackingNumber=test', {
        headers: { 'DHL-API-Key': value },
      });
      if (r.status === 400 || r.status === 404) return { ok: true, message: 'Key gültig (DHL erreichbar).' };
      if (r.status === 401) return { ok: false, message: 'Key ungültig.' };
      return { ok: false, message: `Status: ${r.status}` };
    }
    return { ok: false, message: 'Kein Test-Endpoint für diesen Provider.' };
  } catch (err) {
    return { ok: false, message: `Verbindungsfehler: ${err.message}` };
  }
}

// ── Middleware: Service-Token (für interne Service-zu-Service Calls) ───────
function requireServiceToken(req, res, next) {
  const token = req.headers['x-service-token'];
  if (!CONFIG_SERVICE_TOKEN || token === CONFIG_SERVICE_TOKEN) return next();
  res.status(403).json({ error: 'Service-Token ungültig.' });
}

// ── GET /api/admin/config ─────────────────────────────────────────────────
app.get('/api/admin/config', authenticate, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Nur für Admins.' });
  const rows = db.prepare('SELECT key, label, updated_at FROM api_config').all();
  const result = {};
  for (const [k, p] of Object.entries(PROVIDERS)) {
    const row = rows.find(r => r.key === k);
    let masked = '(nicht gesetzt)';
    let hasValue = false;
    if (row) {
      try {
        const plain = cfgDecrypt(row.enc_value);
        if (plain && plain !== 'PLACEHOLDER') {
          masked = cfgMask(plain);
          hasValue = true;
        }
      } catch {}
    } else {
      // Check env fallback
      const envVal = process.env[p.envKey];
      if (envVal && envVal !== 'PLACEHOLDER') {
        masked = cfgMask(envVal) + ' (aus .env)';
        hasValue = true;
      }
    }
    result[k] = {
      label:      p.label,
      masked,
      hasValue,
      updatedAt:  row?.updated_at || null,
      source:     row ? 'db' : (process.env[p.envKey] && process.env[p.envKey] !== 'PLACEHOLDER' ? 'env' : 'none'),
    };
  }
  res.json(result);
});

// ── POST /api/admin/config ────────────────────────────────────────────────
app.post('/api/admin/config', authenticate, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Nur für Admins.' });
  const { key, value } = req.body;
  if (!key || !PROVIDERS[key]) return res.status(400).json({ error: 'Unbekannter Key.' });
  if (!value || typeof value !== 'string') return res.status(400).json({ error: 'Wert fehlt.' });
  const enc = cfgEncrypt(value.trim());
  const label = PROVIDERS[key].label;
  db.prepare(`
    INSERT INTO api_config (key, enc_value, label) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET enc_value = excluded.enc_value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(key, enc, label);
  res.json({ ok: true, key, masked: cfgMask(value.trim()) });
});

// ── DELETE /api/admin/config/:key ─────────────────────────────────────────
app.delete('/api/admin/config/:key', authenticate, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Nur für Admins.' });
  const { key } = req.params;
  if (!PROVIDERS[key]) return res.status(400).json({ error: 'Unbekannter Key.' });
  db.prepare('DELETE FROM api_config WHERE key = ?').run(key);
  res.json({ ok: true });
});

// ── POST /api/admin/config/test/:provider ─────────────────────────────────
app.post('/api/admin/config/test/:provider', authenticate, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Nur für Admins.' });
  const { provider } = req.params;
  if (!PROVIDERS[provider]) return res.status(400).json({ error: 'Unbekannter Provider.' });
  const result = await cfgTestProvider(provider);
  res.json(result);
});

// ── GET /api/admin/config/raw/:key — Nur mit Service-Token ───────────────
app.get('/api/admin/config/raw/:key', requireServiceToken, (req, res) => {
  const { key } = req.params;
  const value = cfgGetOrEnv(key);
  if (!value) return res.status(404).json({ error: 'Key nicht konfiguriert.' });
  res.json({ key, value });
});

// ── GET /api/admin/config/all-raw — Alle Keys für Services ───────────────
app.get('/api/admin/config/all-raw', requireServiceToken, (req, res) => {
  const result = {};
  for (const key of Object.keys(PROVIDERS)) {
    const value = cfgGetOrEnv(key);
    if (value) result[key] = value;
  }
  res.json(result);
});


// ── Start ─────────────────────────────────────────────────────────────────

// ── GET /api/admin/portal-info ────────────────────────────────────────────
// Aggregiert Live-Daten fuer die Portal-Info-Seite (User-Wunsch 2026-05-01)
// LOC pro App, System-Status, Conventions, Git-Log
const { execSync } = require('child_process');
const fsync = require('fs');

function safeExec(cmd, fallback = '') {
  try { return execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim(); }
  catch (e) { return fallback; }
}

function countLoc(rootPath, extensions) {
  const extFlags = extensions.map(e => `-name '*${e}'`).join(' -o ');
  const cmd = `find ${rootPath} -type f -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.next/*" \\( ${extFlags} \\) 2>/dev/null | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}'`;
  const out = safeExec(cmd, '0');
  return parseInt(out, 10) || 0;
}

app.get('/api/admin/portal-info', authenticate, (req, res) => {
  try {
    // 1) LOC pro App
    const loc = {
      zeiterfassung: countLoc('/root/zeiterfassung/src', ['.ts', '.tsx', '.css', '.js']),
      lms_backend: countLoc('/opt/lms/apps/backend/src', ['.ts']),
      lms_frontend: countLoc('/opt/lms/apps/frontend/src', ['.ts', '.tsx', '.css']),
      inventar: countLoc('/opt/inventar/src', ['.ts', '.tsx', '.css']),
      logistik: countLoc('/opt/id-logistik/src', ['.ts', '.tsx', '.css']),
      vacation_backend: countLoc('/opt/vacation-app/apps/backend/src', ['.ts']),
      vacation_frontend: countLoc('/opt/vacation-app/apps/frontend/src', ['.ts', '.tsx', '.css']),
      master_data: countLoc('/opt/master-data-service/src', ['.ts', '.tsx', '.css']),
      bedarfsanmeldung: countLoc('/opt/bedarfsanmeldung', ['.ts', '.tsx']),
      portal: parseInt(safeExec('wc -l < /opt/portal-pwa/index.html', '0'), 10) || 0,
      notifications_api: countLoc('/root/id-portal/api', ['.js']),
      ocr_service: countLoc('/root/ocr-service', ['.js']),
      scansnap: parseInt(safeExec('wc -l < /opt/scansnap-service/server.js', '0'), 10) || 0,
    };
    const totalLoc = Object.values(loc).reduce((a, b) => a + b, 0);

    // 2) System status
    const dfOut = safeExec('df -h / | tail -1');
    const dfParts = dfOut.split(/\s+/);
    const memOut = safeExec('free -m | grep Mem:');
    const memParts = memOut.split(/\s+/);
    const uptime = safeExec('uptime -p');
    const containers = safeExec('docker ps --format "{{.Names}}|{{.Status}}|{{.Image}}" | head -25').split('\n').filter(Boolean).map(l => {
      const [name, status, image] = l.split('|');
      return { name, status, image };
    });

    // 3) Conventions: read APP_CONVENTION.md headlines
    let conventions = [];
    try {
      const conv = fsync.readFileSync('/opt/id-portal-shared/conventions/APP_CONVENTION.md', 'utf-8');
      // Extract numbered conventions (### N. or N.)
      const matches = conv.match(/^\d+\.\s+\*\*([^:*]+)/gm) || [];
      conventions = matches.slice(0, 12).map(m => m.replace(/^\d+\.\s+\*\*/, '').replace(/\*\*$/, '').trim());
    } catch (_) {}

    // 4) Recent commits per repo
    const repos = [
      { name: 'LMS', path: '/opt/lms' },
      { name: 'Zeiterfassung', path: '/root/zeiterfassung' },
      { name: 'Portal-PWA', path: '/opt/portal-pwa' },
      { name: 'Bedarfsanmeldung', path: '/opt/bedarfsanmeldung' },
      { name: 'Inventar', path: '/opt/inventar' },
      { name: 'Logistik', path: '/opt/id-logistik' },
      { name: 'Vacation', path: '/opt/vacation-app' },
      { name: 'Master-Data', path: '/opt/master-data-service' },
    ];
    const releases = {};
    for (const r of repos) {
      const out = safeExec(`cd ${r.path} && git log --pretty=format:'%h|%ar|%an|%s' -5 2>/dev/null`);
      releases[r.name] = out.split('\n').filter(Boolean).map(l => {
        const [hash, when, author, subject] = l.split('|');
        return { hash, when, author, subject };
      });
    }

    res.json({
      timestamp: new Date().toISOString(),
      loc,
      totalLoc,
      system: {
        disk: { filesystem: dfParts[0], size: dfParts[1], used: dfParts[2], avail: dfParts[3], usePercent: dfParts[4], mount: dfParts[5] },
        memory: { totalMb: parseInt(memParts[1], 10), usedMb: parseInt(memParts[2], 10), freeMb: parseInt(memParts[3], 10) },
        uptime,
        containers,
      },
      conventions,
      releases,
    });
  } catch (err) {
    console.error('portal-info error:', err);
    res.status(500).json({ error: err.message });
  }
});



// ── GET /api/notifications/preferences ───────────────────────────────────
// Liefert User-Notification-Preferences (alle Apps + Channels)
// Default: inbox=ON, email=OFF
app.get('/api/notifications/preferences', authenticate, (req, res) => {
  try {
    const username = req.user.username;
    const rows = db.prepare('SELECT sourceApp, channel, enabled FROM notification_preferences WHERE username=?').all(username);
    // Standard-Apps
    const apps = ['lms', 'bedarfsanmeldung', 'vacation', 'logistik', 'inventar', 'master-data', 'zeiterfassung'];
    const channels = ['inbox', 'email'];
    const result = {};
    for (const app of apps) {
      result[app] = {};
      for (const ch of channels) {
        const found = rows.find(r => r.sourceApp === app && r.channel === ch);
        // Default: inbox=true, email=false
        result[app][ch] = found ? !!found.enabled : (ch === 'inbox');
      }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/notifications/preferences ──────────────────────────────────
// Body: { sourceApp: "lms", channel: "email", enabled: true }
app.post('/api/notifications/preferences', authenticate, (req, res) => {
  try {
    const username = req.user.username;
    const { sourceApp, channel, enabled } = req.body || {};
    if (!sourceApp || !channel || typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'sourceApp + channel + enabled (bool) required' });
    }
    db.prepare(`
      INSERT INTO notification_preferences (id, username, sourceApp, channel, enabled, updatedAt)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(username, sourceApp, channel)
      DO UPDATE SET enabled=excluded.enabled, updatedAt=CURRENT_TIMESTAMP
    `).run(randomUUID(), username, sourceApp, channel, enabled ? 1 : 0);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ── POST /api/notifications/send ──────────────────────────────────────────
// Service-Token-protected. Body: { recipientUsername, sourceApp, subject, body, refUrl? }
// Wenn user-pref(sourceApp,email)=ON UND email in WHITELIST -> SMTP-Mail.
// Wenn user-pref=OFF -> 200 mit "skipped:disabled".
app.post('/api/notifications/send', (req, res) => {
  const token = req.headers['x-service-token'];
  if (!SERVICE_TOKEN || token !== SERVICE_TOKEN) {
    return res.status(403).json({ error: 'Invalid service token' });
  }
  const { recipientUsername, sourceApp, subject, body, refUrl } = req.body || {};
  if (!recipientUsername || !sourceApp || !subject || !body) {
    return res.status(400).json({ error: 'recipientUsername+sourceApp+subject+body required' });
  }
  // 1) Pref-Check: ist email-Channel fuer diese sourceApp aktiviert?
  const pref = db.prepare('SELECT enabled FROM notification_preferences WHERE username=? AND sourceApp=? AND channel=?')
    .get(recipientUsername, sourceApp, 'email');
  // Default: email=OFF (kein Eintrag = OFF)
  const emailEnabled = pref?.enabled === 1;
  if (!emailEnabled) {
    return res.json({ ok: true, skipped: 'disabled', reason: `User ${recipientUsername} hat email fuer ${sourceApp} aus oder kein Eintrag.` });
  }

  // 2) User-Email aus users-Tabelle (per Authentik gesynced)
  const user = db.prepare('SELECT email, displayName FROM users WHERE username=?').get(recipientUsername);
  if (!user || !user.email) {
    return res.status(404).json({ error: 'User has no email on record' });
  }
  const recipientEmail = user.email.toLowerCase();

  // 3) Mail-Whitelist (Mail-Lockdown bis Whitelist aufgehoben)
  if (!MAIL_WHITELIST.includes(recipientEmail)) {
    return res.json({ ok: true, skipped: 'whitelist', reason: `Email ${recipientEmail} nicht in MAIL_WHITELIST.` });
  }

  // 4) SMTP
  const transport = getMailTransport();
  if (!transport) {
    return res.status(503).json({ error: 'No SMTP transport configured' });
  }
  const fromAddress = process.env.MAIL_FROM || 'no-reply@id-engineering-portal.com';
  const linkLine = refUrl ? `\n\nDirekt-Link: https://id-engineering-portal.com${refUrl}` : '';
  const fullBody = body + linkLine + '\n\n— ID Portal Benachrichtigungen';

  transport.sendMail({
    from: fromAddress,
    to: recipientEmail,
    subject: subject,
    text: fullBody,
  }).then(info => {
    res.json({ ok: true, sent: true, messageId: info.messageId });
  }).catch(err => {
    res.status(500).json({ error: 'SMTP send failed: ' + err.message });
  });
});


// ── Admin-Inbox (Konvention #8 — central) ────────────────────────────────
const ADMIN_ALLOWED_FROM_APPS = ['lms', 'bedarfsanmeldung', 'logistik', 'inventar', 'master-data', 'vacation', 'zeiterfassung', 'mibn'];
const ADMIN_ALLOWED_TYPES = {
  lms: ['aiCorrection', 'aiAnomaly'],
  vacation: ['escalation', 'expiredApproval'],
  zeiterfassung: ['timeBookingError', 'pauseAlert'],
  bedarfsanmeldung: ['urgentRequest'],
  logistik: ['returnIssue'],
  inventar: ['stockShortage'],
  'master-data': ['syncError'],
  mibn: ['missionEscalation'],
};

function adminTokenCheck(req, res) {
  const token = req.headers['x-service-token'];
  if (!SERVICE_TOKEN || token !== SERVICE_TOKEN) {
    res.status(403).json({ error: 'Invalid service token' });
    return false;
  }
  return true;
}

// POST /api/admin-inbox  (service-token, push)
app.post('/api/admin-inbox', (req, res) => {
  if (!adminTokenCheck(req, res)) return;
  const body = req.body || {};
  const { fromApp, fromUserId, fromUserName, type, payload, refUrl } = body;
  if (!ADMIN_ALLOWED_FROM_APPS.includes(fromApp)) {
    return res.status(400).json({ error: 'fromApp must be one of: ' + ADMIN_ALLOWED_FROM_APPS.join(', ') });
  }
  if (typeof type !== 'string' || !type || type.length > 50) {
    return res.status(400).json({ error: 'type must be non-empty string' });
  }
  const allowed = ADMIN_ALLOWED_TYPES[fromApp];
  if (allowed && !allowed.includes(type)) {
    return res.status(400).json({ error: "type '" + type + "' not allowed for app '" + fromApp + "'" });
  }
  if (payload === null || payload === undefined || typeof payload !== 'object') {
    return res.status(400).json({ error: 'payload must be non-null object' });
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO admin_inbox (id, fromApp, fromUserId, fromUserName, type, payload, refUrl) VALUES (?,?,?,?,?,?,?)`)
    .run(id, fromApp, fromUserId || null, fromUserName || null, type, JSON.stringify(payload), refUrl || null);
  res.status(201).json({ id });
});

// GET /api/admin-inbox  (cookie-auth + admin-only via authenticate helper if exists)
app.get('/api/admin-inbox', async (req, res) => {
  // Reuse cookie-based auth like /api/notifications/preferences
  const cookie = req.headers.cookie || '';
  if (!cookie) return res.status(401).json({ error: 'Nicht angemeldet' });
  try {
    const r = await fetch(AUTHENTIK_INTERNAL + '/api/v3/core/users/me/', { headers: { cookie, host: AUTHENTIK_HOST } });
    if (!r.ok) return res.status(401).json({ error: 'Sitzung ungueltig' });
    const raw = await r.json();
    const u = raw.user || raw;
    // Optional: check admin rolle. For now: alle eingeloggten User.
    const status = req.query.status || null;
    const rows = status
      ? db.prepare('SELECT * FROM admin_inbox WHERE status=? ORDER BY createdAt DESC LIMIT 100').all(status)
      : db.prepare('SELECT * FROM admin_inbox ORDER BY createdAt DESC LIMIT 100').all();
    // Parse payload JSON
    const items = rows.map(r => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : {} }));
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin-inbox/pending-count', async (req, res) => {
  const cookie = req.headers.cookie || '';
  if (!cookie) return res.status(401).json({ error: 'Nicht angemeldet' });
  const r = await fetch(AUTHENTIK_INTERNAL + '/api/v3/core/users/me/', { headers: { cookie, host: AUTHENTIK_HOST } });
  if (!r.ok) return res.status(401).json({ error: 'Sitzung ungueltig' });
  const row = db.prepare('SELECT COUNT(*) AS n FROM admin_inbox WHERE status=?').get('pending');
  res.json({ count: row.n });
});

app.post('/api/admin-inbox/:id/accept', async (req, res) => {
  const cookie = req.headers.cookie || '';
  if (!cookie) return res.status(401).json({ error: 'Nicht angemeldet' });
  const r = await fetch(AUTHENTIK_INTERNAL + '/api/v3/core/users/me/', { headers: { cookie, host: AUTHENTIK_HOST } });
  if (!r.ok) return res.status(401).json({ error: 'Sitzung ungueltig' });
  const raw = await r.json();
  const u = raw.user || raw;
  const username = u.username;
  const id = req.params.id;
  // Atomic claim
  const result = db.prepare(`UPDATE admin_inbox SET status='accepted', reviewedAt=strftime('%Y-%m-%dT%H:%M:%fZ','now'), reviewedBy=?, reviewNote='akzeptiert' WHERE id=? AND status='pending'`).run(username, id);
  if (result.changes === 0) {
    const exists = db.prepare('SELECT id FROM admin_inbox WHERE id=?').get(id);
    if (!exists) return res.status(404).json({ error: 'Not found' });
    return res.status(400).json({ error: 'Already reviewed' });
  }
  const updated = db.prepare('SELECT * FROM admin_inbox WHERE id=?').get(id);
  res.json({ ...updated, payload: updated.payload ? JSON.parse(updated.payload) : {} });
});

app.post('/api/admin-inbox/:id/reject', async (req, res) => {
  const cookie = req.headers.cookie || '';
  if (!cookie) return res.status(401).json({ error: 'Nicht angemeldet' });
  const r = await fetch(AUTHENTIK_INTERNAL + '/api/v3/core/users/me/', { headers: { cookie, host: AUTHENTIK_HOST } });
  if (!r.ok) return res.status(401).json({ error: 'Sitzung ungueltig' });
  const raw = await r.json();
  const u = raw.user || raw;
  const username = u.username;
  const id = req.params.id;
  const note = req.body?.note || null;
  const result = db.prepare(`UPDATE admin_inbox SET status='rejected', reviewedAt=strftime('%Y-%m-%dT%H:%M:%fZ','now'), reviewedBy=?, reviewNote=? WHERE id=? AND status='pending'`).run(username, note, id);
  if (result.changes === 0) {
    const exists = db.prepare('SELECT id FROM admin_inbox WHERE id=?').get(id);
    if (!exists) return res.status(404).json({ error: 'Not found' });
    return res.status(400).json({ error: 'Already reviewed' });
  }
  const updated = db.prepare('SELECT * FROM admin_inbox WHERE id=?').get(id);
  res.json({ ...updated, payload: updated.payload ? JSON.parse(updated.payload) : {} });
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`[notifications-api] Läuft auf 127.0.0.1:${PORT}`);
});
