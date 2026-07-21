// ============================================================
// Card Lane Battle — RESOLUTION golden tests
//
// Companion to sim/snapshots.js. That file pins the combat-math
// PREDICTOR (Game.predictCombatGlobal) in isolation. THIS file pins
// the ACTUAL engine resolution of the trickiest status/keyword rules
// — the ones reworked during the AAA-engine pass and most likely to
// silently regress: Immunity vs Unresistible, forced-freeze, the
// effect-validity gate (canEffectLand), and the Revive keyword.
//
// It leans on the now-deterministic engine + _syncMode (set by the
// shim) so every scenario resolves synchronously with no timers and
// no RNG drift — a scenario either matches its pinned outcome or it
// doesn't.
//
// Run with:
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc sim/golden.js
// ============================================================

var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');

// ---- Tiny assertion lib (mirrors sim/snapshots.js) ----------
var __cases = [], __passed = 0, __failed = 0, __failures = [];
function gold(name, fn) { __cases.push({ name: name, fn: fn }); }

var __caseAssertFailed = false;
var __caseAssertMessages = [];
function eq(name, actual, expected) {
  if (actual !== expected) {
    __caseAssertFailed = true;
    __caseAssertMessages.push(name + ': expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
  }
}

// ---- Helpers ------------------------------------------------
// Fresh cleared board each case (same shape as snapshots.js reset()).
function reset() {
  if (typeof Game === 'undefined') throw new Error('Game not loaded');
  Game.init();
  Game.state.mode = { deck: 'classic', players: '1v1' };
  Game.state.phase = 'combat';
  Game.state.round = 1;
  Game.state.firstPlayer = 'player';
  Game.state.activePlayer = 'player';
  for (var i = 0; i < Game.LANE_COUNT; i++) {
    Game.state.lanes[i].player = null;
    Game.state.lanes[i].ai = null;
    Game.state.lanes[i].destroyed = false;
  }
  return Game;
}

// Build a real card instance so abilities stamp their charges
// (Immunity → immunityCharges, Unresistible → unresistibleCharges,
// Revive → reviveCharges — see applyAbilities in game.js).
function card(opts) {
  var def = {
    name: opts.name || 'GoldCard',
    cost: opts.cost || 1,
    attack: (opts.attack != null) ? opts.attack : 1,
    health: (opts.health != null) ? opts.health : 5,
    abilities: opts.abilities || [],
  };
  var c = Game.createCardInstance(def, opts.owner || 'ai');
  return c;
}
function place(c, lane, side) {
  Game.state.lanes[lane][side || c.owner] = c;
  return c;
}

// ============================================================
// IMMUNITY vs UNRESISTIBLE (stun path → tryApplyDebuff gate)
// ============================================================

// RG-1 — Immunity blocks a stun; the charge is spent, card unstunned.
gold('RG-1 Immunity blocks stun (no Unresistible): charge spent, not stunned', function () {
  reset();
  var src = card({ name: 'Stunner', owner: 'ai', abilities: [] });
  var tgt = card({ name: 'Immune',  owner: 'player', abilities: ['Immunity'] });
  eq('immunity before', tgt.immunityCharges, 1);
  Game.stunCard(tgt, src, 1);
  eq('isStunned',        !!tgt.isStunned, false);
  eq('immunity after',   tgt.immunityCharges, 0);
});

// RG-2 — Unresistible pierces Immunity: stun lands, ONLY Unresistible
// is spent, Immunity is UNTOUCHED (the fix — it never blocked anything).
gold('RG-2 Unresistible pierces Immunity: stun lands, Immunity untouched', function () {
  reset();
  var src = card({ name: 'Palp',   owner: 'ai',     abilities: ['Unresistible'] });
  var tgt = card({ name: 'Immune', owner: 'player', abilities: ['Immunity'] });
  Game.stunCard(tgt, src, 1);
  eq('isStunned',           !!tgt.isStunned, true);
  eq('src unresistible',    src.unresistibleCharges, 0);
  eq('tgt immunity intact', tgt.immunityCharges, 1);
});

// RG-3 — The exact user bug: a source with ONE Unresistible cannot
// stun-lock two immune enemies back to back. First lands (spends
// Unresistible); second is blocked by Immunity.
gold('RG-3 One Unresistible cannot double-stun two immune enemies', function () {
  reset();
  var src = card({ name: 'Palp', owner: 'ai',     abilities: ['Unresistible'] });
  var a   = card({ name: 'Ana',  owner: 'player', abilities: ['Immunity'] });
  var b   = card({ name: 'Sup',  owner: 'player', abilities: ['Immunity'] });
  Game.stunCard(a, src, 1);
  Game.stunCard(b, src, 1);
  eq('a stunned',       !!a.isStunned, true);
  eq('b NOT stunned',   !!b.isStunned, false);
  eq('src unresistible', src.unresistibleCharges, 0);
  eq('a immunity',      a.immunityCharges, 1);  // pierced → untouched
  eq('b immunity',      b.immunityCharges, 0);  // blocked → spent
});

// ============================================================
// FORCED FREEZE (freezeCardUnresistible)
// ============================================================

// RG-4 — Forced freeze on an immune target with NO Unresistible: the
// Immunity BLOCKS the freeze (charge spent, card NOT frozen). This was
// a real bug where the charge was consumed but the freeze still landed.
gold('RG-4 Forced-freeze blocked by Immunity (no Unresistible): not frozen', function () {
  reset();
  var src = card({ name: 'Freezer', owner: 'ai',     abilities: [] });
  var tgt = card({ name: 'Immune',  owner: 'player', abilities: ['Immunity'] });
  Game.freezeCardUnresistible(tgt, src, 1);
  eq('isFrozen',        !!tgt.isFrozen, false);
  eq('immunity after',  tgt.immunityCharges, 0);
});

// RG-5 — Forced freeze WITH Unresistible pierces Immunity: card frozen,
// Unresistible spent, Immunity untouched.
gold('RG-5 Forced-freeze with Unresistible pierces Immunity', function () {
  reset();
  var src = card({ name: 'Palp',   owner: 'ai',     abilities: ['Unresistible'] });
  var tgt = card({ name: 'Immune', owner: 'player', abilities: ['Immunity'] });
  Game.freezeCardUnresistible(tgt, src, 1);
  eq('isFrozen',            !!tgt.isFrozen, true);
  eq('src unresistible',    src.unresistibleCharges, 0);
  eq('tgt immunity intact', tgt.immunityCharges, 1);
});

// ============================================================
// REVIVE keyword — data carries the charge everywhere
// ============================================================

// RG-6 — A card whose abilities include 'Revive' is stamped with a
// reviveCharges count at instance creation (so the badge + the death
// handler read the SAME source of truth — the global-fix requirement).
gold('RG-6 Revive keyword stamps reviveCharges from the data', function () {
  reset();
  var c1 = card({ name: 'Doomsday', owner: 'ai', abilities: ['Revive'] });
  eq('revive 1', c1.reviveCharges, 1);
  var c2 = card({ name: 'Twice', owner: 'ai', abilities: ['Revive 2'] });
  eq('revive 2', c2.reviveCharges, 2);
  var c3 = card({ name: 'Mortal', owner: 'ai', abilities: [] });
  eq('no revive', c3.reviveCharges | 0, 0);
});

// ============================================================
// EFFECT-VALIDITY GATE (canEffectLand / canTrickLand)
// ============================================================

// RG-7 — The gate answers 'will this even do anything?' consistently:
// Untrickable blocks ENEMY tricks only; Invincible blocks destroy +
// damage + debuff; damage-immunity blocks damage/debuff; a plain body
// accepts everything.
gold('RG-7 canEffectLand gate: untrickable / invincible / damage-immune / normal', function () {
  reset();
  var untrick = card({ name: 'Strange', owner: 'ai', abilities: ['Untrickable'] });
  var invinc  = card({ name: 'Invinc',  owner: 'ai', abilities: [] });
  invinc.invincibleTurns = 1;
  var dmgImm  = card({ name: 'DmgImm',  owner: 'ai', abilities: [] });
  dmgImm.hasDamageImmunity = true;
  var plain   = card({ name: 'Plain',   owner: 'ai', abilities: [] });

  // Untrickable: enemy trick blocked, friendly trick allowed.
  eq('untrick enemy trick', Game.canEffectLand(untrick, 'trick', { owner: 'player' }), false);
  eq('untrick own trick',   Game.canEffectLand(untrick, 'trick', { owner: 'ai' }),     true);

  // Invincible: can't destroy / damage / debuff.
  eq('invinc destroy', Game.canEffectLand(invinc, 'destroy', {}), false);
  eq('invinc damage',  Game.canEffectLand(invinc, 'damage',  {}), false);
  eq('invinc debuff',  Game.canEffectLand(invinc, 'debuff',  {}), false);

  // Damage immunity: damage/debuff blocked, destroy still allowed.
  eq('dmgImm damage',  Game.canEffectLand(dmgImm, 'damage',  {}), false);
  eq('dmgImm destroy', Game.canEffectLand(dmgImm, 'destroy', {}), true);

  // Plain body: everything lands.
  eq('plain trick',   Game.canEffectLand(plain, 'trick',   { owner: 'player' }), true);
  eq('plain damage',  Game.canEffectLand(plain, 'damage',  {}), true);
  eq('plain destroy', Game.canEffectLand(plain, 'destroy', {}), true);
});

// RG-8 — canTrickLand composes both gates: a damaging trick on an
// Untrickable enemy fails on the trick gate; on an Invincible enemy it
// passes the trick gate but fails the damage gate; on a plain enemy it
// lands. Also: dead / environment bodies never accept anything.
gold('RG-8 canTrickLand composite + dead/environment rejection', function () {
  reset();
  var untrick = card({ name: 'Strange', owner: 'ai', abilities: ['Untrickable'] });
  var invinc  = card({ name: 'Invinc',  owner: 'ai', abilities: [] });
  invinc.invincibleTurns = 1;
  var plain   = card({ name: 'Plain',   owner: 'ai', abilities: [] });
  var dead    = card({ name: 'Dead',    owner: 'ai', abilities: [] });
  dead.currentHealth = 0;
  var env     = card({ name: 'Env',     owner: 'ai', abilities: [] });
  env.isEnvironment = true;

  eq('damaging trick vs untrickable', Game.canTrickLand(untrick, 'damage', 'player'), false);
  eq('damaging trick vs invincible',  Game.canTrickLand(invinc,  'damage', 'player'), false);
  eq('plain trick vs plain',          Game.canTrickLand(plain,   'trick',  'player'), true);
  eq('damaging trick vs plain',       Game.canTrickLand(plain,   'damage', 'player'), true);
  eq('anything vs dead',              Game.canEffectLand(dead, 'trick', { owner: 'player' }), false);
  eq('anything vs environment',       Game.canEffectLand(env,  'trick', { owner: 'player' }), false);
});

// ============================================================
// RUNNER
// ============================================================
for (var ci = 0; ci < __cases.length; ci++) {
  var tc = __cases[ci];
  __caseAssertFailed = false;
  __caseAssertMessages = [];
  var threw = null;
  try { tc.fn(); } catch (e) { threw = e; }
  if (threw) {
    __failed++;
    __failures.push('  - ' + tc.name + ' THREW: ' + (threw && threw.message ? threw.message : threw));
    print('  FAIL  ' + tc.name + ' (threw)');
  } else if (__caseAssertFailed) {
    __failed++;
    __failures.push('  - ' + tc.name + ': ' + __caseAssertMessages.join('; '));
    print('  FAIL  ' + tc.name);
  } else {
    __passed++;
    print('  PASS  ' + tc.name);
  }
}
print('');
print('=== ' + __passed + ' passed, ' + __failed + ' failed ===');
if (__failed > 0) {
  print('');
  print('Failures:');
  for (var fi = 0; fi < __failures.length; fi++) print(__failures[fi]);
}
