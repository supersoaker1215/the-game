// ============================================================
// THE MENU IS A VIDEO.
//
//   jsc sim/menu-video.js
//
// Owner (2026-11-11): "the video replaces the hero art entirely, and the
// hero/music matching goes". Before: a random hero painting on the title, a
// cross-faded hero per music track in the menu. After: one muted looping
// video, MOVED from the title into the menu so PRESS START continues the
// same shot (measured live: t 9.1s on the title → 12.1s in the menu, one
// <video> on the page, zero .mm-hero-img), paused whenever the overlay is
// hidden (measured: paused on display:none, playing again when shown).
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var SRC = read('ui.js'), SW = read('sw.js'), CSS = read('style.css');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
function body(sig, next) { var a = SRC.indexOf(sig); return a < 0 ? '' : SRC.slice(a, SRC.indexOf(next, a + sig.length)); }

var scene = UI._menuSceneHTML();
check('the menu scene hosts the video, not hero buffers', /mm-bgvideo/.test(scene) && !/mm-hero-img/.test(scene), scene);
var title = body('  renderTitleScreen(s) {', '  _armTitleDismiss() {');
check('the title mounts the shared video', /this\._mountMenuVideo\(el\.querySelector\('\.ts-bg'\)\)/.test(title));
check('…and no longer picks a hero or retargets the music', !/getCardArtPathDefault|_srcForHeroName|_titleHeroName/.test(title));
check('the menu render mounts the same video', /if \(_flowOn\) this\._mountMenuVideo\(el\.querySelector\(':scope > \.mm-bgvideo'\)\)/.test(SRC));
var side = body('  _updateMenuSideArt(src) {', '\n  },');
check('a track change no longer swaps any art', !/backgroundImage|getCardArtPathDefault/.test(side) && /_updateNowPlaying\(src\)/.test(side));
check('the hero hand-off is gone everywhere', !/_titleHeroName|_heroFocal|_menuHeroInfo/.test(SRC));

// One element, moved — never re-created.
var made = 0, keepCE = document.createElement;
document.createElement = function (t) { if (String(t).toLowerCase() === 'video') made++; return keepCE.apply(document, arguments); };
UI._menuVideo = null;
var a = UI._menuVideoEl(), b = UI._menuVideoEl();
document.createElement = keepCE;
check('the video element is a singleton', a === b && made === 1, 'made ' + made);
check('…muted, looping and inline (autoplay-safe on iOS)', a.muted === true && a.loop === true && a.playsInline === true);
check('…pointing at the shipped loop', String(a.src).indexOf('video/menu-loop.mp4') >= 0);

// Plays only while it is on screen.
var played = 0, paused = 0;
var fake = { isConnected: true, paused: true, play: function () { played++; this.paused = false; }, pause: function () { paused++; this.paused = true; } };
UI._menuVideo = fake; UI._menuVideoOnScreen = true;
UI._syncMenuVideo();
check('on screen → plays', played === 1 && !fake.paused);
UI._menuVideoOnScreen = false; UI._syncMenuVideo();
check('hidden overlay → pauses (no decoding during a match)', paused === 1 && fake.paused);
fake.isConnected = false; UI._menuVideoOnScreen = true; UI._syncMenuVideo();
check('detached → stays paused', played === 1);
UI._menuVideo = null;

check('the service worker leaves video to the HTTP cache (Range requests)', /if \(\/\\\.\(mp4\|webm\|m4v\)\$\/i\.test\(url\.pathname\)\) return;/.test(SW));
check('the video fills its host', /\.mm-video \{[^}]*object-fit: cover/.test(CSS));

print('menu-video: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('menu-video failed');
