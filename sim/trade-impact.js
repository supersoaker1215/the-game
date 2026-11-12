// ============================================================
// THE TRADE KEEPS ITS LUNGE, AND EVERY CARD GETS ITS ONE-SHOTS.
//
//   jsc sim/trade-impact.js
//
// Measured live (previous style.css vs this one, same board):
//   lunge + .hit-flash at impact      → hitFlash ONLY   → lunge AND hitFlash
//     (same Animation object before/after the flash lands: the lunge continues
//      from 167ms to 233ms; during the flash transform = the impact HOLD pose,
//      filter = the flash)
//   High, slasher: lunge/flash/landing → vibeSlasherMenace ×3 → their own
//   Normal, slasher: lunge/flash/landing → none ×3           → their own
//   High, titan: lunge/landing          → vibeTitanBreathe   → their own
// The sim can't paint, so this pins the cascade that produces it.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var CSS = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('')).replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
function bodyOf(sel) {
  var esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), re = new RegExp(esc + '\\s*\\{([^}]*)\\}', 'g'), m, last = null;
  while ((m = re.exec(CSS))) last = m[1];
  return last;
}
[['ally', 'combat-attacker', 'cardLungeAttackerAlly'], ['enemy', 'combat-attacker', 'cardLungeAttackerEnemy'],
 ['ally', 'combat-target', 'cardLungeTargetAlly'], ['enemy', 'combat-target', 'cardLungeTargetEnemy'],
 ['ally', 'combat-splash-hit', 'cardSplashHitAlly'], ['enemy', 'combat-splash-hit', 'cardSplashHitEnemy']].forEach(function (r) {
  var sel = '.card.' + r[0] + '-card.' + r[1] + '.hit-flash:not(.card-enter):not(.card-exit)';
  var b = bodyOf(sel);
  check(r[1] + ' (' + r[0] + ') + flash runs BOTH, lunge first and flash last',
    !!b && new RegExp('animation:\\s*' + r[2] + '[^,;]*,\\s*hitFlash').test(b), b && b.trim());
});
var Y = ':where(:not(.combat-attacker, .combat-target, .combat-splash-hit, .hit-flash, .card-knockback, .card-landing))';
// Every rule that puts a loop `animation` on .card.vibe-X must step aside for one-shots.
var re = /(^|\n)([^{}\n]*\.card\.vibe-[a-z]+[^{}\n]*)\{([^}]*)\}/g, m, leaks = [], seen = 0;
while ((m = re.exec(CSS))) {
  var sel = m[2], b = m[3];
  if (!/(^|;|\s)animation\s*:/.test(b)) continue;
  if (/^\s*:where\(body\.fx-lean:not\(\.low-fx\)\) \.card-slot|hand-card|low-fx|prefers-reduced/.test(sel)) continue;
  if (/^\s*animation\s*:\s*none\s*;?\s*$/.test(b.trim()) && !/!important/.test(b)) continue;
  seen++;
  if (sel.indexOf(Y) < 0) leaks.push(sel.trim().slice(0, 90));
}
check('every vibe loop on a card yields to one-shots (' + seen + ' rules)', seen >= 11 && leaks.length === 0, leaks.join(' | '));

print('trade-impact: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('trade-impact failed');
