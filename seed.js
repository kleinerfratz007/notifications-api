'use strict';
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');

const DB_PATH = process.env.DB_PATH || '/root/id-portal/notifications.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ── Schema ────────────────────────────────────────────────────────────────
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
try { db.exec(`ALTER TABLE notifications ADD COLUMN approvalRole TEXT`); } catch {}

// ── Testnutzer ────────────────────────────────────────────────────────────
const testUsers = [
  {
    username:     'akaufmann',
    displayName:  'Admin Kaufmann',
    email:        'a.kaufmann@id-engineering.com',
    specialRoles: [],   // Authentik-Admin, kein Extra-Eintrag nötig
  },
  {
    username:     'mkorte',
    displayName:  'Margot Korte',
    email:        'm.korte@id-engineering.com',
    specialRoles: ['VACATION_APPROVER'],
  },
  {
    username:     'tmueller',
    displayName:  'Thomas Müller (Abteilungsleiter)',
    email:        't.mueller@id-engineering.com',
    specialRoles: ['ORDER_APPROVER', 'EQUIPMENT_APPROVER'],
  },
  {
    username:     'lschneider',
    displayName:  'Lisa Schneider',
    email:        'l.schneider@id-engineering.com',
    specialRoles: [],
  },
  {
    username:     'fweber',
    displayName:  'Felix Weber',
    email:        'f.weber@id-engineering.com',
    specialRoles: [],
  },
  {
    username:     'akrause',
    displayName:  'Anna Krause',
    email:        'a.krause@id-engineering.com',
    specialRoles: [],
  },
];

const upsertUser = db.prepare(`
  INSERT INTO users (username, displayName, email, specialRoles)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(username) DO UPDATE SET
    displayName  = excluded.displayName,
    email        = excluded.email,
    specialRoles = CASE
      WHEN json_array_length(excluded.specialRoles) > 0 THEN excluded.specialRoles
      ELSE users.specialRoles
    END,
    updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now')
`);

// ── Beispiel-Nachrichten ──────────────────────────────────────────────────
const now = new Date();
const mins = (n) => new Date(now - n * 60000).toISOString();
const hrs  = (n) => new Date(now - n * 3600000).toISOString();
const days = (n) => new Date(now - n * 86400000).toISOString();

const notifications = [
  {
    id:          randomUUID(),
    type:        'SYSTEM',
    title:       'Wartungsfenster am Wochenende',
    message:     'Am Samstag 04:00–06:00 Uhr werden Server-Updates eingespielt. Alle Dienste sind kurzzeitig nicht erreichbar.',
    sender:      'IT-Infrastruktur',
    recipients:  'all',
    priority:    2,
    status:      'active',
    approvalRole: null,
    actionUrl:   null,
    actionLabel: null,
    createdAt:   hrs(3),
  },
  {
    id:          randomUUID(),
    type:        'ADMIN',
    title:       'Neue Reisekostenrichtlinie 2025',
    message:     'Die aktualisierte Reisekostenordnung tritt ab 01.05.2025 in Kraft. Bitte die Änderungen im Intranet lesen.',
    sender:      'Geschäftsführung',
    recipients:  'all',
    priority:    1,
    status:      'active',
    approvalRole: null,
    actionUrl:   'https://id-portal.duckdns.org/if/user/',
    actionLabel: 'Zum Intranet',
    createdAt:   days(1),
  },
  {
    id:          randomUUID(),
    type:        'APPROVAL',
    title:       'Urlaubsantrag: Lisa Schneider (14.–21. Mai)',
    message:     'Lisa Schneider beantragt 6 Urlaubstage vom 14. bis 21. Mai 2025. Saldo: 18,5 Tage. Bitte genehmigen oder ablehnen.',
    sender:      'HR-System',
    recipients:  'all',
    priority:    3,
    status:      'active',
    approvalRole: 'VACATION_APPROVER',
    actionUrl:   null,
    actionLabel: null,
    createdAt:   mins(45),
  },
  {
    id:          randomUUID(),
    type:        'APPROVAL',
    title:       'Bestellung: JetBrains All Products Pack (549 €/Jahr)',
    message:     'Felix Weber beantragt eine JetBrains-Lizenz (All Products Pack). Kostenstelle: Entwicklung. Budgetfreigabe erforderlich.',
    sender:      'Einkauf-System',
    recipients:  'all',
    priority:    2,
    status:      'active',
    approvalRole: 'ORDER_APPROVER',
    actionUrl:   null,
    actionLabel: null,
    createdAt:   hrs(2),
  },
  {
    id:          randomUUID(),
    type:        'APPROVAL',
    title:       'Hardwareanfrage: MacBook Pro 16" für Anna Krause',
    message:     'Anna Krause (Onboarding ab 01.05.) benötigt ein MacBook Pro 16" M3 (ca. 2.800 €). Gerätegenehmigung ausstehend.',
    sender:      'IT-Abteilung',
    recipients:  'all',
    priority:    2,
    status:      'active',
    approvalRole: 'EQUIPMENT_APPROVER',
    actionUrl:   null,
    actionLabel: null,
    createdAt:   hrs(5),
  },
  {
    id:          randomUUID(),
    type:        'INFO',
    title:       'Zeiterfassung: Abwesenheiten in Tagesansicht',
    message:     'Die Zeiterfassungs-App unterstützt jetzt Abwesenheiten direkt in der Tagesansicht. Einfach auf einen Zeitslot tippen.',
    sender:      'Entwicklung',
    recipients:  'all',
    priority:    0,
    status:      'active',
    approvalRole: null,
    actionUrl:   'https://id-zeiterfassung.duckdns.org/',
    actionLabel: 'Jetzt ausprobieren',
    createdAt:   days(2),
  },
  {
    id:          randomUUID(),
    type:        'INFO',
    title:       'Kaffeemaschine 3. OG außer Betrieb',
    message:     'Die Kaffeemaschine im 3. OG wird bis Freitag repariert. Bitte die Maschine im EG nutzen.',
    sender:      'Facility Management',
    recipients:  'all',
    priority:    0,
    status:      'active',
    approvalRole: null,
    actionUrl:   null,
    actionLabel: null,
    createdAt:   hrs(5),
  },
];

// ── Daten eintragen ───────────────────────────────────────────────────────
const insertUser = db.transaction((users) => {
  for (const u of users) upsertUser.run(u.username, u.displayName, u.email, JSON.stringify(u.specialRoles));
});

const insertNotif = db.prepare(`
  INSERT OR IGNORE INTO notifications
    (id, type, title, message, sender, recipients, priority, status, approvalRole, actionUrl, actionLabel, createdAt)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertNotifs = db.transaction((rows) => {
  for (const r of rows) {
    insertNotif.run(
      r.id, r.type, r.title, r.message, r.sender, r.recipients,
      r.priority, r.status, r.approvalRole, r.actionUrl, r.actionLabel, r.createdAt
    );
  }
});

insertUser(testUsers);
insertNotifs(notifications);

console.log(`✓ ${testUsers.length} Testnutzer angelegt`);
console.log(`  → Margot Korte (mkorte) → VACATION_APPROVER`);
console.log(`  → Thomas Müller (tmueller) → ORDER_APPROVER, EQUIPMENT_APPROVER`);
console.log(`✓ ${notifications.length} Beispiel-Nachrichten eingefügt`);
console.log(`  → 3× APPROVAL (VACATION, ORDER, EQUIPMENT)`);

db.close();
