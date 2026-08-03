// ============================================================
// Card Lane Battle — predictor snapshot/golden tests
//
// Pins specific board states to specific predicted outcomes so
// silent regressions in Game.predictCombatGlobal (game.js:6356)
// trip a loud failure. Companion to sim/test.js (which covers
// mechanic-level behavior); this file covers the combat-math
// predictor in isolation.
//
// Run with:
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc sim/snapshots.js
//
// We DO NOT call Game.resolveCombat — only Game.predictCombatGlobal.
// The predictor returns { byId: Map<id, {hpAfter, dies, dmgIn}> }.
// ============================================================

var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');

// ---- Tiny assertion lib (mirrors sim/test.js style) ---------
var __cases = [], __passed = 0, __failed = 0, __failures = [];
function snap(name, fn) { __cases.push({ name: name, fn: fn }); }

// Track per-case asserts so a single bad expected value reports
// the specific field, not the whole case.
var __caseAssertFailed = false;
var __caseAssertMessages = [];
function assertEquals(name, actual, expected) {
  // Strict-eq the primitive, JSON-stringify for the message.
  if (actual !== expected) {
    __caseAssertFailed = true;
    __caseAssertMessages.push(name + ': expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
  }
}

// ---- Reset helpers ------------------------------------------
// Each case starts from a fully-cleared Game.state. We init() to
// build the state shape, then null out lanes + hands + tricks so
// nothing from the previous case leaks. Game.state.lanes is the
// canonical 6-lane array; we just zero player/ai per-lane.
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

// Build a minimal valid card for the predictor. The predictor
// reads: id, owner, attack, currentHealth, maxHealth, splashRange,
// armorValue, evadeCharges, invincibleTurns, hasDamageImmunity,
// isStunned, isFrozen, isFeared, isMindControlled, isBullseye,
// tauntTurns. We provide all of them, plus name/abilities/statuses
// so any future read paths don't NPE on a missing field.
var __nextSnapId = 1001;
function makeCard(opts) {
  var id = (opts && opts.id != null) ? opts.id : __nextSnapId++;
  return {
    id: id,
    name: opts.name || ('SnapCard#' + id),
    owner: opts.owner,
    attack: opts.attack | 0,
    currentHealth: opts.currentHealth | 0,
    maxHealth: opts.maxHealth | 0,
    baseAttack: opts.attack | 0,
    baseHealth: opts.maxHealth | 0,
    splashRange: opts.splashRange | 0,
    armorValue: opts.armorValue | 0,
    evadeCharges: opts.evadeCharges | 0,
    invincibleTurns: opts.invincibleTurns | 0,
    hasDamageImmunity: !!opts.hasDamageImmunity,
    isStunned: !!opts.isStunned,
    isFrozen: !!opts.isFrozen,
    isFeared: !!opts.isFeared,
    isMindControlled: !!opts.isMindControlled,
    isBullseye: !!opts.isBullseye,
    ignoresEvade: !!opts.ignoresEvade,
    tauntTurns: opts.tauntTurns | 0,
    abilities: [],
    statuses: [],
  };
}

// Place a card in a specific lane/side.
function place(card, lane) {
  Game.state.lanes[lane][card.owner] = card;
  return card;
}

// Look up a per-card prediction by id.
function predOf(result, id) {
  return result.byId.get(id);
}

// ============================================================
// ---- GOLDEN CASES ------------------------------------------
// ============================================================

// GS-01 — Plain trade. 3/5 player vs 4/6 ai. Both swing, both
// survive: player 5-4=1 HP, ai 6-3=3 HP, neither dies.
snap('GS-01 Trade: 3/5 vs 4/6 — both survive at 1 / 3', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 3, currentHealth: 5, maxHealth: 5 }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 4, currentHealth: 6, maxHealth: 6 }), 0);
  var r = Game.predictCombatGlobal();
  var pp = predOf(r, p.id), pa = predOf(r, a.id);
  assertEquals('player.hpAfter', pp.hpAfter, 1);
  assertEquals('player.dies',    pp.dies,    false);
  assertEquals('player.dmgIn',   pp.dmgIn,   4);
  assertEquals('ai.hpAfter',     pa.hpAfter, 3);
  assertEquals('ai.dies',        pa.dies,    false);
  assertEquals('ai.dmgIn',       pa.dmgIn,   3);
});

