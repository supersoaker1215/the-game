// Head-to-head difficulty measurement — JSC-compatible.
//   jsc sim/difficulty.js -- --games 400 --a hard --b normal
//
// WHY THIS EXISTS. AI.difficulty() used to read one global setting, so both
// seats in a simulated match always played at the SAME difficulty and the
// question "is hard actually harder than normal?" could not be asked at all.
// With difficulty per-seat, this sits one setting opposite another and reports
// the win rate, so a claim about the AI being smarter is falsifiable.
//
// Seats are SWAPPED every other game: the two sides of this board are not
// symmetric (one of them moves first), so a fixed assignment measures the
// first-player advantage as much as the difficulty.
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');

function parseArgs(argv) {
  var o = { games: 200, a: 'hard', b: 'normal' };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--games') o.games = parseInt(argv[++i], 10);
    else if (argv[i] === '--a') o.a = argv[++i];
    else if (argv[i] === '--b') o.b = argv[++i];
  }
  return o;
}
var opts = parseArgs((typeof arguments !== 'undefined') ? arguments : []);

var aWins = 0, bWins = 0, draws = 0;
for (var g = 0; g < opts.games; g++) {
  // Swap which physical seat carries A so the first-move edge cancels out.
  var aSeat = (g % 2 === 0) ? 'ai' : 'player';
  var bSeat = (aSeat === 'ai') ? 'player' : 'ai';
  AI._diffOverride = {};
  AI._diffOverride[aSeat] = opts.a;
  AI._diffOverride[bSeat] = opts.b;
  var r = runSimGame(null, null, null);      // the shim's own driver
  if (r.winner === aSeat) aWins++;
  else if (r.winner === bSeat) bWins++;
  else draws++;
}
AI._diffOverride = null;
var decided = aWins + bWins;
var rate = decided ? (aWins / decided) : 0;
print('games        : ' + opts.games + '  (decided ' + decided + ', draws ' + draws + ')');
print(opts.a + ' wins    : ' + aWins);
print(opts.b + ' wins    : ' + bWins);
print(opts.a + ' winrate : ' + (rate * 100).toFixed(1) + '%');
// A 50% result means the two settings are indistinguishable on this board.
print('');
print(Math.abs(rate - 0.5) < 0.03
  ? '=> indistinguishable from a coin flip at this sample size.'
  : '=> ' + opts.a + ' is ' + ((rate - 0.5) * 100).toFixed(1) + 'pp ' + (rate > 0.5 ? 'stronger' : 'weaker') + ' than ' + opts.b + '.');
