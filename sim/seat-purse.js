// ============================================================
// A SEAT'S PURSE CAN NEVER BE NEGATIVE.
//
//   jsc sim/seat-purse.js
//
// The seat<->side boundary has three writers: the active-seat bridge
// (_2v2SyncActivePlayer), the read-back (_2v2ReadBackActivePlayer) and the
// jumper bridge (_2v2WithJumperBridge). Two derive a value by subtraction:
//
//   read-back:  used     = energy - currency    (currency < 0  ->  used > energy)
//   bridge:     currency = energy - used        (used > energy ->  currency < 0)
//
// Neither line is wrong on its own; together, once either number leaves its
// range, they keep it out forever. So every writer clamps, and every clamp
// that fires reports itself through _purseFault so the upstream cause arrives
// named instead of hidden. Each check below feeds a writer an out-of-range
// seat and watches what comes back and what was reported.
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

// A fresh 2v2 match with the active seat's team side, and a spy on every
// clamp report and every log line.
var FAULTS, LOGS;
function match() {
  Game.init();
  Game.start2v2Match({ names: { p1: 'A1', p2: 'A2', p3: 'B1', p4: 'B2' } });
  var tt = Game.state.twoVTwo;
  var key = Game._2v2ActivePlayer();
  var seat = tt.players[key];
  FAULTS = []; LOGS = [];
  var realFault = Game._purseFault;
  Game._purseFault = function (where, detail) { FAULTS.push(where); return realFault.call(this, where, detail); };
  var realLog = Game.log;
  Game.log = function (m) { LOGS.push(String(m)); return realLog.apply(this, arguments); };
  return { tt: tt, key: key, seat: seat, side: Game._2v2TeamSide[seat.team],
           restore: function () { Game._purseFault = realFault; Game.log = realLog; } };
}

t('SP-1 the bridge floors the team purse at 0 and reports it', function () {
  var m = match();
  m.seat.energy = 8; m.seat.usedEnergy = 9;            // the state the fuzz caught
  Game._2v2SyncActivePlayer();
  eq('team purse', Game.state[m.side].currency, 0);
  eq('reported as the bridge', FAULTS.join(','), 'bridge');
  m.restore();
});

t('SP-2 an in-range bridge is exact and silent', function () {
  var m = match();
  m.seat.energy = 8; m.seat.usedEnergy = 3;
  Game._2v2SyncActivePlayer();
  eq('team purse', Game.state[m.side].currency, 5);
  eq('no fault', FAULTS.length, 0);
  m.restore();
});

t('SP-3 the read-back is bounded both ways and reports either breach', function () {
  var m = match();
  m.seat.energy = 8; m.seat.usedEnergy = 0;
  Game._2v2SyncActivePlayer();
  Game.state[m.side].currency = -3;                    // would read back used = 11
  Game._2v2ReadBackActivePlayer(m.key);
  eq('used capped at energy', m.seat.usedEnergy, 8);
  eq('reported (over-spend)', FAULTS.join(','), 'read-back');

  FAULTS.length = 0;
  Game._2v2SyncActivePlayer();
  Game.state[m.side].currency = 20;                    // would read back used = -12
  Game._2v2ReadBackActivePlayer(m.key);
  eq('a seat cannot un-spend', m.seat.usedEnergy, 0);
  eq('reported (un-spend)', FAULTS.join(','), 'read-back');

  FAULTS.length = 0;
  Game._2v2SyncActivePlayer();
  Game.state[m.side].currency = 6;
  Game._2v2ReadBackActivePlayer(m.key);
  eq('an in-range read-back is exact', m.seat.usedEnergy, 2);
  eq('and silent', FAULTS.length, 0);
  m.restore();
});

t('SP-4 the jumper bridge floors the purse it installs and reports it', function () {
  var m = match();
  var seen = null;
  m.seat.energy = 4; m.seat.usedEnergy = 7;
  Game._2v2WithJumperBridge(m.key, function () { seen = Game.state[m.side].currency; });
  eq('purse inside the bridge', seen, 0);
  eq('reported as side-sync', FAULTS.join(','), 'side-sync');
  m.restore();
});

t('SP-5 a clamp that fires says so, loudly, in the log', function () {
  var m = match();
  m.seat.energy = 8; m.seat.usedEnergy = 9;
  Game._2v2SyncActivePlayer();
  eq('a [BUG] line names the writer', LOGS.some(function (l) {
    return l.indexOf('[BUG] purse out of range') >= 0 && l.indexOf('bridge') >= 0;
  }), true);
  m.restore();
});

t('SP-6 the round trip cannot amplify an impossible state', function () {
  var m = match();
  m.seat.energy = 8; m.seat.usedEnergy = 9;
  Game._2v2SyncActivePlayer();
  eq('the team purse is not negative', Game.state[m.side].currency >= 0, true);
  Game._2v2ReadBackActivePlayer(m.key);
  eq('used never exceeds energy', m.seat.usedEnergy <= m.seat.energy, true);
  eq('and never goes below zero', m.seat.usedEnergy >= 0, true);
  m.restore();
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
print('seat-purse: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
