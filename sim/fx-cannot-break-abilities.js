// ============================================================
// A SOUND OR AN ANIMATION MUST NEVER KILL AN ABILITY — every card, every trick.
//
// Card code calls the presentation layer inline (UI.sfx.playCardAbility(...),
// UI._fxWhatever(...)) and Game._runHookBody catches whatever a hook throws
// into console.error. So an exception from audio or FX does not surface as a
// broken sound: the card is placed, its [PLAY] line is already in the log, and
// the ability silently never happens. From the board that is indistinguishable
// from the card having no text on it.
//
// Darth Vader is how this was found — his onPlay opens each of its three steps
// with a sound BEFORE touching the board, so one audio throw cost the move, the
// Fear and the 7-damage chain, and the game with it. (User: "i just played
// vader and his ability never fired ... and i lost.")
//
// A hand-picked list of suspects cannot answer "does any OTHER card do this to
// itself", so this does not use one. Every card and every trick is played
// TWICE over an identical board with the RNG pinned to the same position:
//
//   run A   a healthy UI where every method is a no-op
//   run B   a hostile UI where EVERY method throws
//
// and the two outcomes are diffed. Anything that differs is a card whose
// ability depends on its own presentation layer surviving. Nothing is assumed
// about WHICH UI calls a card makes — the whole surface is broken at once, so
// a card that reaches for something nobody thought to list is still covered.
//
//   jsc sim/fx-cannot-break-abilities.js -- [--verbose]
// ============================================================
load('./sim/shim-real.js');

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

var SEED = 987654321;
var BOARD_ENEMY = ['Hulk', 'Godzilla', 'Venom', 'Bane'];
var BOARD_ALLY  = ['Joker', 'King Shark'];
var HAND        = ['Man-Bat', 'Gremlin', 'Venom', 'Bane'];

function mk(name, side) {
  for (var i = 0; i < CARD_DEFS.length; i++) if (CARD_DEFS[i].name === name) return Game.createCardInstance(CARD_DEFS[i], side);
  return null;
}

// ---- the two UIs -----------------------------------------------------------
// The shim's UI is captured once so run A can restore a working one.
var HEALTHY = {};
Object.keys(UI).forEach(function (k) { HEALTHY[k] = UI[k]; });

// Every method throws. Built by proxying the real key set plus every _fx* and
// sfx name the codebase uses, so a card reaching for anything at all fails.
function hostileUI() {
  var boom = function () { throw new Error('presentation layer exploded'); };
  var out = {};
  Object.keys(HEALTHY).forEach(function (k) {
    out[k] = (typeof HEALTHY[k] === 'function') ? boom : HEALTHY[k];
  });
  // THE RENDERER STAYS INERT, DELIBERATELY — and this was checked, not assumed.
  // Making it throw reports all 150 cards as broken, but not because of
  // anything the CARDS do: game.js calls UI.render() unguarded in many places,
  // so the throw escapes from the engine long before any card's own effects
  // are reached. That measures the engine's tolerance of a broken renderer,
  // which is a different question with a different answer (if the renderer is
  // dead the game is dead anyway) and it drowns the one being asked here.
  // The nine UI.render() calls that live in CARD code are guarded at their
  // sites, so a card can no longer lose its ability to the renderer either;
  // that just isn't a property this harness can isolate.
  // updateLog stays inert for a plainer reason: the harness reads the log to
  // judge the result, so breaking it would blind the measurement.
  out.render = function () {};
  out.updateLog = function () {};
  out.renderGameArea = function () {};
  out.renderHand = function () {};
  out.renderDraft = function () {};
  // Anything a card reaches for that is not on the real UI must still throw —
  // a missing method would simply be skipped by the `UI.x &&` guards cards use,
  // which is the opposite of what is being tested.
  var sfxKeys = ['playCardSfx','playCardAbility','playEffectSfx','playTrickSfx','play'];
  out.sfx = {};
  sfxKeys.forEach(function (k) { out.sfx[k] = boom; });
  return { ui: out, boom: boom };
}

