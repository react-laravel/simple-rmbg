module.exports = {
  apps: [
    {
      name: 'simple-rmbg-nextjs',
      script: 'npm',
      args: 'run start',
      cwd: process.env.PM2_CWD || process.env.APP_ROOT,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      combine_logs: true,
      autorestart: true,
      max_restarts: 5,
      min_uptime: '30s',
      max_memory_restart: '3G',
      watch: false,
      ignore_watch: ['node_modules', 'logs', '.next', 'models', '.cache'],
      restart_delay: 3000,
    },
  ],
}
