# Notifications API — Entwicklerdokumentation

## Architektur

- **Typ**: Node.js/Express REST-API
- **Laufzeit**: PM2, 2 Cluster-Instanzen (`notifications-api`)
- **Quellcode**: `/root/id-portal/api/`
- **DB**: SQLite (`/root/notifications.db`)
- **Ecosystem**: `/root/id-portal/api/ecosystem.config.js`

## Wichtige Konfiguration

```javascript
// ecosystem.config.js
env: {
  AUTHENTIK_HOST: 'id-engineering-portal.com',
  PORT: 3001,
  ...
}
```

```javascript
// server.js
const AUTHENTIK_HOST = process.env.AUTHENTIK_HOST || 'id-engineering-portal.com';
```

`AUTHENTIK_HOST` wird verwendet, um Authentik-Sessions zu validieren (Cookie-Forwarding an Authentik).

## Deploy-Anleitung

```bash
ssh hetzner
cd /root/id-portal/api

# Bei Code-Änderungen: npm install falls nötig
npm install

# PM2 neustarten
pm2 restart notifications-api --update-env

# Logs
pm2 logs notifications-api --lines 50
```

## Domain-Migration-Historie

- `AUTHENTIK_HOST` war `id-portal.duckdns.org` → jetzt `id-engineering-portal.com`
- Nach Änderung immer `pm2 restart notifications-api --update-env`
