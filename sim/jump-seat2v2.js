// ============================================================
// A HUMAN'S JUMP IS THAT HUMAN'S, EVEN WHILE A BOT TEAMMATE IS DRIVING.
//
//   jsc sim/jump-seat2v2.js
//
// Owner report (2v2 online): "my art the clown jumped from hand and i
// wasnt given a choice of where to play him and he just jumped into lane
// 1 and i didnt get to choose his ability — sledge hammer was just
// chosen, maybe by my AI teammate."
//
// Art arms at the before-tricks boundary, which in 2v2 is usually some
// OTHER seat's turn — often the bot teammate's. Two separate doors then
// handed his owner's choices to that bot:
//
//   1. playJumpCard raised the lane prompt with no declared seat, so
//      promptLaneChoice's AI-stall net saw the bot driving on the same
//      side, re-routed the prompt to it, and it auto-picked lanes[0].
//   2. playCardFree stamps _2v2PlayedBy from the sub-phase seat when no
//      ability owner is bound — the bot again — so Art's weapon picker,
//      which declares { seat: _2v2PlayedBy }, was declared FOR the bot
//      and auto-picked by its heuristic (a lethal Sledgehammer).
//
// The jump's owner is knowable with certainty: it is the seat whose hand
// holds the card. These cases pin that both choices stay with them.
// ============================================================

var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-real.js');

var __cases = [], __passed = 0, __failed = 0, __failures = [];
function t(name, fn) { __cases.push({ name: name, fn: fn }); }
var __caseFailed = false, __caseMsgs = [];
function eq(label, actual, expected) {
  if (actual !== expected) {
    __caseFailed = true;
    __caseMsgs.push(label + ': expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
  }
}

function mkCard(name, side) {
  for (var i = 0; i < CARD_DEFS.length; i++) {
    if (CARD_DEFS[i].name === name) return Game.createCardInstance(CARD_DEFS[i], side);
  }
  throw new Error('no card ' + name);
}

// p1 is the human host; their teammate is a bot that is mid-turn.
function room(jumperName) {
  Game.start2v2Match({ names: { p1: 'P1', p2: 'P2', p3: 'P3', p4: 'P4' } });
  var tt = Game.state.twoVTwo;
  tt.online = true;
  tt.you = 'p1';
  tt.joinedPlayers = { p1: 1, p2: 1, p3: 1, p4: 1 };
  var team = tt.players.p1.team;
  var mate = ['p2', 'p3', 'p4'].filter(function (k) { return tt.players[k].team === team; })[0];
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) {
    tt.players[k].isAI = (k !== 'p1');
    tt.players[k].energy = 10; tt.players[k].usedEnergy = 0;
    tt.players[k].hand = [];
  });
  tt.round = 4; Game.state.round = 4; Game.state.phase = '2v2-play';
  // Put the sub-phase on the BOT TEAMMATE — the before-tricks boundary.
  var ord = Game._2v2ComputePhaseOrder(4);
  for (var i = 0; i < ord.length; i++) {
    if (ord[i].split('-')[0] === mate) { tt.subPhaseIdx = i; break; }
  }
  var mySide = Game._2v2TeamSide[team];
  var oppSide = Game.opponent(mySide);
  for (var l = 0; l < Game.LANE_COUNT; l++) { Game.state.lanes[l].player = null; Game.state.lanes[l].ai = null; }
  // Enemies outnumber us (Art's jump condition) and give the weapons targets.
  Game.state.lanes[0][oppSide] = mkCard('Hulk', oppSide);
  Game.state.lanes[1][oppSide] = mkCard('Bane', oppSide);
  var card = mkCard(jumperName, mySide);
  card.jumpReady = true;
  tt.players.p1.hand.push(card);
  // The bot teammate is actively driving its own turn.
  Game._2v2AIDriving = mate;
  Game._2v2CurrentActingPlayer = null;
  return { tt: tt, mate: mate, card: card, side: mySide };
}

function clearPrompts() {
  var s = Game.state;
  s.pendingCardChoice = null; s.pendingLaneChoice = null; s.pendingJumpOffer = null;
  Game._2v2AIDriving = null;
}

t('JS-1 Art jump while bot teammate drives: lane prompt goes to the jumper', function () {
  var r = room('Art the Clown');
  Game._submit2v2Jump('p1', true, r.tt.players.p1, { card: r.card });
  var lc = Game.state.pendingLaneChoice;
  eq('lane prompt raised (not auto-picked)', !!lc, true);
  eq('lane prompt owner', lc && lc._2v2ActingPlayer, 'p1');
  eq('Art not yet on the board', Game.state.lanes[0][r.side] === r.card, false);
  clearPrompts();
});

t('JS-2 Art lands where the jumper picked, stamped to them, weapon prompt is theirs', function () {
  var r = room('Art the Clown');
  Game._submit2v2Jump('p1', true, r.tt.players.p1, { card: r.card });
  var lc = Game.state.pendingLaneChoice;
  eq('lane prompt raised', !!lc, true);
  if (lc) Game.resolveActivePrompt('lane', { laneIdx: 3 });
  eq('Art in the lane the jumper picked', Game.state.lanes[3][r.side] === r.card, true);
  eq('Art played by', r.card._2v2PlayedBy, 'p1');
  var cc = Game.state.pendingCardChoice;
  eq('weapon prompt raised (not auto-picked)', !!cc, true);
  eq('weapon prompt owner', cc && cc._2v2ActingPlayer, 'p1');
  eq('no weapon spent yet', (r.card._artWeaponsUsed || []).length, 0);
  clearPrompts();
});

t('JS-3 a guest\'s jump over the wire is routed to that guest too', function () {
  var r = room('Art the Clown');
  // Move the card to a human guest on the other team, driven by their bot mate.
  var tt = r.tt;
  var guest = ['p2', 'p3', 'p4'].filter(function (k) { return tt.players[k].team !== tt.players.p1.team; })[0];
  var gmate = ['p2', 'p3', 'p4'].filter(function (k) { return k !== guest && tt.players[k].team === tt.players[guest].team; })[0];
  tt.players[guest].isAI = false;
  tt.players.p1.hand = [];
  var gside = Game._2v2TeamSide[tt.players[guest].team];
  var gopp = Game.opponent(gside);
  for (var l = 0; l < Game.LANE_COUNT; l++) { Game.state.lanes[l].player = null; Game.state.lanes[l].ai = null; }
  Game.state.lanes[0][gopp] = mkCard('Hulk', gopp);
  Game.state.lanes[1][gopp] = mkCard('Bane', gopp);
  var card = mkCard('Art the Clown', gside);
  card.jumpReady = true;
  tt.players[guest].hand.push(card);
  Game._2v2AIDriving = gmate;
  Game._2v2CurrentActingPlayer = null;
  Game._apply2v2OnlineAction({ t: 'play2v2Jump', playerKey: guest, cardId: card.id });
  var lc = Game.state.pendingLaneChoice;
  eq('lane prompt raised', !!lc, true);
  eq('lane prompt owner', lc && lc._2v2ActingPlayer, guest);
  clearPrompts();
});

__cases.forEach(function (c) {
  __caseFailed = false; __caseMsgs = [];
  try { c.fn(); } catch (e) { __caseFailed = true; __caseMsgs.push('threw: ' + (e && e.message || e)); }
  if (__caseFailed) { __failed++; __failures.push({ name: c.name, msgs: __caseMsgs.slice() }); }
  else __passed++;
});
print('jump-seat2v2: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) { print('  - ' + f.name); f.msgs.forEach(function (m) { print('      ' + m); }); });
}
