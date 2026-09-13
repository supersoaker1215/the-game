// ============================================================
// EVERYTHING ON THE RIGHT OF THE BOARD IS ONE STACK.
//
//   jsc sim/gutter-stack.js
//
// Owner, over three screenshots of the right-hand gutter: "there should be no
// overlap the art should fit in the box ... the shadow man leaderboard is
// getting cut off, and the evts tab should be stapled into the bo[ard] cant be
// moved ... i cant see the play or keep button unless my screen is bigger it
// all needs to fit on the right side of the board."
//
// The gutter had TWO stacking systems in one strip. #right-col docked the event
// rail and the Shadow Man scoreboard as flow children; #classic-decision, the
// trick reveal and the notice toast were fixed-positioned into three "bands"
// that were designed before that column existed and never accounted for it.
// Measured in a live match at 1280x720:
//
//     reveal card over #right-col ............ 78 x 280 px
//     reveal card over the scoreboard ........ 102 x 164 px
//     decision panel over #right-col ......... 184 x 261 px  (its whole width)
//     scoreboard past the column's right edge . 24 px, clipped by overflow:hidden
//     Play Free / Keep below the visible bottom  89 px
//
// The column's own comment already had the answer for this class of bug — "They
// are flow children of one column now. Overlap is not tuned here — it is
// impossible" — so the fix was to finish the job: the decision panel and the
// reveal dock into the same column, and the four occupants get an explicit
// priority instead of fighting over one strip.
//
// This suite pins the structural invariants. The pixel results are in the commit
// message; what a future edit would break by accident is the plumbing.
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

var UISRC  = read('ui.js');
var CSSSRC = read('style.css');

function decomment(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); })
          .replace(/\/\/[^\n]*/g, '');
}
var CSS = decomment(CSSSRC);

// Balance braces so a nested block cannot end the slice early.
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
// EXACT SELECTOR, NOT SUBSTRING. `#right-col` is a substring of
// `#right-col > .trick-reveal .trick-reveal-card`, so a contains-match walked
// past the rule under test and read a completely different one — it reported
// the column had no `--decision-w` width while the file plainly did. Compare
// against the comma-separated members of each selector list instead.
function selectorHas(list, sel) {
  var parts = list.split(',');
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].replace(/\s+/g, ' ').trim() === sel) return true;
  }
  return false;
}
// The LAST rule for that exact selector — later wins at equal specificity, and a
// first-hit grep is the trap card-tube.js records.
function lastRuleFor(sel) {
  var re = /([^{}]+)\{([^{}]*)\}/g, m, found = null;
  while ((m = re.exec(CSS)) !== null) {
    if (!selectorHas(m[1], sel)) continue;
    found = m[2].replace(/\s+/g, ' ').trim();
  }
  return found;
}
// ...and the last one that actually sets `prop`, for a property split across
// several rules for the same selector.
function ruleWith(sel, prop) {
  var re = /([^{}]+)\{([^{}]*)\}/g, m, found = null;
  while ((m = re.exec(CSS)) !== null) {
    if (!selectorHas(m[1], sel)) continue;
    if (m[2].indexOf(prop) < 0) continue;
    found = m[2].replace(/\s+/g, ' ').trim();
  }
  return found;
}

