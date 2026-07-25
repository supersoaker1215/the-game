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
// IMMUNITY vs UNRESISTIBLE (tryApplyDebuff gate). Stun was merged into Freeze
// (2026-07-24) — stunCard is now a back-compat alias for freezeCard, so these
// still call stunCard (verifying the alias routes correctly) but assert on
// isFrozen, since isStunned is never set anymore.
// ============================================================

// RG-1 — Immunity blocks the freeze; the charge is spent, card not frozen.
gold('RG-1 Immunity blocks freeze (no Unresistible): charge spent, not frozen', function () {
  reset();
  var src = card({ name: 'Stunner', owner: 'ai', abilities: [] });
  var tgt = card({ name: 'Immune',  owner: 'player', abilities: ['Immunity'] });
  eq('immunity before', tgt.immunityCharges, 1);
  Game.stunCard(tgt, src, 1);          // alias → freezeCard
  eq('isFrozen',         !!tgt.isFrozen, false);
  eq('immunity after',   tgt.immunityCharges, 0);
});

// RG-2 — Unresistible pierces Immunity: freeze lands, ONLY Unresistible
// is spent, Immunity is UNTOUCHED (the fix — it never blocked anything).
gold('RG-2 Unresistible pierces Immunity: freeze lands, Immunity untouched', function () {
  reset();
  var src = card({ name: 'Palp',   owner: 'ai',     abilities: ['Unresistible'] });
  var tgt = card({ name: 'Immune', owner: 'player', abilities: ['Immunity'] });
  Game.stunCard(tgt, src, 1);          // alias → freezeCard
  eq('isFrozen',            !!tgt.isFrozen, true);
  eq('src unresistible',    src.unresistibleCharges, 0);
  eq('tgt immunity intact', tgt.immunityCharges, 1);
});

// RG-3 — The exact user bug: a source with ONE Unresistible cannot
// freeze-lock two immune enemies back to back. First lands (spends
// Unresistible); second is blocked by Immunity.
gold('RG-3 One Unresistible cannot double-freeze two immune enemies', function () {
  reset();
  var src = card({ name: 'Palp', owner: 'ai',     abilities: ['Unresistible'] });
  var a   = card({ name: 'Ana',  owner: 'player', abilities: ['Immunity'] });
  var b   = card({ name: 'Sup',  owner: 'player', abilities: ['Immunity'] });
  Game.stunCard(a, src, 1);            // alias → freezeCard
  Game.stunCard(b, src, 1);
  eq('a frozen',        !!a.isFrozen, true);
  eq('b NOT frozen',    !!b.isFrozen, false);
  eq('src unresistible', src.unresistibleCharges, 0);
  eq('a immunity',      a.immunityCharges, 1);  // pierced → untouched
  eq('b immunity',      b.immunityCharges, 0);  // blocked → spent
});

// ============================================================
// FEARED = FROZEN for extra actions (2026-07-24)
// Feared cards can't move or take bonus attacks, matching frozen.
// ============================================================

// RG-3a — a feared card cannot move (moveCard refuses, same as frozen).
gold('RG-3a Feared card cannot move', function () {
  reset();
  var c = card({ name: 'Runner', owner: 'player', attack: 2, health: 5 });
  place(c, 0, 'player');
  c.isFeared = true; c.fearedTurns = 1;
  Game.moveCard(c, 0, 3);
  eq('still in lane 0', Game.state.lanes[0].player === c, true);
  eq('lane 3 empty',    Game.state.lanes[3].player, null);
});

// RG-3b — a feared card drains NO bonus attack; the queued attack is cleared
// and the enemy is untouched. (Also closed the hole where FROZEN cards could
// still bonus-attack.)
gold('RG-3b Feared card takes no bonus attack', function () {
  reset();
  var c = card({ name: 'Striker', owner: 'player', attack: 3, health: 5 });
  var e = card({ name: 'Victim',  owner: 'ai',     attack: 0, health: 5 });
  place(c, 0, 'player'); place(e, 0, 'ai');
  c.isFeared = true; c.fearedTurns = 1; c.bonusAttack = 2;
  Game.drainBonusAttacks(c);
  eq('bonus cleared', !!c.bonusAttack, false);
  eq('victim unharmed', e.currentHealth, 5);
});

