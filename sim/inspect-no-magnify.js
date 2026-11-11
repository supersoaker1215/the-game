// ============================================================
// THE INSPECT CARD NEVER GROWS ON HOVER.
//
//   jsc sim/inspect-no-magnify.js
//
// Owner: "if i tap on a card then hover it magnifies it shouldnt magnify its
// already big". Measured live (inspect view of a hand card, real hover):
// Normal / High 442px; Reduced 442 → 618px, matrix(1.4,…) — the board's
// `body.low-fx .card.ally-card:hover` (0,4,1) !important out-ranked the
// modal's kill rule (0,4,0). After: 442px at all three tiers; board cards
// still match their 1.4× grow.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var CSS = read('style.css').replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
var re = /(^|\n)([^{}\n]*\.card\.(ally|enemy)-card[^{}\n]*):hover\s*\{([^}]*)\}/g, m, grow = 0, leaks = [];
while ((m = re.exec(CSS))) {
  if (!/scale\(\s*1\.[1-9]/.test(m[4])) continue;
  if (/inspect-card/.test(m[2]) && !/:where\(:not\(\.inspect-card\)\)/.test(m[2])) continue;   // the modal's own rules
  grow++;
  if (m[2].indexOf(':where(:not(.inspect-card))') < 0) leaks.push(m[2].trim());
}
// The low-fx rule is a 2-selector list on two lines; count it separately.
var low = /body\.low-fx \.card\.ally-card:where\(:not\(\.inspect-card\)\):hover,\s*body\.low-fx \.card\.enemy-card:where\(:not\(\.inspect-card\)\):hover \{\s*transform:\s*scale\(1\.4\)/.test(CSS);
check('board grow rules skip the inspect card (' + grow + ' single-selector rules)', grow >= 2 && leaks.length === 0, leaks.join(' | '));
check('…including the Reduced tier, the one that leaked', low);
check('…with zero added specificity (no plain :not)', !/\.card\.(ally|enemy)-card:not\(\.inspect-card\):hover/.test(CSS));
print('inspect-no-magnify: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('inspect-no-magnify failed');
