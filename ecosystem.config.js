// server.js serves both the API (/api/lobbies) and the frontend, so fe_server.js is not needed.
// Start in production with: pm2 start ecosystem.config.js --env production
module.exports = {
  apps: [
    {
      name: 'server',
      script: './server.js',
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
      max_memory_restart: '1200M', // recycle if Chrome leaks memory
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
        PUPPETEER_NO_SANDBOX: '1', // Ubuntu 24.04 blocks Chrome's sandbox for unprivileged users
      }
    }
  ]
};
