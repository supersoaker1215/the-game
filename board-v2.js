/* ============================================================================
   BOARD V2 — the redesigned board, built to the owner's reference.
   ============================================================================
   Owner: "build the screenshot from scratch and keep it separate from main —
   it's a redesign, the board will look different but the gameplay will stay
   the same."

   SEPARATE, AND OFF BY DEFAULT. Flipping it on adds `board-v2` to <body> and
   board-v2.css does the rest. With the flag off this file contributes nothing
   and the original board renders exactly as it did — same DOM, same ids.

   WHY IT RESTYLES RATHER THAN REPLACES. A second renderBoard emitting its own
   markup quietly breaks a dozen things: most other renderers in ui.js write
   into specific ids (#player-hp-fill, #ai-hand, #player-energy-display,
   #btn-action, .hand-cards, the FX layers, the prompt trays), and the combat FX
   stream targets elements BY ID at animation time. V2 keeps every existing
   element and id exactly where it is, moves them with CSS grid, and ADDS the
   few things the reference has that the board does not. Nothing the engine or
   the FX layer reaches for can go missing — which is what "gameplay stays the
   same" has to mean in practice.

   EVERYTHING IT PRINTS IS REAL. Where the reference shows a number this game
   does not have, this file says so in place rather than inventing one. The
   reference's turn clock is the example: there is no turn timer in this game,
   so the slot carries the phase's actual instruction instead of a countdown.
   ========================================================================== */
