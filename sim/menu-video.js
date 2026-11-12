// ============================================================
// THE MENU BACKDROP IS ONE SHARED ELEMENT, MOVED — NEVER RE-CREATED.
//
//   jsc sim/menu-video.js
//
// The title and the menu mount the same backdrop so PRESS START continues the
// same shot; the start screen is the menu's own scaffold with PRESS START where
// the list will appear; no hero art or hero/music hand-off remains. The video
// scene plays only while it is on screen. These checks RUN the renderers.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var SW = read('sw.js'), CSS = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join(''));
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

var scene = UI._menuSceneHTML();
check('the menu scene hosts the backdrop, not hero buffers', /mm-bgvideo/.test(scene) && !/mm-hero-img/.test(scene), scene);

var hosts = [], realMountV = UI._mountMenuVideo;
UI._mountMenuVideo = function (h) { hosts.push(h); };
var winL = {}, realWinAdd = window.addEventListener;
window.addEventListener = function (t, fn) { (winL[t] = winL[t] || []).push(fn); };
var ov = document.getElementById('main-menu-overlay');
try {
  UI._titleDone = false; UI._titleArmed = false;
  UI.renderTitleScreen(Game.state);
  var vh = ov.querySelector('.mm-bgvideo');
  check('the title mounts the shared backdrop', hosts.length === 1 && vh && hosts[0] === vh, hosts.length);
  var head = ov.querySelector('.mm-panel .mm-header');
  check('the start screen IS the menu scaffold (same header, same panel)',
    head && head.querySelector('h1.mm-title') && head.querySelector('h1.mm-title').textContent === 'the game'
    && ['ts-menulike', 'mm-mw3', 'mm-four'].every(function (c) { return ov.classList.contains(c); }), ov.className);
  var opt = ov.querySelector('.ts-options');
  check('the start screen offers Options (Settings) under PRESS START',
    opt && ov.querySelector('#ts-prompt') && /UI\.openSettings\(\)/.test(opt.getAttribute('onclick') || ''));
  check('…and picks no hero art', !ov.querySelector('.mm-hero-img') && !(ov.style.backgroundImage || ''));
  // An open Settings panel swallows presses: the start screen stays.
  var down = winL.pointerdown || [];
  var so = document.createElement('div'); so.className = 'settings-overlay active'; document.body.appendChild(so);
  down.forEach(function (fn) { fn({ type: 'pointerdown', target: ov.querySelector('.mm-panel') }); });
  check('…and a press while Settings is open never dismisses it', down.length > 0 && UI._titleDone === false, 'done ' + UI._titleDone);
  so.remove();
  hosts.length = 0;
  ov.innerHTML = ''; UI.settings.menuFlow = true;
  UI.renderMainMenu(Game.state);
  var mh = ov.querySelector('.mm-bgvideo');
  check('the menu render mounts the same backdrop', hosts.length >= 1 && mh && hosts[hosts.length - 1] === mh && mh.parentNode === ov, hosts.length);
} catch (e) { fails.push('render threw: ' + (e.message || e)); }
UI._mountMenuVideo = realMountV; window.addEventListener = realWinAdd;

var np = [], realNP = UI._updateNowPlaying;
UI._updateNowPlaying = function (src) { np.push(src); };
UI._updateMenuSideArt('audio/x.mp3');
UI._updateNowPlaying = realNP;
check('a track change only updates the now-playing credit', np.length === 1 && np[0] === 'audio/x.mp3');
check('the hero hand-off is gone everywhere', ['_titleHeroName', '_heroFocal', '_menuHeroInfo'].every(function (k) { return typeof UI[k] === 'undefined'; }));
check('title top centre, PRESS START dead centre (CSS)', /\.ts-menulike \.ts-prompt \{\s*position: absolute; left: 50%; top: 50%; transform: translate\(-50%, -50%\)/.test(CSS) && /\.ts-menulike \.mm-header \{ align-items: center/.test(CSS));

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
