// ============================================================
// CARD-TUBE AUDIT — static. Proves the card frame's neon stack is actually
// REACHABLE, not just present.
//
// This bug class has now cost three separate passes, always the same shape: a
// glow is authored on the card frame, it looks right in the file, and nothing
// changes on screen because a different rule wins.
//
//   .cf-frame  filter ......... zeroed outright by `.card .cf-frame{filter:none}`
//   .card      var(--card-tube) loses to `.card.card` — a 0,2,0 selector 500
//              lines earlier — so the stack wired to --neon-boost never painted
//              and the knob genuinely did nothing
//   .cf-edge::after ........... `display:none`, and before that it was parked
//              inside the hole its own parent's clip-path punches
//
// `filter` is the trap in every case: it is ONE property, so a second
// declaration REPLACES the stack rather than merging with it. A grep for
// "--card-tube" says the tube is there; only resolving the cascade says it
// paints. So this resolves it — !important, then specificity, then order — and
// asserts the rule that actually wins.
//
//   jsc sim/card-tube.js -- [--verbose]
// ============================================================

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

var CSS = read('style.css');
// Comments can contain anything that looks like a rule — this file is full of
// quoted CSS in its own commentary — so they go first. Newlines are kept so
// reported line numbers stay true.
var BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, function (c) {
  return c.replace(/[^\n]/g, ' ');
});

var pass = 0, fails = [];
function ok(name) { pass++; if (VERBOSE) print('  ok  ' + name); }
function bad(name, detail) { fails.push(name + (detail ? ' — ' + detail : '')); }
function check(name, cond, detail) { if (cond) ok(name); else bad(name, detail); }

function lineOf(idx) { return BARE.slice(0, idx).split('\n').length; }

// ---- specificity ------------------------------------------------------------
// Enough of the real algorithm for the selectors this file uses: ids, then
// classes/attributes/pseudo-classes, then elements. :not()/:has()/:is() take
// the specificity of their most specific argument, which is what makes
// `.card:not(.face-down):active` a 0,3,0 and not a 0,2,0.
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
function beats(x, y) {              // does declaration x win over y?
  if (x.important !== y.important) return x.important;
  for (var i = 0; i < 3; i++) {
    if (x.spec[i] !== y.spec[i]) return x.spec[i] > y.spec[i];
  }
  return x.order > y.order;         // equal specificity: later wins
}

// ---- every declaration of `prop`, split per selector in the group ----------
function declarations(prop) {
  var out = [], re = /([^{}]+)\{([^{}]*)\}/g, m, n = 0;
  while ((m = re.exec(BARE))) {
    var body = m[2];
    var d = new RegExp('(?:^|[;{\\s])' + prop + '\\s*:([^;]*)').exec(body);
    if (!d) continue;
    var value = d[1].replace(/\s+/g, ' ').trim();
    var important = /!important/.test(value);
    m[1].split(',').forEach(function (sel) {
      sel = sel.replace(/\s+/g, ' ').trim();
      if (!sel || sel.charAt(0) === '@' || /%$/.test(sel) || sel === 'from' || sel === 'to') return;
      out.push({ sel: sel, value: value, important: important,
                 spec: specificity(sel), order: n++, line: lineOf(m.index) });
    });
  }
  return out;
}

// Which declarations can reach a given element? Modelled, not evaluated: the
// element is described by the classes it carries and the ancestors it has, and
// a selector reaches it only if every compound in the selector is satisfied.
function reaches(sel, el) {
  if (/::/.test(sel)) return false;                       // pseudo-elements are not the card
  if (/:hover|:active|:focus|:checked|:disabled/.test(sel)) return false;  // resting state only
  var parts = sel.split(/\s*[>\s]\s*/).filter(function (p) { return p && p !== '>' && p !== '+' && p !== '~'; });
  var last = parts.pop();
  if (!compoundOk(last, el.classes)) return false;
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i].split(/[.:#\[]/).filter(Boolean).every(function () { return true; })) return false;
    var names = (parts[i].match(/\.[\w-]+/g) || []).map(function (s) { return s.slice(1); });
    if (!names.every(function (n) { return el.ancestors.indexOf(n) >= 0; })) return false;
    if (/^[a-zA-Z]/.test(parts[i])) return false;         // element ancestors: not modelled
  }
  return true;
}
function compoundOk(compound, classes) {
  if (/^[a-zA-Z]/.test(compound)) return false;
  var notOk = true;
  compound.replace(/:not\(([^()]*)\)/g, function (m, inner) {
    inner.split(',').forEach(function (p) {
      var n = (p.match(/\.[\w-]+/g) || []).map(function (s) { return s.slice(1); });
      if (n.length && n.every(function (x) { return classes.indexOf(x) >= 0; })) notOk = false;
    });
    return ' ';
  });
  if (!notOk) return false;
  var stripped = compound.replace(/:(?:not|is|has|where)\([^()]*\)/g, ' ');
  if (/:[\w-]/.test(stripped)) return false;              // an unmodelled pseudo-class
  var names = (stripped.match(/\.[\w-]+/g) || []).map(function (s) { return s.slice(1); });
  return names.length > 0 && names.every(function (n) { return classes.indexOf(n) >= 0; });
}