// GS-02 — Lethal one-sided. 5/3 player vs 2/4 ai.
// Player kills ai (4-5 = -1 → 0, dies). Player takes 2, lands at 1.
snap('GS-02 Lethal: 5/3 vs 2/4 — ai dies, player at 1', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 5, currentHealth: 3, maxHealth: 3 }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 2, currentHealth: 4, maxHealth: 4 }), 0);
  var r = Game.predictCombatGlobal();
  var pp = predOf(r, p.id), pa = predOf(r, a.id);
  assertEquals('player.hpAfter', pp.hpAfter, 1);
  assertEquals('player.dies',    pp.dies,    false);
  assertEquals('ai.hpAfter',     pa.hpAfter, 0);
  assertEquals('ai.dies',        pa.dies,    true);
});

// GS-03 — Mutual death. 4/3 vs 4/3 simultaneously kill each other.
snap('GS-03 Mutual death: 4/3 vs 4/3 — both die', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 4, currentHealth: 3, maxHealth: 3 }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 4, currentHealth: 3, maxHealth: 3 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('player.dies',    predOf(r, p.id).dies,    true);
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter, 0);
  assertEquals('ai.dies',        predOf(r, a.id).dies,    true);
  assertEquals('ai.hpAfter',     predOf(r, a.id).hpAfter, 0);
});

// GS-04 — Stunned defender. ai is stunned (canSwingForward → false),
// so it doesn't swing back. Player still hits ai for 3.
snap('GS-04 Stunned defender: 3/5 vs stunned 4/6 — no swing-back', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 3, currentHealth: 5, maxHealth: 5 }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 4, currentHealth: 6, maxHealth: 6, isStunned: true }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter, 5);
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,   0);
  assertEquals('ai.hpAfter',     predOf(r, a.id).hpAfter, 3);
  assertEquals('ai.dmgIn',       predOf(r, a.id).dmgIn,   3);
});

// GS-05 — Frozen attacker. Player frozen → no swing forward. ai
// still hits player for 4.
snap('GS-05 Frozen attacker: frozen 3/5 vs 4/6 — ai untouched', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 3, currentHealth: 5, maxHealth: 5, isFrozen: true }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 4, currentHealth: 6, maxHealth: 6 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter, 1);
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,   4);
  assertEquals('ai.hpAfter',     predOf(r, a.id).hpAfter, 6);
  assertEquals('ai.dmgIn',       predOf(r, a.id).dmgIn,   0);
});

// GS-06 — Armor full absorb. ai has armor=2 vs player atk=1.
// raw 1 - armor 2 → max(0, -1) = 0 lands. ai takes 0. Player still
// eats ai's 1 atk back swing (player has no armor).
snap('GS-06 Armor blunt: 3/5 vs 1/6 armor=2 — ai absorbs all', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 1, currentHealth: 5, maxHealth: 5 }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 3, currentHealth: 6, maxHealth: 6, armorValue: 2 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('ai.hpAfter',     predOf(r, a.id).hpAfter, 6);
  assertEquals('ai.dmgIn',       predOf(r, a.id).dmgIn,   0);
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter, 2);
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,   3);
});

// GS-07 — Armor partial. Player atk=4, armor=2 → 2 lands. ai 6-2=4.
snap('GS-07 Armor partial: 4/5 vs 1/6 armor=2 — ai at 4', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 4, currentHealth: 5, maxHealth: 5 }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 1, currentHealth: 6, maxHealth: 6, armorValue: 2 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('ai.hpAfter',     predOf(r, a.id).hpAfter, 4);
  assertEquals('ai.dmgIn',       predOf(r, a.id).dmgIn,   2);
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter, 4);
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,   1);
});

