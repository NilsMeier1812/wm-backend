module.exports = {
  apps: [{
    name: "wm-backend",
    script: "./index.js",
    max_restarts: 5,
    min_uptime: 30000 // Explizit in Millisekunden (30 Sekunden)
  }]
}