const BoardV2 = {
  KEY: 'clb-board-v2',

  enabled() {
    try { return localStorage.getItem(this.KEY) === '1'; } catch (e) { return false; }
  },
  set(on) {
    try { localStorage.setItem(this.KEY, on ? '1' : '0'); } catch (e) {}
    this.apply();
    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },
  toggle() { this.set(!this.enabled()); },

  apply() {
    if (typeof document === 'undefined' || !document.body) return;
    const on = this.enabled();
    document.body.classList.toggle('board-v2', on);
    if (!on) this.teardown();
  },

  // OFF MUST MEAN OFF, IN THE DOM AND NOT JUST IN THE STYLESHEET.
  // Scoping every rule to body.board-v2 makes the CSS inert, but the nodes this
  // file INSERTS survive the class going away, and one of them matters: the
  // rail adopts #board-aside, which index.html deliberately keeps at BODY level
  // because #game-area carries a perspective transform and would otherwise
  // become the containing block for anything position:fixed inside it. Leaving
  // the aside parented to the rail would quietly misplace it on the shipping
  // board. So the aside goes home and everything this file added is removed.
  teardown() {
    try {
      const aside = document.getElementById('board-aside');
      if (aside && this._asideHome && aside.parentNode !== this._asideHome.parent) {
        const { parent, next } = this._asideHome;
        if (next && next.parentNode === parent) parent.insertBefore(aside, next);
        else parent.appendChild(aside);
      }
      // Health bars go home before the plates that host them are removed.
      if (this._hpHome) {
        ['ai', 'player'].forEach(who => {
          const home = this._hpHome[who];
          if (!home) return;
          const bar = document.querySelector('.info-bar.' + (who === 'ai' ? 'ai-bar' : 'player-bar'));
          const box = bar && bar.querySelector('.health-container');
          if (!box || box.parentNode === home.parent) return;
          if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(box, home.next);
          else home.parent.appendChild(box);
        });
      }
      document.querySelectorAll('[id^="bv2-"], .bv2-lane-no').forEach(el => el.remove());
    } catch (e) { console.error('[BoardV2] teardown', e); }
  },

  // ---- the chrome the reference has that the board does not -----------------
  // Each of these is created ONCE and then updated in place, so nothing here
  // fights ui.js's own diffing or churns nodes every frame.
  _el(id, cls, parent, tag) {
    let e = document.getElementById(id);
    if (!e) {
      e = document.createElement(tag || 'div');
      e.id = id;
      if (cls) e.className = cls;
      (parent || document.body).appendChild(e);
    }
    return e;
  },

  // The left rail's phase panel: what phase it is and what you can do in it.
  // The reference shows a countdown here; this game has no turn clock, so the
  // slot carries the real instruction for the phase instead of a fake one.
  _renderPhase(s) {
    const rail = document.getElementById('bv2-rail-left');
    if (!rail) return;
    const panel = this._el('bv2-phase', 'bv2-phase', rail);
    // Phase first, then the readouts — the reference reads top-down as
    // "whose turn / what happens if it ends now / what just happened".
    if (rail.firstChild !== panel) rail.insertBefore(panel, rail.firstChild);
    const ph = String(s.phase || '');
    const mine = /^player-/.test(ph);
    const title = mine
      ? (/tricks/.test(ph) ? 'YOUR TRICKS' : 'YOUR TURN')
      : (/^ai-/.test(ph) ? 'OPPONENT' : (ph.replace(/-/g, ' ').toUpperCase() || '—'));
    const hint = mine
      ? (/tricks/.test(ph) ? 'Play a trick or end' : 'Play or end')
      : (/^ai-/.test(ph) ? 'Waiting' : '');
    panel.classList.toggle('is-mine', mine);
    const sig = title + '|' + hint;
    if (panel.dataset.sig === sig) return;
    panel.dataset.sig = sig;
    panel.innerHTML =
      '<div class="bv2-phase-cap">Phase</div>' +
      '<div class="bv2-phase-title">' + title + '</div>' +
      '<div class="bv2-phase-bar"><i></i></div>' +
      (hint ? '<div class="bv2-phase-hint">' + hint + '</div>' : '');
  },

  // THE SEAT PLATE, BUILT LIKE THE REFERENCE.
  // Left cluster is [tag] [name over its own health bar] [HP] [TRICKS n/8].
  // That means the health bar has to live INSIDE the plate, under the name —
  // in the shipping bar it is a separate full-width cell further along the row.
  // So the node is MOVED here and put back by teardown(), the same contract the
  // rail uses for #board-aside. Moving beats rebuilding: #player-hp-fill and
  // #ai-hp-fill are written to by name from ui.js and the FX layer, so a copy
  // would go stale the first time either took damage.
  _renderSeats(s) {
    const put = (bar, who) => {
      if (!bar) return;
      const side = s[who] || {};
      const plate = this._el('bv2-plate-' + who, 'bv2-plate', bar);
      if (bar.firstChild !== plate) bar.insertBefore(plate, bar.firstChild);

      let name = who === 'player' ? 'You' : 'Opponent';
      try {
        if (typeof Multiplayer !== 'undefined' && Multiplayer && Multiplayer.names) {
          name = Multiplayer.names[who] || name;
        } else if (side.name) { name = side.name; }
      } catch (e) {}
      const hp   = side.health != null ? side.health : '';
      const tag  = (String(name).replace(/[^A-Za-z0-9]/g, '').slice(0, 2)
                    || (who === 'player' ? 'YOU' : 'OP')).toUpperCase();
      const trk  = ((side.tricksPlayed != null ? side.tricksPlayed : 0) + '/' +
                    ((typeof Game !== 'undefined' && Game.TRICK_LIMIT) || 8));

      const sig = tag + '|' + name + '|' + hp + '|' + trk;
      if (plate.dataset.sig !== sig) {
        plate.dataset.sig = sig;
        plate.innerHTML =
          '<span class="bv2-tag">' + tag + '</span>' +
          '<span class="bv2-id"><b class="bv2-name">' + String(name).slice(0, 18) + '</b></span>' +
          '<span class="bv2-hp">' + hp + '<i>HP</i></span>' +
          '<span class="bv2-trk"><i>Tricks</i>' + trk + '</span>';
      }
      // Park the live health bar under the name, once.
      const hpBox = bar.querySelector('.health-container');
      const idCol = plate.querySelector('.bv2-id');
      if (hpBox && idCol && hpBox.parentNode !== idCol) {
        if (!this._hpHome) this._hpHome = {};
        if (!this._hpHome[who]) this._hpHome[who] = { parent: hpBox.parentNode, next: hpBox.nextSibling };
        idCol.appendChild(hpBox);
      }
    };
    put(document.querySelector('.info-bar.ai-bar'), 'ai');
    put(document.querySelector('.info-bar.player-bar'), 'player');
  },

  // "HAND 5 / 8" over the hand, and "TRICKS / n HELD" over the trick rail —
  // both counts straight off state.
  _renderCounts(s) {
    const hs = document.querySelector('.player-hand-section');
    if (hs) {
      const cap = this._el('bv2-hand-cap', 'bv2-cap', hs);
      if (hs.firstChild !== cap) hs.insertBefore(cap, hs.firstChild);
      const n = ((s.player && s.player.hand) || []).length;
      const max = (typeof Game !== 'undefined' && Game.HAND_LIMIT) || 8;
      const sig = n + '/' + max;
      if (cap.dataset.sig !== sig) {
        cap.dataset.sig = sig;
        cap.innerHTML = '<span class="bv2-cap-label">Hand</span>' +
          '<span class="bv2-cap-val">' + n + ' <i>/</i> ' + max + '</span>';
      }
    }
    const ts = document.querySelector('.tricks-section');
    if (ts) {
      const cap = this._el('bv2-trick-cap', 'bv2-cap bv2-cap-rule', ts);
      if (ts.firstChild !== cap) ts.insertBefore(cap, ts.firstChild);
      const n = ((s.player && s.player.trickHand) || []).length;
      const sig = String(n);
      if (cap.dataset.sig !== sig) {
        cap.dataset.sig = sig;
        cap.innerHTML = '<span class="bv2-cap-label">Tricks</span>' +
          '<span class="bv2-cap-line"></span>' +
          '<span class="bv2-cap-val">' + n + ' <i>held</i></span>';
      }
    }
  },

  // Lane index chips down the middle of the board, as the reference has them.
  // One per lane, created once, inside the lane's own separator.
  _renderLaneChips() {
    const lanes = document.querySelectorAll('#board .lane');
    lanes.forEach((lane, i) => {
      const sep = lane.querySelector('.lane-sep');
      if (!sep) return;
      let chip = sep.querySelector('.bv2-lane-no');
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'bv2-lane-no';
        chip.textContent = String(i + 1);
        sep.appendChild(chip);
      }
    });
  },

  // The rails themselves. Created inside #game-area so the grid can place them.
  _ensureRails() {
    const ga = document.getElementById('game-area');
    if (!ga) return;
    const left = this._el('bv2-rail-left', 'bv2-rail bv2-rail-left', ga);
    // The existing aside already carries the reference's "if combat resolves
    // now" block and the last log lines — reuse it rather than building a
    // second one that could disagree with it.
    const aside = document.getElementById('board-aside');
    if (aside && aside.parentNode !== left) {
      // Remember where it lives so teardown can put it back exactly.
      if (!this._asideHome) this._asideHome = { parent: aside.parentNode, next: aside.nextSibling };
      left.appendChild(aside);
    }
  },

  // Called from UI.render's tail. Returns immediately when off, so the original
  // board pays nothing for this existing.
  render(s) {
    if (!this.enabled() || !s) return;
    this.apply();
    try {
      this._ensureRails();
      this._renderPhase(s);
      this._renderSeats(s);
      this._renderCounts(s);
      this._renderLaneChips();
    } catch (e) { console.error('[BoardV2] render', e); }
  },
};
if (typeof window !== 'undefined') {
  window.BoardV2 = BoardV2;
  // Apply the body class as early as possible so the first painted frame is
  // already in the right skin rather than flashing the old board.
  try { BoardV2.apply(); } catch (e) {}
}
