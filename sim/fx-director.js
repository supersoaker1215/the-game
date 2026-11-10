// ============================================================
// THE PRESENTATION DIRECTOR + THE VOICE CHANNEL
//   spec: docs/superpowers/specs/2026-11-10-presentation-director-design.md
//
//   jsc sim/fx-director.js
//
// Owner: "sometimes voicelines, or animations are missed entirely … should
// there be a separate engine that handles animation?"
// Measured first: the 60-event cap was not dropping events (~15 a round, max
// batch 10). The miss was the dispatcher playing a whole burst in ONE frame,
// and two foreground audio cues simply overlapping.
// The shim runs setTimeout synchronously, which would hide all pacing, so this
// installs its own timer queue and asserts WHEN each event plays.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

// ---- a controllable clock ------------------------------------------------------
var TIMERS = [], realST = setTimeout;
setTimeout = function (fn, ms) { TIMERS.push({ fn: fn, ms: ms | 0 }); return TIMERS.length; };
clearTimeout = function () {};
function tick() { var t = TIMERS.shift(); if (t) t.fn(); return t; }

// ---- spy on what plays, and when ------------------------------------------------
var PLAYED = [];
UI._fxPlayOne = function (ev) { PLAYED.push(ev.type + (ev.tag ? ':' + ev.tag : '')); };
function reset() { UI._fxReset(); UI._fxDir = null; PLAYED = []; TIMERS = []; }

// 1. the calm path is synchronous — normal host play is unchanged
reset();
UI._fxDirect([{ type: 'hit', attackerId: 1, cardId: 7, tag: 'a' }]);
check('a single combat beat plays in the same frame (calm path)', PLAYED.join() === 'hit:a', PLAYED.join());
check('…and leaves no timer behind', TIMERS.length === 0);

// 2. a burst is paced, one beat per step
reset();
UI._fxDirect([{ type: 'hit', attackerId: 1, tag: 'L1' }, { type: 'hit', attackerId: 2, tag: 'L2' }, { type: 'hit', attackerId: 3, tag: 'L3' }]);
check('a burst plays its FIRST beat now, not all of them', PLAYED.join() === 'hit:L1', PLAYED.join());
tick(); tick();
check('…and the rest one beat per step, in order', PLAYED.join() === 'hit:L1,hit:L2,hit:L3', PLAYED.join());

// 3. beats: an attacker's swing and every hit it lands are ONE beat (area hits stay simultaneous)
reset();
UI._fxDirect([{ type: 'swing', cardId: 5, tag: 's' }, { type: 'hit', attackerId: 5, cardId: 9, tag: 'h1' },
              { type: 'hit', attackerId: 5, cardId: 10, tag: 'h2' }, { type: 'hit', attackerId: 6, cardId: 11, tag: 'next' }]);
check('swing + its two hits play together', PLAYED.join() === 'swing:s,hit:h1,hit:h2', PLAYED.join());
tick();
check('the next attacker is the next beat', PLAYED[PLAYED.length - 1] === 'hit:next');

// 4. immediate types never wait behind a burst
reset();
UI._fxDirect([{ type: 'hit', attackerId: 1 }, { type: 'hit', attackerId: 2 }, { type: 'statusSfx', tag: 'snd' }, { type: 'sig', tag: 'cine' }]);
check('sounds and relayed cinematics are not queued behind combat', PLAYED.indexOf('statusSfx:snd') >= 0 && PLAYED.indexOf('sig:cine') >= 0, PLAYED.join());

// 5. catch-up: the wait shrinks as the backlog grows
reset();
var burst = []; for (var i = 0; i < 20; i++) burst.push({ type: 'hit', attackerId: 100 + i });
UI._fxDirect(burst);
var waits = [];
while (TIMERS.length) { waits.push(TIMERS[0].ms); tick(); }
check('a long backlog plays faster than a short one', waits[0] < 240 && waits[waits.length - 2] > waits[0], waits.join(','));
check('…but every beat still plays (nothing dropped)', PLAYED.length === 20, PLAYED.length + ' of 20');

