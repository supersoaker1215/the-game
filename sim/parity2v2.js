// ============================================================
// 1v1 ↔ 2v2 PARITY — does each card DO the same thing in both modes?
//
// The rule this repo works to is "2v2 mirrors 1v1; only seat / energy / team
// plumbing differs". Nothing enforced it. This runs every card twice — once in
// a 1v1 match and once in a 2v2 online room — over the SAME board, the SAME
// hands, the SAME seed, resolving every prompt the same way (always the first
// option), and diffs the result.
//
// Compared: the first 6 lanes on both sides (name / ATK / HP), both sides'
// health, hand sizes, dead-pile sizes. Lanes 7-8 are excluded because 2v2 has
// eight and 1v1 has six — that difference is the board, not the card.
//
// A DIFF is not automatically a bug: a handful of cards are SUPPOSED to behave
// differently with four players (Symbiote cycles all four hands, Gorr eats from
// all four, Brainiac / Deadpool / the Grinch / the Flash pick a player). Those
// are listed as EXPECTED and reported separately, so the interesting column is
// UNEXPECTED.
//
//   jsc sim/parity2v2.js -- [--verbose]
// ============================================================
load('./sim/shim-real.js');

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

var SEED = 987654321;
var BOARD_ENEMY = ['Hulk', 'Godzilla', 'Venom', 'Bane'];
var BOARD_ALLY  = ['Joker', 'King Shark'];
var HAND        = ['Man-Bat', 'Gremlin', 'Venom', 'Bane'];

// Cards whose whole point CHANGES with four players — each one is a deliberate
// 2v2 branch in abilities.js, not drift.
var EXPECTED = {
  'Symbiote Spider-Man': 'cycles all four hands, not two',
  'Gorr': 'devours from all four hands',
  'Brainiac': 'picks WHICH opponent to scan',
  'Deadpool': 'picks WHICH opponent to steal from',
  'The Grinch': 'picks WHICH opponent to rob',
  'The Flash': 'picks first player from four seats',
  'Paul Atreides': 'keep-one routed through the 2v2 tray',
  'Eye of Agamotto': 'foresight is dealt to four seats',
  'Dr. Strange': 'foresight is dealt to four seats',
  'Dormammu': 'foresight is dealt to four seats',
  'Catwoman': 'picks WHICH opponent to steal energy from',
  'Mobius Chair': 'foresight is dealt to four seats',
  // Board-size, not behaviour: both of these are written against LANE_COUNT, so
  // the bigger 2v2 board is the whole difference. Verified by hand — the shared
  // lanes resolve identically and only the extra lanes differ.
  'Thanos': 'snaps half the LANES — 4 of 8 in 2v2, 3 of 6 in 1v1 (by spec)',
  'Knull': 'fills the battlefield — 8 lanes to fill instead of 6',
};

function mk(name, side) {
  for (var i = 0; i < CARD_DEFS.length; i++) if (CARD_DEFS[i].name === name) return Game.createCardInstance(CARD_DEFS[i], side);
  return null;
}

function drain() {
  var guard = 0;
  while (guard++ < 30) {
    var s = Game.state;
    if (s.pendingCardChoice) {
      var cc = s.pendingCardChoice; s.pendingCardChoice = null;
      try { if (cc.callback) cc.callback(cc.cards[0]); } catch (e) {}
    } else if (s.pendingLaneChoice) {
      var lc = s.pendingLaneChoice; s.pendingLaneChoice = null;
      try { if (lc.callback) lc.callback((lc.lanes && lc.lanes[0]) || 0); } catch (e) {}
    } else if (s.pendingKangChoice) {
      var kc = s.pendingKangChoice; s.pendingKangChoice = null;
    } else if (s.pendingBlockTrick) { s.pendingBlockTrick = null; }
    else if (s.pendingJumpOffer) { s.pendingJumpOffer = null; }
    else break;
    try { Game.cleanupDead(); Game.resumeCombatIfWaiting(); } catch (e) {}
  }
}

