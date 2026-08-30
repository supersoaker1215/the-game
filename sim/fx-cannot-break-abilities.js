// ============================================================
// A SOUND MUST NEVER KILL AN ABILITY.
//
// Card code calls UI.sfx.* and UI._fx* directly, and _runHookBody catches
// whatever an onPlay throws into console.error. So an exception thrown by the
// AUDIO or ANIMATION layer does not surface as a broken sound — the card is
// placed, its [PLAY] line is already in the log, and the entire ability
// silently never happens. From the board that is indistinguishable from the
// card having no text on it.
//
// Darth Vader is the worst case and the reported one: his onPlay opens each of
// its three steps with UI.sfx.playCardAbility(...) BEFORE it touches the
// board, so one throw costs the move, the fear and the 7-damage chain.
// (User: "i just played vader and his ability never fired ... and i lost.")
//
// This makes every sound and every signature animation throw on every call,
// then plays every card that uses one and asserts the ability still resolved.
//
//   jsc sim/fx-cannot-break-abilities.js -- [--verbose]
// ============================================================
load('./sim/shim-real.js');

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

// ---- a UI whose audio and FX layers are entirely broken --------------------
var BOOM = function () { throw new Error('audio layer exploded'); };
UI.sfx = {
  playCardSfx: BOOM, playCardAbility: BOOM, playEffectSfx: BOOM,
  playTrickSfx: BOOM, play: BOOM,
};
// Every signature animation an ability might reach for.
['_fxForceChoke','_fxSaberThrow','_fxSaberSlash','_fxChainArc','_fxTrickStrike',
 '_fxTrickBuff','_fxTrickDebuff','_fxTrickBurst','_fxTendril','_fxImpact',
 '_fxHellfire','_fxWebPull','_fxSpiderWeb','_fxThanosDust','_fxPredatorPlasma',
 '_fxJasonRevive','_fxHollowPurple'].forEach(function (k) { UI[k] = BOOM; });
UI.render = function () {};

// Cards whose ability opens with a sound — the ones that could lose everything.
// Jason Voorhees is deliberately absent: his sound sits in the REVIVE path,
// not in an onPlay, so "no effect when played" is correct for him and would
// read here as a permanent false failure.
var SOUND_CARDS = ['Darth Vader', 'Gojo', 'Thanos',
                   'Predator', 'Spider-Man', 'Human Torch'];

function mk(n, side) {
  for (var i = 0; i < CARD_DEFS.length; i++) {
    if (CARD_DEFS[i].name === n) return Game.createCardInstance(CARD_DEFS[i], side);
  }
  return null;
}

var results = [], failures = 0;
var SEATS = ['p1', 'p2', 'p3', 'p4'];

// The reported table: one human (p1) and three AI, played online. Built the
// same way sim/ownership2v2.js builds its rooms, because that setup is already
// known to drive real plays through the real entry point.
function room() {
  Game.start2v2Match({ names: { p1: 'Ryan', p2: 'Vega', p3: 'Cortex', p4: 'Nyx' } });
  var tt = Game.state.twoVTwo;
  tt.online = true; tt.you = 'p1';
  tt.joinedPlayers = { p1: 1, p2: 1, p3: 1, p4: 1 };
  SEATS.forEach(function (k) {
    tt.players[k].isAI = (k !== 'p1');
    tt.players[k].energy = 40; tt.players[k].usedEnergy = 0;
  });
  tt.round = 8; Game.state.round = 8; Game.state.phase = '2v2-play';
  var ord = Game._2v2ComputePhaseOrder(8);
  for (var i = 0; i < ord.length; i++) {
    if (ord[i].split('-')[0] === 'p1') { tt.subPhaseIdx = i; break; }
  }
  tt.drawPile = [];
  for (var d = 0; d < 40; d++) tt.drawPile.push(CARD_DEFS[d % CARD_DEFS.length]);
  return tt;
}

SOUND_CARDS.forEach(function (name) {
  var tt = room();
  var mySide = Game._2v2TeamSide[tt.players.p1.team];
  var oppSide = mySide === 'player' ? 'ai' : 'player';
  // Enemies to target and open lanes to move them into — so a step that has
  // nothing to do is never mistaken for a step that was destroyed.
  ['Hulk', 'Venom', 'Bane', 'Joker'].forEach(function (n, i) {
    var e = mk(n, oppSide); if (e) Game.state.lanes[i][oppSide] = e;
  });
  var a = mk('Groot', mySide); if (a) Game.state.lanes[5][mySide] = a;

  var card = mk(name, mySide);
  if (!card) { results.push({ name: name, ok: false, logs: ['card not found'] }); failures++; return; }
  card.cost = 0;
  tt.players.p1.hand.unshift(card);

  var logs = [];
  var origLog = Game.log.bind(Game);
  Game.log = function (m) { logs.push(String(m)); };
  var errs = [];
  var origErr = console.error;
  console.error = function () {
    var a2 = [];
    for (var i = 0; i < arguments.length; i++) a2.push(arguments[i] && arguments[i].message ? arguments[i].message : String(arguments[i]));
    errs.push(a2.join(' '));
  };
  try { Game._2v2OnlinePlayCard('p1', 0, 6, false); }
  catch (e) { errs.push('play threw: ' + e.message); }
  Game.log = origLog;
  console.error = origErr;

  // Did the ability actually do something? Either it armed a prompt for the
  // human (the correct outcome for a targeted step), or it wrote a line of its
  // own past the [PLAY] entry.
  var armed = !!(Game.state.pendingCardChoice || Game.state.pendingLaneChoice);
  var failed = logs.some(function (l) { return /\[ERROR\].*failed to resolve/.test(l); });
  var spoke = logs.some(function (l) {
    return !/^\[PLAY\]/.test(l) && !/LONE WOLF/.test(l) && !/Draw pile|\[DRAW\]|\[SEED\]/.test(l) && l.trim().length > 0;
  });
  var ok = !failed && (armed || spoke);
  if (!ok) failures++;
  results.push({ name: name, ok: ok, failed: failed, armed: armed, logs: logs, errs: errs });
  // clear any prompt so the next card starts from a clean table
  Game.state.pendingCardChoice = null; Game.state.pendingLaneChoice = null;
});

print('=== FX / SFX CANNOT BREAK AN ABILITY ===');
print('every sound and signature animation throws on every call; ' + SOUND_CARDS.length + ' cards played through it');
print('');
results.forEach(function (r) {
  print('  ' + (r.ok ? 'OK  ' : 'FAIL') + '  ' + (r.name + '                ').slice(0, 16)
    + (r.armed ? 'prompted its owner' : (r.ok ? 'resolved' : 'produced NO effect'))
    + (r.failed ? '  — hook reported "failed to resolve"' : ''));
  if (VERBOSE || !r.ok) {
    r.logs.slice(0, 6).forEach(function (l) { print('          | ' + l); });
    r.errs.slice(0, 3).forEach(function (l) { print('          ! ' + l); });
  }
});
print('');
print(failures ? (failures + ' CARD(S) LOST THEIR ABILITY TO A BROKEN SOUND/ANIMATION')
               : 'ALL CLEAR — a throwing audio or FX layer costs the effect nothing.');
