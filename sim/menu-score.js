// ============================================================
// THE MENU PLAYS THE SCORE, NOT THE CARDS.
//
//   jsc sim/menu-score.js
//
// Owner (2026-11-11): "the music needs to be not from the cards but the music
// you made". Before: the menu bed was a shuffle of card hover tracks (mp3).
// After: three original generative pieces synthesised in Web Audio (Horizon,
// Orbit, Derelict). Measured live: Orbit playing, card <audio> paused, label
// "♪ Orbit", picker rows = the three pieces, switching to Derelict works, and
// stopMusic fades the score to RMS .0002 within 2.5s.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var SRC = read('ui.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

check('the score is on', UI.MENU_SCORE_ON === true);
check('three original pieces', UI.menuScore.SCORES.map(function (s) { return s.name; }).join() === 'Horizon,Orbit,Derelict');
// Stub the score so the sfx hooks can be observed without Web Audio.
var calls = [];
var keep = { start: UI.menuScore.start, stop: UI.menuScore.stop, next: UI.menuScore.next, duck: UI.menuScore.duck };
UI.menuScore.start = function (i) { calls.push('start' + (i == null ? '' : i)); return true; };
UI.menuScore.stop = function () { calls.push('stop'); };
UI.menuScore.next = function () { calls.push('next'); };
UI.menuScore.duck = function (on) { calls.push(on ? 'duck' : 'unduck'); };
UI.settings = UI.settings || {}; UI.settings.sfxVolume = .5; UI.settings.menuMusic = true;
var hadEnsure = 0, keepEnsure = UI.sfx._ensureMusic;
UI.sfx._ensureMusic = function () { hadEnsure++; return keepEnsure.apply(this, arguments); };
UI.sfx.startMusic();
check('startMusic starts the score…', calls[0] === 'start', calls.join());
check('…and never builds the card-track <audio>', hadEnsure === 0);
UI.sfx.crossfadeTo('audio/cards/thor-hover.mp3');
check('a hero preview cannot put a card track on', hadEnsure === 0);
UI.sfx.nextMenuTrack(); check('the now-playing click moves to the next piece', calls.indexOf('next') >= 0);
UI.sfx.duckMusic(); UI.sfx.restoreMusic(); check('hover duck reaches the score', calls.indexOf('duck') >= 0 && calls.indexOf('unduck') >= 0);
UI.sfx.stopMusic(); check('leaving the menu stops the score', calls.indexOf('stop') >= 0);
UI.settings.menuMusic = false; calls = []; UI.sfx.startMusic();
check('the Menu music toggle still silences it', calls.length === 0);
UI.settings.menuMusic = true;
UI.sfx._ensureMusic = keepEnsure;
for (var k in keep) UI.menuScore[k] = keep[k];
// Match intro: the score comes back for the intro window, never a card track.
UI.menuScore.start = function (i) { calls.push('start' + (i == null ? '' : i)); return true; };
UI.menuScore.stop = function () { calls.push('stop'); };
UI.menuScore._idx = 1;
var made = 0, KeepAudio = this.Audio;
this.Audio = function () { made++; return { play: function () {}, pause: function () {} }; };
calls = []; UI.sfx._musicWantPlay = false;
var timers = [], keepST = this.setTimeout;
this.setTimeout = function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; };
UI.sfx.playMatchIntro();
check('the match intro plays the score (same piece the menu had)', calls[0] === 'start1', calls.join());
check('…and builds no card-track <audio>', made === 0);
check('…for the intro window, then fades out', timers.length === 1 && timers[0].ms === (UI.sfx.MATCH_INTRO_MS || 20000) - 2500);
timers[0].fn();
check('the intro window ends with the score stopped', calls[calls.length - 1] === 'stop');
calls = []; UI.sfx.playMatchIntro(); UI.sfx._musicWantPlay = true; timers[timers.length - 1].fn();
check('a menu that is back on is never cut by the intro timer', calls.indexOf('stop') < 0, calls.join());
this.setTimeout = keepST; this.Audio = KeepAudio;
for (var k2 in keep) UI.menuScore[k2] = keep[k2];
var rows = UI._menuHeroPickerRowsHTML();
check('the picker lists the pieces', /data-score="0"[^>]*>Horizon</.test(rows) && /Derelict/.test(rows) && !/data-hero=/.test(rows), rows.slice(0, 120));
check('the score routes through the mixer MUSIC bus', /comp\.connect\(sfx\._mixBus\('music'\)\)/.test(SRC));

print('menu-score: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('menu-score failed');
