// ============================================================
// FULL-SCREEN HERO CROPS KEEP THE WHOLE HEAD.
//
//   jsc sim/hero-crop.js
//
// Owner: "a lot of the cards need to be recropped to fit the entire heads and
// some room on top of the characters art". Before: the title framed every
// un-cropped hero from the CENTRE (Luke Skywalker's head cut at the brow).
// After: top-anchored, keeping the hand-set horizontal position; a short list
// of low-subject / composition-led art keeps its original framing, and a
// Gallery Audit crop always wins.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var SRC = read('ui.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

var keepMap = UI._artFocalMap, keepFor = UI._artFocalFor;
var local = {}, repo = {};
UI._artFocalMap = function () { return local; };
UI._artFocalFor = function (n, f) { return local[n + '|' + f] || repo[n + '|' + f] || ''; };

check('an un-cropped hero is top-anchored (Luke)', UI._heroFocal('Luke Skywalker', 'Luke.jpg', '50%') === '50% 0%', UI._heroFocal('Luke Skywalker', 'Luke.jpg', '50%'));
check('…at the caller\'s default x (menu side art)', UI._heroFocal('Luke Skywalker', 'Luke.jpg', '72%', '72% 26%') === '72% 0%');
repo['Batman|Batman.jpg'] = '40% 50%';
check('a hand crop keeps its x, loses its mid y', UI._heroFocal('Batman', 'Batman.jpg', '50%') === '40% 0%');
repo['Ghostface|G.jpg'] = '82% 64%';
check('a keep-list hero keeps its hand crop whole', UI._heroFocal('Ghostface', 'G.jpg', '50%') === '82% 64%');
check('a keep-list hero with no crop keeps the centre', UI._heroFocal('Stripe', 'S.jpg', '50%', '50% 50%') === '50% 50%');
check('…or the menu\'s CSS default', UI._heroFocal('Stripe', 'S.jpg', '72%', '72% 26%') === '72% 26%');
local['Batman|Batman.jpg'] = '10% 70%';
check('a Gallery Audit crop wins outright', UI._heroFocal('Batman', 'Batman.jpg', '50%') === '10% 70%');
UI._artFocalMap = keepMap; UI._artFocalFor = keepFor;

check('the title screen frames through _heroFocal', /const focal = art \? this\._heroFocal\(name, file, '50%', '50% 50%'\)/.test(SRC));
check('the menu side art frames through _heroFocal', /backgroundPosition = this\._heroFocal\(name, file, '72%', '72% 26%'\)/.test(SRC));

print('hero-crop: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('hero-crop failed');
