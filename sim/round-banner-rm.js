// ============================================================
// "ROUND N" STILL SHOWS UNDER REDUCED MOTION.
//
//   jsc sim/round-banner-rm.js
//
// roundBannerReveal begins and ends at opacity 0; the reduced-motion
// catch-all sets every animation to 0.01ms !important (snap to the end frame),
// so the banner was invisible for anyone with reduce-motion on. Now a
// fade-in / hold / fade-out with its own !important duration. Pins the cascade.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var CSS = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('')).replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
check('the catch-all still snaps animations to 0.01ms (premise)', /animation-duration:\s*0\.01ms\s*!important/.test(CSS));
var m = /@keyframes roundBannerReveal \{([\s\S]*?)\n\}/.exec(CSS);
check('the normal reveal starts and ends invisible (why it vanished)', !!m && /0%\s*\{\s*opacity:\s*0/.test(m[1]) && /100%\s*\{\s*opacity:\s*0/.test(m[1]));
var rm = /@media \(prefers-reduced-motion: reduce\) \{\s*\.round-banner\.active \{([^}]*)\}/.exec(CSS);
check('reduced motion gives the banner its own animation', !!rm && /animation:\s*roundBannerFade/.test(rm[1]));
check('…with an !important duration that beats the catch-all', !!rm && /animation-duration:\s*1\.6s\s*!important/.test(rm[1]));
var f = /@keyframes roundBannerFade \{([\s\S]*?)\n\}/.exec(CSS);
check('…that holds the banner fully visible', !!f && /85%\s*\{\s*opacity:\s*1/.test(f[1]) && /10%\s*\{\s*opacity:\s*1/.test(f[1]));
check('…and keeps it centred (no zoom)', !!f && !/scale/.test(f[1]) && /translate\(-50%, -50%\)/.test(f[1]));
print('round-banner-rm: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (x) { print('  FAIL  ' + x); });
if (fails.length) throw new Error('round-banner-rm failed');