// GS-08 — Evade dodge. ai has 1 evade charge, takes 0 damage from
// player's swing, charges drop. Player still takes 1 from ai swing.
snap('GS-08 Evade: 3/5 vs 1/6 evade=1 — ai dodges, charge consumed', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 3, currentHealth: 5, maxHealth: 5 }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 1, currentHealth: 6, maxHealth: 6, evadeCharges: 1 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('ai.hpAfter',     predOf(r, a.id).hpAfter, 6);
  assertEquals('ai.dmgIn',       predOf(r, a.id).dmgIn,   0);
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter, 4);
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,   1);
});

// GS-09 — Empty lane (uncontested player). Player alone in lane 0,
// no ai opposite, no taunters. Player has no front-on-front swing
// recorded against any card; face damage isn't in byId.
snap('GS-09 Empty lane: uncontested 3/5 — byId untouched', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 3, currentHealth: 5, maxHealth: 5 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter, 5);
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,   0);
  // No ai card means no entry at all.
  assertEquals('ai byId entries', r.byId.size, 1);
});

// GS-10 — Splash. Player 1/5 with splashRange=2 in lane 0 vs ai 4/6
// in lane 0. ai also has 2/3 in lane 1 (right of player's lane).
// Predictor steps for lane 0:
//   - front-on-front: ai eats 1 (atk), player eats 4 (atk) → player 1 HP
//   - own-lane splash: player splashes 2 onto ai lane 0 → ai eats 2 more
// For lane 1: pre-splash from left adj (player lane 0) → ai lane 1
// eats 2 splash. So ai lane 0 takes 1+2=3 (HP 6→3), ai lane 1 takes 2
// (HP 3→1).
snap('GS-10 Splash: splashRange=2 over two ai cards', function () {
  reset();
  var p  = place(makeCard({ owner: 'player', attack: 1, currentHealth: 5, maxHealth: 5, splashRange: 2 }), 0);
  var a0 = place(makeCard({ owner: 'ai',     attack: 4, currentHealth: 6, maxHealth: 6 }), 0);
  var a1 = place(makeCard({ owner: 'ai',     attack: 0, currentHealth: 3, maxHealth: 3 }), 1);
  var r = Game.predictCombatGlobal();
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter,  1);
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,    4);
  // Front enemy eats the swing (1) ONLY — splash does not hit the card in
  // front, so this is 1, not 1 + 2. Updated with GS-25/25b: the predictor was
  // still modelling own-lane splash after applySplash dropped it.
  assertEquals('ai0.hpAfter',    predOf(r, a0.id).hpAfter, 5);
  assertEquals('ai0.dmgIn',      predOf(r, a0.id).dmgIn,   1);
  // Adjacent enemy still eats the splash (2).
  assertEquals('ai1.hpAfter',    predOf(r, a1.id).hpAfter, 1);
  assertEquals('ai1.dmgIn',      predOf(r, a1.id).dmgIn,   2);
});

// GS-11 — Three contested lanes (independent outcomes per lane).
// L0: 3/4 vs 3/3 — ai 3-3=0 dies, player 4-3=1 survives.
// L2: 2/2 vs 2/2 — mutual death.
// L4: 5/5 vs 0/3 — ai 3-5 → 0 dies; player untouched (ai atk 0).
snap('GS-11 Multi-lane: three independent contested lanes', function () {
  reset();
  var p0 = place(makeCard({ owner: 'player', attack: 3, currentHealth: 4, maxHealth: 4 }), 0);
  var a0 = place(makeCard({ owner: 'ai',     attack: 3, currentHealth: 3, maxHealth: 3 }), 0);
  var p2 = place(makeCard({ owner: 'player', attack: 2, currentHealth: 2, maxHealth: 2 }), 2);
  var a2 = place(makeCard({ owner: 'ai',     attack: 2, currentHealth: 2, maxHealth: 2 }), 2);
  var p4 = place(makeCard({ owner: 'player', attack: 5, currentHealth: 5, maxHealth: 5 }), 4);
  var a4 = place(makeCard({ owner: 'ai',     attack: 0, currentHealth: 3, maxHealth: 3 }), 4);
  var r = Game.predictCombatGlobal();
  // L0
  assertEquals('L0.player.hpAfter', predOf(r, p0.id).hpAfter, 1);
  assertEquals('L0.player.dies',    predOf(r, p0.id).dies,    false);
  assertEquals('L0.ai.hpAfter',     predOf(r, a0.id).hpAfter, 0);
  assertEquals('L0.ai.dies',        predOf(r, a0.id).dies,    true);
  // L2
  assertEquals('L2.player.dies', predOf(r, p2.id).dies, true);
  assertEquals('L2.ai.dies',     predOf(r, a2.id).dies, true);
  // L4
  assertEquals('L4.player.hpAfter', predOf(r, p4.id).hpAfter, 5);
  assertEquals('L4.ai.hpAfter',     predOf(r, a4.id).hpAfter, 0);
  assertEquals('L4.ai.dies',        predOf(r, a4.id).dies,    true);
});

