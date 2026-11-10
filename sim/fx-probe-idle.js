// ============================================================
// THE FRAME-RATE PROBE SLEEPS OUTSIDE A MATCH
//
//   jsc sim/fx-probe-idle.js
//
// Owner: "is the cursor taking up a lot of power". Measured: the cursor trail
// + custom cursor cost ~0.1ms/frame while moving and go fully idle when the
// mouse stops. The real idle cost was _startLowFxFrameProbe: a rAF loop for
// the whole session, 121 callbacks in 2s on a still main menu, doing nothing
// but rescheduling. Now it uses a 1s timer whenever there is nothing to
// sample (boot warm-up, not in a match, tab hidden) and rAF only during play.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

// Capture scheduling instead of running it (the shim's timers are synchronous,
// which would recurse forever on any self-rescheduling loop).
var rafQ = [], toQ = [];
var origRaf = window.requestAnimationFrame, origTo = this.setTimeout, origNow = performance.now;
window.requestAnimationFrame = function (fn) { rafQ.push(fn); return rafQ.length; };
requestAnimationFrame = window.requestAnimationFrame;
this.setTimeout = function (fn, ms) { toQ.push({ fn: fn, ms: ms }); return toQ.length; };
window.setTimeout = this.setTimeout;
var clock = 0; performance.now = function () { return clock; };

UI._lowFxProbeRan = false;
UI.settings = UI.settings || {}; UI.settings.graphics = 'auto';
document.body.classList.remove('in-match');
UI._startLowFxFrameProbe();
check('the probe starts', rafQ.length + toQ.length === 1, (rafQ.length + toQ.length) + ' scheduled');

function runNext() {
  if (rafQ.length) { var f = rafQ.shift(); f(); return 'raf'; }
  if (toQ.length) { var t = toQ.shift(); t.fn(); return 'timer:' + t.ms; }
  return 'none';
}

// On the menu: 20 wake-ups, every one a 1s timer, never a frame request.
runNext();
var kinds = [];
for (var i = 0; i < 20; i++) { clock += 1000; kinds.push(runNext()); }
check('on the menu it never asks for frames', kinds.indexOf('raf') < 0, kinds.join(','));
check('on the menu it checks back once a second', kinds.every(function (k) { return k === 'timer:1000'; }), kinds.join(','));

// A match starts (past warm-up): it switches to per-frame sampling.
document.body.classList.add('in-match');
clock += 1000; runNext();
var afterMatch = [];
for (var j = 0; j < 5; j++) { clock += 16; afterMatch.push(runNext()); }
check('in a match it samples every frame', afterMatch.every(function (k) { return k === 'raf'; }), afterMatch.join(','));

// The match ends: back to sleep.
document.body.classList.remove('in-match');
clock += 16; var back = runNext(); var next = runNext();
check('after the match it goes back to sleeping', back === 'raf' && next === 'timer:1000', back + ' then ' + next);

window.requestAnimationFrame = origRaf; requestAnimationFrame = origRaf;
this.setTimeout = origTo; window.setTimeout = origTo; performance.now = origNow;
print('fx-probe-idle: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('fx-probe-idle failed');
