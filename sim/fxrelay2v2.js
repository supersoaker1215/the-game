// ============================================================
// 2v2 FX / SOUND RELAY AUDIT — static, no engine run.
//
// In a 2v2 online room ONE client (the host) runs the engine. The other three
// seats only receive broadcast state, so anything the engine fires straight at
// the UI happens on the host's screen and nowhere else. Two bridges exist to
// close that gap:
//
//   installFxBridge   relays every UI method named _fx*, PLUS a hand-written
//                     RELAY_ALSO list for effects that are not
//   installSfxBridge  relays four named sound entry points
//
// Both lists are maintained BY HAND, which is the whole problem: an animation
// added later under a name that is not _fx-prefixed is host-only, and nothing
// says so. It looks fine to whoever built it — they are the host. (User:
// "make sure all the animations, sounds, and badge animations fire and work
// for 2v2 vs AI and when 4 people are playing because ive noticed some don't")
//
// It also checks a THIRD thing, which is a different way for the same work to
// quietly come undone: ui.js monkey-patches engine methods to hang FX off
// them, and a patch that declares FEWER PARAMETERS than the method it wraps
// silently drops the rest. drawCards(owner, count, source) wrapped as
// (owner, count) is how every 2v2 seat-routing fix on a draw path was undone
// in the browser while the headless sim — which stubs UI — stayed green.
//
//   jsc sim/fxrelay2v2.js -- [--verbose]
// ============================================================

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

function src(f) { return read(f); }
var UIJS = src('ui.js');
var GAMEJS = src('game.js');
var ABIL = src('abilities.js');
var TRICKS = src('tricks.js');

var findings = [];
function note(kind, what, detail) { findings.push({ kind: kind, what: what, detail: detail }); }

// ---------------------------------------------------------------- 1. FX relay
// The bridge's own rule, read out of the source so this can never drift from
// what installFxBridge actually does.
var relayAlso = {};
var mAlso = /const RELAY_ALSO = new Set\(\[([\s\S]*?)\]\)/.exec(UIJS);
if (!mAlso) note('HARNESS', 'RELAY_ALSO', 'could not find the RELAY_ALSO list in ui.js — the bridge was renamed or restructured');
// Strip // comments before pulling the quoted names out — the list is
// commented, and an apostrophe in prose ("the guest replays them") otherwise
// parses as a relay entry.
else strings(mAlso[1]).forEach(function (n) { relayAlso[n] = 1; });

function strings(block) {
  var bare = String(block).replace(/\/\/[^\n]*/g, '');
  return (bare.match(/'([^'\n]+)'/g) || []).map(function (q) { return q.slice(1, -1); });
}

// Effects that reach the other seats through a channel of their OWN rather than
// the generic sig relay. Each entry names where that trigger lives, so a claim
// here can be checked rather than trusted.
var HAS_OWN_PATH = {
  showGameOverScreen: 'ui.js _render2v2OnlineBoard fires it from broadcast state (seat-aware winner)',
  showRoundBanner:    'ui.js render fires it on the round change it sees in state',
  showCardReveal:     "dedicated 'brainiacScan' / 'ironGiantSave' FX events",
  showTrickReveal:    "dedicated 'trickReveal' FX event",
  showRoundSummary:   'host-gating modal built from ABSOLUTE side stats — see FOOTNOTE',
  // Deaths cannot ride the sig relay: it drains AFTER the guest swaps state and
  // re-renders, so the dying element is already gone. Fired from the pre-swap
  // board diff instead, which is the last moment the card is still on screen.
  spawnDestroyParticles: 'ui.js _relay2v2CardFx fires it from the pre-swap board diff',
};
// Sounds that reach the other seats on a dedicated FX event rather than through
// installSfxBridge's four-name list.
var SFX_HAS_OWN_PATH = {
  play: "Game._statusSfx emits its own 'statusSfx' event alongside the local play",
};
// Not effects at all: plumbing, state, or things that legitimately run per client.
var NOT_FX = {
  render: 1, _mpInit: 1, _mpName: 1, _persistGet: 1, _statsGet: 1, _statsSet: 1,
  aiStepDelay: 1, startPromptCountdown: 1, stopPromptCountdown: 1, closeMatchOverlays: 1,
  showAITrickToast: 1,   // a local advisory toast (settings saved, illegal play) — per client by design
};

function callsTo(text) {
  var out = {}, re = /UI\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g, m;
  while ((m = re.exec(text))) out[m[1]] = 1;
  return out;
}
var called = {};
[['game.js', GAMEJS], ['abilities.js', ABIL], ['tricks.js', TRICKS]].forEach(function (pair) {
  var c = callsTo(pair[1]);
  Object.keys(c).forEach(function (n) { (called[n] = called[n] || []).push(pair[0]); });
});