// GS-12 — Bullseye does NOT pierce a card's Evade.
//
// Bullseye bypasses the lane BLOCK METER (badge tip: "Damage bypasses
// Block Meter"), a lane-level absorb — NOT a card's Evade. Only the
// separate `ignoresEvade` flag disables Evade. Live combat's canDodge
// gate proves it (game.js): canDodge = !stunned && !frozen &&
// !(attacker && attacker.ignoresEvade) — isBullseye is absent. The
// predictor (engine/combat.js) agrees. This case pins the two keywords
// stay distinct; if Bullseye ever starts eating Evade charges, it fails.
//
// Setup: player 3/5 isBullseye, ai 1/6 evadeCharges=1. Bullseye does
// NOT bypass evade → ai spends a charge and dodges → ai takes 0 (HP 6).
// Player still takes 1 from ai's regular swing.
snap('GS-12 Bullseye does not pierce card Evade (only ignoresEvade does)', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 3, currentHealth: 5, maxHealth: 5, isBullseye: true }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 1, currentHealth: 6, maxHealth: 6, evadeCharges: 1 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('ai.hpAfter',     predOf(r, a.id).hpAfter, 6);
  assertEquals('ai.dmgIn',       predOf(r, a.id).dmgIn,   0);
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter, 4);
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,   1);
});

// GS-12b — the positive half: ignoresEvade DOES pierce card Evade.
// Same board, attacker carries ignoresEvade instead of isBullseye →
// ai's charge cannot save it → ai takes the full 3 (HP 3). Locks the
// Bullseye/ignoresEvade distinction from both sides.
snap('GS-12b ignoresEvade pierces card Evade', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 3, currentHealth: 5, maxHealth: 5, ignoresEvade: true }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 1, currentHealth: 6, maxHealth: 6, evadeCharges: 1 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('ai.hpAfter',     predOf(r, a.id).hpAfter, 3);
  assertEquals('ai.dmgIn',       predOf(r, a.id).dmgIn,   3);
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter, 4);
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,   1);
});

// ============================================================
// ---- EXPANSION WAVE (extra coverage) -----------------------
// ============================================================
// First 12 cases pin the predictor's main combat-math branches.
// The cases below cover behaviors flagged during the rules-engine
// extraction inventory + bugs surfaced by the fuzzer that benefit
// from a regression pin.

// GS-13 — Cross-lane taunt redirection. Lane 0: player Taunt
// brute (3/8) with no ai opposite. Lane 2: player 4/3 vs ai 5/4.
// AI's lane-2 swing should REDIRECT to the lane-0 taunter (per
// global predictor's taunt-aware logic). Result: lane 2 player
// keeps full HP; lane 0 taunter eats the 5; lane 2 ai dies to
// the player's 4 atk.
//
// User report from earlier session: "It will still say TRADE in
// lane three if lane one is taunting." Lane forecast strip used
// to call predictLaneOutcome (per-lane only) — switched it to
// predictCombatGlobal which honors cross-lane taunt. This pins
// that behavior so a regression breaks loudly.
snap('GS-13 Cross-lane taunt: lane-0 taunter soaks lane-2 swing', function () {
  reset();
  var taunter = place(makeCard({ owner: 'player', attack: 3, currentHealth: 8, maxHealth: 8, tauntTurns: 1 }), 0);
  var p2      = place(makeCard({ owner: 'player', attack: 4, currentHealth: 3, maxHealth: 3 }), 2);
  var a2      = place(makeCard({ owner: 'ai',     attack: 5, currentHealth: 4, maxHealth: 4 }), 2);
  var r = Game.predictCombatGlobal();
  assertEquals('taunter.dmgIn',   predOf(r, taunter.id).dmgIn,   5);
  assertEquals('taunter.hpAfter', predOf(r, taunter.id).hpAfter, 3);
  assertEquals('taunter.dies',    predOf(r, taunter.id).dies,    false);
  // Lane 2 player escapes — no front-on-front swing reaches them.
  assertEquals('p2.dmgIn',        predOf(r, p2.id).dmgIn,        0);
  assertEquals('p2.hpAfter',      predOf(r, p2.id).hpAfter,      3);
  // Lane 2 ai still eats player's 4 atk.
  assertEquals('a2.dmgIn',        predOf(r, a2.id).dmgIn,        4);
  assertEquals('a2.dies',         predOf(r, a2.id).dies,         true);
});

