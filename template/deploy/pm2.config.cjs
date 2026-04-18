module.exports = {
  apps: [
    {
      name: "tally-holder",
      script: "start.ts",
      interpreter: "npx",
      interpreter_args: "tsx",
      cwd: __dirname + "/..",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      kill_timeout: 20000,        // allow graceful /holders/leave
      shutdown_with_message: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
