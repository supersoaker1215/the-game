// ============================================================
// 2v2 ABILITY AUDIT — plays EVERY card and EVERY trick in a 2v2 online
// room and reports anything that would hold the table up:
//
//   THREW      the hook raised an exception (the engine swallows these into
//              console.error, so in a live game the card just does nothing)
//   UNOWNED    it raised a prompt with no owning seat — in a 2v2 room that
//              prompt shows up for whoever is looking and can be answered by
//              the wrong person, or by nobody
//   MISROUTED  it raised a prompt owned by a seat on the WRONG TEAM
//   STUCK      after resolving every prompt it raised, the table still could
//              not advance (this is the "holdup" the owner cares about)
//   NOFIRE     the card declares a hook that never ran when it was played
//
// Every card gets a clean room, a full board of live enemies and allies, and
// a hand + trick hand, so abilities that need targets actually find them.
//
//   jsc sim/audit2v2.js -- [--verbose]
// ============================================================
load('./sim/shim-real.js');

// Run against older builds too, so a fix can be shown to actually fix
// something: the owner binder is a recent addition.
if (typeof Game._2v2RunOwned !== 'function') Game._2v2RunOwned = function (c, fn) { return fn(); };

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

var SEATS = ['p1', 'p2', 'p3', 'p4'];
var findings = [];   // { card, kind, detail }
var stats = { cards: 0, tricks: 0, prompts: 0, clean: 0 };

function note(card, kind, detail) {
  findings.push({ card: card, kind: kind, detail: detail || '' });
}

// ---- a fresh 2v2 online room with a populated board ------------------------
// CASTER is always p3 (a human guest on team A) — the seat whose prompts have
// historically gone astray, and the one the owner plays from.
function room() {
  Game.start2v2Match({ names: { p1: 'Ally', p2: 'EnemyA', p3: 'Caster', p4: 'EnemyB' } });
  var tt = Game.state.twoVTwo;
  tt.online = true;
  tt.you = 'p1';                       // this client is the HOST engine
  tt.joinedPlayers = { p1: 1, p2: 1, p3: 1, p4: 1 };
  SEATS.forEach(function (k) { tt.players[k].isAI = false; tt.players[k].energy = 12; tt.players[k].usedEnergy = 0; });
  tt.round = 4;
  Game.state.round = 4;
  tt.subPhaseIdx = 0;
  Game.state.phase = '2v2-play';
  return tt;
}

var BODIES = ['Hulk', 'Godzilla', 'Venom', 'Bane', 'Joker', 'King Shark', 'Man-Bat', 'Gremlin'];
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
function mkCard(name, side) {
  var def = null;
  for (var i = 0; i < CARD_DEFS.length; i++) if (CARD_DEFS[i].name === name) def = CARD_DEFS[i];
  return def ? Game.createCardInstance(def, side) : null;
}

// ---- resolve whatever the card asked for, checking WHO was asked -----------
// Cards that prompt a seat OTHER than the caster on purpose. Symbiote asks all
// four players to cycle their own hand, so three of its four prompts are
// legitimately somebody else's.
var PROMPTS_OTHERS = { 'Symbiote Spider-Man': 1, 'Symbiote Spider-Man (deferred)': 1 };