// GS-14 — Mind-controlled card forecasts ZERO forward damage.
// canSwingForward gates on isMindControlled. Player MC'd 5/5 vs
// ai 1/4 — player's swing doesn't reach the enemy lane (predictor
// models MC as "swings at ally side" = 0 to enemy). AI's 1 atk
// still lands on player.
snap('GS-14 MC attacker: predictor zeros forward swing', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 5, currentHealth: 5, maxHealth: 5, isMindControlled: true }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 1, currentHealth: 4, maxHealth: 4 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('ai.dmgIn',       predOf(r, a.id).dmgIn,     0);
  assertEquals('ai.hpAfter',     predOf(r, a.id).hpAfter,   4);
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,     1);
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter,   4);
});

// GS-15 — Feared attacker deals ZERO forward and hits ITSELF.
// EXPECTATION UPDATED 2026-07-30. This case used to assert
// `player.dmgIn = 1`, and its comment said so explicitly: "Feared swings at
// self IRL but the predictor models it as 'no damage to opposing lane.'" That
// approximation was pinned deliberately — and it is exactly what the user
// reported as a bug: a feared card showed a tiny incoming number and no skull,
// then died anyway when combat resolved.
// The forecast now models the self-hit, so it agrees with the resolver.
// Verified against a real resolveCombat() on this same board before changing
// the number: player DIES, ai ends on 4 HP untouched.
snap('GS-15 Feared attacker: zero forward, and hits itself', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 5, currentHealth: 5, maxHealth: 5, isFeared: true }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 1, currentHealth: 4, maxHealth: 4 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('ai.dmgIn',       predOf(r, a.id).dmgIn,     0);
  assertEquals('ai.hpAfter',     predOf(r, a.id).hpAfter,   4);
  // 5 self + 1 from ai = 6, so the 5 HP card is dead.
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,     6);
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter,   0);
  assertEquals('player.dies',    predOf(r, p.id).dies,      true);
});

// GS-15b — the user's exact reported board: a FEARED Iron Man, 5 ATK / 4 HP /
// Armor 1, opposite a 2-ATK Black Widow. Displayed "-1" with no skull; he
// actually dies to his own swing. Armor applies to the self-hit as well, so
// 5-1=4 from himself plus 2-1=1 from Black Widow = 5 into a 4 HP card.
snap('GS-15b Feared Iron Man dies to his own swing (user report)', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 2, currentHealth: 1, maxHealth: 1 }), 0);
  var a = place(makeCard({ owner: 'ai', attack: 5, currentHealth: 4, maxHealth: 4,
                           armorValue: 1, isFeared: true }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('feared.dmgIn',   predOf(r, a.id).dmgIn,   5);
  assertEquals('feared.hpAfter', predOf(r, a.id).hpAfter, 0);
  assertEquals('feared.dies',    predOf(r, a.id).dies,    true);
  assertEquals('enemy.dmgIn',    predOf(r, p.id).dmgIn,   0);
});

