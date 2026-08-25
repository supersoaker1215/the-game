// JSC shim — stubs UI/document/setTimeout and loads the game files.
// Run under: /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc

// ---- polyfill a console that delegates to print() ----
if (typeof console === 'undefined') {
  this.console = {
    log: function () {
      var args = Array.prototype.slice.call(arguments);
      print(args.map(function (a) { return (typeof a === 'object' ? JSON.stringify(a) : String(a)); }).join(' '));
    },
    error: function () {
      var args = Array.prototype.slice.call(arguments);
      print('[ERR] ' + args.map(function (a) { return (typeof a === 'object' ? JSON.stringify(a) : String(a)); }).join(' '));
    },
    warn: function () {
      var args = Array.prototype.slice.call(arguments);
      print('[WARN] ' + args.map(function (a) { return (typeof a === 'object' ? JSON.stringify(a) : String(a)); }).join(' '));
    },
    info: function () { this.log.apply(this, arguments); },
  };
}

// ---- synchronous setTimeout / setInterval so the game's paced flow collapses ----
this.setTimeout = function (fn) { if (typeof fn === 'function') { try { fn(); } catch (e) { console.error('[sim:setTimeout]', e.message || e); } } return 0; };
this.clearTimeout = function () {};
this.setInterval = function () { return 0; };
this.clearInterval = function () {};

// ---- DOM stub ----
function __simEl() {
  return {
    style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, removeEventListener: function () {},
    appendChild: function () {}, removeChild: function () {}, insertBefore: function () {},
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    getAttribute: function () { return null; }, setAttribute: function () {},
    cloneNode: function () { return __simEl(); },
    focus: function () {}, click: function () {},
    innerHTML: '', textContent: '',
    offsetWidth: 0, offsetHeight: 0,
    getBoundingClientRect: function () { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    children: [],
  };
}
// Explicit flag for game code to detect headless sim — shim stubs both
// `window` and `document`, so typeof checks don't separate the two.
this.__HEADLESS_SIM = true;
this.document = {
  getElementById: function () { return __simEl(); },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  createElement: function () { return __simEl(); },
  createTextNode: function (t) { return { nodeValue: t }; },
  addEventListener: function () {}, removeEventListener: function () {},
  body: __simEl(), documentElement: __simEl(),
};

// ---- UI stub ----
// Note: `showRoundSummary` is INTENTIONALLY omitted. postCombat() reads
// `typeof UI !== 'undefined' && UI.showRoundSummary` and takes the sync
// branch when false — which is what we want. If we defined it, the game
// calls `Promise.resolve(UI.showRoundSummary(data)).then(proceed)` and
// `proceed` parks in the microtask queue, which doesn't drain inside our
// synchronous game loop.
this.UI = {
  render: function () {},
  startPromptCountdown: function () {}, stopPromptCountdown: function () {},
  draftEl: { style: { display: '' } },
  settings: { roundRecap: false, aiSpeed: 'fast', difficulty: 'normal', aiPacing: 'instant' },
  renderGameArea: function () {}, renderHand: function () {}, renderDraft: function () {}, updateLog: function () {},
};

// ---- `window` alias ----
this.window = this;

// ---- load game files in canonical order ----
var __SIM_ROOT = (typeof __SIM_ROOT_OVERRIDE === 'string') ? __SIM_ROOT_OVERRIDE : '.';
// engine/combat.js loads BEFORE game.js so Game._snapForPredict /
// Game._canSwingForward (now thin forwarders) find CombatEngine on
// global scope. Mirrors the index.html script-tag order.
var __SIM_FILES = ['cards.js', 'tricks.js', 'abilities.js', 'engine/combat.js', 'decks.js', 'game.js', 'ai.js'];
for (var __i = 0; __i < __SIM_FILES.length; __i++) {
  load(__SIM_ROOT + '/' + __SIM_FILES[__i]);
}


// ---- REAL PROMPT SYSTEM ----------------------------------------------------
// sim/shim.js replaces promptCardChoice / promptLaneChoice with synchronous
// auto-pickers, which is what makes balance runs possible — and also makes
// prompt ROUTING invisible, because pendingCardChoice never exists. This
// variant loads the same environment but leaves the engine's own prompt system
// intact, so a harness can inspect who each prompt was routed to and whether
// the table was released afterwards. The one thing it must neutralise is the
// 30s auto-pick: setTimeout here is synchronous, so an armed timeout would
// answer every prompt in the same tick it was raised.
Game._startPromptTimeout = function () {};
Game._clearPromptTimeout = function () {};
// _aiActionDelay defers through setTimeout (synchronous here) but also
// increments _pendingAIActions; keep the accounting honest so hasPendingPrompt
// does not report a phantom lock after the callback has already run.
