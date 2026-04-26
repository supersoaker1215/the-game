// Run many games, capture state of any that end in a draw (stuck games).
// Usage: jsc sim/diagnose-stall.js -- --games 20000
load('./sim/shim.js');

var games = 20000;
var __argv = (typeof arguments !== 'undefined') ? arguments : [];
for (var i = 0; i < __argv.length; i++) {
  if (__argv[i] === '--games') games = parseInt(__argv[++i], 10);
}

var draws = 0;
var captured = [];
for (var g = 0; g < games; g++) {
  var r = runSimGame(null, null, null);
  if (!r.winner) {
    draws++;
    if (captured.length < 5) {
      var s = Game.state;
      captured.push({
        round: s.round,
        phase: s.phase,
        pHP: s.player.health,
        aHP: s.ai.health,
        pendingCardChoice: !!s.pendingCardChoice,
        pendingCardChoiceTitle: s.pendingCardChoice ? s.pendingCardChoice.title : null,
        pendingLaneChoice: !!s.pendingLaneChoice,
        pendingBlockTrick: !!s.pendingBlockTrick,
        pendingKangChoice: !!s.pendingKangChoice,
        pendingJumpOffer: !!s.pendingJumpOffer,
        stolenByBWL_p: !!s.player.stolenByBWL,
        stolenByBWL_a: !!s.ai.stolenByBWL,
        _combatContinuation: !!s._combatContinuation,
        _inCombat: !!s._inCombat,
        lanes: s.lanes.map(function (l) {
          return (l.destroyed ? '[X]' : '   ') +
            ' P=' + (l.player ? l.player.name + '(' + l.player.attack + '/' + l.player.currentHealth + ')' : '_') +
            ' | A=' + (l.ai ? l.ai.name + '(' + l.ai.attack + '/' + l.ai.currentHealth + ')' : '_');
        }),
        pHand: s.player.hand.map(function (c) { return c.name; }).join(','),
        aHand: s.ai.hand.map(function (c) { return c.name; }).join(','),
      });
    }
  }
}

print('=== ' + games + ' games, ' + draws + ' draws (' + (draws * 100 / games).toFixed(3) + '%) ===');
print('');
for (var ci = 0; ci < captured.length; ci++) {
  var c = captured[ci];
  print('--- STALL #' + (ci + 1) + ' ---');
  print('round=' + c.round + ' phase=' + c.phase + ' pHP=' + c.pHP + ' aHP=' + c.aHP);
  print('pending: cardChoice=' + c.pendingCardChoice + (c.pendingCardChoiceTitle ? ' ("' + c.pendingCardChoiceTitle + '")' : '') +
        ' laneChoice=' + c.pendingLaneChoice +
        ' blockTrick=' + c.pendingBlockTrick + ' kang=' + c.pendingKangChoice +
        ' jump=' + c.pendingJumpOffer);
  print('         stolenBWL_p=' + c.stolenByBWL_p + ' stolenBWL_a=' + c.stolenByBWL_a +
        ' combatCont=' + c._combatContinuation + ' inCombat=' + c._inCombat);
  print('lanes:');
  for (var li = 0; li < c.lanes.length; li++) print('  ' + (li + 1) + ': ' + c.lanes[li]);
  print('pHand: [' + c.pHand + ']');
  print('aHand: [' + c.aHand + ']');
  print('');
}
