// ============================================================
// APOCALYPSE RAISES A RANDOM 1–4 COST CARD.
//
//   jsc sim/apocalypse-summon.js
//
// His When Played summon draws from the shared summon deck. Every horseman
// must cost 1 to 4, must fight (ATK > 0), must not be a discard-effect card,
// and over many plays every cost from 1 to 4 must actually come up.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

var seenCost = {}, bad = [], summoned = 0;
var realSummon = Game.summonCardChoice;
Game.summonCardChoice = function (owner, name, cost, atk, hp, abilities, a, b, def) {
  summoned++;
  if (!(cost >= 1 && cost <= 4) || !(atk > 0) || (def && def.isDiscardEffect)) bad.push(name + ' (' + cost + '/' + atk + ')');
  seenCost[cost] = (seenCost[cost] || 0) + 1;
};
var apocDef = CARD_DEFS.find(function (d) { return d.name === 'Apocalypse'; });
for (var seed = 1; seed <= 400; seed++) {
  Game.init(); Game.seedMatch(seed);
  var apoc = Game.createCardInstance(apocDef, 'player');
  try { CARD_ABILITIES['Apocalypse'].onPlay(Game, apoc, 0); } catch (e) { fails.push('onPlay threw on seed ' + seed + ': ' + (e.message || e)); break; }
}
Game.summonCardChoice = realSummon;

check('every play raises a horseman', summoned === 400, summoned + ' of 400');
check('every horseman costs 1-4, fights, and is not a discard card', bad.length === 0, bad.slice(0, 5).join(', '));
check('every cost from 1 to 4 comes up', [1, 2, 3, 4].every(function (c) { return seenCost[c] > 0; }), JSON.stringify(seenCost));
check('the card text says 1-4', /random 1-4 cost card/.test(apocDef.desc), apocDef.desc.slice(0, 60));

print('apocalypse-summon: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('apocalypse-summon failed');
