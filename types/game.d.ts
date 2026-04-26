// ============================================================
// Card Lane Battle — ambient type declarations
//
// Describes the public shape of globals defined in the loose
// scripts (cards.js, tricks.js, abilities.js, game.js, ai.js,
// ui.js). Gives VS Code autocomplete + error-detection without
// requiring any file to be converted to an ES module.
//
// When the Vite migration (see MIGRATION.md) converts the files
// to modules, these declarations get replaced by real exports.
// For now they live alongside the JS as a typing-only contract.
// ============================================================

/* ---- Card status flags & per-instance state ---- */

type Owner = 'player' | 'ai';
type Phase =
  | 'main-menu' | 'mode-select' | 'my-decks' | 'stats'
  | 'deckbuilder-build' | 'deckbuilder-start'
  | 'draft-cards' | 'draft-tricks'
  | 'player-cards' | 'player-cards-tricks' | 'player-tricks'
  | 'ai-cards'     | 'ai-cards-tricks'     | 'ai-tricks'
  | 'combat';

/** Abilities defined on card defs via the abilities[] string list and
 *  via CARD_ABILITIES hooks. Canonical keyword strings from card-text-audit.md. */
type AbilityKeyword =
  | 'Armor' | 'Evade' | 'Splash' | 'Bullseye' | 'Overdrive'
  | 'Taunt' | 'Immunity' | 'Invincible' | 'Unresistible'
  | 'Untrickable' | 'Damage Immunity' | 'Hunt' | 'Revive'
  | 'Draw';

interface CardDef {
  name: string;
  cost: number;
  attack: number;
  health: number;
  type?: 'hero' | 'villain' | 'neutral' | string;
  abilities?: string[];       // ['Armor 1', 'Evade 1', …]
  desc?: string;
  passive?: string | null;
  isDiscardEffect?: boolean;
  actualCost?: number;

  /* Lifecycle hooks — filled in from CARD_ABILITIES by the merger
     at the bottom of abilities.js. */
  onPlay?:          (G: Game, self: CardInstance, lane: number) => void;
  onDeath?:         (G: Game, self: CardInstance, lane: number) => boolean | void;
  onKill?:          (G: Game, self: CardInstance) => void;
  onDamaged?:       (G: Game, self: CardInstance, attacker: CardInstance | null, dmg: number) => void;
  onBeforeAttack?:  (G: Game, self: CardInstance) => void;
  onBeforeTricks?:  (G: Game, self: CardInstance, lane: number) => void;
  onEndOfTurn?:     (G: Game, self: CardInstance, lane: number) => void;
  onTurnStart?:     (G: Game, self: CardInstance) => void;
  onAnyCardPlayed?: (G: Game, self: CardInstance) => void;
  onAllyKilled?:    (G: Game, self: CardInstance) => void;
  onEvade?:         (G: Game, self: CardInstance) => void;
  onDamagePlayer?:  (G: Game, self: CardInstance, amount: number) => void;
  onMoved?:         (G: Game, self: CardInstance, toLane: number) => void;
  onLaneResolved?:  (G: Game, self: CardInstance, lane: number) => void;
  onDiscard?:       (G: Game, owner: Owner, self: CardInstance) => void;

  _recurringBT?: boolean;
  trickPhasePlayable?: boolean;
}

interface CardInstance extends CardDef {
  id: number;
  owner: Owner;
  currentHealth: number;
  maxHealth: number;
  baseAttack: number;
  baseHealth: number;
  baseCost: number;

  /* Status flags (defaults 0 / false). Set by applyAbilities based
     on the abilities[] string list + by runtime effects. */
  evadeCharges: number;
  armorValue: number;
  invincibleTurns: number;
  splashRange: number;
  tauntTurns: number;
  immunityCharges: number;
  unresistibleCharges: number;
  damageImmuneTurn: boolean;
  hasDamageImmunity: boolean;
  hasHunt: boolean;
  isUntrickable: boolean;
  permanentUntrickable?: boolean;
  isBullseye: boolean;
  isOverdrive: boolean;
  drawOnPlay: number;
  reviveCharges: number;

  isStunned: boolean;
  isFrozen: boolean;
  isFeared: boolean;
  isMindControlled: boolean;
  mindControlTarget?: CardInstance | null;

  isFaceDown?: boolean;
  _isToken?: boolean;
  _deathHandled?: boolean;

  /* Attribution chain — every derived card points at the card/source
     that produced it. _creditChain walks this chain on stat writes. */
  _summonedBy?: CardInstance | null;
  _drawnBy?: CardInstance | null;

