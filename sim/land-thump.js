// ============================================================
// PLAYING A CARD LANDS WITH A THUMP
//
//   jsc sim/land-thump.js
//
// Owner: Marvel-Snap game feel on the most-repeated gesture in the game. Snap's
// card play: short wind-up, ease-out flight, ~5% overshoot then settle, and on
// TOUCHDOWN a thump = lane flash + a tiny screen shake + a sound.
// Measured before (source + cascade, this harness): 0 screen shakes on any
// landing (player, AI, 2v2 partner, MP opponent); lane "flash" = a 3px
// translate dip, no light at all; wind-up visible 0ms (class added and the
// hand tile replaced by the same synchronous render, and the class is in the
// diff renderer's strip list); landing ring parented to the real card while it
// is opacity:0 for the whole 460ms flight (ring lives 700ms → ~66% of it spent
// invisible); the play cue fires at commit, 460ms before touchdown;
// _screenShake had NO reduced-motion / low-fx gate.
// After: one canonical UI._landThump (shake tier by cost, body-level lane
// flash, ring at the landing rect) called from the
// player landing (_spawnPlayerLandFx) AND the AI/opponent landing; wind-up
// folded into the flight ghost's keyframe; flight 460 → 360ms (so the commit
// cue now leads touchdown by 360ms; no new sound — procedural cues are off).
// Paint cannot run here, so this pins the mechanism and the cascade.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var SRC = (read('ui-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('\n'))   /* every UI part, in load order */;
var CSS = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('')).replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
function body(fnHead) {
  var i = SRC.indexOf(fnHead); if (i < 0) return '';
  var j = SRC.indexOf('{', i), depth = 0, k = j;
  for (; k < SRC.length; k++) { if (SRC[k] === '{') depth++; else if (SRC[k] === '}' && --depth === 0) break; }
  return SRC.slice(j, k + 1);
}
var strip = function (s) { return s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); };
function keyframes(name) {
  var i = CSS.indexOf('@keyframes ' + name + ' {'); if (i < 0) return '';
  var j = CSS.indexOf('{', i), depth = 0, k = j;
  for (; k < CSS.length; k++) { if (CSS[k] === '{') depth++; else if (CSS[k] === '}' && --depth === 0) break; }
  return CSS.slice(j, k + 1);
}

// Timers: record, never run inline (the shim's inline setTimeout would remove
// every one-shot FX before it could be observed).
var timers = [];
this.setTimeout = window.setTimeout = function (fn, ms) { timers.push(ms); return timers.length; };
var gameArea = document.getElementById('game-area') || (function () {
  var g = document.createElement('div'); g.id = 'game-area'; document.body.appendChild(g); return g;
})();

function rig() {
  var lane = document.createElement('div'); lane.className = 'lane';
  lane.setAttribute('data-lane', '1');
  lane.getBoundingClientRect = function () { return { left: 100, top: 50, width: 220, height: 400, right: 320, bottom: 450 }; };
  var slot = document.createElement('div'); slot.className = 'card-slot player-slot';
  var card = document.createElement('div'); card.className = 'card ally-card';
  card.getBoundingClientRect = function () { return { left: 120, top: 260, width: 180, height: 180, right: 300, bottom: 440 }; };
  slot.appendChild(card); lane.appendChild(slot); document.body.appendChild(lane);
  return { lane: lane, slot: slot, card: card };
}
function layerCount(cls) {
  var layer = document.getElementById('signature-fx-layer');
  if (!layer) return 0;
  return layer.querySelectorAll('.' + cls).length;
}

// ---- 1. A flown player card's touchdown thumps ---------------------------
var shakes = [], sounds = [];
var realShake = UI._screenShake;
UI._screenShake = function (t) { shakes.push(t); };
UI.sfx = UI.sfx || {};
var realPlay = UI.sfx.play;
UI.sfx.play = function (n) { sounds.push(n); };
UI._reducedMotion = function () { return false; };
UI._lastLandThumpAt = 0;
var r = rig();
var flashBefore = layerCount('lane-land-flash'), ringBefore = layerCount('card-place-shockring');
try { UI._spawnPlayerLandFx(r.card, r.lane, r.slot, true, { cost: 2 }); } catch (e) { fails.push('landing threw: ' + e.message); }
var landShakes = shakes.filter(function (s) { return /^land/.test(String(s)); });
print('  measured: landing → ' + shakes.length + ' shake call(s) ' + JSON.stringify(shakes) + ', sounds ' + JSON.stringify(sounds) +
  ', lane flashes ' + (layerCount('lane-land-flash') - flashBefore) + ', staged rings ' + (layerCount('card-place-shockring') - ringBefore));
check('a player card landing shakes the screen (landing tier)', landShakes.length === 1, JSON.stringify(shakes));
check('a player card landing flashes its lane on the body-level layer', layerCount('lane-land-flash') - flashBefore === 1);
check('the landing ring fires AT touchdown, on the body-level layer', layerCount('card-place-shockring') - ringBefore === 1);
// No synth thud: every procedural cue is gated off by the owner
// (sfx.PROCEDURAL_CUES = false), and the per-card play cue's stagger and
// hover-lockout gates are keyed to commit — so the thump adds NO sound.
check('the thump adds no sound of its own (play-cue gates untouched)', sounds.length === 0, JSON.stringify(sounds));

// ---- 2. Shake scales with cost, all below the lightest existing tier ------
var tiers = typeof UI._landShakeTier === 'function'
  ? [1, 3, 4, 6, 7, 10].map(function (c) { return UI._landShakeTier(c); }) : [];
