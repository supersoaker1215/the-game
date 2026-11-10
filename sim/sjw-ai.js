// ============================================================
// THE AI SEES SUNG JIN-WOO AT HIS REAL SIZE.
//
//   jsc sim/sjw-ai.js
//
// He is an X/X: X is the whole purse when he lands. The hand instance carries
// the printed 5/5, and the AI read stats/cost straight off it — so its play
// order put a 7-drop first and him on the scraps. Measured before (hard AI,
// empty board): 9 energy + Dr. Doom → Doom, then Sung Jin-Woo X=2 (2/2,
// shadows at 0 ATK); 10 energy + Ghost Rider → Rider, then X=4. After: he
// goes first at X=9 / X=10. Unchanged: 9 energy + 3c + 2c, a 9-energy block
// of a 7/7, and 3 energy blocking with a 3-drop instead of a 3/3 him.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
function def(n) { return CARD_DEFS.find(function (d) { return d.name === n; }); }
function setup(energy, handNames, enemy) {
  Game.init(); Game.seedMatch(0x77);
  var s = Game.state; s.mode = { deck: 'classic', players: '1v1' }; s.round = 6; s.phase = 'ai-cards';
  s.firstPlayer = 'ai'; s.activePlayer = 'ai'; s.player.isHuman = true; s.ai.isHuman = false;
  for (var i = 0; i < Game.LANE_COUNT; i++) { s.lanes[i].player = null; s.lanes[i].ai = null; s.lanes[i].destroyed = false; }
  ['player', 'ai'].forEach(function (k) { s[k].hand = []; s[k].deadPile = []; s[k].discount = 0; });
  s.ai.currency = energy;
  handNames.forEach(function (n) { var c = Game.createCardInstance(def(n), 'ai'); c.owner = 'ai'; s.ai.hand.push(c); });
  if (enemy) { var e = Game.createCardInstance(def(enemy.name), 'player'); e.owner = 'player'; e.attack = enemy.atk; e.currentHealth = e.maxHealth = enemy.hp; s.lanes[enemy.lane].player = e; }
}
function play() {
  var s = Game.state, played = [], orig = Game.playCard;
  Game.playCard = function (o, c) { var r = orig.apply(Game, arguments); if (o === 'ai') played.push({ name: c.name, x: c._energyLocked }); return r; };
  try { AI.playCards('ai', function () {}, function () { return true; }); } finally { Game.playCard = orig; }
  return played;
}
var fill = CARD_DEFS.filter(function (d) { return d.attack > 0 && d.health > 0 && !d._spawnOnly && !d.isEnvironment && !d.isDiscardEffect && !d.scalesWithEnergy; });
var byCost = function (n) { return fill.find(function (d) { return d.cost === n; }).name; };

setup(9, ['Sung Jin-Woo', byCost(7)]);
var p = play();
check('9 energy + a 7-drop: he goes first, at X=9', p.length && p[0].name === 'Sung Jin-Woo' && p[0].x === 9, JSON.stringify(p));
setup(10, ['Sung Jin-Woo', byCost(6)]);
p = play();
check('10 energy + a 6-drop: he goes first, at X=10', p.length && p[0].name === 'Sung Jin-Woo' && p[0].x === 10, JSON.stringify(p));
setup(3, ['Sung Jin-Woo', byCost(3)], { name: byCost(3), atk: 7, hp: 7, lane: 2 });
p = play();
check('3 energy facing a 7/7: still blocks with the 3-drop, not a 3/3 him', p.length === 1 && p[0].name !== 'Sung Jin-Woo', JSON.stringify(p));

// The accessor is a no-op for every printed card — nothing else re-sorts.
setup(9, ['Sung Jin-Woo', byCost(4)]);
var hand = Game.state.ai.hand, other = hand[1];
check('_handBody returns a printed card itself', AI._handBody(other, 'ai') === other);
var b = AI._handBody(hand[0], 'ai');
check('_handBody gives him the live X/X', b.cost === 9 && b.attack === 9 && b.currentHealth === 9, b.cost + ' ' + b.attack + '/' + b.currentHealth);
check('_handBody never mutates the hand card', hand[0].attack === 5 && b !== hand[0]);

print('sjw-ai: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('sjw-ai failed');