// ============================================================
// INTERCEPT PRIORITY — one played card, one "next enemy card" trigger.
// Moder (forcedLane) vs The Batman Who Laughs (nextCardStolen): the
// LOWEST-LANE source claims the card; the loser stays armed. (2026-07-24)
// ============================================================

// RG-3c — Moder (lower lane) claims; BWL loses the tie-break and stays armed.
gold('RG-3c Moder lower lane wins the intercept; BWL stays armed', function () {
  reset();
  place(card({ name: 'The Batman Who Laughs', owner: 'ai' }), 4, 'ai'); // BWL lane 4
  Game.state.player.forcedLane = 1;        // Moder forces the player into lane 1
  Game.state.player.nextCardStolen = true; // BWL armed against the player
  eq('moder wins (1 < 4)', Game._nextEnemyCardClaimant('player'), 'moder');
});

// RG-3d — BWL (lower lane) claims; Moder's forcedLane stays armed so its
// warning persists until a card is genuinely pulled in.
gold('RG-3d BWL lower lane wins the intercept; Moder stays armed', function () {
  reset();
  place(card({ name: 'The Batman Who Laughs', owner: 'ai' }), 0, 'ai'); // BWL lane 0
  Game.state.player.forcedLane = 3;        // Moder lane 3
  Game.state.player.nextCardStolen = true;
  eq('bwl wins (0 < 3)', Game._nextEnemyCardClaimant('player'), 'bwl');
});

