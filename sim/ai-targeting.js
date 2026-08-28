// ============================================================
// THE BOT'S TARGET PICKS.
//
//   jsc sim/ai-targeting.js
//
// Owner, after losing a 2v2 on two of them in the same combat:
//   "he played gojo in 1 which is good but he moved doomsday 5 and didn't have
//    his attack reduced to 0 … he gets soul stone kills my omni man for the
//    hulk, doomsday with 15 attack is uncontested and hits us for the win.
//    literally the worst possible plays"
//
// Both were target-selection, not evaluation weights:
//
//   SOUL STONE  destroys one ally and one enemy. The AI branch was
//               `doSoulStone(allies[0])` — the first ELIGIBLE ally in lane
//               order, with no evaluation of any kind. It happened to be the
//               only body standing in front of a 15-ATK Doomsday, so the trick
//               killed a Hulk and opened the lane that lost the match.
//               (Gojo, standing earlier, was skipped only because his Immunity
//               fails canTrickLand — which is exactly how arbitrary "[0]" is.)
//
//   GOJO        moves an enemy, then strips the ATK off the enemies in his own
//               lane and the two beside it. The destination list was sorted to
//               put those cone lanes first ONLY when the owner was a bot; for
//               everyone else it went out unsorted. Every path that resolves a
//               prompt WITHOUT a person — the 30s timeout, the stall watchdog,
//               the force-recovery — takes lanes[0], so those all moved the
//               enemy somewhere the strip could not reach and the card did
//               nothing. Ordering the list takes no choice away from a human.
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

function clearBoard() {
  Game.init();
  for (var i = 0; i < Game.LANE_COUNT; i++) {
    Game.state.lanes[i].player = null;
    Game.state.lanes[i].ai = null;
    Game.state.lanes[i].destroyed = false;
  }
}
function mk(name, owner) {
  var def = null;
  for (var i = 0; i < CARD_DEFS.length; i++) if (CARD_DEFS[i].name === name) { def = CARD_DEFS[i]; break; }
  if (!def) throw new Error('no CARD_DEF named ' + name);
  var c = Game.createCardInstance(def, owner);
  Game.applyAbilities(c);
  return c;
}
function trick(name) {
  for (var i = 0; i < TRICK_DEFS.length; i++) if (TRICK_DEFS[i].name === name) return TRICK_DEFS[i];
  throw new Error('no TRICK_DEF named ' + name);
}

// ============================================================
// AT-1 — THE REPORTED LOSS. The wall is first in lane order; a worthless
//        body sits further along blocking nothing. The bot must give up
//        the worthless one.
// ============================================================
t('AT-1 Soul Stone does not sacrifice the body holding back a lethal swing', function () {
  clearBoard();
  Game.state.player.isHuman = false;                 // the bot owns this side
  var wall  = mk('Omni-Man', 'player');
  var spare = mk('Gizmo', 'player');
  Game.state.lanes[0].player = wall;                 // lane 1, facing the threat
  Game.state.lanes[3].player = spare;                // lane 4, facing nothing
  var doom = mk('Doomsday', 'ai');
  doom.attack = 15; doom.currentHealth = 15; doom.maxHealth = 15;
  Game.state.lanes[0].ai = doom;
  Game.state.lanes[2].ai = mk('Hulk', 'ai');

  trick('Soul Stone').play(Game, 'player');
  Game.cleanupDead();

  eq('the wall is still standing', !!Game.state.lanes[0].player, true);
  eq('the spare body was given up', !!Game.state.lanes[3].player, false);
  eq('the threat is still contested', !!Game.state.lanes[0].player && !!Game.state.lanes[0].ai, true);
});

