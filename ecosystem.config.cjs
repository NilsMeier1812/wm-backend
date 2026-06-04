module.exports = {
  apps: [
    {
      name: "wm-backend-prod",
      script: "./index.js",
      env: { NODE_ENV: "prod" },
      max_restarts: 5,
      min_uptime: 30000
    },
    {
      name: "wm-backend-dev",
      script: "./index.js",
      env: { NODE_ENV: "dev" },
      max_restarts: 5,
      min_uptime: 30000
    }
  ]
}