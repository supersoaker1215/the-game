// Verify coin flip is working + investigate seat bias.
// Usage: jsc sim/diagnose-seat.js -- --games 5000
load('./sim/shim.js');

var games = 5000;
var __argv = (typeof arguments !== 'undefined') ? arguments : [];
for (var i = 0; i < __argv.length; i++) {
  if (__argv[i] === '--games') games = parseInt(__argv[++i], 10);
}

var r1FirstPlayer = 0, r1FirstAI = 0;
// Cross-tab: wins broken down by who went first in round 1.
var stats = {
  playerFirst: { playerWin: 0, aiWin: 0, draw: 0 },
  aiFirst:     { playerWin: 0, aiWin: 0, draw: 0 },
};

// Patch startRound to capture round-1 firstPlayer before anything else runs.
var origStartRound = Game.startRound;
Game.startRound = function () {
  var r = this.state.round + 1;
  origStartRound.apply(this, arguments);
  if (r === 1) {
    this.state._simRound1First = this.state.firstPlayer;
  }
};

for (var g = 0; g < games; g++) {
  var r = runSimGame(null, null, null);
  var firstR1 = Game.state._simRound1First;
  if (firstR1 === 'player') r1FirstPlayer++;
  else if (firstR1 === 'ai') r1FirstAI++;

  var bucket = firstR1 === 'player' ? stats.playerFirst : stats.aiFirst;
  if (r.winner === 'player') bucket.playerWin++;
  else if (r.winner === 'ai') bucket.aiWin++;
  else bucket.draw++;
}

print('=== ' + games + ' games ===');
print('');
print('Round 1 first-player distribution:');
print('  player first: ' + r1FirstPlayer + ' (' + (r1FirstPlayer * 100 / games).toFixed(1) + '%)');
print('  AI first:     ' + r1FirstAI + ' (' + (r1FirstAI * 100 / games).toFixed(1) + '%)');
print('');
print('Wins when PLAYER goes first in R1:');
var pf = stats.playerFirst;
var pfN = pf.playerWin + pf.aiWin + pf.draw;
print('  player wins: ' + pf.playerWin + ' (' + (pf.playerWin * 100 / pfN).toFixed(1) + '%)');
print('  AI wins:     ' + pf.aiWin + ' (' + (pf.aiWin * 100 / pfN).toFixed(1) + '%)');
print('  draws:       ' + pf.draw);
print('');
print('Wins when AI goes first in R1:');
var af = stats.aiFirst;
var afN = af.playerWin + af.aiWin + af.draw;
print('  player wins: ' + af.playerWin + ' (' + (af.playerWin * 100 / afN).toFixed(1) + '%)');
print('  AI wins:     ' + af.aiWin + ' (' + (af.aiWin * 100 / afN).toFixed(1) + '%)');
print('  draws:       ' + af.draw);