t('GS-1 the gutter is ONE width, and it is the one the board reserved', function () {
  // #right-col carried a hard 184px while the decision panel in the same strip
  // used --decision-w, the width _fitBoardToViewport solves and lays the lanes
  // out around. Two widths for one column is how a 208px scoreboard ended up
  // inside a 184px box with overflow:hidden.
  var body = ruleWith('#right-col', 'width:');
  eq('#right-col sets a width', !!body, true);
  eq('and it reads --decision-w', /width:\s*var\(--decision-w/.test(body), true);
  eq('not a literal px width', /width:\s*\d+px/.test(body), false);
  eq('the solver still publishes it', UISRC.indexOf('--decision-w') > 0, true);
});

t('GS-2 the docked scoreboard drops its own min-width', function () {
  // `width: 100%` cannot beat `min-width: calc(208px * var(--sh-scale))` —
  // min-width wins over width, which is why the dock rule looked right and the
  // ENEMY column was still cut off.
  // Query by PROPERTY: this selector is set by two rules — the dock rule and the
  // one-line priority rule further down — and lastRuleFor would read the latter.
  var w = ruleWith('#right-col > .shadow-tracker', 'width:');
  eq('the dock rule exists', !!w, true);
  eq('it sizes to the column', /[^-]width:\s*100%\s*!important/.test(w), true);
  eq('AND releases the authored min-width', /min-width:\s*0\s*!important/.test(w), true);
  eq('the authored min-width is still there to be released',
     /min-width:\s*calc\(208px\s*\*\s*var\(--sh-scale/.test(CSS), true);
});

t('GS-3 the column is stapled — nothing drags it', function () {
  var wire = decomment(methodBody('_wireShadowTracker'));
  eq('_wireShadowTracker still exists', wire.length > 60, true);
  eq('no pointermove drag is wired', wire.indexOf('pointermove') < 0, true);
  eq('and the title bar is not a handle', wire.indexOf('sh-title') < 0, true);
  eq('the resize button still works', wire.indexOf('sh-size') > 0, true);
  // ...and a drag saved before this change must not be re-asserted forever.
  var box = decomment(methodBody('_applyRightColBox'));
  eq('_applyRightColBox no longer writes a position',
     /col\.style\.left\s*=\s*box\.x/.test(box), false);
  eq('and it clears a stored one', /delete box\.x/.test(box), true);
  eq('the title no longer advertises a drag', UISRC.indexOf('title="Drag to move"') < 0, true);
});

t('GS-4 the reveal and the decision panel dock into that same column', function () {
  // Both used to be fixed-positioned over it. A flow child cannot cover a
  // sibling, which is the whole argument for the column.
  var home = decomment(methodBody('_revealHome'));
  eq('_revealHome exists', home.length > 40, true);
  eq('it returns the column', home.indexOf("getElementById('right-col')") > 0, true);
  eq('only in classic decision-column mode', /decision-column/.test(home) && /board-v2/.test(home), true);
  eq('and the reveal is mounted through it',
     /this\._revealHome\(\)\.appendChild\(wrap\)/.test(UISRC), true);
  eq('the reveal no longer mounts to the body',
     /document\.body\.appendChild\(wrap\)/.test(UISRC), false);
  var slot = decomment(methodBody('_classicDecisionSlot'));
  eq('the decision panel asks for the column too', slot.indexOf('_rightColumn') > 0, true);
  eq('and adopts a panel built before the column existed',
     /panel\.parentNode\s*!==\s*host/.test(slot), true);
  // Docked, it must not keep its own fixed anchor.
  var dock = ruleWith('#right-col > #classic-decision', 'position:');
  eq('the docked panel is static', !!dock && /position:\s*static\s*!important/.test(dock), true);
});

t('GS-5 the column carries the layer the panel used to hold', function () {
  // The decision panel sat at z-index 500 precisely so it cleared the three rows
  // below the board (210/220/230). Docking it into a column at 180 would have
  // put a live prompt under the hand.
  var body = ruleWith('#right-col', 'z-index');
  eq('#right-col sets a z-index', !!body, true);
  eq('and it is the panel\'s old one', /z-index:\s*500/.test(body), true);
});

t('GS-6 the four occupants have an explicit priority', function () {
  // Left to shrink proportionally, the flex algorithm gave the scoreboard 39px —
  // the clipping complaint in a new place. Measured outcomes are in the commit.
  eq('the panel absorbs',
     /#right-col > #classic-decision \{ flex: 0 1 auto; min-height: min\(\d+px, 100%\); \}/.test(CSS), true);
  eq('the scoreboard does not shrink at all',
     /#right-col > \.shadow-tracker\s+\{ flex: 0 0 auto; \}/.test(CSS), true);
  eq('the reveal and the rail give first',
     /#right-col > \.trick-reveal,\s*#right-col > #event-rail\s+\{ flex: 0 1 auto; min-height: 0; \}/.test(CSS), true);
});

t('GS-7 the answer is always on screen', function () {
  // The height chain has to be definite the whole way down or `max-height: 100%`
  // on the panel measures 100% of "as tall as my content" and caps nothing.
  var wrap = lastRuleFor('#classic-decision #block-trick-modal');
  eq('the docked modal wrapper is bounded',
     !!wrap && /max-height:\s*100%\s*!important/.test(wrap) && /min-height:\s*0\s*!important/.test(wrap), true);
  var slot = ruleWith('#classic-decision .cd-slot', 'flex:');
  eq('and so is the slot above it',
     !!slot && /flex:\s*1 1 auto/.test(slot) && /min-height:\s*0/.test(slot), true);
  var panel = ruleWith('#classic-decision .floating-prompt-panel', 'max-height');
  eq('the panel caps at its slot', !!panel && /max-height:\s*100%\s*!important/.test(panel), true);
  var choices = ruleWith('#classic-decision .fp-choices', 'flex:');
  eq('the choices are pinned outside what scrolls',
     !!choices && /flex:\s*0 0 auto\s*!important/.test(choices), true);
  var prev = ruleWith('#classic-decision .fp-trick-preview', 'min-height');
  eq('the card keeps a floor rather than collapsing to a sliver',
     !!prev && /min-height:\s*min\(\d+px, 100%\)\s*!important/.test(prev), true);
  eq('and it is the part that scrolls', /overflow-y:\s*auto\s*!important/.test(prev), true);
});

// ---- run ----------------------------------------------------
// ---- GS-8 A TEXT DECISION IS TEXT -------------------------------------------
// Owner, circling a scrolling decision column holding The Flash's two
// first-player options: "there should be no scrooll fit it the cards are too
// big for those decsins its jsut text no cards."
//
// Measured on that prompt: each option was a 190px card-shaped tile carrying a
// 34px name plate and a .card-desc stretched to 108.8px to hold 26.1px of
// sentence, plus a separate 44px PICK button. 242px per option, and the panel
// scrolled by 103px inside a gutter with no room to give. After: 51px per
// option, panel scrolls by 0.
t('GS-8 a pure-text option renders as a button, not a card tile', function () {
  var src = decomment(UISRC);
  eq('the branch exists', /isPlainText/.test(src), true);
  eq('it emits a button, not a .choice-card', /class="choice-text-opt"/.test(src), true);
  // The three action tiles that carry real art must NOT be collapsed: the
  // Voldemort curses (coloured lightning), Art the Clown's weapons (neon
  // glyph), and the "which player?" seat tiles (the name IS the decision).
  var cond = (src.match(/const isPlainText =[^;]*;/) || [''])[0];
  eq('curse tiles excluded',  /!curseColor/.test(cond), true);
  eq('weapon tiles excluded', /!card\._artWeaponKey/.test(cond), true);
  eq('player tiles excluded', /!card\._isPlayerTile/.test(cond), true);
  eq('and anything with stats or a cost', /!stats/.test(cond) && /!costHtml/.test(cond), true);
});

t('GS-9 the text option is pickable through the one existing door', function () {
  var src = decomment(UISRC);
  var branch = (src.match(/if \(isPlainText\)[\s\S]*?\n      \}/) || [''])[0];
  eq('found the branch', branch.length > 40, true);
  // [data-idx] is already delegated to cardChoicePick. Carrying data-pick as
  // well would bind a SECOND listener to the same button and pick twice.
  eq('carries data-idx', /data-idx=/.test(branch), true);
  eq('and not a second data-pick door', /data-pick=/.test(branch), false);
});

t('GS-10 the stacking override beats the !important grid it overrides', function () {
  // The decision column forces `display: grid !important` with an auto-fit
  // track list sized for card portraits. A normal declaration loses to it no
  // matter how specific, so the text rule has to be !important too — and it is
  // written directly beneath what it overrides rather than 36,000 lines away,
  // which is how a correct rule ends up dead. (See [[css-audit-traps]].)
  var m = CSS.match(/#classic-decision \.choice-tray-cards:has\(\.choice-opt-text\)\s*\{([^}]*)\}/);
  eq('the override exists', !!m, true);
  eq('it is !important', !!m && /display:\s*flex\s*!important/.test(m[1]), true);
  eq('and stacks them', !!m && /flex-direction:\s*column/.test(m[1]), true);
  // It must come AFTER the grid rule in source order, so equal-weight
  // declarations resolve its way too.
  var gridAt = CSS.indexOf('#classic-decision .choice-tray-cards {');
  var overAt = CSS.indexOf('#classic-decision .choice-tray-cards:has(.choice-opt-text)');
  eq('and is authored after it', gridAt >= 0 && overAt > gridAt, true);
});

// ---- GS-11 ONE ANNOUNCEMENT PER TRICK ---------------------------------------
// Owner, on a screenshot of the Bacta Tank reveal with a text notice painted
// across it: "also no overlapping the art says it all no notice needed, have
// the art stay for 7 seconds though so you know whit a little bar timer."
//
// playTrick calls UI.showTrickReveal for EVERY trick and carries its own `else`
// fallback to the toast. A ui.js wrapper around Game.playTrick fired a SECOND
// toast for AI tricks — written before the centre reveal existed, when a trick
// had no card to look at. The two ran on different clocks (the reveal queue and
// UI._stage do not serialise against each other), so they landed on screen
// together rather than one after the other.
t('GS-11 the playTrick wrapper no longer raises its own toast', function () {
  var src = decomment(UISRC);
  // NOT by slicing "the wrapper": ui.js wraps Game.playTrick TWICE (once for
  // the play SFX, once — formerly — for this toast), and a non-greedy slice
  // from the first one runs 9,268 characters into unrelated code and reports
  // whatever it finds there. A constant error = a wrong reference, again.
  // The call itself is unique, so assert on the call.
  eq('the opponent-trick toast is gone',
     /showAITrickToast\(`\$\{UI\.oppName\(\)\} played/.test(src), false);
  eq('and no toast is raised from a playTrick wrapper at all',
     /Game\.playTrick = [\s\S]{0,400}?showAITrickToast/.test(src), false);
  // ...and the engine's own door still does, so nothing was simply deleted.
  var engine = read('game.js');
  eq('playTrick still reveals every trick',
     /UI\.showTrickReveal\(trick\.name, trick\.desc \|\| '', trick\.cost, owner === 'player'\)/.test(engine), true);
});

t('GS-12 the reveal holds for seven seconds, and says how long is left', function () {
  var src = decomment(UISRC);
  eq('seven seconds', /TRICK_NOTICE_MS:\s*7000/.test(src), true);
  var body = decomment(methodBody('_nextTrickReveal'));
  eq('one number for both', /const hold = item\.holdMs \|\| 2100;/.test(body), true);
  eq('the bar is driven by it', /animation-duration:\$\{hold\}ms/.test(body), true);
  eq('and the dismissal too', /\}, hold\);/.test(body), true);
  // A bar that animates width relayouts every frame over card art.
  var bar = CSS.match(/\.trick-reveal \.tr-timer > i\s*\{([^}]*)\}/);
  eq('the bar exists', !!bar, true);
  eq('it names the drain animation', !!bar && /animation-name:\s*trickRevealDrain/.test(bar[1]), true);
  eq('and it is linear, so the bar tracks real time',
     !!bar && /animation-timing-function:\s*linear/.test(bar[1]), true);
  // The KEYFRAMES are the thing that must not animate width — a width
  // animation relayouts every frame on an element sitting over card art.
  // (The static `width: 100%` on the bar itself is the box, not the motion.)
  var kf = CSS.match(/@keyframes trickRevealDrain\s*\{([\s\S]*?)\}\s*\n/);
  eq('the keyframes exist', !!kf, true);
  eq('they scale, they do not resize', !!kf && /scaleX\(0\)/.test(kf[1]) && !/width/.test(kf[1]), true);
});

__cases.forEach(function (c) {
  __caseFailed = false; __caseMsgs = [];
  try { c.fn(); } catch (e) {
    __caseFailed = true;
    __caseMsgs.push('threw: ' + (e && e.message ? e.message : String(e)));
  }
  if (__caseFailed) { __failed++; __failures.push({ name: c.name, msgs: __caseMsgs.slice(0, 5) }); }
  else __passed++;
});
print('gutter-stack: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
