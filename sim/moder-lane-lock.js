// ============================================================
// ONE ANSWER TO "WHICH LANES MAY I PLACE INTO".
//
//   jsc sim/moder-lane-lock.js
//
// Owner: "for moder, his ability works but the opponent needs to only
// have that lane highlighted to play."
//
// The engine already pulled the compelled card into Moder's lane. What
// it never did was SAY so anywhere except the 1v1 board: three separate
// placement surfaces each decided for themselves which lanes were
// legal, and two of them — both 2v2 pickers — asked only "is my slot
// free". A compelled player in 2v2 saw every lane button lit, aimed
// wherever they liked, and watched the card land somewhere else.
//
// Game.placeableLanesFor is now the single answer all three ask.
//
// It deliberately consults moderCompulsionLane rather than the raw
// `forcedLane` stamp. M-2 is the case that matters most: the stamp
// outlives a Moder who left the board silently (Super Soldier Serum's
// killCardSilent, devour-to-void, a bounce to hand), and a board
// padlocked to a compeller who is not standing there is the same
// residue that used to march a guest's cards into lanes 1, 2, 3 with
// no picker at all. The 1v1 board was reading that raw stamp until
// now, while the lock GLYPH beside it read the validated one — so the
// two disagreed exactly when it mattered.
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
function compel(lane) {
  Game.state.lanes[lane].ai = mk('Moder', 'ai');
  Game.state.player.forcedLane = lane;
}

// ============================================================
// M-1 — a live compulsion leaves exactly one door open.
// ============================================================
t('M-1 a live Moder narrows the compelled side to his lane alone', function () {
  clearBoard();
  eq('unconstrained, every lane is open',
     Game.placeableLanesFor('player', mk('Gizmo', 'player')).length, Game.LANE_COUNT);
  compel(3);
  eq('compulsion is live', Game.moderCompulsionLane('player'), 3);
  eq('exactly one lane', JSON.stringify(Game.placeableLanesFor('player', mk('Gizmo', 'player'))), '[3]');
  // The compelling side is not itself compelled.
  eq('the other side is unaffected',
     Game.placeableLanesFor('ai', mk('Gizmo', 'ai')).indexOf(0) >= 0, true);
});

// ============================================================
// M-2 — THE RESIDUE GUARD. A stamp without a Moder locks nothing.
// ============================================================
t('M-2 a stale forcedLane stamp does not padlock the board', function () {
  clearBoard();
  compel(3);
  eq('locked while he stands', Game.placeableLanesFor('player', mk('Gizmo', 'player')).length, 1);
  // He leaves without an onDeath — the exact silent exit that strands the stamp.
  Game.state.lanes[3].ai = null;
  eq('the stamp is still there', Game.state.player.forcedLane, 3);
  eq('but the compulsion is dead', Game.moderCompulsionLane('player'), -1);
  eq('so the board is open again',
     Game.placeableLanesFor('player', mk('Gizmo', 'player')).length, Game.LANE_COUNT);
});

// ============================================================
// M-3 — nowhere to pull the card means no lock at all.
// ============================================================
t('M-3 the lock dissolves when the compelled side already holds that lane', function () {
  clearBoard();
  compel(3);
  Game.state.lanes[3].player = mk('Gizmo', 'player');
  var open = Game.placeableLanesFor('player', mk('Gizmo', 'player'));
  eq('not narrowed to one', open.length, Game.LANE_COUNT - 1);
  eq('and lane 3 is not offered — it is occupied', open.indexOf(3), -1);
});

// ============================================================
// M-4 — an environment is not the card Moder is reaching for.
// ============================================================
t('M-4 environments are never compelled', function () {
  clearBoard();
  compel(3);
  var lanes = Game.placeableLanesFor('player', { isEnvironment: true });
  eq('an environment still has choices', lanes.length > 1, true);
});

// ============================================================
// M-5 — every placement surface asks the same question. This is the
//       durable case: a fourth picker added later fails it until it
//       routes through the helper too.
// ============================================================
t('M-5 all three placement surfaces route through placeableLanesFor', function () {
  var ui = readFile('./ui.js');
  var uses = (ui.match(/placeableLanesFor/g) || []).length;
  eq('at least three call sites in the UI', uses >= 3, true);
  // And none of them still hand-rolls "is my slot free" as the whole rule.
  eq('the 2v2 strip no longer decides for itself',
     /const blocked = !!\(ln\[mySide\]\);/.test(ui), false);
  eq('the 2v2 overlay picker no longer decides for itself',
     /const blocked = !!\(ln\[side\]\);/.test(ui), false);
  // The 1v1 board reads the validated compulsion, not the raw stamp.
  eq('the 1v1 board stopped reading the raw stamp',
     /let fl = s\.player && s\.player\.forcedLane/.test(ui), false);
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
print('moder-lane-lock: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
