// ============================================================
// YOUR CARDS, NOT YOUR TEAM'S.
//
//   jsc sim/seat-scope.js
//
// Owner: "for mace and doomsday in 2v2 it only counts for your own cards, not
// teammates … they get too big, this is a nerf."
//
// A side in 2v2 is a TEAM of two, so "an ally was destroyed" and "each time you
// play a card" were both true of the teammate's board as well as your own.
// Mace Windu and Doomsday are written against a 1v1 board where those events
// happen at one rate; on a shared board they happened at two, and both cards
// compounded to sizes the text never promised.
//
// Scoped to the SEAT now, through one helper — Game._2v2SameSeat — so the two
// cards cannot drift apart, and so a third card with the same shape has an
// answer to use. Outside 2v2 there is one seat per side and the helper is
// always true, which is why 1v1 is untouched: SC-4 pins that.
//
// This is a deliberate balance change, asked for. It is not a bug fix, and the
// old behaviour was not broken — it was the 1v1 rule applied to a 2v2 board.
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
function mk(name, owner) {
  var def = null;
  for (var i = 0; i < CARD_DEFS.length; i++) if (CARD_DEFS[i].name === name) { def = CARD_DEFS[i]; break; }
  if (!def) throw new Error('no CARD_DEF named ' + name);
  var c = Game.createCardInstance(def, owner);
  Game.applyAbilities(c);
  return c;
}
// p1 and p3 are teammates on side A; p2 and p4 are the other team.
function table() {
  Game.start2v2Match({ names: { p1: 'Me', p2: 'Foe1', p3: 'Mate', p4: 'Foe2' },
                       teamAssignment: { A: ['p1', 'p3'], B: ['p2', 'p4'] } });
  var tt = Game.state.twoVTwo;
  tt.online = true; tt.you = 'p1';
  Game.state.round = 3; tt.round = 3;
  for (var i = 0; i < Game.LANE_COUNT; i++) { Game.state.lanes[i].player = null; Game.state.lanes[i].ai = null; }
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) { tt.players[k].energy = 9; tt.players[k].usedEnergy = 0; });
  return tt;
}

// ============================================================
// SC-1 — Mace grows from HIS fallen, not his teammate's.
// ============================================================
t('SC-1 Mace Windu counts only his own seat\'s losses', function () {
  var tt = table();
  var side = Game._2v2TeamSide['A'];
  var mace  = mk('Mace Windu', side); mace._2v2PlayedBy = 'p1';
  var mine  = mk('Gizmo', side);      mine._2v2PlayedBy = 'p1';
  var mates = mk('Bane', side);       mates._2v2PlayedBy = 'p3';
  Game.state.lanes[0][side] = mace;
  Game.state.lanes[1][side] = mine;
  Game.state.lanes[2][side] = mates;
  var hp0 = mace.maxHealth;

  Game.killCard(mates, null); Game.cleanupDead();
  eq("the teammate's card does not feed him", mace.maxHealth, hp0);

  Game.killCard(mine, null); Game.cleanupDead();
  eq('his own does', mace.maxHealth, hp0 + 2);
});

// ============================================================
// SC-2 — Doomsday grows on HIS owner's plays only.
// ============================================================
t('SC-2 Doomsday counts only his own seat\'s plays', function () {
  var tt = table();
  var side = Game._2v2TeamSide['A'];
  var dd = mk('Doomsday', side); dd._2v2PlayedBy = 'p1';
  tt.players.p1.hand = [dd];
  tt.players.p3.hand = [mk('Gizmo', side)];
  var atk0 = dd.attack;

  Game._2v2CurrentActingPlayer = 'p3';
  Game._2v2OnlinePlayCard('p3', 0, 4, false);
  eq("the teammate's play does not grow him", dd.attack, atk0);

  tt.players.p1.hand.push(mk('Bane', side));
  Game._2v2CurrentActingPlayer = 'p1';
  Game._2v2OnlinePlayCard('p1', 1, 5, false);
  eq('his own owner\'s play does', dd.attack, atk0 + 1);
});

// ============================================================
// SC-3 — and the in-hand cost discount is the same rule.
// ============================================================
t('SC-3 Doomsday discounts only on his own seat\'s losses', function () {
  var tt = table();
  var side = Game._2v2TeamSide['A'];
  var dd = mk('Doomsday', side); dd._2v2PlayedBy = 'p1';
  tt.players.p1.hand = [dd];
  var theirs = mk('Bane', side);  theirs._2v2PlayedBy = 'p3';
  var ours   = mk('Gizmo', side); ours._2v2PlayedBy = 'p1';
  Game.state.lanes[2][side] = theirs;
  Game.state.lanes[3][side] = ours;
  var cost0 = dd.cost;

  Game.killCard(theirs, null); Game.cleanupDead();
  eq("the teammate's loss does not discount him", dd.cost, cost0);

  Game.killCard(ours, null); Game.cleanupDead();
  eq('his own does', dd.cost, cost0 - 1);
});

// ============================================================
// SC-4 — 1v1 IS UNTOUCHED. One seat per side, so the helper is always
//        true and both cards behave exactly as they always did.
// ============================================================
t('SC-4 1v1 keeps the old behaviour exactly', function () {
  Game.init();
  for (var i = 0; i < Game.LANE_COUNT; i++) { Game.state.lanes[i].player = null; Game.state.lanes[i].ai = null; }
  eq('no seats, so same-seat is always true', Game._2v2SameSeat({}, {}), true);

  var mace = mk('Mace Windu', 'player');
  var ally = mk('Gizmo', 'player');
  var dd   = mk('Doomsday', 'player');
  Game.state.lanes[0].player = mace;
  Game.state.lanes[1].player = ally;
  Game.state.player.hand = [dd];
  var hp0 = mace.maxHealth, cost0 = dd.cost;

  Game.killCard(ally, null); Game.cleanupDead();
  eq('Mace still grows', mace.maxHealth, hp0 + 2);
  eq('Doomsday still discounts', dd.cost, cost0 - 1);
});

// ============================================================
// SC-5 — one helper, so the two cards cannot drift apart.
// ============================================================
t('SC-5 both cards ask the same question', function () {
  eq('the helper exists', typeof Game._2v2SameSeat, 'function');
  eq('Mace uses it',     /_2v2SameSeat/.test(String(CARD_ABILITIES['Mace Windu'].onAllyKilled)), true);
  eq('Doomsday uses it', /_2v2SameSeat/.test(String(Game._scaleDoomsdayInHands)), true);
  // The kill hook has to be TOLD which card died, or the seat cannot be read.
  eq('onAllyKilled receives the dead card',
     /onAllyKilled\(this, a, card\)/.test(readFile('./game.js')), true);
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
print('seat-scope: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
