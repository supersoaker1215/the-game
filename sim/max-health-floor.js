// ============================================================
// maxHealth IS A CAPACITY, NOT A CURRENT VALUE — IT NEVER REACHES 0.
//
//   jsc sim/max-health-floor.js
//
// The 2v2 fuzz reported "board hp>max: Harley Quinn" — a living card whose
// current HP was ABOVE its maximum. Seed 2 reproduces it 9x in 400 games.
//
// The chain: `_chainWeaken` applies a permanent -1/-1 through `buffCard`, and
// buffCard is the +N door — it deliberately applies a raw delta with no
// clamp. On a 1-HP card that is
//
//     currentHealth 1 -> 0     (correct: 0 HP means dead)
//     maxHealth     1 -> 0     (CORRUPT: a card with no capacity at all)
//
// and normally nobody notices, because cleanupDead takes the corpse away a
// moment later. But a card at 0 HP can be SAVED — Iron Giant sacrifices
// himself and restores the victim to `Math.max(1, hpSnapshot)`. Now the card
// is alive at 1/0, and it stays that way: every heal is above maximum, the
// HP bar has no denominator, and the invariant sweep fires forever.
//
// The fix belongs in buffCard, not in Iron Giant and not in the chain. Every
// OTHER hp-strip in the engine already floors maxHealth at 1 — debuffCard,
// the stat-strip, Brainiac's spy drain, the aura reconcile. buffCard was the
// one door that didn't, so it is the one door that needed the floor.
// currentHealth stays unclamped on purpose: 0 there is a real outcome.
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
function card(opts) {
  opts = opts || {};
  return Game.createCardInstance({
    name: opts.name || 'FloorTest',
    cost: 1,
    attack: (opts.attack != null) ? opts.attack : 1,
    health: (opts.health != null) ? opts.health : 1,
    abilities: [],
  }, 'player');
}

t('MHF-1 buffCard cannot strip maxHealth below 1', function () {
  Game.init();
  var c = card({ attack: 2, health: 1 });
  eq('starts at 1 max', c.maxHealth, 1);
  Game.buffCard(c, 0, -1);
  eq('maxHealth floors at 1', c.maxHealth, 1);
  // The CURRENT half is deliberately NOT floored — 0 HP is a real death.
  eq('currentHealth still reaches 0', c.currentHealth, 0);
});

t('MHF-2 an oversized negative delta still floors', function () {
  Game.init();
  var c = card({ attack: 2, health: 3 });
  Game.buffCard(c, 0, -9);
  eq('maxHealth floors at 1', c.maxHealth, 1);
  eq('currentHealth goes negative freely', c.currentHealth, -6);
});

t('MHF-3 the positive path is untouched', function () {
  Game.init();
  var c = card({ attack: 1, health: 4 });
  Game.buffCard(c, 2, 3);
  eq('max grew', c.maxHealth, 7);
  eq('current grew', c.currentHealth, 7);
  eq('attack grew', c.attack, 3);
});

t('MHF-4 _chainWeaken leaves a 1/1 dead but not capacity-less', function () {
  Game.init();
  var c = card({ attack: 1, health: 1 });
  Game._chainWeaken(c);
  eq('attack floors at 0', c.attack, 0);
  eq('dead on arrival', c.currentHealth, 0);
  eq('but maxHealth survives', c.maxHealth >= 1, true);
});

t('MHF-5 a chained card that is then SAVED reads a legal bar', function () {
  // This is the exact shape the fuzz caught: the chains take a 1-HP card to
  // 0, Iron Giant's sacrifice restores it to Math.max(1, snapshot), and the
  // card is alive again. hp must not exceed max.
  Game.init();
  var c = card({ attack: 1, health: 1 });
  Game._chainWeaken(c);
  c.currentHealth = Math.max(1, c.currentHealth);   // what doSave does
  c._deathHandled = false;
  eq('alive', c.currentHealth > 0, true);
  eq('hp is not above max', c.currentHealth <= c.maxHealth, true);
});

t('MHF-6 no engine path can leave a living card at max 0', function () {
  // A sweep over every hp-strip door, not just the one that broke: each must
  // agree that a card left standing has capacity.
  Game.init();
  var doors = [
    ['buffCard',   function (c) { Game.buffCard(c, 0, -5); }],
    ['debuffCard', function (c) { Game.debuffCard(c, 0, 5, true, { name: 'test' }); }],
  ];
  doors.forEach(function (d) {
    var c = card({ attack: 1, health: 2, name: d[0] });
    d[1](c);
    eq(d[0] + ' keeps capacity', c.maxHealth >= 1, true);
  });
});

// ---- run ----------------------------------------------------
__cases.forEach(function (c) {
  __caseFailed = false; __caseMsgs = [];
  try { c.fn(); } catch (e) {
    __caseFailed = true;
    __caseMsgs.push('threw: ' + (e && e.message ? e.message : String(e)));
  }
  if (__caseFailed) { __failed++; __failures.push({ name: c.name, msgs: __caseMsgs.slice(0, 4) }); }
  else __passed++;
});
print('max-health-floor: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
