// ============================================================
// GRAPHICS BUDGET — static. What does an idle board cost per frame?
//
//   jsc sim/gfx-budget.js -- [--verbose]
//
// An infinite CSS animation that touches only `transform` / `opacity` is handed
// to the compositor and is close to free. One that touches `filter`,
// `box-shadow`, `background-position`, `color` or `text-shadow` REPAINTS its
// element every frame for as long as it runs — and "as long as it runs" is the
// whole match. Several of them run once PER CARD, so the bill grows with every
// body that lands. That is what "after round 6 the game lags" was: nothing got
// slower, there was just more of it.
//
// Measured in Chrome on a representative 10-card board, before the fx-lean tier
// existed: FULL ran 48 infinite animations, ~30 of them repainting every frame;
// REDUCED ran 0. Two positions with a cliff between them, and the only way to
// stop a 0.6s text flash repeating on twelve cards was to accept Reduced, which
// also flattens the entire 3D card stack.
//
// So this audit pins the rule that replaced it: EVERY infinite animation whose
// keyframes repaint or relayout must be switched off (or swapped for a
// compositor-only variant) at the Normal tier — `body.fx-lean`, which Reduced
// inherits. A new one arrives un-gated and this fails, with the selector.
//
// grep cannot do this: keyframes are multi-line, a shorthand `animation:` can
// wrap across lines, and a comment that closes early takes the rule below it
// with it. So the sheet is parsed.
// ============================================================

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

var SRC = read('style.css');

// Blank comments out rather than deleting them, so every reported line number
// still matches the real file.
function strip(s) {
  var o = '', i = 0;
  while (i < s.length) {
    var a = s.indexOf('/*', i);
    if (a < 0) { o += s.slice(i); break; }
    o += s.slice(i, a);
    var b = s.indexOf('*/', a + 2);
    if (b < 0) { o += s.slice(a).replace(/[^\n]/g, ' '); break; }
    o += s.slice(a, b + 2).replace(/[^\n]/g, ' ');
    i = b + 2;
  }
  return o;
}
var CSS = strip(SRC);
var LINES = CSS.split('\n');

// ---- every @keyframes block, by brace matching ----
function keyframeBlocks(s) {
  var out = {}, re = /@(?:-webkit-)?keyframes\s+([A-Za-z0-9_-]+)\s*\{/g, m;
  while ((m = re.exec(s))) {
    var i = m.index + m[0].length, depth = 1, start = i;
    while (i < s.length && depth > 0) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') depth--;
      i++;
    }
    out[m[1]] = s.slice(start, i - 1);
  }
  return out;
}
var KF = keyframeBlocks(CSS);

var CHEAP  = /^(transform|opacity|visibility|-webkit-transform|offset-distance|animation-timing-function)$/;
var LAYOUT = /^(width|height|top|left|right|bottom|margin|padding|inset|font-size|letter-spacing|line-height|gap|flex)/;

function propsOf(body) {
  var p = {}, re = /(^|[;{\s])(-?[a-zA-Z][-a-zA-Z]*)\s*:/g, m;
  while ((m = re.exec(body))) p[m[2]] = true;
  return Object.keys(p);
}
function costOf(name) {
  var props = propsOf(KF[name] || '');
  var layout = props.filter(function (p) { return LAYOUT.test(p); });
  var paint  = props.filter(function (p) { return !CHEAP.test(p) && !LAYOUT.test(p); });
  return { layout: layout, paint: paint, costly: !!(layout.length || paint.length) };
}

// ---- every rule that starts an infinite animation, with its selector ----
// The shorthand legitimately wraps (`animation: a 4s infinite,\n  b 3s infinite`),
// so declarations are read to the semicolon rather than to the newline.
var rules = [];
(function () {
  var re = /animation(?:-name)?\s*:([^;{}]*)[;}]/g, m;
  while ((m = re.exec(CSS))) {
    var value = m[1];
    if (!/\binfinite\b/.test(value)) continue;
    // Walk back to this declaration's rule head.
    var head = CSS.lastIndexOf('{', m.index);
    if (head < 0) continue;
    var prevEnd = Math.max(CSS.lastIndexOf('}', head), CSS.lastIndexOf('{', head - 1));
    var sel = CSS.slice(prevEnd + 1, head).trim().replace(/\s+/g, ' ');
    if (!sel || sel.indexOf('@') === 0 || /^\d/.test(sel)) continue;   // inside @keyframes
    rules.push({
      sel: sel,
      value: value.replace(/\s+/g, ' ').trim(),
      line: CSS.slice(0, m.index).split('\n').length,
    });
  }
})();

