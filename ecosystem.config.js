// Secrets werden zur Laufzeit aus /root/id-portal/api/.env via dotenv (server.js) geladen.
// Hier dürfen NUR nicht-sensitive Defaults stehen.
module.exports = {
  apps: [{
    name: 'notifications-api',
    script: 'server.js',
    cwd: '/root/id-portal/api',
    instances: 2,
    exec_mode: 'cluster',
    autorestart: true,
    watch: false,
    max_memory_restart: '150M',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
      DB_PATH: '/root/id-portal/notifications.db',
      AUTHENTIK_URL: 'http://127.0.0.1:9000',
      AUTHENTIK_HOST: 'id-engineering-portal.com',
      MAIL_HOST: 'www684.your-server.de',
      MAIL_PORT: '587',
      MAIL_SECURE: 'false',
      MAIL_FROM: 'urlaub@id-engineering-portal.com',
      MAIL_WHITELIST: 'sartor.m@id-engineering.com'
    },
    error_file: '/root/.pm2/logs/notifications-api-error.log',
    out_file:   '/root/.pm2/logs/notifications-api-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
