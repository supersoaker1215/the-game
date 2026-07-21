// Probe the "unresolved events crossed into a new round" Stack leak.
// Seeds Math.random for a deterministic sample, wraps _stackClear to
// record WHAT gets dropped at startRound (type + label), and reports
// counts. Deterministic → fair before/after comparison.
//
//   jsc sim/probe-stack.js -- --games 120

var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');

var __mrState = 999 >>> 0;
function reseed(n) { __mrState = (n >>> 0) || 1; }
Math.random = function () {
  __mrState |= 0; __mrState = (__mrState + 0x6D2B79F5) | 0;
  var t = Math.imul(__mrState ^ (__mrState >>> 15), 1 | __mrState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

var GAMES = 120;
for (var i = 0; i < arguments.length; i++) {
  if (arguments[i] === '--games' && arguments[i + 1]) GAMES = parseInt(arguments[i + 1], 10);
}

var G = Game;
var dropped = [];       // {type, label}
var dropEvents = 0, dropRounds = 0, liveDrops = 0, promptPendingAtClear = 0, promptKinds = {};
var liveByType = {};
function onBoard(card) {
  var s = G.state; if (!s || !s.lanes) return false;
  for (var i = 0; i < s.lanes.length; i++) {
    if (s.lanes[i].player === card || s.lanes[i].ai === card) return true;
  }
  return false;
}
// "Live" = the dropped event WOULD have done something had it drained.
// death: card still on board at <=0 HP and not yet handled.
// call:  listener still on board and alive (matches the fn's own guards).
function isLive(ev) {
  var c = ev.card;
  if (ev.type === 'death') return !!(c && onBoard(c) && c.currentHealth <= 0 && !c._deathHandled);
  if (ev.type === 'call') {
    // The label is "hook:Name"; the closure captures the card, but we only
    // stored label — approximate liveness by checking the fn exists. We
    // can't re-read the captured card, so treat call-drops as potentially
    // live only when we can find a matching live listener by name+hook.
    return null; // unknown from label alone
  }
  return null;
}
var origClear = G._stackClear.bind(G);
G._stackClear = function (where) {
  if (where === 'startRound' && G._stack && G._stack.length) {
    dropRounds++;
    if (G._promptBusy()) {
      promptPendingAtClear++;
      var s = G.state;
      ['pendingCardChoice','pendingLaneChoice','pendingBlockTrick','pendingKangChoice','pendingJumpOffer','pendingTimeStoneIntercept'].forEach(function (k) {
        if (s[k]) promptKinds[k] = (promptKinds[k] || 0) + 1;
      });
    }
    G._stack.forEach(function (ev) {
      dropEvents++;
      var live = isLive(ev);
      if (live === true) { liveDrops++; liveByType[ev.type] = (liveByType[ev.type] || 0) + 1; }
      dropped.push({ type: ev.type, label: ev.label || '', live: live });
    });
  }
  return origClear(where);
};

for (var g = 0; g < GAMES; g++) {
  reseed(g + 1);
  try { runSimGame(null, null, null); } catch (e) { /* keep going */ }
}

// Aggregate.
var byType = {}, byLabelHead = {};
dropped.forEach(function (d) {
  byType[d.type] = (byType[d.type] || 0) + 1;
  var head = (d.label.split(':')[0]) || d.type;
  byLabelHead[head] = (byLabelHead[head] || 0) + 1;
});
print('games=' + GAMES + '  drop-rounds=' + dropRounds + '  dropped-events=' + dropEvents);
print('LIVE death drops=' + liveDrops + '  prompt-pending-at-clear=' + promptPendingAtClear); print('prompt kinds pending: ' + JSON.stringify(promptKinds));
print('by type:      ' + JSON.stringify(byType));
print('by label-head:' + JSON.stringify(byLabelHead));
// Show a few concrete dropped labels.
var sample = {};
dropped.forEach(function (d) { if (!sample[d.label] && Object.keys(sample).length < 15) sample[d.label] = 1; });
print('sample labels: ' + Object.keys(sample).join(' | '));
