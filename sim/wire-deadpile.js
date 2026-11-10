// ============================================================
// DEAD PILES ON THE WIRE — sent once, slim mid-match.
//
//   jsc sim/wire-deadpile.js
//
// Owner: "one of the biggest problems … lag when the game goes on for longer."
// Measured 2026-11-10 (sim, 2v2, teams kept alive to round 24): every host
// broadcast grew 28KB -> 88-97KB, ~43% of it dead piles — serialized TWICE,
// because in 2v2 a side's pile IS its team's array and JSON writes a shared
// array once per reference — at ~420 bytes an entry, mostly end-of-match stats.
// After: the side ships a pointer to its team's pile and the receiver re-links
// them; stats leave dead entries until the match is over. Round-24 broadcast
// measured 65-67KB, dead piles ~13KB.
// ============================================================
load('./sim/shim.js');
load('./multiplayer.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

function entry(name, i) {
  return { name: name, cost: 3, attack: 3, health: 4, abilities: ['Armor 1'], type: 'hero', owner: 'player',
           statsKills: 2 + i, statsEnemyDamage: 7, statsHealthbarDamage: 3, statsKillTempo: 4, _playedByName: 'Henry' };
}
Game.init();
Game.goTo2v2OnlineLobby();
var s = Game.state, tt = s.twoVTwo;
tt.teams.A.deadPile = []; tt.teams.B.deadPile = [];
for (var i = 0; i < 20; i++) { tt.teams.A.deadPile.push(entry('Bane', i)); tt.teams.B.deadPile.push(entry('Thanos', i)); }
// the 2v2 bridge: each side record holds its team's very array
s.player.deadPile = tt.teams.A.deadPile;
s.ai.deadPile = tt.teams.B.deadPile;

// ---- (1) sent once -------------------------------------------------------------
var wire = Multiplayer.serializeState(s);
check('the side does not carry its own copy of the team pile', wire.player.deadPile === undefined && wire.ai.deadPile === undefined);
check('it carries a pointer to its team instead', wire.player._deadPileTeam === 'A' && wire.ai._deadPileTeam === 'B');
check('the team piles still travel in full', wire.twoVTwo.teams.A.deadPile.length === 20 && wire.twoVTwo.teams.B.deadPile.length === 20);
var back = Multiplayer._rehydrateState(JSON.parse(JSON.stringify(wire)));
check('the receiver re-links the side to its team pile — the SAME array, as on the host',
      back.player.deadPile === back.twoVTwo.teams.A.deadPile && back.ai.deadPile === back.twoVTwo.teams.B.deadPile);
check('…with every entry intact', back.player.deadPile.length === 20 && back.player.deadPile[0].name === 'Bane');
check('…and the pointer is gone', back.player._deadPileTeam === undefined);

// a pile that is NOT the team's (mid-bridge, or 1v1) still travels as its own
s.player.deadPile = tt.teams.A.deadPile.slice(0, 3);
var wire2 = Multiplayer.serializeState(s);
check('a side pile that is not its team array is sent as-is', Array.isArray(wire2.player.deadPile) && wire2.player.deadPile.length === 3 && !wire2.player._deadPileTeam);
s.player.deadPile = tt.teams.A.deadPile;

// ---- (2) slim mid-match, full at game over ---------------------------------
var e0 = wire.twoVTwo.teams.A.deadPile[0];
check('mid-match, dead entries travel without their stats',
      Object.keys(e0).filter(function (k) { return k.indexOf('stats') === 0; }).length === 0, Object.keys(e0).join(','));
check('…but keep what play needs (name, cost, stats line, abilities, owner)',
      e0.name === 'Bane' && e0.cost === 3 && e0.attack === 3 && e0.health === 4 && e0.abilities[0] === 'Armor 1' && e0.owner === 'player');
check('…and the host keeps its own full record', tt.teams.A.deadPile[0].statsKills === 2);
s.gameOver = true;
var wireEnd = Multiplayer.serializeState(s);
check('at game over the stats travel again, for the victory screen', wireEnd.twoVTwo.teams.A.deadPile[0].statsKills === 2);
s.gameOver = false;

// ---- the size it buys ------------------------------------------------------------
var before = JSON.stringify(tt.teams.A.deadPile).length * 2 + JSON.stringify(tt.teams.B.deadPile).length * 2;
var after = JSON.stringify(wire.twoVTwo.teams.A.deadPile).length + JSON.stringify(wire.twoVTwo.teams.B.deadPile).length;
print('  40 dead cards on the wire: ' + before + ' bytes before (twice, with stats) -> ' + after + ' after');
check('the dead piles cost well under half what they did', after < before * 0.4, after + ' vs ' + before);

print('wire-deadpile: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('wire-deadpile failed');
