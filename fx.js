// ============================================================
// fx.js — THE EFFECTS LIBRARY (split out of ui.js)
// ============================================================
// Every one-shot visual effect the game draws: the shared primitives
// (_fxDrawBolt/Beam, _fxSparks, _fxImpact, _fxRing, _fxTendril, …), the
// per-card signature casts, move styles, the FX director that paces the
// engine's FX event stream, and the AAA impact layer.
//
// HOW IT JOINS UI. This file loads BEFORE ui.js and only declares UI_FX — a
// plain object of methods. ui.js merges it into UI immediately after the UI
// object literal (Object.assign), i.e. before UI.init() runs. That order is
// load-bearing: installFxBridge (called from init) wraps every `_fx*` key it
// finds on UI so effects relay to online guests — an effect added after init
// would silently never reach the other players. Methods use `this` exactly as
// they did inside the literal, so nothing that calls UI._fxWhatever changes.
// ============================================================
const UI_FX = {

  // ============================================================
  // A CARD THAT CHANGES LANE, SEEN CHANGING LANE
  // ============================================================
  // The board is a diff render, so a moved card is simply absent from one slot
  // and present in another on the next frame; this connects the two.
  //
  // Same machinery as the play-from-hand throw (card-flying on the real element
  // + a fixed ghost + _spawnPlayerLandFx on arrival). Two differences: the path
  // is a lateral SLIDE rather than a thrown arc, and it runs for BOTH sides,
  // because an enemy repositioning is the move you most need to follow.
  // MOVE STYLES. Every move funnels through moveCard -> emitFX('move') ->
  // _fxCardSlide, so a card's travel gets its own personality by adding ONE
  // entry here — no per-ability FX calls.
  //   moth  — flutters along a wavy arc, shedding glowing wing dust
  //   boom  — crosses in a blink: white-hot streak, shockwave at both ends
  //   jet   — Jango Fett: a jetpack burn, flame streak, sparks at take-off
  //   stomp — T-Rex: three heavy strides, a hard landing that shakes the board
  MOVE_STYLES: { 'Killer Moth': 'moth', 'Man-Bat': 'moth', 'Omni-Man': 'boom', 'Jango Fett': 'jet', 'T-Rex': 'stomp' },
  _fxCardSlide(ev) {
    if (!ev || ev.from == null || ev.to == null || ev.from === ev.to) return;
    if (this._reducedMotion && this._reducedMotion()) return;
    const realEl = document.querySelector(`[data-card-id="${ev.cardId}"]`);
    if (!realEl) return;
    // Viewer-relative: ev.owner is the ABSOLUTE side, and in 2v2 half the table
    // sees the board mirrored.
    const dom = this._fxDomSide ? this._fxDomSide(ev.owner) : ev.owner;
    const fromLane = this.laneElAt(ev.from);
    if (!fromLane) return;
    const fromSlot = fromLane.querySelector(dom === 'player' ? '.player-slot' : '.ai-slot');
    if (!fromSlot) return;
    const fromRect = fromSlot.getBoundingClientRect();
    const toRect = realEl.getBoundingClientRect();
    if (!fromRect.width || !toRect.width) return;
    const dx = (toRect.left + toRect.width / 2) - (fromRect.left + fromRect.width / 2);
    const dy = (toRect.top + toRect.height / 2) - (fromRect.top + fromRect.height / 2);
    if (Math.hypot(dx, dy) < 24) return;   // no real travel — nothing to show

    const ghost = realEl.cloneNode(true);
    ghost.classList.add('card-slide-ghost');
    ghost.classList.remove('card-enter', 'card-flying', 'card-landing', 'selected',
      'card-selected', 'target-highlight', 'targetable', 'playable', 'unplayable');
    ghost.removeAttribute('data-card-id');
    ghost.onclick = null;
    ghost.style.position = 'fixed';
    ghost.style.margin = '0';
    ghost.style.left = fromRect.left + 'px';
    ghost.style.top = fromRect.top + 'px';
    ghost.style.width = toRect.width + 'px';
    ghost.style.height = toRect.height + 'px';
    ghost.style.setProperty('--slide-dx', dx + 'px');
    ghost.style.setProperty('--slide-dy', dy + 'px');
    // Lean into the direction of travel — a body moving sideways banks.
    ghost.style.setProperty('--slide-tilt', (dx >= 0 ? 5 : -5) + 'deg');
    const style = (this.MOVE_STYLES && this.MOVE_STYLES[ev.name]) || '';
    const DUR = style === 'moth' ? 900 : style === 'boom' ? 240 : style === 'jet' ? 380 : style === 'stomp' ? 640 : 420;
    const cx0 = fromRect.left + fromRect.width / 2, cy0 = fromRect.top + fromRect.height / 2;
    let anim = null;
    if (style && ghost.animate) {
      // Driven by the Web Animations API so the path can be more than a line.
      const N = 16, frames = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        let x = dx * t, y = dy * t, rot = 0, extra = '';
        if (style === 'moth') {
          const e = t < .5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2)/2;     // ease in-out
          x = dx * e; y = dy * e - Math.sin(t * Math.PI) * 46 + Math.sin(t * Math.PI * 4) * 9;
          rot = Math.sin(t * Math.PI * 6) * 9;
          extra = ' scale(' + (1 - Math.sin(t * Math.PI) * .12).toFixed(3) + ')';
        } else if (style === 'stomp') {
          const e = t;                                                  // three strides: hop, hop, hop
          x = dx * e; y = dy * e - Math.abs(Math.sin(t * Math.PI * 3)) * 18; rot = Math.sin(t * Math.PI * 3) * 3;
        } else if (style === 'jet') {
          const e = t < .5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2)/2;        // lift, cruise, settle
          x = dx * e; y = dy * e - Math.sin(t * Math.PI) * 30; rot = (dx >= 0 ? 6 : -6) * Math.sin(t * Math.PI);
        } else {
          const e = 1 - Math.pow(1 - t, 4);                             // snap out, hard stop
          x = dx * e; y = dy * e; rot = (dx >= 0 ? 4 : -4) * Math.sin(t * Math.PI);
        }
        const f = { transform: 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) rotate(' + rot.toFixed(2) + 'deg)' + extra };
        if (style === 'boom') f.filter = t > .05 && t < .9 ? 'blur(1.5px) brightness(1.5)' : 'none';
        frames.push(f);
      }
      document.body.appendChild(ghost);
      anim = ghost.animate(frames, { duration: DUR, easing: 'linear', fill: 'forwards' });
      if (style === 'moth') this._fxMothDust(cx0, cy0, dx, dy, DUR);
      if (style === 'boom') this._fxSonicBoom(cx0, cy0, dx, dy);
      if (style === 'jet') this._fxSonicBoom(cx0, cy0, dx, dy, 'jet');
    } else {
      ghost.style.animation = `cardSlideAcross ${DUR}ms cubic-bezier(0.4, 0, 0.2, 1) forwards`;
      document.body.appendChild(ghost);
    }

    // The wake it leaves behind — a streak along the path, drawn on the same
    // fixed layer so no render can delete it.
    const trail = document.createElement('div');
    trail.className = 'card-slide-trail';
    trail.style.left = (fromRect.left + fromRect.width / 2) + 'px';
    trail.style.top = (fromRect.top + fromRect.height / 2) + 'px';
    trail.style.width = Math.hypot(dx, dy) + 'px';
    trail.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    trail.classList.add(dom === 'player' ? 'slide-ally' : 'slide-enemy');
    if (style !== 'moth') document.body.appendChild(trail);   // the moth leaves dust, not a line

    realEl.classList.add('card-flying');
    realEl.dataset.flyAt = String(Date.now());   // swept if it sticks (renderBoard), like every other card-flying
    let done = false;
    const land = () => {
      if (done) return; done = true;
      try { ghost.remove(); } catch (e) {}
      try { trail.remove(); } catch (e) {}
      realEl.classList.remove('card-flying');
      if (realEl.dataset) delete realEl.dataset.flyAt;
      const slot = realEl.closest('.player-slot, .ai-slot');
      const lane = realEl.closest('.lane');
      try { this._spawnPlayerLandFx(realEl, lane, slot, true, { thump: false }); } catch (e) {}
    };
    if (anim) anim.onfinish = () => {
      land();
      if (style === 'boom') { try { this._fxRing(realEl, { color: '#ffffff' }); this._screenShake('land-m'); } catch (e) {} }
      if (style === 'moth') { try { this._fxRing(realEl, { color: '#c08cff', contract: true }); } catch (e) {} }
      if (style === 'jet') { try { const p = this._fxCenter(realEl); if (p) this._fxSparks(p, { color: '#ffd38a', glow: '#ff7a1a', count: 12, angle: Math.PI / 2, cone: 1.2, spread: 50, size: 2.6 }); } catch (e) {} }
      if (style === 'stomp') { try { this._fxRing(realEl, { color: '#c9a36a' }); this._screenShake('land-l'); } catch (e) {} }
    };
    else ghost.addEventListener('animationend', land, { once: true });
    setTimeout(land, DUR + 90);   // the card can never stay hidden
    try { this.sfx && this.sfx.play && this.sfx.play('cardMove'); } catch (e) {}
  },
  // Wing dust shed along a moth's flutter path: small glowing motes, released
  // in step with the card as it travels, each drifting down and fading.
  _fxMothDust(x0, y0, dx, dy, dur) {
    const layer = this._fxLayer();
    const N = 26;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      setTimeout(() => {
        const e = t < .5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2)/2;
        const m = document.createElement('i');
        m.className = 'fx-moth-dust';
        const x = x0 + dx * e + (Math.random() - .5) * 46;
        const y = y0 + dy * e - Math.sin(t * Math.PI) * 46 + (Math.random() - .5) * 30;
        const hue = Math.random() < .55 ? '#c08cff' : '#ffd37a';
        m.style.cssText = 'left:' + x + 'px;top:' + y + 'px;--dust-c:' + hue + ';--dust-dx:' + ((Math.random() - .5) * 30) + 'px;--dust-s:' + (2 + Math.random() * 3) + 'px;';
        layer.appendChild(m);
        setTimeout(() => m.remove(), 1100);
      }, t * dur);
    }
  },
  // Sonic boom: a white-hot streak the length of the jump that snaps in and
  // bleeds out, plus a shock ring left hanging at the take-off point.
  _fxSonicBoom(x0, y0, dx, dy, kind) {
    const layer = this._fxLayer();
    const st = document.createElement('div');
    st.className = 'fx-sonic-streak' + (kind === 'jet' ? ' fx-jet-streak' : '');
    st.style.cssText = 'left:' + x0 + 'px;top:' + y0 + 'px;width:' + Math.hypot(dx, dy) + 'px;transform:rotate(' + Math.atan2(dy, dx) + 'rad);';
    layer.appendChild(st);
    setTimeout(() => st.remove(), 700);
    const ring = document.createElement('div');
    ring.className = 'sig-ring';
    ring.style.cssText = 'left:' + x0 + 'px;top:' + y0 + 'px;--sig-c:#ffffff;';
    layer.appendChild(ring);
    setTimeout(() => ring.remove(), 540);
  },

  // ============================================================
  // A LANE GOING OUT
  // ============================================================
  // Darkseid's Anti-Life takes a whole lane away for several rounds. Layers on
  // one beat, like the block moment: the lane implodes inward, a shock ring
  // throws outward, the column goes to void, and the number of rounds it is
  // gone is stated on the collapse rather than left to be counted off a pip.
  _fxLaneVoid(ev) {
    if (!ev || ev.lane == null) return;
    const stage = this._fxLaneStage(ev.lane, 'lane-void-stage');
    if (!stage) return;
    if (this._reducedMotion && this._reducedMotion()) { stage.remove(); return; }
    const collapse = document.createElement('div');
    collapse.className = 'lane-void-collapse';
    const ring = document.createElement('div');
    ring.className = 'lane-void-ring';
    const label = document.createElement('div');
    label.className = 'lane-void-label';
    const n = ev.rounds | 0;
    label.textContent = n > 0 ? `VOID · ${n}` : 'VOID';
    stage.appendChild(collapse);
    stage.appendChild(ring);
    stage.appendChild(label);
    setTimeout(() => { try { stage.remove(); } catch (e) {} }, 1450);
    try { this._screenShake && this._screenShake('medium'); } catch (e) {}
    try { this._haptic && this._haptic('block'); } catch (e) {}
  },

  // Wetlands loses a Power — a single ring spreading across the lane's water.
  // Small on purpose: this fires up to three times a match and is a countdown
  // tick, not an event. The release below is the event.
  _fxWetlandsRipple(laneIdx) {
    if (this._reducedMotion && this._reducedMotion()) return;
    const stage = this._fxLaneStage(laneIdx, 'wetlands-ripple-stage');
    if (!stage) return;
    const ring = document.createElement('div');
    ring.className = 'wetlands-ripple';
    stage.appendChild(ring);
    setTimeout(() => stage.remove(), 900);
  },

  // The swamp drains as Spinosaurus surfaces — the release consumes the
  // habitat, so this plays on the way in rather than on his death.
  _fxWetlandsDrain(laneIdx) {
    const stage = this._fxLaneStage(laneIdx, 'wetlands-drain-stage');
    if (!stage) return;
    const drain = document.createElement('div');
    drain.className = 'wetlands-drain';
    stage.appendChild(drain);
    setTimeout(() => stage.remove(), 1000);
  },

  // IT LANDED, AND THEN IT DIED — SHOW BOTH.
  //
  // A card killed by the lane it walked into (The Bathroom, Luke's aura, a
  // trap) is seated and swept inside one synchronous engine block, so the board
  // never renders with it present. Game._settleAndSweep emits 'enterAndDie';
  // this paints the moment over a board that has already moved on, using the
  // canonical card renderer so the face matches what the lane would show.
  //
  // On the body-level lane stage, never parented to the lane: renderBoard
  // deletes every lane child and rewrites the lane's className, and a render is
  // exactly what follows the play that raised this. See _fxLaneStage.
  _fxEnterAndDie(ev) {
    if (!ev || ev.lane == null) return;
    if (this._reducedMotion && this._reducedMotion()) return;
    const stage = this._fxLaneStage(ev.lane, 'enter-die-stage');
    if (!stage) return;
    let el = null;
    try {
      const def = (typeof CARD_DEFS !== 'undefined')
        ? CARD_DEFS.find(d => d && d.name === ev.name) : null;
      if (def) {
        const face = this._synthFace(def, { cost: ev.cost, attack: ev.atk, health: ev.hp });
        // Viewer-relative side, like every other side-anchored effect — ev.owner
        // is the ABSOLUTE side, and in 2v2 half the table sees it mirrored.
        const side = this._fxDomSide ? this._fxDomSide(ev.owner) : ev.owner;
        // inHand false — this is the BOARD face, the one the lane would have
        // shown, not the taller hand tile.
        el = this.makeCardEl(face, false, side, { static: true, extraClass: 'enter-die-card' });
      }
    } catch (e) { el = null; }
    if (!el) { stage.remove(); return; }
    // Bottom half for the near side, top half for the far side — the same
    // geometry the lane itself uses for the two combat slots.
    const side = this._fxDomSide ? this._fxDomSide(ev.owner) : ev.owner;
    stage.classList.add(side === 'player' ? 'enter-die-near' : 'enter-die-far');
    stage.appendChild(el);
    // Land, hold long enough to be read, then die.
    setTimeout(() => { try { el.classList.add('enter-die-out'); } catch (e) {} }, 620);
    setTimeout(() => { try { stage.remove(); } catch (e) {} }, 1320);
    try { if (this.sfx && this.sfx.playCardSfx) this.sfx.playCardSfx(ev.name, 'death', null); } catch (e) {}
  },

  // A lane-shaped, lane-CLIPPED stage in the body-level FX layer.
  //
  // NOT a child of the lane: renderBoard's lane rebuild removes every child
  // except the two slots, the separator and the env background, and rewrites
  // the lane's className — so an FX node in the lane, and any class put on the
  // lane to drive it, die on the next render (e.g. summoning Spinosaurus itself
  // triggers one).
  //
  // #signature-fx-layer is position:fixed and untouched by any render, so the
  // stage is placed at the lane's screen rect instead. It also paints ABOVE
  // the board (z-index 200), which lets an opaque water panel cover the card
  // during the emergence without touching the card element.
  //
  // Clipping matters: `.lane` is overflow:visible (several FX rely on that), so
  // an unclipped sail would show the body below the waterline.
  // OVERDRIVE — "attacks again after a kill". A boxless glow-text callout in the
  // keyword's own colour (--kw-overdrive, the badge's token) over the card that
  // is about to swing again; ×N on the second link onward. On the body-level
  // FX layer, so a render mid-chain can't delete it (lane FX rule).
  _fxOverdrive(ev) {
    if (typeof document === 'undefined') return;
    const stage = this._fxLaneStage(ev.lane, 'overdrive-stage');
    if (!stage) return;
    const sr = stage.getBoundingClientRect();
    const cardEl = ev.cardId != null ? document.querySelector(`.board [data-card-id="${ev.cardId}"]`) : null;
    let y = sr.height * (this._fxDomSide && this._fxDomSide(ev.owner) === 'player' ? 0.72 : 0.28);
    if (cardEl) { const cr = cardEl.getBoundingClientRect(); if (cr.height) y = cr.top - sr.top + cr.height * 0.38; }
    const tag = document.createElement('div');
    tag.className = 'od-callout';
    tag.style.top = y + 'px';
    tag.textContent = 'OVERDRIVE';
    if ((ev.chain | 0) > 1) {
      const n = document.createElement('span');
      n.className = 'od-chain';
      n.textContent = '\u00d7' + (ev.chain | 0);
      tag.appendChild(n);
    }
    stage.appendChild(tag);
    try { this.sfx && this.sfx.play && this.sfx.play('overdrive'); } catch (e) {}
    if (this._haptic) { try { this._haptic('hit'); } catch (e) {} }
    setTimeout(() => stage.remove(), 950);
  },
  _fxLaneStage(laneIdx, cls) {
    const laneEl = this.laneElAt(laneIdx);
    if (!laneEl) return null;
    const r = laneEl.getBoundingClientRect();
    if (!r || !r.width) return null;
    const stage = document.createElement('div');
    stage.className = 'lane-fx-stage ' + (cls || '');
    stage.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
    this._fxLayer().appendChild(stage);
    return stage;
  },

  // ===================== SIGNATURE FX TOOLKIT =====================
  // Reusable one-shot cinematics for marquee casts. Primitives any card can
  // fire (BOLT, BEAM, IMPLODE, …) so a new card just calls a primitive instead
  // of adding per-card hacks. Every one is reduced-motion-gated, battery-safe
  // (one setTimeout cleanup each — no infinite loops), and tab-hidden-paused
  // (they live under <body>, which `body.tab-hidden *{animation-play-state:paused}`
  // freezes).
  // Fired from engine/ability code via the guarded
  //   if (typeof UI !== 'undefined' && UI._fxXxx) ...
  // pattern, like the jumpscares. In headless sim UI is undefined, so the
  // calls no-op.

  _fxLayer() {
    let layer = document.getElementById('signature-fx-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'signature-fx-layer';
      document.body.appendChild(layer);
    }
    return layer;
  },
  _fxCardElById(id) {
    if (id == null) return null;
    return document.querySelector('.board .card[data-card-id="' + id + '"]');
  },
  _fxCenter(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  },
  // Run cb(el) with a card's DOM element, deferring if the card was JUST played
  // and isn't painted to .board yet (playCard repaints only AFTER onPlay
  // returns). Every onPlay-fired cast that needs its source element uses this.
  _fxWhenPainted(sourceCard, cb) {
    if (!sourceCard) return;
    const found = this._fxCardElById(sourceCard.id);
    if (found) { cb(found); return; }
    // Not painted yet. The caller's post-onPlay UI.render() mutates the DOM
    // inside its OWN rAF, registered AFTER this one, so a setTimeout(0) or a
    // SINGLE rAF both fire before that paint. A DOUBLE rAF waits one frame past
    // render's rAF, by which point the card element exists. Falls back to timers
    // where rAF is unavailable (headless never gets here — UI is undefined in sim).
    const raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
      ? window.requestAnimationFrame.bind(window)
      : (f) => setTimeout(f, 16);
    // rAF STARVATION FALLBACK. A backgrounded tab gets no animation frames, so
    // the double-rAF never runs — a relayed cast on an unwatched guest would
    // never animate. A timer keeps running, so both are armed and the first to
    // arrive wins (`done` makes it exactly once). 120ms is past the render that
    // paints the card, yet short enough that a hidden tab still resolves.
    let done = false;
    const fire = () => {
      if (done) return;
      const e2 = this._fxCardElById(sourceCard.id);
      if (!e2) return;          // still not painted — let the other path retry
      done = true;
      // DEPTH GUARD ACROSS THE DEFERRAL. This body runs later, after the relayed
      // top-level _fx* method has returned and _sigFxDepth is back to 0. Without
      // re-entering the guard, every nested _fx* call inside cb with serializable
      // args emits its OWN 'sig', and the guest plays that piece TWICE (once from
      // replaying the top-level method, once from the stray sig). Treat the
      // deferred body as still inside the top-level call.
      this._sigFxDepth++;
      try { cb(e2); }
      finally { this._sigFxDepth--; }
    };
    raf(() => raf(fire));
    setTimeout(fire, 120);
    setTimeout(fire, 400);      // last chance on a slow/just-restored client
  },

  // Jagged electric arc between two viewport points. `from` null → the
  // bolt strikes down from the sky above `to`. Cosmetic jitter uses
  // Math.random (NOT Game.rng — the FX must never consume the seeded
  // gameplay stream).
  _fxDrawBolt(from, to, opts) {
    if (!to || this._reducedMotion()) return;
    opts = opts || {};
    const src = from || { x: to.x, y: Math.max(-40, to.y - 280) };
    const color = opts.color || '#9be0ff';
    const glow  = opts.glow  || '#4aa3ff';
    const layer = this._fxLayer();
    const dx = to.x - src.x, dy = to.y - src.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len, py = dx / len;   // perpendicular unit vector
    const segs = Math.max(4, Math.min(11, Math.round(len / 40)));
    let d = 'M ' + src.x.toFixed(1) + ' ' + src.y.toFixed(1);
    for (let i = 1; i < segs; i++) {
      const t = i / segs;
      const jitter = (Math.random() - 0.5) * Math.min(48, len * 0.24);
      const x = src.x + dx * t + px * jitter;
      const y = src.y + dy * t + py * jitter;
      d += ' L ' + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    d += ' L ' + to.x.toFixed(1) + ' ' + to.y.toFixed(1);
    // AAA: 1-2 jagged branch forks off the main arc so it reads as real
    // lightning, not a single stroke.
    let forks = '';
    const nForks = 1 + (Math.random() < 0.6 ? 1 : 0);
    for (let f = 0; f < nForks; f++) {
      const bt = 0.42 + Math.random() * 0.42;
      const bx = src.x + dx * bt, by = src.y + dy * bt;
      const fa = Math.atan2(dy, dx) + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.6);
      const flen = len * (0.16 + Math.random() * 0.22);
      let fd = 'M ' + bx.toFixed(1) + ' ' + by.toFixed(1);
      for (let i = 1; i <= 3; i++) {
        const t = i / 3;
        fd += ' L ' + (bx + Math.cos(fa) * flen * t + (Math.random() - 0.5) * 18).toFixed(1) +
              ' ' + (by + Math.sin(fa) * flen * t + (Math.random() - 0.5) * 18).toFixed(1);
      }
      forks +=
        '<path d="' + fd + '" fill="none" stroke="' + glow + '" stroke-width="3.4" stroke-linecap="round" opacity="0.45"></path>' +
        '<path d="' + fd + '" fill="none" stroke="' + color + '" stroke-width="1.4" stroke-linecap="round"></path>';
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'sig-bolt');
    svg.style.filter = 'drop-shadow(0 0 6px ' + glow + ')';
    svg.innerHTML = forks +
      '<path d="' + d + '" fill="none" stroke="' + glow + '" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"></path>' +
      '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></path>' +
      '<path d="' + d + '" fill="none" stroke="#ffffff" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"></path>';
    layer.appendChild(svg);
    // AAA: strike flash + spark burst where the bolt lands.
    this._fxImpact(to, { color: glow, core: '#ffffff', size: 0.85 });
    this._fxSparks(to, { color: '#ffffff', glow: glow, count: 9, spread: 56, size: 2.6 });
    setTimeout(() => svg.remove(), 440);
  },

  // Straight energy beam from `from` to `to` with a bright core, plus an
  // impact burst at the target. Color-parameterized (Darkseid red,
  // Superman red/white). The angle rides a CSS var so the fire keyframe
  // can animate scaleX without clobbering the rotation.
  _fxDrawBeam(from, to, opts) {
    if (!from || !to || this._reducedMotion()) return;
    opts = opts || {};
    const core = opts.core || '#ffffff';
    const color = opts.color || '#ff2d2d';
    const thickness = opts.thickness || 8;
    const layer = this._fxLayer();
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    const angRad = Math.atan2(dy, dx);
    const ang = angRad * 180 / Math.PI;
    const beam = document.createElement('div');
    beam.className = 'sig-beam';
    beam.style.cssText =
      'left:' + from.x + 'px;top:' + (from.y - thickness / 2) + 'px;width:' + len + 'px;height:' + thickness + 'px;' +
      '--sig-ang:' + ang + 'deg;' +
      'background:linear-gradient(90deg,' + color + '00 0%,' + color + ' 12%,' + core + ' 50%,' + color + ' 88%,' + color + '00 100%);' +
      'box-shadow:0 0 18px 4px ' + color + ', 0 0 40px 9px ' + color + '66;';
    layer.appendChild(beam);
    // AAA: muzzle flash + forward spark-spit at the origin; an impact flash,
    // shockwave, and debris burst at the target.
    this._fxImpact(from, { color: color, core: core, size: 0.5 });
    this._fxSparks(from, { color: core, glow: color, count: 5, angle: angRad, cone: 1.0, spread: 38, size: 2.4 });
    this._fxImpact(to, { color: color, core: core, size: opts.impact || 1 });
    this._fxSparks(to, { color: core, glow: color, count: 13, spread: 72, size: 3 });
    setTimeout(() => { beam.remove(); }, 540);
  },

  // Void singularity that swallows a card (Galactus devour). Clones the
  // card into a DETACHED ghost so the engine's card removal (which
  // happens on the very next render) can't cut the spiral short — same
  // trick _spawnDeathGhost uses.
  _fxImplode(el, opts) {
    if (!el || this._reducedMotion()) return;
    opts = opts || {};
    const color = opts.color || '#b06bff';
    const r = el.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const layer = this._fxLayer();
    const ghost = el.cloneNode(true);
    ghost.removeAttribute('data-card-id');
    ghost.classList.add('sig-devour-ghost');
    ghost.style.cssText =
      'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;--sig-c:' + color + ';';
    layer.appendChild(ghost);
    const ring = document.createElement('div');
    ring.className = 'sig-void-ring';
    ring.style.cssText = 'left:' + (r.left + r.width / 2) + 'px;top:' + (r.top + r.height / 2) + 'px;--sig-c:' + color + ';';
    layer.appendChild(ring);
    setTimeout(() => { ghost.remove(); ring.remove(); }, 660);
  },

  // ---- AAA "juice" primitives — shared debris + impact so every line-based
  // cast (beam / bolt / tendril / saber) lands with weight instead of just a
  // stroke. All one-shot + auto-removing + reduced-motion guarded; cosmetic
  // jitter uses Math.random, never Game.rng. ----

  // Particle spark burst: N bright motes fly out of `point` and fade. Radial
  // by default; pass opts.angle (radians) + opts.cone for a directional spit
  // (muzzle spray). opts: count, color, glow, spread(px), size, angle, cone.
  _fxSparks(point, opts) {
    if (!point || this._reducedMotion()) return;
    opts = opts || {};
    const n = opts.count || 10;
    const color = opts.color || '#cfeaff';
    const glow = opts.glow || color;
    const spread = opts.spread || 62;
    const size = opts.size || 3;
    const layer = this._fxLayer();
    const dir = (opts.angle != null) ? opts.angle : null;
    const cone = (opts.cone != null) ? opts.cone : 1.4;
    for (let i = 0; i < n; i++) {
      const a = (dir != null) ? dir + (Math.random() - 0.5) * cone : Math.random() * Math.PI * 2;
      const dist = spread * (0.4 + Math.random() * 0.6);
      const sx = Math.cos(a) * dist, sy = Math.sin(a) * dist;
      const s = (size * (0.55 + Math.random() * 0.9)).toFixed(1);
      const sp = document.createElement('div');
      sp.className = 'sig-spark';
      sp.style.cssText =
        'left:' + point.x + 'px;top:' + point.y + 'px;width:' + s + 'px;height:' + s + 'px;' +
        '--sx:' + sx.toFixed(1) + 'px;--sy:' + sy.toFixed(1) + 'px;' +
        '--sig-c:' + color + ';--sig-g:' + glow + ';' +
        'animation-delay:' + (Math.random() * 60).toFixed(0) + 'ms;';
      layer.appendChild(sp);
      setTimeout(() => sp.remove(), 640);
    }
  },

  // Impact burst: a bright radial flash + an expanding shockwave ring at
  // `point`. opts: color, core, size (scale multiplier).
  _fxImpact(point, opts) {
    if (!point || this._reducedMotion()) return;
    opts = opts || {};
    const color = opts.color || '#ffd0d0';
    const core = opts.core || '#ffffff';
    const size = opts.size || 1;
    const layer = this._fxLayer();
    const flash = document.createElement('div');
    flash.className = 'sig-flash';
    flash.style.cssText = 'left:' + point.x + 'px;top:' + point.y + 'px;--sig-c:' + color + ';--sig-core:' + core + ';--sig-s:' + size + ';';
    layer.appendChild(flash);
    const shock = document.createElement('div');
    shock.className = 'sig-shock';
    shock.style.cssText = 'left:' + point.x + 'px;top:' + point.y + 'px;--sig-c:' + color + ';--sig-s:' + size + ';';
    layer.appendChild(shock);
    setTimeout(() => { flash.remove(); shock.remove(); }, 580);
  },

  // ---- Named per-card entry points (thin wrappers over the primitives) ----

  // Palpatine (and ANY chain ability via runPlayerChain): one electric
  // arc per link, staggered so the chain reads as a travelling bolt.
  // fromId null → sky strike; seq drives the stagger.
  _fxChainArc(fromId, toId, seq) {
    if (this._reducedMotion()) return;
    const delay = (seq | 0) * 120;
    setTimeout(() => {
      const to = this._fxCenter(this._fxCardElById(toId));
      if (!to) return;
      const from = fromId != null ? this._fxCenter(this._fxCardElById(fromId)) : null;
      this._fxDrawBolt(from, to, { color: '#9be0ff', glow: '#4aa3ff' });
      if ((seq | 0) === 0) this._screenShake('light');
    }, delay);
  },

  // Darkseid Omega Beam: red beam from Darkseid to each target as it's hit.
  _fxOmegaBeam(sourceCard, targetCard) {
    if (this._reducedMotion() || !sourceCard || !targetCard) return;
    const srcEl = this._fxCardElById(sourceCard.id);
    const from = this._fxCenter(srcEl);
    const tgtEl = this._fxCardElById(targetCard.id);
    const to = this._fxCenter(tgtEl);
    if (!from || !to) return;
    // Twin Omega Beams sear from Darkseid's eyes into the victim, then the
    // impact caves in with a red ring + debris.
    this._fxDrawBeam({ x: from.x - 10, y: from.y }, to, { color: '#ff2d2d', core: '#ffd0d0', thickness: 7 });
    this._fxDrawBeam({ x: from.x + 10, y: from.y }, to, { color: '#ff2d2d', core: '#ffd0d0', thickness: 7 });
    if (tgtEl) this._fxRing(tgtEl, { color: '#ff2d2d', contract: true });
    this._fxImpact(to, { color: '#ff6a5a', core: '#ffffff', size: 1.1 });
    this._fxSparks(to, { count: 12, color: '#ffd0d0', glow: '#ff2d2d', spread: 66, size: 2.8 });
    this._screenShake('medium');
    if (srcEl) { srcEl.classList.add('fx-eye-glow'); setTimeout(() => srcEl.classList.remove('fx-eye-glow'), 500); }
  },

  // Emperor Palpatine — UNLIMITED POWER: forked violet-white Force lightning
  // leaps from his hands to each enemy in the freeze chain.
  _fxPalpatineLightning(self, targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const tgtEl = this._fxCardElById(targetCard.id);
    const to = this._fxCenter(tgtEl);
    if (!to) return;
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from) {
        this._fxDrawBolt(from, to, { color: '#e6b3ff', glow: '#8a2be2' });
        this._fxDrawBolt(from, to, { color: '#ffffff', glow: '#b06bff' });
        this._fxDrawBolt(from, to, { color: '#f3d9ff', glow: '#8a2be2' });
      }
      // The bolt storm caves in — a violet ring constricts + a white-hot burst.
      if (tgtEl) this._fxRing(tgtEl, { color: '#b06bff', contract: true });
      this._fxImpact(to, { color: '#c98cff', core: '#ffffff', size: 1.0 });
      this._fxSparks(to, { color: '#e9c6ff', glow: '#8a2be2', count: 12, spread: 60, size: 2.6 });
    });
    this._screenShake('medium');
  },

  // VOLDEMORT — one wand, three curses, three colours. Built entirely from the
  // existing FX primitives and gated on reduced-motion like every other cast.
  _fxVoldemortCurse(self, targetCard, curseId) {
    if (this._reducedMotion() || !targetCard) return;
    const tgtEl = this._fxCardElById(targetCard.id);
    const to = this._fxCenter(tgtEl);
    if (!to) return;
    // Three curses, three colours of LIGHTNING: Avada Kedavra green, Crucio red,
    // Imperio yellow — one family, told apart by colour alone.
    const kit = curseId === 'ak'
      ? { bolt: '#39ff5e', glow: '#0b8f2a', core: '#eaffef', shake: 'medium' }
      : curseId === 'cr'
      ? { bolt: '#ff3b3b', glow: '#8f0b0b', core: '#ffe3e3', shake: 'medium' }
      : { bolt: '#ffd633', glow: '#b38600', core: '#fff6cc', shake: 'medium' };
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (!from) return;
      // A forked strike + a white-hot inner bolt — same shape for all three.
      this._fxDrawBolt(from, to, { color: kit.bolt, glow: kit.glow });
      this._fxDrawBolt(from, to, { color: kit.core, glow: kit.bolt });
      if (tgtEl) this._fxRing(tgtEl, { color: kit.bolt, contract: true });
      this._fxImpact(to, { color: kit.bolt, core: kit.core, size: curseId === 'ak' ? 1.1 : 0.95 });
      this._fxSparks(to, { color: kit.bolt, glow: kit.glow, count: curseId === 'ak' ? 14 : 11, spread: 55, size: 2.4 });
    });
    this._screenShake(kit.shake);
  },

  // Superman heat vision: twin red/white beams to the blast target.
  // Capture the TARGET now (it exists and isn't damaged yet), then draw
  // once the freshly-played SOURCE is painted (_fxWhenPainted defers a
  // frame — playCard repaints only after onPlay returns).
  _fxHeatVision(sourceCard, targetCard) {
    if (this._reducedMotion() || !sourceCard || !targetCard) return;
    const to = this._fxCenter(this._fxCardElById(targetCard.id));
    if (!to) return;
    this._fxWhenPainted(sourceCard, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (!from) return;
      this._fxDrawBeam({ x: from.x - 11, y: from.y }, to, { color: '#ff3b30', core: '#ffffff', thickness: 5 });
      this._fxDrawBeam({ x: from.x + 11, y: from.y }, to, { color: '#ff3b30', core: '#ffffff', thickness: 5 });
      // Molten burst where the twin beams converge.
      this._fxImpact(to, { color: '#ff6a4a', core: '#ffffff', size: 1.1 });
      this._fxSparks(to, { count: 12, color: '#ffd8b0', glow: '#ff3b30', spread: 64, size: 2.8 });
      if (srcEl) { srcEl.classList.add('fx-eye-glow'); setTimeout(() => srcEl.classList.remove('fx-eye-glow'), 460); }
      this._screenShake('medium');
    });
  },

  // Godzilla atomic breath: a fan of fire streams from his maw out to every
  // enemy card, a roar recoil on his own card, a board-wide heat wash, and a
  // shake. Fired from Godzilla's onPlay; the per-card catch-fire flare is left
  // to the ability's _fxBurnIgnite so each card ignites as the breath lands.
  // One-shot, reduced-motion gated, every element self-removes.
  _fxGodzillaFire(sourceCard, enemyCards) {
    if (this._reducedMotion() || !sourceCard || !enemyCards || !enemyCards.length) return;
    // Capture each target's on-screen centre NOW — before the post-play render
    // or the burn damage repaints and moves anything.
    const targets = enemyCards
      .map(c => this._fxCenter(this._fxCardElById(c.id)))
      .filter(Boolean);
    if (!targets.length) return;
    this._fxWhenPainted(sourceCard, (srcEl) => {
      const r = srcEl.getBoundingClientRect();
      if (!r || r.width === 0) return;
      // Origin = Godzilla's maw: high on his portrait (his head is framed near
      // the top of the card), a touch in from the very edge.
      const from = { x: r.left + r.width * 0.5, y: r.top + r.height * 0.17 };

      // Roar recoil + jaw glow on his own card, a heat wash over the board,
      // and a shake as the breath erupts.
      srcEl.classList.remove('fx-godzilla-roar');
      void srcEl.offsetWidth;
      srcEl.classList.add('fx-godzilla-roar');
      setTimeout(() => srcEl.classList.remove('fx-godzilla-roar'), 900);
      this._fxGodzillaHeatWash();
      this._screenShake('medium');

      // Fan the streams out, staggered, so it reads as a sweeping breath
      // rather than one simultaneous flash.
      targets.forEach((to, i) => {
        setTimeout(() => {
          this._fxFireStream(from, to);
          // Bright inner lance + muzzle/impact bursts in fire colours.
          this._fxDrawBeam(from, to, { color: '#ff7a18', core: '#ffe6a0', thickness: 6, impact: 1.1 });
          this._fxSparks(to, { color: '#ffd27a', glow: '#ff5a1e', count: 12, spread: 66, size: 3 });
        }, i * 70);
      });
    });
  },

  // The fat, flickering body of one breath stream — a blurred flame gradient
  // that grows from maw to target, layered under the bright _fxDrawBeam lance.
  _fxFireStream(from, to) {
    if (!from || !to || this._reducedMotion()) return;
    const layer = this._fxLayer();
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx) * 180 / Math.PI;
    const thickness = Math.max(20, Math.min(46, len * 0.12));
    const stream = document.createElement('div');
    stream.className = 'fx-godzilla-fire';
    stream.style.cssText =
      'left:' + from.x + 'px;top:' + (from.y - thickness / 2) + 'px;' +
      'width:' + len + 'px;height:' + thickness + 'px;--gz-ang:' + ang + 'deg;';
    layer.appendChild(stream);
    setTimeout(() => stream.remove(), 620);
  },

  _fxGodzillaHeatWash() {
    if (this._reducedMotion()) return;
    const layer = this._fxLayer();
    const wash = document.createElement('div');
    wash.className = 'fx-godzilla-heat';
    layer.appendChild(wash);
    setTimeout(() => wash.remove(), 720);
  },

  // Galactus devour: void singularity on the devoured card.
  _fxDevour(card) {
    if (this._reducedMotion() || !card) return;
    const el = this._fxCardElById(card.id);
    if (!el) return;
    const c = this._fxCenter(el);
    // Cosmic void swallows the card — spiral implosion + a contracting void
    // ring + scattered debris, then a bright collapse where it winks out.
    this._fxImplode(el, { color: '#b06bff' });
    this._fxRing(el, { color: '#b06bff', contract: true });
    if (c) {
      this._fxSparks(c, { count: 14, color: '#e8d0ff', glow: '#b06bff', spread: 96, size: 3 });
      setTimeout(() => this._fxImpact(c, { color: '#b06bff', core: '#f0e0ff', size: 0.9 }), 300);
    }
    this._screenShake('medium');
  },

  // ---- Wave 2 primitives ----

  // Organic curved tendril that grows from `from` to `to` (symbiote lash).
  // Quadratic bezier bowed to one side; the stroke draws on via dashoffset.
  _fxTendril(from, to, opts) {
    if (!from || !to || this._reducedMotion()) return;
    opts = opts || {};
    const color = opts.color || '#0c0c0c';
    const glow  = opts.glow  || '#c1121f';
    const layer = this._fxLayer();
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len, py = dx / len;
    const bow = (opts.bow != null ? opts.bow : 32) * (Math.random() < 0.5 ? -1 : 1);
    const mx = from.x + dx * 0.5 + px * bow, my = from.y + dy * 0.5 + py * bow;
    const d = 'M ' + from.x.toFixed(1) + ' ' + from.y.toFixed(1) +
              ' Q ' + mx.toFixed(1) + ' ' + my.toFixed(1) + ' ' + to.x.toFixed(1) + ' ' + to.y.toFixed(1);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'sig-tendril');
    svg.style.filter = 'drop-shadow(0 0 5px ' + glow + ')';
    svg.innerHTML =
      '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="8" stroke-linecap="round" pathLength="1" class="sig-tendril-path"></path>' +
      '<path d="' + d + '" fill="none" stroke="' + glow + '" stroke-width="2.2" stroke-linecap="round" pathLength="1" class="sig-tendril-path sig-tendril-glint"></path>';
    layer.appendChild(svg);
    // AAA: a small burst where the tendril seizes its target.
    this._fxSparks(to, { color: glow, glow: glow, count: 7, spread: 40, size: 2.3 });
    setTimeout(() => svg.remove(), 640);
  },

  // Expanding gas cloud over a card (Joker fear-gas). Detached overlay.
  _fxGasBurst(el, opts) {
    if (!el || this._reducedMotion()) return;
    opts = opts || {};
    const color = opts.color || '#8bf24e';
    const c = this._fxCenter(el);
    if (!c) return;
    const layer = this._fxLayer();
    const gas = document.createElement('div');
    gas.className = 'sig-gas';
    gas.style.cssText = 'left:' + c.x + 'px;top:' + c.y + 'px;--sig-c:' + color + ';';
    layer.appendChild(gas);
    setTimeout(() => gas.remove(), 760);
  },

  // Ashen wither over a card (Ghost Rider Penance Stare). A detached
  // overlay that grayscales the card BENEATH it (backdrop-filter) with a
  // soul-fire flicker — survives board re-renders because it's detached.
  _fxAshen(el) {
    if (!el || this._reducedMotion()) return;
    const r = el.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const layer = this._fxLayer();
    const ash = document.createElement('div');
    ash.className = 'sig-ashen';
    ash.style.cssText = 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;';
    layer.appendChild(ash);
    setTimeout(() => ash.remove(), 900);
  },

  // Bone-spike revive shockwave + green resurrection flash (Doomsday).
  _fxRevive(el) {
    if (!el || this._reducedMotion()) return;
    const r = el.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const layer = this._fxLayer();
    const ring = document.createElement('div');
    ring.className = 'sig-revive-ring';
    ring.style.cssText = 'left:' + c.x + 'px;top:' + c.y + 'px;';
    layer.appendChild(ring);
    const flash = document.createElement('div');
    flash.className = 'sig-revive-flash';
    flash.style.cssText = 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;';
    layer.appendChild(flash);
    setTimeout(() => { ring.remove(); flash.remove(); }, 820);
    this._screenShake('heavy');
  },

  // ---- Wave 2 named per-card entry points ----

  // Ghost Rider Penance Stare: the target withers to ash; his skull flares.
  _fxPenanceStare(sourceCard, targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const tgtEl = this._fxCardElById(targetCard.id);
    if (tgtEl) this._fxAshen(tgtEl);
    this._fxWhenPainted(sourceCard, (srcEl) => {
      srcEl.classList.add('fx-hellfire');
      setTimeout(() => srcEl.classList.remove('fx-hellfire'), 660);
    });
    this._screenShake('light');
  },

  // Joker fear-gas: sickly-green laughing-gas burst over the feared enemy.
  _fxFearGas(targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const el = this._fxCardElById(targetCard.id);
    if (el) this._fxGasBurst(el, { color: '#8bf24e' });
  },

  // Venom symbiote lash: a black tendril whips from Venom to the frozen target.
  _fxSymbioteLash(sourceCard, targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const to = this._fxCenter(this._fxCardElById(targetCard.id));
    if (!to) return;
    this._fxWhenPainted(sourceCard, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from) this._fxTendril(from, to, { color: '#0b0b0b', glow: '#d8d8d8', bow: 30 });
    });
    this._screenShake('light');
  },

  // Knull symbiote flood: black-and-red tendrils ripple from Knull to each
  // summoned card. Everything is placed THIS tick, so defer until painted.
  _fxSymbioteFlood(sourceCard, summonedCards) {
    if (this._reducedMotion() || !sourceCard || !summonedCards || !summonedCards.length) return;
    this._fxWhenPainted(sourceCard, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (!from) return;
      // A black symbiote mass wells up around Knull before it floods outward.
      this._fxGasBurst(srcEl, { color: '#0a0a0a' });
      this._fxRing(srcEl, { color: '#c1121f' });
      summonedCards.forEach((sc, i) => {
        setTimeout(() => {
          const tgtEl = this._fxCardElById(sc.id);
          const to = this._fxCenter(tgtEl);
          if (!to) return;
          this._fxTendril(from, to, { color: '#0a0a0a', glow: '#c1121f', bow: 26 });
          // The living symbiote seizes each host — a red burst as it takes hold.
          this._fxImpact(to, { color: '#ff2b4a', core: '#ffd0d8', size: 0.8 });
        }, i * 90);
      });
    });
    this._screenShake('medium');
  },

  // Doomsday rise: bone-spike shockwave + green revive flash on the reviver.
  _fxDoomsdayRise(card) {
    if (this._reducedMotion() || !card) return;
    this._fxWhenPainted(card, (el) => this._fxRevive(el));
  },
  // ---- Shared TRICK FX ------------------------------------------------------
  // Themeable helpers for the common trick shapes; each trick passes its own
  // colour (Kryptonite green, Power Stone purple). All take a card ref, so the
  // FX bridge relays them to the 1v1 guest (who never runs trick.play locally).
  _fxTrickStrike(card, color, glow) {
    if (this._reducedMotion() || !card) return;
    const el = this._fxCardElById(card.id);
    const c = this._fxCenter(el);
    if (!c) return;
    this._fxImpact(c, { color: glow || color || '#ff5a2e', core: '#fff0d0', size: 0.9 });
    this._fxSparks(c, { color: color || '#ffd27a', glow: glow || '#ff5a2e', count: 12, spread: 58, size: 2.6 });
    if (el) this._fxRing(el, { color: color || '#ff5a2e' });
  },
  // ══ SHADOW MAN'S WONDER WEAPONS AND MC BALLYHOO'S CANDIES ══════════════
  // One effect per card, each shaped to what that card actually does, so the
  // animation reads as the rule rather than as generic sparkle. All are _fx-
  // prefixed, which is what puts them on the 2v2 relay so every seat sees them
  // (see installFxBridge), and every one bails on reduced motion.

  // RAY GUN — a green plasma bolt in, splash either side, and the blast washing
  // BACK over your own card. The recoil is the card's whole identity, so it is
  // drawn as a return stroke rather than just another hit.
  _fxRayGun(targetCard, sideCards, ownCard) {
    if (this._reducedMotion() || !targetCard) return;
    // WAIT FOR THE CARD TO EXIST: looking the element up immediately returns
    // silently when the board has not painted yet (worse online, where render
    // timing is looser). Every card effect uses this helper.
    this._fxWhenPainted(targetCard, (tEl) => {
    const to = this._fxCenter(tEl);
    if (!to) return;
    this._fxDrawBolt({ x: to.x, y: to.y + 260 }, to, { color: '#7dff5a', glow: '#1f8f2f', thickness: 6 });
    this._fxImpact(to, { color: '#7dff5a', core: '#eaffe0', size: 1.15 });
    this._fxSparks(to, { color: '#b6ff9a', glow: '#1f8f2f', count: 16, spread: 70, size: 3 });
    if (tEl) this._fxRing(tEl, { color: '#7dff5a' });
    (sideCards || []).forEach((c, i) => {
      if (!c) return;
      setTimeout(() => {
        const el = this._fxCardElById(c.id), p = this._fxCenter(el);
        if (!p) return;
        this._fxImpact(p, { color: '#7dff5a', core: '#eaffe0', size: 0.7 });
        if (el) this._fxRing(el, { color: '#9dff7a' });
      }, 90 + i * 60);
    });
    if (ownCard) {
      setTimeout(() => {
        const el = this._fxCardElById(ownCard.id), p = this._fxCenter(el);
        if (!p) return;
        this._fxDrawBolt(to, p, { color: '#9dff7a', glow: '#1f8f2f', thickness: 4 });
        this._fxSparks(p, { color: '#d8ffcc', glow: '#1f8f2f', count: 9, spread: 44, size: 2.2 });
        if (el) this._fxRing(el, { color: '#9dff7a', contract: true });
      }, 200);
    }
    this._screenShake('medium');
    });
  },

  // THUNDERGUN — a wall of air. A wide beam along the direction of travel, a
  // wind ring on each card it is driven through, and a heavy hit where it lands.
  _fxThundergun(targetCard, pathCards, landCard) {
    if (this._reducedMotion() || !targetCard) return;
    this._fxWhenPainted(targetCard, (_srcEl) => {
    const from = this._fxCenter(_srcEl);
    if (!from) return;
    const endEl = landCard ? this._fxCardElById(landCard.id) : null;
    const end = endEl ? this._fxCenter(endEl) : { x: from.x + 260, y: from.y };
    this._fxDrawBeam(from, end, { color: '#eef3f8', core: '#ffffff', thickness: 9 });
    (pathCards || []).forEach((c, i) => {
      if (!c) return;
      setTimeout(() => {
        const el = this._fxCardElById(c.id), p = this._fxCenter(el);
        if (!p) return;
        if (el) this._fxRing(el, { color: '#eef3f8' });
        this._fxSparks(p, { color: '#ffffff', glow: '#9fb3c8', count: 10, spread: 52, size: 2.4 });
      }, 80 + i * 90);
    });
    if (landCard) {
      setTimeout(() => {
        const p = this._fxCenter(this._fxCardElById(landCard.id));
        if (!p) return;
        this._fxImpact(p, { color: '#ffffff', core: '#eef3f8', size: 1.3 });
        this._screenShake('heavy');
      }, 180);
    } else this._screenShake('medium');
    });
  },

  // LIGHTNING BOW — the Mark is a slow blue pulse that SITS on the card, so a
  // player can see which one the storm is coming for.
  _fxStormMark(card) {
    if (this._reducedMotion() || !card) return;
    this._fxWhenPainted(card, (el) => {
    if (!el) return;
    this._fxRing(el, { color: '#3fa9ff' });
    el.classList.remove('fx-storm-mark'); void el.offsetWidth; el.classList.add('fx-storm-mark');
    setTimeout(() => el.classList.remove('fx-storm-mark'), 4200);
    const c = this._fxCenter(el);
    if (c) this._fxSparks(c, { color: '#9be0ff', glow: '#3fa9ff', count: 8, angle: -Math.PI / 2, cone: 1.2, spread: 40, size: 2.2 });
    });
  },
  // …and the strike itself comes DOWN from above, growing with each jump the
  // way the damage does.
  _fxStormStrike(card, jump) {
    if (this._reducedMotion() || !card) return;
    this._fxWhenPainted(card, (el) => {
    const p = this._fxCenter(el);
    if (!p) return;
    const n = (jump | 0);
    setTimeout(() => {
      this._fxDrawBolt({ x: p.x, y: p.y - 320 }, p, { color: '#9be0ff', glow: '#3fa9ff', thickness: 5 + n * 2 });
      this._fxImpact(p, { color: '#3fa9ff', core: '#eaf6ff', size: 0.9 + n * 0.25 });
      this._fxSparks(p, { color: '#cfeaff', glow: '#3fa9ff', count: 12 + n * 4, spread: 60 + n * 12, size: 2.6 });
      if (el) this._fxRing(el, { color: '#3fa9ff' });
      this._screenShake(n === 0 ? 'medium' : 'heavy');
    }, n * 160);
    });
  },

  // WUNDERWAFFE — the current runs the LINE, card to card, and then earths
  // itself past the last one into the enemy. The grounding stroke is what makes
  // the face damage legible.
  _fxGroundCurrent(cards) {
    if (this._reducedMotion() || !cards || !cards.length) return;
    const pts = cards.map(c => this._fxCenter(this._fxCardElById(c.id))).filter(Boolean);
    if (!pts.length) return;
    pts.forEach((p, i) => {
      setTimeout(() => {
        if (i > 0) this._fxDrawBolt(pts[i - 1], p, { color: '#d8ff7a', glow: '#7ad8ff', thickness: 4 });
        this._fxImpact(p, { color: '#d8ff7a', core: '#ffffff', size: 0.7 });
        this._fxSparks(p, { color: '#eaffb0', glow: '#7ad8ff', count: 8, spread: 46, size: 2.2 });
      }, i * 110);
    });
    const last = pts[pts.length - 1];
    setTimeout(() => {
      this._fxDrawBolt(last, { x: last.x, y: last.y - 300 }, { color: '#7ad8ff', glow: '#d8ff7a', thickness: 8 });
      this._fxImpact({ x: last.x, y: last.y - 260 }, { color: '#7ad8ff', core: '#ffffff', size: 1.4 });
      this._screenShake('heavy');
    }, pts.length * 110 + 90);
  },

  // APOTHICON SERVANT — a hole, not a hit. Everything contracts inward.
  _fxRiftTear(laneIdx, side) {
    if (this._reducedMotion()) return;
    const lane = document.querySelector('.lane[data-lane="' + laneIdx + '"]')
      || document.querySelectorAll('.lane')[laneIdx];
    if (!lane) return;
    const c = this._fxCenter(lane);
    if (!c) return;
    this._fxRing(lane, { color: '#8e44d0', contract: true });
    setTimeout(() => this._fxRing(lane, { color: '#c07bff', contract: true }), 120);
    setTimeout(() => this._fxRing(lane, { color: '#5a1f8f', contract: true }), 240);
    this._fxSparks(c, { color: '#c07bff', glow: '#5a1f8f', count: 18, spread: 74, size: 3 });
    this._fxImplode(lane, { color: '#8e44d0' });
    this._screenShake('medium');
  },

  // ── MC BALLYHOO'S CANDIES ────────────────────────────────────────────────
  // TWICE — the card is briefly doubled: two rings out of one centre.
  _fxCandyTwice(card) {
    if (this._reducedMotion() || !card) return;
    this._fxWhenPainted(card, (el) => {
    const c = this._fxCenter(el);
    if (!c) return;
    this._fxRing(el, { color: '#ffd23f' });
    setTimeout(() => this._fxRing(el, { color: '#fff2a8' }), 150);
    this._fxSparks(c, { color: '#fff2a8', glow: '#ffb300', count: 14, angle: -Math.PI / 2, cone: 2.2, spread: 58, size: 2.8 });
    this._fxImpact(c, { color: '#ffd23f', core: '#fffbe6', size: 0.8 });
    });
  },
  // CASHZAP — energy pulled UP and away from everyone else.
  _fxCandyCash(card) {
    if (this._reducedMotion()) return;
    const el = card ? this._fxCardElById(card.id) : null;
    const c = el ? this._fxCenter(el) : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    if (!c) return;
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this._fxSparks(c, {
        color: '#ffc046', glow: '#ff8a00', count: 10, angle: -Math.PI / 2, cone: 0.9, spread: 90, size: 3.2
      }), i * 110);
    }
    this._fxImpact(c, { color: '#ff8a00', core: '#ffe9c0', size: 0.9 });
  },
  // VAMPIRE — a red draw from THEM to YOU, so the direction of the theft shows.
  _fxCandyVampire() {
    if (this._reducedMotion()) return;
    const w = window.innerWidth, h = window.innerHeight;
    const from = { x: w / 2, y: h * 0.22 }, to = { x: w / 2, y: h * 0.78 };
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this._fxDrawBeam(
        { x: from.x + (i - 1) * 46, y: from.y }, { x: to.x + (i - 1) * 26, y: to.y },
        { color: '#c1121f', core: '#ff8a94', thickness: 5 }), i * 90);
    }
    this._fxImpact(to, { color: '#ff2d4a', core: '#ffd0d6', size: 1.2 });
    this._fxSparks(to, { color: '#ff8a94', glow: '#c1121f', count: 16, spread: 66, size: 2.8 });
    this._screenShake('medium');
  },
  // BLOWAY — a gust that throws the card sideways out of frame.
  _fxCandyBloway(card) {
    if (this._reducedMotion() || !card) return;
    this._fxWhenPainted(card, (el) => {
    const c = this._fxCenter(el);
    if (!c) return;
    this._fxDrawBeam({ x: c.x - 240, y: c.y }, { x: c.x + 240, y: c.y }, { color: '#dff3ff', core: '#ffffff', thickness: 7 });
    this._fxSparks(c, { color: '#ffffff', glow: '#8fd0ff', count: 14, angle: 0, cone: 0.8, spread: 96, size: 2.6 });
    if (el) {
      el.classList.remove('fx-blown'); void el.offsetWidth; el.classList.add('fx-blown');
      setTimeout(() => el.classList.remove('fx-blown'), 520);
    }
    this._screenShake('light');
    });
  },

  _fxTrickBuff(card, color, glow) {
    if (this._reducedMotion() || !card) return;
    const el = this._fxCardElById(card.id);
    if (!el) return;
    el.style.setProperty('--tfx', glow || color || '#3ad17e');
    this._fxRing(el, { color: color || '#3ad17e' });
    el.classList.remove('fx-trick-buff'); void el.offsetWidth; el.classList.add('fx-trick-buff');
    setTimeout(() => el.classList.remove('fx-trick-buff'), 640);
    const c = this._fxCenter(el);
    if (c) this._fxSparks(c, { color: color || '#b8ffd9', glow: glow || '#2fbf4f', count: 10, angle: -Math.PI / 2, cone: 1.9, spread: 52, size: 2.6 });
  },
  _fxTrickDebuff(card, color, glow) {
    if (this._reducedMotion() || !card) return;
    const el = this._fxCardElById(card.id);
    if (!el) return;
    el.style.setProperty('--tfx', glow || color || '#c0392b');
    this._fxRing(el, { color: color || '#c0392b', contract: true });
    el.classList.remove('fx-trick-debuff'); void el.offsetWidth; el.classList.add('fx-trick-debuff');
    setTimeout(() => el.classList.remove('fx-trick-debuff'), 640);
    const c = this._fxCenter(el);
    if (c) this._fxSparks(c, { color: color || '#ff9a8a', glow: glow || '#a01a0a', count: 9, angle: Math.PI / 2, cone: 1.4, spread: 44, size: 2.4 });
  },
  _fxTrickBurst(card, color, glow) {
    if (this._reducedMotion() || !card) return;
    const el = this._fxCardElById(card.id);
    if (!el) return;
    if (this._fxImplode) this._fxImplode(el, { color: color || '#8a5bff' });
    this._fxRing(el, { color: color || '#8a5bff', contract: true });
    const c = this._fxCenter(el);
    if (c) this._fxSparks(c, { color: glow || '#d0b0ff', glow: color || '#8a5bff', count: 12, spread: 70, size: 2.8 });
  },
  // Open Water — a wall of water erupts as Jaws surfaces. Fired on the Jaws
  // card the instant it's summoned, alongside the jumpscare.
  _fxWaterSurge(card) {
    if (this._reducedMotion() || !card) return;
    this._fxWhenPainted(card, (el) => {
      const c = this._fxCenter(el);
      this._fxRing(el, { color: '#4fc8ff' });
      el.classList.remove('fx-water-surge'); void el.offsetWidth; el.classList.add('fx-water-surge');
      setTimeout(() => el.classList.remove('fx-water-surge'), 760);
      if (c) this._fxSparks(c, { color: '#dff4ff', glow: '#2f9fe0', count: 16, angle: -Math.PI / 2, cone: 2.0, spread: 70, size: 2.8 });
    });
  },
  // Gargantua — a gravity well: an accretion vortex contracts over the
  // environment and motes spiral inward as it drags the enemy line closer.
  _fxGargantuaPull(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      const c = this._fxCenter(el);
      if (!c) return;
      const layer = this._fxLayer();
      this._fxRing(el, { color: '#f0b45a', contract: true });
      this._fxRing(el, { color: '#8fbfff', contract: true });
      for (let i = 0; i < 18; i++) {
        const p = document.createElement('div');
        p.className = 'fx-gargantua-mote';
        const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 70;
        p.style.cssText = 'left:' + c.x.toFixed(0) + 'px;top:' + c.y.toFixed(0) + 'px;'
          + '--gx:' + (Math.cos(a) * d).toFixed(0) + 'px;--gy:' + (Math.sin(a) * d).toFixed(0) + 'px;'
          + '--gr:' + ((Math.random() * 2 - 1) * 120).toFixed(0) + 'deg;animation-delay:' + (Math.random() * 140).toFixed(0) + 'ms;';
        layer.appendChild(p);
        setTimeout(() => p.remove(), 820);
      }
      setTimeout(() => this._fxImpact(c, { color: '#ffd98a', core: '#fff6e0', size: 1.0 }), 260);
    });
  },
  // The Bathroom — a reverse bear-trap clamp: iron chains snap around the victim
  // in a rusty jolt as it's locked to the lane.
  _fxBathroomChain(victimCard) {
    if (this._reducedMotion() || !victimCard) return;
    const el = this._fxCardElById(victimCard.id);
    if (!el) return;
    this._fxRing(el, { color: '#9aa4ad' });
    el.classList.remove('fx-bathroom-chain'); void el.offsetWidth; el.classList.add('fx-bathroom-chain');
    setTimeout(() => el.classList.remove('fx-bathroom-chain'), 720);
    const c = this._fxCenter(el);
    if (c) this._fxSparks(c, { color: '#c8ccd0', glow: '#5a6068', count: 10, spread: 48, size: 2.4 });
  },
  // Doomsday — the entrance: he slams down in a burst of rock and bone-shards
  // with a dust shockwave and a heavy quake. Distinct from his revive (Rise).
  _fxDoomsdayEntrance(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      el.classList.remove('fx-doomsday-slam'); void el.offsetWidth; el.classList.add('fx-doomsday-slam');
      setTimeout(() => el.classList.remove('fx-doomsday-slam'), 720);
      this._fxRing(el, { color: '#b8a06a' });
      const c = this._fxCenter(el);
      if (c) {
        this._fxImpact(c, { color: '#9a8752', core: '#e8dcc0', size: 1.4 });
        this._fxSparks(c, { color: '#d8c89a', glow: '#6a5a34', count: 18, spread: 84, size: 3.2 });
      }
      this._screenShake('heavy');
    });
  },

  // ====================== FREEZE FX ======================
  // Fired from Game.freezeCard the instant a freeze LANDS. A burst of frost
  // radiates over the card, a quick blue flash, and the card shudders as it
  // ices over. The PERSISTENT ice sheet is the .card-frost overlay makeCardEl
  // injects while isFrozen; this is only the one-shot "it just froze" beat.
  // One-shot, reduced-motion / low-fx gated, self-removing.
  _fxFreezeStrike(card) {
    if (!card || this._reducedMotion()) return;
    this._fxWhenPainted(card, (el) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r || r.width === 0) return;
      const layer = this._fxLayer();
      const burst = document.createElement('div');
      burst.className = 'fx-freeze-burst';
      burst.style.cssText =
        'left:' + (r.left + r.width / 2) + 'px;top:' + (r.top + r.height / 2) + 'px;' +
        'width:' + r.width + 'px;height:' + r.height + 'px;';
      layer.appendChild(burst);
      setTimeout(() => burst.remove(), 760);
      // Brief shudder on the card itself.
      el.classList.remove('card-freeze-shudder');
      void el.offsetWidth;
      el.classList.add('card-freeze-shudder');
      setTimeout(() => el.classList.remove('card-freeze-shudder'), 520);
    });
  },
  // Fired when a card THAWS (frozenTurns hits 0). The ice cracks and shatters
  // off in shards. Target-anchored, one-shot, gated, self-removing.
  _fxThaw(card) {
    if (!card || this._reducedMotion()) return;
    const el = this._fxCardElById(card.id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const layer = this._fxLayer();
    const shatter = document.createElement('div');
    shatter.className = 'fx-thaw-shatter';
    shatter.style.cssText =
      'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;';
    // A handful of ice shards flung outward.
    let shards = '';
    for (let i = 0; i < 7; i++) {
      const ang = (Math.PI * 2 * i) / 7 + (Math.random() - 0.5) * 0.5;
      const dist = 26 + Math.random() * 26;
      shards += '<i style="--sx:' + (Math.cos(ang) * dist).toFixed(1) + 'px;--sy:' +
        (Math.sin(ang) * dist).toFixed(1) + 'px;--sr:' + ((Math.random() - 0.5) * 220).toFixed(0) +
        'deg;--sd:' + (i * 18) + 'ms"></i>';
    }
    shatter.innerHTML = shards;
    layer.appendChild(shatter);
    setTimeout(() => shatter.remove(), 620);
  },
  // Fired from Boiler Room._markBurning the instant a card catches fire. A
  // burst of flame licks up over the card and it flinches from the heat. The
  // PERSISTENT ember/heat layer is the .card-burn overlay makeCardEl injects
  // while isBurning; this is only the one-shot "it just ignited" beat.
  // One-shot, reduced-motion / low-fx gated, self-removing.
  _fxBurnIgnite(card) {
    if (!card || this._reducedMotion()) return;
    this._fxWhenPainted(card, (el) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r || r.width === 0) return;
      const layer = this._fxLayer();
      const flare = document.createElement('div');
      flare.className = 'fx-burn-ignite';
      flare.style.cssText =
        'left:' + (r.left + r.width / 2) + 'px;top:' + (r.top + r.height / 2) + 'px;' +
        'width:' + r.width + 'px;height:' + r.height + 'px;';
      // A spray of sparks flung upward from the ignition.
      let sparks = '';
      for (let i = 0; i < 9; i++) {
        const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;   // fan upward
        const dist = 24 + Math.random() * 34;
        sparks += '<i style="--sx:' + (Math.cos(ang) * dist).toFixed(1) + 'px;--sy:' +
          (Math.sin(ang) * dist).toFixed(1) + 'px;--sd:' + (i * 14) + 'ms"></i>';
      }
      flare.innerHTML = sparks;
      layer.appendChild(flare);
      setTimeout(() => flare.remove(), 760);
      // A quick heat flinch on the card itself.
      el.classList.remove('card-burn-flinch');
      void el.offsetWidth;
      el.classList.add('card-burn-flinch');
      setTimeout(() => el.classList.remove('card-burn-flinch'), 520);
    });
  },
  // Fired from applyCombatDamage when a swing is EVADED. The card sidesteps —
  // it blurs sideways and snaps back — while a translucent after-image is left
  // behind at its original spot and fades. One-shot, reduced-motion / low-fx
  // gated, self-removing.
  _fxEvadeDodge(card) {
    if (!card || this._reducedMotion()) return;
    const el = this._fxCardElById(card.id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r || r.width === 0) return;
    // Sidestep AWAY from centre, toward open space.
    const dir = (r.left + r.width / 2) < (window.innerWidth / 2) ? -1 : 1;
    const dx = dir * Math.max(30, r.width * 0.55);
    const layer = this._fxLayer();
    // The GHOST carries the whole dodge: a glowing after-image of the card that
    // slides sideways and fades. It lives on the FX layer so it survives the
    // render combat fires right after (a class on the card element would be
    // wiped a frame later). The card art is copied onto the ghost.
    const ghost = document.createElement('div');
    ghost.className = 'fx-evade-afterimage';
    ghost.style.cssText =
      'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;' +
      '--evade-dx:' + dx.toFixed(1) + 'px;';
    const portrait = el.querySelector('.card-portrait');
    if (portrait) {
      const bg = getComputedStyle(portrait).backgroundImage;
      if (bg && bg !== 'none') {
        ghost.style.backgroundImage = bg;
        ghost.style.backgroundSize = 'cover';
        ghost.style.backgroundPosition = 'center';
      }
    }
    layer.appendChild(ghost);
    setTimeout(() => ghost.remove(), 480);
    // Nudge the real card too, in case it isn't re-rendered this beat.
    el.style.setProperty('--evade-dx', dx.toFixed(1) + 'px');
    el.classList.remove('card-evade-dodge');
    void el.offsetWidth;
    el.classList.add('card-evade-dodge');
    setTimeout(() => { el.classList.remove('card-evade-dodge'); el.style.removeProperty('--evade-dx'); }, 480);
  },

  // ====================== WAVE 3 (cost-8+ titans) ======================
  // More reusable primitives + the per-titan wrappers. Same rules: one-shot,
  // reduced-motion-gated, battery-safe, tab-hidden-paused, guarded callers.

  // Lightsaber slash across the target card — a bright diagonal blade sweep +
  // spark. Target-anchored (the target is a pre-existing enemy, painted). When
  // a source is given, a thin blade-line is also drawn from the caster once he
  // paints, so it reads as coming from the Jedi.
  // Draw ONE lightsaber slash over a given ELEMENT (blade/core color + angle
  // in deg via opts). Extracted so self-cast flourishes and the Grievous
  // flurry can reuse it without a card-id lookup.
  _fxSlashEl(el, opts) {
    if (!el) return;
    opts = opts || {};
    const r = el.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const layer = this._fxLayer();
    const slash = document.createElement('div');
    slash.className = 'sig-saber';
    slash.style.cssText = 'left:' + (r.left + r.width / 2) + 'px;top:' + (r.top + r.height / 2) + 'px;' +
      'width:' + (r.width * 1.7) + 'px;--sig-blade:' + (opts.blade || '#3aa0ff') + ';--sig-core:' + (opts.core || '#eaf4ff') +
      ';--sig-ang:' + (opts.angle != null ? opts.angle : -38) + 'deg;';
    layer.appendChild(slash);
    setTimeout(() => slash.remove(), 460);
  },
  _fxSaberSlash(sourceCard, targetCard, opts) {
    if (this._reducedMotion() || !targetCard) return;
    opts = opts || {};
    const tgtEl = this._fxCardElById(targetCard.id);
    if (!tgtEl) return;
    this._fxSlashEl(tgtEl, opts);
    const to = this._fxCenter(tgtEl);
    if (sourceCard && to) {
      this._fxWhenPainted(sourceCard, (srcEl) => {
        const from = this._fxCenter(srcEl);
        if (from) this._fxDrawBeam(from, to, { color: opts.blade || '#3aa0ff', core: opts.core || '#eaf4ff', thickness: opts.thickness || 4 });
      });
    }
    // A small flash + spark scatter where the blade bites.
    if (to) {
      this._fxImpact(to, { color: opts.blade || '#3aa0ff', core: opts.core || '#eaf4ff', size: 0.85 });
      this._fxSparks(to, { color: opts.core || '#eaf4ff', glow: opts.blade || '#3aa0ff', count: 9, spread: 56, size: 2.4 });
    }
    this._screenShake('light');
  },

  // Spinning projectile that flies from caster to target (Batman batarang).
  _fxProjectile(sourceCard, targetCard, opts) {
    if (this._reducedMotion() || !targetCard) return;
    opts = opts || {};
    const to = this._fxCenter(this._fxCardElById(targetCard.id));
    if (!to) return;
    this._fxWhenPainted(sourceCard, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (!from) return;
      const layer = this._fxLayer();
      const proj = document.createElement('div');
      proj.className = 'sig-projectile';
      proj.style.cssText = 'left:' + from.x + 'px;top:' + from.y + 'px;' +
        '--sig-dx:' + (to.x - from.x) + 'px;--sig-dy:' + (to.y - from.y) + 'px;--sig-c:' + (opts.color || '#c9d1d9') + ';';
      layer.appendChild(proj);
      const spark = document.createElement('div');
      spark.className = 'sig-proj-spark';
      spark.style.cssText = 'left:' + to.x + 'px;top:' + to.y + 'px;--sig-c:' + (opts.color || '#c9d1d9') + ';';
      layer.appendChild(spark);
      // Spark = 300ms anim + 260ms delay = 560ms; clean up after it fully fades.
      setTimeout(() => { proj.remove(); spark.remove(); }, 580);
    });
  },

  // Upward hellfire column + flicker over a card (Trigon).
  _fxFlameColumn(el) {
    if (!el || this._reducedMotion()) return;
    const r = el.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const layer = this._fxLayer();
    const fh = r.height * 1.25;
    const flame = document.createElement('div');
    flame.className = 'sig-flame';
    // Anchor the flame's BOTTOM at the card's base so it erupts UPWARD over
    // the card (transform-origin:bottom center + scaleY grow), rather than
    // rendering entirely in the row below it.
    flame.style.cssText = 'left:' + (r.left + r.width / 2) + 'px;top:' + (r.top + r.height - fh) + 'px;' +
      'width:' + (r.width * 0.92) + 'px;height:' + fh + 'px;';
    layer.appendChild(flame);
    setTimeout(() => flame.remove(), 740);
  },

  // Expanding — or contracting (opts.contract) — ring over a card.
  _fxRing(el, opts) {
    if (!el || this._reducedMotion()) return;
    opts = opts || {};
    const c = this._fxCenter(el);
    if (!c) return;
    const layer = this._fxLayer();
    const ring = document.createElement('div');
    ring.className = 'sig-ring' + (opts.contract ? ' sig-ring-contract' : '');
    ring.style.cssText = 'left:' + c.x + 'px;top:' + c.y + 'px;--sig-c:' + (opts.color || '#c1121f') + ';';
    layer.appendChild(ring);
    setTimeout(() => ring.remove(), 540);
  },

  // ---- Wave 3 named per-card entry points ----

  // Thor: Mjolnir sky-lightning hammers down on a struck enemy (seq staggers a volley).
  _fxThorStrike(targetCard, seq) {
    if (this._reducedMotion() || !targetCard) return;
    // Capture the target's position NOW — the caller deals (often lethal)
    // thunder synchronously right after, so a deferred DOM lookup would miss
    // any enemy the strike kills (its element is swept by the next render).
    // seq is a COMPACTED strike ordinal (0,1,2 among STRUCK enemies), so
    // seq 0 both starts the stagger and fires the single volley shake.
    const to = this._fxCenter(this._fxCardElById(targetCard.id));
    if (!to) return;
    const s = seq | 0;
    setTimeout(() => {
      this._fxDrawBolt(null, to, { color: '#cfeaff', glow: '#4aa3ff' });
      // A hammer-blow flash + a splash of embers on top of the bolt's own hit.
      this._fxImpact(to, { color: '#9bd4ff', core: '#ffffff', size: 1.15 });
      this._fxSparks(to, { color: '#eaf6ff', glow: '#4aa3ff', count: 10, spread: 66, size: 2.8 });
      if (s === 0) this._screenShake('medium');
    }, s * 70);
  },

  // Darth Vader: crimson Force-choke — a grip line from Vader + a red ring
  // constricting the target.
  _fxForceChoke(sourceCard, targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const tgtEl = this._fxCardElById(targetCard.id);
    const to = this._fxCenter(tgtEl);
    if (tgtEl) this._fxRing(tgtEl, { color: '#ff2d2d', contract: true });
    if (to) this._fxWhenPainted(sourceCard, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from) this._fxTendril(from, to, { color: '#c1121f', glow: '#ff2d2d', bow: 18 });
    });
    // The grip crushes — a dark-red choke burst as it seizes the throat.
    if (to) this._fxSparks(to, { color: '#ff6a6a', glow: '#c1121f', count: 8, spread: 46, size: 2.3 });
    this._screenShake('light');
  },

  // Darth Vader: hurls his crimson lightsaber — the blade spins out to the
  // struck enemy, flares on impact (slash + sparks), then boomerangs back to
  // his hand. Fired at the start of the 7-damage chain (the 'throw' beat).
  _fxSaberThrow(sourceCard, targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const tgtEl = this._fxCardElById(targetCard.id);
    const to = this._fxCenter(tgtEl);
    if (!to) return;
    // Vader may have just been played this render — wait for his card to paint
    // so the throw launches from his actual board slot, not a stale rect.
    this._fxWhenPainted(sourceCard, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (!from) return;
      const layer = this._fxLayer();
      const dx = to.x - from.x, dy = to.y - from.y;
      // The lead blade + two lagging afterimages. Each trail runs the SAME
      // flight animation but starts a hair later (animation-delay) so it sits
      // BEHIND the leader on the path — a crimson motion-trail that follows on
      // the way out and the boomerang back. Fainter + set behind via z-order.
      const nodes = [];
      const mk = (cls, delayMs, opacity) => {
        const el = document.createElement('div');
        el.className = 'sig-saber-throw' + (cls ? ' ' + cls : '');
        el.style.cssText =
          'left:' + from.x + 'px;top:' + from.y + 'px;' +
          '--sig-dx:' + dx + 'px;--sig-dy:' + dy + 'px;' +
          (delayMs ? 'animation-delay:' + delayMs + 'ms;' : '') +
          (opacity != null ? '--sig-trail-op:' + opacity + ';' : '');
        layer.appendChild(el);
        nodes.push(el);
      };
      mk('sig-saber-ghost', 78, 0.28);   // farthest, faintest trail
      mk('sig-saber-ghost', 40, 0.5);    // mid trail
      mk('', 0, 1);                      // lead blade (drawn last = on top)
      // Impact timed to the lead blade's outbound arrival (~47% of the flight).
      setTimeout(() => {
        this._fxSlashEl(tgtEl, { blade: '#ff2d2d', core: '#ffd0d0', angle: -34 });
        // Debris KICK — heavy chips spat out the FAR side along the blade's
        // travel line (angle = incoming direction), plus a tighter hot burst.
        const travelAng = Math.atan2(dy, dx);
        this._fxSparks(to, { count: 9, color: '#ffcaa0', glow: '#ff7a3a', spread: 82, size: 4, angle: travelAng, cone: 1.1 });
        this._fxSparks(to, { count: 12, color: '#ff5a4a', glow: '#ff2d2d', spread: 60 });
        this._fxImpact(to, { color: '#ff8a7a', core: '#ffffff', size: 1.1 });
        this._screenShake('light');
      }, 356);
      // Full flight = out + boomerang back + fade (lead + longest trail delay).
      setTimeout(() => nodes.forEach(n => n.remove()), 900);
    });
  },

  // Yoda: serene green Force channel binding the two chosen allies. Either
  // endpoint may be freshly-played Yoda, so re-query both past render's rAF.
  _fxForceChannel(a1, a2) {
    if (this._reducedMotion() || !a1 || !a2) return;
    const draw = () => {
      const e1 = this._fxCardElById(a1.id), e2 = this._fxCardElById(a2.id);
      const p1 = this._fxCenter(e1), p2 = this._fxCenter(e2);
      if (p1 && p2) {
        this._fxTendril(p1, p2, { color: '#7bf27a', glow: '#8bf24e', bow: 12 });
        // A serene green pulse blooms on each bound ally + a soft spark drift.
        if (e1) this._fxRing(e1, { color: '#7bf27a' });
        if (e2) this._fxRing(e2, { color: '#7bf27a' });
        this._fxSparks(p1, { color: '#c8ffca', glow: '#8bf24e', count: 8, spread: 50, size: 2.2 });
        this._fxSparks(p2, { color: '#c8ffca', glow: '#8bf24e', count: 8, spread: 50, size: 2.2 });
        return true;
      }
      return false;
    };
    if (draw()) return;
    const raf = (typeof window !== 'undefined' && window.requestAnimationFrame) ? window.requestAnimationFrame.bind(window) : (f) => setTimeout(f, 16);
    raf(() => raf(() => { draw(); }));
  },

  // Batman: a spinning batarang cracks into a struck enemy — steel flash +
  // debris + a light jolt as it lands.
  _fxBatarang(sourceCard, targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    this._fxProjectile(sourceCard, targetCard, { color: '#e8edf2' });
    const to = this._fxCenter(this._fxCardElById(targetCard.id));
    if (!to) return;
    // Crack on impact — timed to the batarang's arrival (~300ms flight).
    setTimeout(() => {
      this._fxImpact(to, { color: '#dfe7ef', core: '#ffffff', size: 0.85 });
      this._fxSparks(to, { count: 9, color: '#eef3f8', glow: '#aab6c4', spread: 58, size: 2.6 });
      this._screenShake('light');
    }, 300);
  },
  // Batman: a swirling shadow-bat swarm engulfs the feared enemy — dark gas,
  // a constricting ring, and a scatter of bat-black motes.
  _fxFearBats(targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const el = this._fxCardElById(targetCard.id);
    if (!el) return;
    this._fxGasBurst(el, { color: '#3a3350' });
    this._fxRing(el, { color: '#6b5b95', contract: true });
    const c = this._fxCenter(el);
    if (c) this._fxSparks(c, { count: 14, color: '#2b2438', glow: '#6b5b95', spread: 74, size: 3 });
  },

  // Anakin: a heavy dark-side saber power-strike — a beam lunges in, a
  // cross-slash rends the target, and debris kicks out along the strike line.
  _fxSaberStrike(sourceCard, targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const tgtEl = this._fxCardElById(targetCard.id);
    const to = this._fxCenter(tgtEl);
    if (!to) return;
    // Cross-slash — two blades scissor across the target.
    this._fxSlashEl(tgtEl, { blade: '#2b8cff', core: '#eaf4ff', angle: -40 });
    setTimeout(() => this._fxSlashEl(tgtEl, { blade: '#2b8cff', core: '#eaf4ff', angle: 38 }), 90);
    this._fxWhenPainted(sourceCard, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (!from) return;
      this._fxDrawBeam(from, to, { color: '#2b8cff', core: '#eaf4ff', thickness: 7 });
      // Debris kicked out the far side along the strike direction.
      const ang = Math.atan2(to.y - from.y, to.x - from.x);
      this._fxSparks(to, { count: 12, color: '#cfe4ff', glow: '#2b8cff', spread: 82, size: 3.2, angle: ang, cone: 1.1 });
    });
    this._fxImpact(to, { color: '#8fc4ff', core: '#ffffff', size: 1.2 });
    this._screenShake('medium');
  },

  // Apocalypse: celestial-tech transmutation surge over your visible hand.
  _fxCelestialSurge(owner) {
    if (this._reducedMotion()) return;
    if (owner && owner !== 'player') return;   // only the local human's face-up hand
    const hand = document.querySelector('.player-hand-section');
    if (!hand) return;
    const r = hand.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const layer = this._fxLayer();
    const surge = document.createElement('div');
    surge.className = 'sig-celestial';
    surge.style.cssText = 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;';
    layer.appendChild(surge);
    setTimeout(() => surge.remove(), 780);
    // Empower each hand card in turn — a purple-gold keyword-charge flare rolls
    // down the hand so you SEE every card getting a new keyword.
    const cards = hand.querySelectorAll('.card');
    cards.forEach((cardEl, i) => {
      setTimeout(() => {
        cardEl.classList.remove('fx-empower-pulse'); void cardEl.offsetWidth; cardEl.classList.add('fx-empower-pulse');
        setTimeout(() => cardEl.classList.remove('fx-empower-pulse'), 620);
        const c = this._fxCenter(cardEl);
        if (c) this._fxSparks(c, { color: '#e9c6ff', glow: '#a24bff', count: 6, angle: -Math.PI / 2, cone: 1.6, spread: 40, size: 2.2 });
      }, 100 + i * 75);
    });
  },

  // Colored HAZE that rolls over a whole hand for in-hand effects — a tinted
  // veil fades in over the hand, and a per-card puff sweeps down the row so you
  // SEE every card get touched. `owner` picks the hand (player = face-up hand
  // at the bottom, ai = the face-down backs up top). opts.color tints it:
  // Apocalypse empowers your hand (blue), Mace Windu curses the enemy's (purple).
  // HAND FX NEED THEIR OWN LAYER. #signature-fx-layer is z-index 200, but the
  // hand sits at z-index 220 (300 on mobile), so the cast layer paints BEHIND
  // the cards. The child's own z-index can't rescue it: the fx layer is its
  // stacking context. This layer sits above the hand and below the emote/taunt
  // popups (900+).
  _fxHandLayer() {
    let l = document.getElementById('hand-fx-layer');
    if (!l) {
      l = document.createElement('div');
      l.id = 'hand-fx-layer';
      document.body.appendChild(l);
    }
    return l;
  },
  _fxHandHaze(owner, opts) {
    if (this._reducedMotion()) return;
    opts = opts || {};
    const color = opts.color || '#a24bff';
    const isPlayer = owner === 'player';
    const hand = isPlayer ? document.querySelector('.player-hand-section') : document.getElementById('ai-hand');
    if (!hand) return;
    const r = hand.getBoundingClientRect();
    if (!r || r.width === 0) return;
    // The OPPONENT's hand renders as a small face-down strip, so a haze alone
    // is too subtle to read — add a burst over it so the curse is unmissable.
    if (!isPlayer) {
      const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      this._fxImpact(c, { color: color, core: '#ffffff', size: 1.1 });
      this._fxSparks(c, { count: 14, color: '#ffffff', glow: color, spread: 78, size: 2.8 });
    }
    const layer = this._fxHandLayer();
    const haze = document.createElement('div');
    haze.className = 'sig-hand-haze';
    haze.style.cssText = 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;--sig-c:' + color + ';';
    layer.appendChild(haze);
    setTimeout(() => haze.remove(), 900);
    // Per-card puff, staggered so the haze visibly rolls across the hand.
    const cards = isPlayer ? hand.querySelectorAll('.card') : hand.querySelectorAll('.card-back');
    cards.forEach((cardEl, i) => {
      setTimeout(() => {
        const cr = cardEl.getBoundingClientRect();
        if (!cr || cr.width === 0) return;
        const puff = document.createElement('div');
        puff.className = 'sig-card-haze';
        puff.style.cssText = 'left:' + cr.left + 'px;top:' + cr.top + 'px;width:' + cr.width + 'px;height:' + cr.height + 'px;--sig-c:' + color + ';';
        layer.appendChild(puff);
        setTimeout(() => puff.remove(), 700);
      }, 80 + i * 70);
    });
  },

  // Flare a SINGLE card in a hand so you can see exactly which one an in-hand
  // effect touched — Red Skull's gold empower, Freddy's red slash. Resolves the
  // player's card by data-card-id (face-up) and the AI's by hand index (its
  // face-down backs carry no id). A colored puff + ring + impact + a pulse land
  // right on that card. opts: color, core.
  _fxHandCardFlare(owner, cardId, handIdx, opts) {
    if (this._reducedMotion()) return;
    opts = opts || {};
    const color = opts.color || '#ffcc33';
    const isPlayer = owner === 'player';
    let el = null;
    if (isPlayer) {
      el = (cardId != null) ? document.querySelector('.player-hand-section .card[data-card-id="' + cardId + '"]') : null;
    } else {
      const backs = document.querySelectorAll('#ai-hand .card-back');
      el = (handIdx >= 0 && backs[handIdx]) ? backs[handIdx] : null;
    }
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r || r.width === 0) return;
    // Hand layer, not the cast layer — see _fxHandLayer: the cast layer sits
    // UNDER the hand, so a flare drawn there is hidden by the card it marks.
    const layer = this._fxHandLayer();
    const puff = document.createElement('div');
    puff.className = 'sig-card-haze';
    puff.style.cssText = 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;--sig-c:' + color + ';';
    layer.appendChild(puff);
    setTimeout(() => puff.remove(), 700);
    const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    this._fxImpact(c, { color: color, core: opts.core || '#ffffff', size: 1.0 });
    this._fxSparks(c, { color: opts.core || '#ffffff', glow: color, count: 12, spread: 62, size: 2.6 });
    el.classList.remove('fx-empower-pulse'); void el.offsetWidth; el.classList.add('fx-empower-pulse');
    setTimeout(() => el.classList.remove('fx-empower-pulse'), 620);
  },

  // Dr. Manhattan: a cold quantum stream flows into the hero HP orb.
  _fxManhattan(sourceCard, owner) {
    if (this._reducedMotion()) return;
    const orb = document.getElementById(owner === 'player' ? 'player-hp-fill' : 'ai-hp-fill')
             || document.getElementById(owner === 'player' ? 'player-health' : 'ai-health');
    if (!orb) return;
    const orbR = orb.getBoundingClientRect();
    if (!orbR || orbR.width === 0) return;
    const to = { x: orbR.left + orbR.width / 2, y: orbR.top + orbR.height / 2 };
    this._fxWhenPainted(sourceCard, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (!from) return;
      // Quantum bloom on Manhattan himself — nested blue rings ripple out.
      this._fxRing(srcEl, { color: '#4dd0ff' });
      setTimeout(() => this._fxRing(srcEl, { color: '#9be0ff' }), 130);
      // A healing energy stream + a crackling bolt into the HP orb.
      this._fxDrawBeam(from, to, { color: '#3fd0ff', core: '#eaffff', thickness: 6 });
      this._fxDrawBolt(from, to, { color: '#eaffff', glow: '#4aa3ff' });
    });
    // Bloom + sparks blossom at the HP orb as it heals.
    this._fxImpact(to, { color: '#9be0ff', core: '#eaffff', size: 1.1 });
    this._fxSparks(to, { count: 12, color: '#eaffff', glow: '#4dd0ff', spread: 72, size: 2.6 });
  },

  // Dormammu: twin Dark-Dimension flame streamers rip power FROM the enemy
  // BACK to him — embers tear off the victim, his core swells as it lands.
  _fxDrainSiphon(sourceCard, targetCard) {
    if (this._reducedMotion() || !sourceCard || !targetCard) return;
    const tgtEl = this._fxCardElById(targetCard.id);
    const from = this._fxCenter(tgtEl);
    const to = this._fxCenter(this._fxCardElById(sourceCard.id));
    if (!from || !to) return;
    this._fxTendril(from, to, { color: '#c04bff', glow: '#ff6a00', bow: 30 });
    setTimeout(() => this._fxTendril(from, to, { color: '#ff6a00', glow: '#c04bff', bow: -20 }), 70);
    // Embers torn off the enemy, streaming toward Dormammu.
    const ang = Math.atan2(to.y - from.y, to.x - from.x);
    this._fxSparks(from, { count: 12, color: '#ffb15a', glow: '#c04bff', spread: 74, size: 2.8, angle: ang, cone: 1.0 });
    if (tgtEl) this._fxRing(tgtEl, { color: '#ff6a00', contract: true });
    setTimeout(() => this._fxImpact(to, { color: '#c04bff', core: '#ffd9a0', size: 1.0 }), 180);
    this._screenShake('light');
  },

  // Trigon: demonic hellfire erupts under every frozen enemy, each column
  // throwing off a lick of rising embers.
  _fxHellfire(sourceCard, targets) {
    if (this._reducedMotion() || !targets || !targets.length) return;
    targets.forEach((t, i) => {
      setTimeout(() => {
        const el = t && this._fxCardElById(t.id);
        if (!el) return;
        this._fxFlameColumn(el);
        const c = this._fxCenter(el);
        if (c) this._fxSparks({ x: c.x, y: c.y + 10 }, { count: 9, color: '#ffb15a', glow: '#ff3b1a', spread: 70, size: 2.6, angle: -Math.PI / 2, cone: 1.2 });
      }, i * 70);
    });
    this._screenShake('heavy');
  },

  // Trigon: a hellfire soul-siphon that rips the Block Meter from the enemy and
  // pours it into him — twin flame streamers from the foe's meter to Trigon, a
  // red ring flaring on him, hellfire under his feet, rising embers. Falls back
  // to a self-surge if the meter element can't be located.
  _fxTrigonSteal(sourceCard, oppOwner) {
    if (this._reducedMotion() || !sourceCard) return;
    this._fxWhenPainted(sourceCard, (srcEl) => {
      const to = this._fxCenter(srcEl);
      if (!to) return;
      const meterText = document.getElementById((oppOwner || 'ai') + '-block-text');
      const meterEl = meterText ? meterText.closest('.block-circle') : null;
      const from = meterEl ? this._fxCenter(meterEl) : null;
      if (from) {
        this._fxTendril(from, to, { color: '#ff3b1a', glow: '#ffb15a', bow: 28 });
        setTimeout(() => this._fxTendril(from, to, { color: '#ffb15a', glow: '#ff3b1a', bow: -18 }), 70);
        const ang = Math.atan2(to.y - from.y, to.x - from.x);
        this._fxSparks(from, { count: 12, color: '#ffc27a', glow: '#ff3b1a', spread: 76, size: 2.8, angle: ang, cone: 1.0 });
        this._fxRing(meterEl, { color: '#ff3b1a', contract: true });
      }
      // Trigon's hatred crests — a red ring + hellfire embers rise off him.
      this._fxRing(srcEl, { color: '#ff3b1a' });
      this._fxFlameColumn(srcEl);
      setTimeout(() => this._fxImpact(to, { color: '#ff3b1a', core: '#ffc27a', size: 1.1 }), 180);
    });
    this._screenShake('medium');
  },

  // ====================== WAVE 4 (cost-6/7) ======================
  // Two more primitives (spinning dharma WHEEL, horizontal flight STREAK);
  // the rest compose the existing toolkit. Same rules throughout.

  // Spinning spoked wheel over a card (Mahoraga's Wheel of Dharma).
  _fxDharmaWheel(card) {
    if (this._reducedMotion() || !card) return;
    this._fxWhenPainted(card, (el) => {
      const c = this._fxCenter(el);
      if (!c) return;
      const layer = this._fxLayer();
      const wheel = document.createElement('div');
      wheel.className = 'sig-wheel';
      wheel.style.cssText = 'left:' + c.x + 'px;top:' + c.y + 'px;';
      wheel.innerHTML =
        '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="none" stroke="#d9a441" stroke-width="4"/>' +
        '<circle cx="50" cy="50" r="12" fill="none" stroke="#d9a441" stroke-width="4"/>' +
        Array.from({ length: 8 }, (_, i) => { const a = (i * 45) * Math.PI / 180; return '<line x1="' + (50 + 12 * Math.cos(a)).toFixed(1) + '" y1="' + (50 + 12 * Math.sin(a)).toFixed(1) + '" x2="' + (50 + 46 * Math.cos(a)).toFixed(1) + '" y2="' + (50 + 46 * Math.sin(a)).toFixed(1) + '" stroke="#3a3a3a" stroke-width="3"/>'; }).join('') +
        '</svg>';
      layer.appendChild(wheel);
      setTimeout(() => wheel.remove(), 760);
      // The Wheel of Dharma locks in — a golden ring pulse + adaptation sparks.
      this._fxRing(el, { color: '#d9a441' });
      this._fxSparks(c, { count: 14, color: '#ffe6a0', glow: '#d9a441', spread: 94, size: 2.8 });
    });
    this._screenShake('medium');
  },

  // Horizontal flight streak sweeping the enemy row + crimson blood bursts on
  // each struck enemy (Omni-Man). Enemies are pre-existing (painted); capture
  // them BEFORE the caller's synchronous AoE removes any it kills.
  _fxViltrumiteFlight(enemies) {
    if (this._reducedMotion() || !enemies || !enemies.length) return;
    const pts = enemies.map(e => this._fxCenter(this._fxCardElById(e && e.id))).filter(Boolean);
    if (!pts.length) return;
    const layer = this._fxLayer();
    const ys = pts.map(p => p.y), y = ys.reduce((a, b) => a + b, 0) / ys.length;
    const streak = document.createElement('div');
    streak.className = 'sig-streak';
    streak.style.cssText = 'top:' + y + 'px;';
    layer.appendChild(streak);
    setTimeout(() => streak.remove(), 460);
    pts.forEach((p, i) => setTimeout(() => {
      const spat = document.createElement('div');
      spat.className = 'sig-gas';
      spat.style.cssText = 'left:' + p.x + 'px;top:' + p.y + 'px;--sig-c:#c1121f;';
      layer.appendChild(spat);
      setTimeout(() => spat.remove(), 760);
      // Bone-crunch impact + a gout of gore where he rips through each enemy.
      this._fxImpact(p, { color: '#ff3b3b', core: '#ffd0d0', size: 0.9 });
      this._fxSparks(p, { color: '#ff6a6a', glow: '#c1121f', count: 10, spread: 62, size: 2.8 });
    }, 120 + i * 40));
    this._screenShake('heavy');
  },

  // ---- Wave 4 named per-card entry points ----

  // Obi-Wan: Soresu deflect — blue blade arcs the blow back across the lanes.
  _fxObiReflect(sourceCard, attackerCard) {
    if (attackerCard) this._fxSaberSlash(sourceCard, attackerCard, { blade: '#2b8cff', core: '#eaf4ff' });
  },
  // Mace Windu: Vaapad — an amethyst saber flourish erupts over Mace.
  _fxVaapad(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      // Vaapad — a flurry of violet strikes.
      [-42, -8, 26].forEach((a, i) => setTimeout(() => this._fxSlashEl(el, { blade: '#a855f7', core: '#f3e8ff', angle: a }), i * 90));
      // The debuff reaches the ENEMY's hand (hidden, up-screen): a violet
      // energy wave sweeps across into their side.
      const from = this._fxCenter(el);
      const to = { x: (typeof window !== 'undefined' ? window.innerWidth : 1200) * 0.5, y: 56 };
      if (from) this._fxDrawBeam(from, to, { color: '#a855f7', core: '#f3e8ff', thickness: 5 });
      if (from) this._fxSparks(to, { color: '#e9c6ff', glow: '#7a1fa2', count: 10, spread: 60, size: 2.6 });
      // The flurry lands — an amethyst burst flares over Mace as the last blow bites.
      if (from) setTimeout(() => this._fxImpact(from, { color: '#a855f7', core: '#f3e8ff', size: 1.0 }), 180);
    });
    this._screenShake('medium');
  },
  // Darth Maul — a spinning double-bladed red saber: twin crimson slashes
  // scissor across him, with a red-sith spark burst.
  _fxMaulSaber(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      this._fxSlashEl(el, { blade: '#ff2020', core: '#ffd0d0', angle: -40 });
      setTimeout(() => this._fxSlashEl(el, { blade: '#ff2020', core: '#ffd0d0', angle: 40 }), 110);
      const c = this._fxCenter(el);
      if (c) this._fxSparks(c, { color: '#ffb0b0', glow: '#ff2020', count: 10, spread: 56, size: 2.6 });
    });
    this._screenShake('light');
  },
  // Gorr: the All-Black necrosword — a black shadow-slash + oily smoke.
  _fxNecrosword(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      // All Black carves a cross-slash of living darkness, then a necrotic
      // shroud + violet death-sparks bleed out of the wound.
      this._fxSlashEl(el, { blade: '#0a0a0a', core: '#7a1fa2', angle: -30 });
      setTimeout(() => this._fxSlashEl(el, { blade: '#0a0a0a', core: '#7a1fa2', angle: 34 }), 90);
      this._fxGasBurst(el, { color: '#1a0a1a' });
      this._fxRing(el, { color: '#7a1fa2', contract: true });
      const c = this._fxCenter(el);
      if (c) this._fxSparks(c, { count: 12, color: '#c98cff', glow: '#7a1fa2', spread: 84, size: 2.8 });
    });
    this._screenShake('medium');
  },
  // Dr. Doom: emerald Latverian doom-magic — a green burst + sigil ring over
  // Doom. Anchored on Doom himself: the summoned Doombot isn't reachable
  // synchronously (summonCardChoice may defer behind a lane prompt and returns
  // nothing).
  _fxDoomConjure(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      this._fxGasBurst(el, { color: '#2fbf4f' });
      this._fxRing(el, { color: '#2fbf4f' });
      // Latverian doom-magic swells — a sigil flash + emerald arcane sparks.
      const c = this._fxCenter(el);
      if (c) {
        this._fxImpact(c, { color: '#2fbf4f', core: '#d6ffe0', size: 1.0 });
        this._fxSparks(c, { count: 14, color: '#8affa0', glow: '#2fbf4f', spread: 90, size: 2.8 });
      }
    });
    this._screenShake('medium');
  },
  // Ultron: cold red robotic energy collapses inward to forge each replica.
  _fxUltronReplicate(replicas) {
    if (this._reducedMotion() || !replicas || !replicas.length) return;
    replicas.filter(Boolean).forEach((rep) => this._fxWhenPainted(rep, (el) => this._fxRing(el, { color: '#ff3b3b', contract: true })));
    this._screenShake('light');
  },
  // Hela: green Asgardian necromancy — a bone-ring bursts beneath each raise.
  _fxHelaRaise(self, warriors) {
    if (this._reducedMotion()) return;
    if (self) this._fxWhenPainted(self, (el) => this._fxGasBurst(el, { color: '#2fdd6a' }));
    (warriors || []).filter(Boolean).forEach((w) => this._fxWhenPainted(w, (el) => this._fxRevive(el)));
  },
  // Magneto: a magnetic metal shard hurls the card + a steel ripple that
  // settles at the DESTINATION lane. moveCard only mutates state — the card's
  // element is still at its OLD lane when this fires (then FLIP-animates over),
  // so anchor the arrival ring to the destination lane SLOT (stable, not
  // animated) rather than the still-old-positioned card element.
  _fxMagnetoHurl(self, targetCard, toLane, owner) {
    if (this._reducedMotion() || !targetCard) return;
    this._fxProjectile(self, targetCard, { color: '#8fa8c8' });
    const lanes = document.querySelectorAll('.board > .lane');
    const laneEl = (toLane != null) ? lanes[toLane | 0] : null;
    const slot = laneEl && laneEl.querySelector(owner === 'player' ? '.player-slot' : '.ai-slot');
    if (slot) {
      // Let the card FLIP into place, then ripple the ring where it lands.
      setTimeout(() => this._fxRing(slot, { color: '#6f8fbf' }), 340);
    } else {
      // No lane info → wait past the relocation render, then ring the card at
      // its new position (double-rAF: _fxWhenPainted fires immediately here
      // because the card is already painted at the OLD spot).
      const raf = (typeof window !== 'undefined' && window.requestAnimationFrame) ? window.requestAnimationFrame.bind(window) : (f) => setTimeout(f, 16);
      raf(() => raf(() => { const el = this._fxCardElById(targetCard.id); if (el) this._fxRing(el, { color: '#6f8fbf' }); }));
    }
    this._screenShake('light');
  },
  // Hulk SMASH: he rears up and pounds the ground, a green ground-shatter
  // shockwave ruptures out of him, and every enemy the sweep hits gets a
  // rolling gamma impact + debris. Fired from his onPlay (2 dmg to all enemies).
  _fxHulkSmash(self) {
    if (this._reducedMotion() || !self) return;
    // Impact every enemy currently on the board — read straight from the DOM so
    // enemies about to die in the sweep still get hit (their element is still
    // painted from the last render).
    const enemyEls = document.querySelectorAll('.board .card.enemy-card[data-card-id]');
    enemyEls.forEach((eEl, i) => {
      const p = this._fxCenter(eEl);
      if (!p) return;
      setTimeout(() => {
        this._fxImpact(p, { color: '#5ed84a', core: '#e6ffcf', size: 1.05 });
        this._fxSparks(p, { color: '#b6ff8f', glow: '#3fae2f', count: 9, spread: 54, size: 2.8 });
      }, 130 + i * 55);
    });
    this._fxWhenPainted(self, (el) => {
      // The pound itself — rear back and slam down with a gamma flash.
      el.classList.remove('fx-hulk-slam'); void el.offsetWidth; el.classList.add('fx-hulk-slam');
      setTimeout(() => el.classList.remove('fx-hulk-slam'), 640);
      this._fxRing(el, { color: '#4caf3a' });
      const c = this._fxCenter(el);
      if (c) this._fxSparks(c, { color: '#c8e6a0', glow: '#3a8a2a', count: 12, spread: 66, size: 3.2 });
    });
    this._screenShake('heavy');
  },
  // Hulk rage: getting hit only makes him madder. When he's damaged he
  // swells with gamma fury — a pump-up on his card, twin green shockwave
  // rings, debris flung upward, and a shake. Fired from onDamaged after the
  // +2/+2 lands. One-shot, self-removing, reduced-motion gated.
  _fxHulkRage(self) {
    if (this._reducedMotion() || !self) return;
    const el = this._fxCardElById(self.id);
    if (!el) return;
    const c = this._fxCenter(el);
    // Gamma pump-up on the card itself.
    el.classList.remove('fx-hulk-rage');
    void el.offsetWidth;
    el.classList.add('fx-hulk-rage');
    setTimeout(() => el.classList.remove('fx-hulk-rage'), 620);
    // Twin expanding gamma shockwaves.
    this._fxRing(el, { color: '#5ed84a' });
    setTimeout(() => this._fxRing(el, { color: '#8ef07a' }), 110);
    // A burst of green debris flung upward.
    if (c) this._fxSparks(c, { color: '#b6ff8f', glow: '#3fae2f', count: 12, angle: -Math.PI / 2, cone: 2.0, spread: 70, size: 3 });
    this._screenShake('light');
  },
  // Spider-Man: a web THWIPs from Spidey to the enemy he freezes, then a web
  // net splats over the target. Fired from onPlay right after the freeze
  // lands. One-shot, self-removing, reduced-motion gated.
  _fxSpiderWeb(sourceCard, targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const toEl = this._fxCardElById(targetCard.id);
    const to = this._fxCenter(toEl);
    if (!to) return;
    const sz = toEl ? Math.max(toEl.getBoundingClientRect().width * 1.15, 72) : 92;
    // The strand fires from Spidey once he's painted; the net splats a beat
    // later so it reads as "shot → stuck".
    this._fxWhenPainted(sourceCard, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from) this._fxWebStrand(from, to);
      srcEl.classList.remove('fx-spider-thwip');
      void srcEl.offsetWidth;
      srcEl.classList.add('fx-spider-thwip');
      setTimeout(() => srcEl.classList.remove('fx-spider-thwip'), 420);
    });
    setTimeout(() => this._fxWebSplat(to, sz), 130);
  },
  // A single web strand: a lightly-sagging line that draws on from maw to
  // target. Two stacked strokes (soft halo + bright core) read as silk.
  _fxWebStrand(from, to) {
    if (!from || !to || this._reducedMotion()) return;
    const layer = this._fxLayer();
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len, py = dx / len;
    const sag = Math.min(24, len * 0.07);
    const mx = from.x + dx * 0.5 + px * sag, my = from.y + dy * 0.5 + py * sag + 8;
    const d = 'M ' + from.x.toFixed(1) + ' ' + from.y.toFixed(1) +
              ' Q ' + mx.toFixed(1) + ' ' + my.toFixed(1) + ' ' + to.x.toFixed(1) + ' ' + to.y.toFixed(1);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'fx-spider-strand');
    svg.style.filter = 'drop-shadow(0 0 4px rgba(190,225,255,0.8))';
    svg.innerHTML =
      '<path d="' + d + '" fill="none" stroke="rgba(255,255,255,0.32)" stroke-width="5" stroke-linecap="round" pathLength="1" class="fx-web-draw"></path>' +
      '<path d="' + d + '" fill="none" stroke="#eaf6ff" stroke-width="1.8" stroke-linecap="round" pathLength="1" class="fx-web-draw"></path>';
    layer.appendChild(svg);
    setTimeout(() => svg.remove(), 540);
  },
  // A classic radial spider web (spokes + catenary rings) that splats over a
  // point and fades. `size` = on-screen diameter in px.
  _fxWebSplat(point, size) {
    if (!point || this._reducedMotion()) return;
    const layer = this._fxLayer();
    const R = 46, spokes = 9, rings = 4, sag = 0.16;
    const pts = [];
    let g = '';
    for (let s = 0; s < spokes; s++) {
      const a = (s / spokes) * Math.PI * 2 - Math.PI / 2;
      const p = [Math.cos(a), Math.sin(a)];
      pts.push(p);
      g += '<line x1="0" y1="0" x2="' + (p[0] * R).toFixed(1) + '" y2="' + (p[1] * R).toFixed(1) + '"/>';
    }
    for (let r = 1; r <= rings; r++) {
      const rr = R * (r / rings) * 0.95;
      let d = '';
      for (let s = 0; s <= spokes; s++) {
        const p = pts[s % spokes];
        const x = p[0] * rr, y = p[1] * rr;
        if (s === 0) { d += 'M ' + x.toFixed(1) + ' ' + y.toFixed(1) + ' '; continue; }
        const prev = pts[(s - 1) % spokes];
        // Control point: midpoint of the two spoke hits, pulled toward centre
        // so each segment bows in like real web silk.
        const cx = (prev[0] + p[0]) / 2 * rr * (1 - sag);
        const cy = (prev[1] + p[1]) / 2 * rr * (1 - sag);
        d += 'Q ' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      }
      g += '<path d="' + d + '" fill="none"/>';
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'fx-spider-web');
    svg.setAttribute('viewBox', '-50 -50 100 100');
    svg.innerHTML = g;
    const w = size, h = size;
    svg.style.cssText = 'left:' + (point.x - w / 2) + 'px;top:' + (point.y - h / 2) + 'px;width:' + w + 'px;height:' + h + 'px;';
    layer.appendChild(svg);
    setTimeout(() => svg.remove(), 780);
  },
  // Gojo: Hollow Purple implodes each doomed enemy into a violet singularity.
  _fxHollowPurple(sourceCard, victimCard) {
    if (this._reducedMotion() || !victimCard) return;
    const el = this._fxCardElById(victimCard.id);
    if (!el) { this._screenShake('medium'); return; }
    const c = this._fxCenter(el);
    // Hollow Purple — Blue (attraction) + Red (repulsion) collide into a violet
    // singularity that erases the target: implosion + twin contracting rings in
    // blue then red, debris dragged in, and a blinding collapse flash.
    this._fxImplode(el, { color: '#b06bff' });
    this._fxRing(el, { color: '#3aa0ff', contract: true });
    setTimeout(() => this._fxRing(el, { color: '#ff3b3b', contract: true }), 90);
    if (c) {
      this._fxSparks(c, { count: 18, color: '#e8d0ff', glow: '#b06bff', spread: 120, size: 3.2 });
      setTimeout(() => this._fxImpact(c, { color: '#b06bff', core: '#ffffff', size: 1.5 }), 240);
    }
    this._screenShake('heavy');
  },
  // Silver Surfer: a chrome Power-Cosmic wave washes over the drained enemy.
  _fxCosmicWave(sourceCard, targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const tgtEl = this._fxCardElById(targetCard.id);
    const to = this._fxCenter(tgtEl);
    if (tgtEl) this._fxRing(tgtEl, { color: '#cfd8e6', contract: true });
    if (to) this._fxWhenPainted(sourceCard, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from) this._fxDrawBeam(from, to, { color: '#cfd8e6', core: '#ffffff', thickness: 7 });
    });
    // A chrome burst where the Power-Cosmic breaks over the target.
    if (to) {
      this._fxImpact(to, { color: '#cfd8e6', core: '#ffffff', size: 1.0 });
      this._fxSparks(to, { count: 12, color: '#ffffff', glow: '#cfd8e6', spread: 66, size: 2.6 });
    }
    // The Power-Cosmic tax — a silver-chrome wave sweeps across the enemy side
    // (their cards cost 1 more while the Surfer stands).
    this._fxCosmicSweep();
  },
  // A silver Power-Cosmic light-wave sweeping over the enemy half of the board.
  _fxCosmicSweep() {
    if (this._reducedMotion()) return;
    const board = document.querySelector('#board');
    if (!board) return;
    const br = board.getBoundingClientRect();
    if (!br || !br.width) return;
    const layer = this._fxLayer();
    const sweep = document.createElement('div');
    sweep.className = 'fx-cosmic-sweep';
    sweep.style.cssText = 'left:' + br.left + 'px;top:' + br.top + 'px;width:' + br.width + 'px;height:' + (br.height * 0.5) + 'px;';
    layer.appendChild(sweep);
    setTimeout(() => sweep.remove(), 900);
  },
  // Thanos snap: a doomed card crumbles to ash and blows away. A detached ghost
  // (so the engine's card removal on the next render can't cut the dissolve
  // short — same trick _fxImplode uses) erodes, desaturates and drifts up with
  // a cloud of ash motes and a dust puff. Call on each snapped card BEFORE
  // killCard removes it. If the element can't be located (paint-timing race),
  // fall back to a burst at the card's lane slot. One-shot, self-removing,
  // reduced-motion gated.
  _fxThanosDust(card) {
    if (this._reducedMotion() || !card) return;
    let el = this._fxCardElById(card.id);
    // Fallback: locate the lane slot holding this card so a summon/paint race
    // still produces a dust burst at the right spot.
    if (!el && typeof Game !== 'undefined' && Game.findCardLane) {
      const li = Game.findCardLane(card);
      if (li != null && li >= 0) {
        const slot = document.querySelector('#board .lane:nth-child(' + (li + 1) + ') .card-slot')
          || document.querySelectorAll('#board .card-slot')[li];
        if (slot) el = slot;
      }
    }
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const layer = this._fxLayer();
    // Ghost = a PLAIN div carrying the card's portrait as a background image —
    // NOT a cloneNode of the whole card, which drags the card's own CSS
    // (transforms, z-index, nested overlays) along and mis-sizes, mis-positions
    // or hides the ghost. transform:none + the portrait bitmap dissolves cleanly.
    const portrait = el.querySelector && el.querySelector('.card-portrait');
    if (portrait) {
      const bg = getComputedStyle(portrait).backgroundImage;
      const ghost = document.createElement('div');
      ghost.className = 'fx-thanos-dust';
      ghost.style.cssText =
        'position:fixed;transform:none;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;' +
        'border-radius:10px;background-size:cover;background-position:center;';
      if (bg && bg !== 'none') ghost.style.backgroundImage = bg;
      layer.appendChild(ghost);
      setTimeout(() => ghost.remove(), 1400);
    }
    // Soft expanding dust puff behind the motes.
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const puff = document.createElement('div');
    puff.className = 'fx-dust-cloud';
    puff.style.cssText =
      'left:' + cx + 'px;top:' + cy + 'px;width:' + (r.width * 1.25) + 'px;height:' + (r.height * 0.9) + 'px;';
    layer.appendChild(puff);
    setTimeout(() => puff.remove(), 1200);
    // Dense ash burst — the unmistakable "dusting". Motes stream up-and-out.
    const n = 34;
    for (let i = 0; i < n; i++) {
      const mote = document.createElement('div');
      mote.className = 'fx-dust-mote';
      const mx = r.left + Math.random() * r.width;
      const my = r.top + r.height * (0.1 + Math.random() * 0.85);
      const rise = 60 + Math.random() * 120;
      const drift = (Math.random() - 0.5) * 95;
      const sz = 2 + Math.random() * 4.5;
      mote.style.cssText =
        'left:' + mx.toFixed(0) + 'px;top:' + my.toFixed(0) + 'px;width:' + sz.toFixed(1) + 'px;height:' + sz.toFixed(1) + 'px;' +
        '--dx:' + drift.toFixed(0) + 'px;--dy:' + (-rise).toFixed(0) + 'px;animation-delay:' + (Math.random() * 360).toFixed(0) + 'ms;';
      layer.appendChild(mote);
      setTimeout(() => mote.remove(), 1650);
    }
  },

  // =============== 1-cost character cast FX ===============
  // Each reuses the signature-FX primitives; wired from the card's onPlay so
  // the little bodies get a moment. All one-shot, self-removing, reduced-motion
  // gated (the primitives gate themselves too).

  // Ant-Man: a Pym-particle size-punch — his card snaps small then bursts big
  // with a blue shock ring and sparks.
  _fxAntManPym(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      el.classList.remove('fx-antman-pym'); void el.offsetWidth; el.classList.add('fx-antman-pym');
      setTimeout(() => el.classList.remove('fx-antman-pym'), 560);
      this._fxRing(el, { color: '#4aa3ff' });
      const c = this._fxCenter(el);
      if (c) this._fxSparks(c, { color: '#cfe6ff', glow: '#4aa3ff', count: 10, spread: 54, size: 2.6 });
    });
  },
  // Black Widow: a "Widow's Bite" — a crackling blue zap from Widow to each
  // frozen enemy (the freeze frost itself fires from freezeCard).
  _fxWidowBite(self, targetCard) {
    if (this._reducedMotion() || !self || !targetCard) return;
    const to = this._fxCenter(this._fxCardElById(targetCard.id));
    if (!to) return;
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from) this._fxDrawBolt(from, to, { color: '#9be0ff', glow: '#2f7fff' });
    });
  },
  // Harley Quinn: chaos confetti — her card wobbles and flings a burst of
  // spinning pink/green diamonds (playing-card pips) as everyone draws.
  // Poison Ivy — the charmed ally is wreathed in a green pheromone bloom and a
  // vine draws its strength back to Ivy. Card-ref args (self, ally) so it
  // relays to the MP guest, which rebuilds it from its own DOM.
  _fxIvyCharm(self, allyCard) {
    if (this._reducedMotion() || !self) return;
    const ael = allyCard ? this._fxCardElById(allyCard.id) : null;
    const from = this._fxCenter(ael);
    if (ael) {
      this._fxRing(ael, { color: '#54d66a' });
      if (from) this._fxSparks(from, { color: '#9dffb0', glow: '#2ea043', count: 9, angle: -Math.PI / 2, cone: 1.9, spread: 54, size: 2.6 });
    }
    this._fxWhenPainted(self, (srcEl) => {
      const to = this._fxCenter(srcEl);
      if (from && to) this._fxTendril(from, to, { color: '#1f7a34', glow: '#7bf29a', bow: 26 });
      this._fxRing(srcEl, { color: '#54d66a', contract: true });
      if (to) this._fxSparks(to, { color: '#9dffb0', glow: '#2ea043', count: 8, spread: 46, size: 2.4 });
    });
  },
  _fxHarleyChaos(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      el.classList.remove('fx-harley-wobble'); void el.offsetWidth; el.classList.add('fx-harley-wobble');
      setTimeout(() => el.classList.remove('fx-harley-wobble'), 560);
      const c = this._fxCenter(el);
      if (!c) return;
      const layer = this._fxLayer();
      const colors = ['#ff4da6', '#ff2d8e', '#5be089', '#28d66a', '#ffffff'];
      for (let i = 0; i < 16; i++) {
        const conf = document.createElement('div');
        conf.className = 'fx-harley-confetti';
        const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;   // fan upward
        const dist = 40 + Math.random() * 70;
        const sz = 5 + Math.random() * 6;
        conf.style.cssText =
          'left:' + c.x.toFixed(0) + 'px;top:' + c.y.toFixed(0) + 'px;' +
          'width:' + sz.toFixed(1) + 'px;height:' + sz.toFixed(1) + 'px;' +
          'background:' + colors[i % colors.length] + ';' +
          '--cx:' + (Math.cos(ang) * dist).toFixed(0) + 'px;--cy:' + (Math.sin(ang) * dist).toFixed(0) + 'px;' +
          '--cr:' + ((Math.random() * 2 - 1) * 540).toFixed(0) + 'deg;' +
          'animation-delay:' + (Math.random() * 90).toFixed(0) + 'ms;';
        layer.appendChild(conf);
        setTimeout(() => conf.remove(), 900);
      }
    });
  },
  // Gorilla Grodd: a psychic seize — a violet beam from Grodd to the target,
  // a contracting psi-ring clamping the victim's mind, and a pulse on Grodd.
  _fxGroddMindControl(self, targetCard) {
    if (this._reducedMotion() || !self || !targetCard) return;
    const tgtEl = this._fxCardElById(targetCard.id);
    const to = this._fxCenter(tgtEl);
    // Telepathic ripple — three concentric psi-rings pulse OUT of the victim's
    // head as Grodd seizes the mind. Custom, staggered.
    if (to) {
      const layer = this._fxLayer();
      for (let i = 0; i < 3; i++) {
        setTimeout(() => {
          const ring = document.createElement('div');
          ring.className = 'fx-psi-ripple';
          ring.style.cssText = 'left:' + to.x.toFixed(0) + 'px;top:' + to.y.toFixed(0) + 'px;';
          layer.appendChild(ring);
          setTimeout(() => ring.remove(), 720);
        }, i * 130);
      }
    }
    if (tgtEl) this._fxRing(tgtEl, { color: '#b06bff', contract: true });
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from && to) this._fxDrawBeam(from, to, { color: '#a24bff', core: '#e9d4ff', thickness: 6 });
      this._fxRing(srcEl, { color: '#b06bff' });
    });
  },
  // Hawkeye: a trick-arrow volley — thin fast bolts from Hawkeye to each
  // adjacent enemy he splashes.
  _fxHawkeyeVolley(self, lane, owner) {
    if (this._reducedMotion() || !self || typeof Game === 'undefined') return;
    const opp = Game.opponent(owner);
    const targets = [];
    [lane - 1, lane + 1].forEach((li) => {
      if (li < 0 || li >= Game.LANE_COUNT) return;
      const e = Game.state.lanes[li] && Game.state.lanes[li][opp];
      if (e && e.currentHealth > 0) { const c = this._fxCenter(this._fxCardElById(e.id)); if (c) targets.push(c); }
    });
    if (!targets.length) return;
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (!from) return;
      targets.forEach((to, i) => setTimeout(() => {
        this._fxDrawBolt(from, to, { color: '#ffe08a', glow: '#ff9d2e' });
      }, i * 90));
    });
  },
  // Mr. Freeze: a cryo-ray — a cyan beam to each frozen enemy (frost lands from
  // freezeCard) plus a frost shield ring on Freeze himself for the HP freeze.
  _fxFreezeRay(self, targetCards) {
    if (this._reducedMotion() || !self) return;
    const tos = (targetCards || [])
      .map(t => this._fxCenter(this._fxCardElById(t.id)))
      .filter(Boolean);
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from) tos.forEach(to => this._fxDrawBeam(from, to, { color: '#8fe6ff', core: '#ffffff', thickness: 5 }));
      this._fxRing(srcEl, { color: '#8fe6ff', contract: true });
    });
  },
  // Catwoman: a quick claw-swipe across her card and a spray of stolen-energy
  // motes lifting off her as she lightens the enemy's purse.
  _fxCatwomanSteal(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      const r = el.getBoundingClientRect();
      if (!r || r.width === 0) return;
      const layer = this._fxLayer();
      const slash = document.createElement('div');
      slash.className = 'fx-catwoman-swipe';
      slash.style.cssText = 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;';
      slash.innerHTML = '<i></i><i></i><i></i>';
      layer.appendChild(slash);
      setTimeout(() => slash.remove(), 520);
      const c = this._fxCenter(el);
      if (c) this._fxSparks({ x: c.x, y: c.y }, { color: '#ffcf6b', glow: '#ff9d2e', count: 10, angle: -Math.PI / 2, cone: 1.6, spread: 66, size: 2.8 });
      // THE STEAL, SHOWN: an energy orb is clawed out of the enemy's energy
      // counter and arcs across the board into hers (it lands next turn —
      // the orb says where it is going).
      this._fxEnergyTheft(self.owner);
    });
  },

  // =============== WAVE 4: cards that had no animation ===============
  // Every entry is abstract light/particle work built from the shared
  // primitives above — beams, bolts, rings, sparks, slashes, gas — so each
  // card's moment reads at a glance without drawing anyone. Targets are
  // captured BEFORE the caller deals damage (a lethal hit sweeps the element
  // on the next render); casters wait for paint via _fxWhenPainted.
  _fxPt(card) { return card ? this._fxCenter(this._fxCardElById(card.id)) : null; },
  // The four Cogs' signature openers.
  _fxCogStrike(self, target, kind) {
    if (this._reducedMotion() || !self || !target) return;
    const to = this._fxPt(target), tEl = this._fxCardElById(target.id);
    if (!to) return;
    this._fxWhenPainted(self, (el) => {
      const from = this._fxCenter(el);
      if (!from) return;
      if (kind === 'beguile') {            // Mr. Hollywood: a dazzling spotlight flash
        this._fxDrawBeam(from, to, { color: '#ff7ad9', core: '#fff' });
        this._fxImpact(to, { color: '#ffd6f3', core: '#ffffff', size: 1.3 });
        this._fxSparks(to, { color: '#fff3a8', glow: '#ff7ad9', count: 14, spread: 70, size: 3 });
      } else if (kind === 'embezzle') {    // Robber Baron: a green-gold siphon + the energy he takes
        this._fxDrawBeam(from, to, { color: '#7dffb0', core: '#fff6c8' });
        this._fxSparks(to, { color: '#ffe08a', glow: '#3dff9a', count: 12, angle: Math.atan2(from.y - to.y, from.x - to.x), cone: .9, spread: 80, size: 2.6 });
        this._fxEnergyTheft(self.owner);
      } else if (kind === 'fired') {       // Big Wig: a spinning pink slip, then the shove
        this._fxProjectile(self, target, { color: '#ff5252' });
        setTimeout(() => this._fxImpact(to, { color: '#ff8a8a', size: 1.1 }), 260);
      } else {                             // The Big Cheese: a heavy red glare that knocks down
        this._fxDrawBeam(from, to, { color: '#ff2a2a', core: '#ffd0a0', width: 9 });
        this._fxImpact(to, { color: '#ff6a3d', core: '#fff2c8', size: 1.7 });
        if (tEl) this._fxRing(tEl, { color: '#ff3b2f' });
        this._screenShake('light');
      }
    });
  },
  // Power Trip: arcs of current leap from the Cog to every enemy at once.
  _fxPowerTrip(self, enemies) {
    if (this._reducedMotion() || !self || !enemies || !enemies.length) return;
    const pts = enemies.map(c => this._fxPt(c)).filter(Boolean);
    const from = this._fxPt(self);
    if (!from || !pts.length) return;
    pts.forEach((p, i) => setTimeout(() => {
      this._fxDrawBolt(from, p, { color: '#ffe066' });
      this._fxSparks(p, { color: '#fff6b0', glow: '#ffcf33', count: 8, spread: 46, size: 2.4 });
    }, i * 70));
    this._screenShake('light');
  },
  // Padme: a gold blessing settles over every other ally each turn.
  _fxPadmeBlessing(allies) {
    if (this._reducedMotion() || !allies || !allies.length) return;
    allies.forEach((c, i) => {
      const el = this._fxCardElById(c.id); if (!el) return;
      setTimeout(() => {
        this._fxRing(el, { color: '#ffd76b', contract: true });
        const p = this._fxCenter(el);
        if (p) this._fxSparks(p, { color: '#fff1bd', glow: '#ffc94a', count: 9, angle: -Math.PI / 2, cone: .8, spread: 60, size: 2.4 });
      }, i * 90);
    });
  },
  // Red Hulk: the hit he takes boils over — a flame column, then the splash.
  _fxRedHulkRage(self) {
    if (this._reducedMotion() || !self) return;
    const el = this._fxCardElById(self.id); if (!el) return;
    this._fxFlameColumn(el);
    const p = this._fxCenter(el);
    if (p) this._fxImpact(p, { color: '#ff3b1f', core: '#ffd27a', size: 1.6 });
    this._screenShake('light');
  },
  // Ahsoka: an ally falls and twin blades flash ready for the extra swing.
  _fxAhsokaReady(self) {
    if (this._reducedMotion() || !self) return;
    const el = this._fxCardElById(self.id); if (!el) return;
    this._fxSlash(el, { count: 2, color: '#eaf6ff', angle: -32 });
    this._fxRing(el, { color: '#bfe6ff', contract: true });
  },
  // Gizmo: the bright light that starts the multiplying.
  _fxGizmoFlash(self) {
    if (this._reducedMotion() || !self) return;
    const p = this._fxPt(self); if (!p) return;
    this._fxImpact(p, { color: '#ffffff', core: '#ffffff', size: 2 });
    this._fxSparks(p, { color: '#d8ff9a', glow: '#7dff4e', count: 16, spread: 90, size: 2.6 });
  },
  // Sabertooth: three claw rakes and a growth pulse when he draws hero blood.
  _fxSabertoothRage(self) {
    if (this._reducedMotion() || !self) return;
    const el = this._fxCardElById(self.id); if (!el) return;
    this._fxSlash(el, { count: 3, color: '#ffb347', angle: 24 });
    this._fxRing(el, { color: '#ff9d2e' });
  },
  // Jaws: the kill feeds him — a churn of water and a healing surge.
  _fxJawsFeed(self) {
    if (this._reducedMotion() || !self) return;
    const el = this._fxCardElById(self.id); if (!el) return;
    this._fxRing(el, { color: '#4fc3ff' });
    const p = this._fxCenter(el);
    if (p) this._fxSparks(p, { color: '#bfeaff', glow: '#2fa8ff', count: 14, angle: -Math.PI / 2, cone: 1.4, spread: 70, size: 2.8 });
  },
  // Shadows rising (Igris, Beru): black-violet smoke boils up out of the slot.
  _fxShadowRise(card) {
    if (this._reducedMotion() || !card) return;
    this._fxWhenPainted(card, (el) => {
      this._fxGasBurst(el, { color: '#5b2bd6' });
      this._fxRing(el, { color: '#8a5cff', contract: true });
      const p = this._fxCenter(el);
      if (p) this._fxSparks(p, { color: '#c9b3ff', glow: '#6a3dff', count: 12, angle: -Math.PI / 2, cone: .7, spread: 80, size: 2.4 });
    });
  },

  // ---- Superman / Batman / Dr. Doom: their other big moments ----
  // Superman's entry strike: a white-blue streak dives onto the target (or the
  // enemy HP bar) and lands with a shockwave. Target captured before damage.
  _fxSupermanStrike(self, target, owner) {
    if (this._reducedMotion() || !self) return;
    let to = target ? this._fxPt(target) : null;
    if (!to) {
      const dom = this._fxDomSide ? this._fxDomSide(owner || self.owner) : (owner || self.owner);
      to = this._fxCenter(document.getElementById(dom === 'player' ? 'ai-hp-fill' : 'player-hp-fill'));
    }
    if (!to) return;
    this._fxWhenPainted(self, (el) => {
      const from = this._fxCenter(el);
      if (!from) return;
      this._fxSonicBoom(from.x, from.y, to.x - from.x, to.y - from.y);
      setTimeout(() => {
        this._fxImpact(to, { color: '#cfe6ff', core: '#ffffff', size: 1.8 });
        this._fxSparks(to, { color: '#ffffff', glow: '#6fb6ff', count: 14, spread: 80, size: 2.6 });
        this._screenShake('light');
      }, 160);
    });
  },
  // Superman's freeze: an icy breath cone onto each frozen enemy.
  _fxSupermanFreezeBreath(self, target) {
    if (this._reducedMotion() || !self || !target) return;
    this._fxFreezeRay(self, [target]);
  },
  // Batman's lockdown: a dark seal snaps shut over the enemy's hand — rings
  // contract onto it and cold sparks spit off as the best card is locked.
  _fxBatmanLockdown(self) {
    if (this._reducedMotion() || !self) return;
    const dom = this._fxDomSide ? this._fxDomSide(self.owner) : self.owner;
    const hand = document.getElementById(dom === 'player' ? 'ai-hand' : 'player-hand');
    const to = this._fxCenter(hand);
    if (!to) return;
    this._fxWhenPainted(self, (el) => {
      const from = this._fxCenter(el);
      if (from) this._fxTendril(from, to, { color: '#1b2433' });
      setTimeout(() => {
        this._fxRing(hand, { color: '#9fb4d6', contract: true });
        setTimeout(() => this._fxRing(hand, { color: '#41536f', contract: true }), 120);
        this._fxSparks(to, { color: '#d6e2f5', glow: '#4f6a93', count: 12, spread: 70, size: 2.2 });
      }, 260);
    });
  },
  // Dr. Doom's revive: green arcane rings turn on him, then a bolt of that
  // light carries the fallen ally back to his master's hand.
  _fxDoomRevive(self) {
    if (this._reducedMotion() || !self) return;
    const dom = this._fxDomSide ? this._fxDomSide(self.owner) : self.owner;
    const hand = document.getElementById(dom === 'player' ? 'player-hand' : 'ai-hand');
    this._fxWhenPainted(self, (el) => {
      this._fxRing(el, { color: '#3dff8a' });
      setTimeout(() => this._fxRing(el, { color: '#9dffc4', contract: true }), 140);
      const from = this._fxCenter(el), to = this._fxCenter(hand);
      if (from) this._fxSparks(from, { color: '#c8ffd9', glow: '#2bd66b', count: 14, angle: -Math.PI / 2, cone: 1, spread: 80, size: 2.6 });
      if (from && to) setTimeout(() => {
        this._fxDrawBolt(from, to, { color: '#5dff9b' });
        this._fxImpact(to, { color: '#7dffb0', size: 1.2 });
      }, 260);
    });
  },

  // ---- Jango Fett / Sung Jin-Woo / Iron Man / Hulk extras ----
  // Ground crack: jagged fissures race out from a card's slot (SVG strokes
  // drawn on via dashoffset), with a dust wave sweeping along the row.
  _fxGroundCrack(el, opts) {
    if (!el || this._reducedMotion()) return;
    opts = opts || {};
    const r = el.getBoundingClientRect(); if (!r || !r.width) return;
    const cx = r.left + r.width / 2, cy = r.bottom - r.height * .12;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'fx-crack');
    svg.style.cssText = 'left:0;top:0;width:100vw;height:100vh;--crack-c:' + (opts.color || '#b6ff8f') + ';';
    for (let i = 0; i < 9; i++) {
      const a = Math.PI + (i / 8) * Math.PI + (Math.random() - .5) * .25;   // fan out sideways + down
      let x = cx, y = cy, d = 'M' + x.toFixed(1) + ' ' + y.toFixed(1);
      const len = 70 + Math.random() * 120, steps = 6;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, jitter = (Math.random() - .5) * 18;
        x = cx + Math.cos(a) * len * t * 1.6 + jitter;
        y = cy - Math.sin(a) * len * t * .45 + jitter * .4;
        d += ' L' + x.toFixed(1) + ' ' + y.toFixed(1);
      }
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.style.animationDelay = (i * 18) + 'ms';
      svg.appendChild(path);
    }
    this._fxLayer().appendChild(svg);
    setTimeout(() => svg.remove(), 1100);
    const wave = document.createElement('div');
    wave.className = 'fx-dust-wave';
    wave.style.cssText = 'left:' + cx + 'px;top:' + cy + 'px;--dust-c:' + (opts.dust || 'rgba(140,220,110,.55)') + ';';
    this._fxLayer().appendChild(wave);
    setTimeout(() => wave.remove(), 900);
  },
  // Hulk lands: a heavy drop, the floor splits, a gamma dust wave rolls out.
  _fxHulkLanding(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      this._fxGroundCrack(el, { color: '#c8ff9e', dust: 'rgba(120,230,90,.5)' });
      this._fxRing(el, { color: '#5ed84a' });
      this._screenShake('land-l');
    });
  },
  // Iron Man: a targeting sweep crosses the enemy row; each damaged enemy he
  // can finish gets a lock-on ring before the repulsors fire (staggered).
  _fxIronManScan(self, targets) {
    if (this._reducedMotion() || !self) return;
    const row = Array.from(document.querySelectorAll('.board .card.enemy-card[data-card-id]'));
    const rects = row.map(e => e.getBoundingClientRect()).filter(r => r.width);
    if (rects.length) {
      const top = Math.min(...rects.map(r => r.top)), bot = Math.max(...rects.map(r => r.bottom));
      const left = Math.min(...rects.map(r => r.left)), right = Math.max(...rects.map(r => r.right));
      const sweep = document.createElement('div');
      sweep.className = 'fx-hud-sweep';
      sweep.style.cssText = 'left:' + left + 'px;top:' + top + 'px;width:' + (right - left) + 'px;height:' + (bot - top) + 'px;';
      this._fxLayer().appendChild(sweep);
      setTimeout(() => sweep.remove(), 760);
    }
    (targets || []).forEach((t, i) => {
      const el = this._fxCardElById(t.id); if (!el) return;
      setTimeout(() => this._fxRing(el, { color: '#ff3b3b', contract: true }), 260 + i * 90);
    });
    this._fxWhenPainted(self, (el) => {
      this._fxRing(el, { color: '#57d6ff', contract: true });
      const c = this._fxCenter(el);
      if (c) this._fxSparks(c, { color: '#e6fbff', glow: '#57d6ff', count: 10, spread: 50, size: 2.2 });
    });
  },
  // Jango Fett lands and lets the rockets fly into the lanes his splash hits.
  _fxJangoRockets(self, toLane) {
    if (this._reducedMotion() || !self || toLane == null) return;
    const opp = self.owner === 'player' ? 'ai' : 'player';
    const lanes = (typeof Game !== 'undefined' && Game.state && Game.state.lanes) || [];
    const pts = [];
    for (let i = toLane - 1; i <= toLane + 1; i++) {
      const c = lanes[i] && lanes[i][opp];
      if (c && c.currentHealth > 0) { const p = this._fxPt(c); if (p) pts.push(p); }
    }
    if (!pts.length) return;
    setTimeout(() => {                         // after his jet move lands
      const from = this._fxPt(self);
      if (!from) return;
      pts.forEach((p, i) => setTimeout(() => {
        this._fxSonicBoom(from.x, from.y, p.x - from.x, p.y - from.y, 'jet');
        setTimeout(() => {
          this._fxImpact(p, { color: '#ffb35a', core: '#fff2c8', size: 1.2 });
          this._fxSparks(p, { color: '#ffd38a', glow: '#ff6a1a', count: 10, spread: 50, size: 2.4 });
        }, 150);
      }, i * 110));
    }, 420);
  },
  // Sung Jin-Woo enters: every point of energy he cost pours out of his
  // owner's counter into him, then a violet aura erupts from the slot.
  _fxSungArise(self, energy) {
    if (this._reducedMotion() || !self) return;
    const dom = this._fxDomSide ? this._fxDomSide(self.owner) : self.owner;
    const src = this._fxCenter(document.getElementById(dom === 'player' ? 'player-energy-display' : 'ai-energy-display'));
    this._fxWhenPainted(self, (el) => {
      const to = this._fxCenter(el); if (!to) return;
      const n = Math.max(1, Math.min(10, energy | 0 || 3));
      if (src) for (let i = 0; i < n; i++) setTimeout(() => {
        const orb = document.createElement('div');
        orb.className = 'fx-energy-orb fx-energy-orb-violet';
        orb.style.cssText = 'left:' + src.x + 'px;top:' + src.y + 'px;';
        this._fxLayer().appendChild(orb);
        const dx = to.x - src.x, dy = to.y - src.y, lift = 40 + Math.random() * 60, side = (Math.random() - .5) * 80;
        const fr = [];
        for (let k = 0; k <= 10; k++) { const t = k / 10, e = t*t*(3 - 2*t);
          fr.push({ transform: 'translate(' + (dx*e + Math.sin(t*Math.PI)*side).toFixed(1) + 'px,' + (dy*e - Math.sin(t*Math.PI)*lift).toFixed(1) + 'px) scale(' + (1 - t*.4).toFixed(2) + ')', opacity: t < .1 ? t*10 : 1 }); }
        const an = orb.animate ? orb.animate(fr, { duration: 560, easing: 'linear', fill: 'forwards' }) : null;
        const end = () => orb.remove();
        if (an) an.onfinish = end; else setTimeout(end, 560);
      }, i * 70);
      setTimeout(() => {
        this._fxGasBurst(el, { color: '#4a1fbf' });
        this._fxRing(el, { color: '#9b6bff' });
        setTimeout(() => this._fxRing(el, { color: '#c7a8ff', contract: true }), 130);
        const c = this._fxCenter(el);
        if (c) this._fxSparks(c, { color: '#d9c8ff', glow: '#6a3dff', count: 18, angle: -Math.PI / 2, cone: 1.1, spread: 110, size: 2.6 });
        this._screenShake('light');
      }, n * 70 + 420);
    });
  },

  // ---- Jump entrances, Deadpool's swap, Wolverine's adamantium ----
  // A Jump is a jump-scare: the screen drops dark for a beat, a red flash
  // cuts, and the card SNAPS into its slot out of nowhere.
  _fxJumpIn(ev) {
    if (!ev || this._reducedMotion()) return;
    const go = () => {
      const el = document.querySelector('#board [data-card-id="' + ev.cardId + '"]') || this._fxCardElById(ev.cardId);
      if (!el) return;
      // A full-screen overlay, not a body class: body's class list is rewritten
      // by other systems mid-frame, which can eat the dim before it shows.
      const flash = document.createElement('div');
      flash.className = 'fx-jump-flash';
      this._fxLayer().appendChild(flash);
      setTimeout(() => flash.remove(), 460);
      el.classList.remove('fx-jump-snap'); void el.offsetWidth; el.classList.add('fx-jump-snap');
      setTimeout(() => el.classList.remove('fx-jump-snap'), 520);
      this._fxSlash(el, { count: 2, color: '#ff2b2b', angle: -24 });
      this._fxRing(el, { color: '#ff2b2b', contract: true });
      this._screenShake('light');
    };
    // WAIT FOR THE LANDING. A jump plays the card from the hand, so it spends
    // ~360ms in flight before its tile exists in the slot; firing on the next
    // frame would find nothing. Poll (bounded) for the landed, non-flying tile.
    let tries = 0;
    const poll = () => {
      const el = document.querySelector('#board [data-card-id="' + ev.cardId + '"]');
      if (el && !el.classList.contains('card-flying') && !el.classList.contains('card-enter')) { go(); return; }
      if (++tries < 90) requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  },
  // Deadpool's trade: a red card-shaped glint arcs between the two hands —
  // enemy -> his owner on the steal, back the other way on the give.
  _fxHandSwap(owner, dir) {
    if (this._reducedMotion()) return;
    const dom = this._fxDomSide ? this._fxDomSide(owner) : owner;
    const mine = document.getElementById(dom === 'player' ? 'player-hand' : 'ai-hand');
    const theirs = document.getElementById(dom === 'player' ? 'ai-hand' : 'player-hand');
    const a = this._fxCenter(dir === 'give' ? mine : theirs), b = this._fxCenter(dir === 'give' ? theirs : mine);
    if (!a || !b) return;
    const g = document.createElement('div');
    g.className = 'fx-swap-card';
    g.style.cssText = 'left:' + a.x + 'px;top:' + a.y + 'px;';
    this._fxLayer().appendChild(g);
    const dx = b.x - a.x, dy = b.y - a.y, bow = (dir === 'give' ? -1 : 1) * 160;
    const fr = [];
    for (let i = 0; i <= 14; i++) { const t = i / 14, e = t < .5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2)/2;
      fr.push({ transform: 'translate(' + (dx*e + Math.sin(t*Math.PI)*bow).toFixed(1) + 'px,' + (dy*e).toFixed(1) + 'px) rotate(' + (t*540).toFixed(0) + 'deg)', opacity: t < .1 ? t*10 : (t > .9 ? (1 - t)*10 : 1) }); }
    const an = g.animate ? g.animate(fr, { duration: 720, easing: 'linear', fill: 'forwards' }) : null;
    const end = () => { g.remove(); this._fxSparks(b, { color: '#ff8a8a', glow: '#d61a1a', count: 10, spread: 50, size: 2.4 }); };
    if (an) an.onfinish = end; else setTimeout(end, 720);
  },
  // Wolverine takes a hit: adamantium turns it — a shower of silver sparks.
  _fxAdamantium(self) {
    if (this._reducedMotion() || !self) return;
    const p = this._fxPt(self); if (!p) return;
    this._fxSparks(p, { color: '#f2f6fa', glow: '#9fb3c8', count: 12, angle: -Math.PI / 2, cone: 2.2, spread: 64, size: 2.2 });
  },

  // ---- Thanos / Darth Vader / Joker extras ----
  // Thanos' snap: a gold pulse bursts off him and a shimmer wave rolls across
  // the whole board (each erased enemy still gets _fxThanosDust).
  _fxThanosSnap(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      const c = this._fxCenter(el);
      this._fxRing(el, { color: '#ffd76b' });
      setTimeout(() => this._fxRing(el, { color: '#fff1bd', contract: true }), 120);
      if (c) {
        this._fxImpact(c, { color: '#ffd76b', core: '#ffffff', size: 2.2 });
        this._fxSparks(c, { color: '#fff1bd', glow: '#ffb31a', count: 20, spread: 120, size: 2.6 });
      }
      const board = document.querySelector('#board') || document.querySelector('.board');
      const r = board && board.getBoundingClientRect();
      if (r && r.width) {
        const wave = document.createElement('div');
        wave.className = 'fx-snap-wave';
        wave.style.cssText = 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;';
        this._fxLayer().appendChild(wave);
        setTimeout(() => wave.remove(), 900);
      }
      this._screenShake('light');
    });
  },
  // Vader's Force pull: a dark tendril reaches the target and a red ring
  // clamps onto it just before it's dragged to its new lane.
  _fxForcePull(self, target) {
    if (this._reducedMotion() || !self || !target) return;
    const to = this._fxPt(target), tEl = this._fxCardElById(target.id);
    if (!to) return;
    this._fxWhenPainted(self, (el) => {
      const from = this._fxCenter(el);
      if (from) this._fxTendril(from, to, { color: '#120004', glow: '#e01030', bow: 26 });
      if (tEl) this._fxRing(tEl, { color: '#e01030', contract: true });
      this._fxSparks(to, { color: '#ff6b6b', glow: '#8a0010', count: 10, spread: 46, size: 2.2 });
    });
  },
  // Joker's Crazy stamp: a burst of green-and-purple gas and spinning sparks
  // on the enemy that now carries the mark.
  _fxJokerCrazy(target) {
    if (this._reducedMotion() || !target) return;
    const el = this._fxCardElById(target.id); if (!el) return;
    this._fxGasBurst(el, { color: '#7cff4e' });
    setTimeout(() => this._fxGasBurst(el, { color: '#9b3dff' }), 140);
    this._fxRing(el, { color: '#b46bff', contract: true });
    const p = this._fxCenter(el);
    if (p) this._fxSparks(p, { color: '#d6ff9a', glow: '#9b3dff', count: 16, spread: 70, size: 2.6 });
  },

  // ---- Spider-Man / Venom / Captain America extras ----
  // Spider-Man dodges: a pale afterimage streak flicks off sideways and a ring
  // pulses as he grows; when the extra charge comes back, quick jagged
  // "tingle" rays radiate from him (abstract — light only).
  _fxSpiderDodge(self, sense) {
    if (this._reducedMotion() || !self) return;
    const el = this._fxCardElById(self.id); if (!el) return;
    const p = this._fxCenter(el); if (!p) return;
    if (!sense) {
      const dir = Math.random() < .5 ? -1 : 1;
      this._fxSonicBoom(p.x, p.y, dir * 70, -14);
      this._fxRing(el, { color: '#ff5a5a', contract: true });
    } else {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        this._fxDrawBolt({ x: p.x + Math.cos(a) * 18, y: p.y + Math.sin(a) * 18 }, { x: p.x + Math.cos(a) * 62, y: p.y + Math.sin(a) * 62 }, { color: '#ff8a8a' });
      }
      this._fxRing(el, { color: '#ffd0d0' });
    }
  },
  // Venom's heal: dark tendrils carry the life from him into his owner's HP bar,
  // which pulses as it fills.
  _fxSymbioteHeal(self) {
    if (this._reducedMotion() || !self) return;
    const dom = this._fxDomSide ? this._fxDomSide(self.owner) : self.owner;
    const bar = document.getElementById(dom === 'player' ? 'player-hp-fill' : 'ai-hp-fill');
    const to = this._fxCenter(bar);
    const el = this._fxCardElById(self.id);
    const from = this._fxCenter(el);
    if (!to || !from) return;
    for (let i = 0; i < 3; i++) setTimeout(() => {
      this._fxTendril(from, { x: to.x + (i - 1) * 40, y: to.y }, { color: '#0a0a0a', glow: '#e6e6e6', bow: 30 + i * 16 });
    }, i * 90);
    setTimeout(() => {
      this._fxImpact(to, { color: '#9dffb5', core: '#ffffff', size: 1.1 });
      this._fxSparks(to, { color: '#d6ffe0', glow: '#2fd66b', count: 12, angle: -Math.PI / 2, cone: 1.2, spread: 50, size: 2.2 });
    }, 380);
  },
  // Captain America's rally: a bright pulse sweeps along his owner's hand and
  // each card in it gets a small lift of light (the discount, shown).
  _fxRallyHand(self) {
    if (this._reducedMotion() || !self) return;
    const dom = this._fxDomSide ? this._fxDomSide(self.owner) : self.owner;
    const hand = document.getElementById(dom === 'player' ? 'player-hand' : 'ai-hand');
    if (!hand) return;
    const cards = Array.from(hand.children).filter(c => c.getBoundingClientRect().width);
    cards.forEach((c, i) => setTimeout(() => {
      this._fxRing(c, { color: '#9fd0ff', contract: true });
      const p = this._fxCenter(c);
      if (p) this._fxSparks(p, { color: '#ffffff', glow: '#3d8bff', count: 8, angle: -Math.PI / 2, cone: .8, spread: 44, size: 2.2 });
    }, 120 + i * 70));
    this._fxWhenPainted(self, (el) => this._fxRing(el, { color: '#3d8bff' }));
  },

  _fxEnergyTheft(owner) {
    if (this._reducedMotion()) return;
    const dom = this._fxDomSide ? this._fxDomSide(owner) : owner;
    const fromEl = document.getElementById(dom === 'player' ? 'ai-energy-display' : 'player-energy-display');
    const toEl = document.getElementById(dom === 'player' ? 'player-energy-display' : 'ai-energy-display');
    const a = this._fxCenter(fromEl), b = this._fxCenter(toEl);
    if (!a || !b) return;
    const layer = this._fxLayer();
    // three claw marks rake the enemy counter first
    const rake = document.createElement('div');
    rake.className = 'fx-catwoman-swipe fx-energy-rake';
    rake.style.cssText = 'left:' + (a.x - 34) + 'px;top:' + (a.y - 24) + 'px;width:68px;height:48px;';
    rake.innerHTML = '<i></i><i></i><i></i>';
    layer.appendChild(rake);
    setTimeout(() => rake.remove(), 520);
    const orb = document.createElement('div');
    orb.className = 'fx-energy-orb';
    orb.style.cssText = 'left:' + a.x + 'px;top:' + a.y + 'px;';
    layer.appendChild(orb);
    const dx = b.x - a.x, dy = b.y - a.y, lift = Math.max(60, Math.abs(dy) * .35);
    const frames = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12, e = t < .5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2)/2;
      frames.push({ transform: 'translate(' + (dx*e).toFixed(1) + 'px,' + (dy*e - Math.sin(t*Math.PI)*lift).toFixed(1) + 'px) scale(' + (1 + Math.sin(t*Math.PI)*.35).toFixed(2) + ')',
                    opacity: t < .08 ? t/.08 : 1 });
    }
    const go = () => {
      const an = orb.animate ? orb.animate(frames, { duration: 760, easing: 'linear', fill: 'forwards' }) : null;
      const end = () => { orb.remove(); try { this._fxRing(toEl, { color: '#ffcf6b', contract: true }); } catch (e) {}
        if (b) this._fxSparks({ x: b.x, y: b.y }, { color: '#ffe3a0', glow: '#ff9d2e', count: 8, spread: 40, size: 2.4 }); };
      if (an) an.onfinish = end; else setTimeout(end, 760);
    };
    setTimeout(go, 180);
    setTimeout(() => { if (orb.isConnected) orb.remove(); }, 1400);
  },
  // Invisible Woman: a force-field bubble snaps around the shielded ally, and
  // Sue herself shimmers half-invisible as she casts.
  _fxInvisibleWomanField(self, allyCard) {
    if (this._reducedMotion() || !self) return;
    if (allyCard) {
      const ael = this._fxCardElById(allyCard.id);
      if (ael) {
        this._fxRing(ael, { color: '#6fd0ff', contract: true });
        ael.classList.remove('fx-iw-shimmer'); void ael.offsetWidth; ael.classList.add('fx-iw-shimmer');
        setTimeout(() => ael.classList.remove('fx-iw-shimmer'), 620);
      }
    }
    this._fxWhenPainted(self, (el) => {
      el.classList.remove('fx-iw-shimmer'); void el.offsetWidth; el.classList.add('fx-iw-shimmer');
      setTimeout(() => el.classList.remove('fx-iw-shimmer'), 620);
    });
  },

  // =============== 2-cost character cast FX ===============

  // A generic bright blade-slash across a card (1+ diagonal strokes). Shared by
  // Gamora / Ghostface / Nightwing, each with its own colour + angle.
  _fxSlash(el, opts) {
    if (!el || this._reducedMotion()) return;
    opts = opts || {};
    const r = el.getBoundingClientRect();
    if (!r || !r.width) return;
    const layer = this._fxLayer();
    const n = opts.count || 1, color = opts.color || '#fff2d2', ang = (opts.angle != null ? opts.angle : 26);
    const wrap = document.createElement('div');
    wrap.className = 'fx-slash';
    wrap.style.cssText =
      'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;' +
      '--slash-ang:' + ang + 'deg;--slash-c:' + color + ';';
    let inner = '';
    for (let i = 0; i < n; i++) inner += '<i style="top:' + (32 + i * 24) + '%;animation-delay:' + (i * 80) + 'ms"></i>';
    wrap.innerHTML = inner;
    layer.appendChild(wrap);
    setTimeout(() => wrap.remove(), 520);
  },

  // Xenomorph — acid-blood burst on death: a spray of corrosive green globs
  // that arc out and drip down, over a green splash flash.
  _fxXenomorphAcid(self) {
    if (this._reducedMotion() || !self) return;
    const el = this._fxCardElById(self.id);
    const r = el ? el.getBoundingClientRect() : null;
    const pt = (r && r.width) ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    if (!pt) return;
    const layer = this._fxLayer();
    this._fxImpact(pt, { color: '#7fff5a', core: '#e6ffcf', size: 1.1 });
    for (let i = 0; i < 20; i++) {
      const g = document.createElement('div');
      g.className = 'fx-acid-glob';
      const a = Math.random() * Math.PI * 2, d = 28 + Math.random() * 66, sz = 3 + Math.random() * 4;
      g.style.cssText =
        'left:' + pt.x.toFixed(0) + 'px;top:' + pt.y.toFixed(0) + 'px;width:' + sz.toFixed(1) + 'px;height:' + sz.toFixed(1) + 'px;' +
        '--gx:' + (Math.cos(a) * d).toFixed(0) + 'px;--gy:' + (Math.sin(a) * d + 34).toFixed(0) + 'px;animation-delay:' + (Math.random() * 120).toFixed(0) + 'ms;';
      layer.appendChild(g);
      setTimeout(() => g.remove(), 840);
    }
    this._screenShake('light');
  },

  // Bane — Venom injection: a green surge pulses through him, then a toxic
  // tendril saps the target's strength (its ATK/evade stripped).
  _fxBaneVenom(self, targetCard) {
    if (this._reducedMotion() || !self) return;
    const tgtEl = targetCard ? this._fxCardElById(targetCard.id) : null;
    const to = tgtEl ? this._fxCenter(tgtEl) : null;
    if (tgtEl) this._fxRing(tgtEl, { color: '#57d957', contract: true });
    this._fxWhenPainted(self, (el) => {
      this._fxRing(el, { color: '#2fbf4f' });
      const from = this._fxCenter(el);
      if (from && to) this._fxTendril(from, to, { color: '#124d12', glow: '#57ff57', bow: 24 });
      if (to) this._fxSparks(to, { color: '#8dff8d', glow: '#2fbf4f', count: 8, spread: 42, size: 2.4 });
    });
  },

  // Dr. Strange — a golden Agamotto rune mandala spins open as he peers ahead.
  _fxStrangePortal(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      const c = this._fxCenter(el);
      if (!c) return;
      const layer = this._fxLayer();
      [1, 0.64].forEach((scale, i) => {
        const rune = document.createElement('div');
        rune.className = 'fx-strange-rune';
        rune.style.cssText = 'left:' + c.x + 'px;top:' + c.y + 'px;--rscale:' + scale + ';--rspin:' + (i ? -1 : 1) + ';animation-delay:' + (i * 90) + 'ms;';
        layer.appendChild(rune);
        setTimeout(() => rune.remove(), 780);
      });
      this._fxSparks(c, { color: '#ffd27a', glow: '#ff8a1e', count: 10, spread: 54, size: 2.4 });
    });
  },

  // Gamora — a clean blade execution: a green-white slash rakes the doomed
  // enemy and it falls apart.
  _fxGamoraBlade(self, victimCard) {
    if (this._reducedMotion() || !victimCard) return;
    const el = this._fxCardElById(victimCard.id);
    if (el) this._fxSlash(el, { count: 1, color: '#d6ffe6', angle: 34 });
    const to = this._fxCenter(el);
    if (to) this._fxSparks(to, { color: '#c9ffdd', glow: '#3ad980', count: 9, spread: 48, size: 2.6 });
    this._screenShake('light');
  },

  // Ghostface — a quick knife-slash streak and an eerie phantom flicker as a
  // second killer steps out of the shadows.
  _fxGhostfaceSlash(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      this._fxSlash(el, { count: 1, color: '#eef2ff', angle: -40 });
      el.classList.remove('fx-ghost-flicker'); void el.offsetWidth; el.classList.add('fx-ghost-flicker');
      setTimeout(() => el.classList.remove('fx-ghost-flicker'), 620);
    });
  },
  // Carnage — a red-symbiote frenzy: tendrils lash out to every enemy and feed
  // back into Carnage as he heals. Enemies recomputed on each client from
  // self.owner, so the MP guest rebuilds it from its own board.
  _fxCarnageFrenzy(self) {
    if (this._reducedMotion() || !self) return;
    const enemies = (typeof Game !== 'undefined' && Game.getEnemiesOf)
      ? Game.getEnemiesOf(self.owner).filter(e => e.currentHealth > 0) : [];
    const froms = enemies.map(e => this._fxCenter(this._fxCardElById(e.id))).filter(Boolean);
    this._fxWhenPainted(self, (el) => {
      el.classList.remove('fx-carnage-frenzy'); void el.offsetWidth; el.classList.add('fx-carnage-frenzy');
      setTimeout(() => el.classList.remove('fx-carnage-frenzy'), 700);
      this._fxRing(el, { color: '#e01e1e' });
      const to = this._fxCenter(el);
      froms.forEach((from, i) => setTimeout(() => { if (to) this._fxTendril(from, to, { color: '#5c0a0a', glow: '#ff3b3b', bow: 22 }); }, i * 70));
      if (to) this._fxSparks(to, { color: '#ff6b6b', glow: '#c81e1e', count: 12, angle: -Math.PI / 2, cone: 1.9, spread: 60, size: 2.8 });
    });
  },
  // Michael Myers — the stalk: a cold steel knife-glint slashes across him and
  // he darkens into shadow as he steps in (normal play or jump).
  _fxMyersStalk(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      el.classList.remove('fx-myers-stalk'); void el.offsetWidth; el.classList.add('fx-myers-stalk');
      setTimeout(() => el.classList.remove('fx-myers-stalk'), 720);
      this._fxSlash(el, { count: 1, color: '#dfe8f0', angle: -52 });
      const c = this._fxCenter(el);
      if (c) this._fxSparks(c, { color: '#cfd8e3', glow: '#8fa0b3', count: 6, spread: 38, size: 2.2 });
    });
  },
  // Green Lantern — his ring flares emerald willpower as it channels the
  // round's damage into energy.
  _fxGreenLantern(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      this._fxRing(el, { color: '#2fe36b' });
      el.classList.remove('fx-lantern-glow'); void el.offsetWidth; el.classList.add('fx-lantern-glow');
      setTimeout(() => el.classList.remove('fx-lantern-glow'), 700);
      const c = this._fxCenter(el);
      if (c) this._fxSparks(c, { color: '#8dffb0', glow: '#17c04a', count: 12, spread: 58, size: 2.8 });
    });
  },
  // Han Solo — draws first: a blaster muzzle-flash, a bolt streaking off, and a
  // quick recoil on the card.
  _fxHanBlaster(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      const from = this._fxCenter(el);
      if (!from) return;
      this._fxImpact(from, { color: '#ff5a2e', core: '#ffe6a0', size: 0.6 });
      this._fxDrawBeam(from, { x: from.x + 170, y: from.y - 26 }, { color: '#ff5a2e', core: '#fff0c8', thickness: 4, impact: 0.8 });
      this._fxSparks(from, { color: '#ffd27a', glow: '#ff5a2e', count: 8, spread: 44, size: 2.6 });
      el.classList.remove('fx-han-recoil'); void el.offsetWidth; el.classList.add('fx-han-recoil');
      setTimeout(() => el.classList.remove('fx-han-recoil'), 380);
    });
  },
  // Droideka — shields UP: a blue deflector snaps around him (Damage Immunity).
  // Shields DOWN: the twin blasters overcharge red-hot (triple ATK). The
  // ability calls this on the shield toggle; `shieldsUp` picks the mode.
  _fxDroidekaShield(self, shieldsUp) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      const c = this._fxCenter(el);
      if (shieldsUp) {
        this._fxRing(el, { color: '#4aa3ff', contract: true });
        el.classList.remove('fx-droideka-shield'); void el.offsetWidth; el.classList.add('fx-droideka-shield');
        setTimeout(() => el.classList.remove('fx-droideka-shield'), 700);
        if (c) this._fxSparks(c, { color: '#bfe4ff', glow: '#2f7fff', count: 10, spread: 52, size: 2.4 });
      } else {
        this._fxRing(el, { color: '#ff5a2e' });
        el.classList.remove('fx-droideka-overcharge'); void el.offsetWidth; el.classList.add('fx-droideka-overcharge');
        setTimeout(() => el.classList.remove('fx-droideka-overcharge'), 700);
        if (c) this._fxSparks(c, { color: '#ffd27a', glow: '#ff3b0a', count: 12, spread: 60, size: 2.8 });
      }
    });
  },
  // Professor X — a telepathic seizure: violet psi-rings pulse out of the
  // enemy's head as its mind is turned and it flips to your side.
  _fxProfessorX(targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const el = this._fxCardElById(targetCard.id);
    const to = this._fxCenter(el);
    if (!to) return;
    const layer = this._fxLayer();
    for (let i = 0; i < 4; i++) {
      setTimeout(() => {
        const ring = document.createElement('div');
        ring.className = 'fx-psi-ripple';
        ring.style.cssText = 'left:' + to.x.toFixed(0) + 'px;top:' + to.y.toFixed(0) + 'px;';
        layer.appendChild(ring);
        setTimeout(() => ring.remove(), 720);
      }, i * 120);
    }
    if (el) {
      this._fxRing(el, { color: '#e0b0ff', contract: true });
      el.classList.remove('fx-profx-convert'); void el.offsetWidth; el.classList.add('fx-profx-convert');
      setTimeout(() => el.classList.remove('fx-profx-convert'), 800);
    }
    this._fxSparks(to, { color: '#efd6ff', glow: '#a24bff', count: 12, spread: 56, size: 2.6 });
  },
  // Jack Sparrow — parlay: a gold spectral shimmer holds the enemy in place so
  // it can't attack this round.
  _fxParlay(targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const el = this._fxCardElById(targetCard.id);
    if (!el) return;
    this._fxRing(el, { color: '#e8c05a' });
    el.classList.remove('fx-parlay-hold'); void el.offsetWidth; el.classList.add('fx-parlay-hold');
    setTimeout(() => el.classList.remove('fx-parlay-hold'), 700);
    const c = this._fxCenter(el);
    if (c) this._fxSparks(c, { color: '#ffe9a8', glow: '#c8962e', count: 9, spread: 48, size: 2.4 });
  },
  // Freddy Fazbear — the animatronic glitches red as it drains a stray Energy.
  _fxFazbearGlitch(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      el.classList.remove('fx-fazbear-glitch'); void el.offsetWidth; el.classList.add('fx-fazbear-glitch');
      setTimeout(() => el.classList.remove('fx-fazbear-glitch'), 620);
      const c = this._fxCenter(el);
      if (c) this._fxSparks(c, { color: '#ff6b6b', glow: '#7a0d22', count: 8, spread: 46, size: 2.4 });
    });
  },

  // Human Torch — Flame On! He combusts and hurls a fireball at the blast target.
  _fxHumanTorchFlame(self, targetCard) {
    if (this._reducedMotion() || !self) return;
    const to = targetCard ? this._fxCenter(this._fxCardElById(targetCard.id)) : null;
    this._fxWhenPainted(self, (el) => {
      el.classList.remove('fx-torch-ignite'); void el.offsetWidth; el.classList.add('fx-torch-ignite');
      setTimeout(() => el.classList.remove('fx-torch-ignite'), 640);
      const from = this._fxCenter(el);
      if (from) this._fxSparks(from, { color: '#ffd27a', glow: '#ff5a1e', count: 12, spread: 60, size: 3 });
      if (from && to) {
        this._fxDrawBeam(from, to, { color: '#ff7a18', core: '#ffe6a0', thickness: 7, impact: 1.2 });
        this._fxSparks(to, { color: '#ffd27a', glow: '#ff5a1e', count: 10, spread: 62, size: 3 });
      }
    });
  },

  // Nightwing — twin escrima strikes flash blue across the weakened enemy.
  _fxNightwingStrike(self, targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const el = this._fxCardElById(targetCard.id);
    const to = this._fxCenter(el);
    if (el) this._fxSlash(el, { count: 2, color: '#9bd3ff', angle: 22 });
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from && to) this._fxDrawBolt(from, to, { color: '#9bd3ff', glow: '#2f7fff' });
    });
  },

  // Peacemaker — one clean shot: muzzle flash, a bright tracer, the target drops.
  _fxPeacemakerShot(self, victimCard) {
    if (this._reducedMotion() || !victimCard) return;
    const to = this._fxCenter(this._fxCardElById(victimCard.id));
    if (!to) return;
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (!from) return;
      this._fxImpact(from, { color: '#ffd27a', core: '#ffffff', size: 0.5 });
      this._fxDrawBeam(from, to, { color: '#fff2c8', core: '#ffffff', thickness: 3, impact: 1.1 });
      this._screenShake('light');
    });
  },

  // Rocket Raccoon — a heavy blaster bolt with a big muzzle flash and kick.
  _fxRocketBlast(self, targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const to = this._fxCenter(this._fxCardElById(targetCard.id));
    if (!to) return;
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (!from) return;
      const ang = Math.atan2(to.y - from.y, to.x - from.x);
      this._fxImpact(from, { color: '#ff7a2e', core: '#ffe6a0', size: 0.7 });
      this._fxSparks(from, { color: '#ffe0a0', glow: '#ff7a2e', count: 6, angle: ang, cone: 0.9, spread: 40, size: 2.6 });
      this._fxDrawBeam(from, to, { color: '#ff8a2e', core: '#fff0c8', thickness: 6, impact: 1.3 });
      this._screenShake('medium');
    });
  },

  // The Flash — a Speed-Force dash: a lightning blur streaks across him and a
  // bolt arcs to the frozen enemy.
  _fxFlashDash(self, targetCard) {
    if (this._reducedMotion() || !self) return;
    const to = targetCard ? this._fxCenter(this._fxCardElById(targetCard.id)) : null;
    this._fxWhenPainted(self, (el) => {
      el.classList.remove('fx-flash-dash'); void el.offsetWidth; el.classList.add('fx-flash-dash');
      setTimeout(() => el.classList.remove('fx-flash-dash'), 560);
      const from = this._fxCenter(el);
      if (from && to) this._fxDrawBolt(from, to, { color: '#ffe45a', glow: '#ffae00' });
      if (from) this._fxSparks(from, { color: '#fff2a0', glow: '#ffae00', count: 9, spread: 56, size: 2.4 });
    });
  },

  // Symbiote Spider-Man — black symbiote tendrils lash out in a fan and a green
  // heal pulse washes over him.
  _fxSymbioteSurge(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      const c = this._fxCenter(el);
      if (!c) return;
      for (let i = 0; i < 5; i++) {
        const ang = -Math.PI / 2 + (i - 2) * 0.5;
        const to = { x: c.x + Math.cos(ang) * 120, y: c.y + Math.sin(ang) * 120 };
        this._fxTendril(c, to, { color: '#0b0b0b', glow: '#c1121f', bow: 18 });
      }
      this._fxRing(el, { color: '#3ad980', contract: true });
    });
  },

  // =============== 3-cost character cast FX ===============

  // Resolve an on-screen point for an enemy in a lane — the card centre if one
  // is there, else the lane slot centre. Used by lane-targeted casts.
  _fxLanePoint(lane, owner) {
    if (typeof Game === 'undefined' || lane == null || lane < 0) return null;
    const opp = Game.opponent(owner);
    const e = Game.state.lanes[lane] && Game.state.lanes[lane][opp];
    if (e) { const c = this._fxCenter(this._fxCardElById(e.id)); if (c) return c; }
    const slots = document.querySelectorAll('#board .card-slot');
    const slot = slots[lane];
    if (slot) { const r = slot.getBoundingClientRect(); if (r.width) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
    return null;
  },

  // Deathstroke — a mercenary assassination: an orange blade-rake and a clean
  // tracer drop the target.
  _fxDeathstrokeKill(self, victimCard) {
    if (this._reducedMotion() || !victimCard) return;
    const el = this._fxCardElById(victimCard.id);
    const to = this._fxCenter(el);
    if (el) this._fxSlash(el, { count: 1, color: '#ffb14d', angle: 30 });
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from && to) this._fxDrawBeam(from, to, { color: '#ff9d2e', core: '#fff0c8', thickness: 3, impact: 1.1 });
    });
    this._screenShake('light');
  },

  // Green Goblin — pumpkin bombs lobbed onto both adjacent lanes, bursting green.
  _fxGoblinBombs(self, lane, owner) {
    if (this._reducedMotion() || typeof Game === 'undefined') return;
    [lane - 1, lane + 1].forEach((li, i) => {
      if (li < 0 || li >= Game.LANE_COUNT) return;
      const pt = this._fxLanePoint(li, owner);
      if (!pt) return;
      setTimeout(() => {
        this._fxImpact(pt, { color: '#7fff5a', core: '#e6ffcf', size: 1.2 });
        this._fxSparks(pt, { color: '#b6ff8f', glow: '#3fae2f', count: 12, spread: 64, size: 3 });
      }, i * 120);
    });
    this._screenShake('light');
  },

  // Groot — protective bark: green-brown guard rings snap around adjacent allies.
  _fxGrootGuard(self, lane, owner) {
    if (this._reducedMotion() || typeof Game === 'undefined') return;
    [lane - 1, lane + 1].forEach((li) => {
      if (li < 0 || li >= Game.LANE_COUNT) return;
      const a = Game.state.lanes[li] && Game.state.lanes[li][owner];
      if (a) { const el = this._fxCardElById(a.id); if (el) this._fxRing(el, { color: '#8ec06a' }); }
    });
    this._fxWhenPainted(self, (el) => {
      this._fxRing(el, { color: '#5a8a3a' });
      const c = this._fxCenter(el);
      if (c) this._fxSparks(c, { color: '#c8e6a0', glow: '#5a8a3a', count: 8, angle: -Math.PI / 2, cone: 1.8, spread: 48, size: 2.6 });
    });
  },

  // Loki — green Asgardian sorcery swirls up as he charges the Block Meter.
  _fxLokiMagic(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      this._fxRing(el, { color: '#3ad980' });
      const c = this._fxCenter(el);
      if (c) this._fxSparks(c, { color: '#8dffbf', glow: '#1fbf6a', count: 12, angle: -Math.PI / 2, cone: 1.9, spread: 64, size: 2.6 });
    });
  },

  // Moder — a dark serpent coil drags the lane and a null-burst silences it.
  _fxModerCoil(self, lane, owner) {
    if (this._reducedMotion() || !self) return;
    const to = this._fxLanePoint(lane, owner);
    this._fxWhenPainted(self, (el) => {
      const from = this._fxCenter(el);
      if (from && to) this._fxTendril(from, to, { color: '#160f2b', glow: '#8a5bff', bow: 30 });
      if (to) this._fxImpact(to, { color: '#8a5bff', core: '#e0d4ff', size: 1.0 });
    });
  },
  // Played on the enemy card Art hits. The neon glyph flies in / stamps while
  // the shared spark & impact primitives sell the blow, plus a hit-shake.
  _fxArtWeapon(weapon, el) {
    if (!el || (this._reducedMotion && this._reducedMotion())) return;
    const c = this._fxCenter ? this._fxCenter(el) : null;
    if (!c) return;
    const layer = this._fxLayer ? this._fxLayer() : null;
    const glyph = (iconKey, cls, ms) => {
      if (!layer) return;
      const svg = this.ART_WEAPON_ICONS[iconKey];
      if (!svg) return;
      const g = document.createElement('div');
      g.className = 'fx-art-weapon ' + cls;
      g.innerHTML = svg;
      g.style.cssText = 'left:' + c.x + 'px;top:' + c.y + 'px;';
      layer.appendChild(g);
      setTimeout(() => g.remove(), ms || 720);
    };
    const shake = (cls) => {
      el.classList.remove('fx-art-hit', 'fx-art-hit-heavy');
      void el.offsetWidth;
      el.classList.add(cls);
      setTimeout(() => el.classList.remove(cls), 620);
    };
    const at = (ms, fn) => setTimeout(fn, ms);
    switch (weapon) {
      case 'scissors':
        // Blades fly in and close; two quick snips cross the card as the cut.
        glyph('scissors', 'fx-art-scissors', 720);
        if (this._fxSlashEl) {
          at(190, () => this._fxSlashEl(el, { blade: '#8fe9ff', core: '#eaffff', angle: -7 }));
          at(310, () => this._fxSlashEl(el, { blade: '#8fe9ff', core: '#eaffff', angle: 7 }));
        }
        if (this._fxSparks) at(250, () => this._fxSparks(c, { color: '#dfe7ee', glow: '#9fb3c8', count: 10, spread: 46, size: 2.2 }));
        at(250, () => shake('fx-art-hit'));
        break;
      case 'sledgehammer':
        // Drops from above; impact, sparks, shake and a light screen jolt all
        // land together on the ~350ms slam frame, not at the top of the swing.
        glyph('sledgehammer', 'fx-art-sledge', 640);
        at(330, () => {
          if (this._fxImpact) this._fxImpact(c, { color: '#38e6ff', core: '#d6faff', size: 1.5 });
          if (this._fxSparks) this._fxSparks(c, { color: '#9fe9ff', glow: '#0f9bd6', count: 18, spread: 84, size: 3.3 });
          if (this._screenShake) this._screenShake('light');
          shake('fx-art-hit-heavy');
        });
        break;
      case 'scythe':
        // One sweeping arc; a clean diagonal cut flashes along its path.
        glyph('scythe', 'fx-art-scythe', 700);
        at(300, () => {
          if (this._fxSlashEl) this._fxSlashEl(el, { blade: '#38e6ff', core: '#eaffff', angle: 42 });
          if (this._fxSparks) this._fxSparks(c, { color: '#b8f4ff', glow: '#17b6e6', count: 14, angle: -Math.PI / 4, cone: 0.6, spread: 80, size: 2.8 });
          shake('fx-art-hit');
        });
        break;
      case 'hacksaw':
        // Saws back and forth; two red cuts open the wound as it drags → bleed.
        glyph('hacksaw', 'fx-art-hacksaw', 760);
        if (this._fxSlashEl) {
          at(150, () => this._fxSlashEl(el, { blade: '#ff5470', core: '#ffd6dd', angle: 6 }));
          at(380, () => this._fxSlashEl(el, { blade: '#ff5470', core: '#ffd6dd', angle: -3 }));
        }
        if (this._fxSparks) at(260, () => this._fxSparks(c, { color: '#ff5470', glow: '#b3122f', count: 12, spread: 60, size: 2.6 }));
        at(220, () => shake('fx-art-hit'));
        break;
      case 'bleedTick':
        // A bead of blood wells up and falls — small, red, no shake.
        glyph('bleed', 'fx-art-bleed', 820);
        if (this._fxSparks) this._fxSparks(c, { color: '#e0244d', glow: '#7a0d22', count: 8, angle: Math.PI / 2, cone: 0.7, spread: 40, size: 2.4 });
        break;
    }
  },
  // Red Skull — a Cosmic-Cube red energy surge empowering a card in hand.
  _fxRedSkullCube(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      const c = this._fxCenter(el);
      if (!c) return;
      this._fxImpact(c, { color: '#ff3b3b', core: '#ffd0d0', size: 1.0 });
      this._fxSparks(c, { color: '#ffb0b0', glow: '#ff2d2d', count: 12, spread: 60, size: 2.8 });
      this._fxRing(el, { color: '#ff3b3b' });
    });
  },

  // Scarlet Witch — chaos magic: a crimson hex glyph spins out of her hands and
  // a hex tendril links to the enemy she mirrors.
  _fxScarletHex(self, targetCard) {
    if (this._reducedMotion() || !self) return;
    const to = targetCard ? this._fxCenter(this._fxCardElById(targetCard.id)) : null;
    this._fxWhenPainted(self, (el) => {
      const c = this._fxCenter(el);
      if (!c) return;
      const layer = this._fxLayer();
      [1, 0.6].forEach((scale, i) => {
        const hex = document.createElement('div');
        hex.className = 'fx-scarlet-hex';
        hex.style.cssText = 'left:' + c.x + 'px;top:' + c.y + 'px;--hscale:' + scale + ';--hspin:' + (i ? -1 : 1) + ';animation-delay:' + (i * 80) + 'ms;';
        layer.appendChild(hex);
        setTimeout(() => hex.remove(), 840);
      });
      this._fxSparks(c, { color: '#ff6b6b', glow: '#d1112f', count: 12, spread: 58, size: 2.6 });
      if (to) this._fxTendril(c, to, { color: '#7a0016', glow: '#ff3b5c', bow: 22 });
    });
  },

  // Solomon Grundy — grave mist and a purple soul-flare as he crawls back for a
  // Dead-Pile card.
  _fxGrundyGrave(self) {
    if (this._reducedMotion() || !self) return;
    const el = this._fxCardElById(self.id);
    const r = el ? el.getBoundingClientRect() : null;
    const pt = (r && r.width) ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    if (!pt) return;
    this._fxImpact(pt, { color: '#9b8bbf', core: '#e0d6f0', size: 1.0 });
    this._fxSparks(pt, { color: '#c9bfe0', glow: '#6b4f9e', count: 16, angle: -Math.PI / 2, cone: 2.2, spread: 72, size: 3 });
    this._screenShake('light');
  },

  // Star-Lord — an outlaw rally: a warm energy stream lifts the buffed ally.
  _fxStarLordRally(self, allyCard) {
    if (this._reducedMotion() || !self) return;
    const ael = allyCard ? this._fxCardElById(allyCard.id) : null;
    const to = this._fxCenter(ael);
    if (to) this._fxSparks(to, { color: '#ffd27a', glow: '#ff8a1e', count: 10, angle: -Math.PI / 2, cone: 1.6, spread: 56, size: 2.6 });
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from && to) this._fxDrawBeam(from, to, { color: '#ffb14d', core: '#fff0c8', thickness: 5 });
    });
  },

  // Winter Soldier — a cold, clean sniper shot from his metal arm.
  _fxWinterShot(self, victimCard) {
    if (this._reducedMotion() || !victimCard) return;
    const to = this._fxCenter(this._fxCardElById(victimCard.id));
    if (!to) return;
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (!from) return;
      this._fxImpact(from, { color: '#9bd3ff', core: '#ffffff', size: 0.5 });
      this._fxDrawBeam(from, to, { color: '#cfe6ff', core: '#ffffff', thickness: 3, impact: 1.1 });
      this._screenShake('light');
    });
  },

  // Optimus Prime — a blue command pulse orders an ally to strike.
  _fxOptimusCommand(self, allyCard) {
    if (this._reducedMotion() || !allyCard) return;
    const ael = this._fxCardElById(allyCard.id);
    const to = this._fxCenter(ael);
    if (ael) this._fxRing(ael, { color: '#3a86ff' });
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from && to) this._fxDrawBeam(from, to, { color: '#3a86ff', core: '#cfe0ff', thickness: 5 });
    });
  },

  // Raven — Soul-Self: a dark raven of energy bursts out in a fan of wings,
  // wiping the enemy's Block Meter and thawing her allies.
  _fxRavenSoul(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      const c = this._fxCenter(el);
      if (!c) return;
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i - 2.5) * 0.42;
        const to = { x: c.x + Math.cos(a) * 110, y: c.y + Math.sin(a) * 110 };
        this._fxTendril(c, to, { color: '#0c0a18', glow: '#7a3bff', bow: 16 });
      }
      this._fxImpact(c, { color: '#7a3bff', core: '#d8c8ff', size: 1.1 });
    });
  },

  // The Grinch — a sneaky green grab: a swipe and a mischievous green sparkle.
  _fxGrinchGrab(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      this._fxSlash(el, { count: 1, color: '#8ef07a', angle: -28 });
      const c = this._fxCenter(el);
      if (c) this._fxSparks(c, { color: '#b6ff8f', glow: '#2fae2f', count: 10, spread: 54, size: 2.6 });
    });
  },

  // =============== 4-cost character cast FX ===============

  // Anti-Venom — white healing symbiote: pale tendrils lash out and a
  // restorative pulse washes over him as he heals.
  _fxAntiVenomHeal(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      const c = this._fxCenter(el);
      if (!c) return;
      for (let i = 0; i < 4; i++) {
        const a = -Math.PI / 2 + (i - 1.5) * 0.5;
        const to = { x: c.x + Math.cos(a) * 100, y: c.y + Math.sin(a) * 100 };
        this._fxTendril(c, to, { color: '#e8f0ff', glow: '#9fe8c0', bow: 16 });
      }
      this._fxRing(el, { color: '#7fe6b0', contract: true });
      this._fxSparks(c, { color: '#d6ffe6', glow: '#3ad980', count: 8, angle: -Math.PI / 2, cone: 1.8, spread: 46, size: 2.4 });
    });
  },

  // Black Panther — a Vibranium kinetic discharge: stored energy releases in a
  // violet shockwave.
  _fxBlackPantherKinetic(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      this._fxRing(el, { color: '#a24bff' });
      const c = this._fxCenter(el);
      if (c) {
        this._fxImpact(c, { color: '#8a5bff', core: '#e0d4ff', size: 0.9 });
        this._fxSparks(c, { color: '#c9b0ff', glow: '#7a3bff', count: 12, spread: 60, size: 2.6 });
      }
    });
  },

  // Deadpool — chaotic regeneration: a red katana slash and a spray of
  // red-white sparks as his final trick fires.
  _fxDeadpoolChaos(self) {
    if (this._reducedMotion() || !self) return;
    const el = this._fxCardElById(self.id);
    if (!el) return;
    this._fxSlash(el, { count: 2, color: '#ff5252', angle: -32 });
    const c = this._fxCenter(el);
    if (c) this._fxSparks(c, { color: '#ffd0d0', glow: '#c1121f', count: 12, spread: 60, size: 2.8 });
    this._screenShake('light');
  },

  // Jason Voorhees — he rises again: a dark-red horror pulse and a machete rake.
  _fxJasonRevive(self) {
    if (this._reducedMotion() || !self) return;
    const el = this._fxCardElById(self.id);
    if (!el) return;
    this._fxSlash(el, { count: 1, color: '#ff5a5a', angle: 34 });
    this._fxRing(el, { color: '#8a1220' });
    const c = this._fxCenter(el);
    if (c) this._fxSparks(c, { color: '#ff9a9a', glow: '#8a1220', count: 10, spread: 54, size: 2.6 });
    this._screenShake('medium');
  },

  // Paul Atreides — prescience: a golden-blue spice vision swirls as he reads
  // the futures.
  _fxPaulVision(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      this._fxRing(el, { color: '#e8b24a' });
      const c = this._fxCenter(el);
      if (!c) return;
      this._fxSparks(c, { color: '#ffe0a0', glow: '#d98f2e', count: 9, spread: 56, size: 2.4 });
      this._fxSparks(c, { color: '#bcdcff', glow: '#4a86c8', count: 7, spread: 62, size: 2.2 });
    });
  },

  // Martian Manhunter — a green Martian phase-shift as he adopts a fallen kit.
  _fxMartianShift(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      el.classList.remove('fx-iw-shimmer'); void el.offsetWidth; el.classList.add('fx-iw-shimmer');
      setTimeout(() => el.classList.remove('fx-iw-shimmer'), 620);
      this._fxRing(el, { color: '#3ad980' });
      const c = this._fxCenter(el);
      if (c) this._fxSparks(c, { color: '#a8ffce', glow: '#1fbf6a', count: 11, spread: 58, size: 2.6 });
    });
  },

  // Predator — a shoulder-cannon plasma bolt: a red tri-laser paint, then a
  // green plasma lance to the target.
  _fxPredatorPlasma(self, targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const to = this._fxCenter(this._fxCardElById(targetCard.id));
    if (!to) return;
    this._fxImpact(to, { color: '#ff2d2d', core: '#ffd0d0', size: 0.55 });
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from) this._fxDrawBeam(from, to, { color: '#7fff5a', core: '#e6ffcf', thickness: 5, impact: 1.2 });
    });
  },

  // Wolverine — SNIKT: three adamantium claws rake the attacker he retaliates on.
  _fxWolverineClaws(self, targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const el = this._fxCardElById(targetCard.id);
    if (!el) return;
    this._fxSlash(el, { count: 3, color: '#dfe8f0', angle: 28 });
    const c = this._fxCenter(el);
    if (c) this._fxSparks(c, { color: '#ffffff', glow: '#9fb4c8', count: 9, spread: 46, size: 2.4 });
    this._screenShake('light');
  },

  // Wolverine — berserker rage on revive: a yellow-and-blue fury burst.
  _fxWolverineRage(self) {
    if (this._reducedMotion() || !self) return;
    const el = this._fxCardElById(self.id);
    if (!el) return;
    this._fxRing(el, { color: '#ffd23a' });
    const c = this._fxCenter(el);
    if (c) this._fxSparks(c, { color: '#fff0a0', glow: '#3a6cff', count: 12, spread: 60, size: 2.8 });
    this._screenShake('medium');
  },

  // Wonder Woman — the Lasso of Truth whips out in gold to the frozen enemy.
  _fxWonderWomanLasso(self, targetCard) {
    if (this._reducedMotion() || !self) return;
    const to = targetCard ? this._fxCenter(this._fxCardElById(targetCard.id)) : null;
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from && to) this._fxTendril(from, to, { color: '#8a5a12', glow: '#ffd23a', bow: 26 });
      this._fxRing(srcEl, { color: '#ffd23a' });
      if (to) this._fxSparks(to, { color: '#fff0b0', glow: '#e0a020', count: 9, spread: 48, size: 2.6 });
    });
  },

  // Homelander — heat vision: twin red eye-beams lance the target.
  _fxHomelanderLaser(self, targetCard) {
    if (this._reducedMotion() || !targetCard) return;
    const to = this._fxCenter(this._fxCardElById(targetCard.id));
    if (!to) return;
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (!from) return;
      this._fxDrawBeam({ x: from.x - 10, y: from.y }, to, { color: '#ff2d2d', core: '#ffffff', thickness: 4, impact: 1.2 });
      this._fxDrawBeam({ x: from.x + 10, y: from.y }, to, { color: '#ff2d2d', core: '#ffffff', thickness: 4 });
      this._screenShake('light');
    });
  },

  // =============== 5-cost character cast FX ===============

  // Davy Jones — the deep answers: briny tentacles rise in a fan and a teal
  // sea-burst churns as he calls the Kraken.
  _fxDavyKraken(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      const c = this._fxCenter(el);
      if (!c) return;
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i - 2) * 0.5;
        const to = { x: c.x + Math.cos(a) * 120, y: c.y + Math.sin(a) * 120 };
        this._fxTendril(c, to, { color: '#08201e', glow: '#2fd6c0', bow: 22 });
      }
      this._fxImpact(c, { color: '#2fd6c0', core: '#d6fff6', size: 1.0 });
      this._fxSparks(c, { color: '#9ff0e0', glow: '#1a8f80', count: 10, spread: 58, size: 2.6 });
    });
  },

  // Captain America — a shield snaps onto the ally: a red-white-blue guard ring
  // and a patriotic spark.
  _fxCapShield(self, allyCard) {
    if (this._reducedMotion() || !allyCard) return;
    const ael = this._fxCardElById(allyCard.id);
    if (!ael) return;
    this._fxRing(ael, { color: '#3a6cff', contract: true });
    const c = this._fxCenter(ael);
    if (c) {
      this._fxImpact(c, { color: '#3a6cff', core: '#ffffff', size: 0.9 });
      this._fxSparks(c, { color: '#ffffff', glow: '#ff3b3b', count: 8, spread: 46, size: 2.4 });
    }
  },

  // Iron Man — a repulsor beam finishes off each damaged enemy in the sweep.
  _fxIronManRepulsor(self, targetCard, seq) {
    if (this._reducedMotion() || !targetCard) return;
    const to = this._fxCenter(this._fxCardElById(targetCard.id));
    if (!to) return;
    const fire = () => this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from) this._fxDrawBeam(from, to, { color: '#57d6ff', core: '#ffffff', thickness: 5, impact: 1.2 });
    });
    if (seq == null) fire(); else setTimeout(fire, 520 + seq * 140);   // after the scan locks on
  },

  // The Batman Who Laughs — a sinister hex coils out: black tendrils and a
  // blood-red ring set the intercept trap.
  _fxBWLHex(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      const c = this._fxCenter(el);
      if (!c) return;
      for (let i = 0; i < 4; i++) {
        const a = -Math.PI / 2 + (i - 1.5) * 0.55;
        const to = { x: c.x + Math.cos(a) * 105, y: c.y + Math.sin(a) * 105 };
        this._fxTendril(c, to, { color: '#0a0a0a', glow: '#e01030', bow: 18 });
      }
      this._fxRing(el, { color: '#e01030' });
      this._fxSparks(c, { color: '#ff5a6e', glow: '#a00018', count: 10, spread: 56, size: 2.6 });
    });
  },

  // Revan — a violet Force current flows to the chosen ally, blessing it with
  // a second life.
  _fxRevanForce(self, allyCard) {
    if (this._reducedMotion() || !self) return;
    const ael = allyCard ? this._fxCardElById(allyCard.id) : null;
    const to = this._fxCenter(ael);
    if (ael) this._fxRing(ael, { color: '#b06bff', contract: true });
    this._fxWhenPainted(self, (srcEl) => {
      const from = this._fxCenter(srcEl);
      if (from && to) this._fxDrawBeam(from, to, { color: '#a24bff', core: '#e9d4ff', thickness: 5 });
      if (to) this._fxSparks(to, { color: '#d8c8ff', glow: '#7a3bff', count: 9, spread: 48, size: 2.6 });
    });
  },

  // =============== 6-cost character cast FX ===============

  // Obi-Wan — "You can't win, Darth." He becomes one with the Force: a blue
  // spectral fade on himself and a disarming pulse strips the enemy opposite.
  _fxObiOneWithForce(self, targetCard) {
    if (this._reducedMotion() || !self) return;
    const el = this._fxCardElById(self.id);
    const from = this._fxCenter(el);
    const tel = targetCard ? this._fxCardElById(targetCard.id) : null;
    const to = this._fxCenter(tel);
    if (el) {
      el.classList.remove('fx-iw-shimmer'); void el.offsetWidth; el.classList.add('fx-iw-shimmer');
      setTimeout(() => el.classList.remove('fx-iw-shimmer'), 620);
    }
    if (tel) this._fxRing(tel, { color: '#6fd0ff', contract: true });
    if (from && to) this._fxDrawBeam(from, to, { color: '#9bd3ff', core: '#eaf6ff', thickness: 4 });
    if (to) this._fxSparks(to, { color: '#cfeaff', glow: '#4aa3ff', count: 8, spread: 46, size: 2.4 });
  },

  // General Grievous — a whirling four-lightsaber flourish as he takes the
  // field, with a shower of mechanical sparks.
  _fxGrievousSabers(self) {
    if (this._reducedMotion() || !self) return;
    this._fxWhenPainted(self, (el) => {
      const c = this._fxCenter(el);
      if (!c) return;
      const layer = this._fxLayer();
      const spin = document.createElement('div');
      spin.className = 'fx-grievous-sabers';
      spin.style.cssText = 'left:' + c.x + 'px;top:' + c.y + 'px;';
      const cols = ['#4aa3ff', '#4caf3a', '#4aa3ff', '#4caf3a'];
      let inner = '';
      for (let i = 0; i < 4; i++) inner += '<i style="--sang:' + (i * 90) + 'deg;--scol:' + cols[i] + '"></i>';
      spin.innerHTML = inner;
      layer.appendChild(spin);
      setTimeout(() => spin.remove(), 720);
      this._fxSparks(c, { color: '#cfe6ff', glow: '#8fb4d8', count: 10, spread: 58, size: 2.4 });
    });
  },

  // Ghost Rider — his last act: a hellfire eruption bursts from his lane as a
  // soul is dragged up from his hand.
  _fxGhostRiderHellfire(self) {
    if (this._reducedMotion() || !self) return;
    const el = this._fxCardElById(self.id);
    if (!el) return;
    this._fxRing(el, { color: '#ff5a1e' });
    const c = this._fxCenter(el);
    if (c) {
      this._fxImpact(c, { color: '#ff5a1e', core: '#ffd27a', size: 1.1 });
      this._fxSparks(c, { color: '#ffd27a', glow: '#ff3b0a', count: 14, angle: -Math.PI / 2, cone: 2.2, spread: 72, size: 3 });
    }
    this._screenShake('medium');
  },
  // The "-N" for a hit whose card is already gone: the same .dmg-float the
  // node branch builds (same classes, same --pop-scale tiers), parented to a
  // fixed box sized and placed exactly where the card stood.
  _fxKillFloat(ev, fx) {
    const dr = this._deathRects && this._deathRects.get(String(ev.cardId));
    if (!dr || performance.now() - dr.t > 4000 || typeof document === 'undefined') return null;
    const box = document.createElement('div');
    box.className = 'dmg-float-anchor';
    box.style.cssText = `position:fixed; left:${dr.left}px; top:${dr.top}px; width:${dr.width}px; height:${dr.height}px; pointer-events:none; z-index:2600;`;
    const float = document.createElement('div');
    const pop = (fx && fx.pop) || 1.7;
    float.className = 'dmg-float dmg-hit' + (pop >= 1.6 ? ' dmg-float-lethal' : pop >= 1.35 ? ' dmg-float-heavy' : '');
    float.textContent = `-${ev.amount}`;
    float.style.setProperty('--pop-scale', String(pop));
    float.style.setProperty('--dx', '0px');
    box.appendChild(float);
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 1200);
    return float;
  },

  // ===================== AAA IMPACT LAYER =====================
  // What a heavy hit / kill adds on top of the card's own flash + chips:
  //   · a CONTACT FLASH where the blow lands — the target's edge facing the
  //     attacker, not its centre (that is where the eye expects it);
  //   · SPARKS sprayed AWAY from the attacker, so the hit has a direction;
  //   · a CAMERA KICK — the whole view jolts a few px along the blow and
  //     springs back (the `translate` property, so it never fights the
  //     shake's transform animation), plus a tiny zoom punch on a kill.
  // Low-fx / reduced-motion: no kick, no zoom; the flash still reads.
  _impactLayer(targetEl, attackerId, fx, deadId) {
    if (this._reducedMotion && this._reducedMotion()) return;
    let tr = targetEl ? targetEl.getBoundingClientRect() : null;
    if ((!tr || !tr.width) && deadId != null && this._deathRects) {
      const d = this._deathRects.get ? this._deathRects.get(String(deadId)) : null;
      if (d) tr = d;
    }
    const aEl = attackerId != null ? document.querySelector('.board [data-card-id="' + attackerId + '"]') : null;
    const ar = aEl ? aEl.getBoundingClientRect() : null;
    let dir = 0;   // +1 = blow travels DOWN the screen, -1 = UP
    if (tr && ar && ar.width) dir = (tr.top + tr.height / 2) > (ar.top + ar.height / 2) ? 1 : -1;
    else if (targetEl) dir = targetEl.classList.contains('ally-card') ? 1 : -1;
    if (tr && tr.width) {
      const p = { x: tr.left + tr.width / 2, y: dir > 0 ? tr.top + tr.height * .12 : (dir < 0 ? tr.top + tr.height * .88 : tr.top + tr.height / 2) };
      this._fxImpact(p, { color: fx.kick >= 10 ? '#ffd2b0' : '#ffe8d6', core: '#ffffff', size: fx.impact || 1.4 });
      this._fxSparks(p, { color: '#fff4e6', glow: fx.kick >= 10 ? '#ff5a3d' : '#ffb35a', count: fx.kick >= 10 ? 22 : 14,
        angle: dir >= 0 ? Math.PI / 2 : -Math.PI / 2, cone: 1.3, spread: fx.kick >= 10 ? 110 : 80, size: 2.6 });
    }
    const low = document.body && document.body.classList.contains('low-fx');
    const area = document.getElementById('game-area');
    if (!area || low || !dir) return;
    const k = fx.kick * dir;
    area.style.transition = 'none';
    area.style.translate = '0 ' + k + 'px';
    if (fx.zoom) area.style.scale = String(fx.zoom);
    void area.offsetWidth;
    requestAnimationFrame(() => {
      area.style.transition = 'translate 220ms cubic-bezier(.2,1.6,.4,1), scale 260ms cubic-bezier(.2,1.2,.4,1)';
      area.style.translate = '0 0';
      area.style.scale = '1';
      clearTimeout(this._kickT);
      this._kickT = setTimeout(() => { area.style.transition = ''; area.style.translate = ''; area.style.scale = ''; }, 320);
    });
  },

  // 2v2: FX events carry the ABSOLUTE side ('player'=Team A, 'ai'=Team B), but
  // the board renders the VIEWER's team on the 'player' bars and the enemy on
  // the 'ai' bars (Team B sees the board flipped). Map an event's absolute owner
  // to the viewer-relative side so a hit flashes the correct health bar.
  // _fx2v2MySide is set each render by _render2v2OnlineBoard; no-op in 1v1.
  _fxDomSide(owner) {
    const tt = Game.state && Game.state.twoVTwo;
    if (tt && tt.online && this._fx2v2MySide) {
      return owner === this._fx2v2MySide ? 'player' : 'ai';
    }
    return owner;
  },

  // Which track an event plays on. Anything not listed plays immediately —
  // sounds, relayed cinematics (they keep their own pacing, _queueSigFx), and
  // any type added later until someone decides otherwise.
  _FX_TRACKS: {
    combat: ['swing', 'hit', 'hpHit', 'block', 'blocked', 'armor', 'evade', 'heal', 'move',
             'enterAndDie', 'blockDrain', 'artWeapon', 'laneVoid', 'overdrive'],
    announce: ['trickReveal', 'discardReveal', 'envReveal', 'titan', 'legendary', 'ballyhoo',
               'shadowman', 'ironGiantSave'],
  },
  // Cosmetic beats the catch-up may merge away when far behind. Never hits,
  // kills or announcements.
  _FX_COSMETIC: { swing: 1, blockDrain: 1, artWeapon: 1 },
  _FX_SPACING_MS: { combat: 240, announce: 700 },
  _fxTrackOf(ev) {
    if (!this._fxTrackMap) {
      const m = {};
      Object.keys(this._FX_TRACKS).forEach(t => this._FX_TRACKS[t].forEach(ty => { m[ty] = t; }));
      this._fxTrackMap = m;
    }
    return (ev && this._fxTrackMap[ev.type]) || 'immediate';
  },
  // One BEAT = what happens at the same instant. Consecutive events from the
  // same attacker (its swing, then the hits it lands — an area hit included)
  // are one beat; with no attacker, consecutive events of the same type are.
  _fxSameBeat(a, b) {
    if (!a || !b) return false;
    if (a.attackerId != null && a.attackerId === b.attackerId) return true;
    if (a.type === 'swing' && a.cardId != null && a.cardId === b.attackerId) return true;
    return a.attackerId == null && b.attackerId == null && a.type === b.type;
  },
  _fxDirector() {
    return this._fxDir || (this._fxDir = {
      combat: [], announce: [], busy: { combat: false, announce: false },
      stat: { events: 0, beats: 0, paced: 0, merged: 0, maxBacklog: 0 },
    });
  },
  _fxReset() {
    const D = this._fxDirector();
    D.combat.length = 0; D.announce.length = 0; D.busy.combat = false; D.busy.announce = false; D.until = {};
    clearTimeout(D._tCombat); clearTimeout(D._tAnnounce);
  },
  _fxDirect(events) {
    const D = this._fxDirector();
    D.stat.events += events.length;
    const beats = { combat: [], announce: [] };
    for (const ev of events) {
      const tr = this._fxTrackOf(ev);
      if (tr === 'immediate') { this._fxPlayOneSafe(ev); continue; }
      const list = beats[tr];
      const last = list[list.length - 1];
      if (tr === 'combat' && last && this._fxSameBeat(last[last.length - 1], ev)) last.push(ev);
      else list.push([ev]);
    }
    ['combat', 'announce'].forEach(tr => {
      const incoming = beats[tr];
      if (!incoming.length) return;
      const q = D[tr];
      // CALM PATH — an idle track handed one beat plays it this frame, so the
      // host's normal play (events trickling in one combat step at a time) is
      // unpaced. It then HOLDS the track for the beat's real length, so anything
      // arriving mid-animation waits for it.
      if (!D.busy[tr] && !q.length && incoming.length === 1) {
        const len = this._fxPlayBeat(incoming[0]);
        D.stat.beats++;
        this._fxHold(tr, len, 1);
        return;
      }
      q.push(...incoming);
      D.stat.paced += incoming.length;
      if (tr === 'combat' && q.length > 24) this._fxMergeCosmetic(q);
      if (q.length > D.stat.maxBacklog) D.stat.maxBacklog = q.length;
      if (!D.busy[tr]) this._fxPump(tr);
    });
  },
  // Play the next beat, then wait. The wait SHRINKS as the backlog grows
  // (x1 at an empty queue, up to x2.5) — catch up by playing faster, not by
  // throwing beats away.
  _fxPump(tr) {
    const D = this._fxDirector();
    const q = D[tr];
    const beat = q.shift();
    if (!beat) { D.busy[tr] = false; return; }
    D.busy[tr] = true;
    const len = this._fxPlayBeat(beat);
    D.stat.beats++;
    this._fxHold(tr, len, Math.min(2.5, 1 + q.length / 6));
  },
  // Hold the track for this beat: its measured length, never less than the
  // track's minimum spacing, divided by the catch-up factor when behind.
  _fxHold(tr, lenMs, scale) {
    const D = this._fxDirector();
    D.busy[tr] = true;
    const wait = Math.round(Math.max(this._FX_SPACING_MS[tr] || 240, lenMs || 0) / (scale || 1));
    D.until = D.until || {};
    D.until[tr] = Date.now() + wait;
    if (lenMs > (this._FX_SPACING_MS[tr] || 240)) D.stat.measuredLonger = (D.stat.measuredLonger || 0) + 1;
    const key = tr === 'combat' ? '_tCombat' : '_tAnnounce';
    clearTimeout(D[key]);
    D[key] = setTimeout(() => this._fxPump(tr), wait);
  },
  _fxPlayBeat(beat) {
    const canRead = typeof document !== 'undefined' && typeof document.getAnimations === 'function';
    const before = canRead ? new Set(document.getAnimations()) : null;
    for (const ev of beat) this._fxPlayOneSafe(ev);
    if (!canRead) return 0;
    let longest = 0;
    try {
      document.getAnimations().forEach(a => {
        if (before.has(a)) return;
        const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
        if (!t || !isFinite(t.endTime)) return;
        const left = t.endTime - (typeof a.currentTime === 'number' ? a.currentTime : 0);
        if (left > longest) longest = left;
      });
    } catch (e) { return 0; }
    return Math.min(this._FX_BEAT_CAP_MS, Math.max(0, Math.round(longest)));
  },
  // Far behind: drop the purely cosmetic events first (a swing lunge, a drain
  // shimmer), keeping every hit, kill and announcement.
  _fxMergeCosmetic(q) {
    const D = this._fxDirector();
    for (let i = q.length - 1; i >= 0; i--) {
      const kept = q[i].filter(ev => !this._FX_COSMETIC[ev.type]);
      D.stat.merged += q[i].length - kept.length;
      if (kept.length) q[i] = kept; else q.splice(i, 1);
    }
  },
  // One failing effect must not take the rest of its batch with it.
  _fxPlayOneSafe(ev) {
    try { this._fxPlayOne(ev); } catch (e) { if (typeof console !== 'undefined') console.error('[fx]', ev && ev.type, e); }
  },
  // What each event DOES — the dispatcher body (a `return` ends one event).
  _fxPlayOne(ev) {
    // ---- FX-stream board events (System 3/3) — engine-emitted, replayed
    // on every client including the MP guest (they ride state broadcasts).
    // Signature FX relayed from the host (see installFxBridge). ONLY the guest
    // replays these — the host already ran the animation live.
    if (ev.type === 'sig') {
      // Replay on any non-host online client — 1v1 guest AND the three
      // non-host seats of a 2v2 room. The host already animated live.
      // PACED, NOT DUMPED. The host resolves combat over several seconds on async
      // timers but broadcasts ONCE, in _2v2PostCombat, so the guest receives every
      // queued FX event in one snapshot; firing them all in one frame would skip
      // the combat. Spacing them here changes guest playback timing only and
      // cannot touch host combat or game state. A single relayed effect still
      // plays instantly — the delay only appears once a batch arrives.
      if (Game.onlineRelayRole && Game.onlineRelayRole() === 'guest') this._queueSigFx(ev);
      return;
    }
    // 2v2 trick reveal relayed from the host (see Game.playTrick). Guests
    // don't run the engine, so this FX event is their only reveal trigger;
    // the host already showed it live and must not double-fire. `mine` is
    // computed against the guest's own seat so their own plays read as "you".
    if (ev.type === 'trickReveal') {
      if (Game.onlineRelayRole && Game.onlineRelayRole() === 'guest') {
        const tt = Game.state && Game.state.twoVTwo;
        const mine = !!(tt && ev.seat && ev.seat === tt.you);
        try { if (this.sfx && this.sfx.playTrickSfx) this.sfx.playTrickSfx(ev.name, 'play'); } catch (e) {}
        if (ev.name !== 'Time Stone' && this.showTrickReveal) {
          // The payload carries `seat`; resolve it to the caster's name too.
          let _who = null;
          try { _who = (ev.seat && Game._2v2SeatName) ? Game._2v2SeatName(ev.seat) : null; } catch (e) {}
          if (mine) _who = 'You';
          try { this.showTrickReveal(ev.name, ev.desc || '', ev.cost, mine, _who); } catch (e) {}
        }
      }
      return;
    }
    // Discard-effect reveal relayed from the host — guests only, the host
    // already showed it live in playCard's discard branch. Same shape as
    // trickReveal: `mine` is computed against this client's own seat so your
    // own discard reads as yours.
    if (ev.type === 'discardReveal') {
      if (Game.onlineRelayRole && Game.onlineRelayRole() === 'guest') {
        const tt = Game.state && Game.state.twoVTwo;
        const mine = !!(tt && ev.seat && ev.seat === tt.you);
        if (this.showCardReveal) {
          try { this.showCardReveal(ev.name, ev.desc || '', ev.cost, mine, 'Discarded for Effect'); } catch (e) {}
        }
      }
      return;
    }
    // Shadow Man's two appearances, relayed to the seats that never run the
    // engine — same shape as Ballyhoo's.
    if (ev.type === 'shadowman') {
      if (Game.onlineRelayRole && Game.onlineRelayRole() === 'guest') {
        try { if (this.showShadowMan) this.showShadowMan(ev.phase, null); } catch (e) {}
      }
      return;
    }
    // …and each Wonder Weapon as it is handed over.
    if (ev.type === 'wonderWeapon') {
      if (Game.onlineRelayRole && Game.onlineRelayRole() === 'guest') {
        const def = this._trickDefByName(ev.weapon) || { name: ev.weapon, desc: '' };
        try { if (this.showWonderWeapon) this.showWonderWeapon(ev.seat, def, ev.category || ''); } catch (e) {}
      }
      return;
    }
    // MC Ballyhoo's arrival, relayed to the seats that do not run the engine.
    if (ev.type === 'ballyhoo') {
      if (Game.onlineRelayRole && Game.onlineRelayRole() === 'guest') {
        // The same arrival the host just ran — music, lead-in and all.
        try { if (this.showBallyhoo) this.showBallyhoo(); } catch (e) {}
      }
      return;
    }
    // Brainiac's scan — guests only (the caster's own client already showed it
    // live). Everyone is told a scan is RUNNING and whose hand it reads; the
    // cards themselves stay with the caster. Same shape as trickReveal.
    if (ev.type === 'brainiacScan') {
      if (Game.onlineRelayRole && Game.onlineRelayRole() === 'guest') {
        const tt = Game.state && Game.state.twoVTwo;
        const mine = !!(tt && ev.seat && ev.seat === tt.you);
        if (this.showCardReveal) {
          try { this.showCardReveal(ev.name || 'Brainiac', ev.desc || '', ev.cost, mine, ev.label || ''); } catch (e) {}
        }
      }
      return;
    }
    // Brainiac per-draw reveal — the ONE card the watched hand just drew, at
    // its reduced stats, shown ONLY on the caster's screen. Unlike the scan
    // announce above, the host does NOT show this live (the engine emits it for
    // every seat), so it fires for whichever client owns ev.seat — host or
    // guest alike. Nobody else sees the private read.
    if (ev.type === 'brainiacDraw') {
      const tt = Game.state && Game.state.twoVTwo;
      if (tt && ev.seat && ev.seat === tt.you && ev.card && this._fxBrainiacScan) {
        try { this._fxBrainiacScan([ev.card], ev.who || 'Opponent', 'drew a card', false); } catch (e) {}
      }
      return;
    }
    // Iron Giant sacrifice reveal — guests only (the host already showed it
    // live in doSave). Mirrors trickReveal: audio cue + the card reveal.
    if (ev.type === 'ironGiantSave') {
      if (Game.onlineRelayRole && Game.onlineRelayRole() === 'guest') {
        const tt = Game.state && Game.state.twoVTwo;
        let mine = false;
        if (tt && tt.online) {
          mine = (!!ev.seat && ev.seat === tt.you) ||
                 !!(Game._2v2TeamSide && tt.players && tt.players[tt.you] &&
                    Game._2v2TeamSide[tt.players[tt.you].team] === ev.owner);
        } else {
          mine = (ev.owner === 'player');
        }
        try { if (this.sfx && this.sfx.playCardSfx) this.sfx.playCardSfx('Iron Giant', 'ability'); } catch (e) {}
        if (this.showCardReveal) {
          try { this.showCardReveal('Iron Giant', (ev.saved ? ev.saved + ' survives — all enemies take 1.' : ''), null, mine, 'Iron Giant Sacrificed!'); } catch (e) {}
        }
      }
      return;
    }
    if (ev.type === 'titan') {
      const tEl = this.board && this.board.querySelector(`.card-slot .card[data-card-id="${ev.cardId}"]`);
      if (tEl) this.fxTitanEntrance(tEl, ev.owner, ev.cardId, ev.name);
      return;
    }
    if (ev.type === 'legendary') {
      const lEl = this.board && this.board.querySelector(`.card-slot .card[data-card-id="${ev.cardId}"]`);
      this.fxLegendaryEntrance(lEl, ev.owner, ev.cardId, ev.name);
      return;
    }
    // Status cue (Freeze / Fear / Mind Control) relayed from the host — guests
    // only, the host already played it live at the engine call (_statusSfx).
    if (ev.type === 'sfx') {
      if (Game.onlineRelayRole && Game.onlineRelayRole() === 'guest') this._replaySfx(ev);
      return;
    }
    // A SWING HAPPENED — the attacker's own cue, on the beat its side owns.
    // Emitted by Game.applyCombatDamage, the one door every swing goes through,
    // so it fires whether the hit lands, is dodged, is absorbed, or kills (do not
    // hang it off 'hit', which misses those). Riding the FX stream also means a
    // guest hears it — they never run the engine line.
    if (ev.type === 'swing') {
      const beat = (this._reducedMotion && this._reducedMotion()) ? 0 : this._swingBeatMs(ev.owner);
      this._lungeOnBeat(ev.attackerId, beat);
      if (beat > 0) {
        this._bookLaneAudioUntil(beat);
        setTimeout(() => this._playAttackerCue(ev.attackerId, ev.name), beat);
      } else {
        this._playAttackerCue(ev.attackerId, ev.name);
      }
      return;
    }
    if (ev.type === 'statusSfx') {
      if (Game.onlineRelayRole && Game.onlineRelayRole() === 'guest') {
        try { if (this.sfx && this.sfx.play && ev.sound) this.sfx.play(ev.sound); } catch (e) {}
      }
      return;
    }
    // Effect cue relayed from the host — the event fanfares are fired from engine
    // code, which a guest never runs. Guests ONLY: the host already played it
    // live inside Game._effectSfx.
    if (ev.type === 'effectSfx') {
      if (Game.onlineRelayRole && Game.onlineRelayRole() === 'guest') {
        try { if (this.sfx && this.sfx.playEffect && ev.sound) this.sfx.playEffect(ev.sound); } catch (e) {}
      }
      return;
    }
    if (ev.type === 'envReveal') {
      this.fxEnvReveal(ev.lane, ev.name);
      return;
    }
    if (ev.type === 'enterAndDie') {
      this._fxEnterAndDie(ev);
      return;
    }
    if (ev.type === 'move') {
      this._fxCardSlide(ev);
      return;
    }
    if (ev.type === 'jump') {
      this._fxJumpIn(ev);
      return;
    }
    if (ev.type === 'laneVoid') {
      this._fxLaneVoid(ev);
      return;
    }
    if (ev.type === 'overdrive') {
      this._fxOverdrive(ev);
      return;
    }
    if (ev.type === 'artWeapon') {
      const wEl = document.querySelector(`[data-card-id="${ev.cardId}"]`);
      if (wEl) this._fxArtWeapon(ev.weapon, wEl);
      return;
    }
    if (ev.type === 'blockDrain') {
      this.fxBlockAbsorb(ev.owner);
      return;
    }
    // (b) Block-fill spark — fire when a 'block' event credits the
    // block meter (damage absorbed by the meter).
    if (ev.type === 'block' && ev.cardId) {
      const card = document.querySelector(`[data-card-id="${ev.cardId}"]`);
      const side = card && card.classList.contains('ally-card') ? 'player' : 'ai';
      this.spawnBlockSpark(side);
      // One-time teaching — the first time YOUR meter credits, explain the
      // mechanic (a tutorial-skipper otherwise just sees a gold circle fill).
      if (side === 'player') this._maybeTeachBlockMeter();
    }
    if (ev.type === 'blocked') {
      // VIEWER-RELATIVE SIDE. ev.owner is the ABSOLUTE side whose meter fired
      // (Team A = 'player', Team B = 'ai'); every side-anchored effect below must
      // land on the bar the VIEWER sees it on, or in 2v2 a Team B guest's block
      // flashes the enemy bar. Routed through _fxDomSide, like hpHit.
      const bside = this._fxDomSide ? this._fxDomSide(ev.owner) : ev.owner;
      // The energy-shield activation cue (audio/block-full.mp3) — the meter
      // just turned this hit aside. Its own cue so the triple-multikill reuse
      // of 'blockFull' stays the procedural chord.
      this.sfx.play('blockShield');
      // Haptic for the block trigger — distinctive punch so the
      // player feels the moment their meter saved them.
      this._haptic('block');
      // THE BIG, UNMISSABLE ONE. A hex energy-shield flares up over the bar
      // that blocked, throws a shockwave ring, and drops a "BLOCKED!" title —
      // so the moment reads at a glance even across a busy 2v2 board, matching
      // the shield-activation sound.
      this.fxBlockShield(bside);
      // Flash the HP bar
      const fill = document.getElementById(bside === 'player' ? 'player-hp-fill' : 'ai-hp-fill');
      if (fill) { fill.classList.add('hp-flash'); setTimeout(() => fill.classList.remove('hp-flash'), 500); }
      // Shield ring on the HP bar — the meter was spent absorbing this.
      this.fxBlockAbsorb(bside);
      // Charge burst on the block circle itself — the ring flares and
      // radiates shock rings as it discharges into the free Trick.
      this.fxBlockCharge(bside);
      return;
    }
    if (ev.type === 'hpHit') {
      // 2v2: map the absolute owner ('player'=Team A / 'ai'=Team B) to the
      // viewer-relative bar so a hit flashes the correct side (no-op in 1v1).
      const dside = this._fxDomSide(ev.owner);
      if (ev.amount > 0) this.sfx.play('hpHit');
      // Face-damage vignette — red pulse from the hurt side's edge.
      if (ev.amount > 0) this.fxFaceDamage(dside);
      // Flash the HP bar
      const fill = document.getElementById(dside === 'player' ? 'player-hp-fill' : 'ai-hp-fill');
      if (fill) { fill.classList.add('hp-flash'); setTimeout(() => fill.classList.remove('hp-flash'), 500); }
      // (j) HP depletion shards
      this.spawnHpShards(dside, ev.amount || 0);
      // Shake the HP number itself — localized hit feedback
      const hpText = document.getElementById(dside === 'player' ? 'player-health' : 'ai-health');
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
        const maxHp = dside === 'player'
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
        this.pulseHpEdge(dside);
      }
      return;
    }
    // Hero heal — the mirror of hpHit above. Same health-container float,
    // green and rising, so lifesteal and heal effects are legible.
    if (ev.type === 'heal' && ev.cardId == null) {
      // ROUTE THROUGH _fxDomSide like hpHit does: raw ev.owner puts the float on
      // the WRONG bar for any viewer whose team isn't the 'player' side (2v2 Team B
      // seats, the 1v1 guest), which reads as both teams healing. Only the caster's
      // team is ever healed; this lands the float on the bar that changed.
      const hside = this._fxDomSide ? this._fxDomSide(ev.owner) : ev.owner;
      const hfill = document.getElementById(hside === 'player' ? 'player-hp-fill' : 'ai-hp-fill');
      const hcontainer = hfill ? hfill.closest('.health-container') : null;
      if (hcontainer && ev.amount > 0) {
        hcontainer.style.position = 'relative';
        const hf = document.createElement('div');
        hf.className = 'hp-dmg-float hp-heal-float';
        hf.textContent = `+${ev.amount}`;
        hcontainer.appendChild(hf);
        setTimeout(() => hf.remove(), 1200);
        if (hfill) {
          hfill.classList.add('hp-heal-flash');
          setTimeout(() => hfill.classList.remove('hp-heal-flash'), 500);
        }
      }
      return;
    }
    // Card-targeted events — find card element on board
    const cardEl = document.querySelector(`[data-card-id="${ev.cardId}"]`);
    if (!cardEl) {
      // The card is already off the board — exactly what happens on a KILLING
      // BLOW: the victim is removed before this runs. The node-anchored channels
      // (flash / burst / knockback / chips / float) have nothing to attach to, but
      // the BOARD-level ones don't need a node — fire those so a kill still
      // registers.
      if (ev.type === 'hit') {
        const tier = this._damageTier(ev.amount, ev.lethal);
        const fx = this._TIER_FX[tier] || this._TIER_FX.medium;
        // ON ITS OWN BEAT, same as the node-anchored branch below, so both halves of
        // one exchange are heard in order rather than the kill jumping ahead.
        const owner = this._attackerOwner(ev.attackerId);
        const beat = ev.attackerId != null && !(this._reducedMotion && this._reducedMotion())
          ? this._swingBeatMs(owner) : 0;
        if (beat) this._bookLaneAudioUntil(beat);
        const fire = () => {
          if (fx.shake) this._screenShake(fx.shake);
          if (fx.hitPause) this._hitPauseFreeze(fx.hitPause);
          if (fx.kick) this._impactLayer(null, ev.attackerId, fx, ev.cardId);
          try { this.sfx.play('hit', fx.sfxGain, 0); } catch (e) {}
          if (ev.amount > 0) this._haptic('hit');
          // THE KILLING NUMBER. Every hit pops its "-N", including the one that kills
          // (whose card is already gone).
          if (ev.amount > 0) this._fxKillFloat(ev, fx);
          const g = document.querySelector(`[data-ghost-of="${ev.cardId}"]`);
          if (g) {
            g.style.setProperty('--flash-ms', fx.flashMs + 'ms');
            g.classList.remove('hit-flash'); void g.offsetWidth;
            g.classList.add('hit-flash'); if (fx.flashCls) g.classList.add(fx.flashCls);
          }
        };
        if (beat) setTimeout(fire, beat); else fire();
      }
      return;
    }
    // Defer the visual FX + damage number of a contested-lane combat hit
    // to the lunge impact frame (~190ms) so they land ON contact. Splash /
    // trick / ability hits (no attackerId, no lunge) and reduced-motion
    // run inline. The float block below uses the SAME defer so a hit's
    // number rises exactly when its flash blooms.
    const _combatHit = ev.type === 'hit' && ev.attackerId != null
      && !(this._reducedMotion && this._reducedMotion());
    // …and WHICH beat it lands on is the attacker's side: the opponent's
    // swing keeps the impact frame, the player's follows a gap behind it, so
    // the two are heard as two events instead of one smear. See the note on
    // COMBAT_SWING_GAP_MS — resolution order is untouched, only playback.
    const _beatMs = _combatHit
      ? this._swingBeatMs(this._attackerOwner(ev.attackerId))
      : 0;
    if (_combatHit) this._bookLaneAudioUntil(_beatMs);
    const defer = _combatHit ? (fn) => setTimeout(fn, _beatMs) : (fn) => fn();
    // Hit flash + strike burst ring + card shake — ALL magnitude-scaled. The
    // tier classifier maps this hit's damage (and lethality) to an intensity;
    // every channel reads its parameter from the shared _TIER_FX table.
    if (ev.type === 'hit') {
      const tier = this._damageTier(ev.amount, ev.lethal);
      const fx = this._TIER_FX[tier] || this._TIER_FX.medium;
      ev._popScale = fx.pop;   // read synchronously by the floating-number block
      // The reactive bundle below is gated through defer() so a combat hit
      // fires it at the impact frame, not the instant combat resolves.
      defer(() => {
        // Attack beam — laser line from attacker to target. Fires only
        // when the attacker is known (direct combat hits). Skipped for
        // splash/chain/trick damage where the attackerId is undefined.
        if (ev.attackerId != null && ev.amount > 0) {
          this._spawnAttackBeam(ev.attackerId, ev.cardId);
        }
        // Tiered flash — brightness peak + duration scale with tier.
        cardEl.classList.add('hit-flash');
        if (fx.flashCls) cardEl.classList.add(fx.flashCls);
        cardEl.style.setProperty('--flash-ms', fx.flashMs + 'ms');
        setTimeout(() => cardEl.classList.remove('hit-flash', 'hit-flash-heavy', 'hit-flash-lethal'), fx.flashMs);
        // Chip-shedding particle burst — count scales with tier.
        this.spawnHitChips(cardEl, fx.chips);
        // Card recoil — jolt away from the attacker, distance by tier.
        this._cardKnockback(cardEl, fx.knockback);
        // AAA impact layer — contact flash + directional sparks + camera kick.
        if (fx.kick) this._impactLayer(cardEl, ev.attackerId, fx);
        // Screen shake — light hits don't shake (fx.shake === null).
        if (fx.shake) this._screenShake(fx.shake);
        // Lethal hit-pause — brief board freeze-frame on a kill.
        if (fx.hitPause) this._hitPauseFreeze(fx.hitPause);
        // Stereo-pan the impact by the card's horizontal position so a
        // left-lane and right-lane hit don't sound from the same spot.
        let pan = 0;
        const bd = this.board || document.getElementById('board');
        if (bd && cardEl) {
          const br = bd.getBoundingClientRect(), cr = cardEl.getBoundingClientRect();
          if (br.width > 0) pan = Math.max(-0.5, Math.min(0.5, ((cr.left + cr.width / 2 - br.left) / br.width - 0.5)));
        }
        this.sfx.play('hit', fx.sfxGain, pan);
        // (The attacker's own cue is NOT fired here — it belongs to the swing, not
        // the damage; see the 'swing' event above. On 'hit' it would go silent on
        // every Evade, Invincible, Damage Immunity and fully-absorbed Armor.)
        // Haptic — one honest tick per hit, either side.
        if (ev.amount > 0) this._haptic('hit');
        // Concussive ring burst — size scales with tier via --burst-scale.
        const burst = document.createElement('div');
        burst.className = 'strike-burst';
        burst.style.setProperty('--burst-scale', String(fx.burst));
        cardEl.style.position = 'relative';
        cardEl.appendChild(burst);
        setTimeout(() => burst.remove(), 600);
      });
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
    // Floating number — deferred to impact for combat hits (same defer as
    // the FX bundle) so the "-N" rises as the flash blooms; immediate for
    // everything else. Randomized horizontal offset + a per-card vertical
    // stagger so stacked hits (splash + main + chain) stay legible.
    defer(() => {
      const float = document.createElement('div');
      float.className = `dmg-float dmg-${ev.type}`;
      if (ev.type === 'hit') float.textContent = `-${ev.amount}`;
      else if (ev.type === 'evade') float.textContent = 'EVADE';
      else if (ev.type === 'block') float.textContent = 'BLOCKED';
      else if (ev.type === 'armor') float.textContent = 'ARMOR';
      else if (ev.type === 'heal') float.textContent = `+${ev.amount}`;
      // Magnitude pop — _popScale was stamped on the event by the hit
      // handler above (1.0 tap → 1.7 lethal); non-hit events default 1.0.
      const popScale = ev._popScale || 1.0;
      float.style.setProperty('--pop-scale', String(popScale));
      if (popScale >= 1.6) float.classList.add('dmg-float-lethal');
      else if (popScale >= 1.35) float.classList.add('dmg-float-heavy');
      const dx = (Math.random() * 26 - 13) | 0;
      float.style.setProperty('--dx', dx + 'px');
      // Vertical stagger — per-card float count in a 1.1s rolling window
      // so multi-hit damage stacks readably instead of overlapping.
      if (!this._dmgFloatStack) this._dmgFloatStack = new Map();
      const stack = this._dmgFloatStack;
      const key = ev.cardId;
      const now = performance.now();
      const slot = stack.get(key);
      let stackIdx = 0;
      if (slot && now - slot.t < 1100) stackIdx = slot.n + 1;
      stack.set(key, { n: stackIdx, t: now });
      float.style.setProperty('--stack-dy', (stackIdx * -14) + 'px');
      cardEl.style.position = 'relative';
      cardEl.appendChild(float);
      setTimeout(() => float.remove(), 1200);
    });
  },
  // Immediate reveal when the human discards Brainiac. The small HUD strip is
  // easy to miss, so the discard throws a prominent center-screen reveal of the
  // opponent's next draws; the strip then lingers as the persistent reference
  // for the next 2 rounds.
  _fxBrainiacScan(upcoming, whoName, subLabel, force) {
    const el = document.getElementById('brainiac-scan');
    if (el) {
      el.classList.remove('brainiac-scan-pulse');
      void el.offsetWidth;   // reflow so the pulse restarts
      el.classList.add('brainiac-scan-pulse');
    }
    // `force` is a user-initiated reopen (clicking the strip), which should
    // show even for reduced-motion players — they asked for it.
    if (!force && this._reducedMotion && this._reducedMotion()) return;
    if (!upcoming || !upcoming.length) return;
    // Tear down any previous reveal still on screen.
    const prev = document.getElementById('brainiac-reveal');
    if (prev) prev.remove();
    const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const overlay = document.createElement('div');
    overlay.id = 'brainiac-reveal';
    overlay.className = 'brainiac-reveal-overlay';
    const cards = upcoming.map((c, idx) => {
      const art = this.getCardArtPath ? this.getCardArtPath(c.name) : '';
      const cost = (c.cost != null ? c.cost : (c.baseCost != null ? c.baseCost : ''));
      // Show the REDUCED stats the card arrived with (−1/−1 under the scan), so
      // the caster sees exactly what they'll be facing, not the printed values.
      const hasStats = (typeof c.attack === 'number' && typeof c.currentHealth === 'number')
        && this._hasBody(c);
      return `<div class="brainiac-reveal-card" style="--i:${idx}">`
        + `<span class="brainiac-reveal-order">${idx + 1}</span>`
        + (cost !== '' ? `<span class="brainiac-reveal-cost">${esc(cost)}</span>` : '')
        + (art ? `<div class="brainiac-reveal-art" style="background-image:url('${esc(art)}')"></div>` : '<div class="brainiac-reveal-art"></div>')
        + `<div class="brainiac-reveal-name">${esc(c.name)}</div>`
        + (hasStats ? `<div class="brainiac-reveal-stats"><span class="brs-atk">${c.attack}</span><span class="brs-hp">${c.currentHealth}</span></div>` : '')
        + `</div>`;
    }).join('');
    overlay.innerHTML = `<div class="brainiac-reveal-inner">`
      + `<div class="brainiac-reveal-title"><span class="brainiac-reveal-eye">👁</span> BRAINIAC SCANS${whoName ? ' \u00b7 ' + String(whoName).replace(/[<>&]/g, '') : ''}</div>`
      + `<div class="brainiac-reveal-sub">${esc(subLabel || ('The opponent\'s next draw' + (upcoming.length === 1 ? '' : 's')))}</div>`
      + `<div class="brainiac-reveal-cards">${cards}</div></div>`;
    document.body.appendChild(overlay);
    // Click to dismiss early; otherwise auto-fade.
    const kill = () => { overlay.classList.add('is-leaving'); setTimeout(() => overlay.remove(), 320); };
    overlay.addEventListener('click', kill);
    clearTimeout(this._brainiacRevealT);
    this._brainiacRevealT = setTimeout(kill, 2600);
    if (this.sfx && this.sfx.play) { try { this.sfx.play('modalOpen'); } catch (e) {} }
  },

  // Bespoke, character-themed entrance flourish for each 10-cost titan — the
  // layer that lifts every titan drop to the Thanos/Vader bar. Composes the
  // shared FX primitives; all one-shot, self-removing, reduced-motion gated
  // (guarded by the caller). `geom` = { cx, cy, r } of the card.
  _fxTitanSignature(name, el, geom, ally) {
    if (this._reducedMotion() || !el || !geom) return;
    const cx = geom.cx, cy = geom.cy, r = geom.r;
    const center = { x: cx, y: cy };
    switch (name) {
      case 'Galactus': {
        // World-eater: a cosmic void yawns open (contracting ring), a violet
        // shockwave rolls out, and the power-cosmic washes the board.
        this._fxRing(el, { color: '#b06bff', contract: true });
        setTimeout(() => this._fxRing(el, { color: '#d8b0ff' }), 130);
        this._fxCosmicSweep();
        this._fxSparks(center, { count: 22, color: '#e8d0ff', glow: '#b06bff', spread: 124, size: 3.4 });
        break;
      }
      case 'Dr. Manhattan': {
        // Quantum bloom: nested blue rings ripple out + forked bolts crackle in.
        this._fxRing(el, { color: '#4dd0ff' });
        setTimeout(() => this._fxRing(el, { color: '#9be0ff' }), 130);
        setTimeout(() => this._fxRing(el, { color: '#eaffff' }), 260);
        this._fxDrawBolt(null, center, { color: '#eaffff', glow: '#4aa3ff' });
        setTimeout(() => this._fxDrawBolt({ x: cx - r.width, y: cy - r.height }, center, { color: '#cfeaff', glow: '#4aa3ff' }), 90);
        break;
      }
      case 'Knull': {
        // God of Symbiotes: black tendrils erupt outward in a corona, red core burst.
        this._fxGasBurst(el, { color: '#0a0a0a' });
        const dirs = [[-1, -0.35], [1, -0.35], [-0.75, 0.55], [0.75, 0.55], [-0.15, -1], [0.15, 1]];
        dirs.forEach((d, i) => setTimeout(() => {
          this._fxTendril(center, { x: cx + d[0] * 150, y: cy + d[1] * 150 }, { color: '#070707', glow: '#ff2b4a', bow: 22 });
        }, i * 45));
        this._fxImpact(center, { color: '#ff2b4a', core: '#ffd0d8', size: 1.2 });
        break;
      }
      case 'Trigon': {
        // Demon lord: hellfire erupts under him with a red ring + rising embers.
        this._fxFlameColumn(el);
        this._fxRing(el, { color: '#ff3b1a' });
        this._fxSparks({ x: cx, y: cy + r.height * 0.35 }, { count: 16, color: '#ffb15a', glow: '#ff3b1a', spread: 100, size: 3.2, angle: -Math.PI / 2, cone: 1.3 });
        this._screenShake('heavy');
        break;
      }
      case 'Anakin Skywalker': {
        // The Chosen One: a blue saber ignites in a cross-slash + Force ring.
        this._fxSlashEl(el, { blade: '#2b8cff', core: '#eaf4ff', angle: -40 });
        setTimeout(() => this._fxSlashEl(el, { blade: '#2b8cff', core: '#eaf4ff', angle: 40 }), 110);
        this._fxRing(el, { color: '#3aa0ff' });
        this._fxSparks(center, { count: 14, color: '#eaf4ff', glow: '#2b8cff', spread: 90, size: 2.8 });
        break;
      }
      case 'Dormammu': {
        // Dark Dimension: swirling magenta flame + orange embers spiralling out.
        this._fxGasBurst(el, { color: '#c04bff' });
        this._fxRing(el, { color: '#ff6a00' });
        setTimeout(() => this._fxRing(el, { color: '#c04bff' }), 140);
        this._fxSparks(center, { count: 18, color: '#ffb15a', glow: '#c04bff', spread: 106, size: 3 });
        break;
      }
    }
  },
};
