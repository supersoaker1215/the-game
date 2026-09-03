// ============================================================
// CSS PARSE AUDIT — static. Proves style.css says what it looks like it says.
//
// A CSS comment ends at the FIRST `*/`, and nothing warns you when that lands
// in the middle of your prose. Write a token family as `--enemy-*/--player-*`
// and the comment closes at the `*/` inside it; the rest of the sentence is
// then parsed as CSS, the parser swallows everything up to the next `{` as a
// selector, and the rule you wrote underneath is dropped on the floor. The file
// looks right, the rule is dead, and the only symptom is "that fix didn't work".
//
// This has bitten twice in this sheet:
//   L17530  `--player-*/--enemy-*` killed the victory/defeat panel's themed
//           border, glow and background — the block written specifically to
//           override the hardcoded cyan/red had never applied.
//   2026-09-03  the same sequence in a new comment swallowed the lane rail fix
//           minutes after it was written.
//
// Two checks, both cheap:
//   STRAY    a `*/` that appears while not inside a comment
//   UNCLOSED a `/*` with no `*/` after it — everything below it is gone
//
//   jsc sim/css-parse.js -- [--verbose]
// ============================================================

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

var FILES = ['style.css'];
var pass = 0, fails = [];

function lineOf(s, pos) { return s.slice(0, pos).split('\n').length; }
function lineText(s, ln) { return (s.split('\n')[ln - 1] || '').trim().slice(0, 120); }

FILES.forEach(function (file) {
  var s;
  try { s = read(file); } catch (e) { fails.push(file + ' — could not be read'); return; }

  var i = 0, n = s.length, strays = [], unterminated = -1;
  while (i < n) {
    var open = s.indexOf('/*', i);
    if (open < 0) {
      var k = s.indexOf('*/', i);
      while (k >= 0) { strays.push(k); k = s.indexOf('*/', k + 2); }
      break;
    }
    var j = s.indexOf('*/', i);
    while (j >= 0 && j < open) { strays.push(j); j = s.indexOf('*/', j + 2); }
    var close = s.indexOf('*/', open + 2);
    if (close < 0) { unterminated = open; break; }
    i = close + 2;
  }

  if (strays.length === 0) { pass++; if (VERBOSE) print('  ok  ' + file + ': no stray comment terminators'); }
  else {
    strays.forEach(function (p) {
      var ln = lineOf(s, p);
      fails.push(file + ':' + ln + ' — stray `*/` outside a comment. A comment above it ended early, '
               + 'and the rule after it is being parsed as part of a broken selector: ' + lineText(s, ln));
    });
  }

  if (unterminated < 0) { pass++; if (VERBOSE) print('  ok  ' + file + ': every comment is closed'); }
  else fails.push(file + ':' + lineOf(s, unterminated) + ' — unterminated `/*`; everything below it is dead');
});

print('css-parse: ' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) {
  print('Failures:');
  fails.forEach(function (f) { print('  - ' + f); });
}
