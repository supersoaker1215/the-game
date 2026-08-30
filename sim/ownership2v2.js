// ============================================================
// 2v2 CARD OWNERSHIP AUDIT — does every card know WHO PLAYED IT, and do its
// abilities go to that person?
//
// The engine already has the ID: Game stamps card._2v2PlayedBy with the seat
// that played it, and _2v2SeatOwning / _2v2RunOwned route a card's prompts back
// to that seat. What was never tested is whether the ENGINE actually sets the
// stamp on every path a card can reach the board — sim/audit2v2.js sets
// `card._2v2PlayedBy = casterSeat` by hand before playing, so it proves the
// ROUTING works given a stamp and says nothing about whether the stamp is
// there. That blind spot is exactly where "someone else got to use my card's
// ability" lives. (User: "an ID system for every card that's linked to who
// played that card, so the owner of the card gets to use the abilities.")
//
// So: never stamp anything here. Play through the real entry points with every
// ambient "who is acting" global deliberately pointed at an ENEMY seat, and
// check what the engine worked out on its own.
//
//   THEFT       a prompt this card raised was handed to a seat that did not
//               play it (the headline bug)
//   UNSTAMPED   the card reached the board with no _2v2PlayedBy at all — it
//               has no ID, so every later hook falls back to guessing
//   MISSTAMPED  it was stamped with the WRONG seat
//   ORPHAN      a prompt with no owning seat — answerable by whoever looks
//   THREW       the path raised an exception
//
//   jsc sim/ownership2v2.js -- [--verbose] [--seat p1|p2|p3|p4]
// ============================================================
load('./sim/shim-real.js');
if (typeof Game._2v2RunOwned !== 'function') Game._2v2RunOwned = function (c, fn) { return fn(); };

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false, ONLY_SEAT = null;
for (var i = 0; i < argv.length; i++) {
  if (argv[i] === '--verbose') VERBOSE = true;
  if (argv[i] === '--seat') ONLY_SEAT = String(argv[i + 1] || '');
}

var SEATS = ['p1', 'p2', 'p3', 'p4'];
var findings = [];
var stats = { played: 0, prompts: 0, stamped: 0 };
function note(card, kind, detail) { findings.push({ card: card, kind: kind, detail: detail }); }

function mkCard(name, side) {
  for (var i = 0; i < CARD_DEFS.length; i++) {
    if (CARD_DEFS[i].name === name) return Game.createCardInstance(CARD_DEFS[i], side);
  }
  return null;
}
var BODIES = ['Hulk', 'Godzilla', 'Venom', 'Bane', 'Joker', 'King Shark', 'Man-Bat', 'Gremlin'];

// A room where EVERY seat is human. An AI seat auto-resolves its own prompts,
// which would mask a theft as a silent success — if nobody is a bot, a prompt
// that lands on the wrong seat stays there to be seen.
function room(caster) {
  Game.start2v2Match({ names: { p1: 'P1', p2: 'P2', p3: 'P3', p4: 'P4' } });
  var tt = Game.state.twoVTwo;
  tt.online = true;
  tt.you = 'p1';
  tt.joinedPlayers = { p1: 1, p2: 1, p3: 1, p4: 1 };
  SEATS.forEach(function (k) {
    tt.players[k].isAI = false;
    tt.players[k].energy = 40; tt.players[k].usedEnergy = 0;
  });
  tt.round = 4; Game.state.round = 4; Game.state.phase = '2v2-play';
  var ord = Game._2v2ComputePhaseOrder(4);
  for (var i = 0; i < ord.length; i++) {
    if (ord[i].split('-')[0] === caster) { tt.subPhaseIdx = i; break; }
  }
  tt.drawPile = [];
  for (var d = 0; d < 40; d++) tt.drawPile.push(CARD_DEFS[d % CARD_DEFS.length]);
  tt.trickDrawPile = TRICK_DEFS.slice(0);
  return tt;
}

// Point every ambient signal at an ENEMY seat. If the engine still routes to
// the caster, it did so because the CARD knows who played it.
function scramble(decoy) {
  Game._2v2CurrentActingPlayer = decoy;
  Game._2v2AIDriving = null;
}

