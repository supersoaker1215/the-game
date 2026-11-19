// ============================================================
// THE LOCATION REVEAL OUTLIVES THE RENDER THAT FOLLOWS IT.
//
//   jsc sim/env-reveal.js
//
// An environment's reveal (lane flash + name) is painted on the body-level
// FX layer over its lane. Parented inside the lane it was deleted by the very
// next renderBoard, which always follows the play that raised it. Reduced
// motion keeps the name as a plain fade instead of skipping it.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

Game.init(); Game.seedMatch(5);
Game.state.lanes.forEach(function (l) { l.player = null; l.ai = null; });
UI.renderBoard(Game.state);
// The fake DOM has no layout; give every lane a box so the stage can place itself.
var realLaneAt = UI.laneElAt;
UI.laneElAt = function (i) {
  var el = realLaneAt.call(UI, i);
  if (el) el.getBoundingClientRect = function () { return { left: 100 * i, top: 50, width: 90, height: 400 }; };
  return el;
};
var motion = false;
UI._reducedMotion = function () { return motion; };
// Keep the stage alive for inspection: the fake DOM runs timeouts at once.
var realST = setTimeout, held = [];
setTimeout = window.setTimeout = function (fn, ms) { held.push(fn); return held.length; };

UI.fxEnvReveal(1, 'Boiler Room', 'player');
function stages() { return document.querySelectorAll('.env-reveal-stage'); }
var st = stages()[0];
var layer = document.getElementById('signature-fx-layer');
check('the reveal is painted on the body-level FX layer', st && layer && st.parentNode === layer, st && st.parentNode && (st.parentNode.id || st.parentNode.className));
check('…not inside the lane', !realLaneAt.call(UI, 1).querySelector('.env-reveal-stage'));
check('…and carries the environment name', st && /Boiler Room/.test(st.innerHTML));

UI.renderBoard(Game.state);
check('it survives the board render that follows the play', stages().length === 1 && stages()[0] === st, stages().length);

UI.fxEnvReveal(3, 'Wakanda', 'ai');
var opp = stages()[1];
check("the opponent's reveal is marked as theirs (their colour)", opp && /\bis-opponent\b/.test(opp.className), opp && opp.className);
check('your reveal is not', st && !/\bis-opponent\b/.test(st.className));

UI.fxEnvReveal(1, 'Boiler Room', 'player');
check('a second reveal in a lane replaces the first', stages().length === 2, stages().length);

motion = true;
UI.fxEnvReveal(4, 'Sanctum', 'player');
var calm = document.querySelectorAll('.env-reveal-stage.is-calm');
check('reduced motion still shows the name (shortened, not skipped)', calm.length === 1 && /Sanctum/.test(calm[0].innerHTML), calm.length);

held.forEach(function (fn) { fn(); });
check('every stage cleans itself up', stages().length === 0, stages().length);
setTimeout = window.setTimeout = realST;

// The event stream tells the reveal whose side played it.
check('the FX relay passes the viewer-relative side', /this\.fxEnvReveal\(ev\.lane, ev\.name, this\._fxDomSide \? this\._fxDomSide\(ev\.owner\) : ev\.owner\)/.test(read('fx.js')));

print('env-reveal: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('env-reveal failed');
