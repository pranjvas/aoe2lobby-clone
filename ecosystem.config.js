// server.js serves both the API (/api/lobbies) and the frontend, so fe_server.js is not needed.
// Start in production with: pm2 start ecosystem.config.js --env production
module.exports = {
  apps: [
    {
      name: 'server',
      script: './server.js',
      kill_timeout: 9000, // time for server.js to close cleanly on SIGINT before pm2 sends SIGKILL
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: {
        NODE_ENV: 'development',
        API_PORT: 3002,
      },
      env_production: {
        NODE_ENV: 'production',
        API_PORT: 3002,
        HOST: '127.0.0.1', // only Caddy (reverse proxy) is public
      }
    },
    {
      name: 'scraper',
      script: './scraper.js',
      autorestart: true,
      restart_delay: 15000,
      max_memory_restart: '300M', // the scraper is a plain node process (no browser)
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      }
    }
  ]
};
