// Headless game runner — JSC-compatible.
//   jsc sim/run.js -- --games 10
//   jsc sim/run.js -- --games 5000 --stats
// `arguments` is populated with values after the `--` separator.

var __SIM_ROOT_OVERRIDE = (function () {
  // When invoked as `jsc sim/run.js`, the cwd is the project root. Shim files
  // live one level up from the sim script's perspective — but JSC `load()` is
  // relative to the cwd, not the script. We just use relative paths from cwd.
  return '.';
})();

load('./sim/shim.js');
load('./sim/stats.js');

function parseArgs(argv) {
  var out = { games: 1, stats: false, quiet: false, weights: null, reportDir: './sim/data', mode: 'classic' };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--games') out.games = parseInt(argv[++i], 10);
    else if (a === '--stats') out.stats = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--weights') out.weights = argv[++i];
    else if (a === '--report-dir') out.reportDir = argv[++i];
    else if (a === '--mode') out.mode = argv[++i]; // 'classic' | 'deckbuilder'
  }
  return out;
}

// Game driving logic lives in shim.js (`runSimGame`) — it supports per-seat
// weights for the tuner, so we share the same driver here.

// ---- main ----
var __argv = (typeof arguments !== 'undefined') ? arguments : [];
var opts = parseArgs(__argv);

if (opts.weights) {
  var raw = read(opts.weights);
  var loaded = JSON.parse(raw);
  if (!AI.WEIGHTS) AI.WEIGHTS = {};
  for (var k in loaded) AI.WEIGHTS[k] = loaded[k];
  if (!opts.quiet) print('[sim] loaded weights from ' + opts.weights);
}

var collect = opts.stats ? SimStats.createCollector() : null;

// Thread the mode into runSimGame via a global the shim reads before each
// game — avoids plumbing a 4th arg through every call site.
this.SIM_MODE = opts.mode;

var t0 = Date.now();
var pWins = 0, aWins = 0, draws = 0, totalRounds = 0;
for (var g = 0; g < opts.games; g++) {
  var r = runSimGame(null, null, collect);
  if (r.winner === 'player') pWins++;
  else if (r.winner === 'ai') aWins++;
  else draws++;
  totalRounds += r.rounds;
  if (!opts.quiet && (opts.games <= 20 || (g + 1) % 250 === 0)) {
    print('[game ' + (g + 1) + '/' + opts.games + '] winner=' + r.winner + ' rounds=' + r.rounds + ' hp=P' + r.playerHp + '/A' + r.aiHp);
  }
}
var dt = (Date.now() - t0) / 1000;
var gps = (opts.games / Math.max(dt, 0.001)).toFixed(1);
print('');
print('=== ' + opts.games + ' games in ' + dt.toFixed(2) + 's (' + gps + ' g/s) ===');
print('  player-seat wins: ' + pWins + '  ai-seat wins: ' + aWins + '  draws: ' + draws);
print('  avg rounds: ' + (totalRounds / Math.max(1, opts.games)).toFixed(2));

if (collect) {
  var out = SimStats.finalize(collect);
  SimStats.writeReports(out, opts.reportDir);
  print('  stats written to ' + opts.reportDir + '/');
}
