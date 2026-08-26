// EDGE2 service worker — app-shell caching for offline support and PWA
// installability. Bump CACHE_NAME whenever VERSION changes in app.js (same
// pattern as the "Bump ?v=" cache-busting comment in index.html) so old
// caches get cleared on activate rather than accumulating.
const CACHE_NAME = 'edge2-cache-v2.9.3-phase2-dev1';
const APP_SHELL = [
  './',
  './index.html',
  './core/clock.js',
  './core/indicators.js',
  './core/api-client.js',
  './core/market-data.js',
  './core/news.js',
  './core/store.js',
  './core/universe.js',
  './shell/registry.js',
  './app.js',
  './styles.css',
  './manifest.json',
  './icon.svg',
];
// engines/warrior/index.js is deliberately NOT listed here. cache.addAll()
// below is all-or-nothing — if any one URL in this list 404s, the whole
// service worker install fails. Phase 2's acceptance explicitly requires
// the app to keep working when that file is missing or broken; putting it
// in a list where its absence would take down offline caching for
// everything else would work against that, not support it. It's fetched
// live via dynamic import() same as any other request, and gets the same
// network-first/cache-fallback treatment as everything else below once a
// successful fetch has happened at least once.

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for same-origin GET requests, so a fresh deploy is picked up
// immediately whenever the phone is online, falling back to the cached app
// shell when offline. Cross-origin requests (Alpaca, Groq, Supabase, CDN
// scripts/fonts) are left untouched — never cached, always network, so
// trading data is never served stale from Cache Storage.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
