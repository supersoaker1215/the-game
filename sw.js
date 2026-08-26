// Service worker — fresh-first cache for Card Lane Battle.
// For an actively-developed multiplayer game, having one side run
// stale code while the other has the latest = silent desync. We
// trade a little offline reliability for "always fresh on reload":
// HTML + JS + CSS are network-first (cached only as a fallback for
// genuinely offline visits). Audio/images/manifest stay cache-first
// since they rarely change and are heavy to re-download.
// TWO CACHES, NOT ONE. Previously a single CACHE_VERSION held BOTH the
// versioned code and the heavy static assets, and `activate` deleted every
// cache whose key wasn't the current version — so EVERY DEPLOY threw away the
// entire audio and card-art cache and forced a full re-download of tens of MB,
// even though none of it had changed. Splitting them means a code deploy
// refreshes code and leaves the assets alone.
//   CODE_CACHE  — bumped on every deploy (that's the point: fresh code).
//   ASSET_CACHE — bumped ONLY when the art/audio themselves change.
const CACHE_VERSION = 'clb-v557-menu-icons';
const CODE_CACHE  = CACHE_VERSION;
const ASSET_CACHE = 'clb-assets-v1';
const APP_SHELL = [
  './manifest.webmanifest',
  './icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(ASSET_CACHE).then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      // Keep BOTH live caches; sweep only genuinely stale ones (old code
      // versions, and any asset cache from a previous asset generation).
      Promise.all(keys
        .filter((k) => k !== CODE_CACHE && k !== ASSET_CACHE)
        .map((k) => caches.delete(k)))
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
  // MEDIA IS NOT CODE. This used to be a bare `url.search.includes('v=')`,
  // which is true for any query string containing those two characters — and
  // card audio is stamped `?cv=<n>` (ui.js:3144) while card art is stamped
  // `?v=<n>` (ui.js ~227). Both matched, so every image and every audio file
  // took the network-first branch below and was written into CODE_CACHE...
  // which `activate` deletes on EVERY deploy. Net effect: ~100 MB of art and
  // audio re-downloaded after every single deploy, and served from the network
  // during play instead of from cache. ASSET_CACHE only ever held the 2-entry
  // app shell. The header comment at the top of this file claims "audio/images
  // stay cache-first" — that was true for nothing the game actually loads.
  // Versioning only means "this is code that changes on deploy" for the three
  // extensions that actually are code.
  const isVersionedCode = url.search.includes('v=') &&
    (url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.html'));
  const isJsCss = url.pathname.endsWith('.js') || url.pathname.endsWith('.css');
  // Sim-data JSON files (sim/data/**/*.json) get re-generated on
  // every 20K-game run. The stats panel's "Reload Sim" button
  // re-fetches them; without network-first JSON, the SW served the
  // cached copy and the user saw stale runs in the SIM RUN HISTORY
  // panel after running a fresh sim. User report: "I'm reloading
  // the SIM, and it's not There."
  const isJson = url.pathname.endsWith('.json');
  if (isHtml || isVersionedCode || isJsCss || isJson) {
    event.respondWith(
      fetch(req).then((res) => {
        // Cache the fresh response so it's available offline next time.
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CODE_CACHE).then((c) => c.put(req, copy));
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
        // Heavy, rarely-changing media lands in the ASSET cache so a code
        // deploy can never evict it.
        caches.open(ASSET_CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
