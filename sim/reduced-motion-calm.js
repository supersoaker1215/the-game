// ============================================================
// REDUCED MOTION SHORTENS WHAT CARRIES INFORMATION; IT DOES NOT DELETE IT.
//
//   jsc sim/reduced-motion-calm.js
//
// Under the OS "reduce motion" setting a catch-all snaps every animation to
// 0.01ms, which lands each one on its END frame. An effect that ends
// invisible (a damage number, a death, a face hit, a location name) is then
// never seen. Each effect below carries game information, so it must (a) still
// be built by the JS, and (b) own a reduced-motion rule whose !important
// duration outranks the catch-all, and never be hidden or set to none.
// Spectacle (per-card cinematics, shake, motes) is deliberately left deleted.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

// ---- The cascade half: every rule inside a prefers-reduced-motion block.
var css = read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
var rmRules = [];
(function collect() {
  var re = /@media[^{]*prefers-reduced-motion:\s*reduce[^{]*\{/g, m;
  while ((m = re.exec(css))) {
    var i = m.index + m[0].length, depth = 1, start = i;
    while (depth && i < css.length) { var c = css[i++]; if (c === '{') depth++; else if (c === '}') depth--; }
    var body = css.slice(start, i - 1), r = /([^{}]+)\{([^{}]*)\}/g, x;
    while ((x = r.exec(body))) {
      rmRules.push({ sels: x[1].split(',').map(function (s) { return s.replace(/\s+/g, ' ').trim(); }), decl: x[2] });
    }
  }
})();
function rulesFor(sel) { return rmRules.filter(function (r) { return r.sels.indexOf(sel) !== -1; }); }
function calmDuration(sel) {
  var best = 0;
  rulesFor(sel).forEach(function (r) {
    var d = /animation-duration:\s*([\d.]+)(m?s)\s*!important/.exec(r.decl);
    if (d) best = Math.max(best, parseFloat(d[1]) * (d[2] === 'ms' ? 1 : 1000));
  });
  return best;
}
function deleted(sel) {
  return rulesFor(sel).some(function (r) {
    return /animation(-name)?:\s*none/.test(r.decl) || /display:\s*none/.test(r.decl);
  });
}
[
  ['damage numbers', '.hp-dmg-float'],
  ['hit / kill numbers', '.dmg-float'],
  ['a card being placed', '.card.card-enter'],
  ['a card dying', '.card-death-ghost'],
  ['face damage', '.face-dmg-vignette'],
  ['the lane recap', '.lane-recap'],
  ['a card that landed and died', '.enter-die-stage .card.enter-die-card'],
  ['…and its exit', '.enter-die-stage .card.enter-die-card.enter-die-out'],
  ['the location name', '.env-reveal-stage.is-calm .env-reveal-name'],
].forEach(function (row) {
  var ms = calmDuration(row[1]);
  check(row[0] + ' keeps a calm fade that outlasts the catch-all (' + row[1] + ')', ms >= 200, ms + 'ms');
  check(row[0] + ' is not deleted under reduced motion', !deleted(row[1]));
});
var stageHide = rmRules.filter(function (r) { return /display:\s*none/.test(r.decl); })
  .reduce(function (a, r) { return a.concat(r.sels); }, []);
check('lane stages that carry information are not hidden',
  stageHide.indexOf('.lane-fx-stage') === -1 && stageHide.indexOf('.enter-die-stage') === -1,
  stageHide.filter(function (s) { return /lane-fx-stage|enter-die/.test(s); }).join(' | '));
check('decorative lane stages still are',
  stageHide.some(function (s) { return /^\.lane-fx-stage:not\(/.test(s); }));

// ---- The JS half: each effect is still BUILT under reduced motion.
UI._reducedMotion = function () { return true; };
var held = [], realST = setTimeout;
setTimeout = window.setTimeout = function (fn) { held.push(fn); return held.length; };
Game.init(); Game.seedMatch(7);
Game.state.lanes.forEach(function (l) { l.player = null; l.ai = null; });
UI.renderBoard(Game.state);
var realLaneAt = UI.laneElAt;
UI.laneElAt = function (i) {
  var el = realLaneAt.call(UI, i);
  if (el) el.getBoundingClientRect = function () { return { left: 100 * i, top: 50, width: 90, height: 400 }; };
  return el;
};
UI.fxFaceDamage('player');
check('face damage is still shown', !!document.querySelector('.face-dmg-vignette'));
UI._fxEnterAndDie({ lane: 2, name: 'Bane', owner: 'ai', cost: 4, atk: 4, hp: 6 });
check('a card that landed and died is still shown', !!document.querySelector('.enter-die-stage .card'));
UI.fxEnvReveal(1, 'Boiler Room', 'player');
check('the location name is still shown', !!document.querySelector('.env-reveal-stage.is-calm .env-reveal-name'));
UI.showLaneRecap({ laneIdx: 0, pHpBefore: 5, pHpAfter: 2, aHpBefore: 4, aHpAfter: 0, pAtkBefore: 4, aAtkBefore: 3, pDied: false, aDied: true });
check('the lane recap is still shown', !!document.querySelector('.lane-recap'));
setTimeout = window.setTimeout = realST;

print('reduced-motion-calm: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('reduced-motion-calm failed');
