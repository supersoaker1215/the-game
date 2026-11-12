// ============================================================
// A DEATH NEVER THROWS.
//
//   jsc sim/dissolve-owner.js
//
// Found live 2026-11-11 while testing The Big Cheese: a card killed by an
// ability threw "ReferenceError: owner is not defined" from _dissolveCardEl
// (b9ea039 split it out of spawnDestroyParticles and dropped the parameter),
// up through handleDeath -> dealDamage -> the ability. The kill flash and the
// multikill counter never ran for any un-held death either.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
var el = document.createElement('div'); el.className = 'card enemy-card';
var seen = null, keepRec = UI._recordMultikill, keepRM = UI._reducedMotion;
UI._recordMultikill = function (side) { seen = side; };
UI._reducedMotion = function () { return false; };
var threw = null;
try { UI._dissolveCardEl(el, 'ai'); } catch (e) { threw = e; }
check('an enemy death dissolves without throwing', !threw, threw && String(threw));
check('…and credits the PLAYER with the kill', seen === 'player', seen);
seen = null; threw = null;
var el2 = document.createElement('div'); el2.className = 'card ally-card';
try { UI._dissolveCardEl(el2); } catch (e) { threw = e; }
check('no owner passed: falls back to the tile\'s side, no throw', !threw && seen === 'ai', (threw && String(threw)) || seen);
var SRC = (read('ui-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('\n'));
check('the un-held path passes the owner', /this\._dissolveCardEl\(cardEl, owner\);/.test(SRC));
check('the held path passes the side it stored', /this\._dissolveCardEl\(live, held \? held\.side : null\)/.test(SRC));
UI._recordMultikill = keepRec; UI._reducedMotion = keepRM;
print('dissolve-owner: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('dissolve-owner failed');
