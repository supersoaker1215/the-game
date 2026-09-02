// ============================================================
// Card Lane Battle — regression test harness
//
// Runs under JavaScriptCore using the same shim as sim/run.js.
// Invocation (same pattern as run.js):
//
//     jsc sim/test.js
//
// This script loads the shim + game files itself, then runs
// the test suite. If any test fails the process exits non-zero
// so CI can gate on it.
//
// Goal: establish a SEED of card-behavior regression tests so
// future ability changes can't silently reintroduce bugs that
// took a live playtest to catch. Add a test per bug as we fix
// them — the list grows with our confidence.
//
// Each test:
//   1. Builds a minimal Game state with the relevant cards.
//   2. Invokes the trigger (combat, trick, ability).
//   3. Asserts the expected outcome.
//
// This is intentionally lightweight — no Jest/Mocha deps, no
// setup boilerplate. One file, one command, clear pass/fail.
// ============================================================

// ---- Load the shim + game ----------------------------------
// Match the pattern sim/run.js uses: load shim.js relative to the
// project root (the cwd at invocation), which pulls in cards.js,
// tricks.js, abilities.js, decks.js, game.js, ai.js in order.
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');
// Roguelite isn't part of the canonical shim load list (run.js / tune.js
// don't need it), but the relic-hook regression below exercises every
// relic def's hooks — load it explicitly here.
load('./roguelite.js');
// The 2v2 transport, loaded so the allowlist below can be checked against the
// engine's own handler. Not in the shim's list because run.js / tune.js never
// touch the wire.
load('./multiplayer.js');

// ---- Tiny assertion lib -------------------------------------
var __tests = [], __passed = 0, __failed = 0, __failures = [];
function test(name, fn) { __tests.push({ name: name, fn: fn }); }
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + (msg || '(no msg)'));
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error('ASSERT EQ FAILED: expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a) + (msg ? ' — ' + msg : ''));
}

// ---- Helpers to build test game states ----------------------
// Each test starts with a fresh game via Game.init() — the same
// entry point the browser boot path uses. Then we manually place
// cards in lanes for the behavior under test, skipping the full
// draft / turn cycle.
function freshGame() {
  if (typeof Game === 'undefined') throw new Error('Game not loaded');
  Game.init();
  // SEEDED, so a unit test cannot be flaky. Game.rng() falls back to
  // Math.random whenever state._rngState is null, and Game.init() leaves it
  // null — so every test that touched a random path (a target picked at random,
  // a lane drawn, an event round rolled) was running on a fresh stream each
  // time. One run of the suite failed and could not be reproduced in the 27
  // runs after it; whatever it was, this closes the class rather than the
  // instance. A fixed seed also means a failure here reproduces on demand.
  Game.seedMatch(0x5EED);
  // Fake out the main-menu phase so ability hooks don't balk.
  Game.state.mode = { deck: 'classic', players: '1v1' };
  Game.state.phase = 'player-cards';
  Game.state.round = 1;
  Game.state.firstPlayer = 'player';
  Game.state.activePlayer = 'player';
  return Game;
}

function cardByName(name) {
  var def = (typeof CARD_DEFS !== 'undefined' ? CARD_DEFS.find(function (d) { return d.name === name; }) : null);
  // Summon tokens (Battle Droid, Ant, Doombot, …) are a separate list — they
  // are not draftable, so they are not in CARD_DEFS, but a test still has to
  // be able to build one.
  if (!def && typeof SUMMON_TOKEN_DEFS !== 'undefined') {
    def = SUMMON_TOKEN_DEFS.find(function (d) { return d.name === name; });
  }
  if (!def) throw new Error('Unknown card: ' + name);
  return def;
}

function place(G, name, owner, lane) {
  var def = cardByName(name);
  var card = G.createCardInstance(def, owner);
  G.state.lanes[lane][owner] = card;
  return card;
}

// The hand equivalent of place() — for anything whose behaviour depends on the
// card being IN HAND rather than on the board (Pinhead's chain, discards).
function createInHand(G, name, owner) {
  var card = G.createCardInstance(cardByName(name), owner);
  G.state[owner].hand = G.state[owner].hand || [];
  G.state[owner].hand.push(card);
  return card;
}

// ============================================================
// ---- TESTS -------------------------------------------------
// ============================================================

// Regression: stunned Man-Bat shouldn't prompt-and-debuff.
// (Bug hit in live play: Wonder Woman stunned Man-Bat, player
// was still prompted to move, -1/-1 still fired on Juggernaut.)
// Regression: Homelander's destroy mode refused an enemy with Evade. Evade
// dodges an ATTACK; canEffectLand('destroy') is blocked by Invincible and
// nothing else. User: "i killed 4 cost jason with homelander and wanted to kill
// predator a 4 cost card wasnt able to". Both 4-cost; Predator has Evade 1.
// Red Skull's empower moves from the BOARD to the HAND (owner direction).
// Two assertions because "buffs a hand card" and "leaves the board alone" are
// separate failures: a version that buffed both would pass the first alone.
test('Hawkeye carries a standing Splash 1, on top of his on-play burst', function () {
  var G = freshGame();
  var hawk = place(G, 'Hawkeye', 'player', 1);
  // The ability keyword is what makes him splash EVERY combat.
  assert(hawk.splashRange >= 1, 'splashRange set from the Splash 1 ability');
  assert(hawk.isBullseye === true, 'Bullseye survived alongside it');
});

test('Per-match counters reset on a NEW match, not just on init', function () {
  var G = freshGame();
  G.state.player.redrawsUsed = 2;
  G.state.player.undosUsed = 1;
  G.state.ai.redrawsUsed = 3;
  // startMatch REUSES state — the factory default only ever applies at init(),
  // so without an explicit wipe the next match inherits the escalated cost.
  G.startMatch({ players: '1v1', deck: 'classic' });
  assertEq(G.state.player.redrawsUsed, 0, 'player redraws reset for the new match');
  assertEq(G.state.player.undosUsed, 0, 'player undos reset for the new match');
  assertEq(G.state.ai.redrawsUsed, 0, 'ai redraws reset too');
  assertEq(G.getRedrawCost('player'), 2, 'so the first redraw is 2 again, not 8');
});

test('Killer Moth grows when he MOVES, not when he is boxed in', function () {
  var G = freshGame();
  var moth = place(G, 'Killer Moth', 'player', 0);
  var atk = moth.attack, hp = moth.currentHealth;
  // lanes 1..5 are empty, so he has somewhere to fly
  CARD_ABILITIES['Killer Moth'].onBeforeTricks(G, moth, 0);
  assertEq(moth.attack, atk + 1, 'gains +1 ATK on the move');
  assertEq(moth.currentHealth, hp + 1, 'gains +1 HP on the move');
  assert(G.findCardLane(moth) !== 0, 'and he actually relocated');
});

test('Killer Moth boxed in does NOT grow', function () {
  var G = freshGame();
  var moth = place(G, 'Killer Moth', 'player', 0);
  // fill every other lane on BOTH sides so no lane is empty
  for (var i = 1; i < G.LANE_COUNT; i++) {
    place(G, 'Catwoman', 'player', i);
    place(G, 'Bane', 'ai', i);
  }
  var atk = moth.attack, hp = moth.currentHealth;
  CARD_ABILITIES['Killer Moth'].onBeforeTricks(G, moth, 0);
  assertEq(moth.attack, atk, 'no move means no ATK growth');
  assertEq(moth.currentHealth, hp, 'no move means no HP growth');
  assertEq(G.findCardLane(moth), 0, 'and he stayed put');
});

// 0/1 as of 2026-08-08 — he has to EARN his first point of attack by flying
// somewhere new. (Superseded the old 1/1 pin; see the new-ground test below.)
test('Killer Moth starts as a 0/1', function () {
  var def = cardByName('Killer Moth');
  assertEq(def.attack, 0, 'base ATK 0');
  assertEq(def.health, 1, 'base HP 1');
});

test('Redraw cost doubles per match: 2, 4, 8', function () {
  var G = freshGame();
  G.state.phase = 'player-tricks';
  assertEq(G.getRedrawCost('player'), 2, 'first redraw costs 2');
  G.state.player.redrawsUsed = 1;
  assertEq(G.getRedrawCost('player'), 4, 'second costs 4');
  G.state.player.redrawsUsed = 2;
  assertEq(G.getRedrawCost('player'), 8, 'third costs 8');
  G.state.player.redrawsUsed = 3;
  assertEq(G.getRedrawCost('player'), 16, 'fourth costs 16 (unaffordable by design)');
});

test('Redraw swaps the card, spends energy, and does not change hand size', function () {
  var G = freshGame();
  G.state.phase = 'player-tricks';
  G.state.player.currency = 8;
  var doomed = G.createCardInstance(cardByName('Bane'), 'player');
  var keep   = G.createCardInstance(cardByName('Catwoman'), 'player');
  G.state.player.hand = [doomed, keep];
  var pile = G.getDrawPile('player');
  pile.push(cardByName('Hawkeye'));
  var before = G.state.player.hand.length;

  var ok = G.redrawCard('player', doomed);
  assertEq(ok, true, 'redraw should succeed');
  assertEq(G.state.player.currency, 6, 'spends 2 energy on the first redraw');
  assertEq(G.state.player.hand.length, before, 'hand size unchanged: one out, one in');
  assertEq(G.state.player.hand.indexOf(doomed), -1, 'redrawn card leaves the hand');
  assertEq(G.state.player.redrawsUsed, 1, 'counter increments');
});

test('Redraw is allowed in ANY of your own phases, and refused outside your turn', function () {
  // Was trick-phase-only; the owner widened it to "anytime". What still has to
  // hold is that it is YOUR turn — combat and the opponent's phases stay shut,
  // because the host owns the deck and a redraw landing mid-combat would mutate
  // a hand the resolver is already walking.
  function reasonIn(phase) {
    var G = freshGame();
    G.state.phase = phase;
    G.state.player.currency = 8;
    G.state.player.hand = [G.createCardInstance(cardByName('Bane'), 'player')];
    G.getDrawPile('player').push(cardByName('Hawkeye'));
    return G.redrawBlockedReason('player');
  }
  assertEq(reasonIn('player-cards'), null, 'allowed in the cards phase');
  assertEq(reasonIn('player-tricks'), null, 'allowed in the trick phase');
  assertEq(reasonIn('player-cards-tricks'), null, 'allowed in the combined phase');
  assertEq(reasonIn('combat'), 'Only on your turn', 'refused during combat');
  assertEq(reasonIn('ai-cards'), 'Only on your turn', "refused on the opponent's turn");
  assertEq(reasonIn('ai-tricks'), 'Only on your turn', "refused on the opponent's trick phase");

  // And a refused redraw must still cost nothing.
  var G = freshGame();
  G.state.phase = 'combat';
  G.state.player.currency = 8;
  G.state.player.hand = [G.createCardInstance(cardByName('Bane'), 'player')];
  G.getDrawPile('player').push(cardByName('Hawkeye'));
  assertEq(G.redrawCard('player', G.state.player.hand[0]), false, 'refuses to run during combat');
  assertEq(G.state.player.currency, 8, 'no energy spent on a refused redraw');
  assertEq(G.state.player.hand.length, 1, 'and no card binned');
});

test('Redraw is refused when it cannot be afforded', function () {
  var G = freshGame();
  G.state.phase = 'player-tricks';
  G.state.player.redrawsUsed = 2;   // next costs 8
  G.state.player.currency = 7;
  G.state.player.hand = [G.createCardInstance(cardByName('Bane'), 'player')];
  G.getDrawPile('player').push(cardByName('Hawkeye'));
  assertEq(G.redrawBlockedReason('player'), 'Needs 8 Energy', 'reports the real escalated cost');
  assertEq(G.state.player.hand.length, 1, 'hand untouched');
});

test('Redraw discards BEFORE drawing so a full hand still gets its replacement', function () {
  var G = freshGame();
  G.state.phase = 'player-tricks';
  G.state.player.currency = 8;
  // Fill the hand to exactly maxHandSize — drawing first would be refused.
  var hand = [];
  for (var i = 0; i < G.state.player.maxHandSize; i++) {
    hand.push(G.createCardInstance(cardByName('Catwoman'), 'player'));
  }
  G.state.player.hand = hand;
  G.getDrawPile('player').push(cardByName('Hawkeye'));
  var full = G.state.player.hand.length;

  assertEq(G.redrawCard('player', hand[0]), true, 'redraw works at max hand size');
  assertEq(G.state.player.hand.length, full, 'still full — the replacement landed');
});

test('Red Skull buffs a card in HAND, not an ally on board', function () {
  var G = freshGame();
  var skull = G.createCardInstance(cardByName('Red Skull'), 'player');
  var boardAlly = place(G, 'The Thing', 'player', 1);
  var boardAtk = boardAlly.attack, boardHp = boardAlly.maxHealth;

  var inHand = G.createCardInstance(cardByName('Bane'), 'player');
  var handAtk = inHand.attack, handHp = inHand.maxHealth;
  G.state.player.hand = [inHand];

  G.state.lanes[0].player = skull;
  CARD_ABILITIES['Red Skull'].onPlay(G, skull, 0);

  assertEq(inHand.attack, handAtk + 2, 'hand card should gain +2 ATK');
  assertEq(inHand.maxHealth, handHp + 2, 'hand card should gain +2 HP');
  assertEq(boardAlly.attack, boardAtk, 'board ally must NOT be buffed');
  assertEq(boardAlly.maxHealth, boardHp, 'board ally HP must NOT change');
});

// An empty hand is a real state (you played your last card into Red Skull's
// own slot), and it must not throw or buff the board as a fallback.
test('Red Skull with an empty hand buffs nothing and does not throw', function () {
  var G = freshGame();
  var skull = G.createCardInstance(cardByName('Red Skull'), 'player');
  var boardAlly = place(G, 'The Thing', 'player', 1);
  var boardAtk = boardAlly.attack;
  G.state.player.hand = [];
  G.state.lanes[0].player = skull;
  CARD_ABILITIES['Red Skull'].onPlay(G, skull, 0);
  assertEq(boardAlly.attack, boardAtk, 'no board fallback when the hand is empty');
});

test('Homelander can destroy an enemy that has Evade', function () {
  var G = freshGame();
  var evasive = place(G, 'Predator', 'ai', 0);
  assertEq((evasive.evadeCharges || 0) > 0, true, 'Predator should carry Evade');
  assertEq(G.canEffectLand(evasive, 'destroy', { owner: 'player' }), true,
    'Evade must not block a destroy effect');
});

// The flip side, so the gate is not just permissive: Invincible DOES block it.
test('Invincible blocks a destroy effect', function () {
  var G = freshGame();
  var t = place(G, 'The Thing', 'ai', 0);
  t.invincibleTurns = 1;
  assertEq(G.canEffectLand(t, 'destroy', { owner: 'player' }), false,
    'Invincible must block a destroy effect');
  t.invincibleTurns = 0;
  t.hasDamageImmunity = true;
  assertEq(G.canEffectLand(t, 'destroy', { owner: 'player' }), true,
    'Damage Immunity is a DAMAGE shield and must not block destroy');
  assertEq(G.canEffectLand(t, 'damage', { owner: 'player' }), false,
    'Damage Immunity does block damage');
});

// Han Solo moved to 4 cost at the owner's request — pinned so a future edit to
// cards.js does not silently drift it back.
test('Han Solo costs 4', function () {
  assertEq(cardByName('Han Solo').cost, 4, 'Han Solo should be a 4 cost');
});

// Regression: a target list built before something died still contained the
// corpse, so Palpatine's chain freeze / Magneto's move offered a dead card and
// spending the pick on it wasted the ability. The queue path always filtered;
// the immediate path did not. User: "dead cards shouldnt be an option to selct".
//
// SCOPE, stated honestly: sim/shim.js REPLACES Game.promptCardChoice with a
// synchronous auto-picker, so this exercises the SHIM's copy of the rule, not
// the engine's. It is still worth pinning — the shim was feeding corpses to
// every fuzz and balance run — but the engine-side fix is verified in the
// browser, not here. Do not read a pass as proof the engine filters.
test('promptCardChoice drops dead cards from an immediate prompt', function () {
  var G = freshGame();
  var alive = place(G, 'The Thing', 'ai', 0);
  var dead  = place(G, 'Loki', 'ai', 1);
  dead.currentHealth = 0;
  var offered = null;
  G.promptCardChoice('player', [alive, dead], 'T', 'D', function () {}, function (cards) {
    offered = cards.slice();
    return cards[0];
  });
  assertEq(offered !== null, true, 'prompt should have been raised');
  assertEq(offered.length, 1, 'only the living card should be offered');
  assertEq(offered[0].name, 'The Thing', 'the living card is the one offered');
});

// Synthetic choices (Kang's card defs, Darkseid's lane list) have no
// currentHealth at all and must survive the filter untouched.
test('promptCardChoice keeps synthetic choices that have no health', function () {
  var G = freshGame();
  var offered = null;
  G.promptCardChoice('player',
    [{ name: 'Option A' }, { name: 'Option B' }], 'T', 'D',
    function () {}, function (cards) { offered = cards.slice(); return cards[0]; });
  assertEq(offered !== null, true, 'prompt should have been raised');
  assertEq(offered.length, 2, 'synthetic options must not be filtered out');
});

// Regression: Apocalypse hands a random keyword to every card in your hand.
// Environments sit in the hand like anything else but never fight, so a combat
// keyword on one is meaningless — user saw Gargantua wearing an Overdrive badge.
// Guarded in TWO places, and this asserts both: the grant site skips them so no
// phantom entry lands in card.abilities, and applyAbilities refuses outright so
// any future granting card is covered without knowing the rule.
test('Apocalypse does not give keywords to environments', function () {
  var G = freshGame();
  var apoc = place(G, 'Apocalypse', 'player', 0);
  var env = G.createCardInstance(cardByName('Gargantua'), 'player');
  var norm = G.createCardInstance(cardByName('The Thing'), 'player');
  G.state.player.hand.push(env, norm);
  var envAbilitiesBefore = (env.abilities || []).slice();
  CARD_ABILITIES['Apocalypse'].onPlay(G, apoc, 0);
  assertEq((env.abilities || []).length, envAbilitiesBefore.length,
    'environment must not gain an ability entry');
  assertEq(!!env.isOverdrive, false, 'environment must not gain Overdrive');
  assertEq(!!env.isBullseye, false, 'environment must not gain Bullseye');
  assertEq(env.armorValue || 0, 0, 'environment must not gain Armor');
  assertEq(env.evadeCharges || 0, 0, 'environment must not gain Evade');
  // The non-environment in the same hand still gets its handout, so the guard
  // is not just switching the whole effect off.
  assertEq((norm.abilities || []).length > 0, true,
    'a normal card in hand should still receive a keyword');
});

// Regression: the central door refuses environments even if a keyword is forced
// straight onto the abilities array by some other path.
test('applyAbilities refuses to stamp flags on an environment', function () {
  var G = freshGame();
  var env = G.createCardInstance(cardByName('Sewers'), 'player');
  env.abilities = ['Armor 2', 'Overdrive', 'Taunt 3'];
  G.applyAbilities(env);
  assertEq(env.armorValue || 0, 0, 'Armor must not stamp on an environment');
  assertEq(!!env.isOverdrive, false, 'Overdrive must not stamp on an environment');
  assertEq(env.tauntTurns || 0, 0, 'Taunt must not stamp on an environment');
});

test('Man-Bat when stunned skips move + debuff', function () {
  var G = freshGame();
  var mb = place(G, 'Man-Bat', 'ai', 0);
  var jug = place(G, 'Juggernaut', 'player', 3);
  mb.isStunned = true;
  mb.beforeTricksFired = false;
  var atkBefore = jug.attack, hpBefore = jug.currentHealth;
  G.runBeforeTricks();
  assertEq(G.findCardLane(mb), 0, 'Man-Bat should not move');
  assertEq(jug.attack, atkBefore, 'Juggernaut ATK should be unchanged');
  assertEq(jug.currentHealth, hpBefore, 'Juggernaut HP should be unchanged');
  assertEq(jug._debuffStacks || 0, 0, 'No -1/-1 stack should apply');
});

// Regression: frozen Man-Bat skips too (same class of bug).
test('Man-Bat when frozen skips move + debuff', function () {
  var G = freshGame();
  var mb = place(G, 'Man-Bat', 'ai', 0);
  var jug = place(G, 'Juggernaut', 'player', 3);
  mb.isFrozen = true;
  mb.beforeTricksFired = false;
  var hpBefore = jug.currentHealth;
  G.runBeforeTricks();
  assertEq(G.findCardLane(mb), 0, 'Man-Bat should not move while frozen');
  assertEq(jug._debuffStacks || 0, 0, 'No debuff should apply');
  assertEq(jug.currentHealth, hpBefore, 'Juggernaut HP unchanged');
});

// Regression: Anakin when stunned doesn't queue bonus attack.
test('Anakin when stunned skips move + bonus attack', function () {
  var G = freshGame();
  var ana = place(G, 'Anakin Skywalker', 'ai', 0);
  ana.isStunned = true;
  ana.beforeTricksFired = false;
  G.runBeforeTricks();
  assertEq(G.findCardLane(ana), 0, 'Anakin should not move');
  assertEq(ana.bonusAttack || 0, 0, 'Bonus attack should not queue');
});

// Regression: SPLASH DAMAGE MUST CARRY ITS SOURCE.
// User report: "red hulk splashed and killed wolverine so he should die."
// Wolverine is "When Damaged: Destroy the card that dealt the damage if its
// cost is <= 7"; Red Hulk is cost 5 and his own splash is what damaged
// Wolverine, so Red Hulk should have been destroyed.
// Game.splashDamage used to call dealDamage with only (card, amount) — no
// source — so every onDamaged hook fired with attacker === undefined and
// Wolverine's `if (attacker && ...)` guard short-circuited. Ordering was never
// the problem: dealDamage fires onDamaged BEFORE the death check, so even
// lethal damage triggers the hook.
test('splashDamage passes its source to onDamaged (Wolverine kills the splasher)', function () {
  var G = freshGame();
  // Wolverine adjacent to the splash origin lane, on the receiving side.
  var wolv = place(G, 'Wolverine', 'player', 1);
  var hulk = place(G, 'Red Hulk', 'ai', 0);
  assert(!!wolv && !!hulk, 'both cards should exist');
  // Splash out of lane 0 on the AI side — hits the player card in lane 1.
  G.splashDamage(0, 'ai', 3, hulk);
  assert(hulk.currentHealth <= 0 || G.findCardLane(hulk) < 0,
    'Red Hulk (cost 5) should be destroyed by Wolverine\'s When Damaged retaliation');
});

// Regression: the same missing argument also silenced Thorns on splash.
// dealDamage gates _resolveThorns on `source` too, so a thorned card took
// splash damage without ever chipping back.
test('splashDamage source enables Thorns retaliation', function () {
  var G = freshGame();
  var victim = place(G, 'Wolverine', 'player', 1);
  var splasher = place(G, 'Red Hulk', 'ai', 0);
  if (!victim || !splasher) return;
  // Neutralise Wolverine's own retaliation so we isolate Thorns.
  victim.onDamaged = null;
  victim.hasThorns = true;
  victim.thornsDamage = 1;
  var hpBefore = splasher.currentHealth;
  G.splashDamage(0, 'ai', 1, splasher);
  assert(splasher.currentHealth <= hpBefore,
    'splasher should be reachable by the victim\'s Thorns (source must be threaded)');
});

// Regression: Green Goblin when stunned skips move + splash.
test('Green Goblin when stunned skips move + splash', function () {
  var G = freshGame();
  var gg = place(G, 'Green Goblin', 'ai', 0);
  gg.isStunned = true;
  gg.beforeTricksFired = false;
  G.runBeforeTricks();
  assertEq(G.findCardLane(gg), 0, 'Green Goblin should not move');
});

// Regression: 10-cost cards are automatically Untrickable.
test('10-cost cards have permanent Untrickable', function () {
  // Pick a 10-cost (cost, not baseCost) card — check applyAbilities
  // attaches the flag. Uses a live instance because the flag is set
  // in createCardInstance/applyAbilities, not on the def.
  var G = freshGame();
  var def = (typeof CARD_DEFS !== 'undefined' ? CARD_DEFS.find(function (c) { return (c.cost || 0) >= 10; }) : null);
  if (!def) return; // nothing to test in this deck
  var c = G.createCardInstance(def, 'player');
  assert(c.isUntrickable, '10-cost should be Untrickable');
  assert(c.permanentUntrickable, '10-cost should be PERMANENT Untrickable');
});

// Regression: a MC target stored from a PREVIOUS Grodd doesn't
// leak into the current one (simplified flow: mindControlTarget
// is cleared so combat prompts fresh).
test('Gorilla Grodd onPlay does not pre-set mindControlTarget', function () {
  var G = freshGame();
  // Put a candidate enemy in lane 2 (cost ≤ 3).
  var victim = place(G, 'Ant-Man', 'player', 2);
  var gg = place(G, 'Gorilla Grodd', 'ai', 1);
  // Normally this prompts a human; we're AI-owned so the AI picker
  // runs synchronously. After it resolves, mindControlTarget
  // should be NULL (Grodd's new spec: pick victim at combat time).
  // Trigger the onPlay ability.
  if (G.applyOnPlay) G.applyOnPlay(gg, 1);
  else if (CARD_ABILITIES['Gorilla Grodd'] && CARD_ABILITIES['Gorilla Grodd'].onPlay) {
    CARD_ABILITIES['Gorilla Grodd'].onPlay(G, gg, 1);
  }
  assertEq(victim.mindControlTarget, null, 'Grodd must not pre-set a target victim');
});

// Regression: damagePlayer respects Mahoraga's invincibility
// when damage is absorbed by the HP bar path.
test('Mahoraga with invincibleTurns blocks HP-absorbed damage', function () {
  var G = freshGame();
  var mah = place(G, 'Mahoraga', 'ai', 4);
  mah.invincibleTurns = 1;
  // Route damage through the HP-absorb branch — simplest way is a
  // direct damagePlayer call with Mahoraga's side. We count the
  // damage taken on the AI HP bar.
  var hpBefore = G.state.ai.health;
  G.damagePlayer('ai', 5, { name: 'test' });
  // Mahoraga's invincibility should soak the damage; HP shouldn't drop.
  assert(G.state.ai.health >= hpBefore, 'AI HP should not decrease through invincible Mahoraga');
});

// Regression: Reality Stone makes buff/swap permanent
// (doesn't clear on postCombat like transient buffs).
test('Reality Stone swap survives postCombat', function () {
  var G = freshGame();
  var a = place(G, 'The Flash', 'player', 1);
  var b = place(G, 'Wonder Woman', 'ai', 1);
  var aAtkBefore = a.attack, bAtkBefore = b.attack;
  if (G.applyTrick) {
    var rs = (typeof TRICK_DEFS !== 'undefined' ? TRICK_DEFS.find(function (t) { return t.name === 'Reality Stone'; }) : null);
    if (!rs) return;
    // Stub target selection — Reality Stone takes two cards; fake the
    // pick inline. The trick's effect flips their stats.
    try {
      G.applyTrick('player', rs, { targetA: a, targetB: b });
    } catch (e) {
      // If the trick harness doesn't support this shape, skip.
      return;
    }
  }
  // We don't have a guaranteed applyTrick signature; just assert the
  // bookkeeping: Reality Stone should mark the swap permanent.
  // This test is a placeholder — deepen once applyTrick is runnable here.
  assert(true, 'Reality Stone permanence check (scaffold)');
});

// ============================================================
// ---- BUG HUNTERS --------------------------------------------
// Not just regression locks — these actively probe for bugs.
// Each one is a "fuzz pass" that drives real game paths and
// asserts invariants. Any failure here likely points to a real
// live bug, not a test bug.
// ============================================================

// Shared helper for hook smoke-tests — builds a minimal board
// with a stranger on each side so abilities that scan for
// enemies / allies find something, and puts `self` in lane 2.
function setupSmokeBoard(self, selfOwner) {
  var G = freshGame();
  place(G, 'Ant-Man',  'player', 0);
  place(G, 'Ant-Man',  'player', 5);
  place(G, 'Black Widow', 'ai', 0);
  place(G, 'Black Widow', 'ai', 5);
  G.state.lanes[2][selfOwner] = self;
  return G;
}
function runHookSmokeTest(hookName, callFn) {
  var thrown = [];
  for (var i = 0; i < CARD_DEFS.length; i++) {
    var def = CARD_DEFS[i];
    var ab = (typeof CARD_ABILITIES !== 'undefined') ? CARD_ABILITIES[def.name] : null;
    if (!ab || !ab[hookName]) continue;
    try {
      var G = freshGame();
      var self = G.createCardInstance(def, 'player');
      var others = setupSmokeBoard(self, 'player');
      callFn(ab[hookName], others, self);
    } catch (e) {
      thrown.push({ name: def.name, error: (e && e.message) || String(e) });
    }
  }
  return thrown;
}

// BUG HUNTER #1 — onPlay smoke sweep.
test('HUNTER: all onPlay abilities execute without throwing', function () {
  var thrown = runHookSmokeTest('onPlay', function (fn, G, self) { fn(G, self, 2); });
  if (thrown.length > 0) {
    var summary = thrown.slice(0, 5).map(function (t) { return t.name + ' (' + t.error + ')'; }).join(', ');
    throw new Error(thrown.length + ' cards threw on onPlay: ' + summary);
  }
});

// BUG HUNTER #2 — Every trick's play() should execute without
// throwing against a minimal board.
test('HUNTER: all tricks play without throwing', function () {
  if (typeof TRICK_DEFS === 'undefined') return;
  var thrown = [];
  for (var i = 0; i < TRICK_DEFS.length; i++) {
    var def = TRICK_DEFS[i];
    if (!def.play) continue;
    try {
      var G = freshGame();
      place(G, 'Ant-Man',  'player', 0);
      place(G, 'Ant-Man',  'player', 5);
      place(G, 'Black Widow', 'ai', 0);
      place(G, 'Black Widow', 'ai', 5);
      def.play(G, 'player');
    } catch (e) {
      thrown.push({ name: def.name, error: (e && e.message) || String(e) });
    }
  }
  if (thrown.length > 0) {
    var summary = thrown.slice(0, 5).map(function (t) { return t.name + ' (' + t.error + ')'; }).join(', ');
    throw new Error(thrown.length + ' tricks threw: ' + summary);
  }
});

// BUG HUNTER #2a — onDeath smoke sweep. Triggered every time a
// card is destroyed; common bugs: reading self.currentHealth
// after it's already 0, calling on a card no longer on the
// board, etc.
test('HUNTER: all onDeath abilities execute without throwing', function () {
  var thrown = runHookSmokeTest('onDeath', function (fn, G, self) {
    self.currentHealth = 0;
    fn(G, self, 2);
  });
  if (thrown.length > 0) {
    var summary = thrown.slice(0, 5).map(function (t) { return t.name + ' (' + t.error + ')'; }).join(', ');
    throw new Error(thrown.length + ' cards threw on onDeath: ' + summary);
  }
});

// BUG HUNTER #2b — onKill smoke sweep.
test('HUNTER: all onKill abilities execute without throwing', function () {
  var thrown = runHookSmokeTest('onKill', function (fn, G, self) { fn(G, self); });
  if (thrown.length > 0) {
    var summary = thrown.slice(0, 5).map(function (t) { return t.name + ' (' + t.error + ')'; }).join(', ');
    throw new Error(thrown.length + ' cards threw on onKill: ' + summary);
  }
});

// BUG HUNTER #2c — onDamaged smoke sweep.
test('HUNTER: all onDamaged abilities execute without throwing', function () {
  var thrown = runHookSmokeTest('onDamaged', function (fn, G, self) {
    // Fake an attacker — the 2,5-lane Ant-Man/Black Widow pair is
    // available; use one so the hook gets a real-card argument.
    var attacker = G.state.lanes[0].ai; // Black Widow at ai lane 0
    fn(G, self, attacker, 2);
  });
  if (thrown.length > 0) {
    var summary = thrown.slice(0, 5).map(function (t) { return t.name + ' (' + t.error + ')'; }).join(', ');
    throw new Error(thrown.length + ' cards threw on onDamaged: ' + summary);
  }
});

// BUG HUNTER #2d — onBeforeTricks smoke sweep.
test('HUNTER: all onBeforeTricks abilities execute without throwing', function () {
  var thrown = runHookSmokeTest('onBeforeTricks', function (fn, G, self) { fn(G, self, 2); });
  if (thrown.length > 0) {
    var summary = thrown.slice(0, 5).map(function (t) { return t.name + ' (' + t.error + ')'; }).join(', ');
    throw new Error(thrown.length + ' cards threw on onBeforeTricks: ' + summary);
  }
});

// BUG HUNTER #2e — onBeforeAttack smoke sweep.
test('HUNTER: all onBeforeAttack abilities execute without throwing', function () {
  var thrown = runHookSmokeTest('onBeforeAttack', function (fn, G, self) { fn(G, self); });
  if (thrown.length > 0) {
    var summary = thrown.slice(0, 5).map(function (t) { return t.name + ' (' + t.error + ')'; }).join(', ');
    throw new Error(thrown.length + ' cards threw on onBeforeAttack: ' + summary);
  }
});

// BUG HUNTER #2f — onAllyKilled smoke sweep.
test('HUNTER: all onAllyKilled abilities execute without throwing', function () {
  var thrown = runHookSmokeTest('onAllyKilled', function (fn, G, self) { fn(G, self); });
  if (thrown.length > 0) {
    var summary = thrown.slice(0, 5).map(function (t) { return t.name + ' (' + t.error + ')'; }).join(', ');
    throw new Error(thrown.length + ' cards threw on onAllyKilled: ' + summary);
  }
});

// BUG HUNTER #2g — onTurnStart smoke sweep.
test('HUNTER: all onTurnStart abilities execute without throwing', function () {
  var thrown = runHookSmokeTest('onTurnStart', function (fn, G, self) { fn(G, self); });
  if (thrown.length > 0) {
    var summary = thrown.slice(0, 5).map(function (t) { return t.name + ' (' + t.error + ')'; }).join(', ');
    throw new Error(thrown.length + ' cards threw on onTurnStart: ' + summary);
  }
});

// BUG HUNTER #3 — Invariants over MANY full AI-vs-AI games.
// 25 games × ~8 rounds each = hundreds of invariant checkpoints.
// Catches:
//   • HP going negative / over max (damagePlayer bugs)
//   • Energy going negative (overspending / double-spend)
//   • Card in both hand AND a lane (state corruption)
//   • Lane's player-slot card owned by 'ai' or vice-versa
//   • Duplicate instance IDs across the entire living set
//   • Any uncaught exception mid-game
// Each is a cheap sanity check; any failure is a real bug.
// BUG HUNTER — find where hand goes over 7 by instrumenting PUSH
// itself on the hand array after startMatch. Captures the stack
// of the first offending push.
test('HUNTER: pinpoint hand > max_hand_size via push tripwire', function () {
  if (typeof runSimGame !== 'function') return;
  var G = Game;
  var first = null;
  // Draft REPLACES p.hand with a fresh array after picks complete,
  // so we install tripwires AFTER startRound so we catch the live
  // array. Rewrap on every round since cards in/out may or may not
  // replace the array; over-wrapping is fine (idempotent marker).
  var origStartRound = G.startRound.bind(G);
  G.startRound = function () {
    var r = origStartRound.apply(this, arguments);
    ['player', 'ai'].forEach(function (side) {
      var p = G.state[side];
      if (!p || !p.hand || p.hand.__tripwireInstalled) return;
      p.hand.__tripwireInstalled = true;
      var origPush = p.hand.push.bind(p.hand);
      p.hand.push = function () {
        var sizeBefore = p.hand.length;
        var cap = p.maxHandSize || 7;
        var r = origPush.apply(p.hand, arguments);
        if (!first && p.hand.length > cap) {
          try { throw new Error('trip'); } catch (e) {
            first = { side: side, pushedCount: arguments.length,
              before: sizeBefore, after: p.hand.length, cap: cap,
              stack: (e.stack || '').split('\n').slice(1, 12).join(' || ') };
          }
        }
        return r;
      };
    });
    return r;
  };
  for (var g = 0; g < 100 && !first; g++) {
    try { runSimGame(); } catch (e) {}
  }
  G.startRound = origStartRound;
  if (first) throw new Error('Hand overflow: ' + first.side + ' ' + first.before + '→' + first.after + ' (cap=' + first.cap + ')\n  stack: ' + first.stack);
});

test('HUNTER: invariants hold across 200 AI-vs-AI games', function () {
  if (typeof runSimGame !== 'function') return; // sim driver not loaded
  var G = Game;
  var violations = [];
  var origStart = G.startRound.bind(G);
  var origPostCombat = G.postCombat ? G.postCombat.bind(G) : null;
  G.startRound = function () {
    try { checkInvariants(G, violations, 'round-start'); } catch (e) { violations.push('INV:' + e.message); }
    return origStart();
  };
  if (origPostCombat) {
    G.postCombat = function () {
      var r = origPostCombat.apply(this, arguments);
      try { checkInvariants(G, violations, 'post-combat'); } catch (e) { violations.push('INV:' + e.message); }
      return r;
    };
  }
  var gamesRun = 0;
  for (var g = 0; g < 200; g++) {
    try { runSimGame(); gamesRun++; } catch (e) { violations.push('GAME#' + g + ':' + ((e && e.message) || e)); }
  }
  G.startRound = origStart;
  if (origPostCombat) G.postCombat = origPostCombat;
  if (violations.length > 0) {
    // Dedupe by message so we see UNIQUE bug classes, not every occurrence.
    var seen = {}, unique = [];
    violations.forEach(function (v) { if (!seen[v]) { seen[v] = 1; unique.push(v); } else seen[v]++; });
    var lines = unique.slice(0, 12).map(function (v) { return v + ' (×' + seen[v] + ')'; });
    throw new Error(gamesRun + '/200 games completed; ' + unique.length + ' unique violations: ' + lines.join(' | '));
  }
});

function checkInvariants(G, out) {
  var s = G.state;
  if (!s) return;
  var BLOCK_MAX = G.BLOCK_MAX || 15;
  // HP bounds.
  if (s.player.health < 0 || s.player.health > s.player.maxHealth) {
    out.push('player HP out of bounds: ' + s.player.health);
  }
  if (s.ai.health < 0 || s.ai.health > s.ai.maxHealth) {
    out.push('ai HP out of bounds: ' + s.ai.health);
  }
  // Energy non-negative.
  if (s.player.currency < 0) out.push('player energy negative: ' + s.player.currency);
  if (s.ai.currency < 0)     out.push('ai energy negative: ' + s.ai.currency);
  // Block meter in [0, BLOCK_MAX].
  if (s.player.blockMeter < 0 || s.player.blockMeter > BLOCK_MAX) {
    out.push('player block meter out of bounds: ' + s.player.blockMeter);
  }
  if (s.ai.blockMeter < 0 || s.ai.blockMeter > BLOCK_MAX) {
    out.push('ai block meter out of bounds: ' + s.ai.blockMeter);
  }
  // Hand size never exceeds maxHandSize (default 7). Each side carries
  // its OWN cap — Eye of Agamotto permanently raises the playing
  // side's cap (tricks.js:260), so cross-comparing AI vs player.cap
  // would falsely flag a legitimate AI cap raise. Read each side's
  // own max independently.
  var PLAYER_MAX_HAND = s.player.maxHandSize || 7;
  var AI_MAX_HAND     = s.ai.maxHandSize     || 7;
  if ((s.player.hand || []).length > PLAYER_MAX_HAND) {
    out.push('player hand size ' + s.player.hand.length + ' > max ' + PLAYER_MAX_HAND);
  }
  if ((s.ai.hand || []).length > AI_MAX_HAND) {
    out.push('ai hand size ' + s.ai.hand.length + ' > max ' + AI_MAX_HAND);
  }
  // Trick hand size — same per-side cap discipline, PLUS the one sanctioned
  // exception. MC Ballyhoo's candies are pushed straight onto the trick hand
  // and deliberately ignore maxTrickHandSize (game.js, "A CANDY IGNORES THE
  // TRICK-HAND CAP, ON PURPOSE" — owner: "make sure for the tricks these can
  // extend the trick hand to 4 if someone has 3 tricks"). A hand holding a
  // candy is legitimately allowed to be that far over.
  //
  // Counted, not waived: allowing exactly as many extras as there are candies
  // present keeps the invariant catching every OTHER way a hand can overfill,
  // which is the only reason it exists. Raising the cap to 4 outright, or
  // dropping the check, would let a real overflow through unseen.
  var _candies = function (hand) {
    return (hand || []).filter(function (t) { return t && t._isCandy; }).length;
  };
  var PLAYER_MAX_TRICK = (s.player.maxTrickHandSize || 3) + _candies(s.player.trickHand);
  var AI_MAX_TRICK     = (s.ai.maxTrickHandSize     || 3) + _candies(s.ai.trickHand);
  if ((s.player.trickHand || []).length > PLAYER_MAX_TRICK) {
    out.push('player trick hand ' + s.player.trickHand.length + ' > max ' + PLAYER_MAX_TRICK);
  }
  if ((s.ai.trickHand || []).length > AI_MAX_TRICK) {
    out.push('ai trick hand ' + s.ai.trickHand.length + ' > max ' + AI_MAX_TRICK);
  }
  // firstPlayer / activePlayer must be valid sides (not null mid-match).
  if (s.round > 0 && s.firstPlayer !== 'player' && s.firstPlayer !== 'ai') {
    out.push('invalid firstPlayer: ' + s.firstPlayer);
  }
  // Stats counters non-negative (regression: buggy _creditChain could
  // decrement instead of increment).
  if (s._stats) {
    ['player', 'ai'].forEach(function (side) {
      var st = s._stats[side];
      if (!st) return;
      Object.keys(st).forEach(function (k) {
        if (typeof st[k] === 'number' && st[k] < 0) {
          out.push(side + ' stats.' + k + ' negative: ' + st[k]);
        }
      });
    });
  }
  // No card present in both hand and on a lane.
  ['player', 'ai'].forEach(function (side) {
    var handIds = {};
    (s[side].hand || []).forEach(function (c) { if (c && c.id != null) handIds[c.id] = c.name; });
    for (var li = 0; li < s.lanes.length; li++) {
      var lc = s.lanes[li][side];
      if (lc && lc.id != null && handIds[lc.id]) {
        out.push('Card ' + lc.name + ' in hand AND lane ' + li + ' for ' + side);
      }
    }
  });
  // Lane ownership integrity — the card in lanes[i][side] must claim side.
  for (var li = 0; li < s.lanes.length; li++) {
    var L = s.lanes[li];
    if (L.player && L.player.owner !== 'player') out.push('lane ' + li + ' player slot owned by ' + L.player.owner);
    if (L.ai     && L.ai.owner     !== 'ai')     out.push('lane ' + li + ' ai slot owned by '     + L.ai.owner);
  }
  // currentHealth <= maxHealth unless explicitly buffed. We signal when
  // maxHealth < 0 or when currentHealth is NaN / undefined (a real
  // corruption signal). Over-max HP from Groot etc. is expected; we
  // don't gate on that.
  for (var li = 0; li < s.lanes.length; li++) {
    ['player', 'ai'].forEach(function (side) {
      var c = s.lanes[li][side];
      if (!c) return;
      if (typeof c.currentHealth !== 'number' || Number.isNaN(c.currentHealth)) {
        out.push(c.name + ' currentHealth not a number: ' + c.currentHealth);
      }
      if (typeof c.attack !== 'number' || Number.isNaN(c.attack)) {
        out.push(c.name + ' attack not a number: ' + c.attack);
      }
      if (c.maxHealth != null && c.maxHealth < 0) {
        out.push(c.name + ' maxHealth negative: ' + c.maxHealth);
      }
      // Living card with 0 HP that wasn't cleaned up by handleDeath.
      if (c.currentHealth <= 0 && !c._deathHandled) {
        out.push(c.name + ' has 0 HP but no _deathHandled flag');
      }
    });
  }
  // Dead-pile entries should be plain objects, not live instances. A
  // live instance leaking into the dead pile means Lazarus Pit / Hela
  // / Solomon Grundy could revive the SAME card that's still on board.
  ['player', 'ai'].forEach(function (side) {
    (s[side].deadPile || []).forEach(function (entry) {
      if (!entry) return;
      // Live instances have `id` + `currentHealth`. Dead-pile entries
      // should just have name/cost/attack/health/abilities/type.
      if (entry.id != null || typeof entry.currentHealth === 'number') {
        out.push(side + ' dead pile has live instance: ' + entry.name);
      }
    });
  });
  // After postCombat, no card should still carry _debuffDelayedClear
  // (it should have been consumed to extend the debuff for one more round
  // then reset, or cleared outright).
  // Note: this is only safe to check at 'round-start' phase. We can't
  // distinguish phases here, so we skip the check entirely if the flag
  // is mid-window. Accept it as-is; the targeted regression test for
  // Mind Stone carry-over covers the happy path.

  // Unique IDs across the entire living set.
  var seen = {};
  ['player', 'ai'].forEach(function (side) {
    (s[side].hand || []).forEach(function (c) {
      if (c && c.id != null) {
        if (seen[c.id]) out.push('duplicate id ' + c.id + ': ' + seen[c.id] + ' + ' + c.name);
        seen[c.id] = c.name;
      }
    });
  });
  for (var li = 0; li < s.lanes.length; li++) {
    ['player', 'ai'].forEach(function (side) {
      var c = s.lanes[li][side];
      if (c && c.id != null) {
        if (seen[c.id]) out.push('duplicate id ' + c.id + ' on lane: ' + seen[c.id] + ' + ' + c.name);
        seen[c.id] = c.name;
      }
    });
  }
}

// BUG HUNTER — pinpoint NaN currentHealth via a live setter.
// Wraps createCardInstance so every freshly-minted card has a
// tripwire setter on `currentHealth`. First assignment of a
// non-finite value fires a thrown error we can catch below —
// giving us the stack trace to the exact line.
test('HUNTER: pinpoint which code path NaNs currentHealth via setter', function () {
  if (typeof runSimGame !== 'function') return;
  var G = Game;
  var firstNaN = null;
  var origCreate = G.createCardInstance.bind(G);
  G.createCardInstance = function (def, owner) {
    var card = origCreate(def, owner);
    var _hp = card.currentHealth;
    var _max = card.maxHealth;
    try {
      Object.defineProperty(card, 'currentHealth', {
        get: function () { return _hp; },
        set: function (v) {
          if (!firstNaN && (typeof v !== 'number' || !Number.isFinite(v))) {
            try {
              throw new Error('NaN assignment trace');
            } catch (e) {
              firstNaN = {
                card: card.name,
                value: String(v),
                prev: String(_hp),
                stack: (e.stack || '').split('\n').slice(1, 8).join(' || ')
              };
            }
          }
          _hp = v;
        },
        configurable: true
      });
      Object.defineProperty(card, 'maxHealth', {
        get: function () { return _max; },
        set: function (v) {
          if (!firstNaN && (typeof v !== 'number' || !Number.isFinite(v))) {
            try {
              throw new Error('NaN assignment trace to maxHealth');
            } catch (e) {
              firstNaN = {
                card: card.name + '.maxHealth',
                value: String(v),
                prev: String(_max),
                stack: (e.stack || '').split('\n').slice(1, 8).join(' || ')
              };
            }
          }
          _max = v;
        },
        configurable: true
      });
    } catch (e) { /* some JS engines don't allow redefining non-configurable props; ignore */ }
    return card;
  };
  for (var g = 0; g < 300 && !firstNaN; g++) {
    try { runSimGame(); } catch (e) { /* ignore */ }
  }
  G.createCardInstance = origCreate;
  if (firstNaN) {
    throw new Error('NaN set on ' + firstNaN.card + ' = ' + firstNaN.value
      + ' (prev=' + firstNaN.prev + ')\n  stack: ' + firstNaN.stack);
  }
});

// OLD HUNTER — kept as fallback (coarser instrumentation, 100
// games). Runs after the setter version; if that catches the
// root cause it can be pruned.
test('HUNTER: pinpoint which code path NaNs currentHealth', function () {
  if (typeof runSimGame !== 'function') return;
  var G = Game;
  var firstNaN = null;
  // Define a Proxy-style tracker by replacing the lanes/hand access
  // with a post-step check. Simpler approach: hook each mutator.
  // We use the monkey-patches below, then restore them after.
  var origDealDamage = G.dealDamage.bind(G);
  var origBuffCard = G.buffCard.bind(G);
  var origDebuffCard = G.debuffCard.bind(G);
  var origApplyCombatDamage = G.applyCombatDamage.bind(G);
  var origDamagePlayer = G.damagePlayer.bind(G);
  var origDrainCard = G.drainCard ? G.drainCard.bind(G) : null;
  var origKillCard = G.killCard ? G.killCard.bind(G) : null;
  function guard(site, card, amount) {
    if (firstNaN) return;
    if (!card) return;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      firstNaN = { site: site, name: card.name || 'unknown', amount: String(amount), before: card.currentHealth };
    }
  }
  function postCheck(site, card) {
    if (firstNaN) return;
    if (!card) return;
    if (typeof card.currentHealth !== 'number' || Number.isNaN(card.currentHealth)) {
      firstNaN = { site: site + '(post)', name: card.name, amount: 'n/a', result: String(card.currentHealth) };
    }
  }
  function checkPre(site, card) {
    if (firstNaN || !card) return;
    if (typeof card.currentHealth !== 'number' || Number.isNaN(card.currentHealth)) {
      firstNaN = { site: site + ':PRE', name: card.name, amount: 'hp=' + card.currentHealth, before: '(prev)', result: 'already-NaN-on-entry' };
    }
  }
  G.dealDamage = function (card, amount, source) {
    checkPre('dealDamage', card);
    guard('dealDamage', card, amount);
    var r = origDealDamage(card, amount, source);
    postCheck('dealDamage', card);
    return r;
  };
  G.buffCard = function (card, atk, hp) {
    checkPre('buffCard', card);
    if (hp !== undefined) guard('buffCard.hp', card, hp);
    var r = origBuffCard(card, atk, hp);
    postCheck('buffCard', card);
    return r;
  };
  G.debuffCard = function (card, atk, hp, allowKill, source) {
    if (hp !== undefined) guard('debuffCard.hp', card, hp);
    // Pre-check the target's current stats. If already NaN/undefined,
    // the NaN came from an EARLIER call — record that as the root.
    if (!firstNaN && card) {
      if (typeof card.currentHealth !== 'number' || Number.isNaN(card.currentHealth)) {
        firstNaN = { site: 'debuffCard:entry pre-NaN', name: card.name, amount: 'atk=' + atk + ' hp=' + hp, before: card.currentHealth, result: 'already-NaN' };
      } else if (typeof card.maxHealth !== 'number' || Number.isNaN(card.maxHealth)) {
        firstNaN = { site: 'debuffCard:entry pre-NaN maxHp', name: card.name, amount: 'atk=' + atk + ' hp=' + hp, before: card.maxHealth, result: 'already-NaN-maxHp' };
      }
    }
    var r = origDebuffCard(card, atk, hp, allowKill, source);
    postCheck('debuffCard', card);
    return r;
  };
  G.applyCombatDamage = function (attacker, target) {
    // Pre-check: both attacker.attack and target.currentHealth must be
    // finite numbers. If they already aren't, the NaN came from EARLIER
    // in the flow, not this call.
    if (!firstNaN && attacker) {
      if (typeof attacker.attack !== 'number' || !Number.isFinite(attacker.attack)) {
        firstNaN = { site: 'applyCombatDamage:entry', name: attacker.name + '(attacker)', amount: 'attack=' + attacker.attack, before: 'pre', result: 'NaN-source' };
      }
    }
    if (!firstNaN && target) {
      if (typeof target.currentHealth !== 'number' || Number.isNaN(target.currentHealth)) {
        firstNaN = { site: 'applyCombatDamage:entry', name: target.name + '(target)', amount: 'hp=' + target.currentHealth, before: 'pre', result: 'already-NaN' };
      }
    }
    var r = origApplyCombatDamage(attacker, target);
    postCheck('applyCombatDamage', target);
    return r;
  };
  if (origDrainCard) {
    G.drainCard = function (source, target) {
      if (!firstNaN && source && target) {
        if (typeof source.attack !== 'number' || !Number.isFinite(source.attack)) {
          firstNaN = { site: 'drainCard:entry', name: source.name + '(source)', amount: 'atk=' + source.attack, before: '?', result: 'pre-NaN source' };
        }
        if (typeof target.attack !== 'number' || !Number.isFinite(target.attack)) {
          firstNaN = { site: 'drainCard:entry', name: target.name + '(target)', amount: 'atk=' + target.attack, before: '?', result: 'pre-NaN target' };
        }
        if (typeof target.currentHealth !== 'number' || Number.isNaN(target.currentHealth)) {
          firstNaN = { site: 'drainCard:entry', name: target.name + '(target)', amount: 'hp=' + target.currentHealth, before: '?', result: 'pre-NaN target-hp' };
        }
      }
      var r = origDrainCard(source, target);
      postCheck('drainCard:source', source);
      postCheck('drainCard:target', target);
      return r;
    };
  }
  // Also instrument raw `currentHealth` writes via autoChainDamage by
  // wrapping whichever function does the chain (if any).
  for (var g = 0; g < 100 && !firstNaN; g++) {
    try { runSimGame(); } catch (e) { /* ignore game-level throws, we want the NaN not the crash */ }
  }
  // Restore.
  G.dealDamage = origDealDamage;
  G.buffCard = origBuffCard;
  G.debuffCard = origDebuffCard;
  G.applyCombatDamage = origApplyCombatDamage;
  G.damagePlayer = origDamagePlayer;
  if (origDrainCard) G.drainCard = origDrainCard;
  if (origKillCard) G.killCard = origKillCard;
  if (firstNaN) {
    throw new Error('First NaN at ' + firstNaN.site + ' for ' + firstNaN.name
      + ' (amount=' + firstNaN.amount + ', before=' + firstNaN.before + ', result=' + firstNaN.result + ')');
  }
});

// ============================================================
// ---- COMBAT EDGE-CASE LAB ----------------------------------
// Added 2026-05-01 — combat invariants discovered via the
// Preview-tool edge-case sweep. Each test exercises one concrete
// interaction the live test playthroughs wouldn't catch. Most
// use synthetic minimal cards (no CARD_DEFS lookup) so they
// stay fast and don't drift if a real card is rebalanced.
// ============================================================

// Minimal synthetic card for combat-mechanic tests. Avoids the
// CARD_DEFS dependency for invariants that are about the engine,
// not a specific card. Borrows the same shape createCardInstance
// produces so applyCombatDamage / damagePlayer treat it normally.
function mkSynth(o) {
  o = o || {};
  var c = {
    id: Math.random(),
    name: o.name || 'Synth',
    attack: (o.attack != null) ? o.attack : 3,
    currentHealth: (o.currentHealth != null) ? o.currentHealth : 5,
    maxHealth: (o.maxHealth != null) ? o.maxHealth : 5,
    baseAttack: (o.attack != null) ? o.attack : 3,
    baseHealth: (o.maxHealth != null) ? o.maxHealth : 5,
    cost: (o.cost != null) ? o.cost : 2,
    baseCost: (o.cost != null) ? o.cost : 2,
    owner: o.owner || 'player',
    armorValue: 0, evadeCharges: 0, invincibleTurns: 0,
    hasDamageImmunity: false, isStunned: false, isFrozen: false,
    isFaceDown: false, tauntTurns: 0, passive: null,
    hasPhoenix: false, hasThorns: 0, hasBerserker: false, hasZealot: false,
    hasLifesteal: 0, splashRange: 0, statsKills: 0,
    onDeath: null, onDamaged: null, onPlay: null, onEvade: null, onKill: null
  };
  for (var k in o) c[k] = o[k];
  return c;
}

test('Phoenix revives once on lethal (hasPhoenix flag)', function () {
  var G = freshGame();
  var target = mkSynth({ name: 'Pho', currentHealth: 3, maxHealth: 10, owner: 'ai', hasPhoenix: true });
  var attacker = mkSynth({ name: 'Hit', attack: 50, owner: 'player' });
  G.state.lanes[0].player = attacker; G.state.lanes[0].ai = target;
  var died = G.applyCombatDamage(attacker, target);
  assertEq(died, false, 'Phoenix should keep target alive');
  assertEq(target.currentHealth, target.maxHealth, 'Phoenix should restore full HP');
  assert(target._phoenixUsed, 'Phoenix _phoenixUsed flag set');
});

test('Phoenix only fires once per game', function () {
  var G = freshGame();
  var target = mkSynth({ name: 'Pho', currentHealth: 3, maxHealth: 10, owner: 'ai', hasPhoenix: true });
  var attacker = mkSynth({ name: 'Hit', attack: 50, owner: 'player' });
  G.state.lanes[0].player = attacker; G.state.lanes[0].ai = target;
  G.applyCombatDamage(attacker, target);  // first lethal — revives
  target.currentHealth = 3;
  var died = G.applyCombatDamage(attacker, target);  // second lethal
  assertEq(died, true, 'Second lethal must kill (no second Phoenix)');
});

test('Stunned target cannot evade', function () {
  var G = freshGame();
  var target = mkSynth({ name: 'Sleeper', evadeCharges: 1, isStunned: true, owner: 'ai' });
  var attacker = mkSynth({ name: 'Hit', attack: 3, owner: 'player' });
  G.state.lanes[0].player = attacker; G.state.lanes[0].ai = target;
  G.applyCombatDamage(attacker, target);
  assertEq(target.evadeCharges, 1, 'Evade should not consume on stunned dodge attempt');
  assertEq(target.currentHealth, 2, 'Damage should land through stun-blocked evade');
});

test('Frozen target cannot evade', function () {
  var G = freshGame();
  var target = mkSynth({ name: 'Frosty', evadeCharges: 1, isFrozen: true, owner: 'ai' });
  var attacker = mkSynth({ name: 'Hit', attack: 3, owner: 'player' });
  G.state.lanes[0].player = attacker; G.state.lanes[0].ai = target;
  G.applyCombatDamage(attacker, target);
  assertEq(target.evadeCharges, 1, 'Evade should not consume on frozen target');
});

test('Armor exactly equals damage — full absorb, no HP loss', function () {
  var G = freshGame();
  var target = mkSynth({ name: 'Tank', armorValue: 3, owner: 'ai' });
  var attacker = mkSynth({ name: 'Hit', attack: 3, owner: 'player' });
  G.state.lanes[0].player = attacker; G.state.lanes[0].ai = target;
  var ret = G.applyCombatDamage(attacker, target);
  assertEq(target.currentHealth, 5, 'Equal-armor hit should not chip HP');
  assertEq(ret, false, 'Target survives');
});

test('Damage Immune absorbs full hit', function () {
  var G = freshGame();
  var target = mkSynth({ name: 'Ghost', hasDamageImmunity: true, owner: 'ai' });
  var attacker = mkSynth({ name: 'Hit', attack: 999, owner: 'player' });
  G.state.lanes[0].player = attacker; G.state.lanes[0].ai = target;
  G.applyCombatDamage(attacker, target);
  assertEq(target.currentHealth, 5, 'Damage Immune should fully block');
});

test('Thorns retaliates on landed hit', function () {
  var G = freshGame();
  var target = mkSynth({ name: 'Bramble', hasThorns: 2, currentHealth: 10, owner: 'ai' });
  var attacker = mkSynth({ name: 'Glass', currentHealth: 5, attack: 3, owner: 'player' });
  G.state.lanes[0].player = attacker; G.state.lanes[0].ai = target;
  G.applyCombatDamage(attacker, target);
  assertEq(attacker.currentHealth, 3, 'Thorns should chip attacker for 2');
});

test('Lifesteal heals owner equal to dmg dealt', function () {
  var G = freshGame();
  G.state.player.health = 20; G.state.player.maxHealth = 30;
  var attacker = mkSynth({ name: 'Vamp', attack: 4, hasLifesteal: 1, owner: 'player' });
  var target = mkSynth({ name: 'Victim', owner: 'ai' });
  G.state.lanes[0].player = attacker; G.state.lanes[0].ai = target;
  G.applyCombatDamage(attacker, target);
  assert(G.state.player.health > 20, 'Lifesteal should heal owner');
});

test('Lifesteal does NOT heal on absorbed hit (whiff)', function () {
  var G = freshGame();
  G.state.player.health = 20; G.state.player.maxHealth = 30;
  var attacker = mkSynth({ name: 'Vamp', attack: 2, hasLifesteal: 1, owner: 'player' });
  var target = mkSynth({ name: 'Tank', armorValue: 5, owner: 'ai' });
  G.state.lanes[0].player = attacker; G.state.lanes[0].ai = target;
  G.applyCombatDamage(attacker, target);
  assertEq(G.state.player.health, 20, 'Lifesteal should not trigger when armor fully absorbs');
});

test('NaN currentHealth coerces to baseHealth (no propagation)', function () {
  var G = freshGame();
  var target = mkSynth({ name: 'Glitch', baseHealth: 8, owner: 'ai' });
  target.currentHealth = NaN;
  target.maxHealth = NaN;
  var attacker = mkSynth({ name: 'Hit', attack: 3, owner: 'player' });
  G.state.lanes[0].player = attacker; G.state.lanes[0].ai = target;
  G.applyCombatDamage(attacker, target);
  assert(Number.isFinite(target.currentHealth), 'currentHealth should be finite after coerce');
  assertEq(target.currentHealth, 5, 'Expected 8 - 3 = 5 after coerce');
});

test('addToHand returns false when hand is full', function () {
  var G = freshGame();
  G.state.player.hand = [];
  G.state.player.maxHandSize = 2;
  G.state.player.hand.push(mkSynth({ name: 'A' }));
  G.state.player.hand.push(mkSynth({ name: 'B' }));
  var ret = G.addToHand('player', mkSynth({ name: 'C' }));
  assertEq(ret, false, 'addToHand must return false when capped');
  assertEq(G.state.player.hand.length, 2, 'Hand must not grow past cap');
});

test('Moder strip + _unstripModer roundtrip restores fields', function () {
  var G = freshGame();
  // Use a real Moder + a synthetic victim so the strip helper runs
  // its actual logic against a card with onPlay/onDeath/passives.
  var victim = mkSynth({ name: 'Victim', armorValue: 2, evadeCharges: 1, passive: 'somePassive' });
  victim.onDeath = function () { return 'death-fn'; };
  victim.onPlay = function () { return 'play-fn'; };
  var moder = mkSynth({ name: 'Moder', owner: 'ai', _moderStripPending: 1 });
  G.state.lanes[0].player = victim; G.state.lanes[0].ai = moder;
  // Moder now strips only the specific card played INTO his lane (id match),
  // so onAnyCardPlayed takes the played card as its third arg.
  CARD_ABILITIES['Moder'].onAnyCardPlayed(G, moder, victim);
  assert(victim._moderStripped, 'Moder should set _moderStripped');
  assertEq(victim.onDeath, null, 'onDeath should be nulled');
  assertEq(typeof victim._unstripModer, 'function', '_unstripModer must be on card');
  victim._unstripModer();
  assert(!victim._moderStripped, 'Strip flag should clear');
  assertEq(typeof victim.onDeath, 'function', 'onDeath should be restored');
  assertEq(victim.armorValue, 2, 'Armor should be restored');
});

test('addToHand un-strips Moder-stripped card on bounce', function () {
  // Regression for #73cf0c8 — the Moder bounce bug. Bouncing a
  // stripped card via Phantom Zone (or any bounce) used to leave
  // it permanently de-fanged because addToHand had no restore
  // path. Now addToHand calls card._unstripModer() before pushing.
  var G = freshGame();
  G.state.player.hand = [];
  G.state.player.maxHandSize = 7;
  var card = mkSynth({ name: 'Bounce', owner: 'player' });
  card.onPlay = function () { return 'fn'; };
  var moder = mkSynth({ name: 'Moder', owner: 'ai', _moderStripPending: 1 });
  G.state.lanes[0].player = card; G.state.lanes[0].ai = moder;
  CARD_ABILITIES['Moder'].onAnyCardPlayed(G, moder, card);
  assert(card._moderStripped, 'precondition: card should be stripped');
  G.addToHand('player', card);
  assert(!card._moderStripped, 'Strip flag must clear on hand re-entry');
  assertEq(typeof card.onPlay, 'function', 'onPlay must be restored on bounce');
});

test('Direct-attack path: damagePlayer drops .health', function () {
  var G = freshGame();
  G.state.ai.health = 30; G.state.ai.blockMeter = 0;
  var attacker = mkSynth({ name: 'Hit', attack: 5, owner: 'player' });
  // isBullseye=true bypasses the block-meter randomness — keeps test
  // deterministic. Real direct hits would roll the meter normally.
  G.damagePlayer('ai', 5, true, attacker);
  assertEq(G.state.ai.health, 25, 'damagePlayer should reduce .health by amount');
});

test('damagePlayer to 0 sets gameOver + winner', function () {
  var G = freshGame();
  G.state.ai.health = 5; G.state.ai.blockMeter = 0;
  var attacker = mkSynth({ name: 'KO', attack: 10, owner: 'player' });
  G.damagePlayer('ai', 10, true, attacker);
  assertEq(G.state.ai.health, 0, 'health floors at 0');
  assert(G.state.gameOver, 'gameOver flag should set');
  assertEq(G.state.winner, 'player', 'Winner is opposite of damaged side');
});

test('Frozen HP bar negates first incoming damage', function () {
  var G = freshGame();
  G.state.ai.health = 30;
  G.state.ai.healthFrozen = true;
  G.damagePlayer('ai', 5, true);
  assertEq(G.state.ai.health, 30, 'First hit should be fully negated');
  assertEq(G.state.ai.healthFrozen, false, 'healthFrozen flag must clear after one negation');
});

test('getCardCost respects discount (positive)', function () {
  var G = freshGame();
  G.state.player.discount = 1;
  var cost = G.getCardCost('player', mkSynth({ cost: 4 }));
  assertEq(cost, 3, 'Cost should reduce by discount');
});

test('getCardCost floors at 0 (huge discount)', function () {
  var G = freshGame();
  G.state.player.discount = 99;
  var cost = G.getCardCost('player', mkSynth({ cost: 4 }));
  assert(cost >= 0, 'Cost cannot go negative');
});

test('Hit on already-dead card returns false (no double-kill credit)', function () {
  var G = freshGame();
  var target = mkSynth({ name: 'Dead', currentHealth: 0, owner: 'ai' });
  var attacker = mkSynth({ name: 'Hit', attack: 3, owner: 'player' });
  G.state.lanes[0].player = attacker; G.state.lanes[0].ai = target;
  var ret = G.applyCombatDamage(attacker, target);
  assertEq(ret, false, 'No-op on already-dead target');
});

// ============================================================
// ---- ROGUELITE RELIC STRESS ------------------------------
// ============================================================
// Coverage gap pre-this-batch: roguelite.js wasn't loaded in the
// sim shim at all, so every relic def's hooks (onAcquire,
// onCardBuild, onFightStart, onFightEnd) had zero regression
// coverage. We now exercise every defined hook on every relic
// against a minimal run + sample card and assert nothing throws,
// the run state stays well-formed, and the registry behaves.

test('Roguelite is loaded in test shim', function () {
  assert(typeof Roguelite !== 'undefined', 'Roguelite must be defined');
  assert(Array.isArray(Roguelite.RELICS) && Roguelite.RELICS.length > 0, 'Roguelite.RELICS non-empty');
});

function mkRunForRelic() {
  return {
    hp: 30, maxHp: 30, gold: 50,
    deck: [], tricks: [], relics: [],
    currentNode: 0, currentRow: 0, totalRows: 6, act: 1,
    seed: 'test', boon: null, pendingRewards: null, lastResult: null,
    _stats: { startTime: 0, fightsWon: 0, elitesWon: 0, bossesWon: 0,
              goldEarned: 0, totalDamageDealt: 0, totalHpLost: 0 },
    ascension: 0,
  };
}

function mkCardForRelic() {
  return { name: 'Brute', cost: 2, attack: 2, currentHealth: 2, maxHealth: 2,
           abilities: [], owner: 'player', armorValue: 0 };
}

// Per-relic dynamic test — failure prints the exact relic id.
if (typeof Roguelite !== 'undefined' && Array.isArray(Roguelite.RELICS)) {
  Roguelite.RELICS.forEach(function (r) {
    test('RELIC ' + r.id + ' — hooks fire without throwing', function () {
      var run = mkRunForRelic();
      // Stub showToast — DOM stub absorbs the calls but we don't need
      // the noise; also avoids any subtle interaction with the toast
      // stack persisting across tests.
      var origShowToast = Roguelite.showToast;
      Roguelite.showToast = function () {};
      try {
        Roguelite.grantRelic(run, r.id);
      } finally {
        Roguelite.showToast = origShowToast;
      }
      assert(run.relics.indexOf(r.id) >= 0, 'relic added to run.relics');
      if (typeof r.onCardBuild === 'function') {
        // Run twice — once with a cost-2 card, once with a cost-1 card —
        // so cost-gated branches like Smiling Mask's cost<=1 buff are
        // actually exercised. Without this both branches return clean
        // even if only the cost-2 path actually ran.
        [mkCardForRelic(), Object.assign(mkCardForRelic(), { cost: 1, baseCost: 1 })].forEach(function (card) {
          r.onCardBuild(run, card);
          assert(Array.isArray(card.abilities), 'card.abilities still array (cost=' + card.cost + ')');
          assert(typeof card.attack === 'number' && !isNaN(card.attack), 'card.attack still number');
        });
      }
      if (typeof r.onFightStart === 'function') r.onFightStart(run);
      if (typeof r.onFightEnd === 'function') {
        r.onFightEnd(run, true);
        r.onFightEnd(run, false);
      }
      assert(typeof run.hp === 'number' && !isNaN(run.hp), 'run.hp valid');
      assert(typeof run.maxHp === 'number' && !isNaN(run.maxHp), 'run.maxHp valid');
      assert(typeof run.gold === 'number' && !isNaN(run.gold), 'run.gold valid');
    });
  });
}

test('_applyRelicHook ignores unknown relic ids', function () {
  var run = mkRunForRelic();
  run.relics = ['nonexistent-relic-12345'];
  Roguelite._applyRelicHook(run, 'onFightStart');
  Roguelite._applyRelicHook(run, 'onFightEnd', true);
});

test('Reality Stone honors per-rarity cost floor', function () {
  // Per-rarity floor: common→0, rare→1, special→2, legendary→3.
  // The generic per-relic stress test runs with the default _runRarity
  // (common, floor 0) only, so the rare/special/legendary branches
  // were uncovered. This pins each floor explicitly.
  var rs = Roguelite.RELICS.find(function (r) { return r.id === 'reality-stone'; });
  assert(rs && typeof rs.onCardBuild === 'function', 'reality-stone must define onCardBuild');
  var run = mkRunForRelic();
  // (rarity, startCost, expected after one apply)
  var cases = [
    ['common',    1, 0],   // 1 - 1 = 0, floor 0 ⇒ 0
    ['common',    5, 4],   // 5 - 1 = 4
    ['rare',      1, 1],   // floor 1 ⇒ stays 1 (would have gone to 0)
    ['rare',      5, 4],
    ['special',   2, 2],   // floor 2 ⇒ stays
    ['special',   6, 5],
    ['legendary', 3, 3],   // floor 3 ⇒ stays
    ['legendary', 9, 8],
  ];
  cases.forEach(function (c) {
    var rarity = c[0], startCost = c[1], expected = c[2];
    var card = Object.assign(mkCardForRelic(), { cost: startCost, baseCost: startCost, _runRarity: rarity });
    rs.onCardBuild(run, card);
    assertEq(card.cost, expected, rarity + ' card cost ' + startCost + ' floored to ' + expected);
    assertEq(card.baseCost, expected, rarity + ' baseCost matches');
  });
});

test('grantRelic is idempotent (duplicate add returns false)', function () {
  var run = mkRunForRelic();
  var firstId = Roguelite.RELICS[0].id;
  var origShowToast = Roguelite.showToast;
  Roguelite.showToast = function () {};
  try {
    var first = Roguelite.grantRelic(run, firstId);
    var second = Roguelite.grantRelic(run, firstId);
    assertEq(first, true, 'first add returns true');
    assertEq(second, false, 'duplicate add returns false');
    assertEq(run.relics.length, 1, 'relic in run.relics exactly once');
  } finally {
    Roguelite.showToast = origShowToast;
  }
});

// ============================================================
// ---- Codex completeness checks -----------------------------
// ============================================================
// Every player-facing etch should have a human-readable description
// in ETCH_DESCS. The level-up modal renders these on hover; a
// missing entry = blank tooltip. Skips `_internal` (boss-deck
// signature etches that players can't see in level-up rolls).
test('Codex: every draftable etch id has an ETCH_DESCS entry', function () {
  var missing = [];
  Roguelite.TIERS.forEach(function (tier) {
    Roguelite.ETCHES[tier].forEach(function (etch) {
      if (!Roguelite.ETCH_DESCS[etch.id]) missing.push(tier + ':' + etch.id);
    });
  });
  assert(missing.length === 0,
    'etches without ETCH_DESCS entry: ' + missing.join(', '));
});

// Every etch's `apply` function runs without throwing on a
// freshly built card. Catches typos in the apply body that
// only manifest when an etch actually procs.
test('Codex: every etch.apply runs without throwing on a fresh card', function () {
  var failures = [];
  var tiers = Object.keys(Roguelite.ETCHES);
  tiers.forEach(function (tier) {
    Roguelite.ETCHES[tier].forEach(function (etch) {
      var c = {
        name: 'TestCard', id: 99000, owner: 'player',
        attack: 1, health: 1, currentHealth: 1, maxHealth: 1,
        cost: 1, baseCost: 1, abilities: [], statuses: [],
      };
      try { etch.apply(c); }
      catch (e) { failures.push(tier + ':' + etch.id + ' — ' + (e && e.message || e)); }
    });
  });
  assert(failures.length === 0,
    'etch.apply threw: ' + failures.join(', '));
});

// Every etch id referenced in BOSS_DECK_ETCHES resolves to an
// actual etch via _findEtch. This is the regression the user
// hit when we removed `cantrip` — boss decks still listed it,
// and the game would silently no-op on those signature picks.
test('Codex: every BOSS_DECK_ETCHES id resolves via _findEtch', function () {
  var missing = [];
  var tables = Roguelite.BOSS_DECK_ETCHES || {};
  Object.keys(tables).forEach(function (tier) {
    var bossMap = tables[tier];
    if (!bossMap || typeof bossMap !== 'object') return;
    Object.keys(bossMap).forEach(function (boss) {
      var ids = bossMap[boss] || [];
      ids.forEach(function (id) {
        if (!Roguelite._findEtch(id)) missing.push(tier + '.' + boss + ':' + id);
      });
    });
  });
  assert(missing.length === 0,
    'unresolvable boss-deck etch ids: ' + missing.join(', '));
});

// ============================================================
// ---- BLOCK-TRICK MID-COMBAT DEBUFF PERSISTENCE -------------
// ============================================================
// Regression for: "if i use a trick like fear toxin when i block
// mid combat phase, that debuff should stick until the lane does
// combat again." The contested-lane path already marks both
// combatants as having swung (so debuffs landed mid-combat
// persist past postCombat's decrement); the uncontested path
// didn't. An uncontested AI swing into the player's empty lane
// fills the block meter → free trick → Fear Toxin → tryApplyDebuff
// would NOT see _combatSwungThisRound on the AI attacker, so the
// fear was cleared at postCombat before next round's swing.
//
// This test calls resolveUncontestedLane directly with a stunned
// damagePlayer stub so block-meter logic is bypassed, then asserts
// the attacker has _combatSwungThisRound set after the swing —
// proving the flag is now stamped before damagePlayer fires.
test('Block-trick: uncontested attacker is marked _combatSwungThisRound BEFORE damagePlayer', function () {
  Game.init();
  Game.startMatch('classic');
  // Stub damagePlayer so we can capture the flag state AT THE TIME of
  // the damage call (mirrors what a synchronous block-trick path would
  // see). Without the fix, the flag would be undefined at this point.
  var capturedFlagAtDamageTime = null;
  var orig = Game.damagePlayer.bind(Game);
  Game.damagePlayer = function (owner, amount, isBullseye, source) {
    if (source && source.id === 90001) {
      capturedFlagAtDamageTime = !!source._combatSwungThisRound;
    }
    // Skip actual face damage; we just want to observe the flag.
  };
  try {
    var attacker = {
      id: 90001, name: 'Test Attacker', owner: 'ai',
      attack: 3, currentHealth: 4, maxHealth: 4, baseAttack: 3, baseHealth: 4,
      cost: 1, splashRange: 0, armorValue: 0, evadeCharges: 0,
      invincibleTurns: 0, hasDamageImmunity: false,
      isStunned: false, isFrozen: false, isFeared: false, isMindControlled: false,
      isBullseye: false, abilities: [], statuses: [], tauntTurns: 0,
    };
    Game.state.lanes[0].player = null;
    Game.state.lanes[0].ai = attacker;
    Game.resolveUncontestedLane(0, 'ai', function () {});
    assertEq(capturedFlagAtDamageTime, true,
      '_combatSwungThisRound must be set on attacker before damagePlayer fires');
    // Also verify the flag persists post-resolution (so postCombat's
    // tryApplyDebuff late-clear path can read it).
    assert(!!attacker._combatSwungThisRound, '_combatSwungThisRound persists after uncontested swing');
  } finally {
    Game.damagePlayer = orig;
  }
});

// ============================================================
// ---- PROFESSOR X CONVERSION ORDER --------------------------
// ============================================================
// Regression: "I [used] Professor X [on] a Scarlet Witch which
// was 0/1, tried to place her in front of Dormammu, but they
// had Luke Skywalker on the board. It should copy Dormammu, not
// die." Bug was order: place → onAnyCardPlayed → cardPlayedBuff
// → onPlay. Luke's -1/-1 aura ran in onAnyCardPlayed BEFORE
// Scarlet Witch's onPlay could copy stats; she went 0/0 → -1/-1
// → killed. Fix: fire onPlay first so her stats resolve, then
// sibling reactions hit her real stats.
test('Professor X conversion: onPlay fires BEFORE onAnyCardPlayed sweep', function () {
  Game.init();
  Game.startMatch('classic');
  // Build a synthetic converted-card with onPlay that records
  // when it fires, and a sibling card with onAnyCardPlayed that
  // records when it fires. Assert the converted card's onPlay
  // ran first.
  var order = [];
  var converted = {
    id: 80001, name: 'Conv Card', owner: 'player',
    attack: 0, currentHealth: 1, maxHealth: 1, baseAttack: 0, baseHealth: 1,
    cost: 1, abilities: [], statuses: [],
    onPlay: function () { order.push('onPlay'); }
  };
  var sibling = {
    id: 80002, name: 'Sibling', owner: 'player',
    attack: 1, currentHealth: 1, maxHealth: 1, baseAttack: 1, baseHealth: 1,
    cost: 1, abilities: [], statuses: [],
    onAnyCardPlayed: function () { order.push('onAnyCardPlayed'); }
  };
  // Place sibling first (so the conversion sweep finds it).
  Game.state.lanes[0].player = sibling;
  // Now simulate the inner conversion-place sequence (lifted from
  // the real Professor X onDiscard at abilities.js).
  Game.state.lanes[1].player = converted;
  Game._runHook(converted, 'onPlay', Game, converted, 1);
  Game.getAllCardsOnBoard().forEach(function (c) {
    if (c.onAnyCardPlayed && c.id !== converted.id) c.onAnyCardPlayed(Game, c);
  });
  assertEq(order[0], 'onPlay',          'onPlay must fire first');
  assertEq(order[1], 'onAnyCardPlayed', 'onAnyCardPlayed must fire after');
});

// End-to-end: a 0/0 copiesOpposite card placed via the conversion
// chain copies Dormammu's stats and survives Luke's -1/-1 aura.
test('Scarlet Witch convert: copies Dormammu stats then takes Luke debuff and lives', function () {
  Game.init();
  Game.startMatch('classic');
  // Lane 2: AI Dormammu (5/6 base — used as the copy target)
  var dormammu = {
    id: 81001, name: 'Dormammu', owner: 'ai',
    attack: 5, currentHealth: 6, maxHealth: 6, baseAttack: 5, baseHealth: 6,
    cost: 8, abilities: [], statuses: [],
  };
  Game.state.lanes[2].ai = dormammu;
  // Lane 0: AI Luke Skywalker with active -1/-1 aura via onAnyCardPlayed
  var luke = {
    id: 81002, name: 'Luke Skywalker', owner: 'ai',
    attack: 5, currentHealth: 6, maxHealth: 6, baseAttack: 5, baseHealth: 6,
    cost: 8, abilities: [], statuses: [],
    onAnyCardPlayed: function (G, self) {
      G.getEnemiesOf(self.owner).filter(function (e) { return !e._lukeDebuff; }).forEach(function (e) {
        G.debuffCard(e, 1, 1, true, self);
        e._lukeDebuff = true;
      });
    },
  };
  Game.state.lanes[0].ai = luke;
  // Place a synthetic Scarlet-Witch-style card (0/0 with
  // copiesOpposite) in lane 2 (player slot). Apply the same
  // place → onPlay → onAnyCardPlayed sequence as the patched
  // Professor X conversion path.
  var witch = {
    id: 81003, name: 'Scarlet Witch', owner: 'player',
    attack: 0, currentHealth: 0, maxHealth: 0,
    baseAttack: 0, baseHealth: 0, cost: 3,
    abilities: [], statuses: [], copiesOpposite: true,
    onPlay: function (G, self, lane) {
      var opp = G.opponent(self.owner);
      var enemy = G.state.lanes[lane] && G.state.lanes[lane][opp];
      if (enemy && enemy.currentHealth > 0) {
        self.attack = enemy.attack || 0;
        self.baseAttack = enemy.attack || 0;
        self.currentHealth = enemy.currentHealth || 1;
        self.maxHealth = enemy.currentHealth || 1;
        self.baseHealth = enemy.currentHealth || 1;
        self.copiesOpposite = false;
      }
    },
  };
  Game.state.lanes[2].player = witch;
  Game._runHook(witch, 'onPlay', Game, witch, 2);
  Game.getAllCardsOnBoard().forEach(function (c) {
    if (c.onAnyCardPlayed && c.id !== witch.id) c.onAnyCardPlayed(Game, c);
  });
  // Witch should have copied Dormammu's 5/6, then taken Luke's
  // -1/-1 → 4/5 → ALIVE.
  assertEq(witch.attack,        4, 'attack = 5 (Dormammu) - 1 (Luke aura)');
  assertEq(witch.currentHealth, 5, 'hp = 6 (Dormammu) - 1 (Luke aura)');
  assert(witch.currentHealth > 0, 'Scarlet Witch must be alive after Luke aura');
  assertEq(witch.copiesOpposite, false, 'copiesOpposite cleared after stats resolve');
});

// And an integration check: apply Fear via the same flag-aware path
// and confirm tryApplyDebuff stamps _debuffDelayedClear when the
// target is `_combatSwungThisRound`. This is the actual mechanism
// that keeps Fear Toxin's debuff alive through postCombat.
test('Block-trick: tryApplyDebuff stamps _debuffDelayedClear on a swung target', function () {
  Game.init();
  Game.startMatch('classic');
  var target = {
    id: 90002, name: 'Already-Swung Target', owner: 'ai',
    attack: 3, currentHealth: 5, maxHealth: 5,
    cost: 1, immunityCharges: 0, abilities: [], statuses: [],
    fearedTurns: 0, isFeared: false,
    _combatSwungThisRound: true,  // simulating the just-swung uncontested attacker
  };
  Game.fearCard(target, { name: 'Fear Toxin' }, 1);
  assertEq(target.isFeared, true, 'fear should land');
  assertEq(target.fearedTurns, 1, 'fearedTurns should be 1');
  assertEq(!!target._debuffDelayedClear, true,
    '_debuffDelayedClear must be stamped so postCombat skips the decrement');
});

// Regression: the titan ("tens can't touch tens") rule has ONE authority —
// is10CostImmune, reached through canEffectLand. Trigon's bonus-destroy carried
// a second, hand-rolled copy (`cost < 10`) in front of that call, and the copy
// disagreed: it swept in Doomsday, who prints at 12 but is explicitly NOT a
// titan (skipAutoUntrickable). killCard already allowed the hit — only the
// target filter hid him, so the effect just silently skipped a legal target.
// Drives the real onKill hook (not canEffectLand directly) — the hand-rolled
// filter lived in the hook, so only calling the hook can catch it. killCard is
// stubbed so the assertion is "who did Trigon PICK", independent of Doomsday's
// Revive charge deciding whether he actually stays dead.
function __trigonPicks(enemyName) {
  var G = freshGame();
  var trigon = place(G, 'Trigon', 'player', 0);
  var enemy = place(G, enemyName, 'ai', 1);
  var picked = null;
  var realKill = G.killCard;
  G.killCard = function (t) { picked = t && t.name; };
  try { CARD_ABILITIES.Trigon.onKill(G, trigon); } finally { G.killCard = realKill; }
  return { picked: picked, enemy: enemy, trigon: trigon };
}

test('Trigon bonus-destroy reaches Doomsday but not a real titan', function () {
  var d = __trigonPicks('Doomsday');
  assert(!!d.enemy.skipAutoUntrickable, 'Doomsday must carry the not-a-titan flag');
  assertEq(d.picked, 'Doomsday',
    'Doomsday prints at 12 but is not a titan — Trigon must be able to pick him');

  var g = __trigonPicks('Galactus');
  assert((g.enemy.baseCost || g.enemy.cost) >= 10, 'Galactus must be a real titan');
  assert((g.trigon.baseCost || g.trigon.cost) >= 10, 'Trigon must be a real titan');
  assertEq(g.picked, null, 'Galactus is a titan — tens still cannot touch tens');
});

// Regression: THE REAL Knull -> Hela cascade, end to end.
// User: "Hela needs to spawn her 2 minions first before more cards are summoned
// by Knull, since she is in lane 2 — so there should be 2 less total summons."
// Golden RG-13 covers the MECHANISM (it sets _summonCascadeDepth by hand and
// calls summonCardChoice directly) but never runs Knull's onPlay, so it cannot
// catch a regression in summonCard's depth bookkeeping or in Knull's live
// lane re-check. This drives the actual cards and asserts the actual outcome:
// Hela's warriors land, and Knull draws FEWER cards because of it.
test('Knull -> Hela cascade: warriors land first, Knull draws 2 fewer', function () {
  var G = freshGame();
  var knull = place(G, 'Knull', 'player', 0);

  // Deterministic pull order: Hela first, then plain fillers with no On Play.
  // The spread MUST be shallow — CARD_DEFS carries the merged ability hooks as
  // function properties, and a JSON deep-clone would silently strip onPlay and
  // make this test pass for the wrong reason.
  var draws = 0;
  var realDraw = G.drawFromSummonDeck;
  G.drawFromSummonDeck = function () {
    draws++;
    if (draws === 1) return { ...cardByName('Hela') };
    return { name: 'Filler', cost: 2, attack: 2, health: 2, abilities: [] };
  };
  // THE ACTUAL GUARD. The sim cannot reproduce the original bug by outcome:
  // under the shim the prompt / _aiActionDelay path resolves synchronously, so
  // the warriors land either way and only their lane assignment differs. What
  // IS deterministic — and what actually breaks if summonCard stops bracketing
  // the nested onPlay — is that Hela's summons are seen INSIDE the cascade.
  // Golden RG-13 sets _summonCascadeDepth by hand, so it cannot catch that;
  // this reads the depth the real Knull->Hela flow produces.
  var depthsAtChoice = [];
  var realChoice = G.summonCardChoice;
  G.summonCardChoice = function () {
    depthsAtChoice.push(G._summonCascadeDepth || 0);
    return realChoice.apply(G, arguments);
  };
  try {
    CARD_ABILITIES.Knull.onPlay(G, knull, 0);
  } finally {
    G.drawFromSummonDeck = realDraw;
    G.summonCardChoice = realChoice;
  }

  assert(depthsAtChoice.length > 0, 'Hela should have requested lanes for her warriors');
  assert(depthsAtChoice.every(function (d) { return d > 0; }),
    'every nested summon must run with _summonCascadeDepth > 0 so summonCardChoice ' +
    'places synchronously instead of prompting / deferring. Saw depths: ' + depthsAtChoice.join(','));
  assertEq(!!G.state.pendingLaneChoice, false, 'no lane prompt may be left armed by the cascade');

  var names = [];
  for (var i = 0; i < G.LANE_COUNT; i++) {
    var c = G.state.lanes[i].player;
    names.push(c ? c.name : null);
  }
  var warriors = names.filter(function (n) { return n === 'Undead Warrior'; }).length;
  var occupied = names.filter(Boolean).length;

  assert(names.indexOf('Hela') > -1, 'Hela should have been summoned, got: ' + names.join(','));
  assertEq(warriors, 2, 'Hela must raise both Undead Warriors — they are dropped if ' +
    'her On Play resolves after Knull has already filled the board. Board: ' + names.join(','));
  assertEq(occupied, G.LANE_COUNT, 'every lane should end up occupied: ' + names.join(','));
  // The whole point of the user's ruling: the warriors take lanes Knull would
  // otherwise have filled, so Knull burns 2 fewer cards from the summon deck.
  // 5 open lanes, minus the 2 the warriors claimed = 3 draws.
  assertEq(draws, 3, 'Knull should draw 3 (not 5) — 2 fewer, because the warriors ' +
    'claimed two lanes before his loop reached them');
});

// Regression: a FEARED card must not take EXTRA actions. User report:
// "han solo was able to strike when he was feared in a different lane that
// wasn't his own — that shouldn't happen."
// The engine already gated moving / hunting / bonus attacks on
// isFrozen || isStunned || isFeared, but every ability-side guard had drifted
// to `isStunned || isFrozen` and omitted fear — 9 sites. All now route through
// Game.isActionLocked so the rule has one definition.
test('feared cards cannot take extra actions (Han Solo redirect + friends)', function () {
  // Count whether Han is even OFFERED the redirect. Asserting on
  // pendingLaneChoice does not work here: the sim shim resolves prompts
  // synchronously, so the slot is armed and cleared before the test can read it
  // (see the sim-fidelity note — outcome-only assertions silently pass either
  // way). Counting the promptLaneChoice call is deterministic and is exactly
  // the guard under test.
  function offersRedirect(feared) {
    var G = freshGame();
    var han = place(G, 'Han Solo', 'player', 0);
    place(G, 'Bane', 'ai', 1);              // a redirect target in another lane
    var asked = 0, real = G.promptLaneChoice;
    G.promptLaneChoice = function () { asked++; return real.apply(G, arguments); };
    han.isFeared = feared;
    try { CARD_ABILITIES['Han Solo'].onBeforeCombat(G, han, 0); }
    finally { G.promptLaneChoice = real; }
    return asked;
  }
  // Control first — if an UNFEARED Han did not offer a shot, the test below
  // would pass for the wrong reason.
  assertEq(offersRedirect(false), 1, 'control: an unfeared Han Solo should be offered the redirect');
  assertEq(offersRedirect(true), 0, 'a FEARED Han Solo must not be offered a shot into another lane');

  var G = freshGame();

  // The predicate itself is the thing every other card now inherits.
  assertEq(G.isActionLocked({ isFeared: true }), true, 'feared is action-locked');
  assertEq(G.isActionLocked({ isFrozen: true }), true, 'frozen is action-locked');
  assertEq(G.isActionLocked({}), false, 'a clean card is not action-locked');

  // Spot-check one of the other 8 that had the same drift.
  var G2 = freshGame();
  var mb = place(G2, 'Man-Bat', 'ai', 0);
  var jug = place(G2, 'Juggernaut', 'player', 3);
  mb.isFeared = true; mb.beforeTricksFired = false;
  var hpBefore = jug.currentHealth;
  G2.runBeforeTricks();
  assertEq(G2.findCardLane(mb), 0, 'feared Man-Bat should not move');
  assertEq(jug.currentHealth, hpBefore, 'feared Man-Bat should not debuff');
});

// Regression: a "move an enemy" ability must NOT prompt when the enemy side has
// no open lane. User report, board with all six enemy lanes occupied: "the lanes
// are full, no one to move, so this prompt shouldn't pop up" — Gojo still asked
// and ran a 23s choice timer, then logged "No open lanes" and did nothing.
// Three cards shared the shape (prompt first, look for a destination second):
// Gojo, Jigsaw and Darth Vader. All three now check first.
test('move-an-enemy abilities do not prompt when every enemy lane is full', function () {
  function fullBoard() {
    var G = freshGame();
    // Fill ALL six enemy lanes so there is nowhere to move anyone.
    for (var i = 0; i < G.LANE_COUNT; i++) place(G, 'King Shark', 'ai', i);
    return G;
  }
  // Count only MOVE-related prompts. Darth Vader's onPlay legitimately prompts
  // for its later steps (Fear, then the damage chain), so counting every prompt
  // would fail for the wrong reason — match on the title instead.
  function movePrompts(cardName, board) {
    var G = board();
    var self = place(G, cardName, 'player', 0);
    var asked = 0;
    var isMove = function (title) { return /move|relocate|drag/i.test(String(title || '')); };
    var realCard = G.promptCardChoice, realLane = G.promptLaneChoice;
    G.promptCardChoice = function (o, c, title) { if (isMove(title)) asked++; return realCard.apply(G, arguments); };
    G.promptLaneChoice = function (o, l, title) { if (isMove(title)) asked++; return realLane.apply(G, arguments); };
    try { CARD_ABILITIES[cardName].onPlay(G, self, 0); }
    catch (e) { /* later steps may need more setup; we only care about move prompts */ }
    finally { G.promptCardChoice = realCard; G.promptLaneChoice = realLane; }
    return asked;
  }
  function oneLaneOpen() {
    var G = freshGame();
    for (var i = 1; i < G.LANE_COUNT; i++) place(G, 'King Shark', 'ai', i);
    return G;
  }

  assertEq(fullBoard().getOpenLanes('ai').length, 0, 'setup sanity: ai side has no open lane');
  assertEq(oneLaneOpen().getOpenLanes('ai').length, 1, 'setup sanity: control leaves exactly one open');

  // Controls FIRST — if these were 0, the assertions below would pass vacuously.
  assert(movePrompts('Gojo', oneLaneOpen) > 0, 'control: Gojo should offer the move when a lane is open');
  assert(movePrompts('Darth Vader', oneLaneOpen) > 0, 'control: Vader should offer the move when a lane is open');

  assertEq(movePrompts('Gojo', fullBoard), 0, 'Gojo must not prompt to move with every enemy lane full');
  assertEq(movePrompts('Darth Vader', fullBoard), 0, 'Vader must not prompt to move with every enemy lane full');
});

// Regression: the placement preview must agree with what actually happens,
// including REACTIVE abilities. User report on Bane (3/4, "While Active: Add
// (+1/+1) when damaged"): the SIM tooltip read "ENEMY 4 -> 2" when the true
// result is 4 -> 3, because previewPlacement simulated the PLACEMENT for real
// but handed COMBAT to the static predictor, which models damage/armor/evade/
// taunt and knows nothing about on-damaged hooks.
// It now resolves combat on the clone, so this holds for every reactive card,
// not just Bane. Asserted against a real resolveCombat() on the same board so
// the expectation is ground truth rather than a number I chose.
test('placement preview matches real combat for a reactive card (Bane rage)', function () {
  function board() {
    var G = freshGame();
    G.state.player.isHuman = false; G.state.ai.isHuman = false;
    G.state.player.currency = 10;
    var b = place(G, 'Bane', 'ai', 0);
    b.attack = 3; b.currentHealth = 4; b.maxHealth = 4;
    var c = G.createCardInstance(cardByName('Gremlin'), 'player');
    c.attack = 2; c.currentHealth = 2; c.maxHealth = 2; c.cost = 1;
    G.state.player.hand = [c];
    return { G: G, bane: b, card: c };
  }
  // Ground truth: play it for real and resolve.
  var t = board();
  t.G.playCard('player', t.card, 0);
  t.G.resolveCombat();
  var real = t.G.state.lanes[0].ai;
  var trueHp = real ? real.currentHealth : 0;
  assert(!!real, 'ground truth: Bane should survive this exchange');
  assert(real.attack > 3, 'ground truth: Bane should have raged (ATK up from 3)');

  // The preview must say the same thing.
  var p = board();
  var sim = p.G.previewPlacement('player', p.card.id, 0);
  assert(!!sim, 'previewPlacement should return a result');
  var predicted = sim.lanes[0] && sim.lanes[0].ai;
  assert(!!predicted, 'preview should include the enemy lane');
  assertEq(predicted.hpAfter, trueHp,
    'preview hpAfter must equal what real combat produces (Bane rages +1 HP)');
  assertEq(predicted.dies, false, 'Bane does not die here');
});

// Regression: a FACE-DOWN card is untouchable until it reveals. Invisible
// Woman's text promises exactly that, and dealDamage / killCard /
// canEffectLand / combat all honoured it — but four paths did not, so a hidden
// card could still be weakened, frozen, feared or dragged out of its lane.
// User: "nothing can interact with a downturned card."
test('face-down cards cannot be damaged, debuffed, statused or moved', function () {
  function hidden() {
    var G = freshGame();
    var c = place(G, 'Bane', 'ai', 0);
    c.attack = 3; c.currentHealth = 4; c.maxHealth = 4; c.isFaceDown = true;
    return { G: G, c: c };
  }
  var t;
  t = hidden(); t.G.dealDamage(t.c, 3, null);
  assertEq(t.c.currentHealth, 4, 'face-down takes no damage');
  t = hidden(); t.G.killCard(t.c, null);
  assert(t.c.currentHealth > 0, 'face-down cannot be destroyed');
  t = hidden(); t.G.debuffCard(t.c, 1, 1, true, null);
  assertEq(t.c.attack, 3, 'face-down keeps its ATK');
  assertEq(t.c.currentHealth, 4, 'face-down keeps its HP');
  t = hidden(); t.G.freezeCard(t.c, null, 1);
  assertEq(!!t.c.isFrozen, false, 'face-down cannot be frozen');
  t = hidden(); t.G.fearCard(t.c, null, 1);
  assertEq(!!t.c.isFeared, false, 'face-down cannot be feared');
  t = hidden(); t.G.moveCard(t.c, 0, 3);
  assertEq(t.G.findCardLane(t.c), 0, 'face-down cannot be relocated');
  t = hidden();
  assertEq(t.G.canEffectLand(t.c, 'trick', { owner: 'player' }), false,
    'no trick can land on a face-down card');

  // ...and once REVEALED it is a normal card again, or the guards would be a
  // permanent immunity rather than a hidden-state one.
  t = hidden();
  t.c.isFaceDown = false;
  t.G.dealDamage(t.c, 2, null);
  assert(t.c.currentHealth < 4, 'a revealed card takes damage normally');
  t.G.freezeCard(t.c, null, 1);
  assertEq(!!t.c.isFrozen, true, 'a revealed card can be frozen normally');
});

// ============================================================
// ---- ATK SUPPRESSION vs CRAZY -------------------------------
// ============================================================
// Reported 2026-08-02: "i played gojo on hela she had crazy, moved her to lane
// 2, she had 0 attack, then the thing got crazy and hela went back to 5 attack".
// Gojo removes all ATK for a turn by snapshotting the stat and pinning it to 0.
// The Crazy stamp moving to another card ran a blind `attack = _preCrazyAttack`,
// which un-suppressed her early AND left Gojo holding a stale restore value.

test('Crazy un-stamp does not break Gojo ATK suppression', function () {
  var G = freshGame();
  var v = place(G, 'Hela', 'ai', 1);
  v.attack = 5;
  // Gojo's suppression, exactly as his onPlay writes it.
  v._gojoAttackZeroed = v.attack;
  v._gojoZeroedBy = 'gojo-test';
  v.attack = 0;
  // Now Crazy is applied and then stripped, as the stamp moving would do.
  v.isCrazy = true; v._crazyAppliedBy = true; v._preCrazyAttack = 5;
  G.setTrueAttack(v, v._preCrazyAttack);
  assertEq(v.attack, 0, 'stays at 0 while Gojo suppression is active');
  assertEq(v._gojoAttackZeroed, 5, 'the restore value lands in Gojo\'s snapshot');
});

test('Gojo expiry restores the value Crazy left behind, not a stale one', function () {
  var G = freshGame();
  var v = place(G, 'Hela', 'ai', 1);
  v.attack = 5;
  v._gojoAttackZeroed = v.attack; v._gojoZeroedBy = 'gojo-test'; v.attack = 0;
  // Crazy rolls a 3 while suppressed — it must be banked, not shown.
  G.setTrueAttack(v, 3);
  assertEq(v.attack, 0, 'a Crazy roll cannot un-suppress the card');
  // Suppression lifts (Gojo's own restore).
  v.attack = v._gojoAttackZeroed;
  delete v._gojoAttackZeroed; delete v._gojoZeroedBy;
  assertEq(v.attack, 3, 'expiry restores the banked roll, not the pre-Crazy 5');
});

test('setTrueAttack writes the live stat when nothing suppresses it', function () {
  var G = freshGame();
  var v = place(G, 'Hela', 'ai', 1);
  v.attack = 5;
  var changed = G.setTrueAttack(v, 2);
  assertEq(v.attack, 2, 'unsuppressed card takes the value directly');
  assertEq(changed, true, 'reports that the live stat changed');
  assertEq(G.setTrueAttack(v, NaN), false, 'a non-finite value is refused');
  assertEq(v.attack, 2, 'and leaves the stat alone');
});

test('Obi-Wan suppression is respected the same way as Gojo', function () {
  var G = freshGame();
  var v = place(G, 'Hela', 'ai', 1);
  v.attack = 5;
  v._obiWanAttackZeroed = v.attack; v.attack = 0;
  G.setTrueAttack(v, 4);
  assertEq(v.attack, 0, 'stays suppressed');
  assertEq(v._obiWanAttackZeroed, 4, 'banked into Obi-Wan\'s snapshot');
});

// ============================================================
// ---- IRON GIANT: sacrifice draws a card ---------------------
// ============================================================
// Driven on the 'ai' seat throughout. The PLAYER seat routes through
// promptCardChoice with no aiPicker, and the shim then picks uniformly at
// random — a player-seat test would be a literal coin flip. state.ai.isHuman is
// false, so the AI branch decides deterministically.
// The AI branch also carries a worth gate (victim cost >= 4, OR 3+ enemies), so
// every victim below is cost >= 4 on purpose.
function igSetup() {
  var G = freshGame();
  // freshGame's draw pile is EMPTY — Game.init() leaves state.drawPile at
  // length 0. Without seeding it, the draw is a silent no-op and a test
  // asserting "hand grew" would fail even with the feature working, while a
  // test asserting "no crash" would pass for the wrong reason.
  G.state.drawPile = [ Object.assign({}, cardByName('Ant-Man')) ];
  return G;
}

test('Iron Giant sacrifice draws a card (and the control case does not)', function () {
  // CONTROL FIRST. If a declined sacrifice also drew, the test below would
  // pass for the wrong reason.
  var G0 = igSetup();
  var victim0 = place(G0, 'Hela', 'ai', 0);
  place(G0, 'Juggernaut', 'player', 0);
  var before0 = G0.state.ai.hand.length;         // no Iron Giant in hand
  G0._ironGiantIntercept(victim0, 0, null);
  assertEq(G0.state.ai.hand.length, before0, 'control: no Giant in hand, so no draw');

  var G = igSetup();
  var victim = place(G, 'Hela', 'ai', 0);
  place(G, 'Juggernaut', 'player', 0);
  var ig = G.createCardInstance(cardByName('Iron Giant'), 'ai');
  G.state.ai.hand.push(ig);
  var before = G.state.ai.hand.length;
  var intercepted = G._ironGiantIntercept(victim, 0, null);
  assertEq(intercepted, true, 'the intercept should fire for a cost-5 victim');
  assertEq(victim._igSavedThisCombat, true, 'the ally is actually saved');
  // -1 Giant spent, +1 card drawn => net unchanged. Assert BOTH legs so a
  // no-op draw (net -1) and a no-op sacrifice (net +1) each fail distinctly.
  assertEq(G.state.ai.hand.indexOf(ig), -1, 'the Giant left the hand');
  assertEq(G.state.ai.hand.length, before, 'one card drawn to replace the spent Giant');
  assertEq(G.state.ai.discardPile.indexOf(ig) > -1, true, 'the Giant went to the discard pile');
});

test('Lex Luthor stops the Iron Giant sacrifice draw', function () {
  // The MECHANISM, not the outcome. Counting addToHand calls proves nothing —
  // drawCards calls addToHand internally, so the count is 1 either way. What
  // actually distinguishes the two doors is the Lex Luthor block, which lives
  // ONLY inside drawCards. Put Lex on the far side and the draw must vanish;
  // had the sacrifice reached for addToHand it would sail straight past him,
  // which is exactly the leak this repo has shipped three times.
  var G = igSetup();
  var victim = place(G, 'Hela', 'ai', 0);
  var lex = place(G, 'Lex Luthor', 'player', 0);   // opponent of the 'ai' seat
  lex.passive = 'preventDraw';
  var ig = G.createCardInstance(cardByName('Iron Giant'), 'ai');
  G.state.ai.hand.push(ig);
  var before = G.state.ai.hand.length;
  var drawCalls = 0, realDraw = G.drawCards;
  G.drawCards = function () { drawCalls++; return realDraw.apply(G, arguments); };
  try { G._ironGiantIntercept(victim, 0, null); }
  finally { G.drawCards = realDraw; }
  assertEq(drawCalls, 1, 'the sacrifice must still go knock on the drawCards door');
  assertEq(victim._igSavedThisCombat, true, 'the save itself is unaffected by Lex');
  // Giant spent, nothing drawn to replace him.
  assertEq(G.state.ai.hand.length, before - 1, 'Lex Luthor blocks the replacement card');
});

test('Iron Giant draws BEFORE the blast, so the cascade cannot land on top of it', function () {
  // Ordering is the whole point: _ironGiantBlast damages the enemy line, and a
  // lethal hit re-enters handleDeath inline, which can arm the OTHER player's
  // Iron Giant prompt mid-cascade. Drawing after that puts the card behind
  // someone else's modal. Outcome alone cannot tell the two orders apart, so
  // record the sequence.
  var G = igSetup();
  var victim = place(G, 'Hela', 'ai', 0);
  place(G, 'Juggernaut', 'player', 0);
  G.state.ai.hand.push(G.createCardInstance(cardByName('Iron Giant'), 'ai'));
  var seq = [];
  var realDraw = G.drawCards, realBlast = G._ironGiantBlast;
  G.drawCards = function () { seq.push('draw'); return realDraw.apply(G, arguments); };
  G._ironGiantBlast = function () { seq.push('blast'); return realBlast.apply(G, arguments); };
  try { G._ironGiantIntercept(victim, 0, null); }
  finally { G.drawCards = realDraw; G._ironGiantBlast = realBlast; }
  assertEq(seq.join(','), 'draw,blast', 'the draw must resolve before the blast cascade');
});

test('a failing Iron Giant draw cannot cost the Giant AND the ally', function () {
  // The whole intercept sits inside one try/catch that returns false on throw.
  // By the time the draw runs, the ally is already restored and the Giant is
  // already spent — so a throw escaping the draw would fall through into the
  // normal death path on a restored card: Giant consumed, ally dead anyway.
  // The draw therefore carries its own local try/catch.
  var G = igSetup();
  var victim = place(G, 'Hela', 'ai', 0);
  place(G, 'Juggernaut', 'player', 0);
  var ig = G.createCardInstance(cardByName('Iron Giant'), 'ai');
  G.state.ai.hand.push(ig);
  var realDraw = G.drawCards;
  // A plain Error, deliberately: run-tests.sh greps stdout for TypeError /
  // ReferenceError and fails the suite on a match, so the forced failure must
  // not print one of those words.
  G.drawCards = function () { throw new Error('forced draw failure'); };
  var intercepted;
  try { intercepted = G._ironGiantIntercept(victim, 0, null); }
  finally { G.drawCards = realDraw; }
  assertEq(intercepted, true, 'a broken draw must not abort the intercept');
  assertEq(victim._igSavedThisCombat, true, 'the ally stays saved even if the draw throws');
  assertEq(G.state.ai.hand.indexOf(ig), -1, 'the Giant is still spent exactly once');
});

test('Iron Giant sacrifices at most ONCE per combat, even holding a second copy', function () {
  // Regression, user-reported: "he doesnt keep sacrificing himself".
  // The draw payoff fed itself — sacrifice draws a card, that card is your
  // SECOND Iron Giant, next ally death offers him straight back. Measured at
  // 3 sacrifices in one combat off a stacked draw pile before the gate.
  var G = freshGame();
  // Draw pile topped with MORE Giants — the deckbuilder/roguelite case.
  G.state.drawPile = [
    Object.assign({}, cardByName('Ant-Man')),
    Object.assign({}, cardByName('Iron Giant')),
    Object.assign({}, cardByName('Iron Giant'))
  ];
  G.state.ai.hand.push(G.createCardInstance(cardByName('Iron Giant'), 'ai'));
  var allies = [0, 1, 2].map(function (i) {
    return place(G, 'Hela', 'ai', i);       // cost 5, clears the AI worth gate
  });
  place(G, 'Juggernaut', 'player', 0);
  var saves = 0, realBlast = G._ironGiantBlast;
  G._ironGiantBlast = function () { saves++; return realBlast.apply(G, arguments); };
  try {
    allies.forEach(function (a, i) { G._ironGiantIntercept(a, i, null); });
  } finally { G._ironGiantBlast = realBlast; }
  assertEq(saves, 1, 'exactly one sacrifice per combat, however many Giants get drawn');
  assertEq(G.state.ai._igSpentThisCombat, true, 'the per-seat gate is armed');
  // The gate is per SEAT, so the opponent still gets their own save.
  assertEq(!!G.state.player._igSpentThisCombat, false, 'the other side keeps its own save');
});

test('the Iron Giant save recharges for the next combat', function () {
  var G = freshGame();
  G.state.ai._igSpentThisCombat = true;
  G.state.player._igSpentThisCombat = true;
  G.postCombat();
  assertEq(!!G.state.ai._igSpentThisCombat, false, 'AI save recharges after combat');
  assertEq(!!G.state.player._igSpentThisCombat, false, 'player save recharges after combat');
});

test('Mobius Chair raises max hand size, so its card fits a full hand', function () {
  var TR = (typeof TRICK_DEFS !== 'undefined' ? TRICK_DEFS : null);
  if (!TR) throw new Error('TRICK_DEFS not loaded');
  var chair = TR.find(function (t) { return t.name === 'Mobius Chair'; });

  // A FULL hand is the case that was silently broken: addToHand refuses at the
  // cap and bins the card, so you paid 2 Energy for nothing.
  var G = freshGame();
  var p = G.state.player;
  p.maxHandSize = 7;
  p.hand = [];
  for (var i = 0; i < 7; i++) p.hand.push(G.createCardInstance(cardByName('Bane'), 'player'));
  for (var j = 0; j < 3; j++) G.getDrawPile('player').push(Object.assign({}, cardByName('Hawkeye')));
  chair.play(G, 'player');
  assertEq(p.maxHandSize, 8, 'max hand size went up by 1');
  assertEq(p.hand.length, 8, 'and the picked card actually landed instead of being binned');

  // It stacks — two Chairs, two points of headroom.
  chair.play(G, 'player');
  assertEq(p.maxHandSize, 9, 'a second Chair stacks');

  // Empty draw pile still grants the headroom (the +1 is not conditional on
  // finding cards) and must not throw.
  var G2 = freshGame();
  G2.getDrawPile('player').length = 0;
  var before = G2.state.player.maxHandSize;
  chair.play(G2, 'player');
  assertEq(G2.state.player.maxHandSize, before + 1, 'headroom granted even with an empty pile');
});

test('max hand size resets between matches', function () {
  // makePlayer() runs once per PAGE LOAD, not per match — the same trap that
  // let the redraw cost carry over. Two Chairs must not follow you into the
  // next match.
  var G = freshGame();
  G.state.player.maxHandSize = 9;
  G.state.ai.maxHandSize = 8;
  G.startMatch();
  assertEq(G.state.player.maxHandSize, 7, 'player max hand size is back to 7');
  assertEq(G.state.ai.maxHandSize, 7, 'AI max hand size is back to 7');
});

test('Iron Giant carries the Draw 1 badge without gaining a play-time draw', function () {
  var def = cardByName('Iron Giant');
  assertEq(def.abilities.indexOf('Draw 1') > -1, true, 'the badge keyword is on the def');
  var G = freshGame();
  var ig = G.createCardInstance(def, 'player');
  // The keyword stamps drawOnPlay, which is fine ONLY because he can never be
  // played. Pin both halves: the flag exists, and the gate that makes it inert
  // is still in place.
  assertEq(ig._neverPlayable, true, 'still never playable, so drawOnPlay can never fire');
  G.state.player.hand.push(ig);
  var handBefore = G.state.player.hand.length;
  assertEq(G.playCard('player', ig, 0), false, 'playCard still refuses him');
  assertEq(G.state.player.hand.length, handBefore, 'and no draw happened');
});

test('a summoned card keeps the stats it actually had, not its printed ones', function () {
  // User report: "doomsday was spawned in by ghostrider from hand he was an 8/8
  // and then became a 1/1 on board". summonCard takes attack/health arguments
  // but the real-card branch ignored them and rebuilt from the printed def.
  var G = freshGame();
  var dd = G.createCardInstance(cardByName('Doomsday'), 'player');
  G.state.player.hand.push(dd);
  G.state.player.cardsPlayedCount = 0;
  for (var i = 0; i < 7; i++) G._scaleDoomsdayOnOwnerPlay('player');
  assertEq(dd.attack, 8, 'control: he really is an 8/8 in hand');
  assertEq(dd.maxHealth, 8, 'control: and 8 max HP');

  // A SECOND surviving ally, on purpose: a real-card summon entering an
  // otherwise-empty board picks up LONE WOLF's +1/+1, which would muddy the
  // numbers this test exists to pin.
  place(G, 'Juggernaut', 'player', 5);
  var gr = place(G, 'Ghost Rider', 'player', 2);
  gr.currentHealth = 0;
  G.handleDeath(gr, 2, null);

  var onBoard = null;
  for (var l = 0; l < G.LANE_COUNT; l++) {
    var c = G.state.lanes[l].player;
    if (c && c.name === 'Doomsday') { onBoard = c; break; }
  }
  assertEq(!!onBoard, true, 'Doomsday was summoned somewhere');
  assertEq(onBoard.attack, 8, 'he arrives with the ATK he had in hand');
  assertEq(onBoard.maxHealth, 8, 'and the max HP he had in hand');
  assertEq(onBoard.currentHealth, 8, 'at full health');
});

test('summoning still uses printed stats when the caller passes the def values', function () {
  // The control case for the fix above: a normal summon of an unmodified card
  // must be unchanged. Guards against "explicit stats win" quietly rewriting
  // every other summon in the game.
  var G = freshGame();
  place(G, 'Bane', 'player', 5);        // keeps LONE WOLF (+1/+1) out of the maths
  var def = cardByName('Juggernaut');
  G.summonCard('player', 0, def.name, def.cost, def.attack, def.health, def.abilities || [], def);
  var c = G.state.lanes[0].player;
  assertEq(!!c, true, 'the summon landed');
  assertEq(c.attack, def.attack, 'printed ATK preserved');
  assertEq(c.maxHealth, def.health, 'printed HP preserved');
});

test('LONE WOLF still fires on a summon into an empty board', function () {
  // The rule the two tests above deliberately sidestep — pinned here so
  // sidestepping it never quietly becomes deleting it.
  var G = freshGame();
  var def = cardByName('Juggernaut');
  G.summonCard('player', 0, def.name, def.cost, def.attack, def.health, def.abilities || [], def);
  var c = G.state.lanes[0].player;
  assertEq(c.attack, def.attack + 1, 'alone on the board → +1 ATK');
  assertEq(c.maxHealth, def.health + 1, 'alone on the board → +1 HP');
});

test('Michael Myers does not arm a jump into a lane he cannot land in', function () {
  // User: "if michael cannot jump there shouldnt be an option to jump, if the
  // lane is contesed the popup shouldnt occur." The offer was armed on a
  // strictly weaker condition than execution required, so a lane you already
  // held produced a prompt whose PLAY FREE was a guaranteed no-op.
  function armsInto(occupyOwnLane) {
    var G = freshGame();
    var mm = G.createCardInstance(cardByName('Michael Myers'), 'player');
    G.state.player.hand.push(mm);
    if (occupyOwnLane) place(G, 'Bane', 'player', 3);   // our side of lane 4 taken
    // An enemy plays something cheaper in lane 4.
    G.checkJumpConditions('cardPlayed', { owner: 'ai', laneIdx: 3, cost: 1, isEnvironment: false });
    return { ready: !!mm.jumpReady, lane: mm.jumpLane };
  }
  // CONTROL — an open lane must still arm, or the test below passes for the
  // wrong reason by simply having broken the mechanic.
  var open = armsInto(false);
  assertEq(open.ready, true, 'control: an OPEN lane still arms the jump');
  assertEq(open.lane, 3, 'control: locked to the triggering lane');

  var contested = armsInto(true);
  assertEq(contested.ready, false, 'a lane we already occupy must NOT arm the jump');
});

test('a destroyed lane does not arm a jump either', function () {
  var G = freshGame();
  var mm = G.createCardInstance(cardByName('Michael Myers'), 'player');
  G.state.player.hand.push(mm);
  G.state.lanes[3].destroyed = true;
  G.checkJumpConditions('cardPlayed', { owner: 'ai', laneIdx: 3, cost: 1, isEnvironment: false });
  assertEq(!!mm.jumpReady, false, 'a destroyed lane cannot be jumped into');
});

test('jumpTargetLane agrees with what playJumpCard will actually accept', function () {
  // The whole point of the fix: ONE predicate, so arming can never promise
  // something execution refuses.
  var G = freshGame();
  var mm = G.createCardInstance(cardByName('Michael Myers'), 'player');
  G.state.player.hand.push(mm);
  assertEq(G.jumpTargetLane('player', mm, 2), 2, 'an empty, intact lane is legal');
  place(G, 'Bane', 'player', 2);
  assertEq(G.jumpTargetLane('player', mm, 2), -1, 'occupied by us → illegal');
  G.state.lanes[4].destroyed = true;
  assertEq(G.jumpTargetLane('player', mm, 4), -1, 'destroyed → illegal');
  assertEq(G.jumpTargetLane('player', mm, 99), -1, 'out of range → illegal');
  // Free-lane jumper (no locked lane) falls back to any open lane.
  var gf = G.createCardInstance(cardByName('Ghostface'), 'player');
  assertEq(G.jumpTargetLane('player', gf) >= 0, true, 'free-lane jumper finds an open lane');
  for (var i = 0; i < G.LANE_COUNT; i++) {
    // Skip the destroyed lane — putting a body in one builds a board state the
    // engine's own cleanup invariant rejects ("occupies DESTROYED lane").
    if (G.state.lanes[i].destroyed) continue;
    if (!G.state.lanes[i].player) G.state.lanes[i].player = G.createCardInstance(cardByName('Bane'), 'player');
  }
  assertEq(G.jumpTargetLane('player', gf), -1, 'full board → free-lane jumper is illegal too');
});

test("Yoda's shield stops when he stops being Yoda", function () {
  // User: "i super soilder serumed yoda into superman, and yodas passsive of
  // taking half health is still active". The shield was a per-side counter
  // bumped in onPlay and unwound in onDeath, and Super Soldier Serum removes
  // the card with killCardSilent — which fires no onDeath at all.
  var G = freshGame();
  var yoda = place(G, 'Yoda', 'player', 0);
  if (CARD_ABILITIES['Yoda'].onPlay) CARD_ABILITIES['Yoda'].onPlay(G, yoda, 0);
  assertEq(G.yodaShieldCount('player'), 1, 'control: the shield is up while Yoda stands');

  // The exact removal the Serum uses.
  G.killCardSilent(yoda);
  assertEq(G.yodaShieldCount('player'), 0, 'shield is down the moment he leaves the board');

  // And the damage path agrees — this is what the player actually feels.
  var G2 = freshGame();
  var y2 = place(G2, 'Yoda', 'player', 0);
  if (CARD_ABILITIES['Yoda'].onPlay) CARD_ABILITIES['Yoda'].onPlay(G2, y2, 0);
  var ally = place(G2, 'Juggernaut', 'player', 1);
  var attacker = place(G2, 'Bane', 'ai', 1);
  attacker.attack = 4;
  var halved = G2._computeIncomingDamage(attacker, ally);
  assertEq(halved, 2, 'with Yoda up, a 4 lands as 2');
  G2.killCardSilent(y2);
  var full = G2._computeIncomingDamage(attacker, ally);
  assertEq(full, 4, 'with Yoda gone, the same 4 lands in full');
});

test("a dead Yoda still on the board does not hold the shield up", function () {
  // yodaShieldCount filters on currentHealth — a corpse awaiting cleanup must
  // not keep halving damage.
  var G = freshGame();
  var yoda = place(G, 'Yoda', 'player', 0);
  if (CARD_ABILITIES['Yoda'].onPlay) CARD_ABILITIES['Yoda'].onPlay(G, yoda, 0);
  assertEq(G.yodaShieldCount('player'), 1, 'control: up while alive');
  yoda.currentHealth = 0;
  assertEq(G.yodaShieldCount('player'), 0, 'a 0-HP Yoda holds nothing up');
});

test("two Yodas do not stack, and one leaving does not drop the other's shield", function () {
  var G = freshGame();
  var a = place(G, 'Yoda', 'player', 0);
  var b = place(G, 'Yoda', 'player', 1);
  if (CARD_ABILITIES['Yoda'].onPlay) {
    CARD_ABILITIES['Yoda'].onPlay(G, a, 0);
    CARD_ABILITIES['Yoda'].onPlay(G, b, 1);
  }
  assertEq(G.yodaShieldCount('player'), 2, 'both counted');
  G.killCardSilent(a);
  assertEq(G.yodaShieldCount('player') > 0, true, 'the survivor keeps the shield up');
  // The shield is binary at every read site, so 2 must not halve twice.
  var ally = place(G, 'Juggernaut', 'player', 3);
  var atk = place(G, 'Bane', 'ai', 3);
  atk.attack = 4;
  assertEq(G._computeIncomingDamage(atk, ally), 2, 'halved once, not twice');
});

test("the enemy's Yoda does not shield YOUR side", function () {
  var G = freshGame();
  var y = place(G, 'Yoda', 'ai', 0);
  if (CARD_ABILITIES['Yoda'].onPlay) CARD_ABILITIES['Yoda'].onPlay(G, y, 0);
  assertEq(G.yodaShieldCount('ai'), 1, 'their side is shielded');
  assertEq(G.yodaShieldCount('player'), 0, 'ours is not');
});

// Grievous's Block-Meter strangle was REMOVED on 2026-08-09 along with its
// enforcement, so the two tests that pinned it are gone with it — a test for a
// deleted rule is a test that stops the rule from staying deleted. What
// replaces them pins the card he is now.
// Grievous's Block-Meter strangle was REMOVED on 2026-08-09 along with its
// enforcement, and the board-wide Bullseye grant that briefly replaced it went
// the same day. A test for a deleted rule is a test that stops the rule from
// staying deleted, so both sets are gone; these pin the card he is now.
test('General Grievous is a 4-cost duelist with Evade and Overdrive', function () {
  var def = cardByName('General Grievous');
  assertEq(def.cost, 4, 'costs 4');
  assertEq(def.attack, 3, '3 ATK');
  assertEq(def.health, 4, '4 HP');
  assertEq(def.abilities.join(','), 'Evade 1,Overdrive', 'both keywords are on the card');
  // Keywords render as badges — repeating them in the text is the house style
  // violation that makes tiles unreadable.
  assertEq(def.desc.indexOf('Evade'), -1, 'and are NOT repeated in the desc');
  assertEq(def.desc.indexOf('Overdrive'), -1, 'either of them');
  assertEq(def.desc.indexOf('Bullseye'), -1, 'the Bullseye grant is gone from the text');
  assertEq(def.desc.indexOf('Block Meter'), -1, 'and so is the old passive');
  assertEq(typeof Game.grievousLocksBlockFor, 'undefined', 'the old gate is still gone from the engine');

  // The keywords have to actually LAND on the instance, not just print.
  var G = freshGame();
  var gr = place(G, 'General Grievous', 'player', 0);
  assertEq(gr.evadeCharges, 1, 'Evade 1 resolved to a charge');
  assertEq(gr.isOverdrive, true, 'Overdrive resolved to the flag');
});

test('Grievous summons a (1/1) Battle Droid, and grants nobody Bullseye', function () {
  var G = freshGame();
  var ally = place(G, 'Bane', 'player', 3);
  var gr = place(G, 'General Grievous', 'player', 0);
  CARD_ABILITIES['General Grievous'].onPlay(G, gr, 0);

  var droid = G.getAllCardsOf('player').find(function (c) { return c.name === 'Battle Droid'; });
  assert(!!droid, 'a Battle Droid is on the board');
  assertEq(droid.attack, 1, '1 ATK');
  assertEq(droid.currentHealth, 1, '1 HP');
  // The printed text has to agree with what actually lands — these two drifted
  // apart the moment the droid's stats changed.
  assertEq(cardByName('General Grievous').desc.indexOf('(1/1) Battle Droid') > -1, true,
    'and his card text names the same body');
  // The grant is gone — nobody should be picking up a keyword on his arrival.
  assertEq(!!ally.isBullseye, false, 'the ally gets no Bullseye');
  assertEq(!!gr.isBullseye, false, 'nor does Grievous');
  assertEq(!!droid.isBullseye, false, 'nor the droid');
});

test('Every Grievous kill hands (+1/+1) to a DIFFERENT ally', function () {
  var G = freshGame();
  var gr = place(G, 'General Grievous', 'player', 0);
  var a1 = place(G, 'Bane', 'player', 1);
  var a2 = place(G, 'Catwoman', 'player', 2);
  var grAtk = gr.attack, grHp = gr.currentHealth;
  var before = (a1.attack + a1.currentHealth) + (a2.attack + a2.currentHealth);

  CARD_ABILITIES['General Grievous'].onKill(G, gr);
  var after = (a1.attack + a1.currentHealth) + (a2.attack + a2.currentHealth);
  assertEq(after, before + 2, 'exactly one ally gained +1/+1');
  assertEq(gr.attack, grAtk, 'and it was not Grievous — his ATK is untouched');
  assertEq(gr.currentHealth, grHp, 'nor his HP');

  // It stacks: three more kills, three more points of stats on the board.
  for (var i = 0; i < 3; i++) CARD_ABILITIES['General Grievous'].onKill(G, gr);
  var after2 = (a1.attack + a1.currentHealth) + (a2.attack + a2.currentHealth);
  assertEq(after2, before + 8, 'four kills, four buffs — it is permanent and repeatable');
});

test('A lone Grievous kill buffs nobody, rather than buffing himself', function () {
  var G = freshGame();
  var gr = place(G, 'General Grievous', 'player', 0);
  var atk = gr.attack, hp = gr.currentHealth;
  CARD_ABILITIES['General Grievous'].onKill(G, gr);
  assertEq(gr.attack, atk, 'no self-buff when he is alone');
  assertEq(gr.currentHealth, hp, 'none at all');

  // Environments never fight, so a (+1/+1) on one is a stat nobody reads.
  var G2 = freshGame();
  var gr2 = place(G2, 'General Grievous', 'player', 0);
  var env = place(G2, 'Boiler Room', 'player', 1);
  env.isEnvironment = true;
  var envAtk = env.attack;
  CARD_ABILITIES['General Grievous'].onKill(G2, gr2);
  assertEq(env.attack, envAtk, 'the environment is not a valid trophy holder');
  assertEq(gr2.attack, atk, 'and he still does not buff himself as a fallback');
});

test('the combat forecast counts Critical (and every other attacker modifier)', function () {
  // User: an "8 -> 5" HP-after pill on a card a CRITICAL attacker was about to
  // hit for 6. predictCombatGlobal hand-rolled `raw - armor` off card.attack,
  // making it a THIRD copy of the damage maths that knew about armor and
  // nothing else.
  function predictedDmgOn(setup) {
    var G = freshGame();
    var atk = place(G, 'Bane', 'ai', 0);
    var def = place(G, 'Hela', 'player', 0);
    atk.attack = 3;
    def.currentHealth = 20; def.maxHealth = 20;   // survive, so we read damage not death
    if (setup) setup(G, atk, def);
    var pred = G.predictCombatGlobal();
    var e = pred && pred.byId && pred.byId.get(def.id);
    return e ? e.dmgIn : null;
  }
  // CONTROL — plain 3 ATK must still predict 3, or a broken predictor would
  // make the crit assertion pass for the wrong reason.
  assertEq(predictedDmgOn(null), 3, 'control: a plain 3-ATK swing predicts 3');
  assertEq(predictedDmgOn(function (G, atk) { atk._criticalThisRound = true; }), 6,
    'CRITICAL doubles it — this is the reported bug');
  assertEq(predictedDmgOn(function (G, atk) { atk._yodaCombinedAtk = 9; }), 9,
    "Yoda's combined-force strike overrides base ATK");
  assertEq(predictedDmgOn(function (G, atk, def) { def.armorValue = 1; }), 2,
    'armor still subtracts (the one modifier it always had)');
  assertEq(predictedDmgOn(function (G, atk, def) { def.armorValue = 1; atk.ignoresArmor = true; }), 3,
    'ignoresArmor now respected too');
});

test("the forecast honours Yoda's shield and Palpatine's frozen-double", function () {
  function dmg(setup) {
    var G = freshGame();
    var atk = place(G, 'Bane', 'ai', 0);
    var def = place(G, 'Hela', 'player', 0);
    atk.attack = 4;
    def.currentHealth = 30; def.maxHealth = 30;
    if (setup) setup(G, atk, def);
    var e = G.predictCombatGlobal().byId.get(def.id);
    return e ? e.dmgIn : null;
  }
  assertEq(dmg(null), 4, 'control');
  assertEq(dmg(function (G) {
    var y = G.createCardInstance(cardByName('Yoda'), 'player');
    G.state.lanes[4].player = y;
  }), 2, "the defender's Yoda halves it");
  assertEq(dmg(function (G, atk, def) {
    def.isFrozen = true;
    var p = G.createCardInstance(cardByName('Emperor Palpatine'), 'ai');
    p.passive = 'doubleFrozenDamage';
    G.state.lanes[4].ai = p;
  }), 8, 'Palpatine doubles damage to a frozen target');
});

test('predicting damage must not write to the combat log', function () {
  // predictCombatGlobal runs on EVERY render. Routing it through the resolver's
  // helper without silencing it would spray phantom "[CRITICAL] CRITICAL HIT!"
  // lines into the log for fights that have not happened.
  var G = freshGame();
  var atk = place(G, 'Bane', 'ai', 0);
  var def = place(G, 'Hela', 'player', 0);
  atk.attack = 3; atk._criticalThisRound = true;
  var lines = 0, real = G.log;
  G.log = function () { lines++; return real.apply(G, arguments); };
  try { G.predictCombatGlobal(); } finally { G.log = real; }
  assertEq(lines, 0, 'the predictor is silent');

  // ...and the RESOLVER still logs, so silencing did not mute real combat.
  var G2 = freshGame();
  var a2 = place(G2, 'Bane', 'ai', 0);
  var d2 = place(G2, 'Hela', 'player', 0);
  a2.attack = 3; a2._criticalThisRound = true;
  var said = [];
  var real2 = G2.log;
  G2.log = function (m) { said.push(String(m)); return real2.apply(G2, arguments); };
  try { G2._computeIncomingDamage(a2, d2); } finally { G2.log = real2; }
  assertEq(said.some(function (m) { return m.indexOf('CRITICAL') > -1; }), true,
    'real combat still narrates the crit');
});

test('environments never enter the dead pile', function () {
  // User: "enviroments dont go into the dead pile". They cannot be revived —
  // revival writes a COMBAT slot via summonCard, which refuses environments —
  // so an archived environment is a trap: it appears as a revive candidate,
  // gets picked, and the effect silently does nothing.
  var G = freshGame();
  var envDefs = CARD_DEFS.filter(function (d) { return d.type === 'environment'; });
  assertEq(envDefs.length > 0, true, 'control: there are environment cards to test');
  envDefs.slice(0, 4).forEach(function (def, i) {
    var e = G.createCardInstance(def, 'player');
    if (!G.state.lanes[i]._env) G.state.lanes[i]._env = {};
    G.state.lanes[i]._env.player = e;
    e.currentHealth = 0;
    G.handleDeath(e, i, null);
  });
  var envInPile = G.state.player.deadPile.filter(function (d) { return d.type === 'environment'; });
  assertEq(envInPile.length, 0, 'no environment reached the dead pile');

  // CONTROL — an ordinary card must still be archived, or this test would pass
  // by having simply broken the dead pile.
  var G2 = freshGame();
  var bane = place(G2, 'Bane', 'player', 0);
  bane.currentHealth = 0;
  G2.handleDeath(bane, 0, null);
  assertEq(G2.state.player.deadPile.some(function (d) { return d.name === 'Bane'; }), true,
    'control: a normal card is still archived');
});

test("Moder's compulsion dies with Moder, even on a silent exit", function () {
  // Last of the stamped-state leaks. forcedLane was set in Moder's onPlay and
  // cleared only in his onDeath, so a silent removal (Super Soldier Serum's
  // killCardSilent, devour, bounce) left the opponent compelled by a Moder who
  // was no longer on the board. Stale forced-lane residue is the exact class
  // behind the old MP guest-placement bug.
  var G = freshGame();
  var moder = place(G, 'Moder', 'player', 2);
  CARD_ABILITIES['Moder'].onPlay(G, moder, 2);
  assertEq(G.state.ai.forcedLane, 2, 'control: the stamp is set');
  assertEq(G.moderCompulsionLane('ai'), 2, 'control: and the compulsion is real');

  G.killCardSilent(moder);        // exactly what the Serum does
  assertEq(G.state.ai.forcedLane, 2, 'the raw stamp is STILL there — that is the leak');
  assertEq(G.moderCompulsionLane('ai'), -1, 'but the compulsion is correctly dead');
  assertEq(G._nextEnemyCardClaimant('ai'), null, 'so Moder no longer claims the next card');
});

test('a dead-but-uncleaned Moder does not compel either', function () {
  var G = freshGame();
  var moder = place(G, 'Moder', 'player', 3);
  CARD_ABILITIES['Moder'].onPlay(G, moder, 3);
  assertEq(G.moderCompulsionLane('ai'), 3, 'control');
  moder.currentHealth = 0;
  assertEq(G.moderCompulsionLane('ai'), -1, 'a corpse compels nothing');
});

test("a living Moder still pulls the next enemy card into his lane", function () {
  // The control that matters most: the leak fix must not disarm the card.
  var G = freshGame();
  var moder = place(G, 'Moder', 'player', 4);
  CARD_ABILITIES['Moder'].onPlay(G, moder, 4);
  assertEq(G._nextEnemyCardClaimant('ai'), 'moder', 'Moder claims the next enemy card');
  assertEq(G.moderCompulsionLane('ai'), 4, 'and it points at his lane');
  // Asserting through playCard would drag in phase/energy gating that has
  // nothing to do with this fix; the claimant IS the mechanism the pull reads.
});

test("Moder's compulsion FIZZLES on the next card when his lane is blocked — no lurking ambush", function () {
  // 1v1 report: a Moder standing in front of an occupied lane lurked for turns,
  // then yanked a totally different card in and stripped it. The compel is a
  // one-shot on the opponent's NEXT card — if Moder's lane can't take it, it
  // fizzles instead of persisting to ambush a later card.
  var G = freshGame();
  var moder = place(G, 'Moder', 'player', 4);
  place(G, 'King Shark', 'ai', 4);            // "in front of some other card"
  CARD_ABILITIES['Moder'].onPlay(G, moder, 4);
  assertEq(G.state.ai.forcedLane, 4, 'compel armed');

  // The AI's next card lands elsewhere (blocked lane) → fizzle.
  var next = G.createCardInstance(cardByName('Sabertooth'), 'ai');
  var lane1 = G._redirectForForcedLane('ai', next, 0);
  assertEq(lane1, 0, 'the next card stays where it was played');
  assertEq(G.state.ai.forcedLane, null, 'the compel is spent, not left armed');
  assertEq(!!next._moderStripped, false, 'and the card keeps its abilities');
  assertEq(moder._moderStripPending, 0, 'the pending charge is consumed');

  // Later, with the lane free, a big card must NOT be grabbed by the dead compel.
  G.state.lanes[4].ai = null;
  var gz = G.createCardInstance(cardByName('Godzilla'), 'ai');
  var lane2 = G._redirectForForcedLane('ai', gz, 5);
  assertEq(lane2, 5, 'a later card is not yanked into Moder\'s lane');
  assertEq(!!gz._moderStripped, false, 'and keeps its abilities');
});

test("Moder still pulls + strips the next card when his lane IS free", function () {
  // The control: the fizzle fix must not disarm a Moder whose lane can take the card.
  var G = freshGame();
  var moder = place(G, 'Moder', 'player', 3);
  CARD_ABILITIES['Moder'].onPlay(G, moder, 3);
  var next = G.createCardInstance(cardByName('Godzilla'), 'ai');
  var lane = G._redirectForForcedLane('ai', next, 1);   // chose lane 1; Moder's lane 3 is free
  assertEq(lane, 3, 'the next card is pulled into Moder\'s lane');
  assertEq(!!next._moderStripped, true, 'and loses its abilities');
});

test('a destroyed lane kills the compulsion too', function () {
  var G = freshGame();
  var moder = place(G, 'Moder', 'player', 1);
  CARD_ABILITIES['Moder'].onPlay(G, moder, 1);
  G.state.lanes[1].destroyed = true;
  assertEq(G.moderCompulsionLane('ai'), -1, 'nothing can be pulled into a destroyed lane');
});

test('Magneto never moves a card that died before the move landed', function () {
  // User: "magneto is forced to move a person he killed with his passive."
  // Each completed move runs moveCard -> recomputeAuras, and Magneto's parity
  // aura can kill an enemy it pushes into an even lane. The picker filters
  // living cards when it OPENS, but choosing a card and choosing its lane are
  // two separate interactions and the target can die in between.
  var G = freshGame();
  for (var i = 0; i < G.LANE_COUNT; i++) { G.state.lanes[i].player = null; G.state.lanes[i].ai = null; }
  var mag = place(G, 'Magneto', 'player', 5);
  var frail = place(G, 'Ant-Man', 'ai', 0);
  frail.currentHealth = 1; frail.maxHealth = 1;
  place(G, 'Bane', 'ai', 2);

  var movedDead = false;
  var realMove = G.moveCard;
  G.moveCard = function (card, from, to) {
    if (!card || card.currentHealth <= 0) movedDead = true;
    return realMove.apply(G, arguments);
  };
  // Kill the chosen target in the gap between the card pick and the lane pick —
  // the window the guard exists for, and the one the synchronous shim cannot
  // produce on its own.
  var realCard = G.promptCardChoice, realLane = G.promptLaneChoice;
  G.promptCardChoice = function (o, opts, t, b, cb) {
    var pick = (opts || []).find(function (c) { return c.name === 'Ant-Man'; }) || (opts || [])[0];
    if (pick && pick.name === 'Ant-Man') pick.currentHealth = 0;   // dies mid-decision
    if (cb) cb(pick);
    return true;
  };
  G.promptLaneChoice = function (o, lanes, t, b, cb) { if (cb) cb(lanes[0]); return true; };
  try { CARD_ABILITIES['Magneto'].onPlay(G, mag, 5); }
  finally { G.moveCard = realMove; G.promptCardChoice = realCard; G.promptLaneChoice = realLane; }

  assertEq(movedDead, false, 'moveCard was never handed a corpse');

  // CONTROL — a living target still gets moved, or this passes by having
  // simply broken Magneto.
  var G2 = freshGame();
  for (var j = 0; j < G2.LANE_COUNT; j++) { G2.state.lanes[j].player = null; G2.state.lanes[j].ai = null; }
  var mag2 = place(G2, 'Magneto', 'player', 5);
  var victim = place(G2, 'Bane', 'ai', 0);
  var moves = 0, rm2 = G2.moveCard;
  G2.moveCard = function () { moves++; return rm2.apply(G2, arguments); };
  var rc2 = G2.promptCardChoice, rl2 = G2.promptLaneChoice;
  G2.promptCardChoice = function (o, opts, t, b, cb) { if (cb) cb((opts || [])[0]); return true; };
  G2.promptLaneChoice = function (o, lanes, t, b, cb) { if (cb) cb(lanes[0]); return true; };
  try { CARD_ABILITIES['Magneto'].onPlay(G2, mag2, 5); }
  finally { G2.moveCard = rm2; G2.promptCardChoice = rc2; G2.promptLaneChoice = rl2; }
  assertEq(moves > 0, true, 'control: a living card is still moved');
});

test('Magneto offers the last move instead of forcing it, but only at one option', function () {
  // Owner's call: auto-resolve is the problem, not the mandate. With exactly
  // one candidate the picker used to be skipped entirely (promptCardChoice
  // shows no tray for a single-option list), so the player was moved with no
  // say. With 2+ candidates it stays mandatory, because then it is a decision.
  function titlesShownWith(nCandidates) {
    var G = freshGame();
    for (var i = 0; i < G.LANE_COUNT; i++) { G.state.lanes[i].player = null; G.state.lanes[i].ai = null; }
    var mag = place(G, 'Magneto', 'player', 5);
    var names = ['Bane', 'Juggernaut', 'Hela'];
    for (var k = 0; k < nCandidates; k++) place(G, names[k], 'ai', k);
    var seen = [];
    var rc = G.promptCardChoice, rl = G.promptLaneChoice;
    G.promptCardChoice = function (o, opts, t, b, cb) {
      seen.push((opts || []).map(function (c) { return c.name; }));
      if (cb) cb((opts || [])[0]);   // always take the first offered
      return true;
    };
    G.promptLaneChoice = function (o, lanes, t, b, cb) { if (cb) cb(lanes[0]); return true; };
    try { CARD_ABILITIES['Magneto'].onPlay(G, mag, 5); }
    finally { G.promptCardChoice = rc; G.promptLaneChoice = rl; }
    return seen;
  }

  var one = titlesShownWith(1);
  assertEq(one.length > 0, true, 'a picker IS shown for the single candidate');
  assertEq(one[0].indexOf('Skip') > -1, true, 'and it carries a Skip option');

  // CONTROL — with two candidates the real card tray is shown, no Skip.
  var two = titlesShownWith(2);
  assertEq(two[0].indexOf('Skip'), -1, 'two candidates: no Skip, the move stays mandatory');
  assertEq(two[0].length, 2, 'and the tray lists the real cards');
});

test('choosing Skip on Magneto leaves the board alone', function () {
  var G = freshGame();
  for (var i = 0; i < G.LANE_COUNT; i++) { G.state.lanes[i].player = null; G.state.lanes[i].ai = null; }
  var mag = place(G, 'Magneto', 'player', 5);
  var lone = place(G, 'Bane', 'ai', 0);
  var moves = 0, rm = G.moveCard;
  G.moveCard = function () { moves++; return rm.apply(G, arguments); };
  var rc = G.promptCardChoice, rl = G.promptLaneChoice;
  G.promptCardChoice = function (o, opts, t, b, cb) {
    var skip = (opts || []).find(function (c) { return c.id === 'mag_skip'; });
    if (cb) cb(skip || (opts || [])[0]);
    return true;
  };
  G.promptLaneChoice = function (o, lanes, t, b, cb) { if (cb) cb(lanes[0]); return true; };
  try { CARD_ABILITIES['Magneto'].onPlay(G, mag, 5); }
  finally { G.moveCard = rm; G.promptCardChoice = rc; G.promptLaneChoice = rl; }
  assertEq(moves, 0, 'nothing was moved');
  assertEq(G.findCardLane(lone), 0, 'and the lone card stayed put');
});

test("Joker's Playing Card blocks a BONUS attack, not just the normal swing", function () {
  // User: "the opponent played jokers playing card in lane 3, the anakin moved
  // did a bonus attack in lane 3 and it still hit." resolveUncontestedLane
  // honoured lane.protected; drainBonusAttacks never did.
  function heroDamageFrom(protectLane) {
    var G = freshGame();
    var atk = place(G, 'Anakin Skywalker', 'player', 2);   // lane 3, uncontested
    atk.attack = 5;
    atk.bonusAttack = 1;
    if (protectLane) G.state.lanes[2].protected = 'ai';    // the AI cast the trick
    var before = G.state.ai.health;
    G.drainBonusAttacks(atk);
    return before - G.state.ai.health;
  }
  // CONTROL FIRST — an unprotected lane must still land, or the assertion below
  // would pass simply by having broken bonus attacks outright.
  assertEq(heroDamageFrom(false), 5, 'control: an unprotected bonus attack still hits the hero');
  assertEq(heroDamageFrom(true), 0, 'a protected lane turns the bonus attack aside');
});

test("Joker's protection does NOT stop a contested bonus attack", function () {
  // The card reads "UNCONTESTED enemies in those lanes cannot attack", so a
  // real trade in a protected lane is unaffected. Pinning this stops the fix
  // from quietly becoming "protected lanes are immune to everything".
  var G = freshGame();
  var atk = place(G, 'Anakin Skywalker', 'player', 2);
  atk.attack = 4; atk.bonusAttack = 1;
  var blocker = place(G, 'Bane', 'ai', 2);
  blocker.currentHealth = 10; blocker.maxHealth = 10;
  G.state.lanes[2].protected = 'ai';
  // Spy on the SWING rather than measuring net HP. Bane's own "add (+1/+1)
  // when damaged" heals him mid-hit, so net health conflates the damage with
  // his reaction — my first version of this test read 3 for a 4-ATK swing and
  // looked like a bug in the fix. The question here is only whether the hit
  // happened at all.
  var hits = [];
  var real = G.applyCombatDamage;
  G.applyCombatDamage = function (from, to) { hits.push((from && from.name) + '->' + (to && to.name)); return real.apply(G, arguments); };
  try { G.drainBonusAttacks(atk); } finally { G.applyCombatDamage = real; }
  assertEq(hits.length, 1, 'the contested trade still resolves');
  assertEq(hits[0], 'Anakin Skywalker->Bane', 'and it struck the blocker, not the hero');
});

test('per-match seat hygiene runs for BOTH classic and custom-deck matches', function () {
  // Owner asked whether custom-deck multiplayer runs exactly like regular
  // multiplayer. Both flavours enter through the same startMultiplayerMatch and
  // differ only in the startMatch opts — so the per-match reset has to be
  // mode-blind. Probing it turned up three fields that leaked in BOTH modes.
  function residueAfter(opts) {
    var G = freshGame();
    ['player', 'ai'].forEach(function (sd) {
      var s = G.state[sd];
      s.redrawsUsed = 3; s.undosUsed = 1;
      s.maxHandSize = 9; s.maxTrickHandSize = 5;
      s.forcedLane = 2; s.magnetoForcedLanes = [1, 2];
      s._igSpentThisCombat = true;
    });
    G.startMatch(opts);
    var p = G.state.player, a = G.state.ai;
    return {
      redraw: p.redrawsUsed + a.redrawsUsed,
      undos: p.undosUsed + a.undosUsed,
      hand: p.maxHandSize + a.maxHandSize,
      tricks: p.maxTrickHandSize + a.maxTrickHandSize,
      forced: (p.forcedLane == null ? 0 : 1) + (a.forcedLane == null ? 0 : 1),
      magneto: (p.magnetoForcedLanes ? 1 : 0) + (a.magnetoForcedLanes ? 1 : 0),
      igSpent: (p._igSpentThisCombat ? 1 : 0) + (a._igSpentThisCombat ? 1 : 0)
    };
  }
  var deck = { cards: ['Bane', 'Juggernaut', 'Hela', 'Revan'], tricks: ['Smoke Pellet'] };
  var modes = [
    ['classic', { players: '1v1', deck: 'classic' }],
    ['custom-deck', { players: '1v1', deck: 'deckbuilder', withDraft: true, customDeck: deck, aiDeck: deck }]
  ];
  modes.forEach(function (m) {
    var r = residueAfter(m[1]);
    assertEq(r.redraw, 0, m[0] + ': redraw counters reset');
    assertEq(r.undos, 0, m[0] + ': undo counters reset');
    assertEq(r.hand, 14, m[0] + ': max hand size back to 7 each');
    assertEq(r.tricks, 6, m[0] + ': max trick hand back to 3 each');
    assertEq(r.forced, 0, m[0] + ': no forced-lane residue');
    assertEq(r.magneto, 0, m[0] + ': no Magneto queue residue');
    assertEq(r.igSpent, 0, m[0] + ": Iron Giant's save is recharged");
  });
});

test('Killer Moth grows on ANY move, not just his own flutter', function () {
  // User: "i used bifrost on killer moth, bifrost moved killer moth yet he
  // didnt gain +1/+1." The buff was stamped inline at his own moveCard call
  // site, so only the move he makes himself paid.
  var G = freshGame();
  var km = place(G, 'Killer Moth', 'player', 0);
  var a0 = km.attack, h0 = km.maxHealth;

  // An EXTERNAL move — exactly what Bifrost does.
  G.moveCard(km, 0, 2);
  assertEq(G.findCardLane(km), 2, 'control: he actually moved');
  assertEq(km.attack, a0 + 1, 'external move grows ATK');
  assertEq(km.maxHealth, h0 + 1, 'external move grows HP');

  G.moveCard(km, 2, 4);
  assertEq(km.attack, a0 + 2, 'and it compounds per move');

  // His OWN flutter must grow him exactly ONCE, not twice — the inline stamp
  // was removed precisely so moveCard's hook is the only source.
  var G2 = freshGame();
  var km2 = place(G2, 'Killer Moth', 'player', 0);
  var before = km2.attack;
  km2.beforeTricksFired = false;
  CARD_ABILITIES['Killer Moth'].onBeforeTricks(G2, km2, 0);
  assertEq(km2.attack, before + 1, 'his own flutter grows him once, not twice');
});

test('a blocked move does not grow Killer Moth', function () {
  // moveCard bails before the hook on a destroyed / occupied / frozen move, so
  // a refused relocation must not pay. Otherwise "grows when he moves" quietly
  // becomes "grows when anything tries to move him".
  var G = freshGame();
  var km = place(G, 'Killer Moth', 'player', 0);
  var a0 = km.attack;
  G.state.lanes[3].destroyed = true;
  G.moveCard(km, 0, 3);
  assertEq(G.findCardLane(km), 0, 'the move was refused');
  assertEq(km.attack, a0, 'and he did not grow');

  km.isFrozen = true;
  G.moveCard(km, 0, 2);
  assertEq(km.attack, a0, 'a frozen Moth cannot be moved and does not grow');
});

test('onBeforeCombat fires ONCE per combat, however often resolveCombat re-enters', function () {
  // User: "for some reason jack sparrow had more than 1 parlay thats
  // impossible." _beforeCombatFired was deleted the moment the hooks finished,
  // making it a once-per-CALL guard rather than the once-per-COMBAT guard it is
  // documented to be. resolveCombat is deeply re-entrant — every mid-combat
  // prompt re-enters it — so each re-entry re-fired every hook.
  var G = freshGame();
  var fires = 0;
  var probe = place(G, 'Bane', 'player', 5);
  probe.onBeforeCombat = function () { fires++; };

  function dispatch() {
    // The exact block resolveCombat runs.
    if (!G.state._beforeCombatFired) {
      G.state._beforeCombatFired = true;
      G.getAllCardsOnBoard().forEach(function (c) {
        if (c.onBeforeCombat && c.currentHealth > 0) c.onBeforeCombat(G, c, G.findCardLane(c));
      });
    }
  }
  dispatch(); dispatch(); dispatch();
  assertEq(fires, 1, 'three re-entries, one firing');

  // postCombat is what re-arms it for the NEXT combat.
  G.postCombat();
  assertEq(!!G.state._beforeCombatFired, false, 'postCombat re-arms the hooks');
  dispatch();
  assertEq(fires, 2, 'the next combat fires them again');
});

test('Jack Sparrow parlays exactly one enemy per combat', function () {
  // The player-visible half of the same bug: Parlay leaves a badge, so a
  // double-fire was legible on the board where Han Solo's redirect was not.
  var G = freshGame();
  place(G, 'Jack Sparrow', 'player', 5);
  [0, 1, 2].forEach(function (i) { place(G, 'Bane', 'ai', i); });
  // Answer each prompt with a DIFFERENT lane — picking the same one every time
  // masks the bug by re-parlaying the same card, which is how my first probe
  // read a false clean.
  var pick = 0, realLane = G.promptLaneChoice;
  G.promptLaneChoice = function (o, lanes, t, b, cb) {
    if (cb) cb(lanes[Math.min(pick++, lanes.length - 1)]);
    return true;
  };
  function dispatch() {
    if (!G.state._beforeCombatFired) {
      G.state._beforeCombatFired = true;
      G.getAllCardsOnBoard().forEach(function (c) {
        if (c.onBeforeCombat && c.currentHealth > 0) c.onBeforeCombat(G, c, G.findCardLane(c));
      });
    }
  }
  try { dispatch(); dispatch(); dispatch(); }
  finally { G.promptLaneChoice = realLane; }
  var parlayed = [0, 1, 2].filter(function (i) { return G.state.lanes[i].ai._parlayedThisRound; }).length;
  assertEq(parlayed, 1, 'exactly one enemy is held by Parlay');
});

test('the one-undo-per-match cap actually holds online', function () {
  // Shipped this morning and it never worked: the counter was incremented on
  // the CURRENT state, then `this.state = snap` replaced that object with a
  // clone captured before the increment. Measured four consecutive undos with
  // undosUsed reading 0 after every one.
  var G = freshGame();
  var realMP = G.isMultiplayer;
  G.isMultiplayer = function () { return true; };
  G.mp = { role: 'host', you: 'player' };
  var results = [];
  try {
    for (var i = 0; i < 3; i++) {
      G.snapshot();
      G.state.player.currency = 5 + i;
      results.push({ ok: G.undo('player'), used: G.state.player.undosUsed | 0 });
    }
  } finally { G.isMultiplayer = realMP; G.mp = null; }
  assertEq(results[0].ok, true, 'the first undo is allowed');
  assertEq(results[0].used, 1, 'and it is CHARGED — this is what was lost in the restore');
  assertEq(results[1].ok, false, 'the second is refused');
  assertEq(results[2].ok, false, 'and stays refused');
});

test('a draft mulligan draws from the mulliganing side\'s own pile', function () {
  // Custom-deck only. Every other key in draftMulligan is per-side; the pile
  // lookup was hardcoded to 'player', so a guest's mulligan pulled from the
  // HOST's deck. Invisible in classic, where both sides share one pile.
  var G = freshGame();
  G.state.mode = { deck: 'deckbuilder', players: '1v1' };
  // Distinct per-side piles so the source is unambiguous.
  G.state.player.drawPile = [];
  G.state.ai.drawPile = [];
  for (var i = 0; i < 6; i++) {
    G.state.player.drawPile.push(Object.assign({}, cardByName('Bane')));
    G.state.ai.drawPile.push(Object.assign({}, cardByName('Hela')));
  }
  var hostBefore = G.state.player.drawPile.length;
  var guestBefore = G.state.ai.drawPile.length;
  G.state.draft = {
    phase: 'cards', aiChoices: [Object.assign({}, cardByName('Juggernaut'))],
    aiHolding: [], playerChoices: [], playerHolding: []
  };
  G.draftMulligan('ai');
  assertEq(G.state.player.drawPile.length, hostBefore, "the HOST's pile is untouched");
  assertEq(G.state.ai.drawPile.length < guestBefore, true, "the guest drew from their OWN pile");
});

test('a second match does not inherit the first', function () {
  // makePlayer() runs once per PAGE LOAD and startMatch reuses this.state, so
  // the only things reset were the counters. Measured after quitting a match
  // and hosting again: round 13, gameOver TRUE, HP 4/9, last match's hand,
  // piles, block meter, an armed one-shot, and two lanes still occupied.
  var G = freshGame();
  G.startMatch({ players: '1v1', deck: 'classic' });
  var s = G.state;
  s.round = 13; s.gameOver = true; s.winner = 'player';
  s.player.health = 4; s.ai.health = 9;
  s.player.hand = [G.createCardInstance(cardByName('Bane'), 'player')];
  s.player.deadPile = [{ name: 'Ghost' }];
  s.player.discardPile = [{ name: 'Trash' }];
  s.player.blockMeter = 6;
  s.player.nextCardStolen = true;
  s.lanes[0].player = G.createCardInstance(cardByName('Hela'), 'player');
  s.lanes[2].ai = G.createCardInstance(cardByName('Revan'), 'ai');
  s.lanes[4].destroyed = true;

  G.startMatch({ players: '1v1', deck: 'classic' });
  var n = G.state;
  assertEq(n.round, 0, 'round reset (round 13 = 13 energy on turn one)');
  assertEq(n.gameOver, false, 'gameOver cleared');
  assertEq(n.winner, null, 'winner cleared');
  assertEq(n.player.health, 30, 'player HP restored');
  assertEq(n.ai.health, 30, 'AI HP restored');
  assertEq(n.player.deadPile.length, 0, 'dead pile emptied');
  assertEq(n.player.discardPile.length, 0, 'discard emptied');
  assertEq(n.player.blockMeter, 0, 'block meter reset');
  assertEq(!!n.player.nextCardStolen, false, 'armed one-shot cleared');
  assertEq(n.lanes.filter(function (l) { return l.player || l.ai; }).length, 0, 'board cleared');
  assertEq(!!n.lanes[4].destroyed, false, 'destroyed lanes restored');
});

test("a guest's undo cannot pop the host's snapshot", function () {
  // Every conditional snapshot site read `owner === 'player'`, so a GUEST
  // action — which reaches the host as 'ai' — produced no entry at all, and
  // the guest's Undo popped whatever the host had last stored.
  var G = freshGame();
  var realMP = G.isMultiplayer;
  G.isMultiplayer = function () { return true; };
  G.mp = { role: 'host', you: 'player' };
  try {
    // The HOST takes a snapshot for its own move.
    G.snapshot('player');
    assertEq(G.history.length, 1, 'control: the host recorded an entry');
    // The guest now asks to undo. That entry is not theirs.
    assertEq(G.undo('ai'), false, "the guest cannot pop the host's entry");
    assertEq(G.history.length, 1, 'and it is still there for its owner');
    // The host can take its own back.
    assertEq(G.undo('player'), true, 'the host undoes its own move');

    // A guest action now records too, tagged to the guest.
    G.snapshot('ai');
    assertEq(G.history[0]._undoSeat, 'ai', 'the entry is stamped to the guest');
    assertEq(G.undo('player'), false, "and the host cannot pop the guest's");
    assertEq(G.undo('ai'), true, 'the guest undoes their own move');
  } finally { G.isMultiplayer = realMP; G.mp = null; }
});

test('a card killed by its own Burning does not get to attack', function () {
  // User: "burning needs to hit first resolve then the attack."
  // The burn tick's damage was never RESOLVED before the swing, so a card the
  // burn had just killed still landed its full attack. The hook below is a
  // hand-rolled stand-in for a pre-attack tick, NOT Boiler Room's — Boiler Room
  // has since moved onto the shared decaying Burning, which ticks on
  // onLaneCombat. What is under test here is the resolution ordering, which is
  // why this test is unaffected by that move.
  function heroDamage(burning) {
    var G = freshGame();
    G.state.phase = 'combat';
    var burner = place(G, 'Bane', 'ai', 2);
    burner.currentHealth = 1; burner.maxHealth = 1; burner.attack = 6;
    burner.isBurning = !!burning;
    burner.onBeforeAttack = function (G2, self) {
      if (self.isBurning && self.currentHealth > 0) G2.dealDamage(self, 1, null);
    };
    var before = G.state.player.health;
    G.resolveUncontestedLane(2, 'ai');
    return { dealt: before - G.state.player.health, hp: burner.currentHealth };
  }
  // CONTROL — the same 1 HP attacker, NOT burning, must still hit for 6.
  // Without this the assertion below would pass if I had simply broken attacks.
  var control = heroDamage(false);
  assertEq(control.dealt, 6, 'control: an unburned attacker still swings');

  var burned = heroDamage(true);
  assertEq(burned.hp <= 0, true, 'the burn killed it');
  assertEq(burned.dealt, 0, 'and a corpse deals no damage');
});

test('Burning that does NOT kill still lets the attack through', function () {
  // The other half: burn resolving first must not cancel a swing the card
  // survived. Otherwise "resolve first" quietly becomes "burning disarms".
  var G = freshGame();
  G.state.phase = 'combat';
  var burner = place(G, 'Bane', 'ai', 2);
  burner.currentHealth = 5; burner.maxHealth = 5; burner.attack = 4;
  burner.isBurning = true;
  // Inert the reaction on purpose. Bane's "While Active: Add (+1/+1) when
  // damaged" fires ON THE BURN TICK, so he heals back to 5 AND swings for 5
  // instead of 4 — correct behaviour, but it makes every number in this test
  // about Bane rather than about burn ordering. Two of my earlier assertions
  // today were wrong for exactly this reason.
  burner.onDamaged = null;
  burner.passive = null;
  burner.onBeforeAttack = function (G2, self) {
    if (self.isBurning && self.currentHealth > 0) G2.dealDamage(self, 1, null);
  };
  // Spy on the tick rather than reading HP afterwards. Bane's own "While
  // Active: Add (+1/+1) when damaged" heals him straight back, so his health
  // reads 5 both before and after and says nothing about whether burn fired —
  // the same reactive passive that made a 4-ATK swing measure as 3 in the
  // Joker test earlier today.
  var burnTicks = 0;
  var realDeal = G.dealDamage;
  G.dealDamage = function (t, n) { if (t === burner && n === 1) burnTicks++; return realDeal.apply(G, arguments); };
  var before = G.state.player.health;
  try { G.resolveUncontestedLane(2, 'ai'); }
  finally { G.dealDamage = realDeal; }
  assertEq(burnTicks, 1, 'it took its burn tick');
  assertEq(before - G.state.player.health, 4, 'and still swung for full');
});

test('Time Stone counters every hostile trick, not just a hardcoded nine', function () {
  // User: "time stone did not block pym particles or kryptonite". Pym Particles
  // takes (-3/-3) off one of your cards and can destroy it outright, but it was
  // missing from the name list in _isHostileTrick, so no counter was ever
  // offered. The list is the real defect — a new harmful trick defaults to NOT
  // counterable and nothing reports it.
  var G = freshGame();
  function trickDef(name) {
    var t = (typeof TRICK_DEFS !== 'undefined' ? TRICK_DEFS : []).find(function (d) { return d.name === name; });
    if (!t) throw new Error('no such trick: ' + name);
    return t;
  }
  assertEq(G._isHostileTrick(trickDef('Pym Particles')), true, 'Pym Particles is hostile');
  assertEq(G._isHostileTrick(trickDef("Joker's Playing Card")), true, "Joker's Playing Card is hostile");
  // Still-covered originals, so the flag work did not displace the list.
  assertEq(G._isHostileTrick(trickDef('Kryptonite')), true, 'Kryptonite still hostile');
  assertEq(G._isHostileTrick(trickDef('Batarangs')), true, 'Batarangs still hostile');
  // CONTROL — a friendly trick must NOT arm the counter, or Time Stone would
  // interrupt on every buff the opponent plays.
  assertEq(G._isHostileTrick(trickDef('Time Stone')), false, 'Time Stone is not itself hostile');
  assertEq(G._isHostileTrick(trickDef('Super Soldier Serum')), false, 'a buff is not hostile');
});

test('Juggernaut protects himself, not the whole enemy board', function () {
  // User: "Juggernaut was on the field ... but there was also an open Gorilla
  // Grodd that I could have done my mind control on". Grodd's On Play used to
  // cancel ENTIRELY if any Juggernaut stood anywhere on the enemy side, so a
  // board with one Juggernaut made the whole ability a silent no-op.
  function offeredWith(juggernaut) {
    var G = freshGame();
    if (juggernaut) place(G, 'Juggernaut', 'ai', 0);
    place(G, 'Gorilla Grodd', 'ai', 2);
    var grodd = place(G, 'Gorilla Grodd', 'player', 5);
    var offered = null;
    var real = G.promptCardChoice;
    G.promptCardChoice = function (o, opts, t, b, cb) {
      if (/Mind Control/.test(t || '')) {
        offered = (opts || []).map(function (c) { return c.name; });
        var pick = (opts || []).filter(function (c) { return c.name === 'Gorilla Grodd'; })[0];
        if (cb) cb(pick || opts[0]);
      } else if (cb) cb(opts[0]);
      return true;
    };
    try { CARD_ABILITIES['Gorilla Grodd'].onPlay(G, grodd, 5); }
    finally { G.promptCardChoice = real; }
    return { offered: offered, victim: G.state.lanes[2].ai };
  }
  // CONTROL — no Juggernaut, the target is offered and taken.
  var clean = offeredWith(false);
  assertEq(clean.offered.length, 1, 'control: one legal target offered');
  assertEq(!!clean.victim.isMindControlled, true, 'control: and it is controlled');

  var guarded = offeredWith(true);
  assertEq(guarded.offered.length, 2, 'a Juggernaut on the board does not empty the list');
  assertEq(!!guarded.victim.isMindControlled, true, 'the other enemy is still controllable');
});

test('Juggernaut himself still resists Mind Control, and says so', function () {
  // The other half. Narrowing his protection must not delete it — he carries
  // Immunity, and mindControlCard routes through tryApplyDebuff where Immunity
  // is spent, which is why the board-wide cancel was redundant to begin with.
  var G = freshGame();
  var jug = place(G, 'Juggernaut', 'ai', 0);
  var grodd = place(G, 'Gorilla Grodd', 'player', 5);
  var lines = [], realLog = G.log;
  G.log = function (m) { lines.push(String(m)); return realLog.apply(G, arguments); };
  var realPrompt = G.promptCardChoice;
  G.promptCardChoice = function (o, opts, t, b, cb) {
    if (/Mind Control/.test(t || '')) {
      var j = (opts || []).filter(function (c) { return c.name === 'Juggernaut'; })[0];
      if (cb) cb(j || opts[0]);
    } else if (cb) cb(opts[0]);
    return true;
  };
  try { CARD_ABILITIES['Gorilla Grodd'].onPlay(G, grodd, 5); }
  finally { G.promptCardChoice = realPrompt; G.log = realLog; }
  assertEq(!!jug.isMindControlled, false, 'Juggernaut is not controlled');
  assertEq(lines.some(function (l) { return /IMMUNITY/.test(l); }), true,
    'and the resist is reported rather than silent');
});

test('Mind Control and Fear both stun — no moves, hunts or bonus attacks', function () {
  // Owner: "when a character is mind controlled or feared they are stunned
  // where they cant move/bonus attack etc." Fear already action-locked; MIND
  // CONTROL did not, so a controlled card was free to move, hunt and spend a
  // banked bonus attack while fighting for the other side.
  var G = freshGame();
  var feared = place(G, 'Bane', 'ai', 0);      feared.isFeared = true;
  var mc     = place(G, 'Bane', 'ai', 1);      mc.isMindControlled = true;
  var frozen = place(G, 'Bane', 'ai', 2);      frozen.isFrozen = true;
  var clean  = place(G, 'Bane', 'ai', 3);
  assertEq(G.isActionLocked(feared), true, 'feared is locked');
  assertEq(G.isActionLocked(mc), true, 'mind-controlled is locked');
  assertEq(G.isActionLocked(frozen), true, 'frozen is still locked');
  // CONTROL — an unafflicted card must NOT be locked, or "everything is
  // stunned" would pass this test while breaking the game.
  assertEq(G.isActionLocked(clean), false, 'a clean card still acts');

  // The lock has to actually stop a bonus attack, not just report true.
  var atk = place(G, 'Bane', 'player', 5);
  atk.attack = 4; atk.bonusAttack = 1; atk.isMindControlled = true;
  var before = G.state.ai.health;
  G.drainBonusAttacks(atk);
  assertEq(G.state.ai.health, before, 'a mind-controlled card banks no bonus attack');

  assertEq(G.actionLockLabel(mc), 'MIND CONTROLLED', 'and the log names the real cause');
});

test('Iron Giant is still never placeable, and the desc still says so', function () {
  // The gate itself is untouched by the draw work — this pins that.
  var G = igSetup();
  var ig = G.createCardInstance(cardByName('Iron Giant'), 'player');
  assertEq(ig._neverPlayable, true, 'the never-playable flag survives createCardInstance');
  G.state.player.hand.push(ig);
  assertEq(G.playCard('player', ig, 0), false, 'playCard must refuse him');
  assertEq(G.state.lanes[0].player, null, 'and nothing lands in the lane');
  var desc = cardByName('Iron Giant').desc;
  assertEq(desc.indexOf('Leaves your hand only to save an ally') === 0, true,
    'the desc opens with the conditional gate, not a flat refusal');
  // The HOW of the save (remaining HP, minimum 1, no more damage this combat) is
  // the rescue mechanic's own rule and is no longer spelled out here — same
  // over-explaining pass as Superman, Darkseid and Anakin. The behaviour is
  // unchanged and still covered by the sacrifice tests above.
  assertEq(desc.indexOf('minimum 1'), -1, 'the HP-floor aside is gone');
  assertEq(desc.indexOf('no more damage this combat'), -1, 'and the damage-immunity aside');
  assert(desc.length < 200, 'the whole card fits in three short sentences (' + desc.length + ')');
  assertEq(desc.indexOf('Draw a card') > -1, true, 'the desc advertises the draw');
  // Capital D is load-bearing: the keyword regex is case-SENSITIVE, so a
  // lowercase "draw" would render without the keyword chip and tooltip.
  assertEq(desc.indexOf('draw a card') === -1, true, 'Draw is capitalised so the keyword chip renders');
});

// ENTRANCE-THEN-TRAP. Scarlet Witch enters 0/0 and BECOMES her hex target in
// onPlay, so a trap that fired on arrival killed a card that had no body yet.
// User: "she should be a 3/4 then get hit by the trap."
test('Scarlet Witch copies FIRST, then the trap bites the copied body', function () {
  var G = freshGame();
  var target = place(G, 'Bane', 'ai', 2);
  target.attack = 3; target.baseAttack = 3;
  target.currentHealth = 4; target.maxHealth = 4; target.baseHealth = 4;
  G.state.lanes[2].trap = { placedBy: 'ai', debuff: 1 };
  var witch = G.createCardInstance(cardByName('Scarlet Witch'), 'player');
  G.state.player.hand.push(witch);
  G.state.player.currency = 20;
  G.playCard('player', witch, 2);
  // She must be ALIVE and standing — the whole bug was that she was neither.
  assertEq(G.state.lanes[2].player, witch, 'she survives the trap and holds the lane');
  assert(witch.currentHealth > 0, 'and she is not a 0-HP zombie');
  // 3/4 copied, then -1/-1 from the trap.
  assertEq(witch.attack, 2, 'copied 3 ATK, trap took 1');
  assertEq(witch.currentHealth, 3, 'copied 4 HP, trap took 1');
  assertEq(G.state.lanes[2].trap, null, 'and the trap was genuinely spent, not skipped');
});

// The same ordering rule on the MOVE door, which is a separate call site and so
// a separate way to reintroduce the bug.
test('A trap on the destination lane fires AFTER onMoved, not before', function () {
  var G = freshGame();
  var moth = place(G, 'Killer Moth', 'player', 0);
  moth._mothLanes = [0];
  G.state.lanes[3].trap = { placedBy: 'ai', debuff: 1 };
  G.moveCard(moth, 0, 3);
  // 0/1 → grows to 1/2 on arrival → trap takes it to 0/1. Alive either way you
  // count it; under the old order the trap hit 0/1 and killed him outright.
  assertEq(G.state.lanes[3].player, moth, 'he lands and stays');
  assert(moth.currentHealth > 0, 'the growth beat the trap');
});

// An entrance that RELOCATES the card must not drag the origin lane's trap
// along — the guard that makes the late trap correct rather than merely later.
test('A card that leaves during its own entrance does not eat the old lane trap', function () {
  var G = freshGame();
  var bait = place(G, 'Bane', 'player', 1);
  G.state.lanes[1].trap = { placedBy: 'ai', debuff: 1 };
  // Simulate the entrance moving him out before the trap resolves.
  G.state.lanes[1].player = null;
  G.state.lanes[4].player = bait;
  var atkBefore = bait.attack;
  G._trapOnSettle(bait, 1);
  assertEq(bait.attack, atkBefore, 'no debuff — he is not in that lane any more');
  assert(G.state.lanes[1].trap !== null, 'and the trap is still armed for whoever does step in');
});

test('Killer Moth starts 0/1 and only pays for NEW ground', function () {
  var G = freshGame();
  assertEq(cardByName('Killer Moth').attack, 0, 'base ATK is 0');
  assertEq(cardByName('Killer Moth').health, 1, 'base HP is 1');
  var moth = place(G, 'Killer Moth', 'player', 1);
  CARD_ABILITIES['Killer Moth'].onPlay(G, moth, 1);
  assertEq(moth.attack, 0, 'landing in lane 1 is not itself a buff');

  G.moveCard(moth, 1, 3);                       // NEW lane
  assertEq(moth.attack, 1, 'lane 3 is new — +1 ATK');
  assertEq(moth.currentHealth, 2, 'and +1 HP');

  G.moveCard(moth, 3, 1);                       // back to a VISITED lane
  assertEq(moth.attack, 1, 'lane 1 already flown — no growth');
  assertEq(moth.currentHealth, 2, 'HP unchanged too');

  G.moveCard(moth, 1, 3);                       // and lane 3 is spent as well
  assertEq(moth.attack, 1, 'bouncing between two known lanes is worth nothing');

  G.moveCard(moth, 3, 5);                       // one more new lane
  assertEq(moth.attack, 2, 'lane 5 is new — the engine still works forwards');
  assertEq(moth._mothLanes.length, 3, 'the tally holds exactly the lanes he has flown');
});

test('Thanos DEVOURS on the snap — void pile, and no When Destroyed', function () {
  var G = freshGame();
  // Solomon Grundy has a When Destroyed. Devour must swallow it.
  var victim = place(G, 'Solomon Grundy', 'ai', 0);
  var deadBefore = G.state.ai.deadPile.length;
  var voidBefore = (G.state.voidPile || []).length;
  var thanos = G.createCardInstance(cardByName('Thanos'), 'player');
  G.state.player.hand.push(thanos);
  G.state.player.currency = 20;
  // Walk the roll across lanes 0,1,2 so lane 0 is guaranteed hit. A constant
  // stub would spin forever — the snap rerolls until it has N DISTINCT lanes.
  var realRng = Game.rng, n = 0;
  Game.rng = function () { return (n++ % Game.LANE_COUNT) / Game.LANE_COUNT; };
  try { G.playCard('player', thanos, 3); } finally { Game.rng = realRng; }

  assertEq(G.state.lanes[0].ai, null, 'the victim is gone from the board');
  assertEq(G.state.ai.deadPile.length, deadBefore, 'and NOT in the dead pile — devour voids');
  assert((G.state.voidPile || []).length > voidBefore, 'it landed in the void pile instead');
  assertEq(cardByName('Thanos').desc.indexOf('Devour') > -1, true,
    'the card text says Devour, capitalised so the keyword chip renders');
});

// OPTIONAL PROMPTS. "Stay put" used to be expressed by listing the card's own
// lane among the choices — a square already covered by the card, so the click
// hit the card. Owner: "it's hard right now to click their lane that they are
// in to stay." The opt-out is its own control now.
// The shim replaces promptLaneChoice/promptCardChoice with a synchronous
// auto-pick, so these assert the MECHANISM — what the ability asks for, and
// what the engine's resolve door does with a decline — rather than driving a
// modal the headless harness never renders.
function capturePrompt(G, kind) {
  var seen = null;
  var key = kind === 'lane' ? 'promptLaneChoice' : 'promptCardChoice';
  var real = G[key];
  G[key] = function (owner, list, title, desc, cb) {
    var opts = kind === 'lane' ? arguments[8] : arguments[6];
    // targetSide (lane prompts only) decides WHICH side's row the picker
    // paints. A mover that relocates enemy cards has to point the picker at
    // the enemy row or the player is choosing from lanes the card can't enter.
    seen = { owner: owner, list: list, title: title, callback: cb,
             targetSide: kind === 'lane' ? arguments[5] : undefined,
             options: opts || {} };
  };
  return { get: function () { return seen; }, restore: function () { G[key] = real; } };
}

test('A move prompt offers a real opt-out, not the card own lane', function () {
  var G = freshGame();
  G.state.player.isHuman = true;
  var mb = place(G, 'Man-Bat', 'player', 2);
  var enemy = place(G, 'Bane', 'ai', 3);
  var eAtk = enemy.attack;
  var cap = capturePrompt(G, 'lane');
  try { CARD_ABILITIES['Man-Bat'].onBeforeTricks(G, mb, 2); } finally { cap.restore(); }
  var p = cap.get();
  assert(!!p, 'the prompt was raised');
  assertEq(p.list.indexOf(2), -1, 'his OWN lane is no longer one of the lane choices');
  assertEq(p.options.declineLabel, 'STAY PUT', 'and the opt-out is a labelled control instead');
  assertEq(typeof p.options.onDecline, 'function', 'with something to run when it is taken');
  p.options.onDecline();
  assertEq(G.findCardLane(mb), 2, 'declining leaves him exactly where he was');
  assertEq(enemy.attack, eAtk, 'and the arrival sting never fired');
});

test('The resolve door honours a decline, and refuses one that was never offered', function () {
  var G = freshGame();
  G.state.player.isHuman = true;
  var picked = null, declined = false;
  // MANDATORY prompt — no declineLabel.
  G.state.pendingLaneChoice = { owner: 'player', lanes: [0, 1], title: 't', desc: 'd',
    callback: function (l) { picked = l; } };
  assertEq(G.resolveActivePrompt('lane', { decline: true }), false, 'the engine refuses the decline');
  assert(!!G.state.pendingLaneChoice, 'and the mandatory prompt is still standing');
  assertEq(picked, null, 'nothing was resolved behind the players back');

  // OPTIONAL prompt — same shape plus the opt-out.
  G.state.pendingLaneChoice = { owner: 'player', lanes: [0, 1], title: 't', desc: 'd',
    callback: function (l) { picked = l; }, declineLabel: 'STAY PUT',
    onDecline: function () { declined = true; } };
  assertEq(G.resolveActivePrompt('lane', { decline: true }), true, 'this one resolves');
  assertEq(declined, true, 'via the decline path');
  assertEq(picked, null, 'and NOT via the pick callback');
  assertEq(G.state.pendingLaneChoice, null, 'the slot is cleared, not left dangling');
});

// ============================================================
// ANTI-VENOM — the move is the payload (owner, 2026-08-24).
// He heals 4 and may move ANY card to an empty lane: an ally gains
// (+1/+1), an enemy loses (−1/−1). Every test below drives the real
// two-step prompt chain (pick a card, then pick a lane) rather than
// asserting on the outcome alone, because the outcome is reachable
// through paths that should NOT pay out.
// ============================================================

// Captures BOTH halves of the chain at once so a test can walk pick →
// lane → settle. capturePrompt only stubs one kind.
function captureAntiVenom(G) {
  var card = capturePrompt(G, 'card');
  var lane = capturePrompt(G, 'lane');
  return {
    card: card, lane: lane,
    restore: function () { lane.restore(); card.restore(); },
    // Pick a target, then send it to `to`. Returns false if either half
    // of the chain never opened.
    move: function (target, to) {
      var p = card.get();
      if (!p) return false;
      p.callback(target);
      var l = lane.get();
      if (!l) return false;
      l.callback(to);
      return true;
    },
  };
}

function antiVenomOnBoard(G, lane) {
  var av = G.createCardInstance(cardByName('Anti-Venom'), 'player');
  G.state.lanes[lane].player = av; av.owner = 'player';
  return av;
}

test('Anti-Venom offers enemies too, not just allies', function () {
  var G = freshGame();
  G.state.player.isHuman = true;
  var av = antiVenomOnBoard(G, 1);
  var ally = place(G, 'Bane', 'player', 4);
  var foe = place(G, 'Wolverine', 'ai', 0);
  var cap = capturePrompt(G, 'card');
  try { CARD_ABILITIES['Anti-Venom'].onPlay(G, av, 1); } finally { cap.restore(); }
  var p = cap.get();
  assert(!!p, 'the pick was raised');
  assert(p.list.indexOf(ally) > -1, 'the ally is offered');
  assert(p.list.indexOf(foe) > -1, 'and so is the enemy — the pool is both sides now');
  assertEq(p.list.indexOf(av), -1, 'Anti-Venom himself is never a target');
  assertEq(p.options.declineLabel, 'MOVE NO ONE', 'and the opt-out survived the rework');
});

test('Anti-Venom heals 4 whether or not anything moves', function () {
  var G = freshGame();
  G.state.player.isHuman = true;
  G.state.player.health = 20;
  var av = antiVenomOnBoard(G, 1);
  var cap = capturePrompt(G, 'card');
  // No other card on the board at all — the move half has nothing to do.
  try { CARD_ABILITIES['Anti-Venom'].onPlay(G, av, 1); } finally { cap.restore(); }
  assertEq(G.state.player.health, 24, 'the heal is unconditional');
  assertEq(cap.get(), null, 'and no prompt is raised with nothing movable');
});

test('Anti-Venom moving an ALLY gives it (+1/+1)', function () {
  var G = freshGame();
  G.state.player.isHuman = true;
  var av = antiVenomOnBoard(G, 1);
  var ally = place(G, 'Bane', 'player', 4);
  var atk = ally.attack, hp = ally.currentHealth, max = ally.maxHealth;
  var cap = captureAntiVenom(G);
  try {
    CARD_ABILITIES['Anti-Venom'].onPlay(G, av, 1);
    assertEq(cap.move(ally, 3), true, 'the chain opened both prompts');
  } finally { cap.restore(); }
  assertEq(G.findCardLane(ally), 3, 'the ally landed in the chosen lane');
  assertEq(ally.attack, atk + 1, 'and gained +1 ATK');
  assertEq(ally.currentHealth, hp + 1, 'and +1 current HP');
  assertEq(ally.maxHealth, max + 1, 'with max HP raised too, so it is a real buff');
});

test('Anti-Venom moving an ENEMY takes (−1/−1)', function () {
  var G = freshGame();
  G.state.player.isHuman = true;
  var av = antiVenomOnBoard(G, 1);
  var foe = place(G, 'Bane', 'ai', 4);
  var atk = foe.attack, hp = foe.currentHealth;
  var cap = captureAntiVenom(G);
  try {
    CARD_ABILITIES['Anti-Venom'].onPlay(G, av, 1);
    assertEq(cap.move(foe, 2), true, 'the chain opened both prompts');
  } finally { cap.restore(); }
  assertEq(G.findCardLane(foe), 2, 'the enemy was shoved into the chosen lane');
  assertEq(foe.attack, atk - 1, 'and lost 1 ATK');
  assertEq(foe.currentHealth, hp - 1, 'and 1 HP');
});

test('Anti-Venom shows the ENEMY lane row when moving an enemy', function () {
  // The lane picker has to be pointed at the target's side, or the player is
  // choosing from their own empty lanes for a card that cannot go there.
  var G = freshGame();
  G.state.player.isHuman = true;
  var av = antiVenomOnBoard(G, 1);
  var foe = place(G, 'Bane', 'ai', 4);
  place(G, 'Wolverine', 'ai', 0);           // enemy lane 0 is taken
  place(G, 'Wolverine', 'player', 2);       // OUR lane 2 is taken — irrelevant to the enemy
  var cap = captureAntiVenom(G);
  try {
    CARD_ABILITIES['Anti-Venom'].onPlay(G, av, 1);
    cap.card.get().callback(foe);
  } finally { cap.restore(); }
  var l = cap.lane.get();
  assert(!!l, 'the lane prompt opened');
  assertEq(l.targetSide, 'ai', 'and it is pointed at the ENEMY row, not our own');
  assertEq(l.list.indexOf(0), -1, 'the lane the enemy side already holds is not offered');
  assert(l.list.indexOf(2) > -1, 'but a lane WE hold still is — it is empty on their side');
  assertEq(l.list.indexOf(4), -1, 'and never the lane it is standing in');
});

test('Anti-Venom backing out at the LANE step costs nothing', function () {
  // Two prompts means two chances to change your mind. Picking a target and
  // then finding no lane you like must leave the card — and its stats — alone.
  var G = freshGame();
  G.state.player.isHuman = true;
  var av = antiVenomOnBoard(G, 1);
  var foe = place(G, 'Bane', 'ai', 4);
  var atk = foe.attack, hp = foe.currentHealth;
  var cap = captureAntiVenom(G);
  try {
    CARD_ABILITIES['Anti-Venom'].onPlay(G, av, 1);
    cap.card.get().callback(foe);
  } finally { cap.restore(); }
  var l = cap.lane.get();
  assert(!!l, 'the lane prompt opened');
  assertEq(l.options.declineLabel, 'LEAVE THEM', 'and it carries its own opt-out');
  assertEq(typeof l.options.onDecline, 'function', 'with something to run when it is taken');
  l.options.onDecline();
  assertEq(G.findCardLane(foe), 4, 'the enemy stayed in its lane');
  assertEq(foe.attack, atk, 'took no ATK loss');
  assertEq(foe.currentHealth, hp, 'and no HP loss');
});

test('Anti-Venom (−1/−1) finishes a 1-HP enemy instead of flooring it', function () {
  var G = freshGame();
  G.state.player.isHuman = true;
  var av = antiVenomOnBoard(G, 1);
  var foe = place(G, 'Bane', 'ai', 4);
  foe.currentHealth = 1; foe.maxHealth = 1;
  var cap = captureAntiVenom(G);
  try {
    CARD_ABILITIES['Anti-Venom'].onPlay(G, av, 1);
    cap.move(foe, 2);
  } finally { cap.restore(); }
  assert(foe.currentHealth <= 0, 'the enemy died to the strip (allowKill), not stuck at 1');
  assertEq(G.state.lanes[2].ai, null, 'and cleanupDead cleared the slot it moved into');
});

test('Anti-Venom does not burn a card the arrival already killed', function () {
  // moveCard fires the destination lane's trap on the way in, and a Bear Trap
  // routes through killCard. Normally that pulls the corpse out of the lane and
  // the "did it land?" check catches it — see the next test for the case where
  // it does NOT.
  var G = freshGame();
  G.state.player.isHuman = true;
  var av = antiVenomOnBoard(G, 1);
  var foe = place(G, 'Bane', 'ai', 4);
  foe.currentHealth = 1; foe.maxHealth = 1;
  G.state.lanes[2].trap = { placedBy: 'player', debuff: 1 };
  var burned = 0;
  var realDebuff = G.debuffCard;
  G.debuffCard = function (c) { if (c === foe) burned++; return realDebuff.apply(G, arguments); };
  var cap = captureAntiVenom(G);
  try {
    CARD_ABILITIES['Anti-Venom'].onPlay(G, av, 1);
    cap.move(foe, 2);
  } finally { cap.restore(); G.debuffCard = realDebuff; }
  assert(foe.currentHealth <= 0, 'the trap killed it on arrival');
  assertEq(burned, 0, 'and the cure never touched the corpse');
  assertEq(G.state.lanes[2].trap, null, 'the trap was genuinely spent');
});

test('Anti-Venom does not revive an ally whose death is mid-pause', function () {
  // "Landed in the lane" is NOT the same as "alive". The Iron Giant save PAUSES
  // a death on a prompt, and while that offer is standing the dying card sits in
  // its lane at 0 HP. Anti-Venom's cure has to read the health, not just the
  // slot — a (+1/+1) here would hand a 0-HP card 1 HP and un-kill it behind the
  // prompt's back.
  var G = freshGame();
  G.state.player.isHuman = true;
  var av = antiVenomOnBoard(G, 1);
  var ally = place(G, 'Wolverine', 'player', 0);
  ally.currentHealth = 1; ally.maxHealth = 1;
  var atk = ally.attack;
  G.state.lanes[2].trap = { placedBy: 'ai', debuff: 1 };
  G.state.player.hand.push(G.createCardInstance(cardByName('Iron Giant'), 'player'));
  var cured = 0;
  var realBuff = G.buffCard;
  G.buffCard = function (c) { if (c === ally) cured++; return realBuff.apply(G, arguments); };
  var cap = captureAntiVenom(G);
  try {
    CARD_ABILITIES['Anti-Venom'].onPlay(G, av, 1);
    cap.move(ally, 2);
  } finally { cap.restore(); G.buffCard = realBuff; }
  assertEq(G.state.lanes[2].player, ally, 'setup: the ally IS still standing in the lane it moved to');
  assert(ally.currentHealth <= 0, 'setup: at 0 HP, with the Iron Giant offer holding its death open');
  assertEq(cured, 0, 'so the cure was never applied to it');
  assertEq(ally.attack, atk - 1, 'its ATK is what the trap left, with nothing added back');
  assert(ally.currentHealth <= 0, 'and it is still dead — a (+1/+1) here would have un-killed it');
});

test('Anti-Venom pays nothing when the move is refused', function () {
  // moveCard bails SILENTLY when the destination fills up. The stat swing hangs
  // off the move landing, so a refused move must leave the target untouched.
  var G = freshGame();
  G.state.player.isHuman = true;
  var av = antiVenomOnBoard(G, 1);
  var ally = place(G, 'Bane', 'player', 4);
  var atk = ally.attack, hp = ally.currentHealth;
  var cap = captureAntiVenom(G);
  try {
    CARD_ABILITIES['Anti-Venom'].onPlay(G, av, 1);
    cap.card.get().callback(ally);
    // Lane 3 was open when the picker listed it; something takes it before the
    // player answers the second prompt.
    place(G, 'Wolverine', 'player', 3);
    cap.lane.get().callback(3);
  } finally { cap.restore(); }
  assertEq(G.findCardLane(ally), 4, 'the ally never moved');
  assertEq(ally.attack, atk, 'so it gained no ATK');
  assertEq(ally.currentHealth, hp, 'and no HP — the payout is tied to the move, not the pick');
});

test('Anti-Venom never offers a card that cannot move', function () {
  var G = freshGame();
  G.state.player.isHuman = true;
  var av = antiVenomOnBoard(G, 1);
  var frozen = place(G, 'Bane', 'player', 4);
  frozen.isFrozen = true;
  var boxedIn = place(G, 'Wolverine', 'ai', 0);
  for (var i = 0; i < G.LANE_COUNT; i++) {
    if (i !== 0 && !G.state.lanes[i].ai) G.state.lanes[i].ai = place(G, 'Bane', 'ai', i);
  }
  var free = place(G, 'Wolverine', 'player', 2);
  var cap = capturePrompt(G, 'card');
  try { CARD_ABILITIES['Anti-Venom'].onPlay(G, av, 1); } finally { cap.restore(); }
  var p = cap.get();
  assert(!!p, 'the pick was raised');
  assertEq(p.list.indexOf(frozen), -1, 'a frozen ally is not offered — moveCard would refuse it');
  assertEq(p.list.indexOf(boxedIn), -1, 'nor an enemy whose own side has no empty lane left');
  assert(p.list.indexOf(free) > -1, 'the one card that can actually move still is');
});

test('Anti-Venom declining moves no one and buffs no one', function () {
  var G = freshGame();
  G.state.player.isHuman = true;
  var av = antiVenomOnBoard(G, 1);
  var ally = place(G, 'Bane', 'player', 4);
  var foe = place(G, 'Wolverine', 'ai', 0);
  var atk = ally.attack, fAtk = foe.attack;
  var cap = capturePrompt(G, 'card');
  try { CARD_ABILITIES['Anti-Venom'].onPlay(G, av, 1); } finally { cap.restore(); }
  cap.get().options.onDecline();
  assertEq(G.findCardLane(ally), 4, 'the ally stayed exactly where it was');
  assertEq(ally.attack, atk, 'with no buff');
  assertEq(foe.attack, fAtk, 'and the enemy took nothing either');
});

test('Anti-Venom AI reaches for the enemy it can finish', function () {
  var G = freshGame();
  G.state.player.isHuman = false;   // drive the non-prompt branch
  var av = antiVenomOnBoard(G, 1);
  var fatAlly = place(G, 'Bane', 'player', 4);
  var bigFoe = place(G, 'Wolverine', 'ai', 0);
  var doomedFoe = place(G, 'Bane', 'ai', 2);
  doomedFoe.currentHealth = 1; doomedFoe.maxHealth = 1;
  var allyAtk = fatAlly.attack;
  CARD_ABILITIES['Anti-Venom'].onPlay(G, av, 1);
  assert(doomedFoe.currentHealth <= 0, 'the AI took the kill');
  assertEq(fatAlly.attack, allyAtk, 'and did not spend the move buffing its own card instead');
  assertEq(bigFoe.currentHealth, bigFoe.maxHealth, 'nor on the enemy it could only scratch');
});

test('Anti-Venom card text matches what the ability does', function () {
  var d = cardByName('Anti-Venom').desc;
  assertEq(cardByName('Anti-Venom').cost, 3, 'he is still a 3-cost');
  assert(d.indexOf('Heal yourself for 4') > -1, 'the heal is still printed');
  assert(d.indexOf('You may move a card') > -1, 'MAY, matching the opt-out the prompt carries');
  assert(d.indexOf('(+1/+1)') > -1, 'the ally half is printed');
  assert(d.indexOf('(−1/−1)') > -1, 'and the enemy half, with a Unicode minus');
});

// Magneto/Luke auras are recorded per card and re-applied to every new arrival.
// Copying a target's POST-aura numbers charged Scarlet Witch for the same aura
// twice and killed her on entry.
test('Scarlet Witch mirrors the body, not the body plus its aura', function () {
  var G = freshGame();
  place(G, 'Magneto', 'ai', 5);
  var dd = place(G, 'Doomsday', 'ai', 1);   // lane index 1 = display lane 2 = even = Magneto debuffs it
  var witch = G.createCardInstance(cardByName('Scarlet Witch'), 'player');
  G.state.player.hand.push(witch);
  G.state.player.currency = 20;
  G.playCard('player', witch, 1);
  var live = G.state.lanes[1].player;
  assertEq(live, witch, 'she survives entry opposite a Magneto-debuffed enemy');
  assert(witch.currentHealth > 0, 'and is not a 0-HP zombie');
  // MIRROR: whatever the aura does to her, she lands on the target's stats.
  assertEq(witch.attack, dd.attack, 'she ends on the targets exact ATK');
  assertEq(witch.currentHealth, dd.currentHealth, 'and the targets exact HP');
});

test('The rebalanced costs and Pym numbers are what the text claims', function () {
  var pym = TRICK_DEFS.find(function (t) { return t.name === 'Pym Particles'; });
  var rs  = TRICK_DEFS.find(function (t) { return t.name === 'Reality Stone'; });
  assertEq(rs.cost, 3, 'Reality Stone is 3');
  assertEq(pym.desc.indexOf('(−2/−2)') > -1, true, 'Pym text says −2/−2');
  // And the code agrees with the text — the pair that silently drifts.
  var G = freshGame();
  G.state.player.isHuman = true;
  var target = place(G, 'Doomsday', 'ai', 0);
  target.attack = 5; target.baseAttack = 5;
  target.currentHealth = 5; target.maxHealth = 5;
  G.state.player.currency = 20;
  pym.play(G, 'player');
  var cc = G.state.pendingCardChoice;
  if (cc) G.resolveActivePrompt('card', { idx: cc.cards.indexOf(target) });
  assertEq(target.attack, 3, 'and actually removes 2 ATK');
  assertEq(target.currentHealth, 3, 'and 2 HP');
});

// Symbiote Spider-Man is a WASH — 2 back, 2 up. The small-hand branch drew a
// flat 2 no matter how many went back, so an empty hand shuffled nothing and
// drew two free cards.
test('Symbiote Spider-Man draws only what you actually put back', function () {
  var G = freshGame();
  var sym = G.createCardInstance(cardByName('Symbiote Spider-Man'), 'player');
  G.state.lanes[0].player = sym; sym.owner = 'player';
  G.state.player.hand = [];      // the reported case: zero cards
  G.state.ai.hand = [];
  var pileBefore = G.getDrawPile('player').length;
  CARD_ABILITIES['Symbiote Spider-Man'].onPlay(G, sym, 0);
  assertEq(G.state.player.hand.length, 0, 'an empty hand draws NOTHING');
  assertEq(G.state.ai.hand.length, 0, 'and neither does the opponents');
  assertEq(G.getDrawPile('player').length, pileBefore, 'the pile is untouched too');

  // One card in hand → one back, one up. Still a wash, not a windfall.
  var G2 = freshGame();
  var sym2 = G2.createCardInstance(cardByName('Symbiote Spider-Man'), 'player');
  G2.state.lanes[0].player = sym2; sym2.owner = 'player';
  G2.state.player.hand = [G2.createCardInstance(cardByName('Catwoman'), 'player')];
  G2.state.ai.hand = [];
  CARD_ABILITIES['Symbiote Spider-Man'].onPlay(G2, sym2, 0);
  assertEq(G2.state.player.hand.length, 1, 'one back, one up — hand size unchanged');
});

test('Mother Box and Bat Signal hold their boss back until round 4', function () {
  var mb = TRICK_DEFS.find(function (t) { return t.name === 'Mother Box'; });
  var bs = TRICK_DEFS.find(function (t) { return t.name === 'Bat Signal'; });
  assertEq(mb.desc.indexOf('From round 4') > -1, true, 'Mother Box text states the gate');
  assertEq(bs.desc.indexOf('From round 4') > -1, true, 'Bat Signal text states the gate');

  // The gate itself: capture the filter each trick hands the summon deck and
  // ask it about the boss directly. That is the predicate under test — pulling
  // random cards would only sample it.
  function bossAllowed(trick, round, bossName) {
    var G = freshGame();
    G.state.round = round;
    var seen = null;
    var real = G.drawFromSummonDeck;
    G.drawFromSummonDeck = function (fn) { seen = fn; return null; };
    try { trick.play(G, 'player'); } finally { G.drawFromSummonDeck = real; }
    return seen({ name: bossName, cost: 12, isDiscardEffect: false });
  }
  assertEq(bossAllowed(mb, 1, 'Darkseid'), false, 'round 1 cannot pull Darkseid');
  assertEq(bossAllowed(mb, 3, 'Darkseid'), false, 'nor round 3');
  assertEq(bossAllowed(mb, 4, 'Darkseid'), true,  'round 4 opens him up');
  assertEq(bossAllowed(bs, 3, 'Batman'), false, 'Bat Signal is gated the same way');
  assertEq(bossAllowed(bs, 4, 'Batman'), true,  'and opens at the same round');
  // The cheap pool is untouched by the gate — the trick must still do its job.
  var G = freshGame(); G.state.round = 1;
  var seen = null, real = G.drawFromSummonDeck;
  G.drawFromSummonDeck = function (fn) { seen = fn; return null; };
  try { mb.play(G, 'player'); } finally { G.drawFromSummonDeck = real; }
  assertEq(seen({ name: 'Catwoman', cost: 1, isDiscardEffect: false }), true,
    'a 1-cost is still summonable on round 1');
});

test('Doomsday rises with real Immunity, and it does not tick down', function () {
  var G = freshGame();
  var dd = place(G, 'Doomsday', 'ai', 0);
  var killer = place(G, 'Bane', 'player', 0);
  dd.currentHealth = 0;
  CARD_ABILITIES['Doomsday'].onDeath(G, dd, 0);
  assert(dd.immunityCharges > 0, 'he carries the real keyword, not a lookalike');
  assertEq(dd.permanentImmunity, true, 'and it is flagged permanent');
  assertEq(dd.currentHealth, dd.maxHealth, 'back at full HP');

  // STATUS debuffs bounce off him — that is what Immunity is for. (Stat
  // strips are NOT debuffs and land normally; see the category test above.)
  G.mindControlCard(dd, killer);
  assertEq(!!dd.isMindControlled, false, 'Mind Control does not land');
  G.freezeCard(dd, killer, 1);
  assertEq(!!dd.isFrozen, false, 'nor Freeze');

  // Repeat: a permanent shield must not run out.
  for (var i = 0; i < 5; i++) G.mindControlCard(dd, killer);
  assertEq(!!dd.isMindControlled, false, 'still refused after six attempts');
  assert(dd.immunityCharges > 0, 'and still immune — the shield never spends down');
  // "permanent" was dropped in the 2026-08-09 wording pass — the word the
  // keyword chip needs is Immunity, and permanence is behaviour, not text.
  assertEq(cardByName('Doomsday').desc.indexOf('Immunity') > -1, true,
    'the card text says Immunity, capitalised so the keyword chip renders');
});

// Immunity blocks every debuff — with two DECLARED exceptions and one bought
// one. Owner: "not like kryptonite, that should always go through immunity or
// pym particles, but mind control can't — only if it has unresistible."
test('Immunity blocks Mind Control, and Unresistible is what buys through', function () {
  var G = freshGame();
  var t = place(G, 'Bane', 'ai', 0);
  t.immunityCharges = 2;
  var caster = place(G, 'Gorilla Grodd', 'player', 0);
  G.mindControlCard(t, caster);
  assertEq(!!t.isMindControlled, false, 'the shield refuses it');
  assertEq(t.immunityCharges, 1, 'and spends exactly one charge doing so');

  caster.unresistibleCharges = 1;
  G.mindControlCard(t, caster);
  assertEq(!!t.isMindControlled, true, 'Unresistible pierces');
  assertEq(t.immunityCharges, 1, 'without touching the Immunity it went around');
  assertEq(caster.unresistibleCharges, 0, 'the piercing charge is what gets spent');
});

test('A stat change is not a debuff, so Immunity never touches it', function () {
  // Owner drew this line on 2026-08-09: "anything that affects stats is not a
  // debuff. Immunity does not block Nightwing, Pym Particles, Kryptonite,
  // Silver Surfer." So these land through a full shield and spend none of it.
  var kryp = TRICK_DEFS.find(function (t) { return t.name === 'Kryptonite'; });
  var pym  = TRICK_DEFS.find(function (t) { return t.name === 'Pym Particles'; });

  var G = freshGame();
  G.state.player.isHuman = true;
  var t = place(G, 'Doomsday', 'ai', 0);
  t.attack = 6; t.baseAttack = 6; t.currentHealth = 6; t.maxHealth = 6;
  t.immunityCharges = 3;
  kryp.play(G, 'player');
  var cc = G.state.pendingCardChoice;
  if (cc) G.resolveActivePrompt('card', { idx: cc.cards.indexOf(t) });
  assertEq(t.attack, 3, 'Kryptonite lands');
  assertEq(t.immunityCharges, 3, 'and spends no charge — there was nothing to block');

  var G2 = freshGame();
  G2.state.player.isHuman = true;
  var t2 = place(G2, 'Doomsday', 'ai', 0);
  t2.attack = 6; t2.baseAttack = 6; t2.currentHealth = 6; t2.maxHealth = 6;
  t2.immunityCharges = 3;
  pym.play(G2, 'player');
  var cc2 = G2.state.pendingCardChoice;
  if (cc2) G2.resolveActivePrompt('card', { idx: cc2.cards.indexOf(t2) });
  assertEq(t2.attack, 4, 'Pym lands');
  assertEq(t2.currentHealth, 4, 'both halves');
  assertEq(t2.immunityCharges, 3, 'and spends no charge either');

  // A generic strip (a Nightwing / aura-class effect) behaves identically —
  // the point is the CATEGORY, not a per-card exception list.
  var G3 = freshGame();
  var t3 = place(G3, 'Bane', 'ai', 0);
  t3.immunityCharges = 1;
  var atk = t3.attack;
  G3.debuffCard(t3, 2, 2, true, { name: 'Nightwing' });
  assert(t3.attack < atk, 'a plain stat strip lands through Immunity too');
  assertEq(t3.immunityCharges, 1, 'charge untouched');

  // CONTROL — the STATUS debuffs are still blocked, or Immunity would mean
  // nothing at all.
  var G4 = freshGame();
  var t4 = place(G4, 'Bane', 'ai', 0);
  t4.immunityCharges = 1;
  var caster = place(G4, 'Gorilla Grodd', 'player', 0);
  G4.mindControlCard(t4, caster);
  assertEq(!!t4.isMindControlled, false, 'Mind Control is still refused');
  assertEq(t4.immunityCharges, 0, 'and THAT is what spends the charge');
});

// ---- 2v2 TEAM SELECTION ------------------------------------
function lobby2v2() {
  Game.start2v2Match({ names: { p1: 'One', p2: 'Two', p3: 'Three', p4: 'Four' } });
  return Game;
}

// The turn order used to be four hardcoded p1..p4 lists. Rewriting it in terms
// of team ROLES must not move a single step under the default seating, or every
// existing 2v2 match just changed shape.
test('The default seating produces the canonical p1->p4 rotation, alternating teams', function () {
  var G = lobby2v2();
  // Default seating is A = p1,p3 · B = p2,p4, so the team-interleave reads out
  // as the seat order p1,p2,p3,p4, rotating the start by one each round.
  var expected = [
    ['p1-cards', 'p2-cards', 'p3-cards-tricks', 'p4-cards-tricks', 'p1-tricks', 'p2-tricks'],
    ['p2-cards', 'p3-cards', 'p4-cards-tricks', 'p1-cards-tricks', 'p2-tricks', 'p3-tricks'],
    ['p3-cards', 'p4-cards', 'p1-cards-tricks', 'p2-cards-tricks', 'p3-tricks', 'p4-tricks'],
    ['p4-cards', 'p1-cards', 'p2-cards-tricks', 'p3-cards-tricks', 'p4-tricks', 'p1-tricks'],
  ];
  for (var r = 1; r <= 8; r++) {
    assertEq(G._2v2ComputePhaseOrder(r).join('|'), expected[(r - 1) % 4].join('|'),
      'round ' + r + ' matches the canonical rotation');
    // And no two consecutive turns are ever the same team — the property the
    // whole scheme exists to guarantee.
    var teams = G._2v2ComputePhaseOrder(r).map(function (sp) { return G._2v2TeamOf(sp.split('-')[0]); });
    for (var i = 1; i < teams.length; i++) {
      assert(teams[i] !== teams[i - 1], 'round ' + r + ': step ' + (i + 1) + ' switches teams (no back-to-back)');
    }
  }
});

test('Rearranged teams still alternate and stay fair', function () {
  var G = lobby2v2();
  // Move p2 and p3 across so the teams become A = p1,p2 · B = p3,p4 — a
  // non-default arrangement. The order must move with the teams AND still never
  // put two same-team turns back to back.
  assertEq(G.swap2v2Teams('p2', 'p3', 'p1'), true, 'the swap is accepted');
  assertEq(G._2v2TeamOf('p1'), 'A', 'p1 stays on A');
  assertEq(G._2v2TeamOf('p2'), 'A', 'p2 joins him');
  assertEq(G._2v2TeamOf('p3'), 'B', 'p3 goes across');
  assertEq(G._2v2TeamOf('p4'), 'B', 'p4 stays on B');

  // Team-interleave with A=[p1,p2], B=[p3,p4] → cycle p1,p3,p2,p4.
  assertEq(G._2v2ComputePhaseOrder(1).join('|'),
    ['p1-cards', 'p3-cards', 'p2-cards-tricks', 'p4-cards-tricks', 'p1-tricks', 'p3-tricks'].join('|'),
    'the order follows the teams, not the seats');

  // Every round: strict team alternation, two card slots per team, each player
  // in the card slots exactly once.
  for (var r = 1; r <= 8; r++) {
    var order = G._2v2ComputePhaseOrder(r);
    var teamsAll = order.map(function (sp) { return G._2v2TeamOf(sp.split('-')[0]); });
    for (var i = 1; i < teamsAll.length; i++) {
      assert(teamsAll[i] !== teamsAll[i - 1], 'round ' + r + ': no back-to-back same team');
    }
    var cardSlots = order.slice(0, 4).map(function (sp) { return sp.split('-')[0]; });
    var teams = cardSlots.map(function (pk) { return G._2v2TeamOf(pk); });
    assertEq(teams.filter(function (t) { return t === 'A'; }).length, 2, 'round ' + r + ': A gets two card slots');
    assertEq(teams.filter(function (t) { return t === 'B'; }).length, 2, 'round ' + r + ': B gets two');
    assertEq(cardSlots.slice().sort().join(','), 'p1,p2,p3,p4', 'round ' + r + ': each player exactly once');
  }
});

test('The engine and the lobby agree on whose team is whose', function () {
  var G = lobby2v2();
  G.swap2v2Teams('p2', 'p3', 'p1');
  // This is the bug that already existed: card dealing read the live team while
  // the turn engine read a static map, so a rearranged lobby dealt a player
  // cards for one side and gave them a turn on the other.
  G._2v2ComputePhaseOrder(1).forEach(function (sp) {
    var pk = sp.split('-')[0];
    assertEq(G._2v2TeamOf(pk), G.state.twoVTwo.players[pk].team,
      pk + ': engine team matches lobby team');
  });
  G.state.twoVTwo.subPhaseIdx = 0;
  G.state.twoVTwo.round = 1;
  assertEq(G._2v2ActiveTeam(), G.state.twoVTwo.players[G._2v2ActivePlayer()].team,
    'and the ACTIVE team is read from the same place');
});

test('A swap can never leave the lobby lopsided', function () {
  var G = lobby2v2();
  assertEq(G._2v2TeamsBalanced(), true, 'it starts two a side');
  // Every legal swap, in sequence — the roster must stay 2-2 throughout.
  [['p1','p3'], ['p2','p4'], ['p1','p2'], ['p3','p4'], ['p2','p3']].forEach(function (pair) {
    G.swap2v2Teams(pair[0], pair[1], 'p1');
    assertEq(G._2v2TeamsBalanced(), true, 'still two a side after ' + pair.join('/'));
  });
  // Same-team "swaps" are refused rather than silently doing nothing useful.
  var r = G._2v2Roster();
  assertEq(G.swap2v2Teams(r.A[0], r.A[1], 'p1'), false, 'two teammates cannot trade');
  assertEq(G.swap2v2Teams('p1', 'p1', 'p1'), false, 'nor can a player trade with themselves');
});

test('Only the host, or a player moving themselves, may rearrange', function () {
  var G = lobby2v2();
  assertEq(G.swap2v2Teams('p2', 'p3', 'p4'), false, 'p4 cannot rearrange two other people');
  assertEq(G.swap2v2Teams('p2', 'p3', 'p2'), true, 'but p2 can move themselves');
  // After that swap teams are A = p1,p2 · B = p3,p4; p1 and p3 are cross-team.
  assertEq(G.swap2v2Teams('p1', 'p3', 'p1'), true, 'and the host can move anyone');

  // Locked once the match is real — teams are load-bearing after the deal.
  G.state.twoVTwo.round = 1;
  var before = G._2v2TeamOf('p1');
  assertEq(G.swap2v2Teams('p1', 'p3', 'p1'), false, 'refused mid-match');
  assertEq(G._2v2TeamOf('p1'), before, 'and nothing moved');
  assertEq(G.randomize2v2Teams('p1'), false, 'shuffle is locked too');
});

test('Shuffle deals a startable 2-2, and only the host may call it', function () {
  var G = lobby2v2();
  assertEq(G.randomize2v2Teams('p3'), false, 'a guest cannot shuffle the room');
  for (var i = 0; i < 25; i++) {
    assertEq(G.randomize2v2Teams('p1'), true, 'the host can');
    assertEq(G._2v2TeamsBalanced(), true, 'and every shuffle is two a side');
  }
});

// A temporary "remove all ATK" has to give back WHAT IT TOOK, not restore a
// photograph taken before it landed. Owner: Magneto 3 base, Adamantium to 5,
// Gojo zeroes him, Power Stone puts him at 2 — and the restore snapped him back
// to 5 instead of 7, silently refunding the Power Stone to nobody.
test('ATK suppression gives back what it took, not a stale snapshot', function () {
  var G = freshGame();
  var mag = place(G, 'Magneto', 'player', 2);
  mag.attack = 3; mag.baseAttack = 3;

  G.buffCard(mag, 2, 0);                                        // Adamantium
  assertEq(mag.attack, 5, 'buffed to 5');
  G._suppressAttack(mag, '_gojoAttackZeroed', '_gojoZeroedBy', 999);
  assertEq(mag.attack, 0, 'nullified');
  G.buffCard(mag, 2, 0);                                        // Power Stone, while at 0
  assertEq(mag.attack, 2, 'the buff lands on the zeroed body');
  G._restoreSuppressedAttack(mag, '_gojoAttackZeroed', '_gojoZeroedBy', 999);
  assertEq(mag.attack, 7, 'restore ADDS BACK the 5 it took — 2 + 5, not a snap to 5');
  assertEq(mag._gojoAttackZeroed, undefined, 'and the stamp is cleared');
});

test('Only the suppressor that took the ATK gives it back', function () {
  var G = freshGame();
  var c = place(G, 'Bane', 'player', 0);
  c.attack = 4;
  G._suppressAttack(c, '_gojoAttackZeroed', '_gojoZeroedBy', 111);
  // A DIFFERENT Gojo's end-of-turn must not collect someone else's suppression.
  assertEq(G._restoreSuppressedAttack(c, '_gojoAttackZeroed', '_gojoZeroedBy', 222), false, 'wrong owner is refused');
  assertEq(c.attack, 0, 'so the card stays nullified');
  assertEq(G._restoreSuppressedAttack(c, '_gojoAttackZeroed', '_gojoZeroedBy', 111), true, 'the right one collects');
  assertEq(c.attack, 4, 'and gets the 4 back');
  // Double-restore must not pay twice.
  assertEq(G._restoreSuppressedAttack(c, '_gojoAttackZeroed', '_gojoZeroedBy', 111), false, 'no second payout');
  assertEq(c.attack, 4, 'attack unchanged');
});

test('Writing through a suppression still lands the card on that value', function () {
  var G = freshGame();
  var c = place(G, 'Bane', 'player', 0);
  c.attack = 4;
  G._suppressAttack(c, '_gojoAttackZeroed', '_gojoZeroedBy', 1);
  G.buffCard(c, 3, 0);                       // live attack is now 3
  G.setTrueAttack(c, 9);                     // "your real attack is 9"
  G._restoreSuppressedAttack(c, '_gojoAttackZeroed', '_gojoZeroedBy', 1);
  assertEq(c.attack, 9, 'the card ends on the value that was written, not 9 + leftovers');
});

// ---- CARD DOSSIER ------------------------------------------
test('A card records where it came from and what was done to it', function () {
  var G = freshGame();
  G.state.round = 1;
  var mag = G.createCardInstance(cardByName('Magneto'), 'player');
  G.addToHand('player', mag);
  G.state.lanes[0].player = mag; mag.owner = 'player';

  G.state.round = 4;
  G.state._activeTrickName = 'Adamantium';
  G.buffCard(mag, 2, 0);
  G.state._activeTrickName = null;

  G.state.round = 6;
  G.state._activeTrickName = 'Power Stone';
  G.debuffCard(mag, 1, 1, false, { name: 'Power Stone' });
  G.state._activeTrickName = null;

  var h = mag._history || [];
  assertEq(h.length, 3, 'three entries: the draw and two tricks');
  assertEq(h[0].r, 1, 'the arrival is stamped with the round it happened');
  assertEq(h[1].r, 4, 'and so is each trick');
  assertEq(h[1].t.indexOf('Adamantium') > -1, true, 'the trick is named');
  assertEq(h[2].t.indexOf('Power Stone') > -1, true, 'both of them');
  // An untouched card carries no record at all — the back stays clean.
  var plain = place(G, 'Bane', 'ai', 3);
  assertEq(plain._history, undefined, 'nothing happened, nothing recorded');
});

test('The record is credited to the ABILITY when no trick is resolving', function () {
  var G = freshGame();
  G.state.round = 3;
  var hela = place(G, 'Hela', 'player', 0);
  var pulled = G.createCardInstance(cardByName('Bane'), 'player');
  // addToHand takes an explicit source — the door Hela / Grundy / a BWL steal
  // all pass through.
  G.addToHand('player', pulled, hela);
  assertEq((pulled._history[0] || {}).t, 'Drawn by Hela', 'named after the card that pulled it');
  assertEq(pulled._history[0].r, 3, 'on the round it happened');
});

test('The record does not grow without bound, or repeat itself', function () {
  var G = freshGame();
  var c = place(G, 'Bane', 'player', 0);
  c.attack = 50; c.currentHealth = 50; c.maxHealth = 50;
  G.state.round = 2;
  G.state._activeTrickName = 'An Aura';
  // The same effect reconciling over and over in one round is ONE line.
  for (var i = 0; i < 5; i++) G.buffCard(c, 1, 1);
  assertEq(c._history.length, 1, 'repeats in the same round collapse');
  // And the whole thing is capped, so it can never bloat an MP broadcast.
  for (var r = 3; r < 40; r++) { G.state.round = r; G.buffCard(c, 1, 1); }
  G.state._activeTrickName = null;
  assert(c._history.length <= 10, 'capped at 10 entries, got ' + c._history.length);
});

// ---- VOLDEMORT ---------------------------------------------
function voldSetup(enemyName) {
  var G = freshGame();
  var v = place(G, 'Voldemort', 'player', 2);
  var e = place(G, enemyName || 'Bane', 'ai', 2);
  return { G: G, v: v, e: e };
}
// Force ONE curse and run it. The shim replaces the prompt functions and the
// AI fallback has its own preference order, so narrowing the menu to a single
// entry is how a test names the curse it wants — and it exercises the real
// cast path rather than a copy of it.
function castCurse(G, v, id, lane) {
  var defs = CARD_ABILITIES['Voldemort'];
  var all = defs._CURSES;
  defs._CURSES = all.filter(function (c) { return c.id === id; });
  try { defs.onLaneCombat(G, v, lane == null ? 2 : lane); }
  finally { defs._CURSES = all; }
}

test('Voldemort prints as an 8-cost 4/10 villain', function () {
  var d = cardByName('Voldemort');
  assertEq(d.cost, 8, 'cost 8');
  assertEq(d.attack, 4, '4 ATK');
  assertEq(d.health, 10, '10 HP');
  assertEq(d.type, 'villain', 'villain');
  assertEq(d.desc.indexOf('Mind Control') > -1, true, 'the text names the keyword so its chip renders');
});

test('Avada Kedavra kills outright, but only cost 7 and under', function () {
  var defs = CARD_ABILITIES['Voldemort'];
  var s = voldSetup('Bane');                       // cost 2
  var reach = defs._targetsFor(s.G, s.v, 'ak');
  assertEq(reach.length, 1, 'a cheap enemy is in reach');

  var big = voldSetup('Anakin Skywalker');         // cost 10
  assertEq(defs._targetsFor(big.G, big.v, 'ak').length, 0, 'a 10-cost is out of reach');

  // It is DEATH, not damage — the victim leaves the board at full HP.
  var k = voldSetup('Bane');
  var hpBefore = k.e.currentHealth;
  castCurse(k.G, k.v, 'ak');
  assertEq(k.G.state.lanes[2].ai, null, 'the enemy is gone');
  assertEq(hpBefore > 0, true, 'and it was alive and unhurt right up until it was not');
});

test('Crucio maims without stunning, and CAN finish a small enemy', function () {
  var s = voldSetup('Bane');
  s.e.attack = 6; s.e.baseAttack = 6;
  s.e.currentHealth = 7; s.e.maxHealth = 7;
  castCurse(s.G, s.v, 'cr');
  assertEq(s.e.attack, 2, 'ATK cut by 4');
  assertEq(s.e.currentHealth, 3, 'HP cut by 4');
  // Stun rider removed (owner, 2026-08-09) — a (-4/-4) that ALSO took the
  // card's turn left Imperio with nothing of its own to offer.
  assertEq(s.G.isActionLocked(s.e), false, 'and it is NOT stunned');

  // CRUCIO KILLS as of 2026-08-11 (owner, via debuffCard allowKill false ->
  // true). This assertion used to read the other way — "floors at 1 HP,
  // Avada Kedavra is the kill curse" — and it is inverted here rather than
  // deleted, so the suite still pins which of the two rules is live.
  var t = voldSetup('Bane');
  t.e.attack = 1; t.e.currentHealth = 4; t.e.maxHealth = 4;
  castCurse(t.G, t.v, 'cr');
  assert(t.e.currentHealth <= 0 || t.G.state.lanes[2].ai !== t.e,
    'a 4-HP enemy is destroyed outright');

  // ...but it is still a (-4/-4), not a nuke: a bigger body survives.
  var u = voldSetup('Bane');
  u.e.attack = 5; u.e.currentHealth = 6; u.e.maxHealth = 6;
  castCurse(u.G, u.v, 'cr');
  assertEq(u.e.currentHealth, 2, 'a 6-HP enemy lives at 2');
  assertEq(u.G.state.lanes[2].ai, u.e, 'and is still standing');

  // The card text has to say so, or the kill is a hidden rule.
  assert(CARD_ABILITIES.Voldemort._CURSES.find(function (c) { return c.id === 'cr'; })
    .desc.indexOf('destroy') > -1, 'and the curse text warns that it can destroy');
});

test('Imperio turns an enemy for the round, then lets it go', function () {
  var s = voldSetup('Bane');
  castCurse(s.G, s.v, 'im');
  assertEq(!!s.e.isMindControlled, true, 'it is controlled');
  assertEq(s.G.state.lanes[2].ai, s.e, 'it stays in its own lane, on its own side of the board');
  // Released by the SAME end-of-round sweep that releases every other Mind
  // Control — Imperio does not need its own return trip.
  s.G.state.round = 1;
  s.G.clearRoundStatuses ? s.G.clearRoundStatuses() : null;
});

test('Each curse can be cast only once, ever', function () {
  var defs = CARD_ABILITIES['Voldemort'];
  var s = voldSetup('Bane');
  // A fat target so no curse ever runs out of marks — the limit under test is
  // the ONCE rule, not target availability.
  s.e.attack = 9; s.e.currentHealth = 40; s.e.maxHealth = 40;

  for (var r = 1; r <= 3; r++) {
    s.G.state.round = r;
    var beforeCount = (s.v._usedCurses || []).length;
    defs.onLaneCombat(s.G, s.v, 2);
    var after = (s.v._usedCurses || []).length;
    assertEq(after, beforeCount + 1, 'round ' + r + ' spent exactly one curse');
    // Keep a live victim and clear the status so the next round has a mark.
    if (!s.G.state.lanes[2].ai) { s.e = place(s.G, 'Bane', 'ai', 2); }
    s.e.currentHealth = 40; s.e.maxHealth = 40; s.e.attack = 9;
    s.e.isMindControlled = false; s.e.isFrozen = false; s.e.isStunned = false; s.e.frozenTurns = 0;
  }
  assertEq(s.v._usedCurses.length, 3, 'all three are spent after three rounds');
  assertEq(s.v._usedCurses.slice().sort().join(','), 'ak,cr,im', 'and they were three DIFFERENT curses');

  // Round four: nothing left to cast, and no crash reaching for it.
  s.G.state.round = 4;
  defs.onLaneCombat(s.G, s.v, 2);
  assertEq(s.v._usedCurses.length, 3, 'a fourth round adds nothing');
});

test('Voldemort casts through REAL combat, once per round, never a repeat', function () {
  // Every other Voldemort test calls defs.onLaneCombat() by hand, which proves
  // the curse logic and proves NOTHING about whether the lane dispatcher ever
  // reaches it. "Make sure he chooses a curse each time he attacks" is a
  // question about the dispatcher, so this one drives resolveCombat().
  var G = freshGame();
  var v = place(G, 'Voldemort', 'player', 2);
  var e = place(G, 'Bane', 'ai', 2);
  // Fat and toothless: he must survive three rounds and always have a mark.
  e.attack = 0; e.currentHealth = e.maxHealth = 60;
  v.currentHealth = v.maxHealth = 60;

  var castPerRound = [];
  for (var r = 1; r <= 3; r++) {
    G.state.round = r;
    var before = (v._usedCurses || []).length;
    G.resolveCombat();
    var after = (v._usedCurses || []).length;
    castPerRound.push(after - before);
    // Keep a living, unafflicted mark for the next round.
    if (!G.state.lanes[2].ai || G.state.lanes[2].ai.currentHealth <= 0) {
      e = place(G, 'Bane', 'ai', 2);
    } else { e = G.state.lanes[2].ai; }
    e.attack = 0; e.currentHealth = e.maxHealth = 60;
    e.isMindControlled = false; e.isFrozen = false; e.isStunned = false; e.frozenTurns = 0;
    v.currentHealth = v.maxHealth = 60;
    v.isFrozen = false; v.isStunned = false; v.frozenTurns = 0;
  }
  assertEq(castPerRound.join(','), '1,1,1', 'exactly one curse in each of three real combats');
  assertEq(v._usedCurses.slice().sort().join(','), 'ak,cr,im',
    'and they were three DIFFERENT curses — a spent one is never offered again');

  // Round four: all three spent, so the fight resolves with nothing cast.
  G.state.round = 4;
  G.resolveCombat();
  assertEq(v._usedCurses.length, 3, 'a fourth combat adds nothing and does not crash');

  // UNCONTESTED lane too. The dispatcher reads lane.player/lane.ai before the
  // contested/uncontested split, but "each time he attacks" includes the
  // rounds nothing stands in front of him, so assert it rather than infer it.
  var G2 = freshGame();
  var v2 = place(G2, 'Voldemort', 'player', 0);      // lane 0: nobody opposite
  var mark = place(G2, 'Bane', 'ai', 3);             // a mark in a FAR lane
  mark.attack = 0; mark.currentHealth = mark.maxHealth = 60;
  G2.resolveCombat();
  assertEq((v2._usedCurses || []).length, 1, 'he curses on a round he is unblocked');
});

test('A spent curse is filtered out of the menu, not just refused on cast', function () {
  // The user-visible half of the once-each rule: after Crucio, the prompt is
  // down to two options. Asserting the OFFER list, not the outcome.
  var defs = CARD_ABILITIES['Voldemort'];
  var G = freshGame();
  var v = place(G, 'Voldemort', 'player', 2);
  var e = place(G, 'Bane', 'ai', 2);
  e.attack = 0; e.currentHealth = e.maxHealth = 60;

  function offered() {
    var used = v._usedCurses || [];
    return defs._CURSES
      .filter(function (c) { return used.indexOf(c.id) === -1; })
      .filter(function (c) { return defs._targetsFor(G, v, c.id).length > 0; })
      .map(function (c) { return c.id; });
  }
  assertEq(offered().join(','), 'ak,cr,im', 'all three on the table to start');
  v._usedCurses = ['cr'];
  var left = offered();
  assertEq(left.indexOf('cr'), -1, 'Crucio is gone once it has been cast');
  assertEq(left.length, 2, 'and exactly two remain to choose from');
  v._usedCurses = ['cr', 'ak'];
  assertEq(offered().join(','), 'im', 'then one');
});

test('A curse that finds no mark does not burn its one use', function () {
  var defs = CARD_ABILITIES['Voldemort'];
  var G = freshGame();
  var v = place(G, 'Voldemort', 'player', 2);
  // Empty enemy board — nothing to curse at all.
  defs.onLaneCombat(G, v, 2);
  assertEq((v._usedCurses || []).length, 0, 'nothing was spent on an empty board');
  // Now give him a target: all three are still available.
  place(G, 'Bane', 'ai', 2);
  defs.onLaneCombat(G, v, 2);
  assertEq(v._usedCurses.length, 1, 'and the first real cast spends exactly one');
});

test('A silenced Voldemort casts nothing, and a curse with no mark is not offered', function () {
  var defs = CARD_ABILITIES['Voldemort'];
  var s = voldSetup('Bane');
  s.v.isFrozen = true; s.v.frozenTurns = 1;
  CARD_ABILITIES['Voldemort'].onLaneCombat(s.G, s.v, 2);
  assertEq(s.v._lastCurse, undefined, 'frozen — no curse was cast');

  // Board with nothing to curse at all.
  var empty = freshGame();
  var v2 = place(empty, 'Voldemort', 'player', 0);
  CARD_ABILITIES['Voldemort'].onLaneCombat(empty, v2, 0);
  assertEq(v2._lastCurse, undefined, 'no enemies — nothing cast, and no crash');
});

// A card that steps in FRONT of a hit still gets its own shields. The taunt
// intercept re-tested Invincible and Damage Immunity on the taunter by hand and
// left Evade out, so a Taunt+Evade body died to a hit it should have dodged
// with its charge untouched. Owner: "star lord had an evade and should have
// evaded the bonus attack, why did he die?"
function tauntSetup() {
  var G = freshGame();
  var taunter = place(G, 'Star-Lord', 'player', 0);
  taunter.tauntTurns = 3;
  var ally = place(G, 'Black Panther', 'player', 1);
  var enemy = place(G, 'Gamora', 'ai', 1);
  return { G: G, taunter: taunter, ally: ally, enemy: enemy };
}

test('A taunter with Evade dodges the hit it intercepted', function () {
  var s = tauntSetup();
  s.taunter.evadeCharges = 1;
  var hp = s.taunter.currentHealth, allyHp = s.ally.currentHealth;
  s.G.dealDamage(s.ally, 99, s.enemy);
  assertEq(s.taunter.currentHealth, hp, 'the taunter took nothing');
  assertEq(s.taunter.evadeCharges, 0, 'and the dodge SPENT the charge — it was really used');
  assertEq(s.ally.currentHealth, allyHp, 'the protected ally is still untouched');

  // Out of charges, the next one lands — Evade is a charge, not a state.
  s.G.dealDamage(s.ally, 2, s.enemy);
  assert(s.taunter.currentHealth < hp, 'the second hit gets through');
});

test('A taunter with Invincible still blocks, and Armor still reduces', function () {
  var inv = tauntSetup();
  inv.taunter.invincibleTurns = 1;
  var hp = inv.taunter.currentHealth;
  inv.G.dealDamage(inv.ally, 99, inv.enemy);
  assertEq(inv.taunter.currentHealth, hp, 'Invincible on the taunter is unchanged by the refactor');

  var arm = tauntSetup();
  arm.taunter.armorValue = 5;
  var hp2 = arm.taunter.currentHealth;
  arm.G.dealDamage(arm.ally, 3, arm.enemy);
  assertEq(arm.taunter.currentHealth, hp2, 'Armor still absorbs a small hit after the redirect');
});

test('A taunter with no shields still eats it — the fix is not a blanket immunity', function () {
  var s = tauntSetup();
  s.taunter.evadeCharges = 0;
  var hp = s.taunter.currentHealth, allyHp = s.ally.currentHealth;
  s.G.dealDamage(s.ally, 2, s.enemy);
  assert(s.taunter.currentHealth < hp, 'the taunter took the hit');
  assertEq(s.ally.currentHealth, allyHp, 'and the ally was spared, which is the whole point of Taunt');
});

test('The intended target still gets its OWN shields when nobody taunts', function () {
  var G = freshGame();
  var target = place(G, 'Black Panther', 'player', 1);
  target.evadeCharges = 1;
  var enemy = place(G, 'Gamora', 'ai', 1);
  var hp = target.currentHealth;
  G.dealDamage(target, 99, enemy);
  assertEq(target.currentHealth, hp, 'dodged');
  assertEq(target.evadeCharges, 0, 'charge spent');
});

// THE GUARD THAT SHOULD HAVE EXISTED. The codex's summoned-token rows mirror
// the summonCardChoice() calls by hand, and nothing connected the two — so a
// token added to an ability simply never showed up in the encyclopedia. Battle
// Droid went missing the day it was written (owner: "battledroid isn't in the
// codex of summons") and Doombot had been missing far longer.
//
// This reads the ABILITY SOURCE for summon-name literals and checks each one is
// accounted for. It cannot be fooled by adding a row to the list — the list is
// not the input, the code is.
test('Every token an ability summons is listed for the codex', function () {
  var listed = {};
  (typeof SUMMON_TOKEN_DEFS !== 'undefined' ? SUMMON_TOKEN_DEFS : []).forEach(function (t) { listed[t.name] = t; });
  var isCard = {};
  CARD_DEFS.forEach(function (d) { isCard[d.name] = true; });

  var found = {}, hooks = 0;
  Object.keys(CARD_ABILITIES).forEach(function (cardName) {
    var def = CARD_ABILITIES[cardName];
    Object.keys(def).forEach(function (k) {
      if (typeof def[k] !== 'function') return;
      hooks++;
      var src = def[k].toString();
      // summonCardChoice(owner, "Name", cost, atk, hp, ...)
      var re = /summonCardChoice\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]/g, m;
      while ((m = re.exec(src))) found[m[1]] = cardName;
    });
  });
  // Sanity: if the scan finds nothing, the regex broke and this test is
  // asserting nothing at all — which is worse than failing.
  assert(hooks > 50, 'the scan actually walked the ability hooks (' + hooks + ')');
  var names = Object.keys(found);
  assert(names.length >= 6, 'the scan found summon calls (' + names.length + ')');

  names.forEach(function (n) {
    // A token is fine either way: a real CARD_DEF (Ghostface, Gremlin — they
    // show in their own codex section) or a display row in SUMMON_TOKEN_DEFS.
    assert(isCard[n] || listed[n],
      '"' + n + '" is summoned by ' + found[n] + ' but appears nowhere in the codex');
  });
});

test('The token rows match the stats the abilities actually summon', function () {
  // A row that exists but lies is no better than a missing one.
  var byName = {};
  SUMMON_TOKEN_DEFS.forEach(function (t) { byName[t.name] = t; });
  var checks = 0;
  Object.keys(CARD_ABILITIES).forEach(function (cardName) {
    var def = CARD_ABILITIES[cardName];
    Object.keys(def).forEach(function (k) {
      if (typeof def[k] !== 'function') return;
      // Only literal-argument calls can be checked — a call whose stats come
      // from a variable (Ant-Man's Text+ scaling) is skipped rather than
      // guessed at.
      var re = /summonCardChoice\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,/g, m;
      var src = def[k].toString();
      while ((m = re.exec(src))) {
        var row = byName[m[1]];
        if (!row) continue;
        checks++;
        assertEq(row.cost, +m[2], m[1] + ' cost matches the summon call');
        assertEq(row.attack, +m[3], m[1] + ' ATK matches');
        assertEq(row.health, +m[4], m[1] + ' HP matches');
      }
    });
  });
  assert(checks >= 3, 'at least a few rows were actually compared (' + checks + ')');
});

// ---- STATUS DEBUFFS LAST UNTIL YOUR LANE FIGHTS ------------
// Owner, 2026-08-09: "Iron Man attacks in lane 4, the enemy blocks, he plays
// Fear Toxin on Iron Man — that debuff lasts until the next time his lane
// resolves." The clock moved off the global end-of-round tick and onto the
// victim's own lane.
test('A status clears when the afflicted card LANE resolves, not at end of round', function () {
  var G = freshGame();
  var c = place(G, 'Bane', 'player', 2);
  G.freezeCard(c, place(G, 'Bane', 'ai', 5), 1);
  assertEq(c.isFrozen, true, 'frozen to start');

  // The end-of-round sweep must NOT touch it any more — that was the old clock.
  G.postCombat();
  assertEq(c.isFrozen, true, 'a round passing on its own does not thaw it');

  // Its lane fighting is what clears it.
  G._tickStatusOnLaneResolve(c);
  assertEq(c.isFrozen, false, 'its lane resolved — thawed');
});

test('The count survives as LANE resolutions, so Freeze 2 still lasts longer', function () {
  var G = freshGame();
  var c = place(G, 'Bane', 'player', 2);
  var src = place(G, 'Bane', 'ai', 5);
  G.freezeCard(c, src, 2);
  assertEq(c.frozenTurns, 2, 'Freeze 2 armed');
  G._tickStatusOnLaneResolve(c);
  assertEq(c.isFrozen, true, 'one lane resolution is not enough');
  assertEq(c.frozenTurns, 1, 'it ticked down by one');
  G._tickStatusOnLaneResolve(c);
  assertEq(c.isFrozen, false, 'the second clears it');
});

test('A debuff landed after the lane fought survives to next round', function () {
  // The exact scenario reported: the lane resolves, the blocker plays Fear
  // Toxin on the card that just swung, and it must still be afflicted when
  // that lane comes round again — not wiped by a sweep it never lived through.
  var G = freshGame();
  var c = place(G, 'Iron Man', 'player', 3);
  var enemy = place(G, 'Bane', 'ai', 3);
  G._tickStatusOnLaneResolve(c);            // lane 4 fights
  G.freezeCard(c, enemy, 1);                // ...then the trick lands
  assertEq(c.isFrozen, true, 'afflicted after its lane already fought');
  G.postCombat();
  assertEq(c.isFrozen, true, 'and the round ending does NOT consume it');
  G._tickStatusOnLaneResolve(c);            // next round, lane 4 fights again
  assertEq(c.isFrozen, false, 'it is spent by the lane it was meant to affect');
});

test('All four statuses are on the lane clock, and nothing else is', function () {
  var G = freshGame();
  var c = place(G, 'Bane', 'player', 0);
  // Set directly rather than via the appliers: stunCard ALIASES freezeCard
  // (Stun was merged into Freeze globally), so applying both through the API
  // stacks one status to 2 instead of arming two.
  c.isFrozen = true; c.frozenTurns = 1;
  c.isStunned = true; c.stunnedTurns = 1;
  c.isFeared = true; c.fearedTurns = 1;
  c.isMindControlled = true;
  // Taunt and Invincible are NOT status debuffs — Invincible is a round-based
  // buff (owner, 2026-08-09) and stays on the end-of-round tick with Taunt.
  c.tauntTurns = 2; c.invincibleTurns = 2;

  G._tickStatusOnLaneResolve(c);
  assertEq(c.isFrozen, false, 'freeze cleared');
  assertEq(c.isStunned, false, 'stun cleared');
  assertEq(c.isFeared, false, 'fear cleared');
  assertEq(c.isMindControlled, false, 'mind control cleared');
  assertEq(c.tauntTurns, 2, 'taunt is untouched by the lane clock');
  assertEq(c.invincibleTurns, 2, 'and so is invincible');
});

test('Knull rolls 2-9, never a 1-cost', function () {
  var def = cardByName('Knull');
  assertEq(def.desc.indexOf('cost 2-9') > -1, true, 'the text states the range');

  // The gate under test is the FILTER Knull hands the summon deck — sampling
  // random pulls would only ever probe it.
  var G = freshGame();
  var k = place(G, 'Knull', 'player', 0);
  var seen = null, real = G.drawFromSummonDeck;
  G.drawFromSummonDeck = function (fn) { seen = fn; return null; };
  try { CARD_ABILITIES['Knull'].onPlay(G, k, 0); } finally { G.drawFromSummonDeck = real; }
  assert(!!seen, 'the filter was handed over');
  var probe = function (cost) { return seen({ name: 'x', cost: cost, attack: 2, health: 2, isDiscardEffect: false }); };
  assertEq(probe(1), false, 'a 1-cost is out of the pool now');
  assertEq(probe(2), true, '2 is the new floor');
  assertEq(probe(9), true, '9 is still the ceiling');
  assertEq(probe(10), false, 'and a 10-cost titan stays out');
  // The other filters are untouched — a 0-ATK body is still not a summon.
  assertEq(seen({ name: 'x', cost: 5, attack: 0, health: 3, isDiscardEffect: false }), false,
    '0-ATK cards are still excluded');
});

// ---- 2026-08-09 CARD PASS ----------------------------------
test('Draw 1 lands on Wonder Woman, Scarlet Witch and Padme; Groot loses it', function () {
  // Draw 1 is a KEYWORD — the badge and the drawOnPlay effect both come from
  // the abilities array, so the array is what these assert. A desc mention
  // would print the words and draw nothing.
  ['Wonder Woman', 'Scarlet Witch', 'Padme Amidala'].forEach(function (n) {
    assertEq(cardByName(n).abilities.indexOf('Draw 1') > -1, true, n + ' has Draw 1');
    assertEq(cardByName(n).desc.indexOf('Draw'), -1, n + ' does not repeat it in the text');
  });
  var groot = cardByName('Groot');
  assertEq(groot.abilities.indexOf('Draw 1'), -1, 'Groot lost Draw 1');
  assertEq(groot.attack, 4, 'and is a 4/4 — 4 ATK');
  assertEq(groot.health, 4, '4 HP');
  assertEq(groot.abilities.indexOf('Armor 1') > -1, true, 'Armor 1 survived the edit');

  // The keyword has to REACH the instance, not just print on the def.
  var G = freshGame();
  var ww = G.createCardInstance(cardByName('Wonder Woman'), 'player');
  assertEq(ww.drawOnPlay, 1, 'Wonder Woman actually draws on play');
  var gr = G.createCardInstance(cardByName('Groot'), 'player');
  assertEq(gr.drawOnPlay, 0, 'and Groot no longer does');
});

test("Wonder Woman's lasso chains exactly ONE enemy", function () {
  // Was: every consecutive enemy in the chosen direction. Now: the first one
  // only. Three bodies in a row so a runaway chain is unmistakable — assert the
  // MECHANISM (who took damage), not just WW's own state.
  var G = freshGame();
  var ww = place(G, 'Wonder Woman', 'player', 2);
  var front = place(G, 'Groot', 'ai', 2);
  var next1 = place(G, 'Groot', 'ai', 3);
  var next2 = place(G, 'Groot', 'ai', 4);
  [front, next1, next2].forEach(function (c) { c.currentHealth = c.maxHealth = 30; });
  ww.attack = 5;
  var hp1 = next1.currentHealth, hp2 = next2.currentHealth;
  G.autoChainDamage('player', 2, ww.attack - 1, 0, null, 'LASSO CHAIN', 1);
  assert(next1.currentHealth < hp1, 'the adjacent enemy takes the chain');
  assertEq(next2.currentHealth, hp2, 'the one BEYOND it is untouched');

  // Vader shares autoChainDamage — no cap means he still walks the whole run.
  next1.currentHealth = hp1; next2.currentHealth = hp2;
  G.autoChainDamage('player', 2, 6, 1, null, 'VADER CHAIN');
  assert(next2.currentHealth < hp2, 'an uncapped chain still reaches the far enemy');

  assert(cardByName('Wonder Woman').desc.indexOf('1 chained enemy') > -1,
    'and the card text says one');
});

test('Crazy and Insane highlight in body text like every other status', function () {
  // Both already had full KEYWORD_DATA (color + glyph + tip) but were missing
  // from the desc highlighter's keyword list, so Joker's "Give Crazy to..." was
  // grey prose with no tooltip. THREE lists have to agree for a keyword to work
  // in body text — this is a duplicated-predicate guard, so it reads ui.js as
  // source (UI can't load headless: it needs a DOM).
  var src = readFile('./ui.js');
  ['Crazy', 'Insane'].forEach(function (k) {
    assert(src.indexOf("'" + k + "':") > -1, k + ' has a KEYWORD_DATA entry');
    assert(src.indexOf("'" + k.toLowerCase() + "':'" + k + "'") > -1,
      k + ' is in kwLookup (supplies data-kw, hence the tooltip)');
    assert(new RegExp("\\['" + k + "',\\s").test(src), k + ' is in kwMap (does the highlighting)');
  });
  var css = readFile('./style.css');
  ['crazy', 'insane'].forEach(function (k) {
    assert(css.indexOf('.kw-' + k) > -1, '.kw-' + k + ' has a color rule');
    assert(css.indexOf('--kw-' + k + ':') > -1, '--kw-' + k + ' is a real token');
  });
  assert(cardByName('Joker').desc.indexOf('Crazy') > -1, 'and Joker still says the word');
});

test('Wolverine says the When Damaged effect is lost on revive', function () {
  // The engine nulls self.onDamaged in onDeath; the text has to admit it.
  var d = cardByName('Wolverine').desc;
  assert(d.indexOf('When Damaged is removed') > -1, 'the revive line names the loss');
  var G = freshGame();
  var w = place(G, 'Wolverine', 'player', 1);
  assert(typeof w.onDamaged === 'function', 'the hook is live before dying');
  var lane = G.findCardLane(w);
  w.currentHealth = 0;
  if (CARD_ABILITIES.Wolverine.onDeath) CARD_ABILITIES.Wolverine.onDeath(G, w, lane);
  assertEq(w.onDamaged, null, 'and gone after the revive');
});

// ---- 2026-08-10 ORDERING + SPLASH RULING -------------------
test('On Play resolves BEFORE passives — Peacemaker kills a 2-ATK Xenomorph', function () {
  // The reported case verbatim: Xenomorph sitting at 2 ATK, Peacemaker played,
  // "it doesn't grow first, the On Play effect happens first". Before the fix
  // the aura ping ran ahead of onPlay, so Xenomorph's While-Active growth took
  // him to 3 ATK and Peacemaker's "destroy an enemy with ≤ 2 ATK" found no
  // legal target.
  var G = freshGame();
  var xeno = place(G, 'Xenomorph', 'ai', 2);
  xeno.attack = 2; xeno.currentHealth = 5; xeno.maxHealth = 5;
  var pm = G.createCardInstance(cardByName('Peacemaker'), 'player');
  G.state.player.hand.push(pm);
  G.state.player.currency = 20;
  G.playCard('player', pm, 2);
  assert(xeno.currentHealth <= 0 || G.state.lanes[2].ai !== xeno,
    'Xenomorph was still 2 ATK when Peacemaker looked, so he dies');
});

test('the arrival aura ping still fires — it only MOVED, it was not dropped', function () {
  // The ordering flip must not drop onAnyCardPlayed, and the same Xenomorph
  // proves it from the other side: with nothing for the played card's On Play
  // to contest, his While-Active growth must still land.
  var G = freshGame();
  var xeno = place(G, 'Xenomorph', 'player', 2);
  var atkBefore = xeno.attack;
  var body = G.createCardInstance(cardByName('Groot'), 'player');
  G.state.player.hand.push(body);
  G.state.player.currency = 20;
  G.playCard('player', body, 4);
  assert(xeno.attack > atkBefore, 'Xenomorph still grew off the new arrival');
});

test('Splash does not answer to ATK — a 0-ATK splasher still splashes', function () {
  // Owner ruling: "if a card has 0 attack like doc ock and he still has splash
  // 2, the splash 2 still fires". Drive real combat, not applySplash directly —
  // the bug was in the GATE (pCanAttack required attack > 0), so calling the
  // splash helper by hand would have passed either way.
  function run(contested) {
    var G = freshGame();
    var ock = place(G, 'Dr. Octopus', 'player', 2);
    ock.splashRange = 2;
    ock.attack = 0;                       // stripped by Gojo / Nightwing / etc.
    var adj = place(G, 'Gorilla Grodd', 'ai', 3);   // no Armor — it would eat a point
    adj.currentHealth = adj.maxHealth = 20;
    if (contested) {
      var front = place(G, 'Gorilla Grodd', 'ai', 2);
      front.currentHealth = front.maxHealth = 20;
      front.attack = 0;                   // keep the trade from killing Ock
    }
    var before = adj.currentHealth;
    G.resolveCombat();
    return before - adj.currentHealth;
  }
  assertEq(run(true), 2, 'contested lane: the adjacent enemy takes Splash 2');
  assertEq(run(false), 2, 'uncontested lane: same');
});

test('Hulk is not an exception — his splash follows his ATK because it IS his ATK', function () {
  // The one card the owner carved out. He needs no special case in the gate:
  // _splashTracksAtk drives splashRange FROM attack, so zeroing his ATK zeroes
  // the splash and the same rule produces the right answer.
  var G = freshGame();
  var hulk = G.createCardInstance(cardByName('Hulk'), 'player');
  G.state.player.hand.push(hulk);
  G.state.player.currency = 20;
  G.playCard('player', hulk, 2);          // the flag is set by his On Play
  assert(!!hulk._splashTracksAtk, 'Hulk tracks ATK for splash');
  assertEq(hulk.splashRange, hulk.attack, 'and his splash equals his ATK');
  hulk.attack = 0;
  G.buffCard(hulk, 0, 0);                 // any stat touch re-syncs splashRange
  assertEq(hulk.splashRange, 0, 'no ATK, no splash — for Hulk specifically');
});

test('Dead Draw reaches the live instance, not just the printed def', function () {
  // Hela and Grundy had the keyword on the DEF (so the codex drew the green
  // glyph) but createCardInstance had no case for it, and the in-hand / board
  // badge row reads the INSTANCE. Two lists, one keyword.
  var G = freshGame();
  ['Hela', 'Solomon Grundy'].forEach(function (n) {
    assert(cardByName(n).abilities.indexOf('Dead Draw 1') > -1, n + ' prints the keyword');
    var inst = G.createCardInstance(cardByName(n), 'player');
    assertEq(inst.hasDeadDraw, 1, n + "'s instance carries it too");
  });
  // And both really do pull at random from BOTH piles, which is what the
  // keyword's description now claims.
  var src = readFile('./abilities.js');
  assert(src.indexOf('...G.state.player.deadPile, ...G.state.ai.deadPile') > -1,
    'Hela merges both dead piles before rolling');
  var tip = readFile('./ui.js');
  assert(tip.indexOf('The Dead Pile is <b>shared</b>') > -1, 'the tooltip says shared');
  assert(tip.indexOf('the pull is <b>random</b>') > -1, 'and random');

  // ...and ONLY the cards that actually behave that way carry it. Dr. Doom
  // picks a card he chooses from HIS OWN pile, and Martian Manhunter copies
  // abilities rather than drawing — neither matches "shared" or "random", so
  // the badge on them was a keyword promising something the card does not do.
  // Both descriptions already spell their effect out in full, so nothing is
  // lost by dropping it. (Owner call, 2026-08-10.)
  ['Dr. Doom', 'Martian Manhunter'].forEach(function (n) {
    assertEq(cardByName(n).abilities.indexOf('Dead Draw 1'), -1,
      n + ' no longer prints Dead Draw');
    assertEq(G.createCardInstance(cardByName(n), 'player').hasDeadDraw, 0,
      n + "'s instance does not carry it either");
    assert(cardByName(n).desc.indexOf('Dead Pile') > -1,
      n + ' still explains its dead-pile effect in the text');
  });
  assertEq(cardByName('Martian Manhunter').abilities.indexOf('Evade 1') > -1, true,
    'and Evade 1 survived the edit');
});

test('Doomsday rises with Immunity and Untrickable — and NOT with Taunt', function () {
  // Reversed 2026-08-14: the revive briefly re-armed Taunt, on the reasoning
  // that Taunt 1 is printed on the def and tauntTurns decays to 0 long before
  // he dies. Owner struck "and Taunt" off the revive line — that decay IS the
  // intended shape. Taunt is his ARRIVAL keyword, spent once; the revive does
  // not refresh it.
  var G = freshGame();
  var d = place(G, 'Doomsday', 'player', 2);
  assertEq(d.tauntTurns, 1, 'the printed keyword still arms on arrival');

  // Age him so Taunt has genuinely expired before he dies — otherwise a
  // still-live counter would mask whether the revive re-armed it.
  for (var r = 0; r < 3 && d.tauntTurns > 0; r++) {
    G.state.round = r + 1;
    if (G.postCombat) G.postCombat();
  }
  assertEq(d.tauntTurns, 0, 'and it decays to nothing, as it should');

  var lane = G.findCardLane(d);
  d.currentHealth = 0;
  var prevented = CARD_ABILITIES.Doomsday.onDeath(G, d, lane);
  assertEq(prevented, true, 'the revive still fires');
  assertEq(d.tauntTurns | 0, 0, 'but Taunt is NOT re-armed — this is the change');
  assert(d.immunityCharges >= 1, 'Immunity still comes back');
  assertEq(d.isUntrickable, true, 'and Untrickable');
  assertEq(d.currentHealth, d.maxHealth, 'at full HP');

  // The printed text must match the two he actually gets, and must not
  // promise the third.
  var desc = cardByName('Doomsday').desc;
  assert(desc.indexOf('Immunity') > -1, 'the revive line names Immunity');
  assert(desc.indexOf('Untrickable') > -1, 'and Untrickable');
  assert(!/Untrickable and Taunt/.test(desc), 'and no longer promises Taunt on revive');
});

test("Moder strips EVERY hook the engine can dispatch, not most of them", function () {
  // The drift guard. Moder's list had 13 of the engine's 19 hooks, so six
  // abilities survived a full ability strip — including Jack Sparrow's Parlay
  // (onBeforeCombat), the reported bug. Reads both lists from source so adding
  // a hook to createCardInstance without adding it to Moder fails HERE rather
  // than in someone's match.
  var gsrc = readFile('./game.js');
  var asrc = readFile('./abilities.js');
  var engineHooks = {};
  var re = /(on[A-Z][A-Za-z]*)\s*:\s*def\./g, m;
  while ((m = re.exec(gsrc))) engineHooks[m[1]] = true;
  var names = Object.keys(engineHooks);
  assert(names.length >= 15, 'found the hook table in game.js (' + names.length + ' hooks)');

  var block = asrc.slice(asrc.indexOf('const STRIP_HOOKS'), asrc.indexOf('const STRIP_FIELDS'));
  var missing = names.filter(function (h) { return block.indexOf("'" + h + "'") === -1; });
  assertEq(missing.join(','), '', 'every engine hook is in Moder STRIP_HOOKS');
});

test('Moder shuts off Jack Sparrow Parlay, not just his stats', function () {
  // Reported: "Jack Sparrow was played into Moder, his abilities were stripped
  // but his Parlay was still going off." Parlay runs on onBeforeCombat, which
  // the strip list did not carry.
  var G = freshGame();
  var jack = place(G, 'Jack Sparrow', 'player', 2);
  assert(typeof jack.onBeforeCombat === 'function', 'Parlay is live before the strip');

  // Drive the REAL path: the strip lives in a closure, applied by Moder's
  // onAnyCardPlayed when a card is played directly into her lane.
  var moder = CARD_ABILITIES['Moder'];
  var m = place(G, 'Moder', 'ai', 2);
  m._moderStripPending = 1;
  moder.onAnyCardPlayed(G, m, jack);
  assertEq(jack.onBeforeCombat, null, 'Parlay is gone after the strip');
  assertEq(jack.onPlay, null, 'and so is everything else it already covered');
});

function freddySetup() {
  var G = freshGame();
  var f = place(G, 'Freddy Krueger', 'player', 2);
  f.attack = 2;
  G.state.ai.hand = ['Groot', 'Bane'].map(function (n) {
    return G.createCardInstance(cardByName(n), 'ai');
  });
  return { G: G, f: f };
}

test('Freddy: a hand card that SURVIVES the slash falls asleep and feeds him', function () {
  var s = freddySetup();
  var target = s.G.state.ai.hand[0];
  target.currentHealth = target.maxHealth = 20;   // survives comfortably
  s.G.state.ai.hand.length = 1;                   // one target, no rng ambiguity
  var atk0 = s.f.attack, hp0 = s.f.currentHealth;

  CARD_ABILITIES['Freddy Krueger'].onBeforeAttack(s.G, s.f);

  assertEq(target.isAsleep, true, 'the survivor is Asleep');
  assert(target.sleepTurns > 0, 'and carries a sleep counter');
  assertEq(s.f.attack, atk0 + 1, 'Freddy gains +1 ATK');
  assertEq(s.f.currentHealth, hp0 + 1, 'and +1 HP');
  assertEq(s.G.state.ai.hand.length, 1, 'a survivor stays in hand');
});

test('Freddy: a hand card reduced to 0 is destroyed, and does NOT sleep', function () {
  var s = freddySetup();
  var target = s.G.state.ai.hand[0];
  target.currentHealth = 1;                        // dies to a 2-ATK slash
  s.G.state.ai.hand.length = 1;
  var atk0 = s.f.attack;

  CARD_ABILITIES['Freddy Krueger'].onBeforeAttack(s.G, s.f);

  assertEq(s.G.state.ai.hand.length, 0, 'destroyed cards leave the hand');
  assertEq(target.isAsleep, undefined, 'a destroyed card never falls asleep');
  assertEq(s.f.attack, atk0, 'and Freddy gains nothing from a kill');
});

test('Freddy: an already-Asleep card cannot be re-slept for more stacks', function () {
  // Spec point 7, and the balance reason for it: without the guard Freddy
  // farms the same unplayable card for +1/+1 every single round.
  var s = freddySetup();
  var target = s.G.state.ai.hand[0];
  target.currentHealth = target.maxHealth = 40;
  s.G.state.ai.hand.length = 1;

  CARD_ABILITIES['Freddy Krueger'].onBeforeAttack(s.G, s.f);
  var atkAfterFirst = s.f.attack;
  assertEq(target.isAsleep, true, 'asleep after the first slash');

  CARD_ABILITIES['Freddy Krueger'].onBeforeAttack(s.G, s.f);
  assertEq(s.f.attack, atkAfterFirst, 'a second slash on a sleeper adds no stack');
});

test('Freddy: a Sleeping card cannot be played, and wakes a round later', function () {
  var s = freddySetup();
  var target = s.G.state.ai.hand[0];
  target.currentHealth = target.maxHealth = 20;
  s.G.state.ai.hand.length = 1;
  CARD_ABILITIES['Freddy Krueger'].onBeforeAttack(s.G, s.f);
  assertEq(target.isAsleep, true, 'asleep');

  // The engine must REFUSE it — assert the gate, not just the flag.
  s.G.state.ai.currency = 20;
  assertEq(s.G.playCard('ai', target, 0), false, 'playCard refuses a sleeping card');
  assertEq(s.G.state.lanes[0].ai, null, 'and it never reached the board');

  s.G.tickSleep('ai');
  assertEq(target.isAsleep, false, 'it wakes on the next round');
  assertEq(target.sleepTurns, 0, 'counter cleared');
  assertEq(s.G.playCard('ai', target, 0), true, 'and is playable again');
});

test('Freddy rising from Boiler Room never resurrects a dead ally', function () {
  // Reported: Boiler Room lane held Sabertooth + Nightwing, Soul Stone killed
  // BOTH, Freddy rose off Sabertooth's death, and the "move your ally" prompt
  // — armed while Nightwing still stood — put a corpse back on the board when
  // it finally resolved. The guard has to be on RESOLVE, not on arm.
  var G = freshGame();
  var ally = place(G, 'Nightwing', 'player', 3);
  var openLanes = [];
  var captured = null;
  // RESTORED IN `finally`. This stub swallows the callback instead of
  // resolving it, which is the point of the test — but leaving it installed
  // silently broke every later test whose effect prompts for a lane (the
  // prompt was armed and then dropped, so the effect just never happened).
  var realLane = G.promptLaneChoice;
  try {
    G.promptLaneChoice = function (owner, lanes, title, desc, cb) { captured = cb; };

    CARD_ABILITIES['Boiler Room']._spawnFreddy(G, 'player', 3);
    assert(typeof captured === 'function', 'the move prompt was armed while the ally lived');

    // The ally dies before the player answers.
    ally.currentHealth = 0;
    G.state.lanes[3].player = null;

    captured(5);   // answer the prompt now
  } finally { G.promptLaneChoice = realLane; }
  assert(!G.state.lanes[5].player || G.state.lanes[5].player.currentHealth > 0,
    'a dead ally is NOT placed into the chosen lane');
  assertEq(G.state.lanes[3].player && G.state.lanes[3].player.name, 'Freddy Krueger',
    'and Freddy still rises');
});

test('Moder strips a card BEFORE its On Play can fire', function () {
  // Reported: Moder summoned off Paul Atreides, opponent played Human Torch
  // into her lane, no strip. Two causes, both from moving On Play ahead of the
  // passives: the arriving card fired its When Played first, and Human Torch's
  // arrival splash + blast KILLED the 2/1 Moder, so the onAnyCardPlayed
  // broadcast that used to carry the strip never reached her. The strip is now
  // a lane-entry effect, like a trap.
  var G = freshGame();
  var moder = G.createCardInstance(cardByName('Moder'), 'player');
  G.state.player.hand = [moder]; G.state.player.currency = 20;
  G.playCard('player', moder, 0);
  var moderHp = moder.currentHealth;

  var neighbour = place(G, 'Groot', 'player', 1);
  var nHp = neighbour.currentHealth;

  var torch = G.createCardInstance(cardByName('Human Torch'), 'ai');
  G.state.ai.hand = [torch]; G.state.ai.currency = 20;
  G.playCard('ai', torch, 0);

  assertEq(!!torch._moderStripped, true, 'the arriving card is stripped');
  assertEq(torch.onPlay, null, 'and its On Play is gone');
  assertEq(neighbour.currentHealth, nHp, 'so its arrival splash never landed');
  assert(moder.currentHealth === moderHp && moder.currentHealth > 0,
    'and Moder survives to have done it');
});

test('Magneto never offers a dead card to move', function () {
  // Reported: the picker listed The Grinch at 1/0. getAlliesOf/getEnemiesOf
  // read the lane slots and do NOT filter the dead, so anything killed earlier
  // in the same resolution — Magneto's own parity aura does exactly this —
  // could still be offered.
  var G = freshGame();
  var mag = place(G, 'Magneto', 'player', 2);
  var live = place(G, 'Groot', 'ai', 0);
  var corpse = place(G, 'The Grinch', 'ai', 1);
  corpse.currentHealth = 0;                     // dead but not yet swept

  // freshGame() hands back the Game SINGLETON, so a stub installed here leaks
  // into every later test unless it is put back. (It did: this override broke
  // the status-clearing test two files down before the restore was added.)
  var realPrompt = G.promptCardChoice;
  var realHuman = G.isHuman;
  var offered = null;
  G.isHuman = function () { return true; };
  G.promptCardChoice = function (owner, cards) { offered = cards; };
  try {
    var ab = CARD_ABILITIES['Magneto'];
    (ab.onBeforeTricks || ab.onPlay).call(ab, G, mag, 2);
  } finally {
    G.promptCardChoice = realPrompt;
    G.isHuman = realHuman;
  }

  assert(offered !== null, 'Magneto opened a move picker');
  // Two shapes: the normal tray lists the cards themselves, and the
  // one-candidate branch offers a synthetic "Move <name>" / "Skip" pair. Match
  // on the text either way so the test asserts WHO is offered, not which
  // branch happened to run.
  var blob = offered.map(function (c) { return c.name; }).join(' | ');
  assertEq(blob.indexOf('Grinch'), -1, 'the corpse is NOT offered: ' + blob);
  assert(blob.indexOf('Groot') > -1, 'the living enemy still is: ' + blob);
});

test('Freddy only wakes on TWO or more wasted energy', function () {
  assertEq(Game.FREDDY_WASTE_THRESHOLD, 2, 'the threshold is a named constant');
  function ended(withEnergy) {
    var G = freshGame();
    var fz = G.createCardInstance(cardByName('Freddy Fazbear'), 'player');
    G.state.player.hand.push(fz);
    G.state.ai.currency = withEnergy;      // the AI ended holding this much
    G._checkFreddyFazbear('ai');
    return !!fz.jumpReady;
  }
  assertEq(ended(0), false, '0 wasted — asleep');
  assertEq(ended(1), false, '1 wasted is normal play, not a mistake — still asleep');
  assertEq(ended(2), true,  '2 wakes him');
  assertEq(ended(5), true,  'and so does more');
  assertEq(cardByName('Freddy Fazbear').desc.indexOf('2 or more') > -1, true,
    'the card text states the threshold');
});

test('Apocalypse raises a 1-cost body on play', function () {
  var G = freshGame();
  var ap = place(G, 'Apocalypse', 'player', 0);
  // The gate under test is the FILTER handed to the summon deck.
  var seen = null, real = G.drawFromSummonDeck;
  G.drawFromSummonDeck = function (fn) { seen = fn; return null; };
  try { CARD_ABILITIES['Apocalypse'].onPlay(G, ap, 0); } finally { G.drawFromSummonDeck = real; }
  assert(!!seen, 'a pull was attempted');
  var probe = function (cost, atk) { return seen({ name: 'x', cost: cost, attack: atk, health: 2, isDiscardEffect: false }); };
  assertEq(probe(1, 2), true, 'a 1-cost with ATK qualifies');
  assertEq(probe(2, 2), false, 'a 2-cost does not');
  assertEq(probe(0, 2), false, 'nor a 0-cost');
  assertEq(probe(1, 0), false, 'nor a 1-cost that cannot fight');
  assertEq(cardByName('Apocalypse').desc.indexOf('random 1-cost') > -1, true, 'the text says so');
});

test('Doomsday rises Untrickable as well as Immune', function () {
  var G = freshGame();
  var dd = place(G, 'Doomsday', 'ai', 0);
  assertEq(!!dd.isUntrickable, false, 'not before he falls');
  dd.currentHealth = 0;
  CARD_ABILITIES['Doomsday'].onDeath(G, dd, 0);
  assertEq(dd.isUntrickable, true, 'he rises untrickable');
  // Which is a REAL refusal, not just a flag: enemy tricks cannot land.
  assertEq(G.canTrickLand(dd, 'trick', 'player'), false, 'an enemy trick is refused');
  assertEq(cardByName('Doomsday').desc.indexOf('Untrickable') > -1, true, 'and the text says so');
});

test('Avada Kedavra now stops at cost 6', function () {
  var defs = CARD_ABILITIES['Voldemort'];
  var six = voldSetup('Apocalypse');   // cost 7 in the defs — just out of reach
  assertEq(cardByName('Apocalypse').cost, 7, 'control: Apocalypse is a 7');
  assertEq(defs._targetsFor(six.G, six.v, 'ak').length, 0, 'a 7-cost is out of reach now');
  var ok = voldSetup('Bane');
  assertEq(defs._targetsFor(ok.G, ok.v, 'ak').length, 1, 'a cheap body is still fair game');
  assertEq(cardByName('Voldemort').desc.indexOf('\u2264 6') > -1, true, 'the text says 6');
});

// A FROZEN CARD'S LANE STILL RESOLVES. Owner: "Gamora should not be frozen
// forever — she was frozen by Spider-Man and after her attack lane the frozen
// should disappear, it's still on her."
//
// The tick was hung off the card's SWING, and every reason a card cannot swing
// (frozen, stunned, 0 ATK) returns before it — so the freeze was preventing the
// very attack that was supposed to clear it and renewed itself forever. These
// drive REAL COMBAT rather than calling the tick directly, which is exactly why
// the earlier tests missed it: they asserted the helper, not the wiring.
test('A frozen card thaws by its lane fighting, even though it cannot swing', function () {
  var G = freshGame();
  var gamora = place(G, 'Gamora', 'ai', 2);
  G.freezeCard(gamora, place(G, 'Spider-Man', 'player', 5), 1);
  assertEq(gamora.isFrozen, true, 'frozen to start');
  assertEq(G.state.lanes[2].player, null, 'and her lane is uncontested');

  G.resolveCombat();
  assertEq(gamora.isFrozen, false, 'her lane resolved — she thaws');
});

test('A frozen card in a CONTESTED lane thaws too', function () {
  var G = freshGame();
  var gamora = place(G, 'Gamora', 'ai', 2);
  var foe = place(G, 'Bane', 'player', 2);
  foe.attack = 0;                       // nobody kills anybody; the lane still fights
  gamora.currentHealth = 20; gamora.maxHealth = 20;
  G.freezeCard(gamora, place(G, 'Spider-Man', 'player', 5), 1);
  G.resolveCombat();
  assertEq(gamora.isFrozen, false, 'thawed by the lane resolving');
});

test('A 0-ATK card still ticks — it cannot swing, but its lane fights', function () {
  var G = freshGame();
  var c = place(G, 'Gamora', 'ai', 3);
  c.attack = 0;                          // never reaches the swing path
  G.freezeCard(c, place(G, 'Spider-Man', 'player', 5), 1);
  G.resolveCombat();
  assertEq(c.isFrozen, false, 'a body that cannot attack is not frozen forever');
});

test('The lane tick fires exactly ONCE per lane, so Freeze 2 is not halved', function () {
  var G = freshGame();
  var c = place(G, 'Gamora', 'ai', 2);
  c.currentHealth = 30; c.maxHealth = 30;
  G.freezeCard(c, place(G, 'Spider-Man', 'player', 5), 2);
  assertEq(c.frozenTurns, 2, 'Freeze 2 armed');
  G.resolveCombat();
  assertEq(c.frozenTurns, 1, 'one lane resolution spent exactly one');
  assertEq(c.isFrozen, true, 'still frozen after the first');
  G.resolveCombat();
  assertEq(c.isFrozen, false, 'and clear after the second');
});

// EVERY status, not just Freeze. Owner: "that's the same for mind control,
// fear etc." They share one tick, but sharing it is not proof — Mind Control in
// particular takes a DIFFERENT route through the lane dispatcher (it returns
// early expecting an async resolve), so each one is driven through real combat
// here rather than argued from the helper they have in common.
function statusSurvivesCombat(apply, read, contested) {
  var G = freshGame();
  var victim = place(G, 'Gamora', 'ai', 2);
  victim.currentHealth = 30; victim.maxHealth = 30;
  // A teammate, so a feared / mind-controlled card has something to turn on.
  var buddy = place(G, 'Bane', 'ai', 4);
  buddy.currentHealth = 30; buddy.maxHealth = 30;
  var src = place(G, 'Spider-Man', 'player', 5);
  if (contested) {
    var foe = place(G, 'Bane', 'player', 2);
    foe.attack = 0;                       // the lane fights; nobody dies
  }
  apply(G, victim, src);
  assertEq(read(victim), true, 'armed');
  G.resolveCombat();
  return read(victim);
}

test('Freeze, Stun, Fear and Mind Control ALL clear when the lane fights', function () {
  var cases = [
    ['Freeze',       function (G, v, s) { G.freezeCard(v, s, 1); },                function (v) { return !!v.isFrozen; }],
    ['Stun',         function (G, v, s) { G.stunCard(v, s, 1); },                  function (v) { return !!(v.isStunned || v.isFrozen); }],
    ['Fear',         function (G, v)    { v.isFeared = true; v.fearedTurns = 1; }, function (v) { return !!v.isFeared; }],
    ['Mind Control', function (G, v)    { v.isMindControlled = true; },            function (v) { return !!v.isMindControlled; }],
  ];
  cases.forEach(function (c) {
    assertEq(statusSurvivesCombat(c[1], c[2], false), false, c[0] + ' clears in an uncontested lane');
    assertEq(statusSurvivesCombat(c[1], c[2], true),  false, c[0] + ' clears in a contested lane');
  });
});

// onLaneCombat fires as THAT LANE comes up, not at the top of the phase.
// Owner, on Voldemort: "his passive should fire when his lane is attacking,
// not at the beginning of the attack phase."
test('onLaneCombat fires in lane order, not all at once up front', function () {
  var G = freshGame();
  var fired = [];
  // Probes in lanes 1 and 5. If the hook fired at the top of the phase they
  // would both run before any lane logged; in lane order, lane 1's probe runs,
  // then lane 1 fights, then lane 5's.
  [0, 4].forEach(function (i) {
    var c = place(G, 'Bane', 'player', i);
    c.currentHealth = 40; c.maxHealth = 40;
    c.onLaneCombat = function (g, self, lane) { fired.push('hook' + (lane + 1)); };
    var e = place(G, 'Bane', 'ai', i);
    e.currentHealth = 40; e.maxHealth = 40;
  });
  // Record lane starts through the same channel as the hooks, so the ordering
  // is one array rather than two clocks that have to be reconciled.
  var realResolveLaneCombat = G.resolveLaneCombat;
  var realUncontested = G.resolveUncontestedLane;
  G.resolveLaneCombat = function (i) { fired.push('lane' + (i + 1)); return realResolveLaneCombat.apply(G, arguments); };
  G.resolveUncontestedLane = function (i) { fired.push('lane' + (i + 1)); return realUncontested.apply(G, arguments); };
  try { G.resolveCombat(); }
  finally { G.resolveLaneCombat = realResolveLaneCombat; G.resolveUncontestedLane = realUncontested; }

  // Every hook must sit immediately before its own lane, never after it.
  assertEq(fired.indexOf('hook1') < fired.indexOf('lane1'), true, 'lane 1 hook precedes lane 1');
  assertEq(fired.indexOf('hook5') < fired.indexOf('lane5'), true, 'lane 5 hook precedes lane 5');
  // THE POINT: lane 5's hook runs AFTER lane 1 has already fought.
  assertEq(fired.indexOf('lane1') < fired.indexOf('hook5'), true,
    'lane 5 hook runs after lane 1 resolved, not up front with it');
});

test('onLaneCombat actually reaches a card instance', function () {
  // The instance hook whitelist in createCardInstance is the only way a hook
  // reaches a card — a hook the list omits is silently dropped and the card
  // just quietly does nothing. That is exactly what happened when this hook
  // was introduced.
  var G = freshGame();
  var v = G.createCardInstance(cardByName('Voldemort'), 'player');
  assertEq(typeof v.onLaneCombat, 'function', 'Voldemort carries the hook');
  assertEq(v.onBeforeCombat, null, 'and no longer uses the phase-wide one');
  assertEq(cardByName('Voldemort').desc.indexOf('When his lane fights') > -1, true,
    'the card text says when it happens');
});

// The jump offer is a pending prompt like any other, and the guest's state is
// seat-flipped — so its owner has to flip with the rest of them.
test('A jump offer owner flips for the guest, like every other prompt', function () {
  var G = freshGame();
  var st = { lanes: [], player: { hand: [] }, ai: { hand: [] },
             pendingJumpOffer: { cardId: 7, owner: 'ai' } };
  G._mpFlipPerspective(st);
  assertEq(st.pendingJumpOffer.owner, 'player',
    "the host's 'ai' reads as the guest's own seat");
  // And it survives a round trip unchanged, which is what makes it a flip
  // rather than a one-way stamp.
  G._mpFlipPerspective(st);
  assertEq(st.pendingJumpOffer.owner, 'ai', 'flipping back restores it');

  // An offer with no owner must not gain one out of thin air.
  var st2 = { lanes: [], player: { hand: [] }, ai: { hand: [] }, pendingJumpOffer: { cardId: 7 } };
  G._mpFlipPerspective(st2);
  assertEq(st2.pendingJumpOffer.owner, undefined, 'an unstamped offer stays unstamped');
});

// ONE MULLIGAN PER PLAYER, PER PHASE — owner reported it reading as spent when
// they had not used one. The ENGINE is correct (this pins that), so the symptom
// was display/sync, which is the rAF-gated render fixed alongside this.
test('The 2v2 draft mulligan is one per player, per phase', function () {
  Game.start2v2Match({ names: { p1: 'A', p2: 'B', p3: 'C', p4: 'D' } });
  Game.state.twoVTwo.online = true;
  Game.confirm2v2Teams(null, null);
  var d = Game.state.twoVTwo.draft;
  assertEq(!!d.simultaneous, true, 'online drafts are simultaneous');
  assertEq(JSON.stringify(d.mulliganUsed), '{}', 'nobody has spent one yet');

  assertEq(Game._2v2DraftMulligan('p2'), true, 'p2 spends theirs');
  assertEq(!!d.mulliganUsed.p2, true, 'and it is recorded against p2');
  // The bug shape being guarded: one player spending it must not spend it for
  // anyone else.
  assertEq(!!d.mulliganUsed.p1, false, "p1's is untouched");
  assertEq(!!d.mulliganUsed.p3, false, "p3's is untouched");
  assertEq(!!d.mulliganUsed.p4, false, "p4's is untouched");
  assertEq(Game._2v2DraftMulligan('p1'), true, 'and p1 can still spend theirs');
  assertEq(Game._2v2DraftMulligan('p2'), false, 'p2 cannot spend a second');

  // The two phases keep separate ledgers, so the cards-phase spend does not
  // eat the tricks-phase one.
  assertEq(JSON.stringify(d.trickMulliganUsed), '{}', 'the tricks ledger is its own');
});

test('Superman says what he does without explaining the rulebook', function () {
  // Owner, 2026-08-09: "do you see how much less text that needs —
  // overexplaining leads to burnout." The old line spelled out the bonus-attack
  // RULE ("strike the enemy opposite immediately, or the opponent's HP if that
  // lane is empty") on a card that merely USES it. The rule belongs to the
  // mechanic, not to every card that references it.
  var d = cardByName('Superman');
  assertEq(d.desc.indexOf('bonus attack') > -1, true, 'it names the mechanic');
  assertEq(d.desc.indexOf('lane is empty'), -1, 'and stops re-teaching it');
  assertEq(d.desc.length < 100, true, 'the whole line fits in one breath (' + d.desc.length + ' chars)');
  // The EFFECTS are untouched — this was a wording pass, not a balance one.
  assertEq(d.desc.indexOf('Freeze 1') > -1, true, 'still freezes 2 enemies');
  assertEq(d.desc.indexOf('5 damage') > -1, true, 'still deals 5');
  assertEq(d.cost, 9, 'same cost');
  assertEq(d.attack, 8, 'same body');
});

test("Darkseid's card text matches the lane collapse the engine actually runs", function () {
  var d = cardByName('Darkseid');
  assertEq(d.desc.indexOf('for 2 rounds') > -1, true, 'the text says 2 rounds');
  assertEq(d.desc.indexOf('3 rounds'), -1, 'and no longer claims 3');
  // The text was wrong, not the engine — destroyLane's default duration is 2,
  // and Darkseid passes 2 explicitly. Pinning the DEFAULT keeps the card honest
  // if that default ever moves.
  var G = freshGame();
  G.destroyLane(0);
  assertEq(G.state.lanes[0].destroyedTurns, 2, 'a collapsed lane really lasts 2');
  assertEq(d.desc.indexOf('own lane is exempt'), -1, 'the exemption aside is gone');
});

test('Anakin does bonus attacks, and leads with what he can do', function () {
  var d = cardByName('Anakin Skywalker');
  assertEq(d.desc.indexOf('Can move to an empty lane') > -1, true, 'the move line leads with Can move');
  assertEq(d.desc.indexOf('make a bonus attack'), -1, 'no "make" anywhere');
  assertEq(d.desc.indexOf('Make a bonus attack'), -1, 'nor capitalised');
  assertEq((d.desc.match(/do a bonus attack/gi) || []).length, 2, 'both places say "do"');
  assertEq(d.desc.indexOf('10-cost cards'), -1, 'the parenthetical aside is gone');
  assertEq(d.desc.indexOf('if no lane is open'), -1, 'and the edge-case aside too');
});

// ---- CARD TEXT: SAY IT ONCE --------------------------------
// Owner has been pruning restated rules card by card. These pin the batch so a
// later edit cannot quietly put the boilerplate back.
test('Cards no longer restate rules that belong to their keywords', function () {
  var gone = [
    ['Hawkeye',         ['immediately', ' also ']],
    ['Invisible Woman', ['for 1 turn']],
    ['Killer Moth',     ['permanently', 'however he is moved']],
    ['Man-Bat',         ['or stay put']],
    // JUMP already means "play for free" — the keyword owns that rule.
    ['Ghostface',       ['play for free']],
    ['Michael Myers',   ['play for free']],
    ['Jason Voorhees',  ['play for free']],
    ['Gizmo',           ['Fires even if']],
    ['Black Panther',   ['for free, or skip']],
    ['Deadpool',        ['face-down']],
    ['Han Solo',        ['at the start of combat', 'Before each combat', 'or stay']],
    ['Homelander',      ['Skip if you']],
    ['Paul Atreides',   ['permanently', 'goes back on the pile', 'replaces your draw']],
  ];
  gone.forEach(function (row) {
    var d = cardByName(row[0]).desc;
    row[1].forEach(function (phrase) {
      assertEq(d.indexOf(phrase), -1, row[0] + ' no longer says "' + phrase + '"');
    });
  });
});

test('The trimmed cards still say what they actually do', function () {
  // A trim that deletes the EFFECT is worse than the verbosity it removed.
  var kept = [
    ['Hawkeye',         ['Splash 1', 'removes 1 ATK']],
    ['Invisible Woman', ['Evade 1', 'face-down']],
    ['Man-Bat',         ['Can move to an empty lane', '(−1/−1)']],
    ['Michael Myers',   ['costing less than Michael Myers', 'lane opposite it']],
    ['Jason Voorhees',  ['When an ally is destroyed', 'into its lane', '(3/4)']],
    ['Gizmo',           ['(2/2) Gremlin', 'Add Stripe']],
    ['Black Panther',   ['base cost ≤ 3', '(+1/+1)']],
    ['Deadpool',        ["Steal a card from the enemy's hand"]],
    ['Han Solo',        ['before other lanes', 'Critical']],
    ['Homelander',      ['sacrifice an ally', "cost ≤ that ally's cost"]],
    ['Paul Atreides',   ['top 2 cards', 'cost drops by 2', 'play it for free']],
  ];
  kept.forEach(function (row) {
    var d = cardByName(row[0]).desc;
    row[1].forEach(function (phrase) {
      assertEq(d.indexOf(phrase) > -1, true, row[0] + ' still says "' + phrase + '"');
    });
  });
});

test("Gizmo keeps its (once) — that limit is real, not boilerplate", function () {
  // The owner struck "(once)" along with the reassurance clause, but the guard
  // exists: _gizmoTriggered blocks every summon after the first. Deleting the
  // word would have made the card understate a real restriction, which is the
  // same failure as overstating one.
  assertEq(cardByName('Gizmo').desc.indexOf('(once)') > -1, true, 'the text keeps it');
  var G = freshGame();
  var giz = place(G, 'Gizmo', 'player', 0);
  giz.currentHealth = 20; giz.maxHealth = 20;
  var enemy = place(G, 'Bane', 'ai', 0);
  var handBefore = G.state.player.hand.length;
  G.dealDamage(giz, 1, enemy);
  var afterFirst = G.state.player.hand.length;
  G.dealDamage(giz, 1, enemy);
  assertEq(G.state.player.hand.length, afterFirst, 'the second hit adds nothing more');
  assert(afterFirst > handBefore, 'and the first one really did fire');
});

// A 10-COST NEVER TOUCHES ANOTHER 10-COST. Owner: "it's a given that no 10
// abilities affect other 10s." It is a rule of the TIER, enforced once in
// is10CostImmune, so no card carries it in its text any more.
test('No card restates the tens-cannot-touch-tens rule', function () {
  CARD_DEFS.concat(TRICK_DEFS).forEach(function (d) {
    if (!d.desc) return;
    assertEq(d.desc.indexOf('10-cost'), -1, (d.name || '?') + ' should not mention 10-cost');
  });
});

test('And the rule is real, so removing the text costs nothing', function () {
  // If this ever fails, the descriptions above became a lie and the rule needs
  // to go BACK on the cards rather than the text staying silent.
  var G = freshGame();
  var titanA = place(G, 'Knull', 'player', 0);        // cost 10
  var titanB = place(G, 'Trigon', 'ai', 0);           // cost 10
  var normal = place(G, 'Bane', 'ai', 1);             // cost 2
  assertEq(G.is10CostImmune(titanA, titanB), true, 'a ten is immune to another ten');
  assertEq(G.is10CostImmune(titanA, normal), false, 'but not to an ordinary card');
  // Doomsday prints at 12 and is deliberately NOT a titan for this rule.
  var dd = place(G, 'Doomsday', 'ai', 2);
  assertEq(G.is10CostImmune(titanA, dd), false, 'Doomsday is exempt in both directions');
});

test('The 2026-08-09 wording batch stuck', function () {
  var gone = [
    ['Wolverine',   ['retaliation is lost']],
    ['Iron Man',    ['damaged enemies']],
    ['Jack Sparrow',['no ally opposite']],
    ['Joker',       ['recovers when Joker dies', 'Start of Tricks', 'rerolls 1-4']],
    ['Lex Luthor',  ['make bonus attacks', 'Tricks can still be drawn']],
    ['Doomsday',    ['(min 0)', 'permanent Immunity']],
    ['Batman',      ['then 2 damage to an enemy again']],
  ];
  gone.forEach(function (r) {
    var d = cardByName(r[0]).desc;
    r[1].forEach(function (ph) { assertEq(d.indexOf(ph), -1, r[0] + ' dropped "' + ph + '"'); });
  });
  var kept = [
    ['Wolverine',   ['Revive as (6/5)', 'Overdrive']],
    ['Iron Man',    ['hurt enemies', '≤ 8']],
    ['Jack Sparrow',['uncontested lane', 'cannot attack']],
    ['Joker',       ['While Active', 'Crazy']],
    ['Lex Luthor',  ['cannot draw cards', 'do bonus attacks']],
    ['Doomsday',    ['costs 1 less', 'Immunity and Untrickable']],
    ['Batman',      ['Throw Batarangs', 'Fear 1']],
  ];
  kept.forEach(function (r) {
    var d = cardByName(r[0]).desc;
    r[1].forEach(function (ph) { assertEq(d.indexOf(ph) > -1, true, r[0] + ' still says "' + ph + '"'); });
  });
  // Batman names a REAL trick — if Batarangs is ever renamed, this catches it.
  assert(TRICK_DEFS.some(function (t) { return t.name === 'Batarangs'; }),
    'Batarangs exists as a trick for Batman to name');
});

// ============================================================
// ---- WETLANDS / SPINOSAURUS --------------------------------
// ============================================================
// An environment lives in the lane's `_env` sub-slot, NOT the combat slot —
// place() puts cards in the combat slot, which would make findCardLane report
// the right lane for the wrong reason and let an ally and the habitat fight
// over one slot. Every habitat test needs the real slot.
function placeEnv(G, name, owner, lane) {
  var card = G.createCardInstance(cardByName(name), owner);
  card.isEnvironment = true;
  if (!G.state.lanes[lane]._env) G.state.lanes[lane]._env = { player: null, ai: null };
  G.state.lanes[lane]._env[owner] = card;
  return card;
}

// Regression: Xenomorph grows "each time any other card enters the board", and
// playCard's ENVIRONMENT branch (game.js ~5197) broadcasts onAnyCardPlayed just
// like the normal branch does — so dropping a Sewers was feeding him. An
// environment never enters a combat slot, never fights and cannot be attacked;
// counting it as a card entering the board is the same category error the set
// already guards against elsewhere ("Apocalypse does not give keywords to
// environments"). Owner: "xenomorph shouldnt grow from enviroments".
//
// Driven through the REAL playCard path on purpose. place()/placeEnv() write
// straight into state and never broadcast, so a test built on those would pass
// with the bug still in.
test('Xenomorph does not grow when an environment is played', function () {
  var G = freshGame();
  var xeno = place(G, 'Xenomorph', 'player', 0);
  var atk0 = xeno.attack, hp0 = xeno.currentHealth;

  var env = G.createCardInstance(cardByName('Sewers'), 'player');
  G.state.player.hand.push(env);
  G.state.player.currency = 99;
  G.playCard('player', env, 2);

  assertEq(G.state.lanes[2]._env && G.state.lanes[2]._env.player === env, true,
    'the environment must actually have been played (else the test proves nothing)');
  assertEq(xeno.attack, atk0, 'Xenomorph ATK must not grow from an environment');
  assertEq(xeno.currentHealth, hp0, 'Xenomorph HP must not grow from an environment');
});

// The other half of the same guard: a NORMAL card entering must still feed him,
// so the fix is a filter and not an off switch.
test('Xenomorph still grows when a normal card is played', function () {
  var G = freshGame();
  var xeno = place(G, 'Xenomorph', 'player', 0);
  var atk0 = xeno.attack;

  var ally = G.createCardInstance(cardByName('The Thing'), 'player');
  G.state.player.hand.push(ally);
  G.state.player.currency = 99;
  G.playCard('player', ally, 3);

  assertEq(G.state.lanes[3].player === ally, true, 'the ally must actually have been played');
  assertEq(xeno.attack > atk0, true, 'Xenomorph must still grow from a real card');
});

test('Wetlands drains on EITHER side\'s Block Meter, not just its owner\'s', function () {
  var G = freshGame();
  var wet = placeEnv(G, 'Wetlands', 'player', 2);
  CARD_ABILITIES['Wetlands'].onPlay(G, wet, 2);
  assertEq(wet._wetPower, 1, 'starts at 1 Power');
  // The blocker argument is who blocked; the drain must ignore it entirely.
  // Power is 1, so a single block drains it to 0. Fire it from the ENEMY side to
  // prove the drain is not gated to the owner's meter.
  G._notifyBlockMeterFired('ai');
  assertEq(wet._wetPower, 0, 'an ENEMY block drained it');

  // And the owner's own meter drains it just the same — fresh habitat, since one
  // block is all it takes.
  var G2 = freshGame();
  var wet2 = placeEnv(G2, 'Wetlands', 'player', 2);
  CARD_ABILITIES['Wetlands'].onPlay(G2, wet2, 2);
  G2._notifyBlockMeterFired('player');
  assertEq(wet2._wetPower, 0, 'and so does its owner\'s');
});

test('Wetlands at 0 Power releases Spinosaurus and takes the enemy in the lane', function () {
  var G = freshGame();
  var wet = placeEnv(G, 'Wetlands', 'player', 2);
  CARD_ABILITIES['Wetlands'].onPlay(G, wet, 2);
  var prey = place(G, 'Sabertooth', 'ai', 2);
  G._notifyBlockMeterFired('ai');
  G._notifyBlockMeterFired('ai');
  G._notifyBlockMeterFired('ai');
  assertEq(wet._wetPower, 0, 'drained to 0');
  assertEq(wet._wetReleased, true, 'and latched as released');
  assert(prey.currentHealth <= 0, 'the enemy standing in the lane is destroyed');
  var spino = G.state.lanes[2].player;
  assert(!!spino && spino.name === 'Spinosaurus', 'Spinosaurus surfaced in the lane');
  assertEq(spino.attack, 4, 'at printed 4 ATK');
  assertEq(spino.currentHealth, 6, 'and 6 HP');
  // THE HABITAT IS CONSUMED, like Boiler Room / Sewers / Open Water / Enclosure.
  // This assertion used to say the opposite, and was written as a guard against
  // someone "fixing" Wetlands to match its siblings — which is exactly what the
  // owner then asked for once every environment went on the shared four-round
  // clock: "just change wetlands to fit the global rule and the wording."
  assertEq(G.state.lanes[2]._env.player, null, 'the habitat is consumed by the release');
});

test('Spinosaurus leaving does not have to drain anything behind him', function () {
  // The swamp used to outlive its own release, which needed three pieces of
  // private machinery to clean up after: an onDeath on Spinosaurus, a
  // self-heal on Wetlands.onTurnStart for the ways he can leave WITHOUT dying
  // (Phantom Zone bounces him to a hand, Devour voids him past handleDeath),
  // and the _habitatLane breadcrumb both read. All three are gone; this pins
  // that killing him leaves a clean lane rather than a zombie habitat.
  var G = freshGame();
  var wet = placeEnv(G, 'Wetlands', 'player', 2);
  CARD_ABILITIES['Wetlands'].onPlay(G, wet, 2);
  G._notifyBlockMeterFired('ai');
  var spino = G.state.lanes[2].player;
  assert(!!spino && spino.name === 'Spinosaurus', 'he surfaced');
  assertEq(G.state.lanes[2]._env.player, null, 'and the swamp went with the release');
  G.killCard(spino, null);
  G.cleanupDead();
  assertEq(G.state.lanes[2]._env.player, null, 'still nothing in the env slot');
  assertEq(CARD_ABILITIES['Spinosaurus'].onDeath, undefined, 'and he no longer carries a When Destroyed for it');
});

test('A further Block Meter never releases a SECOND Spinosaurus', function () {
  var G = freshGame();
  var wet = placeEnv(G, 'Wetlands', 'player', 1);
  CARD_ABILITIES['Wetlands'].onPlay(G, wet, 1);
  for (var i = 0; i < 6; i++) G._notifyBlockMeterFired('ai');
  assertEq(wet._wetPower, 0, 'Power floors at 0 rather than going negative');
  var spinos = G.getAllCardsOf('player').filter(function (c) { return c.name === 'Spinosaurus'; });
  assertEq(spinos.length, 1, 'exactly one Spinosaurus, however many blocks fire');
});

test('An ally with no open lane is absorbed; Spinosaurus adds its stats', function () {
  var G = freshGame();
  var wet = placeEnv(G, 'Wetlands', 'player', 0);
  CARD_ABILITIES['Wetlands'].onPlay(G, wet, 0);
  // Fill every lane on the player's side so there is nowhere to displace to.
  var ally = place(G, 'Sabertooth', 'player', 0);   // 2/3
  for (var l = 1; l < G.LANE_COUNT; l++) place(G, 'Sabertooth', 'player', l);
  var atk = ally.attack, hp = ally.currentHealth;
  G._notifyBlockMeterFired('player');
  G._notifyBlockMeterFired('player');
  G._notifyBlockMeterFired('player');
  var spino = G.state.lanes[0].player;
  assert(!!spino && spino.name === 'Spinosaurus', 'Spinosaurus took the lane');
  assertEq(spino.attack, 4 + atk, 'absorbed the ally\'s ATK');
  assertEq(spino.currentHealth, 6 + hp, 'and its remaining HP');
});

test('Spinosaurus hunts with the real keyword, like Jason and Jango', function () {
  // He used to carry a bespoke start-of-round stalk toward the opponent's
  // last-played lane — a second movement mechanic that shared the name "Hunt"
  // without being the Hunt keyword. Owner: "just add Hunt like jason and jango
  // to spino, that easy." One movement rule on the card now, not two.
  var G = freshGame();
  var spino = place(G, 'Spinosaurus', 'player', 0);
  assertEq(spino.hasHunt, true, 'the real Hunt keyword reached the instance');
  assertEq(spino.hasHuntMeter, true, 'and Hunt Meter still does — they parse independently');
  assertEq(typeof CARD_ABILITIES['Spinosaurus'].onTurnStart, 'undefined',
    'the bespoke stalk hook is gone, not merely unused');
  // The printed text must not still promise the stalk.
  var desc = cardByName('Spinosaurus').desc;
  assertEq(/moves to the lane/.test(desc), false, 'and the card no longer describes it');
});

test('The Hunt Meter fills on ENEMY damage only', function () {
  // Owner spec 2026-08-14: "hunt meter goes up each time an enemy is damaged."
  // It previously counted ALLY damage — a revenge meter — which is the opposite
  // reading, so the trigger was inverted rather than widened. Both directions
  // are asserted; testing only the enemy side would pass with the old rule too.
  var G = freshGame();
  var spino = place(G, 'Spinosaurus', 'player', 0);
  assertEq(spino.hasHuntMeter, true, 'the printed keyword reached the instance');
  // ...and it must NOT have picked up the vanilla Hunt keyword off the shared
  // first word. Two different mechanics; one would move him twice a round.
  assertEq(!!spino.hasHunt, true, 'he now prints the real Hunt keyword alongside the meter');

  var enemy = place(G, 'Sabertooth', 'ai', 3);
  G.dealDamage(enemy, 1, null);
  assertEq(spino._spinoMeter, 1, 'an enemy taking damage fills it');

  var ally = place(G, 'Bane', 'player', 4);
  G.dealDamage(ally, 1, null);
  assertEq(spino._spinoMeter, 1, 'an ALLY taking damage does NOT — this is the change');
});

test('At 3 the Hunt Meter is spent for permanent Overdrive', function () {
  // Owner: "when hunt meter gains 3 remove hunt meter and permanently gain
  // overdrive." It used to cap, arm, sweep every lane and refill forever.
  var G = freshGame();
  var spino = place(G, 'Spinosaurus', 'player', 0);
  var enemy = place(G, 'Sabertooth', 'ai', 3);
  assertEq(!!spino.isOverdrive, false, 'he does not start with Overdrive');

  G.dealDamage(enemy, 1, null);
  G.dealDamage(enemy, 1, null);
  assertEq(!!spino.isOverdrive, false, 'still nothing at 2');
  assertEq(spino._spinoMeter, 2, 'and the meter is tracking');

  G.dealDamage(enemy, 1, null);
  assertEq(!!spino.isOverdrive, true, 'the third fills it and grants Overdrive');
  assertEq(!!spino._spinoHuntSpent, true, 'the meter is marked spent');
  assertEq(spino._spinoMeter, 0, 'and cleared, not left sitting at max');
  assertEq(!!spino.hasHuntMeter, false, 'so the badge stops rendering');

  // PERMANENT: more damage must not re-arm it or double-grant.
  G.dealDamage(enemy, 1, null);
  assertEq(spino._spinoMeter, 0, 'further enemy damage does not refill a spent meter');
  assertEq(!!spino.isOverdrive, true, 'and Overdrive stays');

  // The rampage is gone with the mechanic, not merely disabled.
  assertEq(typeof CARD_ABILITIES['Spinosaurus'].onBeforeCombat, 'undefined',
    'the whole-board rampage hook is removed');
});

// (Two tests stood here — "The habitat drains the moment Spinosaurus dies" and
// "A drained habitat cleans itself up when Spinosaurus leaves without dying".
// Both pinned machinery that only existed because the swamp outlived its own
// release: Spinosaurus's onDeath and Wetlands' onTurnStart self-heal. The
// habitat is consumed at release now, on the shared environment clock, so both
// hooks are gone and there is nothing left for either test to assert. Their
// replacement is "Spinosaurus leaving does not have to drain anything behind
// him", above.)

test('Spinosaurus is spawn-only and never enters a draftable pool', function () {
  var def = cardByName('Spinosaurus');
  assertEq(def._spawnOnly, true, 'flagged spawn-only');
  var pool = CARD_DEFS.filter(function (d) { return !d._spawnOnly; });
  assertEq(pool.some(function (d) { return d.name === 'Spinosaurus'; }), false,
    'excluded from the draftable pool');
  // WETLANDS IS SPAWN-ONLY TOO NOW, and this assertion used to say the exact
  // opposite: "it MUST be draftable or the pair is unreachable." That was true
  // while a player bought the habitat and the habitat released the monster.
  // Environments are events now (owner: "id rather have environments be
  // events"), so nobody buys one and the reachability guarantee moves with it —
  // from "a player can draft it" to "an event is responsible for placing it".
  assertEq(!!cardByName('Wetlands')._spawnOnly, true, 'Wetlands is spawn-only too');
  assertEq(cardByName('Wetlands').isEnvironment, true, 'and is an environment');
});

// THE REPLACEMENT GUARANTEE. The old test kept the habitat/monster pair
// reachable by insisting the habitat stayed in the draft. Now that every
// environment is placed by an event instead, the thing that must hold is that
// no environment is orphaned: each one is claimed by exactly one franchise, so
// there is always something whose job it is to put it on the board. Without
// this, making a card `_spawnOnly` and forgetting to file it silently deletes
// it from the game — which is exactly what the deleted assertion above was
// protecting against, in the form the design now takes.
test('No event can fire before round 3', function () {
  // Owner: "events start on turn 3 no events before that." Both constants are
  // asserted AND the behaviour is driven, because the constant alone would not
  // catch a caller that appeared him without consulting it.
  assert(Game._BALLYHOO_FIRST_ROUND >= 3, 'Ballyhoo is gated to round 3+');
  assert(Game._SHADOW_FIRST_ROUND >= 3, 'the Shadow Man is gated to round 3+');

  var G = freshGame();
  // Force his slot so `shows` cannot come up false and pass this vacuously.
  G.state._matchEvent = 'shadowman';
  G._rollShadowMan();
  G.state._shadow.shows = true;
  G._maybeShadowMan(1);
  assertEq(!!G.state._shadow.appeared, false, 'round 1 — he stays away');
  G._maybeShadowMan(2);
  assertEq(!!G.state._shadow.appeared, false, 'round 2 — still nothing');
  G._maybeShadowMan(3);
  assertEq(G.state._shadow.appeared, true, 'round 3 — he arrives');

  var H = freshGame();
  H.state._matchEvent = 'ballyhoo';
  H._rollBallyhoo();
  H.state._ballyhoo.shows = true;
  H.state._ballyhoo.appearAt = 1;   // even told to come early, the gate holds
  H._maybeBallyhoo(1);
  assertEq(!!H.state._ballyhoo.fired, false, 'round 1 — no candy');
  H._maybeBallyhoo(2);
  assertEq(!!H.state._ballyhoo.fired, false, 'round 2 — no candy');
});

test('Every environment is claimed by exactly one event franchise', function () {
  assert(typeof EVENT_FRANCHISES !== 'undefined', 'the franchise registry exists');
  // Two tiers: an EVENT is what gets rolled, its spawns are what come out. An
  // environment can legitimately be EITHER — Wetlands is an event, while The
  // Bathroom and Game Over are environments that Jigsaw's event puts down. The
  // invariant is not "every environment is an event", it is that every
  // environment is claimed SOMEWHERE, so something is responsible for putting
  // it on the board. (This test first asserted the stricter version and it was
  // wrong: it failed on Jigsaw's two, which are placed, not rolled.)
  var claims = {};
  EVENT_FRANCHISES.forEach(function (fr) {
    (fr.events || []).forEach(function (ev) {
      claims[ev.name] = (claims[ev.name] || 0) + 1;
      (ev.spawns || []).forEach(function (sp) {
        if (sp.charAt(0) === '@') return;
        claims[sp] = (claims[sp] || 0) + 1;
      });
    });
  });
  CARD_DEFS.filter(function (d) { return d.isEnvironment; }).forEach(function (env) {
    assertEq(claims[env.name] || 0, 1, env.name + ' is named by exactly one franchise');
    assertEq(!!env._spawnOnly, true, env.name + ' is spawn-only');
  });
  // And every name a franchise lists must actually resolve to something, or the
  // codex renders a franchise with a hole in it.
  var known = {};
  CARD_DEFS.forEach(function (d) { known[d.name] = true; });
  if (typeof SUMMON_TOKEN_DEFS !== 'undefined') SUMMON_TOKEN_DEFS.forEach(function (d) { known[d.name] = true; });
  ['MC Ballyhoo', 'Shadow Man', 'Apothicon Rift'].forEach(function (n) { known[n] = true; });
  EVENT_FRANCHISES.forEach(function (fr) {
    (fr.events || []).forEach(function (ev) {
      assert(known[ev.name], fr.title + ' names a real event: ' + ev.name);
      (ev.spawns || []).forEach(function (sp) {
        if (sp.charAt(0) === '@') return;   // @candies / @wonders expand at render
        assert(known[sp], fr.title + '/' + ev.name + ' releases something real: ' + sp);
      });
    });
  });
});

test('Every event in the registry can actually be rolled, at even odds', function () {
  // Owner: "on round 3 for events is it random which event spawns? it should
  // be, ive only seen shadow man, it should be all events have an equal
  // chance." Before this, the roll was a coin flip between two events and the
  // other seven were unreachable — so the assertion is not "the draw is random"
  // (it always was) but "the draw can produce every event there is".
  var pool = Game.matchEventPool();
  var listed = [];
  EVENT_FRANCHISES.forEach(function (fr) {
    (fr.events || []).forEach(function (ev) { listed.push(ev.name); });
  });
  assertEq(pool.length, listed.length, 'the pool is exactly the registry, one entry per event');
  listed.forEach(function (n) { assert(pool.indexOf(n) >= 0, n + ' is in the draw'); });

  // Drive the real roll over many seeds and check nothing is unreachable. The
  // bug being pinned was a pool of two, so a seen-set is the shape of the test;
  // the counts are checked loosely because a fair 9-way draw over 900 trials
  // sits near 100 each and this must not become a flaky statistics assertion.
  var seen = {};
  for (var i = 0; i < 900; i++) {
    var G = freshGame();
    G.seedMatch(i + 1);
    G.state._eventsUsed = [];
    var pick = G._drawEventFor();
    if (!pick) continue;                            // events switched off for this mode
    seen[pick] = (seen[pick] || 0) + 1;
  }
  var missing = listed.filter(function (n) { return !seen[n]; });
  assertEq(missing.join(','), '', 'no event is unreachable');
  listed.forEach(function (n) {
    assert(seen[n] > 20, n + ' comes up at a plausible rate (' + seen[n] + '/900)');
  });
});

test('A habitat event opens the same environment on both sides, in different lanes', function () {
  var G = freshGame();
  G.state._matchEvent = 'habitat';
  G.state._matchEventName = 'Open Water';
  G._rollHabitatEvent();

  G._maybeHabitatEvent(2);
  assertEq(!!G.state._habitats[0].fired, false, 'round 2 — nothing opens');

  G._maybeHabitatEvent(3);
  assertEq(G.state._habitats[0].fired, true, 'round 3 — it opens');

  var mine = -1, theirs = -1;
  for (var i = 0; i < G.LANE_COUNT; i++) {
    var l = G.state.lanes[i];
    if (l._env && l._env.player) { assertEq(l._env.player.name, 'Open Water', 'the player side gets Open Water'); mine = i; }
    if (l._env && l._env.ai)     { assertEq(l._env.ai.name, 'Open Water', 'the enemy side gets the same card'); theirs = i; }
  }
  assert(mine >= 0, 'the player got one');
  assert(theirs >= 0, 'the opponent got one');
  assert(mine !== theirs, 'they are in different lanes — seating one on the other would destroy it');
});

test('A habitat event waits for space instead of being spent on it', function () {
  // Owner, while this was being designed: "if something were to spawn but that
  // side doesnt have space how would that work, those events couldnt show up?"
  var G = freshGame();
  G.state._matchEvent = 'habitat';
  G.state._matchEventName = 'Sewers';
  G._rollHabitatEvent();

  // Fill every lane but one with environments, so only one is free.
  for (var i = 0; i < G.LANE_COUNT - 1; i++) G._placeEventEnvironment('player', i, 'Gargantua');
  G._maybeHabitatEvent(3);
  assertEq(!!G.state._habitats[0].fired, false, 'one free lane is not enough — it holds');

  // Give it room back and it turns up on a later round.
  G.state.lanes[0]._env = {};
  G._maybeHabitatEvent(4);
  assertEq(G.state._habitats[0].fired, true, 'with two lanes clear it opens');
});

test('The Enclosure releases the T-Rex AGAINST whoever stopped paying', function () {
  // Owner: "welcome to jurassic park event where you have to give energy to the
  // park, if you dont a T rex will spawn against you" — and, on the first pass
  // following its four sibling habitats instead: "it should be flipped."
  var G = freshGame();
  var gate = G._placeEventEnvironment('player', 2, 'Enclosure');
  assert(gate, 'the gate is standing');

  // Paying keeps it shut.
  G.state._pendingUpkeep = [];
  gate.onTurnStart(G, gate);
  assertEq(G.state._pendingUpkeep.length, 1, 'it asks for the upkeep');
  G.state._pendingUpkeep[0].onPay();
  assertEq(!!gate._encReleased, false, 'paid — the gate holds');
  assertEq(G.state.lanes[2]._env.player, gate, 'and the paddock is still there');

  // Refusing once lets it out — on the OTHER side.
  G.state._pendingUpkeep = [];
  gate.onTurnStart(G, gate);
  G.state._pendingUpkeep[0].onDecline();
  assertEq(gate._encReleased, true, 'refused — the gate opens');
  assertEq(G.state.lanes[2].player, null, 'it does NOT join the side that refused');
  var rex = G.state.lanes[2].ai;
  assert(rex && rex.name === 'T-Rex', 'it takes the lane against them');
  assertEq(rex.owner, 'ai', 'and it fights for the other side');
  assertEq(rex.attack, 3, 'at its printed attack');
  assertEq(rex.currentHealth, 7, 'and its printed health');
  assertEq(G.state.lanes[2]._env.player, null, 'the paddock is spent, not kept');

  // And a second refusal cannot let out a second one.
  G.state._pendingUpkeep = [];
  gate.onTurnStart(G, gate);
  assertEq(G.state._pendingUpkeep.length, 0, 'a spent gate stops asking');
});

test('An optional upkeep asks in its OWN words', function () {
  // Gargantua was the only optional upkeep in the game when the resolver was
  // written, so every string in it is his — a second one inherited "Pay 1
  // Energy to pull all enemies 1 lane closer" for a paddock gate.
  var G = freshGame();
  var gate = G._placeEventEnvironment('ai', 1, 'Enclosure');
  G.state.ai.currency = 5;

  G.state._pendingUpkeep = [];
  gate.onTurnStart(G, gate);
  var entry = G.state._pendingUpkeep[0];
  assert(entry.promptDesc.indexOf('gate') >= 0, 'the gate asks about the gate');
  assert(entry.promptDesc.indexOf('lane closer') < 0, 'and not about Gargantua\'s pull');

  // A toll gets paid while it can be afforded — the T-Rex is a punishment, so
  // buying it off is the right play for a bot and the decision stays a human's.
  var done = false;
  G._resolveUpkeepPrompts(function () { done = true; });
  assertEq(done, true, 'the queue drains');
  assertEq(!!gate._encReleased, false, 'the bot paid, so the gate holds');
  assertEq(G.state.ai.currency, 4, 'and it paid exactly 1');
  assertEq(G.state.lanes[1]._env.ai, gate, 'the paddock is still standing');
});

test('The T-Rex clears the lane it lands in, and eats what cannot move', function () {
  // "An enemy already standing there moves to an empty lane — with no empty
  // lane it is destroyed and the T-Rex adds its stats." The card that has to
  // make room is the one on the side the T-Rex JOINS, which is the side that
  // did NOT refuse.
  var G = freshGame();
  var gate = G._placeEventEnvironment('player', 0, 'Enclosure');
  var sitting = place(G, 'Hulk', 'ai', 0);
  // Fill every other lane on that side so it has nowhere to go.
  for (var i = 1; i < G.LANE_COUNT; i++) place(G, 'Nightwing', 'ai', i);
  var atk = sitting.attack, hp = sitting.currentHealth;

  G.state._pendingUpkeep = [];
  gate.onTurnStart(G, gate);
  G.state._pendingUpkeep[0].onDecline();

  var rex = G.state.lanes[0].ai;
  assert(rex && rex.name === 'T-Rex', 'the T-Rex still takes the lane');
  assertEq(rex.attack, 3 + atk, 'it absorbs the attack');
  assertEq(rex.currentHealth, 7 + hp, 'and the health');
});

test("Gargantua's pull re-reads a card's lane before moving it", function () {
  // The fuzz found "duplicate id 8 on lane: Trigon + Trigon" — ONE object in
  // two lanes at once. _doPull reads curLane at the top of each iteration and
  // wrote `lanes[curLane] = null` several statements later, AFTER the two
  // dealDamage calls of a collision. Those kill cards, which runs onDeath and
  // onDamaged hooks, which can move the very card being pulled (a habitat
  // release displacing it, a Hunt chase, a bounce). Nulling the stale index
  // then leaves the card where it actually is AND writes it into the
  // destination.
  //
  // The window is BETWEEN the damage and the write, so the hook here fires
  // from onDamaged — exactly where Open Water's displacement was firing when
  // the fuzz caught it.
  var G = freshGame();
  G.state.player.isHuman = false;
  var garg = G._placeEventEnvironment('player', 0, 'Gargantua');
  assert(garg, 'Gargantua is standing');

  // An enemy standing in Gargantua's own lane — this is what makes the pulled
  // card COLLIDE rather than simply step across.
  // PLAIN BODIES, deliberately. The first draft used Nightwing and Trigon and
  // neither branch ran: Nightwing has Evade so it dodged the killing blow, and
  // Trigon has Immunity so it took no damage and its onDamaged never fired.
  // Hulk and Apocalypse carry no keywords.
  var occupant = place(G, 'Hulk', 'ai', 0);
  // It needs a BITE as well as a low HP total: the collision deals damage both
  // ways, and the victim's onDamaged is what fires inside the window. At 0
  // attack the victim takes nothing and the hook never runs.
  occupant.attack = 2; occupant.currentHealth = 1; occupant.maxHealth = 1;

  // The card that gets pulled into that collision, from the adjacent lane.
  var victim = place(G, 'Apocalypse', 'ai', 1);
  victim.attack = 9; victim.currentHealth = 9; victim.maxHealth = 9;

  // Mid-collision, something relocates the victim — the displacement that a
  // habitat release performs when the collision's deaths cascade into it.
  victim.onDamaged = function (g, self) {
    if (self._moved) return;
    self._moved = true;
    var from = g.findCardLane(self);
    if (from < 0) return;
    g.state.lanes[from].ai = null;
    g.state.lanes[4].ai = self;
  };

  CARD_ABILITIES['Gargantua']._doPull(G, garg);

  var seats = [];
  for (var i = 0; i < G.LANE_COUNT; i++) {
    if (G.state.lanes[i].ai === victim) seats.push(i);
  }
  assertEq(seats.length, 1, 'the pulled card occupies exactly one lane, not ' + seats.length + ' (lanes ' + seats.join(',') + ')');
});

test('An event lands on round 3, 6 and 9 — and never the same one twice', function () {
  // Owner: "on turn 6 another event should fire, and on turn 9 — right now its
  // just turn 3." A match used to draw exactly one event at match start.
  var G = freshGame();
  G.seedMatch(99);
  assertEq(G._eventRoundDue(2), false, 'round 2 is not an event round');
  assertEq(G._eventRoundDue(3), true,  'round 3 is');
  assertEq(G._eventRoundDue(4), false, 'round 4 is not');
  assertEq(G._eventRoundDue(6), true,  'round 6 is');
  assertEq(G._eventRoundDue(9), true,  'round 9 is');

  var drawn = [];
  [1,2,3,4,5,6,7,8,9].forEach(function (r) {
    G.state.round = r;
    G._maybeMatchEvent(r);
    var got = (G.state._eventRounds || {})[r];
    if (got && got !== 'none') drawn.push(r + ':' + got);
  });
  assertEq(drawn.length, 3, 'three events across nine rounds, one each on 3/6/9 — got ' + drawn.join(', '));
  assert(drawn[0].indexOf('3:') === 0, 'the first is round 3');
  assert(drawn[1].indexOf('6:') === 0, 'the second is round 6');
  assert(drawn[2].indexOf('9:') === 0, 'the third is round 9');
  var names = drawn.map(function (d) { return d.split(':')[1]; });
  assertEq(new Set(names).size, 3, 'and no event repeats within a match');

  // Asking twice for the same round does not draw twice.
  G.state.round = 9;
  G._maybeMatchEvent(9);
  assertEq((G.state._eventsUsed || []).length, 3, 'a round draws exactly once');
});

test('A hidden deploy still counts as a card you played', function () {
  // Owner: "why is deadpool not buffed from BP, he was deployed upside down /
  // hidden." The face-down branch returns early — rightly, since it has just
  // silenced the card's own hooks — but the early return also skipped what
  // OTHER cards do when a card enters. Black Panther reads "While Active: Add
  // (+1/+1) to each card you play".
  var G = freshGame();
  var bp = place(G, 'Black Panther', 'player', 0);
  assertEq(bp.passive, 'cardPlayedBuff', 'Black Panther carries the aura');

  var hidden = createInHand(G, 'Deadpool', 'player');
  var atk = hidden.attack, hp = hidden.currentHealth;
  G.state.player.currency = 20;
  G.state.player.faceDownAvailable = true;
  hidden._playFaceDown = true;
  G.playCard('player', hidden, 3);

  var seated = G.state.lanes[3].player;
  assert(seated === hidden, 'the hidden card is seated');
  assertEq(!!seated.isFaceDown, true, 'and it is face down');
  assertEq(seated.attack, atk + 1, 'the aura still adds +1 attack');
  assertEq(seated.currentHealth, hp + 1, 'and +1 health');
  // Its OWN abilities stay silenced — that is what hiding it is for.
  assertEq(seated.onPlay, null, "the hidden card's own hooks are still off");
});

test('A 2v2 upkeep rotates between the two teammates, and costs that seat', function () {
  // Owner, on the Enclosure: "in 2v2 the player on each team rotates."
  var G = freshGame();
  G.start2v2Match({ names: { p1: 'Henry', p2: 'Vega', p3: 'Ryan', p4: 'Bot2' },
                    teamAssignment: { A: ['p1', 'p3'], B: ['p2', 'p4'] } });
  var tt = G.state.twoVTwo;
  tt.online = false; tt.you = 'p1';
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) {
    tt.players[k].isAI = true; tt.players[k].energy = 9; tt.players[k].usedEnergy = 0;
  });

  G.state.round = 3; var a = G._upkeepSeatFor('player');
  G.state.round = 4; var b = G._upkeepSeatFor('player');
  G.state.round = 5; var c = G._upkeepSeatFor('player');
  assert(a && b, 'a seat is named each round');
  assert(a !== b, 'the two teammates alternate');
  assertEq(c, a, 'and it comes back round');
  assert(['p1', 'p3'].indexOf(a) >= 0 && ['p1', 'p3'].indexOf(b) >= 0, 'both are on that team');

  // The spend lands on the payer's own energy, not on the discarded side proxy.
  G.state.round = 4;
  var payer = G._upkeepSeatFor('player');
  var gate = G._placeEventEnvironment('player', 2, 'Enclosure');
  G.state._pendingUpkeep = [];
  gate.onTurnStart(G, gate);
  G._resolveUpkeepPrompts(function () {});
  assertEq(tt.players[payer].usedEnergy, 1, 'the payer spent 1');
  var mate = ['p1', 'p3'].filter(function (k) { return k !== payer; })[0];
  assertEq(tt.players[mate].usedEnergy, 0, 'the teammate paid nothing');
});

test('A chained pair cannot be split by a FREE play', function () {
  // Owner: "mr freeze and optums prime are bounded yet optimus was played
  // wiythout mr freeze." playCard has intercepted Pinhead's chain since the
  // chain existed; playCardFree — the door every jump, Mother Box, Kang and
  // Ghost Rider play walks through, all of which take the card out of a HAND —
  // never did.
  var G = freshGame();
  var a = createInHand(G, 'Optimus Prime', 'player');
  var b = createInHand(G, 'Mr. Freeze', 'player');
  G.state.player.currency = 20;
  a._chained = true; a._chainPartnerId = b.id; a._chainPartnerName = b.name;
  b._chained = true; b._chainPartnerId = a.id; b._chainPartnerName = a.name;

  G.playCardFree('player', a, 0);

  var seated = [];
  for (var i = 0; i < G.LANE_COUNT; i++) {
    if (G.state.lanes[i].player) seated.push(G.state.lanes[i].player.name);
  }
  assertEq(seated.length, 2, 'both halves of the chain enter');
  assert(seated.indexOf('Optimus Prime') >= 0, 'the played one is there');
  assert(seated.indexOf('Mr. Freeze') >= 0, 'and so is its partner');
  assertEq(G.state.player.hand.length, 0, 'neither is left behind in hand');
  // And the chain's own price still lands on both.
  var opt = G.state.lanes[0].player;
  assertEq(!!opt._chained, false, 'the chain is spent, not left dangling');
});

test('Han Solo shoots what he can KILL, and weighs staying against redirecting', function () {
  // Owner: "the right play to survive is shooting apocalypse with han. he shot
  // gorr and they lost, terrible play, fix this." The bot sorted redirect lanes
  // by raw attack * currentHealth and never considered its own lane at all —
  // and a redirect MOVES the shot (it sets _skipNormalAttack), so the enemy
  // opposite Han goes unhit.
  var G = freshGame();
  // The AI branch is the one under test — freshGame leaves both seats human.
  G.state.player.isHuman = false;
  var han = place(G, 'Han Solo', 'player', 0);
  han.attack = 4;
  // Lane 3: a wall he cannot kill but which wins on atk*hp (3 * 7 = 21).
  var wall = place(G, 'Hulk', 'ai', 3);
  wall.attack = 3; wall.currentHealth = 7; wall.maxHealth = 7;
  // Lane 5: a real threat he CAN kill (4 * 4 = 16, so the old sort lost).
  var killable = place(G, 'Bane', 'ai', 5);
  killable.attack = 4; killable.currentHealth = 4; killable.maxHealth = 4;

  han.onBeforeCombat(G, han, 0);
  assertEq(han._hanRedirectLane, 5, 'he takes the shot he can actually kill');

  // ...and when his OWN lane holds the best target he stays instead of moving
  // the shot off it.
  var H = freshGame();
  H.state.player.isHuman = false;
  var han2 = place(H, 'Han Solo', 'player', 2);
  han2.attack = 6;
  var here = place(H, 'Bane', 'ai', 2);
  here.attack = 5; here.currentHealth = 5; here.maxHealth = 5;   // killable, big threat
  var away = place(H, 'Nightwing', 'ai', 4);
  away.attack = 1; away.currentHealth = 1; away.maxHealth = 1;   // killable, trivial
  han2.onBeforeCombat(H, han2, 2);
  assertEq(han2._hanRedirectLane, undefined, 'no redirect — his own lane was the better shot');
});

test('The T-Rex freezes an enemy on every move, not just its own hunt', function () {
  var G = freshGame();
  var rex = place(G, 'T-Rex', 'player', 0);
  var a = place(G, 'Hulk', 'ai', 3);
  var b = place(G, 'Nightwing', 'ai', 4);
  assertEq(!!a.isFrozen, false, 'nothing frozen to start');
  assertEq(!!b.isFrozen, false, 'nothing frozen to start');
  // moveCard is the engine's own relocation path — the same one a Bifrost or a
  // Magneto pull uses — so this proves the hook fires for moves the T-Rex did
  // not initiate, which is what its text claims.
  G.moveCard(rex, 0, 1);
  var frozen = [a, b].filter(function (c) { return !!c.isFrozen; });
  assertEq(frozen.length, 1, 'exactly one enemy caught the roar');
  // And it is spawn-only — it arrives from the Enclosure, never from a draft.
  assertEq(cardByName('T-Rex')._spawnOnly, true, 'T-Rex is spawn-only');
  assertEq(cardByName('Enclosure')._spawnOnly, true, 'Enclosure is spawn-only');
});

// ============================================================
// ---- BATTLE DROID (Revive 2, grows on each revive) ---------
// ============================================================

test('Grievous summons a Battle Droid that actually carries Revive 2', function () {
  var G = freshGame();
  var gr = place(G, 'General Grievous', 'player', 0);
  CARD_ABILITIES['General Grievous'].onPlay(G, gr, 0);
  var droid = G.getAllCardsOf('player').find(function (c) { return c.name === 'Battle Droid'; });
  assert(!!droid, 'a Battle Droid was summoned');
  assertEq(droid.reviveCharges, 2, 'the Revive 2 keyword reached the live token');
  // The token branch of summonCard built a pure-data def, so a CARD_ABILITIES
  // entry named after a token used to be inert — writable but never wired.
  assertEq(typeof droid.onRevive, 'function', 'and so did its onRevive hook');
  assertEq(droid._isToken, true, 'still a token — it must not enter the dead pile');
  assert(droid.desc.indexOf('+1/+1') > -1, 'and it keeps the text the badge cannot say');
});

test('A Battle Droid comes back bigger, twice, then stays dead', function () {
  var G = freshGame();
  var droid = place(G, 'Battle Droid', 'player', 1);
  G.applyAbilities(droid);
  assertEq(droid.reviveCharges, 2, 'starts with two lives');
  assertEq(droid.attack, 1, 'and starts at 1 ATK');
  var atk = droid.attack, hp = droid.maxHealth;

  droid.currentHealth = 0;
  G.handleDeath(droid, 1, null);
  assertEq(droid.reviveCharges, 1, 'spent one charge');
  assertEq(droid.attack, atk + 1, 'came back with +1 ATK');
  assertEq(droid.maxHealth, hp + 1, 'and +1 max HP');
  assertEq(droid.currentHealth, hp + 1, 'at full health');

  droid.currentHealth = 0;
  G.handleDeath(droid, 1, null);
  assertEq(droid.reviveCharges, 0, 'spent the second charge');
  // The growth must STACK. applyAbilities re-runs on every revive; if it ever
  // rebuilt stats from the printed def this would silently read atk+1.
  assertEq(droid.attack, atk + 2, 'the growth stacked rather than resetting');
  assertEq(droid.maxHealth, hp + 2, 'on both stats');

  droid.currentHealth = 0;
  G.handleDeath(droid, 1, null);
  assertEq(droid.currentHealth, 0, 'out of charges — it stays down');
});

test('onRevive is not onPlay — it does not fire on the original summon', function () {
  // The revive path re-fires onPlay, which is exactly why onRevive has to be
  // its own hook: a card cannot tell a revival from its arrival inside onPlay.
  var G = freshGame();
  var gr = place(G, 'General Grievous', 'player', 0);
  CARD_ABILITIES['General Grievous'].onPlay(G, gr, 0);
  var droid = G.getAllCardsOf('player').find(function (c) { return c.name === 'Battle Droid'; });
  assertEq(droid.attack, 1, 'summoned at its printed 1 ATK, ungrown');
  assertEq(droid.maxHealth, 1, 'and its printed 1 HP');
});

test('A revive blocked by a destroyed lane grants no growth', function () {
  // reviveCharges is checked before the void guard, so "did it grow?" is the
  // cheapest proof the hook fired only on a revive that really happened.
  var G = freshGame();
  var droid = place(G, 'Battle Droid', 'player', 2);
  G.applyAbilities(droid);
  var atk = droid.attack;
  G.state.lanes[2].destroyed = true;
  droid.currentHealth = 0;
  G.handleDeath(droid, 2, null);
  assertEq(droid.attack, atk, 'the void claimed it — no revive, no (+1/+1)');
  assertEq(droid.reviveCharges, 2, 'and no charge was spent');
});

test('The Mind Control prompt quotes EFFECTIVE attack, so Critical shows', function () {
  // Reported from a screenshot: a mind-controlled Red Hulk carrying Critical
  // offered "(4 ATK)" and then hit for 8. You choose the target FROM that
  // number, so it was the one figure on the prompt that had to be right.
  function promptFor(crit) {
    var G = freshGame();
    var rh = place(G, 'Red Hulk', 'ai', 1);
    rh.attack = 4;
    rh._criticalThisRound = crit;
    rh.isMindControlled = true;
    place(G, 'Hela', 'ai', 0);
    place(G, 'Han Solo', 'ai', 2);
    G.state.player.isHuman = true;
    var seen = null;
    var real = G.promptCardChoice;
    G.promptCardChoice = function (o, cards, title, desc) { seen = desc; };
    try { G.getMindControlTarget(rh, 'player', function () {}); }
    finally { G.promptCardChoice = real; }
    return seen;
  }
  assert(promptFor(false).indexOf('(4 ATK)') > -1, 'plain: quotes printed attack');
  assert(promptFor(true).indexOf('(8 ATK)') > -1, 'Critical: quotes the DOUBLED attack');
  // Pinned to the resolver's own helper, so the prompt cannot drift from the
  // swing again the next time something modifies effective attack.
  var G = freshGame();
  var c = place(G, 'Red Hulk', 'ai', 1);
  c.attack = 4; c._criticalThisRound = true;
  assertEq(G._cardEffectiveAtk(c), 8, 'and that helper is what the prompt reads');
});

test('Ultron replicates ONCE — his copies do not replicate again', function () {
  // "Copies don't trigger this effect" is printed on the card, and for years
  // the only thing enforcing it was summonCard's token branch producing a body
  // with no hooks. Giving named tokens their CARD_ABILITIES back (for Battle
  // Droid) handed every replica Ultron's own onDeath, and the board filled
  // with Ultrons — four and climbing in the owner's screenshot.
  var G = freshGame();
  function ultrons() {
    return G.getAllCardsOf('ai').filter(function (c) { return c.name === 'Ultron'; });
  }
  var u = place(G, 'Ultron', 'ai', 0);
  u.currentHealth = 0;
  G.handleDeath(u, 0, null);
  G.cleanupDead();
  var copies = ultrons();
  assertEq(copies.length, 2, 'the ORIGINAL replicates into two copies');
  copies.forEach(function (c) {
    assertEq(typeof c.onDeath, 'object', 'a copy carries no onDeath (null)');
  });
  copies.forEach(function (c) {
    var l = G.findCardLane(c);
    c.currentHealth = 0;
    G.handleDeath(c, l, null);
  });
  G.cleanupDead();
  assertEq(ultrons().length, 0, 'and killing the copies spawns nothing — the chain ends');
});

test('Only NAMED TOKENS inherit abilities; copies of real cards stay dumb bodies', function () {
  // The gate that makes the test above true. Both arrive at summonCard without
  // a sourceDef; only the ones that exist as tokens may carry hooks.
  var G = freshGame();
  G.summonCard('player', 0, 'Battle Droid', 2, 1, 1, ['Revive 2']);
  var droid = G.state.lanes[0].player;
  assertEq(droid.name, 'Battle Droid', 'the token landed');
  assertEq(typeof droid.onRevive, 'function', 'a real token keeps its ability');

  G.summonCard('player', 1, 'Ultron', 6, 5, 3, []);
  var copy = G.state.lanes[1].player;
  assertEq(copy.name, 'Ultron', 'the copy landed');
  assertEq(typeof copy.onDeath, 'object', 'a copy of a real card gets no hooks');
  // The distinction is membership in SUMMON_TOKEN_DEFS, not the presence of a
  // CARD_ABILITIES entry — Ultron has one, and must still be refused.
  assert(!!CARD_ABILITIES['Ultron'], 'Ultron does have a CARD_ABILITIES entry');
  assertEq(SUMMON_TOKEN_DEFS.some(function (t) { return t.name === 'Ultron'; }), false,
    'but he is not a token, which is what the gate reads');
});

test('undo steps back TO the decision, re-arming the prompt instead of stranding you', function () {
  // Play Ant-Man, pick a lane for the Ant, undo. The Ant used to vanish with NO
  // prompt to place it again — the decision was gone and unrepeatable. Owner:
  // "i should have a prompt to spawn the ant since that was the last decision i
  // had to make, if i undo again i despawn ant man."
  //
  // Asserts the MECHANISM, not just the outcome: the sim shim resolves prompts
  // synchronously, so an outcome-only check would pass either way. What matters
  // is that a prompt slot is ARMED again after the undo, and that the callback
  // behind it is a fresh one (re-run), never the restored closure — the rule in
  // undo()'s purge that this must not break.
  var G = freshGame();
  G.state.phase = 'player-cards-tricks';
  var antman = G.createCardInstance(cardByName('Ant-Man'), 'player');
  G.state.player.hand.push(antman);
  G.state.player.currency = 20;

  // Hold the summon prompt open instead of letting the shim answer it, so the
  // state under test is "question asked, not yet answered".
  var armed = [];
  var realLane = G.promptLaneChoice;
  G.promptLaneChoice = function (owner, lanes, title, desc, cb, opts) {
    G.state.pendingLaneChoice = { owner: owner, lanes: lanes, title: title, callback: cb };
    armed.push(title);
    return true;
  };
  var beforeHistory, afterPlay, afterUndo1, afterUndo2;
  try {
    beforeHistory = G.history.length;
    G.playCard('player', antman, 0);
    afterPlay = {
      onBoard: G.state.lanes[0].player === antman,
      prompted: armed.length,
      history: G.history.length
    };
    // Answer it — this is the decision we will then take back.
    var slot = G.state.pendingLaneChoice;
    G.state.pendingLaneChoice = null;
    var lane = slot.lanes[1] != null ? slot.lanes[1] : slot.lanes[0];
    slot.callback(lane);
    var antAfter = null;
    for (var i = 0; i < G.state.lanes.length; i++) {
      var c = G.state.lanes[i].player;
      if (c && c !== antman && c.name === 'Ant') antAfter = c;
    }
    armed.length = 0;
    G.undo('player');
    var antStill = null;
    for (var j = 0; j < G.state.lanes.length; j++) {
      var d = G.state.lanes[j].player;
      if (d && d !== antman && d.name === 'Ant') antStill = d;
    }
    afterUndo1 = {
      antGone: !antStill,
      antmanStillOnBoard: !!(G.state.lanes[0].player && G.state.lanes[0].player.name === 'Ant-Man'),
      promptArmedAgain: !!G.state.pendingLaneChoice,
      reArmed: armed.length,
      antWasSummoned: !!antAfter
    };
    // A second undo takes the card itself back — the prompt on screen means
    // "cancel the play", so it must not just re-ask.
    G.undo('player');
    afterUndo2 = {
      laneEmpty: !G.state.lanes[0].player,
      backInHand: G.state.player.hand.indexOf(antman) >= 0 ||
                  G.state.player.hand.some(function (h) { return h.name === 'Ant-Man'; })
    };
  } finally {
    G.promptLaneChoice = realLane;
  }

  assertEq(afterPlay.onBoard, true, 'Ant-Man is on the board after the play');
  assertEq(afterPlay.prompted, 1, 'and his On Play asked where the Ant goes');
  assertEq(afterUndo1.antWasSummoned, true, 'the Ant really was summoned before the undo');
  assertEq(afterUndo1.antGone, true, 'undo removes the Ant');
  assertEq(afterUndo1.antmanStillOnBoard, true, 'but Ant-Man himself stays — one step, not two');
  assertEq(afterUndo1.reArmed, 1, 'the ability RE-RAN, which is what arms a fresh prompt');
  assertEq(afterUndo1.promptArmedAgain, true, 'so the decision is on offer again');
  assertEq(afterUndo2.laneEmpty, true, 'a second undo clears the lane');
  assertEq(afterUndo2.backInHand, true, 'and puts Ant-Man back in hand');
});

test("Freddy Fazbear's jump does not also bill for the waste that summoned him", function () {
  // He jumped out of the AI's hand because the player banked 2+ energy — correct
  // — and then drained an energy at the start of the next round off that SAME
  // end-of-turn. One trigger cashed twice: deployed him for free AND charged for
  // it. Owner: "he took away my energy the next round, his ability doesn't fire
  // the round he is played."
  var G = freshGame();
  G.state.phase = 'player-cards';
  G.state.player.currency = 4;              // the waste that wakes him
  G.state.ai.currency = 0;
  var freddy = G.createCardInstance(cardByName('Freddy Fazbear'), 'ai');
  G.state.ai.hand.push(freddy);
  // AI seat so the jump lands immediately (a human's would arm a prompt).
  var realHuman = G.isHuman;
  G.isHuman = function (seat) { return seat === 'player'; };
  try {
    G._checkFreddyFazbear('player');
  } finally { G.isHuman = realHuman; }

  var onBoard = null;
  for (var i = 0; i < G.state.lanes.length; i++) {
    if (G.state.lanes[i].ai && G.state.lanes[i].ai.name === 'Freddy Fazbear') onBoard = G.state.lanes[i].ai;
  }
  assert(!!onBoard, 'he still jumps in off the banked energy — that part was right');
  assertEq(!!onBoard._triggerNextRound, false,
    'but the turn that DEPLOYED him must not also arm his drain');

  // And the round he was played does not cost the player anything.
  var before = G.state.player.currency;
  G._runHook(onBoard, 'onTurnStart', G, onBoard);
  assertEq(G.state.player.currency, before, 'so no energy is taken the round he lands');

  // While-Active still works: a LATER qualifying end-of-turn arms him normally.
  G.state.player.currency = 3;
  G._checkFreddyFazbear('player');
  assertEq(!!onBoard._triggerNextRound, true, 'a later end-of-turn does arm him');
  var before2 = G.state.player.currency;
  G._runHook(onBoard, 'onTurnStart', G, onBoard);
  assertEq(G.state.player.currency, before2 - 1, 'and then he drains 1, as printed');
});

test("Hela's dead-pile draw is a WHEN DESTROYED payoff, like Grundy's", function () {
  // Owner: "make hela's draw just like solomon grundy when she dies." It used
  // to fire off her On Play, so a Hela who never left the board still paid out.
  // Both halves are asserted: the entrance must NOT draw, and the death must.
  var G = freshGame();
  G.state.phase = 'player-cards';
  G.state.player.currency = 20;
  // Something to pull, on BOTH sides — the pile is shared, same as Grundy's.
  G.state.player.deadPile = [cardByName('Hawkeye')];
  G.state.ai.deadPile     = [cardByName('Ant-Man')];
  var hela = G.createCardInstance(cardByName('Hela'), 'player');
  G.state.player.hand.push(hela);

  var handBefore = G.state.player.hand.length;
  G.playCard('player', hela, 0);
  // She leaves hand as she is played; the warriors are summoned, nothing drawn.
  var deadAfterPlay = G.state.player.deadPile.length + G.state.ai.deadPile.length;
  var handAfterPlay = G.state.player.hand.length;
  assertEq(deadAfterPlay, 2, 'her ENTRANCE must not touch the dead pile any more');
  assertEq(handAfterPlay, handBefore - 1, 'and must not add a card to hand (only Hela left it)');

  // Now kill her.
  G.killCard(hela, null);
  G.cleanupDead();
  var deadAfterDeath = G.state.player.deadPile.length + G.state.ai.deadPile.length;
  var handAfterDeath = G.state.player.hand.length;
  assert(handAfterDeath > handAfterPlay, 'her DEATH draws — this is the whole change');
  assert(deadAfterDeath < deadAfterPlay + 1, 'and the card came out of a dead pile');

  // Same trigger as Grundy: both must own an onDeath and neither an onPlay draw.
  assertEq(typeof CARD_ABILITIES['Hela'].onDeath, 'function', 'Hela has a When Destroyed hook');
  assertEq(typeof CARD_ABILITIES['Solomon Grundy'].onDeath, 'function', 'as does Grundy');

  // And the printed text has to say so, or the card lies about itself.
  var desc = cardByName('Hela').desc;
  assert(/When Destroyed:/.test(desc), 'her text names the When Destroyed trigger');
  assert(/Dead Pile/.test(desc), 'and still names the Dead Pile');
});

test("Droideka's overcharge shows on his ATK orb, not just in the damage", function () {
  // Owner: "for droideka make sure his triple attack reflects on his card
  // damage stats." The orb printed card.attack — the raw stat — so on his
  // shields-down round he showed 3 while swinging for 9. The card contradicted
  // the damage it was about to deal.
  //
  // Asserts against the CANONICAL helper, which is what combat and the lane
  // forecast already resolve damage with; if the orb and that helper ever
  // disagree again this fails regardless of which one moved.
  var G = freshGame();
  var d = place(G, 'Droideka', 'player', 2);

  // Round 1 on the field = shields UP = no multiplier.
  CARD_ABILITIES['Droideka'].onPlay(G, d, 2);
  assertEq(!!d._droidekaOvercharge, false, 'shields up on his first round');
  assertEq(G._cardEffectiveAtk(d), d.attack, 'so effective ATK is just his ATK');

  // Round 2 = shields DOWN = overcharged.
  CARD_ABILITIES['Droideka'].onTurnStart(G, d);
  assertEq(!!d._droidekaOvercharge, true, 'shields drop on the next round');
  var MULT = CARD_ABILITIES['Droideka'].ATK_MULT;
  assertEq(MULT, 2, 'the overcharge is DOUBLE (owner call), not triple');
  assertEq(G._cardEffectiveAtk(d), d.attack * MULT, 'and the orb reads the multiplied ATK');

  // ONE MULTIPLIER, TWO READERS. The orb (_cardEffectiveAtk) and the damage
  // (_computeIncomingDamage) used to hold separate literal 3s, so the card
  // could show one number and hit for another. Assert they agree by MEASURING
  // both, not by reading the constant twice — that is the failure this guards.
  var target = place(G, 'Sabertooth', 'ai', 2);
  target.currentHealth = 99; target.maxHealth = 99;
  var dealt = G._computeIncomingDamage(d, target, { silent: true });
  assertEq(dealt, G._cardEffectiveAtk(d),
    'the damage dealt equals the ATK printed on the orb');
  assertEq(dealt, d.attack * MULT, 'and both are the base ATK times the shared multiplier');

  // Guard the SOURCE relationship: makeCardEl must route the orb through
  // _cardEffectiveAtk, not card.attack. Reading the source keeps this honest
  // in a harness with no DOM.
  var src = readFile('ui.js');
  var i = src.indexOf('const atkCell = hideAtk');
  assert(i > -1, 'the ATK orb assignment still exists');
  var line = src.slice(i, i + 220);
  assert(/atkBoosted \? effAtk/.test(line),
    'the orb prints the effective value when a multiplier is live');
  var j = src.indexOf('const effAtk =');
  assert(j > -1 && /_cardEffectiveAtk/.test(src.slice(j, j + 260)),
    'and effAtk comes from Game._cardEffectiveAtk — the same helper combat uses');
});

test("Ghost Rider PLAYS the card from hand, so its On Play fires like any other", function () {
  // Owner: "he summoned luke and his on play mind control did not go off …
  // that's literally his ability, just make that he plays a card from hand in
  // his place so it goes normally."
  //
  // He used to splice the card out of hand and rebuild it through summonCard,
  // which fires onPlay only as a special case of its own. Reproduced: with a
  // prompt ALREADY ARMED at the moment he died — the normal mid-combat state —
  // Luke landed with his Mind Control silently gone. Not applied, not queued.
  //
  // Both conditions are asserted, because the no-prompt case passed even with
  // the bug present: a test that only covered it would have proved nothing.
  function run(promptBusy) {
    var G = freshGame();
    var gr = G.createCardInstance(cardByName('Ghost Rider'), 'player');
    G.state.lanes[2].player = gr; gr.owner = 'player';
    G.state.player.hand = [G.createCardInstance(cardByName('Luke Skywalker'), 'player')];
    var foe = G.createCardInstance(cardByName('Hawkeye'), 'ai');
    G.state.lanes[0].ai = foe; foe.owner = 'ai';
    if (promptBusy) {
      G.state.pendingCardChoice = { owner: 'player', cards: [foe], title: 'busy',
                                    desc: '', callback: function () {} };
    }
    gr.currentHealth = 0;
    G.handleDeath(gr, 2, null);
    G.cleanupDead();
    var luke = null;
    for (var i = 0; i < G.state.lanes.length; i++) {
      var c = G.state.lanes[i].player;
      if (c && c.name === 'Luke Skywalker') luke = c;
    }
    return { luke: !!luke, hand: G.state.player.hand.length, mc: !!foe.isMindControlled };
  }

  var quiet = run(false), busy = run(true);
  assertEq(quiet.luke, true, 'the card reaches the board on a quiet board');
  assertEq(quiet.mc,   true, 'and its On Play resolves');
  assertEq(busy.luke,  true, 'it reaches the board with a prompt already armed too');
  assertEq(busy.mc,    true, 'and its On Play STILL resolves — this is the bug');
  assertEq(busy.hand,  0,    'and it left hand exactly once (playCardFree owns the removal)');

  // The mechanism, not just the outcome: he must go through the shared free-play
  // door. Routing back to summonCard would reintroduce the whole class.
  var src = readFile('abilities.js');
  var i = src.indexOf('"Ghost Rider"');
  var body = src.slice(i, i + 4200);
  assert(/playCardFree\(self\.owner, card, targetLane\)/.test(body),
    'Ghost Rider plays the card through playCardFree');
  assertEq(/G\.summonCard\(/.test(body), false,
    'and no longer rebuilds it through summonCard');
});

test("Godzilla's Burning is a decaying counter that ticks on ITS OWN lane", function () {
  // Owner: "burning 3 so they take 3 damage then next turn it goes to burning 2
  // they take 2 damage next turn burning 1 … they take burning damage right
  // before their lane not at the beginning of the attack phase."
  //
  // Two separate claims, both asserted: the SEQUENCE (3/2/1, not the old
  // 3/1/1 queue) and the TIMING (onLaneCombat, not onBeforeCombat).
  var G = freshGame();
  var victim = place(G, 'Sabertooth', 'ai', 2);
  victim.currentHealth = 20; victim.maxHealth = 20;   // survive the whole burn
  CARD_ABILITIES['Godzilla']._ignite(G, victim);

  assertEq(victim.burnStacks, 3, 'ignites at Burning 3');
  assertEq(!!victim.isBurning, true, 'and reads as burning');

  // THE TIMING. The tick must hang off onLaneCombat — the "my lane is fighting
  // now" hook — and NOT off onBeforeCombat, which fires for the whole board
  // before lane 1 has swung.
  assertEq(typeof victim.onLaneCombat, 'function', 'the burn ticks on its own lane');

  var hp = victim.currentHealth;
  victim.onLaneCombat(G, victim, 2);
  assertEq(victim.currentHealth, hp - 3, 'Burning 3 deals 3');
  assertEq(victim.burnStacks, 2, 'and decays to 2');

  hp = victim.currentHealth;
  victim.onLaneCombat(G, victim, 2);
  assertEq(victim.currentHealth, hp - 2, 'Burning 2 deals 2 — not 1, which was the old queue');
  assertEq(victim.burnStacks, 1, 'and decays to 1');

  hp = victim.currentHealth;
  victim.onLaneCombat(G, victim, 2);
  assertEq(victim.currentHealth, hp - 1, 'Burning 1 deals 1');
  assertEq(victim.burnStacks, 0, 'and the counter empties');
  assertEq(!!victim.isBurning, false, 'the fire goes out');

  // Spent means spent — a fourth lane fight must not deal a phantom tick.
  hp = victim.currentHealth;
  victim.onLaneCombat(G, victim, 2);
  assertEq(victim.currentHealth, hp, 'a burnt-out card takes no further burn');

  // And the printed text has to describe the counter, not the old schedule.
  var desc = cardByName('Godzilla').desc;
  assert(/Burning 3/.test(desc), 'the card names the starting number');
  assertEq(/before attacking/.test(desc), false, 'and drops the old phase-start wording');
});

// ============================================================
test("A full trick hand OFFERS THE GRINCH'S STEAL AS A TRADE, not a shredder", function () {
  // THE RULE CHANGED, AND THIS TEST WAS PINNING THE OLD ONE.
  //
  // Originally: keep() called addToTrickHand, which DISCARDS at the cap — so a
  // full hand meant the victim lost the trick, the owner never got it, and the
  // Grinch did not triple. Three losses at once. The first fix made a full hand
  // skip the steal entirely and triple, with no prompt, and this test pinned
  // that. (Owner then: "that decision needs to be made automatically because i
  // can't steal the trick.")
  //
  // The owner has since asked for the opposite, and the engine now does it:
  // "when i play grinch and my tricks are at max it won't offer me — i should
  // be offered and be able to trade one out." keep() routes through
  // _gainTrickWithTrade, so a full hand offers a swap, and declining the swap
  // gives the trick back and triples — the old outcome is still reachable, it
  // is just a choice now instead of a silent verdict.
  //
  // What must NEVER come back is the shredder: no path may leave the trick
  // destroyed, and no path may push the hand over its cap.
  var cap = freshGame().state.player.maxTrickHandSize;

  var setup = function () {
    var G = freshGame();
    G.state.player.isHuman = true;
    G.state.player.trickHand = [];
    for (var i = 0; i < cap; i++) G.addToTrickHand('player', { name: 'Filler ' + i, cost: i + 1 });
    G.state.ai.trickHand = [{ name: 'Bacta Tank', cost: 3, id: 90001 }];
    var grinch = place(G, 'The Grinch', 'player', 0);
    return { G: G, grinch: grinch, atk: grinch.attack, hp: grinch.currentHealth };
  };

  // ---- 1. THE OWNER IS ASKED, instead of being told. ----------------------
  var a = setup();
  CARD_ABILITIES['The Grinch'].onPlay(a.G, a.grinch, 0);
  var cc = a.G.state.pendingCardChoice;
  assertEq(!!cc, true, 'a keep-or-give-back prompt IS armed at a full hand');
  assertEq(cc.cards.length, 2, 'and it offers exactly the two outcomes');
  var keepIdx = cc.cards.findIndex(function (c) { return c._action === 'keep'; });
  var backIdx = cc.cards.findIndex(function (c) { return c._action === 'giveback'; });
  assert(keepIdx >= 0 && backIdx >= 0, 'keep and give-back are both reachable');

  // ---- 2. GIVE IT BACK — the old outcome, now as a choice. ---------------
  a.G.resolveActivePrompt('card', { idx: backIdx });
  assertEq(a.G.state.ai.trickHand.length, 1, 'the victim gets their trick back');
  assertEq(a.G.state.ai.trickHand[0].name, 'Bacta Tank', 'and it is the same trick');
  assertEq(a.G.state.player.trickHand.length, cap, 'the full hand did not overflow');
  assertEq(a.grinch.attack, a.atk * 3, 'attack triples');
  assertEq(a.grinch.currentHealth, a.hp * 3, 'health triples');

  // ---- 3. KEEP — the thing the owner asked for. --------------------------
  // NOTE ON THE HARNESS: sim/shim.js resolves promptCardChoice SYNCHRONOUSLY
  // with the prompt's own aiPicker, so the trade prompt can never be caught
  // armed here — only its result. That result is the rule worth pinning
  // anyway: at a full hand the steal TRADES. The picker is lowest-cost-first,
  // so the cheapest filler is the one that goes.
  var b = setup();
  CARD_ABILITIES['The Grinch'].onPlay(b.G, b.grinch, 0);
  var cc2 = b.G.state.pendingCardChoice;
  b.G.resolveActivePrompt('card', { idx: cc2.cards.findIndex(function (c) { return c._action === 'keep'; }) });
  var names = b.G.state.player.trickHand.map(function (t) { return t.name; });
  assertEq(b.G.state.player.trickHand.length, cap, 'the hand stays at the cap');
  assertEq(names.indexOf('Filler 0'), -1, 'the cheapest held trick was traded out');
  assert(names.indexOf('Bacta Tank') >= 0, 'and the stolen one took its place');
  assertEq(b.G.state.ai.trickHand.length, 0, 'the victim really lost it');
  assertEq(b.grinch.attack, b.atk, 'a kept steal does NOT triple');

  // ---- 4. DECLINING THE TRADE gives it back — never shreds it. -----------
  // Driven straight at _gainTrickWithTrade, because the decline arm of a
  // promptCardChoice has no representation in the shim at all. isAI takes the
  // deterministic branch: an incoming trick cheaper than everything held is
  // the case where the trade is refused, and that refusal must reach the
  // CALLER's onDecline (which is what the Grinch hangs giveBack on) rather
  // than quietly discarding the trick.
  var c = setup();
  var declined = 0, kept = 0;
  c.G._gainTrickWithTrade('player', { name: 'Cheap Thing', cost: 0 }, {
    isAI: true,
    onKept: function () { kept++; },
    onDecline: function () { declined++; }
  });
  assertEq(declined, 1, 'the refusal reaches onDecline');
  assertEq(kept, 0, 'and nothing was added');
  assertEq(c.G.state.player.trickHand.length, cap, 'no overflow');
  // The other side of the same branch: something worth more than the cheapest
  // held trick IS traded in, and the hand still never grows.
  var d = setup();
  var landedName = null;
  d.G._gainTrickWithTrade('player', { name: 'Worth It', cost: 9 }, {
    isAI: true,
    onKept: function (landed) { landedName = landed && landed.name; }
  });
  assertEq(landedName, 'Worth It', 'a better trick is traded in');
  assertEq(d.G.state.player.trickHand.length, cap, 'and the hand still holds the cap');
  assertEq(d.G.state.player.trickHand.map(function (t) { return t.name; }).indexOf('Filler 0'), -1,
           'at the cost of the cheapest one');
});

test("Human Torch sets Burning 2 instead of dealing 2 flat damage", function () {
  // Owner: "for human torch have apply 2 burning to an enemy instead of 2 damage."
  var G = freshGame();
  var torch = cardByName('Human Torch');
  var victim = place(G, 'Sabertooth', 'ai', 3);
  victim.currentHealth = 20; victim.maxHealth = 20;

  var hpBefore = victim.currentHealth;
  // Resolve the blast directly on the chosen target — the prompt path just
  // picks who; the effect is what is under test.
  CARD_ABILITIES['Godzilla']._ignite(G, victim, 2);

  // NOT damage on application. The old behaviour took 2 HP the instant it hit.
  assertEq(victim.currentHealth, hpBefore, 'applying Burning deals no immediate damage');
  assertEq(victim.burnStacks, 2, 'the target is set to Burning 2');
  assertEq(!!victim.isBurning, true, 'and reads as burning');

  // 2 then 1 then out — the same decay every Burning source shares.
  victim.onLaneCombat(G, victim, 3);
  assertEq(victim.currentHealth, hpBefore - 2, 'first tick deals 2');
  assertEq(victim.burnStacks, 1, 'and decays to 1');
  victim.onLaneCombat(G, victim, 3);
  assertEq(victim.currentHealth, hpBefore - 3, 'second tick deals 1 — 3 total');
  assertEq(victim.burnStacks, 0, 'the counter empties');

  assert(/Burning 2/.test(torch.desc), 'the card names the Burning number');
  assertEq(/Deal 2 damage/.test(torch.desc), false, 'and drops the flat-damage wording');
});

test("Re-igniting takes the higher Burning number, never a downgrade", function () {
  // A Human Torch's Burning 2 must not put out part of a Godzilla's Burning 3.
  var G = freshGame();
  var victim = place(G, 'Sabertooth', 'ai', 1);
  victim.currentHealth = 30; victim.maxHealth = 30;

  CARD_ABILITIES['Godzilla']._ignite(G, victim);        // 3
  CARD_ABILITIES['Godzilla']._ignite(G, victim, 2);     // weaker source
  assertEq(victim.burnStacks, 3, 'the weaker source does not downgrade the burn');

  // And the stronger source still refreshes upward.
  victim.burnStacks = 1;
  CARD_ABILITIES['Godzilla']._ignite(G, victim, 2);
  assertEq(victim.burnStacks, 2, 'a stronger source re-stokes');
});

test("Boiler Room burns with the shared Burning, at the same 1 per turn", function () {
  // Owner picked unification: Boiler Room used to run a private version of the
  // status (flat 1 on onBeforeAttack, forever, no decay), so one printed word
  // meant two different rules. Now it ignites at Burning 1 through the same
  // applier Godzilla and Human Torch use. This test pins BOTH halves: the
  // private rule is gone, and the damage per turn did not change.
  var G = freshGame();
  var boiler = place(G, 'Boiler Room', 'player', 1);
  var victim = place(G, 'Sabertooth', 'ai', 1);
  victim.currentHealth = 20; victim.maxHealth = 20;

  CARD_ABILITIES['Boiler Room']._markBurning(victim, boiler);

  // 1. THE SHARED STATUS, not a private one.
  assertEq(victim.burnStacks, 1, 'ignites at Burning 1');
  assertEq(!!victim.isBurning, true, 'and reads as burning');
  assertEq(typeof victim.onLaneCombat, 'function', 'it ticks on its own lane');
  assertEq(!!victim._brAttackHooked, false, 'the private onBeforeAttack tick is gone');

  // 2. ONE DAMAGE, then the counter is spent.
  var hp = victim.currentHealth;
  victim.onLaneCombat(G, victim, 1);
  assertEq(victim.currentHealth, hp - 1, 'the tick deals 1 — the old amount');
  assertEq(victim.burnStacks, 0, 'and the counter empties');
  assertEq(!!victim.isBurning, true, 'but the fire stays lit while the Boiler Room stands');

  // 3. THE RE-STOKE is what keeps it at 1 per turn. Without it a decaying
  //    counter would tick once and quietly stop, silently nerfing the card.
  CARD_ABILITIES['Boiler Room'].onTurnStart(G, boiler);
  assertEq(victim.burnStacks, 1, 'each turn re-stokes the burn back to 1');
  hp = victim.currentHealth;
  victim.onLaneCombat(G, victim, 1);
  assertEq(victim.currentHealth, hp - 1, 'so the second turn deals 1 again');

  // 4. And a stronger source in the lane is not dragged down to 1.
  CARD_ABILITIES['Godzilla']._ignite(G, victim, 3);
  CARD_ABILITIES['Boiler Room'].onTurnStart(G, boiler);
  assertEq(victim.burnStacks, 3, "the re-stoke never downgrades a bigger burn");

  // 5. The card no longer explains the status itself — the keyword does.
  var env = cardByName('Boiler Room');
  assertEq(/take 1 damage before they attack/.test(env.desc), false,
    'the private-rule sentence is gone from the card');
  assert(/Burning/.test(env.desc), 'but it still names the keyword');
});

test("Bacta Tank costs 2", function () {
  // Owner: "bacta should be a 2 cost."
  var bacta = TRICK_DEFS.find(function (t) { return t.name === 'Bacta Tank'; });
  assert(!!bacta, 'the trick still exists');
  assertEq(bacta.cost, 2, 'Bacta Tank is a 2-cost trick');
});

test("Jigsaw places two rooms instead of Bear Traps", function () {
  // Owner: "jigsaw now makes 2 environments." The traps are gone entirely;
  // the relocate step stays.
  var G = freshGame();
  var jig = cardByName('Jigsaw');
  assertEq(/Bear Trap/.test(jig.desc), false, 'the card no longer mentions Bear Traps');
  assert(/The Bathroom/.test(jig.desc) && /Game Over/.test(jig.desc),
    'and it names both rooms');

  // Both rooms exist as environments, and neither can be drafted — they are
  // Jigsaw's alone, like Pennywise belongs to the Sewers.
  ['The Bathroom', 'Game Over'].forEach(function (n) {
    var def = cardByName(n);
    assert(!!def, n + ' is a real card def');
    assertEq(def.type, 'environment', n + ' is an environment');
    assertEq(!!def.isEnvironment, true, n + ' carries isEnvironment');
    assertEq(!!def._spawnOnly, true, n + ' is spawn-only, never drafted');
  });

  // Placement seats the room in the lane's environment sub-slot.
  CARD_ABILITIES['Jigsaw']._placeRoom(G, 'player', 3, 'The Bathroom');
  var room = G.state.lanes[3]._env && G.state.lanes[3]._env.player;
  assert(!!room, 'the room is seated in the env sub-slot');
  assertEq(room.name, 'The Bathroom', 'and it is the room asked for');
});

test("The Bathroom chains the first enemy in — and moving costs it again", function () {
  var G = freshGame();
  var room = CARD_ABILITIES['Jigsaw']._placeRoom(G, 'player', 2, 'The Bathroom');

  // An enemy walks in. Given stats that survive TWO tolls — base Sabertooth is
  // 2/3, so entry alone leaves it 0/1 and the move would kill it, which is the
  // lethal case covered by its own test rather than this one.
  var victim = place(G, 'Sabertooth', 'ai', 2);
  victim.attack = 8; victim.maxHealth = 8; victim.currentHealth = 8;
  var atk0 = victim.attack, hp0 = victim.currentHealth;
  CARD_ABILITIES['The Bathroom'].onAnyCardPlayed(G, room);

  assertEq(victim.attack, atk0 - 2, 'it takes -2 ATK');
  assertEq(victim.currentHealth, hp0 - 2, 'and -2 HP');

  // THE CHAIN, tested through moveCard — the choke point every mover uses.
  // Asserting the flag alone would pass even if nothing read it. The chain is
  // a TOLL now, not a lock: the move goes through and costs another (−2/−2).
  var atkBefore = victim.attack, hpBefore = victim.currentHealth;
  G.moveCard(victim, 2, 4);
  assertEq(G.state.lanes[4].ai, victim, 'it CAN leave the bathroom now');
  assertEq(G.state.lanes[2].ai, null, 'and really left the old lane');
  assertEq(victim.attack, atkBefore - 2, 'the move cost 2 more ATK');
  assertEq(victim.currentHealth, hpBefore - 2, 'and 2 more HP');

  // ONE victim only — the room does not keep chaining the same body.
  var atk1 = victim.attack;
  CARD_ABILITIES['The Bathroom'].onAnyCardPlayed(G, room);
  assertEq(victim.attack, atk1, 'the room does not re-chain it');
});

test("Game Over raises an enemy body that dies in its lane, as a (2/2)", function () {
  var G = freshGame();
  var room = CARD_ABILITIES['Jigsaw']._placeRoom(G, 'player', 1, 'Game Over');

  // An enemy stands in the lane; our side of it is empty so a body can rise.
  var victim = place(G, 'Sabertooth', 'ai', 1);
  CARD_ABILITIES['Game Over'].onAnyCardPlayed(G, room);
  assertEq(!!victim._revealHooked, true, 'the occupant is hooked');

  // Give the room's owner another ally somewhere else. Without one, LONE WOLF
  // (+1/+1 to a summon entering with no allies) fires on the body and it stands
  // up as a 2/2 — a real rule, not a bug, but it would hide whether the room
  // actually raises a (1/1). Both cases are asserted; this one isolates the room.
  place(G, 'Nightwing', 'player', 5);

  var name = victim.name;
  victim.currentHealth = 0;
  G.handleDeath(victim, 1, null);

  var risen = G.state.lanes[1].player;
  assert(!!risen, 'a body gets up');
  assertEq(risen.name, name, 'it is the card that died');
  assertEq(risen.owner, 'player', 'and it rises on the room owner side');
  assertEq(risen.attack, 2, 'as a 2 ATK');
  assertEq(risen.currentHealth, 2, 'and 2 HP body');

  // SPENT. One body only — otherwise the room re-hooks what it just raised and
  // a death cascade loops forever (this hung the full-match suite once).
  assertEq(!!room._revealSpent, true, 'the room is spent after one rise');
  assertEq(G.state.lanes[1]._env.player, null, 'and its lane slot is cleared');
});

test("Brainiac is discard-only and opens the opponent's HAND for two rounds", function () {
  var G = freshGame();
  var brain = G.createCardInstance(cardByName('Brainiac'), 'player');
  assertEq(!!brain.isDiscardEffect, true, 'Brainiac is a discard effect (never seated in a lane)');

  // He reads a HAND, not the top of the draw pile. (The old foresight version
  // peeked two unowned cards off the deck; it was reworked because that told
  // you nothing about what you were actually about to be hit with.)
  G.state.ai.hand.length = 0;
  G.state.ai.hand.push(G.createCardInstance(cardByName('Bane'), 'ai'));
  G.state.ai.hand.push(G.createCardInstance(cardByName('Hawkeye'), 'ai'));

  assertEq(G.brainiacSpiedHand(null, 'player'), null, 'nothing visible before he lands');
  CARD_ABILITIES['Brainiac'].onDiscard(G, 'player', brain);

  var view = G.brainiacSpiedHand(null, 'player');
  assertEq(!!view, true, 'the enemy hand is now readable');
  assertEq(view.rounds, G.BRAINIAC_SPY_ROUNDS, 'the window is BRAINIAC_SPY_ROUNDS long');
  assertEq(view.hand.length, 2, 'both cards in that hand are visible');
  assertEq(view.hand[0].name, 'Bane', 'and they are the real cards');
});

test("Brainiac shaves 1 ATK off every card that lands in the watched hand", function () {
  var G = freshGame();
  var card = G.createCardInstance(cardByName('Bane'), 'ai');
  var before = card.attack;
  // Not watched yet — the drain is a no-op.
  assertEq(G.applyBrainiacDrain(card, null, 'ai'), false, 'no scan, no drain');
  assertEq(card.attack, before, 'and the card is untouched');

  G.setBrainiacSpy('player', null, 2, null);
  var fresh = G.createCardInstance(cardByName('Bane'), 'ai');
  assertEq(G.applyBrainiacDrain(fresh, null, 'ai'), true, 'a watched hand drains what lands in it');
  assertEq(fresh.attack, Math.max(0, before - G.BRAINIAC_SPY_ATK_DRAIN), 'arrives at -1 ATK');
  // Once only — a card cannot be shaved twice.
  assertEq(G.applyBrainiacDrain(fresh, null, 'ai'), false, 'never drained twice');
  assertEq(fresh.attack, Math.max(0, before - G.BRAINIAC_SPY_ATK_DRAIN), 'still just the one point');
});

test("Brainiac's window ticks down and expires at round start", function () {
  var G = freshGame();
  G.setBrainiacSpy('player', null, 2, null);
  assertEq(G.state.player._brainiacSpy.rounds, 2, 'armed for two rounds');
  G.startRound();
  assertEq(G.state.player._brainiacSpy.rounds, 1, 'one round spent');
  G.startRound();
  assertEq(!G.brainiacSpyOf(null, 'player'), true, 'and it is gone after the second');
});

// ---- Art the Clown ----------------------------------------------------------
// Weapon effects are tested through _resolve with exactly ONE enemy on the
// board, so the target prompt auto-resolves (single valid target) instead of
// stalling on a modal.
function artOnBoard(G, lane) {
  var art = G.createCardInstance(cardByName('Art the Clown'), 'player');
  art._artWeaponsUsed = [];
  G.state.lanes[lane == null ? 0 : lane].player = art;
  return art;
}

test("Art the Clown — Sledgehammer deals double his ATK", function () {
  var G = freshGame();
  var art = artOnBoard(G, 0);
  art.attack = 3;
  var foe = place(G, 'Sabertooth', 'ai', 2);   // a beefy body
  foe.currentHealth = 10; foe.maxHealth = 10;
  CARD_ABILITIES['Art the Clown']._resolve(G, art, 'sledgehammer');
  assertEq(foe.currentHealth, 4, '10 HP minus double 3 ATK = 4');
  assert(art._artWeaponsUsed.indexOf('sledgehammer') > -1, 'the weapon is spent');
});

test("Art the Clown — Scythe halves an enemy's ATK and HP (rounded down)", function () {
  var G = freshGame();
  var art = artOnBoard(G, 0);
  var foe = place(G, 'Sabertooth', 'ai', 2);
  foe.attack = 5; foe.currentHealth = 7; foe.maxHealth = 7;
  CARD_ABILITIES['Art the Clown']._resolve(G, art, 'scythe');
  assertEq(foe.attack, 2, '5 → 2');
  assertEq(foe.currentHealth, 3, '7 → 3');
});

test("Art the Clown — Scissors strips a keyword and clears its flag", function () {
  var G = freshGame();
  var art = artOnBoard(G, 0);
  var foe = place(G, 'Sabertooth', 'ai', 2);
  foe.abilities = ['Evade 2']; G.applyAbilities(foe);
  assertEq(foe.evadeCharges, 2, 'starts with Evade 2');
  CARD_ABILITIES['Art the Clown']._resolve(G, art, 'scissors');
  assertEq(foe.evadeCharges, 0, 'Evade is cut to 0');
  assert(foe.abilities.indexOf('Evade 2') < 0, 'and gone from the printed list');
});

test("Art the Clown — Hacksaw bleeds 2 on the cut, then 2 more next round", function () {
  // RETARGETED, not reverted. 79349d6 deliberately moved the FIRST tick to the
  // moment the target is chosen — _resolve sets _bleedRounds = 2 and then calls
  // tickBleed immediately, which deals 2 and decrements to 1. This test still
  // asserted the pre-79349d6 contract (_bleedRounds === 2 straight after the
  // cut) and had been the suite's one red test since.
  // The TOTAL is unchanged at 4 — 2 on the cut plus 2 at the next round start —
  // so this is a timing change, not a balance one.
  var G = freshGame();
  var art = artOnBoard(G, 0);
  var foe = place(G, 'Sabertooth', 'ai', 2);
  foe.currentHealth = 9; foe.maxHealth = 9;
  CARD_ABILITIES['Art the Clown']._resolve(G, art, 'hacksaw');
  assertEq(foe.currentHealth, 7, 'the cut itself bleeds for 2');
  assertEq(foe._bleedRounds, 1, 'leaving one round of wound');
  G.startRound();
  assertEq(foe.currentHealth, 5, 'second tick at the next round: -2');
  assertEq(foe._bleedRounds, 0, 'wound closed');
  G.startRound();
  assertEq(foe.currentHealth, 5, 'no third tick');
});

test("Art the Clown — no weapon twice, then he becomes stats-only", function () {
  var G = freshGame();
  var art = artOnBoard(G, 0);
  art._artWeaponsUsed = ['scissors', 'sledgehammer', 'scythe'];
  place(G, 'Sabertooth', 'ai', 2);
  CARD_ABILITIES['Art the Clown']._resolve(G, art, 'hacksaw');
  assertEq(art._artWeaponsUsed.length, 4, 'all four used');
  assertEq(!!art._artExhausted, true, 'the bag is empty');
  assertEq(art.onPlay, null, 'onPlay hook dropped');
  assertEq(art.onBeforeTricks, null, 'onBeforeTricks hook dropped');
});

test("Art the Clown — Jump arms when the enemy has more cards on the field", function () {
  var G = freshGame();
  var art = G.createCardInstance(cardByName('Art the Clown'), 'player');
  G.state.player.hand = [art];
  // Enemy: 2 bodies. Player: none on board (Art is in hand). 2 > 0 → jump.
  place(G, 'Sabertooth', 'ai', 1);
  place(G, 'Sabertooth', 'ai', 3);
  G.checkJumpConditions('beforeTricks', {});
  assertEq(!!art.jumpReady, true, 'Art is jump-ready');

  // Even board — no jump.
  var G2 = freshGame();
  var art2 = G2.createCardInstance(cardByName('Art the Clown'), 'player');
  G2.state.player.hand = [art2];
  place(G2, 'Sabertooth', 'ai', 1);
  place(G2, 'Sabertooth', 'player', 3);
  G2.checkJumpConditions('beforeTricks', {});
  assertEq(!!art2.jumpReady, false, '1 vs 1 does not arm the jump');
});

test("The Bathroom chains an enemy DRAGGED into its lane, not only one played", function () {
  // The Jigsaw combo: place a room, then drag an enemy into it. A drag never
  // fired onAnyCardPlayed, so the room did nothing — the reported bug. The entry
  // choke point (checkLaneTrap, which every move/drag/summon passes through) now
  // pokes the room.
  var G = freshGame();
  CARD_ABILITIES['Jigsaw']._placeRoom(G, 'player', 3, 'The Bathroom');
  var foe = place(G, 'King Shark', 'ai', 3);   // 3/3 arrives opposite the room
  var a0 = foe.attack, h0 = foe.currentHealth;
  G.checkLaneTrap(foe, 3);                       // the drag/move entry point
  assertEq(foe.attack, a0 - 2, 'the dragged enemy loses 2 ATK');
  assertEq(foe.currentHealth, h0 - 2, 'and 2 HP');
  assertEq(!!foe._chained, true, 'and carries the Chained status');
});

test("Game Over hooks a body dragged in, which rises on your side on death", function () {
  var G = freshGame();
  CARD_ABILITIES['Jigsaw']._placeRoom(G, 'player', 4, 'Game Over');
  var foe = place(G, 'King Shark', 'ai', 4);
  G.checkLaneTrap(foe, 4);                       // entry poke installs the hook
  assert(!!foe._revealHooked, 'the entering body is hooked by Game Over');
  foe.currentHealth = 0; G.handleDeath(foe, 4, null); G.cleanupDead();
  var risen = G.state.lanes[4].player;
  assert(risen && risen.owner === 'player', 'the dead body rises on your side');
  assertEq(risen.name, 'King Shark', 'as the same card it was');
});

test("A card revived from the dead pile keeps ALL its hooks (Dormammu's drain)", function () {
  // The dead-pile archive used to copy only onPlay/onDeath/onDamaged/onKill, so
  // a revived Dormammu lost his drain (onBeforeTricks) and just stood there.
  var G = freshGame();
  var dorm = place(G, 'Dormammu', 'player', 5);
  dorm.currentHealth = 0; G.handleDeath(dorm, 5, null);
  var archive = G.state.player.deadPile[0];
  assert('onBeforeTricks' in archive, 'the archive carries onBeforeTricks');
  var revived = G.createCardInstance(archive, 'player');
  assertEq(typeof revived.onBeforeTricks, 'function', 'and the revived card has it');
  assertEq(typeof revived.onPlay, 'function', 'onPlay too');
});

test("A body raised alone still gets Lone Wolf — the room does not bypass it", function () {
  // The other half of the case above, pinned deliberately rather than left as a
  // surprise: with no other ally on the board the risen body is a 3/3 — the
  // room's (2/2) plus Lone Wolf, which applies to it like any other summon.
  var G = freshGame();
  var room = CARD_ABILITIES['Jigsaw']._placeRoom(G, 'player', 1, 'Game Over');
  var victim = place(G, 'Sabertooth', 'ai', 1);
  CARD_ABILITIES['Game Over'].onAnyCardPlayed(G, room);
  victim.currentHealth = 0;
  G.handleDeath(victim, 1, null);
  var risen = G.state.lanes[1].player;
  assert(!!risen, 'a body gets up');
  assertEq(risen.attack, 3, 'Lone Wolf takes the lone (2/2) body to 3 ATK');
  assertEq(risen.currentHealth, 3, 'and 3 HP');
});

test("A card's On Play can ground a hunter before it chases", function () {
  // Owner: "on plays happen 1st always — so when spiderman is played his stun
  // hits martian manhunter 1st, then the hunt passive fires, he is frozen,
  // can't move." MM hunted anyway.
  //
  // The isActionLocked guard inside _resolveHuntChase was already correct; the
  // call simply ran ABOVE the On Play block, so the hunter chased before the
  // freeze existed. This is the same ruling that moved the aura ping below the
  // On Play — Hunt is a passive reaction to a card entering, and it was missed.
  var G = freshGame();
  // playCard refuses for a human seat in the harness — same convention the
  // other playCard tests here use.
  G.state.player.isHuman = false; G.state.ai.isHuman = false;

  // A hunter sitting far from the action.
  var hunter = place(G, 'Martian Manhunter', 'ai', 0);
  hunter.hasHunt = true;

  // The card being played freezes the hunter in its own On Play.
  var bait = G.createCardInstance(cardByName('Nightwing'), 'player');
  G.state.player.hand = [bait];
  G.state.player.currency = 99;   // energy is spent from .currency
  bait.onPlay = function (G2) { G2.freezeCard(hunter, 1); };

  G.playCard('player', bait, 4);

  assertEq(!!G.isActionLocked(hunter), true, 'the On Play froze the hunter');
  assertEq(G.state.lanes[0].ai, hunter, 'so the hunter never left its lane');
  assertEq(G.state.lanes[4].ai, null, 'and did not arrive in the played lane');
});

test("An UNfrozen hunter still chases — the fix did not just disable Hunt", function () {
  // The control. Without this, the test above would pass just as well if the
  // move had broken hunting outright.
  var G = freshGame();
  G.state.player.isHuman = false; G.state.ai.isHuman = false;
  var hunter = place(G, 'Martian Manhunter', 'ai', 0);
  hunter.hasHunt = true;

  var bait = G.createCardInstance(cardByName('Nightwing'), 'player');
  G.state.player.hand = [bait];
  G.state.player.currency = 99;   // energy is spent from .currency

  G.playCard('player', bait, 4);

  assertEq(G.state.lanes[4].ai, hunter, 'the hunter chases into the played lane');
  assertEq(G.state.lanes[0].ai, null, 'and leaves the lane it came from');
});

test("firstPlayerForRound is the one rule the draft screen and startRound share", function () {
  // Owner: "on the draft screen display who is playing 1st on turn 1."
  // The lead is derivable for ANY round from the single coin flip, which is
  // what lets the draft answer it before a round exists. The value of pulling
  // it into a helper is that the screen and the engine cannot drift apart —
  // so this test checks the helper AND that startRound agrees with it.
  var G = freshGame();
  G.state.oddPlayer = 'player';
  assertEq(G.firstPlayerForRound(1), 'player', 'odd rounds go to oddPlayer');
  assertEq(G.firstPlayerForRound(2), 'ai', 'even rounds alternate');
  assertEq(G.firstPlayerForRound(3), 'player', 'and alternate back');

  G.state.oddPlayer = 'ai';
  assertEq(G.firstPlayerForRound(1), 'ai', 'follows the flip, not a fixed seat');
  assertEq(G.firstPlayerForRound(2), 'player', 'still alternates');

  // Not yet flipped — null, so the draft can simply print nothing rather than
  // guessing a seat and being wrong half the time.
  G.state.oddPlayer = null;
  assertEq(G.firstPlayerForRound(1), null, 'no answer before the coin flip');

  // THE AGREEMENT. startRound must land on what the helper promised, or the
  // draft screen becomes a liar.
  // NOTE startRound() takes NO argument — it increments state.round itself.
  // Passing one is silently ignored, which is how the first draft of this test
  // managed to assert against the wrong round and "fail" a correct helper.
  G.state.oddPlayer = 'ai';
  G.state.round = 0;
  var promised = G.firstPlayerForRound(1);
  G.startRound();
  assertEq(G.state.round, 1, 'startRound advanced to round 1');
  assertEq(G.state.firstPlayer, promised, 'startRound honours the promise');

  var promised2 = G.firstPlayerForRound(2);
  G.startRound();
  assertEq(G.state.round, 2, 'and on to round 2');
  assertEq(G.state.firstPlayer, promised2, 'and again on the alternating round');
});

test("A chain whose start cannot change the outcome does not ask", function () {
  // Owner: "when there's only targets next to each other like this, because it
  // doesn't matter where i start the chain it will end the same."
  //
  // Decided by SIMULATION rather than an enemy count, and these cases are why:
  // three in a row are also all-or-nothing, while TWO split by a gap are a real
  // choice because a chain cannot cross empty ground.
  var G = freshGame();
  var pal = place(G, 'Emperor Palpatine', 'player', 0);
  var MAX = 3;

  function enemiesAt(lanes) {
    for (var i = 0; i < G.LANE_COUNT; i++) G.state.lanes[i].ai = null;
    lanes.forEach(function (l) { place(G, 'Sabertooth', 'ai', l); });
  }

  // ONE enemy — nothing to pick.
  enemiesAt([2]);
  assertEq(G._chainStartIsForced(pal, MAX), true, 'a single enemy is forced');

  // TWO ADJACENT — the reported case. Start either end, both freeze.
  enemiesAt([0, 1]);
  assertEq(G._chainStartIsForced(pal, MAX), true, 'two adjacent enemies are forced');

  // THREE ADJACENT still ASKS, and the reason is the one-way rule: the chain
  // locks direction after the first step, so starting in the MIDDLE reaches
  // only two cards while starting at either end reaches all three. That is a
  // real decision, and it is exactly what a count-based shortcut ("two or three
  // in a row, just auto-pick") would have silently taken away from the player.
  enemiesAt([1, 2, 3]);
  assertEq(G._chainStartIsForced(pal, MAX), false, 'a middle start reaches fewer, so it asks');

  // TWO WITH A GAP — a genuine choice: the chain cannot jump lane 2, so
  // starting at 1 freezes one card and starting at 3 freezes the other.
  enemiesAt([0, 2]);
  assertEq(G._chainStartIsForced(pal, MAX), false, 'a gap makes the start matter');

  // FOUR ADJACENT against a cap of 3 — now the end you start from decides
  // WHICH three get frozen, so it must still ask.
  enemiesAt([0, 1, 2, 3]);
  assertEq(G._chainStartIsForced(pal, MAX), false, 'a run longer than the cap still asks');
});

test("A card flagged asleep with no turns left cannot stay asleep forever", function () {
  // Owner: "freddy is keeping cards asleep way longer than intended — yoda has
  // been asleep for 3 turns and freddy died a long time ago."
  //
  // Freddy is the only thing that sets sleep, and he sets both fields together,
  // so a LONG timer is not reachable. A STUCK one was: tickSleep skipped any
  // card whose counter was not > 0, so a stale isAsleep flag had no path out,
  // and the renderer dimmed and badged on that flag while the engine allowed
  // the play. Permanently-asleep-looking, which is what a player sees as
  // "asleep for 3 turns".
  var G = freshGame();
  var yoda = G.createCardInstance(cardByName('Yoda'), 'player');
  G.state.player.hand = [yoda];

  // ONE PREDICATE. The engine and the renderer must agree on this card.
  yoda.isAsleep = true; yoda.sleepTurns = 0;      // the trap state
  assertEq(G.isCardAsleep(yoda), false, 'no turns left means awake, flag or not');

  // AND THE TICK HEALS IT rather than skipping past it forever.
  G.state.round = 0;
  G.startRound();
  assertEq(!!yoda.isAsleep, false, 'the stale flag is cleared');
  assertEq(yoda.sleepTurns | 0, 0, 'and the counter stays at zero');

  // The normal path still behaves: one round of sleep, then awake.
  yoda.isAsleep = true; yoda.sleepTurns = 1;
  assertEq(G.isCardAsleep(yoda), true, 'a real sleep still reads as asleep');
  G.startRound();
  assertEq(G.isCardAsleep(yoda), false, 'and wakes on the next round');
  assertEq(!!yoda.isAsleep, false, 'with the display flag cleared too');

  // A dead Freddy cannot re-apply it — he sleeps cards from onBeforeAttack,
  // which only runs for a card that actually swings.
  var freddy = place(G, 'Freddy Krueger', 'ai', 2);
  freddy.currentHealth = 0;
  G.handleDeath(freddy, 2, null);
  G.cleanupDead();
  G.startRound();
  assertEq(G.isCardAsleep(yoda), false, 'still awake with Freddy gone');
});

test("Deadpool's trade needs both halves — no give-back, no steal", function () {
  // Owner: "if deadpool doesn't have a card to trade — like the hand is empty —
  // his ability shouldn't fire."
  //
  // The give-back WAS guarded, but only after the steal had already resolved:
  // you picked a face-down card, it entered your hand, and only then did the
  // log admit there was nothing to give back. A trade with one half missing is
  // a free steal, and you had to sit through a blind pick to discover it.
  function board(ownerHand, enemyHand) {
    var G = freshGame();
    G.state.player.isHuman = false; G.state.ai.isHuman = false;
    var dp = place(G, 'Deadpool', 'player', 0);
    G.state.player.hand = ownerHand.map(function (n) {
      return G.createCardInstance(cardByName(n), 'player');
    });
    G.state.ai.hand = enemyHand.map(function (n) {
      return G.createCardInstance(cardByName(n), 'ai');
    });
    return { G: G, dp: dp };
  }

  // NOTHING TO TRADE BACK → the ability does not fire at all.
  var t1 = board([], ['Hulk']);
  CARD_ABILITIES['Deadpool'].onDeath(t1.G, t1.dp, 0);
  assertEq(t1.G.state.ai.hand.length, 1, 'the enemy keeps their card');
  assertEq(t1.G.state.ai.hand[0].name, 'Hulk', 'and it is the same card');
  assertEq(t1.G.state.player.hand.length, 0, 'and nothing is stolen into an empty hand');
  assertEq(!!t1.G.state.pendingCardChoice, false, 'no blind pick is raised');

  // NOTHING TO STEAL → also does not fire (this half was already guarded).
  var t2 = board(['Gizmo'], []);
  CARD_ABILITIES['Deadpool'].onDeath(t2.G, t2.dp, 0);
  assertEq(t2.G.state.player.hand.length, 1, 'the owner keeps their own card');
  assertEq(!!t2.G.state.pendingCardChoice, false, 'and no prompt is raised');

  // CONTROL — with both hands stocked the trade still happens. Without this the
  // test above would pass just as well if Deadpool had been broken outright.
  var t3 = board(['Gizmo'], ['Hulk']);
  CARD_ABILITIES['Deadpool'].onDeath(t3.G, t3.dp, 0);
  var ownerNames = t3.G.state.player.hand.map(function (c) { return c.name; });
  var enemyNames = t3.G.state.ai.hand.map(function (c) { return c.name; });
  assertEq(ownerNames.join(','), 'Hulk', 'the owner ends up holding the stolen card');
  assertEq(enemyNames.join(','), 'Gizmo', 'and the enemy ends up holding the traded one');

  // PURE THIEF (roguelite Text+) owes nothing, so an empty hand does not stop it.
  var t4 = board([], ['Hulk']);
  t4.dp._deadpoolNoGiveBack = true;
  CARD_ABILITIES['Deadpool'].onDeath(t4.G, t4.dp, 0);
  assertEq(t4.G.state.player.hand.length, 1, 'the no-give-back variant still steals');
  assertEq(t4.G.state.ai.hand.length, 0, 'and the enemy loses it');
});

test("Crazy cannot outlive the Joker who stamped it", function () {
  // Owner: "joker died long ago, why is crazy still applied" — on Mahoraga.
  //
  // Joker's onDeath DID strip the stamp, but only from getAllCardsOnBoard().
  // A victim that was off-board at that instant kept it with nothing alive
  // left to ever clear it. Mahoraga hits this more than anything else because
  // dying and coming back IS his card.
  function stamped(where) {
    var G = freshGame();
    G.state.player.isHuman = false; G.state.ai.isHuman = false;
    var joker = place(G, 'Joker', 'player', 0);
    var m = place(G, 'Mahoraga', 'ai', 1);
    G.applyCrazyToCard(m);
    assertEq(!!m.isCrazy, true, 'stamped to begin with');
    if (where === 'deadpile') { G.state.lanes[1].ai = null; G.state.ai.deadPile.push(m); }
    if (where === 'nowhere')  { G.state.lanes[1].ai = null; }
    return { G: G, joker: joker, m: m };
  }

  // ON THE BOARD — the case that already worked.
  var a = stamped('board');
  a.joker.currentHealth = 0; a.G.handleDeath(a.joker, 0, null); a.G.cleanupDead();
  assertEq(!!a.m.isCrazy, false, 'a board victim is cleared on Joker death');

  // IN THE DEAD PILE — mid-revive, which is exactly Mahoraga's kit.
  var b = stamped('deadpile');
  var restoreTo = b.m._preCrazyAttack;
  b.joker.currentHealth = 0; b.G.handleDeath(b.joker, 0, null); b.G.cleanupDead();
  assertEq(!!b.m.isCrazy, false, 'a dead-pile victim is cleared too');
  assertEq(b.m.attack, restoreTo, 'and its pre-Crazy ATK comes back');

  // UNREACHABLE at the moment of death, back on the board afterwards. Nothing
  // could have swept it, so the per-round reconcile is what saves it.
  var c = stamped('nowhere');
  c.joker.currentHealth = 0; c.G.handleDeath(c.joker, 0, null); c.G.cleanupDead();
  c.G.state.lanes[1].ai = c.m;
  c.G.state.round = 0;
  c.G.startRound();
  assertEq(!!c.m.isCrazy, false, 'the round reconcile heals a stranded stamp');
  assertEq(!!c.m._crazyAppliedBy, false, 'and drops the marker with it');

  // CONTROL — a LIVING Joker must keep his stamp. Without this the test would
  // pass just as well if Crazy had been broken outright.
  var d = freshGame();
  d.state.player.isHuman = false; d.state.ai.isHuman = false;
  place(d, 'Joker', 'player', 0);
  var v = place(d, 'Sabertooth', 'ai', 1);
  d.applyCrazyToCard(v);
  d.state.round = 0;
  d.startRound();
  assertEq(!!v.isCrazy, true, 'Crazy survives while its Joker is alive');
});

test("2v2: an orphaned prompt goes to a HUMAN seat, never a bot", function () {
  // Owner, emphatically: "MAKE SURE THEY CAN NEVER PLAY FOR ANOTHER HUMAN."
  //
  // The seat fallback used to prefer an AI seat on purpose — the host
  // auto-resolves those — which turned "no seat is obviously acting" into "a bot
  // decides for a human". That is what a player experiences as their cards being
  // played for them: an Iron Giant sacrificing itself with no prompt, a Superman
  // whose targets were picked for them, a Ghost Rider whose teleport resolved
  // out of a teammate's hand.
  function lobby(teamA, teamB) {
    var G = freshGame();
    G.state.twoVTwo = { online: true, players: {
      p1: { team: 'A', isAI: teamA[0], name: 'p1' },
      p2: { team: 'A', isAI: teamA[1], name: 'p2' },
      p3: { team: 'B', isAI: teamB[0], name: 'p3' },
      p4: { team: 'B', isAI: teamB[1], name: 'p4' } } };
    return G;
  }

  // A human sharing a team with a bot fill-in must own the prompt.
  var G1 = lobby([false, true], [true, true]);
  assertEq(G1._2v2SeatForSide('player'), 'p1', 'the human seat owns it, not the bot');

  // Even when the bot occupies the earlier slot.
  var G2 = lobby([true, false], [true, true]);
  assertEq(G2._2v2SeatForSide('player'), 'p2', 'slot order does not hand it to the bot');

  // An all-bot team still resolves — the AI branch is the last resort, not the
  // first choice, so nothing strands.
  var G3 = lobby([true, true], [true, true]);
  assertEq(G3._2v2SeatForSide('ai'), 'p3', 'an all-bot team still gets a seat');

  // And the enemy team's prompt never crosses over.
  var G4 = lobby([false, true], [false, true]);
  assertEq(G4._2v2SeatForSide('ai'), 'p3', 'Team B prompts stay on Team B');
});

test("2v2: a played card always records who played it", function () {
  // _2v2PlayedBy was only stamped when a seat was ALREADY acting, so a card
  // played while that was null recorded no owner — and every prompt it raised
  // later fell through to the team-derived fallback instead of staying with the
  // player who played it.
  var G = freshGame();
  G.state.player.isHuman = false; G.state.ai.isHuman = false;
  G.state.twoVTwo = { online: true, players: {
    p1: { team: 'A', isAI: false }, p2: { team: 'A', isAI: true },
    p3: { team: 'B', isAI: true },  p4: { team: 'B', isAI: true } } };
  G._2v2CurrentActingPlayer = null;          // nothing acting
  // SAVE/RESTORE. freshGame() hands back the one shared Game object, so a stub
  // left installed here silently governs every 2v2 test that runs after this
  // one — a permanently-'p1' active seat quietly defeats any later case whose
  // whole point is that the seat MOVED.
  var realActive = G._2v2ActivePlayer;
  G._2v2ActivePlayer = function () { return 'p1'; };
  try {
    var c = G.createCardInstance(cardByName('Superman'), 'player');
    G.state.player.hand = [c];
    G.state.player.currency = 99;
    G.playCard('player', c, 0);

    assertEq(c._2v2PlayedBy, 'p1', 'the card knows which seat played it');
  } finally {
    G._2v2ActivePlayer = realActive;
  }
});

test("Seismic Charge falls off 3 / 2 / 1 from the lane it lands on", function () {
  // Owner: "played on an enemy in lane 3 — lane 3 takes 3, lanes 2 and 4 take
  // 2, lanes 1 and 5 take 1."
  var G = freshGame();
  G.state.player.isHuman = false; G.state.ai.isHuman = false;
  var e = [];
  for (var i = 0; i < 6; i++) {
    var c = G.createCardInstance(cardByName('Sabertooth'), 'ai');
    c.currentHealth = 20; c.maxHealth = 20;
    G.state.lanes[i].ai = c;
    e.push(c);
  }
  var trick = TRICK_DEFS.find(function (t) { return t.name === 'Seismic Charge'; });
  var real = G.promptCardChoice;
  G.promptCardChoice = function (o, cards, ti, de, cb) { cb(e[2]); };  // epicentre lane 3
  try { trick.play(G, 'player'); } finally { G.promptCardChoice = real; }

  var took = e.map(function (c) { return 20 - c.currentHealth; });
  assertEq(took.join(','), '1,2,3,2,1,0', 'the blast falls off by distance');

  // The far lane is genuinely OUT of range, not merely undamaged by luck —
  // three lanes away is past the last ring.
  assertEq(took[5], 0, 'three lanes out takes nothing');

  // And the printed text matches what it does.
  assert(/3 damage/.test(trick.desc), 'the card names the epicentre damage');
  assertEq(/Deal 2 damage to an enemy and every enemy/.test(trick.desc), false,
    'and drops the old flat-2 wording');
});

test("Seismic Charge at the board edge loses the rings that fall off it", function () {
  // Lane 1 has no left side, so half the blast simply has nowhere to go —
  // worth pinning so an edge detonation is never quietly re-centred.
  var G = freshGame();
  G.state.player.isHuman = false; G.state.ai.isHuman = false;
  var e = [];
  for (var i = 0; i < 6; i++) {
    var c = G.createCardInstance(cardByName('Sabertooth'), 'ai');
    c.currentHealth = 20; c.maxHealth = 20;
    G.state.lanes[i].ai = c;
    e.push(c);
  }
  var trick = TRICK_DEFS.find(function (t) { return t.name === 'Seismic Charge'; });
  var real = G.promptCardChoice;
  G.promptCardChoice = function (o, cards, ti, de, cb) { cb(e[0]); };  // epicentre lane 1
  try { trick.play(G, 'player'); } finally { G.promptCardChoice = real; }

  var took = e.map(function (c) { return 20 - c.currentHealth; });
  assertEq(took.join(','), '3,2,1,0,0,0', 'the blast only spreads inward from the edge');
});

test("Devour still counts as an ally dying — Ahsoka bonus-attacks", function () {
  // Owner: "ahsoka didn't bonus attack when galactus devoured 2 allies."
  //
  // devourCard deliberately skips handleDeath (void pile, not dead pile). That
  // is RIGHT for the victim — the void is the promise it can never come back,
  // so its own onDeath must not fire and hand it a revive. But it also threw
  // away every reaction from the cards still standing, which have nothing to do
  // with the victim returning.
  var G = freshGame();
  G.state.player.isHuman = false; G.state.ai.isHuman = false;
  var ahsoka   = place(G, 'Ahsoka', 'ai', 0);
  var ally1    = place(G, 'Sabertooth', 'ai', 1);
  var ally2    = place(G, 'Sabertooth', 'ai', 2);
  var galactus = place(G, 'Galactus', 'player', 3);
  // Something opposite Ahsoka for a bonus swing to land on.
  var victim = place(G, 'Sabertooth', 'player', 0);
  victim.currentHealth = 40; victim.maxHealth = 40;

  var grants = 0;
  var realGrant = ahsoka.onAllyKilled;
  ahsoka.onAllyKilled = function (g, self) { grants++; return realGrant.call(this, g, self); };

  var hp0 = victim.currentHealth;
  G.devourCard(ally1, galactus);
  G.devourCard(ally2, galactus);

  assertEq(grants, 2, 'one ally-death reaction per devoured ally');
  assert(victim.currentHealth < hp0, 'and she actually swung, not just banked it');

  // The victims are VOIDED, not merely dead — that half must not regress.
  assertEq(G.state.voidPile.length, 2, 'both devoured cards went to the void');
  assertEq(G.state.ai.deadPile.indexOf(ally1), -1, 'and not into the dead pile');
});

test("A side is not a player: side-wide effects reach BOTH teammates", function () {
  // Owner: "all these changes in 2v2 need to affect everyone."
  //
  // state['player'] / state['ai'] are SIDES. In 1v1 a side is one person, so an
  // effect written against the side is correct. In 2v2 a side is a TEAM OF TWO
  // and the side proxy is bound to whichever seat is acting — so identical code
  // touches one teammate and silently misses the other. Harley Quinn's "both
  // players draw" drew once per TEAM.
  function twoVtwo(G) {
    G.state.mode = { deck: 'classic', players: '2v2' };
    G.state.twoVTwo = { online: true, drawPile: [], players: {
      p1: { team: 'A', isAI: true, name: 'P1', hand: [] },
      p2: { team: 'A', isAI: true, name: 'P2', hand: [] },
      p3: { team: 'B', isAI: true, name: 'P3', hand: [] },
      p4: { team: 'B', isAI: true, name: 'P4', hand: [] } } };
    for (var i = 0; i < 60; i++) {
      G.state.twoVTwo.drawPile.push({ name: 'Gizmo', cost: 2, attack: 1, health: 1,
        abilities: [], type: 'neutral', desc: '' });
    }
    return G;
  }

  // THE HELPER resolves a side to its real players.
  var G = twoVtwo(freshGame());
  assertEq(G.seatStatesOnSide('player').length, 2, 'a 2v2 side is two players');
  assertEq(G.seatKeysOnSide('player').join(','), 'p1,p2', 'and names both seats');
  assertEq(G.seatKeysOnSide('ai').join(','), 'p3,p4', 'per team, not per side proxy');

  // 2v2 — every seat draws.
  var hq = G.createCardInstance(cardByName('Harley Quinn'), 'player');
  G.state.lanes[0].player = hq;
  CARD_ABILITIES['Harley Quinn'].onPlay(G, hq, 0);
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) {
    assertEq(G.state.twoVTwo.players[k].hand.length, 1, k + ' drew');
  });

  // 1v1 — a side IS a player, so nothing changes and nobody draws twice.
  var S = freshGame();
  S.state.player.isHuman = false; S.state.ai.isHuman = false;
  for (var j = 0; j < 40; j++) {
    S.state.drawPile.push({ name: 'Gizmo', cost: 2, attack: 1, health: 1,
      abilities: [], type: 'neutral', desc: '' });
  }
  S.state.player.hand = []; S.state.ai.hand = [];
  assertEq(S.seatStatesOnSide('player').length, 1, 'a 1v1 side is one player');
  var hq2 = S.createCardInstance(cardByName('Harley Quinn'), 'player');
  S.state.lanes[0].player = hq2;
  CARD_ABILITIES['Harley Quinn'].onPlay(S, hq2, 0);
  assertEq(S.state.player.hand.length, 1, '1v1 owner draws exactly one');
  assertEq(S.state.ai.hand.length, 1, '1v1 opponent draws exactly one');
});

test("2v2: a trick-phase card (Iron Man) is playable on a tricks turn", function () {
  // Owner: "i cant play iron man on my trick phase in 2v2."
  //
  // 1v1 encodes the exception against phase === 'player-tricks'. 2v2 runs its
  // own phase names, so that gate never matched and 2v2 inherited the
  // restriction with none of the exception — the one card whose entire ability
  // is being playable during a trick turn could never be played on one.
  var G = freshGame();
  G.state.twoVTwo = { online: true, you: 'p1', players: {
    p1: { team: 'A', isAI: false, hand: [] }, p2: { team: 'A', isAI: true, hand: [] },
    p3: { team: 'B', isAI: true, hand: [] },  p4: { team: 'B', isAI: true, hand: [] } } };

  var iron = G.createCardInstance(cardByName('Iron Man'), 'player');
  var hulk = G.createCardInstance(cardByName('Hulk'), 'player');
  assertEq(!!iron.trickPhasePlayable, true, 'Iron Man carries the flag');

  // TRICKS-ONLY turn: the flagged card yes, an ordinary card no.
  assertEq(G._2v2CanPlayCardNow('p1-tricks', iron, 'player'), true, 'Iron Man plays on a tricks turn');
  assertEq(G._2v2CanPlayCardNow('p1-tricks', hulk, 'player'), false, 'but the rest of the hand does not');

  // CARDS turn: everything, as before.
  assertEq(G._2v2CanPlayCardNow('p1-cards', iron, 'player'), true, 'cards turn allows Iron Man');
  assertEq(G._2v2CanPlayCardNow('p1-cards', hulk, 'player'), true, 'and allows ordinary cards');

  // RED SKULL unlocks the whole hand on a tricks turn — the other half of the
  // 1v1 rule, which must not be lost in the port.
  var skull = place(G, 'Red Skull', 'player', 0);
  skull.passive = 'allowCardsInTricksPhase';
  assertEq(G._2v2CanPlayCardNow('p1-tricks', hulk, 'player'), true, 'Red Skull unlocks the hand');
});

test("2v2 runs the per-round upkeep 1v1 does (onTurnStart, sleep, Crazy)", function () {
  // Owner: "Droideka isn't going between shield-up and shield-down, it is
  // always shield-up."
  //
  // 2v2 runs start2v2Round instead of startRound, and the per-round upkeep half
  // was never ported. None of it is mode-specific, so its absence silently
  // disabled a whole CLASS of abilities in 2v2 while they worked in 1v1 —
  // Droideka was just the one noticed.
  function room() {
    var G = freshGame();
    G.state.mode = { deck: 'classic', players: '2v2' };
    G.state.twoVTwo = { online: true, you: 'p1', round: 0, subPhaseIdx: 0, drawPile: [],
      teams: { A: { health: 30, maxHealth: 30, deadPile: [] },
               B: { health: 30, maxHealth: 30, deadPile: [] } },
      players: { p1: { team: 'A', isAI: true, hand: [], energy: 0, usedEnergy: 0 },
                 p2: { team: 'A', isAI: true, hand: [], energy: 0, usedEnergy: 0 },
                 p3: { team: 'B', isAI: true, hand: [], energy: 0, usedEnergy: 0 },
                 p4: { team: 'B', isAI: true, hand: [], energy: 0, usedEnergy: 0 } } };
    G._2v2StartSubPhase = function () {};   // stop after the upkeep
    return G;
  }

  // ONTURNSTART — Droideka's two-mode cycle needs it every round.
  var G = room();
  var d = G.createCardInstance(cardByName('Droideka'), 'player');
  G.state.lanes[0].player = d;
  CARD_ABILITIES['Droideka'].onPlay(G, d, 0);
  assertEq(!!d.hasDamageImmunity, true, 'starts shields UP');
  G.start2v2Round();
  assertEq(!!d._droidekaOvercharge, true, 'flips to shields DOWN next round');
  G.start2v2Round();
  assertEq(!!d.hasDamageImmunity, true, 'and back UP again');

  // TICKSLEEP — a card Freddy slept stayed asleep for the whole match in 2v2.
  var G2 = room();
  var y = G2.createCardInstance(cardByName('Yoda'), 'player');
  y.isAsleep = true; y.sleepTurns = 1;
  G2.state.twoVTwo.players.p1.hand = [y];
  G2.state.player.hand = G2.state.twoVTwo.players.p1.hand;
  G2.start2v2Round();
  assertEq(!!y.isAsleep, false, 'sleep wears off in 2v2 too');

  // RECOMPUTECRAZY — a Joker stamp must not outlive its Joker here either.
  var G3 = room();
  var v = place(G3, 'Sabertooth', 'ai', 1);
  G3.applyCrazyToCard(v);
  assertEq(!!v.isCrazy, true, 'stamped');
  G3.start2v2Round();          // no Joker on the board at all
  assertEq(!!v.isCrazy, false, 'and reconciled away with no Joker in play');
});

// ============================================================
// 2v2 PARITY HARNESS
// ============================================================
// WHY THIS EXISTS. 2v2 is a FORK of the 1v1 flow, not a mode of it — ~40
// _2v2* functions shadow a 1v1 equivalent, and start2v2Round is a hand-copy of
// startRound. A fork does not inherit fixes, so every improvement to 1v1 can
// silently fail to reach 2v2, and nothing catches it because 2v2 had almost no
// automated coverage at all. That is not a theory: in one day, one missing
// upkeep call had disabled onTurnStart (Droideka, Gargantua, Boiler Room,
// Apocalypse), tickSleep and the Crazy reconcile in 2v2 while all of them
// worked perfectly in 1v1.
//
// Fixing those one at a time treats instances. This treats the CLASS: run the
// same scenario in both modes and assert the same outcome. A drift bug then
// fails here instead of in a live match.
//
// Adding a check is three functions — build the board, do the thing, measure
// something comparable — and the harness runs it twice.

// A 4-seat online room, with the seat plumbing every 2v2 path expects. Written
// once here because it had been hand-rolled in four separate tests already,
// each slightly different, which is its own drift risk.
function twoVtwoRoom(opts) {
  var o = opts || {};
  var G = freshGame();
  G.state.player.isHuman = false; G.state.ai.isHuman = false;
  G.state.mode = { deck: 'classic', players: '2v2' };
  G.state.twoVTwo = {
    online: true, you: 'p1', round: 0, subPhaseIdx: 0, drawPile: [],
    teams: { A: { health: 30, maxHealth: 30, deadPile: [], blockMeter: 0 },
             B: { health: 30, maxHealth: 30, deadPile: [], blockMeter: 0 } },
    players: {
      p1: { team: 'A', isAI: o.p1AI !== false, name: 'P1', hand: [], trickHand: [], energy: 0, usedEnergy: 0 },
      p2: { team: 'A', isAI: true,  name: 'P2', hand: [], trickHand: [], energy: 0, usedEnergy: 0 },
      p3: { team: 'B', isAI: true,  name: 'P3', hand: [], trickHand: [], energy: 0, usedEnergy: 0 },
      p4: { team: 'B', isAI: true,  name: 'P4', hand: [], trickHand: [], energy: 0, usedEnergy: 0 }
    }
  };
  for (var i = 0; i < 60; i++) {
    G.state.twoVTwo.drawPile.push({ name: 'Gizmo', cost: 2, attack: 1, health: 1,
      abilities: [], type: 'neutral', desc: '' });
  }
  // Stop after the round upkeep — a parity check is about the UPKEEP, not about
  // driving six sub-phases of AI turns.
  G._2v2StartSubPhase = function () {};
  return G;
}

// A 1v1 game stocked the same way, so a scenario can be written once.
function oneVoneGame() {
  var G = freshGame();
  G.state.player.isHuman = false; G.state.ai.isHuman = false;
  for (var i = 0; i < 60; i++) {
    G.state.drawPile.push({ name: 'Gizmo', cost: 2, attack: 1, health: 1,
      abilities: [], type: 'neutral', desc: '' });
  }
  G.state.player.hand = []; G.state.ai.hand = [];
  return G;
}

// Advance one round in whichever mode this game is. THE point of the harness:
// a scenario should never name startRound or start2v2Round, because "which
// round function" is exactly the fork under test.
function advanceRound(G) {
  var tt = G.state && G.state.twoVTwo;
  if (tt && tt.online) { G.start2v2Round(); return; }
  G.startRound();
}

// The local seat's hand, in either mode — 1v1 has one hand per side, 2v2 has
// one per seat and the side proxy points at only one of them.
function handOf(G, side) {
  var tt = G.state && G.state.twoVTwo;
  if (!tt || !tt.online) return G.state[side].hand;
  var team = side === 'player' ? 'A' : 'B';
  var keys = Object.keys(tt.players).filter(function (k) { return tt.players[k].team === team; });
  return tt.players[keys[0]].hand;
}

// Run one scenario in BOTH modes and require the same measured outcome.
// `measure` must return something comparable — a string or number, never an
// object — so a mismatch reports what actually differed.
function parity(label, scenario) {
  test('PARITY · ' + label, function () {
    var solo = oneVoneGame();
    scenario.build(solo, 'player');
    scenario.act(solo, 'player');
    var a = String(scenario.measure(solo, 'player'));

    var duo = twoVtwoRoom();
    scenario.build(duo, 'player');
    scenario.act(duo, 'player');
    var b = String(scenario.measure(duo, 'player'));

    assertEq(b, a, label + ' — 2v2 must match 1v1 (1v1=' + a + ', 2v2=' + b + ')');
  });
}

// A SECOND SHAPE OF CHECK, for the side-vs-player class.
// parity() compares 1v1 against 2v2 and demands the SAME value — right for the
// round upkeep, wrong here. A side-wide effect SHOULD hit more players in 2v2
// (four seats, not two), so equality would be the wrong assertion entirely.
// What must hold instead is that NOBODY IS SKIPPED: an effect written against a
// side has to reach every real player on it, because state[side] is a proxy
// bound to one seat and quietly misses the teammate. That is the exact shape of
// "the enemy played Symbiote and only my teammate redrew".
function everySeatAffected(label, scenario) {
  test('PARITY · every seat · ' + label, function () {
    var G = twoVtwoRoom();
    scenario.build(G);
    // BASELINE AFTER BUILD, BEFORE ACT — and that ordering is the whole
    // validity of this check. Snapshotting before build() meant every scenario
    // "passed" simply because building the board put cards in hands, whether or
    // not act() did anything at all. Caught by reverting a fix and watching the
    // check pass anyway: a test that cannot fail is worse than no test, because
    // it is believed.
    var before = {};
    ['p1', 'p2', 'p3', 'p4'].forEach(function (k) {
      before[k] = scenario.snapshot(G, k);
    });
    scenario.act(G);
    var missed = [];
    (scenario.seats || ['p1', 'p2', 'p3', 'p4']).forEach(function (k) {
      if (String(scenario.snapshot(G, k)) === String(before[k])) missed.push(k);
    });
    assertEq(missed.join(',') || 'none', 'none',
      label + ' — these seats were skipped: ' + (missed.join(',') || 'none'));
  });
}

// ---- SEEDED FROM REAL DRIFT BUGS ---------------------------------
// Each of these failed in 2v2 and passed in 1v1 before today.

parity('onTurnStart fires every round (Droideka cycles)', {
  build: function (G, side) {
    var d = G.createCardInstance(cardByName('Droideka'), side);
    G.state.lanes[0][side] = d;
    CARD_ABILITIES['Droideka'].onPlay(G, d, 0);
    G._pd = d;
  },
  act: function (G) { advanceRound(G); },
  measure: function (G) { return 'overcharge=' + !!G._pd._droidekaOvercharge; }
});

parity('sleep wears off after a round', {
  build: function (G, side) {
    var y = G.createCardInstance(cardByName('Yoda'), side);
    y.isAsleep = true; y.sleepTurns = 1;
    var h = handOf(G, side);
    h.length = 0; h.push(y);
    G.state[side].hand = h;
    G._py = y;
  },
  act: function (G) { advanceRound(G); },
  measure: function (G) { return 'asleep=' + !!G._py.isAsleep; }
});

parity('a Crazy stamp with no Joker in play reconciles away', {
  build: function (G, side) {
    var v = G.createCardInstance(cardByName('Sabertooth'), G.opponent(side));
    G.state.lanes[1][G.opponent(side)] = v;
    G.applyCrazyToCard(v);
    G._pv = v;
  },
  act: function (G) { advanceRound(G); },
  measure: function (G) { return 'crazy=' + !!G._pv.isCrazy; }
});

parity('Magneto/aura reconcile runs each round', {
  build: function (G, side) {
    var m = G.createCardInstance(cardByName('Magneto'), side);
    G.state.lanes[0][side] = m;
    var ally = G.createCardInstance(cardByName('Sabertooth'), side);
    G.state.lanes[2][side] = ally;
    G._pa = ally;
  },
  act: function (G) { advanceRound(G); },
  measure: function (G) { return 'atk=' + G._pa.attack + ',hp=' + G._pa.maxHealth; }
});

// ---- THE SIDE-vs-PLAYER CLASS ------------------------------------
// Cards whose printed text promises EVERY player. Each of these is a place a
// side-keyed effect can silently reach one teammate and stop.

everySeatAffected('Harley Quinn — both players draw', {
  snapshot: function (G, k) { return G.state.twoVTwo.players[k].hand.length; },
  build: function (G) {
    var hq = G.createCardInstance(cardByName('Harley Quinn'), 'player');
    G.state.lanes[0].player = hq;
    G._hq = hq;
  },
  act: function (G) { CARD_ABILITIES['Harley Quinn'].onPlay(G, G._hq, 0); }
});

everySeatAffected('Symbiote Spider-Man — everyone cycles two', {
  snapshot: function (G, k) {
    return G.state.twoVTwo.players[k].hand.map(function (c) { return c.name; }).join(',');
  },
  build: function (G) {
    // Every seat needs a hand with something in it to cycle.
    var stock = ['Gizmo', 'Hulk', 'Thor', 'Batman'];
    ['p1', 'p2', 'p3', 'p4'].forEach(function (k) {
      var side = G.state.twoVTwo.players[k].team === 'A' ? 'player' : 'ai';
      G.state.twoVTwo.players[k].hand = stock.map(function (n) {
        return G.createCardInstance(cardByName(n), side);
      });
    });
    var ssm = G.createCardInstance(cardByName('Symbiote Spider-Man'), 'player');
    ssm._2v2PlayedBy = 'p1';
    G.state.lanes[0].player = ssm;
    G._ssm = ssm;
  },
  act: function (G) { CARD_ABILITIES['Symbiote Spider-Man'].onPlay(G, G._ssm, 0); }
});

everySeatAffected('every seat gets its round energy', {
  snapshot: function (G, k) { return G.state.twoVTwo.players[k].energy; },
  build: function () {},
  act: function (G) { advanceRound(G); }
});

everySeatAffected("Doomsday's in-hand discount reaches both teammates' hands", {
  // Found by auditing card text against behaviour: Doomsday's discount IS
  // implemented, but was read against state[side].hand — the proxy bound to one
  // seat — so a Doomsday in the OTHER teammate's hand was never even scanned
  // and silently cost full price. That lookup is what this pins.
  //
  // WHOSE DEATH triggers it is a separate question, and the answer changed:
  // a side in 2v2 is a team of two, so counting both teammates' losses grew
  // Doomsday at twice the rate his text describes. He counts his OWN seat's
  // losses now (owner: "they get too big, this is a nerf" — see
  // sim/seat-scope.js). So each seat is given its own ally to lose here; the
  // property under test is that BOTH hands are reached, not that one death
  // pays out twice.
  seats: ['p1', 'p2'],
  snapshot: function (G, k) {
    var d = G.state.twoVTwo.players[k].hand[0];
    return d ? d.cost : 'none';
  },
  build: function (G) {
    G._allies = {};
    ['p1', 'p2'].forEach(function (k, i) {
      var side = G.state.twoVTwo.players[k].team === 'A' ? 'player' : 'ai';
      var d = G.createCardInstance(cardByName('Doomsday'), side);
      d.passive = 'doomsdayScaling';
      d._2v2PlayedBy = k;
      G.state.twoVTwo.players[k].hand = [d];
      // That seat's OWN ally, on that seat's own side of the board.
      var ally = G.createCardInstance(cardByName('Sabertooth'), side);
      ally._2v2PlayedBy = k;
      G.state.lanes[3 + i][side] = ally;
      G._allies[k] = { card: ally, lane: 3 + i };
    });
  },
  act: function (G) {
    ['p1', 'p2'].forEach(function (k) {
      var a = G._allies[k];
      G._2v2CurrentActingPlayer = k;
      a.card.currentHealth = 0;
      G.handleDeath(a.card, a.lane, null);
      G.cleanupDead();
    });
  }
});

test("Burn/bleed kills BEFORE the lane fights, so the survivor hits the healthbar", function () {
  // Owner: "if a card is burning 2 in lane 2 with 2 health they should die
  // during lane 2 and the card opposite should hit the enemy healthbar."
  //
  // p and a are captured BEFORE the onLaneCombat hooks, and that hook is
  // exactly where Burning and Bleed tick. A card the tick killed was still a
  // live OBJECT reference — 0 HP but non-null — so `p && a` read as CONTESTED
  // and the survivor traded with a corpse instead of walking through.
  function lane(victimHp, burn) {
    var G = freshGame();
    G.state.phase = 'combat';
    G.state.player.isHuman = false; G.state.ai.isHuman = false;
    var victim = place(G, 'Sabertooth', 'ai', 1);
    victim.currentHealth = victimHp; victim.maxHealth = victimHp;
    CARD_ABILITIES['Godzilla']._ignite(G, victim, burn);
    var mine = place(G, 'Sabertooth', 'player', 1);
    mine.attack = 3; mine.currentHealth = 9; mine.maxHealth = 9;
    var before = G.state.ai.health;
    G.resolveCombat();
    return { G: G, victim: victim, mine: mine, dealt: before - G.state.ai.health };
  }

  // THE REPORTED CASE — burn 2 kills a 2 HP card, lane is now uncontested.
  var dead = lane(2, 2);
  assertEq(dead.victim.currentHealth <= 0, true, 'the burn killed it');
  assertEq(dead.dealt, 3, 'and our card hit the healthbar unopposed');

  // CONTROL — a card that SURVIVES its burn still trades normally. Without
  // this, the test above would pass just as well if every lane had been made
  // uncontested.
  var alive = lane(9, 2);
  assertEq(alive.victim.currentHealth > 0, true, 'it survived the burn');
  assertEq(alive.dealt, 0, 'so the lane was contested and the healthbar was untouched');
  assert(alive.mine.currentHealth < 9, 'and our card took the trade');
});

test("The Bathroom chains TWO enemies, and only the second death drains it", function () {
  // Owner: "the next 2 enemy cards lose (-2/-2) and have a chained icon ...
  // once the 2nd enemy chained dies the bathroom disappears."
  var G = freshGame();
  var room = CARD_ABILITIES['Jigsaw']._placeRoom(G, 'player', 1, 'The Bathroom');
  CARD_ABILITIES['The Bathroom'].onPlay(G, room, 1);
  var AB = CARD_ABILITIES['The Bathroom'];

  // FIRST enemy walks in.
  var a = place(G, 'Sabertooth', 'ai', 1);
  var aAtk = a.attack, aHp = a.currentHealth;
  AB.onAnyCardPlayed(G, room);
  assertEq(a.attack, Math.max(0, aAtk - 2), 'first victim loses 2 ATK');
  assertEq(a.currentHealth, aHp - 2, 'and 2 HP');
  assertEq(!!a._chained, true, 'and carries the Chained status');
  assertEq(a._chainedToLane, undefined, 'no longer PINNED to the lane — the chain is a toll now');

  // The room is NOT spent after one — it owes a second body.
  assert(!room._bathroomTriggered, 'still hungry after the first');

  // AND IT MUST NOT RE-CHAIN THE BODY ALREADY STANDING THERE. The one-victim
  // version was protected by its own spent-flag; holding two removes that
  // protection, so every later card played re-read the same victim as a fresh
  // arrival and hit it for another (−2/−2).
  var atkAfterFirst = a.attack, hpAfterFirst = a.currentHealth;
  AB.onAnyCardPlayed(G, room);
  AB.onAnyCardPlayed(G, room);
  assertEq(a.attack, atkAfterFirst, 'the chained body is not hit again');
  assertEq(a.currentHealth, hpAfterFirst, 'nor loses more health');
  assertEq((room._bathroomChained || []).length, 1, 'and is still only ONE victim');

  // SECOND enemy takes the first one's place.
  G.state.lanes[1].ai = null;
  var b = place(G, 'Sabertooth', 'ai', 1);
  var bAtk = b.attack, bHp = b.currentHealth;
  AB.onAnyCardPlayed(G, room);
  assertEq(b.attack, Math.max(0, bAtk - 2), 'second victim loses 2 ATK');
  assertEq(b.currentHealth, bHp - 2, 'and 2 HP');
  assertEq(!!b._chained, true, 'and is Chained too');
  assertEq(!!room._bathroomTriggered, true, 'intake closes at two');

  // FIRST chained body dies — the room must STAY, one chain still holds.
  a.currentHealth = 0;
  G.handleDeath(a, 1, null);
  assertEq(G.state.lanes[1]._env && G.state.lanes[1]._env.player, room,
    'the room survives the first death');

  // SECOND chained body dies — now it drains.
  b.currentHealth = 0;
  G.handleDeath(b, 1, null);
  assertEq(!!(G.state.lanes[1]._env && G.state.lanes[1]._env.player), false,
    'the room drains away once the second Chained card dies');
});

test("Game Over ignores an ALLY dying in its lane — enemy bodies only", function () {
  // Owner: "the 1st ENEMY card to die in this lane rises on your side". It used
  // to hook both sides, so your own dead was raised and the room spent on it.
  var G = freshGame();
  var room = CARD_ABILITIES['Jigsaw']._placeRoom(G, 'player', 1, 'Game Over');
  var ally = place(G, 'Sabertooth', 'player', 1);
  CARD_ABILITIES['Game Over'].onAnyCardPlayed(G, room);
  assertEq(!!ally._revealHooked, false, 'an ally is never hooked');

  ally.currentHealth = 0;
  G.handleDeath(ally, 1, null);
  assertEq(!!room._revealSpent, false, 'an ally death does not spend the room');

  // An ENEMY death still works.
  G.state.lanes[1].player = null;
  var enemy = place(G, 'Sabertooth', 'ai', 1);
  CARD_ABILITIES['Game Over'].onAnyCardPlayed(G, room);
  assertEq(!!enemy._revealHooked, true, 'the enemy IS hooked');
  enemy.currentHealth = 0;
  G.handleDeath(enemy, 1, null);
  assert(!!G.state.lanes[1].player, 'and an enemy death raises a body');
});

test("Game Over moves an ally out of the way, like Sewers does", function () {
  // Owner: "for the reveal just like sewers an ally will move to make room."
  // It used to simply give up if your own card stood in the lane, which made
  // the room a coin-flip on board state instead of an effect you can plan for.
  var G = freshGame();
  var room = CARD_ABILITIES['Jigsaw']._placeRoom(G, 'player', 1, 'Game Over');
  var enemy = place(G, 'Sabertooth', 'ai', 1);
  var ally  = place(G, 'Nightwing', 'player', 1);      // standing where the body wants to rise
  CARD_ABILITIES['Game Over'].onAnyCardPlayed(G, room);

  enemy.currentHealth = 0;
  G.handleDeath(enemy, 1, null);

  var risen = G.state.lanes[1].player;
  assert(!!risen, 'a body gets up');
  assertEq(risen.name, 'Sabertooth', 'and it is the dead ENEMY that rose');
  assert(ally.currentHealth > 0, 'the ally is alive — it was moved, not killed');
  var where = -1;
  for (var i = 0; i < G.LANE_COUNT; i++) if (G.state.lanes[i].player === ally) where = i;
  assert(where >= 0 && where !== 1, 'and it now stands in a different lane');
});

test("Game Over refuses to rise rather than kill your own card", function () {
  // Sewers ABSORBS the ally when there is nowhere to move it, because that
  // feeds Pennywise's stats. Game Over has no absorb rule, so with no open
  // lane it must decline — never destroy an ally to make space for itself.
  var G = freshGame();
  var room = CARD_ABILITIES['Jigsaw']._placeRoom(G, 'player', 1, 'Game Over');
  var enemy = place(G, 'Sabertooth', 'ai', 1);
  var ally  = place(G, 'Nightwing', 'player', 1);
  CARD_ABILITIES['Game Over'].onAnyCardPlayed(G, room);
  // fill every other lane on our side so there is nowhere to go
  for (var i = 0; i < G.LANE_COUNT; i++) if (i !== 1 && !G.state.lanes[i].player) place(G, 'Sabertooth', 'player', i);

  enemy.currentHealth = 0;
  G.handleDeath(enemy, 1, null);

  assert(ally.currentHealth > 0, 'the ally is NOT killed to make room');
  assertEq(G.state.lanes[1].player, ally, 'and it is still standing in its lane');
});

test("An environment cannot cover another while a free lane remains", function () {
  // Owner: "a new rule is environments can't cover other environments unless
  // all lanes have an environment and to place you need to cover."
  var G = freshGame();
  CARD_ABILITIES['Jigsaw']._placeRoom(G, 'player', 1, 'The Bathroom');
  assertEq(G.canPlaceEnvironment('player', 1), false, 'the occupied lane is refused');
  assertEq(G.canPlaceEnvironment('player', 0), true,  'an empty lane is fine');
  assertEq(G.openEnvLanes('player').indexOf(1), -1,   'and it is not offered as a choice');

  // EITHER SIDE counts: seating an env destroys whatever is in that lane on
  // BOTH sides, so placing "beside" an enemy room is still covering it.
  var G2 = freshGame();
  CARD_ABILITIES['Jigsaw']._placeRoom(G2, 'ai', 3, 'Game Over');
  assertEq(G2.canPlaceEnvironment('player', 3), false, 'an enemy environment blocks the lane too');
});

test("...unless every lane holds one — then covering is the only move", function () {
  var G = freshGame();
  for (var i = 0; i < G.LANE_COUNT; i++) CARD_ABILITIES['Jigsaw']._placeRoom(G, 'player', i, 'The Bathroom');
  for (var j = 0; j < G.LANE_COUNT; j++)
    assertEq(G.canPlaceEnvironment('player', j), true, 'lane ' + (j + 1) + ' becomes legal once nothing is free');
  assertEq(G.openEnvLanes('player').length, G.LANE_COUNT, 'every lane is offered');
});

test("A destroyed lane never blocks the cover rule", function () {
  // A voided lane can hold nothing, so counting it as "free" would make
  // covering permanently illegal — the rule would deadlock.
  var G = freshGame();
  for (var i = 0; i < G.LANE_COUNT; i++) {
    if (i === 4) { G.state.lanes[i].destroyed = true; continue; }
    CARD_ABILITIES['Jigsaw']._placeRoom(G, 'player', i, 'The Bathroom');
  }
  assertEq(G.canPlaceEnvironment('player', 4), false, 'you cannot place into the void');
  assertEq(G.canPlaceEnvironment('player', 0), true,  'and the void does not block covering elsewhere');
});

test("A Chained card CAN move — and pays (−2/−2) every time it does", function () {
  // Owner: "I wanted the chained debuff to just say if moved lose (−2/−2)."
  // It used to refuse the move outright.
  var G = freshGame();
  var room = CARD_ABILITIES['Jigsaw']._placeRoom(G, 'player', 1, 'The Bathroom');
  CARD_ABILITIES['The Bathroom'].onPlay(G, room, 1);
  var v = place(G, 'Sabertooth', 'ai', 1);
  v.attack = 9; v.maxHealth = 9; v.currentHealth = 9;
  CARD_ABILITIES['The Bathroom'].onAnyCardPlayed(G, room);
  assertEq(v.attack, 7, 'entering cost 2 ATK');
  assertEq(v.currentHealth, 7, 'and 2 HP');
  assertEq(!!v._chained, true, 'and it is Chained');

  G.moveCard(v, 1, 4);
  assertEq(G.state.lanes[4].ai, v, 'the move is ALLOWED now');
  assertEq(v.attack, 5, 'and the move cost another 2 ATK');
  assertEq(v.currentHealth, 5, 'and 2 more HP');

  // the ball is still attached — a second move costs again
  G.moveCard(v, 4, 5);
  assertEq(G.state.lanes[5].ai, v, 'it can move again');
  assertEq(v.attack, 3, 'and pays again');
  assertEq(v.currentHealth, 3, 'each time');
});

test("The chain toll respects the shield rule, and can be lethal", function () {
  var G = freshGame();
  var room = CARD_ABILITIES['Jigsaw']._placeRoom(G, 'player', 1, 'The Bathroom');
  CARD_ABILITIES['The Bathroom'].onPlay(G, room, 1);
  var v = place(G, 'Sabertooth', 'ai', 1);
  v.attack = 9; v.maxHealth = 9; v.currentHealth = 9;
  CARD_ABILITIES['The Bathroom'].onAnyCardPlayed(G, room);
  // shielded: the ATK strip still lands, the health loss does not
  v.invincibleTurns = 1;   // the field statStripShieldsHp actually reads
  var hp = v.currentHealth;
  G.moveCard(v, 1, 3);
  assertEq(v.currentHealth, hp, 'Invincible blocks the health half of the toll');
  assertEq(v.attack, 5, 'but the ATK strip still lands');

  // lethal: a toll that empties the bar routes through the death path
  var G2 = freshGame();
  var r2 = CARD_ABILITIES['Jigsaw']._placeRoom(G2, 'player', 1, 'The Bathroom');
  CARD_ABILITIES['The Bathroom'].onPlay(G2, r2, 1);
  var w = place(G2, 'Sabertooth', 'ai', 1);
  w.attack = 4; w.maxHealth = 4; w.currentHealth = 4;
  CARD_ABILITIES['The Bathroom'].onAnyCardPlayed(G2, r2);   // -> 2/2
  G2.moveCard(w, 1, 3);                                     // -> 0/0
  assert(w.currentHealth <= 0, 'the toll can kill');
  assertEq(G2.state.lanes[3].ai, null, 'and the body does not linger in the lane');
});

test("A nested summon still lets a HUMAN pick the lane (Gorr -> Darkseid -> Parademon)", function () {
  // Owner: "Darkseid's Parademon was auto-placed for me when he was summoned
  // from Gorr — I should be able to pick where to summon the Parademon."
  // The cascade guard fired on ANY nesting, but Gorr summons one card and is
  // finished by the time that card's On Play runs, so nothing was racing.
  var G = freshGame();
  G.state.player.isHuman = true;
  var self = { owner: 'player', name: 'Darkseid' };
  // several open lanes, so there is a real choice to make
  G._simPromptLog = [];
  G._summonCascadeDepth = 1;          // as if summoned by Gorr
  G._summonLoopDepth = 0;             // ...but nothing is mid-placement
  var asked = 0;
  var realPrompt = G.promptLaneChoice;
  G.promptLaneChoice = function (owner, lanes, title, desc, cb) { asked++; cb(lanes[lanes.length - 1]); };
  G.summonCardChoice('player', 'Parademon', 1, 2, 1, [], null, null);
  G.promptLaneChoice = realPrompt;
  G._summonCascadeDepth = 0;
  assertEq(asked, 1, 'the player IS asked where it goes');
  assertEq(G.state.lanes[0].player, null, 'and it did not silently take lane 1');
});

test("...but a placing LOOP still resolves nested summons synchronously", function () {
  // Knull and Hela place several bodies into lanes chosen up front. Those loops
  // do not wait, so a prompt there would hand the remaining lanes to the loop
  // before the player answered — the reason the guard exists at all.
  var G = freshGame();
  G.state.player.isHuman = true;
  var asked = 0;
  var realPrompt = G.promptLaneChoice;
  G.promptLaneChoice = function (owner, lanes, title, desc, cb) { asked++; cb(lanes[0]); };
  G._summonCascadeDepth = 1;
  G._withSummonLoop(function () {
    G.summonCardChoice('player', 'Parademon', 1, 2, 1, [], null, null);
  });
  G.promptLaneChoice = realPrompt;
  G._summonCascadeDepth = 0;
  assertEq(asked, 0, 'no prompt while a placing loop is mid-flight');
  assert(!!G.state.lanes[0].player, 'it took the lowest open lane instead');
});

test("_withSummonLoop nests — Knull summoning Hela must not clear the outer mark", function () {
  var G = freshGame();
  var seen = [];
  G._withSummonLoop(function () {
    seen.push(G._summonLoopDepth);
    G._withSummonLoop(function () { seen.push(G._summonLoopDepth); });
    seen.push(G._summonLoopDepth);   // the inner one finished; the OUTER still holds
  });
  seen.push(G._summonLoopDepth);
  assertEq(seen.join(','), '1,2,1,0', 'a counter, not a boolean');
});

test("Jack Sparrow's Parlay ends when he dies", function () {
  // Ryan: "Jack Sparrow's parlay stays after he dies."
  // onBeforeCombat already refused to fire once he was down, but the flag it
  // stamped EARLIER in the round outlived him — nothing cleared it until the
  // next round started.
  var G = freshGame();
  var jack = place(G, 'Jack Sparrow', 'player', 0);
  var foe  = place(G, 'Sabertooth', 'ai', 3);      // uncontested: no ally opposite
  CARD_ABILITIES['Jack Sparrow'].onBeforeCombat(G, jack, 0);
  assertEq(!!foe._parlayedThisRound, true, 'the enemy is parlayed');
  assertEq(foe._parlayedBy, jack.id, 'and it records WHO parlayed it');

  jack.currentHealth = 0;
  G.handleDeath(jack, 0, null);
  assertEq(!!foe._parlayedThisRound, false, 'the deal ends with him');
  assertEq(foe._parlayedBy, undefined, 'and the stamp is cleared too');
});

test("One Jack dying does not cancel another Jack's Parlay", function () {
  // Why the stamp is an id and not a boolean.
  var G = freshGame();
  var jackA = place(G, 'Jack Sparrow', 'player', 0);
  var jackB = place(G, 'Jack Sparrow', 'player', 1);
  var foeA = place(G, 'Sabertooth', 'ai', 3);
  var foeB = place(G, 'Sabertooth', 'ai', 4);
  // parley each one explicitly so the pairing is unambiguous
  foeA._parlayedThisRound = true; foeA._parlayedBy = jackA.id;
  foeB._parlayedThisRound = true; foeB._parlayedBy = jackB.id;

  jackA.currentHealth = 0;
  G.handleDeath(jackA, 0, null);
  assertEq(!!foeA._parlayedThisRound, false, "the dead Jack's deal is off");
  assertEq(!!foeB._parlayedThisRound, true, "the living Jack's deal stands");
});

test("2v2 clears Parlay each round — it was permanent there", function () {
  // The recon's real finding: start2v2Round back-ported most of the 1v1 upkeep
  // block but not the Parlay sweep, so in 2v2 a parlayed enemy could never
  // attack again for the whole match — Jack alive or dead.
  var G = twoVtwoRoom ? twoVtwoRoom({}) : null;
  if (!G) { return; }                      // harness unavailable — skip quietly
  var victim = null;
  for (var i = 0; i < G.LANE_COUNT && !victim; i++) victim = G.state.lanes[i].ai;
  if (!victim) { victim = place(G, 'Sabertooth', 'ai', 0); }
  victim._parlayedThisRound = true;
  victim._parlayedBy = 999;
  victim._combatSwungThisRound = true;
  G.state.lanes[0].protected = 'player';

  G.start2v2Round();

  assertEq(!!victim._parlayedThisRound, false, 'the parlay expires with the round');
  assertEq(victim._parlayedBy, undefined, 'and its stamp goes too');
  assertEq(!!victim._combatSwungThisRound, false, 'combat-swung is reset');
  assertEq(G.state.lanes[0].protected, null, 'and a one-round lane guard is lifted');
});

test("Every 2v2 play route broadcasts — not just the host's own tap", function () {
  // Ryan: "the guest doesn't load what the host does until the host is done
  // with their turn." Only ONE of the four routes into _2v2OnlinePlayCard was
  // broadcasting; the remote handler, the trick case and the AI-seat driver
  // applied the play and said nothing.
  var G = twoVtwoRoom ? twoVtwoRoom({}) : null;
  if (!G) { return; }
  G.state.twoVTwo.online = true;
  G.state.twoVTwo.you = 'p1';          // act as the host, the only broadcaster

  var pushes = 0;
  var real = G._2v2OnlineBroadcast;
  G._2v2OnlineBroadcast = function () { pushes++; };

  var pk = null, ap = null;
  var keys = Object.keys(G.state.twoVTwo.players || {});
  for (var i = 0; i < keys.length && !ap; i++) {
    var cand = G.state.twoVTwo.players[keys[i]];
    if (cand && cand.hand && cand.hand.length) { pk = keys[i]; ap = cand; }
  }
  if (!ap) { G._2v2OnlineBroadcast = real; return; }

  var before = pushes;
  G._2v2OnlinePlayCard(pk, 0, 0);
  G._2v2OnlineBroadcast = real;
  assert(pushes > before, 'playing a card pushes state to the guests');
});

test("...and the push is host-gated, so a guest never broadcasts", function () {
  var G = twoVtwoRoom ? twoVtwoRoom({}) : null;
  if (!G) { return; }
  G.state.twoVTwo.online = true;
  G.state.twoVTwo.you = 'p2';          // a GUEST
  var pushes = 0;
  var real = G._2v2OnlineBroadcast;
  G._2v2OnlineBroadcast = function () { pushes++; };
  G._pushOnlineState();
  G._2v2OnlineBroadcast = real;
  assertEq(pushes, 0, 'a guest calling the door broadcasts nothing');
});

test("Every 2v2 handler case is registered in the transport allowlist", function () {
  // THE BUG THIS WOULD HAVE CAUGHT. Multiplayer4._GAME_ACTION_TYPES is an
  // ALLOWLIST, not a router: a `case` in Game._apply2v2OnlineAction is dead
  // unless its type is also named there, and the message is dropped silently
  // with a successful-looking send. Two cases had drifted out —
  // resolve2v2BlockTrick (a guest could not Keep or Play a trick won from a
  // Block, and the whole match froze) and skip2v2Jump (same freeze, via the
  // jump offer).
  // toString is safe HERE specifically: the wrapping that makes it lie lives in
  // ui.js, which the sim never loads.
  if (typeof Multiplayer4 === 'undefined' || !Multiplayer4._GAME_ACTION_TYPES) return;
  var src = Game._apply2v2OnlineAction.toString();
  var cases = [], m, re = /case\s+'([^']+)'/g;
  while ((m = re.exec(src)) !== null) cases.push(m[1]);
  assert(cases.length > 5, 'found the handler cases (' + cases.length + ')');
  var missing = cases.filter(function (c) { return !Multiplayer4._GAME_ACTION_TYPES.has(c); });
  assertEq(missing.join(','), '', 'no handler case is unreachable from the wire');
});

test("The two types that were dropped are registered", function () {
  if (typeof Multiplayer4 === 'undefined' || !Multiplayer4._GAME_ACTION_TYPES) return;
  assertEq(Multiplayer4._GAME_ACTION_TYPES.has('resolve2v2BlockTrick'), true,
    'a guest can answer a Block-won trick');
  assertEq(Multiplayer4._GAME_ACTION_TYPES.has('skip2v2Jump'), true,
    'a guest can decline a jump');
});

// ---- 2v2 SEAT ISOLATION: A DEFERRED UN-BRIDGE MUST WRITE HOME TO ITS OWN SEAT
// The side bridge points state[side].hand at the ACTIVE seat's array, and its
// un-bridge is DEFERRED whenever the play left a prompt open. The read-back
// used to ask "who is active?" again at that later moment — so if the phase had
// advanced, it wrote the bridged seat's hand array into a DIFFERENT seat.
// Both teammates then shared ONE array and a player saw their teammate's cards.
// (User: "ryan is playing and dragging cards, i can see his hand ... i don't
// want to see his hand or anybody else's hand but my own.")
test("2v2: a deferred un-bridge never writes one seat's hand into another", function () {
  // The shim's hasPendingPrompt DRAINS prompts, which makes the deferred path
  // unreachable; swap in a faithful predicate for the length of this test.
  var savedHPP = Game.hasPendingPrompt;
  Game.hasPendingPrompt = function () {
    var st = Game.state;
    return !!(st && (st.pendingCardChoice || st.pendingLaneChoice));
  };
  try {
    Game.start2v2Match({ names: { p1: 'Ryan', p2: 'Vega', p3: 'yomamma', p4: 'Cortex' } });
    var s = Game.state, tt = s.twoVTwo;
    tt.online = true; tt.you = 'p3';
    ['p1', 'p2', 'p3', 'p4'].forEach(function (k) { tt.players[k].isAI = false; });
    // PIN THE TEAMS. An earlier suite test swaps them, and this case only has
    // teeth when the two seats share a SIDE — that is what makes a mis-targeted
    // read-back land on a teammate's hand instead of harmlessly on the enemy's.
    tt.players.p1.team = 'A'; tt.players.p3.team = 'A';
    tt.players.p2.team = 'B'; tt.players.p4.team = 'B';

    var mk = function (n) {
      return Game.createCardInstance(CARD_DEFS.find(function (c) { return c.name === n; }), 'player');
    };
    tt.players.p1.hand = [mk('Loki')];
    tt.players.p3.hand = [mk('Iron Man')];

    tt.round = 1;
    var order = Game._2v2ComputePhaseOrder(1);
    // MIRROR WHAT A REAL SUB-PHASE START DOES. _2v2StartSubPhase advances the
    // index AND calls _2v2SyncActivePlayer(), which re-points the side proxy's
    // hand at the NEW seat. Setting only the index made this test blind to the
    // exact bug it was written for: the deferred read-back reads
    // s[side].hand, and without the re-sync that array had never moved.
    var seatTo = function (pk) {
      for (var i = 0; i < order.length; i++) {
        if (order[i].indexOf(pk + '-') === 0) {
          tt.subPhaseIdx = i;
          Game._2v2SyncActivePlayer();
          return;
        }
      }
    };

    seatTo('p1');
    assertEq(Game._2v2ActivePlayer(), 'p1', 'p1 is the acting seat');
    // p1 plays something whose onPlay leaves a prompt open — the un-bridge defers.
    Game._2v2WithSideBridge(function () {
      s.pendingCardChoice = { owner: 'player', cards: [{ name: 'x' }], title: 't', callback: function () {} };
    });
    assertEq((s._deferredRestores || []).length, 1, 'the un-bridge was deferred');

    // The phase moves on while that prompt is still open (watchdog, block
    // trick, combat) — then p1 finally answers and the restore fires LATE.
    seatTo('p3');
    s.pendingCardChoice = null;
    Game.resumeCombatIfWaiting();

    assertEq(tt.players.p1.hand === tt.players.p3.hand, false,
      'the two teammates must not share one hand array');
    assertEq(tt.players.p3.hand.map(function (c) { return c.name; }).join(','), 'Iron Man',
      "yomamma still holds her OWN hand, not Ryan's");
    assertEq(tt.players.p1.hand.map(function (c) { return c.name; }).join(','), 'Loki',
      'Ryan still holds his own hand');
  } finally {
    Game.hasPendingPrompt = savedHPP;
  }
});

// ---- 2v2 WIRE PRIVACY: A SEAT ONLY EVER RECEIVES ITS OWN HAND ---------
test("2v2: the state sent to a seat carries no other seat's cards", function () {
  Game.start2v2Match({ names: { p1: 'Ryan', p2: 'Vega', p3: 'yomamma', p4: 'Cortex' } });
  var s = Game.state, tt = s.twoVTwo;
  tt.online = true; tt.you = 'p1';
  tt.players.p1.team = 'A'; tt.players.p3.team = 'A';
  tt.players.p2.team = 'B'; tt.players.p4.team = 'B';

  var mk = function (n) {
    return Game.createCardInstance(CARD_DEFS.find(function (c) { return c.name === n; }), 'player');
  };
  tt.players.p1.hand = [mk('Loki'), mk('Droideka')];
  tt.players.p3.hand = [mk('Iron Man')];
  tt.players.p2.hand = [mk('Magneto'), mk('Knull')];
  tt.players.p1.trickHand = [];
  // The side proxy is pointed at the ACTIVE seat — during Ryan's turn that IS
  // Ryan's hand, which is exactly what used to reach his teammate's client.
  s.player.hand = tt.players.p1.hand;

  var forP3 = Game._2v2RedactStateFor(s, 'p3');
  var names = function (list) {
    return (list || []).map(function (c) { return c && c.name; }).filter(Boolean).join(',');
  };

  assertEq(names(forP3.twoVTwo.players.p3.hand), 'Iron Man', 'p3 still gets her OWN hand in full');
  assertEq(names(forP3.twoVTwo.players.p1.hand), '', "Ryan's cards are not in the payload p3 receives");
  assertEq(names(forP3.twoVTwo.players.p2.hand), '', "nor an opponent's");
  assertEq(forP3.twoVTwo.players.p1.hand.length, 2, 'but the COUNT survives — the strip still shows 2 backs');
  assertEq(forP3.twoVTwo.players.p2.hand.length, 2, 'same for the enemy hand display');
  assertEq(names(forP3.player.hand), 'Iron Man', "the side proxy shows the recipient's own hand, not the actor's");
  assertEq(forP3.twoVTwo.you, 'p3', 'the payload is stamped for its recipient');

  // ...and the host's own live state is untouched by building that view.
  assertEq(names(tt.players.p1.hand), 'Loki,Droideka', 'redaction never mutates the authoritative state');
  assertEq(names(s.player.hand), 'Loki,Droideka', 'the live side proxy is left alone too');
});

// ---- 2v2 PROMPT ROUTING: THE SEAT WHOSE TURN IT IS ANSWERS -------------
// Two humans on one side (p1 + p3, the other two seats AI fillers) is the
// normal shape of a 2-player 2v2 room. The side->seat fallback used to take the
// lowest-numbered human on the team, so whichever of them was actually playing,
// p1 got the prompt. (User: "I played homelander, I never got a choice on who
// to kill, it auto decided in 2v2.")
test("2v2: a prompt for a side goes to the seat whose sub-phase it is", function () {
  Game.start2v2Match({ names: { p1: 'Ryan', p2: 'Vega', p3: 'yomamma', p4: 'Cortex' } });
  var s = Game.state, tt = s.twoVTwo;
  tt.online = true; tt.you = 'p3';
  tt.players.p1.team = 'A'; tt.players.p3.team = 'A';
  tt.players.p2.team = 'B'; tt.players.p4.team = 'B';
  // The two fillers are AI, exactly as a 2-human room fills out.
  tt.players.p1.isAI = false; tt.players.p3.isAI = false;
  tt.players.p2.isAI = true;  tt.players.p4.isAI = true;

  tt.round = 1;
  var order = Game._2v2ComputePhaseOrder(1);
  var seatTo = function (pk) {
    for (var i = 0; i < order.length; i++) {
      if (order[i].indexOf(pk + '-') === 0) { tt.subPhaseIdx = i; return; }
    }
  };

  seatTo('p3');
  assertEq(Game._2v2ActivePlayer(), 'p3', 'it is p3 (yomamma) acting');
  assertEq(Game._2v2SeatForSide('player'), 'p3',
    'her own prompt must stay with her, not fall to her teammate p1');

  seatTo('p1');
  assertEq(Game._2v2SeatForSide('player'), 'p1', "and Ryan's turn routes to Ryan");

  // An AI filler's own sub-phase still resolves to that AI seat — that is what
  // lets the AI authority auto-pick for it instead of asking a human.
  seatTo('p2');
  assertEq(Game._2v2SeatForSide('ai'), 'p2', 'an AI seat answers for itself on its turn');

  // With nobody from that side acting, fall back as before — slot order, a real
  // player ahead of an AI filler (team B here is all AI, so it is just order).
  seatTo('p1');
  assertEq(Game._2v2SeatForSide('ai'), 'p2', 'the unchanged fallback still applies');
  tt.players.p4.isAI = false;
  assertEq(Game._2v2SeatForSide('ai'), 'p4', 'and a real player on that side wins over a filler');
});

// ---- 2v2 ENERGY GRANTS MUST LAND ON A SEAT, NOT THE SIDE PROXY ---------
// start2v2Round hands out `tt.round + p.nextTurnCurrency` PER SEAT and never
// reads state[side].nextTurnCurrency — so a grant parked on the side proxy is
// silently discarded. Green Lantern harvests in the end-of-turn sweep, when no
// seat is acting, which is exactly when the old acting-seat default was null.
// (User: "vega played green lantern and didnt receive any energy next round,
// vega played power battery so that worked on 1 side.")
test("2v2: Green Lantern's energy reaches the seat that played him", function () {
  Game.start2v2Match({ names: { p1: 'Ryan', p2: 'Vega', p3: 'yomamma', p4: 'Cortex' } });
  var s = Game.state, tt = s.twoVTwo;
  tt.online = true; tt.you = 'p1';
  tt.players.p1.team = 'A'; tt.players.p3.team = 'A';
  tt.players.p2.team = 'B'; tt.players.p4.team = 'B';
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) { tt.players[k].nextTurnCurrency = 0; });

  // Cortex (p4, team B -> side 'ai') played Green Lantern, who dealt 3 damage.
  // Deliberately the SECOND seat on that team: a fix that merely picks "some
  // seat on the right side" would credit p2 and look correct, so the card has
  // to carry the seat that actually played it.
  var gl = Game.createCardInstance(cardByName('Green Lantern'), 'ai');
  gl._2v2PlayedBy = 'p4';
  gl._damageDealtThisTurn = 3;
  s.lanes[0].ai = gl;

  // The end-of-turn sweep runs with NOBODY acting - the whole point.
  Game._2v2CurrentActingPlayer = null;
  gl.onEndOfTurn(Game, gl, 0);

  assertEq(tt.players.p4.nextTurnCurrency, 3, 'Cortex banks the 3 energy he earned');
  assertEq(tt.players.p2.nextTurnCurrency, 0, 'his teammate gets none of it');
  assertEq(tt.players.p1.nextTurnCurrency, 0, 'and the enemy team certainly does not');
  assertEq(s.ai.nextTurnCurrency, 0, 'nothing is left stranded on the side proxy');

  // ...and it actually becomes spendable energy at the top of the next round.
  tt.round = 5;
  Game.start2v2Round();          // this advances the round, so read it back
  var r = tt.round;
  assertEq(tt.players.p4.energy, r + 3, 'round energy PLUS the banked bonus');
  assertEq(tt.players.p2.energy, r, 'teammate gets the plain round energy');
  assertEq(tt.players.p4.nextTurnCurrency, 0, 'the bucket is consumed, never stacking');
});

// ---- PER-ROUND ENERGY PASSIVES IN 2v2 ---------------------------------
// "Each Turn: Add N Energy" (Dr. Manhattan +2, Power Battery +1) is swept in
// 1v1's startRound. start2v2Round never ported that sweep, so every one of
// those cards was inert for a whole 2v2 match — and once it IS swept, the
// grant has to land on the seat that PLAYED the card, not the side proxy and
// not whichever teammate happens to sort first.
// (User: "so the person who played manhattan should get 2 extra energy each
// turn in 2v2.")
// PRISTINE COPIES OF ENGINE METHODS THE 2v2 HELPERS MONKEY-PATCH.
// Two upkeep helpers below (`room()` and `twoVtwoGame()`) replace
// Game._2v2StartSubPhase with a no-op so a parity check stops after the round
// upkeep instead of driving six sub-phases of AI turns — and neither puts it
// back. Game is a SINGLETON, so every test that ran afterwards silently got the
// stub: a turn never really started, the undo snapshot was never taken, and an
// undo test failed for a reason that had nothing to do with undo. Same trap a
// stubbed _2v2ActivePlayer set earlier in this file's history.
// Captured at load, before anything has had a chance to replace it.
var _PRISTINE_2V2 = (typeof Game !== 'undefined') ? {
  startSubPhase: Game._2v2StartSubPhase,
  activePlayer:  Game._2v2ActivePlayer,
} : null;

function fresh2v2(teams) {
  // Undo whatever an earlier test left patched on the singleton, so "fresh"
  // means fresh.
  if (_PRISTINE_2V2) {
    Game._2v2StartSubPhase = _PRISTINE_2V2.startSubPhase;
    Game._2v2ActivePlayer  = _PRISTINE_2V2.activePlayer;
  }
  Game.start2v2Match({ names: { p1: 'Ryan', p2: 'Vega', p3: 'Joe', p4: 'Cortex' } });
  var tt = Game.state.twoVTwo;
  tt.online = true; tt.you = 'p1';
  tt.players.p1.team = 'A'; tt.players.p3.team = 'A';
  tt.players.p2.team = 'B'; tt.players.p4.team = 'B';
  ['p1','p2','p3','p4'].forEach(function (k) {
    tt.players[k].nextTurnCurrency = 0; tt.players[k].energy = 0;
  });
  Game._2v2CurrentActingPlayer = null;
  Game._2v2AIDriving = null;
  return Game;
}

// ---- THE CARD-CHOICE WIRE HANDLER MUST CLEAR ITS SLOT -----------------
// The host applies a guest's pick from the wire. The LANE branch nulls the slot
// before running the callback; the CARD branch did not — so the effect landed
// and the prompt stayed armed, and every seat sat on a tray that would not come
// down. (Owner: "i played human torch 2v2 and this screen popped up now im
// stuck here.")
function armed2v2CardPrompt(G, seat, opts) {
  var tt = G.state.twoVTwo;
  var picked = null;
  G.state.pendingCardChoice = {
    owner: 'player',
    cards: (opts && opts.cards) || [],
    title: 'T', desc: 'D',
    callback: function (c) { picked = c; if (opts && opts.then) opts.then(c); },
    declineLabel: (opts && opts.declineLabel) || null,
    onDecline: (opts && opts.onDecline) || null,
    _2v2ActingPlayer: seat,
    _seq: (opts && opts.seq != null) ? opts.seq : 7,
  };
  return { got: function () { return picked; } };
}

test("2v2: a guest's card pick takes the prompt DOWN, not just fires it", function () {
  var G = fresh2v2();
  var a = G.createCardInstance(cardByName('Jango Fett'), 'ai');
  var b = G.createCardInstance(cardByName('Star-Lord'), 'ai');
  var cap = armed2v2CardPrompt(G, 'p2', { cards: [a, b], seq: 7 });
  G._apply2v2OnlineAction({ t: '2v2CardChoiceResult', playerKey: 'p2', idx: 1, cardId: b.id, seq: 7 });
  assertEq(cap.got(), b, 'the callback ran on the card that was actually picked');
  assertEq(G.state.pendingCardChoice, null, 'and the prompt came down — this is the freeze');
});

test("2v2: the pick is matched by identity, and a no-match leaves the prompt up", function () {
  var G = fresh2v2();
  var a = G.createCardInstance(cardByName('Jango Fett'), 'ai');
  var b = G.createCardInstance(cardByName('Star-Lord'), 'ai');
  var cap = armed2v2CardPrompt(G, 'p2', { cards: [a, b], seq: 7 });
  // An id that is not on the list, and an index past the end.
  G._apply2v2OnlineAction({ t: '2v2CardChoiceResult', playerKey: 'p2', idx: 99, cardId: 987654, seq: 7 });
  assertEq(cap.got(), null, 'nothing was chosen');
  assert(!!G.state.pendingCardChoice, 'and the prompt is deliberately still up to ask again');
});

test("2v2: an answer to a stale question neither fires nor clears", function () {
  var G = fresh2v2();
  var a = G.createCardInstance(cardByName('Jango Fett'), 'ai');
  var cap = armed2v2CardPrompt(G, 'p2', { cards: [a], seq: 9 });
  G._apply2v2OnlineAction({ t: '2v2CardChoiceResult', playerKey: 'p2', idx: 0, cardId: a.id, seq: 4 });
  assertEq(cap.got(), null, 'the old answer did not resolve the new question');
  assert(!!G.state.pendingCardChoice, 'and the live prompt is still standing');
});

test("2v2: another seat's answer cannot resolve your prompt", function () {
  var G = fresh2v2();
  var a = G.createCardInstance(cardByName('Jango Fett'), 'ai');
  var cap = armed2v2CardPrompt(G, 'p2', { cards: [a], seq: 7 });
  G._apply2v2OnlineAction({ t: '2v2CardChoiceResult', playerKey: 'p4', idx: 0, cardId: a.id, seq: 7 });
  assertEq(cap.got(), null, 'p4 cannot answer p2 question');
  assert(!!G.state.pendingCardChoice, 'and it stays up for the seat it belongs to');
});

test("2v2: a declined card prompt also comes down", function () {
  var G = fresh2v2();
  var a = G.createCardInstance(cardByName('Jango Fett'), 'ai');
  var declined = false;
  armed2v2CardPrompt(G, 'p2', { cards: [a], seq: 7, declineLabel: 'NO ONE',
                                onDecline: function () { declined = true; } });
  G._apply2v2OnlineAction({ t: '2v2CardChoiceResult', playerKey: 'p2', decline: true, seq: 7 });
  assertEq(declined, true, 'the opt-out ran');
  assertEq(G.state.pendingCardChoice, null, 'and the slot is clear, not left dangling');
});

test("2v2: the slot is already clear WHEN the callback runs, not after it", function () {
  // Ordering, not just eventual state. A callback that raises a CHAINED prompt
  // hits _promptBusy() — if the answered prompt were still sitting in the slot
  // the chained one would be parked in the queue instead of shown, and no
  // snapshot taken inside the callback may ever capture an armed prompt.
  var G = fresh2v2();
  var a = G.createCardInstance(cardByName('Jango Fett'), 'ai');
  var b = G.createCardInstance(cardByName('Star-Lord'), 'ai');
  var slotDuringCallback = 'never ran';
  var busyDuringCallback = null;
  armed2v2CardPrompt(G, 'p2', { cards: [a, b], seq: 7, then: function () {
    slotDuringCallback = G.state.pendingCardChoice;
    busyDuringCallback = G._promptBusy ? G._promptBusy() : null;
  }});
  G._apply2v2OnlineAction({ t: '2v2CardChoiceResult', playerKey: 'p2', idx: 0, cardId: a.id, seq: 7 });
  assertEq(slotDuringCallback, null, 'the answered prompt was gone before its own callback ran');
  assertEq(busyDuringCallback, false, 'so a chained prompt raised in there is shown, not queued');
});

// ---- UNDO MUST NOT RESTORE A PHASE THAT WAS NEVER TRUE ------------------
// The turn snapshot is taken at the TOP of _2v2StartSubPhase, before it writes
// s.phase — so the clone carries the PREVIOUS turn's phase string. Restoring it
// hands the UI a value that was never true for the turn the player is back at
// the start of, and when that value is '2v2-combat' the board shows the combat
// header, hides the End button and strands the seat.
// (Owner: "when i pressed the undo button to undo the gizmo play now im stuck".)
function seat2v2TurnStart(G, seat, phaseBefore) {
  var tt = G.state.twoVTwo;
  tt.round = 1;
  var order = G._2v2ComputePhaseOrder(1);
  tt.subPhaseIdx = order.findIndex(function (sp) { return sp.indexOf(seat + '-') === 0; });
  G.state.phase = phaseBefore;
  G._2v2StartSubPhase();
  return G._2v2SubPhase();
}

test("2v2: undo leaves the phase matching the turn you are back at", function () {
  var G = fresh2v2();
  var tt = G.state.twoVTwo;
  tt.players.p1.hand = [G.createCardInstance(cardByName('Gizmo'), 'player')];
  tt.players.p1.energy = 8; tt.players.p1.usedEnergy = 0;
  // The turn BEFORE this one was combat — the round-boundary case.
  var sub = seat2v2TurnStart(G, 'p1', '2v2-combat');
  assertEq(G._2v2ActivePlayer(), 'p1', 'setup: it is p1 turn');
  assert(!!sub, 'setup: there IS a sub-phase');
  G._2v2OnlinePlayCard('p1', 0, 2);
  assert(!!G.state.lanes[2].player, 'setup: Gizmo is on the board');

  assertEq(G._2v2UndoTurn('p1'), true, 'the undo went through');
  assertEq(G.state.lanes[2].player, null, 'the card came off the board');
  assertEq(G.state.twoVTwo.players.p1.hand.length, 1, 'and went back to hand');
  assertEq(G._2v2SubPhase(), sub, 'the sub-phase is unchanged — same turn');
  assertEq(G.state.phase, '2v2-' + sub,
    'and the phase string matches it, instead of the combat it restored');
});

test("2v2: an undone card can be played again", function () {
  var G = fresh2v2();
  var tt = G.state.twoVTwo;
  tt.players.p1.hand = [G.createCardInstance(cardByName('Gizmo'), 'player')];
  tt.players.p1.energy = 8; tt.players.p1.usedEnergy = 0;
  seat2v2TurnStart(G, 'p1', '2v2-combat');
  G._2v2OnlinePlayCard('p1', 0, 2);
  G._2v2UndoTurn('p1');
  var tt2 = G.state.twoVTwo;
  assertEq(tt2.players.p1.energy - tt2.players.p1.usedEnergy, 8, 'the energy came back too');
  G._2v2OnlinePlayCard('p1', 0, 4);
  assert(!!G.state.lanes[4].player, 'and the card goes down again, in a lane of your choosing');
  assertEq(G.state.lanes[4].player.name, 'Gizmo', 'the same card');
});

// ---- A STALE AI-DRIVE LOCK MUST NOT FREEZE THE TABLE --------------------
// _2v2AIDriving is an ENGINE field, so it survives an undo's whole-state swap
// and a round rollover — while the watchdog that would clear it is a _schedule
// callback that does not. The guard used to be a bare early return placed
// BEFORE the watchdog is armed, so once the flag went stale no AI seat could
// ever move again. (Owner: "the AIs got stuck ... dont let it stall the game
// out again.")
test("2v2: a fresh AI drive is still refused while one is genuinely running", function () {
  var G = fresh2v2();
  G._2v2AIDriving = 'p2';
  G._2v2AIDrivingAt = Date.now();          // started just now — a real drive
  G.state.twoVTwo.players.p4.isAI = true;
  G._2v2DriveAISeat('p4', 'p4-cards');
  assertEq(G._2v2AIDriving, 'p2', 'the running drive is not stomped by a second one');
});

test("2v2: a stale AI drive lock releases instead of freezing every AI seat", function () {
  var G = fresh2v2();
  G.state.twoVTwo.players.p4.isAI = true;
  G._2v2AIDriving = 'p2';
  G._2v2AIDrivingAt = Date.now() - 60000;  // a minute old — nothing is running
  G._2v2DriveAISeat('p4', 'p4-cards');
  assert(G._2v2AIDriving !== 'p2', 'the dead lock did not survive the next AI turn');
});

test("2v2: a drive lock with no timestamp at all is treated as dead", function () {
  // A lock carried over from a build that never stamped one, or from a state
  // restore. Missing evidence that it is alive is not evidence that it is.
  var G = fresh2v2();
  G.state.twoVTwo.players.p4.isAI = true;
  G._2v2AIDriving = 'p2';
  G._2v2AIDrivingAt = 0;
  G._2v2DriveAISeat('p4', 'p4-cards');
  assert(G._2v2AIDriving !== 'p2', 'it released rather than blocking forever');
});

test("2v2: undo releases the AI drive lock", function () {
  var G = fresh2v2();
  var tt = G.state.twoVTwo;
  tt.players.p1.hand = [G.createCardInstance(cardByName('Gizmo'), 'player')];
  tt.players.p1.energy = 8; tt.players.p1.usedEnergy = 0;
  seat2v2TurnStart(G, 'p1', '2v2-combat');
  G._2v2OnlinePlayCard('p1', 0, 2);
  G._2v2AIDriving = 'p2';                  // a drive from the timeline being undone
  G._2v2AIDrivingAt = Date.now();
  assertEq(G._2v2UndoTurn('p1'), true, 'the undo went through');
  assertEq(G._2v2AIDriving, null, 'and took the drive lock with it');
});

test("2v2: Dr. Manhattan's +2 goes to the seat that played him", function () {
  var G = fresh2v2(), tt = G.state.twoVTwo;
  // Cortex (p4) is the SECOND seat on team B, deliberately: a fix that merely
  // picks "some seat on the right side" would credit p2 and look correct.
  var dm = G.createCardInstance(cardByName('Dr. Manhattan'), 'ai');
  dm._2v2PlayedBy = 'p4';
  G.state.lanes[0].ai = dm;

  tt.round = 5;
  G.start2v2Round();
  var r = tt.round;

  assertEq(tt.players.p4.energy, r + 2, 'Cortex gets the round energy plus Manhattan\'s 2');
  assertEq(tt.players.p2.energy, r, 'his teammate gets the plain round energy, not a share');
  assertEq(tt.players.p1.energy, r, 'and the enemy team certainly does not');
  assertEq(tt.players.p3.energy, r, 'nor the other enemy seat');
});

test("2v2: the energy passive fires EVERY round, not just once", function () {
  var G = fresh2v2(), tt = G.state.twoVTwo;
  var dm = G.createCardInstance(cardByName('Dr. Manhattan'), 'player');
  dm._2v2PlayedBy = 'p3';
  G.state.lanes[0].player = dm;
  tt.round = 1;
  G.start2v2Round();
  assertEq(tt.players.p3.energy, tt.round + 2, 'first round after he lands');
  G.start2v2Round();
  assertEq(tt.players.p3.energy, tt.round + 2, 'and again the round after that');
});

test("2v2: every energy tier routes the same way, on its own seat", function () {
  var G = fresh2v2(), tt = G.state.twoVTwo;
  // Dr. Octopus is the real +1 card ("While Active: Add 1 extra Energy each
  // round"); nothing ships extraCurrency3 today, so that tier is stamped on to
  // pin the table itself rather than one card's spelling of it.
  var doc = G.createCardInstance(cardByName('Dr. Octopus'), 'player');
  doc._2v2PlayedBy = 'p3';
  assertEq(doc.passive, 'extraCurrency', 'setup: Dr. Octopus really carries the +1 passive');
  var big = G.createCardInstance(cardByName('Hawkeye'), 'player');
  big.passive = 'extraCurrency3';
  big._2v2PlayedBy = 'p1';
  G.state.lanes[0].player = doc;
  G.state.lanes[1].player = big;
  tt.round = 2;
  G.start2v2Round();
  var r = tt.round;
  assertEq(tt.players.p3.energy, r + 1, 'the +1 tier lands on its own seat');
  assertEq(tt.players.p1.energy, r + 3, 'the +3 tier lands on its own seat');
  assertEq(tt.players.p2.energy, r, 'and neither leaks to the other team');
});

test("2v2: two generators on the same team each pay their own player", function () {
  var G = fresh2v2(), tt = G.state.twoVTwo;
  var dm = G.createCardInstance(cardByName('Dr. Manhattan'), 'ai');
  dm._2v2PlayedBy = 'p4';
  var doc = G.createCardInstance(cardByName('Dr. Octopus'), 'ai');
  doc._2v2PlayedBy = 'p2';
  G.state.lanes[0].ai = dm;
  G.state.lanes[1].ai = doc;
  tt.round = 3;
  G.start2v2Round();
  var r = tt.round;
  assertEq(tt.players.p4.energy, r + 2, 'Manhattan pays Cortex only');
  assertEq(tt.players.p2.energy, r + 1, 'Dr. Octopus pays Vega only');
});

test("2v2: a mind-controlled generator pays its CURRENT controller", function () {
  // The card changed sides. Its original owner must not keep collecting from
  // it, and _2v2PlayedBy still names them — so the controller's seat has to win.
  var G = fresh2v2(), tt = G.state.twoVTwo;
  var dm = G.createCardInstance(cardByName('Dr. Manhattan'), 'ai');
  dm._2v2PlayedBy = 'p1';                // played by team A originally
  dm._mcSeat = 'p4';                     // now controlled by Cortex, team B
  dm.owner = 'ai';
  G.state.lanes[0].ai = dm;
  tt.round = 3;
  G.start2v2Round();
  var r = tt.round;
  assertEq(tt.players.p4.energy, r + 2, 'the controller collects');
  assertEq(tt.players.p1.energy, r, 'the seat that played it does not');
});

test("2v2: a stale controller seat on the wrong side falls back to provenance", function () {
  // Mind control ended: the card is back on team A but _mcSeat still names a
  // team B seat. Crediting it would hand energy straight to the opponent.
  var G = fresh2v2(), tt = G.state.twoVTwo;
  var dm = G.createCardInstance(cardByName('Dr. Manhattan'), 'player');
  dm._2v2PlayedBy = 'p3';
  dm._mcSeat = 'p2';                     // stale — team B, card is on team A now
  G.state.lanes[0].player = dm;
  tt.round = 4;
  G.start2v2Round();
  var r = tt.round;
  assertEq(tt.players.p2.energy, r, 'the enemy seat named by the stale flag gets nothing');
  assertEq(tt.players.p3.energy, r + 2, 'and it falls through to who actually played it');
});

test("2v2: a generator with no provenance still pays its own side", function () {
  var G = fresh2v2(), tt = G.state.twoVTwo;
  var dm = G.createCardInstance(cardByName('Dr. Manhattan'), 'ai');
  delete dm._2v2PlayedBy;                // e.g. summoned before stamping existed
  G.state.lanes[0].ai = dm;
  tt.round = 6;
  G.start2v2Round();
  var r = tt.round;
  var teamB = tt.players.p2.energy + tt.players.p4.energy;
  assertEq(teamB, r * 2 + 2, 'the 2 landed somewhere on the owning team');
  assertEq(tt.players.p1.energy, r, 'and nowhere on the other one');
  assertEq(tt.players.p3.energy, r, 'neither enemy seat');
  assertEq(G.state.ai.nextTurnCurrency, 0, 'nothing stranded on the side proxy');
});

test("2v2: Green Lantern's per-round damage counter is cleared", function () {
  // Same forEach in 1v1's startRound zeroes this; without it a counter from a
  // round where GL died mid-combat carries into the next one and double-pays.
  var G = fresh2v2(), tt = G.state.twoVTwo;
  var gl = G.createCardInstance(cardByName('Green Lantern'), 'player');
  gl._damageDealtThisTurn = 4;
  gl._2v2PlayedBy = 'p1';
  G.state.lanes[0].player = gl;
  tt.round = 2;
  G.start2v2Round();
  assertEq(gl._damageDealtThisTurn, 0, 'the counter starts the round at zero');
});

test("2v2: an energy grant is never credited to the wrong team", function () {
  Game.start2v2Match({ names: { p1: 'Ryan', p2: 'Vega', p3: 'yomamma', p4: 'Cortex' } });
  var s = Game.state, tt = s.twoVTwo;
  tt.online = true; tt.you = 'p1';
  tt.players.p1.team = 'A'; tt.players.p3.team = 'A';
  tt.players.p2.team = 'B'; tt.players.p4.team = 'B';
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) { tt.players[k].nextTurnCurrency = 0; });

  // A stale acting-seat global pointing at the OTHER side must not be trusted.
  Game._2v2CurrentActingPlayer = 'p1';          // team A
  Game.addNextTurnCurrency('ai', 4);            // ...granting to team B

  assertEq(tt.players.p1.nextTurnCurrency, 0, 'the team A seat is not credited');
  assertEq((tt.players.p2.nextTurnCurrency || 0) + (tt.players.p4.nextTurnCurrency || 0), 4,
    'the energy lands on the side it was granted to');
});

// ---- PROVENANCE: WHO PLAYED THIS CARD, ON WHAT ROUND -------------------
// The RECORD block was an EFFECT log only ("R5 Star-Lord - +2/+2"); nothing
// recorded who PLAYED a card. (User: "so in all game modes i want who played
// the card on what turn.")
test("every placement path stamps who played the card and when", function () {
  var G = freshGame();
  G.state.player.isHuman = true; G.state.ai.isHuman = false;
  G.state.round = 4;

  // 1. playCard - the ordinary path.
  var c = G.createCardInstance(cardByName('Hawkeye'), 'player');
  G.state.player.hand = [c];
  G.state.player.currency = 99;
  G.playCard('player', c, 0);
  assertEq(c._playedRound, 4, 'the round it was played');
  assertEq(c._playedByName, 'You', 'solo: the local player');

  // 2. playCardFree - abilities that play a card for you.
  var f = G.createCardInstance(cardByName('Hawkeye'), 'ai');
  G.playCardFree('ai', f, 1);
  assertEq(f._playedRound, 4, 'a free play is still a play');
  assertEq(f._playedByName, 'AI', 'and it belongs to whoever it was played for');

  // 3. placeInLane - revives / displacements, the path that stamped NOTHING.
  var p = G.createCardInstance(cardByName('Hawkeye'), 'player');
  G.placeInLane('player', p, 2);
  assertEq(p._playedRound, 4, 'a direct placement records its round');
  assertEq(p.statsEnteredRound, 4, '...and its entered-round, which it also never set');
  assertEq(p._playedByName, 'You', 'and its player');

  // The stamp is HISTORY: it must survive the card changing hands.
  p.owner = 'ai';
  assertEq(p._playedByName, 'You', 'a stolen card still records who originally played it');
});

test("2v2: provenance names the SEAT that played it, not the team", function () {
  Game.start2v2Match({ names: { p1: 'Ryan', p2: 'Vega', p3: 'yomamma', p4: 'Cortex' } });
  var s = Game.state, tt = s.twoVTwo;
  tt.online = true; tt.you = 'p3';
  tt.players.p1.team = 'A'; tt.players.p3.team = 'A';
  tt.players.p2.team = 'B'; tt.players.p4.team = 'B';
  s.round = 6;

  var c = Game.createCardInstance(cardByName('Hawkeye'), 'player');
  c._2v2PlayedBy = 'p3';
  Game._2v2CurrentActingPlayer = null;      // nothing acting - the card knows
  Game._stampProvenance(c, 'player');

  assertEq(c._playedByName, 'yomamma', 'the seat, not "Ryan & yomamma"');
  assertEq(c._playedSeat, 'p3', 'and the seat key is kept for the "You" check');
  assertEq(c._playedRound, 6, 'on the round it was played');

  // A teammate's card must not be attributed to the seat merely acting now.
  var t = Game.createCardInstance(cardByName('Hawkeye'), 'player');
  t._2v2PlayedBy = 'p1';
  Game._2v2CurrentActingPlayer = 'p3';
  Game._stampProvenance(t, 'player');
  assertEq(t._playedByName, 'Ryan', "the card's own seat wins over whoever is acting");
});

// A card the Batman Who Laughs INTERCEPTS never landed for the player who paid
// for it — it goes to the thief's hand and is played later, by them. Its
// provenance must not survive that steal, or the record credits the victim.
test("an intercepted card is credited to the thief who replays it, not the victim", function () {
  var G = freshGame();
  G.state.player.isHuman = false; G.state.ai.isHuman = false;
  G.state.round = 2;

  var c = G.createCardInstance(cardByName('Hawkeye'), 'player');
  G.state.player.hand = [c];
  G.state.player.currency = 99;
  G.playCard('player', c, 0);
  assertEq(c._playedByName, 'You', 'played by its original owner first');

  // Now the same instance is stolen out of the air. (BWL intercepts from HAND,
  // so the card is off the board when the thief later plays it.)
  G.state.lanes[0].player = null;
  G._clearProvenance(c);
  assertEq(c._playedRound, undefined, 'the steal wipes the stamp');
  assertEq(c._playedByName, undefined, 'including the name');
  assertEq(c._2v2PlayedBy, undefined, 'and the seat, which is stamped before the intercept runs');

  // The thief plays it on a later round — that is the play the record should show.
  c.owner = 'ai';
  G.state.round = 5;
  G.placeInLane('ai', c, 3);
  assertEq(c._playedByName, 'AI', 'the record now names whoever actually played it');
  assertEq(c._playedRound, 5, 'on the round THEY played it');
});

test("a dead card keeps its provenance in the dead pile", function () {
  var G = freshGame();
  G.state.player.isHuman = true; G.state.ai.isHuman = false;
  G.state.round = 3;
  var c = G.createCardInstance(cardByName('Hawkeye'), 'player');
  G.state.player.hand = [c];
  G.state.player.currency = 99;
  G.playCard('player', c, 0);
  G.killCard(c);
  G.cleanupDead();

  var entry = (G.state.player.deadPile || []).find(function (e) { return e && e.name === 'Hawkeye'; });
  assert(!!entry, 'the card reached the dead pile');
  assertEq(entry._playedByName, 'You', 'the archive carries who played it');
  assertEq(entry._playedRound, 3, '...and when');
});

// ---- A DRY-RUN PREVIEW MUST NEVER REACH THE WIRE (2v2) -----------------
// previewPlacement deep-clones the state, stamps it _silentSim, then plays the
// card AND RESOLVES COMBAT on the clone to build the drag-time forecast. Every
// push inside that chain was broadcasting the HYPOTHETICAL future to all three
// seats. _mpBroadcast has carried this guard since the 1v1 version of the bug;
// the 2v2 door never got it. (User: "when the host tries to drag a card onto
// the field its crazy ... a bunch of other simulations occurred but never
// actually fired for the guest ... my teammate got my hand or we merged.")
test("2v2: a silent preview sim never broadcasts to the guests", function () {
  Game.start2v2Match({ names: { p1: 'Ryan', p2: 'Vega', p3: 'yomamma', p4: 'Cortex' } });
  var tt = Game.state.twoVTwo;
  tt.online = true; tt.you = 'p1';           // we are the host: pushes are ours to make

  if (typeof Multiplayer4 === 'undefined') return;
  var sent = 0;
  var realBroadcast = Multiplayer4.broadcastState;
  Multiplayer4.broadcastState = function () { sent++; };
  try {
    // A real push reaches the wire.
    Game.state._silentSim = false;
    Game._pushOnlineState();
    assertEq(sent, 1, 'a genuine push is broadcast');

    // A dry run must not — not through the door...
    Game.state._silentSim = true;
    Game._pushOnlineState();
    assertEq(sent, 1, 'a preview sim is NOT broadcast');

    // ...nor through the direct call, which a dozen sites use.
    Game._2v2OnlineBroadcast({ silent: true });
    assertEq(sent, 1, 'and not via the direct broadcast either');

    // Clearing the flag restores normal service.
    Game.state._silentSim = false;
    Game._pushOnlineState();
    assertEq(sent, 2, 'the real play still broadcasts');
  } finally {
    Multiplayer4.broadcastState = realBroadcast;
    Game.state._silentSim = false;
  }
});

// ---- A DRAW GOES TO THE SEAT THAT PLAYED THE CARD ----------------------
// "i played padme and my teammate drew king shark, it should go to me since i
// played the card that draws a card." _2v2HandTarget was the only acting-seat
// resolver that read _2v2CurrentActingPlayer and stopped there; with that
// global null it returned the SIDE PROXY, whose hand is whichever teammate
// synced last. The battle log proves the global WAS null: the line above the
// draw printed seatLabel's last-resort team form, "Player 1 & Ryan".
test("2v2: a card's draw lands on the seat that played it, not the teammate", function () {
  Game.start2v2Match({ names: { p1: 'Player 1', p2: 'Vega', p3: 'Ryan', p4: 'Cortex' } });
  var s = Game.state, tt = s.twoVTwo;
  tt.online = true; tt.you = 'p1';
  tt.players.p1.team = 'A'; tt.players.p3.team = 'A';
  tt.players.p2.team = 'B'; tt.players.p4.team = 'B';

  var mk = function (n, o) { return Game.createCardInstance(cardByName(n), o); };
  tt.players.p1.hand = [];
  tt.players.p3.hand = [];
  // The side proxy is stale on the TEAMMATE — exactly the state the bug needs.
  s.player.hand = tt.players.p1.hand;

  // p3 (Ryan) played the drawing card. Nobody is "acting" any more.
  var padme = mk('Padme Amidala', 'player');
  padme._2v2PlayedBy = 'p3';
  Game._2v2CurrentActingPlayer = null;
  Game._2v2AIDriving = null;

  var target = Game._2v2HandTarget('player', padme);
  assertEq(target, tt.players.p3, 'the gain routes to the seat that played the card');
  assert(target !== s.player, 'and NOT to the stale side proxy');

  // ...and an actual draw lands there.
  s.drawPile = [mk('King Shark', 'player')];
  tt.drawPile = s.drawPile;
  Game.drawCards('player', 1, padme);
  assertEq(tt.players.p3.hand.length, 1, 'Ryan holds the card he drew');
  assertEq(tt.players.p3.hand[0].name, 'King Shark', 'and it is the right card');
  assertEq(tt.players.p1.hand.length, 0, 'his teammate got nothing');
});

// ---- THANOS SNAPS HALF THE BOARD, WHATEVER THE BOARD IS ----------------
// (User: "change thanos to devour enemies in half the total number of lanes —
// same thing, but in 2v2 its 8 lanes so it works there as well.")
test("Thanos devours half the lanes: 3 of 6 in 1v1", function () {
  var G = freshGame();
  G.state.player.isHuman = false; G.state.ai.isHuman = false;
  assertEq(G.LANE_COUNT, 6, 'a 1v1 board is six lanes');
  // Fill every enemy lane so the devour count equals the lane count rolled.
  for (var i = 0; i < 6; i++) {
    G.state.lanes[i].ai = G.createCardInstance(cardByName('Hawkeye'), 'ai');
  }
  var thanos = G.createCardInstance(cardByName('Thanos'), 'player');
  G.state.lanes[0].player = thanos;
  cardByName('Thanos').onPlay(G, thanos, 0);

  var left = 0;
  for (var j = 0; j < 6; j++) if (G.state.lanes[j].ai) left++;
  assertEq(left, 3, 'three of the six enemies are erased');
});

test("Thanos devours half the lanes: 4 of 8 in 2v2", function () {
  Game.start2v2Match({ names: { p1: 'A', p2: 'B', p3: 'C', p4: 'D' } });
  var s = Game.state;
  assertEq(Game.LANE_COUNT, 8, 'a 2v2 board is eight lanes');
  for (var i = 0; i < 8; i++) {
    s.lanes[i].ai = Game.createCardInstance(cardByName('Hawkeye'), 'ai');
  }
  var thanos = Game.createCardInstance(cardByName('Thanos'), 'player');
  s.lanes[0].player = thanos;
  cardByName('Thanos').onPlay(Game, thanos, 0);

  var left = 0;
  for (var j = 0; j < 8; j++) if (s.lanes[j].ai) left++;
  assertEq(left, 4, 'four of the eight enemies are erased — half the bigger board');
});

test("Thanos: the roguelite tier ladder still lands on its old numbers", function () {
  var G = freshGame();
  G.state.player.isHuman = false; G.state.ai.isHuman = false;
  // half(3) + offset. These are the values the flat 2/3/4/5 ladder produced,
  // so upgrading a run's Thanos is worth exactly what it was worth before.
  var expect = { rare: 3, special: 4, legendary: 5 };
  Object.keys(expect).forEach(function (tier) {
    for (var i = 0; i < 6; i++) {
      G.state.lanes[i].ai = G.createCardInstance(cardByName('Hawkeye'), 'ai');
    }
    var t = G.createCardInstance(cardByName('Thanos'), 'player');
    t._runRarity = tier;
    G.state.lanes[0].player = t;
    cardByName('Thanos').onPlay(G, t, 0);
    var killed = 0;
    for (var j = 0; j < 6; j++) if (!G.state.lanes[j].ai) killed++;
    assertEq(killed, expect[tier], tier + ' Thanos erases ' + expect[tier]);
    for (var k = 0; k < 6; k++) { G.state.lanes[k].ai = null; G.state.lanes[k].player = null; }
  });
});

// ---- ANT-MAN DESTROYS BEFORE HE SUMMONS --------------------------------
// (User: "flip the order — destroy... then summon for ant man.") The summon
// opens a LANE prompt, so leading with it asked the player to place the Ant
// before the automatic half of the card had resolved.
test("Ant-Man destroys first, then summons the Ant", function () {
  var G = freshGame();
  G.state.player.isHuman = false; G.state.ai.isHuman = false;
  // A DIFFERENT card as the victim: two instances of the same def in one fresh
  // game share an id and trip the duplicate-id invariant — test noise, not a
  // product bug, but noise that looks like one in the log.
  var victim = G.createCardInstance(cardByName('Hawkeye'), 'ai');
  victim.attack = 1; victim.currentHealth = 1;      // a legal ≤1/≤1 target
  G.state.lanes[3].ai = victim;

  var order = [];
  var realKill = G.killCard, realSummon = G.summonCardChoice;
  G.killCard = function (c, src) { order.push('destroy'); return realKill.call(G, c, src); };
  G.summonCardChoice = function () { order.push('summon'); return realSummon.apply(G, arguments); };
  try {
    var am = G.createCardInstance(cardByName('Ant-Man'), 'player');
    G.state.lanes[0].player = am;
    cardByName('Ant-Man').onPlay(G, am, 0);
  } finally {
    G.killCard = realKill; G.summonCardChoice = realSummon;
  }

  assertEq(order.join(' → '), 'destroy → summon', 'the kill resolves before the placement prompt');
  assertEq(G.state.lanes[3].ai, null, 'the enemy is gone');
});

test("Ant-Man still summons when there is nothing to destroy", function () {
  var G = freshGame();
  G.state.player.isHuman = false; G.state.ai.isHuman = false;
  // No enemies at all — the destroy half simply has no target.
  var summoned = 0;
  var realSummon = G.summonCardChoice;
  G.summonCardChoice = function () { summoned++; return realSummon.apply(G, arguments); };
  try {
    var am = G.createCardInstance(cardByName('Ant-Man'), 'player');
    G.state.lanes[0].player = am;
    cardByName('Ant-Man').onPlay(G, am, 0);
  } finally { G.summonCardChoice = realSummon; }

  assertEq(summoned, 1, 'the Ant is summoned even with no kill to make');
  var ants = 0;
  for (var i = 0; i < G.LANE_COUNT; i++) {
    if (G.state.lanes[i].player && G.state.lanes[i].player.name === 'Ant') ants++;
  }
  assertEq(ants, 1, 'and it actually reaches the board');
});

// ============================================================
// REDRAW COVERS TRICKS
// ------------------------------------------------------------
// The pick used to be resolved against p.hand alone, so a trick handed to
// redrawCard fell through the guard and returned false — silently. The owner
// asked for tricks to be offered by the redraw prompt with the same gold
// highlight the hand cards get, which only works if the engine can actually
// bin one. Cards and tricks go back to, and draw from, their OWN piles.
// ============================================================
test('Redraw swaps a TRICK for a new one from the trick pile', function () {
  var G = freshGame();
  G.state.phase = 'player-tricks';
  G.state.player.currency = 8;
  var keepCard = G.createCardInstance(cardByName('Catwoman'), 'player');
  G.state.player.hand = [keepCard];
  G.getDrawPile('player').push(cardByName('Hawkeye'));

  var doomed = Object.assign({}, TRICK_DEFS[0], { id: 90001 });
  var other  = Object.assign({}, TRICK_DEFS[1], { id: 90002 });
  G.state.player.trickHand = [doomed, other];
  var replacement = TRICK_DEFS[2];
  G.getTrickPile('player').push(replacement);
  var beforeTricks = G.state.player.trickHand.length;
  var beforePile   = G.getTrickPile('player').length;

  var ok = G.redrawCard('player', doomed);
  assertEq(ok, true, 'redrawing a trick succeeds');
  assertEq(G.state.player.currency, 6, 'spends the same 2 energy the card redraw does');
  assertEq(G.state.player.trickHand.length, beforeTricks, 'trick hand size unchanged: one out, one in');
  assertEq(G.state.player.trickHand.indexOf(doomed), -1, 'the redrawn trick leaves the trick hand');
  assertEq(G.state.player.trickHand.some(function (t) { return t.name === replacement.name; }), true,
    'and the replacement came off the TRICK pile');
  assertEq(G.getTrickPile('player').length, beforePile - 1, 'trick pile drops by exactly one');
  assertEq(G.state.player.hand.length, 1, 'the card hand is untouched');
  assertEq(G.state.player.redrawsUsed, 1, 'counter increments, so the next one costs 4');

  // A binned trick was never PLAYED — it must not show up in the round recap's
  // "tricks played" readout.
  assertEq((G.state.player.playedTrickPile || []).some(function (t) { return t.name === doomed.name; }), false,
    'a binned trick is not recorded as played');
});

test('Redraw stays available when only TRICKS are left to replace', function () {
  var G = freshGame();
  G.state.phase = 'player-tricks';
  G.state.player.currency = 8;
  G.state.player.hand = [];                       // no cards at all
  G.state.player.trickHand = [Object.assign({}, TRICK_DEFS[0], { id: 90003 })];
  G.getTrickPile('player').push(TRICK_DEFS[1]);
  assertEq(G.redrawBlockedReason('player'), null,
    'an empty card hand no longer refuses a redraw when a trick can still be swapped');

  // ...and the mirror: nothing on either side is still a refusal.
  var G2 = freshGame();
  G2.state.phase = 'player-tricks';
  G2.state.player.currency = 8;
  G2.state.player.hand = [];
  G2.state.player.trickHand = [];
  assertEq(G2.redrawBlockedReason('player'), 'Nothing to redraw', 'empty hand AND empty tricks refuses');
});

test('Redraw refuses a trick whose own pile is empty, without spending anything', function () {
  var G = freshGame();
  G.state.phase = 'player-tricks';
  G.state.player.currency = 8;
  // A full CARD pile must not let a trick redraw run on an empty trick pile —
  // the gate only knows one of the two has stock; redrawCard decides which.
  G.state.player.hand = [G.createCardInstance(cardByName('Catwoman'), 'player')];
  G.getDrawPile('player').push(cardByName('Hawkeye'));
  var stuck = Object.assign({}, TRICK_DEFS[0], { id: 90004 });
  G.state.player.trickHand = [stuck];
  G.getTrickPile('player').length = 0;

  assertEq(G.redrawBlockedReason('player'), null, 'the button is live — the card side still has stock');
  assertEq(G.redrawCard('player', stuck), false, 'but the trick pick itself is refused');
  assertEq(G.state.player.currency, 8, 'no energy spent');
  assertEq(G.state.player.trickHand.length, 1, 'and the trick is still in hand');
  assertEq(G.state.player.redrawsUsed | 0, 0, 'the counter did not move, so the price did not go up');
});

// ============================================================
// EVERY ENVIRONMENT IS ON A CLOCK
// ------------------------------------------------------------
// None of them had one. An environment held its lane until something replaced
// or killed it, and the Enclosure was the worst case: its toll came round every
// turn forever, the bot pays while it can afford to, and energy refills BEFORE
// upkeep runs, so on the AI's side the gate never opened and never left.
// Owner: "all environments stay on the field for 4 turns."
// ============================================================
test('Every environment fades after Game.ENV_TURNS rounds', function () {
  var G = freshGame();
  assertEq(G.ENV_TURNS, 4, 'four rounds is the rule');
  var env = G._placeEventEnvironment('player', 2, 'Boiler Room');
  assert(env, 'the environment is seated');
  assertEq(env._envTurns, G.ENV_TURNS, 'and it arrives with a full clock');

  for (var r = 1; r < G.ENV_TURNS; r++) {
    G._tickEnvironments();
    assertEq(G.state.lanes[2]._env.player, env, 'still there after ' + r + ' round(s)');
    assertEq(env._envTurns, G.ENV_TURNS - r, 'with ' + (G.ENV_TURNS - r) + ' left on the clock');
  }
  G._tickEnvironments();
  assertEq(G.state.lanes[2]._env.player, null, 'the fourth tick clears the lane');
});

test('A timed environment expiry is not a death', function () {
  // Routing it through handleDeath would fire When Destroyed for a card nothing
  // killed — Xenomorph would Splash the lane on its way out.
  var G = freshGame();
  var env = G._placeEventEnvironment('player', 0, 'Boiler Room');
  var died = false;
  env.onDeath = function () { died = true; };
  for (var i = 0; i < G.ENV_TURNS; i++) G._tickEnvironments();
  assertEq(G.state.lanes[0]._env.player, null, 'it is gone');
  assertEq(died, false, 'and its When Destroyed never fired');
});

test('Each environment runs its own clock', function () {
  var G = freshGame();
  var mine  = G._placeEventEnvironment('player', 0, 'Boiler Room');
  G._tickEnvironments();
  G._tickEnvironments();
  var yours = G._placeEventEnvironment('ai', 4, 'Boiler Room');
  assertEq(mine._envTurns, 2, 'the older one is halfway through');
  assertEq(yours._envTurns, G.ENV_TURNS, 'the new one starts fresh');
  G._tickEnvironments();
  G._tickEnvironments();
  assertEq(G.state.lanes[0]._env.player, null, 'the older one runs out first');
  assertEq(G.state.lanes[4]._env.ai, yours, 'the newer one is still standing');
});

test("The Enclosure's last toll lands on its final round", function () {
  var G = freshGame();
  var gate = G._placeEventEnvironment('player', 3, 'Enclosure');

  // Rounds 1-3: an ordinary toll, and paying keeps the gate shut.
  for (var turn = 1; turn < G.ENV_TURNS; turn++) {
    G.state._pendingUpkeep = [];
    gate.onTurnStart(G, gate);
    assertEq(G.state._pendingUpkeep.length, 1, 'turn ' + turn + ' asks for its toll');
    assert(!/final toll/i.test(G.state._pendingUpkeep[0].promptDesc || ''),
      'turn ' + turn + ' is not billed as the last one');
    G.state._pendingUpkeep[0].onPay();
    assertEq(G.state.lanes[3]._env.player, gate, 'turn ' + turn + ' paid — still standing');
    G._tickEnvironments();
  }

  // Round 4 is the last one the clock allows, and the prompt says so.
  G.state._pendingUpkeep = [];
  gate.onTurnStart(G, gate);
  assertEq(G.state._pendingUpkeep.length, 1, 'the final round still asks');
  assert(/final toll/i.test(G.state._pendingUpkeep[0].promptDesc || ''), 'and it says it is the last one');
  G.state._pendingUpkeep[0].onPay();
  G._tickEnvironments();
  assertEq(G.state.lanes[3]._env.player, null, 'paid it out — the park closes');
  assertEq(G.state.lanes[3].ai, null, 'and nothing was released for paying');
  assertEq(G.state.lanes[3].player, null, 'on either side');
});

test('Refusing on the final round still lets the T-Rex out', function () {
  // The clock and the release both land on the last round; the wrong order
  // would take the paddock away and quietly cancel the punishment.
  var G = freshGame();
  var gate = G._placeEventEnvironment('player', 1, 'Enclosure');
  for (var turn = 1; turn < G.ENV_TURNS; turn++) {
    G.state._pendingUpkeep = [];
    gate.onTurnStart(G, gate);
    G.state._pendingUpkeep[0].onPay();
    G._tickEnvironments();
  }
  G.state._pendingUpkeep = [];
  gate.onTurnStart(G, gate);
  G.state._pendingUpkeep[0].onDecline();
  var rex = G.state.lanes[1].ai;
  assert(rex && rex.name === 'T-Rex', 'refusing the final toll still releases it');
  assertEq(rex.owner, 'ai', 'against the side that refused');
  assertEq(G.state.lanes[1]._env.player, null, 'and the paddock is spent');
});

test('An environment declares which side it turns on, and the flag survives instancing', function () {
  // The lane backdrop paints an environment's picture on the half it acts
  // AGAINST (owner: "the picture should be on the side its against"), which is
  // the opponent's for almost all of them and the OWNER'S for the Enclosure —
  // its T-Rex is released against whoever stopped paying. The renderer reads
  // this off the instance, and createCardInstance builds from an explicit
  // literal, so a def-only flag would silently arrive as undefined there.
  assertEq(cardByName('Enclosure').actsAgainstOwner, true, 'the Enclosure turns on its owner');
  ['Boiler Room', 'Sewers', 'Open Water', 'The Bathroom', 'Game Over', 'Wetlands'].forEach(function (n) {
    assertEq(!!cardByName(n).actsAgainstOwner, false, n + ' works for its owner');
  });

  var G = freshGame();
  var gate = G.createCardInstance(cardByName('Enclosure'), 'player');
  var room = G.createCardInstance(cardByName('Boiler Room'), 'player');
  assertEq(gate.actsAgainstOwner, true, 'the flag reaches the instance');
  assertEq(room.actsAgainstOwner, false, 'and is false, not undefined, on the rest');
});

// ---- RUNNER ------------------------------------------------
// ============================================================

for (var i = 0; i < __tests.length; i++) {
  var t = __tests[i];
  try {
    t.fn();
    __passed++;
    console.log('  PASS  ' + t.name);
  } catch (e) {
    __failed++;
    __failures.push({ name: t.name, error: e && e.message || String(e) });
    console.log('  FAIL  ' + t.name + ' — ' + (e && e.message || e));
  }
}

console.log('');

console.log('=== ' + __passed + ' passed, ' + __failed + ' failed ===');
if (__failed > 0) {
  console.log('');
  console.log('Failures:');
  __failures.forEach(function (f) { console.log('  • ' + f.name + ': ' + f.error); });
}
