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
var CSS = read('style.css').replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
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

print('idle-loops: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('idle-loops failed');
