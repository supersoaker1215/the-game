// ============================================================
// THE MAIN MENU FITS ON ONE SCREEN.
//
//   jsc sim/menu-fits.js
//
// Owner: "the main menu shouldnt have a scroll bar as it should fit all on 1
// screen."
//
// The diagnosis was not where it looked. .mm-panel measured 974px in an 876px
// viewport, so the obvious story was "the panel is too tall" — and it was, but
// fixing that alone still left a scrollbar. The overlay adds its own
// padding-top 40 + padding-bottom 60, so the quantity that has to fit is
// panel + 100, not panel. That padding is why the menu scrolled even at
// 1920x1080, where the panel had 48px of slack.
//
// It also produced a convincing false lead: hiding .mm-heropick made the
// overflow go to zero, which reads as "the hero picker is the problem". It was
// not. Removing it just shortened the panel enough to absorb the padding. A
// component whose removal fixes a symptom is not thereby the cause.
//
// Measured after the fix — scrollbar height, every viewport:
//   640:0  700:0  720:0  800:0  876:0  982:0  1080:0  1440:0
// ============================================================

var CSS = read('style.css');
var BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });

var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

// ---- 1. the overlay's own padding must scale, not be a fixed slab ----------
// Find the LAST (and therefore winning, at equal-or-greater specificity)
// vertical padding declared for the menu overlay.
var padRe = /\.main-menu-overlay[^{}]*\{([^{}]*)\}/g, m, lastPadBlock = null, lastSel = null;
while ((m = padRe.exec(BARE))) {
  if (/padding-(top|bottom)\s*:/.test(m[1])) {
    lastPadBlock = m[1];
    lastSel = BARE.slice(m.index, m.index + m[0].indexOf('{')).trim();
  }
}
check('the overlay declares vertical padding somewhere', !!lastPadBlock);
if (lastPadBlock) {
  check('the winning overlay padding is viewport-relative, not a fixed slab',
        /padding-(top|bottom)\s*:\s*var\(--mm-vr\)/.test(lastPadBlock),
        'last padding rule is `' + lastSel + '` and reads: ' +
        lastPadBlock.replace(/\s+/g, ' ').trim().slice(0, 90));
}

// ---- 2. the rhythm tokens exist and are height-driven ----------------------
['--mm-vr', '--mm-vr-sm', '--mm-opt-pad'].forEach(function (tok) {
  var re = new RegExp(tok.replace(/-/g, '\\-') + '\\s*:\\s*clamp\\([^;]*vh[^;]*\\)');
  check(tok + ' is a vh-driven clamp', re.test(BARE),
        'not found as clamp(... vh ...) — a fixed value only moves the breakpoint');
});

// ---- 3. the pieces sized off vw ALONE are the ones that broke short windows -
// 4.4vw on a 1280x720 screen is a 56px title; the panel spent 100px on the
// wordmark before any content existed. Each of these must be capped against vh.
[['.mm-mw3 .mm-title', 'font-size'],
 ['.mm-mw3 .mm-option-icon', 'width']].forEach(function (pair) {
  var sel = pair[0], prop = pair[1];
  var re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^{}]*)\\}', 'g');
  var hit = null, mm;
  while ((mm = re.exec(BARE))) if (new RegExp(prop + '\\s*:').test(mm[1])) hit = mm[1];
  check(sel + ' caps ' + prop + ' against vh, not vw alone',
        !!hit && /min\(\s*[\d.]+vw\s*,\s*[\d.]+vh\s*\)/.test(hit),
        hit ? 'reads: ' + hit.replace(/\s+/g, ' ').trim().slice(0, 80) : 'no rule found');
});

// ---- 4. and the short-viewport step, which is what lands 640-720 -----------
check('a short-viewport step tightens the same tokens',
      /@media\s*\(max-height:\s*760px\)[\s\S]{0,600}--mm-opt-pad/.test(BARE),
      'no (max-height: 760px) block re-declaring the rhythm tokens');

print('menu-fits: ' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) { print('Failures:'); fails.forEach(function (f) { print('  - ' + f); }); }
