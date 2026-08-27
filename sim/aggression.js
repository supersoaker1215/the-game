// AGGRESSION / "FEELS HARDER" MEASUREMENT — JSC-compatible.
//   jsc sim/aggression.js -- --games 300 --diff hard
//
// WHY THIS EXISTS. sim/difficulty.js answers "does A beat B", which is the
// wrong question for the thing the user actually asked for: an opponent that
// FEELS harder. Feel is not win rate. It is what the AI visibly does — where
// it puts its cards, whether it spends its energy, whether it presses or
// turtles. This measures those directly so a claim about the AI feeling more
// aggressive is falsifiable in the same way a win-rate claim is.
//
// Reports:
//   laneHistogram   — where the AI actually places. A board that always opens
//                     in lane 0 reads as a script, not an opponent.
//   laneEntropy     — 0 = always the same lane, 1 = perfectly spread.
//   energyLeftPct   — share of a turn's energy the AI ends the turn holding.
//                     Unspent energy is the most visible form of passivity.
//   defensiveTurns  — share of turns the AI entered in its defensive posture.
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');

function parseArgs(argv) {
  var o = { games: 200, diff: 'hard' };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--games') o.games = parseInt(argv[++i], 10);
    else if (argv[i] === '--diff') o.diff = argv[++i];
  }
  return o;
}
var opts = parseArgs((typeof arguments !== 'undefined') ? arguments : []);

var laneCounts = [0,0,0,0,0,0,0,0];
var placements = 0;
var energySamples = [];
var turnsEnded = 0, turnsWithUnplayed = 0, unplayedCards = 0;
var postureTurns=0, defensiveTurns=0, defByIncoming=0, defByFarBehind=0, incomingSum=0;

// Record every lane the AI chooses.
var _origChooseLane = AI.chooseLane;
AI.chooseLane = function (card, owner) {
  var l = _origChooseLane.call(this, card, owner);
  if (typeof l === 'number' && l >= 0 && l < laneCounts.length) { laneCounts[l]++; placements++; }
  return l;
};

// Sample how much energy the AI is still holding when its card step ends.
var _origPlayCards = AI.playCards;
if (typeof _origPlayCards === 'function') {
  AI.playCards = function (owner, onComplete) {
    var self = this;
    var o = owner || 'ai';
    var before = (Game.state && Game.state[o]) ? (Game.state[o].currency || 0) : 0;
    // POSTURE. `defensive` is a local inside playCards, so recompute it here
    // from the same inputs at the same moment. This is the number that decides
    // whether the AI spends its turn blocking or pressing — the single most
    // visible thing about how an opponent plays.
    try {
      var st0 = Game.state, opp0 = Game.opponent(o);
      var incoming = AI.unblockedIncoming(o);
      var dfc = AI.difficulty(o);
      var thr = dfc === 'easy' ? AI.WEIGHTS.defensiveThresholdEasy
              : dfc === 'hard' ? AI.WEIGHTS.defensiveThresholdHard
              : AI.WEIGHTS.defensiveThresholdNormal;
      var fb = st0[o].health < st0[opp0].health - 10;
      postureTurns++;
      if (incoming >= thr) defByIncoming++;
      if (fb) defByFarBehind++;
      if (incoming >= thr || fb) defensiveTurns++;
      incomingSum += incoming;
    } catch (e) {}
    return _origPlayCards.call(this, o, function () {
      var st = Game.state;
      var after = (st && st[o]) ? (st[o].currency || 0) : 0;
      if (before > 0) energySamples.push(after / before);
      // AVOIDABLE leftover: energy still held while a card in hand was both
      // affordable AND had somewhere to go. Unspent energy on its own is not
      // passivity — sometimes there is simply nothing to buy. This is the part
      // the AI actually chose not to spend.
      if (st && st[o] && after > 0) {
        var openLanes = Game.getOpenLanes(o) || [];
        var hand = st[o].hand || [];
        var playable = 0;
        for (var i = 0; i < hand.length; i++) {
          var c = hand[i];
          if (!c || c._neverPlayable) continue;
          if (c.trickPhasePlayable) continue;       // deliberately held, not passivity
          if (Game.getCardCost(o, c) > after) continue;
          if (!c.isDiscardEffect && !openLanes.length) continue;
          playable++;
        }
        turnsEnded++;
        if (playable > 0) { turnsWithUnplayed++; unplayedCards += playable; }
      } else if (st && st[o]) { turnsEnded++; }
      if (onComplete) onComplete();
    });
  };
}

for (var g = 0; g < opts.games; g++) {
  AI._diffOverride = { ai: opts.diff, player: opts.diff };
  runSimGame(null, null, null);
}
AI._diffOverride = null;

// Shannon entropy over the lane histogram, normalised to [0,1].
var used = 0, ent = 0;
for (var i = 0; i < laneCounts.length; i++) if (laneCounts[i] > 0) used++;
for (var i = 0; i < laneCounts.length; i++) {
  if (!laneCounts[i]) continue;
  var p = laneCounts[i] / placements;
  ent -= p * Math.log(p);
}
var maxEnt = Math.log(laneCounts.length);
var norm = maxEnt > 0 ? ent / maxEnt : 0;

var energyLeft = 0;
for (var i = 0; i < energySamples.length; i++) energyLeft += energySamples[i];
energyLeft = energySamples.length ? energyLeft / energySamples.length : 0;

print('games            ' + opts.games + '   difficulty ' + opts.diff);
print('placements       ' + placements);
print('laneHistogram    ' + laneCounts.join(' / '));
var pct = [];
for (var i = 0; i < laneCounts.length; i++) pct.push((100 * laneCounts[i] / placements).toFixed(1) + '%');
print('lanePercent      ' + pct.join(' '));
print('laneEntropy      ' + norm.toFixed(4) + '   (1.0 = perfectly spread, 0 = always one lane)');
print('lanesEverUsed    ' + used + ' of ' + laneCounts.length);
print('energyLeftPct    ' + (100 * energyLeft).toFixed(1) + '%   (share of energy still held when the card step ends)');
print('energySamples    ' + energySamples.length);
print('turnsEnded       ' + turnsEnded);
print('turnsLeftAPlay   ' + (100 * turnsWithUnplayed / Math.max(1, turnsEnded)).toFixed(1)
  + '%   (turns ended holding energy AND a playable card)');
print('cardsLeftUnplayed ' + (unplayedCards / Math.max(1, turnsEnded)).toFixed(2) + ' per turn');
print('--- posture ---');
print('defensiveTurns   ' + (100 * defensiveTurns / Math.max(1, postureTurns)).toFixed(1)
  + '%   (turn spent blocking rather than pressing)');
print('  by incoming    ' + (100 * defByIncoming / Math.max(1, postureTurns)).toFixed(1) + '%');
print('  by farBehind   ' + (100 * defByFarBehind / Math.max(1, postureTurns)).toFixed(1) + '%');
print('avgIncoming      ' + (incomingSum / Math.max(1, postureTurns)).toFixed(2));
