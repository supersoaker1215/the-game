// ============================================================
// ui-hand.js — THE PLAYER'S HAND (split out of ui.js)
// ============================================================
// Rendering the hand (renderPlayerHand, the opponent's card-backs, Batman's
// lock mark), the hand-card read-flip and hover magnify, fitting the hand row
// to the viewport, and the pointer drag-to-play gesture with its ghost.
//
// Same contract as fx.js: loads BEFORE ui.js and only declares UI_HAND;
// ui.js merges it into UI right after the UI literal, before UI.init().
// ============================================================
const UI_HAND = {
  // ===================== HOVER MAGNIFY =====================
  // Readable card pop-up: after ~280ms hovering any card, show a 1.6x clone
  // ANCHORED to that card (right by default, flips left/above/below on
  // overflow) — never cursor-chasing, so it doesn't move while being read.
  // Compositor-cheap (transform + opacity only).
  // Shrink-to-fit for the hand card's flip-over text face.
  //
  // The face is a fixed box (the card is a fixed 194px so the hand row stays
  // even) but descriptions run 0-384 characters, so 8px is the default and
  // only cards that actually overflow step down (to 7px).
  //
  // Cheap by construction: runs on hover for the ONE hovered card, cached on
  // the element. visibility:hidden still participates in layout, so the face
  // measures correctly while edge-on and invisible.
  installHandCardFlip() {
    if (this._handFlipInstalled) return;
    this._handFlipInstalled = true;
    // Bubble phase, not capture: the card's own onclick (select / play / toast)
    // must keep working. The flip is a READING action alongside it — a click
    // still selects the card and lights its lanes and targets.
    // A CLICK ON A CARD MAKES A SOUND, wherever the card is.
    // Delegated, because a card click lands in at least four handlers
    // (openCardInspect, _inspectHandCardEl, showCardInspect, toggleHandCardFlip)
    // across hand, board, codex, draft and deck builder; one listener covers
    // every surface and can't drift out of sync.
    //
    // CAPTURE PHASE, deliberately. 2v2 re-wires the 1v1 renderer's card
    // handlers after render and calls stopPropagation in them, so a
    // bubble-phase listener would go quiet in exactly one mode.
    //
    // It shares the drag guard below: a drag ends by dispatching a click, and
    // that release already has the card's own play cue on it.
    document.addEventListener('click', (e) => {
      if (this._suppressNextHandFlip) return;
      // ...and the stamp, because the flag's 0ms clear races this listener.
      if (this._dragEndedAt && Date.now() - this._dragEndedAt < 300) return;
      const el = e.target && e.target.closest && e.target.closest('.card, .trick-card');
      if (!el) return;
      if (this.sfx && this.sfx.playCardClick) this.sfx.playCardClick();
    }, true);

    document.addEventListener('click', (e) => {
      if (this._suppressNextHandFlip) return;      // the tail of a drag
      // ON TOUCH THE FLIP IS THE WRONG SURFACE. A phone taps a hand/trick card
      // to open the FULL-SCREEN inspect (onCardClick → openCardInspect,
      // onTrickClick → showCardInspect) and taps off to dismiss. The small
      // in-place flip is a DESKTOP affordance (hover-capable pointers); running
      // both on touch flips the card BEHIND its own modal and leaves it
      // face-down afterward. So on `(hover: none)` do nothing here.
      const touch = window.matchMedia && window.matchMedia('(hover: none)').matches;
      const cardEl = e.target.closest && e.target.closest(this.FLIPPABLE_SELECTOR);
      // BIG INSPECT ON CLICK, NOT THE TINY IN-PLACE FLIP: a hand card or trick
      // opens the same full-size modal a board card opens, dismissed by
      // clicking off. A drag never fires this click, so drag-to-play is untouched.
      if (cardEl) { this._inspectHandCardEl(cardEl); return; }
      if (touch) return;   // nothing else to dismiss on touch
      // CLICKED OFF THE CARD — deselect and flip back, so a mis-click never
      // leaves a card face-down with its targets still lit.
      this.dismissHandCardFlip(e);
    });
    // Esc does the same thing, matching every other dismissable surface.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.dismissHandCardFlip(null);
    });
  },

  // Open the FULL-SIZE inspect for a hand card / trick element. A real card
  // resolves to its LIVE instance (current stats, buffs) via openCardInspect; a
  // trick (or anything unresolvable) falls to showCardInspect, which builds
  // the modal by name.
  _inspectHandCardEl(cardEl) {
    if (!cardEl) return;
    const isTrick = !!cardEl.dataset.trickId;
    const id = cardEl.dataset.cardId || cardEl.dataset.trickId;
    const P = (typeof Game !== 'undefined' && Game.state) ? Game.state.player : null;
    if (!isTrick && id != null) {
      const hand = (Game.localHand ? Game.localHand() : (P && P.hand)) || [];
      const inst = hand.find(c => String(c.id) === String(id));
      if (inst && this.openCardInspect) { this.openCardInspect(inst); return; }
    }
    // Tricks + fallback: the name-based dispatcher (opens the trick inspect).
    if (this.showCardInspect) { this.showCardInspect(cardEl); return; }
    this.toggleHandCardFlip(cardEl);
  },

  // Every surface that turns over. `.flip-host` is the general opt-in — any
  // renderer that adds it inherits the whole treatment without its own
  // selector here or CSS copy. The two hand rows keep explicit entries (they
  // predate the class and carry hand-specific styling). Tricks share the same
  // treatment — see the .trick-cards block in style.css.
  // DRAFT IS DELIBERATELY ABSENT: a draft card is chosen BY its text, so
  // hiding it behind a flip would be backwards.
  FLIPPABLE_SELECTOR: '.player-hand-section .hand-cards .card, .trick-cards .trick-card, .flip-host',
  // One source for the hand-guardian (Iron Giant) hint, shared by the
  // select-time toast and the rejected-lane toast so they can't desync.
  HAND_GUARD_HINT: 'Leaves your hand only to save an ally — never takes the field',
  // The element carrying the rules text on each of those (tricks use
  // .trick-desc rather than .card-desc).
  // .card-trick-passive is NOT listed: it's a CHILD of .card-desc, not a peer
  // face. Treated as one, the flip CSS (`position:absolute; inset:0;
  // background:#000`) makes it paint over its siblings and black out the rules.
  // It inherits show/hide from .card-desc.
  FLIP_FACE_SELECTOR: '.card-desc, .trick-desc',

  // Turn any flipped card back over, and drop the selection with it.
  dismissHandCardFlip(e) {
    const flipped = document.querySelector('.face-flipped');
    if (flipped) {
      flipped.classList.remove('face-flipped');
      this._flippedHandCardId = null;
    }
    // Deselect too — the flip and the selection came from the same click.
    // EXCEPT when the click landed on the play target: that click IS the play,
    // and the play can continue asynchronously through a prompt, so the
    // selection must survive. The play only ever lands on the player's OWN slot
    // (pSlot.onclick → onLaneClick / laneChoicePick; .lane has no handler), so
    // that is the only element exempted — a broader selector makes most of the
    // board unable to deselect.
    const onPlayTarget = e && e.target && e.target.closest &&
      e.target.closest('.card-slot.player-slot');
    const s = (typeof Game !== 'undefined') && Game.state;
    // While a prompt is armed the selection belongs to the PROMPT — clearing it
    // would cancel a choice in progress (and enemy-side targeting legitimately
    // clicks an ai-slot). Ask the ENGINE what is armed so a queued arm
    // (_promptQueue) and future prompt kinds count too.
    const promptArmed = (typeof Game !== 'undefined' && Game._anyPromptArmed)
      ? Game._anyPromptArmed()
      : !!(s && (s.pendingCardChoice || s.pendingLaneChoice));
    // EXEMPT BY OUTCOME, NOT BY SELECTOR. A click on your own slot that couldn't
    // accept the card is not a play. The slot handler has already run by the
    // time this document listener fires, so the card still in hand with nothing
    // pending means the click did nothing — and it should deselect.
    const stillInHand = !!(s && s.selectedCard && s.player && s.player.hand &&
                           s.player.hand.indexOf(s.selectedCard) >= 0);
    if (!promptArmed && s && s.selectedCard && (!onPlayTarget || stillInHand)) {
      s.selectedCard = null;
      this.render();
    }
  },

  // Which hand card is turned over to its rules face. One at a time —
  // flipping a second card turns the first back.
  _flippedHandCardId: null,

  // Which hand card is in flight under the cursor/finger; cleared by the
  // pointer-release sweep in _makeCardDragGhost. Like _flippedHandCardId: the
  // render diff strips the class, so the ID is the source of truth and the
  // class is re-derived from it every render.
  _draggingCardId: null,

  // Turn a hand card over (or back). Returns true if the flip state changed.
  //
  // Deliberately NOT wired through the hand renderer's per-card el.onclick:
  // that handler is assigned in branches (playable / unaffordable /
  // Batman-blocked / jump-ready / prompt-pending), several of which replace it.
  // Reading must work in every state (especially the card you can't afford),
  // so this rides a single delegated listener.
  toggleHandCardFlip(cardEl) {
    if (!cardEl) return false;
    // "Always show" mode: the rules already sit on the face, so suppress the
    // read-flip. The card's own select/play onclick still fires.
    if (document.body.classList.contains('hand-text-always')) return false;
    const face = cardEl.querySelector(this.FLIP_FACE_SELECTOR);
    // Nothing to turn over (pure stat-line cards) — flipping would show a
    // blank black panel where the art was.
    if (!face || !(face.textContent || '').trim()) return false;
    const id = cardEl.dataset.cardId || cardEl.dataset.trickId;
    const wasFlipped = cardEl.classList.contains('face-flipped');
    // Any previously flipped surface turns back — matched on the CLASS, not on a
    // hand-scoped selector, so a flipped trick closes when a card opens and
    // vice versa. One thing face-up at a time, across both rows.
    document.querySelectorAll('.face-flipped')
      .forEach(el => el.classList.remove('face-flipped'));
    if (wasFlipped) {
      this._flippedHandCardId = null;
    } else {
      this._fitHandCardFace(cardEl);   // size the text before it comes into view
      cardEl.classList.add('face-flipped');
      this._flippedHandCardId = id;
    }
    return true;
  },

  _fitHandCardFace(cardEl) {
    if (!cardEl || !cardEl.closest('.player-hand-section .hand-cards, .trick-cards')) return;
    const face = cardEl.querySelector(this.FLIP_FACE_SELECTOR);
    if (!face || face.dataset.faceFit) return;
    const STEPS = [8, 7.5, 7, 6.5, 6];
    let fit = STEPS[STEPS.length - 1];
    for (const px of STEPS) {
      face.style.setProperty('font-size', px + 'px', 'important');
      if (face.scrollHeight <= face.clientHeight + 1) { fit = px; break; }
    }
    face.style.setProperty('font-size', fit + 'px', 'important');
    face.dataset.faceFit = String(fit);
  },

  installHoverMagnify() {
    // DISABLED — the card-inspect popup (openCardInspect) replaces the hover
    // magnify (it was also firing a competing audio path on top of the
    // inspect-open hover SFX). The early return keeps the install gate (no
    // double-install).
    if (this._hoverMagnifyInstalled) return;
    this._hoverMagnifyInstalled = true;
    // Hide any stale popup element so a previously-rendered magnify
    // can't linger across a hot-reload.
    const popEl = document.getElementById('hover-magnify');
    if (popEl) { popEl.style.display = 'none'; popEl.innerHTML = ''; }
    const HOVER_MAGNIFY_ENABLED = false;   // flip to true to bring the legacy popup back
    if (!HOVER_MAGNIFY_ENABLED) return;
    // Legacy implementation kept below so hover-magnify can be restored; the
    // early return above keeps it off.
    const pop = document.getElementById('hover-magnify');
    if (!pop) return;
    const HOVER_DELAY = 280;       // ms before magnify reveals
    const ANCHOR_GAP  = 18;        // px between source card and magnified clone
    let timer = null;
    let lastEl = null;
    let fadedEl = null;
    let openEl = null;             // el currently being magnified (for SFX guard)
    // Card-source-anchored placement: right → left → above → below, each only
    // if the previous would overflow. The clone is scaled via CSS transform, so
    // getBoundingClientRect (read AFTER the transform) gives its visual rect.
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
      // Hand cards AND board cards (ally/enemy): NO clone popup — the card
      // itself grows in place on :hover (`.hand-card-wrapper:hover
      // .card.hand-card`, `.card.ally-card:hover, .card.enemy-card:hover`), so
      // there are never two copies on screen and the 3D tilt survives (the
      // .magnifying lock would kill it). Draft/trick cards keep the popup.
      if (el.classList.contains('hand-card') ||
          el.classList.contains('ally-card') ||
          el.classList.contains('enemy-card')) {
        openEl = el;
        return;
      }
      // Clone with the same interior; strip interactive + animation classes
      // (card-enter / selected / status) so the clone stays perfectly still.
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
      // KEEP THE SOURCE VISIBLE. visibility:hidden disables :hover on the
      // source, so the effective hover target slides to whatever's beneath,
      // firing fresh mouseovers (hover audio retriggers, border glow flickers).
      // .magnifying is still applied so the wrapper's hover-lift transforms
      // stay locked.
      if (el.classList.contains('hand-card') || el.classList.contains('trick-card')) {
        const wrap = el.closest && el.closest('.hand-card-wrapper');
        if (wrap) { wrap.classList.add('magnifying'); fadedEl = el; }
        if (el.classList.contains('trick-card')) { el.classList.add('magnifying'); fadedEl = el; }
      }
      // Two-pass position — first frame sizes the clone, second measures and
      // places (rAF avoids reading getBoundingClientRect mid-layout).
      requestAnimationFrame(() => position(el));
    };
    const hide = () => {
      if (fadedEl) {
        // Strip the .magnifying lock from the wrapper (and trick card) so its
        // :hover transforms re-engage on the NEXT hover.
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
      // Size the hand card's text face before it flips into view.
      this._fitHandCardFace(el);
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
      // Also suppress the flicker when the cursor passes onto the popup — it's
      // pointer-events:none but the browser still resolves relatedTarget for it.
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
    // Any click force-hides the popup. Covers hover-then-click-to-play: the
    // card is destroyed by render(), so the next mouseout has
    // e.target.closest(...) === null and the handler above exits early.
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
    // Teardown hook for the main render loop. Only force-closes if the SOURCE
    // card the popup clones has left the DOM — closing unconditionally every
    // render makes the popup blip (280ms HOVER_DELAY to reopen) during AI
    // turns. makeCardElCached keeps card identity across renders, so genuine
    // removals (destroyed, discarded, hand reshuffled) still detach openEl.
    this._hideHoverMagnify = () => {
      // Source still in DOM? Leave the popup; mouseout hides it naturally.
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

  // (AAA) HAND FAN — set --hand-i / --hand-n on each hand-card wrapper for the
  // CSS fan arc. Called after renderHand each tick.
  applyHandFanVars() {
    const wrappers = document.querySelectorAll('.player-hand-section .hand-card-wrapper');
    const n = wrappers.length;
    wrappers.forEach((w, i) => {
      w.style.setProperty('--hand-i', i);
      w.style.setProperty('--hand-n', n);
    });
  },

  // Is this card one the open `fromHand` prompt is offering? Returns its index
  // in the prompt's list, or -1. The inspect view uses it to decide whether to
  // show a PICK button.
  _handPickIndexOf(card) {
    const st = typeof Game !== 'undefined' && Game.state;
    const cc = st && st.pendingCardChoice;
    if (!card || !cc || !cc.fromHand) return -1;
    try { if (!Game.promptIsMine(cc, 'card')) return -1; } catch (e) { return -1; }
    return (cc.cards || []).findIndex(c => c && String(c.id) === String(card.id));
  },

  // A LIT HAND CARD WAS DROPPED ON A LANE. Two questions, one gesture: which
  // card, and where it goes. The pick goes through the normal door
  // (cardChoicePick → resolveActivePrompt, so ownership, replay recording,
  // snapshots and 2v2 seat binding behave exactly as a tap), and since that
  // door runs the callback SYNCHRONOUSLY, a lane prompt it raises is already
  // armed when this returns — so the same drop can answer it.
  //
  // Deliberately narrow: the lane is only offered to a lane prompt that (a)
  // was not there before the pick, (b) is mine, and (c) lists that lane.
  // Otherwise the lane prompt stays on screen to be tapped. An MP GUEST always
  // gets that path — cardChoicePick forwards to the host without arming
  // anything locally.
  _resolveHandDrop(idx, laneIdx) {
    const before = Game.state.pendingLaneChoice;
    try { cardChoicePick(idx); } catch (e) { console.error('[hand-drop]', e); }
    const lc = Game.state.pendingLaneChoice;
    if (lc && lc !== before && Game.promptIsMine(lc, 'lane')
        && (!lc.lanes || lc.lanes.indexOf(laneIdx) !== -1)) {
      try { laneChoicePick(laneIdx); } catch (e) { console.error('[hand-drop-lane]', e); }
    }
    this.render();
  },

  // THE HAND GROWS INTO WHATEVER HEIGHT IS LEFT OVER, between a floor that
  // guarantees a fit and a ceiling.
  // Computed from EVERYTHING EXCEPT the hand row, never the total — sizing off
  // the total oscillates (bigger card → taller row → less slack → smaller card).
  // Width is the lever: a hand card is `aspect-ratio: 92/182`, so width only
  // changes its scale.
  // _pass is internal: `others` derives from the CURRENT row height, so one
  // pass lands close and the second lands exactly; running both here means
  // the player never sees the intermediate size.
  // THE HAND CARD'S REAL WIDTH, published once on the row (phone spec, section
  // 2.1). At phone width the slot is sized by flex, not --hand-card-w, so card
  // chrome must read the real width. One measurement on the row serves every
  // slot and survives re-renders. Can't feed back: the slot is flex: 1 1 0
  // between fixed min/max widths, and nothing --hand-real-w drives changes it.
  _syncHandRealWidth() {
    try {
      const row = document.querySelector('.player-hand-section .hand-cards');
      if (!row) return;
      const slot = row.querySelector('.hand-card-wrapper');
      const w = slot ? Math.round(slot.getBoundingClientRect().width) : 0;
      if (w < 40) return;                       // hidden / pre-layout: keep the old value
      const v = w + 'px';
      if (row.style.getPropertyValue('--hand-real-w') !== v) row.style.setProperty('--hand-real-w', v);
    } catch (e) {}
  },
  _fitHandToViewport(_pass) {
    const area = document.getElementById('game-area');
    const row = document.querySelector('.player-hand-section');
    if (!area || !row) return;
    const rowH = row.getBoundingClientRect().height;
    if (!rowH) return;
    // Row chrome read from the section's own padding, NOT (rowH - cardH): the
    // tricks column shares this grid row, so when tricks are taller that
    // subtraction would charge their height to "chrome".
    const rcs = getComputedStyle(row);
    const rowChrome = (parseFloat(rcs.paddingTop) || 0) + (parseFloat(rcs.paddingBottom) || 0);
    // Everything that is NOT the hand row keeps its height when the hand grows.
    let others = area.scrollHeight - rowH;

    // ...EXCEPT THE BOARD, also sized from leftover height. Coupled, the two
    // chase each other and diverge, so the hand is solved against the board's
    // FLOOR (a constant) and the board takes what's left. Dependency runs one
    // way: hand, then board.
    const bSlot = document.querySelector('.card-slot');
    const bLane = document.querySelector('.lane');
    const bSec = document.querySelector('.board-section');
    if (bSlot && bLane && bSec) {
      const n = (el, ...p) => { const c = getComputedStyle(el);
        return p.reduce((t, k) => t + (parseFloat(c[k]) || 0), 0); };
      // 140 FLAT, deliberately not min(140, --board-card-w): freeing that height
      // in 2v2 let hand cards grow past board cards, inverting the hierarchy.
      // 2v2 board slack belongs in the board's own width solve.
      const floorH = 2 * (140 * 182 / 92 + n(bSlot, 'paddingTop', 'paddingBottom'))
                   + n(bLane, 'paddingTop', 'paddingBottom');
      others = others - bSec.getBoundingClientRect().height + floorH;
    }
    const avail = window.innerHeight - others - rowChrome;
    // 200 is a CEILING, not a target — the measured value wins below it.
    // The FLOOR is usually the binding constraint; 110 still lets a match fit
    // a short window, because the board is solved after the hand against its
    // own floor and absorbs the difference.
    const HAND_MIN = 110;
    let w = Math.max(HAND_MIN, Math.min(200, avail * 92 / 182));

    // It must fit ACROSS too: body clips on x, so an overrun reports nothing
    // and cards are simply cut off. Target: 7 cards + 3 tricks with no
    // horizontal scroll. Gaps, paddings and the tools block are all measured
    // from live layout, so CSS changes can't silently invalidate this.
    const cards = row.querySelectorAll('.hand-card-wrapper').length;
    if (cards) {
      const tricksSec = document.querySelector('.tricks-section');
      const trickEls = document.querySelectorAll('.trick-card');
      const m = trickEls.length;
      const px = (el, ...props) => { const c = getComputedStyle(el);
        return props.reduce((sum, pr) => sum + (parseFloat(c[pr]) || 0), 0); };
      const handGap = parseFloat(getComputedStyle(row.querySelector('.hand-cards') || row).gap) || 0;
      const handPad = px(row, 'paddingLeft', 'paddingRight');
      // Fixed width the tricks column spends on anything that is NOT a trick
      // card: the music/redraw tools, the flex gaps, its own padding.
      let trickFixed = 0, trickGap = 0, trickRatio = 0;
      if (tricksSec && m) {
        const tw0 = trickEls[0].getBoundingClientRect().width || 1;
        trickGap = parseFloat(getComputedStyle(trickEls[0].parentElement).gap) || 0;
        trickFixed = tricksSec.getBoundingClientRect().width
                   - (m * tw0 + (m - 1) * trickGap);
        // A trick card's width is a linear function of the hand card's (both
        // ride the same 0..1 position on their ranges), so its contribution
        // scales with w and has to be part of the solve, not a constant.
        trickRatio = (190 - 88) / (200 - HAND_MIN);
      }
      const fixed = handPad + handGap * (cards - 1)
                  + trickFixed + trickGap * Math.max(0, m - 1)
                  + m * (88 - trickRatio * HAND_MIN);
      const perCard = cards + m * trickRatio;
      // MINUS WHAT SITS TO THE LEFT OF THE ROW: the row starts at grid column 2,
      // after a margin column of max(--board-left, --hand-col-w) — ~500px in
      // 2v2 — so budgeting the whole viewport crops the hand. Read off the
      // row's own left edge (depends on neither card size, so not circular;
      // below 521px the row simply starts at 0).
      const leftSpent = Math.max(0, row.getBoundingClientRect().left);
      const byWidth = (window.innerWidth - leftSpent - fixed - 8) / perCard;   // 8px slack
      w = Math.max(HAND_MIN, Math.min(w, byWidth));
    }
    area.style.setProperty('--hand-card-w', Math.floor(w) + 'px');
    // The phone slot width only settles after this pass lays out — measure it
    // a frame later (rAF + timeout, the same double-signal the passes use).
    { let _d = false; const _go = () => { if (_d) return; _d = true; this._syncHandRealWidth(); };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(_go);
      setTimeout(_go, 60); }
    // Tricks ride the same 0..1 position on that range so the two groups stay
    // in proportion instead of one outgrowing the other.
    // FLOORED, like --hand-card-w and --board-card-w: a fractional
    // --trick-card-w feeds --sb-card and puts the trick row's text and 1px
    // neon borders on sub-pixels (soft). t is taken from the FLOORED hand
    // width so the trick stays exactly proportional to the hand card.
    const wFloor = Math.floor(w);
    const t = (wFloor - HAND_MIN) / (200 - HAND_MIN);
    area.style.setProperty('--trick-card-w', Math.floor(88 + t * (190 - 88)) + 'px');
    // The refinement pass must run AFTER a paint: a custom property set this
    // tick isn't in layout for a same-tick re-measure. rAF + a timeout, like
    // `_fxWhenPainted`: rAF doesn't fire in a hidden tab, the timeout guarantees.
    if (!_pass) {
      let done = false;
      const again = () => { if (done) return; done = true;
        this._fitHandToViewport(1);
        // Board LAST, on the settled hand — twice, like the hand: the first
        // solve changes the board's own height, so `others` is exact only on
        // the re-read.
        if (this._fitBoardToViewport) {
          this._fitBoardToViewport();
          this._fitBoardToViewport();
        }
      };
      requestAnimationFrame(again);
      setTimeout(again, 60);
    }
  },


  // ===================== HANDS =====================

  // ===================== BATMAN'S LOCK WEARS HIS MARK =====================
  // A Batman-locked card must look different from one you simply can't
  // afford (both are `.unplayable`, grey) — an el.title alone needs a hover,
  // so on a phone the rule would be invisible.
  //
  // The mark hangs on the WRAPPER, never inside `.card`. `.card.unplayable`
  // carries `filter: grayscale(.95) brightness(.6)`, and a filter applies to
  // the element AND its descendants — a bat inside the card would be greyed
  // by the very rule it explains. As a sibling it stays gold over grey.
  //
  // Idempotent by contract: called every render, from every branch, with the
  // live answer. Present + still locked = left alone (so its one-shot entrance
  // plays once per lock, not once per frame); absent + locked = built; present
  // + unlocked = removed. Nothing here depends on the cache-hit class strip.
  // TRACED, NOT DRAWN. The path comes from the reference image: threshold ->
  // largest connected component -> Moore boundary walk -> Ramer-Douglas-Peucker
  // at 1.6px -> corner detection at 112 degrees (wingtips, ear tips and tail
  // stay sharp) -> Catmull-Rom to cubics. Verified by rasterised diff (IoU
  // 98.45%; the rest is the antialias fringe). Re-trace rather than hand-edit.
  _BAT_LOCK_VIEWBOX: '0 0 1000 423.6',
  _BAT_LOCK_PATH: 'M 252.2 0 C 245.5 7.9 236.9 15.7 232.3 23.6 C 227.7 31.5 225.3 38.9 224.8 47.2 ' +
    'C 224.4 55.5 226.9 65.4 229.8 73.3 C 232.7 81.2 235.8 86.7 242.2 94.4 ' +
    'C 248.7 102.1 259.2 112.4 268.3 119.3 C 277.4 126.1 283.4 130.4 296.9 135.4 ' +
    'C 310.4 140.4 330.6 145.8 349.1 149.1 C 367.5 152.4 392.3 154.2 407.5 155.3 ' +
    'C 422.6 156.3 434 155.7 439.8 155.3 C 445.5 154.9 439.5 165 442.2 152.8 ' +
    'C 444.9 140.6 453.2 98.3 455.9 82 C 458.6 65.6 457.6 63.8 458.4 54.7 ' +
    'C 465.8 71.2 470.6 96.1 480.7 104.3 C 490.9 112.6 509.1 112.6 519.3 104.3 ' +
    'C 529.4 96.1 534.2 71.2 541.6 54.7 C 544.9 77.8 548.4 107.5 551.6 124.2 ' +
    'C 554.7 141 557.3 144.9 560.2 155.3 C 576.8 154.9 596.1 154.9 609.9 154 ' +
    'C 623.8 153.2 630.4 152.6 643.5 150.3 C 656.5 148 677.2 143.3 688.2 140.4 ' +
    'C 699.2 137.5 702.3 136.2 709.3 132.9 C 716.4 129.6 723 126.1 730.4 120.5 ' +
    'C 737.9 114.9 748.7 104.8 754 99.4 C 759.4 94 759.6 93.4 762.7 88.2 ' +
    'C 765.8 83 770.6 73.5 772.7 68.3 C 774.7 63.1 774.9 62.5 775.2 57.1 ' +
    'C 775.4 51.8 775.4 42 773.9 36 C 772.5 30 771 27.1 766.5 21.1 ' +
    'C 761.9 15.1 753.2 7 746.6 0 C 756.1 2.5 765.2 4.1 775.2 7.5 ' +
    'C 785.1 10.8 793.2 13.5 806.2 19.9 C 819.3 26.3 836 34.6 853.4 46 ' +
    'C 870.8 57.3 895.7 76 910.6 88.2 C 925.5 100.4 932.7 107.7 942.9 119.3 ' +
    'C 953 130.8 963.6 145.5 971.4 157.8 C 979.3 170 985.5 182.4 990.1 192.5 ' +
    'C 994.6 202.7 997.1 211.6 998.8 218.6 C 1000.4 225.7 999.6 229.4 1000 234.8 ' +
    'C 987.2 231.9 976.2 228.4 961.5 226.1 C 946.8 223.8 928.8 221.5 911.8 221.1 ' +
    'C 894.8 220.7 873.7 221.9 859.6 223.6 C 845.5 225.3 837.9 227.1 827.3 231.1 ' +
    'C 816.8 235 804.8 241.4 796.3 247.2 C 787.8 253 781.8 259.2 776.4 265.8 ' +
    'C 771 272.5 766.7 281.4 764 287 C 761.3 292.5 761.1 294.4 760.2 299.4 ' +
    'C 759.4 304.3 759.4 311 759 316.8 C 749.9 311.4 741 304.6 731.7 300.6 ' +
    'C 722.4 296.7 713 294.4 703.1 293.2 C 693.2 291.9 683.2 291.7 672 293.2 ' +
    'C 660.9 294.6 649.3 297.3 636 301.9 C 622.8 306.4 605.6 313.3 592.5 320.5 ' +
    'C 579.5 327.7 568.9 335.2 557.8 345.3 C 546.6 355.5 535.2 368.3 525.5 381.4 ' +
    'C 515.7 394.4 508.1 409.5 499.4 423.6 C 496.9 418.2 496.3 414.9 491.9 407.5 ' +
    'C 487.6 400 482.2 389.9 473.3 378.9 C 464.4 367.9 449.1 351.1 438.5 341.6 ' +
    'C 428 332.1 421.1 328 409.9 321.7 C 398.8 315.5 384.9 309.1 371.4 304.3 ' +
    'C 358 299.6 341.4 295 329.2 293.2 C 317 291.3 308.7 291.7 298.1 293.2 ' +
    'C 287.6 294.6 275.4 298.1 265.8 301.9 C 256.3 305.6 249.3 311 241 315.5 ' +
    'C 241 311.4 241.8 308.1 241 303.1 C 240.2 298.1 238.5 291.5 236 285.7 ' +
    'C 233.5 279.9 229.8 273.5 226.1 268.3 C 222.4 263.1 220.9 260.2 213.7 254.7 ' +
    'C 206.4 249.1 193.4 239.8 182.6 234.8 C 171.8 229.8 160.9 227.1 149.1 224.8 ' +
    'C 137.3 222.6 125.3 221.5 111.8 221.1 C 98.3 220.7 80.5 221.5 68.3 222.4 ' +
    'C 56.1 223.2 49.9 223.8 38.5 226.1 C 27.1 228.4 12.8 232.7 0 236 ' +
    'C 0.8 229 -0.4 224.6 2.5 214.9 C 5.4 205.2 11.2 189.9 17.4 177.6 ' +
    'C 23.6 165.4 29.6 154.9 39.8 141.6 C 49.9 128.4 63.1 112.2 78.3 98.1 ' +
    'C 93.4 84.1 114.1 68.7 130.4 57.1 C 146.8 45.5 162.3 36.2 176.4 28.6 ' +
    'C 190.5 20.9 202.3 15.9 214.9 11.2 C 227.5 6.4 239.8 3.7 252.2 0 Z ',
  _applyBatLock(wrap, el, on) {
    if (el && el.classList) el.classList.toggle('batman-locked', !!on);
    if (!wrap) return;
    let mark = wrap.querySelector(':scope > .bat-lock');
    if (!on) { if (mark) mark.remove(); return; }
    if (mark) return;
    mark = document.createElement('div');
    mark.className = 'bat-lock';
    // Decoration only — the reason is already on the card's title and in the
    // rejection toast a real play attempt fires, so this must not be read out
    // a second time.
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = '<svg viewBox="' + this._BAT_LOCK_VIEWBOX + '" focusable="false" aria-hidden="true">' +
                     '<path d="' + this._BAT_LOCK_PATH + '"/></svg>';
    wrap.appendChild(mark);
  },

  renderPlayerHand(s) {
    // Smart wipe — keep hand-card wrappers + their .card children continuously
    // attached to playerHand so CSS animations (vibe-*, tron-perimeter-card)
    // don't restart and hover state doesn't reset on every render.
    // Hand cards have their OWN cache map, separate from _capturedBoardCardEls:
    // the board's makeCardElCached must NEVER reach for a hand-card DOM node
    // (different subtree → visual collisions).
    if (!this._handWrappers) this._handWrappers = new Map(); // id → wrapper

    // DID A CARD JUST ARRIVE IN THIS HAND? Stamped here rather than in every draw
    // path, because there are many and they share no single door (2v2's round
    // draw skips drawCards). installCardSfx reads the stamp and withholds hover
    // audio for a beat, so a card reflowing under a resting cursor stays silent.
    try {
      const _hnow = ((this._2v2LocalSeatData && this._2v2LocalSeatData()) || s.player || {}).hand || [];
      if (this._lastHandLen != null && _hnow.length > this._lastHandLen) this._handGrewAt = Date.now();
      this._lastHandLen = _hnow.length;
    } catch (e) {}

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
    // One authority — covers cc.owner and 2v2's _2v2ActingPlayer.
    const isMyHandChoice = Game.promptIsMine(cc, 'card');
    // Lane-choice parallel of isMyHandChoice (consumed below at isReqLcCard).
    // Must be defined: `lc && isMyLaneChoice` runs whenever a lane choice is pending.
    const isMyLaneChoice = Game.promptIsMine(lc, 'lane');
    const targetHandIds = new Set();
    // inlineTray prompts present every option as a full card in the floating
    // tray, so the hand-card highlight is redundant — the user picks from the tray.
    if (cc && isMyHandChoice && !cc.inlineTray) cc.cards.forEach(c => { if (c.id !== undefined) targetHandIds.add(c.id); });
    // Guest debug: log when any hand card gets a non-standard onclick (cardChoicePick or jumpCard)
    // Open browser console (F12) and filter for [GUEST HAND] to diagnose instant-placement bugs.
    if (Game.isMultiplayer() && Game.mp && Game.mp.role === 'guest' && (cc || (s.player.hand||[]).some(c => c.jumpReady))) {
      console.log('[GUEST HAND] phase:', s.phase, '| cc:', cc ? (cc.owner + ':' + (cc.cards||[]).map(c=>c.name||'?').join(',')) : 'none', '| lc:', lc ? (lc.owner + ' lanes:' + (lc.lanes||[]).join(',')) : 'none', '| cards:', (s.player.hand||[]).map(c => {
        const incc = cc && isMyHandChoice && targetHandIds.has(c.id);
        const jump = c.jumpReady;
        return c.name + ':' + (incc ? 'CHOICE-PICK' : jump ? 'JUMP' : 'normal');
      }).join(' | '));
    }
    // Track which hand card ids are newly-drawn since the last render — those
    // get the draw-in fly animation.
    this._lastHandIds = this._lastHandIds || new Set();
    const currentIds = new Set(s.player.hand.map(c => c.id));
    const newIds = new Set();
    s.player.hand.forEach(c => { if (!this._lastHandIds.has(c.id)) newIds.add(c.id); });

    // Display copy sorted low→high cost (stable by name on ties). Underlying
    // s.player.hand array is unchanged so game logic / abilities see unsorted order.
    const handDisplay = s.player.hand.slice().sort((a, b) => {
      const ca = this._localCardCost(a);
      const cb = this._localCardCost(b);
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
      // Idempotent class assignment — avoids the className-mutation style
      // recalc that restarts CSS animations even when the class set is identical.
      // Boot-sequence guard: during the trick-draft → first-fight boot, the
      // wrapper's bootCardEnter animation IS the entrance; adding hand-deal-in /
      // card-draw-in on top stacks two competing animations (flicker).
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

      // Hand-card snapshot cache, mirroring the board's makeCardElCached: if the
      // card's visual state hasn't changed, reuse the existing .card element
      // instead of rebuilding via makeCardEl (hand rebuilds dominated render cost).
      const existing = wrap.querySelector(':scope > .card');
      const snap = this._cardVisualSnapshot(card);
      let el;
      if (existing && existing.dataset.snap === snap) {
        // Snapshot match — reuse the existing element. Strip the transient
        // state classes the affordability code below re-applies, or they STACK
        // across renders (afford+unafford+playable+unplayable at once).
        this._DECORATION_CLASSES.forEach(c => existing.classList.remove(c));
        existing.classList.remove(
          'afford', 'unafford', 'playable', 'unplayable',
          // table-waiting is decided fresh every render like the four above;
          // off this list it would stick to the hand for the rest of the match.
          'table-waiting',
          // ballyhoo-locked is decided fresh every render too; off this list the
          // greyed chrome and title would outlive the lock lifting.
          'ballyhoo-locked',
          'card-draw-in', 'card-enter', 'card-exit',
          'hit-flash', 'armor-burst', 'stat-changed', 'cant-afford'
        );
        existing.style.cursor = '';
        el = existing;
      } else {
        // Build fresh and transplant into the existing wrapper child
        // (or use fresh directly if no existing).
        const fresh = this.makeCardEl(card, true);
        if (existing) {
          // Keep the composited art node alive when the URL is unchanged — hand
          // snapshots bust on cost/energy/affordability changes, so hand-card
          // art flickers on those renders too without this guard.
          this._preserveCardArt(existing, fresh);
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
      // Reset the click handler. el.onclick (not addEventListener) so this
      // REPLACES any prior handler — stacked listeners would compound a play
      // across renders. Nulled up front so stale handlers from previous renders
      // don't fire after affordability changed.
      el.onclick = null;

      // Re-apply the turned-over state from UI._flippedHandCardId. Required:
      // 'face-flipped' is in _DECORATION_CLASSES, so the cached path strips it
      // every render and the card would snap back to its art mid-read.
      if (this._flippedHandCardId != null &&
          String(card.id) === String(this._flippedHandCardId)) {
        el.classList.add('face-flipped');
      }

      // Same for the in-flight drag: starting a drag sets selectedCard, which
      // renders immediately, so without this the source card re-lights while
      // the ghost is out of the hand.
      if (this._draggingCardId != null &&
          String(card.id) === String(this._draggingCardId)) {
        el.classList.add('card-being-dragged');
      }

      // reqLaneChoice flow: guest card is pending lane placement — lc.previewCard
      // IS this card. Show it as selected so the user sees their pick registered,
      // even though hasPending blocks the normal !hasPending branch below.
      const isReqLcCard = lc && isMyLaneChoice && lc.previewCard && lc.previewCard.id === card.id;
      if (isReqLcCard) el.classList.add('is-selected', 'selected');

      // HOISTED OUT OF THE PLAYABILITY BRANCH ON PURPOSE. The lock is a fact
      // about the card, not about which branch this render took — inside
      // `!hasPending` it would vanish whenever any prompt opened.
      const batBlocked = Game.isCardBatmanBlocked('player', card) && !card.isDiscardEffect;

      if (cc && isMyHandChoice && targetHandIds.has(card.id)) {
        el.classList.add('target-highlight');
        const idx = cc.cards.findIndex(c => c.id === card.id);
        // onclick assignment (not addEventListener) so reused .card elements
        // don't accumulate stacked listeners across renders.
        // A `fromHand` prompt OPENS the card rather than committing it: a tap is
        // a READ everywhere else in the game, so the commit is the Pick button
        // inside the inspect view.
        el.onclick = cc.fromHand
          ? () => { try { this.openCardInspect(card); } catch (e) { cardChoicePick(idx); } }
          : () => cardChoicePick(idx);
      } else if (!hasPending) {
        const cost = this._localCardCost(card);
        const afford = s.player.currency >= cost;
        const hasOpen = Game.getOpenLanes('player').length > 0 || card.isDiscardEffect || card.isEnvironment;
        // Per-card phase check — otherwise every hand card looks playable when
        // only one trickPhasePlayable card (e.g. Thanos) is. Mirrors onCardClick.
        const phaseAllowsThisCard = this.canPlayThisCardNow(s, card);

        // Always-on affordability indicator — shows whether the card can be
        // cast right now regardless of whether we're in a playable phase.
        if (afford && hasOpen && !batBlocked && !card._neverPlayable) el.classList.add('afford');
        else el.classList.add('unafford');

        // HAND GUARDIAN (Iron Giant) can never be placed, so he must never wear
        // the playable light or carry a select handler.
        // No title and no tap toast: the reason belongs on a genuine play
        // ATTEMPT, not on a read. The delegated flip listener still turns the
        // card over independently of el.onclick.
        // `title` is a property, not in the rebuilt class list, so it must be
        // cleared explicitly when the reason no longer applies.
        let _ballyTitled = false;
        if (el.title === 'MC Ballyhoo is handing out candy — hold on.') el.title = '';
        if (card._neverPlayable) {
          el.classList.add('unplayable', 'hand-guard');
        } else if (Game.ballyhooLocked && Game.ballyhooLocked()) {
          // MC BALLYHOO HAS THE ROOM. The engine refuses every play during his
          // entrance, so the hand must not glow playable or the click looks broken.
          // Titled like the Batman lock (the other transient "not right now"
          // state), so the reason is one hover away.
          el.classList.add('unplayable', 'ballyhoo-locked');
          el.title = 'MC Ballyhoo is handing out candy — hold on.';
          _ballyTitled = true;
        } else if (batBlocked) {
          el.classList.add('unplayable');
          el.title = 'Blocked by Batman — card is locked this turn.';
          // NO TOAST ON TAP — a tap is a READ (it flips the card) on touch and
          // mouse alike, so a toast here would scold every read. The card stays
          // greyed, `title` explains on hover, and a real play attempt still gets
          // a rejection toast.
        } else if (card.jumpReady && hasOpen) {
          el.classList.add('jump-ready');
          el.onclick = () => Game.submitCommand({ type: 'playJump', payload: { card } });
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
          // NO HOVER TOOLTIP AND NO TAP TOAST for an unplayable card.
          // el.title draws an unstyleable OS tooltip, and tapping turns the card
          // over to read it, so a toast would fire on every read. The card is
          // greyed, its cost orb states the price, and real rejection feedback
          // still fires when a play is ATTEMPTED by drag or lane click.
        }
      } else {
        // A prompt is pending — cards can't be clicked, but the
        // affordability indicator must STAY live so the hand keeps
        // reading truthfully (the "always-on" contract above).
        el.classList.add('unplayable');
        // WAITING ON SOMEBODY ELSE IS NOT THE SAME AS UNPLAYABLE.
        // `hasPending` is "is ANY prompt open", not "is it mine". In 2v2 the
        // engine QUEUES an action taken in that window and replays it, so the
        // card would play despite looking unplayable. Cards stay non-interactive,
        // but a distinct class says the table is waiting, not that they're broken.
        const _mine = Game.promptIsMine
          ? (Game.promptIsMine(cc, 'card') && Game.promptIsMine(lc, 'lane'))
          : true;
        if (!_mine) el.classList.add('table-waiting');
        const pCost = this._localCardCost(card);
        if (this._localEnergy() >= pCost) el.classList.add('afford');
        else el.classList.add('unafford');
      }
      // Anti-reattach guards: only call appendChild if the child
      // isn't already in the right parent. Re-appending an
      // already-attached child triggers detach-reattach which
      // resets CSS animation timing.
      if (el.parentNode !== wrap) wrap.appendChild(el);
      if (wrap.parentNode !== this.playerHand) this.playerHand.appendChild(wrap);
      // AFTER the attach guards: `wrap.appendChild(el)` on a first build would
      // otherwise move the card to the end of the wrapper, i.e. on top of a
      // mark stamped a moment earlier.
      this._applyBatLock(wrap, el, batBlocked);
    });

    // Sweep wrappers for cards no longer in hand (played, discarded).
    for (const [id, wrap] of this._handWrappers) {
      if (!usedIds.has(id)) {
        if (wrap.parentNode) wrap.remove();
        this._handWrappers.delete(id);
      }
    }

    // Reorder children to match handDisplay sort order — only when the current
    // sequence differs, since appendChild detaches + reattaches (resets animations).
    const desiredOrder = handDisplay.map(c => this._handWrappers.get(String(c.id)));
    const currentChildren = Array.from(this.playerHand.children).filter(
      c => c.classList && c.classList.contains('hand-card-wrapper')
    );
    const orderMatches = desiredOrder.length === currentChildren.length &&
      desiredOrder.every((w, i) => w === currentChildren[i]);
    if (!orderMatches) {
      // Sort in place via appendChild (moves an attached child to the end).
      // Each move resets that wrapper's animation — acceptable because this only
      // runs when the sort actually changed.
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

    // Regression guardrail for class stacking: a hand card with both `afford`
    // and `unafford` (or `playable`/`unplayable`) means the cache-hit path
    // reused an element without stripping prior state classes.
    // Gated on PerfOverlay (?perf=1) or debug mode — production pays nothing.
    // console.warn lists the offending ids + colliding pairs.
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
    // Opponent hand — mini card-backs matching the in-game face-down card.
    // No shared SVG id (one `#cb-mini` made trick backs paint the card lattice);
    // the lattice is CSS on .ai-hand-mini .card-back instead.
    const cardBackSVG = '';
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

  installMobileCardDrag() {
    if (this._cardDragInstalled) return;
    this._cardDragInstalled = true;
    let d = null;

    const cardFromEl = (el) => {
      const cardEl = el && el.closest && el.closest('.player-hand-section .card[data-card-id]');
      if (!cardEl) return null;
      const id = parseInt(cardEl.getAttribute('data-card-id'), 10);
      const s = Game.state;
      // 2v2 online restores s.player after the board renders, so read the
      // local seat's live hand instead. Falls back to s.player for 1v1/solo.
      const seat2v2 = UI._2v2LocalSeatData && UI._2v2LocalSeatData();
      const hand = seat2v2 ? seat2v2.hand : (s && s.player && s.player.hand);
      const card = hand && hand.find(c => c.id === id);
      // Hand guardians (Iron Giant) are not draggable. Refusing HERE covers
      // both installers (touchstart and mousedown share this closure), so the
      // card never lifts.
      if (card && card._neverPlayable) return null;
      if (!card) return null;
      // A PROMPT IS WAITING ON THE HAND:
      //   • An option of a `handDrop` prompt IS draggable, and the drop answers
      //     the decision instead of playing the card (see endAt).
      //   • Anything else is not draggable at all — lane click handlers aren't
      //     installed while a prompt is open, so a drag must not play through it.
      // Asked HERE because touchstart and mousedown share this closure.
      const _cc = s && s.pendingCardChoice;
      if (_cc && Game.promptIsMine(_cc, 'card')) {
        if (!_cc.handDrop) return null;
        const pickIdx = UI._handPickIndexOf(card);
        if (pickIdx < 0) return null;
        return { card, cardEl, pickIdx };
      }
      return { card, cardEl, pickIdx: null };
    };
    const laneEls = () => [...document.querySelectorAll('.board > .lane')];
    const laneIdxUnder = (x, y) => {
      // Probe the finger first, then progressively further UP. The ghost is
      // drawn above the fingertip (translate -62% Y), so players line the CARD
      // up with the lane while the finger sits below — on a tablet a finger-only
      // hit-test lands on the hand row. The drop reads "where the card looks".
      let lane = null;
      for (const dy of [0, -40, -80, -120]) {
        const el = document.elementFromPoint(x, y + dy);
        lane = el && el.closest && el.closest('.board .lane');
        if (lane) break;
      }
      if (!lane) return null;
      // The lane's OWN index, not its position among siblings — see the stamp
      // in renderBoard. Position is only a fallback to keep the helper total.
      const stamped = lane.dataset ? parseInt(lane.dataset.lane, 10) : NaN;
      if (Number.isFinite(stamped)) return stamped;
      const i = laneEls().indexOf(lane);
      return i >= 0 ? i : null;
    };
    let hiLane = null;
    const clearHi = () => { hiLane = null; document.querySelectorAll('.lane.drag-over').forEach(l => l.classList.remove('drag-over')); };

    // ONE FRAME OF DRAG, shared by touch and mouse. Move handlers only record
    // the latest point (a digitiser delivers 2+ events per frame); this runs
    // once per display frame:
    //   • position rides transform (see _positionDragGhost) → compositor only
    //   • the lane highlight is touched only when the lane under it CHANGES
    //   • the tilt eases toward a per-FRAME velocity instead of jumping with
    //     each raw event, and keeps easing back to level while the finger rests
    const dragFrame = () => {
      if (!d) return;
      d.raf = 0;
      if (d.px == null) return;
      if (d.ghost) {
        const vx = d.px - (d.fx != null ? d.fx : d.px);
        d.fx = d.px;
        const target = Math.max(-12, Math.min(12, vx * 0.45));
        d.tilt = (d.tilt || 0) + (target - (d.tilt || 0)) * 0.35;
        if (Math.abs(d.tilt) < 0.05 && target === 0) d.tilt = 0;
        this._positionDragGhost(d.ghost, d.px, d.py, d.tilt);
        // Still leaning → one more frame to settle, even with the finger still.
        if (d.tilt !== 0) d.raf = requestAnimationFrame(dragFrame);
      }
      if (d.card && (d.px !== d.hx || d.py !== d.hy)) {
        d.hx = d.px; d.hy = d.py;
        const i = laneIdxUnder(d.px, d.py);
        if (i !== hiLane) {
          clearHi();
          hiLane = i;
          if (i != null) { const l = UI.laneElAt(i); if (l) l.classList.add('drag-over'); }
        }
      }
    };
    const queueDragMove = (x, y) => {
      if (!d) return;
      d.px = x; d.py = y;
      if (!d.raf) d.raf = requestAnimationFrame(dragFrame);
    };
    // A release must judge the card where it IS, so a frame still pending is
    // applied before the drop reads the ghost's box.
    // BUILD THE GHOST BEFORE IT IS NEEDED. Cloning + layout cost ~1.5ms, and
    // the lift needs 8-10px of travel, so the clone is built off-screen in the
    // frame after the press; the lift only places it. A tap throws it away.
    const prepGhostSoon = () => {
      const mine = d;
      requestAnimationFrame(() => {
        if (d !== mine || !d || d.moved || d.prep) return;
        d.prep = this._prepCardDragGhost(d.cardEl);
      });
    };
    const dropPrep = (st) => { if (st && st.prep && st.prep !== st.ghost) st.prep.remove(); };
    const flushDragFrame = () => {
      if (!d) return;
      if (d.raf) { cancelAnimationFrame(d.raf); d.raf = 0; }
      if (d.ghost && d.px != null) this._positionDragGhost(d.ghost, d.px, d.py, d.tilt || 0);
    };

    // The top edge of the hand area (cards + trick tray). A release ABOVE this
    // line is an unambiguous "play" gesture — anywhere over the board or the
    // health bar counts — and only a release back DOWN into the hand cancels.
    // Zero-height (hidden) elements are skipped so a collapsed row can't drag
    // the boundary to y=0 and make everything read as "over the hand".
    const handTopBoundary = () => {
      let top = Infinity;
      const consider = (el) => {
        if (!el || !el.getBoundingClientRect) return;
        const r = el.getBoundingClientRect();
        if (r.height > 0) top = Math.min(top, r.top);
      };
      consider(document.querySelector('.player-hand-section'));
      consider(this.playerTricks);
      consider(this.playerHand);
      return top;
    };
    const aboveHand = (y) => y != null && y < handTopBoundary() - 8;

    // Nearest lane to an x coordinate — prefers a lane THIS card can actually
    // enter (open, not destroyed; any non-destroyed lane for an environment),
    // and only falls back to the closest lane overall so a genuinely blocked
    // drop still lands somewhere and explains itself through onLaneClick's
    // reject flash. A release above the hand need not be pixel-aligned over a
    // lane column.
    const nearestLaneByX = (x, card) => {
      const els = laneEls();
      if (!els.length || x == null) return null;
      const open = [], all = [];
      // In 2v2 the local seat may play on the 'ai' slot (team B), so test the
      // real side rather than assuming 'player'.
      const side = (UI._2v2LocalSide && UI._2v2LocalSide()) || 'player';
      els.forEach((el, pos) => {
        // Same rule as laneIdxUnder: identity comes from the stamp, never from
        // the element's position in the list.
        const stamped = el.dataset ? parseInt(el.dataset.lane, 10) : NaN;
        const idx = Number.isFinite(stamped) ? stamped : pos;
        const r = el.getBoundingClientRect();
        const dist = Math.abs(x - (r.left + r.width / 2));
        all.push({ idx, dist });
        const L = Game.state.lanes[idx];
        const ok = L && !L.destroyed && (card && card.isEnvironment ? true : !L[side]);
        if (ok) open.push({ idx, dist });
      });
      const pool = open.length ? open : all;
      pool.sort((a, b) => a.dist - b.dist);
      return pool[0].idx;
    };

    // Trick-tray version of cardFromEl — resolves a .trick-card element back
    // to its live trick object via data-trick-id (set in renderPlayerTricks).
    const trickFromEl = (el) => {
      const tEl = el && el.closest && el.closest('.trick-card[data-trick-id]');
      if (!tEl) return null;
      const id = parseInt(tEl.getAttribute('data-trick-id'), 10);
      const s = Game.state;
      const seat2v2 = UI._2v2LocalSeatData && UI._2v2LocalSeatData();
      const trickList = seat2v2 ? (seat2v2.trickHand || []) : (s && s.player && (s.player.trickHand || []));
      const trick = trickList && trickList.find(tk => tk.id === id);
      return trick ? { trick, cardEl: tEl } : null;
    };

    document.addEventListener('touchstart', (e) => {
      if (d || e.touches.length !== 1) return;
      const s = Game.state;
      if (!s) return;
      // MP guests drag exactly like the host — selection is purely local and
      // onLaneClick → playCard forwards {t:'playCard', cardId, lane} to the host.
      // Character card — needs the card phase.
      let hit = null, trickHit = null;
      if (this.canPlayerPlayCards && this.canPlayerPlayCards(s)) {
        hit = cardFromEl(e.target);
        // Discard cards CAN be dragged: they need no lane — endAt plays them
        // wherever released over the board. Tapping still plays them.
      }
      // Trick — tricks drag-to-play exactly like cards. Allowed during the
      // tricks phase, or any player phase for `anytime` tricks — same gate
      // onTrickClick's desktop path uses.
      if (!hit) {
        const playerActive = s.phase && s.phase.startsWith('player-') && !s.gameOver;
        const th = trickFromEl(e.target);
        if (th && (this.canPlayerPlayTricks(s) || (th.trick.anytime && playerActive))) trickHit = th;
      }
      if (!hit && !trickHit) return;
      const t = e.touches[0];
      d = { card: hit ? hit.card : null, trick: trickHit ? trickHit.trick : null,
            pickIdx: hit ? hit.pickIdx : null,
            cardEl: (hit || trickHit).cardEl, x0: t.clientX, y0: t.clientY, moved: false, ghost: null };
      prepGhostSoon();
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!d) return;
      const t = e.touches[0];
      const dx = t.clientX - d.x0, dy = t.clientY - d.y0;
      if (!d.moved) {
        // Engage as soon as the finger LIFTS the card (>10px upward),
        // whatever the horizontal component. Don't require a mostly-vertical
        // gesture: on an iPad the lanes fan out wide, so drags to outer lanes
        // are steeply diagonal, and tablets have no tap-to-place fallback.
        // Native hand-scrolling still works: a sideways swipe never lifts the
        // card upward, so it falls through to the abandon branch below.
        const liftedUp = dy < -10;
        if (!liftedUp) {
          if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) d = null;
          return;
        }
        d.moved = true;
        // THE DRAG SOUNDS LIKE THE TAP. Fired when the drag is RECOGNISED, not
        // on pointerdown — a tap gets its cue from the click, so either gesture
        // makes exactly one sound. The trailing synthesised click is suppressed
        // by the _dragEndedAt stamp, so this cannot double with it.
        if (this.sfx && this.sfx.playCardClick) this.sfx.playCardClick();
        // Ghost FIRST, then select, then render — the order is load-bearing.
        // The ghost is cloned from the live hand element, and the render below
        // rebuilds the hand, so cloning second would clone a detached node.
        // It also sets _draggingCardId, from which the hand renderer re-applies
        // 'card-being-dragged', so the card stays dimmed across the render.
        d.ghost = this._makeCardDragGhost(d.cardEl, t.clientX, t.clientY, d.prep);
        document.body.classList.add('mobile-card-dragging');
        // Tricks play on any drop ABOVE the tray; this class lights the banner
        // as a target for the length of the drag so the drop zone is visible.
        if (d.trick) document.body.classList.add('dragging-trick');
        // Render too, not just select: the combat previews are built in
        // renderBoard from state.selectedCard.
        if (d.card) { Game.state.selectedCard = d.card; this.render(); }
        try { if (this._haptic) this._haptic('cardPlay'); } catch (_) {}
      }
      e.preventDefault();
      // Velocity tilt + position + lane highlight all happen once per frame in
      // dragFrame (the highlight is a CARD thing — tricks are lane-less).
      queueDragMove(t.clientX, t.clientY);
    }, { passive: false });

    // Drop resolution, shared by touch and mouse. Takes plain coordinates so
    // the two input paths differ only in how they read the pointer position;
    // everything downstream (lane hit-test, trick tray, cancel) is identical.
    const endAt = (px, py) => {
      if (!d) return;
      flushDragFrame();
      const wasDrag = d.moved, card = d.card, trick = d.trick, ghost = d.ghost, pickIdx = d.pickIdx;
      // JUDGE THE DROP BY WHERE THE CARD IS, NOT WHERE THE FINGER IS.
      // The ghost is placed at `top = y - h * 0.62`, so its CENTRE sits about
      // an eighth of a card above the finger and its bottom edge below it.
      //   • hit point  = the ghost's centre — where the card looks like it is,
      //     which is what the player is actually aiming with.
      //   • clear point = whichever of the finger and that centre is HIGHER, so
      //     this test can only be more forgiving than the raw pointer, never
      //     stricter (the ghost's bottom edge would demand a taller lift).
      // Both fall back to the pointer when there is no ghost.
      let hitX = px, hitY = py, clearY = py;
      if (ghost && ghost.getBoundingClientRect) {
        const gr = ghost.getBoundingClientRect();
        if (gr.width > 0 || gr.height > 0) {
          hitX = gr.left + gr.width / 2;
          hitY = gr.top + gr.height / 2;
          clearY = (py == null) ? hitY : Math.min(py, hitY);
        }
      }
      const t = (hitX == null || hitY == null) ? null : { clientX: hitX, clientY: hitY };
      // IS THE CARD ITSELF OVER THE BOARD? A release where the card visibly
      // overlaps the lanes is a play, whatever the finger is doing below it —
      // on a short lift the finger is still in the hand row.
      let overBoard = false;
      if (ghost && this.board && this.board.getBoundingClientRect) {
        const gr = ghost.getBoundingClientRect();
        const br = this.board.getBoundingClientRect();
        overBoard = gr.bottom > br.top && gr.top < br.bottom
                 && gr.right > br.left && gr.left < br.right;
      }
      const releasedClear = ((clearY != null) && aboveHand(clearY)) || overBoard;
      if (ghost) ghost.remove();
      dropPrep(d);
      clearHi();
      document.body.classList.remove('mobile-card-dragging');
      document.body.classList.remove('dragging-trick');
      d = null;
      if (!wasDrag) return;   // it was a tap → the element's own onclick inspects
      if (card && card.isDiscardEffect) {
        // Lane-less, like a trick: released anywhere ABOVE the hand it fires,
        // released back into the hand it cancels. A discard effect never
        // occupies a lane — the engine takes lane 0 as a placeholder, as the tap
        // path passes. The hand boundary (not the board rect) is used so a
        // release on the health bar fires too, matching tricks.
        if (t && releasedClear) Game.submitCommand({ type: 'playCard', payload: { card, lane: 0 } });
        Game.state.selectedCard = null;
        this.render();
      } else if (card && pickIdx != null) {
        // THE DRAG ANSWERS THE DECISION. A `handDrop` prompt's options are hand
        // cards and a free play needs a lane, so the lane it lands on answers
        // the lane question. Same hit-test and snap as a normal play.
        let i = t ? laneIdxUnder(t.clientX, t.clientY) : null;
        if (i == null && t && releasedClear) i = nearestLaneByX(t.clientX, card);
        // Dropped back into the hand — a change of heart, not an answer. The
        // decision stays open so the notice and the lit cards are still there.
        Game.state.selectedCard = null;
        if (i == null) { this.render(); return; }
        this._resolveHandDrop(pickIdx, i, card);
      } else if (card) {
        let i = t ? laneIdxUnder(t.clientX, t.clientY) : null;
        // Forgiving drop: the finger/cursor came down clear of the hand (over
        // the board or the bar) but not squarely on a lane column — between
        // lanes, or a hair above the board. Snap to the nearest playable lane
        // instead of bouncing the card back to hand.
        if (i == null && t && releasedClear) i = nearestLaneByX(t.clientX, card);
        if (i != null && Game.state.selectedCard === card) {
          // A DROPPED CARD LANDS WHERE IT WAS DROPPED — the ghost is already
          // over the lane, so no hand→lane flight. Read by renderBoard (land in
          // place) and _applyMotionEffects (no flight).
          UI._markDragDropped(card.id);
          this.onLaneClick(i);
        } else if (Game.state.selectedCard === card) {
          Game.state.selectedCard = null; this.render();   // dropped into hand → cancel
        }
      } else if (trick) {
        // Tricks are lane-less: releasing anywhere ABOVE the hand plays it;
        // releasing back down into the hand/tray cancels. Same clearance rule
        // as cards.
        if (t && releasedClear) {
          const cost = UI._localTrickCost(trick);
          if (UI._localEnergy() >= cost) {
            Game.state.selectedTrick = null;
            Game.submitCommand({ type: 'playTrick', payload: { trick } });
          } else {
            this.flashUnaffordable(cost, null);
          }
        }
        this.render();
      }
    };
    const end = (e) => {
      const t = e.changedTouches && e.changedTouches[0];
      endAt(t ? t.clientX : null, t ? t.clientY : null);
    };
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('touchcancel', (e) => {
      if (!d) return;
      if (d.raf) cancelAnimationFrame(d.raf);
      if (d.ghost) d.ghost.remove();
      dropPrep(d);
      clearHi();
      document.body.classList.remove('mobile-card-dragging');
      document.body.classList.remove('dragging-trick');
      d = null;
    }, { passive: true });

    // ---- MOUSE DRAG (desktop) -------------------------------------------
    // Same gesture as touch, reusing the SAME ghost, lane hit-test, highlight
    // and drop resolution — only the coordinate source differs.
    //
    // CLICK STILL WORKS, by explicit choice: a drag only engages after the
    // pointer travels DRAG_PX with the button down. Under that, nothing is
    // consumed and the element's own click handler runs, so select-then-click-
    // a-lane is untouched.
    //
    // Bound to mousedown (not pointerdown) so it cannot double-fire alongside
    // the touch path on a hybrid device, and gated on a real fine pointer so
    // the synthetic mouse events phones emit after a tap are ignored.
    const DRAG_PX = 8;
    document.addEventListener('mousedown', (e) => {
      if (d || e.button !== 0) return;
      if (!this._hasFinePointer || !this._hasFinePointer()) return;
      const s = Game.state;
      if (!s) return;
      let hit = null, trickHit = null;
      if (this.canPlayerPlayCards && this.canPlayerPlayCards(s)) {
        hit = cardFromEl(e.target);
        // Discard cards CAN be dragged (see the touch path).
      }
      if (!hit) trickHit = trickFromEl(e.target);
      if (!hit && !trickHit) return;
      d = { card: hit && hit.card, trick: trickHit && trickHit.trick,
            pickIdx: hit ? hit.pickIdx : null,
            cardEl: (hit || trickHit).cardEl, x0: e.clientX, y0: e.clientY,
            moved: false, ghost: null };
      prepGhostSoon();
    });

    document.addEventListener('mousemove', (e) => {
      if (!d || !d.cardEl) return;
      const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < DRAG_PX) return;   // still a click, not a drag
        d.moved = true;
        // Same cue as the touch path above — mouse and touch are deliberately
        // separate drag implementations, so the sound has to be fired in both.
        if (this.sfx && this.sfx.playCardClick) this.sfx.playCardClick();
        // Same ordering as the touch path above, for the same reasons: clone
        // the ghost off the live element before the render replaces it, then
        // select and render so the lane previews actually get built.
        d.ghost = this._makeCardDragGhost(d.cardEl, e.clientX, e.clientY, d.prep);
        document.body.classList.add('mobile-card-dragging');
        // Lights the trick banner as a drop target (see the touch path).
        if (d.trick) document.body.classList.add('dragging-trick');
        if (d.card) { Game.state.selectedCard = d.card; this.render(); }
      }
      // THE BUTTON CAME UP SOMEWHERE WE NEVER HEARD ABOUT. The drag is torn
      // down only by a mouseup reaching `document`; releasing over browser
      // chrome, an alt-tab/focus steal, or a native dragend never deliver one,
      // leaving the ghost glued to the cursor. e.buttons is authoritative on
      // every move, so this one check covers all those exits.
      // endAt(null, null) is deliberately the CANCEL form: no coordinates, no
      // lane, no trick — a lost drag tidies itself away.
      if (e.buttons === 0) { endAt(null, null); return; }
      e.preventDefault();   // stop the drag turning into a text selection
      queueDragMove(e.clientX, e.clientY);
    });

    document.addEventListener('mouseup', (e) => {
      if (!d) return;
      // A drag that never passed the threshold must fall through to the click
      // handler untouched, so only swallow the event when we actually dragged.
      const wasDrag = d.moved;
      endAt(e.clientX, e.clientY);
      if (wasDrag) {
        e.preventDefault(); e.stopPropagation();
        // Tell the flip handler to ignore the click this drag is about to
        // synthesise. The browser fires a click on the common ancestor of the
        // mousedown and mouseup targets, so a drag starting and ending on the
        // same card would otherwise flip it.
        UI._suppressNextHandFlip = true;
        setTimeout(() => { UI._suppressNextHandFlip = false; }, 0);
        // A TIMESTAMP AS WELL AS THE FLAG. The flag is cleared on a 0ms
        // timeout, which races the synthesised click (the card-click cue loses
        // and plays a sound on release). A stamp cannot be raced.
        UI._dragEndedAt = Date.now();
      }
    }, true);
  },
  // Floating clone of the dragged card that tracks the finger.
  // THE ONE PLACE A DRAG GHOST IS POSITIONED.
  // left/top are written ONCE, at the lift point, with setProperty(...,
  // 'important') — real layout properties no transform rule can move. Every
  // later frame moves the card with a translate in the inline !important
  // transform, so the compositor slides a painted layer instead of re-layout
  // + repainting the drop-shadow filter. Size is measured once (reading
  // offsetWidth per move forced layout). Centring offsets are real pixels off
  // the measured box. If the transform were ever lost, the card would rest
  // where it was LIFTED, never at 0,0.
  _positionDragGhost(g, x, y, tilt) {
    if (!g) return;
    if (!g._dragW) { g._dragW = g.offsetWidth || 0; g._dragH = g.offsetHeight || 0; }
    const w = g._dragW, h = g._dragH;
    if (g._dragAx == null) {
      g._dragAx = x - w / 2; g._dragAy = y - h * 0.62;
      g.style.setProperty('left', g._dragAx + 'px', 'important');
      g.style.setProperty('top',  g._dragAy + 'px', 'important');
    }
    const tx = (x - w / 2) - g._dragAx, ty = (y - h * 0.62) - g._dragAy;
    // transform-origin MUST be the centre here. The .card-drag-ghost rule sets
    // `transform-origin: 0 0`, under which scale and tilt push the painted box
    // away from the pointer (16px at a 9° tilt). Centre origin makes the
    // transform purely cosmetic.
    g.style.setProperty('transform-origin', '50% 50%', 'important');
    g.style.setProperty('transform', `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) rotate(${(tilt || 0).toFixed(2)}deg) scale(1.06)`, 'important');
  },
  // The clone, off-screen and laid out, with nothing else changed — safe to
  // build on a press that turns out to be a tap. _makeCardDragGhost adopts it
  // on the lift (or builds one itself if the lift beat the prep frame).
  _prepCardDragGhost(cardEl) {
    const g = cardEl.cloneNode(true);
    g.removeAttribute('data-card-id');
    g.classList.add('card-drag-ghost');
    // A CLONE KEEPS EVERY CLASS, AND EVERY CLASS IS A CSS HANDLE. An inline
    // style LOSES to any `!important` the element still matches — e.g. under
    // prefers-reduced-motion,
    //   .card.hand-card.selected { transform: translateY(-16px) scale(1.04) !important }
    // would veto the inline transform. Strip selection/highlight classes (the
    // card-flight-ghost above strips the same list).
    g.classList.remove('selected', 'is-selected', 'card-selected', 'target-highlight',
      'targetable', 'playable', 'unplayable', 'card-enter', 'card-flying',
      'card-landing', 'magnifying', 'face-flipped', 'card-being-dragged');
    // Size the ghost to the BOARD TILE it will become — not the tall hand
    // card. The clone leaves .player-hand-section, so the hand-scoped hide
    // rules stop applying. Width comes from a live card-slot; the
    // .card-drag-ghost CSS mirrors the mobile board compaction.
    const slot = document.querySelector('.board .card-slot');
    const w = slot ? Math.max(48, slot.offsetWidth - 6) : cardEl.offsetWidth;
    // OPAQUE — any translucency lets the text of the cards underneath bleed
    // through; the drop shadow already separates it from the board.
    // BORN OFF-SCREEN, NEVER AT 0,0: at -9999px an unpositioned ghost is
    // invisible instead of parking a full-size card over the HUD.
    // Position rides `left`/`top` (setProperty ..., 'important'), which no
    // transform rule can touch; `transform` is only the cosmetic tilt and
    // scale, so the worst case costs the tilt, not the position.
    g.style.cssText = `position:fixed; left:-9999px; top:-9999px; z-index:3000;
      pointer-events:none; width:${w}px; margin:0; opacity:1; will-change:transform;`;
    document.body.appendChild(g);
    g._dragW = g.offsetWidth || 0; g._dragH = g.offsetHeight || 0;
    g._dragSrc = cardEl;
    return g;
  },
  _makeCardDragGhost(cardEl, px, py, prepared) {
    const g = (prepared && prepared.isConnected && prepared._dragSrc === cardEl)
      ? prepared : this._prepCardDragGhost(cardEl);
    // Place it AT THE POINTER the moment it exists, rather than relying on the
    // caller to do it on the same tick. offsetWidth/offsetHeight are readable
    // now because it is in the document.
    if (typeof px === 'number' && typeof py === 'number') this._positionDragGhost(g, px, py, 0);
    // Mark the card being dragged so the hand shows a gap where it was, rather
    // than the same card appearing twice.
    // Cleared by a single document-level sweep rather than in the teardown:
    // the drag has SEVERAL exit paths (mouseup, touchend, touchcancel, a
    // rejected drop), and a stuck class would leave an invisible hand card.
    // BACKED BY STATE (_draggingCardId), not just stamped on the element:
    // starting a drag renders, and the cached hand path diffs className. Like
    // UI._flippedHandCardId, the id is the truth and the class is re-applied
    // every render; it is in _DECORATION_CLASSES so the diff strips-and-restores.
    // It must NOT go in _FX_TRANSIENT_CLASSES — that list is only for provably
    // self-removing one-shots, and a drag ends on an event.
    document.querySelectorAll('.card-being-dragged')
      .forEach(el => el.classList.remove('card-being-dragged'));
    cardEl.classList.add('card-being-dragged');
    this._draggingCardId = cardEl.dataset.cardId != null ? cardEl.dataset.cardId : null;
    if (!this._dragClassSweepInstalled) {
      this._dragClassSweepInstalled = true;
      const sweep = () => {
        this._draggingCardId = null;
        document.querySelectorAll('.card-being-dragged')
          .forEach(el => el.classList.remove('card-being-dragged'));
      };
      ['mouseup', 'touchend', 'touchcancel', 'dragend'].forEach(evt =>
        document.addEventListener(evt, sweep, { capture: true, passive: true }));
    }
    return g;
  },

  installHandTilt() {
    if (this._handTiltInstalled) return;
    this._handTiltInstalled = true;
    if (!this._hasFinePointer()) return;  // hover-tilt is mouse-only; a tap would freeze a card mid-tilt
    // The tilt vars drive rotateX/rotateY on the hovered card, which is what
    // creates its 3D rendering context. In low-fx the CSS forces a flat 2D
    // scale instead, so writing the vars would just burn frames.
    if (this.isLowFx()) return;
    // Hand cards and tricks both get the 3D tilt. Hand cards: vars go on the
    // .hand-card-wrapper (CSS keys the transform off its hover + child card).
    // Tricks / draft / board-ally / board-enemy have no wrapper, so the vars go on
    // the card itself. .enc-card is included so codex portraits get the
    // cursor-following bevel + holographic sheen (they read --tilt-x/y too).
    //
    // ============================================================
    // rAF LERP LOOP
    // ============================================================
    // mousemove writes a TARGET; rAF lerps current → target and writes the CSS
    // var. Writing vars straight from mousemove fights a CSS transform transition
    // and judders, so the active-hover CSS transition is dropped (see style.css)
    // and the rAF loop owns the per-frame transform.
    //
    // Lerp factor 0.20: smaller = silkier but laggier; larger = snappier but the
    // lerp benefit fades.
    //
    // ONE loop at a time walks the (tiny) active-target list and self-terminates
    // when every target is at rest (|delta| < 0.001).
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

    // Targets with non-zero target OR current values, so the loop never scans
    // the DOM. A Set for O(1) add/remove + de-dupe.
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
      if (UI.isLowFx()) return;   // probe can trip after install
      const target = e.target.closest && e.target.closest(TILT_SELECTORS);
      if (!target) return;
      // For .hand-card-wrapper only the inner .card.hand-card is scaled; read the
      // inner card's rect so tilt maps to the visible enlarged card.
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

    // Mouseleave: target → 0,0 so the lerp eases back; tick removes it from
    // hovered once current also reaches 0.
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
};
