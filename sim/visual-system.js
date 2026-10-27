// ============================================================
// VISUAL SYSTEM AUDIT — static. Two things that read as "unfinished" and
// that a grep cannot see, because both are about what is ABSENT.
//
// 1. FORM CONTROLS AND THE UA FONT.
//    A <button> or <input> does not inherit font-family. This sheet styles
//    fonts per CLASS (button.btn, .mp-code-input, .settings-row select, ...),
//    so any control no class claimed fell through to Arial on a page whose
//    type system is Inter / Rajdhani / JetBrains Mono. Measured on a live
//    match before the fix: 20 of 133 controls — the music toggle and its
//    glyph, the redraw counter, emote and taunt, the log close and drawer
//    handles, the cheat-sheet close, three bare inputs. A per-class sheet
//    cannot be audited by listing classes; the only durable guard is that a
//    universal rule exists at all.
//
// 2. ELEVATION AS A RAMP.
//    Depth here lives in `filter: drop-shadow`, NOT box-shadow — .card carries
//    a clip-path for its chamfer, and a box-shadow on a clipped element is
//    clipped away. (Measuring box-shadow is how I first, wrongly, concluded
//    the game had no cast shadows at all: the elevation was the THIRD entry in
//    a filter stack. Audit the right property.)
//    The shadow existed but was the constant `0 2px 6px` — a resting board
//    card, a resting hand card and a HOVERED card were all at the same height,
//    because hover moved only --tube-r1/r2/a1/a2. Nothing in a match ever
//    lifted. It now rides --tube-ey/-eb/-ea so any state that tunes the tube
//    can tune its height, and this fails if it is ever flattened back.
//
//   jsc sim/visual-system.js -- [--verbose]
// ============================================================

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

var CSS = read('style.css');
// Comments quote CSS in their own commentary — strip first, keep newlines.
var BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, function (c) {
  return c.replace(/[^\n]/g, ' ');
});

var pass = 0, fails = [];
function ok(n) { pass++; if (VERBOSE) print('  ok  ' + n); }
function bad(n, d) { fails.push(n + (d ? ' — ' + d : '')); }
function check(n, cond, d) { if (cond) ok(n); else bad(n, d); }

// ---- 1. a universal font rule reaches every form control -------------------
// Bare element selectors only: a class-qualified rule is what we already have
// 15 of and is exactly what does NOT solve this.
var universal = null;
var re = /(?:^|\n)([^{}@][^{}]*?)\{([^{}]*)\}/g, m;
while ((m = re.exec(BARE))) {
  var decl = m[2];
  if (!/font-family\s*:/.test(decl)) continue;
  var sels = m[1].split(',').map(function (s) { return s.replace(/\s+/g, ' ').trim(); });
  var bare = sels.filter(function (s) { return /^(button|input|select|textarea)$/.test(s); });
  if (bare.length) {
    var need = ['button', 'input', 'select', 'textarea'];
    var covered = need.filter(function (n) { return bare.indexOf(n) >= 0; });
    if (!universal || covered.length > universal.covered.length) {
      universal = { covered: covered, sels: sels,
                    line: BARE.slice(0, m.index).split('\n').length + 1,
                    value: (/font-family\s*:([^;]*)/.exec(decl) || [])[1] };
    }
  }
}
check('a bare-element font-family rule exists for form controls',
      !!universal,
      'none found — every control not claimed by a class rule falls back to the UA font');
if (universal) {
  check('that rule covers button, input, select AND textarea',
        universal.covered.length === 4,
        'covers only: ' + universal.covered.join(', '));
  if (VERBOSE) print('  universal rule at L' + universal.line + ': font-family:' + universal.value);
}

// ---- 2. elevation is a ramp, not a constant --------------------------------
var tube = /--card-tube\s*:([\s\S]*?);\s*\n/.exec(BARE);
// Take the LAST definition — that is the one that wins, and the whole point of
// card-tube.js is that an earlier one looks right and does not paint.
var all = [], tre = /--card-tube\s*:([\s\S]*?);/g, tm;
while ((tm = tre.exec(BARE))) all.push({ body: tm[1], line: BARE.slice(0, tm.index).split('\n').length + 1 });
check('--card-tube is defined', all.length > 0, 'no definition found');
var winner = all.length ? all[all.length - 1] : null;

if (winner) {
  if (VERBOSE) print('  winning --card-tube at L' + winner.line);
  // the elevation entry: a drop-shadow whose Y offset is non-zero
  var elevVar = /drop-shadow\(\s*0\s+var\(\s*--tube-ey/.test(winner.body);
  var elevConst = /drop-shadow\(\s*0\s+(\d*\.?\d+)px\s+\d/.exec(winner.body);
  check('the elevation shadow is driven by a variable, not a constant',
        elevVar,
        elevConst ? ('L' + winner.line + ' hardcodes y=' + elevConst[1] +
                     'px, so hover/rest/hand can never differ in height')
                  : ('L' + winner.line + ' has no elevation drop-shadow at all'));
}

// at least one state must actually MOVE it, or a ramp with one rung is a constant
var movers = [];
var mre = /([^{}]+)\{([^{}]*--tube-ey\s*:[^;]*;[^{}]*)\}/g, mm;
while ((mm = mre.exec(BARE))) {
  var s2 = mm[1].replace(/\s+/g, ' ').trim();
  if (/--card-tube/.test(mm[2])) continue;          // the definition itself
  movers.push({ sel: s2.slice(0, 70), line: BARE.slice(0, mm.index).split('\n').length + 1 });
}
check('at least two states redefine --tube-ey (a ramp needs rungs)',
      movers.length >= 2,
      movers.length + ' found: ' + movers.map(function (x) { return 'L' + x.line + ' ' + x.sel; }).join(' | '));
if (VERBOSE) movers.forEach(function (x) { print('  rung: L' + x.line + ' ' + x.sel); });

var hoverLifts = movers.some(function (x) { return /:hover/.test(x.sel); });
check('hover is one of them (the card lifts when singled out)', hoverLifts,
      'no :hover rule sets --tube-ey');

print('');
print('visual-system: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('visual-system failed');
