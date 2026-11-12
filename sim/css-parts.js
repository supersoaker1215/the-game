// ============================================================
// THE STYLESHEET IS ORDERED PARTS, LOADED IN ORDER.
//
//   jsc sim/css-parts.js
//
// style.css (53k lines) was split 2026-11-12 into style-NN-*.css. Later rules
// win, so ORDER IS THE CASCADE: style-parts.txt is the single source of it,
// and index.html must link exactly those files, in exactly that order, with
// nothing left pointing at the old monolith.
// ============================================================
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
var parts = read('style-parts.txt').trim().split('\n');
var html = read('index.html');
var links = (html.match(/<link rel="stylesheet" href="([^"?]+)\?v=\d+">/g) || [])
  .map(function (l) { return l.replace(/^.*href="([^"?]+)\?.*$/, '$1'); })
  .filter(function (h) { return /^style(-\d\d-[\w-]+)?\.css$/.test(h); });
check('index.html links every part, in parts.txt order', links.join('|') === parts.join('|'), links.join(', '));
check('nothing still loads the old style.css', !/href="style\.css/.test(html));
check('parts are numbered in load order', parts.every(function (p, i) { return p.indexOf('style-' + (i + 1 < 10 ? '0' : '') + (i + 1) + '-') === 0; }), parts.join(', '));
var ok = true; parts.forEach(function (p) { try { if (!read(p).length) ok = false; } catch (e) { ok = false; } });
check('every part exists and is non-empty', ok);
check('the parts sit beside index.html (CSS url()s resolve from the sheet\'s folder)', parts.every(function (p) { return p.indexOf('/') < 0; }));
print('css-parts: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('css-parts failed');
