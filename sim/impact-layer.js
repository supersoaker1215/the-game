// ============================================================
// HEAVY HITS AND KILLS LAND LIKE AAA HITS.
//
//   jsc sim/impact-layer.js
//
// Heavy and lethal hits get a short hit-stop, a contact flash + sparks at the
// target's edge facing the attacker, and a camera kick along the blow. The kick
// rides `translate` so it never fights the screen shake's `transform`.
// These checks RUN the hit path (UI._fxPlayOne) and watch what it does.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
var T = UI._TIER_FX;
check('heavy hits freeze briefly (hit-stop), not only kills', T.heavy.hitPause > 0 && T.heavy.hitPause <= 90, T.heavy.hitPause);
check('a kill\'s freeze is a few frames, not a stall (<= 160ms)', T.lethal.hitPause > T.heavy.hitPause && T.lethal.hitPause <= 160, T.lethal.hitPause);
check('light/medium stay snappy: no freeze, no kick', !T.light.hitPause && !T.medium.hitPause && !T.light.kick && !T.medium.kick);
check('heavy + lethal kick the camera, lethal harder and with a zoom punch', T.heavy.kick > 0 && T.lethal.kick > T.heavy.kick && T.lethal.zoom > 1);

// ---- harness: record every translate/transform write on #game-area, and hold
// rAF callbacks so the kick's first frame is observable before it settles back.
var area = document.getElementById('game-area');
var writes = [];
function watch(prop) {
  var v = '';
  Object.defineProperty(area.style, prop, { configurable: true,
    get: function () { return v; }, set: function (x) { v = x; writes.push(prop + '=' + x); } });
}
watch('translate'); watch('transform'); watch('scale');
var heldRaf = [];
window.requestAnimationFrame = requestAnimationFrame = function (fn) { heldRaf.push(fn); return heldRaf.length; };
var calls = [];
var realLayer = UI._impactLayer;
UI._impactLayer = function () { calls.push(Array.prototype.slice.call(arguments)); return realLayer.apply(this, arguments); };
UI._reducedMotion = function () { return false; };
['_screenShake', '_hitPauseFreeze', '_haptic', '_spawnAttackBeam', 'spawnHitChips', '_cardKnockback', '_fxImpact', '_fxSparks', '_fxKillFloat']
  .forEach(function (k) { UI[k] = function () {}; });
function reset() { writes.length = 0; heldRaf.length = 0; calls.length = 0; area.style.translate = ''; writes.length = 0; }

function boardCard(id, cls) {
  var board = document.querySelector('.board') || (function () { var b = document.createElement('div'); b.className = 'board'; document.body.appendChild(b); return b; })();
  var el = document.createElement('div');
  el.className = 'card ' + cls; el.dataset.cardId = String(id);
  board.appendChild(el);
  return el;
}
var target = boardCard(9001, 'ally-card');

// 1. a heavy hit on a card that is still on the board
reset();
try { UI._fxPlayOne({ type: 'hit', cardId: 9001, amount: 7 }); } catch (e) { fails.push('heavy hit threw: ' + (e.message || e)); }
check('a heavy hit runs the impact layer', calls.length === 1 && calls[0][0] === target, calls.length);
check('the kick moves the view along the blow via translate', writes.indexOf('translate=0 ' + T.heavy.kick + 'px') >= 0, writes.join(', '));
check('the kick never writes transform (that is the shake\'s)', !writes.some(function (w) { return w.indexOf('transform=') === 0; }), writes.join(', '));
heldRaf.splice(0).forEach(function (f) { f(); });
check('…and settles back to rest', area.style.translate === '', JSON.stringify(area.style.translate));

// 2. a light hit: no impact layer at all
reset();
UI._fxPlayOne({ type: 'hit', cardId: 9001, amount: 1 });
check('a light hit does not kick', calls.length === 0 && writes.length === 0, writes.join(', '));

// 3. a killing blow whose card is already gone still kicks
reset();
UI._fxPlayOne({ type: 'hit', cardId: 424242, amount: 9, lethal: true });
check('a killing blow on a removed card still runs the impact layer', calls.length === 1 && calls[0][0] === null && calls[0][3] === 424242, JSON.stringify(calls.map(function (c) { return c.length; })));

// 4. low-fx tier and reduced motion skip the kick
reset();
document.body.classList.add('low-fx');
UI._fxPlayOne({ type: 'hit', cardId: 9001, amount: 7 });
check('low-fx tier: no camera kick', writes.length === 0, writes.join(', '));
document.body.classList.remove('low-fx');
reset();
UI._reducedMotion = function () { return true; };
UI._impactLayer(target, null, T.heavy);
check('reduced motion: no camera kick', writes.length === 0, writes.join(', '));

print('impact-layer: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('impact-layer failed');
