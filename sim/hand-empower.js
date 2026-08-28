// ============================================================
// AN EMPOWER NEEDS A BODY TO LAND ON.
//
//   jsc sim/hand-empower.js
//
// Owner: "make sure red skull cant hit discards".
//
// Red Skull picks a random card in your hand and gives it +2/+2. His
// pool was every card in hand except himself, so the roll could land
// on Jigsaw, Brainiac, Professor X or Mr. Fantastic (discard effects),
// on Iron Giant (never placeable), or on an environment — none of
// which ever carry those stats to a lane. The ability simply did
// nothing, with a log line saying it had.
//
// Apocalypse has the same shape and had half the guard: he filtered
// `!card.isEnvironment` before handing out a random keyword, which is
// the right idea applied to a third of the cases. Armor / Evade /
// Bullseye / Overdrive still landed on the five non-environment
// bodyless cards.
//
// Game.cardHasBody is the canonical answer to "does this card fight?"
// — it is what the RENDERER already uses to decide whether to print
// stats at all — so routing both through it means the rule can never
// drift from what the card visibly is.
//
// HE-1 is the durable case: it walks every card in the game, so a new
// discard effect or environment is covered the day it is added.
// ============================================================

var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');

var __cases = [], __passed = 0, __failed = 0, __failures = [];
function t(name, fn) { __cases.push({ name: name, fn: fn }); }
var __caseFailed = false, __caseMsgs = [];
function eq(label, actual, expected) {
  if (actual !== expected) {
    __caseFailed = true;
    __caseMsgs.push(label + ': expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
  }
}

function reset() {
  Game.init();
  Game.state.mode = { deck: 'classic', players: '1v1' };
  Game.state.phase = 'player-cards';
  Game.state.round = 3;
  for (var i = 0; i < Game.LANE_COUNT; i++) {
    Game.state.lanes[i].player = null;
    Game.state.lanes[i].ai = null;
    Game.state.lanes[i].destroyed = false;
  }
  Game.state.player.hand = [];
  return Game;
}
function realCard(name, owner) {
  var def = null;
  for (var i = 0; i < CARD_DEFS.length; i++) if (CARD_DEFS[i].name === name) { def = CARD_DEFS[i]; break; }
  if (!def) throw new Error('no CARD_DEF named ' + name);
  var c = Game.createCardInstance(def, owner || 'player');
  Game.applyAbilities(c);
  return c;
}
function bodylessNames() {
  var out = [];
  for (var i = 0; i < CARD_DEFS.length; i++) {
    var c;
    try { c = Game.createCardInstance(CARD_DEFS[i], 'player'); Game.applyAbilities(c); } catch (e) { continue; }
    if (!Game.cardHasBody(c)) out.push(CARD_DEFS[i].name);
  }
  return out;
}

// ============================================================
// HE-1 — a hand of nothing but bodyless cards: Red Skull empowers none
//        of them, however the dice fall. Run once per bodyless card so
//        the roll cannot hide a miss.
// ============================================================
t('HE-1 Red Skull never empowers a card with no body', function () {
  reset();
  var names = bodylessNames();
  eq('there are bodyless cards to test', names.length >= 5, true);
  names.forEach(function (n) {
    reset();
    var victim = realCard(n, 'player');
    var atk0 = victim.attack, hp0 = victim.maxHealth;
    Game.state.player.hand = [victim];
    var skull = realCard('Red Skull', 'player');
    Game.state.lanes[0].player = skull;
    Game.runEffect ? null : null;
    CARD_ABILITIES['Red Skull'].onPlay(Game, skull, 0);
    eq(n + ' attack untouched',    victim.attack, atk0);
    eq(n + ' maxHealth untouched', victim.maxHealth, hp0);
  });
});

// ============================================================
// HE-2 — with one real card among the discards, the buff lands on the
//        real card every time, not one roll in five.
// ============================================================
t('HE-2 the empower finds the one card that can carry it', function () {
  for (var trial = 0; trial < 12; trial++) {
    reset();
    var real = realCard('Gizmo', 'player');
    var hand = [realCard('Jigsaw', 'player'), realCard('Brainiac', 'player'),
                realCard('Iron Giant', 'player'), realCard('Open Water', 'player'), real];
    Game.state.player.hand = hand;
    var atk0 = real.attack, hp0 = real.maxHealth;
    var skull = realCard('Red Skull', 'player');
    Game.state.lanes[0].player = skull;
    CARD_ABILITIES['Red Skull'].onPlay(Game, skull, 0);
    eq('trial ' + trial + ': the real card got +2 ATK', real.attack, atk0 + 2);
    eq('trial ' + trial + ': the real card got +2 HP',  real.maxHealth, hp0 + 2);
  }
});

// ============================================================
// HE-3 — an all-discard hand is a clean no-op, not a silent lie.
// ============================================================
t('HE-3 a hand with no valid target empowers nothing', function () {
  reset();
  var hand = [realCard('Jigsaw', 'player'), realCard('Brainiac', 'player'), realCard('Iron Giant', 'player')];
  Game.state.player.hand = hand;
  var before = hand.map(function (c) { return c.attack + '/' + c.maxHealth; }).join(',');
  var skull = realCard('Red Skull', 'player');
  Game.state.lanes[0].player = skull;
  CARD_ABILITIES['Red Skull'].onPlay(Game, skull, 0);
  var after = hand.map(function (c) { return c.attack + '/' + c.maxHealth; }).join(',');
  eq('nothing moved', after, before);
});

// ============================================================
// HE-4 — Apocalypse, same rule. His filter used to stop at environments.
// ============================================================
t('HE-4 Apocalypse grants keywords only to cards that fight', function () {
  reset();
  var jig  = realCard('Jigsaw', 'player');
  var brain = realCard('Brainiac', 'player');
  var giant = realCard('Iron Giant', 'player');
  var env  = realCard('Open Water', 'player');
  var real = realCard('Gizmo', 'player');
  var before = { jig: jig.abilities.length, brain: brain.abilities.length,
                 giant: giant.abilities.length, env: env.abilities.length,
                 real: real.abilities.length };
  Game.state.player.hand = [jig, brain, giant, env, real];
  var apoc = realCard('Apocalypse', 'player');
  Game.state.lanes[0].player = apoc;
  try { CARD_ABILITIES['Apocalypse'].onPlay(Game, apoc, 0); } catch (e) { /* summon half may need a board */ }
  eq('Jigsaw got nothing',      jig.abilities.length,   before.jig);
  eq('Brainiac got nothing',    brain.abilities.length, before.brain);
  eq('Iron Giant got nothing',  giant.abilities.length, before.giant);
  eq('the environment got nothing', env.abilities.length, before.env);
  eq('the real card was granted',   real.abilities.length > before.real, true);
});

// ============================================================
// HE-5 — both effects ask the SAME question, so neither can drift.
// ============================================================
t('HE-5 both empowers route through Game.cardHasBody', function () {
  var rs = String(CARD_ABILITIES['Red Skull'].onPlay);
  var ap = String(CARD_ABILITIES['Apocalypse'].onPlay);
  eq('Red Skull uses cardHasBody',  /cardHasBody/.test(rs), true);
  eq('Apocalypse uses cardHasBody', /cardHasBody/.test(ap), true);
  // And the predicate itself still means what these rely on.
  Game.init();
  eq('a discard has no body', Game.cardHasBody({ isDiscardEffect: true }), false);
  eq('an environment has no body', Game.cardHasBody({ isEnvironment: true }), false);
  eq('Iron Giant has no body', Game.cardHasBody({ _neverPlayable: true }), false);
  eq('a plain card has a body', Game.cardHasBody({ name: 'x' }), true);
});

// ---- run ----------------------------------------------------
__cases.forEach(function (c) {
  __caseFailed = false; __caseMsgs = [];
  try { c.fn(); } catch (e) {
    __caseFailed = true;
    __caseMsgs.push('threw: ' + (e && e.message ? e.message : String(e)));
  }
  if (__caseFailed) { __failed++; __failures.push({ name: c.name, msgs: __caseMsgs.slice() }); }
  else __passed++;
});
print('hand-empower: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
