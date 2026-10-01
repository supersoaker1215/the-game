// ============================================================
// CACHE STAMP — keep index.html's ?v= and sw.js's CACHE_VERSION honest.
//
//   jsc tools/stamp-cache.js              # stamp anything that changed
//   jsc tools/stamp-cache.js -- --check   # report only, exit 1 if stale
//
// WHY THIS EXISTS. Shipping this game means editing TWO things by hand on
// every deploy: the `?v=N` on each changed file in index.html, and
// CACHE_VERSION in sw.js. The `?v=` alone is not enough — a returning player's
// service worker serves the old CODE_CACHE until CACHE_VERSION changes, so they
// stay on stale code and re-report bugs that were fixed days ago.
//
// Measured over 30 days: 42 of 343 commits that touched engine JS did not bump
// sw.js. One deploy in eight went out invisible to anyone who already had the
// page cached.
//
// NUMBERS, NOT HASHES. The obvious fix is a content hash in the query string,
// and it is wrong here: multiplayer.js derives its version handshake from these
// params with /(game|ui|multiplayer|cards|abilities)\.js\?v=(\d+)/ — digits
// only. A hash would silently break the check that warns two players they are
// on different builds. So the counter stays a counter; this just increments it
// for you.
//
// HOW IT KNOWS. tools/cache-stamp.json records the content hash each file had
// when its ?v= was last set. A file whose hash no longer matches has changed
// since it was stamped, so its ?v= goes up by one and CACHE_VERSION is bumped.
// Deterministic and idempotent: running it twice in a row changes nothing.
// ============================================================

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var CHECK_ONLY = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--check') CHECK_ONLY = true;

var MANIFEST = 'tools/cache-stamp.json';

// FNV-1a, the same one game.js uses to derive seeds. We only ever ask "is this
// byte-for-byte what it was", so collision resistance is not the job.
function hash(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

var HTML = read('index.html');

// Every `src="x.js?v=N"` / `href="x.css?v=N"` in the page, in file order.
function assets(html) {
  var out = [], re = /(src|href)="([^"]+?)\?v=(\d+)"/g, m;
  while ((m = re.exec(html))) out.push({ path: m[2], v: parseInt(m[3], 10), attr: m[1] });
  return out;
}

var list = assets(HTML);
var prev = {};
try { prev = JSON.parse(read(MANIFEST)); } catch (e) { prev = {}; }

var stale = [], next = {}, missing = [];
list.forEach(function (a) {
  var body;
  try { body = read(a.path); }
  catch (e) {
    // KEEP ITS RECORD. Returning here dropped the entry from the manifest that
    // is written moments later, so the next run found no record, took the
    // "adopt at the current ?v=" branch, and never bumped it — a real change
    // shipping with a stale ?v= and no CACHE_VERSION move. Reachable any time
    // index.html names an asset that is momentarily absent (a new file not yet
    // created, a branch without it). The old hash is carried forward untouched.
    missing.push(a.path);
    if (prev[a.path]) next[a.path] = prev[a.path];
    return;
  }
  var h = hash(body);
  var was = prev[a.path];
  // A file with no record yet is adopted at its current ?v= rather than bumped
  // — the first run stamps the status quo instead of inventing 22 deploys.
  //
  // …AND NEITHER IS A FILE SOMEBODY ALREADY BUMPED BY HAND. The hash alone
  // answers "has this changed since it was last stamped", which is NOT the
  // question the gate asks — that question is "did this change WITHOUT a ?v=
  // bump". Reading only the hash, a correct hand-fix (the path CLAUDE.md
  // documents for a co-author without the hook, or a --no-verify) was reported
  // as `STALE … changed without a ?v= bump` when it had just been bumped, and
  // the prescribed fix then burned a second number for no deploy. So the ?v= is
  // consulted too: if it has already moved past what the manifest recorded, the
  // human did the work — adopt the new hash where it stands and bump nothing.
  if (was && was.hash !== h && a.v <= was.v) {
    stale.push({ path: a.path, from: a.v, to: a.v + 1 });
    next[a.path] = { v: a.v + 1, hash: h };
  } else {
    next[a.path] = { v: a.v, hash: h };
  }
});

if (missing.length) {
  print('  index.html references files that are not here:');
  missing.forEach(function (p) { print('    ' + p); });
}

if (CHECK_ONLY) {
  print('=== CACHE STAMP ===');
  print('  versioned assets: ' + list.length);
  if (!stale.length && !missing.length) {
    print('✅ every ?v= matches the file it points at');
  } else {
    stale.forEach(function (s) {
      print('  STALE  ' + s.path + '  — changed since ?v=' + s.from + ' was set');
    });
    print('');
    // SAY WHICH PROBLEM IT IS. With only missing files this printed "❌ 0
    // file(s) changed without a ?v= bump" and threw "cache stamp stale: 0" —
    // and run-tests.sh greps for exactly that line, so "0 file(s)" was the
    // whole explanation a reader got for a failing gate.
    if (stale.length) {
      print('❌ ' + stale.length + ' file(s) changed without a ?v= bump.');
      print('   Players holding a cached service worker would not get them.');
      print('   Fix: jsc tools/stamp-cache.js');
    }
    if (missing.length) {
      print('❌ ' + missing.length + ' file(s) named by index.html are not on disk.');
      print('   Nothing can be stamped for a file that is not there.');
    }
    throw new Error('cache stamp: ' + stale.length + ' stale, ' + missing.length + ' missing');
  }
} else {
  if (!stale.length) {
    // Still write the manifest — the first run adopts the current numbers.
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      write(MANIFEST, JSON.stringify(next, null, 2) + '\n');
      print('· cache stamp: manifest adopted (' + list.length + ' assets), no ?v= changes');
    } else {
      print('· cache stamp: nothing changed');
    }
  } else {
    var html = HTML;
    stale.forEach(function (s) {
      var from = s.path + '?v=' + s.from;
      var to = s.path + '?v=' + s.to;
      html = html.split(from).join(to);
      print('  ' + s.path + '  v' + s.from + ' → v' + s.to);
    });
    write('index.html', html);

    // ONE BUMP PER DEPLOY, not one per file. The service worker only needs to
    // know the code cache is not the one it holds; which file moved is the
    // ?v='s job.
    //
    // THE NAME IS LEFT ALONE. The convention here is `clb-v935-green-gate` —
    // a counter and a human label for what shipped — and the label is worth
    // keeping: it is how you tell from a console which build a player is on.
    // So only the number moves, and whoever is committing can rename the tail
    // to describe the change (or not; the number alone is enough to bust the
    // cache). A version with no `v<N>` at all gets one appended rather than
    // being overwritten.
    var sw = read('sw.js');
    var m = sw.match(/const CACHE_VERSION = '([^']*)';/);
    if (!m) {
      print('  !! could not find CACHE_VERSION in sw.js — bump it by hand');
    } else {
      var cur = m[1], bumped;
      var vm = cur.match(/^(.*?)v(\d+)(.*)$/);
      if (vm) bumped = vm[1] + 'v' + (parseInt(vm[2], 10) + 1) + vm[3];
      else bumped = cur + '-v2';
      write('sw.js', sw.replace(/const CACHE_VERSION = '[^']*';/,
        "const CACHE_VERSION = '" + bumped + "';"));
      print('  sw.js CACHE_VERSION  ' + cur + ' → ' + bumped);
    }
    write(MANIFEST, JSON.stringify(next, null, 2) + '\n');
    print('· cache stamp: ' + stale.length + ' file(s) bumped');
  }
}