  /* Per-card stats (feed the end-of-game MVP panel). */
  statsHealthbarDamage?: number;
  statsEnemyDamage?: number;
  statsDamageAbsorbed?: number;
  statsKills?: number;
  statsKillValue?: number;
  statsCardAdvantage?: number;
  statsEnergyGenerated?: number;
  statsDebuffValue?: number;
  statsDiscountValue?: number;
  statsHealingDone?: number;
  statsMcApplied?: number;
  statsFreezesApplied?: number;
  statsStunsApplied?: number;
  statsFearsApplied?: number;
  statsEnteredRound?: number | null;
  statsLeftRound?: number | null;

  /* Transient per-round flags. */
  _combatSwungThisRound?: boolean;
  _debuffDelayedClear?: boolean;
  _gojoAttackZeroed?: number;
  _gojoZeroedBy?: number;
  _obiWanAttackZeroed?: number;
  _grantedBuffs?: Array<{
    prop: string;
    delta?: number;
    prev?: unknown;
    set?: boolean;
    turnsLeft: number;
  }>;
  _lastJokerRoll?: number;
  _lastJokerDebuffRoll?: number;
  _damageDealtThisTurn?: number;
  _debuffStacks?: number;
  _recurringBT?: boolean;
  beforeTricksFired?: boolean;

  /* Bonus attack queue drained in postCombat. */
  bonusAttack?: number | false;
}

/* ---- Tricks ---- */

interface TrickDef {
  name: string;
  cost: number;
  desc?: string;
  abilities?: string[];
  canPlay?: (G: Game, owner: Owner) => boolean;
  play: (G: Game, owner: Owner, ctx?: unknown) => void;
  _sourceInstance?: CardInstance;
}

/* ---- Per-side player state ---- */

interface PlayerState {
  isHuman: boolean;
  health: number;
  maxHealth: number;
  currency: number;
  hand: CardInstance[];
  trickHand: TrickDef[];
  deadPile: CardDef[];
  discardPile: CardDef[];
  playedTrickPile: Array<{ name: string; cost: number }>;
  blockMeter: number;
  discount: number;
  nextDrawDiscount: number;
  nextTurnCurrency: number;
  maxHandSize: number;
  maxTrickHandSize: number;
  nextCardStolen: boolean;
  stolenByBWL: unknown;
  bwlInterceptUsed: boolean;
  drStrangeReorder: boolean | string;
  faceDownAvailable: boolean;
  drawPile: CardDef[];
  trickDrawPile: TrickDef[];
  forcedLane?: number | null;
  magnetoForcedLanes?: number[];
  healthFrozen?: boolean;
  _healthFrozenBy?: CardInstance | null;
  _nextDrawDiscountSource?: CardInstance | null;
  batmanBlocked?: number;
  batmanLockedCardName?: string;
}

interface Lane {
  player: CardInstance | null;
  ai:     CardInstance | null;
  destroyed: boolean;
  destroyedTurns: number;
  protected: 'player' | 'ai' | null;
  trap?: { placedBy: Owner; damage?: number } | null;
}

interface GameState {
  phase: Phase;
  mode: { players: string; deck: string; customDeck?: { cards: string[]; tricks: string[] } } | null;
  round: number;
  draft: {
    round: number;
    phase: 'cards' | 'tricks';
    playerChoices: CardDef[];
    aiChoices: CardDef[];
    playerDrafted: CardDef[];
    aiDrafted: CardDef[];
    playerTrickDrafted: TrickDef[];
    aiTrickDrafted: TrickDef[];
    cardHolding: CardDef[];
    trickHolding: TrickDef[];
    mulliganUsed: boolean;
    history?: Array<Record<string, unknown>>;
  } | null;
  oddPlayer: Owner;
  firstPlayer: Owner | null;
  activePlayer: Owner | null;
  drawPile: CardDef[];
  trickDrawPile: TrickDef[];
  voidPile: CardDef[];
  player: PlayerState;
  ai: PlayerState;
  lanes: Lane[];
  selectedCard: CardInstance | null;
  selectedTrick: TrickDef | null;
  log: string[];
  gameOver: boolean;
  winner: Owner | null;
  _stats?: Record<Owner, { blockTriggers: number; peakRoundDamage: number; cardsKilled: number; energySpent: number }>;
  _hpHistory?: Array<{ round: number; player: number; ai: number }>;
  _combatFinishedThisRound?: boolean;
  _inCombat?: boolean;
  _inTrick?: boolean;
  _trickOwner?: Owner;
  _activeLane?: number;
  _roundStats?: Record<string, unknown>;
  _nextFirstPlayer?: Owner;
  pendingCardChoice?: unknown;
  pendingLaneChoice?: unknown;
  pendingBlockTrick?: TrickDef;
  pendingKangChoice?: unknown;
  pendingJumpOffer?: unknown;
  _promptDeadline?: number | null;
  _combatContinuation?: () => void;
}

/* ---- Ambient globals defined by the loose scripts ---- */

