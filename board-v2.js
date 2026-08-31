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
      // THE HAND AND TRICKS GO HOME BEFORE ANYTHING IS REMOVED. They live
      // inside #bv2-handrow while V2 is on, and the sweep below deletes every
      // bv2- node — with the hand still inside it, turning the redesign off
      // would delete the shipping board's hand. Restored in reverse document
      // order so each one's recorded next sibling is already back in place.
      [['_tricksHome', '.tricks-section'], ['_handHome', '.player-hand-section']].forEach(([key, sel]) => {
        const home = this[key], node = document.querySelector(sel);
        if (!node || !home || node.parentNode === home.parent) return;
        if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(node, home.next);
        else home.parent.appendChild(node);
      });
      // The slot dimensions are inline custom properties on #board — not a
      // bv2- node, so the sweep below cannot reach them, and left behind they
      // would size the shipping board's slots too.
      // The primary button lives inside a bv2- wrapper; the sweep below would
      // take the button with it.
      const _btn = document.getElementById('btn-action');
      if (_btn && this._btnHome && _btn.parentNode && _btn.parentNode.id === 'bv2-btn-glow') {
        const h = this._btnHome;
        if (h.next && h.next.parentNode === h.parent) h.parent.insertBefore(_btn, h.next);
        else h.parent.appendChild(_btn);
      }
      const _b = document.getElementById('board');
      if (_b) { ['--bv2-slot-w', '--bv2-slot-h', '--bv2-board-card-w']
        .forEach(p => _b.style.removeProperty(p)); }
      this._slotW = null;
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
    let mine, title, hint;
    const tt = this._tt();
    if (tt && /^2v2-/.test(ph)) {
      // 2v2 phase names are seat-keyed ('2v2-p3-cards-tricks'), so the 1v1
      // reading produced "2V2 P1 CARDS TRICKS" on the panel — the raw slug.
      // Say whose turn it is by NAME, and whether it is yours.
      const m = ph.match(/^2v2-(p[1-4])-(.+)$/);
      const seat = m && m[1];
      const kind = (m && m[2]) || '';
      const me = this._mySeat();
      mine = !!(seat && seat === me);
      const who = (seat && tt.players[seat] && tt.players[seat].name) || 'Opponent';
      const what = /tricks/.test(kind) ? (/cards/.test(kind) ? 'CARDS + TRICKS' : 'TRICKS') : 'CARDS';
      title = mine ? ('YOUR ' + what) : String(who).toUpperCase();
      hint  = mine ? (/tricks/.test(kind) ? (/cards/.test(kind) ? 'Play cards or tricks, then end' : 'Play a trick or end') : 'Play or end')
                   : (what.charAt(0) + what.slice(1).toLowerCase());
      if (/combat/.test(ph)) { title = 'COMBAT'; hint = 'Lanes resolving'; mine = false; }
    } else {
      mine = /^player-/.test(ph);
      title = mine
        ? (/tricks/.test(ph) ? 'YOUR TRICKS' : 'YOUR TURN')
        : (/^ai-/.test(ph) ? 'OPPONENT' : (ph.replace(/-/g, ' ').toUpperCase() || '—'));
      hint = mine
        ? (/tricks/.test(ph) ? 'Play a trick or end' : 'Play or end')
        : (/^ai-/.test(ph) ? 'Waiting' : '');
    }
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
  // ===================== 2v2 AWARENESS =====================
  // A SIDE IS A TEAM. Everything the redesign prints on a band — the name, the
  // HP, the hand count, the trick count — is a per-PLAYER fact in 1v1 and a
  // per-TEAM or per-SEAT fact in 2v2, and s.player / s.ai are combat proxies
  // that carry neither. These three answer it once so no panel guesses.
  _tt() { const s = (typeof Game !== 'undefined' && Game.state) || null; return (s && s.twoVTwo && s.twoVTwo.players) ? s.twoVTwo : null; },
  // WHICH TEAM IS ON THIS BAR — FROM THE CHAIR OF WHOEVER IS LOOKING.
  //
  // 'player' and 'ai' name the BOTTOM and TOP bar. Game._2v2TeamSide is the
  // engine's fixed A->player / B->ai map, which is the right answer for the
  // ENGINE and the wrong one for a screen: it made the bottom bar always
  // Team A, so every player on Team B saw their own team on top and the enemy
  // on the bottom, under their own health bar. (Owner: "so im fd and cortex is
  // my teammate — my healthbar should be switched.")
  //
  // Worse than merely swapped: _render2v2OnlineBoard writes the VIEWER's team
  // health into #player-health, which this plate adopts, so the bottom bar
  // carried the enemy's names with your own HP bar inside them.
  //
  // Bottom is always MINE. Same rule the dead pile already follows
  // (_deadPileSideForBar in ui.js) — resolve the bar to a side through the
  // viewer, never through the engine's map. Online that is the fixed seat; in
  // pass-and-play it is whoever is on the clock, because that is who is looking
  // at the screen. With no seat to go on, fall back to the engine's map.
  _teamOf(side) {
    const map = (typeof Game !== 'undefined' && Game._2v2TeamSide) || { A: 'player', B: 'ai' };
    const tt = this._tt();
    const seat = tt ? this._mySeat() : null;
    const mine = seat && tt.players[seat] && tt.players[seat].team;
    if (mine) {
      const other = mine === 'A' ? 'B' : 'A';
      return side === 'player' ? mine : other;
    }
    return map.A === side ? 'A' : 'B';
  },
  _seatsOnSide(side) {
    const tt = this._tt(); if (!tt) return [];
    const team = this._teamOf(side);
    return ['p1', 'p2', 'p3', 'p4'].filter(pk => tt.players[pk] && tt.players[pk].team === team);
  },
  // The seat this device is playing. In local pass-and-play that is whoever is
  // on the clock; online it is the fixed `you`.
  _mySeat() {
    const tt = this._tt(); if (!tt) return null;
    if (tt.online) return tt.you || null;
    try { return (Game._2v2ActivePlayer && Game._2v2ActivePlayer()) || tt.you || null; } catch (e) { return tt.you || null; }
  },
  _mySeatState() { const tt = this._tt(); const k = this._mySeat(); return (tt && k && tt.players[k]) || null; },

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
      let hp  = side.health != null ? side.health : '';
      let tag = (String(name).replace(/[^A-Za-z0-9]/g, '').slice(0, 2)
                 || (who === 'player' ? 'YOU' : 'OP')).toUpperCase();
      // 2v2: the band belongs to a TEAM. Name both seats, mark the one on the
      // clock, and read the team's health — side.health is the combat proxy and
      // is not the number the scoreboard shows.
      const tt2 = this._tt();
      if (tt2) {
        const team = this._teamOf(who);
        const seats = this._seatsOnSide(who);
        let onClock = null;
        try { onClock = Game._2v2ActivePlayer && Game._2v2ActivePlayer(); } catch (e) {}
        name = seats.map(pk => {
          const nm = String(tt2.players[pk].name || pk);
          return (pk === onClock) ? '\u25B8 ' + nm : nm;
        }).join('  \u00B7  ');
        if (tt2.teams && tt2.teams[team] && tt2.teams[team].health != null) hp = tt2.teams[team].health;
        tag = 'T' + team;
      }
      // NEVER REBUILD THIS PLATE WITH innerHTML.
      //
      // The plate ADOPTS the live .health-container below — the real node, with
      // #player-health / #player-hp-fill inside it, moved out of the band. So a
      // wholesale innerHTML rewrite on the next render did not just repaint the
      // plate, it DELETED those elements from the document. And the signature
      // that gated the rewrite included the health, so it fired precisely when
      // someone took damage. After that `bar.querySelector('.health-container')`
      // found nothing and it could never be re-parked.
      //
      // What that cost: the 2v2 renderer writes
      // `getElementById('player-health').textContent` with no guard, so the very
      // next 2v2 render threw — and _render2v2OnlineBoard is not wrapped in
      // _safe, so the throw took the whole rest of the frame with it: the
      // block-trick modal, the jump offer, the Time Stone intercept, the FX
      // drain. A blocked player's free trick was armed and never drawn until
      // some later frame survived. (Owner: "EVERY TIME OUR TEAM BLOCKS MY
      // TEAMMATE GETS A TRICK TO PLAY AND I DONT, IT SHOWS UP ON MY NEXT TURN".)
      //
      // Build the skeleton once, then write text into stable nodes. The adopted
      // health bar sits inside .bv2-id and is never touched again.
      if (!plate.firstChild) {
        // THE HP NUMBER SITS ON THE NAME'S LINE, AND THE BAR RUNS UNDER BOTH.
        //
        // It used to be a third column beside the name, with the health bar
        // tucked under the name alone — so the bar measured something narrower
        // than the thing it belonged to, and the number floated off to one side
        // of it. In the reference the identity is one block: name and HP on one
        // row, the bar spanning the full width of that row beneath them.
        // (Owner, pointing at the reference: "the you, the phase, opponent, the
        // health bar, HP number, the subtle gradient — can we move to the
        // screenshot redesign.")
        //
        // .bv2-id is still the health bar's home, so the adoption below drops it
        // in as the second row without needing to know any of this.
        plate.innerHTML =
          '<span class="bv2-tag"><i class="bv2-face"></i><b class="bv2-tag-txt"></b></span>' +
          '<span class="bv2-id">' +
            '<span class="bv2-idrow">' +
              '<b class="bv2-name"></b>' +
              '<span class="bv2-hp"><b class="bv2-hpn"></b><i>HP</i></span>' +
            '</span>' +
          '</span>';
      }
      // The LETTERS live in their own node now. This used to write
      // .textContent straight onto .bv2-tag, which would wipe the face layers
      // added beside them on the very next render.
      const _tagEl  = plate.querySelector('.bv2-tag-txt');
      const _nameEl = plate.querySelector('.bv2-name');
      const _hpEl   = plate.querySelector('.bv2-hpn');
      const _name40 = String(name).slice(0, 40);
      if (_tagEl  && _tagEl.textContent  !== tag)      _tagEl.textContent  = tag;
      if (_nameEl && _nameEl.textContent !== _name40)  _nameEl.textContent = _name40;
      if (_hpEl   && _hpEl.textContent   !== String(hp)) _hpEl.textContent = hp;
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

  // "HAND 5 / 7" over the hand, "TRICKS 2 / 3" over the tricks — both counts
  // AND both limits straight off the same objects the engine enforces against.
  //
  // The hand read `Game.HAND_LIMIT || 8`, and Game.HAND_LIMIT does not exist —
  // it never has, anywhere in the codebase — so the caption was always printing
  // the literal 8 while the rule the engine actually applies is `maxHandSize`,
  // which is 7. The one case where 8 is right (Mobius Chair and Eye of Agamotto
  // each raise that seat's cap by one) was the one case it could not show,
  // because a constant cannot know. (Owner: "the hand should say n/7 and the
  // tricks should say n/3, n being how many you have currently.")
  //
  // The trick caption printed "2 held" and named no limit at all, so the cap
  // that actually stops you keeping a block reward was invisible.
  //
  // Both now read the live value: 7 and 3 normally, 8 the moment a card raises
  // it, and a hand over its cap (an MC Ballyhoo candy is allowed past 3 on
  // purpose) reads honestly as 4 / 3 rather than being hidden.
  _handCapOf(seat, side) {
    const holder = seat || side;
    return (holder && holder.maxHandSize) || 7;
  },
  _trickCapOf(seat, side) {
    const holder = seat || side;
    return (holder && holder.maxTrickHandSize) || 3;
  },
  _renderCounts(s) {
    const hs = document.querySelector('.player-hand-section');
    if (hs) {
      const cap = this._el('bv2-hand-cap', 'bv2-cap', hs);
      if (hs.firstChild !== cap) hs.insertBefore(cap, hs.firstChild);
      // 2v2 hands live on the SEAT, never on the side proxy.
      const _seat = this._mySeatState();
      const n = ((_seat ? _seat.hand : (s.player && s.player.hand)) || []).length;
      const max = this._handCapOf(_seat, s.player);
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
      const _seatT = this._mySeatState();
      const n = ((_seatT ? _seatT.trickHand : (s.player && s.player.trickHand)) || []).length;
      const tmax = this._trickCapOf(_seatT, s.player);
      const sig = n + '/' + tmax;
      if (cap.dataset.sig !== sig) {
        cap.dataset.sig = sig;
        cap.innerHTML = '<span class="bv2-cap-label">Tricks</span>' +
          '<span class="bv2-cap-line"></span>' +
          '<span class="bv2-cap-val">' + n + ' <i>/</i> ' + tmax + '</span>';
      }
    }
  },

  // NO INJECTED LANE CHIP. The separator already contains a `.lane-number`
  // element that ui.js maintains, so adding a second one produced the doubled
  // digits on the board. board-v2.css styles the real one to the spec's 22px
  // chamfered square instead — fewer nodes, and the number stays whatever the
  // engine says it is.

  // TRICKS BELONG BESIDE THE HAND, NOT IN A COLUMN OF THEIR OWN.
  //
  // V2 put .tricks-section in the right rail, so the two cards you can actually
  // play sat 1330px away from the five you were choosing between — at the top of
  // the screen, level with the enemy's board, while your hand was at the bottom.
  // The shipping board settled this a while ago and the reasoning still holds:
  // "have the tricks next to the cards, just at the end." A trick is something
  // you play on your turn; it reads with the hand or it reads as chrome.
  // (Owner, on the redesign: "can you place the tricks down like the classic
  // board.")
  //
  // Done the way classic does it — one row holding both, centred as a group, so
  // the tricks land immediately after the last hand card at every hand size.
  // The nodes are MOVED and put back by teardown(), the same contract the aside
  // and the turn tracker already use, because teardown removes every bv2- node
  // and would otherwise take the hand with it.
  _ensureHandRow() {
    const ga = document.getElementById('game-area');
    if (!ga) return;
    const hand = document.querySelector('.player-hand-section');
    const tricks = document.querySelector('.tricks-section');
    if (!hand || !tricks) return;
    if (hand.parentNode === ga) this._handHome = this._handHome || { parent: ga, next: hand.nextSibling };
    if (tricks.parentNode === ga) this._tricksHome = this._tricksHome || { parent: ga, next: tricks.nextSibling };
    const row = this._el('bv2-handrow', 'bv2-handrow', ga);
    if (hand.parentNode !== row) row.appendChild(hand);
    if (tricks.parentNode !== row) row.appendChild(tricks);
  },

  // THE PRIMARY BUTTON'S GLOW WAS BEING CLIPPED OFF THE BUTTON.
  //
  // #btn-action carries BOTH the chamfer clip-path and the three-stop
  // drop-shadow. clip-path is applied AFTER filter, so every pixel of that
  // bloom that fell outside the chamfer — which is all of it, a glow being
  // entirely outside the shape — was cut away. The button had the right glow
  // and showed none of it.
  //
  // The fix is the one the spec names: the filter goes on a WRAPPER that is
  // not clipped, and the clipped element sits inside it. Wrapping is safe here
  // because the click handler is on the button itself, so it travels with the
  // node.
  _ensureButtonGlow() {
    const btn = document.getElementById('btn-action');
    if (!btn) return;
    let wrap = document.getElementById('bv2-btn-glow');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'bv2-btn-glow';
      wrap.className = 'bv2-btn-glow';
    }
    if (!wrap.querySelector('.bv2-btn-face')) {
      // Three stacked clipped shapes, not a shadow: tube, core, fill. They are
      // SIBLINGS of the button rather than pseudo-elements on it, because
      // ui.js rewrites the button's label and a pseudo cannot carry a third
      // layer anyway.
      const face = document.createElement('i');
      face.className = 'bv2-btn-face';
      face.innerHTML = '<i class="bv2-btn-tube"></i><i class="bv2-btn-core"></i><i class="bv2-btn-fill"></i>';
      wrap.insertBefore(face, wrap.firstChild);
    }
    if (btn.parentNode !== wrap) {
      if (!this._btnHome) this._btnHome = { parent: btn.parentNode, next: btn.nextSibling };
      const home = this._btnHome;
      if (wrap.parentNode !== home.parent) {
        if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(wrap, home.next);
        else home.parent.appendChild(wrap);
      }
      wrap.appendChild(btn);
    }
  },

  // The rails themselves. Created inside #game-area so the grid can place them.
  _ensureRails() {
    const ga = document.getElementById('game-area');
    if (!ga) return;
    const left = this._el('bv2-rail-left', 'bv2-rail bv2-rail-left', ga);
    // The right rail used to BE the trick column — the notice feed was parented
    // to .tricks-section and inherited its place in the grid. With the tricks
    // gone to the hand row it needs a column of its own, or the feed (and every
    // prompt that docks in it) travels down there with them.
    this._el('bv2-rail-right', 'bv2-rail bv2-rail-right', ga);
    // The existing aside already carries the reference's "if combat resolves
    // now" block and the last log lines — reuse it rather than building a
    // second one that could disagree with it.
    // THE ASIDE IS PAINTED BY THE 1v1 TAIL, WHICH 2v2 NEVER REACHES. Without it
    // the rail in a 2v2 match held the phase panel and nothing else — a 180px
    // column of black beside the board, missing both the combat forecast and
    // the log.
    //
    // It has to be painted EVERY 2v2 render, not just when the node is absent.
    // renderBoardAside hides itself on any phase that is not a live turn and
    // returns early while hidden, so a one-shot bootstrap that happened to run
    // during setup left it hidden forever — the node existed, empty, and
    // nothing ever came back to fill it.
    if (this._tt() && typeof UI !== 'undefined' && UI.renderBoardAside) {
      try { UI.renderBoardAside(Game.state); } catch (e) {}
    }
    // THE TURN-ORDER TRACKER is position:fixed on <body>, so in the redesign it
    // sat on top of the trick rail and the hand. It belongs in the column that
    // already answers "what is happening" — moved, not copied, so the 2v2
    // renderer keeps updating the same node.
    const tracker = document.getElementById('twov2-turn-tracker');
    if (tracker && tracker.parentNode !== left) {
      if (!this._trackerHome) this._trackerHome = { parent: tracker.parentNode, next: tracker.nextSibling };
      left.appendChild(tracker);
    }
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
    // THE TURN FLAG IS GONE. "YOUR TURN" in the band said what the phase panel
    // in zone 1 already says in larger type two inches away, and what the
    // primary button says a third time by being lit — three answers to one
    // question, in one glance. (Owner: "get rid of your turn.")
    // Any flag left over from a previous render is removed here rather than in
    // teardown, because the band it was parked on is not a bv2- node.
    const _old = document.getElementById('bv2-turnflag');
    if (_old) _old.remove();
  },

  // THE ROSTER FAN BECOMES A NUMBER. 2v2 prints one small rectangle per card
  // each player holds, four players at up to ten cards, inside a band that also
  // has to carry the seat plate and the primary button — so the button was
  // being squeezed to fit a picture of a hand size. The count is the
  // information; the fan was the decoration. Read off the same spans the
  // renderer just built, so it cannot disagree with them.
  _slim2v2Roster() {
    if (!this._tt()) return;
    document.querySelectorAll('.twov2-roster-strip .rc-chip .rc-hand').forEach((h) => {
      const cards  = h.querySelectorAll('.rc-back-card').length;
      const tricks = h.querySelectorAll('.rc-back-trick').length;
      if (!cards && !tricks && !h.dataset.bv2Sig) return;   // nothing to read yet
      const sig = cards + '/' + tricks;
      if (h.dataset.bv2Sig === sig) return;
      h.dataset.bv2Sig = sig;
      h.innerHTML = '<span class="bv2-rc-n">' + cards + '</span><i>cards</i>' +
                    '<span class="bv2-rc-n">' + tricks + '</span><i>tricks</i>';
    });
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
  // RETIRED. The left rail used to print its own copy of the last few log
  // lines; the right rail carries the whole log now (see _paintNotices), and
  // two panels quoting the same array is the duplication the notice feed was
  // removed for. renderBoardAside still BUILDS that node — it is the shipping
  // board's panel and is shared — so board-v2.css hides it rather than this
  // file deleting it, which keeps that renderer free of a board-v2 special
  // case. Kept as a no-op so the render tail needs no conditional.
  _fillRailLog(s) { return; },

  // Every internal proportion of a card face derives from --card-w. Board V2
  // sizes the board card with `width: 100%` so it fills its slot, which left
  // --card-w as the literal string `100%` — and `calc(100% * k)` in a
  // font-size context resolves against the PARENT font size, not the card. So
  // the cost numeral computed to 1.37px on board against 8.38px in hand: the
  // ribbon was drawn, the number inside it was a rounding error tall.
  //
  // The slot's width is set by the lane and its own height cap, never by the
  // card, so measuring it and handing the length back down is not a loop.
  // THE SLOT IS A CARD-SHAPED HOLE, AT EVERY WINDOW SIZE.
  //
  // A card renders at a fixed 130 x 257 (measured 1.977, and the hand card holds
  // it to three decimals at every size). The board slot had no ratio at all —
  // `aspect-ratio: auto; flex: 1 1 0` — so its WIDTH came from the lane column
  // and its HEIGHT came from whatever vertical space the grid had left over.
  // Two independent axes, so the shape moved with the window: measured 2.62 at
  // 1200x1000, 2.07 at 1278x932, and 0.81 at 1920x780 — where the card came out
  // 221 wide by 169 tall, LANDSCAPE, because `max-height: 100%` then squashed it
  // into the hole. (Owner: "the board gets wider but the lanes shrink and change
  // aspect ratio, that shouldnt happen — this is the aspect ratio i want all
  // game.")
  //
  // CSS cannot fix this alone: fitting a fixed-ratio box inside a box whose two
  // dimensions come from a grid `1fr` needs both of those dimensions, and a
  // pure aspect-ratio version collapses (tried — the lane shrink-wraps a slot
  // whose width depends on the lane, and the slot came out 66 x 225). So the two
  // numbers are measured here, once per render, and published for the CSS.
  //
  // Whichever axis is tighter wins, exactly like the --u scale unit does for the
  // rest of the design: the card is as large as it can be without ever changing
  // shape. Spare height on a tall window goes into bigger cards; a short window
  // narrows the lanes and leaves gutters, which is what the shipping board has
  // always done (measured there: a 932-wide board in a 1920 window, card 1.978).
  _CARD_RATIO: 257 / 130,
  _sizeBoardCards() {
    const root = document.getElementById('board');
    if (!root) return;
    const lanes = root.querySelectorAll('.lane');
    const n = lanes.length;
    if (!n) return;
    const availW = root.clientWidth, availH = root.clientHeight;
    if (!availW || !availH) return;                    // not laid out yet
    const gap = parseFloat(getComputedStyle(root).columnGap) || 0;
    // One probe for the scale unit — the separator and the lane's side margin
    // are both authored in --u, so they have to be read in the same currency.
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;width:calc(100 * var(--u))';
    root.appendChild(probe);
    const u = probe.getBoundingClientRect().width / 100;
    probe.remove();
    if (!u) return;
    const R = this._CARD_RATIO;
    // Height available to ONE slot: the lane, less the midline, halved.
    const byHeight = (availH - 28 * u) / 2 / R;
    // Width available to one slot: the lane column, less the gaps and the 8u
    // the slot is inset from its lane.
    const byWidth  = (availW - (n - 1) * gap) / n - 8 * u;
    const w = Math.max(20, Math.min(byWidth, byHeight));
    const wv = Math.round(w * 100) / 100;
    if (wv === this._slotW) return;                    // nothing moved
    this._slotW = wv;
    root.style.setProperty('--bv2-slot-w', wv + 'px');
    root.style.setProperty('--bv2-slot-h', (Math.round(wv * R * 100) / 100) + 'px');
    root.style.setProperty('--bv2-board-card-w', wv + 'px');
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
  // BOX 2 — EVERY POP-UP LANDS HERE, in the right rail.
  //
  // The jump offer, the block-trick offer, the Time Stone intercept and the
  // prompt banner were four separate floating panels dropped over the middle of
  // the board — the thing you are trying to read while answering them. They now
  // dock in one column. (Owner: "in the 2 box is where all pop ups happen —
  // jumps, choose cards. it's no longer in the middle of the screen, it's just
  // here. all pop ups live there.")
  _renderDecision(s) {
    const rail = document.getElementById('bv2-rail-right')
              || this._el('bv2-rail-right', 'bv2-rail bv2-rail-right', document.getElementById('game-area'));
    if (!rail) return;
    const panel = this._el('bv2-decision', 'bv2-decision', rail);
    // Always FIRST in the rail — a question you have to answer sits above the
    // running commentary, not under it.
    if (rail.firstChild !== panel) rail.insertBefore(panel, rail.firstChild);
    if (!panel.firstChild) {
      panel.innerHTML =
        '<div class="bv2-cap bv2-cap-rule"><span class="bv2-cap-label">Decision</span>' +
        '<span class="bv2-cap-line"></span></div>' +
        '<div class="bv2-dec-slot"></div><div class="bv2-dec-body"></div>';
    }
    const body = panel.querySelector('.bv2-dec-body');
    const slot = panel.querySelector('.bv2-dec-slot');
    // ADOPT THE FLOATERS. Each of these builds itself at body level and places
    // itself over the board; moving the node (rather than copying it) keeps
    // every listener and countdown ui.js attached to it. Anything that got
    // built before this panel existed is pulled in on the next frame.
    if (slot) {
      // #choice-tray is in this list now. It is the "pick one of these cards"
      // panel — Gorilla Grodd's mind control, Deathstroke's assassinate,
      // Deadpool's give-back — and it was a bottom-anchored floating sheet with
      // a backdrop over the middle of the screen. It is the same kind of thing
      // as the other three and belongs in the same place. (Owner: "you summon
      // gorilla grodd, who do you mind control — pop up, the text and
      // everything lives there.") It is rebuilt from scratch each time it is
      // raised, so this re-adopts by id on every render rather than once.
      ['jump-offer-modal', 'block-trick-modal', 'time-stone-modal', 'choice-tray'].forEach(function (id) {
        const m = document.getElementById(id);
        if (m && m.parentNode !== slot) slot.appendChild(m);
      });
    }
    const banner = document.getElementById('prompt-banner');
    if (banner && banner.parentNode !== body) body.appendChild(banner);

    // The echo of the tray's title is gone with it — the tray itself is in the
    // slot above now, so repeating its heading here would just say it twice.
    const note = body.querySelector('.bv2-dec-echo');
    if (note) note.remove();

    const docked = !!(slot && slot.firstElementChild);
    panel.classList.toggle('is-live', !!(banner || note || docked));
    panel.classList.toggle('has-docked', docked);
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
  // Kept as a sink so every existing caller (and the toast hook below) still
  // has somewhere to go — the announcement itself already reaches the log,
  // which is now the only place it needs to be.
  notice(label, name, desc) { return; },
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
  // THE NOTICE FEED IS GONE — THE LOG IS THE RUNNING COMMENTARY.
  //
  // It was a second, shorter history sitting beside the real one, saying the
  // same things in fewer words ("AI PLAYED A TRICK / Power Stone") while the
  // log two panels away already had the line. Two feeds competing to be the
  // answer to "what just happened". (Owner: "get rid of notices bar all
  // together, that's where the log will be.")
  //
  // The rail's log is the full battle log through the viewer filter, newest
  // first, filling whatever height Box 2 is not using.
  _paintNotices() {
    const rail = document.getElementById('bv2-rail-right');
    if (!rail) return;
    const panel = this._el('bv2-log', 'bv2-log', rail);
    if (panel.parentNode !== rail) rail.appendChild(panel);
    if (!panel.firstChild) {
      panel.innerHTML =
        '<div class="bv2-cap bv2-cap-rule"><span class="bv2-cap-label">Log</span>' +
        '<span class="bv2-cap-line"></span></div><div class="bv2-log-list"></div>';
    }
    const list = panel.querySelector('.bv2-log-list');
    // THE LOG STARTS AT THE MATCH, NOT AT THE DRAFT.
    //
    // Every draft pick, the "draft complete" line, the round-1 banner and the
    // event roll sat at the bottom of this panel forever — a fixed block of
    // setup that never changes and that pushes the lines you are actually
    // reading up and out. (Owner, X-ing that block out: "get rid of ... the
    // event bottom right.") They are still in the full drawer, which is where
    // a record belongs; the rail is for what is happening.
    const _setup = /^\s*\[(DRAFT|EVENT)\]|^\s*---\s*Round 1\s*---/;
    const lines = ((typeof UI !== 'undefined' && UI.readableLog)
      ? UI.readableLog(Game.state && Game.state.log)
      : ((Game.state && Game.state.log) || [])
    ).filter(l => !_setup.test(String(l)));
    // START GENEROUS, LET THE MEASURE CUT BACK.
    //
    // This used to estimate how many lines would fit and take exactly that many
    // — and the estimate is a guess, because a line is one row or three
    // depending on where it wraps. Guessing low meant the panel rendered fewer
    // lines than it had room for and stopped partway down, leaving the bottom
    // of the box empty. (Owner: "the log can go to the bottom of the box.")
    // The trim below only ever REMOVES, so the fix is to hand it more than can
    // fit and let the measurement decide. 60 is a ceiling, not a target.
    const want = lines.slice(-60).reverse();
    const sig = want.length + '|' + (want[0] || '');
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    const esc = function (t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
    list.innerHTML = want.map(function (t, i) {
      return '<div class="bv2-log-line' + (i === 0 ? ' is-latest' : '') + '">' + esc(t) + '</div>';
    }).join('');
    // TRIM TO WHOLE LINES — THE ZONE DOES NOT BLEED.
    //
    // How many lines fit cannot be calculated: a log line is one row or three
    // depending on how its text wraps at this width, so the estimate above
    // (room / lineHeight) is only ever a starting guess. Left at the guess the
    // panel rendered more than it could show and overflow:hidden chopped the
    // last one mid-sentence at the zone's edge. (Owner: "the log is way too
    // long, it cuts off at the line — remember 4 zones, no bleed.")
    //
    // So it is MEASURED instead: drop the oldest line until the content fits
    // its box. Newest is first, so removing from the end always removes the
    // least interesting one, and the panel ends on a complete line.
    var guard = 0;
    while (list.children.length > 1 && list.scrollHeight > list.clientHeight && guard++ < 200) {
      list.removeChild(list.lastElementChild);
    }
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
      this._ensureHandRow();
      this._ensureButtonGlow();
      this._renderPhase(s);
      this._renderSeats(s);
      this._renderCounts(s);
      this._renderBandExtras(s);
      this._slim2v2Roster();
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
  // A window drag changes both of the numbers the slot is sized from and does
  // not necessarily re-render the board, so the slot would keep the shape it
  // had at the old size until something else happened to repaint.
  window.addEventListener('resize', () => {
    if (!BoardV2.enabled()) return;
    BoardV2._slotW = null;                    // force the recompute
    try { BoardV2._sizeBoardCards(); } catch (e) {}
  });
  // Apply the body class as early as possible so the first painted frame is
  // already in the right skin rather than flashing the old board.
  try { BoardV2.apply(); } catch (e) {}
}
