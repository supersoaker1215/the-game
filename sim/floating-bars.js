// ============================================================
// FLOATING BARS — no full-width rules across the board.
//
//   jsc sim/floating-bars.js
//
// Owner: "too much lines across the whole board feels crammed" → floating
// bars. Measured live (classic skin): before, 1px full-width lines at the HUD
// underline, both edges of each bar (border AND a duplicate inset shadow) and
// the hand row's top (border AND a 0 -1px shadow); after, 0 full-width lines,
// bar heights/positions unchanged (47 / 64 / 64), the trick drop-zone tint
// still wins while dragging.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var CSS = read('style.css').replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
function body(sel) { var i = CSS.lastIndexOf(sel); if (i < 0) return ''; return CSS.slice(CSS.indexOf('{', i) + 1, CSS.indexOf('}', i)); }
check('HUD underline gone', /border-bottom-color:\s*transparent !important/.test(body('.turn-hud:where(body:not(.board-v2) *)')));
var bars = body('.info-bar.player-bar:where(body:not(.board-v2) *) {\n  border-top-color');
var barRule = CSS.slice(CSS.indexOf('.info-bar.ai-bar:where(body:not(.board-v2) *),'));
barRule = barRule.slice(barRule.indexOf('{') + 1, barRule.indexOf('}'));
check('bar edges gone (borders)', /border-top-color:\s*transparent !important/.test(barRule) && /border-bottom-color:\s*transparent !important/.test(barRule));
check('bar edges gone (the duplicate inset shadows)', /box-shadow:\s*none !important/.test(barRule));
check('hand row top rule gone (border + shadow)', /border-top-color:\s*transparent !important[\s\S]*box-shadow:\s*none !important/.test(body('.player-hand-section:where(body:not(.board-v2) *)')));
check('each bar keeps one short fading accent toward the board',
  /0\) 40%\) left bottom \/ 100% 1px no-repeat/.test(body('.info-bar.ai-bar:where(body:not(.board-v2) *) {\n  background')) &&
  /0\) 40%\) left top \/ 100% 1px no-repeat/.test(body('.info-bar.player-bar:where(body:not(.board-v2) *) {\n  background')));
check('weight kept low so the trick drop-zone tint still wins', !/body:not\(\.board-v2\) #game-area > \.info-bar/.test(CSS.slice(CSS.indexOf('FLOATING BARS'))));
// Part 2 — lane and tray edges. The lanes' visible top/bottom pair is a
// border-IMAGE (width "1 0": top + bottom only) whose heaviest rule is
// `.board-section .lane` (0,2,0) !important; turning it off must also keep the
// plain side borders invisible (a border-image had been hiding them).
check('lane border-image off at the weight of its heaviest rule',
  /\.board-section \.lane:where\(body:not\(\.board-v2\) \*\) \{\s*border-image:\s*none !important;/.test(CSS));
check('lane borders all transparent (sides never showed)', /border-color:\s*transparent !important/.test(body('.lane:where(body:not(.board-v2) .board > *)')));
check('trick tray top edge gone (border + shadow)', /border-top-color:\s*transparent !important[\s\S]*box-shadow:\s*none !important/.test(body('.tricks-section:where(body:not(.board-v2) *)')));

print('floating-bars: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('floating-bars failed');
