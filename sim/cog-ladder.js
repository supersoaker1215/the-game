// ============================================================
// COG INVASION — the Cog that spawns is a function of TURN, not of VP.
//
//   jsc sim/cog-ladder.js
//
// Owner: "if the event happens on turn 0 a flunky or short change can spawn,
// on turn 3 a name dropper or bloodsucker, turn 6 a downsizer or money bags,
// and on 9 mingler or legal eagle, on turn 12+ a robber baron or big cheese.
// the same cog for each side."
//
// Before: every VP had exactly ONE Cog and sent that same 3-cost 4/6 body
// every three rounds from the moment it arrived, so the event opened at full
// strength and never escalated — and eight of the ten Cogs on the ladder did
// not exist as cards at all.
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

var SCHEDULE = [
  [0,  ['Flunky', 'Short Change']],
  [3,  ['Name Dropper', 'Bloodsucker']],
  [6,  ['Downsizer', 'Money Bags']],
  [9,  ['The Mingler', 'Legal Eagle']],
  [12, ['Robber Baron', 'The Big Cheese']],
];

t('CL-1 the ladder is the owner\'s schedule, rung for rung', function () {
  SCHEDULE.forEach(function (row) {
    var rung = Game._cogRungFor(row[0]);
    eq('turn ' + row[0], JSON.stringify(rung.cogs.slice().sort()), JSON.stringify(row[1].slice().sort()));
  });
});

t('CL-2 a rung holds until the next one, and 12+ tops out', function () {
  // Between rungs the previous one stands — the ladder steps, it does not
  // interpolate.
  eq('turn 1',  Game._cogRungFor(1).turn,  0);
  eq('turn 2',  Game._cogRungFor(2).turn,  0);
  eq('turn 5',  Game._cogRungFor(5).turn,  3);
  eq('turn 11', Game._cogRungFor(11).turn, 9);
  // "12+" — it must not wrap back to Flunky on a long event.
  eq('turn 12', Game._cogRungFor(12).turn, 12);
  eq('turn 30', Game._cogRungFor(30).turn, 12);
  eq('turn 99', Game._cogRungFor(99).turn, 12);
});

t('CL-3 THE SAME COG ON BOTH SIDES — one roll per wave, not one per side', function () {
  Game.init();
  var seen = [];
  var realSpawn = Game._cogSpawnOnSide;
  Game._cogSpawnOnSide = function (vp, round, side) { seen.push({ side: side, cog: vp.cog }); return null; };
  try {
    // Many waves across every rung: a per-side roll would diverge within a few.
    for (var r = 1; r <= 40; r++) {
      var vp = { key: 'vp', name: 'The V.P.', cog: null, firstRound: 1 };
      seen.length = 0;
      Game._cogSpawnCog(vp, r);
      eq('wave at round ' + r + ' hits both sides', seen.length, 2);
      eq('wave at round ' + r + ' sends one cog', seen[0].cog, seen[1].cog);
    }
  } finally { Game._cogSpawnOnSide = realSpawn; }
});

t('CL-4 the cog is picked from the rung the EVENT has reached', function () {
  Game.init();
  var realSpawn = Game._cogSpawnOnSide;
  Game._cogSpawnOnSide = function () { return null; };
  try {
    SCHEDULE.forEach(function (row) {
      var turn = row[0], allowed = row[1];
      // firstRound 1, so round = turn + 1 puts the event on `turn`.
      for (var i = 0; i < 12; i++) {
        var vp = { key: 'vp', name: 'The V.P.', cog: null, firstRound: 1 };
        Game._cogSpawnCog(vp, turn + 1);
        eq('turn ' + turn + ' sent ' + vp.cog, allowed.indexOf(vp.cog) >= 0, true);
      }
    });
  } finally { Game._cogSpawnOnSide = realSpawn; }
});

t('CL-5 all ten cogs are real, spawn-only cards', function () {
  SCHEDULE.forEach(function (row) {
    row[1].forEach(function (n) {
      var def = CARD_DEFS.filter(function (d) { return d.name === n; })[0];
      eq(n + ' exists', !!def, true);
      if (def) eq(n + ' is spawn-only', !!def._spawnOnly, true);
    });
  });
});

t('CL-6 the ladder escalates — a later rung is never weaker', function () {
  var prev = -1;
  SCHEDULE.forEach(function (row) {
    row[1].forEach(function (n) {
      var d = CARD_DEFS.filter(function (x) { return x.name === n; })[0];
      if (!d) return;
      var power = (d.attack | 0) + (d.health | 0);
      eq('rung ' + row[0] + ' (' + n + ') is not weaker than the rung below', power >= prev, true);
    });
    var lowest = Math.min.apply(null, row[1].map(function (n) {
      var d = CARD_DEFS.filter(function (x) { return x.name === n; })[0];
      return d ? (d.attack | 0) + (d.health | 0) : 0;
    }));
    prev = lowest;
  });
});

t('CL-7 a cog card does not claim its sender\'s protection', function () {
  // The protection keys on card._cogVP — WHICH VP SENT IT — so any VP can now
  // hand any Cog any protection. A card naming one VP was wrong in three cases
  // out of four (a Big Cheese sent by the C.J. gets +1 ATK per ally, not
  // Freeze immunity). The attack is the card's; the protection is the sender's.
  ['Mr. Hollywood', 'Robber Baron', 'Big Wig', 'The Big Cheese'].forEach(function (n) {
    var d = CARD_DEFS.filter(function (x) { return x.name === n; })[0];
    if (!d) { __caseFailed = true; __caseMsgs.push('missing ' + n); return; }
    eq(n + ' does not name a VP protection',
       /While The (V\.P\.|C\.F\.O\.|C\.J\.|Chairman) lives/.test(d.desc || ''), false);
  });
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
print('cog-ladder: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
