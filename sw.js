// EDGE2 service worker — app-shell caching for offline support and PWA
// installability.
//
// CACHE_NAME CARRIES THE app.js BUILD STAMP (2026-10-22). It used to be
// 'edge2-cache-v2.16.0', with a comment asking whoever changed VERSION to bump
// it; nobody did after v2.16.0. That had two effects. sw.js never changed, so
// the browser never found a new worker and the "New version available" banner
// (app.js registerServiceWorker, 'updatefound') never fired: every "reload the
// app" instruction rested on a mechanism that couldn't detect staleness. And
// the cache was never discarded, so every versioned file from every deploy
// since September accumulated. With the stamp here, each deploy changes these
// bytes, which is what makes the browser install a new worker (and fire the
// banner), and activate() drops the previous deploy's cache.
// There's no build step to inject it, so tests/sw-cache-name.test.js FAILS if
// this name and index.html's app.js?v= stamp disagree: a guard that refuses
// the divergence, not a reminder.
const CACHE_NAME = 'edge2-20261027200000';

// Unversioned entry points. The versioned scripts and styles are read from
// index.html at install (below), so the cache holds exactly what this deploy
// loads and nothing is listed by hand. The old hand list named unversioned
// paths the page never requests, and had no core/edge-scoring.js at all.
const STATIC_SHELL = ['./', './index.html', './manifest.json', './icon.svg'];
// engines/warrior/index.js is deliberately NOT precached: it's loaded by a
// dynamic import(), never a <script> tag, so a missing or broken Warrior file
// can't take down the install. It gets the same network-first/cache-fallback
// treatment as everything else below once a successful fetch has happened.

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const urls = new Set(STATIC_SHELL);
    try {
      // This deploy's own local <script src> / <link href> URLs, ?v= included,
      // so the app opens offline straight after an update.
      const html = await (await fetch('./index.html', { cache: 'no-store' })).text();
      for (const m of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
        if (!/^(?:[a-z]+:)?\/\//i.test(m[1])) urls.add('./' + m[1].replace(/^\.\//, ''));
      }
    } catch (_) { /* installed offline: the static shell only */ }
    // One at a time, not addAll: addAll is all-or-nothing, and one missing
    // file must not stop the new worker installing (that would block updates).
    await Promise.allSettled([...urls].map(u => cache.add(u)));
    await self.skipWaiting();
  })());
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
