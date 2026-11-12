// ============================================================
// A DRAGGED CARD LANDS WHERE IT WAS DROPPED.
//
//   jsc sim/drag-land.js
//
// Measured live (main, before): drag-and-drop a card onto a lane →
// _spawnPlayerLandFx, the landing ring, the thump and _animateFly were ALL
// never called — the card sat hidden as `card-flying` until a 900ms sweep and
// then simply appeared. Tap-to-play was fine. Drag is the gesture most players
// (and every phone player) use. After: a drop marks the card, renderBoard lands
// it in place and the hand→lane flight is skipped; live, _spawnPlayerLandFx /
// _landThump / _screenShake(land-s) at 12ms, card visible, no stuck flight.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var SRC = (read('ui-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('\n'));
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

check('the drop marks the card before playing it',
  /if \(i != null && Game\.state\.selectedCard === card\) \{[\s\S]{0,700}UI\._markDragDropped\(card\.id\);[\s\S]{0,200}this\.onLaneClick\(i\)/.test(SRC));
check('renderBoard lands a dropped card in place (no flight)',
  /const willFly = pv && pv\.inHand[^;]*&& !this\._wasDragDropped\(plDisplayCard\.id\);/.test(SRC));
check('the motion pass never flies a dropped card from the hand',
  /if \(!prev \|\| !prev\.inHand\) continue;\s*if \(this\._wasDragDropped\(id\)\) continue;/.test(SRC));

UI._dragDropped = null;
check('unmarked card is not drag-dropped', UI._wasDragDropped(7) === false);
UI._markDragDropped(7);
check('a marked card is drag-dropped (string/number ids agree)', UI._wasDragDropped(7) === true && UI._wasDragDropped('7') === true);
var realNow = performance.now; performance.now = function () { return realNow.call(performance) + 5000; };
check('the mark expires, so a card returned to hand flies again later', UI._wasDragDropped(7) === false);
performance.now = realNow;

print('drag-land: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('drag-land failed');
