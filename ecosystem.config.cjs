// PM2 Ecosystem Configuration for Raspberry Pi 5
// This manages the live monitor process

module.exports = {
  apps: [
    {
      name: 'prediction-monitor',
      script: 'dist/index.js',
      args: 'live',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        DB_PATH: './data/live-monitor.db',
        POLL_INTERVAL_MS: '1000'
      },
      error_file: './logs/error.log',
      out_file: './logs/output.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Restart strategy
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,
      // Performance
      kill_timeout: 5000,
      listen_timeout: 3000,
      // Cron for scheduled restart (every day at 3 AM - optional)
      cron_restart: '0 3 * * *'
    }
  ]
};
