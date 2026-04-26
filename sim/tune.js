// Cross-Entropy Method self-play weight tuner — JSC-compatible.
//   jsc sim/tune.js -- --generations 10 --pop 30 --games 40 --elite 0.2
//
// Each generation:
//   1. Sample `pop` weight sets from current (mean, stdev) Gaussians.
//   2. For each sample, play `games` games as challenger vs current champion.
//   3. Keep the top `elite` fraction (by win rate). Refit mean = mean(elite),
//      stdev = stdev(elite) (with a floor so distributions don't collapse).
//   4. The generation's best sample becomes the next champion IF it beats the
//      previous champion by ≥55% over a fresh tiebreak eval.
//
// Writes:
//   sim/data/weights-gen-N.json  — champion weights per generation
//   sim/data/weights-current.json — the running champion (load this in the browser)
//   sim/data/tune-log.md          — human-readable progress log

var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');

function parseArgs(argv) {
  var out = {
    generations: 10,
    pop: 30,
    games: 40,
    elite: 0.2,
    stdevFloor: 0.15,   // min fractional std (15% of |mean|)
    stdevInit: 0.30,    // initial fractional std (30% of |mean|)
    tiebreakGames: 80,  // games for final champion promotion eval
    tiebreakThreshold: 0.53, // challenger must win >= this fraction to dethrone
    out: './sim/data',
    seedWeights: null,  // optional starting champion JSON
  };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--generations') out.generations = parseInt(argv[++i], 10);
    else if (a === '--pop') out.pop = parseInt(argv[++i], 10);
    else if (a === '--games') out.games = parseInt(argv[++i], 10);
    else if (a === '--elite') out.elite = parseFloat(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--seed') out.seedWeights = argv[++i];
  }
  return out;
}

