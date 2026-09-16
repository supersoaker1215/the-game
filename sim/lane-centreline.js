// ============================================================
// LANE CENTRELINE AUDIT — static. Proves that what a lane is CARRYING cannot
// move where its cards and its divider sit.
//
// The lane is a flex column: two `.card-slot`s at `flex: 1 1 0` either side of
// a fixed-height `.lane-sep`. The slots split whatever is left. So ANY other
// in-flow child steals height from both of them and drags the centreline —
// divider, lane-number badge and both cards — up by half its own height, in
// that lane only.
//
// That is exactly what shipped: the status row (environment countdown,
// destroyed timer, trap warning, forced arrow, Hill crown) and the Reverse
// Bear Trap plate were appended straight onto the lane. Measured at the real
// board height: a plain lane's centreline at y=415, a lane with a countdown at
// y=404, a lane with a countdown AND a trap at y=392.5. Owner: "this should be
// even with the other lanes, it's a little too high."
//
// Two things have to hold, and only one of them is visible to a grep:
//   1. ui.js appends nothing to the lane except the four structural children
//      and the out-of-flow stacks.
//   2. the stack's `position: absolute` actually WINS. It did not, at first:
//      `.lane > * { position: relative; z-index: 1 }` sits later in style.css
//      at equal specificity, so a bare `.lane-chips` rule lost silently and
//      the fix measured as no fix at all. So this resolves the cascade —
//      !important, then specificity, then order — rather than grepping.
//
//   jsc sim/lane-centreline.js -- [--verbose]
// ============================================================

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

var CSS = read('style.css').replace(/\/\*[\s\S]*?\*\//g, function (c) {
  return c.replace(/[^\n]/g, ' ');           // keep line numbers true
});
var UIJS = read('ui.js');

var findings = [];
function finding(msg) { findings.push(msg); }
function ok(msg) { if (VERBOSE) print('  ok  ' + msg); }

// ---- specificity (enough of the real algorithm for these selectors) --------
function specificity(sel) {
  var a = 0, b = 0, c = 0;
  var s = sel.replace(/::[\w-]+/g, '');
  s = s.replace(/:(?:not|is|has|where)\(([^()]*)\)/g, function (m, inner) {
    if (/^:where/.test(m)) return ' ';
    var best = [0, 0, 0];
    inner.split(',').forEach(function (part) {
      var sp = specificity(part);
      if (sp[0] > best[0] || (sp[0] === best[0] && (sp[1] > best[1] ||
          (sp[1] === best[1] && sp[2] > best[2])))) best = sp;
    });
    a += best[0]; b += best[1]; c += best[2];
    return ' ';
  });
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
  return x.order > y.order;                  // equal specificity: later wins
}
function lineOf(idx) { return CSS.slice(0, idx).split('\n').length; }

function declarations(prop) {
  var out = [], re = /([^{}]+)\{([^{}]*)\}/g, m, n = 0;
  while ((m = re.exec(CSS))) {
    var body = m[2];
    var d = new RegExp('(?:^|[;{\\s])' + prop + '\\s*:').exec(body);
    if (!d) continue;
    var rest = body.slice(d.index + d[0].length);
    var semi = rest.indexOf(';');
    var value = (semi >= 0 ? rest.slice(0, semi) : rest).replace(/\s+/g, ' ').trim();
    var important = /!important/.test(value);
    m[1].split(',').forEach(function (sel) {
      sel = sel.replace(/\s+/g, ' ').trim();
      if (!sel || sel.charAt(0) === '@' || /%$/.test(sel) || sel === 'from' || sel === 'to') return;
      out.push({ sel: sel, value: value.replace(/\s*!important\s*/, ''), important: important,
                 spec: specificity(sel), order: n++, line: lineOf(m.index) });
    });
  }
  return out;
}

