// ============================================================
// MENU SCENES: RANDOM EACH VISIT, NAMES ALONG THE BOTTOM.
//
//   jsc sim/menu-scene.js
//
// The backdrop is a scene picked at random per visit; a bar of scene names
// along the bottom switches it, on the start screen and in the menu alike, and
// picking one never dismisses the start screen. These checks RUN the renderers,
// the dismiss handler and the canvas sizing.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
load('./menu-scene.js');
var CSS = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('')), HTML = read('index.html');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
var MS = window.MenuScene;

check('five scenes, in bar order', MS && MS.SCENES.map(function (s) { return s.name; }).join('|') === 'Black Hole|Event Horizon|Earth|Orbit|Gas Giant');
check('each picture scene points at a shipped file', MS.SCENES.filter(function (s) { return s.kind === 'photo'; }).every(function (s) { return /^menu\/[a-z-]+\.jpg$/.test(s.src); }));
// Random each visit: the pick is uniform-ish over a few hundred fresh visits.
var seen = {};
for (var i = 0; i < 400; i++) { MS.current = null; seen[MS._pick().id] = (seen[MS._pick().id] || 0) + 1; }
check('the first scene of a visit is random (all five come up)', Object.keys(seen).length === 5, JSON.stringify(seen));
MS.current = null; var first = MS._pick();
check('…and it stays put for the rest of the visit', MS._pick() === first && MS._pick() === first);
var bar = MS.barHTML();
check('the bar lists every scene name', MS.SCENES.every(function (s) { return bar.indexOf('>' + s.name + '<') >= 0; }));
check('the bar marks the current scene', new RegExp('is-on" data-scene="' + first.id + '"').test(bar), bar.slice(0, 160));
check('each name switches the scene', /onclick="MenuScene\.set\('blackhole'\)"/.test(bar) && /onclick="MenuScene\.set\('giant'\)"/.test(bar));

check('index.html loads menu-scene.js before ui.js', HTML.indexOf('menu-scene.js?v=') > 0 && HTML.indexOf('menu-scene.js?v=') < HTML.indexOf('ui.js?v='));
// ---- the bar is on both screens, and the backdrop is the scene ----------------
var mounts = [];
var realMount = MS.mount;
MS.mount = function (host) { mounts.push(host); };
var winL = {};
var realWinAdd = window.addEventListener;
window.addEventListener = function (t, fn) { (winL[t] = winL[t] || []).push(fn); };
var ov = document.getElementById('main-menu-overlay');
try {
  UI._titleDone = false; UI._titleArmed = false;
  UI.renderTitleScreen(Game.state);
  check('the start screen shows the bar', !!ov.querySelector('.mm-scene-bar'), ov.innerHTML.slice(-200));
  var vh = ov.querySelector('.mm-bgvideo');
  check('the shared backdrop mounts the scene', mounts.length === 1 && mounts[0] === vh, mounts.length);
  // Clicking a scene name on the start screen must not dismiss it.
  var opt = ov.querySelector('.mm-scene-bar').firstChild || ov.querySelector('.mm-scene-bar');
  var down = winL.pointerdown || [];
  down.forEach(function (fn) { fn({ type: 'pointerdown', target: opt }); });
  check('picking a scene never dismisses the start screen', down.length > 0 && UI._titleDone === false, 'listeners ' + down.length + ', done ' + UI._titleDone);
  var opts = ov.querySelector('.ts-options');
  down.forEach(function (fn) { fn({ type: 'pointerdown', target: opts }); });
  check('…nor does Options', UI._titleDone === false);
  var panel = ov.querySelector('.mm-panel');
  down.forEach(function (fn) { fn({ type: 'pointerdown', target: panel }); });
  check('…while a press anywhere else does', UI._titleDone === true);
} catch (e) { fails.push('start screen threw: ' + (e.message || e)); }
try {
  ov.innerHTML = ''; ov.className = 'main-menu-overlay';
  UI.settings.menuFlow = true;
  UI.renderMainMenu(Game.state);
  check('the menu shows the bar', !!ov.querySelector('.mm-scene-bar'));
  UI.settings.menuFlow = false;
  ov.innerHTML = '';
  UI.renderMainMenu(Game.state);
  check('…and hides it when the animated backdrop is off', !ov.querySelector('.mm-scene-bar'));
  UI.settings.menuFlow = true;
} catch (e) { fails.push('menu threw: ' + (e.message || e)); }
MS.mount = realMount; window.addEventListener = realWinAdd;

// ---- the canvas renders at the device's real pixel ratio ---------------------
function sized(dpr, low) {
  window.devicePixelRatio = dpr; innerWidth = 800; innerHeight = 500;
  if (low) document.body.classList.add('low-fx'); else document.body.classList.remove('low-fx');
  MS.cv = { width: 0, height: 0 }; MS.fx = { width: 0, height: 0 }; MS.gl = null;
  MS._scale = 1; MS._scale0 = 1; MS._scaleSet = false;
  MS._resize();
  return MS.cv.width;
}
check('renders at the real device ratio (HD), not a fraction of it', sized(2) === 1600, sized(2));
check('…capped at 2x', sized(3) === 1600, sized(3));
check('…and lowered on the low-fx tier', sized(2, true) === 960, sized(2, true));
document.body.classList.remove('low-fx');
sized(2); MS._scale = 1.4; MS._resize();
check('the adaptive step-down is kept between resizes (it only resets upward past the target)', MS._scale === 1.4, MS._scale);

check('the bar is boxless (no border/background box)', /\.main-menu-overlay \.mm-scene-opt \{\s*background: none; border: 0;/.test(CSS));
check('the start screen has no left-side scrim', /#main-menu-overlay\.ts-menulike \.mm-scrim \{ display: none; \}/.test(CSS));
print('menu-scene: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('menu-scene failed');