// Prompts that deliberately address a seat OTHER than the caster, matched on
// the prompt TITLE. Symbiote Spider-Man cycles ALL FOUR hands — each seat picks
// from their OWN hand, so three of its four prompts belong to somebody else by
// design. Matched on title, not on the card under test, because free-play
// effects (Paul Atreides, Knull) can raise it under another card's name.
var PROMPT_TITLES_FOR_OTHERS = [/^Symbiote Spider-Man/];
function promptMayTargetOthers(title) {
  return PROMPT_TITLES_FOR_OTHERS.some(function (re) { return re.test(String(title || '')); });
}

// Drain whatever the card asked for, checking WHO was asked each time.
function drain(label, caster, casterSide, tt) {
  var guard = 0;
  while (guard++ < 40) {
    var s = Game.state;
    var p = s.pendingCardChoice || s.pendingLaneChoice;
    if (!p) break;
    stats.prompts++;
    var seat = p._2v2ActingPlayer;
    if (!seat) {
      note(label, 'ORPHAN', '"' + (p.title || '?') + '" has no owning seat');
    } else if (seat !== caster) {
      // A prompt aimed at the OTHER TEAM is legitimate — the Grinch makes his
      // victim choose, Symbiote cycles all four hands. What is never legitimate
      // is a prompt on the CASTER'S OWN side being answered by anyone else,
      // teammate included.
      var sameSide = p.owner ? Game._2v2SeatOnSide(seat, p.owner) : true;
      if (promptMayTargetOthers(p.title)) {
        // by design — each seat answers for their own hand
      } else if (!p.owner || p.owner === casterSide) {
        note(label, 'THEFT', '"' + (p.title || '?') + '" → ' + seat
          + ' but ' + caster + ' played the card'
          + (tt.players[seat] && tt.players[seat].team === tt.players[caster].team ? ' (teammate)' : ' (opponent!)'));
      } else if (!sameSide) {
        note(label, 'ORPHAN', '"' + (p.title || '?') + '" → ' + seat + ' is not on owning side ' + p.owner);
      }
    }
    // ANSWER IT THROUGH THE ENGINE'S OWN DOOR. Calling prompt.callback()
    // directly — which this used to do — skips resolveActivePrompt, and that
    // is where the engine re-binds the owning seat for the duration of the
    // callback (_2v2WithSeatBound). Skipping it means every CHAINED prompt in
    // the harness is raised with nothing remembering the owner, so the harness
    // manufactures the exact theft it is looking for. Resolve as that seat's
    // own client would: promptIsMine gates on tt.you, so borrow it.
    var answering = seat || tt.you;
    var youWas = tt.you;
    tt.you = answering;
    try {
      if (s.pendingCardChoice) {
        var ok = Game.resolveActivePrompt('card', { idx: 0 });
        if (!ok) { var cc = s.pendingCardChoice; s.pendingCardChoice = null;
                   try { if (cc && cc.callback) cc.callback(cc.cards && cc.cards[0]); } catch (e) {} }
      } else {
        var lc0 = s.pendingLaneChoice;
        var lane0 = (lc0 && lc0.lanes && lc0.lanes[0]) || 0;
        var ok2 = Game.resolveActivePrompt('lane', { laneIdx: lane0 });
        if (!ok2) { s.pendingLaneChoice = null;
                    try { if (lc0 && lc0.callback) lc0.callback(lane0); } catch (e) {} }
      }
    } catch (e) {
      note(label, 'THREW', 'resolving "' + (p.title || '?') + '": ' + (e.message || e));
      s.pendingCardChoice = null; s.pendingLaneChoice = null;
    } finally { tt.you = youWas; }
    if (Game.state.pendingBlockTrick) Game.state.pendingBlockTrick = null;
    if (Game.state.pendingJumpOffer) Game.state.pendingJumpOffer = null;
    try { Game.cleanupDead(); } catch (e) {}
  }
}