// Does `sel` reach an element described by {classes, ancestors}? `*` matches
// anything — which is the whole reason this audit exists, since `.lane > *` is
// the rule that quietly won.
function compoundOk(compound, classes) {
  if (compound === '*') return true;
  if (/^[a-zA-Z]/.test(compound)) return false;
  var stripped = compound.replace(/:(?:not|is|has|where)\([^()]*\)/g, ' ');
  if (/:[\w-]/.test(stripped)) return false;               // unmodelled pseudo-class
  var names = (stripped.match(/\.[\w-]+/g) || []).map(function (s) { return s.slice(1); });
  return names.length > 0 && names.every(function (n) { return classes.indexOf(n) >= 0; });
}
// COMBINATORS ARE HONOURED, and they have to be: the first version of this
// audit collapsed `>` into a descendant match and reported `#game-area > *` as
// the winner — an ID selector that cannot reach a .lane-chips two levels down.
// It "found" the bug that had just been fixed, which is worse than finding
// nothing. `el` describes the element as {classes, parent, ancestors}.
function reaches(sel, el) {
  if (/::/.test(sel)) return false;
  if (/:hover|:active|:focus|:checked|:disabled/.test(sel)) return false;
  if (/[+~]/.test(sel)) return false;                      // siblings: not modelled
  var toks = sel.trim().split(/\s+/);
  // Re-split so `a>b` and `a > b` tokenize the same.
  var flat = [];
  toks.forEach(function (t) {
    t.split(/(>)/).forEach(function (p) { if (p) flat.push(p); });
  });
  var last = flat.pop();
  if (last === '>') return false;
  if (!compoundOk(last, el.classes)) return false;
  // Walk right-to-left. A '>' before a compound means that compound must match
  // the PARENT; otherwise it may match any ancestor.
  var childCombinator = false;
  for (var i = flat.length - 1; i >= 0; i--) {
    var t = flat[i];
    if (t === '>') { childCombinator = true; continue; }
    var pool = childCombinator ? [el.parent] : el.ancestors;
    if (t !== '*') {
      if (/^[a-zA-Z]/.test(t)) return false;               // element ancestors: not modelled
      if (/^#/.test(t)) {
        var id = t.replace(/^#/, '').split(/[.:\[]/)[0];
        if (pool.indexOf(id) < 0) return false;
      } else {
        var names = (t.match(/\.[\w-]+/g) || []).map(function (s) { return s.slice(1); });
        if (!names.every(function (n) { return pool.indexOf(n) >= 0; })) return false;
      }
    }
    childCombinator = false;
  }
  return true;
}
function winner(prop, el) {
  var best = null;
  declarations(prop).forEach(function (d) {
    if (!reaches(d.sel, el)) return;
    if (!best || beats(d, best)) best = d;
  });
  return best;
}

// ---- 1. the chip stack must resolve to out-of-flow -------------------------
var CHIPS = { classes: ['lane-chips'], parent: 'lane',
              ancestors: ['lane', 'board', 'board-section', 'game-area'] };
var pos = winner('position', CHIPS);
if (!pos) {
  finding('.lane-chips has no reachable `position` at all — it would be static and back in flow');
} else if (pos.value !== 'absolute' && pos.value !== 'fixed') {
  finding('.lane-chips resolves to position:' + pos.value + ' via `' + pos.sel +
          '` (style.css:' + pos.line + ') — it is IN FLOW and moves the centreline');
} else {
  ok('.lane-chips wins position:' + pos.value + ' via `' + pos.sel + '`');
}
// It has to clear the player card it now overlaps, too.
var z = winner('z-index', CHIPS);
if (!z || !(parseInt(z.value, 10) >= 2)) {
  finding('.lane-chips z-index resolves to ' + (z ? z.value + ' via `' + z.sel + '`' : 'nothing') +
          ' — the pips would be painted under the card slots they sit over');
} else {
  ok('.lane-chips wins z-index:' + z.value + ' via `' + z.sel + '`');
}

// ---- 2. nothing else gets appended to the lane ----------------------------
// Everything appended directly to the lane element inside renderBoard's lane
// loop, by the variable it appends. Structural children and the FX wave are
// allowed; anything new has to be justified here rather than silently costing
// 11px of lane.
var ALLOWED = { chips: 1, aiSlot: 1, sep: 1, pSlot: 1, playerSlot: 1, wave: 1, envBg: 1 };
// SCOPED to renderBoard's lane loop. `el` is a common local name across ui.js,
// and an unscoped scan reported four unrelated appends in other functions as
// lane children — noise that would have trained the next reader to ignore this
// audit. The loop runs from the selective-clear to the point the lane is
// attached to the board.
var loopStart = UIJS.indexOf("const KEEP = el.querySelector(':scope > .ai-slot')");
var loopEnd   = UIJS.indexOf('if (el.parentNode !== this.board) this.board.appendChild(el)');
if (loopStart < 0 || loopEnd < 0 || loopEnd <= loopStart) {
  finding('could not locate renderBoard\'s lane loop in ui.js — this audit has gone stale and is not checking anything');
}
var seg = (loopStart >= 0 && loopEnd > loopStart) ? UIJS.slice(loopStart, loopEnd) : '';
var appendRe = /\bel\.appendChild\((\w+)\)/g, am;
var seen = {};
while ((am = appendRe.exec(seg))) seen[am[1]] = (seen[am[1]] || 0) + 1;
Object.keys(seen).forEach(function (name) {
  if (!ALLOWED[name]) {
    finding('ui.js appends `' + name + '` straight onto the lane element — if it is in flow it ' +
            'steals height from both card slots and shifts that lane\'s centreline. Put it in ' +
            '.lane-chips, or make it absolute on a selector that clears `.lane > *`.');
  } else {
    ok('lane append `' + name + '` is accounted for');
  }
});
// And the two chips must actually be routed into the stack, not onto the lane.
['lane-status-row', 'lane-trap '].forEach(function (cls) {
  if (UIJS.indexOf("className = '" + cls) < 0 && UIJS.indexOf("className = '" + cls.trim() + "'") < 0) {
    finding('could not find where `' + cls.trim() + '` is built in ui.js — this audit has gone stale');
  } else { ok(cls.trim() + ' is still built in ui.js'); }
});
if (!/_chip\(row\)/.test(UIJS)) finding('the status row no longer goes through _chip() — check it is still in the stack');
if (!/_chip\(trapEl\)/.test(UIJS)) finding('the trap plate no longer goes through _chip() — check it is still in the stack');

// ---- 3. the selective clear still keeps exactly the structural four -------
// If a fifth child ever joins the KEEP list it survives renders, and if it is
// in flow it shifts the centreline permanently rather than for one frame.
['> .ai-slot', '> .lane-sep', '> .player-slot', '> .lane-env-bg'].forEach(function (q) {
  if (seg.indexOf("querySelector(':scope " + q + "')") < 0) {
    finding('renderBoard no longer keeps `' + q.replace('> ', '') + '` across renders — ' +
            'the lane\'s structural children changed, re-check what splits the lane height');
  } else { ok('sweep keeps ' + q.replace('> ', '')); }
});

// ---- verdict --------------------------------------------------------------
print('AUDIT lane-centreline: ' + findings.length + ' findings');
findings.forEach(function (f) { print('  - ' + f); });
