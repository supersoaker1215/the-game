// ============================================================
// A BOT WAITING ON SOMEONE ELSE IS NOT A HUNG BOT.
//
//   jsc sim/ai-drive-wait2v2.js
//
// Owner, round 3 of a 2v2 online game, log reading "Cortex [AI]'s turn was
// cut short — it stopped responding" and then the same for Vega, followed by
// "[OUT OF TURN] Solomon Grundy was not played": "its not hard for the AI to
// play a card and not have their turns cut short, FIX THIS NOW."
//
// The bot wasn't dead — it played a card the moment it woke, just on the
// wrong turn. It had been WAITING, and the 12s drive watchdog did not know:
//
//   DW-1  The AI queue waits on every prompt slot (hasPendingPrompt), but the
//         watchdog only stood down for a human's card/lane prompt. A human's
//         jump offer, block-trick offer, Kang choice or Time Stone reaction —
//         or an event hold, a resolution boundary, a hidden host tab — read
//         as silence and the turn was cut.
//   DW-2  The AI parks on whenPromptCleared and only wakes when somebody
//         calls resumeCombatIfWaiting. A prompt cleared down a path that
//         doesn't call it left the bot asleep behind nothing. It now polls as
//         a floor, and takes its continuation back off the LIFO stack so a
//         later pop isn't wasted on a no-op.
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
  tt.players.p1.isAI = false; tt.players.p2.isAI = false;
  tt.players.p3.isAI = true;  tt.players.p4.isAI = true;
  var s = Game.state;
  s.pendingCardChoice = null; s.pendingLaneChoice = null; s.pendingBlockTrick = null;
  s.pendingJumpOffer = null; s.pendingKangChoice = null; s.pendingTimeStoneIntercept = null;
  s._pendingAIActions = 0; s._combatContStack = []; s._combatContinuation = null;
  tt._resolving = false;
  return tt;
}

t('DW-1a nothing pending: the bot is not waiting on anyone', function () {
  room();
  eq('waiting', Game._2v2DriveWaitingOnOthers(), false);
});

t('DW-1b a human\'s JUMP offer holds the bot\'s clock', function () {
  room();
  Game.state.pendingJumpOffer = { cardId: 1, owner: 'player', seat: 'p1', _2v2ActingPlayer: 'p1' };
  eq('waiting', Game._2v2DriveWaitingOnOthers(), true);
});

t('DW-1c a human\'s BLOCK-TRICK offer holds the bot\'s clock', function () {
  room();
  Game.state.pendingBlockTrick = { _2v2Seat: 'p2' };
  eq('waiting', Game._2v2DriveWaitingOnOthers(), true);
});

t('DW-1d a human\'s Time Stone reaction holds the bot\'s clock', function () {
  room();
  Game.state.pendingTimeStoneIntercept = { _2v2Seat: 'p1' };
  eq('waiting', Game._2v2DriveWaitingOnOthers(), true);
});

t('DW-1e a BOT\'s own prompt does not — that one is the bot\'s to answer', function () {
  room();
  Game.state.pendingJumpOffer = { cardId: 1, seat: 'p3', _2v2ActingPlayer: 'p3' };
  eq('waiting', Game._2v2DriveWaitingOnOthers(), false);
});

t('DW-1f a resolution boundary holds the bot\'s clock', function () {
  var tt = room();
  tt._resolving = true;
  eq('waiting', Game._2v2DriveWaitingOnOthers(), true);
});

t('DW-2 a prompt cleared without a resume call still wakes the parked bot', function () {
  room();
  // A real clock for this case only: queue timers, run them by hand.
  var timers = [];
  var g = (function () { return this; })();
  var savedST = g.setTimeout, savedSync = Game._syncMode;
  g.setTimeout = function (fn) { timers.push(fn); return timers.length; };
  Game._syncMode = false;
  try {
    var woke = 0;
    Game.state.pendingJumpOffer = { cardId: 1, seat: 'p1', _2v2ActingPlayer: 'p1' };
    AI._parkUntilPromptsClear(function () { woke++; });
    eq('parked, not run', woke, 0);
    eq('continuation parked', Game.state._combatContStack.length, 1);
    // Something underneath it on the stack that must NOT be lost.
    // (Pushed first in real play; simulate by inserting at the bottom.)
    var below = 0;
    Game.state._combatContStack.unshift(function () { below++; });
    // Cleared down a path that never calls resumeCombatIfWaiting.
    Game.state.pendingJumpOffer = null;
    var n = 0;
    while (timers.length && n++ < 20) timers.shift()();
    eq('bot woke on its own', woke, 1);
    eq('its continuation was taken back off the stack', Game.state._combatContStack.length, 1);
    // The next real resume fires the continuation that was beneath it.
    Game.resumeCombatIfWaiting();
    eq('the continuation beneath still fires', below, 1);
    eq('bot did not wake twice', woke, 1);
  } finally {
    g.setTimeout = savedST; Game._syncMode = savedSync;
  }
});

__cases.forEach(function (c) {
  __caseFailed = false; __caseMsgs = [];
  try { c.fn(); } catch (e) { __caseFailed = true; __caseMsgs.push('threw: ' + (e && e.message || e)); }
  if (__caseFailed) { __failed++; __failures.push({ name: c.name, msgs: __caseMsgs.slice() }); }
  else __passed++;
});
print('ai-drive-wait2v2: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) { print('  - ' + f.name); f.msgs.forEach(function (m) { print('      ' + m); }); });
}
