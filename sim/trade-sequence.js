// ============================================================
// ONE EXCHANGE: EACH LUNGE LANDS ON ITS HIT, AND DEATH COMES LAST.
//
//   jsc sim/trade-sequence.js
//
// Measured live, real resolveCombat, 9/9 vs 2/2 (enemy dies):
//   before — enemy dissolve 40ms, removed 77ms (it never lunged), my lunge 77ms
//            (impact ~267), "-2" 454ms, "-9" 585ms on a card already gone.
//   after  — enemy lunge 259 (impact ~449) / "-2" 440; my lunge 378
//            (impact ~568) / "-9" 580; enemy dissolves 812ms.
// Both-die: enemy dissolves 803, mine 1062 (opponent first). Both-survive:
// "-2" 419 / "-3" 551 on their impacts.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var SRC = (read('ui.js') + '\n' + read('fx.js'))   /* fx.js = the effects library split out of ui.js */, CSS = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join(''));
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

check('every swing lunges its attacker on the swing\'s beat',
  /if \(ev\.type === 'swing'\) \{\s*const beat = [^;]*;\s*this\._lungeOnBeat\(ev\.attackerId, beat\);/.test(SRC));
var mal = SRC.slice(SRC.indexOf('  markActiveLaneBeat() {'), SRC.indexOf('  // ===================== SPLASH ANIMATION HOOK'));
var contested = mal.slice(mal.indexOf('if (p && a) {'), mal.indexOf('} else if (p) {'));
check('the lane beat no longer lunges a contested lane on its own clock', !/classOnCard\(/.test(contested) && !/hitFlashOn\(/.test(contested));
check('a held death keeps its lane contested', /const p = lane\.player \|\| heldIn\('player'\), a = lane\.ai \|\| heldIn\('ai'\);/.test(mal));
check('a combat death is held to its death beat',
  /const hold = this\._deathHoldMs\(owner\);\s*if \(hold > 0\) \{[\s\S]{0,700}setTimeout\(\(\) => this\._releaseDeath\(cardId\), hold\);\s*return;/.test(SRC));
check('the removed card stands in until released', /this\._isDeathHeld\(id\)\) \{\s*el\.classList\.add\('card-death-hold'\);\s*el\.setAttribute\('data-ghost-of'/.test(SRC));
check('the stand-in is pinned in place', /\.card-death-hold \{[^}]*position:\s*fixed !important/.test(CSS));

// Behaviour of the hold window.
UI.sfx = UI.sfx || {};
var keepIn = UI.sfx._inCombat, keepRM = UI._reducedMotion;
UI._reducedMotion = function () { return false; };
UI.sfx._inCombat = false;
check('outside combat a death is immediate', UI._deathHoldMs('ai') === 0);
UI.sfx._inCombat = true;
check('in combat it waits for its death beat', UI._deathHoldMs('ai') === UI._deathBeatMs('ai') && UI._deathHoldMs('player') === UI._deathBeatMs('player'));
check('…the player\'s after the opponent\'s', UI._deathHoldMs('player') > UI._deathHoldMs('ai'));
check('…and after the killing hit\'s beat', UI._deathHoldMs('ai') > UI._swingBeatMs('player'));
UI._reducedMotion = function () { return true; };
check('reduced motion never holds', UI._deathHoldMs('ai') === 0);
UI.sfx._inCombat = keepIn; UI._reducedMotion = keepRM;

print('trade-sequence: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('trade-sequence failed');
