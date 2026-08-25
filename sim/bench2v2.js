// ============================================================
// 2v2 AI BENCHMARK — four AI seats, full matches, A/B on the teamplay layer.
//
// Team A plays with 2v2 teamplay ON, team B with it OFF (the plain 1v1 brain
// each seat used to run). Sides are swapped every other game so the seating
// order cannot flatter either arm. What comes out is a win rate, which is the
// only honest way to answer "are the 2v2 bots smarter now".
//
//   jsc sim/bench2v2.js -- --games 200
// ============================================================
load('./sim/shim.js');

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var GAMES = 200, DRAFT_MODE = 'both';
for (var i = 0; i < argv.length; i++) {
  if (argv[i] === '--games') GAMES = parseInt(argv[++i], 10);
  // --draft cards|tricks|both|none — which half of the draft the candidate arm
  // gets to make smartly, so the two effects can be measured apart.
  if (argv[i] === '--draft') DRAFT_MODE = String(argv[++i] || 'both');
  // --set key=value, repeatable: sweep the teamplay weights without editing ai.js
  if (argv[i] === '--set') {
    var kv = String(argv[++i] || '').split('=');
    if (kv.length === 2) AI.WEIGHTS[kv[0]] = parseFloat(kv[1]);
  }
}

var SEATS = ['p1', 'p2', 'p3', 'p4'];

// ---- SENSITIVITY PROBES ----
// Before hunting for a smarter rule, find out whether the dimension matters at
// all: cripple ONE of the control arm's decisions and see whether it costs them
// anything. A crippled control that still wins half its games means no amount
// of cleverness in that dimension can pay.
var CRIPPLE = null;
for (var ci = 0; ci < argv.length; ci++) if (argv[ci] === '--cripple') CRIPPLE = String(argv[ci + 1] || '');
function _isControlSeat() {
  var tt = Game.state.twoVTwo;
  var seat = Game._2v2CurrentActingPlayer;
  return !!(seat && tt && tt.players[seat] && tt.players[seat].team !== TEAMPLAY_TEAM);
}
if (CRIPPLE) {
  var _chooseLane = AI.chooseLane.bind(AI);
  AI.chooseLane = function (card, owner) {
    if (CRIPPLE === 'lanes' && _isControlSeat()) {
      var open = Game.getOpenLanes(owner);
      return open.length ? open[Game.rngInt ? Game.rngInt(open.length) : 0] : -1;
    }
    return _chooseLane(card, owner);
  };
  var _planBlocks = AI.planDefensiveBlocks.bind(AI);
  AI.planDefensiveBlocks = function (hand, budget, owner) {
    if (CRIPPLE === 'blocks' && _isControlSeat()) return [];
    return _planBlocks(hand, budget, owner);
  };
  var _playTricks = AI.playTricks.bind(AI);
  AI.playTricks = function (owner, cb) {
    if (CRIPPLE === 'tricks' && _isControlSeat()) { if (cb) cb(); return; }
    return _playTricks(owner, cb);
  };
  var _playCards = AI.playCards.bind(AI);
  AI.playCards = function (owner, cb) {
    // 'order' — force the control arm back to cheapest-first, the play order
    // the 1v1 A/B measured as costing 6.3pp there.
    if (CRIPPLE === 'order' && _isControlSeat()) {
      var prev = AI.WEIGHTS._playOrder;
      AI.WEIGHTS._playOrder = 'asc';
      try { return _playCards(owner, cb); } finally { AI.WEIGHTS._playOrder = prev; }
    }
    // 'onecard' — the control arm may place at most ONE card per turn, to size
    // how much of the game is simply "get bodies down".
    if (CRIPPLE === 'onecard' && _isControlSeat()) {
      var before = Game.state[owner].hand.length;
      var _pc = Game.playCard.bind(Game);
      var played = 0;
      Game.playCard = function (o, c, l, f) {
        if (o === owner && played >= 1) return false;
        var r = _pc(o, c, l, f);
        if (r) played++;
        return r;
      };
      try { return _playCards(owner, cb); } finally { Game.playCard = _pc; }
    }
    return _playCards(owner, cb);
  };
}

// The teamplay layer keys entirely off AI._2v2Ctx returning a context; make it
// return null for the seats in the control arm and they play the old way.
var _realCtx = AI._2v2Ctx.bind(AI);
var TEAMPLAY_TEAM = 'A';
AI._2v2Ctx = function (owner) {
  var ctx = _realCtx(owner);
  if (!ctx) return null;
  var tt = Game.state.twoVTwo;
  var me = tt.players[ctx.seat];
  if (!me || me.team !== TEAMPLAY_TEAM) return null;   // control arm: 1v1 brain
  return ctx;
};