// The comparable part of the world — deliberately mode-agnostic.
function snapshot(mySide, oppSide, myHand, oppHand) {
  var lanes = [];
  for (var i = 0; i < 6; i++) {
    var l = Game.state.lanes[i];
    ['mine', 'theirs'].forEach(function (which) {
      var c = l[which === 'mine' ? mySide : oppSide];
      lanes.push(i + which[0] + ':' + (c ? c.name + ' ' + (c.attack | 0) + '/' + (c.currentHealth | 0)
        + (c.isFrozen ? 'F' : '') + (c.isStunned ? 'S' : '') + (c.isMindControlled ? 'M' : '')
        + (c.isFeared ? 'R' : '') + (c.tauntTurns > 0 ? 'T' : '') : '-'));
    });
  }
  return {
    lanes: lanes.join('|'),
    myHp: Game.state[mySide].health,
    oppHp: Game.state[oppSide].health,
    myHand: myHand().length,
    oppHand: oppHand().length,
    myDead: (Game.state[mySide].deadPile || []).length,
    oppDead: (Game.state[oppSide].deadPile || []).length,
  };
}

function run1v1(def) {
  Game.startSeededRun(SEED, 'classic');   // seeded, and startMatch cannot overwrite it
  Game.state.phase = 'player-cards';
  Game.state.player.isHuman = true;
  Game.state.player.currency = 12;
  Game.state.lanes.forEach(function (l) { l.player = null; l.ai = null; });
  BOARD_ENEMY.forEach(function (n, i) { Game.state.lanes[i].ai = mk(n, 'ai'); });
  BOARD_ALLY.forEach(function (n, i) { Game.state.lanes[i + 4].player = mk(n, 'player'); });
  Game.state.player.hand = HAND.map(function (n) { return mk(n, 'player'); });
  Game.state.ai.hand = HAND.map(function (n) { return mk(n, 'ai'); });
  Game.state.player.trickHand = TRICK_DEFS.slice(0, 2).map(function (t) { return Object.assign({}, t); });
  Game.state.ai.trickHand = TRICK_DEFS.slice(0, 2).map(function (t) { return Object.assign({}, t); });

  var card = Game.createCardInstance(def, 'player');
  // Same RNG position AND the same summon pool at the moment of play. The
  // summon deck is shuffled once per match, and the two modes consume different
  // amounts of RNG getting there — so a card that SUMMONS (Knull, Apocalypse,
  // Gorr) would otherwise diff purely on which card the lottery handed it.
  Game.seedMatch(SEED);
  Game._initSummonDeck();
  Game.seedMatch(SEED);
  try {
    if (card.isDiscardEffect) { if (card.onDiscard) card.onDiscard(Game, 'player', card); }
    else { Game.state.lanes[3].player = card; if (card.onPlay) card.onPlay(Game, card, 3); }
  } catch (e) { return { err: String(e.message || e) }; }
  drain();
  try { Game.cleanupDead(); } catch (e) {}
  return snapshot('player', 'ai',
    function () { return Game.state.player.hand; },
    function () { return Game.state.ai.hand; });
}

