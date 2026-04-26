// Service worker — offline-first cache for Card Lane Battle.
// Bump CACHE_VERSION whenever app shell assets change so clients
// evict the old bundle on next activate. Asset-specific cache-bust
// query strings (?v=N) already force re-download of individual
// JS/CSS files; this worker wraps everything else (index.html,
// manifest, icon, audio) in a named cache for offline play.
const CACHE_VERSION = 'clb-v2-multi';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GETs for the same origin. Leave everything else
  // (POST analytics, cross-origin font CDN, etc.) to the network.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network-first for versioned JS/CSS (the `?v=N` query param
  // guarantees the URL changes on content update, so a network hit
  // is rare but worth trying for freshness). Falls back to the
  // cached copy offline.
  const isVersioned = url.search.includes('v=');
  if (isVersioned) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for everything else (app shell, audio, images).
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      // Only cache successful same-origin responses.
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
