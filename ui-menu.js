// ============================================================
// ui-menu.js — THE MENU + START SCREEN (split out of ui.js, 2026-11-12)
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
    // Full-bleed looping video (owner, 2026-11-11: "the video replaces the hero
    // art entirely"). The host is empty; _mountMenuVideo moves the one shared
    // <video> into it after the HTML lands.
    return `
      <div class="mm-tron-grid" aria-hidden="true"></div>
      <div class="mm-bgvideo" aria-hidden="true"></div>`;
  },
  // MENU VIDEO — ONE element for the title AND the menu. It is created once and
  // MOVED between hosts, so PRESS START carries on the same shot instead of
  // cutting back to frame 0 (the menu re-renders with innerHTML, which would
  // throw a per-screen <video> away and restart it). Muted + playsinline is
  // what lets iOS/Chrome autoplay it without a gesture; the file carries no
  // audio track at all, so the menu music is the only sound.
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
    // The backdrop is a SCENE now (menu-scene.js): random each visit, switched
    // from the name bar along the bottom. The video is one of the scenes.
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
  // Live-sync the menu-atmosphere scene to current settings without a full menu
  // re-render — lets the Settings toggle/slider preview in real time over the
  // (still-mounted) menu behind the settings overlay.
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
    // theme), so stem → name alone can name the wrong one. When the title
    // screen handed its hero to the menu (_pinTrackFace) that face wins for
    // that track.
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
  // Rows for the picker: alphabetical heroes. The saved default gets a ★ prefix
  // (.is-default); the currently-playing hero is highlighted (.is-active, set
  // by _updateNowPlaying). Clicking a row plays that hero.
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
  // The menu-music rotation — DERIVED from CARD_SFX, which is the single
  // source of truth for hover audio. Any card with a `hover` entry joins the
  // menu rotation (and the hero picker) automatically; there is no roster to
  // keep in sync. This used to walk a hand-maintained MENU_HOVER_SRCS array,
  // which had silently drifted five cards behind the registry — Gizmo,
  // Predator, Stripe, The Flash and Iron Giant all shipped with hover tracks
  // that could never play on the menu because nobody added the matching line.
  //
  // Exclusion is a DENYLIST, not an allowlist of types. The old filter kept
  // only type 'hero'/'villain', which is why Iron Giant (type 'scifi') was
  // dropped despite being a perfectly good character — and why the next new
  // type would be dropped too. Now a card is excluded only if it:
  //   • isn't in CARD_DEFS at all (tricks and Infinity Stones live in
  //     TRICK_DEFS — those have hover audio but no character to show), or
  //   • is an 'environment' (Boiler Room, Sewers, Open Water, Gargantua —
  //     these are places, so the hero panel would show scenery), or
  //   • resolves to no art path at all.
  // Everything else — any existing or future type — is in by default.
  //
  // The art check is a cheap guard, NOT a guarantee the file exists:
  // getCardArtPathDefault() synthesizes "art/<Name>.png" from the name and
  // only returns null if the resolver yields nothing. A card whose art is
  // genuinely missing still gets in and 404s — which is fine, because the
  // preloader in _updateMenuSideArt has an onerror that keeps the previous
  // hero on screen rather than blanking the panel.
  //
  // The src comes from CARD_SFX rather than a copied literal so the menu track
  // stays byte-identical to the in-game card hover, cache-bust ?v= included.
  // (Vader's hover swapped to ?v=2; a copied roster kept playing the stale
  // cached clip while the card itself played the new one.)
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

  // Abandon the current match / draft / deckbuilder session from the
  // Settings modal and bounce back to the main menu. Confirms first so
  // an accidental click mid-game doesn't nuke progress. Skips the
  // confirm if we're already on the main menu (no-op) so the button
  // still feels responsive in that edge case.
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
  // Landing screen. Title, five buttons: PLAY, DECK BUILDER, MY DECKS,
  // STATS, SETTINGS. Clicking a button flips Game.state.phase to the
  // target screen and re-renders.
  // ---- TITLE SCREEN -------------------------------------------------------
  // Owner: "i want a title screen like [the console game]". The pattern, not
  // the picture: a full-bleed hero (our own art pool, the same picker the menu
  // uses), the wordmark centred, and a PRESS START that breathes until any key
  // or tap dismisses it. Session-scoped — it shows once per load, never again
  // mid-session, and nothing about it is persisted.
  _titleDone: false,
  renderTitleScreen(s) {
    // THE START SCREEN IS THE MENU WITHOUT ITS LIST (owner, 2026-11-11: "the
    // start screen needs to be the same as the menu"). Same overlay classes,
    // same scene + scrim + panel, the same .mm-header in the same place — only
    // PRESS START stands where the option list will appear. Pressing it swaps
    // in the list and nothing else moves.
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
      // ROGUELITE and CODEX were the only two rows wearing another row's icon —
      // Roguelite took SVG.play, the same triangle as Solo Match, and Codex took
      // SVG.decks, the same stacked cards as My Decks. In a list this short a
      // repeated glyph is worse than no glyph: it says "these two are the same
      // thing" of two rows that are not. Owner supplied the marks.
      // The diamond is the run: a node on the map, and the shape the roguelite
      // screens already use for their map nodes and relic slots.
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
    // Wrap each label character in a .mm-letter span so the left list can
    // do a per-letter flip when swapping between the main list and an
    // in-place submenu (see .mm-flipping CSS). Spaces stay literal so word
    // spacing is unaffected; at rest .mm-letter is plain inline text.
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
    // FEATURED ROW — one mode gets pulled out of the list and given a real
    // panel: chamfered on the two opposite corners, outlined rather than
    // filled. It is the one boxed thing on the screen, which is what makes it
    // read as featured; every other row stays boxless glow-text.
    const feature = (id, label, sub, icon, onClick) => `
      <button type="button" class="mm-feature" id="${id}" onclick="${onClick}">
        <span class="mm-feature-icon">${icon}</span>
        <span class="mm-feature-text">
          <span class="mm-feature-label">${label}</span>
          <span class="mm-feature-sub">${sub}</span>
        </span>
      </button>`;
    // Library rows carry a right-aligned counter. REAL numbers, not the
    // mockup's placeholders — a menu that lies about how many decks you have
    // is worse than one that says nothing.
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
    // THE LEADERBOARD TAKES THIS SLOT. Owner crossed the YOU / SIGNED IN chip
    // out and asked for the leaderboard "where the you signed in is".
    // No loss of function: the chip's only job was opening Settings to change
    // your name, and the leaderboard's own rename control does exactly that,
    // in the place where the name actually matters. Settings is still one tap
    // away on the gear.
    // _pname / _initials are kept — the codex and the share card read them.
    // Simple question-mark SVG for the tutorial option (no other icon
    // slot conveys "how to play"). Matches the other .mm-svg spec.
    const helpSVG = `<svg class="mm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4.5 2.6c-.9.5-1.5 1-1.5 2"/><line x1="12" y1="17" x2="12" y2="17.2"/></svg>`;
    // Trophy for the Tournament row.
    const trophySVG = `<svg class="mm-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10v4a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4v1a3 3 0 0 0 3 3"/><path d="M17 6h3v1a3 3 0 0 1-3 3"/><path d="M9.5 13.5 9 17h6l-.5-3.5"/><path d="M8 20h8"/><path d="M10 17v3M14 17v3"/></svg>`;
    // Panel inner content. buildPanel(sub) returns ONLY the .mm-panel
    // markup so the SAME shell (hero on the right, scrim, bottom bar) can
    // host an in-place SUBMENU without a screen change: clicking Solo Match
    // swaps just this left list to the solo sub-options (with a per-letter
    // flip) while the hero + music keep playing. Only a real commit (start
    // a draft / run / match, open My Decks) actually leaves the menu.
    //   sub === null  → main list (Play + Library)
    //   sub === 'solo'→ Solo Match sub-options (Solo·vs AI + Two on Two)
    // Brand bar — sits IN FLOW at the very end of the panel list (below
    // Sandbox on the main list) so it's only visible once you scroll to
    // the bottom. User direction: "just below the sandbox mode regardless
    // and not seen at all until you scroll all the way down." Emitted by
    // buildPanel (not the shell) so submenu swaps keep it.
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
      // Multiplayer — networked play, rendered in-shell (all online modes,
      // incl. 2v2 Online, live here so Solo Match stays same-device only).
      // Pass the menu's own btn()/SVG so the MP options are REAL .mm-option
      // rows — same glow-text, spacing, and letter-flip as the main list.
      if (sub === 'mp') {
        return this._mpSubmenuHTML(btn, SVG) + botbarHTML;
      }
      // FOUR ROWS (2026-11-06). Owner's reference is a console title menu: a
      // handful of big all-caps rows hung off a vertical rail, the selected one
      // gold, a full-bleed hero on the right. Nine rows with icons, sections and
      // inline counts could never reach that scale — at this viewport nine rows
      // at the reference's height is 600px of column — so the list is four and
      // everything else is one level down, through the same in-shell swap Solo
      // Match and Tools already used. Icons are gone (the rail segment is the
      // mark now); descriptions stay in the markup for the phone, where mw3
      // shows them again. The boxed "Multiplayer · beta" callout is gone with
      // them — it is a row like the others. (Owner: "i like this as the menu
      // this is the inspiration", then "Four big rows".)
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
      // (the previous nine-row list, kept as dead text for one commit so the
      // diff reads; delete on the next touch)
      /* legacy main list:
        ${feature('mm-multi', 'Multiplayer', 'Play a friend online · beta', SVG.multi, "UI.openMultiplayer()")}
        <div class="mm-section mm-tier-1">
          <div class="mm-section-label">Play</div>
          <div class="mm-grid mm-grid-section">
            ${btn('mm-play',    'Solo Match',   'Play against the AI',                                    SVG.play,     "UI.mmShowSub('solo')")}
            ${(() => {
              // Consolidated Continue Run + Roguelite button — when a save
              // exists it reads "Continue last run" and resumes in place.
              const savedInfo = (typeof Roguelite !== 'undefined' && Roguelite.savedRunInfo) ? Roguelite.savedRunInfo() : null;
              if (savedInfo) {
                return btn('mm-rogue', 'Roguelite', `${savedInfo.label} · ${savedInfo.fightsWon} fights won`, SVG.rogue, "Roguelite.resumeRun()");
              }
              return btn('mm-rogue', 'Roguelite', 'Climb a 6-fight ladder — build your deck as you go · beta', SVG.rogue, "Roguelite.enterRun()");
            })()}
            ${btn('mm-tournament','Tournament', 'Best-of series vs AI — rotating modifiers · new', trophySVG, "Tournament.enter()")}
            ${btn('mm-tutorial','Tutorial',     'Guided walkthrough — play a scripted round',              helpSVG,      "Tutorial.start()")}
          </div>
        </div>
        <div class="mm-section mm-tier-2">
          <div class="mm-section-label">Library</div>
          <div class="mm-grid mm-grid-section">
            ${metaBtn('mm-decks', 'My Decks', 'Build, edit, copy, or play your decks', SVG.decks, "Game.goToMyDecks()", `${_deckCount} built`)}
            ${metaBtn('mm-encyc', 'Codex',    'Every card and trick in the game',       SVG.codex, "UI.openEncyclopedia()", `${_codexCount} entries`)}
            ${btn('mm-stats',   'Stats',        'Card win rates and balance trends',                      SVG.stats,    "Game.goToStats()")}
            ${btn('mm-tools',   'Tools',        'Leaderboard, Sound Gallery, Art Gallery + Sandbox',      SVG.settings, "UI.mmShowSub('tools')")}
          </div>
        </div>
        <aside id="mm-lb-rail" class="mm-lb-rail"></aside>${botbarHTML}
      */
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
    // No on-screen key legend (owner removed it 2026-11-09). The keys still work.
    this._mmInstallKeys(el);
    this._mmSetActive(0);
    // THE LEADERBOARD LIVES IN THE MENU COLUMN NOW, under the profile chip.
    // Owner: "place the leaderboard here in the menu and make it tron themed
    // and collapsable" — with an arrow drawn from the floating panel to the
    // YOU / SIGNED IN chip.
    // It used to be a sibling of .mm-panel, absolutely positioned across the
    // gap beside the menu, specifically so a submenu swap (which replaces only
    // .mm-panel) could not destroy it. That reason has since expired: mmShowSub
    // calls _renderMenuLeaderboard itself after every swap, so the rail can sit
    // INSIDE the panel and flow with the column like everything else. Emitted by
    // buildPanel for the same reason botbarHTML is.
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
  // The scene already MOVED — a 34s Ken Burns drift on the hero — but every
  // layer moved as one, which is why it read as an animated poster rather than
  // a set. Depth on screen does not come from more motion, it comes from planes
  // travelling at DIFFERENT rates against each other. This pushes each plane by
  // a few pixels off the pointer, at its own depth.
  //
  // WHY THE `translate` PROPERTY AND NOT `transform`. The hero already owns its
  // transform: mmHeroDrift animates it forever, mmHeroRezIn on entry, and the
  // shards carry static offsets that create the fracture. Writing transform
  // here would clobber all three — the drift would stop dead the first time the
  // pointer moved. `translate` is a separate longhand that composes with
  // transform instead of replacing it, so every existing animation keeps
  // running underneath and this only adds to it.
  //
  // Scaled by --menu-flow-intensity so the Settings slider that already governs
  // the rest of the scene governs this too, rather than adding a second knob
  // for the same idea. Pointer-only: a touch screen has no hover position to
  // read, so phones simply never arm it.
  _installMenuParallax(el) {
    // OFF. The menu used to lean with the cursor — five planes sliding on
    // pointermove. The owner does not want the art or the screen reacting to
    // the mouse at all: "i dont like when my mouse moved the art and screen
    // move, get rid of that." The scene keeps its own slow drift instead (see
    // mmHeroBreathe), which is motion the player watches rather than motion
    // they cause.
    // Left as an early return rather than deleting the body, so the CSS planes,
    // the @property declarations and the settings knob it reads all stay
    // internally consistent and this is one line to reverse.
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
    // a nested calc. (Checked, not assumed: holding the clamp in an untyped
    // custom property and multiplying by it computes correctly — that was a
    // wrong suspicion while debugging. This is for legibility only.)
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
  // (not the hero scene), so the music-synced hero + bottom bar stay alive and
  // continuous — the left letters just flip to the sub-options. `sub` is the
  // submenu key buildPanel() understands ('solo'), or null for the main list.
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
    // The leaderboard's mount lives INSIDE the Tools panel, and this swap
    // replaces the panel without re-running renderMainMenu — which is the one
    // place that paints it. So a submenu that carries a live readout has to
    // repaint it here, or Tools opens with an empty frame. (The rail is a no-op
    // on every other submenu: it looks for a mount that is not there.)
    try { this._renderMenuLeaderboard(); } catch (e) {}
    try { if (sub === 'tools' && typeof Leaderboard !== 'undefined') Leaderboard.connect(); } catch (e) {}
    // Mark the panel as swapped (persistent) so the row fade-up entrance stays
    // suppressed — the letter flip is the only entrance on a swap. Without this,
    // removing .mm-flipping below would restart mmOptionIn and the list would
    // visibly re-fade-in ~1.1s after the click ("disappears and reloads").
    panel.classList.add('mm-swapped');
    // Retrigger the per-letter flip: remove → force reflow → add the class so
    // the freshly-built letters animate in. Cleared after the cascade ends.
    panel.classList.remove('mm-flipping');
    void panel.offsetWidth;
    panel.classList.add('mm-flipping');
    if (this._mmFlipTimer) clearTimeout(this._mmFlipTimer);
    // Cascade now settles in ~0.6s (capped per-option stagger), so clear the
    // flip class shortly after rather than lingering to 1.1s.
    this._mmFlipTimer = setTimeout(() => panel.classList.remove('mm-flipping'), 700);
    try { if (this.sfx && this.sfx.playNav) this.sfx.playNav(); } catch (e) {}
  },
  mmBack() {
    const cur = this._mmSub || null;
    this.mmShowSub(cur && Object.prototype.hasOwnProperty.call(this._MM_PARENT, cur) ? this._MM_PARENT[cur] : null);
  },

  // ---- keyboard + the single highlighted row --------------------------------
  // The reference is a controller menu: one row is lit at a time and the hero
  // reacts to it. Hover and the arrow keys share that one state (.is-active) so
  // the mouse never leaves a second row highlighted, and the legend strip is
  // only honest if the keys actually work.
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
    // OFF — same reason as _installMenuParallax. This is the SECOND cursor
    // parallax on this screen: it drives --parallax-x/y on <body>, which moves
    // .mm-panel (style.css:17195) and body::before (17199). Killing only the
    // plane parallax would have left the menu still swimming under the pointer,
    // which is exactly the complaint.
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