function auditCard(def, caster) {
  if (def._spawnOnly) return;
  var tt = room(caster);
  var team = tt.players[caster].team;
  var mySide = Game._2v2TeamSide[team];
  var oppSide = mySide === 'player' ? 'ai' : 'player';
  var decoy = SEATS.filter(function (k) { return tt.players[k].team !== team; })[0];

  // Bodies on both sides so targeted abilities find something.
  for (var l = 0; l < 4; l++) { var e = mkCard(BODIES[l % BODIES.length], oppSide); if (e) Game.state.lanes[l][oppSide] = e; }
  for (var l2 = 0; l2 < 3; l2++) { var a = mkCard(BODIES[l2 % BODIES.length], mySide); if (a) Game.state.lanes[l2 + 4][mySide] = a; }
  SEATS.forEach(function (k) {
    var sd = Game._2v2TeamSide[tt.players[k].team];
    tt.players[k].hand = ['Hulk', 'Venom', 'Bane'].map(function (n) { return mkCard(n, sd); }).filter(Boolean);
    tt.players[k].trickHand = TRICK_DEFS.slice(0, 2).map(function (t) { return Object.assign({}, t); });
  });

  // THE CARD UNDER TEST — into the caster's hand, and NOT stamped by us.
  var card = Game.createCardInstance(def, mySide);
  card.cost = 0;                       // affordability is not what is being tested
  tt.players[caster].hand.unshift(card);
  var label = def.name;

  stats.played++;
  scramble(decoy);
  try {
    Game._2v2OnlinePlayCard(caster, 0, card.isDiscardEffect ? 0 : 7, false);
  } catch (e) {
    note(label, 'THREW', 'on play: ' + (e.message || e));
  }

  // ---- 1. did the engine give the card an ID, and the right one? ----
  if (!card._2v2PlayedBy) {
    note(label, 'UNSTAMPED', 'reached play with no _2v2PlayedBy — later hooks can only guess');
  } else if (card._2v2PlayedBy !== caster) {
    note(label, 'MISSTAMPED', 'stamped ' + card._2v2PlayedBy + ' but ' + caster + ' played it');
  } else {
    stats.stamped++;
  }
  drain(label, caster, mySide, tt);

  // ---- 2. the LATER hooks, with every global pointing elsewhere ----
  // These are where ownership is hardest: they run during combat or another
  // seat's turn, long after the play, when nothing ambient remembers the caster.
  var victim = Game.state.lanes[0][oppSide] || mkCard('Hulk', oppSide);
  var ally = Game.state.lanes[4][mySide] || mkCard('Venom', mySide);
  Game.state.lanes[7][mySide] = card;
  var LATER = [
    ['onBeforeTricks', [Game, card, 7]],
    ['onEndOfTurn', [Game, card, 7]],
    ['onDamaged', [Game, card, 2, victim]],
    ['onKill', [Game, card, victim]],
    ['onAllyKilled', [Game, card, ally]],
    ['onAnyCardPlayed', [Game, card, victim]],
    ['onEvade', [Game, card, victim]],
    ['onBeforeAttack', [Game, card, 7]],
    ['onTurnStart', [Game, card]],
    ['onDeath', [Game, card, 7]]
  ];
  LATER.forEach(function (pair) {
    var h = pair[0];
    if (typeof card[h] !== 'function') return;
    scramble(decoy);                       // nothing ambient remembers the caster
    Game.state.lanes[7][mySide] = card;
    try {
      // Through _2v2RunOwned, which is how the engine fires owned hooks.
      Game._2v2RunOwned(card, function () { Game._runHook.apply(Game, [card, h].concat(pair[1])); });
    } catch (e) { note(label + ' ' + h, 'THREW', (e.message || e)); }
    drain(label + ' ' + h, caster, mySide, tt);
  });
}

