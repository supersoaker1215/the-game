// ============================================================
// LANE/SLOT FIT AUDIT — static. Proves a board card sits CENTRED in its lane.
//
// THE BUG THIS REPLACES. The lane and the card slot were sized by two
// independently authored constants for the same gap:
//
//   body.in-match .lane      width: calc(var(--board-card-w) + var(--lane-chrome))
//   body.in-match .card-slot width: calc(var(--board-card-w) + 14px)      <- hardcoded
//
// --lane-chrome is 20px by default and is shaved to 8px under
// `@media (max-width: 700px)` so eight lanes fit a phone. The slot's 14 does
// not move with it, so below 700px the slot is WIDER than the lane that holds
// it. The lane lays its slots out at flex-start, so the overflow all goes to
// one side and every card on the board drifts RIGHT of its own lane number.
// Owner: "the cards are on the right side for some reason instead of the
// middle."
//
// Measured on the live build before the fix:
//   1280px  lane 124  slot 118  card centre +1px right of lane centre
//    375px  lane  61  slot  65  card centre +4px right, slot overhanging 6px
// (Desktop was wrong too — the 14 never accounted for the lane's 1px borders.)
//
// The fix is to stop authoring the third constant: the slot is `width: 100%`,
// so it fills the lane's content box at every breakpoint by construction. The
// phone block at `@container (max-width: 520px)` ALREADY said exactly that and
// was silently overridden, because `body.in-match .card-slot` is a 0,2,1 and
// `.card-slot` is a 0,1,0 — the same cascade trap card-tube.js exists for.
//
// So this asserts the invariant, not the fix: no rule reaching .card-slot may
// size it by a fixed pixel offset from --board-card-w, because any such
// constant is a promise about --lane-chrome that the stylesheet cannot keep.
//
//   jsc sim/lane-slot-fit.js -- [--verbose]
// ============================================================

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

var CSS = read('style.css');
// Comments can contain anything that looks like a rule — this file quotes CSS
// in its own commentary — so they go first. Newlines kept so lines stay true.
var BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, function (c) {
  return c.replace(/[^\n]/g, ' ');
});

var pass = 0, fails = [];
function ok(n) { pass++; if (VERBOSE) print('  ok  ' + n); }
function bad(n, d) { fails.push(n + (d ? ' — ' + d : '')); }
function check(n, cond, d) { if (cond) ok(n); else bad(n, d); }
function lineOf(idx) { return BARE.slice(0, idx).split('\n').length; }

function specificity(sel) {
  var a = 0, b = 0, c = 0;
  var s = sel.replace(/::[\w-]+/g, '');
  a += (s.match(/#[\w-]+/g) || []).length;
  b += (s.match(/\.[\w-]+/g) || []).length;
  b += (s.match(/\[[^\]]*\]/g) || []).length;
  b += (s.match(/:[\w-]+(?:\([^()]*\))?/g) || []).length;
  c += (s.replace(/[#.:][\w-]+(?:\([^()]*\))?/g, ' ').replace(/\[[^\]]*\]/g, ' ')
        .match(/\b[a-zA-Z][\w-]*\b/g) || []).length;
  return [a, b, c];
}
function beats(x, y) {
  if (x.important !== y.important) return x.important;
  for (var i = 0; i < 3; i++) if (x.spec[i] !== y.spec[i]) return x.spec[i] > y.spec[i];
  return x.order > y.order;
}

// Every `width` declaration whose subject is .card-slot. Ancestors are not
// modelled beyond "they are satisfiable on a real board" — body.in-match,
// .board and .lane all are, which is exactly how the losing rule wins.
function slotWidthDecls() {
  var out = [], re = /([^{}]+)\{([^{}]*)\}/g, m, n = 0;
  while ((m = re.exec(BARE))) {
    var body = m[2];
    var d = /(?:^|[;{\s])width\s*:/.exec(body);
    if (!d) continue;
    var value = body.slice(d.index + d[0].length).split(';')[0].replace(/\s+/g, ' ').trim();
    var important = /!important/.test(value);
    var line = lineOf(m.index);
    m[1].split(',').forEach(function (sel) {
      sel = sel.replace(/\s+/g, ' ').trim();
      if (!sel || sel.charAt(0) === '@' || /%$/.test(sel)) return;
      var parts = sel.split(/\s+/);
      var subject = parts[parts.length - 1];
      if (!/\.card-slot(\.|:|$)/.test(subject)) return;
      if (/::/.test(sel) || /:hover|:active|:focus/.test(sel)) return;
      out.push({ sel: sel, value: value, important: important,
                 spec: specificity(sel), order: n++, line: line });
    });
  }
  return out;
}

var decls = slotWidthDecls();
check('stylesheet declares a width for .card-slot', decls.length > 0,
      'found none — selector model is wrong, not the CSS');

// ---- 1. the winner must not be an independent pixel offset -----------------
var winner = null;
decls.forEach(function (d) { if (!winner || beats(d, winner)) winner = d; });
if (VERBOSE && winner) print('  winning .card-slot width: ' + winner.value +
                             '  (' + winner.sel + ', L' + winner.line + ')');

var OFFSET = /calc\(\s*var\(\s*--board-card-w[^)]*\)\s*\+\s*(\d+(?:\.\d+)?)px/;
var mw = winner && OFFSET.exec(winner.value);
check('the winning .card-slot width is not a hardcoded offset from --board-card-w',
      !mw,
      winner ? ('L' + winner.line + ' `' + winner.sel + '` sizes the slot as card + ' +
                (mw ? mw[1] : '?') + 'px, an independent constant the lane does not share')
             : 'no winner resolved');

// ---- 2. no reachable rule may promise more than the tightest lane ----------
// The lane is card + --lane-chrome, less its own padding and borders. Any slot
// offset above the SMALLEST --lane-chrome overflows on the screens that use it.
var chromes = [];
var cre = /--lane-chrome\s*:\s*(\d+(?:\.\d+)?)px/g, cm;
while ((cm = cre.exec(BARE))) chromes.push(parseFloat(cm[1]));
check('--lane-chrome is declared at more than one value (it is a breakpoint knob)',
      chromes.length >= 2, 'found: ' + chromes.join(', '));
var tightest = chromes.length ? Math.min.apply(null, chromes) : 20;

var offenders = [];
decls.forEach(function (d) {
  var m2 = OFFSET.exec(d.value);
  if (m2 && parseFloat(m2[1]) > tightest) {
    offenders.push('L' + d.line + ' `' + d.sel + '` = card + ' + m2[1] +
                   'px, but the tightest lane is card + ' + tightest + 'px');
  }
});
check('no .card-slot width offset exceeds the tightest --lane-chrome',
      offenders.length === 0, offenders.join(' | '));

// ---- 3. the lane keeps deriving from the shared variable -------------------
var laneDerived = /body\.in-match\s+\.lane\s*\{[^}]*width\s*:\s*calc\(\s*var\(\s*--board-card-w[^}]*var\(\s*--lane-chrome/.test(BARE);
check('the lane still derives its width from --board-card-w + --lane-chrome',
      laneDerived, 'lane width rule changed shape — this audit assumes it');

print('');
print('lane-slot-fit: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('lane-slot-fit failed');
