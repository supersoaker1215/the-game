// ============================================================
// THE KILLING BLOW SHOWS ITS NUMBER.
//
//   jsc sim/kill-float.js
//
// Every hit pops "-N" on its card — including the one that kills, whose card
// is removed at death while the hit's beat plays 175-515ms later. So death
// records where the card stood (spawnDestroyParticles -> _rememberDeathRect)
// before any gate can return, and the missing-card branch of the hit player
// draws the number there (_fxKillFloat). These checks run both halves.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

var RECT = { left: 52, top: 121, width: 129, height: 255, right: 181, bottom: 376, x: 52, y: 121 };
function boardCard(id) {
  var el = document.createElement('div');
  el.className = 'card enemy-card'; el.dataset.cardId = String(id);
  el.getBoundingClientRect = function () { return RECT; };
  document.body.appendChild(el);
  return el;
}
UI.sfx = UI.sfx || {};
var keepIn = UI.sfx._inCombat, keepRM = UI._reducedMotion, keepDis = UI._dissolveCardEl;

// ---- 1. death records where the card stood, whichever way it then leaves ----
var order = [];
var realRemember = UI._rememberDeathRect;
UI._rememberDeathRect = function (id) { order.push('remember:' + id); return realRemember.apply(this, arguments); };
UI._dissolveCardEl = function () { order.push('dissolve'); };

// a) outside combat, normal motion: recorded, then dissolved — in that order
UI._deathRects = null; order = [];
UI.sfx._inCombat = false; UI._reducedMotion = function () { return false; };
var a = boardCard(41);
UI.spawnDestroyParticles(41, 'ai');
check('a death outside combat records the rect', !!(UI._deathRects && UI._deathRects.get('41')), JSON.stringify(order));
check('…before it dissolves', order.join() === 'remember:41,dissolve', order.join());
a.remove();

// b) in combat the death is HELD (an early return): still recorded
UI._deathRects = null; order = [];
UI.sfx._inCombat = true;
var heldT = [], realST = setTimeout;
setTimeout = function (fn, ms) { heldT.push(fn); return heldT.length; };
var b = boardCard(43);
UI.spawnDestroyParticles(43, 'ai');
setTimeout = realST;
check('a held combat death still records the rect', !!(UI._deathRects && UI._deathRects.get('43')), JSON.stringify(order));
check('…and is not dissolved yet', order.indexOf('dissolve') < 0, order.join());
if (UI._deathHold) UI._deathHold.delete('43');
b.remove();

// c) reduced motion: the number is information, so it is still recorded
UI._deathRects = null; order = [];
UI.sfx._inCombat = false; UI._reducedMotion = function () { return true; };
var c = boardCard(44);
UI.spawnDestroyParticles(44, 'ai');
var r44 = UI._deathRects && UI._deathRects.get('44');
check('reduced motion still records the rect', !!r44);
check('…with the card\'s geometry', !!r44 && r44.left === 52 && r44.top === 121 && r44.width === 129, JSON.stringify(r44));
c.remove();

UI._rememberDeathRect = realRemember;
UI._dissolveCardEl = keepDis;
UI.sfx._inCombat = keepIn; UI._reducedMotion = keepRM;

// ---- 2. a hit on a card that is already gone draws the number ---------------
var KF = [];
var realKF = UI._fxKillFloat;
UI._fxKillFloat = function (ev, fx) { KF.push({ ev: ev, fx: fx }); };
['_screenShake', '_hitPauseFreeze', '_haptic', '_impactLayer', '_bookLaneAudioUntil'].forEach(function (k) { UI[k] = function () {}; });
UI.sfx.play = function () {};
UI._reducedMotion = function () { return true; };   // beat 0: fire inline
UI._fxPlayOne({ type: 'hit', cardId: 424242, amount: 9, lethal: true });
check('a killing blow on a removed card draws the number', KF.length === 1 && KF[0].ev.cardId === 424242, KF.length);
check('…with the lethal tier', KF.length === 1 && KF[0].fx === UI._TIER_FX.lethal);
KF = [];
UI._fxPlayOne({ type: 'hit', cardId: 424243, amount: 0 });
check('a zero hit on a removed card draws nothing', KF.length === 0, KF.length);
UI._fxKillFloat = realKF;
UI._reducedMotion = keepRM;

// ---- 3. the float itself ----------------------------------------------------
UI._deathRects = null;
UI._rememberDeathRect(42, { getBoundingClientRect: function () { return { left: 52, top: 121, width: 129, height: 255 }; } });
var f = UI._fxKillFloat({ cardId: 42, amount: 9 }, UI._TIER_FX.lethal);
check('a float is built for a remembered card', !!f);
if (f) {
  check('it reads "-9"', f.textContent === '-9', f.textContent);
  check('lethal tier styling', /dmg-float-lethal/.test(f.className) && /dmg-hit/.test(f.className), f.className);
  var box = f.parentElement;
  check('anchored where the card stood', box && /left:\s*52px/.test(box.style.cssText) && /top:\s*121px/.test(box.style.cssText) && /width:\s*129px/.test(box.style.cssText), box && box.style.cssText);
}
check('an unknown card draws nothing', UI._fxKillFloat({ cardId: 999, amount: 3 }, UI._TIER_FX.light) === null);

print('kill-float: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (x) { print('  FAIL  ' + x); });
if (fails.length) throw new Error('kill-float failed');
