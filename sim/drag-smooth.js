// ============================================================
// DRAG-TO-PLAY SMOOTHNESS
//
//   jsc sim/drag-smooth.js
//
// Owner: "the animation of drag to play seems choppy i want that very smooth."
// Measured before (desktop Chromium, 2 moves/frame like a phone digitiser):
// 1.9ms main-thread per frame, the ghost moved by left/top (layout + a repaint
// of its drop-shadow filter every move), offsetWidth read back after each write
// (forced layout), the lane highlight stripped + re-added every event, and the
// tilt computed from raw per-event deltas (jerk 0.48). After: 1.2ms/frame,
// compositor-only translate, one hit-test per frame, tilt eased per frame and
// settling to level (jerk 0.35, peak 2.5deg on a normal drag); ghost centre
// within 0.3px of the aim point and the drop still plays the card.
// Paint cost cannot be measured here, so this pins the mechanism.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var SRC = (read('ui-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('\n'));
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

function body(fnHead) {
  var i = SRC.indexOf(fnHead); if (i < 0) return '';
  var j = SRC.indexOf('{', i), depth = 0, k = j;
  for (; k < SRC.length; k++) { if (SRC[k] === '{') depth++; else if (SRC[k] === '}' && --depth === 0) break; }
  return SRC.slice(j, k + 1);
}
var strip = function (s) { return s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); };

// 1. The move handlers only RECORD the point; the work happens once per frame.
var install = strip(body('installMobileCardDrag() {'));
var touchMove = install.slice(install.indexOf("addEventListener('touchmove'"));
touchMove = touchMove.slice(0, touchMove.indexOf('{ passive: false }'));
var mouseMove = install.slice(install.indexOf("addEventListener('mousemove'"));
mouseMove = mouseMove.slice(0, mouseMove.indexOf("addEventListener('mouseup'"));
[['touchmove', touchMove], ['mousemove', mouseMove]].forEach(function (p) {
  check(p[0] + ' queues the move for the next frame', /queueDragMove\(/.test(p[1]));
  check(p[0] + ' no longer positions the ghost per event', !/_positionDragGhost\(/.test(p[1]));
  check(p[0] + ' no longer hit-tests lanes per event', !/laneIdxUnder\(/.test(p[1]));
  check(p[0] + ' no longer strips the highlight per event', !/clearHi\(\)/.test(p[1]));
});
check('one frame step is scheduled with requestAnimationFrame', /requestAnimationFrame\(dragFrame\)/.test(install));
check('the highlight changes only when the lane under the card changes', /if \(i !== hiLane\)/.test(install));
check('a drop applies the pending frame before judging the ghost', /const endAt = \(px, py\) => \{\s*if \(!d\) return;\s*flushDragFrame\(\);/.test(install));

// 2. The ghost moves by compositor transform; layout is written once.
(function () {
  var writes = [], reads = 0;
  var g = { style: { setProperty: function (k, v) { writes.push([k, v]); } } };
  Object.defineProperty(g, 'offsetWidth', { get: function () { reads++; return 100; } });
  Object.defineProperty(g, 'offsetHeight', { get: function () { reads++; return 200; } });
  UI._positionDragGhost(g, 300, 400, 0);
  UI._positionDragGhost(g, 350, 380, 4);
  UI._positionDragGhost(g, 410, 300, -3);
  var lefts = writes.filter(function (w) { return w[0] === 'left' || w[0] === 'top'; });
  check('left/top are written once, at the lift point', lefts.length === 2, lefts.length + ' writes');
  check('the lift anchor centres the card on the pointer', lefts[0][1] === '250px' && lefts[1][1] === '276px', JSON.stringify(lefts));
  check('the size is measured once, not per move', reads === 2, reads + ' reads');
  var last = writes.filter(function (w) { return w[0] === 'transform'; }).pop()[1];
  check('later moves are a translate from the anchor', /^translate3d\(110\.0px, -100\.0px, 0\) rotate\(-3\.00deg\) scale\(1\.06\)$/.test(last), last);
})();
check('the ghost is promoted to its own layer', /will-change:transform/.test(body('_prepCardDragGhost(cardEl) {')));

// 3. The lift frame (owner: "do 2" — make picking up a card instant).
// Measured same session, same harness: lift 8.3 → 2.3 ms, drop 5.9 → 1.3 ms;
// ghost ready before the lift 8/8; a tap leaves 0 ghosts; mouse + touch both
// play the card with exactly one ghost on screen.
check('a press schedules the ghost build for a spare frame', (install.match(/prepGhostSoon\(\);/g) || []).length === 2);
check('the lift adopts the prepared ghost', /_makeCardDragGhost\(d\.cardEl, t\.clientX, t\.clientY, d\.prep\)/.test(install)
  && /_makeCardDragGhost\(d\.cardEl, e\.clientX, e\.clientY, d\.prep\)/.test(install));
check('a tap or cancel throws the unused ghost away', (install.match(/dropPrep\(d\);/g) || []).length === 2);
var make = strip(body('_makeCardDragGhost(cardEl, px, py, prepared) {'));
check('only a ghost built from THIS card is adopted', /prepared\._dragSrc === cardEl/.test(make) && /prepared\.isConnected/.test(make));
var CSS = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('')).replace(/\/\*[\s\S]*?\*\//g, '');
check('no style change lands on <body> itself when a drag starts (re-resolved the whole document: ~2.6ms each way)',
  !/body\.mobile-card-dragging\s*\{/.test(CSS));

print('drag-smooth: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('drag-smooth failed');
