// ============================================================
// A DRY RUN MUST NOT TOUCH THE SCREEN.
//
// previewCombatNow ("IF COMBAT RESOLVES NOW"), previewPlacement and the drag
// forecast all deep-clone the state, stamp it _silentSim, and resolve combat on
// the COPY to work out what would happen. Every engine path that talks to the
// wire already guards on that flag. The paths that talk to the UI did not.
//
// handleDeath calls UI.spawnDestroyParticles(card.id, ...) unguarded, and that
// function looks the element up by data-card-id in the REAL document — so a
// card the forecast merely PREDICTED would die had the Tron dissolve applied to
// its live board tile. The dissolve ends fully masked out and the forecast
// re-runs on every render, re-stamping it, so the sweep that exists for stuck
// dissolves never got a window in which to fire. The card stayed invisible for
// as long as the lane stayed contested, and came back the moment combat
// started, because the forecast stops running then. (User: "the card is gone in
// front of flash ... but during the combat phase then you can see the art
// again.")
//
// This runs a forecast against a recording UI and asserts it called NOTHING.
//
//   jsc sim/silentsim-ui-leak.js -- [--verbose]
// ============================================================
load('./sim/shim-real.js');

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

function mk(n, side) {
  for (var i = 0; i < CARD_DEFS.length; i++) {
    if (CARD_DEFS[i].name === n) return Game.createCardInstance(CARD_DEFS[i], side);
  }
  return null;
}

// Record every UI method a forecast reaches for. Anything at all is a leak:
// nobody is watching a dry run, so it has no business drawing, playing a sound,
// or touching a board tile.
var calls = [];
function recordingUI(base) {
  var out = {};
  Object.keys(base).forEach(function (k) {
    if (typeof base[k] === 'function') out[k] = (function (name) {
      return function () { calls.push(name); };
    })(k);
    else out[k] = base[k];
  });
  // The names a forecast is most likely to reach that the stub may not define.
  ['spawnDestroyParticles', 'flashCombatReveal', 'showLaneRecap', 'showRoundSummary',
   'showCardReveal', 'showTrickReveal', 'showAITrickToast', 'showRoundBanner',
   'showGameOverScreen', 'killcamFlash', 'hitPause', 'flashLanes', '_screenShake',
   'render', 'spawnDestroyShards', 'fireCritFlash', 'showDamageFloats'
  ].forEach(function (k) {
    out[k] = (function (name) { return function () { calls.push(name); }; })(k);
  });
  out.sfx = {};
  ['playCardSfx', 'playCardAbility', 'playEffectSfx', 'playTrickSfx', 'play'].forEach(function (k) {
    out.sfx[k] = (function (name) { return function () { calls.push('sfx.' + name); }; })(k);
  });
  return out;
}

// A board where the forecast will certainly predict deaths on both sides.
function board() {
  Game.init();
  Game.startSeededRun(4242, 'classic');
  Game.state.phase = 'player-cards';
  Game.state.round = 5;
  Game.state.player.currency = 20;
  Game.state.lanes.forEach(function (l) { l.player = null; l.ai = null; });
  // big vs small, both ways, so somebody dies in each direction
  Game.state.lanes[0].ai     = mk('Padme Amidala', 'ai');
  Game.state.lanes[0].player = mk('Spawn', 'player');
  Game.state.lanes[1].ai     = mk('Hulk', 'ai');
  Game.state.lanes[1].player = mk('Groot', 'player');
  Game.state.lanes[2].ai     = mk('Venom', 'ai');
  Game.state.lanes[2].player = mk('Godzilla', 'player');
}

var origUI = UI;
var results = [];

function run(label, fn) {
  board();
  calls = [];
  globalThis.UI = recordingUI(origUI);
  try { fn(); } catch (e) { calls.push('THREW:' + (e.message || e)); }
  globalThis.UI = origUI;
  var uniq = {};
  calls.forEach(function (c) { uniq[c] = (uniq[c] || 0) + 1; });
  results.push({ label: label, calls: uniq, total: calls.length });
}

run('previewCombatNow()', function () { if (Game.previewCombatNow) Game.previewCombatNow(); });
run('previewPlacement()', function () {
  if (!Game.previewPlacement) return;
  var c = mk('Wolverine', 'player');
  Game.state.player.hand = [c];
  Game.previewPlacement('player', c, 3);
});

print('=== A DRY RUN MUST NOT TOUCH THE SCREEN ===');
var leaks = 0;
results.forEach(function (r) {
  var names = Object.keys(r.calls);
  if (!names.length) { print('  ok    ' + r.label + ' — touched nothing'); return; }
  leaks += names.length;
  print('  LEAK  ' + r.label + ' — called ' + r.total + ' UI method(s):');
  names.sort().forEach(function (n) { print('           ' + n + ' x' + r.calls[n]); });
});
print('');
print(leaks ? (leaks + ' LEAKING CALL SITE(S) — a forecast is drawing on the live board')
            : 'NO LEAKS — the forecast resolves in silence.');
