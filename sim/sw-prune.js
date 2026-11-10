// ============================================================
// THE SERVICE WORKER KEEPS ONE COPY OF EACH ASSET.
//
//   jsc sim/sw-prune.js
//
// Art and audio are cache-first, keyed by the full URL including ?v=. Every
// art-version bump stored a second full copy of every file and nothing removed
// the first. This runs the REAL sw.js against a fake Cache Storage and drives
// its own activate and fetch handlers.
// ============================================================
var ORIGIN = 'https://game.test';
// --- minimal browser surface sw.js touches -------------------------------
function URLx(u) {
  var m = /^(https?:\/\/[^\/]+)(\/[^?#]*)?(\?[^#]*)?/.exec(u);
  this.origin = m[1]; this.pathname = m[2] || '/'; this.search = m[3] || '';
}
var URL = URLx;
function Resp(body) { this.ok = true; this.type = 'basic'; this.body = body; }
Resp.prototype.clone = function () { return new Resp(this.body); };
function FakeCache() { this.map = {}; }
FakeCache.prototype.put = function (req, res) { this.map[typeof req === 'string' ? req : req.url] = res; return Promise.resolve(); };
FakeCache.prototype.match = function (req) { return Promise.resolve(this.map[typeof req === 'string' ? req : req.url]); };
FakeCache.prototype.keys = function () { var self = this; return Promise.resolve(Object.keys(self.map).map(function (u) { return { url: u }; })); };
FakeCache.prototype.delete = function (req, opts) {
  var u = typeof req === 'string' ? req : req.url, self = this, hit = false;
  var base = u.split('?')[0];
  Object.keys(self.map).forEach(function (k) {
    if (opts && opts.ignoreSearch ? k.split('?')[0] === base : k === u) { delete self.map[k]; hit = true; }
  });
  return Promise.resolve(hit);
};
var STORE = {};
var caches = {
  open: function (n) { return Promise.resolve(STORE[n] = STORE[n] || new FakeCache()); },
  keys: function () { return Promise.resolve(Object.keys(STORE)); },
  delete: function (n) { delete STORE[n]; return Promise.resolve(true); },
  match: function (req) { var u = req.url || req; for (var n in STORE) if (STORE[n].map[u]) return Promise.resolve(STORE[n].map[u]); return Promise.resolve(undefined); },
};
var FETCHED = [];
function fetch(req) { FETCHED.push(req.url); return Promise.resolve(new Resp('net:' + req.url)); }
var HANDLERS = {};
var self = { location: { origin: ORIGIN }, addEventListener: function (t, f) { HANDLERS[t] = f; },
             skipWaiting: function () { return Promise.resolve(); }, clients: { claim: function () { return Promise.resolve(); } } };
load('./sw.js');
function drain() { for (var i = 0; i < 50; i++) drainMicrotasks(); }
function keysOf(n) { return Object.keys((STORE[n] || { map: {} }).map).sort(); }

var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

// --- 1. activate sweeps copies already stranded in a player's cache -------
var A = 'clb-assets-v1';
caches.open(A); drain();
['/audio/cards/art/Yoda.png?v=99', '/audio/cards/art/Yoda.png?v=100', '/audio/cards/art/Yoda.png?v=98',
 '/audio/cards/art-md/Yoda.jpg?v=100', '/audio/cards/mahoraga-hover.mp3?v=4', '/icon.svg'].forEach(function (p) {
  STORE[A].map[ORIGIN + p] = new Resp(p);
});
STORE['clb-v1-old'] = new FakeCache();
HANDLERS.activate({ waitUntil: function (p) { this.p = p; } }); drain();
var after = keysOf(A).map(function (u) { return u.replace(ORIGIN, ''); });
check('activate keeps only the newest ?v= of each asset',
      after.join(' | ') === '/audio/cards/art-md/Yoda.jpg?v=100 | /audio/cards/art/Yoda.png?v=100 | /audio/cards/mahoraga-hover.mp3?v=4 | /icon.svg',
      after.join(' | '));
check('…and still drops old code caches', !STORE['clb-v1-old']);

// --- 2. fetching a new version replaces the old one ---------------------
function get(path) {
  var ev = { request: { method: 'GET', url: ORIGIN + path, mode: 'no-cors' }, respondWith: function (p) { this.p = p; } };
  HANDLERS.fetch(ev); drain(); return ev.p;
}
get('/audio/cards/art/Ultron 2.png?v=100'); drain();
check('a first fetch is stored', keysOf(A).indexOf(ORIGIN + '/audio/cards/art/Ultron 2.png?v=100') >= 0);
get('/audio/cards/art/Ultron 2.png?v=101'); drain();
var ul = keysOf(A).filter(function (u) { return u.indexOf('Ultron 2.png') >= 0; });
check('a new ?v= replaces the old copy instead of sitting beside it', ul.length === 1 && /v=101$/.test(ul[0]), ul.join(', '));
var n0 = FETCHED.length; get('/audio/cards/art/Ultron 2.png?v=101'); drain();
check('a cached asset is still served without going to the network', FETCHED.length === n0);
check('other files are untouched', keysOf(A).indexOf(ORIGIN + '/audio/cards/art-md/Yoda.jpg?v=100') >= 0);

print('sw-prune: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('sw-prune failed');