// GS-15c — feared AND frozen is too locked to swing at all, so there is no
// self-hit either. Guards against the fix over-applying.
snap('GS-15c Feared AND frozen: no self-hit', function () {
  reset();
  var a = place(makeCard({ owner: 'ai', attack: 5, currentHealth: 4, maxHealth: 4,
                           isFeared: true, isFrozen: true }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('dmgIn',   predOf(r, a.id).dmgIn,   0);
  assertEquals('hpAfter', predOf(r, a.id).hpAfter, 4);
});

// GS-16 — MC + Frozen co-occurring (the fuzzer-stall config from
// seed 263). Forecast should still be sane: MC card produces 0
// forward, frozen is a redundant gate at the predictor level.
// Pins predictor behavior — separate from the resolver fix in
// resolveUncontestedLane that solved the stall.
snap('GS-16 MC + Frozen attacker: forecast is consistent', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 5, currentHealth: 5, maxHealth: 5, isMindControlled: true, isFrozen: true }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 2, currentHealth: 4, maxHealth: 4 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('ai.dmgIn',       predOf(r, a.id).dmgIn,     0);
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,     2);
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter,   3);
});

// GS-17 — Damage Immunity blocks all damage. Player has
// hasDamageImmunity → 0 incoming. AI still eats player's swing.
snap('GS-17 Damage Immunity: blocks all incoming', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 3, currentHealth: 5, maxHealth: 5, hasDamageImmunity: true }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 4, currentHealth: 6, maxHealth: 6 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,     0);
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter,   5);
  assertEquals('ai.dmgIn',       predOf(r, a.id).dmgIn,     3);
  assertEquals('ai.hpAfter',     predOf(r, a.id).hpAfter,   3);
});

// GS-18 — Invincible turns blocks all damage. Same shape as
// damage immunity but timed (invincibleTurns counter).
snap('GS-18 Invincible turns: blocks all incoming', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 3, currentHealth: 1, maxHealth: 1, invincibleTurns: 1 }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 99, currentHealth: 6, maxHealth: 6 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,     0);
  assertEquals('player.dies',    predOf(r, p.id).dies,      false);
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter,   1);
});

// GS-19 — Zero-attack card. Predictor's _canSwingForward returns
// false for attack ≤ 0 paths via the per-lane simulator. Useful
// regression: Gorilla Grodd in fuzz seed 263 had its attack
// debuffed to 0 and stuck around — no swing should be predicted.
snap('GS-19 Zero-attack: no forward swing predicted', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 0, currentHealth: 3, maxHealth: 3 }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 2, currentHealth: 4, maxHealth: 4 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('ai.dmgIn',       predOf(r, a.id).dmgIn,     0);
  assertEquals('ai.hpAfter',     predOf(r, a.id).hpAfter,   4);
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,     2);
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter,   1);
});

// GS-20 — Stunned attacker (vs GS-04 stunned defender). No
// forward swing; AI defender still swings normally.
snap('GS-20 Stunned attacker: no forward swing predicted', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 3, currentHealth: 5, maxHealth: 5, isStunned: true }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 4, currentHealth: 6, maxHealth: 6 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('ai.dmgIn',       predOf(r, a.id).dmgIn,     0);
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,     4);
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter,   1);
});

// GS-21 — Empty board. predictCombatGlobal on a board with no
// cards returns an empty byId map. Edge-case guard against any
// future change accidentally stamping default entries.
snap('GS-21 Empty board: byId map is empty', function () {
  reset();
  var r = Game.predictCombatGlobal();
  assertEquals('byId.size', r.byId.size, 0);
});

// GS-22 — Multiple evade charges, only one consumed per swing.
// AI has evadeCharges=3, takes player's first swing (charge → 2),
// no further player swings this round. Predictor mutates a SNAP
// copy of the charges, never the live card.
snap('GS-22 Multiple evade charges: live state untouched', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 3, currentHealth: 5, maxHealth: 5 }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 1, currentHealth: 6, maxHealth: 6, evadeCharges: 3 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('ai.dmgIn',     predOf(r, a.id).dmgIn,     0);
  assertEquals('ai.hpAfter',   predOf(r, a.id).hpAfter,   6);
  // Defends against the predictor accidentally mutating gameplay
  // state during forecast — a real bug class we want to bar.
  assertEquals('live evade charges', a.evadeCharges, 3);
});