declare const CARD_DEFS: CardDef[];
declare const TRICK_DEFS: TrickDef[];
declare const CARD_ABILITIES: Record<string, Partial<CardDef>>;
declare const STARTER_DECKS: Record<string, { name: string; description?: string; cards: string[]; tricks: string[] }>;
declare let nextCardId: number;

interface GameApi {
  state: GameState;
  init(): void;
  startMatch(mode: string | { deck: string; players: string; customDeck?: { cards: string[]; tricks: string[] } }): void;
  goToMainMenu(): void;
  goToModeSelect(): void;
  goToMyDecks(): void;
  goToStats(): void;
  enterDeckBuilder(seed?: unknown): void;
  createCardInstance(def: CardDef, owner: Owner): CardInstance;
  playCard(owner: Owner, card: CardInstance, laneIdx: number): boolean;
  playTrick(owner: Owner, trick: TrickDef): void;
  dealDamage(card: CardInstance, amount: number, source?: CardInstance): void;
  buffCard(card: CardInstance, atk: number, hp: number): void;
  debuffCard(card: CardInstance, atk: number, hp: number, allowKill?: boolean, source?: CardInstance | null): void;
  killCard(card: CardInstance, source?: CardInstance): void;
  damagePlayer(owner: Owner, amount: number, isBullseye?: boolean | CardInstance, source?: CardInstance): void;
  healPlayer(owner: Owner, amount: number, source?: CardInstance): void;
  mindControlCard(card: CardInstance, source: CardInstance, onApply?: () => void): boolean;
  freezeCard(card: CardInstance, source?: CardInstance): void;
  freezeCardUnresistible(card: CardInstance, source?: CardInstance): void;
  stunCard(card: CardInstance, source?: CardInstance): void;
  fearCard(card: CardInstance, source?: CardInstance): void;
  devourCard(card: CardInstance, source?: CardInstance): void;
  drainCard(source: CardInstance, target: CardInstance): void;
  moveCard(card: CardInstance, from: number, to: number): void;
  opponent(o: Owner): Owner;
  isHuman(owner: Owner): boolean;
  isPlayerTurn(): boolean;
  getEnemiesOf(owner: Owner): CardInstance[];
  getAlliesOf(owner: Owner): CardInstance[];
  getAllCardsOf(owner: Owner): CardInstance[];
  getAllCardsOnBoard(): CardInstance[];
  getOpenLanes(owner: Owner): number[];
  getDrawPile(owner: Owner): CardDef[];
  getTrickPile(owner: Owner): TrickDef[];
  findCardLane(card: CardInstance): number;
  applyAbilities(card: CardInstance): void;
  promptCardChoice(
    owner: Owner,
    cards: CardInstance[] | Array<CardInstance | CardDef>,
    title: string,
    desc: string,
    callback: (picked: CardInstance) => void,
    aiPicker?: (cards: CardInstance[]) => CardInstance,
    options?: { faceDown?: boolean }
  ): void;
  promptLaneChoice(
    owner: Owner,
    lanes: number[],
    title: string,
    desc: string,
    callback: (lane: number) => void,
    targetSide?: Owner
  ): void;
  summonCard(owner: Owner, laneIdx: number, name: string, cost: number, attack: number, health: number, abilities: string[], sourceDef?: CardDef): void;
  draftPick(index: number): void;
  draftMulligan(): boolean;
  draftUndo(): boolean;
  draftQuitToMenu?(): void;
  log(msg: string): void;
  snapshot(): void;
  cleanupDead(): void;
  resumeCombatIfWaiting(): void;
  whenPromptCleared(fn: () => void): void;
  hasPendingPrompt(): boolean;
  readonly BLOCK_MAX: number;
  readonly LANE_COUNT: number;
  readonly COMBAT_POST_DELAY: number;
  _creditChain(card: CardInstance, key: string, amount: number): void;
  _runHook(card: CardInstance | null, hookName: string, ...args: unknown[]): unknown;
  _trickBlocked(target: CardInstance): boolean;
  _simulatePhantomSwing(source: CardInstance, target: CardInstance): void;
  resolveCombat(): void;
  resolveLaneCombat(laneIdx: number, done?: () => void): void;
  applyCombatDamage(attacker: CardInstance, target: CardInstance): boolean;
  applySplash(card: CardInstance, laneIdx: number): void;
  postCombat(): void;
  runBeforeTricks(): void;
  startRound(): void;
  endPhase1(): void;
  endPhase2(): void;
  endPhase3(): void;
  drawCards(owner: Owner, count: number): void;
  addToHand(owner: Owner, card: CardInstance, source?: CardInstance): boolean;
  tryApplyDebuff(source: CardInstance | null, target: CardInstance, name: string, applyFn: () => void): boolean;
}

declare const Game: GameApi;
declare const AI: Record<string, (...args: unknown[]) => unknown>;
declare const UI: Record<string, unknown>;