function drainPrompts(cardName, casterSeat, casterTeam, casterSide) {
  var tt = Game.state.twoVTwo, guard = 0;
  while (guard++ < 40) {
    var s = Game.state;
    var p = s.pendingCardChoice || s.pendingLaneChoice;
    if (!p) break;
    stats.prompts++;
    var seat = p._2v2ActingPlayer;
    if (!seat) {
      note(cardName, 'UNOWNED', '"' + (p.title || '?') + '"');
    } else if (seat !== casterSeat && Game.state.twoVTwo.players[seat]
               && Game.state.twoVTwo.players[seat].isAI) {
      note(cardName, 'ANSWEREDBYAI', '"' + (p.title || '?') + '" → ' + seat + ' [AI] instead of the human who played the card');
    } else if (casterSide && p.owner === casterSide && seat !== casterSeat && !PROMPTS_OTHERS[cardName]) {
      // THE ONE THAT MATTERS: a prompt on the CASTER's own side that somebody
      // else got to answer. The seat may be perfectly "valid" — the host, the
      // teammate — and still be the wrong person, because the card is not
      // theirs. (User: "the person who plays a card ... gets to use the ability
      // and it never goes to the Host or an AI opponent.")
      note(cardName, 'WRONGSEAT', '"' + (p.title || '?') + '" → ' + seat + ' instead of ' + casterSeat + ', who played it');
    } else if (p.owner && Game._2v2SeatOnSide && !Game._2v2SeatOnSide(seat, p.owner)) {
      // The prompt's OWNER is a side; the seat answering it must be on that
      // side. A prompt deliberately aimed at an enemy seat (Symbiote cycles
      // all four hands; the Grinch's victim picks which trick to give up)
      // carries that enemy's side as its owner, so it passes — while a prompt
      // that leaked to the wrong side still fails.
      note(cardName, 'MISROUTED', '"' + (p.title || '?') + '" → ' + seat + ' but the prompt is owned by side ' + p.owner);
    }
    if (s.pendingCardChoice) {
      var cc = s.pendingCardChoice;
      s.pendingCardChoice = null;
      if (seat) Game._2v2CurrentActingPlayer = seat;
      try { if (cc.callback) cc.callback(cc.cards[0]); }
      catch (e) { note(cardName, 'THREW', 'in a card-choice callback: ' + (e.message || e)); }
    } else {
      var lc = s.pendingLaneChoice;
      s.pendingLaneChoice = null;
      if (seat) Game._2v2CurrentActingPlayer = seat;
      try { if (lc.callback) lc.callback((lc.lanes && lc.lanes[0]) || 0); }
      catch (e) { note(cardName, 'THREW', 'in a lane-choice callback: ' + (e.message || e)); }
    }
    // block-trick / jump offers park hasPendingPrompt the same way
    if (Game.state.pendingBlockTrick) Game.state.pendingBlockTrick = null;
    if (Game.state.pendingJumpOffer) Game.state.pendingJumpOffer = null;
    try { Game.cleanupDead(); Game.resumeCombatIfWaiting(); } catch (e) {}
  }
  if (guard >= 40) note(cardName, 'STUCK', 'prompt chain never drained (40 iterations)');
}

// ---- can the table still act after this card resolved? --------------------
function assertNotHeldUp(cardName) {
  if (Game._2v2ActionsLocked && Game._2v2ActionsLocked()) {
    var s = Game.state;
    var why = s.pendingCardChoice ? 'card choice "' + s.pendingCardChoice.title + '"'
            : s.pendingLaneChoice ? 'lane choice "' + s.pendingLaneChoice.title + '"'
            : s.pendingBlockTrick ? 'block trick'
            : s.pendingKangChoice ? 'kang choice'
            : s.pendingJumpOffer ? 'jump offer'
            : (s._pendingAIActions > 0) ? 'AI action delay x' + s._pendingAIActions
            : Game.state.twoVTwo._resolving ? 'before-tricks boundary' : 'unknown';
    note(cardName, 'STUCK', 'table still locked after resolution: ' + why);
    // unstick so the next card starts clean
    s.pendingCardChoice = null; s.pendingLaneChoice = null; s.pendingBlockTrick = null;
    s.pendingKangChoice = null; s.pendingJumpOffer = null; s._pendingAIActions = 0;
    Game.state.twoVTwo._resolving = false;
  }
}