// ============================================================
// AT-2 — and it still does its job: one ally and one enemy die.
// ============================================================
t('AT-2 Soul Stone still trades a body for an enemy', function () {
  clearBoard();
  Game.state.player.isHuman = false;
  Game.state.lanes[1].player = mk('Gizmo', 'player');
  Game.state.lanes[4].ai = mk('Hulk', 'ai');
  var alliesBefore  = Game.getAllCardsOf('player').length;
  var enemiesBefore = Game.getAllCardsOf('ai').length;
  trick('Soul Stone').play(Game, 'player');
  Game.cleanupDead();
  eq('one ally died',  Game.getAllCardsOf('player').length, alliesBefore - 1);
  eq('one enemy died', Game.getAllCardsOf('ai').length,     enemiesBefore - 1);
});

// ============================================================
// AT-3 — Gojo must OFFER his cone lanes first, for both owners.
//
// Asserting the ordering, not the outcome. sim/shim.js resolves a lane prompt
// with `lanes[Math.floor(Math.random() * lanes.length)]` — a random pick — so a
// test that checks where the enemy ended up is a coin flip, and it passed for
// me once by luck before failing on the next run. What the product actually
// guarantees is the ORDER of the list: cone lanes first, so every picker that
// takes lanes[0] — the 30s timeout, the stall watchdog, the force-recovery —
// lands somewhere the strip can reach.
// ============================================================
t('AT-3 Gojo offers a cone lane first, whoever owns him', function () {
  [false, true].forEach(function (human) {
    clearBoard();
    Game.state.player.isHuman = human;
    // GOJO IN THE MIDDLE, deliberately. With him in lane 1 the cone is lanes
    // 0-1, which an ascending list already starts with — so the sort is a no-op
    // and the test passes even unfixed. Put him at index 3 and the cone (2,3,4)
    // is NOT where the list naturally begins, so the ordering is what is
    // actually under test.
    var gojo = mk('Gojo', 'player');
    Game.state.lanes[3].player = gojo;               // cone = lane indices 2, 3, 4
    var big = mk('Doomsday', 'ai');
    big.attack = 15;
    Game.state.lanes[0].ai = big;                    // parked at the far end

    var offered = null;
    var realLane = Game.promptLaneChoice;
    Game.promptLaneChoice = function (owner, lanes, title, desc, cb) {
      if (offered === null) offered = lanes.slice();
      return realLane.apply(Game, arguments);
    };
    try { CARD_ABILITIES['Gojo'].onPlay(Game, gojo, 3); }
    finally { Game.promptLaneChoice = realLane; }

    eq('owner human=' + human + ': a destination list was offered', !!(offered && offered.length), true);
    if (offered && offered.length) {
      eq('owner human=' + human + ': the first offer is inside the cone',
         offered[0] >= 2 && offered[0] <= 4, true);
      // and nothing was taken away — the far lanes are still on the list
      eq('owner human=' + human + ': far lanes are still offered too',
         offered.indexOf(5) >= 0, true);
    }
  });
});

// ============================================================
// AT-4 / AT-5 — PLAY ORDER.
//
// Owner: "the ai always plays xenomorph last — if that card is going to be
// played it always is played 1st."
//
// Xenomorph is "+1/+1 each time any other card enters the board", and he costs
// 2. The AI plays most-expensive-first, so he was always LAST and grew by
// nothing — a 0/1 walking into combat. The same is true of every While-Active
// that answers an ENTRY (Juggernaut's adjacent Immunity, Poison Ivy's charm,
// Luke's and Dr. Strange's auras): they only ever reach the bodies that land
// after them. The rule reads the card's own onAnyCardPlayed hook rather than a
// list of names, so a new card of that shape is covered on the day it is added.
//
// AT-5 is the guard rail. Most-expensive-first is worth +6.3pp head to head
// because cheapest-first strands the AI's best body on a third of turns, so the
// jump has to be conditional: a reactive card goes first only when paying for
// it still leaves enough for the dearest card behind it.
// ============================================================
function playOrder(energy, names) {
  Game.init();
  for (var i = 0; i < Game.LANE_COUNT; i++) { Game.state.lanes[i].player = null; Game.state.lanes[i].ai = null; }
  Game.state.phase = 'ai-cards';
  Game.state.ai.currency = energy;
  Game.state.ai.hand = names.map(function (n) { return mk(n, 'ai'); });
  var order = [];
  var real = Game.playCard;
  Game.playCard = function (o, c, l) { order.push(c.name); return real.call(Game, o, c, l); };
  try { AI.playCards('ai'); } catch (e) {}
  Game.playCard = real;
  return order;
}

