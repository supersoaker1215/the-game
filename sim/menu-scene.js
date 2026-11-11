// ============================================================
// MENU SCENES: RANDOM EACH VISIT, NAMES ALONG THE BOTTOM.
//
//   jsc sim/menu-scene.js
//
// Owner (2026-11-11): "it should be random and the names at the bottom to
// switch". Measured live at 1600x1000: a fresh load picked Black Hole; the
// bar read Black Hole* | Event Horizon | Earth | Orbit | Gas Giant; switching
// to Earth on the start screen did NOT dismiss it; Gas Giant swapped in the
// playing video (WebGL loop stopped); PRESS START kept Gas Giant in the menu;
// hiding the overlay stopped the render loop, showing it restarted it.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
load('./menu-scene.js');
var SRC = read('ui.js'), CSS = read('style.css'), HTML = read('index.html');
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
check('the start screen shows the bar', /MenuScene\.barHTML\(\) : ''\}`;\s*this\._mountMenuVideo/.test(SRC));
check('the menu shows the bar', /_flowOn && typeof MenuScene !== 'undefined' \? MenuScene\.barHTML\(\) : ''/.test(SRC));
check('picking a scene never dismisses the start screen', /closest\('\.ts-options, \.mm-scene-bar,/.test(SRC));
check('the shared backdrop mounts the scene', /if \(typeof MenuScene !== 'undefined'\) \{ MenuScene\.mount\(host\); return; \}/.test(SRC));
check('the bar is boxless (no border/background box)', /\.main-menu-overlay \.mm-scene-opt \{\s*background: none; border: 0;/.test(CSS));

print('menu-scene: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('menu-scene failed');
