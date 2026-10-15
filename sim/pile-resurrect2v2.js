// ============================================================
// A CARD THAT HAS BEEN DRAWN NEVER GOES BACK IN THE DECK.
//
//   jsc sim/pile-resurrect2v2.js
//
// Owner, round 13 of a 2v2 online game, holding two Professor X while Ryan
// was handed a third by Dormammu's foresight: "i drew 2 of the same card and
// so did everyone else, it mightve been because the table got stuck."
//
// The 2v2 deck is one shared array, tt.drawPile. A play bridges it onto the
// 1v1 proxy (state.drawPile = tt.drawPile) and the un-bridge adopts whatever
// state.drawPile holds afterwards — on the theory that if the two differ, the
// code inside swapped the pile (Paul Atreides, a reshuffle). But the un-bridge
// is DEFERRED while a prompt is open, and a stuck table keeps it deferred for
// rounds. Meanwhile foresight (Dr. Strange / Eye of Agamotto / Dormammu)
// REPLACED tt.drawPile with a filtered copy and every later draw came off the
// copy. When the deferred un-bridge finally ran, it saw "they differ" and
// adopted the OLD array — every card drawn since the bridge opened was back on
// top, and the next draws handed them out a second time.
//
//   PR-1  a deferred un-bridge must not reinstate a pile someone else replaced
//   PR-2  foresight removes the handed cards IN PLACE, so it never replaces
//         the shared pile to begin with
//   PR-3  a play that genuinely swaps the pile inside the bridge still sticks
// ============================================================

var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-real.js');

var __cases = [], __passed = 0, __failed = 0, __failures = [];
function t(name, fn) { __cases.push({ name: name, fn: fn }); }
var __caseFailed = false, __caseMsgs = [];
function eq(label, actual, expected) {
  if (actual !== expected) {
    __caseFailed = true;
    __caseMsgs.push(label + ': expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
  }
}

function room() {
  Game.start2v2Match({ names: { p1: 'Sy', p2: 'Ryan', p3: 'Cortex', p4: 'Vega' } });
  var tt = Game.state.twoVTwo;
  tt.online = true; tt.you = 'p1';
  tt.joinedPlayers = { p1: 1, p2: 1, p3: 1, p4: 1 };
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) {
    tt.players[k].isAI = (k === 'p3' || k === 'p4');
    tt.players[k].hand = []; tt.players[k].energy = 10; tt.players[k].usedEnergy = 0;
  });
  tt.round = 5; Game.state.round = 5; Game.state.phase = '2v2-play';
  var ord = Game._2v2ComputePhaseOrder(5);
  for (var i = 0; i < ord.length; i++) { if (ord[i].split('-')[0] === 'p1') { tt.subPhaseIdx = i; break; } }
  // One of every card, like the real match pool — so any duplicate is a bug.
  tt.drawPile = CARD_DEFS.filter(function (d) { return !d.isEnvironment && !d._spawnOnly; }).slice(0, 40);
  var s = Game.state;
  s.pendingCardChoice = null; s.pendingLaneChoice = null;
  s._combatContStack = []; s._deferredRestores = []; s._pendingAIActions = 0;
  return tt;
}

function names(tt) {
  var all = [];
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) { tt.players[k].hand.forEach(function (c) { all.push(c.name); }); });
  tt.drawPile.forEach(function (d) { all.push(d.name); });
  return all;
}
function dupes(list) {
  var seen = {}, out = [];
  list.forEach(function (n) { if (seen[n]) out.push(n); seen[n] = 1; });
  return out;
}

// Open a bridge and leave a prompt up, so the un-bridge is deferred — the
// state a stuck table leaves behind.
function openDeferredBridge() {
  Game._2v2WithSideBridge(function () {
    Game.state.pendingCardChoice = { title: 'stuck', cards: [{ name: 'x' }], callback: function () {}, owner: 'player', _2v2ActingPlayer: 'p1' };
  });
  eq('un-bridge was deferred', (Game.state._deferredRestores || []).length, 1);
}
function releaseDeferred() {
  Game.state.pendingCardChoice = null;
  Game.resumeCombatIfWaiting();
}

t('PR-1 a deferred un-bridge does not reinstate a replaced pile', function () {
  var tt = room();
  var before = tt.drawPile.length;
  openDeferredBridge();
  // Something else replaces the shared pile while the bridge is parked
  // (foresight did exactly this), then a round of draws comes off it.
  tt.drawPile = tt.drawPile.slice(0, tt.drawPile.length - 2);
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) {
    tt.players[k].hand.push(Game.createCardInstance(tt.drawPile.pop(), 'player'));
  });
  var afterDraw = tt.drawPile.length;
  releaseDeferred();
  eq('pile did not grow back', tt.drawPile.length, afterDraw);
  eq('no card exists twice across hands + pile', dupes(names(tt)).join(','), '');
  eq('sanity: we drew from a shrunk pile', afterDraw, before - 6);
});

t('PR-2 foresight removes handed cards in place — the shared pile is not replaced', function () {
  var tt = room();
  var pileRef = tt.drawPile;
  var top2 = [pileRef[pileRef.length - 1].name, pileRef[pileRef.length - 2].name];
  tt.players.p3._2v2Foresight = { count: 2, source: 'Dr. Strange' };   // AI owner auto-assigns
  Game._2v2ResolveForesight('p3', function () {});
  eq('same pile array', tt.drawPile === pileRef, true);
  eq('handed cards left the pile', tt.drawPile.some(function (d) { return top2.indexOf(d.name) >= 0; }), false);
  eq('no card exists twice across hands + pile', dupes(names(tt)).join(','), '');
});

t('PR-2b foresight while a bridge is parked, then the round draw: no duplicates', function () {
  var tt = room();
  openDeferredBridge();
  Game.state.pendingCardChoice = null;   // free the prompt slot for foresight, bridge still parked
  tt.players.p3._2v2Foresight = { count: 4, source: 'Dormammu' };
  Game._2v2ResolveForesight('p3', function () {});
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) { delete tt.players[k]._2v2GotForesightCard; });
  Game.state.pendingCardChoice = { title: 'stuck again', cards: [{ name: 'x' }], callback: function () {}, owner: 'player', _2v2ActingPlayer: 'p1' };
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) {
    tt.players[k].hand.push(Game.createCardInstance(tt.drawPile.pop(), 'player'));
  });
  releaseDeferred();
  // Next round's draws — the step that handed out the second copies.
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) {
    tt.players[k].hand.push(Game.createCardInstance(tt.drawPile.pop(), 'player'));
  });
  eq('no card exists twice across hands + pile', dupes(names(tt)).join(','), '');
});

t('PR-3 a play that swaps the pile inside the bridge still sticks', function () {
  var tt = room();
  var swapped = tt.drawPile.slice(0, 10);
  Game._2v2WithSideBridge(function () { Game.state.drawPile = swapped; });
  eq('shared pile adopted the in-bridge swap', tt.drawPile === swapped, true);
});

__cases.forEach(function (c) {
  __caseFailed = false; __caseMsgs = [];
  try { c.fn(); } catch (e) { __caseFailed = true; __caseMsgs.push('threw: ' + (e && e.message || e)); }
  if (__caseFailed) { __failed++; __failures.push({ name: c.name, msgs: __caseMsgs.slice() }); }
  else __passed++;
});
print('pile-resurrect2v2: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) { print('  - ' + f.name); f.msgs.forEach(function (m) { print('      ' + m); }); });
}