// ---- one card ------------------------------------------------------------
function auditCard(def) {
  if (def._spawnOnly) return;   // never dealt or played; only spawned
  stats.cards++;
  var tt = room();
  var casterSeat = 'p3', casterTeam = tt.players.p3.team;
  var mySide = Game._2v2TeamSide[casterTeam];
  var oppSide = mySide === 'player' ? 'ai' : 'player';
  populate(mySide, oppSide);
  // a hand and tricks so discard/steal/shuffle effects have material
  SEATS.forEach(function (k) {
    var side = Game._2v2TeamSide[tt.players[k].team];
    tt.players[k].hand = ['Hulk', 'Venom', 'Bane', 'Joker'].map(function (n) { return mkCard(n, side); }).filter(Boolean);
    tt.players[k].trickHand = TRICK_DEFS.slice(0, 2).map(function (t) { return Object.assign({}, t); });
  });

  var card = Game.createCardInstance(def, mySide);
  card._2v2PlayedBy = casterSeat;
  // HOSTILE CONDITIONS, ON PURPOSE. The card is played by a HUMAN GUEST (p3),
  // and then every signal the engine could lean on is set WRONG: the acting
  // seat is cleared, an AI seat is marked as driving, and the "active" seat is
  // an AI on the other team. If a prompt still finds p3, it found them because
  // the card knows who played it — not because a global happened to be right.
  // (User: "the person who played it gets to use the ability and it never goes
  // to the Host or an AI opponent.")
  tt.players.p2.isAI = true;
  tt.players.p4.isAI = true;
  Game._2v2CurrentActingPlayer = null;
  Game._2v2AIDriving = 'p2';
  Game._2v2ActivePlayer = function () { return 'p2'; };

  var hooks = [];
  ['onPlay', 'onDiscard', 'onBeforeTricks', 'onEndOfTurn', 'onDeath',
   'onDamaged', 'onKill', 'onAllyKilled', 'onAnyCardPlayed', 'onEvade',
   'onBeforeAttack', 'onTurnStart'].forEach(function (h) {
    if (typeof card[h] === 'function') hooks.push(h);
  });

  var fired = {};
  // PASS 1 — the ordinary path, played through the hook runner so the ability
  // owner is bound the way the engine binds it.
  try {
    if (card.isDiscardEffect) {
      if (typeof card.onDiscard === 'function') { fired.onDiscard = 1; Game._2v2RunOwned(card, function () { card.onDiscard(Game, mySide, card); }); }
    } else {
      var lane = 7;
      Game.state.lanes[lane][mySide] = card;
      if (typeof card.onPlay === 'function') { fired.onPlay = 1; Game._runHook(card, 'onPlay', Game, card, lane); }
    }
  } catch (e) {
    note(def.name, 'THREW', (e.message || e));
  }
  drainPrompts(def.name, casterSeat, casterTeam, mySide);

  // PASS 2 — THE DEFERRED ARM. The same card, but something is already holding
  // the prompt slot when it plays, so its prompt goes into the queue and
  // re-arms LATER — after the hook returned, with every global moved on to the
  // AI seat whose turn it now is. This is the shape of "a guest played a card
  // and the host got the prompt": the queue used to re-derive the seat from the
  // owning TEAM at drain time, which lands on the first human on that team.
  (function deferredPass() {
    var card2 = Game.createCardInstance(def, mySide);
    card2._2v2PlayedBy = casterSeat;
    Game.state.pendingCardChoice = { owner: mySide, cards: [{ id: 999999, name: 'blocker', currentHealth: 1 }], title: 'blocker', callback: function () {} };
    try {
      if (card2.isDiscardEffect) {
        if (typeof card2.onDiscard === 'function') Game._2v2RunOwned(card2, function () { card2.onDiscard(Game, mySide, card2); });
      } else {
        Game.state.lanes[6][mySide] = card2;
        if (typeof card2.onPlay === 'function') Game._runHook(card2, 'onPlay', Game, card2, 6);
      }
    } catch (e) { /* pass 1 already reported anything that throws */ }
    // release the blocker into a world where nothing remembers the caster
    Game.state.pendingCardChoice = null;
    Game._2v2CurrentActingPlayer = null;
    Game._2v2AIDriving = 'p2';
    try { Game.resumeCombatIfWaiting(); } catch (e) {}
    drainPrompts(def.name + ' (deferred)', casterSeat, casterTeam, mySide);
  })();

  // recurring hooks: they must survive a second round too
  try {
    if (typeof card.onBeforeTricks === 'function') {
      Game.state.round = 5; tt.round = 5;
      fired.onBeforeTricks = 1;
      Game._runHook(card, 'onBeforeTricks', Game, card, 7);
      drainPrompts(def.name, casterSeat, casterTeam, mySide);
    }
  } catch (e) { note(def.name, 'THREW', 'onBeforeTricks: ' + (e.message || e)); }
  try {
    if (typeof card.onEndOfTurn === 'function') {
      fired.onEndOfTurn = 1;
      Game._runHook(card, 'onEndOfTurn', Game, card, 7);
      drainPrompts(def.name, casterSeat, casterTeam, mySide);
    }
  } catch (e) { note(def.name, 'THREW', 'onEndOfTurn: ' + (e.message || e)); }
  // The REACTIVE hooks — fired the way combat fires them, with the card on the
  // board and a live victim/attacker to hand. These are the ones that run
  // DURING combat, where the acting seat is least likely to still be set, so
  // they are exactly where a 2v2 prompt goes astray or a throw eats the rest
  // of the lane.
  var victim = Game.state.lanes[0][oppSide] || mkCard('Hulk', oppSide);
  var ally   = Game.state.lanes[4][mySide]  || mkCard('Venom', mySide);
  Game.state.lanes[7][mySide] = card;
  [['onDamaged', [Game, card, 2, victim]],
   ['onKill', [Game, card, victim]],
   ['onAllyKilled', [Game, card, ally]],
   ['onAnyCardPlayed', [Game, card, victim]],
   ['onEvade', [Game, card, victim]],
   ['onBeforeAttack', [Game, card, 7]],
   ['onTurnStart', [Game, card]]].forEach(function (pair) {
    var h = pair[0];
    if (typeof card[h] !== 'function') return;
    try {
      fired[h] = 1;
      Game._runHook.apply(Game, [card, h].concat(pair[1]));
      drainPrompts(def.name, casterSeat, casterTeam, mySide);
    } catch (e) { note(def.name, 'THREW', h + ': ' + (e.message || e)); }
  });

  try {
    if (typeof card.onDeath === 'function') {
      // The engine fires onDeath from handleDeath with the card STILL in its
      // lane and the real lane index — match that, or every hook that reads
      // lanes[laneIdx] throws on a harness artefact instead of a real bug.
      var dLane = 7;
      Game.state.lanes[dLane][mySide] = card;
      fired.onDeath = 1;
      Game._runHook(card, 'onDeath', Game, card, dLane);
      drainPrompts(def.name, casterSeat, casterTeam, mySide);
    }
  } catch (e) { note(def.name, 'THREW', 'onDeath: ' + (e.message || e)); }

  hooks.forEach(function (h) { if (!fired[h]) note(def.name, 'NOFIRE', h + ' declared but never ran'); });
  assertNotHeldUp(def.name);
}