Object.keys(called).sort().forEach(function (name) {
  if (NOT_FX[name]) return;
  if (name.indexOf('_fx') === 0) return;        // relayed by prefix
  if (relayAlso[name]) return;                  // relayed by the explicit list
  if (HAS_OWN_PATH[name]) return;               // relayed by its own event
  note('HOSTONLY', name,
    'fired from ' + called[name].join(', ') + ' but not _fx-prefixed, not in RELAY_ALSO, '
    + 'and has no relay event — only the host sees/hears it');
});

// A RELAY_ALSO entry for something nobody fires any more is dead weight, and
// worse, it hides the fact that the effect was renamed.
Object.keys(relayAlso).forEach(function (name) {
  if (!called[name] && UIJS.indexOf('this.' + name + '(') === -1)
    note('STALE', name, 'listed in RELAY_ALSO but nothing calls it — renamed or removed?');
});

// --------------------------------------------------------------- 2. SFX relay
var sfxRelay = {};
var mS = /const RELAY = \[([^\]]*)\];/.exec(UIJS);
if (mS) strings(mS[1]).forEach(function (n) { sfxRelay[n] = 1; });
else note('HARNESS', 'sfx RELAY', 'could not find the sound relay list in installSfxBridge');

var sfxCalled = {};
[['game.js', GAMEJS], ['abilities.js', ABIL], ['tricks.js', TRICKS]].forEach(function (pair) {
  var re = /UI\.sfx\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g, m;
  while ((m = re.exec(pair[1]))) (sfxCalled[m[1]] = sfxCalled[m[1]] || {})[pair[0]] = 1;
});
Object.keys(sfxCalled).sort().forEach(function (name) {
  if (sfxRelay[name]) return;
  if (SFX_HAS_OWN_PATH[name]) return;
  note('SFXHOSTONLY', 'sfx.' + name,
    'fired from ' + Object.keys(sfxCalled[name]).join(', ') + ' but not in installSfxBridge RELAY — only the host hears it');
});

// ------------------------------------------------- 3. wrapper arity vs engine
// Engine signatures: a method literal at two-space indent in the Game object.
var engineSig = {};
(function () {
  var re = /^  ([a-zA-Z_][a-zA-Z0-9_]*)\(([^)\n]*)\)\s*\{/gm, m;
  while ((m = re.exec(GAMEJS))) {
    if (engineSig[m[1]] === undefined) engineSig[m[1]] = m[2].trim();
  }
})();
function arity(params) {
  if (!params) return { n: 0, rest: false };
  var rest = params.indexOf('...') !== -1;
  var parts = params.split(',').filter(function (p) { return p.trim().length; });
  return { n: parts.length, rest: rest };
}
(function () {
  // Game.foo = (a, b) => ...   /   Game.foo = function (a, b) {
  var re = /Game\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:function\s*)?\(([^)\n]*)\)\s*(?:=>|\{)/g, m;
  var seen = {};
  while ((m = re.exec(UIJS))) {
    var name = m[1], w = arity(m[2]);
    var sig = engineSig[name];
    if (sig === undefined) continue;                 // not an engine method
    var e = arity(sig);
    if (w.rest) continue;                            // forwards everything
    if (w.n >= e.n) continue;                        // declares at least as many
    var key = name + ':' + w.n;
    if (seen[key]) continue; seen[key] = 1;
    note('ARITY', 'Game.' + name,
      'ui.js wrapper takes ' + w.n + ' param(s) but the engine takes ' + e.n
      + ' (' + sig + ') — the extra argument(s) are dropped for every call in the browser');
  }
})();

// ------------------------------------------------------------------- report
print('=== 2v2 FX / SOUND RELAY AUDIT ===');
print('UI effects fired from gameplay code: ' + Object.keys(called).length
  + '   relayed by _fx prefix: ' + Object.keys(called).filter(function (n) { return n.indexOf('_fx') === 0; }).length
  + '   by explicit list: ' + Object.keys(relayAlso).length);
var byKind = {};
findings.forEach(function (f) { (byKind[f.kind] = byKind[f.kind] || []).push(f); });
var ORDER = ['ARITY', 'HOSTONLY', 'SFXHOSTONLY', 'STALE', 'HARNESS'];
var total = 0;
ORDER.forEach(function (k) {
  var list = byKind[k] || [];
  total += list.length;
  if (!list.length) { print('  ' + k + ': none'); return; }
  print('  ' + k + ': ' + list.length);
  list.forEach(function (f) { print('      ' + f.what + ' — ' + f.detail); });
});
print(total ? ('TOTAL FINDINGS: ' + total) : 'NO FINDINGS — every gameplay effect reaches all four seats.');
if (VERBOSE) {
  print('');
  print('--- effects with their own relay channel (not findings) ---');
  Object.keys(HAS_OWN_PATH).forEach(function (n) { print('  ' + n + ' — ' + HAS_OWN_PATH[n]); });
  Object.keys(SFX_HAS_OWN_PATH).forEach(function (n) { print('  sfx.' + n + ' — ' + SFX_HAS_OWN_PATH[n]); });
}
