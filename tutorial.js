// tutorial.js — v8
// Fully scripted, on-rails WHOLE GAME tutorial. The player plays a real match
// on the real engine — real cards, real combat, real draw/phase machinery — but
// the opponent is scripted to be harmless and the player's board out-scales it,
// so the match is a guaranteed win by Round 3. Both sides start at 15 HP so the
// game is short. Every mechanic is explained as it happens, and the player gets
// to slam down two marquee cards — GODZILLA and THE HULK — for the payoff.
//
// HOW IT DRIVES A REAL GAME WITHOUT FIGHTING THE ENGINE
//   • The player is FIRST every round (firstPlayerForRound is pinned to
//     'player'), so each round runs: player-cards → (Done) → AI cards+tricks →
//     player-tricks → (Done) → combat → draw → next round. That is the real
//     phase chain in game.js; we don't reimplement it.
//   • The AI's DECISIONS are overridden (AI.playCards / playTrickPhaseCards /
//     playTricks) to place a fixed, weak script for the current round and then
//     call their onComplete — so the round chain flows exactly as normal.
//   • Round energy + the per-round AI script are set in a thin wrapper around
//     Game.startRound; the real startRound still runs, we just top up energy.
//   • The round summary crossfade and the game-over screen are stubbed while the
//     tutorial is active so pacing stays in our hands and our own callouts show.
// All overrides are saved and restored in complete().

