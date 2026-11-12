// ============================================================
// audio.js — THE SOUND SYSTEM (split out of ui.js, 2026-11-12)
// ============================================================
// The sound engine (sfx: Web Audio mixer, card cues, music, the generative menu score), the per-card sound registry, the UI/nav/hover sound installers, the audio bridge for online play and the Audio Audit dev tool.
//
// Same contract as fx.js: this file loads BEFORE ui.js and only declares
// UI_AUDIO, a plain object of methods written exactly as they were inside the
// UI literal; ui.js merges it into UI right after that literal and before
// UI.init(). Methods keep `this`, so every UI.whatever call is unchanged.
// ============================================================
const UI_AUDIO = {
  // ===================== MENU SCORE =====================
  // The menu bed is generative music synthesised live in Web Audio — no files,
  // nothing from the cards (owner, 2026-11-11: "the music needs to be not from
  // the cards but the music you made"). Three ORIGINAL pieces, each a chord
  // loop with its own voicing; a scheduler keeps ~1.5s of notes queued ahead.
  // Output goes through the mixer's MUSIC bus, so the Music slider, the master
  // mute and the hover-duck all apply exactly as they did to the old tracks.
  menuScore: {
    _live: null, _idx: -1, _out: null, _ducked: false,
    SCORES: [
      { name: 'Horizon', bar: 10,   // slow organ-like chords, a soft high arpeggio
        chords: [[33,45,52,57,60,64],[29,41,48,53,57,60],[36,48,55,60,64,67],[31,43,50,55,59,62]],
        play(A, bus, t, ch) { const L = this.bar;
          A.pad(bus, ch[0], t, L, { type: 'sine', vol: .13, cut: 240, det: 1 });
          ch.slice(1).forEach(m => { A.pad(bus, m, t, L, { type: 'sine', vol: .03, cut: 3000, det: 3 });
            A.pad(bus, m + 12, t + .2, L, { type: 'triangle', vol: .012, cut: 1800, det: 5 }); });
          const arp = [ch[3]+12, ch[4]+12, ch[5]+12, ch[4]+24, ch[5]+12, ch[4]+12];
          for (let i = 0; i < 10; i++) A.pluck(bus, arp[i % arp.length], t + 1 + i*L/10, .016); } },
      { name: 'Orbit', bar: 8,      // wide synth pads, a patient arpeggio, a deep sub
        chords: [[38,50,53,57,62,64],[34,46,50,53,57,60],[31,43,46,50,55,57],[33,45,49,52,57,59]],
        play(A, bus, t, ch) { const L = this.bar;
          A.pad(bus, ch[0], t, L, { type: 'sine', vol: .12, cut: 300, det: 2 });
          ch.slice(1).forEach(m => A.pad(bus, m, t, L, { cut: 1100, vol: .028 }));
          const arp = [ch[2]+12, ch[3]+12, ch[4]+12, ch[5]+12, ch[4]+12, ch[3]+12];
          for (let i = 0; i < 16; i++) A.pluck(bus, arp[i % arp.length], t + i*L/16, .022 + (i % 4 === 0 ? .012 : 0)); } },
      { name: 'Derelict', bar: 12,  // tense dark drone: low clusters, air, distant metal
        chords: [[26,38,45,51],[27,39,46,50],[24,36,43,49],[26,38,44,51]],
        ambient(A, bus) { const c = A.ctx, s = A.noise(), f = c.createBiquadFilter(), g = c.createGain(), l = c.createOscillator(), lg = c.createGain();
          f.type = 'bandpass'; f.frequency.value = 500; f.Q.value = .6; g.gain.value = .035;
          l.frequency.value = .05; lg.gain.value = 300; l.connect(lg); lg.connect(f.frequency);
          s.connect(f); f.connect(g); g.connect(bus); s.start(); l.start();
          return () => { try { s.stop(); l.stop(); } catch (e) {} }; },
        play(A, bus, t, ch, n) { const L = this.bar;
          A.pad(bus, ch[0], t, L, { vol: .07, cut: 200, det: 4 });
          ch.slice(1).forEach((m, i) => A.pad(bus, m + 12, t + i*.7, L, { type: 'sine', vol: .022, cut: 1400, det: 12 }));
          A.bell(bus, 74 + (n % 3)*3, t + 3 + (n % 2)*4, .018);
          if (n % 2 === 0) A.boom(bus, t + .1, .22); } },
    ],
    // --- tiny synth kit (all oscillators + filters + a noise-impulse reverb)
    hz(m) { return 440*Math.pow(2, (m - 69)/12); },
    noise() { const s = this.ctx.createBufferSource(); s.buffer = this._noise; s.loop = true; return s; },
    pad(bus, midi, t, dur, { cut = 900, vol = .05, type = 'sawtooth', det = 9 } = {}) {
      const c = this.ctx, g = c.createGain(), f = c.createBiquadFilter();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + dur*.35); g.gain.setTargetAtTime(0, t + dur*.75, dur*.18);
      f.type = 'lowpass'; f.Q.value = .7;
      f.frequency.setValueAtTime(cut*.5, t); f.frequency.linearRampToValueAtTime(cut, t + dur*.5); f.frequency.linearRampToValueAtTime(cut*.6, t + dur);
      f.connect(g); g.connect(bus);
      [-det, 0, det].forEach((d, i) => { const o = c.createOscillator(); o.type = type; o.frequency.value = this.hz(midi); o.detune.value = d;
        if (c.createStereoPanner) { const pn = c.createStereoPanner(); pn.pan.value = (i - 1)*.6; o.connect(pn); pn.connect(f); } else o.connect(f);
        o.start(t); o.stop(t + dur*1.6); });
    },
    pluck(bus, midi, t, vol = .05) {
      const c = this.ctx, o = c.createOscillator(), g = c.createGain(), f = c.createBiquadFilter();
      o.type = 'triangle'; o.frequency.value = this.hz(midi); f.type = 'lowpass'; f.frequency.value = 2400;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + 2.2);
      o.connect(f); f.connect(g); g.connect(bus); o.start(t); o.stop(t + 2.4);
    },
    bell(bus, midi, t, vol = .05) {
      const c = this.ctx; [1, 2.76, 5.4, 8.93].forEach((r, i) => { const o = c.createOscillator(), g = c.createGain();
        o.frequency.value = this.hz(midi)*r; g.gain.setValueAtTime(vol/(i + 1), t); g.gain.exponentialRampToValueAtTime(.0001, t + 7/(i + 1));
        o.connect(g); g.connect(bus); o.start(t); o.stop(t + 7); });
    },
    boom(bus, t, vol = .3) {
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.frequency.setValueAtTime(80, t); o.frequency.exponentialRampToValueAtTime(38, t + .6);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0001, t + 2.6);
      o.connect(g); g.connect(bus); o.start(t); o.stop(t + 2.7);
    },
    _setup() {
      if (this._out) return true;
      const sfx = UI.sfx; if (!sfx || !sfx._init || !sfx._init() || !sfx._ctx) return false;
      const c = this.ctx = sfx._ctx;
      const comp = c.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 3;
      comp.connect(sfx._mixBus('music'));
      this._out = c.createGain(); this._out.gain.value = 0; this._out.connect(comp);
      const len = Math.floor(c.sampleRate*5), ir = c.createBuffer(2, len, c.sampleRate);
      for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random()*2 - 1)*Math.pow(1 - i/len, 2.6); }
      const rev = c.createConvolver(); rev.buffer = ir; const wet = c.createGain(); wet.gain.value = .55; rev.connect(wet); wet.connect(this._out);
      this._dry = c.createGain(); this._dry.gain.value = .5; this._dry.connect(this._out); this._dry.connect(rev);
      const nb = c.createBuffer(1, c.sampleRate*2, c.sampleRate), nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random()*2 - 1; this._noise = nb;
      return true;
    },
    // Loudness: the synth voices sum ~12 dB under a mastered track (measured
    // RMS .0097 at 2.4x vs ~.04 for the old card bed), so the score sits at 6x
    // the old bed target; the compressor after it catches the peaks.
    _target() { const s = UI.sfx; const v = s && s._musicTargetVol ? s._musicTargetVol() : .2; return v*6*(this._ducked ? (s._MUSIC_DUCK_FACTOR || .18) : 1); },
    setLevel(fadeS) { if (!this._out || !this._live) return; this._out.gain.setTargetAtTime(this._target(), this.ctx.currentTime, (fadeS == null ? .3 : fadeS)/3); },
    duck(on) { this._ducked = !!on; this.setLevel(.25); },
    playing() { return !!this._live; },
    // start(): keep whatever is playing (menu screen changes re-call it);
    // start(i): switch piece with a crossfade.
    start(idx) {
      if (!this._setup()) return false;
      if (idx == null && this._live) { this.setLevel(.6); return true; }
      if (idx == null) idx = Math.floor(Math.random()*this.SCORES.length);
      if (this._live && idx === this._idx) { this.setLevel(.6); return true; }
      this._stopLive(2.5);
      const c = this.ctx, sc = this.SCORES[idx], bus = c.createGain();
      bus.gain.setValueAtTime(0, c.currentTime); bus.gain.linearRampToValueAtTime(1, c.currentTime + 3); bus.connect(this._dry);
      const stopAmb = sc.ambient ? sc.ambient(this, bus) : null;
      let n = 0, next = c.currentTime + .1;
      const tick = () => { while (next < c.currentTime + 1.5) { sc.play(this, bus, next, sc.chords[n % sc.chords.length], n); next += sc.bar; n++; } };
      tick();
      this._idx = idx; this._live = { bus, iv: setInterval(tick, 400), stopAmb };
      this._out.gain.setTargetAtTime(this._target(), c.currentTime, .4);
      try { UI._updateNowPlaying(null); } catch (e) {}
      return true;
    },
    next() { return this.start((this._idx + 1) % this.SCORES.length); },
    _stopLive(fadeS) {
      const L = this._live; if (!L) return; this._live = null;
      clearInterval(L.iv); L.bus.gain.setTargetAtTime(0, this.ctx.currentTime, fadeS/4);
      setTimeout(() => { if (L.stopAmb) L.stopAmb(); try { L.bus.disconnect(); } catch (e) {} }, fadeS*1000 + 600);
    },
    stop(fadeS) { this._stopLive(fadeS == null ? 1.2 : fadeS); },
    name() { return this._live ? this.SCORES[this._idx].name : ''; },
  },
  MENU_SCORE_ON: true,
  // Hand-audio privacy quick toggle — the small ♪ at the head of the hand row.
  // Exactly the same state as the "Hide hand sounds" settings checkbox, just
  // surfaced where it matters: every card has its own hover cue, so anyone next
  // to you (or listening on a call) can hear what you're holding. Flipping
  // either control updates the other; both write the same persisted key.
  toggleHandAudioPrivacy() {
    if (!this.settings) return;
    this.settings.handAudioPrivacy = !this.settings.handAudioPrivacy;
    // Cut any identifying hover cue already ringing, so the card you were
    // hovering doesn't finish announcing itself after you've hit mute.
    if (this.settings.handAudioPrivacy && this.sfx && this.sfx._currentHoverAudio) {
      try { this.sfx._currentHoverAudio.pause(); } catch (e) {}
      this.sfx._currentHoverAudio = null;
    }
    try { localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) {}
    this.syncHandAudioToggle();
  },

  // Paint the toggle to match state and keep the settings checkbox in agreement
  // (so opening Settings after using the quick toggle shows the truth).
  syncHandAudioToggle() {
    const on = !!(this.settings && this.settings.handAudioPrivacy);
    // Every surface that offers the toggle carries [data-hand-audio-toggle] —
    // the in-hand glyph AND the draft HUD button (draft cards have per-card
    // hover cues too, so the control has to be reachable there). Driving them
    // all from one query keeps them from drifting apart.
    document.querySelectorAll('[data-hand-audio-toggle]').forEach(btn => {
      btn.classList.toggle('is-muted', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = on
        ? 'Hand sounds hidden — per-card hover cues are replaced with one generic blip'
        : 'Hide hand sounds — stop per-card hover cues from revealing your hand';
      // The draft variant is a labelled HUD button; the in-hand one is bare.
      const lbl = btn.querySelector('.mulligan-label');
      if (lbl) lbl.textContent = on ? 'Sounds Hidden' : 'Hide Sounds';
    });
    const box = document.getElementById('setting-hand-audio-privacy');
    if (box) box.checked = on;
  },

  // Audition a card-select cue the moment it is picked. Picking a sound you
  // cannot hear until you close the panel and tap a card is not a choice, it
  // is a guess — so the value is committed to settings first, then the synth's
  // own 'select' case is fired, which means the preview is BY DEFINITION the
  // same code path the game will use rather than a second copy of it.
  previewSelectSfx(value) {
    this.settings.selectSfx = value;
    // Through _playSelectCue — the SAME entry point a card selection uses —
    // not straight into one engine. Calling sfx.play('select') directly is
    // what hid the real bug: the preview sounded correct while the game went
    // on playing the other engine's 880Hz pip, so the setting appeared to work
    // everywhere except where it mattered. A preview that does not travel the
    // production path is not a preview.
    if (value !== 'off') {
      try { this._playSelectCue(); } catch (e) {}
    }
  },

  // Same contract as previewSelectSfx: commit first, then fire the cue through
  // the audio object's OWN roundStart, so the preview is the real thing rather
  // than a copy of it that can drift.
  previewRoundSfx(value) {
    this.settings.roundSfx = value;
    if (value !== 'off' && this.audio && this.audio.roundStart) {
      try { this.audio.roundStart(); } catch (e) {}
    }
  },

  // ===================== SFX (procedural Web Audio) =====================
  // Tiny procedural SFX engine — no asset files. Single shared AudioContext,
  // lazy-initialized on first user gesture (browsers block autoplay until
  // then). Each named effect is a handful of oscillator + noise nodes
  // shaped with short envelopes. Respects UI.settings.sfxVolume (0..1).
  sfx: {
    _ctx: null,
    _master: null,
    _armed: false,
    // HTMLAudioElement pool for the UI nav cue. We round-robin through a
    // handful of clones so back-to-back menu clicks don't clip each other
    // (a single element would have to rewind to start mid-play).
    _navPool: null,
    _navIdx: 0,
    NAV_SRC: 'audio/ui_planetzoom.wav',

    // Per-card SFX registry. Keys are card names exactly as they appear in
    // CARD_DEFS (see cards.js). Each value is a partial map of event →
    // filepath; missing events fall back to DEFAULT_CARD_SFX. Add new
    // entries here to wire unique sounds; no code changes needed.
    //   events: hover, play, ability, attack, death
    CARD_SFX: {
      // ── MENU-SHUFFLE EVENT HEROES ──
      // MC Ballyhoo and the Shadow Man are events, not cards, so they are not
      // in CARD_DEFS — but _menuCharHoverSrcs reads THIS table to build the
      // main-menu shuffle, so their themes are registered here to put them in
      // the rotation. (Owner: "you can add MC Ballyhoo and Shadow man to main
      // menu shuffle too".) Their codex-hover entries stay in TRICK_SFX, which
      // is the table the codex's trick chrome routes through — different
      // lookups, so both are needed.
      'MC Ballyhoo': { hover: 'audio/ballyhoo-fanfare.mp3' },
      'Shadow Man':  { hover: 'audio/shadow-man-theme.mp3' },
      // Cog Invasion VPs — added to the main-menu hero shuffle, each playing its
      // own battle theme on hover. (Owner: "add the 4 vps to the main menu
      // themes.") getCardArtPathDefault resolves their portraits by name.
      'The V.P.':     { hover: 'audio/cog-theme-vp.mp3' },
      'The C.F.O.':   { hover: 'audio/cog-theme-cfo.mp3' },
      'The C.J.':     { hover: 'audio/cog-theme-cj.mp3' },
      'The Chairman': { hover: 'audio/cog-theme-chairman.mp3' },

      // ── SHADOW MAN'S WONDER WEAPONS ──
      // These are CARDS (isDiscardEffect), not tricks: they are played through
      // Game.playCard, and its wrapper fires playCardSfx(name, 'play'). They do
      // NOT go through playTrickSfx, so TRICK_SFX is the wrong table for them —
      // an entry there only ever fires on codex hover.
      // 'play' and not 'ability': the play hook always fires 'play'; 'ability'
      // is never auto-fired, only when an ability calls it explicitly.
      'Ray Gun':               { play: { src: 'audio/cards/ray-gun-play.mp3', noFade: true, fullDuration: true } },
      'Thundergun':            { play: { src: 'audio/cards/thundergun-play.mp3', noFade: true, fullDuration: true } },
      'Lightning Bow':         { play: { src: 'audio/cards/lightning-bow-play.mp3', noFade: true, fullDuration: true } },
      'Wunderwaffe DG-3 JZ':   { play: { src: 'audio/cards/wunderwaffe-play.mp3', noFade: true, fullDuration: true } },
      'Apothicon Servant':     { play: { src: 'audio/cards/apothicon-servant-play.mp3', noFade: true, fullDuration: true } },
      // Vader hover = imperial breath; death = injured-breath sting
      // (3s, longer than the 1.5s default cap — `maxDur: 3.5` lets the
      // dying breath play out fully rather than getting clipped). Not
      // LEGO style, intentional — Vader's death is a cinematic moment
      // and the iconic film sting carries the weight better than a
      // cartoon yelp.
      // Darth Vader play: 4s of "The Imperial March" (1:47 → 1:51) — the
      // brass sting stabs on entrance. 0.05s fade-in / 0.4s fade-out baked.
      // Vader hover: 68s of John Williams' "Anakin's Betrayal" (0:00 → 1:08) —
      // the Order 66 elegy. 0.6s fade-in / 2s fade-out baked; ?v=2 busts the old
      // cached file.
      'Darth Vader':      { hover: { src: 'audio/cards/darth-vader-hover.mp3?v=2', maxDur: 68 }, play: { src: 'audio/cards/darth-vader-play.mp3', maxDur: 4.2 }, death: { src: 'audio/cards/darth-vader-death.mp3', maxDur: 3.5 } },
      // Batman hover: 1:45 of Hans Zimmer & James Newton Howard's "A
      // Watchful Guardian" (Dark Knight OST), 2:15 → 4:00 of source.
      // -20 LUFS unified-baseline, 1s fade-in / 2s fade-out. maxDur 106
      // lets the full phrase play.
      'Batman':           {
        hover: { src: 'audio/cards/batman-hover.mp3?v=2', maxDur: 106 },
        play:  { src: 'audio/cards/batman-play.mp3', maxDur: 5 },
        death: 'audio/cards/batman-death.mp3',
        // When Batman deals damage (his "Strike 1" / "Strike 2"
        // batarang throws after the Fear pick), fire the Batarangs
        // trick SFX instead of the generic procedural 'hit' synth.
        // Two short throws (0.89s each) layer cleanly over the Arkham
        // theme + ducked hover bed.
        effects: { damage: 'audio/cards/batarangs-play.mp3' },
      },
      // Mahoraga hover: the full "Sukuna vs Mahoraga" epic version (0:00 → 3:03),
      // normalised to the −20 LUFS baseline (measured −19.0), 1s fade-in / 2s
      // fade-out baked in; maxDur 183 lets the whole track run under a long
      // browse. Play: 0:53 → 0:58 of the same track — the owner's chosen
      // moment, cut to the ~5s a When Played cue should be — 0.05s / 0.4s
      // fades, measured −19.2 LUFS. (Owner: "use this song for mahoraga's
      // hover ... when played use 0:53 ... these should be like 5 seconds and
      // can be off their hover at specific parts.") attack / death keep their
      // synth cues in CARD_PROCEDURAL; this row only claims the two file events.
      'Mahoraga':         {
        hover: { src: 'audio/cards/mahoraga-hover.mp3', maxDur: 183 },
        play:  { src: 'audio/cards/mahoraga-play.mp3',  maxDur: 5 },
      },
      // Sung Jin-Woo — "Dark Aria <LV2>" (Solo Leveling). Hover is the full
      // 2:22 track, 1s in / 2s out, measured −20.0 LUFS. When Played is the
      // ARISE hit: the track sits near silence and then jumps +27.6 dB at 0:42.0
      // (measured — the largest onset in the file), so the cue is 0:42.0–0:47.0
      // with 0.05s / 0.4s fades, −19.9 LUFS. No owner timestamp was given for
      // this one; change the 42.0 in the cut if a different moment is wanted.
      // Igris and Beru carry no rows — their attack/death stay on the defaults.
      'Sung Jin-Woo':     {
        hover: { src: 'audio/cards/sung-jin-woo-hover.mp3', maxDur: 142 },
        play:  { src: 'audio/cards/sung-jin-woo-play.mp3',  maxDur: 5 },
      },
      // Spider-Man hover: first 1:20 of Danny Elfman's "Main Title"
      // (Spider-Man 2002). Normalized to -20 LUFS — the unified baseline
      // for signature cinematic hovers (Spider-Man / Anakin / Superman
      // all sit at -20). 1s fade-in / 2s fade-out baked in. maxDur 81
      // lets the full phrase play; ability slot kept for the legacy
      // Spider-Man swing cue.
      'Spider-Man':       { hover: { src: 'audio/cards/spider-man-hover.mp3?v=4', maxDur: 81 }, ability: 'audio/cards/spider-man-ability.mp3' },
      // Human Torch's flame-on cue — fired from his onPlay (abilities.js) when
      // he ignites, the same way Spider-Man / Predator fire their 'ability'.
      'Human Torch':      { ability: { src: 'audio/cards/human-torch-ability.mp3', maxDur: 4.0 } },
      // Gorr — the All-Black necrosword lashing out as he lands. 'play' fires
      // automatically from Game.playCard's wrapper (playCardSfx(name, 'play')),
      // so this is his When Played cue. 2.06s sword-slash swoosh.
      'Gorr':             { play: 'audio/cards/gorr-play.mp3' },
      // Death — the death-whistle. The full whistle plays on hover; his When
      // Played cue is the same file capped at a 2s clip (playCardSfx(name,'play')
      // fires from Game.playCard's wrapper). -20 LUFS baseline.
      'Death':            { hover: { src: 'audio/cards/death-hover.mp3', maxDur: 27 }, play: { src: 'audio/cards/death-hover.mp3', maxDur: 2.0 } },
      'Ant-Man':          { death: { src: 'audio/cards/ant-man-death.m4a', fullDuration: true } },
      // Ghostface hover: 58s of Nick Cave & The Bad Seeds' "Red Right
      // Hand" (start → 0:58 of the source — intro through the first
      // verse). -20 LUFS unified-baseline, 1s fade-in / 2s fade-out
      // baked in. maxDur 59 lets the full phrase play.
      // Ghostface play: 2.6s Voicemod-clipped "What's your favorite
      // scary movie?" stinger. Sits just under the 3s play-cap, with
      // a 0.2s fade-out baked into the encode so the tail blends out
      // cleanly. Fires every time Ghostface lands on the board.
      'Ghostface':        {
        hover: { src: 'audio/cards/ghostface-hover.mp3?v=2', maxDur: 59 },
        play:  { src: 'audio/cards/ghostface-play.mp3',  maxDur: 5.0 },
      },
      // Harley deathfall — 0.58s clip, plays whenever Harley is killed.
      // Already under the 1.5s death-cap so no maxDur needed.
      'Harley Quinn':     { death: 'audio/cards/harley-death.mp3' },
      // Joker deathfall — 0.83s clip, plays on every Joker kill.
      // Joker hover: the source file was mastered ~18 dB under every other
      // cinematic hover (measured −38.6 dB mean), and `gain` cannot rescue it —
      // the sample plays through a plain HTMLAudioElement whose volume is capped
      // at 1.0, and 0.55 (sfxVolume) × 0.85 (hover) × 6.0 already saturates that
      // ceiling, so raising the number did nothing. Fixed at the source instead:
      // the mp3 is loudnorm'd to the house −20 LUFS baseline (peak −1.6 dB, no
      // clip), which is the only lever that actually makes it louder. `?v=2`
      // busts the old quiet file from the browser + service-worker caches.
      // (User: "increase the sound of the jokers hover by a lot.")
      'Joker':            { hover: { src: 'audio/cards/joker-hover.mp3?v=2', maxDur: 46, gain: 6.0 }, play: 'audio/cards/joker-play.mp3', death: 'audio/cards/joker-death.mp3' },
      // Poison Ivy death — 0.58s clip, plays on every Ivy kill.
      // Two takes, cut to 4s each with a 0.3s fade so neither ends on a hard
      // edge; _resolveSfxEntry picks one at random per play. (Was 3.5s —
      // owner: "poison ivy voice line should be 4 seconds not 3.5". The play
      // event's own cap is 5s, so 4 plays whole and needs no maxDur here.)
      'Poison Ivy':       { death: 'audio/cards/poison-ivy-death.mp3',
                            play: ['audio/cards/poison-ivy-play-02.mp3',
                                   'audio/cards/poison-ivy-play-03.mp3'] },
      // Man-Bat death — 0.65s clip, plays on every Man-Bat kill.
      'Man-Bat':          { death: 'audio/cards/man-bat-death.mp3' },
      // Bane death — 0.58s clip, plays on every Bane kill.
      'Bane':             { hover: { src: 'audio/cards/bane-hover.mp3', maxDur: 21 }, death: 'audio/cards/bane-death.mp3' },
      'King Shark':       { play: { src: 'audio/cards/king-shark-play.mp3', fullDuration: true } },
      // Homelander hover: 65s of Christopher Lennertz's "I Can Do Anything"
      // finale from The Boys — the swelling Homelander hero-theme reprise.
      // -20 LUFS unified-baseline, 1s fade-in / 2s fade-out baked. maxDur
      // 66 lets the full phrase play across re-hovers (resume-from-pause).
      'Homelander':       { hover: { src: 'audio/cards/homelander-hover.mp3', maxDur: 66 } },
      // Omni-Man hover: 81s of Holy Fuck's "Tom Tom" (0:14 → 1:35) —
      // the percussive synth-driven build that fits Nolan Grayson's
      // menace-with-momentum. -20 LUFS, 1s fade-in / 2s fade-out
      // baked. maxDur 81 = full clip plays across re-hovers.
      'Omni-Man':         { hover: { src: 'audio/cards/omni-man-hover.mp3', maxDur: 81 } },
      // Davy Jones hover: 72s from "Davy Jones" theme (Pirates of
      // the Caribbean — Hans Zimmer / Klaus Badelt), 0:00 → 1:12 —
      // the music-box organ intro that establishes the cursed-
      // captain identity. -20 LUFS, 1s fade-in / 2s fade-out baked.
      // maxDur 72 lets the full music-box phrase play.
      'Davy Jones':       { hover: { src: 'audio/cards/davy-jones-hover.mp3', maxDur: 72 } },
      // Emperor Palpatine hover: 65s of John Williams's "The
      // Emperor" theme, 0:21 → 1:26 — the slow gregorian chant
      // build that defines Sidious's throne-room menace. -20 LUFS,
      // 1s fade-in / 2s fade-out baked. maxDur 65 lets the full
      // sustained-choir phrase play across re-hovers.
      'Emperor Palpatine': { hover: { src: 'audio/cards/emperor-palpatine-hover.mp3', maxDur: 165 }, play: { src: 'audio/cards/emperor-palpatine-play.mp3', maxDur: 5 } },
      // Wonder Woman hover: 115 s of Hans Zimmer + Junkie XL's "Is
      // She With You" — Diana's electric-cello entrance theme from
      // BvS / Wonder Woman. Clipped 0:00 → 1:55 to ride the full
      // riff build through to the percussive payoff. -20 LUFS,
      // 1s fade-in / 2s fade-out baked.
      'Wonder Woman':     { hover: { src: 'audio/cards/wonder-woman-hover.mp3', maxDur: 115 } },
      // Deadpool hover: 80 s of *NSYNC's "Bye Bye Bye" (the
      // Deadpool & Wolverine slo-mo intro track), 0:00 → 1:20 —
      // captures the iconic backing-vocal build through the first
      // full chorus. -20 LUFS, 1 s fade-in / 2 s fade-out baked.
      'Deadpool':         { hover: { src: 'audio/cards/deadpool-hover.mp3', maxDur: 80 }, play: { src: 'audio/cards/deadpool-play.mp3', maxDur: 3 } },
      // Wolverine hover: 79 s of "Like a Prayer (Choir Version)"
      // from Deadpool & Wolverine, 1:05 → 2:24 — the sustained
      // choir build that scores his entrance. Pairs intentionally
      // with Deadpool's "Bye Bye Bye" cue. -20 LUFS, 1 s fade-in /
      // 2 s fade-out baked.
      'Wolverine':        { hover: { src: 'audio/cards/wolverine-hover.mp3', maxDur: 79 } },
      // Godzilla hover: ~65s of the King-of-the-Monsters theme — the roar-and-
      // brass build that scores his arrival. maxDur lets the full phrase play.
      // Godzilla play: ~10s atomic roar. fullDuration so it isn't clipped by
      // the 5s on-play cap (he's cost-7, not a 10, so he needs the flag) — the
      // roar tails off on its own, no hard cut.
      'Godzilla':         { hover: { src: 'audio/cards/godzilla-hover.mp3', maxDur: 65 }, play: { src: 'audio/cards/godzilla-play.mp3', fullDuration: true } },
      // The Flash hover: 67 s of Junkie XL's "At the Speed of
      // Force" (Justice League / The Flash motif), 1:35 → 2:42 —
      // the percussive run sequence that scores Barry's speed-
      // force traversals. -20 LUFS, 1 s fade-in / 2 s fade-out
      // baked.
      'The Flash':        { hover: { src: 'audio/cards/the-flash-hover.mp3', maxDur: 67 } },
      // Captain America hover: 65s of Harry James's "It's Been a Long, Long
      // Time" (start → 1:05) — the period-correct cue from CA's WWII era.
      // -20 LUFS unified-baseline, 1s fade-in / 2s fade-out baked.
      'Captain America':  { hover: { src: 'audio/cards/captain-america-hover.mp3', maxDur: 66 } },
      // Optimus Prime hover: 57s of Steve Jablonsky's "Bumblebee Captured"
      // (0:24 → 1:21) — the Autobot-leader theme reprise from the
      // Transformers OST. -20 LUFS unified-baseline, 1s fade-in / 2s
      // fade-out baked.
      'Optimus Prime':    { hover: { src: 'audio/cards/optimus-prime-hover.mp3?v=2' }, play: { src: 'audio/cards/optimus-prime-play.mp3', maxDur: 5.0 } },
      // Sabertooth hover: 62s of "Logan Through Time" (0:54 → 1:56 of the
      // source). 0.4s fade-in / 1.7s fade-out baked into the file; maxDur 62
      // = full clip.
      'Sabertooth':       { hover: { src: 'audio/cards/sabertooth-hover.mp3', maxDur: 62 } },
      // Iron Man hover: 81s of AC/DC's "Shoot to Thrill" (start → 1:21) —
      // Tony's signature entrance riff. -20 LUFS unified-baseline, 1s
      // fade-in / 2s fade-out baked.
      'Iron Man':         { hover: { src: 'audio/cards/iron-man-hover.mp3', maxDur: 82 }, play: { src: 'audio/cards/iron-man-play.mp3', maxDur: 5 } },
      'Black Panther':    { hover: { src: 'audio/cards/black-panther-hover.mp3?v=2', maxDur: 236 } },
      // Jigsaw hover: 69s of Charlie Clouser's "Hello Zepp + Overture"
      // (start → 1:09) — the Saw signature theme intro. -20 LUFS unified-
      // baseline, 1s fade-in / 2s fade-out baked. maxDur 70 lets the full
      // phrase play.
      'Jigsaw':           { hover: { src: 'audio/cards/jigsaw-hover.mp3?v=1', maxDur: 70 }, play: 'audio/cards/jigsaw-play.mp3' },
      // Star-Lord hover: 65s of Redbone's "Come And Get Your Love" (start
      // → 1:05) — the GOTG opening-scene cue. -20 LUFS unified-baseline,
      // 1s fade-in / 2s fade-out baked. maxDur 66 lets the full phrase
      // play.
      'Star-Lord':        { hover: { src: 'audio/cards/star-lord-hover.mp3?v=1', maxDur: 66 } },
      // Paul Atreides hover: 1:54 of "Kiss the Ring" (1:05 → 2:59 of the
      // source). 1s fade-in / 2s fade-out + loudnorm -20 LUFS baked. Full clip.
      'Paul Atreides':    { hover: { src: 'audio/cards/paul-atreides-hover.mp3', maxDur: 114 } },
      // Hulk hover: 42s of Danny Elfman's "End Credits — From Hulk"
      // (0:27 → 1:09 of the source). -20 LUFS unified-baseline, 1s
      // fade-in / 2s fade-out baked. maxDur 43 lets the full phrase play.
      'Hulk':             { hover: { src: 'audio/cards/hulk-hover.mp3?v=1', maxDur: 43 }, play: 'audio/cards/hulk-play.mp3' },
      'Groot':            { play: { src: 'audio/cards/groot-play.mp3', maxDur: 5 } },
      'Symbiote Spider-Man': { play: { src: 'audio/cards/symbiote-spider-man-play.mp3', maxDur: 5.0 } },
      // Jango's WESTAR-34s: 2s of a blaster-pistol volley (0:20 -> 0:22 of the
      // source the owner supplied). The window is one self-contained burst —
      // silence from 19.4s, the volley starts exactly on 20.0, decays out by
      // 21.7, and the next burst does not begin until 22.3 — so neither end
      // cuts a transient. Two-pass loudnorm (linear, static gain) to -15 LUFS /
      // -4.6 dB peak, which is where the other short combat cues sit (his own
      // death is -14.3, Anakin's -14.2, the Battle Droid's -14.6).
      // maxDur 2.0 because the attack slot's DEFAULT is 1.5s (it shares the
      // death branch in playCardSfx) and would clip the tail off the volley.
      // ?v=2 because the filename did not change — see the note on The Grinch:
      // without it _bustCache leaves the URL alone, the service worker serves
      // the old bytes out of ASSET_CACHE, and the new clip never arrives.
      'Jango Fett':       { attack: { src: 'audio/cards/jango-fett-attack.mp3?v=2', maxDur: 2.0 }, death: 'audio/cards/jango-fett-death.mp3' },
      'Jason Voorhees':   { play: { src: 'audio/cards/jason-play.mp3', maxDur: 5.0 } },
      'Art the Clown':    { play: { src: 'audio/cards/art-the-clown-play.mp3', maxDur: 5.0 } },
      'Knull':            { hover: { src: 'audio/cards/knull-hover.mp3' }, play: { src: 'audio/cards/knull-play.mp3', fullDuration: true, gain: 4.5 } },
      'Galactus':         { hover: { src: 'audio/cards/galactus-hover.mp3' }, play: { src: 'audio/cards/galactus-play.mp3', maxDur: 5.0 } },
      'Dormammu':         { hover: { src: 'audio/cards/dormammu-hover.mp3' }, play: { src: 'audio/cards/dormammu-play.mp3', fullDuration: true } },
      // Michael Myers hover: 55s of John & Cody Carpenter's "The Shape
      // Returns" (start → 0:55) — the Halloween theme reborn. -20 LUFS
      // unified-baseline, 1s fade-in / 2s fade-out baked. maxDur 56 lets
      // the full phrase play; play slot keeps the existing stinger.
      'Michael Myers':    { hover: { src: 'audio/cards/michael-myers-hover.mp3?v=1', maxDur: 56 }, play: { src: 'audio/cards/michael-myers-play.mp3?v=3', maxDur: 5.3 } },
      'Thanos':           { hover: 'audio/cards/thanos-hover.mp3?v=4', ability: { src: 'audio/cards/thanos-ability.mp3?v=4', maxDur: 5 }, voiceLine: 'audio/cards/thanos-kill.mp3' },
      // Gojo hover: 59s of Lady Gaga's "Judas" (3:11 → end of source) — the
      // outro/refrain section. -20 LUFS unified-baseline, 1s fade-in / 2s
      // fade-out baked. maxDur 60 lets the full phrase play; ability slot
      // kept for the Hollow Purple cue (fires from inside abilities.js
      // when Hollow Purple resolves, not on play).
      'Gojo':             { hover: { src: 'audio/cards/gojo-hover.mp3?v=2', maxDur: 60 }, ability: { src: 'audio/cards/gojo-ability.mp3', maxDur: 4.0 } },
      // Xenomorph hover: 62 s of Jed Kurzel's "The Covenant" theme
      // (Alien: Covenant OST), 0:48 → 1:50 — the slow dread-build
      // string section that scores the xenomorph's first hunt
      // sequences. -20 LUFS, 1 s fade-in / 2 s fade-out baked.
      // Replaced an earlier shorter cue per user direction "get rid
      // of the other." Play / attack / death stay on the original
      // 1.5-3 s SFX clips with their own duration caps baked in.
      'Xenomorph':        { hover: { src: 'audio/cards/xenomorph-hover.mp3?v=2', maxDur: 62 }, play: 'audio/cards/xenomorph-play.mp3', attack: 'audio/cards/xenomorph-attack.mp3', death: 'audio/cards/xenomorph-death.mp3' },
      'Predator':         { hover: 'audio/cards/predator-hover.mp3', ability: { src: 'audio/cards/predator-ability.mp3', maxDur: 3.0 } },
      'Thor':             { hover: 'audio/cards/thor-hover.mp3', attack: { src: 'audio/cards/thor-attack.mp3', maxDur: 1.5 } },
      // Lightsaber hum — Jedi only (Yoda, Obi-Wan, Ahsoka, Anakin).
      // Yoda hover: ~51s clip. maxDur 52 lets the full phrase play.
      // The whole death-cue family follows the LEGO rule: short
      // (~1–2s native), -14 LUFS, NO baked fades (engine adds 130ms in /
      // 300ms out), bare-string registry entry. Lane-gating already
      // ensures only the highest-cost dying card per lane plays its cue,
      // so a single big combat doesn't stack overlapping LEGO yelps.
      // ---- PER-CARD EFFECT OVERRIDES ----
      // The `effects` map lets a card's source-of-effect lookup win
      // over the global EFFECT_SFX entry. Use this when a card has
      // its own thematic version of an effect (Mr. Freeze's freeze
      // gun vs a generic ice sting; Spider-Man's web freeze vs Thor's
      // lightning freeze; etc.). User spec: "the freezes are going to
      // be all different."
      'Mr. Freeze':       { play: { src: 'audio/cards/mr-freeze-play.mp3', maxDur: 4 }, effects: { freeze: 'audio/cards/mr-freeze-freeze.mp3' } },
      // Luke Skywalker hover: 98s of Samuel Kim's "A Jedi's Fury" (0:31 →
      // 2:09 of source) — the heroic-build section. -20 LUFS unified-
      // baseline, 1s fade-in / 2s fade-out baked. maxDur 99 lets the full
      // phrase play.
      'Luke Skywalker':   { hover: { src: 'audio/cards/luke-hover.mp3?v=2', maxDur: 99 } },
      'Yoda':             { hover: { src: 'audio/cards/yoda-hover.mp3', maxDur: 52 }, play: 'audio/cards/yoda-play.mp3', death: 'audio/cards/yoda-death.mp3' },
      'Darth Maul':       { hover: { src: 'audio/cards/darth-maul-hover.mp3?v=2', maxDur: 126 } },
      // Padme's blaster: the Naboo pistol volley at 0:11 -> 0:13 of the source
      // the owner supplied — trimmed at the FRONT to 11.62. The window they
      // picked holds the right shot, but a whole second lands 0.63s early:
      // silencedetect puts the silence at 10.731 -> 11.631, so taken verbatim
      // the cue would have fired most of a second after the swing that made it.
      // Starting on the transient gives 1.38s, decaying to -47 dB by the end,
      // and that is under the attack slot's 1.5s default cap so it needs no
      // maxDur of its own (unlike Jango's 2.0s volley). Two-pass loudnorm
      // (linear) to -15.2 LUFS / -5.4 dB peak — the same family as his.
      // New filename, so the global ?cv= stamp busts the cache and no per-entry
      // ?v= is needed (see the note on Gamora).
      'Padme Amidala':    { hover: { src: 'audio/cards/padme-amidala-hover.mp3', maxDur: 106 }, attack: 'audio/cards/padme-amidala-attack.mp3' },
      'General Grievous': { hover: { src: 'audio/cards/general-grievous-hover.mp3?v=3', maxDur: 50 }, kill: { src: 'audio/cards/general-grievous-kill.mp3', maxDur: 3 } },
      // maxDur 3 — the house cap for a play sting (hover beds run long, casts
      // do not). If the source runs longer it is trimmed at playback rather
      // than talking over the turn that follows it.
      // THE FULL 8.9s LINE, and fullDuration so nothing touches it. Two separate
      // cuts were stacked here: the import pipeline had trimmed the source to
      // 3.0s (the standard play-clip cap), and the registry's `maxDur: 3` then
      // armed the engine's 1s programmatic cap-fade over the last third of what
      // survived. Re-encoded from the 8.93s original at -20 LUFS with a 0.2s
      // tail (click guard only, not a fade), and fullDuration keeps the engine
      // off it. Owner: "his when played is being cut, let it play all the way
      // through." This is a deliberate exception to the ~3s play-clip rule.
      // Voldemort hover: 65s. Full clip — the hover rule caps play/attack/death
      // clips, not hovers.
      'Voldemort':        { hover: { src: 'audio/cards/voldemort-hover.mp3', maxDur: 66 }, play: { src: 'audio/cards/voldemort-play.mp3', fullDuration: true, gain: 2.5 } },
      // Obi-Wan hover: 86s of John Williams' "The Immolation Scene" (0:00 →
      // 1:26 of the source) — the Mustafar-duel elegy. 0.6s fade-in / 2s
      // fade-out baked; maxDur 86 = full clip. ?v=2 busts the old cached file.
      'Obi-Wan':          { hover: { src: 'audio/cards/obi-wan-hover.mp3?v=2', maxDur: 86 }, play: 'audio/cards/obi-wan-play.mp3', death: 'audio/cards/obi-wan-death.mp3' },
      'Ahsoka':           { hover: { src: 'audio/cards/ahsoka-hover.mp3?v=1', maxDur: 64 } },
      // Anakin Skywalker hover: 109s of John Williams' "Anakin's Dark Deeds"
      // (LSO recording) — trimmed from 2:15 to the end of the source so the
      // hover lands on the final, darker arc of the piece. -20 LUFS (unified
      // signature-hover baseline), 1s fade-in / 2s fade-out baked in.
      // maxDur 110 lets the full phrase play across re-hovers.
      'Anakin Skywalker': { hover: { src: 'audio/cards/anakin-hover.mp3?v=4', maxDur: 110 }, play: 'audio/cards/anakin-skywalker-play.mp3', death: 'audio/cards/anakin-death.mp3' },
      'Dr. Manhattan':    { hover: { src: 'audio/cards/dr-manhattan-hover.mp3', maxDur: 101, gain: 1.5 }, play: { src: 'audio/cards/dr-manhattan-play.mp3', maxDur: 5 } },
      'Red Skull':        { play: 'audio/cards/red-skull-play.mp3' },
      'Winter Soldier':   { hover: { src: 'audio/cards/winter-soldier-hover.mp3', maxDur: 338 } },
      // Superman hover: first 1:14 of Hans Zimmer's "Krypton's Last" — the
       // opening swell through the first cadence. Normalized to -20 LUFS
       // (unified signature-hover baseline), 1s fade-in / 2s fade-out baked.
       // maxDur 75 lets the full phrase play; resume-on-rehover keeps the
       // position across visits.
      // Superman play: 5s of John Williams' "Theme from Superman" (0:00 → 0:05)
      // — the fanfare hits on entrance. 0.03s fade-in / 0.6s fade-out baked.
      // ?v=3 busts the old cached play file.
      'Superman':         { hover: { src: 'audio/cards/superman-hover.mp3?v=7', maxDur: 75 }, play: { src: 'audio/cards/superman-play.mp3?v=7', fullDuration: true } },
      // The Grinch hover: 65s clip (2:10-3:15 of the source). maxDur tracks the
      // FILE — it was 44, sized to the previous 43.4s clip, which would have cut
      // this one off two thirds of the way through. ?v=2 because the filename
      // did not change; without it a cached client keeps serving the old audio
      // and the maxDur bump silently does nothing.
      'The Grinch':       { hover: { src: 'audio/cards/the-grinch-hover.mp3?v=2', maxDur: 66, gain: 1.5 } },
      // Gamora hover: 89s clip (0:42-2:11 of the source). New filename, so the
      // global ?cv= stamp handles cache-busting and no per-entry ?v= is needed.
      // No gain override: measured -14.3 dB mean / 0.0 dB peak, already louder
      // than Green Goblin below, which plays at the default 1.0. Boosting a
      // clip that peaks at full scale only feeds the master limiter.
      'Gamora':           { hover: { src: 'audio/cards/gamora-hover.mp3', maxDur: 90 } },
      'Green Goblin':     { hover: { src: 'audio/cards/green-goblin-hover.mp3', maxDur: 24 } },
      'Dr. Octopus':      { play: { src: 'audio/cards/dr-octopus-play.mp3?v=2', maxDur: 5 } },
      'Sandman':          { hover: { src: 'audio/cards/sandman-hover.mp3', maxDur: 194, gain: 1.5 }, death: { src: 'audio/cards/sandman-death.m4a', fullDuration: true, gain: 3.0 } },
      'Jack Sparrow':     { hover: { src: 'audio/cards/jack-sparrow-hover.mp3' }, play: { src: 'audio/cards/jack-sparrow-when-played.mp3' } },
      'Trigon':           { hover: { src: 'audio/cards/trigon-hover.mp3' }, play: { src: 'audio/cards/trigon-play.mp3', maxDur: 5, gain: 2.5 } },
      'Freddy Fazbear':   { hover: { src: 'audio/cards/freddy-fazbear-hover.mp3', maxDur: 31 }, play: { src: 'audio/cards/freddy-fazbear-when-played.mp3', maxDur: 5 } },
      'Freddy Krueger':   { spawn: { src: 'audio/cards/freddy-krueger-spawn.m4a', maxDur: 5.5 }, play: { src: 'audio/cards/freddy-krueger-spawn.m4a', maxDur: 5.5 } },
      'Pennywise':        { hover: { src: 'audio/cards/pennywise-hover.mp3', maxDur: 100 }, spawn: { src: 'audio/cards/pennywise-spawn.mp3', maxDur: 8.5 }, play: { src: 'audio/cards/pennywise-spawn.mp3', maxDur: 8.5 } },
      'Jaws':             { spawn: { src: 'audio/cards/jaws-spawn.mp3?v=2', maxDur: 10 }, play: { src: 'audio/cards/jaws-spawn.mp3?v=2', maxDur: 10 } },
      // Battle Droid's "roger roger" (2.5s) — fires when General Grievous
      // summons him in (see summonCard's spawn-cue hook). `play` mirrors it so
      // any future direct play of the token still has audio.
      'Battle Droid':     { spawn: { src: 'audio/cards/battle-droid-spawn.mp3', maxDur: 4 }, play: { src: 'audio/cards/battle-droid-spawn.mp3', maxDur: 4 }, death: { src: 'audio/cards/battle-droid-death.mp3', maxDur: 3 } },
      'Mace Windu':       { play: { src: 'audio/cards/mace-windu-play.mp3', maxDur: 6 } },
      // Droideka's blaster fire — played from his onBeforeAttack (see ability).
      'Droideka':         { attack: { src: 'audio/cards/droideka-attack.mp3', maxDur: 2.5 } },
      // Darkseid — sample 'play' cue overrides his procedural one (CARD_SFX
      // wins over CARD_PROCEDURAL); hover/attack/death stay synthesized there.
      'Darkseid':         { play: { src: 'audio/cards/darkseid-play.mp3', maxDur: 5 } },
      'Boiler Room':      { hover: { src: 'audio/cards/boiler-room-hover.mp3', maxDur: 25 } },
      'Sewers':           { hover: { src: 'audio/cards/sewers-hover.mp3', maxDur: 15 } },
      // Wetlands hover: 10.9s of swamp ambience — full clip, hovers are not
      // capped. Spinosaurus play (2.6s) doubles as his `spawn` cue, since the
      // only way he reaches the board is Wetlands releasing him.
      'Wetlands':         { hover: { src: 'audio/cards/wetlands-hover.mp3', maxDur: 11 } },
      'Spinosaurus':      { spawn: { src: 'audio/cards/spinosaurus-play.mp3', maxDur: 3 }, play: { src: 'audio/cards/spinosaurus-play.mp3', maxDur: 3 } },
      'Open Water':       { hover: { src: 'audio/cards/open-water-hover.mp3' } },
      'Gargantua':        { hover: { src: 'audio/cards/gargantua-hover.mp3' } },
      'Ultron':           { hover: { src: 'audio/cards/ultron-hover.mp3', maxDur: 29 } },
      'Loki':             { hover: { src: 'audio/cards/loki-hover.mp3' } },
      'Gizmo':            { hover: { src: 'audio/cards/gizmo-hover.mp3', maxDur: 62 } },
      'Stripe':           { hover: { src: 'audio/cards/stripe-hover.mp3', maxDur: 47 }, play: { src: 'audio/cards/stripe-when-played.mp3', maxDur: 4 } },
      // Iron Giant never gets a 'play' event (he's never placed) — the
      // sacrifice sting fires as 'ability' from _ironGiantIntercept's save.
      'Iron Giant':       { hover: { src: 'audio/cards/iron-giant-hover.mp3', maxDur: 45 }, ability: { src: 'audio/cards/iron-giant-sacrifice.mp3', maxDur: 3.5 } },
    },
    // Default files for the per-card events — used when a card's
    // CARD_SFX entry doesn't have that event. If neither the card-
    // specific entry nor this default is set, playCardSfx falls back
    // to a procedural synth tone (see PROC_EVENT_FALLBACK in
    // playCardSfx) so every card still has audio feedback.
    // User spec: "each card has, like, a default" — keeps all events
    // audible even for cards without a unique registered file.
    // Events: hover (5s), play, ability, death, voiceLine.
    // play XOR ability: only one fires per card play (see Game.playCard
    // hook — 'ability' if card has onPlay, else 'play').
    // voiceLine: gated to ONE per round total across both sides, awarded
    // to the highest-cost card that lands a kill (see _voiceLineDelegate).
    DEFAULT_CARD_SFX: {
      // hover is INTENTIONALLY null — a generic hover hum on every card
      // was muddy (a lightsaber-hum default made every non-Jedi card
      // sound like a Jedi). The Jedi cards still register the hum
      // explicitly below; everything else stays silent on hover unless
      // it gets its own file.
      hover:     null,
      // THE LANDING THUNK. Owner: "when a card lands in a lane sound." This is
      // the slot for it — playCardSfx resolves `reg[event] ?? DEFAULT_CARD_SFX
      // [event]`, so every card that has no play cue of its own now makes a
      // physical sound as it hits the lane instead of falling through to the
      // procedural cardPlay / cardPlayEnemy triad.
      //
      // A DEFAULT RATHER THAN A UNIVERSAL LAYER, and that is the same call this
      // registry already makes one line up: the hover default is null because
      // "a generic hover hum on every card was muddy". A card with its own
      // voice line keeps it alone rather than getting a thunk mixed under it.
      // Converted from the supplied .WAV — 155K of PCM for 1.8s, against 16K as
      // mp3, and it is fetched on every first play of most cards in the game.
      play:      'audio/cards/default-play.mp3',
      ability:   null, // procedural defaultAbility
      // Generic LEGO Luke "argh" — used for any card that doesn't have its
      // own death entry. Per-card overrides (Yoda, Anakin, Obi-Wan, ...)
      // win in playCardSfx's lookup. `?v=2` cache-busts past the previous
      // generic clip. Female-coded cards should eventually override with
      // their own LEGO clip when the assets are ready.
      death:     'audio/cards/default-death.mp3?v=2',
      voiceLine: null  // procedural kill stinger
    },

    // ===================== EFFECT SFX =====================
    // Central effect-based audio with per-source-card overrides. When
    // ANY card or trick applies one of these effects, the engine
    // wrapper below fires the corresponding cue at the moment the
    // effect actually lands. User spec: "the freezes are going to be
    // all different" — Mr. Freeze's freeze gun ≠ Black Widow's tranq
    // ≠ Thor's lightning. So each source card can override the global
    // effect sound.
    //
    // Lookup order in playEffect(name, source):
    //   1. CARD_SFX[source.name].effects[name]  — per-card override
    //   2. EFFECT_SFX[name]                     — global default
    //   3. EFFECT_PROC_FALLBACK[name]           — procedural synth
    //
    // To wire a per-card variant, add an `effects` map to the card's
    // CARD_SFX entry, e.g.:
    //   'Mr. Freeze': { effects: { freeze: 'audio/cards/mr-freeze-freeze.mp3' } }
    EFFECT_SFX: {
      // Globals are null — drop a global default in `audio/effects/<n>.mp3`
      // if you want a fallback for cards without their own override.
      freeze:      null,
      stun:        null,
      fear:        null,
      // THE ONE GLOBAL THAT IS FILLED IN. Owner: "for any mind control ability
      // once you select the ability to fire on a card this sound plays." It is
      // set here rather than on a card because mindControlCard is the single
      // door every one of them goes through — Gorilla Grodd, Luke Skywalker,
      // the Mind Stone — so a global default covers all of them, and any card
      // that later wants its own can still override it through CARD_SFX.effects
      // without this changing.
      //
      // An OBJECT, not a bare path: the clip is 2.85s and playEffect's default
      // cap is 1.5s, which would cut a hypnotic sweep in half. See the maxDur
      // handling in playEffect below.
      mindControl: { src: 'audio/effects/mind-control.mp3', maxDur: 3 },
      // Jurassic Park event fanfare — the "Welcome to Jurassic Park" line, fired
      // once from _announceHabitatEvent when that franchise's event (Wetlands or
      // Enclosure) appears. maxDur is generous so the whole line plays out; it
      // is a marquee announcement, not a one-shot tick. (Owner supplied the clip
      // and asked for it on the Jurassic Park event.)
      jurassicWelcome: { src: 'audio/jurassic-welcome.mp3', maxDur: 12 },
      // Saw event — Jigsaw's "do you want to play a game" line, fired once from
      // _announceHabitatEvent when the Saw event appears, as his card pops up.
      // (Owner supplied the clip and asked for it on the Jigsaw event.)
      sawGame: { src: 'audio/saw-play-a-game.mp3', maxDur: 8 },
      // Cog Invasion — one battle theme per VP, fired when that VP first arrives
      // ("when they are talking"). maxDur keeps it a strong arrival flourish
      // rather than hijacking the match music. (Owner supplied the four tracks.)
      cogThemeVp:       { src: 'audio/cog-theme-vp.mp3',       maxDur: 7 },
      cogThemeCfo:      { src: 'audio/cog-theme-cfo.mp3',      maxDur: 7 },
      cogThemeCj:       { src: 'audio/cog-theme-cj.mp3',       maxDur: 7 },
      cogThemeChairman: { src: 'audio/cog-theme-chairman.mp3', maxDur: 7 },
      buff:        null,
      debuff:      null,
      summon:      null,
      damage:      null,
      heal:        null,
      armor:       null,
      evade:       null,
    },
    EFFECT_PROC_FALLBACK: {
      damage: 'hit',
      heal:   'heal',
      armor:  'armor',
      evade:  'evade',
      // freeze/stun/fear/mc/buff/debuff/summon stay silent until a
      // per-card or global file is supplied. Better silent than the
      // wrong-feeling synth.
    },
    // Per-effect cooldown so a chain (e.g. Vader's 7-damage chain →
    // 7 dealDamage calls) doesn't machine-gun the SFX. 80ms gap is
    // long enough to deduplicate same-frame fires but short enough
    // that two visibly distinct effects still both play.
    _effectCooldownMs: 80,
    _lastEffectTimes: {},
    playEffect(effectName, source, opts) {
      if (!UI.settings || UI.settings.sfxVolume === 0) return null;
      const now = performance.now();
      // Per-source cooldown — was just `effectName` which dedupe'd
      // SAME-effect-from-DIFFERENT-source within 80ms. That made
      // simultaneous Fears from Batman + a trick suppress one of
      // them. Source-aware key lets parallel effects layer cleanly.
      // Same source firing the SAME effect within 80ms is still
      // suppressed (the original anti-machine-gun guard for chain
      // damage etc.).
      const sourceTag = (source && source.name) ? source.name : '_global';
      const cooldownKey = effectName + '|' + sourceTag;
      const last = this._lastEffectTimes[cooldownKey] || 0;
      if (now - last < this._effectCooldownMs) return null;
      this._lastEffectTimes[cooldownKey] = now;
      // 1. Per-source-card override (Mr. Freeze's freeze gun, etc.)
      let file = null;
      if (source && source.name) {
        const reg = this.CARD_SFX[source.name];
        if (reg && reg.effects && reg.effects[effectName]) file = reg.effects[effectName];
      }
      // 2. Global default
      if (!file) file = this.EFFECT_SFX[effectName];
      if (file) {
        // AN ENTRY MAY CARRY ITS OWN CAP. Both registries above already accept
        // `{ src, maxDur }` for exactly this reason — a clip written as a
        // sweep or a phrase is ruined by a cap set for a one-shot tick — and
        // this path only understood a bare path, so a longer effect cue had no
        // way to say so. Strings still work untouched.
        let fileMax = null;
        if (file && typeof file === 'object') { fileMax = file.maxDur; file = file.src; }
        // Effect SFX (fear, freeze, stun, damage, etc.) sit at the
        // 'effect' tier — 0.7× of base sfxVolume — so they layer
        // underneath play/voice marquee events.
        const base = { maxDur: fileMax != null ? fileMax : 1.5, fadeIn: 100, fadeOut: 200, category: 'effect' };
        const playOpts = Object.assign(base, opts || {});
        return this._playSample(file, playOpts);
      }
      // 3. Procedural fallback
      const proc = this.EFFECT_PROC_FALLBACK[effectName];
      if (proc) return this.play(proc);
      return null;
    },

    // Per-trick SFX registry. Events: hover, play.
    TRICK_SFX: {
      // Batarang spin loop — 0.89s clip, fires every time Batarangs
      // is played. Already under the 1.5s play-cap so no maxDur tweak.
      'Batarangs': {
        play: 'audio/cards/batarangs-play.mp3'
      },
      'Seismic Charge': {
        play: 'audio/cards/seismic-charge-play.mp3'
      },
      'Time Stone': {
        hover: 'audio/cards/time-stone-hover.mp3',
        play:  'audio/cards/time-stone-play.mp3'
      },
      'Reality Stone': {
        hover: 'audio/cards/reality-stone-hover.mp3',
        play:  'audio/cards/reality-stone-play.mp3'
      },
      'Space Stone': {
        hover: 'audio/cards/space-stone-hover.mp3',
        play:  'audio/cards/space-stone-play.mp3'
      },
      'Power Stone': {
        hover: 'audio/cards/power-stone-hover.mp3',
        play:  'audio/cards/power-stone-play.mp3'
      },
      'Soul Stone': {
        hover: 'audio/cards/soul-stone-hover.mp3',
        play:  'audio/cards/soul-stone-play.mp3'
      },
      'Mind Stone': {
        hover: 'audio/cards/mind-stone-hover.mp3',
        play:  'audio/cards/mind-stone-play.mp3'
      },
      // MC BALLYHOO HIMSELF — his theme, on hover. He is not a playable trick,
      // but the codex's Random Event tab renders him with the trick chrome
      // (a .trick-card carrying data-trick-name), and the hover handler routes
      // anything without data-card-name through playTrickSfx — so registering
      // him here is all it takes to let you hold the cursor on his card and
      // hear the carnival. (Owner: "if you hover over MC ballyhoo in the codex
      // that main theme plays.")
      //
      // `hover` and not `play`: hover cues are deliberately full-length and
      // resume-from-pause, which is what a 60-second theme wants, while `play`
      // is capped at 1.5s and would clip it to a stub. Moving the cursor off
      // stops it through the same _stopHover every other hover cue uses.
      'MC Ballyhoo': { hover: 'audio/ballyhoo-fanfare.mp3' },
      // SHADOW MAN — same deal as Ballyhoo directly above: not a playable card,
      // rendered with trick chrome in the codex's Random Event tab, so hover
      // routes here. `hover` (full length, resume-from-pause) and not `play`,
      // which is capped at 1.5s and would clip a theme to a stub.
      'Shadow Man': { hover: 'audio/shadow-man-theme.mp3' },
      // MC BALLYHOO'S CANDIES — one cue, all four. They are unwrapped the same
      // way whatever is inside them does, so they share a sound rather than
      // each getting a near-identical one. Registered per name because the
      // lookup is by trick name; there is no "family" key to hang it on.
      // Reaches every seat: Game.playTrick fires playTrickSfx on a successful
      // play, and that is one of the four calls installSfxBridge relays, so the
      // other three players in a 2v2 room hear it too.
      'Twice Candy':   { play: 'audio/cards/candy-play.mp3' },
      'Cashzap Candy': { play: 'audio/cards/candy-play.mp3' },
      'Vampire Candy': { play: 'audio/cards/candy-play.mp3' },
      'Bloway Candy':  { play: 'audio/cards/candy-play.mp3' },
      // THE WONDER WEAPONS FIRE DOWN THE CANDY PATH. They are cards, so they
      // were registered in CARD_SFX and played through playCardSfx from the
      // Game.playCard wrapper — and reported as silent, while the candies
      // beside them (same author, same folder, playTrickSfx) were audible.
      // Rather than keep guessing at why one path is quieter than the other in
      // a hidden test pane I cannot measure volume in, they now use the path
      // that is known to work. (Owner: "just make the sounds play for the guns
      // like you make the sound play for the candies".) The CARD_SFX entries
      // stay for hover and any other card-path lookup.
      'Ray Gun':             { play: { src: 'audio/cards/ray-gun-play.mp3', noFade: true, fullDuration: true } },
      'Thundergun':          { play: { src: 'audio/cards/thundergun-play.mp3', noFade: true, fullDuration: true } },
      'Lightning Bow':       { play: { src: 'audio/cards/lightning-bow-play.mp3', noFade: true, fullDuration: true } },
      'Wunderwaffe DG-3 JZ': { play: { src: 'audio/cards/wunderwaffe-play.mp3', noFade: true, fullDuration: true } },
      'Apothicon Servant':   { play: { src: 'audio/cards/apothicon-servant-play.mp3', noFade: true, fullDuration: true } }
    },
    DEFAULT_TRICK_SFX: { hover: null, play: null },

    // Per-character procedural cues. Middle tier in the lookup chain:
    //   CARD_SFX[name][event]  (file)        — highest priority
    //   CARD_PROCEDURAL[name][event] (fn)    — character-feel synth
    //   DEFAULT_CARD_SFX[event]  (file)      — fallback file
    //   generic procedural (cardPlay etc.)   — last-resort category cue
    // Functions are invoked with the sfx object as `this`, so they can
    // call `this._tone(...)` / `this._noise(...)` / `this.play(...)`
    // directly. Short, distinctive, "feels like the character" — not
    // claims to be the franchise audio, just evocative of it.
    CARD_PROCEDURAL: {
      // =============== STAR WARS ===============
      'Darth Vader': {
        play:   function() { this._tone({ type:'sawtooth', freq:110, freqEnd:55, dur:0.35, gain:0.22, release:0.42 }); this._tone({ type:'sine', freq:55, freqEnd:40, dur:0.5, gain:0.18, release:0.55, delay:0.05 }); this._noise({ dur:0.25, gain:0.06, highpass:60, lowpass:500, delay:0.02 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:880, freqEnd:330, dur:0.22, gain:0.14, release:0.24 }); this._noise({ dur:0.12, gain:0.08, highpass:1200, lowpass:5000 }); this._tone({ type:'sine', freq:165, dur:0.18, gain:0.14, release:0.22, delay:0.02 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.55, gain:0.18, release:0.7 }); this._tone({ type:'sine', freq:110, freqEnd:40, dur:0.8, gain:0.14, release:0.9, delay:0.1 }); },
        move:   function() { this._tone({ type:'sine', freq:82, freqEnd:55, dur:0.3, gain:0.16, release:0.34 }); this._noise({ dur:0.18, gain:0.04, highpass:80, lowpass:600, delay:0.02 }); },
      },
      'Revan': {
        play:   function() { this._tone({ type:'sawtooth', freq:110, freqEnd:55, dur:0.5, gain:0.14, release:0.6 }); this._noise({ dur:0.3, gain:0.05, highpass:80, lowpass:600, delay:0.1 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:1760, freqEnd:330, dur:0.13, gain:0.13, release:0.17 }); this._noise({ dur:0.06, gain:0.06, highpass:2500, lowpass:7000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:330, freqEnd:55, dur:1.0, gain:0.14, release:1.2 }); },
      },
      'Obi-Wan': {
        play:   function() { this._tone({ type:'triangle', freq:440, dur:0.3, gain:0.12, release:0.36 }); this._tone({ type:'sine', freq:659, dur:0.3, gain:0.08, release:0.36, delay:0.06 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:1100, freqEnd:660, dur:0.16, gain:0.11, release:0.2 }); this._noise({ dur:0.09, gain:0.05, highpass:2200, lowpass:6500 }); },
        death:  function() { this._tone({ type:'sine', freq:659, freqEnd:330, dur:1.0, gain:0.10, release:1.2 }); },
      },
      'Anakin Skywalker': {
        play:   function() { this._tone({ type:'triangle', freq:330, freqEnd:494, dur:0.28, gain:0.14, release:0.34 }); this._tone({ type:'sawtooth', freq:220, dur:0.3, gain:0.08, release:0.36, delay:0.05 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:1320, freqEnd:440, dur:0.18, gain:0.14, release:0.22 }); this._noise({ dur:0.1, gain:0.06, highpass:2000, lowpass:6000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:440, freqEnd:110, dur:0.7, gain:0.16, release:0.85 }); this._tone({ type:'sine', freq:220, freqEnd:55, dur:0.9, gain:0.12, release:1.0, delay:0.1 }); },
      },
      'Emperor Palpatine': {
        hover:  function() { this._noise({ dur:0.4, gain:0.06, highpass:1200, lowpass:5000 }); this._tone({ type:'sawtooth', freq:110, dur:0.35, gain:0.08, release:0.4 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:220, freqEnd:165, dur:0.3, gain:0.14, release:0.35 }); this._noise({ dur:0.35, gain:0.10, highpass:1500, lowpass:6000, delay:0.02 }); this._tone({ type:'sine', freq:80, dur:0.4, gain:0.12, release:0.45, delay:0.04 }); },
        attack: function() { for (let i = 0; i < 5; i++) this._noise({ dur:0.04, gain:0.09, highpass:2000, lowpass:7000, delay: i * 0.04 }); this._tone({ type:'sawtooth', freq:165, freqEnd:82, dur:0.22, gain:0.12, release:0.26 }); },
        death:  function() { this._noise({ dur:0.6, gain:0.12, highpass:200, lowpass:3000 }); this._tone({ type:'sawtooth', freq:880, freqEnd:55, dur:0.5, gain:0.16, release:0.7 }); },
      },
      // =============== MARVEL HEROES ===============
      'Thor': {
        play:   function() { this._tone({ type:'sine', freq:55, freqEnd:45, dur:0.55, gain:0.22, release:0.65 }); this._noise({ dur:0.35, gain:0.10, highpass:100, lowpass:900, delay:0.05 }); this._tone({ type:'triangle', freq:220, freqEnd:110, dur:0.3, gain:0.12, release:0.38, delay:0.08 }); },
        death:  function() { this._tone({ type:'sine', freq:165, freqEnd:40, dur:0.9, gain:0.18, release:1.1 }); this._noise({ dur:0.4, gain:0.06, highpass:80, lowpass:600, delay:0.1 }); },
      },
      'Hulk': {
        hover:  function() { this._tone({ type:'sawtooth', freq:82, dur:0.35, gain:0.10, release:0.4 }); this._tone({ type:'sawtooth', freq:110, dur:0.35, gain:0.08, release:0.4, delay:0.04 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:165, freqEnd:55, dur:0.45, gain:0.20, release:0.55 }); this._tone({ type:'sawtooth', freq:220, freqEnd:82, dur:0.4, gain:0.14, release:0.5, delay:0.03 }); this._noise({ dur:0.3, gain:0.12, highpass:100, lowpass:1400, delay:0.02 }); },
        attack: function() { this._tone({ type:'sine', freq:60, freqEnd:35, dur:0.15, gain:0.25, release:0.18 }); this._noise({ dur:0.12, gain:0.14, highpass:80, lowpass:800 }); this._tone({ type:'sawtooth', freq:220, freqEnd:80, dur:0.12, gain:0.10, release:0.15, delay:0.005 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:165, freqEnd:55, dur:0.7, gain:0.14, release:0.85 }); this._noise({ dur:0.5, gain:0.08, highpass:80, lowpass:700, delay:0.1 }); },
      },
      'Iron Man': {
        hover:  function() { this._tone({ type:'sine', freq:880, dur:0.2, gain:0.06, release:0.25 }); this._tone({ type:'sine', freq:1320, dur:0.2, gain:0.04, release:0.25, delay:0.03 }); },
        play:   function() { this._tone({ type:'sine', freq:220, freqEnd:880, dur:0.35, gain:0.14, release:0.4 }); this._tone({ type:'sine', freq:440, freqEnd:1320, dur:0.3, gain:0.08, release:0.36, delay:0.06 }); this._noise({ dur:0.15, gain:0.04, highpass:3000, lowpass:8000 }); },
        attack: function() { this._tone({ type:'sine', freq:1760, freqEnd:880, dur:0.1, gain:0.14, release:0.14 }); this._noise({ dur:0.08, gain:0.08, highpass:3500, lowpass:9000 }); this._tone({ type:'sawtooth', freq:110, dur:0.08, gain:0.10, release:0.1, delay:0.005 }); },
        death:  function() { this._tone({ type:'sine', freq:1320, freqEnd:55, dur:0.7, gain:0.16, release:0.85 }); this._noise({ dur:0.3, gain:0.05, highpass:1000, lowpass:4000, delay:0.05 }); },
      },
      'Captain America': {
        play:   function() { this._tone({ type:'triangle', freq:523, dur:0.25, gain:0.14, release:0.3 }); this._tone({ type:'triangle', freq:659, dur:0.25, gain:0.12, release:0.3, delay:0.06 }); this._tone({ type:'triangle', freq:784, dur:0.28, gain:0.10, release:0.34, delay:0.12 }); },
        attack: function() { this._tone({ type:'sine', freq:1760, freqEnd:880, dur:0.18, gain:0.14, release:0.22 }); this._tone({ type:'sine', freq:880, dur:0.25, gain:0.08, release:0.32, delay:0.03 }); this._noise({ dur:0.06, gain:0.05, highpass:4000, lowpass:9000 }); },
        death:  function() { this._tone({ type:'triangle', freq:523, freqEnd:220, dur:0.8, gain:0.12, release:1.0 }); },
      },
      'Spider-Man': {
        // ability is already file-backed (thwip)
        attack: function() { this._tone({ type:'sine', freq:1400, freqEnd:900, dur:0.1, gain:0.10, release:0.13 }); this._noise({ dur:0.05, gain:0.06, highpass:3500, lowpass:9000 }); },
        death:  function() { this._tone({ type:'sine', freq:880, freqEnd:220, dur:0.5, gain:0.12, release:0.6 }); },
      },
      'Symbiote Spider-Man': {
        hover:  function() { this._tone({ type:'sawtooth', freq:110, dur:0.3, gain:0.08, release:0.35 }); this._noise({ dur:0.25, gain:0.04, highpass:100, lowpass:1200 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:440, freqEnd:165, dur:0.15, gain:0.12, release:0.18 }); this._noise({ dur:0.12, gain:0.08, highpass:300, lowpass:2500 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.6, gain:0.14, release:0.75 }); this._noise({ dur:0.4, gain:0.06, highpass:80, lowpass:900, delay:0.05 }); },
      },
      'Wolverine': {
        play:   function() { this._noise({ dur:0.12, gain:0.12, highpass:1500, lowpass:7000 }); this._tone({ type:'sawtooth', freq:880, freqEnd:440, dur:0.15, gain:0.10, release:0.2 }); },
        attack: function() { this._noise({ dur:0.14, gain:0.14, highpass:2000, lowpass:8000 }); this._tone({ type:'sine', freq:1200, freqEnd:440, dur:0.1, gain:0.08, release:0.13 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:82, dur:0.55, gain:0.14, release:0.7 }); },
      },
      // =============== MARVEL VILLAINS ===============
      'Thanos': {
        play:   function() { this._tone({ type:'sine', freq:45, dur:0.6, gain:0.25, release:0.75 }); this._tone({ type:'sawtooth', freq:110, freqEnd:55, dur:0.5, gain:0.14, release:0.65, delay:0.05 }); this._noise({ dur:0.4, gain:0.08, highpass:40, lowpass:500, delay:0.1 }); },
        attack: function() { this._tone({ type:'sine', freq:55, freqEnd:30, dur:0.2, gain:0.30, release:0.25 }); this._noise({ dur:0.15, gain:0.16, highpass:60, lowpass:700 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:40, dur:1.0, gain:0.18, release:1.2 }); this._noise({ dur:0.6, gain:0.1, highpass:100, lowpass:2000, delay:0.2 }); },
      },
      'Magneto': {
        hover:  function() { this._tone({ type:'sawtooth', freq:110, dur:0.3, gain:0.08, release:0.35 }); this._tone({ type:'sawtooth', freq:220, dur:0.3, gain:0.05, release:0.35, delay:0.04 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:165, freqEnd:330, dur:0.4, gain:0.14, release:0.48 }); this._noise({ dur:0.25, gain:0.06, highpass:2000, lowpass:6000, delay:0.05 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:1200, freqEnd:220, dur:0.18, gain:0.13, release:0.22 }); this._noise({ dur:0.12, gain:0.08, highpass:1500, lowpass:6500 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:82, dur:0.7, gain:0.14, release:0.85 }); },
      },
      'Carnage': {
        play:   function() { this._noise({ dur:0.25, gain:0.12, highpass:600, lowpass:3500 }); this._tone({ type:'sawtooth', freq:330, freqEnd:110, dur:0.22, gain:0.12, release:0.28 }); },
        attack: function() { this._noise({ dur:0.12, gain:0.12, highpass:1000, lowpass:5000 }); this._tone({ type:'sawtooth', freq:660, freqEnd:220, dur:0.12, gain:0.10, release:0.15 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:440, freqEnd:110, dur:0.55, gain:0.14, release:0.7 }); this._noise({ dur:0.4, gain:0.08, highpass:200, lowpass:2000, delay:0.05 }); },
      },
      'Venom': {
        hover:  function() { this._noise({ dur:0.35, gain:0.06, highpass:200, lowpass:1500 }); this._tone({ type:'sawtooth', freq:82, dur:0.3, gain:0.08, release:0.35 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:220, freqEnd:82, dur:0.4, gain:0.14, release:0.5 }); this._noise({ dur:0.3, gain:0.10, highpass:150, lowpass:1800, delay:0.04 }); },
        attack: function() { this._noise({ dur:0.12, gain:0.12, highpass:400, lowpass:3000 }); this._tone({ type:'sawtooth', freq:165, freqEnd:55, dur:0.14, gain:0.12, release:0.18 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:165, freqEnd:55, dur:0.7, gain:0.14, release:0.85 }); },
      },
      'Green Goblin': {
        play:   function() { this._tone({ type:'sawtooth', freq:660, freqEnd:880, dur:0.15, gain:0.12, release:0.2 }); this._tone({ type:'sawtooth', freq:440, freqEnd:660, dur:0.15, gain:0.10, release:0.2, delay:0.08 }); this._tone({ type:'sawtooth', freq:330, freqEnd:220, dur:0.2, gain:0.08, release:0.25, delay:0.16 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:1760, freqEnd:880, dur:0.1, gain:0.12, release:0.14 }); this._noise({ dur:0.08, gain:0.06, highpass:3000, lowpass:8000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:880, freqEnd:110, dur:0.6, gain:0.14, release:0.75 }); },
      },
      // =============== DC HEROES ===============
      'Superman': {
        play:   function() { this._tone({ type:'triangle', freq:392, dur:0.18, gain:0.14, release:0.22 }); this._tone({ type:'triangle', freq:523, dur:0.2, gain:0.12, release:0.26, delay:0.06 }); this._tone({ type:'triangle', freq:784, dur:0.3, gain:0.12, release:0.38, delay:0.14 }); this._tone({ type:'sine', freq:1568, dur:0.2, gain:0.06, release:0.26, delay:0.22 }); },
        attack: function() { this._tone({ type:'sine', freq:2200, freqEnd:660, dur:0.12, gain:0.12, release:0.15 }); this._noise({ dur:0.06, gain:0.06, highpass:4000, lowpass:10000 }); this._tone({ type:'sine', freq:110, dur:0.1, gain:0.14, release:0.14, delay:0.002 }); },
        death:  function() { this._tone({ type:'triangle', freq:784, freqEnd:220, dur:0.9, gain:0.14, release:1.1 }); },
      },
      'Batman': {
        hover:  function() { this._noise({ dur:0.35, gain:0.05, highpass:100, lowpass:800 }); },
        play:   function() { this._noise({ dur:0.22, gain:0.12, highpass:400, lowpass:2500 }); this._tone({ type:'sawtooth', freq:165, freqEnd:82, dur:0.25, gain:0.10, release:0.3, delay:0.04 }); },
        attack: function() { this._tone({ type:'sine', freq:220, freqEnd:55, dur:0.11, gain:0.18, release:0.14 }); this._noise({ dur:0.08, gain:0.10, highpass:300, lowpass:2500 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.8, gain:0.14, release:1.0 }); },
      },
      'Wonder Woman': {
        play:   function() { this._tone({ type:'sine', freq:659, dur:0.2, gain:0.12, release:0.26 }); this._tone({ type:'sine', freq:988, dur:0.25, gain:0.10, release:0.32, delay:0.06 }); this._tone({ type:'sine', freq:1319, dur:0.3, gain:0.08, release:0.38, delay:0.14 }); },
        attack: function() { this._tone({ type:'sine', freq:2093, freqEnd:1046, dur:0.12, gain:0.12, release:0.16 }); this._noise({ dur:0.05, gain:0.06, highpass:4500, lowpass:10000 }); },
        death:  function() { this._tone({ type:'sine', freq:880, freqEnd:330, dur:0.85, gain:0.12, release:1.0 }); },
      },
      'The Flash': {
        play:   function() { this._tone({ type:'sine', freq:110, freqEnd:3520, dur:0.22, gain:0.14, release:0.26 }); this._noise({ dur:0.08, gain:0.05, highpass:3000, lowpass:9000 }); },
        attack: function() { this._tone({ type:'sine', freq:220, freqEnd:2640, dur:0.07, gain:0.13, release:0.1 }); this._tone({ type:'sine', freq:440, freqEnd:3520, dur:0.06, gain:0.08, release:0.09, delay:0.035 }); },
        death:  function() { this._tone({ type:'sine', freq:2200, freqEnd:110, dur:0.7, gain:0.14, release:0.85 }); },
      },
      'Davy Jones': {
        play:   function() { this._noise({ dur:0.3, gain:0.10, highpass:80, lowpass:1500 }); this._tone({ type:'triangle', freq:165, freqEnd:440, dur:0.3, gain:0.12, release:0.36, delay:0.03 }); },
        attack: function() { this._noise({ dur:0.12, gain:0.12, highpass:200, lowpass:2500 }); this._tone({ type:'triangle', freq:880, freqEnd:330, dur:0.1, gain:0.10, release:0.14 }); },
        death:  function() { this._tone({ type:'triangle', freq:440, freqEnd:110, dur:0.7, gain:0.14, release:0.85 }); },
      },
      // =============== DC VILLAINS ===============
      'Joker': {
        hover:  function() { this._tone({ type:'triangle', freq:392, freqEnd:554, dur:0.18, gain:0.08, release:0.22 }); this._tone({ type:'triangle', freq:554, freqEnd:392, dur:0.18, gain:0.06, release:0.22, delay:0.16 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:523, freqEnd:740, dur:0.25, gain:0.12, release:0.3 }); this._tone({ type:'sawtooth', freq:370, freqEnd:554, dur:0.25, gain:0.10, release:0.3, delay:0.05 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:1480, freqEnd:740, dur:0.09, gain:0.14, release:0.12 }); this._noise({ dur:0.05, gain:0.06, highpass:3000, lowpass:8000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:1175, freqEnd:110, dur:0.6, gain:0.14, release:0.75 }); this._noise({ dur:0.2, gain:0.04, highpass:500, lowpass:3000, delay:0.1 }); },
      },
      'Darkseid': {
        hover:  function() { this._tone({ type:'sawtooth', freq:55, dur:0.4, gain:0.10, release:0.45 }); this._tone({ type:'sine', freq:82, dur:0.4, gain:0.08, release:0.45, delay:0.06 }); },
        play:   function() { this._tone({ type:'sine', freq:36, dur:0.7, gain:0.26, release:0.85 }); this._tone({ type:'sawtooth', freq:82, freqEnd:55, dur:0.55, gain:0.14, release:0.7, delay:0.08 }); this._noise({ dur:0.5, gain:0.08, highpass:30, lowpass:400, delay:0.1 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:440, dur:0.22, gain:0.14, release:0.26 }); this._tone({ type:'sawtooth', freq:445, dur:0.22, gain:0.12, release:0.26, delay:0.002 }); this._tone({ type:'sine', freq:55, dur:0.22, gain:0.18, release:0.26 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:165, freqEnd:30, dur:1.1, gain:0.18, release:1.3 }); },
      },
      'Harley Quinn': {
        hover:  function() { this._tone({ type:'triangle', freq:880, freqEnd:1100, dur:0.1, gain:0.06, release:0.14 }); this._tone({ type:'triangle', freq:1100, freqEnd:880, dur:0.1, gain:0.05, release:0.14, delay:0.1 }); },
        play:   function() { this._tone({ type:'triangle', freq:660, freqEnd:990, dur:0.14, gain:0.11, release:0.18 }); this._tone({ type:'triangle', freq:880, freqEnd:1320, dur:0.14, gain:0.08, release:0.18, delay:0.06 }); },
        attack: function() { this._tone({ type:'sine', freq:165, freqEnd:80, dur:0.1, gain:0.15, release:0.13 }); this._noise({ dur:0.08, gain:0.1, highpass:300, lowpass:2500 }); },
        death:  function() { this._tone({ type:'triangle', freq:880, freqEnd:220, dur:0.55, gain:0.12, release:0.7 }); },
      },
      'Bane': {
        hover:  function() { this._noise({ dur:0.5, gain:0.06, highpass:500, lowpass:2500 }); this._tone({ type:'sawtooth', freq:82, dur:0.4, gain:0.08, release:0.45 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:110, freqEnd:55, dur:0.5, gain:0.18, release:0.6 }); this._noise({ dur:0.4, gain:0.10, highpass:300, lowpass:2000, delay:0.05 }); },
        attack: function() { this._tone({ type:'sine', freq:55, freqEnd:35, dur:0.15, gain:0.22, release:0.18 }); this._noise({ dur:0.1, gain:0.12, highpass:100, lowpass:1200 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:110, freqEnd:40, dur:0.85, gain:0.16, release:1.05 }); },
      },
      'Poison Ivy': {
        hover:  function() { this._tone({ type:'sine', freq:392, dur:0.25, gain:0.06, attack:0.02, release:0.3 }); this._tone({ type:'sine', freq:588, dur:0.25, gain:0.04, attack:0.02, release:0.3, delay:0.04 }); },
        play:   function() { this._tone({ type:'triangle', freq:440, freqEnd:660, dur:0.3, gain:0.11, release:0.36 }); this._noise({ dur:0.2, gain:0.04, highpass:2000, lowpass:6000 }); },
        attack: function() { this._tone({ type:'triangle', freq:880, freqEnd:330, dur:0.12, gain:0.10, release:0.15 }); this._noise({ dur:0.1, gain:0.06, highpass:1500, lowpass:5000 }); },
        death:  function() { this._tone({ type:'sine', freq:440, freqEnd:110, dur:0.7, gain:0.12, release:0.85 }); },
      },
      'Trigon': {
        hover:  function() { this._tone({ type:'sawtooth', freq:40, dur:0.5, gain:0.10, release:0.55 }); this._noise({ dur:0.4, gain:0.04, highpass:30, lowpass:400 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:55, freqEnd:30, dur:0.7, gain:0.22, release:0.85 }); this._noise({ dur:0.55, gain:0.10, highpass:40, lowpass:500, delay:0.05 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.2, gain:0.14, release:0.24 }); this._noise({ dur:0.15, gain:0.10, highpass:100, lowpass:1500 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:110, freqEnd:30, dur:1.0, gain:0.18, release:1.2 }); },
      },
      'Homelander': {
        hover:  function() { this._tone({ type:'sine', freq:440, dur:0.2, gain:0.06, release:0.25 }); this._tone({ type:'sine', freq:660, dur:0.2, gain:0.04, release:0.25, delay:0.03 }); },
        play:   function() { this._tone({ type:'triangle', freq:523, dur:0.25, gain:0.14, release:0.3 }); this._tone({ type:'sawtooth', freq:220, dur:0.25, gain:0.08, release:0.3, delay:0.02 }); },
        attack: function() { this._noise({ dur:0.18, gain:0.14, highpass:2500, lowpass:8000 }); this._tone({ type:'sine', freq:1760, freqEnd:440, dur:0.15, gain:0.10, release:0.18 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:660, freqEnd:110, dur:0.7, gain:0.16, release:0.85 }); },
      },
      // =============== HORROR ===============
      'Ghostface': {
        hover:  function() { this._noise({ dur:0.4, gain:0.05, highpass:400, lowpass:2500 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:2200, freqEnd:1760, dur:0.12, gain:0.12, release:0.15 }); this._noise({ dur:0.18, gain:0.08, highpass:300, lowpass:3000, delay:0.1 }); },
        attack: function() { this._noise({ dur:0.12, gain:0.12, highpass:4000, lowpass:10000 }); this._tone({ type:'sawtooth', freq:3520, freqEnd:880, dur:0.09, gain:0.10, release:0.12 }); },
        death:  function() { this._noise({ dur:0.5, gain:0.10, highpass:200, lowpass:2000 }); this._tone({ type:'sawtooth', freq:440, freqEnd:82, dur:0.5, gain:0.10, release:0.65 }); },
      },
      // =============== ANIME ===============
      'Mahoraga': {
        hover:  function() { this._tone({ type:'sine', freq:50, dur:0.4, gain:0.12, release:0.45 }); this._tone({ type:'sawtooth', freq:110, dur:0.4, gain:0.06, release:0.45, delay:0.05 }); },
        play:   function() { this._tone({ type:'sine', freq:40, dur:0.7, gain:0.26, release:0.85 }); this._tone({ type:'sawtooth', freq:82, freqEnd:110, dur:0.55, gain:0.14, release:0.65, delay:0.06 }); this._noise({ dur:0.35, gain:0.06, highpass:30, lowpass:400, delay:0.1 }); },
        attack: function() { this._tone({ type:'sine', freq:55, freqEnd:35, dur:0.18, gain:0.24, release:0.22 }); this._noise({ dur:0.14, gain:0.12, highpass:80, lowpass:900 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:40, dur:0.9, gain:0.16, release:1.1 }); },
      },
      // =============== STAR WARS (extended) ===============
      'Ahsoka': {
        play:   function() { this._tone({ type:'triangle', freq:523, freqEnd:784, dur:0.24, gain:0.12, release:0.28 }); this._tone({ type:'sine', freq:1046, dur:0.18, gain:0.06, release:0.22, delay:0.08 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:1320, freqEnd:660, dur:0.14, gain:0.11, release:0.18 }); this._noise({ dur:0.08, gain:0.05, highpass:2400, lowpass:7000 }); },
        death:  function() { this._tone({ type:'sine', freq:784, freqEnd:220, dur:0.8, gain:0.11, release:1.0 }); },
      },
      'Luke Skywalker': {
        play:   function() { this._tone({ type:'triangle', freq:392, dur:0.25, gain:0.11, release:0.3 }); this._tone({ type:'triangle', freq:588, dur:0.3, gain:0.09, release:0.36, delay:0.08 }); this._tone({ type:'sine', freq:784, dur:0.28, gain:0.06, release:0.34, delay:0.16 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:1200, freqEnd:600, dur:0.16, gain:0.11, release:0.2 }); this._noise({ dur:0.09, gain:0.05, highpass:2200, lowpass:6500 }); },
        death:  function() { this._tone({ type:'triangle', freq:659, freqEnd:220, dur:0.95, gain:0.12, release:1.15 }); },
      },
      'Jango Fett': {
        play:   function() { this._noise({ dur:0.14, gain:0.08, highpass:600, lowpass:4000 }); this._tone({ type:'sawtooth', freq:330, freqEnd:165, dur:0.18, gain:0.10, release:0.22 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.55, gain:0.14, release:0.7 }); this._noise({ dur:0.3, gain:0.06, highpass:100, lowpass:900, delay:0.05 }); },
        move:   function() { this._noise({ dur:0.3, gain:0.08, highpass:1000, lowpass:5500 }); this._tone({ type:'sawtooth', freq:440, freqEnd:880, dur:0.25, gain:0.08, release:0.3 }); },
      },
      // =============== MARVEL HEROES (extended) ===============
      'Ant-Man': {
        play:   function() { this._tone({ type:'sine', freq:1760, freqEnd:440, dur:0.18, gain:0.08, release:0.22 }); this._tone({ type:'sine', freq:880, freqEnd:220, dur:0.16, gain:0.06, release:0.2, delay:0.04 }); },
        attack: function() { this._tone({ type:'sine', freq:2200, freqEnd:1100, dur:0.1, gain:0.09, release:0.13 }); },
        death:  function() { this._tone({ type:'sine', freq:1100, freqEnd:110, dur:0.6, gain:0.1, release:0.75 }); },
      },
      'Black Panther': {
        play:   function() { this._tone({ type:'sawtooth', freq:165, freqEnd:330, dur:0.22, gain:0.12, release:0.28 }); this._noise({ dur:0.1, gain:0.06, highpass:1800, lowpass:5000, delay:0.04 }); },
        attack: function() { this._noise({ dur:0.08, gain:0.10, highpass:2500, lowpass:8000 }); this._tone({ type:'sine', freq:1200, freqEnd:400, dur:0.07, gain:0.08, release:0.1 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.6, gain:0.13, release:0.75 }); },
      },
      'Black Widow': {
        play:   function() { this._tone({ type:'sine', freq:440, dur:0.14, gain:0.10, release:0.18 }); this._noise({ dur:0.1, gain:0.04, highpass:2000, lowpass:6000, delay:0.05 }); },
        attack: function() { this._noise({ dur:0.06, gain:0.12, highpass:4000, lowpass:11000 }); this._tone({ type:'sine', freq:1760, freqEnd:440, dur:0.08, gain:0.08, release:0.11 }); },
        death:  function() { this._tone({ type:'sine', freq:660, freqEnd:220, dur:0.55, gain:0.11, release:0.7 }); },
      },
      'Deadpool': {
        play:   function() { this._tone({ type:'triangle', freq:440, freqEnd:660, dur:0.12, gain:0.10, release:0.16 }); this._tone({ type:'triangle', freq:880, freqEnd:1100, dur:0.1, gain:0.08, release:0.14, delay:0.08 }); this._tone({ type:'sine', freq:1760, dur:0.08, gain:0.05, release:0.11, delay:0.16 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:880, freqEnd:1760, dur:0.08, gain:0.10, release:0.11 }); this._noise({ dur:0.06, gain:0.06, highpass:3000, lowpass:8000 }); },
        death:  function() { this._tone({ type:'triangle', freq:880, freqEnd:110, dur:0.6, gain:0.12, release:0.75 }); this._tone({ type:'sine', freq:110, dur:0.2, gain:0.08, release:0.25, delay:0.4 }); },
      },
      'Spawn': {
        play:   function() { this._tone({ type:'sawtooth', freq:110, freqEnd:55, dur:0.4, gain:0.16, release:0.5 }); this._noise({ dur:0.22, gain:0.10, highpass:100, lowpass:1200, delay:0.04 }); },
        attack: function() { this._tone({ type:'sine', freq:70, freqEnd:40, dur:0.14, gain:0.22, release:0.17 }); this._noise({ dur:0.1, gain:0.1, highpass:150, lowpass:1200 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.75, gain:0.15, release:0.9 }); },
      },
      'Dr. Strange': {
        hover:  function() { this._tone({ type:'sine', freq:392, dur:0.3, gain:0.05, attack:0.02, release:0.35 }); this._tone({ type:'sine', freq:659, dur:0.3, gain:0.04, attack:0.02, release:0.35, delay:0.08 }); },
        play:   function() { this._tone({ type:'sine', freq:330, freqEnd:880, dur:0.35, gain:0.12, release:0.42 }); this._tone({ type:'sine', freq:660, freqEnd:1320, dur:0.3, gain:0.08, release:0.36, delay:0.08 }); this._noise({ dur:0.2, gain:0.04, highpass:3000, lowpass:9000, delay:0.02 }); },
        attack: function() { this._tone({ type:'sine', freq:1760, freqEnd:440, dur:0.14, gain:0.10, release:0.18 }); this._noise({ dur:0.08, gain:0.04, highpass:3500, lowpass:9500 }); },
        death:  function() { this._tone({ type:'sine', freq:880, freqEnd:220, dur:0.85, gain:0.12, release:1.0 }); },
      },
      'Dr. Manhattan': {
        hover:  function() { this._tone({ type:'sine', freq:220, dur:0.5, gain:0.06, attack:0.03, release:0.55 }); this._tone({ type:'sine', freq:330, dur:0.5, gain:0.04, attack:0.03, release:0.55, delay:0.04 }); },
        play:   function() { this._tone({ type:'sine', freq:110, dur:0.6, gain:0.14, attack:0.02, release:0.7 }); this._tone({ type:'sine', freq:220, dur:0.55, gain:0.10, attack:0.02, release:0.65, delay:0.04 }); this._tone({ type:'sine', freq:330, dur:0.5, gain:0.06, attack:0.02, release:0.6, delay:0.08 }); },
        attack: function() { this._tone({ type:'sine', freq:1760, freqEnd:55, dur:0.22, gain:0.12, release:0.28 }); },
        death:  function() { this._tone({ type:'sine', freq:440, freqEnd:30, dur:1.2, gain:0.14, release:1.4 }); },
      },
      'Gamora': {
        play:   function() { this._tone({ type:'sawtooth', freq:440, freqEnd:880, dur:0.18, gain:0.10, release:0.22 }); this._noise({ dur:0.08, gain:0.05, highpass:2800, lowpass:7500, delay:0.04 }); },
        attack: function() { this._noise({ dur:0.08, gain:0.10, highpass:3500, lowpass:9000 }); this._tone({ type:'sawtooth', freq:1320, freqEnd:440, dur:0.08, gain:0.10, release:0.11 }); },
        death:  function() { this._tone({ type:'sine', freq:880, freqEnd:165, dur:0.7, gain:0.12, release:0.85 }); },
      },
      'Gojo': {
        play:   function() { this._tone({ type:'sine', freq:220, freqEnd:660, dur:0.3, gain:0.12, release:0.36 }); this._tone({ type:'sine', freq:440, freqEnd:1320, dur:0.28, gain:0.08, release:0.34, delay:0.08 }); },
        attack: function() { this._tone({ type:'sine', freq:1760, freqEnd:440, dur:0.14, gain:0.12, release:0.18 }); this._noise({ dur:0.08, gain:0.05, highpass:3000, lowpass:9000 }); },
        death:  function() { this._tone({ type:'sine', freq:880, freqEnd:55, dur:1.0, gain:0.14, release:1.2 }); },
      },
      'Green Lantern': {
        play:   function() { this._tone({ type:'sine', freq:523, dur:0.22, gain:0.10, release:0.28 }); this._tone({ type:'sine', freq:659, dur:0.22, gain:0.08, release:0.28, delay:0.05 }); this._tone({ type:'sine', freq:784, dur:0.25, gain:0.06, release:0.3, delay:0.1 }); },
        attack: function() { this._tone({ type:'sine', freq:880, freqEnd:440, dur:0.15, gain:0.11, release:0.18 }); this._noise({ dur:0.06, gain:0.04, highpass:3500, lowpass:9000 }); },
        death:  function() { this._tone({ type:'sine', freq:659, freqEnd:165, dur:0.75, gain:0.12, release:0.9 }); },
      },
      'Groot': {
        hover:  function() { this._tone({ type:'sawtooth', freq:82, dur:0.3, gain:0.08, release:0.35 }); this._noise({ dur:0.25, gain:0.04, highpass:80, lowpass:800 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:110, freqEnd:220, dur:0.35, gain:0.12, release:0.42 }); this._noise({ dur:0.2, gain:0.06, highpass:100, lowpass:1200, delay:0.05 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:165, freqEnd:82, dur:0.14, gain:0.14, release:0.18 }); this._noise({ dur:0.1, gain:0.1, highpass:150, lowpass:1500 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.85, gain:0.14, release:1.05 }); this._noise({ dur:0.4, gain:0.06, highpass:80, lowpass:700, delay:0.1 }); },
      },
      'Hawkeye': {
        play:   function() { this._tone({ type:'triangle', freq:880, freqEnd:440, dur:0.14, gain:0.11, release:0.18 }); this._noise({ dur:0.08, gain:0.06, highpass:3500, lowpass:9000, delay:0.06 }); },
        attack: function() { this._tone({ type:'sine', freq:2200, freqEnd:660, dur:0.09, gain:0.12, release:0.12 }); this._noise({ dur:0.05, gain:0.06, highpass:4500, lowpass:10500 }); },
        death:  function() { this._tone({ type:'triangle', freq:660, freqEnd:165, dur:0.6, gain:0.11, release:0.75 }); },
      },
      'Hela': {
        hover:  function() { this._tone({ type:'sawtooth', freq:110, dur:0.35, gain:0.08, release:0.4 }); this._tone({ type:'sine', freq:220, dur:0.35, gain:0.05, release:0.4, delay:0.05 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:165, freqEnd:220, dur:0.4, gain:0.14, release:0.48 }); this._tone({ type:'sine', freq:82, dur:0.45, gain:0.14, release:0.55, delay:0.04 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:880, freqEnd:220, dur:0.15, gain:0.12, release:0.2 }); this._noise({ dur:0.08, gain:0.06, highpass:1500, lowpass:6000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:440, freqEnd:55, dur:0.9, gain:0.16, release:1.1 }); },
      },
      'Human Torch': {
        hover:  function() { this._noise({ dur:0.45, gain:0.07, highpass:2000, lowpass:8000 }); },
        play:   function() { this._noise({ dur:0.3, gain:0.14, highpass:1500, lowpass:7000 }); this._tone({ type:'sawtooth', freq:330, freqEnd:880, dur:0.28, gain:0.1, release:0.34, delay:0.02 }); },
        attack: function() { this._noise({ dur:0.15, gain:0.14, highpass:2000, lowpass:9000 }); this._tone({ type:'sawtooth', freq:880, freqEnd:220, dur:0.1, gain:0.08, release:0.14 }); },
        death:  function() { this._noise({ dur:0.55, gain:0.1, highpass:800, lowpass:5000 }); this._tone({ type:'sawtooth', freq:440, freqEnd:82, dur:0.5, gain:0.1, release:0.65 }); },
      },
      'Invisible Woman': {
        hover:  function() { this._tone({ type:'sine', freq:1320, dur:0.3, gain:0.04, attack:0.03, release:0.35 }); },
        play:   function() { this._tone({ type:'sine', freq:1760, freqEnd:440, dur:0.3, gain:0.08, attack:0.02, release:0.36 }); this._noise({ dur:0.18, gain:0.03, highpass:3500, lowpass:10000 }); },
        attack: function() { this._tone({ type:'sine', freq:2200, freqEnd:1100, dur:0.1, gain:0.08, release:0.14 }); },
        death:  function() { this._tone({ type:'sine', freq:1760, freqEnd:440, dur:0.7, gain:0.08, release:0.85 }); },
      },
      'Mr. Fantastic': {
        play:   function() { this._tone({ type:'sine', freq:220, freqEnd:660, dur:0.35, gain:0.10, release:0.42 }); this._tone({ type:'sine', freq:660, freqEnd:220, dur:0.3, gain:0.06, release:0.36, delay:0.08 }); },
        attack: function() { this._tone({ type:'sine', freq:1100, freqEnd:550, dur:0.12, gain:0.10, release:0.15 }); },
        death:  function() { this._tone({ type:'sine', freq:880, freqEnd:220, dur:0.7, gain:0.12, release:0.85 }); },
      },
      'Nightwing': {
        play:   function() { this._tone({ type:'triangle', freq:660, freqEnd:990, dur:0.14, gain:0.11, release:0.18 }); this._noise({ dur:0.08, gain:0.05, highpass:2500, lowpass:7000 }); },
        attack: function() { this._noise({ dur:0.06, gain:0.10, highpass:3000, lowpass:9000 }); this._tone({ type:'sine', freq:1760, freqEnd:660, dur:0.08, gain:0.08, release:0.11 }); },
        death:  function() { this._tone({ type:'triangle', freq:880, freqEnd:220, dur:0.55, gain:0.11, release:0.7 }); },
      },
      'Peacemaker': {
        play:   function() { this._tone({ type:'triangle', freq:440, dur:0.2, gain:0.12, release:0.26 }); this._tone({ type:'triangle', freq:660, dur:0.2, gain:0.09, release:0.26, delay:0.06 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:440, freqEnd:110, dur:0.08, gain:0.14, release:0.1 }); this._noise({ dur:0.06, gain:0.12, highpass:1500, lowpass:6500 }); },
        death:  function() { this._tone({ type:'triangle', freq:660, freqEnd:165, dur:0.55, gain:0.12, release:0.7 }); },
      },
      'Professor X': {
        hover:  function() { this._tone({ type:'sine', freq:220, dur:0.4, gain:0.05, attack:0.04, release:0.45 }); this._tone({ type:'sine', freq:330, dur:0.4, gain:0.04, attack:0.04, release:0.45, delay:0.05 }); },
        play:   function() { this._tone({ type:'sine', freq:220, freqEnd:440, dur:0.4, gain:0.10, attack:0.02, release:0.46 }); this._tone({ type:'sine', freq:660, dur:0.35, gain:0.06, attack:0.02, release:0.42, delay:0.06 }); },
        attack: function() { this._tone({ type:'sine', freq:1100, freqEnd:220, dur:0.18, gain:0.10, release:0.22 }); },
        death:  function() { this._tone({ type:'sine', freq:660, freqEnd:110, dur:1.0, gain:0.12, release:1.2 }); },
      },
      'Rocket Raccoon': {
        play:   function() { this._tone({ type:'triangle', freq:660, freqEnd:1100, dur:0.14, gain:0.10, release:0.18 }); this._noise({ dur:0.08, gain:0.06, highpass:1500, lowpass:7000, delay:0.05 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:660, freqEnd:220, dur:0.08, gain:0.12, release:0.11 }); this._noise({ dur:0.07, gain:0.10, highpass:1200, lowpass:6000 }); },
        death:  function() { this._tone({ type:'triangle', freq:880, freqEnd:220, dur:0.5, gain:0.11, release:0.65 }); },
      },
      'Scarlet Witch': {
        hover:  function() { this._tone({ type:'sine', freq:440, dur:0.3, gain:0.06, attack:0.02, release:0.35 }); this._tone({ type:'sine', freq:370, dur:0.3, gain:0.04, attack:0.02, release:0.35, delay:0.04 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:165, freqEnd:440, dur:0.35, gain:0.11, release:0.42 }); this._tone({ type:'sine', freq:660, freqEnd:880, dur:0.28, gain:0.08, release:0.34, delay:0.06 }); this._noise({ dur:0.15, gain:0.04, highpass:2500, lowpass:7000, delay:0.04 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:660, freqEnd:165, dur:0.14, gain:0.12, release:0.18 }); this._noise({ dur:0.08, gain:0.06, highpass:1500, lowpass:6000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:440, freqEnd:55, dur:0.95, gain:0.14, release:1.15 }); },
      },
      'Silver Surfer': {
        hover:  function() { this._tone({ type:'sine', freq:880, dur:0.3, gain:0.05, attack:0.02, release:0.35 }); this._tone({ type:'sine', freq:1320, dur:0.3, gain:0.03, attack:0.02, release:0.35, delay:0.04 }); },
        play:   function() { this._tone({ type:'sine', freq:440, freqEnd:1760, dur:0.35, gain:0.12, release:0.42 }); this._noise({ dur:0.15, gain:0.04, highpass:4000, lowpass:10000, delay:0.03 }); },
        attack: function() { this._tone({ type:'sine', freq:2200, freqEnd:880, dur:0.12, gain:0.10, release:0.15 }); this._noise({ dur:0.06, gain:0.04, highpass:4500, lowpass:10500 }); },
        death:  function() { this._tone({ type:'sine', freq:1320, freqEnd:220, dur:0.9, gain:0.12, release:1.1 }); },
      },
      'Star-Lord': {
        play:   function() { this._tone({ type:'triangle', freq:523, dur:0.18, gain:0.10, release:0.24 }); this._tone({ type:'triangle', freq:659, dur:0.18, gain:0.08, release:0.24, delay:0.06 }); this._tone({ type:'triangle', freq:784, dur:0.22, gain:0.07, release:0.28, delay:0.12 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:440, freqEnd:220, dur:0.09, gain:0.11, release:0.12 }); this._noise({ dur:0.06, gain:0.08, highpass:2000, lowpass:7500 }); },
        death:  function() { this._tone({ type:'triangle', freq:660, freqEnd:220, dur:0.55, gain:0.12, release:0.7 }); },
      },
      // =============== MARVEL VILLAINS (extended) ===============
      'Anti-Venom': {
        hover:  function() { this._tone({ type:'sine', freq:440, dur:0.3, gain:0.06, attack:0.02, release:0.35 }); this._noise({ dur:0.25, gain:0.03, highpass:2000, lowpass:6500 }); },
        play:   function() { this._tone({ type:'sine', freq:220, freqEnd:660, dur:0.4, gain:0.12, release:0.48 }); this._noise({ dur:0.2, gain:0.05, highpass:1500, lowpass:5500, delay:0.04 }); },
        attack: function() { this._noise({ dur:0.1, gain:0.10, highpass:2000, lowpass:7000 }); this._tone({ type:'sine', freq:660, freqEnd:220, dur:0.1, gain:0.09, release:0.14 }); },
        death:  function() { this._tone({ type:'sine', freq:660, freqEnd:165, dur:0.7, gain:0.12, release:0.85 }); },
      },
      'Dormammu': {
        hover:  function() { this._tone({ type:'sawtooth', freq:55, dur:0.5, gain:0.10, release:0.55 }); this._noise({ dur:0.4, gain:0.04, highpass:80, lowpass:800 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:82, freqEnd:55, dur:0.6, gain:0.16, release:0.75 }); this._tone({ type:'sawtooth', freq:165, freqEnd:110, dur:0.5, gain:0.10, release:0.6, delay:0.08 }); this._noise({ dur:0.35, gain:0.08, highpass:100, lowpass:1500, delay:0.1 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:440, freqEnd:110, dur:0.2, gain:0.14, release:0.24 }); this._noise({ dur:0.15, gain:0.10, highpass:500, lowpass:3500 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:30, dur:1.1, gain:0.18, release:1.3 }); },
      },
      'Dr. Doom': {
        play:   function() { this._tone({ type:'sawtooth', freq:165, freqEnd:220, dur:0.35, gain:0.13, release:0.42 }); this._tone({ type:'sine', freq:82, dur:0.4, gain:0.12, release:0.48, delay:0.04 }); this._noise({ dur:0.18, gain:0.05, highpass:1500, lowpass:5500, delay:0.05 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:880, freqEnd:165, dur:0.16, gain:0.13, release:0.2 }); this._noise({ dur:0.1, gain:0.06, highpass:2000, lowpass:7000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.9, gain:0.15, release:1.1 }); },
      },
      'Dr. Octopus': {
        play:   function() { this._tone({ type:'sawtooth', freq:220, freqEnd:330, dur:0.3, gain:0.12, release:0.36 }); this._tone({ type:'sawtooth', freq:165, dur:0.3, gain:0.09, release:0.36, delay:0.04 }); this._noise({ dur:0.15, gain:0.05, highpass:2000, lowpass:7000, delay:0.05 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:660, freqEnd:220, dur:0.13, gain:0.11, release:0.17 }); this._noise({ dur:0.08, gain:0.07, highpass:1500, lowpass:6000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:330, freqEnd:82, dur:0.75, gain:0.13, release:0.9 }); },
      },
      'Galactus': {
        hover:  function() { this._tone({ type:'sine', freq:30, dur:0.5, gain:0.16, release:0.55 }); },
        play:   function() { this._tone({ type:'sine', freq:25, dur:0.8, gain:0.28, release:0.95 }); this._tone({ type:'sawtooth', freq:55, freqEnd:30, dur:0.7, gain:0.14, release:0.85, delay:0.1 }); this._noise({ dur:0.55, gain:0.1, highpass:30, lowpass:350, delay:0.15 }); },
        attack: function() { this._tone({ type:'sine', freq:40, freqEnd:25, dur:0.25, gain:0.3, release:0.3 }); this._noise({ dur:0.18, gain:0.14, highpass:40, lowpass:500 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:165, freqEnd:25, dur:1.3, gain:0.2, release:1.5 }); },
      },
      'Gorr': {
        play:   function() { this._tone({ type:'sawtooth', freq:220, freqEnd:110, dur:0.4, gain:0.14, release:0.48 }); this._noise({ dur:0.28, gain:0.08, highpass:80, lowpass:1500, delay:0.04 }); },
        attack: function() { this._noise({ dur:0.12, gain:0.12, highpass:300, lowpass:3000 }); this._tone({ type:'sawtooth', freq:440, freqEnd:110, dur:0.13, gain:0.12, release:0.17 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.85, gain:0.15, release:1.05 }); },
      },
      'Paul Atreides': {
        play:   function() { this._tone({ type:'sine', freq:110, freqEnd:1760, dur:0.35, gain:0.10, release:0.42 }); this._tone({ type:'sine', freq:1760, freqEnd:110, dur:0.35, gain:0.08, release:0.42, delay:0.06 }); },
        attack: function() { this._tone({ type:'sine', freq:660, freqEnd:2200, dur:0.1, gain:0.10, release:0.14 }); },
        death:  function() { this._tone({ type:'sine', freq:880, freqEnd:55, dur:0.9, gain:0.12, release:1.1 }); },
      },
      'Knull': {
        hover:  function() { this._tone({ type:'sawtooth', freq:40, dur:0.5, gain:0.10, release:0.55 }); this._noise({ dur:0.4, gain:0.03, highpass:30, lowpass:500 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:55, freqEnd:30, dur:0.7, gain:0.22, release:0.85 }); this._noise({ dur:0.5, gain:0.08, highpass:40, lowpass:600, delay:0.08 }); },
        attack: function() { this._noise({ dur:0.14, gain:0.12, highpass:200, lowpass:2000 }); this._tone({ type:'sawtooth', freq:165, freqEnd:40, dur:0.16, gain:0.14, release:0.2 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:110, freqEnd:25, dur:1.1, gain:0.2, release:1.3 }); },
      },
      'Loki': {
        hover:  { src: 'audio/cards/loki-hover.mp3' },
        play:   function() { this._tone({ type:'triangle', freq:440, freqEnd:660, dur:0.18, gain:0.10, release:0.22 }); this._tone({ type:'triangle', freq:660, freqEnd:440, dur:0.18, gain:0.08, release:0.22, delay:0.08 }); this._tone({ type:'sine', freq:880, dur:0.12, gain:0.05, release:0.16, delay:0.18 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:660, freqEnd:330, dur:0.11, gain:0.11, release:0.14 }); },
        death:  function() { this._tone({ type:'sine', freq:880, freqEnd:220, dur:0.7, gain:0.12, release:0.85 }); },
      },
      'Red Hulk': {
        hover:  function() { this._tone({ type:'sawtooth', freq:82, dur:0.35, gain:0.11, release:0.4 }); this._noise({ dur:0.3, gain:0.05, highpass:200, lowpass:2000 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:110, freqEnd:55, dur:0.45, gain:0.20, release:0.55 }); this._noise({ dur:0.3, gain:0.14, highpass:150, lowpass:2200, delay:0.03 }); },
        attack: function() { this._tone({ type:'sine', freq:55, freqEnd:30, dur:0.16, gain:0.26, release:0.2 }); this._noise({ dur:0.12, gain:0.14, highpass:100, lowpass:1500 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:165, freqEnd:40, dur:0.8, gain:0.15, release:1.0 }); },
      },
      'Red Skull': {
        play:   function() { this._tone({ type:'sawtooth', freq:220, freqEnd:110, dur:0.35, gain:0.13, release:0.42 }); this._noise({ dur:0.2, gain:0.06, highpass:800, lowpass:4000, delay:0.04 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:660, freqEnd:165, dur:0.13, gain:0.12, release:0.17 }); this._noise({ dur:0.08, gain:0.08, highpass:1500, lowpass:6000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:330, freqEnd:55, dur:0.8, gain:0.14, release:1.0 }); },
      },
      'Sandman': {
        hover:  function() { this._noise({ dur:0.4, gain:0.06, highpass:300, lowpass:2500 }); },
        play:   function() { this._noise({ dur:0.5, gain:0.14, highpass:200, lowpass:3000 }); this._tone({ type:'sawtooth', freq:110, freqEnd:220, dur:0.35, gain:0.1, release:0.42, delay:0.05 }); },
        attack: function() { this._noise({ dur:0.14, gain:0.14, highpass:400, lowpass:3500 }); this._tone({ type:'sawtooth', freq:165, freqEnd:55, dur:0.1, gain:0.1, release:0.14 }); },
        death:  function() { this._noise({ dur:0.6, gain:0.1, highpass:200, lowpass:2500 }); },
      },
      'Ultron': {
        hover:  function() { this._tone({ type:'sawtooth', freq:220, dur:0.25, gain:0.06, release:0.3 }); this._tone({ type:'sawtooth', freq:440, dur:0.25, gain:0.05, release:0.3, delay:0.06 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:110, freqEnd:440, dur:0.35, gain:0.13, release:0.42 }); this._tone({ type:'sawtooth', freq:220, freqEnd:880, dur:0.3, gain:0.09, release:0.36, delay:0.05 }); this._noise({ dur:0.18, gain:0.06, highpass:2500, lowpass:8000, delay:0.04 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:880, freqEnd:220, dur:0.11, gain:0.12, release:0.14 }); this._noise({ dur:0.07, gain:0.08, highpass:3000, lowpass:9000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:440, freqEnd:82, dur:0.9, gain:0.15, release:1.1 }); },
      },
      // =============== DC VILLAINS (extended) ===============
      'Deathstroke': {
        play:   function() { this._tone({ type:'sawtooth', freq:220, freqEnd:110, dur:0.25, gain:0.12, release:0.3 }); this._noise({ dur:0.1, gain:0.05, highpass:2000, lowpass:6500, delay:0.04 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:440, freqEnd:110, dur:0.08, gain:0.14, release:0.1 }); this._noise({ dur:0.06, gain:0.12, highpass:1500, lowpass:6500 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:330, freqEnd:82, dur:0.7, gain:0.13, release:0.85 }); },
      },
      'Catwoman': {
        hover:  function() { this._tone({ type:'sine', freq:440, freqEnd:330, dur:0.25, gain:0.05, attack:0.02, release:0.3 }); },
        play:   function() { this._noise({ dur:0.12, gain:0.06, highpass:1500, lowpass:5500 }); this._tone({ type:'sine', freq:880, freqEnd:440, dur:0.16, gain:0.08, release:0.2, delay:0.04 }); },
        attack: function() { this._noise({ dur:0.05, gain:0.08, highpass:3000, lowpass:9000 }); this._tone({ type:'sawtooth', freq:1100, freqEnd:440, dur:0.07, gain:0.09, release:0.1 }); },
        death:  function() { this._tone({ type:'sine', freq:660, freqEnd:165, dur:0.55, gain:0.11, release:0.7 }); },
      },
      'Gorilla Grodd': {
        hover:  function() { this._tone({ type:'sawtooth', freq:110, dur:0.3, gain:0.09, release:0.35 }); this._noise({ dur:0.25, gain:0.05, highpass:80, lowpass:800 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:110, freqEnd:220, dur:0.35, gain:0.14, release:0.42 }); this._tone({ type:'sine', freq:220, dur:0.3, gain:0.08, release:0.36, delay:0.06 }); this._noise({ dur:0.18, gain:0.06, highpass:500, lowpass:3500, delay:0.05 }); },
        attack: function() { this._tone({ type:'sine', freq:110, freqEnd:40, dur:0.14, gain:0.22, release:0.18 }); this._noise({ dur:0.1, gain:0.12, highpass:150, lowpass:1500 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.85, gain:0.14, release:1.05 }); },
      },
      'Lex Luthor': {
        play:   function() { this._tone({ type:'sawtooth', freq:220, freqEnd:165, dur:0.3, gain:0.12, release:0.36 }); this._tone({ type:'sine', freq:110, dur:0.35, gain:0.1, release:0.42, delay:0.04 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:440, freqEnd:110, dur:0.14, gain:0.13, release:0.18 }); this._noise({ dur:0.09, gain:0.07, highpass:1500, lowpass:6000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.8, gain:0.14, release:1.0 }); },
      },
      'Mr. Freeze': {
        hover:  function() { this._tone({ type:'sine', freq:1760, dur:0.3, gain:0.04, attack:0.02, release:0.35 }); this._noise({ dur:0.3, gain:0.03, highpass:4000, lowpass:10000 }); },
        play:   function() { this._noise({ dur:0.35, gain:0.12, highpass:3500, lowpass:10000 }); this._tone({ type:'sine', freq:880, freqEnd:2200, dur:0.3, gain:0.1, release:0.36, delay:0.02 }); },
        attack: function() { this._tone({ type:'sine', freq:2200, freqEnd:880, dur:0.1, gain:0.1, release:0.14 }); this._noise({ dur:0.08, gain:0.08, highpass:4500, lowpass:11000 }); },
        death:  function() { this._tone({ type:'sine', freq:880, freqEnd:220, dur:0.75, gain:0.12, release:0.9 }); this._noise({ dur:0.3, gain:0.06, highpass:3000, lowpass:9000, delay:0.05 }); },
      },
      'Raven': {
        hover:  function() { this._tone({ type:'sine', freq:220, dur:0.35, gain:0.06, attack:0.03, release:0.4 }); this._tone({ type:'sine', freq:329, dur:0.35, gain:0.04, attack:0.03, release:0.4, delay:0.04 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:110, dur:0.45, gain:0.12, release:0.55 }); this._tone({ type:'sine', freq:440, freqEnd:220, dur:0.4, gain:0.08, release:0.48, delay:0.06 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:440, freqEnd:110, dur:0.13, gain:0.11, release:0.17 }); this._noise({ dur:0.08, gain:0.04, highpass:1500, lowpass:5500 }); },
        death:  function() { this._tone({ type:'sine', freq:440, freqEnd:55, dur:0.95, gain:0.12, release:1.15 }); },
      },
      'Sabertooth': {
        hover:  function() { this._tone({ type:'sawtooth', freq:110, dur:0.3, gain:0.08, release:0.35 }); this._noise({ dur:0.25, gain:0.04, highpass:100, lowpass:900 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:220, freqEnd:110, dur:0.28, gain:0.13, release:0.34 }); this._noise({ dur:0.18, gain:0.1, highpass:200, lowpass:2000, delay:0.03 }); },
        attack: function() { this._noise({ dur:0.12, gain:0.14, highpass:400, lowpass:3500 }); this._tone({ type:'sawtooth', freq:880, freqEnd:220, dur:0.09, gain:0.09, release:0.12 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:330, freqEnd:82, dur:0.75, gain:0.14, release:0.9 }); },
      },
      'Solomon Grundy': {
        hover:  function() { this._tone({ type:'sawtooth', freq:55, dur:0.5, gain:0.11, release:0.55 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:82, freqEnd:55, dur:0.55, gain:0.20, release:0.65 }); this._noise({ dur:0.35, gain:0.1, highpass:80, lowpass:800, delay:0.05 }); },
        attack: function() { this._tone({ type:'sine', freq:55, freqEnd:30, dur:0.18, gain:0.24, release:0.22 }); this._noise({ dur:0.12, gain:0.12, highpass:80, lowpass:900 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:165, freqEnd:30, dur:1.0, gain:0.18, release:1.2 }); },
      },
      'The Batman Who Laughs': {
        hover:  function() { this._tone({ type:'sawtooth', freq:110, freqEnd:165, dur:0.3, gain:0.08, release:0.35 }); this._tone({ type:'sawtooth', freq:220, freqEnd:165, dur:0.3, gain:0.05, release:0.35, delay:0.15 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:220, freqEnd:329, dur:0.3, gain:0.12, release:0.36 }); this._tone({ type:'sawtooth', freq:165, freqEnd:247, dur:0.3, gain:0.09, release:0.36, delay:0.08 }); this._noise({ dur:0.2, gain:0.05, highpass:500, lowpass:3500, delay:0.05 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:880, freqEnd:220, dur:0.12, gain:0.13, release:0.16 }); this._noise({ dur:0.08, gain:0.08, highpass:800, lowpass:5000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:1100, freqEnd:110, dur:0.8, gain:0.14, release:1.0 }); },
      },
      'The Grinch': {
        play:   function() { this._tone({ type:'triangle', freq:392, freqEnd:494, dur:0.18, gain:0.10, release:0.22 }); this._tone({ type:'triangle', freq:330, freqEnd:262, dur:0.22, gain:0.08, release:0.26, delay:0.1 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:330, freqEnd:165, dur:0.12, gain:0.10, release:0.15 }); },
        death:  function() { this._tone({ type:'triangle', freq:659, freqEnd:165, dur:0.65, gain:0.12, release:0.8 }); },
      },
      // =============== DC HEROES (extended) ===============
      'Ghost Rider': {
        hover:  function() { this._tone({ type:'sawtooth', freq:220, dur:0.25, gain:0.05, release:0.3 }); this._tone({ type:'sine', freq:880, dur:0.22, gain:0.04, release:0.28, delay:0.05 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:110, freqEnd:440, dur:0.3, gain:0.12, release:0.36 }); this._noise({ dur:0.15, gain:0.05, highpass:2500, lowpass:8000, delay:0.04 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:1100, freqEnd:220, dur:0.12, gain:0.11, release:0.15 }); this._noise({ dur:0.07, gain:0.08, highpass:2500, lowpass:9000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:440, freqEnd:82, dur:0.75, gain:0.13, release:0.9 }); },
      },
      'Martian Manhunter': {
        hover:  function() { this._tone({ type:'sine', freq:165, dur:0.35, gain:0.06, attack:0.03, release:0.4 }); this._tone({ type:'sine', freq:247, dur:0.35, gain:0.04, attack:0.03, release:0.4, delay:0.05 }); },
        play:   function() { this._tone({ type:'sine', freq:110, freqEnd:440, dur:0.45, gain:0.12, attack:0.02, release:0.52 }); this._tone({ type:'sine', freq:220, freqEnd:880, dur:0.35, gain:0.08, attack:0.02, release:0.42, delay:0.05 }); },
        attack: function() { this._tone({ type:'sine', freq:880, freqEnd:220, dur:0.14, gain:0.11, release:0.18 }); },
        death:  function() { this._tone({ type:'sine', freq:659, freqEnd:82, dur:1.0, gain:0.13, release:1.2 }); },
      },
      'Man-Bat': {
        hover:  function() { this._noise({ dur:0.25, gain:0.05, highpass:2000, lowpass:8000 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:1760, freqEnd:660, dur:0.18, gain:0.12, release:0.22 }); this._noise({ dur:0.15, gain:0.08, highpass:1000, lowpass:6500, delay:0.03 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:2200, freqEnd:880, dur:0.1, gain:0.11, release:0.14 }); this._noise({ dur:0.08, gain:0.09, highpass:2500, lowpass:9000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:1760, freqEnd:220, dur:0.7, gain:0.13, release:0.85 }); },
        move:   function() { this._noise({ dur:0.25, gain:0.07, highpass:800, lowpass:5500 }); },
      },
      // =============== HORROR (extended) ===============
      'Jason Voorhees': {
        attack: function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.18, gain:0.16, release:0.22 }); this._noise({ dur:0.12, gain:0.12, highpass:300, lowpass:3000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:40, dur:0.85, gain:0.15, release:1.05 }); },
      },
      'Michael Myers': {
        attack: function() { this._tone({ type:'sawtooth', freq:440, freqEnd:110, dur:0.13, gain:0.14, release:0.17 }); this._noise({ dur:0.09, gain:0.1, highpass:400, lowpass:3500 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.85, gain:0.15, release:1.05 }); },
      },
      'Freddy Krueger': {
        play:   function() { this._tone({ type:'sawtooth', freq:120, freqEnd:55, dur:0.45, gain:0.20, release:0.55 }); this._noise({ dur:0.32, gain:0.14, highpass:180, lowpass:2800, delay:0.05 }); },
        attack: function() { this._noise({ dur:0.15, gain:0.18, highpass:280, lowpass:3800 }); this._tone({ type:'sawtooth', freq:300, freqEnd:65, dur:0.13, gain:0.15, release:0.17 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:180, freqEnd:35, dur:0.95, gain:0.16, release:1.15 }); this._noise({ dur:0.35, gain:0.06, highpass:120, lowpass:1800, delay:0.05 }); },
      },
      'Predator': {
        play:   function() { this._noise({ dur:0.25, gain:0.05, highpass:1200, lowpass:6500 }); this._tone({ type:'sawtooth', freq:220, freqEnd:110, dur:0.25, gain:0.1, release:0.3, delay:0.04 }); },
        attack: function() { this._noise({ dur:0.11, gain:0.13, highpass:1500, lowpass:7000 }); this._tone({ type:'sawtooth', freq:880, freqEnd:220, dur:0.09, gain:0.09, release:0.12 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:330, freqEnd:55, dur:0.75, gain:0.14, release:0.9 }); this._noise({ dur:0.3, gain:0.06, highpass:400, lowpass:3000, delay:0.1 }); },
      },
      'Jigsaw': {
        hover:  function() { this._tone({ type:'sawtooth', freq:110, dur:0.3, gain:0.07, release:0.35 }); this._noise({ dur:0.25, gain:0.03, highpass:200, lowpass:1500 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:220, freqEnd:110, dur:0.3, gain:0.11, release:0.36 }); this._noise({ dur:0.18, gain:0.05, highpass:400, lowpass:3500, delay:0.04 }); },
        attack: function() { this._noise({ dur:0.1, gain:0.1, highpass:500, lowpass:4000 }); this._tone({ type:'sawtooth', freq:330, freqEnd:82, dur:0.1, gain:0.09, release:0.13 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.7, gain:0.13, release:0.85 }); },
      },
      // =============== MISC / OTHERS ===============
      'Juggernaut': {
        hover:  function() { this._tone({ type:'sawtooth', freq:82, dur:0.35, gain:0.09, release:0.4 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:110, freqEnd:55, dur:0.5, gain:0.2, release:0.6 }); this._noise({ dur:0.35, gain:0.12, highpass:100, lowpass:1500, delay:0.03 }); },
        attack: function() { this._tone({ type:'sine', freq:50, freqEnd:28, dur:0.18, gain:0.28, release:0.22 }); this._noise({ dur:0.13, gain:0.14, highpass:80, lowpass:900 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:165, freqEnd:40, dur:0.95, gain:0.18, release:1.15 }); },
      },
      'King Shark': {
        hover:  function() { this._noise({ dur:0.35, gain:0.06, highpass:100, lowpass:1500 }); this._tone({ type:'sawtooth', freq:82, dur:0.3, gain:0.08, release:0.35 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:110, freqEnd:55, dur:0.4, gain:0.16, release:0.5 }); this._noise({ dur:0.3, gain:0.12, highpass:80, lowpass:1500, delay:0.03 }); },
        attack: function() { this._tone({ type:'sine', freq:55, freqEnd:30, dur:0.14, gain:0.22, release:0.18 }); this._noise({ dur:0.1, gain:0.14, highpass:80, lowpass:1200 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:55, dur:0.75, gain:0.14, release:0.9 }); },
      },
      'Moder': {
        hover:  function() { this._tone({ type:'sawtooth', freq:110, dur:0.35, gain:0.08, release:0.4 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:165, freqEnd:220, dur:0.35, gain:0.13, release:0.42 }); this._noise({ dur:0.2, gain:0.08, highpass:200, lowpass:2500, delay:0.04 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:440, freqEnd:110, dur:0.14, gain:0.13, release:0.18 }); this._noise({ dur:0.09, gain:0.1, highpass:300, lowpass:3500 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:220, freqEnd:40, dur:0.85, gain:0.15, release:1.05 }); },
      },
      'Omni-Man': {
        hover:  function() { this._tone({ type:'sine', freq:220, dur:0.3, gain:0.06, release:0.35 }); },
        play:   function() { this._tone({ type:'triangle', freq:392, freqEnd:784, dur:0.3, gain:0.12, release:0.36 }); this._tone({ type:'sawtooth', freq:110, dur:0.35, gain:0.1, release:0.42, delay:0.04 }); },
        attack: function() { this._tone({ type:'sine', freq:2200, freqEnd:440, dur:0.12, gain:0.14, release:0.16 }); this._noise({ dur:0.08, gain:0.1, highpass:3000, lowpass:10000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:660, freqEnd:55, dur:0.9, gain:0.16, release:1.1 }); },
      },
      'Optimus Prime': {
        hover:  function() { this._tone({ type:'sawtooth', freq:165, dur:0.3, gain:0.07, release:0.35 }); this._tone({ type:'sawtooth', freq:220, dur:0.3, gain:0.05, release:0.35, delay:0.04 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:110, freqEnd:220, dur:0.3, gain:0.13, release:0.36 }); this._tone({ type:'sawtooth', freq:220, freqEnd:440, dur:0.3, gain:0.10, release:0.36, delay:0.08 }); this._noise({ dur:0.2, gain:0.07, highpass:800, lowpass:4500, delay:0.05 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:880, freqEnd:165, dur:0.14, gain:0.13, release:0.18 }); this._noise({ dur:0.09, gain:0.09, highpass:1500, lowpass:7000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:440, freqEnd:55, dur:0.95, gain:0.16, release:1.15 }); },
      },
      'Winter Soldier': {
        play:   function() { this._tone({ type:'sawtooth', freq:220, freqEnd:110, dur:0.22, gain:0.11, release:0.28 }); this._noise({ dur:0.1, gain:0.05, highpass:1200, lowpass:5500, delay:0.04 }); },
        attack: function() { this._tone({ type:'sawtooth', freq:440, freqEnd:110, dur:0.08, gain:0.14, release:0.1 }); this._noise({ dur:0.06, gain:0.1, highpass:1500, lowpass:6500 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:330, freqEnd:55, dur:0.7, gain:0.13, release:0.85 }); },
      },
      'The Thing': {
        hover:  function() { this._tone({ type:'sawtooth', freq:82, dur:0.35, gain:0.10, release:0.4 }); this._noise({ dur:0.3, gain:0.05, highpass:100, lowpass:900 }); },
        play:   function() { this._tone({ type:'sawtooth', freq:110, freqEnd:55, dur:0.45, gain:0.18, release:0.55 }); this._noise({ dur:0.3, gain:0.1, highpass:100, lowpass:1200, delay:0.05 }); },
        attack: function() { this._tone({ type:'sine', freq:60, freqEnd:30, dur:0.16, gain:0.26, release:0.2 }); this._noise({ dur:0.12, gain:0.14, highpass:80, lowpass:1000 }); },
        death:  function() { this._tone({ type:'sawtooth', freq:165, freqEnd:40, dur:0.9, gain:0.16, release:1.1 }); },
      }
    },

    // Pool of Audio elements keyed by src — up to 3 clones per file so
    // overlapping triggers don't clip each other (first free clone wins).
    _samplePool: null,
    // Tracks the currently-hovered card/trick element and the audio clone
    // its hover sound is playing from, so mouseleave can cut playback.
    _currentHoverEl: null,
    _currentHoverAudio: null,
    // Menu music — random shuffle of card hover themes. One HTMLAudioElement
    // chains tracks indefinitely: on 'ended', pick a new random hover clip
    // (never the same one back-to-back) and play it. Stops when startMatch
    // fires so gameplay audio owns the mix.
    _music: null,
    _musicWantPlay: false,
    _menuHoverLastIdx: -1,
    // MUSIC_SRC kept for the settings panel label / legacy path.
    MUSIC_SRC: 'audio/menu_music.mp3?v=6',
    // NOTE: the old MENU_HOVER_SRCS array lived here — a hand-maintained list
    // of every hover file, duplicated from CARD_SFX. It drifted five cards
    // behind the registry before anyone noticed. The rotation is now derived
    // from CARD_SFX in UI._menuCharHoverSrcs(), so adding a card with a hover
    // track is all it takes to put it on the menu. Nothing to update here.
    _pickMenuTrack() {
      // Character cards only — no tricks, Infinity Stones, or environments.
      const srcs = (UI._menuCharHoverSrcs && UI._menuCharHoverSrcs()) || [];
      if (!srcs.length) return this.MUSIC_SRC;
      let idx;
      do { idx = Math.floor(Math.random() * srcs.length); }
      while (idx === this._menuHoverLastIdx && srcs.length > 1);
      this._menuHoverLastIdx = idx;
      return srcs[idx];
    },
    // Now-playing label click → jump to a fresh RANDOM hero (was a sequential
    // step through the alphabetical list). User direction: "the menu hero
    // art/music should be random instead of alphabetical." Delegates to the
    // random picker so skip and auto-advance behave identically.
    _nextMenuTrack() {
      return this._pickMenuTrack();
    },
    // Cold-entry picker: lead with the player's pinned default hero once, then
    // hand off to the random picker ("then it becomes random after that").
    _pickMenuTrackForEntry() {
      const def = UI.settings && UI.settings.defaultMenuHero;
      if (def && !UI._menuDefaultLed) {
        const src = this._srcForHeroName(def);
        if (src) {
          UI._menuDefaultLed = true;
          const srcs = (UI._menuCharHoverSrcs && UI._menuCharHoverSrcs()) || [];
          this._menuHoverLastIdx = srcs.indexOf(src);   // next random avoids an immediate repeat
          return src;
        }
      }
      return this._pickMenuTrack();
    },
    // Resolve a hero name back to its hover-track src (reverse of _menuHoverArtName).
    _srcForHeroName(name) {
      const srcs = (UI._menuCharHoverSrcs && UI._menuCharHoverSrcs()) || [];
      for (const s of srcs) if (UI._menuHoverArtName(s) === name) return s;
      return null;
    },
    // Match load-in sting — the former menu track. Played ONCE for ~20s at
    // the first combat round of a match, then faded out. Not looped; lives
    // on its own <audio> element independent of the menu loop.
    MATCH_INTRO_SRC: 'audio/match_intro.mp3?v=2',
    MATCH_INTRO_MS: 20000,   // total on-screen time before it's fully faded

    // MC Ballyhoo's fanfare. It starts the moment he arrives and plays UNDER
    // his card rather than in front of it — the song used to run alone for ten
    // seconds before the card dropped, which is the wait the owner asked to
    // lose ("have his art immedialty shoe up").
    BALLYHOO_SRC: 'audio/ballyhoo-fanfare.mp3?v=1',
    // It only has to outlast the moment his voice cuts it
    // (BALLYHOO_VOICE_LEAD_MS), never to time anything, so this is a ceiling
    // rather than a duration and is deliberately left long.
    BALLYHOO_MS: 16000,
    // …and his voice. The fanfare is the fairground starting up; this is the
    // man himself, and it lands on the beat the card drops. The fanfare is cut
    // at that moment rather than ducked — he is talking over it otherwise, and
    // two pieces of Mario Party audio fighting each other is worse than
    // either alone. (Owner: "this sound fires and the other music stops".)
    BALLYHOO_VOICE_SRC: 'audio/ballyhoo-voice.mp3',
    // Owner: "sound when you win." Supplied as .ogg and converted — nothing
    // else in the project is ogg, and Safari's support for it is patchy enough
    // that a PWA installed on an iPhone would simply have played nothing.
    VICTORY_SRC: 'audio/win.mp3',
    // Owner: "when you click on a card." Converted from the supplied .WAV —
    // 73K of PCM against 7.5K as mp3, for a sound that fires on every tap.
    CARD_CLICK_SRC: 'audio/card-click.mp3',

    // ===================== FILE-BACKED NAMED CUES =====================
    // play(name) is otherwise a pure synth switch, so a named cue had no way to
    // be a real recording. This is the same shape EFFECT_SFX already uses one
    // tier down: a name in here is played from its file, a name absent from it
    // falls through to the switch exactly as before.
    //
    // hpHit is here because the owner asked for a sound "when the health bar
    // gets hit", and it is registered rather than patched into the two call
    // sites — the engine fires it from the FX stream and the MULTIPLAYER GUEST
    // fires it separately off a state diff (the guest runs no local engine, so
    // it never sees the event). Backing the cue itself means both inherit;
    // editing the call sites would have given the guest silence.
    //
    // cooldownMs guards against the burst: face damage arrives per lane, so up
    // to six hpHits can land in one tick. The 0.12s synth could stack; a 0.32s
    // swing six times over cannot. 60ms collapses only what is genuinely
    // simultaneous and still lets separately-timed hits read as separate.
    SAMPLE_CUES: {
      hpHit: { src: 'audio/hp-hit.mp3', maxDur: 0.6, fadeIn: 0, fadeOut: 60, cooldownMs: 60 },
      // The round announcement. There was NO round sound before this — the
      // banner was purely visual, verified by instrumenting play, _playSample
      // and HTMLMediaElement.play across a real round rollover and seeing only
      // a card hover and the combat hpHits. So this adds one rather than
      // replacing anything.
      roundStart: { src: 'audio/new-round.mp3', maxDur: 1.5, fadeIn: 0, fadeOut: 120 },
      // The Block Meter absorbing a hit — a sci-fi energy-shield activation.
      // Its OWN cue name, not 'blockFull', on purpose: play('blockFull') is
      // also reused as a triumphant sting for a TRIPLE multikill (see the
      // multikill FX), which is not a block — so backing 'blockFull' itself
      // would leak the shield whoosh onto that. This name is fired only from the
      // 'blocked' FX event, the one moment a meter caps and turns a hit aside.
      // cooldown guards the rare double-block in one tick. (User: "add this
      // sound whenever you block an attack with your block meter.")
      // category:'play' — a block is a marquee "your meter saved you" beat, not
      // a supporting layer, so it is exempt from the four-sound concurrency cap
      // (it fires mid-combat, when that cap is already full) and ducks the combat
      // noise instead of being buried under it.
      blockShield: { src: 'audio/block-full.mp3', maxDur: 2.1, fadeIn: 0, fadeOut: 150, cooldownMs: 300, category: 'play' },
    },
    // His sign-off, on the second text beat.
    BALLYHOO_VOICE2_SRC: 'audio/ballyhoo-voice-2.mp3',

    _init() {
      if (this._ctx) return true;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this._ctx = new AC();
        this._master = this._ctx.createGain();
        this._master.gain.value = (UI.settings && UI.settings.sfxVolume) ?? 0.55;
        // Master-bus limiter — catches the "wall of sound" the cue code
        // itself worries about (multi-death combat, Batman + Fear + two
        // Strikes summing past 0dBFS) before it hard-clips on destination.
        // Fast attack, musical release; transparent until things get loud.
        const comp = this._ctx.createDynamicsCompressor();
        comp.threshold.value = -10; comp.knee.value = 6; comp.ratio.value = 4;
        comp.attack.value = 0.003; comp.release.value = 0.15;
        this._master.connect(comp);
        comp.connect(this._ctx.destination);
      } catch (e) { return false; }
      return true;
    },

    setVolume(v) {
      if (!this._init()) return;
      this._master.gain.value = Math.max(0, Math.min(1, v));
    },

    // ===================== THE MIXER (Web Audio buses) =====================
    // File sounds used to play straight out of <audio> elements and fade by
    // writing element.volume on a timer. That cannot be mixed as groups, and on
    // iOS Safari element.volume is READ-ONLY (always 1) — every fade and duck in
    // this file silently did nothing on an iPhone. Each element is now routed
    // element -> its own GainNode -> a bus (music / sfx / voice) -> mix -> out.
    //
    // THE TRICK THAT KEEPS EVERY EXISTING FADE WORKING: a routed element's
    // `volume` property is redefined on that instance to read/write its
    // GainNode. All the code that already writes `el.volume` (fades, cap fades,
    // ducks, the voice channel) now drives the mixer unchanged, and the native
    // element volume is pinned at 1. Routing only happens once the context is
    // RUNNING (after the first gesture) — a suspended context would play
    // silence — and any failure leaves that element on the old native path.
    // Buses are separate from this._master (the synth's master, already at the
    // SFX volume) so the SFX setting is never applied twice.
    _MIX_BUS_OF: { voiceLine: 'voice', play: 'voice', ability: 'voice', hover: 'sfx', effect: 'sfx', death: 'sfx', music: 'music' },
    _mixReady() {
      return !this._mixOff && !!(this._ctx && this._ctx.state === 'running'
        && typeof this._ctx.createMediaElementSource === 'function');
    },
    _mixBus(name) {
      if (!this._mix) {
        const ctx = this._ctx, mix = { out: ctx.createGain() };
        mix.out.connect(ctx.destination);
        ['music', 'sfx', 'voice'].forEach(b => { mix[b] = ctx.createGain(); mix[b].connect(mix.out); });
        this._mix = mix;
      }
      return this._mix[name] || this._mix.sfx;
    },
    _route(el, bus) {
      if (!el || el._mixGain || el._mixFailed) return !!(el && el._mixGain);
      if (!this._mixReady()) return false;
      try {
        const ctx = this._ctx;
        const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
        const start = desc && desc.get ? desc.get.call(el) : 1;
        const src = ctx.createMediaElementSource(el);
        const g = ctx.createGain();
        g.gain.value = start;
        src.connect(g);
        g.connect(this._mixBus(bus));
        if (desc && desc.set) desc.set.call(el, 1);
        Object.defineProperty(el, 'volume', {
          configurable: true,
          get() { return g.gain.value; },
          set(v) { g.gain.value = Math.max(0, Math.min(1, +v || 0)); },
        });
        el._mixGain = g; el._mixBusName = bus;
        this._mixRouted = (this._mixRouted || 0) + 1;
        return true;
      } catch (e) {
        el._mixFailed = true;   // this element stays native; the rest still route
        return false;
      }
    },
    // Duck a whole bus (e.g. music under a voice line) with a smooth ramp, and
    // bring it back. No-ops off the mixer.
    _mixDuck(bus, level, ms) {
      if (!this._mix || !this._mix[bus]) return;
      const g = this._mix[bus].gain, t = this._ctx.currentTime;
      try { g.cancelScheduledValues(t); g.setTargetAtTime(level, t, (ms || 150) / 3000); } catch (e) { g.value = level; }
    },
    mixStats() {
      return { ready: this._mixReady(), routed: this._mixRouted || 0,
               buses: this._mix ? { music: this._mix.music.gain.value, sfx: this._mix.sfx.gain.value, voice: this._mix.voice.gain.value } : null };
    },

    // Autoplay policies suspend the AudioContext until a user gesture — arm it
    // on first click or keypress so later engine-triggered play() calls work.
    // Also the hook that retries menu music start once we have a gesture
    // (initial page load lands on the main menu, where we want music, but
    // Chrome/Safari refuse to autoplay MP3s until the user interacts).
    arm() {
      if (this._armed) return;
      this._armed = true;
      const resume = () => {
        this._init();
        if (this._ctx && this._ctx.state === 'suspended') {
          try { this._ctx.resume().then(() => { if (this._music) this._route(this._music, 'music'); }).catch(() => {}); } catch (e) {}
        } else if (this._music) {
          this._route(this._music, 'music');
        }
        // iOS blocks HTMLAudioElement.play() outside a user-gesture call stack.
        // Playing a silent Audio here within the gesture unlocks the pool so
        // async play() calls (combat SFX, card sounds) work on iPad/iPhone.
        try {
          const sil = new Audio();
          sil.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
          sil.volume = 0;
          const p = sil.play();
          if (p) p.then(() => { sil.pause(); sil.src = ''; }).catch(() => {});
        } catch (_) {}
        if (UI.MENU_SCORE_ON && this._musicWantPlay && UI.settings && UI.settings.menuMusic !== false && UI.settings.sfxVolume !== 0) {
          try { UI.menuScore.start(); } catch (e) {}
        }
        if (this._musicWantPlay && this._music && this._music.paused) {
          // If the track already ended while waiting for a gesture, pick a
          // new one rather than replaying the same clip from the start.
          if (this._music.ended) this._music.src = this._pickMenuTrack();
          try { this._music.play().catch(() => {}); } catch (e) {}
        }
      };
      window.addEventListener('pointerdown', resume, { passive: true });
      window.addEventListener('keydown', resume);
      // iOS/iPadOS suspends AudioContext when the screen dims or the app is
      // backgrounded. Resume it whenever the page becomes visible again so
      // card SFX don't stay silent after the user returns to the game.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          if (this._ctx && this._ctx.state === 'suspended') {
            try { this._ctx.resume().catch(() => {}); } catch (e) {}
          }
          // Re-prime the HTMLAudioElement pool so any pooled <audio> elements
          // that iOS evicted get a fresh load kick before the next SFX fires.
          if (this._samplePool) {
            this._samplePool.forEach((clones) => {
              clones.forEach(a => { if (a.networkState === 3 /* NETWORK_NO_SOURCE */) try { a.load(); } catch (_) {} });
            });
          }
        }
      }, { passive: true });
    },

    // ===================== PROCEDURAL CUES ARE OFF =====================
    // Owner: "when i tap a card i hear the sound i imported and a high pitched
    // sound, almost like a balloon letting air out ... remove all default
    // sounds that you made and leave all imported sounds."
    //
    // The blip on a tap was the hover cue, not the click: `play('cardHover')`
    // is a 260→390Hz triangle with a 520Hz sine over it, and on desktop you
    // hover a card immediately before clicking it, so the pair arrived together
    // and read as one doubled sound. Removing that one cue would have left
    // several dozen others of the same kind, which is what the instruction is
    // actually about.
    //
    // GATED AT THE SYNTH, NOT AT EACH CUE. Every procedural cue in this file
    // ends up in _tone or _noise — the play() switch, the CARD_PROCEDURAL
    // character cues, the roguelite and transition stingers. One guard here
    // therefore silences all of them provably, where deleting cases one at a
    // time would be forty edits and still miss whatever is added next. Files
    // are untouched: they go through _playSample and never reach these.
    //
    // NOT the two ambient beds. arenaHumStart and _dangerHeartbeatStart also
    // synthesise, but they are drones with their own start/stop lifecycle
    // rather than cues fired at an action, and they build their oscillators
    // directly instead of through here. Flip PROCEDURAL_CUES back to true to
    // restore every blip at once.
    PROCEDURAL_CUES: false,

    _tone({ type = 'sine', freq = 440, freqEnd = null, dur = 0.15, gain = 0.25, attack = 0.005, release = null, delay = 0, pan = 0 }) {
      if (!this.PROCEDURAL_CUES) return null;
      if (!this._init()) return;
      const ctx = this._ctx;
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
      const rel = release != null ? release : dur;
      // Per-fire gain jitter (±8%) so repeated cues — several 'hit' tones in a
      // <1s combat flurry — don't machine-gun bit-identical. Pitch stays exact
      // so musical triads (cardPlay etc.) remain in tune.
      const gj = gain * (0.92 + Math.random() * 0.16);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gj, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + rel);
      osc.connect(g);
      this._panConnect(g, pan);
      osc.start(t0); osc.stop(t0 + rel + 0.02);
    },
    // Route a node to the master bus, optionally through a StereoPanner so
    // lane-positioned combat SFX read left/right on headphones.
    _panConnect(node, pan) {
      if (pan && this._ctx.createStereoPanner) {
        const p = this._ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, pan));
        node.connect(p); p.connect(this._master);
      } else {
        node.connect(this._master);
      }
    },

    _noise({ dur = 0.12, gain = 0.12, highpass = 400, lowpass = 6000, delay = 0, pan = 0 }) {
      if (!this.PROCEDURAL_CUES) return null;
      if (!this._init()) return;
      const ctx = this._ctx;
      const t0 = ctx.currentTime + delay;
      const len = Math.ceil(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource(); src.buffer = buf;
      // Per-fire jitter — gain ±12% and filter cutoffs ±6% so stacked combat
      // noise bursts read as varied, not stamped from one sample.
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = highpass * (0.94 + Math.random() * 0.12);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';  lp.frequency.value = lowpass  * (0.94 + Math.random() * 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain * (0.88 + Math.random() * 0.24), t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(hp); hp.connect(lp); lp.connect(g);
      this._panConnect(g, pan);
      src.start(t0); src.stop(t0 + dur);
    },

    // ===================== AAA AMBIENT ARENA HUM =====================
    // Procedural drone that plays during a match — fades in at match
    // start, fades out at game-over / return-to-menu. Three layers:
    //   • Sub-pad: detuned sawtooth pair at 55 Hz / 55.4 Hz through a
    //     400 Hz lowpass. Wide, slow, "powered on" feel.
    //   • Mid pad: sine at 165 Hz, ~3% amplitude. Gives the low pad
    //     a perceivable pitch.
    //   • Shimmer: sine at 4400 Hz at 0.4% amplitude — barely audible
    //     high-end texture so the drone has air, not just rumble.
    //   • LFO: 0.13 Hz triangle modulating the sub-pad gain ±25%
    //     so the drone breathes instead of sitting flat.
    // Volume is tied to the sfxVolume master, scaled to ~7% peak so
    // it sits well behind every other game sound.
    arenaHumStart() {
      // RETIRED. Owner: "get rid of the constant hum."
      // This was a procedural drone running for the entire match — a detuned
      // 55 Hz sub-pad, a 165 Hz mid, a 4.4 kHz shimmer and a 0.13 Hz LFO — and
      // unlike every other sound in the game it never stopped. Something always
      // playing is the one thing you cannot un-hear, and it sat under the card
      // SFX and the music the whole time.
      // Killed HERE rather than at the call site so it stays dead no matter who
      // calls it, and arenaHumStop keeps working for anything already running
      // when this ships. The generator below is left intact and unreachable —
      // restoring it is deleting this return.
      const ARENA_HUM_ENABLED = false;   // flip to true to bring the hum back
      if (!ARENA_HUM_ENABLED) return;
      if (!this._init()) return;
      if (this._arenaHum) return; // already running
      if (!UI.settings || UI.settings.sfxVolume === 0) return;
      const ctx = this._ctx;
      const now = ctx.currentTime;
      // Master gain for the entire hum stack — makes it easy to fade
      // the whole thing out as one unit on stop.
      const bus = ctx.createGain();
      bus.gain.setValueAtTime(0, now);
      bus.gain.linearRampToValueAtTime(0.55, now + 1.6); // gentle fade-in
      bus.connect(this._master);
      // Lowpass on the sub-pad to keep it warm/round
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 480;
      lp.Q.value = 0.5;
      lp.connect(bus);
      // Sub-pad: two slightly-detuned saws into the lowpass
      const subA = ctx.createOscillator();
      subA.type = 'sawtooth'; subA.frequency.value = 55.0;
      const subB = ctx.createOscillator();
      subB.type = 'sawtooth'; subB.frequency.value = 55.4;
      const subGain = ctx.createGain();
      subGain.gain.setValueAtTime(0.045, now);
      subA.connect(subGain); subB.connect(subGain);
      subGain.connect(lp);
      // Mid pad: sine for pitch perception
      const mid = ctx.createOscillator();
      mid.type = 'sine'; mid.frequency.value = 165;
      const midGain = ctx.createGain();
      midGain.gain.setValueAtTime(0.025, now);
      mid.connect(midGain); midGain.connect(bus);
      // Shimmer: very quiet high sine
      const sh = ctx.createOscillator();
      sh.type = 'sine'; sh.frequency.value = 4400;
      const shGain = ctx.createGain();
      shGain.gain.setValueAtTime(0.0035, now);
      sh.connect(shGain); shGain.connect(bus);
      // LFO breathing on the sub gain — modulate ±0.012 around 0.045
      const lfo = ctx.createOscillator();
      lfo.type = 'triangle'; lfo.frequency.value = 0.13;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.012;
      lfo.connect(lfoGain);
      lfoGain.connect(subGain.gain);
      // Start everything together
      subA.start(now); subB.start(now); mid.start(now); sh.start(now); lfo.start(now);
      this._arenaHum = { bus, subA, subB, mid, sh, lfo };
      /* eslint-enable no-unreachable */
    },

    arenaHumStop() {
      const h = this._arenaHum;
      if (!h || !this._ctx) return;
      const ctx = this._ctx;
      const now = ctx.currentTime;
      // 1.4s fade-out, then disconnect
      try {
        h.bus.gain.cancelScheduledValues(now);
        h.bus.gain.setValueAtTime(h.bus.gain.value, now);
        h.bus.gain.linearRampToValueAtTime(0.0001, now + 1.4);
      } catch (e) {}
      const stopAt = now + 1.45;
      try { h.subA.stop(stopAt); h.subB.stop(stopAt); h.mid.stop(stopAt); h.sh.stop(stopAt); h.lfo.stop(stopAt); } catch (e) {}
      // Clear the handle immediately so a re-start can build a fresh
      // stack while the old one fades. The stop()-scheduled nodes will
      // GC themselves once the destination releases them.
      this._arenaHum = null;
    },

    // ===================== DANGER HEARTBEAT =====================
    // A slow procedural "lub-dub" that fades in when the PLAYER's HP is
    // critical (≤30%) so the tensest moment of a match is scored instead of
    // silent. The game already computes the critical state for the red HP
    // throb; this hooks the same beat to audio. Idempotent start/stop tied to
    // the render loop (UI.render). Felt-but-subtle — sits under combat SFX.
    _dangerHeartbeatStart() {
      if (!this._init()) return;
      if (this._dangerHeart) return;                       // already running
      if (!UI.settings || UI.settings.sfxVolume === 0) return;
      const ctx = this._ctx;
      const bus = ctx.createGain();
      bus.gain.setValueAtTime(0, ctx.currentTime);
      bus.gain.linearRampToValueAtTime(1, ctx.currentTime + 1.2);  // fade in
      bus.connect(this._master);
      const thump = (at, f0, f1, gain, dur) => {
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(f0, at);
        o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), at + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        o.connect(g); g.connect(bus);
        o.start(at); o.stop(at + dur + 0.03);
      };
      const beat = () => {
        if (!this._dangerHeart || !this._ctx) return;
        const t = this._ctx.currentTime;
        thump(t,        60, 38, 0.34, 0.17);   // lub
        thump(t + 0.21, 50, 32, 0.22, 0.15);   // dub
      };
      beat();
      this._dangerHeart = { bus, interval: setInterval(beat, 1050) };  // ~57 bpm
    },
    _dangerHeartbeatStop() {
      const h = this._dangerHeart;
      if (!h) return;
      clearInterval(h.interval);
      if (this._ctx) {
        const now = this._ctx.currentTime;
        try {
          h.bus.gain.cancelScheduledValues(now);
          h.bus.gain.setValueAtTime(h.bus.gain.value, now);
          h.bus.gain.linearRampToValueAtTime(0.0001, now + 0.5);
        } catch (e) {}
      }
      this._dangerHeart = null;
    },

    // ===================== COMBAT ANTICIPATION THUMP =====================
    // Sub-bass thump fired alongside the .combat-anticipate body class.
    // 60 Hz exp-decay sine + a soft noise tail. Brief — ~280ms total —
    // so it lands as a kick, not a drone.
    combatAnticipateThump() {
      if (!this._init()) return;
      if (!UI.settings || UI.settings.sfxVolume === 0) return;
      // Sub-bass kick — 60 Hz dropping to 38 Hz, fast attack, exp release
      this._tone({ type: 'sine', freq: 60, freqEnd: 38, dur: 0.32, gain: 0.18, attack: 0.004, release: 0.32, delay: 0 });
      // Tail noise — short, low-passed, gives the kick "body"
      this._noise({ dur: 0.16, gain: 0.05, highpass: 60, lowpass: 600, delay: 0.02 });
      // High click — 1.8kHz pip on top so the kick has presence on
      // small speakers / phones where the sub-bass is weak.
      this._tone({ type: 'triangle', freq: 1800, freqEnd: 600, dur: 0.06, gain: 0.04, attack: 0.001, release: 0.06, delay: 0 });
    },

    // Boot-sequence audio — fires when the game enters its first
    // combat phase out of trick-draft. Three layers, all timed to
    // match the visual boot sequence in style.css:
    //   - Whoosh (0-1100ms): wide-band noise sweep matching the
    //     scanline crossing the screen. Two slightly-staggered
    //     bursts at different freq bands give it a "filter sweep"
    //     feel without needing a real animated filter.
    //   - Hum (100-1900ms): low sustained pad — the "computer is
    //     powered on" baseline drone. Subtle 80→100Hz wobble.
    //   - Power-on bleep (550ms): rising sine pip at the scan peak.
    //   - Per-card ticks (1100ms+): one short blip per hand card,
    //     spaced 110ms apart matching the bootCardEnter stagger.
    // Caller passes cardCount so we generate the right number of
    // ticks. Respects the master sfx volume; bails clean if audio
    // is unsupported / muted.
    playBootSequence(cardCount) {
      if (!this._init()) return;
      if (!UI.settings || UI.settings.sfxVolume === 0) return;
      // Whoosh — two filtered noise bursts overlapping. First sits
      // low-mid, second rises into the high-mid as the scan peaks.
      this._noise({ dur: 0.85, gain: 0.08, highpass: 200,  lowpass: 1800, delay: 0.00 });
      this._noise({ dur: 0.95, gain: 0.10, highpass: 1200, lowpass: 5500, delay: 0.20 });
      // Power-on hum — long low pad, fades in slow, hangs through
      // the rest of the boot, then fades naturally.
      this._tone({ type: 'sawtooth', freq: 80,  freqEnd: 100, dur: 1.8, gain: 0.06, attack: 0.30, release: 1.8, delay: 0.10 });
      this._tone({ type: 'sine',     freq: 160, freqEnd: 200, dur: 1.8, gain: 0.04, attack: 0.30, release: 1.8, delay: 0.10 });
      // Power-on bleep — at scan peak. Quick rising sine pip.
      this._tone({ type: 'sine', freq: 440,  freqEnd: 880,  dur: 0.18, gain: 0.18, attack: 0.005, release: 0.18, delay: 0.55 });
      this._tone({ type: 'sine', freq: 880,  freqEnd: 1760, dur: 0.14, gain: 0.10, attack: 0.005, release: 0.14, delay: 0.62 });
      // Per-card ticks — terminal "blip" as each hand card lands.
      // Same 110ms stagger and 1100ms base delay as bootCardEnter.
      const n = Math.max(0, Math.min(8, cardCount | 0));
      for (let i = 0; i < n; i++) {
        const t = 1.10 + i * 0.110;
        this._tone({ type: 'square',   freq: 1800, freqEnd: 1200, dur: 0.05, gain: 0.10, attack: 0.002, release: 0.05, delay: t });
        this._tone({ type: 'triangle', freq: 600,  freqEnd: 400,  dur: 0.06, gain: 0.06, attack: 0.002, release: 0.06, delay: t + 0.005 });
      }
    },

    // Menu-nav cue — plays a sampled WAV (separate path from the procedural
    // engine since file playback is simpler via HTMLAudioElement, and
    // AudioContext decoding would add async boot cost for a single asset).
    // Volume tracks UI.settings.sfxVolume so the Settings slider controls
    // everything. A small pool of clones prevents clipping on fast clicks.
    playNav() {
      if (!UI.settings || UI.settings.sfxVolume === 0) return;
      if (!this._navPool) {
        this._navPool = [];
        for (let i = 0; i < 3; i++) {
          const a = new Audio(this.NAV_SRC);
          a.preload = 'auto';
          this._navPool.push(a);
        }
      }
      // Nav cue (Battlefront-style click) sits at ~50% of sfxVolume — a
      // little quieter than other UI cues per user feedback ("button press
      // sound a little quieter"). Was 0.9× before, now 0.5× ≈ -5 dB.
      const vol = Math.max(0, Math.min(1, (UI.settings.sfxVolume ?? 0.55) * 0.5));
      const a = this._navPool[this._navIdx];
      this._navIdx = (this._navIdx + 1) % this._navPool.length;
      try {
        a.volume = vol;
        a.currentTime = 0;
        const p = a.play();
        if (p && p.catch) p.catch(() => {}); // swallow autoplay rejections silently
      } catch (e) { /* ignore */ }
    },

    // Lazy-construct the looping <audio> element the first time music
    // starts (or the first time we remember the user wants it running).
    _ensureMusic() {
      if (this._music) return this._music;
      const a = new Audio();
      a.loop = false;
      a.preload = 'none';
      // Chain a new random hover track whenever one finishes.
      a.addEventListener('ended', () => {
        if (!this._musicWantPlay) return;
        a.src = this._pickMenuTrack();
        a.volume = this._musicTargetVol();
        try { a.play().catch(() => {}); } catch (e) {}
      });
      // Each time a track begins, swap the full-bleed hero to that card's art
      // and update the now-playing credit. Covers start, skip, and the chain.
      a.addEventListener('playing', () => {
        try { UI._updateMenuSideArt(a.currentSrc); } catch (e) {}
      });
      this._music = a;
      return a;
    },

    startMusic() {
      if (!UI.settings || UI.settings.sfxVolume === 0) { this._musicWantPlay = true; return; }
      // Menu-music toggle: when off, remember intent (so toggling back on
      // mid-menu can auto-resume) but skip actual playback.
      if (UI.settings.menuMusic === false) { this._musicWantPlay = true; return; }
      if (UI.MENU_SCORE_ON) { this._musicWantPlay = true; UI.menuScore.start(); return; }
      const a = this._ensureMusic();
      this._route(a, 'music');   // into the mixer's music bus (no-op before the first gesture)
      // Already playing a menu track? Keep it going. Navigating between menu
      // screens (main-menu → mode-select / my-decks / stats, etc.) re-calls
      // startMusic via wrapMenu — it must NOT re-roll or restart the loop, so
      // the SAME hero's track keeps playing seamlessly across screen changes.
      // Only (re)pick when nothing is playing: first entry, or returning to the
      // menu after a match (startRound's stopMusic pauses the bed).
      if (this._musicWantPlay && !a.paused && a.currentSrc) return;
      // (Re-)entering the menu cold: lead with the pinned default hero if set,
      // otherwise a fresh random hover track.
      a.src = this._pickMenuTrackForEntry();
      const target = this._musicTargetVol();
      if (this._musicFadeInterval) { clearInterval(this._musicFadeInterval); this._musicFadeInterval = null; }
      this._musicWantPlay = true;
      try {
        // Start silent, ramp up over 600ms.
        a.volume = 0;
        const p = a.play();
        // Autoplay blocks trigger a rejected promise — swallow it and rely
        // on the gesture-armed re-try in arm() to start playback once the
        // user interacts with the page.
        if (p && p.catch) p.catch(() => {});
      } catch (e) { /* ignore */ }
      this._fadeVolume(a, target, 600, '_musicFadeInterval');
    },

    // Duck the menu music — temporarily lower its volume so a hover
    // theme can sit on top without the two muddying each other. Stores
    // the original target on `_musicDuckBase` so restoreMusic can ramp
    // back to exactly where we were. Idempotent — calling duckMusic
    // twice is safe; the second call is a no-op while ducking is active.
    // User spec: "when you hover a card I'd like the main menu music
    // to be quieter so it isn't muddy."
    _VOICE_PRIORITY: { voiceLine: 3, play: 2, ability: 1 },
    _VOICE_UNDER_GAIN: 0.35,
    voiceStats() { return Object.assign({ cues: 0, replaced: 0, under: 0 }, this._voiceStat || {}); },
    _MUSIC_DUCK_FACTOR: 0.18,  // duck to ~18% of normal level (-15 dB)
    // 2026-05-19 — dropped 600 → 220 ms so the bed responds at the
    // same pace as the hover audio's 120 ms fade-in. With a 600 ms
    // duck the menu music was still loud for half a second after
    // the hover SFX started playing — felt sluggish. 220 ms keeps
    // the duck inaudible-but-responsive.
    _MUSIC_DUCK_FADE_MS: 220,
    duckMusic() {
      if (UI.MENU_SCORE_ON) { UI.menuScore.duck(true); return; }
      if (!this._music || this._music.paused) return;
      if (this._musicDucked) return;
      this._musicDucked = true;
      const fullTarget = this._musicTargetVol();
      this._musicDuckBase = fullTarget;
      const duckTarget = fullTarget * this._MUSIC_DUCK_FACTOR;
      if (this._musicFadeInterval) { clearInterval(this._musicFadeInterval); this._musicFadeInterval = null; }
      this._fadeVolume(this._music, duckTarget, this._MUSIC_DUCK_FADE_MS, '_musicFadeInterval');
    },
    restoreMusic() {
      if (UI.MENU_SCORE_ON) { UI.menuScore.duck(false); return; }
      if (!this._music || this._music.paused) { this._musicDucked = false; return; }
      if (!this._musicDucked) return;
      this._musicDucked = false;
      const fullTarget = this._musicDuckBase ?? this._musicTargetVol();
      if (this._musicFadeInterval) { clearInterval(this._musicFadeInterval); this._musicFadeInterval = null; }
      this._fadeVolume(this._music, fullTarget, this._MUSIC_DUCK_FADE_MS, '_musicFadeInterval');
    },

    // Instantly skip to a new random hover track — called when the player
    // clicks the refresh/sync button on the main menu so they can quickly
    // cycle until they hear something they like. Fades out in 250ms, then
    // fades the next track in. No-op if music isn't currently playing.
    skipMenuTrack() {
      if (UI.MENU_SCORE_ON) { if (this._musicWantPlay) UI.menuScore.next(); return; }
      if (!this._musicWantPlay) return;
      const a = this._music;
      if (!a) { this.startMusic(); return; }
      const target = this._musicTargetVol();
      if (this._musicFadeInterval) { clearInterval(this._musicFadeInterval); this._musicFadeInterval = null; }
      this._fadeVolume(a, 0, 250, '_musicFadeInterval', () => {
        try { a.pause(); } catch (_) {}
        a.src = this._pickMenuTrack();
        a.volume = 0;
        try {
          const p = a.play();
          if (p && p.catch) p.catch(() => {});
        } catch (e) {}
        this._fadeVolume(a, target, 400, '_musicFadeInterval');
      });
    },

    // Clicking the now-playing credit advances to the NEXT character track
    // (sequential). Crossfades when music is already playing; starts cold on
    // the next track if it isn't. The audio element's 'playing' listener
    // re-syncs the hero art + the '♪ Name' label automatically, so art, music,
    // and label all move together.
    nextMenuTrack() {
      if (UI.MENU_SCORE_ON) {
        if (UI.settings && (UI.settings.sfxVolume === 0 || UI.settings.menuMusic === false)) { this._musicWantPlay = true; return; }
        this._musicWantPlay = true; UI.menuScore.next(); return;
      }
      const target = this._musicTargetVol();
      const a = this._music;
      // Not currently playing (first interaction, or stopped) — start fresh on
      // the next sequential track. Honor the menu-music toggle being off.
      if (!a || a.paused || !this._musicWantPlay) {
        if (UI.settings && (UI.settings.sfxVolume === 0 || UI.settings.menuMusic === false)) { this._musicWantPlay = true; return; }
        const el = this._ensureMusic();
        el.src = this._nextMenuTrack();
        el.volume = 0;
        this._musicWantPlay = true;
        if (this._musicFadeInterval) { clearInterval(this._musicFadeInterval); this._musicFadeInterval = null; }
        try { const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
        this._fadeVolume(el, target, 350, '_musicFadeInterval');
        return;
      }
      // Playing — quick crossfade to the next track.
      if (this._musicFadeInterval) { clearInterval(this._musicFadeInterval); this._musicFadeInterval = null; }
      this._fadeVolume(a, 0, 200, '_musicFadeInterval', () => {
        try { a.pause(); } catch (_) {}
        a.src = this._nextMenuTrack();
        a.volume = 0;
        try { const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
        this._fadeVolume(a, target, 350, '_musicFadeInterval');
      });
    },

    // Smoothly switch the menu loop to a specific hover track — used by the
    // 3-card hover preview and the trio re-roll. No-op if already playing it.
    crossfadeTo(src) {
      if (UI.MENU_SCORE_ON) return;   // the menu plays the score, never a card's track
      if (!UI.settings || UI.settings.sfxVolume === 0) { this._musicWantPlay = true; return; }
      if (UI.settings.menuMusic === false) { this._musicWantPlay = true; return; }
      if (!src) return;
      const a = this._ensureMusic();
      const base = (u) => String(u || '').split('/').pop().split('?')[0];
      if (base(a.currentSrc || a.src) === base(src) && !a.paused && a.volume > 0.02) return;
      this._musicWantPlay = true;
      const target = this._musicTargetVol();
      if (this._musicFadeInterval) { clearInterval(this._musicFadeInterval); this._musicFadeInterval = null; }
      const swap = () => {
        a.src = src; a.volume = 0;
        try { const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
        this._fadeVolume(a, target, 360, '_musicFadeInterval');
      };
      if (a.paused || a.volume < 0.04) swap();
      else this._fadeVolume(a, 0, 200, '_musicFadeInterval', swap);
    },

    stopMusic() {
      this._musicWantPlay = false;
      try { UI.menuScore.stop(1.2); } catch (e) {}
      // Leaving the menu (→ match). Re-arm the default-hero lead so the next
      // cold menu entry greets the player with their pinned hero again.
      UI._menuDefaultLed = false;
      try { UI._updateNowPlaying(null); } catch (e) {}
      if (!this._music) return;
      const a = this._music;
      if (this._musicFadeInterval) { clearInterval(this._musicFadeInterval); this._musicFadeInterval = null; }
      // Fade the loop out over 400ms before pausing — keeps the menu-to-
      // round transition feeling cinematic instead of a silence drop.
      const restoreVol = this._musicTargetVol();
      this._fadeVolume(a, 0, 600, '_musicFadeInterval', () => {
        try { a.pause(); a.currentTime = 0; a.volume = restoreVol; } catch (e) {}
      });
    },

    // Target playback level for the music bed (menu loop + match intro).
    // Independent of the SFX slider: driven by the dedicated Music slider so
    // a player can run loud music + quiet effects (or the reverse). The SFX
    // slider at 0 still acts as the master kill-switch ("0 silences audio
    // entirely"). 0.35 keeps music under nav/combat cues at full music vol.
    _musicTargetVol() {
      if (!UI.settings || UI.settings.sfxVolume === 0) return 0;   // master mute
      const mv = (UI.settings.musicVolume != null) ? UI.settings.musicVolume : 0.55;
      return Math.max(0, Math.min(1, mv * 0.35));
    },
    setMusicVolume() {
      try { UI.menuScore.setLevel(.15); } catch (e) {}
      if (!this._music) return;
      this._music.volume = this._musicTargetVol();
    },

    // ---- Match load-in cue ------------------------------------------------
    // Plays the former menu track for ~20s as combat begins (first round of
    // a match), then fades out. One-shot, non-looping, on its own <audio>
    // element so it's fully independent of the menu loop (which has just
    // faded out via stopMusic). Sits at the menu-bed level (0.35×) so combat
    // SFX still cut through. Respects the same toggles as the menu music.
    _matchIntro: null,
    _matchIntroTimer: null,
    // Same shape as playMatchIntro: its own Audio element, faded in, faded out
    // on a timer, and never stacked — two Ballyhoos overlapping would be a mess
    // and he can only turn up once a match anyway.
    playBallyhooFanfare() {
      try {
        // MASTER MUTE ONLY. This used to bail on `menuMusic === false` and fade
        // to _musicTargetVol(), both inherited from playMatchIntro — and both
        // wrong here. menuMusic is a preference about background music in the
        // MENU; MC Ballyhoo's theme is a gameplay event cue, so anyone with that
        // toggle off got the card and the voice with dead silence where the
        // 10-second lead-in should be. And _musicTargetVol() is musicVolume x
        // 0.35 — about 0.19 at defaults — a level chosen to sit UNDER a menu,
        // not to announce anything. (Owner: "never heard his theme play".)
        if (!UI.settings || UI.settings.sfxVolume === 0) return;
        this.stopBallyhooFanfare();
        const a = new Audio(this.BALLYHOO_SRC);
        a.loop = false;
        a.preload = 'auto';
        this._ballyhoo = a;
        // Mixed like a card cue, not like background music, with a floor so it
        // can never come in as a whisper.
        const sv = (UI.settings.sfxVolume != null) ? UI.settings.sfxVolume : 0.55;
        const target = Math.max(0.4, Math.min(1, sv * 0.95));
        // GET THE MENU LOOP OUT OF THE WAY. If it is playing, two pieces of
        // music fight for the same ten seconds and neither reads. Paused, not
        // stopped, so it picks up where it left off when he is done.
        try {
          if (this._music && !this._music.paused) { this._music.pause(); this._ballyhooDuckedMusic = true; }
        } catch (e) {}
        a.volume = 0;
        try { a.currentTime = 0; } catch (e) {}
        const p = a.play();
        if (p && p.catch) p.catch(() => {});
        this._fadeVolume(a, target, 400, '_ballyhooFade');
        const total = this.BALLYHOO_MS || 9000;
        const fadeOutMs = 2000;
        this._ballyhooTimer = setTimeout(() => {
          this._ballyhooTimer = null;
          if (this._ballyhoo !== a) return;
          this._fadeVolume(a, 0, fadeOutMs, '_ballyhooFade', () => {
            try { a.pause(); a.currentTime = 0; } catch (e) {}
            if (this._ballyhoo === a) this._ballyhoo = null;
          });
        }, Math.max(0, total - fadeOutMs));
      } catch (e) { /* a fanfare is never worth an exception */ }
    },
    // SHADOW MAN'S THEME. Plays for as long as he is actually on screen rather
    // than for a fixed length: the caller passes the duration of his reveals,
    // because "arrive" is two text beats and "return" is one.
    SHADOW_SRC: 'audio/shadow-man-theme.mp3?v=1',
    playShadowTheme(ms) {
      try {
        // MASTER MUTE ONLY — deliberately NOT gated on settings.menuMusic. That
        // toggle is about background music in the MENU; this is a gameplay event
        // cue, and gating on it is exactly what made Ballyhoo's theme silent.
        if (!UI.settings || UI.settings.sfxVolume === 0) return;
        this.stopShadowTheme();
        const a = new Audio(this.SHADOW_SRC);
        // Loops because his reveals can outlast a short track; the explicit
        // stop below is what ends it, not the file's length.
        a.loop = true;
        a.preload = 'auto';
        this._shadowTheme = a;
        // Mixed as a cue with a floor, not as background music — _musicTargetVol
        // is musicVolume x 0.35 (~0.19) and announces nothing.
        const sv = (UI.settings.sfxVolume != null) ? UI.settings.sfxVolume : 0.55;
        const target = Math.max(0.4, Math.min(1, sv * 0.95));
        try {
          if (this._music && !this._music.paused) { this._music.pause(); this._shadowDuckedMusic = true; }
        } catch (e) {}
        a.volume = 0;
        try { a.currentTime = 0; } catch (e) {}
        const pr = a.play();
        if (pr && pr.catch) pr.catch(() => {});
        this._fadeVolume(a, target, 400, '_shadowFade');
        const total = Math.max(1200, ms | 0);
        const fadeOutMs = 1200;
        this._shadowThemeTimer = setTimeout(() => {
          this._shadowThemeTimer = null;
          if (this._shadowTheme !== a) return;
          this._fadeVolume(a, 0, fadeOutMs, '_shadowFade', () => {
            try { a.pause(); a.currentTime = 0; } catch (e) {}
            if (this._shadowTheme === a) this._shadowTheme = null;
            this._restoreMusicAfterShadow();
          });
        }, Math.max(0, total - fadeOutMs));
      } catch (e) { /* a theme is never worth an exception */ }
    },
    stopShadowTheme() {
      try {
        if (this._shadowThemeTimer) { clearTimeout(this._shadowThemeTimer); this._shadowThemeTimer = null; }
        if (this._shadowTheme) { this._shadowTheme.pause(); this._shadowTheme.currentTime = 0; this._shadowTheme = null; }
      } catch (e) {}
      this._restoreMusicAfterShadow();
    },
    _restoreMusicAfterShadow() {
      try {
        if (this._shadowDuckedMusic) {
          this._shadowDuckedMusic = false;
          if (this._music && this._music.paused && this._musicWantPlay
              && UI.settings && UI.settings.menuMusic !== false) {
            const p = this._music.play(); if (p && p.catch) p.catch(() => {});
          }
        }
      } catch (e) {}
    },
    // WIN ONLY. There is deliberately no defeat counterpart: the ask was for a
    // sound when you WIN, and the procedural 'defeat' cue stays exactly as it
    // was. Uncapped — the standing rule caps play/ability clips at 1.5-3s so
    // they do not tail over the next action, but this is a 4.5s sting on a
    // screen where nothing follows, and it is music, which that rule exempts.
    playCardClick() {
      // A COOLDOWN, because this one is fired by the user rather than by the
      // game. Nothing else in here can be triggered a dozen times a second by
      // someone clicking quickly, and without a floor those copies stack into
      // a rattle. 70ms is below the rate anyone clicks deliberately and above
      // the rate a double-click or a stray second event arrives at.
      const now = Date.now();
      if (now - (this._lastCardClickAt || 0) < 70) return null;
      this._lastCardClickAt = now;
      try {
        return this._playSample(this.CARD_CLICK_SRC,
          { fadeIn: 0, fadeOut: 80, maxDur: 0.9, category: 'effect' });
      } catch (e) { return null; }
    },
    playVictoryMusic() {
      try { return this._playSample(this.VICTORY_SRC, { fadeIn: 0, fadeOut: 400 }); }
      catch (e) { return null; }
    },
    playBallyhooVoice() {
      // Through _playSample so it rides the master bus (and its limiter) like
      // every other one-shot, instead of being a second uncontrolled <audio>.
      try { return this._playSample(this.BALLYHOO_VOICE_SRC, { fadeIn: 0, fadeOut: 150 }); }
      catch (e) { return null; }
    },
    playBallyhooVoice2() {
      try { return this._playSample(this.BALLYHOO_VOICE2_SRC, { fadeIn: 0, fadeOut: 150 }); }
      catch (e) { return null; }
    },
    stopBallyhooFanfare() {
      try {
        if (this._ballyhooTimer) { clearTimeout(this._ballyhooTimer); this._ballyhooTimer = null; }
        if (this._ballyhoo) { this._ballyhoo.pause(); this._ballyhoo.currentTime = 0; this._ballyhoo = null; }
      } catch (e) {}
      // Hand the menu loop back if we took it. Guarded on the flag so this can
      // never start music that was not playing to begin with.
      try {
        if (this._ballyhooDuckedMusic) {
          this._ballyhooDuckedMusic = false;
          if (this._music && this._music.paused && this._musicWantPlay
              && UI.settings && UI.settings.menuMusic !== false) {
            const p = this._music.play(); if (p && p.catch) p.catch(() => {});
          }
        }
      } catch (e) {}
    },

    playMatchIntro() {
      try {
        if (!UI.settings || UI.settings.sfxVolume === 0) return;
        if (UI.settings.menuMusic === false) return;
        this.stopMatchIntro();   // never stack (e.g. fast rematch)
        // THE SCORE CARRIES INTO THE MATCH (owner, 2026-11-11: "use the score
        // music for the match intro too"). The piece the menu was playing comes
        // back for the intro window, then fades — no card track. startRound has
        // just called stopMusic, so this crossfades the same piece back in.
        if (UI.MENU_SCORE_ON && UI.menuScore) {
          const ms = UI.menuScore;
          if (!ms.start(ms._idx >= 0 ? ms._idx : null)) return;
          this._matchIntroScore = true;
          const total = this.MATCH_INTRO_MS || 20000, fadeOutS = 2.5;
          this._matchIntroTimer = setTimeout(() => {
            this._matchIntroTimer = null;
            if (!this._matchIntroScore) return;
            this._matchIntroScore = false;
            if (!this._musicWantPlay) ms.stop(fadeOutS);   // never cut a menu that is back on
          }, Math.max(0, total - fadeOutS*1000));
          return;
        }
        const a = new Audio(this.MATCH_INTRO_SRC);
        a.loop = false;
        a.preload = 'auto';
        this._matchIntro = a;
        const target = this._musicTargetVol();
        a.volume = 0;
        try { a.currentTime = 0; } catch (e) {}
        const p = a.play();
        if (p && p.catch) p.catch(() => {});
        // Fade in over 600ms to match the menu loop's entrance.
        this._fadeVolume(a, target, 600, '_introFade');
        const total = this.MATCH_INTRO_MS || 20000;
        const fadeOutMs = 2500;
        // Fade out so the cue ends cleanly right around the 20s mark.
        this._matchIntroTimer = setTimeout(() => {
          this._matchIntroTimer = null;
          if (this._matchIntro !== a) return;
          this._fadeVolume(a, 0, fadeOutMs, '_introFade', () => {
            try { a.pause(); a.currentTime = 0; } catch (e) {}
            if (this._matchIntro === a) this._matchIntro = null;
          });
        }, Math.max(0, total - fadeOutMs));
      } catch (e) { /* ignore */ }
    },
    stopMatchIntro() {
      if (this._matchIntroTimer) { clearTimeout(this._matchIntroTimer); this._matchIntroTimer = null; }
      if (this._matchIntroScore) {
        this._matchIntroScore = false;
        if (!this._musicWantPlay) { try { UI.menuScore.stop(.8); } catch (e) {} }
      }
      const a = this._matchIntro;
      if (!a) return;
      this._matchIntro = null;
      try { if (a._introFade) cancelAnimationFrame(a._introFade); } catch (e) {}
      try { a.pause(); a.currentTime = 0; } catch (e) {}
    },

    // Low-level HTMLAudioElement playback for a specific sound file. Clone
    // pool keyed by URL so overlapping triggers of the same file each get
    // their own playback head. Returns the audio element that started
    // playing (or null) so callers — e.g. hover — can stop it mid-clip.
    // Cancel any fade-in / cap-fade timers currently scheduled on a pooled
    // clone. Called when the clone is re-used for a new play so the old
    // timers don't fight with the new one's volume.
    _clearFadeTimers(a) {
      // After the 2026-05-19 fade-engine rewrite, these IDs are RAF
      // handles, not setInterval IDs. Cancel via cancelAnimationFrame
      // primarily; clearInterval kept as a belt-and-braces fallback
      // in case a fade from the legacy setInterval path is still in
      // flight when this helper runs (e.g. mid-deploy, hot-reload).
      const cancel = (id) => {
        if (id == null) return;
        try { cancelAnimationFrame(id); } catch (e) {}
        try { clearInterval(id); } catch (e) {}
      };
      if (a._fadeInInterval) { cancel(a._fadeInInterval); a._fadeInInterval = null; }
      if (a._capTimeout)     { clearTimeout(a._capTimeout);  a._capTimeout = null; }
      if (a._capInterval)    { cancel(a._capInterval);   a._capInterval = null; }
      if (a._stopInterval)   { cancel(a._stopInterval);  a._stopInterval = null; }
    },

    // Volume ramp helper — eases a clone's .volume from its current value
    // to `toVol` over `durMs`, calling `onDone` when finished. Holds the
    // RAF id on the element so a follow-up play can cancel it.
    // Tracks under `slot` so fade-in / fade-out / stop fades don't step on
    // each other. Fades DOWN use an ease-out-quad curve so the tail
    // lingers at low volume and the cut to silence doesn't click; fades
    // UP are linear (sharp transients still read as immediate).
    //
    // 2026-05-19 — switched from setInterval(20 ms) to
    // requestAnimationFrame. The 20 ms timer fired 50 Hz unsynced with
    // the browser's paint schedule, so every fade contended with the
    // main thread; multiple simultaneous fades (old hover fading out +
    // new hover fading in + music ducking) compounded into perceived
    // lag during transitions. User report: "it's kinda lagging, how
    // can we make the audio smoother transitions?" RAF syncs the
    // volume writes with the next paint (~16.67 ms at 60 Hz, fewer
    // ticks total) and auto-pauses when the tab is backgrounded — no
    // wasted work and smoother per-frame interpolation. We cancel via
    // `cancelAnimationFrame` instead of `clearInterval`. The `slot`
    // contract stays the same so all the existing fade-in /
    // fade-out / stop / duck call sites work unchanged.
    // How long until every currently-sounding non-hover cue has finished, in ms.
    // Combat's lane advance uses this to hold a lane open until you have actually
    // HEARD it resolve.
    // Why this is needed alongside the existing _laneAudioEndsAt: that field is
    // only written when a card had a real death SAMPLE that won the lane's single
    // audio slot. Cards that fall back to a procedural cue return null from
    // playCardSfx, so `chosen` was null, nothing was recorded, and the lane
    // advanced on the flat base delay while the sound was still going. Measuring
    // the live elements covers those, plus anything an onDeath trigger fired
    // (ability cues, voice lines) that the single-slot bookkeeping never saw.
    // Reading the ELEMENT rather than trusting a precomputed end-time also fixes
    // the case where duration was NaN when the estimate was made — a freshly
    // constructed Audio has readyState 0, so duration is unknown at exactly the
    // moment the old code needed it.
    // Bounded by design: the concurrency cap keeps this set small, and CAP_MS
    // stops one long voice line from stalling the whole combat.
    activeTailMs(capMs) {
      const CAP_MS = capMs || 2600;
      // No metadata yet -> assume a typical capped cue rather than 0. Guessing
      // low here reintroduces the bug; guessing high only costs a short pause.
      const UNKNOWN_MS = 1100;
      let worst = 0;
      const consider = (a) => {
        if (!a || a.paused || a.ended) return;
        const known = !isNaN(a.duration) && a.duration > 0;
        const remain = known ? Math.max(0, (a.duration - a.currentTime) * 1000) : UNKNOWN_MS;
        const capped = Math.min(CAP_MS, remain);
        if (capped > worst) worst = capped;
      };
      if (this._activeNonHover) this._activeNonHover.forEach(consider);
      return worst;
    },
    _fadeVolume(a, toVol, durMs, slot, onDone) {
      const startVol = a.volume;
      const goingDown = toVol < startVol;
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const key = slot || '_fadeInterval';
      // Cancel any in-flight RAF in the same slot. Belt-and-braces
      // clearInterval too in case a fade was queued under the old
      // setInterval implementation and the engine is mid-transition.
      if (a[key]) {
        try { cancelAnimationFrame(a[key]); } catch (e) {}
        try { clearInterval(a[key]); } catch (e) {}
        a[key] = null;
      }
      const tick = () => {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const p = Math.min(1, (now - t0) / durMs);
        // Ease-out-quad on the way down: amplitude drops more quickly
        // initially, so we spend the last portion of the fade at quiet
        // levels where a straight cut would otherwise stand out. Up-
        // ramps stay linear — they're short and don't benefit from easing.
        const eased = goingDown ? 1 - Math.pow(1 - p, 2) : p;
        a.volume = Math.max(0, Math.min(1, startVol + (toVol - startVol) * eased));
        if (p >= 1) {
          a[key] = null;
          if (onDone) onDone();
          return;
        }
        a[key] = requestAnimationFrame(tick);
      };
      a[key] = requestAnimationFrame(tick);
    },

    // Fade a clone down to 0 then pause + rewind. Restores the original
    // volume on the paused element so the next play starts at the right
    // level. Used by _stopHover and any other "cut early" path.
    _fadeAndPause(a, durMs) {
      if (!a || a.paused) return;
      const restoreVol = Math.max(0, Math.min(1, (UI.settings.sfxVolume ?? 0.55)));
      this._clearFadeTimers(a);
      this._fadeVolume(a, 0, durMs, '_stopInterval', () => {
        try { a.pause(); a.currentTime = 0; a.volume = restoreVol; } catch (e) {}
      });
    },

    // Global cache-bust suffix appended to card audio URLs. Bumped whenever
    // the underlying files are batch-reprocessed (e.g. after a loudnorm
    // pass) so browsers refetch instead of serving stale cached bytes.
    // Only applied when the src doesn't already carry its own `?v=...`
    // override (so individually-bumped entries like Thanos's stay intact).
    _CARD_AUDIO_VERSION: 13,
    _bustCache(src) {
      if (typeof src !== 'string' || src.indexOf('?') !== -1) return src;
      return src + '?cv=' + this._CARD_AUDIO_VERSION;
    },
    // ===================== AAA AUDIO BUSES =====================
    // Category-based gain multipliers establish a priority hierarchy
    // so layered audio reads as intentional rather than chaotic.
    // Voice/play sit at marquee level (1.0); supporting effects sit
    // underneath at 0.7 so they don't fight the moment. Pattern from
    // AAA mixing practice (Wwise HDR / Unity audio mixer): "dialogue
    // ducks SFX 10-15dB, ambient ducks both." Without this every
    // category played at flat sfxVolume and a Batman play + Fear +
    // 2 Strikes all stacked at the same loudness — fine alone, but
    // collectively a wall of sound. Per-category gain creates space
    // for each layer to be heard. */
    _CATEGORY_GAIN: {
      voiceLine: 1.10,  // dialogue/character voice — highest priority
      play:      1.00,  // marquee play SFX (Arkham theme, HULK SMASH, laughs)
      ability:   1.00,  // mid-play ability SFX (Gojo's Hollow Purple resolve)
      death:     0.90,  // dramatic but slightly softer (chains avoid wall)
      hover:     0.85,  // ambient bed under everything else
      effect:    0.70,  // fear/freeze/stun/damage cues — supporting layer
    },
    _playSample(src, opts) {
      if (!src) return null;
      if (!UI.settings || UI.settings.sfxVolume === 0) return null;
      if (!this._samplePool) this._samplePool = new Map();
      if (!this._activeHover) this._activeHover = new Set();
      if (!this._activeNonHover) this._activeNonHover = new Set();
      src = this._bustCache(src);
      const isHover = !!(opts && opts.hover);
      // SUPPRESSION CHECK MOVED AHEAD OF POOL CREATION. The 3 clones below are
      // created with preload='auto', i.e. three full downloads, and this used
      // to happen BEFORE the hover-suppression return further down. So sweeping
      // the cursor across the board during combat — exactly when the board is
      // busiest — kicked off megabytes of hover audio that was then never
      // played. Card hover files average 1.65 MB.
      if (isHover && this._activeNonHover && this._activeNonHover.size > 0) return null;
      // CONCURRENCY CAP ON SUPPORTING CUES — same reasoning as the hover check
      // above, and deliberately in the same place: ahead of pool creation, so a
      // cue we are not going to play never spawns its clones.
      // A wiped board fires a death cue per casualty, and _activeNonHover had no
      // ceiling at all. Measured with a 12-card wipe: 12 Audio elements created
      // in one tick, 6 playing at once. On a phone each of those is a cold fetch
      // AND a decode landing in the same frame as the deaths themselves, which
      // is precisely the moment the board is busiest — and twelve overlapping
      // death sounds are not readable as twelve deaths anyway, they are noise.
      // So this is a legibility fix as much as a performance one; the user's two
      // complaints ("lags like crazy" and "impossible to tell what happens") are
      // the same event seen from two sides.
      // Only SUPPORTING cues are capped. Marquee audio — a card's voice line,
      // its play cue, its ability — is never dropped, matching the mixing rule
      // the category-gain table already encodes: voice ducks SFX, SFX never
      // ducks voice. Four is the point past which additional simultaneous
      // effects stop being distinguishable.
      const _cat = (opts && opts.category) || (isHover ? 'hover' : 'effect');
      if (!isHover
          && (_cat === 'effect' || _cat === 'death')
          && this._activeNonHover.size >= 4) return null;
      let clones = this._samplePool.get(src);
      if (!clones) {
        clones = [];
        // ONE clone for hover, three for everything else. Only a single hover
        // may sound at a time (enforced just below), so the other two were
        // pure resident memory: every distinct card hovered in a match pinned
        // 3 x 1.65 MB forever — _samplePool has no eviction path anywhere.
        const n = isHover ? 1 : 3;
        for (let i = 0; i < n; i++) { const a = new Audio(src); a.preload = 'auto'; clones.push(a); }
        this._samplePool.set(src, clones);
      }
      let pick;
      if (isHover) {
        // Block hover starts while any board SFX (play/death/kill/spawn/ability) is active.
        // Once those sounds finish, _activeNonHover empties and hovers resume normally.
        if (this._activeNonHover && this._activeNonHover.size > 0) return null;
        // Enforce ONE hover at a time at the audio layer: quick-fade any hover
        // clone still PLAYING (from this or another card) before starting a new
        // one. Belt-and-suspenders against a missed mouseout / orphaned clone
        // stacking into overlapping hovers. Paused-for-resume clones aren't in
        // _activeHover (removed on 'pause'), so the resume feature is untouched.
        if (this._activeHover && this._activeHover.size) {
          Array.from(this._activeHover).forEach(h => {
            if (h && !h.paused) this._fadeToPauseAtPosition(h, 120);
          });
        }
        // Hover resume: if any clone was previously paused mid-play
        // (currentTime > 0 and < duration), re-use THAT clone and
        // continue from where we left off. Otherwise start fresh.
        // User spec: "Darth Vader's breathing doesn't restart when
        // you press the card again — it just resumes from where you
        // last had it."
        const resumable = clones.find(a => a.paused && a.currentTime > 0 && (isNaN(a.duration) || a.currentTime < a.duration - 0.1));
        pick = resumable || clones.find(a => a.paused || a.ended) || clones[0];
      } else {
        pick = clones.find(a => a.paused || a.ended) || clones[0];
        // HOVER DUCKING — when a non-hover SFX fires (play, ability,
        // death, etc.), dip any currently-playing hover audio so the
        // player can hear the new cue cleanly while the hover music
        // keeps drifting underneath at lower volume. User spec:
        // "I pressed jigsaw, and I heard the laugh and the hover
        // music at the same time, which is kinda cool... like, hover
        // music kind of blends with whatever the wind blade is. Just
        // would have to be a little bit softer."
        // Stop any hover audio immediately — board SFX takes priority and
        // hover is blocked from starting again until _activeNonHover empties.
        if (this._activeHover.size > 0) {
          this._stopHover(true);
        }
      }
      this._clearFadeTimers(pick);
      // Apply category-based gain — voice/play sit at full volume,
      // supporting effects 30% quieter so the mix has hierarchy.
      const cat = (opts && opts.category) || (isHover ? 'hover' : 'effect');
      const catGain = this._CATEGORY_GAIN[cat] ?? 1.0;
      const entryGain = (opts && opts.gain) ? opts.gain : 1.0;
      let vol = Math.max(0, Math.min(1, (UI.settings.sfxVolume ?? 0.55) * catGain * entryGain));
      // THE VOICE CHANNEL — one foreground cue owns it at a time (spec:
      // docs/superpowers/specs/2026-11-10-presentation-director-design.md).
      // Priority: voice line 3 > card play / spawn / kill 2 > ability 1.
      //   newer, equal priority  -> takes the channel; the old cue fades out
      //                             (two play cues used to overlap at 60/100,
      //                             which is the garble a voice line got lost in)
      //   higher priority        -> takes the channel; the old cue is ducked below
      //   lower priority         -> plays UNDER the current cue at 35%, never cut
      const _VPRI = this._VOICE_PRIORITY;
      if (!isHover && _VPRI[cat]) {
        const pri = _VPRI[cat];
        const cur = this._voiceNow;
        const curLive = cur && cur.el && cur.el !== pick && !cur.el.paused && !cur.el.ended;
        if (curLive && pri < cur.pri) {
          vol *= this._VOICE_UNDER_GAIN;                 // under the current owner
          pick._voiceUnder = true;
        } else {
          if (curLive && pri === cur.pri) {
            try { this._fadeToPauseAtPosition(cur.el, 250); } catch (e) {}
          }
          pick._voiceUnder = false;
          this._voiceNow = { el: pick, pri, at: Date.now() };
        }
        if (pri === 3 && !pick._voiceUnder && this._mix) {
          this._mixDuck('music', this._VOICE_UNDER_GAIN, 150);
          const up = () => { if (this._voiceNow && this._voiceNow.el === pick) this._mixDuck('music', 1, 600); };
          pick.addEventListener('ended', up, { once: true });
          pick.addEventListener('pause', up, { once: true });
        }
        this._voiceStat = this._voiceStat || { cues: 0, replaced: 0, under: 0 };
        this._voiceStat.cues++;
        if (curLive && pri === cur.pri) this._voiceStat.replaced++;
        if (pick._voiceUnder) this._voiceStat.under++;
      }
      // Tag the audio element with its category so other code paths
      // (voice-first ducking below) can decide who-ducks-who.
      pick._sfxCategory = cat;
      // VOICE-FIRST DUCKING: when a play/voiceLine SFX fires, briefly
      // duck OTHER active non-hover SFX (effects) so the marquee event
      // is the focal point. AAA-mix principle: voice ducks SFX, SFX
      // doesn't duck voice. Implemented per priority — the new SFX
      // ducks any active SFX of LOWER or EQUAL tier. */
      if (!isHover && (cat === 'play' || cat === 'voiceLine' || cat === 'ability')) {
        const restoreMs = (opts && opts.fadeOut) || 600;
        const playLife = (opts && opts.maxDur) ? opts.maxDur * 1000 : 1500;
        this._activeNonHover.forEach(other => {
          if (other === pick) return;
          // Don't duck higher-priority audio (voiceLine should never be ducked).
          if (other._sfxCategory === 'voiceLine') return;
          if (other._sfxPreDuck == null) other._sfxPreDuck = other.volume;
          this._clearFadeTimers(other, '_voiceDuckInterval');
          // Duck to 60% of current — supporting effects step back so
          // the play moment lands cleanly.
          // A voice line pulls everything else down to 35% (was 60%): it is the
          // one cue the player must not miss.
          const tgt = other._sfxPreDuck * (cat === 'voiceLine' ? this._VOICE_UNDER_GAIN : 0.60);
          this._fadeVolume(other, tgt, 150, '_voiceDuckInterval');
          clearTimeout(other._sfxRestoreTimer);
          other._sfxRestoreTimer = setTimeout(() => {
            if (!this._activeNonHover.has(other)) return;
            this._fadeVolume(other, other._sfxPreDuck, restoreMs, '_voiceDuckRestore');
            other._sfxPreDuck = null;
          }, Math.max(playLife - restoreMs, 200));
        });
      }
      // Fade IN from silence — prevents a click on sharp-onset files
      // and makes every cue land softly. For hover samples we resume
      // at currentTime instead of jumping back to 0; for everything
      // else we rewind. Per-event fade-in duration via opts.fadeIn
      // (hover 1000ms, play 500ms; default 130ms for death).
      // Into the mixer first (no-op until the context is running, or if routing
      // fails for this element) — and a context iOS suspended gets woken.
      if (this._ctx && this._ctx.state === 'suspended') { try { this._ctx.resume().catch(() => {}); } catch (e) {} }
      this._route(pick, this._MIX_BUS_OF[cat] || 'sfx');
      try {
        pick.volume = 0;
        // `pick.currentTime = 0` used to sit bare inside this same try. On iOS
        // Safari, setting currentTime on a media element still in HAVE_NOTHING
        // (readyState 0) throws InvalidStateError — and the clone pool above is
        // built LAZILY, so the very first play of any given card's sound is
        // always in exactly that state. The throw aborted this whole block
        // before pick.play() was ever reached and the `catch { return null }`
        // swallowed it, so the cue was silently lost on its first use and
        // worked every time after. That is the reported symptom: "the when
        // played audio doesnt fire all the time on mobile."
        // Rewinding is only meaningful once there IS media to rewind, so skip
        // it when there is none, and never let it take the play() call down.
        if (!isHover && pick.readyState > 0) {
          try { pick.currentTime = 0; } catch (_) {}
        }
        const p = pick.play();
        if (p && p.catch) {
          let retried = false;
          p.catch(() => {
            // ONE retry once the element actually has data. iOS rejects play()
            // with NotAllowedError / AbortError while a pooled element is still
            // loading or was interrupted mid-load; the previous empty catch
            // dropped the cue permanently. Self-removing one-shot listener —
            // no polling, no new timers, nothing that runs on idle.
            if (retried) return;
            retried = true;
            pick.addEventListener('canplay', () => {
              // Only resume if this cue is still wanted — a card whose sound
              // was stopped or superseded in the meantime has already been
              // pulled from the active set by the 'pause'/'ended' handlers
              // registered just below.
              const live = isHover ? this._activeHover : this._activeNonHover;
              if (!live || !live.has(pick) || !pick.paused) return;
              try { pick.play().catch(() => {}); } catch (_) {}
            }, { once: true });
          });
        }
      } catch (e) { return null; }
      // Track active audio in category-aware sets so the duck logic
      // can operate on the right group. Hover gets its own set
      // (the existing 50% bed duck path); everything else goes in
      // _activeNonHover so the voice-first ducking can step them
      // back when a play/voiceLine fires.
      if (isHover) {
        this._activeHover.add(pick);
        pick.addEventListener('ended', () => this._activeHover.delete(pick), { once: true });
        pick.addEventListener('pause', () => this._activeHover.delete(pick), { once: true });
      } else {
        this._activeNonHover.add(pick);
        pick.addEventListener('ended', () => this._activeNonHover.delete(pick), { once: true });
        pick.addEventListener('pause', () => this._activeNonHover.delete(pick), { once: true });
      }
      // NO FADE, FOR CUES THAT MUST SIMPLY BE HEARD. The ramp is driven by
      // requestAnimationFrame, so anywhere rAF is throttled — a background tab,
      // a hidden pane — the volume never leaves 0 and the cue plays silently.
      // Setting it outright removes both the fade-in and that failure mode.
      // (Owner: "make sure for all the gun sounds there is no fade out but it
      // works".) The fade-out is skipped through the same flag below.
      if (opts && opts.noFade) {
        pick.volume = vol;
      } else {
        const fadeInMs = (opts && opts.fadeIn) ? opts.fadeIn : 130;
        this._fadeVolume(pick, vol, fadeInMs, '_fadeInInterval');
      }
      // Fade OUT — schedule an ease-out ramp that lands at the clip's
      // natural end OR at the requested `maxDur` cap, whichever is
      // shorter. Per-event tail duration via opts.fadeOut (hover 2000ms,
      // play 1000ms; default 300ms for death so chained deaths don't
      // trail into each other).
      const fadeMs = (opts && opts.fadeOut) ? opts.fadeOut : (isHover ? 1500 : 300);
      const scheduleCapFade = (durSec) => {
        const fadeStartMs = Math.max(0, durSec * 1000 - fadeMs);
        pick._capTimeout = setTimeout(() => {
          pick._capTimeout = null;
          const startVol = pick.volume;
          const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
          // RAF-driven taper — synced to paint, no main-thread 50 Hz
          // setInterval. Matches the rest of the fade engine (see
          // _fadeVolume) so multiple simultaneous fades share one
          // animation tick instead of contending. 2026-05-19
          // smoother-transitions pass.
          const capTick = () => {
            const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            const p = Math.min(1, (now - t0) / fadeMs);
            const eased = 1 - Math.pow(1 - p, 2);
            pick.volume = startVol * (1 - eased);
            if (p >= 1) {
              pick._capInterval = null;
              try { pick.pause(); pick.currentTime = 0; pick.volume = startVol; } catch (e) {}
              return;
            }
            pick._capInterval = requestAnimationFrame(capTick);
          };
          pick._capInterval = requestAnimationFrame(capTick);
        }, fadeStartMs);
      };
      const maxDur = opts && opts.maxDur;
      // SKIP the programmatic cap-fade when `fullDuration` is set
      // (hover SFX). User spec: "no max restriction on how long a
      // hover is. I dictate where to start and stop the song."
      // Hover MP3s already have their fade-out BAKED IN by the
      // ffmpeg pipeline at clip-time — stacking the engine's own
      // 2s ease-out on top of that compounded into a fade that
      // killed the volume ~2s before the user's intended end. The
      // audio now plays naturally to its `ended` event with the
      // baked fade as the only taper.
      if (opts && opts.fullDuration) {
        // intentionally no cap-fade scheduled
      } else if (maxDur && maxDur > 0) {
        scheduleCapFade(maxDur);
      } else if (!isNaN(pick.duration) && pick.duration > 0) {
        scheduleCapFade(pick.duration);
      } else {
        // Duration unknown — schedule the fade-out once metadata loads.
        const onMeta = () => {
          if (!isNaN(pick.duration) && pick.duration > 0) scheduleCapFade(pick.duration);
        };
        pick.addEventListener('loadedmetadata', onMeta, { once: true });
      }
      return pick;
    },

    // Registry entries can be either a bare string path or an object
    // `{ src, maxDur }` when a runtime length cap is desired. Normalizes
    // both into `{ src, opts }` for _playSample.
    _resolveSfxEntry(entry) {
      if (!entry) return null;
      // AN ARRAY IS A SET OF ALTERNATES. Owner: "have it so it's random which
      // sound plays if there are multiple for a card." Handled here rather than
      // in playCardSfx because this is the one function every registry entry
      // passes through — CARD_SFX, DEFAULT_CARD_SFX, TRICK_SFX and the effect
      // overrides all resolve through it — so every event on every card and
      // trick (play, hover, death, ability, kill, spawn, attack) gets alternates
      // at once, and a future registry inherits it without knowing about it.
      //
      // Math.random, NOT the engine's seeded rng: which take you hear is
      // presentation, and drawing from the game's RNG here would advance it by a
      // different number of steps depending on audio settings, desyncing replays
      // and multiplayer. Entries stay mixed — a member may be a bare path or a
      // { src, maxDur } object, because the recursion below re-resolves it.
      if (Array.isArray(entry)) {
        if (!entry.length) return null;
        return this._resolveSfxEntry(entry[Math.floor(Math.random() * entry.length)]);
      }
      if (typeof entry === 'string') return { src: entry, opts: null };
      if (typeof entry === 'object' && entry.src) {
        const opts = { maxDur: entry.maxDur };
        if (entry.fullDuration !== undefined) opts.fullDuration = entry.fullDuration;
        if (entry.gain !== undefined) opts.gain = entry.gain;
        if (entry.noFade !== undefined) opts.noFade = entry.noFade;
        return { src: entry.src, opts };
      }
      return null;
    },

    // Resolve + play a per-card sound. Audio spec v3:
    //   • hover: up to 5s; resumes from pause position on re-hover
    //   • play / ability: capped 1.5s; card fires ONE of the two based
    //     on whether it has an onPlay clause (ability if yes, play if no).
    //     Decision lives in the Game.playCard hook, not here.
    //   • death: capped 1.5s; highest-cost dying card in a lane wins the
    //     lane's audio slot (see combat pacing below).
    //   • voiceLine: capped 3s. GATED — fires at most ONCE per round across
    //     BOTH sides. Awarded to the highest-cost card that lands a kill.
    //     Pre-computed at combat start into `_voiceLineDelegate`; killCard
    //     hook only fires it for that card. User spec: "one voice line per
    //     round on kill — too many voices gets crammed fast".
    //   • ability: cost-based priority — if a higher-cost card's ability
    //     fired in the last 600ms, lower-cost abilities are suppressed.
    // Lookup chain per event:
    //   1. CARD_SFX[name][event]      — card-specific file
    //   2. DEFAULT_CARD_SFX[event]    — global default file
    //   3. PROC_EVENT_FALLBACK[event] — procedural synth tone
    // Return value: HTMLAudioElement for the played sample (or null if
    // nothing played). Combat pacing reads `.duration` from it to decide
    // when the next lane can start.
    playCardSfx(name, event, cardOrCost) {
      if (!name) return null;
      // Suppress play/spawn sounds for cards summoned while _suppressSummonSfx
      // is active (e.g. Knull filling the board) — direct onPlay calls inside
      // abilities.js bypass the summonCard wrapper check, so we gate here too.
      if ((event === 'play' || event === 'spawn') && typeof Game !== 'undefined' && Game._suppressSummonSfx) return null;
      // Card SFX events:
      //   • hover     — 8s clip, 1s fade-in, 2s fade-out
      //   • play      — 4s clip, 0.5s fade-in, 1s fade-out
      //   • death     — 1.5s clip, default fades (multiple deaths chain)
      //   • ability   — 4s clip, 0.5s fade-in, 1s fade-out (NOT auto-
      //     fired by the play hook — only when an ability explicitly
      //     triggers it from inside abilities.js, e.g. Gojo's Hollow
      //     Purple resolving after 2 combats).
      //   • kill      — fires on the KILLER when it destroys an enemy card.
      //     5s cap; only registered for cards with a unique kill cue.
      //   • spawn     — fires when a card enters play via code (e.g. Freddy
      //     Krueger nightmare trigger, Pennywise rising from the Sewers).
      //     Same cap/fade settings as play; NOT auto-fired by playCard.
      //   • attack    — fires when a card swings in combat. NOT auto-fired by
      //     the engine; an ability calls it from onBeforeAttack (Droideka's
      //     blaster fire). Same cap/fade profile as play.
      const ALLOWED = { hover: 1, play: 1, death: 1, ability: 1, kill: 1, spawn: 1, attack: 1 };
      if (!ALLOWED[event]) return null;
      // HAND-AUDIO PRIVACY (user, 2026-07-25): every card has its OWN hover cue,
      // so browsing your hand tells anyone sitting beside you exactly what you
      // are holding — a real tell when you play online next to your opponent.
      // With the setting on we return null for the IDENTIFYING hover cue only;
      // each call site already falls back to the generic `cardHover` blip, so
      // you keep the tactile feedback and lose the information leak — and the
      // rest of the game stays at full volume. play/death/kill/spawn are NOT
      // gated: by then the card is face-up on the board and already public.
      // A TAUNT is not a hand leak. The privacy setting exists so browsing your
      // own hand doesn't announce what you hold — but a taunt is a deliberate
      // broadcast of a character's theme to the opponent, so it must play even
      // with privacy on. `cardOrCost === 'taunt'` is the opt-out flag passed by
      // UI._playTauntSound. (User: "the taunt system for play sounds doesn't
      // work either" — with hand-audio privacy on every taunt returned null.)
      const _isTaunt = cardOrCost === 'taunt';
      if (event === 'hover' && !_isTaunt && UI.settings && UI.settings.handAudioPrivacy) return null;
      // FACE-DOWN PRIVACY — a card played face-down (Invisible Woman's cloak, a
      // hidden Deadpool steal, etc.) is NOT public: only a card BACK shows on
      // the board. But its identifying play/spawn theme would announce exactly
      // which card it is — a real tell, and online BOTH clients fire the cue.
      // Swap the card-specific theme for the generic placement blip so the
      // play still lands with tactile feedback but leaks nothing. death/kill
      // are unaffected (a face-down card flips face-up before it can die) and
      // hover is already gated above. User: "when a card is played upside down,
      // the sounds still fire and gives away the card."
      if ((event === 'play' || event === 'spawn')
          && cardOrCost && typeof cardOrCost === 'object' && cardOrCost.isFaceDown) {
        this.play(cardOrCost.owner === 'ai' ? 'cardPlayEnemy' : 'cardPlay');
        return null;
      }
      // Resolve file: card-specific first, else global default.
      const reg = this.CARD_SFX[name] || {};

      // THE DEFAULT "WHEN PLAYED" CUE IS THE CARD'S OWN HOVER THEME.
      // Owner: "the default when-played sound for cards is just their specific
      // hover from wherever it last stopped — so if I play Thanos, there's no
      // unique when-played sound, the default would be his hover for like 3.5
      // seconds."
      //
      // Only a handful of cards have a bespoke `play` clip; everything else
      // fell through to a procedural blip that says nothing about WHICH card
      // landed. Its hover theme already does — and every card that has one is
      // already carrying the asset, so this costs nothing to ship.
      //
      // RESUMED, not restarted. `hover: true` puts this on the same clone the
      // hover system uses, so it picks up from wherever browsing the card left
      // off and the theme keeps advancing across plays rather than replaying
      // its first three seconds forever.
      //
      // NOT capped with maxDur: that path's cap-fade rewinds currentTime to 0,
      // which would destroy the very position this is built to preserve. The
      // 3.5s stop is scheduled here through the hover system's own
      // pause-preserving fade instead.
      //
      // Placed AFTER both privacy gates above on purpose. Hover privacy does
      // not apply — the card is face-up on the board by now, so this leaks
      // nothing — and a face-down play has already returned with the generic
      // blip before reaching this line.
      if ((event === 'play' || event === 'spawn') && !reg[event] && reg.hover) {
        const hoverRes = this._resolveSfxEntry(reg.hover);
        if (hoverRes && hoverRes.src) {
          const hOpts = { ...(hoverRes.opts || {}) };
          hOpts.hover = true;          // resume-from-pause clone selection
          hOpts.fullDuration = true;   // no cap-fade — see above
          delete hOpts.maxDur;
          hOpts.fadeIn = 200;
          hOpts.category = 'play';     // marquee gain tier, not hover's
          const el = this._playSample(hoverRes.src, hOpts);
          if (el) {
            // 2.5s of the card's own hover theme, tail included. (User: "make
            // sure that when cards dont have when played, a 2.5 sec clip of
            // their hover if they have any hover, and this is for environments
            // too.") Environments reach this through the same playCard wrapper
            // every other card uses, so one rule covers both.
            const PLAY_HOVER_MS = 2500, TAIL_MS = 700;
            setTimeout(() => { try { this._fadeToPauseAtPosition(el, TAIL_MS); } catch (e) {} },
                       Math.max(0, PLAY_HOVER_MS - TAIL_MS));
          }
          return el;
        }
      }

      const fileEntry = reg[event] ?? this.DEFAULT_CARD_SFX[event];
      if (!fileEntry) {
        // Procedural fallback so every card still has audio feedback
        // even without a registered file.
        const owner = (cardOrCost && typeof cardOrCost === 'object') ? cardOrCost.owner : null;
        const PROC_EVENT_FALLBACK = {
          hover:     null, // no generic hover hum — would be noise across whole collection
          play:      owner === 'ai' ? 'cardPlayEnemy' : 'cardPlay',
          death:     'cardDestroy'
        };
        const toneName = PROC_EVENT_FALLBACK[event];
        if (toneName) this.play(toneName);
        return null;
      }
      const resolved = this._resolveSfxEntry(fileEntry);
      if (!resolved) return null;
      const opts = { ...(resolved.opts || {}) };
      if (event === 'hover') {
        opts.hover = true;
        // Hover plays the FULL clip with no programmatic taper. User
        // direction: "no max restriction on how long a hover is. I
        // dictate where to start and stop the song." The ffmpeg
        // pipeline already bakes a 1 s fade-in / 2 s fade-out into
        // every hover MP3 at clip-time — letting the engine schedule
        // its own cap-fade on top of that produced a compounded
        // ease-out that audibly killed the clip ~2 s before its
        // intended end. Strip every registry-side maxDur and set the
        // fullDuration sentinel so _playSample skips its cap-fade
        // and lets the file play to natural `ended`.
        // 2026-05-19 — fade-in dropped 1000 → 120 ms for snappier
        // hover-to-audible feel. The ffmpeg-baked 1 s fade-in on
        // every hover MP3 already supplies the gentle ramp the user
        // hears; layering a 1 s engine fade on top of it was double-
        // ramping the first second and contributing to "delay
        // causing the lag." 120 ms is just enough to avoid an
        // audible click when the engine starts playback.
        // fadeOut here is the cap-fade tail — gated off by
        // fullDuration: true below, so the value is dead for hover.
        opts.fadeIn  = opts.fadeIn  ?? 120;
        opts.fadeOut = opts.fadeOut ?? 2000;
        opts.fullDuration = true;
        delete opts.maxDur;
        // Duck the menu music while a hover theme is live so the two
        // don't muddy each other. _stopHover restores the music level
        // when the cursor leaves the card.
        this.duckMusic();
      } else if (event === 'play' || event === 'ability' || event === 'spawn') {
        // On Play ('play') is normally capped at 5s. Two exceptions play the
        // clip in FULL (user request — the biggest entrances get their whole
        // cue): an entry flagged `fullDuration`, OR any 10-cost card. The card
        // instance is passed as the 3rd arg, so we read its PRINTED cost
        // (baseCost, so a discount can't drop it under 10). Uncapped clips
        // skip the programmatic cap-fade in _playSample (opts.fullDuration),
        // so they should have their own baked tail to avoid a hard cut.
        // 'ability'/'spawn' are code-triggered dramatic entrances (Jaws
        // rising, Pennywise from the Sewers) that DEFAULT to 5 but honor an
        // override.
        if (event === 'play') {
          const _printedCost = this._costFromArg(cardOrCost);
          if (opts.fullDuration || _printedCost >= 10) {
            opts.fullDuration = true;   // _playSample skips its 5s cap-fade
            delete opts.maxDur;
          } else {
            opts.maxDur = Math.min(opts.maxDur ?? 5.0, 5.0);
          }
        } else {
          opts.maxDur = opts.maxDur ?? 5.0;
        }
        opts.fadeIn  = opts.fadeIn  ?? 500;
        opts.fadeOut = opts.fadeOut ?? 1000;
        opts.category = (event === 'spawn') ? 'play' : event;  // spawn gets full marquee gain
      } else if (event === 'kill') {
        opts.maxDur  = opts.maxDur  ?? 5.0;
        opts.fadeIn  = opts.fadeIn  ?? 200;
        opts.fadeOut = opts.fadeOut ?? 800;
        opts.category = 'play';
      } else {
        opts.maxDur = opts.maxDur ?? 1.5;          // death — keep tight for chains
        opts.category = 'death';
      }
      const _sampleEl = this._playSample(resolved.src, opts);
      // Stash the registry-capped length on the element so callers can
      // size stagger windows off the REAL clip cap instead of the raw
      // element.duration (which is NaN until metadata loads on first play).
      if (_sampleEl && opts.maxDur != null) _sampleEl._sfxMaxDur = opts.maxDur;
      return _sampleEl;
    },
    // Extract a numeric cost from a possible card instance or number
    // passed to playCardSfx as the 3rd arg. Used by ability priority.
    _costFromArg(arg) {
      if (arg == null) return 0;
      if (typeof arg === 'number') return arg;
      if (typeof arg === 'object') return arg.baseCost || arg.cost || 0;
      return 0;
    },

    // Per-ability sound — use from inside an `onPlay` callback when the
    // card has multiple distinct moments you want to cue separately.
    //   CARD_SFX['Darth Vader'] = {
    //     abilities: { move: 'audio/.../vader-move.mp3', throw: '...' }
    //   }
    //   UI.sfx.playCardAbility('Darth Vader', 'move');
    // Falls back to the single `ability` slot, then the global default, so
    // a call with an unregistered key still plays something reasonable if
    // either a card-level or global ability sound is defined.
    // No-op kept for backwards compatibility with abilities.js call sites
    // (Darth Vader's chain). The simplified SFX set only emits hover, play,
    // and death cues — per-ability mid-effect sounds were removed per user
    // spec ("only sounds for card hover, when played, when killed").
    playCardAbility(_name, _key) { return null; },
    // Per-trick SFX playback. Mirrors the hover resume-from-pause and
    // play-event cap behavior from playCardSfx so a tricky hover like
    // Time Stone's breathing swell picks up where it left off on re-
    // hover instead of restarting.
    playTrickSfx(name, event) {
      if (!name) return null;
      // Hand-audio privacy — same rule as playCardSfx: the per-trick hover cue
      // identifies what you're holding to anyone beside you. Null here falls
      // back to the generic blip at every call site.
      if (event === 'hover' && UI.settings && UI.settings.handAudioPrivacy) return null;
      const reg = this.TRICK_SFX[name] || {};
      const entry = reg[event] ?? this.DEFAULT_TRICK_SFX[event];
      const resolved = this._resolveSfxEntry(entry);
      if (!resolved) return null;
      const opts = { ...(resolved.opts || {}) };
      if (event === 'hover') {
        opts.hover = true;          // enables resume-from-pause in _playSample
        opts.category = 'hover';
        opts.fullDuration = true;   // skip _playSample cap-fade (see playCardSfx note)
        delete opts.maxDur;         // hover is full-length per user spec
      } else {
        // Non-hover trick events (play) get the same 1.5s cap as cards.
        opts.maxDur = Math.min(1.5, opts.maxDur ?? 1.5);
        opts.category = 'play';     // tricks use marquee tier on play
      }
      return this._playSample(resolved.src, opts);
    },

    // PAUSE the current hover sample (keeping its currentTime) so the
    // next re-hover resumes exactly where it left off instead of
    // restarting. Fades out the volume smoothly before pausing so
    // there's no click. Vader's breathing / Predator's clicking pick
    // up mid-breath when the user re-hovers the card.
    _stopHover(force) {
      // Keep hover audio running while the card is SELECTED (clicked
      // but not yet placed). User spec: "if you click a card, right,
      // and you're gonna place the card, I think it should be playing
      // the whole time as you're clicking it, as it's selected."
      // The mouseout-triggered stop respects this guard; only the
      // post-play stop (force=true) pushes through it.
      if (!force) {
        const sel = (typeof Game !== 'undefined' && Game.state) ? Game.state.selectedCard : null;
        if (sel && this._currentHoverName && sel.name === this._currentHoverName) {
          // Mouse left the card but it's still selected — keep music
          // playing. Don't even clear `_currentHoverEl` so re-entry
          // doesn't restart the audio.
          return;
        }
      }
      // Also clear any pending dwell-delay timer — once we're tearing
      // down hover state, a queued play would be operating on a stale
      // element by the time it fires.
      if (this._hoverDelayTimer) {
        clearTimeout(this._hoverDelayTimer);
        this._hoverDelayTimer = null;
        this._hoverDelayEl = null;
      }
      // Clear the mouseout-to-empty delayed stop too. If we're
      // tearing down hover state right now, there's no point in a
      // scheduled stop firing later — it'd no-op against a null
      // audio ref but stays as dead state. Safer to clean it up.
      if (this._pendingStopHover) {
        clearTimeout(this._pendingStopHover);
        this._pendingStopHover = null;
      }
      const a = this._currentHoverAudio;
      // Quick stop fade — 250 ms is short enough to feel SHARP when
      // the cursor leaves a card (user report 2026-05-19: "it should
      // be sharp when it start playing and when it ends") but long
      // enough to avoid an audible click as the volume hits zero.
      // Was 1000 ms previously — the longer tail kept audio
      // audibly bleeding into the next hover's start.
      if (a && !a.paused) this._fadeToPauseAtPosition(a, 250);
      // CRITICAL: stop EVERY other hover clone still ringing out, not just
      // _currentHoverAudio. Fast cursor movement can start hover B and
      // reassign _currentHoverAudio while card A's clone is still playing
      // and orphaned in _activeHover — stopping only the current ref left
      // that clone playing for its full length. THAT is the "Deadpool's
      // hover plays when I'm not hovering / multiple hovers at once" bug.
      if (this._activeHover && this._activeHover.size) {
        Array.from(this._activeHover).forEach(h => {
          if (h && h !== a && !h.paused) this._fadeToPauseAtPosition(h, 200);
        });
      }
      this._currentHoverAudio = null;
      this._currentHoverEl = null;
      this._currentHoverName = null;
      // Restore the menu music to its full target volume.
      this.restoreMusic();
    },
    // Fade volume to 0 over durMs then pause WITHOUT resetting
    // currentTime. Mirror of _fadeAndPause but preserves playback
    // position for the resume-hover flow.
    _fadeToPauseAtPosition(a, durMs) {
      if (!a || a.paused) return;
      const restoreVol = Math.max(0, Math.min(1, (UI.settings.sfxVolume ?? 0.55)));
      this._clearFadeTimers(a);
      this._fadeVolume(a, 0, durMs, '_stopInterval', () => {
        try { a.pause(); a.volume = restoreVol; } catch (e) {}
        // Intentionally NOT: a.currentTime = 0
      });
    },

    play(name, gainMul, pan) {
      if (!UI.settings || UI.settings.sfxVolume === 0) return;
      // FILE FIRST. Checked before _init() because a sample does not need the
      // WebAudio synth context at all, and before the switch so a registered
      // name never also fires its procedural version underneath.
      const cue = this.SAMPLE_CUES && this.SAMPLE_CUES[name];
      if (cue) {
        if (cue.cooldownMs) {
          if (!this._cueLast) this._cueLast = {};
          const now = Date.now();
          if (now - (this._cueLast[name] || 0) < cue.cooldownMs) return null;
          this._cueLast[name] = now;
        }
        try {
          // A cue can name its own mixing category. Default 'effect' keeps every
          // existing sample (hpHit, roundStart) exactly where it was — a
          // supporting layer that is ducked and, crucially, DROPPED once four
          // non-hover sounds are already going (the concurrency cap in
          // _playSample). That cap is why the block cue went silent in 2v2: a
          // block fires in the middle of combat, surrounded by hit and death
          // sounds, so _activeNonHover is almost always already at four and the
          // block was suppressed. A marquee moment declares a priority category
          // (see blockShield → 'play'), which the cap exempts and which ducks the
          // combat noise so it lands cleanly. (User: "i blocked in a 2v2 game and
          // never heard the sound fire.")
          return this._playSample(cue.src, {
            maxDur: cue.maxDur, fadeIn: cue.fadeIn, fadeOut: cue.fadeOut,
            gain: cue.gain, category: cue.category || 'effect',
          });
        } catch (e) { return null; }
      }
      if (!this._init()) return;
      if (this._ctx.state === 'suspended') { try { this._ctx.resume().catch(() => {}); } catch (e) {} }
      switch (name) {
        case 'cardPlay':
          // Heroic ally arrival — staggered major triad (C5-E5-G5) in
          // warm triangle waves with a high-sine shimmer on top. Reads
          // as "good guy lands" — bright, rising, major-key.
          this._tone({ type: 'triangle', freq: 523, dur: 0.22, gain: 0.13, attack: 0.003, release: 0.26 });
          this._tone({ type: 'triangle', freq: 659, dur: 0.22, gain: 0.11, attack: 0.003, release: 0.26, delay: 0.04 });
          this._tone({ type: 'triangle', freq: 784, dur: 0.26, gain: 0.09, attack: 0.003, release: 0.30, delay: 0.08 });
          this._tone({ type: 'sine',     freq: 1568, dur: 0.16, gain: 0.05, attack: 0.003, release: 0.20, delay: 0.12 });
          break;
        case 'cardPlayEnemy':
          // Menacing enemy arrival — descending sawtooth A-minor triad
          // (E5 → C5 → A4, each dropping an octave through its envelope)
          // stacked over a low sub-bass rumble and a whisper of low-pass
          // noise. Reads as "something bad showed up" without being
          // overtly dissonant.
          this._tone({ type: 'sawtooth', freq: 659, freqEnd: 330, dur: 0.24, gain: 0.08, release: 0.28 });
          this._tone({ type: 'sawtooth', freq: 523, freqEnd: 262, dur: 0.24, gain: 0.09, release: 0.28, delay: 0.04 });
          this._tone({ type: 'sawtooth', freq: 440, freqEnd: 220, dur: 0.28, gain: 0.10, release: 0.32, delay: 0.08 });
          this._tone({ type: 'sine',     freq: 82,  freqEnd: 50,  dur: 0.36, gain: 0.18, release: 0.40, delay: 0.02 });
          this._noise({ dur: 0.20, gain: 0.04, highpass: 40, lowpass: 380, delay: 0.01 });
          break;
        case 'cardDestroy':
          this._tone({ type: 'sawtooth', freq: 440, freqEnd: 70, dur: 0.22, gain: 0.2, release: 0.28 });
          this._noise({ dur: 0.16, gain: 0.14, highpass: 200, lowpass: 3500 });
          break;
        case 'trick':
          // Synth-circuit trigger — two-tone sine sweep with delayed
          // harmonic. Previous version was a three-step triangle arpeggio
          // that landed arcade-chirpy; this sits cleaner in the mix.
          this._tone({ type: 'sine', freq: 440, freqEnd: 1200, dur: 0.18, gain: 0.13, attack: 0.003, release: 0.22 });
          this._tone({ type: 'sine', freq: 660, freqEnd: 1800, dur: 0.14, gain: 0.08, attack: 0.003, release: 0.18, delay: 0.05 });
          break;
        case 'blockFull':
          this._tone({ type: 'sine', freq: 523, dur: 0.5, gain: 0.18, release: 0.55 });
          this._tone({ type: 'sine', freq: 659, dur: 0.5, gain: 0.14, release: 0.55, delay: 0.04 });
          this._tone({ type: 'sine', freq: 784, dur: 0.55, gain: 0.12, release: 0.62, delay: 0.08 });
          break;
        case 'hit': {
          // Plasma / forcefield impact — sub thump body + mid pitch drop
          // + high-passed digital snap. gainMul (from _TIER_FX.sfxGain,
          // ~0.78 light → 1.40 lethal) scales the whole impact so a chip
          // tap and a lethal blow sound genuinely different — previously
          // every hit fired bit-identical. Defaults to 1 for non-tiered callers.
          const g = (typeof gainMul === 'number' && gainMul > 0) ? gainMul : 1;
          const pn = (typeof pan === 'number') ? pan : 0;   // lane-positioned stereo
          this._tone({ type: 'sine',     freq: 70,  freqEnd: 35,  dur: 0.14, gain: 0.20 * g, release: 0.18, pan: pn });
          this._tone({ type: 'triangle', freq: 380, freqEnd: 120, dur: 0.11, gain: 0.12 * g, release: 0.14, delay: 0.005, pan: pn });
          this._noise({ dur: 0.045, gain: 0.06 * g, highpass: 3200, lowpass: 7000, delay: 0.002, pan: pn });
          // Lethal sub-thump — the heaviest hits drop a 45Hz body so a kill
          // is felt as much as heard. Only the top tier earns it. (Sub stays
          // centered — low frequencies carry no useful stereo image.)
          if (g >= 1.35) {
            this._tone({ type: 'sine', freq: 46, freqEnd: 28, dur: 0.22, gain: 0.17 * g, release: 0.26, delay: 0.004 });
          }
          break;
        }
        case 'hpHit':
          this._tone({ type: 'sawtooth', freq: 130, freqEnd: 55, dur: 0.12, gain: 0.2, release: 0.18 });
          this._noise({ dur: 0.14, gain: 0.15, highpass: 120, lowpass: 1600 });
          break;
        case 'select': {
          // WAS a bare 880Hz sine pip. 880 is the top of the range the ear is
          // most sensitive to, it was a pure tone with no harmonics to soften
          // it, and it fires on EVERY card tap — so it read as a shrill beep
          // rather than a tick. Owner: "the high pitched sound when you select
          // a card get rid of and give me new sound options."
          //
          // Four alternatives, all pitched well below the old pip and shaped
          // so repeated taps layer instead of stacking into a whine. Picked in
          // Settings > Audio; 'soft' is the new default.
          const v = (UI.settings && UI.settings.selectSfx) || 'soft';
          if (v === 'off') break;
          if (v === 'pulse') {
            // Two low blips a beat apart — reads as "picked up".
            this._tone({ type: 'sine', freq: 260, dur: 0.032, gain: 0.075, release: 0.05 });
            this._tone({ type: 'sine', freq: 340, dur: 0.032, gain: 0.06,  release: 0.05, delay: 0.045 });
          } else if (v === 'glass') {
            // Mid sine with a filtered tick on top — tactile, still not shrill.
            this._tone({ type: 'sine', freq: 520, dur: 0.04, gain: 0.06, release: 0.08 });
            this._noise({ dur: 0.03, gain: 0.035, highpass: 1200, lowpass: 4000 });
          } else if (v === 'lift') {
            // No tone at all — filtered noise only, the sound of a card being
            // slid off a stack.
            this._noise({ dur: 0.06, gain: 0.06, highpass: 700, lowpass: 5200 });
          } else {
            // 'soft' — a low triangle that falls slightly. Triangle rather than
            // sine so it has a little harmonic body and does not sit as a pure
            // sustained pitch.
            this._tone({ type: 'triangle', freq: 300, freqEnd: 240, dur: 0.045, gain: 0.075, release: 0.07 });
          }
          break;
        }
        case 'uiHover':
          // Tron-style digital hover blip — triangle wave with a quick
          // upward sweep + sine harmonic shimmer for a clean synthetic
          // feel. Kept short and quiet so rapid button-to-button hovers
          // layer gracefully instead of becoming a pulse.
          this._tone({ type: 'triangle', freq: 860, freqEnd: 1280, dur: 0.055, gain: 0.08, attack: 0.002, release: 0.09 });
          this._tone({ type: 'sine',     freq: 1720, freqEnd: 2160, dur: 0.04,  gain: 0.04, attack: 0.002, release: 0.06, delay: 0.012 });
          break;
        case 'kill':
          // "Got 'em" confirm — two ascending triangle blips with a tiny
          // high-sine shimmer for a satisfying kill confirmation. Fires
          // when the PLAYER kills an enemy (not when an AI kill happens
          // against you). Sits between the attack cue and the death cue
          // so the sequence reads: impact → confirm → death.
          this._tone({ type: 'triangle', freq: 659,  freqEnd: 988,  dur: 0.07, gain: 0.09, attack: 0.002, release: 0.09 });
          this._tone({ type: 'triangle', freq: 988,  freqEnd: 1318, dur: 0.06, gain: 0.08, attack: 0.002, release: 0.08, delay: 0.06 });
          this._tone({ type: 'sine',     freq: 1976, dur: 0.05, gain: 0.04, attack: 0.002, release: 0.06, delay: 0.09 });
          break;
        case 'evade':
          // Dodge whoosh — a quick rising sine sweep + high-shelf noise
          // puff for the "air moving" feel. Kept very short so it
          // doesn't compete with the attack cue that triggered it.
          this._tone({ type: 'sine', freq: 440, freqEnd: 1200, dur: 0.11, gain: 0.09, attack: 0.002, release: 0.13 });
          this._noise({ dur: 0.08, gain: 0.05, highpass: 2400, lowpass: 6000 });
          break;
        case 'armor':
          // Metal deflection — sawtooth plink with a bright high-shelf
          // noise burst, like a shield ting. Slightly longer release
          // than 'hit' so the clang rings briefly before decaying.
          this._tone({ type: 'sawtooth', freq: 1320, freqEnd: 980, dur: 0.09, gain: 0.10, attack: 0.001, release: 0.16 });
          this._tone({ type: 'triangle', freq: 660,  freqEnd: 550, dur: 0.07, gain: 0.06, attack: 0.001, release: 0.12, delay: 0.008 });
          this._noise({ dur: 0.06, gain: 0.07, highpass: 3800, lowpass: 9000, delay: 0.003 });
          break;
        case 'heal':
          // Rising major-3rd chime — ascending triad on soft sines, no
          // noise, so it reads as clean restoration. One cue per heal
          // event (not per HP point) — stacked heals won't chain-fire.
          this._tone({ type: 'sine', freq: 784,  dur: 0.18, gain: 0.10, attack: 0.004, release: 0.22 });
          this._tone({ type: 'sine', freq: 988,  dur: 0.18, gain: 0.09, attack: 0.004, release: 0.22, delay: 0.05 });
          this._tone({ type: 'sine', freq: 1318, dur: 0.20, gain: 0.07, attack: 0.004, release: 0.26, delay: 0.10 });
          break;
        case 'defaultAbility':
          // Generic ability confirm — used as the fallback when a card
          // has no registered ability file. Bright synth-snap: triangle
          // up-sweep + sine harmonic shimmer. Short (~0.12s) so repeat
          // plays don't pile up. Distinct from 'cardPlay' / 'hit' / 'kill'
          // so the ear reads it as "that card did a thing".
          this._tone({ type: 'triangle', freq: 523, freqEnd: 880, dur: 0.10, gain: 0.10, attack: 0.002, release: 0.14 });
          this._tone({ type: 'sine',     freq: 1320, dur: 0.07, gain: 0.05, attack: 0.002, release: 0.10, delay: 0.025 });
          break;
        case 'cardHover':
          // Deeper card / trick focus cue — still Tron-digital, but
          // dropped roughly an octave from the UI button blip so it
          // feels grounded rather than pingy. Faint high-sine shimmer
          // keeps the cue audible without being tinny. Fires as the
          // fallback for any card / trick with no registered hover file.
          this._tone({ type: 'triangle', freq: 260, freqEnd: 390, dur: 0.09, gain: 0.10, attack: 0.003, release: 0.12 });
          this._tone({ type: 'sine',     freq: 520, freqEnd: 780, dur: 0.07, gain: 0.04, attack: 0.003, release: 0.10, delay: 0.015 });
          break;
        case 'victory':
          this._tone({ type: 'triangle', freq: 523, dur: 0.7, gain: 0.2,  release: 0.9 });
          this._tone({ type: 'triangle', freq: 659, dur: 0.7, gain: 0.17, release: 0.9, delay: 0.09 });
          this._tone({ type: 'triangle', freq: 784, dur: 0.8, gain: 0.15, release: 1.0, delay: 0.18 });
          this._tone({ type: 'sine',     freq: 1046, dur: 1.0, gain: 0.11, release: 1.1, delay: 0.32 });
          break;
        case 'defeat':
          this._tone({ type: 'sawtooth', freq: 220, dur: 0.5, gain: 0.13, release: 0.7 });
          this._tone({ type: 'sawtooth', freq: 175, dur: 0.6, gain: 0.13, release: 0.8, delay: 0.18 });
          this._tone({ type: 'sawtooth', freq: 147, dur: 0.8, gain: 0.14, release: 1.0, delay: 0.4 });
          this._noise({ dur: 0.6, gain: 0.05, highpass: 80, lowpass: 900, delay: 0.1 });
          break;

        // ---- Roguelite UI cues (audit wave 3) ----------------------
        case 'modalOpen':
          // Soft swoosh-in — quick rising sine + faint noise puff.
          // Reads as "panel slid in." Quiet so back-to-back modal
          // opens layer cleanly.
          this._tone({ type: 'sine', freq: 220, freqEnd: 540, dur: 0.10, gain: 0.06, attack: 0.005, release: 0.13 });
          this._noise({ dur: 0.08, gain: 0.025, highpass: 1200, lowpass: 4000 });
          break;
        case 'modalClose':
          // Snap-out — falling sine + tiny click. Distinct from modalOpen
          // so the player feels the modal commit on close.
          this._tone({ type: 'sine', freq: 540, freqEnd: 220, dur: 0.08, gain: 0.05, attack: 0.002, release: 0.10 });
          this._tone({ type: 'triangle', freq: 1200, dur: 0.025, gain: 0.04, release: 0.04, delay: 0.04 });
          break;
        case 'rewardPick':
          // Major-chord rise — the "you got it" moment for a card pick.
          // Triangle chord (G5-B5-D6) with high-sine shimmer, slightly
          // brighter / longer than 'cardPlay' so it reads as a meta-pick
          // rather than an in-fight play.
          this._tone({ type: 'triangle', freq: 784,  dur: 0.26, gain: 0.13, attack: 0.003, release: 0.32 });
          this._tone({ type: 'triangle', freq: 988,  dur: 0.26, gain: 0.11, attack: 0.003, release: 0.32, delay: 0.05 });
          this._tone({ type: 'triangle', freq: 1175, dur: 0.30, gain: 0.09, attack: 0.003, release: 0.36, delay: 0.10 });
          this._tone({ type: 'sine',     freq: 2349, dur: 0.18, gain: 0.05, attack: 0.003, release: 0.22, delay: 0.14 });
          break;
        case 'levelUpPick':
          // Sharper synth-burst tied to a card leveling — bright triangle
          // up-sweep with two harmonic shimmer layers. Distinct from
          // rewardPick so the ear reads "card upgraded" vs "deck added".
          this._tone({ type: 'triangle', freq: 660,  freqEnd: 1320, dur: 0.13, gain: 0.11, attack: 0.002, release: 0.16 });
          this._tone({ type: 'sine',     freq: 1320, freqEnd: 2640, dur: 0.10, gain: 0.06, attack: 0.002, release: 0.13, delay: 0.04 });
          this._tone({ type: 'sine',     freq: 1980, dur: 0.07, gain: 0.04, attack: 0.002, release: 0.10, delay: 0.08 });
          break;
        case 'relicAcquire':
          // Golden fanfare — five-note ascending arpeggio (E4-G#4-B4-E5-G#5)
          // on triangle waves with a sustained sine overtone for warmth.
          // Reads as "treasure earned" — the meta moment of relic pickup.
          this._tone({ type: 'triangle', freq: 330,  dur: 0.18, gain: 0.13, attack: 0.003, release: 0.22 });
          this._tone({ type: 'triangle', freq: 415,  dur: 0.18, gain: 0.13, attack: 0.003, release: 0.22, delay: 0.08 });
          this._tone({ type: 'triangle', freq: 494,  dur: 0.20, gain: 0.13, attack: 0.003, release: 0.24, delay: 0.16 });
          this._tone({ type: 'triangle', freq: 659,  dur: 0.22, gain: 0.13, attack: 0.003, release: 0.28, delay: 0.24 });
          this._tone({ type: 'triangle', freq: 831,  dur: 0.30, gain: 0.12, attack: 0.003, release: 0.36, delay: 0.32 });
          this._tone({ type: 'sine',     freq: 1660, dur: 0.40, gain: 0.06, attack: 0.05,  release: 0.44, delay: 0.34 });
          break;
        case 'curseAcquire':
          // Descending dissonant buzz — inverse of relicAcquire. Sawtooth
          // tritone slide from F#4 → C4, low rumble underneath, faint
          // band-passed noise wash for menace.
          this._tone({ type: 'sawtooth', freq: 370, freqEnd: 220, dur: 0.32, gain: 0.10, attack: 0.005, release: 0.36 });
          this._tone({ type: 'sawtooth', freq: 277, freqEnd: 165, dur: 0.36, gain: 0.10, attack: 0.005, release: 0.40, delay: 0.06 });
          this._tone({ type: 'sine',     freq: 80,  freqEnd: 50,  dur: 0.40, gain: 0.12, release: 0.44 });
          this._noise({ dur: 0.30, gain: 0.04, highpass: 200, lowpass: 1100, delay: 0.04 });
          break;
        case 'bossSting':
          // Deep rumble + low brassy sting — the moment the boss intro
          // splash lands. Sub-bass + low-pass noise bed + a single
          // descending sawtooth phrase.
          this._tone({ type: 'sine',     freq: 55,  dur: 0.85, gain: 0.20, release: 0.95 });
          this._tone({ type: 'sawtooth', freq: 110, freqEnd: 82, dur: 0.55, gain: 0.10, attack: 0.05, release: 0.65, delay: 0.10 });
          this._tone({ type: 'sawtooth', freq: 165, freqEnd: 123, dur: 0.55, gain: 0.08, attack: 0.05, release: 0.65, delay: 0.18 });
          this._noise({ dur: 0.55, gain: 0.045, highpass: 60, lowpass: 600, delay: 0.05 });
          break;
        case 'statusFreeze':
          // Crystalline shimmer — high sine with tremolo-style harmonic.
          // Reads as "ice formed" without a sharp attack.
          this._tone({ type: 'sine', freq: 1760, dur: 0.18, gain: 0.06, attack: 0.005, release: 0.22 });
          this._tone({ type: 'sine', freq: 2349, dur: 0.16, gain: 0.04, attack: 0.005, release: 0.20, delay: 0.04 });
          this._noise({ dur: 0.10, gain: 0.02, highpass: 4000, lowpass: 9000, delay: 0.02 });
          break;
        case 'statusStun':
          // Electric crackle — quick noise burst + descending square
          // chirp. Reads as "zapped."
          this._noise({ dur: 0.10, gain: 0.10, highpass: 1500, lowpass: 6000 });
          this._tone({ type: 'square', freq: 880, freqEnd: 220, dur: 0.10, gain: 0.06, attack: 0.001, release: 0.12, delay: 0.005 });
          break;
        case 'statusFear':
          // Eerie low-pass moan — slow sine with detuned partial below.
          // Reads as "spooked."
          this._tone({ type: 'sine', freq: 196, freqEnd: 233, dur: 0.30, gain: 0.10, attack: 0.04, release: 0.34 });
          this._tone({ type: 'sine', freq: 147, freqEnd: 175, dur: 0.32, gain: 0.07, attack: 0.04, release: 0.36, delay: 0.02 });
          this._noise({ dur: 0.20, gain: 0.025, highpass: 100, lowpass: 600, delay: 0.05 });
          break;
        case 'statusMindCtrl':
          // Warbling sweep — pitch-modulated sine pair. Reads as "you
          // are not yourself anymore."
          this._tone({ type: 'sine', freq: 440, freqEnd: 660, dur: 0.22, gain: 0.08, attack: 0.005, release: 0.26 });
          this._tone({ type: 'sine', freq: 660, freqEnd: 440, dur: 0.22, gain: 0.07, attack: 0.005, release: 0.26, delay: 0.03 });
          break;
        case 'etchApply':
          // Synth-tick when an etch applies to a card. Two-tone rising
          // ping. Distinct from rewardPick / levelUpPick so chained
          // cues read clearly.
          this._tone({ type: 'triangle', freq: 1175, dur: 0.05, gain: 0.07, attack: 0.001, release: 0.07 });
          this._tone({ type: 'sine',     freq: 2349, dur: 0.04, gain: 0.04, attack: 0.001, release: 0.06, delay: 0.025 });
          break;
        // ---- Phase-transition variants (audit wave 4) -----------
        case 'phaseEngage':
          // Combat-ready snap — rising sawtooth pulse with a sharp
          // noise crack. Distinct from boot's rolling whoosh; this
          // is fast and aggressive, the moment of "weapons hot."
          // Fires on roguelite-map → first-fight-phase.
          this._tone({ type: 'sawtooth', freq: 220, freqEnd: 660, dur: 0.18, gain: 0.14, attack: 0.002, release: 0.22 });
          this._tone({ type: 'sawtooth', freq: 165, freqEnd: 110, dur: 0.16, gain: 0.10, attack: 0.002, release: 0.20, delay: 0.10 });
          this._noise({ dur: 0.06, gain: 0.10, highpass: 2200, lowpass: 6500, delay: 0.04 });
          this._tone({ type: 'sine', freq: 90, freqEnd: 55, dur: 0.20, gain: 0.18, attack: 0.005, release: 0.24 });
          break;
        case 'phaseCommit':
          // Calm "saving data" descending three-tone — soft sines on
          // a major triad descent (G5 → E5 → C5). Reads as the run
          // committing the result, not a fanfare. Fires on
          // in-fight → roguelite-rewards.
          this._tone({ type: 'sine', freq: 784, dur: 0.22, gain: 0.10, attack: 0.005, release: 0.26 });
          this._tone({ type: 'sine', freq: 659, dur: 0.22, gain: 0.09, attack: 0.005, release: 0.26, delay: 0.18 });
          this._tone({ type: 'sine', freq: 523, dur: 0.32, gain: 0.08, attack: 0.005, release: 0.40, delay: 0.36 });
          this._noise({ dur: 0.30, gain: 0.02, highpass: 600, lowpass: 3000, delay: 0.04 });
          break;
        case 'phaseReturn':
          // Contemplative ink-spread — slow sustained sine pad with
          // a faint shimmer. The "back to the map" beat. No drum,
          // no edge, just a quiet wash.
          this._tone({ type: 'sine', freq: 220, freqEnd: 196, dur: 0.65, gain: 0.07, attack: 0.10, release: 0.75 });
          this._tone({ type: 'sine', freq: 330, dur: 0.55, gain: 0.05, attack: 0.10, release: 0.65, delay: 0.10 });
          this._tone({ type: 'sine', freq: 1100, dur: 0.40, gain: 0.03, attack: 0.10, release: 0.50, delay: 0.20 });
          break;
      }
    }
  },

  // Tron-style button-hover cue — short digital blip whenever the cursor
  // enters a <button> or .btn element anywhere in the app. Uses the same
  // enter/leave semantics as the card hover (relatedTarget check filters
  // child-element bubbles) plus a same-element guard so a stationary
  // cursor on a button that re-renders doesn't re-trigger.
  installUiHoverSfx() {
    if (this._uiHoverInstalled) return;
    this._uiHoverInstalled = true;
    const getBtn = (node) => {
      if (!node || !node.closest) return null;
      // Match any <button>, .btn-class element, and the menu/deck tiles
      // that are clickable but rendered as divs (mm-option, md-deck-card,
      // mode-tile). Excludes card / trick elements — those have their
      // own hover audio via installCardSfx.
      return node.closest(
        'button, .btn, .mm-option, .mm-btn, .md-action-btn, .md-deck-card, .mode-tile, .theme-swatch, .settings-cog, .log-drawer-toggle, .draft-mulligan-btn, .draft-settings-btn, .draft-quit-btn, .mode-back, .md-back, .stats-back'
      );
    };
    document.addEventListener('mouseover', (e) => {
      const curr = getBtn(e.target);
      if (!curr) return;
      const from = getBtn(e.relatedTarget);
      if (from === curr) return; // bubble from child, still inside same button
      // Don't fire when hovering inside a disabled button (no affordance).
      if (curr.disabled) return;
      this.sfx.play('uiHover');
    });
  },

  // Wire per-card / per-trick SFX hooks. Installed once from init(). The
  // registry itself (UI.sfx.CARD_SFX / TRICK_SFX) is where filepaths live
  // — this function only translates user input and game events into
  // playCardSfx / playTrickSfx calls on the right element/name/event.
  installCardSfx() {
    if (this._cardSfxInstalled) return;
    this._cardSfxInstalled = true;

    // ---- Hover (delegated, enter/leave semantics) ----
    // Use bubbling mouseover/mouseout plus relatedTarget so we can delegate
    // enter/leave for any card or trick element without binding per-card
    // listeners. Hover sample plays when entering a new card/trick and
    // stops when the cursor leaves it (moves to a different card OR off
    // all cards entirely). Movement between child nodes inside the same
    // card is filtered out by the relatedTarget check.
    const getHoverTarget = (node) =>
      (node && node.closest) ? node.closest('[data-card-name],[data-trick-name]') : null;
    // Per-card-name cooldown — every UI.render() call wipes the board
    // via `board.innerHTML = ''`, which fires mouseout on the previous
    // card element + a fresh mouseover on the rebuilt one. From the
    // engine's POV that looks like leaving and re-entering the card,
    // so the hover SFX retriggers on every render. We can't easily
    // suppress mouseout between renders (the element really IS gone
    // from the DOM briefly), but we CAN gate the SFX replay by name +
    // recent timestamp. Same card hovered within COOLDOWN_MS → no
    // replay. Moving to a DIFFERENT card → different name → plays.
    // User report: "its highliting the card over and over while the
    // curser is over it... the sound it keeps playing over and over."
    const HOVER_SFX_COOLDOWN_MS = 1000;
    // Intent delay — user has to dwell on a card for HOVER_SFX_DELAY_MS
    // before its hover audio fires. Without this gate, sweeping the
    // cursor across the hand triggers a chain of overlapping hover cues
    // (each cut by the next), which sounds messy.
    //
    // 2026-05-19 — dropped from 1500 → 300 ms. User report: "it should
    // be sharp when it start playing and when it ends the delay is
    // causing the lag." 1.5 s dwell + 1 s fade-in = ~2.5 s from hover
    // to audible, which felt like the app was sluggish to react.
    // 300 ms is still enough to filter accidental swipe-overs but
    // makes the hover→audio transition feel immediate.
    const HOVER_SFX_DELAY_MS = 300;
    const lastHoverByName = {};
    // Cancel any scheduled-but-not-yet-fired hover SFX. Called on mouse-
    // out, on movement to another card, and from _stopHover so the timer
    // can never outlive the cursor it was tracking.
    const cancelPendingHover = () => {
      if (this.sfx._hoverDelayTimer) {
        clearTimeout(this.sfx._hoverDelayTimer);
        this.sfx._hoverDelayTimer = null;
        this.sfx._hoverDelayEl = null;
      }
    };
    // Track the last touchstart time so the mouseover handler below can
    // ignore iOS synthetic mouseover events that fire immediately after a
    // finger tap (those produce a spurious hover-SFX that cuts off mid-play
    // and sounds wrong). Long-press hover audio is handled separately in
    // installLongPressInspect instead.
    document.addEventListener('touchstart', () => { this._lastTouchMs = Date.now(); }, { passive: true });

    // DID THE USER ACTUALLY POINT AT THIS, OR DID IT SLIDE UNDER THEM?
    // A mouseover does not mean the cursor moved. Every render rebuilds the
    // hand, so a card drawn into it lands under a stationary cursor and fires
    // mouseover all by itself — and 280ms later the card announces its own
    // identifying theme to the whole room. That is the draw leak: you never
    // touched the mouse and everyone just heard which card you drew.
    // Recording the last REAL movement lets the dwell callback tell the two
    // apart. Passive listener, one timestamp, no work per event.
    document.addEventListener('mousemove', () => { this.sfx._lastPointerMoveAt = Date.now(); }, { passive: true });
    document.addEventListener('mouseover', (e) => {
      const curr = getHoverTarget(e.target);
      if (!curr) return;
      const from = getHoverTarget(e.relatedTarget);
      if (from === curr) return; // still inside the same card; bubbled child
      // Skip hover audio for synthetic mouseover events fired by iOS right
      // after a finger tap. A real mouse hover arrives without any recent
      // touchstart; a tap-triggered synthetic arrives within ~50 ms of one.
      if (this._lastTouchMs && (Date.now() - this._lastTouchMs) < 500) return;
      // CANCEL any pending mouseout-to-empty stop — the user came
      // back onto a hover target before the 3 s delayed-stop fired,
      // so we want to keep the audio playing without interruption
      // (or take a clean handoff if they re-hover a different card).
      // Scoped here because both the same-card return AND the
      // different-card stopHover paths below need the cancel.
      if (this.sfx._pendingStopHover) {
        clearTimeout(this.sfx._pendingStopHover);
        this.sfx._pendingStopHover = null;
      }
      // Already hovering this exact element — skip to avoid retriggering
      // audio on any browser quirk that fires a spurious mouseover from
      // outside (e.g. brief transform flicker).
      if (this.sfx._currentHoverEl === curr) return;
      const name = curr.getAttribute('data-card-name') || curr.getAttribute('data-trick-name');
      // Cooldown gate — if we played a hover SFX for THIS card name
      // very recently, this is almost certainly a render-rebuild
      // re-entry, not a genuine new hover. Skip the SFX play but
      // still update _currentHoverEl so the mouseout handler can
      // tear down cleanly when the cursor really leaves.
      const now = Date.now();
      const recently = name && lastHoverByName[name] && (now - lastHoverByName[name]) < HOVER_SFX_COOLDOWN_MS;
      if (recently) {
        this.sfx._currentHoverEl = curr;
        return;
      }
      // Moving from one card to another — FORCE stop the previous
      // card's sample. The selectedCard guard in _stopHover only
      // protects "mouse left card to non-card area" (keep playing
      // while selected). Moving to another card means a new hover
      // is taking over — old must die or it orphans and plays for
      // its full duration. User report: "sometimes the hover music
      // gets stuck playing way after the cards played and im not
      // hovering."
      if (this.sfx._currentHoverEl) this.sfx._stopHover(true);
      cancelPendingHover();
      this.sfx._currentHoverEl = curr;
      // How stale was the cursor when this hover arrived? A real hover follows
      // a movement by a few ms; a reflow-under-a-still-cursor has none.
      this.sfx._hoverArmedMoveAge = now - (this.sfx._lastPointerMoveAt || 0);
      // Schedule the SFX to fire after the dwell timeout. If the user
      // leaves before the timer fires, mouseout cancels it.
      this.sfx._hoverDelayEl = curr;
      this.sfx._hoverDelayTimer = setTimeout(() => {
        this.sfx._hoverDelayTimer = null;
        this.sfx._hoverDelayEl = null;
        // Re-confirm the cursor is still on this element — guards against
        // any race where we missed a mouseout cancel.
        if (this.sfx._currentHoverEl !== curr) return;
        // POST-PLAY LOCKOUT — block hover audio from re-arming during
        // the brief window after a card is played. When the user clicks
        // a lane to place a card, the cursor lands on the freshly-
        // materialized board card; without this gate, the dwell timer
        // would fire 280ms later and re-trigger hover audio that the
        // play hook had just faded out, producing the "hover never
        // stopped" perception. Two tiers: a global 1.6s lock on ALL
        // hover, and a 2.4s lock on the SAME card name we just played
        // (since same-name resume from the pool is the worst offender —
        // sonically identical to "the audio didn't stop at all"). On
        // expiry we silently allow the hover to fire normally.
        const now = Date.now();
        const sfx = this.sfx;
        if (sfx._postPlayHoverLockUntil && now < sfx._postPlayHoverLockUntil) return;
        if (sfx._postPlayHoverLockName === name && now < (sfx._postPlayHoverLockNameUntil || 0)) return;
        // THE CARD CAME TO THE CURSOR, NOT THE OTHER WAY ROUND — say nothing
        // that identifies it. Either the pointer had not moved for a beat when
        // this hover armed (the card reflowed under it), or a card has just
        // entered this hand (see _handGrewAt, set by renderPlayerHand, which
        // covers a draw, a redraw, a steal, a Batman Who Laughs keep — every
        // path that puts a new card in front of you). The generic blip still
        // fires, so the surface stays tactile; only the tell is withheld.
        // (User: "make sure sound cues and hover don't fire when cards are
        // drawn so enemy players cant hear them.")
        const STILL_CURSOR_MS = 150;
        const armedStill = (sfx._hoverArmedMoveAge == null) || (sfx._hoverArmedMoveAge > STILL_CURSOR_MS);
        const handJustGrew = now < ((this._handGrewAt || 0) + 1400);
        const isCard = curr.hasAttribute('data-card-name');
        const audio = (armedStill || handJustGrew)
          ? null
          : (isCard ? this.sfx.playCardSfx(name, 'hover')
                    : this.sfx.playTrickSfx(name, 'hover'));
        if (!audio) this.sfx.play('cardHover');
        this.sfx._currentHoverAudio = audio;
        // Track the source card NAME so _stopHover can keep the audio
        // running when the card is selected (mid-placement). User
        // spec: hover music continues through the click→place flow.
        this.sfx._currentHoverName = name;
        if (name) lastHoverByName[name] = Date.now();
        // NATURAL-END CLEANUP — when the hover audio finishes by
        // itself (clip reached its baked fade-out, or capFade
        // wound it down), clear the tracker refs so a subsequent
        // mouseover on the same card can start a fresh playback.
        // Without this, _currentHoverEl + _currentHoverName stay
        // pinned to the now-silent card forever, and the
        // same-card-re-hover guard at the top of mouseover (line
        // 2740) would suppress the next hover indefinitely.
        // Also: a stale _currentHoverAudio = audio that's already
        // ended means the "is this card's audio still playing?"
        // check in openCardInspect dedup falls through to "yes"
        // and skips re-triggering — leaving silence. User report
        // 2026-05-19: "the audio will keep playing after I'm done
        // hover over the card creating multiple hovers playing at
        // once." Stops the pile-up by ensuring each card's audio
        // has exactly one lifecycle.
        if (audio && typeof audio.addEventListener === 'function') {
          const sfx = this.sfx;
          const cleanup = () => {
            if (sfx._currentHoverAudio === audio) {
              sfx._currentHoverAudio = null;
              sfx._currentHoverEl = null;
              sfx._currentHoverName = null;
            }
          };
          audio.addEventListener('ended', cleanup, { once: true });
          // Pause may fire from a fade-out (engine cap or
          // _stopHover) before 'ended' — treat both as terminal.
          audio.addEventListener('pause', cleanup, { once: true });
        }
      }, HOVER_SFX_DELAY_MS);
    });
    document.addEventListener('mouseout', (e) => {
      const curr = getHoverTarget(e.target);
      if (!curr) return;
      const to = getHoverTarget(e.relatedTarget);
      if (to === curr) return; // still inside the same card
      if (this.sfx._hoverDelayEl === curr) cancelPendingHover();
      // Mouseout handling — three cases:
      //
      //   (a) Moving to ANOTHER hover target (a different card or
      //       trick): fire _stopHover(true) immediately so the
      //       new mouseover starts cleanly. The new hover's
      //       1.5 s dwell timer covers the transition.
      //
      //   (b) Moving to EMPTY SPACE (board lanes, body, hand row
      //       gap, codex panel padding, etc.): SCHEDULE a stop
      //       3 s out instead of firing immediately. If the user
      //       returns to the SAME card within that window
      //       (briefly slid off then back on), the mouseover
      //       handler cancels the scheduled stop and the audio
      //       keeps playing — covers the user's earlier
      //       direction "Can you hover over a card in your hand?
      //       It doesn't go — so then you get cut off, which is
      //       not what I want." If they don't return, the
      //       scheduled stop fires and the clip gracefully fades
      //       — covers today's direction "the audio will keep
      //       playing after I'm done hover over the card
      //       creating multiple hovers playing at once which lags
      //       the game" (codex Jigsaw → leave → audio
      //       orphaned). 3 s is generous enough for "I'm
      //       repositioning my cursor on this card" but short
      //       enough that abandoned hovers don't tail forever.
      if (to && this.sfx._currentHoverEl === curr) {
        // Different-card transition — stop now.
        if (this.sfx._pendingStopHover) {
          clearTimeout(this.sfx._pendingStopHover);
          this.sfx._pendingStopHover = null;
        }
        this.sfx._stopHover(true);
      } else if (!to && this.sfx._currentHoverEl === curr) {
        // Empty-space transition — schedule a delayed stop. 2026-05-19,
        // dropped from 3000 → 200 ms per user direction: the lingering
        // 3 s tail was perceived as lag ("the delay is causing the
        // lag"). 200 ms is enough to absorb a tiny cursor wobble off
        // the card edge without restarting the audio (re-hover within
        // this window cancels the pending stop), but quick enough
        // that "actually moved off" feels immediate.
        if (this.sfx._pendingStopHover) clearTimeout(this.sfx._pendingStopHover);
        this.sfx._pendingStopHover = setTimeout(() => {
          this.sfx._pendingStopHover = null;
          this.sfx._stopHover(true);
        }, 200);
      }
    });

    // ---- Audio model v3 ----
    // Per-card events: hover / play / ability / death / voiceLine.
    //   • play XOR ability — exactly one fires when a card enters play,
    //     chosen by whether the card has an onPlay clause (ability if yes,
    //     play if no). User spec: "some cards have a win played and some
    //     cards don't, so it's either one of the two".
    //   • voiceLine — fires AT MOST ONCE per round across both sides. The
    //     highest-cost card that lands a kill gets to speak. See the
    //     combat preamble in Game.resolveCombat (below) for delegate
    //     pre-computation and the killCard hook for gated firing.
    //   • death — fires on the highest-cost dying card in a lane (lane
    //     has one audio slot; voiceLine trumps death if both would fire).

    // ---- Play cue on card entry ----
    if (Game.playCard) {
      const orig = Game.playCard.bind(Game);
      Game.playCard = (owner, card, laneIdx, ...rest) => {
        const r = orig(owner, card, laneIdx, ...rest);
        if (r && card && card.name) {
          // Per-card placement cue. Effect-themed sounds (freeze, stun,
          // damage, etc.) fire from the central EFFECT_SFX hooks below
          // when the effect actually applies — independent of which card
          // triggered them. So Superman's flow is: placement cue → freeze
          // SFX (after target 1 picked) → freeze SFX (after target 2) →
          // damage SFX (after final target).
          // A Wonder Weapon takes the trick route — the one the candies use and
          // the owner can actually hear. Everything else is unchanged.
          const _playSfxEl = (card.type === 'wonder' && this.sfx.playTrickSfx)
            ? this.sfx.playTrickSfx(card.name, 'play')
            : this.sfx.playCardSfx(card.name, 'play', card);
          // Track when the play SFX ends so the AI queue and player click
          // handler can stagger the next card play until the audio finishes.
          if (_playSfxEl) {
            // FULL-SFX end — read ONLY by the hover lockout below so a hover
            // theme can't resume on top of a still-playing play cue. Size it
            // off the registry's capped length (not a flat 5s when .duration
            // is still NaN on the clip's first play).
            const _sfxCap = _playSfxEl._sfxMaxDur || 5.0;
            const _sfxDur = (!isNaN(_playSfxEl.duration) && _playSfxEl.duration > 0)
              ? Math.min(_playSfxEl.duration, _sfxCap)
              : _sfxCap;
            this.sfx._playCardSfxEndsAt = Date.now() + _sfxDur * 1000;
            // PLAY-TO-PLAY stagger — a SHORT gate (read by the player's play
            // action + the AI queue) that stops two card cues firing on the
            // same beat WITHOUT freezing the hand for the full clip. The audio
            // keeps playing underneath (ducked); only the next PLAY waits.
            this.sfx._playStaggerUntil = Date.now() + Math.min(_sfxDur, 1.4) * 1000;
          }
          // POST-PLAY HOVER LOCKOUT — when the user clicks a lane to
          // place a card, the cursor naturally lands on the freshly-
          // placed board card (since the card materializes under the
          // cursor). The mouseenter dwell timer would then fire 280ms
          // later and RESUME the hover audio from where the post-play
          // fade left off, making it sound like "the hover never
          // stopped." User report: "I played Obi Wan. and his hover
          // was still going on when I was not hovering over him." The
          // lockout suppresses any new hover firing for ~1.6s after
          // any play, plus on the same-named card we cap it at 2.4s
          // since the resume from the played card's own audio is
          // sonically identical to "still playing."
          // Extend hover lockout to cover the full when-played SFX duration
          // so hovering during a play sound doesn't start a new hover track
          // on top of it. Floor at 1600ms for cards with no registered SFX.
          const _sfxLockMs = (this.sfx._playCardSfxEndsAt && this.sfx._playCardSfxEndsAt > Date.now())
            ? Math.max(1600, this.sfx._playCardSfxEndsAt - Date.now())
            : 1600;
          this.sfx._postPlayHoverLockUntil = Date.now() + _sfxLockMs;
          this.sfx._postPlayHoverLockName = card.name;
          this.sfx._postPlayHoverLockNameUntil = Date.now() + Math.max(2400, _sfxLockMs);
          // After the card plays, GRADUALLY fade out the hover audio
          // over 3 seconds. The hover music has already been ducked to
          // 50% by the play SFX (see _playSample's duck logic), and
          // this long fade-out ensures it gracefully blends into
          // silence as the play SFX runs its course. User spec: "the
          // hover music plays, but just like at, like, 50% of its
          // actual decibels, and then the [play SFX] is on top of
          // that... I think that'd be really, really smooth."
          // 3s gives the play SFX (max 5s capped) plenty of overlap
          // before the hover fully fades out.
          //
          // Same-name fast path: fade the tracked _currentHoverAudio.
          // Different name (or null) path: walk _activeHover and fade
          // ALL active hover clones — covers the case where the user
          // hovered another card briefly between hovering Obi-Wan and
          // playing him, leaving an orphan still in the active set.
          const sfx = this.sfx;
          if (owner === 'player') {
            if (sfx._currentHoverName === card.name) {
              const a = sfx._currentHoverAudio;
              if (a && !a.paused) sfx._fadeToPauseAtPosition(a, 3000);
            }
            // Fade out EVERY active hover clone, not just the tracked
            // one. Belt-and-suspenders: even if the bookkeeping above
            // missed an orphan (e.g. a leaked sample from a quick
            // hover swap), this catches it. Caps the perceived
            // "hover lingering after play" bug entirely.
            if (sfx._activeHover && sfx._activeHover.size > 0) {
              sfx._activeHover.forEach(h => {
                if (h && !h.paused) sfx._fadeToPauseAtPosition(h, 3000);
              });
            }
            sfx._currentHoverAudio = null;
            sfx._currentHoverEl = null;
            sfx._currentHoverName = null;
            sfx.restoreMusic();
          }
        }
        return r;
      };
    }

    // ---- Play cue for summoned real cards (Mother Box, Bat Signal, SSS, etc.) ----
    // summonCard bypasses the playCard hook, so summoned real cards never
    // triggered their play SFX. Hook summonCard and fire 'play' for any
    // summon that has a sourceDef (i.e. a real card, not a token).
    // Pennywise and Freddy Krueger are excluded — their jumpscare helpers
    // already fire 'spawn' + 'play' 60 ms later via setTimeout.
    if (Game.summonCard) {
      const origSummon = Game.summonCard.bind(Game);
      Game.summonCard = (owner, laneIdx, name, cost, attack, health, abilities, sourceDef) => {
        const r = origSummon(owner, laneIdx, name, cost, attack, health, abilities, sourceDef);
        if (sourceDef && name && name !== 'Pennywise' && name !== 'Freddy Krueger' && !Game._suppressSummonSfx) {
          const lane = Game.state && Game.state.lanes && Game.state.lanes[laneIdx];
          const card = lane && lane[owner];
          if (card && card.name === name) {
            if (card.type === 'wonder' && this.sfx.playTrickSfx) this.sfx.playTrickSfx(card.name, 'play'); else this.sfx.playCardSfx(card.name, 'play', card);
          }
        }
        return r;
      };
    }

    // ---- Play (trick) — separate registry from cards ----
    if (Game.playTrick) {
      const origT = Game.playTrick.bind(Game);
      Game.playTrick = (owner, trick, ...rest) => {
        const r = origT(owner, trick, ...rest);
        // deferPlaySfx tricks (Seismic Charge) fire their own cue AFTER the
        // target is chosen — here play() only ARMS the prompt and returns, so a
        // cue now would sound before the blast lands. They play it themselves.
        if (r && trick && trick.name && !trick.deferPlaySfx) this.sfx.playTrickSfx(trick.name, 'play');
        return r;
      };
    }
    // ---- Time Stone counter — doesn't go through playTrick ----
    // Game.timeStoneCounter consumes the Time Stone trick directly
    // (splices hand + pushes to playedTrickPile) to avoid the normal
    // trick-play flow, so the playTrick hook above never fires for it.
    // Patch the counter fn to emit the 'play' cue when the intercept
    // actually lands.
    if (Game.timeStoneCounter) {
      const origTS = Game.timeStoneCounter.bind(Game);
      Game.timeStoneCounter = (...rest) => {
        const hadIntercept = !!Game.state.pendingTimeStoneIntercept;
        const before = Game.state.player.trickHand.filter(t => t && t.name === 'Time Stone').length;
        const r = origTS(...rest);
        const after = Game.state.player.trickHand.filter(t => t && t.name === 'Time Stone').length;
        // Fire only if a Time Stone was actually consumed by this call
        // (prevents a no-op call with stale state from chiming).
        if (hadIntercept && after < before) this.sfx.playTrickSfx('Time Stone', 'play');
        return r;
      };
    }

    // ---- Play (free / jump) — mirror of playCard ----
    if (Game.playCardFree) {
      const origPF = Game.playCardFree.bind(Game);
      Game.playCardFree = (owner, card, laneIdx, ...rest) => {
        const r = origPF(owner, card, laneIdx, ...rest);
        if (card && card.name) { if (card.type === 'wonder' && this.sfx.playTrickSfx) this.sfx.playTrickSfx(card.name, 'play'); else this.sfx.playCardSfx(card.name, 'play', card); }
        return r;
      };
    }

    // ---- Heal ----
    // One cue per successful heal event (not per HP point). Fires only
    // when HP actually increased — capped at-max heals are silent.
    if (Game.healPlayer) {
      const origH = Game.healPlayer.bind(Game);
      Game.healPlayer = (owner, amount, ...rest) => {
        const before = (Game.state && Game.state[owner]) ? Game.state[owner].health : 0;
        const r = origH(owner, amount, ...rest);
        const after = (Game.state && Game.state[owner]) ? Game.state[owner].health : 0;
        if (after > before) this.sfx.playEffect('heal');
        return r;
      };
    }

    // ---- Effect SFX engine wrappers ----
    // Each wrapper fires playEffect(<name>, source) at the moment the
    // effect ACTUALLY APPLIES. The `source` arg lets per-card overrides
    // resolve (e.g. Mr. Freeze's freeze gun vs Black Widow's tranq).
    // sourceArgIdx tells the wrapper which positional arg holds the
    // source card — most engine functions follow `(target, source, ...)`.
    const wrapEffect = (fnName, effectName, sourceArgIdx, guard) => {
      if (!Game[fnName]) return;
      const orig = Game[fnName].bind(Game);
      Game[fnName] = (...args) => {
        const r = orig(...args);
        try {
          if (!guard || guard(r, args)) {
            const source = args[sourceArgIdx == null ? 1 : sourceArgIdx];
            this.sfx.playEffect(effectName, source);
          }
        } catch (e) { /* never let SFX break gameplay */ }
        return r;
      };
    };
    // Status effects: signature `(target, source, ...)` — source at idx 1
    wrapEffect('freezeCard',              'freeze',      1);
    wrapEffect('freezeCardUnresistible',  'freeze',      1);
    wrapEffect('stunCard',                'stun',        1);
    wrapEffect('fearCard',                'fear',        1);
    wrapEffect('mindControlCard',         'mindControl', 1);
    // Buffs / debuffs: signature `(card, atk, hp, ...)` — source isn't
    // tracked in the call, so per-card override won't resolve here
    // (those are usually called from the card's own onPlay anyway).
    wrapEffect('buffCard',   'buff',   null, (r, a) => (a[1] || 0) > 0 || (a[2] || 0) > 0);
    wrapEffect('debuffCard', 'debuff', 4,    (r, a) => (a[1] || 0) > 0 || (a[2] || 0) > 0);
    // Damage: gated on actual HP loss; source at idx 2 in
    // dealDamage(target, amount, source).
    if (Game.dealDamage) {
      const origDD = Game.dealDamage.bind(Game);
      Game.dealDamage = (target, amount, source, ...rest) => {
        const beforeHp = target ? target.currentHealth : 0;
        const r = origDD(target, amount, source, ...rest);
        const afterHp = target ? target.currentHealth : 0;
        if (afterHp < beforeHp) this.sfx.playEffect('damage', source);
        return r;
      };
    }
    // Summons — source isn't a card here (it's a string name); just
    // fire the global summon cue.
    wrapEffect('summonCard', 'summon', null);

    // ---- Death + Voice line (lane-gated, cost-based) ----
    // On a creature dying we pick ONE SFX for the lane's audio slot:
    //   1. If the killer is the pre-computed voice-line delegate AND no
    //      voice line has fired yet this round → killer's voiceLine.
    //   2. Else the dying card's death SFX — but only if this death is
    //      the highest-cost death seen in this lane's current window.
    //      (Prevents stacking two death cues when both cards in a lane
    //      die the same frame.)
    // The chosen clip's expected end time is recorded on
    // `_laneAudioEndsAt` so Game.resolveCombat's advance() can await it
    // before moving to the next lane. User spec: "it can't move on
    // until the audio stops playing".
    if (Game.killCard) {
      const origK = Game.killCard.bind(Game);
      Game.killCard = (card, source, ...rest) => {
        const isCreature = card && card.name && card.currentHealth !== undefined && typeof card.play !== 'function';
        if (!isCreature) return origK(card, source, ...rest);
        // Iron Giant will intercept this kill (save the ally, or offer the
        // sacrifice) — don't fire the dying card's death cue or seize the
        // combat lane-audio slot. A saved ally makes no death sound, and
        // the sacrifice sting (fired inside the intercept) gets a clean
        // slot. On decline, doDecline re-enters with _igOffered set → the
        // predicate returns false → the real death gets its normal cue.
        if (Game._willIronGiantIntercept && Game._willIronGiantIntercept(card)) {
          return origK(card, source, ...rest);
        }

        const hasNamedKiller = source && source.name && source.currentHealth !== undefined
                             && source.owner && source.owner !== card.owner;
        const killerName = hasNamedKiller ? source.name : null;
        const deadName = card.name;
        const deadCost = card.baseCost || card.cost || 0;

        // Voice line delegate check — fires only for the one pre-selected
        // card each round (highest-cost killer across both sides).
        const delegate = this.sfx._voiceLineDelegate;
        const isDelegateKill = delegate && hasNamedKiller
          && delegate.name === source.name
          && delegate.owner === source.owner
          && !this.sfx._voiceLineFiredThisRound;

        // Simplified SFX set — only the dying card's `death` cue fires.
        // The old voiceLine path was retired with the broader SFX cleanup
        // (user spec: "only sounds for card hover, when played, when
        // killed"). Lane-gating still applies so chained deaths in the
        // same combat don't pile up — and outside combat it does not, so an
        // ability kill (Homelander sacrificing an ally, then destroying an
        // enemy) still gets its own slot per death.
        //
        // ONE DOOR (see UI._playDeathCue). This block and the handleDeath
        // wrapper were two copies of the same gate, and only the OTHER one ever
        // runs for a combat death — so a fix applied here alone would have
        // looked right in the diff and changed nothing in a fight.
        this._playDeathCue(card, { capSec: isDelegateKill ? 3.0 : 1.5 });

        // Kill sound on the source card (trick/ability kills).
        // Set _killAudioFiredFor so handleDeath wrapper doesn't double-play.
        if (killerName && this.sfx && this.sfx.playCardSfx) {
          if (source) source._killAudioFiredFor = card.id;
          try { this.sfx.playCardSfx(killerName, 'kill', source); } catch (e) {}
        }
        return origK(card, source, ...rest);
      };
    }

    // ---- Round reset + voice-line delegate pre-pass ----
    // Clears per-round voice-line gating and pre-computes which card
    // would land a kill this combat so its voice line can fire at the
    // dramatic moment. Delegate selection uses cost priority with a
    // best-effort damage prediction (main-swing only — evade / reactive
    // ability kills are missed, but those are rare and the fallback is
    // graceful: no voice line fires that round, which is fine).
    if (Game.startRound) {
      const origSR = Game.startRound.bind(Game);
      Game.startRound = (...rest) => {
        this.sfx._voiceLineDelegate = null;
        this.sfx._voiceLineFiredThisRound = false;
        this.sfx._laneAudioEl = null;
        this.sfx._laneAudioEndsAt = 0;
        this.sfx._laneDeathCost = null;
        this.sfx._laneAudioBySide = null;
        this.sfx._inCombat = false;
        return origSR(...rest);
      };
    }
    if (Game.resolveCombat) {
      const origRC = Game.resolveCombat.bind(Game);
      Game.resolveCombat = (...rest) => {
        // Pre-pass: scan all contested lanes, predict main-swing kills,
        // pick the highest-cost predicted killer as this round's voice-
        // line delegate. Randomized tie-breaks (user spec: ties "split
        // randomly so it doesn't get muddy").
        try {
          if (!this.sfx._voiceLineFiredThisRound) {
            const candidates = [];
            for (const lane of (Game.state.lanes || [])) {
              if (!lane || lane.destroyed) continue;
              const p = lane.player, a = lane.ai;
              if (p && a) {
                // Main-swing prediction: attacker.attack vs defender.currentHealth
                if (p.attack >= a.currentHealth && !p.isStunned && !p.isFrozen && p.attack > 0) {
                  candidates.push({ name: p.name, owner: p.owner, cost: p.baseCost || p.cost || 0 });
                }
                if (a.attack >= p.currentHealth && !a.isStunned && !a.isFrozen && a.attack > 0) {
                  candidates.push({ name: a.name, owner: a.owner, cost: a.baseCost || a.cost || 0 });
                }
              }
            }
            if (candidates.length) {
              // Highest cost wins; random tie-break for equals.
              const maxCost = Math.max(...candidates.map(c => c.cost));
              const top = candidates.filter(c => c.cost === maxCost);
              this.sfx._voiceLineDelegate = top[Math.floor(Math.random() * top.length)];
            }
          }
        } catch (e) { /* non-fatal — voice line just won't fire this round */ }
        // Reset lane-audio window at combat start.
        this.sfx._laneAudioEl = null;
        this.sfx._laneAudioEndsAt = 0;
        this.sfx._laneDeathCost = null;
        this.sfx._laneAudioBySide = null;
        this.sfx._inCombat = true;
        return origRC(...rest);
      };
    }
    // ---- Audio-aware lane delay ----
    // Original COMBAT_LANE_DELAY is a flat ms number driven by aiSpeed.
    // Replace with a getter that adds the remaining lane-audio tail + a
    // 250ms breathing gap, floored at the original base delay so users
    // on "fast" mode still get a minimum beat. After a lane advance
    // consumes the delay, we reset the lane-audio tracking so the NEXT
    // lane starts with a fresh window.
    // User spec: "can't move on until the audio stops playing" + "cinematic".
    try {
      const basePropertyDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Game), 'COMBAT_LANE_DELAY')
        || Object.getOwnPropertyDescriptor(Game, 'COMBAT_LANE_DELAY');
      const origDelayGet = basePropertyDescriptor && basePropertyDescriptor.get;
      if (origDelayGet) {
        const postDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Game), 'COMBAT_POST_DELAY')
          || Object.getOwnPropertyDescriptor(Game, 'COMBAT_POST_DELAY');
        const origPostGet = postDescriptor && postDescriptor.get;
        const computeAudioTail = (baseMs) => {
          const endsAt = this.sfx._laneAudioEndsAt || 0;
          const now = performance.now();
          const remaining = endsAt > now ? (endsAt - now) : 0;
          // TWO SOURCES, take whichever says "still playing" for longer.
          // `remaining` is the BOOKED estimate, written only when a card had a
          // real death sample that won the lane's single audio slot. `live` is
          // measured off the elements that are actually sounding right now, and
          // it is the one that catches everything the booking misses: cards
          // whose death falls back to a procedural cue (playCardSfx returns
          // null, so nothing was ever booked), and any ability or voice cue an
          // onDeath trigger fired. That gap is why a lane could advance with its
          // audio still going — user: "audio combat per lane needs to resolve
          // before moving on to the next".
          const live = this.sfx.activeTailMs ? this.sfx.activeTailMs() : 0;
          // AND the visuals. Audio alone was not "resolve everything": a lane
          // could still advance with its damage numbers mid-flight, because the
          // damage float runs 1.1s against a 900ms base delay. See
          // UI.activeFxTailMs.
          const fx = this.activeFxTailMs ? this.activeFxTailMs() : 0;
          const tail = Math.max(remaining, live, fx);
          // Floor at the base delay so the aiSpeed setting still sets the pace
          // when a lane happens to be silent and still, and never go BELOW it —
          // the user reports combat reading as too fast, so audio and FX can
          // only ever extend a lane, never shorten it.
          const computed = tail > 0 ? Math.max(baseMs, tail + this.COMBAT_LANE_BEAT_MS) : baseMs;
          // Reset for next lane (the getter fires once per advance).
          this.sfx._laneAudioEl = null;
          this.sfx._laneAudioEndsAt = 0;
          this.sfx._laneDeathCost = null;
          this.sfx._laneAudioBySide = null;
          return computed;
        };
        Object.defineProperty(Game, 'COMBAT_LANE_DELAY', {
          configurable: true,
          get: () => computeAudioTail(origDelayGet.call(Game))
        });
        if (origPostGet) {
          Object.defineProperty(Game, 'COMBAT_POST_DELAY', {
            configurable: true,
            get: () => {
              // Post-delay: wait for the final lane's audio to finish, then
              // use the ORIGINAL post delay (not lane delay) as the ceiling.
              const endsAt = this.sfx._laneAudioEndsAt || 0;
              const now = performance.now();
              const remaining = endsAt > now ? (endsAt - now) : 0;
              const base = origPostGet.call(Game);
              // Same booked-vs-live pair as the lane delay above — the last
              // lane's audio is the one most likely to be cut off, since there
              // is no following lane to absorb its tail.
              const live = this.sfx.activeTailMs ? this.sfx.activeTailMs() : 0;
              const fx = this.activeFxTailMs ? this.activeFxTailMs() : 0;
              const tail = Math.max(remaining, live, fx);
              const computed = tail > 0 ? Math.max(base, tail + this.COMBAT_LANE_BEAT_MS) : base;
              this.sfx._laneAudioEl = null;
              this.sfx._laneAudioEndsAt = 0;
              this.sfx._laneDeathCost = null;
              this.sfx._laneAudioBySide = null;
              return computed;
            }
          });
        }
      }
    } catch (e) { /* audio pacing disabled — fall back to the fixed delay */ }
  },

  // Plays the ui_planetzoom WAV whenever the user switches areas of the
  // game (main menu ↔ mode select, deck builder, my decks, stats, and when
  // a match actually starts). Patches Game methods instead of adding
  // onclick attributes so we cover every call site — including `mdPlay`
  // → `Game.startMatch` from My Decks — without touching game.js.
  // Same patches also gate the looping menu music: any menu nav starts it
  // (or no-ops if already playing), and `startMatch` stops it so gameplay
  // audio owns the mix.
  installNavSounds() {
    if (this._navSoundsInstalled) return;
    this._navSoundsInstalled = true;
    if (typeof Game === 'undefined') return;
    const wrapMenu = (name) => {
      const orig = Game[name];
      if (typeof orig !== 'function') return;
      Game[name] = (...args) => {
        this.sfx.playNav();
        this.sfx.startMusic();
        return orig.apply(Game, args);
      };
    };
    wrapMenu('goToMainMenu');
    wrapMenu('goToModeSelect');
    wrapMenu('goToMyDecks');
    wrapMenu('goToStats');
    wrapMenu('enterDeckBuilder');
    // startMatch enters the draft — music KEEPS playing through both
    // draft phases (draft-cards + draft-tricks) so the menu ambience
    // carries all the way up to the first round. The stop happens when
    // startRound fires (draft is complete, combat begins).
    const origStart = Game.startMatch;
    if (typeof origStart === 'function') {
      Game.startMatch = (...args) => {
        this.sfx.playNav();
        // Arm the 20s match load-in cue — it fires on the FIRST combat
        // round of this match (see startRound below). Clear any intro
        // still ringing out from a previous match so a fast rematch
        // doesn't overlap two stings.
        this._matchIntroArmed = true;
        try { this.sfx.stopMatchIntro(); } catch (e) {}
        // Starting a match counts as onboarded — never nag with the first-run
        // tutorial prompt after the player has already dived in.
        try { localStorage.setItem('clb-onboarded', '1'); } catch (e) {}
        this._pruneMatchState();
        // Pick a fresh AI personality for this match (avatar + name
        // in the ai-bar). Round-robins via localStorage so repeats
        // feel less common.
        this._pickAiPersonality();
        return origStart.apply(Game, args);
      };
    }
    const origRound = Game.startRound;
    if (typeof origRound === 'function') {
      Game.startRound = (...args) => {
        this.sfx.stopMusic();
        // 20s match load-in cue — the former menu track. Fires once, on the
        // first combat round of a match (the "loading into the match" beat),
        // right as the menu loop fades out. The armed flag (set in
        // startMatch) guarantees it never re-triggers on later rounds.
        if (this._matchIntroArmed) {
          this._matchIntroArmed = false;
          try {
            if (!Game.state.gameOver && this.sfx && this.sfx.playMatchIntro) {
              this.sfx.playMatchIntro();
            }
          } catch (e) {}
        }
        // (AAA) Ambient arena hum — kicks in at the FIRST round of a
        // match (draft is over, gameplay starts). Idempotent:
        // arenaHumStart bails if already running. Hum fades in over
        // 1.6s on its own bus so it doesn't pop in jarringly.
        try {
          if (!Game.state.gameOver && this.sfx && this.sfx.arenaHumStart) {
            this.sfx.arenaHumStart();
          }
        } catch (e) {}
        return origRound.apply(Game, args);
      };
    }
  },
  // ---- SOUND RELAY ----
  // Guests never run the engine, so a sound an ABILITY fires only ever reaches
  // the host's speakers. Card plays and deaths were already reconstructed on
  // the guest by diffing the board (_relay2v2CardFx) and status cues ride
  // their own event, but the distinctive ones — Homelander's laser, Palpatine's
  // lightning, a trick's own voice — were host-only. (User: "make sure sounds
  // play for everyone as well.")
  // Deliberately NOT the generic sfx.play(): that is the UI's own vocabulary,
  // button clicks and hovers included, and the host's interface noise is not
  // something to broadcast into three other rooms. Only the four calls that
  // mean "a card or trick just did something" are relayed, and 'play'/'death'
  // are skipped because the board diff already covers them — relaying those
  // would double every card sound on the guest.
  installSfxBridge() {
    if (this._sfxBridgeInstalled) return;
    if (!this.sfx) return;
    this._sfxBridgeInstalled = true;
    const self = this;
    const RELAY = ['playCardSfx', 'playCardAbility', 'playEffectSfx', 'playTrickSfx'];
    RELAY.forEach((key) => {
      const fn = this.sfx[key];
      if (typeof fn !== 'function') return;
      this.sfx[key] = function (...args) {
        const isHost = typeof Game !== 'undefined' && Game.onlineRelayRole
                       && Game.onlineRelayRole() === 'host';
        const kind = args[1];
        const alreadyCovered = (key === 'playCardSfx' && (kind === 'play' || kind === 'death'));
        if (isHost && !alreadyCovered && Game.state && !Game.state._silentSim && !self._sfxReplaying) {
          // Only the primitives travel — a card argument would not survive, and
          // none of these sounds need the object, just the name.
          const payload = args.map(a => (a && typeof a === 'object') ? undefined : a);
          try { Game.emitFX('sfx', { fn: key, args: payload }); } catch (e) {}
        }
        // A SOUND MUST NEVER KILL AN ABILITY. Card code calls these straight —
        // Darth Vader's onPlay opens each of its three steps with
        // UI.sfx.playCardAbility(...) before it touches the board — and
        // _runHookBody catches whatever an onPlay throws into console.error.
        // So a throw in here does not surface as a broken sound: the card is
        // placed, the log line is already written, and the entire ability
        // silently never happens. That is indistinguishable, in play, from the
        // card having no text on it. (User: "i just played vader and his
        // ability never fired ... and i lost.")
        // The audio layer has plenty of ways to fail that have nothing to do
        // with the game — a suspended AudioContext, a file that never loaded,
        // an autoplay policy — and none of them are worth an ability for.
        try { return fn.apply(self.sfx, args); } catch (e) { console.error('[sfx ' + key + ']', e); }
      };
    });
  },
  _replaySfx(ev) {
    if (!ev || !ev.fn || !this.sfx) return;
    const fn = this.sfx[ev.fn];
    if (typeof fn !== 'function') return;
    // Guard against the wrapper re-emitting what it just replayed.
    this._sfxReplaying = true;
    try { fn.apply(this.sfx, ev.args || []); } catch (e) {}
    finally { this._sfxReplaying = false; }
  },

  // THE LANE CANNOT ADVANCE OUT FROM UNDER ITS OWN BEATS. COMBAT_LANE_DELAY is
  // already audio- and FX-aware, but it is read the instant the engine finishes
  // the lane — when every beat above is still in the future and so invisible to
  // both `activeTailMs` (nothing is sounding yet) and `activeFxTailMs` (nothing
  // is animating yet). Booking the end of the sequence into the same slot the
  // death cue already uses is what makes the existing wait cover it.
  _bookLaneAudioUntil(msFromNow) {
    if (!this.sfx) return;
    const at = performance.now() + msFromNow;
    if (at > (this.sfx._laneAudioEndsAt || 0)) this.sfx._laneAudioEndsAt = at;
  },

  // ===================== AUDIO AUDIT (dev) =====================
  // Per-card audio coverage table. Surfaces what's wired in CARD_SFX /
  // TRICK_SFX vs. what falls back to procedural CARD_PROCEDURAL or to
  // the global DEFAULT_CARD_SFX. User direction: "I can have a checklist
  // of every card and if they have audio for each specific part. And
  // then if they do, I can splice it with the fade-in/out already
  // there." So each cell is one of:
  //   • file path  → registered .mp3 / .wav with optional maxDur
  //   • generic    → procedural synth fallback (CARD_PROCEDURAL or
  //                  DEFAULT_CARD_SFX[event])
  //   • —          → no audio at all (event won't fire anything)
  //
  // Clicking a registered file opens the inline splicer — re-trim the
  // existing clip with adjustable IN/OUT and fade durations, export as
  // WAV. The user runs the standard ffmpeg pipeline on the WAV to get
  // the final 48k stereo 192k mp3 with -20 LUFS norm.
  _audioAudit: { query: '', section: 'cards' },
  openAudioAudit() {
    this.renderAudioAudit();
    const ov = document.getElementById('audio-audit-overlay');
    if (ov) ov.style.display = 'flex';
    document.body.classList.add('clb-toggle-hidden');
  },
  closeAudioAudit() {
    const ov = document.getElementById('audio-audit-overlay');
    if (ov) ov.style.display = 'none';
    document.body.classList.remove('clb-toggle-hidden');
    // Stop any in-flight previews when leaving.
    if (this._audioAuditPreview) {
      try { this._audioAuditPreview.pause(); } catch (e) {}
      this._audioAuditPreview = null;
    }
  },
  _audioAuditSetQuery(q)   { this._audioAudit.query = q || ''; this.renderAudioAudit(); },
  _audioAuditSetSection(s) { this._audioAudit.section = s; this.renderAudioAudit(); },
  // Resolve the audio status for one (name, event) pair. Returns one of:
  //   { kind: 'file', src: '<path>', maxDur?: <num> }
  //   { kind: 'generic', via: 'procedural' | 'default-file' }
  //   { kind: 'none' }
  _audioStatus(name, event, isTrick) {
    const sfx = this.sfx;
    if (!sfx) return { kind: 'none' };
    const reg = isTrick ? (sfx.TRICK_SFX || {}) : (sfx.CARD_SFX || {});
    const def = isTrick ? (sfx.DEFAULT_TRICK_SFX || {}) : (sfx.DEFAULT_CARD_SFX || {});
    // Per-card file entry wins
    const entry = (reg[name] || {})[event];
    if (entry) {
      if (typeof entry === 'string') return { kind: 'file', src: entry };
      if (entry && entry.src) return { kind: 'file', src: entry.src, maxDur: entry.maxDur };
    }
    // Procedural per-card synth (cards only)
    if (!isTrick) {
      const proc = (sfx.CARD_PROCEDURAL || {})[name];
      if (proc && typeof proc[event] === 'function') return { kind: 'generic', via: 'procedural' };
    }
    // Global default file (CARD_SFX has 'death' default; TRICK has none)
    const dflt = def[event];
    if (dflt) {
      const src = (typeof dflt === 'string') ? dflt : (dflt && dflt.src);
      if (src) return { kind: 'generic', via: 'default-file', src };
    }
    return { kind: 'none' };
  },
  // ===================== SYSTEM SFX DIRECTORY =====================
  // A flat catalog of every NON-card / NON-trick sound the engine
  // can play — UI cues, combat events, status effects, transitions,
  // match outcomes, and the boot sequence. Lets the audio audit
  // panel surface them so the user can hear each one in isolation
  // and decide which to swap. Each entry is { id, category, name,
  // desc, kind: 'procedural'|'file', src?, play }.
  //
  // `id` matches the literal passed to UI.sfx.play(name) for
  // procedural entries — keeps the directory in lock-step with the
  // play() switch in UI.sfx without duplicating the synth graphs.
  _systemSfxDirectory() {
    const sfx = this.sfx;
    if (!sfx) return [];
    // Procedural entries that route through UI.sfx.play(name). Any
    // case in that switch should appear here so the audit covers it.
    const proc = (id, category, name, desc) => ({
      id, category, name, desc,
      kind: 'procedural',
      play: () => sfx.play(id),
    });
    return [
      // ---- UI ----
      proc('uiHover',   'UI',     'UI hover',          'Tron-digital hover blip — triangle sweep + sine shimmer. Fires on menu/HUD button hover.'),
      proc('select',    'UI',     'Select tick',       'Player-chosen: soft tick / double pulse / glass tap / card lift / silent (Settings > Audio). Fires on selection toggle.'),
      proc('cardHover', 'UI',     'Card hover (default)', 'Deeper Tron blip used as the fallback for any card / trick without a registered hover file.'),
      proc('modalOpen', 'UI',     'Modal open',        'Soft swoosh-in — rising sine + faint noise puff.'),
      proc('modalClose','UI',     'Modal close',       'Snap-out — falling sine + tiny click.'),
      // ---- Card events ----
      proc('cardPlay',      'Cards', 'Card play (ally)',  'Heroic ally arrival — staggered C-major triad on triangle waves with a high shimmer.'),
      proc('cardPlayEnemy', 'Cards', 'Card play (enemy)', 'Menacing enemy arrival — descending sawtooth A-minor triad over a sub bass.'),
      proc('cardDestroy',   'Cards', 'Card destroyed',    'Falling sawtooth + filtered noise. Generic destroy cue.'),
      proc('defaultAbility','Cards', 'Default ability',   'Generic ability confirm fallback — triangle up-sweep + sine shimmer.'),
      // ---- Combat ----
      proc('hit',       'Combat', 'Hit',             'Plasma / forcefield impact — sub thump + mid pitch drop + high digital snap.'),
      proc('hpHit',     'Combat', 'HP bar hit',      'Sawtooth + noise body — fires when face HP takes damage.'),
      proc('kill',      'Combat', 'Kill confirm',    '"Got \'em" — two ascending triangle blips + high-sine shimmer when YOU kill an enemy.'),
      proc('evade',     'Combat', 'Evade dodge',     'Quick rising sine sweep + high-shelf noise puff. Fires when evade consumes a charge.'),
      proc('armor',     'Combat', 'Armor block',     'Sawtooth plink + bright noise burst — shield ting.'),
      proc('heal',      'Combat', 'Heal chime',      'Rising major-third triad on soft sines.'),
      proc('blockShield', 'Combat', 'Block meter full', 'Sci-fi energy-shield activation (audio/block-full.mp3) — fires when the block meter caps and turns a hit aside.'),
      proc('blockFull', 'Combat', 'Triple-kill sting','Three-note major chord — reused as the sting for a triple multikill.'),
      // ---- Tricks ----
      proc('trick',     'Tricks', 'Trick activate',  'Synth-circuit trigger — two-tone sine sweep with delayed harmonic.'),
      // ---- Status effects ----
      proc('statusFreeze',   'Status', 'Freeze applied',       'Status-apply cue for Freeze.'),
      proc('statusStun',     'Status', 'Stun applied',         'Status-apply cue for Stun.'),
      proc('statusFear',     'Status', 'Fear applied',         'Status-apply cue for Fear.'),
      proc('statusMindCtrl', 'Status', 'Mind Control applied', 'Status-apply cue for Mind Control.'),
      // ---- Roguelite progression ----
      proc('rewardPick',   'Roguelite', 'Reward pick',   'Major-chord rise — the "you got it" moment for a card pick.'),
      proc('levelUpPick',  'Roguelite', 'Level-up pick', 'Sharper synth-burst — bright triangle up-sweep + harmonic shimmer for a card upgrade.'),
      proc('relicAcquire', 'Roguelite', 'Relic acquire', 'Golden five-note ascending arpeggio + sustained sine overtone — treasure earned.'),
      proc('curseAcquire', 'Roguelite', 'Curse acquire', 'Descending dissonant buzz — inverse of relic.'),
      proc('bossSting',    'Roguelite', 'Boss sting',    'Heavy-low sting that lands when a boss node is entered.'),
      proc('etchApply',    'Roguelite', 'Etch apply',    'Confirmation cue when an etch lands on a card.'),
      // ---- Match outcomes ----
      proc('victory', 'Match', 'Victory fanfare', 'Ascending C-major triad + sustained shimmer. Match win.'),
      proc('defeat',  'Match', 'Defeat dirge',    'Descending sawtooth chord + low-pass noise. Match loss.'),
      // ---- Transitions ----
      // Boot-sequence components — exposed individually so each
      // layer can be auditioned in isolation, plus a "Full sequence"
      // entry that fires the actual boot routine.
      {
        id: 'boot-whoosh-low',  category: 'Transitions', kind: 'procedural',
        name: 'Boot whoosh (low)',
        desc: 'Wide-band noise burst, 200-1800 Hz, 0.85s. First half of the trick-draft → board boot scan.',
        play: () => sfx._noise({ dur: 0.85, gain: 0.08, highpass: 200, lowpass: 1800 }),
      },
      {
        id: 'boot-whoosh-high', category: 'Transitions', kind: 'procedural',
        name: 'Boot whoosh (high)',
        desc: 'Higher-band noise 1200-5500 Hz at 0.20s offset. Pairs with the low whoosh for a filter-sweep feel.',
        play: () => sfx._noise({ dur: 0.95, gain: 0.10, highpass: 1200, lowpass: 5500 }),
      },
      {
        id: 'boot-hum', category: 'Transitions', kind: 'procedural',
        name: 'Boot hum (pad)',
        desc: 'Low sawtooth pad 80→100 Hz + sine harmonic. The "computer powered on" baseline drone.',
        play: () => {
          sfx._tone({ type: 'sawtooth', freq: 80,  freqEnd: 100, dur: 1.8, gain: 0.06, attack: 0.30, release: 1.8 });
          sfx._tone({ type: 'sine',     freq: 160, freqEnd: 200, dur: 1.8, gain: 0.04, attack: 0.30, release: 1.8 });
        },
      },
      {
        id: 'boot-bleep', category: 'Transitions', kind: 'procedural',
        name: 'Boot bleep (lock-on)',
        desc: 'Rising sine pip 440→880 Hz + harmonic 880→1760 Hz. The "lock-on" cue at scan peak.',
        play: () => {
          sfx._tone({ type: 'sine', freq: 440, freqEnd: 880,  dur: 0.18, gain: 0.18, attack: 0.005 });
          sfx._tone({ type: 'sine', freq: 880, freqEnd: 1760, dur: 0.14, gain: 0.10, attack: 0.005, delay: 0.07 });
        },
      },
      {
        id: 'boot-tick', category: 'Transitions', kind: 'procedural',
        name: 'Boot card tick',
        desc: 'Per-card landing blip — square + triangle blend. Fires once per card during the hand stagger.',
        play: () => {
          sfx._tone({ type: 'square',   freq: 1800, freqEnd: 1200, dur: 0.05, gain: 0.10 });
          sfx._tone({ type: 'triangle', freq: 600,  freqEnd: 400,  dur: 0.06, gain: 0.06, delay: 0.005 });
        },
      },
      {
        id: 'boot-full', category: 'Transitions', kind: 'procedural',
        name: 'Boot sequence (full)',
        desc: 'Full ~2.2s boot-up — all whoosh + hum + bleep + 4 ticks layered with their real timings. Plays on trick-draft → first combat phase.',
        play: () => sfx.playBootSequence(4),
      },
      proc('phaseEngage', 'Transitions', 'Engage cue (map → fight)',
        'Combat-ready snap — rising sawtooth pulse + sharp noise crack + sub thump. Distinct from boot; this is fast and aggressive ("weapons hot"). Fires on roguelite-map → first-fight-phase.'),
      proc('phaseCommit', 'Transitions', 'Commit cue (fight → rewards)',
        'Descending three-tone major triad on soft sines (G5→E5→C5) with a low noise wash. The "saving data" beat. Fires on in-fight → roguelite-rewards.'),
      proc('phaseReturn', 'Transitions', 'Return cue (rewards → map)',
        'Contemplative sustained sine pad with a faint shimmer. The quiet "back to the map" beat — no drum, no edge. Fires on roguelite-rewards → roguelite-map.'),
      // ---- Music & file-backed UI ----
      {
        id: 'nav', category: 'Music & Files', kind: 'file',
        name: 'Menu navigation',
        desc: 'Sampled WAV played on every menu navigation click.',
        src: sfx.NAV_SRC || 'audio/ui_planetzoom.wav',
        play: () => sfx.playNav(),
      },
      {
        id: 'music', category: 'Music & Files', kind: 'file',
        name: 'Menu music (loop)',
        desc: 'Looping menu/draft background music ("Organ Variation"). Full track on seamless loop.',
        src: (sfx.MUSIC_SRC || 'audio/menu_music.mp3').split('?')[0],
        play: () => { try { sfx.startMusic(); } catch (e) {} },
      },
      {
        id: 'match-intro', category: 'Music & Files', kind: 'file',
        name: 'Match load-in (20s)',
        desc: 'The former menu track, played for ~20s as combat begins (first round of a match), then faded out. Non-looping.',
        src: (sfx.MATCH_INTRO_SRC || 'audio/match_intro.mp3').split('?')[0],
        play: () => { try { sfx.playMatchIntro(); } catch (e) {} },
      },
      {
        id: 'heal-hp', category: 'Music & Files', kind: 'file',
        name: 'Heal HP cue',
        desc: 'File-backed HP heal sample.',
        src: 'audio/heal-hp.mp3',
        play: () => sfx._playSample('audio/heal-hp.mp3', { fadeIn: 0, fadeOut: 200, maxDur: 1.5 }),
      },
      // THE IMPORTED CUES BELONG IN THE GALLERY TOO. These were added one at a
      // time and none of them registered here, so the screen that exists to
      // list every sound in the game was missing five of the handful that can
      // actually be heard. Each plays through the same path the game uses, so
      // the ▶ button is a real audition rather than an approximation.
      {
        id: 'card-click', category: 'Interface', kind: 'file',
        name: 'Card click',
        desc: 'Fires on any click of a card or trick, on every surface.',
        src: 'audio/card-click.mp3',
        play: () => sfx.playCardClick(),
      },
      {
        id: 'hp-hit', category: 'Combat', kind: 'file',
        name: 'Health bar hit',
        desc: 'Face damage on either bar. Registered in SAMPLE_CUES; 60ms cooldown so a six-lane burst does not stack.',
        src: 'audio/hp-hit.mp3',
        play: () => sfx.play('hpHit'),
      },
      {
        id: 'round-start', category: 'Match', kind: 'file',
        name: 'New round',
        desc: 'Fires with the round banner, once per round.',
        src: 'audio/new-round.mp3',
        play: () => sfx.play('roundStart'),
      },
      {
        id: 'victory', category: 'Match', kind: 'file',
        name: 'Victory',
        desc: 'Plays on the game-over screen when you win. No defeat counterpart.',
        src: 'audio/win.mp3',
        play: () => sfx.playVictoryMusic(),
      },
      {
        id: 'mind-control', category: 'Status', kind: 'file',
        name: 'Mind Control',
        desc: 'Global effect cue — fires for every card that applies Mind Control.',
        src: 'audio/effects/mind-control.mp3',
        play: () => sfx.playEffect('mindControl'),
      },
      {
        id: 'default-play', category: 'Cards', kind: 'file',
        name: 'Card lands in a lane',
        desc: 'DEFAULT_CARD_SFX.play — the fallback for any card without a play cue of its own.',
        src: 'audio/cards/default-play.mp3',
        play: () => sfx._playSample('audio/cards/default-play.mp3', { fadeIn: 0, fadeOut: 200, maxDur: 5 }),
      },
    ];
  },
  // Public play helper invoked by the inline ▶ buttons in the
  // system-sounds table. Wraps the entry's play fn in a try/catch
  // so a busted entry doesn't take down the whole audit.
  _audioAuditPlaySystem(id) {
    const list = this._systemSfxDirectory();
    const entry = list.find(e => e.id === id);
    if (!entry) return;
    try { entry.play(); } catch (e) { console.warn('[audio-audit] play failed', id, e); }
  },

  // Render the "Game Sounds" tab. Single column of rows grouped by
  // category (UI / Combat / Status / Tricks / Roguelite / Match /
  // Transitions / Music & Files). Each row: ▶ play button, name,
  // ID/source pill, description. Filterable by name + description
  // via the same search box the cards/tricks tabs use.
  _renderAudioAuditSystem(ov, f) {
    // SILENT ROWS ARE NOT LISTED. Procedural cues are gated off
    // (sfx.PROCEDURAL_CUES), so every 'synth' entry in this directory now
    // produces nothing — leaving ~40 of them with a ▶ button that does nothing
    // is the opposite of an audit. While the gate is off the gallery shows only
    // what can actually be heard; flip PROCEDURAL_CUES back to true and they
    // return on their own, no change needed here.
    const proceduralOn = !!(this.sfx && this.sfx.PROCEDURAL_CUES);
    const all = this._systemSfxDirectory().filter(e => proceduralOn || e.kind === 'file');
    const q = (f.query || '').trim().toLowerCase();
    const list = all.filter(e =>
      !q || e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q) || (e.desc || '').toLowerCase().includes(q)
    );
    // Group by category, preserving directory order within each.
    const byCat = new Map();
    list.forEach(e => {
      if (!byCat.has(e.category)) byCat.set(e.category, []);
      byCat.get(e.category).push(e);
    });
    const escAttr = (s) => String(s).replace(/"/g, '&quot;');
    const escText = (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rowHtml = (e) => {
      const kindBadge = e.kind === 'file'
        ? `<span class="aa-sys-kind aa-sys-kind-file" title="File-backed">file</span>`
        : `<span class="aa-sys-kind aa-sys-kind-proc" title="Procedural — generated by Web Audio">synth</span>`;
      const srcLine = e.kind === 'file' && e.src
        ? `<div class="aa-sys-src" title="${escAttr(e.src)}">${escText(e.src)}</div>`
        : `<div class="aa-sys-src aa-sys-src-id">id: <code>${escText(e.id)}</code></div>`;
      return `
        <tr class="aa-sys-row">
          <td class="aa-sys-play-cell">
            <button type="button" class="aa-cell-play" title="Play"
              onclick="UI._audioAuditPlaySystem('${escAttr(e.id)}')">▶</button>
          </td>
          <td class="aa-sys-name-cell">
            <div class="aa-sys-name">${escText(e.name)} ${kindBadge}</div>
            ${srcLine}
            <div class="aa-sys-desc">${escText(e.desc || '')}</div>
          </td>
        </tr>`;
    };
    const sections = Array.from(byCat.entries()).map(([cat, entries]) => `
      <tbody class="aa-sys-group">
        <tr><td colspan="2" class="aa-sys-cat">${escText(cat)} <span class="aa-sys-cat-count">${entries.length}</span></td></tr>
        ${entries.map(rowHtml).join('')}
      </tbody>`).join('');
    const sysCount = all.length;
    const cardsCount = (typeof CARD_DEFS !== 'undefined' ? CARD_DEFS.length : 0);
    const tricksCount = (typeof TRICK_DEFS !== 'undefined' ? TRICK_DEFS.length : 0);
    ov.innerHTML = `
      <div class="encyc-panel audio-audit-panel">
        <button type="button" class="encyc-close" onclick="UI.closeAudioAudit()">← Menu</button>
        <h1 class="encyc-title">Sound Gallery</h1>
        <div class="aa-summary">
          <span><b>${list.length}</b>/${sysCount} game sounds</span>
          ${proceduralOn ? '' : '<span class="aa-note">synth cues are off &mdash; only imported audio is listed</span>'}
        </div>
        <div class="aa-tabs">
          <button type="button" class="aa-tab" onclick="UI._audioAuditSetSection('cards')">Cards (${cardsCount})</button>
          <button type="button" class="aa-tab" onclick="UI._audioAuditSetSection('tricks')">Tricks (${tricksCount})</button>
          <button type="button" class="aa-tab aa-tab-active" onclick="UI._audioAuditSetSection('system')">Game Sounds (${sysCount})</button>
        </div>
        <div class="aa-controls">
          <input class="aa-search" type="search" placeholder="Filter by name, id, or description…"
            value="${escAttr(f.query || '')}"
            oninput="UI._audioAuditSetQuery(this.value)">
        </div>
        <div class="aa-table-wrap">
          <table class="aa-table aa-table-system">
            ${sections || `<tbody><tr><td colspan="2" class="aa-empty">No matches.</td></tr></tbody>`}
          </table>
        </div>
      </div>`;
  },

  renderAudioAudit() {
    const ov = document.getElementById('audio-audit-overlay');
    if (!ov) return;
    const f = this._audioAudit;
    const section = f.section || 'cards';
    if (section === 'system') return this._renderAudioAuditSystem(ov, f);
    const isTrick = section === 'tricks';
    const defs = isTrick
      ? (typeof TRICK_DEFS !== 'undefined' ? TRICK_DEFS : [])
      : (typeof CARD_DEFS !== 'undefined' ? CARD_DEFS : []);
    const events = isTrick ? ['hover', 'play'] : ['hover', 'play', 'death', 'ability', 'kill'];
    // Filter: name search, case-insensitive substring
    const q = (f.query || '').trim().toLowerCase();
    const list = defs.filter(d => !q || d.name.toLowerCase().includes(q));
    // Coverage tally — % of cards × events that have a NON-none cell.
    let cells = 0, covered = 0, fileBacked = 0;
    list.forEach(d => events.forEach(ev => {
      cells++;
      const s = this._audioStatus(d.name, ev, isTrick);
      if (s.kind !== 'none') covered++;
      if (s.kind === 'file') fileBacked++;
    }));
    const pctCovered = cells ? Math.round((covered / cells) * 100) : 0;
    const pctFile    = cells ? Math.round((fileBacked / cells) * 100) : 0;
    const cellHtml = (name, ev) => {
      const s = this._audioStatus(name, ev, isTrick);
      // JS-escape the name for use inside the inline onclick string
      // literal. The HTML attribute is double-quoted; the JS string is
      // single-quoted; so we backslash-escape any backslash or apostrophe
      // in the name (e.g. "Joker's Playing Card" → "Joker\'s Playing Card").
      const jsName = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      if (s.kind === 'file') {
        const display = s.src.split('/').pop().replace(/\?.*$/, '');
        const maxDur = s.maxDur ? `<span class="aa-cell-maxdur">${s.maxDur}s cap</span>` : '';
        return `<div class="aa-cell aa-cell-file">
          <button type="button" class="aa-cell-play" title="Play"
            onclick="UI._audioAuditPlay('${s.src}')">▶</button>
          <span class="aa-cell-file-name" title="${s.src}">${display}</span>
          ${maxDur}
          <button type="button" class="aa-cell-splice" title="Splice / re-trim"
            onclick="UI._audioAuditSplice('${s.src}', '${jsName}', '${ev}')">✂</button>
        </div>`;
      }
      if (s.kind === 'generic') {
        return `<div class="aa-cell aa-cell-generic" title="${s.via === 'procedural' ? 'Procedural synth fallback (CARD_PROCEDURAL)' : 'Global default file'}">generic</div>`;
      }
      return `<div class="aa-cell aa-cell-none">—</div>`;
    };
    const headerCols = events.map(ev => `<th>${ev}</th>`).join('');
    const rows = list.map(d => `
      <tr>
        <td class="aa-row-name">${d.name}</td>
        ${events.map(ev => `<td>${cellHtml(d.name, ev)}</td>`).join('')}
      </tr>`).join('');
    const sysCount = this._systemSfxDirectory().length;
    const sectionTabs = `
      <div class="aa-tabs">
        <button type="button" class="aa-tab ${!isTrick ? 'aa-tab-active' : ''}" onclick="UI._audioAuditSetSection('cards')">Cards (${(typeof CARD_DEFS !== 'undefined' ? CARD_DEFS.length : 0)})</button>
        <button type="button" class="aa-tab ${ isTrick ? 'aa-tab-active' : ''}" onclick="UI._audioAuditSetSection('tricks')">Tricks (${(typeof TRICK_DEFS !== 'undefined' ? TRICK_DEFS.length : 0)})</button>
        <button type="button" class="aa-tab" onclick="UI._audioAuditSetSection('system')">Game Sounds (${sysCount})</button>
      </div>`;
    ov.innerHTML = `
      <div class="encyc-panel audio-audit-panel">
        <button type="button" class="encyc-close" onclick="UI.closeAudioAudit()">← Menu</button>
        <h1 class="encyc-title">Sound Gallery</h1>
        <div class="aa-summary">
          <span><b>${list.length}</b> ${isTrick ? 'tricks' : 'cards'}</span>
          <span><b>${covered}</b>/${cells} cells covered (${pctCovered}%)</span>
          <span><b>${fileBacked}</b>/${cells} backed by a file (${pctFile}%)</span>
        </div>
        ${sectionTabs}
        <div class="aa-controls">
          <input class="aa-search" type="search" placeholder="Filter by name…"
            value="${(f.query || '').replace(/"/g, '&quot;')}"
            oninput="UI._audioAuditSetQuery(this.value)">
        </div>
        <div class="aa-table-wrap">
          <table class="aa-table">
            <thead><tr><th class="aa-row-name">Name</th>${headerCols}</tr></thead>
            <tbody>${rows || `<tr><td colspan="${events.length+1}" class="aa-empty">No matches.</td></tr>`}</tbody>
          </table>
        </div>
        <div id="aa-splicer-mount"></div>
      </div>`;
  },
  _audioAuditPlay(src) {
    if (this._audioAuditPreview) {
      try { this._audioAuditPreview.pause(); } catch (e) {}
    }
    if (!this.sfx || !this.sfx._playSample) return;
    this._audioAuditPreview = this.sfx._playSample(src, { fadeIn: 1000, fadeOut: 2000 });
  },

  // ----- Splicer ------------------------------------------------------
  // In-browser audio editor: load the registered file, decode, render
  // waveform with draggable IN / OUT markers, configurable fade-in /
  // fade-out, preview with the fades applied, and export as a WAV.
  // Output is intentionally WAV (no MP3 encoder lib) so the user can
  // run the existing ffmpeg pipeline on it for final encoding:
  //   ffmpeg -y -i x.wav -ar 48000 -ac 2 -b:a 192k \
  //     -af "loudnorm=I=-20:TP=-1.5:LRA=11" x.mp3
  _audioAuditSplice(src, name, event) {
    const mount = document.getElementById('aa-splicer-mount');
    if (!mount) return;
    mount.innerHTML = `
      <div class="aa-splicer">
        <div class="aa-splicer-header">
          <div class="aa-splicer-title">Splicer · <b>${name}</b> <span class="aa-splicer-event">${event}</span></div>
          <button type="button" class="aa-splicer-close" onclick="document.getElementById('aa-splicer-mount').innerHTML = ''">×</button>
        </div>
        <div class="aa-splicer-src">${src}</div>
        <canvas class="aa-splicer-wave" width="1080" height="120"></canvas>
        <div class="aa-splicer-ranges">
          <label class="aa-rng-lbl">Start <input type="range" class="aa-splicer-in-rng"  min="0" max="100" step="0.01" value="0"></label>
          <label class="aa-rng-lbl">Finish <input type="range" class="aa-splicer-out-rng" min="0" max="100" step="0.01" value="100"></label>
        </div>
        <div class="aa-splicer-controls">
          <label>IN <input type="number" class="aa-splicer-in"  step="0.01" min="0" value="0"></label>
          <label>OUT <input type="number" class="aa-splicer-out" step="0.01" min="0" value="0"></label>
          <label>fade-in (s) <input type="number" class="aa-splicer-fadein"  step="0.1" min="0" value="1"></label>
          <label>fade-out (s) <input type="number" class="aa-splicer-fadeout" step="0.1" min="0" value="2"></label>
          <button type="button" class="aa-splicer-preview">▶ Preview slice</button>
          <button type="button" class="aa-splicer-pause" title="Stop the current preview">⏸ Pause</button>
          <button type="button" class="aa-splicer-save" title="Save these IN / OUT / fade values to localStorage and copy the ffmpeg command — survives page reloads, lets Claude apply on next message">💾 Save trim</button>
          <button type="button" class="aa-splicer-export">⬇ Export WAV</button>
          <button type="button" class="aa-splicer-copyffmpeg" title="Copy ffmpeg command for the current trim">⌘ Copy ffmpeg</button>
        </div>
        <div class="aa-splicer-status"></div>
      </div>`;
    const splicerEl = mount.querySelector('.aa-splicer');
    const canvas = splicerEl.querySelector('.aa-splicer-wave');
    const inEl  = splicerEl.querySelector('.aa-splicer-in');
    const outEl = splicerEl.querySelector('.aa-splicer-out');
    const fiEl  = splicerEl.querySelector('.aa-splicer-fadein');
    const foEl  = splicerEl.querySelector('.aa-splicer-fadeout');
    const previewBtn = splicerEl.querySelector('.aa-splicer-preview');
    const pauseBtn   = splicerEl.querySelector('.aa-splicer-pause');
    const saveBtn    = splicerEl.querySelector('.aa-splicer-save');
    const exportBtn  = splicerEl.querySelector('.aa-splicer-export');
    const copyBtn    = splicerEl.querySelector('.aa-splicer-copyffmpeg');
    const status     = splicerEl.querySelector('.aa-splicer-status');
    const inRng  = splicerEl.querySelector('.aa-splicer-in-rng');
    const outRng = splicerEl.querySelector('.aa-splicer-out-rng');
    // Keep the Start/Finish range sliders in sync with the number inputs.
    const syncRanges = () => { if (inRng) inRng.value = inEl.value; if (outRng) outRng.value = outEl.value; };
    // Per-card+event localStorage key for trim params. Lets the user
    // save IN/OUT/fade values across page reloads instead of having
    // to re-find their sweet-spot every time. Same key is checked on
    // splicer open to auto-restore.
    const trimKey = 'aa-trim::' + String(name) + '::' + String(event);
    const setStatus = (msg) => { status.textContent = msg || ''; };
    setStatus('Loading…');
    // Decode the source into an AudioBuffer.
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let buf = null, peakAmp = 1;
    fetch(src).then(r => r.arrayBuffer()).then(ab => ctx.decodeAudioData(ab)).then(b => {
      buf = b;
      outEl.value = b.duration.toFixed(2);
      outEl.max = b.duration;
      inEl.max  = b.duration;
      if (inRng)  inRng.max  = b.duration;
      if (outRng) outRng.max = b.duration;
      // Restore previously saved trim params if the user has hit Save
      // for this card+event before. Skips if any field would be out
      // of range (e.g. file got re-encoded shorter since the save).
      try {
        const saved = localStorage.getItem(trimKey);
        if (saved) {
          const p = JSON.parse(saved);
          if (typeof p.in === 'number' && p.in >= 0 && p.in < b.duration) inEl.value = p.in.toFixed(2);
          if (typeof p.out === 'number' && p.out > 0 && p.out <= b.duration) outEl.value = p.out.toFixed(2);
          if (typeof p.fadeIn === 'number' && p.fadeIn >= 0) fiEl.value = p.fadeIn;
          if (typeof p.fadeOut === 'number' && p.fadeOut >= 0) foEl.value = p.fadeOut;
        }
      } catch (e) { /* swallow — bad JSON shouldn't break the splicer */ }
      // Find peak for waveform scaling.
      const ch0 = buf.getChannelData(0);
      const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
      const step = Math.max(1, Math.floor(ch0.length / 50000));
      let p = 0;
      for (let i = 0; i < ch0.length; i += step) {
        let v = Math.abs(ch0[i]);
        if (ch1) v = Math.max(v, Math.abs(ch1[i]));
        if (v > p) p = v;
      }
      peakAmp = Math.max(0.05, p);
      drawWave();
      setStatus(`Loaded · ${b.duration.toFixed(2)}s · ${b.numberOfChannels}ch · ${b.sampleRate}Hz`);
    }).catch(e => setStatus('Decode failed: ' + e.message));
    // Waveform render with IN/OUT shading + fade-in/out zones.
    const drawWave = (playheadSec = -1) => {
      if (!buf) return;
      const w = canvas.width, h = canvas.height;
      const c = canvas.getContext('2d');
      c.clearRect(0, 0, w, h);
      const dur = buf.duration;
      const inT  = Math.max(0, Math.min(dur, parseFloat(inEl.value)  || 0));
      const outT = Math.max(0, Math.min(dur, parseFloat(outEl.value) || dur));
      const fi   = Math.max(0, parseFloat(fiEl.value) || 0);
      const fo   = Math.max(0, parseFloat(foEl.value) || 0);
      // Gray out everything outside [in, out]
      c.fillStyle = 'rgba(0,0,0,0.55)';
      c.fillRect(0, 0, (inT / dur) * w, h);
      c.fillRect((outT / dur) * w, 0, w - (outT / dur) * w, h);
      // Fade zones inside the selection
      const inX  = (inT / dur) * w;
      const outX = (outT / dur) * w;
      const fiW  = ((fi  / dur) * w);
      const foW  = ((fo  / dur) * w);
      c.fillStyle = 'rgba(74,255,140,0.18)';
      c.fillRect(inX, 0, fiW, h);
      c.fillStyle = 'rgba(255,120,90,0.18)';
      c.fillRect(outX - foW, 0, foW, h);
      // Waveform
      const ch0 = buf.getChannelData(0);
      const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
      const samplesPerPx = Math.max(1, Math.floor(ch0.length / w));
      const scale = 1 / peakAmp;
      c.strokeStyle = '#4af';
      c.lineWidth = 1;
      c.beginPath();
      for (let x = 0; x < w; x++) {
        let mn = 1, mx = -1;
        const start = x * samplesPerPx;
        const end = Math.min(ch0.length, start + samplesPerPx);
        for (let i = start; i < end; i++) {
          let v = ch0[i];
          if (ch1) v = (v + ch1[i]) * 0.5;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const mxN = Math.max(-1, Math.min(1, mx * scale));
        const mnN = Math.max(-1, Math.min(1, mn * scale));
        c.moveTo(x + 0.5, ((1 - mxN) / 2) * h);
        c.lineTo(x + 0.5, ((1 - mnN) / 2) * h);
      }
      c.stroke();
      // Markers
      const drawMarker = (xPx, color, label) => {
        c.strokeStyle = color;
        c.lineWidth = 2;
        c.beginPath(); c.moveTo(xPx, 0); c.lineTo(xPx, h); c.stroke();
        c.fillStyle = color;
        c.font = '10px ui-monospace, monospace';
        c.fillText(label, xPx + 4, 12);
      };
      drawMarker(inX, '#4af', 'IN');
      drawMarker(outX, '#fc6', 'OUT');
      // Tick marks every 10s
      c.fillStyle = 'rgba(154,184,204,0.6)';
      c.font = '9px ui-monospace, monospace';
      for (let t = 0; t <= dur; t += 10) {
        const x = (t / dur) * w;
        c.fillRect(x, h - 6, 1, 4);
        if (t > 0 && t < dur - 5) c.fillText(`${t}s`, x + 2, h - 8);
      }
      // Playhead
      if (playheadSec >= 0 && playheadSec <= dur) {
        const x = (playheadSec / dur) * w;
        c.strokeStyle = '#fff';
        c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
      }
    };
    // Drag IN/OUT markers on the canvas (mouse OR touch — Pointer Events).
    let dragging = null;  // 'in' | 'out' | null
    canvas.style.touchAction = 'none';   // let us drag without the page scrolling
    canvas.addEventListener('pointerdown', (e) => {
      if (!buf) return;
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) * (canvas.width / r.width);
      const dur = buf.duration;
      const inX  = (parseFloat(inEl.value)  / dur) * canvas.width;
      const outX = (parseFloat(outEl.value) / dur) * canvas.width;
      const dIn  = Math.abs(x - inX), dOut = Math.abs(x - outX);
      if (dIn < 24 && dIn <= dOut) dragging = 'in';
      else if (dOut < 24) dragging = 'out';
      else dragging = null;
      if (dragging) { try { canvas.setPointerCapture(e.pointerId); } catch (_) {} }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging || !buf) return;
      const r = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(canvas.width, (e.clientX - r.left) * (canvas.width / r.width)));
      const t = (x / canvas.width) * buf.duration;
      if (dragging === 'in')  inEl.value  = Math.min(t, parseFloat(outEl.value) - 0.1).toFixed(2);
      if (dragging === 'out') outEl.value = Math.max(t, parseFloat(inEl.value)  + 0.1).toFixed(2);
      previewPausedAt = null; syncRanges(); drawWave();
    });
    const endDrag = () => { dragging = null; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    // Number inputs keep the ranges + waveform in sync.
    [inEl, outEl, fiEl, foEl].forEach(el => el.addEventListener('input', () => { syncRanges(); drawWave(); }));
    // Start / Finish range SLIDERS — touch-friendly manual trim.
    const wireRange = (rng, numEl, isIn) => rng && rng.addEventListener('input', () => {
      let t = parseFloat(rng.value);
      if (isIn) t = Math.min(t, parseFloat(outEl.value) - 0.1);
      else      t = Math.max(t, parseFloat(inEl.value)  + 0.1);
      numEl.value = t.toFixed(2);
      previewPausedAt = null; drawWave();
    });
    wireRange(inRng, inEl, true);
    wireRange(outRng, outEl, false);
    // Preview the slice with WebAudio gain envelope (fade-in / fade-out)
    // + actual pause/resume semantics. Web Audio BufferSource is
    // one-shot (stop() can't be undone), so "pause" captures the
    // current offset and the next Preview click rebuilds a fresh
    // BufferSource that starts mid-slice from that saved offset.
    //
    // State variables:
    //   previewSrc       — live BufferSource (null when paused/stopped)
    //   previewPausedAt  — offset in SECONDS FROM THE IN MARKER where
    //                       the user paused. null when no resume is
    //                       pending (next Preview starts fresh from IN).
    //   previewRaf       — outer-closure handle so Pause can cancel
    //                       the playhead animation cleanly.
    let previewSrc = null;
    let previewPausedAt = null;
    let previewRaf = null;
    // Editing any of the IN / OUT / fade params invalidates the saved
    // pause offset — the slice geometry changes and the offset would
    // mean something different. Clear it so the next Preview rebuilds
    // fresh from IN.
    [inEl, outEl, fiEl, foEl].forEach(el => {
      el.addEventListener('input', () => { previewPausedAt = null; });
    });
    previewBtn.addEventListener('click', () => {
      if (!buf) return;
      if (previewSrc) { try { previewSrc.stop(); } catch(e){} previewSrc = null; }
      if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = null; }
      const inT  = parseFloat(inEl.value);
      const outT = parseFloat(outEl.value);
      const fi   = parseFloat(fiEl.value);
      const fo   = parseFloat(foEl.value);
      const sliceLen = Math.max(0.01, outT - inT);
      // Resume mid-slice if Pause set an offset; otherwise start fresh.
      const resumeOffset = (previewPausedAt != null && previewPausedAt < sliceLen) ? previewPausedAt : 0;
      const remainingLen = Math.max(0.01, sliceLen - resumeOffset);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      const vol = (UI.settings && UI.settings.sfxVolume != null) ? UI.settings.sfxVolume : 0.6;
      const t0 = ctx.currentTime;
      // Fade envelope must be REWRITTEN for the resume case so the
      // fade-out lands at the same real-time moment in the clip,
      // not `fo` seconds after the resume point. Three regions:
      //   • Fade-in region [0, fi):     ramp 0 → vol over fi seconds (from IN)
      //   • Body region    [fi, len-fo): constant vol
      //   • Fade-out region [len-fo, len]: ramp vol → 0 over fo seconds
      // When resuming at offset T, we shift each region by -T and clip
      // the leading edge of any region whose start is now negative.
      const fadeInEndOrig  = Math.min(fi, sliceLen / 2);
      const fadeOutStartOrig = Math.max(0, sliceLen - fo);
      // Project these into the resumed timeline (ctx-clock-relative).
      // If we resume PAST a region's start, its volume contribution at
      // resume time is whatever the envelope was at that offset.
      let startVol;
      if (resumeOffset < fadeInEndOrig) {
        // Inside fade-in — partial-volume start, finish ramp to vol.
        startVol = (resumeOffset / Math.max(0.0001, fadeInEndOrig)) * vol;
        const fadeInRemaining = fadeInEndOrig - resumeOffset;
        gain.gain.setValueAtTime(startVol, t0);
        gain.gain.linearRampToValueAtTime(vol, t0 + fadeInRemaining);
      } else {
        // Past fade-in — full volume start.
        startVol = vol;
        gain.gain.setValueAtTime(vol, t0);
      }
      // Fade-out: hold vol until we hit (len-fo)-T, then ramp to 0
      // over fo seconds (or whatever remains of fo if we're already
      // past its start).
      const fadeOutStartShifted = Math.max(0, fadeOutStartOrig - resumeOffset);
      if (fadeOutStartShifted > 0) {
        gain.gain.setValueAtTime(vol, t0 + fadeOutStartShifted);
        gain.gain.linearRampToValueAtTime(0, t0 + remainingLen);
      } else {
        // Resumed mid-fade-out — partial ramp from current envelope
        // value down to 0 over what's left of the slice.
        const fadeOutProgress = (resumeOffset - fadeOutStartOrig) / Math.max(0.0001, fo);
        const cur = vol * (1 - fadeOutProgress);
        gain.gain.setValueAtTime(cur, t0);
        gain.gain.linearRampToValueAtTime(0, t0 + remainingLen);
      }
      src.connect(gain).connect(ctx.destination);
      // BufferSource start: (when, offset_in_buffer, duration)
      src.start(t0, inT + resumeOffset, remainingLen);
      // Stash the ctx-clock start time and the resume offset on the
      // source object so the Pause handler can derive "elapsed since
      // playback started" + "where in the slice we are." Web Audio
      // doesn't expose a current-position read on BufferSource, so we
      // track it manually via these two anchors.
      src._startCtxT = t0;
      src._resumeOffset = resumeOffset;
      previewSrc = src;
      previewPausedAt = null;     // resume consumed; next pause sets a fresh offset
      // Animate playhead from the resume offset onward.
      const startedAt = performance.now();
      const startOffsetMs = resumeOffset * 1000;
      const tick = () => {
        const elapsedMs = (performance.now() - startedAt) + startOffsetMs;
        const elapsedSec = elapsedMs / 1000;
        if (elapsedSec >= sliceLen) { drawWave(-1); previewRaf = null; return; }
        drawWave(inT + elapsedSec);
        previewRaf = requestAnimationFrame(tick);
      };
      tick();
      src.addEventListener('ended', () => {
        if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = null; }
        // Only clear when the playback finishes naturally — Pause
        // sets the offset before stop() and we don't want this
        // listener to wipe it before the next Preview reads it.
        if (previewSrc === src) {
          drawWave(-1);
          previewSrc = null;
          previewPausedAt = null;  // natural end resets to "fresh next time"
        }
      });
    });
    // Pause — capture the current playback position (relative to the
    // IN marker), stop the BufferSource, and stash the offset so the
    // next Preview click resumes from here. User direction 2026-05-26:
    // "the pause restarts the audio file not just pause it." Now it
    // actually pauses.
    pauseBtn.addEventListener('click', () => {
      if (!previewSrc) return;
      const inT  = parseFloat(inEl.value);
      const outT = parseFloat(outEl.value);
      const sliceLen = Math.max(0.01, outT - inT);
      // Figure out how far we've played so far. We need the offset
      // relative to the IN marker (not to ctx.currentTime), so we
      // derive it from the playhead animation's elapsed time. The
      // playhead tick draws at `inT + elapsedSec` — read the canvas
      // attribute? No: stash the latest elapsed in a variable.
      // Simpler: compute via ctx.currentTime - source's logical start.
      // We track that on previewSrc by setting a custom property.
      // Approach: capture `ctx.currentTime` against a stamp set when
      // the source started. The Preview handler sets src._startCtxT.
      const startCtxT = previewSrc._startCtxT;
      const resumeFrom = previewSrc._resumeOffset || 0;
      const elapsed = (typeof startCtxT === 'number')
        ? (ctx.currentTime - startCtxT) + resumeFrom
        : resumeFrom;
      previewPausedAt = Math.max(0, Math.min(sliceLen - 0.01, elapsed));
      try { previewSrc.stop(); } catch (e) {}
      previewSrc = null;
      if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = null; }
      drawWave(-1);
      setStatus(`Paused at ${(inT + previewPausedAt).toFixed(2)}s · click ▶ Preview slice to resume.`);
    });
    // Save button — persists the current IN / OUT / fade values to
    // localStorage so they survive page reloads, AND auto-copies the
    // equivalent ffmpeg command to the clipboard. Two-in-one because
    // saving without an apply-path leaves the changes stranded; the
    // ffmpeg command is what actually re-encodes the file when run.
    // User direction 2026-05-26: "and a save button." The persist
    // path means the user can dial in trim points across multiple
    // sessions; the auto-copy gives them (or me, on the next chat
    // message) a one-paste command to apply.
    saveBtn.addEventListener('click', () => {
      if (!buf) return;
      const inT  = parseFloat(inEl.value)  || 0;
      const outT = parseFloat(outEl.value) || buf.duration;
      const fi   = parseFloat(fiEl.value)  || 0;
      const fo   = parseFloat(foEl.value)  || 0;
      try {
        localStorage.setItem(trimKey, JSON.stringify({
          in: inT, out: outT, fadeIn: fi, fadeOut: fo,
          savedAt: Date.now(),
          name, event,
        }));
      } catch (e) { /* localStorage quota / disabled — keep going */ }
      // Build the same ffmpeg command the Copy button produces.
      const sliceLen = Math.max(0.01, outT - inT);
      const fadeOutStart = Math.max(0, sliceLen - fo);
      const safeName = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const cmd = `ffmpeg -y -i "${src}" -ss ${inT.toFixed(2)} -t ${sliceLen.toFixed(2)} -ar 48000 -ac 2 -b:a 192k -af "afade=t=in:st=0:d=${fi},afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fo},loudnorm=I=-20:TP=-1.5:LRA=11" "audio/cards/${safeName}-${event}.mp3"`;
      navigator.clipboard.writeText(cmd).then(
        () => setStatus(`✓ Saved trim (IN ${inT.toFixed(2)}s · OUT ${outT.toFixed(2)}s · ${sliceLen.toFixed(2)}s slice) + ffmpeg copied. Tell Claude to apply, or paste the command into Terminal yourself.`),
        () => setStatus(`✓ Saved trim locally. ffmpeg copy failed — command logged to console.`)
      );
      console.log('[audio-audit save]', { name, event, in: inT, out: outT, fadeIn: fi, fadeOut: fo, cmd });
    });
    // Export the slice + fades as a WAV download.
    exportBtn.addEventListener('click', async () => {
      if (!buf) return;
      const inT  = parseFloat(inEl.value);
      const outT = parseFloat(outEl.value);
      const fi   = parseFloat(fiEl.value);
      const fo   = parseFloat(foEl.value);
      const sliceLen = Math.max(0.01, outT - inT);
      const sr = buf.sampleRate;
      const offline = new OfflineAudioContext(buf.numberOfChannels, Math.ceil(sliceLen * sr), sr);
      const src = offline.createBufferSource();
      src.buffer = buf;
      const gain = offline.createGain();
      const t0 = 0;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(1, t0 + Math.min(fi, sliceLen / 2));
      gain.gain.setValueAtTime(1, t0 + Math.max(0, sliceLen - fo));
      gain.gain.linearRampToValueAtTime(0, t0 + sliceLen);
      src.connect(gain).connect(offline.destination);
      src.start(0, inT, sliceLen);
      setStatus('Rendering…');
      const rendered = await offline.startRendering();
      const wavBlob = UI._audioBufferToWav(rendered);
      const safeName = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const fname = `${safeName}-${event}-splice.wav`;
      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement('a');
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setStatus(`Exported ${fname} · ${sliceLen.toFixed(2)}s · drop into audio/cards/ then run the ffmpeg pipeline.`);
    });
    // Copy the equivalent ffmpeg command (so the user can re-derive
    // the same trim deterministically from the SOURCE file).
    copyBtn.addEventListener('click', () => {
      const inT  = parseFloat(inEl.value);
      const outT = parseFloat(outEl.value);
      const fi   = parseFloat(fiEl.value);
      const fo   = parseFloat(foEl.value);
      const sliceLen = Math.max(0.01, outT - inT);
      const fadeOutStart = Math.max(0, sliceLen - fo);
      const safeName = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const cmd = `ffmpeg -y -i "${src}" -ss ${inT.toFixed(2)} -t ${sliceLen.toFixed(2)} -ar 48000 -ac 2 -b:a 192k -af "afade=t=in:st=0:d=${fi},afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fo},loudnorm=I=-20:TP=-1.5:LRA=11" "audio/cards/${safeName}-${event}.mp3"`;
      navigator.clipboard.writeText(cmd).then(() => setStatus('ffmpeg command copied to clipboard.'),
                                                () => setStatus('Clipboard copy failed — command logged to console.'));
      console.log('[audio-audit ffmpeg]', cmd);
    });
  },
  // Tiny WAV encoder — float32 PCM → 16-bit PCM WAV. ~40 lines, no
  // external dep. Output matches the audio system's expected stereo
  // 48k formats but inherits whatever sampleRate the source had so
  // the user's ffmpeg pipeline can resample on the way to MP3.
  _audioBufferToWav(buffer) {
    const numCh = buffer.numberOfChannels;
    const sr = buffer.sampleRate;
    const length = buffer.length * numCh * 2 + 44;
    const ab = new ArrayBuffer(length);
    const view = new DataView(ab);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, length - 8, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);                    // chunk size
    view.setUint16(20, 1, true);                     // PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * numCh * 2, true);
    view.setUint16(32, numCh * 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, length - 44, true);
    let off = 44;
    const channels = [];
    for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
    for (let i = 0; i < buffer.length; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = Math.max(-1, Math.min(1, channels[c][i]));
        s = s < 0 ? s * 0x8000 : s * 0x7fff;
        view.setInt16(off, s | 0, true);
        off += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  },
  // MC BALLYHOO'S ARRIVAL — music first, then the man.
  //
  // The song and the card now arrive TOGETHER — the fanfare plays under the
  // panel instead of in front of it, and his voice cuts in a beat later. It
  // used to hold the card back for ten full seconds (owner, originally: "i want
  // this song to play first ... and then his card appears"; and since: "theres
  // like 5 seconds before his art pops up ... have his art immedialty shoe
  // up"). Purely presentational: the candies are already in everyone's
  // trick hand by the time this runs, so nothing waits on the animation and a
  // player who clicks straight through misses nothing but the show.
  //
  // ONE function for every client. The host calls it from _maybeBallyhoo and
  // the three 2v2 guests call it from the relayed 'ballyhoo' FX event, so the
  // lead-in, the wording and the music are identical on all four screens
  // instead of the guests getting a bare card with no fanfare.
  // HOW LONG THE FANFARE HAS THE ROOM BEFORE HIS VOICE CUTS IN. This used to be
  // BALLYHOO_LEAD_MS: 10000 and it gated the CARD as well as the voice — ten
  // seconds of locked table with nothing on screen. (The original ask was
  // "the first song needs to play for like 10 seconds"; the follow-up was
  // "have his art immedialty shoe up".) The card no longer waits on it; this is
  // only the beat between the music starting and him talking over it.
  BALLYHOO_VOICE_LEAD_MS: 1200,
  _playTauntSound(name) {
    if (!name || !this.sfx) return;
    this.stopTaunt();                       // never stack two taunts
    try {
      // 'taunt' flag → playCardSfx bypasses the hand-audio-privacy gate, which
      // otherwise nulls every hover cue and left taunts silent.
      const played = this.sfx.playCardSfx ? this.sfx.playCardSfx(name, 'hover', 'taunt') : null;
      if (!played) { if (typeof this.sfx.play === 'function') this.sfx.play('cardHover'); return; }
      this._tauntAudio = played;
      this._tauntTimer = setTimeout(() => this.stopTaunt(), this.TAUNT_MAX_MS);
    } catch (e) {}
  },

  // ==================================================================
  // UI.audio — synthesized game-feel audio module
  // ==================================================================
  // A complete sonic language for game events, all built from Web Audio
  // synthesis (no sample assets). The point of synthesis here isn't
  // saving bandwidth (samples would be tiny) — it's CONSISTENCY OF
  // VOICE. Every cue uses the same oscillator + envelope plumbing,
  // so the whole soundscape feels like one instrument family. Adding
  // sample-based audio later would require curating ~50 samples
  // matched in tone, mix, and timbre — far harder than tuning the
  // synth params here.
  //
  // Mix philosophy:
  //   • All cues are quiet by default (peak gain 0.04-0.18). Audio
  //     should READ subliminally; on-the-nose sound effects are the
  //     hallmark of amateur game audio.
  //   • Distinct timbres per category: sines/triangles for friendly
  //     events, sawtooths for hostile, squares for UI errors, FM-like
  //     pitch sweeps for status effects. Hit the same FAMILY across
  //     a category so freezing reads similar to evading reads similar
  //     to dodging.
  //   • Pitch envelopes (attack/decay/release) shaped per event type:
  //     percussive (5ms attack, fast decay) for hits, sustained
  //     (50ms attack, slow release) for buffs/breath, slid (start
  //     freq → end freq) for sweeps.
  //   • Polyphony is unlimited but engagement-throttled at the call
  //     site: each Game event hook fires once per logical event,
  //     not per-frame.
  //
  // Volume gate: respects this.settings.sfxVolume. 0 = silent.
  // Auto-gate after page load: AudioContext is created lazily on
  // FIRST cue to satisfy browser autoplay policy.
  audio: {
    _ctx: null,
    _master: null,
    _ui: null,        // owner ref — bound by init below
    _bind(uiRef) { this._ui = uiRef; },
    _ensureCtx() {
      if (this._ctx) return this._ctx;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      this._ctx = new Ctx();
      this._master = this._ctx.createGain();
      this._master.gain.value = 1;
      // Master-bus limiter — same anti-clip guard as the sfx engine.
      const comp = this._ctx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.knee.value = 6; comp.ratio.value = 4;
      comp.attack.value = 0.003; comp.release.value = 0.15;
      this._master.connect(comp);
      comp.connect(this._ctx.destination);
      return this._ctx;
    },
    _vol() {
      const u = this._ui;
      return (u && u.settings && u.settings.sfxVolume != null) ? u.settings.sfxVolume : 1;
    },
    // Core voice: a single oscillator with attack/release envelope,
    // optional pitch slide. This is the atomic unit that every cue
    // is built from.
    voice(opts) {
      // THE SECOND SYNTH SYSTEM, GATED BY THE SAME SWITCH.
      // Owner: "still a high pitched sound when changing rounds."
      //
      // UI.sfx and UI.audio are two independent engines with their own context,
      // master bus and primitives. Turning off UI.sfx._tone/_noise silenced
      // every cue I knew about and left this one running — measured, a single
      // round change still created 36 oscillators here, from _roundCue,
      // cardDraw and trickSummon. _roundCue is the round-change sound itself.
      //
      // voice() is the only createOscillator in this object and its own comment
      // says why that is enough: "the atomic unit that every cue is built
      // from". chord() and melody() both call it, so this one guard covers the
      // whole system. It reads UI.sfx.PROCEDURAL_CUES deliberately rather than
      // keeping a flag of its own — one switch for all procedural audio, so
      // turning it back on cannot half-revive the game.
      try {
        const sfx = this._ui && this._ui.sfx;
        if (sfx && !sfx.PROCEDURAL_CUES) return;
      } catch (e) {}
      const ctx = this._ensureCtx();
      if (!ctx || this._vol() === 0) return;
      const o = opts || {};
      const t0 = ctx.currentTime + (o.delay || 0);
      const dur = o.dur != null ? o.dur : 0.15;
      const peak = (o.gain != null ? o.gain : 0.10) * this._vol();
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = o.type || 'sine';
      // Frequency envelope: if endFreq is set, slide from freq → endFreq
      osc.frequency.setValueAtTime(o.freq || 440, t0);
      if (o.endFreq != null) {
        if (o.exp) osc.frequency.exponentialRampToValueAtTime(o.endFreq, t0 + dur);
        else       osc.frequency.linearRampToValueAtTime(o.endFreq, t0 + dur);
      }
      // Amplitude envelope: attack (linear), then exponential decay
      const atk = o.attack != null ? o.attack : 0.005;
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(peak, t0 + atk);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(env).connect(this._master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },
    // Convenience: chord = N voices fired simultaneously
    chord(freqs, opts) {
      freqs.forEach(f => this.voice(Object.assign({}, opts, { freq: f })));
    },
    // Convenience: melody = N voices fired sequentially
    melody(notes) {
      // notes = [{freq, dur, gain, type, delay?}, ...]
      let t = 0;
      notes.forEach(n => {
        this.voice(Object.assign({}, n, { delay: t + (n.delay || 0) }));
        t += (n.gap != null ? n.gap : (n.dur || 0.1));
      });
    },

    // ===================================================================
    // GAME EVENT CUES — the "vocabulary" the audio language speaks
    // ===================================================================

    // ---- UI: clicks, rejection, selection ----
    // (kept minimal volumes — UI audio should support, never lead)
    click()  { this.voice({ freq: 2400, dur: 0.04, type: 'sine',   gain: 0.05 }); },
    // DELEGATED, NOT DUPLICATED. This project has TWO audio engines, and both
    // owned a 'select' cue: the sfx synth's switch case, and an 880Hz sine
    // right here. Card selection goes through _playSelectCue -> audio.select,
    // i.e. THIS one — so retuning the other engine's case changed nothing
    // audible and only the settings preview moved. Owner: "the sound when
    // selecting a card is still the same."
    //
    // Rather than paste the four variants here as well (a third place to keep
    // in sync, and this engine has no noise source so 'glass' and 'lift' could
    // not be reproduced faithfully anyway), forward to the one implementation.
    // The picker in Settings then governs the cue wherever it is triggered
    // from, which is what a setting is supposed to mean.
    select() {
      const ui = this._ui || (typeof UI !== 'undefined' ? UI : null);
      if (ui && ui.sfx && ui.sfx.play) { try { ui.sfx.play('select'); return; } catch (e) {} }
      // Fallback only if that engine is unavailable — pitched at the 'soft'
      // default rather than the old 880Hz pip, so the failure mode is quiet
      // too.
      this.voice({ freq: 300, endFreq: 240, dur: 0.045, type: 'triangle', gain: 0.07 });
    },
    reject() {
      // Descending two-tone bleep. Square wave for the "rude" timbre.
      this.voice({ freq: 220, dur: 0.10, type: 'square', gain: 0.09 });
      this.voice({ freq: 150, dur: 0.14, type: 'square', gain: 0.09, delay: 0.06 });
    },
    hover() {
      // Light whisper for hover. Throttled at call site.
      this.voice({ freq: 1800, dur: 0.03, type: 'sine', gain: 0.025 });
    },

    // ---- COMBAT: hit / kill / block / evade ----
    hit() {
      // Percussive thud — fast attack, low pitch, fast decay
      this.voice({ freq: 180, endFreq: 90, dur: 0.10, type: 'triangle', gain: 0.13 });
    },
    kill() {
      // Hit + rising "crash" overtone for finality
      this.voice({ freq: 200, endFreq: 80,  dur: 0.18, type: 'triangle', gain: 0.16 });
      this.voice({ freq: 1200, endFreq: 600, dur: 0.20, type: 'sawtooth', gain: 0.04, delay: 0.02 });
    },
    block() {
      // Metallic ping — high freq, sine for clean tone
      this.voice({ freq: 1500, endFreq: 1700, dur: 0.10, type: 'sine', gain: 0.08 });
      this.voice({ freq: 3000, dur: 0.06, type: 'sine', gain: 0.04, delay: 0.02 });
    },
    evade() {
      // Whoosh — quick high→low slide
      this.voice({ freq: 2400, endFreq: 800, dur: 0.18, type: 'sawtooth', gain: 0.06, exp: true });
    },
    armorAbsorb() {
      // Dull thud — armor absorbing damage. Lower than block (steel
      // not crystal).
      this.voice({ freq: 110, endFreq: 80, dur: 0.12, type: 'square', gain: 0.07 });
    },

    // ---- STATUS EFFECTS: each with distinct timbral signature ----
    // The mental rule: cold = high+sine, electric = mid+square,
    // dread = low+sawtooth, charm = sweet+triangle.
    freeze() {
      // Cold high crystallize — three rapid cascading high tones
      this.melody([
        { freq: 2200, dur: 0.05, type: 'sine', gain: 0.05, gap: 0.025 },
        { freq: 2800, dur: 0.05, type: 'sine', gain: 0.05, gap: 0.025 },
        { freq: 3400, dur: 0.10, type: 'sine', gain: 0.06 }
      ]);
    },
    stun() {
      // Electric crackle — square wave with rapid mod
      this.voice({ freq: 320, endFreq: 260, dur: 0.08, type: 'square', gain: 0.08 });
      this.voice({ freq: 480, endFreq: 380, dur: 0.06, type: 'square', gain: 0.06, delay: 0.03 });
    },
    fear() {
      // Low rumble + descending wail — dread
      this.voice({ freq: 80,  endFreq: 50,  dur: 0.40, type: 'sawtooth', gain: 0.08, exp: true });
      this.voice({ freq: 220, endFreq: 130, dur: 0.30, type: 'triangle', gain: 0.05, delay: 0.04 });
    },
    drain() {
      // Long descending wail — life force ebbing
      this.voice({ freq: 400, endFreq: 100, dur: 0.40, type: 'sawtooth', gain: 0.07, exp: true });
    },
    mindControl() {
      // Uneasy minor chord — three simultaneous tones
      this.chord([220, 261, 311], { dur: 0.30, type: 'triangle', gain: 0.04 });
    },
    charm() {
      // Sweet major-third + pitch wobble — Poison Ivy etc.
      this.voice({ freq: 660, endFreq: 740, dur: 0.20, type: 'triangle', gain: 0.06 });
      this.voice({ freq: 880, endFreq: 990, dur: 0.20, type: 'sine', gain: 0.05, delay: 0.04 });
    },

    // ---- BUFF / DEBUFF / HEAL ----
    buff() {
      // Ascending major chord — positive
      this.melody([
        { freq: 523, dur: 0.06, type: 'triangle', gain: 0.06, gap: 0.03 },
        { freq: 659, dur: 0.06, type: 'triangle', gain: 0.06, gap: 0.03 },
        { freq: 784, dur: 0.10, type: 'triangle', gain: 0.07 }
      ]);
    },
    debuff() {
      // Descending minor — negative
      this.melody([
        { freq: 523, dur: 0.06, type: 'triangle', gain: 0.05, gap: 0.03 },
        { freq: 415, dur: 0.06, type: 'triangle', gain: 0.05, gap: 0.03 },
        { freq: 311, dur: 0.10, type: 'triangle', gain: 0.06 }
      ]);
    },
    heal() {
      // Warm sustained tone with overtone — gentle major
      this.voice({ freq: 440, dur: 0.30, type: 'sine', gain: 0.08, attack: 0.04 });
      this.voice({ freq: 660, dur: 0.30, type: 'sine', gain: 0.05, attack: 0.04, delay: 0.02 });
    },

    // ---- TRICKS — categorical (damage / control / draw / summon) ----
    trickDamage() {
      // Sharp impact + descending tail
      this.voice({ freq: 1200, endFreq: 200, dur: 0.18, type: 'sawtooth', gain: 0.10, exp: true });
    },
    trickControl() {
      // Reverberant chord — controlly / mind-affecting
      this.chord([330, 415, 495], { dur: 0.25, type: 'sine', gain: 0.05, attack: 0.03 });
    },
    trickDraw() {
      // Pleasant ascending arpeggio
      this.melody([
        { freq: 392, dur: 0.05, type: 'sine', gain: 0.05, gap: 0.04 },
        { freq: 494, dur: 0.05, type: 'sine', gain: 0.06, gap: 0.04 },
        { freq: 587, dur: 0.08, type: 'sine', gain: 0.07 }
      ]);
    },
    trickSummon() {
      // Rising sustained tone — something coming into being
      this.voice({ freq: 220, endFreq: 660, dur: 0.30, type: 'triangle', gain: 0.07, exp: true });
    },

    // ---- CARD MOVEMENT — draw, mulligan, shuffle ----
    cardDraw() {
      // Whoosh — air moving past a card pulled from deck
      this.voice({ freq: 1500, endFreq: 600, dur: 0.16, type: 'sawtooth', gain: 0.04, exp: true });
    },
    cardPlay() {
      // Soft thwack as card lands
      this.voice({ freq: 280, endFreq: 200, dur: 0.08, type: 'triangle', gain: 0.07 });
    },
    mulligan() {
      // Rapid double-whoosh — replacing the hand
      this.cardDraw();
      setTimeout(() => this.cardDraw(), 80);
    },

    // ---- PHASE / ROUND TRANSITIONS ----
    // ---- ROUND CHANGE ----
    // WAS a 220→440Hz triangle sweep over a full 0.40s (and its mirror on the
    // way out). It topped out at the most sensitive part of the ear's range and
    // held long enough to sing rather than tick, so the loudest, whiniest thing
    // in the match was the one cue that fires every single round. Owner, after
    // I first went looking in the wrong place: "its the change round audio."
    //
    // Four alternatives, all pitched WELL below the old peak and shorter, plus
    // silent. Picked in Settings > Audio. Start and end share one setting and
    // one shape — they are the same event heard from two sides — so they can
    // never drift into sounding like different cards.
    _roundCue(dir) {
      const v = (UI.settings && UI.settings.roundSfx) || 'swell';
      if (v === 'off') return;
      const up = dir === 'start';
      const pair = (lo, hi) => up ? [lo, hi] : [hi, lo];
      if (v === 'pulse') {
        const p = pair(147, 196);
        this.melody([
          { freq: p[0], dur: 0.075, type: 'triangle', gain: 0.055, gap: 0.085 },
          { freq: p[1], dur: 0.075, type: 'triangle', gain: 0.045 }
        ]);
      } else if (v === 'chime') {
        // A soft fifth rather than a slide — reads as a marker, not a siren.
        this.chord([196, 294], { dur: 0.22, type: 'triangle', gain: 0.032 });
      } else if (v === 'deep') {
        // Near the bottom of hearing: felt more than heard.
        const p = pair(82, 110);
        this.voice({ freq: p[0], endFreq: p[1], dur: 0.34, type: 'sine', gain: 0.07, exp: true });
      } else {
        // 'swell' — the old shape, an octave and a half down and shorter.
        const p = pair(110, 165);
        this.voice({ freq: p[0], endFreq: p[1], dur: 0.30, type: 'triangle', gain: 0.05, exp: true });
      }
    },
    roundStart() { this._roundCue('start'); },
    roundEnd()   { this._roundCue('end'); },
    phaseChange() {
      // Subtle UI bleep
      this.voice({ freq: 660, dur: 0.06, type: 'sine', gain: 0.04 });
    },
    combatStart() {
      // Tense rising chord
      this.chord([147, 220, 294], { dur: 0.20, type: 'sawtooth', gain: 0.05, exp: true });
    },

    // ---- END GAME ----
    victory() {
      // Triumphal major arpeggio + sustained octave
      this.melody([
        { freq: 523, dur: 0.10, type: 'triangle', gain: 0.10, gap: 0.06 },
        { freq: 659, dur: 0.10, type: 'triangle', gain: 0.10, gap: 0.06 },
        { freq: 784, dur: 0.10, type: 'triangle', gain: 0.10, gap: 0.06 },
        { freq: 1047,dur: 0.40, type: 'triangle', gain: 0.12 }
      ]);
    },
    defeat() {
      // Descending minor with sustained low note
      this.melody([
        { freq: 392, dur: 0.10, type: 'sawtooth', gain: 0.10, gap: 0.06 },
        { freq: 311, dur: 0.10, type: 'sawtooth', gain: 0.10, gap: 0.06 },
        { freq: 247, dur: 0.40, type: 'sawtooth', gain: 0.12 }
      ]);
    }
  },

  // ==================================================================
  // installAudioHooks — wire Game events to UI.audio cues
  // ==================================================================
  // Pattern: monkey-patch each Game method that represents a "game
  // moment" with a wrap that fires the appropriate audio cue. The
  // patches are non-destructive: they call orig() first, then maybe
  // fire the cue based on what actually happened (e.g. Game.healPlayer
  // can be called with 0 = no audio).
  installAudioHooks() {
    if (this._audioHooksInstalled) return;
    this._audioHooksInstalled = true;
    if (typeof Game === 'undefined') return;
    const A = this.audio;

    // Helper for the wrap pattern
    const wrap = (name, after) => {
      if (typeof Game[name] !== 'function') return;
      const orig = Game[name].bind(Game);
      Game[name] = (...args) => {
        const r = orig(...args);
        try { after(r, args); } catch (e) {}
        return r;
      };
    };

    // ---- COMBAT ----
    wrap('applyCombatDamage', (r, args) => {
      const target = args[1];
      // Defended outcomes (return false, target survived)
      if (r === false && target && target.currentHealth > 0) {
        // Try to discriminate evade vs block vs armor by post-state.
        // We can't fully disambiguate without engine state inspection,
        // so we play `block` as the generic defense cue.
        if (target.invincibleTurns > 0 || target.hasDamageImmunity) A.block();
        else if (target.evadeCharges > 0) A.evade();
        else if (target.armorValue > 0) A.armorAbsorb();
        else A.block();
        return;
      }
      // Damage landed
      if (target && target.currentHealth <= 0) {
        A.kill();
        // Hit-pause — 90ms board-wide freeze when a card dies. The
        // single biggest "weight" addition for combat. Eye locks onto
        // the moment of death instead of the chain blurring past.
        this.hitPause(90);
        // (AAA) Kill-cam micro-cinema — fires the radial warm flash
        // anchored on the dying card's screen position, desaturates
        // the rest of the board for ~320ms, and pops the dying card
        // briefly. Layered on top of the hit-pause, NOT a replacement.
        // Keep this AFTER hitPause so the freeze blocks the pop scale
        // and we read the freeze AS the hold — not a competing motion.
        if (this.killcamFlash) this.killcamFlash(target);
      } else if (target) {
        A.hit();
      }
    });

    // ---- DEATHS (covers non-combat kills too — Darkseid lane wipes,
    //              Bear Trap, etc.) ----
    wrap('handleDeath', (r, args) => {
      // Skip if combat-related death already cued (kill cue fired in
      // applyCombatDamage above). Heuristic: if killer arg present,
      // it was likely combat OR an ability — either way `kill()` cue
      // is appropriate. For NO-killer deaths (e.g. self-destruct from
      // an ability), we still fire kill so the death is sonically
      // marked.
      // To avoid double-firing on combat deaths, debounce within a
      // single animation frame using the timestamp.
      const now = performance.now();
      if (this._lastKillCue && now - this._lastKillCue < 50) return;
      this._lastKillCue = now;
      A.kill();
    });

    // ---- BUFFS / DEBUFFS / HEAL ----
    wrap('buffCard',   (r, args) => {
      const atk = args[1] || 0;
      const hp = args[2] || 0;
      if (atk + hp > 0) A.buff();
    });
    wrap('debuffCard', (r, args) => {
      const atk = args[1] || 0;
      const hp = args[2] || 0;
      if (atk + hp > 0) A.debuff();
    });
    wrap('healPlayer', (r, args) => {
      const amount = args[1] || 0;
      if (amount > 0) A.heal();
    });

    // ---- STATUS EFFECTS ----
    wrap('freezeCard',     () => A.freeze());
    wrap('stunCard',       () => A.stun());
    wrap('fearCard',       () => A.fear());
    wrap('drainCard',      () => A.drain());
    wrap('mindControlCard',() => A.mindControl());
    wrap('charmCard',      () => A.charm());

    // ---- CARD MOVEMENT ----
    wrap('drawCards', (r, args) => {
      const count = args[1] || 1;
      if (count > 0) A.cardDraw();
    });
    wrap('mulligan', () => A.mulligan());

    // ---- TRICKS — discriminate by category ----
    // Game.playTrick is wrapped here; we infer category from trick
    // name keywords. Ideally each trick def carries a `category` field
    // for unambiguous mapping, but the keyword heuristic is good enough
    // for v1. Tricks not matching any keyword fall through to the
    // generic damage cue.
    wrap('playTrick', (r, args) => {
      if (r === false) return;
      const trick = args[1];
      if (!trick || !trick.name) return;
      const n = trick.name.toLowerCase();
      const desc = (trick.desc || '').toLowerCase();
      if (n.includes('summon') || desc.includes('summon')) A.trickSummon();
      else if (desc.includes('draw'))                       A.trickDraw();
      else if (desc.includes('mind control') || desc.includes('control'))
                                                             A.trickControl();
      else                                                   A.trickDamage();
    });

    // ---- PHASE / ROUND TRANSITIONS ----
    wrap('startRound', () => {
      // Skip the first round (round 1 has the match-start fanfare).
      const round = (Game.state && Game.state.round) || 1;
      if (round > 1) A.roundStart();
    });
    wrap('endPhase1', () => A.phaseChange());
    wrap('endPhase2', () => A.combatStart());
    wrap('endPhase3', () => A.roundEnd());

    // ---- END GAME ----
    // Watch for state.gameOver flip via render wrap; fires once per
    // game over (debounced).
    this._gameOverCued = false;
    const origRender = this.render.bind(this);
    this.render = function(...args) {
      const r = origRender(...args);
      const s = Game.state;
      if (s && s.gameOver && !this._gameOverCued) {
        this._gameOverCued = true;
        if (s.winner === 'player') A.victory();
        else                       A.defeat();
        // (AAA) Fade out the ambient arena hum on match end. 1.4s
        // tail so it doesn't disappear abruptly under the victory
        // sting.
        // NOTE: these live on UI.sfx, NOT on UI.audio (which `A` is bound to).
        // They were called as A.arenaHumStop() behind an `if (A && A.arenaHumStop)`
        // guard, so the lookup was undefined and the guard swallowed it SILENTLY —
        // the ambient arena hum and the danger heartbeat just kept playing after
        // the match ended, with no error to show for it. Call the real owner.
        try { if (this.sfx && this.sfx.arenaHumStop) this.sfx.arenaHumStop(); } catch (e) {}
        try { if (this.sfx && this.sfx._dangerHeartbeatStop) this.sfx._dangerHeartbeatStop(); } catch (e) {}
      } else if (s && !s.gameOver) {
        // Reset the latch when a new game starts.
        this._gameOverCued = false;
      }
      return r;
    };
  },
};
