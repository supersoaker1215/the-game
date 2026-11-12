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

var CSS = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join(''));
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

// ---- 3. no @keyframes name is defined twice -------------------------------
// Keyframe names resolve GLOBALLY and last-definition-wins; specificity does
// not apply. A duplicate silently retires the earlier animation, which is how
// the 2-axis `hpShake` written for the HP number never played once in the
// shipped game — both consumers got the flat translateX one 200 lines below.
var kf = {}, kre = /@keyframes\s+([\w-]+)\s*\{/g, km;
while ((km = kre.exec(BARE))) {
  var nm = km[1];
  (kf[nm] = kf[nm] || []).push(BARE.slice(0, km.index).split('\n').length + 1);
}
// KNOWN, UNREVIEWED DUPLICATES — baselined deliberately, not waved through.
// Each of these silently retires an earlier animation, exactly as hpShake did,
// and picking which definition is the intended one is a per-animation design
// call (rlPhaseWipeSweep has THREE, and the surviving pair travels +/-50% where
// the first travels +/-110%). They are listed so the suite guards against NEW
// duplicates while the debt stays visible and counted. Shrink this list; never
// add to it.
// EMPTY, AND IT STAYS EMPTY. All eight duplicates are gone: hpShake was renamed
// (the two consumers genuinely wanted different motion), five were dead earlier
// copies superseded by a var(--card-tube) or themed rewrite that already won,
// blockFullPulse was orphaned outright, and rlPhaseWipeSweep went 3 -> 1.
// Anything added here again is a silently-retired animation.
var KNOWN_DUPE_KEYFRAMES = [];
var dupes = Object.keys(kf).filter(function (n) { return kf[n].length > 1; });
var fresh = dupes.filter(function (n) { return KNOWN_DUPE_KEYFRAMES.indexOf(n) < 0; });
var stale = KNOWN_DUPE_KEYFRAMES.filter(function (n) { return dupes.indexOf(n) < 0; });
check('no NEW @keyframes name is defined more than once',
      fresh.length === 0,
      fresh.map(function (n) { return n + ' at L' + kf[n].join(', L'); }).join(' | '));
check('the known-duplicate baseline has no stale entries',
      stale.length === 0,
      'these are no longer duplicated and should be removed from the list: ' + stale.join(', '));
if (VERBOSE) print('  (baselined duplicate keyframes still outstanding: ' + dupes.length + ')');

// ---- 4. a hover that MOVES a card must transition what it moves -----------
// `transition` is one list, so a more specific hover rule that re-authors it
// for a single property silently drops the duration off everything else. That
// made board cards snap to scale(1.4) on enter and glide back over 240ms on
// leave — instant in, eased out, which is backwards.
var laneHover = null;
var lre = /(?:^|\n)([^{}@][^{}]*?)\{([^{}]*)\}/g, lm;
while ((lm = lre.exec(BARE))) {
  var sels = lm[1].split(',').map(function (x) { return x.replace(/\s+/g, ' ').trim(); });
  if (sels.indexOf('.lane .card:hover') < 0) continue;
  var tdecl = /(?:^|[;{\s])transition\s*:([^;]*)/.exec(lm[2]);
  if (tdecl) laneHover = { value: tdecl[1].replace(/\s+/g, ' ').trim(),
                           line: BARE.slice(0, lm.index).split('\n').length + 1 };
}
check('.lane .card:hover re-authors transition, so it must list transform',
      !laneHover || /\btransform\b/.test(laneHover.value),
      laneHover ? ('L' + laneHover.line + ' lists only: ' + laneHover.value) : '');

// ---- 5. the three fit-loop outputs publish integers ------------------------
// --hand-card-w and --board-card-w are Math.floor; --trick-card-w published
// one decimal, so the whole centred trick row landed on sub-pixels and its 1px
// neon borders rasterised soft while the hand row above it was crisp. The
// repo's own note at ui.js:24690 diagnosed this for the board already.
var UI = (read('ui.js') + '\n' + read('fx.js'))   /* fx.js = the effects library split out of ui.js */;
// STRIPPING JS COMMENTS NEEDS A SCANNER, NOT A REGEX — and getting this wrong
// silently deletes a tenth of the file. ui.js:10 contains the text `/*.png)`
// INSIDE a `//` line comment. A naive `/\*[\s\S]*?\*/` strip treats that as a
// block-comment opener and blanks 401 lines (10-411) — which is exactly where
// the art tier pipeline lives, so every ui.js assertion about it silently
// answered "not found". Browsers parse it correctly; only the analyser was
// wrong. (The CSS mirror of this — `*/` inside a comment — is already pinned by
// sim/css-parse.js.)
// Walk once, tracking string / template / line-comment / block-comment state,
// and blank comment bodies while preserving newlines so line numbers hold.
function stripJsComments(src) {
  var out = '', i = 0, n = src.length, q = null, inLine = false, inBlock = false;
  while (i < n) {
    var c = src[i], d = src[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } else out += ' '; i++; continue; }
    if (inBlock) { if (c === '*' && d === '/') { inBlock = false; out += '  '; i += 2; } else { out += (c === '\n' ? c : ' '); i++; } continue; }
    if (q) {
      out += c;
      if (c === '\\') { out += (d === undefined ? '' : d); i += 2; continue; }
      if (c === q) q = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && d === '/') { inLine = true; out += '  '; i += 2; continue; }
    if (c === '/' && d === '*') { inBlock = true; out += '  '; i += 2; continue; }
    out += c; i++;
  }
  return out;
}
var BARE_UI = stripJsComments(UI);
// Self-check: if the scanner ever regresses, say so instead of reporting every
// ui.js finding as "not found".
check('the ui.js comment scanner did not eat the source',
      BARE_UI.length > UI.length * 0.5 && /_artFallback/.test(BARE_UI),
      'stripped ' + (100 - Math.round(BARE_UI.length / UI.length * 100)) + '% of the file');
['--hand-card-w', '--board-card-w', '--trick-card-w'].forEach(function (tok) {
  var m2 = new RegExp("setProperty\\(\\s*'" + tok + "'\\s*,([^;]*?)\\)\\s*;").exec(BARE_UI);
  if (!m2) { check('publishes ' + tok, false, 'no setProperty found'); return; }
  var body = m2[1].replace(/\s+/g, ' ').trim();
  if (/toFixed\(/.test(body)) { check(tok + ' is published as an integer', false, 'publishes `' + body.slice(0, 70) + '`'); return; }
  var intish = /Math\.(floor|round)\(/.test(body);
  // `bw + 'px'` is still an integer when bw was floored a line earlier, so
  // follow a bare identifier back to its declaration before judging it.
  if (!intish) {
    var id = /^([A-Za-z_$][\w$]*)\s*\+/.exec(body);
    if (id) {
      var decl = new RegExp('(?:const|let|var)\\s+' + id[1] + '\\s*=([^;]*);').exec(BARE_UI);
      if (decl && /Math\.(floor|round)\(/.test(decl[1])) intish = true;
    }
  }
  check(tok + ' is published as an integer', intish, 'publishes `' + body.slice(0, 70) + '`');
});

// ---- 6. a failed art fetch must fall back ACROSS tiers --------------------
// Retrying the SAME directory minus the ?v= heals a dropped fetch and is a
// guaranteed second 404 for a file that is simply absent from that tier —
// and the result is memoized, so the portrait stays blank all session.
// `=` not followed by `=`, or this matches the guard READ (`if (this._artFallback
// && this._artFallback[fbKey]) return ...`) that sits earlier in the file.
var fbm = /_artFallback\[fbKey\]\s*=(?!=)([^;]{0,400});/.exec(BARE_UI);
check('the art fallback can leave the tier it just failed in',
      !!fbm && /audio\/cards\/art['"`]/.test(fbm[0]),
      fbm ? ('assigns `' + fbm[1].replace(/\s+/g, ' ').trim().slice(0, 80) + '`')
          : 'no _artFallback assignment found');

// ---- 7. the phase wipe actually sweeps, rather than starting covered -------
// A translate-based wipe only reads as a SWEEP if the element is fully clear of
// its clipped container at both ends. For an element of width k*W translated by
// t% of its OWN width, the right edge sits at k*W*(1 - t/100), so it clears the
// left edge only when t >= 100 — independent of k, which is why the authored
// `width: 200%` does not rescue a smaller travel.
// This shipped at +/-50% for a long time (the element already covered the whole
// container at frame 0, so it could only wipe OFF) because two later duplicate
// @keyframes definitions silently retired the +/-110% one it was designed with.
var sweep = null;
var sre = /@keyframes\s+rlPhaseWipeSweep\s*\{/.exec(BARE);
if (sre) {
  var k2 = sre.index + sre[0].length, depth2 = 1;
  while (k2 < BARE.length && depth2) {
    if (BARE[k2] === '{') depth2++;
    else if (BARE[k2] === '}') depth2--;
    k2++;
  }
  var body2 = BARE.slice(sre.index, k2);
  // Read the CAPTURE GROUP, not a fresh number-match over the matched text:
  // `translate3d` contains a digit, so re-scanning `translate3d(-110%` for the
  // first number yields 3. Both the 110% and 50% cases then reported "3%",
  // which looked like a working test that could not tell them apart.
  var offsets = [], ore = /translate3d\(\s*(-?\d+(?:\.\d+)?)%/g, om;
  while ((om = ore.exec(body2))) offsets.push(Math.abs(parseFloat(om[1])));
  sweep = offsets.length ? Math.min.apply(null, offsets) : null;
}
check('the roguelite phase wipe clears its container at both ends',
      sweep !== null && sweep >= 100,
      sweep === null ? 'could not read a translate3d % from @keyframes rlPhaseWipeSweep'
                     : 'travels only ' + sweep + '% of its own width, so it starts already covering the container');

// ---- 8. the draft header must be allowed to wrap on a phone ---------------
// .draft-hud is a flex row whose children default to min-width:auto, so with
// `nowrap` it cannot fit below ~620px and does not try: overflow is visible,
// the excess paints outside <body>, and <body> clips on x. Measured on the
// deployed build at 375px mid-draft: box 349px against 603px of content, with
// Sound (511->554) and Menu (574->603) entirely off-screen, Mulligan 116px cut,
// and document.scrollWidth === 375 — so there was no gesture that could reach
// any of them. You could not quit a draft on a phone.
// The guard is that SOME phone-width rule lets it wrap; the exact layout is
// free to change.
var wraps = [];
var hre = /(?:^|\n)([^{}@][^{}]*?)\{([^{}]*)\}/g, hm2;
while ((hm2 = hre.exec(BARE))) {
  var sl = hm2[1].split(',').map(function (x) { return x.replace(/\s+/g, ' ').trim(); });
  if (!sl.some(function (x) { return /\.draft-hud$/.test(x); })) continue;
  var w2 = /(?:^|[;{\s])flex-wrap\s*:\s*([\w-]+)/.exec(hm2[2]);
  if (w2) wraps.push(w2[1]);
}
check('the draft header is allowed to wrap at phone width',
      wraps.indexOf('wrap') >= 0,
      wraps.length ? ('only ever set to: ' + wraps.join(', ')) : 'no flex-wrap is set on .draft-hud anywhere');

// ---- 9. --cf-inset stays consolidated ------------------------------------
// It positions the card frame, the edge, the band and the cost together AND
// feeds the body clip-path, and it had drifted to 21 declarations across 11
// values, ten of which could never paint. Consolidated to five, one per
// surface. Two are ratios and must stay rounded: a fractional inset puts a 1px
// neon line on a half pixel, which the rasteriser splits into two half-opacity
// lines (ui.js:24694). Frame and clip read the same token, so rounding cannot
// open a seam between them.
var insetVals = {}, ire = /(?:^|\n)([^{}@][^{}]*?)\{([^{}]*)\}/g, im;
while ((im = ire.exec(BARE))) {
  var idm = /(?:^|[;{\s])--cf-inset\s*:([^;]*)/.exec(im[2]);
  if (!idm) continue;
  var v = idm[1].replace(/\s+/g, ' ').trim();
  (insetVals[v] = insetVals[v] || []).push(BARE.slice(0, im.index).split('\n').length + 1);
}
var vals = Object.keys(insetVals);
check('--cf-inset has not drifted back past five distinct values',
      vals.length <= 5,
      vals.length + ' values: ' + vals.join(' | '));
var unroundedRatio = vals.filter(function (v) { return /calc\(/.test(v) && !/round\(/.test(v); });
check('every ratio-derived --cf-inset is rounded to whole pixels',
      unroundedRatio.length === 0,
      unroundedRatio.join(' | '));

// ---- 10. the four-row menu block keeps the last word --------------------
// .mm-option is declared in four places and the label's colour at ~L14792 is
// !important, so the four-row restyle only paints because its block is LAST
// in the file and !important at >= (0,4,0). Both halves are asserted: the
// gold selected state exists in that form, and no later rule has crept in
// beneath it to re-declare the label's size. (The reference's one defining
// move is the gold row; losing it to a later .mm-option-label would look
// exactly like the restyle never shipped.)
var goldRule = null, lastLabelSize = null;
var mre2 = /(?:^|\n)([^{}@][^{}]*?)\{([^{}]*)\}/g, mm3;
while ((mm3 = mre2.exec(BARE))) {
  var sels3 = mm3[1].split(',').map(function (x) { return x.replace(/\s+/g, ' ').trim(); });
  var body3 = mm3[2];
  if (sels3.some(function (x) { return /\.mm-four \.mm-option\.is-active \.mm-option-label/.test(x); })
      && /color\s*:[^;]*--(mm-gold|gold-rgb)[^;]*!important/.test(body3)) goldRule = BARE.slice(0, mm3.index).split('\n').length + 1;
  if (sels3.some(function (x) { return /\.mm-option-label$/.test(x); }) && /(?:^|[;{\s])font-size\s*:/.test(body3)) {
    lastLabelSize = { line: BARE.slice(0, mm3.index).split('\n').length + 1, sel: sels3.join(', '), important: /font-size\s*:[^;]*!important/.test(body3) };
  }
}
check('the gold selected-row rule exists, !important, on the (0,4,0) selector',
      goldRule !== null, 'no `.mm-four .mm-option.is-active .mm-option-label { color: …gold… !important }` found');
check('the four-row block holds the LAST .mm-option-label font-size in the sheet',
      !!lastLabelSize && /\.mm-four/.test(lastLabelSize.sel) && lastLabelSize.important,
      lastLabelSize ? ('last is L' + lastLabelSize.line + ' `' + lastLabelSize.sel.slice(0, 60) + '`' + (lastLabelSize.important ? '' : ' (not !important)')) : 'none found');

// The title screen centres its lockup inside the SAME overlay the menu
// left-pins with `.main-menu-overlay { align-items: flex-start !important }`.
// A normal `align-items: center` on `.is-title` loses to that regardless of
// specificity (an !important beats every normal declaration) — the wordmark
// sat on the left edge at 1280px. So the title rule must carry !important too.
var titleAlign = null;
var mre3 = /(?:^|\n)([^{}@][^{}]*?)\{([^{}]*)\}/g, mm4;
while ((mm4 = mre3.exec(BARE))) {
  var sels4 = mm4[1].split(',').map(function (x) { return x.replace(/\s+/g, ' ').trim(); });
  if (sels4.some(function (x) { return /^#main-menu-overlay\.is-title(:not\(\.ts-menulike\))?$/.test(x); }) && /align-items\s*:/.test(mm4[2])) {
    titleAlign = { important: /align-items\s*:[^;]*!important/.test(mm4[2]), justImportant: /justify-content\s*:[^;]*!important/.test(mm4[2]) };
  }
}
var baseLeftPin = /\.main-menu-overlay\s*\{[^}]*align-items\s*:\s*flex-start\s*!important/.test(BARE);
check('the title screen centres with !important (the base overlay left-pins with !important)',
      !!titleAlign && titleAlign.important && titleAlign.justImportant && baseLeftPin,
      titleAlign ? ('align !imp=' + titleAlign.important + ' justify !imp=' + titleAlign.justImportant + ' basePin=' + baseLeftPin) : 'no #main-menu-overlay.is-title align-items rule');

// ---- every @keyframes is played by something ---------------------------
// A keyframe nothing names is dead weight, and worse, a trap: a reader finds
// the animation, assumes it runs, and builds on it. Ten were deleted on
// 2026-11-10 (aaaBlockBreathe, tronConicFlow, cardStressTremble … — several
// disabled by owner request years of commits ago, left "in place but unused").
// A keyframe counts as used when a CSS animation / animation-name / custom
// property names it, or when any shipped JS / index.html names it as a whole
// word (JS sets style.animation and builds FX with these names).
(function () {
  var names = []; var re = /@(?:-webkit-)?keyframes\s+([\w-]+)\s*\{/g, mm;
  while ((mm = re.exec(BARE))) names.push(mm[1]);
  var cssUse = {};
  var dre = /(?:animation(?:-name)?|--[\w-]+)\s*:\s*([^;{}]+)/g, dm;
  while ((dm = dre.exec(BARE))) (dm[1].match(/[A-Za-z_][\w-]*/g) || []).forEach(function (t) { cssUse[t] = true; });
  var jsText = '';
  ['ui.js', 'fx.js', 'menu-scene.js', 'game.js', 'abilities.js', 'tricks.js', 'ai.js', 'roguelite.js', 'multiplayer.js',
   'voice.js', 'tutorial.js', 'tournament.js', 'index.html'].forEach(function (f) {
    try { jsText += '\n' + read(f); } catch (e) {}
  });
  var dead = names.filter(function (n) {
    if (cssUse[n]) return false;
    return !new RegExp('(^|[^\\w-])' + n.replace(/[-]/g, '\\-') + '([^\\w-]|$)').test(jsText);
  });
  check('every @keyframes is used by a CSS animation or named in the shipped JS',
        dead.length === 0, 'dead: ' + dead.join(', '));
})();

print('');
print('visual-system: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('visual-system failed');