// Every _fx* name that appears anywhere in card code, so the hostile UI has one
// to throw for even if the shim never defined it.
var FX_NAMES = {};
(function () {
  var re = /UI\.(_fx[A-Za-z0-9_]*|_[a-z][A-Za-z0-9_]*Jumpscare|_screenShake|flashLanes)\s*\(/g, m;
  [typeof CARD_ABILITIES !== 'undefined' ? '' : ''].forEach(function () {});
  var srcs = [read('abilities.js'), read('tricks.js'), read('game.js')];
  srcs.forEach(function (src) { while ((m = re.exec(src))) FX_NAMES[m[1]] = 1; });
})();

function installUI(which) {
  if (which === 'healthy') {
    Object.keys(HEALTHY).forEach(function (k) { UI[k] = HEALTHY[k]; });
    UI.sfx = { playCardSfx: function(){}, playCardAbility: function(){}, playEffectSfx: function(){},
               playTrickSfx: function(){}, play: function(){} };
    Object.keys(FX_NAMES).forEach(function (k) { UI[k] = function () {}; });
    return null;
  }
  var h = hostileUI();
  Object.keys(h.ui).forEach(function (k) { UI[k] = h.ui[k]; });
  UI.sfx = h.ui.sfx;
  Object.keys(FX_NAMES).forEach(function (k) { UI[k] = h.boom; });
  return h.boom;
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
    } else if (s.pendingKangChoice) { s.pendingKangChoice = null; }
    else if (s.pendingBlockTrick) { s.pendingBlockTrick = null; }
    else if (s.pendingJumpOffer) { s.pendingJumpOffer = null; }
    else break;
    try { Game.cleanupDead(); Game.resumeCombatIfWaiting(); } catch (e) {}
  }
}

// The comparable part of the world. Same shape parity2v2 uses, plus the
// prompt a card armed — for a targeted ability, "did it ask its owner?" IS the
// effect, and a card that asks in run A and stays silent in run B has lost it.
function snapshot(prompted) {
  var lanes = [];
  for (var i = 0; i < 6; i++) {
    var l = Game.state.lanes[i];
    ['player', 'ai'].forEach(function (side) {
      var c = l[side];
      lanes.push(i + side[0] + ':' + (c ? c.name + ' ' + (c.attack | 0) + '/' + (c.currentHealth | 0)
        + (c.isFrozen ? 'F' : '') + (c.isStunned ? 'S' : '') + (c.isMindControlled ? 'M' : '')
        + (c.isFeared ? 'R' : '') + (c.tauntTurns > 0 ? 'T' : '') : '-'));
    });
  }
  return {
    lanes: lanes.join('|'),
    pHp: Game.state.player.health, aHp: Game.state.ai.health,
    pHand: Game.state.player.hand.length, aHand: Game.state.ai.hand.length,
    pDead: (Game.state.player.deadPile || []).length,
    aDead: (Game.state.ai.deadPile || []).length,
    prompted: prompted,
  };
}

// ---- one run ---------------------------------------------------------------
function runOnce(def, isTrick, mode) {
  installUI(mode);
  Game.startSeededRun(SEED, 'classic');
  Game.state.phase = 'player-cards';
  Game.state.round = 8;
  Game.state.player.currency = 40; Game.state.ai.currency = 40;
  Game.state.player.isHuman = false;   // resolve AI-side: no modal to answer
  Game.state.lanes.forEach(function (l) { l.player = null; l.ai = null; });
  BOARD_ENEMY.forEach(function (n, i) { Game.state.lanes[i].ai = mk(n, 'ai'); });
  BOARD_ALLY.forEach(function (n, i) { Game.state.lanes[i + 4].player = mk(n, 'player'); });
  Game.state.player.hand = HAND.map(function (n) { return mk(n, 'player'); });
  Game.state.ai.hand = HAND.map(function (n) { return mk(n, 'ai'); });
  Game.state.player.trickHand = TRICK_DEFS.slice(0, 2).map(function (t) { return Object.assign({}, t); });

  // Same RNG position AND the same summon pool at the moment of play, so a
  // card that summons does not diff on the lottery.
  Game.seedMatch(SEED); Game._initSummonDeck(); Game.seedMatch(SEED);

  var prompted = '';
  var threw = null;
  // WATCH FOR A SWALLOWED HOOK. _runHookBody catches an ability exception into
  // console.error, so a card can lose part of its effect and still produce a
  // snapshot that happens to match — the diff is only as sharp as what it
  // measures. A hook that threw at all is direct evidence the presentation
  // layer reached into the ability, whether or not it changed anything
  // observable, so it is recorded rather than inferred.
  var hookErrs = [];
  var origErr = console.error;
  console.error = function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var a0 = arguments[i];
      parts.push(a0 && a0.message ? a0.message : String(a0));
    }
    var line = parts.join(' ');
    if (/^\[(on[A-Z][A-Za-z]*|ECHO )/.test(line)) hookErrs.push(line);
  };
  try {
    if (isTrick) {
      var t = Object.assign({}, def);
      if (t.play) t.play(Game, 'player');
    } else {
      var card = Game.createCardInstance(def, 'player');
      if (card.isDiscardEffect) {
        if (card.onDiscard) Game._runHook(card, 'onDiscard', Game, 'player', card);
      } else {
        Game.state.lanes[3].player = card;
        if (card.onPlay) Game._runHook(card, 'onPlay', Game, card, 3);
      }
    }
  } catch (e) { threw = String(e && e.message || e); }
  var s = Game.state;
  prompted = (s.pendingCardChoice && ('C:' + s.pendingCardChoice.title))
          || (s.pendingLaneChoice && ('L:' + s.pendingLaneChoice.title)) || '';
  drain();
  try { Game.cleanupDead(); } catch (e) {}
  console.error = origErr;
  var snap = snapshot(prompted);
  snap.threw = threw;
  snap.hookErrs = hookErrs.join(' ; ');
  return snap;
}

