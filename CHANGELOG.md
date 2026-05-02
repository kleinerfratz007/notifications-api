# Changelog — Notifications-API (id-portal/api)

## [next] — 2. Mai 2026

### Features (Konvention #8 INTER-APP-INBOX)
- **Admin-Inbox** SQLite-Tabelle (`admin_inbox`) + 5 Endpoints:
  - POST /api/admin-inbox (Service-Token, push)
  - GET /api/admin-inbox?status=... (Cookie-Auth via Authentik)
  - GET /api/admin-inbox/pending-count
  - POST /api/admin-inbox/:id/accept (atomic claim)
  - POST /api/admin-inbox/:id/reject (mit optional note)
- Allow-list 8 Apps (lms, vacation, ze, bedarfs, logistik, inventar, master-data, mibn) + Type-Whitelist
- **Email-Hook** POST /api/notifications/send:
  - nodemailer-Integration (SMTP via www684.your-server.de)
  - Pref-Check (notification_preferences) + Whitelist-Filter (MAIL_WHITELIST)
  - Default: email=OFF; User aktiviert in /portal/notifications.html
- **Listen 0.0.0.0** statt 127.0.0.1 (Container-Connectivity, Token-protected)
- ENV in ecosystem.config.js: `NOTIFICATIONS_SERVICE_TOKEN`, `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM`, `MAIL_WHITELIST`

