// ============================================================
// IDLE LOOPS THAT REPAINT STAY PAUSED (Normal tier + invisible cases)
//
//   jsc sim/idle-loops.js
//
// Owner: "do 2" — cut in-match power. Measured on a fresh page, 10-card board,
// default tier: idle frame 2.4-2.5ms → 1.6-1.8ms main thread; infinite loops
// running 29 → 7, repainting loops 22 → 0 (card edge tube ×15, lane-number
// pulse ×6 — invisible in occupied lanes — and the AI ring, hidden all turn).
// Layout/paint cannot run here, so this pins the cascade that produces it.
// NOTE for live testing: calling .pause()/.play() on a CSSAnimation from
// script makes it ignore animation-play-state for good — measure on a fresh
// page, toggling the RULES, never the Animation objects.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var CSS = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('')).replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
function ruleAt(sel) {
  var re = new RegExp('(^|\\n)\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g'), m, last = null;
  while ((m = re.exec(CSS))) last = { at: m.index, body: m[2] };
  return last;
}
var cases = [
  { sel: ':where(body.fx-lean) .tron-perimeter-card::after', base: '.tron-perimeter-card::after', why: 'card edge tube held at Normal' },
  { sel: ':where(.lane.occ-ai, .lane.occ-player, .lane.occ-both) .lane-number', base: '.lane-number', why: 'lane pulse paused where it is invisible' },
  { sel: ':where(body.fx-lean) .lane-number', base: '.lane-number', why: 'empty-lane pulse held at Normal' },
  { sel: 'body:not(.ai-thinking) .ai-thinking-ring circle', base: '.ai-thinking-ring circle', why: 'AI ring paused while hidden' },
];
cases.forEach(function (c) {
  var r = ruleAt(c.sel), b = ruleAt(c.base);
  check(c.why + ': rule exists', !!r);
  if (!r) return;
  check(c.why + ': it PAUSES (keeps the loop\'s precedence) rather than replacing it',
    /animation-play-state:\s*paused/.test(r.body) && !/(^|;|\s)animation\s*:/.test(r.body), r.body.trim());
  // :where() rules tie with their base on specificity, so they must come later.
  if (c.sel.indexOf(':where(') === 0) {
    var firstBase = CSS.search(new RegExp('(^|\\n)\\s*' + c.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{'));
    check(c.why + ': sits after the base rule it ties with', firstBase >= 0 && r.at > firstBase);
  }
});
// The High tier keeps the loops: nothing here may pause them without fx-lean.
var tube = ruleAt(':where(body.fx-lean) .tron-perimeter-card::after');
check('High keeps the card tube (only fx-lean pauses it)', !!tube && !ruleAt('.tron-perimeter-card::after:where(*)'));

// ---- PANEL + HUD TUBES (screens other than the board) ---------------------
// Measured, deck builder idle: 9.1-9.5ms/frame with no pauses (117 loops),
// 2.2 with only the card tube paused, 0.3 with panels too. Held at the quarter
// cycle of EACH tier (panel border 0.576 = midway 0.30-0.85, card 0.376).
var base = ruleAt(':where(body.fx-lean) .tron-perimeter::after');
check('panel/HUD tube held at Normal', !!base && /animation-play-state:\s*paused/.test(base.body) && /--tron-perim-hud-cycle/.test(base.body));
var slow = ruleAt(':where(body.fx-lean) .tron-perimeter-slow::after');
check('panel tier holds at ITS quarter (8s cycle, not the 6s HUD one)', !!slow && /--tron-perim-panel-cycle\)\s*\*\s*-0\.25/.test(slow.body));
check('the tier delays come after the base tube rule they tie with',
  !!base && !!slow && slow.at > base.at && base.at > CSS.search(/\n\.tron-perimeter::after\s*\{/));

// ---- VIBES RIDE THE SLOT -------------------------------------------------
// Measured, same page, same loops running: idle frame 1.4-1.5ms (loops on the
// card) → 0.2-0.3ms (loops on the slot); 12 cards: 2.7-3.2ms → 0.2ms. And with
// the loop off the card, its one-shots play: combat-attacker/target, hit-flash,
// card-knockback, card-landing all resolved to the vibe before, their own now.
var LOOPS = { titan: 'vibeTitanBreatheLean', phase: 'vibePhaseShimmerLean', symbiote: 'vibeSymbioteOoze',
              cosmic: 'vibeCosmicDrift', speed: 'vibeSpeedJitter', alien: 'vibeAlienTwitch' };
Object.keys(LOOPS).forEach(function (v) {
  var slotSel = ':where(body.fx-lean:not(.low-fx)) .card-slot:where(:has(> .card.vibe-' + v + ':not(.card-enter):not(.card-exit)))';
  var slot = ruleAt(slotSel);
  check(v + ': the loop runs on the SLOT at Normal', !!slot && slot.body.indexOf(LOOPS[v]) >= 0, slot && slot.body.trim());
  // Every rule that puts an `animation` on a .card.vibe-X must be kept off slot-hosted cards at Normal.
  var re = new RegExp('(^|\\n)([^{}\\n]*\\.card\\.vibe-' + v + '[^{}\\n]*)\\{([^}]*)\\}', 'g'), m, leaks = [];
  while ((m = re.exec(CSS))) {
    var sel = m[2], body2 = m[3];
    if (!/(^|;|\s)animation\s*:/.test(body2) || /animation\s*:\s*none/.test(body2)) continue;
    if (/\.card-slot|hand-card|low-fx|prefers-reduced/.test(sel)) continue;
    if (/:not\(:where\((body\.fx-lean )?\.card-slot > \*\)\)/.test(sel)) continue;
    leaks.push(sel.trim());
  }
  check(v + ': no card-level loop left on a slot-hosted card', leaks.length === 0, leaks.join(' | '));
});
var crazy = ruleAt(':where(body.fx-lean:not(.low-fx)) .card-slot:where(:has(> .card.status-crazy:not(.card-enter):not(.card-exit)))');
check('crazy wobble rides the slot', !!crazy && /cardCrazyWobble/.test(crazy.body));
check('the crazy restore no longer targets slot-hosted cards',
  /body\.fx-lean:not\(\.low-fx\) \.card\.status-crazy:not\(:where\(\.card-slot > \*\)\)(:where\(:not\([^)]*\)\))?\s*\{/.test(CSS));
check('the slot keeps each card\'s desync phase', /:where\(body\.fx-lean:not\(\.low-fx\)\) \.card-slot:where\(:has\(> \.card:is\([^)]*\)\)\)\s*\{\s*animation-delay:\s*var\(--vibe-delay/.test(CSS));
var UIJS = (read('ui-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('\n'));
check('ui.js copies --vibe-delay from the card onto its slot (only when it changed)',
  /host\.classList\.contains\('card-slot'\)[\s\S]{0,200}getPropertyValue\('--vibe-delay'\)[\s\S]{0,120}!== vd/.test(UIJS));

print('idle-loops: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('idle-loops failed');
