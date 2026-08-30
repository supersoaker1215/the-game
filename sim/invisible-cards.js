// ============================================================
// INVISIBLE-CARD AUDIT — static. Finds board cards that CSS can make
// invisible while they stay in the DOM and stay clickable.
//
// This bug has now been found three times, always the same shape: a class is
// added to a board tile to animate it, the class hides the tile, and the only
// thing that removes it is a timer or a callback holding a reference to THAT
// element. makeCardElCached reuses board tiles between renders, so a re-render
// during the animation leaves the remover clearing a node that is no longer on
// the board while the live tile keeps the hiding class forever. The card is
// invisible, and — because nothing else about it changed — still clickable.
// (User: "the cards played would go invisible and you could click on them but
// on the board they were invisible.")
//
// card-enter and card-exit were each fixed this way; card-flying was the third.
// The cure is always the same three things, so this checks for all three:
//
//   STAMP   every add site records data-<x>At, so a sweep can tell a genuinely
//           animating tile from a stuck one
//   TIMEOUT the add site removes it again on its own
//   SWEEP   renderBoard strips it from any LIVE tile whose window has elapsed
//           — the only one of the three that can catch a reused tile, because
//           it queries the DOM instead of holding a reference
//
//   jsc sim/invisible-cards.js -- [--verbose]
// ============================================================

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

var CSS = read('style.css');
// Does this class end up INVISIBLE, or merely altered? `forwards` makes any end
// state persist, but a stuck `brightness(2.5)` is a washed-out card while a
// stuck mask or opacity:0 is a card you cannot see at all and can still click.
// Both are bugs; only one is the bug the user reported, and a tool that calls
// them the same thing stops being worth reading.
function endsInvisible(cls, body) {
  if (/opacity:\s*0\s*[;}]|visibility:\s*hidden/.test(body)) return true;
  var anim = /animation:\s*([a-zA-Z0-9_-]+)/.exec(body);
  if (!anim) return false;
  var kf = new RegExp('@keyframes\\s+' + anim[1] + '\\s*\\{([\\s\\S]*?)\\n\\}').exec(CSS);
  if (!kf) return false;
  // mask-image/mask-position dissolves end fully masked out — that is how
  // card-exit disappears without ever naming opacity.
  return /opacity:\s*0|visibility:\s*hidden|mask-position|mask-image/.test(kf[1]) ||
         /mask-image|mask-position/.test(body);
}
var UIJS = read('ui.js');
var findings = [];
function note(kind, what, detail) { findings.push({ kind: kind, what: what, detail: detail }); }

// ---- 1. which classes can hide a card? -------------------------------------
// Direct hiders: a rule on a .card-* class that sets opacity:0 or hides it.
var hiders = {};
var ruleRe = /([^{}]+)\{([^{}]*)\}/g, m;
while ((m = ruleRe.exec(CSS))) {
  var sel = m[1], body = m[2];
  // A class hides a tile if it sets it invisible outright, OR if it runs an
  // animation with `forwards` — fill-mode forwards means the END STATE
  // PERSISTS after the animation finishes, which is exactly what makes a stuck
  // class permanent. card-exit is the case that proves the point: it never
  // says `opacity: 0` anywhere, it dissolves via an animated mask and ends
  // fully masked out, so an opacity-only scan cannot see the very bug this
  // audit was written for.
  if (!/opacity:\s*0\s*[;}]|visibility:\s*hidden|animation:[^;]*\bforwards\b/.test(body)) continue;
  // Only selectors that target a card tile, and only the simple form — a
  // hider gated on a second class (.a.b) needs both, which the add-site scan
  // below will not match anyway.
  var cls = sel.match(/\.card-[a-zA-Z0-9-]+|\.card\.[a-zA-Z0-9-]+/g) || [];
  cls.forEach(function (c) {
    var name = c.replace(/^\.card\./, '').replace(/^\./, '');
    if (!name || name === 'card') return;
    // STATE CLASSES ONLY. ally-card / enemy-card / hand-card are permanent
    // IDENTITY classes — every board tile carries one for its whole life, and
    // they only ever appear in a hiding rule as half of a compound
    // (`.card-flying.ally-card`). Treating them as hiders reports three
    // findings that can never be fixed, because there is nothing transient to
    // sweep. Every real animation class in this file is `card-<state>`.
    if (!/^card-/.test(name)) return;
    // A DETACHED CLONE IS NOT A BOARD TILE. card-death-ghost is put on a clone
    // appended to <body> and removed on its own timer; it never touches a tile
    // the renderer can reuse, so it has nothing to be swept from.
    if (/-ghost$/.test(name)) return;
    hiders[name] = { invisible: endsInvisible(name, body) };
  });
}

