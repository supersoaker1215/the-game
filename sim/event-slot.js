// ============================================================
// ONE EVENT, THREE ROUNDS, NO OVERLAP.
//
//   jsc sim/event-slot.js
//
// Owner: "each event should only last 3 turns, same with enviroments, events
// shouldnt overlap, event 0,3,6,9,12 are all their own separate little movie,
// the shadowman needs to go into the event section on the right, same with MC,
// the events all follow the same path."
//
// Every event ALREADY gated on _eventInProgress() and retried next round,
// which is the right shape — but that guard is a MILLISECOND presentation lock
// (a few seconds while a reveal plays). It stopped two events colliding on
// screen and did nothing about two being ACTIVE across rounds. So Ballyhoo
// could land on top of a habitat still running, and an environment (4 rounds)
// outlived the 3-round window by one.
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
var SRC = read('game.js');
var UISRC = read('ui.js');

t('ES-1 an event is three rounds, and so is an environment', function () {
  eq('_EVENT_LEN', Game._EVENT_LEN, 3);
  // The environment used to run 4 and outlive the window by a round — which is
  // precisely the overlap the slot exists to remove.
  eq('ENV_TURNS matches the event length', Game.ENV_TURNS, Game._EVENT_LEN);
});

t('ES-2 a claimed slot blocks for exactly three rounds, then opens', function () {
  Game.init();
  Game._eventSlotClaim(3, 'MC Ballyhoo', 'boon');
  eq('round 3 held', !!Game._eventSlotFor(3), true);
  eq('round 4 held', !!Game._eventSlotFor(4), true);
  eq('round 5 held', !!Game._eventSlotFor(5), true);
  eq('round 6 open', Game._eventSlotFor(6), null);
  eq('round 9 open', Game._eventSlotFor(9), null);
});

t('ES-3 nothing else may start while the slot is held', function () {
  Game.init();
  Game._eventSlotClaim(6, 'The Shadow Man', 'modifier');
  eq('round 6', Game._eventSlotOpen(6), false);
  eq('round 7', Game._eventSlotOpen(7), false);
  eq('round 8', Game._eventSlotOpen(8), false);
  eq('round 9', Game._eventSlotOpen(9), true);
});

t('ES-4 the slot survives a missed round seam', function () {
  // Derived from the round rather than expired by a tick, so a seam that never
  // fires cannot strand the slot held forever (the Batman-lock lesson).
  Game.init();
  Game._eventSlotClaim(2, 'Wetlands', 'hazard');
  eq('a far later round is open', Game._eventSlotOpen(40), true);
});

t('ES-5 EVERY one-shot event goes through the same door', function () {
  // The point of "all events follow the same path": one gate, one claim.
  eq('Ballyhoo gates on the slot',  /if \(!this\._eventSlotOpen\(roundNow\)\) return;[\s\S]{0,120}b\.fired = true;/.test(SRC), true);
  eq('Ballyhoo claims it',          /_eventSlotClaim\(roundNow, 'MC Ballyhoo'/.test(SRC), true);
  eq('Shadow Man gates on the slot',/if \(!this\._eventSlotOpen\(r\)\) return;/.test(SRC), true);
  eq('Shadow Man claims it',        /_eventSlotClaim\(r, 'The Shadow Man'/.test(SRC), true);
  eq('a habitat gates on the slot', /a habitat waits its turn behind the live slot[\s\S]{0,200}_eventSlotOpen/.test(SRC), true);
  eq('a habitat claims it',         /_eventSlotClaim\(roundNow, name, 'hazard'\)/.test(SRC), true);
  // And the ms lock is no longer any event's overlap rule.
  eq('no event still gates on the millisecond lock alone',
     /(?:b\.fired|sh\.appeared|h\.fired)[\s\S]{0,80}if \(this\._eventInProgress\(\)\) return;/.test(SRC), false);
});

t('ES-6 a VP ARRIVAL claims a slot; its waves deliberately do not', function () {
  // A wave is the boss acting, not a new event starting. A VP sends one every
  // three rounds for as long as it lives, so claiming per wave would hold the
  // slot for the rest of the match and silently delete Ballyhoo, the Shadow Man
  // and every habitat from any game an invasion turned up in.
  eq('the arrival claims', /_eventSlotClaim\(round, vp\.name \+ ' arrives', 'boss'\)/.test(SRC), true);
  var spawn = SRC.slice(SRC.indexOf('_cogSpawnCog(vp, round) {'));
  spawn = spawn.slice(0, spawn.indexOf('\n  },'));
  eq('a wave does not claim', /_eventSlotClaim/.test(spawn), false);
});

t('ES-7 the rail reads the slot, so Ballyhoo and the Shadow Man have a row', function () {
  eq('the rail asks the slot', /Game\.eventSlotNow\(\)/.test(UISRC), true);
  eq('and pushes it as a row', /id: 'slot' \+ slot\.start \+ slot\.name/.test(UISRC), true);
  // It must read the ONE door, not each event's private state — that is what
  // keeps a new event type from needing its own rail branch.
  eq('it does not read ballyhoo state directly', /_eventRailModel[\s\S]{0,3000}s\._ballyhoo/.test(UISRC), false);
});

t('ES-8 eventSlotNow counts down and names the event', function () {
  Game.init();
  Game.state.round = 9;
  Game._eventSlotClaim(9, 'MC Ballyhoo', 'boon');
  var a = Game.eventSlotNow();
  eq('named', a && a.name, 'MC Ballyhoo');
  eq('3 left on the first round', a && a.left, 3);
  Game.state.round = 11;
  eq('1 left on the last', Game.eventSlotNow().left, 1);
  Game.state.round = 12;
  eq('gone on the next slot boundary', Game.eventSlotNow(), null);
});

// ---- run ----------------------------------------------------
__cases.forEach(function (c) {
  __caseFailed = false; __caseMsgs = [];
  try { c.fn(); } catch (e) {
    __caseFailed = true;
    __caseMsgs.push('threw: ' + (e && e.message ? e.message : String(e)));
  }
  if (__caseFailed) { __failed++; __failures.push({ name: c.name, msgs: __caseMsgs.slice(0, 4) }); }
  else __passed++;
});
print('event-slot: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
