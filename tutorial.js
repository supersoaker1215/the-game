// tutorial.js — v3
// Scripted in-game tutorial. Loaded after ui.js so UI/Game are available.

const Tutorial = {
  active: false,
  stepIdx: -1,
  _lastPlayedLane: -1,
  _overlay: null,
  _callout: null,
  _backdrop: null,
  _prevTarget: null,
  _minimized: false,

  // ── STEPS ──────────────────────────────────────────────────────────────
  steps: [
    {
      id: 'welcome',
      title: 'Welcome to Card Lane Battle!',
      text: 'This short walkthrough teaches you the basics with a real game. Follow the prompts — you\'ll know how to play in just a few minutes.',
      target: null, full: true, type: 'next',
    },
    {
      id: 'board',
      title: 'The Battlefield',
      text: 'Six <strong>lanes</strong> make up the board. Your cards sit in the <em>bottom row</em>, the AI\'s in the <em>top row</em>. Cards in the same lane fight each other head-to-head. An <strong>empty lane</strong> lets an uncontested card attack the enemy\'s HP directly.',
      target: '#board', pos: 'top', type: 'next',
    },
    {
      id: 'player-hp',
      title: 'Your HP',
      text: 'You start with <strong>30 HP</strong>. When enemy cards attack into empty lanes — or tricks deal direct damage — your HP drops here. Hit 0 and you lose.',
      target: '.player-bar .bar-hp', pos: 'top', type: 'next',
    },
    {
      id: 'block-meter',
      title: 'The Block Meter',
      text: 'Right next to your HP is the <strong>Block Meter</strong>. Every time you take damage, it fills up.<br><br>When it reaches <strong>8/8</strong> — the next incoming hit is <em>completely blocked</em> and you draw a <strong>free Trick card</strong>. Then it resets to 0.<br><br>A perfectly timed block can completely swing a round.',
      target: '.player-bar .bar-block', pos: 'top', type: 'next',
    },
    {
      id: 'ai-hp',
      title: "The Enemy's HP",
      text: 'The AI also starts at <strong>30 HP</strong>. Drain it to 0 and you win. Keep both bars in mind as you decide which lanes to contest.',
      target: '.ai-bar .bar-hp', pos: 'bottom', type: 'next',
    },
    {
      id: 'energy',
      title: 'Energy',
      text: 'You spend <strong>Energy</strong> to play cards and tricks. Each round you gain Energy equal to the round number — Round 1 → 1, Round 2 → 2, etc. We gave you a head start for this tutorial.',
      target: '#player-energy-display', pos: 'top', type: 'next',
    },
    {
      id: 'hand',
      title: 'Your Hand',
      text: 'These are your two cards for this tutorial. Click a card to select it, then click a lane to place it there.',
      target: '.player-hand-section', pos: 'top', type: 'next',
    },
    {
      id: 'read-card',
      title: 'Reading a Card — Gamora',
      text: 'This is <strong>Gamora</strong>.<br><br>🔢 <strong>Top-left number</strong> — Energy cost to play her (2).<br>🟢 <strong>Green box (bottom-left)</strong> = Attack — damage dealt in combat (2).<br>🔴 <strong>Red box (bottom-right)</strong> = Health — how much damage she can take (3).<br><br>She also has an ability: on play she <em>destroys any enemy at 2 HP or less</em>, and gains +1/+1 each time she gets a kill.',
      target: '.player-hand-section .hand-card-wrapper:first-child', pos: 'top', type: 'next',
    },
    {
      id: 'read-keyword',
      title: 'Keywords — The Thing',
      text: 'This is <strong>The Thing</strong>. See the <span class="tut-kw-demo">Armor 2</span> chip under his name?<br><br><strong>Armor N</strong> subtracts N from every incoming attack. A 3-ATK hit only deals 1 damage to him. Hover any keyword chip in-game for a full tooltip.',
      target: '.player-hand-section .hand-card-wrapper:last-child', pos: 'top', type: 'next',
    },
    {
      id: 'ai-card',
      title: 'The AI Already Has a Card',
      text: '<strong>Gorilla Grodd</strong> (2 ATK / 3 HP) is pre-placed in Lane 1. Nobody is blocking him — when combat fires, he\'ll deal <strong>2 damage directly to your HP</strong>.<br><br>Placing one of your cards in Lane 1 would block him, but leaving him open is fine for now.',
      target: '#board', pos: 'top', type: 'next',
    },
    {
      id: 'play-card',
      title: 'Play a Card!',
      text: '🎯 <strong>Click one of your cards</strong> to select it, then <strong>click any lane</strong> to place it.<br><br>Try Lane 3 or 4 so your card attacks the AI\'s HP freely — or challenge Gorilla Grodd in Lane 1!',
      target: '.player-hand-section', pos: 'top', type: 'wait', waitEvent: 'card-played',
    },
    {
      id: 'card-in-lane',
      title: 'Card is on the Board!',
      text: 'Your card is in the lane. Notice the <strong>health number</strong> on the card — every point of combat damage reduces it. When it hits 0, the card dies and goes to your dead pile.',
      target: null, pos: 'top', type: 'next',
    },
    {
      id: 'end-cards',
      title: 'End the Cards Phase',
      text: 'You can keep playing cards while you have Energy, or click <strong>Done</strong> to move on. The AI will take its turn, then you\'ll reach the Tricks phase.',
      target: '#btn-action', pos: 'top', type: 'wait', waitEvent: 'phase-tricks',
    },
    {
      id: 'tricks',
      title: 'Tricks',
      text: 'Tricks are <strong>instant, one-use effects</strong> — damage, buffs, healing, control. They\'re gone once used, so spend them wisely.<br><br>You have <em>Vibranium</em> in your trick hand: +1/+1 to all allies. Play it or click <strong>Done</strong> to skip to combat.',
      target: '#player-tricks', pos: 'top', type: 'wait', waitEvent: 'post-combat',
    },
    {
      id: 'done',
      title: "You're Ready to Play!",
      text: 'You now know the core loop:<br><br><strong>Play cards → Use tricks → Fight in combat → Protect your HP and build the Block Meter</strong><br><br>Start a real match from the main menu. Good luck!',
      target: null, full: true, type: 'finish',
    },
  ],

  // ── LAUNCH ─────────────────────────────────────────────────────────────
  start() {
    this.active = true;
    this.stepIdx = -1;
    this._lastPlayedLane = -1;
    this._prevTarget = null;
    this._minimized = false;
    this._launchGame();
    this._buildOverlay();
    this.advance(0);
  },

  _launchGame() {
    if (typeof Game === 'undefined') return;

    // Reset to clean state, then override for tutorial
    Game.init();
    const s = Game.state;
    s.phase        = 'player-cards';
    s.round        = 1;
    s.isTutorial   = true;
    s.firstPlayer  = 'player';
    s.activePlayer = 'player';
    s.oddPlayer    = 'player';
    s.player.isHuman = true;
    s.ai.isHuman     = false;
    s.player.currency = 6;
    s.ai.currency     = 0;

    // Player hand: Gamora (vanilla) + The Thing (Armor 2)
    const defs = typeof CARD_DEFS !== 'undefined' ? CARD_DEFS : [];
    const inst = (name) => {
      const d = defs.find(c => c.name === name);
      return d ? Game.createCardInstance(d, 'player') : null;
    };
    s.player.hand = [inst('Gamora'), inst('The Thing')].filter(Boolean);

    // Player trick: Vibranium (+1/+1 to all allies)
    const trickDefs = typeof TRICK_DEFS !== 'undefined' ? TRICK_DEFS : [];
    const vibranium = trickDefs.find(t => t.name === 'Vibranium');
    s.player.trickHand = vibranium ? [Object.assign({}, vibranium)] : [];

    // AI card pre-placed in lane 0 — will hit player face if unblocked
    const groodDef = defs.find(c => c.name === 'Gorilla Grodd');
    if (groodDef) s.lanes[0].ai = Game.createCardInstance(groodDef, 'ai');

    // Empty draw piles — tutorial is a single round
    s.drawPile      = [];
    s.trickDrawPile = [];
    if (!s._stats) {
      s._stats = {
        player: { blockTriggers: 0, peakRoundDamage: 0, cardsKilled: 0, energySpent: 0 },
        ai:     { blockTriggers: 0, peakRoundDamage: 0, cardsKilled: 0, energySpent: 0 },
      };
    }
    if (!s._roundStats) {
      s._roundStats = { round: 1, playerDamageDealt: 0, playerDamageTaken: 0, aiDamageDealt: 0, aiDamageTaken: 0, playerKills: [], aiKills: [], playerTricks: [], aiTricks: [] };
    }

    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },

  // ── OVERLAY ────────────────────────────────────────────────────────────
  _buildOverlay() {
    const old = document.getElementById('tut-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'tut-overlay';
    overlay.className = 'tut-overlay';

    const backdrop = document.createElement('div');
    backdrop.className = 'tut-backdrop';
    overlay.appendChild(backdrop);
    this._backdrop = backdrop;

    const callout = document.createElement('div');
    callout.className = 'tut-callout';
    callout.innerHTML = `
      <div class="tut-callout-header">
        <span class="tut-callout-icon">🎮</span>
        <span class="tut-callout-title"></span>
        <button class="tut-btn-minimize" title="Minimize" onclick="Tutorial.toggleMinimize()">−</button>
      </div>
      <div class="tut-callout-body"></div>
      <div class="tut-callout-footer">
        <span class="tut-callout-counter"></span>
        <div class="tut-callout-btns">
          <button class="tut-btn-skip" onclick="Tutorial.complete()">Skip</button>
          <button class="tut-btn-next"></button>
        </div>
      </div>
    `;
    overlay.appendChild(callout);
    this._callout = callout;
    document.body.appendChild(overlay);
    this._overlay = overlay;
  },

  // ── STEP RENDER ────────────────────────────────────────────────────────
  advance(idx) {
    if (idx >= this.steps.length) { this.complete(); return; }
    this.stepIdx = idx;
    const step = this.steps[idx];

    // Clear previous highlight
    if (this._prevTarget) {
      this._prevTarget.classList.remove('tut-target-highlight');
      this._prevTarget = null;
    }

    // Populate content
    const c = this._callout;
    c.querySelector('.tut-callout-title').textContent = step.title;
    c.querySelector('.tut-callout-body').innerHTML = step.text;
    c.querySelector('.tut-callout-counter').textContent = `${idx + 1} / ${this.steps.length}`;

    const nextBtn = c.querySelector('.tut-btn-next');
    if (step.type === 'next') {
      nextBtn.textContent = 'Next →';
      nextBtn.onclick = () => this.next();
      nextBtn.style.display = '';
    } else if (step.type === 'finish') {
      nextBtn.textContent = 'Start Playing →';
      nextBtn.onclick = () => this.complete();
      nextBtn.style.display = '';
    } else {
      // 'wait' — advances automatically when the matching game event fires
      nextBtn.style.display = 'none';
    }

    // Resolve target element
    let targetEl = null;
    if (step.id === 'card-in-lane' && this._lastPlayedLane >= 0) {
      const laneEls = document.querySelectorAll('.board .lane');
      const laneEl  = laneEls[this._lastPlayedLane];
      if (laneEl) targetEl = laneEl.querySelector('.player-card') || laneEl;
    } else if (step.target) {
      targetEl = document.querySelector(step.target);
    }

    // Auto-minimize on steps that need free player interaction; auto-expand otherwise
    const shouldMinimize = step.type === 'wait';
    if (shouldMinimize !== this._minimized) this.toggleMinimize();

    const isFull = step.full || !targetEl;
    this._overlay.classList.toggle('tut-full', !!step.full);

    if (targetEl) {
      targetEl.classList.add('tut-target-highlight');
      this._prevTarget = targetEl;
      this._positionNear(targetEl, step.pos || 'bottom');
    } else {
      this._positionCenter();
    }
  },

  next() { this.advance(this.stepIdx + 1); },

  toggleMinimize() {
    this._minimized = !this._minimized;
    const c = this._callout;
    if (!c) return;
    c.classList.toggle('tut-minimized', this._minimized);
    const btn = c.querySelector('.tut-btn-minimize');
    if (btn) btn.textContent = this._minimized ? '+' : '−';
  },

  // ── POSITIONING ────────────────────────────────────────────────────────
  _positionNear(el, pref) {
    const c   = this._callout;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const CW = Math.min(340, vw - 32), GAP = 14, CH = 240;
    c.style.width = CW + 'px';
    c.style.transform = '';

    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;

    const tryPos = (side) => {
      if (side === 'bottom') {
        const t = rect.bottom + GAP, l = Math.max(GAP, Math.min(cx - CW/2, vw - CW - GAP));
        return (t + CH < vh) ? { t, l } : null;
      }
      if (side === 'top') {
        const t = rect.top - CH - GAP, l = Math.max(GAP, Math.min(cx - CW/2, vw - CW - GAP));
        return (t > GAP) ? { t, l } : null;
      }
      if (side === 'right') {
        const l = rect.right + GAP, t = Math.max(GAP, Math.min(cy - CH/2, vh - CH - GAP));
        return (l + CW < vw) ? { t, l } : null;
      }
      if (side === 'left') {
        const l = rect.left - CW - GAP, t = Math.max(GAP, Math.min(cy - CH/2, vh - CH - GAP));
        return (l > GAP) ? { t, l } : null;
      }
      return null;
    };

    let pos = null;
    for (const s of [pref, 'bottom', 'top', 'right', 'left']) {
      pos = tryPos(s);
      if (pos) break;
    }
    if (!pos) pos = { t: GAP, l: GAP };

    c.style.position = 'fixed';
    c.style.top  = pos.t + 'px';
    c.style.left = pos.l + 'px';
  },

  _positionCenter() {
    const c = this._callout;
    c.style.position  = 'fixed';
    c.style.width     = Math.min(400, window.innerWidth - 32) + 'px';
    c.style.top       = '50%';
    c.style.left      = '50%';
    c.style.transform = 'translate(-50%, -50%)';
  },

  // ── GAME HOOKS ─────────────────────────────────────────────────────────
  // Called from game.js after specific game events fire.
  notify(event, data) {
    if (!this.active) return;
    const step = this.steps[this.stepIdx];
    if (!step || step.type !== 'wait') return;
    if (step.waitEvent === event) {
      if (event === 'card-played' && data && typeof data.laneIdx === 'number') {
        this._lastPlayedLane = data.laneIdx;
      }
      // Wait one animation frame so the board re-renders before repositioning
      requestAnimationFrame(() => this.next());
    }
  },

  // ── COMPLETION ─────────────────────────────────────────────────────────
  complete() {
    this.active   = false;
    this.stepIdx  = -1;

    document.querySelectorAll('.tut-target-highlight')
      .forEach(el => el.classList.remove('tut-target-highlight'));

    const ol = document.getElementById('tut-overlay');
    if (ol) ol.remove();
    this._overlay = this._callout = this._backdrop = this._prevTarget = null;

    // Return to main menu
    if (typeof Game !== 'undefined') Game.init();
    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },
};
