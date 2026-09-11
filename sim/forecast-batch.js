// ============================================================
// THE HOVER FORECAST MEASURES FIRST AND BUILDS SECOND.
//
//   jsc sim/forecast-batch.js
//
// Owner: "the game is lagging wn i hover over cards".
//
// Hovering a board card draws the combat forecast, and the follow loop in
// _installCombatForecast re-plots it on every frame the hovered card's rect
// changes — which the hover magnify does for the whole 240ms of its grow. So a
// single hover is ~14 full re-plots, landing in exactly the 14 frames that are
// already paying for the card's own re-raster.
//
// _showCombatForecast used to append an arrow, measure the next target, append
// the next arrow, measure again. A getBoundingClientRect that follows a DOM
// mutation cannot reuse the layout the engine already has, so each of those
// measures forced a fresh synchronous layout. Measured in the browser on a
// 3-target card:
//
//     the same rect reads, batched .............. 0.0015 ms
//     the same rect reads, interleaved .......... 0.30 ms each
//     one whole re-plot, before ................. 2.828 ms  (39.6 ms / hover)
//     one whole re-plot, after .................. 0.337 ms  ( 4.7 ms / hover)
//     _forecastBadge across 3 live hovers, before  28.0 ms
//     _forecastBadge across 3 live hovers, after .. 0.2 ms
//
// The DOM output is byte-identical — verified node-for-node across all 12 board
// cards before and after.
//
// This suite cannot run the browser path (there is no layout engine here), so
// it pins the INVARIANT that made it fast, which is the thing a future edit
// would break by accident: no measuring after the build starts, one append, one
// theme read. See [[trace-dont-eyeball]] for why the numbers above are measured
// rather than reasoned about.
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

var UISRC = read('ui.js');

// Pull one method's body out of ui.js by its opening line, balancing braces so
// a nested function or object literal cannot end the slice early. Line-wise
// grep cannot see a multi-line rule — the same trap [[css-audit-traps]] records.
function methodBody(name) {
  var open = UISRC.indexOf('\n  ' + name + '(');
  if (open < 0) return '';
  var brace = UISRC.indexOf('{', open);
  if (brace < 0) return '';
  var depth = 0, i = brace;
  for (; i < UISRC.length; i++) {
    var ch = UISRC.charAt(i);
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  return UISRC.slice(brace, i + 1);
}
// Blank comment bodies (keeping newlines) so the prose ABOVE describing the old
// interleave is not itself read as code — art-accent.js hit exactly this.
function decomment(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); })
          .replace(/\/\/[^\n]*/g, '');
}

var SHOW_RAW = methodBody('_showCombatForecast');
var SHOW = decomment(SHOW_RAW);

t('FB-1 the method still exists and is the one being pinned', function () {
  eq('_showCombatForecast found', SHOW.length > 400, true);
  eq('it still plots arrows', SHOW.indexOf('_forecastArrow') > 0, true);
  eq('it still plots badges', SHOW.indexOf('_forecastBadge') > 0, true);
});

t('FB-2 the build phase is marked, and nothing measures after it', function () {
  var cut = SHOW_RAW.indexOf('PASS 2: WRITE ONLY');
  eq('the write phase is marked', cut > 0, true);
  // Everything after the marker is the build. A rect read there is the exact
  // regression this suite exists to catch: it re-forces a layout per frame.
  var writePhase = decomment(SHOW_RAW.slice(cut));
  eq('no getBoundingClientRect in the write phase',
     writePhase.indexOf('getBoundingClientRect') < 0, true);
  eq('no getComputedStyle in the write phase',
     writePhase.indexOf('getComputedStyle') < 0, true);
  eq('no _fxCenter in the write phase (it measures)',
     writePhase.indexOf('_fxCenter') < 0, true);
  eq('no _themeRGB in the write phase (it calls getComputedStyle)',
     writePhase.indexOf('_themeRGB') < 0, true);
});

t('FB-3 the layer is appended to exactly once', function () {
  // One append of one fragment. The old code appended per arrow and per badge,
  // so every following measure had a dirty layout to force.
  var appends = SHOW.match(/_forecastLayer\(\)\.appendChild/g) || [];
  eq('one _forecastLayer().appendChild', appends.length, 1);
  eq('and it appends the fragment',
     /_forecastLayer\(\)\.appendChild\(frag\)/.test(SHOW), true);
  eq('the fragment is created', /createDocumentFragment\(\)/.test(SHOW), true);
});

t('FB-4 the theme is resolved once per plot, not once per arrow', function () {
  var reads = SHOW.match(/this\._themeRGB\(\)/g) || [];
  eq('_themeRGB called at most once in the plot', reads.length <= 1, true);
  eq('and it is handed to the arrows', /themeRGB/.test(SHOW), true);
  var arrow = decomment(methodBody('_forecastArrow'));
  eq('the arrow prefers the value it was given',
     /opts\.themeRGB\s*\|\|\s*this\._themeRGB\(\)/.test(arrow), true);
});

t('FB-5 every node the plot makes can be built detached', function () {
  // opts.frag is what lets the badge/arrow land in the fragment instead of the
  // live layer. If a helper loses it, that helper starts appending mid-build
  // again and FB-3 alone would not notice.
  ['_forecastArrow', '_forecastBadge', '_forecastHeroBadge'].forEach(function (fn) {
    var body = decomment(methodBody(fn));
    eq(fn + ' honours opts.frag',
       /\(opts\.frag \|\| this\._forecastLayer\(\)\)\.appendChild/.test(body), true);
  });
});

t('FB-6 the badges reuse the rect the read phase already took', function () {
  var badge = decomment(methodBody('_forecastBadge'));
  eq('_forecastBadge takes a pre-measured rect',
     /opts\.rect \|\| el\.getBoundingClientRect\(\)/.test(badge), true);
  var hero = decomment(methodBody('_forecastHeroBadge'));
  eq('_forecastHeroBadge takes one too',
     /opts\.rect \|\| orb\.getBoundingClientRect\(\)/.test(hero), true);
  eq('and the plot passes it', /rect: pl\.rect/.test(SHOW), true);
});

t('FB-7 the follow loop that makes this hot is still there', function () {
  // If the follow loop is ever removed the batching stops mattering, and a
  // future reader should be told why this suite exists. Pin the coupling.
  var inst = decomment(methodBody('_installCombatForecast'));
  eq('the follow loop re-plots while the card moves',
     inst.indexOf('_forecastFollowRaf') > 0, true);
  eq('and it is armed on hover', inst.indexOf('_forecastStartFollow') > 0, true);
});

// ---- run ----------------------------------------------------
__cases.forEach(function (c) {
  __caseFailed = false; __caseMsgs = [];
  try { c.fn(); } catch (e) {
    __caseFailed = true;
    __caseMsgs.push('threw: ' + (e && e.message ? e.message : String(e)));
  }
  if (__caseFailed) { __failed++; __failures.push({ name: c.name, msgs: __caseMsgs.slice(0, 5) }); }
  else __passed++;
});
print('forecast-batch: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