// Box-Muller Gaussian.
function randn() {
  var u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Sample a full weight set from (mean, stdev) dicts. Uses fractional stdev —
// stdev[k] is fraction of |mean[k]|, so big-valued weights move proportionally.
function sampleWeights(mean, stdev) {
  var w = {};
  for (var k in mean) {
    var s = Math.abs(mean[k]) * stdev[k];
    w[k] = mean[k] + randn() * s;
  }
  return w;
}

function meanOf(arr) {
  var s = 0;
  for (var i = 0; i < arr.length; i++) s += arr[i];
  return arr.length ? s / arr.length : 0;
}
function stdevOf(arr, m) {
  if (arr.length < 2) return 0;
  var s = 0;
  for (var i = 0; i < arr.length; i++) { var d = arr[i] - m; s += d * d; }
  return Math.sqrt(s / (arr.length - 1));
}

function cloneW(w) {
  var o = {};
  for (var k in w) o[k] = w[k];
  return o;
}

// Play K games with challenger on one seat, champion on the other; return
// challenger's wins (ties broken by HP diff). To neutralize first-player
// advantage, alternate seats so challenger plays player K/2 times and ai K/2.
function evalPair(challenger, champion, games) {
  var wins = 0, totalGames = 0;
  var half = Math.floor(games / 2);
  for (var i = 0; i < half; i++) {
    var r = runSimGame(challenger, champion, null);
    totalGames++;
    if (r.winner === 'player') wins++;
    else if (r.winner === null) {
      if (r.playerHp > r.aiHp) wins++;
    }
  }
  for (var j = 0; j < games - half; j++) {
    var r2 = runSimGame(champion, challenger, null);
    totalGames++;
    if (r2.winner === 'ai') wins++;
    else if (r2.winner === null) {
      if (r2.aiHp > r2.playerHp) wins++;
    }
  }
  return wins / Math.max(1, totalGames);
}

// ---- main ----
var __argv = (typeof arguments !== 'undefined') ? arguments : [];
var opts = parseArgs(__argv);

// Seed: current AI.WEIGHTS (or loaded file).
var mean = cloneW(AI.WEIGHTS);
if (opts.seedWeights) {
  var seed = JSON.parse(read(opts.seedWeights));
  for (var k in seed) mean[k] = seed[k];
  print('[tune] seeded from ' + opts.seedWeights);
}

var stdev = {};
for (var k in mean) stdev[k] = opts.stdevInit;

var champion = cloneW(mean);
writeFile(opts.out + '/weights-gen-0.json', JSON.stringify(champion, null, 2));
writeFile(opts.out + '/weights-current.json', JSON.stringify(champion, null, 2));

var logLines = [];
logLines.push('# CEM Tuning Log');
logLines.push('');
logLines.push('Generations: ' + opts.generations + ' | Pop: ' + opts.pop + ' | Games/sample: ' + opts.games + ' | Elite: ' + opts.elite);
logLines.push('');
logLines.push('| Gen | Best WR | Mean WR | Elite WR | Champion swap? | Time |');
logLines.push('|---:|---:|---:|---:|:---:|---:|');

var tStart = Date.now();
for (var gen = 1; gen <= opts.generations; gen++) {
  var tGen = Date.now();
  // 1. Sample population.
  var samples = [];
  for (var p = 0; p < opts.pop; p++) {
    var w = sampleWeights(mean, stdev);
    var wr = evalPair(w, champion, opts.games);
    samples.push({ weights: w, wr: wr });
    if ((p + 1) % 5 === 0) print('  [gen ' + gen + '] sample ' + (p + 1) + '/' + opts.pop + ' wr=' + wr.toFixed(3));
  }
  samples.sort(function (a, b) { return b.wr - a.wr; });
  var best = samples[0];
  var meanWr = 0;
  for (var si = 0; si < samples.length; si++) meanWr += samples[si].wr;
  meanWr /= samples.length;

  // 2. Elite fit.
  var eliteN = Math.max(2, Math.round(samples.length * opts.elite));
  var elite = samples.slice(0, eliteN);
  var eliteWr = 0;
  for (var ei = 0; ei < elite.length; ei++) eliteWr += elite[ei].wr;
  eliteWr /= elite.length;

  var newMean = {}, newStdev = {};
  for (var key in mean) {
    var vals = elite.map(function (e) { return e.weights[key]; });
    var m = meanOf(vals);
    var sRaw = stdevOf(vals, m);
    var floor = Math.abs(m) * opts.stdevFloor;
    newMean[key] = m;
    // Convert to fractional stdev (how we store it), with floor.
    newStdev[key] = Math.max(opts.stdevFloor, sRaw / Math.max(0.01, Math.abs(m)));
    if (newStdev[key] < opts.stdevFloor) newStdev[key] = opts.stdevFloor;
  }
  mean = newMean;
  stdev = newStdev;

  // 3. Promote champion if the gen's best meaningfully beats current champion.
  var promoted = false;
  if (best.wr > 0.5) {
    var tieWr = evalPair(best.weights, champion, opts.tiebreakGames);
    if (tieWr >= opts.tiebreakThreshold) {
      champion = cloneW(best.weights);
      promoted = true;
      writeFile(opts.out + '/weights-current.json', JSON.stringify(champion, null, 2));
    }
  }
  writeFile(opts.out + '/weights-gen-' + gen + '.json', JSON.stringify(mean, null, 2));

  var dt = ((Date.now() - tGen) / 1000).toFixed(1);
  logLines.push('| ' + gen + ' | ' + (best.wr * 100).toFixed(1) + '% | ' + (meanWr * 100).toFixed(1) + '% | ' +
    (eliteWr * 100).toFixed(1) + '% | ' + (promoted ? 'YES' : '—') + ' | ' + dt + 's |');
  print('[gen ' + gen + '/' + opts.generations + '] best=' + (best.wr * 100).toFixed(1) + '% mean=' + (meanWr * 100).toFixed(1) +
    '% elite=' + (eliteWr * 100).toFixed(1) + '% swap=' + promoted + ' dt=' + dt + 's');

  // Incrementally write the log so you can tail it during a long run.
  writeFile(opts.out + '/tune-log.md', logLines.join('\n'));
}

var total = ((Date.now() - tStart) / 1000).toFixed(1);
print('');
print('=== tuning complete in ' + total + 's ===');
print('  champion weights: ' + opts.out + '/weights-current.json');
print('  per-generation means: ' + opts.out + '/weights-gen-N.json');
print('  log: ' + opts.out + '/tune-log.md');