function playGame(gameIdx) {
  // Alternate which team gets the teamplay layer so seating can't skew it.
  TEAMPLAY_TEAM = (gameIdx % 2 === 0) ? 'A' : 'B';
  Game.start2v2Match({ names: { p1: 'A1', p2: 'B1', p3: 'A2', p4: 'B2' } });
  var tt = Game.state.twoVTwo;
  tt.online = true;
  tt.you = 'p1';
  SEATS.forEach(function (k) { tt.players[k].isAI = true; });
  tt.joinedPlayers = { p1: 1, p2: 1, p3: 1, p4: 1 };
  Game._2v2StartDraft();

  // DRAFT THROUGH THE REAL PATH, per seat, so the arms can differ here too —
  // the draft is where a 2v2 bot's deck is decided and it used to be a stub.
  // The candidate team drafts with the engine's picker; the control team keeps
  // the old "pricier card, first trick" heuristic.
  var guard = 0;
  while (Game.state.twoVTwo.draft && guard++ < 400) {
    SEATS.forEach(function (pk) {
      var d = Game.state.twoVTwo.draft;
      if (!d || d.picked[pk]) return;
      var offers = (d.choicesByPlayer && d.choicesByPlayer[pk]) || [];
      if (offers.length < 2) { try { Game._2v2DraftPick(0, pk); } catch (e) {} return; }
      var smart = Game.state.twoVTwo.players[pk].team === TEAMPLAY_TEAM
                  && (DRAFT_MODE === 'both' || DRAFT_MODE === (d.phase === 'cards' ? 'cards' : 'tricks'));
      var idx;
      if (smart) {
        idx = Game._2v2AIDraftIndex(pk, offers, d.phase);
      } else {
        idx = (d.phase === 'cards') ? (((offers[1].cost || 0) > (offers[0].cost || 0)) ? 1 : 0) : 0;
      }
      try { Game._2v2DraftPick(idx, pk); } catch (e) {}
    });
  }

  var turns = 0;
  while (!Game.state.gameOver && turns++ < 300) {
    var activeKey = Game._2v2ActivePlayer();
    if (!activeKey) break;
    var subPhase = Game._2v2SubPhase();
    var side = Game._2v2ActiveSide();
    Game._2v2CurrentActingPlayer = activeKey;
    Game._2v2SyncActivePlayer();
    try {
      if (Game._2v2CanPlayCards(subPhase) && AI.playCards) AI.playCards(side, function () {});
      if (Game._2v2CanPlayTricks(subPhase)) {
        if (AI.playTrickPhaseCards) AI.playTrickPhaseCards(side, function () {});
        if (AI.playTricks) AI.playTricks(side, function () {});
      }
    } catch (e) {}
    try { Game.end2v2Phase(); } catch (e) { break; }
  }

  var t = Game.state.twoVTwo.teams;
  if (!t) return null;
  if (t.A.health === t.B.health) return 'draw';
  var winner = t.A.health > t.B.health ? 'A' : 'B';
  return (winner === TEAMPLAY_TEAM) ? 'teamplay' : 'control';
}

var res = { teamplay: 0, control: 0, draw: 0, broken: 0 };
for (var g = 0; g < GAMES; g++) {
  var r;
  try { r = playGame(g); } catch (e) { r = null; }
  if (!r) res.broken++; else res[r]++;
}

var decided = res.teamplay + res.control;
var pct = decided ? (100 * res.teamplay / decided) : 0;
print('=== 2v2 AI BENCHMARK: ' + GAMES + ' games ===');
print('  teamplay ON  wins: ' + res.teamplay);
print('  teamplay OFF wins: ' + res.control);
print('  draws: ' + res.draw + '   unfinished: ' + res.broken);
print('  teamplay win rate: ' + pct.toFixed(1) + '%  (50% = no difference)');
// Rough 95% band for a coin flip at this sample size, so the number can be read
// without pretending a 2-point wobble is a result.
if (decided) {
  var se = 100 * Math.sqrt(0.25 / decided);
  print('  95% band for "no difference" at n=' + decided + ': ' + (50 - 1.96 * se).toFixed(1) + '% – ' + (50 + 1.96 * se).toFixed(1) + '%');
}