// 6. far behind: cosmetic events merge away first, hits never
reset();
var big = []; for (var j = 0; j < 30; j++) { big.push({ type: 'swing', cardId: 200 + j }); big.push({ type: 'hit', attackerId: 300 + j }); }
UI._fxDirect(big);
while (tick()) {}
var hits = PLAYED.filter(function (p) { return p === 'hit'; }).length;
check('over 24 queued beats, every hit still plays', hits === 30, hits + ' of 30');
check('…while cosmetic swings are merged away', UI.fxDirectorStats().merged > 0, JSON.stringify(UI.fxDirectorStats()));

// 7. announcements queue on their own track and never merge away
reset();
UI._fxDirect([{ type: 'trickReveal', tag: 't1' }, { type: 'trickReveal', tag: 't2' }, { type: 'hit', attackerId: 1, tag: 'h' }]);
check('two announcements in a burst: the first now, the second later; combat is its own track',
      PLAYED.indexOf('trickReveal:t1') >= 0 && PLAYED.indexOf('trickReveal:t2') < 0 && PLAYED.indexOf('hit:h') >= 0, PLAYED.join());
while (tick()) {}
check('…and the second announcement does play', PLAYED.indexOf('trickReveal:t2') >= 0);

// 8. showDamageFloats routes through the director
check('the dispatcher reads the stream and hands it to the director',
      /showDamageFloats\(\)\s*\{\s*const events = Game\.flushDmg\(\);\s*if \(events\.length\) this\._fxDirect\(events\);/.test(read('ui.js')));

// ---- 9. the voice channel ---------------------------------------------------------------
function FakeAudio() { this.paused = true; this.ended = false; this.volume = 1; this.currentTime = 0; this.readyState = 4; this.duration = 5; this._l = {}; }
FakeAudio.prototype.play = function () { this.paused = false; return { catch: function () {} }; };
FakeAudio.prototype.pause = function () { this.paused = true; (this._l.pause || []).forEach(function (f) { f(); }); };
FakeAudio.prototype.addEventListener = function (t, f) { (this._l[t] = this._l[t] || []).push(f); };
FakeAudio.prototype.removeEventListener = function () {};
Audio = FakeAudio;
setInterval = function () { return 0; }; clearInterval = function () {};
UI.settings.sfxVolume = 0.5;
var S = UI.sfx;
S._samplePool = new Map(); S._activeHover = new Set(); S._activeNonHover = new Set(); S._voiceNow = null; S._voiceStat = null;
S._fadeVolume = function (a, v) { a.volume = v; };
var faded = [];
S._fadeToPauseAtPosition = function (a) { faded.push(a); a.pause(); };
var a1 = S._playSample('audio/x/one.mp3', { category: 'play', noFade: true });
var a2 = S._playSample('audio/x/two.mp3', { category: 'play', noFade: true });
check('a newer card-play cue takes the channel and the older one fades out (no overlap)', faded.indexOf(a1) >= 0 && S._voiceNow.el === a2);
var a3 = S._playSample('audio/x/abil.mp3', { category: 'ability', noFade: true });
check('a lower-priority cue plays UNDER the current one, not over it', a3 && a3._voiceUnder === true && a3.volume < a2.volume, (a3 && a3.volume) + ' vs ' + a2.volume);
var a4 = S._playSample('audio/x/voice.mp3', { category: 'voiceLine', noFade: true });
var full = a2._sfxPreDuck;   // its level before ANY duck
check('a voice line takes the channel', S._voiceNow.el === a4);
check('…and pulls everything else down to 35% of its own level', full > 0 && Math.abs(a2.volume - full * 0.35) < 1e-6, a2.volume + ' vs ' + full);
var a5 = S._playSample('audio/x/three.mp3', { category: 'play', noFade: true });
check('a card play during a voice line plays under it, never cutting it', a5 && a5._voiceUnder === true && !a4.paused);

print('fx-director: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('fx-director failed');
