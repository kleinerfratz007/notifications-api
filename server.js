'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || '/root/id-portal/notifications.db';
const AUTHENTIK_INTERNAL = process.env.AUTHENTIK_URL || 'http://127.0.0.1:9000';
const AUTHENTIK_HOST = process.env.AUTHENTIK_HOST || 'id-portal.duckdns.org';

app.use(express.json());

// ── Database Schema ───────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
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
`);

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
    const u = await r.json();

    // Sonderrollen aus lokaler DB laden
    const dbUser = db.prepare('SELECT specialRoles FROM users WHERE username = ?').get(u.username);
    let specialRoles = [];
    if (dbUser) {
      try { specialRoles = JSON.parse(dbUser.specialRoles); } catch {}
    }

    // Nutzerprofil ggf. anlegen/aktualisieren (ohne Rollen zu überschreiben)
    db.prepare(`
      INSERT INTO users (username, displayName, email, specialRoles)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        displayName = excluded.displayName,
        email       = excluded.email,
        updatedAt   = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(u.username, u.name || u.username, u.email || '', JSON.stringify(specialRoles));

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

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[notifications-api] Läuft auf 127.0.0.1:${PORT}`);
});