// ---- 2. which of those are applied to BOARD tiles by ui.js? ----------------
var applied = {};
var addRe = /classList\.add\((['"])([a-zA-Z0-9_-]+)\1/g;
while ((m = addRe.exec(UIJS))) if (hiders[m[2]]) applied[m[2]] = (applied[m[2]] || 0) + 1;

// ---- 3. does each have a stamp, a timeout and a sweep? ---------------------
// The sweep is the load-bearing one, so it is checked by the exact shape
// renderBoard uses.
Object.keys(applied).sort().forEach(function (cls) {
  var sweepRe = new RegExp("querySelectorAll\\((['\"])#board \\.card\\." + cls + "\\1\\)");
  var hasSweep = sweepRe.test(UIJS);
  // A stamp is a dataset write NEAR an add of this class — on either side of
  // it, and with a window wide enough to survive the explanatory comment that
  // every one of these sites carries. The first version of this check looked
  // only BEFORE the add and only 400 chars back, and reported three fixes that
  // were sitting right there as missing.
  var addRes = new RegExp("classList\\.add\\((['\"])" + cls + "\\1\\)");
  var addAt = UIJS.search(addRes);
  var near = addAt < 0 ? '' : UIJS.slice(Math.max(0, addAt - 1200), addAt + 1200);
  var hasStamp = /dataset\.[a-zA-Z0-9_]+ = String\(Date\.now\(\)\);/.test(near);
  // Self-removal: anywhere in the file is enough — a removal in a timer the add
  // site armed is exactly as good as one three lines down, and often clearer.
  var hasTimeout = new RegExp("classList\\.remove\\((['\"])" + cls + "\\1\\)").test(UIJS);
  var missing = [];
  if (!hasStamp) missing.push('STAMP');
  if (!hasTimeout) missing.push('self-removal');
  if (!hasSweep) missing.push('SWEEP');
  if (!missing.length) return;
  // No sweep is the finding that matters — without it a reused tile is stuck
  // for the rest of the match. The other two are defence in depth.
  var invisible = hiders[cls] && hiders[cls].invisible;
  var kind = hasSweep ? 'THIN' : (invisible ? 'STUCKABLE' : 'STICKY');
  note(kind, '.' + cls,
    (invisible ? 'can make a board card INVISIBLE' : 'leaves a persisting visual state on a board card')
    + ' and is missing: ' + missing.join(' + ')
    + (hasSweep ? '' : ' — a reused tile keeps it for the rest of the match'));
});

// ---- 4. do all modes reach the sweep? -------------------------------------
// The sweep lives in renderBoard, so any renderer that paints lane cards
// WITHOUT going through renderBoard would not be covered.
var boardRenderers = [];
var fnRe = /^  (_?render[A-Za-z0-9_]*)\(/gm;
while ((m = fnRe.exec(UIJS))) boardRenderers.push(m[1]);
var paintsLanes = [];
boardRenderers.forEach(function (fn) {
  var start = UIJS.indexOf('\n  ' + fn + '(');
  if (start < 0) return;
  var end = UIJS.indexOf('\n  },', start);
  var body = UIJS.slice(start, end < 0 ? start + 8000 : end);
  // Does it actually BUILD lane card tiles, as opposed to merely mentioning a
  // lane? The forecast strip queries lanes to position itself over them and
  // paints no cards at all; only a renderer that makes card elements can leave
  // a hiding class on one.
  // Only renderers that build BOARD tiles. renderPlayerHand adds card-* classes
  // too, but to hand cards — a different surface with its own lifecycle, and
  // reporting it here is noise, not a lane that misses the sweep.
  if (!/makeCardElCached|_spawnPlayerLandFx/.test(body)) return;
  if (fn === 'renderBoard' || fn === '_renderBoardImpl') return;
  if (/Hand$/.test(fn)) return;   // the hand is a different surface, with its own lifecycle
  var reaches = /this\.renderBoard\(|_render2v2OnlineBoard\(/.test(body);
  paintsLanes.push({ fn: fn, reaches: reaches });
  if (!reaches) note('UNSWEPT', fn + '()', 'paints lane cards but never calls renderBoard — the stuck-class sweep does not run for it');
});

// ---- report ---------------------------------------------------------------
print('=== INVISIBLE-CARD AUDIT ===');
print('classes CSS can hide a card with: ' + Object.keys(hiders).length
  + '   of those, applied to tiles by ui.js: ' + Object.keys(applied).length
  + '   lane renderers checked: ' + paintsLanes.length);
if (VERBOSE) {
  print('  hiding classes in use: ' + Object.keys(applied).sort().join(', '));
  paintsLanes.forEach(function (r) { print('  ' + r.fn + ' → renderBoard: ' + (r.reaches ? 'yes' : 'NO')); });
}
var byKind = {};
findings.forEach(function (f) { (byKind[f.kind] = byKind[f.kind] || []).push(f); });
var total = 0;
['STUCKABLE', 'UNSWEPT', 'STICKY', 'THIN'].forEach(function (k) {
  var list = byKind[k] || [];
  total += list.length;
  if (!list.length) { print('  ' + k + ': none'); return; }
  print('  ' + k + ': ' + list.length);
  list.forEach(function (f) { print('      ' + f.what + ' — ' + f.detail); });
});
print(total ? ('TOTAL FINDINGS: ' + total)
            : 'NO FINDINGS — every class that can hide a board card is swept if it sticks.');
