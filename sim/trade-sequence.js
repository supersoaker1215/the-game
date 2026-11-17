// ============================================================
// ONE EXCHANGE: EACH LUNGE LANDS ON ITS HIT, AND DEATH COMES LAST.
//
//   jsc sim/trade-sequence.js
//
// In a contested trade the engine kills a card before the UI shows a swing.
// So: each 'swing' event lunges its attacker on that swing's beat; the lane
// beat itself no longer lunges a contested lane on its own clock (a held death
// keeps the lane contested); a combat death is held to its death beat, with a
// pinned stand-in on screen until it is released. These checks run each piece
// (UI._fxPlayOne, markActiveLaneBeat, spawnDestroyParticles, _spawnDeathGhost)
// against a controllable clock.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var CSSTEXT = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join(''));
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

// ---- a controllable clock ---------------------------------------------------
var TIMERS = [], realST = setTimeout;
function holdTimers() { TIMERS = []; setTimeout = function (fn, ms) { TIMERS.push({ fn: fn, ms: ms | 0 }); return TIMERS.length; }; }
function freeTimers() { setTimeout = realST; }
function flush() { while (TIMERS.length) TIMERS.shift().fn(); }

UI.sfx = UI.sfx || {};
var keepIn = UI.sfx._inCombat, keepRM = UI._reducedMotion;
UI._reducedMotion = function () { return false; };

// ---- 1. every swing lunges its attacker on the swing's beat -----------------
var LUNGES = [];
var realLunge = UI._lungeOnBeat;
UI._lungeOnBeat = function (id, beat) { LUNGES.push([id, beat]); };
UI._playAttackerCue = function () {}; UI._bookLaneAudioUntil = function () {};
holdTimers();
UI._fxPlayOne({ type: 'swing', attackerId: 77, owner: 'player', name: 'X' });
UI._fxPlayOne({ type: 'swing', attackerId: 78, owner: 'ai', name: 'Y' });
freeTimers();
check('a player swing lunges its attacker on the player\'s beat',
      LUNGES[0] && LUNGES[0][0] === 77 && LUNGES[0][1] === UI._swingBeatMs('player'), JSON.stringify(LUNGES));
check('an opponent swing lunges on the opponent\'s beat',
      LUNGES[1] && LUNGES[1][0] === 78 && LUNGES[1][1] === UI._swingBeatMs('ai'), JSON.stringify(LUNGES));
UI._lungeOnBeat = realLunge;

// ---- 2. the lane beat leaves a contested lane to the swings ------------------
var boardHost = document.createElement('div');
document.body.appendChild(boardHost);
function lanes(n) {
  boardHost.innerHTML = '';
  for (var i = 0; i < n; i++) { var l = document.createElement('div'); l.className = 'lane'; l.dataset.lane = String(i); boardHost.appendChild(l); }
  return boardHost.querySelectorAll('.lane');
}
function tile(laneEl, id) {
  var el = document.createElement('div'); el.className = 'card'; el.dataset.cardId = String(id);
  laneEl.appendChild(el); return el;
}
function beat(laneState) {
  Game.init();
  Game.state.lanes = [laneState];
  Game.state._activeLane = 0;
  UI._lastActiveLane = null;
  holdTimers();
}
// Records whether a class was EVER added (the beat removes it again on a timer).
function anyAdded(el, cls) {
  var hit = false, orig = el.classList.add;
  el.classList.add = function () { for (var i = 0; i < arguments.length; i++) if (arguments[i] === cls) hit = true; return orig.apply(this, arguments); };
  return function () { return hit; };
}

var L = lanes(1);
var pEl = tile(L[0], 501), aEl = tile(L[0], 502);
var pLunge = anyAdded(pEl, 'combat-attacker'), aLunge = anyAdded(aEl, 'combat-attacker');
var pFlash = anyAdded(pEl, 'hit-flash'), aFlash = anyAdded(aEl, 'hit-flash');
beat({ player: { id: 501, attack: 3, currentHealth: 3 }, ai: { id: 502, attack: 3, currentHealth: 3 } });
UI.markActiveLaneBeat(); flush(); freeTimers();
check('a contested lane is not lunged on the lane\'s own clock', !pLunge() && !aLunge());
check('…nor flashed', !pFlash() && !aFlash());

