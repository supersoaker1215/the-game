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
  eq('Cog Invasion gates on the slot', /if \(!this\._eventSlotOpen\(r\)\) return;\s*\n\s*ev\.fired = true;/.test(SRC), true);
  eq('Cog Invasion claims it',      /_eventSlotClaim\(r, 'Cog Invasion', 'hazard'\)/.test(SRC), true);
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

t('ES-9 up next names what is queued and counts down to it', function () {
  Game.init();
  Game.state.round = 3;
  Game._eventSlotClaim(3, 'MC Ballyhoo', 'boon');
  Game.state._shadow = { shows: true, appeared: false, appearAt: 5 };
  var seen = [];
  for (var r = 3; r <= 6; r++) {
    Game.state.round = r;
    var n = Game.eventUpNext();
    seen.push(n.name + ':' + n.inRounds);
  }
  // Due on 5, but the slot is held until 6 — so the countdown is to when it can
  // ACTUALLY start, not to when it was drawn. A timer that promised round 5 and
  // then did nothing would be worse than no timer.
  eq('countdown', seen.join(' '), 'The Shadow Man:3 The Shadow Man:2 The Shadow Man:1 The Shadow Man:0');
});

t('ES-10 with nothing drawn it says WHEN, not WHAT', function () {
  Game.init();
  Game.state.round = 4;
  Game.state._ballyhoo = null; Game.state._shadow = null; Game.state._habitats = [];
  var n = Game.eventUpNext();
  // The draw has not happened. Naming an event here would be inventing a
  // prediction the game has not made; the round the clock is due is real.
  eq('unnamed', n.name, null);
  eq('but a real round', n.inRounds > 0, true);
});

t('ES-11 a Cog VP arrival is never predicted', function () {
  // It is a 12.5% roll every round — there is no round on which it is "due",
  // so there is no honest countdown to it.
  var src = read('game.js');
  var fn = src.slice(src.indexOf('eventUpNext() {'));
  fn = fn.slice(0, fn.indexOf('\n  },'));
  eq('_cog is not consulted', /_cog\b/.test(fn), false);
});

t('ES-12 the rail keeps the row at zero — the seam', function () {
  // At inRounds 0 the event is due but has not claimed the slot yet. Dropping
  // the row there made it vanish for exactly the moment it was arriving.
  var ui = read('ui.js');
  eq('rendered at zero', /if \(upNext && upNext\.inRounds >= 0\)/.test(ui), true);
  eq('and reads "now"', /upNext\.inRounds > 0 \? 'in ' \+ upNext\.inRounds : 'now'/.test(ui), true);
});

t('ES-13 rail rows are reused, or nothing can transition', function () {
  var ui = read('ui.js');
  // innerHTML on the whole rail replaces every node, and a brand-new element
  // has nothing to transition FROM — the promotion would pop.
  eq('rows are keyed', /data-ev-id/.test(ui), true);
  eq('and reused rather than rebuilt', /if \(el\.dataset\.h !== def\.html\)/.test(ui), true);
  // The entrance must land at CREATION only, never on a re-render.
  eq('entrance is one-shot', /el\.classList\.add\('is-arriving'\)/.test(ui), true);
});

t('ES-14 the schedule is the hand-off — 3, 6, 9, 12, 15', function () {
  // Owner: "no round 1 event 3,6,9,12,15 etc, the events only last 3 rounds
  // after that the next event takes over."
  var due = [];
  for (var r = 1; r <= 20; r++) if (Game._eventRoundDue(r)) due.push(r);
  eq('the clock', due.join(','), '3,6,9,12,15,18');
  eq('nothing in the opening', Game._eventRoundDue(1) || Game._eventRoundDue(2), false);

  // On the uniform beat the two limits are the same number, so the cap is
  // invisible in a normal match…
  [3, 6, 9, 12, 15].forEach(function (r) {
    eq('round ' + r + ' gets its full three', Game._eventSlotEndsAt(r) - r, Game._EVENT_LEN);
  });
  // …and earns its keep on an OFF-BEAT claim. An event blocked on its own round
  // and claiming late must not push the next one along with it, or the schedule
  // drifts a slot to the right and stays there for the rest of the match.
  Game.init();
  Game._eventSlotClaim(7, 'A Late Claim', 'hazard');
  eq('round 8 still held',   !!Game._eventSlotFor(8), true);
  eq('round 9 hands over',   Game._eventSlotFor(9), null);
  eq('so round 9 is on time', Game._eventSlotOpen(9), true);
});

