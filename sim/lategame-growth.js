// ============================================================
// LATE-GAME GROWTH PROBE — what gets bigger every round?
//
// Owner: "after round 11 the game strats to break doen, it gets laggy and bugs
// start spawing that dont happen ealier on."
//
// A match that degrades with round count is almost always something that GROWS
// with round count. This plays one long 2v2 online game and, at every round
// boundary, measures the things that could: the broadcast payload, the state
// blob, each accumulating array, and the wall-clock cost of the round itself.
// Whatever's slope is not flat is the answer.
//
//   jsc sim/lategame-growth.js -- [--rounds 40] [--games 3]
// ============================================================
load('./sim/shim.js');

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var MAXR = 40, GAMES = 1;
for (var i = 0; i < argv.length; i++) {
  if (argv[i] === '--rounds') MAXR = parseInt(argv[++i], 10);
  if (argv[i] === '--games') GAMES = parseInt(argv[++i], 10);
}
var KEYS = ['p1', 'p2', 'p3', 'p4'];
function rnd(n) { return Math.floor(Math.random() * n); }

function drainPrompts(budget) {
  var n = 0;
  while (n++ < (budget || 60)) {
    var s = Game.state;
    if (s.pendingCardChoice) {
      var cc = s.pendingCardChoice, cards = cc.cards || [];
      if (!cards.length) { s.pendingCardChoice = null; continue; }
      var pick = cards[rnd(cards.length)];
      s.pendingCardChoice = null;
      try { if (cc.callback) cc.callback(pick); } catch (e) {}
      continue;
    }
    if (s.pendingLaneChoice) {
      var lc = s.pendingLaneChoice, lanes = lc.lanes || [];
      if (!lanes.length) { s.pendingLaneChoice = null; continue; }
      var lane = lanes[rnd(lanes.length)];
      s.pendingLaneChoice = null;
      try { if (lc.callback) lc.callback(lane); } catch (e) {}
      continue;
    }
    var seat = (s.player && s.player.stolenByBWL) ? 'player' : (s.ai && s.ai.stolenByBWL) ? 'ai' : null;
    if (seat) { var d = s[seat].stolenByBWL; s[seat].stolenByBWL = null;
      try { Game.addToHand(seat, d.card, d.bwl); } catch (e) {} continue; }
    break;
  }
}

function len(x) { return (x && x.length) || 0; }
function jlen(x) { try { return JSON.stringify(x).length; } catch (e) { return -1; } }

// Everything that could plausibly grow with round count, measured the same way
// every round so the SLOPE is the signal, not the absolute number.
function measure() {
  var s = Game.state, tt = s.twoVTwo, m = {};
  m.stateBytes = jlen(s);
  try { m.wireBytes = jlen(Multiplayer.serializeState(s)); } catch (e) { m.wireBytes = -1; }
  m.log        = len(s.log);
  m.fx         = (s._fx && len(s._fx.events)) || 0;
  m.voidPile   = len(s.voidPile);
  m.deadP      = len(s.player && s.player.deadPile) + len(s.ai && s.ai.deadPile);
  m.replayLog  = len(Game._replayLog);
  m.replayFrm  = len(Game._liveReplayFrames);
  m.stack      = len(Game._stack);
  m.promptQ    = len(s._promptQueue) + len(Game._promptQueue);
  m.pendingCbs = len(Game._promptClearedCbs) + len(Game._whenPromptCleared);
  m.history    = len(s.history) + len(s._history);
  m.snapshots  = len(Game._undoSnapshots) + len(s._snapshots) + len(s.undoStack);
  m.timers     = (Game._schedules && Game._schedules.length) || 0;
  var cards = 0;
  for (var i = 0; i < s.lanes.length; i++) { if (s.lanes[i].player) cards++; if (s.lanes[i].ai) cards++; }
  if (tt) KEYS.forEach(function (k) { var p = tt.players[k]; if (p) cards += len(p.hand) + len(p.trickHand); });
  m.cards = cards;
  // WHICH prompt is holding the drain open. _stackDrain returns the moment
  // _promptBusy() is true, so a prompt slot nobody ever answers freezes the
  // stack for the rest of the match — everything queued behind it strands.
  m.busy = Game._promptBusy() ? 1 : 0;
  m._stuck = ['pendingCardChoice','pendingLaneChoice','pendingBlockTrick',
              'pendingKangChoice','pendingJumpOffer','pendingTimeStoneIntercept']
              .filter(function (k) { return !!s[k]; }).join(',');
  m._labels = (Game._stack || []).slice(0, 4).map(function (e) { return e.label || e.type; }).join(' | ');
  return m;
}

var FIELDS = ['stateBytes','wireBytes','log','fx','voidPile','deadP','replayLog','replayFrm',
              'stack','promptQ','pendingCbs','history','snapshots','timers','cards'];

