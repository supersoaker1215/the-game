// ============================================================
// A SEAT'S PURSE CAN NEVER BE NEGATIVE.
//
//   jsc sim/seat-purse.js
//
// 2v2 fuzz reported "negative energy p1 (8/9)" — a seat that had spent 9 of
// the 8 energy it owns. Caught in the act at 4000 games:
//
//   BRIDGE energy=8 used=9
//
// The seat<->side boundary had THREE writers and they disagreed: two derived a
// value with no floor, one clamped. That disagreement IS the defect, because
// an impossible seat state round-trips through the pair and amplifies:
//
//   read-back:  used     = energy - currency    (currency < 0  ->  used > energy)
//   bridge:     currency = energy - used        (used > energy ->  currency < 0)
//
// Neither line is wrong on its own. Together, once either number goes out of
// range, they keep it out of range forever.
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

t('SP-1 all three boundary writers clamp', function () {
  // The bridge and the side-sync both derive a team purse from a seat.
  eq('bridge floors at 0',    /_bridgePurse < 0[\s\S]{0,200}Math\.max\(0, _bridgePurse\)/.test(SRC), true);
  eq('side-sync floors at 0', /s\[side\]\.currency = Math\.max\(0, _p\)/.test(SRC), true);
  // The read-back derives a seat's spend from the team purse: bounded BOTH
  // ways — a seat cannot un-spend, and cannot have spent more than it owns.
  eq('read-back is bounded both ways',
     /ap\.usedEnergy = Math\.min\(ap\.energy \| 0, Math\.max\(0, _spent\)\)/.test(SRC), true);
});

t('SP-2 a clamp that fires SAYS so', function () {
  // A clamp with no report is a place bugs go to hide: it would have turned a
  // visible fuzz violation into a silent wrong number. Every one of the three
  // reports, so a real upstream cause arrives named.
  eq('the reporter exists', /_purseFault\(where, detail\)/.test(SRC), true);
  eq('bridge reports',    /_purseFault\('bridge'/.test(SRC), true);
  eq('read-back reports', /_purseFault\('read-back'/.test(SRC), true);
  eq('side-sync reports', /_purseFault\('side-sync'/.test(SRC), true);
  eq('and it is loud',    /\[BUG\] purse out of range/.test(SRC), true);
});

t('SP-3 the round trip cannot amplify an impossible state', function () {
  // The actual failure: feed the pair a seat that has over-spent and confirm
  // the numbers come back INSIDE their range instead of compounding.
  Game.init();
  Game.start2v2Match({ names: { p1: 'A1', p2: 'A2', p3: 'B1', p4: 'B2' } });
  var tt = Game.state.twoVTwo;
  var seat = tt.players.p1;
  var side = Game._2v2TeamSide[seat.team];
  seat.energy = 8;
  seat.usedEnergy = 9;            // the state the fuzz caught
  Game._2v2SyncActivePlayer();
  eq('the team purse is not negative', Game.state[side].currency >= 0, true);
  Game._2v2ReadBackActivePlayer('p1');
  eq('used never exceeds energy', seat.usedEnergy <= seat.energy, true);
  eq('and never goes below zero', seat.usedEnergy >= 0, true);
  eq('so the purse is sane', (seat.energy - seat.usedEnergy) >= 0, true);
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