// A TRICK IS PLAYED BY SOMEBODY TOO. Same question, different door: play it
// through the real 2v2 entry point with every ambient global pointing at an
// enemy, and see whether the prompts it raises come back to the seat that
// spent the card.
function auditTrick(def, caster) {
  var tt = room(caster);
  var team = tt.players[caster].team;
  var mySide = Game._2v2TeamSide[team];
  var oppSide = mySide === 'player' ? 'ai' : 'player';
  var decoy = SEATS.filter(function (k) { return tt.players[k].team !== team; })[0];
  for (var l = 0; l < 4; l++) { var e = mkCard(BODIES[l % BODIES.length], oppSide); if (e) Game.state.lanes[l][oppSide] = e; }
  for (var l2 = 0; l2 < 3; l2++) { var a = mkCard(BODIES[l2 % BODIES.length], mySide); if (a) Game.state.lanes[l2 + 4][mySide] = a; }
  SEATS.forEach(function (k) {
    var sd = Game._2v2TeamSide[tt.players[k].team];
    tt.players[k].hand = ['Hulk', 'Venom', 'Bane'].map(function (n) { return mkCard(n, sd); }).filter(Boolean);
    tt.players[k].trickHand = TRICK_DEFS.slice(0, 2).map(function (t) { return Object.assign({}, t); });
  });
  var trick = Object.assign({}, def);
  trick.cost = 0;
  tt.players[caster].trickHand.unshift(trick);
  var label = 'TRICK ' + def.name;
  stats.played++;
  scramble(decoy);
  try { Game._2v2OnlinePlayTrick(caster, 0); }
  catch (e) { note(label, 'THREW', 'on play: ' + (e.message || e)); }
  if (!trick._2v2PlayedBy) {
    note(label, 'UNSTAMPED', 'played with no _2v2PlayedBy — its prompts can only be routed by guesswork');
  } else if (trick._2v2PlayedBy !== caster) {
    note(label, 'MISSTAMPED', 'stamped ' + trick._2v2PlayedBy + ' but ' + caster + ' played it');
  } else { stats.stamped++; }
  drain(label, caster, mySide, tt);
}

// ---- run -------------------------------------------------------------------
var _origErr = console.error; console.error = function () {};
var CASTERS = ONLY_SEAT ? [ONLY_SEAT] : ['p3', 'p2'];
CASTERS.forEach(function (caster) {
  CARD_DEFS.forEach(function (d) {
    try { auditCard(d, caster); }
    catch (e) { note(d.name, 'THREW', 'harness: ' + (e.message || e)); }
  });
  TRICK_DEFS.forEach(function (t) {
    try { auditTrick(t, caster); }
    catch (e) { note('TRICK ' + t.name, 'THREW', 'harness: ' + (e.message || e)); }
  });
});
console.error = _origErr;

print('=== 2v2 CARD OWNERSHIP AUDIT ===');
print('casters tested: ' + CASTERS.join(', '));
print('cards played through the real engine path: ' + stats.played
  + '   correctly ID-stamped: ' + stats.stamped
  + '   prompts checked: ' + stats.prompts);
var byKind = {};
findings.forEach(function (f) { (byKind[f.kind] = byKind[f.kind] || []).push(f); });
var ORDER = ['THEFT', 'MISSTAMPED', 'UNSTAMPED', 'ORPHAN', 'THREW'];
var total = 0;
ORDER.forEach(function (k) {
  var list = byKind[k] || [];
  total += list.length;
  if (!list.length) { print('  ' + k + ': none'); return; }
  // Collapse duplicates — the same card is run once per caster seat.
  var seen = {}, uniq = [];
  list.forEach(function (f) {
    var key = f.card + '|' + f.detail.replace(/\bp[1-4]\b/g, '#');
    if (seen[key]) return; seen[key] = 1; uniq.push(f);
  });
  print('  ' + k + ': ' + list.length + ' (' + uniq.length + ' distinct)');
  uniq.slice(0, VERBOSE ? 999 : 25).forEach(function (f) { print('      ' + f.card + ' — ' + f.detail); });
  if (!VERBOSE && uniq.length > 25) print('      … ' + (uniq.length - 25) + ' more (--verbose)');
});
print(total ? ('TOTAL FINDINGS: ' + total)
            : 'NO FINDINGS — every card carries the seat that played it, and every ability went to that seat.');
