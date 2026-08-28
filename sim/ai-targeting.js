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