// GS-23 — Stunned + Frozen co-occurring. Both gate canSwingForward;
// either alone is enough. Defensive guard against the gate being
// reordered to require BOTH false.
snap('GS-23 Stunned + Frozen attacker: still no forward swing', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 3, currentHealth: 5, maxHealth: 5, isStunned: true, isFrozen: true }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 2, currentHealth: 4, maxHealth: 4 }), 0);
  var r = Game.predictCombatGlobal();
  assertEquals('ai.dmgIn',       predOf(r, a.id).dmgIn,     0);
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,     2);
});

// GS-24 — Both sides uncontested (different lanes). Lane 0:
// player only. Lane 1: ai only. No contested combat happens;
// both cards survive at full HP.
snap('GS-24 Both uncontested: cards survive, no dmgIn', function () {
  reset();
  var p = place(makeCard({ owner: 'player', attack: 3, currentHealth: 5, maxHealth: 5 }), 0);
  var a = place(makeCard({ owner: 'ai',     attack: 4, currentHealth: 6, maxHealth: 6 }), 1);
  var r = Game.predictCombatGlobal();
  assertEquals('player.dmgIn',   predOf(r, p.id).dmgIn,   0);
  assertEquals('player.hpAfter', predOf(r, p.id).hpAfter, 5);
  assertEquals('ai.dmgIn',       predOf(r, a.id).dmgIn,   0);
  assertEquals('ai.hpAfter',     predOf(r, a.id).hpAfter, 6);
});

// GS-25 — A DYING attacker's splash cone still fires: BOTH ADJACENT LANES.
// Player 1/1 Splash 3 trades into lane-0 ai 5/6 — the ai eats the front swing
// (1) and NOTHING else, because splash does not hit the card in front; the
// lane-1 ai eats the adjacent splash (3).
//
// UPDATED: this case used to assert the own-lane splash landed too (4 damage
// on the front enemy). applySplash stopped hitting the front lane — "the enemy
// directly in front is NOT splashed, it already ate the normal attack" — and
// this golden was never updated, so it pinned the PREDICTOR's stale copy of the
// old rule and made the forecast over-report against the card opposite.
// Checked against the resolver rather than assumed: running the GS-25b setup
// through applyCombatDamage + applySplash deals Magneto 4, and the corrected
// predictor now also says 4.
//
// What this case still pins is the part that DID survive: a splasher that dies
// in the exchange still splashes, because applySplash gates on having had a
// valid attack, not on post-exchange survival.
snap('GS-25 Dying attacker splash cone: adjacent lanes fire, front does not', function () {
  reset();
  var p  = place(makeCard({ owner: 'player', attack: 1, currentHealth: 1, maxHealth: 1, splashRange: 3 }), 0);
  var a0 = place(makeCard({ owner: 'ai',     attack: 5, currentHealth: 6, maxHealth: 6 }), 0);
  var a1 = place(makeCard({ owner: 'ai',     attack: 0, currentHealth: 4, maxHealth: 4 }), 1);
  var r = Game.predictCombatGlobal();
  assertEquals('player.dies',    predOf(r, p.id).dies,    true);
  // Lane 0 ai: front swing only (1). No own-lane splash.
  assertEquals('ai0.dmgIn',      predOf(r, a0.id).dmgIn,   1);
  assertEquals('ai0.hpAfter',    predOf(r, a0.id).hpAfter, 5);
  // Lane 1 ai eats the adjacent splash (3).
  assertEquals('ai1.dmgIn',      predOf(r, a1.id).dmgIn,   3);
  assertEquals('ai1.hpAfter',    predOf(r, a1.id).hpAfter, 1);
});

// GS-25b — Red Hulk (4 ATK / 3 HP, Splash 3) opposite Magneto (3 ATK / 5 HP),
// alone in the lane. Magneto eats the front swing (4) and SURVIVES on 1: there
// is no adjacent enemy for the splash to reach and the front is not splashed.
// Red Hulk still takes 3 back and dies.
//
// UPDATED alongside GS-25 — this asserted 7 and death, which was the old
// own-lane-splash rule. Verified against the real resolver: applyCombatDamage
// + applySplash on this exact board deals Magneto 4, hp 5 -> 1.
snap('GS-25b Red Hulk (Splash 3) trades: Magneto eats 4 and survives', function () {
  reset();
  var rh  = place(makeCard({ owner: 'player', attack: 4, currentHealth: 3, maxHealth: 3, splashRange: 3 }), 2);
  var mag = place(makeCard({ owner: 'ai',     attack: 3, currentHealth: 5, maxHealth: 5 }), 2);
  var r = Game.predictCombatGlobal();
  assertEquals('magneto.dmgIn',  predOf(r, mag.id).dmgIn,   4);
  assertEquals('magneto.dies',   predOf(r, mag.id).dies,    false);
  assertEquals('redhulk.dies',   predOf(r, rh.id).dies,     true);  // trades, still splashes
});