function run2v2(def) {
  Game.start2v2Match({ names: { p1: 'Ally', p2: 'EnemyA', p3: 'Caster', p4: 'EnemyB' } });
  Game.seedMatch(SEED);   // after the deal, so both modes enter the card with the same RNG position
  var tt = Game.state.twoVTwo;
  tt.online = true; tt.you = 'p1';
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) { tt.players[k].isAI = false; tt.players[k].energy = 12; tt.players[k].usedEnergy = 0; });
  tt.round = 4; Game.state.round = 4; tt.subPhaseIdx = 0;
  Game.state.phase = '2v2-play';
  var casterSeat = 'p3';
  var mySide = Game._2v2TeamSide[tt.players[casterSeat].team];
  var oppSide = mySide === 'player' ? 'ai' : 'player';
  Game.state.lanes.forEach(function (l) { l.player = null; l.ai = null; });
  BOARD_ENEMY.forEach(function (n, i) { Game.state.lanes[i][oppSide] = mk(n, oppSide); });
  BOARD_ALLY.forEach(function (n, i) { Game.state.lanes[i + 4][mySide] = mk(n, mySide); });
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) {
    var side = Game._2v2TeamSide[tt.players[k].team];
    tt.players[k].hand = HAND.map(function (n) { return mk(n, side); });
    tt.players[k].trickHand = TRICK_DEFS.slice(0, 2).map(function (t) { return Object.assign({}, t); });
  });
  // the side proxies mirror the acting seat, exactly as a live turn does
  Game._2v2CurrentActingPlayer = casterSeat;
  Game._2v2ActivePlayer = function () { return casterSeat; };
  Game._2v2SyncActivePlayer();

  var card = Game.createCardInstance(def, mySide);
  card._2v2PlayedBy = casterSeat;
  // Same RNG position AND the same summon pool at the moment of play. The
  // summon deck is shuffled once per match, and the two modes consume different
  // amounts of RNG getting there — so a card that SUMMONS (Knull, Apocalypse,
  // Gorr) would otherwise diff purely on which card the lottery handed it.
  Game.seedMatch(SEED);
  Game._initSummonDeck();
  Game.seedMatch(SEED);
  try {
    if (card.isDiscardEffect) { if (card.onDiscard) card.onDiscard(Game, mySide, card); }
    else { Game.state.lanes[3][mySide] = card; if (card.onPlay) card.onPlay(Game, card, 3); }
  } catch (e) { return { err: String(e.message || e) }; }
  drain();
  try { Game.cleanupDead(); } catch (e) {}
  return snapshot(mySide, oppSide,
    function () { return tt.players[casterSeat].hand; },
    function () { return tt.players.p2.hand; });
}

// ---- run ------------------------------------------------------------------
var _origErr = console.error; console.error = function () {};
var diffs = [], expected = [], errs = [], same = 0;

CARD_DEFS.forEach(function (def) {
  if (def._spawnOnly) return;
  var a, b;
  try { a = run1v1(def); } catch (e) { a = { err: 'harness 1v1: ' + (e.message || e) }; }
  try { b = run2v2(def); } catch (e) { b = { err: 'harness 2v2: ' + (e.message || e) }; }
  if (a.err || b.err) { errs.push(def.name + ' — 1v1: ' + (a.err || 'ok') + ' | 2v2: ' + (b.err || 'ok')); return; }
  var fields = ['lanes', 'myHp', 'oppHp', 'myHand', 'oppHand', 'myDead', 'oppDead'];
  var bad = [];
  fields.forEach(function (f) {
    if (String(a[f]) !== String(b[f])) bad.push(f + ': 1v1=' + a[f] + '  2v2=' + b[f]);
  });
  if (!bad.length) { same++; return; }
  (EXPECTED[def.name] ? expected : diffs).push({ name: def.name, why: EXPECTED[def.name] || '', bad: bad });
});

console.error = _origErr;
print('=== 1v1 ↔ 2v2 PARITY ===');
print('identical in both modes: ' + same + ' / ' + (same + diffs.length + expected.length + errs.length) + ' cards');
print('');
if (expected.length) {
  print('EXPECTED differences (deliberate 2v2 branches): ' + expected.length);
  expected.forEach(function (d) { print('   ' + d.name + ' — ' + d.why); });
  print('');
}
if (diffs.length) {
  print('UNEXPECTED differences: ' + diffs.length);
  diffs.forEach(function (d) {
    print('   ' + d.name);
    d.bad.slice(0, VERBOSE ? 99 : 3).forEach(function (b) { print('        ' + b); });
  });
} else {
  print('UNEXPECTED differences: none — every other card does the same thing in 2v2 as it does in 1v1.');
}
if (errs.length) {
  print('');
  print('threw in one or both modes: ' + errs.length);
  errs.slice(0, VERBOSE ? 99 : 12).forEach(function (e) { print('   ' + e); });
}
