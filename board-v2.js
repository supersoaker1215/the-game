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
      const sig = tag + '|' + name + '|' + hp;
      if (plate.dataset.sig !== sig) {
        plate.dataset.sig = sig;
        plate.innerHTML =
          '<span class="bv2-tag">' + tag + '</span>' +
          '<span class="bv2-id"><b class="bv2-name">' + String(name).slice(0, 18) + '</b></span>' +
          '<span class="bv2-hp">' + hp + '<i>HP</i></span>';
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

  // NO INJECTED LANE CHIP. The separator already contains a `.lane-number`
  // element that ui.js maintains, so adding a second one produced the doubled
  // digits on the board. board-v2.css styles the real one to the spec's 22px
  // chamfered square instead — fewer nodes, and the number stays whatever the
  // engine says it is.

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

  // The two band pieces the spec calls for that the shipping bar has no
  // element for: the hand STACK's count, and the turn flag.
  //   "hand stack (three overlapping 30 x 40 chamfered backs plus a count —
  //    not N loose backs) ... YOUR TURN in green, then the primary button"
  // The backs themselves are the existing #ai-hand children, overlapped and
  // trimmed to three by CSS; only the count needs a node, because the real
  // hand size is not otherwise printed anywhere on that band.
  _renderBandExtras(s) {
    const ah = document.getElementById('ai-hand');
    if (ah && ah.parentNode) {
      const n = ah.children.length;
      const cnt = this._el('bv2-hand-count', 'bv2-hand-count', ah.parentNode);
      if (ah.nextSibling !== cnt) ah.parentNode.insertBefore(cnt, ah.nextSibling);
      if (cnt.textContent !== String(n)) cnt.textContent = String(n);
    }
    // The flag lives on whichever band is on the clock, so the board answers
    // "whose turn" from the seat itself rather than only from the left rail.
    const ph = String(s.phase || '');
    const mine = /^player-/.test(ph);
    const theirs = /^ai-/.test(ph);
    const bar = document.querySelector(mine ? '.info-bar.player-bar'
                                            : (theirs ? '.info-bar.ai-bar' : null));
    const old = document.getElementById('bv2-turnflag');
    if (!bar) { if (old) old.remove(); return; }
    const flag = this._el('bv2-turnflag', 'bv2-turnflag', bar);
    const centre = bar.querySelector('.bar-center');
    if (centre && flag.nextSibling !== centre) bar.insertBefore(flag, centre);
    else if (!centre && flag.parentNode !== bar) bar.appendChild(flag);
    const label = mine ? 'Your turn' : 'Their turn';
    if (flag.textContent !== label) flag.textContent = label;
    flag.classList.toggle('is-mine', mine);
  },

  // BOARD-SPEC FIX 3, second half: "No minus sign. The arrow carries direction
  // and the colour carries who is dealing; `-3` on top of a down-arrow says the
  // same thing twice and reads as a negative number."
  // The engine writes the signed figure; the arrow is added in CSS. So the sign
  // is stripped for DISPLAY only — the element's own text is what changes, never
  // the value the engine computed.
  _stripForecastSigns() {
    const cells = document.querySelectorAll('#lane-forecast-strip .lf-face');
    cells.forEach(el => {
      const t = (el.textContent || '');
      const clean = t.replace(/^[\u2212\-+]/, '');
      if (clean !== t) el.textContent = clean;
    });
  },

  // FILL THE RAIL'S LOG. renderBoardAside prints the last three lines, which is
  // right for a floating panel and leaves ~300px of black in a full-height rail.
  // This repopulates that block with as many lines as the column can show —
  // measured from its own height, not a guessed count — using the same markup
  // and classes the aside already uses, so nothing about its styling changes.
  // Runs AFTER renderBoardAside (BoardV2 is last in the render tail), so it is
  // rewriting a block that has already been built for this frame.
  _fillRailLog(s) {
    const box = document.querySelector('#bv2-rail-left .ba-log');
    if (!box) return;
    const lines = (s && s.log) || [];
    if (!lines.length) return;
    const lineH = parseFloat(getComputedStyle(box).lineHeight) || 16;
    const room  = box.clientHeight || 0;
    // Each entry wraps to roughly two lines at this width; be conservative so
    // the last one is never half-clipped.
    const fit = Math.max(3, Math.floor(room / (lineH * 2.2)));
    const want = lines.slice(-fit).reverse();
    const sig = want.length + '|' + (want[0] || '');
    if (box.dataset.bv2Sig === sig) return;
    box.dataset.bv2Sig = sig;
    box.innerHTML = want.map((t, i) =>
      '<div class="ba-log-line' + (i === 0 ? ' is-latest' : '') + '">' + t + '</div>'
    ).join('');
  },

  // Every internal proportion of a card face derives from --card-w. Board V2
  // sizes the board card with `width: 100%` so it fills its slot, which left
  // --card-w as the literal string `100%` — and `calc(100% * k)` in a
  // font-size context resolves against the PARENT font size, not the card. So
  // the cost numeral computed to 1.37px on board against 8.38px in hand: the
  // ribbon was drawn, the number inside it was a rounding error tall.
  //
  // The slot's width is set by the lane and its own height cap, never by the
  // card, so measuring it and handing the length back down is not a loop.
  _sizeBoardCards() {
    const slot = document.querySelector('#board .card-slot');
    const root = document.getElementById('board');
    if (!slot || !root) return;
    const w = Math.round(slot.getBoundingClientRect().width * 100) / 100;
    if (!w || w === this._slotW) return;
    this._slotW = w;
    root.style.setProperty('--bv2-board-card-w', w + 'px');
  },

  // ===========================================================================
  // BOX 2 - DECISIONS, in the left rail under the log.
  // Every card that asks you something (Paul Atreides, Spider-Man, Dr. Strange)
  // raises the same `#prompt-banner`: the question, the detail line, the opt-out
  // button and the 30s countdown. ui.js rebuilds that node every render and
  // parks it across the top of the screen. Here it is MOVED, not copied - one
  // node, so every listener ui.js attached comes with it and the countdown
  // keeps ticking against the same element.
  // ===========================================================================
  _renderDecision(s) {
    const left = document.getElementById('bv2-rail-left');
    if (!left) return;
    const panel = this._el('bv2-decision', 'bv2-decision', left);
    if (panel.parentNode !== left) left.appendChild(panel);
    if (!panel.firstChild) {
      panel.innerHTML =
        '<div class="bv2-cap bv2-cap-rule"><span class="bv2-cap-label">Decision</span>' +
        '<span class="bv2-cap-line"></span></div><div class="bv2-dec-body"></div>';
    }
    const body = panel.querySelector('.bv2-dec-body');
    const banner = document.getElementById('prompt-banner');
    if (banner && banner.parentNode !== body) body.appendChild(banner);

    // A choice that cannot be pointed at on the board opens the centre tray.
    // Three card faces do not fit a 182px column, so the tray stays where it
    // is - but the rail still says a decision is live, and what it is, so the
    // panel is never silent while the game is waiting on you.
    const tray = document.querySelector('#choice-tray .choice-tray-title');
    let note = body.querySelector('.bv2-dec-echo');
    if (tray && !banner) {
      if (!note) { note = document.createElement('div'); note.className = 'bv2-dec-echo'; body.appendChild(note); }
      const t = tray.textContent || '';
      if (note.textContent !== t) note.textContent = t;
    } else if (note) { note.remove(); note = null; }

    panel.classList.toggle('is-live', !!(banner || note));
  },

  // ===========================================================================
  // BOX 1 - NOTICES, in the right rail under the tricks.
  // "Opponent played a Trick" was a corner toast that appeared, held 4s and
  // vanished, so the answer to "what just happened?" was gone by the time you
  // looked. In V2 the toast IS this feed: the corner popup is suppressed and
  // every announcement lands here as a line that stays.
  // The full-screen trick REVEAL is a different thing - a cinematic, not a
  // notice - and is left alone; it logs a line here as it plays.
  // ===========================================================================
  _NOTICE_MAX: 8,
  notice(label, name, desc) {
    if (!this.enabled()) return;
    if (!this._notices) this._notices = [];
    const key = String(label) + ' ' + String(name);
    if (this._notices[0] && this._notices[0].key === key) return;   // same beat twice
    this._notices.unshift({ key: key, label: String(label || 'Notice'),
                            name: String(name || ''), desc: String(desc || '') });
    if (this._notices.length > this._NOTICE_MAX) this._notices.length = this._NOTICE_MAX;
    this._paintNotices();
  },
  // The feed is on the singleton, so it outlives a match unless something
  // drops it. There is no per-match id to key off — `_leaderboardMatchId` is
  // null in solo, the state object is REUSED across matches, and the log is
  // not truncated either, so every passive signal reads "same match". The one
  // unambiguous event is the call that starts one.
  _clearNotices() {
    this._notices = [];
    const list = document.querySelector('#bv2-notices .bv2-note-list');
    if (list) { delete list.dataset.sig; list.innerHTML = ''; }
    const panel = document.getElementById('bv2-notices');
    if (panel) panel.classList.remove('is-live');
  },
  _paintNotices() {
    const ts = document.querySelector('.tricks-section');
    if (!ts) return;
    const panel = this._el('bv2-notices', 'bv2-notices', ts);
    if (panel.parentNode !== ts) ts.appendChild(panel);
    if (!panel.firstChild) {
      // The slot is where a floating prompt docks (jump offer, block-trick,
      // time-stone). ui.js appends into it directly, so it must exist before
      // any of those can fire — build it with the panel, never on demand.
      panel.innerHTML =
        '<div class="bv2-cap bv2-cap-rule"><span class="bv2-cap-label">Notices</span>' +
        '<span class="bv2-cap-line"></span></div>' +
        '<div class="bv2-note-slot"></div><div class="bv2-note-list"></div>';
    }
    const list = panel.querySelector('.bv2-note-list');
    const slot = panel.querySelector('.bv2-note-slot');
    // ADOPT A STRAY. Picking the anchor at the insertion point covers every
    // normal frame, but not the COLD one: on the first render after V2 turns
    // on — and on the first frame of a match — the prompt is built before this
    // panel exists, so it lands on <body> and floats over the board exactly
    // once. Anything that got there is pulled in here.
    if (slot) {
      ['jump-offer-modal', 'block-trick-modal', 'time-stone-modal'].forEach(function (id) {
        const m = document.getElementById(id);
        if (m && m.parentNode !== slot) slot.appendChild(m);
      });
    }
    const items = this._notices || [];
    // The panel is live when it has ANYTHING to show. This has to be decided
    // before the redraw guard below, or a docked prompt arriving on a frame
    // where the feed did not change would leave the panel hidden.
    const docked = !!(slot && slot.firstElementChild);
    panel.classList.toggle('is-live', items.length > 0 || docked);
    panel.classList.toggle('has-docked', docked);
    const sig = items.map(function (n) { return n.key; }).join('|');
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    const esc = function (t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
    list.innerHTML = items.map(function (n, i) {
      return '<div class="bv2-note' + (i === 0 ? ' is-latest' : '') + '">' +
        '<span class="bv2-note-label">' + esc(n.label) + '</span>' +
        (n.name ? '<span class="bv2-note-name">' + esc(n.name) + '</span>' : '') +
      '</div>';
    }).join('');
  },
  // Installed lazily on the first render, so UI is guaranteed to exist. Same
  // wrap-the-method pattern ui.js already uses on undo/playCardFree/killCard -
  // which does mean UI.showAITrickToast.toString() no longer shows the original.
  _hookNotices() {
    if (this._hooked) return;
    if (typeof UI === 'undefined' || !UI || typeof UI.showAITrickToast !== 'function') return;
    this._hooked = true;
    const self = this;
    const oppName = function () { try { return UI.oppName(); } catch (e) { return 'Opponent'; } };

    const toast = UI.showAITrickToast.bind(UI);
    UI.showAITrickToast = function (name, desc, kind) {
      if (self.enabled()) {
        const LABEL = {
          discard: function () { return oppName() + ' played a Discard'; },
          trick:   function () { return oppName() + ' played a Trick'; },
          error:   function () { return 'Cannot play'; },
          info:    function () { return 'Notice'; },
          system:  function () { return 'System'; }
        };
        self.notice((LABEL[kind] || LABEL.trick)(), name, desc);
        return;                       // the rail is the toast now
      }
      return toast(name, desc, kind);
    };

    if (typeof Game !== 'undefined' && Game && typeof Game.startMatch === 'function') {
      const origSM = Game.startMatch.bind(Game);
      Game.startMatch = function () { self._clearNotices(); return origSM.apply(null, arguments); };
    }
    if (typeof UI.showTrickReveal === 'function') {
      const origTR = UI.showTrickReveal.bind(UI);
      UI.showTrickReveal = function (name, desc, cost, mine) {
        if (self.enabled()) {
          self.notice(mine ? 'You played a Trick' : oppName() + ' played a Trick', name, desc);
        }
        return origTR(name, desc, cost, mine);
      };
    }
    if (typeof UI.showCardReveal === 'function') {
      const origCR = UI.showCardReveal.bind(UI);
      UI.showCardReveal = function (name, desc, cost, mine, label) {
        if (self.enabled()) {
          self.notice(label || (mine ? 'You played a Card' : oppName() + ' played a Card'), name, desc);
        }
        return origCR(name, desc, cost, mine, label);
      };
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
      this._renderBandExtras(s);
      this._hookNotices();
      this._renderDecision(s);
      this._paintNotices();
      this._sizeBoardCards();
      this._stripForecastSigns();
      this._fillRailLog(s);
    } catch (e) { console.error('[BoardV2] render', e); }
  },
};
if (typeof window !== 'undefined') {
  window.BoardV2 = BoardV2;
  // Apply the body class as early as possible so the first painted frame is
  // already in the right skin rather than flashing the old board.
  try { BoardV2.apply(); } catch (e) {}
}