// GS-26 — predictLaneOutcome (per-lane API). The simpler API
// the damage-preview pill reads when previewing a hand card.
// Pins its return shape so a future API change doesn't silently
// break the preview.
snap('GS-26 predictLaneOutcome: per-lane API shape + values', function () {
  reset();
  place(makeCard({ owner: 'player', attack: 4, currentHealth: 3, maxHealth: 3 }), 0);
  place(makeCard({ owner: 'ai',     attack: 2, currentHealth: 4, maxHealth: 4 }), 0);
  var r = Game.predictLaneOutcome(0);
  assertEquals('shape.player.exists', !!(r && r.player), true);
  assertEquals('shape.ai.exists',     !!(r && r.ai),     true);
  assertEquals('player.hpAfter', r.player.hpAfter, 1);
  assertEquals('player.dies',    r.player.dies,    false);
  assertEquals('ai.hpAfter',     r.ai.hpAfter,     0);
  assertEquals('ai.dies',        r.ai.dies,        true);
});

// GS-27 — predictLaneOutcome with `hypothetical` injection. Used
// when previewing "what would happen if I played this card here?"
// The hypothetical replaces the player's snap WITHOUT mutating
// the live state.
snap('GS-27 predictLaneOutcome: hypothetical card injection', function () {
  reset();
  // Real lane: empty player slot, ai 4/6.
  place(makeCard({ owner: 'ai', attack: 4, currentHealth: 6, maxHealth: 6 }), 0);
  // Hypothetical: drop a 5/3 player card.
  var hypo = {
    name: 'Hypothetical', currentHealth: 3, attack: 5, splashRange: 0,
    armorValue: 0, evadeCharges: 0, invincibleTurns: 0,
    hasDamageImmunity: false, isStunned: false, isFrozen: false,
    isFeared: false, isMindControlled: false, isBullseye: false,
    owner: 'player',
  };
  var r = Game.predictLaneOutcome(0, { player: hypo });
  // 5/3 vs 4/6: ai 6-5=1, doesn't die. Player 3-4 → 0, dies.
  assertEquals('player.dies',    r.player.dies,    true);
  assertEquals('player.hpAfter', r.player.hpAfter, 0);
  assertEquals('ai.dies',        r.ai.dies,        false);
  assertEquals('ai.hpAfter',     r.ai.hpAfter,     1);
});

// ============================================================
// ---- RUNNER -----------------------------------------------
// ============================================================

for (var i = 0; i < __cases.length; i++) {
  var c = __cases[i];
  __caseAssertFailed = false;
  __caseAssertMessages = [];
  var threwErr = null;
  try {
    c.fn();
  } catch (e) {
    threwErr = e && e.message || String(e);
  }
  if (threwErr) {
    __failed++;
    __failures.push({ name: c.name, error: 'threw: ' + threwErr });
    console.log('  FAIL  ' + c.name + ' — threw: ' + threwErr);
  } else if (__caseAssertFailed) {
    __failed++;
    var joined = __caseAssertMessages.join('; ');
    __failures.push({ name: c.name, error: joined });
    console.log('  FAIL  ' + c.name + ': ' + joined);
  } else {
    __passed++;
    console.log('  PASS  ' + c.name);
  }
}

console.log('');
console.log('=== ' + __passed + ' passed, ' + __failed + ' failed ===');
if (__failed > 0) {
  console.log('');
  console.log('Failures:');
  __failures.forEach(function (f) { console.log('  - ' + f.name + ': ' + f.error); });
  if (typeof quit === 'function') quit(1);
}
