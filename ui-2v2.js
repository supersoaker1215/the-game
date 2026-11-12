// ============================================================
// ui-2v2.js — THE 2v2 SCREENS (split out of ui.js, 2026-11-12)
// ============================================================
// Every 2v2 renderer — local + online setup, lobby, draft, pass screens, board, turn tracker — and the 2v2 seat/visibility helpers.
//
// Same contract as fx.js: this file loads BEFORE ui.js and only declares
// UI_2V2, a plain object of methods written exactly as they were inside the
// UI literal; ui.js merges it into UI right after that literal and before
// UI.init(). Methods keep `this`, so every UI.whatever call is unchanged.
// ============================================================
const UI_2V2 = {

  // 2v2 guest: the three non-host seats never run the engine, so the card-play
  // and card-death FX the host fires live never reach them. Diff the board
  // between the old and incoming broadcast by card id and fire the matching cue
  // (id-based, so a card that just MOVED lanes stays silent). Mirrors the 1v1
  // guest lane-diff in _mpInit. Called before the state swap on the joiner path.
  //
  // WHY DEATHS ARE HANDLED HERE AND NOT ON THE FX RELAY. This is the only
  // moment a guest can animate a death: it runs BEFORE Game.state is swapped,
  // so the dying card is still on screen. The generic sig relay drains from
  // showDamageFloats — after the swap and after the re-render — where the
  // element is already gone and the particle burst would silently find nothing
  // to burst. So the guests heard the death and never saw it: no dissolve, no
  // shards, no kill flash, cards just blinked out. (User: "make sure all the
  // animations ... fire and work ... when 4 people are playing.")
  // Named ...CardFx, not ...CardSounds, because it is no longer only sound.
  _relay2v2CardFx(oldState, newState) {
    try {
      if (!oldState || !newState || !this.sfx || !this.sfx.playCardSfx) return;
      const idsOf = (st) => {
        const m = {};
        (st.lanes || []).forEach(l => ['player', 'ai'].forEach(s => {
          const c = l && l[s]; if (c && c.id != null) m[c.id] = c;
        }));
        return m;
      };
      const before = idsOf(oldState), after = idsOf(newState);
      for (const id in after) if (!(id in before)) {
        const c = after[id]; try { this.sfx.playCardSfx(c.name, 'play', c); } catch (e) {}
      }
      for (const id in before) if (!(id in after)) {
        const c = before[id];
        try { this.sfx.playCardSfx(c.name, 'death', null); } catch (e) {}
        // The card is still in the DOM at this instant — burst it here.
        // spawnDestroyParticles maps the kill-flash side through _fxDomSide,
        // so the absolute owner recorded in the board state reads correctly on
        // whichever team this viewer is on.
        try { if (this.spawnDestroyParticles) this.spawnDestroyParticles(c.id, c.owner); } catch (e) {}
      }
    } catch (e) {}
  },

  // ===================== 2v2 ONLINE DRAFT RENDERING =====================
  // Renders the 2v2 online draft using the same polished card-art UI as the
  // 1v1 draft (portraits, stat orbs, rarity pips, progress pips). Non-active
  // pickers see a waiting spinner. Reads from tt.draft instead of s.draft.
  // ===================== 2v2 LOCAL — POLISHED BOARD =====================
  // Wraps _render2v2OnlineBoard for local (same-device) 2v2. Temporarily
  // sets tt.you = activeKey so the shared renderer knows who is acting,
  // then re-wires Done / lane-select / trick clicks to local handlers.
  _render2v2LocalGame(s) {
    const tt = s.twoVTwo;
    if (!tt) return;
    const activeKey = Game._2v2ActivePlayer();
    if (!activeKey) return;
    const prevYou = tt.you;
    tt.you = activeKey;
    this._render2v2OnlineBoard(s);
    tt.you = prevYou;

    // Done button → local phase-end handler
    const btnA = document.getElementById('btn-action');
    if (btnA && btnA.style.display !== 'none') {
      btnA.onclick = () => Game.end2v2Phase(null, { actor: Game._2v2ActivePlayer() });
    }

    // Lane-select buttons → local place function (re-write onclick string)
    const strip = document.getElementById('twov2-board-lane-select');
    if (strip) {
      strip.querySelectorAll('.twov2-bls-btn').forEach(btn => {
        const old = btn.getAttribute('onclick');
        if (old) btn.setAttribute('onclick', old.replace('twov2OnlinePlaceCard', 'twov2PlaceCard'));
      });
    }

    // Trick clicks → READ, not play. Same fix and same reason as the online
    // tray (_apply2v2OnlineTrickClicks): pass-and-play had the identical
    // play-on-first-tap wiring. The inspect view's Play button commits via
    // twov2PlayTrick, so nothing is lost — it just takes a deliberate second
    // tap, exactly like a card.
    const tricksEl = document.getElementById('player-tricks');
    if (tricksEl) {
      tricksEl.querySelectorAll('.trick-card').forEach((el) => {
        if (!el.onclick) return;
        el.onclick = (e) => {
          e.stopPropagation();
          if (UI.showCardInspect) UI.showCardInspect(el);
        };
      });
    }
  },

  // ===================== 2v2 LOCAL — POLISHED DRAFT =====================
  // Wraps _render2v2OnlineDraftPolished for local 2v2. Temporarily sets
  // tt.you = pickerKey so the shared renderer shows the right player's
  // hand, then re-wires pick clicks to the local twov2DraftPick handler.
  _render2v2LocalDraft(s) {
    const tt = s.twoVTwo;
    if (!tt || !tt.draft) return;
    const d = tt.draft;
    const pickerKey = d.pickerOrder[d.pickerIdx];
    const prevYou = tt.you;
    tt.you = pickerKey;
    // Hide local overlay so the polished draftEl shows instead
    const overlay = document.getElementById('twoVTwo-overlay');
    if (overlay) overlay.style.display = 'none';
    this._render2v2OnlineDraftPolished(s);
    tt.you = prevYou;

    // Re-wire pick and mulligan onclicks to local functions
    const draftEl = this.draftEl;
    if (draftEl) {
      draftEl.querySelectorAll('[onclick*="twov2OnlineDraftPick"]').forEach(el => {
        const old = el.getAttribute('onclick');
        if (old) el.setAttribute('onclick', old.replace('twov2OnlineDraftPick', 'twov2DraftPick'));
      });
      draftEl.querySelectorAll('[onclick*="twov2OnlineDraftMulligan"]').forEach(el => {
        el.setAttribute('onclick', 'twov2DraftMulligan()');
      });
      // Swap Leave → Menu button
      const leaveBtn = draftEl.querySelector('.draft-quit-btn');
      if (leaveBtn) {
        const lbl = leaveBtn.querySelector('.mulligan-label');
        if (lbl) lbl.textContent = 'Menu';
        leaveBtn.setAttribute('onclick', 'Game.quit ? Game.quit() : (Game.state.phase = "main-menu", UI.render())');
      }
    }
  },

  _render2v2OnlineDraftPolished(s) {
    const tt = s.twoVTwo;
    if (!tt || !tt.draft) return;

    // Hide the text-based 2v2 overlay so only the polished draft element shows
    const twov2El = document.getElementById('twoVTwo-overlay');
    if (twov2El) twov2El.style.display = 'none';

    const d = tt.draft;
    const sim = !!d.simultaneous;   // online = everyone picks at once
    const myKey = tt.you;
    const ap = tt.players[myKey];
    const isCards = d.phase === 'cards';
    const round = d.round;
    const total = isCards ? 4 : 2;

    // In simultaneous mode "the picker" is simply me — I'm active until I lock
    // in this round, then I wait for the others. In sequential (local) mode the
    // active picker walks the pickerOrder as before.
    const iPicked   = sim ? !!(d.picked && d.picked[myKey]) : false;
    const pickerKey = sim ? myKey : d.pickerOrder[d.pickerIdx];
    const picker    = tt.players[pickerKey];
    const isMyPick  = sim ? !iPicked : (myKey === pickerKey);
    const myChoices = sim ? (d.choicesByPlayer && d.choicesByPlayer[myKey]) || [] : d.choices;
    const teamColor = (sim ? ap.team : picker.team) === 'A' ? '#4fc3f7' : '#f44336';
    // Who else hasn't locked in yet (simultaneous waiting view).
    const stillOut = sim ? ['p1','p2','p3','p4'].filter(k => !(d.picked && d.picked[k])).map(k => tt.players[k].name) : [];

    const pips = [];
    for (let i = 1; i <= total; i++) {
      const cls = i < round ? 'pip-done' : i === round ? 'pip-current' : 'pip-future';
      pips.push(`<span class="draft-pip ${cls}"></span>`);
    }

    // ONE FRAME FOR BOTH PHASES. `draft-tricks` on the panel re-themes the label,
    // the sub-line, the pips, the counter and both edge glows — 30 rules, and not
    // one of them styles a trick CARD (those carry their own trick-draft classes
    // from makeTrickEl). So the class only ever repainted the chrome, which is
    // precisely the screen-change the owner asked to be rid of. The phase goes
    // on a data attribute instead, for anything that genuinely needs it.
    let html = `<div class="draft-panel draft-cards" data-draft-phase="${isCards ? 'cards' : 'tricks'}">`;
    html += `<div class="draft-hud">`;
    html +=   `<div class="draft-hud-row">`;
    html +=     `<span class="draft-hud-label" style="color:${teamColor}">${isMyPick ? 'Your Pick' : (sim ? 'Locked In' : picker.name + "’s Pick")}</span>`;
    html +=     `<span class="draft-hud-pips">${pips.join('')}</span>`;
    html +=     `<span class="draft-hud-counter">Pick <em>${round}</em> / ${total}</span>`;
    html +=   `</div>`;
    // NOTHING ON YOUR OWN TURN. "Choose one card for your hand" restated what
    // the header ("Your Pick"), the counter ("Pick 2 / 4") and two cards with
    // nothing else to click already say three times over — it was a line of
    // instructions above a screen that has one possible action. The WAITING
    // states stay, because those genuinely carry information you cannot get
    // from anywhere else on the screen: who the table is still waiting on.
    const subText = isMyPick
      ? ''
      : (sim ? `Waiting for ${stillOut.join(', ')}…` : `Waiting for ${picker.name} to choose…`);
    if (subText) html += `<div class="draft-hud-sub">${subText}</div>`;
    // WHO LEADS THIS GAME — mirror the 1v1 draft's first-player callout. The
    // opener is randomized per match (_2v2StartOffset), so surface it here so
    // everyone knows the turn order before the match starts. (User: "on the
    // draft screen have it say who is playing first for this game.")
    try {
      const firstSeat = (Game._2v2ComputePhaseOrder(1)[0] || '').split('-')[0];
      if (firstSeat && tt.players[firstSeat]) {
        const firstName = firstSeat === myKey ? 'You' : (tt.players[firstSeat].name || firstSeat);
        const verb = firstSeat === myKey ? 'play' : 'plays';
        // WHOSE SIDE OPENS, not whose seat. In 2v2 a teammate leading is your
        // team leading, so the test is TEAM: your side gets the theme neon, the
        // other side gets the enemy red. Same two classes the 1v1 banner uses,
        // so both screens are coloured by one pair of rules.
        const myTeam    = tt.players[myKey] && tt.players[myKey].team;
        const firstTeam = tt.players[firstSeat].team;
        const side = (myTeam && firstTeam === myTeam) ? 'is-mine' : 'is-theirs';
        html += `<div class="draft-hud-sub draft-first-player ${side}">${firstName} ${verb} first this game</div>`;
      }
    } catch (e) {}
    const mulliganKey = isCards ? 'mulliganUsed' : 'trickMulliganUsed';
    const mulliganUsed = !!(d[mulliganKey] && d[mulliganKey][pickerKey]);
    const mulliganDisabled = mulliganUsed ? ' mulligan-used' : '';
    const mulliganAttr     = mulliganUsed ? ' disabled' : '';
    const mulliganLabel    = mulliganUsed ? 'Mulligan Used' : 'Mulligan';

    // SAME CONTROL ROW AS THE 1v1 DRAFT (owner: "copy the draft and make it the
    // same"). The 2v2 draft is the same activity — read two offers, take one —
    // so it gets the same controls, in the same order, from the same classes.
    //
    // BACK is deliberately absent: 1v1's draft is sequential and can rewind the
    // last pick, but 2v2 online is SIMULTANEOUS — three other people are
    // picking against the same pool at the same time, and un-picking would have
    // to un-deal their offers too. Adding it would change the game, which is
    // exactly what was asked not to happen.
    html +=   `<div class="draft-hud-actions">`;
    html +=     `<button type="button" class="draft-quit-btn" onclick="twov2OnlineLeave()" title="Leave game">`;
    html +=       `<span class="mulligan-icon">&#8592;</span><span class="mulligan-label">Leave</span>`;
    html +=     `</button>`;
    // Hand-audio privacy — draft cards have per-card hover cues, so someone
    // beside you (or on the call) can hear which offers you are weighing. In
    // 2v2 there are three other people listening, so it matters MORE here than
    // in 1v1. Same setting, same persisted key, same [data-hand-audio-toggle]
    // hook that keeps every surface in sync.
    const _ha2 = !!(this.settings && this.settings.handAudioPrivacy);
    html +=     `<button type="button" class="draft-audio-btn${_ha2 ? ' is-muted' : ''}"`;
    html +=       ` data-hand-audio-toggle aria-pressed="${_ha2 ? 'true' : 'false'}"`;
    html +=       ` onclick="UI.toggleHandAudioPrivacy()"`;
    html +=       ` title="${_ha2 ? 'Hand sounds hidden — per-card hover cues are replaced with one generic blip' : 'Hide hand sounds — stop per-card hover cues from revealing your picks'}">`;
    html +=       `<span class="mulligan-icon">&#9834;</span>`;
    html +=       `<span class="mulligan-label">${_ha2 ? 'Sounds Hidden' : 'Hide Sounds'}</span>`;
    html +=     `</button>`;
    // The mulligan button is shown whether or not it is still yours to spend —
    // hiding it once locked in (the old `if (isMyPick)`) meant the row silently
    // changed shape mid-draft and you could not see that you still had one.
    html +=     this._draftMulliganHTML(mulliganUsed || !isMyPick, 'twov2OnlineDraftMulligan()');
    html +=   `</div>`;
    html += `</div>`;
    // Same two rails as the 1v1 draft — one implementation, called from both,
    // so the screens cannot drift. In 2v2 a seat's picks ARE its hand, and the
    // 'opponent' is the other TEAM, so the readout names both of them and how
    // many have locked in this round rather than pretending there is one rival.
    const _railPicks2 = ((ap && ap.hand) || []).slice();   // the deck is the deck — see renderDraft
    const _oppSeats = ['p1','p2','p3','p4'].filter(k => tt.players[k] && ap && tt.players[k].team !== ap.team);
    const _oppNames = _oppSeats.map(k => tt.players[k].name).join(' · ');
    const _oppIn = _oppSeats.filter(k => d.picked && d.picked[k]).length;
    html += `<div class="draft-stage">`;
    html +=   this._draftPicksRailHTML([
                { label: 'Pick', kind: 'card', items: (ap && ap.hand) || [], total: 4, active: isCards },
              ], 0, { title: 'Your picks' });
    html += `<div class="draft-choices">`;

    if (!isMyPick) {
      const waitTitle = sim ? 'Locked in — waiting for your rivals' : `Waiting for ${picker.name}…`;
      const waitSub   = sim
        ? (stillOut.length ? `Still choosing: ${stillOut.join(', ')}` : 'Everyone in — next round loading…')
        : "They're picking from their own offers.";
      html += `<div class="draft-waiting">`;
      html +=   `<div class="draft-waiting-spinner"></div>`;
      html +=   `<div class="draft-waiting-title" style="color:${teamColor}">${waitTitle}</div>`;
      html +=   `<div class="draft-waiting-sub">${waitSub}</div>`;
      html += `</div>`;
    } else {
      this._draftOfferOrder(myChoices).forEach(({ c, i }) => {
        if (isCards) {
          // Same one renderer as classic draft — only the pick fn differs.
          html += `<div class="draft-offer">` + this._draftCardHTML(c, i, 'twov2OnlineDraftPick')
                + this._draftCardFootHTML(c, _railPicks2) + `</div>`;
        } else {
          html += `<div class="draft-offer">`
                + this.makeTrickEl(c, { extraClass: 'draft-card trick-draft', onclick: 'twov2OnlineDraftPick(' + i + ')' })
                + this._draftCardFootHTML(c, _railPicks2) + `</div>`;
        }
      });
    }

    html += `</div>`; // draft-choices

    if (ap) {
      // Nothing here — the left rail carries the picks in both phases.
    }

    html +=   this._draftDeckRailHTML(_railPicks2, { title: 'Deck so far', oppName: _oppNames, oppPicked: _oppIn,
                tricks: { items: (ap && ap.trickHand) || [], total: 2, active: !isCards } });
    html += `</div>`;   // /draft-stage
    html += `</div>`; // draft-panel
    this.draftEl.innerHTML = html;
    if (this.applyTronFx) this.applyTronFx();
  },

  _render2v2TurnTracker(s, tt) {
    let el = document.getElementById('twov2-turn-tracker');
    if (!el) {
      el = document.createElement('div');
      el.id = 'twov2-turn-tracker';
      el.className = 'twov2-tracker';
      document.body.appendChild(el);
    }
    // ---- 1v1 ONLINE: two seats, three steps, same rail ----
    if (!tt || !tt.players) {
      const online1v1 = Game.isMultiplayer && Game.isMultiplayer();
      if (!online1v1 || !s || !/^(player|ai)-/.test(s.phase || '')) { el.style.display = 'none'; return; }
      const o = this._1v1TrackerOrder(s);
      return this._paintTurnTracker(el, {
        round: s.round || 1,
        idx: o.idx,
        rows: o.steps.map(st => ({
          // The opponent by NAME, not "AI" — this rail only shows in an online
          // match, where the other seat is a person. oppName is the same source
          // the trick reveal and the seat strips already use.
          name: st.side === 'player'
            ? 'You'
            : (this.oppName ? this.oppName() : (Game.seatLabel ? Game.seatLabel('ai') : 'Opponent')),
          kind: st.kind,
          you: st.side === 'player',      // 1v1 state is seat-flipped, so 'player' IS me
          isAI: false,
          color: st.side === 'player' ? '#4fc3f7' : '#ff7a6b',
        })),
      });
    }
    if (!tt.round || !Game._2v2ComputePhaseOrder) { el.style.display = 'none'; return; }
    const round = tt.round || 1;
    const order = Game._2v2ComputePhaseOrder(round) || [];
    if (!order.length) { el.style.display = 'none'; return; }
    const idx = tt.subPhaseIdx | 0;
    const myKey = tt.you || null;
    const teamColor = (team) => team === 'A' ? '#4fc3f7' : team === 'B' ? '#ff7a6b' : '#8a94a0';
    // Both modes describe their round as the same list of rows, so the rail is
    // painted once (below) rather than twice.
    return this._paintTurnTracker(el, {
      round, idx,
      rows: order.map((step) => {
        const pk = step.split('-')[0];
        const p = (tt.players && tt.players[pk]) || {};
        return {
          name: p.name || ('Player ' + (pk[1] || '?')),
          kind: step.split('-').slice(1).join('-'),
          you: !!myKey && pk === myKey,
          isAI: !!p.isAI,
          color: teamColor(p.team || ''),
          team: p.team || '',
          // The seat key, so the painter can ask Voice who is talking without
          // matching on display names (two players may share one).
          seat: pk,
        };
      }),
    });
  },

  // ONE PAINTER FOR BOTH MODES. rows = [{ name, kind, you, isAI, color, team }],
  // idx = which row is NOW (rows.length means the round is done). Everything
  // that makes the rail a rail — the drag handle, the resize grip, the collapse
  // click, the saved geometry — lives here, so 1v1 inherits all of it by
  // construction rather than by a second copy that drifts.
  // WHAT THIS TURN LETS YOU DO, in words — "Cards", "Tricks", "Cards + Tricks".
  // Accepts a full sub-phase ('p1-cards-tricks') or a bare kind ('cards'), so
  // the turn rail and the End button can read the SAME answer off the SAME
  // authority instead of each spelling the rule out again. (The board header
  // had its own copy that compared the full sub-phase against 'cards' and so
  // never matched — every turn read "Turn".)
  _2v2PhaseLabel(kind) {
    const k = String(kind || '');
    const c = k.indexOf('cards') >= 0, t = k.indexOf('tricks') >= 0;
    return (c && t) ? 'Cards + Tricks' : c ? 'Cards' : t ? 'Tricks' : '\u2014';
  },

  // ===================== TURN-ORDER PANEL: MOVE + RESIZE =====================
  // The rail is pinned to the right edge at a fixed width, which on a narrow
  // window sits on top of the last lanes — and a player could not move a board
  // element out of their own way. (User: "make it so that you can move it
  // wherever you want, and you can adjust the size of it so it's never blocking
  // a lane for anyone.") Geometry is per-DEVICE (localStorage), never match
  // state: where your panel sits is not something the other three seats inherit.
  _2v2TrackerGeom() {
    if (this.__tkGeom !== undefined) return this.__tkGeom;
    let g = null;
    try { g = JSON.parse(localStorage.getItem('tk2v2Geom') || 'null'); } catch (e) { g = null; }
    this.__tkGeom = (g && typeof g.left === 'number' && typeof g.top === 'number') ? g : null;
    return this.__tkGeom;
  },
  _2v2TrackerSaveGeom(g) {
    this.__tkGeom = g;
    try {
      if (g) localStorage.setItem('tk2v2Geom', JSON.stringify(g));
      else localStorage.removeItem('tk2v2Geom');
    } catch (e) {}
  },
  // Re-applied on every render (the panel re-renders constantly) and re-CLAMPED
  // each time, so a panel parked near the right edge of a wide window is still
  // reachable after the window shrinks instead of stranded off-screen.
  _2v2TrackerApplyGeom(el) {
    const g = this._2v2TrackerGeom();
    if (!g) return;
    const w = g.w || el.offsetWidth || 176;
    const h = g.h || el.offsetHeight || 0;
    const maxL = Math.max(4, (window.innerWidth || 0) - w - 4);
    const maxT = Math.max(4, (window.innerHeight || 0) - Math.max(h, 40) - 4);
    el.classList.add('is-placed');
    el.style.right = 'auto';
    // ...and bottom. The default anchor is bottom-right now, so leaving that
    // set while writing an explicit `top` would over-constrain a fixed box with
    // auto height — the panel stretches to fill the gap between the two edges
    // instead of hugging its chips. A placed panel is positioned by its top-left
    // corner and nothing else.
    el.style.bottom = 'auto';
    el.style.transform = 'none';
    el.style.left = Math.min(Math.max(g.left, 4), maxL) + 'px';
    el.style.top  = Math.min(Math.max(g.top, 4), maxT) + 'px';
    if (g.w) el.style.width = g.w + 'px';
    // SCALE THE TEXT WITH THE BOX. Resizing used to grow only the width, so a
    // bigger panel just meant wider rows with more empty space and the same tiny
    // text. Every font-size in the tracker is now multiplied by --tk-scale (see
    // style.css), derived from the width against the 158px base, so making it
    // bigger makes the WHOLE thing bigger. Clamped so it stays readable and never
    // runs away. (Owner: "i want the whole thing to get bigger and not have a ton
    // of empty space.")
    const TK_BASE_W = 158;
    const tkScale = Math.max(0.85, Math.min(2.4, (g.w ? g.w / TK_BASE_W : 1)));
    el.style.setProperty('--tk-scale', tkScale.toFixed(3));
    // A collapsed panel is just its header — holding the expanded height would
    // leave a tall empty box, the opposite of getting out of the way.
    if (g.h && !el.classList.contains('is-collapsed')) {
      el.style.height = g.h + 'px';
      el.style.maxHeight = 'none';
    } else {
      el.style.height = 'auto';
      el.style.maxHeight = '';
    }
  },
  _2v2TrackerResetGeom(el) {
    this._2v2TrackerSaveGeom(null);
    el.classList.remove('is-placed');
    // 'bottom' belongs in this list now that the default anchor uses it — the
    // placed state sets it to 'auto', and a reset that left that inline would
    // drop the panel back to wherever `top` last put it instead of the corner.
    ['left', 'top', 'right', 'bottom', 'transform', 'width', 'height', 'maxHeight']
      .forEach(k => { el.style[k] = ''; });
  },
  _2v2TrackerMakeMovable(el) {
    if (el._tkWired) return;
    el._tkWired = true;
    const UIref = this;
    let mode = null, sx = 0, sy = 0, sl = 0, st = 0, sw = 0, sh = 0, moved = false;
    const hit = (e, sel) => e.target && e.target.closest && e.target.closest(sel);
    el.addEventListener('pointerdown', (e) => {
      const onGrip = hit(e, '.twov2-tk-grip');
      const onHead = hit(e, '.twov2-tk-head');
      if (!onGrip && !onHead) return;
      mode = onGrip ? 'size' : 'move';
      moved = false;
      // Freeze the CURRENTLY rendered box as explicit geometry before the drag
      // math starts — the default styling is right-anchored and
      // transform-centred, and dragging that by deltas fights the anchor.
      const r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY;
      sl = r.left; st = r.top; sw = r.width; sh = r.height;
      el.classList.add('is-placed', mode === 'move' ? 'is-dragging' : 'is-sizing');
      el.style.right = 'auto';
      el.style.transform = 'none';
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.width = r.width + 'px';
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!mode) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      // A few pixels of travel is a click, not a drag — that slack is what lets
      // the same handle still collapse the panel.
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      if (mode === 'move') {
        const w = el.offsetWidth, h = el.offsetHeight;
        el.style.left = Math.min(Math.max(sl + dx, 4), Math.max(4, window.innerWidth - w - 4)) + 'px';
        el.style.top  = Math.min(Math.max(st + dy, 4), Math.max(4, window.innerHeight - h - 4)) + 'px';
      } else {
        el.style.width = Math.min(Math.max(sw + dx, 108), Math.max(108, window.innerWidth - sl - 6)) + 'px';
        el.style.height = Math.min(Math.max(sh + dy, 56), Math.max(56, window.innerHeight - st - 6)) + 'px';
        el.style.maxHeight = 'none';
      }
    });
    const end = (e) => {
      if (!mode) return;
      const wasMove = (mode === 'move'), didMove = moved;
      mode = null;
      el.classList.remove('is-dragging', 'is-sizing');
      try { el.releasePointerCapture(e.pointerId); } catch (_) {}
      if (!didMove) {
        // A click on the head that never travelled is the old collapse toggle.
        if (wasMove) {
          UIref._2v2TrackerCollapsed = !UIref._2v2TrackerCollapsed;
          if (UIref.render) UIref.render();
        }
        return;
      }
      const r = el.getBoundingClientRect();
      UIref._2v2TrackerSaveGeom({
        left: Math.round(r.left), top: Math.round(r.top),
        w: Math.round(r.width),
        h: el.classList.contains('is-collapsed') ? 0 : Math.round(r.height),
      });
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // Double-click the header to put it back where it started — the way out of
    // a panel dragged somewhere useless.
    el.addEventListener('dblclick', (e) => {
      if (!hit(e, '.twov2-tk-head')) return;
      UIref._2v2TrackerResetGeom(el);
      if (UIref.render) UIref.render();
    });
  },

  _render2v2OnlineBoard(s) {
    const tt = s.twoVTwo;
    if (!tt || !tt.you) return;
    const myKey  = tt.you;
    const ap     = tt.players[myKey];
    if (!ap) return;

    const myTeam    = ap.team;
    const oppTeam   = myTeam === 'A' ? 'B' : 'A';
    const mySide    = Game._2v2TeamSide[myTeam];
    const activeKey = Game._2v2ActivePlayer();
    const isMyTurn  = activeKey === myKey;
    const subPhase  = Game._2v2SubPhase();
    // LOCKED WHILE THE TABLE IS MID-RESOLUTION. The engine refuses these
    // actions during the before-tricks boundary and while any prompt is still
    // outstanding (Game._2v2ActionsLocked); the controls have to agree, or the
    // player clicks a live-looking card and nothing happens — which reads as
    // the game being broken rather than as "something is still resolving".
    const _locked   = !!(Game._2v2ActionsLocked && Game._2v2ActionsLocked());
    const canCards  = isMyTurn && !_locked && Game._2v2CanPlayCards(subPhase);
    const canTricks = isMyTurn && !_locked && Game._2v2CanPlayTricks(subPhase);

    // Hide the 2v2 full-screen overlay (used by lobby/setup/local phases)
    const twov2El = document.getElementById('twoVTwo-overlay');
    if (twov2El) twov2El.style.display = 'none';

    // Patch s so every existing render sub-function works correctly.
    const save = {
      playerHand: s.player.hand, playerTricks: s.player.trickHand,
      playerCurrency: s.player.currency, playerDeadPile: s.player.deadPile,
      aiHand: s.ai.hand, aiTricks: s.ai.trickHand, aiDeadPile: s.ai.deadPile,
      phase: s.phase, round: s.round,
    };

    // TRY/FINALLY, NOT A BARE RESTORE. Everything below runs with the SIDE
    // PROXY pointing at the LOCAL VIEWER's hand. If anything in the ~240 lines
    // between here and the restore throws, the proxy is left aiming at the
    // viewer's array for the rest of the match — and the very next
    // _2v2ReadBackActivePlayer writes  tt.players[acting].hand = s[side].hand,
    // i.e. copies the VIEWER's hand into whichever seat is acting. That is a
    // second, independent route to two teammates sharing one hand. The restore
    // is now unconditional. (User: "keep each players card contained to thier
    // own hand its very simple.")
    try {
    s.player.hand      = ap.hand;
    s.player.trickHand = ap.trickHand;
    s.player.currency  = ap.energy - ap.usedEnergy;
    s.player.deadPile  = tt.teams[myTeam].deadPile || [];
    s.ai.deadPile      = tt.teams[oppTeam].deadPile || [];
    s.round            = tt.round || 1;

    // Feed opponent's representative hand to the ai-hand mini display
    const oppPlayerKey = Object.keys(tt.players).find(k => tt.players[k].team === oppTeam);
    const oppAp = oppPlayerKey ? tt.players[oppPlayerKey] : null;
    if (oppAp) { s.ai.hand = oppAp.hand; s.ai.trickHand = oppAp.trickHand; }

    // Team B players see their own team at the bottom and Team A at the top —
    // same as Team A players do — so both teammates look "up" at the enemy.
    // Swap the lane slots temporarily so renderBoard puts Team B cards on the
    // player (bottom) row and Team A cards on the ai (top) row for those clients.
    const needsFlip = mySide === 'ai';
    const _flipSeat = (v) => v === 'player' ? 'ai' : v === 'ai' ? 'player' : v;
    if (needsFlip) {
      for (const lane of s.lanes) {
        [lane.player, lane.ai] = [lane.ai, lane.player];
        if (lane._env) [lane._env.player, lane._env.ai] = [lane._env.ai, lane._env.player];
      }
      // Flip pending choice owner/targetSide so renderBoard highlights the
      // correct slot row for Team B. Without this, a Team B summon ability
      // (owner='ai', targetSide='ai') would highlight the opponent's top
      // row instead of Team B's own bottom row after the lane flip.
      if (s.pendingLaneChoice) {
        s.pendingLaneChoice.owner      = _flipSeat(s.pendingLaneChoice.owner);
        s.pendingLaneChoice.targetSide = _flipSeat(s.pendingLaneChoice.targetSide);
      }
      if (s.pendingCardChoice) {
        s.pendingCardChoice.owner      = _flipSeat(s.pendingCardChoice.owner);
        s.pendingCardChoice.targetSide = _flipSeat(s.pendingCardChoice.targetSide);
      }
    }

    // Map 2v2 sub-phase → 1v1 phase so canPlayerPlayCards/Tricks and hand
    // highlights work without modifications to those functions.
    if      (canCards && canTricks) s.phase = 'player-cards-tricks';
    else if (canCards)              s.phase = 'player-cards';
    else if (canTricks)             s.phase = 'player-tricks';
    else                            s.phase = 'ai-cards';

    // --- HUD: Health (my team always on bottom / player bar) ---
    const myTeamData  = tt.teams[myTeam];
    const oppTeamData = tt.teams[oppTeam];
    // Guarded. These four are the first DOM writes in the function and they had
    // no null check, so any layout that does not carry a health bar — or any bug
    // that removes one — did not degrade, it threw, 200 lines before the modals
    // this function is also responsible for drawing.
    const _setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const _setW   = (id, v) => { const el = document.getElementById(id); if (el) el.style.width = v; };
    _setTxt('player-health', Math.max(0, myTeamData.health));
    _setTxt('ai-health',     Math.max(0, oppTeamData.health));
    _setW('player-hp-fill', `${Math.max(0, (myTeamData.health / (myTeamData.maxHealth || 30)) * 100)}%`);
    _setW('ai-hp-fill',     `${Math.max(0, (oppTeamData.health / (oppTeamData.maxHealth || 30)) * 100)}%`);
    // Mr. Freeze frozen health bar — same animation as 1v1. myTeam always maps
    // to the bottom (player) bar, oppTeam to the top (ai) bar, so the flip is
    // already handled by the team mapping above.
    const _pFrz = document.getElementById('player-hp-fill').closest('.health-container');
    const _aFrz = document.getElementById('ai-hp-fill').closest('.health-container');
    if (_pFrz) _pFrz.classList.toggle('hp-frozen', !!myTeamData.healthFrozen);
    if (_aFrz) _aFrz.classList.toggle('hp-frozen', !!oppTeamData.healthFrozen);

    // --- HUD: Block circles ---
    // Read the LIVE combat-proxy meter, not tt.teams[..].blockMeter. The team
    // value is only synced back at end-of-phase / postCombat, so a meter that
    // filled mid-combat (a hit's d3 roll) or mid-turn (Loki, Two-Face Coin,
    // Trigon's steal) sat at its old value on screen until the round ended. The
    // proxies (s.player = Team A, s.ai = Team B) hold the live value the instant
    // it changes — for the host AND, via the state broadcast, for every guest.
    // (User: "the block meter doesn't load instantly... make it change the
    // second you take damage or an ability changes it.")
    const oppSide = Game._2v2TeamSide[oppTeam];
    const myBlockLive  = (s[mySide]  && s[mySide].blockMeter  != null) ? s[mySide].blockMeter  : myTeamData.blockMeter;
    const oppBlockLive = (s[oppSide] && s[oppSide].blockMeter != null) ? s[oppSide].blockMeter : oppTeamData.blockMeter;
    const blockMax = Game.BLOCK_MAX || 8;
    [['player', myBlockLive], ['ai', oppBlockLive]].forEach(([side, meter]) => {
      const textEl = document.getElementById(`${side}-block-text`);
      if (!textEl) return;
      textEl.textContent = `${meter}/${blockMax}`;
      const circle = textEl.closest('.block-circle');
      if (circle) {
        circle.style.setProperty('--fill',
          Math.max(0, Math.min(100, (meter / blockMax) * 100)) + '%');
        circle.classList.toggle('full', meter >= blockMax);
      }
    });

    // --- HUD: Energy orbs ---
    const myEnergy = ap.energy - ap.usedEnergy;
    this.renderEnergyOrbs('player-energy-display', myEnergy, Math.max(s.round, myEnergy));
    const oppEnergy = oppAp ? Math.max(0, oppAp.energy - oppAp.usedEnergy) : 0;
    this.renderEnergyOrbs('ai-energy-display', oppEnergy, Math.max(s.round, oppEnergy));

    // --- HUD: Piles ---
    document.getElementById('player-dead-count').textContent  = myTeamData.deadPile.length;
    document.getElementById('ai-dead-count').textContent      = oppTeamData.deadPile.length;
    document.getElementById('draw-pile-count').textContent    = (tt.drawPile || []).length;
    document.getElementById('trick-pile-count').textContent   = (tt.trickDrawPile || []).length;

    // --- HUD: Round + phase text ---
    document.getElementById('round-num').textContent = s.round;
    const activeAp = activeKey ? tt.players[activeKey] : null;
    // Always show WHO is acting AND WHAT sub-phase they're in — e.g.
    // "Ryan — Cards only" / "Max — Tricks only" — so at a glance everyone
    // knows whose turn it is and whether they're playing cards or tricks.
    // (User: on my card turn make it say something like "Ryan card only".)
    // THE SUB-PHASE IS THE AUTHORITY, not the phase STRING. save.phase is only
    // rewritten by _2v2StartSubPhase, so any render that arrives before it —
    // a post-combat repaint, an incoming broadcast, an undo restoring the
    // PREVIOUS turn's value — showed "Combat" while it was plainly someone's
    // card turn. When combat really is running there is no sub-phase at all,
    // which is a fact about the round rather than a string someone remembered
    // to update. (The old comparisons were dead anyway: subPhase is 'p1-cards',
    // never 'cards', so every turn fell through to "Turn".)
    let phaseLabel;
    if (!subPhase) {
      phaseLabel = 'Combat';
    } else {
      const sub = this._2v2PhaseLabel(subPhase);
      const who = activeAp ? activeAp.name : '';
      phaseLabel = who ? `${who} — ${sub}` : sub;
    }
    const phaseEl = document.getElementById('phase-text');
    if (phaseEl) phaseEl.textContent = phaseLabel;

    const firstEl = document.getElementById('first-player-text');
    if (firstEl) firstEl.textContent =
      (() => {
        // Names from the ROSTER, not from the seats — p1 and p2 are only
        // teammates by default, and this line was the last place still saying
        // otherwise after teams became pickable.
        const r = Game._2v2Roster ? Game._2v2Roster() : { A: ['p1','p2'], B: ['p3','p4'] };
        const nm = (k, f) => (tt.players[k] ? tt.players[k].name : f);
        const side = (arr, f1, f2) => `${nm(arr[0], f1)} & ${nm(arr[1], f2)}`;
        return `${side(r.A.length === 2 ? r.A : ['p1','p2'], 'Team A', 'P2')} vs ${side(r.B.length === 2 ? r.B : ['p3','p4'], 'Team B', 'P4')}`;
      })();

    // --- Board, hand, tricks (standard polished render) ---
    this.renderRoundTrack(s);
    this._updateDominanceVars(s);
    this._capturePositions();
    this.renderBoard(s);

    // Restore flipped lanes and pending-choice seats so game logic isn't affected
    if (needsFlip) {
      for (const lane of s.lanes) {
        [lane.player, lane.ai] = [lane.ai, lane.player];
        if (lane._env) [lane._env.player, lane._env.ai] = [lane._env.ai, lane._env.player];
      }
      if (s.pendingLaneChoice) {
        s.pendingLaneChoice.owner      = _flipSeat(s.pendingLaneChoice.owner);
        s.pendingLaneChoice.targetSide = _flipSeat(s.pendingLaneChoice.targetSide);
      }
      if (s.pendingCardChoice) {
        s.pendingCardChoice.owner      = _flipSeat(s.pendingCardChoice.owner);
        s.pendingCardChoice.targetSide = _flipSeat(s.pendingCardChoice.targetSide);
      }
    }

    this.renderPlayerHand(s);
    this.renderAIHand(s);
    this.renderPlayerTricks(s);

    // Prompt banner ("Place Man-Bat" / "Choose a lane…"). _renderImpl calls
    // this on the 1v1 path only — the 2v2 board returns before reaching it,
    // so every 2v2 seat (online AND local, which wraps this same function)
    // got glowing target lanes with zero instruction text. Worse for the
    // three players who AREN'T picking: without the banner's "Waiting for
    // <name>…" line they stare at a frozen board with no idea whose prompt
    // is blocking the turn. Safe to call here — Game.isMultiplayer() is
    // false in 2v2 (that's the 1v1 Game.mp path; 2v2 rides Multiplayer4),
    // so the banner falls through to the _2v2ActingPlayer annotation, which
    // is exactly who owns the choice.
    this.renderPromptBanner(s);

    // Re-wire hand/trick clicks to 2v2 play path (renderPlayerHand wires
    // them to onCardClick which uses Game.playCard — wrong for 2v2).
    this._apply2v2OnlineHandClicks(ap, canCards);
    this._apply2v2OnlineTrickClicks(ap, canTricks);

    // Turn-order tracker — who's up, who's next, and what each may play.
    this._render2v2TurnTracker(s, tt);
    this._safe('shadowTracker', () => this._renderShadowTracker(s));
    this._safe('cogPanel', () => this._renderCogPanel(s));

    // Lane-select strip shown when a card is selected
    this._render2v2OnlineLaneSelect(s, ap, mySide, canCards);

    // Done button
    const btnA   = document.getElementById('btn-action');
    const btnNew = document.getElementById('btn-new-game');
    const btnU   = document.getElementById('btn-undo');
    if (btnNew) btnNew.style.display = 'none';
    // ONE UNDO PER SEAT, PER MATCH. This used to be hidden outright in 2v2 —
    // there was no take-back at all for any of the four players. Shown whenever
    // it is your turn so the affordance is predictable, and DISABLED (with the
    // reason as its tooltip) rather than vanishing when it cannot be used, so
    // "already used it" and "not your turn" read differently.
    // The engine owns every one of those reasons (undo2v2BlockedReason), so the
    // button cannot promise something the host would refuse.
    if (btnU) {
      // `save` is a handful of stashed side-proxy fields — it has no twoVTwo on
      // it, so this read was undefined every time and the button hid itself on
      // every render. The live wrapper is `tt`, captured at the top of this
      // renderer. (User: "the 1 undo per match isnt in 2v2 yet.")
      const _uSeat = tt && tt.you;
      const _uWhy = (Game.undo2v2BlockedReason && _uSeat) ? Game.undo2v2BlockedReason(_uSeat) : 'Not now';
      const _uMine = !!(Game._2v2ActivePlayer && _uSeat && Game._2v2ActivePlayer() === _uSeat);
      if (_uMine && subPhase) {   // same authority as the End button below
        btnU.textContent   = 'Undo';
        btnU.className     = 'btn btn-secondary';
        btnU.style.display = 'inline-block';
        btnU.disabled      = !!_uWhy;
        btnU.title         = _uWhy || 'Take back everything you did this turn (one undo per match)';
        btnU.onclick       = () => { if (Game._2v2UndoTurn) { Game._2v2UndoTurn(_uSeat); UI.render(); } };
      } else {
        btnU.style.display = 'none';
      }
    }
    if (btnA) {
      // ALWAYS THERE ON YOUR TURN. Passing without playing is a legal move, and
      // this gated on save.phase !== '2v2-combat' — a stale string (see the
      // header above), so the button vanished on exactly the turns where you
      // most wanted it and came back the moment you played a card, because the
      // play refreshed the string. Gated on the sub-phase now: during real
      // combat there is no sub-phase, so _2v2ActivePlayer() is null and
      // isMyTurn is already false — the string was never carrying its weight.
      // (Owner: "i want to pass and not play a card in 2v2 but the button that
      // says end cards doesnt pop up, it does once i play a card.")
      if (isMyTurn && !_locked && subPhase) {
        // NAMED FOR THE TURN, off the same formatter the rail prints, so
        // "Cards + Tricks" on the rail and "End Cards + Tricks" on the button
        // can never disagree.
        // The verb is dropped on a narrow window. "End Cards + Tricks" measures
        // 120px of text plus the shared bar button's side padding, against an
        // actions cell that is 766px at 1400 but 153px at 755 — and the button
        // carries `overflow: hidden`, so what does not fit is silently sliced
        // off rather than wrapping. The phase name is the part that carries the
        // information (it is what was asked for), so the verb is what goes.
        const _wide = !(typeof window !== 'undefined' && window.innerWidth && window.innerWidth <= 900);
        btnA.textContent     = (_wide ? 'End ' : '') + this._2v2PhaseLabel(subPhase);
        btnA.className       = 'btn btn-primary twov2-end-btn';
        btnA.onclick         = () => twov2OnlineDone();
        btnA.style.display   = 'inline-block';
        btnA.disabled        = false;
        btnA.style.opacity   = '';
      } else {
        btnA.style.display = 'none';
      }
    }

    // Waiting banner overlay when it's not the local player's turn
    this._update2v2WaitingBanner(isMyTurn, activeAp && activeAp.name);

    // Per-player card/trick counts: the two enemies on the top bar, your ally
    // on the bottom bar, each with their name — so you can track hand sizes.
    this._render2v2RosterCounts(s, tt);

    // Gorr's "what everyone lost" banner (the 1v1 render shows it on its own
    // path; the 2v2 board returns before reaching that, so surface it here too).
    if (s._gorrBanner && s._gorrBanner.at !== this._gorrBannerShown) {
      this._gorrBannerShown = s._gorrBanner.at;
      this.showPhaseBanner(this._gorrBannerText(s._gorrBanner), { duration: 7500 });
    }

    // Block-meter free-trick offer (same — the 1v1 render owns it elsewhere).
    if (s.pendingBlockTrick) { this.renderBlockTrickChoice(s); }
    else { const bt = document.getElementById('block-trick-modal'); if (bt) bt.remove(); }

    // Jump offer (Ghostface / Jason / Michael Myers / Art / Stripe) — the 1v1
    // render owns it elsewhere; the 2v2 board returned first, so a Jason that
    // armed mid-combat never showed its Play/Skip modal. Surface it here.
    if (s.pendingJumpOffer) { this.renderJumpOfferChoice(s); }
    else { const jm = document.getElementById('jump-offer-modal'); if (jm) jm.remove(); }

    // Time Stone intercept — the third floating prompt, and the one that was
    // still missing. hasPendingPrompt() counts pendingTimeStoneIntercept, so in
    // 2v2 it parked combat behind a modal that NO 2v2 render path ever drew:
    // an unanswerable prompt, frozen until a watchdog. The block-trick and jump
    // offers above were each surfaced here for exactly this reason; this is the
    // last one of the set.
    if (s.pendingTimeStoneIntercept) { this.renderTimeStoneIntercept(s); }
    else { const ts = document.getElementById('time-stone-modal'); if (ts) ts.remove(); }

    this.applyTronFx();
    this._applyMotionEffects();

    // Combat FX — the 2v2 board returns before the 1v1 render reaches
    // showDamageFloats(), so the engine-emitted FX stream (hp-bar hit flash +
    // shake + shards + floating damage, card hits, screen shake) never drained
    // and 2v2 combat played silently. Drain it here. _fx2v2MySide tells the
    // hp-bar branch which absolute side is "my team" so the flash lands on the
    // right bar for both teams (Team B's board is flipped).
    this._fx2v2MySide = mySide;
    this.showDamageFloats();

    } finally {
    // Restore patched state — unconditional, see the try above.
    s.player.hand      = save.playerHand;
    s.player.trickHand = save.playerTricks;
    s.player.currency  = save.playerCurrency;
    s.player.deadPile  = save.playerDeadPile;
    s.ai.hand          = save.aiHand;
    s.ai.trickHand     = save.aiTricks;
    s.ai.deadPile      = save.aiDeadPile;
    s.phase            = save.phase;
    s.round            = save.round;
    }

    // MATCH END. The 2v2 board returns long before the 1v1 render tail reaches
    // renderButtons(), and renderButtons is the only place a render opens the
    // game-over overlay — so this path never showed a summary at all. The host
    // still got one because damagePlayer called showGameOverScreen directly
    // inside its own engine; a guest runs no engine, so it got nothing and sat
    // on a live-looking board. (User, as the guest: "i never got the summary
    // screen once the game ended.")
    // The winner is translated to the VIEWER's team: the engine records a SIDE
    // ('player'/'ai'), and both teams see their own side rendered at the
    // bottom, so an untranslated winner shows one of the two teams the wrong
    // screen. showGameOverScreen's own re-entry guard keeps repeated renders
    // from re-opening it.
    if (s.gameOver && this.showGameOverScreen) {
      this.showGameOverScreen(s.winner === mySide ? 'player' : 'ai');
    }
  },

  // Re-wire hand card onclick handlers to 2v2 card-index selection.
  // renderPlayerHand wires onclick → onCardClick → Game.playCard (1v1 path).
  // We replace them here with the 2v2 index-based selection so that clicking
  // a card sets UI._2v2SelectedCardIdx and shows the lane-select strip.
  _apply2v2OnlineHandClicks(ap, canPlay) {
    const handEl = document.getElementById('player-hand');
    if (!handEl) return;
    const energy = ap.energy - ap.usedEnergy;
    const tt = Game.state.twoVTwo;
    const you = tt ? tt.you : null;
    // LOCAL pass-and-play: every seat acts on this device, so everyone
    // uses the select-then-lane-strip flow. The p1-only check routed
    // players 2-4 into the ONLINE guest branch, whose Multiplayer4.send
    // no-ops without a connection — their hand clicks silently did
    // nothing. User report: "tried the 2v2 local and couldn't seem to
    // play any cards when clicking on them."
    // ONLINE (host included) uses the lane-prompt flow: click a card, the open
    // lanes light up on the board, click one. That's exactly how 1v1 online
    // plays, and it's the path the guests were already using successfully.
    // The host used to be lumped in with local via `|| you === 'p1'` and got
    // the numbered lane-strip instead — and that strip is what broke, leaving
    // the host able to select a card but with no way to pick a lane. User
    // report: "in 2v2 online again and i am the host and cant play cards."
    // Host and guest now share one implementation (Game._2v2RequestLaneChoice);
    // the strip survives only for LOCAL pass-and-play, where it belongs.
    const isLocalSelect = (tt && !tt.online);
    const selectedId = (isLocalSelect && UI._2v2SelectedCardIdx != null && ap.hand[UI._2v2SelectedCardIdx])
      ? ap.hand[UI._2v2SelectedCardIdx].id : null;
    // A PENDING PROMPT OWNS THE HAND, AND THIS PASS MUST NOT TAKE IT BACK.
    // renderPlayerHand wires cardChoicePick onto exactly the hand cards a
    // prompt is asking about; this rewire runs immediately after it and used to
    // overwrite that handler unconditionally — nulled whenever it wasn't your
    // sub-phase (or the card cost more than your energy), replaced with the
    // inspect view when it was. So every "choose a card from your hand" prompt
    // in 2v2 (Symbiote Spider-Man's shuffle) lit the cards gold and then did
    // nothing when they were clicked, and because the chain runs one seat at a
    // time, the whole table sat waiting on an answer that could not physically
    // be given. It bit hardest on a seat prompted OUTSIDE its own turn, which
    // is the normal case here: Symbiote cycles all four hands the moment it
    // lands. (User, playing as the guest: "the game cant continue since i never
    // got the prompt to reshuffle, also every player must do this.")
    // Cards the prompt is NOT asking about stay inert while it is open — same
    // rule renderPlayerHand applies in 1v1.
    const _cc = Game.state.pendingCardChoice;
    const _promptOpen = !!(_cc || Game.state.pendingLaneChoice);
    const _promptCardIds = new Set();
    if (_cc && Game.promptIsMine(_cc, 'card')) {
      (_cc.cards || []).forEach(c => { if (c && c.id != null) _promptCardIds.add(String(c.id)); });
    }
    handEl.querySelectorAll('.hand-card-wrapper .card[data-card-id]').forEach(cardEl => {
      const rawId  = cardEl.getAttribute('data-card-id');
      const cardId = parseInt(rawId, 10);
      const apIdx  = ap.hand.findIndex(c => c.id === cardId);
      cardEl.classList.toggle('selected', cardId === selectedId);
      if (_promptCardIds.has(rawId)) return;              // the prompt's own handler stands
      if (_promptOpen) { cardEl.onclick = null; return; } // hand is inert while a prompt is open
      if (apIdx < 0) { cardEl.onclick = null; return; }
      // PER CARD, NOT PER SUB-PHASE. `canPlay` is "can I play cards at all this
      // sub-phase", which is FALSE on a tricks-only turn — so this stripped the
      // click off every hand card during the trick phase, including the two
      // whose entire ability is being playable in it. Iron Man and Thanos were
      // rendered as playable by the hand renderer (which asks per card) and
      // then had their handler removed one pass later, so they read as dead.
      // (User: "my buddy was trying to play iron man and thanos during the
      // trick phase in 2v2 and it wont let him drag and play.")
      // canPlayThisCardNow is the same authority the renderer uses — it allows
      // a trickPhasePlayable card, and Red Skull's aura, during a tricks turn.
      const _liveCard = ap.hand[apIdx];
      const _allowed = this.canPlayThisCardNow
        ? this.canPlayThisCardNow(Game.state, _liveCard)
        : canPlay;
      if (!_allowed) { cardEl.onclick = null; return; }
      const cost = (Game.getCardCost && this._2v2LocalSide)
        ? Game.getCardCost(this._2v2LocalSide() || 'player', _liveCard)
        : (_liveCard.cost || 0);
      if (energy < cost) { cardEl.onclick = null; return; }
      cardEl.onclick = (e) => {
        e.stopPropagation();
        if (isLocalSelect) {
          UI._2v2SelectedCardIdx = UI._2v2SelectedCardIdx === apIdx ? null : apIdx;
          UI.render();
        } else {
          // TAP READS, IT DOES NOT PLAY. This submitted the play on the very
          // first tap, so a 2v2 card could never be picked up and read — the
          // one thing a click does everywhere else in the game. Owner, twice:
          // "when i tap on a card it automatically plays it in 2v2, that
          // shouldn't happen" and "i want it how it works in 1v1 where if i tap
          // it i can read the card and then i have the prompt at the bottom to
          // play it if i choose."
          // The inspect view IS that prompt — it carries a Play button gated by
          // _inspectCardPlayable — so the play still goes through the same door
          // (submitCommand), just one deliberate step later. Drag still plays
          // directly, untouched.
          UI.openCardInspect(ap.hand[apIdx]);
        }
      };
    });
  },

  // Re-wire trick onclick handlers to twov2OnlineTrick(idx).
  _apply2v2OnlineTrickClicks(ap, canPlay) {
    const tricksEl = document.getElementById('player-tricks');
    if (!tricksEl) return;
    tricksEl.querySelectorAll('.trick-card').forEach((el) => {
      if (!canPlay) { el.onclick = null; return; }
      const idx = this._trickIndexFromEl(el, ap && ap.trickHand);
      if (idx < 0) { el.onclick = null; return; }
      // TAP READS, IT DOES NOT PLAY — the same contract hand cards were given
      // one function above, and the same one 1v1 tricks already have. This
      // fired the trick on the very first tap, so a 2v2 trick could never be
      // turned over and read; stopPropagation then swallowed the click before
      // the document-level read handler could see it either. (User: "in the
      // trick if you tap to see the description it will automatically fire,
      // that shouldnt happen. it will work the same as the cards: either drag
      // or tap the button below the description to play.")
      // The inspect view IS that button — _inspectTrickPlayable gates it and it
      // commits through twov2OnlineTrick, the same door this used to call.
      el.onclick = (e) => {
        e.stopPropagation();
        if (UI.showCardInspect) UI.showCardInspect(el);
      };
    });
  },

  // Lane-select strip that appears when a 2v2 card is selected in board mode.
  // Floats below the tricks area; each button places the selected card into
  // the corresponding lane (if the local player's slot is empty).
  _render2v2OnlineLaneSelect(s, ap, mySide, canPlay) {
    let strip = document.getElementById('twov2-board-lane-select');
    if (!strip) {
      strip = document.createElement('div');
      strip.id = 'twov2-board-lane-select';
      strip.className = 'twov2-board-lane-select';
      const ga = document.getElementById('game-area');
      if (ga) ga.appendChild(strip);
    }
    // LOCAL pass-and-play only. Online (host and guests alike) now places via
    // the highlighted-board-lane prompt, so the strip must never appear there
    // — leaving it live would give the host two competing placement UIs.
    const _ttStrip = Game.state.twoVTwo;
    if ((_ttStrip && _ttStrip.online) || UI._2v2SelectedCardIdx == null || !canPlay) {
      strip.style.display = 'none';
      return;
    }
    strip.style.display = 'flex';
    // MODER LOCKS THE STRIP TOO. This asked only "is my slot free", so a
    // compelled player got all eight buttons and could aim anywhere while the
    // engine pulled the card into Moder's lane anyway.
    const _selCard = (ap && ap.hand && UI._2v2SelectedCardIdx != null)
      ? ap.hand[UI._2v2SelectedCardIdx] : null;
    const _ok = new Set(Game.placeableLanesFor
      ? Game.placeableLanesFor(mySide, _selCard) : s.lanes.map((_, i) => i));
    const _compelled = Game.moderCompulsionLane ? Game.moderCompulsionLane(mySide) : -1;
    // The Rift compels the same way Moder does, so it has to be able to SAY so
    // — a board silently narrowed to one lane with no reason given reads as a
    // bug, which is the whole lesson of the Ballyhoo lock.
    const _rift = Game.riftCompulsionLane ? Game.riftCompulsionLane(mySide) : -1;
    const _forcedLane = _compelled >= 0 ? _compelled : _rift;
    const _forcedWhy = _compelled >= 0 ? 'Forced into lane ' : 'Pulled into the Rift — lane ';
    strip.innerHTML = `
      <span class="twov2-bls-label">${_ok.size === 1 && _forcedLane >= 0
        ? _forcedWhy + (_forcedLane + 1) + ':' : 'Place card in lane:'}</span>
      ${s.lanes.map((ln, i) => {
        const blocked = !_ok.has(i);
        const forced = (_compelled === i && _ok.has(i));
        return `<button class="twov2-bls-btn${blocked ? ' twov2-bls-blocked' : ''}${forced ? ' twov2-bls-forced' : ''}"
                  onclick="twov2OnlinePlaceCard(${i})" ${blocked ? 'disabled' : ''}
                  ${blocked && _compelled >= 0 ? `title="Moder forces your next card into lane ${_compelled + 1}"` : ''}>
                  ${i + 1}
                </button>`;
      }).join('')}
      <button class="twov2-bls-cancel"
              onclick="UI._2v2SelectedCardIdx=null;UI.render()">✕</button>
    `;
  },

  // Show a "Waiting for [name]…" banner overlaid at the bottom of game-area
  // when it is not the local player's turn in 2v2 online.
  // REMOVED. This pinned a full-width gold bar to the bottom of the viewport,
  // and on a tall board it sat below the fold — so all the player ever saw was
  // a stray yellow line across the bottom of the screen. Whose turn it is was
  // already being said twice, better, and in view: the header reads
  // "<NAME> — TURN" and the turn-order rail marks that seat NOW. A third
  // notice that cannot be read is not an indicator, it is a rule.
  // (User: "there is this yellow line indicator on the bottom, get rid of that
  // — i think its saying whose turn it is but i cant see it so just remove it.")
  // Still removes any node left over from a previous build.
  _update2v2WaitingBanner() {
    const banner = document.getElementById('twov2-waiting-banner');
    if (banner) banner.remove();
  },

  // Per-player card + trick counts for 2v2 online. The two ENEMY players sit on
  // the top (ai) bar with their names; your ALLY sits on the bottom (player) bar
  // near your hand. Live hand sizes so you can track what each player is holding.
  _render2v2RosterCounts(s, tt) {
    if (!tt || !tt.you || !tt.players) { this._clear2v2RosterStrip('twov2-roster-top'); this._clear2v2RosterStrip('twov2-roster-bottom'); return; }
    const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const me = tt.you;
    const myTeam = tt.players[me] && tt.players[me].team;
    if (!myTeam) return;
    // Mini face-down card-back — the SAME diamond-pattern look as the 1v1
    // opponent mini-hand (renderAIHand). Owner wants each other player's hand
    // shown as real card/trick backs (not a bare count), with their name beside
    // it and their leftover Energy on the same diamond glyph as the main HUD.
    // THE LATTICE IS CSS NOW, NOT AN SVG PATTERN — see .rc-back in style.css.
    // It was `<pattern id="rc-cb">` repeated inside every single back, and
    // `fill="url(#rc-cb)"` resolves against the DOCUMENT, not the local <svg>:
    // every back in the row painted the FIRST pattern in the DOM, and that
    // pattern's `currentColor` is the first back's colour. So the whole roster
    // — your blue seat, the purple trick backs — drew the enemy's red lattice
    // inside its own correctly-coloured border. The border and the glow used
    // plain CSS currentColor and were right all along, which is exactly why it
    // read as "the lines don't match the border".
    const cardBackSVG = '';
    const chip = (pk, isMe) => {
      const p = tt.players[pk]; if (!p) return '';
      const cards = (p.hand || []).length;
      const tricks = (p.trickHand || []).length;
      // PER-SEAT energy stays on each chip — this is the ONLY per-player energy
      // readout (the redundant main enemy diamond is hidden in 2v2, see CSS).
      // Show the LEFTOVER on the diamond glyph (spent/total in the tooltip).
      const eTotal = p.energy || 0;
      const eSpent = p.usedEnergy || 0;
      const eLeft = Math.max(0, eTotal - eSpent);
      const active = (Game._2v2ActivePlayer && Game._2v2ActivePlayer() === pk);
      let backs = '';
      for (let i = 0; i < cards; i++)  backs += `<span class="rc-back rc-back-card">${cardBackSVG}</span>`;
      for (let i = 0; i < tricks; i++) backs += `<span class="rc-back rc-back-trick">${cardBackSVG}</span>`;
      if (!backs) backs = `<span class="rc-empty">—</span>`;
      return `<div class="rc-chip rc-chip-hand${active ? ' rc-active' : ''}${isMe ? ' rc-me' : ''}">`
        + `<span class="rc-name">${UI.seatNameHTML(p.name || pk, p.isAI)}${isMe ? ' <em>(you)</em>' : ''}</span>`
        + `<span class="rc-hand" title="${cards} card${cards === 1 ? '' : 's'}, ${tricks} trick${tricks === 1 ? '' : 's'} in hand">${backs}</span>`
        + `<span class="rc-stat rc-energy" title="${eLeft} Energy left of ${eTotal} (${eSpent} spent)"><i class="rc-ic">&#9670;</i>${eLeft}</span>`
        + `</div>`;
    };
    const order = ['p1', 'p2', 'p3', 'p4'];
    const enemies = order.filter(pk => tt.players[pk] && tt.players[pk].team !== myTeam);
    const ally = order.find(pk => pk !== me && tt.players[pk] && tt.players[pk].team === myTeam);
    // The enemies go in the TOP bar's centre cell (the space that shows the
    // mini-hand in 1v1); the ally goes on the PLAYER bar. Hide the 1v1 mini-hand
    // in 2v2 so the chips own that space.
    const aiMini = document.querySelector('.info-bar.ai-bar #ai-hand');
    if (aiMini) aiMini.style.display = 'none';
    // The standalone voice panel is redundant in 2v2 — the turn rail carries the
    // same roster with a mic per seat, and two lists of the same four names in
    // opposite corners is one list too many. Hidden the same way the 1v1 mini-
    // hand is, rather than by a body class that does not exist. 1v1 online keeps
    // its panel: there is no seat rail there to fold into.
    const vPanel = document.getElementById('voice-panel');
    if (vPanel) vPanel.style.display = 'none';
    this._paint2v2RosterStrip('twov2-roster-top', '.info-bar.ai-bar .bar-center', enemies.map(pk => chip(pk, false)).join(''), 'rc-enemy');
    this._paint2v2RosterStrip('twov2-roster-bottom', '.info-bar.player-bar .bar-center', ally ? chip(ally, false) : '', 'rc-ally');
  },
  _paint2v2RosterStrip(id, anchorSel, innerHTML, extraCls) {
    if (!innerHTML) { this._clear2v2RosterStrip(id); return; }
    let strip = document.getElementById(id);
    if (!strip) {
      strip = document.createElement('div');
      strip.id = id;
      strip.className = 'twov2-roster-strip ' + extraCls;
      const anchor = document.querySelector(anchorSel);
      if (anchor) anchor.appendChild(strip); else document.body.appendChild(strip);
    }
    strip.innerHTML = innerHTML;
    strip.style.display = 'flex';
  },
  _clear2v2RosterStrip(id) {
    const strip = document.getElementById(id);
    if (strip) { strip.innerHTML = ''; strip.style.display = 'none'; }
  },

  // ===================== 2v2 MODE RENDERING =====================
  render2v2(s) {
    const phase = s.phase;
    const tt = s.twoVTwo;
    let el = document.getElementById('twoVTwo-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'twoVTwo-overlay';
      el.className = 'twoVTwo-overlay';
      document.body.appendChild(el);
    }
    el.style.display = 'flex';

    if (phase === '2v2-team-setup')   { this._render2v2TeamSetup(el, s, tt); return; }
    if (phase === '2v2-pass')         { this._render2v2Pass(el, s, tt); return; }
    if (phase === '2v2-draft')        { this._render2v2Draft(el, s, tt); return; }
    if (phase === '2v2-draft-pass')   { this._render2v2DraftPass(el, s, tt); return; }
    if (phase === '2v2-online-lobby') { this._render2v2OnlineLobby(el, s, tt); return; }
    this._render2v2Game(el, s, tt, phase);
  },

  _render2v2TeamSetup(el, s, tt) {
    el.innerHTML = `
      <div class="mode-panel setup2v2-panel">
        <button type="button" class="mode-back" onclick="Game.goToModeSelect()">← Back</button>

        <div class="setup2v2-title">2V2 Setup</div>
        <div class="setup2v2-subtitle">4 players · 2 teams · 8 lanes</div>

        <div class="setup2v2-inputs">
          ${['p1','p2','p3','p4'].map(pk => `
            <div class="setup2v2-name-group">
              <label class="setup2v2-label">Player ${pk[1]}</label>
              <input class="setup2v2-input" id="2v2-name-${pk}" type="text"
                     maxlength="18" placeholder="${tt.players[pk].name}"
                     value="${tt.players[pk].name}" autocomplete="off" />
            </div>
          `).join('')}
        </div>

        <div class="setup2v2-teams">
          ${['A','B'].map((tm, ti) => `
            ${ti ? '<div class="setup2v2-vs">VS</div>' : ''}
            <div class="setup2v2-team setup2v2-team-${tm.toLowerCase()}">
              <div class="setup2v2-team-label">Team ${tm}</div>
              ${(Game._2v2Roster ? Game._2v2Roster()[tm] : (tm === 'A' ? ['p1','p2'] : ['p3','p4']))
                .map(pk => `<div class="setup2v2-member ${UI._2v2TeamSel === pk ? 'is-teamsel' : ''}"
                       onclick="twov2TeamTap('${pk}')" role="button" tabindex="0">${tt.players[pk].name}</div>`).join('')}
            </div>`).join('')}
        </div>
        <div class="setup2v2-hint">${UI._2v2TeamSel
          ? 'Now tap a player on the other team to trade places'
          : 'Tap two players to trade places'}</div>

        <div class="setup2v2-actions">
          <button type="button" class="setup2v2-btn" onclick="start2v2RandomTeams()">🎲 Random Teams</button>
          <button type="button" class="setup2v2-btn setup2v2-btn-pri" onclick="start2v2Confirm()">Start Game →</button>
        </div>
      </div>`;
  },

  _render2v2Pass(el, s, tt) {
    const nextPhase = s._2v2NextPhase || '';
    const nextPlayerKey = Game._2v2ActivePlayer();
    const nextName = nextPlayerKey ? tt.players[nextPlayerKey].name : 'Next Player';
    const team = nextPlayerKey ? tt.players[nextPlayerKey].team : 'A';
    const teamColor = team === 'A' ? '#4fc3f7' : '#f44336';

    el.innerHTML = `
      <div class="twov2-pass-panel">
        <div class="twov2-pass-icon">🔒</div>
        <div class="twov2-pass-heading">Hand off the device</div>
        <div class="twov2-pass-name" style="color:${teamColor}">
          ${nextName}'s Turn
        </div>
        <div class="twov2-pass-sub">
          Don't show the screen until ${nextName} is holding it.
        </div>
        <button class="twov2-btn twov2-btn-pri twov2-ready-btn"
                onclick="Game.confirm2v2Pass()">
          I'm Ready — Show My Cards
        </button>
      </div>`;
  },

  _render2v2Draft(el, s, tt) {
    const d = tt && tt.draft;
    if (!d) return;
    const pickerKey = d.pickerOrder[d.pickerIdx];
    const picker = tt.players[pickerKey];
    const team = picker.team;
    const teamColor = team === 'A' ? '#4fc3f7' : '#f44336';
    const isCards = d.phase === 'cards';
    const roundLabel = isCards
      ? `Card Pick ${d.round} of 4 — ${picker.name}`
      : `Trick Pick ${d.round} of 2 — ${picker.name}`;

    const isOnline = !!tt.online;
    const isMyPick = !isOnline || (tt.you === pickerKey);
    const pickFn = isOnline ? 'twov2OnlineDraftPick' : 'twov2DraftPick';

    const choiceHtml = isMyPick ? d.choices.map((item, idx) => {
      if (!item) return '';
      if (isCards) {
        return `<button class="twov2-draft-choice" onclick="${pickFn}(${idx})">
          <div class="twov2-dc-name">${item.name}</div>
          <div class="twov2-dc-stats">${item.attack} ATK · ${item.health} HP</div>
          <div class="twov2-dc-cost">Cost ${item.cost}</div>
          <div class="twov2-dc-desc">${item.desc || ''}</div>
        </button>`;
      } else {
        return `<button class="twov2-draft-choice" onclick="${pickFn}(${idx})">
          <div class="twov2-dc-name">${item.name}</div>
          <div class="twov2-dc-cost">Cost ${item.cost}</div>
          <div class="twov2-dc-desc">${item.desc || ''}</div>
        </button>`;
      }
    }).join('') : `<div class="twov2-waiting-banner">⏳ Waiting for ${picker.name} to pick…</div>`;

    el.innerHTML = `
      <div class="twov2-pass-panel">
        <div class="twov2-draft-heading" style="color:${teamColor}">${roundLabel}</div>
        ${isMyPick ? `<div class="twov2-draft-sub">Pick one ${isCards ? 'card' : 'trick'} for your hand:</div>` : ''}
        <div class="twov2-draft-choices">${choiceHtml}</div>
        <div class="twov2-draft-progress">
          ${picker.name} has ${isCards ? picker.hand.length : picker.trickHand.length}
          ${isCards ? 'card' : 'trick'}${(isCards ? picker.hand.length : picker.trickHand.length) !== 1 ? 's' : ''} drafted
        </div>
      </div>`;
  },

  _render2v2DraftPass(el, s, tt) {
    const d = tt && tt.draft;
    if (!d) return;
    const pickerKey = d.pickerOrder[d.pickerIdx];
    const picker = tt.players[pickerKey];
    const team = picker.team;
    const teamColor = team === 'A' ? '#4fc3f7' : '#f44336';
    const isCards = d.phase === 'cards';

    el.innerHTML = `
      <div class="twov2-pass-panel">
        <div class="twov2-pass-icon">🔒</div>
        <div class="twov2-pass-heading">Hand off the device</div>
        <div class="twov2-pass-name" style="color:${teamColor}">
          ${picker.name}'s Draft Turn
        </div>
        <div class="twov2-pass-sub">
          ${picker.name} is picking ${isCards ? 'card ' + d.round + ' of 4' : 'trick ' + d.round + ' of 2'}.
          Don't show the screen until they're holding it.
        </div>
        <button class="twov2-btn twov2-btn-pri twov2-ready-btn"
                onclick="Game.confirm2v2DraftPass()">
          I'm Ready — Show My Choices
        </button>
      </div>`;
  },

  _render2v2OnlineLobby(el, s, tt) {
    const isHost = tt && tt.you === 'p1';
    const code = this._2v2OnlineRoomCode || '';
    const players = tt ? tt.players : {};
    const joined = tt ? (tt.joinedPlayers || {}) : {};
    const players0 = tt ? tt.players : {};
    const isAISeat = (pk) => !!(players0[pk] && players0[pk].isAI);
    const isOccupied = (pk) => !!(joined[pk] || isAISeat(pk));
    const joinedCount = Object.values(joined).filter(Boolean).length;
    const occupiedCount = ['p1','p2','p3','p4'].filter(isOccupied).length;

    const errorHtml = this._2v2OnlineError
      ? `<div class="setup2v2-error">${this._2v2OnlineError}</div>` : '';

    // The menu's backdrop, as a still: this lobby re-renders on every state
    // tick, and moving the one menu <video> in and out would stutter it.
    const heroHtml = `<div class="twov2-mm-hero" style="background-image:url('${this.MENU_VIDEO_POSTER}');background-position:30% 50%;background-size:cover;"></div>`;

    if (!tt || !tt.you) {
      // Pre-join — enter name + create/join, in the main-menu style
      // (boxless glow-text, left-aligned, pure black). Same input IDs +
      // handlers as before so twov2OnlineCreate/Join keep working.
      // Pre-fill the name with the last one typed (persisted on create/join) so
      // it doesn't have to be re-entered every visit.
      let savedName = '';
      try { savedName = localStorage.getItem('2v2PlayerName') || ''; } catch (e) {}
      // …or the name already typed on the multiplayer screen, so it is never asked twice.
      if (!savedName && this._mpName) { try { savedName = this._mpName() || ''; } catch (e) {} }
      savedName = savedName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').slice(0, 18);
      const _tq2 = (typeof Tournament !== 'undefined' && Tournament._online && Tournament._online.mode === '2v2') ? Tournament._online : null;
      // SAME LOOK AS THE MENU (owner: "simple sleek like tron"): the full-size
      // wordmark, one line of context, an underline name, and the two actions
      // as rail rows. No icons, no "host" tag, no second smaller title.
      el.innerHTML = `
        <div class="twov2-mm twov2-tron">
          ${heroHtml}
          <div class="twov2-mm-content">
            <button type="button" class="twov2-mm-back" onclick="Game.goToMainMenu(); if (UI.openMultiplayer) UI.openMultiplayer();">&larr; Menu</button>
            <h1 class="twov2-mm-title">the game</h1>
            <div class="twov2-mm-kicker">${_tq2 ? `Tournament · 2v2 · best of ${_tq2.length}` : '2v2 online · 4 players · 2 teams'}</div>
            ${errorHtml}
            <input class="twov2-mm-nameinput" id="2v2-online-name" type="text" maxlength="18" placeholder="Your name" aria-label="Your name" autocomplete="off" value="${savedName}" />
            <div class="twov2-rows">
              <button type="button" class="twov2-row" onclick="twov2OnlineCreate()">
                <span class="twov2-seg" aria-hidden="true"></span><span class="twov2-row-label">Create Room</span>
              </button>
              <div class="twov2-row twov2-row-join">
                <span class="twov2-seg" aria-hidden="true"></span><span class="twov2-row-label">Join</span>
                <input class="twov2-mm-code" id="2v2-online-code" type="text" maxlength="4" placeholder="CODE" aria-label="Room code" autocomplete="off" oninput="this.value=this.value.toUpperCase()" onkeydown="if(event.key==='Enter')twov2OnlineJoin()" />
                <button type="button" class="twov2-mm-go" onclick="twov2OnlineJoin()" aria-label="Join with this code">&rarr;</button>
              </div>
            </div>
          </div>
        </div>`;
      return;
    }

    // Waiting room — room code + player list, in the main-menu style.
    //
    // TEAM PICKING. Tap a player, tap someone on the other team, they trade
    // places. A swap rather than a "join team A" button because there are
    // exactly two seats a side: a swap can never leave the lobby 3-1, so there
    // is no full-team refusal to explain and no unstartable shape to escape.
    // The host may rearrange anyone; everyone else may trade themselves with
    // anyone. The host is authoritative either way — a guest's tap is a
    // request, and the lobby it gets back is the host's.
    const sel = this._2v2TeamSel;
    const canMove = (pk) => isHost || pk === tt.you;
    // WHICH TEAM IS MINE. The team label was one flat pale-blue for everybody,
    // which told you nothing and read as grey — the lobby is the one screen
    // where "who am I fighting" should be obvious before a card is dealt. Your
    // side takes the theme neon, theirs takes enemy red, same as the board.
    const myTeamLobby = (players[tt.you] && players[tt.you].team) || null;
    const playerRows = ['p1','p2','p3','p4'].map(pk => {
      const hasJoined = joined[pk];
      const isAI = isAISeat(pk);
      const occupied = hasJoined || isAI;
      const name = hasJoined ? players[pk].name
        : (isAI ? players[pk].name : (pk === 'p1' ? '(Host)' : 'Empty'));
      const teamLabel = (players[pk] && players[pk].team) || '?';
      // Occupied seats (real OR AI) can be moved between teams so the host can
      // balance a mixed lobby; an empty seat still can't join a team.
      const pickable = occupied && (canMove(pk) || (sel && canMove(sel)));
      const isSel = sel === pk;
      const isPartner = !!sel && !isSel && occupied && teamLabel !== ((players[sel] || {}).team);
      // Host-only per-seat AI control: fill an empty seat, or free an AI one.
      const aiCtrl = isHost && !hasJoined
        ? (isAI
            ? `<button type="button" class="twov2-mm-aibtn is-remove" onclick="event.stopPropagation();Game.remove2v2AI('${pk}')">Remove</button>`
            : `<button type="button" class="twov2-mm-aibtn" onclick="event.stopPropagation();Game.add2v2AI('${pk}')">+ Add AI</button>`)
        : '';
      const sideCls = myTeamLobby ? (teamLabel === myTeamLobby ? 'is-myteam' : 'is-foeteam') : '';
      return `<div class="twov2-mm-prow ${occupied ? 'is-joined' : ''} ${isAI ? 'is-ai' : ''} ${isSel ? 'is-teamsel' : ''} ${sel && isPartner && pickable ? 'is-swappable' : ''} ${pickable ? 'is-pickable' : ''} team-${teamLabel} ${sideCls}"
        ${pickable ? `onclick="twov2TeamTap('${pk}')" role="button" tabindex="0"` : ''}>
        <span class="twov2-mm-pslot">P${pk[1]}</span>
        <span class="twov2-mm-pname">${String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
        <span class="twov2-mm-pteam">Team ${teamLabel}</span>
        ${aiCtrl}
        <span class="twov2-mm-pcheck">${hasJoined ? '✓' : (isAI ? UI.BOT_ICON_SVG : '')}</span>
      </div>`;
    }).join('');
    const balanced = Game._2v2TeamsBalanced ? Game._2v2TeamsBalanced() : true;
    const teamHint = sel
      ? `<div class="twov2-mm-sub">Now tap someone on the other team to trade places</div>`
      : (occupiedCount === 4
          ? `<div class="twov2-mm-sub">Tap ${isHost ? 'any two seats' : 'yourself, then an opponent,'} to trade places</div>`
          : (isHost
              ? `<div class="twov2-mm-sub">Waiting for players…</div>`
              : ''));

    // SIMPLE AND SLEEK, like the pre-join screen and the 1v1 lobby: the code
    // is the one big thing, each seat is one line in its team's colour, and
    // the two host actions are rail rows. One status line at most — the seat
    // list already says how many have joined.
    const _railRow = (label, onClick) => `
      <button type="button" class="twov2-row" onclick="${onClick}">
        <span class="twov2-seg" aria-hidden="true"></span><span class="twov2-row-label">${label}</span>
      </button>`;
    const _hostRows = (isHost && occupiedCount === 4)
      ? `<div class="twov2-rows">
           ${balanced ? _railRow('Start Match', 'twov2OnlineStart()') : ''}
           ${_railRow('Shuffle Teams', 'twov2TeamRandom()')}
         </div>
         ${balanced ? '' : `<div class="twov2-mm-sub">Teams must be two a side to start</div>`}`
      : '';
    el.innerHTML = `
      <div class="twov2-mm twov2-tron twov2-lobby">
        ${heroHtml}
        <div class="twov2-mm-content">
          <button type="button" class="twov2-mm-back" onclick="twov2OnlineLeave()">&larr; Leave</button>
          <h1 class="twov2-mm-title">the game</h1>
          ${isHost
            ? `<div class="twov2-mm-codebig" onclick="UI._2v2CopyCode && UI._2v2CopyCode()" title="Tap to copy">${code}</div>
               <div class="twov2-mm-kicker">${occupiedCount < 4
                  ? `Share this code · ${4 - occupiedCount} seat${4 - occupiedCount === 1 ? '' : 's'} open`
                  : '2v2 lobby · room full'}</div>`
            : `<div class="twov2-mm-kicker">2v2 lobby · waiting for the host to start</div>`}
          ${errorHtml}
          <div class="twov2-mm-players">${playerRows}</div>
          ${teamHint}
          ${_hostRows}
        </div>
      </div>`;
  },

  _render2v2Game(el, s, tt, phase) {
    if (!tt) return;
    const activeKey = Game._2v2ActivePlayer();
    const activeTeam = Game._2v2ActiveTeam();
    const subPhase = Game._2v2SubPhase();
    if (!activeKey || !subPhase) return;

    // Online: show MY player's hand, but only allow actions when it's my turn
    const isOnline = !!tt.online;
    const myKey = isOnline ? (tt.you || activeKey) : activeKey;
    const isMyTurn = !isOnline || (activeKey === myKey);
    const ap = tt.players[myKey] || tt.players[activeKey];

    const teamA = tt.teams.A;
    const teamB = tt.teams.B;
    const round = tt.round || 1;
    const canCards  = isMyTurn && Game._2v2CanPlayCards(subPhase);
    const canTricks = isMyTurn && Game._2v2CanPlayTricks(subPhase);

    // Card/trick click targets differ between local and online mode
    const cardClick  = isOnline
      ? (idx) => `twov2OnlineSelectCard(${idx})`
      : (idx) => `twov2SelectCard(${idx})`;
    const trickClick = isOnline
      ? (idx) => `twov2OnlineTrick(${idx})`
      : (idx) => `twov2PlayTrick(${idx})`;
    const doneClick  = isOnline
      ? 'twov2OnlineDone()'
      : 'Game.end2v2Phase(null, { actor: Game._2v2ActivePlayer() })';

    // Build lane HTML for 8 lanes
    const laneHtml = s.lanes.map((lane, i) => {
      const playerCard = lane.player;
      const aiCard     = lane.ai;
      const makeSlot = (card, side) => {
        if (!card) return `<div class="twov2-lane-slot twov2-lane-slot-empty"></div>`;
        return `<div class="twov2-lane-slot twov2-lane-card" style="background:${side==='player'?'#1e3a2e':'#3a1e1e'}">
          <div class="twov2-card-name">${card.name}</div>
          <div class="twov2-card-stats">${card.attack}/${card.currentHealth}</div>
        </div>`;
      };
      return `<div class="twov2-lane" data-lane="${i}">
        <div class="twov2-lane-num">${i+1}</div>
        ${makeSlot(aiCard, 'ai')}
        <div class="twov2-lane-divider"></div>
        ${makeSlot(playerCard, 'player')}
      </div>`;
    }).join('');

    // Build hand HTML
    const handHtml = ap.hand.map((card, idx) => {
      const affordable = ap.energy - ap.usedEnergy >= card.cost;
      return `<div class="twov2-hand-card ${affordable?'twov2-card-play':''}" onclick="${cardClick(idx)}"
               data-card-idx="${idx}" id="twov2-hcard-${idx}">
        <div class="twov2-hcard-cost">${card.cost}</div>
        <div class="twov2-hcard-name">${card.name}</div>
        ${this._hasBody(card) ? `<div class="twov2-hcard-stats">${card.attack}<span style="opacity:.55">atk</span> ${card.currentHealth}<span style="opacity:.55">hp</span></div>` : ''}
      </div>`;
    }).join('') || '<div class="twov2-hand-empty">No cards in hand</div>';

    const trickHtml = (canTricks && ap.trickHand.length > 0)
      ? ap.trickHand.map((t, idx) =>
          `<div class="twov2-trick-card" onclick="${trickClick(idx)}">
            <div class="twov2-hcard-cost twov2-trick-cost">${t.cost}</div>
            <div class="twov2-hcard-name">${t.name}</div>
          </div>`).join('')
      : '';

    const teamAColor = '#4fc3f7';
    const teamBColor = '#f44336';
    const energy = ap.energy - ap.usedEnergy;

    el.innerHTML = `
      <div class="twov2-game-wrap">
        <!-- Team health bars -->
        <div class="twov2-health-bar">
          <div class="twov2-hb-team" style="border-color:${teamAColor}">
            <span class="twov2-hb-label" style="color:${teamAColor}">Team A</span>
            <span class="twov2-hb-hp" style="color:${teamAColor}">${teamA.health}/${teamA.maxHealth} HP</span>
            <div class="twov2-block-pip-row ${this._blockTierClass(teamA.blockMeter)}">
              ${Array.from({length:Game.BLOCK_MAX}, (_,i) =>
                `<div class="twov2-block-pip ${i < teamA.blockMeter ? 'twov2-pip-filled' : ''}"></div>`
              ).join('')}
              <span class="twov2-block-label">Block</span>
            </div>
          </div>
          <div class="twov2-hb-round">Round ${round}</div>
          <div class="twov2-hb-team" style="border-color:${teamBColor}">
            <span class="twov2-hb-label" style="color:${teamBColor}">Team B</span>
            <span class="twov2-hb-hp" style="color:${teamBColor}">${teamB.health}/${teamB.maxHealth} HP</span>
            <div class="twov2-block-pip-row ${this._blockTierClass(teamB.blockMeter)}">
              ${Array.from({length:Game.BLOCK_MAX}, (_,i) =>
                `<div class="twov2-block-pip ${i < teamB.blockMeter ? 'twov2-pip-filled' : ''}"></div>`
              ).join('')}
              <span class="twov2-block-label">Block</span>
            </div>
          </div>
        </div>

        <!-- Board (8 lanes) -->
        <div class="twov2-board">
          ${laneHtml}
        </div>

        <!-- Active player info -->
        <div class="twov2-active-bar">
          <div class="twov2-active-name" style="color:${activeTeam==='A'?teamAColor:teamBColor}">
            ${ap.name}'s Turn
          </div>
          <div class="twov2-energy-display">
            ⚡ ${energy} Energy
          </div>
          ${phase === '2v2-combat' ? '<div class="twov2-combat-label">⚔️ Combat Resolving…</div>' : ''}
        </div>

        <!-- Player hand -->
        <div class="twov2-hand-wrap">
          <div class="twov2-hand-label">Your Hand ${canCards ? '' : '(Tricks Only)'}</div>
          <div class="twov2-hand" id="twov2-hand">
            ${canCards ? handHtml : '<div class="twov2-hand-empty">Cards locked this phase</div>'}
          </div>
          ${canTricks && trickHtml ? `
            <div class="twov2-hand-label" style="margin-top:8px">Tricks</div>
            <div class="twov2-tricks-row">${trickHtml}</div>
          ` : ''}
        </div>

        ${isOnline && !isMyTurn ? `
          <div class="twov2-waiting-banner">⏳ Waiting for ${tt.players[activeKey].name}…</div>
        ` : ''}

        <!-- Lane selection (shown when a card is selected) -->
        <div class="twov2-lane-select" id="twov2-lane-select" style="display:none">
          <div class="twov2-ls-label">Pick a lane (1–${Game.LANE_COUNT}):</div>
          <div class="twov2-ls-row">
            ${(() => {
              const myTeam = isOnline ? (tt.players[myKey] && tt.players[myKey].team) : activeTeam;
              const side = myTeam === 'A' ? 'player' : 'ai';
              // Same lock as every other placement surface — see
              // Game.placeableLanesFor.
              const okSet = new Set(Game.placeableLanesFor
                ? Game.placeableLanesFor(side, null) : s.lanes.map((_, i2) => i2));
              const compelled = Game.moderCompulsionLane ? Game.moderCompulsionLane(side) : -1;
              return s.lanes.map((ln, i) => {
                const blocked = !okSet.has(i);
                const forced = (compelled === i && okSet.has(i));
                const placeCmd = isOnline ? `twov2OnlinePlaceCard(${i})` : `twov2PlaceCard(${i})`;
                return `<button class="twov2-ls-btn${blocked?' twov2-ls-blocked':''}${forced?' twov2-ls-forced':''}"
                          onclick="${placeCmd}" ${blocked?'disabled':''}
                          ${blocked && compelled >= 0 ? `title="Moder forces your next card into lane ${compelled+1}"` : ''}>
                  Lane ${i+1}
                </button>`;
              }).join('');
            })()}
          </div>
          <button class="twov2-ls-cancel" onclick="twov2CancelCard()">Cancel</button>
        </div>

        <!-- Done button -->
        ${phase !== '2v2-combat' && isMyTurn ? `
          <button class="twov2-done-btn" onclick="${doneClick}">Done →</button>
        ` : ''}
      </div>`;

    // Store selected card index for lane pick
    if (this._2v2SelectedCardIdx != null) {
      const sel = document.getElementById(`twov2-hcard-${this._2v2SelectedCardIdx}`);
      if (sel) sel.classList.add('twov2-card-selected');
      const lsEl = document.getElementById('twov2-lane-select');
      if (lsEl) lsEl.style.display = 'flex';
    }
  },
  // Second stage of the unified join: the code was not a 1v1 room, so try 2v2.
  _mpFallbackTo2v2(code, name) {
    // Drop the dead 1v1 transport so its listeners can't fire into the 2v2 room.
    try { if (typeof Multiplayer !== 'undefined' && Multiplayer.leave) Multiplayer.leave(); } catch (e) {}
    if (typeof twov2OnlineJoin !== 'function') {
      this._mpState.status = 'error';
      this._mpState.error = "Couldn't find that room — double-check the code.";
      this._mpRender();
      return;
    }
    // No onFail here: if it is not a 2v2 room either, twov2OnlineJoin's own
    // error handler shows "couldn't find that room" on the 2v2 lobby it opened,
    // which has a code field to retry from.
    twov2OnlineJoin(code, name);
  },

  // ===================== INTERACTION =====================

  // True when 2v2-online AND it's the local seat's turn AND the sub-phase
  // allows this action. Lets the shared 1v1 hand/drag code work in 2v2, where
  // s.phase is a '2v2-p*' string the plain gates below don't recognise.
  _2v2LocalCanPlay(kind) {
    const tt = Game.state && Game.state.twoVTwo;
    if (!tt || !tt.online || !tt.you) return false;
    if (Game._2v2ActivePlayer && Game._2v2ActivePlayer() !== tt.you) return false;
    const sp = Game._2v2SubPhase && Game._2v2SubPhase();
    return kind === 'tricks' ? !!Game._2v2CanPlayTricks(sp) : !!Game._2v2CanPlayCards(sp);
  },
  // The local seat's live player object in 2v2 online — the hand/trickHand the
  // drag + hand code must read (s.player is restored to a stale value after the
  // 2v2 board renders). null outside 2v2 online.
  _2v2LocalSeatData() {
    const tt = Game.state && Game.state.twoVTwo;
    return (tt && tt.online && tt.you && tt.players[tt.you]) ? tt.players[tt.you] : null;
  },
  _2v2LocalSide() {
    const seat = this._2v2LocalSeatData();
    if (!seat) return null;
    return (Game._2v2TeamSide && Game._2v2TeamSide[seat.team]) || 'player';
  },
  // WHAT THIS TRICK COSTS *ME*. Every display and affordability check used to
  // ask Game.getTrickCost('player', trick) — hardcoded. getTrickCost reads the
  // OPPONENT of the side it is given to find enemy Sandmen, so for a Team B
  // player that asked the wrong question in both directions at once: it counted
  // their OWN team's Sandman against them and ignored the enemy's entirely.
  // (User: "sandmans is affecting but not showing up in hand to the enemy
  // players" — the host charged the real price and the hand showed the base
  // one.) Null outside 2v2, so 1v1 (where the guest's state is
  // perspective-flipped and 'player' really is them) is unchanged.
  // WHAT THIS CARD COSTS *ME* — the card twin of _localTrickCost, and the same
  // bug: getCardCost reads state[owner].discount and finds enemy Silver Surfers
  // by looking at the OPPONENT of the side it is given, and the UI passed a
  // hardcoded 'player'. For a Team B player that read Team A's discount and
  // counted their OWN team's Surfer against them while ignoring the enemy's.
  // (User: "for silver surfer, any in-hand changes to stats or cost, make sure
  // they show up in guest and host hands.")
  // May the person at this screen see what a face-down card actually is?
  // Only its own player. Solo/1v1 keeps its old behaviour (there is nobody
  // else on your side of the board), and the host is NOT special here — the
  // host running the match is not a licence to read a hidden card.
  _2v2MaySeeHidden(card) {
    const tt = Game.state && Game.state.twoVTwo;
    if (!tt || !(Game.is2v2 && Game.is2v2())) return true;
    const seat = tt.you || null;
    if (!seat) return false;
    return !!(card && card._2v2PlayedBy === seat);
  },
};
