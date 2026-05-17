// ============================================================
// UI — Professional TCG Theme with phase banners, status badges,
//       energy orbs, card coloring, and smooth animations
// ============================================================

const UI = {
  _lastPhase: null,
  _lastBoardCardIds: new Set(),

  // Cache-bust suffix for card portrait PNGs (audio/cards/art/*.png).
  // Bumped whenever tools/extract_card_art.py is re-run so browsers
  // refetch the latest extracted artwork instead of serving stale
  // cached PNGs (which don't have built-in cache busters since they're
  // referenced via background-image url() and not the index.html
  // version-suffix system). Bump this every time you regen art.
  _CARD_ART_VERSION: 33,

  // =====================================================================
  // CARD ART VARIANTS
  // =====================================================================
  // Each card can have multiple portrait files (Batman ships with two:
  // the dramatic-cape AI render and the original white-background paint).
  // Variants are declared in card-art-manifest.js — a card listed there
  // gets a picker badge in the codex; cards without an entry just use
  // their default `<Name>.png` (no UI rendered).
  //
  // Selected variant is persisted under clb-ui-prefs.cardArt.<CardName>
  // so the choice survives reloads. Default (first manifest entry, or
  // `<Name>.png` for unlisted cards) is used until the player picks.
  // =====================================================================

  getCardArtVariants(name) {
    const map = (typeof window !== 'undefined' && window.CARD_ART_VARIANTS) || {};
    return map[name] || null;
  },
  getCardArtVariant(name) {
    // Returns the FILE NAME (e.g. "Batman 2.png") for the player's
    // currently-selected variant of this card. Falls back to the
    // manifest's first entry, then to "<Name>.png" if not in manifest.
    if (!name) return null;
    const stored = this._persistGet('cardArt.' + name, null);
    const variants = this.getCardArtVariants(name);
    // Validate: stored choice must still exist in the manifest. If a
    // variant was renamed or removed, fall back to default instead of
    // returning a dead path.
    if (stored && variants && variants.indexOf(stored) >= 0) return stored;
    if (variants && variants.length) return variants[0];
    return name + '.png';
  },
  getCardArtPath(name) {
    // Full URL with cache buster — drop-in for every old call site
    // that used to build `audio/cards/art/${name}.png?v=...` inline.
    if (!name) return null;
    const file = this.getCardArtVariant(name);
    return `audio/cards/art/${encodeURIComponent(file)}?v=${this._CARD_ART_VERSION || 1}`;
  },
  // Wire up the global alt-art picker.
  //
  // Gesture: a click on the card's NAME STRIP (`.card-name-overlay`,
  // the translucent gradient that sits across the bottom of the
  // portrait). Each click rotates the painting to the next variant
  // declared in CARD_ART_VARIANTS for that character. Click again →
  // next. Wraps around at the end. User direction: "have it so the
  // name is clickable for each card, and then each time you click
  // the name, it rotates through a gallery of cards that I have
  // imported for that specific card."
  //
  // The listener runs in CAPTURE PHASE so it fires before the card's
  // own onclick handler (which selects / plays the card). When the
  // card has 2+ variants we stopPropagation so the name-strip click
  // never reaches the play handler — feels like a dedicated "switch
  // art" hit zone. When the card has zero or one variants the
  // listener is a no-op and the click bubbles normally to play the
  // card, so cards without alt art keep their original behavior.
  installAltArtPicker() {
    document.addEventListener('click', (e) => {
      const overlay = e.target && e.target.closest && e.target.closest('.card-name-overlay');
      if (!overlay) return;
      const cardEl = overlay.closest('[data-card-name]');
      if (!cardEl) return;
      const name = cardEl.getAttribute('data-card-name');
      if (!name) return;
      const variants = this.getCardArtVariants(name);
      if (!variants || variants.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      this.cycleCardArt(name);
    }, true /* capture: fire before card.onclick */);
  },

  cycleCardArt(name) {
    // Advance the selected variant by one and wrap. Used by the
    // codex's small "ART N/M" badge — single tap cycles through every
    // alt art on file for this card. No-op if the card has fewer than
    // 2 entries in the manifest.
    const variants = this.getCardArtVariants(name);
    if (!variants || variants.length < 2) return;
    const current = this.getCardArtVariant(name);
    const i = variants.indexOf(current);
    const next = variants[(i + 1) % variants.length];
    this.setCardArtVariant(name, next);
  },
  setCardArtVariant(name, file) {
    // Persist + SURGICAL swap. Previously this called `render()` which
    // rebuilt the entire game DOM — felt like the page was reloading,
    // killed in-flight animations, reset hover state. User direction:
    // "not have to restart the whole entire server. Just have it,
    // like, flip to the next card."
    //
    // The new path: write localStorage, then walk every card element
    // currently in the DOM that carries this character's name and
    // update ONLY its portrait's --portrait-bg CSS variable. No DOM
    // tear-down, no class shuffle, no animation reset — the painting
    // just changes in place. Future render() passes still pull the
    // correct file because getCardArtPath always reads the live
    // localStorage value.
    //
    // Validates against the manifest so a typo or stale localStorage
    // write can't poison the UI (selection silently ignored).
    if (!name || !file) return;
    const variants = this.getCardArtVariants(name);
    if (!variants || variants.indexOf(file) < 0) return;
    this._persistSet('cardArt.' + name, file);
    const bgValue = `url('${this.getCardArtPath(name)}')`;
    document.querySelectorAll('[data-card-name]').forEach(el => {
      if (el.getAttribute('data-card-name') !== name) return;
      const portrait = el.querySelector('.card-portrait');
      if (portrait) portrait.style.setProperty('--portrait-bg', bgValue);
    });
  },

  // ===================== SETTINGS (persisted in localStorage) =====================
  settings: {
    difficulty: 'normal',  // easy | normal | hard
    aiSpeed: 'normal',     // fast | normal | slow
    roundRecap: true,
    tooltips: true,
    // Phase 4c — opt-in card stats telemetry. ON by default; a setting
    // lets privacy-conscious users disable it. Stats stay entirely local.
    trackStats: true,
    // Neon theme — accent color for UI chrome (menus, buttons, panels).
    // Gameplay signal colors stay semantic. One of: blue|red|gold|green|silver.
    theme: 'blue',
    // AI pacing — 'animated' spaces AI card plays with a pause + thinking
    // indicator between each so the player can read what happened.
    // 'instant' fires them all at once (legacy behaviour; faster to
    // play repeated matches).
    aiPacing: 'animated',
    // SFX master volume (0..1). 0 silences everything. Procedural, no files.
    sfxVolume: 0.55,
    // Menu music on/off — plays on main menu, mode picker, deck builder,
    // and draft screens. Stops automatically when a round begins.
    menuMusic: true
  },
  SETTINGS_KEY: 'clb.settings.v1',

  // Theme valid values — kept in one place so settings render + apply can share it.
  THEME_VALUES: ['blue', 'red', 'gold', 'green', 'silver', 'purple'],

  // Swap the body.theme-* class so CSS --theme-* vars pick up the new RGB triplet.
  applyTheme(theme) {
    if (!this.THEME_VALUES.includes(theme)) theme = 'blue';
    const body = document.body;
    const root = document.documentElement;
    this.THEME_VALUES.forEach(t => {
      body.classList.remove('theme-' + t);
      root.classList.remove('theme-' + t);
    });
    // 'blue' is the :root default — no class needed, keeps CSS specificity simple.
    // Class applied to BOTH body AND documentElement so theme custom
    // properties cascade to elements that live OUTSIDE body — e.g.
    // the .viewport-toggle which initViewportMode() relocates to be a
    // direct child of <html> so it stays in viewport-coordinate space
    // during mobile-preview transforms. Before this, theme vars only
    // existed on body.theme-X so the toggle stayed Tron-blue forever.
    if (theme !== 'blue') {
      body.classList.add('theme-' + theme);
      root.classList.add('theme-' + theme);
    }
    this.settings.theme = theme;
    // Reflect active swatch in the custom theme picker if it's rendered.
    const picker = document.getElementById('setting-theme-picker');
    if (picker) {
      picker.querySelectorAll('.theme-swatch').forEach(b => {
        b.classList.toggle('theme-swatch-active', b.dataset.theme === theme);
        b.setAttribute('aria-checked', b.dataset.theme === theme);
      });
    }
  },

  loadSettings() {
    try {
      const raw = localStorage.getItem(this.SETTINGS_KEY);
      if (raw) Object.assign(this.settings, JSON.parse(raw));
    } catch (e) { /* ignore */ }
    // Apply theme on load so it's present before first render.
    this.applyTheme(this.settings.theme || 'blue');
    // Apply colorblind body class on load so CSS picks it up before
    // the first board render (otherwise the player sees a flash of
    // non-cb styling before Save is toggled).
    document.body.classList.toggle('colorblind', !!this.settings.colorblind);
    // Apply CRT scanline overlay if enabled.
    document.body.classList.toggle('crt-on', !!this.settings.crt);
    // Apply UI scale on load so the first render is at the user's
    // chosen zoom, not a flash of 100% followed by resize.
    this._applyUiScale(this.settings.uiScale || 1);
    // Paint the player nameplate from stored settings.
    this._applyPlayerIdentity();
  },
  // Paint the player's custom name + glyph into the player-bar
  // nameplate (mirrors the AI opponent chip on the ai-bar). Called
  // on load + whenever Settings save.
  _applyPlayerIdentity() {
    const name = (this.settings.playerName || 'YOU').trim().slice(0, 12) || 'YOU';
    const glyph = this.settings.playerAvatar || '▲';
    const avEl = document.getElementById('player-avatar');
    const nmEl = document.getElementById('player-name');
    const cellEl = document.getElementById('player-avatar-cell');
    if (avEl) avEl.textContent = glyph;
    if (nmEl) nmEl.textContent = name;
    if (cellEl) cellEl.title = `${name} — that's you`;
  },

  // Scale the root font-size. Em-based CSS cascades; fixed-px pieces
  // (card dimensions, icon sizes) remain unaffected — that's usually
  // the preference since card art/layout shouldn't shrink past a
  // usable threshold. Anything rem-based or %-based scales cleanly.
  _applyUiScale(scale) {
    const s = Math.max(0.7, Math.min(1.5, parseFloat(scale) || 1));
    document.documentElement.style.fontSize = (16 * s) + 'px';
    document.body.dataset.uiScale = s.toFixed(2);
  },
  saveSettings() {
    const g = (id) => document.getElementById(id);
    this.settings.difficulty  = g('setting-difficulty').value;
    this.settings.aiSpeed     = g('setting-ai-speed').value;
    this.settings.roundRecap  = g('setting-round-recap').checked;
    this.settings.tooltips    = g('setting-tooltips').checked;
    const aiPacingEl = g('setting-ai-pacing');
    if (aiPacingEl) this.settings.aiPacing = aiPacingEl.value;
    const trackStatsEl = g('setting-track-stats');
    if (trackStatsEl) this.settings.trackStats = trackStatsEl.checked;
    const sfxVolEl = g('setting-sfx-volume');
    if (sfxVolEl) {
      this.settings.sfxVolume = parseInt(sfxVolEl.value, 10) / 100;
      if (this.sfx) {
        this.sfx.setVolume(this.settings.sfxVolume);
        this.sfx.setMusicVolume();
        // If the user just turned audio from 0 back up, resume music;
        // if they just muted, stop the loop entirely.
        if (this.settings.sfxVolume === 0) this.sfx.stopMusic();
        else if (this.sfx._music && this.sfx._music.paused && this.sfx._musicWantPlay && this.settings.menuMusic) {
          try { this.sfx._music.play().catch(() => {}); } catch (e) {}
        }
      }
    }
    const menuMusicEl = g('setting-menu-music');
    if (menuMusicEl) {
      const prev = this.settings.menuMusic !== false;
      this.settings.menuMusic = menuMusicEl.checked;
      if (this.sfx) {
        if (!this.settings.menuMusic) {
          // Toggled OFF — stop whatever's playing right now.
          this.sfx.stopMusic();
        } else if (!prev) {
          // Toggled ON — if we're currently on a menu phase, restart.
          const phase = (typeof Game !== 'undefined' && Game.state) ? Game.state.phase : null;
          const menuPhases = ['main-menu', 'mode-select', 'my-decks', 'stats', 'deckbuilder-build', 'draft-cards', 'draft-tricks'];
          if (menuPhases.includes(phase)) this.sfx.startMusic();
        }
      }
    }
    // Colorblind mode — toggle a body class so CSS can swap red/theme
    // card chrome for shape/pattern differentiation (stripes on enemy
    // cards). Theme picker keeps working for UI chrome.
    const cbEl = g('setting-colorblind');
    if (cbEl) {
      this.settings.colorblind = cbEl.checked;
      document.body.classList.toggle('colorblind', !!this.settings.colorblind);
    }
    // Haptics — user can opt out for a silent play experience or if
    // the phone's buzz is annoying in long sessions.
    const hapEl = g('setting-haptics-off');
    if (hapEl) this.settings.hapticsOff = hapEl.checked;
    // CRT scanlines — toggleable Tron monitor overlay. Off by default
    // because it can strain eyes during long sessions.
    const crtEl = g('setting-crt');
    if (crtEl) {
      this.settings.crt = crtEl.checked;
      document.body.classList.toggle('crt-on', !!this.settings.crt);
    }
    // UI scale — scales the root font-size so em-based CSS scales in
    // turn, plus applies a CSS transform on the body for pixel
    // fidelity on the parts of the game that use fixed pixel sizes.
    const scaleEl = g('setting-ui-scale');
    if (scaleEl) {
      const scale = parseFloat(scaleEl.value) || 1;
      this.settings.uiScale = scale;
      this._applyUiScale(scale);
    }
    // Player avatar + name — paints into the player-bar nameplate
    // (mirrors the AI opponent chip). Empty name falls back to "YOU".
    const pNameEl = g('setting-player-name');
    const pAvEl = g('setting-player-avatar');
    if (pNameEl) this.settings.playerName = (pNameEl.value || '').trim().slice(0, 12) || 'YOU';
    if (pAvEl) this.settings.playerAvatar = pAvEl.value || '▲';
    this._applyPlayerIdentity();
    // Theme is saved continuously by applyTheme; nothing to read here.
    try { localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) {}
    this.closeSettings();
  },
  openSettings() {
    const g = (id) => document.getElementById(id);
    g('setting-difficulty').value = this.settings.difficulty;
    g('setting-ai-speed').value   = this.settings.aiSpeed;
    g('setting-round-recap').checked = this.settings.roundRecap;
    g('setting-tooltips').checked   = this.settings.tooltips;
    const crtElLoad = g('setting-crt');
    if (crtElLoad) {
      crtElLoad.checked = !!this.settings.crt;
      document.body.classList.toggle('crt-on', !!this.settings.crt);
    }
    const aiPacingEl = g('setting-ai-pacing');
    if (aiPacingEl) aiPacingEl.value = this.settings.aiPacing || 'animated';
    const trackStatsEl = g('setting-track-stats');
    if (trackStatsEl) trackStatsEl.checked = this.settings.trackStats !== false;
    const sfxVolEl = g('setting-sfx-volume');
    if (sfxVolEl) {
      sfxVolEl.value = Math.round((this.settings.sfxVolume ?? 0.55) * 100);
      // Drive the --sfx-pct CSS var so the track paints a wash up to the
      // thumb (same feel as the player HP bar filling). Hook input once
      // so the fill chases the thumb in real time.
      const syncFill = () => { sfxVolEl.style.setProperty('--sfx-pct', sfxVolEl.value + '%'); };
      syncFill();
      if (!sfxVolEl._fillHookWired) {
        sfxVolEl._fillHookWired = true;
        sfxVolEl.addEventListener('input', syncFill);
      }
    }
    const menuMusicEl = g('setting-menu-music');
    if (menuMusicEl) menuMusicEl.checked = this.settings.menuMusic !== false;
    const cbEl = g('setting-colorblind');
    if (cbEl) cbEl.checked = !!this.settings.colorblind;
    const hapEl = g('setting-haptics-off');
    if (hapEl) hapEl.checked = !!this.settings.hapticsOff;
    const scaleEl = g('setting-ui-scale');
    if (scaleEl) scaleEl.value = String(this.settings.uiScale || 1);
    const pNameEl = g('setting-player-name');
    if (pNameEl) pNameEl.value = (this.settings.playerName && this.settings.playerName !== 'YOU') ? this.settings.playerName : '';
    const pAvEl = g('setting-player-avatar');
    if (pAvEl) pAvEl.value = this.settings.playerAvatar || '▲';
    // Re-apply theme on open so the swatch grid reflects the current theme
    // even if the picker was re-rendered. No-op if nothing changed.
    this.applyTheme(this.settings.theme || 'blue');
    const ov = g('settings-overlay');
    ov.classList.remove('classic-overlay-closing');
    ov.style.display = 'flex';
    if (this.sfx && this.sfx.play) {
      try { this.sfx.play('modalOpen'); } catch (e) {}
    }
  },
  // Live-preview the theme as the user changes the dropdown (before Save).
  previewTheme(theme) { this.applyTheme(theme); },
  closeSettings() { this._closeClassicOverlay('settings-overlay'); },

  // Graceful exit for classic overlays — adds .classic-overlay-closing
  // which reverses the entry animation, then hides via display:none
  // after the animation completes. Audit finding: classic overlays
  // closed with no exit animation (hard cut). Same UX pattern as the
  // roguelite rl-modal closing flow.
  _closeClassicOverlay(overlayId) {
    const ov = typeof overlayId === 'string' ? document.getElementById(overlayId) : overlayId;
    if (!ov || ov.style.display === 'none') return;
    ov.classList.add('classic-overlay-closing');
    if (this.sfx && this.sfx.play) {
      try { this.sfx.play('modalClose'); } catch (e) {}
    }
    setTimeout(() => {
      if (!ov.classList.contains('classic-overlay-closing')) return;
      ov.style.display = 'none';
      ov.classList.remove('classic-overlay-closing');
    }, 220);
  },

  // Abandon the current match / draft / deckbuilder session from the
  // Settings modal and bounce back to the main menu. Confirms first so
  // an accidental click mid-game doesn't nuke progress. Skips the
  // confirm if we're already on the main menu (no-op) so the button
  // still feels responsive in that edge case.
  quitToMainMenu() {
    const phase = Game && Game.state ? Game.state.phase : null;
    const inMatch = phase && phase !== 'main-menu' && phase !== 'mode-select'
                 && phase !== 'my-decks' && phase !== 'stats';
    if (inMatch && !confirm('Return to the main menu? Your current match will be lost.')) return;
    this.closeSettings();
    if (Game && Game.goToMainMenu) Game.goToMainMenu();
  },

  // Settings backup — copy the entire settings blob (theme, SFX volume,
  // difficulty, etc.) to the clipboard as JSON. Paste it into Import to
  // restore on another device / browser. Deliberately plain JSON (no
  // base64) since settings are small and user-readable is handy for
  // debugging. Saved decks + match history are separate backups.
  exportSettings() {
    try {
      const blob = JSON.stringify({
        v: 1,
        settings: this.settings,
        savedDecks: this._dbGetSavedDecks()
      }, null, 2);
      const flash = (msg) => {
        if (this.showAITrickToast) this.showAITrickToast('Settings Copied', msg, 'trick');
        else alert(msg);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(blob).then(
          () => flash('Settings + saved decks copied to clipboard'),
          () => { window.prompt('Copy your settings backup:', blob); }
        );
      } else {
        window.prompt('Copy your settings backup:', blob);
      }
    } catch (e) {
      alert('Could not export settings: ' + (e && e.message || e));
    }
  },
  importSettings() {
    const raw = (window.prompt('Paste settings JSON to import:') || '').trim();
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); }
    catch (e) { alert('Invalid settings JSON — could not parse.'); return; }
    if (!payload || payload.v !== 1 || typeof payload.settings !== 'object') {
      alert('Invalid settings — unrecognized format.');
      return;
    }
    if (!confirm('Overwrite your current settings (and saved decks if included) with the imported backup?')) return;
    // Merge into existing settings so unknown future keys aren't lost.
    Object.assign(this.settings, payload.settings);
    try { localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) {}
    if (payload.savedDecks && typeof payload.savedDecks === 'object') {
      const { decks, dropped } = this._validateImportedDecks(payload.savedDecks);
      this._dbSetSavedDecks(decks);
      if (dropped.length) {
        console.warn('[importSettings] dropped malformed decks:', dropped);
      }
    }
    // Re-apply visual settings immediately.
    if (this.applyTheme) this.applyTheme(this.settings.theme || 'blue');
    if (this.sfx && this.sfx.setVolume) this.sfx.setVolume(this.settings.sfxVolume ?? 0.55);
    this.closeSettings();
    alert('Settings imported successfully.');
  },

  // AI scheduling — delay between AI card plays so player can follow along.
  // Scales with aiSpeed; Normal slowed a bit (was 320ms) so plays are easier
  // to read; Slow extended proportionally.
  aiStepDelay() {
    return { fast: 150, normal: 450, slow: 800 }[this.settings.aiSpeed] || 450;
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
      // Vader hover = imperial breath; death = injured-breath sting
      // (3s, longer than the 1.5s default cap — `maxDur: 3.5` lets the
      // dying breath play out fully rather than getting clipped). Not
      // LEGO style, intentional — Vader's death is a cinematic moment
      // and the iconic film sting carries the weight better than a
      // cartoon yelp.
      'Darth Vader':      { hover: 'audio/cards/darth-vader-hover.mp3', death: { src: 'audio/cards/darth-vader-death.mp3', maxDur: 3.5 } },
      // Batman hover: 1:45 of Hans Zimmer & James Newton Howard's "A
      // Watchful Guardian" (Dark Knight OST), 2:15 → 4:00 of source.
      // -20 LUFS unified-baseline, 1s fade-in / 2s fade-out. maxDur 106
      // lets the full phrase play.
      'Batman':           {
        hover: { src: 'audio/cards/batman-hover.mp3?v=2', maxDur: 106 },
        play:  { src: 'audio/cards/batman-play.mp3', maxDur: 20 },
        death: 'audio/cards/batman-death.mp3',
        // When Batman deals damage (his "Strike 1" / "Strike 2"
        // batarang throws after the Fear pick), fire the Batarangs
        // trick SFX instead of the generic procedural 'hit' synth.
        // Two short throws (0.89s each) layer cleanly over the Arkham
        // theme + ducked hover bed.
        effects: { damage: 'audio/cards/batarangs-play.mp3' },
      },
      // Spider-Man hover: first 1:20 of Danny Elfman's "Main Title"
      // (Spider-Man 2002). Normalized to -20 LUFS — the unified baseline
      // for signature cinematic hovers (Spider-Man / Anakin / Superman
      // all sit at -20). 1s fade-in / 2s fade-out baked in. maxDur 81
      // lets the full phrase play; ability slot kept for the legacy
      // Spider-Man swing cue.
      'Spider-Man':       { hover: { src: 'audio/cards/spider-man-hover.mp3?v=3', maxDur: 81 }, ability: 'audio/cards/spider-man-ability.mp3' },
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
      'Joker':            { death: 'audio/cards/joker-death.mp3' },
      // Poison Ivy death — 0.58s clip, plays on every Ivy kill.
      'Poison Ivy':       { death: 'audio/cards/poison-ivy-death.mp3' },
      // Man-Bat death — 0.65s clip, plays on every Man-Bat kill.
      'Man-Bat':          { death: 'audio/cards/man-bat-death.mp3' },
      // Bane death — 0.58s clip, plays on every Bane kill.
      'Bane':             { death: 'audio/cards/bane-death.mp3' },
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
      // Captain America hover: 65s of Harry James's "It's Been a Long, Long
      // Time" (start → 1:05) — the period-correct cue from CA's WWII era.
      // -20 LUFS unified-baseline, 1s fade-in / 2s fade-out baked.
      'Captain America':  { hover: { src: 'audio/cards/captain-america-hover.mp3', maxDur: 66 } },
      // Optimus Prime hover: 57s of Steve Jablonsky's "Bumblebee Captured"
      // (0:24 → 1:21) — the Autobot-leader theme reprise from the
      // Transformers OST. -20 LUFS unified-baseline, 1s fade-in / 2s
      // fade-out baked.
      'Optimus Prime':    { hover: { src: 'audio/cards/optimus-prime-hover.mp3', maxDur: 58 } },
      // Iron Man hover: 81s of AC/DC's "Shoot to Thrill" (start → 1:21) —
      // Tony's signature entrance riff. -20 LUFS unified-baseline, 1s
      // fade-in / 2s fade-out baked.
      'Iron Man':         { hover: { src: 'audio/cards/iron-man-hover.mp3', maxDur: 82 } },
      // Black Panther hover: 69s of Kendrick Lamar & SZA's "All The Stars"
      // (1:58 → 3:07) — the Wakandan signature cue. -20 LUFS unified-
      // baseline, 1s fade-in / 2s fade-out baked.
      'Black Panther':    { hover: { src: 'audio/cards/black-panther-hover.mp3', maxDur: 70 } },
      // Winter Soldier hover: 52s of Henry Jackman's "End Of The Line"
      // (1:05 → 1:57 of the source) — the cold-war motif build. -20 LUFS
      // unified-baseline, 1s fade-in / 2s fade-out baked. maxDur 53 lets
      // the full phrase play.
      'Winter Soldier':   { hover: { src: 'audio/cards/winter-soldier-hover.mp3?v=1', maxDur: 53 } },
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
      // Hulk hover: 42s of Danny Elfman's "End Credits — From Hulk"
      // (0:27 → 1:09 of the source). -20 LUFS unified-baseline, 1s
      // fade-in / 2s fade-out baked. maxDur 43 lets the full phrase play.
      'Hulk':             { hover: { src: 'audio/cards/hulk-hover.mp3?v=1', maxDur: 43 }, play: 'audio/cards/hulk-play.mp3' },
      'Symbiote Spider-Man': { play: { src: 'audio/cards/symbiote-spider-man-play.mp3', maxDur: 5.0 } },
      'Jango Fett':       { attack: 'audio/cards/jango-fett-attack.mp3', death: 'audio/cards/jango-fett-death.mp3' },
      'Jason Voorhees':   { play: { src: 'audio/cards/jason-play.mp3', maxDur: 5.0 } },
      // Michael Myers hover: 55s of John & Cody Carpenter's "The Shape
      // Returns" (start → 0:55) — the Halloween theme reborn. -20 LUFS
      // unified-baseline, 1s fade-in / 2s fade-out baked. maxDur 56 lets
      // the full phrase play; play slot keeps the existing stinger.
      'Michael Myers':    { hover: { src: 'audio/cards/michael-myers-hover.mp3?v=1', maxDur: 56 }, play: { src: 'audio/cards/michael-myers-play.mp3', maxDur: 5.0 } },
      'Thanos':           { hover: 'audio/cards/thanos-hover.mp3?v=3', ability: 'audio/cards/thanos-ability.mp3?v=2', voiceLine: 'audio/cards/thanos-kill.mp3' },
      // Gojo hover: 59s of Lady Gaga's "Judas" (3:11 → end of source) — the
      // outro/refrain section. -20 LUFS unified-baseline, 1s fade-in / 2s
      // fade-out baked. maxDur 60 lets the full phrase play; ability slot
      // kept for the Hollow Purple cue (fires from inside abilities.js
      // when Hollow Purple resolves, not on play).
      'Gojo':             { hover: { src: 'audio/cards/gojo-hover.mp3?v=2', maxDur: 60 }, ability: { src: 'audio/cards/gojo-ability.mp3', maxDur: 4.0 } },
      'Xenomorph':        { hover: 'audio/cards/xenomorph-hover.mp3', play: 'audio/cards/xenomorph-play.mp3', attack: 'audio/cards/xenomorph-attack.mp3', death: 'audio/cards/xenomorph-death.mp3' },
      'Predator':         { hover: 'audio/cards/predator-hover.mp3', ability: { src: 'audio/cards/predator-ability.mp3', maxDur: 3.0 } },
      'Thor':             { hover: 'audio/cards/thor-hover.mp3', attack: { src: 'audio/cards/thor-attack.mp3', maxDur: 1.5 } },
      // Lightsaber hum — Jedi only (Yoda, Obi-Wan, Ahsoka, Anakin).
      // Yoda — no hover (intentional silence), LEGO death sting on kill.
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
      'Mr. Freeze':       { effects: { freeze: 'audio/cards/mr-freeze-freeze.mp3' } },
      // Luke Skywalker hover: 98s of Samuel Kim's "A Jedi's Fury" (0:31 →
      // 2:09 of source) — the heroic-build section. -20 LUFS unified-
      // baseline, 1s fade-in / 2s fade-out baked. maxDur 99 lets the full
      // phrase play.
      'Luke Skywalker':   { hover: { src: 'audio/cards/luke-hover.mp3?v=2', maxDur: 99 } },
      'Obi-Wan':          { hover: 'audio/cards/default-hover.mp3', death: 'audio/cards/obi-wan-death.mp3' },
      'Ahsoka':           { hover: 'audio/cards/default-hover.mp3' },
      // Anakin Skywalker hover: 109s of John Williams' "Anakin's Dark Deeds"
      // (LSO recording) — trimmed from 2:15 to the end of the source so the
      // hover lands on the final, darker arc of the piece. -20 LUFS (unified
      // signature-hover baseline), 1s fade-in / 2s fade-out baked in.
      // maxDur 110 lets the full phrase play across re-hovers.
      'Anakin Skywalker': { hover: { src: 'audio/cards/anakin-hover.mp3?v=4', maxDur: 110 }, death: 'audio/cards/anakin-death.mp3' },
      'Red Skull':        { hover: 'audio/cards/red-skull-hover.mp3', play: 'audio/cards/red-skull-play.mp3' },
      // Superman hover: first 1:14 of Hans Zimmer's "Krypton's Last" — the
       // opening swell through the first cadence. Normalized to -20 LUFS
       // (unified signature-hover baseline), 1s fade-in / 2s fade-out baked.
       // maxDur 75 lets the full phrase play; resume-on-rehover keeps the
       // position across visits.
      'Superman':         { hover: { src: 'audio/cards/superman-hover.mp3?v=7', maxDur: 75 } }
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
      play:      null, // procedural cardPlay / cardPlayEnemy
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
      mindControl: null,
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
        // Effect SFX (fear, freeze, stun, damage, etc.) sit at the
        // 'effect' tier — 0.7× of base sfxVolume — so they layer
        // underneath play/voice marquee events.
        const playOpts = Object.assign({ maxDur: 1.5, fadeIn: 100, fadeOut: 200, category: 'effect' }, opts || {});
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
      }
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
      'Kang': {
        hover:  function() { this._tone({ type:'sine', freq:660, dur:0.25, gain:0.05, attack:0.02, release:0.3 }); this._tone({ type:'sine', freq:990, dur:0.25, gain:0.04, attack:0.02, release:0.3, delay:0.05 }); },
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
        hover:  function() { this._tone({ type:'sine', freq:523, freqEnd:588, dur:0.2, gain:0.06, attack:0.02, release:0.24 }); this._tone({ type:'sine', freq:588, freqEnd:523, dur:0.2, gain:0.05, attack:0.02, release:0.24, delay:0.18 }); },
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
      'Cyborg': {
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
    // Looping menu-screen music. One HTMLAudioElement, loops forever while
    // the player is on any menu (main, mode-select, my-decks, stats, deck
    // builder) — stops when startMatch fires so gameplay audio owns the
    // mix. Volume sits well below sfxVolume so cues still cut through.
    _music: null,
    _musicWantPlay: false,
    // Menu music — Daft Punk's "End Of Line" (Tron: Legacy OST). Full
    // 2:36 track, normalized to -16 LUFS (Spotify/YouTube reference
    // loudness), no fades baked so the `loop = true` boundary is seamless.
    // Previous F1-by-Zimmer track is banked at audio/.menu_music.f1.bak.mp3
    // — restore by renaming if you want to swap back.
    MUSIC_SRC: 'audio/menu_music.mp3?v=5',

    _init() {
      if (this._ctx) return true;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this._ctx = new AC();
        this._master = this._ctx.createGain();
        this._master.gain.value = (UI.settings && UI.settings.sfxVolume) ?? 0.55;
        this._master.connect(this._ctx.destination);
      } catch (e) { return false; }
      return true;
    },

    setVolume(v) {
      if (!this._init()) return;
      this._master.gain.value = Math.max(0, Math.min(1, v));
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
          try { this._ctx.resume(); } catch (e) {}
        }
        if (this._musicWantPlay && this._music && this._music.paused) {
          try { this._music.play().catch(() => {}); } catch (e) {}
        }
      };
      window.addEventListener('pointerdown', resume, { passive: true });
      window.addEventListener('keydown', resume);
    },

    _tone({ type = 'sine', freq = 440, freqEnd = null, dur = 0.15, gain = 0.25, attack = 0.005, release = null, delay = 0 }) {
      if (!this._init()) return;
      const ctx = this._ctx;
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
      const rel = release != null ? release : dur;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + rel);
      osc.connect(g); g.connect(this._master);
      osc.start(t0); osc.stop(t0 + rel + 0.02);
    },

    _noise({ dur = 0.12, gain = 0.12, highpass = 400, lowpass = 6000, delay = 0 }) {
      if (!this._init()) return;
      const ctx = this._ctx;
      const t0 = ctx.currentTime + delay;
      const len = Math.ceil(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = highpass;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lowpass;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(this._master);
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
      const a = new Audio(this.MUSIC_SRC);
      a.loop = true;
      a.preload = 'auto';
      this._music = a;
      return a;
    },

    startMusic() {
      if (!UI.settings || UI.settings.sfxVolume === 0) { this._musicWantPlay = true; return; }
      // Menu-music toggle: when off, remember intent (so toggling back on
      // mid-menu can auto-resume) but skip actual playback.
      if (UI.settings.menuMusic === false) { this._musicWantPlay = true; return; }
      const a = this._ensureMusic();
      // Music sits under nav cues (0.35×) so a sound effect at sfxVolume
      // always reads above the loop. Cancel any in-flight fade from a
      // prior stopMusic so we don't rubber-band.
      const target = Math.max(0, Math.min(1, (UI.settings.sfxVolume ?? 0.55) * 0.35));
      if (this._musicFadeInterval) { clearInterval(this._musicFadeInterval); this._musicFadeInterval = null; }
      this._musicWantPlay = true;
      try {
        // Start silent, ramp up over 400ms.
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
    _MUSIC_DUCK_FACTOR: 0.18,  // duck to ~18% of normal level (-15 dB)
    _MUSIC_DUCK_FADE_MS: 600,
    duckMusic() {
      if (!this._music || this._music.paused) return;
      if (this._musicDucked) return;
      this._musicDucked = true;
      const fullTarget = Math.max(0, Math.min(1, (UI.settings.sfxVolume ?? 0.55) * 0.35));
      this._musicDuckBase = fullTarget;
      const duckTarget = fullTarget * this._MUSIC_DUCK_FACTOR;
      if (this._musicFadeInterval) { clearInterval(this._musicFadeInterval); this._musicFadeInterval = null; }
      this._fadeVolume(this._music, duckTarget, this._MUSIC_DUCK_FADE_MS, '_musicFadeInterval');
    },
    restoreMusic() {
      if (!this._music || this._music.paused) { this._musicDucked = false; return; }
      if (!this._musicDucked) return;
      this._musicDucked = false;
      const fullTarget = this._musicDuckBase ?? Math.max(0, Math.min(1, (UI.settings.sfxVolume ?? 0.55) * 0.35));
      if (this._musicFadeInterval) { clearInterval(this._musicFadeInterval); this._musicFadeInterval = null; }
      this._fadeVolume(this._music, fullTarget, this._MUSIC_DUCK_FADE_MS, '_musicFadeInterval');
    },

    stopMusic() {
      this._musicWantPlay = false;
      if (!this._music) return;
      const a = this._music;
      if (this._musicFadeInterval) { clearInterval(this._musicFadeInterval); this._musicFadeInterval = null; }
      // Fade the loop out over 400ms before pausing — keeps the menu-to-
      // round transition feeling cinematic instead of a silence drop.
      const restoreVol = Math.max(0, Math.min(1, (UI.settings.sfxVolume ?? 0.55) * 0.35));
      this._fadeVolume(a, 0, 600, '_musicFadeInterval', () => {
        try { a.pause(); a.currentTime = 0; a.volume = restoreVol; } catch (e) {}
      });
    },

    setMusicVolume() {
      if (!this._music) return;
      this._music.volume = Math.max(0, Math.min(1, (UI.settings.sfxVolume ?? 0.55) * 0.35));
    },

    // Low-level HTMLAudioElement playback for a specific sound file. Clone
    // pool keyed by URL so overlapping triggers of the same file each get
    // their own playback head. Returns the audio element that started
    // playing (or null) so callers — e.g. hover — can stop it mid-clip.
    // Cancel any fade-in / cap-fade timers currently scheduled on a pooled
    // clone. Called when the clone is re-used for a new play so the old
    // timers don't fight with the new one's volume.
    _clearFadeTimers(a) {
      if (a._fadeInInterval) { clearInterval(a._fadeInInterval); a._fadeInInterval = null; }
      if (a._capTimeout)     { clearTimeout(a._capTimeout);      a._capTimeout = null; }
      if (a._capInterval)    { clearInterval(a._capInterval);    a._capInterval = null; }
      if (a._stopInterval)   { clearInterval(a._stopInterval);   a._stopInterval = null; }
    },

    // Volume ramp helper — eases a clone's .volume from its current value
    // to `toVol` over `durMs`, calling `onDone` when finished. Holds the
    // interval id on the element so a follow-up play can cancel it.
    // Tracks under `slot` so fade-in / fade-out / stop fades don't step on
    // each other. Fades DOWN use an ease-out-quad curve so the tail
    // lingers at low volume and the cut to silence doesn't click; fades
    // UP are linear (sharp transients still read as immediate).
    _fadeVolume(a, toVol, durMs, slot, onDone) {
      const startVol = a.volume;
      const goingDown = toVol < startVol;
      const t0 = Date.now();
      const key = slot || '_fadeInterval';
      if (a[key]) { clearInterval(a[key]); a[key] = null; }
      a[key] = setInterval(() => {
        const p = Math.min(1, (Date.now() - t0) / durMs);
        // Ease-out-quad on the way down: amplitude drops more quickly
        // initially, so we spend the last portion of the fade at quiet
        // levels where a straight cut would otherwise stand out. Up-ramps
        // stay linear — they're short and don't benefit from easing.
        const eased = goingDown ? 1 - Math.pow(1 - p, 2) : p;
        a.volume = Math.max(0, Math.min(1, startVol + (toVol - startVol) * eased));
        if (p >= 1) {
          clearInterval(a[key]); a[key] = null;
          if (onDone) onDone();
        }
      }, 20);
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
    _CARD_AUDIO_VERSION: 6,
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
      let clones = this._samplePool.get(src);
      if (!clones) {
        clones = [];
        for (let i = 0; i < 3; i++) { const a = new Audio(src); a.preload = 'auto'; clones.push(a); }
        this._samplePool.set(src, clones);
      }
      const isHover = !!(opts && opts.hover);
      let pick;
      if (isHover) {
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
        if (this._activeHover.size > 0) {
          const duckMs = (opts && opts.fadeIn) || 200;
          const restoreMs = (opts && opts.fadeOut) || 600;
          // The play SFX's own scheduled-end is at `maxDur` (or natural
          // duration). Restore hover after it ends so the duck duration
          // matches the cue's actual lifespan.
          const playLife = (opts && opts.maxDur)
            ? opts.maxDur * 1000
            : 1500;
          this._activeHover.forEach(hov => {
            if (hov === pick) return;
            // Stash the original target volume so we can restore it.
            // If a duck is already in flight, keep the EARLIER pre-duck
            // value so back-to-back SFX don't compound the dip.
            if (hov._preDuckVol == null) hov._preDuckVol = hov.volume;
            this._clearFadeTimers(hov, '_duckInInterval');
            this._clearFadeTimers(hov, '_duckOutInterval');
            // Fade DOWN to 50% of pre-duck volume — user spec:
            // "the hover music plays, but just like at, like, 50%
            // of its actual decibels, and then the [play SFX] is on
            // top of that." Sweet spot — quiet enough to give the
            // play cue room, loud enough to feel like a continuous
            // bed.
            const targetDown = hov._preDuckVol * 0.50;
            this._fadeVolume(hov, targetDown, duckMs, '_duckInInterval');
            // Schedule restore once the play SFX is mostly done.
            clearTimeout(hov._duckRestoreTimer);
            hov._duckRestoreTimer = setTimeout(() => {
              if (!this._activeHover.has(hov)) return; // hover already stopped — let _stopHover handle volume
              this._fadeVolume(hov, hov._preDuckVol, restoreMs, '_duckOutInterval');
              hov._preDuckVol = null;
            }, Math.max(playLife - restoreMs / 2, duckMs + 50));
          });
        }
      }
      this._clearFadeTimers(pick);
      // Apply category-based gain — voice/play sit at full volume,
      // supporting effects 30% quieter so the mix has hierarchy.
      const cat = (opts && opts.category) || (isHover ? 'hover' : 'effect');
      const catGain = this._CATEGORY_GAIN[cat] ?? 1.0;
      const vol = Math.max(0, Math.min(1, (UI.settings.sfxVolume ?? 0.55) * catGain));
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
          const tgt = other._sfxPreDuck * 0.60;
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
      try {
        pick.volume = 0;
        if (!isHover) pick.currentTime = 0;
        const p = pick.play();
        if (p && p.catch) p.catch(() => {});
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
      const fadeInMs = (opts && opts.fadeIn) ? opts.fadeIn : 130;
      this._fadeVolume(pick, vol, fadeInMs, '_fadeInInterval');
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
          const t0 = Date.now();
          pick._capInterval = setInterval(() => {
            const elapsed = Date.now() - t0;
            const p = Math.min(1, elapsed / fadeMs);
            // Ease-out-quad matches _fadeVolume so the end-of-clip taper
            // feels the same shape as every other down-fade.
            const eased = 1 - Math.pow(1 - p, 2);
            pick.volume = startVol * (1 - eased);
            if (p >= 1) {
              clearInterval(pick._capInterval); pick._capInterval = null;
              try { pick.pause(); pick.currentTime = 0; pick.volume = startVol; } catch (e) {}
            }
          }, 20);
        }, fadeStartMs);
      };
      const maxDur = opts && opts.maxDur;
      if (maxDur && maxDur > 0) {
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
      if (typeof entry === 'string') return { src: entry, opts: null };
      if (typeof entry === 'object' && entry.src) return { src: entry.src, opts: { maxDur: entry.maxDur } };
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
      // Card SFX events:
      //   • hover     — 8s clip, 1s fade-in, 2s fade-out
      //   • play      — 4s clip, 0.5s fade-in, 1s fade-out
      //   • death     — 1.5s clip, default fades (multiple deaths chain)
      //   • ability   — 4s clip, 0.5s fade-in, 1s fade-out (NOT auto-
      //     fired by the play hook — only when an ability explicitly
      //     triggers it from inside abilities.js, e.g. Gojo's Hollow
      //     Purple resolving after 2 combats).
      const ALLOWED = { hover: 1, play: 1, death: 1, ability: 1 };
      if (!ALLOWED[event]) return null;
      // Resolve file: card-specific first, else global default.
      const reg = this.CARD_SFX[name] || {};
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
        // Hover plays the full clip — no default maxDur cap. Per the
        // user's audio rule: "hover/music stay full length." Cards
        // that DO want a trim still set maxDur explicitly in their
        // CARD_SFX entry, but the global 8s ceiling that previously
        // truncated every un-tagged hover is gone.
        opts.fadeIn  = opts.fadeIn  ?? 1000;
        opts.fadeOut = opts.fadeOut ?? 2000;
        // Duck the menu music while a hover theme is live so the two
        // don't muddy each other. _stopHover restores the music level
        // when the cursor leaves the card.
        this.duckMusic();
      } else if (event === 'play' || event === 'ability') {
        // 5s cap per user spec — "force ghostface his whole sound bite
        // should play. So whenever a unique sound I put in for when
        // played for cards, increase the duration to just five
        // seconds." Cards with shorter unique audio just play in full
        // and silence; the cap only kicks in for clips longer than 5s.
        opts.maxDur  = opts.maxDur  ?? 5.0;
        opts.fadeIn  = opts.fadeIn  ?? 500;
        opts.fadeOut = opts.fadeOut ?? 1000;
        opts.category = event;  // 'play' or 'ability' — full marquee gain
      } else {
        opts.maxDur = opts.maxDur ?? 1.5;          // death — keep tight for chains
        opts.category = 'death';
      }
      return this._playSample(resolved.src, opts);
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
      const reg = this.TRICK_SFX[name] || {};
      const entry = reg[event] ?? this.DEFAULT_TRICK_SFX[event];
      const resolved = this._resolveSfxEntry(entry);
      if (!resolved) return null;
      const opts = { ...(resolved.opts || {}) };
      if (event === 'hover') {
        opts.hover = true;          // enables resume-from-pause in _playSample
        opts.category = 'hover';
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
      const a = this._currentHoverAudio;
      // 1-second fade-out on hover stop so leaving a card feels seamless
      // (user spec: "hard to tell there was an audio difference at all").
      // Longer than a typical fade so the tail blends into silence
      // instead of ducking audibly.
      if (a && !a.paused) this._fadeToPauseAtPosition(a, 1000);
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

    play(name) {
      if (!UI.settings || UI.settings.sfxVolume === 0) return;
      if (!this._init()) return;
      if (this._ctx.state === 'suspended') { try { this._ctx.resume(); } catch (e) {} }
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
        case 'hit':
          // Plasma / forcefield impact — sub thump body + mid pitch drop
          // + high-passed digital snap. Replaces the old square+noise
          // combo which sounded like an arcade punch.
          this._tone({ type: 'sine',     freq: 70,  freqEnd: 35,  dur: 0.14, gain: 0.20, release: 0.18 });
          this._tone({ type: 'triangle', freq: 380, freqEnd: 120, dur: 0.11, gain: 0.12, release: 0.14, delay: 0.005 });
          this._noise({ dur: 0.045, gain: 0.06, highpass: 3200, lowpass: 7000, delay: 0.002 });
          break;
        case 'hpHit':
          this._tone({ type: 'sawtooth', freq: 130, freqEnd: 55, dur: 0.12, gain: 0.2, release: 0.18 });
          this._noise({ dur: 0.14, gain: 0.15, highpass: 120, lowpass: 1600 });
          break;
        case 'select':
          this._tone({ type: 'sine', freq: 880, dur: 0.035, gain: 0.08, release: 0.05 });
          break;
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

  init() {
    this.loadSettings();
    this.initViewportMode();  // restore web/mobile preview from localStorage
    this._restoreStatsPrefs();  // restore stats panel filter / sort / view
    // Bind the audio module to UI so it can read settings.sfxVolume.
    if (this.audio && this.audio._bind) this.audio._bind(this);
    // Decorate any interactive surfaces that already exist in the
    // initial HTML (viewport toggle, settings cog, etc.) before the
    // first render() runs. Render-time application picks up the rest.
    if (this.applyTronFx) {
      // Defer one frame so DOM is fully parsed.
      setTimeout(() => this.applyTronFx(), 0);
    }
    this.board = document.getElementById('board');
    this.playerHand = document.getElementById('player-hand');
    this.aiHand = document.getElementById('ai-hand');
    this.playerTricks = document.getElementById('player-tricks');
    this.logEl = document.getElementById('game-log');
    this.draftEl = document.getElementById('draft-overlay');
    this.phaseBanner = document.getElementById('phase-banner');
    this.phaseBannerText = document.getElementById('phase-banner-text');
    this.tooltipEl = document.getElementById('kw-tooltip');
    // Cache stable overlay refs once at init — render() previously called
    // getElementById() ~9× per frame just to check visibility for the
    // top-left toggle. These overlays are persistent page elements that
    // never get torn down, so a one-time bind is safe and saves every
    // render from re-walking the DOM. Each ref is null-tolerant; render
    // already guards with truthy checks.
    this._encyclopediaOverlay  = document.getElementById('encyclopedia-overlay');
    this._matchHistoryOverlay  = document.getElementById('match-history-overlay');
    this._multiplayerOverlay   = document.getElementById('multiplayer-overlay');
    this._mainMenuOverlay      = document.getElementById('main-menu-overlay');
    this._modeSelectOverlay    = document.getElementById('mode-select-overlay');
    this._myDecksOverlay       = document.getElementById('my-decks-overlay');
    this._statsOverlay         = document.getElementById('stats-overlay');
    this._deckbuilderOverlay   = document.getElementById('deckbuilder-overlay');
    this._gameAreaEl           = document.getElementById('game-area');
    this.installKeywordTooltips();
    this.installKeyboardShortcuts();
    this.wireUndoButton();
    this.wireRoundSummary();
    this.installParallaxMenu();
    this.installDeckViewer();
    this.installHpDrainPulse();
    this.installMulliganAnim();
    this.installTrickBurst();
    this.installEnergySpendFlash();
    this.installHandTilt();
    this.installDeckPreview();
    this.installCustomCursor();
    this.installDeadPilePeek();
    this.installHoverMagnify();   // Hearthstone-style readable card pop-up
    //   on hover. Anchored to the source card (not cursor-chasing) so it
    //   stays still while the player reads it. The earlier flip-flop
    //   issue is fixed by the .magnifying CSS lock + visibility:hidden
    //   on the source for hand/trick cards (board/draft cards stay visible).
    this.installNavSounds();
    this.installCardSfx();
    this.installUiHoverSfx();
    this.installLongPressInspect();
    this.installDrawAnimation();
    this.installTronGridFx();
    this.installCameraParallax();   // Wave 3 #8 — mouse-driven camera pivot
    this.installPolishLayer();  // Tier 1-4 reactive + ambient FX
    this.installAudioHooks();   // Game event → audio cue mapping
    this.installSplashFx();     // Splash damage → shockwave + lunge
    this.installBoardCursorLight(); // Cursor-anchored board brightness boost
    this.installRoundSweep();   // Soft beam between rounds
    this.installTronFlare();    // Mouse-parallax + chromatic-on-hit + play afterimage + game-over glitch
    this.installAiActionHighlight(); // Pulse the lane the AI just played in
    this.installUndoFeedback();  // Toast + board flash on undo
    this.installAltArtPicker();  // Right-click any card → cycle art variant
    this.sfx.arm();
    this.sfx.setVolume(this.settings.sfxVolume ?? 0.55);
    // Flag menu music as "should be playing" on boot — we start on the main
    // menu, so the first user gesture in arm() will kick off playback.
    this.sfx.startMusic();
    this.render();
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
    // (each cut by the next), which sounds messy. User spec: "i want a
    // 1.5 second delay before playing the audio so it doesnt get messy
    // going over cards."
    const HOVER_SFX_DELAY_MS = 1500;
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
    document.addEventListener('mouseover', (e) => {
      const curr = getHoverTarget(e.target);
      if (!curr) return;
      const from = getHoverTarget(e.relatedTarget);
      if (from === curr) return; // still inside the same card; bubbled child
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
        const isCard = curr.hasAttribute('data-card-name');
        const audio = isCard ? this.sfx.playCardSfx(name, 'hover')
                             : this.sfx.playTrickSfx(name, 'hover');
        if (!audio) this.sfx.play('cardHover');
        this.sfx._currentHoverAudio = audio;
        // Track the source card NAME so _stopHover can keep the audio
        // running when the card is selected (mid-placement). User
        // spec: hover music continues through the click→place flow.
        this.sfx._currentHoverName = name;
        if (name) lastHoverByName[name] = Date.now();
      }, HOVER_SFX_DELAY_MS);
    });
    document.addEventListener('mouseout', (e) => {
      const curr = getHoverTarget(e.target);
      if (!curr) return;
      const to = getHoverTarget(e.relatedTarget);
      if (to === curr) return; // still inside the same card
      if (this.sfx._hoverDelayEl === curr) cancelPendingHover();
      // Force-stop only when moving to ANOTHER card (or other hover-
      // target like a draft pick) — that's a definitive "new hover
      // taking over." Mouse leaving to non-card areas (lanes, body,
      // overlays) goes through the selection guard so a clicked-and-
      // moved card keeps its hover music while the player is mid-
      // placement.
      if (this.sfx._currentHoverEl === curr) this.sfx._stopHover(!!to);
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
          this.sfx.playCardSfx(card.name, 'play', card);
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
          this.sfx._postPlayHoverLockUntil = Date.now() + 1600;
          this.sfx._postPlayHoverLockName = card.name;
          this.sfx._postPlayHoverLockNameUntil = Date.now() + 2400;
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

    // ---- Play (trick) — separate registry from cards ----
    if (Game.playTrick) {
      const origT = Game.playTrick.bind(Game);
      Game.playTrick = (owner, trick, ...rest) => {
        const r = origT(owner, trick, ...rest);
        if (r && trick && trick.name) this.sfx.playTrickSfx(trick.name, 'play');
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
        if (card && card.name) this.sfx.playCardSfx(card.name, 'play', card);
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
        // same combat don't pile up.
        let chosen = null;
        const currentDeathCost = this.sfx._laneDeathCost ?? -1;
        const winsLane = (deadCost > currentDeathCost)
          || (deadCost === currentDeathCost && Math.random() < 0.5);
        if (winsLane) {
          if (this.sfx._laneAudioEl) {
            try { this.sfx._laneAudioEl.volume = 0; this.sfx._laneAudioEl.pause(); } catch (e) {}
          }
          chosen = this.sfx.playCardSfx(deadName, 'death', card);
          this.sfx._laneDeathCost = deadCost;
        }

        // Record expected end-time so the lane advance can wait on it.
        if (chosen) {
          this.sfx._laneAudioEl = chosen;
          const cap = isDelegateKill ? 3.0 : 1.5;
          const fileDur = (!isNaN(chosen.duration) && chosen.duration > 0) ? chosen.duration : cap;
          const playMs = Math.min(cap, fileDur) * 1000;
          this.sfx._laneAudioEndsAt = performance.now() + playMs + 150; // +150 for fade tail
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
          const computed = remaining > 0 ? (remaining + 250) : baseMs;
          // Reset for next lane (the getter fires once per advance).
          this.sfx._laneAudioEl = null;
          this.sfx._laneAudioEndsAt = 0;
          this.sfx._laneDeathCost = null;
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
              const computed = remaining > 0 ? (remaining + 250) : base;
              this.sfx._laneAudioEl = null;
              this.sfx._laneAudioEndsAt = 0;
              this.sfx._laneDeathCost = null;
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

  // ===================== HOVER MAGNIFY =====================
  // Hearthstone-style readable card pop-up. After ~280ms of hovering any card
  // (hand, board, draft, trick), show a 1.6x clone anchored to that card.
  // ANCHORED, not cursor-chasing — the popup picks a stable side of the
  // source card (right by default, flips to left/above/below if it would
  // overflow) and stays there as long as the cursor is on the card. This
  // matches what professional card games (Hearthstone, MTG Arena, Marvel
  // Snap, LoR) all do — readers don't want the preview moving while they're
  // reading it. Compositor-cheap (transform + opacity only).
  installHoverMagnify() {
    if (this._hoverMagnifyInstalled) return;
    this._hoverMagnifyInstalled = true;
    const pop = document.getElementById('hover-magnify');
    if (!pop) return;
    const HOVER_DELAY = 280;       // ms before magnify reveals
    const ANCHOR_GAP  = 18;        // px between source card and magnified clone
    let timer = null;
    let lastEl = null;
    let fadedEl = null;
    let openEl = null;             // el currently being magnified (for SFX guard)
    // Card-source-anchored placement. Tries: right → left → above → below;
    // each fallback only if the previous would overflow the viewport. The
    // magnified clone is scaled via CSS `transform: scale(...)`, so its
    // visual bounding rect comes from getBoundingClientRect AFTER the
    // transform applies — that's what we read here.
    const position = (sourceEl) => {
      const src = sourceEl.getBoundingClientRect();
      const r   = pop.getBoundingClientRect();
      const margin = 8;
      const W = window.innerWidth;
      const H = window.innerHeight;
      // Vertical-centered candidates
      const cy = src.top + src.height / 2 - r.height / 2;
      const cyClamped = Math.max(margin, Math.min(H - r.height - margin, cy));
      // Horizontal-centered candidates
      const cx = src.left + src.width / 2 - r.width / 2;
      const cxClamped = Math.max(margin, Math.min(W - r.width - margin, cx));
      const candidates = [
        // Right of card, vertically centered
        { x: src.right + ANCHOR_GAP, y: cyClamped, fits: src.right + ANCHOR_GAP + r.width <= W - margin },
        // Left of card, vertically centered
        { x: src.left - ANCHOR_GAP - r.width, y: cyClamped, fits: src.left - ANCHOR_GAP - r.width >= margin },
        // Above card, horizontally centered
        { x: cxClamped, y: src.top - ANCHOR_GAP - r.height, fits: src.top - ANCHOR_GAP - r.height >= margin },
        // Below card, horizontally centered
        { x: cxClamped, y: src.bottom + ANCHOR_GAP, fits: src.bottom + ANCHOR_GAP + r.height <= H - margin },
      ];
      const pick = candidates.find(c => c.fits) || candidates[0];
      pop.style.left = Math.round(pick.x) + 'px';
      pop.style.top  = Math.round(pick.y) + 'px';
    };
    const show = (el) => {
      // Hand cards AND board cards (ally/enemy): NO clone popup.
      // Marvel-Snap-style in-place enlarge — the card itself grows on
      // :hover via the CSS rules at `.hand-card-wrapper:hover .card.hand-card`
      // (hand) and `.card.ally-card:hover, .card.enemy-card:hover` (board).
      // Keeping the popup meant TWO of the same card on screen and the
      // .magnifying class lock killed the 3D tilt mid-hover. User spec:
      // "I would love it so you don't have, like, two cards. Just the
      // card that you select gets bigger... still has a geometry
      // [tilt] that you can do, easier to click on bullseye, on jump,
      // on all the keywords... like Marvel Snap." Then: "this should
      // also happen to enemy cards on board." Draft/trick cards still
      // get the clone popup — different layouts, popup is fine there.
      if (el.classList.contains('hand-card') ||
          el.classList.contains('ally-card') ||
          el.classList.contains('enemy-card')) {
        openEl = el;
        return;
      }
      // Clone the card with the same interior. Strip interactive +
      // animation classes so the magnified clone stays perfectly still
      // (user flagged a pulse while hovering — traced to lingering
      // card-enter / selected / status animations carried from origin).
      const clone = el.cloneNode(true);
      clone.classList.remove(
        'playable', 'unplayable', 'selected', 'card-draw-in', 'card-enter',
        'card-exit', 'card-flying', 'hit-flash', 'armor-burst', 'target-highlight',
        'jump-ready', 'afford', 'unafford', 'hand-deal-in', 'stat-changed'
      );
      // Kill any CSS animation inherited from the original
      clone.style.animation = 'none';
      clone.style.pointerEvents = 'none';
      clone.style.margin = '0';
      pop.innerHTML = '';
      pop.appendChild(clone);
      pop.style.display = 'block';
      openEl = el;
      // KEEP THE SOURCE VISIBLE. Earlier we hid hand/trick sources via
      // visibility:hidden so the magnifier read as "the" card, but
      // visibility:hidden also disables :hover on the source — the
      // cursor's effective hover target slides through to whatever's
      // beneath (the next hand card, or the hand row background),
      // which fires a fresh mouseover → hover audio retriggers + CSS
      // border glow flickers. User report: "its highliting the card
      // over and over while the curser is over it, basciacllly its
      // ttapping the card... maybe its the sound it keeos palying
      // over and over agin." User spec: "in the draft its perfect
      // hover over cards just make the board cards act like that."
      // Draft cards never get hidden; we now do the same for hand
      // and trick cards. Magnifier reads as a "preview" beside the
      // source, source's :hover stays true, no flicker, no retrigger.
      // .magnifying class still applied so the wrapper's hover-lift
      // transforms stay locked (defense-in-depth against future bounce).
      if (el.classList.contains('hand-card') || el.classList.contains('trick-card')) {
        const wrap = el.closest && el.closest('.hand-card-wrapper');
        if (wrap) { wrap.classList.add('magnifying'); fadedEl = el; }
        if (el.classList.contains('trick-card')) { el.classList.add('magnifying'); fadedEl = el; }
      }
      // Two-pass position — first frame sizes the clone, second frame
      // measures and places. requestAnimationFrame avoids reading
      // getBoundingClientRect mid-layout.
      requestAnimationFrame(() => position(el));
    };
    const hide = () => {
      if (fadedEl) {
        // Source no longer gets visibility:hidden, but we still strip
        // the .magnifying class lock from the wrapper (and trick card)
        // so its :hover transforms can re-engage on the NEXT hover.
        const wrap = fadedEl.closest && fadedEl.closest('.hand-card-wrapper');
        if (wrap) wrap.classList.remove('magnifying');
        if (fadedEl.classList) fadedEl.classList.remove('magnifying');
        fadedEl = null;
      }
      // Belt-and-suspenders: clear `magnifying` from any element that
      // somehow still has it (e.g. DOM rebuilt while magnifying).
      document.querySelectorAll('.hand-card-wrapper.magnifying, .trick-card.magnifying')
        .forEach(w => w.classList.remove('magnifying'));
      pop.style.display = 'none';
      pop.innerHTML = '';
      lastEl = null;
      openEl = null;
    };
    document.addEventListener('mouseover', (e) => {
      const el = e.target.closest('.hand-card-wrapper .card, .draft-card, .trick-card');
      if (!el || el === lastEl) return;
      // If a different card was magnified, hide instantly so the next
      // one can take its place — no double-popups.
      if (openEl && openEl !== el && pop.style.display === 'block') hide();
      lastEl = el;
      clearTimeout(timer);
      timer = setTimeout(() => { show(el); }, HOVER_DELAY);
    });
    document.addEventListener('mouseout', (e) => {
      const leaving = e.target.closest('.hand-card-wrapper .card, .draft-card, .trick-card');
      if (!leaving) return;
      // Ignore moves that stay inside the same card (mouseout bubbles
      // on every child-element transition).
      const to = e.relatedTarget;
      if (to && leaving.contains(to)) return;
      // Also suppress the flicker when cursor passes from source onto
      // the magnify popup — the popup is pointer-events:none but the
      // browser still resolves relatedTarget for the visual layer.
      if (to && to.closest && to.closest('#hover-magnify')) return;
      clearTimeout(timer);
      if (pop.style.display === 'block') hide();
      if (fadedEl) {
        fadedEl.style.visibility = '';
        const w = fadedEl.closest && fadedEl.closest('.hand-card-wrapper');
        if (w) w.classList.remove('magnifying');
        if (fadedEl.classList) fadedEl.classList.remove('magnifying');
        fadedEl = null;
      }
      lastEl = null;
    });
    // Any click force-hides the popup. Covers the common stuck-popup case:
    // user hovers a hand card (triggers magnify), then clicks to play
    // without moving the cursor. The card gets destroyed by UI.render(),
    // so the next mouseout fires with e.target.closest(...) === null and
    // the handler above exits early — leaving the popup parked.
    document.addEventListener('click', () => {
      clearTimeout(timer);
      if (pop.style.display === 'block') hide();
    }, true);
    // Hide on scroll/resize — the anchored position becomes stale when
    // the layout shifts. Cheap and avoids ghost popups.
    window.addEventListener('scroll', () => {
      if (pop.style.display === 'block') hide();
    }, true);
    window.addEventListener('resize', () => {
      if (pop.style.display === 'block') hide();
    });
    // Expose a teardown hook the main render loop can call. User report
    // May-1: "hover magnify blips in and out during AI turns." Root
    // cause: render() called this hook unconditionally at the start of
    // every render (ui.js:3195), which closed the popup → 280ms
    // HOVER_DELAY before the user's continued hover re-opened it. With
    // AI playing every ~450ms, that's a constant blip cycle.
    //
    // Fix: only force-close if the SOURCE card the popup is cloning
    // has actually been removed from the DOM. With the transplant fix
    // in makeCardElCached, played cards keep their parent .card
    // identity — so an open magnify of a still-on-board card no longer
    // needs the periodic teardown. Genuine removals (card destroyed,
    // moved to discard pile, hand reshuffled) DO still trigger the
    // hide path because openEl will be detached.
    this._hideHoverMagnify = () => {
      // Source still in DOM? Leave the popup as-is; the user's hover
      // is still valid. mouseout will hide it naturally when they
      // move off the card.
      if (openEl && document.body.contains(openEl)) return;
      // Source gone (or never opened) — sweep up.
      if (fadedEl && !document.body.contains(fadedEl)) {
        fadedEl = null;
      }
      clearTimeout(timer);
      if (pop.style.display === 'block') hide();
      lastEl = null;
      openEl = null;
    };
  },

  // ===================== KEYWORD TOOLTIPS =====================
  installKeywordTooltips() {
    if (!this.tooltipEl) return;
    this._tooltipPinned = false;
    const render = (kw) => {
      const pinHint = this._tooltipPinned
        ? '<span class="kw-tip-pin">📌 pinned — click anywhere to unpin</span>'
        : '<span class="kw-tip-pin-hint">click to pin</span>';
      // CARD-REFERENCE tooltip — when a body-text keyword references an
      // actual trick/card (e.g. Batman's "throw Batarangs"), render the
      // referenced card itself in the tooltip body. Lets the player
      // hover over the keyword and see the full Batarangs card without
      // needing to find it in their hand or remember its description.
      // User spec: "you can hover over the highlighted word and the
      // card will pop up over so you can see it."
      if (kw && kw.indexOf('card:') === 0) {
        const cardName = kw.slice(5);
        const trickDef = (typeof TRICK_DEFS !== 'undefined') ? TRICK_DEFS.find(t => t.name === cardName) : null;
        const cardDef  = !trickDef && (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS.find(d => d.name === cardName) : null;
        const def = trickDef || cardDef;
        if (!def) return false;
        // Render the card. For tricks, mirror the in-hand trick chrome;
        // for cards, mirror the in-hand card chrome.
        const isTrick = !!trickDef;
        const cost = def.cost != null ? def.cost : '';
        const ab = def.abilities && def.abilities.length
          ? `<div class="card-abilities status-badges">${this.formatAbilityBadges(def.abilities)}</div>`
          : '';
        if (isTrick) {
          const rarity = this.getTrickRarityStrip(cost || 0);
          this.tooltipEl.innerHTML =
            `<div class="kw-tip-card-pop">` +
              `<div class="trick-card kw-tip-trick-render">` +
                `<span class="trick-cost">${cost}</span>` +
                rarity +
                `<div class="trick-name">${def.name}</div>` +
                ab +
                `<div class="trick-desc">${this.formatDesc(def.desc || '')}</div>` +
              `</div>` +
            `</div>` +
            pinHint;
        } else {
          this.tooltipEl.innerHTML =
            `<div class="kw-tip-card-pop">` +
              `<div class="card hand-card ${this.getCostClass(cost)} kw-tip-card-render" data-card-name="${def.name}">` +
                `<span class="card-cost">${cost}</span>` +
                `<div class="card-name-banner"><div class="card-name">${def.name}</div></div>` +
                ab +
                `<div class="card-desc">${this.formatDesc(def.desc || '')}</div>` +
                (def.attack != null && def.health != null
                  ? `<span class="stat-circle stat-atk">${def.attack}</span><span class="stat-circle stat-hp">${def.health}</span>`
                  : '') +
              `</div>` +
            `</div>` +
            pinHint;
        }
        return true;
      }
      const data = this.KEYWORD_DATA[kw];
      if (!data) return false;
      this.tooltipEl.innerHTML =
        `<div class="kw-tip-name" style="color:${data.color}">${kw}</div>` +
        `<div class="kw-tip-body">${data.tip}</div>` +
        pinHint;
      return true;
    };
    const show = (e) => {
      if (!this.settings.tooltips) return;
      if (this._tooltipPinned) return; // pinned tooltip holds; hover doesn't interrupt
      const el = e.target.closest('[data-kw]');
      if (!el) return;
      if (!render(el.getAttribute('data-kw'))) return;
      this.tooltipEl.style.display = 'block';
      this.tooltipEl.classList.remove('kw-tooltip-pinned');
      this.moveTooltip(e);
    };
    const move = (e) => {
      if (this.tooltipEl.style.display === 'none') return;
      if (this._tooltipPinned) return; // pinned: don't chase cursor
      this.moveTooltip(e);
    };
    const hide = (e) => {
      if (this._tooltipPinned) return;
      if (e.target.closest && e.target.closest('[data-kw]')) return;
      this.tooltipEl.style.display = 'none';
    };
    const click = (e) => {
      if (!this.settings.tooltips) return;
      const onKw = e.target.closest && e.target.closest('[data-kw]');
      const onTooltip = e.target === this.tooltipEl || (e.target.closest && e.target.closest('.kw-tooltip'));
      if (onKw) {
        // Toggle pin when a keyword pill is clicked. If already pinned on
        // a different keyword, swap to the new one and stay pinned.
        const kw = onKw.getAttribute('data-kw');
        if (this._tooltipPinned && this.tooltipEl.dataset.currentKw === kw) {
          this._tooltipPinned = false;
          this.tooltipEl.style.display = 'none';
          this.tooltipEl.classList.remove('kw-tooltip-pinned');
        } else {
          this._tooltipPinned = true;
          this.tooltipEl.dataset.currentKw = kw;
          render(kw);
          this.tooltipEl.style.display = 'block';
          this.tooltipEl.classList.add('kw-tooltip-pinned');
          this.moveTooltip(e);
        }
        e.stopPropagation();
      } else if (this._tooltipPinned && !onTooltip) {
        // Click anywhere off the tooltip/pills → unpin.
        this._tooltipPinned = false;
        this.tooltipEl.style.display = 'none';
        this.tooltipEl.classList.remove('kw-tooltip-pinned');
      }
    };
    document.addEventListener('mouseover', show);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseout', hide);
    document.addEventListener('click', click, true);
  },
  moveTooltip(e) {
    const t = this.tooltipEl;
    const pad = 14;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    const r = t.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
    t.style.left = x + 'px';
    t.style.top  = y + 'px';
  },

  // Undo button already gets wired by renderButtons on each render — no init work needed.
  wireUndoButton() { /* intentionally empty */ },

  // ===================== KEYBOARD SHORTCUTS =====================
  installKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === 'Escape') {
        // Esc also closes the cheat sheet if it's open.
        const cs = document.getElementById('cheat-sheet-overlay');
        if (cs && cs.style.display === 'flex') { this.closeCheatSheet(); return; }
        // Esc — universal toggle for any peekable modal (round recap,
        // trick prompts, game over). If a modal is currently peeked,
        // bring it back; otherwise peek whichever overlay is showing.
        if (this.hasPeekedModal()) { this.restorePeekedModal(); return; }
        const goOverlay = document.getElementById('game-over-overlay');
        if (goOverlay && goOverlay.style.display === 'flex') {
          this.peekModal('#game-over-overlay', 'Show Result'); return;
        }
        const recap = document.getElementById('round-summary-overlay');
        if (recap && recap.style.display === 'flex') {
          this.peekModal('#round-summary-overlay', 'Show Round Recap'); return;
        }
        // If a floating prompt is open, peek it. Walk all .floating-prompt
        // elements that are currently visible (only one is open at a time
        // by design but the loop is robust).
        const fpOpen = Array.from(document.querySelectorAll('.floating-prompt'))
          .find(el => el.style.display !== 'none' && el.offsetParent !== null);
        if (fpOpen) {
          const label = fpOpen.dataset.peekLabel || 'Show Prompt';
          this.peekModal(fpOpen, label); return;
        }
        const s = Game && Game.state;
        if (s && s.selectedCard) { s.selectedCard = null; UI.render(); }
        else if (s && s.selectedTrick) { s.selectedTrick = null; UI.render(); }
      }
      if ((e.key === 'u' || e.key === 'U') && !e.ctrlKey && !e.metaKey) {
        const btn = document.getElementById('btn-undo');
        if (btn && btn.style.display !== 'none') btn.click();
      }
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this.toggleCheatSheet();
      }
    });
  },

  toggleCheatSheet() {
    const ov = document.getElementById('cheat-sheet-overlay');
    if (!ov) return;
    if (ov.style.display === 'flex') this.closeCheatSheet();
    else this.openCheatSheet();
  },
  openCheatSheet() {
    const ov = document.getElementById('cheat-sheet-overlay');
    if (!ov) return;
    ov.style.display = 'flex';
    // Auto-focus the search box so keyboard users can type immediately.
    // Defer so the display-flip paints before we move focus.
    setTimeout(() => {
      const input = document.getElementById('cheat-sheet-search');
      if (input) { input.value = ''; this.filterCheatSheet(''); input.focus(); }
    }, 20);
  },
  closeCheatSheet() {
    const ov = document.getElementById('cheat-sheet-overlay');
    if (ov) ov.style.display = 'none';
  },
  // Live filter for the cheat-sheet keywords + keyboard shortcuts.
  // Hides any <dt>/<dd>/<li> whose combined text doesn't contain the
  // query (case-insensitive substring). Also hides the <h3> headers
  // whose following list is fully empty so the panel doesn't feel
  // cluttered with unreachable sections.
  filterCheatSheet(query) {
    const q = (query || '').trim().toLowerCase();
    const ov = document.getElementById('cheat-sheet-overlay');
    if (!ov) return;
    // Keyword list: <ul class="cheat-sheet-list"> ... each <li>.
    ov.querySelectorAll('.cheat-sheet-list > li').forEach(li => {
      const txt = (li.textContent || '').toLowerCase();
      li.style.display = (!q || txt.includes(q)) ? '' : 'none';
    });
    // Keyboard <dt>/<dd> pairs — <dt> + its following <dd> form a row;
    // hide both when no match on either.
    const kbd = ov.querySelector('.cheat-sheet-kbd');
    if (kbd) {
      const dts = Array.from(kbd.querySelectorAll('dt'));
      dts.forEach(dt => {
        const dd = dt.nextElementSibling;
        const combined = ((dt.textContent || '') + ' ' + (dd ? dd.textContent || '' : '')).toLowerCase();
        const show = !q || combined.includes(q);
        dt.style.display = show ? '' : 'none';
        if (dd) dd.style.display = show ? '' : 'none';
      });
    }
    // Hide empty headers (all list items filtered out) for cleanliness.
    ov.querySelectorAll('.cheat-sheet-col h3').forEach(h => {
      const next = h.nextElementSibling;
      if (!next) return;
      const items = next.querySelectorAll('li, dt');
      const anyVisible = Array.from(items).some(el => el.style.display !== 'none');
      h.style.display = (!q || anyVisible) ? '' : 'none';
    });
  },

  // ===================== END-OF-ROUND SUMMARY =====================
  wireRoundSummary() {
    const btn = document.getElementById('round-summary-continue');
    if (btn) btn.addEventListener('click', () => {
      const overlay = document.getElementById('round-summary-overlay');
      if (overlay) overlay.style.display = 'none';
      // If the recap was being peeked when Continue fired (possible
      // after a restore), make sure the pill goes away too.
      if (this._peekedModal === overlay) {
        this._peekedModal = null;
        const pill = document.getElementById('peek-restore');
        if (pill) pill.style.display = 'none';
      }
      if (this._summaryResolve) { const r = this._summaryResolve; this._summaryResolve = null; r(); }
    });
  },
  showRoundSummary(data) {
    if (!this.settings.roundRecap) return Promise.resolve();
    // Defensive: clear any stale peek state from prior modals so the
    // floating restore pill never lingers into a fresh recap.
    this._peekedModal = null;
    const _peekPill = document.getElementById('peek-restore');
    if (_peekPill) _peekPill.style.display = 'none';
    // Skip recap when truly nothing happened (no damage, no kills, no tricks).
    const nothingHappened = (data.playerDamageDealt || 0) === 0
      && (data.playerDamageTaken || 0) === 0
      && (!data.playerKills || !data.playerKills.length)
      && (!data.aiKills || !data.aiKills.length)
      && (!data.playerTricks || !data.playerTricks.length)
      && (!data.aiTricks || !data.aiTricks.length);
    if (nothingHappened) return Promise.resolve();
    const overlay = document.getElementById('round-summary-overlay');
    if (!overlay) return Promise.resolve();
    const body = document.getElementById('round-summary-body');
    const title = document.getElementById('round-summary-title');
    title.textContent = `Round ${data.round} Recap`;
    const rows = [];
    const mk = (label, val, cls) => `<div class="recap-row"><span class="recap-label">${label}</span><span class="recap-val ${cls||''}">${val}</span></div>`;
    // HP rows unchanged — your HP blue, enemy HP red
    rows.push(mk('Your HP',     `${data.playerHp} / ${data.playerMaxHp}`, 'recap-ally'));
    rows.push(mk('Enemy HP',    `${data.aiHp} / ${data.aiMaxHp}`, 'recap-enemy'));
    // Damage you dealt (your output) → blue ally color
    // Damage you took (incoming) → red
    rows.push(mk('Damage you dealt',  data.playerDamageDealt, 'recap-ally'));
    rows.push(mk('Damage you took',   data.playerDamageTaken, 'recap-enemy'));
    // Enemies destroyed = RED (they were the enemies)
    // Allies lost = BLUE (they were yours)
    if (data.playerKills && data.playerKills.length) {
      rows.push(mk('Enemies you destroyed', data.playerKills.join(', '), 'recap-enemy'));
    }
    if (data.aiKills && data.aiKills.length) {
      rows.push(mk('Allies you lost', data.aiKills.join(', '), 'recap-ally'));
    }
    // Tricks used — your tricks blue, AI's tricks red
    if (data.playerTricks && data.playerTricks.length) {
      rows.push(mk('Tricks you used', data.playerTricks.join(', '), 'recap-ally'));
    }
    if (data.aiTricks && data.aiTricks.length) {
      rows.push(mk('Tricks AI used', data.aiTricks.join(', '), 'recap-enemy'));
    }
    // Build a visual timeline strip — a horizontal row of event pills
    // showing the round's notable moments (plays, tricks, kills). Each
    // pill is color-coded by source side + event type so the player
    // reads the round's flow at a glance.
    const timelineEvents = [];
    (data.playerTricks || []).forEach(n => timelineEvents.push({ type: 'trick', side: 'player', name: n }));
    (data.aiTricks     || []).forEach(n => timelineEvents.push({ type: 'trick', side: 'ai',     name: n }));
    (data.playerKills  || []).forEach(n => timelineEvents.push({ type: 'kill',  side: 'player', name: n })); // player killed enemy
    (data.aiKills      || []).forEach(n => timelineEvents.push({ type: 'kill',  side: 'ai',     name: n })); // AI killed ally
    const iconFor = {
      trick:  '✦',
      kill:   '☠',
      play:   '▲',
      damage: '◈'
    };
    const sideCls = (s) => s === 'player' ? 'tl-player' : 'tl-ai';
    // Look up each pill's cost so we can tag it with a `cost-N` class
    // and have the recap timeline pick up the same rarity-tier neon
    // styling the rest of the game uses (green common / cyan uncommon
    // / silver rare / gold legendary). Falls back to 0 if the name
    // can't be resolved (defensive — sim mode mocks may pass bare
    // strings without a registry hit).
    const lookupCost = (name, type) => {
      try {
        if (type === 'trick' && typeof TRICK_DEFS !== 'undefined') {
          const t = TRICK_DEFS.find(d => d.name === name);
          if (t) return t.cost || 0;
        }
        if (typeof CARD_DEFS !== 'undefined') {
          const c = CARD_DEFS.find(d => d.name === name);
          if (c) return c.cost || 0;
        }
      } catch (e) {}
      return 0;
    };
    const pillHtml = timelineEvents.length
      ? `<div class="recap-timeline"><div class="recap-timeline-label">Timeline</div><div class="recap-timeline-rail">${
          timelineEvents.map(ev => {
            const lbl = ev.type === 'kill'
              ? (ev.side === 'player' ? `destroyed ${ev.name}` : `${ev.name} lost`)
              : `${ev.name}`;
            const cost = lookupCost(ev.name, ev.type);
            const costCls = 'cost-' + Math.min(10, Math.max(0, cost));
            return `<span class="recap-tl-pill recap-tl-${ev.type} ${sideCls(ev.side)} ${costCls}" title="${lbl}">`
              + `<span class="recap-tl-icon">${iconFor[ev.type] || '•'}</span>`
              + `<span class="recap-tl-text">${ev.name}</span></span>`;
          }).join('')
        }</div></div>`
      : '';
    body.innerHTML = pillHtml + rows.join('');
    overlay.style.display = 'flex';
    return new Promise(res => { this._summaryResolve = res; });
  },

  // ===================== PHASE BANNER =====================

  showPhaseBanner(text, opts) {
    if (!this.phaseBanner) return;
    // Typewriter letter-stagger — each char gets its own span with an
    // incremental animation-delay. Spaces render as .space to keep the
    // visual gap without making the span zero-width.
    const letters = [...text].map((ch, i) => {
      const cls = ch === ' ' ? 'letter space' : 'letter';
      const safe = ch === ' ' ? '&nbsp;' : (ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch);
      return `<span class="${cls}" style="animation-delay:${i * 35}ms">${safe}</span>`;
    }).join('');
    this.phaseBannerText.innerHTML = letters;
    this.phaseBannerText.classList.toggle('phase-combat', /combat/i.test(text));
    this.phaseBanner.classList.add('active');
    clearTimeout(this._bannerTimeout);
    // Banners carrying per-event info (Gorr devour, etc.) need more
    // read time than a generic phase transition. Default 1800ms;
    // long banners (>40 chars or explicit opts.duration) hold longer
    // so the player can actually read them.
    let duration = 1800;
    if (opts && opts.duration) duration = opts.duration;
    else if (text.length > 40) duration = Math.min(5000, 1800 + (text.length - 40) * 55);
    this._bannerTimeout = setTimeout(() => {
      this.phaseBanner.classList.remove('active');
    }, duration);
  },

  checkPhaseTransition(s) {
    if (!s || !s.phase) return;
    // Keep body turn-ownership class in sync every render so HUD tint matches phase.
    document.body.classList.remove('turn-player', 'turn-ai', 'turn-combat');
    if (s.phase && s.phase.startsWith('player')) document.body.classList.add('turn-player');
    else if (s.phase && s.phase.startsWith('ai')) document.body.classList.add('turn-ai');
    else if (s.phase === 'combat') document.body.classList.add('turn-combat');
    // (AAA) Combat anticipation pulse — fires the radial wash + ring
    // animation + sub-bass thump exactly once per combat phase entry.
    // _lastCombatPhase tracks the last seen phase so we don't re-fire
    // while sitting in combat across multiple renders. Skipped during
    // game-over / draft / menu phases where it'd be out of place.
    if (s.phase === 'combat' && this._lastCombatPhase !== 'combat' && !s.gameOver) {
      document.body.classList.remove('combat-anticipate');
      void document.body.offsetWidth;
      document.body.classList.add('combat-anticipate');
      if (this._combatAnticipateTimer) clearTimeout(this._combatAnticipateTimer);
      this._combatAnticipateTimer = setTimeout(() => {
        document.body.classList.remove('combat-anticipate');
      }, 360);
      // Sub-bass thump on the same beat. Bail clean if audio not init.
      try {
        if (this.sfx && this.sfx.combatAnticipateThump) {
          this.sfx.combatAnticipateThump();
        }
      } catch (e) {}
    }
    this._lastCombatPhase = s.phase;
    // Round-first ownership — who had initiative this round. Tints the round
    // badge and the HUD pill outline so the pill colour reflects the round's
    // opener, while the phase label (.hud-phase) keeps showing the ACTIVE turn.
    document.body.classList.remove('round-first-player', 'round-first-ai');
    if (s.firstPlayer === 'player') document.body.classList.add('round-first-player');
    else if (s.firstPlayer === 'ai') document.body.classList.add('round-first-ai');
    // Round-start current sweep — fire once per round by watching s.round.
    // Adds body.round-transition for ~1s; CSS animates a vertical sweep
    // across .board-section::before using the theme accent.
    if (this._lastRound !== s.round && s.round >= 1 && !s.phase.startsWith('draft')) {
      this._lastRound = s.round;
      document.body.classList.add('round-transition');
      clearTimeout(this._roundTransitionTimer);
      this._roundTransitionTimer = setTimeout(() => document.body.classList.remove('round-transition'), 1000);
      // Polish D — CRT boot-up scan: the bright horizontal scan line
      // sweeps top→bottom across the arena once at round start. Reinforces
      // "you're watching this on a Tron broadcast monitor." Class self-
      // removes after the 1.2s animation; reflowing the node before re-
      // adding lets it replay each round.
      const bsEl = document.querySelector('.board-section');
      if (bsEl) {
        bsEl.classList.remove('boot-scan');
        void bsEl.offsetWidth;
        bsEl.classList.add('boot-scan');
        setTimeout(() => bsEl.classList.remove('boot-scan'), 1300);
      }
      // (e) Round badge tick — flip the round number in place.
      const rn = document.getElementById('round-num');
      if (rn) {
        rn.classList.remove('round-tick');
        void rn.offsetWidth;
        rn.classList.add('round-tick');
        setTimeout(() => rn.classList.remove('round-tick'), 560);
      }
      // (N) Big centered ROUND N banner
      this.showRoundBanner(s.round);
      // (F) Currency orb spin
      this.spinEnergyOrbs();
      // (AAA) Round-tick — fires the centerline gradient sweep
      this.fireRoundTick();
    }
    // Particle systems — menu particles while the main menu is visible,
    // game particles otherwise (inside a match). Draft overlay has its
    // own aesthetic; skip both for draft phases.
    const phase = s.phase || '';
    const mmOpen = document.getElementById('main-menu-overlay');
    const inMenu = mmOpen && mmOpen.style.display !== 'none';
    const inDraft = phase.startsWith('draft');
    if (inMenu) { this.startMenuParticles(); this.stopGameParticles(); }
    else if (!inDraft && phase !== 'main-menu') { this.stopMenuParticles(); this.startGameParticles(); }
    else { this.stopMenuParticles(); this.stopGameParticles(); }
    // Hand deal-in stagger — only on first transition from draft into
    // gameplay. Subsequent hand re-renders skip the flourish.
    if (this._lastPhase && this._lastPhase.startsWith('draft') && !s.phase.startsWith('draft')) {
      this._pendingHandDealAnim = true;
      setTimeout(() => { this._pendingHandDealAnim = false; }, 100);
    }
    if (s.phase === this._lastPhase) return;
    const prev = this._lastPhase;
    this._lastPhase = s.phase;
    // Don't show banner on initial load or draft
    if (!prev) return;
    if (s.phase.startsWith('draft')) return;

    const bannerMap = {
      'player-cards': 'Your Turn — Cards',
      'player-tricks': 'Your Turn — Tricks',
      'player-cards-tricks': 'Your Turn — Cards & Tricks',
      'ai-cards': 'Enemy Turn — Cards',
      'ai-tricks': 'Enemy Turn — Tricks',
      'ai-cards-tricks': 'Enemy Turn — Cards & Tricks',
      'combat': 'Combat Phase',
      'draw': 'Draw Phase'
    };
    const text = bannerMap[s.phase];
    if (text) this.showPhaseBanner(text);
  },

  // ===================== ENERGY ORBS =====================

  renderEnergyOrbs(containerId, current, max) {
    const el = document.getElementById(containerId);
    if (!el) return;
    // Trigger gain pulse if energy increased since last render
    this._prevEnergy = this._prevEnergy || {};
    const prev = this._prevEnergy[containerId];
    const gained = prev !== undefined && current > prev;
    this._prevEnergy[containerId] = current;
    // PRO FIX: never replace the .energy-text node on re-render.
    // The previous innerHTML rebuild destroyed the element on every
    // single render, which restarted any infinite animations on it.
    // By updating textContent in place, the same DOM node persists.
    let span = el.querySelector('.energy-text');
    if (!span) {
      // First paint — create the element once. All subsequent calls
      // just patch its textContent + toggle the boost class.
      span = document.createElement('span');
      span.className = 'energy-text';
      el.appendChild(span);
    }
    if (span.textContent !== String(current)) {
      span.textContent = String(current);
    }
    if (gained) {
      // Re-add via remove + force-reflow + add so the boost flash
      // retriggers on each gain even on the same node.
      span.classList.remove('energy-boost');
      void span.offsetWidth;
      span.classList.add('energy-boost');
      setTimeout(() => span.classList.remove('energy-boost'), 620);
    }
    // (REMOVED per user feedback) The hex pip row that lived to the
    // left of the diamond is gone — the integer alone is the cleaner
    // read. Belt-and-suspenders: tear down any leftover .energy-pips
    // node so cached DOM from the previous build doesn't ghost.
    const stalePips = el.querySelector('.energy-pips');
    if (stalePips) stalePips.remove();
  },

  // (REMOVED) HP Nexus tier — the hex frame around the HP integer
  // was removed per user feedback ("don't like the little sticker
  // behind the health number"). Function is kept as a no-op so any
  // stray callers don't blow up. Also strips any leftover
  // data-hp-tier attribute from cached DOM.
  applyHpNexusTier() {
    document.querySelectorAll('.health-text[data-hp-tier]').forEach(el => {
      el.removeAttribute('data-hp-tier');
    });
  },

  // (AAA) ROUND-TICK — fires a 700ms body class .round-tick on
  // round start. The CSS uses it to drive the centerline gradient
  // sweep. JS handles the trigger; the existing _lastRound watch
  // in checkPhaseTransition is the natural firing point.
  fireRoundTick() {
    document.body.classList.remove('round-tick');
    void document.body.offsetWidth;
    document.body.classList.add('round-tick');
    clearTimeout(this._roundTickTimer);
    this._roundTickTimer = setTimeout(() => {
      document.body.classList.remove('round-tick');
    }, 720);
  },

  // (AAA) HAND FAN — set --hand-i and --hand-n on each hand-card
  // wrapper so the CSS fan formula can lay them out in a subtle
  // arc. Called after renderHand each tick.
  applyHandFanVars() {
    const wrappers = document.querySelectorAll('.player-hand-section .hand-card-wrapper');
    const n = wrappers.length;
    wrappers.forEach((w, i) => {
      w.style.setProperty('--hand-i', i);
      w.style.setProperty('--hand-n', n);
    });
  },

  // ===================== MVP RANKING =====================
  // Single source of truth for the per-card MVP score. Used by the live
  // star-pip on every card, by computeMvpRanks() below, and by the
  // end-of-game victory-screen MVP row — all three must agree.
  mvpScoreOf(card) {
    if (!card) return 0;
    return (card.statsHealthbarDamage || 0)
         + (card.statsEnemyDamage     || 0)
         + (card.statsDamageAbsorbed  || 0)
         + (card.statsEnergyGenerated || 0)
         + (card.statsKills           || 0) * 5;
  },
  // Rank every card (board + dead pile) per side and return the top two
  // card IDs so makeCardEl can identify MVP #1 (gold star) and MVP #2
  // (silver star) in O(1) at render time.
  computeMvpRanks() {
    const s = Game.state;
    const ranks = { player: { firstId: null, secondId: null }, ai: { firstId: null, secondId: null } };
    if (!s) return ranks;
    // Bail when not in a combat — Roguelite map / boon / rewards screens
    // null out s.lanes; the dashboard isn't visible there anyway.
    if (!s.lanes || !Array.isArray(s.lanes)) return ranks;
    ['player', 'ai'].forEach(side => {
      const pool = [];
      for (let i = 0; i < Game.LANE_COUNT; i++) {
        const lane = s.lanes[i];
        if (!lane) continue;
        const c = lane[side];
        if (c) pool.push(c);
      }
      (s[side] && s[side].deadPile || []).forEach(c => pool.push(c));
      pool.sort((a, b) => this.mvpScoreOf(b) - this.mvpScoreOf(a));
      // Only record cards with positive score — a tied-at-zero pool
      // shouldn't crown anyone.
      if (pool[0] && this.mvpScoreOf(pool[0]) > 0) ranks[side].firstId = pool[0].id;
      if (pool[1] && this.mvpScoreOf(pool[1]) > 0) ranks[side].secondId = pool[1].id;
    });
    return ranks;
  },

  // ===================== MAIN RENDER =====================

  // ---- Render coalescing (perf Tier-A #1) -----------------------
  // Many engine paths fire `UI.render()` synchronously several times
  // in a single tick (combat resolution, prompt clears, hand updates).
  // This wrapper collapses repeated calls in the same frame into one
  // rAF-flushed pass. Cuts render-pass count ~5-10× on combat turns.
  //
  // `renderSync()` is the escape hatch — call it when downstream code
  // immediately reads layout (offsetHeight, getBoundingClientRect)
  // and needs the DOM to be current.
  render() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this._renderImpl();
      if (window.PerfOverlay && window.PerfOverlay.tickRender) {
        window.PerfOverlay.tickRender();
      }
    });
  },
  renderSync() {
    this._renderQueued = false;
    this._renderImpl();
    if (window.PerfOverlay && window.PerfOverlay.tickRender) {
      window.PerfOverlay.tickRender();
    }
  },
  _renderImpl() {
    const s = Game.state;
    if (!s) return;
    // Reset and IMMEDIATELY repopulate the per-render combat-prediction
    // cache. The card-DOM diff cache (makeCardElCached → snap) reads
    // pred fields out of this cache; if it were lazy-populated by the
    // first makeCardEl call, early snaps would see `pred=null` while
    // later ones see real values, causing stale skull badges to stick
    // around (user report: "There's nothing on board and it has the
    // skull symbol"). One call up-front, then everyone reads the same
    // result.
    this._combatPredCache = (Game && typeof Game.predictCombatGlobal === 'function')
      ? Game.predictCombatGlobal() : null;

    // Phase transition wipe — a brief Tron-scan overlay that sweeps
    // across the screen whenever the player crosses a major boundary
    // (map → fight, fight → rewards, rewards → map). Audit finding:
    // "phase changes were hard cuts." Skipped for modal-driven flows
    // (treasure, rest, event, etc.) since those already animate via
    // the modal scaffold. Tracked via this._lastPhase across renders.
    if (this._maybePhaseWipe) this._maybePhaseWipe(s.phase);

    // Clean up any stuck hover-magnify popup before re-rendering. If the
    // card the popup cloned has been removed from the DOM (played,
    // killed, discarded), the mouseout handler never got a chance to
    // fire hide() — this ensures the zoomed preview doesn't persist over
    // the board / prompts (e.g. Jigsaw's onPlay target chooser).
    if (this._hideHoverMagnify) this._hideHoverMagnify();

    // Recompute per-side MVP rankings once per render. makeCardEl reads
    // this cache to decide whether the card it's drawing gets a gold
    // (#1) or silver (#2) star — cheaper than re-sorting per card. Pool
    // includes both board and dead-pile cards so rankings reflect the
    // whole game, but the star only renders when the top card is still
    // on the board (dead cards don't render a makeCardEl on the lane).
    this._mvpRanks = this.computeMvpRanks();

    const isMainMenu    = s.phase === 'main-menu';
    const isModeSelect  = s.phase === 'mode-select';
    const isMyDecks     = s.phase === 'my-decks';
    const isStats       = s.phase === 'stats';
    const isDeckBuilder = s.phase === 'deckbuilder-build';
    const isDraft = s.phase === 'draft-cards' || s.phase === 'draft-tricks';
    // Hide the dev Web/Mobile preview toggle on every screen EXCEPT the
    // main menu and mode-select. It's a developer affordance, not part
    // of the player UI. User feedback: "the blue square on the top left
    // corner needs to go" (re: the encyclopedia and other overlays).
    // Also hidden when any modal-style overlay (encyclopedia, multi-
    // player, match-history) is open via UI._encyc/UI._mp/etc state.
    const isLandingScreen = isMainMenu || isModeSelect;
    // Use cached overlay refs (bound once in init) instead of re-querying
    // the DOM 9× per frame. Helper inlines the visibility check.
    const isOverlayVisible = (el) => {
      if (!el) return false;
      const d = el.style.display;
      return d !== 'none' && d !== '';
    };
    const overlayOpen = (
      isOverlayVisible(this._encyclopediaOverlay) ||
      isOverlayVisible(this._matchHistoryOverlay) ||
      isOverlayVisible(this._multiplayerOverlay)
    );
    document.body.classList.toggle('clb-toggle-hidden', !isLandingScreen || overlayOpen);
    // Pre-match overlays — only one is visible at a time. Refs cached at init.
    if (this._mainMenuOverlay)    this._mainMenuOverlay.style.display    = isMainMenu ? 'flex' : 'none';
    if (this._modeSelectOverlay)  this._modeSelectOverlay.style.display  = isModeSelect ? 'flex' : 'none';
    if (this._myDecksOverlay)     this._myDecksOverlay.style.display     = isMyDecks ? 'flex' : 'none';
    if (this._statsOverlay)       this._statsOverlay.style.display       = isStats ? 'flex' : 'none';
    if (this._deckbuilderOverlay) this._deckbuilderOverlay.style.display = isDeckBuilder ? 'flex' : 'none';
    this.draftEl.style.display = isDraft ? 'flex' : 'none';
    const isRoguelite = s.phase && s.phase.startsWith('roguelite');
    (this._gameAreaEl || document.getElementById('game-area')).style.display =
      (isDraft || isMainMenu || isModeSelect || isMyDecks || isStats || isDeckBuilder || isRoguelite) ? 'none' : '';

    if (isMainMenu)    { this.renderMainMenu(s); return; }
    if (isModeSelect)  { this.renderModeSelect(s); return; }
    if (isMyDecks)     { this.renderMyDecks(s); return; }
    if (isStats)       { this.renderStats(s); return; }
    if (isDeckBuilder) { this.renderDeckBuilder(s); return; }
    if (isDraft)       { this.renderDraft(s); return; }
    if (isRoguelite && typeof Roguelite !== 'undefined') {
      if (Roguelite.renderPhase(s)) return;
    } else if (typeof Roguelite !== 'undefined') {
      // Hide the overlay when we leave a roguelite phase (return to main menu, etc.)
      Roguelite.hideOverlay();
    }

    // Capture card positions/HTML BEFORE any DOM mutation so we can
    // FLIP-animate hand→board moves and spawn death ghosts for vanished cards.
    this._capturePositions();

    // Block trick choice — render as a floating modal that keeps the board visible.
    // (Don't early-return like the old full-screen modal — we want to render the rest of the board too.)
    if (s.pendingBlockTrick) { this.renderBlockTrickChoice(s); }
    else { this._removeFloatingPrompt('block-trick-modal'); }

    // Jump offer — pause combat with a play-free-or-skip modal when a
    // player-side jump card becomes ready mid-combat (e.g. Jason after an
    // ally death). Previously the lane-resolve timer rolled past the
    // window before the player could click the glowing card in hand.
    if (s.pendingJumpOffer) { this.renderJumpOfferChoice(s); }
    else { this._removeFloatingPrompt('jump-offer-modal'); }
    // Time Stone intercept — paused AI trick waiting on player's counter/allow decision.
    if (s.pendingTimeStoneIntercept) { this.renderTimeStoneIntercept(s); }
    else { this._removeFloatingPrompt('time-stone-modal'); }

    // Batman Who Laughs steal choice
    if (s.player.stolenByBWL) { this.renderBWLChoice(s); return; }

    // Kang deck choice
    if (s.pendingKangChoice) { this.renderKangChoice(s); return; }

    // Phase transition banners
    this.checkPhaseTransition(s);
    this.markActiveLaneBeat();
    this.animateStatChanges();

    // One-shot effect banners (e.g. Gorr devour) — give these a longer
    // explicit duration since they carry info the player actually
    // needs to read (which cards were devoured from each side).
    if (s._gorrBanner && s._gorrBanner.at !== this._gorrBannerShown) {
      this._gorrBannerShown = s._gorrBanner.at;
      this.showPhaseBanner(s._gorrBanner.text, { duration: 4200 });
    }

    // Health
    document.getElementById('player-health').textContent = Math.max(0, s.player.health);
    document.getElementById('ai-health').textContent = Math.max(0, s.ai.health);
    document.getElementById('player-hp-fill').style.width = `${Math.max(0, (s.player.health / s.player.maxHealth) * 100)}%`;
    document.getElementById('ai-hp-fill').style.width = `${Math.max(0, (s.ai.health / s.ai.maxHealth) * 100)}%`;
    // HP critical pulse — toggle the hp-critical class on the fill +
    // the health-text wrapper so both get the red-throb animation
    // when the player is under 30% HP. AI side gets the same treatment
    // so the player sees "time to press advantage" visually.
    ['player', 'ai'].forEach(side => {
      const hp = s[side].health;
      const maxHp = s[side].maxHealth || 30;
      const critical = hp > 0 && hp / maxHp <= 0.30;
      const fill = document.getElementById(side + '-hp-fill');
      const text = document.getElementById(side + '-health');
      if (fill) fill.classList.toggle('hp-critical', critical);
      if (text) {
        const span = text.closest('.health-text') || text.parentElement;
        if (span) span.classList.toggle('hp-critical-text', critical);
      }
    });
    // Frozen HP ring when Mr. Freeze shield is active
    const pHpCont = document.getElementById('player-hp-fill').closest('.health-container');
    const aHpCont = document.getElementById('ai-hp-fill').closest('.health-container');
    if (pHpCont) pHpCont.classList.toggle('hp-frozen', !!s.player.healthFrozen);
    if (aHpCont) aHpCont.classList.toggle('hp-frozen', !!s.ai.healthFrozen);
    // HP change feedback: shake on damage, shimmer on heal
    this._prevHP = this._prevHP || {};
    const triggerHP = (who, cont, hp) => {
      const prev = this._prevHP[who];
      if (prev !== undefined && cont) {
        const cls = hp < prev ? 'hp-hit' : (hp > prev ? 'hp-heal' : null);
        if (cls) {
          cont.classList.remove('hp-hit', 'hp-heal');
          void cont.offsetWidth;  // force reflow so animation restarts
          cont.classList.add(cls);
          setTimeout(() => cont.classList.remove(cls), 650);
        }
      }
      this._prevHP[who] = hp;
    };
    triggerHP('player', pHpCont, s.player.health);
    triggerHP('ai', aHpCont, s.ai.health);

    // Block circles (just fraction + full-state glow)
    const blockMax = Game.BLOCK_MAX || 8;
    const pBlock = document.getElementById('player-block-text');
    const aBlock = document.getElementById('ai-block-text');
    if (pBlock) pBlock.textContent = `${s.player.blockMeter}/${blockMax}`;
    if (aBlock) aBlock.textContent = `${s.ai.blockMeter}/${blockMax}`;
    const pCircle = pBlock ? pBlock.closest('.block-circle') : null;
    const aCircle = aBlock ? aBlock.closest('.block-circle') : null;
    const pPct = Math.max(0, Math.min(100, (s.player.blockMeter / blockMax) * 100));
    const aPct = Math.max(0, Math.min(100, (s.ai.blockMeter / blockMax) * 100));
    if (pCircle) {
      pCircle.style.setProperty('--fill', pPct + '%');
      pCircle.classList.toggle('full', s.player.blockMeter >= blockMax);
    }
    if (aCircle) {
      aCircle.style.setProperty('--fill', aPct + '%');
      aCircle.classList.toggle('full', s.ai.blockMeter >= blockMax);
    }

    // Energy orbs
    const maxEnergy = Math.max(s.round || 1, s.player.currency);
    const aiMaxEnergy = Math.max(s.round || 1, s.ai.currency);
    this.renderEnergyOrbs('player-energy-display', s.player.currency, maxEnergy);
    this.renderEnergyOrbs('ai-energy-display', s.ai.currency, aiMaxEnergy);
    // PERF FIX: applyHpNexusTier and applyHandFanVars were no-ops or
    // setting unused CSS variables (HP Nexus frame was removed by the
    // user, hand fan tilt was removed by the user). Both still ran
    // querySelectorAll('.health-text[data-hp-tier]') / querySelector
    // ('.player-hand-section .hand-card-wrapper') on EVERY render
    // (60-120Hz), generating layout-sync overhead per frame for no
    // visible effect. Calls removed; functions stay defined for
    // legacy reference. */
    // Playable-pulse on the player energy orb — signals "you have
    // cards you can afford to play right now, it's your turn". The
    // CSS animation (energyPlayablePulse) fires while the class is
    // on. Turns off at AI turns / when no affordable card is in hand.
    const pEnergyText = document.querySelector('#player-energy-display .energy-text');
    if (pEnergyText) {
      const isPlayerTurn = s.activePlayer === 'player' && (
        s.phase === 'player-cards' || s.phase === 'player-cards-tricks' || s.phase === 'player-tricks'
      );
      const canAffordSomething = isPlayerTurn && (s.player.hand || []).some(c => {
        const cost = (typeof Game.getCardCost === 'function') ? Game.getCardCost('player', c) : (c.cost || 0);
        return cost <= s.player.currency;
      });
      pEnergyText.classList.toggle('can-play', !!canAffordSomething);
    }

    // Piles — in Deckbuilder the HUD counts show the PLAYER's deck/tricks
    // remaining (each side has its own pile). In Classic the shared pile
    // is the same number for both sides, so we still just show one count.
    const isDeckbuilder = s.mode && s.mode.deck === 'deckbuilder';
    document.getElementById('draw-pile-count').textContent =
      isDeckbuilder ? s.player.drawPile.length : s.drawPile.length;
    document.getElementById('trick-pile-count').textContent =
      isDeckbuilder ? s.player.trickDrawPile.length : s.trickDrawPile.length;
    document.getElementById('player-dead-count').textContent = s.player.deadPile.length;
    document.getElementById('ai-dead-count').textContent = s.ai.deadPile.length;
    // Trick history badges — count of tricks each side has played
    // this match. Both sides visible so both players can count what's
    // been used vs. what's still in the opponent's deck.
    const ptCount = document.getElementById('player-tricks-count');
    if (ptCount) ptCount.textContent = (s.player.playedTrickPile || []).length;
    const atCount = document.getElementById('ai-tricks-count');
    if (atCount) atCount.textContent = (s.ai.playedTrickPile || []).length;

    // Round & phase
    document.getElementById('round-num').textContent = s.round;
    // Shortened phase labels — the pill's border already tints blue/red
    // to indicate whose turn it is, so the old "Your Turn —" / "AI Playing"
    // preamble is redundant. Keeping the strings tight so the pill doesn't
    // overflow when the deck/tricks counts are packed in alongside.
    const phaseLabels = {
      'player-cards': 'Cards',
      'player-tricks': 'Tricks',
      'player-cards-tricks': 'Cards & Tricks',
      'ai-cards': 'AI · Cards',
      'ai-tricks': 'AI · Tricks',
      'ai-cards-tricks': 'AI · Cards & Tricks',
      'combat': 'Combat'
    };
    const phaseText = s.gameOver
      ? (s.winner === 'player' ? 'YOU WIN!' : 'YOU LOSE!')
      : (phaseLabels[s.phase] || s.phase);
    document.getElementById('phase-text').textContent = phaseText;

    // First player indicator
    const firstEl = document.getElementById('first-player-text');
    if (firstEl && s.firstPlayer) {
      firstEl.textContent = s.firstPlayer === 'player' ? 'You go first' : 'AI goes first';
    }

    // Prompt banner for inline card/lane choices
    this.renderPromptBanner(s);

    this.renderRoundTrack(s);
    this._updateDominanceVars(s);  // Color Invasion — write dominance CSS vars before rendering
    this.renderBoard(s);
    this.renderPlayerHand(s);
    this.renderAIHand(s);
    this.renderPlayerTricks(s);
    this.renderInlineChoiceFallback(s);
    this.renderButtons(s);
    this.renderLog(s);
    this.showDamageFloats();

    // Apply the shared Tron interaction language (hover-fill, active
    // pulse, border breathing, click flash) to every interactive
    // surface that landed in this render pass. Idempotent.
    this.applyTronFx();

    // Refresh the risk/reward signaling (threat-lane glow, lethal
    // HP warning) based on the current board state. Decision support
    // — only fires during the player's actionable phases.
    this.refreshThreatSignals();

    // After new DOM is in place, FLIP-animate hand→board flights and
    // spawn death ghosts for any card that vanished from the board.
    this._applyMotionEffects();
  },

  // ===================== RISK / REWARD SIGNALING =====================
  // Compute incoming damage from the AI's current board against the
  // player's current board, lane by lane, and tag the relevant DOM
  // elements with the .threat-lane / .hp-lethal-incoming classes.
  // Called from render() so the signals stay in sync with the game
  // state without needing event hooks scattered through the engine.
  //
  // The math (improved): for each lane,
  //   • Determine raw AI ATK (factoring in stuns/freezes — can't attack)
  //   • Subtract player blocker HP if blocking
  //   • Apply Armor reduction to face damage (-N flat)
  //   • Skip if Invincible / damage-immune is up
  //   • If AI has Bullseye, blocker is bypassed entirely (full to face)
  //   • If AI has Splash, count adjacent splash too (reaches face if
  //     adjacent lane is empty)
  //   • Sum across all lanes → total incoming
  //   • If total ≥ player.health, fire the lethal warning
  refreshThreatSignals() {
    const s = Game && Game.state;
    if (!s || !s.lanes) return;
    const lanes = document.querySelectorAll('.board > .lane');
    // Only signal during the PLAYER's actionable phases.
    const phase = s.phase || '';
    const playerActionable =
      phase === 'player-cards' ||
      phase === 'player-cards-tricks' ||
      phase === 'player-tricks';
    // Player-side global modifiers that reduce face damage even
    // when the lane is unblocked. Read once at function scope.
    const playerInvincible = s.player && (s.player.invincibleTurns > 0 || s.player.hasDamageImmunity);
    const playerArmor = (s.player && s.player.armor) || 0;
    let totalIncoming = 0;
    // Breakdown lines, populated as we compute. Used by the
    // lethal-flash badge tooltip so the player can see WHERE the
    // total comes from (per-lane attribution).
    this._threatBreakdown = [];
    lanes.forEach((laneEl, i) => {
      const lane = s.lanes[i];
      if (!lane || lane.destroyed) {
        laneEl.classList.remove('threat-lane', 'threat-1', 'threat-2', 'threat-3');
        return;
      }
      const ai = lane.ai;
      if (!ai || ai.currentHealth <= 0 || !playerActionable) {
        laneEl.classList.remove('threat-lane', 'threat-1', 'threat-2', 'threat-3');
        return;
      }
      // AI creature can't attack if stunned or frozen
      if (ai.isStunned || ai.isFrozen) {
        laneEl.classList.remove('threat-lane', 'threat-1', 'threat-2', 'threat-3');
        return;
      }
      const player = lane.player;
      const aiAtk = Math.max(0, ai.attack || 0);
      // How much of this lane's AI ATK reaches the face?
      let faceDamage = 0;
      const hasBullseye = ai.hasBullseye || (ai.statusBadges && ai.statusBadges.includes('bullseye'));
      if (!player || player.currentHealth <= 0 || hasBullseye) {
        // Unblocked OR bypassed by bullseye
        faceDamage = aiAtk;
      } else {
        // Blocked path — overflow goes to face if AI's ATK exceeds
        // blocker's HP (player blocker absorbs up to its current HP)
        if (aiAtk > player.currentHealth) {
          faceDamage = aiAtk - player.currentHealth;
        }
      }
      // Player armor reduces face damage by N flat (per-hit, not per-turn,
      // but UI uses it as a worst-case approximation)
      if (faceDamage > 0 && playerArmor > 0) {
        faceDamage = Math.max(0, faceDamage - playerArmor);
      }
      // Invincibility / damage-immunity → no face damage
      if (playerInvincible) {
        faceDamage = 0;
      }
      // Splash damage: if AI has splash, the splash hits the player
      // FACE adjacent to this lane only if that adjacent lane is
      // empty (no blocker). Worst-case approximation.
      let splashFace = 0;
      const splashRange = ai.splashRange || 0;
      if (splashRange > 0 && !playerInvincible) {
        const adjLanes = [i - 1, i + 1].filter(j => j >= 0 && j < 6);
        for (const j of adjLanes) {
          const adjLane = s.lanes[j];
          if (!adjLane || adjLane.destroyed) continue;
          if (!adjLane.player || adjLane.player.currentHealth <= 0) {
            splashFace += Math.max(0, splashRange - playerArmor);
          }
        }
      }
      const laneFaceTotal = faceDamage + splashFace;
      if (laneFaceTotal > 0) {
        totalIncoming += laneFaceTotal;
        // Record breakdown — Lane N: ai.name (math): total
        let math = `${ai.attack} ATK`;
        if (player && player.currentHealth > 0 && !hasBullseye) {
          math += ` − ${player.currentHealth} blocker = ${faceDamage}`;
        } else {
          math += ' unblocked';
        }
        if (splashFace > 0) math += ` + splash ${splashFace}`;
        if (playerArmor > 0 && faceDamage > 0) math += ` (after armor ${playerArmor})`;
        this._threatBreakdown.push(`  Lane ${i+1}: ${ai.name} → ${laneFaceTotal} (${math})`);
        let tier = 1;
        if (laneFaceTotal >= 6) tier = 3;
        else if (laneFaceTotal >= 3) tier = 2;
        laneEl.classList.add('threat-lane');
        ['threat-1', 'threat-2', 'threat-3'].forEach((c, idx) => {
          laneEl.classList.toggle(c, idx + 1 === tier);
        });
      } else {
        laneEl.classList.remove('threat-lane', 'threat-1', 'threat-2', 'threat-3');
      }
    });
    // ---- Player HP lethal-incoming warning ----
    const hpContainer = document.querySelector('.player-bar .health-container');
    const hpText = document.querySelector('.player-bar .health-text');
    const hp = (s.player && s.player.health) || 0;
    const lethal = playerActionable && hp > 0 && totalIncoming >= hp && !playerInvincible;
    if (hpContainer) hpContainer.classList.toggle('hp-lethal-incoming', !!lethal);
    // Inline lethal-flash badge — text shows the after-mitigation total
    // ("−6 INCOMING"), title attribute shows the per-lane breakdown so
    // the player can audit WHERE the damage is coming from. Without
    // the breakdown, the badge is opaque ("how is it 11 with one
    // 6-attack creature?"); the tooltip makes the math legible.
    if (hpText) {
      let badge = hpText.querySelector(':scope > .lethal-flash');
      if (lethal) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'lethal-flash';
          hpText.appendChild(badge);
        }
        badge.textContent = `−${totalIncoming} INCOMING`;
        // Build per-lane breakdown line by line (also written to
        // a debug array on UI for inspection).
        if (!this._threatBreakdown) this._threatBreakdown = [];
        const lines = ['Incoming damage:'];
        this._threatBreakdown.forEach(b => lines.push(b));
        if (lines.length === 1) lines.push('  (none)');
        lines.push('────────────────');
        lines.push(`Total: ${totalIncoming}  ·  HP: ${hp}`);
        badge.title = lines.join('\n');
      } else if (badge) {
        badge.remove();
      }
    }
  },

  // --- MOTION HELPERS -------------------------------------------------

  _capturePositions() {
    this._prevRects = new Map();
    this._prevHtml = new Map();
    document.querySelectorAll('.card[data-card-id]').forEach(el => {
      const id = el.getAttribute('data-card-id');
      const rect = el.getBoundingClientRect();
      if (rect.width < 1) return; // hidden / zero-size — skip
      const inHand = el.classList.contains('hand-card');
      this._prevRects.set(id, { rect, inHand });
      if (!inHand) this._prevHtml.set(id, el.outerHTML);
    });
  },

  _applyMotionEffects() {
    if (!this._prevRects) return;
    const current = new Map();
    document.querySelectorAll('.card[data-card-id]').forEach(el => {
      current.set(el.getAttribute('data-card-id'), el);
    });

    // Hand → Board flight (FLIP)
    for (const [id, el] of current) {
      const prev = this._prevRects.get(id);
      if (!prev || !prev.inHand) continue;
      if (el.classList.contains('hand-card')) continue;
      this._animateFly(el, prev.rect);
    }

    // Deaths — board cards that are no longer present anywhere
    for (const [id, prev] of this._prevRects) {
      if (current.has(id)) continue;
      if (prev.inHand) continue;
      const html = this._prevHtml.get(id);
      if (!html) continue;
      this._spawnDeathGhost(prev.rect, html);
    }
  },

  _animateFly(realEl, fromRect) {
    // User direction May-1: "Replace what we already have as an
    // animation when you place a card with this build-in." The
    // 840ms parabolic flight ghost was the actual visible play
    // animation — it suppressed card-enter (line ~3656 used to
    // strip card-enter from realEl) so the new cardBuildIn keyframe
    // never had a chance to play. Now disabled: the real card stays
    // visible immediately on placement and animates in via the
    // cardBuildIn keyframe (.card.card-enter, style.css:5546).
    //
    // Kept the function as a stub (instead of removing the call
    // site at line ~3626) so any future code path that still calls
    // _animateFly is a no-op rather than a crash. If we ever want
    // a flight back, restore the body and re-add a config flag.
    return;
  },

  _spawnDeathGhost(rect, html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const el = wrap.firstElementChild;
    if (!el) return;
    el.classList.add('card-death-ghost');
    el.classList.remove('card-enter', 'card-exit', 'card-flying');
    el.removeAttribute('data-card-id'); // prevent selector collisions
    el.style.top = rect.top + 'px';
    el.style.left = rect.left + 'px';
    el.style.width = rect.width + 'px';
    el.style.height = rect.height + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 620);
  },

  // Combat reveal — one-shot circuit grid flash across the whole board. Fires
  // once at the start of each combat round.
  flashCombatReveal() {
    const board = document.querySelector('.board-section');
    if (!board) return;
    // Remove any existing flash overlay so the class replay triggers cleanly
    const existing = board.querySelector('.combat-reveal-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.className = 'combat-reveal-overlay';
    board.appendChild(overlay);
    setTimeout(() => overlay.remove(), 900);
  },

  // Phase transition wipe — Tron-scan overlay that sweeps across the
  // screen on major phase boundaries (both roguelite + classic).
  // Audit finding: "phase changes were hard cuts." Tracks the last
  // seen phase across renders; fires a brief wipe overlay when the
  // transition involves combat or the major prep screens. Skipped
  // for landing screens (main-menu ↔ mode-select) and reduced-motion.
  _maybePhaseWipe(currentPhase) {
    if (!currentPhase) { this._lastPhase = currentPhase; return; }
    const prev = this._lastPhase;
    this._lastPhase = currentPhase;
    if (!prev || prev === currentPhase) return;
    if (this._reducedMotion && this._reducedMotion()) return;
    // Phases that should punctuate transitions with the wipe.
    // Excludes the bouncing utility screens (my-decks, stats) and
    // the main-menu ↔ mode-select hops which already have their own
    // entry animations.
    const SIGNIFICANT = new Set([
      // Roguelite
      'roguelite-map', 'roguelite-rewards', 'roguelite-pick-relic',
      'roguelite-pick-card', 'roguelite-end', 'roguelite-start',
      // Classic flow
      'game-over',
      'draft-cards', 'draft-tricks',
      'deckbuilder-build',
    ]);
    // In-fight phase family: anything where the player is on the
    // board (cards/tricks/combat). Treated as a single unit — wipes
    // fire crossing INTO or OUT of this family, not within it (no
    // jarring flash every time the active player flips). Bug fix:
    // earlier code checked currentPhase === 'play', but 'play' is
    // never actually written as a phase value — so the wipe never
    // fired on draft-tricks → player-cards (the curtain-rise moment
    // the user actually wanted animated).
    const INFIGHT_PHASES = new Set([
      'player-cards', 'ai-cards',
      'player-cards-tricks', 'ai-cards-tricks',
      'player-tricks', 'ai-tricks',
      'combat',
    ]);
    const inFightNow  = INFIGHT_PHASES.has(currentPhase);
    const inFightPrev = INFIGHT_PHASES.has(prev);
    const enterOrLeaveFight = inFightNow !== inFightPrev;
    const wipe = enterOrLeaveFight
      || (SIGNIFICANT.has(prev) && SIGNIFICANT.has(currentPhase));
    if (!wipe) return;
    // Avoid stacking wipes on rapid back-to-back phase changes.
    if (this._wipeFiring) return;
    this._wipeFiring = true;
    // ---- Transition flavor detection -----------------------------
    // Each phase boundary gets its own personality. Boot is the
    // game's curtain-rise (trick-draft → first-fight-phase). Other
    // boundaries riff on the same scan-wipe with their own pacing
    // and SFX so map → fight feels DIFFERENT from rewards → map etc.
    //   - boot   : ANY pre-fight → first-fight-phase of a new run
    //              (classic trick-draft → board, roguelite/daily start
    //              → board, deckbuilder match-start → board). The
    //              theatrical curtain-rise that says "the run begins."
    //   - engage : roguelite-map → in-fight (combat-ready, fast + sharp)
    //              Fires on per-fight entries WITHIN a run, NOT on
    //              the first fight (that's boot).
    //   - commit : in-fight → roguelite-rewards (calm, "saving data")
    //   - return : roguelite-rewards → roguelite-map (contemplative ink)
    //
    // User report: "now the start up animation doesn't happen for the
    // lanes... when you load into the game." Was playing roguelite/daily;
    // boot was gated to classic-only via prev==='draft-tricks'. Now also
    // fires on roguelite-start (the boon → first-fight bridge) and
    // deckbuilder-build, so every fresh run gets the curtain-rise.
    const isBoot = inFightNow && (
      prev === 'draft-tricks'      ||
      prev === 'roguelite-start'   ||
      prev === 'deckbuilder-build'
    );
    const isEngage = (prev === 'roguelite-map'     && inFightNow && !isBoot);
    const isCommit = (inFightPrev && currentPhase === 'roguelite-rewards');
    const isReturn = (prev === 'roguelite-rewards' && currentPhase === 'roguelite-map');
    let variant = '';
    if (isBoot)        variant = 'boot';
    else if (isEngage) variant = 'engage';
    else if (isCommit) variant = 'commit';
    else if (isReturn) variant = 'return';
    const wipeEl = document.createElement('div');
    wipeEl.className = 'rl-phase-wipe' + (variant ? ' ' + variant : '');
    document.body.appendChild(wipeEl);
    if (isBoot) {
      document.body.classList.add('boot-sequence');
      // Publish a "boot ends at" timestamp so the engine can defer
      // the AI's first action until the curtain finishes. Without
      // this, AI started at 1200ms while the boot ran ~2200ms — its
      // play landed under the closing scan, hard to follow. Read by
      // game.js startPhase1 (ai-cards branch).
      if (Game && Game.state) {
        Game.state._bootSequenceEndsAt = performance.now() + 2300;
      }
      // Stamp per-element index so CSS can stagger via custom property
      // — but DEFER one frame because _maybePhaseWipe runs at the
      // start of _renderImpl (before the new phase's DOM has been
      // built). nth-child fallbacks in style.css cover the common
      // case (always 6 lanes); the JS stamping is the precision pass
      // for when DOM order doesn't match logical order.
      requestAnimationFrame(() => {
        const board = document.getElementById('board');
        if (board) board.querySelectorAll('.lane').forEach((el, i) => el.style.setProperty('--lane-i', String(i)));
        const hand = document.getElementById('player-hand');
        if (hand) hand.querySelectorAll('.hand-card-wrapper').forEach((el, i) => el.style.setProperty('--card-i', String(i)));
        // Fire the audio cue + HUD numeral scramble in lockstep with
        // the visuals. Both kick off here on the same rAF as the
        // index stamping so the curtain-rise reads as one event.
        if (this.sfx && this.sfx.playBootSequence) {
          const cardCount = (Game.state && Game.state.player && Game.state.player.hand) ? Game.state.player.hand.length : 0;
          try { this.sfx.playBootSequence(cardCount); } catch (e) {}
        }
        if (this._bootScrambleHud) this._bootScrambleHud();
      });
    }
    // Fire variant-specific SFX in lockstep with the visual.
    // Procedural via UI.sfx.play(name) so no asset files needed.
    if (variant === 'engage' && this.sfx && this.sfx.play) {
      try { this.sfx.play('phaseEngage'); } catch (e) {}
    } else if (variant === 'commit' && this.sfx && this.sfx.play) {
      try { this.sfx.play('phaseCommit'); } catch (e) {}
    } else if (variant === 'return' && this.sfx && this.sfx.play) {
      try { this.sfx.play('phaseReturn'); } catch (e) {}
    }
    // CSS animation duration is set in style.css per variant.
    // - standard: 540ms anim, 1120ms cleanup
    // - boot:     1100ms anim, 2300ms cleanup (lane stagger + card stagger)
    // - engage:   700ms anim, 760ms cleanup (sharp combat-ready snap)
    // - commit:   950ms anim, 1010ms cleanup (calm "saving data" fade)
    // - return:   950ms anim, 1010ms cleanup (contemplative ink spread)
    const cleanupMs = variant === 'boot'   ? 2300
                    : variant === 'engage' ? 760
                    : variant === 'commit' ? 1010
                    : variant === 'return' ? 1010
                    : 1120;
    setTimeout(() => {
      wipeEl.remove();
      if (isBoot) {
        document.body.classList.remove('boot-sequence');
        const board = document.getElementById('board');
        if (board) board.querySelectorAll('.lane').forEach(el => el.style.removeProperty('--lane-i'));
        const hand = document.getElementById('player-hand');
        if (hand) hand.querySelectorAll('.hand-card-wrapper').forEach(el => el.style.removeProperty('--card-i'));
      }
      this._wipeFiring = false;
    }, cleanupMs);
  },

  // HUD numeral scramble — fires alongside the boot wipe. The
  // round digit, both HP bars, and both energy displays cycle
  // through random characters at ~12 Hz for ~600ms before settling.
  // Reads like an old-school terminal locking on its values.
  //
  // Implementation note: the real elements stay live; we briefly
  // overwrite their textContent with random glyphs and restore the
  // truth at the end. If UI.render() fires mid-scramble it'll
  // overwrite our random text with the correct value — that's
  // graceful: visually the scramble just settles a frame early.
  _bootScrambleHud() {
    if (this._reducedMotion && this._reducedMotion()) return;
    // Real HUD numeric element IDs in index.html — bumping any of
    // these names requires updating both places. Energy displays
    // (#player-energy-display / #ai-energy-display) are skipped
    // because their text is built dynamically inside nested spans
    // and the text node moves between renders.
    const ids = [
      'round-num',
      'draw-pile-count', 'trick-pile-count',
      'player-health',   'ai-health',
    ];
    const targets = [];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      // Some HUD numerals live inside nested spans — find the deepest
      // text-bearing node so we scramble the digits, not the chrome.
      let node = el;
      while (node.children && node.children.length === 1 && node.firstElementChild) {
        node = node.firstElementChild;
      }
      const original = node.textContent;
      // Skip if not numeric — we don't want to scramble labels.
      if (!/^[0-9./-]+$/.test(original.trim())) return;
      targets.push({ node, original });
    });
    if (!targets.length) return;
    const GLYPHS = '0123456789ABCDEF';
    const randDigit = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];
    const scramble = (text) => text.replace(/[0-9A-F]/g, randDigit);
    const start = performance.now();
    const DURATION = 600;
    const tick = () => {
      const elapsed = performance.now() - start;
      if (elapsed >= DURATION) {
        // Settle — restore originals.
        targets.forEach(t => { t.node.textContent = t.original; });
        return;
      }
      targets.forEach(t => { t.node.textContent = scramble(t.original); });
      // ~12 Hz scramble rate; rAF gives us free vsync-aware pacing.
      setTimeout(() => requestAnimationFrame(tick), 80);
    };
    requestAnimationFrame(tick);
  },

  _screenShake(intensity) {
    const area = document.getElementById('game-area');
    if (!area) return;
    // Audit finding: every hit shook the screen the same. Now hits
    // scale: light (chip damage) = small wobble, heavy (≥30% max HP
    // or ≥10 raw damage) = big shake. Caller passes intensity 'light'
    // / 'medium' / 'heavy'; unknown defaults to medium.
    const cls = intensity === 'heavy' ? 'screen-shake-heavy'
      : intensity === 'light' ? 'screen-shake-light'
      : 'screen-shake';
    area.classList.remove('screen-shake', 'screen-shake-light', 'screen-shake-heavy');
    void area.offsetWidth;
    area.classList.add(cls);
    const dur = intensity === 'heavy' ? 460 : intensity === 'light' ? 220 : 300;
    setTimeout(() => area.classList.remove(cls), dur);
  },

  showDamageFloats() {
    const events = Game.flushDmg();
    for (const ev of events) {
      // (b) Block-fill spark — fire when a 'block' event credits the
      // block meter (damage absorbed by the meter).
      if (ev.type === 'block' && ev.cardId) {
        const card = document.querySelector(`[data-card-id="${ev.cardId}"]`);
        const side = card && card.classList.contains('ally-card') ? 'player' : 'ai';
        this.spawnBlockSpark(side);
      }
      if (ev.type === 'blocked') {
        // BLOCKED! banner
        const banner = document.createElement('div');
        banner.className = 'blocked-banner';
        banner.textContent = 'BLOCKED!';
        document.body.appendChild(banner);
        setTimeout(() => banner.remove(), 1100);
        // Flash the HP bar
        const fill = document.getElementById(ev.owner === 'player' ? 'player-hp-fill' : 'ai-hp-fill');
        if (fill) { fill.classList.add('hp-flash'); setTimeout(() => fill.classList.remove('hp-flash'), 500); }
        this.sfx.play('blockFull');
        // Haptic for the block trigger — distinctive punch so the
        // player feels the moment their meter saved them.
        this._haptic('block');
        continue;
      }
      if (ev.type === 'hpHit') {
        if (ev.amount > 0) this.sfx.play('hpHit');
        // Flash the HP bar
        const fill = document.getElementById(ev.owner === 'player' ? 'player-hp-fill' : 'ai-hp-fill');
        if (fill) { fill.classList.add('hp-flash'); setTimeout(() => fill.classList.remove('hp-flash'), 500); }
        // (j) HP depletion shards
        this.spawnHpShards(ev.owner, ev.amount || 0);
        // Shake the HP number itself — localized hit feedback
        const hpText = document.getElementById(ev.owner === 'player' ? 'player-health' : 'ai-health');
        if (hpText && ev.amount > 0) {
          hpText.classList.remove('hp-shake');
          void hpText.offsetWidth; // force reflow so the animation replays
          hpText.classList.add('hp-shake');
          setTimeout(() => hpText.classList.remove('hp-shake'), 300);
        }
        // Screen shake — magnitude scales with damage. Heavy = ≥30% of
        // max HP OR ≥10 raw damage (catches both early-game small-bar
        // chip and late-game massive blasts). Light = ≤2 damage (chip).
        if (ev.amount > 0) {
          const maxHp = ev.owner === 'player'
            ? (Game.state.player && Game.state.player.maxHealth) || 30
            : (Game.state.ai && Game.state.ai.maxHealth) || 30;
          const heavy = ev.amount >= 10 || ev.amount >= maxHp * 0.30;
          const light = ev.amount <= 2;
          this._screenShake(heavy ? 'heavy' : light ? 'light' : 'medium');
        }
        // Floating damage number on the health bar
        const container = fill ? fill.closest('.health-container') : null;
        if (container && ev.amount > 0) {
          container.style.position = 'relative';
          const float = document.createElement('div');
          float.className = 'hp-dmg-float';
          float.textContent = `-${ev.amount}`;
          container.appendChild(float);
          setTimeout(() => float.remove(), 1200);
          // Pro polish: leading-edge brightness pulse on the bar itself
          // when damage lands. Reads as the bar "registering" the hit
          // alongside the floater + width drop.
          this.pulseHpEdge(ev.owner);
        }
        continue;
      }
      // Card-targeted events — find card element on board
      const cardEl = document.querySelector(`[data-card-id="${ev.cardId}"]`);
      if (!cardEl) continue;
      // Hit flash + strike burst ring + card shake
      if (ev.type === 'hit') {
        // Attack beam — laser line from attacker to target. Fires only
        // when the attacker is known (direct combat hits). Skipped for
        // splash/chain/trick damage where the attackerId is undefined.
        if (ev.attackerId != null && ev.amount > 0) {
          this._spawnAttackBeam(ev.attackerId, ev.cardId);
        }
        cardEl.classList.add('hit-flash');
        setTimeout(() => cardEl.classList.remove('hit-flash'), 350);
        // Chip-shedding particle burst — small cubes "fall off" the
        // card on hit, like a partial disintegration. Replaces the
        // earlier 320ms horizontal shake which the user flagged as
        // distracting ("when a card is hurt it shakes a round get
        // rid of that... start the death animation. cubic
        // disintegration"). Spawns 4-5 ~5px squares at random
        // positions on the card body; they tumble off with rotation
        // + fade. Same visual family as the .destroy-particle
        // burst that fires on actual kills, so a hit reads as the
        // card "starting to die" — a partial preview of the full
        // dissolve.
        this.spawnHitChips(cardEl);
        this.sfx.play('hit');
        // Haptic — fires for EVERY hit, not just player-side. The
        // phone doesn't know which side is "yours", so a tick per
        // hit is honest feedback and subtle enough not to be spammy.
        if (ev.amount > 0) this._haptic('hit');
        // Concussive ring burst — spawns a single expanding circle
        // tinted by the receiving card's side theme.
        const burst = document.createElement('div');
        burst.className = 'strike-burst';
        cardEl.style.position = 'relative';
        cardEl.appendChild(burst);
        setTimeout(() => burst.remove(), 600);
      }
      // Armor absorb — shield burst animation on the card + a metal
      // "ting" system SFX so the deflection is audibly distinct from
      // a normal hit. One cue per armor event; no per-card flavor.
      if (ev.type === 'armor') {
        cardEl.classList.add('armor-burst');
        setTimeout(() => cardEl.classList.remove('armor-burst'), 700);
        const ring = document.createElement('div');
        ring.className = 'armor-ring';
        ring.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3 L34 8 V19 C34 28 20 36 20 36 C20 36 6 28 6 19 V8 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
        cardEl.style.position = 'relative';
        cardEl.appendChild(ring);
        setTimeout(() => ring.remove(), 700);
        this.sfx.play('armor');
      }
      // Evade whoosh — when a card dodges an incoming attack. System
      // SFX (not per-card) so it reads consistently as "dodge" across
      // every card that has Evade charges.
      if (ev.type === 'evade') {
        this.sfx.play('evade');
      }
      // Floating number — spawn with a randomized horizontal offset
      // so stacked hits (splash + main + chain) don't overlap into a
      // single illegible blob.
      const float = document.createElement('div');
      float.className = `dmg-float dmg-${ev.type}`;
      if (ev.type === 'hit') float.textContent = `-${ev.amount}`;
      else if (ev.type === 'evade') float.textContent = 'EVADE';
      else if (ev.type === 'block') float.textContent = 'BLOCKED';
      else if (ev.type === 'armor') float.textContent = 'ARMOR';
      else if (ev.type === 'heal') float.textContent = `+${ev.amount}`;
      const dx = (Math.random() * 26 - 13) | 0;
      float.style.setProperty('--dx', dx + 'px');
      // Vertical stagger — track per-card float count in a 1.2s
      // rolling window so multi-hit damage (splash + main + thorns +
      // chain) stacks readably instead of overlapping. Each subsequent
      // float on the same card rises higher than the last.
      // Audit finding: "Numbers stack illegibly on multi-hit (splash
      // + main + chain)."
      if (!this._dmgFloatStack) this._dmgFloatStack = new Map();
      const stack = this._dmgFloatStack;
      const key = ev.cardId;
      const now = performance.now();
      const slot = stack.get(key);
      let stackIdx = 0;
      if (slot && now - slot.t < 1100) stackIdx = slot.n + 1;
      stack.set(key, { n: stackIdx, t: now });
      // Each stack step lifts the float ~16px and adds a tiny
      // horizontal drift so the column doesn't read like a vertical bar.
      float.style.setProperty('--stack-dy', (stackIdx * -14) + 'px');
      cardEl.style.position = 'relative';
      cardEl.appendChild(float);
      setTimeout(() => float.remove(), 1200);
    }
  },

  renderPromptBanner(s) {
    let existing = document.getElementById('prompt-banner');
    if (existing) existing.remove();
    const cc = s.pendingCardChoice;
    const lc = s.pendingLaneChoice;
    if (!cc && !lc) return;
    const banner = document.createElement('div');
    banner.id = 'prompt-banner';
    banner.className = 'prompt-banner';
    const title = cc ? cc.title : lc ? lc.title : '';
    const desc = cc ? cc.desc : lc ? lc.desc : '';
    banner.innerHTML = `${title}${desc ? `<div class="prompt-desc">${desc}</div>` : ''}<div class="prompt-timer" id="prompt-timer"></div>`;
    const turnHud = document.querySelector('.turn-hud');
    if (turnHud) turnHud.parentNode.insertBefore(banner, turnHud.nextSibling);
    // Re-anchor an active countdown to the new timer element
    if (s._promptDeadline && s._promptDeadline > Date.now()) {
      this.startPromptCountdown(s._promptDeadline);
    }
  },

  // ===================== PROMPT COUNTDOWN =====================
  // Live countdown bar + seconds remaining in the prompt-banner. The bar
  // is updated on rAF via a transform (compositor-cheap, smooth); the
  // seconds-text is updated only when the integer second actually changes,
  // so we avoid rewriting innerHTML 5× per second for 30 seconds straight
  // (the previous setInterval approach). Saves ~140 pointless DOM writes
  // per prompt and eliminates the 200 ms timer wakeup during a prompt.
  startPromptCountdown(deadline) {
    this.stopPromptCountdown();
    const total = 30000; // matches _startPromptTimeout default
    // Prime the DOM once with the timer structure so we can point at
    // specific nodes (fill bar + seconds text) instead of rewriting HTML.
    const timer = document.getElementById('prompt-timer');
    if (!timer) return;
    timer.innerHTML = `
      <div class="prompt-timer-bar"><div class="prompt-timer-fill" style="transform:scaleX(1)"></div></div>
      <div class="prompt-timer-text">30s</div>`;
    const fillEl = timer.querySelector('.prompt-timer-fill');
    const textEl = timer.querySelector('.prompt-timer-text');
    let lastSeconds = -1;
    const tick = () => {
      // If the banner got replaced (render re-ran), re-resolve. If it's gone
      // entirely the prompt ended — stop the loop.
      const liveTimer = document.getElementById('prompt-timer');
      if (!liveTimer) { this.stopPromptCountdown(); return; }
      const liveFill = liveTimer.querySelector('.prompt-timer-fill');
      const liveText = liveTimer.querySelector('.prompt-timer-text');
      const remaining = Math.max(0, deadline - Date.now());
      const pct = Math.max(0, Math.min(1, remaining / total));
      if (liveFill) liveFill.style.transform = `scaleX(${pct})`;
      const seconds = Math.ceil(remaining / 1000);
      if (seconds !== lastSeconds) {
        if (liveText) liveText.textContent = `${seconds}s`;
        lastSeconds = seconds;
      }
      if (remaining <= 0) { this.stopPromptCountdown(); return; }
      this._countdownRaf = requestAnimationFrame(tick);
    };
    this._countdownRaf = requestAnimationFrame(tick);
  },
  stopPromptCountdown() {
    if (this._countdownRaf) { cancelAnimationFrame(this._countdownRaf); this._countdownRaf = null; }
    // Legacy cleanup — earlier version used setInterval; keep the guard in
    // case an old interval handle is still hanging from a previous session.
    if (this._countdownInterval) { clearInterval(this._countdownInterval); this._countdownInterval = null; }
    const timer = document.getElementById('prompt-timer');
    if (timer) timer.innerHTML = '';
  },

  // Render inline choice cards below the board for choices that can't be highlighted on board/hand
  renderInlineChoiceFallback(s) {
    let existing = document.getElementById('inline-choice-row');
    if (existing) existing.remove();
    let stale = document.getElementById('choice-tray');
    if (stale) stale.remove();
    // Always clear health bar highlights before deciding whether to re-add them.
    document.querySelectorAll('.health-container.mc-target').forEach(el => el.classList.remove('mc-target'));
    const cc = s.pendingCardChoice;
    if (!cc) return;

    // Wire up the Mind Control "attack the health bar" option directly to the
    // HP bar UI — the HP bar glows and becomes clickable, instead of being
    // rendered as a fake card in an inline row.
    const hbOption = cc.cards.find(c => c.id === '_healthbar_mc');
    if (hbOption) {
      const owner = hbOption._mcOwner;
      const bar = document.querySelector(`.${owner}-bar .health-container`);
      if (bar) {
        bar.classList.add('mc-target');
        bar.title = `Attack ${owner === 'player' ? 'your' : "AI's"} health bar`;
        // One-shot click — capture the idx now; renderer re-runs will re-attach.
        const idx = cc.cards.indexOf(hbOption);
        const handler = (e) => {
          e.stopPropagation();
          bar.classList.remove('mc-target');
          bar.removeEventListener('click', handler);
          cardChoicePick(idx);
        };
        bar.addEventListener('click', handler);
      }
    }

    // Only render the floating tray for candidates that AREN'T already
    // visible somewhere on screen. If every non-healthbar option is a
    // live card on the board or in the player's hand, those positions
    // already pulse gold (via .target-highlight) and are directly
    // clickable — a redundant centered popup just covers the lanes the
    // player is trying to pick from. User direction: "I'd rather it
    // just do it on board... highlight the cards in yellow."
    //
    // Build a set of currently-visible card IDs across board + hand.
    // Candidates with no `id` (synthetic option cards — e.g. Vader's
    // chain direction picks, Mind Control "attack health bar" tile)
    // are never on-board and ALWAYS need the tray.
    const visibleIds = new Set();
    if (s.lanes) {
      s.lanes.forEach(lane => {
        if (lane.player && lane.player.id !== undefined) visibleIds.add(lane.player.id);
        if (lane.ai && lane.ai.id !== undefined) visibleIds.add(lane.ai.id);
      });
    }
    if (s.player && s.player.hand) {
      s.player.hand.forEach(c => { if (c && c.id !== undefined) visibleIds.add(c.id); });
    }
    if (s.ai && s.ai.hand) {
      s.ai.hand.forEach(c => { if (c && c.id !== undefined) visibleIds.add(c.id); });
    }
    // Filter to candidates that need the tray: skip the healthbar
    // marker (wired separately above) AND skip anything already
    // glowing in place.
    const unmatched = cc.cards.filter(c => {
      if (c.id === '_healthbar_mc') return false;
      if (c.id !== undefined && visibleIds.has(c.id)) return false;
      return true;
    });
    if (!unmatched.length) return;

    // Floating "Discover"-style tray — bottom-anchored panel with a dim
    // backdrop that keeps the board visible. Cards float up, nothing masks
    // the lanes and no phantom lane-7 slot is created.
    const tray = document.createElement('div');
    tray.id = 'choice-tray';
    tray.className = 'choice-tray';
    const title = cc.title || 'Choose a card';
    const desc = cc.desc || '';
    const cardsHtml = unmatched.map((card) => {
      const idx = cc.cards.indexOf(card);
      if (cc.faceDown) {
        return `<div class="choice-card choice-facedown" data-idx="${idx}">?</div>`;
      }
      const costClass = this.getCostClass(card.baseCost || card.cost || 0);
      const typeSigil = card.isDiscardEffect
        ? `<span class="card-type-sigil discard-sigil">&#9670;</span>`
        : (card.attack !== undefined ? `<span class="card-type-sigil char-sigil">&#9733;</span>` : '');
      const stats = card.attack !== undefined
        ? `<span class="stat-circle stat-atk">${card.attack}</span><span class="stat-circle stat-hp">${card.currentHealth || card.health || 0}</span>`
        : '';
      const nameHtml = `<div class="card-name-banner"><div class="card-name">${card.name || 'Unknown'}</div></div>`;
      const costHtml = card.cost !== undefined ? `<span class="card-cost">${card.cost}</span>` : '';
      return `
        <div class="choice-card card ${costClass}" data-idx="${idx}">
          ${costHtml}
          ${typeSigil}
          ${nameHtml}
          <div class="card-desc">${this.formatDesc(card.desc)}</div>
          ${stats}
        </div>`;
    }).join('');
    tray.innerHTML = `
      <div class="choice-tray-backdrop"></div>
      <div class="choice-tray-panel">
        <div class="choice-tray-header">
          <span class="choice-tray-title">${title}</span>
          ${desc ? `<span class="choice-tray-desc">${desc}</span>` : ''}
        </div>
        <div class="choice-tray-cards">${cardsHtml}</div>
      </div>`;
    document.body.appendChild(tray);
    // Wire clicks after insertion
    tray.querySelectorAll('.choice-card').forEach(el => {
      const idx = +el.getAttribute('data-idx');
      el.addEventListener('click', () => cardChoicePick(idx));
    });
  },

  // ===================== MODE SELECT =====================
  // Pre-match screen. Two rows (1v1, 2v2) × two columns (Classic, Deckbuilder).
  // Only 1v1 Classic is enabled in phase 1; the rest show a "coming soon"
  // hint so the roadmap is visible to anyone poking around.
  renderModeSelect(s) {
    const el = document.getElementById('mode-select-overlay');
    if (!el) return;
    // Button factory — `disabled` + `note` drive styling and the tooltip.
    const btn = (id, label, sub, enabled, note, onClick) => {
      const cls = `mode-option${enabled ? '' : ' mode-option-disabled'}`;
      const onc = enabled ? `onclick="${onClick}"` : '';
      const title = enabled ? '' : ` title="${note}"`;
      return `
        <button type="button" class="${cls}" id="${id}"${onc}${title}>
          <div class="mode-option-label">${label}</div>
          <div class="mode-option-sub">${sub}</div>
          ${enabled ? '' : `<div class="mode-option-note">${note}</div>`}
        </button>`;
    };
    el.innerHTML = `
      <div class="mode-panel">
        <button type="button" class="mode-back" onclick="Game.goToMainMenu()" title="Back to main menu">&larr; Menu</button>
        <div class="mode-grid">
          <div class="mode-row-label">Solo · vs AI</div>
          ${btn('mode-1v1-classic', 'Classic Draft',
                'Shared deck of 95 cards. Draft 5 cards + 2 tricks before each match.',
                true, '', "selectMode('1v1','classic')")}
          ${btn('mode-1v1-deck', 'My Deck',
                'Bring your own 30-card deck. Match starts with the first 5 in hand.',
                true, '', "openDeckBuilder()")}
          <div class="mode-row-label">Two on Two</div>
          ${btn('mode-2v2-classic', 'Classic Draft',
                'Teams of two. Each side drafts together from a shared pool.',
                false, 'Not yet available', '')}
          ${btn('mode-2v2-deck', 'My Deck',
                'Teams of two. Each player brings their own deck.',
                false, 'Not yet available', '')}
        </div>
      </div>`;
    // Decorate the mode buttons (.mode-option) + back button with the
    // shared interaction language. render() returns early before
    // reaching the bottom-of-render applyTronFx() call, so we apply
    // explicitly here. Disabled options ([mode-option-disabled] / no
    // onclick) are still selected by the .mode-option entry in the
    // FX list — but the CSS suppresses animations via [disabled] /
    // [aria-disabled] / .mode-option-disabled checks.
    if (this.applyTronFx) this.applyTronFx();
  },

  // ===================== MAIN MENU (phase 4a) =====================
  // Landing screen. Title, five buttons: PLAY, DECK BUILDER, MY DECKS,
  // STATS, SETTINGS. Clicking a button flips Game.state.phase to the
  // target screen and re-renders.
  renderMainMenu(s) {
    const el = document.getElementById('main-menu-overlay');
    if (!el) return;
    // Inline Tron-style SVGs. `stroke: currentColor` + `fill: none` lets
    // the icon inherit the neon cyan hue from the button's text color,
    // and hover-state glows fall out for free via the parent's shadows.
    // All icons drawn on a 24×24 viewBox with 2px strokes so they read
    // clearly at the 28px icon size used in .mm-option-icon.
    const SVG = {
      play: `<svg class="mm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">
               <path d="M7 5 L19 12 L7 19 Z"/>
             </svg>`,
      // Two linked arrows — reads as "two players connected" without
      // needing literal head silhouettes. Stays on-theme with the rest
      // of the line-only Tron icon set.
      multi: `<svg class="mm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">
                <circle cx="7"  cy="8"  r="3"/>
                <circle cx="17" cy="8"  r="3"/>
                <path d="M2 20 c1-3 4-5 5-5"/>
                <path d="M22 20 c-1-3 -4-5 -5-5"/>
                <path d="M9 8 h6"/>
              </svg>`,
      builder: `<svg class="mm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">
                  <rect x="4"  y="5"  width="6" height="14" rx="1"/>
                  <rect x="14" y="5"  width="6" height="14" rx="1"/>
                  <path d="M12 3 v18"/>
                </svg>`,
      decks: `<svg class="mm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">
                <rect x="5"  y="4"  width="10" height="14" rx="1"/>
                <path d="M9 7 h7"/>
                <path d="M9 10 h7"/>
                <rect x="9"  y="6"  width="10" height="14" rx="1" stroke-opacity="0.55"/>
              </svg>`,
      stats: `<svg class="mm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">
                <path d="M4 20 h16"/>
                <rect x="6"  y="12" width="3" height="6"/>
                <rect x="11" y="8"  width="3" height="10"/>
                <rect x="16" y="4"  width="3" height="14"/>
              </svg>`,
      settings: `<svg class="mm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">
                   <!-- Three horizontal sliders — reads unambiguously as
                        "settings / adjustments" and stays on-theme with
                        the minimal Tron line language of the other icons. -->
                   <line x1="3" y1="7"  x2="21" y2="7"/>
                   <circle cx="9"  cy="7"  r="2" fill="#000"/>
                   <line x1="3" y1="12" x2="21" y2="12"/>
                   <circle cx="16" cy="12" r="2" fill="#000"/>
                   <line x1="3" y1="17" x2="21" y2="17"/>
                   <circle cx="7"  cy="17" r="2" fill="#000"/>
                 </svg>`
    };
    const btn = (id, label, sub, icon, onClick) => `
      <button type="button" class="mm-option" id="${id}" onclick="${onClick}">
        <div class="mm-option-icon">${icon}</div>
        <div class="mm-option-text">
          <div class="mm-option-label">${label}</div>
          <div class="mm-option-sub">${sub}</div>
        </div>
      </button>`;
    // Simple question-mark SVG for the tutorial option (no other icon
    // slot conveys "how to play"). Matches the other .mm-svg spec.
    const helpSVG = `<svg class="mm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4.5 2.6c-.9.5-1.5 1-1.5 2"/><line x1="12" y1="17" x2="12" y2="17.2"/></svg>`;
    // Grouped main menu — three logical sections so the 8 entries
    // don't read as a flat wall of buttons. User feedback: "theres
    // too many tabs on the main enu lets condense and combine."
    //
    //   PLAY    — anything that starts a match (solo, multiplayer,
    //             tutorial primer)
    //   DECKS   — deck-management: build new + manage saved
    //   LIBRARY — reference & data: card codex, match history,
    //             win-rate stats
    //
    // Same 8 actions as before, just grouped under section headers
    // for clear visual hierarchy. No sub-page navigation — every
    // button is still one click away from the main menu.
    // Each (label + grid) wrapped in a .mm-section so the panel can
    // distribute them with `justify-content: space-evenly` on mobile.
    // Result: even vertical spacing between Play / Decks / Library +
    // even top/bottom padding around the whole stack. User report:
    // "you can space out the diffrenet sections like 'play' 'decks'
    // and library more vertically give even space between the sections
    // and have even space on the top and bottom of the screen."
    el.innerHTML = `
      <div class="mm-panel">
        <div class="mm-header">
          <h1 class="mm-title">the game</h1>
          <div class="mm-divider" aria-hidden="true"></div>
        </div>
        <div class="mm-section">
          <div class="mm-section-label">Play</div>
          <div class="mm-grid mm-grid-section">
            ${btn('mm-play',    'Solo Match',   'Play against the AI',                                    SVG.play,     "Game.goToModeSelect()")}
            ${(() => {
              // Consolidated Continue Run + Roguelite button. User
              // direction: "Get rid of Continue Run completely, just
              // implement that into the Roguelite button — when it
              // says ascension zero, it'll just say continue last run."
              // Trims the menu by one button when a save exists.
              const savedInfo = (typeof Roguelite !== 'undefined' && Roguelite.savedRunInfo) ? Roguelite.savedRunInfo() : null;
              if (savedInfo) {
                return btn('mm-rogue', 'Roguelite', `${savedInfo.label} · ${savedInfo.fightsWon} fights won`, SVG.play, "Roguelite.resumeRun()");
              }
              return btn('mm-rogue', 'Roguelite', 'Climb a 6-fight ladder — build your deck as you go · beta', SVG.play, "Roguelite.enterRun()");
            })()}
            ${(() => {
              // Daily Run — same starter pools for everyone today.
              // Subline reflects whether today's attempt is locked in.
              const dailyStatus = (typeof Roguelite !== 'undefined' && Roguelite.dailyStatus) ? Roguelite.dailyStatus() : null;
              if (dailyStatus && dailyStatus.attempted) {
                const result = dailyStatus.result;
                const sub = result === 'win'  ? `Today's run: WON · ${dailyStatus.date}`
                          : result === 'loss' ? `Today's run: LOST · ${dailyStatus.date}`
                          : `Today's attempt locked in · ${dailyStatus.date}`;
                return btn('mm-daily', 'Daily Run', sub, SVG.stats, 'Roguelite.enterDailyRun()');
              }
              const sub = dailyStatus ? `Same starter pools for everyone today · ${dailyStatus.date}` : 'Same starter pools for everyone today';
              return btn('mm-daily', 'Daily Run', sub, SVG.stats, 'Roguelite.enterDailyRun()');
            })()}
            ${btn('mm-multi',   'Multiplayer',  'Match a friend over the internet · beta',                SVG.multi,    "UI.openMultiplayer()")}
            ${btn('mm-tutorial','Tutorial',     'Two-minute primer on how to play',                       helpSVG,      "UI.openTutorial()")}
          </div>
        </div>
        <div class="mm-section">
          <div class="mm-section-label">Decks</div>
          <div class="mm-grid mm-grid-section">
            ${btn('mm-builder', 'Deck Builder', 'Build a 30-card deck plus 8 tricks',                     SVG.builder,  "Game.enterDeckBuilder()")}
            ${btn('mm-decks',   'My Decks',     'Your saved decks — edit, copy, or play',                 SVG.decks,    "Game.goToMyDecks()")}
          </div>
        </div>
        <div class="mm-section">
          <div class="mm-section-label">Library</div>
          <div class="mm-grid mm-grid-section">
            ${btn('mm-encyc',   'Codex',        'Every card and trick in the game',                       SVG.decks,    "UI.openEncyclopedia()")}
            ${btn('mm-stats',   'Stats',        'Card win rates and balance trends',                      SVG.stats,    "Game.goToStats()")}
            ${btn('mm-audio',   'Audio Audit',  'Per-card audio coverage + inline splicer · dev',          SVG.settings, "UI.openAudioAudit()")}
            ${btn('mm-sandbox', 'Sandbox',      'Free-play with unlimited energy + spawn any card · dev', SVG.settings, "UI.startSandbox()")}
          </div>
        </div>
      </div>`;
  },
  openTutorial() {
    const ov = document.getElementById('tutorial-overlay');
    if (!ov) return;
    ov.style.display = '';  // clear any inline display:none left by earlier overlay sweeps
    ov.classList.add('open');
    ov.scrollTop = 0;
    const panel = ov.querySelector('.tutorial-panel');
    if (panel) panel.scrollTop = 0;
    if (this.sfx && this.sfx.play) {
      try { this.sfx.play('modalOpen'); } catch (e) {}
    }
  },
  closeTutorial() {
    const ov = document.getElementById('tutorial-overlay');
    if (ov) ov.classList.remove('open');
    if (this.sfx && this.sfx.play) {
      try { this.sfx.play('modalClose'); } catch (e) {}
    }
  },

  // Card / trick encyclopedia — browseable grid of everything in the
  // pool. Filtered live by name + cost-range. Read-only (no add/remove).
  // Data source: CARD_DEFS + TRICK_DEFS. Stats (win rate) surfaced when
  // available so balance outliers read at a glance.
  // ===================== STATE PERSISTENCE HELPERS =====================
  // Pro UIs remember EVERYTHING the user touched: last filter, last
  // sort, scroll position, partial form input. The accumulated effect
  // is "this app respects me." Rule of thumb: persist anything the
  // user CHOSE; don't persist anything that's transient (selectedCard,
  // current modal, in-flight animations).
  // Unified namespace under `clb-ui-` so we don't pollute localStorage
  // with random keys; each persisted preference is a property under
  // a single JSON blob, easier to inspect/migrate later.
  _PERSIST_KEY: 'clb-ui-prefs',
  _persistedPrefs: null,
  _persistGet(path, fallback) {
    if (!this._persistedPrefs) {
      try { this._persistedPrefs = JSON.parse(localStorage.getItem(this._PERSIST_KEY) || '{}'); }
      catch (e) { this._persistedPrefs = {}; }
    }
    // Path can be 'a.b.c' for nested access.
    const parts = path.split('.');
    let cur = this._persistedPrefs;
    for (const k of parts) {
      if (cur == null || typeof cur !== 'object') return fallback;
      cur = cur[k];
    }
    return cur === undefined ? fallback : cur;
  },
  _persistSet(path, value) {
    if (!this._persistedPrefs) {
      try { this._persistedPrefs = JSON.parse(localStorage.getItem(this._PERSIST_KEY) || '{}'); }
      catch (e) { this._persistedPrefs = {}; }
    }
    const parts = path.split('.');
    let cur = this._persistedPrefs;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (typeof cur[k] !== 'object' || cur[k] == null) cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
    try { localStorage.setItem(this._PERSIST_KEY, JSON.stringify(this._persistedPrefs)); }
    catch (e) { /* quota or disabled — silent */ }
  },

  // Codex filter state — restored from persistence on first access,
  // saved on every change via the setter helpers below. `rl` toggles
  // the Roguelite Text+ overlay so each card's text becomes the
  // upgraded `descOverride` (where one exists) instead of its classic
  // desc — handy for browsing the upgrade pool without firing a run.
  _encyc: { section: 'cards', query: '', cost: 'all', rl: false },
  openEncyclopedia() {
    // Restore last-used filter state (section / cost bucket / search
    // query) so opening the codex feels like resuming where you
    // left off, not starting fresh every time.
    const saved = this._persistGet('codex', null);
    if (saved && typeof saved === 'object') {
      Object.assign(this._encyc, saved);
    }
    this.renderEncyclopedia();
    const ov = document.getElementById('encyclopedia-overlay');
    if (ov) {
      ov.classList.remove('classic-overlay-closing');
      ov.style.display = 'flex';
    }
    if (this.sfx && this.sfx.play) {
      try { this.sfx.play('modalOpen'); } catch (e) {}
    }
    // Hide the dev viewport-toggle while this overlay is open.
    document.body.classList.add('clb-toggle-hidden');
  },
  closeEncyclopedia() {
    this._closeClassicOverlay('encyclopedia-overlay');
    // Restore the dev toggle when returning to the menu.
    document.body.classList.remove('clb-toggle-hidden');
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

  // ===================== SANDBOX (dev free-play) =====================
  // Free-play mode: skip draft, unlimited energy, AI is passive, and a
  // floating panel lets you spawn any card / trick into your hand by
  // name. Press `~` (or click the panel toggle) to open the spawner.
  // Console API also exposed: Sandbox.spawn('Hulk'), Sandbox.energy(99),
  // Sandbox.heal(), Sandbox.clearBoard(). User spec: "I'd like to
  // have an area where I can just playtest and have a card in my hand
  // if I want to with unlimited energy."
  startSandbox() {
    // Bypass the menu and start a classic match. We'll skip draft +
    // boost energy after the match initializes.
    Game.startMatch('classic');
    // Mark sandbox mode so per-tick logic can keep energy maxed
    // even after the engine ticks state[player].currency.
    Game.state._sandbox = true;
    // Auto-draft a starting hand so we don't have to click through.
    // We just pick the first option each time.
    const tick = () => {
      const draftEls = Array.from(document.querySelectorAll('.draft-card, .draft-option, .draft-pick, .draft-trick'))
        .filter(c => c.offsetWidth > 0);
      if (draftEls.length) {
        draftEls[0].click();
        setTimeout(tick, 220);
      } else {
        // Draft done — boost energy and open the spawner.
        if (Game.state && Game.state.player) {
          Game.state.player.currency = 99;
          Game.state.player.energy = 99;
        }
        UI.openSandboxPanel();
        UI.render();
      }
    };
    setTimeout(tick, 250);
  },

  openSandboxPanel() {
    let ov = document.getElementById('sandbox-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'sandbox-overlay';
      ov.className = 'sandbox-overlay';
      ov.innerHTML = `
        <div class="sandbox-panel">
          <div class="sandbox-header">
            <span class="sandbox-title">SANDBOX</span>
            <button type="button" class="sandbox-close" aria-label="Close" onclick="UI.closeSandboxPanel()">&times;</button>
          </div>
          <div class="sandbox-controls">
            <button type="button" class="sandbox-btn" onclick="Sandbox.energy(99)">+99 ⚡</button>
            <button type="button" class="sandbox-btn" onclick="Sandbox.heal()">Full HP</button>
            <button type="button" class="sandbox-btn" onclick="Sandbox.clearBoard()">Clear board</button>
            <button type="button" class="sandbox-btn" onclick="Sandbox.advanceRound()">Next round</button>
          </div>
          <input type="search" id="sandbox-search" class="sandbox-search" placeholder="Search any card or trick name..." />
          <div class="sandbox-list" id="sandbox-list"></div>
          <div class="sandbox-hint">Press <kbd>~</kbd> to toggle this panel anytime.</div>
        </div>
      `;
      document.body.appendChild(ov);
      const search = ov.querySelector('#sandbox-search');
      search.addEventListener('input', () => this.renderSandboxList());
    }
    ov.style.display = 'flex';
    this.renderSandboxList();
    setTimeout(() => { const s = document.getElementById('sandbox-search'); if (s) s.focus(); }, 50);
  },

  closeSandboxPanel() {
    const ov = document.getElementById('sandbox-overlay');
    if (ov) ov.style.display = 'none';
  },

  toggleSandboxPanel() {
    const ov = document.getElementById('sandbox-overlay');
    if (!ov || ov.style.display === 'none') this.openSandboxPanel();
    else this.closeSandboxPanel();
  },

  renderSandboxList() {
    const list = document.getElementById('sandbox-list');
    const search = document.getElementById('sandbox-search');
    if (!list) return;
    const q = (search?.value || '').trim().toLowerCase();
    const cardDefs = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS : [];
    const trickDefs = (typeof TRICK_DEFS !== 'undefined') ? TRICK_DEFS : [];
    const all = [
      ...cardDefs.map(d => ({ kind: 'card', def: d })),
      ...trickDefs.map(d => ({ kind: 'trick', def: d })),
    ].filter(e => !q || e.def.name.toLowerCase().includes(q));
    list.innerHTML = all.slice(0, 80).map(e => {
      const cost = e.def.cost ?? 0;
      const stats = e.kind === 'card' ? `<span class="sb-stats">${e.def.attack ?? 0}/${e.def.health ?? 0}</span>` : '';
      const klass = e.kind === 'trick' ? 'sb-row sb-trick' : 'sb-row sb-card';
      return `<div class="${klass}" onclick="Sandbox.spawn('${e.def.name.replace(/'/g, "\\'")}')">
        <span class="sb-cost">${cost}</span>
        <span class="sb-name">${e.def.name}</span>
        ${stats}
        <span class="sb-kind">${e.kind}</span>
      </div>`;
    }).join('');
    if (!all.length) list.innerHTML = '<div class="sb-empty">No matches</div>';
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
      proc('select',    'UI',     'Select tick',       'Short sine click. Fires on selection toggle.'),
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
      proc('blockFull', 'Combat', 'Block meter full','Three-note major chord — fires when block meter caps and absorbs the next hit.'),
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
        desc: 'Looping background music that plays on the menu screens.',
        src: (sfx.MUSIC_SRC || 'audio/menu_music.mp3').split('?')[0],
        play: () => { try { sfx.startMusic(); } catch (e) {} },
      },
      {
        id: 'heal-hp', category: 'Music & Files', kind: 'file',
        name: 'Heal HP cue',
        desc: 'File-backed HP heal sample.',
        src: 'audio/heal-hp.mp3',
        play: () => sfx._playSample('audio/heal-hp.mp3', { fadeIn: 0, fadeOut: 200, maxDur: 1.5 }),
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
    const all = this._systemSfxDirectory();
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
        <h1 class="encyc-title">Audio Audit</h1>
        <div class="aa-summary">
          <span><b>${list.length}</b>/${sysCount} game sounds</span>
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
    const events = isTrick ? ['hover', 'play'] : ['hover', 'play', 'death', 'ability'];
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
        <h1 class="encyc-title">Audio Audit</h1>
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
        <div class="aa-splicer-controls">
          <label>IN <input type="number" class="aa-splicer-in"  step="0.01" min="0" value="0"></label>
          <label>OUT <input type="number" class="aa-splicer-out" step="0.01" min="0" value="0"></label>
          <label>fade-in (s) <input type="number" class="aa-splicer-fadein"  step="0.1" min="0" value="1"></label>
          <label>fade-out (s) <input type="number" class="aa-splicer-fadeout" step="0.1" min="0" value="2"></label>
          <button type="button" class="aa-splicer-preview">▶ Preview slice</button>
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
    const exportBtn  = splicerEl.querySelector('.aa-splicer-export');
    const copyBtn    = splicerEl.querySelector('.aa-splicer-copyffmpeg');
    const status     = splicerEl.querySelector('.aa-splicer-status');
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
    // Drag IN/OUT markers on the canvas for tactile editing.
    let dragging = null;  // 'in' | 'out' | null
    canvas.addEventListener('mousedown', (e) => {
      if (!buf) return;
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) * (canvas.width / r.width);
      const dur = buf.duration;
      const inX  = (parseFloat(inEl.value)  / dur) * canvas.width;
      const outX = (parseFloat(outEl.value) / dur) * canvas.width;
      // Pick whichever marker is closer (within 18px tolerance)
      const dIn  = Math.abs(x - inX);
      const dOut = Math.abs(x - outX);
      if (dIn < 18 && dIn <= dOut) dragging = 'in';
      else if (dOut < 18) dragging = 'out';
      else dragging = null;
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging || !buf) return;
      const r = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(canvas.width, (e.clientX - r.left) * (canvas.width / r.width)));
      const t = (x / canvas.width) * buf.duration;
      if (dragging === 'in')  inEl.value  = Math.min(t, parseFloat(outEl.value) - 0.1).toFixed(2);
      if (dragging === 'out') outEl.value = Math.max(t, parseFloat(inEl.value)  + 0.1).toFixed(2);
      drawWave();
    });
    window.addEventListener('mouseup', () => { dragging = null; });
    [inEl, outEl, fiEl, foEl].forEach(el => el.addEventListener('input', () => drawWave()));
    // Preview the slice with WebAudio gain envelope (fade-in / fade-out)
    let previewSrc = null;
    previewBtn.addEventListener('click', () => {
      if (!buf) return;
      if (previewSrc) { try { previewSrc.stop(); } catch(e){} previewSrc = null; }
      const inT  = parseFloat(inEl.value);
      const outT = parseFloat(outEl.value);
      const fi   = parseFloat(fiEl.value);
      const fo   = parseFloat(foEl.value);
      const sliceLen = Math.max(0.01, outT - inT);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      const vol = (UI.settings && UI.settings.sfxVolume != null) ? UI.settings.sfxVolume : 0.6;
      const t0 = ctx.currentTime;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(vol, t0 + Math.min(fi, sliceLen / 2));
      gain.gain.setValueAtTime(vol, t0 + Math.max(0, sliceLen - fo));
      gain.gain.linearRampToValueAtTime(0, t0 + sliceLen);
      src.connect(gain).connect(ctx.destination);
      src.start(t0, inT, sliceLen);
      previewSrc = src;
      // Animate playhead
      let raf;
      const startedAt = performance.now();
      const tick = () => {
        const elapsed = (performance.now() - startedAt) / 1000;
        if (elapsed >= sliceLen) { drawWave(-1); return; }
        drawWave(inT + elapsed);
        raf = requestAnimationFrame(tick);
      };
      tick();
      src.addEventListener('ended', () => { if (raf) cancelAnimationFrame(raf); drawWave(-1); previewSrc = null; });
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
  _encycSetSection(s) { this._encyc.section = s; this._encyc.cost = 'all'; this._persistSet('codex', this._encyc); this.renderEncyclopedia(); },
  _encycSetCost(c)    { this._encyc.cost = c; this._persistSet('codex', this._encyc); this.renderEncyclopedia(); },
  _encycSetQuery(q)   { this._encyc.query = q || ''; this._persistSet('codex', this._encyc); this.renderEncyclopedia(); },
  _encycToggleRl()    { this._encyc.rl = !this._encyc.rl; this._persistSet('codex', this._encyc); this.renderEncyclopedia(); },
  renderEncyclopedia() {
    const ov = document.getElementById('encyclopedia-overlay');
    if (!ov) return;
    const f = this._encyc;
    const isCards = f.section === 'cards';
    // Filter out roguelite-only cards (Goon/Thug/Brute, Soldier/Mercenary/
    // Operator, Wound/Doubt/Regret) from the classic-mode codex. They're
    // in CARD_DEFS so the engine can name-resolve them during a run but
    // shouldn't show up in the Classic encyclopedia.
    const isRL = (typeof Roguelite !== 'undefined' && Roguelite.isRogueliteOnlyName)
      ? (n) => Roguelite.isRogueliteOnlyName(n) : () => false;
    const rawPool = isCards ? CARD_DEFS : (typeof TRICK_DEFS !== 'undefined' ? TRICK_DEFS : []);
    const pool = rawPool.filter(c => !isRL(c.name));
    const costBuckets = isCards
      ? [ ['all','All'], ['0-3','0-3'], ['4-6','4-6'], ['7-8','7-8'], ['9-10','9-10'] ]
      : [ ['all','All'], ['0-2','0-2'], ['3-4','3-4'], ['5+','5+'] ];
    const inRange = (c) => {
      const n = c.cost || 0;
      if (f.cost === 'all') return true;
      if (f.cost === '0-3') return n <= 3;
      if (f.cost === '4-6') return n >= 4 && n <= 6;
      if (f.cost === '7-8') return n >= 7 && n <= 8;
      if (f.cost === '9-10') return n >= 9;
      if (f.cost === '0-2') return n <= 2;
      if (f.cost === '3-4') return n >= 3 && n <= 4;
      if (f.cost === '5+')  return n >= 5;
      return true;
    };
    const q = (f.query || '').trim().toLowerCase();
    const filtered = pool.filter(c => inRange(c) && (!q || c.name.toLowerCase().includes(q)))
      .slice().sort((a, b) => {
        if ((a.cost || 0) !== (b.cost || 0)) return (a.cost || 0) - (b.cost || 0);
        return a.name.localeCompare(b.name);
      });
    // Codex cards use the SAME chrome as cards in hand — full hand-card
    // dimensions, rarity-tiered borders, stat orbs, ability badges, and
    // the cost diamond in the corner. Tricks keep a compact card-ish look
    // but tinted purple per the trick palette.
    const emptyBody = `<div class="db-grid-empty">No ${isCards ? 'cards' : 'tricks'} match this filter.</div>`;
    let body;
    if (filtered.length) {
      if (isCards) {
        // For each CARD_DEFS entry, synthesize a minimal live-card shape
        // so makeCardEl(fake, inHand=true) produces the exact same visual
        // as a card currently in the player's hand. Board-only status
        // classes (stunned, frozen, MVP star) are skipped because the
        // `inHand` branch of makeCardEl doesn't read them.
        // Roguelite Text+ overlay — when f.rl is on, swap each card's
        // classic desc for its upgraded `descOverride` (if one exists
        // in CARD_TEXT_UPGRADES). Cards without a Text+ entry show
        // their default text unchanged. Upgraded cards also get a
        // small "+" badge so you can see at a glance which cards
        // changed.
        const rlOn = !!f.rl;
        const upgrades = (typeof Roguelite !== 'undefined' && Roguelite.CARD_TEXT_UPGRADES) || {};
        body = filtered.map(def => {
          const costClass = 'cost-' + Math.min(10, Math.max(0, def.cost || 0));
          const abilitiesHtml = (def.abilities && def.abilities.length)
            ? `<div class="card-abilities status-badges">${this.formatAbilityBadges(def.abilities)}</div>` : '';
          const cost = def.cost || 0;
          const _dpPips = cost <= 3 ? 1 : cost <= 6 ? 2 : cost <= 8 ? 3 : 4;
          const rarityPips = `<span class="rarity-strip" aria-hidden="true">${'<span class="rpip"></span>'.repeat(_dpPips)}</span>`;
          const upgrade = rlOn ? upgrades[def.name] : null;
          const desc = upgrade && upgrade.descOverride ? upgrade.descOverride : (def.desc || '');
          const descAttr = desc.replace(/"/g, '&quot;');
          const upgradedClass = upgrade ? ' enc-card-upgraded' : '';
          const upgradeBadge = upgrade
            ? `<span class="enc-rl-badge" title="${(upgrade.name || 'Roguelite Text+').replace(/"/g, '&quot;')}">+</span>` : '';
          // REDESIGN: art-at-top with name overlay (same as makeCardEl).
          // No separate name-banner row — name lives inside the portrait
          // as a translucent bottom strip.
          const portraitFile = UI.getCardArtPath(def.name);
          const portraitHtml = `<div class="card-portrait" style="--portrait-bg:url('${portraitFile}')"><div class="card-name-overlay">${def.name}</div></div>`;
          // [ CARD DATA ] divider was removed — user direction: "it's
          // distracting and it doesn't add anything." The painting →
          // status badges → desc → orbs hierarchy already reads clearly
          // without an explicit seam between the art and the data.
          return `<div class="card hand-card ${costClass} enc-card${upgradedClass}" data-card-name="${def.name}" title="${descAttr}">
            <span class="card-cost">${cost}</span>
            ${rarityPips}
            ${upgradeBadge}
            ${portraitHtml}
            ${abilitiesHtml}
            <div class="card-desc">${this.formatDesc(desc)}</div>
            <span class="stat-circle stat-atk">${def.attack}</span>
            <span class="stat-circle stat-hp">${def.health}</span>
          </div>`;
        }).join('');
      } else {
        // Tricks — render as purple-tinted compact trick cards (mirrors
        // how they appear in the draft + trick panel).
        body = filtered.map(t => {
          const cost = t.cost || 0;
          const abilitiesHtml = (t.abilities && t.abilities.length)
            ? `<div class="card-abilities status-badges">${this.formatAbilityBadges(t.abilities)}</div>` : '';
          const rarityStrip = this.getTrickRarityStrip ? this.getTrickRarityStrip(cost) : '';
          return `<div class="trick-card enc-trick" data-trick-name="${t.name}">
            <span class="trick-cost">${cost}</span>
            ${rarityStrip}
            <div class="trick-name">${t.name}</div>
            ${abilitiesHtml}
            <div class="trick-desc">${this.formatDesc(t.desc || '')}</div>
          </div>`;
        }).join('');
      }
    } else {
      body = emptyBody;
    }
    ov.innerHTML = `
      <div class="encyc-panel">
        <button type="button" class="md-back" onclick="UI.closeEncyclopedia()" title="Back to main menu">&larr; Menu</button>
        <div class="encyc-head">
          <div>
            <div class="encyc-tag">Codex</div>
            <h1 class="encyc-title">Card Encyclopedia</h1>
            <div class="encyc-sub">${filtered.length} of ${pool.length} ${isCards ? 'cards' : 'tricks'}</div>
          </div>
          <div class="encyc-tabs">
            <button type="button" class="db-tab ${f.section==='cards'?'db-filter-active':''}" onclick="UI._encycSetSection('cards')">Cards</button>
            <button type="button" class="db-tab ${f.section==='tricks'?'db-filter-active':''}" onclick="UI._encycSetSection('tricks')">Tricks</button>
          </div>
        </div>
        <div class="encyc-toolbar">
          <div class="db-search-wrap">
            <span class="db-search-icon">⌕</span>
            <input type="search" class="db-search" id="encyc-search" placeholder="Search by name…" value="${q.replace(/"/g, '&quot;')}" oninput="UI._encycSetQuery(this.value)" autocomplete="off"/>
          </div>
          <div class="db-cost-row">
            ${costBuckets.map(([k, lbl]) => `<button type="button" class="db-cost-chip ${f.cost===k?'db-cost-active':''}" onclick="UI._encycSetCost('${k}')">${lbl}</button>`).join('')}
          </div>
          ${isCards ? `<button type="button" class="encyc-rl-toggle ${f.rl ? 'encyc-rl-active' : ''}" onclick="UI._encycToggleRl()" title="Show Roguelite Text+ upgrades on cards that have one">
            <span class="encyc-rl-dot"></span>Roguelite ${f.rl ? 'ON' : 'OFF'}
          </button>` : ''}
        </div>
        <div class="db-grid encyc-grid">${body}</div>
      </div>`;
    // Preserve focus on the search box as the user types.
    const input = document.getElementById('encyc-search');
    if (input && document.activeElement && document.activeElement.id !== 'encyc-search') {
      // Only focus on first open; re-render keeps focus if already active.
    }
    if (input && f.query && document.activeElement === document.body) {
      input.focus();
      try { input.setSelectionRange(f.query.length, f.query.length); } catch (e) {}
    }
    // Decorate codex tabs + cost chips with the Tron interaction layer.
    if (this.applyTronFx) this.applyTronFx();
  },

  // Recent matches log — rolling window of the last N games. Mirrors
  // the main-menu chrome so it doesn't feel grafted-on.
  openMatchHistory() {
    this.renderMatchHistory();
    const ov = document.getElementById('match-history-overlay');
    if (ov) {
      ov.classList.remove('classic-overlay-closing');
      ov.style.display = 'flex';
    }
    if (this.sfx && this.sfx.play) {
      try { this.sfx.play('modalOpen'); } catch (e) {}
    }
    document.body.classList.add('clb-toggle-hidden');
  },
  closeMatchHistory() {
    this._closeClassicOverlay('match-history-overlay');
    document.body.classList.remove('clb-toggle-hidden');
  },
  renderMatchHistory() {
    const ov = document.getElementById('match-history-overlay');
    if (!ov) return;
    const list = this._getMatchHistory().slice().reverse(); // newest first
    // Format timestamps as "Today 15:32" / "2d ago" / "Apr 12" depending on
    // recency — quick-read at a glance. All local time.
    const formatTs = (ms) => {
      const now = Date.now();
      const diffS = Math.floor((now - ms) / 1000);
      if (diffS < 60) return 'just now';
      if (diffS < 3600) return Math.floor(diffS / 60) + 'm ago';
      const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
      if (sameDay) {
        const d = new Date(ms);
        const hh = d.getHours().toString().padStart(2, '0');
        const mm = d.getMinutes().toString().padStart(2, '0');
        return 'Today ' + hh + ':' + mm;
      }
      if (diffS < 86400 * 7) return Math.floor(diffS / 86400) + 'd ago';
      const d = new Date(ms);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    };
    const row = (m) => {
      const winnerLbl = m.winner === 'player' ? 'VICTORY' : m.winner === 'ai' ? 'DEFEAT' : 'DRAW';
      const winnerCls = m.winner === 'player' ? 'mh-win' : m.winner === 'ai' ? 'mh-loss' : 'mh-draw';
      const mvpLbl = m.mvp ? `${m.mvp.name} (${m.mvp.owner === 'player' ? 'you' : 'ai'})` : '—';
      return `<div class="mh-row ${winnerCls}">
        <div class="mh-row-left">
          <div class="mh-verdict">${winnerLbl}</div>
          <div class="mh-meta">${formatTs(m.ts)} · ${m.mode || 'classic'} · ${m.rounds} round${m.rounds === 1 ? '' : 's'}</div>
        </div>
        <div class="mh-row-mid">
          <div class="mh-hp"><span class="mh-hp-player">${m.playerHp}</span> <span class="mh-hp-sep">vs</span> <span class="mh-hp-ai">${m.aiHp}</span></div>
          <div class="mh-hp-label">Final HP</div>
        </div>
        <div class="mh-row-right">
          <div class="mh-mvp-label">MVP</div>
          <div class="mh-mvp-name">${mvpLbl}</div>
        </div>
      </div>`;
    };
    const empty = `<div class="mh-empty">
      <strong>No matches yet.</strong><br>
      Win or lose, every finished game lands here with the MVP card,
      final HP, and round count. Play a match from the main menu to
      get your first entry.
    </div>`;
    const body = list.length ? list.map(row).join('') : empty;
    const clearBtn = list.length ? `<button type="button" class="mh-clear-btn" onclick="if(confirm('Clear all match history?')){UI._clearMatchHistory();UI.renderMatchHistory();}">Clear History</button>` : '';
    // Per-archetype win-rate breakdown — bucket matches by aiArchetype
    // and compute W-L plus win rate. Only matches that recorded an
    // archetype contribute (older entries pre-archetype-field show as
    // "Unrecorded"). Surfaces the data your game already collects.
    const archetypeBreakdown = this._renderArchetypeBreakdown(list);
    ov.innerHTML = `
      <div class="mh-panel">
        <button type="button" class="md-back" onclick="UI.closeMatchHistory()" title="Back to main menu">&larr; Menu</button>
        <h1 class="mh-title">Match History</h1>
        <div class="mh-sub">Last ${this._MATCH_HISTORY_MAX} matches</div>
        ${archetypeBreakdown}
        <div class="mh-list">${body}</div>
        <div class="mh-actions">${clearBtn}</div>
      </div>`;
    // Decorate the back button + clear-history button.
    if (this.applyTronFx) this.applyTronFx();
  },

  // Builds a small "vs <Archetype>: W-L (XX%)" panel above the match
  // list. Helps the player see which matchups they win vs lose.
  // Only renders if at least one match in the history has an archetype
  // recorded (older entries skip).
  _renderArchetypeBreakdown(list) {
    if (!list || !list.length) return '';
    const buckets = {};
    list.forEach(m => {
      if (!m.aiArchetype) return;
      const key = m.aiArchetype;
      if (!buckets[key]) {
        buckets[key] = { name: m.aiArchetypeName || key, wins: 0, losses: 0, draws: 0, total: 0 };
      }
      buckets[key].total++;
      if (m.winner === 'player') buckets[key].wins++;
      else if (m.winner === 'ai') buckets[key].losses++;
      else buckets[key].draws++;
    });
    const keys = Object.keys(buckets);
    if (!keys.length) return '';
    // Sort by total games descending — most-played matchup first.
    keys.sort((a, b) => buckets[b].total - buckets[a].total);
    const rows = keys.map(k => {
      const b = buckets[k];
      const pct = b.total > 0 ? Math.round((b.wins / b.total) * 100) : 0;
      // Color by win rate: green ≥60%, gold 40-59%, red <40%
      const color = pct >= 60 ? 'mh-arch-strong'
                  : pct >= 40 ? 'mh-arch-even'
                              : 'mh-arch-weak';
      return `
        <div class="mh-arch-row ${color}">
          <span class="mh-arch-name">vs ${b.name}</span>
          <span class="mh-arch-record">${b.wins}-${b.losses}${b.draws ? '-' + b.draws : ''}</span>
          <span class="mh-arch-pct">${pct}%</span>
        </div>`;
    }).join('');
    return `
      <div class="mh-arch-panel">
        <div class="mh-arch-title">Win rate by matchup</div>
        <div class="mh-arch-list">${rows}</div>
      </div>`;
  },

  // ===================== VIEWPORT (WEB/MOBILE) TOGGLE =====================
  // Top-left button next to the settings cog that flips body.preview-mobile
  // on/off. Reads/writes the choice to localStorage so reloads remember
  // the user's preference. Updates the icon to reflect the current state
  // (phone icon when in web mode = "click to switch to mobile"; monitor
  // icon when in mobile mode = "click to switch to web").
  _VIEWPORT_KEY: 'clb-viewport-mode',
  toggleViewportMode() {
    const cur = document.body.classList.contains('preview-mobile') ? 'mobile' : 'web';
    const next = cur === 'mobile' ? 'web' : 'mobile';
    this._applyViewportMode(next);
    localStorage.setItem(this._VIEWPORT_KEY, next);
    // Re-render so any open menu/lobby/codex picks up the new container
    // size and re-flows. Simpler than chasing every overlay individually.
    if (typeof Game !== 'undefined' && Game.state) this.render();
  },
  _applyViewportMode(mode) {
    const body = document.body;
    if (mode === 'mobile') body.classList.add('preview-mobile');
    else                   body.classList.remove('preview-mobile');
    // Swap the icon to match the action the next click will perform.
    const icon = document.getElementById('viewport-toggle-icon');
    if (icon) {
      if (mode === 'mobile') {
        // In mobile preview → next click goes back to web → show monitor icon
        icon.innerHTML = '<rect x="3" y="4" width="18" height="13" rx="1"/>'
                       + '<line x1="3" y1="20" x2="21" y2="20"/>'
                       + '<line x1="9" y1="17" x2="9" y2="20"/>'
                       + '<line x1="15" y1="17" x2="15" y2="20"/>';
      } else {
        // In web mode → next click switches to mobile → show phone icon
        icon.innerHTML = '<rect x="6" y="2" width="12" height="20" rx="2"/>'
                       + '<line x1="11" y1="18" x2="13" y2="18"/>';
      }
    }
  },
  // ===================== TRON INTERACTION LANGUAGE =====================
  // Single shared interaction vocabulary for every interactive surface
  // in the app — hover-fill, active-pulse, border-breath, click-flash,
  // disabled-no-current. The CSS half lives at the bottom of style.css
  // (search for "TRON INTERACTION LANGUAGE"); this method is the JS
  // half: it scans the DOM after each render and decorates matching
  // elements with `.tron-fx` + an injected `<span class="tron-sweep">`
  // child + a per-element `--tron-fx-stagger-i` so border breathing
  // is naturally out of phase.
  //
  // Idempotent: safe to call after every render. Already-decorated
  // elements are skipped via the .tron-fx class check.
  //
  // Selector list intentionally enumerated rather than glob-broad so
  // we don't accidentally treat content (card-name spans, status
  // badges) as interactive surfaces. New components should be added
  // here when they're built.
  // Two distinct selector lists:
  //
  //   _TRON_FX_SELECTORS — *button-like* controls. Get the FULL
  //     interaction language: hover-fill sweep + active pulse +
  //     border breath + click flash + disabled handling.
  //
  //   _TRON_BREATHE_SELECTORS — *content cards*. Get ONLY the
  //     border-breathing layer. No sweep, no active pulse — they're
  //     not buttons, they're displays. Decorating them with the
  //     full sweep made content read as buttons.
  //
  // Card containers explicitly EXCLUDED from full FX:
  //   .draft-card        — the two pick cards in the draft phase
  //   .db-deck-row       — a card / trick row in the deck-builder list
  //   .md-deck-card      — saved-deck preview cards in My Decks
  //   .lane              — lane elements (have their own wave + shockwave)
  //   .lane-number       — display, not interactive
  //   .card              — board / hand cards
  //
  // Classes verified against actual DOM output of each renderer.
  _TRON_FX_SELECTORS: [
    // Main menu / mode select / multiplayer lobby
    '.mm-option', '.mode-option',
    '.mp-tab', '.mp-cta', '.mp-leave',
    // Match history
    '.mh-clear-btn', '.md-back',
    // Deck builder — tabs, filter chips, presets, action buttons
    '.db-tab',          // CARDS / TRICKS section tabs (also encyc tabs)
    '.db-cost-chip',    // cost filter chips (0-3, 4-6, 7-8, 9-10)
    '.db-preset',       // preset deck buttons (Aggro / Control / Clear / etc.)
    '.db-save-btn', '.db-load-btn', '.db-share-btn', '.db-import-btn',
    '.db-start-btn', '.db-delete-btn',
    // My Decks chrome (NOT the deck cards themselves)
    '.md-deck-action',
    // Card draft chrome buttons (NOT the two pick cards)
    '.draft-quit-btn', '.draft-mulligan-btn', '.draft-settings-btn',
    // Encyclopedia
    '.encyc-cost-btn',
    // Stats panel
    '.stats-source-btn', '.stats-back',
    // In-game HUD chrome — settings cog + Done button + Undo button
    // (Done & Undo are .btn). Lane numbers are pure display, omitted.
    '.settings-cog', '.btn',
    // Viewport toggle (top-left of html)
    '.viewport-toggle'
  ],
  // Cards — content, not buttons. Border-breathe only, no sweep.
  _TRON_BREATHE_SELECTORS: [
    '.draft-card',
    '.db-deck-row',
    '.md-deck-card'
  ],
  // ---- Chrome perimeter flow tiers ----
  // Three speed tiers control the cycle length of the perimeter
  // packet (slowest → fastest visually). Lane-number circles get a
  // separate synced-pulse class.
  //
  // HUD chrome: HP bars, energy pill, round counter, deck/trick
  //   counters, block circles. Default 6s cycle.
  // Panels: deck-builder frame, draft frame, mode-select panel,
  //   match-history panel, multiplayer lobby panel. Slower 8s.
  // Cards: every card-shaped element (board / hand / draft / deck
  //   builder list rows / saved-deck cards). Low-intensity 5s.
  // HUD chrome perimeter — only on the rectangular HP/block/energy
  // surfaces. The HUD pill (Round/Deck/Tricks readout) handles its
  // own pulse via direct CSS on the inner number boxes — see
  // .hud-count b + .hud-round #round-num at the bottom of style.css.
  // Putting .tron-perimeter on .hud-count caused my ::after rule to
  // hijack .hud-count-deck::after which is the SECOND stacked card
  // icon — cropping the icons in half.
  _TRON_PERIM_HUD_SELECTORS: [
    '.health-bar',
    '.block-circle',
    '.energy-text'
  ],
  _TRON_PERIM_PANEL_SELECTORS: [
    '.mh-panel',
    '.mp-panel',
    '.mode-panel',
    '.deckbuilder-overlay .db-section',
    '.deckbuilder-overlay .db-deck-section',
    '.draft-panel',
    '.encyclopedia-overlay .encyc-panel',
    '.my-decks-overlay .md-panel'
  ],
  _TRON_PERIM_CARD_SELECTORS: [
    '.card',
    '.draft-card',
    '.db-deck-row',
    '.md-deck-card'
  ],
  // Active-state mapping: existing component-specific "selected"
  // classes promoted to the shared .tron-fx-active modifier so the
  // sustained-pulse fires on whichever element is currently the
  // chosen tab/filter/card. Pairs of [decorated-class, active-marker-selector].
  // The decorated-class entry is informational only — JS just runs
  // querySelectorAll on the active-marker-selector and tags hits.
  _TRON_FX_ACTIVE_RULES: [
    ['.mp-tab',           '.mp-tab.mp-tab-active'],
    ['.db-tab',           '.db-tab.db-filter-active'],   // section tabs
    ['.db-cost-chip',     '.db-cost-chip.db-cost-active'],
    ['.db-preset',        '.db-preset.db-preset-active'],
    ['.stats-source-btn', '.stats-source-btn.stats-source-active']
  ],
  applyTronFx() {
    if (typeof document === 'undefined') return;
    let stagger = 0;

    // ---- (a) BUTTON SURFACES — full FX (sweep + breath + active) ----
    const fxSel = this._TRON_FX_SELECTORS.join(', ');
    document.querySelectorAll(fxSel).forEach((el) => {
      // Triple-guarded idempotency:
      //   1. Skip if .tron-fx already present (every render)
      //   2. Even when re-decorating after innerHTML-replacement
      //      (different DOM nodes), the sweep is injected only once
      //      via the existing-child check below.
      if (!el.classList.contains('tron-fx')) {
        el.classList.add('tron-fx');
        el.classList.add('tron-fx-breathe');
      }
      // Inject the sweep child ONLY if the element doesn't already
      // have a .tron-sweep direct child. Catches the case where an
      // element inherited the .tron-fx class from a clone but lost
      // its sweep, AND the case where a previous applyTronFx already
      // added one. Defensive against duplicates.
      if (!el.querySelector(':scope > .tron-sweep')) {
        const sweep = document.createElement('span');
        sweep.className = 'tron-sweep';
        sweep.setAttribute('aria-hidden', 'true');
        el.appendChild(sweep);
      }
      // Per-element stagger index. Set once and preserved across
      // renders so the breath phase doesn't jump when applyTronFx
      // re-runs.
      if (!el.style.getPropertyValue('--tron-fx-stagger-i')) {
        el.style.setProperty('--tron-fx-stagger-i', stagger % 8);
      }
      stagger++;
    });

    // ---- (b) CARD SURFACES — border-breathe only ----
    // Cards aren't interactive; decorating them with the sweep made
    // content read as buttons. They keep ONLY the breathing outline
    // so they participate in the global "alive at rest" feel without
    // pretending to be clickable.
    const breatheSel = this._TRON_BREATHE_SELECTORS.join(', ');
    document.querySelectorAll(breatheSel).forEach((el) => {
      if (!el.classList.contains('tron-fx-breathe')) {
        el.classList.add('tron-fx-breathe');
      }
      // CRITICAL: actively REMOVE any leftover .tron-fx + .tron-sweep
      // that an earlier (over-eager) apply call left on a card. This
      // is the cleanup path for users who reloaded after the v300
      // build that did over-decorate.
      if (el.classList.contains('tron-fx')) {
        el.classList.remove('tron-fx');
      }
      const stray = el.querySelector(':scope > .tron-sweep');
      if (stray) stray.remove();
      if (!el.style.getPropertyValue('--tron-fx-stagger-i')) {
        el.style.setProperty('--tron-fx-stagger-i', stagger % 8);
      }
      stagger++;
    });

    // ---- (c) ACTIVE-STATE SYNC — only on button surfaces ----
    document.querySelectorAll('.tron-fx-active').forEach(el => {
      el.classList.remove('tron-fx-active');
    });
    this._TRON_FX_ACTIVE_RULES.forEach(([_, activeSel]) => {
      document.querySelectorAll(activeSel).forEach(el => {
        if (el.classList.contains('tron-fx')) el.classList.add('tron-fx-active');
      });
    });

    // ---- (d) CHROME PERIMETER FLOW — ambient light around borders ----
    // Three tiers, applied via class. Idempotent: skip elements that
    // already have the class. Each tier's CSS lives in style.css under
    // "TRON CHROME PERIMETER FLOW".
    const tagPerim = (selectors, cls) => {
      const sel = selectors.join(', ');
      document.querySelectorAll(sel).forEach(el => {
        if (!el.classList.contains('tron-perimeter')) {
          el.classList.add('tron-perimeter');
        }
        if (cls && !el.classList.contains(cls)) {
          el.classList.add(cls);
        }
      });
    };
    tagPerim(this._TRON_PERIM_HUD_SELECTORS,   null);                  // 6s default
    tagPerim(this._TRON_PERIM_PANEL_SELECTORS, 'tron-perimeter-slow'); // 8s
    tagPerim(this._TRON_PERIM_CARD_SELECTORS,  'tron-perimeter-card'); // 5s low intensity

    // AI-side HP/block tinted red — paint over the default cyan.
    document.querySelectorAll('.ai-bar .health-bar, .ai-bar .block-circle').forEach(el => {
      if (!el.classList.contains('tron-perimeter-ai')) el.classList.add('tron-perimeter-ai');
    });
  },

  // Auto-init from saved preference on page load. Called from
  // UI.init / late in the boot sequence.
  initViewportMode() {
    // Move the toggle button OUT of body and into the <html> element
    // so it stays in viewport-coordinate space when body gets the
    // transform-clip in mobile-preview mode. Without this, the toggle
    // would visually live inside the 390px phone frame.
    const btn = document.getElementById('viewport-toggle');
    if (btn && btn.parentNode === document.body) {
      document.documentElement.appendChild(btn);
    }
    const saved = localStorage.getItem(this._VIEWPORT_KEY) || 'web';
    this._applyViewportMode(saved);
  },

  // ===================== MULTIPLAYER LOBBY =====================
  // Two-tab card lobby for the friend-share flow. Tabs: "Create Room"
  // (host generates a 4-letter code, shares it with friend) and
  // "Join Room" (friend enters the code). Both tabs share the same
  // chrome — a single room-status card after pairing.
  //
  // Transport selection: by default we use LocalTabTransport (cross-tab
  // BroadcastChannel) for offline / on-device dev. Toggle to PartyKit
  // by entering a server URL into the settings input (saved to
  // localStorage as `clb-mp-server`). Once a public PartyKit deploy
  // exists, the URL will default to that and end-users won't need to
  // touch this — it's a power-user knob.
  _mpState: { tab: 'create', code: null, status: 'idle', you: null, opponent: null },
  openMultiplayer() {
    this._mpInit();
    this._mpRender();
    const ov = document.getElementById('multiplayer-overlay');
    if (ov) { ov.style.display = 'flex'; }
    document.body.classList.add('clb-toggle-hidden');
  },
  closeMultiplayer() {
    const ov = document.getElementById('multiplayer-overlay');
    if (ov) { ov.style.display = 'none'; }
    document.body.classList.remove('clb-toggle-hidden');
    // Don't tear down the multiplayer connection on close — the user
    // might just be glancing back at the menu mid-match. We only call
    // Multiplayer.leave() on explicit Leave Room or Forfeit.
  },
  _mpInit() {
    if (typeof Multiplayer === 'undefined') return;
    if (this._mpInited) return;
    this._mpInited = true;
    Multiplayer.on('roomCreated', (m) => {
      this._mpState.code = m.code;
      this._mpState.you = m.you;
      this._mpState.status = 'waiting';
      this._mpRender();
    });
    Multiplayer.on('roomJoined', (m) => {
      this._mpState.code = m.code;
      this._mpState.you = m.you;
      this._mpState.status = 'paired';
      this._mpRender();
      // Joiner automatically lands in the host's match state when the
      // host pushes its first 'state' broadcast. No further action.
    });
    Multiplayer.on('opponentJoined', (m) => {
      this._mpState.opponent = (m && m.name) || 'Opponent';
      this._mpState.status = 'paired';
      this._mpRender();
      // Host: as soon as opponent joins, kick off a draft and broadcast
      // the initial state so the joiner can mirror it. Keeping classic
      // mode for v1 — deck-builder + custom decks come later via the
      // joinRoom payload.
      if (typeof Game !== 'undefined' && Game.startMultiplayerHost) {
        Game.startMultiplayerHost();
      }
    });
    Multiplayer.on('opponentLeft', () => {
      this._mpState.status = 'opponentLeft';
      this._mpRender();
    });
    Multiplayer.on('error', (e) => {
      this._mpState.status = 'error';
      this._mpState.error = (e && e.message) || 'Connection error';
      this._mpRender();
    });
    Multiplayer.on('state', (m) => {
      // Server pushed authoritative state. Replace local state with
      // the rehydrated copy and re-render. Wired by Game.acceptMultiplayerState
      // so engine-level fields (ai object, current side, etc.) get set
      // correctly; UI just re-renders.
      if (typeof Game !== 'undefined' && Game.acceptMultiplayerState) {
        Game.acceptMultiplayerState(m.state);
      }
      this.render();
    });
  },
  _mpSetTab(t) { this._mpState.tab = t; this._mpRender(); },
  // Transport priority:
  //   1. Custom WebSocket (PartyKit) if user pasted a server URL  — power user
  //   2. LocalTab if `clb-mp-mode === 'local'` localStorage flag    — dev/testing
  //   3. WebRTC (PeerJS public cloud)                                — DEFAULT, real internet play
  // The default is WebRTC so the user can hand the 4-letter code to
  // a friend on a different computer and the game just works peer-to-peer.
  _mpPickTransport() {
    if (typeof Multiplayer === 'undefined') return null;
    const url = (localStorage.getItem('clb-mp-server') || '').trim();
    if (url) return new Multiplayer.WebSocketTransport(url);
    if (localStorage.getItem('clb-mp-mode') === 'local') return new Multiplayer.LocalTabTransport();
    if (typeof Peer === 'undefined') {
      // PeerJS didn't load — fall back to LocalTab so the user at least
      // has SOME way to test. The lobby explainer flags the issue.
      return new Multiplayer.LocalTabTransport();
    }
    return new Multiplayer.WebRTCTransport();
  },
  _mpCreateRoom() {
    if (typeof Multiplayer === 'undefined') { alert('Multiplayer module not loaded.'); return; }
    const transport = this._mpPickTransport();
    if (!transport) { alert('No multiplayer transport available.'); return; }
    transport.open();
    Multiplayer.init(transport);
    Multiplayer.createRoom({ name: this._mpName() });
  },
  _mpJoinRoom() {
    if (typeof Multiplayer === 'undefined') { alert('Multiplayer module not loaded.'); return; }
    const input = document.getElementById('mp-join-code');
    const code = (input && input.value || '').trim().toUpperCase();
    if (code.length !== 4) { alert('Enter the 4-letter room code your friend shared.'); return; }
    const transport = this._mpPickTransport();
    if (!transport) { alert('No multiplayer transport available.'); return; }
    transport.open();
    Multiplayer.init(transport);
    this._mpState.status = 'joining';
    this._mpState.code = code;
    this._mpRender();
    Multiplayer.joinRoom(code, { name: this._mpName() });
  },
  _mpLeaveRoom() {
    if (typeof Multiplayer !== 'undefined') Multiplayer.leave();
    this._mpState = { tab: 'create', code: null, status: 'idle', you: null, opponent: null };
    this._mpRender();
  },
  _mpCopyCode() {
    const c = this._mpState.code;
    if (!c) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(c).catch(() => {});
    }
    // Tiny visual confirm — flash the badge for a moment.
    const el = document.getElementById('mp-code-display');
    if (el) {
      el.classList.add('mp-code-copied');
      setTimeout(() => { if (el) el.classList.remove('mp-code-copied'); }, 700);
    }
  },
  _mpName() {
    // Display name lives in localStorage so it persists across visits;
    // fallback is a friendly anonymous label so the opponent doesn't
    // see "undefined" before the user sets one.
    let n = localStorage.getItem('clb-mp-name') || '';
    if (!n) {
      n = 'Player' + Math.floor(Math.random() * 900 + 100);
      localStorage.setItem('clb-mp-name', n);
    }
    return n;
  },
  // Toggle between WebRTC (internet) and LocalTab (same-browser dev).
  // Persisted in localStorage so the choice sticks across sessions.
  _mpToggleLocalMode() {
    const cur = localStorage.getItem('clb-mp-mode') === 'local';
    if (cur) localStorage.removeItem('clb-mp-mode');
    else     localStorage.setItem('clb-mp-mode', 'local');
    this._mpRender();
  },
  // Power-user knob: PartyKit deployment URL. Lives in localStorage so
  // a curious user can paste a URL once and have all matches go over
  // the production transport. Empty string = LocalTabTransport (dev).
  _mpEditServerUrl() {
    const cur = localStorage.getItem('clb-mp-server') || '';
    const next = prompt(
      'PartyKit server URL (leave blank for local-tab dev mode):\n\n' +
      'Example: wss://card-lane-battle.example.partykit.dev',
      cur
    );
    if (next === null) return;  // user cancelled
    if (next.trim() === '') localStorage.removeItem('clb-mp-server');
    else                    localStorage.setItem('clb-mp-server', next.trim());
    this._mpRender();
  },
  _mpRender() {
    const ov = document.getElementById('multiplayer-overlay');
    if (!ov) return;
    const st = this._mpState;
    const isCreate = st.tab === 'create';
    const tabBtn = (id, label) => `
      <button type="button"
              class="mp-tab ${st.tab === id ? 'mp-tab-active' : ''}"
              onclick="UI._mpSetTab('${id}')">${label}</button>`;
    const url = (localStorage.getItem('clb-mp-server') || '').trim();
    const localMode = localStorage.getItem('clb-mp-mode') === 'local';
    const peerJsLoaded = typeof Peer !== 'undefined';
    let transportLine;
    if (url) {
      transportLine = `<div class="mp-transport-line">Custom server: <code>${url}</code> · <a href="#" onclick="UI._mpEditServerUrl();return false;">change</a></div>`;
    } else if (localMode) {
      transportLine = `<div class="mp-transport-line">Local-tab dev mode · <a href="#" onclick="UI._mpToggleLocalMode();return false;">switch to internet</a></div>`;
    } else if (!peerJsLoaded) {
      transportLine = `<div class="mp-transport-line mp-transport-warn">⚠ PeerJS didn't load — falling back to local-tab. Check network or refresh.</div>`;
    } else {
      transportLine = `<div class="mp-transport-line">Connecting peer-to-peer (WebRTC) · <a href="#" onclick="UI._mpToggleLocalMode();return false;">use local tabs instead</a></div>`;
    }

    // Body switches based on connection status. Idle → tab content
    // (create or join). Otherwise → connection-status card.
    let body = '';
    if (st.status === 'idle') {
      if (isCreate) {
        body = `
          <div class="mp-pane">
            <div class="mp-explainer">
              Click <b>Generate Code</b> below. We'll give you a 4-letter
              room code — text it to a friend and they enter it on their
              own device to join.
            </div>
            <button type="button" class="btn btn-primary mp-cta" onclick="UI._mpCreateRoom()">
              Generate Code
            </button>
          </div>`;
      } else {
        body = `
          <div class="mp-pane">
            <div class="mp-explainer">
              Got a 4-letter code from a friend? Type it in — connects
              directly to their browser, no account needed.
            </div>
            <input id="mp-join-code"
                   class="mp-code-input"
                   maxlength="4"
                   placeholder="CODE"
                   autocapitalize="characters"
                   autocomplete="off"
                   spellcheck="false"
                   oninput="this.value=this.value.toUpperCase()" />
            <button type="button" class="btn btn-primary mp-cta" onclick="UI._mpJoinRoom()">
              Join Room
            </button>
          </div>`;
      }
    } else if (st.status === 'waiting') {
      body = `
        <div class="mp-pane mp-pane-status">
          <div class="mp-status-label">Waiting for opponent</div>
          <div id="mp-code-display" class="mp-code-display" onclick="UI._mpCopyCode()" title="Tap to copy">${st.code || '----'}</div>
          <div class="mp-hint">Share this code with a friend. Tap the code to copy.</div>
          <div class="mp-loader" aria-hidden="true">
            <span></span><span></span><span></span>
          </div>
          <button type="button" class="btn btn-secondary mp-leave" onclick="UI._mpLeaveRoom()">Leave Room</button>
        </div>`;
    } else if (st.status === 'joining') {
      body = `
        <div class="mp-pane mp-pane-status">
          <div class="mp-status-label">Joining ${st.code}…</div>
          <div class="mp-loader" aria-hidden="true">
            <span></span><span></span><span></span>
          </div>
          <button type="button" class="btn btn-secondary mp-leave" onclick="UI._mpLeaveRoom()">Cancel join</button>
        </div>`;
    } else if (st.status === 'paired') {
      body = `
        <div class="mp-pane mp-pane-status">
          <div class="mp-status-label mp-status-go">Connected!</div>
          <div class="mp-pairing-line">${(st.you === 'player' ? 'You' : 'Opponent')} (host) ⟷ ${st.opponent || 'Opponent'}</div>
          <div class="mp-hint">Closing this lobby drops you into the match.</div>
          <button type="button" class="btn btn-primary mp-cta" onclick="UI.closeMultiplayer()">Enter Match</button>
          <button type="button" class="btn btn-secondary mp-leave" onclick="UI._mpLeaveRoom()">Leave Room</button>
        </div>`;
    } else if (st.status === 'opponentLeft') {
      body = `
        <div class="mp-pane mp-pane-status">
          <div class="mp-status-label mp-status-warn">Opponent disconnected</div>
          <div class="mp-hint">They might come back — or you can leave the room.</div>
          <button type="button" class="btn btn-secondary mp-leave" onclick="UI._mpLeaveRoom()">Leave Room</button>
        </div>`;
    } else if (st.status === 'error') {
      body = `
        <div class="mp-pane mp-pane-status">
          <div class="mp-status-label mp-status-warn">Connection error</div>
          <div class="mp-hint">${st.error || 'Something went wrong'}</div>
          <button type="button" class="btn btn-secondary mp-leave" onclick="UI._mpLeaveRoom()">Try Again</button>
        </div>`;
    }

    const tabsRow = (st.status === 'idle')
      ? `<div class="mp-tabs">${tabBtn('create', 'Create Room')}${tabBtn('join', 'Join Room')}</div>`
      : '';
    ov.innerHTML = `
      <div class="mh-panel mp-panel">
        <button type="button" class="md-back" onclick="UI.closeMultiplayer()" title="Back to main menu">&larr; Menu</button>
        <h1 class="mh-title">Multiplayer</h1>
        ${tabsRow}
        ${body}
      </div>`;
    // Re-apply the Tron interaction layer to the freshly-rendered
    // tabs / CTA / leave button so they pick up the hover sweep,
    // active-state pulse on the selected tab, and border breathing.
    if (this.applyTronFx) this.applyTronFx();
  },

  // ===================== MY DECKS (phase 4b) =====================
  // Grid of saved decks (from localStorage) with per-deck actions:
  //   Play   — start a match with this deck
  //   Edit   — load into the deck builder
  //   Copy   — duplicate with an incremented name
  //   Delete — remove from localStorage
  //   Rename — inline rename via prompt()
  // Plus a "New Deck" button that opens the empty builder.
  renderMyDecks(s) {
    const el = document.getElementById('my-decks-overlay');
    if (!el) return;
    const decks = this._dbGetSavedDecks();
    const names = Object.keys(decks).sort();

    const escapeAttr = (str) => String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const deckCard = (name) => {
      const deck = decks[name];
      const cards = deck.cards || [];
      const tricks = deck.tricks || [];
      // Preview: unique cards (max 5) + trick names (max 3)
      const uniqueCards = Array.from(new Set(cards)).slice(0, 6);
      const uniqueTricks = Array.from(new Set(tricks)).slice(0, 4);
      const preview =
        (uniqueCards.length ? uniqueCards.join(', ') + (cards.length > uniqueCards.length ? '…' : '') : '')
        + (uniqueTricks.length ? '<br><span style="color:#d7b3e6">' + uniqueTricks.join(', ') + (tricks.length > uniqueTricks.length ? '…' : '') + '</span>' : '');
      const nameAttr = escapeAttr(name);
      // Validity badge — ✓ READY when cards=30 + tricks=8, else
      // ✗ INCOMPLETE with the missing counts surfaced inline. Lets
      // the user see at a glance which saved decks are ready to
      // play without loading each one individually.
      const isReady = cards.length === 30 && tricks.length === 8;
      const badge = isReady
        ? `<span class="md-deck-badge md-badge-ready" title="Deck is complete and ready to play">✓ READY</span>`
        : `<span class="md-deck-badge md-badge-incomplete" title="Needs exactly 30 cards + 8 tricks">✗ INCOMPLETE</span>`;
      // Disable Play button when the deck isn't valid — clicking it
      // through would just alert() inside mdPlay; gating here makes
      // the affordance clearer.
      const playBtn = isReady
        ? `<button type="button" class="md-action-btn md-action-play" onclick="mdPlay('${nameAttr}')">Play</button>`
        : `<button type="button" class="md-action-btn md-action-play md-action-disabled" title="Edit the deck to reach 30 cards + 8 tricks first" disabled>Play</button>`;
      return `
        <div class="md-deck-card ${isReady ? 'md-deck-ready' : 'md-deck-incomplete'}">
          <div class="md-deck-name">${name}</div>
          ${badge}
          <div class="md-deck-counts">
            <span><b>${cards.length}</b>/30 cards</span>
            <span><b>${tricks.length}</b>/8 tricks</span>
          </div>
          <div class="md-deck-preview">${preview}</div>
          <div class="md-deck-actions">
            ${playBtn}
            <button type="button" class="md-action-btn" onclick="mdEdit('${nameAttr}')">Edit</button>
            <button type="button" class="md-action-btn" onclick="mdCopy('${nameAttr}')">Copy</button>
            <button type="button" class="md-action-btn" onclick="mdRename('${nameAttr}')">Rename</button>
            <button type="button" class="md-action-btn md-action-delete" onclick="mdDelete('${nameAttr}')">Delete</button>
          </div>
        </div>`;
    };

    el.innerHTML = `
      <div class="md-panel">
        <button type="button" class="md-back" onclick="Game.goToMainMenu()" title="Back to main menu">&larr; Menu</button>
        <h1 class="md-title">My Decks</h1>
        <div class="md-subtitle">${names.length} saved ${names.length === 1 ? 'deck' : 'decks'}</div>
        ${names.length
          ? `<div class="md-deck-grid">${names.map(deckCard).join('')}</div>`
          : `<div class="md-empty">
              <strong>No decks saved yet.</strong><br>
              Build a 30-card deck (plus 8 tricks) in the Deck Builder
              and save it here to bring it into matches.
            </div>`}
        <button type="button" class="md-new-btn" onclick="Game.enterDeckBuilder()">+ New Deck</button>
      </div>`;
    // Decorate deck cards + back/new buttons with the interaction layer.
    if (this.applyTronFx) this.applyTronFx();
  },

  // ===================== STATS DASHBOARD (phases 4d + 4e + 4f) =====================
  // Per-card performance table driven by localStorage (browser games) +
  // optional fetched sim data. Source toggle switches between "my games",
  // "sim", and "combined". Auto-flag banner highlights cards whose Wilson
  // CI sits outside [45%, 55%]. Click a row to open the detail modal with
  // per-component breakdown (Tier B/C metrics).
  _statsUi: {
    sort: { key: 'winRate', dir: 'desc' },
    source: 'my',  // 'my' | 'sim' | 'combined'
    view:   'cards', // 'cards' | 'tricks'
    detail: null, // card name, non-null = modal open. NEVER persisted (transient).
    aiWeightsOpen: false,
  },
  // Restore persisted stats prefs (source / view / sort / weights pane)
  // on first read. _persistGet returns the saved object or null.
  _restoreStatsPrefs() {
    const saved = this._persistGet('stats', null);
    if (!saved) return;
    if (saved.source) this._statsUi.source = saved.source;
    if (saved.view)   this._statsUi.view   = saved.view;
    if (saved.sort && typeof saved.sort === 'object') this._statsUi.sort = saved.sort;
    if (typeof saved.aiWeightsOpen === 'boolean') this._statsUi.aiWeightsOpen = saved.aiWeightsOpen;
  },
  _simData: null,       // cached sim card snapshot
  _simTricksData: null, // cached sim tricks snapshot
  _simSummary: null,    // cached sim summary.json (games, avgRounds, seat wins)
  _simHistory: null,    // cached sim history (list of { timestamp, games, cards:{name:{wr,drafts}} })

  // Wilson score interval — 95% confidence. Matches sim/stats.js so
  // sim and browser win rates use the same formula.
  _wilson(wins, n) {
    if (n === 0) return { lo: 0, hi: 0 };
    const z = 1.96;
    const p = wins / n;
    const denom = 1 + (z * z) / n;
    const centre = (p + (z * z) / (2 * n)) / denom;
    const spread = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
    return { lo: Math.max(0, centre - spread), hi: Math.min(1, centre + spread) };
  },

  // Load cached sim data on demand. Non-blocking: if the fetch fails
  // (file not served, CORS, etc.), we just show "Sim data unavailable".
  // Paths tried in order — Classic first since it's the default test
  // target. Loads cards AND tricks in parallel since they're both used
  // by the stats dashboard.
  _loadSimData() {
    if (this._simData !== null) return Promise.resolve(this._simData);
    // Cache-bust each fetch so old service workers (clb-v3 and earlier)
    // that cached sim JSON files cache-first don't keep serving the
    // stale snapshot. The new SW (clb-v4) treats JSON as network-first,
    // making this redundant once it activates — but adding the bust
    // here means clients on the older SW still get fresh data the
    // moment they hit "Reload Sim".
    const cb = '?cb=' + Date.now();
    const loadOne = (filenames) => {
      const tryPath = (i) => {
        if (i >= filenames.length) return {};
        return fetch(filenames[i] + cb)
          .then(r => r.ok ? r.json() : Promise.reject())
          .then(raw => {
            const idx = {};
            (raw || []).forEach(c => { idx[c.name] = c; });
            return idx;
          })
          .catch(() => tryPath(i + 1));
      };
      return tryPath(0);
    };
    // summary.json is a plain object (not an array), so we have its
    // own tiny loader that doesn't try to index by name.
    const loadSummary = (filenames) => {
      const tryPath = (i) => {
        if (i >= filenames.length) return null;
        return fetch(filenames[i] + cb)
          .then(r => r.ok ? r.json() : Promise.reject())
          .catch(() => tryPath(i + 1));
      };
      return tryPath(0);
    };
    return Promise.all([
      loadOne(['sim/data/classic/cards.json',  'sim/data/cards.json',  'sim/data/deckbuilder/cards.json']),
      loadOne(['sim/data/classic/tricks.json', 'sim/data/tricks.json', 'sim/data/deckbuilder/tricks.json']),
      loadSummary(['sim/data/classic/summary.json', 'sim/data/summary.json', 'sim/data/deckbuilder/summary.json']),
      loadSummary(['sim/data/classic/history.json', 'sim/data/history.json', 'sim/data/deckbuilder/history.json'])
    ]).then(([cards, tricks, summary, history]) => {
      this._simData = cards;
      this._simTricksData = tricks;
      this._simSummary = summary || null;
      this._simHistory = (history && Array.isArray(history.runs)) ? history.runs : null;
      return cards;
    });
  },

  // Render the sim-history panel — recent runs + biggest card WR movers
  // between the two most recent runs. Blank if no history (pre-v.first-run).
  _renderSimHistory() {
    const history = this._simHistory;
    if (!history || !history.length) return '';

    const fmtTs = (iso) => {
      if (!iso) return '—';
      const d = new Date(iso);
      if (isNaN(d)) return '—';
      // Show MM/DD HH:MM in local time
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${mm}/${dd} ${hh}:${mi}`;
    };
    const pct = (x) => (x * 100).toFixed(1) + '%';

    // Show the last N runs (most recent first). history.runs is already
    // unshifted so [0] is newest.
    const shown = history.slice(0, 6);

    // Run chips — seat split + game count.
    const runChips = shown.map((r, i) => {
      const playerWR = r.games > 0 ? r.playerWins / r.games : 0;
      const aiWR = r.games > 0 ? r.aiWins / r.games : 0;
      const seatClass = Math.abs(playerWR - aiWR) > 0.05 ? 'stats-hist-biased' : 'stats-hist-balanced';
      const tag = i === 0 ? '<span class="stats-hist-latest">LATEST</span>' : '';
      return `
        <div class="stats-hist-run ${seatClass}">
          ${tag}
          <div class="stats-hist-run-when">${fmtTs(r.timestamp)}</div>
          <div class="stats-hist-run-games">${(r.games || 0).toLocaleString()} games</div>
          <div class="stats-hist-run-split">P ${pct(playerWR)} · AI ${pct(aiWR)}${r.draws ? ` · D${r.draws}` : ''}</div>
        </div>`;
    }).join('');

    // Per-card WR deltas between the latest two runs. Shows the 8 biggest
    // movers (by absolute WR change), with up/down coloring.
    let deltaSection = '';
    if (shown.length >= 2) {
      const cur = shown[0].cards || {};
      const prev = shown[1].cards || {};
      const movers = [];
      for (const name in cur) {
        const c = cur[name];
        const p = prev[name];
        if (!p) continue;
        // Require meaningful sample on both sides so noise doesn't dominate
        if (c.drafts < 30 || p.drafts < 30) continue;
        const delta = c.wr - p.wr;
        if (Math.abs(delta) < 0.01) continue; // ignore <1pp movements
        movers.push({ name, delta, cur: c.wr, prev: p.wr });
      }
      movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      const top = movers.slice(0, 10);
      if (top.length) {
        const rows = top.map(m => {
          const arrow = m.delta > 0 ? '▲' : '▼';
          const deltaClass = m.delta > 0 ? 'stats-hist-up' : 'stats-hist-down';
          const sign = m.delta > 0 ? '+' : '';
          return `
            <div class="stats-hist-mover ${deltaClass}" onclick="statsShowDetail('${m.name.replace(/'/g, "\\'")}')">
              <span class="stats-hist-mover-name">${m.name}</span>
              <span class="stats-hist-mover-delta">${arrow} ${sign}${(m.delta * 100).toFixed(1)}pp</span>
              <span class="stats-hist-mover-wr">${pct(m.prev)} → ${pct(m.cur)}</span>
            </div>`;
        }).join('');
        deltaSection = `
          <div class="stats-hist-movers">
            <div class="stats-hist-movers-title">Biggest WR shifts (last run vs previous)</div>
            <div class="stats-hist-movers-list">${rows}</div>
          </div>`;
      }
    }

    return `
      <div class="stats-hist-panel">
        <div class="stats-hist-title">Sim Run History <span class="stats-hist-count">${history.length} run${history.length === 1 ? '' : 's'} logged</span></div>
        <div class="stats-hist-runs">${runChips}</div>
        ${deltaSection}
      </div>`;
  },

  // Weight coefficients — v7 sabermetrics refactor.
  //   faceDamage   1.2 (winning the hero is the goal)
  //   boardDamage  0.6 (kill credit handles the rest)
  //   energy       2.0 (compounds across turns)
  //   discount     1.5 (future energy with conditionality discount)
  //   damageDenied 0.9 (replaces flat absorbed; freeze/stun/armor included)
  //   debuff       0.7 (ATK/HP stripped from enemies)
  //   heal         1.0 (statsHealLeveraged is already leverage-multiplied)
  //   killTempo    1.0 (sum of victim baseCost — no damage double-count)
  //   advantage    0.85 × avgCardImpact (runtime-computed)
  // Must match game.js and sim/stats.js.
  _IMPACT_WEIGHTS: {
    faceDamage: 1.2, boardDamage: 0.6, energy: 2.0, discount: 1.5,
    damageDenied: 0.9, debuff: 0.7, heal: 1.0, killTempo: 1.0,
    advantage: 0.85
  },

  // Shared weighted-impact formula. Called from `_buildStatsRows`.
  _weightedImpact(rec, avgCardImpact) {
    const w = this._IMPACT_WEIGHTS;
    const draws = rec.cardAdvantage || 0;
    const drawValue = draws * (avgCardImpact || 5) * w.advantage;
    // `rec.healing` may be the leveraged value (post-refactor) or raw
    // (legacy persisted records); treat it uniformly. killTempo
    // similarly falls back to killValue for back-compat.
    const healPts = (rec.healLeveraged != null ? rec.healLeveraged : rec.healing) || 0;
    const killPts = (rec.killTempo != null ? rec.killTempo : rec.killValue) || 0;
    return w.faceDamage   * (rec.hpDamage      || 0) +
           w.boardDamage  * (rec.cardDamage    || 0) +
           w.energy       * (rec.energyGen     || 0) +
           w.discount     * (rec.discount      || 0) +
           w.damageDenied * (rec.absorbed      || 0) +
           w.debuff       * (rec.debuff        || 0) +
           w.heal         * healPts +
           w.killTempo    * killPts +
           drawValue;
  },

  // Per-cost baseline — each cost has its own bucket (0, 1, 2, ... 10).
  // Tighter comparison than the old rarity tiers: a 4-cost card is
  // compared only to other 4-cost cards, not 4-6 lumped together. With
  // only 5-10 cards per cost the baseline is a bit noisier, but it's
  // a much more honest "how does this card compare to its peers?" signal.
  _costBucket(cost) {
    return String(cost);
  },

  // Build the merged per-card stats array for whichever source is active.
  // Two passes: first build raw rows, then compute per-bucket average
  // weighted impact so each row can expose an Impact Index.
  _buildStatsRows(source) {
    const store = this._statsGet();
    const sim = this._simData || {};
    const allNames = new Set([
      ...Object.keys(store.cards || {}),
      ...Object.keys(sim || {})
    ]);

    // --- Pass 1: raw merged records + per-card derived fields ---
    const rows = [];
    allNames.forEach(name => {
      const def = CARD_DEFS.find(d => d.name === name);
      const cost = def ? (def.cost || 0) : 0;
      const local = (store.cards || {})[name] || {};
      const simRec = sim[name] || {};
      // Sim now captures the full v2 schema (see sim/stats.js). For the
      // Sim and Combined tabs, pull all the impact-side fields directly
      // from the sim record instead of zeroing them.
      let rec;
      if (source === 'my') rec = local;
      else if (source === 'sim') rec = {
        drafts: simRec.drafts || 0,
        draftsInWin: simRec.draftsInWin || 0,
        gamesInDeck: simRec.gamesInDeck || simRec.drafts || 0,
        gamesInDeckInWin: simRec.gamesInDeckInWin || simRec.draftsInWin || 0,
        gamesPlayed: simRec.gamesPlayed || 0,
        plays: simRec.plays || 0,
        deaths: simRec.deaths || 0,
        hpDamage: simRec.hpDamage || 0,
        cardDamage: simRec.cardDamage || 0,
        absorbed: simRec.absorbed || 0,
        energyGen: simRec.energyGen || 0,
        cardAdvantage: simRec.cardAdvantage || 0,
        // v3 new components
        healing: simRec.healing || 0,
        discount: simRec.discount || 0,
        debuff: simRec.debuff || 0,
        mvp: simRec.mvp || 0,
        contributionSum: (simRec.contribution || 0) * (simRec.contributionN || simRec.plays || 0),
        contributionN:   simRec.contributionN || simRec.plays || 0,
        kills: simRec.kills || 0,
        freezesApplied: simRec.freezesApplied || 0,
        stunsApplied: simRec.stunsApplied || 0,
        fearsApplied: simRec.fearsApplied || 0,
        mcApplied: simRec.mcApplied || 0,
        _simOnly: true
      };
      else rec = {
        drafts: (local.drafts || 0) + (simRec.drafts || 0),
        draftsInWin: (local.draftsInWin || 0) + (simRec.draftsInWin || 0),
        gamesInDeck: (local.gamesInDeck || 0) + (simRec.gamesInDeck || simRec.drafts || 0),
        gamesInDeckInWin: (local.gamesInDeckInWin || 0) + (simRec.gamesInDeckInWin || simRec.draftsInWin || 0),
        gamesPlayed: (local.gamesPlayed || 0) + (simRec.gamesPlayed || 0),
        plays: (local.plays || 0) + (simRec.plays || 0),
        deaths: (local.deaths || 0) + (simRec.deaths || 0),
        hpDamage: (local.hpDamage || 0) + (simRec.hpDamage || 0),
        cardDamage: (local.cardDamage || 0) + (simRec.cardDamage || 0),
        absorbed: (local.absorbed || 0) + (simRec.absorbed || 0),
        energyGen: (local.energyGen || 0) + (simRec.energyGen || 0),
        cardAdvantage: (local.cardAdvantage || 0) + (simRec.cardAdvantage || 0),
        // v3 new components
        healing: (local.healing || 0) + (simRec.healing || 0),
        discount: (local.discount || 0) + (simRec.discount || 0),
        debuff: (local.debuff || 0) + (simRec.debuff || 0),
        mvp: (local.mvp || 0) + (simRec.mvp || 0),
        contributionSum: (local.contributionSum || 0) + ((simRec.contribution || 0) * (simRec.contributionN || simRec.plays || 0)),
        contributionN: (local.contributionN || 0) + (simRec.contributionN || simRec.plays || 0),
        kills: (local.kills || 0) + (simRec.kills || 0),
        freezesApplied: (local.freezesApplied || 0) + (simRec.freezesApplied || 0),
        stunsApplied: (local.stunsApplied || 0) + (simRec.stunsApplied || 0),
        fearsApplied: (local.fearsApplied || 0) + (simRec.fearsApplied || 0),
        mcApplied: (local.mcApplied || 0) + (simRec.mcApplied || 0)
      };
      if (!rec.drafts && !rec.plays) return;

      const drafts = rec.drafts || 0;
      const wins = rec.draftsInWin || 0;
      const winRate = drafts ? wins / drafts : 0;
      const ci = this._wilson(wins, drafts);
      const plays = rec.plays || 0;
      const gamesInDeck = rec.gamesInDeck || drafts; // fallback for legacy data
      const gamesPlayed = rec.gamesPlayed || 0;
      const playRate = drafts ? plays / drafts : 0;

      // Weighted impact + per-play average (the numerator for Impact Index).
      const weightedImpact = this._weightedImpact(rec);
      const weightedPerPlay = plays > 0 ? weightedImpact / plays : 0;

      // MVP rate — "when this card reaches the board, how often is it the
      // top-impact card on the winning side?". Denominator is
      // `gamesPlayed` (unique games the card appeared in) so cards that
      // enter via foresee / summon / transform get a sane denominator.
      const mvpRate = gamesPlayed > 0 ? (rec.mvp || 0) / gamesPlayed : 0;

      // Contribution share — average % of side impact this card produced
      // across the games it appeared in. Cost-agnostic quality signal.
      const contribution = rec.contributionN > 0 ? rec.contributionSum / rec.contributionN : 0;

      // Raw Impact / E (kept for transparency in the detail modal).
      const totalImpactRaw = (rec.hpDamage || 0) + (rec.cardDamage || 0) + (rec.absorbed || 0) + (rec.energyGen || 0) + (rec.cardAdvantage || 0);
      const rawImpactPerEnergy = plays > 0 && cost > 0 ? (totalImpactRaw / plays) / cost : (cost === 0 ? 999 : 0);

      rows.push({
        name, cost, bucket: this._costBucket(cost),
        drafts, wins, winRate, ci,
        plays, playRate, gamesInDeck, gamesPlayed,
        hpDamage: rec.hpDamage || 0, cardDamage: rec.cardDamage || 0,
        absorbed: rec.absorbed || 0, energyGen: rec.energyGen || 0,
        cardAdvantage: rec.cardAdvantage || 0,
        // v3 components
        healing: rec.healing   || 0,
        discount: rec.discount || 0,
        debuff: rec.debuff     || 0,
        weightedImpact, weightedPerPlay,
        totalImpactRaw, rawImpactPerEnergy,
        mvp: rec.mvp || 0, mvpRate,
        contribution,
        kills: rec.kills || 0,
        freezesApplied: rec.freezesApplied || 0,
        stunsApplied:   rec.stunsApplied   || 0,
        fearsApplied:   rec.fearsApplied   || 0,
        mcApplied:      rec.mcApplied      || 0,
        deaths: rec.deaths || 0,
        _simOnly: !!rec._simOnly
      });
    });

    // --- Pass 2: per-cost MEDIAN baseline → Impact Index ---
    // Median (not mean) so a couple of dominant cards in a small cost
    // bucket (Knull/Dr. Manhattan at cost 10) don't drag the baseline
    // up and squash their peers. Each card contributes its
    // weightedPerPlay once; we take the middle value of that list.
    const bucketBuckets = {};
    rows.forEach(r => {
      if (r.plays <= 0) return;
      (bucketBuckets[r.bucket] = bucketBuckets[r.bucket] || []).push(r.weightedPerPlay);
    });
    const medians = {};
    Object.entries(bucketBuckets).forEach(([b, arr]) => {
      const s = arr.slice().sort((a, c) => a - c);
      const n = s.length;
      medians[b] = n ? (n % 2 === 0 ? (s[n/2-1] + s[n/2]) / 2 : s[(n-1)/2]) : 0;
    });

    rows.forEach(r => {
      const baseline = medians[r.bucket] || 0;
      r.bucketAvg = baseline; // name kept for backwards compat with consumers
      // Impact Index — 1.0 = cost median. >1.2 overperforms, <0.8 under.
      r.impactIndex = baseline > 0 ? r.weightedPerPlay / baseline : null;
    });

    // --- Pass 3: MVP+ (Mike Trout efficiency) ---
    // weightedPerPlay / cost, normalized to 100 = league-average impact-per-cost.
    // 200 = double-efficient ("bomb"), 50 = half-efficient ("filler").
    // Mirrors sim/stats.js so the in-app value matches the report.md value.
    const rates = [];
    rows.forEach(r => {
      if (r.plays <= 0 || r.cost <= 0) return;
      rates.push(r.weightedPerPlay / r.cost);
    });
    const leagueAvgRate = rates.length
      ? rates.reduce((a, b) => a + b, 0) / rates.length
      : 0;
    rows.forEach(r => {
      if (r.plays <= 0 || r.cost <= 0 || leagueAvgRate <= 0) {
        r.mvpPlus = null;
        return;
      }
      r.mvpPlus = Math.round((r.weightedPerPlay / r.cost) / leagueAvgRate * 100);
    });

    return rows;
  },

  _formatPct(x) { return (x * 100).toFixed(1) + '%'; },

  // Build per-trick rows for the Tricks view. Schema (sim + browser):
  //   { drafts, draftsInWin, casts }
  // Win Rate = draftsInWin / drafts (Wilson CI). Play Rate = casts / drafts
  // (can exceed 100% when tricks are drawn mid-game via block-meter).
  _buildTrickRows(source) {
    const store = this._statsGet();
    const sim = this._simTricksData || {};
    const allNames = new Set([
      ...Object.keys(store.tricks || {}),
      ...Object.keys(sim || {})
    ]);
    const rows = [];
    allNames.forEach(name => {
      const def = (typeof TRICK_DEFS !== 'undefined') ? TRICK_DEFS.find(t => t.name === name) : null;
      const cost = def ? (def.cost || 0) : 0;
      const local = (store.tricks || {})[name] || {};
      const simRec = sim[name] || {};
      let rec;
      if (source === 'my') rec = local;
      else if (source === 'sim') rec = {
        drafts: simRec.drafts || 0,
        draftsInWin: simRec.draftsInWin || 0,
        casts: simRec.casts || 0
      };
      else rec = {
        drafts: (local.drafts || 0) + (simRec.drafts || 0),
        draftsInWin: (local.draftsInWin || 0) + (simRec.draftsInWin || 0),
        casts: (local.casts || 0) + (simRec.casts || 0)
      };
      if (!rec.drafts && !rec.casts) return;
      const drafts = rec.drafts || 0;
      const wins = rec.draftsInWin || 0;
      const winRate = drafts ? wins / drafts : 0;
      const ci = this._wilson(wins, drafts);
      const casts = rec.casts || 0;
      const playRate = drafts ? casts / drafts : 0;
      rows.push({ name, cost, drafts, wins, winRate, ci, casts, playRate });
    });
    return rows;
  },

  renderStats(s) {
    const el = document.getElementById('stats-overlay');
    if (!el) return;

    // Lazy-load sim data the first time Stats is opened, then re-render.
    if (this._simData === null) {
      this._loadSimData().then(() => {
        if (Game.state.phase === 'stats') this.renderStats(s);
      });
    }

    const store = this._statsGet();
    const gamesPlayed = (store.__meta && store.__meta.gamesPlayed) || 0;
    const totalRounds = (store.__meta && store.__meta.totalRounds) || 0;
    const localAvgRounds = gamesPlayed > 0 ? (totalRounds / gamesPlayed) : 0;
    const simSummary = this._simSummary;
    const source = this._statsUi.source;
    const view = this._statsUi.view || 'cards';
    const rows = view === 'tricks'
      ? this._buildTrickRows(source)
      : this._buildStatsRows(source);

    // Sorting
    const sort = this._statsUi.sort;
    const sortVal = (r) => {
      switch (sort.key) {
        case 'name': return r.name;
        case 'cost': return r.cost;
        case 'drafts': return r.drafts;
        case 'winRate': return r.winRate;
        case 'playRate': return r.playRate;
        case 'impactIndex': return (r.impactIndex == null ? -1 : r.impactIndex);
        case 'mvpPlus': return (r.mvpPlus == null ? -1 : r.mvpPlus);
        case 'mvpRate': return r.mvpRate;
        case 'contribution': return r.contribution;
        case 'casts': return r.casts;
        default: return r.winRate;
      }
    };
    rows.sort((a, b) => {
      const av = sortVal(a), bv = sortVal(b);
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    // Auto-flag banner — find cards whose entire Wilson CI sits outside
    // the 45-55% band AND have enough samples (>=30 draws) to avoid
    // flagging noise. Over = CI entirely > 55%, under = CI entirely < 45%.
    const MIN_SAMPLES = 30;
    const overperformers = rows.filter(r => r.drafts >= MIN_SAMPLES && r.ci.lo > 0.55)
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 6);
    const underperformers = rows.filter(r => r.drafts >= MIN_SAMPLES && r.ci.hi < 0.45)
      .sort((a, b) => a.winRate - b.winRate)
      .slice(0, 6);

    const sourceBtn = (key, label) => {
      const active = source === key ? ' stats-source-active' : '';
      return `<button type="button" class="stats-source-btn${active}" onclick="statsSetSource('${key}')">${label}</button>`;
    };
    const th = (key, label) => {
      const active = sort.key === key ? ' stats-sort-active' : '';
      const arrow = sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th class="${active}" onclick="statsSort('${key}')">${label}${arrow}</th>`;
    };

    const playRateClamp = (val, raw, drafts) => {
      const disp = val > 1.0 ? '100%+' : this._formatPct(val);
      return `<td title="Raw: ${raw} / ${drafts} = ${(val*100).toFixed(1)}%. Can exceed 100% when the card also appears via non-draft paths (tricks / block-meter draws).">${disp}</td>`;
    };

    // Card-view row renderer — name in rarity neon, ATK/HP in the same
    // green/red chrome as the board stat orbs, so the stats table reads
    // as the same visual family as the in-game card.
    const cardRow = (r) => {
      const wrClass = r.drafts < MIN_SAMPLES
        ? 'stats-lowsample'
        : r.ci.lo > 0.55 ? 'stats-wr-over'
        : r.ci.hi < 0.45 ? 'stats-wr-under'
        : 'stats-wr-ok';
      let indexCell;
      if (r.impactIndex == null) {
        indexCell = '<span class="stats-ci">—</span>';
      } else {
        const idxClass = r.impactIndex > 1.2 ? 'stats-wr-over'
                      : r.impactIndex < 0.8 ? 'stats-wr-under'
                      : 'stats-wr-ok';
        indexCell = `<span class="${idxClass}">${r.impactIndex.toFixed(2)}×</span>`;
      }
      let mvpPlusCell;
      if (r.mvpPlus == null) {
        mvpPlusCell = '<span class="stats-ci">—</span>';
      } else {
        const mvpClass = r.mvpPlus > 120 ? 'stats-wr-over'
                      : r.mvpPlus < 80  ? 'stats-wr-under'
                      : 'stats-wr-ok';
        mvpPlusCell = `<span class="${mvpClass}">${r.mvpPlus}</span>`;
      }
      const def = CARD_DEFS.find(d => d.name === r.name);
      const statsInline = def
        ? `<span class="stats-atkhp"><span class="stats-atk">${def.attack}</span><span class="stats-slash">/</span><span class="stats-hp">${def.health}</span></span>`
        : '';
      return `
        <tr class="${this.getCostClass(r.cost)} ${r.drafts < MIN_SAMPLES ? 'stats-lowsample' : ''}" onclick="statsShowDetail('${r.name.replace(/'/g,"\\'")}')">
          <td class="stats-card-name">
            <span class="stats-name-text">${r.name}</span>
            ${statsInline}
          </td>
          <td class="stats-cost-cell"><span class="stats-cost">${r.cost}</span></td>
          <td>${r.drafts}</td>
          <td class="${wrClass}">${this._formatPct(r.winRate)}<span class="stats-ci">±${((r.ci.hi - r.ci.lo)/2*100).toFixed(1)}%</span></td>
          <td>${indexCell}</td>
          <td>${mvpPlusCell}</td>
          <td>${this._formatPct(r.contribution)}</td>
          <td>${this._formatPct(r.mvpRate)}</td>
        </tr>`;
    };

    // Trick-view row renderer — name in purple neon.
    const trickRow = (r) => {
      const wrClass = r.drafts < MIN_SAMPLES
        ? 'stats-lowsample'
        : r.ci.lo > 0.55 ? 'stats-wr-over'
        : r.ci.hi < 0.45 ? 'stats-wr-under'
        : 'stats-wr-ok';
      return `
        <tr class="stats-trick-row ${r.drafts < MIN_SAMPLES ? 'stats-lowsample' : ''}">
          <td class="stats-card-name">
            <span class="stats-name-text">${r.name}</span>
          </td>
          <td class="stats-cost-cell"><span class="stats-cost stats-cost-trick">${r.cost}</span></td>
          <td>${r.drafts}</td>
          <td class="${wrClass}">${this._formatPct(r.winRate)}<span class="stats-ci">±${((r.ci.hi - r.ci.lo)/2*100).toFixed(1)}%</span></td>
        </tr>`;
    };

    const row = view === 'tricks' ? trickRow : cardRow;

    const flagBanner = (overperformers.length || underperformers.length) ? `
      <div class="stats-flag-banner">
        <div class="stats-flag-title">Balance flags — Wilson 95% CI outside 45–55% (${MIN_SAMPLES}+ samples)</div>
        <div class="stats-flag-list">
          ${overperformers.map(r => `<span class="stats-flag-item stats-flag-over" onclick="statsShowDetail('${r.name.replace(/'/g,"\\'")}')">▲ ${r.name} ${this._formatPct(r.winRate)}</span>`).join('')}
          ${underperformers.map(r => `<span class="stats-flag-item stats-flag-under" onclick="statsShowDetail('${r.name.replace(/'/g,"\\'")}')">▼ ${r.name} ${this._formatPct(r.winRate)}</span>`).join('')}
          ${(!overperformers.length && !underperformers.length) ? '<span style="color:#667078;font-style:italic">No cards flagged.</span>' : ''}
        </div>
      </div>` : '';

    // Sim history panel — shows recent runs + the cards that moved the most
    // between the last two runs. Lets you see "what my last balance change
    // did" at a glance without exporting reports and diff-ing by hand.
    const simHistory = this._renderSimHistory();

    // Definitions panel — always visible so the headline metrics are
    // legible without cross-referencing docs. Condensed to one line each.
    const defsPanel = `
      <div class="stats-defs">
        <div class="stats-def">
          <div class="stats-def-label">Win Rate</div>
          <div class="stats-def-body">% of games won when the card was in the deck. ±95% CI. Flagged when CI is entirely above 55% or below 45%.</div>
        </div>
        <div class="stats-def">
          <div class="stats-def-label">Impact Index</div>
          <div class="stats-def-body">Card's <b>weighted impact per play</b> ÷ the <b>median</b> for its exact cost. <b>1.0× = cost-peer median</b>; >1.2× overperforms, <0.8× underperforms. Median (not mean) so one dominant card can't pull the baseline up and squash its peers.</div>
        </div>
        <div class="stats-def">
          <div class="stats-def-label">MVP+ (efficiency)</div>
          <div class="stats-def-body">Mike-Trout-style <b>impact-per-cost</b> normalized to a league baseline. <b>100 = league average</b>; >120 = bomb, <80 = filler. Cross-cost comparable, unlike Impact Index which only compares within a cost bucket.</div>
        </div>
        <div class="stats-def">
          <div class="stats-def-label">Contribution</div>
          <div class="stats-def-body">Average share of the <b>side's total weighted impact</b> that this card accounted for per game. A 3-cost card at 20% is carrying — a 9-cost card at 5% is underperforming its role.</div>
        </div>
        <div class="stats-def">
          <div class="stats-def-label">MVP Rate</div>
          <div class="stats-def-body">Of the games this card <b>reached the board</b>, the % where it was the top-impact card on the <b>winning side</b>. Losing side's top card gets zero credit.</div>
        </div>
        <div class="stats-def stats-def-formula">
          <div class="stats-def-label">Weighted Impact (v3)</div>
          <div class="stats-def-body">1.0·HP dmg + 0.6·card dmg + 0.5·absorbed + 0.8·energy-gen + 0.7·card-advantage <b>+ 0.8·healing + 0.7·discount + 0.6·debuff</b>. Absorbed includes armor / invincible / evade / phantom-swings from freeze / stun / fear / mind-control. Healing = HP restored. Discount = energy saved by cost-reduction auras. Debuff = ATK points removed from enemies.</div>
        </div>
      </div>`;

    const emptyMsg = rows.length
      ? ''
      : `<div class="stats-empty">No stats yet — play a few matches (or run <code>sim/run.js --stats</code>) and come back.</div>`;

    const detail = this._statsUi.detail
      ? this._renderStatsDetail(this._statsUi.detail, rows)
      : '';

    // AI weights inspection — grouped so the current heuristic is legible
    // at a glance. Useful for auditing "is the AI playing correctly?" — a
    // weight out of whack can explain a card's under/overperformance.
    const weightsPanel = this._renderAiWeights();

    el.innerHTML = `
      <div class="stats-panel">
        <button type="button" class="stats-back" onclick="Game.goToMainMenu()" title="Back to main menu">&larr; Menu</button>
        <h1 class="stats-title">Stats</h1>
        <div class="stats-subtitle">${rows.length} ${view === 'tricks' ? 'trick' : 'card'}${rows.length === 1 ? '' : 's'} in view</div>

        <!-- Sample-size summary — local + sim tallies + avg game length.
             Designers use this to sanity-check sample size before reading
             any individual card's numbers. -->
        <div class="stats-summary">
          <div class="stats-summary-chip">
            <div class="stats-summary-label">My Games</div>
            <div class="stats-summary-value">${gamesPlayed}</div>
            <div class="stats-summary-sub">${localAvgRounds > 0 ? 'avg ' + localAvgRounds.toFixed(1) + ' rounds' : 'no games yet'}</div>
          </div>
          <div class="stats-summary-chip">
            <div class="stats-summary-label">Sim Games</div>
            <div class="stats-summary-value">${simSummary ? simSummary.games.toLocaleString() : '—'}</div>
            <div class="stats-summary-sub">${simSummary ? 'avg ' + simSummary.avgRounds.toFixed(2) + ' rounds' : 'no sim loaded'}</div>
          </div>
          ${simSummary ? `
          <div class="stats-summary-chip">
            <div class="stats-summary-label">Sim Seat Split</div>
            <div class="stats-summary-value">${(simSummary.playerWins/simSummary.games*100).toFixed(1)}% / ${(simSummary.aiWins/simSummary.games*100).toFixed(1)}%</div>
            <div class="stats-summary-sub">P${simSummary.playerWins} / AI${simSummary.aiWins}${simSummary.draws ? ' / D' + simSummary.draws : ''}</div>
          </div>` : ''}
        </div>

        <div class="stats-source-row">
          ${sourceBtn('my', 'My Games')}
          ${sourceBtn('sim', 'Sim')}
          ${sourceBtn('combined', 'Combined')}
        </div>

        <div class="stats-view-row">
          <button type="button" class="stats-view-btn${view === 'cards'  ? ' stats-view-active' : ''}" onclick="statsSetView('cards')">Cards</button>
          <button type="button" class="stats-view-btn${view === 'tricks' ? ' stats-view-active' : ''}" onclick="statsSetView('tricks')">Tricks</button>
        </div>

        <div class="stats-actions-row">
          <button type="button" class="stats-reload-btn" onclick="statsReloadSim()" title="Re-fetch sim/data/cards.json">Reload Sim</button>
          <button type="button" class="stats-export-btn" onclick="statsExportCsv()" title="Download a CSV of the current view">Export CSV</button>
          <button type="button" class="stats-reset-btn" onclick="statsResetLocal()" title="Clear all locally-tracked stats">Reset Local Stats</button>
        </div>

        ${flagBanner}

        ${simHistory}

        ${defsPanel}

        ${emptyMsg || `
        <div class="stats-table-wrap">
          <table class="stats-table">
            <thead>
              <tr>
                ${view === 'tricks' ? `
                  ${th('name',     'Trick')}
                  ${th('cost',     'Cost')}
                  ${th('drafts',   'Games')}
                  ${th('winRate',  'Win Rate')}
                ` : `
                  ${th('name',         'Card')}
                  ${th('cost',         'Cost')}
                  ${th('drafts',       'Games')}
                  ${th('winRate',      'Win Rate')}
                  ${th('impactIndex',  'Impact Index')}
                  ${th('mvpPlus',      'MVP+')}
                  ${th('contribution', 'Contribution')}
                  ${th('mvpRate',      'MVP Rate')}
                `}
              </tr>
            </thead>
            <tbody>
              ${rows.map(row).join('')}
            </tbody>
          </table>
        </div>
        `}

        ${weightsPanel}
      </div>
      ${detail}`;
    // Decorate stats source toggles + back button.
    if (this.applyTronFx) this.applyTronFx();
  },

  // AI weights panel — groups the current AI.WEIGHTS values into their
  // logical sections (draft curve / threat scoring / defensive play /
  // trick eval / lookahead) so a designer can eyeball the heuristic.
  // Collapsible via _statsUi.aiWeightsOpen toggle.
  _renderAiWeights() {
    if (typeof AI === 'undefined' || !AI.WEIGHTS) return '';
    const W = AI.WEIGHTS;
    const open = !!this._statsUi.aiWeightsOpen;
    const groups = [
      { label: 'Draft curve', keys: [
        ['draftBucketDeficitMult',  'Bucket-deficit boost',  'Favors costs short on current deck (more = steeper curve).'],
        ['draftBucketOverPenalty',  'Bucket-over penalty',    'Docks cards in already-saturated cost tiers.'],
        ['draftEarlyFloorBase',     'Early-floor base',       'Minimum cost when drafting first few picks.'],
        ['draftEarlyFloorRamp',     'Early-floor ramp',       'How fast the floor rises per pick.'],
        ['draftLowBias',            'Low-cost bias',          'General pull toward cheap picks.'],
        ['draftHighOverPenalty',    'High-cost over-penalty', 'Penalizes stacking too many 9-10s.'],
        ['draftStatMult',           'Stats-per-cost mult',    'Rewards efficient ATK+HP for the cost.'],
      ]},
      { label: 'Threat scoring', keys: [
        ['threatSplashMult',        'Splash × mult',          'How dangerous splash damage reads.'],
        ['threatOverdriveBonus',    'Overdrive bonus',        'Extra threat weight for double-attack.'],
        ['threatBullseyeBonus',     'Bullseye bonus',         'Bullseye (bypasses block meter) is scary.'],
        ['threatInvincibleBonus',   'Invincible bonus',       'Can\'t be killed this turn — high threat.'],
        ['threatEvadeBonus',        'Evade bonus',            'Harder to kill reliably.'],
        ['threatArmorMult',         'Armor × mult',           'Armor reduces incoming damage.'],
        ['threatTauntBonus',        'Taunt bonus',            'Locks attacks to this card.'],
      ]},
      { label: 'Defensive / block play', keys: [
        ['blockKillBonus',          'Block → kill bonus',     'Reward for blocking with a kill.'],
        ['blockSurviveBonus',       'Block survive bonus',    'Survive the block exchange.'],
        ['blockTradePenalty',       'Bad-trade penalty',      'Discourages unfavorable trades.'],
        ['blockCostDeltaMult',      'Cost-delta multiplier',  'Weights cost difference of the trade.'],
        ['blockExpensiveOverKillPenalty', 'Expensive overkill', 'Avoids blowing a 9-cost on a 1-cost chump.'],
        ['defensiveThresholdNormal','Defensive threshold (Normal)', 'When HP ≤ this, play defensively.'],
        ['defensiveThresholdHard',  'Defensive threshold (Hard)',   'Hard-difficulty defensive trigger.'],
        ['defensiveThresholdEasy',  'Defensive threshold (Easy)',   'Easy-difficulty defensive trigger.'],
      ]},
      { label: 'Trick evaluation', keys: [
        ['trickRemovalHigh',        'Removal (high-threat)',  'Score bump for killing big threats.'],
        ['trickRemovalMid',         'Removal (mid-threat)',   'Score bump for killing mid threats.'],
        ['trickRemovalLowPenalty',  'Low-target penalty',     'Discourages wasting removal on chumps.'],
        ['trickDamageKillable',     'Damage-to-kill bonus',   'Reward for finishing off an enemy.'],
        ['trickFreezeBigThreat',    'Freeze big threat',      'Freezing a threat is valuable.'],
        ['trickBuffAlly',           'Buff ally',              'Base score for a buff effect.'],
        ['trickDrawBonus',          'Draw bonus',             'Card draw = tempo.'],
        ['trickSummonBonus',        'Summon bonus',           'Summoning a body has base value.'],
      ]},
      { label: 'Lookahead (experimental)', keys: [
        ['lookaheadMult',           'Lookahead multiplier',   '0 = disabled. Weights 1-ply combat-sim result.'],
        ['lookaheadHpWeight',       'Lookahead HP weight',    'How much post-combat HP swing counts.'],
      ]},
    ];
    const groupHtml = groups.map(g => {
      const rows = g.keys.map(([k, label, tip]) => {
        const v = W[k];
        const valStr = (typeof v === 'number') ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v);
        return `<div class="ai-weight-row" title="${tip.replace(/"/g,'&quot;')}">
          <span class="ai-weight-label">${label}</span>
          <span class="ai-weight-value">${valStr}</span>
        </div>`;
      }).join('');
      return `
        <div class="ai-weight-group">
          <div class="ai-weight-group-title">${g.label}</div>
          <div class="ai-weight-list">${rows}</div>
        </div>`;
    }).join('');
    return `
      <div class="ai-weights-panel${open ? ' ai-weights-open' : ''}">
        <button type="button" class="ai-weights-toggle" onclick="statsToggleWeights()">
          <span class="ai-weights-caret">${open ? '▼' : '▶'}</span>
          AI Weights
          <span class="ai-weights-hint">${open ? 'Hide' : 'Show heuristic parameters'}</span>
        </button>
        ${open ? `<div class="ai-weights-body">${groupHtml}</div>` : ''}
      </div>`;
  },

  _renderStatsDetail(cardName, rows) {
    const r = rows.find(x => x.name === cardName);
    if (!r) return '';
    const def = CARD_DEFS.find(d => d.name === cardName);
    const stats = def ? `${def.attack}/${def.health}` : '—';
    const ciLo = r.ci.lo * 100, ciHi = r.ci.hi * 100;
    const row = (label, value) => `
      <div class="stats-detail-row">
        <span class="stats-detail-label">${label}</span>
        <span class="stats-detail-value">${value}</span>
      </div>`;
    const avgPerPlay = (n) => r.plays > 0 ? (n / r.plays).toFixed(2) : '—';
    const idxLabel = r.impactIndex == null ? '—' : r.impactIndex.toFixed(2) + '× (vs cost-' + r.bucket + ' peers)';
    const mvpPlusLabel = r.mvpPlus == null ? '—' : r.mvpPlus + ' (100 = league avg)';
    const rawIpeLabel = r.rawImpactPerEnergy === 999 ? '∞' : r.rawImpactPerEnergy.toFixed(2);
    return `
      <div class="stats-detail-backdrop" onclick="if (event.target===this) statsCloseDetail()">
        <div class="stats-detail-panel">
          <button type="button" class="stats-detail-close" onclick="statsCloseDetail()">×</button>
          <div class="stats-detail-name">${r.name}</div>
          <div class="stats-detail-meta">Cost ${r.cost} · ${stats} · ${r.drafts} games (${r.gamesInDeck} unique)${r._simOnly ? ' · sim only' : ''}</div>
          <div class="stats-detail-grid">
            ${row('Win Rate',        this._formatPct(r.winRate) + ' (±' + ((ciHi - ciLo)/2).toFixed(1) + '%)')}
            ${row('95% CI',          ciLo.toFixed(1) + '% – ' + ciHi.toFixed(1) + '%')}
            ${row('Plays / Draft',   this._formatPct(r.playRate))}
            ${row('Impact Index',    idxLabel)}
            ${row('MVP+',            mvpPlusLabel)}
            ${row('Contribution %',  this._formatPct(r.contribution))}
            ${row('MVP Rate',        this._formatPct(r.mvpRate) + ' (' + r.mvp + ' MVP)')}
            ${row('Deaths / Play',   r.plays ? this._formatPct(r.deaths / r.plays) : '—')}
            ${row('Avg Damage',      avgPerPlay((r.hpDamage || 0) + (r.cardDamage || 0)))}
            ${row('Avg Absorbed',    avgPerPlay(r.absorbed))}
            ${row('Avg Energy Gen',  avgPerPlay(r.energyGen))}
            ${row('Avg Card Adv',    avgPerPlay(r.cardAdvantage))}
            ${row('Avg Healing',     avgPerPlay(r.healing))}
            ${row('Avg Discount',    avgPerPlay(r.discount))}
            ${row('Avg Debuff Pts',  avgPerPlay(r.debuff))}
            ${row('Avg Kills / Play',r.plays ? (r.kills / r.plays).toFixed(2) : '—')}
            ${row('Freezes Applied', r.freezesApplied)}
            ${row('Stuns Applied',   r.stunsApplied)}
            ${row('Fears Applied',   r.fearsApplied)}
            ${row('MC Applied',      r.mcApplied)}
            ${row('Raw Impact / E',  rawIpeLabel)}
            ${row('Bucket Avg',      r.bucketAvg ? r.bucketAvg.toFixed(1) + ' weighted/play' : '—')}
          </div>
        </div>
      </div>`;
  },

  // ===================== DECK BUILDER (phase 3) =====================
  // Full deck-builder screen: preset row up top, card grid on the left
  // with cost-tier filters, deck panel on the right with live counts +
  // validation, save/load + Start Match on the bottom. All state lives
  // on Game.state.deckbuilder so re-renders rehydrate the same view.
  renderDeckBuilder(s) {
    const el = document.getElementById('deckbuilder-overlay');
    if (!el) return;
    // Preserve scroll position across re-renders. innerHTML rewrites the
    // grid + deck panels on every click, which would otherwise reset
    // scrollTop to 0 — surfaces as an auto-jump-to-top every time the
    // user adds or removes a card. Capture before, restore after.
    const prevGridScroll = (() => {
      const g = el.querySelector('.db-grid');
      return g ? g.scrollTop : 0;
    })();
    const prevDeckListsScroll = Array.from(el.querySelectorAll('.db-deck-list'))
      .map(e => e.scrollTop);
    // Also capture the active element's id + caret position so the search
    // input stays focused as the user types (every keystroke re-renders,
    // innerHTML nukes the node → focus would bounce to body otherwise).
    const active = document.activeElement;
    const prevFocus = active && el.contains(active) && active.id ? {
      id: active.id,
      selStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
      selEnd:   typeof active.selectionEnd   === 'number' ? active.selectionEnd   : null
    } : null;

    const db = s.deckbuilder || { cards: [], tricks: [], presetName: null };
    const cardCount = db.cards.length;
    const trickCount = db.tricks.length;
    const CARD_MAX = 30, TRICK_MAX = 8, COPY_MAX = 2;
    const valid = cardCount === CARD_MAX && trickCount === TRICK_MAX;

    // Filter tab state — which tab of the collection grid is visible.
    // Cached on `this` so re-renders preserve the user's current filter.
    // Added `query` for the live search box; `sort` for ordering.
    this._dbFilter = this._dbFilter || { section: 'cards', cost: 'all', query: '', sort: 'cost' };
    const filter = this._dbFilter;
    if (typeof filter.query !== 'string') filter.query = '';
    if (!filter.sort) filter.sort = 'cost';

    // Occurrence maps — tell the grid how many copies of each item are
    // currently in the deck (for the "×N" chip + disabled-at-max state).
    const cardCountMap = {};
    db.cards.forEach(n => { cardCountMap[n] = (cardCountMap[n] || 0) + 1; });
    const trickCountMap = {};
    db.tricks.forEach(n => { trickCountMap[n] = (trickCountMap[n] || 0) + 1; });

    const isCards = filter.section === 'cards';
    // Hide roguelite-only cards from the deckbuilder pool too.
    const isRL = (typeof Roguelite !== 'undefined' && Roguelite.isRogueliteOnlyName)
      ? (n) => Roguelite.isRogueliteOnlyName(n) : () => false;
    const rawPool = isCards ? CARD_DEFS : TRICK_DEFS;
    const pool = rawPool.filter(c => !isRL(c.name));
    const costs = isCards ? ['all', '0-3', '4-6', '7-8', '9-10'] : ['all', '0-2', '3-4', '5+'];
    const inRange = (c) => {
      if (filter.cost === 'all') return true;
      const n = c.cost || 0;
      if (filter.cost === '0-3') return n <= 3;
      if (filter.cost === '4-6') return n >= 4 && n <= 6;
      if (filter.cost === '7-8') return n >= 7 && n <= 8;
      if (filter.cost === '9-10') return n >= 9;
      if (filter.cost === '0-2') return n <= 2;
      if (filter.cost === '3-4') return n >= 3 && n <= 4;
      if (filter.cost === '5+')  return n >= 5;
      return true;
    };
    // Apply cost-range filter, name query, and sort. The query is a cheap
    // case-insensitive substring match across the card/trick name — good
    // enough for a ~95-item pool and avoids pulling in fuzzy-search deps.
    const q = filter.query.trim().toLowerCase();
    const matchesQuery = (c) => !q || c.name.toLowerCase().includes(q);
    const filtered = pool.filter(c => inRange(c) && matchesQuery(c)).slice().sort((a, b) => {
      if (filter.sort === 'name') return a.name.localeCompare(b.name);
      if (filter.sort === 'atk') {
        const aa = (a.attack || 0), bb = (b.attack || 0);
        if (aa !== bb) return bb - aa; // desc
        return a.name.localeCompare(b.name);
      }
      // Default: by cost asc, then name
      if ((a.cost || 0) !== (b.cost || 0)) return (a.cost || 0) - (b.cost || 0);
      return a.name.localeCompare(b.name);
    });

    const presetBtn = (key) => {
      const d = (typeof STARTER_DECKS !== 'undefined') ? STARTER_DECKS[key] : null;
      if (!d) return '';
      const active = db.presetName === key ? ' db-preset-active' : '';
      return `<button type="button" class="db-preset${active}" onclick="dbPreset('${key}')" title="${d.description || ''}">${d.name}</button>`;
    };

    const filterBtn = (section, label) => {
      const active = filter.section === section ? ' db-filter-active' : '';
      return `<button type="button" class="db-tab${active}" onclick="dbSetFilter('${section}','all')">${label}</button>`;
    };
    const costBtn = (c) => {
      const active = filter.cost === c ? ' db-cost-active' : '';
      const label = c === 'all' ? 'All' : c;
      return `<button type="button" class="db-cost-chip${active}" onclick="dbSetCost('${c}')">${label}</button>`;
    };

    const gridItemHtml = (item) => {
      const cmap = isCards ? cardCountMap : trickCountMap;
      const count = cmap[item.name] || 0;
      const atMax = count >= COPY_MAX;
      const listCount = isCards ? cardCount : trickCount;
      const listMax = isCards ? CARD_MAX : TRICK_MAX;
      const full = listCount >= listMax;
      const disabled = atMax || full;
      const section = isCards ? 'cards' : 'tricks';
      // Neon ATK / HP split so the numbers match the green-attack,
      // red-health language used on board cards + stat orbs.
      const stats = isCards
        ? `<div class="db-grid-stat-row">
             <span class="db-grid-atk">${item.attack}</span>
             <span class="db-grid-slash">/</span>
             <span class="db-grid-hp">${item.health}</span>
           </div>`
        : '';
      // Ability badges — reuse formatAbilityBadges so the colors + text
      // match the in-game `.status-badge` chrome 1:1 (Armor, Evade, Draw,
      // Bullseye, Overdrive, Invincible, Taunt, Splash, Hunt, Revive,
      // Unresistible, Untrickable, Immunity, Damage Immunity, Mind Control).
      const badges = (item.abilities && item.abilities.length)
        ? `<div class="db-grid-abilities">${this.formatAbilityBadges(item.abilities)}</div>`
        : '';
      const countChip = count > 0
        ? `<span class="db-grid-count${atMax ? ' db-grid-count-max' : ''}">×${count}</span>`
        : '';
      const costClass = this.getCostClass(item.cost || 0);
      const clickAttr = disabled ? '' : `onclick="dbAdd('${section}', ${JSON.stringify(item.name).replace(/"/g,'&quot;')})"`;
      const dimClass = disabled ? ' db-grid-item-disabled' : '';
      // Two-column layout: name + stats on the LEFT, traits stacked on
      // the RIGHT so the badges use the card's horizontal space instead
      // of hugging the bottom border. Cost badge + count chip stay as
      // absolute-positioned corner elements.
      return `
        <div class="db-grid-item ${costClass}${dimClass}" ${clickAttr} title="${(item.desc || '').replace(/"/g,'&quot;')}">
          <div class="db-grid-cost">${item.cost || 0}</div>
          <div class="db-grid-main">
            <div class="db-grid-info">
              <div class="db-grid-name">${item.name}</div>
              ${stats}
            </div>
            ${badges}
          </div>
          ${countChip}
        </div>`;
    };

    // Deck panel rows — group by name with the count baked into the chip,
    // and split visually by cards vs tricks. Click a row → remove one copy.
    // ATK / HP use the same neon green / neon red as the board stat orbs.
    const deckRow = (name, count, section) => {
      const def = section === 'cards'
        ? CARD_DEFS.find(d => d.name === name)
        : TRICK_DEFS.find(d => d.name === name);
      const cost = def ? (def.cost || 0) : 0;
      const stats = section === 'cards' && def
        ? `<span class="db-deck-stats"><span class="db-deck-atk">${def.attack}</span><span class="db-deck-slash">/</span><span class="db-deck-hp">${def.health}</span></span>`
        : '';
      return `
        <div class="db-deck-row ${this.getCostClass(cost)}" onclick="dbRemove('${section}', ${JSON.stringify(name).replace(/"/g,'&quot;')})">
          <span class="db-deck-cost">${cost}</span>
          <span class="db-deck-name">${name}</span>
          ${stats}
          <span class="db-deck-count${count >= COPY_MAX ? ' db-deck-count-max' : ''}">×${count}</span>
        </div>`;
    };
    const cardRows = Object.keys(cardCountMap).sort((a, b) => {
      const ca = CARD_DEFS.find(d => d.name === a);
      const cb = CARD_DEFS.find(d => d.name === b);
      if ((ca?.cost || 0) !== (cb?.cost || 0)) return (ca?.cost || 0) - (cb?.cost || 0);
      return a.localeCompare(b);
    }).map(name => deckRow(name, cardCountMap[name], 'cards')).join('');
    const trickRows = Object.keys(trickCountMap).sort((a, b) => {
      const ta = TRICK_DEFS.find(d => d.name === a);
      const tb = TRICK_DEFS.find(d => d.name === b);
      if ((ta?.cost || 0) !== (tb?.cost || 0)) return (ta?.cost || 0) - (tb?.cost || 0);
      return a.localeCompare(b);
    }).map(name => deckRow(name, trickCountMap[name], 'tricks')).join('');

    // Saved-deck listing from localStorage.
    const saved = this._dbGetSavedDecks();
    const savedNames = Object.keys(saved);

    // Escape query for safe embedding in value attribute (prevents double
    // quote bugs when someone pastes a name with a quote in it).
    const qAttr = (filter.query || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const readyChipCls = valid ? 'db-ready-chip db-ready-ok' : 'db-ready-chip';
    const readyChipText = valid ? 'READY' : 'INCOMPLETE';
    // Meter class helpers — hit target = green; over target (impossible
    // in normal flow, but legacy handling) = red; under target = idle.
    const mCls = (n, max) => n === max ? 'db-meter-ok' : n > max ? 'db-meter-bad' : '';
    // Cost-curve histogram (lives in the HUD header now, replacing the
    // old READY chip slot). Computes avg cost from the drafted cards
    // and surfaces both a numeric "AVG 4.2" badge and a vertical
    // marker line positioned at that cost on the histogram.
    const curveHtml = (() => {
      const buckets = Array(11).fill(0);
      let totalCost = 0, n = 0;
      db.cards.forEach(cn => {
        const def = CARD_DEFS.find(c => c.name === cn);
        if (!def) return;
        const c = Math.min(10, def.cost || 0);
        buckets[c]++;
        totalCost += (def.cost || 0);
        n++;
      });
      const peak = Math.max(1, ...buckets);
      const avg = n > 0 ? (totalCost / n) : 0;
      // Avg marker — percentage across the 1..10 cost range.
      // Each of the 10 bars takes 10% of the rail; bar i covers [i*10%, (i+1)*10%],
      // center at (i + 0.5) * 10%. Avg cost X maps to ((X - 1) + 0.5) * 10%.
      const markerPct = avg > 0 ? Math.max(0, Math.min(100, ((avg - 1) + 0.5) * 10)) : 0;
      const bars = buckets.slice(1).map((count, i) => {
        const cost = i + 1;
        const h = Math.round((count / peak) * 32);
        return `<div class="db-curve-bar" title="${count} × cost ${cost}">
          <div class="db-curve-fill" style="height:${h}px"></div>
          <div class="db-curve-count">${count || ''}</div>
          <div class="db-curve-label">${cost}</div>
        </div>`;
      }).join('');
      const avgBadge = avg > 0 ? `<span class="db-curve-avg">AVG ${avg.toFixed(1)}</span>` : '';
      const marker = avg > 0
        ? `<div class="db-curve-avg-line" style="left: ${markerPct}%" title="Average cost: ${avg.toFixed(2)}"></div>`
        : '';
      return `<div class="db-curve">
        <div class="db-curve-title">Cost Curve${avgBadge}</div>
        <div class="db-curve-bars">${bars}${marker}</div>
      </div>`;
    })();
    // Sort dropdown — three options for now: cost (default), alpha, atk.
    const sortOpts = [
      { k: 'cost', label: 'Cost ↑' },
      { k: 'name', label: 'Name A→Z' },
      { k: 'atk',  label: 'ATK ↓' }
    ].map(o => `<option value="${o.k}"${filter.sort === o.k ? ' selected' : ''}>${o.label}</option>`).join('');

    el.innerHTML = `
      <div class="db-panel">
        <!-- HUD HEADER — back button top-left, centered title,
             meters + cost curve on the right. FORGE tag removed.
             READY chip replaced by the inline cost curve. -->
        <div class="db-hud">
          <button type="button" class="db-back" onclick="dbBack()" title="Back to main menu">&larr; Menu</button>
          <div class="db-hud-center">
            <h1 class="db-hud-title">Deck Builder</h1>
            <div class="db-hud-sub">Assemble 30 cards + 8 tricks — click to add, click a deck row to remove</div>
          </div>
          <div class="db-hud-right">
            <div class="db-meter-strip">
              <div class="db-meter ${mCls(cardCount, CARD_MAX)}">
                <div class="db-meter-label">Cards</div>
                <div class="db-meter-value">${cardCount}<span class="db-meter-slash">/</span>${CARD_MAX}</div>
              </div>
              <div class="db-meter ${mCls(trickCount, TRICK_MAX)}">
                <div class="db-meter-label">Tricks</div>
                <div class="db-meter-value">${trickCount}<span class="db-meter-slash">/</span>${TRICK_MAX}</div>
              </div>
              <div class="db-hud-curve-slot">${curveHtml}</div>
            </div>
          </div>
        </div>

        <!-- DIVIDER with neon diamond node, MM-style -->
        <div class="db-divider"></div>

        <!-- HORIZONTAL LAYERED BODY:
             Row 1: your-deck strip (25-30% height, full width)
             Row 2: collection toolbar + grid (fills remainder) -->
        <div class="db-body">
          <!-- Row 1 — current deck composition, horizontal -->
          <div class="db-deck-strip">
            <div class="db-deck-section db-deck-section-cards">
              <div class="db-deck-heading">
                <span class="db-deck-heading-label">Cards</span>
                <span class="db-deck-heading-count ${mCls(cardCount, CARD_MAX)}">${cardCount}/${CARD_MAX}</span>
              </div>
              <div class="db-deck-list db-deck-list-horizontal">
                ${cardRows || '<div class="db-deck-empty">No cards added yet.</div>'}
              </div>
            </div>
            <div class="db-deck-section db-deck-section-tricks">
              <div class="db-deck-heading">
                <span class="db-deck-heading-label">Tricks</span>
                <span class="db-deck-heading-count ${mCls(trickCount, TRICK_MAX)}">${trickCount}/${TRICK_MAX}</span>
              </div>
              <div class="db-deck-list db-deck-list-horizontal">
                ${trickRows || '<div class="db-deck-empty">No tricks added yet.</div>'}
              </div>
            </div>
          </div>

          <!-- Row 2 — collection (toolbar + grid), full width -->
          <div class="db-collection">
            <div class="db-toolbar">
              <div class="db-tabs">
                ${filterBtn('cards', 'Cards')}
                ${filterBtn('tricks', 'Tricks')}
              </div>
              <div class="db-search-wrap">
                <span class="db-search-icon">⌕</span>
                <input type="text" class="db-search" id="db-search" placeholder="Search by name…" value="${qAttr}" oninput="dbSearch(this.value)" autocomplete="off" />
                ${q ? `<button type="button" class="db-search-clear" onclick="dbSearch('')" title="Clear search">×</button>` : ''}
              </div>
              <div class="db-sort-wrap">
                <select class="db-sort" onchange="dbSetSort(this.value)">${sortOpts}</select>
              </div>
            </div>

            <div class="db-cost-row">
              ${costs.map(costBtn).join('')}
            </div>

            <div class="db-preset-row">
              <span class="db-preset-label">Presets</span>
              ${presetBtn('balanced')}
              ${presetBtn('aggro')}
              ${presetBtn('control')}
              ${presetBtn('reanimator')}
              ${presetBtn('swarm')}
              ${presetBtn('ramp')}
              ${presetBtn('burn')}
              <button type="button" class="db-preset db-preset-clear" onclick="dbClear()" title="Remove all cards + tricks">Clear</button>
            </div>

            <div class="db-grid ${isCards ? '' : 'db-grid-tricks'}">
              ${filtered.length ? filtered.map(gridItemHtml).join('')
                : `<div class="db-grid-empty">No ${isCards ? 'cards' : 'tricks'} match this filter.</div>`}
            </div>
          </div>
        </div>

        <!-- FOOTER — save / load / start. Save + load are meta actions
             (secondary chrome). Start is the primary call-to-action,
             pulsing when the deck is valid. -->
        <div class="db-footer">
          <div class="db-footer-left">
            <input type="text" id="db-save-name" class="db-save-name" placeholder="Deck name" maxlength="30" />
            <button type="button" class="db-save-btn" onclick="dbSave()">Save deck</button>
            <button type="button" class="db-share-btn" onclick="dbExportCode()" title="Copy deck code to clipboard for sharing">Share</button>
            <button type="button" class="db-import-btn" onclick="dbImportCode()" title="Paste a deck code to load it">Import</button>
          </div>
          <div class="db-footer-center">
            ${savedNames.length ? `
              <select id="db-load-select" class="db-load-select">
                <option value="">Load saved deck…</option>
                ${savedNames.map(n => `<option value="${n}">${n}</option>`).join('')}
              </select>
              <button type="button" class="db-load-btn" onclick="dbLoad()">Load</button>
              <button type="button" class="db-delete-btn" onclick="dbDelete()" title="Delete the selected saved deck">Delete</button>
            ` : '<span class="db-footer-empty">No saved decks yet.</span>'}
          </div>
          <div class="db-footer-right">
            <button type="button" class="db-start-btn${valid ? ' db-start-btn-ready' : ' db-start-btn-disabled'}"
              ${valid ? 'onclick="dbStart()"' : `title="Need exactly ${CARD_MAX} cards and ${TRICK_MAX} tricks"`}>
              <span class="db-start-icon">▶</span>
              <span class="db-start-label">Start Match</span>
              <span class="db-start-hint">${cardCount}/${CARD_MAX} · ${trickCount}/${TRICK_MAX}</span>
            </button>
          </div>
        </div>
      </div>`;

    // Restore scroll positions captured above — keeps the grid anchored
    // where the user was browsing instead of snapping back to the top on
    // every add/remove click.
    const newGrid = el.querySelector('.db-grid');
    if (newGrid) newGrid.scrollTop = prevGridScroll;
    const newDeckLists = el.querySelectorAll('.db-deck-list');
    newDeckLists.forEach((e, i) => {
      if (prevDeckListsScroll[i] != null) e.scrollTop = prevDeckListsScroll[i];
    });
    // Restore focus + caret. Without this, typing in the search box
    // loses focus after the first character because re-render swaps the
    // DOM out from under us. Look up the new node by id and re-focus.
    if (prevFocus) {
      const target = document.getElementById(prevFocus.id);
      if (target) {
        try {
          target.focus();
          if (prevFocus.selStart != null && typeof target.setSelectionRange === 'function') {
            target.setSelectionRange(prevFocus.selStart, prevFocus.selEnd ?? prevFocus.selStart);
          }
        } catch (e) { /* select/contenteditable can throw; swallow */ }
      }
    }
    // Decorate every interactive surface this renderer just painted —
    // tabs, cost chips, presets, deck rows, save/share/import/start.
    // render() returned early before reaching the bottom-of-render
    // applyTronFx() call, so we apply explicitly here.
    if (this.applyTronFx) this.applyTronFx();
  },

  // Saved-deck persistence — single JSON blob under a stable key. Cheap
  // (localStorage is synchronous + small payloads) and matches the
  // settings-persistence pattern already in use.
  _DB_STORAGE_KEY: 'clb_saved_decks_v1',
  _dbGetSavedDecks() {
    try {
      const raw = localStorage.getItem(this._DB_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  },
  _dbSetSavedDecks(obj) {
    try { localStorage.setItem(this._DB_STORAGE_KEY, JSON.stringify(obj)); }
    catch (e) { /* quota or disabled — swallow silently */ }
  },
  // Sanitize an imported decks map. Tampered or out-of-date backup JSON
  // could otherwise crash the deckbuilder when it later calls .slice() on
  // a non-array, or surface phantom card names that no longer exist in
  // CARD_DEFS. Returns { decks, dropped } where dropped lists deck names
  // that were rejected so the caller can warn the user.
  _validateImportedDecks(raw) {
    const out = {};
    const dropped = [];
    if (!raw || typeof raw !== 'object') return { decks: out, dropped };
    const cardNames = (typeof CARD_DEFS !== 'undefined')
      ? new Set(CARD_DEFS.map(c => c.name)) : null;
    const trickNames = (typeof TRICK_DEFS !== 'undefined')
      ? new Set(TRICK_DEFS.map(t => t.name)) : null;
    for (const [name, deck] of Object.entries(raw)) {
      if (typeof name !== 'string' || !name.trim()) { dropped.push(String(name)); continue; }
      if (!deck || typeof deck !== 'object') { dropped.push(name); continue; }
      const cards = Array.isArray(deck.cards) ? deck.cards : null;
      const tricks = Array.isArray(deck.tricks) ? deck.tricks : null;
      if (!cards || !tricks) { dropped.push(name); continue; }
      const cleanCards = cards.filter(n => typeof n === 'string' && (!cardNames || cardNames.has(n)));
      const cleanTricks = tricks.filter(n => typeof n === 'string' && (!trickNames || trickNames.has(n)));
      out[name] = { cards: cleanCards, tricks: cleanTricks };
    }
    return { decks: out, dropped };
  },

  // ===================== MATCH HISTORY =====================
  // Rolling log of the last 10 matches — enough for "show me my
  // recent games" without bloating localStorage. Entries capture the
  // outcome, duration, mode, and MVP.
  _MATCH_HISTORY_KEY: 'clb_match_history_v1',
  _MATCH_HISTORY_MAX: 10,
  _getMatchHistory() {
    try {
      const raw = localStorage.getItem(this._MATCH_HISTORY_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  },
  _setMatchHistory(list) {
    try { localStorage.setItem(this._MATCH_HISTORY_KEY, JSON.stringify(list.slice(-this._MATCH_HISTORY_MAX))); }
    catch (e) {}
  },
  _recordMatchInHistory(winner) {
    const s = Game.state;
    if (!s) return;
    // Compute a lightweight entry. MVP = highest statsMVP card across
    // both hand + board + deadPile, or blank if stats not tracked.
    const mvp = this._pickHistoryMvp(s);
    const entry = {
      ts: Date.now(),
      winner: winner,                                  // 'player' | 'ai' | null (draw)
      rounds: s.round || 0,
      mode: (s.mode && s.mode.deck) || 'classic',
      playerHp: Math.max(0, s.player ? s.player.health : 0),
      aiHp: Math.max(0, s.ai ? s.ai.health : 0),
      mvp: mvp ? { name: mvp.name, owner: mvp.owner } : null,
      // Archetype tracking — set by Game.buildDecks when an AI deck
      // is chosen. Lets the match-history panel surface "vs Aggro:
      // 7-3" stats. Falls back to null for classic-mode matches
      // where there's no distinct archetype (shared draft pool).
      aiArchetype:     s.aiArchetype || null,
      aiArchetypeName: s.aiArchetypeName || null
    };
    const list = this._getMatchHistory();
    list.push(entry);
    this._setMatchHistory(list);
    // Save a fuller replay payload too — just the last match's full
    // log + HP history for now (don't need every past match's replay
    // since the history list holds only 10 entries). Key is stable so
    // "View Replay" from the game-over screen always picks up the
    // most recent game.
    this._saveReplay(entry);
  },
  _REPLAY_KEY: 'clb_last_replay_v1',
  _saveReplay(summary) {
    const s = Game.state;
    if (!s) return;
    try {
      const payload = {
        v: 1,
        summary: summary,
        log: (s.log || []).slice(),
        hpHistory: (s._hpHistory || []).slice()
      };
      localStorage.setItem(this._REPLAY_KEY, JSON.stringify(payload));
    } catch (e) { /* quota / disabled */ }
  },
  _loadReplay() {
    try {
      const raw = localStorage.getItem(this._REPLAY_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },
  openReplay() {
    const r = this._loadReplay();
    if (!r) { alert('No replay saved yet. Finish a match first.'); return; }
    this._renderReplayOverlay(r);
  },
  // Copy a compact text summary of the last match to clipboard — a
  // sharable "I just won vs VOLT in 6 rounds, 22 HP left, MVP Hulk"
  // one-liner for Discord/Twitter. Also tries the Web Share API on
  // mobile (native share sheet), falling back to clipboard on
  // browsers that don't support it. Includes the deck code too so
  // people can copy-paste your winning build.
  shareResultSummary() {
    const replay = this._loadReplay();
    if (!replay || !replay.summary) { alert('No recent match to share.'); return; }
    const s = replay.summary;
    const verdict = s.winner === 'player' ? 'WON' : s.winner === 'ai' ? 'LOST' : 'DREW';
    const persona = this._currentAiPersonality;
    const opp = persona ? `${persona.name} (${persona.tag})` : 'AI';
    const mvpLine = s.mvp ? `MVP: ${s.mvp.name} (${s.mvp.owner === 'player' ? 'yours' : "theirs"})` : '';
    const lines = [
      `Card Lane Battle — ${verdict} vs ${opp}`,
      `Rounds: ${s.rounds}  ·  HP: ${s.playerHp} / ${s.aiHp}`,
      mvpLine,
      '',
      `Mode: ${s.mode || 'classic'}`
    ].filter(Boolean);
    const text = lines.join('\n');
    // Try Web Share API first (mobile native share sheet).
    if (navigator.share) {
      navigator.share({ title: 'Card Lane Battle', text }).catch(() => {
        this._copyToClipboard(text);
      });
      return;
    }
    this._copyToClipboard(text);
  },
  _copyToClipboard(text) {
    const flash = (msg) => {
      if (this.showAITrickToast) this.showAITrickToast('Copied to clipboard', msg, 'trick');
      else alert(msg);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => flash('Match summary — paste anywhere'),
        () => { window.prompt('Copy your match summary:', text); }
      );
    } else {
      window.prompt('Copy your match summary:', text);
    }
  },

  // ===================== AAA SHARE CARD =====================
  // Opens the share-card modal and renders a 1080x1080 canvas
  // summary the user can save (PNG download) or copy to clipboard
  // (Image API). Pulls from the same replay data the text share
  // uses so the two stay consistent. The image is built top-down:
  //   1. Background: dark Tron grid + theme accent gradient
  //   2. Headline: VICTORY / DEFEAT (color-coded)
  //   3. MVP card name + score
  //   4. HP curve mini-chart (player vs AI lines)
  //   5. Footer: rounds, mode, AI persona, date
  // Each pass below builds a discrete chunk so future variants can
  // remix layout without touching every step.
  openShareCardModal() {
    const modal = document.getElementById('share-card-modal');
    if (!modal) return;
    const canvas = document.getElementById('share-card-canvas');
    if (!canvas) return;
    this._buildShareCardImage(canvas);
    modal.classList.add('open');
    // ESC closes — install a one-shot listener that auto-removes.
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeShareCardModal();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
    this._scmKeyListener = onKey;
  },

  closeShareCardModal() {
    const modal = document.getElementById('share-card-modal');
    if (modal) modal.classList.remove('open');
    if (this._scmKeyListener) {
      document.removeEventListener('keydown', this._scmKeyListener);
      this._scmKeyListener = null;
    }
  },

  // Trigger PNG download. Uses canvas.toBlob → URL.createObjectURL
  // → invisible <a download> click → URL.revokeObjectURL. File name
  // is `card-lane-<verdict>-<yyyymmdd-hhmm>.png`.
  downloadShareCard() {
    const canvas = document.getElementById('share-card-canvas');
    if (!canvas) return;
    const verdict = this._scmLastVerdict || 'match';
    const stamp = this._scmStamp();
    const name = `card-lane-${verdict.toLowerCase()}-${stamp}.png`;
    canvas.toBlob((blob) => {
      if (!blob) { this._scmToast('Save failed — try Copy instead'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      this._scmToast('Saved to Downloads');
    }, 'image/png');
  },

  // Try the Clipboard API (image MIME). Falls back to a "long-press
  // the canvas to copy" hint on browsers where it's not supported.
  copyShareCard() {
    const canvas = document.getElementById('share-card-canvas');
    if (!canvas) return;
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
      this._scmToast('Long-press the image to copy');
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) { this._scmToast('Copy failed'); return; }
      try {
        const item = new ClipboardItem({ 'image/png': blob });
        navigator.clipboard.write([item]).then(
          () => this._scmToast('Image copied'),
          () => this._scmToast('Copy blocked — try Download')
        );
      } catch (e) {
        this._scmToast('Copy not supported here');
      }
    }, 'image/png');
  },

  _scmStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  },

  _scmToast(msg) {
    const t = document.getElementById('scm-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._scmToastTimer);
    this._scmToastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  },

  _buildShareCardImage(canvas) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    // Resolve theme accent for this build. Falls back to cyan.
    const cs = getComputedStyle(document.body);
    const themeRgb = (cs.getPropertyValue('--theme-rgb') || '79, 195, 247').trim();
    const accent = `rgb(${themeRgb})`;
    const accentDim = `rgba(${themeRgb}, 0.35)`;
    const accentSoft = `rgba(${themeRgb}, 0.12)`;

    // Pull the replay summary so the card matches Share Result.
    const replay = this._loadReplay && this._loadReplay();
    const summary = (replay && replay.summary) || {};
    const winner = summary.winner || (Game.state ? Game.state.winner : null);
    const verdict = winner === 'player' ? 'VICTORY' : winner === 'ai' ? 'DEFEAT' : 'DRAW';
    this._scmLastVerdict = verdict;
    const verdictColor = winner === 'player' ? accent : winner === 'ai' ? '#e74c3c' : '#bdc3c7';

    // ----- LAYER 1: BACKGROUND -----
    // Dark base
    ctx.fillStyle = '#050a10';
    ctx.fillRect(0, 0, W, H);
    // Radial accent from upper-left
    const grad = ctx.createRadialGradient(W * 0.2, H * 0.15, 0, W * 0.5, H * 0.5, W * 0.9);
    grad.addColorStop(0, accentSoft);
    grad.addColorStop(0.5, 'rgba(0, 0, 0, 0.10)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    // Tron grid
    ctx.strokeStyle = accentDim;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const step = 60;
    for (let x = 0; x <= W; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
    for (let y = 0; y <= H; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();
    // Outer frame
    ctx.strokeStyle = accent;
    ctx.lineWidth = 4;
    ctx.strokeRect(20, 20, W - 40, H - 40);
    ctx.lineWidth = 1;
    ctx.strokeStyle = accentDim;
    ctx.strokeRect(36, 36, W - 72, H - 72);

    // Diagonal corner cuts for chrome
    ctx.fillStyle = accent;
    [[20, 20, 1, 1], [W - 20, 20, -1, 1], [20, H - 20, 1, -1], [W - 20, H - 20, -1, -1]].forEach(([x, y, sx, sy]) => {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + sx * 36, y);
      ctx.lineTo(x, y + sy * 36);
      ctx.closePath();
      ctx.fill();
    });

    // ----- LAYER 2: HEADLINE -----
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '500 28px "Rajdhani", "Inter", sans-serif';
    ctx.fillText('CARD LANE BATTLE', W / 2, 130);

    ctx.fillStyle = verdictColor;
    ctx.font = '800 140px "Rajdhani", "Inter", sans-serif';
    ctx.shadowColor = verdictColor;
    ctx.shadowBlur = 28;
    ctx.fillText(verdict, W / 2, 270);
    ctx.shadowBlur = 0;

    // Underline divider
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W * 0.25, 310);
    ctx.lineTo(W * 0.75, 310);
    ctx.stroke();

    // ----- LAYER 3: MVP -----
    const mvp = summary.mvp;
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '600 22px "Rajdhani", sans-serif';
    ctx.fillText('MATCH MVP', W / 2, 370);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 60px "Rajdhani", sans-serif';
    const mvpName = mvp ? mvp.name : '—';
    ctx.fillText(mvpName, W / 2, 440);
    if (mvp) {
      ctx.fillStyle = mvp.owner === 'player' ? accent : '#e74c3c';
      ctx.font = '600 24px "Rajdhani", sans-serif';
      ctx.fillText(mvp.owner === 'player' ? 'YOUR ALLY' : 'ENEMY THREAT', W / 2, 480);
    }

    // ----- LAYER 4: HP CURVE -----
    const history = (replay && replay.hpHistory) || [];
    const chartTop = 540, chartBot = 800, chartLeft = 100, chartRight = W - 100;
    const chartW = chartRight - chartLeft, chartH = chartBot - chartTop;
    // Frame + label
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '600 20px "Rajdhani", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('HP HISTORY', chartLeft, chartTop - 14);
    ctx.strokeStyle = accentDim;
    ctx.lineWidth = 1;
    ctx.strokeRect(chartLeft, chartTop, chartW, chartH);
    // Horizontal grid at quartiles
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    for (let q = 1; q < 4; q++) {
      const y = chartTop + (q / 4) * chartH;
      ctx.beginPath();
      ctx.moveTo(chartLeft, y);
      ctx.lineTo(chartRight, y);
      ctx.stroke();
    }
    if (history.length >= 2) {
      const maxHp = 30;
      const drawLine = (key, color, glow) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.shadowColor = glow;
        ctx.shadowBlur = 14;
        ctx.beginPath();
        history.forEach((h, i) => {
          const x = chartLeft + (i / (history.length - 1)) * chartW;
          const v = Math.max(0, Math.min(maxHp, h[key] || 0));
          const y = chartBot - (v / maxHp) * chartH;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.shadowBlur = 0;
      };
      drawLine('player', accent, accent);
      drawLine('ai', '#e74c3c', '#e74c3c');
      // Legend
      ctx.font = '600 18px "Rajdhani", sans-serif';
      ctx.fillStyle = accent;
      ctx.fillText('YOU', chartLeft + 12, chartTop + 28);
      ctx.fillStyle = '#e74c3c';
      ctx.fillText('AI', chartLeft + 78, chartTop + 28);
    } else {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '500 22px "Rajdhani", sans-serif';
      ctx.fillText('No HP history captured', W / 2, chartTop + chartH / 2 + 8);
    }

    // ----- LAYER 5: STAT GRID -----
    ctx.textAlign = 'center';
    const statY = 870;
    const statCols = [
      { label: 'ROUNDS', value: String(summary.rounds || (Game.state ? Game.state.round : 0) || 0) },
      { label: 'YOUR HP', value: String(summary.playerHp != null ? summary.playerHp : (Game.state && Game.state.player ? Game.state.player.health : 0)) },
      { label: 'AI HP', value: String(summary.aiHp != null ? summary.aiHp : (Game.state && Game.state.ai ? Game.state.ai.health : 0)) },
      { label: 'MODE', value: (summary.mode || 'classic').toUpperCase() }
    ];
    const colW = (W - 200) / statCols.length;
    statCols.forEach((sc, i) => {
      const cx = 100 + colW * (i + 0.5);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '600 18px "Rajdhani", sans-serif';
      ctx.fillText(sc.label, cx, statY);
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 48px "Rajdhani", sans-serif';
      ctx.fillText(sc.value, cx, statY + 56);
    });

    // ----- LAYER 6: FOOTER -----
    const persona = this._currentAiPersonality;
    const oppName = persona ? `${persona.name} • ${persona.tag}` : 'AI Opponent';
    const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '600 22px "Rajdhani", sans-serif';
    ctx.fillText(`vs ${oppName}  ·  ${dateStr}`, W / 2, H - 70);
    ctx.fillStyle = accent;
    ctx.font = '700 18px "Rajdhani", sans-serif';
    ctx.fillText('CARD LANE BATTLE', W / 2, H - 40);
  },
  _renderReplayOverlay(r) {
    // Remove any stale overlay.
    const stale = document.getElementById('replay-overlay');
    if (stale) stale.remove();
    const ov = document.createElement('div');
    ov.id = 'replay-overlay';
    ov.className = 'replay-overlay';
    // Colorize log entries the same way the in-game drawer does —
    // preserve the bracketed tags' inline colors.
    const logLines = (r.log || []).map(line => {
      // Each log line is either a plain string or already-formatted
      // HTML; strip basic HTML risks and re-class it. Game.log stores
      // strings with pre-baked color spans; keeping them is safe here
      // since we control the source.
      return `<div class="replay-log-line">${line}</div>`;
    }).join('');
    // Build an HP chart as SVG — reuses the same math as renderHpCurveSvg.
    const hpSvg = this._replayHpChart(r.hpHistory || []);
    const summary = r.summary || {};
    const verdict = summary.winner === 'player' ? 'VICTORY'
                  : summary.winner === 'ai'    ? 'DEFEAT'
                  : 'DRAW';
    ov.innerHTML = `
      <div class="replay-panel">
        <button type="button" class="md-back" onclick="document.getElementById('replay-overlay').remove()" title="Close replay">&larr; Back</button>
        <div class="encyc-head">
          <div>
            <div class="encyc-tag">Replay</div>
            <h1 class="encyc-title">${verdict}</h1>
            <div class="encyc-sub">${summary.rounds || 0} rounds · ${summary.mode || 'classic'}</div>
          </div>
        </div>
        <div class="replay-chart">${hpSvg}</div>
        <div class="replay-log">${logLines || '<div class="db-grid-empty">No log captured.</div>'}</div>
      </div>`;
    document.body.appendChild(ov);
  },
  _replayHpChart(history) {
    if (!history.length) return '<div class="db-grid-empty">No HP history captured.</div>';
    const W = 560, H = 120, PAD = 12;
    const maxHp = 30;
    const pts = (key, color) => history.map((h, i) => {
      const x = PAD + (i / Math.max(1, history.length - 1)) * (W - PAD * 2);
      const y = H - PAD - (h[key] / maxHp) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const playerPts = pts('player', 'player');
    const aiPts = pts('ai', 'ai');
    return `<svg viewBox="0 0 ${W} ${H}" class="replay-hp-svg" preserveAspectRatio="none">
      <polyline points="${playerPts}" fill="none" stroke="rgb(var(--theme-rgb, 79,195,247))" stroke-width="2.5" stroke-linejoin="round"/>
      <polyline points="${aiPts}" fill="none" stroke="rgb(231,76,60)" stroke-width="2.5" stroke-linejoin="round"/>
    </svg>`;
  },
  _pickHistoryMvp(s) {
    const all = [];
    ['player', 'ai'].forEach(side => {
      (s[side].hand || []).forEach(c => all.push(c));
      (s[side].deadPile || []).forEach(c => all.push(c));
    });
    (s.lanes || []).forEach(l => {
      if (l.player) all.push(l.player);
      if (l.ai) all.push(l.ai);
    });
    const score = (c) => (c.statsEnemyDamage || 0) + (c.statsHealthbarDamage || 0)
                      + (c.statsKills || 0) * 3 + (c.statsDamageAbsorbed || 0);
    return all.slice().sort((a, b) => score(b) - score(a))[0] || null;
  },
  _clearMatchHistory() {
    try { localStorage.removeItem(this._MATCH_HISTORY_KEY); } catch (e) {}
  },

  // ===================== STATS STORE (phase 4c, v2) =====================
  // Per-card telemetry persisted in localStorage. Versioned key so we can
  // evolve the schema without tripping old data. v2 adds:
  //   • gamesInDeck   — unique games where the card was drafted (not per-copy)
  //   • prevented     — damage prevented via phantom-swing sims + cardAdvantage
  //   • cardAdvantage — extra draws generated by this card's abilities
  //   • kills/freezes/stuns/fears/mc applied — action counters
  //   • contributionSum / contributionN — per-game share of side impact
  //     (avg contribution % = contributionSum / contributionN)
  //
  // Shape:
  //   {
  //     __meta: { version, gamesPlayed, firstSeen, lastPlayed },
  //     cards:  { [name]: { drafts, draftsInWin, gamesInDeck, gamesInDeckInWin,
  //                         plays, deaths,
  //                         hpDamage, cardDamage, absorbed, energyGen,
  //                         cardAdvantage,
  //                         mvp,
  //                         contributionSum, contributionN,
  //                         kills, freezesApplied, stunsApplied, fearsApplied, mcApplied } },
  //     tricks: { [name]: { drafts, draftsInWin, casts } }
  //   }
  _STATS_KEY: 'clb_card_stats_v2',
  _LEGACY_STATS_KEYS: ['clb_card_stats_v1'], // best-effort wipe on migration
  _statsGet() {
    try {
      const raw = localStorage.getItem(this._STATS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!parsed.cards) parsed.cards = {};
        if (!parsed.tricks) parsed.tricks = {};
        if (!parsed.__meta) parsed.__meta = { version: 2, gamesPlayed: 0, firstSeen: Date.now(), lastPlayed: null };
        return parsed;
      }
    } catch (e) { /* fall through */ }
    // No v2 data yet — if legacy v1 exists, purge it so the dashboard
    // isn't rendering against a stale shape. (v1 records miss too many
    // v2 fields for a merge to be meaningful.)
    (this._LEGACY_STATS_KEYS || []).forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
    return { __meta: { version: 2, gamesPlayed: 0, firstSeen: Date.now(), lastPlayed: null }, cards: {}, tricks: {} };
  },
  _statsSet(obj) {
    try { localStorage.setItem(this._STATS_KEY, JSON.stringify(obj)); }
    catch (e) { /* swallow — quota or disabled */ }
  },
  _statsReset() {
    try { localStorage.removeItem(this._STATS_KEY); } catch (e) {}
    (this._LEGACY_STATS_KEYS || []).forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
  },

  // ===================== MODE SELECT =====================
  // Pre-match screen. Two rows (1v1, 2v2) × two columns (Classic, Deckbuilder).
  // Only 1v1 is enabled in phase 3 — 2v2 still shows "coming soon".

  // ===================== DRAFT =====================

  renderDraft(s) {
    const d = s.draft;
    const isCards = d.phase === 'cards';
    const choices = d.playerChoices;
    const round = d.round;
    const total = isCards ? 5 : 2;
    const drafted = isCards ? d.playerDrafted : d.playerTrickDrafted;

    // Build the pick-progress pip row ("● ● ○ ○ ○") — HUD-style dots so the
    // player can read round/total at a glance without counting numbers.
    const pips = [];
    for (let i = 1; i <= total; i++) {
      const cls = i < round ? 'pip-done' : i === round ? 'pip-current' : 'pip-future';
      pips.push(`<span class="draft-pip ${cls}"></span>`);
    }

    const mulliganUsed = !!d.mulliganUsed;
    const mulliganDisabled = mulliganUsed ? ' mulligan-used' : '';
    const mulliganAttr = mulliganUsed ? ' disabled' : '';
    const mulliganLabel = mulliganUsed ? 'Mulligan Used' : 'Mulligan';

    // Back button — available whenever there's a snapshot on the undo
    // stack. History is confined to the current phase (reset at the
    // card→trick boundary) so this never lets the user rewind across
    // phases, only within card picks or within trick picks.
    const undoAvailable = !!(d.history && d.history.length);
    const undoDisabled = undoAvailable ? '' : ' undo-disabled';
    const undoAttr = undoAvailable ? '' : ' disabled';

    let html = `<div class="draft-panel ${isCards ? 'draft-cards' : 'draft-tricks'}">`;
    html += `<div class="draft-hud">`;
    html +=   `<div class="draft-hud-row">`;
    html +=     `<span class="draft-hud-label">${isCards ? 'Card' : 'Trick'} Draft</span>`;
    html +=     `<span class="draft-hud-pips">${pips.join('')}</span>`;
    html +=     `<span class="draft-hud-counter">Pick <em>${round}</em> / ${total}</span>`;
    html +=   `</div>`;
    html +=   `<div class="draft-hud-sub">Choose one — the other goes to the holding zone</div>`;
    html +=   `<div class="draft-hud-actions">`;
    // Back-to-menu — early exit out of a draft. Confirms first so an
    // accidental click doesn't wipe picks already made.
    html +=     `<button type="button" class="draft-quit-btn" onclick="draftQuitToMenu()" title="Abandon draft and return to main menu">`;
    html +=       `<span class="mulligan-icon">&#8592;</span>`;
    html +=       `<span class="mulligan-label">Menu</span>`;
    html +=     `</button>`;
    // Undo / Back — rewind the last pick within this draft phase. Dims
    // when there's nothing to undo (first pick of a phase). Uses the
    // curved-left glyph &#x21B6; — the conventional "undo" symbol —
    // paired with the label so it reads clearly even without the icon.
    html +=     `<button type="button" class="draft-undo-btn${undoDisabled}" onclick="draftUndo()"${undoAttr} title="Undo the previous pick">`;
    html +=       `<span class="mulligan-icon">&#x21B6;</span>`;
    html +=       `<span class="mulligan-label">Back</span>`;
    html +=     `</button>`;
    html +=     `<button type="button" class="draft-mulligan-btn${mulliganDisabled}" onclick="draftMulligan()"${mulliganAttr}>`;
    html +=       `<span class="mulligan-icon">&#x21BB;</span>`;
    html +=       `<span class="mulligan-label">${mulliganLabel}</span>`;
    html +=     `</button>`;
    // Settings button — visible during draft so users can pick difficulty
    // and combat speed BEFORE the match begins. Same handler as the cog in
    // the top-right corner; this just makes it obvious.
    html +=     `<button type="button" class="draft-settings-btn" onclick="UI.openSettings()" title="Settings">`;
    html +=       `<span class="mulligan-icon">&#9881;</span>`;
    html +=       `<span class="mulligan-label">Settings</span>`;
    html +=     `</button>`;
    html +=   `</div>`;
    html += `</div>`;
    html += `<div class="draft-choices">`;

    choices.forEach((c, i) => {
      if (isCards) {
        // Same "?" rule the in-hand renderer uses — Scarlet Witch hides
        // both stats (copies-opposite); Joker / Harley hide just ATK
        // (Insane / Crazy reroll). Reads consistently from draft pick
        // through to hand display so the player picks with the same
        // uncertainty the game preserves until the card lands.
        // Draft cards are raw defs (applyAbilities hasn't fired), so
        // we check the abilities array string for the keyword in
        // addition to the runtime boolean flag.
        const _abList = (c.abilities || []);
        const _hasCrazy  = c.isCrazy  || _abList.includes('Crazy');
        const _hasInsane = c.isInsane || _abList.includes('Insane');
        const dHideAtk = !!(c.copiesOpposite || _hasCrazy || _hasInsane);
        const dHideHp  = !!c.copiesOpposite;
        const dAtkCell = dHideAtk ? '?' : c.attack;
        const dHpCell  = dHideHp  ? '?' : c.health;
        const statOrbs = c.isDiscardEffect ? '' : `
          <span class="stat-circle stat-atk">${dAtkCell}</span>
          <span class="stat-circle stat-hp">${dHpCell}</span>`;
        // Rarity pips — same 1-4 tier rule as hand/board cards, so the rarity
        // signal reads continuously from draft → hand → board.
        const _dpCost = c.cost || 0;
        const _dpPips = _dpCost <= 3 ? 1 : _dpCost <= 6 ? 2 : _dpCost <= 8 ? 3 : 4;
        const rarityPips = `<span class="rarity-strip">${'<span class="rpip"></span>'.repeat(_dpPips)}</span>`;
        // Draft picks render with the SAME structure as in-hand cards so
        // the chrome (portrait + name overlay + chamfered octagon orbs +
        // monospace desc) is identical end-to-end: draft → hand → board.
        // `card` pulls in the --rarity-rgb / --portrait-frame-rgb cascade
        // and the unified element styles; `draft-card` only carries the
        // larger picker footprint and hover lift. `hand-card` is omitted
        // intentionally — its `:hover { transform: none !important; }`
        // lock would suppress the draft picker's translateY(-8px) lift.
        const portraitFile = UI.getCardArtPath(c.name);
        const portraitHtml = `<div class="card-portrait" style="--portrait-bg:url('${portraitFile}')"><div class="card-name-overlay">${c.name}</div></div>`;
        html += `<div class="card draft-card ${this.getCostClass(c.cost)}${c.isDiscardEffect ? ' discard-effect' : ''}" data-card-name="${c.name}" onclick="draftPick(${i})">
          <span class="card-cost">${c.cost}</span>
          ${rarityPips}
          ${portraitHtml}
          <div class="card-abilities status-badges">${this.formatAbilityBadges(c.abilities)}</div>
          <div class="card-desc">${this.formatDesc(c.desc)}</div>
          ${statOrbs}
        </div>`;
      } else {
        const draftTrickBadges = c.abilities && c.abilities.length
          ? `<div class="card-abilities status-badges">${this.formatAbilityBadges(c.abilities)}</div>`
          : '';
        const draftTrickRarity = this.getTrickRarityStrip(c.cost || 0);
        html += `<div class="draft-card trick-draft" data-trick-name="${c.name}" onclick="draftPick(${i})">
          <span class="trick-cost">${c.cost}</span>
          ${draftTrickRarity}
          <div class="trick-name">${c.name}</div>
          ${draftTrickBadges}
          <div class="trick-desc">${this.formatDesc(c.desc)||''}</div>
        </div>`;
      }
    });

    html += `</div>`;
    // Drafted summary — render card list whenever any cards have been drafted
    // (so during trick draft the earlier card picks are still visible), and
    // render trick list once any tricks have been drafted. Per-tag rarity tier
    // class mirrors the card rarity-pip palette (green/cyan/silver/gold for
    // cards, purple/silver/gold for tricks) so the drafted list reads the same
    // rarity signal as the in-game pip strip.
    const renderDraftedRow = (list, isTrick) => {
      if (!list.length) return '';
      const baseTag = isTrick ? 'drafted-tag drafted-tag-trick' : 'drafted-tag';
      const listCls = isTrick ? 'drafted-list drafted-list-trick' : 'drafted-list';
      const label = isTrick ? 'Tricks:' : 'Cards:';
      let row = `<div class="${listCls}"><strong>${label}</strong> `;
      row += list.map(c => `<span class="${baseTag} cost-${c.cost}">${c.name} (${c.cost})</span>`).join(' ');
      row += `</div>`;
      return row;
    };
    html += renderDraftedRow(d.playerDrafted, false);
    if (!isCards) html += renderDraftedRow(d.playerTrickDrafted, true);
    html += `</div>`;
    this.draftEl.innerHTML = html;
    // Decorate the two pick cards + the chrome buttons (MENU /
    // MULLIGAN / SETTINGS) with the shared interaction language. This
    // renderer is reached via render() returning early, so the
    // bottom-of-render applyTronFx() never runs for the draft path.
    if (this.applyTronFx) this.applyTronFx();
  },

  // ===================== BLOCK TRICK CHOICE =====================

  renderBlockTrickChoice(s) {
    const trick = s.pendingBlockTrick;
    // Remove any stale modal so we don't stack duplicates
    const stale = document.getElementById('block-trick-modal');
    if (stale) stale.remove();

    // Floating, board-preserving modal — sits over a dim backdrop but doesn't
    // hide the board. Same pattern as Hearthstone's Discover prompt.
    const modal = document.createElement('div');
    modal.id = 'block-trick-modal';
    modal.className = 'floating-prompt block-trick';
    modal.dataset.peekLabel = 'Show Trick Choice';
    modal.innerHTML = `
      <div class="floating-prompt-backdrop"></div>
      <div class="floating-prompt-panel">
        <button class="peek-toggle" onclick="UI.peekModal('#block-trick-modal','Show Trick Choice')" title="Hide prompt to inspect the board (Esc)" aria-label="Hide trick prompt">
          <span class="peek-toggle-glyph">×</span>
        </button>
        <div class="fp-header">
          <span class="fp-label">Block Meter Triggered</span>
          <span class="fp-sub">You drew a free Trick — view the board before deciding.</span>
        </div>
        <div class="fp-body">
          <div class="fp-trick-preview">
            <div class="trick-card fp-tricky">
              <span class="trick-cost">${trick.cost}</span>
              ${this.getTrickRarityStrip(trick.cost || 0)}
              <div class="trick-name">${trick.name}</div>
              ${trick.abilities && trick.abilities.length ? `<div class="card-abilities status-badges">${this.formatAbilityBadges(trick.abilities)}</div>` : ''}
              <div class="trick-desc">${this.formatDesc(trick.desc) || ''}</div>
            </div>
          </div>
          <div class="fp-choices">
            <button class="fp-btn fp-btn-primary" onclick="blockTrickPlay()">
              <span class="fp-btn-title">Play FREE</span>
              <span class="fp-btn-sub">Use now at no cost</span>
            </button>
            <button class="fp-btn fp-btn-secondary" onclick="blockTrickKeep()">
              <span class="fp-btn-title">Keep in Hand</span>
              <span class="fp-btn-sub">Pay ${trick.cost} to play later</span>
            </button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
  },

  // ===================== JUMP OFFER =====================
  // Player-side jump cards (Jason / Ghostface / Michael Myers) that become
  // Time Stone reaction modal — appears when the AI plays a hostile
  // trick and the player has Time Stone in their trick hand. Counter:
  // consume Time Stone, return enemy trick to their hand, block for
  // this round. Allow: let it resolve normally. Combat / AI turn is
  // paused via hasPendingPrompt until the player chooses.
  renderTimeStoneIntercept(s) {
    const ti = s.pendingTimeStoneIntercept;
    if (!ti) return;
    const t = ti.incomingTrick;
    if (!t) { s.pendingTimeStoneIntercept = null; return; }
    const stale = document.getElementById('time-stone-modal');
    if (stale) stale.remove();
    const modal = document.createElement('div');
    modal.id = 'time-stone-modal';
    modal.className = 'floating-prompt time-stone-intercept';
    modal.dataset.peekLabel = 'Show Time Stone Prompt';
    modal.innerHTML = `
      <div class="floating-prompt-backdrop"></div>
      <div class="floating-prompt-panel">
        <button class="peek-toggle" onclick="UI.peekModal('#time-stone-modal','Show Time Stone Prompt')" title="Hide prompt to inspect the board (Esc)" aria-label="Hide time-stone prompt">
          <span class="peek-toggle-glyph">×</span>
        </button>
        <div class="fp-header">
          <span class="fp-label">Time Stone — React</span>
          <span class="fp-sub">Enemy is about to play <strong>${t.name}</strong>. Freeze time to undo it?</span>
        </div>
        <div class="fp-body">
          <div class="fp-trick-preview">
            <div class="trick-card fp-tricky">
              <div class="trick-name">${t.name}</div>
              ${t.cost != null ? `<div class="trick-cost">${t.cost}</div>` : ''}
              <div class="trick-desc">${(t.desc || '').replace(/</g, '&lt;')}</div>
            </div>
          </div>
          <div class="fp-choices">
            <button class="fp-btn fp-btn-primary" onclick="timeStoneCounter()">
              <span class="fp-btn-title">Counter (spend Time Stone)</span>
              <span class="fp-btn-sub">${t.name} returns to enemy hand + blocked this round</span>
            </button>
            <button class="fp-btn fp-btn-secondary" onclick="timeStoneAllow()">
              <span class="fp-btn-title">Let it resolve</span>
              <span class="fp-btn-sub">Trick fires; Time Stone stays in hand</span>
            </button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
  },

  // jumpReady mid-combat used to miss their window because combat resolved
  // lane-by-lane faster than the player could react. This modal pauses
  // combat and asks: play the card free now, or skip. Either answer clears
  // state.pendingJumpOffer and resumes the combat continuation.
  renderJumpOfferChoice(s) {
    const offer = s.pendingJumpOffer;
    if (!offer) return;
    const card = s.player.hand.find(c => c.id === offer.cardId);
    if (!card) {
      // Card no longer in hand (somehow played already) — clear and resume
      s.pendingJumpOffer = null;
      if (typeof Game.resumeCombatIfWaiting === 'function') Game.resumeCombatIfWaiting();
      return;
    }
    const stale = document.getElementById('jump-offer-modal');
    if (stale) stale.remove();
    const modal = document.createElement('div');
    modal.id = 'jump-offer-modal';
    modal.className = 'floating-prompt jump-offer';
    modal.dataset.peekLabel = 'Show Jump Prompt';
    modal.innerHTML = `
      <div class="floating-prompt-backdrop"></div>
      <div class="floating-prompt-panel">
        <button class="peek-toggle" onclick="UI.peekModal('#jump-offer-modal','Show Jump Prompt')" title="Hide prompt to inspect the board (Esc)" aria-label="Hide jump prompt">
          <span class="peek-toggle-glyph">×</span>
        </button>
        <div class="fp-header">
          <span class="fp-label">${card.name} — Jump!</span>
          <span class="fp-sub">Play this card FREE from your hand before combat continues.</span>
        </div>
        <div class="fp-body">
          <div class="fp-choices">
            <button class="fp-btn fp-btn-primary" onclick="jumpOfferPlay()">
              <span class="fp-btn-title">Play FREE</span>
              <span class="fp-btn-sub">Place ${card.name} (${card.attack}/${card.currentHealth}) now</span>
            </button>
            <button class="fp-btn fp-btn-secondary" onclick="jumpOfferSkip()">
              <span class="fp-btn-title">Skip</span>
              <span class="fp-btn-sub">Let combat continue</span>
            </button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
  },

  // ===================== LANE CHOICE =====================


  // ===================== BATMAN WHO LAUGHS CHOICE =====================

  renderBWLChoice(s) {
    const data = s.player.stolenByBWL;
    const card = data.card;
    this.draftEl.style.display = 'flex';
    document.getElementById('game-area').style.display = 'none';
    this.draftEl.innerHTML = `
      <div class="draft-panel">
        <h2>Batman Who Laughs Intercepted!</h2>
        <p class="draft-sub">You intercepted: <strong>${card.name}</strong> (${card.attack}/${card.currentHealth})</p>
        <p class="draft-sub">${this.formatDesc(card.desc)}</p>
        <div class="draft-choices">
          <div class="draft-card ${this.getCostClass(card.baseCost || card.cost)} card-choice-card" onclick="bwlChoiceKeep()">
            <div class="card-name">Keep in Hand</div>
            <div class="card-desc">Add ${card.name} to your hand</div>
          </div>
          <div class="draft-card cost-4 card-choice-card" onclick="bwlChoiceDestroy()">
            <div class="card-name">Destroy</div>
            <div class="card-desc">Destroy ${card.name} — Batman Who Laughs gains +2/+2</div>
          </div>
        </div>
      </div>`;
  },

  // ===================== KANG CHOICE =====================

  renderKangChoice(s) {
    const kc = s.pendingKangChoice;
    this.draftEl.style.display = 'flex';
    document.getElementById('game-area').style.display = 'none';
    let html = `<div class="draft-panel">`;
    html += `<h2>Kang — Choose a Card</h2>`;
    html += `<p class="draft-sub">Pick 1 card to keep (cost reduced by 2). The other returns to the deck.</p>`;
    html += `<div class="draft-choices">`;
    kc.cards.forEach((card, i) => {
      const newCost = Math.max(0, card.cost - 2);
      html += `<div class="draft-card card-choice-card ${this.getCostClass(card.cost)}" onclick="kangChoicePick(${i})">
        <span class="card-cost">${card.cost}</span>
        <div class="card-name">${card.name}</div>
        <div class="card-stats"><span class="atk">${card.attack}</span> / <span class="hp">${card.health}</span></div>
        <div class="card-abilities status-badges">${this.formatAbilityBadges(card.abilities)}</div>
        <div class="card-desc">${this.formatDesc(card.desc)}</div>
        <div style="color:#f39c12;font-weight:bold;margin-top:6px">New cost: ${newCost}</div>
      </div>`;
    });
    html += `</div></div>`;
    this.draftEl.innerHTML = html;
  },

  // ===================== BOARD =====================

  // ===================== DIFF-RENDER FOUNDATION =====================
  // Cache of the previous render's card DOM elements, keyed by card.id.
  // Carries from one renderBoard call to the next so we can REUSE the
  // existing element (with its in-flight CSS animations intact) when
  // a card's visible state is unchanged. Captured BEFORE the
  // board.innerHTML wipe by _captureBoardCardEls() and consumed by
  // makeCardElCached() during the rebuild. Cleared at the end of
  // renderBoard so stale references don't accumulate.
  _capturedBoardCardEls: null,

  // Persistent lane DOM cache. The board's innerHTML gets wiped every
  // render (to flush watermark / motes / etc.), but the lane <div>s
  // themselves are reused across renders so their long-running CSS
  // animations (.lane-number tronCirclePulse 3s infinite, .lane Tron
  // perimeter sweep, hover state) don't restart on every AI step.
  // Indexed by lane idx (0-5). Lazy-initialized on first render.
  // User-visible bug this fixes: "when AI is thinking, lane circles
  // kinda pulse + hovers don't work" — root cause was the lane DOM
  // being destroyed + recreated on every render, which restarted the
  // pulse animations from 0% and detached any active :hover state.
  _laneEls: null,

  // Set of class names that are applied per-render based on transient
  // game-state context (target highlight, dimmed-by-selection, etc.).
  // Stripped before a cached element is reused so they don't leak.
  _DECORATION_CLASSES: [
    'target-highlight', 'dimmed-by-selection', 'hit-flash', 'hit-shake',
    'card-enter', 'card-reveal-flip', 'card-anticipating', 'card-flying',
    'is-selected', 'selected', 'jump-ready', 'card-shake-rejected'
  ],

  // Snapshot of every card-state field that affects the rendered visual.
  // If this string changes between renders, the cached element is stale
  // and a fresh build is required. Numeric fields are coerced via | 0
  // (faster than parseInt; treats null/undefined as 0).
  _cardVisualSnapshot(card) {
    if (!card) return '';
    // Prediction fields included so the cached DOM busts when the
    // global combat predictor's verdict for this card changes (e.g.
    // a new enemy lands and now this card is predicted to die).
    // Earlier the snap intentionally excluded predictor data to avoid
    // pulse-storm during AI thinking — but that left stale skull
    // badges (user report: "where are the damage previews here").
    // The pulse churn is mild because the predictor is stable while
    // nobody is acting; it only re-renders when the verdict actually
    // flips. Reads from the per-render cache (UI._combatPredCache)
    // populated at render start so this is O(1) per card.
    let pred = null;
    if (this._combatPredCache && this._combatPredCache.byId) {
      pred = this._combatPredCache.byId.get(card.id);
    }
    // In-fight XP also affects the chip text, so factor projected XP
    // into the snap. Prevents the chip from showing stale XP when a
    // kill happens but the card's own state didn't change.
    let pxp = 0;
    if (card._runDeckCardRef && typeof Roguelite !== 'undefined' && Roguelite.projectedXp) {
      pxp = Roguelite.projectedXp(card) | 0;
    }
    // Effective cost includes opponent passives (Silver Surfer +1) and
    // own-side discounts (Captain America). Without this, the cached
    // hand-card DOM keeps showing the BASE cost when SS lands on the
    // enemy board — only cards whose other stats changed would
    // re-render, leaving most of the hand showing stale costs even
    // though Game.getCardCost is correctly returning +1 (which is why
    // playing was blocked but the displayed cost was wrong).
    const ec = (card.owner && Game.getCardCost) ? Game.getCardCost(card.owner, card) | 0 : (card.cost | 0);
    return JSON.stringify({
      n:  card.name,
      a:  card.attack | 0,
      h:  card.currentHealth | 0,
      mh: card.maxHealth | 0,
      ba: card.baseAttack | 0,
      bh: card.baseHealth | 0,
      bc: card.baseCost | 0,
      c:  card.cost | 0,
      ec, // effective cost (with auras/discounts) — busts cache on SS land/die
      // Status counters drive multiple class-based glows + status badges
      st: card.stunnedTurns | 0, frT: card.frozenTurns | 0, feT: card.fearedTurns | 0,
      stB: !!card.isStunned, frB: !!card.isFrozen, feB: !!card.isFeared,
      mc: !!card.isMindControlled,
      iv: card.invincibleTurns | 0, av: card.armorValue | 0, ev: card.evadeCharges | 0,
      tt: card.tauntTurns | 0,     sr: card.splashRange | 0,
      di: !!card.hasDamageImmunity, im: card.immunityCharges | 0,
      ur: card.unresistibleCharges | 0, dr: card.drawOnPlay | 0,
      bs: !!card.isBullseye, od: !!card.isOverdrive,
      hu: !!card.hasHunt, rev: card.reviveCharges | 0,
      cr: !!card.isCrazy, ins: !!card.isInsane,
      fd: !!card.isFaceDown, jr: !!card.jumpReady,
      ut: !!card.isUntrickable,
      // Predictor + projected XP fields — keep last so they're visible
      // in the data-snap attr for debugging.
      pdi: pred ? (pred.dmgIn | 0) : 0,
      pdd: pred ? !!pred.dies : false,
      cby: card._charmedByIvy != null ? (card._charmedByIvy | 0) : 0,
      pxp: pxp,
    });
  },

  // Pre-render hook. Called at the very start of renderBoard, BEFORE
  // board.innerHTML = '' wipes the DOM. Walks the current board, grabs
  // every card element by data-card-id, and stashes them in a Map.
  // makeCardElCached() consumes this map during the rebuild.
  //
  // CRITICAL: Map is keyed by id but stores an ARRAY of elements per id.
  // Multiple instances of the same card design can exist on the board
  // simultaneously — Roguelite Jason can have 6 copies across 6 lanes,
  // multi-Goon swarms, etc. If we keyed by single element, only one lane
  // would reuse its DOM node; the other 5 lanes would build fresh nodes
  // each render and stack up in their slots because their stale copies
  // had data-card-id matching the current occupant id and weren't
  // distinguishable from each other. Bug surfaced as: lane 1 ai slot
  // accumulating 18 Jason copies stacked horizontally. Fix is to
  // capture all instances per id, then consume them one-by-one as
  // makeCardElCached() is called during the rebuild.
  _captureBoardCardEls() {
    const fresh = new Map();
    if (this.board) {
      this.board.querySelectorAll('.card[data-card-id]').forEach(el => {
        const id = el.getAttribute('data-card-id');
        if (!id) return;
        if (!fresh.has(id)) fresh.set(id, []);
        fresh.get(id).push(el);
      });
    }
    this._capturedBoardCardEls = fresh;
  },

  // Diff-render entry point. Returns a card DOM element to use for this
  // render. If a cached element exists for this id AND the visual
  // snapshot matches, reuses it (preserving in-flight CSS animations
  // like the .tron-perimeter-card pulse, lethal-HP tremor, etc.).
  // Otherwise builds a fresh one via makeCardEl.
  //
  // The reused element has all transient decoration classes stripped so
  // the caller can apply this render's decorations (target-highlight,
  // selection tint, etc.) on top of a clean baseline. The snapshot
  // string is stamped on data-snap so subsequent renders can compare.
  makeCardElCached(card, inHand, side) {
    if (!card || card.id == null || inHand) {
      // Hand cards aren't covered by this cache — they re-shuffle position
      // every render (sort by cost), so reuse-by-id wouldn't preserve
      // their layout slot anyway. Hand-side animation continuity is
      // handled separately via deterministic --card-anim-phase.
      return this.makeCardEl(card, inHand, side);
    }
    const idStr = String(card.id);
    // shift() consumes the FIRST element from this id's array. Multiple
    // instances of the same card produce multiple entries — each
    // makeCardElCached call hands back one until the array empties.
    // Capture order ≈ left-to-right board scan; subsequent renders
    // build cardEls in the same lane order, so each lane's element
    // tends to round-trip back to the same lane (animations stay
    // continuous per-lane).
    const list = this._capturedBoardCardEls && this._capturedBoardCardEls.get(idStr);
    const cached = (list && list.length) ? list.shift() : null;
    const snap = this._cardVisualSnapshot(card);
    if (cached && cached.dataset && cached.dataset.snap === snap) {
      // STATE UNCHANGED — reuse the existing DOM node. CSS animations on
      // the element continue uninterrupted across the render. Strip
      // transient decoration classes so this render's logic can apply
      // a clean set.
      this._DECORATION_CLASSES.forEach(c => cached.classList.remove(c));
      // Clean stale inline styles that decorations may have left.
      cached.style.cursor = '';
      return cached;
    }
    // STATE CHANGED — but if we have a cached DOM node for this card,
    // TRANSPLANT new content into it instead of returning a fresh node.
    // This is the key fix for the "Carnage's tilt restarts during AI
    // turn" / "hover magnify blips in and out" reports. The infinite
    // CSS animations (.vibe-*, .tron-perimeter-card, .card-hp-critical
    // tremor) live on the parent .card element. As long as the parent
    // element identity persists across renders, those animations keep
    // running. Replacing only the inner content + className lets us
    // refresh stat numbers, status badges, dmg-preview, etc. without
    // restarting the parent's animations OR breaking the user's
    // active hover state (which is what was causing the magnified
    // preview to "blip in and out" during AI thinking — old element
    // gets destroyed, magnify hides, new element appears, magnify
    // re-fires after the 280ms HOVER_DELAY).
    const fresh = this.makeCardEl(card, inHand, side);
    if (cached) {
      // Move children from fresh into cached without recreating fresh
      // (replaceChildren is faster + avoids innerHTML stringification).
      cached.replaceChildren(...fresh.childNodes);
      // CRITICAL: diff the className rather than wholesale-assign.
      // User report May-1: "Carnage's tilt animation keeps restarting
      // during AI turns; hover magnify blips in and out." Three
      // parallel investigation agents converged on the root cause:
      // `cached.className = fresh.className` triggers a browser style
      // recalc that restarts CSS animations on matched selectors like
      // `.card.vibe-symbiote:not(.card-enter):not(.card-exit)` —
      // EVEN WHEN THE RESULTING CLASS SET IS IDENTICAL. Browsers
      // re-evaluate animation: properties on any className mutation,
      // not just on actual class changes.
      //
      // Fix: compute the diff and only call classList.add/remove for
      // classes that actually changed. Identical class sets become a
      // genuine no-op — animations keep their phase across the
      // transplant.
      const oldClasses = cached.className ? cached.className.trim().split(/\s+/) : [];
      const newClasses = fresh.className ? fresh.className.trim().split(/\s+/) : [];
      const oldSet = new Set(oldClasses);
      const newSet = new Set(newClasses);
      for (const c of oldClasses) if (!newSet.has(c)) cached.classList.remove(c);
      for (const c of newClasses) if (!oldSet.has(c)) cached.classList.add(c);
      // Sync dataset (snap stamp + builder-set attrs like data-card-name).
      Object.keys(fresh.dataset).forEach(k => { cached.dataset[k] = fresh.dataset[k]; });
      Object.keys(cached.dataset).forEach(k => {
        if (!(k in fresh.dataset) && k !== 'snap') delete cached.dataset[k];
      });
      cached.dataset.snap = snap;
      // Sync inline styles. CRITICAL: first REMOVE all properties
      // currently on cached so stale values from previous renders
      // (e.g. `position: relative` set by spawnHitChips at ui.js:3870
      // / 3883 / 3923 during damage bursts, or transient `transform`
      // values from one-shot animations) don't accumulate. Otherwise
      // they linger and can produce visible layout glitches like
      // cards rendering outside their lane bounds — user reported a
      // DEATHSTROKE clipping into lane 4 that traced to this exact
      // pattern. After the cleanup, re-apply fresh's inline styles
      // (which include the up-to-date --card-anim-phase /
      // --tremor-phase variables for animation continuity).
      const cachedStyleProps = [];
      for (let i = 0; i < cached.style.length; i++) cachedStyleProps.push(cached.style[i]);
      cachedStyleProps.forEach(p => cached.style.removeProperty(p));
      if (fresh.style.length > 0) {
        for (let i = 0; i < fresh.style.length; i++) {
          const prop = fresh.style[i];
          cached.style.setProperty(prop, fresh.style.getPropertyValue(prop));
        }
      }
      // (Already consumed via list.shift() at lookup time — no extra
      // bookkeeping needed.)
      return cached;
    }
    // No prior cache — first time seeing this card on board. Return
    // the fresh element directly; subsequent renders will transplant
    // into it.
    fresh.dataset.snap = snap;
    return fresh;
  },

  // ===================== PHASE PERSISTENCE HELPER =====================
  // Returns a deterministic negative offset (in ms) for an element's
  // animation-delay, derived from a stable identity. Two elements with
  // the same id get the same phase position. Re-rendered elements pick
  // up at the same phase the prior element was at — eliminating the
  // synchronized "all animations restart at 0%" flash that occurs when
  // a render rebuilds many DOM nodes simultaneously.
  //
  // id: any value with a stable numeric/string representation
  // cycleMs: the animation cycle duration (must match the CSS keyframe
  //   duration, otherwise phases drift)
  //
  // Returns a number suitable for `animation-delay: <N>ms` (negative).
  phaseOffsetFor(id, cycleMs) {
    if (id == null || !cycleMs || cycleMs <= 0) return 0;
    // Hash the id deterministically. String hash for non-numeric ids
    // (like card names), arithmetic for numeric ids.
    let n;
    if (typeof id === 'number') {
      n = Math.abs(id);
    } else {
      const s = String(id);
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      n = Math.abs(h);
    }
    // Multiply by a large prime so neighboring ids get distinct phases.
    return -((n * 263) % cycleMs);
  },

  // Apply a phase offset to an element via a CSS variable. Caller's CSS
  // should declare `animation-delay: var(--phase-offset, 0s)` on the
  // animated element / pseudo. Pass a custom var name as the 4th arg
  // when an element needs multiple independent offsets.
  applyPhaseOffset(el, id, cycleMs, varName) {
    if (!el) return;
    const offset = this.phaseOffsetFor(id, cycleMs);
    el.style.setProperty(varName || '--phase-offset', offset + 'ms');
  },

  renderBoard(s) {
    // STEP 1 — capture every card element currently on the board, keyed
    // by data-card-id, so makeCardElCached() below can reuse the same
    // DOM node when the card's visual state is unchanged. This is the
    // single biggest win for animation continuity: cached elements
    // KEEP their in-flight CSS animations across renders instead of
    // restarting at 0% on every phase change.
    this._captureBoardCardEls();
    // SMART WIPE — board.innerHTML = '' detaches every descendant
    // including the cached lanes, slots, and cards. Browsers reset
    // CSS animations on any element that is detached + reattached,
    // even if the JS reference is the same. That's the deep reason
    // Carnage's vibe-symbiote tilt was restarting on every render —
    // no class change, no inline-style change, just attach/reattach
    // through the board.innerHTML wipe.
    //
    // Fix: clear only the watermark + motes (the actually disposable
    // children), and KEEP the cached lane subtrees attached. Lanes
    // re-append below (which is a no-op when already attached);
    // slots inside them stay continuously rooted, and the cards
    // inside the slots keep their CSS animation timelines intact.
    Array.from(this.board.children).forEach(child => {
      if (child.classList && (child.classList.contains('round-watermark') || child.classList.contains('board-mote'))) {
        child.remove();
      }
    });
    const canPlay = this.canPlayerPlayCards(s);
    const cc = s.pendingCardChoice;
    const lc = s.pendingLaneChoice;
    const targetCardIds = new Set();
    if (cc) cc.cards.forEach(c => { if (c.id !== undefined) targetCardIds.add(c.id); });
    const lcTargetSide = lc ? (lc.targetSide || lc.owner) : null;
    const forcedAi = s.ai && (s.ai.forcedLane != null) ? s.ai.forcedLane : null;
    const forcedPlayer = s.player && (s.player.forcedLane != null) ? s.player.forcedLane : null;

    // Round watermark — massive ghost round number behind the lanes.
    // Absolutely-positioned; sits on the board element (set to
    // position: relative via CSS). Pure ornament + depth cue.
    const watermark = document.createElement('div');
    watermark.className = 'round-watermark';
    watermark.textContent = String(s.round || 1);
    watermark.setAttribute('aria-hidden', 'true');
    this.board.appendChild(watermark);

    // Ambient floating motes — 4 slow drifters layered over the
    // board background. Zero cost, sells "living stage" feel.
    for (let m = 1; m <= 4; m++) {
      const mote = document.createElement('div');
      mote.className = 'board-mote mote-' + m;
      this.board.appendChild(mote);
    }

    // Track new cards for entry animation
    const currentBoardIds = new Set();

    for (let i = 0; i < Game.LANE_COUNT; i++) {
      const lane = s.lanes[i];
      // Reuse cached lane element if present so .lane-number's 3s
      // infinite tronCirclePulse animation and any in-flight CSS
      // transitions don't restart on every render. board.innerHTML
      // detached the element above, but the JS reference still points
      // to the live DOM node — re-appending later in this loop puts
      // it back in place with its animation timeline intact.
      if (!this._laneEls) this._laneEls = [];
      let el = this._laneEls[i];
      if (!el) {
        el = document.createElement('div');
        this._laneEls[i] = el;
      } else {
        // Selective clear — preserve the slots + sep (which contain
        // cards whose CSS animations must stay continuous). Remove
        // only transient children: status-row, lane-trap, dmg-preview
        // chain, claim-wave / dust-kick / landing-ring spawned by
        // play animations. The slots + sep get reused via
        // querySelector below; their card children stay attached.
        const KEEP = el.querySelector(':scope > .ai-slot');
        const KEEP_SEP = el.querySelector(':scope > .lane-sep');
        const KEEP_PSLOT = el.querySelector(':scope > .player-slot');
        Array.from(el.children).forEach(child => {
          if (child !== KEEP && child !== KEEP_SEP && child !== KEEP_PSLOT) {
            child.remove();
          }
        });
        // Strip any decoration classes that might have been added
        // outside the className-rewrite path. forecast data-attrs are
        // overwritten below or removed if no longer relevant.
        delete el.dataset.forecast;
        delete el.dataset.forecastCls;
      }
      const parityClass = (i % 2 === 0) ? 'lane-odd' : 'lane-even';
      // Tron-style occupancy state — lane frame tints by who holds the slot.
      //   empty  → neutral white (default)
      //   ai     → red (enemy side lit)
      //   player → blue (ally side lit)
      //   both   → top-half red / bottom-half blue (split)
      const hasAi = !!lane.ai, hasPl = !!lane.player;
      const occClass = lane.destroyed
        ? ''
        : hasAi && hasPl ? ' occ-both'
        : hasAi ? ' occ-ai'
        : hasPl ? ' occ-player'
        : ' occ-none';
      // AI last-action pulse — highlight the lane the AI just played
      // into for ~1.5s so the player can see WHICH lane changed even
      // if multiple AI actions chain in rapid succession.
      const aiPulse = s._aiPulse;
      const aiPulseActive = aiPulse && aiPulse.laneIdx === i && (Date.now() - aiPulse.at < 1500);
      const pulseClass = aiPulseActive ? ' lane-ai-just-played' : '';
      // Only assign className if it actually changed — assigning the
      // same string is technically a no-op for layout but DOES still
      // bump some browsers' style-recalc cost and (more importantly)
      // any class-toggle observers downstream. Keeping it idempotent
      // means truly unchanged lanes pay zero cost on re-render.
      const nextCls = `lane ${parityClass}${occClass}` + (lane.destroyed ? ' destroyed' : '') + (s._activeLane === i ? ' lane-active' : '') + pulseClass;
      if (el.className !== nextCls) el.className = nextCls;
      if (aiPulseActive && !this._aiPulseClearScheduled) {
        // Schedule a re-render once the pulse window expires so the
        // class drops cleanly. Single-shot — only schedule once per pulse.
        this._aiPulseClearScheduled = true;
        const remaining = Math.max(0, 1550 - (Date.now() - aiPulse.at));
        setTimeout(() => {
          this._aiPulseClearScheduled = false;
          if (Game.state) Game.state._aiPulse = null;
          this.render();
        }, remaining);
      }
      // Stamp the predicted combat verdict on the lane element so a
      // CSS-only on-hover badge can surface "WIN / TRADE / STALL /
      // LOSE / STRIKE / EXPOSED" without any JS hover handler. The
      // attribute is only meaningful during the player's planning
      // phases — outside those, CSS hides the badge regardless.
      // Same predictLaneOutcome the strip uses, kept in sync via the
      // shared helper laneForecastVerdict.
      const forecast = this.laneForecastVerdict(s, i);
      if (forecast.label !== '—') {
        el.dataset.forecast = forecast.label;
        el.dataset.forecastCls = forecast.cls;
      }
      // Per-lane stagger for the Tron flowing-light packet. CSS uses
      // calc(var(--lane-index) * -1.6s) so each lane lights up 1.6s
      // after the previous, sweeping across the field as a wave.
      // Inline so it's robust to DOM-sibling order (the round watermark
      // and 4 board-motes share the .board parent and would otherwise
      // throw off any nth-child / nth-of-type selector).
      el.style.setProperty('--lane-index', i);

      // Lane number is embedded in the centerline separator (added below)
      // so it never overlaps card content.

      // Lane status glyphs row (destroyed / protected / trap / forced)
      const statusRow = [];
      if (lane.destroyed) {
        // Countdown pip — shows rounds remaining until the void collapses
        // and the lane reforms. 3 → 2 → 1 → lane restores. Falls back to
        // an unbounded ✖ if the turn counter is unset (legacy saves or
        // future permanent-destroy callers).
        const turns = lane.destroyedTurns > 0 ? lane.destroyedTurns : null;
        const label = turns != null ? `${turns}` : '&#x2716;';
        const title = turns != null ? `Lane collapsed — reforms in ${turns} round${turns === 1 ? '' : 's'}` : 'Lane destroyed';
        statusRow.push(`<span class="lane-glyph glyph-destroyed" title="${title}">${label}</span>`);
      }
      if (lane.protected) statusRow.push(`<span class="lane-glyph glyph-protected glyph-${lane.protected}" title="Protected from ${lane.protected}">&#x1F6E1;</span>`);
      if (lane.trap) statusRow.push(`<span class="lane-glyph glyph-trap glyph-${lane.trap.placedBy}" title="Bear Trap by ${lane.trap.placedBy}">&#x26A0;</span>`);
      if (forcedAi === i) statusRow.push(`<span class="lane-glyph glyph-forced glyph-forced-ai" title="AI's next card forced here">&#x21E3; AI</span>`);
      if (forcedPlayer === i) statusRow.push(`<span class="lane-glyph glyph-forced glyph-forced-player" title="Your next card forced here">&#x21E3; YOU</span>`);
      if (statusRow.length) {
        const row = document.createElement('div');
        row.className = 'lane-status-row';
        row.innerHTML = statusRow.join('');
        el.appendChild(row);
      }

      if (lane.trap) {
        const trapEl = document.createElement('div');
        trapEl.className = 'lane-trap ' + (lane.trap.placedBy === 'player' ? 'trap-player' : 'trap-ai');
        trapEl.title = `Reverse Bear Trap (${lane.trap.placedBy === 'player' ? 'yours' : "AI's"})`;
        // Jaw-trap SVG + small label. Pure geometric shapes, no emoji.
        trapEl.innerHTML = `
          <svg class="lane-trap-icon" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="3" fill="none" stroke="currentColor" stroke-width="1.2"/>
            <path d="M3 10 L6 7 L6 13 Z M17 10 L14 7 L14 13 Z" fill="currentColor"/>
            <path d="M10 3 L8.5 5 L11.5 5 Z M10 17 L8.5 15 L11.5 15 Z" fill="currentColor"/>
          </svg>
          <span class="lane-trap-label">TRAP</span>`;
        el.appendChild(trapEl);
      }

      // AI slot — reuse existing if cached lane already has one. Keeps
      // the slot continuously attached so its card child's CSS
      // animations don't restart on render.
      let aiSlot = el.querySelector(':scope > .ai-slot');
      if (!aiSlot) {
        aiSlot = document.createElement('div');
      }
      // Replace inner content (the card or empty-glyph) below; class
      // is idempotent (same string = no animation impact, but we
      // assign here so a fresh slot gets the right class too).
      if (aiSlot.className !== 'card-slot ai-slot') aiSlot.className = 'card-slot ai-slot';
      // Decide the card element FIRST (via cache lookup or fresh build),
      // then sweep — keeping ONLY the chosen element. User report May-1
      // (annotated screenshot): "underneath the lane itself, the
      // [cards] are making infinite copies." Root cause: matching by
      // data-card-id alone wasn't unique when multiple instances of
      // the same card existed (e.g. Roguelite Jason copies). The
      // capture Map only held one element per id, so 5 of 6 lanes
      // built fresh nodes each render and stacked them in their slot
      // (since stale copies all matched the keep-id). Now we capture
      // arrays per id (see _captureBoardCardEls) and remove anything
      // that ISN'T the chosen cardEl, regardless of id matching. Single
      // path, single result — no chance of accumulation.
      let aiCardEl = null;
      if (lane.ai) {
        aiCardEl = lane.ai.isFaceDown ? this.makeFaceDownEl() : this.makeCardElCached(lane.ai, false, 'enemy');
      }
      // Clear stale click handlers BEFORE conditional re-assignment below.
      // makeCardElCached returns the same DOM element across renders; if
      // we used addEventListener('click', ...) here the handlers would
      // STACK, and the first-registered (now-stale) one would fire with
      // a captured idx pointing at a card from an earlier prompt. User
      // report: "I selected Loki but Bane's ability went to King Shark."
      // The accumulated listener from a previous prompt was firing first
      // with its own captured idx. .onclick = ... replaces; null clears
      // when no prompt applies.
      aiSlot.onclick = null;
      if (aiCardEl) aiCardEl.onclick = null;
      Array.from(aiSlot.children).forEach(child => {
        if (child !== aiCardEl) child.remove();
      });
      // FORCE-ATTACH IMMEDIATELY after sweep. User report May-1
      // (annotated screenshot): "There is somebody there, but I can't
      // see them." Forecast strip showed -8 EXPOSED for lane 2 but
      // the AI card was invisible. Symptom: lane.ai existed in state,
      // cardEl was computed, but never landed in the slot DOM.
      // The trailing append-if-not-attached at the bottom of the
      // lane.ai block was supposed to be the safety net, but in
      // some flow path it wasn't running. Move the attach here so
      // it's the FIRST thing after the sweep — anti-invisible-card
      // primary defense. Idempotent if already attached.
      if (aiCardEl && aiCardEl.parentNode !== aiSlot) {
        aiSlot.appendChild(aiCardEl);
      }
      if (lane.ai) {
        const cardEl = aiCardEl;
        if (lane.ai.id !== undefined) currentBoardIds.add(lane.ai.id);
        if (!this._lastBoardCardIds.has(lane.ai.id)) {
          // Enemy cards use the same "build from grid" animation as
          // ally cards (1.0s clip-path reveal from bottom up + traveling
          // scan line). Removed the competing card-reveal-flip class —
          // the new build-in IS the load animation; user spec: "I want
          // there to be a little bit of an animation... show the card
          // literally being built from bottom to top." Same animation
          // for both sides keeps the play moment legible. Timeout matches
          // the 1.0s animation duration plus a small safety margin.
          cardEl.classList.add('card-enter');
          setTimeout(() => cardEl.classList.remove('card-enter'), 1100);
          // (h) landing dip + (k) claim wave + dust kick + ring ripple —
          // the ring is the Snap-style concentric pulse under the card.
          el.classList.add('lane-landed');
          setTimeout(() => el.classList.remove('lane-landed'), 400);
          const wave = document.createElement('div');
          wave.className = 'lane-claim-wave claim-ai';
          el.appendChild(wave);
          setTimeout(() => wave.remove(), 750);
          const dust = document.createElement('div');
          dust.className = 'dust-kick';
          aiSlot.appendChild(dust);
          setTimeout(() => dust.remove(), 500);
          const ring = document.createElement('div');
          ring.className = 'card-landing-ring ring-ai';
          aiSlot.appendChild(ring);
          setTimeout(() => ring.remove(), 900);
        }
        if (cc && targetCardIds.has(lane.ai.id)) {
          cardEl.classList.add('target-highlight');
          const idx = cc.cards.findIndex(c => c.id === lane.ai.id);
          cardEl.onclick = () => cardChoicePick(idx);
        }
        // Lane-choice prompts (Vader's chain, Green Goblin target-lane,
        // etc.) that target the AI side need clicks on the OCCUPIED
        // card, not just an empty slot. Previously the target-highlight
        // branch only fired when lane.ai was null, so Vader's chain
        // could never be started on an enemy card. Add click + glow
        // to the card element here.
        if (lc && lcTargetSide === 'ai' && lc.lanes.includes(i)) {
          aiSlot.classList.add('target-highlight');
          cardEl.classList.add('target-highlight');
          cardEl.style.cursor = 'pointer';
          cardEl.onclick = () => laneChoicePick(i);
          // Chain-ability damage preview — when promptLaneChoice was
          // called with previewDamage (Vader chain = 7, etc.), attach
          // a small "− N HP" label to each candidate showing the
          // post-mitigation damage for that target. User spec: "When
          // using a chain ability, show damage preview when selecting
          // an enemy — for Vader and stuff."
          if (lc.previewDamage > 0 && lane.ai && lane.ai.currentHealth > 0) {
            const target = lane.ai;
            let landed = lc.previewDamage;
            let blocked = false;
            if (target.invincibleTurns > 0 || target.hasDamageImmunity) {
              landed = 0; blocked = true;
            } else if (target.evadeCharges > 0) {
              landed = 0; blocked = true;
            } else if (target.armorValue > 0) {
              landed = Math.max(0, lc.previewDamage - target.armorValue);
            }
            const after = Math.max(0, target.currentHealth - landed);
            const dies = !blocked && after <= 0;
            const dmgPreview = document.createElement('div');
            dmgPreview.className = 'dmg-preview chain-preview ' + (dies ? 'chain-kills' : (blocked ? 'chain-blocked' : ''));
            const note = blocked
              ? (target.invincibleTurns > 0 ? 'INVINCIBLE'
                : target.hasDamageImmunity ? 'IMMUNE'
                : 'EVADE')
              : (target.armorValue > 0 ? `−${target.armorValue} Armor` : '');
            dmgPreview.innerHTML = `<div class="dp-row"><span class="dp-side">Hits</span><span class="dp-nums">${target.currentHealth}&nbsp;&rarr;&nbsp;${after}</span></div>` +
              (note ? `<span class="dp-sub">${note}</span>` : '');
            aiSlot.appendChild(dmgPreview);
          }
        }
        // Append card only if not already attached to this slot —
        // re-appending the same child detaches + re-attaches it which
        // kills CSS animation timing (verified: vibeSymbioteOoze
        // resets from 96s back to 0 on slot.appendChild(sameCard)).
        if (cardEl.parentNode !== aiSlot) aiSlot.appendChild(cardEl);
      } else if (lc && lcTargetSide === 'ai' && lc.lanes.includes(i)) {
        aiSlot.classList.add('target-highlight');
        aiSlot.onclick = () => laneChoicePick(i);
      } else if (!lane.destroyed) {
        // Empty-lane drop glyph — faint "+" hinting at placement
        const empty = document.createElement('div');
        empty.className = 'empty-lane-glyph';
        empty.innerHTML = '&#xFF0B;';
        aiSlot.appendChild(empty);
      }
      // Same anti-reattach guard for the slot itself.
      if (aiSlot.parentNode !== el) el.appendChild(aiSlot);

      // Battle centerline separator with embedded lane number — sits between
      // the AI and player halves so it never overlaps card content (Marvel Snap style).
      // Reuse existing sep if present so the .lane-number's 3s
      // tronCirclePulse animation keeps its phase continuous.
      let sep = el.querySelector(':scope > .lane-sep');
      if (!sep) {
        sep = document.createElement('div');
        sep.innerHTML = `<span class="lane-number">${i + 1}</span>`;
      }
      const sepCls = 'lane-sep' + (s._activeLane === i ? ' lane-active' : '');
      if (sep.className !== sepCls) sep.className = sepCls;
      // Append only if not already a child (appendChild on already-
      // attached child triggers detach-reattach which kills CSS
      // animation timing).
      if (sep.parentNode !== el) el.appendChild(sep);

      // Player slot — reuse existing if cached lane already has one.
      let pSlot = el.querySelector(':scope > .player-slot');
      if (!pSlot) {
        pSlot = document.createElement('div');
      }
      if (pSlot.className !== 'card-slot player-slot') pSlot.className = 'card-slot player-slot';
      // Same chosen-element cleanup as ai-slot — compute the cardEl
      // first, then remove any child that isn't it. Handles multi-
      // instance scenarios (e.g. cloned player cards) without
      // accumulation.
      let plCardEl = null;
      if (lane.player) {
        plCardEl = this.makeCardElCached(lane.player, false, 'ally');
      }
      // Mirror of the AI-side stale-handler clear above. Prevents the
      // "wrong card got selected" bug when a prompt re-fires across
      // renders with different cc.cards indices.
      pSlot.onclick = null;
      if (plCardEl) plCardEl.onclick = null;
      Array.from(pSlot.children).forEach(child => {
        if (child !== plCardEl) child.remove();
      });
      // Same anti-invisible-card force-attach as ai-slot. Primary
      // defense against the state-says-card-here-but-DOM-empty bug.
      if (plCardEl && plCardEl.parentNode !== pSlot) {
        pSlot.appendChild(plCardEl);
      }
      if (lane.player) {
        const cardEl = plCardEl;
        if (lane.player.isFaceDown) cardEl.classList.add('face-down');
        if (lane.player.id !== undefined) currentBoardIds.add(lane.player.id);
        if (!this._lastBoardCardIds.has(lane.player.id)) {
          // 1.0s "build from grid" animation; +100ms safety margin.
          cardEl.classList.add('card-enter');
          setTimeout(() => cardEl.classList.remove('card-enter'), 1100);
          // (h) landing dip + (k) claim wave + dust kick + ring ripple —
          // ring is the Snap-style concentric pulse under the card.
          el.classList.add('lane-landed');
          setTimeout(() => el.classList.remove('lane-landed'), 400);
          const wave = document.createElement('div');
          wave.className = 'lane-claim-wave claim-player';
          el.appendChild(wave);
          setTimeout(() => wave.remove(), 750);
          const dust = document.createElement('div');
          dust.className = 'dust-kick';
          pSlot.appendChild(dust);
          setTimeout(() => dust.remove(), 500);
          const ring = document.createElement('div');
          ring.className = 'card-landing-ring ring-player';
          pSlot.appendChild(ring);
          setTimeout(() => ring.remove(), 900);
        }
        if (cc && targetCardIds.has(lane.player.id)) {
          cardEl.classList.add('target-highlight');
          const idx = cc.cards.findIndex(c => c.id === lane.player.id);
          cardEl.onclick = () => cardChoicePick(idx);
        }
        // Lane-choice click on an occupied PLAYER card — mirror of the
        // AI-side handler. Covers any prompt that wants the player to
        // pick one of their own cards by lane.
        if (lc && lcTargetSide === 'player' && lc.lanes.includes(i)) {
          pSlot.classList.add('target-highlight');
          cardEl.classList.add('target-highlight');
          cardEl.style.cursor = 'pointer';
          cardEl.onclick = () => laneChoicePick(i);
        }
        // Anti-reattach guard — see ai-slot equivalent above.
        if (cardEl.parentNode !== pSlot) pSlot.appendChild(cardEl);
      } else if (lc && lcTargetSide === 'player' && lc.lanes.includes(i)) {
        pSlot.classList.add('target-highlight');
        pSlot.onclick = () => laneChoicePick(i);
        // Summon preview — when summonCardChoice supplies a previewCard
        // (Ant-Man's Ant, Cyborg's Doombot, Hela's zombies, etc.) show
        // makeDamagePreview against the opposing enemy so the player
        // sees the trade math before picking a lane. User spec: "When
        // you place a summon, I would also like that to have a damage
        // preview."
        if (lc.previewCard) {
          const preview = this.makeDamagePreview(lc.previewCard, lane.ai, i);
          if (preview) pSlot.appendChild(preview);
        }
      } else if (!lane.destroyed && canPlay && s.selectedCard && !s.selectedCard.isDiscardEffect && !cc && !lc) {
        pSlot.classList.add('playable');
        pSlot.addEventListener('click', () => this.onLaneClick(i));
        // Damage preview — show how this card would trade if placed here.
        const preview = this.makeDamagePreview(s.selectedCard, lane.ai, i);
        if (preview) pSlot.appendChild(preview);
      } else if (!lane.destroyed && !lane.player && !cc && !lc) {
        // Empty ally slot + nothing selected — show the drop glyph
        const empty = document.createElement('div');
        empty.className = 'empty-lane-glyph';
        empty.innerHTML = '&#xFF0B;';
        pSlot.appendChild(empty);
      }
      if (pSlot.parentNode !== el) el.appendChild(pSlot);
      if (el.parentNode !== this.board) this.board.appendChild(el);
    }
    // Any card present last render but missing now was destroyed, bounced,
    // or stolen — fire a short destroy SFX once per removed id. We only
    // play it when something actually left the board so the cue stays
    // meaningful (not every re-render).
    if (this._lastBoardCardIds && this._lastBoardCardIds.size) {
      let removed = 0;
      for (const id of this._lastBoardCardIds) if (!currentBoardIds.has(id)) removed++;
      if (removed > 0) this.sfx.play('cardDestroy');
    }
    this._lastBoardCardIds = currentBoardIds;
  },

  // Lone Wolf is a universal +1/+1 applied by the engine to any card that
  // enters with no other allies on the board (game.js:535). No per-card
  // list here — the bonus is looked up dynamically from the board state.

  // Skull glyph matching the dead-pile icon style — used on the incoming-damage
  // badge when a card is about to die.
  skullSVG() {
    return '<svg class="incoming-skull" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5c-3 0-5.5 2.3-5.5 5.2 0 1.6 0.8 3 2 3.9v2.1c0 0.6 0.5 1 1 1h5c0.5 0 1-0.4 1-1v-2.1c1.2-0.9 2-2.3 2-3.9 0-2.9-2.5-5.2-5.5-5.2z" fill="currentColor"/><circle cx="6" cy="7" r="1.1" fill="#000000"/><circle cx="10" cy="7" r="1.1" fill="#000000"/></svg>';
  },

  // Executioners — destroy a qualifying enemy on play AND gain +1/+1 from onKill.
  // If a valid target exists on the board, the preview should reflect the post-kill stats.
  EXECUTE_KILL_BUFF: {
    'Gamora':         { pred: e => e.currentHealth <= 2,                              atk: 1, hp: 1 },
    'Peacemaker':     { pred: e => (e.attack || 0) <= 2,                              atk: 1, hp: 1 },
    'Deathstroke':    { pred: e => e.currentHealth <= 3,                              atk: 1, hp: 1 },
    'Winter Soldier': { pred: e => (e.attack || 0) <= 3,                              atk: 1, hp: 1 },
    'Ant-Man':        { pred: e => e.currentHealth <= 1 || (e.attack || 0) <= 1,      atk: 0, hp: 0 } // destroys but no onKill stacking buff
  },

  // Cards whose on-play delivers a direct damage/removal that might kill a
  // target and trigger on-kill stacking (e.g. Predator's "+2 ATK when destroys an enemy").
  DAMAGE_KILL_BUFF: {
    'Predator':       { dmg: 3, atk: 2, hp: 0 },   // 3 dmg to chosen enemy; +2 ATK when destroys an enemy
    'Rocket Raccoon': { dmg: 4, atk: 0, hp: 0 },   // 4 dmg — no onKill stacking
    'Human Torch':    { dmg: 2, atk: 0, hp: 0 }
  },

  // Stats as they would be right after placement in `laneIdx`. Accounts for:
  //   - Lone Wolf — universal +1/+1 when no other ally is on the board
  //   - cardPlayedBuff allies — each non-self ally with this passive grants +1/+1
  //   - Execute + onKill +1/+1 when a valid target is on the board
  //   - Damage-based kill buffs (e.g. Predator's +2 ATK on destroy)
  //   - Magneto — -1/-2 when placing into an even-numbered lane (2/4/6)
  //     opposite an enemy-owned Magneto on the board
  projectedStats(card, laneIdx) {
    let atk = card.attack || 0;
    let hp  = card.currentHealth || card.maxHealth || 0;
    if (!Game || !Game.state) return { atk, hp };
    const owner = card.owner;
    const allies = (Game.getAlliesOf && owner)
      ? Game.getAlliesOf(owner).filter(a => a.id !== card.id && a.currentHealth > 0)
      : [];
    // Lone Wolf — engine applies +1/+1 to ANY card entering alone
    if (!allies.length) { atk += 1; hp += 1; }
    // cardPlayedBuff — each non-self ally with this passive grants +1/+1
    for (const a of allies) {
      if (a.passive === 'cardPlayedBuff') { atk += 1; hp += 1; }
    }
    // Execute + onKill stacking
    const exec = this.EXECUTE_KILL_BUFF[card.name];
    if (exec && Game.getEnemiesOf && owner) {
      const hasKill = Game.getEnemiesOf(owner).some(e => e.currentHealth > 0 && exec.pred(e));
      if (hasKill) { atk += exec.atk; hp += exec.hp; }
    }
    // Damage-based kill buff (Predator)
    const dmgBuff = this.DAMAGE_KILL_BUFF[card.name];
    if (dmgBuff && Game.getEnemiesOf && owner) {
      const willKill = Game.getEnemiesOf(owner).some(e => {
        if (e.currentHealth <= 0) return false;
        if (e.invincibleTurns > 0 || e.hasDamageImmunity) return false;
        const after = Math.max(0, e.currentHealth - Math.max(0, dmgBuff.dmg - (e.armorValue || 0)));
        return after <= 0;
      });
      if (willKill) { atk += dmgBuff.atk; hp += dmgBuff.hp; }
    }
    // Magneto — opponent-owned Magneto debuffs any enemy card in an even-
    // numbered lane (index 1, 3, 5) by -1/-2. Applied after all other
    // buffs so the player sees the net post-placement stats.
    if (laneIdx != null && (laneIdx + 1) % 2 === 0 && owner) {
      const enemyHasMagneto = Game.getEnemiesOf
        ? Game.getEnemiesOf(owner).some(e => e.name === 'Magneto' && e.currentHealth > 0)
        : false;
      if (enemyHasMagneto) {
        atk = Math.max(0, atk - 1);
        hp  = hp - 2; // may drop to 0 or below — preview will surface it
      }
    }
    return { atk, hp };
  },

  // Tiny trade-preview pill shown on empty ally lanes when a card is selected.
  // Accounts for Lone Wolf, cardPlayedBuff allies, splash to front, Execute /
  // damage-kill onKill stacks, Magneto even-lane debuff, armor, Evade (one
  // charge consumed per discrete hit), invincibility, damage immunity, and
  // Poison Ivy's charm pre-swing.
  makeDamagePreview(myCard, enemy, laneIdx) {
    if (!myCard) return null;
    // LIVE-SIMULATION PREVIEW. Routes through Game.predictLaneOutcome so
    // the numbers match what combat will actually compute — same engine
    // logic for armor / evade / invincible / immunity / splash from
    // adjacent enemies / stun & freeze gating outgoing swings. The old
    // static heuristic missed adjacent splash (a card "STALL" verdict
    // could in fact be a "LOSE" once an adjacent splasher pings the
    // entering card). predictLaneOutcome is a pure read-only function
    // on a snapshot — no engine side effects, safe to call on every
    // hover/render. User report: "the damage preview isnt working
    // properly can we look into this na dchange it to the live
    // simulationn model".
    const { atk: myAtk, hp: myHp } = this.projectedStats(myCard, laneIdx);
    const splash = myCard.splashRange || 0;
    const box = document.createElement('div');
    box.className = 'dmg-preview';

    // If a Magneto even-lane debuff would outright kill the card on entry,
    // surface that instead of a misleading trade preview.
    if (myHp <= 0) {
      box.innerHTML = `<div class="dp-row dp-will-die"><span class="dp-side">You</span><span class="dp-nums">Dies on entry</span></div>`;
      return box;
    }

    // FULL onPlay SIMULATION first — clones state, runs the card's
    // playCard (which fires onPlay, aura sweep, drawOnPlay), then reads
    // per-lane predictions on the post-play state. Catches abilities
    // that change lane outcomes:
    //   • Hulk — onPlay deals 2 to all enemies → enemies pre-damaged
    //   • Cap — onPlay grants Invincible 1 to ally → ally survives swing
    //   • Storm/Mr. Freeze — onPlay freezes enemies → no enemy swing
    //   • Anti-Venom — onPlay heals 4 → player face survives lethal
    //   • etc.
    // Falls through to the static snapshot below if the sim aborts.
    // User report: "if i were to play raven it doesnt show anything"
    // (lane-choice path) + the broader "live simulation accounting for
    // abilities and buffs."
    if (myCard.id != null && myCard.owner === 'player'
        && typeof Game.previewPlacement === 'function'
        && Game.state && Game.state.player && Game.state.player.hand
        && Game.state.player.hand.indexOf(myCard) >= 0) {
      try {
        const sim = Game.previewPlacement('player', myCard.id, laneIdx);
        if (sim && sim.lanes && sim.lanes[laneIdx]) {
          const pred = sim.lanes[laneIdx];
          const me  = pred && pred.player;
          const you = pred && pred.ai;
          const myHpAfter    = me  ? me.hpAfter  : myHp;
          const enemyHpAfter = you ? you.hpAfter : (enemy ? enemy.currentHealth : 0);
          const incoming = me ? me.dmgIn : 0;
          const totalOut = you ? you.dmgIn : 0;
          // Build the same render shape the static path produces below
          // (verdict + per-side rows + notes), but using sim numbers.
          const enemyDies = !!(you && you.dies);
          const iDie      = !!(me  && me.dies);
          let verdict, verdictCls;
          if      (enemyDies && !iDie) { verdict = 'WIN';    verdictCls = 'dp-verdict-win'; }
          else if (iDie && !enemyDies) { verdict = 'LOSE';   verdictCls = 'dp-verdict-lose'; }
          else if (iDie && enemyDies)  { verdict = 'TRADE';  verdictCls = 'dp-verdict-trade'; }
          else                         { verdict = 'STALL';  verdictCls = 'dp-verdict-stall'; }
          // Uncontested handling: if no enemy on this lane post-onPlay,
          // show the direct face-damage row (uses myAtk + splash since
          // sim.lanes[laneIdx].ai is null when uncontested).
          if (!you) {
            const total = myAtk + splash;
            const splashBit = splash
              ? `<span class="dp-sub">${myAtk} ATK + ${splash} Splash = ${total}</span>`
              : '';
            let directRow = `<div class="dp-row"><span class="dp-side">Direct</span><span class="dp-nums">&minus;${total} HP</span></div>${splashBit}`;
            if (incoming > 0) {
              const dies = me && me.dies;
              directRow += `<div class="dp-row${dies ? ' dp-will-die' : ''}"><span class="dp-side">You</span><span class="dp-nums">${myHp}&nbsp;&rarr;&nbsp;${myHpAfter}</span></div>`;
              if (dies) directRow = `<div class="dp-verdict dp-verdict-lose">LOSE</div>` + directRow;
            }
            box.innerHTML = `<div class="dp-sim-tag">SIM</div>${directRow}`;
            return box;
          }
          const notes = [];
          if (splash > 0 && totalOut > 0) {
            const enemyArmor = (enemy && enemy.armorValue) || 0;
            notes.push(`${myAtk} ATK + ${splash} Splash = ${totalOut}${enemyArmor ? ` (after Armor ${enemyArmor})` : ''}`);
          } else if (splash > 0) {
            notes.push(`Splash ${splash}`);
          }
          const noteHtml = notes.length ? `<span class="dp-sub">${notes.join(' · ')}</span>` : '';
          // Use the SIMULATED enemy HP (pre-combat post-onPlay), not the
          // live enemy.currentHealth — that's what makes Hulk's preview
          // show enemies already at reduced HP.
          const enemyHpStart = (you && (you.hpAfter + you.dmgIn)) || (enemy ? enemy.currentHealth : 0);
          box.innerHTML =
            `<div class="dp-verdict ${verdictCls}">${verdict}</div>` +
            `<div class="dp-row"><span class="dp-side">You</span><span class="dp-nums">${myHp}&nbsp;&rarr;&nbsp;${myHpAfter}</span></div>` +
            `<div class="dp-row"><span class="dp-side">Enemy</span><span class="dp-nums">${enemyHpStart}&nbsp;&rarr;&nbsp;${enemyHpAfter}</span></div>` +
            noteHtml +
            `<div class="dp-sim-tag" title="Simulated with abilities + buffs">SIM</div>`;
          return box;
        }
      } catch (e) { /* swallow — fall through to static path */ }
    }

    // Build the hypothetical "you played myCard into laneIdx" snapshot
    // using the projected stats (which already include Magneto / aura
    // adjustments). Pass this to the live simulator alongside the
    // existing enemy snap.
    const myHypoSnap = {
      name: myCard.name,
      currentHealth: myHp,
      attack: myAtk,
      splashRange: splash,
      armorValue: myCard.armorValue || 0,
      evadeCharges: myCard.evadeCharges || 0,
      invincibleTurns: myCard.invincibleTurns || 0,
      hasDamageImmunity: !!myCard.hasDamageImmunity,
      isStunned: !!myCard.isStunned,
      isFrozen:  !!myCard.isFrozen,
      isBullseye: !!myCard.isBullseye,
      owner: 'player',
    };

    if (!enemy || enemy.currentHealth <= 0) {
      // Uncontested — face damage = ATK + splash. ALSO call the simulator
      // to pick up adjacent enemy splash that might damage the entering
      // card (the static path missed this entirely).
      const total = myAtk + splash;
      const splashBit = splash
        ? `<span class="dp-sub">${myAtk} ATK + ${splash} Splash = ${total}</span>`
        : '';
      let directRow = `<div class="dp-row"><span class="dp-side">Direct</span><span class="dp-nums">&minus;${total} HP</span></div>${splashBit}`;
      try {
        const result = Game.predictLaneOutcome(laneIdx, { player: myHypoSnap });
        if (result && result.player && result.player.dmgIn > 0) {
          // Adjacent splash hits the entering card on uncontested entry.
          // Surface this so the player isn't surprised when their fresh
          // 5/2 enters and immediately drops to 5/0 from a flanking Hulk.
          const after = result.player.hpAfter;
          const dies = result.player.dies;
          directRow += `<div class="dp-row${dies ? ' dp-will-die' : ''}"><span class="dp-side">You</span><span class="dp-nums">${myHp}&nbsp;&rarr;&nbsp;${after}</span></div>`;
          if (dies) {
            directRow = `<div class="dp-verdict dp-verdict-lose">LOSE</div>` + directRow;
          }
        }
      } catch (e) { /* prediction failure → just show direct row */ }
      box.innerHTML = directRow;
      return box;
    }

    // CONTESTED — run the live simulator. Falls back to static math if
    // prediction fails for any reason (shouldn't, but defense-in-depth).
    let result = null;
    try { result = Game.predictLaneOutcome(laneIdx, { player: myHypoSnap }); }
    catch (e) { result = null; }

    let enemyHpAfter, myHpAfter, totalOut, incoming;
    if (result && result.player && result.ai) {
      myHpAfter    = result.player.hpAfter;
      enemyHpAfter = result.ai.hpAfter;
      incoming     = result.player.dmgIn;
      totalOut     = result.ai.dmgIn;
    } else {
      // ---- Static fallback (legacy math) ----
      const enemyArmor   = enemy.armorValue || 0;
      const enemyImmune  = (enemy.invincibleTurns > 0) || enemy.hasDamageImmunity;
      let enemyEvadesLeft = (!myCard.isBullseye && enemy.evadeCharges > 0) ? enemy.evadeCharges : 0;
      const outHits = [];
      if (myAtk > 0) outHits.push(myAtk);
      if (splash > 0) outHits.push(splash);
      totalOut = 0;
      for (const raw of outHits) {
        if (enemyImmune) break;
        if (enemyEvadesLeft > 0) { enemyEvadesLeft--; continue; }
        totalOut += raw > enemyArmor ? raw - enemyArmor : 0;
      }
      enemyHpAfter = enemyImmune ? enemy.currentHealth : Math.max(0, (enemy.currentHealth || 0) - totalOut);
      const myArmor = myCard.armorValue || 0;
      const iImmune = myCard.invincibleTurns > 0 || myCard.hasDamageImmunity;
      let evadesLeft = myCard.evadeCharges || 0;
      incoming = 0;
      const enemyAtk = (enemy.isStunned || enemy.isFrozen) ? 0 : (enemy.attack || 0);
      if (enemyAtk > 0) {
        if (iImmune) { /* no damage */ }
        else if (evadesLeft > 0) { evadesLeft--; }
        else { incoming += Math.max(0, enemyAtk - myArmor); }
      }
      myHpAfter = iImmune ? myHp : Math.max(0, myHp - incoming);
    }

    const notes = [];
    // Splash breakdown — show only when it contributed and the
    // simulator's resolved number isn't just raw ATK.
    if (splash > 0 && totalOut > 0) {
      const enemyArmor = enemy.armorValue || 0;
      notes.push(`${myAtk} ATK + ${splash} Splash = ${totalOut}${enemyArmor ? ` (after Armor ${enemyArmor})` : ''}`);
    } else if (splash > 0) {
      notes.push(`Splash ${splash}`);
    }
    // Surface adjacent-splash damage so the player understands extra
    // incoming hits (was invisible in the old static preview).
    if (incoming > (enemy.attack || 0) && !enemy.isStunned && !enemy.isFrozen) {
      const extra = incoming - (enemy.attack || 0);
      notes.push(`+${extra} adjacent splash`);
    } else if ((enemy.isStunned || enemy.isFrozen) && incoming > 0) {
      notes.push(`+${incoming} adjacent splash`);
    }
    const noteHtml = notes.length ? `<span class="dp-sub">${notes.join(' · ')}</span>` : '';

    // One-word verdict at the top — lets the player read the outcome
    // without doing HP math in their head under time pressure.
    const enemyDies = enemyHpAfter <= 0;
    const iDie = myHpAfter <= 0;
    let verdict, verdictCls;
    if      (enemyDies && !iDie) { verdict = 'WIN';    verdictCls = 'dp-verdict-win'; }
    else if (iDie && !enemyDies) { verdict = 'LOSE';   verdictCls = 'dp-verdict-lose'; }
    else if (iDie && enemyDies)  { verdict = 'TRADE';  verdictCls = 'dp-verdict-trade'; }
    else                         { verdict = 'STALL';  verdictCls = 'dp-verdict-stall'; }

    box.innerHTML =
      `<div class="dp-verdict ${verdictCls}">${verdict}</div>` +
      `<div class="dp-row"><span class="dp-side">You</span><span class="dp-nums">${myHp}&nbsp;&rarr;&nbsp;${myHpAfter}</span></div>` +
      `<div class="dp-row"><span class="dp-side">Enemy</span><span class="dp-nums">${enemy.currentHealth}&nbsp;&rarr;&nbsp;${enemyHpAfter}</span></div>` +
      noteHtml;
    return box;
  },
  // Replicas of AI.wouldKill / wouldSurvive (kept UI-local so we don't require
  // the AI module at render time).
  combatWouldKill(a, b) {
    if (!b) return false;
    if (b.invincibleTurns > 0 || b.hasDamageImmunity) return false;
    if (b.evadeCharges > 0 && !a.isBullseye) return false;
    const dmg = Math.max(0, (a.attack || 0) - (b.armorValue || 0));
    return dmg >= b.currentHealth;
  },
  combatWouldSurvive(a, b) {
    if (!b) return true;
    if (a.invincibleTurns > 0 || a.hasDamageImmunity) return true;
    if (a.evadeCharges > 0) return true;
    const incoming = Math.max(0, (b.attack || 0) - (a.armorValue || 0));
    return (a.currentHealth || a.maxHealth || 0) > incoming;
  },

  // ===================== ORB TOOLTIPS =====================
  // Build a human-readable explanation of why a card's cost / attack /
  // maxHealth differs from its base. Returned as an array of lines (empty
  // if nothing to explain) — caller joins with '\n' for a native `title`
  // attribute. Covers the mechanisms from the modifier inventory:
  // Mr. Fantastic discount, Captain America discount, Silver Surfer aura,
  // Luke Skywalker aura, Magneto even-lane debuff, Man-Bat -1/-1 stacks,
  // `_grantedBuffs` temp buffs, and the base-vs-current delta for anything
  // not attributed above.
  explainCost(card, owner) {
    const lines = [];
    const base = card.baseCost != null ? card.baseCost : card.cost;
    if (card._nextDrawDiscount) lines.push(`Mr. Fantastic discount: −${card._nextDrawDiscount}`);
    // Captain America discount is LIVE — count active CAs on the
    // owner's side and show their tier-discount sum. When CA dies
    // the count drops and the line disappears, matching the live
    // cost change in Game.getCardCost.
    if (owner) {
      const cas = Game.getAllCardsOf(owner).filter(c => c.passive === 'allyCostReduction' && c.currentHealth > 0);
      if (cas.length) {
        let total = 0;
        cas.forEach(ca => { total += Game.rarityValue(ca, { common: 1, rare: 1, special: 2, legendary: 2 }); });
        lines.push(`Captain America discount: −${total}`);
      }
    }
    // Silver Surfer enemy-cost aura only affects cards in HAND, applied
    // live by Game.getCardCost — so only show this line for hand cards.
    if (owner) {
      const opp = owner === 'player' ? 'ai' : 'player';
      const ss = Game.getAllCardsOf(opp).filter(c => c.passive === 'enemyCostIncrease' && c.currentHealth > 0);
      if (ss.length) lines.push(`${ss[0].name} aura: +${ss.length}`);
    }
    if (!lines.length) return null;
    return [`Base cost: ${base}`].concat(lines);
  },
  explainStat(card, which /* 'attack' | 'health' */) {
    const lines = [];
    const base = which === 'attack' ? (card.baseAttack != null ? card.baseAttack : card.attack)
                                    : (card.baseHealth != null ? card.baseHealth : card.maxHealth);
    const cur = which === 'attack' ? card.attack : card.maxHealth;
    if (cur === base) return null;
    // Aura flags. These are set on the card when an aura source lands and
    // cleared when it leaves; their exact delta is fixed by design.
    if (card._lukeBuff)       lines.push(`Luke Skywalker aura: +1`);
    if (card._lukeDebuff)     lines.push(`Luke Skywalker aura: −1`);
    if (card._magnetoDebuffed) lines.push(`Magneto even-lane aura: ${which === 'attack' ? '−1' : '−2'}`);
    if (card._debuffStacks)   lines.push(`Man-Bat debuff: −${card._debuffStacks}`);
    // Temp buffs from grantTempBuff — tricks, Invisible Woman, Red Skull,
    // etc. Each entry records the delta and duration.
    if (Array.isArray(card._grantedBuffs)) {
      card._grantedBuffs
        .filter(b => (which === 'attack' && b.prop === 'attack') ||
                     (which === 'health' && (b.prop === 'maxHealth' || b.prop === 'currentHealth')))
        .forEach(b => {
          const sign = (b.delta || 0) >= 0 ? '+' : '−';
          const mag = Math.abs(b.delta || 0);
          lines.push(`Temp buff: ${sign}${mag} (${b.turnsLeft || 1}t)`);
        });
    }
    if (!lines.length) {
      // Fallback — we know the stat changed but can't attribute it.
      const diff = cur - base;
      const sign = diff >= 0 ? '+' : '−';
      lines.push(`Effects: ${sign}${Math.abs(diff)}`);
    }
    const label = which === 'attack' ? 'Base ATK' : 'Base HP';
    return [`${label}: ${base}`].concat(lines);
  },

  // ===================== CARD ELEMENT =====================

  makeCardEl(card, inHand, side) {
    const el = document.createElement('div');
    el.className = `card ${this.getCostClass(card.baseCost || card.cost)}`;
    // Roguelite rarity tinting — when a card carries `_runRarity`
    // (set by Roguelite.buildRunCard), add `rl-tier-<rarity>` so the
    // rarity-themed CSS overrides the cost-class colors. Non-roguelite
    // cards skip this and keep the cost-tier styling unchanged.
    if (card._runRarity) {
      el.classList.add('rl-tier-' + card._runRarity);
    }
    if (card.id) el.setAttribute('data-card-id', card.id);
    // Name attribute powers the per-card SFX registry (hover/play/ability/
    // attack/death). Event delegation + Game patches in installCardSfx
    // look up sounds via this attribute, so every card element — hand,
    // board, draft, hover-magnify — needs it set.
    if (card.name) el.setAttribute('data-card-name', card.name);

    // Board coloring: ally = blue, enemy = red
    if (!inHand && side === 'ally') el.classList.add('ally-card');
    if (!inHand && side === 'enemy') el.classList.add('enemy-card');
    if (inHand) el.classList.add('hand-card');

    // Tron perimeter chrome — applyTronFx() adds these post-mount, but
    // we add them upfront here so the FRESH element built during a
    // cache-miss transplant already has them. Without this, the
    // diff sees `tron-perimeter` on the cached el (added by post-mount
    // applyTronFx) but missing from fresh, and removes it — which
    // kicks the .tron-perimeter::after rule out and back in,
    // restarting the animation. Applies to BOTH board and hand cards
    // (applyTronFx targets both via _TRON_PERIM_CARD_SELECTORS).
    el.classList.add('tron-perimeter', 'tron-perimeter-card');

    // (AAA) HP-critical tremor — board cards at 1 HP get a sub-pixel
    // tremble + red rim accent so the player can read "lethal range"
    // at a glance. Hand cards skipped (hand HP doesn't matter until
    // the card hits the board). Cards with maxHealth = 1 (1-HP units)
    // are excluded — the tremor is for cards that have BEEN damaged
    // down to 1, not cards that started at 1. Never apply to
    // already-dead cards.
    if (!inHand && card.currentHealth === 1 && (card.maxHealth || 0) > 1) {
      el.classList.add('card-hp-critical');
    }

    // (AAA) PERSISTENT DAMAGE MARKS — cards that took damage but
    // didn't die show physical scarring that stays until they're
    // healed back to full. Three tiers based on damage proportion:
    //   light  — any damage taken      (single hairline crack)
    //   heavy  — ≥40% of max HP gone   (forking crack + dark smudge)
    //   crit   — only 1 HP remaining   (full shatter pattern)
    // Hand cards skipped (hand HP doesn't matter until played). Cards
    // born at 1 HP can't be scarred. Re-rendering reuses the same
    // overlay so the cracks aren't re-randomized every tick — the
    // overlay's clip-path is keyed off card.id so each card gets a
    // unique-but-stable shatter shape. Already-dead cards skipped.
    if (!inHand && card.currentHealth > 0 && (card.maxHealth || 0) > 1) {
      const dmgTaken = card.maxHealth - card.currentHealth;
      if (dmgTaken > 0) {
        const ratio = dmgTaken / card.maxHealth;
        el.classList.add('card-scarred');
        if (ratio >= 0.4) el.classList.add('card-scarred-heavy');
        if (card.currentHealth === 1 && card.maxHealth >= 3) el.classList.add('card-scarred-crit');
        // Stable per-card variant index 0..3 — picks one of four crack
        // patterns so cards on the same board don't all share the
        // identical shatter (would read as a tile, not a wound).
        const variant = ((card.id | 0) * 2654435761 >>> 0) % 4;
        el.style.setProperty('--scar-variant', variant);
      }
    }

    // (PRO) Animation phase persistence — every UI.render() that does
    // a fresh build creates a new DOM node, restarting CSS animations
    // at 0%. The phaseOffsetFor() helper deterministically hashes
    // card.id into a phase position within each animation cycle, so
    // a freshly-built element resumes at the same phase its predecessor
    // was at. Combined with the diff-render cache (makeCardElCached),
    // this means: cached element → CSS animation continues literally
    // uninterrupted; fresh element → CSS animation appears continuous.
    //
    // We set TWO phase offsets so different animations can share the
    // same identity-stable schedule but at different cycle lengths:
    //   --card-anim-phase   — 5s perimeter pulse (.tron-perimeter-card)
    //   --tremor-phase      — 280ms HP-critical tremor (.card-hp-critical)
    if (!inHand && card.id != null) {
      this.applyPhaseOffset(el, card.id, 5000, '--card-anim-phase');
      this.applyPhaseOffset(el, card.id, 280, '--tremor-phase');
    }

    // Status effect glow classes (priority: first matching wins for glow)
    if (card.isStunned) el.classList.add('status-stunned');
    else if (card.isFrozen) el.classList.add('status-frozen');
    else if (card.isFeared) el.classList.add('status-feared');
    else if (card.isMindControlled) el.classList.add('status-mind-ctrl');
    else if (card.invincibleTurns > 0) el.classList.add('status-invincible');
    else if (card.hasDamageImmunity) el.classList.add('status-dmg-immune');
    else if (card.tauntTurns > 0) el.classList.add('status-taunt');
    else if (card.armorValue > 0) el.classList.add('status-armor');
    else if (card.evadeCharges > 0) el.classList.add('status-evade');

    // Poison Ivy charmed glow (additive, doesn't replace status glow).
    // Mirror the three-layer match used by the badge filter above so
    // the visual stays in sync — flag, then legacy ref, then ATK-delta
    // self-heal.
    const ivyOnSide = Game.getAllCardsOnBoard().filter(x =>
      x.name === 'Poison Ivy' && x.owner === card.owner && x.currentHealth > 0
    );
    let glowMatch = false;
    for (const ivy of ivyOnSide) {
      if (card._charmedByIvy != null && card._charmedByIvy === ivy.id) { glowMatch = true; break; }
      if (ivy._ivyAlly && ivy._ivyAlly.id === card.id) { glowMatch = true; break; }
      const buff = (ivy._grantedBuffs || []).find(b => b && b._ivyCharm && (b.delta | 0) > 0);
      if (!buff) continue;
      const allies = Game.getAllCardsOf(ivy.owner).filter(a => a.id !== ivy.id && a.currentHealth > 0 && (a.attack || 0) > 0);
      if (!allies.length) continue;
      const matching = allies.filter(a => (a.attack | 0) === (buff.delta | 0));
      const pick = (matching.length ? matching : allies).slice().sort((a, b) => (b.attack || 0) - (a.attack || 0))[0];
      if (pick && pick.id === card.id) { glowMatch = true; break; }
    }
    if (glowMatch) el.classList.add('status-charmed');

    // Crazy flag — cards whose attack is randomized each turn get a
    // wobble + hue-glitch effect so the dice-roll feel reads at a
    // glance. Joker and Harley are always crazy while on the board;
    // the highest-ATK enemy on a side gets the mark too when a Joker
    // is alive on the opposite side (since Joker's chaos warps them).
    // Skipped for cards in hand — the effect is a board mechanic.
    if (!inHand && this.isCardCrazy(card)) el.classList.add('status-crazy');
    // Character-flavored vibe — per-archetype subtle animation that
    // gives iconic cards a distinct idle feel. Same board-only rule:
    // hand cards stay static, and vibes defer to the crazy flag when
    // both would apply (Joker/Harley can't be "cosmic" + "crazy" at
    // once — crazy wins).
    if (!inHand && !this.isCardCrazy(card)) {
      const vibe = this.getCardVibe(card);
      if (vibe) el.classList.add('vibe-' + vibe);
    }

    const baseCost = card.baseCost || card.cost;
    // In-hand cards show the real cost to play (includes enemy passives like
    // Silver Surfer's +1). On-board cards show their raw cost since it no
    // longer matters for play decisions.
    const displayCost = inHand && card.owner && Game.getCardCost
      ? Game.getCardCost(card.owner, card)
      : card.cost;
    const costStyle = displayCost < baseCost ? 'color:#2ecc71' : displayCost > baseCost ? 'color:#e74c3c' : '';
    const cornerIndicators = '';

    // Buff/debuff classes on the stat orbs — compare current to the
    // card's stored base (baseAttack / baseHealth from createCardInstance).
    // Green aura if pumped above base, red aura if reduced below it. HP
    // comparison uses maxHealth (not currentHealth, which reflects damage).
    const atkBuff  = card.attack != null && card.baseAttack != null && card.attack > card.baseAttack;
    const atkDebuff = card.attack != null && card.baseAttack != null && card.attack < card.baseAttack;
    const hpBuff  = card.maxHealth != null && card.baseHealth != null && card.maxHealth > card.baseHealth;
    const hpDebuff = card.maxHealth != null && card.baseHealth != null && card.maxHealth < card.baseHealth;
    const atkCls = atkBuff ? ' stat-buffed' : atkDebuff ? ' stat-debuffed' : '';
    const hpCls  = hpBuff  ? ' stat-buffed' : hpDebuff  ? ' stat-debuffed' : '';
    // Build hover-tooltip text for any orb whose current value differs from
    // its base (or, for cost, differs from the base OR has a live aura).
    // Uses native `title` attribute — hover-hold reveals the explanation
    // with each contributor on its own line.
    const atkTipLines = (atkBuff || atkDebuff) ? this.explainStat(card, 'attack') : null;
    const hpTipLines = (hpBuff || hpDebuff) ? this.explainStat(card, 'health') : null;
    const costTipLines = this.explainCost(card, inHand ? card.owner : null);
    const atkTip = atkTipLines ? ` title="${atkTipLines.join('&#10;').replace(/"/g, '&quot;')}"` : '';
    const hpTip = hpTipLines ? ` title="${hpTipLines.join('&#10;').replace(/"/g, '&quot;')}"` : '';
    // Unknown-stat display: in HAND, certain cards hide their ATK/HP
    // behind a "?" because their numbers aren't determined until they
    // land on the board.
    //   • Scarlet Witch (copiesOpposite) — both ATK and HP are "?"
    //     (she copies the enemy directly opposite at play-time).
    //   • Joker (Insane) and Harley Quinn (Crazy) — ATK is "?" because
    //     it rerolls on entry (and again every turn). HP is fixed.
    // On the board the actual numbers are shown — once played, the
    // stats are known. Draft cards also use "?" so the player picks
    // Scarlet Witch / Joker / Harley with the same uncertainty the
    // game then preserves in hand.
    const hideAllStats = !!card.copiesOpposite && inHand;
    const hideAtk = inHand && (card.copiesOpposite || card.isCrazy || card.isInsane);
    const atkCell = hideAtk ? '?' : card.attack;
    const hpCell  = hideAllStats ? '?' : card.currentHealth;
    const statOrbs = card.isDiscardEffect ? '' : `
      <span class="stat-circle stat-atk${atkCls}"${atkTip}>${atkCell}</span>
      <span class="stat-circle stat-hp${hpCls}"${hpTip}>${hpCell}</span>`;

    // Moder strips abilities — show a clean, obvious "no abilities" state
    // for the card's INNATE description and active-ability text. Status
    // badges still render: a stripped card can still receive buffs from
    // other sources (Invisible Woman Evade, Red Skull +1/+2, trick buffs,
    // etc.) and those effects actually apply during combat, so the badges
    // must reflect the card's current effective state regardless of
    // whether Moder wiped its original kit.
    if (card._moderStripped) el.classList.add('moder-stripped');
    const descHtml = card._moderStripped
      ? `<div class="card-desc desc-stripped">⛔ Abilities Stripped</div>`
      : `<div class="card-desc">${this.formatDesc(card.desc)}</div>`;
    const statusHtml = `<div class="status-badges">${this.getStatusBadges(card)}</div>`;
    const activeHtml = card._moderStripped ? '' : this.getActiveAbilityText(card);

    // Live MVP tracker — only the TOP TWO cards per side (by composite
    // MVP score incl. summon-chain inheritance) carry a star pip. #1
    // gets a gold star; #2 gets silver. Rankings are precomputed once
    // per render in UI.computeMvpRanks and cached on this._mvpRanks so
    // every card look-up is O(1). Hover reveals the score + breakdown.
    const mvpScore = this.mvpScoreOf(card);
    const sideRanks = this._mvpRanks && card.owner ? this._mvpRanks[card.owner] : null;
    let mvpRankClass = '';
    let mvpRankLabel = '';
    if (!inHand && sideRanks && card.id != null && mvpScore > 0) {
      if (card.id === sideRanks.firstId)       { mvpRankClass = 'mvp-gold';   mvpRankLabel = 'MVP #1'; }
      else if (card.id === sideRanks.secondId) { mvpRankClass = 'mvp-silver'; mvpRankLabel = 'MVP #2'; }
    }
    let mvpStarSpan = '';
    if (mvpRankClass) {
      const tooltip = [
        `${mvpRankLabel}: ${mvpScore}`,
        `  Damage done: ${(card.statsHealthbarDamage || 0) + (card.statsEnemyDamage || 0)}`,
        `  Damage absorbed: ${card.statsDamageAbsorbed || 0}`,
        `  Energy generated: ${card.statsEnergyGenerated || 0}`,
        `  Kills: ${card.statsKills || 0} (×5 = ${(card.statsKills || 0) * 5})`
      ].join('&#10;');
      mvpStarSpan = `<span class="card-mvp-star ${mvpRankClass}" title="${tooltip}" aria-label="${mvpRankLabel} score ${mvpScore}">`
                  + `<svg viewBox="0 0 10 10" aria-hidden="true">`
                  + `<polygon points="5,0.3 6.3,3.7 10,3.9 7,6.1 8.1,9.7 5,7.6 1.9,9.7 3,6.1 0,3.9 3.7,3.7"/>`
                  + `</svg>`
                  + `</span>`;
    }

    // Rarity pips — tiny neon squares in the top-right corner, 1-4 count
    // encodes the rarity tier (common/uncommon/rare/legendary). The MVP
    // star slots in as the leftmost element of this row when present.
    //
    // Roguelite cards key off their `_runRarity` directly (1 common,
    // 2 rare, 3 special, 4 legendary). Classic-mode cards fall back
    // to the cost-tier proxy. User direction: "these cards on board
    // need to be neon-highlighted to designate their rarity — it's
    // the number-of-rarity squares."
    const _rarityCost = card.baseCost || card.cost || 0;
    let _pipCount = _rarityCost <= 3 ? 1 : _rarityCost <= 6 ? 2 : _rarityCost <= 8 ? 3 : 4;
    if (card._runRarity) {
      const _rlPips = { common: 1, rare: 2, special: 3, legendary: 4 };
      if (_rlPips[card._runRarity]) _pipCount = _rlPips[card._runRarity];
    }
    const rarityStrip = `<span class="rarity-strip" aria-hidden="true">${mvpStarSpan}${'<span class="rpip"></span>'.repeat(_pipCount)}</span>`;

    // Placeholder kept for template — mvp star is injected above inside
    // rarityStrip so the template slot that used to render it is empty.
    const mvpStarHtml = '';

    // Incoming-damage preview — shown on-board ALWAYS (any non-game-over
    // mid-match state) so the player can see which cards are about to
    // eat damage at every decision point, not just during the trick
    // phase. Routes through Game.predictLaneOutcome so the math stays
    // consistent with the lane-forecast strip + the placement preview
    // — same simulator, no duplicate arithmetic to drift out of sync.
    // User report: "There's no red skulls on my people. I feel like
    // they should always be showing the damage numbers of the cards
    // and of cards that could die."
    let incomingBadge = '';
    if (!inHand && Game.state && !card.isFaceDown && card.currentHealth > 0
        && !Game.state.gameOver
        && typeof Game.predictCombatGlobal === 'function') {
      // Cache one global combat prediction per render so each card
      // lookup is O(1). Cleared at the start of each top-level render.
      let pred = this._combatPredCache;
      if (!pred) {
        try { pred = Game.predictCombatGlobal(); } catch (e) { pred = null; }
        this._combatPredCache = pred;
      }
      const me = pred && pred.byId && pred.byId.get(card.id);
      if (me && me.dies) {
        incomingBadge = `<span class="incoming-damage lethal" title="Dies in combat${me.dmgIn > 0 ? ' (takes ' + me.dmgIn + ')' : ''}">${this.skullSVG()}</span>`;
      } else if (me && me.dmgIn > 0) {
        // Show damage as "−N" (negative HP delta) instead of just the
        // hpAfter number. User report: "why is it saying that the goons
        // won't take damage? they only have armor 1 so they will take
        // 1 damage" — the previous "3" badge (meaning hpAfter=3) was
        // easy to confuse with stat orbs and didn't read as a damage
        // intake. The minus sign + delta is unambiguous.
        incomingBadge = `<span class="incoming-damage" title="HP after combat: ${me.hpAfter} (takes ${me.dmgIn})">−${me.dmgIn}</span>`;
      }
    }
    // Card-XP chip — sits in the same bottom-center slot as the
    // incoming-damage badge. Mutually exclusive on the BOARD: damage
    // badge wins. In HAND there's no damage prediction, so the chip
    // always renders. User spec: "I'd like it to be current to see
    // which cards I want to play to level up, on board and in hand I
    // want to see the XP."
    let xpChip = '';
    if (!incomingBadge && card._runDeckCardRef && typeof Roguelite !== 'undefined') {
      const dc = card._runDeckCardRef;
      if (dc.rarity === 'legendary') {
        xpChip = `<span class="card-xp-chip card-xp-cap" title="Legendary — XP capped">MAX</span>`;
      } else {
        const stored = dc.xp || 0;
        // Add in-fight stats live so the chip reflects what the card
        // has earned so far this combat. Hand cards have no stats
        // accumulated, so projected = 0 and the chip just shows
        // stored XP.
        const projected = (Roguelite.projectedXp ? Roguelite.projectedXp(card) : 0);
        const xp = stored + projected;
        const threshold = (Roguelite.XP_THRESHOLDS && Roguelite.XP_THRESHOLDS[dc.rarity]) || 0;
        if (threshold > 0) {
          const pct = Math.min(100, Math.max(0, Math.round((xp / threshold) * 100)));
          const tip = projected > 0
            ? `XP toward next tier: ${xp}/${threshold} (${stored} stored + ${projected} this fight)`
            : `XP toward next tier: ${xp}/${threshold}`;
          xpChip = `<span class="card-xp-chip" title="${tip}"><span class="card-xp-fill" style="width:${pct}%"></span><span class="card-xp-text">${xp}/${threshold}</span></span>`;
        }
      }
    }

    const costTip = costTipLines ? ` title="${costTipLines.join('&#10;').replace(/"/g, '&quot;')}"` : '';
    // (AAA) PORTRAIT — extracted from your full-card PSDs via the
    // batch script in tools/. Falls back to no-portrait when the
    // PNG file is missing (cards without art-source still render
    // fine, just without the painted portrait). The art lives at
    // audio/cards/art/<exact card name>.png so the path resolution
    // is name-driven; no per-card lookup table needed.
    // Cache buster — bumped whenever extract_card_art.py is re-run
    // so the browser re-fetches updated portraits instead of serving
    // stale cached PNGs. PNG files don't have a built-in cache buster
    // (unlike HTML/CSS/JS which use ?v=N in index.html), so we append
    // it here at render time.
    const portraitFile = card.name ? UI.getCardArtPath(card.name) : null;
    // REDESIGN: art-at-top with name overlay (Marvel Snap pattern).
    // Standalone .card-name-banner row removed — the name now lives as
    // a translucent strip across the BOTTOM of the portrait. One
    // unified visual block instead of "title row / art / text / stats".
    // Cards without art still render the box with the name overlay so
    // the layout stays consistent. Per-card name escape: text content
    // only, no HTML, so a card named with special chars renders safely.
    const portraitStyle = portraitFile ? `--portrait-bg:url('${portraitFile}')` : '';
    const portraitHtml = `<div class="card-portrait" style="${portraitStyle}"><div class="card-name-overlay">${card.name || ''}</div></div>`;
    // [ CARD DATA ] divider was removed per user feedback — read as
    // distracting, didn't add information beyond the visual gap that
    // already exists between the portrait and the desc text. The
    // painting → status → desc → orbs chain reads cleanly without it.
    el.innerHTML = `
      <span class="card-cost"${costStyle ? ` style="${costStyle}"` : ''}${costTip}>${displayCost}</span>
      ${rarityStrip}
      ${xpChip}
      ${mvpStarHtml}
      ${cornerIndicators}
      ${portraitHtml}
      ${statusHtml}
      ${descHtml}
      ${activeHtml}
      ${statOrbs}
      ${incomingBadge}
    `;
    return el;
  },

  // ===================== AI ACTION TOAST =====================
  // Shows a brief notification when the AI plays a trick OR a discard-
  // effect card (Mr. Fantastic etc.), so the player doesn't have to watch
  // the combat log to know what happened. `kind` is 'trick' (default) or
  // 'discard' — changes the label and a body class that swaps color chrome.
  showAITrickToast(name, desc, kind) {
    const toast = document.getElementById('ai-trick-toast');
    if (!toast) return;
    const nameEl = document.getElementById('ai-trick-name');
    const descEl = document.getElementById('ai-trick-desc');
    const labelEl = document.getElementById('ai-trick-label');
    // Queue if one is already showing so consecutive AI actions don't overlap.
    this._aiTrickQueue = this._aiTrickQueue || [];
    this._aiTrickQueue.push({ name, desc, kind: kind || 'trick' });
    if (this._aiTrickToastActive) return;
    this._aiTrickToastActive = true;
    const showNext = () => {
      if (!this._aiTrickQueue.length) {
        this._aiTrickToastActive = false;
        return;
      }
      const { name, desc, kind } = this._aiTrickQueue.shift();
      nameEl.textContent = name;
      descEl.innerHTML = this.formatDesc(desc) || '';
      if (labelEl) labelEl.textContent = kind === 'discard' ? 'AI played a Discard' : 'AI played a Trick';
      toast.classList.toggle('toast-kind-discard', kind === 'discard');
      toast.classList.toggle('toast-kind-trick', kind !== 'discard');
      toast.style.display = 'block';
      toast.classList.add('active');
      clearTimeout(this._aiTrickTimeout);
      // 4s display — long enough for the player to read the trick name
      // + description + connect it to whatever just changed on the
      // board. The previous 2.6s wasn't long enough for surprise plays
      // (block-trick auto-fires, free Mr. Fantastic discard) where the
      // player has to context-switch from "what's the board state" to
      // "wait, what just happened?". User report: "I never know what
      // trick they play. I need to have it shown to me."
      this._aiTrickTimeout = setTimeout(() => {
        toast.classList.remove('active');
        setTimeout(() => {
          if (!this._aiTrickQueue.length) toast.style.display = 'none';
          showNext();
        }, 300);
      }, 4000);
    };
    showNext();
  },

  // ===================== ROUND TRACK =====================
  renderRoundTrack(s) {
    const el = document.getElementById('round-track');
    if (!el) return;
    const total = 10; // typical game length visualization
    const current = s.round || 0;
    // oddPlayer goes first on odd rounds, opponent on even — that's the
    // standard alternation. A Flash override only affects the immediate
    // round; we reflect the KNOWN current firstPlayer for the current pip
    // and compute future pips by parity.
    const oddPlayer = s.oddPlayer || (s.firstPlayer && current % 2 === 1 ? s.firstPlayer
                                     : s.firstPlayer ? (s.firstPlayer === 'player' ? 'ai' : 'player')
                                     : 'player');
    const firstForRound = (n) => {
      if (n === current && s.firstPlayer) return s.firstPlayer;
      return (n % 2 === 1) ? oddPlayer : (oddPlayer === 'player' ? 'ai' : 'player');
    };
    const pips = [];
    for (let i = 1; i <= total; i++) {
      const state = i < current ? 'past' : i === current ? 'current' : 'future';
      const first = firstForRound(i);
      const side = first === 'player' ? 'first-player' : 'first-ai';
      const title = `Round ${i} — ${first === 'player' ? 'You go first' : 'AI goes first'}`;
      pips.push(`<span class="round-pip ${state} ${side}" title="${title}">${i}</span>`);
    }
    el.innerHTML = pips.join('');
  },

  // ===================== LOG DRAWER =====================
  toggleLogDrawer() {
    const sec = document.getElementById('log-section');
    if (!sec) return;
    // If the drawer was opened from the game-over screen, route through
    // toggleGameOverLog so the `game-over-log-open` class (which forces
    // `transform: translateX(0) !important`) gets cleared too. Without
    // this, the × close button silently fails — `.collapsed` gets added
    // but the !important override keeps the drawer pinned on-screen.
    if (sec.classList.contains('game-over-log-open')) {
      this.toggleGameOverLog();
      return;
    }
    sec.classList.toggle('collapsed');
    // When opening, scroll to bottom
    if (!sec.classList.contains('collapsed')) {
      const log = document.getElementById('game-log');
      if (log) log.scrollTop = log.scrollHeight;
    }
  },

  // ===================== DEAD-PILE PEEK =====================
  installDeadPilePeek() {
    const peek = document.getElementById('dead-peek');
    if (!peek) return;
    const wire = (badge, owner) => {
      if (!badge) return;
      badge.addEventListener('mouseenter', (e) => {
        const list = (Game.state && Game.state[owner] && Game.state[owner].deadPile) || [];
        if (!list.length) return;
        peek.innerHTML = '<div class="peek-title">' + (owner === 'player' ? 'Your dead' : "AI's dead") + '</div>' +
          list.slice(-10).reverse().map(c => `<div class="peek-row"><span class="peek-cost">${c.cost}</span><span class="peek-name">${c.name}</span><span class="peek-stat">${c.attack || 0}/${c.health || 0}</span></div>`).join('');
        const r = badge.getBoundingClientRect();
        peek.style.left = Math.max(8, r.right + 10) + 'px';
        peek.style.top = Math.max(8, r.top) + 'px';
        peek.style.display = 'block';
      });
      badge.addEventListener('mouseleave', () => { peek.style.display = 'none'; });
    };
    // Find the badges by their onclick; simpler: querySelector
    setTimeout(() => {
      const dpP = document.querySelector('.player-bar .dead-pile');
      const dpA = document.querySelector('.ai-bar .dead-pile');
      wire(dpP, 'player');
      wire(dpA, 'ai');
    }, 0);
  },

  makeFaceDownEl() {
    const el = document.createElement('div');
    el.className = 'card face-down-hidden';
    // Inline SVG card-back — tiny repeating diamond pattern. Renders once and
    // doesn't animate, so it's cheap.
    el.innerHTML = `
      <svg class="card-back-pattern" viewBox="0 0 60 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          <pattern id="cbp" x="0" y="0" width="12" height="12" patternUnits="userSpaceOnUse">
            <path d="M6 0 L12 6 L6 12 L0 6 Z" fill="none" stroke="rgba(79,195,247,0.25)" stroke-width="0.6"/>
            <circle cx="6" cy="6" r="1" fill="rgba(79,195,247,0.28)"/>
          </pattern>
        </defs>
        <rect width="60" height="90" fill="url(#cbp)"/>
      </svg>
      <div class="card-back-glyph">&#9830;</div>
      <div class="card-back-label">Face Down</div>`;
    return el;
  },

  // ===================== STATUS BADGES (colored, always with number) =====================

  getActiveAbilityText(card) {
    // Lines are { text, cls } so each renders in its own div and can be
    // styled per-card — Gojo uses a neon purple (matching the Infinity-
    // stone mind color), BWL uses his signature red, Moder keeps the
    // neutral pending-state look. Written in the same uppercase bold
    // form as the "Can be played during the Trick Phase" footer to
    // harmonize with other per-card passive text.
    const lines = [];
    const s = Game.state;
    if (card.name === 'The Batman Who Laughs') {
      const opp = Game.opponent(card.owner);
      if (s[opp].nextCardStolen) {
        lines.push({ text: 'Stealing next enemy card', cls: 'card-active-bwl' });
      }
    }
    if (card.name === 'Moder') {
      const opp = Game.opponent(card.owner);
      if (s[opp].forcedLane !== undefined && s[opp].forcedLane !== null) {
        lines.push({ text: `Next enemy forced into Lane ${s[opp].forcedLane + 1}`, cls: '' });
      }
      const myLane = Game.findCardLane(card);
      if (myLane >= 0) {
        const enemy = s.lanes[myLane][Game.opponent(card.owner)];
        if (enemy && enemy._moderStripped) {
          lines.push({ text: `${enemy.name} stripped of all abilities`, cls: '' });
        }
      }
    }
    if (card.name === 'Gojo' && card._gojoCombats !== undefined && !card._gojoFired) {
      const left = 2 - card._gojoCombats;
      lines.push({ text: `Hollow Purple: ${left === 2 ? 'next turn' : 'this turn'}`, cls: 'card-active-gojo' });
    }
    if (card.name === 'Gojo' && card._gojoFired) {
      lines.push({ text: 'Hollow Purple activated', cls: 'card-active-gojo' });
    }
    if (!lines.length) return '';
    return lines.map(l => `<div class="card-active-text ${l.cls || ''}">${l.text}</div>`).join('');
  },

  // Per-character idle vibes — subtle animations grouped by archetype
  // so similar cards share a sonic-visual language without needing a
  // dedicated effect per card. Skip vibe flagging if a card already
  // has the crazy flag (they'd compete for the same `animation` slot).
  //   cosmic   — reality-benders (hue-shift + gentle rotate)
  //   symbiote — klyntar (viscous skew + dark halo)
  //   slasher  — horror villains (slow menacing red breathe)
  //   titan    — massive bodies (slow breathing scale)
  //   phase    — intangible (opacity pulse)
  //   speed    — fast movers (rapid micro-jitter)
  //   magnetic — tech/metal (metallic hue cycle)
  //   alien    — xenobiology (twitchy biomechanical tremor)
  _CARD_VIBES: {
    'Gojo':'cosmic', 'Dr. Strange':'cosmic', 'Dr. Manhattan':'cosmic',
    'Galactus':'cosmic', 'Silver Surfer':'cosmic', 'Scarlet Witch':'cosmic',
    'Raven':'cosmic', 'Kang':'cosmic', 'Dormammu':'cosmic',
    'Venom':'symbiote', 'Carnage':'symbiote', 'Symbiote Spider-Man':'symbiote',
    'Anti-Venom':'symbiote', 'Knull':'symbiote',
    'Ghostface':'slasher', 'Jason Voorhees':'slasher',
    'Michael Myers':'slasher', 'Predator':'slasher',
    'Thanos':'titan', 'Hulk':'titan', 'Red Hulk':'titan',
    'Darkseid':'titan', 'Mahoraga':'titan', 'Solomon Grundy':'titan',
    'Juggernaut':'titan', 'The Thing':'titan', 'Trigon':'titan',
    'Groot':'titan', 'Bane':'titan', 'Omni-Man':'titan',
    'Invisible Woman':'phase', 'Martian Manhunter':'phase',
    'The Flash':'speed',
    'Magneto':'magnetic', 'Ultron':'magnetic', 'Optimus Prime':'magnetic',
    'Cyborg':'magnetic', 'Iron Man':'magnetic',
    'Xenomorph':'alien'
  },
  getCardVibe(card) {
    if (!card || !card.name) return null;
    if (card.currentHealth != null && card.currentHealth <= 0) return null;
    return this._CARD_VIBES[card.name] || null;
  },

  // Cards that roll for their attack each turn (Joker, Harley Quinn) or
  // that an opposing Joker is actively warping (highest-ATK on their
  // side). Returns true only for alive board cards; hand cards don't
  // carry the effect. Dead cards don't either — the fn short-circuits
  // on currentHealth ≤ 0.
  isCardCrazy(card) {
    if (!card || (card.currentHealth != null && card.currentHealth <= 0)) return false;
    // Traits are now formalized as flags (Crazy / Insane) in
    // applyAbilities — both drive the wobble animation + glitch frame.
    // Previously this function dynamically recomputed which enemy
    // "felt" Crazy based on attack-sort; now the stamp is persistent
    // on the card instance (set by Joker, cleared by Joker's onDeath),
    // so we just read the flag.
    return !!(card.isCrazy || card.isInsane);
  },

  getStatusBadges(c) {
    const b = [];
    // Helper: build a status badge with the keyword tooltip wired in.
    // Stamps `data-kw="<canonical>"` so the same hover/click-to-pin
    // tooltip system the body-text spans use also fires here. Skips
    // the data-kw attribute when the keyword has no KEYWORD_DATA entry
    // (Crazy/Insane don't, so they remain plain).
    const badge = (cls, label, kw) => {
      const hasTip = kw && this.KEYWORD_DATA[kw];
      const dataAttr = hasTip ? ` data-kw="${kw}"` : '';
      return `<span class="status-badge ${cls}"${dataAttr}>${label}</span>`;
    };
    if (c.drawOnPlay > 0) b.push(badge('badge-draw', `Draw ${c.drawOnPlay}`, 'Draw'));
    if (c.evadeCharges > 0) b.push(badge('badge-evade', `Evade ${c.evadeCharges}`, 'Evade'));
    if (c.armorValue > 0) b.push(badge('badge-armor', `Armor ${c.armorValue}`, 'Armor'));
    if (c.isBullseye) b.push(badge('badge-bullseye', 'Bullseye', 'Bullseye'));
    if (c.isOverdrive) b.push(badge('badge-overdrive', 'Overdrive', 'Overdrive'));
    if (c.splashRange > 0) b.push(badge('badge-splash', `Splash ${c.splashRange}`, 'Splash'));
    // Red Hulk's reactive splash — see longer comment below in original.
    if (c.name === 'Red Hulk' && c.currentHealth > 0 && Game && Game.findCardLane) {
      const lane = Game.findCardLane(c);
      const opp = Game.opponent ? Game.opponent(c.owner) : null;
      const front = (lane >= 0 && opp) ? Game.state.lanes[lane][opp] : null;
      const predicted = (front && front.currentHealth > 0) ? (front.attack || 0) : 0;
      if (predicted > 0) {
        b.push(badge('badge-splash', `Splash ${predicted}`, 'Splash'));
      } else {
        b.push(badge('badge-splash', 'Splash', 'Splash'));
      }
    }
    // User feedback: "IMMUNITY 1" reads like damage immunity (most TCG
    // players' default mental model), but this keyword only blocks
    // status debuffs (Freeze, Stun, Fear, etc.). Renamed display label
    // to "Status Immunity N" so the badge is unambiguous. Internal
    // keyword stays 'Immunity' for tooltip + class lookup.
    if (c.immunityCharges > 0) b.push(badge('badge-immune', `Status Immunity ${c.immunityCharges}`, 'Immunity'));
    if (c.invincibleTurns > 0) b.push(badge('badge-invincible', `Invincible ${c.invincibleTurns}`, 'Invincible'));
    if (c.unresistibleCharges > 0) b.push(badge('badge-unresistible', `Unresistible ${c.unresistibleCharges}`, 'Unresistible'));
    if (c.tauntTurns > 0) b.push(badge('badge-taunt', `Taunt ${c.tauntTurns}`, 'Taunt'));
    if (c.hasHunt) b.push(badge('badge-hunt', 'Hunt', 'Hunt'));
    if (c.reviveCharges > 0) b.push(badge('badge-revive', `Revive ${c.reviveCharges}`, 'Revive'));
    if (c.hasDamageImmunity) b.push(badge('badge-dmg-immune', 'DmgImmune', 'Damage Immunity'));
    if (c.isUntrickable) b.push(badge('badge-untrickable', 'Untrickable', 'Untrickable'));
    // Stack-aware status badges — counters drive these.
    if (c.isStunned) {
      const n = c.stunnedTurns > 0 ? c.stunnedTurns : 1;
      b.push(badge('badge-stunned', `Stunned ${n}`, 'Stun'));
    }
    if (c.isFrozen) {
      const n = c.frozenTurns > 0 ? c.frozenTurns : 1;
      b.push(badge('badge-frozen', `Frozen ${n}`, 'Freeze'));
    }
    if (c.isFeared) {
      const n = c.fearedTurns > 0 ? c.fearedTurns : 1;
      b.push(badge('badge-feared', `Feared ${n}`, 'Fear'));
    }
    if (c.isMindControlled) {
      const tgt = c.mindControlTarget;
      const tgtName = tgt && tgt.currentHealth > 0 ? tgt.name : null;
      b.push(badge('badge-mind-ctrl', `MIND${tgtName ? ' - ' + tgtName : ''}`, 'Mind Control'));
    }
    if (c._debuffStacks > 0) b.push(badge('badge-debuff', `-${c._debuffStacks}/-${c._debuffStacks}`));
    // Etch-driven roguelite traits — these are flags set by etch.apply()
    // in Roguelite.buildRunCard. User report: "Phoenix for Flash has
    // disappeared, but I didn't see it as an etch on the card. That
    // needs to be on the card so you don't forget about it." Same
    // principle for Cantrip / Lifesteal / Echo / Berserker / Zealot /
    // Thorns / Discount / Fear — all earned via level-up etches.
    if (c.hasPhoenix > 0) b.push(badge('badge-phoenix', 'Phoenix', 'Phoenix'));
    // Cantrip merged into Draw — both render the Draw N badge above
    // via card.drawOnPlay. Legacy in-flight cards with `hasCantrip`
    // also surface as Draw via the on-play resolution shim.
    if (c.hasCantrip > 0 && !(c.drawOnPlay > 0)) b.push(badge('badge-draw', `Draw ${c.hasCantrip}`, 'Draw'));
    if (c.hasLifesteal > 0) b.push(badge('badge-lifesteal', 'Lifesteal', 'Lifesteal'));
    if (c.hasEcho > 0) b.push(badge('badge-echo', c.hasEcho > 1 ? `Echo ${c.hasEcho}` : 'Echo', 'Echo'));
    if (c.hasBerserker > 0) b.push(badge('badge-berserker', 'Berserker', 'Berserker'));
    if (c.hasZealot > 0) b.push(badge('badge-zealot', 'Zealot', 'Zealot'));
    if (c.hasThorns > 0) b.push(badge('badge-thorns', c.hasThorns > 1 ? `Thorns ${c.hasThorns}` : 'Thorns', 'Thorns'));
    if (c.hasFear > 0) b.push(badge('badge-fear', `Fear ${c.hasFear}`, 'Fear'));
    if (c.hasFreeze > 0) b.push(badge('badge-freeze', `Freeze ${c.hasFreeze}`, 'Freeze'));
    // MC N — offensive-side mind control etch (mc-1 / mc-2). Reuses
    // the badge-mind-ctrl color so the visual lineage is "this card
    // does mind control on play." The defensive `isMindControlled`
    // badge above is what shows on a card that's BEEN mind-controlled.
    if (c.hasMc > 0) b.push(badge('badge-mind-ctrl', `MC ${c.hasMc}`, 'Mind Control'));
    // Mark — adjacent-ally Bullseye aura on play.
    if (c.hasMark > 0) b.push(badge('badge-mark', 'Mark', 'Mark'));
    if (c.hasSteady > 0) b.push(badge('badge-steady', `Steady ${c.hasSteady}`, 'Steady'));
    if (c._discountTotal > 0) b.push(badge('badge-discount', `Discount ${c._discountTotal}`, 'Discount'));
    // "Crazy" / "Insane" — no KEYWORD_DATA entry yet, so badge() omits
    // data-kw and they stay non-interactive.
    if (c.isInsane) b.push(badge('badge-insane', 'Insane'));
    else if (c.isCrazy) b.push(badge('badge-crazy', 'Crazy'));
    // Poison Ivy charmed ally indicator. Three layers, in order:
    //   1. Direct flag set on the ally (`_charmedByIvy = ivyId`).
    //   2. Legacy `_ivyAlly` object-ref match.
    //   3. Self-healing fallback — if Ivy is actively charming (has an
    //      _ivyCharm temp buff with a delta) but neither the flag nor
    //      the ref points anywhere, attribute the charm to the highest-
    //      ATK ally on Ivy's side whose ATK matches the buff delta.
    //      Catches edge cases where _charm fired with a dead-pile or
    //      summon flow that didn't preserve the reference. User report:
    //      "still no charm how hard is it?" — at least make the badge
    //      visible whenever Ivy IS charming.
    const sideIvys = Game.getAllCardsOnBoard().filter(x =>
      x.name === 'Poison Ivy' && x.owner === c.owner && x.currentHealth > 0
    );
    let charmed = false;
    for (const ivy of sideIvys) {
      // Layer 1 — explicit flag set in _charm
      if (c._charmedByIvy != null && c._charmedByIvy === ivy.id) { charmed = true; break; }
      // Layer 2 — legacy object-ref match
      if (ivy._ivyAlly && ivy._ivyAlly.id === c.id) { charmed = true; break; }
      // Layer 3 — self-heal: if Ivy has an active charm buff and this
      // ally is the highest-ATK match for the buff delta, claim it.
      const buff = (ivy._grantedBuffs || []).find(b => b && b._ivyCharm && (b.delta | 0) > 0);
      if (!buff) continue;
      const allies = Game.getAllCardsOf(ivy.owner).filter(a => a.id !== ivy.id && a.currentHealth > 0 && (a.attack || 0) > 0);
      if (!allies.length) continue;
      // Pick whoever's ATK matches the buff delta (Ivy gained +N → ally has N ATK).
      const matching = allies.filter(a => (a.attack | 0) === (buff.delta | 0));
      const sortedByAtk = (matching.length ? matching : allies).slice().sort((a, b) => (b.attack || 0) - (a.attack || 0));
      if (sortedByAtk[0] && sortedByAtk[0].id === c.id) { charmed = true; break; }
    }
    if (charmed) b.push(badge('badge-charmed', 'Charmed', 'Charm'));
    return b.join('');
  },

  // Strip leading intrinsic trait text from card descriptions — badges already show these
  // Central keyword data: color, inline SVG icon (12px), and a one-line tooltip.
  // Icons are tiny geometric shapes — no heavy filters, render once per card.
  KEYWORD_DATA: {
    'Damage Immunity': { color: '#d35400', svg: '<svg viewBox="0 0 12 12"><path d="M6 1 L11 3 V6 C11 9 6 11 6 11 C6 11 1 9 1 6 V3 Z M4 6 L8 6 M6 4 L6 8" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>', tip: 'Cannot take any damage.' },
    'Mind Control': { color: '#f1c40f', svg: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M6 3 Q4 5 6 6 Q8 7 6 9" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>', tip: 'Force an enemy card to attack its own side.' },
    'Bullseye':    { color: '#e74c3c', svg: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1" fill="none"/><circle cx="6" cy="6" r="2.5" stroke="currentColor" stroke-width="1" fill="none"/><circle cx="6" cy="6" r="0.8" fill="currentColor"/></svg>', tip: 'Damage bypasses Block Meter.' },
    'Overdrive':   { color: '#e67e22', svg: '<svg viewBox="0 0 12 12"><path d="M2 6 L5 3 L5 5 L9 5 L9 3 L12 6 L9 9 L9 7 L5 7 L5 9 Z" fill="currentColor"/></svg>', tip: 'Attacks again after killing an enemy.' },
    'Hunt':        { color: '#ff6b35', svg: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1" fill="none"/><path d="M6 1 V4 M6 8 V11 M1 6 H4 M8 6 H11" stroke="currentColor" stroke-width="1.2"/></svg>', tip: 'Seeks out any enemy played in an uncontested lane.' },
    'Splash':      { color: '#1abc9c', svg: '<svg viewBox="0 0 12 12"><circle cx="3" cy="6" r="1.5" fill="currentColor"/><circle cx="6" cy="6" r="2" fill="currentColor"/><circle cx="9" cy="6" r="1.5" fill="currentColor"/></svg>', tip: 'Damages adjacent enemies as well.' },
    'Armor':       { color: '#cdaa6e', svg: '<svg viewBox="0 0 12 12"><path d="M6 1 L10 3 V6 C10 9 6 11 6 11 C6 11 2 9 2 6 V3 Z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>', tip: 'Reduces incoming damage by N. Zero damage if fully absorbed.' },
    'Evade':       { color: '#2ecc71', svg: '<svg viewBox="0 0 12 12"><path d="M2 8 Q6 2 10 8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/><circle cx="6" cy="5.5" r="1" fill="currentColor"/></svg>', tip: 'Dodges the next N attacks completely.' },
    'Taunt':       { color: '#f39c12', svg: '<svg viewBox="0 0 12 12"><path d="M6 1 L6 7 M6 9 L6 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="6" cy="10" r="0.7" fill="currentColor"/></svg>', tip: 'Enemies must attack this card first.' },
    'Immunity':    { color: '#9b59b6', svg: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M6 3 V9 M3 6 H9" stroke="currentColor" stroke-width="1.2"/></svg>', tip: 'Blocks N debuffs (Freeze, Stun, Fear, etc.)' },
    'Invincible':  { color: '#ecf0f1', svg: '<svg viewBox="0 0 12 12"><path d="M6 1 L7.5 5 L11 5 L8 7.5 L9 11 L6 9 L3 11 L4 7.5 L1 5 L4.5 5 Z" fill="currentColor"/></svg>', tip: 'Cannot die for N turns. Lethal hits are absorbed.' },
    'Unresistible':{ color: '#ff4757', svg: '<svg viewBox="0 0 12 12"><path d="M2 6 L10 6 M7 3 L10 6 L7 9" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>', tip: 'Bypasses Immunity when applying debuffs.' },
    'Untrickable': { color: '#95a5a6', svg: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M3 9 L9 3" stroke="currentColor" stroke-width="1.2"/></svg>', tip: 'Cannot be targeted by Tricks.' },
    'Stun':        { color: '#3498db', svg: '<svg viewBox="0 0 12 12"><path d="M3 2 L6 5 L4 5 L8 10 L6 7 L8 7 Z" fill="currentColor"/></svg>', tip: 'Cannot attack or dodge this turn.' },
    'Freeze':      { color: '#85c1e9', svg: '<svg viewBox="0 0 12 12"><path d="M6 1 V11 M1.5 3.5 L10.5 8.5 M10.5 3.5 L1.5 8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>', tip: 'Cannot attack while frozen.' },
    'Fear':        { color: '#5a5a5a', svg: '<svg viewBox="0 0 12 12"><circle cx="4" cy="5" r="1" fill="currentColor"/><circle cx="8" cy="5" r="1" fill="currentColor"/><path d="M3 9 Q6 7 9 9" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>', tip: 'Attacks itself instead of the enemy.' },
    'Steady':      { color: '#16a085', svg: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="2.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M3 6 H9 M6 3 V9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>', tip: 'Cancels one Crazy reroll per charge — ATK stays at base for that turn.' },
    'Curse':       { color: '#9b3c7f', svg: '<svg viewBox="0 0 12 12"><path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="0.8" fill="none" stroke-dasharray="1.5 1"/></svg>', tip: 'Permanent deck liability — clogs your hand, may trigger a downside when played. Cannot be drafted away. Removable at Rest Sites or specific events.' },
    'Drain':       { color: '#8e44ad', svg: '<svg viewBox="0 0 12 12"><path d="M6 2 L8 6 C8 8 7 9 6 9 C5 9 4 8 4 6 Z" fill="currentColor"/></svg>', tip: 'Steals ATK/HP from an enemy.' },
    'Revive':      { color: '#27ae60', svg: '<svg viewBox="0 0 12 12"><path d="M6 10 V4 M6 4 L3 7 M6 4 L9 7" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 2 H9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>', tip: 'When destroyed, revive N times with modified stats.' },
    'Draw':        { color: '#5dade2', svg: '<svg viewBox="0 0 12 12"><path d="M3 2 V8 M6 2 V9 M9 2 V10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>', tip: 'Draw N extra cards from your deck.' },
    'Charm':       { color: '#bb8fce', svg: '<svg viewBox="0 0 12 12"><path d="M6 10 C2 7 2 4 4 3 C5 2.5 6 3 6 4 C6 3 7 2.5 8 3 C10 4 10 7 6 10 Z" fill="currentColor"/></svg>', tip: 'Charmed cards still attack in their own lane but their swing is "loaned" to the charmer for the round.' },
    'Block Meter': { color: '#f1c40f', svg: '<svg viewBox="0 0 12 12"><rect x="2" y="3" width="8" height="6" stroke="currentColor" stroke-width="1.2" fill="none" rx="1"/><rect x="3" y="4" width="4" height="4" fill="currentColor"/></svg>', tip: 'Each side has a Block Meter. When full, the next incoming damage is fully blocked AND draws a free trick.' },
    'Energy':      { color: '#e67e22', svg: '<svg viewBox="0 0 12 12"><path d="M7 1 L3 7 H6 L5 11 L9 5 H6 Z" fill="currentColor"/></svg>', tip: 'Resource you spend to play cards each round.' },
    'Summon':      { color: '#3498db', svg: '<svg viewBox="0 0 12 12"><circle cx="6" cy="7" r="3" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M6 4 V1 M4 2 L6 1 L8 2" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>', tip: 'Place a new card on the board. Pulled from a separate <b>Summon Deck</b> — a 90-card pool that <b>never runs out</b> (Knull, Mother Box, Bat Signal, Super Soldier Serum, Hela revive). Independent from your normal Draw pile.' },
    'Jump':        { color: '#f39c12', svg: '<svg viewBox="0 0 12 12"><path d="M6 11 V3 M3 6 L6 3 L9 6" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>', tip: 'A trigger that lets you play this card for FREE when its condition fires.' },
    'Destroy':     { color: '#c0392b', svg: '<svg viewBox="0 0 12 12"><path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>', tip: 'Removes a card from the board (skips combat math — instant death).' },
    'Sacrifice':   { color: '#a93226', svg: '<svg viewBox="0 0 12 12"><path d="M6 1 L6 11 M3 4 L9 4 M4 8 L8 8" stroke="currentColor" stroke-width="1.2"/></svg>', tip: 'Destroy one of YOUR own cards as part of an effect.' },
    'Chain':       { color: '#9b59b6', svg: '<svg viewBox="0 0 12 12"><path d="M2 6 H4 M5 6 H7 M8 6 H10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>', tip: 'Hits one target, then hops to an adjacent enemy for a follow-up effect.' },
    'Peek':        { color: '#7f8c8d', svg: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="6" cy="6" r="1.5" fill="currentColor"/></svg>', tip: 'See the top of a deck without drawing.' },
    'Devour':      { color: '#7d3c98', svg: '<svg viewBox="0 0 12 12"><path d="M2 4 L6 8 L10 4 M3 9 L9 9" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>', tip: 'Consume a card permanently (often for stat gain on the eater).' },
    'Absorb':      { color: '#2980b9', svg: '<svg viewBox="0 0 12 12"><path d="M6 2 V10 M3 7 L6 10 L9 7" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>', tip: 'Take incoming damage and convert it to your own gain (Block Meter, healing, etc.).' },
    'Regain':      { color: '#16a085', svg: '<svg viewBox="0 0 12 12"><path d="M3 6 A3 3 0 1 1 6 9 M5 8 L6 9 L7 8" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>', tip: 'Recover a charge or resource you previously spent.' },
    'Convert':     { color: '#1abc9c', svg: '<svg viewBox="0 0 12 12"><path d="M3 4 H9 L7 2 M9 8 H3 L5 10" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>', tip: 'Permanently flip an enemy to your team.' },
    'Space Stone': { color: '#2980b9', svg: '<svg viewBox="0 0 12 12"><path d="M6 1 L11 6 L6 11 L1 6 Z" fill="currentColor"/></svg>', tip: 'Infinity Stone — bounces an enemy back to their hand.' },
    'Time Stone':  { color: '#27ae60', svg: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M6 6 L6 3 M6 6 L8 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>', tip: 'Infinity Stone — counters a hostile trick (returns it to opponent\'s hand, blocked this round).' },
    'Power Stone': { color: '#9b59b6', svg: '<svg viewBox="0 0 12 12"><path d="M6 2 L8 5 L11 5 L8.5 7 L9.5 10 L6 8 L2.5 10 L3.5 7 L1 5 L4 5 Z" fill="currentColor"/></svg>', tip: 'Infinity Stone — gives an ally a big ATK buff.' },
    'Soul Stone':  { color: '#e67e22', svg: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="3.5" fill="currentColor"/><path d="M6 1 V3 M6 9 V11 M1 6 H3 M9 6 H11" stroke="currentColor" stroke-width="1"/></svg>', tip: 'Infinity Stone — drains a card\'s soul (HP/ATK transfer).' },
    'Mind Stone':  { color: '#f1c40f', svg: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M6 3 Q4 5 6 6 Q8 7 6 9" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>', tip: 'Infinity Stone — Mind Control 1 (Unresistible) on an enemy this turn.' },
    'Reality Stone':{ color: '#e74c3c', svg: '<svg viewBox="0 0 12 12"><path d="M3 3 L9 9 M9 3 L3 9 M6 1 V11 M1 6 H11" stroke="currentColor" stroke-width="1" fill="none"/></svg>', tip: 'Infinity Stone — permanently swap an ally\'s ATK/HP with an enemy\'s.' },

    // ===== Roguelite etch-driven keywords =====
    // Earned via the etch system; described here so the tooltip
    // pipeline (formatAbilityBadges + kw-pill) lights up on hover.
    // (Cantrip removed — its effect was identical to Draw N; merged.)
    'Mark':       { color: '#ffce5c', svg: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="6" cy="6" r="1.4" fill="currentColor"/></svg>', tip: 'Mark — adjacent allies gain Bullseye for the turn when this is played.' },
    'Thorns':     { color: '#27ae60', svg: '<svg viewBox="0 0 12 12"><path d="M2 6 L4 4 L4 6 L6 4 L6 6 L8 4 L8 6 L10 4 L10 8 L2 8 Z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>', tip: 'When damaged: deal N damage back to the attacker.' },
    'Lifesteal':  { color: '#e74c3c', svg: '<svg viewBox="0 0 12 12"><path d="M6 11 C2 8 2 5 4 4 C5 3.5 6 4 6 5 C6 4 7 3.5 8 4 C10 5 10 8 6 11 Z" fill="currentColor"/><path d="M5 6 H7 M6 5 V7" stroke="#fff" stroke-width="0.8"/></svg>', tip: 'When this card deals damage: heal your HP by N.' },
    'Berserker':  { color: '#c0392b', svg: '<svg viewBox="0 0 12 12"><path d="M3 3 L9 3 L9 7 L6 11 L3 7 Z M5 5 L7 5 M5 7 L7 7" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>', tip: '+1 ATK while damaged (per stack). The card hits harder when bloodied.' },
    'Zealot':     { color: '#f1c40f', svg: '<svg viewBox="0 0 12 12"><path d="M6 1 L7 5 L11 5 L8 7 L9 11 L6 9 L3 11 L4 7 L1 5 L5 5 Z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>', tip: '+1 ATK while at full HP (per stack). Pristine fury.' },
    'Echo':       { color: '#bb8fce', svg: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="2" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1" fill="none" stroke-opacity="0.55"/></svg>', tip: 'On-play / on-death effects fire twice (per stack).' },
    'Phoenix':    { color: '#e67e22', svg: '<svg viewBox="0 0 12 12"><path d="M6 1 L8 4 L11 4 L9 7 L10 11 L6 9 L2 11 L3 7 L1 4 L4 4 Z" fill="currentColor"/></svg>', tip: 'Once per life: revive at full HP when killed.' },
    'Discount':   { color: '#16a085', svg: '<svg viewBox="0 0 12 12"><path d="M2 10 L10 2 M3 4 a1 1 0 1 1 2 0 a1 1 0 0 1 -2 0 z M7 8 a1 1 0 1 1 2 0 a1 1 0 0 1 -2 0 z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>', tip: 'This card costs N less energy.' },
  },

  formatAbilities(abilities) {
    if (!abilities || !abilities.length) return '';
    const kd = this.KEYWORD_DATA;
    const defaults1 = ['Immunity', 'Unresistible'];
    const kws = Object.keys(kd).sort((b, c) => c.length - b.length);
    return abilities.map(a => {
      let text = a;
      defaults1.forEach(d => { if (text === d) text = d + ' 1'; });
      for (const kw of kws) {
        const re = new RegExp('^(' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(\\s+\\d+)?$');
        const m = text.match(re);
        if (m) {
          const data = kd[kw];
          const num = m[2] ? m[2].trim() : '';
          return `<span class="kw-pill" data-kw="${kw}" style="color:${data.color}"><span class="kw-ico">${data.svg}</span>${m[1]}${num ? ' ' + num : ''}</span>`;
        }
      }
      return text;
    }).join(' ');
  },

  // Text-only trait badges for draft cards — mirrors the in-game `.status-badge`
  // chrome (.badge-* color tokens) so the trait display is visually identical
  // from draft → hand → board. No icons; just the trait name (+ value if any).
  TRAIT_BADGE_CLASSES: {
    'Evade': 'badge-evade',
    'Armor': 'badge-armor',
    'Bullseye': 'badge-bullseye',
    'Overdrive': 'badge-overdrive',
    'Splash': 'badge-splash',
    'Immunity': 'badge-immune',
    'Invincible': 'badge-invincible',
    'Unresistible': 'badge-unresistible',
    'Taunt': 'badge-taunt',
    'Hunt': 'badge-hunt',
    'Revive': 'badge-revive',
    'Damage Immunity': 'badge-dmg-immune',
    'Untrickable': 'badge-untrickable',
    'Mind Control': 'badge-mind-ctrl',
    'Drain': 'badge-debuff',
    'Draw': 'badge-draw',
    'Crazy':  'badge-crazy',
    'Insane': 'badge-insane',
    // Roguelite etch keywords (tooltips wired via KEYWORD_DATA)
    'Thorns':     'badge-thorns',
    'Lifesteal':  'badge-lifesteal',
    'Berserker':  'badge-berserker',
    'Zealot':     'badge-zealot',
    'Echo':       'badge-echo',
    'Phoenix':    'badge-phoenix',
    'Fear':       'badge-fear',
    'Freeze':     'badge-freeze',
    'Steady':     'badge-steady',
    'Curse':      'badge-curse',
    'Discount':   'badge-discount'
  },
  formatAbilityBadges(abilities) {
    if (!abilities || !abilities.length) return '';
    const cls = this.TRAIT_BADGE_CLASSES;
    const defaults1 = ['Immunity', 'Unresistible'];
    const kws = Object.keys(cls).sort((b, c) => c.length - b.length);
    // Display-label override map. Keyword used for tooltip + class
    // lookup stays the same; only the visible text in the badge gets
    // overridden. User feedback: "IMMUNITY 1" misreads as damage
    // immunity, but the keyword actually only blocks status debuffs.
    // Renamed display to "Status Immunity N" so it's unambiguous.
    const LABEL_OVERRIDE = { 'Immunity': 'Status Immunity' };
    return abilities.map(a => {
      let text = a;
      defaults1.forEach(d => { if (text === d) text = d + ' 1'; });
      for (const kw of kws) {
        const re = new RegExp('^(' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(\\s+\\d+)?$');
        const m = text.match(re);
        if (m) {
          const num = m[2] ? m[2].trim() : '';
          // Only attach data-kw if KEYWORD_DATA actually has an entry
          // for this kw (Crazy / Insane don't, so they remain plain).
          const hasTip = !!this.KEYWORD_DATA[kw];
          const dataAttr = hasTip ? ` data-kw="${kw}"` : '';
          // Swap visible text via LABEL_OVERRIDE so the badge reads
          // "Status Immunity 1" while the data-kw stays "Immunity".
          const visibleText = LABEL_OVERRIDE[m[1]] || m[1];
          return `<span class="status-badge ${cls[kw]}"${dataAttr}>${visibleText}${num ? ' ' + num : ''}</span>`;
        }
      }
      return `<span class="status-badge">${text}</span>`;
    }).join('');
  },

  // Trick rarity pips — mirrors the card rarity-strip pattern, but with its own
  // palette (purple / silver / gold) and rotated pips (diamonds, not squares).
  //   cost ≤ 2 → 1 purple pip
  //   cost 3   → 2 purple pips
  //   cost 4   → 3 silver pips
  //   cost ≥ 5 → 4 gold pips
  getTrickRarityStrip(cost) {
    const pips = cost <= 2 ? 1 : cost === 3 ? 2 : cost === 4 ? 3 : 4;
    const tier = cost <= 3 ? 'purple' : cost === 4 ? 'silver' : 'gold';
    return `<span class="rarity-strip trick-rarity trick-rarity-${tier}">${'<span class="rpip"></span>'.repeat(pips)}</span>`;
  },

  stripTraitDesc(desc) {
    if (!desc) return '';
    return desc.replace(/^(?:(?:Bullseye|Hunt|Overdrive|Splash \d+|Armor \d+|Evade \d+|Revive \d+|Taunt(?: \d+)?|Immunity(?: \d+)?|Invincible \d+|Damage Immunity|Unresistible(?: \d+)?|Untrickable)(?:,\s*)?)+\.?\s*/, '').trim();
  },

  // Format card description: bold triggers, color traits/debuffs/mechanics.
  // Keyword coloring is class-based (<span class="kw kw-evade">) — classes
  // resolve to colors via :root CSS vars so badge pills under card names and
  // in-description keywords share one palette. Rebrand a keyword by editing
  // :root in style.css, not this file.
  formatDesc(desc) {
    let t = this.stripTraitDesc(desc);
    if (!t) return '';
    // Pull the "Can be played during the Trick Phase" passive out of the
    // body copy — we'll append it as a styled footer at the bottom of the
    // desc so it reads as its own passive line. ANCHORED to start of the
    // desc so it only matches the standalone self-passive on cards like
    // Iron Man / Thanos ("Can be played during the Trick Phase. When
    // Played: ..."). Red Skull's "Your cards can be played during the
    // Trick Phase" is an aura affecting OTHER cards and appears mid-desc
    // after "While Active:" — left alone.
    let trickPhaseFooter = '';
    const tpRe = /^Can be played during the Trick Phase\.?\s*/i;
    if (tpRe.test(t)) {
      t = t.replace(tpRe, '').trim();
      trickPhaseFooter = `<div class="card-trick-passive">Can be played during the Trick Phase</div>`;
    }
    // Per-card phrase cuts — user direction: "trying to reduce the
    // words so the cards fit better." Display-only edits; card data
    // (cards.js / roguelite.js descOverrides) stays unchanged so the
    // engine's ability-trigger lookups and roguelite text+ swaps
    // continue to match the long-form strings.
    //   • Ghostface — drop ", Ghostface glows — play for free" from
    //     the Jump trigger sentence (Jump kw + tooltip already cover
    //     the "free play" mechanic).
    //   • Gorilla Grodd — drop the "You choose..." sentence (Mind
    //     Control kw tooltip already covers the choice mechanic).
    //   • Grinch — drop the "If opponent has no tricks, stats triple"
    //     clause (engine handles the edge case silently).
    //   • Scarlet Witch — drop the "(Her stat orbs read ? until she
    //     lands.)" parenthetical (visible in-game on the orbs).
    //   • Jigsaw — drop the "— the first enemy to enter takes (−1/−1)"
    //     mechanical detail (Bear Trap kw tooltip carries it).
    t = t.replace(/,\s*Ghostface glows\s*[—-]\s*play for free\.?/gi, '.');
    t = t.replace(/\.\s*You choose which of its own allies it attacks this turn\.?/gi, '.');
    t = t.replace(/\.\s*If opponent has no tricks,\s*stats triple\.?/gi, '.');
    t = t.replace(/\s*\(Her stat orbs read [^)]*?\)\.?/gi, '');
    t = t.replace(/\s*[—-]\s*the first enemy to enter takes \([^)]*\)/gi, '');
    // Generic redundant phrase — "in any lane" / "in any open lanes"
    // / "in any empty lane(s)" after a Summon is always implied (the
    // lane prompt always picks a lane). Strip it everywhere it shows
    // up so descriptions read as bare "Summon a (1/1) Ant with
    // Bullseye." instead of "...in any lane."
    t = t.replace(/\s+in any(?:\s+open|\s+empty)?\s+lanes?\b/gi, '');
    // Compact trigger labels. Order matters: the "(once)" variant of
    // Start of Tricks must match BEFORE the bare Start of Tricks,
    // otherwise the shorter pattern eats the prefix and leaves an
    // orphan "(once)" behind.
    t = t.replace(/\bStart of Tricks \(once\)/gi, '1st Trick Phase');
    t = t.replace(/\bStart of Tricks\b/gi,        'Trick Phase');
    t = t.replace(/\bWhen Played\b/gi,            'On Play');
    t = t.replace(/\bWhile Active\b/gi,           'Passive');
    // Bold any label before a colon. Leading char accepts digits too
    // (the trigger pass above can emit "1st Trick Phase:"); without
    // it that whole label would render plain because the regex
    // previously required [A-Z] at position 1.
    t = t.replace(/([1-9A-Z][^:.]*?):/g, '<b style="color:#fff">$1:</b>');
    // Color stat patterns like (+1/+2), (−1/−1), or (1/1) — class-based so the
    // number gets the same neon glow as the attack/health orbs on the card
    // chrome. The sign class accepts BOTH ASCII hyphen `-` and Unicode minus
    // `−` (U+2212) because several card descs use the typographic minus.
    // Colors resolve through :root vars; text-shadow mimics the orb box-shadow.
    t = t.replace(/\(([+\-−]?\d+)\/([+\-−]?\d+)\)/g,
      '(<span class="stat-num stat-num-atk">$1</span>/<span class="stat-num stat-num-hp">$2</span>)');
    // Color bare stat patterns like +1/+1 or 2/3 (not inside parens)
    t = t.replace(/(?<![(\w>])([+\-−]?\d+)\/([+\-−]?\d+)(?![\w)])/g,
      '<span class="stat-num stat-num-atk">$1</span>/<span class="stat-num stat-num-hp">$2</span>');
    // Keyword → CSS class suffix. Ordered longest-first so multi-word phrases
    // (e.g. "Mind Stone", "Damage Immunity") match before single-word forms
    // would eat their prefix.
    const kwMap = [
      // Infinity Stones (thematic Marvel color per stone; must precede "Mind Control" etc.)
      ['Space Stone',                  'stone-space'],
      ['Time Stone',                   'stone-time'],
      ['Power Stone',                  'stone-power'],
      ['Soul Stone',                   'stone-soul'],
      ['Mind Stone',                   'stone-mind'],
      ['Reality Stone',                'stone-reality'],
      // Multi-word traits
      ['Damage Immunity',              'dmg-immune'],
      ['Mind Control(?:led|s)?',       'mind-ctrl'],
      ['Block Meter',                  'block'],
      // Traits (single-word with optional plural/tense variants)
      ['Stun(?:s|ned|ning)?',          'stun'],
      ['Freeze(?:s|n)?|Frozen',        'freeze'],
      ['Fear(?:ed)?',                  'fear'],
      ['Drain(?:s|ed|ing)?',           'drain'],
      ['Revive(?:s|d)?',               'revive'],
      ['Armor',                        'armor'],
      ['Evade',                        'evade'],
      ['Bullseye',                     'bullseye'],
      ['Overdrive',                    'overdrive'],
      ['Splash',                       'splash'],
      ['Taunt',                        'taunt'],
      ['Hunt',                         'hunt'],
      ['Immunit(?:y|ies)|Immune',      'immune'],
      ['Invincib(?:le|ility)',         'invincible'],
      ['Unresistible',                 'unresistible'],
      ['Untrickable',                  'untrickable'],
      ['Charm(?:s|ed|ing)?',           'charm'],
      ['Energy',                       'energy'],
      // Mechanic verbs (newly covered)
      ['Summon(?:s|ed|ing)?',          'summon'],
      ['Jump',                         'jump'],
      ['Destroy(?:s|ed|ing)?',         'destroy'],
      ['Sacrifice(?:s|d|ing)?',        'sacrifice'],
      ['Draw(?:s|n|ing)?',             'draw'],
      ['Chain(?:s|ed|ing)?',           'chain'],
      ['Peek(?:s|ed|ing)?',            'peek'],
      ['Devour(?:s|ed|ing)?',          'devour'],
      ['Absorb(?:s|ed|ing)?',          'absorb'],
      ['Regain(?:s|ed|ing)?',          'regain'],
      ['Convert(?:s|ed|ing)?',         'convert'],
    ];
    // Map suffix → canonical keyword name for KEYWORD_DATA lookup. The
    // body-text spans get `data-kw="<canonical>"` so the same hover /
    // click-to-pin tooltip system the badge-pills use also fires here.
    // User spec: "you can hover over the highlighted word and the card
    // will pop up... so if someone is confused they can click on the
    // highlighted word in the text and give them a description."
    const kwLookup = {
      'stone-space':'Space Stone', 'stone-time':'Time Stone',
      'stone-power':'Power Stone', 'stone-soul':'Soul Stone',
      'stone-mind':'Mind Stone',   'stone-reality':'Reality Stone',
      'dmg-immune':'Damage Immunity', 'mind-ctrl':'Mind Control',
      'block':'Block Meter', 'stun':'Stun', 'freeze':'Freeze',
      'fear':'Fear', 'drain':'Drain', 'revive':'Revive',
      'armor':'Armor', 'evade':'Evade', 'bullseye':'Bullseye',
      'overdrive':'Overdrive', 'splash':'Splash', 'taunt':'Taunt',
      'hunt':'Hunt', 'immune':'Immunity', 'invincible':'Invincible',
      'unresistible':'Unresistible', 'untrickable':'Untrickable',
      'charm':'Charm', 'energy':'Energy', 'summon':'Summon',
      'jump':'Jump', 'destroy':'Destroy', 'sacrifice':'Sacrifice',
      'draw':'Draw', 'chain':'Chain', 'peek':'Peek',
      'devour':'Devour', 'absorb':'Absorb', 'regain':'Regain',
      'convert':'Convert',
    };
    kwMap.forEach(([pattern, suffix]) => {
      // \b + optional trailing scalar (for traits like "Splash 1", "Armor 2").
      // Variable-length lookbehind skips matches already inside a span tag.
      const re = new RegExp('(?<!<[^>]*)\\b(' + pattern + ')(\\s+\\d+)?\\b', 'g');
      const kwName = kwLookup[suffix] || '';
      const dataAttr = kwName ? ` data-kw="${kwName}"` : '';
      t = t.replace(re, (_m, word, num) =>
        `<span class="kw kw-${suffix}"${dataAttr}>${word}${num || ''}</span>`);
    });
    // CARD-POP keywords — references to specific trick/card names that
    // should pop up the actual referenced card on hover. Pattern is
    // optional plural so "Batarang" and "Batarangs" both match.
    // data-kw="card:<Name>" tells the tooltip renderer to look up the
    // card/trick definition and render its full chrome instead of the
    // generic kw-tip body.
    const cardKeywords = [
      ['Batarangs?', 'Batarangs'],
    ];
    cardKeywords.forEach(([pattern, canonical]) => {
      const re = new RegExp('(?<!<[^>]*)\\b(' + pattern + ')\\b', 'g');
      t = t.replace(re, (_m, word) =>
        `<span class="kw kw-card-ref" data-kw="card:${canonical}">${word}</span>`);
    });
    // Strip the trailing period at the very end of the description. Mid-
    // sentence periods between clauses stay because they aid scanning;
    // a final period after the last word adds noise once the desc is
    // visually framed by the card border. Tolerates trailing whitespace
    // and any closing inline tags from the keyword-wrap pass above.
    t = t.replace(/\.\s*(<\/[^>]+>\s*)*$/i, '$1').trimEnd();
    return t + trickPhaseFooter;
  },


  // ===================== HANDS =====================

  renderPlayerHand(s) {
    // Smart wipe — keep hand-card wrappers + their .card children
    // continuously attached to playerHand so CSS animations
    // (vibe-*, tron-perimeter-card) don't restart and active hover
    // state doesn't reset on every render. User report May-1 (after
    // the board fix shipped at commit 53ad0f4): "the hover hand is
    // still not fixed. Cards in hand essentially disappear then
    // reappear during AI turn." Same detach-reattach pattern from
    // the board, different container.
    //
    // Hand cards have their OWN cache map (separate from
    // _capturedBoardCardEls) to avoid cross-contamination. The
    // board's makeCardElCached should NEVER reach for a hand-card
    // DOM node because it's not in the same DOM subtree and would
    // produce visual collisions like the Peacemaker clip-off bug
    // (caught at commit 6924a86's revert).
    if (!this._handWrappers) this._handWrappers = new Map(); // id → wrapper

    // BWL intercept warning — toggle in-place rather than wipe + recreate.
    let warn = this.playerHand.querySelector(':scope > .bwl-intercept-warning');
    if (s.player.nextCardStolen) {
      if (!warn) {
        warn = document.createElement('div');
        warn.className = 'bwl-intercept-warning';
        warn.innerHTML = `<span class="bwl-icon">⚠</span> Next card will be intercepted by <strong>The Batman Who Laughs</strong>`;
        this.playerHand.insertBefore(warn, this.playerHand.firstChild);
      }
    } else if (warn) {
      warn.remove();
    }
    // Empty-hand placeholder — recreated below if hand truly empty.
    const oldEmpty = this.playerHand.querySelector(':scope > .empty-hand');
    if (oldEmpty) oldEmpty.remove();
    const canPlay = this.canPlayerPlayCards(s);
    const cc = s.pendingCardChoice;
    const lc = s.pendingLaneChoice;
    const hasPending = cc || lc;
    const targetHandIds = new Set();
    if (cc) cc.cards.forEach(c => { if (c.id !== undefined) targetHandIds.add(c.id); });
    // Track which hand card ids are newly-drawn since the last render — those
    // get the draw-in fly animation.
    this._lastHandIds = this._lastHandIds || new Set();
    const currentIds = new Set(s.player.hand.map(c => c.id));
    const newIds = new Set();
    s.player.hand.forEach(c => { if (!this._lastHandIds.has(c.id)) newIds.add(c.id); });

    // Display copy sorted low→high cost (stable by name on ties). Underlying
    // s.player.hand array is unchanged so game logic / abilities see unsorted order.
    const handDisplay = s.player.hand.slice().sort((a, b) => {
      const ca = Game.getCardCost ? Game.getCardCost('player', a) : (a.cost || 0);
      const cb = Game.getCardCost ? Game.getCardCost('player', b) : (b.cost || 0);
      if (ca !== cb) return ca - cb;
      return (a.name || '').localeCompare(b.name || '');
    });

    const handCount = handDisplay.length;
    // Track which wrapper ids we used this render — anything in
    // cache but not used got played/discarded and gets removed below.
    const usedIds = new Set();
    handDisplay.forEach((card, idx) => {
      const cardId = String(card.id);
      usedIds.add(cardId);
      // Reuse cached wrapper if we have one — keeps it continuously
      // attached so the .card child's CSS animations + :hover state
      // survive the render.
      let wrap = this._handWrappers.get(cardId);
      const wrapIsNew = !wrap;
      if (!wrap) {
        wrap = document.createElement('div');
        this._handWrappers.set(cardId, wrap);
      }
      // Idempotent class assignment — avoids the className-mutation
      // style recalc that restarts CSS animations even when the
      // resulting class set is identical.
      //
      // Boot-sequence guard: when the trick-draft → first-fight
      // boot is playing, the hand-card-wrapper's bootCardEnter
      // animation IS the entrance. Adding `hand-deal-in` /
      // `card-draw-in` on top stacks two competing animations on
      // the same element — the dealt-in flicker is the visible
      // result. User report: "the cards should just be there.
      // There's no reason for that hand draw animation to take
      // place on round one."
      const inBoot = document.body.classList.contains('boot-sequence');
      const wantsDealIn = !inBoot && !!this._pendingHandDealAnim;
      const wantsDrawIn = !inBoot && newIds.has(card.id);
      const desiredCls = 'hand-card-wrapper'
        + (wantsDealIn ? ' hand-deal-in' : '')
        + (wantsDrawIn ? ' card-draw-in' : '');
      if (wrap.className !== desiredCls) wrap.className = desiredCls;
      const idxStr = String(idx);
      if (wrap.style.getPropertyValue('--idx') !== idxStr) {
        wrap.style.setProperty('--idx', idxStr);
      }
      // No fan tilt — cards sit flat in a straight row.

      // Hand-card snapshot cache (Tier B perf). Mirrors the board's
      // makeCardElCached pattern — if the card's visual state hasn't
      // changed since last render, reuse the existing .card element
      // wholesale without rebuilding via makeCardEl. Hand cards are
      // 6+ per render and were rebuilding every frame even when no
      // stat changed, which dominated the 3ms avg render budget.
      // Now: unchanged hand cards cost ~0 per render; changed ones
      // pay the same makeCardEl + transplant cost as before.
      const existing = wrap.querySelector(':scope > .card');
      const snap = this._cardVisualSnapshot(card);
      let el;
      if (existing && existing.dataset.snap === snap) {
        // Snapshot match — reuse the existing element. Strip the
        // transient state classes the affordability decoration
        // code below will re-apply this render. Without this strip
        // they STACK across renders (afford+unafford+playable+
        // unplayable simultaneously), which made dim/lit hand
        // cards inconsistent. User report: "why are only some
        // cards lit up while others are not even though i have
        // enough energy."
        this._DECORATION_CLASSES.forEach(c => existing.classList.remove(c));
        existing.classList.remove(
          'afford', 'unafford', 'playable', 'unplayable',
          'card-draw-in', 'card-enter', 'card-exit',
          'hit-flash', 'armor-burst', 'stat-changed', 'cant-afford'
        );
        existing.style.cursor = '';
        el = existing;
      } else {
        // Build fresh and transplant into the existing wrapper child
        // (or use fresh directly if no existing). Same pattern as
        // before this cache was added.
        const fresh = this.makeCardEl(card, true);
        if (existing) {
          existing.replaceChildren(...fresh.childNodes);
          const oldClasses = existing.className ? existing.className.trim().split(/\s+/) : [];
          const newClasses = fresh.className ? fresh.className.trim().split(/\s+/) : [];
          const oldSet = new Set(oldClasses);
          const newSet = new Set(newClasses);
          for (const c of oldClasses) if (!newSet.has(c)) existing.classList.remove(c);
          for (const c of newClasses) if (!oldSet.has(c)) existing.classList.add(c);
          Object.keys(fresh.dataset).forEach(k => { existing.dataset[k] = fresh.dataset[k]; });
          Object.keys(existing.dataset).forEach(k => {
            if (!(k in fresh.dataset)) delete existing.dataset[k];
          });
          const oldStyleProps = [];
          for (let i = 0; i < existing.style.length; i++) oldStyleProps.push(existing.style[i]);
          oldStyleProps.forEach(p => existing.style.removeProperty(p));
          if (fresh.style.length > 0) {
            for (let i = 0; i < fresh.style.length; i++) {
              const prop = fresh.style[i];
              existing.style.setProperty(prop, fresh.style.getPropertyValue(prop));
            }
          }
          el = existing;
        } else {
          el = fresh;
        }
        // Stamp the snapshot so the next render can short-circuit.
        // makeCardEl already sets dataset.snap on the fresh element;
        // when we transplant into existing we explicitly rewrite it.
        el.dataset.snap = snap;
      }
      // Reset the click handler. We use el.onclick = ... rather than
      // addEventListener so this assignment REPLACES any prior handler
      // (addEventListener stacks, which would compound a play action
      // across renders). The downstream code below uses
      // el.addEventListener — we override with onclick on the same
      // element so both reach the same target. New el.onclick = null
      // upfront here so click handlers from previous renders don't
      // fire after the card's affordability state changed.
      el.onclick = null;

      if (cc && targetHandIds.has(card.id)) {
        el.classList.add('target-highlight');
        const idx = cc.cards.findIndex(c => c.id === card.id);
        // Use onclick property assignment instead of addEventListener
        // so reused .card elements don't accumulate stacked listeners
        // across renders (each render would otherwise add a fresh
        // click handler on top of the previous ones).
        el.onclick = () => cardChoicePick(idx);
      } else if (!hasPending) {
        const cost = Game.getCardCost('player', card);
        const afford = s.player.currency >= cost;
        const hasOpen = Game.getOpenLanes('player').length > 0 || card.isDiscardEffect;
        const batBlocked = Game.isCardBatmanBlocked('player', card) && !card.isDiscardEffect;
        // Per-card phase check — fixes the trick-phase bug where ALL
        // hand cards looked playable when only a single trickPhasePlayable
        // card (e.g. Thanos) was in hand. Visual must mirror onCardClick.
        const phaseAllowsThisCard = this.canPlayThisCardNow(s, card);

        // Always-on affordability indicator — shows whether the card can be
        // cast right now regardless of whether we're in a playable phase.
        if (afford && hasOpen && !batBlocked) el.classList.add('afford');
        else el.classList.add('unafford');

        if (batBlocked) {
          el.classList.add('unplayable');
          el.title = 'Blocked by Batman — card is locked this turn.';
        } else if (card.jumpReady && hasOpen) {
          el.classList.add('jump-ready');
          el.onclick = () => Game.playJumpCard('player', card);
        } else if (phaseAllowsThisCard && afford && hasOpen) {
          el.classList.add('playable');
          if (s.selectedCard === card) {
            el.classList.add('selected', 'is-selected');
          } else if (s.selectedCard) {
            // Another card is selected — dim this one so the eye
            // is drawn to the one in play. Game-feel rule: focus
            // the user's attention on the active object.
            el.classList.add('dimmed-by-selection');
          }
          el.onclick = () => this.onCardClick(card);
        } else {
          el.classList.add('unplayable');
          // Explain why it's unplayable on hover
          let reason;
          if (!phaseAllowsThisCard) {
            // Be specific so the player understands why an affordable
            // card is greyed out during the trick phase.
            if (s.phase === 'player-tricks') {
              reason = card.trickPhasePlayable
                ? "Card not yet eligible this trick phase."
                : "Trick phase — only Tricks (and trick-phase cards) can be played.";
            } else if (s.phase && s.phase.startsWith('ai-')) {
              reason = "Wait for your turn.";
            } else {
              reason = "Not your turn to play cards.";
            }
          }
          else if (!afford) reason = `Not enough energy — needs ${cost}, you have ${s.player.currency}.`;
          else if (!hasOpen) reason = 'No open lane available.';
          if (reason) el.title = reason;
        }
      } else {
        el.classList.add('unplayable');
      }
      // Anti-reattach guards: only call appendChild if the child
      // isn't already in the right parent. Re-appending an
      // already-attached child triggers detach-reattach which
      // resets CSS animation timing.
      if (el.parentNode !== wrap) wrap.appendChild(el);
      if (wrap.parentNode !== this.playerHand) this.playerHand.appendChild(wrap);
    });

    // Sweep wrappers for cards no longer in hand (played, discarded).
    for (const [id, wrap] of this._handWrappers) {
      if (!usedIds.has(id)) {
        if (wrap.parentNode) wrap.remove();
        this._handWrappers.delete(id);
      }
    }

    // Reorder children to match handDisplay sort order. Only do
    // explicit reorder when the current sequence doesn't match the
    // desired one — minimizes appendChild calls (which detach +
    // reattach and reset animations).
    const desiredOrder = handDisplay.map(c => this._handWrappers.get(String(c.id)));
    const currentChildren = Array.from(this.playerHand.children).filter(
      c => c.classList && c.classList.contains('hand-card-wrapper')
    );
    const orderMatches = desiredOrder.length === currentChildren.length &&
      desiredOrder.every((w, i) => w === currentChildren[i]);
    if (!orderMatches) {
      // Sort in place via appendChild (which moves an attached child
      // to the end). Each move detaches + reattaches that wrapper,
      // which resets its child .card's animation. Acceptable cost
      // because reorder happens only when sort actually changed
      // (cost change, draws, plays) — not on every render.
      desiredOrder.forEach(w => { if (w) this.playerHand.appendChild(w); });
    }

    if (!s.player.hand.length) {
      // Empty-hand placeholder. Wipe wrappers cache so an empty hand
      // doesn't accumulate stale refs across draws.
      this._handWrappers.clear();
      const empty = document.createElement('div');
      empty.className = 'empty-hand';
      empty.textContent = 'No cards';
      // Remove any existing wrappers (defensive — usedIds was empty,
      // so the sweep above already cleared them).
      Array.from(this.playerHand.children).forEach(c => {
        if (c.classList && c.classList.contains('hand-card-wrapper')) c.remove();
      });
      this.playerHand.appendChild(empty);
    }
    // Record current ids for next render's newly-drawn detection
    this._lastHandIds = currentIds;

    // Regression guardrail. Catches the class-stacking bug where a
    // hand card ends up with both `afford` and `unafford` (or
    // `playable` and `unplayable`) applied because the cache-hit
    // path reused the element without stripping prior state classes
    // before the affordability code re-added new ones. The fix lives
    // above (~line 10227); this is the watchman so a future change
    // can't silently re-introduce the bug.
    //
    // Gated on PerfOverlay (?perf=1) or debug mode — production
    // gameplay pays nothing. console.warn lists the offending card
    // ids + which class pairs collided so the bug is self-diagnosing.
    if ((typeof PerfOverlay !== 'undefined' && PerfOverlay.isEnabled) ||
        (typeof localStorage !== 'undefined' && localStorage.getItem('debugMode') === '1')) {
      const wrappers = this.playerHand
        ? this.playerHand.querySelectorAll(':scope > .hand-card-wrapper > .card')
        : [];
      const offenders = [];
      wrappers.forEach(c => {
        const cl = c.classList;
        const afford = cl.contains('afford') && cl.contains('unafford');
        const playable = cl.contains('playable') && cl.contains('unplayable');
        if (afford || playable) {
          offenders.push({
            id: c.dataset.cardId,
            classes: c.className,
            badPairs: [afford && 'afford+unafford', playable && 'playable+unplayable'].filter(Boolean),
          });
        }
      });
      if (offenders.length) {
        console.warn('[hand-class-stacking] contradictory class pairs on hand cards — class strip on cache hit may have regressed:', offenders);
      }
    }
  },

  renderAIHand(s) {
    this.aiHand.innerHTML = '';
    // BWL intercept warning lives on the ai-bar itself (not inside the narrow hand cell)
    const aiBar = document.querySelector('.info-bar.ai-bar');
    if (aiBar) {
      let warn = aiBar.querySelector('.bwl-intercept-warning');
      if (s.ai.nextCardStolen) {
        if (!warn) {
          warn = document.createElement('div');
          warn.className = 'bwl-intercept-warning bwl-intercept-ai';
          aiBar.appendChild(warn);
        }
        warn.innerHTML = `<span class="bwl-icon">⚠</span> AI's next card will be intercepted by <strong>The Batman Who Laughs</strong>`;
      } else if (warn) {
        warn.remove();
      }
    }
    // Opponent hand — mini card-backs with the diamond SVG pattern, matching
    // the in-game face-down card aesthetic.
    const cardBackSVG = `<svg viewBox="0 0 20 30" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <pattern id="cb-mini" x="0" y="0" width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M4 0 L8 4 L4 8 L0 4 Z" fill="none" stroke="currentColor" stroke-width="0.5" stroke-opacity="0.6"/>
        </pattern>
      </defs>
      <rect width="20" height="30" fill="url(#cb-mini)"/>
    </svg>`;
    for (let i = 0; i < s.ai.hand.length; i++) {
      const el = document.createElement('div');
      el.className = 'card-back';
      el.innerHTML = cardBackSVG;
      this.aiHand.appendChild(el);
    }
    for (let i = 0; i < s.ai.trickHand.length; i++) {
      const el = document.createElement('div');
      el.className = 'card-back trick-back';
      el.innerHTML = cardBackSVG;
      this.aiHand.appendChild(el);
    }
  },

  renderPlayerTricks(s) {
    this.playerTricks.innerHTML = '';
    const canTrick = this.canPlayerPlayTricks(s);
    const playerActive = s.phase && s.phase.startsWith('player-') && !s.gameOver;
    // Clear stale selection if the trick is no longer in hand
    if (s.selectedTrick && !s.player.trickHand.includes(s.selectedTrick)) s.selectedTrick = null;

    s.player.trickHand.forEach(trick => {
      const el = document.createElement('div');
      el.className = 'trick-card';
      if (trick.name) el.setAttribute('data-trick-name', trick.name);
      const cost = Game.getTrickCost('player', trick);
      const afford = s.player.currency >= cost;

      const trickBadges = trick.abilities && trick.abilities.length
        ? `<div class="card-abilities status-badges">${this.formatAbilityBadges(trick.abilities)}</div>`
        : '';
      const rarityStrip = this.getTrickRarityStrip(trick.cost || 0);
      el.innerHTML = `
        <span class="trick-cost">${cost}</span>
        ${rarityStrip}
        <div class="trick-name">${trick.name}</div>
        ${trickBadges}
        <div class="trick-desc">${this.formatDesc(trick.desc)}</div>
      `;

      const isAnytime = !!trick.anytime;
      if (((isAnytime && playerActive) || canTrick) && afford) {
        el.classList.add('playable');
        if (s.selectedTrick === trick) el.classList.add('selected');
        el.addEventListener('click', () => this.onTrickClick(trick));
      } else {
        el.classList.add('unplayable');
      }
      this.playerTricks.appendChild(el);
    });

    if (!s.player.trickHand.length) this.playerTricks.innerHTML = '<div class="empty-hand">No tricks</div>';
  },

  // ===================== BUTTONS =====================

  renderButtons(s) {
    const btnA = document.getElementById('btn-action');
    const btnNew = document.getElementById('btn-new-game');
    const btnU = document.getElementById('btn-undo');

    btnNew.style.display = s.gameOver ? 'inline-block' : 'none';
    btnA.style.display = 'none';
    if (btnU) btnU.style.display = 'none';

    if (s.gameOver) {
      this.showGameOverScreen(s.winner);
      return;
    }

    const abilityPending = s.pendingCardChoice || s.pendingLaneChoice || s.pendingBlockTrick || s.pendingKangChoice || s.player.stolenByBWL;

    if (btnU && Game.isPlayerTurn() && Game.history.length > 0 && !abilityPending) {
      btnU.textContent = `Undo (${Game.history.length})`;
      btnU.className = 'btn btn-secondary';
      btnU.onclick = () => Game.undo();
      btnU.style.display = 'inline-block';
      btnU.disabled = false;
      btnU.style.opacity = '';
    }

    // Button text deliberately short ("Done") so the label fits entirely
    // inside the banner's 1fr center cell between the block circle and the
    // energy orb. Full phase name ("Cards", "Cards & Tricks", "Tricks") is
    // already shown by the HUD pill at the top of the screen — the button's
    // only job is to advance the turn. Longer labels caused the button to
    // grow past the center cell and overlap the energy orb on narrower bars.
    if (s.phase === 'player-cards') {
      btnA.textContent = 'Done';
      btnA.className = 'btn btn-primary';
      btnA.onclick = abilityPending ? null : () => Game.endPhase1();
      btnA.style.display = 'inline-block';
      btnA.disabled = !!abilityPending;
      btnA.style.opacity = abilityPending ? '0.4' : '';
    } else if (s.phase === 'player-cards-tricks') {
      btnA.textContent = 'Done';
      btnA.className = 'btn btn-primary';
      btnA.onclick = abilityPending ? null : () => Game.endPhase2();
      btnA.style.display = 'inline-block';
      btnA.disabled = !!abilityPending;
      btnA.style.opacity = abilityPending ? '0.4' : '';
    } else if (s.phase === 'player-tricks') {
      btnA.textContent = 'Done';
      btnA.className = 'btn btn-secondary';
      btnA.onclick = abilityPending ? null : () => Game.endPhase3();
      btnA.style.display = 'inline-block';
      btnA.disabled = !!abilityPending;
      btnA.style.opacity = abilityPending ? '0.4' : '';
    }
    // Render the pre-combat lane-forecast strip whenever it's a player
    // phase with upcoming combat. The strip glances at every lane's
    // predicted outcome (WIN / TRADE / STALL / LOSE / —) so the player
    // can spot lanes worth tricking before locking in. Driven by the
    // pure simulator predictLaneOutcome — same math the damage preview
    // uses, no engine side effects.
    this.renderLaneForecastStrip(s);
  },

  // ===================== LANE FORECAST =====================
  // Predict the player-side outcome for a single lane and return a
  // verdict tag + class for both the strip cell and the data-attr on
  // the lane element. Reused by renderLaneForecastStrip (strip cells)
  // and renderBoard (lane data-forecast attribute → CSS hover badge).
  laneForecastVerdict(s, laneIdx) {
    const lane = s && s.lanes && s.lanes[laneIdx];
    if (!lane || lane.destroyed) return { label: '—', cls: 'lf-destroyed' };
    if (!lane.player && !lane.ai) return { label: '—', cls: 'lf-empty' };
    // Use the GLOBAL predictor (already cached on UI._combatPredCache
    // at the start of every render). Cross-lane Taunt redirection,
    // splash from adjacent lanes, and chained kills are all baked in
    // here — predictLaneOutcome only sees one lane at a time and
    // missed taunt-soaking from other lanes. User report: "It will
    // still say TRADE in lane three if lane one is taunting."
    const global = (this._combatPredCache && this._combatPredCache.byId)
      ? this._combatPredCache
      : (typeof Game.predictCombatGlobal === 'function' ? Game.predictCombatGlobal() : null);
    const pPred = (lane.player && global && global.byId) ? global.byId.get(lane.player.id) : null;
    const aPred = (lane.ai     && global && global.byId) ? global.byId.get(lane.ai.id)     : null;
    const pDies = !!(pPred && pPred.dies);
    const aDies = !!(aPred && aPred.dies);
    if (lane.player && !lane.ai) {
      // Uncontested — player hits face. "STRIKE" verdict (or LOSE if
      // an adjacent splasher would kill the entering card).
      return pDies
        ? { label: 'LOSE', cls: 'lf-lose' }
        : { label: 'STRIKE', cls: 'lf-win' };
    }
    if (lane.ai && !lane.player) {
      // Uncontested — enemy hits face. Always EXPOSED.
      return { label: 'EXPOSED', cls: 'lf-lose' };
    }
    if (aDies && !pDies) return { label: 'WIN',   cls: 'lf-win' };
    if (pDies && !aDies) return { label: 'LOSE',  cls: 'lf-lose' };
    if (pDies && aDies)  return { label: 'TRADE', cls: 'lf-trade' };
    return { label: 'STALL', cls: 'lf-stall' };
  },

  // ===================== LANE FORECAST STRIP =====================
  // Always-on horizontal strip above the player-bar showing each lane's
  // predicted combat outcome. User spec: "for the combat forcast always
  // have it on, remove the words 'combat forecast' and have the boxes
  // be perfectly aligned with thier repective lanes."
  // - Always on (game-over only hides it; otherwise always present)
  // - No label text — pure 6-cell row
  // - Each cell rendered with the same grid template as the .board, so
  //   cell N sits directly under lane N
  renderLaneForecastStrip(s) {
    let strip = document.getElementById('lane-forecast-strip');
    const shouldShow = s && !s.gameOver && typeof Game.predictLaneOutcome === 'function';
    if (!shouldShow) {
      if (strip) strip.style.display = 'none';
      return;
    }
    if (!strip) {
      strip = document.createElement('div');
      strip.id = 'lane-forecast-strip';
      strip.className = 'lane-forecast-strip';
      // Insert just above the player-bar so it sits in the natural
      // pre-combat reading flow (above the Done button).
      const playerBar = document.querySelector('.info-bar.player-bar');
      if (playerBar && playerBar.parentNode) {
        playerBar.parentNode.insertBefore(strip, playerBar);
      } else {
        document.body.appendChild(strip);
      }
    }
    strip.style.display = '';
    // Per-lane face-damage prediction. Each cell shows three values:
    //   • RED  — damage to YOUR face this round from this lane
    //   • word — verdict (WIN / TRADE / STALL / LOSE / etc.)
    //   • GREEN — damage to OPPONENT face this round from this lane
    // Face damage only happens in UNCONTESTED lanes (one side empty);
    // in contested lanes, both swings hit the cards, not the face.
    // ONLY raw ATTACK lands on the face — splash damage hits ADJACENT
    // cards, never the health bar. Engine path: damagePlayer(owner,
    // swinger.attack, ...) at line ~1897 / ~2600 — splashRange is
    // never passed to damagePlayer. User report: "splash doesnt do
    // damge to the healthbar so -10 is wrong it shoudl be -6 to the
    // helathbar but 10 to a card here" (Yoda 6 ATK + Splash 4 lane
    // was reading -10 to face, should be -6).
    // Stunned/frozen attackers contribute zero. Block-meter clamping
    // is intentionally NOT modeled — the player can read their own
    // block meter directly.
    const faceDamageFor = (laneIdx, side) => {
      const lane = s.lanes[laneIdx];
      if (!lane || lane.destroyed) return 0;
      const me  = lane[side];
      const opp = lane[side === 'player' ? 'ai' : 'player'];
      // No attacker on this side, OR the opposing card blocks the swing
      if (!me || me.currentHealth <= 0) return 0;
      if (opp && opp.currentHealth > 0) return 0;
      // Status gates: stunned / frozen → no swing. Feared → swings at
      // own allies (no face damage). Mind-controlled → swings for the
      // opponent (also no face damage in your direction).
      if (me.isStunned || me.isFrozen || me.isFeared || me.isMindControlled) return 0;
      return me.attack || 0;
    };
    // Build per-lane verdict cells. Verdict math lives in the shared
    // helper laneForecastVerdict so the strip and the lane data-attr
    // (used by future features) stay in sync.
    const cells = [];
    for (let i = 0; i < Game.LANE_COUNT; i++) {
      const v = this.laneForecastVerdict(s, i);
      // RED  = damage to YOUR face = ai's swing into uncontested player slot
      // GREEN = damage to OPPONENT face = your swing into uncontested ai slot
      const redDmg   = faceDamageFor(i, 'ai');
      const greenDmg = faceDamageFor(i, 'player');
      const redCell   = redDmg   > 0 ? `<span class="lf-face lf-face-red">−${redDmg}</span>`   : '<span class="lf-face lf-face-zero">−</span>';
      const greenCell = greenDmg > 0 ? `<span class="lf-face lf-face-green">−${greenDmg}</span>` : '<span class="lf-face lf-face-zero">−</span>';
      cells.push(
        `<div class="lf-cell ${v.cls}" data-lane="${i}">` +
          redCell +
          `<span class="lf-verdict">${v.label}</span>` +
          greenCell +
        `</div>`
      );
    }
    // No label — just the 6 cells. Cell widths are sized at render
    // time below to match the actual rendered .lane width so each
    // cell sits directly under its lane regardless of viewport size.
    //
    // Skip the innerHTML rewrite if the rendered content is bit-for-
    // bit identical to last frame. Was a major jitter source —
    // rebuilding every render flickered the cells (children rebuilt
    // → momentary layout-shift → cell-width measurement applied a
    // frame later). Now content-stable renders cost ~0 DOM work.
    const html = cells.join('');
    const htmlChanged = this._laneStripLastHtml !== html;
    if (htmlChanged) {
      strip.innerHTML = html;
      this._laneStripLastHtml = html;
    }
    // Two-pass alignment: read the actual rendered lane widths AND
    // the board's bounding box, then size the strip + cells to match.
    // Defers to the next animation frame so the board's own layout
    // has settled before we measure (otherwise we'd read the layout
    // from the previous render). User spec: "Just make it literally
    // the width of the lane."
    //
    // Re-apply cell widths whenever the HTML was rewritten (new cells
    // come back to default browser sizing) OR when the lane width
    // changed since last render. Skipping both means a content-stable,
    // viewport-stable render does zero style writes here. User report:
    // "the lane preview is not under the lanes" — caused by an earlier
    // version that skipped sizing on content changes too, leaving new
    // cells at default flex sizing → justify-content shifted the row.
    requestAnimationFrame(() => {
      const board = document.getElementById('board');
      const firstLane = board && board.querySelector('.lane');
      if (!board || !firstLane) return;
      const laneRect = firstLane.getBoundingClientRect();
      const boardRect = board.getBoundingClientRect();
      const w = laneRect.width;
      const lastSize = this._laneStripLastSize;
      const sizeUnchanged = lastSize && lastSize.w === w && lastSize.bw === boardRect.width;
      if (sizeUnchanged && !htmlChanged) return;
      this._laneStripLastSize = { w, bw: boardRect.width };
      strip.style.maxWidth = boardRect.width + 'px';
      strip.style.marginLeft = 'auto';
      strip.style.marginRight = 'auto';
      // Match each cell's flex sizing to the actual lane width (px).
      // Set min/max to the same value so flex-shrink can't compress
      // them at narrow viewports.
      strip.querySelectorAll('.lf-cell').forEach(cell => {
        cell.style.width = w + 'px';
        cell.style.minWidth = w + 'px';
        cell.style.maxWidth = w + 'px';
        cell.style.flex = '0 0 ' + w + 'px';
      });
    });
  },

  // ===================== LOG =====================

  renderLog(s) {
    // Show the full match log — previously capped at the last 25 entries,
    // which made mid-match scroll-back impossible. The drawer is
    // overflow-y:auto so it scrolls naturally; we pin the view to the
    // newest entry at the end of render unless the user has scrolled up.
    const stickBottom = !this._logEl_userScrolled;
    const visible = s.log;
    const tagColors = {
      'HIT': '#e74c3c', 'KILLED': '#c0392b', 'DEAD': '#c0392b',
      'DAMAGE': '#e67e22', 'BLOCKED!': '#3498db', 'BLOCK METER': '#2980b9',
      'EVADE': '#9b59b6', 'ARMOR': '#7f8c8d', 'INVINCIBLE': '#f39c12',
      'STUN': '#f1c40f', 'FREEZE': '#3498db', 'FEAR': '#9b59b6',
      'DRAIN': '#8e44ad', 'MIND CTRL': '#e74c3c', 'MIND CONTROL': '#e74c3c',
      'PLAY': '#2ecc71', 'FREE PLAY': '#27ae60', 'TRICK': '#1abc9c',
      'DRAW': '#3498db', 'DRAW TRICK': '#16a085',
      'DRAFT': '#f39c12', 'DISCARD': '#95a5a6',
      'HEAL': '#2ecc71', 'SUMMON': '#27ae60', 'MOVE': '#3498db',
      'OVERDRIVE': '#e74c3c', 'SPLASH': '#e67e22',
      'LANE': '#8e8e8e', 'BULLSEYE': '#c0392b',
      'IMMUNE': '#f39c12', 'BLOCKED': '#95a5a6',
      'HUNT': '#e67e22', 'STOLEN': '#e74c3c', 'DMG IMMUNE': '#f39c12',
      'DECK': '#7f8c8d', 'JUMP': '#f1c40f', 'BWL': '#9b59b6',
      'DISCOUNT': '#f39c12', 'MAGNETO': '#9b59b6', 'DEBUFF': '#e67e22',
      'DR. STRANGE': '#3498db', 'REVEAL': '#3498db', 'MODER': '#9b59b6'
    };
    // Map raw tags to coarse categories so the left-border color stays readable.
    const categoryOf = (tag) => {
      if (!tag) return '';
      if (/^DEAD|KILL|DESTROY/.test(tag)) return 'dead';
      if (/^DAMAGE|DMG|ATTACK|OVERDRIVE|SPLASH|BULLSEYE|HUNT/.test(tag)) return 'damage';
      if (/^HEAL|BLOCK|IMMUNE|ARMOR|EVADE/.test(tag)) return 'defense';
      if (/^DRAW|DECK/.test(tag)) return 'draw';
      if (/^PLAY|FREE PLAY|SUMMON|DRAFT/.test(tag)) return 'play';
      if (/^TRICK/.test(tag)) return 'trick';
      if (/^JUMP/.test(tag)) return 'jump';
      if (/^MOVE|LANE/.test(tag)) return 'move';
      if (/^STOLEN|BWL|MAGNETO|MODER|DEBUFF|FREEZE|STUN|FEAR|MIND/.test(tag)) return 'control';
      if (/^DISCARD|DISCOUNT/.test(tag)) return 'utility';
      return '';
    };
    this.logEl.innerHTML = visible.map(m => {
      if (m.startsWith('---') || m.startsWith('==='))
        return `<div class="log-header">${m}</div>`;
      const firstTag = (m.match(/\[([A-Z .!]+)\]/) || [])[1];
      const cat = categoryOf(firstTag);
      const colored = m.replace(/\[([A-Z .!]+)\]/g, (match, tag) => {
        const color = tagColors[tag] || '#888';
        return `<span style="color:${color};font-weight:bold">[${tag}]</span>`;
      });
      return `<div class="log-entry${cat ? ' log-' + cat : ''}">${colored}</div>`;
    }).join('');
    // Only auto-scroll to the tail if the user hasn't scrolled up to read
    // back-history. Detach once, then re-track.
    if (!this._logEl_scrollListener) {
      this._logEl_scrollListener = true;
      this.logEl.addEventListener('scroll', () => {
        const nearBottom = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 40;
        this._logEl_userScrolled = !nearBottom;
      });
    }
    if (stickBottom) this.logEl.scrollTop = this.logEl.scrollHeight;
  },

  // ===================== LANE FLASH =====================
  // Temporarily add a CSS class to specific lane DOM elements so they
  // visually "light up" for a short burst — e.g. Thanos snap showing
  // which 3 lanes got rolled, even the ones that had no target to kill.
  // Uses a direct DOM write rather than game state so the effect is
  // purely decorative and doesn't survive a re-render; if the next
  // UI.render() wipes the class, we just add it back.
  flashLanes(laneIndices, className, durationMs) {
    if (!Array.isArray(laneIndices) || !className) return;
    const duration = durationMs || 1500;
    const apply = () => {
      laneIndices.forEach(i => {
        const el = document.querySelector(`.board .lane:nth-child(${i + 1})`);
        if (el) el.classList.add(className);
      });
    };
    apply();
    // Defer the apply one tick so it survives a render that happens
    // immediately after the card's onPlay (very common).
    setTimeout(apply, 20);
    setTimeout(() => {
      laneIndices.forEach(i => {
        const el = document.querySelector(`.board .lane:nth-child(${i + 1})`);
        if (el) el.classList.remove(className);
      });
    }, duration);
  },

  // ===================== GAME OVER SCREEN =====================

  // Hide / show the game-over overlay so the player can examine the
  // final board state and bring the result screen back when ready.
  // User spec: "It'd be cool if you can toggle it on and off so you
  // can see the board afterwards and not just be stuck on the victory
  // screen." Esc key handler in installKeyShortcuts also calls this.
  // ----------------------------------------------------------------
  // (R) Now routes through the shared peek-toggle system below so every
  // dismissable modal — round recap, trick prompts, victory screen —
  // uses identical chrome and identical ⨯ → restore pill behavior.
  toggleGameOverScreen() {
    const overlay = document.getElementById('game-over-overlay');
    if (!overlay) return;
    const showing = overlay.style.display === 'flex';
    if (showing) this.peekModal('#game-over-overlay', 'Show Result');
    else this.restorePeekedModal();
  },

  // ===================== SHARED PEEK-TOGGLE SYSTEM =====================
  // Hide a modal but leave a single floating "restore" pill so the
  // player can dismiss any overlay temporarily to inspect the board,
  // then bring it back. One shared pill (#peek-restore) is configured
  // dynamically — only one modal is peeked at a time. Mirrors the
  // game-over toggle visuals (cyan neon ring, breathing pulse, hover
  // shift) so the affordance reads identical regardless of context.
  //
  // selectorOrEl: CSS selector or element of the modal to hide
  // restoreLabel: text shown on the floating pill (defaults to "Restore")
  peekModal(selectorOrEl, restoreLabel) {
    const modal = (typeof selectorOrEl === 'string')
      ? document.querySelector(selectorOrEl)
      : selectorOrEl;
    if (!modal) return;
    // Remember the previous display so .restore() can faithfully restore.
    const prevDisplay = modal.style.display || 'flex';
    modal.dataset.peekDisplay = prevDisplay;
    modal.style.display = 'none';
    modal.dataset.peekHidden = '1';
    this._peekedModal = modal;
    const pill = document.getElementById('peek-restore');
    const label = document.getElementById('peek-restore-label');
    if (label) label.textContent = restoreLabel || 'Restore';
    if (pill) pill.style.display = 'inline-flex';
    // Tiny SFX so the action feels acknowledged. Uses the same atomic
    // click voice the universal click feedback fires for buttons.
    try { if (this.audio && this.audio.click) this.audio.click(); } catch (e) {}
  },
  // Reverse of peekModal — bring the most-recently-hidden modal back.
  // Wired to the shared #peek-restore pill's onclick AND to Esc.
  restorePeekedModal() {
    const modal = this._peekedModal;
    if (modal) {
      modal.style.display = modal.dataset.peekDisplay || 'flex';
      modal.dataset.peekHidden = '0';
    }
    this._peekedModal = null;
    const pill = document.getElementById('peek-restore');
    if (pill) pill.style.display = 'none';
    // A slightly brighter cue on restore — ascending "select" pip — to
    // make the affordance feel reciprocal rather than a flat repeat.
    try { if (this.audio && this.audio.select) this.audio.select(); } catch (e) {}
  },
  // Convenience: returns true if any modal is currently peeked. Used by
  // the Esc-key handler to prefer "restore peeked modal" over other
  // shortcuts when there's a hidden overlay waiting to come back.
  hasPeekedModal() {
    return !!(this._peekedModal && this._peekedModal.dataset.peekHidden === '1');
  },
  // Remove a floating-prompt modal from the DOM and clear any lingering
  // peek-restore pill state if the modal being removed is the one
  // currently peeked. Used when the underlying game state (e.g.
  // pendingBlockTrick) clears so the prompt no longer applies.
  _removeFloatingPrompt(id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (this._peekedModal === el) {
      this._peekedModal = null;
      const pill = document.getElementById('peek-restore');
      if (pill) pill.style.display = 'none';
    }
    el.remove();
  },
  showGameOverScreen(winner) {
    const overlay = document.getElementById('game-over-overlay');
    if (!overlay || overlay.style.display === 'flex') return;
    // Roguelite mode owns its own post-fight flow (rewards screen,
    // level-up etch picks, return to map). Suppress the standard
    // VICTORY/DEFEAT overlay entirely — Roguelite._onFightEnd takes
    // over via the gameOver watcher and routes to roguelite-rewards
    // / roguelite-end. The Rematch button shouldn't appear here at
    // all in this mode (user direction: "rematch breaks everything,
    // just give me Next or Return-to-Map"). Keeping the suppression
    // here belt-and-suspenders even though _onFightEnd hides the
    // overlay too, since this fires earlier in the lifecycle.
    if (Game.state && Game.state.mode && Game.state.mode._roguelite) {
      overlay.style.display = 'none';
      return;
    }
    // Make sure the floating restore pill is hidden whenever the
    // overlay opens (handles re-entry after the user toggled away).
    const peekPill = document.getElementById('peek-restore');
    if (peekPill) peekPill.style.display = 'none';
    // Clear any stale peek state from a previous round-recap session so
    // Esc doesn't try to "restore" a long-gone modal.
    this._peekedModal = null;
    overlay.dataset.peekHidden = '0';
    const isVictory = winner === 'player';
    // (AAA) Killing-blow cinematic — fire the radial vignette + warm
    // brightness pop + 220ms hit-pause anchored on the loser's HP bar
    // BEFORE the overlay slides in. The 60ms defer in damagePlayer
    // gives this beat ~1 frame of breathing room before the overlay
    // covers the board, so the cinematic is visible during the
    // transition. Tinted by outcome (cyan victory / red defeat).
    const losingSide = isVictory ? 'ai' : 'player';
    if (this.killingBlowCinema) this.killingBlowCinema(losingSide);
    // Victory / defeat pose — animate the living board cards with a
    // celebratory rise (winning side) + a defeated slump (losing side).
    // Triggered BEFORE the overlay opens so the player briefly sees
    // their board react before the score panel takes over.
    document.body.classList.remove('victory-pose', 'defeat-pose');
    document.body.classList.add(isVictory ? 'victory-pose' : 'defeat-pose');
    // Strip the pose class a few seconds later so a subsequent match
    // doesn't inherit it on the first render.
    setTimeout(() => {
      document.body.classList.remove('victory-pose', 'defeat-pose');
    }, 2200);
    // Capture match config BEFORE Game.init() nukes it, so the Rematch
    // button can spin up an identical match. Mode is the deck key
    // (classic / deckbuilder); customDeck is the user's saved-deck body
    // when they went through the builder.
    if (Game.state && Game.state.mode) {
      this._lastMatchConfig = {
        mode: Game.state.mode.deck,
        players: Game.state.mode.players,
        customDeck: Game.state.mode.customDeck ? {
          cards: (Game.state.mode.customDeck.cards || []).slice(),
          tricks: (Game.state.mode.customDeck.tricks || []).slice()
        } : null
      };
    }
    // Record this match in the rolling history (last 10). Fires exactly
    // once per game-over regardless of how the user dismisses.
    this._recordMatchInHistory(winner);
    overlay.className = 'game-over-overlay ' + (isVictory ? 'victory' : 'defeat');
    overlay.style.display = 'flex';
    document.getElementById('game-over-title').textContent = isVictory ? 'VICTORY' : 'DEFEAT';
    this.sfx.play(isVictory ? 'victory' : 'defeat');
    if (isVictory) this.launchVictoryConfetti(overlay);
    // Victory haptic — triple buzz pattern; defeat gets a single long rumble.
    if (navigator.vibrate) {
      try { navigator.vibrate(isVictory ? [70, 60, 70, 60, 200] : [300]); } catch (e) {}
    }
    this.renderGameOverStats();
    // (O) Count-up any integer <b> values inside the stats panel so the
    // numbers roll up from 0 when the screen appears. Floats and ranges
    // (e.g. "50.2%") are skipped — only bare integers.
    setTimeout(() => {
      const panel = document.getElementById('game-over-stats');
      if (!panel) return;
      panel.querySelectorAll('b').forEach((b) => {
        const txt = b.textContent.trim();
        if (!/^\d+$/.test(txt)) return;
        const target = parseInt(txt, 10);
        if (target <= 0) return;
        this.animateCountUp(b, target, 700);
      });
    }, 280);
  },

  // Canvas confetti burst on victory. Two waves (bottom-left, bottom-right)
  // of rotating rectangles arc up and fall with drag. Colors are pulled
  // from the active theme tokens so it matches the UI chrome. Respects
  // prefers-reduced-motion — in that mode we skip rendering entirely.
  launchVictoryConfetti(overlay) {
    if (!overlay || this._confettiLive) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'victory-confetti';
    // Insert first so the stats panel paints above the confetti (both
    // share the overlay's stacking context; DOM order decides z).
    overlay.insertBefore(canvas, overlay.firstChild);
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);
    // Read theme accent + gameplay signal colors from CSS tokens so the
    // confetti palette follows the active neon theme.
    const cs = getComputedStyle(document.body);
    const read = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
    const accent = read('--theme-rgb', '78, 220, 255');
    const colors = [
      `rgb(${accent})`,
      `rgb(${read('--ally-rgb', '74, 255, 170')})`,
      '#f6c84c',
      '#ffffff',
      `rgba(${accent}, 0.75)`
    ];
    const rnd = (a, b) => a + Math.random() * (b - a);
    const particles = [];
    const spawn = (originX) => {
      for (let i = 0; i < 65; i++) {
        const angle = rnd(-Math.PI * 0.78, -Math.PI * 0.22);
        const speed = rnd(9, 17);
        particles.push({
          x: originX,
          y: window.innerHeight + 10,
          vx: Math.cos(angle) * speed * (originX < window.innerWidth / 2 ? 1 : -1) * -1,
          vy: Math.sin(angle) * speed,
          w: rnd(6, 10),
          h: rnd(10, 16),
          rot: rnd(0, Math.PI * 2),
          vrot: rnd(-0.3, 0.3),
          color: colors[(Math.random() * colors.length) | 0],
          life: 0
        });
      }
    };
    spawn(window.innerWidth * 0.2);
    spawn(window.innerWidth * 0.8);
    setTimeout(() => spawn(window.innerWidth * 0.5), 220);

    this._confettiLive = true;
    const GRAVITY = 0.35, DRAG = 0.992, MAX_LIFE = 260;
    let frame = 0;
    const tick = () => {
      frame++;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.vx *= DRAG;
        p.vy = p.vy * DRAG + GRAVITY;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vrot;
        p.life++;
        if (p.y > window.innerHeight + 40 || p.life > MAX_LIFE) { particles.splice(i, 1); continue; }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life > MAX_LIFE - 40 ? (MAX_LIFE - p.life) / 40 : 1;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (particles.length > 0 && frame < 600) {
        this._confettiRAF = requestAnimationFrame(tick);
      } else {
        this._confettiLive = false;
        window.removeEventListener('resize', resize);
        canvas.remove();
      }
    };
    this._confettiRAF = requestAnimationFrame(tick);
  },

  stopVictoryConfetti() {
    if (this._confettiRAF) cancelAnimationFrame(this._confettiRAF);
    this._confettiRAF = null;
    this._confettiLive = false;
    const c = document.querySelector('.victory-confetti');
    if (c) c.remove();
  },

  // Compute and render end-of-game stats side-by-side (You vs Opponent):
  // top HP-bar damager, top enemy damager, longest survivor, block-meter
  // triggers, bullseye damage total. Pulls from per-card stat fields
  // captured during the game plus state._stats per-player totals.
  // HP-over-rounds SVG chart — rendered at the top of the game-over
  // stats panel. Player line reads the active --theme-rgb (live on
  // <body>) so a green theme gets a green line, etc.; enemy line stays
  // red (fixed signal). Uses the _hpHistory snapshots captured at each
  // startRound + a final snapshot on game-over.
  renderHpCurveSvg(s) {
    const h = s && s._hpHistory;
    if (!h || h.length < 2) return '';
    // Pull the live theme RGB string from the CSS var so the SVG matches
    // whatever neon theme is currently active.
    const themeRgb = (getComputedStyle(document.body).getPropertyValue('--theme-rgb') || '79,195,247').trim();
    const W = 340, H = 110, padL = 28, padR = 10, padT = 10, padB = 22;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxHp = Math.max(30, ...h.map(p => Math.max(p.player, p.ai)));
    const maxR  = Math.max(1, h[h.length - 1].round);
    const x = (r) => padL + ((r - 1) / Math.max(1, maxR - 1)) * innerW;
    const y = (hp) => padT + (1 - hp / maxHp) * innerH;
    const ptsFor = (key) => h.map(p => `${x(p.round).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
    const gridY = [0, Math.round(maxHp * 0.5), maxHp];
    const gridLines = gridY.map(v =>
      `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="2 3"/>` +
      `<text x="${padL - 6}" y="${y(v) + 3}" fill="#6c7886" font-size="8" text-anchor="end" font-family="Rajdhani, sans-serif">${v}</text>`
    ).join('');
    // Use Math.floor so the half-step end-of-game point (e.g. round
    // 5.5) buckets back to the actual final round (5). Otherwise we'd
    // render a phantom "6" label past the right edge of the chart
    // even though no round 6 was ever played. Math.floor keeps the
    // killing-blow point visible on the line (it sits between label
    // "5" and the right edge) without inventing a fake round label.
    const rounds = h.map(p => Math.floor(p.round)).filter((v, i, a) => a.indexOf(v) === i);
    const xLabels = rounds.map(r =>
      `<text x="${x(r)}" y="${H - padB + 12}" fill="#6c7886" font-size="8" text-anchor="middle" font-family="Rajdhani, sans-serif">${r}</text>`
    ).join('');
    const last = h[h.length - 1];
    // End-of-line marker: skull on the side that died (HP <= 0), circle
    // on the survivor. User feedback: "the graph has a circle at the
    // end, whichever person died, I would like it to be a skull."
    const skullPath = (cx, cy, color) => {
      // Compact skull glyph (~10×12). Offsets so cx/cy is the skull's center.
      const ox = cx - 5, oy = cy - 6;
      return `<g transform="translate(${ox},${oy})">
        <path d="M5 0 C1.5 0 0 2.2 0 4.6 C0 6.5 0.8 7.8 2 8.7 V11 C2 11.6 2.4 12 3 12 H7 C7.6 12 8 11.6 8 11 V8.7 C9.2 7.8 10 6.5 10 4.6 C10 2.2 8.5 0 5 0 Z"
          fill="${color}"/>
        <circle cx="3" cy="5" r="1.1" fill="#080a14"/>
        <circle cx="7" cy="5" r="1.1" fill="#080a14"/>
        <rect x="4" y="9" width="0.7" height="2" fill="#080a14"/>
        <rect x="5.3" y="9" width="0.7" height="2" fill="#080a14"/>
      </g>`;
    };
    const playerEnd = last.player <= 0
      ? skullPath(x(last.round), y(last.player), `rgba(${themeRgb},0.95)`)
      : `<circle cx="${x(last.round)}" cy="${y(last.player)}" r="3" fill="rgba(${themeRgb},0.95)" />`;
    const aiEnd = last.ai <= 0
      ? skullPath(x(last.round), y(last.ai), 'rgba(231,76,60,0.95)')
      : `<circle cx="${x(last.round)}" cy="${y(last.ai)}" r="3" fill="rgba(231,76,60,0.95)" />`;
    return `
      <div class="go-hp-chart">
        <div class="go-hp-chart-title">HP over rounds</div>
        <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none">
          ${gridLines}
          <polyline fill="none" stroke="rgba(231,76,60,0.85)" stroke-width="1.8" points="${ptsFor('ai')}" />
          <polyline fill="none" stroke="rgba(${themeRgb},0.95)" stroke-width="1.8" points="${ptsFor('player')}"
                    style="filter: drop-shadow(0 0 2px rgba(${themeRgb},0.6))" />
          ${aiEnd}
          ${playerEnd}
          ${xLabels}
        </svg>
        <div class="go-hp-legend">
          <span class="go-hp-legend-dot go-hp-you"  style="background:rgb(${themeRgb}); box-shadow:0 0 6px rgba(${themeRgb},0.6)"></span> You
          <span class="go-hp-legend-dot go-hp-opp"></span> Opponent
        </div>
      </div>`;
  },

  renderGameOverStats() {
    const panel = document.getElementById('game-over-stats');
    if (!panel) return;
    const s = Game.state;
    const currentRound = s.round || 1;

    // Name color for each side — matches the board card name banner hue
    // (cyan for player's ally cards, red for AI's enemy cards) so the
    // victory-screen names stay in the same visual family as the cards
    // the player just saw on the board.
    const nameSpan = (name, side) => {
      const cls = side === 'player' ? 'go-card-ally' : 'go-card-enemy';
      return `<span class="${cls}">${name}</span>`;
    };

    // Build a per-side summary: pool = every card that entered play
    // (live board + dead pile), plus the totals the engine tracks on
    // state._stats. Returns normalized display strings the renderer can
    // drop straight into cells.
    const summarize = (side) => {
      const pool = [];
      for (let i = 0; i < Game.LANE_COUNT; i++) {
        const c = s.lanes[i][side];
        if (c && c.statsEnteredRound != null) pool.push(c);
      }
      s[side].deadPile.forEach(c => {
        if (c.statsEnteredRound != null) pool.push(c);
      });
      const topBy = (key) => {
        let best = null;
        for (const c of pool) {
          if (!c[key]) continue;
          if (!best || c[key] > best[key]) best = c;
        }
        return best;
      };
      const topHpDmg = topBy('statsHealthbarDamage');
      const topEnemyDmg = topBy('statsEnemyDamage');
      let topSurvivor = null, topSurvivorRounds = 0;
      for (const c of pool) {
        const left = c.statsLeftRound != null ? c.statsLeftRound : currentRound;
        const rounds = Math.max(0, left - c.statsEnteredRound + 1);
        if (rounds > topSurvivorRounds) { topSurvivorRounds = rounds; topSurvivor = c; }
      }
      // Number chip — vertical 2px tron bar + neon number in team color.
      // Replaces plain parentheses around the stat value so the cell reads
      // as "name │ value" like a telemetry readout rather than text.
      const numChip = (n) => `<span class="go-stat-num">${n}</span>`;
      // For each MVP component, find the SINGLE CARD that contributed
      // the most on that side. Per user: "damage done" / "damage absorbed"
      // / "energy generated" should each show the top card's name + their
      // value (not a side-wide sum) — like a mini-leaderboard per metric.
      let mvpCard = null, mvpScore = 0;
      let topDmgCard = null, topDmgVal = 0;
      let topAbsCard = null, topAbsVal = 0;
      let topEngCard = null, topEngVal = 0;
      for (const c of pool) {
        const damageDone = (c.statsHealthbarDamage || 0) + (c.statsEnemyDamage || 0);
        const absorbed = c.statsDamageAbsorbed || 0;
        const energy = c.statsEnergyGenerated || 0;
        const kills = c.statsKills || 0;
        if (damageDone > topDmgVal) { topDmgVal = damageDone; topDmgCard = c; }
        if (absorbed   > topAbsVal) { topAbsVal = absorbed;   topAbsCard = c; }
        if (energy     > topEngVal) { topEngVal = energy;     topEngCard = c; }
        // MVP formula — damage + absorbed + energy + (5 per kill).
        const score = damageDone + absorbed + energy + kills * 5;
        if (score > mvpScore) { mvpScore = score; mvpCard = c; }
      }
      const totals = (s._stats && s._stats[side]) || { blockTriggers: 0, peakRoundDamage: 0, cardsKilled: 0, energySpent: 0 };
      const topRow = (c, val) => c ? `${nameSpan(c.name, side)}${numChip(val)}` : '—';
      return {
        blocks: totals.blockTriggers,
        peakRound: totals.peakRoundDamage,
        cardsKilled: totals.cardsKilled,
        energySpent: totals.energySpent,
        damageDone: topRow(topDmgCard, topDmgVal),
        damageAbsorbed: topRow(topAbsCard, topAbsVal),
        energyGenerated: topRow(topEngCard, topEngVal),
        survivor: topSurvivor ? `${nameSpan(topSurvivor.name, side)}${numChip(topSurvivorRounds)}` : '—',
        mvpCardName: mvpCard ? mvpCard.name : null,
        mvpScore: mvpScore,
        mvp: mvpCard ? `${mvpCard.name} · ${mvpScore}` : '—',
      };
    };

    const you = summarize('player');
    const opp = summarize('ai');

    // Highlight which side "won" a numeric metric so comparisons pop.
    // `compare` values: 'hi' = higher is better (damage, blocks, energy),
    // 'lo' = lower is better (cards lost — fewer deaths wins),
    // false/null = informational, no winner highlight (names, MVP string).
    const better = (a, b, mode) => {
      if (mode === 'hi') return a > b ? 'go-stat-hi' : '';
      if (mode === 'lo') return a < b ? 'go-stat-hi' : '';
      return '';
    };
    const row = (label, youVal, oppVal, compare) => {
      const yCls = compare ? better(youVal, oppVal, compare) : '';
      const oCls = compare ? better(oppVal, youVal, compare) : '';
      return `
        <div class="go-stat-row">
          <span class="go-stat-label">${label}</span>
          <span class="go-stat-value go-col-you ${yCls}">${youVal}</span>
          <span class="go-stat-value go-col-opp ${oCls}">${oppVal}</span>
        </div>`;
    };

    // Shared per-card pool used by both MVP duo + Top-5 impact list.
    const pool = this._collectGameOverPool(s);
    panel.innerHTML = `
      ${this.renderMvpDuo(s, pool)}
      ${this.renderTop5Impact(pool)}
      ${this.renderHpCurveSvg(s)}
      <div class="go-stat-table">
        <div class="go-stat-row go-stat-head">
          <span class="go-stat-label"></span>
          <span class="go-stat-value go-col-you">You</span>
          <span class="go-stat-value go-col-opp">Opponent</span>
        </div>
        ${row('Cards killed', you.cardsKilled, opp.cardsKilled, 'hi')}
        ${row('Damage denied', you.damageAbsorbed, opp.damageAbsorbed, false)}
        ${row('Energy spent', you.energySpent, opp.energySpent, 'hi')}
        ${row('Times blocked', you.blocks, opp.blocks, 'hi')}
        ${row('Peak round damage', you.peakRound, opp.peakRound, 'hi')}
      </div>
      ${this.renderMvpRow(s._mvpDual, s.winner, s._mvpPlusBaseline)}
    `;
  },

  // Build a per-card stats-pool helper that the MVP duo + Top-5 impact
  // block both share. Aggregates Hela revives + summon copies under
  // the same name on each side. Returns a flat array of
  // { name, side, cost, def, damageDone, kills, absorbed, energy, hpDmg,
  //   enteredRound, leftRound, impactScore } per unique card-on-side.
  _collectGameOverPool(s) {
    const out = [];
    const sides = ['player', 'ai'];
    sides.forEach(side => {
      const pool = [];
      for (let i = 0; i < Game.LANE_COUNT; i++) {
        const c = s.lanes[i][side];
        if (c && c.statsEnteredRound != null) pool.push(c);
      }
      (s[side].deadPile || []).forEach(c => { if (c.statsEnteredRound != null) pool.push(c); });
      // Aggregate by name so multiple instances merge.
      const byName = {};
      pool.forEach(c => {
        const k = c.name || 'unknown';
        const e = byName[k] || (byName[k] = {
          name: k, side, cost: c.baseCost ?? c.cost ?? 0,
          damageDone: 0, kills: 0, absorbed: 0, energy: 0, hpDmg: 0,
          enteredRound: c.statsEnteredRound, leftRound: c.statsLeftRound
        });
        e.damageDone += (c.statsHealthbarDamage || 0) + (c.statsEnemyDamage || 0);
        e.absorbed   += c.statsDamageAbsorbed || 0;
        e.energy     += c.statsEnergyGenerated || 0;
        e.kills      += c.statsKills || 0;
        e.hpDmg      += c.statsHealthbarDamage || 0;
        if (c.statsEnteredRound < e.enteredRound) e.enteredRound = c.statsEnteredRound;
      });
      Object.values(byName).forEach(e => {
        // Match the per-card MVP formula: damage + absorbed + energy + 5×kills
        e.impactScore = e.damageDone + e.absorbed + e.energy + e.kills * 5;
        e.def = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS.find(d => d.name === e.name) : null;
        out.push(e);
      });
    });
    return out;
  },

  // MVP + Runner-up — two side-by-side cards with rarity-based borders
  // and a compact stats line apiece. User feedback: "the cards the MVP
  // cards at the top need to be just horizontal... give a impact score
  // for all the cards in the middle, like the top five."
  renderMvpDuo(s, pool) {
    const sortedAll = pool.slice().sort((a, b) => b.impactScore - a.impactScore);
    if (!sortedAll.length) return '';
    // Prefer MVP from winning side if there's a winner.
    let mvp, runner;
    if (s.winner === 'player' || s.winner === 'ai') {
      const winSide = s.winner;
      const winners = sortedAll.filter(e => e.side === winSide);
      const losers  = sortedAll.filter(e => e.side !== winSide);
      mvp = winners[0] || sortedAll[0];
      runner = losers[0] || sortedAll[1] || null;
    } else {
      mvp = sortedAll[0];
      runner = sortedAll[1];
    }
    if (!mvp) return '';
    const renderCard = (entry, label) => {
      if (!entry) return '<div class="go-mvp-slot go-mvp-empty"></div>';
      const def = entry.def;
      const cost = def && def.cost != null ? def.cost : entry.cost || 0;
      const stats = (def && def.attack != null && def.health != null)
        ? `<span class="stat-circle stat-atk">${def.attack}</span><span class="stat-circle stat-hp">${def.health}</span>`
        : '';
      const abilities = (def && def.abilities && def.abilities.length)
        ? `<div class="card-abilities status-badges">${this.formatAbilityBadges(def.abilities)}</div>` : '';
      const sideTag = entry.side === 'player' ? 'YOU' : 'OPP';
      const sideTagCls = entry.side === 'player' ? 'go-mvp-side-you' : 'go-mvp-side-opp';
      return `
        <div class="go-mvp-slot go-mvp-${label.toLowerCase()}">
          <div class="go-mvp-header">
            <span class="go-mvp-rank">${label}</span>
            <span class="go-mvp-side-tag ${sideTagCls}">${sideTag}</span>
          </div>
          <div class="card go-mvp-card ${this.getCostClass(cost)}">
            <span class="card-cost">${cost}</span>
            <div class="card-name-banner"><div class="card-name">${entry.name}</div></div>
            ${abilities}
            ${stats}
          </div>
          <div class="go-mvp-stats">
            <div class="go-mvp-stat-row"><span class="go-mvp-stat-k">Impact</span><b>${Math.round(entry.impactScore)}</b></div>
            <div class="go-mvp-stat-row"><span class="go-mvp-stat-k">Damage</span><b>${entry.damageDone}</b></div>
            <div class="go-mvp-stat-row"><span class="go-mvp-stat-k">Kills</span><b>${entry.kills}</b></div>
            <div class="go-mvp-stat-row"><span class="go-mvp-stat-k">Absorbed</span><b>${entry.absorbed}</b></div>
            ${entry.energy > 0 ? `<div class="go-mvp-stat-row"><span class="go-mvp-stat-k">Energy gen</span><b>${entry.energy}</b></div>` : ''}
            <div class="go-mvp-stat-row"><span class="go-mvp-stat-k">Played</span><b>R${entry.enteredRound}</b></div>
          </div>
        </div>`;
    };
    return `
      <div class="go-mvp-duo">
        ${renderCard(mvp, 'MVP')}
        ${renderCard(runner, 'RUNNER-UP')}
      </div>`;
  },

  // Top 5 cards by impact across both sides — compact horizontal list
  // sitting between the MVP duo and the HP curve. User spec: "give an
  // impact score for all the cards in the middle, of like the top five."
  renderTop5Impact(pool) {
    const top = pool.slice().sort((a, b) => b.impactScore - a.impactScore).slice(0, 5);
    if (!top.length) return '';
    return `
      <div class="go-top5">
        <div class="go-top5-title">Top 5 Impact</div>
        <ol class="go-top5-list">
          ${top.map((e, i) => `
            <li class="go-top5-item ${this.getCostClass(e.cost || 0)} ${e.side === 'player' ? 'go-top5-you' : 'go-top5-opp'}">
              <span class="go-top5-rank">${i + 1}</span>
              <span class="go-top5-name">${e.name}</span>
              <span class="go-top5-score">${Math.round(e.impactScore)}</span>
            </li>
          `).join('')}
        </ol>
      </div>`;
  },

  // (Legacy) Star of the Match panel — kept for back-compat with any
  // other call site, but the game-over flow uses renderMvpDuo now.
  renderStarOfTheMatch(s, you, opp) {
    const dual = s._mvpDual;
    if (!dual) return '';
    const yourCard = dual.player && dual.player.impactCard;
    const oppCard  = dual.ai     && dual.ai.impactCard;
    const yourScore = (dual.player && dual.player.impactScore) || 0;
    const oppScore  = (dual.ai     && dual.ai.impactScore)     || 0;
    if (!yourCard && !oppCard) return '';
    // Winner-of-the-match preference: if there's a winner side, prefer THEIR
    // MVP for the star panel. Otherwise highest impact across both sides.
    let starSide, starName, starScore, runnerSide, runnerName, runnerScore;
    if (s.winner === 'player' && yourCard) {
      starSide = 'player'; starName = yourCard; starScore = yourScore;
      runnerSide = 'ai';   runnerName = oppCard;  runnerScore = oppScore;
    } else if (s.winner === 'ai' && oppCard) {
      starSide = 'ai';     starName = oppCard;  starScore = oppScore;
      runnerSide = 'player'; runnerName = yourCard; runnerScore = yourScore;
    } else if (yourScore >= oppScore && yourCard) {
      starSide = 'player'; starName = yourCard; starScore = yourScore;
      runnerSide = 'ai';   runnerName = oppCard;  runnerScore = oppScore;
    } else if (oppCard) {
      starSide = 'ai';     starName = oppCard;  starScore = oppScore;
      runnerSide = 'player'; runnerName = yourCard; runnerScore = yourScore;
    } else {
      return '';
    }
    // Look up the actual card definition for the star so we can render
    // its cost / abilities / desc the same way the in-game card chrome
    // does. Falls back to a name-only chip if the def is missing.
    const def = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS.find(c => c.name === starName) : null;
    const sideLabel = starSide === 'player' ? 'YOU' : 'OPPONENT';
    const sideClass = starSide === 'player' ? 'sotm-side-player' : 'sotm-side-ai';
    const cost = def && def.cost != null ? def.cost : '';
    const stats = (def && def.attack != null && def.health != null)
      ? `<span class="stat-circle stat-atk">${def.attack}</span><span class="stat-circle stat-hp">${def.health}</span>`
      : '';
    const abilities = (def && def.abilities && def.abilities.length)
      ? `<div class="card-abilities status-badges">${this.formatAbilityBadges(def.abilities)}</div>` : '';
    const desc = (def && def.desc) ? `<div class="card-desc">${this.formatDesc(def.desc)}</div>` : '';
    // Pull the dominant contribution stat for the star — find it from the
    // pool side. Cheap pass; only runs once per game-over render.
    const findContrib = (side, name) => {
      const pool = [];
      for (let i = 0; i < Game.LANE_COUNT; i++) {
        const c = s.lanes[i][side];
        if (c && c.name === name) pool.push(c);
      }
      (s[side].deadPile || []).forEach(c => { if (c.name === name) pool.push(c); });
      // If multiple instances (Hela revives, summon copies), sum them.
      let damageDone = 0, absorbed = 0, energy = 0, kills = 0, hpDmg = 0;
      pool.forEach(c => {
        damageDone += (c.statsHealthbarDamage || 0) + (c.statsEnemyDamage || 0);
        absorbed   += c.statsDamageAbsorbed || 0;
        energy     += c.statsEnergyGenerated || 0;
        kills      += c.statsKills || 0;
        hpDmg      += c.statsHealthbarDamage || 0;
      });
      return { damageDone, absorbed, energy, kills, hpDmg };
    };
    const contrib = findContrib(starSide, starName);
    // Headline stat — pick whichever contribution dominates.
    const lines = [];
    if (contrib.damageDone > 0) lines.push({ label: 'Damage dealt',    value: contrib.damageDone });
    if (contrib.kills      > 0) lines.push({ label: 'Cards killed',    value: contrib.kills });
    if (contrib.absorbed   > 0) lines.push({ label: 'Damage absorbed', value: contrib.absorbed });
    if (contrib.energy     > 0) lines.push({ label: 'Energy granted',  value: contrib.energy });
    lines.sort((a, b) => b.value - a.value);
    const top = lines[0];
    const subStats = lines.slice(1, 3).map(l => `<span class="sotm-substat"><span class="sotm-substat-label">${l.label}</span><b>${l.value}</b></span>`).join('');
    const runnerLine = (runnerName && runnerScore > 0)
      ? `<div class="sotm-runner">Runner-up: <span class="${runnerSide === 'player' ? 'go-card-ally' : 'go-card-enemy'}">${runnerName}</span> · ${Math.round(runnerScore)} impact</div>`
      : '';
    return `
      <div class="sotm-panel ${sideClass}">
        <div class="sotm-banner">
          <span class="sotm-icon">★</span>
          <span class="sotm-title">Star of the Match</span>
          <span class="sotm-side-tag">${sideLabel}</span>
        </div>
        <div class="sotm-body">
          <div class="card sotm-card ${this.getCostClass(cost || 0)}">
            ${cost !== '' ? `<span class="card-cost">${cost}</span>` : ''}
            <div class="card-name-banner"><div class="card-name">${starName}</div></div>
            ${abilities}
            ${desc}
            ${stats}
          </div>
          <div class="sotm-stats">
            <div class="sotm-headline">
              <span class="sotm-headline-label">${top ? top.label : 'Impact'}</span>
              <b class="sotm-headline-value">${top ? top.value : Math.round(starScore)}</b>
            </div>
            <div class="sotm-substats">${subStats}</div>
            <div class="sotm-impact">Impact score · <b>${Math.round(starScore)}</b></div>
            ${runnerLine}
          </div>
        </div>
      </div>`;
  },
  // Dual MVP row — sabermetrics-inspired Aaron Judge / Mike Trout split:
  //   MVP    — the card with the highest raw weighted impact (the
  //            "finisher" — your big damage / kill / energy contributor)
  //   MVP+   — the card with the highest impact-per-cost rate, indexed
  //            so 100 = league-average for this match. Surfaces the
  //            efficient enabler that often gets overlooked when the
  //            big bombs steal the highlight.
  // Winning-side card uses gold chrome; losing-side silver.
  renderMvpRow(dual, winner, baseline) {
    const yGold = winner === 'player';
    const oGold = winner === 'ai';
    const cell = (label, val, gold) => {
      const cls = gold ? 'go-mvp-gold' : 'go-mvp-silver';
      return `<span class="go-stat-value go-mvp ${cls}"><span class="go-mvp-label">${label}</span> ${val}</span>`;
    };
    const youImpact = (dual && dual.player && dual.player.impactCard)
      ? `${dual.player.impactCard} · ${Math.round(dual.player.impactScore)}` : '—';
    const oppImpact = (dual && dual.ai && dual.ai.impactCard)
      ? `${dual.ai.impactCard} · ${Math.round(dual.ai.impactScore)}` : '—';
    const youPlus = (dual && dual.player && dual.player.mvpPlusCard)
      ? `${dual.player.mvpPlusCard} · ${dual.player.mvpPlus}` : '—';
    const oppPlus = (dual && dual.ai && dual.ai.mvpPlusCard)
      ? `${dual.ai.mvpPlusCard} · ${dual.ai.mvpPlus}` : '—';
    const baselineNote = baseline
      ? `<div class="go-mvp-footnote">MVP+ indexed to 100 = avg impact / energy this match (baseline ${baseline.toFixed(1)})</div>`
      : '';
    return `
      <div class="go-stat-row go-stat-mvp">
        <span class="go-stat-label">MVP</span>
        ${cell('IMPACT', youImpact, yGold)}
        ${cell('IMPACT', oppImpact, oGold)}
      </div>
      <div class="go-stat-row go-stat-mvp">
        <span class="go-stat-label">MVP+</span>
        ${cell('RATE', youPlus, yGold)}
        ${cell('RATE', oppPlus, oGold)}
      </div>
      ${baselineNote}`;
  },

  // Toggle the battle log from the victory/defeat screen. The drawer
  // element is `#log-section` (shared with the in-game log button).
  // Opening it from here also adds `game-over-log-open` which bumps its
  // z-index above the game-over overlay and forces it on-screen
  // regardless of the `.collapsed` state the in-game toggle uses.
  toggleGameOverLog() {
    const drawer = document.getElementById('log-section');
    if (!drawer) return;
    const isOpen = drawer.classList.contains('game-over-log-open');
    if (isOpen) {
      drawer.classList.remove('game-over-log-open');
      drawer.classList.add('collapsed');
    } else {
      drawer.classList.remove('collapsed');
      drawer.classList.add('game-over-log-open');
      const log = document.getElementById('game-log');
      if (log) log.scrollTop = log.scrollHeight;
    }
  },

  // ===================== INTERACTION =====================

  canPlayerPlayCards(s) {
    if (s.phase === 'player-cards' || s.phase === 'player-cards-tricks') return true;
    if (s.phase === 'player-tricks' &&
        Game.getAllCardsOf('player').some(c => c.passive === 'allowCardsInTricksPhase')) {
      return true;
    }
    // Thanos-style: individual cards with trickPhasePlayable
    if (s.phase === 'player-tricks' &&
        s.player.hand.some(c => c.trickPhasePlayable)) {
      return true;
    }
    return false;
  },

  // Per-card variant of canPlayerPlayCards. The global helper returns
  // true the moment ANY card with `trickPhasePlayable` (e.g. Thanos)
  // is in hand — but during the trick phase only that one card can
  // actually be played, not the rest of the hand. The hand renderer
  // and click handler must therefore check this per card so the
  // visual playable/unplayable state matches the click rules.
  canPlayThisCardNow(s, card) {
    if (s.phase === 'player-cards' || s.phase === 'player-cards-tricks') return true;
    if (s.phase === 'player-tricks') {
      // Red Skull passive on board unlocks the entire hand for the
      // trick phase — same gate as canPlayerPlayCards above.
      if (Game.getAllCardsOf('player').some(c => c.passive === 'allowCardsInTricksPhase')) return true;
      // Otherwise the card itself must be flagged trickPhasePlayable.
      if (card && card.trickPhasePlayable) return true;
    }
    return false;
  },

  canPlayerPlayTricks(s) {
    return s.phase === 'player-tricks' || s.phase === 'player-cards-tricks';
  },

  onCardClick(card) {
    const s = Game.state;
    if (!this.canPlayerPlayCards(s)) return;
    // In trick phase, only allow trickPhasePlayable cards unless Red Skull passive is active
    if (s.phase === 'player-tricks' && !card.trickPhasePlayable &&
        !Game.getAllCardsOf('player').some(c => c.passive === 'allowCardsInTricksPhase')) {
      return;
    }
    if (card.isDiscardEffect) { Game.playCard('player', card, 0); this.render(); return; }
    // Can't-afford feedback — shake the energy orb + pop a toast when
    // the player tries to select a card they don't have energy for.
    // Still allows selection (so they can see details) but signals it
    // won't play. Only fires on the "pick" action, not on deselect.
    const cost = (typeof Game.getCardCost === 'function') ? Game.getCardCost('player', card) : (card.cost || 0);
    if (s.selectedCard !== card && cost > s.player.currency) {
      // Pass the clicked card element so we can shake it too — the
      // user is staring at the card they tried to play, so flashing
      // the card itself is more legible than only flashing the
      // distant energy orb.
      const cardEl = document.querySelector(`.player-hand-section .card[data-card-id="${card.id}"]`);
      this.flashUnaffordable(cost, cardEl);
    } else if (s.selectedCard !== card) {
      // Successful card SELECT — fire a short positive haptic +
      // audio cue so mobile users feel the click register
      // independently of the visible selection ring.
      if (this._haptic) this._haptic('cardPlay');
      this._playSelectCue();
    }
    s.selectedCard = s.selectedCard === card ? null : card;
    this.render();
  },

  // Energy shake + card-shake + toast + haptic + audio when the
  // player can't afford the card they just clicked. Multi-channel
  // failure feedback — without this, an unaffordable click looks
  // identical to a successful one until the user notices nothing
  // happened. With it, the rejection is unambiguous and INSTANT
  // (sub-50ms from click to all four feedback channels firing).
  flashUnaffordable(cost, cardEl) {
    const el = document.querySelector('#player-energy-display .energy-text');
    if (el) {
      el.classList.remove('cant-afford');
      void el.offsetWidth; // force reflow so animation restarts
      el.classList.add('cant-afford');
      setTimeout(() => el.classList.remove('cant-afford'), 450);
    }
    // Card-itself shake — visible AT the click location so the eye
    // doesn't have to travel from card → energy orb to read the
    // rejection. Reuses the same energy-shake keyframe via a new
    // .card-shake-rejected class added in CSS.
    if (cardEl) {
      cardEl.classList.remove('card-shake-rejected');
      void cardEl.offsetWidth;
      cardEl.classList.add('card-shake-rejected');
      setTimeout(() => cardEl && cardEl.classList.remove('card-shake-rejected'), 480);
    }
    // Micro-toast that fades.
    if (this.showAITrickToast) {
      this.showAITrickToast('Not enough energy', `Need ${cost} · have ${Game.state.player.currency}`, 'error');
    }
    if (this._haptic) this._haptic('block');
    // Audio cue — synthesize a brief low-frequency thunk via Web
    // Audio so we don't need to ship a sample. Falls back silently
    // if the AudioContext can't be created (Safari before user
    // gesture, etc.).
    this._playRejectCue();
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
      this._master.connect(this._ctx.destination);
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
    select() { this.voice({ freq: 880,  dur: 0.08, type: 'sine',   gain: 0.07 }); },
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
    roundStart() {
      // Rising tone — energy entering the round
      this.voice({ freq: 220, endFreq: 440, dur: 0.40, type: 'triangle', gain: 0.06, exp: true });
    },
    roundEnd() {
      // Descending tone — energy settling
      this.voice({ freq: 440, endFreq: 220, dur: 0.40, type: 'triangle', gain: 0.05, exp: true });
    },
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

  // Compatibility shims — older code calls _playUiTone / _playClickCue
  // / _playSelectCue / _playRejectCue. Forward to the new audio module
  // so we don't have to chase down every caller.
  _playUiTone(freq, dur, type, gain) {
    this.audio.voice({ freq, dur, type, gain });
  },
  _playClickCue()  { this.audio.click();  },
  _playSelectCue() { this.audio.select(); },
  _playRejectCue() { this.audio.reject(); },

  // Spawn N small spark particles at (x, y), each scattering a
  // short distance in a random direction over ~380ms. The visible
  // accent that confirms a click registered without needing to
  // wait for the action to resolve.
  _spawnClickSparks(x, y, count) {
    if (this._reduceMotion === undefined) {
      this._reduceMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    if (this._reduceMotion) return;
    const N = count || 4;
    for (let i = 0; i < N; i++) {
      const ang  = (Math.PI * 2 * i / N) + (Math.random() - 0.5) * 0.6;
      const dist = 14 + Math.random() * 14;
      const dx   = Math.cos(ang) * dist;
      const dy   = Math.sin(ang) * dist;
      const s = document.createElement('div');
      s.className = 'click-spark';
      s.style.left = x + 'px';
      s.style.top  = y + 'px';
      s.style.setProperty('--dx', dx.toFixed(1) + 'px');
      s.style.setProperty('--dy', dy.toFixed(1) + 'px');
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 400);
    }
  },

  onLaneClick(i) {
    const s = Game.state;
    if (!this.canPlayerPlayCards(s) || !s.selectedCard) return;
    const card = s.selectedCard;
    // Invisible Woman face-down option
    if (s.player.faceDownAvailable && !card.isDiscardEffect) {
      const faceUp = { name: 'Play Face Up', desc: 'Play normally — all abilities activate', id: 'faceup_opt' };
      const faceDown = { name: 'Play Face Down', desc: 'Hidden until combat — abilities activate on reveal', id: 'facedown_opt' };
      Game.promptCardChoice('player', [faceUp, faceDown],
        "Invisible Woman — Stealth Deploy",
        `Play ${card.name} face up or face down?`,
        (choice) => {
          if (choice.id === 'facedown_opt') {
            card._playFaceDown = true;
            s.player.faceDownAvailable = false;
          }
          if (Game.playCard('player', card, i)) s.selectedCard = null;
          this.render();
        });
      return;
    }
    if (Game.playCard('player', card, i)) s.selectedCard = null;
    this.render();
  },

  onTrickClick(trick) {
    const s = Game.state;
    const playerActive = s.phase && s.phase.startsWith('player-') && !s.gameOver;
    const allowed = this.canPlayerPlayTricks(s) || (trick.anytime && playerActive);
    if (!allowed) return;
    // Two-click toggle: first click highlights the trick as "selected", second click
    // on the same trick plays it. Clicking a different trick switches selection.
    if (s.selectedTrick === trick) {
      s.selectedTrick = null;
      Game.playTrick('player', trick);
    } else {
      s.selectedTrick = trick;
    }
    this.render();
  },

  getCostClass(cost) {
    return `cost-${Math.min(10, Math.max(0, cost))}`;
  },

  // ===================== POLISH FX (items #1-#11) =====================

  // Respects the user's OS-level "reduce motion" preference. Checked
  // by call sites that spawn JS-driven animations (multikill banner,
  // screen flash, confetti, kill shockwave) — CSS handles the rest.
  _reducedMotion() {
    try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  },
  // Draw a tracer beam from attacker → target for a combat hit. The
  // beam is an absolutely-positioned rotated div sized to span the
  // two card centers. Short-lived (~260ms) with a scale-out on the
  // target end + soft glow. Color picks the attacker's side.
  _spawnAttackBeam(attackerId, targetId) {
    if (this._reducedMotion && this._reducedMotion()) return;
    const aEl = document.querySelector(`[data-card-id="${attackerId}"]`);
    const tEl = document.querySelector(`[data-card-id="${targetId}"]`);
    if (!aEl || !tEl) return;
    const aR = aEl.getBoundingClientRect();
    const tR = tEl.getBoundingClientRect();
    const ax = aR.left + aR.width / 2, ay = aR.top + aR.height / 2;
    const tx = tR.left + tR.width / 2, ty = tR.top + tR.height / 2;
    const dx = tx - ax, dy = ty - ay;
    const len = Math.hypot(dx, dy);
    if (len < 8) return;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    const side = aEl.classList.contains('ally-card') ? 'ally' : 'enemy';
    const beam = document.createElement('div');
    beam.className = 'attack-beam attack-beam-' + side;
    beam.style.left = ax + 'px';
    beam.style.top  = ay + 'px';
    beam.style.width = len + 'px';
    beam.style.transform = `rotate(${angle}deg)`;
    document.body.appendChild(beam);
    setTimeout(() => beam.remove(), 420);
  },

  // Brief "what happened" overlay that floats over a lane after its
  // combat resolves. Reduces log-diving — player sees "Hulk dealt 5
  // to Loki (killed) · Loki dealt 2 to Hulk" as a 2-second overlay
  // tethered to the lane. Respects reduced-motion (skips entirely).
  showLaneRecap(sum) {
    if (!sum || typeof sum.laneIdx !== 'number') return;
    if (this._reducedMotion && this._reducedMotion()) return;
    // No meaningful change? Skip — if nothing happened in this lane
    // the overlay would just be noise.
    const pDmg = Math.max(0, sum.aAtkBefore > 0 ? (sum.pHpBefore - sum.pHpAfter) : 0);
    const aDmg = Math.max(0, sum.pAtkBefore > 0 ? (sum.aHpBefore - sum.aHpAfter) : 0);
    if (!pDmg && !aDmg && !sum.pDied && !sum.aDied) return;
    const laneEl = document.querySelectorAll('.board .lane')[sum.laneIdx];
    if (!laneEl) return;
    // Clean up any old recap on this lane before spawning a new one.
    const stale = laneEl.querySelector('.lane-recap');
    if (stale) stale.remove();
    const panel = document.createElement('div');
    panel.className = 'lane-recap';
    const aLine = sum.aAtkBefore > 0
      ? `<div class="lr-line lr-enemy"><span class="lr-who">${sum.aName}</span> <span class="lr-arrow">→</span> <span class="lr-amt">${aDmg}</span>${sum.pDied ? ' <span class="lr-killed">KILLED</span>' : ''}</div>`
      : '';
    const pLine = sum.pAtkBefore > 0
      ? `<div class="lr-line lr-ally"><span class="lr-who">${sum.pName}</span> <span class="lr-arrow">→</span> <span class="lr-amt">${pDmg}</span>${sum.aDied ? ' <span class="lr-killed">KILLED</span>' : ''}</div>`
      : '';
    panel.innerHTML = aLine + pLine;
    laneEl.appendChild(panel);
    setTimeout(() => panel.remove(), 2000);
  },

  // Tron grid effects — cursor footprint trail on the board and
  // placement ripple when a card lands. User spec: "the footprints
  // on Tron leave, like, a little imprint. I kinda want that same
  // vibe for the cards and for my cursor on the board... when I play
  // a card, you can see the ripples. Having weight to my play would
  // be really cool."
  installTronGridFx() {
    if (this._tronGridFxInstalled) return;
    this._tronGridFxInstalled = true;
    if (typeof Game === 'undefined') return;

    // -------- (a) Tron disk cursor trail — two skate lines --------
    // Per user feedback: "two lines acting as if it's gliding or
    // slicing on top of the board, not a bunch of pulses." The
    // cursor's recent positions are buffered with timestamps; each
    // animation frame, two parallel SVG <path>s are redrawn through
    // the buffered points. Each path is offset PERPENDICULAR to the
    // motion direction by ±4px so the two tracks stay separated
    // regardless of which way the cursor turns. Old buffer points
    // expire after TRAIL_LIFE ms so the trail naturally shortens
    // when the cursor stops, and disappears entirely when the
    // cursor is idle.
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduceMotion) {
      // Build the SVG layer once. Lives at body level so it overlays
      // the entire page (menus, board, panels — all surfaces).
      const SVGNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.id = 'tron-cursor-trail';
      const pathL = document.createElementNS(SVGNS, 'path');
      const pathR = document.createElementNS(SVGNS, 'path');
      pathL.setAttribute('class', 'tron-trail-path');
      pathR.setAttribute('class', 'tron-trail-path');
      svg.appendChild(pathL);
      svg.appendChild(pathR);
      document.body.appendChild(svg);

      // Position buffer — {x, y, t} for each move sample. Older
      // entries get pruned each frame.
      const buf = [];
      const TRAIL_LIFE = 320;     // ms — how long a position lasts in the trail
      // Disk-edge geometry: the trail represents the back edges of a
      // gliding disk. TRAIL_OFFSET is the disk's radius (so the two
      // lines sit on opposite sides of the disk, separated by the
      // full diameter). HEAD_SETBACK_PX is how far behind the live
      // cursor the trail HEAD sits — equal to the radius so the
      // trail emerges from the back edge of the disk, never under
      // its body. Per user feedback: "make the lines a little wider
      // apart so they are even with the diameter of the circle and
      // don't have any of the line in the center of the circle —
      // start from the edge."
      const TRAIL_OFFSET = 10;       // px — half the gap = disk radius
      const HEAD_SETBACK_PX = 10;    // px — gap between live cursor and trail head (= disk radius)
      const SAMPLE_MS = 12;          // throttle on mousemove (~80 Hz)
      let lastSample = 0;
      document.addEventListener('mousemove', (e) => {
        const now = performance.now();
        if (now - lastSample < SAMPLE_MS) return;
        lastSample = now;
        buf.push({ x: e.clientX, y: e.clientY, t: now });
      }, { passive: true });

      // Frame loop — drop expired points, recompute the two parallel
      // path d-attributes from the remaining buffer.
      const tick = () => {
        const now = performance.now();
        // Prune expired points off the head
        while (buf.length > 0 && now - buf[0].t > TRAIL_LIFE) buf.shift();
        // Find the latest sample that's at least HEAD_SETBACK_PX
        // BEHIND the cursor (= the live tip of the buffer). We walk
        // backwards from the most recent point, accumulating arc
        // distance, and use the first sample beyond the setback as
        // the trail's head. This keeps the lines clear of the disk
        // body even at varying cursor speeds.
        let headIdx = buf.length - 1;
        if (buf.length >= 2) {
          let acc = 0;
          for (let i = buf.length - 1; i > 0; i--) {
            acc += Math.hypot(buf[i].x - buf[i - 1].x, buf[i].y - buf[i - 1].y);
            if (acc >= HEAD_SETBACK_PX) { headIdx = i; break; }
            headIdx = i - 1;
          }
        }
        // Effective range to draw: buf[0 .. headIdx]
        if (headIdx < 1) {
          pathL.setAttribute('d', '');
          pathR.setAttribute('d', '');
        } else {
          // ---- Step 1: precompute offset points for both lines ----
          // Two issues we're solving for smoothness:
          //   (a) Per-sample perpendicular flips abruptly when the
          //       cursor changes direction → lines look jittery.
          //       Fix: smooth the perpendicular with an exponential
          //       moving-average so direction changes lag slightly
          //       (the trail then turns gracefully through curves
          //       instead of snapping at corners).
          //   (b) Connecting samples with straight `L` segments
          //       gives a polyline that's visibly angular at every
          //       sample point. Fix: use SVG QUADRATIC BEZIERs
          //       (`Q`) through the midpoints of each segment, with
          //       the actual sample point as the control point.
          //       Standard cursor-trail smoothing technique.
          const SMOOTH_ALPHA = 0.55;  // perpendicular EMA weight
          let smNx = 0, smNy = 0;
          const Lpts = [], Rpts = [];
          for (let i = 0; i <= headIdx; i++) {
            const p = buf[i];
            // Raw perpendicular (instantaneous direction)
            let rawNx = 0, rawNy = 0;
            if (i > 0) {
              const prev = buf[i - 1];
              const dx = p.x - prev.x, dy = p.y - prev.y;
              const len = Math.hypot(dx, dy) || 1;
              rawNx = -dy / len;
              rawNy =  dx / len;
            } else if (buf.length > 1) {
              const next = buf[i + 1];
              const dx = next.x - p.x, dy = next.y - p.y;
              const len = Math.hypot(dx, dy) || 1;
              rawNx = -dy / len;
              rawNy =  dx / len;
            }
            // EMA — for the first sample, just use raw; thereafter
            // blend with the previous smoothed perpendicular.
            if (i === 0) { smNx = rawNx; smNy = rawNy; }
            else {
              smNx = SMOOTH_ALPHA * rawNx + (1 - SMOOTH_ALPHA) * smNx;
              smNy = SMOOTH_ALPHA * rawNy + (1 - SMOOTH_ALPHA) * smNy;
              // Re-normalize so the offset distance stays exactly
              // TRAIL_OFFSET regardless of how far the EMA shifted.
              const sLen = Math.hypot(smNx, smNy) || 1;
              smNx /= sLen; smNy /= sLen;
            }
            Lpts.push({ x: p.x + smNx * TRAIL_OFFSET, y: p.y + smNy * TRAIL_OFFSET });
            Rpts.push({ x: p.x - smNx * TRAIL_OFFSET, y: p.y - smNy * TRAIL_OFFSET });
          }
          // ---- Step 2: build smooth Bezier path through the points
          // Quadratic-midpoint smoothing: between every pair of
          // points P_{i} and P_{i+1}, draw a Q curve where the
          // midpoint is the curve's endpoint and the actual sample
          // is the control point. The polyline's sharp corners get
          // rounded off because each control point sits at the
          // corner and the curve tangents enter/exit smoothly. */
          const buildSmooth = (pts) => {
            const n = pts.length;
            if (n < 2) return '';
            if (n === 2) {
              return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} L ${pts[1].x.toFixed(1)} ${pts[1].y.toFixed(1)}`;
            }
            let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
            for (let i = 1; i < n - 1; i++) {
              const cx = pts[i].x, cy = pts[i].y;
              const next = pts[i + 1];
              const mx = (cx + next.x) / 2;
              const my = (cy + next.y) / 2;
              d += ` Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
            }
            // Final straight line to the head point so the trail
            // tip lands precisely where the head should be.
            const last = pts[n - 1];
            d += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
            return d;
          };
          pathL.setAttribute('d', buildSmooth(Lpts));
          pathR.setAttribute('d', buildSmooth(Rpts));
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    // -------- (b) Card placement — perimeter shockring --------
    // When a card lands, a thin neon ring traces the card's outer
    // edge then expands outward to the lane bounds while fading.
    // Reads as "the card displaced the medium when it landed" —
    // unlike the previous center-ripple (which read as a stamp),
    // this perimeter expansion makes the card feel like a SOLID
    // OBJECT settling into place.
    // Implementation: a position:absolute div is appended to the
    // landed card, sized to match the card via inset:-2px, with a
    // border that animates (scale + opacity + border-width) outward.
    // CSS does all the animation; JS just spawns + cleans up.
    const spawnPlaceShockring = (cardEl, owner) => {
      if (reduceMotion || !cardEl) return;
      const ring = document.createElement('div');
      ring.className = 'card-place-shockring' + (owner === 'ai' ? ' ring-ai' : ' ring-player');
      cardEl.appendChild(ring);
      // Cleanup after the keyframe finishes (700ms + 50ms grace)
      setTimeout(() => ring.remove(), 760);
    };
    if (Game.playCard) {
      const origPlayRing = Game.playCard.bind(Game);
      Game.playCard = (owner, card, laneIdx, ...rest) => {
        const r = origPlayRing(owner, card, laneIdx, ...rest);
        if (r && card && card.id != null && typeof laneIdx === 'number' && laneIdx >= 0) {
          // Defer to the next frame so the lane DOM has rebuilt and
          // the new card element is queryable.
          requestAnimationFrame(() => {
            const newEl = document.querySelector(`[data-card-id="${card.id}"]`);
            if (newEl && !newEl.classList.contains('hand-card')) {
              spawnPlaceShockring(newEl, owner);
            }
          });
        }
        return r;
      };
    }
    if (Game.playCardFree) {
      const origFreeRing = Game.playCardFree.bind(Game);
      Game.playCardFree = (owner, card, laneIdx, ...rest) => {
        const r = origFreeRing(owner, card, laneIdx, ...rest);
        if (card && card.id != null && typeof laneIdx === 'number' && laneIdx >= 0) {
          requestAnimationFrame(() => {
            const newEl = document.querySelector(`[data-card-id="${card.id}"]`);
            if (newEl && !newEl.classList.contains('hand-card')) {
              spawnPlaceShockring(newEl, owner);
            }
          });
        }
        return r;
      };
    }

    // -------- (c) HP-bar damage pulse --------
    // When face damage lands on a player, run a bright light packet
    // along that side's HP bar before the bar's width animation
    // settles to the new value. Hooks Game.damagePlayer so we know
    // exactly when an HP delta happens (any prevented / blocked
    // damage doesn't trigger — that's by design, the pulse is the
    // visual cue that damage actually got through).
    const hpPulse = (side) => {
      const sel = side === 'ai' ? '.ai-bar .health-bar' : '.player-bar .health-bar';
      const bar = document.querySelector(sel);
      if (!bar) return;
      // Re-trigger pattern: remove the class, force reflow, re-add.
      // Without the reflow, sequential damage in the same frame
      // wouldn't restart the keyframes.
      bar.classList.remove('hp-pulse');
      void bar.offsetWidth;
      bar.classList.add('hp-pulse');
      // Class lives 940ms — 40ms grace past the 900ms CSS animation
      // so the keyframe completes before the class is stripped (and
      // a subsequent quick re-trigger gets a clean restart).
      setTimeout(() => bar.classList.remove('hp-pulse'), 940);
    };
    if (Game.damagePlayer) {
      const origDmg = Game.damagePlayer.bind(Game);
      Game.damagePlayer = (target, amount, ...rest) => {
        const before = (Game.state && Game.state[target]) ? Game.state[target].health : null;
        const r = origDmg(target, amount, ...rest);
        const after  = (Game.state && Game.state[target]) ? Game.state[target].health : null;
        if (before != null && after != null && after < before) hpPulse(target);
        return r;
      };
    }
  },

  // ========================================================================
  // POLISH LAYER (Tier 1-4) — reactive + ambient effects on top of the
  // existing tron interaction language. All 14 effects hooked from one
  // place; each is independent so disabling one doesn't break the others.
  // Called once from UI.init alongside installTronGridFx.
  // ========================================================================
  installPolishLayer() {
    if (this._polishLayerInstalled) return;
    this._polishLayerInstalled = true;
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---- T1.1 ATTACK RIBBON --------------------------------------------
    // SVG beam from attacker → target. Hooks Game.applyCombatDamage so
    // every swing spawns a beam. The beam's color matches the attacker's
    // owner side (cyan player, red AI). When the swing is blocked/evaded,
    // the beam still fires (so the player sees who attacked whom), and
    // the deflection arc fires on top via the block hook below.
    const ensureRibbonSvg = () => {
      let svg = document.getElementById('attack-ribbon-layer');
      if (svg) return svg;
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'attack-ribbon-layer';
      svg.setAttribute('class', 'attack-ribbon-svg');
      document.body.appendChild(svg);
      return svg;
    };
    const cardRect = (card) => {
      if (!card || card.id == null) return null;
      const el = document.querySelector(`[data-card-id="${card.id}"]`);
      return el ? el.getBoundingClientRect() : null;
    };
    const spawnAttackRibbon = (attacker, target) => {
      if (reduceMotion) return;
      const a = cardRect(attacker);
      const t = cardRect(target);
      if (!a || !t) return;
      const svg = ensureRibbonSvg();
      const ax = a.left + a.width / 2;
      const ay = a.top  + a.height / 2;
      const tx = t.left + t.width / 2;
      const ty = t.top  + t.height / 2;
      // Quadratic bezier with the control point pulled slightly off the
      // straight line — gives the beam a subtle arc instead of a flat
      // segment, reads as "current bending across space."
      const cx = (ax + tx) / 2 + (ty - ay) * 0.08;
      const cy = (ay + ty) / 2 + (ax - tx) * 0.08;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const aiSide = attacker.owner === 'ai';
      path.setAttribute('class', 'attack-ribbon-path' + (aiSide ? ' ribbon-ai' : ''));
      path.setAttribute('d', `M ${ax} ${ay} Q ${cx} ${cy} ${tx} ${ty}`);
      svg.appendChild(path);
      // Compute true path length so the dash animation traces accurately.
      try {
        const len = path.getTotalLength();
        path.style.setProperty('--ribbon-len', len);
        path.style.strokeDasharray = String(len);
        path.style.strokeDashoffset = String(len);
      } catch (e) { /* getTotalLength can throw on edge cases */ }
      // Impact dot at the target — fires after the ribbon arrives (CSS
      // animation-delay takes care of timing).
      const dot = document.createElement('div');
      dot.className = 'attack-ribbon-impact' + (aiSide ? ' impact-ai' : '');
      dot.style.left = tx + 'px';
      dot.style.top  = ty + 'px';
      document.body.appendChild(dot);
      // Cleanup once the full timeline is done.
      setTimeout(() => { try { path.remove(); dot.remove(); } catch (e) {} }, 600);
    };

    // ---- T1.4 BLOCK DEFLECTION ARC -------------------------------------
    // When a swing is blocked / evaded / damage-immune, spawn an
    // expanding ring at the BLOCKER's location. Color depends on the
    // prevention type: cyan for evade/block, gold for invincible.
    const spawnDeflectArc = (target, kind) => {
      if (reduceMotion) return;
      const r = cardRect(target);
      if (!r) return;
      const arc = document.createElement('div');
      arc.className = 'block-deflect-arc ' + (kind === 'invincible' ? 'deflect-gold' : 'deflect-cyan');
      arc.style.left = (r.left + r.width / 2)  + 'px';
      arc.style.top  = (r.top  + r.height / 2) + 'px';
      document.body.appendChild(arc);
      setTimeout(() => arc.remove(), 460);
    };

    if (Game.applyCombatDamage) {
      const origCombat = Game.applyCombatDamage.bind(Game);
      Game.applyCombatDamage = (attacker, target, opts) => {
        // Spawn the ribbon BEFORE the engine call so the visible beam
        // travels alongside the damage application.
        spawnAttackRibbon(attacker, target);
        // Detect prevention by snapshotting the target's defensive
        // state pre-call; if it triggers a block path, fire deflection.
        const preEvade = target && target.evadeCharges;
        const preInv   = target && target.invincibleTurns;
        const preImm   = target && target.hasDamageImmunity;
        const r = origCombat(attacker, target, opts);
        // Was the swing prevented? (return value false + nothing died)
        if (r === false && target && target.currentHealth > 0) {
          if (preEvade > 0 && (target.evadeCharges < preEvade)) {
            spawnDeflectArc(target, 'evade');
          } else if (preInv > 0 || preImm) {
            spawnDeflectArc(target, 'invincible');
          } else {
            spawnDeflectArc(target, 'block');
          }
        }
        return r;
      };
    }

    // ---- T1.2 CARD DEREZ ON DEATH --------------------------------------
    // Hook Game.handleDeath. Capture the dying card's DOM rect BEFORE
    // the engine processes the death (the DOM element is about to be
    // removed by the next render). Spawn a 5×7 grid of fragments.
    // Tron cubic derez — rebuilt from a flat 5×7 fragment scatter
    // into a proper 3D cubic disintegration with scan-line wave
    // propagation. See the "TRON CUBIC DEREZ" CSS section for the
    // full visual reasoning. Per user spec: "kinda like the health
    // bar" — i.e. wave-of-light propagation, not all-at-once burst.
    //
    // Sequence:
    //   1. Pre-flash original card (80ms brightness boost)
    //   2. Spawn perspective container + scan line + 30 cubes
    //   3. Scan line sweeps top→bottom over ~250ms
    //   4. Each cube's animation-delay = (row_index / row_count) ×
    //      scan_duration, so cubes pop AS the scan line passes
    //   5. Each cube scatters in 3D for 550ms with randomized
    //      translate3d + rotateX/Y/Z + scale-down + opacity fade
    //   6. Container removed at total + grace
    //
    // Total animation budget: 250ms scan + 550ms scatter = 800ms.
    // Last cube starts at delay 250ms and finishes at 800ms.
    const spawnDerez = (card) => {
      if (reduceMotion) return;
      const r = cardRect(card);
      if (!r) return;
      const aiSide = card.owner === 'ai';
      // Pre-flash on the original card. Brief brightness boost
      // before it's replaced by cubes — cues the eye that something
      // is happening at this position.
      const cardEl = document.querySelector(`[data-card-id="${card.id}"]`);
      if (cardEl) {
        cardEl.classList.add('card-pre-derez');
        // The class is removed naturally when renderBoard rebuilds
        // the lane DOM (which fires from the engine's death
        // bookkeeping); no explicit cleanup needed.
      }

      // Perspective container, sized to match the card's rect.
      const container = document.createElement('div');
      container.className = 'tron-derez' + (aiSide ? ' derez-ai' : '');
      container.style.left   = r.left   + 'px';
      container.style.top    = r.top    + 'px';
      container.style.width  = r.width  + 'px';
      container.style.height = r.height + 'px';
      document.body.appendChild(container);

      // Scan-line element — sweeps top→bottom inside the container.
      const scan = document.createElement('div');
      scan.className = 'tron-derez-scanline';
      container.appendChild(scan);

      // Cube grid. 5 cols × 6 rows = 30 cubes — chunky enough to
      // read as discrete data blocks, dense enough to feel like
      // disintegration not just chunks falling off.
      const COLS = 5, ROWS = 6;
      const SCAN_MS = 250;       // matches CSS scanline duration
      const fw = r.width  / COLS;
      const fh = r.height / ROWS;
      // Center reference for outward-radial scatter — cubes near the
      // card's center scatter LESS than cubes near the edge so the
      // explosion has volumetric weight (center pieces stay near,
      // edge pieces fly outward).
      const centerX = r.width  / 2;
      const centerY = r.height / 2;
      for (let cy = 0; cy < ROWS; cy++) {
        for (let cx = 0; cx < COLS; cx++) {
          const cube = document.createElement('div');
          cube.className = 'tron-derez-cube';
          // Position relative to the container (left/top in container coords)
          cube.style.left   = (cx * fw) + 'px';
          cube.style.top    = (cy * fh) + 'px';
          cube.style.width  = fw + 'px';
          cube.style.height = fh + 'px';

          // Outward-radial unit vector from card center to cube center
          const cubeCx = cx * fw + fw / 2;
          const cubeCy = cy * fh + fh / 2;
          const ox = cubeCx - centerX;
          const oy = cubeCy - centerY;
          const olen = Math.hypot(ox, oy) || 1;
          const ux = ox / olen;
          const uy = oy / olen;

          // Scatter distance: bias outward but with random component
          // so the cubes don't all fly along clean radii. Edge cubes
          // (high olen) fly further than center cubes.
          const baseDist = 30 + (olen / Math.max(centerX, centerY)) * 50;
          const dist = baseDist + Math.random() * 25;
          const dx = ux * dist + (Math.random() - 0.5) * 20;
          // Directional bias by side — user report: "when enemies die
          // their death animation is going DOWN like ally deaths, but
          // it should go UP since they're on the top half of the
          // board." So we add a strong vertical bias along the side's
          // outward direction:
          //   AI cards   → bias UP (cubes fly off the top of the board)
          //   Ally cards → bias DOWN (cubes fly off the bottom)
          // 55-90px range is enough to clearly direct the explosion's
          // mass without overpowering the radial scatter (which still
          // gives the cubes their volumetric spray).
          const sideBias = aiSide ? -1 : 1;
          const sideBoost = (55 + Math.random() * 35) * sideBias;
          const dy = uy * dist + (Math.random() - 0.5) * 20 + sideBoost;
          // Z scatter — cubes spray FORWARD (toward viewer) and back
          // randomly for depth. Small range — too much z and the
          // perspective gets flat.
          const dz = (Math.random() - 0.5) * 80;

          // 3D rotations — full ±360° on each axis so cubes tumble
          // through space. The eye reads this as cubic geometry
          // tumbling, even though each cube is technically a 2D quad.
          const rx = (Math.random() * 720 - 360);
          const ry = (Math.random() * 720 - 360);
          const rz = (Math.random() * 360 - 180);

          // Final scale — cubes shrink as they disperse, never
          // entirely disappear (CSS opacity handles the fade).
          const endScale = 0.25 + Math.random() * 0.30;

          cube.style.setProperty('--dx', dx.toFixed(1) + 'px');
          cube.style.setProperty('--dy', dy.toFixed(1) + 'px');
          cube.style.setProperty('--dz', dz.toFixed(1) + 'px');
          cube.style.setProperty('--rx', rx.toFixed(1) + 'deg');
          cube.style.setProperty('--ry', ry.toFixed(1) + 'deg');
          cube.style.setProperty('--rz', rz.toFixed(1) + 'deg');
          cube.style.setProperty('--end-scale', endScale.toFixed(2));

          // Animation delay tied to ROW position so the scan line
          // appears to be "lighting up" cubes as it passes them.
          // Player side: top→bottom (row 0 fires first). AI side:
          // bottom→top (last row fires first) so it matches the
          // upward scanline + upward cube scatter. Adds a tiny
          // per-column jitter (±15ms) so adjacent cubes don't tick
          // at the same frame (reads more organic).
          const rowProgress = aiSide
            ? (ROWS - 1 - cy) / Math.max(1, ROWS - 1)
            : cy / Math.max(1, ROWS - 1);
          const rowDelay = rowProgress * SCAN_MS;
          const colJitter = (Math.random() - 0.5) * 30;
          cube.style.animationDelay = Math.max(0, rowDelay + colJitter) + 'ms';

          container.appendChild(cube);
        }
      }

      // Cleanup at 850ms (250 scan + 550 scatter + 50 grace).
      setTimeout(() => container.remove(), 850);
    };

    if (Game.handleDeath) {
      const origDeath = Game.handleDeath.bind(Game);
      Game.handleDeath = (card, laneIdx, killer) => {
        spawnDerez(card);  // capture rect BEFORE engine teardown
        return origDeath(card, laneIdx, killer);
      };
    }

    // ---- T1.3 CRITICAL FLASH + SHAKE -----------------------------------
    // Fires when face damage to a player is ≥5 OR brings HP to 0.
    // Two-layer: white screen flash + brief 4px shake on game-area.
    const ensureCritFlash = () => {
      let el = document.getElementById('critical-flash-overlay');
      if (el) return el;
      el = document.createElement('div');
      el.id = 'critical-flash-overlay';
      document.body.appendChild(el);
      return el;
    };
    const fireCritFlash = (lethal) => {
      if (reduceMotion) return;
      const f = ensureCritFlash();
      f.classList.remove('flash-fire');
      void f.offsetWidth;
      f.classList.add('flash-fire');
      setTimeout(() => f.classList.remove('flash-fire'), 240);
      const ga = document.getElementById('game-area');
      if (ga) {
        ga.classList.remove('crit-shake');
        void ga.offsetWidth;
        ga.classList.add('crit-shake');
        setTimeout(() => ga.classList.remove('crit-shake'), 240);
      }
    };
    // Hook damagePlayer to detect critical/lethal damage.
    if (Game.damagePlayer) {
      const origCrit = Game.damagePlayer.bind(Game);
      Game.damagePlayer = (target, amount, ...rest) => {
        const before = (Game.state && Game.state[target]) ? Game.state[target].health : null;
        const r = origCrit(target, amount, ...rest);
        const after = (Game.state && Game.state[target]) ? Game.state[target].health : null;
        if (before != null && after != null) {
          const delta = before - after;
          const lethal = (after === 0 && before > 0);
          if (delta >= 5 || lethal) fireCritFlash(lethal);
        }
        return r;
      };
    }

    // ---- T2.1 HP TICK-DOWN ---------------------------------------------
    // Animate the HP NUMBER counting down (the bar width already
    // tweens via CSS transition). We patch the textContent updates
    // for #player-health and #ai-health so every change tweens
    // through the intermediate values. ~600ms for big drops; shorter
    // for small ones.
    this._hpTickPrev = { player: null, ai: null };
    this._hpTickRaf = { player: null, ai: null };
    const tickHp = (id, side, target) => {
      const el = document.getElementById(id);
      if (!el) return;
      const startVal = this._hpTickPrev[side];
      const endVal = target;
      if (startVal == null || startVal === endVal || reduceMotion) {
        el.textContent = String(endVal);
        this._hpTickPrev[side] = endVal;
        return;
      }
      // Cancel prior tween if still running
      if (this._hpTickRaf[side]) cancelAnimationFrame(this._hpTickRaf[side]);
      const t0 = performance.now();
      const dur = Math.min(800, Math.max(280, Math.abs(endVal - startVal) * 60));
      const step = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        // Ease out cubic
        const eased = 1 - Math.pow(1 - p, 3);
        const cur = Math.round(startVal + (endVal - startVal) * eased);
        el.textContent = String(cur);
        if (p < 1) {
          this._hpTickRaf[side] = requestAnimationFrame(step);
        } else {
          this._hpTickRaf[side] = null;
          this._hpTickPrev[side] = endVal;
        }
      };
      this._hpTickRaf[side] = requestAnimationFrame(step);
    };
    // Patch the existing textContent setters by intercepting at render
    // time. The render() method sets player-health / ai-health text
    // directly — wrap that with the tween.
    const origRender = this.render.bind(this);
    this.render = function(...args) {
      const r = origRender(...args);
      if (Game.state) {
        tickHp('player-health', 'player', Math.max(0, Game.state.player.health));
        tickHp('ai-health',     'ai',     Math.max(0, Game.state.ai.health));
      }
      return r;
    };

    // ---- T2.2 ENERGY POUR ----------------------------------------------
    // Detect energy delta in render(); if the displayed value changed,
    // class the energy element with energy-fill (gain) or energy-drain
    // (spend). The CSS animation handles the visual.
    this._energyPrev = { player: null, ai: null };
    const flashEnergy = (sel, side, target) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const prev = this._energyPrev[side];
      this._energyPrev[side] = target;
      if (prev == null || prev === target || reduceMotion) return;
      const cls = target > prev ? 'energy-fill' : 'energy-drain';
      el.classList.remove('energy-fill', 'energy-drain');
      void el.offsetWidth;
      el.classList.add(cls);
      setTimeout(() => el.classList.remove(cls), 460);
    };
    const origRender2 = this.render.bind(this);
    this.render = function(...args) {
      const r = origRender2(...args);
      if (Game.state) {
        flashEnergy('.player-bar .energy-text', 'player', Game.state.player.currency);
        flashEnergy('.ai-bar .energy-text',     'ai',     Game.state.ai.currency);
      }
      return r;
    };

    // ---- T2.3 BLOCK METER LIQUID — REMOVED ----
    // (See block above; one-time DOM cleanup for sessions loaded
    //  with the old build.)
    document.querySelectorAll('.block-circle .block-liquid-fill').forEach(el => el.remove());

    // One-time cleanup: earlier builds tagged .hud-pill-main, .hud-round,
    // .hud-count* with .tron-perimeter, which hijacked their ::after
    // pseudo (used by the deck/tricks card-stack icons). Strip any
    // leftover .tron-perimeter / .tron-fx-breathe / .tron-sweep on
    // those HUD elements so users coming from the old build see the
    // icons restored on first paint without needing to reload twice. */
    [
      '.hud-pill-main', '.hud-pill', '.hud-round', '.hud-count',
      '.hud-count-deck', '.hud-count-tricks'
    ].forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        el.classList.remove('tron-perimeter', 'tron-perimeter-slow', 'tron-perimeter-card', 'tron-fx-breathe');
        el.querySelectorAll(':scope > .tron-sweep').forEach(s => s.remove());
      });
    });

    // ---- T2.4 PHASE BANNER TYPE-ON -------------------------------------
    // Wrap showPhaseBanner so the banner text types on instead of
    // appearing as a unit. Keep existing banner timing; just stagger
    // the character reveal across the first ~25ms × len.
    if (this.showPhaseBanner) {
      const origShow = this.showPhaseBanner.bind(this);
      this.showPhaseBanner = (text, opts) => {
        const r = origShow(text, opts);
        if (reduceMotion) return r;
        const el = this.phaseBannerText;
        if (!el || !text) return r;
        // The original rendered the full text via innerHTML. Replace
        // with progressive reveal: hide all letter spans except the
        // first N, increment N every 25ms.
        const letterEls = Array.from(el.querySelectorAll('.phase-letter'));
        if (!letterEls.length) return r;
        // Hide all initially
        letterEls.forEach(le => le.style.opacity = '0');
        el.classList.add('typing');
        let i = 0;
        const reveal = () => {
          if (i >= letterEls.length) {
            el.classList.remove('typing');
            return;
          }
          letterEls[i].style.opacity = '1';
          i++;
          setTimeout(reveal, 22);
        };
        reveal();
        return r;
      };
    }

    // ---- T3.1 HOVER PARALLAX TILT --------------------------------------
    // (Legacy hand-section listener removed — installHandTilt() at line
    // ~14284 owns this now. The legacy version set --tilt-x/y *with*
    // 'deg' suffix on the .card itself, which conflicts with the newer
    // unitless var on the wrapper: when both fired, the card's own
    // var won inheritance and turned `calc(var(--tilt-x) * 6deg)` into
    // `calc(-3.2deg * 6deg)` — invalid (can't multiply two angles), so
    // the calc fell back to 0 and the tilt silently vanished.)

    // ---- T3.3 FORESEE PEEK X-RAY ---------------------------------------
    // Helper exposed as UI.applyForeseeXray(els) for ability code or
    // ad-hoc renders. Doesn't auto-detect peeks (would require deep
    // engine integration); instead callers tag the peeked card
    // elements when they show them.
    this.applyForeseeXray = (selectorOrEls) => {
      let list;
      if (typeof selectorOrEls === 'string') list = document.querySelectorAll(selectorOrEls);
      else if (selectorOrEls && selectorOrEls.length != null) list = selectorOrEls;
      else if (selectorOrEls) list = [selectorOrEls];
      else return;
      Array.from(list).forEach(el => el.classList.add('foresee-xray'));
    };

    // ---- T4.1 REACTIVE PLAYFIELD CHARGE --------------------------------
    // Watch state.selectedCard each render; if it's a high-cost card
    // (≥8), charge the playfield. Drops back when deselected or
    // played.
    const origRender4 = this.render.bind(this);
    this.render = function(...args) {
      const r = origRender4(...args);
      const ga = document.getElementById('game-area');
      if (!ga) return r;
      const sel = Game.state && Game.state.selectedCard;
      const charged = sel && (sel.cost || sel.baseCost || 0) >= 8;
      ga.classList.toggle('charged', !!charged);
      return r;
    };

    // ---- T4.2 BACKGROUND GRID PARALLAX ---------------------------------
    // Throttled mousemove on document — set body.style.--grid-px-x/y
    // based on cursor position normalized to viewport. Subtle ±6px
    // shift gives a mild parallax depth cue without being distracting.
    if (!reduceMotion) {
      let lastMove = 0;
      document.addEventListener('mousemove', (e) => {
        const now = performance.now();
        if (now - lastMove < 30) return;
        lastMove = now;
        const xN = (e.clientX / window.innerWidth)  - 0.5;
        const yN = (e.clientY / window.innerHeight) - 0.5;
        document.body.style.setProperty('--grid-px-x', (-xN * 12) + 'px');
        document.body.style.setProperty('--grid-px-y', (-yN * 12) + 'px');
      }, { passive: true });
    }

    // ---- T4.3 END-OF-ROUND ECHO ----------------------------------------
    // Fires when startRound runs (i.e. AFTER the previous round's
    // combat fully resolved). Spawns a single soft ring expanding
    // from the board's center.
    const spawnRoundEcho = () => {
      if (reduceMotion) return;
      const board = document.getElementById('board');
      if (!board) return;
      const ring = document.createElement('div');
      ring.className = 'round-echo-ring';
      board.appendChild(ring);
      setTimeout(() => ring.remove(), 880);
    };
    // Round transition punctuation — the previous code only fired a
    // soft ring echo. Audit finding: "round changes feel like a
    // continuous trickle, not a clear beat." Adds a brief board
    // desaturate→resaturate pulse + soft tick SFX so each round-start
    // reads as a real boundary.
    const punctuateRound = () => {
      if (reduceMotion) return;
      const board = document.getElementById('board');
      if (!board) return;
      board.classList.remove('board-round-pulse');
      void board.offsetWidth;
      board.classList.add('board-round-pulse');
      setTimeout(() => board.classList.remove('board-round-pulse'), 480);
      // Subtle tick — same family as 'select' but lower / quieter.
      if (this.sfx && this.sfx._init && this.sfx._init()) {
        try {
          this.sfx._tone({ type: 'sine', freq: 440, dur: 0.06, gain: 0.06, attack: 0.003, release: 0.10 });
          this.sfx._tone({ type: 'sine', freq: 660, dur: 0.05, gain: 0.04, attack: 0.003, release: 0.08, delay: 0.025 });
        } catch (e) {}
      }
    };
    if (Game.startRound) {
      const origRound = Game.startRound.bind(Game);
      Game.startRound = (...rest) => {
        const r = origRound(...rest);
        // Skip the echo on the very first round (round 1) — there's
        // no previous round to "echo from."
        if (Game.state && Game.state.round && Game.state.round > 1) {
          spawnRoundEcho();
          punctuateRound();
        }
        return r;
      };
    }

    // ====================================================================
    // PHYSICALITY UPGRADE — push the polish from "30%" feel toward "50%."
    // Spring physics, anticipation/follow-through, coupled responses,
    // landing particles, velocity-aware cursor trail.
    // The unifying idea: make every motion feel like it has WEIGHT,
    // MOMENTUM, and AWARENESS of the system around it.
    // ====================================================================

    // ---- (1) HAND CARD SPRING HOVER --------------------------------------
    // Replace the CSS-transition-driven translateY(-8px) lift with a
    // RAF-driven critically-damped spring. Springs naturally have:
    //   • velocity continuity — no instant changes in motion
    //   • overshoot/undershoot — the way real masses settle
    //   • frame-rate independence — works at 60/120/240Hz
    // Spring params chosen to be just barely under-damped (~0.85
    // damping coefficient) so the card rises with a gentle hint of
    // overshoot, then settles. Not so springy that it feels gummy.
    if (!reduceMotion) {
      const handSection = document.querySelector('.player-hand-section');
      if (handSection) {
        // Per-card spring state stored on the element itself so multiple
        // cards can be in different lift positions without interference.
        const SPRING_STIFFNESS = 280;   // higher = faster pull to target
        const SPRING_DAMPING   = 22;    // critical damping ≈ 2*sqrt(stiffness*mass)
        const SPRING_MASS      = 1;
        const HOVER_LIFT_PX    = -8;    // target Y when hovered
        const startSpring = (card) => {
          if (card._springRaf) return;
          const tick = () => {
            const target = card._springTarget || 0;
            const cur    = card._springY    || 0;
            const vel    = card._springVel  || 0;
            // Spring force: F = -k*(x - target) - c*v
            const force = -SPRING_STIFFNESS * (cur - target) - SPRING_DAMPING * vel;
            const accel = force / SPRING_MASS;
            const dt    = 1 / 60;       // assume 60Hz step
            const newVel = vel + accel * dt;
            const newY   = cur + newVel * dt;
            card._springVel = newVel;
            card._springY   = newY;
            // Apply via translate3d (forces GPU layer = sub-pixel + smooth)
            card.style.transform = `translate3d(0, ${newY.toFixed(2)}px, 0)`;
            // Stop when settled
            if (Math.abs(newVel) < 0.05 && Math.abs(newY - target) < 0.05) {
              card.style.transform = `translate3d(0, ${target.toFixed(2)}px, 0)`;
              card._springRaf = null;
              card._springVel = 0;
              card._springY   = target;
              return;
            }
            card._springRaf = requestAnimationFrame(tick);
          };
          card._springRaf = requestAnimationFrame(tick);
        };
        handSection.addEventListener('mouseenter', (e) => {
          const card = e.target.closest('.hand-cards .card');
          if (!card) return;
          card._springTarget = HOVER_LIFT_PX;
          startSpring(card);
        }, true);  // capture for shadow children
        handSection.addEventListener('mouseleave', (e) => {
          const card = e.target.closest('.hand-cards .card');
          if (!card) return;
          card._springTarget = 0;
          startSpring(card);
        }, true);
      }
    }

    // ---- (2) ANTICIPATION DIP BEFORE CARD FLIGHT -------------------------
    // Real motion has WINDUP. A baseball pitcher rocks back before
    // throwing; a card "compresses" before launching from your hand.
    // We add a 90ms downward dip on the card before Game.playCard
    // commits, then the existing FLIP flight launches from the
    // depressed position. Subtle (~3px) but adds tangible weight.
    if (Game.playCard) {
      const origPlay = Game.playCard.bind(Game);
      Game.playCard = (owner, card, laneIdx, ...rest) => {
        // Player-side only; AI plays don't need anticipation since
        // the player isn't directing them physically.
        if (!reduceMotion && owner === 'player' && card && card.id != null) {
          const handCardEl = document.querySelector(`.player-hand-section .card[data-card-id="${card.id}"]`);
          if (handCardEl) {
            handCardEl.classList.add('card-anticipating');
            // The CSS transition for translateY runs the dip; we
            // remove the class after the flight starts so it doesn't
            // persist on the lane card.
            setTimeout(() => handCardEl.classList.remove('card-anticipating'), 200);
          }
        }
        return origPlay(owner, card, laneIdx, ...rest);
      };
    }

    // ---- (3) LANE RECEPTIVE CUE — visual anticipation -------------------
    // When the player grabs a card from hand (state.selectedCard
    // is set), the EMPTY lanes that could legally receive it get
    // a subtle cyan glow. The system "reads" the player's intent
    // before they commit, which is one of the strongest polish
    // signals — UI feels like it's leaning in to help.
    const updateLaneReceptive = () => {
      const sel = Game.state && Game.state.selectedCard;
      const lanes = document.querySelectorAll('.board > .lane');
      lanes.forEach((laneEl, i) => {
        const isEmpty = Game.state &&
                        Game.state.lanes[i] &&
                        !Game.state.lanes[i].player &&
                        !Game.state.lanes[i].destroyed;
        const receptive = sel && isEmpty;
        laneEl.classList.toggle('lane-receptive', !!receptive);
      });
    };
    // Hook the render path so the receptive class flips whenever
    // selectedCard or board occupancy changes.
    const origRender5 = this.render.bind(this);
    this.render = function(...args) {
      const r = origRender5(...args);
      updateLaneReceptive();
      return r;
    };

    // ---- (4) LANDING PARTICLE BURST --------------------------------------
    // When the card flight ghost completes its arc and the real card
    // becomes visible in the lane, spawn 6-8 small cyan motes that
    // scatter outward from the lane's center for ~500ms. Reads as
    // "the card landed and disturbed the medium" — an impact accent
    // that the lane wash bloom alone can't carry on its own.
    const spawnLandingBurst = (laneEl, owner) => {
      if (reduceMotion || !laneEl) return;
      const r = laneEl.getBoundingClientRect();
      // Origin near the slot the card landed in (top half for AI,
      // bottom half for player) so the burst feels anchored to the card.
      const cx = r.left + r.width / 2;
      const cy = owner === 'ai' ? r.top + r.height * 0.3 : r.top + r.height * 0.7;
      const aiSide = owner === 'ai';
      const N = 7;
      for (let i = 0; i < N; i++) {
        const ang  = (Math.PI * 2 * i / N) + (Math.random() - 0.5) * 0.4;
        const dist = 28 + Math.random() * 22;
        const dx   = Math.cos(ang) * dist;
        const dy   = Math.sin(ang) * dist;
        const mote = document.createElement('div');
        mote.className = 'landing-mote' + (aiSide ? ' mote-ai' : '');
        mote.style.left = cx + 'px';
        mote.style.top  = cy + 'px';
        mote.style.setProperty('--dx', dx + 'px');
        mote.style.setProperty('--dy', dy + 'px');
        document.body.appendChild(mote);
        setTimeout(() => mote.remove(), 620);
      }
    };
    // Hook into _animateFly's settle moment via the existing
    // setTimeout cleanup. We patch _animateFly so when it wraps up,
    // the burst fires at the lane the ghost arrived at.
    if (typeof this._animateFly === 'function' && !this._burstHooked) {
      this._burstHooked = true;
      const origAnimFly = this._animateFly.bind(this);
      this._animateFly = (realEl, fromRect) => {
        const r = origAnimFly(realEl, fromRect);
        // Lookup the lane element this card landed in
        const lane = realEl.closest('.lane');
        const ownerSide = realEl.classList.contains('ai-card') ? 'ai' : 'player';
        // Burst fires at the IMPACT moment of the new two-stage flight
        // (end of stage A = 660ms). That's when the card has reached
        // the lane at its peak overshoot scale, just before it settles
        // back to 1.0 in stage B. Firing the particles HERE — instead
        // of near the old 870ms cleanup tail — pairs the visual thud
        // with the actual landing instead of trailing it.
        setTimeout(() => spawnLandingBurst(lane, ownerSide), 660);
        return r;
      };
    }

    // ---- (5) VELOCITY-AWARE CURSOR TRAIL ---------------------------------
    // The trail's stroke thickness now scales with cursor speed.
    // Slow movement → thin (1px), fast slashes → thick (3px). This
    // is one of those details that you don't consciously notice
    // but reads as "the cursor has weight" subliminally.
    // We compute speed from buffer samples each frame.
    if (!reduceMotion) {
      // The buffer + tick already exist in the cursor-trail block
      // above; rather than duplicate, we hook a velocity calc into
      // the existing path-update loop via a CSS variable on the
      // SVG layer. The CSS reads `--trail-velocity` to scale stroke.
      // This avoids re-architecting the existing tick.
      const svg = document.getElementById('tron-cursor-trail');
      if (svg) {
        // Light shim — install a separate RAF loop that polls the
        // global mouse-position via captured events and writes the
        // velocity into a CSS var. Deliberately separate from the
        // path-update loop so it can be retuned independently.
        let lastX = -1, lastY = -1, lastT = 0;
        let smoothedSpeed = 0;
        const SPEED_ALPHA = 0.18;        // EMA smoothing
        const SPEED_TO_THICKNESS = 0.012; // px-per-pixel-per-second
        const MIN_THICK = 1.0;
        const MAX_THICK = 3.4;
        document.addEventListener('mousemove', (e) => {
          const now = performance.now();
          if (lastX >= 0) {
            const dt = (now - lastT) / 1000;
            if (dt > 0) {
              const dist = Math.hypot(e.clientX - lastX, e.clientY - lastY);
              const inst = dist / dt;  // px per second
              smoothedSpeed = SPEED_ALPHA * inst + (1 - SPEED_ALPHA) * smoothedSpeed;
            }
          }
          lastX = e.clientX; lastY = e.clientY; lastT = now;
          const thick = Math.max(MIN_THICK, Math.min(MAX_THICK,
            MIN_THICK + smoothedSpeed * SPEED_TO_THICKNESS));
          svg.style.setProperty('--trail-thick', thick.toFixed(2) + 'px');
        }, { passive: true });
        // Decay the speed toward 0 when cursor stops, so trail thins
        // smoothly instead of holding the last fast-motion thickness.
        const decay = () => {
          smoothedSpeed *= 0.92;
          const thick = Math.max(MIN_THICK, Math.min(MAX_THICK,
            MIN_THICK + smoothedSpeed * SPEED_TO_THICKNESS));
          svg.style.setProperty('--trail-thick', thick.toFixed(2) + 'px');
          requestAnimationFrame(decay);
        };
        requestAnimationFrame(decay);
      }
    }

    // ---- (6) UNIVERSAL CLICK FEEDBACK -----------------------------------
    // Delegated mousedown listener fires a click cue + haptic on
    // EVERY interactive press, so no surface in the app is ever
    // silent on press. Uses mousedown (not click) so the feedback
    // happens at the start of the interaction — sub-50ms perception.
    // Excludes:
    //   • cards in hand (handled by onCardClick with its own select cue)
    //   • the cursor trail SVG
    //   • elements inside scrollable lists where clicks aren't actions
    const FEEDBACK_SELECTORS = [
      '.tron-fx',
      '.btn',
      '.mm-option', '.mode-option',
      '.draft-card', '.draft-quit-btn', '.draft-mulligan-btn', '.draft-settings-btn',
      '.db-tab', '.db-cost-chip', '.db-preset',
      '.db-save-btn', '.db-load-btn', '.db-share-btn', '.db-import-btn',
      '.db-start-btn', '.db-delete-btn',
      '.mp-tab', '.mp-cta', '.mp-leave',
      '.md-deck-card', '.md-deck-action',
      '.settings-cog',
      '.viewport-toggle',
      '.mh-clear-btn', '.md-back'
    ];
    const FEEDBACK_SEL = FEEDBACK_SELECTORS.join(', ');
    document.addEventListener('mousedown', (e) => {
      // Walk up from the target to find any matching surface
      const target = e.target.closest(FEEDBACK_SEL);
      if (!target) return;
      // Skip disabled / aria-disabled
      if (target.disabled || target.getAttribute('aria-disabled') === 'true') return;
      // Skip cards in hand — they have their own select-cue path
      if (target.classList.contains('card') && target.closest('.player-hand-section')) return;
      // Audio + haptic
      this._playClickCue();
      if (this._haptic) this._haptic('cardPlay');
      // Spark particle burst at the click point
      this._spawnClickSparks(e.clientX, e.clientY, 4);
    }, { passive: true });

    // Disabled-button blocked-press feedback — when the user clicks
    // a button that's currently disabled, fire the reject cue so
    // they know the click registered but was blocked. Without this,
    // disabled buttons feel "broken."
    document.addEventListener('mousedown', (e) => {
      const target = e.target.closest(FEEDBACK_SEL);
      if (!target) return;
      const isDisabled =
        target.disabled ||
        target.getAttribute('aria-disabled') === 'true' ||
        target.classList.contains('mode-option-disabled') ||
        target.classList.contains('db-start-btn-disabled');
      if (!isDisabled) return;
      this._playRejectCue();
      if (this._haptic) this._haptic('block');
    }, { passive: true });
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
        try { if (A && A.arenaHumStop) A.arenaHumStop(); } catch (e) {}
      } else if (s && !s.gameOver) {
        // Reset the latch when a new game starts.
        this._gameOverCued = false;
      }
      return r;
    };
  },

  // Install hook — monkey-patch Game.drawCards so every successful
  // draw spawns the flying ghost cards. Uses hand-size deltas to
  // count how many cards ACTUALLY landed (draws can be blocked by
  // Lex Luthor's preventDraw, empty pile, max-hand-size, etc.).
  installDrawAnimation() {
    if (this._drawAnimInstalled) return;
    this._drawAnimInstalled = true;
    if (typeof Game === 'undefined' || !Game.drawCards) return;
    const orig = Game.drawCards.bind(Game);
    Game.drawCards = (owner, count) => {
      const before = Game.state && Game.state[owner] ? (Game.state[owner].hand || []).length : 0;
      const r = orig(owner, count);
      const after  = Game.state && Game.state[owner] ? (Game.state[owner].hand || []).length : before;
      const actual = Math.max(0, after - before);
      if (actual > 0) this._animateCardDraw(owner, actual);
      return r;
    };
  },

  // Animated deck draw — spawn ghost cards that fly from the HUD
  // deck indicator to the player's hand row. Fires per drawn card
  // with a small stagger so multi-draws read as a sequence. AI-side
  // draws use the AI bar position (if we can find one), or fall back
  // to the top-center of the board if there isn't an AI hand element.
  _animateCardDraw(owner, count) {
    if (!count || count <= 0) return;
    if (this._reducedMotion && this._reducedMotion()) return;
    // Skip the deck-to-hand ghost-card flight while the boot
    // sequence is running. The boot's hand-card stagger is its own
    // entrance animation; layering the ghost flight on top crowds
    // the moment and clobbers the staged reveal. User report: "when
    // a card goes from deck into hand, that animation is happening
    // too. It kinda takes away from the boot up card sequence."
    if (document.body.classList.contains('boot-sequence')) return;
    // ALSO skip on round 1 — the boot sequence fires AFTER drawCards
    // runs (during startRound's first call) so the boot-sequence
    // class isn't on body yet at this point. The cards should just
    // appear as part of the boot's hand-card stagger; no ghost
    // flight from the deck pip needed for the initial fill. User
    // report: "the cards should just be there. There's no reason
    // for that hand draw animation to take place on round one."
    if (Game && Game.state && (Game.state.round || 0) <= 1) return;
    // Source element: the deck-count indicator in the HUD. For AI
    // side we don't have a separate indicator, so we use the same
    // target as the player (still looks directional — from the top-
    // center HUD down to the AI hand row).
    const src = document.getElementById('draw-pile-count');
    const dst = owner === 'player'
      ? document.getElementById('player-hand')
      : document.querySelector('.ai-bar') || document.getElementById('draw-pile-count');
    if (!src || !dst) return;
    const srcR = src.getBoundingClientRect();
    const dstR = dst.getBoundingClientRect();
    const from = { x: srcR.left + srcR.width / 2, y: srcR.top + srcR.height / 2 };
    const to   = { x: dstR.left + dstR.width / 2, y: dstR.top + dstR.height / 2 };
    const N = Math.min(5, count); // cap stagger count so 5-card draws don't flood
    for (let i = 0; i < N; i++) {
      setTimeout(() => {
        const ghost = document.createElement('div');
        ghost.className = 'draw-ghost-card';
        ghost.style.left = (from.x - 16) + 'px';
        ghost.style.top  = (from.y - 22) + 'px';
        ghost.style.setProperty('--dx', (to.x - from.x) + 'px');
        ghost.style.setProperty('--dy', (to.y - from.y) + 'px');
        document.body.appendChild(ghost);
        setTimeout(() => ghost.remove(), 520);
      }, i * 80);
    }
  },

  // Centralized haptic feedback. Call with a pattern name; the
  // browser's Vibration API fires the matching pulse. No-ops on
  // desktop (no vibrator) and when user opted out via settings.
  // Calling site should be owner==='player' or a global event.
  _haptic(kind) {
    if (!navigator.vibrate) return;
    if (this.settings && this.settings.hapticsOff) return;
    const patterns = {
      'cardPlay':   12,        // light tap — placing a card
      'hit':        [18, 10, 18], // double-tick — combat hit
      'kill':       [25, 20, 45], // rising pulse — enemy dies
      'trick':      [14, 8, 14],  // trick cast
      'block':      [8, 5, 8, 5, 35], // block meter trigger (staccato-to-punch)
      'energy':     10,        // spending energy
      'longPress':  20,        // inspect activate
      'multiKillSmall': [30, 50, 40],
      'multiKillBig':   [40, 60, 40, 60, 80],
      'victory':    [70, 60, 70, 60, 200],
      'defeat':     [300],
    };
    const pat = patterns[kind];
    if (!pat) return;
    try { navigator.vibrate(pat); } catch (e) {}
  },

  // Mobile / touch — long-press on a card pops up a full-size preview
  // modal with the card's description, stats, and ability badges.
  // Hover doesn't exist on touch devices, so without this there's no
  // way to read a card's full desc before committing to the play.
  // ~450ms press threshold matches iOS conventions (press-to-preview
  // vs. tap-to-activate); we cancel on movement to avoid conflicting
  // with drag/scroll gestures.
  installLongPressInspect() {
    if (this._longPressInstalled) return;
    this._longPressInstalled = true;
    const HOLD_MS = 450;
    const MOVE_TOLERANCE = 10; // px — beyond this, treat as scroll/drag
    let timer = null, startX = 0, startY = 0, currentEl = null;
    const cancel = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      currentEl = null;
    };
    // Active long-press ring — visible feedback while the user is
    // holding. Without this the 450ms hold felt unresponsive ("did
    // my press register?"). The ring grows with the progress and
    // pops away cleanly on release / movement / fire.
    let activeRing = null;
    const stopRing = () => {
      if (activeRing && activeRing.parentNode) activeRing.parentNode.removeChild(activeRing);
      activeRing = null;
    };
    const cancelWithRing = () => { stopRing(); cancel(); };
    const onStart = (ev) => {
      const t = ev.touches ? ev.touches[0] : ev;
      if (!t) return;
      const cardEl = (ev.target.closest && ev.target.closest('.card, .db-grid-item, .draft-card, .dead-pile-card, .trick-card'));
      if (!cardEl) return;
      startX = t.clientX; startY = t.clientY;
      currentEl = cardEl;
      // Spawn a progress ring centered on the touch point. Pure CSS
      // animation tied to HOLD_MS — ring scales 0→1 and fades in over
      // the hold window. Removed on cancel/fire so the inspect modal
      // doesn't see a stale ring on the page.
      stopRing();
      activeRing = document.createElement('div');
      activeRing.className = 'long-press-ring';
      activeRing.style.left = t.clientX + 'px';
      activeRing.style.top  = t.clientY + 'px';
      activeRing.style.animationDuration = HOLD_MS + 'ms';
      document.body.appendChild(activeRing);
      timer = setTimeout(() => {
        timer = null;
        stopRing();
        this.showCardInspect(cardEl);
        // Fire a haptic kick so the user knows the long-press landed.
        if (navigator.vibrate) { try { navigator.vibrate(20); } catch (e) {} }
      }, HOLD_MS);
    };
    const onMove = (ev) => {
      if (!timer) return;
      const t = ev.touches ? ev.touches[0] : ev;
      if (!t) return;
      if (Math.abs(t.clientX - startX) > MOVE_TOLERANCE || Math.abs(t.clientY - startY) > MOVE_TOLERANCE) {
        cancelWithRing();
      }
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove',  onMove,  { passive: true });
    document.addEventListener('touchend',   cancelWithRing, { passive: true });
    document.addEventListener('touchcancel',cancelWithRing, { passive: true });
  },

  // Render a full-width card inspect modal. Reads name / cost / stats
  // / abilities / desc directly from the source card def (looked up
  // via data-card-name or data-trick-name) so it always shows the
  // canonical text, not the possibly-buffed in-play values. Tap
  // anywhere outside to close.
  showCardInspect(cardEl) {
    // Close any existing inspect first.
    const stale = document.getElementById('card-inspect-modal');
    if (stale) stale.remove();
    const name = cardEl.dataset.cardName || cardEl.dataset.trickName
              || cardEl.querySelector('.card-name, .db-grid-name, .trick-name')?.textContent;
    if (!name) return;
    const def = (typeof CARD_DEFS !== 'undefined' ? CARD_DEFS.find(c => c.name === name) : null)
             || (typeof TRICK_DEFS !== 'undefined' ? TRICK_DEFS.find(t => t.name === name) : null);
    if (!def) return;
    const isTrick = !!(typeof TRICK_DEFS !== 'undefined' && TRICK_DEFS.find(t => t.name === name));
    const stats = isTrick ? '' : `
      <div class="ci-stats">
        <span class="ci-atk">${def.attack}</span>
        <span class="ci-slash">/</span>
        <span class="ci-hp">${def.health}</span>
      </div>`;
    const badges = def.abilities && def.abilities.length
      ? `<div class="ci-badges">${this.formatAbilityBadges(def.abilities)}</div>` : '';
    const desc = def.desc ? `<div class="ci-desc">${this.formatDesc(def.desc)}</div>` : '';
    const modal = document.createElement('div');
    modal.id = 'card-inspect-modal';
    modal.className = 'card-inspect-modal';
    modal.innerHTML = `
      <div class="ci-backdrop"></div>
      <div class="ci-panel ${this.getCostClass(def.cost || 0)}${isTrick ? ' ci-trick' : ''}">
        <span class="card-cost">${def.cost || 0}</span>
        <div class="ci-name">${def.name}</div>
        ${badges}
        ${stats}
        ${desc}
        <button type="button" class="ci-close" aria-label="Close">×</button>
      </div>`;
    document.body.appendChild(modal);
    // Mobile parity for hover audio: hover SFX is bound to mouseover on
    // desktop, but mobile has no cursor — the long-press inspect modal
    // IS the mobile equivalent of "dwelling on a card." So we trigger
    // the same hover cue when the modal opens, and stop it when the
    // modal closes. Honors the per-card SFX registry, so signature-
    // theme cards (Superman, Anakin, etc.) play their full track on a
    // mobile long-press too. User spec: "do the hovers work on mobile?"
    if (this.sfx) {
      try {
        const inspectAudio = isTrick
          ? this.sfx.playTrickSfx(name, 'hover')
          : this.sfx.playCardSfx(name, 'hover');
        if (!inspectAudio) this.sfx.play('cardHover');
        this.sfx._currentHoverAudio = inspectAudio;
        this.sfx._currentHoverEl = modal;
      } catch (e) { /* swallow */ }
    }
    const close = () => {
      modal.remove();
      // Stop hover audio + restore menu music level when the inspect
      // modal closes. Mirror of the desktop mouseout handler.
      if (this.sfx && typeof this.sfx._stopHover === 'function') this.sfx._stopHover();
    };
    modal.querySelector('.ci-backdrop').addEventListener('click', close);
    modal.querySelector('.ci-close').addEventListener('click', close);
    // Auto-close on any navigation / Escape key.
    const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
  },

  // #3 — Card-destroy particle burst. Called from Game.handleDeath so we
  // can spawn particles in the card's current slot BEFORE the next render
  // sweeps the DOM. Spawns 8 squares on a radial wheel + a shockwave ring
  // + a brief screen flash, and records the kill for multikill detection.
  // Hit-chip burst — small cubes shed off a card when it takes damage.
  // Quieter cousin of spawnDestroyParticles (which fires on death):
  // 4-5 small squares spawn at randomized positions on the card body,
  // tumble outward with gravity, and fade in ~600ms. Reads as
  // "starting to dissolve" — partial preview of the kill animation,
  // distinct from hit-flash (color burst) and the strike-burst ring.
  // Replaced the earlier .hit-shake camera-shake which the user
  // flagged as distracting.
  spawnHitChips(cardEl) {
    if (!cardEl) return;
    cardEl.style.position = 'relative';
    const host = document.createElement('div');
    host.className = 'hit-chips';
    cardEl.appendChild(host);
    const N = 4 + Math.floor(Math.random() * 2); // 4-5 chips per hit
    for (let i = 0; i < N; i++) {
      const chip = document.createElement('div');
      chip.className = 'hit-chip';
      // Spawn anywhere on the card body — random offset from center.
      // (Range tuned to fit inside the typical 120×170 card footprint
      // without spilling outside the visible area pre-fall.)
      const sx = (Math.random() * 60 - 30);    // −30 .. +30 px
      const sy = (Math.random() * 80 - 40);    // −40 .. +40 px
      // Outward velocity — chips drift downward (gravity) + sideways.
      // Wider horizontal spread + always-positive Y so chips fall.
      const dx = (Math.random() * 80 - 40);    // −40 .. +40 px
      const dy = 30 + Math.random() * 50;      // 30 .. 80 px (down)
      const rot = (Math.random() * 540 - 270); // −270 .. +270 deg
      const size = 4 + Math.random() * 4;       // 4-8 px
      chip.style.setProperty('--sx',  sx  + 'px');
      chip.style.setProperty('--sy',  sy  + 'px');
      chip.style.setProperty('--dx',  dx  + 'px');
      chip.style.setProperty('--dy',  dy  + 'px');
      chip.style.setProperty('--rot', rot + 'deg');
      chip.style.width = size + 'px';
      chip.style.height = size + 'px';
      // Random small per-chip delay so they don't all fire on one frame.
      chip.style.animationDelay = (Math.random() * 60) + 'ms';
      host.appendChild(chip);
    }
    setTimeout(() => host.remove(), 700);
  },

  spawnDestroyParticles(cardId, owner) {
    if (cardId == null) return;
    const cardEl = document.querySelector(`[data-card-id="${cardId}"]`);
    if (!cardEl) return;
    cardEl.style.position = 'relative';
    // Apply the Tron-dissolve scan-line animation to the card itself.
    // Was dead code before — `.card-exit` class was being removed in
    // a few cleanup paths but never added on death, so the keyframe
    // animation never fired. User spec: "I want the cards just to
    // dissolve any time they're killed... like Tron, dissolve back
    // into the grid." Fires alongside the existing particle burst /
    // shockwave / screen flash.
    cardEl.classList.add('card-exit');
    // Original 8-particle burst (unchanged).
    const host = document.createElement('div');
    host.className = 'destroy-particles';
    cardEl.appendChild(host);
    const N = 8;
    for (let i = 0; i < N; i++) {
      const p = document.createElement('div');
      p.className = 'destroy-particle';
      p.style.setProperty('--angle', `${(360 / N) * i}deg`);
      host.appendChild(p);
    }
    setTimeout(() => host.remove(), 550);
    // Shockwave ring — larger expanding circle tinted by card side,
    // layered under the particles. Gives kills a beat that damage hits
    // don't have (only the strike-burst ring on non-lethal hits).
    const shock = document.createElement('div');
    shock.className = 'kill-shockwave';
    cardEl.appendChild(shock);
    setTimeout(() => shock.remove(), 640);
    // Screen flash — brief radial wash in the killing side's color.
    // Kills from player's perspective (their card died) = red flash;
    // kills of an enemy card = theme-color flash. `owner` here is the
    // OWNER of the dying card, so an 'ai'-owned death means the PLAYER
    // scored the kill (theme flash); a 'player'-owned death means the
    // AI scored (red flash).
    const killingSide = owner === 'ai' ? 'player' : 'ai';
    const flashCls = killingSide === 'player' ? 'kill-flash-player' : 'kill-flash-ai';
    document.body.classList.remove(flashCls);
    void document.body.offsetWidth;
    document.body.classList.add(flashCls);
    setTimeout(() => document.body.classList.remove(flashCls), 300);
    // Multikill tracking — record this death in a rolling window.
    // When the next one comes in within 700ms, the counter ticks up
    // and trigger banners at 2, 3, 4+.
    this._recordMultikill(killingSide);
    // Scatter shards — bigger, irregular wedges that fly outward with
    // rotation + gravity. Layered on top of the radial particle burst
    // so kills feel explosive, not just dissolved. Audit finding:
    // "death reads as fade not explosion."
    this.spawnDestroyShards(cardEl, owner);
    // Single-kill haptic — distinct from hit; slightly longer pulse
    // so you can feel the difference between a chip-damage hit and
    // a card actually dying.
    this._haptic('kill');
  },

  // Bigger, irregular wedge-shaped shards that fly out + spin + fall.
  // Spawned alongside spawnDestroyParticles. Each shard has a random
  // angle, distance, rotation, and size — looks like the card LITERALLY
  // shattered into pieces. 5-7 shards per kill to read as substantial
  // without overwhelming the particle burst.
  spawnDestroyShards(cardEl, owner) {
    if (!cardEl) return;
    if (this._reducedMotion && this._reducedMotion()) return;
    const host = document.createElement('div');
    host.className = 'destroy-shards';
    cardEl.appendChild(host);
    const N = 5 + Math.floor(Math.random() * 3); // 5-7 shards
    for (let i = 0; i < N; i++) {
      const shard = document.createElement('div');
      shard.className = 'destroy-shard';
      // Wide angle spread (full 360°) but biased outward via large dx/dy.
      const angle = (Math.random() * 360);
      const dist = 60 + Math.random() * 70;       // 60-130 px
      const dx = Math.cos(angle * Math.PI / 180) * dist;
      const dy = Math.sin(angle * Math.PI / 180) * dist + 30; // gravity bias
      const rot = (Math.random() * 720 - 360);     // -360 to +360 deg
      const size = 7 + Math.random() * 8;          // 7-15 px
      const dur = 600 + Math.random() * 240;       // 600-840 ms
      shard.style.setProperty('--dx', dx + 'px');
      shard.style.setProperty('--dy', dy + 'px');
      shard.style.setProperty('--rot', rot + 'deg');
      shard.style.width = size + 'px';
      shard.style.height = (size * 0.6) + 'px';
      shard.style.animationDuration = dur + 'ms';
      shard.style.animationDelay = (Math.random() * 40) + 'ms';
      host.appendChild(shard);
    }
    setTimeout(() => host.remove(), 900);
  },

  // Multikill tracker — counts deaths credited to each side within a
  // rolling 700ms window. When the counter crosses a threshold, shows
  // the tier banner ("DOUBLE KILL" / "TRIPLE KILL" / "BOARD WIPE").
  // Resets per-side independently so one combat's deaths on the same
  // side chain but don't spill between sides.
  _recordMultikill(side) {
    if (!this._mkState) this._mkState = { player: { count: 0, last: 0, shown: 0 }, ai: { count: 0, last: 0, shown: 0 } };
    const s = this._mkState[side];
    const now = performance.now();
    // Window reset — >700ms gap = new kill streak.
    if (now - s.last > 700) { s.count = 0; s.shown = 0; }
    s.count++;
    s.last = now;
    // Only show the highest tier reached so the banner doesn't flash
    // DOUBLE then immediately TRIPLE — let the triple supersede.
    const tier = s.count >= 4 ? 'wipe' : s.count === 3 ? 'triple' : s.count === 2 ? 'double' : null;
    const tierRank = { double: 1, triple: 2, wipe: 3 };
    if (tier && (tierRank[tier] > (s.shown || 0))) {
      s.shown = tierRank[tier];
      this._showMultikillBanner(tier, side);
    }
  },
  _showMultikillBanner(tier, side) {
    // Don't stack banners — remove any live one first so the new tier
    // replaces immediately (matches how Halo/Quake handle escalation).
    document.querySelectorAll('.multikill-banner').forEach(n => n.remove());
    // Respect reduced-motion — skip the banner entirely. The log line
    // "BOARD WIPE" / "TRIPLE KILL" still records what happened.
    const reduceMotion = this._reducedMotion();
    const el = document.createElement('div');
    el.className = `multikill-banner mk-${tier}`;
    el.textContent = tier === 'wipe' ? 'BOARD WIPE!'
                   : tier === 'triple' ? 'TRIPLE KILL!'
                   : 'DOUBLE KILL!';
    if (!reduceMotion) {
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 1500);
    }
    // Haptic kick on the local player's big moments (matches the
    // victory-screen vibrate pattern). Only fires for player-side
    // multikills; AI multikills are a different kind of emotional beat.
    if (side === 'player' && navigator.vibrate) {
      try {
        const pattern = tier === 'wipe' ? [40, 60, 40, 60, 80] : tier === 'triple' ? [30, 50, 30, 60] : [30, 50, 40];
        navigator.vibrate(pattern);
      } catch (e) {}
    }
    // Sound escalation — reuse victory SFX for the biggest (board wipe)
    // so the audio lines up with the on-screen flourish; fallbacks use
    // the generic hit sound for smaller multikills.
    if (this.sfx && this.sfx.play) {
      if (tier === 'wipe') this.sfx.play('victory');
      else if (tier === 'triple') this.sfx.play('blockFull');
    }
  },

  // #4 — HP drain pulse. Observes HP changes by polling after every
  // render and flashing the fill element when HP decreases.
  installHpDrainPulse() {
    this._lastHp = { player: null, ai: null };
    const orig = this.render.bind(this);
    this.render = (...args) => {
      const r = orig(...args);
      if (!Game.state) return r;
      ['player', 'ai'].forEach(side => {
        const hp = Game.state[side] && Game.state[side].health;
        if (hp == null) return;
        if (this._lastHp[side] !== null && hp < this._lastHp[side]) {
          const fill = document.getElementById(side === 'player' ? 'player-hp-fill' : 'ai-hp-fill');
          if (fill) {
            fill.classList.remove('hp-drain');
            void fill.offsetWidth;
            fill.classList.add('hp-drain');
            setTimeout(() => fill.classList.remove('hp-drain'), 450);
          }
        }
        this._lastHp[side] = hp;
      });
      return r;
    };
  },

  // #7 — Mulligan shuffle. Patches Game.draftMulligan to animate the
  // current draft cards off before the redraw renders new ones.
  installMulliganAnim() {
    if (this._mulliganInstalled) return;
    this._mulliganInstalled = true;
    if (typeof Game === 'undefined' || !Game.draftMulligan) return;
    const orig = Game.draftMulligan.bind(Game);
    Game.draftMulligan = () => {
      document.querySelectorAll('.draft-card').forEach(c => c.classList.add('mulligan-shuffle'));
      setTimeout(() => orig(), 320);
    };
  },

  // #8 — Trick cast burst. Fires a colored shockwave from screen center
  // when a trick plays. Hooks Game.playTrick. Also (J) flips the trick
  // card element on play for a mid-screen flourish.
  installTrickBurst() {
    if (this._trickBurstInstalled) return;
    this._trickBurstInstalled = true;
    if (typeof Game === 'undefined' || !Game.playTrick) return;
    const orig = Game.playTrick.bind(Game);
    Game.playTrick = (owner, trick, ...rest) => {
      // (J) Flip the trick card element before it disappears.
      if (owner === 'player' && trick) {
        const trickEl = document.querySelector(`.trick-card[data-trick-name="${trick.name}"]`)
          || [...document.querySelectorAll('.trick-card .trick-name')]
               .find(e => e.textContent.trim().toUpperCase() === String(trick.name).toUpperCase())
               ?.closest('.trick-card');
        if (trickEl) {
          trickEl.classList.add('trick-played');
          setTimeout(() => trickEl.classList.remove('trick-played'), 440);
        }
      }
      const burst = document.createElement('div');
      burst.className = `trick-burst caster-${owner === 'player' ? 'player' : 'ai'}`;
      document.body.appendChild(burst);
      setTimeout(() => burst.remove(), 700);
      // Haptic for trick cast — double-tick feels distinct from
      // card-play's single tap and hit's three-pulse.
      if (owner === 'player') this._haptic('trick');
      return orig(owner, trick, ...rest);
    };
  },

  // (B) Energy spend flash hook — monkey-patch Game.playCard and
  // Game.playTrick so whenever a paid play happens, the corresponding
  // side's energy orb flashes.
  installEnergySpendFlash() {
    if (this._energySpendInstalled) return;
    this._energySpendInstalled = true;
    if (typeof Game === 'undefined') return;
    if (Game.playCard) {
      const origPc = Game.playCard.bind(Game);
      Game.playCard = (owner, card, laneIdx, ...rest) => {
        const before = Game.state && Game.state[owner] ? Game.state[owner].currency : 0;
        const r = origPc(owner, card, laneIdx, ...rest);
        if (r) {
          const after = Game.state && Game.state[owner] ? Game.state[owner].currency : before;
          this.flashEnergySpend(owner, Math.max(0, before - after));
          // Mobile haptic — routes through central helper so the
          // settings "Disable haptics" toggle applies. Fires only
          // for the local player's own plays; AI plays don't vibrate.
          if (owner === 'player') this._haptic('cardPlay');
        }
        return r;
      };
    }
    if (Game.playTrick) {
      // Note: trick burst already patches playTrick; stack this patch
      // on top so both fire.
      const origPt = Game.playTrick.bind(Game);
      Game.playTrick = (owner, trick, ...rest) => {
        const before = Game.state && Game.state[owner] ? Game.state[owner].currency : 0;
        const r = origPt(owner, trick, ...rest);
        if (r) {
          const after = Game.state && Game.state[owner] ? Game.state[owner].currency : before;
          this.flashEnergySpend(owner, Math.max(0, before - after));
          this.sfx.play('trick');
        }
        return r;
      };
    }
  },

  // #9 — Parallax main menu. Mouse position drives body-level CSS vars
  // that each UI surface (mm-panel, body::before) reads for tiny offsets.
  installParallaxMenu() {
    let rafPending = false;
    document.addEventListener('mousemove', (e) => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        const mmOpen = document.getElementById('main-menu-overlay');
        // Only drive parallax while the main menu is visible — no need
        // to repaint this during gameplay.
        if (!mmOpen || mmOpen.style.display === 'none') return;
        const w = window.innerWidth || 1;
        const h = window.innerHeight || 1;
        const x = (e.clientX / w) * 2 - 1;  // -1..1
        const y = (e.clientY / h) * 2 - 1;
        document.body.style.setProperty('--parallax-x', x.toFixed(3));
        document.body.style.setProperty('--parallax-y', y.toFixed(3));
      });
    }, { passive: true });
  },

  // #10 — Deck viewer popover. Clicking the HUD deck-count opens a
  // compact panel listing remaining cards grouped by cost.
  installDeckViewer() {
    if (this._deckViewerInstalled) return;
    this._deckViewerInstalled = true;
    // Inject overlay once
    if (!document.getElementById('deck-viewer-overlay')) {
      const ov = document.createElement('div');
      ov.id = 'deck-viewer-overlay';
      ov.className = 'deck-viewer-overlay';
      ov.innerHTML = `<div class="deck-viewer-panel">
        <button type="button" class="deck-viewer-close" onclick="UI.closeDeckViewer()" aria-label="Close">&times;</button>
        <div class="deck-viewer-title">Draw Pile</div>
        <div id="deck-viewer-body"></div>
      </div>`;
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => {
        if (e.target === ov) this.closeDeckViewer();
      });
    }
    // Delegate click on the deck count pill (<b>) AND the tricks pill.
    document.addEventListener('click', (e) => {
      const deckTarget = e.target.closest('.hud-count-deck b');
      if (deckTarget) {
        e.stopPropagation();
        this.openDeckViewer('cards');
        return;
      }
      const trickTarget = e.target.closest('.hud-count-tricks b');
      if (trickTarget) {
        e.stopPropagation();
        this.openDeckViewer('tricks');
      }
    });
  },
  openDeckViewer(kind) {
    if (!Game.state) return;
    kind = kind || 'cards';
    // Deckbuilder + roguelite store per-side piles on state.player.* —
    // read from there. Classic uses the shared state.drawPile /
    // state.trickDrawPile. Without this branch the modal showed empty
    // in deckbuilder runs even when the HUD count said the pile had
    // cards. User report: "the draw pile is empty even though it shows
    // five. Same thing with the tricks."
    const isDeckbuilder = Game.state.mode && Game.state.mode.deck === 'deckbuilder';
    const pile = isDeckbuilder
      ? (kind === 'tricks' ? Game.state.player.trickDrawPile : Game.state.player.drawPile)
      : (kind === 'tricks' ? Game.state.trickDrawPile : Game.state.drawPile);
    const titleEl = document.querySelector('.deck-viewer-title');
    if (titleEl) titleEl.textContent = kind === 'tricks' ? 'Trick Pile' : 'Draw Pile';
    const body = document.getElementById('deck-viewer-body');
    if (!body) return;
    if (!pile || !pile.length) {
      body.innerHTML = `<div style="color:#7a8691;font-style:italic;text-align:center">${kind === 'tricks' ? 'Trick pile' : 'Draw pile'} is empty.</div>`;
    } else {
      // Group by cost for both card + trick pile — same visual template.
      const groups = new Map();
      pile.forEach(c => {
        const cost = c.cost || 0;
        if (!groups.has(cost)) groups.set(cost, []);
        groups.get(cost).push(c.name);
      });
      const costs = [...groups.keys()].sort((a, b) => a - b);
      body.innerHTML = costs.map(c => {
        const names = groups.get(c).sort();
        return `<div class="deck-viewer-group">
          <div class="deck-viewer-cost">Cost ${c} — ${names.length}</div>
          <div class="deck-viewer-list">${names.map(n => `<span class="deck-viewer-chip">${n}</span>`).join('')}</div>
        </div>`;
      }).join('');
    }
    document.getElementById('deck-viewer-overlay').classList.add('open');
  },
  closeDeckViewer() {
    const ov = document.getElementById('deck-viewer-overlay');
    if (ov) ov.classList.remove('open');
  },

  // #11 — Combat pacing beat. Adds a brief "lane-activating" flash at
  // the start of each lane's resolution. Hooks into the active-lane
  // body-class change by observing Game.state._activeLane changes.
  _lastActiveLane: undefined,
  markActiveLaneBeat() {
    if (!Game.state) return;
    const cur = Game.state._activeLane;
    if (cur === this._lastActiveLane) return;
    this._lastActiveLane = cur;
    if (cur == null) return;
    const laneEl = document.querySelectorAll('.lane')[cur];
    if (!laneEl) return;
    laneEl.classList.remove('lane-activating');
    void laneEl.offsetWidth;
    laneEl.classList.add('lane-activating');
    setTimeout(() => laneEl.classList.remove('lane-activating'), 440);
    // (m) Combat lunges — when a lane activates, animate the attacker
    // forward and the target back. Reads lane.player / lane.ai to find
    // the card DOM and add .combat-attacker / .combat-target briefly.
    // Both classes co-exist on each card during a contested lane (each
    // is both an attacker AND a target since combat is simultaneous);
    // CSS animation runs on whichever class wins the cascade.
    const lane = Game.state.lanes && Game.state.lanes[cur];
    if (!lane) return;
    const p = lane.player, a = lane.ai;
    // Updated lunge duration (320 → 540) — see CSS keyframes for the
    // new anticipation→impact-hold→recoil structure. Class cleanup
    // matches the new total so the card returns to its rest pose
    // exactly when the keyframe ends.
    const LUNGE_MS = 540;
    // Impact moment in the new keyframe is 35-48% (~190-260ms in).
    // We fire the hit-flash + camera-shake at 190ms so they land at
    // the start of the impact-hold frame.
    const IMPACT_AT_MS = 190;
    const classOnCard = (id, cls, dur) => {
      if (id == null) return null;
      const el = document.querySelector(`[data-card-id="${id}"]`);
      if (!el) return null;
      el.classList.remove(cls);
      void el.offsetWidth;
      el.classList.add(cls);
      setTimeout(() => el.classList.remove(cls), dur || LUNGE_MS);
      return el;
    };
    // Camera-shake tier from attacker's ATK. Fired on document.body so
    // the entire viewport rocks subtly with each impact — turns "two
    // cards bumping" into "two cards COLLIDING."
    const shakeForAtk = (atk) => {
      if (!atk || atk < 1) return;
      const cls = atk >= 7 ? 'combat-shake-heavy'
               : atk >= 4 ? 'combat-shake-medium'
               : 'combat-shake-light';
      // Strip whichever shake class is currently active so a back-to-
      // back lane reset retriggers cleanly.
      ['combat-shake-light','combat-shake-medium','combat-shake-heavy']
        .forEach(c => document.body.classList.remove(c));
      void document.body.offsetWidth;
      document.body.classList.add(cls);
      setTimeout(() => document.body.classList.remove(cls), 340);
    };
    // Hit-flash on a card — re-uses the existing .hit-flash class
    // which paints a brief scanline + brightness pulse.
    const hitFlashOn = (id) => {
      const el = id != null ? document.querySelector(`[data-card-id="${id}"]`) : null;
      if (!el) return;
      el.classList.remove('hit-flash');
      void el.offsetWidth;
      el.classList.add('hit-flash');
      setTimeout(() => el.classList.remove('hit-flash'), 320);
    };
    if (p && a) {
      // Contested lane — both cards swing simultaneously. Each card
      // gets BOTH attacker (its outgoing swing) AND target (the
      // incoming hit) classes; the resulting visual is each card
      // lunging toward the centerline AND being shoved back. CSS
      // collapses the two animations onto the same property by
      // letting the LAST class to be added win, so we toggle both
      // into a single combined class via a short delay so neither
      // lone-class state lingers.
      classOnCard(p.id, 'combat-attacker');
      classOnCard(a.id, 'combat-attacker');
      // Drive impact effects at the ~190ms mark so the hit-flash and
      // camera-shake align with the keyframe's impact-hold frame.
      const peakAtk = Math.max(p.attack || 0, a.attack || 0);
      setTimeout(() => {
        hitFlashOn(p.id);
        hitFlashOn(a.id);
        shakeForAtk(peakAtk);
      }, IMPACT_AT_MS);
    } else if (p) {
      // Uncontested ally lane → swings at the AI's HP bar.
      classOnCard(p.id, 'combat-attacker');
      setTimeout(() => shakeForAtk(p.attack), IMPACT_AT_MS);
    } else if (a) {
      classOnCard(a.id, 'combat-attacker');
      setTimeout(() => shakeForAtk(a.attack), IMPACT_AT_MS);
    }
  },

  // ===================== SPLASH ANIMATION HOOK =====================
  // Wraps Game.applySplash so each splashed enemy plays the same
  // weight-driven hit lunge that contested-lane targets do, plus a
  // radial shockwave from the source card's center. Without this hook
  // splash damage drained HP silently — no impact reading. Hook is
  // installed once from init() (idempotent guard inside).
  installSplashFx() {
    if (this._splashFxHooked) return;
    if (typeof Game === 'undefined' || typeof Game.applySplash !== 'function') return;
    this._splashFxHooked = true;
    const orig = Game.applySplash.bind(Game);
    Game.applySplash = (card, laneIdx) => {
      // Snapshot the splash victims BEFORE the engine kills them so we
      // can find their DOM elements while they still exist.
      const opp = Game.opponent(card.owner);
      const victims = [];
      [laneIdx - 1, laneIdx, laneIdx + 1].forEach(li => {
        if (li < 0 || li >= Game.LANE_COUNT) return;
        const t = Game.state.lanes[li] && Game.state.lanes[li][opp];
        if (t && t.currentHealth > 0) victims.push({ card: t, lane: li });
      });
      // Run the engine logic first so HP bars + log lines fire normally.
      const r = orig(card, laneIdx);
      // Now paint the visual. The shockwave traces the source card's
      // perimeter (NOT a tiny circle in the center) — the card is
      // opaque, so the ripple is only visible around its edges, like
      // dropping a flat object on water and watching the wave radiate
      // out from its outline. Position/size copy the source card's
      // exact rect so the initial frame sits flush with the card edge,
      // and scale() expands outward from there.
      const srcEl = document.querySelector(`[data-card-id="${card.id}"]`);
      const srcRect = srcEl && srcEl.getBoundingClientRect();
      if (srcRect && srcRect.width > 0) {
        const sideCls = card.owner === 'ai' ? ' ring-ai' : '';
        // Match the card's own border-radius so the ring traces the
        // actual silhouette (corners included).
        const borderRadius = (srcEl && getComputedStyle(srcEl).borderRadius) || '6px';
        const placeRing = (extraCls) => {
          const ring = document.createElement('div');
          ring.className = 'splash-shockwave' + sideCls + (extraCls ? ' ' + extraCls : '');
          ring.style.left   = srcRect.left   + 'px';
          ring.style.top    = srcRect.top    + 'px';
          ring.style.width  = srcRect.width  + 'px';
          ring.style.height = srcRect.height + 'px';
          ring.style.borderRadius = borderRadius;
          document.body.appendChild(ring);
          setTimeout(() => ring.remove(), 700);
          return ring;
        };
        placeRing();                        // primary wave (immediate)
        setTimeout(() => placeRing('shock-secondary'), 90); // trailing wave
      }
      victims.forEach((v, i) => {
        const el = document.querySelector(`[data-card-id="${v.card.id}"]`);
        if (!el) return;
        // Each victim staggered 50ms after the previous so adjacent
        // lanes don't all jolt in lockstep.
        setTimeout(() => {
          el.classList.remove('combat-splash-hit');
          void el.offsetWidth;
          el.classList.add('combat-splash-hit');
          // Hit-flash at the impact frame.
          setTimeout(() => {
            el.classList.remove('hit-flash');
            void el.offsetWidth;
            el.classList.add('hit-flash');
            setTimeout(() => el.classList.remove('hit-flash'), 320);
          }, 170);
          setTimeout(() => el.classList.remove('combat-splash-hit'), 510);
        }, i * 50);
      });
      return r;
    };
  },

  // (f) Hover card tilt parallax — mousemove on hand-card-wrapper
  // sets --tilt-x / --tilt-y CSS vars so the CSS 3D transform pivots
  // the card based on cursor position within its bounds. Subtle: ±1.
  // AI opponent personalities — 8 flavors picked at match start so
  // every match has a different "face" across from you. Each entry
  // has a glyph (single char/emoji used as avatar), a name, and a
  // tagline shown in the bar tooltip. Pure cosmetic — zero effect
  // on gameplay. Picked round-robin from localStorage counter so
  // you don't see the same personality 3 matches in a row.
  AI_PERSONALITIES: [
    { glyph: '◉', name: 'HAL',        tag: 'The logical one.' },
    { glyph: '☠', name: 'GRIMM',      tag: 'Hungry for your soul.' },
    { glyph: '⚡', name: 'VOLT',       tag: 'Lightning reflexes.' },
    { glyph: '❄', name: 'VEX',        tag: 'Cold and calculating.' },
    { glyph: '✧', name: 'ORACLE',     tag: 'She saw this coming.' },
    { glyph: '▲', name: 'RECLUSE',    tag: 'Watches from the shadows.' },
    { glyph: '☢', name: 'TOXIC',      tag: 'You already lost.' },
    { glyph: '♛', name: 'MONARCH',    tag: 'Bow to the board.' }
  ],
  _pickAiPersonality() {
    const list = this.AI_PERSONALITIES;
    let idx = 0;
    try {
      idx = (parseInt(localStorage.getItem('clb_ai_personality_idx') || '0', 10) + 1) % list.length;
      localStorage.setItem('clb_ai_personality_idx', String(idx));
    } catch (e) { idx = Math.floor(Math.random() * list.length); }
    this._currentAiPersonality = list[idx];
    const avEl = document.getElementById('ai-avatar');
    const nmEl = document.getElementById('ai-name');
    const cellEl = document.getElementById('ai-avatar-cell');
    if (avEl) avEl.textContent = list[idx].glyph;
    if (nmEl) nmEl.textContent = list[idx].name;
    if (cellEl) cellEl.title = `${list[idx].name} — ${list[idx].tag}`;
  },

  // ===================== COLOR INVASION =====================
  // Computes lane-control dominance each render and writes it as
  // CSS variables on body so the rest of the UI can react.
  // Empty lanes and contested lanes count for nobody. Single-side
  // occupancy contributes 1 lane to that side. Dominance is the
  // fraction of (player_lanes - enemy_lanes) / 6, clamped to 0..1
  // for each side. Both can be 0 (e.g. board empty) but never both
  // simultaneously >0 — only the leading side has positive value.
  // The CSS uses these to:
  //   • Tint each HUD's border + glow toward the LEADING side's color
  //   • Paint an "invasion gradient" on the LOSING HUD's inside edge
  //   • At >50% dominance, tint the LOSING HUD's HP-trough
  //   • Bias empty lane mid-color toward the leading side
  // 800ms CSS transitions on the affected properties make changes
  // feel like atmospheric shifts rather than UI flashes.
  _updateDominanceVars(s) {
    if (!s || !s.lanes) return;
    let pl = 0, ai = 0;
    for (const lane of s.lanes) {
      const hasP = lane.player && lane.player.currentHealth > 0;
      const hasA = lane.ai     && lane.ai.currentHealth > 0;
      // Only single-occupancy counts toward dominance. Contested
      // and empty are neutral. This keeps the signal pure: lots of
      // GREEN ON BOARD = strong player dominance; lots of YELLOW
      // (contested) = stalemate; the dominance bar stays moderate.
      if (hasP && !hasA) pl++;
      else if (hasA && !hasP) ai++;
    }
    // Net advantage in 0..1 each direction. 6 lanes max.
    const net = pl - ai;          // -6..+6
    const playerDom = Math.max(0, net) / 6;   // 0..1
    const enemyDom  = Math.max(0, -net) / 6;  // 0..1
    document.body.style.setProperty('--player-dominance', playerDom.toFixed(3));
    document.body.style.setProperty('--enemy-dominance',  enemyDom.toFixed(3));
  },

  // Wave 3 #8 — MOUSE-PARALLAX CAMERA. Tiny rotateY/X on
  // #game-area driven by cursor distance from screen center.
  // The CSS rule reads --cam-tx (-1..1) / --cam-ty (-1..1) we
  // set here. Magnitudes capped at ±2° in CSS so the playfield
  // pivots subtly — "looking around" a Tron room — without
  // making anyone seasick. Skipped in reduced-motion.
  installCameraParallax() {
    if (this._cameraParallaxInstalled) return;
    this._cameraParallaxInstalled = true;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ga = document.getElementById('game-area');
    if (!ga) return;
    let rafScheduled = false;
    let nextX = 0, nextY = 0;
    const flush = () => {
      rafScheduled = false;
      ga.style.setProperty('--cam-tx', nextX.toFixed(3));
      ga.style.setProperty('--cam-ty', nextY.toFixed(3));
    };
    document.addEventListener('mousemove', (e) => {
      // -1 at left edge, +1 at right; same for vertical
      const cx = (e.clientX / window.innerWidth)  * 2 - 1;
      const cy = (e.clientY / window.innerHeight) * 2 - 1;
      // Soft attenuation — the eye shouldn't see jitter, only
      // smooth drift as the cursor crosses the screen.
      nextX = Math.max(-1, Math.min(1, cx));
      nextY = Math.max(-1, Math.min(1, cy));
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(flush);
      }
    }, { passive: true });
  },

  installHandTilt() {
    if (this._handTiltInstalled) return;
    this._handTiltInstalled = true;
    // Both hand cards and tricks get the 3D tilt. Hand cards live
    // inside a .hand-card-wrapper (the CSS keys the transform off
    // that wrapper's hover + its child card). Tricks don't have a
    // wrapper — the .trick-card / .draft-card.trick-draft element
    // IS the tilt target, so we set the vars on the card itself.
    // Targets: hand-wrapper (sets vars on wrapper, child card reads them),
    // trick / draft / board-ally / board-enemy (vars set on the card
    // itself since they have no wrapper).
    //
    // ============================================================
    // AAA RE-WRITE — rAF LERP LOOP
    // ============================================================
    // Previous implementation wrote --tilt-x / --tilt-y CSS variables
    // DIRECTLY from raw mousemove (60-120 Hz). That fought the CSS
    // `transition: transform 180ms` on the hover state — every
    // mousemove restarted the transition, producing the judder the
    // user reported ("very janky, not smooth at all"). Industry
    // consensus (rachsmith.com/lerp, simeydotme/pokemon-cards-css):
    // mousemove writes a TARGET, rAF lerps current → target each
    // frame, rAF writes the CSS var. Active-hover CSS transition
    // also dropped (see style.css block) so the rAF loop fully owns
    // the per-frame transform.
    //
    // Lerp factor: 0.20 — pokemon-cards-css uses spring-damp
    // equivalent ~0.18; bumping slightly to 0.20 gives a touch more
    // responsiveness without overshoot. Smaller = silkier but more
    // lag; larger = snappier but the lerp benefit fades.
    //
    // ONE rAF loop runs at a time, walking the active-target list
    // (kept tiny — usually 0 or 1 card hovered at once). The loop
    // self-terminates when every target is at-rest (|delta| < 0.001).
    // .enc-card added so codex cards also get cursor-following bevel +
    // holographic sheen on the portrait. Those effects read --tilt-x /
    // --tilt-y CSS variables; without enc-card in the selector list
    // the codex portrait would show a flat fallback (tilt=0) instead
    // of the 3D hologram effect.
    const TILT_SELECTORS = '.hand-card-wrapper, .trick-card, .draft-card.trick-draft, .card.ally-card, .card.enemy-card, .card.enc-card';
    const clamp = (v) => v < -1 ? -1 : v > 1 ? 1 : v;
    const LERP = 0.20;
    const REST_EPSILON = 0.001;
    // Per-target state: { current: {x,y}, target: {x,y} }. Stored
    // in a WeakMap so DOM removal cleans up automatically.
    const tiltState = new WeakMap();
    let raf = 0;

    const ensureState = (el) => {
      let s = tiltState.get(el);
      if (!s) {
        s = { cx: 0, cy: 0, tx: 0, ty: 0, active: false };
        tiltState.set(el, s);
      }
      return s;
    };

    // The hovered list — targets that have non-zero target OR
    // current values, so the loop can iterate without scanning the
    // whole DOM. Kept as a Set so add/remove is O(1) and we de-dupe.
    const hovered = new Set();

    const writeVars = (el, x, y) => {
      el.style.setProperty('--tilt-x', x.toFixed(3));
      el.style.setProperty('--tilt-y', y.toFixed(3));
    };

    const tick = () => {
      raf = 0;
      let stillMoving = false;
      hovered.forEach(el => {
        const s = tiltState.get(el);
        if (!s) { hovered.delete(el); return; }
        // Lerp current toward target.
        s.cx = s.cx + (s.tx - s.cx) * LERP;
        s.cy = s.cy + (s.ty - s.cy) * LERP;
        // Snap to exact target when within epsilon — prevents
        // floating-point creep that would keep the rAF alive forever.
        const dx = Math.abs(s.tx - s.cx);
        const dy = Math.abs(s.ty - s.cy);
        if (dx < REST_EPSILON && dy < REST_EPSILON) {
          s.cx = s.tx; s.cy = s.ty;
          // If target is also (0, 0) AND not actively hovered, drop
          // it from the loop so we don't tick forever.
          if (!s.active && s.tx === 0 && s.ty === 0) hovered.delete(el);
        } else {
          stillMoving = true;
        }
        writeVars(el, s.cx, s.cy);
      });
      if (stillMoving || hovered.size > 0) raf = requestAnimationFrame(tick);
    };

    const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

    document.addEventListener('mousemove', (e) => {
      const target = e.target.closest && e.target.closest(TILT_SELECTORS);
      if (!target) return;
      // For .hand-card-wrapper the wrapper itself ISN'T scaled (only
      // the inner .card.hand-card is). Read from the inner card's
      // rect so the tilt magnitude maps to the visible enlarged card.
      const inner = target.classList.contains('hand-card-wrapper')
        ? target.querySelector('.card.hand-card')
        : null;
      const r = (inner || target).getBoundingClientRect();
      const x = clamp(((e.clientX - r.left) / r.width  - 0.5) * 2);
      const y = clamp(((e.clientY - r.top)  / r.height - 0.5) * 2);
      const s = ensureState(target);
      s.tx = x; s.ty = y; s.active = true;
      hovered.add(target);
      kick();
    }, { passive: true });

    // Mouseleave per-target: set target to 0,0 so the lerp eases
    // back smoothly. Don't drop from hovered immediately — let tick
    // remove it once current also hits 0.
    document.addEventListener('mouseout', (e) => {
      const target = e.target.closest && e.target.closest(TILT_SELECTORS);
      if (!target) return;
      // relatedTarget inside the same tilt element = still inside
      const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(TILT_SELECTORS);
      if (to === target) return;
      const s = ensureState(target);
      s.tx = 0; s.ty = 0; s.active = false;
      kick();
    }, { passive: true });
  },

  // (b) Block-fill spark — on emitDmg 'block' events the block meter
  // ticks up; spawn a small spark that flies from the HP bar to the
  // block circle. Hooks into showDamageFloats event loop.
  spawnBlockSpark(side) {
    const hpBar = document.getElementById(side === 'player' ? 'player-hp-fill' : 'ai-hp-fill');
    const blockCircle = document.querySelector((side === 'player' ? '.player-bar' : '.ai-bar') + ' .block-circle');
    if (!hpBar || !blockCircle) return;
    const hpR = hpBar.getBoundingClientRect();
    const bcR = blockCircle.getBoundingClientRect();
    const sp = document.createElement('div');
    sp.className = 'block-spark side-' + (side === 'player' ? 'player' : 'ai');
    sp.style.left = `${hpR.right - 10}px`;
    sp.style.top  = `${hpR.top + hpR.height / 2 - 4}px`;
    sp.style.setProperty('--dx', `${bcR.left + bcR.width / 2 - hpR.right + 10}px`);
    sp.style.setProperty('--dy', `${bcR.top + bcR.height / 2 - hpR.top - hpR.height / 2 + 4}px`);
    document.body.appendChild(sp);
    setTimeout(() => sp.remove(), 640);
  },

  // (A) Stat counter flip: compare previous stat values and flip the
  // orb when they change. Called after every renderBoard.
  _lastCardStats: new Map(),
  animateStatChanges() {
    if (!Game.state || !Game.state.lanes) return;
    Game.state.lanes.forEach(lane => {
      ['player', 'ai'].forEach(side => {
        const card = lane[side];
        if (!card || card.id == null) return;
        const prev = this._lastCardStats.get(card.id) || {};
        const atk = card.attack, hp = card.currentHealth;
        if (prev.atk != null && prev.atk !== atk) this._flipStatOrb(card.id, 'atk');
        if (prev.hp  != null && prev.hp  !== hp)  this._flipStatOrb(card.id, 'hp');
        this._lastCardStats.set(card.id, { atk, hp });
      });
    });
  },
  _flipStatOrb(cardId, which) {
    const cardEl = document.querySelector(`[data-card-id="${cardId}"]`);
    if (!cardEl) return;
    const orb = cardEl.querySelector('.stat-' + which);
    if (!orb) return;
    orb.classList.remove('stat-changed');
    void orb.offsetWidth;
    orb.classList.add('stat-changed');
    setTimeout(() => orb.classList.remove('stat-changed'), 380);
    // Tick-up the digit itself: count from prev → current over ~380ms.
    // Reads the previous integer from data-prev-stat (set by us last
    // tick) so re-renders don't lose history. Plays a smooth digit
    // count instead of an instant snap — small detail, big polish.
    this._tickStatDigit(orb);
  },

  // Tick a stat orb's digit text from its prior numeric value to its
  // current rendered value, over 380ms with ease-out. Idempotent: if
  // the orb's text isn't a clean integer, skip (e.g. "X" placeholder).
  _tickStatDigit(orb) {
    const txt = (orb.textContent || '').trim();
    const target = parseInt(txt, 10);
    if (!Number.isFinite(target)) return;
    const prevAttr = orb.getAttribute('data-prev-stat');
    const prev = prevAttr != null ? parseInt(prevAttr, 10) : target;
    orb.setAttribute('data-prev-stat', String(target));
    if (!Number.isFinite(prev) || prev === target) return;
    // Cancel any in-flight tick on this orb so back-to-back changes
    // don't stack interleaved counters.
    if (orb._tickRaf) cancelAnimationFrame(orb._tickRaf);
    const t0 = performance.now();
    const dur = 380;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      // ease-out-quart — fast start, smooth landing on the final digit.
      const eased = 1 - Math.pow(1 - p, 4);
      const cur = Math.round(prev + (target - prev) * eased);
      // Set text directly; don't go through innerHTML to keep child
      // adornments (badge dots, etc.) untouched.
      if (orb.firstChild && orb.firstChild.nodeType === 3) {
        orb.firstChild.nodeValue = String(cur);
      } else {
        orb.textContent = String(cur);
      }
      if (p < 1) orb._tickRaf = requestAnimationFrame(tick);
      else orb._tickRaf = null;
    };
    orb._tickRaf = requestAnimationFrame(tick);
  },

  // ===================== HIT-PAUSE =====================
  // Briefly freeze ALL board animations + transitions when something
  // big lands (a kill, a lethal HP-bar hit). 90ms is the sweet spot —
  // long enough that the eye locks onto the moment, short enough that
  // gameplay doesn't drag. Re-entry-safe: nested calls extend the
  // pause window rather than stacking timers.
  hitPause(ms) {
    const dur = Math.max(40, Math.min(180, ms || 90));
    if (this._hitPauseTimer) clearTimeout(this._hitPauseTimer);
    document.body.classList.add('hit-pause');
    this._hitPauseTimer = setTimeout(() => {
      document.body.classList.remove('hit-pause');
      this._hitPauseTimer = null;
    }, dur);
  },

  // ===================== HP DRAIN PULSE =====================
  // Fires the leading-edge brightness pulse on the HP bar fill when
  // damage lands on the player/AI HP bar. Layered on top of the
  // existing damage floater + bar-width transition.
  pulseHpEdge(side) {
    const el = document.getElementById(side === 'player' ? 'player-hp-fill' : 'ai-hp-fill');
    if (!el) return;
    el.classList.remove('hp-edge-pulse');
    void el.offsetWidth;
    el.classList.add('hp-edge-pulse');
    setTimeout(() => el.classList.remove('hp-edge-pulse'), 340);
  },

  // ===================== KILLING-BLOW CINEMATIC =====================
  // Fired when a hit takes player or AI HP to zero — the match-ending
  // moment. Bigger than the regular hit-pause: 240ms freeze + radial
  // vignette closing in on the impact point + warm theme-tinted
  // brightness pop. Reads as a cinematic match-end beat.
  //
  // side: 'player' | 'ai' — which side just lost.
  // anchor: optional {x,y} of the impact point in viewport coords. Falls
  //   back to the middle of the side's HP bar.
  killingBlowCinema(side, anchor) {
    // Tint the flash by outcome — cyan for player victory (AI side
    // lost), red for player defeat (player side lost). Anchored at
    // the losing side's HP bar by default.
    const tint = side === 'ai'
      ? 'rgba(127,208,255,0.22)'   // we won — cyan victory tint
      : 'rgba(231,76,60,0.22)';    // we lost — red defeat tint
    let cx = anchor && anchor.x, cy = anchor && anchor.y;
    if (cx == null || cy == null) {
      const bar = document.getElementById(side === 'player' ? 'player-hp-fill' : 'ai-hp-fill');
      const r = bar && bar.getBoundingClientRect();
      if (r) { cx = r.left + r.width * 0.92; cy = r.top + r.height / 2; }
      else { cx = window.innerWidth / 2; cy = window.innerHeight / 2; }
    }
    const xPct = ((cx / window.innerWidth)  * 100).toFixed(1) + '%';
    const yPct = ((cy / window.innerHeight) * 100).toFixed(1) + '%';
    document.body.style.setProperty('--kb-x', xPct);
    document.body.style.setProperty('--kb-y', yPct);
    document.body.style.setProperty('--kb-tint', tint);
    // Add the class fresh so re-entrant calls retrigger the keyframes.
    document.body.classList.remove('killing-blow-cinema');
    void document.body.offsetWidth;
    document.body.classList.add('killing-blow-cinema');
    // Pair with a longer hit-pause so the freeze and the visual
    // overlap. 220ms is long enough to feel like time stopped without
    // dragging on.
    this.hitPause(220);
    setTimeout(() => {
      document.body.classList.remove('killing-blow-cinema');
    }, 720);
  },

  // ===================== CURSOR-ANCHORED BOARD LIGHT =====================
  // Tracks the cursor's position over the board (rAF-throttled) and
  // updates two CSS variables — --bx, --by — which the .board::after
  // overlay uses to anchor a soft 7% radial brightness boost. Fades in
  // when the cursor enters the board area, out when it leaves. Pure
  // CSS interpolation does the heavy lifting; the JS just streams
  // coordinates and toggles a fade var. Idempotent install.
  installBoardCursorLight() {
    if (this._boardCursorLightInstalled) return;
    const board = document.getElementById('board');
    if (!board) return;
    this._boardCursorLightInstalled = true;
    let pendingX = 50, pendingY = 50, raf = null;
    // PERF FIX: cache the board rect and only recompute on resize.
    // Previously getBoundingClientRect() ran on EVERY mousemove (60-
    // 120Hz), forcing a synchronous layout read on each event before
    // the rAF throttle could even kick in. The event handler blocked
    // until the layout read completed, causing the "cursor takes
    // time to register" lag the user reported. Now the rect is
    // computed lazily and reused across events; only invalidated
    // when the window resizes (board layout changes).
    let cachedRect = null;
    const getRect = () => {
      if (!cachedRect) cachedRect = board.getBoundingClientRect();
      return cachedRect;
    };
    const invalidateRect = () => { cachedRect = null; };
    window.addEventListener('resize', invalidateRect, { passive: true });
    window.addEventListener('scroll', invalidateRect, { passive: true });
    const flush = () => {
      raf = null;
      board.style.setProperty('--bx', pendingX + '%');
      board.style.setProperty('--by', pendingY + '%');
    };
    board.addEventListener('mousemove', (e) => {
      const rect = getRect();
      pendingX = ((e.clientX - rect.left) / rect.width  * 100).toFixed(1);
      pendingY = ((e.clientY - rect.top)  / rect.height * 100).toFixed(1);
      if (!raf) raf = requestAnimationFrame(flush);
    }, { passive: true });
    board.addEventListener('mouseenter', () => {
      // Recompute on enter — board could have moved (round transition).
      invalidateRect();
      board.style.setProperty('--b-light', '1');
    });
    board.addEventListener('mouseleave', () => {
      board.style.setProperty('--b-light', '0');
    });
  },

  // ===================== KILL-CAM MICRO-CINEMA =====================
  // Fired in addition to the regular 90ms hit-pause when a board card
  // dies. Adds a radial warm flash anchored at the killed card's
  // viewport coords, plus a brief desaturation of the rest of the
  // board so the eye locks on the kill. Pairs with a pop-out scale
  // animation on the dying card itself before renderBoard wipes it.
  //
  // killedCard: the card object that just hit 0 HP. We look up its
  //   DOM element by data-card-id to get the rect. If the element
  //   isn't found (cleanup race), fall back to centering on the board.
  killcamFlash(killedCard) {
    if (this._killcamSuppressed) return;
    const board = document.getElementById('board');
    if (!board) return;
    let cx = 50, cy = 50;
    let cardEl = null;
    if (killedCard && killedCard.id != null) {
      cardEl = board.querySelector(`.card[data-card-id="${killedCard.id}"]`);
      if (cardEl) {
        const rect = cardEl.getBoundingClientRect();
        const bRect = board.getBoundingClientRect();
        cx = ((rect.left + rect.width / 2 - bRect.left) / bRect.width * 100).toFixed(1);
        cy = ((rect.top  + rect.height / 2 - bRect.top)  / bRect.height * 100).toFixed(1);
      }
    }
    board.style.setProperty('--kc-x', cx + '%');
    board.style.setProperty('--kc-y', cy + '%');
    document.body.classList.remove('killcam');
    void document.body.offsetWidth;
    document.body.classList.add('killcam');
    if (cardEl) {
      cardEl.classList.remove('card-killcam-target');
      void cardEl.offsetWidth;
      cardEl.classList.add('card-killcam-target');
    }
    if (this._killcamTimer) clearTimeout(this._killcamTimer);
    this._killcamTimer = setTimeout(() => {
      document.body.classList.remove('killcam');
      this._killcamTimer = null;
    }, 320);
  },

  // ===================== ROUND-END BEAM SWEEP =====================
  // Fires a soft horizontal beam that sweeps the board top-to-bottom
  // between rounds. Punctuates the match rhythm — gives the eye a
  // 600-700ms exhale beat between the chaos of one round and the
  // setup of the next. Toggled by hooking Game.startRound (a wrap
  // installed at first call here).
  installRoundSweep() {
    if (this._roundSweepHooked) return;
    if (typeof Game === 'undefined' || typeof Game.startRound !== 'function') return;
    this._roundSweepHooked = true;
    const orig = Game.startRound.bind(Game);
    Game.startRound = (...args) => {
      // Skip the sweep on round 1 — there's no "previous round" to
      // close out, and the match-start render already has its own
      // entrance flourish.
      const wasFirstRound = !Game.state || (Game.state.round || 0) <= 0;
      const r = orig(...args);
      if (!wasFirstRound) {
        const board = document.getElementById('board');
        if (board) {
          board.classList.remove('round-sweep');
          void board.offsetWidth;
          board.classList.add('round-sweep');
          setTimeout(() => board.classList.remove('round-sweep'), 760);
        }
      }
      return r;
    };
  },

  // ===================== TRON FLARE PASS =====================
  // Visual polish wave inspired by Tron Legacy / Cyberpunk 2077 /
  // Marvel Snap research. Adds:
  //   • Mouse-parallax background grid (~5px max, subtle depth)
  //   • Chromatic-aberration flash on card hit (RGB split, 220ms)
  //   • Play-afterimage trail (200ms ghost in lane after card lands)
  //   • Game-over glitch text (RGB-split scramble, 380ms)
  //
  // Hooks Game.applyCombatDamage, Game.dealDamage, Game.playCard,
  // Game.playCardFree, and UI.showGameOverScreen so the engine fires
  // these naturally without flag-passing. All gated on prefers-
  // reduced-motion and skipped when Game.state isn't present.
  installTronFlare() {
    if (this._tronFlareHooked) return;
    this._tronFlareHooked = true;
    if (this._reducedMotion && this._reducedMotion()) return;

    // Mouse-parallax: smooth pointer-tracked offset on body, read by
    // CSS to translate the background grid. Listener is passive so
    // it never blocks scroll; throttled via rAF so high-DPI mice
    // don't ddos style recalc.
    let pendingMx = 0, pendingMy = 0, rafScheduled = false;
    const setParallax = () => {
      rafScheduled = false;
      document.body.style.setProperty('--mx', pendingMx.toFixed(1) + 'px');
      document.body.style.setProperty('--my', pendingMy.toFixed(1) + 'px');
    };
    window.addEventListener('mousemove', (e) => {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      // Clamp to ±5px, multiply by -1 so background drifts AGAINST
      // the cursor (depth illusion: closer thing follows cursor,
      // farther background pushes opposite).
      pendingMx = ((cx - e.clientX) / cx) * 5;
      pendingMy = ((cy - e.clientY) / cy) * 5;
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(setParallax);
      }
    }, { passive: true });

    // Chromatic-aberration flash on hit. Wrap applyCombatDamage so any
    // landed combat hit pulses .hit-chrom on the target card element.
    if (typeof Game !== 'undefined' && Game.applyCombatDamage) {
      const orig = Game.applyCombatDamage.bind(Game);
      Game.applyCombatDamage = function (attacker, target, opts) {
        const r = orig(attacker, target, opts);
        // Only flash on actually-landed damage. r === true means kill,
        // r === false means evade/block/whiff. Either way the swing
        // landed visually, but only damage-landed events should pulse
        // — so check the target's currentHealth went down OR it died.
        if (r === true && target && target.id != null) {
          UI._flashHitChrom(target.id);
        }
        return r;
      };
    }
    // Same wrap for dealDamage (handles trick + ability + splash hits).
    if (typeof Game !== 'undefined' && Game.dealDamage) {
      const orig = Game.dealDamage.bind(Game);
      Game.dealDamage = function (card, amount, source) {
        const before = card && card.currentHealth;
        const r = orig(card, amount, source);
        const after = card && card.currentHealth;
        if (card && card.id != null && typeof before === 'number' && typeof after === 'number' && after < before) {
          UI._flashHitChrom(card.id);
        }
        return r;
      };
    }

    // Play-afterimage. Wrap playCard / playCardFree so a 380ms ghost
    // stays in the lane the card just entered.
    const wrapPlay = (fnName) => {
      if (!Game[fnName]) return;
      const orig = Game[fnName].bind(Game);
      Game[fnName] = function (owner, card, laneIdx) {
        const r = orig(owner, card, laneIdx);
        // Only spawn afterimage if the card actually landed in the lane.
        if (card && card.id != null && typeof laneIdx === 'number' && laneIdx >= 0
            && Game.state && Game.state.lanes[laneIdx]
            && Game.state.lanes[laneIdx][owner] === card) {
          UI._spawnPlayAfterimage(card.id, laneIdx);
        }
        return r;
      };
    };
    wrapPlay('playCard');
    wrapPlay('playCardFree');

    // Game-over glitch. Wrap showGameOverScreen to add .glitch class
    // to the title element after it renders. Removes the class when
    // the screen closes so the animation plays again on rematch.
    if (typeof this.showGameOverScreen === 'function') {
      const orig = this.showGameOverScreen.bind(this);
      this.showGameOverScreen = function (winner) {
        const r = orig(winner);
        // Defer to next rAF so the title element is in the DOM.
        requestAnimationFrame(() => {
          const title = document.querySelector('.game-over-title');
          if (title) {
            title.classList.remove('glitch');
            void title.offsetWidth;
            title.classList.add('glitch');
          }
        });
        return r;
      };
    }
  },
  // Helpers — kept on UI so hooks above can reach them. Cheap, no-op
  // on missing element.
  _flashHitChrom(cardId) {
    const sel = '.card[data-card-id="' + String(cardId) + '"]';
    document.querySelectorAll(sel).forEach((el) => {
      el.classList.remove('hit-chrom');
      void el.offsetWidth;
      el.classList.add('hit-chrom');
      setTimeout(() => el.classList.remove('hit-chrom'), 260);
    });
  },
  _spawnPlayAfterimage(cardId, laneIdx) {
    const sel = '.card[data-card-id="' + String(cardId) + '"]';
    const src = document.querySelector(sel);
    if (!src) return;
    const r = src.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const ghost = document.createElement('div');
    ghost.className = 'card-play-afterimage';
    ghost.style.left = r.left + 'px';
    ghost.style.top = r.top + 'px';
    ghost.style.width = r.width + 'px';
    ghost.style.height = r.height + 'px';
    document.body.appendChild(ghost);
    setTimeout(() => ghost.remove(), 420);
  },

  // ===================== UNDO FEEDBACK =====================
  // Wraps Game.undo so a successful undo emits a clear visual + audible
  // confirmation: a "↩ Undone" toast, a brief reverse-flash on the
  // board so the eye registers something changed, and a soft nav SFX.
  // Without this the undo button felt under-confirmed — the user
  // wasn't sure if their click landed.
  installUndoFeedback() {
    if (this._undoFeedbackHooked) return;
    if (typeof Game === 'undefined' || typeof Game.undo !== 'function') return;
    this._undoFeedbackHooked = true;
    const orig = Game.undo.bind(Game);
    Game.undo = (...args) => {
      const remainingBefore = Game.history.length;
      const r = orig(...args);
      if (r) {
        // Toast — bottom-right corner, brief.
        if (this.showAITrickToast) {
          this.showAITrickToast(
            '↩ Undone',
            remainingBefore > 1 ? `${remainingBefore - 1} undo${remainingBefore - 1 === 1 ? '' : 's'} left` : 'Last undo used',
            'info'
          );
        }
        // Board reverse-flash — quick sweep that visually "rewinds"
        // the most recent action. Compositor-cheap; just toggles a
        // class for ~500ms.
        const board = document.getElementById('board');
        if (board) {
          board.classList.remove('board-undo-flash');
          void board.offsetWidth;  // restart the animation
          board.classList.add('board-undo-flash');
          setTimeout(() => board.classList.remove('board-undo-flash'), 520);
        }
        // Soft nav SFX so the action gets an audible ack.
        if (this.sfx && this.sfx.playNav) try { this.sfx.playNav(); } catch (e) {}
      }
      return r;
    };
  },

  // ===================== AI LAST-ACTION HIGHLIGHT =====================
  // Hook Game.playCard / Game.playTrick. When the AI takes an action,
  // stamp a transient marker on Game.state. The board renderer reads
  // this and applies a 1.5s pulse to the affected lane (or shows a
  // toast for tricks, since they don't have a lane). Helps the player
  // notice WHICH lane the AI just played into when multiple actions
  // happen in quick succession.
  installAiActionHighlight() {
    if (this._aiActionHooked) return;
    this._aiActionHooked = true;
    if (typeof Game !== 'undefined') {
      if (typeof Game.playCard === 'function') {
        const orig = Game.playCard.bind(Game);
        Game.playCard = (owner, card, laneIdx, ...rest) => {
          const r = orig(owner, card, laneIdx, ...rest);
          if (r && owner === 'ai' && Game.state && laneIdx != null) {
            Game.state._aiPulse = {
              kind: 'play',
              laneIdx,
              cardId: card && card.id,
              name: card && card.name,
              at: Date.now(),
            };
          }
          return r;
        };
      }
      if (typeof Game.playCardFree === 'function') {
        const orig = Game.playCardFree.bind(Game);
        Game.playCardFree = (owner, card, laneIdx, ...rest) => {
          const r = orig(owner, card, laneIdx, ...rest);
          if (r && owner === 'ai' && Game.state && laneIdx != null) {
            Game.state._aiPulse = {
              kind: 'play',
              laneIdx,
              cardId: card && card.id,
              name: card && card.name,
              at: Date.now(),
            };
          }
          return r;
        };
      }
      if (typeof Game.playTrick === 'function') {
        const orig = Game.playTrick.bind(Game);
        Game.playTrick = (owner, trick, ...rest) => {
          const r = orig(owner, trick, ...rest);
          if (r && owner === 'ai' && trick && trick.name) {
            // Tricks don't have a lane — surface as a toast so the
            // player sees what just hit them. Existing toast helper
            // gets the right styling for trick-cast notifications.
            if (this.showAITrickToast) {
              this.showAITrickToast(`AI played ${trick.name}`, trick.desc || '', 'trick');
            }
          }
          return r;
        };
      }
    }
  },

  // ===================== CASCADE STAGGER =====================
  // Helper for multi-card simultaneous events (e.g. Thanos snap, Darkseid
  // wipe). Instead of every card reacting in the same frame — which the
  // eye reads as a chaotic flash — schedule each callback with a
  // configurable per-item stagger so the chain visibly traces through
  // the affected cards. Returns a Promise that resolves when the last
  // staggered callback has fired.
  cascadeStagger(items, perItemMs, fn) {
    return new Promise((resolve) => {
      if (!items || !items.length) return resolve();
      const dt = perItemMs == null ? 50 : Math.max(0, perItemMs);
      let i = 0;
      const fire = () => {
        try { fn(items[i], i); } catch (e) { console.error(e); }
        i++;
        if (i >= items.length) resolve();
        else setTimeout(fire, dt);
      };
      fire();
    });
  },

  // ===================== WILL-CHANGE HYGIENE =====================
  // Add will-change before an animation, strip after. CSS `will-change`
  // hints to the browser to keep an element on its own composite layer;
  // leaving it on permanently fragments the GPU layer cache. Use this
  // helper around any one-shot animation that mutates transform/opacity
  // so the layer is reclaimed once the motion is done.
  withWillChange(el, props, ms) {
    if (!el) return;
    el.style.willChange = props || 'transform, opacity';
    setTimeout(() => {
      // Only clear if we still own this slot — another animation may
      // have re-set will-change in the meantime.
      if (el.style.willChange === (props || 'transform, opacity')) {
        el.style.willChange = '';
      }
    }, ms || 800);
  },

  // (B) Energy spend flash — triggered from Game.playCard via a UI hook.
  // Takes an optional `amount` so we can pop a floating "-N" indicator
  // out of the orb; makes the cost legible without waiting for the HUD
  // number to tick down.
  flashEnergySpend(side, amount) {
    const el = document.querySelector((side === 'player' ? '#player-energy-display' : '#ai-energy-display') + ' .energy-text');
    if (!el) return;
    el.classList.remove('energy-spend');
    void el.offsetWidth;
    el.classList.add('energy-spend');
    setTimeout(() => el.classList.remove('energy-spend'), 470);
    if (amount && amount > 0) {
      const host = el.parentElement;
      if (host) {
        host.style.position = host.style.position || 'relative';
        const float = document.createElement('div');
        float.className = 'energy-cost-float';
        float.textContent = '-' + amount;
        host.appendChild(float);
        setTimeout(() => float.remove(), 900);
      }
    }
  },

  // (F) Currency orb spin on round start — piggybacks the round-tick
  // detection. Adds spin class to both energy orbs.
  spinEnergyOrbs() {
    ['player-energy-display', 'ai-energy-display'].forEach(id => {
      const el = document.querySelector('#' + id + ' .energy-text');
      if (!el) return;
      el.classList.remove('energy-round-spin');
      void el.offsetWidth;
      el.classList.add('energy-round-spin');
      setTimeout(() => el.classList.remove('energy-round-spin'), 620);
    });
  },

  // (N) Round-start big banner
  showRoundBanner(round) {
    const el = document.getElementById('round-banner');
    if (!el) return;
    el.textContent = 'Round ' + round;
    el.classList.remove('active');
    void el.offsetWidth;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 1800);
  },

  // (L) Main-menu ambient particles. Spawns 18 drifting dots once
  // when the main menu opens; removed when we leave the menu.
  _mmParticlesEl: null,
  startMenuParticles() {
    if (this._mmParticlesEl) return;
    const host = document.createElement('div');
    host.className = 'mm-particles';
    const N = 18;
    for (let i = 0; i < N; i++) {
      const p = document.createElement('div');
      p.className = 'mm-particle';
      const startX = Math.random() * 100;
      const startY = Math.random() * 100;
      const dirX = (Math.random() - 0.5) * 2;
      const dirY = (Math.random() - 0.5) * 2;
      const len = 300 + Math.random() * 600;
      p.style.left = `${startX}%`;
      p.style.top = `${startY}%`;
      p.style.setProperty('--dx', `${dirX * len}px`);
      p.style.setProperty('--dy', `${dirY * len}px`);
      p.style.animationDuration = `${18 + Math.random() * 22}s`;
      p.style.animationDelay = `${-Math.random() * 20}s`;
      host.appendChild(p);
    }
    document.body.appendChild(host);
    this._mmParticlesEl = host;
  },
  stopMenuParticles() {
    if (this._mmParticlesEl) { this._mmParticlesEl.remove(); this._mmParticlesEl = null; }
  },

  // (P) Gameplay ambient particles — sparse hexagons drifting behind
  // the board. Lives for the duration of any non-menu/non-draft phase.
  _gameParticlesEl: null,
  startGameParticles() {
    if (this._gameParticlesEl) return;
    const host = document.createElement('div');
    host.className = 'game-particles';
    const N = 12;
    for (let i = 0; i < N; i++) {
      const p = document.createElement('div');
      p.className = 'game-particle';
      const startX = Math.random() * 100;
      const startY = Math.random() * 100;
      const dirX = (Math.random() - 0.5) * 1.5;
      const dirY = (Math.random() - 0.5) * 1.5;
      const len = 200 + Math.random() * 400;
      // Wave 3 #9 — random Z depth (-200..+150) so when the
      // camera-parallax pivots, near particles slide more than
      // far ones. Real stereoscopic depth, not layered 2D
      // parallax. Negative Z = recessed deeper into the scene.
      const pz = (Math.random() * 350) - 200;
      p.style.left = `${startX}%`;
      p.style.top = `${startY}%`;
      p.style.setProperty('--dx', `${dirX * len}px`);
      p.style.setProperty('--dy', `${dirY * len}px`);
      p.style.setProperty('--pz', `${pz.toFixed(0)}px`);
      p.style.animationDuration = `${25 + Math.random() * 20}s`;
      p.style.animationDelay = `${-Math.random() * 30}s`;
      host.appendChild(p);
    }
    const gameArea = document.getElementById('game-area');
    if (gameArea) gameArea.appendChild(host);
    this._gameParticlesEl = host;
  },
  stopGameParticles() {
    if (this._gameParticlesEl) { this._gameParticlesEl.remove(); this._gameParticlesEl = null; }
  },

  // (O) Game-over count-up — animates stat numbers from 0 to target.
  animateCountUp(el, target, duration = 700) {
    if (!el) return;
    el.classList.add('counting', 'gosv-count');
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);  // easeOutCubic
      el.textContent = Math.round(target * eased);
      if (p < 1) requestAnimationFrame(step);
      else el.classList.remove('counting');
    };
    requestAnimationFrame(step);
  },

  // Custom cursor + trail. A small theme-tinted disc follows the mouse
  // and emits fading trail dots; over the board the disc swells into a
  // Tron ring that slowly spins. Keeps the "draw on a blackboard" feel
  // while staying cheap (10 recycled trail DOMs + transform-only anim).
  installCustomCursor() {
    if (this._customCursorInstalled) return;
    this._customCursorInstalled = true;
    const main = document.createElement('div');
    main.className = 'custom-cursor hidden';
    document.body.appendChild(main);
    const TRAIL = 10;
    const trails = [];
    for (let i = 0; i < TRAIL; i++) {
      const t = document.createElement('div');
      t.className = 'cursor-trail';
      document.body.appendChild(t);
      trails.push(t);
    }
    let trailIdx = 0;
    let lastTrailT = 0;
    let lastX = -1, lastY = -1;

    const move = (e) => {
      const x = e.clientX, y = e.clientY;
      main.classList.remove('hidden');
      main.style.left = x + 'px';
      main.style.top  = y + 'px';
      // One cursor style everywhere — no context-specific swell. Users
      // found the board's spinning disc + the interactive "hand" swell
      // distracting; cleaner to keep the disc visually consistent and
      // let the trail do the talking.
      main.classList.remove('on-disc', 'on-interactive');

      // Throttled trail emission + skip tiny moves. Trail dots are
      // placed at the TRAILING EDGE of the disc (opposite to motion
      // direction) so they stream behind the cursor like a wake,
      // never stacking in the middle of the disc.
      const now = performance.now();
      const dx = (lastX < 0) ? 0 : (x - lastX);
      const dy = (lastY < 0) ? 0 : (y - lastY);
      const dist = (lastX < 0) ? Infinity : Math.hypot(dx, dy);
      if (now - lastTrailT > 32 && dist > 4) {
        const DISC_RADIUS = 13;  // half of 26px cursor
        const len = dist || 1;
        // Offset opposite to motion — trail sits at the back of the disc.
        const tx = x - (dx / len) * DISC_RADIUS;
        const ty = y - (dy / len) * DISC_RADIUS;
        const d = trails[trailIdx];
        trailIdx = (trailIdx + 1) % TRAIL;
        d.style.left = tx + 'px';
        d.style.top  = ty + 'px';
        d.classList.remove('active');
        void d.offsetWidth;
        d.classList.add('active');
        lastTrailT = now;
        lastX = x; lastY = y;
      }
    };
    const leave = () => { main.classList.add('hidden'); };
    document.addEventListener('mousemove', move, { passive: true });
    document.addEventListener('mouseleave', leave);
    document.addEventListener('mouseenter', () => main.classList.remove('hidden'));
    // Press feedback — toggle a class on click to shrink the disc
    // briefly. Done via class so it composes with the CSS rotate
    // animation on .on-disc instead of stomping the transform.
    document.addEventListener('mousedown', () => main.classList.add('pressed'));
    document.addEventListener('mouseup',   () => main.classList.remove('pressed'));
  },

  // (M) Deck-viewer chip hover — show a floating card preview panel.
  installDeckPreview() {
    if (this._deckPreviewInstalled) return;
    this._deckPreviewInstalled = true;
    const tip = document.createElement('div');
    tip.className = 'deck-viewer-preview';
    tip.style.display = 'none';
    document.body.appendChild(tip);
    document.addEventListener('mouseover', (e) => {
      const chip = e.target.closest && e.target.closest('.deck-viewer-chip');
      if (!chip) return;
      const name = chip.textContent.trim();
      const def = (typeof CARD_DEFS !== 'undefined' && CARD_DEFS.find(c => c.name === name));
      if (!def) return;
      const tier = def.cost <= 3 ? 'common' : def.cost <= 6 ? 'uncommon' : def.cost <= 8 ? 'rare' : 'legendary';
      tip.innerHTML = `
        <div class="dvp-name">${def.name}</div>
        <div class="dvp-row"><span>Cost</span><span class="dvp-stat">${def.cost}</span></div>
        <div class="dvp-row"><span>ATK / HP</span><span><span class="dvp-stat dvp-stat-atk">${def.attack}</span> / <span class="dvp-stat dvp-stat-hp">${def.health}</span></span></div>
        <div class="dvp-row"><span>Tier</span><span class="dvp-tier-${tier}">${tier.toUpperCase()}</span></div>`;
      const r = chip.getBoundingClientRect();
      tip.style.left = `${r.right + 8}px`;
      tip.style.top  = `${r.top - 8}px`;
      tip.style.display = 'block';
    });
    document.addEventListener('mouseout', (e) => {
      const chip = e.target.closest && e.target.closest('.deck-viewer-chip');
      if (!chip) return;
      tip.style.display = 'none';
    });
  },

  // (j) HP shards — when a player HP hit lands, spawn 4-5 small
  // vertical shards falling off the HP bar's drain edge.
  spawnHpShards(side, amount) {
    if (amount < 2) return;  // skip tiny hits
    const bar = document.getElementById(side === 'player' ? 'player-hp-fill' : 'ai-hp-fill');
    if (!bar) return;
    const container = bar.parentElement;
    container.style.position = 'relative';
    const count = Math.min(5, 2 + Math.floor(amount / 2));
    for (let i = 0; i < count; i++) {
      const s = document.createElement('div');
      s.className = 'hp-shard';
      s.style.left = `${parseFloat(bar.style.width) || 100}%`;
      s.style.marginLeft = `-${i * 2}px`;
      s.style.setProperty('--sx', (Math.random() * 2 - 1).toFixed(2));
      s.style.animationDelay = `${i * 30}ms`;
      container.appendChild(s);
      setTimeout(() => s.remove(), 600);
    }
  }
};

// ---- GLOBAL HANDLERS ----
function draftPick(idx) { Game.draftPick(idx); }
function draftMulligan() { Game.draftMulligan(); }
// Undo the most recent draft pick. No-op when there's no snapshot on
// the stack (e.g. first pick of a phase); disabled state on the button
// is the primary gate, this is a belt-and-suspenders guard.
function draftUndo() { if (Game && Game.draftUndo) Game.draftUndo(); }
// Abort a draft and go back to the main menu. Confirms so a stray click
// doesn't nuke picks the user already made.
function draftQuitToMenu() {
  if (!confirm('Quit this draft and return to the main menu? Your picks will be lost.')) return;
  Game.goToMainMenu();
}
// Mode-select overlay button handler. Accepts any (players, deck) combo
// so 2v2 can plug in later without a rename. Deckbuilder goes through
// openDeckBuilder() instead of startMatch directly so the user can
// build / load a deck first.
function selectMode(players, deck) {
  Game.startMatch({ players: players, deck: deck });
}
function openDeckBuilder() { Game.enterDeckBuilder(); }

// ---- DECK BUILDER HANDLERS (phase 3) ----
// All deck state lives on Game.state.deckbuilder so re-renders rehydrate
// the same view. The UI just mutates this state and calls UI.render().

function dbAdd(section, name) {
  const db = Game.state.deckbuilder;
  if (!db) return;
  const CARD_MAX = 30, TRICK_MAX = 8, COPY_MAX = 2;
  const list = section === 'cards' ? db.cards : db.tricks;
  const max = section === 'cards' ? CARD_MAX : TRICK_MAX;
  if (list.length >= max) return;
  const copies = list.filter(n => n === name).length;
  if (copies >= COPY_MAX) return;
  list.push(name);
  db.presetName = null; // diverged from preset
  UI.render();
}

function dbRemove(section, name) {
  const db = Game.state.deckbuilder;
  if (!db) return;
  const list = section === 'cards' ? db.cards : db.tricks;
  const idx = list.lastIndexOf(name); // remove most recent copy
  if (idx >= 0) list.splice(idx, 1);
  db.presetName = null;
  UI.render();
}

function dbPreset(key) {
  const preset = (typeof STARTER_DECKS !== 'undefined') ? STARTER_DECKS[key] : null;
  if (!preset) return;
  Game.state.deckbuilder = {
    cards: preset.cards.slice(),
    tricks: preset.tricks.slice(),
    presetName: key
  };
  UI.render();
}

function dbClear() {
  Game.state.deckbuilder = { cards: [], tricks: [], presetName: null };
  UI.render();
}

// Persistence helper — every db filter mutation also flushes to
// localStorage so the deckbuilder remembers the user's last view
// (section / cost bucket / search query) across sessions. Read at
// open-time via UI._restoreDbFilterPrefs.
function _dbPersistFilter() {
  if (UI._dbFilter && UI._persistSet) UI._persistSet('deckbuilder', UI._dbFilter);
}
function dbSetFilter(section /*, cost */) {
  if (!UI._dbFilter) UI._dbFilter = { section: 'cards', cost: 'all' };
  UI._dbFilter.section = section;
  // Reset cost filter when switching sections — the cost buckets differ.
  UI._dbFilter.cost = 'all';
  _dbPersistFilter();
  UI.render();
}
function dbSetCost(cost) {
  if (!UI._dbFilter) UI._dbFilter = { section: 'cards', cost: 'all' };
  UI._dbFilter.cost = cost;
  _dbPersistFilter();
  UI.render();
}
// Live search — filters the grid by name. Fires on every keystroke.
// Focus/caret preservation in renderDeckBuilder keeps the user's
// position in the input across re-renders so typing is uninterrupted.
function dbSearch(q) {
  if (!UI._dbFilter) UI._dbFilter = { section: 'cards', cost: 'all', query: '', sort: 'cost' };
  UI._dbFilter.query = q == null ? '' : String(q);
  _dbPersistFilter();
  UI.render();
}
// Sort toggle — cost asc (default), name A→Z, or attack desc.
function dbSetSort(s) {
  if (!UI._dbFilter) UI._dbFilter = { section: 'cards', cost: 'all', query: '', sort: 'cost' };
  UI._dbFilter.sort = s || 'cost';
  UI.render();
}

function dbBack() {
  // Drop any in-progress build state when going back to the main menu —
  // if the user changes their mind, the empty builder greets them next time.
  Game.state.deckbuilder = null;
  Game.state.mode = null;
  Game.state.phase = 'main-menu';
  UI.render();
}

function dbSave() {
  const input = document.getElementById('db-save-name');
  if (!input) return;
  const name = (input.value || '').trim();
  if (!name) { alert('Enter a deck name before saving.'); return; }
  const db = Game.state.deckbuilder;
  if (!db) return;
  const saved = UI._dbGetSavedDecks();
  saved[name] = { cards: db.cards.slice(), tricks: db.tricks.slice() };
  UI._dbSetSavedDecks(saved);
  UI.render();
}
function dbLoad() {
  const sel = document.getElementById('db-load-select');
  if (!sel || !sel.value) return;
  const saved = UI._dbGetSavedDecks();
  const deck = saved[sel.value];
  if (!deck) return;
  Game.state.deckbuilder = {
    cards: (deck.cards || []).slice(),
    tricks: (deck.tricks || []).slice(),
    presetName: null
  };
  UI.render();
}
// Deck code export — serialize the current deckbuilder state to a
// compact base64 string the user can share. Format: base64(JSON) with
// version marker so future format bumps can fall back. Pure JS, no
// deps; clipboard write is best-effort (falls back to a prompt).
function dbExportCode() {
  const db = Game.state.deckbuilder;
  if (!db) return;
  if (!db.cards.length && !db.tricks.length) {
    alert('Deck is empty — add some cards first.');
    return;
  }
  const payload = { v: 1, c: db.cards, t: db.tricks };
  // btoa requires ASCII-safe input. Card names can contain accented chars
  // (Dr. Strange uses a plain ASCII period but we unescape unicode just in
  // case). Encode via unescape(encodeURIComponent(...)) to survive.
  const json = JSON.stringify(payload);
  const code = btoa(unescape(encodeURIComponent(json)));
  const blurb = `${payload.c.length} cards · ${payload.t.length} tricks`;
  // Try clipboard API; fall back to prompt so user can copy manually.
  const trySetClipboard = (text) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
    }
    return Promise.resolve(false);
  };
  trySetClipboard(code).then(ok => {
    if (ok) {
      // Flash a toast via UI.showAITrickToast if it exists; else alert.
      if (typeof UI !== 'undefined' && UI.showAITrickToast) {
        UI.showAITrickToast('Deck Code Copied', blurb + ' — paste anywhere to share', 'trick');
      } else {
        alert('Deck code copied to clipboard!\n(' + blurb + ')');
      }
    } else {
      window.prompt('Copy this deck code:', code);
    }
  });
}

// Deck code import — paste a code string, decode it, load into the
// deckbuilder. Validates structure + name existence before swapping.
function dbImportCode() {
  const code = (window.prompt('Paste deck code to import:') || '').trim();
  if (!code) return;
  let payload;
  try {
    const json = decodeURIComponent(escape(atob(code)));
    payload = JSON.parse(json);
  } catch (e) {
    alert('Invalid deck code — could not decode.');
    return;
  }
  if (!payload || payload.v !== 1 || !Array.isArray(payload.c) || !Array.isArray(payload.t)) {
    alert('Invalid deck code — unrecognized format.');
    return;
  }
  // Validate every card/trick exists in the current pool.
  const knownCards = new Set(CARD_DEFS.map(c => c.name));
  const knownTricks = new Set(
    (typeof TRICK_DEFS !== 'undefined' ? TRICK_DEFS : []).map(t => t.name)
  );
  const missingCards = payload.c.filter(n => !knownCards.has(n));
  const missingTricks = payload.t.filter(n => !knownTricks.has(n));
  if (missingCards.length || missingTricks.length) {
    alert('Deck code references unknown cards:\n' +
      missingCards.concat(missingTricks).slice(0, 8).join(', '));
    return;
  }
  Game.state.deckbuilder = {
    cards: payload.c.slice(),
    tricks: payload.t.slice(),
    presetName: null
  };
  UI.render();
}

function dbDelete() {
  const sel = document.getElementById('db-load-select');
  if (!sel || !sel.value) return;
  const saved = UI._dbGetSavedDecks();
  delete saved[sel.value];
  UI._dbSetSavedDecks(saved);
  UI.render();
}

function dbStart() {
  const db = Game.state.deckbuilder;
  if (!db) return;
  if (db.cards.length !== 30 || db.tricks.length !== 8) return; // shouldn't happen — button is disabled
  const customDeck = { cards: db.cards.slice(), tricks: db.tricks.slice() };
  // Clear the builder state and launch the match with the chosen deck.
  Game.state.deckbuilder = null;
  Game.startMatch({ players: '1v1', deck: 'deckbuilder', customDeck });
}

// ---- MY DECKS HANDLERS (phase 4b) ----
function mdPlay(name) {
  const saved = UI._dbGetSavedDecks();
  const deck = saved[name];
  if (!deck) return;
  if ((deck.cards || []).length !== 30 || (deck.tricks || []).length !== 8) {
    alert('This deck is invalid (needs exactly 30 cards + 8 tricks). Edit it first.');
    return;
  }
  // withDraft: true so the saved deck still goes through the full draft
  // phase (cards drafted from your saved 30 + tricks drafted from your
  // saved 8). User spec: "for my decks can you still incorporate the
  // whole draft phase". Without this, mdPlay-launched matches dealt
  // straight from the deck and skipped the draft experience.
  Game.startMatch({
    players: '1v1',
    deck: 'deckbuilder',
    withDraft: true,
    customDeck: { cards: deck.cards.slice(), tricks: deck.tricks.slice() }
  });
}

function mdEdit(name) {
  const saved = UI._dbGetSavedDecks();
  const deck = saved[name];
  if (!deck) return;
  // Open the builder pre-loaded with this deck's contents so the user
  // can tweak and re-save.
  Game.enterDeckBuilder({ cards: deck.cards || [], tricks: deck.tricks || [] });
}

function mdCopy(name) {
  const saved = UI._dbGetSavedDecks();
  const deck = saved[name];
  if (!deck) return;
  // Find a non-clashing name by appending (copy), (copy 2), etc.
  let newName = name + ' (copy)';
  let n = 2;
  while (saved[newName]) { newName = name + ' (copy ' + (n++) + ')'; }
  saved[newName] = { cards: (deck.cards || []).slice(), tricks: (deck.tricks || []).slice() };
  UI._dbSetSavedDecks(saved);
  UI.render();
}

function mdRename(name) {
  const fresh = prompt('Rename deck', name);
  if (!fresh || fresh === name) return;
  const trimmed = fresh.trim();
  if (!trimmed) return;
  const saved = UI._dbGetSavedDecks();
  if (saved[trimmed]) { alert('A deck with that name already exists.'); return; }
  if (!saved[name]) return;
  saved[trimmed] = saved[name];
  delete saved[name];
  UI._dbSetSavedDecks(saved);
  UI.render();
}

function mdDelete(name) {
  if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
  const saved = UI._dbGetSavedDecks();
  delete saved[name];
  UI._dbSetSavedDecks(saved);
  UI.render();
}

// ---- STATS HANDLERS (phase 4d/4e/4f) ----
// Stats panel — every filter mutation persists so the panel re-opens
// to the user's last-used view/source/sort.
function statsSort(key) {
  const ui = UI._statsUi;
  if (ui.sort.key === key) {
    ui.sort.dir = ui.sort.dir === 'desc' ? 'asc' : 'desc';
  } else {
    ui.sort.key = key;
    ui.sort.dir = key === 'name' ? 'asc' : 'desc';
  }
  UI._persistSet('stats', { source: ui.source, view: ui.view, sort: ui.sort });
  UI.render();
}
function statsSetSource(key) {
  UI._statsUi.source = key;
  UI._persistSet('stats', { source: UI._statsUi.source, view: UI._statsUi.view, sort: UI._statsUi.sort });
  UI.render();
}
function statsSetView(key) {
  UI._statsUi.view = key;
  // Reset sort to the canonical default for the active view so we don't
  // leave the user sorting by a column that no longer exists.
  UI._statsUi.sort = { key: 'winRate', dir: 'desc' };
  UI._persistSet('stats', { source: UI._statsUi.source, view: UI._statsUi.view, sort: UI._statsUi.sort });
  UI.render();
}
function statsToggleWeights() {
  UI._statsUi.aiWeightsOpen = !UI._statsUi.aiWeightsOpen;
  UI._persistSet('stats.aiWeightsOpen', UI._statsUi.aiWeightsOpen);
  UI.render();
}
function statsShowDetail(name) {
  UI._statsUi.detail = name;
  UI.render();
}
function statsCloseDetail() {
  UI._statsUi.detail = null;
  UI.render();
}
function statsReloadSim() {
  UI._simData = null;
  UI.render();
}
function statsResetLocal() {
  if (!confirm('Reset all locally-tracked card stats? Sim data is unaffected. This can\'t be undone.')) return;
  UI._statsReset();
  UI.render();
}
function statsExportCsv() {
  const rows = UI._buildStatsRows(UI._statsUi.source);
  const header = [
    'Name','Cost','Bucket','Games','GamesInDeck','Wins','WinRate','CiLo','CiHi',
    'Plays','PlayRate',
    'WeightedImpact','WeightedPerPlay','BucketAvg','ImpactIndex','MVPPlus',
    'RawImpactPerEnergy','Contribution',
    'MVP','MVPRate','Deaths',
    'Damage','Absorbed','EnergyGen','CardAdvantage',
    'Healing','Discount','Debuff',
    'Kills','FreezesApplied','StunsApplied','FearsApplied','McApplied'
  ];
  const lines = [header.join(',')];
  rows.forEach(r => {
    lines.push([
      '"' + r.name.replace(/"/g,'""') + '"',
      r.cost, r.bucket,
      r.drafts, r.gamesInDeck, r.wins,
      r.winRate.toFixed(4),
      r.ci.lo.toFixed(4), r.ci.hi.toFixed(4),
      r.plays, r.playRate.toFixed(4),
      r.weightedImpact.toFixed(2),
      r.weightedPerPlay.toFixed(4),
      (r.bucketAvg || 0).toFixed(4),
      r.impactIndex == null ? '' : r.impactIndex.toFixed(4),
      r.mvpPlus == null ? '' : r.mvpPlus,
      r.rawImpactPerEnergy === 999 ? '' : r.rawImpactPerEnergy.toFixed(4),
      r.contribution.toFixed(4),
      r.mvp, r.mvpRate.toFixed(4), r.deaths,
      (r.hpDamage || 0) + (r.cardDamage || 0), r.absorbed, r.energyGen, r.cardAdvantage,
      r.healing, r.discount, r.debuff,
      r.kills, r.freezesApplied, r.stunsApplied, r.fearsApplied, r.mcApplied
    ].join(','));
  });
  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `clb-stats-${UI._statsUi.source}-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 250);
}
function newGame() {
  const overlay = document.getElementById('game-over-overlay');
  if (overlay) { overlay.style.display = 'none'; overlay.className = 'game-over-overlay'; }
  // Clear any lingering peek state so the floating restore pill doesn't
  // outlive the match it was attached to.
  UI._peekedModal = null;
  const pill = document.getElementById('peek-restore');
  if (pill) pill.style.display = 'none';
  UI.stopVictoryConfetti();
  Game.init();
}
// Rematch — spin up a fresh match with the same mode + custom deck that
// just ended. Lets the player hit "Rematch" without bouncing through
// the main menu and mode picker. Captured at showGameOverScreen time
// because Game.init() nukes state.mode.
function rematch() {
  const cfg = UI._lastMatchConfig;
  const overlay = document.getElementById('game-over-overlay');
  if (overlay) { overlay.style.display = 'none'; overlay.className = 'game-over-overlay'; }
  UI._peekedModal = null;
  const pill = document.getElementById('peek-restore');
  if (pill) pill.style.display = 'none';
  UI.stopVictoryConfetti();
  Game.init();
  if (cfg && cfg.mode) {
    // Rebuild the startMatch args that were used. startMatch accepts
    // either a string (classic/deckbuilder) or a {deck, customDeck} object.
    const args = { players: cfg.players || '1v1', deck: cfg.mode };
    if (cfg.customDeck) args.customDeck = cfg.customDeck;
    Game.startMatch(args);
  } else {
    // Fallback: no captured config — send to mode picker.
    Game.goToModeSelect();
  }
}

function blockTrickPlay() {
  const s = Game.state;
  const trick = s.pendingBlockTrick;
  if (!trick) return;
  s.pendingBlockTrick = null;
  s.player.playedTrickPile.push({ name: trick.name, cost: trick.cost });
  Game.log(`  [BLOCK TRICK] You play ${trick.name} for free!`);
  if (trick.play) { try { trick.play(Game, 'player'); } catch (e) { console.error(e); } }
  Game.cleanupDead();
  UI.draftEl.style.display = 'none';
  document.getElementById('game-area').style.display = '';
  Game.resumeCombatIfWaiting();
  UI.render();
}

function blockTrickKeep() {
  const s = Game.state;
  const trick = s.pendingBlockTrick;
  if (!trick) return;
  s.pendingBlockTrick = null;
  Game.addToTrickHand('player', trick);
  Game.log(`  [BLOCK TRICK] You keep ${trick.name} in hand (costs ${trick.cost})`);
  UI.draftEl.style.display = 'none';
  document.getElementById('game-area').style.display = '';
  Game.resumeCombatIfWaiting();
  UI.render();
}

// Time Stone intercept handlers — the modal's two buttons route here.
// Counter spends Time Stone and blocks the enemy's trick. Allow lets
// it resolve normally. Both clear pendingTimeStoneIntercept and
// resume the AI's turn via Game.resumeCombatIfWaiting.
function timeStoneCounter() { if (Game && Game.timeStoneCounter) Game.timeStoneCounter(); }
function timeStoneAllow()   { if (Game && Game.timeStoneAllow)   Game.timeStoneAllow();   }

// Jump-offer modal handlers — mirror blockTrickPlay/Keep. Either choice
// clears pendingJumpOffer and resumes whatever combat continuation was
// parked while the player was deciding.
function jumpOfferPlay() {
  const s = Game.state;
  const offer = s.pendingJumpOffer;
  if (!offer) return;
  s.pendingJumpOffer = null;
  const card = s.player.hand.find(c => c.id === offer.cardId);
  if (card && card.jumpReady) {
    Game.playJumpCard('player', card);
  }
  Game.resumeCombatIfWaiting();
  UI.render();
}

function jumpOfferSkip() {
  const s = Game.state;
  const offer = s.pendingJumpOffer;
  if (!offer) return;
  s.pendingJumpOffer = null;
  const card = s.player.hand.find(c => c.id === offer.cardId);
  if (card) {
    card.jumpReady = false;
    card.jumpLane = undefined;
    Game.log(`  [JUMP] ${card.name}'s jump skipped by you.`);
  }
  Game.resumeCombatIfWaiting();
  UI.render();
}

function laneChoicePick(laneIdx) {
  const s = Game.state;
  const lc = s.pendingLaneChoice;
  if (!lc) return;
  Game._clearPromptTimeout();
  if (lc.owner === 'player' && Game.isPlayerTurn()) Game.snapshot();
  s.pendingLaneChoice = null;
  if (lc.callback) lc.callback(laneIdx);
  Game.cleanupDead();
  Game.resumeCombatIfWaiting();
  UI.render();
}

function cardChoicePick(idx) {
  const s = Game.state;
  const cc = s.pendingCardChoice;
  if (!cc) return;
  Game._clearPromptTimeout();
  if (cc.owner === 'player' && Game.isPlayerTurn()) Game.snapshot();
  s.pendingCardChoice = null;
  if (cc.callback) cc.callback(cc.cards[idx]);
  Game.cleanupDead();
  Game.resumeCombatIfWaiting();
  UI.render();
}

function bwlChoiceKeep() {
  const s = Game.state;
  const data = s.player.stolenByBWL;
  if (!data) return;
  s.player.stolenByBWL = null;
  Game.addToHand('player', data.card);
  Game.log(`  [BWL] You keep ${data.card.name} in hand!`);
  UI.draftEl.style.display = 'none';
  document.getElementById('game-area').style.display = '';
  // Wake any parked AI / combat continuation that was waiting on the
  // prompt to clear. Without this, hasPendingPrompt flips false but
  // whenPromptCleared's stored callback never fires, leaving the AI
  // loop frozen — user report: "When I keep a card from Batman Who
  // Laughs and he died, the AI is bugging out and I can't play."
  Game.resumeCombatIfWaiting();
  UI.render();
}

function bwlChoiceDestroy() {
  const s = Game.state;
  const data = s.player.stolenByBWL;
  if (!data) return;
  s.player.stolenByBWL = null;
  // Only buff BWL if he's still alive — if he died after the steal
  // armed but before the player chose Destroy, the +2/+2 should not
  // land on a corpse. The card is destroyed regardless (already
  // intercepted from the player's hand).
  if (data.bwl && data.bwl.currentHealth > 0) {
    data.bwl.attack += 2; data.bwl.currentHealth += 2; data.bwl.maxHealth += 2;
    Game.log(`  [BWL] You destroy ${data.card.name} — Batman Who Laughs gains +2/+2!`);
  } else {
    Game.log(`  [BWL] You destroy ${data.card.name} — but Batman Who Laughs is already dead.`);
  }
  UI.draftEl.style.display = 'none';
  document.getElementById('game-area').style.display = '';
  Game.resumeCombatIfWaiting();
  UI.render();
}

function kangChoicePick(idx) {
  const s = Game.state;
  const kc = s.pendingKangChoice;
  if (!kc) return;
  s.pendingKangChoice = null;
  const picked = kc.cards[idx];
  const other = kc.cards[1 - idx];
  // The rejected card drops back onto the Kang owner's own pile.
  Game.getDrawPile(kc.owner).push(other);
  const card = Game.createCardInstance(picked, kc.owner);
  card.cost = Math.max(0, card.cost - 2);
  Game.log(`  [KANG] Kept ${card.name} (cost reduced to ${card.cost})`);
  Game.addToHand(kc.owner, card);
  if (card.cost <= 2) {
    const open = Game.getOpenLanes(kc.owner);
    if (open.length && !card.isDiscardEffect) {
      Game.log(`  [KANG] ${card.name} costs ${card.cost} — bonus free play available!`);
      Game.promptLaneChoice(kc.owner, open, `Play ${card.name} FREE`,
        `Kang allows free play of ${card.name} (cost ${card.cost}). Choose lane or close to keep in hand.`,
        (lane) => { Game.playCardFree(kc.owner, card, lane); });
    }
  }
  UI.draftEl.style.display = 'none';
  document.getElementById('game-area').style.display = '';
  UI.render();
}

function toggleDeadPile(owner) {
  const overlay = document.getElementById('dead-pile-overlay');
  const title = document.getElementById('dead-pile-title');
  const container = document.getElementById('dead-pile-cards');
  const pile = Game.state[owner].deadPile;
  title.textContent = (owner === 'player' ? 'Your' : "AI's") + ' Dead Pile';
  // Ensure ranks are fresh — viewing the dead pile mid-match should
  // reflect the current MVP standings including cards in this pile.
  const ranks = UI.computeMvpRanks()[owner];
  const mvpStar = (c) => {
    if (!c || c.id == null) return '';
    const score = UI.mvpScoreOf(c);
    if (score <= 0) return '';
    let cls = '';
    if (c.id === ranks.firstId)       cls = 'mvp-gold';
    else if (c.id === ranks.secondId) cls = 'mvp-silver';
    if (!cls) return '';
    return `<span class="card-mvp-star ${cls}" title="MVP: ${score}"><svg viewBox="0 0 10 10" aria-hidden="true"><polygon points="5,0.3 6.3,3.7 10,3.9 7,6.1 8.1,9.7 5,7.6 1.9,9.7 3,6.1 0,3.9 3.7,3.7"/></svg></span>`;
  };
  container.innerHTML = pile.length ? pile.map(c => `
    <div class="dead-pile-card${c.isDiscardEffect ? ' discard-effect' : ''}">
      <div class="card-cost">${c.cost}</div>
      ${mvpStar(c)}
      <div class="card-name">${c.name}</div>
      ${c.isDiscardEffect ? '' : `<div class="card-stats"><span class="atk">${c.attack || '?'}</span> / <span class="hp">${c.health || '?'}</span></div>`}
    </div>`).join('') : '<p style="color:#888">No cards have died yet.</p>';
  overlay.style.display = 'flex';
}

function closeDeadPile() {
  document.getElementById('dead-pile-overlay').style.display = 'none';
}

// Played-trick history — reuses the dead-pile overlay chrome with
// trick-styled cards instead. Each side's `playedTrickPile` accumulates
// every trick they've cast this match (set by Game.playTrick). Visible
// for both sides so both players can count what's been used vs. what's
// still in the opponent's deck.
function toggleTrickHistory(owner) {
  const overlay = document.getElementById('dead-pile-overlay');
  const title = document.getElementById('dead-pile-title');
  const container = document.getElementById('dead-pile-cards');
  const pile = (Game.state[owner] && Game.state[owner].playedTrickPile) || [];
  title.textContent = (owner === 'player' ? 'Your' : "Opponent's") + ' Trick History';
  if (!pile.length) {
    container.innerHTML = '<p style="color:#888">No tricks played yet.</p>';
  } else {
    // Reuse trick-card chrome (cost orb, name banner, rarity strip,
    // ability badges, desc) so the history reads exactly like the
    // tricks the player saw in their hand. Look up the full trick
    // def by name so we have abilities + desc; the pile itself only
    // stores { name, cost } as a lightweight log entry.
    const trickDefs = (typeof TRICK_DEFS !== 'undefined') ? TRICK_DEFS : [];
    container.innerHTML = pile.map((p) => {
      const def = trickDefs.find(t => t.name === p.name) || { name: p.name, cost: p.cost, desc: '', abilities: [] };
      const rarity = UI.getTrickRarityStrip ? UI.getTrickRarityStrip(def.cost || 0) : '';
      const ab = (def.abilities && def.abilities.length)
        ? `<div class="card-abilities status-badges">${UI.formatAbilityBadges(def.abilities)}</div>` : '';
      return `<div class="trick-card history-trick">
        <span class="trick-cost">${def.cost != null ? def.cost : ''}</span>
        ${rarity}
        <div class="trick-name">${def.name}</div>
        ${ab}
        <div class="trick-desc">${UI.formatDesc(def.desc || '')}</div>
      </div>`;
    }).join('');
  }
  overlay.style.display = 'flex';
}

// ===================== SANDBOX (global console API) =====================
// Console-friendly façade so the user can drop into devtools and run:
//   Sandbox.spawn('Hulk')              → drops Hulk into player hand
//   Sandbox.spawn('Batarangs')         → drops the trick into player tricks
//   Sandbox.energy(99)                 → max energy
//   Sandbox.heal()                     → refill HP both sides
//   Sandbox.clearBoard()               → wipe all lanes
//   Sandbox.advanceRound()             → skip to next round
//   Sandbox.summonOnBoard('Iron Man', 0, 'ai') → place enemy in lane 0
window.Sandbox = {
  spawn(name) {
    if (!Game.state || !Game.state.player) { console.warn('Sandbox: no game in progress'); return null; }
    const cardDef = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS.find(c => c.name === name) : null;
    if (cardDef) {
      const inst = Game.createCardInstance(cardDef, 'player');
      Game.state.player.hand.push(inst);
      UI.render();
      return inst;
    }
    const trickDef = (typeof TRICK_DEFS !== 'undefined') ? TRICK_DEFS.find(t => t.name === name) : null;
    if (trickDef) {
      const inst = Game.createCardInstance ? Game.createCardInstance(trickDef, 'player') : Object.assign({}, trickDef);
      inst.id = 'sb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      Game.state.player.tricks.push(inst);
      UI.render();
      return inst;
    }
    console.warn('Sandbox: no card or trick named', name);
    return null;
  },
  energy(n) {
    if (!Game.state || !Game.state.player) return;
    Game.state.player.currency = n;
    Game.state.player.energy = n;
    UI.render();
  },
  heal(n) {
    if (!Game.state) return;
    n = n ?? 30;
    if (Game.state.player) Game.state.player.health = n;
    if (Game.state.ai)     Game.state.ai.health = n;
    UI.render();
  },
  clearBoard() {
    if (!Game.state || !Game.state.lanes) return;
    Game.state.lanes.forEach(L => { L.ai = null; L.player = null; L.trap = null; L.destroyed = false; });
    UI.render();
  },
  advanceRound() {
    if (!Game.state) return;
    Game.state.round = (Game.state.round || 0) + 1;
    UI.render();
  },
  summonOnBoard(name, laneIdx, side) {
    side = side || 'player';
    if (!Game.state || !Game.state.lanes || !Game.state.lanes[laneIdx]) return null;
    const def = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS.find(c => c.name === name) : null;
    if (!def) { console.warn('Sandbox: no card named', name); return null; }
    const inst = Game.createCardInstance(def, side);
    inst.lane = laneIdx;
    Game.state.lanes[laneIdx][side] = inst;
    UI.render();
    return inst;
  },
};

// Hotkey toggle for the sandbox panel: ` (backtick / tilde key).
// Works at any time after a match starts.
document.addEventListener('keydown', (e) => {
  if (e.key !== '`' && e.key !== '~') return;
  // Don't fire while the user is typing in an input/textarea.
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (UI.toggleSandboxPanel) UI.toggleSandboxPanel();
});

// Auto-start
UI.init();
Game.init();
