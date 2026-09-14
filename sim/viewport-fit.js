// ============================================================
// THE LAYOUT RE-SOLVES WHEN THE VIEWPORT CHANGES — ON EVERY DEVICE.
//
//   jsc sim/viewport-fit.js
//
// The hand, the draft and the board each solve their size against the viewport,
// and each had a resize listener to re-solve when it moved. All three listeners
// were registered inside _installCombatForecast — which returns early on
// anything without a fine hover pointer:
//
//     _installCombatForecast()
//       …(hover: hover) and (pointer: fine) …  -> return     at offset  261
//       window.addEventListener('resize', … _fitHandToViewport …)   offset 2662
//
// So on a PHONE OR TABLET they were never registered at all. Rotating the
// device, or the URL bar sliding away — a real viewport-height change on
// mobile, and a frequent one — left all three solved against a viewport that
// no longer existed.
//
// The note above _installPortraitSnap had already spotted exactly this, and
// said why it installed itself unconditionally rather than joining them: "art
// framing is not a desktop affordance — a phone rotating is exactly the resize
// that matters most." That is just as true of the layout the art sits in.
//
// Measured after, on a 375x812 touch profile (matchMedia fine-pointer false):
// a resize fires all three, and an orientationchange fires all three twice —
// the rAF pass and the 250ms settle tail.
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
function decomment(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); })
          .replace(/\/\/[^\n]*/g, '');
}
// Balance braces so a nested block cannot end the slice early.
function methodBody(name) {
  var open = UISRC.indexOf('\n  ' + name + '(');
  if (open < 0) return '';
  var brace = UISRC.indexOf('{', open);
  if (brace < 0) return '';
  var depth = 0;
  for (var i = brace; i < UISRC.length; i++) {
    if (UISRC[i] === '{') depth++;
    else if (UISRC[i] === '}') { depth--; if (!depth) return UISRC.slice(brace, i + 1); }
  }
  return '';
}

var FITS = ['_fitHandToViewport', '_fitDraftToViewport', '_fitBoardToViewport'];

t('VF-1 the forecast installer still refuses a device with no hover', function () {
  // Not a complaint about the gate — the forecast IS a pointer affordance and
  // the gate is right. It is the reason nothing else may be parked behind it.
  var body = decomment(methodBody('_installCombatForecast'));
  eq('found the installer', body.length > 400, true);
  eq('it gates on a fine hover pointer', /\(hover: hover\) and \(pointer: fine\)/.test(body), true);
  eq('and returns when there is none', /matches\)\) return;/.test(body), true);
});

t('VF-2 …so no viewport fit is registered behind it', function () {
  var body = decomment(methodBody('_installCombatForecast'));
  FITS.forEach(function (fn) {
    eq(fn + ' is not installed there', body.indexOf(fn) === -1, true);
  });
});

t('VF-3 they live in an installer with no device gate at all', function () {
  var body = decomment(methodBody('_installViewportFit'));
  eq('the installer exists', body.length > 200, true);
  FITS.forEach(function (fn) {
    eq('it re-solves ' + fn, body.indexOf(fn) !== -1, true);
  });
  eq('on resize',            /addEventListener\('resize'/.test(body), true);
  // A PHONE ROTATING is the resize that matters most, and it is the one event
  // some browsers deliver differently — _installPortraitSnap listens for both
  // for the same reason.
  eq('and on orientationchange', /addEventListener\('orientationchange'/.test(body), true);
  eq('with no pointer gate', /pointer: fine|hover: hover/.test(body), false);
  // Coalesced: mobile fires resize in a stream while the URL bar animates, and
  // each of these solves its width inside its own rAF, so one frame after the
  // last event is not always the settled size.
  eq('coalesced on a frame', /requestAnimationFrame/.test(body), true);
  eq('with a settle tail',   /setTimeout\(run, 250\)/.test(body), true);
});

t('VF-4 and it is actually called, next to the one that already knew better', function () {
  var src = decomment(UISRC);
  eq('installed', /this\._installViewportFit\(\);/.test(src), true);
  // Ordering is not load-bearing, but sitting beside _installPortraitSnap is:
  // that is the installer whose own comment diagnosed this problem and worked
  // around it alone.
  eq('beside the portrait snap',
     /_installViewportFit\(\);\s*\n\s*this\._installPortraitSnap\(\);/.test(src), true);
  eq('and only once', (src.match(/this\._installViewportFit\(\);/g) || []).length, 1);
  var body = decomment(methodBody('_installViewportFit'));
  eq('guarded against double-install', /_viewportFitInstalled/.test(body), true);
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
print('viewport-fit: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