t('ES-15 the countdown reads the same end the slot does', function () {
  // A late claim that still printed "3" would count down to a row that vanished
  // a round early — the rail's hand-off would read as a glitch.
  Game.init();
  Game.state.round = 6;
  Game._eventSlotClaim(6, 'A Normal Event', 'hazard');
  eq('a normal event reads three', Game.eventSlotNow().max, Game._EVENT_LEN);
  eq('and counts down', Game.eventSlotNow().left, Game._EVENT_LEN);
  Game.state.round = 8;
  eq('one left on the last round', Game.eventSlotNow().left, 1);
  Game.state.round = 9;
  eq('and it is gone when the next is due', Game.eventSlotNow(), null);

  Game.init();
  Game.state.round = 7;
  Game._eventSlotClaim(7, 'A Late Claim', 'hazard');
  var a = Game.eventSlotNow();
  eq('a late claim says the truth, not three', a && a.max, 2);
  eq('and left agrees', a && a.left, 2);
});

t('ES-19 an event drawn but never SHOWN goes back in the pool', function () {
  // "events cant be done twice in the same game" is about SHOWINGS. Every draw
  // is written into _eventsUsed, so an event whose window closed without ever
  // finding an opening was marked used and silently deleted from the match —
  // zero showings, and never drawable again. It also skews a draw the owner
  // asked to be flat.
  Game.init();
  Game.state._eventsUsed = ['MC Ballyhoo'];
  Game.state._ballyhoo = { shows: true, appearAt: 3, fired: false };

  Game._reclaimUnshownEvents(5);                       // still inside its window
  eq('inside the window it is left alone', Game.state._eventsUsed.join(','), 'MC Ballyhoo');
  eq('and still pending', !!Game.state._ballyhoo, true);

  Game._reclaimUnshownEvents(6);                       // round 6 takes over
  eq('it is back in the pool', Game.state._eventsUsed.length, 0);
  eq('and no longer pending', !!Game.state._ballyhoo, false);

  // An event that DID show is never reclaimed — that would be a second showing.
  Game.init();
  Game.state._eventsUsed = ['MC Ballyhoo'];
  Game.state._ballyhoo = { shows: true, appearAt: 3, fired: true };
  Game._reclaimUnshownEvents(12);
  eq('a shown event stays used', Game.state._eventsUsed.join(','), 'MC Ballyhoo');
});

t('ES-16 an event that never found an opening is SPENT, not queued', function () {
  // Every runner retried next round when the slot was busy, which is right —
  // but it had no far end, so a round-6 event blocked by three later draws
  // surfaced on round 13 still calling itself round 6's. The window closes when
  // the next scheduled event comes round.
  eq('round 6 may start on 6, 7 and 8',
     [6, 7, 8].every(function (r) { return Game._eventWindowOpen(6, r); }), true);
  eq('but not on 9',  Game._eventWindowOpen(6, 9),  false);
  eq('nor on 13',     Game._eventWindowOpen(6, 13), false);
  eq('and never before its own round', Game._eventWindowOpen(6, 5), false);
  // The NEAR end is clamped to the clock's floor, so "no round 1 event" holds
  // at this one door however an appearAt got set — a stale schedule, a legacy
  // roller's default, a caller with its own idea of the opening.
  eq('nothing may start on round 1', Game._eventWindowOpen(1, 1), false);
  eq('nor on round 2',               Game._eventWindowOpen(1, 2), false);
  eq('an early appearAt is pulled up to round 3', Game._eventWindowOpen(1, 3), true);
  eq('and still ends with round 3\'s window',      Game._eventWindowOpen(1, 6), false);
  // EVERY runner asks — a single one keeping its own arithmetic is how the
  // Ballyhoo round-3 floor survived the schedule going in.
  ['b\\.appearAt', 'sh\\.appearAt', 'h\\.appearAt', 'ev\\.appearAt'].forEach(function (a) {
    eq(a + ' goes through _eventWindowOpen',
       new RegExp('_eventWindowOpen\\([^)]*' + a).test(SRC), true);
  });
});

