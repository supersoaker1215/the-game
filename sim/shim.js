// JSC shim — stubs UI/document/setTimeout and loads the game files.
// Run under: /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc

// ---- polyfill a console that delegates to print() ----
if (typeof console === 'undefined') {
  this.console = {
    log: function () {
      var args = Array.prototype.slice.call(arguments);
      print(args.map(function (a) { return (typeof a === 'object' ? JSON.stringify(a) : String(a)); }).join(' '));
    },
    error: function () {
      var args = Array.prototype.slice.call(arguments);
      print('[ERR] ' + args.map(function (a) { return (typeof a === 'object' ? JSON.stringify(a) : String(a)); }).join(' '));
    },
    warn: function () {
      var args = Array.prototype.slice.call(arguments);
      print('[WARN] ' + args.map(function (a) { return (typeof a === 'object' ? JSON.stringify(a) : String(a)); }).join(' '));
    },
    info: function () { this.log.apply(this, arguments); },
  };
}

// ---- synchronous setTimeout / setInterval so the game's paced flow collapses ----
this.setTimeout = function (fn) { if (typeof fn === 'function') { try { fn(); } catch (e) { console.error('[sim:setTimeout]', e.message || e); } } return 0; };
this.clearTimeout = function () {};
this.setInterval = function () { return 0; };
this.clearInterval = function () {};

