// ============================================================
// ui-draft.js — THE DRAFT SCREEN (split out of ui.js)
// ============================================================
// renderDraft and its helpers: the shared draft rails, mulligan control and
// pick tiles (also used by the 2v2 draft), the offer order, and the draft
// zoom-to-fit.
//
// Same contract as fx.js: loads BEFORE ui.js and only declares UI_DRAFT;
// ui.js merges it into UI right after the UI literal, before UI.init().
// ============================================================
const UI_DRAFT = {
  // ===================== DRAFT RAILS (2026-08-27) =====================
  // ONE implementation, called by BOTH draft renderers (the 2v2 one is a
  // separate function), so the rails can't drift apart. Everything reads from
  // the picks array it is handed, and every number is derived from real picks.

  // ONE MULLIGAN CONTROL, BOTH DRAFTS. Its own chamfered control under the
  // offers it acts on (not a header text link — it REPLACES THE CARDS IN FRONT
  // OF YOU), carrying the charges it has left.
  _draftMulliganHTML(used, onclick) {
    const spent = !!used;
    return `<div class="draft-mulligan-row">
      <button type="button" class="draft-mulligan${spent ? ' is-spent' : ''}"
        ${spent ? 'disabled' : ''} onclick="${onclick}"
        title="One mulligan per phase — redraws your two offers">
        <span class="dm-ic">&#x21BB;</span>
        <span class="dm-label">Mulligan</span>
        <span class="dm-count">${spent ? 'Used' : '1 left'}</span>
      </button>
    </div>`;
  },

  // The left rail: one slot per pick — filled ones show the card, the current
  // one is marked, the rest wait.
  // BOTH GROUPS, ALWAYS. Card slots and trick slots are both present from the
  // first pick, so crossing into the tricks phase changes only which row is
  // lit, never the screen's shape. `active` says which group is being picked;
  // the other group's empty slots show no "choosing" marker.
  // ONE SLOT, drawn the same wherever it appears — the picks rail and the trick
  // group in the right rail are the same object and must not drift.
  _draftSlotHTML(c, label, state, kind) {
    const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    let face;
    if (c) {
      const art = this.getCardArtPath ? this.getCardArtPath(c.name) : '';
      const bg = art ? `--portrait-bg:url('${art.replace(/'/g, '%27')}')${this._artFocalCard ? this._artFocalCard(c.name) : ''}` : '';
      // .dpr-abbr / .dpr-mcost are the PHONE tile (first 2 letters of the name
      // + cost); desktop hides them and keeps the art thumb.
      const abbr = String(c.name || '').replace(/^the\s+/i, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 2);
      face = `<span class="dpr-cost">${c.baseCost != null ? c.baseCost : (c.cost || 0)}</span>
              <span class="dpr-art" style="${bg}"></span>
              <span class="dpr-abbr">${esc(abbr.charAt(0).toUpperCase() + abbr.slice(1).toLowerCase())}</span>
              <span class="dpr-name">${esc(c.name)}</span>`;
    } else if (state === 'is-current') {
      face = `<span class="dpr-q">?</span>`;
    } else {
      face = '';
    }
    const stats = c && c.attack != null && c.health != null && this._hasBody(c)
      ? `<span class="dpr-stats"><b>${c.attack}</b> / <i>${c.health}</i></span>` : '';
    // A CHIP, NOT A FULL-SIZE EMPTY SLOT: an outlined empty box reads as a
    // container waiting to be filled and would be the loudest thing on the
    // rail. Filled picks keep their art; unfilled ones are a chip + dim word.
    // TAP A PAST PICK TO SEE IT — the same name-based inspect every other
    // surface uses (showCardInspect resolves cards and tricks by data-*).
    const pickAttrs = c ? ` data-${kind === 'trick' ? 'trick' : 'card'}-name="${esc(c.name)}" role="button" tabindex="0" onclick="UI.showCardInspect(this)"` : '';
    const mcost = c ? `<span class="dpr-mcost">${c.baseCost != null ? c.baseCost : (c.cost || 0)}</span>` : '';
    return `<div class="dpr-slot ${state}${kind ? ' dpr-' + kind : ''}${c ? ' is-card' : ''}"${pickAttrs}>
      <div class="dpr-tile">${face}</div>
      ${mcost}
      <div class="dpr-meta">
        <span class="dpr-label">${esc(label)}</span>
        ${c ? stats : (state === 'is-current' ? '<span class="dpr-choosing">Choosing</span>' : '')}
      </div>
    </div>`;
  },
  _draftPicksRailHTML(groups, _legacyTotal, opts) {
    const o = opts || {};
    const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    // Back-compat: an array of picks + a total still works.
    const gs = Array.isArray(groups) && groups.length && groups[0] && groups[0].items !== undefined
      ? groups
      : [{ label: 'Pick', items: (groups || []), total: _legacyTotal || 0, active: true }];
    const rows = [];
    gs.forEach(g => {
      const picks = g.items || [];
      const total = g.total || 0;
      for (let i = 0; i < total; i++) {
      const c = picks[i];
      const state = c ? 'is-filled' : ((g.active && i === picks.length) ? 'is-current' : 'is-empty');
      rows.push(this._draftSlotHTML(c, (g.label || 'Pick') + ' ' + (i + 1), state, g.kind));
      }
    });
    return `<aside class="draft-rail draft-rail-left">
      <div class="mp-rule"><span class="mp-rule-label">${esc(o.title || 'Your picks')}</span><span class="mp-rule-line"></span></div>
      <div class="dpr-list">${rows.join('')}</div>
    </aside>`;
  },

  // The right rail: what the picks ADD UP TO. Card count, average cost and
  // total attack, the cost curve as a shape rather than a list, the keywords
  // you are holding, and what the opponent has done. All computed here.
  _draftDeckRailHTML(picks, opts) {
    const o = opts || {};
    const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const n = picks.length;
    const costOf = (c) => (c.baseCost != null ? c.baseCost : (c.cost || 0));
    const totalCost = picks.reduce((a, c) => a + costOf(c), 0);
    const totalAtk  = picks.reduce((a, c) => a + (c.attack || 0), 0);
    const avg = n ? (totalCost / n) : 0;
    // Buckets 1..5 then 6+, which is where this game's curve actually lives.
    const buckets = [0, 0, 0, 0, 0, 0];
    picks.forEach(c => { const k = Math.min(6, Math.max(1, costOf(c))); buckets[k - 1]++; });
    const peak = Math.max(1, ...buckets);
    const bars = buckets.map((v, i) => {
      const h = Math.round((v / peak) * 100);
      return `<div class="dcr-bar${v ? '' : ' is-zero'}" style="--h:${h}%" title="${v} card${v === 1 ? '' : 's'} at cost ${i === 5 ? '6+' : i + 1}">
        <span class="dcr-bar-fill"></span><span class="dcr-bar-tick">${i === 5 ? '6+' : i + 1}</span></div>`;
    }).join('');
    // Keywords actually held, de-duplicated, in pick order.
    const kw = [];
    picks.forEach(c => (c.abilities || []).forEach(a => { if (a && kw.indexOf(a) < 0) kw.push(a); }));
    // Keyword chips opt into the document-level [data-kw] tooltip delegate
    // (UI.KEYWORD_DATA[kw].tip) — hover shows, click pins, as everywhere else.
    // data-kw wants the CANONICAL keyword, so the count is stripped ("Evade 1"
    // -> "Evade"). Anything with no entry stays plain so no tooltip comes up empty.
    const kwHtml = kw.length
      ? kw.map(k => {
          const base = String(k).replace(/\s*\d+$/, '').trim();
          const has  = !!(this.KEYWORD_DATA && this.KEYWORD_DATA[base]);
          return `<span class="dcr-kw${has ? ' dcr-kw-has' : ''}"${has ? ` data-kw="${esc(base)}"` : ''}>${esc(k)}</span>`;
        }).join('')
      : `<span class="dcr-kw dcr-kw-none">None yet</span>`;
    // NO OPPONENT BLOCK — a pick count of a deck you can't see isn't
    // actionable. opts.oppName / opts.oppPicked are still accepted and ignored
    // so callers needn't change.
    const oppHtml = '';
    // The tricks live in this rail, not under the card picks — that made the
    // left column the tallest thing on screen and squeezed the offers narrow
    // enough to crop their art.
    const t = o.tricks;
    const trickHtml = (t && t.total) ? `
      <div class="mp-rule"><span class="mp-rule-label">Your tricks</span><span class="mp-rule-line"></span></div>
      <div class="dpr-list dcr-tricks">${
        Array.from({ length: t.total }, (_, i) => {
          const c = (t.items || [])[i];
          const state = c ? 'is-filled' : ((t.active && i === (t.items || []).length) ? 'is-current' : 'is-empty');
          return this._draftSlotHTML(c, 'Trick ' + (i + 1), state, 'trick');
        }).join('')
      }</div>` : '';
    // Deck-so-far stats are not shown — the rail carries only the drafted
    // tricks. (n / avg / totalAtk / bars / kwHtml above stay computed: callers
    // and tests read the helper's inputs, and they cost nothing.)
    void n; void avg; void totalAtk; void bars; void kwHtml; void oppHtml;
    return `<aside class="draft-rail draft-rail-right">
      ${trickHtml}
    </aside>`;
  },

  // The line under each offer: what it IS on the left, and how it sits against
  // the curve you have actually built on the right. The advice is computed from
  // the picks, not asserted — with fewer than two picks there is no curve to
  // speak of yet, so it says nothing rather than inventing a judgement.
  _draftCardFootHTML(card, picks) {
    if (!card) return '';
    const r = this._cardRarityLabel(card);
    const costOf = (c) => (c.baseCost != null ? c.baseCost : (c.cost || 0));
    const cost = costOf(card);
    let note = '';
    if (picks && picks.length >= 2) {
      const avg = picks.reduce((a, c) => a + costOf(c), 0) / picks.length;
      const has = picks.some(c => costOf(c) === cost);
      if (cost >= avg + 2)      note = 'Top of curve';
      else if (cost <= avg - 2) note = 'Low drop';
      else if (!has)            note = 'Fits your curve';
      else                      note = 'Doubles up';
    }
    return `<div class="draft-foot">
      <span class="draft-foot-rarity rarity-tier-${r.tier}">${r.label}</span>
      <span class="draft-foot-line"></span>
      ${note ? `<span class="draft-foot-note">${note}</span>` : ''}
    </div>`;
  },

  renderDraft(s) {
    const d = s.draft;
    const isCards = d.phase === 'cards';
    const choices = d.playerChoices;
    const round = d.round;
    const total = isCards ? 5 : 2;

    // Prefetch both draft choices. { md: true } MUST match the tier makeCardEl
    // paints for draft surfaces on mobile, or the real file arrives cold.
    if (isCards && choices) this._preloadArt(choices.map(c => c.name), { md: true });
    const drafted = isCards ? d.playerDrafted : d.playerTrickDrafted;

    // Build the pick-progress pip row ("● ● ○ ○ ○") — HUD-style dots so the
    // player can read round/total at a glance without counting numbers.
    const pips = [];
    for (let i = 1; i <= total; i++) {
      const cls = i < round ? 'pip-done' : i === round ? 'pip-current' : 'pip-future';
      pips.push(`<span class="draft-pip ${cls}"></span>`);
    }

    // MP and hotseat use the per-side mulligan flag, not the shared legacy one.
    // (Hotseat's flip swaps playerMulliganUsed, so 'player' is always the
    // human holding the device.)
    const isMP = Game.isMultiplayer && Game.isMultiplayer();
    const isHot = Game.isHotseat && Game.isHotseat();
    const mulliganUsed = (isMP || isHot) ? !!d.playerMulliganUsed : !!d.mulliganUsed;
    const mulliganDisabled = mulliganUsed ? ' mulligan-used' : '';
    const mulliganAttr = mulliganUsed ? ' disabled' : '';
    const mulliganLabel = mulliganUsed ? 'Mulligan Used' : 'Mulligan';

    // Back disabled in MP (snapshots are host-perspective; an already-broadcast
    // pick can't be undone) and hotseat (undo would rewind across the device
    // flip and reveal the other player's picks).
    const undoAvailable = !isMP && !isHot && !!(d.history && d.history.length);
    const undoDisabled = undoAvailable ? '' : ' undo-disabled';
    const undoAttr = undoAvailable ? '' : ' disabled';

    // Hotseat: name whose draft this is — the two players alternate on
    // one device, so the header must say who is picking right now.
    const hotName = (isHot && s._mpNames && s._mpNames.player) ? ` — ${s._mpNames.player}` : '';

    // One frame for both phases: the phase goes on a data attribute, not a
    // `draft-tricks` class — that class only re-themed the chrome, producing an
    // unwanted screen change between phases.
    let html = `<div class="draft-panel draft-cards" data-draft-phase="${isCards ? 'cards' : 'tricks'}">`;
    // One header row: title + who opens on the left, pick progress in the
    // middle, controls on the right. Pick progress is a five-segment tick bar
    // (not dots plus a "Pick 1 / 5" counter — the same fact twice).
    const _fp1 = (Game.firstPlayerForRound) ? Game.firstPlayerForRound(1) : null;
    let _firstHtml = '';
    if (_fp1) {
      const _mine = _fp1 === 'player';
      const _nm = (s._mpNames && s._mpNames[_fp1]) ? s._mpNames[_fp1]
                : (Game.seatLabel ? Game.seatLabel(_fp1) : (_mine ? 'You' : 'AI'));
      _firstHtml = `<span class="dh-first ${_mine ? 'is-mine' : 'is-theirs'}">${_nm} ${_mine ? 'go' : 'goes'} first</span>`;
    }
    const _ticks = Array.from({ length: total }, (_, i) =>
      `<span class="dh-seg${i < round ? ' is-done' : ''}${i === round - 1 ? ' is-now' : ''}"></span>`).join('');
    const _haOn = !!(this.settings && this.settings.handAudioPrivacy);

    html += `<div class="draft-hud">`;
    html +=   `<div class="dh-left">`;
    html +=     `<span class="dh-title">Draft${hotName}</span>`;
    html +=     `<span class="dh-sep" aria-hidden="true"></span>`;
    html +=     `<span class="dh-round">Round ${s.round || 1}</span>`;
    html +=     _firstHtml;
    html +=   `</div>`;
    html +=   `<div class="dh-progress">`;
    html +=     `<span class="dh-pick-lbl">Pick</span>`;
    html +=     `<span class="dh-tick" role="img" aria-label="Pick ${round} of ${total}">${_ticks}</span>`;
    html +=     `<span class="dh-count">${round} / ${total}</span>`;
    html +=   `</div>`;
    html +=   `<div class="dh-actions">`;
    html +=     this._draftMulliganHTML(mulliganUsed, 'draftMulligan()');
    html +=     `<button type="button" class="draft-audio-btn${_haOn ? ' is-muted' : ''}"`;
    html +=       ` data-hand-audio-toggle aria-pressed="${_haOn ? 'true' : 'false'}"`;
    html +=       ` onclick="UI.toggleHandAudioPrivacy()"`;
    html +=       ` title="${_haOn ? 'Hand sounds hidden — per-card hover cues are replaced with one generic blip' : 'Hide hand sounds — stop per-card hover cues from revealing your picks'}">`;
    html +=       `<span class="mulligan-label">${_haOn ? 'Sounds off' : 'Sound'}</span>`;
    html +=     `</button>`;
    html +=     `<button type="button" class="draft-quit-btn" onclick="draftQuitToMenu()" title="Abandon draft and return to main menu">`;
    html +=       `<span class="mulligan-label">Menu</span>`;
    html +=     `</button>`;
    html +=   `</div>`;
    html += `</div>`;
    // Three columns: picks / offers / totals, so an offer can be weighed
    // against your curve. The rails (_draftPicksRailHTML / _draftDeckRailHTML)
    // are shared with the 2v2 draft so the screens can't drift.
    // The deck rail always reads CARD picks (playerDrafted), in both phases —
    // using `drafted` would show trick-phase totals as 0 cards.
    const _railPicks = (d.playerDrafted || []).slice();
    const _oppName = (s._mpNames && s._mpNames.ai) ? s._mpNames.ai
                   : (Game.isMultiplayer && Game.isMultiplayer() ? 'Opponent' : (Game.seatLabel ? Game.seatLabel('ai') : 'AI'));
    const _oppPicked = ((isCards ? d.aiDrafted : d.aiTrickDrafted) || []).length;
    html += `<div class="draft-stage">`;
    html +=   this._draftPicksRailHTML([
                { label: 'Pick', kind: 'card', items: d.playerDrafted || [], total: 5, active: isCards },
              ], 0, { title: 'Your picks' });
    html += `<div class="draft-choices">`;

    // MP mid-round wait — we've committed our pick (playerChoices cleared by
    // game.js draftPick) but the opponent hasn't. Show "waiting for opponent"
    // instead of an empty picker; their `aiChoices` stays populated.
    if (Game.isMultiplayer && Game.isMultiplayer() && (!choices || !choices.length)) {
      html += `<div class="draft-waiting">`;
      html +=   `<div class="draft-waiting-spinner"></div>`;
      html +=   `<div class="draft-waiting-title">Waiting for opponent…</div>`;
      html +=   `<div class="draft-waiting-sub">They're picking from their own offers.</div>`;
      html += `</div>`;
    }

    this._draftOfferOrder(choices).forEach(({ c, i }) => {
      if (isCards) {
        // ONE renderer — draft face is identical to hand/board via makeCardEl
        // ('?'-hiding, rarity pips, badges, orbs live there). Shared with the
        // 2v2 draft (only the pick fn differs).
        html += `<div class="draft-offer">` + this._draftCardHTML(c, i, 'draftPick')
              + this._draftCardFootHTML(c, _railPicks) + `</div>`;
      } else {
        // Same one trick renderer — draft-card carries the picker footprint.
        html += `<div class="draft-offer">`
              + this.makeTrickEl(c, { extraClass: 'draft-card trick-draft', onclick: 'draftPick(' + i + ')' })
              + this._draftCardFootHTML(c, []) + `</div>`;   // a trick has no place on a cost curve
      }
    });

    html += `</div>`;
    html +=   this._draftDeckRailHTML(_railPicks, { title: 'Deck so far', oppName: _oppName, oppPicked: _oppPicked,
                tricks: { items: d.playerTrickDrafted || [], total: 2, active: !isCards } });
    html += `</div>`;   // /draft-stage
    // No drafted-cards list under the offers: the left rail shows those picks
    // with art and stats in both phases.
    html += `</div>`;
    this.draftEl.innerHTML = html;
    // Decorate the pick cards + chrome buttons. This renderer is reached via
    // render() returning early, so bottom-of-render applyTronFx() never runs.
    if (this.applyTronFx) this.applyTronFx();
    // Zoom must be fitted HERE, not in renderSync: render() calls _renderImpl()
    // directly (renderSync is only the network path) and _renderImpl
    // early-returns into renderDraft. Whatever draws the draft also sizes it.
    if (this._fitDraftToViewport) this._fitDraftToViewport();
  },
  // THE DRAFT PANEL ZOOMS TO FILL THE SCREEN via a transform, so art, text,
  // borders and spacing scale together (widening the card just adds
  // whitespace — draft type sizes are fixed). Safe here: the draft has no
  // position:fixed children (the settings cog is outside .draft-panel) and
  // nothing inside uses viewport units. Always measured at scale 1, or the
  // previous zoom compounds on every render.
  _fitDraftToViewport() {
    const panel = document.querySelector('.draft-panel');
    if (!panel || !panel.querySelector('.draft-card')) return;
    if (this._isPhoneDraft()) {
      panel.style.transform = ''; panel.dataset.draftScale = '1';
      this._fitDraftPhone();
      return;
    }
    // NEVER clear the transform to measure — early returns (e.g. a hidden tab
    // reporting 0x0) would leave the panel unscaled. Divide the measured box
    // by the current scale instead; nothing mutates until the new value is
    // known, so re-running is idempotent.
    const prev = parseFloat(panel.dataset.draftScale || '1') || 1;
    const r = panel.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // The panel's own size, with any existing zoom divided back out.
    const baseW = r.width / prev, baseH = r.height / prev;
    // 4% of each axis kept clear so the panel never sits flush to the window.
    const k = Math.min((window.innerWidth * 0.96) / baseW,
                       (window.innerHeight * 0.96) / baseH);
    // Never shrink (small windows keep authored size and scroll); 1.8 cap
    // stops it ballooning into a poster on very large monitors.
    const scale = Math.max(1, Math.min(1.8, k));
    panel.style.transformOrigin = 'center center';
    panel.dataset.draftScale = String(scale);
    panel.style.transform = scale > 1.001 ? `scale(${scale.toFixed(3)})` : '';
  },

  // PHONE DRAFT: one non-scrolling screen, cards side by side, card aspect
  // never changes. Each offer is laid out at ONE fixed design width (CSS,
  // --dph-card-w) so its contents wrap as designed; the pair is then scaled
  // uniformly with `zoom` (layout + hit-testing scale with it) to fill the
  // space between the HUD and the picks strip.
  _isPhoneDraft() {
    return typeof window !== 'undefined' && window.innerWidth <= 640;
  },
  _fitDraftPhone() {
    const box = document.querySelector('.draft-stage > .draft-choices');
    if (!box) return;
    const offers = [...box.querySelectorAll(':scope > .draft-offer')];
    if (!offers.length) return;
    const apply = () => {
      // The box can be laid out wider than the screen (its row of zoomed
      // offers pushes it), so the screen is the real limit on width.
      const avW = Math.min(box.clientWidth, window.innerWidth - 28), avH = box.clientHeight;
      if (!avW || !avH) return;
      const z = parseFloat(getComputedStyle(offers[0]).zoom) || 1;
      // Natural (zoom 1) size of the pair: rects are post-zoom, so divide out.
      let sumW = 0, maxH = 0;
      // Pair height: the taller card's NATURAL height sets both (cleared first
      // so a previous pair's height never props the next one up).
      box.style.setProperty('--dph-pair-h', '0px');
      let cardH = 0;
      offers.forEach(o => {
        const c = o.querySelector('.draft-card, .trick-draft');
        if (c) cardH = Math.max(cardH, c.getBoundingClientRect().height / z);
      });
      if (cardH) box.style.setProperty('--dph-pair-h', Math.ceil(cardH) + 'px');
      offers.forEach(o => { const r = o.getBoundingClientRect(); sumW += r.width / z; maxH = Math.max(maxH, r.height / z); });
      const gap = parseFloat(getComputedStyle(box).columnGap) || 10;
      const k = Math.min((avW - gap * (offers.length - 1) - 4) / sumW, (avH - 4) / maxH);
      const kk = Math.max(0.35, Math.min(1.6, k));
      if (Math.abs(kk - z) > 0.005) box.style.setProperty('--dph-zoom', kk.toFixed(3));
    };
    // Fonts + layout settle first (fit-loop rule: double rAF, then fonts).
    requestAnimationFrame(() => requestAnimationFrame(apply));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply);
    if (!this._draftPhoneResizeHooked) {
      this._draftPhoneResizeHooked = true;
      window.addEventListener('resize', () => { if (document.querySelector('.draft-stage')) this._fitDraftToViewport(); }, { passive: true });
    }
  },

  // Shared draft-card HTML — classic AND 2v2 draft both build the pick tile
  // here, so a draft card is byte-identical to the same card in hand/board.
  // Only the pick-callback name differs. Returns an outerHTML string.
  // DRAFT OFFER ORDER — cheaper card left, pricier card right, always (same for
  // tricks).
  //
  // Returns {c, i} pairs where `i` is the ORIGINAL index — the engine's pick id
  // (draftPick(i)). Sorting the array alone would make the left card call the
  // right card's pick. Sorting a COPY and carrying the index keeps display
  // order and pick identity independent.
  //
  // Stable on ties, so a same-cost pair does not shuffle between renders.
  _draftOfferOrder(choices) {
    return (choices || [])
      .map((c, i) => ({ c, i }))
      .filter(e => e.c)
      .sort((a, b) => ((a.c.cost | 0) - (b.c.cost | 0)) || (a.i - b.i));
  },

  _draftCardHTML(c, i, pickFn) {
    const face = this._synthFace(c, {});
    const el = this.makeCardEl(face, true, 'player', {
      static: true,
      noHandClass: true, // draft needs the hover-lift, which .hand-card suppresses
      extraClass: 'draft-card' + (c.isDiscardEffect ? ' discard-effect' : ''),
    });
    el.setAttribute('data-card-name', c.name);
    el.setAttribute('onclick', pickFn + '(' + i + ')');
    return el.outerHTML;
  },
};