const Tutorial = {
  active: false,
  stepIdx: -1,
  _lastPlayedLane: -1,
  _overlay: null,
  _callout: null,
  _backdrop: null,
  _prevTarget: null,
  _minimized: false,
  _saved: null,     // originals of every monkey-patched method
  _round: 1,
  _vib: null,

  // ── THE SCRIPTED OPPONENT ───────────────────────────────────────────────
  // What the AI places each round, by round number. Lanes are high (5) so they
  // never sit in the low lanes the player is guided into. Every entry becomes a
  // pure stat-stick (all ability hooks nulled, all keyword flags zeroed) via
  // _vanillaAI, so combat is 100% predictable.
  //   Round 1: nothing — the pre-placed Gorilla Grodd is the only threat.
  //   Round 2: one weak 1/2 that chips a single point of face damage.
  //   Round 3: nothing — the player closes it out.
  AI_SCRIPT: {
    1: [],
    2: [{ name: 'Hawkeye', atk: 1, hp: 2, lane: 5 }],
    3: [],
  },

  // ── STEPS ───────────────────────────────────────────────────────────────
  // type: 'next'   → player clicks "Next" to advance
  //       'wait'   → advances automatically when waitEvent fires from the game
  //       'finish' → last step, closes the tutorial
  steps: [
    // ═══════════════ INTRO & THE SCREEN ═══════════════
    {
      id: 'welcome', title: 'Welcome to The Game!',
      text: 'You\'re about to play a <strong>full match</strong> from start to finish — and you\'re going to <strong>win it</strong>. I\'ll explain <em>everything</em> as it comes up, and by the end you\'ll get to slam down some huge cards.<br><br>Both sides start at <strong>15 HP</strong> so it plays fast. Take your time and read each tip. Ready?',
      target: null, full: true, type: 'next',
    },
    {
      id: 'board', title: 'The Battlefield',
      text: 'The board is <strong>six lanes</strong> (columns). <em>Your</em> cards sit in the bottom row; the <em>enemy\'s</em> in the top row.<br><br>Two cards in the <strong>same lane fight each other</strong>, head-to-head. A card alone in a lane is <strong>uncontested</strong> — with nothing blocking it, it hits the enemy\'s HP directly. That distinction is the heart of the whole game.',
      target: '#board', pos: 'top', type: 'next',
    },
    {
      id: 'player-hp', title: 'Your HP — 15',
      text: 'This is your health. It drops when enemy cards attack into <strong>empty lanes</strong> in front of you, or when certain tricks hit you directly.<br><br>If it reaches <strong>0, you lose</strong>. So never leave a big enemy threat sitting uncontested for long.',
      target: '.player-bar .bar-hp', pos: 'top', type: 'next',
    },
    {
      id: 'block-meter', title: 'The Block Meter',
      text: 'Right beside your HP is the <strong>Block Meter</strong> (0–8). Each time you take damage it <strong>fills up a bit</strong>.<br><br>The moment it reaches <strong>8/8</strong>, that hit is <strong>completely blocked</strong> (you take 0 damage), you <strong>draw a free Trick card</strong>, and the meter <strong>resets to 0</strong>. It\'s a comeback mechanic that rewards taking hits. We\'ll trigger a real one this game so you can watch it happen.',
      target: '.player-bar .bar-block', pos: 'top', type: 'next',
    },
    {
      id: 'ai-hp', title: "The Enemy's HP — 15",
      text: 'Same idea for the AI. Drain this number to <strong>0 and you win the match</strong>.<br><br>Your entire plan: get your cards into empty lanes where nothing blocks them, and pound this number down faster than they can hurt you.',
      target: '.ai-bar .bar-hp', pos: 'bottom', type: 'next',
    },
    {
      id: 'energy', title: 'Energy',
      text: 'You spend <strong>Energy</strong> to play cards and tricks — it\'s shown here and it <strong>refreshes every round</strong>.<br><br>Normally you get Energy equal to the round number (Round 1 → 1, Round 2 → 2, and so on), so your plays get bigger as the game goes. For this walkthrough we\'ve handed you <strong>bonus Energy</strong> so you can play freely and try the fun stuff.',
      target: '#player-energy-display', pos: 'top', type: 'next',
    },
    // ═══════════════ READING CARDS ═══════════════
    {
      id: 'hand', title: 'Your Hand',
      text: 'These are the cards you\'re holding. To play one: <strong>click the card</strong> to select it, then <strong>click a lane</strong> to place it there.<br><br>Let\'s learn how to read a card before you play.',
      target: '.player-hand-section', pos: 'top', type: 'next',
    },
    {
      id: 'read-card', title: 'Anatomy of a Card — Gamora',
      text: 'This is <strong>Gamora</strong>. Every card shows four things:<br><br>🔢 <strong>Top-left</strong> = <strong>Energy cost</strong> to play her (2).<br>🟢 <strong>Green (bottom-left)</strong> = <strong>Attack</strong> — damage she deals in combat (2).<br>🔴 <strong>Red (bottom-right)</strong> = <strong>Health</strong> — how much damage she can survive (3).<br><br>People shorthand this as her <strong>“2/3”</strong> (Attack/Health).',
      target: '.player-hand-section .hand-card-wrapper:first-child', pos: 'top', type: 'next',
    },
    {
      id: 'read-ability', title: 'Card Text & Abilities',
      text: 'The line of text on a card is its <strong>ability</strong>. Watch for the trigger words:<br><br>• <strong>When Played</strong> — fires once, the moment you drop it.<br>• <strong>While Active</strong> — a passive that\'s always on while it\'s alive.<br>• <strong>Start of Tricks / When Damaged / On Kill</strong> — fires at those moments.<br><br>Gamora\'s: <em>When Played, destroy an enemy with 2 HP or less; and she gains +1/+1 whenever she kills something.</em>',
      target: '.player-hand-section .hand-card-wrapper:first-child', pos: 'top', type: 'next',
    },
    {
      id: 'read-keyword', title: 'Keywords — Armor',
      text: 'This is <strong>The Thing</strong>. See the <span class="tut-kw-demo">Armor 2</span> chip under his name? That\'s a <strong>keyword</strong> — a reusable rule.<br><br><strong>Armor N</strong> subtracts N from <em>every</em> incoming attack. A 2-ATK hit does <strong>0</strong> damage to him. That makes him an amazing blocker — remember him next round.<br><br>In a real game, <em>hover any keyword chip</em> for its full explanation.',
      target: '.player-hand-section .hand-card-wrapper:last-child', pos: 'top', type: 'next',
    },
    {
      id: 'ai-card', title: 'The Enemy Already Has a Card',
      text: '<strong>Gorilla Grodd</strong> (a 2/3) is sitting in <strong>Lane 1</strong> with nothing in front of him. When combat fires, that uncontested attacker will hit <strong>your HP for 2</strong>.<br><br>You could block him now — but this round let\'s learn to <em>attack</em>. We\'ll shut him down next round.',
      target: '#board', pos: 'top', type: 'next',
    },
    // ═══════════════ ROUND 1 — PLAY & COMBAT ═══════════════
    {
      id: 'play-card', title: 'Play Gamora into an Empty Lane',
      text: '🎯 Click <strong>Gamora</strong>, then click any <strong>empty lane</strong> (try <strong>Lane 3</strong>).<br><br>Alone in an empty lane she\'s uncontested — in combat she\'ll strike the enemy\'s HP directly for her 2 Attack.',
      target: '.player-hand-section', pos: 'top', type: 'wait', waitEvent: 'card-played',
    },
    {
      id: 'card-in-lane', title: 'She\'s on the Board — and Bigger!',
      text: 'Wait — Gamora is now a <strong>3/4</strong>, not the 2/3 you read in your hand. 🐺 That\'s <strong>Lone Wolf</strong>: <em>the first card you play while your side of the board is empty gets a permanent <strong>+1/+1</strong></em>. It rewards leading with a card, and it happens for <em>any</em> card played alone — not just Gamora.<br><br>Also note her <strong>Health number</strong>: combat damage lowers it, and at <strong>0 the card dies</strong> and goes to your <strong>Dead Pile</strong>. In an empty lane nothing hits her back, so she survives and keeps attacking.',
      target: null, pos: 'top', type: 'next',
    },
    {
      id: 'end-cards-1', title: 'The Action Button',
      text: 'You could keep playing cards while you have Energy — but let\'s move on. The big button at the bottom advances the game; it changes label to match your phase. Right now it reads <strong>“End Cards”</strong>.<br><br>🎯 Press <strong>End Cards</strong> to finish placing cards. The AI will take its turn, then you\'ll reach your Tricks phase.',
      target: '#btn-action', pos: 'top', type: 'wait', waitEvent: 'phase-tricks',
    },
    {
      id: 'round-structure', title: 'How a Round is Structured',
      text: 'Every round has <strong>three phases</strong>, then combat:<br><br><strong>①</strong> First player places <em>cards</em>.<br><strong>②</strong> Second player places <em>cards AND tricks</em> — so they get to react.<br><strong>③</strong> First player plays <em>tricks</em>.<br><br>Then <strong>Combat</strong> resolves every lane. Who goes first <em>alternates</em> each round. You went first, so you\'re now in <strong>your Tricks phase (③)</strong> — the button now reads <strong>“End Tricks”</strong>.',
      target: '#player-tricks', pos: 'top', type: 'next',
    },
    {
      id: 'tricks-none-1', title: 'No Trick Yet — End Tricks',
      text: 'Tricks are one-use effect cards (we\'ll get one next round). You have none right now.<br><br>🎯 Press <strong>End Tricks</strong> to finish your Tricks phase and trigger <strong>Combat</strong>. Watch the HP bars.',
      target: '#btn-action', pos: 'top', type: 'wait', waitEvent: 'post-combat',
    },
    {
      id: 'after-combat-1', title: 'Combat Resolved',
      text: 'Here\'s what just happened, lane by lane:<br><br>• Gamora was uncontested → the enemy took <strong>2</strong> (they\'re down to ~13).<br>• Grodd was uncontested → <strong>you</strong> took 2 (~13), and your <strong>Block Meter ticked up</strong>.<br><br>Then the <strong>Draw phase</strong> ran automatically: both players drew a card. Let\'s see what you got.',
      target: null, pos: 'top', type: 'next',
    },
    // ═══════════════ ROUND 2 — BLOCK, KEYWORDS, TRICKS ═══════════════
    {
      id: 'round2-intro', title: 'Round 2 — Draw & Refresh',
      text: 'A new round began: your <strong>Energy refreshed</strong> (with our bonus), and you <strong>drew a fresh card</strong> — a monster this time. 🦖<br><br>This round you\'ll learn <strong>blocking</strong>, a couple of new <strong>keywords</strong>, and <strong>tricks</strong>. First, let\'s deal with Grodd.',
      target: '#board', pos: 'top', type: 'next',
    },
    {
      id: 'play-block', title: 'Block Grodd with The Thing',
      text: '🎯 Play <strong>The Thing</strong> into <strong>Lane 1</strong> — the <em>same</em> lane as Grodd.<br><br>Now they\'re contesting each other. Grodd\'s 2 ATK vs The Thing\'s <span class="tut-kw-demo">Armor 2</span> = <strong>0</strong> damage taken, while The Thing\'s 3 ATK <strong>kills</strong> Grodd (3 HP). A perfect trade.',
      target: '.player-hand-section', pos: 'top', type: 'wait', waitEvent: 'card-played',
    },
    {
      id: 'after-block', title: 'That\'s a Block',
      text: 'The Thing is now standing in Grodd\'s lane. When combat fires they\'ll swing at each other — Grodd bounces off the Armor, and The Thing caves him in.<br><br>A card that trades up like this, or simply soaks a hit so it doesn\'t reach your HP, is <strong>blocking</strong>. Now let\'s bring the pain.',
      target: null, pos: 'top', type: 'next',
    },
    {
      id: 'play-godzilla', title: 'Unleash GODZILLA 🦖',
      text: 'Your drawn card is <strong>Godzilla</strong> — a huge <strong>5/8</strong> body.<br><br>🎯 Play him into an <strong>empty lane</strong> (try <strong>Lane 4</strong>) so he\'s uncontested and hammers the enemy\'s HP directly.',
      target: '.player-hand-section', pos: 'top', type: 'wait', waitEvent: 'card-played',
    },
    {
      id: 'godzilla-keywords', title: 'Godzilla\'s Kit — Burning',
      text: 'Godzilla\'s <strong>When Played</strong> ability just hit <em>every enemy card</em> with <span class="tut-kw-demo">Burning 3</span>.<br><br><strong>Burning N</strong> is damage-over-time: a burned card loses health at the start of each round until it wears off. Combined with his 5 Attack straight to the enemy\'s face, he\'s a wrecking ball.',
      target: null, pos: 'top', type: 'next',
    },
    {
      id: 'end-cards-2', title: 'Pass to the AI',
      text: '🎯 Press <strong>End Cards</strong>. Because you went first, the AI now takes phase ② (its cards + tricks). Then you\'ll get phase ③ — <strong>your Tricks phase</strong>, where a surprise is waiting.',
      target: '#btn-action', pos: 'top', type: 'wait', waitEvent: 'phase-tricks',
    },
    {
      id: 'tricks-explain', title: 'Tricks — Vibranium',
      text: 'You drew a <strong>Trick</strong>: instant, one-use effects (buffs, damage, healing, control). Tricks live in a separate <strong>trick hand</strong> and are gone once used.<br><br><strong>Vibranium</strong> gives <em>+1/+1 to ALL your allies</em> on the board.<br><br>To play a trick you <strong>drag it onto the board</strong> — or just tap the button below.<br><button class="tut-play-btn" onclick="Tutorial.playStepTrick(\'Vibranium\')">▶ Play Vibranium</button>',
      target: '#player-tricks', pos: 'top', type: 'wait', waitEvent: 'trick-played', pin: 'corner',
    },
    {
      id: 'after-vibranium', title: 'Whole Board, Buffed',
      text: 'Every card you own just gained <strong>+1/+1</strong> — The Thing, Godzilla, and Gamora are all bigger now. Buffing your board right before combat is one of the strongest things a trick can do.<br><br>🎯 Press <strong>End Tricks</strong> to finish your tricks and fire <strong>Combat</strong>.',
      target: '#btn-action', pos: 'top', type: 'wait', waitEvent: 'post-combat',
    },
    {
      id: 'after-combat-2', title: 'A Blowout Round',
      text: 'Look at everything that landed:<br><br>• The Thing <strong>killed Grodd</strong> and took 0 back (Armor) — that card is now in the enemy\'s <strong>dead pile</strong>.<br>• Godzilla + Gamora, both buffed and uncontested, tore the enemy\'s HP down hard.<br>• Their weak card tried to chip you — but it pushed your <strong>Block Meter to 8/8</strong>, so it <strong>triggered</strong>: that hit was <em>fully blocked</em> (you took 0!) and the meter reset to 0. In a normal match a block also hands you a free trick to play. That\'s the Block Meter paying off.<br><br>You also drew your <strong>final</strong> card. It\'s a big one.',
      target: '.player-bar .bar-block', pos: 'top', type: 'next',
    },
    // ═══════════════ ROUND 3 — THE FINISH ═══════════════
    {
      id: 'round3-intro', title: 'Round 3 — Close It Out',
      text: 'The enemy is nearly dead and your board dominates. Grodd is gone, so <strong>The Thing is uncontested now too</strong> — literally everything you own is pointed at their HP.<br><br>Time for the knockout. 👊',
      target: '.ai-bar .bar-hp', pos: 'bottom', type: 'next',
    },
    {
      id: 'play-hulk', title: 'Smash with THE HULK 💚',
      text: 'Your last card is <strong>Hulk</strong>. His <strong>When Played</strong>: <em>deal 2 damage to ALL enemies</em>, and he swings for a big hit on top.<br><br>🎯 Play <strong>Hulk</strong> into any <strong>empty lane</strong>. Your uncontested attackers now add up to <strong>far more</strong> than the enemy has left.',
      target: '.player-hand-section', pos: 'top', type: 'wait', waitEvent: 'card-played',
    },
    {
      id: 'end-cards-3', title: 'Finish the Match',
      text: 'That\'s overwhelming force. 🎯 Press <strong>End Cards</strong> to pass, then <strong>End Tricks</strong> through your Tricks phase to trigger the final combat.<br><br>Watch the enemy\'s HP hit <strong>zero</strong>.',
      target: '#btn-action', pos: 'top', type: 'wait', waitEvent: 'post-combat',
    },
    // ═══════════════ VICTORY ═══════════════
    {
      id: 'done', title: '🏆 You Win!',
      text: 'That\'s a complete match. You just learned the entire loop:<br><br><strong>Read cards → play into lanes → block threats & attack empty lanes → buff with tricks → win combat → protect your HP and build your Block Meter.</strong><br><br>Real matches add a <strong>draft</strong> to build your deck, deeper decks, and dozens more keywords and combos — but it\'s all this same rhythm. Now go win one for real!',
      target: null, full: true, type: 'finish',
    },
  ],

  // ── LAUNCH ────────────────────────────────────────────────────────────────
  start() {
    this.active = true;
    this.stepIdx = -1;
    this._lastPlayedLane = -1;
    this._prevTarget = null;
    this._minimized = false;
    this._round = 1;
    this._finished = false;
    this._installHooks();
    this._setupGame();
    this._buildOverlay();
    this.advance(0);
  },

  // ── MONKEY-PATCHES (saved + restored) ──────────────────────────────────────
  _installHooks() {
    const T = this;
    this._saved = {
      firstPlayerForRound: Game.firstPlayerForRound,
      startRound:          Game.startRound,
      playTrick:           Game.playTrick,
      damagePlayer:        Game.damagePlayer,
      aiPlayCards:          (typeof AI !== 'undefined') ? AI.playCards : null,
      aiPlayTrickPhase:     (typeof AI !== 'undefined') ? AI.playTrickPhaseCards : null,
      aiPlayTricks:         (typeof AI !== 'undefined') ? AI.playTricks : null,
      showRoundSummary:    (typeof UI !== 'undefined') ? UI.showRoundSummary : null,
      showGameOverScreen:  (typeof UI !== 'undefined') ? UI.showGameOverScreen : null,
    };

    // Player is ALWAYS first — keeps the phase order fixed and predictable.
    Game.firstPlayerForRound = function () { return 'player'; };

    // Real round setup runs; we just top up energy and load the round's AI
    // script afterward. (Draw already happened before startRound is called.)
    Game.startRound = function () {
      const ret = T._saved.startRound.apply(this, arguments);
      T._afterStartRound();
      return ret;
    };

    // GUARANTEE the match reaches Round 3. Combat damage varies (the Block
    // Meter absorbs a random d3 per hit on both sides), so the AI could drop to
    // 0 in Round 2 and end the game before the player gets to play their big
    // finisher. Floor the AI at 1 HP through Rounds 1–2 by capping any damage
    // dealt to it; Round 3 lifts the cap so the kill lands. This also lets R2
    // combat fully resolve, so the enemy's chip hit reliably fires the player's
    // Block Meter demonstration.
    Game.damagePlayer = function (owner, amount, isBullseye, source) {
      if (T.active && owner === 'ai' && (this.state.round || 1) < 3) {
        const floor = 1;
        const cur = this.state.ai.health;
        amount = Math.max(0, Math.min(amount, cur - floor));
      }
      return T._saved.damagePlayer.call(this, owner, amount, isBullseye, source);
    };

    // Fire a 'trick-played' event so a step can wait on the player using a trick.
    Game.playTrick = function (owner, trick) {
      const ok = T._saved.playTrick.apply(this, arguments);
      if (ok && owner === 'player' && T.active) T.notify('trick-played', { trick });
      return ok;
    };

    // The scripted opponent. playCards places this round's cards; the other two
    // just pass through. Each is async-shaped (owner, onComplete) exactly like
    // the real AI methods so the endPhase chain is unchanged.
    if (typeof AI !== 'undefined') {
      AI.playCards = function (owner, onComplete) {
        try { T._applyAIScript(); } catch (e) { console.error('[tutorial AI]', e); }
        if (onComplete) onComplete();
      };
      AI.playTrickPhaseCards = function (owner, onComplete) { if (onComplete) onComplete(); };
      AI.playTricks         = function (owner, onComplete) { if (onComplete) onComplete(); };
    }

    // Keep the round-summary crossfade and the real game-over screen out of the
    // way — our own callouts narrate both. Setting showRoundSummary falsy makes
    // postCombat take the simple, immediate proceed() path. The game-over stub
    // is ALSO how we reliably reach the victory step: the killing blow flows
    // through damagePlayer's immediate game-over hook, which bypasses postCombat
    // (so the 'post-combat' notify never fires on the winning round). Catching
    // the game-over here instead jumps straight to the finish callout.
    if (typeof UI !== 'undefined') {
      UI.showRoundSummary   = null;
      UI.showGameOverScreen = function (winner) { T._onGameOver(winner); };
    }
  },

  // Fired when the engine ends the match. Jump to the finish step once.
  _onGameOver() {
    if (!this.active || this._finished) return;
    this._finished = true;
    const doneIdx = this.steps.findIndex(s => s.type === 'finish');
    if (doneIdx >= 0) this.advance(doneIdx);
  },

  _restoreHooks() {
    const s = this._saved;
    if (!s) return;
    Game.firstPlayerForRound = s.firstPlayerForRound;
    Game.startRound          = s.startRound;
    Game.playTrick           = s.playTrick;
    Game.damagePlayer        = s.damagePlayer;
    if (typeof AI !== 'undefined') {
      if (s.aiPlayCards)      AI.playCards          = s.aiPlayCards;
      if (s.aiPlayTrickPhase) AI.playTrickPhaseCards = s.aiPlayTrickPhase;
      if (s.aiPlayTricks)     AI.playTricks         = s.aiPlayTricks;
    }
    if (typeof UI !== 'undefined') {
      UI.showRoundSummary   = s.showRoundSummary;
      UI.showGameOverScreen = s.showGameOverScreen;
    }
    this._saved = null;
  },

  // ── GAME SETUP ─────────────────────────────────────────────────────────────
  _cardInst(name, owner) {
    const defs = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS : [];
    const d = defs.find(c => c.name === name);
    if (!d) return null;
    // createCardInstance already runs applyAbilities internally.
    return Game.createCardInstance(d, owner);
  },

  // Turn any card into a harmless stat-stick for the scripted AI: null every
  // ability hook and zero every keyword flag so combat is fully predictable.
  _vanillaAI(name, atk, hp, owner) {
    const c = this._cardInst(name, owner) || Game.createCardInstance({ name, cost: 1, attack: atk, health: hp, type: 'villain', abilities: [] }, owner);
    ['onPlay','onDeath','onDamaged','onKill','onBeforeTricks','onBeforeAttack',
     'onEndOfTurn','onAnyCardPlayed','onAllyKilled','onEvade','onTurnStart','onDiscard']
      .forEach(h => { c[h] = null; });
    c.abilities = [];
    c.evadeCharges = 0; c.armorValue = 0; c.splashRange = 0; c.tauntTurns = 0;
    c.isBullseye = false; c.isOverdrive = false; c.passive = null;
    if (atk != null) { c.attack = atk; c.baseAttack = atk; }
    if (hp != null)  { c.currentHealth = hp; c.maxHealth = hp; c.baseHealth = hp; }
    return c;
  },

  _setupGame() {
    if (typeof Game === 'undefined') return;
    Game.init();
    const s = Game.state;
    s.mode        = { players: '1v1', deck: 'classic' };
    s.phase       = 'player-cards';
    s.round       = 1;
    s.isTutorial  = true;
    s.firstPlayer = 'player';
    s.activePlayer = 'player';
    s.oddPlayer   = 'player';
    s.player.isHuman = true;
    s.ai.isHuman     = false;

    // 15 HP both sides.
    s.player.health = s.player.maxHealth = 15;
    s.ai.health     = s.ai.maxHealth     = 15;

    // Generous Energy so the guided plays always fit.
    s.player.currency = 6;
    s.ai.currency     = 0;

    // Opening hand: Gamora (read a card) + The Thing (read a keyword / blocker).
    s.player.hand = [this._cardInst('Gamora', 'player'), this._cardInst('The Thing', 'player')].filter(Boolean);
    s.player.trickHand = [];

    // Pre-placed enemy threat: a vanilla Gorilla Grodd, uncontested in Lane 1.
    const grodd = this._vanillaAI('Gorilla Grodd', 2, 3, 'ai');
    if (grodd) s.lanes[0].ai = grodd;

    // Decks are seeded so the player's draws are deterministic. drawCards pops
    // from the END of the pile, and each Draw phase the PLAYER draws before the
    // AI — so the last element is the player's Round-2 card, and so on. The
    // player draws the two marquee cards they get to slam down: Godzilla (R2)
    // then Hulk (R3). Both are big AoE bodies with NO targeting prompt, so the
    // scripted combat stays fully predictable.
    //   pop order: Godzilla(→P R2), filler(→AI), Hulk(→P R3), filler(→AI)
    const defs = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS : [];
    const def = (n) => defs.find(c => c.name === n);
    const FILLER = def('Hawkeye');            // harmless AI draws
    s.drawPile = [FILLER, FILLER, def('Hulk'), FILLER, def('Godzilla')].filter(Boolean);
    // Vibranium is handed straight to the trick hand in Round 2 (see
    // _afterStartRound). The shared trick DRAW pile is kept EMPTY on purpose: a
    // Block-Meter trigger pulls from it and pops a mid-combat "play free or keep"
    // modal, which the tutorial doesn't script around — an empty pile means the
    // block still fires (blocks the hit, resets) with no interrupting modal.
    const vib = (typeof TRICK_DEFS !== 'undefined') ? TRICK_DEFS.find(t => t.name === 'Vibranium') : null;
    s.trickDrawPile = [];
    this._vib = vib;

    // Stats scaffolding the engine expects to exist.
    if (!s._stats) s._stats = {
      player: { blockTriggers: 0, peakRoundDamage: 0, cardsKilled: 0, energySpent: 0 },
      ai:     { blockTriggers: 0, peakRoundDamage: 0, cardsKilled: 0, energySpent: 0 },
    };
    if (!s._roundStats) s._roundStats = { round: 1, playerDamageDealt: 0, playerDamageTaken: 0, aiDamageDealt: 0, aiDamageTaken: 0, playerKills: [], aiKills: [], playerTricks: [], aiTricks: [] };

    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },

  // Runs right after the real startRound for rounds 2+. Top up Energy, hand the
  // player their scripted trick, demo the block meter, and mark the new round.
  _afterStartRound() {
    const s = Game.state;
    this._round = s.round;
    // Generous Energy from Round 2 on so the player can afford the big marquee
    // cards (Godzilla cost 7, Hulk cost 6) plus a trick.
    s.player.currency = 12;
    s.ai.currency     = 0;

    if (s.round === 2) {
      // Give Vibranium for the tricks lesson.
      if (this._vib && !s.player.trickHand.some(t => t.name === 'Vibranium')) {
        s.player.trickHand.push(Object.assign({}, this._vib));
      }
      // Prime the Block Meter to 7 so the enemy's chip hit this round pushes it
      // over 8 and triggers a live block (the fill is a d3 roll per hit, so 7 +
      // any roll clears the bar). The trick draw pile is empty (see _setupGame),
      // so the block fires cleanly — hit blocked, meter reset — with no modal.
      s.player.blockMeter = 7;
    }
    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },

  // The overridden AI.playCards calls this once per round to place the script.
  _applyAIScript() {
    const round = Game.state.round;
    const script = this.AI_SCRIPT[round] || [];
    script.forEach(entry => {
      const lane = Game.state.lanes[entry.lane];
      if (!lane || lane.ai) return;              // don't stomp an occupied lane
      const c = this._vanillaAI(entry.name, entry.atk, entry.hp, 'ai');
      if (c) lane.ai = c;
    });
    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },

  // ── OVERLAY ────────────────────────────────────────────────────────────────
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

    // A big pulsing arrow that points from the callout at whatever it's
    // describing, so there's no doubt what "this" refers to.
    const arrow = document.createElement('div');
    arrow.className = 'tut-arrow';
    arrow.style.display = 'none';
    overlay.appendChild(arrow);
    this._arrow = arrow;

    document.body.appendChild(overlay);
    this._overlay = overlay;
  },

  // Point the arrow at `el` from the side the callout is sitting on.
  _placeArrow(el, side) {
    const A = this._arrow;
    if (!A || !el) return;
    const r = el.getBoundingClientRect();
    const glyph = { bottom: '▲', top: '▼', right: '◀', left: '▶' }[side] || '▲';
    A.textContent = glyph;
    A.style.display = 'block';
    const SZ = 30;
    let x, y;
    if (side === 'bottom')      { x = r.left + r.width / 2 - SZ / 2; y = r.bottom + 4; }
    else if (side === 'top')    { x = r.left + r.width / 2 - SZ / 2; y = r.top - SZ - 4; }
    else if (side === 'right')  { x = r.right + 4;                    y = r.top + r.height / 2 - SZ / 2; }
    else                        { x = r.left - SZ - 4;                y = r.top + r.height / 2 - SZ / 2; }
    A.style.left = Math.max(2, x) + 'px';
    A.style.top  = Math.max(2, y) + 'px';
  },
  _hideArrow() { if (this._arrow) this._arrow.style.display = 'none'; },

  // ── STEP RENDER ──────────────────────────────────────────────────────────
  advance(idx) {
    if (!this.active || !this._callout) return;
    if (idx >= this.steps.length) { this.complete(); return; }
    this.stepIdx = idx;
    const step = this.steps[idx];

    if (this._prevTarget) {
      this._prevTarget.classList.remove('tut-target-highlight');
      this._prevTarget = null;
    }

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
      nextBtn.style.display = 'none';   // 'wait' — driven by game events
    }

    // Resolve target element.
    let targetEl = null;
    if (step.id === 'card-in-lane' && this._lastPlayedLane >= 0) {
      const laneEls = document.querySelectorAll('.board .lane');
      const laneEl  = laneEls[this._lastPlayedLane];
      if (laneEl) targetEl = laneEl.querySelector('.player-card') || laneEl;
    } else if (step.target) {
      targetEl = document.querySelector(step.target);
    }

    if (this._minimized) this.toggleMinimize();

    this._overlay.classList.toggle('tut-full', !!step.full);

    if (this._minimized) {
      this._positionCorner();
      this._hideArrow();
    } else if (step.type === 'wait') {
      // Interaction step — the player must reach the board / hand / button, so
      // the callout MUST NOT cover them. Pin it to the bottom-right corner
      // (clear of the board and the centered hand + action button) and point
      // the arrow at whatever they need to touch.
      if (targetEl) { targetEl.classList.add('tut-target-highlight'); this._prevTarget = targetEl; }
      this._positionCornerBR();
      if (targetEl) this._placeArrow(targetEl, 'top'); else this._hideArrow();
    } else if (targetEl) {
      targetEl.classList.add('tut-target-highlight');
      this._prevTarget = targetEl;
      const side = this._positionNear(targetEl, step.pos || 'bottom');
      this._placeArrow(targetEl, side);
    } else {
      this._positionCenter();
      this._hideArrow();
    }
  },

  // Play a named trick from the tutorial callout button — the reliable path when
  // drag-to-play is fiddly. Our wrapped Game.playTrick fires 'trick-played',
  // which advances the waiting step; if it can't be played, advance anyway so
  // the tutorial can never dead-end on this screen.
  playStepTrick(name) {
    const s = Game.state;
    const t = (s.player.trickHand || []).find(x => x.name === name);
    if (!t) { this.next(); return; }
    let ok = false;
    try { ok = Game.playTrick('player', t); } catch (e) { console.error('[tutorial trick]', e); }
    if (!ok) this.next();
  },

  next() { this.advance(this.stepIdx + 1); },

  toggleMinimize() {
    this._minimized = !this._minimized;
    const c = this._callout;
    if (!c) return;
    c.classList.toggle('tut-minimized', this._minimized);
    const btn = c.querySelector('.tut-btn-minimize');
    if (btn) btn.textContent = this._minimized ? '+' : '−';
    this._hideArrow();
    if (this._minimized) this._positionCorner();
    else this._positionCenter();
  },

  // ── POSITIONING ────────────────────────────────────────────────────────────
  _positionCorner() {
    const c = this._callout;
    const vw = window.innerWidth;
    const GAP = 14;
    const CW = Math.min(340, vw - 32);
    c.style.position  = 'fixed';
    c.style.width     = CW + 'px';
    c.style.top       = GAP + 'px';
    c.style.bottom    = 'auto';
    c.style.left      = (vw - CW - GAP) + 'px';
    c.style.transform = '';
  },

  // Bottom-right corner — used for every interaction step so the callout stays
  // clear of the board and the centered hand + action button.
  _positionCornerBR() {
    const c = this._callout;
    const vw = window.innerWidth, vh = window.innerHeight;
    const GAP = 14;
    const CW = Math.min(330, vw - 32);
    c.style.position  = 'fixed';
    c.style.width     = CW + 'px';
    c.style.left      = (vw - CW - GAP) + 'px';
    c.style.top       = 'auto';
    c.style.bottom    = GAP + 'px';
    c.style.transform = '';
  },

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

    let pos = null, chosen = 'bottom';
    for (const side of [pref, 'bottom', 'top', 'right', 'left']) {
      pos = tryPos(side);
      if (pos) { chosen = side; break; }
    }
    if (!pos) { pos = { t: GAP, l: GAP }; chosen = pref || 'bottom'; }

    c.style.position = 'fixed';
    c.style.top  = pos.t + 'px';
    c.style.bottom = 'auto';
    c.style.left = pos.l + 'px';
    return chosen;   // the side the callout landed on, so the arrow can point back
  },

  _positionCenter() {
    const c = this._callout;
    c.style.position  = 'fixed';
    c.style.width     = Math.min(400, window.innerWidth - 32) + 'px';
    c.style.top       = '50%';
    c.style.bottom    = 'auto';
    c.style.left      = '50%';
    c.style.transform = 'translate(-50%, -50%)';
  },

  // ── GAME HOOKS ─────────────────────────────────────────────────────────────
  // Called from game.js (card-played, phase-tricks, post-combat) and from our
  // playTrick wrapper (trick-played). Advances a 'wait' step when its event
  // fires. A card-played step only advances on a PLAYER card.
  notify(event, data) {
    if (!this.active) return;
    const step = this.steps[this.stepIdx];
    if (!step || step.type !== 'wait') return;
    if (step.waitEvent !== event) return;
    if (event === 'card-played') {
      if (data && data.card && data.card.owner && data.card.owner !== 'player') return;
      if (data && typeof data.laneIdx === 'number') this._lastPlayedLane = data.laneIdx;
    }
    this.next();
  },

  // ── COMPLETION ─────────────────────────────────────────────────────────────
  complete() {
    this.active  = false;
    this.stepIdx = -1;

    this._restoreHooks();

    document.querySelectorAll('.tut-target-highlight')
      .forEach(el => el.classList.remove('tut-target-highlight'));

    const ol = document.getElementById('tut-overlay');
    if (ol) ol.remove();
    this._overlay = this._callout = this._backdrop = this._prevTarget = null;

    if (typeof Game !== 'undefined') Game.init();
    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },
};
