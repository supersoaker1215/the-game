// ============================================================
// SUNG JIN-WOO, IGRIS AND BERU.
//
//   jsc sim/sung-jin-woo.js
//
// Owner's spec: "his cost and stats scale with how much energy you have — if
// you have 5 energy he is a 5/5. When played: summon Igris and Beru. Beru has
// 3 less attack than Sung Jin-Woo, Overdrive, When Played: freeze the highest
// cost card. Cannot be killed until Sung Jin-Woo is killed; his attack is
// based on Sung Jin-Woo and he has 0 health. Igris: 4 less attack, Overdrive,
// same passive. Sung Jin-Woo also revives a chosen ally card: cost ≤ 6 100%,
// 7-8 66%, 9-10 33%."
//
// Every case drives the real door (Game.playCard from hand, real damage /
// destroy / devour calls) and asserts the MECHANISM, not just the outcome.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');

var __cases = [], __fails = [];
function t(name, fn) { __cases.push({ name: name, fn: fn }); }
var __bad = [];
function eq(label, a, b) { if (a !== b) __bad.push(label + ': expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
function ok(label, c) { if (!c) __bad.push(label); }

function reset() {
  Game.init();
  Game.seedMatch(0x5317);
  Game.state.mode = { deck: 'classic', players: '1v1' };
  Game.state.phase = 'player-cards';
  Game.state.round = 5;
  Game.state.firstPlayer = 'player';
  Game.state.activePlayer = 'player';
  Game.history = [];
  for (var i = 0; i < Game.LANE_COUNT; i++) {
    Game.state.lanes[i].player = null; Game.state.lanes[i].ai = null; Game.state.lanes[i].destroyed = false;
  }
  ['player', 'ai'].forEach(function (s) { Game.state[s].hand = []; Game.state[s].deadPile = []; Game.state[s].discount = 0; });
  return Game;
}
function def(name) { return CARD_DEFS.find(function (d) { return d.name === name; }); }
function inHand(G, name, owner) { var c = G.createCardInstance(def(name), owner); G.state[owner].hand.push(c); return c; }
function place(G, name, owner, lane) { var c = G.createCardInstance(def(name), owner); G.state.lanes[lane][owner] = c; return c; }
function onBoard(G, owner, name) {
  for (var i = 0; i < G.LANE_COUNT; i++) { var c = G.state.lanes[i][owner]; if (c && c.name === name) return c; }
  return null;
}
// Play him and answer the revive prompt (if any) with nothing to keep the
// case about one thing. An empty dead pile raises no prompt at all.
// An ally already stands in lane 6, so the engine's universal Lone Wolf
// (+1/+1 to a card entering an empty board) stays out of these numbers.
function playSJW(G, owner, energy, lane) {
  if (!G.state.lanes[5][owner]) place(G, 'Bane', owner, 5);
  G.state[owner].currency = energy;
  var sjw = inHand(G, 'Sung Jin-Woo', owner);
  var res = G.playCard(owner, sjw, lane);
  return { sjw: sjw, res: res };
}

t('cost and body follow the purse while he is in hand', function () {
  var G = reset();
  var c = inHand(G, 'Sung Jin-Woo', 'player');
  G.state.player.currency = 5;
  eq('5 energy -> costs 5', G.getCardCost('player', c), 5);
  var p5 = G.energyScaledPreview(c);
  eq('…and is a 5/5', p5.attack + '/' + p5.health, '5/5');
  G.state.player.currency = 8;
  eq('8 energy -> costs 8', G.getCardCost('player', c), 8);
  var p8 = G.energyScaledPreview(c);
  eq('…and is an 8/8', p8.attack + '/' + p8.health, '8/8');
  G.state.player.currency = 0;
  eq('an empty purse prices him at 1, not free', G.getCardCost('player', c), 1);
});

t('enemy and ally cost modifiers do not move the price off the purse', function () {
  var G = reset();
  place(G, 'Silver Surfer', 'ai', 4);
  var c = inHand(G, 'Sung Jin-Woo', 'player');
  G.state.player.currency = 6;
  eq('Silver Surfer on the board: still exactly 6', G.getCardCost('player', c), 6);
});

t('playing him spends ALL the energy and locks him at X/X', function () {
  var G = reset();
  var r = playSJW(G, 'player', 7, 2);
  eq('play accepted', r.res, true);
  eq('purse emptied', G.state.player.currency, 0);
  eq('locked X', r.sjw._energyLocked, 7);
  eq('body', r.sjw.attack + '/' + r.sjw.currentHealth, '7/7');
  eq('cost and baseCost both X (both reader idioms agree)', r.sjw.cost + '/' + r.sjw.baseCost, '7/7');
  eq('on the board he no longer re-prices off the purse', G.isEnergyScaled(r.sjw), false);
  G.state.player.currency = 3;
  eq('board cost stays 7 after the purse changes', G.getCardCost('player', r.sjw), 7);
});

t('a hand buff survives the lock (Red Skull style +2/+2)', function () {
  var G = reset();
  place(G, 'Bane', 'player', 5);
  G.state.player.currency = 4;
  var c = inHand(G, 'Sung Jin-Woo', 'player');
  G.buffCard(c, 2, 2);
  var pv = G.energyScaledPreview(c);
  eq('preview carries the buff', pv.attack + '/' + pv.health, '6/6');
  G.playCard('player', c, 0);
  eq('lands 6/6 at X=4', c.attack + '/' + c.currentHealth, '6/6');
});

t('Lone Wolf still applies to him like any card (empty board: X+1)', function () {
  var G = reset();
  G.state.player.currency = 5;
  var c = inHand(G, 'Sung Jin-Woo', 'player');
  G.playCard('player', c, 2);
  eq('5 energy alone -> 6/6', c.attack + '/' + c.currentHealth, '6/6');
});

t('he raises Igris and Beru in the nearest empty lanes, at his ATK −4 / −3', function () {
  var G = reset();
  var r = playSJW(G, 'player', 7, 2);
  var ig = onBoard(G, 'player', 'Igris'), be = onBoard(G, 'player', 'Beru');
  ok('Igris summoned', !!ig); ok('Beru summoned', !!be);
  eq('Igris nearest (lane 1, tie to the lower)', G.findCardLane(ig), 1);
  eq('Beru next (lane 3)', G.findCardLane(be), 3);
  eq('Igris ATK = 7 − 4', ig.attack, 3);
  eq('Beru ATK = 7 − 3', be.attack, 4);
  eq('both Overdrive', ig.isOverdrive && be.isOverdrive, true);
  eq('linked by id', ig._shadowOf === r.sjw.id && be._shadowOf === r.sjw.id, true);
  eq('ATK is their own, not a buff (base moves with it)', be.baseAttack, 4);
  ok('bound shadows are Invincible', ig.invincibleTurns > 0 && be.invincibleTurns > 0);
});

t('Beru freezes the highest-cost enemy when he lands', function () {
  var G = reset();
  var small = place(G, 'Ant-Man', 'ai', 0);
  var big = place(G, 'Silver Surfer', 'ai', 5);
  playSJW(G, 'player', 6, 2);
  eq('the 7-cost is frozen', !!big.isFrozen, true);
  eq('the 1-cost is not', !!small.isFrozen, false);
});

t('a bound shadow cannot be killed — damage, destroy, devour, raw zero-HP death', function () {
  var G = reset();
  playSJW(G, 'player', 7, 2);
  var be = onBoard(G, 'player', 'Beru'), ig = onBoard(G, 'player', 'Igris');
  var foe = place(G, 'Silver Surfer', 'ai', 3);
  G.dealDamage(be, 50, foe);
  ok('damage: Beru stands', be.currentHealth > 0 && G.findCardLane(be) >= 0);
  G.killCard(be, foe);
  ok('destroy: Beru stands', be.currentHealth > 0 && G.findCardLane(be) >= 0);
  G.devourCard(ig, foe);
  ok('devour: Igris stands', G.findCardLane(ig) >= 0);
  // The shield-bypassing door: someone writes 0 and calls handleDeath.
  ig.currentHealth = 0; G.handleDeath(ig, G.findCardLane(ig), foe);
  ok('raw death: Igris stands', ig.currentHealth > 0 && G.findCardLane(ig) >= 0);
  eq('neither went to the dead pile', G.state.player.deadPile.filter(function (e) { return e.name === 'Igris' || e.name === 'Beru'; }).length, 0);
});

t('their ATK follows his — buff and debuff', function () {
  var G = reset();
  var r = playSJW(G, 'player', 6, 2);
  var be = onBoard(G, 'player', 'Beru'), ig = onBoard(G, 'player', 'Igris');
  eq('start: Beru 3, Igris 2', be.attack + '/' + ig.attack, '3/2');
  G.buffCard(r.sjw, 3, 0);
  eq('he gains 3 -> Beru 6, Igris 5', be.attack + '/' + ig.attack, '6/5');
  G.debuffCard(r.sjw, 5, 0, false, null);
  eq('he loses 5 -> Beru 1, Igris 0', be.attack + '/' + ig.attack, '1/0');
});

t('a debuff on the shadow itself stays on the shadow', function () {
  var G = reset();
  var r = playSJW(G, 'player', 8, 2);
  var be = onBoard(G, 'player', 'Beru');
  G.debuffCard(be, 2, 0, false, null);
  eq('Beru 5 -> 3', be.attack, 3);
  G.buffCard(r.sjw, 1, 0);
  eq('he gains 1 -> Beru 4, the −2 kept', be.attack, 4);
});

t('when he is killed, both shadows dissolve', function () {
  var G = reset();
  var r = playSJW(G, 'player', 7, 2);
  var foe = place(G, 'Silver Surfer', 'ai', 2);
  G.killCard(r.sjw, foe);
  eq('he is gone', G.findCardLane(r.sjw), -1);
  eq('Igris gone', onBoard(G, 'player', 'Igris'), null);
  eq('Beru gone', onBoard(G, 'player', 'Beru'), null);
  eq('he is in the dead pile, they are not',
     G.state.player.deadPile.map(function (e) { return e.name; }).join(','), 'Sung Jin-Woo');
});

t('devour skips handleDeath — the shadows still dissolve', function () {
  var G = reset();
  var r = playSJW(G, 'player', 7, 2);
  G.devourCard(r.sjw, place(G, 'Silver Surfer', 'ai', 2));
  eq('Igris gone', onBoard(G, 'player', 'Igris'), null);
  eq('Beru gone', onBoard(G, 'player', 'Beru'), null);
});

t('revive: a cost ≤ 6 card always rises, onto the board, from the dead pile', function () {
  var G = reset();
  G.state.ai.deadPile.push({ name: 'Bane', cost: 4, attack: 4, health: 5, abilities: [] });
  G.state.ai.currency = 7;
  var sjw = inHand(G, 'Sung Jin-Woo', 'ai');
  G.playCard('ai', sjw, 2);
  ok('Bane is on the board', !!onBoard(G, 'ai', 'Bane'));
  eq('and out of the pile', G.state.ai.deadPile.length, 0);
});

t('revive odds by cost bracket: 100 / 66 / 33', function () {
  var ch = CARD_ABILITIES['Sung Jin-Woo'].reviveChance;
  eq('6', ch(6), 1); eq('7', ch(7), 2 / 3); eq('8', ch(8), 2 / 3); eq('9', ch(9), 1 / 3); eq('10', ch(10), 1 / 3);
});

t('revive: a miss leaves the card in the dead pile', function () {
  var G = reset();
  G.state.ai.deadPile.push({ name: 'Knull', cost: 10, attack: 7, health: 7, abilities: [] });
  var realRng = G.rng; G.rng = function () { return 0.99; };   // above 1/3
  try {
    G.state.ai.currency = 7;
    G.playCard('ai', inHand(G, 'Sung Jin-Woo', 'ai'), 2);
  } finally { G.rng = realRng; }
  eq('Knull not on the board', onBoard(G, 'ai', 'Knull'), null);
  eq('Knull still in the pile', G.state.ai.deadPile.length, 1);
});

t('revive: a hit on a 10-cost raises it', function () {
  var G = reset();
  G.state.ai.deadPile.push({ name: 'Knull', cost: 10, attack: 7, health: 7, abilities: [] });
  var realRng = G.rng, calls = 0; G.rng = function () { calls++; return 0.10; };
  try {
    G.state.ai.currency = 7;
    G.playCard('ai', inHand(G, 'Sung Jin-Woo', 'ai'), 2);
  } finally { G.rng = realRng; }
  ok('Knull rose', !!onBoard(G, 'ai', 'Knull'));
  ok('the roll used the seeded stream (Game.rng)', calls > 0);
});

t('the shadows are spawn-only and the master has a body on every surface', function () {
  eq('Beru _spawnOnly', !!def('Beru')._spawnOnly, true);
  eq('Igris _spawnOnly', !!def('Igris')._spawnOnly, true);
  eq('Sung Jin-Woo is draftable', !!def('Sung Jin-Woo')._spawnOnly, false);
  eq('Beru prints stats (0/0 is a claim, not bodyless)', Game.cardHasBody(def('Beru')), true);
  var b = Game.createCardInstance(def('Beru'), 'player');
  eq('instance too', Game.cardHasBody(b), true);
});

t('undo after playing him restores the purse, the hand and an empty board', function () {
  var G = reset();
  G.state.player.currency = 6;
  var c = inHand(G, 'Sung Jin-Woo', 'player');
  G.playCard('player', c, 2);
  G.undo();
  eq('purse back', G.state.player.currency, 6);
  eq('him back in hand', G.state.player.hand.length, 1);
  eq('no shadows left behind', !!(onBoard(G, 'player', 'Igris') || onBoard(G, 'player', 'Beru')), false);
  var back = G.state.player.hand[0];
  eq('and he scales again', G.isEnergyScaled(back), true);
});

__cases.forEach(function (c) {
  __bad = [];
  try { c.fn(); } catch (e) { __bad.push('threw: ' + (e && e.message || e)); }
  if (__bad.length) { __fails.push(c.name); print('  FAIL  ' + c.name); __bad.forEach(function (m) { print('        - ' + m); }); }
  else print('  PASS  ' + c.name);
});
print('');
print('sung-jin-woo: ' + (__cases.length - __fails.length) + ' passed, ' + __fails.length + ' failed');
if (__fails.length) throw new Error('sung-jin-woo failed');