// control: the same harness DOES see an uncontested lunge
L = lanes(1);
pEl = tile(L[0], 511);
pLunge = anyAdded(pEl, 'combat-attacker');
beat({ player: { id: 511, attack: 3, currentHealth: 3 }, ai: null });
UI.markActiveLaneBeat(); flush(); freeTimers();
check('an uncontested lane still lunges at the face (harness control)', pLunge());

// a held death keeps its lane contested
L = lanes(1);
pEl = tile(L[0], 521);
pLunge = anyAdded(pEl, 'combat-attacker');
UI._deathHold = new Map([['522', { at: 0, hold: 500, side: 'ai', lane: 0, atk: 2 }]]);
beat({ player: { id: 521, attack: 3, currentHealth: 3 }, ai: null });
UI.markActiveLaneBeat(); flush(); freeTimers();
check('a held death keeps its lane contested (the survivor does not face-lunge)', !pLunge());
UI._deathHold = null;

// ---- 3. a combat death is held to its death beat ----------------------------
var dissolved = [], released = [];
var realDis = UI._dissolveCardEl, realRel = UI._releaseDeath;
UI._dissolveCardEl = function (el) { dissolved.push(el && el.dataset.cardId); };
UI._releaseDeath = function (id) { released.push(String(id)); };
L = lanes(1);
var victim = tile(L[0], 531);
UI.sfx._inCombat = true;
holdTimers();
UI.spawnDestroyParticles(531, 'ai');
var hold = UI._deathHoldMs('ai');
check('in combat the death is not dissolved at once', dissolved.length === 0, dissolved.join());
check('…it is held for its death beat', TIMERS.some(function (t) { return t.ms === hold; }) && hold > 0,
      TIMERS.map(function (t) { return t.ms; }).join(',') + ' vs ' + hold);
check('…and remembered as held, with its lane', UI._isDeathHeld(531) && UI._deathHold.get('531').lane === 0);
flush(); freeTimers();
check('…then released when the beat comes', released.join() === '531', released.join());
UI._dissolveCardEl = realDis; UI._releaseDeath = realRel;
if (UI._deathHold) UI._deathHold.delete('531');

// ---- 4. the removed card stands in until released ---------------------------
UI._deathHold = new Map([['541', { at: 0, hold: 500, side: 'ai', lane: 0, atk: 1 }]]);
holdTimers();
UI._spawnDeathGhost({ top: 10, left: 20, width: 100, height: 150 }, '<div class="card" data-card-id="541"></div>', 541);
var ghost = document.querySelector('[data-ghost-of="541"]');
check('a held death leaves a stand-in carrying data-ghost-of', !!ghost);
check('…classed as the held stand-in, not the dissolving ghost',
      !!ghost && ghost.classList.contains('card-death-hold') && !ghost.classList.contains('card-death-ghost'), ghost && ghost.className);
check('…with no live card id to collide with', !!ghost && ghost.getAttribute('data-card-id') === null);
if (ghost) ghost.remove();
UI._deathHold = null;
UI._spawnDeathGhost({ top: 10, left: 20, width: 100, height: 150 }, '<div class="card ghostx" data-card-id="542"></div>', 542);
var g2 = document.querySelector('.ghostx');
check('a death that is not held dissolves as a plain ghost', !!g2 && g2.classList.contains('card-death-ghost') && !g2.classList.contains('card-death-hold'));
if (g2) g2.remove();
freeTimers();

// CSS: there is no cascade in the shim, so the pin is checked as stylesheet text.
check('the stand-in is pinned in place', /\.card-death-hold \{[^}]*position:\s*fixed !important/.test(CSSTEXT));

// ---- 5. the hold window -----------------------------------------------------
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
