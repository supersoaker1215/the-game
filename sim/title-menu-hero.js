// ============================================================
// PRESS START KEEPS THE SAME FACE.
//
//   jsc sim/title-menu-hero.js
//
// Owner: "i want the main menu press start screen to be the same character
// as when you load into the game". The menu shows whoever's theme is playing.
// Measured live before: title Mahoraga → menu Darth Maul (music had been
// loaded at boot with a random track, and the PRESS START tap that unlocks
// audio played it). After, real taps on fresh loads: Thor → Thor, The V.P. →
// The V.P., and The C.J. → The C.J. (a theme shared by several Cog heroes,
// which stem→name alone resolved to The C.F.O.).
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var SRC = read('ui.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

var ts = SRC.slice(SRC.indexOf('  renderTitleScreen(s) {'), SRC.indexOf('  _armTitleDismiss() {'));
check('the title retargets the boot music to its own hero (loaded OR already playing)',
  /this\.sfx\._srcForHeroName\(name\)/.test(ts) && /if \(a && tSrc\) \{\s*const wasPlaying = !a\.paused;\s*a\.src = tSrc;/.test(ts));
check('…and pins that face to the track', /if \(tSrc\) this\._pinTrackFace\(tSrc, name\);/.test(ts));

// A shared track names the pinned face, not whichever stem won the map.
UI._trackFace = null;
UI._pinTrackFace('audio/cards/cog-theme-cj.mp3?v=1', 'The C.J.');
check('a pinned face wins for its track', UI._menuHoverArtName('http://x/audio/cards/cog-theme-cj.mp3') === 'The C.J.');
check('…and only for its track', UI._menuHoverArtName('audio/cards/thor-hover.mp3') !== 'The C.J.');

// The entry track leads with the title hero when the hand-off is still open.
var keep = UI.sfx._srcForHeroName;
UI.sfx._srcForHeroName = function (n) { return n === 'Thor' ? 'audio/cards/thor-hover.mp3' : null; };
UI._titleHeroName = 'Thor'; UI._menuDefaultLed = false;
var first = UI.sfx._pickMenuTrackForEntry();
check('the first menu track is the title hero\'s theme', first === 'audio/cards/thor-hover.mp3', first);
check('…once (the shuffle carries on afterwards)', UI._titleHeroName === null);
UI.sfx._srcForHeroName = keep;

print('title-menu-hero: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('title-menu-hero failed');
