// ============================================================
// THE PAGE NEVER ZOOMS (phone: "i can't see all 6 lanes").
//
//   jsc sim/no-page-zoom.js
//
// Measured: the layout fits 6 lanes on a phone (430pt: 70pt each; 393: 64),
// but the owner's board screenshot was ~2× magnified — iOS ignores
// user-scalable=no, and double-tap zoom was only disabled on buttons / cards /
// slots / lanes. Live after: root touch-action manipulation; a 2-finger
// touchmove is cancelled, a 1-finger one (card drag) is not.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var SRC = read('ui.js');
var CSS = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('')).replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
check('no double-tap zoom anywhere (root touch-action)', /html, body \{ touch-action: manipulation; \}/.test(CSS));
var fn = SRC.slice(SRC.indexOf('  installNoPageZoom() {'), SRC.indexOf('  installMobileCardDrag() {'));
check('pinch blocked: Safari gesture events', /'gesturestart', 'gesturechange', 'gestureend'/.test(fn) && /passive: false/.test(fn));
check('pinch blocked: only multi-touch moves (drag stays free)', /e\.touches && e\.touches\.length > 1/.test(fn));
check('installed at boot with the other input handlers', /this\.installMobileCardDrag\(\);\s*this\.installNoPageZoom\(\);/.test(SRC));
print('no-page-zoom: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('no-page-zoom failed');