function playLong(seed) {
  Game.start2v2Match({ names: { p1: 'A1', p2: 'A2', p3: 'B1', p4: 'B2' } });
  Game.state.twoVTwo.online = true;
  Game.state.twoVTwo.you = 'p1';
  Game._2v2StartDraft();
  var guard = 0;
  while (Game.state.twoVTwo.draft && guard++ < 400) {
    KEYS.forEach(function (pk) {
      var dd = Game.state.twoVTwo.draft; if (!dd || dd.picked[pk]) return;
      try { Game._2v2DraftPick(rnd(2), pk); } catch (e) {}
    });
  }
  var rows = [], turns = 0, lastRound = 0, tRound = Date.now(), lastSig = '';
  while (!Game.state.gameOver && turns++ < 900) {
    var s = Game.state, tt = s.twoVTwo;
    if (!tt) break;
    if ((tt.round || 0) > MAXR) break;
    var activeKey = Game._2v2ActivePlayer();
    if (!activeKey) break;
    var sig = s.phase + '|' + activeKey + '|' + (tt.round || 0) + '|' + (tt.subPhaseIdx || 0);
    var ap = tt.players[activeKey];
    var acts = rnd(3);
    for (var a = 0; a < acts; a++) {
      ap = tt.players[activeKey];
      var avail = [];
      (ap.hand || []).forEach(function (c, idx) {
        if ((ap.energy - (ap.usedEnergy || 0)) >= (c.cost || 0)) avail.push(idx);
      });
      if (!avail.length) break;
      try { Game._2v2RequestLaneChoice(activeKey, avail[rnd(avail.length)]); } catch (e) {}
      drainPrompts();
    }
    ap = tt.players[activeKey];
    if (len(ap.trickHand) && Math.random() < 0.4) {
      try { Game._2v2OnlinePlayTrick(activeKey, rnd(ap.trickHand.length)); } catch (e) {}
      drainPrompts();
    }
    try { Game.end2v2Phase(null, { actor: activeKey }); } catch (e) {}
    drainPrompts();

    var r = (Game.state.twoVTwo && Game.state.twoVTwo.round) || 0;
    if (r !== lastRound) {
      var now = Date.now();
      var m = measure(); m.round = lastRound; m.ms = now - tRound;
      if (lastRound > 0) rows.push(m);
      lastRound = r; tRound = now;
    }
    var newSig = Game.state.phase + '|' + (Game._2v2ActivePlayer() || '-') + '|' +
                 ((Game.state.twoVTwo && Game.state.twoVTwo.round) || 0) + '|' +
                 ((Game.state.twoVTwo && Game.state.twoVTwo.subPhaseIdx) || 0);
    if (newSig === sig && newSig === lastSig) break;
    lastSig = sig;
  }
  return rows;
}

var all = [];
for (var g = 0; g < GAMES; g++) { Game.init(); all.push(playLong(g)); }

// print the longest run
var rows = all.sort(function (a, b) { return b.length - a.length; })[0] || [];
print('=== per-round growth, ' + rows.length + ' rounds ===');
var hdr = 'rd    ms  ' + FIELDS.map(function (f) { return f.slice(0, 9).padStart(10); }).join('');
print(hdr);
rows.forEach(function (m) {
  print(String(m.round).padStart(2) + ' ' + String(m.ms).padStart(5) + '  ' +
        FIELDS.map(function (f) { return String(m[f]).padStart(10); }).join('') +
        '   busy=' + m.busy + (m._stuck ? ' [' + m._stuck + ']' : '') +
        (m._labels ? '  head: ' + m._labels : ''));
});
if (rows.length >= 6) {
  var a = rows.slice(0, 3), b = rows.slice(-3);
  var avg = function (set, f) { return set.reduce(function (t, m) { return t + (m[f] || 0); }, 0) / set.length; };
  print('');
  print('=== first 3 rounds vs last 3 ===');
  print('field           first      last     xgrowth');
  ['ms'].concat(FIELDS).forEach(function (f) {
    var x = avg(a, f), y = avg(b, f);
    var mult = x > 0 ? (y / x) : (y > 0 ? Infinity : 1);
    var flag = (mult >= 2 && y > 8) ? '   <-- GROWS' : '';
    print(f.padEnd(12) + String(Math.round(x)).padStart(9) + String(Math.round(y)).padStart(10) +
          '   ' + (isFinite(mult) ? mult.toFixed(2) + 'x' : 'inf') + flag);
  });
}

// ---- GATE ------------------------------------------------------------------
// The probe doubles as a regression: whatever else a long 2v2 does, the queued
// event stack must not carry from one round into the next. That is the thing
// that made a round-16 match a different, worse game than a round-5 one.
var __pass = 0, __fail = [];
var worst = 0, growing = 0;
all.forEach(function (rs) {
  rs.forEach(function (m) { if (m.stack > worst) worst = m.stack; });
  for (var i = 1; i < rs.length; i++) if (rs[i].stack > rs[i - 1].stack && rs[i].stack > 0) growing++;
});
if (worst === 0) __pass++;
else __fail.push('the stack crossed a round boundary — deepest carry-over was ' + worst
               + ' queued events (' + growing + ' rounds where it grew)');
var anyRounds = all.some(function (rs) { return rs.length >= 3; });
if (anyRounds) __pass++;
else __fail.push('no game reached 3 rounds — the probe measured nothing');
print('');
print('lategame-growth: ' + __pass + ' passed, ' + __fail.length + ' failed');
if (__fail.length) { print('Failures:'); __fail.forEach(function (f) { print('  - ' + f); }); }
