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
      CONFIG_ENCRYPTION_KEY: '07ed660927371848e2546dc97da3ce0e2a3bbf3f24137fc042e82ea7c7aa2b8d',
      CONFIG_SERVICE_TOKEN:  '4bfa5733bfc6b2313a3432b5ba11c51472f1abedea1c2a33e0d9b55fb063f8b3',
      // Email-Hook (Konvention #8 INTER-APP-INBOX)
      NOTIFICATIONS_SERVICE_TOKEN: '04a681ab3ddcae14decfadfc0c8d3e010b1855f6e38c1a774ff8559a17e8fdf4',
      MAIL_HOST: 'www684.your-server.de',
      MAIL_PORT: '587',
      MAIL_SECURE: 'false',
      MAIL_USER: 'urlaub@id-engineering-portal.com',
      MAIL_PASSWORD: 'hetSpencer82+',
      MAIL_FROM: 'urlaub@id-engineering-portal.com',
      MAIL_WHITELIST: 'sartor.m@id-engineering.com'
    },
    error_file: '/root/.pm2/logs/notifications-api-error.log',
    out_file:   '/root/.pm2/logs/notifications-api-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