t('AT-4 a card that grows from later plays is played before them', function () {
  var order = playOrder(12, ['Xenomorph', 'Hulk', 'Gizmo']);
  eq('it played several cards', order.length >= 2, true);
  eq('Xenomorph led', order[0], 'Xenomorph');
  // And he actually grew from the ones that followed.
  var x = null;
  Game.getAllCardsOf('ai').forEach(function (c) { if (c.name === 'Xenomorph') x = c; });
  eq('he is on the board', !!x, true);
  if (x) eq('and he is bigger than his printed 0/1', x.attack > 0, true);
});

t('AT-5 but not when going first would strand the best body', function () {
  // Hulk costs 7 and the budget is 7: leading with the 2-drop leaves 5 and the
  // big body never lands. The desc rule has to win here.
  var order = playOrder(7, ['Xenomorph', 'Hulk']);
  eq('the big body was played', order.indexOf('Hulk') >= 0, true);
  eq('and it was not sacrificed to the 2-drop', order[0], 'Hulk');
});

// ============================================================
// AT-6 / AT-7 — WHICH ENEMY IS ACTUALLY GOING TO HURT US.
//
// Every "weaken or neutralise an enemy" picker sorted by raw ATK. A FEARED card
// attacks ITSELF (resolveLaneCombat: `if (pCard.isFeared) pTarget = pCard`), so
// its attack is not a threat, it is a gift — and taking 3 off it is the
// difference between it dying on its own swing and surviving. The bot spent
// Kryptonite on a feared Droideka and left an uncontested Revan to hit the
// health bar. (Owner: "the ai played kryptonite on the droideka that was feared
// so now he doesnt kill himself, instead of on the enemy revan to reduce damage
// to our healthbar.")
// ============================================================
t('AT-6 threat is not raw ATK: feared scores below zero, uncontested doubles', function () {
  clearBoard();
  var feared = mk('Droideka', 'ai');
  feared.attack = 5; feared.isFeared = true; feared.fearedTurns = 1;
  Game.state.lanes[3].ai = feared;
  Game.state.lanes[3].player = mk('Gizmo', 'player');      // contested
  var open = mk('Revan', 'ai'); open.attack = 4;
  Game.state.lanes[4].ai = open;                            // nothing opposite

  eq('a feared enemy is worth LESS than nothing', Game.threatOf(feared, 'player') < 0, true);
  eq('an uncontested swing counts double',        Game.threatOf(open, 'player'), 8);
  eq('so the bigger number is not the pick',      Game.pickBiggestThreat([feared, open], 'player').name, 'Revan');

  // Frozen and stunned do not swing either.
  var frozen = mk('Hulk', 'ai'); frozen.attack = 9; frozen.isFrozen = true;
  Game.state.lanes[1].ai = frozen;
  eq('a frozen 9-ATK is worth nothing', Game.threatOf(frozen, 'player'), 0);
});

t('AT-7 Kryptonite lands on the card that will actually hit us', function () {
  clearBoard();
  var feared = mk('Droideka', 'ai');
  feared.attack = 5; feared.isFeared = true; feared.fearedTurns = 1;
  Game.state.lanes[3].ai = feared;
  Game.state.lanes[3].player = mk('Gizmo', 'player');
  var open = mk('Revan', 'ai'); open.attack = 4;
  Game.state.lanes[4].ai = open;

  trick('Kryptonite').play(Game, 'player');
  eq('the feared one keeps its attack (it is killing itself)', feared.attack, 5);
  eq('the real threat was weakened', open.attack, 1);

  // And with nothing odd on the board it still takes the biggest hitter.
  clearBoard();
  var big = mk('Hulk', 'ai');  big.attack = 7;  Game.state.lanes[1].ai = big;
  var small = mk('Gizmo', 'ai'); small.attack = 1; Game.state.lanes[2].ai = small;
  trick('Kryptonite').play(Game, 'player');
  eq('plain board: the biggest hitter', big.attack, 4);
  eq('and the small one is untouched',  small.attack, 1);
});