// ---- one trick -----------------------------------------------------------
function auditTrick(def) {
  stats.tricks++;
  var tt = room();
  var casterSeat = 'p3', casterTeam = tt.players.p3.team;
  var mySide = Game._2v2TeamSide[casterTeam];
  var oppSide = mySide === 'player' ? 'ai' : 'player';
  populate(mySide, oppSide);
  SEATS.forEach(function (k) {
    var side = Game._2v2TeamSide[tt.players[k].team];
    tt.players[k].hand = ['Hulk', 'Venom', 'Bane'].map(function (n) { return mkCard(n, side); }).filter(Boolean);
    tt.players[k].trickHand = [Object.assign({}, def)];
  });
  Game._2v2CurrentActingPlayer = casterSeat;
  Game._2v2ActivePlayer = function () { return casterSeat; };
  try { Game._2v2OnlinePlayTrick(casterSeat, 0); }
  catch (e) { note('TRICK ' + def.name, 'THREW', (e.message || e)); }
  drainPrompts('TRICK ' + def.name, casterSeat, casterTeam, mySide);
  assertNotHeldUp('TRICK ' + def.name);
}

// ---- run -----------------------------------------------------------------
var _origErr = console.error;
var swallowed = [];
console.error = function () {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) { var a = arguments[i]; parts.push(a && a.message ? a.message : String(a)); }
  swallowed.push(parts.join(' '));
};

CARD_DEFS.forEach(function (d) {
  try { auditCard(d); }
  catch (e) { note(d.name, 'THREW', 'audit harness: ' + (e.message || e)); }
});
TRICK_DEFS.forEach(function (t) {
  try { auditTrick(t); }
  catch (e) { note('TRICK ' + t.name, 'THREW', 'audit harness: ' + (e.message || e)); }
});

console.error = _origErr;

print('=== 2v2 ABILITY AUDIT ===');
print('cards played: ' + stats.cards + '   tricks played: ' + stats.tricks + '   prompts raised: ' + stats.prompts);
var byKind = {};
findings.forEach(function (f) { (byKind[f.kind] = byKind[f.kind] || []).push(f); });
var order = ['THREW', 'STUCK', 'UNOWNED', 'ANSWEREDBYAI', 'WRONGSEAT', 'MISROUTED', 'NOFIRE'];
var total = 0;
order.forEach(function (k) {
  var list = byKind[k] || [];
  total += list.length;
  if (!list.length) { print('  ' + k + ': none'); return; }
  print('  ' + k + ': ' + list.length);
  list.slice(0, VERBOSE ? 999 : 20).forEach(function (f) { print('      ' + f.card + ' — ' + f.detail); });
  if (!VERBOSE && list.length > 20) print('      … ' + (list.length - 20) + ' more (--verbose)');
});
print(total ? ('TOTAL FINDINGS: ' + total) : 'NO FINDINGS — every card and trick resolved and released the table.');
if (swallowed.length) {
  var uniq = {};
  swallowed.forEach(function (e) { uniq[String(e).slice(0, 120)] = (uniq[String(e).slice(0, 120)] || 0) + 1; });
  print('--- engine console.error during the run (' + swallowed.length + ') ---');
  Object.keys(uniq).slice(0, 15).forEach(function (k) { print('  ' + uniq[k] + 'x  ' + k); });
}