print('  measured: tiers by cost 1,3,4,6,7,10 → ' + JSON.stringify(tiers));
check('cost 1-3 share the smallest tier', tiers[0] === 'land-s' && tiers[1] === 'land-s', JSON.stringify(tiers));
check('cost 4-6 step up', tiers[2] === 'land-m' && tiers[3] === 'land-m');
check('cost 7+ is the strongest landing tier', tiers[4] === 'land-l' && tiers[5] === 'land-l');
function amp(kf) {
  var m, re = /translate\(\s*(-?[\d.]+)(?:px)?\s*,\s*(-?[\d.]+)(?:px)?/g, mx = 0;
  while ((m = re.exec(kf))) mx = Math.max(mx, Math.abs(+m[1]), Math.abs(+m[2]));
  return mx;
}
var lightAmp = amp(keyframes('screenShakeLight'));
['s', 'm', 'l'].forEach(function (t) {
  var rm = CSS.match(new RegExp('#game-area\\.screen-shake-land-' + t + '\\s*\\{([^}]*)\\}'));
  var dur = rm && rm[1].match(/(\d+)ms/);
  var kf = keyframes('screenShakeLand' + t.toUpperCase());
  print('  measured: land-' + t + ' amplitude ' + amp(kf) + 'px, ' + (dur ? dur[1] : '?') + 'ms (lightest existing: ' + lightAmp + 'px, 200ms)');
  check('land-' + t + ' exists and is under 200ms', !!dur && +dur[1] < 200 && +dur[1] >= 120);
  check('land-' + t + ' stays below the lightest shake (' + lightAmp + 'px)', !!kf && amp(kf) > 0 && amp(kf) < lightAmp);
});

// ---- 3. Nothing shakes under reduced motion or the low-fx tier -----------
UI._screenShake = realShake;
gameArea.className = '';
UI._reducedMotion = function () { return true; };
UI._screenShake('heavy'); UI._screenShake('land-l');
check('reduced motion never shakes (any tier)', !/screen-shake/.test(gameArea.className), gameArea.className);
UI._reducedMotion = function () { return false; };
document.body.classList.add('low-fx');
UI._screenShake('medium'); UI._screenShake('land-s');
check('low-fx never shakes (any tier)', !/screen-shake/.test(gameArea.className), gameArea.className);
document.body.classList.remove('low-fx');
// A landing tick must never cut a real hit's shake short.
gameArea.className = ''; UI._shakeRank = 0; UI._shakeUntil = 0;
UI._screenShake('heavy'); UI._screenShake('land-s');
check('a landing shake never pre-empts a running hit shake', /screen-shake-heavy/.test(gameArea.className) && !/land/.test(gameArea.className), gameArea.className);
UI._shakeUntil = 0;
var rmCss = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^@]*#game-area\[class\*="screen-shake"\]\s*\{\s*animation:\s*none/.test(CSS);
check('the cascade also drops every shake under reduced motion', rmCss);

// ---- 4. Every landing surface uses the canonical thump --------------------
var render = strip(SRC);
var aiAt = render.indexOf("'lane-claim-wave claim-ai'");
var aiBlock = aiAt > 0 ? render.slice(aiAt - 1500, aiAt + 1200) : '';
check('the AI / opponent / MP-guest landing thumps too', /this\._landThump\(/.test(aiBlock));
check('the player landing routes through the canonical thump', /this\._landThump\(/.test(strip(body('_spawnPlayerLandFx(cardEl, laneEl, slotEl, flown, opts) {'))));
check('a lateral card slide is not a play (no thump)', /_spawnPlayerLandFx\([^)]*\{\s*thump:\s*false\s*\}\)/.test(strip(body('_fxCardSlide(ev) {'))));
check('the ring no longer rides playCard on the next frame (card still hidden mid-flight)',
  !/spawnPlaceShockring\(newEl/.test(render));

// ---- 5. Wind-up + timing ----------------------------------------------------
var arc = keyframes('cardFlightArc');
var wind = arc.match(/(\d+)%\s*\{\s*transform:\s*translate3d\(\s*0(?:px)?\s*,\s*(\d+(?:\.\d+)?)px[^}]*scale\((0\.\d+)\)/);
print('  measured: flight ' + (UI._FLY_DUR_MS) + 'ms, wind-up keyframe ' + (wind ? wind[1] + '% (+' + wind[2] + 'px, scale ' + wind[3] + ')' : 'none'));
check('the flight ghost itself winds up (dips + compresses) before it arcs', !!wind && +wind[1] > 0 && +wind[1] <= 20 && +wind[2] > 0);
check('flight shortened toward Snap (320-380ms)', UI._FLY_DUR_MS >= 320 && UI._FLY_DUR_MS <= 380, UI._FLY_DUR_MS);
check('the dead hand-tile anticipation class is gone', !/classList\.add\('card-anticipating'\)/.test(render));
check('the overshoot-then-settle survives (scale > 1 on the way in, 1 at rest)',
  /scale\(1\.0[2-9]\d*\)/.test(arc) && /100%\s*\{[^}]*scale\(1(\.0)?\)/.test(arc));

// ---- 6. The flash is compositor-only ---------------------------------------
var fl = keyframes('laneLandFlash');
check('the lane flash animates opacity only (no box-shadow/filter per frame)', !!fl && /opacity/.test(fl) && !/box-shadow|filter|background/.test(fl));
check('the play cue still fires at commit with its stagger gate', /this\.sfx\._playStaggerUntil = Date\.now\(\)/.test(SRC));

UI.sfx.play = realPlay;
print('land-thump: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
