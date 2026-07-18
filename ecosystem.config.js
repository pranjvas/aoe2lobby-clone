module.exports = {
  apps: [
    {
      name: 'server',
      script: './server.js',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      }
    },
    {
      name: 'scraper',
      script: './scraper.js',
      autorestart: true,
      watch: false,
      restart_delay: 15000,
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      }
    },
    {
      name: 'fe_server',
      script: './fe_server.js',
      env: {
        NODE_ENV: 'development',
        PORT: 8080,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 8080,
      }
    }
  ]
};
