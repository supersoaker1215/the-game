/* ============================================================================
   BOARD V2 — the redesigned board. Gameplay identical; only the look differs.
   ============================================================================
   SEPARATE, AND OFF BY DEFAULT. Flipping it on adds `board-v2` to <body> and
   board-v2.css does the rest. With the flag off this file contributes nothing
   and the original board renders exactly as it did — same DOM, same ids.

   WHY IT RESTYLES RATHER THAN REPLACES. Other renderers in ui.js write into
   specific ids (#player-hp-fill, #ai-hand, #player-energy-display, #btn-action,
   .hand-cards, the FX layers, the prompt trays), and the combat FX stream
   targets elements BY ID at animation time. V2 keeps every existing element and
   id, moves them with CSS grid, and only ADDS the few missing pieces — so
   nothing the engine or FX layer reaches for can go missing.

   EVERYTHING IT PRINTS IS REAL. Where the reference shows a number this game
   does not have (e.g. a turn clock), the slot carries the phase's actual
   instruction instead of inventing one.
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
  // Nodes this file INSERTS survive the class going away. The rail adopts
  // #board-aside, which index.html keeps at BODY level because #game-area's
  // perspective transform would become the containing block for anything
  // position:fixed inside it. So the aside goes home and every added node is removed.
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
      // THE HAND AND TRICKS GO HOME BEFORE ANYTHING IS REMOVED. They live inside
      // #bv2-handrow while V2 is on, and the sweep below deletes every bv2- node.
      // Restored in reverse document order so each recorded next sibling is
      // already back in place.
      [['_tricksHome', '.tricks-section'], ['_handHome', '.player-hand-section']].forEach(([key, sel]) => {
        const home = this[key], node = document.querySelector(sel);
        if (!node || !home || node.parentNode === home.parent) return;
        if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(node, home.next);
        else home.parent.appendChild(node);
      });
      // The slot dimensions are inline custom properties on #board — not a bv2-
      // node, so the sweep cannot reach them; left behind they'd size the shipping
      // board's slots too. The primary button lives inside a bv2- wrapper; the sweep
      // would take the button with it.
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
      // 2v2 phase names are seat-keyed ('2v2-p3-cards-tricks'); say whose turn it
      // is by NAME, and whether it is yours, instead of the raw slug.
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

  // THE SEAT PLATE: [tag] [name over its own health bar] [HP] [TRICKS n/8].
  // The health bar lives INSIDE the plate, so the node is MOVED here and put back
  // by teardown() (same contract as #board-aside). Moving beats rebuilding:
  // #player-hp-fill / #ai-hp-fill are written by id from ui.js and the FX layer,
  // so a copy would go stale on the first hit.
  // ===================== 2v2 AWARENESS =====================
  // A SIDE IS A TEAM. Name, HP, hand count and trick count are per-PLAYER facts
  // in 1v1 and per-TEAM or per-SEAT in 2v2, and s.player / s.ai are combat
  // proxies that carry neither. These three answer it once so no panel guesses.
  _tt() { const s = (typeof Game !== 'undefined' && Game.state) || null; return (s && s.twoVTwo && s.twoVTwo.players) ? s.twoVTwo : null; },
  // WHICH TEAM IS ON THIS BAR — FROM THE CHAIR OF WHOEVER IS LOOKING.
  //
  // 'player' and 'ai' name the BOTTOM and TOP bar. Game._2v2TeamSide is the
  // engine's fixed A->player / B->ai map — right for the ENGINE, wrong for a
  // screen: Team B would see their own team on top. And _render2v2OnlineBoard
  // writes the VIEWER's team health into #player-health, which this plate adopts.
  //
  // Bottom is always MINE. Same rule as _deadPileSideForBar in ui.js — resolve
  // through the viewer, never the engine's map. Online that is the fixed seat;
  // in pass-and-play whoever is on the clock. With no seat, fall back to the map.
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
      // The plate ADOPTS the live .health-container (with #player-health /
      // #player-hp-fill inside). An innerHTML rewrite DELETES those elements; the
      // 2v2 renderer then writes getElementById('player-health') unguarded and
      // throws, and _render2v2OnlineBoard is not wrapped in _safe, so the rest of
      // the frame (block-trick modal, jump offer, Time Stone intercept, FX drain)
      // never draws.
      //
      // Build the skeleton once, then write text into stable nodes. The adopted
      // health bar sits inside .bv2-id and is never touched again.
      if (!plate.firstChild) {
        // THE HP NUMBER SITS ON THE NAME'S LINE, AND THE BAR RUNS UNDER BOTH — the
        // identity is one block, name and HP on one row, the bar spanning it beneath.
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
      // The LETTERS live in their own node: writing .textContent onto .bv2-tag
      // would wipe the face layers beside them on the next render.
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
  // AND both limits read live off the same objects the engine enforces against.
  // The hand cap is `maxHandSize` (7; Game.HAND_LIMIT does not exist). Mobius
  // Chair / Eye of Agamotto raise it to 8, and a hand over its cap (an MC
  // Ballyhoo candy may pass 3 on purpose) reads honestly as 4 / 3.
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

  // NO INJECTED LANE CHIP. The separator already has a `.lane-number` that ui.js
  // maintains (a second one doubles the digits); board-v2.css styles the real one
  // to the spec's 22px chamfered square instead.

  // TRICKS BELONG BESIDE THE HAND, NOT IN A COLUMN OF THEIR OWN — a trick is
  // played on your turn, so it reads with the hand. Done the way classic does it:
  // one row holding both, centred as a group, so the tricks land right after the
  // last hand card at every hand size. The nodes are MOVED and put back by
  // teardown(), because teardown removes every bv2- node and would take the hand.
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

  // THE PRIMARY BUTTON'S GLOW NEEDS AN UNCLIPPED WRAPPER.
  //
  // clip-path is applied AFTER filter, so a drop-shadow on the chamfer-clipped
  // #btn-action is cut away entirely. The filter goes on a WRAPPER that is not
  // clipped, with the clipped element inside. Safe because the click handler is
  // on the button itself, so it travels with the node.
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
      // Three stacked clipped shapes, not a shadow: tube, core, fill. SIBLINGS of
      // the button rather than pseudo-elements, because ui.js rewrites the button's
      // label and a pseudo cannot carry a third layer anyway.
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
    // With the tricks in the hand row, the notice feed needs a column of its own,
    // or the feed (and every prompt docked in it) travels down there with them.
    this._el('bv2-rail-right', 'bv2-rail bv2-rail-right', ga);
    // The existing aside already carries the "if combat resolves now" block and the
    // last log lines — reuse it rather than build a second that could disagree.
    // THE ASIDE IS PAINTED BY THE 1v1 TAIL, WHICH 2v2 NEVER REACHES, so paint it
    // here EVERY 2v2 render: renderBoardAside hides itself on non-turn phases and
    // returns early while hidden, so a one-shot bootstrap during setup would leave
    // it hidden forever.
    if (this._tt() && typeof UI !== 'undefined' && UI.renderBoardAside) {
      try { UI.renderBoardAside(Game.state); } catch (e) {}
    }
    // THE TURN-ORDER TRACKER is position:fixed on <body>, so it would sit on top of
    // the trick rail and the hand. It goes in the "what is happening" column —
    // moved, not copied, so the 2v2 renderer keeps updating the same node.
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

  // The two band pieces the shipping bar has no element for: the hand STACK's
  // count, and the turn flag. The backs are the existing #ai-hand children,
  // overlapped and trimmed to three by CSS; only the count needs a node.
  _renderBandExtras(s) {
    const ah = document.getElementById('ai-hand');
    if (ah && ah.parentNode) {
      const n = ah.children.length;
      const cnt = this._el('bv2-hand-count', 'bv2-hand-count', ah.parentNode);
      if (ah.nextSibling !== cnt) ah.parentNode.insertBefore(cnt, ah.nextSibling);
      if (cnt.textContent !== String(n)) cnt.textContent = String(n);
    }
    // NO TURN FLAG — the phase panel and the lit primary button already say it.
    // A leftover flag is removed here rather than in teardown, because the band it
    // was parked on is not a bv2- node.
    const _old = document.getElementById('bv2-turnflag');
    if (_old) _old.remove();
  },

  // THE ROSTER FAN BECOMES A NUMBER. 2v2's one-rectangle-per-card fan (four
  // players, up to ten cards) squeezes the primary button; the count is the
  // information. Read off the spans the renderer just built, so it can't disagree.
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

  // No minus sign: the arrow (CSS) carries direction and the colour carries who
  // is dealing; `-3` on a down-arrow says it twice. The sign is stripped for
  // DISPLAY only — the element's text changes, never the engine's value.
  _stripForecastSigns() {
    const cells = document.querySelectorAll('#lane-forecast-strip .lf-face');
    cells.forEach(el => {
      const t = (el.textContent || '');
      const clean = t.replace(/^[\u2212\-+]/, '');
      if (clean !== t) el.textContent = clean;
    });
  },

  // RETIRED. The right rail carries the whole log (see _paintNotices), so the
  // left rail no longer prints its own copy. renderBoardAside still BUILDS that
  // node (it is shared with the shipping board), so board-v2.css hides it rather
  // than this file special-casing that renderer. Kept as a no-op so the render
  // tail needs no conditional.
  _fillRailLog(s) { return; },

  // Every internal proportion of a card face derives from --card-w. V2 sizes the
  // board card `width: 100%`, which would leave --card-w as the string `100%`, and
  // `calc(100% * k)` in font-size resolves against the PARENT font size. The
  // slot's width is set by the lane and its height cap, never by the card, so
  // measuring it and handing the length back down is not a loop.
  // THE SLOT IS A CARD-SHAPED HOLE, AT EVERY WINDOW SIZE.
  //
  // A card renders at a fixed 130 x 257 (1.977). Without a ratio, slot WIDTH
  // comes from the lane column and HEIGHT from leftover grid space, so the shape
  // changes with the window (even going landscape). The aspect ratio must hold
  // for the whole game.
  //
  // CSS cannot fix this alone: fitting a fixed-ratio box inside a box whose two
  // dimensions come from a grid `1fr` needs both dimensions, and a pure
  // aspect-ratio version collapses (the lane shrink-wraps a slot whose width
  // depends on the lane). So both numbers are measured once per render and
  // published for the CSS.
  //
  // Whichever axis is tighter wins, like the --u scale unit: the card is as large
  // as it can be without changing shape. A short window narrows the lanes and
  // leaves gutters, as the shipping board always has.
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
  // BOX 2 — EVERY POP-UP LANDS HERE, in the right rail.
  //
  // The jump offer, the block-trick offer, the Time Stone intercept, the choice
  // tray and the prompt banner all dock in one column instead of floating over
  // the board you're trying to read. They are MOVED, not copied — one node, so
  // every listener ui.js attached comes along and countdowns keep ticking.
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
    // ADOPT THE FLOATERS. Each builds itself at body level over the board; moving
    // the node (not copying it) keeps every listener and countdown ui.js attached.
    // Anything built before this panel existed is pulled in on the next frame.
    if (slot) {
      // #choice-tray ("pick one of these cards" — Grodd, Deathstroke, Deadpool) is
      // rebuilt from scratch each time it is raised, so this re-adopts by id on
      // every render rather than once.
      ['jump-offer-modal', 'block-trick-modal', 'time-stone-modal', 'choice-tray'].forEach(function (id) {
        const m = document.getElementById(id);
        if (m && m.parentNode !== slot) slot.appendChild(m);
      });
    }
    const banner = document.getElementById('prompt-banner');
    if (banner && banner.parentNode !== body) body.appendChild(banner);

    // No echo of the tray's title — the tray itself is in the slot above.
    const note = body.querySelector('.bv2-dec-echo');
    if (note) note.remove();

    const docked = !!(slot && slot.firstElementChild);
    panel.classList.toggle('is-live', !!(banner || note || docked));
    panel.classList.toggle('has-docked', docked);
  },

  // ===========================================================================
  // BOX 1 - NOTICES, in the right rail under the tricks.
  // In V2 the corner toast is suppressed and every announcement lands in the log
  // as a line that stays. The full-screen trick REVEAL is a cinematic, not a
  // notice, and is left alone; it logs a line as it plays.
  // ===========================================================================
  _NOTICE_MAX: 8,
  // Kept as a sink so every existing caller (and the toast hook below) still
  // has somewhere to go — the announcement already reaches the log.
  notice(label, name, desc) { return; },
  // The feed is on the singleton, so it outlives a match unless dropped. No
  // passive signal distinguishes matches (`_leaderboardMatchId` is null in solo,
  // state is REUSED, the log isn't truncated); the one unambiguous event is the
  // call that starts one.
  _clearNotices() {
    this._notices = [];
    const list = document.querySelector('#bv2-notices .bv2-note-list');
    if (list) { delete list.dataset.sig; list.innerHTML = ''; }
    const panel = document.getElementById('bv2-notices');
    if (panel) panel.classList.remove('is-live');
  },
  // THE LOG IS THE RUNNING COMMENTARY — no separate notice feed competing with
  // it. The rail's log is the full battle log through the viewer filter, newest
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
    // THE LOG STARTS AT THE MATCH, NOT AT THE DRAFT. Draft picks, "draft
    // complete", the round-1 banner and the event roll stay in the full drawer;
    // the rail is for what is happening now.
    const _setup = /^\s*\[(DRAFT|EVENT)\]|^\s*---\s*Round 1\s*---/;
    const lines = ((typeof UI !== 'undefined' && UI.readableLog)
      ? UI.readableLog(Game.state && Game.state.log)
      : ((Game.state && Game.state.log) || [])
    ).filter(l => !_setup.test(String(l)));
    // START GENEROUS, LET THE MEASURE CUT BACK. Line count can't be estimated (a
    // line wraps to one row or three), and the trim below only ever REMOVES — so
    // hand it more than can fit. 60 is a ceiling, not a target.
    const want = lines.slice(-60).reverse();
    const sig = want.length + '|' + (want[0] || '');
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    const esc = function (t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
    list.innerHTML = want.map(function (t, i) {
      return '<div class="bv2-log-line' + (i === 0 ? ' is-latest' : '') + '">' + esc(t) + '</div>';
    }).join('');
    // TRIM TO WHOLE LINES — THE ZONE DOES NOT BLEED. Drop the oldest line until
    // the content fits its box (overflow:hidden would chop the last one
    // mid-sentence). Newest is first, so removing from the end removes the least
    // interesting one and the panel ends on a complete line.
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
  // A window drag changes both numbers the slot is sized from without
  // necessarily re-rendering the board, so re-measure on resize.
  window.addEventListener('resize', () => {
    if (!BoardV2.enabled()) return;
    BoardV2._slotW = null;                    // force the recompute
    try { BoardV2._sizeBoardCards(); } catch (e) {}
  });
  // Apply the body class as early as possible so the first painted frame is
  // already in the right skin rather than flashing the old board.
  try { BoardV2.apply(); } catch (e) {}
}
