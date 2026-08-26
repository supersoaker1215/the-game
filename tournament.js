// tournament.js — v1
// A complete, self-contained Tournament game mode: a best-of series of real
// classic matches, each played under one of 13 modifiers, with a number game
// to decide first pick and a persistent series scoreboard.
//
// FLOW
//   1. Pick series length (Bo3 / Bo5 / Bo7).
//   2. Number game — both sides secretly pick 1–20; the roll decides who is
//      closest. Ties reroll. The winner gets first pick.
//   3. Draft — the normal classic draft, ONCE. Both decks are captured and
//      reused for every match in the series (reshuffled each game).
//   4. The number-game winner picks the first modifier AND whether to go first.
//   5. Play the match. On result, the LOSER picks the next modifier (no repeats)
//      and whether to go first. Repeat until a side reaches the win threshold.
//
// The match itself runs on the real engine via Game.startMatch({ _presetHands,
// _mods, _firstPlayer }). The modifier effects live in game.js (Game.mod()).
// This module owns only the series flow, its screens, and the two runtime-only
// modifiers (Auction House pre-match bidding, Speed Round turn timer).

const Tournament = {
  active: false,
  _saved: null,
  el: null,

  // The 13 modifiers. `id` matches the flags Game.mod() reads.
  MODIFIERS: [
    { id: 'classic',       name: 'Classic',        icon: '🎴', desc: 'A normal game — no changes.' },
    { id: 'powerSurge',    name: 'Power Surge',    icon: '⚡', desc: 'Energy gains +2 per round instead of +1.' },
    { id: 'glassCannon',   name: 'Glass Cannon',   icon: '💥', desc: 'Both players start at half HP (15).' },
    { id: 'anarchy',       name: 'Anarchy',        icon: '🏴', desc: 'All cards cost 1 less (minimum 0).' },
    { id: 'bloodBath',     name: 'Blood Bath',     icon: '🩸', desc: 'All cards deal double damage.' },
    { id: 'glassJaw',      name: 'Glass Jaw',      icon: '🦴', desc: 'All cards enter with half HP (rounded down).' },
    { id: 'chainReaction', name: 'Chain Reaction', icon: '☢️', desc: 'When a card dies it deals 1 to all adjacent cards.' },
    { id: 'battlefield',   name: 'Battlefield',    icon: '🔥', desc: 'A card takes 1 damage when played into a lane.' },
    { id: 'shuffle',       name: 'Shuffle',        icon: '🌀', desc: 'Every round, all cards are re-scattered to new lanes.' },
    { id: 'bounty',        name: 'Bounty Hunter',  icon: '🎯', desc: 'Killing an enemy card grants you 1 energy immediately.' },
    { id: 'speed',         name: 'Speed Round',    icon: '⏱️', desc: '15 seconds per turn — or it is skipped.' },
    { id: 'kingOfHill',    name: 'King of the Hill',icon: '👑', desc: 'Hold the random Hill lane at round end for +1 HP.' },
    { id: 'auction',       name: 'Auction House',  icon: '💰', desc: 'Bid energy on 5 bonus cards before the match.' },
  ],

  // Runtime series state.
  T: null,

  // ── ENTRY ──────────────────────────────────────────────────────────────
  enter() {
    this.active = true;
    this.T = {
      phase: 'setup',
      length: 3, threshold: 2,
      playerWins: 0, aiWins: 0,
      numberWinner: null,        // who won the number game
      decks: null,               // { player:{cards,tricks}, ai:{cards,tricks} }
      usedMods: [],              // modifier ids already played
      currentMod: null,
      firstPlayer: null,         // who goes first this match
      chooser: null,             // who is picking modifier + order right now
      gameNumber: 0,
      playerNum: null, aiNum: null, roll: null,   // number game
    };
    this._installHooks();
    this._ensureOverlay();
    this._renderSetup();
  },

  exit() {
    this.active = false;
    this._restoreHooks();
    this._clearSpeedTimer();
    if (this.el) this.el.remove();
    this.el = null;
    this.T = null;
    if (typeof Game !== 'undefined') Game.init();
    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },

  // ── ENGINE HOOKS (saved + restored) ──────────────────────────────────────
  _installHooks() {
    const self = this;
    this._saved = {
      showGameOverScreen: (typeof UI !== 'undefined') ? UI.showGameOverScreen : null,
      finishTrickDraft:   Game.finishTrickDraft,
    };
    // Intercept match end — feed the result into the series instead of the
    // normal victory screen.
    if (typeof UI !== 'undefined') {
      UI.showGameOverScreen = function (winner) {
        if (self.active && self.T && self.T.phase === 'playing') { self._onMatchEnd(winner); return; }
        if (self._saved.showGameOverScreen) return self._saved.showGameOverScreen.call(UI, winner);
      };
    }
    // Capture the draft result the first time the series drafts, and hand
    // control back to the tournament instead of starting a loose match.
    Game.finishTrickDraft = function () {
      if (self.active && self.T && self.T.phase === 'draft') { self._captureDraft(); return; }
      return self._saved.finishTrickDraft.apply(this, arguments);
    };
  },
  _restoreHooks() {
    const s = this._saved; if (!s) return;
    if (typeof UI !== 'undefined') UI.showGameOverScreen = s.showGameOverScreen;
    Game.finishTrickDraft = s.finishTrickDraft;
    this._saved = null;
  },

  // ── OVERLAY ──────────────────────────────────────────────────────────────
  _ensureOverlay() {
    let el = document.getElementById('tournament-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tournament-overlay';
      el.className = 'tourney-overlay';
      document.body.appendChild(el);
    }
    this.el = el;
    el.style.display = 'flex';
  },
  _hideOverlay()  { if (this.el) this.el.style.display = 'none'; },
  _showOverlay()  { if (this.el) this.el.style.display = 'flex'; },
  _set(html)      { this._showOverlay(); if (this.el) this.el.innerHTML = html; },

  // Scoreboard chip reused across every screen + the in-match HUD.
  _scoreHTML() {
    const t = this.T;
    return `<div class="tourney-score">
      <span class="ts-side ts-you">YOU <b>${t.playerWins}</b></span>
      <span class="ts-vs">Best of ${t.length}</span>
      <span class="ts-side ts-ai"><b>${t.aiWins}</b> RIVAL</span>
    </div>`;
  },

  // ── 1) SERIES LENGTH ─────────────────────────────────────────────────────
  _renderSetup() {
    this.T.phase = 'setup';
    const opt = (len) => `
      <button class="tourney-bigbtn" onclick="Tournament.pickLength(${len})">
        <span class="tb-title">Best of ${len}</span>
        <span class="tb-sub">First to ${Math.ceil((len + 1) / 2)} wins</span>
      </button>`;
    this._set(`
      <div class="tourney-card tourney-setup">
        <div class="tourney-kicker">Tournament</div>
        <h1 class="tourney-h1">Choose Series Length</h1>
        <p class="tourney-lead">Win the series under a rotating set of modifiers. Each match changes the rules.</p>
        <div class="tourney-choices">${opt(3)}${opt(5)}${opt(7)}</div>
        <button class="tourney-textbtn" onclick="Tournament.exit()">← Leave Tournament</button>
      </div>`);
  },
  pickLength(len) {
    this.T.length = len;
    this.T.threshold = Math.ceil((len + 1) / 2);
    this._renderNumberGame();
  },

  // ── 2) NUMBER GAME ───────────────────────────────────────────────────────
  _renderNumberGame() {
    this.T.phase = 'number';
    this.T.playerNum = null;
    const nums = Array.from({ length: 20 }, (_, i) => i + 1)
      .map(n => `<button class="tourney-num" id="tnum-${n}" onclick="Tournament.pickNumber(${n})">${n}</button>`).join('');
    this._set(`
      <div class="tourney-card">
        ${this._scoreHTML()}
        <div class="tourney-kicker">Round 0 · The Draw</div>
        <h1 class="tourney-h1">Number Game</h1>
        <p class="tourney-lead">Secretly pick a number from <b>1–20</b>. A number is rolled — whoever is closest wins <b>first pick</b> of the series. Ties reroll.</p>
        <div class="tourney-numgrid">${nums}</div>
        <div id="tourney-numresult" class="tourney-numresult"></div>
      </div>`);
  },
  pickNumber(n) {
    const t = this.T;
    if (t.playerNum != null) return;
    t.playerNum = n;
    const btn = document.getElementById('tnum-' + n);
    if (btn) btn.classList.add('picked');
    document.querySelectorAll('.tourney-num').forEach(b => { b.disabled = true; });
    // AI picks secretly.
    t.aiNum = 1 + Math.floor(Math.random() * 20);
    this._rollNumber();
  },
  _rollNumber() {
    const t = this.T;
    t.roll = 1 + Math.floor(Math.random() * 20);
    const dp = Math.abs(t.playerNum - t.roll);
    const da = Math.abs(t.aiNum - t.roll);
    const res = document.getElementById('tourney-numresult');
    if (dp === da) {
      if (res) res.innerHTML = `<div class="tn-roll">Rolled <b>${t.roll}</b> — you ${t.playerNum}, rival ${t.aiNum}. <span class="tn-tie">Tie! Rerolling…</span></div>`;
      setTimeout(() => this._rollNumber(), 1100);
      return;
    }
    t.numberWinner = (dp < da) ? 'player' : 'ai';
    const won = t.numberWinner === 'player';
    if (res) res.innerHTML = `
      <div class="tn-roll">Rolled <b>${t.roll}</b> &nbsp;·&nbsp; You picked <b>${t.playerNum}</b> &nbsp;·&nbsp; Rival picked <b>${t.aiNum}</b></div>
      <div class="tn-winner ${won ? 'win' : 'lose'}">${won ? 'You win the draw — you get first pick!' : 'Rival wins the draw — they pick first.'}</div>
      <button class="tourney-bigbtn tourney-continue" onclick="Tournament.startDraft()">Continue to Draft →</button>`;
  },

  // ── 3) DRAFT ─────────────────────────────────────────────────────────────
  startDraft() {
    this.T.phase = 'draft';
    this._hideOverlay();
    // Run the real classic draft. Our patched finishTrickDraft captures it.
    Game.startMatch({ players: '1v1', deck: 'classic' });
  },
  _captureDraft() {
    const d = Game.state.draft;
    this.T.decks = {
      player: { cards: (d.playerDrafted || []).slice(), tricks: (d.playerTrickDrafted || []).slice() },
      ai:     { cards: (d.aiDrafted     || []).slice(), tricks: (d.aiTrickDrafted     || []).slice() },
    };
    Game.log('[TOURNAMENT] Decks drafted and locked in for the series.');
    // The number-game winner makes the first pick.
    this.T.gameNumber = 1;
    this.T.chooser = this.T.numberWinner;
    this._renderModifierPick();
  },

  // ── 4/6) MODIFIER + FIRST/SECOND PICK ─────────────────────────────────────
  _renderModifierPick() {
    this.T.phase = 'modifier';
    const t = this.T;
    this._showOverlay();
    const youChoose = t.chooser === 'player';
    const avail = this.MODIFIERS.filter(m => t.usedMods.indexOf(m.id) < 0);
    if (!youChoose) {
      // AI chooses — auto-pick, show what it chose, then continue.
      const mod = avail[Math.floor(Math.random() * avail.length)];
      // AI tends to take first, but sometimes second for variety.
      const first = Math.random() < 0.75 ? 'ai' : 'player';
      this._set(`
        <div class="tourney-card">
          ${this._scoreHTML()}
          <div class="tourney-kicker">Game ${t.gameNumber} · Rival chooses</div>
          <h1 class="tourney-h1">Rival's Pick</h1>
          <div class="tourney-modchosen">
            <div class="tmc-icon">${mod.icon}</div>
            <div class="tmc-name">${mod.name}</div>
            <div class="tmc-desc">${mod.desc}</div>
          </div>
          <p class="tourney-lead">Rival elects to go <b>${first === 'ai' ? 'first' : 'second'}</b>.</p>
          <button class="tourney-bigbtn tourney-continue" onclick="Tournament.confirmModifier('${mod.id}','${first}')">Begin Game ${t.gameNumber} →</button>
        </div>`);
      return;
    }
    // Human chooses a modifier tile, then first/second.
    const tiles = avail.map(m => `
      <button class="tourney-modtile" onclick="Tournament.selectMod('${m.id}')" id="tmod-${m.id}">
        <span class="tmt-icon">${m.icon}</span>
        <span class="tmt-name">${m.name}</span>
        <span class="tmt-desc">${m.desc}</span>
      </button>`).join('');
    const usedTiles = t.usedMods.map(id => {
      const m = this.MODIFIERS.find(x => x.id === id);
      return `<span class="tourney-usedchip" title="${m.desc}">${m.icon} ${m.name}</span>`;
    }).join('');
    this._set(`
      <div class="tourney-card tourney-modpick">
        ${this._scoreHTML()}
        <div class="tourney-kicker">Game ${t.gameNumber} · Your pick</div>
        <h1 class="tourney-h1">Choose a Modifier</h1>
        <p class="tourney-lead">${t.gameNumber === 1 ? 'You won the draw.' : 'You lost the last match, so you choose.'} Pick a modifier and whether to go first. No modifier repeats in a series.</p>
        ${usedTiles ? `<div class="tourney-used">Already played: ${usedTiles}</div>` : ''}
        <div class="tourney-modgrid">${tiles}</div>
        <div id="tourney-order" class="tourney-order" style="display:none"></div>
      </div>`);
  },
  selectMod(id) {
    this.T._pendingMod = id;
    document.querySelectorAll('.tourney-modtile').forEach(b => b.classList.remove('sel'));
    const b = document.getElementById('tmod-' + id);
    if (b) b.classList.add('sel');
    const mod = this.MODIFIERS.find(m => m.id === id);
    const order = document.getElementById('tourney-order');
    if (order) {
      order.style.display = '';
      order.innerHTML = `
        <div class="tourney-order-q">Selected <b>${mod.icon} ${mod.name}</b> — go first or second?</div>
        <div class="tourney-order-btns">
          <button class="tourney-bigbtn" onclick="Tournament.confirmModifier('${id}','player')">Go First</button>
          <button class="tourney-bigbtn" onclick="Tournament.confirmModifier('${id}','ai')">Go Second</button>
        </div>`;
      order.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  },
  confirmModifier(id, firstPlayer) {
    const t = this.T;
    t.currentMod = id;
    t.firstPlayer = firstPlayer;
    if (t.usedMods.indexOf(id) < 0) t.usedMods.push(id);
    // Auction House runs its pre-match bidding screen first.
    if (id === 'auction') { this._renderAuction(); return; }
    this._startMatch();
  },

  // ── 5) PLAY A MATCH ───────────────────────────────────────────────────────
  _startMatch(bonusHands) {
    const t = this.T;
    t.phase = 'playing';
    this._hideOverlay();
    const decks = t.decks;
    // Fresh instances each match; add any auction-won bonus cards to hand.
    const mods = {}; mods[t.currentMod] = true;
    const preset = {
      player: { cards: decks.player.cards.slice().concat((bonusHands && bonusHands.player) || []), tricks: decks.player.tricks.slice() },
      ai:     { cards: decks.ai.cards.slice().concat((bonusHands && bonusHands.ai) || []),         tricks: decks.ai.tricks.slice() },
    };
    Game.startMatch({
      players: '1v1', deck: 'classic',
      _presetHands: preset, _mods: mods, _firstPlayer: t.firstPlayer, _tournament: true,
    });
    this._showHud();
    if (t.currentMod === 'speed') this._armSpeedTimer();
  },

  _onMatchEnd(winner) {
    const t = this.T;
    this._clearSpeedTimer();
    this._removeHud();
    if (winner === 'player') t.playerWins++; else t.aiWins++;
    if (t.playerWins >= t.threshold || t.aiWins >= t.threshold) { this._renderSeriesOver(); return; }
    // Loser of THIS match chooses the next modifier + order.
    t.gameNumber++;
    t.chooser = (winner === 'player') ? 'ai' : 'player';
    t._pendingMod = null;
    this._renderMatchResult(winner);
  },
  _renderMatchResult(winner) {
    const t = this.T;
    const won = winner === 'player';
    this._set(`
      <div class="tourney-card">
        ${this._scoreHTML()}
        <div class="tourney-kicker">Game ${t.gameNumber - 1} result</div>
        <h1 class="tourney-h1 ${won ? 'win' : 'lose'}">${won ? 'You won that game!' : 'Rival took that one.'}</h1>
        <p class="tourney-lead">Series: <b>You ${t.playerWins}</b> — <b>${t.aiWins} Rival</b> (first to ${t.threshold}). The loser picks the next modifier.</p>
        <button class="tourney-bigbtn tourney-continue" onclick="Tournament._renderModifierPick()">${t.chooser === 'player' ? 'Choose next modifier →' : 'See rival&#39;s pick →'}</button>
      </div>`);
  },

  // ── 7) SERIES OVER ────────────────────────────────────────────────────────
  _renderSeriesOver() {
    this.T.phase = 'series-over';
    const t = this.T;
    const won = t.playerWins > t.aiWins;
    this._set(`
      <div class="tourney-card tourney-final">
        <div class="tourney-kicker">Best of ${t.length} · Complete</div>
        <div class="tourney-trophy">${won ? '🏆' : '🥈'}</div>
        <h1 class="tourney-h1 ${won ? 'win' : 'lose'}">${won ? 'Series Won!' : 'Series Lost'}</h1>
        <p class="tourney-lead">Final score: <b>You ${t.playerWins}</b> — <b>${t.aiWins} Rival</b>.</p>
        <div class="tourney-choices">
          <button class="tourney-bigbtn" onclick="Tournament.enter()">New Tournament</button>
          <button class="tourney-bigbtn" onclick="Tournament.exit()">Main Menu</button>
        </div>
      </div>`);
  },

  // ── IN-MATCH HUD (persistent series scoreboard) ───────────────────────────
  _showHud() {
    this._removeHud();
    const t = this.T;
    const mod = this.MODIFIERS.find(m => m.id === t.currentMod);
    const hud = document.createElement('div');
    hud.id = 'tourney-hud';
    hud.className = 'tourney-hud';
    hud.innerHTML = `
      <span class="th-series">SERIES <b>${t.playerWins}</b>–<b>${t.aiWins}</b> · Bo${t.length}</span>
      <span class="th-game">Game ${t.gameNumber}</span>
      <span class="th-mod">${mod.icon} ${mod.name}</span>
      <span id="th-timer" class="th-timer" style="display:none"></span>`;
    document.body.appendChild(hud);
  },
  _removeHud() { const h = document.getElementById('tourney-hud'); if (h) h.remove(); },

  // ── SPEED ROUND (15s turn timer) ──────────────────────────────────────────
  _armSpeedTimer() {
    this._clearSpeedTimer();
    this._speedInt = setInterval(() => this._speedTick(), 500);
    this._speedPhase = null;
  },
  _speedTick() {
    if (!this.active || this.T.phase !== 'playing') { this._clearSpeedTimer(); return; }
    const s = Game.state;
    const timerEl = document.getElementById('th-timer');
    // Only run the clock on a HUMAN card/trick phase with no open prompt.
    const myTurn = s.phase && s.phase.startsWith('player-') && !s.gameOver && !Game.hasPendingPrompt();
    if (!myTurn) { this._speedPhase = null; if (timerEl) timerEl.style.display = 'none'; return; }
    const now = Date.now();
    if (this._speedPhase !== s.phase) { this._speedPhase = s.phase; this._speedStart = now; }
    const left = Math.max(0, 15 - Math.floor((now - this._speedStart) / 1000));
    if (timerEl) { timerEl.style.display = ''; timerEl.textContent = `⏱ ${left}s`; timerEl.classList.toggle('th-urgent', left <= 5); }
    if (left <= 0) {
      // Time up — auto-pass this phase.
      this._speedPhase = null;
      Game.log('  [SPEED ROUND] Time up — turn skipped.');
      try {
        if (s.phase === 'player-cards') Game.endPhase1();
        else if (s.phase === 'player-cards-tricks') Game.endPhase2();
        else if (s.phase === 'player-tricks') Game.endPhase3();
      } catch (e) { console.error('[speed round]', e); }
    }
  },
  _clearSpeedTimer() { if (this._speedInt) { clearInterval(this._speedInt); this._speedInt = null; } },

  // ── AUCTION HOUSE ─────────────────────────────────────────────────────────
  // Before the match, 5 random cards are auctioned. Each side has a bid budget;
  // the human bids on each in turn (blind vs the AI's roll); the higher bid wins
  // the card into their opening hand. Won cards are added on top of the drafted
  // hand for THIS match only.
  _renderAuction() {
    this.T.phase = 'auction';
    const pool = (typeof CARD_DEFS !== 'undefined')
      ? CARD_DEFS.filter(c => !c._spawnOnly && !c.isEnvironment) : [];
    const picks = [];
    const used = new Set();
    while (picks.length < 5 && pool.length) {
      const c = pool[Math.floor(Math.random() * pool.length)];
      if (used.has(c.name)) continue; used.add(c.name); picks.push(c);
    }
    this.T._auction = {
      cards: picks, idx: 0,
      playerBudget: 10, aiBudget: 10,
      won: { player: [], ai: [] },
    };
    this._renderAuctionCard();
  },
  _renderAuctionCard() {
    const a = this.T._auction;
    if (a.idx >= a.cards.length) { this._finishAuction(); return; }
    const c = a.cards[a.idx];
    const maxBid = a.playerBudget;
    const bidOpts = Array.from({ length: maxBid + 1 }, (_, i) => i)
      .map(v => `<button class="tourney-num tourney-bid" onclick="Tournament.placeBid(${v})">${v}</button>`).join('');
    this._showOverlay();
    this._set(`
      <div class="tourney-card tourney-auction">
        ${this._scoreHTML()}
        <div class="tourney-kicker">💰 Auction House · Lot ${a.idx + 1} of ${a.cards.length}</div>
        <h1 class="tourney-h1">Bid for a Bonus Card</h1>
        <div class="tourney-lot">
          <div class="tl-name">${c.name}</div>
          <div class="tl-stats">${(c.cost != null ? c.cost + '⚡ · ' : '')}${c.attack != null ? c.attack + '/' + c.health : ''} · ${c.type || ''}</div>
          <div class="tl-desc">${c.desc || ''}</div>
        </div>
        <p class="tourney-lead">Your budget: <b>${a.playerBudget}⚡</b>. Highest bid wins it into your opening hand for this match. Ties go to the house (nobody).</p>
        <div class="tourney-bidrow">${bidOpts}</div>
        <div id="tourney-bidresult" class="tourney-numresult"></div>
      </div>`);
  },
  placeBid(v) {
    const a = this.T._auction;
    document.querySelectorAll('.tourney-bid').forEach(b => b.disabled = true);
    const aiBid = Math.floor(Math.random() * (a.aiBudget + 1));
    const c = a.cards[a.idx];
    let winner = null;
    if (v > aiBid) { winner = 'player'; a.playerBudget -= v; a.won.player.push(c); }
    else if (aiBid > v) { winner = 'ai'; a.aiBudget -= aiBid; a.won.ai.push(c); }
    const res = document.getElementById('tourney-bidresult');
    if (res) res.innerHTML = `
      <div class="tn-roll">You bid <b>${v}⚡</b> · Rival bid <b>${aiBid}⚡</b></div>
      <div class="tn-winner ${winner === 'player' ? 'win' : (winner === 'ai' ? 'lose' : '')}">
        ${winner === 'player' ? `You win ${c.name}!` : winner === 'ai' ? `Rival takes ${c.name}.` : `No sale — tie.`}</div>
      <button class="tourney-bigbtn tourney-continue" onclick="Tournament._nextAuctionLot()">${a.idx + 1 < a.cards.length ? 'Next Lot →' : 'Start Match →'}</button>`;
  },
  _nextAuctionLot() { this.T._auction.idx++; this._renderAuctionCard(); },
  _finishAuction() {
    const a = this.T._auction;
    const bonus = {
      player: a.won.player.map(c => c),
      ai:     a.won.ai.map(c => c),
    };
    this._startMatch(bonus);
  },
};