// ============================================================
// AT-8 / AT-9 — OPTIMUS SPENDS THE FREE SWING WHERE IT CHANGES SOMETHING.
//
// Both of his picks were `[0]`: the first adjacent ally, and the enemy OPPOSITE
// him if alive. On the reported board that sent Green Goblin into a 3/1 The
// Thing — which Optimus himself, at 4 ATK, was going to kill in the very next
// combat anyway — while a 3/6 Solomon Grundy stood untouched beside them.
// (Owner: "he had GG attack the thing … he should have had GG attack solomon
// grundy so they can trade. optimus was already going to win the trade vs the
// thing.")
// ============================================================
function optimusBoard() {
  clearBoard();
  Game.state.ai.isHuman = false;
  var gg     = mk('Green Goblin', 'ai');     gg.attack = 3; gg.currentHealth = 3;
  var thing  = mk('The Thing', 'player');    thing.attack = 3; thing.currentHealth = 1;
  var grundy = mk('Solomon Grundy', 'player'); grundy.attack = 3; grundy.currentHealth = 6; grundy.maxHealth = 6;
  var opt    = mk('Optimus Prime', 'ai');    opt.attack = 4; opt.currentHealth = 4;
  Game.state.lanes[3].ai = gg;
  Game.state.lanes[4].player = thing;        // opposite Optimus, already doomed to him
  Game.state.lanes[3].player = grundy;       // opposite Green Goblin, survives
  Game.state.lanes[4].ai = opt;
  return { gg: gg, thing: thing, grundy: grundy, opt: opt };
}

t('AT-8 a target our own body is already killing is worth almost nothing', function () {
  var b = optimusBoard();
  var AB = CARD_ABILITIES['Optimus Prime'];
  var doomed = AB._targetScore(Game, b.opt, b.gg, b.thing);
  var live   = AB._targetScore(Game, b.opt, b.gg, b.grundy);
  eq('the doomed one scores low', doomed < 50, true);
  eq('the live one scores higher', live > doomed, true);
});

t('AT-9 so Optimus sends the swing at the card that survives otherwise', function () {
  var b = optimusBoard();
  CARD_ABILITIES['Optimus Prime'].onPlay(Game, b.opt, 4);
  eq('The Thing is left for Optimus', b.thing.currentHealth, 1);
  eq('Grundy took the free swing',    b.grundy.currentHealth, 3);

  // And a free swing that lands a kill nothing else was getting still wins.
  clearBoard();
  Game.state.ai.isHuman = false;
  var ally  = mk('Green Goblin', 'ai');  ally.attack = 3; ally.currentHealth = 3;
  var opt2  = mk('Optimus Prime', 'ai'); opt2.attack = 1; opt2.currentHealth = 4;
  // Sabertooth, not The Thing — The Thing carries Armor 2, and a target whose
  // armour eats the swing is a different test than the one intended here.
  var frail = mk('Sabertooth', 'player'); frail.attack = 1; frail.currentHealth = 2;  // 1 ATK Optimus cannot finish it
  var fat   = mk('Solomon Grundy', 'player'); fat.attack = 1; fat.currentHealth = 9; fat.maxHealth = 9;
  Game.state.lanes[3].ai = ally;
  Game.state.lanes[4].ai = opt2;
  Game.state.lanes[4].player = frail;
  Game.state.lanes[3].player = fat;
  CARD_ABILITIES['Optimus Prime'].onPlay(Game, opt2, 4);
  eq('it took the kill it could actually land', frail.currentHealth <= 0, true);
  eq('and left the one it could not dent',      fat.currentHealth, 9);
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
print('ai-targeting: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