t('ES-17 Cog Invasion is an event in the slot, not a match-long engine', function () {
  // Owner: "for the toon town event stahs the VP 4 bosses, thats not what i
  // want." The VP engine claimed the slot on ARRIVAL and then ran underneath
  // every later event for the rest of the match. The event does not.
  eq('the VP engine is off for real matches', Game._COG_ALL_GAMES, false);
  Game.init();
  Game.state.round = 9;
  Game.state._cogEvent = { shows: true, appearAt: 9, fired: false };
  Game._maybeCogEvent(9);
  eq('it is in the slot', Game.eventSlotNow().name, 'Cog Invasion');
  eq('for three rounds', Game.eventSlotNow().max, Game._EVENT_LEN);
  eq('and round 12 hands over', Game._eventSlotOpen(12), true);
});

t('ES-18 a drawn Cog Invasion is named in up-next, like the others', function () {
  // It is DRAWN on a known round now, so there is an honest countdown to it —
  // which is exactly what a VP arrival never had (see ES-11).
  Game.init();
  Game.state.round = 4;
  Game.state._cogEvent = { shows: true, appearAt: 6, fired: false };
  var up = Game.eventUpNext();
  eq('named', up && up.name, 'Cog Invasion');
  eq('on its round', up && up.at, 6);
  eq('counting down', up && up.inRounds, 2);
});

// ---- run ----------------------------------------------------
// ============================================================
// ES-QUIET — THE CLOCK KEPT TICKING AND NOTHING EVER CAME
// ------------------------------------------------------------
// Owner: "the evenst didnt go off on round 12, 15 etc, tehre were a lot that
// could roll, jaws, jurrasc park, it, feddy and it never happened."
//
// Two causes stacked, and each alone was enough:
//
//   1. matchEventPool() carried a three-name allow-list, and _drawEventFor
//      shows each event at most once per match. Three events fill exactly three
//      due rounds — 3, 6, 9 — and every due round after that drew from an empty
//      pool. Measured over 24 seeded matches to round 30: 168 of 240 due rounds
//      (70%) held no event at all, and only 3 distinct events ever appeared.
//
//   2. A habitat seats an environment on two lanes and NOTHING took them away.
//      They accumulate 2, 4, 6 — and landing needs two lanes clear of
//      environments, so the fourth habitat could never place. Traced in a
//      seeded match: Gargantua r6, Wetlands r9, Open Water r12, then all six
//      lanes occupied; rounds 18 and 21 drew Boiler Room and Jigsaw and had
//      nowhere to put them. The draw was working the whole time.
//
// After both: 0 of 240 due rounds empty, 11 distinct events, at most 2 lanes
// carrying an environment at once.
function esRunMatch(seed, maxR) {
  Game.init();
  if (Game.setSeed) Game.setSeed(seed);
  Game.startMatch('classic');
  Game.state.player.isHuman = false;
  Game.state.ai.isHuman = false;
  var out = { dueEmpty: 0, dueTotal: 0, maxEnv: 0, held: {} };
  for (var r = 1; r <= maxR; r++) {
    Game.state.round = r;
    Game.startRound();
    var n = 0;
    Game.state.lanes.forEach(function (l) { if (l && l._env && (l._env.player || l._env.ai)) n++; });
    if (n > out.maxEnv) out.maxEnv = n;
    if (Game._eventRoundDue(r)) {
      out.dueTotal++;
      var sl = Game.state._eventSlot;
      var holding = (sl && Game._eventSlotFor(r)) ? sl.name : null;
      if (holding) out.held[holding] = 1; else out.dueEmpty++;
    }
  }
  return out;
}

