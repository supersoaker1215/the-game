// ============================================================
// 2v2 AI-CASTER STALL SWEEP — plays EVERY card as an AI SEAT with the AI-drive
// context active, then checks whether the card left any prompt pending. In a
// live game an AI seat cannot answer a prompt, so a lingering prompt IS the
// "the AI played X and the table froze" stall the owner hit (Symbiote
// Spider-Man, Human Torch, …). The engine is supposed to auto-pick every such
// prompt for the driving AI; anything this reports is a card that does not.
//
//   jsc sim/aiStall2v2.js -- [--verbose]
// ============================================================
load('./sim/shim-real.js');
if (typeof Game._2v2RunOwned !== 'function') Game._2v2RunOwned = function (c, fn) { return fn(); };

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

function mkCard(name, side) {
  var def = null;
  for (var i = 0; i < CARD_DEFS.length; i++) if (CARD_DEFS[i].name === name) def = CARD_DEFS[i];
  return def ? Game.createCardInstance(def, side) : null;
}

// A fresh online 2v2 room. CASTER is p2, an AI seat on team B; its teammate p4
// is a HUMAN (the exact hazard — a same-side human a mis-routed prompt strands).
// The opposing team (p1, p3) is human too. Board is fully populated so target
// pickers find enemies and allies.
var BODIES = ['Hulk', 'Godzilla', 'Venom', 'Bane', 'Joker', 'King Shark', 'Man-Bat', 'Gremlin'];
function room() {
  Game.start2v2Match({ names: { p1: 'HumanA1', p2: 'Vega', p3: 'HumanA2', p4: 'HumanB2' } });
  var tt = Game.state.twoVTwo;
  tt.online = true;
  tt.you = 'p1';
  tt.joinedPlayers = { p1: 1, p2: 1, p3: 1, p4: 1 };
  // p2 is the AI caster; everyone else human.
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) {
    tt.players[k].isAI = (k === 'p2');
    tt.players[k].energy = 12; tt.players[k].usedEnergy = 0;
  });
  tt.round = 4; Game.state.round = 4; tt.subPhaseIdx = 0; Game.state.phase = '2v2-play';
  return tt;
}
function populate(mySide, oppSide) {
  var oppI = 0, myI = 0;
  for (var l = 0; l < 4; l++) {
    var e = mkCard(BODIES[(oppI++) % BODIES.length], oppSide);
    if (e) Game.state.lanes[l][oppSide] = e;
  }
  for (var l2 = 0; l2 < 3; l2++) {
    var a = mkCard(BODIES[(myI++) % BODIES.length], mySide);
    if (a) Game.state.lanes[l2 + 4][mySide] = a;
  }
}

function pendingKind() {
  var s = Game.state;
  if (s.pendingCardChoice) return 'cardChoice "' + s.pendingCardChoice.title + '"';
  if (s.pendingLaneChoice) return 'laneChoice "' + s.pendingLaneChoice.title + '"';
  if (s.pendingKangChoice) return 'kangChoice';
  if (s.pendingBlockTrick) return 'blockTrick';
  if (s.pendingJumpOffer) return 'jumpOffer';
  return null;
}

var stalls = [];
var threw = [];
var tested = 0;

CARD_DEFS.forEach(function (def) {
  if (def._spawnOnly) return;
  tested++;
  var tt = room();
  var casterSeat = 'p2';
  var mySide = Game._2v2TeamSide[tt.players[casterSeat].team];   // team B side
  var oppSide = mySide === 'player' ? 'ai' : 'player';
  populate(mySide, oppSide);
  // Give every seat a hand + tricks so shuffle/discard/steal effects have material.
  ['p1', 'p2', 'p3', 'p4'].forEach(function (k) {
    var side = Game._2v2TeamSide[tt.players[k].team];
    tt.players[k].hand = ['Hulk', 'Venom', 'Bane', 'Joker'].map(function (n) { return mkCard(n, side); }).filter(Boolean);
    tt.players[k].trickHand = TRICK_DEFS.slice(0, 2).map(function (t) { return Object.assign({}, t); });
  });
  tt.drawPile = [];
  for (var d = 0; d < 30; d++) tt.drawPile.push(CARD_DEFS[d % CARD_DEFS.length]);

  var card = Game.createCardInstance(def, mySide);
  card._2v2PlayedBy = casterSeat;
  // THE AI-DRIVE CONTEXT. This is what the real _2v2DriveAISeat sets before an
  // AI seat plays: the driving-seat flag + the acting-player global. The stall
  // fix keys on exactly these.
  Game._2v2AIDriving = casterSeat;
  Game._2v2AIDrivingAt = Date.now();
  Game._2v2CurrentActingPlayer = casterSeat;

  try {
    if (card.isDiscardEffect) {
      if (typeof card.onDiscard === 'function') Game._2v2RunOwned(card, function () { card.onDiscard(Game, mySide, card); });
    } else {
      var lane = 7;
      Game.state.lanes[lane][mySide] = card;
      if (typeof card.onPlay === 'function') Game._runHook(card, 'onPlay', Game, card, lane);
    }
    // Give any deferred/queued prompt a chance to arm, then let the engine drain.
    Game.resumeCombatIfWaiting();
  } catch (e) {
    threw.push({ name: def.name, err: (e && e.message) || String(e) });
  }

  var pend = pendingKind();
  if (pend) {
    // Distinguish a prompt correctly handed to a HUMAN OPPONENT (legitimate) from
    // one stranded on the AI's own side / a same-side human / the host.
    var s = Game.state;
    var p = s.pendingCardChoice || s.pendingLaneChoice;
    var seat = p && p._2v2ActingPlayer;
    var owner = p && p.owner;
    var onCasterSide = owner ? Game._2v2SeatOnSide(casterSeat, owner) : true;
    stalls.push({ name: def.name, pend: pend, seat: seat || '(none)', owner: owner, onCasterSide: onCasterSide });
  }

  // Clean up so the next card starts fresh.
  Game._2v2AIDriving = null;
  Game.state.pendingCardChoice = null; Game.state.pendingLaneChoice = null;
  Game.state.pendingKangChoice = null; Game.state.pendingBlockTrick = null; Game.state.pendingJumpOffer = null;
});

print('=== 2v2 AI-CASTER STALL SWEEP ===');
print('cards tested: ' + tested);
print('THREW: ' + threw.length);
threw.forEach(function (t) { if (VERBOSE) print('  THREW ' + t.name + ': ' + t.err); });
print('STALLS (prompt left pending after an AI seat played it): ' + stalls.length);
stalls.forEach(function (s) {
  print('  STALL ' + s.name + ' → ' + s.pend + '  actingSeat=' + s.seat
        + ' owner=' + s.owner + (s.onCasterSide ? ' [caster-side]' : ' [opponent-side]'));
});
if (!stalls.length) print('NO STALLS — every card an AI seat played resolved without leaving a prompt.');