function winner(prop, el) {
  var best = null;
  declarations(prop).forEach(function (d) {
    if (!reaches(d.sel, el)) return;
    if (!best || beats(d, best)) best = d;
  });
  return best;
}

print('--- card-tube: is the frame\'s neon stack reachable?');

// ---- 1. the stack exists ----------------------------------------------------
check('--card-tube is declared', /--card-tube\s*:/.test(BARE),
      'the canonical tube variable is gone');

// ---- 2. THE ONE THAT MATTERS. A resting board card — no state classes, no
// hover — must end up with a filter that composes the tube. This is the check
// that would have caught all three dead-rule passes.
var restingCard = { classes: ['card'], ancestors: ['board', 'lane', 'card-slot', 'game-area'] };
var wf = winner('filter', restingCard);
check('a resting card\'s winning `filter` composes var(--card-tube)',
      wf && /var\(--card-tube\)/.test(wf.value),
      wf ? 'style.css:' + wf.line + ' wins with `' + wf.value.slice(0, 70) + '` — the tube is dead code'
         : 'no filter declaration reaches a plain .card at all');

// ---- 3. the core. The line has to be LIGHTER than the glow around it, which
// is the entire reason a tube reads as lit. A flat rgb(var(--cf-rgb)) ring is
// the state this audit was written to stop coming back.
var restingEdge = { classes: ['cf-edge'], ancestors: ['card', 'cf-frame', 'board', 'lane'] };
var we = winner('background', restingEdge);
check('the frame ring is lifted toward white, not flat frame colour',
      we && /color-mix\(/.test(we.value) && /#fff|white/.test(we.value),
      we ? 'style.css:' + we.line + ' wins with `' + we.value.slice(0, 70) + '`'
         : 'no background declaration reaches .cf-edge');

// ---- 4. ONE LINE, NOT TWO. The owner has rejected an added white line inside
// the stroke twice. The core is the line itself; the ::after ring stays dead.
var afterHidden = /\.cf-edge::after[^{]*\{[^}]*display:\s*none/.test(BARE);
check('.cf-edge::after stays hidden (one line, not two)', afterHidden,
      'a second white ring is back inside the stroke');

// ---- 5. the persistent states. Each of these declares its own `filter`, so
// each one silently erased the whole glow until it was made to compose it. They
// are listed by hand because they are a decision, not a pattern: a state that
// SHOULD go dark belongs off this list, not quietly failing it.
var MUST_COMPOSE = [
  '.card.moder-stripped', '.card.hand-card.rl-curse', '.card.card-being-dragged',
  '.card.card-asleep', '.hand-cards .card.ballyhoo-locked', '.card.hand-card.selected',
  '.card:not(.face-down):active', '.card.unplayable', '.hand-card-wrapper .card.unafford',
  '.card.unplayable.table-waiting', '.player-hand-section .hand-cards .card.dimmed-by-selection',
  '.player-hand-section .hand-cards .card.is-selected'
];
var all = declarations('filter');
MUST_COMPOSE.forEach(function (want) {
  var mine = all.filter(function (d) { return d.sel === want; });
  if (!mine.length) { bad('state composes the tube: ' + want, 'selector no longer declares filter'); return; }
  var last = mine[mine.length - 1];
  check('state composes the tube: ' + want, /var\(--card-tube\)/.test(last.value),
        'style.css:' + last.line + ' replaces the whole stack with `' + last.value.slice(0, 50) + '`');
});

// ---- 6. and the infinite keyframes, which replace `filter` sixty times a
// second for as long as the card is on the board.
['cardCrazyGlitch', 'vibeCosmicHue', 'vibeMagneticShift', 'table-waiting-breathe'].forEach(function (name) {
  var re = new RegExp('@keyframes\\s+' + name + '\\s*\\{([\\s\\S]*?)\\n\\}', 'g'), m, body = null;
  while ((m = re.exec(BARE))) body = m[1];   // the LAST one is the live definition
  check('infinite keyframe composes the tube: ' + name,
        body && /var\(--card-tube\)/.test(body),
        body ? 'it replaces the filter outright' : 'keyframe not found');
});

print('card-tube: ' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) {
  print('Failures:');
  fails.forEach(function (f) { print('  - ' + f); });
}