t('ES-Q1 every event in the registry can actually roll', function () {
  var pool = Game.matchEventPool();
  var all = [];
  var FR = (typeof EVENT_FRANCHISES !== 'undefined') ? EVENT_FRANCHISES : [];
  FR.forEach(function (fr) { (fr.events || []).forEach(function (ev) { if (ev && ev.name) all.push(ev.name); }); });
  eq('the registry is not empty', all.length > 0, true);
  // The four the owner named by franchise: Jaws, Jurassic Park, IT, Freddy.
  ['Open Water', 'Wetlands', 'Sewers', 'Boiler Room'].forEach(function (n) {
    eq(n + ' can roll', pool.indexOf(n) >= 0, true);
  });
  eq('nothing is withheld from the draw', pool.length, all.length);
});

t('ES-Q2 a long match has an event on every due round', function () {
  var bad = [];
  for (var seed = 1; seed <= 6; seed++) {
    var r = esRunMatch(seed * 7919, 24);
    if (r.dueEmpty > 0) bad.push('seed' + seed + ': ' + r.dueEmpty + '/' + r.dueTotal + ' due rounds empty');
  }
  eq('no due round comes up empty', bad.join(' | '), '');
});

t('ES-Q3 an event\'s environments leave with the event', function () {
  var worst = 0;
  for (var seed = 1; seed <= 6; seed++) {
    var r = esRunMatch(seed * 104729, 24);
    if (r.maxEnv > worst) worst = r.maxEnv;
  }
  // One habitat seats TWO. Anything above that is last event's lanes never
  // being given back, which is what filled the board and stopped the rest.
  //
  // NOTE: this one PASSES against the pre-fix commit, and vacuously — with the
  // allow-list in place no habitat could roll, so no lane ever held an
  // environment and the worst case was 0. The two faults are stacked: lifting
  // the allow-list is what makes the silting reachable at all. Kept because it
  // is the guard that matters from here on, not because it demonstrates the
  // bug — ES-Q2 and the 168/240 measurement do that.
  eq('at most one habitat\'s worth of lanes at a time', worst <= 2, true);
});

