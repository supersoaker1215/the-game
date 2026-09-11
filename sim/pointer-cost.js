// ============================================================
// NOTHING WRITES A <body> CUSTOM PROPERTY ON EVERY MOUSEMOVE.
//
//   jsc sim/pointer-cost.js
//
// Owner: "its when i move my mouse constantly over draft cards".
//
// A custom property written on <body> invalidates style for the WHOLE
// document subtree. Do that on a mousemove listener and you buy a
// document-wide style recalc on every frame the cursor is moving — 954
// elements on the draft screen, ~2,090 on the board. Measured render phase
// (style+layout+paint) while the cursor moved constantly:
//
//     draft screen ......  4.7 ms -> 1.2 ms per frame  (idle floor 0.9 ms)
//     match board ...... 24.1 ms -> 9.8 ms per frame  (idle floor 1.8 ms)
//
// 24.1 ms was already over the 16.7 ms frame budget, on a fast machine.
//
// Two listeners were doing it, and BOTH drove nothing at all:
//
//   --mx / --my          (installTronFlare) — its only consumer is
//                        `.background-grid, body > .grid-bg`, and no such
//                        element is created anywhere in this repo. The class
//                        names appear in style.css and nowhere else.
//   --grid-px-x / -y     (installPolishLayer) — its only consumer is
//                        body::after's background-position, and body::after is
//                        authored FOUR times; the last one sets the
//                        `background` SHORTHAND, which resets
//                        background-position and takes the grid with it.
//                        Measured live: --grid-px-x was 1.72px while the
//                        computed background-position read "0% 0%".
//
// Proven inert empirically rather than by reading the cascade — each var was
// slammed to 400px and ZERO computed styles moved across every element plus
// the body/html pseudo-elements, on the main menu, the draft screen and the
// board (including body.turn-player, the one state where body::after is
// actually visible). See [[css-audit-traps]] for why reading the cascade would
// not have settled it.
//
// This suite pins the invariant, not the deletion: a per-mousemove <body>
// custom-property write must not come back, however it is dressed up.
// ============================================================

var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');

var __cases = [], __passed = 0, __failed = 0, __failures = [];
function t(name, fn) { __cases.push({ name: name, fn: fn }); }
var __caseFailed = false, __caseMsgs = [];
function eq(label, actual, expected) {
  if (actual !== expected) {
    __caseFailed = true;
    __caseMsgs.push(label + ': expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
  }
}

var UISRC_RAW = read('ui.js');
// Blank comment bodies (keep newlines so line numbers still mean something).
// This file's OWN prose names the removed writers, and art-accent.js was
// failed once by exactly that — a comment reading as code.
function decomment(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); })
          .replace(/\/\/[^\n]*/g, '');
}
var UISRC = decomment(UISRC_RAW);

