// ============================================================
// DRAFT TRICKS NEVER MAGNIFY ON HOVER.
//
//   jsc sim/draft-trick-hover.js
//
// Owner: "in the draft the tricks magnify on hover that shouldnt happen".
// Measured live at the Reduced tier: a hovered draft trick went 343 → 515px
// (matrix(1.5,…)) — `body.low-fx .trick-card:hover` (0,3,1) !important beat
// the draft's own lift (0,3,0). After: 343px with the 8px lift at Reduced,
// Normal and High. The in-match chips (132px) keep their 1.5× read.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var CSS = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('')).replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
// Every rule that scales a trick up on hover must skip draft tricks.
var re = /(^|\n)([^{}\n]*\.trick-card[^{}\n]*):hover\s*\{([^}]*)\}/g, m, magnify = 0, leaks = [];
while ((m = re.exec(CSS))) {
  if (!/scale\(\s*1\.[1-9]/.test(m[3])) continue;
  magnify++;
  if (m[2].indexOf(':where(:not(.trick-draft))') < 0 && m[2].indexOf('trick-draft') < 0) leaks.push(m[2].trim());
}
check('every trick magnify rule skips draft tricks (' + magnify + ' rules)', magnify >= 4 && leaks.length === 0, leaks.join(' | '));
check('…without adding specificity (hand-trick hover unchanged)', !/\.trick-card:not\(\.trick-draft\):hover/.test(CSS));
check('Reduced keeps the draft\'s plain lift', /body\.low-fx \.draft-card\.trick-draft:hover \{\s*transform:\s*translateY\(-8px\) !important;/.test(CSS));
print('draft-trick-hover: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('draft-trick-hover failed');
