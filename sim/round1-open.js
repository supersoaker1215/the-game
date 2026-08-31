// ROUND-1 OPEN — can the AI actually play on turn 1?
//   jsc sim/round1-open.js -- --games 400
//
// WHY. User report: "the ai is getting stuck on turn 1 and wont play a card."
// It is not stuck — it passes, correctly, because nothing in its hand is
// affordable. Round 1 pays 1 energy. AI.pickDraftCard has a round-1 floor, but
// the floor's test is `cost <= 2`, so a single cost-2 card satisfies it and the
// AI still opens with a dead turn. This measures how often that happens.
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');

function parseArgs(argv) {
  var o = { games: 400 };
  for (var i = 0; i < argv.length; i++) if (argv[i] === '--games') o.games = parseInt(argv[++i], 10);
  return o;
}
var opts = parseArgs((typeof arguments !== 'undefined') ? arguments : []);

// CEILING. The floor can only take a cost-1 card if one is ever OFFERED, so
// record what each seat was actually shown across its five picks. Anything the
// fix cannot reach is a limit of the draft pool, not of the picker.
var offeredCost1 = { player: false, ai: false };
var _origPick = AI.pickDraftCard;
AI.pickDraftCard = function (choices, drafted) {
  var seat = (Game.state.draft && choices === Game.state.draft.aiChoices) ? 'ai' : 'player';
  for (var i = 0; i < (choices || []).length; i++) {
    if ((choices[i].cost || 0) <= 1) offeredCost1[seat] = true;
  }
  return _origPick.call(this, choices, drafted);
};

// Freeze the actual turn so we can read the opening hand before it is spent.
AI.playCards = function () {};
AI.playTricks = function () {};
AI.playTrickPhaseCards = function () {};

var stats = {
  games: 0,
  deadOpen: { player: 0, ai: 0 },
  cheapestHist: {},       // cheapest card cost in the opening hand
  hasCost1:   { player: 0, ai: 0 },
  hasCost2Only: 0,
  everOfferedCost1: { player: 0, ai: 0 },
  qualitySum: { player: 0, ai: 0 },
  deadDespiteOffer: { player: 0, ai: 0 }
};

function measureSeat(s, seat) {
  var hand = s[seat].hand || [];
  if (!hand.length) return;
  var energy = s[seat].currency || 0;
  var cheapest = Infinity;
  var affordable = 0;
  for (var i = 0; i < hand.length; i++) {
    var c = Game.getCardCost(seat, hand[i]);
    if (c < cheapest) cheapest = c;
    if (c <= energy) affordable++;
  }
  if (affordable === 0) {
    stats.deadOpen[seat]++;
    if (offeredCost1[seat]) stats.deadDespiteOffer[seat]++;
  }
  if (offeredCost1[seat]) stats.everOfferedCost1[seat]++;
  // WHAT THE FLOOR COSTS. Constraining a pick can only lower the drafted
  // hand's raw quality; this says by how much, so the trade is visible rather
  // than assumed.
  var q = 0;
  for (var qi = 0; qi < hand.length; qi++) q += AI.draftCardQuality(hand[qi]);
  stats.qualitySum[seat] += q;
  if (cheapest <= 1) stats.hasCost1[seat]++;
  var k = String(cheapest);
  stats.cheapestHist[k] = (stats.cheapestHist[k] || 0) + 1;
}

for (var g = 0; g < opts.games; g++) {
  offeredCost1 = { player: false, ai: false };
  Game.init();
  Game._syncMode = true;
  Game.startMatch('classic');
  Game.state.player.isHuman = false;
  Game.state.ai.isHuman = false;

  var guard = 0;
  while ((Game.state.phase === 'draft-cards' || Game.state.phase === 'draft-tricks') && guard++ < 60) {
    var d = Game.state.draft;
    if (!d.playerChoices || d.playerChoices.length === 0) {
      if (d.phase === 'cards') Game.finishCardDraft(); else Game.finishTrickDraft();
      continue;
    }
    var pick = d.phase === 'cards'
      ? AI.pickDraftCard(d.playerChoices, d.playerDrafted)
      : AI.pickDraftTrick(d.playerChoices, d.playerTrickDrafted);
    var idx = d.playerChoices.indexOf(pick);
    Game.draftPick(idx >= 0 ? idx : 0);
  }

  var s = Game.state;
  if (s.round !== 1) continue;
  stats.games++;
  measureSeat(s, 'ai');
  measureSeat(s, 'player');
}

function pct(n) { return stats.games ? ((n / stats.games) * 100).toFixed(1) + '%' : 'n/a'; }
print('');
print('ROUND-1 OPEN over ' + stats.games + ' drafts  (round 1 pays 1 energy)');
print('  AI     opens with NOTHING affordable : ' + stats.deadOpen.ai + '  (' + pct(stats.deadOpen.ai) + ')');
print('  player opens with NOTHING affordable : ' + stats.deadOpen.player + '  (' + pct(stats.deadOpen.player) + ')');
print('  AI     holds at least one cost-1     : ' + pct(stats.hasCost1.ai));
print('  player holds at least one cost-1     : ' + pct(stats.hasCost1.player));
print('  mean drafted-hand quality  AI ' + (stats.qualitySum.ai / (stats.games||1)).toFixed(2)
      + '   player ' + (stats.qualitySum.player / (stats.games||1)).toFixed(2));
print('');
print('  CEILING — a cost-1 was offered at some point:');
print('    to AI     : ' + pct(stats.everOfferedCost1.ai));
print('    to player : ' + pct(stats.everOfferedCost1.player));
print('  dead open DESPITE being offered a cost-1 (the pickers fault):');
print('    AI        : ' + stats.deadDespiteOffer.ai + '  (' + pct(stats.deadDespiteOffer.ai) + ')');
print('    player    : ' + stats.deadDespiteOffer.player + '  (' + pct(stats.deadDespiteOffer.player) + ')');
print('');
print('  cheapest card in the opening hand (both seats):');
var keys = Object.keys(stats.cheapestHist).sort(function (a, b) { return (+a) - (+b); });
for (var i = 0; i < keys.length; i++) {
  print('    cost ' + keys[i] + ': ' + stats.cheapestHist[keys[i]]);
}
print('');
