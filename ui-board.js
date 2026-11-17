// ============================================================
// ui-board.js — THE BOARD (split out of ui.js)
// ============================================================
// renderBoard and its diff-render foundation: the captured card-element
// cache, makeCardElCached and the art/orb preservers, the board
// fit-to-viewport solve, and the lane-element lookup.
//
// Same contract as fx.js: loads BEFORE ui.js and only declares UI_BOARD;
// ui.js merges it into UI right after the UI literal, before UI.init().
// ============================================================
const UI_BOARD = {
  // ===================== BOARD =====================

  // ===================== DIFF-RENDER FOUNDATION =====================
  // Previous render's card DOM elements, keyed by card.id, so an element
  // with unchanged visual state is REUSED (in-flight CSS animations intact).
  // Captured BEFORE the board.innerHTML wipe by _captureBoardCardEls(),
  // consumed by makeCardElCached(), released by renderBoard's wrapper.
  _capturedBoardCardEls: null,

  // Persistent lane DOM cache, indexed by lane idx (0-5), lazy-initialized.
  // The board's innerHTML is wiped every render, but the lane <div>s are
  // reused so their long-running animations (.lane-number pulse, perimeter
  // sweep) don't restart and :hover isn't detached on every AI step.
  _laneEls: null,

  // Per-render classes from transient game-state context (target highlight,
  // dimmed-by-selection, etc.), stripped before a cached element is reused.
  _DECORATION_CLASSES: [
    // 'hit-flash' and 'card-enter' live in _FX_TRANSIENT_CLASSES instead —
    // they carry animations and stripping them here cancels them mid-flight.
    'target-highlight', 'dimmed-by-selection', 'hit-shake',
    'card-reveal-flip', 'card-anticipating', 'card-flying',
    // Durable for the length of a drag, re-applied from UI._draggingCardId by
    // the hand renderer (like 'face-flipped'). Not FX-transient: it ends on
    // pointer release, not a timer.
    'card-being-dragged',
    'is-selected', 'selected', 'jump-ready', 'card-shake-rejected',
    'forecast-target', 'forecast-source',
    // 'face-flipped' is durable state (UI._flippedHandCardId) re-applied by
    // the hand renderer every render — so strip-and-re-add is correct here,
    // not in _FX_TRANSIENT_CLASSES.
    'face-flipped'
  ],

  // ONE-SHOT FX CLASSES — applied IMPERATIVELY after a render, so they're on
  // the cached node but never on the fresh one. Exempted from the REMOVAL half
  // of the className diff so a live animation survives the transplant (the
  // snapshot busts exactly when HP changes, i.e. mid-combat).
  //
  // SAFETY RULE — every class here MUST provably remove itself on a timer, or
  // exempting it strands it on the card forever. Verified self-removing:
  //   combat-attacker / combat-target  → classOnCard's setTimeout
  //   hit-flash-heavy / hit-flash-lethal → setTimeout in the hit-flash path
  //   card-knockback                     → setTimeout in the knockback path
  // Do NOT add a class here without finding its removal timer first.
  _FX_TRANSIENT_CLASSES: [
    'combat-attacker', 'combat-target',
    // Jump entrance snap — removed by _fxJumpIn's own 520ms setTimeout.
    'fx-jump-snap',
    // The BASE class too: hit-flash-heavy/-lethal only set --flash-bright; the
    // animation lives on `.card.hit-flash`. Self-removes on a timer.
    'hit-flash',
    'hit-flash-heavy', 'hit-flash-lethal',
    'card-knockback',
    // The on-play entrance: playing a card always triggers a render, so these
    // must survive it. Self-removing: card-enter (1100ms), card-landing
    // (400ms). Vibe loops are gated on `:not(.card-enter)`, so killing
    // card-enter early would also start the ambient loop on a half entrance.
    'card-enter', 'card-landing',
    // Spinosaurus: applied exactly when the snapshot busts (release paints a
    // new card; rampage changes six enemies' HP). Self-removing via setTimeouts
    // in _spinosaurusRelease (800ms) / _spinosaurusRampage (700ms).
    'spino-reveal', 'spino-rampage'
  ],

  // Snapshot of every card-state field that affects the rendered visual.
  // If this string changes between renders, the cached element is stale
  // and a fresh build is required. Numeric fields are coerced via | 0
  // (faster than parseInt; treats null/undefined as 0).
  _cardVisualSnapshot(card) {
    if (!card) return '';
    // Prediction fields bust the cache when the combat predictor's verdict for
    // this card flips (else skull badges go stale). The predictor is stable
    // while nobody acts, so churn is mild. Reads UI._combatPredCache
    // (populated at render start), O(1) per card.
    let pred = null;
    if (this._combatPredCache && this._combatPredCache.byId) {
      pred = this._combatPredCache.byId.get(card.id);
    }
    // Projected in-fight XP affects the chip text, so it's in the snap too.
    let pxp = 0;
    if (card._runDeckCardRef && typeof Roguelite !== 'undefined' && Roguelite.projectedXp) {
      pxp = Roguelite.projectedXp(card) | 0;
    }
    // Effective cost includes opponent passives (Silver Surfer +1) and own-side
    // discounts (Captain America); without it cached hand cards show the BASE
    // cost while Game.getCardCost enforces the real one.
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
      tt: card.tauntTurns | 0,     sr: (Game.effectiveSplash ? Game.effectiveSplash(card) : card.splashRange) | 0,
      di: !!card.hasDamageImmunity, im: card.immunityCharges | 0,
      ur: card.unresistibleCharges | 0, dr: card.drawOnPlay | 0,
      bs: !!card.isBullseye, od: !!card.isOverdrive,
      hu: !!card.hasHunt, rev: card.reviveCharges | 0,
      // Spinosaurus's Hunt Meter and Wetlands' Power print live counts in the
      // status row, so they must bust the snapshot. hms (spent) is needed
      // because a count back at 0 looks identical to "never filled".
      hm: card._spinoMeter | 0, hms: !!card._spinoHuntSpent, ovd: !!card.isOverdrive,
      wp: (card._wetPower == null ? -1 : card._wetPower | 0), wr: !!card._wetReleased,
      pl: !!card._parlayedThisRound,
      cr: !!card.isCrazy, ins: !!card.isInsane,
      fd: !!card.isFaceDown, jr: !!card.jumpReady,
      ut: !!card.isUntrickable,
      fks: !!card._freddySlashing,
      // burnStacks too — the badge's count decaying 3->2->1 is the point of it.
      crit: !!card._criticalThisRound, burn: !!card.isBurning, bstk: card.burnStacks | 0,
      chn: !!card._chained,
      ma: !!card._mastersApprentice,
      brl: card._bullseyeRoundsLeft | 0, ds: card._debuffStacks | 0,
      // Predictor + projected XP fields — keep last so they're visible
      // in the data-snap attr for debugging.
      pdi: pred ? (pred.dmgIn | 0) : 0,
      pdd: pred ? !!pred.dies : false,
      cby: card._charmedByIvy != null ? (card._charmedByIvy | 0) : 0,
      pxp: pxp,
      // Art-edit revision — see _bumpArtRev. Not a card field; without it a
      // crop/zoom/variant change never busts the hand or board cache.
      ar: this._artRev | 0,
    });
  },

  // Pre-render hook, called at the start of renderBoard BEFORE the innerHTML
  // wipe: stashes every card element by data-card-id for makeCardElCached().
  // CRITICAL: stores an ARRAY per id — multiple instances of one card can be
  // on the board (e.g. 6 Roguelite Jasons). Keying by a single element made
  // the other lanes build fresh nodes each render and stack stale copies in
  // their slots. Instances are consumed one by one during the rebuild.
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

  // Diff-render entry point. If a cached element exists for this id AND the
  // visual snapshot matches, reuse it (preserving in-flight CSS animations);
  // otherwise build via makeCardEl. Reused elements have transient
  // decoration classes stripped so the caller applies this render's
  // decorations on a clean baseline. The snapshot is stamped on data-snap.

  // Preserve the already-composited `.card-portrait` node across a transplant
  // when the art URL is unchanged. The state-changed branch rebuilds children
  // via replaceChildren whenever the snapshot busts (HP, predictor — many
  // cards at once in combat). `.card-portrait` is deliberately NOT
  // GPU-promoted (VRAM budget, see style.css), so a fresh node flashes its
  // #111 fallback for a frame before the bitmap composites. Keeping the live
  // node kills the blink while siblings still refresh. Call right before the
  // caller's replaceChildren. Presentation-only.
  // Art vars that are NOT the URL: `_artFocalCard` stamps --portrait-pos
  // (crop focal), --portrait-size (zoom) and --art-grade (brightness) beside
  // --portrait-bg. A crop edit changes only these, so they're synced onto the
  // live node (re-swapping would bring the blink back). Explicit list, not a
  // wholesale style copy — the live node also carries the fit loop's
  // imperative height/aspect-ratio, which must not be wiped.
  _PORTRAIT_ART_VARS: ['--portrait-pos', '--portrait-size', '--art-grade'],
  _preserveCardArt(cached, fresh) {
    if (!cached || !fresh) return;
    const oldP = cached.querySelector(':scope > .card-portrait');
    const newP = fresh.querySelector(':scope > .card-portrait');
    if (oldP && newP &&
        oldP.style.getPropertyValue('--portrait-bg') === newP.style.getPropertyValue('--portrait-bg')) {
      // Same art → keep the live composited node: refresh its inner content
      // from fresh, then substitute it into fresh's child list so it survives
      // replaceChildren.
      this._PORTRAIT_ART_VARS.forEach(v => {
        const next = newP.style.getPropertyValue(v);
        if (next === oldP.style.getPropertyValue(v)) return;
        if (next) oldP.style.setProperty(v, next);
        else oldP.style.removeProperty(v);
      });
      oldP.replaceChildren(...newP.childNodes);
      fresh.replaceChild(oldP, newP);
    }
  },

  // A stat orb mid-pop survives the transplant. _flipStatOrb decorates the
  // orb AFTER renderBoard, and a later render inside the 600ms pop would
  // destroy it. Kept only while popping AND already counting to the number
  // the fresh orb prints (data-prev-stat = _tickStatDigit's target); a NEW
  // value takes the fresh orb, which animateStatChanges pops itself. The pop
  // classes still clear on _flipStatOrb's own 600ms timer on this node.
  _STAT_POP_CLASSES: ['stat-changed', 'stat-up', 'stat-down'],
  _preservePoppingOrbs(cached, fresh) {
    if (!cached || !fresh) return;
    const pop = this._STAT_POP_CLASSES;
    ['stat-atk', 'stat-hp'].forEach(which => {
      const oldO = cached.querySelector(':scope > .stat-circle.stat-changed.' + which);
      if (!oldO) return;
      const newO = fresh.querySelector(':scope > .stat-circle.' + which);
      if (!newO) return;
      const target = oldO.getAttribute('data-prev-stat');
      if (target == null || target !== (newO.textContent || '').trim()) return;
      // Class DIFF, not a className write — the live node keeps its animation.
      const want = new Set(String(newO.className).trim().split(/\s+/).filter(Boolean));
      String(oldO.className).trim().split(/\s+/).filter(Boolean).forEach(c => {
        if (!want.has(c) && pop.indexOf(c) === -1) oldO.classList.remove(c);
      });
      want.forEach(c => { if (!oldO.classList.contains(c)) oldO.classList.add(c); });
      const tip = newO.getAttribute('title');
      if (tip != null) oldO.setAttribute('title', tip); else oldO.removeAttribute('title');
      fresh.replaceChild(oldO, newO);
    });
  },
  makeCardElCached(card, inHand, side) {
    if (!card || card.id == null || inHand) {
      // Hand cards aren't cached — they reorder every render (sort by cost);
      // their animation continuity comes from deterministic --card-anim-phase.
      return this.makeCardEl(card, inHand, side);
    }
    const idStr = String(card.id);
    // shift() hands back one element per call for multi-instance ids. Capture
    // order ≈ the left-to-right build order, so each lane's element tends to
    // round-trip to the same lane (animations stay continuous per lane).
    const list = this._capturedBoardCardEls && this._capturedBoardCardEls.get(idStr);
    const cached = (list && list.length) ? list.shift() : null;
    const snap = this._cardVisualSnapshot(card);
    if (cached && cached.dataset && cached.dataset.snap === snap) {
      // STATE UNCHANGED — reuse the node (animations continue); strip transient
      // decoration classes so this render applies a clean set.
      this._DECORATION_CLASSES.forEach(c => cached.classList.remove(c));
      // Clean stale inline styles that decorations may have left.
      cached.style.cursor = '';
      return cached;
    }
    // STATE CHANGED — if we have a cached node, TRANSPLANT new content into it
    // instead of returning a fresh node. The infinite animations (.vibe-*,
    // .tron-perimeter-card, .card-hp-critical tremor) live on the parent .card,
    // so keeping its identity keeps them running and preserves the active
    // :hover (otherwise the magnify preview blips during AI thinking).
    const fresh = this.makeCardEl(card, inHand, side);
    if (cached) {
      // Keep the composited art node alive when the URL is unchanged — must run
      // before the replaceChildren transplant below.
      this._preserveCardArt(cached, fresh);
      // Same for a stat orb that is mid-pop: keep the live node so the 600ms
      // hit/buff punch is not thrown away by a re-render inside it.
      this._preservePoppingOrbs(cached, fresh);
      // Move children from fresh into cached without recreating fresh
      // (replaceChildren is faster + avoids innerHTML stringification).
      cached.replaceChildren(...fresh.childNodes);
      // CRITICAL: diff the className rather than wholesale-assign. Any
      // className mutation makes browsers re-evaluate animation properties and
      // restart matched animations (e.g. `.card.vibe-symbiote:not(.card-enter)`)
      // EVEN WHEN THE CLASS SET IS IDENTICAL. Only add/remove what changed.
      const oldClasses = cached.className ? cached.className.trim().split(/\s+/) : [];
      const newClasses = fresh.className ? fresh.className.trim().split(/\s+/) : [];
      const oldSet = new Set(oldClasses);
      const newSet = new Set(newClasses);
      // Exempt live one-shot FX from the REMOVAL half — applied imperatively,
      // never on `fresh`; each self-removes (see _FX_TRANSIENT_CLASSES).
      const fxKeep = this._FX_TRANSIENT_CLASSES;
      for (const c of oldClasses) {
        if (!newSet.has(c) && fxKeep.indexOf(c) === -1) cached.classList.remove(c);
      }
      for (const c of newClasses) if (!oldSet.has(c)) cached.classList.add(c);
      // Sync dataset (snap stamp + builder-set attrs like data-card-name).
      Object.keys(fresh.dataset).forEach(k => { cached.dataset[k] = fresh.dataset[k]; });
      Object.keys(cached.dataset).forEach(k => {
        if (!(k in fresh.dataset) && k !== 'snap') delete cached.dataset[k];
      });
      cached.dataset.snap = snap;
      // Sync inline styles. First REMOVE everything on cached so stale values
      // (spawnHitChips' `position: relative`, one-shot `transform`s) don't
      // accumulate and push cards outside their lane; then re-apply fresh's
      // (incl. --card-anim-phase / --tremor-phase for continuity).
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
    // No prior cache — return fresh; later renders transplant into it.
    fresh.dataset.snap = snap;
    return fresh;
  },

  // THE BOARD TAKES WHATEVER HEIGHT IS STILL FREE.
  // Measured, not CSS-only: a board card is `aspect-ratio: 92/182`, and
  // `height:100%` makes it contribute no width during intrinsic sizing, so
  // flex collapses the lane and the card paints wider than it.
  // ONE VARIABLE DRIVES THE WHOLE CHAIN: --board-card-w feeds card, slot and
  // lane via CSS calc (+14/+20 offsets from the authored 140/154/160 triple),
  // so the card can't drift out of its lane.
  _fitBoardToViewport() {
    const area = document.getElementById('game-area');
    const section = document.querySelector('.board-section');
    const board = document.querySelector('.board');
    const lane = board && board.querySelector('.lane');
    const slot = lane && lane.querySelector('.card-slot');
    if (!area || !section || !board || !lane || !slot) return;
    const boardH = section.getBoundingClientRect().height;
    if (!boardH) return;
    const num = (el, ...p) => { const c = getComputedStyle(el);
      return p.reduce((t, k) => t + (parseFloat(c[k]) || 0), 0); };

    // HEIGHT BOUND — must NOT depend on the hand's CURRENT height, or the board
    // resizes mid-turn every time a card is played or drawn. The hand is
    // charged at its CEILING (a 200px card), so board size is a pure function
    // of the viewport.
    const handRow = document.querySelector('.player-hand-section');
    let others = area.scrollHeight - boardH;
    if (handRow) {
      const hcs = getComputedStyle(handRow);
      // Charged at the CEILING, always (the row never collapses).
      const handMax = 200 * 182 / 92
          + (parseFloat(hcs.paddingTop) || 0) + (parseFloat(hcs.paddingBottom) || 0);
      others = others - handRow.getBoundingClientRect().height + handMax;
    }
    // -12px headroom: sub-pixel rounding across two slot heights, plus the
    // hand/board competing for the same leftover height (they converge but
    // land ~1px over without it). The board yields because the hand has a hard
    // readability floor.
    const avail = window.innerHeight - others - 12;
    if (avail <= 0) return;
    // Board chrome is MEASURED as (board height - two card heights), never
    // summed from padding — the lane carries more than its box model (gap,
    // lane-number divider), so a sum goes stale; this can't be wrong by
    // construction. Measure off a lane that holds a card (an empty lane gives
    // cardH 0 and "the whole board is chrome").
    let liveCardH = 0;
    board.querySelectorAll('.card-slot > .card').forEach(c => {
      if (!liveCardH) liveCardH = c.getBoundingClientRect().height;
    });
    // 29px = the remainder the box model doesn't explain (inter-slot gap +
    // lane-number divider); used only before any card has been laid out.
    const chrome = liveCardH
      ? (boardH - 2 * liveCardH)
      : (num(lane, 'paddingTop', 'paddingBottom')
         + 2 * num(slot, 'paddingTop', 'paddingBottom') + 29);
    const cardH = (avail - chrome) / 2;
    let w = cardH * 92 / 182;

    // WIDTH BOUND — lanes plus gaps and padding must fit across; body's
    // overflow-x:hidden means a clip would go unreported.
    const lanes = board.querySelectorAll('.lane').length || 6;
    // Lane chrome is the authored offset (`lane = card + chrome`), never
    // measured: measuring (laneWidth - card) feeds the variable back into its
    // own solve and ping-pongs forever. Read from --lane-chrome, which narrow
    // screens shave to 8px so eight lanes fit.
    const laneChrome = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lane-chrome')) || 20;
    const laneGap = (parseFloat(getComputedStyle(board).gap) || 0);
    const sectionPadR = num(section, 'paddingRight');
    let across = window.innerWidth
                 - num(board, 'paddingLeft', 'paddingRight')
                 - num(section, 'paddingLeft', 'paddingRight')
                 - laneGap * (lanes - 1)
                 - 8;

    // THE DECISION COLUMN IS SPENT WIDTH, like a lane. #classic-decision is
    // absolutely positioned on the right edge, invisible to this solve, so its
    // width is decided HERE and published as --decision-w — one number sizes
    // both panel and lanes. The clamp tracks the viewport between a readable
    // minimum and a greedy-stop maximum.
    const decInset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--decision-inset')) || 10;
    const decGap   = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--decision-gap')) || 12;
    const decW = Math.round(Math.max(232, Math.min(330, window.innerWidth * 0.21)));
    // 2v2 reserves nothing for the panel: #classic-decision is rendered from
    // renderHud, which every 2v2 path returns before (it uses
    // renderInlineChoiceFallback), so the width goes to the lanes. Same
    // exemption board-v2 has, for the same reason.
    const _noDecisionCol = document.body.classList.contains('board-v2')
      || !!(typeof Game !== 'undefined' && Game.is2v2 && Game.is2v2());
    let reserve = _noDecisionCol ? 0 : (decW + decInset + decGap);
    // ...unless the screen can't afford it: on a phone the panel is an overlay,
    // not a column. If paying the reserve would push lanes under the 100px
    // readability floor, it isn't paid and the panel floats over the board.
    if (reserve && (across - reserve) / lanes - laneChrome < 100) reserve = 0;
    across -= reserve;
    w = Math.min(w, across / lanes - laneChrome);

    // 140 is the authored card width — the floor, so this can only ever GROW
    // the board. 260 stops a very tall window turning six lanes into murals.
    w = Math.max(140, Math.min(260, w));
    // The height solve is deliberately PESSIMISTIC (hand charged at its ceiling,
    // hand solved against the board floor), so without a floor the board would
    // collapse; but a floor the solve can't go under guarantees overflow. So the
    // prediction is corrected against measurement: _trimBoardToFit reads the
    // real overflow after layout and feeds a trim back through here.
    // 100 is a readability floor (still wider than a hand card at its 86px
    // floor). Limit: below ~840px viewport even a fully trimmed board can't
    // absorb overflow — fixed chrome (≈203px) + hand at its floor (≈185px)
    // exceed what's left, and the chrome has to give, not the lanes.
    w = Math.max(100, w - (this._boardTrim || 0));
    // ...AND THE WIDTH BOUND OUTRANKS THE FLOOR: the floor is a readability
    // minimum, the bound is physical — eight lanes at 100px would run off a
    // 768px iPad (unreported, body has overflow-x: hidden). 36px is the hard
    // stop and only binds on a phone showing eight lanes; a lane you can't see
    // can't be played, and tap-to-inspect covers reading it.
    const widthBound = across / lanes - laneChrome;
    if (widthBound < w) w = Math.max(36, widthBound);
    // Whole pixels: at one decimal the value flickered 155.9 / 156.2 between
    // renders on identical input, which is rounding noise, not a resize.
    const bw = Math.floor(w);
    area.style.setProperty('--board-card-w', bw + 'px');
    // ...and its height as a WHOLE pixel too: `w * 182 / 92` is fractional for
    // nearly every width, which offsets every row beneath it and splits 1px
    // neon borders into two half-opacity lines (soft line work).
    area.style.setProperty('--board-card-h', Math.round(bw * 182 / 92) + 'px');
    // ...AND HOW FAR THE BOARD STANDS OFF CENTRE so the panel clears the last
    // lane (a centred board that fits the left track still sits under the
    // panel). The shift is only the deficit:
    //     shift = reserve - (whatever gutter centring already left)
    // so a wide window shifts by zero.
    //
    // It cannot overrun the left edge: the reserve above caps the board at
    // `inner - reserve - 8`, which forces gutter >= (reserve + 8) / 2, and that
    // bounds shift at reserve/2 - 12 against a left gutter of at least
    // reserve/2 + 12. The two are the same arithmetic, so they cannot disagree.
    const laidBoardW = lanes * (bw + laneChrome) + laneGap * (lanes - 1);
    const gutter = Math.max(0, (window.innerWidth - num(section, 'paddingLeft', 'paddingRight') - laidBoardW) / 2);
    // ON THE ROOT, not #game-area: the notice toast and trick reveal are
    // `position: fixed` children of <body>, so they must read the same numbers
    // to line up with the gutter.
    const root = document.documentElement;
    // 2v2 pays no reserve but still has slack; it becomes a COLUMN on the right
    // (board flush left) for decisions and notices, like 1v1, without taking
    // pixels off the lanes. The column is sized to the slack, not decW (asking
    // for more would hang the panel over lane 8), and is declined below the
    // same 232 readability floor the reserve uses.
    // FLUSH LEFT. The margin is the HAND TOOLS COLUMN's width, not zero: grid
    // column 1 is max(--board-left, --hand-col-w), so a board at 0 would
    // misalign the lanes from the hand row.
    const _handColW = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--hand-col-w')) || 54;
    const _leftMargin = Math.max(num(section, 'paddingLeft'), _handColW);
    // 2v2's slack column is measured from the right, where the column lives.
    const _slackCol = (reserve === 0 && typeof Game !== 'undefined' && Game.is2v2 && Game.is2v2())
      ? Math.round(Math.max(0, window.innerWidth - _leftMargin - laidBoardW - decInset - decGap))
      : 0;
    const _use2v2Col = _slackCol >= 232;
    root.style.setProperty('--decision-w', (_use2v2Col ? _slackCol : decW) + 'px');
    // WHERE THE COLUMN STARTS. The panel is fixed-positioned on <body> (see
    // _classicDecisionSlot), so publish the section's measured top rather than
    // summing HUD + enemy bar (a sum that goes stale).
    root.style.setProperty('--decision-top', Math.round(section.getBoundingClientRect().top) + 'px');
    // ...AND WHERE IT ENDS. The notice parks against the board's bottom, not
    // the viewport floor — below the board sit full-width rows (forecast,
    // player bar, hand) it would otherwise land on.
    root.style.setProperty('--decision-bottom', Math.round(section.getBoundingClientRect().bottom) + 'px');
    // WHERE THE HAND ROW STARTS, for the 2v2 turn-order tracker to sit level
    // with the cards. Measured off the hand section (the bar's height is a
    // breakpoint value — 64px desktop, 52px phone); falls back to the board's
    // bottom before the hand has rendered (first frame of a match).
    const _handSec = document.querySelector('.player-hand-section');
    const _handTop = _handSec
      ? Math.round(_handSec.getBoundingClientRect().top)
      : Math.round(section.getBoundingClientRect().bottom);
    if (_handTop > 0) root.style.setProperty('--hand-top', _handTop + 'px');
    // WHERE LANE 1 STARTS, published for the hand + tricks row so it aligns
    // with the shifted board. Derived from the same numbers as the shift, not
    // the board's rect — this runs BEFORE the new --board-card-w is laid out,
    // so a rect would be a frame stale.
    // One rule for both modes: with a column, the board goes to the left
    // margin and the leftover is the column's.
    const laneShift = (reserve || _use2v2Col)
      ? Math.max(0, Math.round(num(section, 'paddingLeft') + gutter - _leftMargin))
      : 0;
    root.style.setProperty('--decision-shift', laneShift + 'px');
    root.style.setProperty('--board-left',
      Math.max(0, Math.round(num(section, 'paddingLeft') + gutter - laneShift)) + 'px');
    // ...and whether the column EXISTS at all (declined on phones). A class,
    // not a `--decision-shift > 0` test — the shift is legitimately 0 on a wide
    // screen where the column is real.
    document.body.classList.toggle('decision-column', reserve > 0 || _use2v2Col);
    // Lanes just moved: the forecast strip measured its cells during render,
    // BEFORE this solve, so re-align here where lane geometry is final.
    // Deferred a frame so the new property is laid out before anything reads it.
    requestAnimationFrame(() => {
      try { this._trimBoardToFit(); } catch (e) {}
      try { this.alignLaneForecastStrip(true); } catch (e) {}
    });
  },

  // MEASURE THE OVERFLOW, DO NOT PREDICT IT.
  // Converts real document overflow into a width trim the board solve applies
  // next pass. A lane stacks TWO cards at height w*182/92, so 1px of width is
  // ≈3.96px of board height: to shed `over` px, trim over*92/364 px of width.
  // Converges because the trim responds only to measured overflow, is capped,
  // and gives pixels back one at a time only with genuine slack. The
  // re-entry guard stops the fit it triggers from recursing.
  _trimBoardToFit() {
    if (this._inBoardTrim) return;
    const area = document.getElementById('game-area');
    if (!area || !document.body.classList.contains('in-match')) return;
    // NOT document.body.scrollHeight: body is pinned to 100dvh, so it never
    // reports LESS than the viewport and the trim could never unwind. The last
    // in-flow section's bottom edge is signed both ways, as a corrector needs.
    let bottom = 0;
    for (const el of area.children) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.position === 'fixed' || cs.position === 'absolute') continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom > bottom) bottom = r.bottom;
    }
    if (!bottom) return;
    const over = bottom - document.documentElement.clientHeight;
    // One pixel of card width is 2*182/92 ≈ 3.96px of board height.
    const PX = 364 / 92;
    const before = this._boardTrim || 0;
    let trim = before;
    if (over > 0) {
      // 60 is the cap: 140 - 60 = 80, already under the 110 hard minimum the
      // solve enforces, so the trim can never outrun the floor and spin.
      trim = Math.min(60, trim + Math.ceil(over / PX));
    } else if (over < -PX && trim > 0) {
      // Give room back, but leave one trim-pixel of slack unclaimed — that
      // deadband stops it trading places with itself frame after frame.
      trim = Math.max(0, trim - Math.floor((-over - PX) / PX));
    }
    if (trim === before) return;
    this._boardTrim = trim;
    this._inBoardTrim = true;
    try { this._fitBoardToViewport(); } finally { this._inBoardTrim = false; }
  },

  // Thin wrapper so the captured-element Map is ALWAYS released, even on a
  // throw — otherwise a stale Map of detached nodes from an aborted pass
  // (survivable, see _safe) could be handed back by the next render.

  renderBoard(s) {
    // INVISIBLE-CARD SAFETY SWEEP. `.card.card-enter` holds opacity:0 + a full
    // reveal mask (fill-mode both), and its removal is a per-element 1.1s
    // setTimeout that a re-render can outlive — leaving a clickable but invisible
    // card. Strip card-enter from any card whose data-enterAt window has elapsed
    // (or that has no stamp), so no card stays invisible past ~1.2s.
    try {
      const now = Date.now();
      document.querySelectorAll('#board .card.card-enter').forEach(el => {
        const t = +(el.dataset && el.dataset.enterAt) || 0;
        if (!t || (now - t) > 1300) { el.classList.remove('card-enter'); if (el.dataset) delete el.dataset.enterAt; }
      });
      // SAME HAZARD, OTHER DIRECTION. card-exit (cardDestroy, 0.9s, fill-mode
      // forwards) ends fully mask-dissolved. If a re-render reuses that tile for
      // a live card before the class clears, the live card inherits the dissolve
      // and vanishes while staying clickable. Strip card-exit once its window has
      // elapsed (or there is no stamp).
      document.querySelectorAll('#board .card.card-exit').forEach(el => {
        const t = +(el.dataset && el.dataset.exitAt) || 0;
        if (!t || (now - t) > 1100) { el.classList.remove('card-exit'); if (el.dataset) delete el.dataset.exitAt; }
      });
      // THIRD OF THE SAME FAMILY — card-flying is flat `opacity: 0` with no
      // animation to end. land() in _animateFly clears it on the element it held
      // when the flight began, so a mid-flight re-render (tile reuse) leaves the
      // live tile invisible. Flight is 360ms + 90ms fallback, so anything still
      // flying after 900ms is stuck. Querying the LIVE DOM is what catches the
      // reused-tile case the timeouts cannot.
      document.querySelectorAll('#board .card.card-flying').forEach(el => {
        const t = +(el.dataset && el.dataset.flyAt) || 0;
        if (!t || (now - t) > 900) { el.classList.remove('card-flying'); if (el.dataset) delete el.dataset.flyAt; }
      });
      // FOURTH OF THE FAMILY — card-pre-derez. Not an invisible card: an 80ms
      // pre-flash that ends at brightness(2.5) and persists, so a stuck one is
      // a permanently blown-out white tile. Same reused-tile cause.
      document.querySelectorAll('#board .card.card-pre-derez').forEach(el => {
        const t = +(el.dataset && el.dataset.derezAt) || 0;
        if (!t || (now - t) > 400) { el.classList.remove('card-pre-derez'); if (el.dataset) delete el.dataset.derezAt; }
      });
      // FIFTH — card-killcam-target. Ends visible, so nothing disappears; what
      // it leaves behind is z-index:7 on a tile whose kill-cam was cut short by
      // the next kill taking the single shared timer.
      document.querySelectorAll('#board .card.card-killcam-target').forEach(el => {
        const t = +(el.dataset && el.dataset.kcAt) || 0;
        if (!t || (now - t) > 500) { el.classList.remove('card-killcam-target'); if (el.dataset) delete el.dataset.kcAt; }
      });
    } catch (e) {}
    try {
      this._renderBoardImpl(s);
    } finally {
      this._capturedBoardCardEls = null;
    }
  },

  _renderBoardImpl(s) {
    // STEP 1 — capture every card element currently on the board, keyed
    // by data-card-id, so makeCardElCached() below can reuse the same
    // DOM node when the card's visual state is unchanged. This is the
    // single biggest win for animation continuity: cached elements
    // KEEP their in-flight CSS animations across renders instead of
    // restarting at 0% on every phase change.
    this._captureBoardCardEls();
    // SMART WIPE — board.innerHTML = '' would detach every descendant, and
    // browsers restart CSS animations on detach + reattach. Clear only the
    // watermark + motes (the disposable children) and KEEP cached lane subtrees
    // attached, so slots and cards keep their animation timelines intact.
    Array.from(this.board.children).forEach(child => {
      if (child.classList && (child.classList.contains('round-watermark') || child.classList.contains('board-mote'))) {
        child.remove();
      }
    });
    // AND DROP LANES THAT NO LONGER EXIST. The wipe above keeps cached lanes
    // attached, but the lane COUNT can change (8 in 2v2, 6 in 1v1). Surviving
    // lanes are re-appended to the end, so stale extras would sit in front and
    // shift anything reading the board positionally. Trim the cache and detach.
    if (this._laneEls && this._laneEls.length > Game.LANE_COUNT) {
      this._laneEls.splice(Game.LANE_COUNT).forEach(el => { if (el && el.remove) el.remove(); });
    }
    const canPlay = this.canPlayerPlayCards(s);
    const cc = s.pendingCardChoice;
    const lc = s.pendingLaneChoice;
    // Only render interactive pick targets for the local seat's own choices —
    // the opponent resolves their prompts on their own client. promptIsMine
    // unifies solo / 1v1 seat-flip / 2v2 _2v2ActingPlayer ownership.
    const isMyCardChoice = Game.promptIsMine(cc, 'card');
    const isMyLaneChoice = Game.promptIsMine(lc, 'lane');
    const targetCardIds = new Set();
    // EVERY PICK-A-CARD PROMPT LIGHTS UP ITS TARGETS ON THE BOARD, tray or no
    // tray — the tray shows options divorced from the lanes, so the board must
    // show which cards are legal. The tray still shows and answers; this only
    // adds the glow (and direct click) on the board copy. 2v2 board renderers
    // paint no target-highlight, which is why the tray exists there.
    //
    // The HAND is deliberately left out — see the targetHandIds rule in
    // renderPlayerHand (tray prompts must not highlight hand cards).
    if (cc && isMyCardChoice) cc.cards.forEach(c => { if (c.id !== undefined) targetCardIds.add(c.id); });
    const lcTargetSide = (lc && isMyLaneChoice) ? (lc.targetSide || lc.owner) : null;
    // ABILITY TARGET PREVIEW — when a card is SELECTED in hand (and no pick
    // prompt is open) glow the enemies its onPlay ability could hit. The class
    // (.target-highlight) is in _DECORATION_CLASSES, so it auto-clears on the
    // next render once the card is deselected or played.
    const abilityTargetIds = (s.selectedCard && !cc && !lc && Game.previewAbilityTargets)
      ? new Set((Game.previewAbilityTargets(s.selectedCard, s.selectedCard.owner) || []).map(c => c.id))
      : null;
    // Effective forced lane for each seat — Moder's single forcedLane only.
    const _effectiveForcedLane = (seat) => {
      const p = s[seat]; if (!p) return null;
      // Ask the engine whether the compulsion is still REAL — a stamped
      // forcedLane can outlive a Moder who left the board silently.
      // moderCompulsionLane checks a living Moder still stands there.
      const live = (Game.moderCompulsionLane ? Game.moderCompulsionLane(seat) : (p.forcedLane != null ? p.forcedLane : -1));
      if (live >= 0) {
        // Only report the lock if the forced lane is still open — if the seat
        // already has a card there the lock can't fire anyway.
        const fl = s.lanes[live];
        if (fl && !fl.destroyed && !fl[seat]) return live;
      }
      return null;
    };
    const forcedAi = _effectiveForcedLane('ai');
    const forcedPlayer = _effectiveForcedLane('player');

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
      // Reuse the cached lane element so .lane-number's tronCirclePulse and
      // in-flight transitions don't restart on every render; re-appending later
      // in this loop puts it back with its animation timeline intact.
      if (!this._laneEls) this._laneEls = [];
      let el = this._laneEls[i];
      if (!el) {
        el = document.createElement('div');
        this._laneEls[i] = el;
      } else {
        // Selective clear — preserve the slots + sep (their cards' CSS
        // animations must stay continuous). Remove only transient children:
        // status-row, lane-trap, dmg-preview chain, claim-wave / dust-kick /
        // landing-ring spawned by play animations.
        const KEEP = el.querySelector(':scope > .ai-slot');
        const KEEP_SEP = el.querySelector(':scope > .lane-sep');
        const KEEP_PSLOT = el.querySelector(':scope > .player-slot');
        const KEEP_ENV = el.querySelector(':scope > .lane-env-bg');
        Array.from(el.children).forEach(child => {
          if (child !== KEEP && child !== KEEP_SEP && child !== KEEP_PSLOT && child !== KEEP_ENV) {
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
      const hasAi = !!(lane.ai || (lane._env && lane._env.ai));
      const hasPl = !!(lane.player || (lane._env && lane._env.player));
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
      // Only assign className if it actually changed — avoids style-recalc
      // cost and class-toggle observers, so unchanged lanes pay zero cost.
      const nextCls = `lane ${parityClass}${occClass}` + (lane.destroyed ? ' destroyed' : '') + (s._activeLane === i ? ' lane-active' : '') + pulseClass;
      if (el.className !== nextCls) el.className = nextCls;
      // WHICH LANE THIS IS, WRITTEN ON THE ELEMENT. Position among .board > .lane
      // is not identity (cached lanes stay attached and are re-appended, so
      // stranded extras can sit at the front). The drag hit-test reads this
      // stamp instead, so the lane number cannot drift.
      if (el.dataset.lane !== String(i)) el.dataset.lane = String(i);
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
      // Stamp the predicted combat verdict on the lane so a CSS-only hover badge
      // can surface "WIN / TRADE / STALL / LOSE / STRIKE / EXPOSED". Only
      // meaningful during planning phases (CSS hides it otherwise). Kept in sync
      // with the strip via the shared helper laneForecastVerdict.
      const forecast = this.laneForecastVerdict(s, i);
      if (forecast.label !== '—') {
        el.dataset.forecast = forecast.label;
        el.dataset.forecastCls = forecast.cls;
      }
      // No data-threatIn / data-threatOut here: updateThreatSignaling owns the
      // threat visual (it accounts for stun, freeze, Bullseye, armor and
      // invincible), and a second writer on .lane::after would fight it.
      // Per-lane stagger for the Tron flowing-light packet. CSS uses
      // calc(var(--lane-index) * -1.6s) so lanes light up as a wave. Inline so
      // it's robust to DOM-sibling order (watermark and board-motes share the
      // .board parent and would throw off nth-child selectors).
      el.style.setProperty('--lane-index', i);

      // Lane number is embedded in the centerline separator (added below)
      // so it never overlaps card content.

      // Lane status glyphs row (destroyed / protected / trap / forced)
      const statusRow = [];
      if (lane.destroyed) {
        // Countdown pip — rounds remaining until the void collapses and the
        // lane reforms (3 → 2 → 1 → restores). Falls back to an unbounded ✖ if
        // the turn counter is unset (legacy saves or permanent-destroy callers).
        const turns = lane.destroyedTurns > 0 ? lane.destroyedTurns : null;
        const label = turns != null ? `${turns}` : '&#x2716;';
        const title = turns != null ? `Lane collapsed — reforms in ${turns} round${turns === 1 ? '' : 's'}` : 'Lane destroyed';
        statusRow.push(`<span class="lane-glyph glyph-destroyed" title="${title}">${label}</span>`);
      }
      // ENVIRONMENT COUNTDOWN — the same pip the destroyed lane prints, in the
      // same row: environments last 4 turns and must show how long is left.
      // One per side, coloured by side, since both may hold an environment.
      // ONE CLOCK PER ENVIRONMENT: a full-lane event seats BOTH sides on one
      // timer, so it prints once, in neutral white (it belongs to neither player).
      let _envPipDone = false;
      ['ai', 'player'].forEach(side => {
        const env = lane._env && lane._env[side];
        const left = env && (env._envTurns | 0);
        if (!env || !(left > 0)) return;
        if (env._fullLane) {
          if (_envPipDone) return;
          _envPipDone = true;
        }
        const tone = env._fullLane ? 'full' : side;
        const title = `${env.name} — ${left} round${left === 1 ? '' : 's'} left`;
        statusRow.push(`<span class="lane-glyph glyph-env glyph-env-${tone}" title="${this._esc ? this._esc(title) : title}">${left}</span>`);
      });
      if (lane.protected) statusRow.push(`<span class="lane-glyph glyph-protected glyph-${lane.protected}" title="Protected from ${lane.protected}">&#x1F6E1;</span>`);
      if (lane.trap) statusRow.push(`<span class="lane-glyph glyph-trap glyph-${lane.trap.placedBy}" title="Bear Trap by ${lane.trap.placedBy}">&#x26A0;</span>`);
      if (forcedAi === i) statusRow.push(`<span class="lane-glyph glyph-forced glyph-forced-ai" title="AI's next card forced here">&#x21E3; AI</span>`);
      if (forcedPlayer === i) statusRow.push(`<span class="lane-glyph glyph-forced glyph-forced-player" title="Your next card forced here">&#x21E3; YOU</span>`);
      // TOURNAMENT — King of the Hill: mark the Hill lane so the player knows
      // which lane to hold at round end for +2 HP.
      const _isHill = !!(Game.mod && Game.mod('kingOfHill') && Game.state._hillLane === i);
      el.classList.toggle('lane-hill', _isHill);
      if (_isHill) statusRow.push(`<span class="lane-glyph glyph-hill" title="King of the Hill — hold this lane alone at round's end for +2 HP">&#x1F451; HILL</span>`);
      // ONE OUT-OF-FLOW STACK FOR BOTH CHIPS. The lane is a flex column, so a
      // status row or trap plate appended directly would steal height from the
      // two `flex: 1 1 0` slots and shift the centreline. They go in a stack
      // pinned to the lane's bottom edge (see `.lane > .lane-chips` in
      // style.css). Anything else printing along the lane's bottom belongs here.
      let chips = null;
      const _chip = (node) => {
        if (!chips) {
          chips = document.createElement('div');
          chips.className = 'lane-chips';
        }
        chips.appendChild(node);
      };

      if (statusRow.length) {
        const row = document.createElement('div');
        row.className = 'lane-status-row';
        row.innerHTML = statusRow.join('');
        _chip(row);
      }

      if (lane.trap) {
        const trapEl = document.createElement('div');
        trapEl.className = 'lane-trap ' + (lane.trap.placedBy === 'player' ? 'trap-player' : 'trap-ai');
        trapEl.title = `Reverse Bear Trap (${lane.trap.placedBy === 'player' ? 'yours' : UI.oppNamePoss()})`;
        // Jaw-trap SVG + small label. Pure geometric shapes, no emoji.
        trapEl.innerHTML = `
          <svg class="lane-trap-icon" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="3" fill="none" stroke="currentColor" stroke-width="1.2"/>
            <path d="M3 10 L6 7 L6 13 Z M17 10 L14 7 L14 13 Z" fill="currentColor"/>
            <path d="M10 3 L8.5 5 L11.5 5 Z M10 17 L8.5 15 L11.5 15 Z" fill="currentColor"/>
          </svg>
          <span class="lane-trap-label">TRAP</span>`;
        _chip(trapEl);
      }
      if (chips) el.appendChild(chips);

      // Environment background layer — sits behind both card slots.
      // Reuse existing element across renders so it doesn't flicker.
      {
        const envAi = lane._env && lane._env.ai;
        const envPl = lane._env && lane._env.player;
        // THE APOTHICON RIFT IS AN ENVIRONMENT, so it is painted like one —
        // otherwise the forced-placement rule (lane._rift) has no visible cause.
        // It rides this existing painter to inherit the no-flicker element reuse
        // and focal/zoom handling. Art resolves via card-art-manifest's
        // 'Apothicon Rift' entry.
        const riftOn = !!(lane._rift && lane._rift.rounds > 0);
        const riftEnv = riftOn ? { name: 'Apothicon Rift' } : null;
        let envBg = el.querySelector(':scope > .lane-env-bg');
        if (envAi || envPl || riftEnv) {
          if (!envBg) {
            envBg = document.createElement('div');
            // Insert as the very first child so CSS z-index keeps it behind the slots.
            el.insertBefore(envBg, el.firstChild);
          }
          // A real environment wins the backdrop if both somehow occupy the
          // lane — the rift is the transient of the two.
          const primary = envAi || envPl || riftEnv;
          const safeClass = 'env-' + primary.name.toLowerCase().replace(/\s+/g, '-');
          // NO OWNERSHIP FLAGS (env-own-ai / env-own-player). The picture only
          // covers one half, and which half already says whose it is.
          envBg.className = 'lane-env-bg ' + safeClass;
          // THE PICTURE SITS ON THE HALF THE ENVIRONMENT ACTS AGAINST, not the
          // half that owns it; lane._env is keyed by side, so each side's
          // environment gets its own half.
          //
          // The halves are named by POSITION (env-half-top / env-half-bottom),
          // not owner, because owner and position are deliberately crossed and a
          // name saying "ai" would be wrong half the time.
          //
          // Two children inside one .lane-env-bg: the container keeps the
          // click-to-inspect target, the KEEP_ENV sweep entry and the rift frame.
          //
          // Faded, not cut: each half's mask runs to transparent at the midline,
          // so the art dissolves into the lane's black instead of a hard edge.
          const paintHalf = (where, env) => {
            const cls = 'env-half env-half-' + where;
            let half = envBg.querySelector(':scope > .env-half-' + where);
            if (!env) { if (half) half.remove(); return; }
            if (!half) {
              half = document.createElement('div');
              envBg.appendChild(half);
            }
            if (half.className !== cls) half.className = cls;
            const p = this._envArtBackground(env);
            if (half.style.background !== p) half.style.background = p;
          };
          // WHICH HALF an environment paints on is where its business HAPPENS.
          // For most that is the owner's own half; the Enclosure's T-Rex breaks
          // out onto the opponent's, so its paddock paints there. Same flag
          // releaseHabitatMonster uses to place the monster, so the picture
          // cannot end up on a different half from what comes out of it.
          //
          // A FULL-LANE ENVIRONMENT IS ONE PICTURE. Gargantua seats both sides
          // of one lane (Game._ONE_LANE_EVENTS); it gets one box that IS the
          // lane, framed once, instead of two half-crops fading across the
          // middle. The flag is stamped on the instance at the seat rather than
          // tested by name here, so the rule lives in one place for every surface.
          const _halves = { top: null, bottom: null, full: null };
          const _full = (envAi && envAi._fullLane) ? envAi
                      : (envPl && envPl._fullLane) ? envPl : null;
          if (_full) {
            _halves.full = _full;
          } else {
            [envAi, envPl].forEach(env => {
              if (!env) return;
              const lands = env.actsOnOpponentSide ? Game.opponent(env.owner) : env.owner;
              _halves[lands === 'ai' ? 'top' : 'bottom'] = env;
            });
          }
          paintHalf('top', _halves.top);
          paintHalf('bottom', _halves.bottom);
          paintHalf('full', _halves.full);

          // The container itself only paints for the RIFT, which belongs to
          // nobody and so has no half to sit in — it keeps the full lane.
          const artPath = riftEnv && !envAi && !envPl ? this.getCardArtPath(primary.name) : null;
          if (artPath) {
            // Rift only — the shared builder does the framing (see
            // _envArtBackground), so the halves and the rift crop identically.
            const _rb = this._envArtBackground(primary);
            if (envBg.style.background !== _rb) envBg.style.background = _rb;
          } else {
            envBg.style.background = '';
          }
          // SAY WHAT IT DOES, ON THE LANE. The rift's first bite kills outright
          // and everything after arrives at −4/−4 — not inferable from a purple
          // lane. The warning changes once the rift has taken its first, so it
          // never promises a kill it will not deliver.
          if (riftOn) {
            const firstStill = !lane._rift.firstClaimed;
            const want = firstStill ? 'FIRST CARD IN DIES' : 'ARRIVES \u22124/\u22124';
            let warn = envBg.querySelector(':scope > .rift-warn');
            if (!warn) {
              warn = document.createElement('div');
              warn.className = 'rift-warn';
              envBg.appendChild(warn);
            }
            if (warn.textContent !== want) warn.textContent = want;
            warn.classList.toggle('rift-warn-lethal', firstStill);
          } else {
            // Targeted removal, NOT innerHTML = ''. The halves are children of
            // this element, so wiping it would rebuild the art every render —
            // the flicker the element reuse exists to avoid.
            const _oldWarn = envBg.querySelector(':scope > .rift-warn');
            if (_oldWarn) _oldWarn.remove();
          }
          // Class on the LANE, not the backdrop, so the rim glow can sit on the
          // lane frame. Cleared in the else-branch and when the rift ends,
          // because lane elements are reused between renders.
          el.classList.toggle('lane-rift', riftOn);
        } else if (envBg) {
          envBg.style.background = '';
          envBg.remove();
          el.classList.remove('lane-rift');
        } else {
          el.classList.remove('lane-rift');
        }

        // THE ENVIRONMENT'S NAME ALWAYS SITS ON THE CENTRELINE, whatever is
        // standing in the lane, so the name lives in ONE place.
        //
        // The top/bottom .env-bg-label pair is therefore never built — only
        // removed, to clear leftovers from older renders. Their click-to-inspect
        // moved to the centreline pill along with the name.
        const _sepEnv = envAi || envPl;
        const _oldLabelAi = el.querySelector(':scope > .env-bg-label-ai');
        const _oldLabelPl = el.querySelector(':scope > .env-bg-label-player');
        if (_oldLabelAi) _oldLabelAi.remove();
        if (_oldLabelPl) _oldLabelPl.remove();
        el._sepEnvName = _sepEnv ? this._envLabelText(_sepEnv) : '';
        el._sepEnvCard = _sepEnv || null;
      }

      // AI slot — reuse existing if cached lane already has one, so its card
      // child's CSS animations don't restart on render.
      let aiSlot = el.querySelector(':scope > .ai-slot');
      if (!aiSlot) {
        aiSlot = document.createElement('div');
      }
      // Replace inner content (card or empty-glyph) below; the class assignment
      // is idempotent, and gives a fresh slot the right class.
      if (aiSlot.className !== 'card-slot ai-slot') aiSlot.className = 'card-slot ai-slot';
      // Decide the card element FIRST (via cache lookup or fresh build), then
      // sweep — keeping ONLY the chosen element. data-card-id is not unique
      // (multiple instances of one card can exist), so _captureBoardCardEls
      // holds arrays per id and anything that ISN'T the chosen cardEl is
      // removed, regardless of id. Single path, no chance of accumulation.
      const aiEnvCard = lane._env && lane._env.ai;
      const aiDisplayCard = lane.ai;
      let aiCardEl = null;
      if (aiDisplayCard) {
        aiCardEl = aiDisplayCard.isFaceDown ? this.makeFaceDownEl() : this.makeCardElCached(aiDisplayCard, false, 'enemy');
      }
      // Clear stale click handlers BEFORE conditional re-assignment below.
      // makeCardElCached returns the same DOM element across renders, so
      // addEventListener would STACK handlers and a stale one (with a captured
      // idx from an earlier prompt) would fire first. .onclick replaces; null
      // clears when no prompt applies.
      aiSlot.onclick = null;
      if (aiCardEl) aiCardEl.onclick = null;
      Array.from(aiSlot.children).forEach(child => {
        if (child !== aiCardEl) child.remove();
      });
      // FORCE-ATTACH IMMEDIATELY after the sweep — the anti-invisible-card
      // primary defense, so a card in state always lands in the slot DOM even
      // if a later path skips the trailing append. Idempotent if attached.
      if (aiCardEl && aiCardEl.parentNode !== aiSlot) {
        aiSlot.appendChild(aiCardEl);
      }
      if (aiDisplayCard) {
        const cardEl = aiCardEl;
        if (aiDisplayCard.id !== undefined) currentBoardIds.add(aiDisplayCard.id);
        if (!this._lastBoardCardIds.has(aiDisplayCard.id)) {
          // Enemy cards use the same "build from grid" animation as ally cards
          // (1.0s clip-path reveal from bottom up + scan line), so the play
          // moment reads the same for both sides. Timeout = the 1.0s animation
          // plus a small safety margin.
          cardEl.dataset.enterAt = String(Date.now());   // swept if it ever gets stuck (see renderBoard)
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
          // The touchdown thump (shake + lane flash + shockring) — the same
          // canonical beat a player card gets, so the AI, an MP opponent and
          // the 2v2 enemy team all land with weight.
          this._landThump(el, aiDisplayCard.cost, 'ai', cardEl);
        }
        // DEFAULT click handler — tap a board card to open the inspect popup.
        // The cc / lc branches below override this when the card is a valid
        // target, so targeting flow is preserved. Skipped for face-down enemy
        // tiles — inspect would leak hidden information.
        if (!aiDisplayCard.isFaceDown) {
          cardEl.onclick = () => UI.openCardInspect(aiDisplayCard);
        }
        if (cc && targetCardIds.has(aiDisplayCard.id)) {
          cardEl.classList.add('target-highlight');
          const idx = cc.cards.findIndex(c => c.id === aiDisplayCard.id);
          cardEl.onclick = () => cardChoicePick(idx);
        }
        // ---- Iron Man kill preview ----
        // With Iron Man selected in hand, mark every damaged enemy whose cost is
        // within his tier-gated ceiling (common ≤5, rare ≤8, special ≤9,
        // legendary any). Mirrors Iron Man.onPlay's filter in abilities.js.
        // `card-kill-preview` (skull glow) is distinct from .target-highlight so
        // "I have to pick this" reads differently from "this WILL die".
        if (s.selectedCard && s.selectedCard.name === 'Iron Man'
            && lane.ai.currentHealth < lane.ai.maxHealth) {
          const ironRarity = s.selectedCard._runRarity;
          const ironCap = ironRarity === 'legendary' ? 99
            : ironRarity === 'special' ? 9
            : ironRarity === 'rare' ? 8
            : 5;
          const enemyCost = lane.ai.baseCost || lane.ai.cost || 0;
          if (enemyCost <= ironCap) cardEl.classList.add('card-kill-preview');
          else cardEl.classList.remove('card-kill-preview');
        } else {
          // Clear the preview class when Iron Man is no longer
          // selected so a stale highlight doesn't linger.
          cardEl.classList.remove('card-kill-preview');
        }
        // Generalized ability-target preview: a card selected in hand glows the
        // enemies its onPlay could hit. Gated to pure selection (no active pick
        // prompt), and uses .target-highlight (in _DECORATION_CLASSES →
        // auto-cleared on the next render).
        if (abilityTargetIds && lane.ai && abilityTargetIds.has(lane.ai.id)) {
          cardEl.classList.add('target-highlight');
        }
        // Lane-choice prompts (Vader's chain, Green Goblin target-lane, etc.)
        // that target the AI side need clicks on the OCCUPIED card, not just an
        // empty slot, so add click + glow to the card element here.
        if (lc && lcTargetSide === 'ai' && lc.lanes.includes(i)) {
          aiSlot.classList.add('target-highlight');
          cardEl.classList.add('target-highlight');
          cardEl.style.cursor = 'pointer';
          cardEl.onclick = () => laneChoicePick(i);
          // Chain-ability damage preview — when promptLaneChoice was called
          // with previewDamage (Vader chain = 7, etc.), label each candidate
          // with the post-mitigation "− N HP" for that target.
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
        // Append card only if not already attached to this slot — re-appending
        // the same child detaches + re-attaches it, which restarts its CSS
        // animations.
        if (cardEl.parentNode !== aiSlot) aiSlot.appendChild(cardEl);
      } else if (lc && lcTargetSide === 'ai' && lc.lanes.includes(i)) {
        aiSlot.classList.add('target-highlight');
        aiSlot.onclick = () => laneChoicePick(i);
        // An uncontested lane offered as a target = a direct hero strike
        // (Han Solo "stay"). Label it so it never reads as targeting an empty lane.
        if (lc.heroStrikeLane === i) {
          aiSlot.classList.add('target-hero-strike');
          const hs = document.createElement('div');
          hs.className = 'hero-strike-glyph';
          hs.textContent = 'STRIKE HERO';
          aiSlot.appendChild(hs);
        }
      } else if (!lane.destroyed) {
        // The empty slot's mark is the LANE NUMBER, ghosted behind the
        // light-cell. Because it only exists while the slot is empty, the whole
        // light-cell treatment is scoped to empty slots with no :has() or JS gate.
        const empty = document.createElement('div');
        empty.className = 'empty-lane-glyph';
        empty.textContent = String(i + 1);
        aiSlot.appendChild(empty);
      }
      // Same anti-reattach guard for the slot itself.
      if (aiSlot.parentNode !== el) el.appendChild(aiSlot);

      // Battle centerline separator with embedded lane number — sits between
      // the AI and player halves so it never overlaps card content. Reused so
      // the .lane-number's tronCirclePulse keeps its phase.
      let sep = el.querySelector(':scope > .lane-sep');
      if (!sep) {
        sep = document.createElement('div');
        sep.innerHTML = `<span class="lane-number">${i + 1}</span>`;
      }
      // Swap the number for the environment's name in a contested lane. The
      // NODE is reused and only its text and one class change — rebuilding the
      // span would restart tronCirclePulse, which is the exact reason the sep
      // is cached rather than recreated (see the comment above).
      {
        const numEl = sep.querySelector(':scope > .lane-number');
        if (numEl) {
          const want = el._sepEnvName || String(i + 1);
          if (numEl.textContent !== want) numEl.textContent = want;
          numEl.classList.toggle('lane-number-env', !!el._sepEnvName);
          if (el._sepEnvName) {
            numEl.title = el._sepEnvName;
            // TAPPABLE: the name is the only handle on an environment once cards
            // cover the lane, so it opens the card inspector.
            // Read el._sepEnvCard at CLICK time rather than capturing _sepEnv:
            // this node is cached across renders, so a captured reference would
            // open whichever environment was there when the handler was attached.
            numEl.onclick = (e) => {
              const env = el._sepEnvCard;
              if (env) { UI.openCardInspect(env); e.stopPropagation(); }
            };
          } else {
            numEl.removeAttribute('title');
            numEl.onclick = null;      // a plain lane number is not interactive
          }
        }
      }
      const sepCls = 'lane-sep' + (s._activeLane === i ? ' lane-active' : '');
      if (sep.className !== sepCls) sep.className = sepCls;
      // Append only if not already a child (re-appending restarts CSS
      // animation timing).
      if (sep.parentNode !== el) el.appendChild(sep);

      // Player slot — reuse existing if cached lane already has one.
      let pSlot = el.querySelector(':scope > .player-slot');
      if (!pSlot) {
        pSlot = document.createElement('div');
      }
      if (pSlot.className !== 'card-slot player-slot') pSlot.className = 'card-slot player-slot';
      // Same chosen-element cleanup as ai-slot — compute the cardEl first,
      // then remove any child that isn't it (no accumulation with
      // multi-instance cards).
      const plEnvCard = lane._env && lane._env.player;
      const plDisplayCard = lane.player;
      let plCardEl = null;
      if (plDisplayCard) {
        // Face-down = card back for the OWNER as well, matching what the
        // opponent sees, so both players look at the identical hidden card.
        plCardEl = plDisplayCard.isFaceDown
          ? this.makeFaceDownEl()
          : this.makeCardElCached(plDisplayCard, false, 'ally');
      }
      // Mirror of the AI-side stale-handler clear above, so a prompt that
      // re-fires with different cc.cards indices can't hit a stale handler.
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
      if (plDisplayCard) {
        const cardEl = plCardEl;
        // A face-down card shows the CARD BACK to its owner too, so both
        // players see the same board.
        if (lane.player && lane.player.isFaceDown) cardEl.classList.add('face-down');
        if (plDisplayCard.id !== undefined) currentBoardIds.add(plDisplayCard.id);
        if (!this._lastBoardCardIds.has(plDisplayCard.id)) {
          // If this card just came from the hand it will FLY hand→lane
          // (_animateFly, fired after this render by _applyMotionEffects).
          // Defer the build-in + landing FX to the landing, and hide the card
          // until then so it never sits in the lane while the ghost is mid-air.
          // Everything else (summons, environments, reduced-motion) lands now.
          const pv = this._prevRects && this._prevRects.get(plDisplayCard.id);
          const willFly = pv && pv.inHand && !(this._reducedMotion && this._reducedMotion())
            && !this._wasDragDropped(plDisplayCard.id);
          if (willFly) {
            // INVISIBLE-CARD FAMILY: card-flying gets a stamp so the renderBoard
            // sweep can clear it. Its only other removal is land() in
            // _animateFly, which holds the element captured at flight start —
            // a re-render during the ~360ms flight (tile reuse) would leave the
            // live tile at `opacity: 0` forever.
            cardEl.dataset.flyAt = String(Date.now());   // swept if it sticks (see renderBoard)
            cardEl.classList.add('card-flying');
            setTimeout(() => {
              cardEl.classList.remove('card-flying');
              if (cardEl.dataset) delete cardEl.dataset.flyAt;
            }, 900);
          } else {
            this._spawnPlayerLandFx(cardEl, el, pSlot, false);
          }
        }
        // Mirror of the AI-side default-onclick — tap your own board card to
        // open the inspect popup; cc / lc branches override during prompts.
        // THE FACE-DOWN GUARD IS REQUIRED HERE TOO: in 2v2 this row is the
        // whole TEAM, so a partner's hidden card sits in it. Only the seat that
        // played it may inspect it; for everyone else the tile is inert until
        // it flips.
        if (!plDisplayCard.isFaceDown || this._2v2MaySeeHidden(plDisplayCard)) {
          cardEl.onclick = () => UI.openCardInspect(plDisplayCard);
        }
        if (cc && targetCardIds.has(plDisplayCard.id)) {
          cardEl.classList.add('target-highlight');
          const idx = cc.cards.findIndex(c => c.id === plDisplayCard.id);
          cardEl.onclick = () => cardChoicePick(idx);
        }
        // Lane-choice click on an occupied PLAYER card — only for real (non-env) cards.
        if (lane.player && lc && lcTargetSide === 'player' && lc.lanes.includes(i)) {
          pSlot.classList.add('target-highlight');
          cardEl.classList.add('target-highlight');
          cardEl.style.cursor = 'pointer';
          cardEl.onclick = () => laneChoicePick(i);
        }
        // Anti-reattach guard — see ai-slot equivalent above.
        if (cardEl.parentNode !== pSlot) pSlot.appendChild(cardEl);
        // Environment placement on an occupied lane — the else-if chain below
        // never fires when plDisplayCard exists, so handle it here.
        if (!lane.destroyed && canPlay && s.selectedCard && s.selectedCard.isEnvironment && !cc && !lc
            && Game.canPlaceEnvironment('player', i)) {
          const _envCost = this._localCardCost(s.selectedCard);
          if (_envCost <= s.player.currency) pSlot.classList.add('playable');
          pSlot.onclick = () => this.onLaneClick(i);
          cardEl.onclick = () => this.onLaneClick(i);
        }
      } else if (lc && lcTargetSide === 'player' && lc.lanes.includes(i)) {
        pSlot.classList.add('target-highlight');
        pSlot.onclick = () => laneChoicePick(i);
        // Summon preview — when summonCardChoice supplies a previewCard
        // (Ant-Man's Ant, Cyborg's Doombot, Hela's zombies, etc.) show
        // makeDamagePreview against the opposing enemy so the player sees the
        // trade math before picking a lane.
        if (lc.previewCard) {
          const preview = this.makeDamagePreview(lc.previewCard, lane.ai, i);
          if (preview) pSlot.appendChild(preview);
        }
      } else if (!lane.destroyed && canPlay && s.selectedCard && !s.selectedCard.isDiscardEffect && !cc && !lc
                 && (s.selectedCard.isEnvironment ? Game.canPlaceEnvironment('player', i) : !lane.player)) {
        // When a forced lane is active (Moder — roguelite solo boss), only that
        // lane is clickable.
        // THE SAME AUTHORITY THE LOCK GLYPH USES (moderCompulsionLane via
        // placeableLanesFor), not the raw `s.player.forcedLane` stamp, which can
        // outlive a Moder who left the board silently.
        const _allowed = Game.placeableLanesFor
          ? Game.placeableLanesFor('player', s.selectedCard)
          : null;
        // Either compeller narrows the board to one lane, and both should light
        // the same way — the Rift is a second reason for the same lockout.
        const _comp = (Game.moderCompulsionLane ? Game.moderCompulsionLane('player') : -1);
        const _riftC = (Game.riftCompulsionLane ? Game.riftCompulsionLane('player') : -1);
        let fl = (_allowed && _allowed.length === 1 && !s.selectedCard.isEnvironment
                  && (_comp === _allowed[0] || _riftC === _allowed[0]))
          ? _allowed[0] : null;
        if (fl !== null && fl !== i && !s.selectedCard.isEnvironment) {
          // Not the forced lane — show as locked, not playable.
          // The class goes on the LANE, not just the slot, so the closed lanes
          // read as clearly as the open one. Safe because the lane's className
          // is rebuilt from scratch earlier in this render (see nextCls).
          el.classList.add('lane-locked');
          const empty = document.createElement('div');
          empty.className = 'empty-lane-glyph lane-glyph-locked';
          empty.title = (_riftC === fl && _comp !== fl)
            ? `The Apothicon Rift pulls your next card into lane ${fl + 1}`
            : `Your next card is forced into lane ${fl + 1}`;
          empty.innerHTML = '&#x1F512;';
          pSlot.appendChild(empty);
        } else {
          // The forced lane itself — mark it so it can be the one lit thing.
          if (fl !== null && fl === i) el.classList.add('lane-forced');
          // Only glow the lane as playable when the card is actually affordable
          // — otherwise the lit lane + preview invite a click that silently
          // fails. The click stays wired so a tap still shakes + explains.
          const _cost = this._localCardCost(s.selectedCard);
          const _afford = _cost <= s.player.currency;
          if (_afford) {
            pSlot.classList.add('playable');
            // Damage preview — show how this card would trade if placed here.
            const preview = s.selectedCard.isEnvironment ? null : this.makeDamagePreview(s.selectedCard, lane.ai, i);
            if (preview) pSlot.appendChild(preview);
          }
          pSlot.onclick = () => this.onLaneClick(i);
        }
      } else if (!lane.destroyed && !lane.player && !cc && !lc) {
        // Empty ally slot + nothing selected — the lane number, as above.
        const empty = document.createElement('div');
        empty.className = 'empty-lane-glyph';
        empty.textContent = String(i + 1);
        pSlot.appendChild(empty);
      }
      // THE LIGHT-CELL IS THE EMPTY SLOT'S RESTING LAYER and must survive every
      // branch above. Those are if/else-if, so a slot gets EITHER the playable
      // branch (damage preview) OR the glyph — append the cell here, once, for
      // any empty slot that still lacks one. insertBefore keeps it first so the
      // preview draws over it, and the querySelector guard means a forced-lane
      // lock (also an .empty-lane-glyph) still suppresses it.
      if (!lane.destroyed && !lane.player && !pSlot.querySelector('.empty-lane-glyph')) {
        const cell = document.createElement('div');
        cell.className = 'empty-lane-glyph';
        cell.textContent = String(i + 1);
        pSlot.insertBefore(cell, pSlot.firstChild);
      }
      if (pSlot.parentNode !== el) el.appendChild(pSlot);
      if (el.parentNode !== this.board) this.board.appendChild(el);
    }
    // Any card present last render but missing now was destroyed, bounced,
    // or stolen — fire a short destroy SFX once per removed id, only when
    // something actually left the board so the cue stays meaningful.
    if (this._lastBoardCardIds && this._lastBoardCardIds.size) {
      let removed = 0;
      for (const id of this._lastBoardCardIds) if (!currentBoardIds.has(id)) removed++;
      if (removed > 0) this.sfx.play('cardDestroy');
    }
    this._lastBoardCardIds = currentBoardIds;
  },

  // THE LANE ELEMENT FOR A LANE INDEX. DOM order does not match lane numbering
  // after the lane count shrinks (8 in 2v2 → 6 in 1v1: surviving lanes are
  // re-appended and stale ones strand at the front). Read the stamp
  // renderBoard writes; fall back to position only if a board predates it.
  laneElAt(laneIdx) {
    if (!this.board || laneIdx == null) return null;
    const stamped = this.board.querySelector(`:scope > .lane[data-lane="${laneIdx}"]`);
    if (stamped) return stamped;
    return this.board.querySelectorAll(':scope > .lane')[laneIdx] || null;
  },
};
