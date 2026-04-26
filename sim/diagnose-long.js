// Diagnostic — find games that go past 25 rounds, draws, and show the
// round distribution to confirm the sim isn't making up data.
// Usage: jsc sim/diagnose-long.js -- --games 5000 --threshold 15
load('./sim/shim.js');

var __argv = (typeof arguments !== 'undefined') ? arguments : [];
var games = 5000, threshold = 15;
for (var i = 0; i < __argv.length; i++) {
  if (__argv[i] === '--games') games = parseInt(__argv[++i], 10);
  else if (__argv[i] === '--threshold') threshold = parseInt(__argv[++i], 10);
}

function snap(s) {
  function c(x) { return x ? (x.name + ' ' + x.attack + '/' + x.currentHealth) : '_'; }
  var lanes = s.lanes.map(function (l, i) {
    return '  L' + (i + 1) + (l.destroyed ? ' [DESTROYED]' : '') +
      ': P=' + c(l.player) + ' | A=' + c(l.ai);
  }).join('\n');
  return (
    'round=' + s.round + ' phase=' + s.phase +
    ' first=' + s.firstPlayer +
    ' pHP=' + s.player.health + ' aHP=' + s.ai.health +
    ' pE=' + s.player.currency + ' aE=' + s.ai.currency +
    ' pHand=[' + s.player.hand.map(function (c) { return c.name; }).join(',') + ']' +
    ' aHand=[' + s.ai.hand.map(function (c) { return c.name; }).join(',') + ']' +
    '\n' + lanes
  );
}

var found = 0;
var draws = 0;
var summaries = [];
var histogram = {};

for (var g = 0; g < games; g++) {
  var r = runSimGame(null, null, null);
  var rk = String(r.rounds);
  histogram[rk] = (histogram[rk] || 0) + 1;
  var isDraw = !r.winner;
  if (isDraw) draws++;
  if (isDraw || r.rounds > threshold) {
    found++;
    var s = Game.state;
    var boardCards = [];
    for (var i = 0; i < s.lanes.length; i++) {
      if (s.lanes[i].player) boardCards.push('P:' + s.lanes[i].player.name);
      if (s.lanes[i].ai) boardCards.push('A:' + s.lanes[i].ai.name);
    }
    summaries.push({
      rounds: r.rounds,
      winner: r.winner,
      isDraw: isDraw,
      pHp: r.playerHp,
      aHp: r.aiHp,
      board: boardCards.join('|'),
      pHand: s.player.hand.map(function (c) { return c.name; }).join(','),
      aHand: s.ai.hand.map(function (c) { return c.name; }).join(','),
    });
  }
}

print('=== ' + games + ' games; ' + draws + ' draws; ' + found + ' interesting (>' + threshold + ' rounds OR draw) ===');
print('');
// show at most 15 interesting summaries
var N = Math.min(summaries.length, 15);
for (var j = 0; j < N; j++) {
  var x = summaries[j];
  print('#' + (j + 1) + ' rounds=' + x.rounds +
    ' winner=' + (x.isDraw ? 'DRAW' : x.winner) +
    ' pHP=' + x.pHp + ' aHP=' + x.aHp);
  print('  BOARD: ' + x.board);
  print('');
}

print('=== round histogram ===');
var keys = Object.keys(histogram).map(function (k) { return parseInt(k, 10); }).sort(function (a, b) { return a - b; });
for (var ki = 0; ki < keys.length; ki++) {
  var k = keys[ki];
  print('  r=' + k + ':\t' + histogram[String(k)]);
}
