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

t('ES-14 the schedule is the hand-off — 1, 3, 6, 9, 12, 15', function () {
  // Owner: "i just wnat a random event on round 1,3,6,9,12,15 etc, the events
  // only last 3 rounds after that the next event takes over."
  var due = [];
  for (var r = 1; r <= 20; r++) if (Game._eventRoundDue(r)) due.push(r);
  eq('the clock', due.join(','), '1,3,6,9,12,15,18');

  // THE ROUND-1 OPENER IS THE ONE SHORT WINDOW, and it must not push round 3.
  // Before the hand-off cap, an event claimed on round 1 held 1-3 and round 3's
  // event slid to round 4 — and every event after it stayed a slot behind for
  // the whole match.
  Game.init();
  Game._eventSlotClaim(1, 'The Opener', 'boon');
  eq('round 1 held', !!Game._eventSlotFor(1), true);
  eq('round 2 held', !!Game._eventSlotFor(2), true);
  eq('round 3 hands over', Game._eventSlotFor(3), null);
  eq('so round 3 can start on time', Game._eventSlotOpen(3), true);

  // On the 3/6/9/12 beat the two limits are the same number, so nothing else
  // is shortened.
  [3, 6, 9, 12, 15].forEach(function (r) {
    eq('round ' + r + ' gets its full three', Game._eventSlotEndsAt(r) - r, Game._EVENT_LEN);
  });
});

t('ES-15 the countdown reads the same end the slot does', function () {
  // A shortened opener that still printed "3" would count down to a row that
  // vanished a round early — the rail's hand-off would read as a glitch.
  Game.init();
  Game.state.round = 1;
  Game._eventSlotClaim(1, 'The Opener', 'boon');
  var a = Game.eventSlotNow();
  eq('max is the real length', a && a.max, 2);
  eq('and left agrees on round 1', a && a.left, 2);
  Game.state.round = 2;
  eq('and on round 2', Game.eventSlotNow().left, 1);
  Game.state.round = 3;
  eq('and it is gone on round 3', Game.eventSlotNow(), null);

  Game.init();
  Game.state.round = 6;
  Game._eventSlotClaim(6, 'A Normal Event', 'hazard');
  eq('a normal event still reads three', Game.eventSlotNow().max, Game._EVENT_LEN);
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
  // The round-1 opener gets the two rounds it actually has.
  eq('opener may start on 1', Game._eventWindowOpen(1, 1), true);
  eq('opener may start on 2', Game._eventWindowOpen(1, 2), true);
  eq('opener is spent on 3',  Game._eventWindowOpen(1, 3), false);
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
