// ============================================================
// A TRICK REVEAL NEVER COVERS AN OPEN DECISION.
//
//   jsc sim/reveal-fit.js
//
// In the right-hand column the decision panel takes the top and the reveal
// gives up room first. A squeezed reveal scales its whole card down to the
// room it got (UI._fitRevealToColumn) instead of spilling up over the
// decision's buttons or reflowing its text. The fake DOM has no layout, so
// the heights the browser would measure are supplied here; the CSS half
// (who gives first, which way overflow goes) is checked as cascade text.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var CSS_TEXT = read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('\n');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

var rafs = [];
window.requestAnimationFrame = requestAnimationFrame = function (fn) { rafs.push(fn); return rafs.length; };
function flush() { for (var i = 0; i < 10 && rafs.length; i++) rafs.shift()(); }
window.getComputedStyle = getComputedStyle = function () { return { rowGap: '6px', getPropertyValue: function () { return ''; } }; };

function dock(roomPx, cardPx) {
  var col = document.getElementById('right-col') || (function () { var c = document.createElement('div'); c.id = 'right-col'; document.body.appendChild(c); return c; })();
  var wrap = document.createElement('div'); wrap.className = 'trick-reveal';
  var card = document.createElement('div'); card.className = 'trick-reveal-card';
  var timer = document.createElement('div'); timer.className = 'tr-timer';
  var label = document.createElement('div'); label.className = 'tr-label';
  wrap.appendChild(card); wrap.appendChild(timer); wrap.appendChild(label);
  col.appendChild(wrap);
  Object.defineProperty(wrap, 'clientHeight', { get: function () { return roomPx; } });
  Object.defineProperty(card, 'offsetHeight', { get: function () { return cardPx; } });
  Object.defineProperty(timer, 'offsetHeight', { get: function () { return 3; } });
  Object.defineProperty(label, 'offsetHeight', { get: function () { return 15; } });
  wrap.isConnected = true;
  UI._fitRevealToColumn(wrap);
  flush();
  return card;
}

// Squeezed under an open decision: 153px of room for a 280px card.
var squeezed = dock(153, 280);
var expect = (153 - 3 - 15 - 6 * 2) / 280;
check('a squeezed reveal scales its whole card to the room it got',
  Math.abs(parseFloat(squeezed.style.zoom) - expect) < 0.001, squeezed.style.zoom + ' vs ' + expect.toFixed(4));

// Plenty of room: the card is left at its own size.
var roomy = dock(400, 280);
check('a reveal with room keeps its card at full size', !roomy.style.zoom, roomy.style.zoom);

// Never vanishes to a dot.
var tiny = dock(40, 280);
check('the scale has a floor so the card stays recognisable', parseFloat(tiny.style.zoom) === 0.35, tiny.style.zoom);

// The docked reveal is wired to the fit.
check('the reveal is fitted when it docks', /this\._fitRevealToColumn\(wrap\);/.test(read('ui.js')));

// Cascade: the reveal gives first, and overflow goes down, not up.
check('the docked reveal absorbs the column shortfall before the decision',
  /#right-col > \.trick-reveal \{[^}]*flex-shrink:\s*1000/.test(CSS_TEXT));
check('a docked reveal never centres its overflow up over the decision',
  /body\.decision-column:not\(\.board-v2\):has\(#classic-decision\) #right-col > \.trick-reveal \{\s*justify-content:\s*flex-start/.test(CSS_TEXT));

print('reveal-fit: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('reveal-fit failed');
