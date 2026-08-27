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
    this._online = null;
    this._restoreHooks();
    this._clearSpeedTimer();
    this._removeHud();
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
    this._renderModeSelect();
  },

  // ── 1b) OPPONENT / MODE ──────────────────────────────────────────────────
  _isLocal() { return this.T.mode === '1v1'; },
  _rivalName() { return this._isLocal() ? 'Player 2' : 'Rival'; },
  _renderModeSelect() {
    this.T.phase = 'mode';
    const opt = (onclick, title, sub, enabled) => `
      <button class="tourney-bigbtn ${enabled ? '' : 'tourney-soon'}" ${enabled ? `onclick="${onclick}"` : 'disabled'}>
        <span class="tb-title">${title}</span>
        <span class="tb-sub">${sub}</span>
      </button>`;
    this._set(`
      <div class="tourney-card">
        ${this._scoreHTML()}
        <div class="tourney-kicker">Tournament · Best of ${this.T.length}</div>
        <h1 class="tourney-h1">Choose Your Opponent</h1>
        <p class="tourney-lead">Who are you facing across the series?</p>
        <div class="tourney-choices">
          ${opt("Tournament.pickMode('solo')", 'Solo vs AI', 'Play the whole series against the computer', true)}
          ${opt("Tournament._goOnline('1v1')", '1v1 Online', 'Play a friend online — create or join a room', true)}
          ${opt("Tournament._goOnline('2v2')", '2v2 Online', 'Four players online — team series', true)}
        </div>
        <button class="tourney-textbtn" onclick="Tournament._renderSetup()">← Series length</button>
      </div>`);
  },
  pickMode(m) {
    this.T.mode = m;
    this._renderNumberGame();
  },

  // ── 2) NUMBER GAME ───────────────────────────────────────────────────────
  _numGridHTML(handler) {
    return Array.from({ length: 20 }, (_, i) => i + 1)
      .map(n => `<button class="tourney-num" onclick="Tournament.${handler}(${n})">${n}</button>`).join('');
  },
  _renderNumberGame() {
    this.T.phase = 'number';
    this.T.playerNum = null; this.T.aiNum = null;
    const who = this._isLocal() ? 'Player 1' : 'You';
    this._set(`
      <div class="tourney-card">
        ${this._scoreHTML()}
        <div class="tourney-kicker">Round 0 · The Draw</div>
        <h1 class="tourney-h1">Number Game</h1>
        <p class="tourney-lead"><b>${who}</b>, secretly pick a number from <b>1–20</b>. Closest to the roll wins <b>first pick</b> of the series. Ties reroll.</p>
        <div class="tourney-numgrid">${this._numGridHTML('pickNumber')}</div>
        <div id="tourney-numresult" class="tourney-numresult"></div>
      </div>`);
  },
  pickNumber(n) {
    const t = this.T;
    if (t.playerNum != null) return;
    t.playerNum = n;
    if (this._isLocal()) { this._renderP2Number(); return; }
    // Solo: AI picks secretly.
    document.querySelectorAll('.tourney-num').forEach(b => { b.disabled = true; });
    t.aiNum = 1 + Math.floor(Math.random() * 20);
    this._rollNumber();
  },
  // 1v1 Local — pass the device, Player 2 picks their own number.
  _renderP2Number() {
    this._set(`
      <div class="tourney-card">
        ${this._scoreHTML()}
        <div class="tourney-kicker">Round 0 · The Draw</div>
        <h1 class="tourney-h1">Pass to Player 2</h1>
        <p class="tourney-lead"><b>Player 2</b>, pick your number from <b>1–20</b>. (Player 1's pick is hidden.)</p>
        <div class="tourney-numgrid">${this._numGridHTML('pickNumberP2')}</div>
        <div id="tourney-numresult" class="tourney-numresult"></div>
      </div>`);
  },
  pickNumberP2(n) {
    const t = this.T;
    if (t.aiNum != null) return;
    t.aiNum = n;
    document.querySelectorAll('.tourney-num').forEach(b => { b.disabled = true; });
    this._rollNumber();
  },
  _rollNumber() {
    const t = this.T;
    t.roll = 1 + Math.floor(Math.random() * 20);
    const dp = Math.abs(t.playerNum - t.roll);
    const da = Math.abs(t.aiNum - t.roll);
    const res = document.getElementById('tourney-numresult');
    const nameW = this._isLocal() ? 'Player 1' : 'You';
    const nameL = this._isLocal() ? 'Player 2' : 'Rival';
    if (dp === da) {
      if (res) res.innerHTML = `<div class="tn-roll">Rolled <b>${t.roll}</b> — ${nameW} ${t.playerNum}, ${nameL} ${t.aiNum}. <span class="tn-tie">Tie! Rerolling…</span></div>`;
      setTimeout(() => this._rollNumber(), 1100);
      return;
    }
    t.numberWinner = (dp < da) ? 'player' : 'ai';
    const winnerName = t.numberWinner === 'player' ? nameW : nameL;
    const won = t.numberWinner === 'player';
    if (res) res.innerHTML = `
      <div class="tn-roll">Rolled <b>${t.roll}</b> &nbsp;·&nbsp; ${nameW}: <b>${t.playerNum}</b> &nbsp;·&nbsp; ${nameL}: <b>${t.aiNum}</b></div>
      <div class="tn-winner ${won ? 'win' : 'lose'}">${winnerName} win${winnerName === 'You' ? '' : 's'} the draw — first pick!</div>
      <button class="tourney-bigbtn tourney-continue" onclick="Tournament.startDraft()">Continue to Draft →</button>`;
  },

  // ── 3) DRAFT ─────────────────────────────────────────────────────────────
  startDraft() {
    this.T.phase = 'draft';
    this._hideOverlay();
    // Run the real classic draft. Our patched finishTrickDraft captures it.
    // 1v1 Local drafts pass-and-play so each player picks their own deck.
    Game.startMatch({ players: '1v1', deck: 'classic', hotseat: this._isLocal() });
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
    // The chooser is a human unless it's the AI in Solo mode. In 1v1 Local the
    // "rival" is Player 2 (human), so they pick their own modifier + order.
    const humanChoose = (t.chooser === 'player') || this._isLocal();
    const chooserName = t.chooser === 'player'
      ? (this._isLocal() ? 'Player 1' : 'You')
      : (this._isLocal() ? 'Player 2' : 'Rival');
    const avail = this.MODIFIERS.filter(m => t.usedMods.indexOf(m.id) < 0);
    if (!humanChoose) {
      // Solo AI chooses — auto-pick, show what it chose, then continue.
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
    const reason = t.gameNumber === 1
      ? `${chooserName} won the draw.`
      : `${chooserName} lost the last match, so ${chooserName === 'You' ? 'you' : 'they'} choose.`;
    this._set(`
      <div class="tourney-card tourney-modpick">
        ${this._scoreHTML()}
        <div class="tourney-kicker">Game ${t.gameNumber} · ${chooserName === 'You' ? 'Your' : chooserName + '’s'} pick</div>
        <h1 class="tourney-h1">Choose a Modifier</h1>
        <p class="tourney-lead">${reason} Pick a modifier and whether to go first. No modifier repeats in a series.</p>
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
      // First/second is from the CHOOSER's seat: "Go First" means the chooser
      // takes the first turn (chooser === 'ai' when the loser / Player 2 picks).
      const me = this.T.chooser;
      const them = me === 'player' ? 'ai' : 'player';
      order.style.display = '';
      order.innerHTML = `
        <div class="tourney-order-q">Selected <b>${mod.icon} ${mod.name}</b> — go first or second?</div>
        <div class="tourney-order-btns">
          <button class="tourney-bigbtn" onclick="Tournament.confirmModifier('${id}','${me}')">Go First</button>
          <button class="tourney-bigbtn" onclick="Tournament.confirmModifier('${id}','${them}')">Go Second</button>
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
    this._matchResolved = false;   // arm this match's single result
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
      hotseat: this._isLocal(),   // 1v1 Local runs its matches pass-and-play
    });
    this._showHud();
    if (t.currentMod === 'speed') this._armSpeedTimer();
  },

  _onMatchEnd(winner) {
    const t = this.T;
    // ONE RESULT PER MATCH. showGameOverScreen fires more than once per game
    // over (damagePlayer's immediate hook + the next render both call it), so
    // without this guard a single win counted twice and a Bo3 ended 2–0 after
    // one game.
    if (this._matchResolved) return;
    this._matchResolved = true;
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
    // Win pips so the series score reads at a glance.
    const pip = (filled, cls) => `<span class="th-pip ${filled ? cls : ''}"></span>`;
    const pips = (n, cls) => Array.from({ length: t.threshold }, (_, i) => pip(i < n, cls)).join('');
    const hud = document.createElement('div');
    hud.id = 'tourney-hud';
    hud.className = 'tourney-hud';
    hud.innerHTML = `
      <div class="th-head">🏆 TOURNAMENT</div>
      <div class="th-row"><span class="th-label">Series</span><span class="th-sub">Best of ${t.length}</span></div>
      <div class="th-scoreline">
        <span class="th-name th-you">YOU</span>
        <span class="th-pips">${pips(t.playerWins, 'you')}</span>
        <span class="th-vs">${t.playerWins}–${t.aiWins}</span>
        <span class="th-pips th-pips-r">${pips(t.aiWins, 'ai')}</span>
        <span class="th-name th-ai">RIVAL</span>
      </div>
      <div class="th-divider"></div>
      <div class="th-row"><span class="th-label">Game ${t.gameNumber}</span><span id="th-timer" class="th-timer" style="display:none"></span></div>
      <div class="th-modrow"><span class="th-modicon">${mod.icon}</span><span class="th-modname">${mod.name}</span></div>
      <div class="th-moddesc">${mod.desc}</div>`;
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

  // ════════════════════════════════════════════════════════════════════════
  // ONLINE 1v1 TOURNAMENT
  // Host-authoritative. The whole series lives in Game.state._tournament, which
  // rides the existing state broadcast, so both clients render the same series
  // UI for free. Each game is a normal online match (startMultiplayerHost →
  // draft → play → rematch) with the modifier injected via state.mode._mods.
  // Guests forward their picks to the host as { t:'tourneyNum' } /
  // { t:'tourneyMod' } actions; the host mutates the series and re-broadcasts.
  // ════════════════════════════════════════════════════════════════════════

  // Entry from the mode-select. Opens the existing 1v1 online lobby; the
  // pending config tells the opponentJoined handler to run the series flow.
  _goOnline(mode) {
    this._online = { mode: mode, length: this.T.length, threshold: this.T.threshold };
    this.active = false;                 // hand off to the online lobby
    if (this.el) this.el.style.display = 'none';
    if (mode === '2v2') {
      if (typeof Game !== 'undefined' && Game.goTo2v2OnlineLobby) Game.goTo2v2OnlineLobby();
    } else {
      if (typeof UI !== 'undefined' && UI.openMultiplayer) UI.openMultiplayer();
    }
  },

  _isHost() { return !!(typeof Game !== 'undefined' && Game.mp && Game.mp.role === 'host'); },
  _t() { return (typeof Game !== 'undefined' && Game.state) ? Game.state._tournament : null; },
  _mySide()  { return this._isHost() ? 'host' : 'guest'; },
  _oppSide() { return this._isHost() ? 'guest' : 'host'; },
  _myWins()  { const t = this._t(); return t ? (this._isHost() ? t.hostWins : t.guestWins) : 0; },
  _oppWins() { const t = this._t(); return t ? (this._isHost() ? t.guestWins : t.hostWins) : 0; },

  // Host: the opponent connected — build the series and start the number game.
  _hostConnected() {
    const cfg = this._online; if (!cfg) return;
    Game.startMultiplayerHost({}, true);   // connection + broadcast only, no match
    Game.state._tournament = {
      online: true, mode: cfg.mode,
      length: cfg.length, threshold: cfg.threshold,
      hostWins: 0, guestWins: 0,
      phase: 'number', gameNumber: 1,
      hostNum: null, guestNum: null, roll: null, numberWinner: null,
      usedMods: [], currentMod: null, firstPlayer: null, chooser: null,
    };
    Game._mpBroadcast();
    this._onlineRender();
  },

  // Called on every state update (host after broadcast, guest on state arrival)
  // and after any local pick. Renders the right series screen from the synced
  // state, or steps aside while a game is being played.
  _onlineRender() {
    const t = this._t();
    if (!t || !t.online) { this._hideOverlay && this._hideOverlay(); return; }
    this._ensureOverlay();
    // A game is in progress — show only the compact HUD, let the board play.
    if (t.phase === 'playing' && !Game.state.gameOver) {
      this._hideOverlay(); this._showOnlineHud(); return;
    }
    this._removeHud();
    this._showOverlay();
    if (t.phase === 'number')      return this._renderOnlineNumber(t);
    if (t.phase === 'modifier')    return this._renderOnlineModifier(t);
    if (t.phase === 'series-over') return this._renderOnlineOver(t);
  },

  _onlineScoreHTML() {
    const t = this._t(); if (!t) return '';
    return `<div class="tourney-score">
      <span class="ts-side ts-you">YOU <b>${this._myWins()}</b></span>
      <span class="ts-vs">Best of ${t.length}</span>
      <span class="ts-side ts-ai"><b>${this._oppWins()}</b> RIVAL</span>
    </div>`;
  },

  // ---- number game ----
  _renderOnlineNumber(t) {
    const myNum = this._isHost() ? t.hostNum : t.guestNum;
    if (myNum != null) {
      const oppNum = this._isHost() ? t.guestNum : t.hostNum;
      this._set(`<div class="tourney-card">${this._onlineScoreHTML()}
        <div class="tourney-kicker">The Draw</div>
        <h1 class="tourney-h1">Number Game</h1>
        <p class="tourney-lead">You picked <b>${myNum}</b>. ${oppNum != null ? 'Rolling…' : 'Waiting for your opponent to pick…'}</p>
        ${t.roll != null ? `<div class="tn-roll">Rolled <b>${t.roll}</b></div>` : ''}
      </div>`);
      return;
    }
    const nums = Array.from({ length: 20 }, (_, i) => i + 1)
      .map(n => `<button class="tourney-num" onclick="Tournament.onlinePickNumber(${n})">${n}</button>`).join('');
    this._set(`<div class="tourney-card">${this._onlineScoreHTML()}
      <div class="tourney-kicker">The Draw</div>
      <h1 class="tourney-h1">Number Game</h1>
      <p class="tourney-lead">Secretly pick <b>1–20</b>. Closest to the roll wins first pick. Ties reroll.</p>
      <div class="tourney-numgrid">${nums}</div>
    </div>`);
  },
  onlinePickNumber(n) {
    if (this._isHost()) this._hostReceiveNumber('host', n);
    else if (typeof Multiplayer !== 'undefined') { Multiplayer.send({ t: 'tourneyNum', num: n }); }
    // optimistic: reflect our own pick immediately
    const t = this._t(); if (t) { if (this._isHost()) t.hostNum = n; else t.guestNum = n; this._onlineRender(); }
  },
  _hostReceiveNumber(who, n) {
    const t = this._t(); if (!t || t.phase !== 'number') return;
    if (who === 'host') t.hostNum = n; else t.guestNum = n;
    if (t.hostNum != null && t.guestNum != null) this._hostRollNumbers();
    Game._mpBroadcast(); this._onlineRender();
  },
  _hostRollNumbers() {
    const t = this._t();
    do { t.roll = 1 + Math.floor(Math.random() * 20); }
    while (Math.abs(t.hostNum - t.roll) === Math.abs(t.guestNum - t.roll));
    t.numberWinner = Math.abs(t.hostNum - t.roll) < Math.abs(t.guestNum - t.roll) ? 'host' : 'guest';
    t.phase = 'modifier';
    t.chooser = t.numberWinner;
    t.gameNumber = 1;
  },

  // ---- modifier pick ----
  _renderOnlineModifier(t) {
    const amChooser = t.chooser === this._mySide();
    const avail = this.MODIFIERS.filter(m => t.usedMods.indexOf(m.id) < 0);
    if (!amChooser) {
      this._set(`<div class="tourney-card">${this._onlineScoreHTML()}
        <div class="tourney-kicker">Game ${t.gameNumber}</div>
        <h1 class="tourney-h1">Rival is choosing…</h1>
        <p class="tourney-lead">${t.gameNumber === 1 ? 'They won the draw.' : 'They lost the last game.'} Waiting for their modifier + first/second pick.</p>
      </div>`);
      return;
    }
    const tiles = avail.map(m => `
      <button class="tourney-modtile" id="tomod-${m.id}" onclick="Tournament._onlineSelMod('${m.id}')">
        <span class="tmt-icon">${m.icon}</span><span class="tmt-name">${m.name}</span>
        <span class="tmt-desc">${m.desc}</span>
      </button>`).join('');
    const used = t.usedMods.map(id => { const m = this.MODIFIERS.find(x => x.id === id); return `<span class="tourney-usedchip">${m.icon} ${m.name}</span>`; }).join('');
    this._set(`<div class="tourney-card tourney-modpick">${this._onlineScoreHTML()}
      <div class="tourney-kicker">Game ${t.gameNumber} · Your pick</div>
      <h1 class="tourney-h1">Choose a Modifier</h1>
      <p class="tourney-lead">${t.gameNumber === 1 ? 'You won the draw.' : 'You lost the last game, so you choose.'} No modifier repeats.</p>
      ${used ? `<div class="tourney-used">Already played: ${used}</div>` : ''}
      <div class="tourney-modgrid">${tiles}</div>
      <div id="tourney-oorder" class="tourney-order" style="display:none"></div>
    </div>`);
  },
  _onlineSelMod(id) {
    this._oPendingMod = id;
    document.querySelectorAll('.tourney-modtile').forEach(b => b.classList.remove('sel'));
    const b = document.getElementById('tomod-' + id); if (b) b.classList.add('sel');
    const m = this.MODIFIERS.find(x => x.id === id);
    const o = document.getElementById('tourney-oorder');
    if (o) { o.style.display = ''; o.innerHTML =
      `<div class="tourney-order-q">Selected <b>${m.icon} ${m.name}</b> — go first or second?</div>
       <div class="tourney-order-btns">
         <button class="tourney-bigbtn" onclick="Tournament.onlinePickMod('${id}','first')">Go First</button>
         <button class="tourney-bigbtn" onclick="Tournament.onlinePickMod('${id}','second')">Go Second</button>
       </div>`; }
  },
  onlinePickMod(id, first) {
    if (this._isHost()) this._hostReceiveMod('host', id, first);
    else if (typeof Multiplayer !== 'undefined') Multiplayer.send({ t: 'tourneyMod', mod: id, first: first });
  },
  _hostReceiveMod(who, id, first) {
    const t = this._t(); if (!t || t.phase !== 'modifier' || who !== t.chooser) return;
    if (t.usedMods.indexOf(id) < 0) t.usedMods.push(id);
    t.currentMod = id;
    // Translate the chooser's first/second into which SIDE goes first.
    const chooserGoesFirst = (first === 'first');
    const chooserSide = t.chooser;   // 'host' | 'guest'
    t.firstPlayer = chooserGoesFirst ? chooserSide : (chooserSide === 'host' ? 'guest' : 'host');
    t.phase = 'playing';
    t._gameCounted = false;
    Game._mpBroadcast();
    this._onlineStartGame();
  },
  _onlineStartGame() {
    // Reuse the real online match: fresh draft + play, modifier injected from
    // state._tournament.currentMod inside startMultiplayerHost.
    Game.startMultiplayerHost({});
    // Honor first/second: round 1's first player = oddPlayer. Host='player'.
    const t = this._t();
    if (t && (t.firstPlayer === 'host' || t.firstPlayer === 'guest')) {
      Game.state.oddPlayer = (t.firstPlayer === 'host') ? 'player' : 'ai';
    }
    // Re-attach the series to the fresh match state so it keeps syncing.
    if (t) { Game.state._tournament = t; Game.state._tournament._gameCounted = false; }
    Game._mpBroadcast();
    this._onlineRender();
  },

  // ---- game end (host only) ----
  _hostOnGameEnd(winner) {
    const t = this._t(); if (!t || !t.online) return;
    // winner is 'player' (host) or 'ai' (guest).
    if (winner === 'player') t.hostWins++; else t.guestWins++;
    if (t.hostWins >= t.threshold || t.guestWins >= t.threshold) {
      t.phase = 'series-over';
    } else {
      t.gameNumber++;
      t.chooser = (winner === 'player') ? 'guest' : 'host';   // loser picks next
      t.currentMod = null; t.firstPlayer = null;
      t.phase = 'modifier';
    }
    Game._mpBroadcast();
    this._onlineRender();
  },

  _renderOnlineOver(t) {
    const won = this._myWins() > this._oppWins();
    this._set(`<div class="tourney-card tourney-final">
      <div class="tourney-kicker">Best of ${t.length} · Complete</div>
      <div class="tourney-trophy">${won ? '🏆' : '🥈'}</div>
      <h1 class="tourney-h1 ${won ? 'win' : 'lose'}">${won ? 'Series Won!' : 'Series Lost'}</h1>
      <p class="tourney-lead">Final: <b>You ${this._myWins()}</b> — <b>${this._oppWins()} Rival</b>.</p>
      <button class="tourney-bigbtn" onclick="Tournament.exit()">Main Menu</button>
    </div>`);
  },

  _showOnlineHud() {
    this._removeHud();
    const t = this._t(); if (!t) return;
    const mod = this.MODIFIERS.find(m => m.id === t.currentMod) || { icon: '🎴', name: 'Classic' };
    const hud = document.createElement('div');
    hud.id = 'tourney-hud'; hud.className = 'tourney-hud';
    hud.innerHTML = `
      <div class="th-head">🏆 TOURNAMENT</div>
      <div class="th-scoreline"><span class="th-name th-you">YOU</span>
        <span class="th-vs">${this._myWins()}–${this._oppWins()}</span>
        <span class="th-name th-ai">RIVAL</span></div>
      <div class="th-divider"></div>
      <div class="th-row"><span class="th-label">Game ${t.gameNumber}</span><span class="th-sub">Bo${t.length}</span></div>
      <div class="th-modrow"><span class="th-modicon">${mod.icon}</span><span class="th-modname">${mod.name}</span></div>`;
    document.body.appendChild(hud);
  },

  // ════════════════════════════════════════════════════════════════════════
  // ONLINE 2v2 TOURNAMENT  (team A = p1,p3 · team B = p2,p4 · captains p1 / p2)
  // Same host-authoritative pattern as 1v1: series lives in state._tournament
  // (synced via _2v2OnlineBroadcast), guests forward picks over Multiplayer4,
  // p1 is the authority. A team's number/modifier is chosen by its CAPTAIN
  // (p1 for A, p2 for B); an AI captain is auto-picked by the host.
  // ════════════════════════════════════════════════════════════════════════
  _2v2tt() { return (typeof Game !== 'undefined' && Game.state) ? Game.state.twoVTwo : null; },
  _2v2Me() { const tt = this._2v2tt(); return tt ? tt.you : null; },
  _2v2AmAuth() { return this._2v2Me() === 'p1'; },
  _2v2MyTeam() { const tt = this._2v2tt(), me = this._2v2Me(); return (tt && me && tt.players[me]) ? tt.players[me].team : null; },
  _2v2CaptainSeat(team) { return team === 'A' ? 'p1' : 'p2'; },
  _2v2TeamOfSeat(pk) { const tt = this._2v2tt(); return (tt && tt.players[pk]) ? tt.players[pk].team : null; },
  _2v2IAmCaptain() { const me = this._2v2Me(), team = this._2v2MyTeam(); return me && team && me === this._2v2CaptainSeat(team); },
  _2v2MyWins() { const t = this._t(); const team = this._2v2MyTeam(); return t ? (team === 'A' ? t.aWins : t.bWins) : 0; },
  _2v2OppWins() { const t = this._t(); const team = this._2v2MyTeam(); return t ? (team === 'A' ? t.bWins : t.aWins) : 0; },

  // Host: seats are all filled — build the series and start the number game.
  _2v2HostBegin() {
    const cfg = this._online; if (!cfg) return;
    Game.state._tournament = {
      online: true, mode: '2v2',
      length: cfg.length, threshold: cfg.threshold,
      aWins: 0, bWins: 0, phase: 'number', gameNumber: 1,
      aNum: null, bNum: null, roll: null, numberWinner: null,
      usedMods: [], currentMod: null, firstTeam: null, chooser: null,
    };
    this._2v2MaybeAutoNumber();
    Game._2v2OnlineBroadcast();
    this._2v2OnlineRender();
  },

  _2v2OnlineRender() {
    const t = this._t();
    if (!t || !t.online || t.mode !== '2v2') { this._hideOverlay && this._hideOverlay(); return; }
    this._ensureOverlay();
    if (t.phase === 'playing' && !Game.state.gameOver) { this._hideOverlay(); this._show2v2Hud(); return; }
    this._removeHud();
    this._showOverlay();
    if (t.phase === 'number')      return this._render2v2Number(t);
    if (t.phase === 'modifier')    return this._render2v2Modifier(t);
    if (t.phase === 'series-over') return this._render2v2Over(t);
  },

  _2v2ScoreHTML() {
    const t = this._t(); if (!t) return '';
    return `<div class="tourney-score">
      <span class="ts-side ts-you">YOUR TEAM <b>${this._2v2MyWins()}</b></span>
      <span class="ts-vs">Best of ${t.length}</span>
      <span class="ts-side ts-ai"><b>${this._2v2OppWins()}</b> RIVALS</span>
    </div>`;
  },

  // ---- number game ----
  _render2v2Number(t) {
    const myTeam = this._2v2MyTeam();
    const myNum = myTeam === 'A' ? t.aNum : t.bNum;
    if (!this._2v2IAmCaptain()) {
      this._set(`<div class="tourney-card">${this._2v2ScoreHTML()}
        <div class="tourney-kicker">The Draw</div><h1 class="tourney-h1">Number Game</h1>
        <p class="tourney-lead">Your team captain is picking a number for the draw…</p></div>`);
      return;
    }
    if (myNum != null) {
      this._set(`<div class="tourney-card">${this._2v2ScoreHTML()}
        <div class="tourney-kicker">The Draw</div><h1 class="tourney-h1">Number Game</h1>
        <p class="tourney-lead">You picked <b>${myNum}</b>. Waiting for the other captain…</p></div>`);
      return;
    }
    const nums = Array.from({ length: 20 }, (_, i) => i + 1)
      .map(n => `<button class="tourney-num" onclick="Tournament._2v2PickNumber(${n})">${n}</button>`).join('');
    this._set(`<div class="tourney-card">${this._2v2ScoreHTML()}
      <div class="tourney-kicker">The Draw · You are captain</div><h1 class="tourney-h1">Number Game</h1>
      <p class="tourney-lead">Pick <b>1–20</b> for your team. Closest to the roll wins first pick. Ties reroll.</p>
      <div class="tourney-numgrid">${nums}</div></div>`);
  },
  _2v2PickNumber(n) {
    const team = this._2v2MyTeam();
    if (this._2v2AmAuth()) this._2v2HostReceiveNumber(this._2v2Me(), n);
    else if (typeof Multiplayer4 !== 'undefined') Multiplayer4.send({ t: 'tourneyNum', playerKey: this._2v2Me(), num: n });
    const t = this._t(); if (t) { if (team === 'A') t.aNum = n; else t.bNum = n; this._2v2OnlineRender(); }
  },
  _2v2HostReceiveNumber(pk, n) {
    const t = this._t(); if (!t || t.phase !== 'number') return;
    const team = this._2v2TeamOfSeat(pk); if (team === 'A') t.aNum = n; else if (team === 'B') t.bNum = n; else return;
    this._2v2MaybeAutoNumber();
    if (t.aNum != null && t.bNum != null) this._2v2HostRoll();
    Game._2v2OnlineBroadcast(); this._2v2OnlineRender();
  },
  // Host auto-picks for any AI captain.
  _2v2MaybeAutoNumber() {
    const t = this._t(); const tt = this._2v2tt(); if (!t || !tt) return;
    if (t.aNum == null && tt.players.p1 && tt.players.p1.isAI) t.aNum = 1 + Math.floor(Math.random() * 20);
    if (t.bNum == null && tt.players.p2 && tt.players.p2.isAI) t.bNum = 1 + Math.floor(Math.random() * 20);
  },
  _2v2HostRoll() {
    const t = this._t();
    do { t.roll = 1 + Math.floor(Math.random() * 20); }
    while (Math.abs(t.aNum - t.roll) === Math.abs(t.bNum - t.roll));
    t.numberWinner = Math.abs(t.aNum - t.roll) < Math.abs(t.bNum - t.roll) ? 'A' : 'B';
    t.phase = 'modifier'; t.chooser = t.numberWinner; t.gameNumber = 1;
    this._2v2MaybeAutoMod();
  },

  // ---- modifier pick ----
  _render2v2Modifier(t) {
    const amChooserCaptain = this._2v2IAmCaptain() && this._2v2MyTeam() === t.chooser;
    const chooserIsMyTeam = this._2v2MyTeam() === t.chooser;
    if (!amChooserCaptain) {
      this._set(`<div class="tourney-card">${this._2v2ScoreHTML()}
        <div class="tourney-kicker">Game ${t.gameNumber}</div>
        <h1 class="tourney-h1">${chooserIsMyTeam ? 'Your captain is choosing…' : 'Rivals are choosing…'}</h1>
        <p class="tourney-lead">Team ${t.chooser} ${t.gameNumber === 1 ? 'won the draw' : 'lost the last game'} — they pick the modifier.</p></div>`);
      return;
    }
    const avail = this.MODIFIERS.filter(m => t.usedMods.indexOf(m.id) < 0);
    const tiles = avail.map(m => `<button class="tourney-modtile" id="t2mod-${m.id}" onclick="Tournament._2v2SelMod('${m.id}')">
        <span class="tmt-icon">${m.icon}</span><span class="tmt-name">${m.name}</span><span class="tmt-desc">${m.desc}</span></button>`).join('');
    const used = t.usedMods.map(id => { const m = this.MODIFIERS.find(x => x.id === id); return `<span class="tourney-usedchip">${m.icon} ${m.name}</span>`; }).join('');
    this._set(`<div class="tourney-card tourney-modpick">${this._2v2ScoreHTML()}
      <div class="tourney-kicker">Game ${t.gameNumber} · You choose for Team ${t.chooser}</div>
      <h1 class="tourney-h1">Choose a Modifier</h1>
      <p class="tourney-lead">No modifier repeats in the series.</p>
      ${used ? `<div class="tourney-used">Already played: ${used}</div>` : ''}
      <div class="tourney-modgrid">${tiles}</div></div>`);
  },
  _2v2SelMod(id) {
    document.querySelectorAll('.tourney-modtile').forEach(b => b.classList.remove('sel'));
    const b = document.getElementById('t2mod-' + id); if (b) b.classList.add('sel');
    this._2v2PickMod(id);
  },
  _2v2PickMod(id) {
    if (this._2v2AmAuth()) this._2v2HostReceiveMod(this._2v2Me(), id);
    else if (typeof Multiplayer4 !== 'undefined') Multiplayer4.send({ t: 'tourneyMod', playerKey: this._2v2Me(), mod: id });
  },
  _2v2HostReceiveMod(pk, id) {
    const t = this._t(); if (!t || t.phase !== 'modifier') return;
    if (this._2v2TeamOfSeat(pk) !== t.chooser) return;   // only the chooser team's captain
    if (t.usedMods.indexOf(id) < 0) t.usedMods.push(id);
    t.currentMod = id; t.phase = 'playing'; t._gameCounted = false;
    // Apply the modifier to the CURRENT match state (mode._mods rides the sync).
    if (Game.state.mode) Game.state.mode._mods = (id && id !== 'classic') ? { [id]: true } : null;
    Game._2v2OnlineBroadcast();
    // Start the game: first game drafts from the lobby, later games rematch.
    if (t.gameNumber === 1 && !t._started) { t._started = true; Game._2v2StartDraft(); }
    else Game._2v2Rematch();
  },
  // Host auto-picks a modifier when the chooser team's captain is an AI.
  _2v2MaybeAutoMod() {
    const t = this._t(); const tt = this._2v2tt(); if (!t || !tt || t.phase !== 'modifier') return;
    const cap = this._2v2CaptainSeat(t.chooser);
    if (tt.players[cap] && tt.players[cap].isAI) {
      const avail = this.MODIFIERS.filter(m => t.usedMods.indexOf(m.id) < 0);
      const pick = avail[Math.floor(Math.random() * avail.length)];
      if (pick) this._2v2HostReceiveMod(cap, pick.id);
    }
  },

  // ---- game end (host only) ----
  _2v2HostOnGameEnd(winnerTeam) {
    const t = this._t(); if (!t || !t.online) return;
    if (winnerTeam === 'A') t.aWins++; else t.bWins++;
    if (t.aWins >= t.threshold || t.bWins >= t.threshold) { t.phase = 'series-over'; }
    else {
      t.gameNumber++;
      t.chooser = (winnerTeam === 'A') ? 'B' : 'A';   // losing team picks next
      t.currentMod = null;
      t.phase = 'modifier';
      this._2v2MaybeAutoMod();
    }
    Game._2v2OnlineBroadcast();
    this._2v2OnlineRender();
  },

  _render2v2Over(t) {
    const won = this._2v2MyWins() > this._2v2OppWins();
    this._set(`<div class="tourney-card tourney-final">
      <div class="tourney-kicker">Best of ${t.length} · Complete</div>
      <div class="tourney-trophy">${won ? '🏆' : '🥈'}</div>
      <h1 class="tourney-h1 ${won ? 'win' : 'lose'}">${won ? 'Series Won!' : 'Series Lost'}</h1>
      <p class="tourney-lead">Final: <b>Your team ${this._2v2MyWins()}</b> — <b>${this._2v2OppWins()} Rivals</b>.</p>
      <button class="tourney-bigbtn" onclick="Tournament.exit()">Main Menu</button></div>`);
  },

  _show2v2Hud() {
    this._removeHud();
    const t = this._t(); if (!t) return;
    const mod = this.MODIFIERS.find(m => m.id === t.currentMod) || { icon: '🎴', name: 'Classic' };
    const hud = document.createElement('div');
    hud.id = 'tourney-hud'; hud.className = 'tourney-hud';
    hud.innerHTML = `<div class="th-head">🏆 TEAM SERIES</div>
      <div class="th-scoreline"><span class="th-name th-you">YOU</span>
        <span class="th-vs">${this._2v2MyWins()}–${this._2v2OppWins()}</span>
        <span class="th-name th-ai">RIVALS</span></div>
      <div class="th-divider"></div>
      <div class="th-row"><span class="th-label">Game ${t.gameNumber}</span><span class="th-sub">Bo${t.length}</span></div>
      <div class="th-modrow"><span class="th-modicon">${mod.icon}</span><span class="th-modname">${mod.name}</span></div>`;
    document.body.appendChild(hud);
  },
};
