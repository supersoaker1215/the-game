// ============================================================
// REPRODUCIBLE AUDITS — one master seed per run, Math.random re-seeded per
// scenario.
//
// The engine seeds every match from Math.random (startMatch / start2v2Match),
// so an unseeded audit is a different game each run: a crash it finds once
// may never come back. Each scenario re-seeds Math.random from
// hash(master seed, scenario key), so any single scenario replays exactly —
// on its own, without running the ones before it:
//
//   jsc sim/<audit>.js -- --seed <N> --only '<scenario key>'
//
// Usage in an audit (after load('./sim/shim-real.js')):
//   load('./sim/audit-seed.js');
//   AuditSeed.init(argv, 'sim/ownership2v2.js');
//   if (!AuditSeed.scenario(key)) return;   // re-seeds; false = filtered out by --only
//   ... run it ...
//   AuditSeed.check(key, findingsBefore, findings.length);
//   AuditSeed.report();                     // prints [AUDIT-SEED] + [REPLAY] lines
// ============================================================
var AuditSeed = (function () {
  var S = { master: 0, only: null, file: '', failed: [], originalRandom: Math.random };
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(str) {   // FNV-1a, 32-bit
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  S.init = function (argv, file) {
    S.file = file;
    for (var i = 0; i < argv.length; i++) {
      if (argv[i] === '--seed') S.master = (Number(argv[i + 1]) >>> 0);
      if (argv[i] === '--only') S.only = String(argv[i + 1]);
    }
    var given = false;
    for (var j = 0; j < argv.length; j++) if (argv[j] === '--seed') given = true;
    if (!given) S.master = (S.originalRandom() * 4294967296) >>> 0;
    return S;
  };
  // Re-seed Math.random for this scenario. Returns false when --only excludes it.
  S.scenario = function (key) {
    if (S.only !== null && S.only !== key) return false;
    Math.random = mulberry32(hash(S.master + '|' + key));
    return true;
  };
  S.check = function (key, before, after) { if (after > before && S.failed.indexOf(key) < 0) S.failed.push(key); };
  S.replayCommand = function (key) {
    return 'jsc ' + S.file + ' -- --seed ' + S.master + " --only '" + key.replace(/'/g, "'\\''") + "'";
  };
  S.report = function () {
    print('[AUDIT-SEED] ' + S.file + ' master seed = ' + S.master + (S.only !== null ? '  (only: ' + S.only + ')' : ''));
    S.failed.slice(0, 8).forEach(function (k) { print('[REPLAY] ' + S.replayCommand(k)); });
    if (S.failed.length > 8) print('[REPLAY] … ' + (S.failed.length - 8) + ' more failing scenarios (same seed)');
  };
  return S;
})();
