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
check('…then holds the track for the beat (one release timer)', TIMERS.length === 1);
UI._fxDirect([{ type: 'hit', attackerId: 2, cardId: 8, tag: 'b' }]);
check('a beat arriving mid-animation waits for it instead of stacking on top', PLAYED.join() === 'hit:a', PLAYED.join());
tick();
check('…and plays when the first one ends', PLAYED.join() === 'hit:a,hit:b', PLAYED.join());

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
      /showDamageFloats\(\)\s*\{\s*const events = Game\.flushDmg\(\);\s*if \(events\.length\) this\._fxDirect\(events\);/.test((read('ui-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('\n'))));

// ---- STEP 1: a beat lasts as long as its animations ---------------------------
reset();
var FAKE_ANIMS = [];
document.getAnimations = function () { return FAKE_ANIMS.slice(); };
UI._fxPlayOne = function (ev) {
  PLAYED.push(ev.type);
  if (ev.len) FAKE_ANIMS.push({ currentTime: 0, effect: { getComputedTiming: function () { return { endTime: ev.len }; } } });
  if (ev.loop) FAKE_ANIMS.push({ currentTime: 0, effect: { getComputedTiming: function () { return { endTime: Infinity }; } } });
};
UI._fxDirect([{ type: 'hit', attackerId: 1, len: 1500 }]);
check('a beat with a 1.5s animation holds the track 1.5s, not the fixed 240ms', TIMERS[0] && TIMERS[0].ms === 1500, TIMERS[0] && TIMERS[0].ms);
reset(); FAKE_ANIMS = [];
UI._fxDirect([{ type: 'hit', attackerId: 1, len: 90 }]);
check('a short animation never shortens the minimum spacing', TIMERS[0] && TIMERS[0].ms === 240, TIMERS[0] && TIMERS[0].ms);
reset(); FAKE_ANIMS = [];
UI._fxDirect([{ type: 'hit', attackerId: 1, len: 9000 }]);
check('a very long animation is capped (2.4s) so nothing can stall the queue', TIMERS[0] && TIMERS[0].ms === 2400, TIMERS[0] && TIMERS[0].ms);
reset(); FAKE_ANIMS = [];
UI._fxDirect([{ type: 'hit', attackerId: 1, loop: true }]);
check('a looping animation does not count as the beat length', TIMERS[0] && TIMERS[0].ms === 240, TIMERS[0] && TIMERS[0].ms);
var pre1 = [{ currentTime: 0, effect: { getComputedTiming: function () { return { endTime: 5000 }; } } }];
reset(); FAKE_ANIMS = pre1.slice();
UI._fxDirect([{ type: 'hit', attackerId: 1 }]);
check('animations already running before the beat are not counted', TIMERS[0] && TIMERS[0].ms === 240, TIMERS[0] && TIMERS[0].ms);

// ---- STEP 2: one timeline — the engine's next lane waits for the director -------
reset(); FAKE_ANIMS = [];
UI._fxDirect([{ type: 'hit', attackerId: 1, len: 2000 }]);
var rem = UI.fxRemainingMs('combat');
check('the director reports how long it still has to play', rem > 1500 && rem <= 2000, rem);
var gap = Game._laneGapMs();
check('the next lane waits for it (longer than the fixed gap)', gap >= rem - 5 && gap > Game.COMBAT_LANE_DELAY, gap + ' vs base ' + Game.COMBAT_LANE_DELAY);
reset();
check('with nothing playing, the lane gap is exactly the speed setting', Game._laneGapMs() === Game.COMBAT_LANE_DELAY);
reset(); FAKE_ANIMS = [];
for (var k = 0; k < 6; k++) UI._fxDirect([{ type: 'hit', attackerId: 50 + k, len: 2400 }]);
check('…and the director\'s share of the wait is capped at 2.5s (the existing audio-tail wait keeps its own rules)', Game._laneGapMs() <= Math.max(Game.COMBAT_LANE_DELAY, 2500), Game._laneGapMs());
check('the lane scheduler uses it', /this\._schedule\(\(\) => resolveLane\(i \+ 1\), this\._laneGapMs\(\)\)/.test(read('game.js')));
delete document.getAnimations;
UI._fxPlayOne = function (ev) { PLAYED.push(ev.type + (ev.tag ? ':' + ev.tag : '')); };

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

// ---- STEP 3: the mixer (Web Audio can't run headless — assert its wiring) ----
var SRC = (read('ui-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('\n'));
check('samples are routed into the mixer just before they play', /this\._route\(pick, this\._MIX_BUS_OF\[cat\] \|\| 'sfx'\);\s*try \{\s*pick\.volume = 0;/.test(SRC));
check('three buses: music, sfx, voice', /\['music', 'sfx', 'voice'\]\.forEach\(b => \{ mix\[b\] = ctx\.createGain\(\)/.test(SRC));
check('a routed element\'s volume drives its GainNode (so every existing fade works, iOS included)',
      /Object\.defineProperty\(el, 'volume', \{[\s\S]{0,120}get\(\) \{ return g\.gain\.value; \}/.test(SRC));
check('it only routes a RUNNING context (a suspended one would play silence)', /this\._ctx\.state === 'running'/.test(SRC));
check('a failed route leaves that element on the native path', /el\._mixFailed = true;/.test(SRC));
check('music joins the music bus, including once the context wakes', /this\._route\(a, 'music'\)/.test(SRC) && /resume\(\)\.then\(\(\) => \{ if \(this\._music\) this\._route\(this\._music, 'music'\)/.test(SRC));
check('a voice line ducks the music bus', /this\._mixDuck\('music', this\._VOICE_UNDER_GAIN, 150\)/.test(SRC));
// and the routing itself, against a fake context
(function () {
  var made = [];
  function Gain() { this.gain = { value: 1 }; this.connect = function (n) { this.to = n; return n; }; }
  var fakeCtx = { state: 'running', destination: {}, currentTime: 0,
    createGain: function () { var g = new Gain(); made.push(g); return g; },
    createMediaElementSource: function (el) { return { connect: function (n) { this.to = n; return n; } }; } };
  var savedCtx = S._ctx, savedMix = S._mix;
  S._ctx = fakeCtx; S._mix = null;
  var HM = (typeof HTMLMediaElement !== 'undefined') ? HTMLMediaElement : null;
  if (!HM) { this.HTMLMediaElement = function () {}; }
  var proto = HTMLMediaElement.prototype, nativeVol = { v: 0.42 };
  Object.defineProperty(proto, 'volume', { configurable: true, get: function () { return nativeVol.v; }, set: function (v) { nativeVol.v = v; } });
  var el = Object.create(proto);
  var ok1 = S._route(el, 'voice');
  check('routing a live element succeeds', ok1 === true);
  check('…its gain starts at the volume it had', Math.abs(el._mixGain.gain.value - 0.42) < 1e-9, el._mixGain.gain.value);
  check('…the native volume is pinned at 1', nativeVol.v === 1, nativeVol.v);
  el.volume = 0.2;
  check('…and writing el.volume now moves the gain node, not the element', Math.abs(el._mixGain.gain.value - 0.2) < 1e-9 && nativeVol.v === 1);
  check('…which feeds the voice bus', el._mixGain.to === S._mix.voice);
  fakeCtx.state = 'suspended';
  var el2 = Object.create(proto);
  check('a suspended context does not route (no silent audio)', S._route(el2, 'sfx') === false && !el2._mixGain);
  S._ctx = savedCtx; S._mix = savedMix;
})();

print('fx-director: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('fx-director failed');
