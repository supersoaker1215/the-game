// ============================================================
// COG INVASION — ONE WAVE, ON THE RUNG FOR THE ROUND IT ROLLED ON.
//
//   jsc sim/cog-ladder.js
//
// Owner: "if the event happens on turn 0 a flunky or short change can spawn,
// on turn 3 a name dropper or bloodsucker, turn 6 a downsizer or money bags,
// and on 9 mingler or legal eagle, on turn 12+ a robber baron or big cheese.
// the same cog for each side."
//
// …and then, on seeing it in play: "for the toon town event stahs the VP 4
// bosses, thats not what i want ... i just wnat a random event on round
// 1,3,6,9,12,15 etc, the events only last 3 rounds after that the next event
// takes over very simple so for toontown if it rolls on round 6 only the cogs
// that i said on round 6 spawn the same cog one on each side ez peasy."
//
// So two rules, and this suite pins both:
//   1. The RUNG is a function of the MATCH ROUND. Not of which VP is out (the
//      original bug: every VP had one fixed 4/6 Cog, so the event opened at
//      full strength and never escalated) and not of the event's own clock
//      (the judgement call that was left open when the ladder went in).
//   2. The EVENT is one wave. The four-VP engine — persistent 10-HP bosses
//      arriving on a per-round roll, sending waves and draining 2 HP a side
//      for the rest of the match — no longer runs in a real match at all.
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

