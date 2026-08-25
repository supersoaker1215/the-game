// ============================================================
// 2v2 TEAMPLAY TUNER — CEM over the four teamplay weights only.
//
// sim/tune.js tunes the whole weight vector against 1v1 self-play. This tunes
// ONLY the keys the 2v2 teamplay layer reads, for one reason: AI.WEIGHTS is a
// single global shared by both modes, and those four keys are inert in 1v1 by
// construction (AI._2v2Ctx returns null there), so anything found here cannot
// move 1v1 balance a single point.
//
// Fitness is a head-to-head: the candidate's weights drive one team, the
// current champion's drive the other, seats swap every game, and the score is
// the candidate's win rate. That makes "better" mean "beats what we ship",
// which is the only definition worth optimising.
//
//   jsc sim/tune2v2.js -- --generations 6 --pop 10 --games 300
// ============================================================
load('./sim/shim.js');

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var GENS = 6, POP = 10, GAMES = 300, ELITE_FRAC = 0.3;
for (var i = 0; i < argv.length; i++) {
  if (argv[i] === '--generations') GENS = parseInt(argv[++i], 10);
  if (argv[i] === '--pop') POP = parseInt(argv[++i], 10);
  if (argv[i] === '--games') GAMES = parseInt(argv[++i], 10);
}

var KEYS = ['teamCoverUnblocked', 'teamReserveLane', 'teamSpreadBias', 'teamThreatPriority'];
// Start centred on "no teamplay at all" so the tuner has to EARN every point it
// moves away from the shipped behaviour.
var mean = { teamCoverUnblocked: 0, teamReserveLane: 0, teamSpreadBias: 0, teamThreatPriority: 0 };
var sigma = { teamCoverUnblocked: 3.0, teamReserveLane: 2.5, teamSpreadBias: 2.0, teamThreatPriority: 1.0 };

var CHAMPION = { teamCoverUnblocked: 0, teamReserveLane: 0, teamSpreadBias: 0, teamThreatPriority: 0 };

var SEATS = ['p1', 'p2', 'p3', 'p4'];
var BASE = {};
KEYS.forEach(function (k) { BASE[k] = AI.WEIGHTS[k]; });

// Gaussian sample (Box-Muller off the game's own seeded RNG so a run is
// reproducible from the seed like every other sim here).
function gauss() {
  var u = 0, v = 0;
  while (u === 0) u = Game.rng();
  while (v === 0) v = Game.rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function sample() {
  var out = {};
  KEYS.forEach(function (k) { out[k] = mean[k] + sigma[k] * gauss(); });
  return out;
}
function applyWeights(w) { KEYS.forEach(function (k) { AI.WEIGHTS[k] = w[k]; }); }

// One head-to-head game. `candTeam` is the team playing the candidate weights;
// the other team plays the champion's. Weights are swapped in per SEAT TURN,
// which is what lets two different brains share one match.
function playGame(cand, candTeam) {
  Game.start2v2Match({ names: { p1: 'A1', p2: 'B1', p3: 'A2', p4: 'B2' } });
  var tt = Game.state.twoVTwo;
  tt.online = true; tt.you = 'p1';
  SEATS.forEach(function (k) { tt.players[k].isAI = true; });
  tt.joinedPlayers = { p1: 1, p2: 1, p3: 1, p4: 1 };
  Game._2v2StartDraft();
  var guard = 0;
  while (Game.state.twoVTwo.draft && guard++ < 400) {
    SEATS.forEach(function (pk) {
      var d = Game.state.twoVTwo.draft;
      if (!d || d.picked[pk]) return;
      try { Game._2v2DraftPick(0, pk); } catch (e) {}
    });
  }
  var turns = 0;
  while (!Game.state.gameOver && turns++ < 300) {
    var activeKey = Game._2v2ActivePlayer();
    if (!activeKey) break;
    var me = tt.players[activeKey];
    applyWeights(me && me.team === candTeam ? cand : CHAMPION);
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
  if (!t || t.A.health === t.B.health) return null;
  var winner = t.A.health > t.B.health ? 'A' : 'B';
  return winner === candTeam;
}

function fitness(cand) {
  var wins = 0, decided = 0;
  for (var g = 0; g < GAMES; g++) {
    var r;
    try { r = playGame(cand, g % 2 === 0 ? 'A' : 'B'); } catch (e) { r = null; }
    if (r === null) continue;
    decided++;
    if (r) wins++;
  }
  return decided ? wins / decided : 0.5;
}

print('=== 2v2 TEAMPLAY TUNER ===');
print(GENS + ' generations x ' + POP + ' population x ' + GAMES + ' games — candidate vs champion');
print('');
var best = { w: Object.assign({}, CHAMPION), score: 0.5 };
for (var gen = 1; gen <= GENS; gen++) {
  var pop = [];
  for (var i2 = 0; i2 < POP; i2++) {
    var w = sample();
    pop.push({ w: w, score: fitness(w) });
  }
  pop.sort(function (a, b) { return b.score - a.score; });
  var nElite = Math.max(2, Math.round(POP * ELITE_FRAC));
  var elite = pop.slice(0, nElite);
  KEYS.forEach(function (k) {
    var vals = elite.map(function (e) { return e.w[k]; });
    var m = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    var v = vals.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / vals.length;
    mean[k] = m;
    sigma[k] = Math.max(0.15, Math.sqrt(v));
  });
  if (pop[0].score > best.score) best = { w: Object.assign({}, pop[0].w), score: pop[0].score };
  print('gen ' + gen + ': best ' + (100 * pop[0].score).toFixed(1) + '%   elite mean '
    + KEYS.map(function (k) { return k.replace('team', '') + '=' + mean[k].toFixed(2); }).join(' '));
}
print('');
print('champion-beating candidate: ' + (100 * best.score).toFixed(1) + '% over ' + GAMES + ' games');
print('  ' + KEYS.map(function (k) { return k + '=' + best.w[k].toFixed(3); }).join('\n  '));
print('');
print('(A win rate inside ~50% +/- ' + (100 * 1.96 * Math.sqrt(0.25 / GAMES)).toFixed(1)
  + ' at this sample size is NOT a result — confirm any winner with sim/bench2v2.js at a much larger n.)');
applyWeights(BASE);