// Which keyframe names does a value reference?
function kfNames(value) {
  return Object.keys(KF).filter(function (n) {
    return new RegExp('(^|[\\s,])' + n.replace(/-/g, '\\-') + '($|[\\s,])').test(value);
  });
}

// ---- is this selector switched off at the Normal tier? ----
// A rule counts as gated when the sheet ALSO contains a `body.fx-lean`-scoped
// rule naming the same target, or when the rule is already scoped to fx-lean /
// low-fx itself. Matching on the target's last compound keeps this honest about
// descendant selectors without trying to reimplement selector matching.
var leanTargets = [];
(function () {
  var re = /animation(?:-name)?\s*:([^;{}]*)[;}]/g, m;
  while ((m = re.exec(CSS))) {
    var head = CSS.lastIndexOf('{', m.index);
    if (head < 0) continue;
    var prevEnd = Math.max(CSS.lastIndexOf('}', head), CSS.lastIndexOf('{', head - 1));
    var sel = CSS.slice(prevEnd + 1, head).trim().replace(/\s+/g, ' ');
    if (sel.indexOf('fx-lean') < 0) continue;
    sel.split(',').forEach(function (part) { leanTargets.push(part.trim()); });
  }
})();
// The mobile block turns the same list off by media query; a rule covered there
// is already lean on the devices that need it, but NOT on a laptop, so it does
// not count as gated on its own.
function lastCompound(sel) {
  var parts = sel.split(/[\s>+~]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : sel;
}
// Compare the TARGET, not the gate. `body.fx-lean::before` gates `body::before`
// — the tier class is part of the gate and has to come off before the two can
// be recognised as the same element, or every body-level rule reads as ungated.
function normalizeTarget(sel) {
  return lastCompound(sel.replace(/\.fx-lean/g, '').replace(/\.low-fx/g, '').trim());
}
function gatedAtNormal(sel) {
  if (sel.indexOf('fx-lean') >= 0 || sel.indexOf('low-fx') >= 0) return true;
  var want = normalizeTarget(sel);
  for (var i = 0; i < leanTargets.length; i++) {
    if (normalizeTarget(leanTargets[i]) === want) return true;
  }
  return false;
}

// ---- KEEP LIST ----
// Loops that repaint and are deliberately left running at Normal, each with the
// reason. A SIGNAL may cost something; ambience may not. Anything added here
// should be a thing the player needs to notice.
var KEEP = {
  'hpCriticalPulse':    'about to die — the one loop the player must not miss',
  'hpLethalWarn':       'lethal on the board next combat',
  'hpDamagedPulse':     'the HP number after a hit',
  'critical-pulse':     'a card one hit from dying',
  'lethalPulse':        'lethal marker',
  'promptPulse':        'a prompt is waiting on YOU — the table is blocked until it is answered',
  'dbStartPulse':       'menu only — never on a board',
  'dbReadyPulse':       'menu only — never on a board',
  'draftMulliganPulse': 'draft only — never on a board',
  'tut-pulse':          'tutorial only',
  'updateBannerPulse':  'a new build is waiting; menu-level, one element',
  'themeSwatchLockPulse': 'settings only',
  'gameOverScan':       'the game-over screen; the match is over',
  'gameOverRestorePulse': 'game-over screen only',
  'peekRestorePulse':   'menu only',
  'aiThinkingRing':     'the AI is thinking — bounded to that wait, one element',
  'selectedCardPulse':  'the card YOU have picked up, one element at a time',
  'tronTargetPulseBig': 'a live targeting prompt, one element at a time',
  'targetRipple':       'a live targeting prompt',
  'mcTargetPulse':      'a live targeting prompt',
  'tronTubePulse':      'the frame of a card being targeted',
  'tronCirclePulse':    'a live targeting prompt',
  'previewHpPulse':     'the damage preview under the cursor — transient by nature',
  'hudHeartbeat':       'gated at fx-lean by selector, not by name',
  // Live targeting and prompts — one element at a time, and the whole point is
  // that you cannot miss it. A signal may cost something; ambience may not.
  'ironManKillPreviewPulse': 'the damage preview under YOUR cursor — gone the moment you move',
  'cardTargetFramePulse':    'the card a live targeting prompt is offering',
  'cardTargetHaloPulse':     'the slot a live targeting prompt is offering',
  'doneNudge':               'you are the one holding the table up',
  'moder-forced-pulse':      'a forced choice is waiting on you',
  // Screens, not boards. None of these can be on-screen during a match, so
  // they cost nothing while the game is being played.
  'rl-mapnode-halo-pulse':   'roguelite map screen — never on a board',
  'curseTileGlow':           'roguelite choice screen — never on a board',
  'choice-player-breathe':   'the choice screen — never on a board',
};

var costlyInfinite = [], ungated = [], gated = [], kept = [];
rules.forEach(function (r) {
  kfNames(r.value).forEach(function (n) {
    var c = costOf(n);
    if (!c.costly) return;
    var row = { name: n, sel: r.sel, line: r.line, paint: c.paint, layout: c.layout };
    costlyInfinite.push(row);
    // Gated FIRST: a loop that Normal actually switches off is the outcome this
    // audit wants, and counting it as "kept" would flatter the KEEP list into
    // looking like it carries work it does not.
    if (gatedAtNormal(r.sel)) { gated.push(row); return; }
    if (KEEP[n]) { kept.push(row); return; }
    ungated.push(row);
  });
});

print('=== GRAPHICS BUDGET — the idle, per-frame bill ===');
print('  keyframes in the sheet                         : ' + Object.keys(KF).length);
print('  rules starting an INFINITE animation           : ' + rules.length);
print('  ...whose keyframes REPAINT or RELAYOUT a frame : ' + costlyInfinite.length);
print('     switched off at Normal (body.fx-lean)       : ' + gated.length);
print('     kept on purpose — signals, or menu-only     : ' + kept.length);
print('     UNGATED at Normal                           : ' + ungated.length);
if (VERBOSE) {
  print('');
  print('  every repainting infinite loop, and whether Normal stops it:');
  costlyInfinite.forEach(function (r) {
    var why = KEEP[r.name] ? 'KEPT  (' + KEEP[r.name] + ')'
            : gatedAtNormal(r.sel) ? 'lean' : 'UNGATED';
    print('    ' + (r.name + '                          ').slice(0, 26)
      + (why + '        ').slice(0, 8) + '  ' + r.sel.slice(0, 70));
  });
}
if (ungated.length) {
  print('');
  print('  FAIL — these repaint every frame for the whole match and Normal does');
  print('  not stop them. Either switch the selector off under body.fx-lean (or');
  print('  give it a compositor-only variant the way the vibes have), or add the');
  print('  keyframe to the KEEP list at the top of this file with the reason a');
  print('  player needs to see it.');
  ungated.forEach(function (r) {
    print('    style.css:' + r.line + '  ' + r.name
      + '  [' + r.paint.concat(r.layout).join(',') + ']');
    print('        ' + r.sel.slice(0, 100));
  });
}
print('');
print(ungated.length ? '❌ GRAPHICS BUDGET FAILED' : '✅ GRAPHICS BUDGET OK — nothing repaints every frame at Normal');
if (ungated.length) throw new Error('graphics budget: ' + ungated.length + ' ungated per-frame loops');