// ---- compare ---------------------------------------------------------------
var findings = [], tested = 0;

function check(def, isTrick) {
  var label = (isTrick ? 'TRICK ' : '') + def.name;
  tested++;
  var a, b;
  try { a = runOnce(def, isTrick, 'healthy'); }
  catch (e) { findings.push({ name: label, kind: 'HARNESS', detail: 'healthy run threw: ' + (e.message || e) }); return; }
  try { b = runOnce(def, isTrick, 'hostile'); }
  catch (e) { findings.push({ name: label, kind: 'BROKEN', detail: 'a throwing UI took the whole play down: ' + (e.message || e) }); return; }

  var diffs = [];
  Object.keys(a).forEach(function (k) {
    if (k === 'hookErrs') return;
    if (String(a[k]) !== String(b[k])) diffs.push(k + ': healthy=' + a[k] + '  brokenUI=' + b[k]);
  });
  if (diffs.length) { findings.push({ name: label, kind: 'FXDEPENDENT', detail: diffs.join('   ') }); return; }
  // No observable difference, but the hostile run still lost a hook to an
  // exception the engine swallowed. Nothing measured here changed — but the
  // snapshot cannot see everything, and an ability that aborts partway is one
  // input away from mattering.
  if (b.hookErrs && !a.hookErrs) {
    findings.push({ name: label, kind: 'ABORTED',
      detail: 'its hook threw when the UI broke (engine swallowed it): ' + b.hookErrs });
  }
}

installUI('healthy');
CARD_DEFS.forEach(function (d) { if (!d._spawnOnly) check(d, false); });
TRICK_DEFS.forEach(function (t) { check(t, true); });
installUI('healthy');

print('=== A BROKEN SOUND / ANIMATION MUST NOT COST AN ABILITY ===');
print('played twice each (healthy UI vs every-UI-method-throws), RNG pinned: ' + tested + ' cards + tricks');
print('fx names the hostile UI throws for: ' + Object.keys(FX_NAMES).length);
var byKind = {};
findings.forEach(function (f) { (byKind[f.kind] = byKind[f.kind] || []).push(f); });
var total = 0;
['BROKEN', 'FXDEPENDENT', 'ABORTED', 'HARNESS'].forEach(function (k) {
  var list = byKind[k] || [];
  total += list.length;
  if (!list.length) { print('  ' + k + ': none'); return; }
  print('  ' + k + ': ' + list.length);
  list.slice(0, VERBOSE ? 999 : 30).forEach(function (f) { print('      ' + f.name + ' — ' + f.detail); });
  if (!VERBOSE && list.length > 30) print('      … ' + (list.length - 30) + ' more (--verbose)');
});
print(total ? ('TOTAL FINDINGS: ' + total)
            : 'NO FINDINGS — every card and trick resolves identically with its entire presentation layer throwing.');