// ---- DOM stub ----
function __simEl() {
  return {
    style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, removeEventListener: function () {},
    appendChild: function () {}, removeChild: function () {}, insertBefore: function () {},
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    getAttribute: function () { return null; }, setAttribute: function () {},
    cloneNode: function () { return __simEl(); },
    focus: function () {}, click: function () {},
    innerHTML: '', textContent: '',
    offsetWidth: 0, offsetHeight: 0,
    getBoundingClientRect: function () { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    children: [],
  };
}
// Explicit flag for game code to detect headless sim — shim stubs both
// `window` and `document`, so typeof checks don't separate the two.
this.__HEADLESS_SIM = true;
this.document = {
  getElementById: function () { return __simEl(); },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  createElement: function () { return __simEl(); },
  createTextNode: function (t) { return { nodeValue: t }; },
  addEventListener: function () {}, removeEventListener: function () {},
  body: __simEl(), documentElement: __simEl(),
};

// ---- UI stub ----
// Note: `showRoundSummary` is INTENTIONALLY omitted. postCombat() reads
// `typeof UI !== 'undefined' && UI.showRoundSummary` and takes the sync
// branch when false — which is what we want. If we defined it, the game
// calls `Promise.resolve(UI.showRoundSummary(data)).then(proceed)` and
// `proceed` parks in the microtask queue, which doesn't drain inside our
// synchronous game loop.
this.UI = {
  render: function () {},
  startPromptCountdown: function () {}, stopPromptCountdown: function () {},
  draftEl: { style: { display: '' } },
  settings: { roundRecap: false, aiSpeed: 'fast', difficulty: 'normal', aiPacing: 'instant' },
  renderGameArea: function () {}, renderHand: function () {}, renderDraft: function () {}, updateLog: function () {},
};

// ---- `window` alias ----
this.window = this;

// ---- load game files in canonical order ----
var __SIM_ROOT = (typeof __SIM_ROOT_OVERRIDE === 'string') ? __SIM_ROOT_OVERRIDE : '.';
// engine/combat.js loads BEFORE game.js so Game._snapForPredict /
// Game._canSwingForward (now thin forwarders) find CombatEngine on
// global scope. Mirrors the index.html script-tag order.
var __SIM_FILES = ['engine/util.js', 'cards.js', 'tricks.js', 'abilities.js', 'engine/combat.js', 'decks.js', 'game.js', 'ai.js'];
for (var __i = 0; __i < __SIM_FILES.length; __i++) {
  load(__SIM_ROOT + '/' + __SIM_FILES[__i]);
}

// ---- post-load patches: auto-resolve sticky prompts and route player-side prompts synchronously ----
(function () {
  // 1. Card/lane prompts → sync auto-pick for BOTH sides (player seat is also AI-driven).
  //    After the callback fires, call resumeCombatIfWaiting — the real UI click-handlers
  //    do this and without it `whenPromptCleared` continuations never fire, so combat
  //    can hang after an onPlay prompt that was parked via `state._combatContinuation`.
  Game.promptCardChoice = function (owner, cards, title, desc, callback, aiPicker) {
    if (!cards || !cards.length) return;
    // Use aiPicker if provided; else pick uniformly at random. The earlier
    // `cards[0]` default systematically biased 'player'-owned prompts
    // toward the front of the list, creating silent seat bias in the sim.
    var pick;
    if (aiPicker) {
      pick = aiPicker(cards);
    } else {
      pick = cards[Math.floor(Math.random() * cards.length)];
    }
    try { callback(pick); } catch (e) { console.error('[sim:promptCard]', e.message || e); }
    Game.resumeCombatIfWaiting();
  };
  Game.promptLaneChoice = function (owner, lanes, title, desc, callback) {
    if (!lanes || !lanes.length) return;
    // Random pick — matches the `const to = open[Math.floor(Math.random()*open.length)]`
    // pattern the real abilities use for AI-owned cards. Previously picking
    // lanes[0] biased 'player'-owned effects toward the left side of the board.
    var pick = lanes[Math.floor(Math.random() * lanes.length)];
    try { callback(pick); } catch (e) { console.error('[sim:promptLane]', e.message || e); }
    Game.resumeCombatIfWaiting();
  };

  // 2. Sticky prompts set directly on state (pendingKangChoice, stolenByBWL, pendingBlockTrick,
  //    and direct pendingCardChoice/pendingLaneChoice from Grinch / Lasso of Truth / etc.)
  //    — drain them inside hasPendingPrompt so combat continuations never park.
  //
  //    A drained callback can CHAIN a new prompt (e.g. "pick target" → "pick amount"),
  //    so we loop until the state is clean, then return false. Without the loop,
  //    `whenPromptCleared(fn)` sees `false`, fires fn, and the chained prompt gets
  //    ignored until the next tick — by which time the combat lane has already advanced.
  Game.hasPendingPrompt = function () {
    var s = Game.state;
    if (!s) return false;

    for (var iter = 0; iter < 50; iter++) {
      var madeProgress = false;

      if (s.pendingBlockTrick) {
        var trick = s.pendingBlockTrick; s.pendingBlockTrick = null;
        if (Game.getAllCardsOf('player').length && trick.play) {
          s.player.playedTrickPile.push({ name: trick.name, cost: trick.cost });
          try { trick.play(Game, 'player'); } catch (e) { console.error('[sim:blockTrick]', e.message || e); }
        } else {
          Game.addToTrickHand('player', trick);
        }
        madeProgress = true;
      }

      if (s.pendingKangChoice) {
        var kc = s.pendingKangChoice; s.pendingKangChoice = null;
        var idx = (kc.cards[0].cost >= kc.cards[1].cost) ? 0 : 1;
        var other = kc.cards[1 - idx];
        s.drawPile.push(other);
        var c = Game.createCardInstance(kc.cards[idx], kc.owner);
        c.cost = Math.max(0, c.cost - 2);
        Game.addToHand(kc.owner, c);
        if (c.cost <= 2) {
          var open = Game.getOpenLanes(kc.owner);
          if (open.length && !c.isDiscardEffect) Game.playCardFree(kc.owner, c, open[0]);
        }
        madeProgress = true;
      }

      if (s.player && s.player.stolenByBWL) {
        var data = s.player.stolenByBWL; s.player.stolenByBWL = null;
        if ((data.card.baseCost || data.card.cost || 0) >= 4) {
          Game.addToHand('player', data.card);
        } else if (data.bwl) {
          data.bwl.attack += 2; data.bwl.currentHealth += 2; data.bwl.maxHealth += 2;
        }
        madeProgress = true;
      }
      if (s.ai && s.ai.stolenByBWL) {
        s.ai.stolenByBWL = null;
        madeProgress = true;
      }

      if (s.pendingCardChoice) {
        var pc = s.pendingCardChoice; s.pendingCardChoice = null;
        var pick = (pc.cards && pc.cards.length) ? pc.cards[0] : null;
        if (pick && pc.callback) { try { pc.callback(pick); } catch (e) { console.error('[sim:pc]', e.message || e); } }
        madeProgress = true;
      }
      if (s.pendingLaneChoice) {
        var pl = s.pendingLaneChoice; s.pendingLaneChoice = null;
        var lpick = (pl.lanes && pl.lanes.length) ? pl.lanes[0] : -1;
        if (lpick >= 0 && pl.callback) { try { pl.callback(lpick); } catch (e) { console.error('[sim:pl]', e.message || e); } }
        madeProgress = true;
      }

      if (!madeProgress) break;
      // A drained callback may have cleared the last prompt the combat loop was
      // parked on — fire any stored continuation now. Safe to call when empty.
      Game.resumeCombatIfWaiting();
    }

    return false;
  };

  // ai.js is now owner-parameterized: AI.playCards(owner), AI.playTricks(owner),
  // AI.chooseLane(card, owner), AI.evalTrick(trick, owner), etc. The ancient
  // *As mirrors are kept ONLY as thin aliases for any code that still calls
  // them. New callers should use the owner-parameterized form directly.
  AI.playCardsAs            = function (owner)        { return AI.playCards(owner); };
  AI.playTricksAs           = function (owner)        { return AI.playTricks(owner); };
  AI.playTrickPhaseCardsAs  = function (owner)        { return AI.playTrickPhaseCards(owner); };
  AI.chooseLaneAs           = function (owner, card)  { return AI.chooseLane(card, owner); };
  AI.evalTrickAs            = function (owner, trick) { return AI.evalTrick(trick, owner); };
  AI.planDefensiveBlocksAs  = function (owner, hand, budget) { return AI.planDefensiveBlocks(hand, budget, owner); };
  AI.enemyHasTaunterOf      = function (owner)        { return AI.opponentHasTaunter(owner); };
  AI.unblockedIncomingFor   = function (owner)        { return AI.unblockedIncoming(owner); };
})();

// ---- shared game driver — used by run.js and tune.js ----
// Supports per-seat weights so the CEM tuner can pit a challenger against a champion.
// `weightsP` / `weightsA` default to `AI.WEIGHTS` if null. Swaps `AI.WEIGHTS` around
// each seat's turn; all parameterized reads (threatScore, blockFitScore, evalTrick,
// pickDraftCard, etc.) go through `this.WEIGHTS` so the swap is sufficient.
this.SIM_MAX_ROUNDS = 40;
this.runSimGame = function (weightsP, weightsA, collect) {
  var savedW = AI.WEIGHTS;
  var wP = weightsP || savedW;
  var wA = weightsA || savedW;
  function withP(fn) { AI.WEIGHTS = wP; try { fn(); } finally { AI.WEIGHTS = savedW; } }
  function withA(fn) { AI.WEIGHTS = wA; try { fn(); } finally { AI.WEIGHTS = savedW; } }

  Game.init();
  // Force both seats to AI-controlled in sim. Game.init() defaults player
  // to isHuman=true (for browser single-player); headless sim wants both
  // seats running the AI branch of every ability so the two sides are
  // symmetric for balance measurement.
  Game.state.player.isHuman = false;
  Game.state.ai.isHuman = false;
  var simMode = (typeof this !== 'undefined' && this.SIM_MODE) || 'classic';
  Game.startMatch(simMode);
  if (collect) collect.onGameStart(Game.state);

  // Drive draft — each seat uses its own weights during its pick.
  // Deckbuilder has no draft so this loop skips immediately.
  while (Game.state.phase === 'draft-cards' || Game.state.phase === 'draft-tricks') {
    var d = Game.state.draft;
    if (!d.playerChoices || d.playerChoices.length === 0) {
      if (d.phase === 'cards') Game.finishCardDraft(); else Game.finishTrickDraft();
      break;
    }
    var pick;
    withP(function () {
      pick = d.phase === 'cards'
        ? AI.pickDraftCard(d.playerChoices, d.playerDrafted)
        : AI.pickDraftTrick(d.playerChoices, d.playerTrickDrafted);
    });
    var idx = d.playerChoices.indexOf(pick);
    Game.draftPick(idx >= 0 ? idx : 0);
  }
  if (collect) collect.onDraftComplete(Game.state);

  var safety = 0, lastRound = -1;
  while (!Game.state.gameOver) {
    var phase = Game.state.phase;
    switch (phase) {
      case 'player-cards':
        withP(function () { AI.playCards('player'); });
        Game.endPhase1();
        break;
      case 'player-cards-tricks':
        withP(function () {
          AI.playCards('player');
          AI.playTrickPhaseCards('player');
          AI.playTricks('player');
        });
        Game.endPhase2();
        break;
      case 'player-tricks':
        withP(function () {
          if (Game.getAllCardsOf('player').some(function (c) { return c.passive === 'allowCardsInTricksPhase'; })) {
            AI.playCards('player');
          }
          AI.playTrickPhaseCards('player');
          AI.playTricks('player');
        });
        Game.endPhase3();
        break;
      case 'ai-cards':
        withA(function () { AI.playCards('ai'); });
        Game.endPhase1();
        break;
      case 'ai-cards-tricks':
        withA(function () {
          AI.playCards('ai');
          AI.playTrickPhaseCards('ai');
          AI.playTricks('ai');
        });
        Game.endPhase2();
        break;
      case 'ai-tricks':
        withA(function () {
          if (Game.getAllCardsOf('ai').some(function (c) { return c.passive === 'allowCardsInTricksPhase'; })) AI.playCards('ai');
          AI.playTrickPhaseCards('ai'); AI.playTricks('ai');
        });
        Game.endPhase3();
        break;
      case 'combat':
        if (Game.state._combatContinuation) Game.resumeCombatIfWaiting();
        else Game.resolveCombat();
        break;
      default: break;
    }
    if (Game.state.round !== lastRound) { lastRound = Game.state.round; safety = 0; } else safety++;
    if (safety > 500) {
      // Stalled (combat loop / latent bug). Award to higher HP so the
      // sample isn't lost — only marks DRAW if HPs happen to be tied.
      Game.state.gameOver = true;
      Game.state.winner = Game.state.player.health > Game.state.ai.health ? 'player'
        : Game.state.ai.health > Game.state.player.health ? 'ai' : null;
      Game.state._simStalled = true; // diagnostic flag for downstream tools
      break;
    }
    if (Game.state.round > SIM_MAX_ROUNDS) {
      Game.state.gameOver = true;
      Game.state.winner = Game.state.player.health > Game.state.ai.health ? 'player'
        : Game.state.ai.health > Game.state.player.health ? 'ai' : null;
      break;
    }
  }
  if (collect) collect.onGameEnd(Game.state);
  return {
    winner: Game.state.winner,
    rounds: Game.state.round,
    playerHp: Game.state.player.health,
    aiHp: Game.state.ai.health,
  };
};
