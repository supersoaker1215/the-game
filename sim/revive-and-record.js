// ============================================================
// A REVIVED CARD GETS ITS ABILITY BACK — and the dossier says HOW a
// card reached the hand.
//
//   jsc sim/revive-and-record.js
//
// Two owner reports, one file, because both are "the engine remembers
// something it should have let go of, or forgot something it should
// have written down":
//
//   1. "carnage revived from revan and his heal didnt go off again —
//       make sure it works for all card like this"
//      Revan's Revive says the card "comes back as if newly played —
//      abilities reset and its When Played fires again". That was true
//      of the keyword kit (applyAbilities) and of onPlay, but NOT of the
//      once-per-life latch a card stamps on itself. Carnage heals once
//      at Start of Tricks and sets `carnageHealed`; the flag outlived
//      the revive, so a revived Carnage was a 3/4 body with a dead
//      ability. Venom, Dormammu, Galactus, Anakin and Gizmo share the
//      shape — the bug is the class.
//
//   2. "this SS was assimilated but just says drawn — the history
//       should show how it ended up in the hand"
//      addToHand is the single door every hand gain walks through and
//      it wrote "Drawn" for all of them, so an assimilated copy, a card
//      stolen out of an enemy hand and a body raised from the dead pile
//      all read the same.
//
// THE SECOND HALF OF CASE 1 IS THE ONE THAT MATTERS MOST. Six other
// flags look exactly like `carnageHealed` and MUST NOT be cleared:
// two are in-flight re-entrancy guards (clearing them mid-cascade
// hangs), one is Doomsday's revive limiter (clearing it is infinite
// lives), one is Game Over's documented loop guard, and two are
// deliberate "spent, period" designs. RR-2 pins that list so a future
// tidy-up can't fold them in.
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
  Game.state.phase = 'combat';
  Game.state.round = 4;
  Game.state.firstPlayer = 'player';
  Game.state.activePlayer = 'player';
  for (var i = 0; i < Game.LANE_COUNT; i++) {
    Game.state.lanes[i].player = null;
    Game.state.lanes[i].ai = null;
    Game.state.lanes[i].destroyed = false;
  }
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
function historyText(card) {
  return (card._history || []).map(function (h) { return h.t; });
}

// ============================================================
// 1. THE REPORTED BUG — Carnage revived by Revan heals again.
// ============================================================
t('RR-1 a revived Carnage gets his once-per-life heal back', function () {
  reset();
  var carnage = realCard('Carnage', 'player');
  Game.state.lanes[2].player = carnage;
  // He has already healed this life — the exact state Revan revives into.
  carnage.carnageHealed = true;
  // Revan's grant: a generic revive charge, no custom onDeath.
  carnage.reviveCharges = 1;
  carnage.currentHealth = 0;
  Game.handleDeath(carnage, 2);
  eq('revived (still on board)', Game.state.lanes[2].player === carnage, true);
  eq('charge spent',             carnage.reviveCharges, 0);
  eq('heal latch cleared',       !!carnage.carnageHealed, false);
});

// ============================================================
// 2. THE GUARD RAIL — the flags that look identical and must survive.
//    If one of these ever comes back false, the fix has over-reached:
//      _doomsdayRevived  -> infinite Doomsday lives
//      _revealSpent      -> Game Over raises bodies forever
//      _obiWanReflecting -> reflect recurses on itself
//      _trigonChaining   -> kill-chain recurses on itself
//      trigonFrozen      -> a re-summon snap-freezes the field
//      _spinoHuntSpent   -> the hunt meter can be earned twice
// ============================================================
t('RR-2 re-entrancy guards, revive limiters and spent meters are NOT reset', function () {
  reset();
  var c = realCard('Carnage', 'player');
  var keep = ['_doomsdayRevived', '_revealSpent', '_obiWanReflecting',
              '_trigonChaining', 'trigonFrozen', '_spinoHuntSpent',
              '_bathroomTriggered', '_owSpawned', '_sewersTriggered',
              '_wetReleased', '_artExhausted'];
  keep.forEach(function (f) { c[f] = true; });
  c.carnageHealed = true;
  Game.resetOncePerLifeTriggers(c);
  eq('the latch it is for was cleared', !!c.carnageHealed, false);
  keep.forEach(function (f) { eq(f + ' survived', !!c[f], true); });
});

// ============================================================
// 3. THE CLASS — every card with this shape, not just Carnage.
// ============================================================
t('RR-3 the whole once-per-life class resets, and nothing else does', function () {
  reset();
  var c = realCard('Carnage', 'player');
  var flags = Game.ONCE_PER_LIFE_FLAGS;
  eq('list is non-empty', flags.length > 0, true);
  flags.forEach(function (f) { c[f] = true; });
  var cleared = Game.resetOncePerLifeTriggers(c);
  eq('cleared count', cleared, flags.length);
  flags.forEach(function (f) { eq(f + ' cleared', !!c[f], false); });
  // Named explicitly so the list cannot silently shrink.
  ['carnageHealed', 'venomHealed', 'dormammuDrained',
   'galactusDevoured', 'anakinMoved', '_gizmoTriggered'].forEach(function (f) {
    eq(f + ' is in the list', flags.indexOf(f) >= 0, true);
  });
});

// ============================================================
// 4. THE DOSSIER — a stated manner of arrival is what gets recorded.
// ============================================================
t('RR-4 addToHand records HOW the card arrived when the caller says', function () {
  reset();
  var c = realCard('Silver Surfer', 'player');
  Game.addToHand('player', c, null, null, 'Assimilated from the enemy hand');
  var h = historyText(c);
  eq('recorded the manner', h.indexOf('Assimilated from the enemy hand') >= 0, true);
  eq('did not say Drawn',   h.indexOf('Drawn') >= 0, false);
});

t('RR-5 a plain draw still reads Drawn', function () {
  reset();
  var c = realCard('Silver Surfer', 'player');
  Game.addToHand('player', c);
  eq('plain draw', historyText(c).indexOf('Drawn') >= 0, true);
});

// ============================================================
// 5. THE REPORTED BUG — the real Assimilate trick, end to end.
//    This is the case the owner screenshotted: the record said "Drawn".
// ============================================================
t('RR-6 Assimilate writes its own name into the copy\'s record', function () {
  reset();
  var victim = realCard('Gizmo', 'ai');
  Game.state.ai.hand = [victim];
  Game.state.player.hand = [];
  var trick = null;
  for (var i = 0; i < TRICK_DEFS.length; i++) if (TRICK_DEFS[i].name === 'Assimilate') { trick = TRICK_DEFS[i]; break; }
  eq('found the trick', !!trick, true);
  if (!trick) return;
  trick.play(Game, 'player');
  var copy = Game.state.player.hand[0];
  eq('a copy landed in hand', !!copy, true);
  if (!copy) return;
  var h = historyText(copy);
  eq('record names the manner', h.indexOf('Assimilated from the enemy hand') >= 0, true);
  eq('record is not a bare Drawn', h.indexOf('Drawn') >= 0, false);
  eq("the original stayed put", Game.state.ai.hand.length, 1);
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
print('revive-and-record: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
