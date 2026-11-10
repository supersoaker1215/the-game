// ============================================================
// THE KILLING BLOW SHOWS ITS NUMBER.
//
//   jsc sim/kill-float.js
//
// Every hit pops "-N" on its card — except the one that kills: the victim is
// removed at death, and the hit's beat plays 175-515ms later, so the branch
// for a missing card fired shake/freeze/sound with no number. Measured live,
// Ant-Man (9 ATK) vs Poison Ivy (2 HP): before, the only float was Ant-Man's
// "-1"; after, a lethal-styled "-9" at 624ms, inside the box where Ivy stood
// (x 78 within 52-181), plus the "-1".
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var SRC = read('ui.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

var sp = SRC.indexOf('spawnDestroyParticles(cardId, owner) {');
var spBody = SRC.slice(sp, sp + 1600);
check('death records where the card stood, BEFORE the reduced-motion gate',
  spBody.indexOf('_rememberDeathRect(cardId, cardEl)') > 0 &&
  spBody.indexOf('_rememberDeathRect(cardId, cardEl)') < spBody.indexOf('_reducedMotion'));
var miss = SRC.indexOf("// The card is already off the board — which is precisely what happens on");
var missBody = SRC.slice(miss, miss + 2600);
check('the missing-card (killing blow) branch draws the number', /this\._fxKillFloat\(ev, fx\)/.test(missBody));

// Behaviour, with stubbed layout.
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
