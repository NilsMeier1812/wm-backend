// Standard Service Worker für PWA-Installierbarkeit
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass-Through: Für echtes Offline-Caching müsstest du hier
  // die relevanten Netzwerk-Requests abfangen und cachen.
});