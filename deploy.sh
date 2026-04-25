#!/usr/bin/env bash
# deploy.sh — Notifications-API auf Hetzner installieren und starten
# Aufruf: bash deploy.sh
set -euo pipefail

REMOTE="hetzner"
API_DIR="/root/id-portal/api"
DB_DIR="/root/id-portal"
PORTAL_PWA="/opt/portal-pwa"
NGINX_CONF="/etc/nginx/sites-available/id-portal"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== 1/6  Verzeichnisse anlegen ==="
ssh "$REMOTE" "mkdir -p '$API_DIR' '$DB_DIR'"

echo "=== 2/6  Dateien übertragen ==="
scp "$SCRIPT_DIR/server.js"          "$REMOTE:$API_DIR/"
scp "$SCRIPT_DIR/package.json"       "$REMOTE:$API_DIR/"
scp "$SCRIPT_DIR/seed.js"            "$REMOTE:$API_DIR/"
scp "$SCRIPT_DIR/ecosystem.config.js" "$REMOTE:$API_DIR/"

echo "=== 3/6  npm install (Production) ==="
ssh "$REMOTE" "cd '$API_DIR' && npm install --omit=dev"

echo "=== 4/6  Datenbank initialisieren + Beispieldaten ==="
ssh "$REMOTE" "cd '$API_DIR' && node seed.js"

echo "=== 5/6  PM2 starten / neu laden ==="
ssh "$REMOTE" "
  cd '$API_DIR'
  if pm2 list | grep -q 'notifications-api'; then
    pm2 reload ecosystem.config.js --update-env
  else
    pm2 start ecosystem.config.js
  fi
  pm2 save
"

echo "=== 6/6  Portal-PWA + Nginx aktualisieren ==="
scp "$SCRIPT_DIR/../portal-patch/index.html" "$REMOTE:$PORTAL_PWA/index.html"

# Nginx: notifications-Location-Block einfügen (falls noch nicht vorhanden)
ssh "$REMOTE" "
  if ! grep -q 'api/notifications' '$NGINX_CONF'; then
    # Vor 'location /portal/' einfügen
    sed -i '/location \/portal\//i\\
    location /api/notifications {\\
        proxy_pass http://127.0.0.1:3001;\\
        proxy_http_version 1.1;\\
        proxy_set_header Host \$host;\\
        proxy_set_header X-Real-IP \$remote_addr;\\
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;\\
        proxy_set_header X-Forwarded-Proto \$scheme;\\
        proxy_set_header Cookie \$http_cookie;\\
        proxy_connect_timeout 10s;\\
        proxy_send_timeout    30s;\\
        proxy_read_timeout    30s;\\
    }\\
' '$NGINX_CONF'
    echo '  Nginx-Config aktualisiert.'
  else
    echo '  Nginx-Config bereits vorhanden, übersprungen.'
  fi
  nginx -t && systemctl reload nginx
"

echo ""
echo "✓ Deployment abgeschlossen!"
echo "  API:    https://id-portal.duckdns.org/api/notifications"
echo "  Portal: https://id-portal.duckdns.org/portal/"
echo "  PM2:    ssh hetzner 'pm2 logs notifications-api'"
