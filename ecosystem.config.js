module.exports = {
  apps: [{
    name: 'notifications-api',
    script: 'server.js',
    cwd: '/root/id-portal/api',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '150M',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
      DB_PATH: '/root/id-portal/notifications.db',
      AUTHENTIK_URL: 'http://127.0.0.1:9000',
      AUTHENTIK_HOST: 'id-portal.duckdns.org'
    },
    error_file: '/root/.pm2/logs/notifications-api-error.log',
    out_file:   '/root/.pm2/logs/notifications-api-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