// RG-3e — if Moder's lane is occupied he can't claim, so BWL takes it even at
// a higher lane number (feasibility beats raw lane order).
gold('RG-3e Moder cannot claim into an occupied lane; BWL takes it', function () {
  reset();
  place(card({ name: 'Blocker', owner: 'player' }), 1, 'player'); // lane 1 occupied
  place(card({ name: 'The Batman Who Laughs', owner: 'ai' }), 4, 'ai');
  Game.state.player.forcedLane = 1;        // Moder can't pull in — lane full
  Game.state.player.nextCardStolen = true;
  eq('bwl claims (moder blocked)', Game._nextEnemyCardClaimant('player'), 'bwl');
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
// Untrickable blocks ENEMY tricks only; Invincible is a DAMAGE/DESTROY
// shield (blocks destroy + damage, but NOT debuffs); damage-immunity blocks
// damage only. Debuffs are gated by Immunity (immunityCharges), never by
// these damage shields — Invincible != Immunity. A plain body accepts all.
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

  // Invincible: can't destroy / damage, but DEBUFFS still land (damage shield,
  // not a debuff shield — Invincible != Immunity).
  eq('invinc destroy', Game.canEffectLand(invinc, 'destroy', {}), false);
  eq('invinc damage',  Game.canEffectLand(invinc, 'damage',  {}), false);
  eq('invinc debuff',  Game.canEffectLand(invinc, 'debuff',  {}), true);

  // Damage immunity: damage blocked, but destroy AND debuffs still land.
  eq('dmgImm damage',  Game.canEffectLand(dmgImm, 'damage',  {}), false);
  eq('dmgImm destroy', Game.canEffectLand(dmgImm, 'destroy', {}), true);
  eq('dmgImm debuff',  Game.canEffectLand(dmgImm, 'debuff',  {}), true);

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
// ENTITY REGISTRY (id -> live card)
// ============================================================

// RG-9 — createCardInstance registers; findCard resolves the id back to
// the SAME live instance; unknown ids return null; a rebuild picks up
// cards wherever they live (board or hand).
gold('RG-9 entity registry: findCard resolves ids to the live instance', function () {
  reset();
  var a = card({ name: 'Alpha', owner: 'ai' });
  var b = card({ name: 'Beta',  owner: 'player' });
  eq('findCard(a) is a', Game.findCard(a.id) === a, true);
  eq('findCard(b) is b', Game.findCard(b.id) === b, true);
  eq('unknown id -> null', Game.findCard(999999), null);
  // Place on board + hand, rebuild, still resolvable to the same objects.
  place(a, 0, 'ai');
  Game.state.player.hand = [b];
  Game.rebuildEntityIndex();
  eq('board card resolves', Game.findCard(a.id) === a, true);
  eq('hand card resolves',  Game.findCard(b.id) === b, true);
});

// RG-10 — the id-collision audit fires when two DIFFERENT objects share an
// id (the exact class the registry exists to kill), and stays silent on a
// clean board.
gold('RG-10 checkInvariants flags an id collision (two objects, one id)', function () {
  reset();
  var a = card({ name: 'Real',  owner: 'ai' });
  var clone = card({ name: 'Clone', owner: 'ai' });
  clone.id = a.id;                       // force the collision
  place(a, 0, 'ai');
  place(clone, 1, 'ai');
  var v = Game.checkInvariants('golden');
  var hit = v.some(function (line) { return /shared by two DIFFERENT/.test(line); });
  eq('collision reported', hit, true);
  // Clean board → no idCollision.
  reset();
  place(card({ name: 'Solo', owner: 'ai' }), 0, 'ai');
  var v2 = Game.checkInvariants('golden');
  eq('no false positive', v2.some(function (l) { return /shared by two DIFFERENT/.test(l); }), false);
});

// ============================================================
// ENCHANTMENT / BUFF-OBJECT SYSTEM
// ============================================================

// RG-11 — timed buff lifecycle: grantTempBuff adds the delta and tags the
// source; expireGrantedBuffs reverts it once the timer runs out.
gold('RG-11 grantTempBuff applies + auto-expires, tagged with its source', function () {
  reset();
  var src = card({ name: 'Buffer', owner: 'ai' });
  var tgt = card({ name: 'Target', owner: 'ai', attack: 2, health: 5 });
  place(tgt, 0, 'ai');
  Game.grantTempBuff(tgt, { attack: 3 }, 1, src);
  eq('buffed attack', tgt.attack, 5);
  eq('buff count', tgt._grantedBuffs.length, 1);
  eq('buff tagged sourceId', tgt._grantedBuffs[0].sourceId, src.id);
  Game.expireGrantedBuffs();          // one tick → turnsLeft 1 -> 0 -> revert
  eq('reverted attack', tgt.attack, 2);
  eq('buff cleared', tgt._grantedBuffs.length, 0);
});

// RG-12 — source-death cleanup strips ONLY the dying source's buffs and
// leaves another granter's buff on the same target intact.
gold('RG-12 removeGrantedBuffsFromSource strips only that source', function () {
  reset();
  var s1 = card({ name: 'S1', owner: 'ai' });
  var s2 = card({ name: 'S2', owner: 'ai' });
  var tgt = card({ name: 'Target', owner: 'ai', attack: 1, health: 9 });
  place(tgt, 0, 'ai');
  Game.grantTempBuff(tgt, { attack: 2 }, 5, s1);   // long timer, from s1
  Game.grantTempBuff(tgt, { attack: 4 }, 5, s2);   // long timer, from s2
  eq('both applied', tgt.attack, 7);
  Game.removeGrantedBuffsFromSource(s1.id);         // s1 leaves the board
  eq('only s1 stripped', tgt.attack, 5);            // 7 - 2
  eq('one buff left', tgt._grantedBuffs.length, 1);
  eq('remaining is s2', tgt._grantedBuffs[0].sourceId, s2.id);
});

// RG-13 — the stuck-buff audit fires on a buff that can never expire
// (non-finite turn counter) and stays silent on a well-formed buff.
gold('RG-13 checkInvariants flags a stuck (non-expiring) buff', function () {
  reset();
  var tgt = card({ name: 'Cursed', owner: 'ai', attack: 1, health: 9 });
  place(tgt, 0, 'ai');
  Game.grantTempBuff(tgt, { attack: 2 }, 1);
  tgt._grantedBuffs[0].turnsLeft = Infinity;        // corrupt → never expires
  var v = Game.checkInvariants('golden');
  eq('stuck buff reported', v.some(function (l) { return /can never expire/.test(l); }), true);
  // Well-formed buff → silent.
  reset();
  var ok = card({ name: 'Fine', owner: 'ai', attack: 1, health: 9 });
  place(ok, 0, 'ai');
  Game.grantTempBuff(ok, { attack: 2 }, 2);
  eq('no false positive', Game.checkInvariants('golden').some(function (l) { return /can never expire/.test(l); }), false);
});

// ============================================================
// CLIENT-SIDE PREDICTION / RECONCILIATION (netcode core)
// ============================================================

function playableState() {
  reset();
  Game.state.phase = 'player-cards';
  Game.state.activePlayer = 'player';
  Game.state.firstPlayer = 'player';
  Game.state.player.currency = 10;
  Game.state.ai.currency = 10;
  Game.state.player.isHuman = false;
  Game.state.ai.isHuman = false;
  Game._predictions = null; Game._predictSeq = 0;
  return Game;
}

// RG-14 — an ACKED prediction is dropped; the authoritative state stands.
gold('RG-14 reconcile drops an acked prediction, adopts authoritative state', function () {
  playableState();
  var x = card({ name: 'Grunt', owner: 'player', attack: 2, health: 3 });
  Game.state.player.hand = [x];
  var seq = Game.predictCommand({ type: 'playCard', payload: { cardId: x.id, lane: 0 }, actor: 'player' });
  eq('predicted ok', seq > 0, true);
  eq('card left hand', Game.state.player.hand.length, 0);
  eq('card in lane 0', !!Game.state.lanes[0].player, true);
  // Host processed it → authoritative state reflects the play; ack covers seq.
  var authPost = Game.cloneStateDeep(Game.state);
  Game.reconcile(authPost, seq);
  eq('predictions cleared', (Game._predictions || []).length, 0);
  eq('lane still filled', !!Game.state.lanes[0].player, true);
  eq('adopted authoritative', Game.state === authPost, true);
});

// RG-15 — an UN-ACKED prediction is re-applied on the fresh authoritative
// base, so the guest keeps seeing its own in-flight play (no rubber-band).
gold('RG-15 reconcile re-applies an un-acked prediction on the authoritative base', function () {
  playableState();
  var x = card({ name: 'Grunt', owner: 'player', attack: 2, health: 3 });
  Game.state.player.hand = [x];
  // Snapshot the PRE-play state — the host has NOT processed the play yet.
  var authPre = Game.cloneStateDeep(Game.state);
  var seq = Game.predictCommand({ type: 'playCard', payload: { cardId: x.id, lane: 0 }, actor: 'player' });
  eq('predicted play landed', !!Game.state.lanes[0].player, true);
  // Authoritative state arrives WITHOUT the play, ack=0 → re-apply the seq.
  Game.reconcile(authPre, 0);
  eq('prediction survived', (Game._predictions || []).length, 1);
  eq('re-applied: lane filled', !!Game.state.lanes[0].player, true);
  eq('re-applied: hand empty', Game.state.player.hand.length, 0);
});

// ============================================================
// EFFECTS-AS-DATA DSL
// ============================================================

// RG-16 — the declarative DSL reproduces Omni-Man's imperative AoE
// EXACTLY: dealing `sweep` (3) to every living enemy, identical to a
// hand-written getEnemiesOf().forEach. Proves the migration is behavior-
// preserving (the whole point of an effects-as-data layer).
gold('RG-16 effects-as-data DSL matches imperative AoE (Omni-Man)', function () {
  function boardWithEnemies() {
    reset();
    var self = card({ name: 'Omni-Man', owner: 'player', attack: 5, health: 9 });
    place(self, 0, 'player');
    var e1 = card({ name: 'E1', owner: 'ai', attack: 1, health: 5 });  place(e1, 0, 'ai');
    var e2 = card({ name: 'E2', owner: 'ai', attack: 1, health: 4 });  place(e2, 1, 'ai');
    var e3 = card({ name: 'E3', owner: 'ai', attack: 1, health: 10 }); place(e3, 2, 'ai');
    return { self: self, enemies: [e1, e2, e3] };
  }
  var sweep = 3;
  // (A) DSL path — Omni-Man's migrated onPlay runs through Game.runEffect.
  var A = boardWithEnemies();
  CARD_ABILITIES['Omni-Man'].onPlay(Game, A.self, 0);
  var dslHp = A.enemies.map(function (e) { return e.currentHealth; });
  // (B) Imperative reference on an identical board.
  var B = boardWithEnemies();
  Game.getEnemiesOf(B.self.owner).forEach(function (e) { Game.dealDamage(e, sweep, B.self); });
  var impHp = B.enemies.map(function (e) { return e.currentHealth; });
  eq('DSL == imperative', JSON.stringify(dslHp), JSON.stringify(impHp));
  eq('e1 took sweep', dslHp[0], 5 - sweep);
  eq('e2 took sweep', dslHp[1], 4 - sweep);
  eq('e3 took sweep', dslHp[2], 10 - sweep);
});

// RG-17 — the DSL routes through the SAME primitives, so the shared rules
// still apply: an Invincible enemy shrugs off DSL damage exactly as it
// would imperative damage (no separate rules path to drift).
gold('RG-17 DSL damage respects Invincible (shared primitive path)', function () {
  reset();
  var self = card({ name: 'Omni-Man', owner: 'player', attack: 5, health: 9 });
  place(self, 0, 'player');
  var tank = card({ name: 'Tank', owner: 'ai', attack: 1, health: 6 });
  tank.invincibleTurns = 1;
  place(tank, 0, 'ai');
  Game.runEffect({ do: 'damage', target: 'allEnemies', amount: 3 }, { self: self, lane: 0 });
  eq('invincible enemy untouched', tank.currentHealth, 6);
});

// ============================================================
// FORCED-CHOICE AUTO-RESOLVE (no pointless prompts)
// ============================================================

// RG-18 — the global hook: promptCardChoice auto-resolves a multi-candidate
// choice when options.forced is set (the "every candidate gets taken anyway"
// case, e.g. Galactus devouring all remaining enemies) instead of arming a
// modal, and it uses the aiPicker for a sensible first pick. A single
// candidate still auto-resolves as before.
gold('RG-18 promptCardChoice options.forced auto-resolves without a modal', function () {
  reset();
  Game.state.player.isHuman = true;
  Game.state.pendingCardChoice = null;
  var a = card({ name: 'A', owner: 'ai' });
  var b = card({ name: 'B', owner: 'ai' });
  var picked = null;
  Game.promptCardChoice('player', [a, b], 'T', 'd',
    function (t) { picked = t; }, function (cs) { return cs[1]; }, { forced: true });
  eq('forced: callback fired', !!picked, true);
  eq('forced: no modal armed', Game.state.pendingCardChoice, null);
  eq('forced: used aiPicker (cs[1]=B)', picked && picked.name, 'B');
  // A single candidate still auto-resolves (regression on the existing arm).
  Game.state.pendingCardChoice = null;
  var solo = null;
  Game.promptCardChoice('player', [a], 'T', 'd', function (t) { solo = t; }, null, {});
  eq('single: auto-resolved', solo && solo.name, 'A');
  eq('single: no modal', Game.state.pendingCardChoice, null);
});

// RG-19 — Galactus auto-devours every enemy with NO modal when the number
// of enemies is <= its devour count (user: "if there are only 2 or less
// enemies it should happen automatically").
gold('RG-19 Galactus auto-devours all when enemies <= devour count', function () {
  reset();
  Game.state.player.isHuman = true;
  Game.state.ai.isHuman = false;
  Game.state.pendingCardChoice = null;
  var g = card({ name: 'Galactus', owner: 'player', cost: 10, attack: 5, health: 20 });
  g._galactusDevourCount = 2;
  place(g, 0, 'player');
  place(card({ name: 'E1', owner: 'ai', attack: 2, health: 4 }), 0, 'ai');
  place(card({ name: 'E2', owner: 'ai', attack: 2, health: 4 }), 1, 'ai');
  CARD_ABILITIES['Galactus'].onBeforeTricks(Game, g, 0);
  eq('no modal armed', Game.state.pendingCardChoice, null);
  eq('E1 devoured (lane empty)', Game.state.lanes[0].ai, null);
  eq('E2 devoured (lane empty)', Game.state.lanes[1].ai, null);
});

// RG-20 — Darkseid's Omega Beam dumps its whole payload on a single enemy
// with NO "Allocate damage" modal ("darkseids beams as well").
gold('RG-20 Omega Beam dumps all on a single enemy (no allocate modal)', function () {
  reset();
  Game.state.player.isHuman = true;
  Game.state.ai.isHuman = false;
  Game.state.pendingCardChoice = null;
  var d = card({ name: 'Darkseid', owner: 'player', cost: 9, attack: 5, health: 9 });
  place(d, 0, 'player');
  var foe = card({ name: 'Foe', owner: 'ai', attack: 2, health: 12 });
  place(foe, 0, 'ai');
  Game.distributeOmegaBeam(d);
  eq('no modal armed', Game.state.pendingCardChoice, null);
  eq('all 5 dumped on the sole enemy', foe.currentHealth, 12 - 5);
});

// ============================================================
// ABILITY TARGET PREVIEW (hand-selection highlight source)
// ============================================================

// RG-21 — previewAbilityTargets mirrors each ability's own onPlay filter,
// so the board highlight shows exactly the enemies the card could hit.
gold('RG-21 previewAbilityTargets mirrors ability filters (WS/Gamora)', function () {
  reset();
  var ws = card({ name: 'Winter Soldier', owner: 'player', attack: 3, health: 5 });
  place(card({ name: 'Weak', owner: 'ai', attack: 2, health: 8 }), 0, 'ai');   // ATK 2 <= 3 → target
  place(card({ name: 'Strong', owner: 'ai', attack: 6, health: 2 }), 1, 'ai');  // ATK 6 > 3 → not
  eq('WS targets ATK<=3', JSON.stringify(Game.previewAbilityTargets(ws, 'player').map(c => c.name).sort()), JSON.stringify(['Weak']));
  // Gamora executes HP<=2 → only Strong (HP 2). And an Invincible enemy drops
  // out (mirrors the canEffectLand destroy gate).
  var gam = card({ name: 'Gamora', owner: 'player', attack: 2, health: 5 });
  eq('Gamora targets HP<=2', JSON.stringify(Game.previewAbilityTargets(gam, 'player').map(c => c.name)), JSON.stringify(['Strong']));
  Game.state.lanes[1].ai.invincibleTurns = 1;
  eq('Gamora excludes invincible', Game.previewAbilityTargets(gam, 'player').length, 0);
  // A card with no targeting ability previews nothing.
  eq('non-targeting → empty', Game.previewAbilityTargets(card({ name: 'Nobody', owner: 'player' }), 'player').length, 0);
});

// RG-11 — Resolver half of the Invincible-vs-debuff rule: a stat strip
// (debuffCard — used by Nightwing/Bear Trap/Silver Surfer/Bane and the
// Luke/Magneto auras) LANDS on an Invincible card, and Invincible itself is
// untouched (it still blocks damage/destroy). Reverses the old "stat debuffs
// are damage in spirit → Invincible shrugs them off" rule. (User: you can be
// debuffed while Invincible; only Immunity blocks debuffs.)
gold('RG-11 stat debuff (debuffCard) lands on an Invincible card', function () {
  reset();
  var tgt = card({ name: 'Flash', owner: 'ai', attack: 3, health: 4, abilities: [] });
  tgt.invincibleTurns = 2;
  Game.debuffCard(tgt, 2, 1, false, { name: 'Nightwing' });
  eq('atk after -2', tgt.attack, 1);              // debuff LANDED despite Invincible
  eq('maxHp after -1', tgt.maxHealth, 3);
  eq('invincible untouched', tgt.invincibleTurns, 2);  // still a damage/destroy shield
});

// RG-12 — the DESTROY-shield half: an allowKill stat debuff (Bane / Man-Bat /
// Magneto-Luke aura) can NOT kill an Invincible card. The -HP lands (down to a
// floor of 1) but Invincible blocks the destroy — the card survives on the
// board, not stranded <=0 for cleanupDead to reap. (Regression guard for the
// Invincible-allows-debuffs change.)
gold('RG-12 allowKill debuff cannot destroy an Invincible card', function () {
  reset();
  var tgt = card({ name: 'Flash', owner: 'ai', attack: 2, health: 1, abilities: [] });
  tgt.invincibleTurns = 2;
  Game.state.lanes[0].ai = tgt;                    // on the board
  Game.debuffCard(tgt, 1, 5, true, { name: 'Bane' });  // allowKill, huge -HP
  eq('survives (hp floored at 1)', tgt.currentHealth, 1);
  eq('still on the board', Game.state.lanes[0].ai === tgt, true);
  eq('invincible untouched', tgt.invincibleTurns, 2);
  // And a NON-invincible card under the same allowKill debuff IS destroyed.
  reset();
  var mortal = card({ name: 'Mortal', owner: 'ai', attack: 2, health: 1, abilities: [] });
  Game.state.lanes[0].ai = mortal;
  Game.debuffCard(mortal, 1, 5, true, { name: 'Bane' });
  eq('mortal died', !(mortal.currentHealth > 0), true);
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
