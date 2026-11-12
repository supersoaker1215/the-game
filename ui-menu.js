// ============================================================
// ui-menu.js — THE MENU + START SCREEN (split out of ui.js)
// ============================================================
// The start screen, the main menu and its in-shell submenus, keyboard nav, the backdrop scene hand-off, the now-playing/hero picker.
//
// Same contract as fx.js: this file loads BEFORE ui.js and only declares
// UI_MENU, a plain object of methods written exactly as they were inside the
// UI literal; ui.js merges it into UI right after that literal and before
// UI.init(). Methods keep `this`, so every UI.whatever call is unchanged.
// ============================================================
const UI_MENU = {
  // The MW3-style "mirror dimension" backdrop: a Tron grid in the left zone, a
  // single hero on the right, a vertical neon SEAM (mirror plane) between them,
  // and a faint mirrored REFLECTION of the hero spilling left off the seam onto
  // the grid. hero + reflect carry two cross-fade buffers each. Order matters:
  // grid (back) → reflect → hero → seam (front line).
  _menuSceneHTML() {
    // Full-bleed looping video that replaces the hero art. The host is empty;
    // _mountMenuVideo moves the one shared <video> into it after the HTML lands.
    return `
      <div class="mm-tron-grid" aria-hidden="true"></div>
      <div class="mm-bgvideo" aria-hidden="true"></div>`;
  },
  // MENU VIDEO — ONE element for the title AND the menu, created once and MOVED
  // between hosts so PRESS START continues the same shot (the menu re-renders
  // with innerHTML, which would restart a per-screen <video>). Muted +
  // playsinline lets iOS/Chrome autoplay without a gesture; the file has no
  // audio track, so the menu music is the only sound.
  MENU_VIDEO_SRC: 'video/menu-loop.mp4',
  MENU_VIDEO_POSTER: 'video/menu-loop.jpg',
  _menuVideoEl() {
    if (this._menuVideo) return this._menuVideo;
    const v = document.createElement('video');
    v.className = 'mm-video';
    v.muted = true; v.defaultMuted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
    v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('loop', '');
    v.setAttribute('aria-hidden', 'true'); v.setAttribute('disablepictureinpicture', '');
    v.preload = 'auto';
    v.poster = this.MENU_VIDEO_POSTER;
    v.src = this.MENU_VIDEO_SRC;
    this._menuVideo = v;
    // A hidden overlay (in a match) still DECODES a playing video — 1080p for
    // nothing, on battery. Play only while it is actually on screen.
    try {
      if (typeof IntersectionObserver !== 'undefined') {
        new IntersectionObserver((es) => {
          this._menuVideoOnScreen = es.some(e => e.isIntersecting);
          this._syncMenuVideo();
        }).observe(v);
      }
      document.addEventListener('visibilitychange', () => this._syncMenuVideo());
    } catch (e) {}
    return v;
  },
  _mountMenuVideo(host) {
    if (!host) return;
    // The backdrop is a SCENE (menu-scene.js): random each visit, switched from
    // the name bar along the bottom. The video is one of the scenes.
    if (typeof MenuScene !== 'undefined') { MenuScene.mount(host); return; }
    const v = this._menuVideoEl();
    if (v.parentNode !== host) host.appendChild(v);
    this._syncMenuVideo();
  },
  _syncMenuVideo() {
    const v = this._menuVideo;
    if (!v) return;
    let reduce = false;
    try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}
    const want = v.isConnected && !document.hidden && !reduce && this._menuVideoOnScreen !== false;
    if (want && v.paused) { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
    else if (!want && !v.paused) { try { v.pause(); } catch (e) {} }
  },
  // Live-sync the menu scene to current settings without a full re-render, so
  // the Settings controls preview in real time over the menu behind them.
  _applyMenuFlow() {
    const el = document.getElementById('main-menu-overlay');
    if (!el) return;
    const on = this.settings.menuFlow !== false;
    el.style.setProperty('--menu-flow-intensity', String(this.settings.menuFlowIntensity ?? 0.18));
    const sceneSel = ':scope > .mm-tron-grid, :scope > .mm-hero-reflect, :scope > .mm-bgvideo, :scope > .mm-seam';
    if (!on) { el.querySelectorAll(sceneSel).forEach(n => n.remove()); this._syncMenuVideo(); return; }
    if (!el.querySelector(':scope > .mm-bgvideo')) {
      const tmp = document.createElement('div');
      tmp.innerHTML = this._menuSceneHTML();
      const ref = el.firstChild;   // insert the scene before scrim/panel
      while (tmp.firstChild) el.insertBefore(tmp.firstChild, ref);
    }
    this._mountMenuVideo(el.querySelector(':scope > .mm-bgvideo'));
  },
  _menuHoverArtName(src) {
    if (!src) return null;
    let base = String(src).split('/').pop().split('?')[0].replace(/\.[a-z0-9]+$/i, '');
    base = base.replace(/-hover$/i, '');
    // A track can belong to more than one face (the Cog event heroes share one
    // theme), so stem → name alone can name the wrong one. A face pinned by the
    // title screen (_pinTrackFace) wins for that track.
    if (this._trackFace && this._trackFace.stem === base) return this._trackFace.name;
    if (!this._menuStemToName) this._menuStemToName = this._buildMenuStemMap();
    return this._menuStemToName[base] || null;
  },
  // Update the top now-playing credit (the hero NAME), its star, and the
  // highlight on the currently-playing row in the picker below.
  _pinTrackFace(src, name) {
    if (!src || !name) return;
    const stem = String(src).split('/').pop().split('?')[0].replace(/\.[a-z0-9]+$/i, '').replace(/-hover$/i, '');
    this._trackFace = { stem, name };
  },
  _updateNowPlaying(src) {
    if (this.MENU_SCORE_ON) {
      const np0 = document.querySelector('#main-menu-overlay .mm-nowplaying');
      if (np0) np0.textContent = this.menuScore.playing() ? ('♪ ' + this.menuScore.name()) : '';
      const pin0 = document.querySelector('#main-menu-overlay .mm-pin-hero');
      if (pin0) pin0.style.display = 'none';
      const pk = document.querySelector('#main-menu-overlay .mm-heropick');
      if (pk) pk.querySelectorAll('.mm-heropick-row').forEach(r => r.classList.toggle('is-active', r.dataset.score === String(this.menuScore._idx)));
      return;
    }
    const name = this._menuHoverArtName(src);
    const np = document.querySelector('#main-menu-overlay .mm-nowplaying');
    if (np) np.textContent = name ? ('♪ ' + name) : '';
    // Star: filled (★) when the CURRENT hero is your saved default.
    const pin = document.querySelector('#main-menu-overlay .mm-pin-hero');
    if (pin) {
      const isDefault = !!(name && this.settings.defaultMenuHero === name);
      pin.textContent = isDefault ? '★' : '☆';
      pin.classList.toggle('is-pinned', isDefault);
      pin.title = isDefault ? 'Unstar — no default (random)' : 'Star this hero as your default';
      pin.style.display = name ? '' : 'none';
    }
    // Highlight the playing hero's row in the picker.
    const picker = document.querySelector('#main-menu-overlay .mm-heropick');
    if (picker) picker.querySelectorAll('.mm-heropick-row').forEach(r =>
      r.classList.toggle('is-active', (r.dataset.hero || '') === (name || '')));
  },
  // Is `name` a valid menu-hero character (has a hover track)?
  _isMenuHeroName(name) {
    if (!name) return false;
    const srcs = (this._menuCharHoverSrcs && this._menuCharHoverSrcs()) || [];
    return srcs.some(s => this._menuHoverArtName(s) === name);
  },
  // ── Menu-hero picker (compact scrollable name list) ───────────────
  // Alphabetical list of menu-hero character names (those with a hover track).
  _menuHeroNames() {
    const srcs = (this._menuCharHoverSrcs && this._menuCharHoverSrcs()) || [];
    const names = srcs.map(s => this._menuHoverArtName(s)).filter(Boolean);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  },
  // Picker rows: alphabetical heroes. The saved default gets a ★ prefix
  // (.is-default); the playing hero is .is-active (set by _updateNowPlaying).
  _menuHeroPickerRowsHTML() {
    if (this.MENU_SCORE_ON) {
      return this.menuScore.SCORES.map((sc, i) =>
        `<button type="button" class="mm-heropick-row" data-score="${i}" role="option" onclick="UI.menuScore.start(${i});UI._updateNowPlaying(null)">${sc.name}</button>`).join('');
    }
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const cur = this.settings.defaultMenuHero || '';
    return this._menuHeroNames().map(n =>
      `<button type="button" class="mm-heropick-row${cur === n ? ' is-default' : ''}" data-hero="${esc(n)}" role="option" onclick="UI.playMenuHero(this.dataset.hero)">${esc(n)}</button>`
    ).join('');
  },
  // Click a picker row → play/preview that hero (switch the live art + hover).
  // Does NOT change your default — star the hero (top line) to make it default.
  playMenuHero(name) {
    if (!name) return;
    const src = this.sfx._srcForHeroName(name);
    if (!src) return;
    const audioOn = this.settings.menuMusic !== false && this.settings.sfxVolume !== 0;
    if (audioOn) this.sfx.crossfadeTo(src);   // art + credit + highlight follow the 'playing' event
    else this._updateMenuSideArt(src);        // audio off → set art (+ credit) directly
  },
  // Star / unstar the CURRENT hero as your default. When set, that hero leads
  // the menu on cold entry, then the rotation goes random. Per-browser.
  togglePinnedHero() {
    const name = this._menuHoverArtName(this.sfx && this.sfx._music && this.sfx._music.currentSrc);
    if (!name) return;   // no hero showing — nothing to star
    const wasDefault = this.settings.defaultMenuHero === name;
    this.settings.defaultMenuHero = wasDefault ? null : name;
    try { localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) {}
    UI._menuDefaultLed = true;
    this._markDefaultRow();
    this._updateNowPlaying(this.sfx && this.sfx._music && this.sfx._music.currentSrc);
    if (this.showAITrickToast) {
      this.showAITrickToast(wasDefault ? 'Default Cleared' : 'Default Set',
        wasDefault ? 'Your menu hero is random again.'
                   : name + ' greets you first, then it\'s random.', 'trick');
    }
  },
  // Apply the ★ default marker to the matching picker row and scroll it into
  // the picker's own window (scrollTop math only — never yanks the menu panel).
  _markDefaultRow() {
    const picker = document.querySelector('#main-menu-overlay .mm-heropick');
    if (!picker) return;
    const cur = this.settings.defaultMenuHero || '';
    let def = null;
    picker.querySelectorAll('.mm-heropick-row').forEach(r => {
      const on = (r.dataset.hero || '') === cur && cur !== '';
      r.classList.toggle('is-default', on);
      if (on) def = r;
    });
    if (def) picker.scrollTop = Math.max(0, def.offsetTop - (picker.clientHeight - def.offsetHeight) / 2);
  },
  // The menu-music rotation is DERIVED from CARD_SFX, the single source of truth
  // for hover audio: any card with a `hover` entry joins the rotation (and the
  // hero picker) automatically, so there is no roster to keep in sync.
  //
  // Exclusion is a DENYLIST, so new types are in by default. A card is excluded
  // only if it:
  //   • isn't in CARD_DEFS (tricks and Infinity Stones live in TRICK_DEFS —
  //     hover audio but no character to show), or
  //   • is an 'environment' (a place, so the hero panel would show scenery), or
  //   • resolves to no art path at all.
  //
  // The art check is cheap, NOT a guarantee the file exists:
  // getCardArtPathDefault() synthesizes "art/<Name>.png". A missing file 404s,
  // and _updateMenuSideArt's onerror keeps the previous hero on screen.
  //
  // The src comes from CARD_SFX rather than a copied literal so the menu track
  // stays byte-identical to the in-game hover, cache-bust ?v= included.
  _menuCharHoverSrcs() {
    if (this._charSrcs) return this._charSrcs;
    const out = [];
    const reg = (this.sfx && this.sfx.CARD_SFX) || {};
    for (const name of Object.keys(reg)) {
      const hv = reg[name] && reg[name].hover;
      if (!hv) continue;
      const src = (typeof hv === 'string') ? hv : hv.src;
      if (!src) continue;
      const def = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS.find(d => d.name === name) : null;
      // Events are allowed in by name; everything else still has to be a real,
      // non-environment card.
      if (!def && !(this._MENU_EVENT_HEROES && this._MENU_EVENT_HEROES.has(name))) continue;
      if (def && def.type === 'environment') continue;
      if (!this.getCardArtPathDefault(name)) continue;
      out.push(src);
    }
    // Only cache once CARD_SFX has actually populated — caching an empty list
    // during a cold load would pin the menu to silence for the whole session.
    if (out.length) this._charSrcs = out;
    return out;
  },
  // Pick a random menu-hero character (used as the fallback hero when menu
  // music is off, so the menu art is never blank).
  _pickRandomMenuHeroName() {
    const srcs = (this._menuCharHoverSrcs && this._menuCharHoverSrcs()) || [];
    if (!srcs.length) return null;
    const src = srcs[Math.floor(Math.random() * srcs.length)];
    return this._menuHoverArtName(src);
  },

  // Abandon the current match / draft / deckbuilder session from Settings and
  // return to the main menu. Confirms first; skips the confirm if already on
  // the main menu.
  quitToMainMenu() {
    const phase = Game && Game.state ? Game.state.phase : null;
    const inMatch = phase && phase !== 'main-menu' && phase !== 'mode-select'
                 && phase !== 'my-decks' && phase !== 'stats';
    const doQuit = () => { this.closeSettings(); if (Game && Game.goToMainMenu) Game.goToMainMenu(); };
    if (inMatch) {
      this.confirmModal('Return to the main menu? Your current match will be lost.',
        { title: 'Leave Match', okText: 'Leave', danger: true }).then(ok => { if (ok) doQuit(); });
      return;
    }
    doQuit();
  },

  // ===================== MAIN MENU (phase 4a) =====================
  // Landing screen. Clicking a button flips Game.state.phase to the target
  // screen and re-renders.
  // ---- TITLE SCREEN -------------------------------------------------------
  // A full-bleed hero (same picker as the menu), the wordmark centred, and a
  // PRESS START that breathes until any key or tap dismisses it.
  // Session-scoped: shows once per load, nothing persisted.
  _titleDone: false,
  renderTitleScreen(s) {
    // THE START SCREEN IS THE MENU WITHOUT ITS LIST. Same overlay classes, scene,
    // scrim, panel and .mm-header — only PRESS START stands where the option list
    // will appear, so pressing it swaps in the list and nothing else moves.
    const el = document.getElementById('main-menu-overlay');
    if (!el) return;
    el.classList.add('is-title', 'ts-menulike', 'mm-mw3', 'mm-four');
    el.innerHTML = `
      <div class="mm-tron-grid" aria-hidden="true"></div>
      <div class="mm-bgvideo" aria-hidden="true"></div>
      <div class="mm-scrim" aria-hidden="true"></div>
      <div class="mm-panel">
        <div class="mm-header">
          <h1 class="mm-title">the game</h1><div class="mm-tagline">Card Lane Battle</div>
        </div>
        <button type="button" class="ts-prompt" id="ts-prompt">Press Start</button>
        <button type="button" class="ts-options" onclick="UI.openSettings()">Options</button>
      </div>
      ${typeof MenuScene !== 'undefined' ? MenuScene.barHTML() : ''}`;
    this._mountMenuVideo(el.querySelector('.mm-bgvideo'));
    this._armTitleDismiss();
  },
  _armTitleDismiss() {
    if (this._titleArmed) return;
    this._titleArmed = true;
    // NOT stopPropagation: sfx.arm() listens for these same events on window
    // to unlock audio, and the whole point of the gate is that this press is
    // that gesture.
    const go = (e) => {
      if (this._titleDone) return;
      // Ignore modifier-only keys so holding Shift does not skip the screen.
      if (e && e.type === 'keydown' && /^(Shift|Control|Alt|Meta|CapsLock|Tab)$/.test(e.key || '')) return;
      // OPTIONS (and the settings cog, and anything inside Settings) open over
      // the start screen instead of dismissing it.
      const t = e && e.target;
      if (t && t.closest && t.closest('.ts-options, .mm-scene-bar, .settings-cog, .settings-overlay, .settings-modal, [role="dialog"]')) return;
      if (document.querySelector('.settings-overlay.active, .settings-overlay.open, .settings-overlay[style*="flex"]')) return;
      this.dismissTitle();
    };
    window.addEventListener('pointerdown', go, { passive: true });
    window.addEventListener('keydown', go);
  },
  dismissTitle() {
    if (this._titleDone) return;
    this._titleDone = true;
    const el = document.getElementById('main-menu-overlay');
    if (el) el.classList.add('is-title-leaving');
    // Music: the intent was set at boot; this gesture is what lets it play.
    try { if (this.sfx && this.sfx.startMusic) this.sfx.startMusic(); } catch (e) {}
    const finish = () => {
      if (el) el.classList.remove('is-title', 'is-title-leaving', 'ts-menulike');
      try { this.render(); } catch (e) {}
      // The first-run nudge waited behind the title; ask again now the menu is up.
      try { this._maybeShowFirstRun(); } catch (e) {}
    };
    const reduced = (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (reduced || typeof setTimeout !== 'function') finish(); else setTimeout(finish, 380);
  },

  renderMainMenu(s) {
    const el = document.getElementById('main-menu-overlay');
    if (!el) return;
    el.classList.add('mm-mw3');   // MW3-style layout: left list + single right hero
    // Inline Tron-style SVGs. `stroke: currentColor` + `fill: none` lets the icon
    // inherit the button's text colour and hover glow. Drawn on a 24×24 viewBox
    // with 2px strokes so they read at the 28px .mm-option-icon size.
    const SVG = {
      play: `<svg class="mm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">
               <path d="M7 5 L19 12 L7 19 Z"/>
             </svg>`,
      // Two linked arrows — "two players connected", line-only like the rest.
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
      // Each row gets its own glyph: a repeated glyph in a short list says two rows
      // are the same thing. The diamond is the run — the shape the roguelite
      // screens use for map nodes and relic slots.
      rogue: `<svg class="mm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">
                <path d="M12 2.5 L21.5 12 L12 21.5 L2.5 12 Z"/>
                <path d="M12 8.5 L15.5 12 L12 15.5 L8.5 12 Z" stroke-opacity="0.55"/>
              </svg>`,
      // An open book for the codex — the one row that is a reference work
      // rather than a thing you play or build.
      codex: `<svg class="mm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">
                <path d="M12 6.5 C10 4.9 7.2 4.2 3.5 4.4 V17.6 C7.2 17.4 10 18.1 12 19.7"/>
                <path d="M12 6.5 C14 4.9 16.8 4.2 20.5 4.4 V17.6 C16.8 17.4 14 18.1 12 19.7"/>
                <path d="M12 6.5 V19.7"/>
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
    let mmIdx = 0;   // running index drives the one-shot entrance stagger
    // Wrap each label character in a .mm-letter span for the per-letter flip on
    // submenu swaps (see .mm-flipping CSS). Spaces stay literal so word spacing
    // is unaffected; at rest .mm-letter is plain inline text.
    const _letters = (label) => String(label).split('').map((ch, i) =>
      ch === ' ' ? ' ' : `<span class="mm-letter" style="--mm-li:${i}">${ch}</span>`).join('');
    const btn = (id, label, sub, icon, onClick) => `
      <button type="button" class="mm-option" id="${id}" style="--mm-idx:${mmIdx++}" onclick="${onClick}">
        <span class="mm-rail-seg" aria-hidden="true"></span>
        <div class="mm-option-icon">${icon}</div>
        <div class="mm-option-text">
          <div class="mm-option-label">${_letters(label)}</div>
          <div class="mm-option-sub">${sub}</div>
        </div>
      </button>`;
    // FEATURED ROW — one mode gets a real panel: chamfered on two opposite
    // corners, outlined not filled. It is the one boxed thing on the screen,
    // which is what makes it read as featured; other rows stay boxless glow-text.
    const feature = (id, label, sub, icon, onClick) => `
      <button type="button" class="mm-feature" id="${id}" onclick="${onClick}">
        <span class="mm-feature-icon">${icon}</span>
        <span class="mm-feature-text">
          <span class="mm-feature-label">${label}</span>
          <span class="mm-feature-sub">${sub}</span>
        </span>
      </button>`;
    // Library rows carry a right-aligned counter with REAL numbers — a menu that
    // lies about how many decks you have is worse than one that says nothing.
    const _deckCount = (() => {
      try { return Object.keys(this._dbGetSavedDecks() || {}).length; } catch (e) { return 0; }
    })();
    const _codexCount = (() => {
      try {
        const c = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS.length : 0;
        const t = (typeof TRICK_DEFS !== 'undefined') ? TRICK_DEFS.length : 0;
        // + the Random Event tab: the four candies and MC Ballyhoo himself,
        // none of which live in CARD_DEFS or TRICK_DEFS.
        const e = (typeof CANDY_DEFS !== 'undefined') ? CANDY_DEFS.length + 1 : 0;
        return c + t + e;
      } catch (e) { return 0; }
    })();
    const metaBtn = (id, label, sub, icon, onClick, meta) =>
      btn(id, label, sub, icon, onClick).replace(
        '</div>\n        </div>\n      </button>',
        `</div>\n        </div><span class="mm-option-meta">${meta}</span>\n      </button>`);
    // Who is signed in. Initials come off the same settings.playerName the
    // leaderboard uses, so the chip cannot drift from the name on the board.
    const _pname = ((this.settings && this.settings.playerName) || 'YOU').trim().slice(0, 12) || 'YOU';
    const _initials = _pname.split(/[\s._-]+/).filter(Boolean).slice(0, 2)
      .map(w => w[0]).join('').toUpperCase() || _pname.slice(0, 2).toUpperCase();
    // The leaderboard takes the signed-in chip's slot; its rename control covers
    // the chip's only job, and Settings is still on the gear.
    // _pname / _initials are kept — the codex and the share card read them.
    // Simple question-mark SVG for the tutorial option (no other icon
    // slot conveys "how to play"). Matches the other .mm-svg spec.
    const helpSVG = `<svg class="mm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4.5 2.6c-.9.5-1.5 1-1.5 2"/><line x1="12" y1="17" x2="12" y2="17.2"/></svg>`;
    // Trophy for the Tournament row.
    const trophySVG = `<svg class="mm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10v4a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4v1a3 3 0 0 0 3 3"/><path d="M17 6h3v1a3 3 0 0 1-3 3"/><path d="M9.5 13.5 9 17h6l-.5-3.5"/><path d="M8 20h8"/><path d="M10 17v3M14 17v3"/></svg>`;
    // Panel inner content. buildPanel(sub) returns ONLY the .mm-panel markup so
    // the SAME shell (hero, scrim, bottom bar) can host an in-place SUBMENU: a
    // submenu swaps just this left list (with a per-letter flip) while the hero
    // + music keep playing. Only a real commit actually leaves the menu.
    //   sub === null  → main list (Play + Library)
    //   sub === 'solo'→ Solo Match sub-options (Solo·vs AI + Two on Two)
    // Brand bar — IN FLOW at the very end of the panel list, so it is only seen
    // once you scroll to the bottom. Emitted by buildPanel (not the shell) so
    // submenu swaps keep it.
    const botbarHTML = `
      <div class="mm-botbar">
        <div class="mm-np-label">Now playing</div>
        <div class="mm-npline">
          <span class="mm-nowplaying" role="button" tabindex="0" title="Shuffle to a random hero"
                onclick="UI.sfx.nextMenuTrack()"
                onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();UI.sfx.nextMenuTrack();}"></span>
          <span class="mm-pin-hero" role="button" tabindex="0" aria-label="Star this hero as your default" style="display:none"
                onclick="UI.togglePinnedHero()"
                onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();UI.togglePinnedHero();}"></span>
        </div>
        <div class="mm-heropick" role="listbox" aria-label="Choose your menu hero">
          ${this._menuHeroPickerRowsHTML()}
        </div>
      </div>`;
    const buildPanel = (sub) => {
      mmIdx = 0;   // reset so the swapped list re-staggers from the top
      if (sub === 'solo') {
        return `
        <div class="mm-header">
          <h1 class="mm-title">the game</h1><div class="mm-tagline">Card Lane Battle</div>
        </div>
        <button type="button" class="mm-subback" onclick="UI.mmBack()" aria-label="Back to Play">&larr; Play</button>
        <div class="mm-section">
          <div class="mm-section-label">Solo · vs AI</div>
          <div class="mm-grid mm-grid-section">
            ${btn('mm-sub-classic', 'Classic Draft', 'Shared deck of 95 cards. Draft 5 cards + 2 tricks.', SVG.play,  "selectMode('1v1','classic')")}
            ${btn('mm-sub-deck',    'My Deck',       `Bring your own ${UI.DECK_CARD_MAX}-card deck.`,                        SVG.decks, "openDeckBuilder()")}
          </div>
          ${UI._mmEventToggle('solo', 'Random events in solo matches')}
        </div>
        <div class="mm-section">
          <div class="mm-section-label">Head to Head</div>
          <div class="mm-grid mm-grid-section">
            ${btn('mm-sub-1v1local', '1v1 Local Play', 'Same draft + board as solo — pass one device.', SVG.multi, "Game.startLocal1v1()")}
          </div>
          ${UI._mmEventToggle('oneVOne', 'Random events in 1v1 matches — local and online')}
        </div>
        <div class="mm-section">
          <div class="mm-section-label">Two on Two</div>
          <div class="mm-grid mm-grid-section">
            ${btn('mm-sub-2v2local',  '2v2 Local Play', '4 players, same device. Teams share health.', SVG.multi, "Game.goTo2v2Setup()")}
          </div>
          ${UI._mmEventToggle('twoVTwo', 'Random events in 2v2 matches')}
        </div>${botbarHTML}`;
      }
      // Tools — the dev shelf, one level down. Same in-shell swap as Solo
      // Match, so the hero art and the music keep playing across the change.
      if (sub === 'tools') {
        return `
        <div class="mm-header">
          <h1 class="mm-title">the game</h1><div class="mm-tagline">Card Lane Battle</div>
        </div>
        <button type="button" class="mm-subback" onclick="UI.mmBack()" aria-label="Back to Library">&larr; Library</button>
        <div class="mm-section">
          <div class="mm-section-label">Tools</div>
          <div class="mm-grid mm-grid-section">
            ${btn('mm-audio',   'Sound Gallery','Every sound in the game, per card and per cue',    SVG.settings, "UI.openAudioAudit()")}
            ${btn('mm-gallery', 'Gallery Audit','Browse, crop + delete card art',                   SVG.decks,    "UI.openGalleryAudit()")}
            ${btn('mm-sandbox', 'Sandbox',      'Free-play with unlimited energy + spawn any card', SVG.settings, "UI.startSandbox()")}
            ${btn('mm-leaderboard', 'Leaderboard', 'Rename yourself + pick your favorite card',  SVG.stats,    "UI.openLeaderboard()")}
          </div>
        </div>${botbarHTML}`;
      }
      // Multiplayer — networked play, rendered in-shell (all online modes, incl.
      // 2v2 Online, live here so Solo Match stays same-device only). Pass the
      // menu's own btn()/SVG so MP options are REAL .mm-option rows.
      if (sub === 'mp') {
        return this._mpSubmenuHTML(btn, SVG) + botbarHTML;
      }
      // FOUR ROWS, styled on a console title menu: big all-caps rows on a vertical
      // rail, the selected one gold, a full-bleed hero on the right. Everything else
      // is one level down through the in-shell swap. No icons (the rail segment is
      // the mark); descriptions stay in the markup for the phone layout.
      if (sub === 'play') {
        return `
        <div class="mm-header">
          <h1 class="mm-title">the game</h1><div class="mm-tagline">Card Lane Battle</div>
        </div>
        <div class="mm-section mm-four-list">
          <div class="mm-grid mm-grid-section">
            ${btn('mm-play',    'Solo Match',   'Play against the AI',                                    '', "UI.mmShowSub('solo')")}
            ${(() => {
              const savedInfo = (typeof Roguelite !== 'undefined' && Roguelite.savedRunInfo) ? Roguelite.savedRunInfo() : null;
              if (savedInfo) {
                return btn('mm-rogue', 'Roguelite', `${savedInfo.label} · ${savedInfo.fightsWon} fights won`, '', "Roguelite.resumeRun()");
              }
              return btn('mm-rogue', 'Roguelite', 'Climb a 6-fight ladder — build your deck as you go · beta', '', "Roguelite.enterRun()");
            })()}
            ${btn('mm-tournament','Tournament', 'Best-of series vs AI — rotating modifiers · new', '', "Tournament.enter()")}
            ${btn('mm-tutorial','Tutorial',     'Guided walkthrough — play a scripted round',              '', "Tutorial.start()")}
            ${btn('mm-back-play', 'Back', 'Main menu', '', "UI.mmBack()")}
          </div>
        </div>${botbarHTML}`;
      }
      if (sub === 'library') {
        return `
        <div class="mm-header">
          <h1 class="mm-title">the game</h1><div class="mm-tagline">Card Lane Battle</div>
        </div>
        <div class="mm-section mm-four-list">
          <div class="mm-grid mm-grid-section">
            ${metaBtn('mm-decks', 'My Decks', 'Build, edit, copy, or play your decks', '', "Game.goToMyDecks()", `${_deckCount} built`)}
            ${metaBtn('mm-encyc', 'Codex',    'Every card and trick in the game',       '', "UI.openEncyclopedia()", `${_codexCount} entries`)}
            ${btn('mm-stats',   'Stats',        'Card win rates and balance trends',                      '', "Game.goToStats()")}
            ${btn('mm-tools',   'Tools',        'Leaderboard, Sound Gallery, Art Gallery + Sandbox',      '', "UI.mmShowSub('tools')")}
            ${btn('mm-back-library', 'Back', 'Main menu', '', "UI.mmBack()")}
          </div>
        </div>${botbarHTML}`;
      }
      // Default: the main list — the four.
      return `
        <div class="mm-header">
          <h1 class="mm-title">the game</h1><div class="mm-tagline">Card Lane Battle</div>
        </div>
        <div class="mm-section mm-four-list mm-tier-1">
          <div class="mm-grid mm-grid-section">
            ${btn('mm-four-play',     'Play',        'Solo, Roguelite, Tournament, Tutorial',   '', "UI.mmShowSub('play')")}
            ${btn('mm-four-multi',    'Multiplayer', 'Play a friend online',                   '', "UI.openMultiplayer()")}
            ${btn('mm-four-library',  'Library',     'Decks, Codex, Stats, Tools',             '', "UI.mmShowSub('library')")}
            ${btn('mm-four-settings', 'Settings',    'Audio, graphics, name',                  '', "UI.openSettings()")}
          </div>
        </div>
        <aside id="mm-lb-rail" class="mm-lb-rail"></aside>${botbarHTML}`;
    };
    this._mmBuildPanel = buildPanel;   // reused by in-place submenu swaps (mmShowSub)
    const _flowOn = this.settings.menuFlow !== false;
    const _flowI  = this.settings.menuFlowIntensity ?? 0.18;
    el.style.setProperty('--menu-flow-intensity', String(_flowI));
    el.classList.add('mm-four');
    el.innerHTML = `
      ${_flowOn ? this._menuSceneHTML() : ''}
      <div class="mm-scrim" aria-hidden="true"></div>
      <div class="mm-panel">${buildPanel(this._mmSub || null)}</div>
      ${_flowOn && typeof MenuScene !== 'undefined' ? MenuScene.barHTML() : ''}`;
    // No on-screen key legend. The keys still work.
    this._mmInstallKeys(el);
    this._mmSetActive(0);
    // The leaderboard lives INSIDE the panel and flows with the column. A submenu
    // swap replaces only .mm-panel, so mmShowSub re-calls _renderMenuLeaderboard
    // after every swap; emitted by buildPanel for the same reason as botbarHTML.
    try { this._renderMenuLeaderboard(); } catch (e) {}
    try { if (typeof Leaderboard !== 'undefined') Leaderboard.connect(); } catch (e) {}
    // The backdrop video (moved here from the title, still playing), and the
    // now-playing credit for whatever theme is already on.
    if (_flowOn) this._mountMenuVideo(el.querySelector(':scope > .mm-bgvideo'));
    try { this._updateMenuSideArt(this.sfx && this.sfx._music && this.sfx._music.currentSrc); } catch (e) {}
    // Depth. Installed after the scene exists so it can find its planes.
    if (_flowOn) { try { this._installMenuParallax(el); } catch (e) {} }
    // Scroll the picker so the starred default (if any) is visible on load.
    try { requestAnimationFrame(() => this._markDefaultRow()); } catch (e) {}
  },

  // ===================== MENU PARALLAX =====================
  // Depth comes from planes travelling at DIFFERENT rates, so each plane is
  // pushed a few pixels off the pointer at its own depth.
  //
  // Uses the `translate` property, NOT `transform`: the hero owns its transform
  // (mmHeroDrift, mmHeroRezIn, the shards' static offsets) and writing it here
  // would clobber all three. `translate` composes with transform instead.
  //
  // Scaled by --menu-flow-intensity so the existing Settings slider governs it.
  // Pointer-only: touch screens never arm it.
  _installMenuParallax(el) {
    // OFF: the art and screen must not react to the mouse; the scene keeps its
    // own slow drift (mmHeroBreathe) instead. An early return rather than a
    // deleted body, so the CSS planes, @property declarations and settings knob
    // stay consistent and this is one line to reverse.
    const MENU_PLANE_PARALLAX = false;   // flip to true to restore
    if (!MENU_PLANE_PARALLAX) return;
    if (!el || el._mmParallaxOn) return;
    if (typeof window === 'undefined' || !window.matchMedia) return;
    // Respect the OS setting and skip devices with no real pointer.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    el._mmParallaxOn = true;
    let raf = 0, tx = 0, ty = 0;
    // Strength is folded in here so CSS receives one finished number instead of
    // a nested calc — for legibility only (the untyped-var multiply works too).
    const k = Math.max(0.35, Math.min(1.3, (this.settings.menuFlowIntensity ?? 0.18) * 3.2));
    const apply = () => {
      raf = 0;
      el.style.setProperty('--mm-par-x', (tx * k).toFixed(4));
      el.style.setProperty('--mm-par-y', (ty * k).toFixed(4));
    };
    const onMove = (e) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      // -1..1 from centre, clamped — a pointer leaving the window mid-drag
      // must not push the planes past their intended travel.
      tx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      ty = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onLeave = () => { tx = 0; ty = 0; if (!raf) raf = requestAnimationFrame(apply); };
    el.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerleave', onLeave, { passive: true });
    // Park the planes when the tab is hidden — same reasoning as the existing
    // rAF pause: a backgrounded menu should not hold a queued frame.
    document.addEventListener('visibilitychange', () => { if (document.hidden) onLeave(); });
  },

  // In-place main-menu submenu swap. Re-renders ONLY the .mm-panel left list
  // (not the hero scene), so the hero + bottom bar stay alive. `sub` is a key
  // buildPanel() understands ('solo'), or null for the main list.
  mmShowSub(sub) {
    this._mmSub = sub || null;
    const el = document.getElementById('main-menu-overlay');
    const panel = el && el.querySelector('.mm-panel');
    // No shell built yet (shouldn't happen from a click) — fall back to full render.
    if (!panel || typeof this._mmBuildPanel !== 'function') {
      if (Game && Game.state) this.renderMainMenu(Game.state);
      return;
    }
    panel.innerHTML = this._mmBuildPanel(this._mmSub);
    this._mmSetActive(0);
    // The leaderboard's mount lives INSIDE the Tools panel and only
    // renderMainMenu paints it, so this swap must repaint it or Tools opens with
    // an empty frame. (No-op on submenus without the mount.)
    try { this._renderMenuLeaderboard(); } catch (e) {}
    try { if (sub === 'tools' && typeof Leaderboard !== 'undefined') Leaderboard.connect(); } catch (e) {}
    // Mark the panel as swapped (persistent) so the row fade-up entrance stays
    // suppressed — otherwise removing .mm-flipping below restarts mmOptionIn and
    // the list visibly re-fades ~1.1s after the click.
    panel.classList.add('mm-swapped');
    // Retrigger the per-letter flip: remove → force reflow → add the class so
    // the freshly-built letters animate in. Cleared after the cascade ends.
    panel.classList.remove('mm-flipping');
    void panel.offsetWidth;
    panel.classList.add('mm-flipping');
    if (this._mmFlipTimer) clearTimeout(this._mmFlipTimer);
    // Cascade settles in ~0.6s (capped per-option stagger), so clear the flip
    // class shortly after.
    this._mmFlipTimer = setTimeout(() => panel.classList.remove('mm-flipping'), 700);
    try { if (this.sfx && this.sfx.playNav) this.sfx.playNav(); } catch (e) {}
  },
  mmBack() {
    const cur = this._mmSub || null;
    this.mmShowSub(cur && Object.prototype.hasOwnProperty.call(this._MM_PARENT, cur) ? this._MM_PARENT[cur] : null);
  },

  // ---- keyboard + the single highlighted row --------------------------------
  // One row is lit at a time, like a controller menu. Hover and the arrow keys
  // share that one state (.is-active) so the mouse never leaves a second row
  // highlighted.
  _mmRows() {
    const el = document.getElementById('main-menu-overlay');
    return el ? [...el.querySelectorAll('.mm-panel .mm-option')]
      .filter(b => b.offsetParent !== null || typeof b.getBoundingClientRect !== 'function' || b.getBoundingClientRect().height > 0) : [];
  },
  _mmSetActive(idx) {
    const rows = this._mmRows();
    if (!rows.length) return;
    const i = Math.max(0, Math.min(rows.length - 1, idx | 0));
    rows.forEach((r, k) => r.classList.toggle('is-active', k === i));
    this._mmActiveIdx = i;
    // The hero leans toward the row you are on — a few percent, eased in CSS.
    const el = document.getElementById('main-menu-overlay');
    if (el) el.style.setProperty('--mm-row', String(i));
  },
  _mmInstallKeys(el) {
    if (!el || el._mmKeysInstalled) return;
    el._mmKeysInstalled = true;
    el.addEventListener('keydown', (e) => this._mmKey(e));
    // Hovering a row makes it THE row, so mouse and keys never disagree.
    el.addEventListener('mouseover', (e) => {
      const b = e.target && e.target.closest && e.target.closest('.mm-panel .mm-option');
      if (!b) return;
      const k = this._mmRows().indexOf(b);
      if (k >= 0 && k !== this._mmActiveIdx) this._mmSetActive(k);
    });
    el.setAttribute('tabindex', '-1');
    // Focus the overlay so arrow keys work without a prior click — but not
    // while a modal (first-run prompt, settings) is up and owns focus.
    try { if (!document.querySelector('.first-run-overlay, .settings-overlay.is-open')) el.focus({ preventScroll: true }); } catch (e) {}
  },
  _mmKey(e) {
    if (!e || !e.key) return;
    const rows = this._mmRows();
    if (!rows.length) return;
    const i = this._mmActiveIdx | 0;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this._mmSetActive(e.key === 'ArrowDown' ? (i + 1) % rows.length : (i - 1 + rows.length) % rows.length);
      if (this.sfx && this.sfx.play) { try { this.sfx.play('cardHover'); } catch (_) {} }
    } else if (e.key === 'Enter' || e.key === ' ') {
      // Only when the overlay itself (not a botbar control) has focus.
      if (e.target && e.target.closest && e.target.closest('.mm-botbar, .mm-lb-rail, input, select')) return;
      e.preventDefault();
      const b = rows[i]; if (b) b.click();
    } else if (e.key === 'Escape') {
      if (this._mmSub) { e.preventDefault(); this.mmBack(); }
    }
  },

  // One switch per mode, sitting in that mode's own section of the Solo menu so
  // it is read right next to the button it affects.
  _mmEventToggle(key, label) {
    const cfg = (this.settings && this.settings.randomEvents) || {};
    // Same migration the engine does: a saved 'hotseat' answers for 'oneVOne'.
    const on = (key === 'oneVOne' && cfg.oneVOne === undefined && cfg.hotseat !== undefined)
      ? cfg.hotseat !== false : cfg[key] !== false;
    const esc = (t) => String(t).replace(/"/g, '&quot;');
    return `<label class="mm-evtoggle${on ? ' is-on' : ''}" title="${esc(label)}">
      <input type="checkbox" ${on ? 'checked' : ''}
             onchange="UI.toggleRandomEvents('${key}')"
             aria-label="${esc(label)}">
      <span class="mm-evdot" aria-hidden="true"></span>
      <span class="mm-evtext">Random events <b>${on ? 'ON' : 'OFF'}</b></span>
    </label>`;
  },

  // #9 — Parallax main menu. Mouse position drives body-level CSS vars
  // that each UI surface (mm-panel, body::before) reads for tiny offsets.
  installParallaxMenu() {
    // OFF — same reason as _installMenuParallax. This SECOND cursor parallax
    // drives --parallax-x/y on <body>, which moves .mm-panel and body::before;
    // both must stay off.
    const MENU_POINTER_PARALLAX = false;   // flip to true to restore
    if (!MENU_POINTER_PARALLAX) return;
    if (!this._hasFinePointer()) return;  // mouse-driven menu parallax; a tap would leave the bg shifted
    if (this.isLowFx()) return;           // mousemove repaint — off on low-capability GPUs
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

  // (L) Main-menu ambient particles. Spawns 18 drifting dots once
  // when the main menu opens; removed when we leave the menu.
  _mmParticlesEl: null,
};
