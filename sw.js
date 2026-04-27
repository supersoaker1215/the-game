// Service worker — fresh-first cache for Card Lane Battle.
// For an actively-developed multiplayer game, having one side run
// stale code while the other has the latest = silent desync. We
// trade a little offline reliability for "always fresh on reload":
// HTML + JS + CSS are network-first (cached only as a fallback for
// genuinely offline visits). Audio/images/manifest stay cache-first
// since they rarely change and are heavy to re-download.
const CACHE_VERSION = 'clb-v3-fresh';
const APP_SHELL = [
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

  // Network-first for HTML + versioned JS/CSS — these are the files
  // that change with every deploy. We try the network first so a
  // fresh deploy reaches the client immediately on next page load.
  // Falls back to cache only if the network is genuinely unreachable.
  const isHtml = req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  const isVersioned = url.search.includes('v=');
  const isJsCss = url.pathname.endsWith('.js') || url.pathname.endsWith('.css');
  if (isHtml || isVersioned || isJsCss) {
    event.respondWith(
      fetch(req).then((res) => {
        // Cache the fresh response so it's available offline next time.
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for static assets that rarely change (audio, icons,
  // manifest). These are heavy to re-download and updates are rare.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