// Balanced-brace body of every mousemove / pointermove listener.
function pointerHandlerBodies() {
  var out = [], re = /addEventListener\(\s*['"](?:mousemove|pointermove)['"]/g, m;
  while ((m = re.exec(UISRC)) !== null) {
    var brace = UISRC.indexOf('{', m.index);
    if (brace < 0) continue;
    var depth = 0, i = brace;
    for (; i < UISRC.length; i++) {
      var ch = UISRC.charAt(i);
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    out.push({ at: m.index, body: UISRC.slice(brace, i + 1) });
  }
  return out;
}
function lineOf(idx) { return UISRC.slice(0, idx).split('\n').length; }

t('PC-1 the two dead vars are never written again', function () {
  // Not "the listener is gone" — the VAR. A rewrite that keeps the write and
  // moves it somewhere else costs exactly the same.
  ['--grid-px-x', '--grid-px-y', '--mx', '--my'].forEach(function (v) {
    var hits = UISRC.split("'" + v + "'").length - 1;
    eq('ui.js never writes ' + v, hits, 0);
  });
});

// The installer a listener sits in, and whether that installer can ever reach
// it. A handler behind an unconditional early return costs nothing, so flagging
// it would be a false alarm — but only a PROVABLE `if (true) return;` counts,
// never a runtime condition.
function enclosingInstaller(at) {
  var re = /\n  ([A-Za-z_$][A-Za-z0-9_$]*)\(/g, m, best = null;
  while ((m = re.exec(UISRC)) !== null) { if (m.index > at) break; best = { name: m[1], at: m.index }; }
  return best;
}
function unreachable(handlerAt) {
  var fn = enclosingInstaller(handlerAt);
  if (!fn) return false;
  var seg = UISRC.slice(fn.at, handlerAt);
  return seg.indexOf('if (true) return;') >= 0;
}

t('PC-2 no reachable mousemove listener writes a <body> custom property', function () {
  var bodies = pointerHandlerBodies();
  eq('there are still mousemove listeners to check', bodies.length > 0, true);
  var checked = 0;
  bodies.forEach(function (h) {
    if (unreachable(h.at)) return;      // switched off; PC-4 pins that it stays off
    checked++;
    var b = h.body;
    // The exact shape that caused this: a custom property set on body or the
    // root element, from inside a pointer handler.
    var bad = /document\.body\.style\.setProperty\(\s*['"]--/.test(b)
           || /document\.documentElement\.style\.setProperty\(\s*['"]--/.test(b);
    eq('handler near ui.js:' + lineOf(h.at) + ' (' + (enclosingInstaller(h.at) || {}).name +
       ') writes no <body> custom prop', bad, false);
  });
  eq('and it actually checked some live handlers', checked > 0, true);
});

t('PC-3 nor does one schedule such a write for the next frame', function () {
  // The --mx/--my writer did its setProperty inside a rAF callback declared
  // beside the listener, so a check that only read the handler body would have
  // missed it. Widen to the whole enclosing installer for the two functions
  // that owned these, and assert no body-level custom-property write survives
  // anywhere in them.
  ['installTronFlare', 'installPolishLayer'].forEach(function (fn) {
    var open = UISRC.indexOf('\n  ' + fn + '(');
    eq(fn + ' found', open > 0, true);
    if (open < 0) return;
    var brace = UISRC.indexOf('{', open), depth = 0, i = brace;
    for (; i < UISRC.length; i++) {
      var ch = UISRC.charAt(i);
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    var body = UISRC.slice(brace, i + 1);
    eq(fn + ' sets no <body> custom property',
       /document\.body\.style\.setProperty\(\s*['"]--/.test(body), false);
  });
});

t('PC-4 the third body-level writer stays disabled', function () {
  // installParallaxMenu writes --parallax-x/y on <body> from a mousemove, the
  // same shape, and it is already switched off. If it is ever switched back on
  // it has to be scoped to the element that consumes it first.
  var open = UISRC.indexOf('\n  installParallaxMenu(');
  eq('installParallaxMenu found', open > 0, true);
  var body = UISRC.slice(open, open + 2200);
  var listenerAt = body.indexOf("addEventListener('mousemove'");
  var guardAt = body.indexOf('if (true) return;');
  eq('it is guarded', guardAt >= 0, true);
  eq('and the guard comes BEFORE the listener', guardAt >= 0 && guardAt < listenerAt, true);
});

t('PC-5 the element --mx was steering still does not exist', function () {
  // If someone creates .background-grid later, the CSS rule wakes up and the
  // temptation is to re-add the <body> writer to feed it. The rule stands:
  // write the var on that element, never on <body>. This case exists so the
  // next person sees the note.
  var made = /background-grid|grid-bg/.test(UISRC)
          || /background-grid|grid-bg/.test(read('index.html'));
  eq('no .background-grid / .grid-bg is created in ui.js or index.html', made, false);
});

// ---- run ----------------------------------------------------
__cases.forEach(function (c) {
  __caseFailed = false; __caseMsgs = [];
  try { c.fn(); } catch (e) {
    __caseFailed = true;
    __caseMsgs.push('threw: ' + (e && e.message ? e.message : String(e)));
  }
  if (__caseFailed) { __failed++; __failures.push({ name: c.name, msgs: __caseMsgs.slice(0, 6) }); }
  else __passed++;
});
print('pointer-cost: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