// THE OWNER'S SCHEDULE, as it stands after the round-3 merge. It was authored
// with a turn-0 rung (Flunky / Short Change) and a separate turn-3 one (Name
// Dropper / Bloodsucker) — but the event clock never reaches a round below 3,
// so the turn-0 rung was unreachable and those two cogs could not spawn at all.
// Owner: "have flunky short change in the round 3 rotation." One wide opening
// rung; nothing else moved.
var SCHEDULE = [
  [3,  ['Flunky', 'Short Change', 'Name Dropper', 'Bloodsucker']],
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
  // interpolate. Below round 3 it floors on the opening rung, which no
  // scheduled event can reach anyway.
  eq('turn 1',  Game._cogRungFor(1).turn,  3);
  eq('turn 2',  Game._cogRungFor(2).turn,  3);
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

t('CL-4 the rung is the MATCH ROUND, not the event\'s own clock', function () {
  // The open question when the ladder went in, now answered: "if it rolls on
  // round 6 only the cogs that i said on round 6 spawn." A VP that arrived on
  // round 20 used to send a FLUNKY, because its own clock read turn 0.
  Game.init();
  var realSpawn = Game._cogSpawnOnSide;
  Game._cogSpawnOnSide = function () { return null; };
  try {
    SCHEDULE.forEach(function (row) {
      var round = row[0], allowed = row[1];
      for (var i = 0; i < 12; i++) {
        // firstRound deliberately varied — it must make no difference at all.
        var vp = { key: 'vp', name: 'The V.P.', cog: null, firstRound: 1 + (i % 9) };
        Game._cogSpawnCog(vp, round);
        eq('round ' + round + ' sent ' + vp.cog, allowed.indexOf(vp.cog) >= 0, true);
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

t('CL-8 the rungs line up with the event schedule, round for round', function () {
  // The schedule is 3, 6, 9, 12, 15 … and the ladder is 0, 3, 6, 9, 12+. They
  // have to agree or "the cogs i said on round 6" is not what round 6 sends.
  eq('round 3 -> rung 3',   Game._cogRungFor(3).turn,  3);
  eq('round 6 -> rung 6',   Game._cogRungFor(6).turn,  6);
  eq('round 9 -> rung 9',   Game._cogRungFor(9).turn,  9);
  eq('round 12 -> rung 12', Game._cogRungFor(12).turn, 12);
  eq('round 15 tops out',   Game._cogRungFor(15).turn, 12);
  eq('every scheduled round is a rung',
     [3, 6, 9, 12, 15].every(function (r) { return Game._eventRoundDue(r); }), true);
});

t('CL-8b EVERY rung is reachable, and every cog can actually spawn', function () {
  // THIS TEST USED TO ASSERT THE OPPOSITE. The ladder was authored with a turn-0
  // rung and the clock starts at round 3, so Flunky and Short Change had no
  // round that could reach them — 0 hits in 3000 measured matches. It was
  // flagged rather than patched because the fix was a content decision; the
  // owner made it ("have flunky short change in the round 3 rotation"), and this
  // now guards the whole ladder against the same class of orphan.
  var reachable = {};
  for (var r = Game._EVENT_FIRST_ROUND; r <= 60; r++) {
    if (Game._eventRoundDue(r)) reachable[Game._cogRungFor(r).turn] = true;
  }
  Game._COG_LADDER.forEach(function (rung) {
    eq('rung ' + rung.turn + ' is on a scheduled round', !!reachable[rung.turn], true);
  });
  eq('the first rung is the first event round',
     Game._cogRungFor(Game._EVENT_FIRST_ROUND).turn, Game._COG_LADDER[0].turn);

  // And drive it: every one of the ten cogs comes out of a real wave.
  var seen = {};
  var realSpawn = Game._cogSpawnOnSide;
  Game._cogSpawnOnSide = function () { return null; };
  try {
    Game.init();
    for (var i = 0; i < 4000; i++) {
      var round = [3, 6, 9, 12, 15][i % 5];
      var vp = { key: null, name: 'Cog Invasion', cog: null };
      Game._cogSpawnCog(vp, round);
      seen[vp.cog] = (seen[vp.cog] || 0) + 1;
    }
  } finally { Game._cogSpawnOnSide = realSpawn; }
  SCHEDULE.forEach(function (row) {
    row[1].forEach(function (n) {
      eq(n + ' actually spawns (' + (seen[n] || 0) + ' of 4000)', (seen[n] || 0) > 0, true);
    });
  });
  eq('and nothing spawns that is not on the ladder',
     Object.keys(seen).every(function (n) {
       return SCHEDULE.some(function (row) { return row[1].indexOf(n) >= 0; });
     }), true);
});

t('CL-9 THE EVENT IS ONE WAVE — one Cog, one on each side, this round\'s rung', function () {
  // "if it rolls on round 6 only the cogs that i said on round 6 spawn the same
  // cog one on each side ez peasy." Driven on a real board, not through a stub.
  [[3, ['Flunky', 'Short Change', 'Name Dropper', 'Bloodsucker']],
   [6, ['Downsizer', 'Money Bags']],
   [9, ['The Mingler', 'Legal Eagle']],
   [12, ['Robber Baron', 'The Big Cheese']],
   [15, ['Robber Baron', 'The Big Cheese']]].forEach(function (row) {
    var round = row[0], allowed = row[1];
    Game.init();
    Game.state.round = round;
    Game.state._cogEvent = { shows: true, appearAt: round, fired: false };
    Game._maybeCogEvent(round);

    var mine = [], theirs = [];
    for (var i = 0; i < Game.LANE_COUNT; i++) {
      var l = Game.state.lanes[i];
      if (l.player && l.player._cogSpawnRound === round) mine.push(l.player.name);
      if (l.ai     && l.ai._cogSpawnRound === round)     theirs.push(l.ai.name);
    }
    eq('round ' + round + ': exactly one on the player side', mine.length, 1);
    eq('round ' + round + ': exactly one on the enemy side', theirs.length, 1);
    eq('round ' + round + ': the SAME cog on both', mine[0], theirs[0]);
    eq('round ' + round + ' sent ' + mine[0], allowed.indexOf(mine[0]) >= 0, true);
  });
});

t('CL-10 the event takes the slot, and starts no boss at all', function () {
  Game.init();
  Game.state.round = 6;
  Game.state._cogEvent = { shows: true, appearAt: 6, fired: false };
  Game._maybeCogEvent(6);
  var now = Game.eventSlotNow();
  eq('it claimed the slot', now && now.name, 'Cog Invasion');
  eq('for the usual three rounds', now && now.left, Game._EVENT_LEN);
  // THE POINT OF THE WHOLE CHANGE. "it starts the VP 4 bosses, thats not what
  // i want" — the event must not touch the VP engine's state.
  eq('no VP engine was started', !!Game.state._cog, false);
  // …and it is spent. One wave, not a subscription.
  eq('the wave is fired', Game.state._cogEvent.fired, true);
  Game._maybeCogEvent(7);
  Game._maybeCogEvent(8);
  var cogs = 0;
  for (var i = 0; i < Game.LANE_COUNT; i++) {
    if (Game.state.lanes[i].player && Game.state.lanes[i].player._cogSpawnRound != null) cogs++;
  }
  eq('and no second wave follows it', cogs, 1);
});

t('CL-11 a real match never starts the four-VP engine', function () {
  eq('_COG_ALL_GAMES is off', Game._COG_ALL_GAMES, false);
  Game.init();
  eq('off by default', Game._cogEnabled(), false);
  // Rolling the EVENT must not switch the engine back on — that test used to
  // live in _cogEnabled and would have quietly restarted everything.
  Game.state._matchEventName = 'Cog Invasion';
  Game.state._matchEvent = 'coginvasion';
  eq('and rolling the event does not', Game._cogEnabled(), false);
  // The dev door still works.
  Game.state._cogForce = true;
  eq('_cogForce still opens it', Game._cogEnabled(), true);
});

t('CL-12 Cog Invasion is a rollable event like any other', function () {
  eq('it is in the pool', Game.matchEventPool().indexOf('Cog Invasion') >= 0, true);
  // And the draw dispatches it to the wave, not to the habitat branch — a
  // habitat would try to place an ENVIRONMENT named "Cog Invasion", which does
  // not exist, and the event would silently do nothing.
  Game.init();
  Game.state.round = 6;
  Game.state._eventRounds = {};
  Game.state._eventsUsed = Game.matchEventPool().filter(function (n) { return n !== 'Cog Invasion'; });
  Game._maybeMatchEvent(6);
  eq('the draw landed on Cog Invasion', Game.state._eventRounds[6], 'Cog Invasion');
  eq('and it scheduled a wave', !!(Game.state._cogEvent && Game.state._cogEvent.shows), true);
  eq('for this round', Game.state._cogEvent.appearAt, 6);
  eq('and NOT a habitat', (Game.state._habitats || []).length, 0);
});

t('CL-13 a Cog from the event carries no boss protection', function () {
  // The protections key on card._cogVP — WHICH VP SENT IT. There is no VP now,
  // so a Cog from the event is exactly its printed card and nothing more.
  Game.init();
  Game.state.round = 9;
  Game.state._cogEvent = { shows: true, appearAt: 9, fired: false };
  Game._maybeCogEvent(9);
  for (var i = 0; i < Game.LANE_COUNT; i++) {
    ['player', 'ai'].forEach(function (side) {
      var c = Game.state.lanes[i][side];
      if (!c || c._cogSpawnRound == null) return;
      eq(c.name + ' names no sender', !c._cogVP, true);
      eq(c.name + ' blocks no damage', Game._cogBlocksDamage(c), false);
      eq(c.name + ' resists no freeze', Game._cogResistsFreeze(c), false);
    });
  }
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
