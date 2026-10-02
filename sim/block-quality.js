// ============================================================
// BLOCK QUALITY — how far is the greedy block plan from the best one?
//
//   jsc sim/block-quality.js -- [--games 200]
//
// planDefensiveBlocks sorts threatened lanes by threat and takes the best fit
// for each in turn. That is a local choice made globally, and this brute-forces
// the exact best assignment (the sets are small) to size the gap.
//
// READ THE NOTE ON planDefensiveBlocks BEFORE ACTING ON THE NUMBER. The gap is
// real — 21.1% of calls when this was written — and CLOSING IT MAKES THE AI
// WORSE: an exhaustive search scored 46.7% and 46.1% against greedy over 3000
// games on two seeds. Summed blockFitScore is not a quantity worth maximising;
// it buys breadth and pays with the scariest lane. This tool is kept so the gap
// can be re-measured against a BETTER objective, not so the search can be
// rebuilt against this one.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');
var argv=(typeof arguments!=='undefined')?arguments:[]; var GAMES=200;
for (var i=0;i<argv.length;i++) if (argv[i]==='--games') GAMES=parseInt(argv[++i],10);

var calls=0, suboptimal=0, totalGap=0, worstGap=0, skipped=0;

function bestAssignment(lanes, cards, budget, owner) {
  // exhaustive over (lane -> card or none), pruned by budget. Small by nature.
  var best = -Infinity, n = lanes.length;
  function rec(i, usedMask, spent, acc) {
    if (i === n) { if (acc > best) best = acc; return; }
    rec(i + 1, usedMask, spent, acc);                      // leave this lane open
    for (var j = 0; j < cards.length; j++) {
      if (usedMask & (1 << j)) continue;
      var cost = Game.getCardCost(owner, cards[j]);
      if (spent + cost > budget) continue;
      var sc = AI.blockFitScore(cards[j], lanes[i].enemy);
      if (sc < 1) continue;                                 // planner's own floor
      rec(i + 1, usedMask | (1 << j), spent + cost, acc + sc);
    }
  }
  rec(0, 0, 0, 0);
  return best === -Infinity ? 0 : best;
}

var realPlan = AI.planDefensiveBlocks.bind(AI);
AI.planDefensiveBlocks = function (hand, budget, owner) {
  var out = realPlan(hand, budget, owner);
  try {
    var s = Game.state, opp = Game.opponent(owner);
    var lanes = [];
    for (var i=0;i<Game.LANE_COUNT;i++) {
      var lane = s.lanes[i];
      if (lane.destroyed || lane[owner]) continue;
      var e = lane[opp];
      if (e && e.currentHealth>0 && (e.attack||0)>0) lanes.push({ lane:i, enemy:e });
    }
    var cards = hand.filter(function(c){ return !c.isDiscardEffect && !c._neverPlayable; });
    if (!lanes.length || !cards.length) return out;
    if (lanes.length * cards.length > 42) { skipped++; return out; }  // keep the brute force honest
    calls++;
    var got = 0;
    out.forEach(function (a) {
      var c = cards.filter(function(x){return x.id===a.cardId;})[0];
      var L = lanes.filter(function(x){return x.lane===a.lane;})[0];
      if (c && L) got += AI.blockFitScore(c, L.enemy);
    });
    var opt = bestAssignment(lanes, cards, budget, owner);
    if (opt > got + 0.01) {
      suboptimal++; totalGap += (opt - got);
      if (opt - got > worstGap) worstGap = opt - got;
    }
  } catch (e) {}
  return out;
};

runSimGame.seed = 8080;
for (var g=0; g<GAMES; g++) { try { runSimGame(null,null,null); } catch(e){} }
print('=== GREEDY vs OPTIMAL block assignment, ' + GAMES + ' games ===');
print('  planning calls compared : ' + calls + '   (skipped as too large: ' + skipped + ')');
print('  greedy was SUBOPTIMAL   : ' + suboptimal + '  (' + (100*suboptimal/Math.max(1,calls)).toFixed(1) + '%)');
print('  mean score left on table: ' + (suboptimal ? (totalGap/suboptimal).toFixed(2) : 0) + '   worst single: ' + worstGap.toFixed(2));