t('ES-Q4 the sweep runs in BOTH modes, before the habitat looks for room', function () {
  // A habitat due the very round its predecessor expires must find the lanes
  // already clear, or it waits a round for nothing.
  var calls = SRC.match(/_expireEventEnvironments\(/g) || [];
  eq('called from 1v1 and 2v2 round starts, plus its own definition',
     calls.length >= 3, true);
  eq('1v1 clears before the runner',
     /_expireEventEnvironments\(this\.state\.round\);\s*\n\s*this\._maybeHabitatEvent\(this\.state\.round\)/.test(SRC), true);
  eq('2v2 clears before the runner',
     /_expireEventEnvironments\(tt\.round\);\s*\n\s*this\._maybeHabitatEvent\(tt\.round\)/.test(SRC), true);
});

t('ES-Q5 the rail does not promise an event that cannot come', function () {
  // The clock is a schedule, not a promise. With the registry spent there is
  // no next event, and counting down to one is a lie the player can see.
  Game.init();
  Game.state.mode = { deck: 'classic', players: '1v1' };
  Game.state.round = 12;
  Game.state._eventsUsed = Game.matchEventPool().slice();   // everything shown
  eq('nothing is claimed as coming', Game.eventUpNext(), null);
  // ...and with something still undrawn it DOES answer.
  Game.state._eventsUsed = [];
  var un = Game.eventUpNext();
  eq('an honest countdown survives', !!un, true);
});

// ============================================================
// ES-N — THE RAIL NAMES WHAT IS COMING
// ------------------------------------------------------------
// Owner: "now the next event should show the name of the upcomng event."
//
// It could not before, and honestly so: the draw happened ON the due round, so
// until then there was no answer and the row said "Next event". One event is
// drawn a round ahead now, which turns "something is due in 2" into "Wetlands
// is due in 2" — the same uniform pull from the same pool, resolved sooner.
//
// The thing that can go wrong is the rail promising one event and the board
// opening another, so that is what these check: not that a name appears, but
// that the name is KEPT.
t('ES-N1 the rail names the next event instead of saying "Next event"', function () {
  Game.init();
  if (Game.setSeed) Game.setSeed(4242);
  Game.startMatch('classic');
  Game.state.player.isHuman = false; Game.state.ai.isHuman = false;
  Game.state.round = 1;
  Game.startRound();
  var un = Game.eventUpNext();
  eq('there is an answer', !!un, true);
  eq('and it has a name', !!(un && un.name), true);
  eq('drawn and held on deck', !!(Game.state._eventNextUp && Game.state._eventNextUp.name), true);
});

t('ES-N2 the name it promises is the name that lands', function () {
  var checked = 0, broken = [];
  for (var seed = 1; seed <= 6; seed++) {
    Game.init();
    if (Game.setSeed) Game.setSeed(seed * 31337);
    Game.startMatch('classic');
    Game.state.player.isHuman = false; Game.state.ai.isHuman = false;
    var promises = [], landed = {};
    for (var r = 1; r <= 24; r++) {
      Game.state.round = r;
      Game.startRound();
      var now = Game.state.round | 0;
      var un = null; try { un = Game.eventUpNext(); } catch (e) {}
      if (un && un.name && un.at > now) promises.push({ at: un.at, name: un.name });
      var sl = Game.state._eventSlot;
      if (sl && Game._eventSlotFor(now)) landed[sl.start] = sl.name;
    }
    promises.forEach(function (pr) {
      if (landed[pr.at] == null) return;            // match ended before it landed
      checked++;
      if (landed[pr.at] !== pr.name) {
        broken.push('said "' + pr.name + '" for round ' + pr.at + ', got "' + landed[pr.at] + '"');
      }
    });
  }
  eq('some promises were actually testable', checked > 40, true);
  eq('every named promise landed as named', broken.slice(0, 4).join(' | '), '');
});

t('ES-N3 Jigsaw\'s room is decided once, not announced and then re-rolled', function () {
  // _habitatPlacement consumes RNG for Jigsaw (The Bathroom / Game Over). Roll
  // it at announce AND again at landing and the rail says one room while the
  // board opens the other — a mismatch no amount of correct scheduling fixes.
  Game.init();
  Game.state.mode = { deck: 'classic', players: '1v1' };
  Game.state._eventsUsed = Game.matchEventPool().filter(function (n) { return n !== 'Jigsaw'; });
  Game.state.round = 1;
  Game._ensureNextEventDrawn();
  var deck = Game.state._eventNextUp;
  eq('Jigsaw is on deck', !!deck && deck.name, 'Jigsaw');
  eq('and its room is already chosen', ['The Bathroom', 'Game Over'].indexOf(deck.place) >= 0, true);
  var announced = deck.place;
  eq('the rail announces the room, not the card', Game.eventUpNext().name, announced);
  Game.state.round = 3;
  Game._maybeMatchEvent(3);
  var h = (Game.state._habitats || []).filter(function (x) { return x && x.name === 'Jigsaw'; })[0];
  eq('the habitat was queued', !!h, true);
  eq('with the SAME room that was announced', h && h.place, announced);
});

t('ES-N4 a habitat is announced by its place, the set pieces by their own names', function () {
  // The up-next row and the live row must say the same words — the hand-off is
  // a promotion, not a rename.
  eq('Shadow Man',   Game._eventLabelFor('Shadow Man', null),  'The Shadow Man');
  eq('MC Ballyhoo',  Game._eventLabelFor('MC Ballyhoo', null), 'MC Ballyhoo');
  eq('Cog Invasion', Game._eventLabelFor('Cog Invasion', null),'Cog Invasion');
  eq('a habitat',    Game._eventLabelFor('Jigsaw', 'Game Over'), 'Game Over');
  // …and the kinds match the slot each one claims, so the tick colour does not
  // change when the row is promoted.
  eq('shadow kind',  Game._eventKindFor('Shadow Man'),  'modifier');
  eq('ballyhoo kind',Game._eventKindFor('MC Ballyhoo'), 'boon');
  eq('cog kind',     Game._eventKindFor('Cog Invasion'),'hazard');
  eq('habitat kind', Game._eventKindFor('Open Water'),  'hazard');
});


// ============================================================
// ONE LANE, ONE ENVIRONMENT (2026-09-13)
// A _ONE_LANE_EVENTS habitat seats BOTH sides of a single lane, and every
// surface downstream read that as two environments sharing a lane: the lane
// backdrop painted the black hole twice (one `cover` crop per half, each masked
// to nothing at the midline, so a seam ran through the middle of a single
// hole), and the status row printed two identical countdown pips for one clock.
// Owner: "gargantua can cover the whoe lane like before just onw pircture."
// The fact lives on the INSTANCE, stamped at the seat, so the renderers read it
// instead of each re-deriving it from the card's name.
// ============================================================

t('ES-FL1 a one-lane event stamps both of its seats; an ordinary habitat stamps neither', function () {
  Game.init();
  Game.state.lanes.forEach(function (l) { l._env = null; });
  Game._placeEventEnvironment('player', 0, 'Gargantua');
  Game._placeEventEnvironment('ai', 0, 'Gargantua', { keepOpposite: true });
  var g = Game.state.lanes[0]._env;
  eq('both sides seated', !!(g && g.player && g.ai), true);
  eq('player seat is full-lane', !!(g.player && g.player._fullLane), true);
  eq('ai seat is full-lane',     !!(g.ai && g.ai._fullLane), true);
  // …and the ordinary case is untouched: two lanes, one side each, no flag, so
  // they keep their halves and their two side-coloured clocks.
  Game._placeEventEnvironment('ai', 2, 'Boiler Room');
  Game._placeEventEnvironment('player', 2, 'Sewers', { keepOpposite: true });
  var two = Game.state.lanes[2]._env;
  eq('boiler room is not full-lane', !!(two.ai && two.ai._fullLane), false);
  eq('sewers is not full-lane',      !!(two.player && two.player._fullLane), false);
});

t('ES-FL2 nothing can seat a one-lane event except this path', function () {
  // The flag is stamped in _placeEventEnvironment only. That is safe precisely
  // because a one-lane event is _spawnOnly — it is out of the draw pile, the
  // draft pool and the summon deck, so no other route can produce an instance
  // that is missing the flag and would paint two pictures again.
  var defs = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS : [];
  Object.keys(Game._ONE_LANE_EVENTS).forEach(function (name) {
    var d = null;
    for (var i = 0; i < defs.length; i++) if (defs[i].name === name) { d = defs[i]; break; }
    eq(name + ' has a definition', !!d, true);
    eq(name + ' is spawn-only', !!(d && d._spawnOnly), true);
  });
});

t('ES-FL3 the lane renderer reads the flag, not the card name', function () {
  // The sim has no DOM, so this asserts the SHIPPED source: the half-picker
  // branches on the instance flag and paints one full-lane box, the countdown
  // loop drops the duplicate, and the art builder frames a full-lane
  // environment for the lane instead of for a card face.
  var half = UISRC.slice(UISRC.indexOf('const paintHalf = (where, env)'));
  half = half.slice(0, half.indexOf("paintHalf('bottom'") + 140);
  eq('half-picker branches on the flag', half.indexOf('_fullLane') !== -1, true);
  eq('a full-lane box is painted',       half.indexOf("paintHalf('full'") !== -1, true);

  var pip = UISRC.slice(UISRC.indexOf("['ai', 'player'].forEach(side => {"));
  pip = pip.slice(0, pip.indexOf('glyph-env') + 200);
  eq('one clock per full-lane environment', pip.indexOf('_fullLane') !== -1, true);

  var art = UISRC.slice(UISRC.indexOf('_envArtBackground(env) {'));
  art = art.slice(0, art.indexOf('no-repeat`'));
  eq('a full-lane environment is framed for the lane',
     art.indexOf("env._fullLane ? 'cover'") !== -1, true);
});

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
