// ============================================================
// ROGUELITE MODE — Slay-the-Spire-shaped run with lane combat.
// ============================================================
// Architecture: a thin overlay UI + state machine that lives next to
// the main game. Each "fight" inside a run uses the existing
// Game.startMatch combat engine; this module handles everything
// outside combat: run state, map progression, rewards, hp carry-over,
// future shop/rest/boss nodes.
//
// Run state lives at `Game.state.roguelite` so a save/restore cycle
// (refresh, reload) can pick up where the player left off.
//
// Phases (added to Game.state.phase):
//   roguelite-start      — boon picker (Spire's neow-style 4 choices)
//   roguelite-map        — node ladder, click to enter a fight
//   roguelite-rewards    — post-fight card pick (1 of 3)
//   roguelite-end        — run complete / failed summary
//
// Combat itself runs through the existing 'player-cards' / 'ai-cards'
// phases; the run phase resumes once Game.state.gameOver flips true.
//
// Per the design discussion:
//   - HP carries across fights (run HP = player HP), heals between
//     fights via rest sites and event rewards
//   - Energy ramps 1→3→5→7→9 (faster pacing)
//   - Draw 2 per round
//   - Dead pile reshuffles into draw on empty (preserves Lazarus / Hela)
//   - Tier-gated reward pool: Act 1 → tier 1, Act 2 → tier 2, Act 3 → tier 3
//   - Cards earn XP through play and level up to higher rarities
//   - Etches stack on top of base card text via the `statuses` array
// ============================================================

const Roguelite = {
  // ----- Data: starter cards (Tier 0 vanilla bodies) -----
  // Plain stat-line goons. Designed so Act 1 feels like climbing OUT of
  // weakness rather than starting strong. These don't exist in CARD_DEFS;
  // the runtime card builder (buildRunCard below) checks here first.
  // ----- Curse cards (the "deck pollution" mechanic) -----
  // Bad cards that get added to your deck via events. They occupy a
  // hand slot and do nothing (or worse). Removable only via the
  // Merchant's "remove a card" service. User direction: "Curses /
  // Wound cards — bad cards that get added via events, removable at
  // the Merchant. Adds deck-thinning depth."
  //
  // Marked `_isCurse: true` so the engine can show the dim purple
  // tint + the deck-thinning hint in the UI.
  CURSE_DEFS: [
    {
      name: 'Wound',
      cost: 1, attack: 0, health: 1,
      type: 'curse', abilities: [], desc: 'A scar on your deck. Plays as a 0/1 dud — does nothing.',
      _isCurse: true,
    },
    {
      name: 'Doubt',
      cost: 2, attack: 0, health: 2,
      type: 'curse', abilities: [], desc: 'Hesitation. Plays as a 0/2 dud — does nothing.',
      _isCurse: true,
    },
    {
      name: 'Regret',
      cost: 0, attack: 0, health: 1,
      type: 'curse', abilities: [], desc: '0-cost dud that clogs your hand. WHEN PLAYED: Lose 2 HP.',
      _isCurse: true,
      onPlay(G, self) {
        G.state[self.owner].health = Math.max(0, G.state[self.owner].health - 2);
        G.log(`Regret bites — you lose 2 HP.`);
      },
    },
  ],

  // Inject curse defs into CARD_DEFS so the engine's name-lookup path
  // (expand, summon, dead-pile reshuffle) resolves them. Done lazily
  // alongside the vanilla-defs registration.
  _ensureCurseDefsRegistered() {
    if (this._cursesRegistered) return;
    if (typeof CARD_DEFS === 'undefined') return;
    this.CURSE_DEFS.forEach(def => {
      if (!CARD_DEFS.find(d => d.name === def.name)) CARD_DEFS.push(def);
    });
    this._cursesRegistered = true;
  },

  // Add a random curse to the run's deck. Used by events / future
  // shop-mishaps. Returns the curse name.
  addRandomCurse(run, weights) {
    if (!run) return null;
    this._ensureCurseDefsRegistered();
    const pool = this.CURSE_DEFS;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    run.deck.push({
      defName: pick.name,
      rarity: 'common',
      xp: 0,
      statuses: [],
      _isStarter: false,
      _isCurse: true,
    });
    // Curse-warning toast — purple tint, ✕ glyph.
    this.showToast(`<span class="rl-toast-glyph">✕</span><span class="rl-toast-text"><b>${pick.name}</b><span class="rl-toast-sub">CURSE ADDED</span></span>`, 'curse');
    return pick.name;
  },

  // Hide roguelite-only cards from Classic mode (codex, deckbuilder,
  // draft pile, summon pool). User report: "brute goon and thug made
  // its way to the game, not just the roguelike — they need to be
  // removed there and only in the roguelike." STARTER_DEFS get injected
  // into CARD_DEFS at boot so the engine can name-resolve them during
  // a run; this helper lets every classic-mode pool filter them back
  // out without touching the def store. Same treatment for the AI
  // vanilla bodies (Soldier / Mercenary / Operator) and curses
  // (Wound / Doubt / Regret).
  _rogueliteOnlyNames: null,
  isRogueliteOnlyName(name) {
    if (!this._rogueliteOnlyNames) {
      const set = new Set();
      (this.STARTER_DEFS || []).forEach(d => set.add(d.name));
      (this.AI_VANILLA_DEFS || []).forEach(d => set.add(d.name));
      (this.CURSE_DEFS || []).forEach(d => set.add(d.name));
      this._rogueliteOnlyNames = set;
    }
    return this._rogueliteOnlyNames.has(name);
  },

  STARTER_DEFS: [
    // The 3 vanilla starter bodies. User spec: "I just want Goon, who's
    // a one energy 1/1. Thug, two energy 2/2. Brute, three energy 3/4.
    // I want three of each." Predictable like Strike/Defend in StS;
    // starter cards do NOT receive the Common -1/-1 tier penalty
    // (`_isStarter` flag flows through buildRunCard) — they sit at
    // their face stats so the early game has a stable read.
    //
    // Each starter has a small ability so they're not pure stat-sticks:
    //   • Goon  — While Active: +1/+1 per other Goon ally on board.
    //              Synergy bait — 3 Goons = 3/3 each.
    //   • Thug  — When Played: deal 1 damage to a chosen enemy.
    //              Tempo poke — kills 1-HP threats on arrival.
    //   • Brute — Armor 1, Taunt 1. The wall — taunts intercept for
    //              1 turn, armor blunts chip damage.
    {
      name: 'Goon',  cost: 1, attack: 1, health: 1, type: 'villain',
      abilities: [], passive: 'goonHive',
      desc: 'WHILE ACTIVE: +1/+1 for every other Goon ally on board.',
    },
    {
      name: 'Thug',  cost: 2, attack: 2, health: 2, type: 'villain',
      abilities: [],
      desc: 'WHEN PLAYED: Deal 1 damage to an enemy.',
    },
    {
      name: 'Brute', cost: 3, attack: 3, health: 4, type: 'villain',
      // User direction: "Armor 1 on Brute is pretty good — remove it.
      // Make sure all Brutes have Taunt 1." Keeping Taunt 1 keeps the
      // wall identity (intercepts a hit per turn) without the chip
      // mitigation that made Brute too dominant on Act 1.
      abilities: ['Taunt 1'],
      desc: '',
    },
  ],

  // ----- Data: etch pool (status modifiers by rarity tier) -----
  // Each etch is an object { id, name, apply }. apply mutates the runtime
  // card instance; abilities array gets the keyword pushed so the card
  // renderer shows the badge. User direction: "really cut back on the
  // rarity of edges. A lot of them should be common." So commons are
  // the bulk of the pool — simple stat bumps + basic keywords.
  // Helper: bump a stackable counter keyword to a new total. Replaces
  // an existing "Keyword N" badge with "Keyword <total>" so etching
  // Splash 1 onto a card that already has Splash 4 reads as a single
  // Splash 5 badge instead of two stacked rows. User report:
  // "Deathstroke base Splash 4 + Splash 1 etch should just be Splash 5,
  // not two badges." Same logic applies to Evade, Armor, Taunt,
  // Discount, Splash, etc. — anything with a "<Keyword> N" form.
  _bumpKw(c, keyword, total) {
    if (!c || !Array.isArray(c.abilities)) return;
    const re = new RegExp('^' + keyword + '(\\s+\\d+)?$', 'i');
    const idx = c.abilities.findIndex(a => re.test(a));
    const badge = `${keyword} ${total}`;
    if (idx >= 0) c.abilities[idx] = badge;
    else c.abilities.push(badge);
  },

  // Display-name map for rarity labels. Internal tier strings are
  // common/rare/special/legendary (kept stable so we don't break
  // RARITY_DESCS keys, ETCHES tiers, save state, etc.). User direction:
  // "the naming of green is common, blue is uncommon, white is rare,
  // and gold is legendary." So the labels we SHOW the player are:
  //   common    → "Common"
  //   rare      → "Uncommon"
  //   special   → "Rare"
  //   legendary → "Legendary"
  // The displayRarity helper applies this mapping everywhere a rarity
  // label gets rendered.
  RARITY_LABELS: {
    common:    'Common',
    rare:      'Uncommon',
    special:   'Rare',
    legendary: 'Legendary',
  },
  displayRarity(rarity) {
    return (this.RARITY_LABELS && this.RARITY_LABELS[rarity]) || (rarity ? rarity[0].toUpperCase() + rarity.slice(1) : '');
  },

  ETCHES: {
    common: [
      { id: 'plus1-atk',     name: '+1 ATK',    apply: c => { c.attack += 1; } },
      { id: 'plus1-hp',      name: '+1 HP',     apply: c => { c.health += 1; c.maxHealth += 1; c.currentHealth += 1; } },
      { id: 'plus1-atk-hp',  name: '+1/+1',     apply: c => { c.attack += 1; c.health += 1; c.maxHealth += 1; c.currentHealth += 1; } },
      { id: 'evade-1',       name: 'Evade 1',   apply: c => { c.evadeCharges = (c.evadeCharges || 0) + 1; Roguelite._bumpKw(c, 'Evade', c.evadeCharges); } },
      { id: 'bullseye',      name: 'Bullseye',  apply: c => { c.isBullseye = true; if (!c.abilities.includes('Bullseye')) c.abilities.push('Bullseye'); } },
      { id: 'splash-1',      name: 'Splash 1',  apply: c => { c.splashRange = (c.splashRange || 0) + 1; Roguelite._bumpKw(c, 'Splash', c.splashRange); } },
      { id: 'armor-1',       name: 'Armor 1',   apply: c => { c.armorValue = (c.armorValue || 0) + 1; Roguelite._bumpKw(c, 'Armor', c.armorValue); } },
      { id: 'hunt',          name: 'Hunt',      apply: c => { c.hasHunt = true; if (!c.abilities.includes('Hunt')) c.abilities.push('Hunt'); } },
      { id: 'untrickable',   name: 'Untrickable', apply: c => { c.isUntrickable = true; if (!c.abilities.includes('Untrickable')) c.abilities.push('Untrickable'); } },
      { id: 'discount-1',    name: 'Discount 1', apply: c => { const before = c.baseCost || c.cost || 0; c.cost = Math.max(0, (c.cost || 0) - 1); c.baseCost = Math.max(0, (c.baseCost || before) - 1); c._discountTotal = (c._discountTotal || 0) + 1; Roguelite._bumpKw(c, 'Discount', c._discountTotal); } },
      { id: 'taunt-1',       name: 'Taunt 1',   apply: c => { c.tauntTurns = Math.max(c.tauntTurns || 0, 0) + 1; Roguelite._bumpKw(c, 'Taunt', c.tauntTurns); } },
      // Crazy + Insane intentionally NOT in the etch pool — they're
      // ATK-randomizers (debuff-shaped), not upgrades. User: "kinda
      // like debuffs to the cards, just get those out of there."
    ],
    rare: [
      { id: 'plus2-atk',     name: '+2 ATK',    apply: c => { c.attack += 2; } },
      { id: 'plus2-hp',      name: '+2 HP',     apply: c => { c.health += 2; c.maxHealth += 2; c.currentHealth += 2; } },
      { id: 'plus2-atk-hp',  name: '+2/+2',     apply: c => { c.attack += 2; c.health += 2; c.maxHealth += 2; c.currentHealth += 2; } },
      { id: 'evade-2',       name: 'Evade 2',   apply: c => { c.evadeCharges = (c.evadeCharges || 0) + 2; Roguelite._bumpKw(c, 'Evade', c.evadeCharges); } },
      { id: 'overdrive',     name: 'Overdrive', apply: c => { c.isOverdrive = true; if (!c.abilities.includes('Overdrive')) c.abilities.push('Overdrive'); } },
      { id: 'splash-2',      name: 'Splash 2',  apply: c => { c.splashRange = (c.splashRange || 0) + 2; Roguelite._bumpKw(c, 'Splash', c.splashRange); } },
      { id: 'armor-2',       name: 'Armor 2',   apply: c => { c.armorValue = (c.armorValue || 0) + 2; Roguelite._bumpKw(c, 'Armor', c.armorValue); } },
      { id: 'fear-1',        name: 'Fear 1',    apply: c => { c.hasFear = (c.hasFear || 0) + 1; Roguelite._bumpKw(c, 'Fear', c.hasFear); } },
      { id: 'discount-2',    name: 'Discount 2', apply: c => { const before = c.baseCost || c.cost || 0; c.cost = Math.max(0, (c.cost || 0) - 2); c.baseCost = Math.max(0, (c.baseCost || before) - 2); c._discountTotal = (c._discountTotal || 0) + 2; Roguelite._bumpKw(c, 'Discount', c._discountTotal); } },
      { id: 'thorns',        name: 'Thorns',    apply: c => { c.hasThorns = (c.hasThorns || 0) + 1; Roguelite._bumpKw(c, 'Thorns', c.hasThorns); } },
      { id: 'cantrip',       name: 'Cantrip',   apply: c => { c.hasCantrip = (c.hasCantrip || 0) + 1; Roguelite._bumpKw(c, 'Cantrip', c.hasCantrip); } },
    ],
    special: [
      { id: 'plus3-atk',     name: '+3 ATK',    apply: c => { c.attack += 3; } },
      { id: 'plus3-hp',      name: '+3 HP',     apply: c => { c.health += 3; c.maxHealth += 3; c.currentHealth += 3; } },
      { id: 'plus3-atk-hp',  name: '+3/+3',     apply: c => { c.attack += 3; c.health += 3; c.maxHealth += 3; c.currentHealth += 3; } },
      { id: 'splash-3',      name: 'Splash 3',  apply: c => { c.splashRange = (c.splashRange || 0) + 3; Roguelite._bumpKw(c, 'Splash', c.splashRange); } },
      { id: 'invincible-1',  name: 'Invincible 1', apply: c => { c.invincibleTurns = Math.max(c.invincibleTurns || 0, 0) + 1; Roguelite._bumpKw(c, 'Invincible', c.invincibleTurns); } },
      { id: 'unresistible-1',name: 'Unresistible 1', apply: c => { c.unresistibleTurns = Math.max(c.unresistibleTurns || 0, 0) + 1; Roguelite._bumpKw(c, 'Unresistible', c.unresistibleTurns); } },
      { id: 'discount-3',    name: 'Discount 3', apply: c => { const before = c.baseCost || c.cost || 0; c.cost = Math.max(0, (c.cost || 0) - 3); c.baseCost = Math.max(0, (c.baseCost || before) - 3); c._discountTotal = (c._discountTotal || 0) + 3; Roguelite._bumpKw(c, 'Discount', c._discountTotal); } },
      { id: 'lifesteal',     name: 'Lifesteal', apply: c => { c.hasLifesteal = (c.hasLifesteal || 0) + 1; if (!c.abilities.includes('Lifesteal')) c.abilities.push('Lifesteal'); } },
      { id: 'berserker',     name: 'Berserker', apply: c => { c.hasBerserker = (c.hasBerserker || 0) + 1; if (!c.abilities.includes('Berserker')) c.abilities.push('Berserker'); } },
      { id: 'zealot',        name: 'Zealot',    apply: c => { c.hasZealot = (c.hasZealot || 0) + 1; if (!c.abilities.includes('Zealot')) c.abilities.push('Zealot'); } },
    ],
    legendary: [
      { id: 'plus4-atk',     name: '+4 ATK',    apply: c => { c.attack += 4; } },
      { id: 'plus4-atk-hp',  name: '+4/+4',     apply: c => { c.attack += 4; c.health += 4; c.maxHealth += 4; c.currentHealth += 4; } },
      { id: 'splash-4',      name: 'Splash 4',  apply: c => { c.splashRange = (c.splashRange || 0) + 4; Roguelite._bumpKw(c, 'Splash', c.splashRange); } },
      { id: 'evade-4',       name: 'Evade 4',   apply: c => { c.evadeCharges = (c.evadeCharges || 0) + 4; Roguelite._bumpKw(c, 'Evade', c.evadeCharges); } },
      { id: 'echo',          name: 'Echo',      apply: c => { c.hasEcho = (c.hasEcho || 0) + 1; if (!c.abilities.includes('Echo')) c.abilities.push('Echo'); } },
      { id: 'phoenix',       name: 'Phoenix',   apply: c => { c.hasPhoenix = (c.hasPhoenix || 0) + 1; if (!c.abilities.includes('Phoenix')) c.abilities.push('Phoenix'); } },
      { id: 'discount-4',    name: 'Discount 4', apply: c => { const before = c.baseCost || c.cost || 0; c.cost = Math.max(0, (c.cost || 0) - 4); c.baseCost = Math.max(0, (c.baseCost || before) - 4); c._discountTotal = (c._discountTotal || 0) + 4; Roguelite._bumpKw(c, 'Discount', c._discountTotal); } },
      // ----- TEXT etch -----
      // Scales this card's printed ability up by one rarity tier when
      // Game.rarityValue() resolves it. So a Rare Hawkeye with a Text+
      // etch reads its Splash value at the Special tier (Splash 2),
      // and a Black Widow with Text+ freezes 2 instead of 1. User
      // direction: "the text etch should effect the scalar on the
      // text ability — like Hawkeye's 'When played: Splash 1' becomes
      // 'When played: Splash 2'. The text tech is the Legendary quality
      // upgrade so it's rare to get." Lives in the legendary tier so
      // it only drops on big promotions.
      { id: 'text-upgrade', name: 'Text+', apply: c => { c.textTierBumps = (c.textTierBumps || 0) + 1; if (!c.abilities.includes('Text+')) c.abilities.push('Text+'); } },
    ],
  },

  // Etch description book — surfaced in the level-up modal so the
  // player knows what each keyword/etch actually does. Keys are etch
  // IDs from the ETCHES table above.
  ETCH_DESCS: {
    'plus1-atk':     '+1 attack power.',
    'plus1-hp':      '+1 hit points.',
    'plus1-atk-hp':  '+1 attack and +1 hit points.',
    'plus2-atk':     '+2 attack power.',
    'plus2-hp':      '+2 hit points.',
    'plus2-atk-hp':  '+2 attack and +2 hit points.',
    'plus3-atk':     '+3 attack power.',
    'plus3-hp':      '+3 hit points.',
    'plus3-atk-hp':  '+3 attack and +3 hit points.',
    'plus4-atk':     '+4 attack power.',
    'plus4-atk-hp':  '+4 attack and +4 hit points.',
    'discount-1':    'Costs 1 less energy to play.',
    'discount-2':    'Costs 2 less energy to play.',
    'discount-3':    'Costs 3 less energy to play.',
    'discount-4':    'Costs 4 less energy to play.',
    'evade-1':       'Evade 1 — first incoming damage is avoided.',
    'evade-2':       'Evade 2 — first two incoming hits are avoided.',
    'evade-4':       'Evade 4 — first four incoming hits are avoided.',
    'bullseye':      'Bullseye — attacks ignore Armor and pass through to the player when no enemy is in lane.',
    'splash-1':      'Splash 1 — deal +1 splash damage to adjacent lanes.',
    'splash-2':      'Splash 2 — splash damage hits adjacent lanes for +2.',
    'splash-3':      'Splash 3 — splash damage hits adjacent lanes for +3.',
    'splash-4':      'Splash 4 — splash damage hits adjacent lanes for +4.',
    'armor-1':       'Armor 1 — reduces every incoming hit by 1.',
    'armor-2':       'Armor 2 — reduces every incoming hit by 2.',
    'hunt':          'Hunt — moves to the lane of newly-played enemies on arrival.',
    'untrickable':   'Untrickable — immune to enemy tricks.',
    'taunt-1':       'Taunt 1 — intercepts 1 attack aimed at allies next turn.',
    'overdrive':     'Overdrive — attacks twice this turn.',
    'fear-1':        'Fear 1 — applies Fear to one enemy on play.',
    'thorns':        'Thorns — counter-damage attackers for 1 each time you\'re hit.',
    'cantrip':       'Cantrip — draw 1 card whenever you play this card.',
    'echo':          'Echo — duplicates this card\'s when-played effect.',
    'phoenix':       'Phoenix — once per life, revive at full HP when killed.',
    'lifesteal':     'Lifesteal — heal yourself for damage dealt.',
    'berserker':     'Berserker — gain +1 attack each time you take damage.',
    'zealot':        'Zealot — gain +1/+1 each time an ally dies.',
    'invincible-1':  'Invincible 1 — take no damage for 1 turn after arrival.',
    'unresistible-1':'Unresistible — your attacks cannot be blocked by Evade or Immunity.',
    'text-upgrade':  'Text+ — scales this card\'s printed ability up one tier (e.g. Splash 1 → Splash 2). Legendary-quality upgrade.',
  },
  etchDesc(id) {
    return this.ETCH_DESCS[id] || '';
  },

  // ----- Relics (run-scoped passive modifiers) -----
  // Spire-style: collected through events / shops / boss rewards. Each
  // hooks into a defined point — onAcquire (one-shot when picked up),
  // onCardBuild (each deck card gets a transformation when built into a
  // runtime card), onFightStart (mutates the run before the fight
  // launches), onFightEnd (post-fight rewards / heals). All hooks
  // optional. Most relics are passive stat bumps; rare ones grant
  // keyword etches on every card; boss relics are big run-defining mods.
  RELICS: [
    // ----- Common (event + shop) -----
    // ----- STARTER-RELIC BALANCE -----
    // User feedback (paraphrased): "Battery and Old Manuscript are
    // broken — I just choose those every time. Crimson Cuirass and
    // Lucky Coin are weak. Lucky Coin should give +10g per win, not 5."
    //
    // Slay-the-Spire-style: each starter relic should be a distinct
    // playstyle anchor at roughly equivalent power, not a power-creep
    // ladder. So:
    //   • Cuirass    → bigger HP buffer (+10 max + 10 heal). Survival anchor.
    //   • Lucky Coin → +10g/win (was 5). Economy anchor.
    //   • Manuscript → ROUND-1 ONLY +1 draw. Burst anchor.
    //   • Battery    → ROUND-1 ONLY +1 energy. Burst anchor.
    // The two "burst" relics give a tempo lead in round 1 without
    // free-rolling +1 energy/draw every round of every fight.
    {
      id: 'crimson-cuirass', name: 'Crimson Cuirass', rarity: 'common',
      // User direction: "Crimson Cuirass is at the beginning of the
      // run, so you don't need to heal on pickup." The "heal 10" was
      // a no-op when the player was already at full HP at run start.
      // Now just bumps both max HP and current HP by 10 — clean
      // survival-anchor messaging.
      desc: '+10 max HP.',
      onAcquire(run) { run.maxHp += 10; run.hp += 10; },
    },
    {
      id: 'lucky-coin', name: 'Lucky Coin', rarity: 'common',
      desc: 'Gain +10 gold after every fight won.',
      onFightEnd(run, won) { if (won) run.gold += 10; },
    },
    {
      id: 'old-manuscript', name: 'Old Manuscript', rarity: 'common',
      desc: 'Every other round: draw +1 card.',
      onFightStart(run) { run._extraDrawAlt = (run._extraDrawAlt || 0) + 1; },
    },
    {
      id: 'battery', name: 'Battery', rarity: 'common',
      desc: 'Every other round: +1 energy.',
      onFightStart(run) { run._extraEnergyAlt = (run._extraEnergyAlt || 0) + 1; },
    },
    {
      id: 'healing-brew', name: 'Healing Brew', rarity: 'common',
      desc: 'Heal 5 HP after every fight won.',
      onFightEnd(run, won) { if (won) run.hp = Math.min(run.maxHp, run.hp + 5); },
    },
    {
      id: 'steel-heart', name: 'Steel Heart', rarity: 'common',
      desc: 'All your cards gain Armor 1.',
      onCardBuild(run, card) { card.armorValue = (card.armorValue || 0) + 1; if (!card.abilities.includes('Armor 1')) card.abilities.push('Armor 1'); },
    },
    // Slay-the-Spire-inspired additions. Each one slots a distinct
    // playstyle nudge so the common pool isn't just six survival
    // anchors. User direction: "Maybe there should be more relics in
    // the game. We can just add some. Just take inspiration from Slay
    // the Spire."
    {
      id: 'anchor', name: 'Anchor', rarity: 'common',
      desc: '+2 HP-loss reduction every fight (passive).',
      // Same flag Iron Maiden uses, but no max-HP penalty — common-tier
      // payoff is half the Iron Maiden DR with no downside, so picking
      // it never feels like a regret.
      onAcquire(run) { run._dmgReduction = (run._dmgReduction || 0) + 2; },
    },
    {
      id: 'whetstone', name: 'Whetstone', rarity: 'common',
      desc: 'All your cards gain +1 ATK.',
      onCardBuild(run, card) { card.attack = (card.attack || 0) + 1; },
    },
    {
      id: 'toy-ornithopter', name: 'Toy Ornithopter', rarity: 'common',
      // Heals on ANY fight ending — distinct from Healing Brew (which
      // only heals on wins). Soft buffer for risky elite attempts.
      desc: 'Heal 3 HP after every fight (win or lose).',
      onFightEnd(run) { run.hp = Math.min(run.maxHp, run.hp + 3); },
    },

    // ----- Rare (elite + shop) -----
    {
      id: 'spider-web', name: 'Spider Web', rarity: 'rare',
      desc: 'All your cards gain Thorns 1.',
      onCardBuild(run, card) { card.hasThorns = (card.hasThorns || 0) + 1; if (!card.abilities.includes('Thorns')) card.abilities.push('Thorns'); },
    },
    {
      id: 'vampire-fang', name: "Vampire's Fang", rarity: 'rare',
      desc: 'All your cards gain Lifesteal 1.',
      onCardBuild(run, card) { card.hasLifesteal = (card.hasLifesteal || 0) + 1; if (!card.abilities.includes('Lifesteal')) card.abilities.push('Lifesteal'); },
    },
    {
      id: 'iron-maiden', name: 'Iron Maiden', rarity: 'rare',
      desc: 'Start each fight with -2 HP loss reduction. Max HP -10.',
      onAcquire(run) { run.maxHp = Math.max(10, run.maxHp - 10); run.hp = Math.min(run.hp, run.maxHp); run._dmgReduction = (run._dmgReduction || 0) + 2; },
    },
    {
      id: 'phoenix-feather', name: 'Phoenix Feather', rarity: 'rare',
      desc: 'Once per run, revive from lethal HP loss to 1 HP.',
      onAcquire(run) { run._phoenixFeatherCharged = true; },
    },
    {
      id: 'gamblers-glove', name: "Gambler's Glove", rarity: 'rare',
      desc: '+25 gold now. Spend 25g to reroll any reward (UI: future).',
      onAcquire(run) { run.gold += 25; run._canRerollRewards = true; },
    },
    // Slay-the-Spire-inspired rare additions.
    {
      id: 'bag-of-marbles', name: 'Bag of Marbles', rarity: 'rare',
      desc: 'All your cards gain +1 max HP.',
      onCardBuild(run, card) {
        card.health = (card.health || 0) + 1;
        card.maxHealth = (card.maxHealth || card.health) + 1;
        card.currentHealth = (card.currentHealth || card.maxHealth);
      },
    },
    {
      id: 'smiling-mask', name: 'Smiling Mask', rarity: 'rare',
      // Starter-card-only buff so this relic shines in thin starter-heavy
      // decks. The _runDeckCardRef tag (set right above _applyRelicHook
      // in buildRunCard) carries the _isStarter flag through.
      desc: '+2 ATK on starter cards (Goon, Thug, Brute).',
      onCardBuild(run, card) {
        const ref = card._runDeckCardRef;
        if (ref && ref._isStarter) card.attack = (card.attack || 0) + 2;
      },
    },

    // ----- Boss (act-clear rewards) -----
    {
      id: 'mirror-shard', name: 'Mirror Shard', rarity: 'boss',
      desc: 'All your cards gain Echo (effects fire twice).',
      onCardBuild(run, card) { card.hasEcho = (card.hasEcho || 0) + 1; if (!card.abilities.includes('Echo')) card.abilities.push('Echo'); },
    },
    {
      id: 'speed-force', name: 'Speed Force', rarity: 'boss',
      desc: '+2 starting energy each combat round.',
      onFightStart(run) { run._extraEnergy = (run._extraEnergy || 0) + 2; },
    },
    {
      id: 'reality-stone', name: 'Reality Stone', rarity: 'boss',
      desc: 'All your cards cost 1 less (min 0).',
      onCardBuild(run, card) { card.cost = Math.max(0, (card.cost || 0) - 1); card.baseCost = Math.max(0, (card.baseCost || card.cost || 0) - 1); },
    },
    {
      id: 'thanos-gauntlet', name: "Thanos Gauntlet", rarity: 'boss',
      desc: 'Win 5 fights to unlock a full heal. (One-shot finisher relic.)',
      onAcquire(run) { run._gauntletWins = 0; run._gauntletReady = false; },
      onFightEnd(run, won) {
        if (!won) return;
        run._gauntletWins = (run._gauntletWins || 0) + 1;
        if (run._gauntletWins >= 5 && !run._gauntletConsumed) {
          run.hp = run.maxHp;
          run._gauntletConsumed = true;
        }
      },
    },
    // Slay-the-Spire-inspired boss addition. StS Cursed Key trades a
    // free energy/turn for a curse card — we don't have a curse system
    // wired into the rng deck, so the cost lands on max HP instead.
    {
      id: 'cursed-key', name: 'Cursed Key', rarity: 'boss',
      desc: '+1 starting energy each round. -10 max HP on pickup.',
      onAcquire(run) {
        run.maxHp = Math.max(10, run.maxHp - 10);
        run.hp = Math.min(run.hp, run.maxHp);
      },
      onFightStart(run) { run._extraEnergy = (run._extraEnergy || 0) + 1; },
    },
  ],

  // Apply a hook across all owned relics. Errors caught + logged so a
  // bad relic def doesn't kill the run.
  // Returns true if any relic fired a hook in the last 3 seconds.
  // Drives the brief gold pulse on the RELICS HUD button so the
  // player notices their relics actually triggered. The 3s window
  // covers the post-fight banner + the rewards screen entry.
  _relicPulseRecent(run) {
    if (!run || !run._relicPulses) return false;
    const now = Date.now();
    const recent = Object.values(run._relicPulses).some(t => (now - (t || 0)) < 3000);
    if (!recent) {
      // GC stale entries so the map doesn't grow unbounded.
      Object.keys(run._relicPulses).forEach(k => {
        if ((now - (run._relicPulses[k] || 0)) >= 3000) delete run._relicPulses[k];
      });
    }
    return recent;
  },

  _applyRelicHook(run, hookName, ...args) {
    if (!run || !run.relics) return;
    run.relics.forEach(rid => {
      const r = this.RELICS.find(x => x.id === rid);
      if (r && typeof r[hookName] === 'function') {
        try { r[hookName](run, ...args); } catch (e) { console.warn('[RELIC]', rid, hookName, e); }
        // Mark relic as "recently triggered" so the next render flashes
        // its chip in the relic strip. User polish: "when a relic
        // fires, the chip pulses gold so the player sees that the
        // relic actually did something." Skip onCardBuild — it fires
        // for every card and would just constant-pulse the chips.
        if (hookName !== 'onCardBuild') {
          run._relicPulses = run._relicPulses || {};
          run._relicPulses[rid] = Date.now();
        }
      }
    });
  },

  // Grant a relic to the run. Idempotent — duplicates rejected.
  // Fires onAcquire so any one-shot effect (HP bump, gold, etc.) lands
  // immediately. Spawns an acquire toast so the player notices the
  // addition (was silent — relics just appeared in the count).
  grantRelic(run, relicId) {
    if (!run || !relicId) return false;
    if (run.relics.includes(relicId)) return false;
    const r = this.RELICS.find(x => x.id === relicId);
    if (!r) return false;
    run.relics.push(relicId);
    if (typeof r.onAcquire === 'function') {
      try { r.onAcquire(run); } catch (e) { console.warn('[RELIC onAcquire]', relicId, e); }
    }
    // Mark as recently triggered so the HUD button pulses.
    run._relicPulses = run._relicPulses || {};
    run._relicPulses[relicId] = Date.now();
    // Toast — show the icon glyph + relic name with rarity tint.
    const glyph = this._relicIcon(r);
    this.showToast(`<span class="rl-toast-glyph">${glyph}</span><span class="rl-toast-text"><b>${r.name}</b><span class="rl-toast-sub">${this.displayRarity(r.rarity).toUpperCase()} RELIC</span></span>`, 'relic');
    return true;
  },

  // Roll a random relic by rarity (skipping any already owned).
  rollRelic(run, rarity) {
    rarity = rarity || 'common';
    const owned = new Set(run.relics || []);
    const pool = this.RELICS.filter(r => r.rarity === rarity && !owned.has(r.id));
    if (!pool.length) {
      // Fallback: anything not owned
      const fallback = this.RELICS.filter(r => !owned.has(r.id));
      if (!fallback.length) return null;
      return fallback[Math.floor(Math.random() * fallback.length)];
    }
    return pool[Math.floor(Math.random() * pool.length)];
  },

  // ----- Per-rarity description swaps -----
  // For cards that have rarity-driven ability variants (via
  // Game.rarityValue), the codex text needs to reflect the actual
  // behavior at the displayed rarity tier. If a card has an entry
  // here, _renderCodexCard reads from this table instead of the def
  // desc. Cards without an entry fall through to their base def
  // description (so we only write variants for cards we explicitly
  // tune). User direction: "do not change cards from roguelite into
  // the game — they're two separate entities." — these strings are
  // ROGUELITE-ONLY.
  RARITY_DESCS: {
    'Gorilla Grodd': {
      common:    'WHEN PLAYED: Mind Control 1 an enemy with cost ≤ 1. You choose which of its own allies it attacks this turn.',
      rare:      'WHEN PLAYED: Mind Control 1 an enemy with cost ≤ 3. You choose which of its own allies it attacks this turn.',
      special:   'WHEN PLAYED: Mind Control 1 an enemy with cost ≤ 5. You choose which of its own allies it attacks this turn.',
      legendary: 'WHEN PLAYED: Mind Control 1 an enemy with cost ≤ 9. You choose which of its own allies it attacks this turn.',
    },
    'Xenomorph': {
      common:    'WHILE ACTIVE: Add (+1/+0) for each card played (not summoned). WHEN DESTROYED: Splash 1.',
      rare:      'WHILE ACTIVE: Add (+1/+1) for each card played (not summoned). WHEN DESTROYED: Splash 1.',
      special:   'WHILE ACTIVE: Add (+1/+2) for each card played (not summoned). WHEN DESTROYED: Splash 2.',
      legendary: 'WHILE ACTIVE: Add (+2/+2) for each card played (not summoned). WHEN DESTROYED: Splash 3.',
    },
    'Star-Lord': {
      common:    'WHEN PLAYED: Give an ally +1/+1.',
      rare:      'WHEN PLAYED: Give an ally +2/+2.',
      special:   'WHEN PLAYED: Give an ally +3/+3.',
      legendary: 'WHEN PLAYED: Give an ally +4/+4.',
    },
    'Rocket Raccoon': {
      common:    'WHEN PLAYED: Deal 2 damage to an enemy.',
      rare:      'WHEN PLAYED: Deal 4 damage to an enemy.',
      special:   'WHEN PLAYED: Deal 5 damage to an enemy.',
      legendary: 'WHEN PLAYED: Deal 7 damage to an enemy.',
    },
    'Black Widow': {
      common:    'WHEN PLAYED: Freeze 1 an adjacent enemy.',
      rare:      'WHEN PLAYED: Freeze 1 an adjacent enemy.',
      special:   'WHEN PLAYED: Freeze 1 up to 2 adjacent enemies.',
      legendary: 'WHEN PLAYED: Freeze 1 up to 2 adjacent enemies. Allies gain Bullseye this turn.',
    },
    'Mr. Freeze': {
      common:    'WHEN PLAYED: Freeze the enemy opposite. Freeze your HP bar — the next hit is negated.',
      rare:      'WHEN PLAYED: Freeze the enemy opposite. Freeze your HP bar — the next hit is negated.',
      special:   'WHEN PLAYED: Freeze the enemy opposite + 1 adjacent enemy. Freeze your HP bar.',
      legendary: 'WHEN PLAYED: Freeze the enemy opposite + both adjacent enemies. Freeze your HP bar.',
    },
    'Hawkeye': {
      common:    'WHEN PLAYED: Splash 1. WHILE ACTIVE: Splash damage from allies also removes 1 ATK.',
      rare:      'WHEN PLAYED: Splash 1. WHILE ACTIVE: Splash damage from allies also removes 1 ATK.',
      special:   'WHEN PLAYED: Splash 2. WHILE ACTIVE: Splash damage from allies also removes 1 ATK.',
      legendary: 'WHEN PLAYED: Splash 2. WHILE ACTIVE: Splash damage from allies also removes 1 ATK.',
    },
    'Captain America': {
      common:    'WHEN PLAYED: Other character cards in your hand cost 1 less. Grant an ally Invincible 1.',
      rare:      'WHEN PLAYED: Other character cards in your hand cost 1 less. Grant an ally Invincible 1.',
      special:   'WHEN PLAYED: Other character cards in your hand cost 2 less. Grant an ally Invincible 1.',
      legendary: 'WHEN PLAYED: Other character cards in your hand cost 2 less. Grant an ally Invincible 1.',
    },
    'Thanos': {
      common:    'Can be played during the Trick Phase. WHEN PLAYED: Destroy enemies in 2 random lanes.',
      rare:      'Can be played during the Trick Phase. WHEN PLAYED: Destroy enemies in 3 random lanes.',
      special:   'Can be played during the Trick Phase. WHEN PLAYED: Destroy enemies in 4 random lanes.',
      legendary: 'Can be played during the Trick Phase. WHEN PLAYED: Destroy enemies in 5 random lanes.',
    },
    'Hela': {
      common:    'WHEN PLAYED: Summon 1 Undead Warrior (1/3, Bullseye). Pull 1 random card from any Dead Pile to your hand.',
      rare:      'WHEN PLAYED: Summon 2 Undead Warriors (1/3, Bullseye). Pull 1 random card from any Dead Pile to your hand.',
      special:   'WHEN PLAYED: Summon 2 Undead Warriors (1/3, Bullseye). Pull 2 random cards from any Dead Pile to your hand.',
      legendary: 'WHEN PLAYED: Summon 3 Undead Warriors (1/3, Bullseye). Pull 2 random cards from any Dead Pile to your hand.',
    },
    'Iron Man': {
      common:    'Can be played during the Trick Phase. WHEN PLAYED: Destroy any damaged enemy with cost ≤ 5.',
      rare:      'Can be played during the Trick Phase. WHEN PLAYED: Destroy any damaged enemy with cost ≤ 8.',
      special:   'Can be played during the Trick Phase. WHEN PLAYED: Destroy any damaged enemy with cost ≤ 9.',
      legendary: 'Can be played during the Trick Phase. WHEN PLAYED: Destroy any damaged enemy (no cost gate).',
    },
    'Anakin Skywalker': {
      common:    'WHEN PLAYED: Draw 1. Fear 1 an enemy. START OF TRICKS (once): Move and bonus attack. WHILE ACTIVE: Bonus attack on ally death.',
      rare:      'WHEN PLAYED: Draw 1. Fear 1 an enemy. START OF TRICKS (once): Move and bonus attack. WHILE ACTIVE: Bonus attack on ally death.',
      special:   'WHEN PLAYED: Draw 1. Fear 1 up to 2 enemies. START OF TRICKS (once): Move and bonus attack. WHILE ACTIVE: Bonus attack on ally death.',
      legendary: 'WHEN PLAYED: Draw 1. Fear 1 up to 3 enemies. START OF TRICKS (once): Move and bonus attack. WHILE ACTIVE: Bonus attack on ally death.',
    },
    'Galactus': {
      common:    'START OF TRICKS (once): Devour 1 enemy. EACH TURN: Devour any enemy with ≤ 4 ATK.',
      rare:      'START OF TRICKS (once): Devour 2 enemies. EACH TURN: Devour any enemy with ≤ 4 ATK.',
      special:   'START OF TRICKS (once): Devour 3 enemies. EACH TURN: Devour any enemy with ≤ 4 ATK.',
      legendary: 'START OF TRICKS (once): Devour 4 enemies. EACH TURN: Devour any enemy with ≤ 4 ATK.',
    },
    'Trigon': {
      common:    'WHEN PLAYED: Steal 50% of opponent\'s Block Meter. START OF TRICKS (once): Freeze 1 all enemies. WHILE ACTIVE: Chain destroy.',
      rare:      'WHEN PLAYED: Steal opponent\'s Block Meter. START OF TRICKS (once): Freeze 1 all enemies. WHILE ACTIVE: Chain destroy.',
      special:   'WHEN PLAYED: Steal opponent\'s Block Meter, max your own. START OF TRICKS (once): Freeze 1 all enemies. WHILE ACTIVE: Chain destroy.',
      legendary: 'WHEN PLAYED: Steal Block Meter, max your own, drain 2 HP from every enemy. START OF TRICKS (once): Freeze 1 all enemies. WHILE ACTIVE: Chain destroy.',
    },
    'Joker': {
      common:    'WHEN PLAYED: Fear 1 an enemy with cost ≤ 2. WHILE ACTIVE: Highest-ATK enemy is stamped Crazy. INSANE.',
      rare:      'WHEN PLAYED: Fear 1 an enemy with cost ≤ 4. WHILE ACTIVE: Highest-ATK enemy is stamped Crazy. INSANE.',
      special:   'WHEN PLAYED: Fear 1 an enemy with cost ≤ 6. WHILE ACTIVE: Highest-ATK enemy is stamped Crazy. INSANE.',
      legendary: 'WHEN PLAYED: Fear 1 an enemy with cost ≤ 9. WHILE ACTIVE: Highest-ATK enemy is stamped Crazy. INSANE.',
    },
    'Magneto': {
      common:    'WHEN PLAYED: Even-lane enemies get -1/-2. Force opponent\'s next 1 card placement.',
      rare:      'WHEN PLAYED: Even-lane enemies get -1/-2. Force opponent\'s next 2 card placements.',
      special:   'WHEN PLAYED: Even-lane enemies get -1/-2. Force opponent\'s next 3 card placements.',
      legendary: 'WHEN PLAYED: Even-lane enemies get -1/-2. Force opponent\'s next 4 card placements.',
    },
    'Sandman': {
      common:    'A pile of sand — no while-active effect (just a 1/3 body).',
      rare:      'WHILE ACTIVE: Enemy Tricks cost 1 more Energy.',
      special:   'WHILE ACTIVE: Enemy Tricks cost 2 more Energy.',
      legendary: 'WHILE ACTIVE: Enemy Tricks cost 3 more Energy.',
    },
    'Loki': {
      common:    'WHEN PLAYED: Fill your Block Meter by 50%.',
      rare:      'WHEN PLAYED: Fill your Block Meter to MAX.',
      special:   'WHEN PLAYED: Fill your Block Meter to MAX. Grant a random ally Evade 1.',
      legendary: 'WHEN PLAYED: Fill your Block Meter to MAX. Grant ALL allies Evade 1.',
    },
  },

  // Card-rarity drop weights at draft time. Most cards you see are
  // common (just base text); rares are notable, specials are punchy,
  // legendaries are the "I just topdecked god" moments. Each rarity
  // confers N starter etches, scaled by tier.
  // Per-act card-rarity drop weights. User direction (paraphrased):
  // "Act 1 should rarely show Special/Legendary, Act 3 should rarely
  // show Common." This tilts the reward curve so early-act picks feel
  // like grunts and late-act picks feel like jackpots.
  //   Act 1 — Common-heavy:    65 / 30 / 5 / 0
  //   Act 2 — balanced mid:    35 / 40 / 20 / 5
  //   Act 3 — Legendary-bias:   5 / 25 / 50 / 20
  // The legacy `CARD_DROP_WEIGHTS` field stays as a pre-act fallback
  // (used when act isn't passed, e.g. event-bridged rolls).
  CARD_DROP_WEIGHTS: { common: 60, rare: 25, special: 12, legendary: 3 },
  CARD_DROP_WEIGHTS_BY_ACT: {
    1: { common: 65, rare: 30, special: 5,  legendary: 0  },
    2: { common: 35, rare: 40, special: 20, legendary: 5  },
    3: { common: 5,  rare: 25, special: 50, legendary: 20 },
  },
  CARD_RARITY_ETCH_COUNT: { common: 0, rare: 1, special: 2, legendary: 3 },
  // Tiered XP thresholds — Common→Uncommon is fast (early commitment),
  // Uncommon→Rare medium, Rare→Legendary a real grind. Previous flat-ish
  // curve (40/120/280) made Legendary unreachable in a single run; the
  // new curve (30/80/160) lands a Legendary on a 4-5 fight commitment
  // for a card you actually use.
  XP_THRESHOLDS: { common: 30, rare: 80, special: 160 },
  TIERS: ['common', 'rare', 'special', 'legendary'],
  TIER_INDEX: { common: 0, rare: 1, special: 2, legendary: 3 },

  // ----- Run state init -----
  // Starter tricks — every run begins with a small utility trick set so
  // the trick phase isn't dead air during early fights. Pulled from the
  // existing TRICK_DEFS pool, weighted toward cheap utility (Bat Signal,
  // Mother Box, Bifrost). Players grow their trick hand from rewards.
  // 6 starter tricks (user spec): 2 Mother Box, 2 Smoke Pellet, 2
  // Kryptonite. Provides a stable utility kit — summon body, evade
  // buff, ATK debuff — without leaning on any one strong trick.
  STARTER_TRICK_NAMES: ['Mother Box', 'Mother Box', 'Smoke Pellet', 'Smoke Pellet', 'Kryptonite', 'Kryptonite'],

  // Helper: build a deckCard with a fresh stat roll. Centralizes the
  // shape so every code path (starter deck, rewards, boon adds, future
  // shop / event buys) gets the variance.
  // Build a deckCard: the run-state record for one card slot. No more
  // statRoll RNG — stats are derived from rarity tier at runtime via
  // _resolveStats. The `_isStarter` flag tags the 9 starter goons so
  // they keep their listed face stats regardless of tier. Starter
  // cards begin at "common" rarity but display at base stats (floor)
  // and can still level up to rare/special/legendary, gaining tier
  // bumps from there.
  _makeDeckCard(defName, rarity, statuses, isStarter) {
    return {
      defName,
      rarity: rarity || 'common',
      xp: 0,
      statuses: statuses || [],
      _isStarter: !!isStarter,
    };
  },

  initRun(boon) {
    // Starter deck: 3 of each vanilla body. User spec: "I want 3 Goon
    // (1/1), 3 Thug (2/2), 3 Brute (3/4)." Predictable like StS's
    // Strike/Defend opener — every run starts in the same shape so
    // the player can ramp around a known floor. _isStarter flag means
    // these cards never get the Common −1/−1 tier penalty.
    const starterDeck = [
      this._makeDeckCard('Goon',  'common', [], true),
      this._makeDeckCard('Goon',  'common', [], true),
      this._makeDeckCard('Goon',  'common', [], true),
      this._makeDeckCard('Thug',  'common', [], true),
      this._makeDeckCard('Thug',  'common', [], true),
      this._makeDeckCard('Thug',  'common', [], true),
      this._makeDeckCard('Brute', 'common', [], true),
      this._makeDeckCard('Brute', 'common', [], true),
      this._makeDeckCard('Brute', 'common', [], true),
    ];
    const starterTricks = this.STARTER_TRICK_NAMES.map(name => ({ defName: name, rarity: 'common' }));
    const run = {
      hp: 30, maxHp: 30,
      gold: (boon && boon.gold) || 50,
      deck: starterDeck,
      tricks: starterTricks,
      relics: [],
      currentNode: 0,
      currentRow: 0,
      totalRows: 6,
      act: 1,
      seed: Math.random().toString(36).slice(2, 10),
      boon: boon || null,
      pendingRewards: null,
      lastResult: null,
      // Lifetime run counters — surfaced on the end-of-run summary.
      // User polish suggestion: "Add a 'Run Complete' panel with total
      // gold earned, fights won, time taken, etc." Counters increment
      // in _onFightEnd and other state-mutation hooks.
      _stats: {
        startTime: Date.now(),
        fightsWon: 0,
        elitesWon: 0,
        bossesWon: 0,
        goldEarned: (boon && boon.gold) || 50,
        totalDamageDealt: 0,
        totalHpLost: 0,
      },
      // Snapshot of the ascension level at run start so save/resume
      // and the end-of-run summary can show what difficulty was used.
      ascension: this.currentAscension(),
    };
    // Ascension 2 used to nerf the player to 25 max HP. User feedback:
    // "Don't touch my max HP. Just make their max health more." A2 is
    // now an enemy-HP escalation (see ASCENSION_LEVELS above + the
    // ascHpMul step in buildAiEncounter). Player max HP starts at the
    // boon-defined value regardless of ascension level.
    if (boon) {
      if (boon.bonusCard) {
        run.deck.push(this._makeDeckCard(boon.bonusCard, 'rare'));
      }
      // startingHp = current HP value at run start.
      // startingMaxHp = max HP cap at run start. If a boon only sets
      // startingHp, the cap stays at the default 30 — so a 20-HP start
      // begins INJURED at 20/30 and can heal back up to 30. User
      // direction: "When you start with 20 HP, your max is 30. So if
      // you heal, you should be able to heal up to 30." Boons that
      // want to extend the cap (Robust → 40 max) set startingMaxHp
      // explicitly.
      if (boon.startingMaxHp != null) run.maxHp = boon.startingMaxHp;
      if (boon.startingHp != null)    run.hp    = boon.startingHp;
      if (boon.startingRelic) {
        // Use grantRelic so onAcquire fires (some relics adjust maxHp /
        // gold / charges on pickup — boon-granted ones must too).
        this.grantRelic(run, boon.startingRelic);
      }
    }
    return run;
  },

  // ----- Boons (run-start choices, Spire's Neow encounter) -----
  // Player picks one of four. Each is a meaningful trade-off — bigger
  // boons usually carry a downside or a future cost.
  BOONS: [
    {
      id: 'gold-purse',
      name: 'A Pouch of Coins',
      desc: 'Begin the run with +100 gold (150 total).',
      apply: () => ({ gold: 150 }),
    },
    {
      id: 'fragile-armor',
      name: 'Fragile Power',
      desc: 'Begin with 20 HP instead of 30, but with the Battery relic (+1 energy/round).',
      apply: () => ({ startingHp: 20, startingRelic: 'battery' }),
    },
    {
      id: 'hired-help',
      name: 'Hired Help',
      desc: 'Add a random Rare card (cost 1-2) to your starting deck.',
      apply: () => {
        // Roll a real (non-vanilla, non-starter) card with cost 1-2
        // and serve it as a Rare deck-card. Filtered to cost 1-2 so it
        // can land round 1 or 2 — a Rare 7-cost would be dead in hand
        // for the first half of Act 1.
        if (typeof CARD_DEFS === 'undefined') return {};
        const pool = CARD_DEFS.filter(d =>
          (d.cost || 0) >= 1 && (d.cost || 0) <= 2
          && !Roguelite.AI_VANILLA_DEFS.find(v => v.name === d.name)
          && !Roguelite.STARTER_DEFS.find(s => s.name === d.name)
        );
        if (!pool.length) return {};
        const pick = pool[Math.floor(Math.random() * pool.length)];
        return { hiredHelpCard: pick.name };
      },
    },
    {
      id: 'lifesteal-fang',
      name: "Vampire's Fang",
      desc: 'Begin with the Lifesteal relic — all your cards drain HP on hit.',
      apply: () => ({ startingRelic: 'vampire-fang' }),
    },
    {
      id: 'beefier',
      name: 'Robust',
      desc: 'Begin with 40 max HP (instead of 30).',
      apply: () => ({ startingHp: 40, startingMaxHp: 40 }),
    },
  ],

  // ----- Map graph generation (Slay-the-Spire-shaped, 3-act) -----
  // 18 rows total = 3 acts × 6 rows. Each act has its own boss row + a
  // pre-boss rest. Final boss sits at row 17 with no choice — it's the
  // climactic single fight. Tier scales by act: rows 0-5 = tier 1 pool,
  // 6-11 = tier 2, 12-17 = tier 3. The map renders scrollable so the
  // full 18-row track is visible by panning.
  // 7 rows × 3 acts = 21 total. User direction: "7 per act because
  // every act should have a treasure chest that contains a relic.
  // Plus one more fight node. So 21 total." Each act layout (top→bot):
  //   row 0   — entry combat row (3-4 nodes)
  //   row 1-3 — body (combat / event / shop / rest / elite mix)
  //   row 4   — TREASURE CHEST (guaranteed relic)
  //   row 5   — pre-boss rest stop
  //   row 6   — single boss (was 2 boss options)
  ACT_BOUNDS: [
    { act: 1, startRow: 0,  endRow: 6,  treasureRow: 4, bossRow: 6,  tier: 1 },
    { act: 2, startRow: 7,  endRow: 13, treasureRow: 11, bossRow: 13, tier: 2 },
    { act: 3, startRow: 14, endRow: 20, treasureRow: 18, bossRow: 20, tier: 3 },
  ],
  TOTAL_ROWS: 21,

  generateMap(run) {
    const ROWS = this.TOTAL_ROWS;
    const rng = () => Math.random();
    const nodes = [];
    let nextId = 0;
    const mk = (row, col, type, tier) => {
      const n = { id: nextId++, row, col, type, tier, edges: [] };
      nodes.push(n);
      return n;
    };

    // Generate each act's body identically. Pre-boss rest + boss row at
    // the end of acts 1 and 2; final-boss singleton at row 17.
    this.ACT_BOUNDS.forEach((act, actIdx) => {
      const tier = act.tier;
      const bodyStart = act.startRow;
      // Row layout per act (7 rows total):
      //   row 0          = entry (3-4 combat nodes)
      //   row 1..3       = body mix (combat/event/shop/rest/elite)
      //   row 4 (treasureRow)  = single TREASURE chest, guaranteed relic
      //   row 5          = pre-boss rest
      //   row 6 (bossRow)= single boss (or final-boss for act 3)
      const bodyEndRow = act.treasureRow - 1;

      // Row 0 — 3-4 entry combat nodes
      const startCount = 3 + Math.floor(rng() * 2);
      for (let c = 0; c < startCount; c++) {
        mk(bodyStart, c + Math.floor((5 - startCount) / 2), 'combat', tier);
      }
      // Body rows (1..3) — combat/event/shop/rest/elite mix
      for (let r = bodyStart + 1; r <= bodyEndRow; r++) {
        const count = 3 + Math.floor(rng() * 3); // 3-5 nodes
        const offset = Math.floor((5 - count) / 2);
        for (let c = 0; c < count; c++) {
          const roll = rng();
          let type;
          if (roll < 0.50) type = 'combat';
          else if (roll < 0.72) type = 'event';
          else if (roll < 0.85) type = 'shop';
          else if (roll < 0.95) type = 'rest';
          else type = 'elite';
          mk(r, c + offset, type, tier);
        }
      }
      // Guarantee at least one elite per act in the body rows. User
      // direction: "with elites, there should always be one elite per
      // act that you can fight, and that's a guaranteed common relic."
      // The combat-rewards path already grants the relic — see line
      // ~2607 (rollRelic('common') on elite win). All we need is to
      // make sure the random roll above didn't shut the player out of
      // the elite path entirely. If no elite landed, promote a random
      // body-row combat node to elite so the act always has the
      // guaranteed-relic detour available.
      const bodyNodes = nodes.filter(n => n.row >= bodyStart + 1 && n.row <= bodyEndRow);
      if (!bodyNodes.some(n => n.type === 'elite')) {
        const combats = bodyNodes.filter(n => n.type === 'combat');
        if (combats.length) {
          const pick = combats[Math.floor(rng() * combats.length)];
          pick.type = 'elite';
        }
      }
      // Treasure chest row — single centered relic node. User: "every
      // act should have a treasure chest that contains a relic."
      mk(act.treasureRow, 2, 'treasure', tier);
      // Pre-boss rest stop centered in the 5-col grid
      mk(act.endRow - 1, 2, 'rest', tier);
      // Boss row — ONE node per act now. User: "I want there to only
      // be one boss node. Just like Act 3 has one final boss."
      if (actIdx === 2) {
        mk(act.endRow, 2, 'final-boss', tier);
      } else {
        mk(act.endRow, 2, 'boss', tier);
      }
    });

    // Edges between consecutive rows. Bias toward column-proximity so the
    // graph reads as diagonal flowlines rather than random spaghetti.
    // Cross-act transitions: every act-boss edges into both row-0 entries
    // of the next act (forced single→multi fan-out).
    for (let r = 0; r < ROWS - 1; r++) {
      const here = nodes.filter(n => n.row === r);
      const next = nodes.filter(n => n.row === r + 1);
      if (!next.length) continue;
      here.forEach(n => {
        const sorted = next.slice().sort((a, b) => Math.abs(a.col - n.col) - Math.abs(b.col - n.col));
        n.edges.push(sorted[0].id);
        if (sorted.length > 1 && rng() < 0.5) n.edges.push(sorted[1].id);
        // Bosses fan out to ALL next-row entries (so both bosses lead
        // into Act 2 and the player can re-pick path)
        if (n.type === 'boss') {
          next.forEach(target => { if (!n.edges.includes(target.id)) n.edges.push(target.id); });
        }
      });
      // Reachability fix
      const reachable = new Set();
      here.forEach(n => n.edges.forEach(id => reachable.add(id)));
      next.forEach(n => {
        if (!reachable.has(n.id)) {
          const closest = here.slice().sort((a, b) => Math.abs(a.col - n.col) - Math.abs(b.col - n.col))[0];
          if (closest) closest.edges.push(n.id);
        }
      });
    }

    return { rows: ROWS, nodes };
  },

  // Pick the next legal nodes (those reachable from the current node).
  legalNextNodes(run) {
    if (!run || !run.map) return [];
    if (run.currentNodeId == null) {
      // Player hasn't picked an entry yet → all row-0 nodes are legal.
      return run.map.nodes.filter(n => n.row === 0);
    }
    const cur = run.map.nodes.find(n => n.id === run.currentNodeId);
    if (!cur) return [];
    return run.map.nodes.filter(n => cur.edges.includes(n.id));
  },

  // ----- Card builder: deck-card → runtime card instance -----
  // Pipeline:
  //   1. Look up base def (CARD_DEFS or STARTER_DEFS / AI_VANILLA_DEFS)
  //   2. Clone (don't mutate the source def)
  //   3. Apply tier-based stat bump (common −1, rare 0, special +1,
  //      legendary +2 — floored 1/1; starter cards skip the penalty)
  //   4. Build the runtime instance via Game.createCardInstance
  //   5. Apply each etch in order (stat bumps, keyword adds, cost mods)
  //   6. Tag the card with run metadata for XP attribution at fight end
  buildRunCard(deckCard, owner) {
    let def = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS.find(d => d.name === deckCard.defName) : null;
    if (!def) def = this.STARTER_DEFS.find(d => d.name === deckCard.defName);
    if (!def) def = this.AI_VANILLA_DEFS.find(d => d.name === deckCard.defName);
    if (!def && this.CURSE_DEFS) def = this.CURSE_DEFS.find(d => d.name === deckCard.defName);
    if (!def) {
      console.warn('Roguelite.buildRunCard: unknown card', deckCard.defName);
      return null;
    }
    // SHALLOW clone via Object.assign so callback functions (onPlay,
    // onDeath, passive, etc.) survive — JSON.parse(JSON.stringify(def))
    // drops every function field, which silently broke Goon's hive,
    // Thug's strike, and any other ability hook for starter cards.
    // Deep-copy the abilities array (only mutable list field we care
    // about) so etch-driven abilities.push doesn't mutate the source.
    //
    // Roguelite-only ability strip. User direction: "all status traits
    // need to be removed from the cards besides Revive — that's the
    // whole point, to get new status on cards and create more RNG."
    // So Bullseye, Hunt, Armor N, Taunt N, Evade N, Untrickable,
    // Overdrive, Splash N, Immunity, Invincible N, Unresistible, Crazy,
    // Insane all drop here for non-starter / non-curse cards. Etches +
    // level-ups + relics are how the player EARNS keywords back.
    //
    // Revive N stays (death-trigger identity is core for revivers).
    // Starter cards keep their baseline (Brute's Taunt 1) — that was
    // an explicit balance call. Curses have no abilities anyway.
    // STARTER ABILITY INTEGRITY GUARD. User report (multiple times):
    // "There's still a Brute in the deck that doesn't have Taunt 1.
    // How many times do we have to go over this? Fix it."
    //
    // Root cause: somewhere in the dead-pile → reshuffle → createCardInstance
    // chain, abilities arrays were drifting. Bulletproof fix: for any
    // card whose name matches a STARTER_DEFS entry, OR any deck-entry
    // tagged `_isStarter`, ALWAYS rebuild the abilities from the
    // canonical STARTER_DEFS source. This way even if `def.abilities`
    // got mutated, lost, or was pulled from a stale dead-pile entry,
    // every Brute we build is guaranteed to ship with `['Taunt 1']`.
    const starterDef = this.STARTER_DEFS.find(s => s.name === deckCard.defName);
    const isStarter  = deckCard._isStarter || !!starterDef;
    const rawAbilities = (isStarter && starterDef)
      ? [...(starterDef.abilities || [])]   // canonical — never trust runtime drift
      : [...(def.abilities || [])];
    const abilities = (isStarter || def._isCurse)
      ? rawAbilities
      : rawAbilities.filter(ab => /^Revive(\s|$)/i.test(ab));
    const clone = Object.assign({}, def, { abilities });
    // Apply tier-based stat bump BEFORE createCardInstance so the
    // engine's createCardInstance picks up the modified stats as
    // baseAttack/baseHealth. Starter cards bypass the Common penalty.
    const resolved = this._resolveStats(clone, deckCard.rarity, deckCard._isStarter);
    clone.attack = resolved.atk;
    clone.health = resolved.hp;
    const card = Game.createCardInstance(clone, owner);
    // Strip etches that don't belong on this card type. For discard-only
    // cards (Catwoman / Mr. Fantastic / Jigsaw / Professor X) only
    // energy + Text+ etches are valid — anything else (stat bumps,
    // trait keywords) was rolled by an old build before the discard
    // filter shipped. User report: "Mr. Fantastic showed up with
    // Evade 2 + Unresistible 1, doesn't make sense, he's not on the
    // board." Sanitizing here AND at codex/reward render time ensures
    // existing saves get cleaned without forcing a run reset.
    this._sanitizeDeckCardStatuses(deckCard);
    // Apply etches in order
    (deckCard.statuses || []).forEach(etchId => {
      const etch = this._findEtch(etchId);
      if (etch) try { etch.apply(card); } catch (e) { console.warn('Etch apply failed', etchId, e); }
    });
    // Apply relic-driven per-card transformations (Steel Heart →
    // Armor 1 on every card, Spider Web → Thorns 1 on every card,
    // Reality Stone → cost -1, etc.). Player-owned cards only — the
    // run is the player's, AI-side build paths come through different
    // routes (buildAiEncounter assembles raw defs, doesn't touch
    // relics).
    // Tag the card with its run metadata BEFORE the relic hook so
    // onCardBuild handlers (e.g. Smiling Mask, which keys off the
    // _isStarter flag on the deckCard) can read run-scoped fields off
    // the card. Order matters: was previously tagged after the hook,
    // but new relics need this context.
    card._runDeckCardRef = deckCard;
    card._runRarity = deckCard.rarity;
    if (owner === 'player') {
      const run = Game.state && Game.state.roguelite;
      if (run) this._applyRelicHook(run, 'onCardBuild', card);
    }
    // DISCARD-ONLY INVARIANT: cards with isDiscardEffect: true never
    // touch the board — they fire when discarded. Stat values are
    // meaningless for them. User direction: "Discards can't gain
    // stats. It can only be energy reduction. And text." So after
    // every etch + relic has run, force discard cards back to 0/0 so
    // a stray +1 ATK etch (rolled before this filter shipped) or a
    // global-stats relic (Whetstone, Bag of Marbles) can't paint them
    // with body stats. Splash/armor/etc. ALSO get cleared since the
    // card never enters a lane.
    if (this._isDiscardOnlyCard(deckCard.defName)) {
      card.attack = 0;
      card.baseAttack = 0;
      card.health = 0;
      card.baseHealth = 0;
      card.maxHealth = 0;
      card.currentHealth = 0;
      card.armorValue = 0;
      card.evadeCharges = 0;
      card.splashRange = 0;
      card.tauntTurns = 0;
    }
    // Curse flag — Game.createCardInstance doesn't pass through arbitrary
    // def fields, so re-stamp it from the def/deckCard. The dim purple
    // tint, deck-removal hint, and tier-bypass logic all key off this.
    if (def._isCurse || deckCard._isCurse) card._isCurse = true;
    // PER-RARITY DESCRIPTION SWAP. For cards in RARITY_DESCS (Mr. Freeze,
    // Hawkeye, Black Widow, etc.), the rarity tier widens the actual
    // behavior — Mr. Freeze legendary freezes 3 lanes via rarityValue
    // — but the def's classic desc still reads "Freeze 1 the enemy
    // opposite". User report: "Card text says Freeze 1, but it acted
    // like a splash freeze. The text didn't say that. This isn't the
    // interaction I wanted." Fix: pull the rarity-scaled variant onto
    // card.desc so the in-game render and tooltips match what actually
    // happens. Codex / deck list / reward picker already do their own
    // RARITY_DESCS lookup; this aligns the in-lane render with that.
    const variantDescs = this.RARITY_DESCS && this.RARITY_DESCS[deckCard.defName];
    if (variantDescs && variantDescs[deckCard.rarity]) {
      card.desc = variantDescs[deckCard.rarity];
    }
    return card;
  },

  _findEtch(etchId) {
    for (const tier of Object.keys(this.ETCHES)) {
      const e = this.ETCHES[tier].find(x => x.id === etchId);
      if (e) return e;
    }
    // Also check the per-card Text+ table — those upgrade definitions
    // are stored by card name but each has a unique id we can match.
    if (this.CARD_TEXT_UPGRADES) {
      for (const name of Object.keys(this.CARD_TEXT_UPGRADES)) {
        const u = this.CARD_TEXT_UPGRADES[name];
        if (u && u.id === etchId) return u;
      }
    }
    return null;
  },

  // ----- Reward pool: 3 random cards from the current act tier -----
  // Each candidate is rolled at a rarity weight (60/25/12/3) and pre-
  // populated with the appropriate number of starter etches. So a draft
  // can hand you a Common Gamora (just base text, green border), a Rare
  // Gamora (1 etch, blue border), or a Legendary Gamora (3 etches, gold
  // border). The visual rarity is the tell — same Gamora, very different
  // pull strengths.
  rollRewards(act, opts) {
    opts = opts || {};
    if (typeof CARD_DEFS === 'undefined') return [];
    // Exclude roguelite-only entries (starters Goon/Thug/Brute, AI vanilla
    // Soldier/Mercenary/Operator, curses Wound/Doubt/Regret) from the
    // reward pool. They live in CARD_DEFS so the engine can name-resolve
    // them during a run, but they shouldn't appear as card rewards.
    // User report: "one of the brutes doesn't have taunt 1" — turned out
    // a non-starter Brute got pulled from rewards and the baseline
    // keyword strip in buildRunCard nuked its Taunt 1 (only starters
    // are exempt from the strip).
    const isRL = (n) => this.isRogueliteOnlyName(n);
    let pool;
    if (act === 1) {
      pool = CARD_DEFS.filter(c => (c.cost || 0) <= 4 && !isRL(c.name));
    } else if (act === 2) {
      pool = CARD_DEFS.filter(c => (c.cost || 0) >= 3 && (c.cost || 0) <= 7 && !isRL(c.name));
    } else {
      pool = CARD_DEFS.filter(c => (c.cost || 0) >= 5 && !isRL(c.name));
    }
    const count = opts.count || 3;
    const out = [];
    const usedNames = new Set();
    let attempts = 0;
    while (out.length < count && attempts < 50) {
      attempts++;
      const def = pool[Math.floor(Math.random() * pool.length)];
      if (usedNames.has(def.name)) continue;
      usedNames.add(def.name);
      const rarity = this._rollRarity(opts.rarityFloor, act);
      const deckCard = this._makeDeckCard(def.name, rarity, this._rollEtchesForRarity(rarity, def.name));
      // Reference to the def for the reward picker UI (cost, stats, desc).
      deckCard._def = def;
      out.push(deckCard);
    }
    return out;
  },

  // Rarity dice — weighted roll. Uses per-act weights when an act is
  // provided so Act 1 leans Common and Act 3 leans Legendary; falls
  // back to the flat CARD_DROP_WEIGHTS when no act passed (for events
  // that bridge between rewards).
  _rollRarity(floor, act) {
    const tiers = ['common', 'rare', 'special', 'legendary'];
    const w = (act && this.CARD_DROP_WEIGHTS_BY_ACT && this.CARD_DROP_WEIGHTS_BY_ACT[act])
      || this.CARD_DROP_WEIGHTS;
    const startIdx = floor ? this.TIER_INDEX[floor] : 0;
    let total = 0;
    for (let i = startIdx; i < tiers.length; i++) total += (w[tiers[i]] || 0);
    if (total <= 0) return tiers[startIdx];
    let roll = Math.random() * total;
    for (let i = startIdx; i < tiers.length; i++) {
      roll -= (w[tiers[i]] || 0);
      if (roll <= 0) return tiers[i];
    }
    return tiers[startIdx];
  },

  // Pre-populate etches based on the rolled rarity. A rare gets 1 random
  // etch from common/rare; a legendary gets 3 from any tier.
  // Discard-only check — cards like Catwoman / Mr. Fantastic / Jigsaw
  // / Professor X have isDiscardEffect: true in CARD_ABILITIES and never
  // enter a lane. Stat / trait etches are pointless on them, so the
  // rolling and picking flows below restrict their etch pool to energy
  // (cost reduction) + text (per-card effect upgrades) only.
  _isDiscardOnlyCard(defName) {
    if (!defName || typeof CARD_ABILITIES === 'undefined') return false;
    const ab = CARD_ABILITIES[defName];
    return !!(ab && ab.isDiscardEffect);
  },

  // Resolve which rarity tier (common / rare / special / legendary) an
  // etch ID lives in — drives the level-up picker border coloring. User
  // direction: "I don't want HP to always be green and trait to always
  // be blue and energy always to be gold. I want it based on the rarity
  // of the etch you get." So a +1 ATK (common tier) shows a green
  // border, +2/+2 (rare) shows cyan, +3/+3 (special) white, +4/+4
  // (legendary) gold. Card-specific Text+ entries map to legendary
  // since they're the rare-jackpot pull.
  _etchTier(etchId) {
    if (!etchId || !this.ETCHES) return 'common';
    for (const tier of this.TIERS) {
      const list = this.ETCHES[tier];
      if (list && list.some(e => e.id === etchId)) return tier;
    }
    if (this.CARD_TEXT_UPGRADES) {
      for (const name in this.CARD_TEXT_UPGRADES) {
        const u = this.CARD_TEXT_UPGRADES[name];
        if (u && u.id === etchId) return 'legendary';
      }
    }
    return 'common';
  },

  // Strip etches that don't belong on a discard-only card. For Catwoman,
  // Mr. Fantastic, Jigsaw, and Professor X, only energy etches and
  // card-specific Text+ entries are kept; stat bumps and trait keywords
  // are removed. Idempotent — safe to call multiple times. Mutates the
  // deckCard's statuses array in place. No-op for non-discard cards.
  // User report: stale Evade 2 + Unresistible 1 on Mr. Fantastic from a
  // run started before the discard filter shipped.
  _sanitizeDeckCardStatuses(deckCard) {
    if (!deckCard || !this._isDiscardOnlyCard(deckCard.defName)) return;
    if (!Array.isArray(deckCard.statuses) || !deckCard.statuses.length) return;
    const textEtch = this.cardTextUpgrade(deckCard.defName);
    const allowedTextId = textEtch ? textEtch.id : null;
    deckCard.statuses = deckCard.statuses.filter(id => {
      if (this._isEnergyEtch(id)) return true;
      if (allowedTextId && id === allowedTextId) return true;
      return false;
    });
  },

  _rollEtchesForRarity(rarity, defName) {
    const count = this.CARD_RARITY_ETCH_COUNT[rarity] || 0;
    if (!count) return [];
    // Build a pool of etch IDs allowed at this rarity (current tier
    // plus all lower tiers).
    const tierIdx = this.TIER_INDEX[rarity];
    let allowed = [];
    for (let i = 0; i <= tierIdx; i++) {
      const t = this.TIERS[i];
      this.ETCHES[t].forEach(e => allowed.push(e.id));
    }
    // Discard-only cards: drop stat-bump and trait etches from the
    // pool. Keep energy (discount-N) only — these are the only etches
    // that meaningfully change a card that never enters the board.
    // Card-specific Text+ entries (CARD_TEXT_UPGRADES) are NOT in the
    // ETCHES tier lists; they get surfaced through the level-up picker
    // separately (see _rollLevelUpChoices), so this filter doesn't
    // need to consider them.
    if (this._isDiscardOnlyCard(defName)) {
      allowed = allowed.filter(id => this._isEnergyEtch(id));
    }
    const out = [];
    while (out.length < count && allowed.length > 0) {
      const pick = allowed[Math.floor(Math.random() * allowed.length)];
      if (out.includes(pick)) continue;
      out.push(pick);
    }
    // STARTER TEXT+ ROLL — small chance that a higher-rarity reward
    // card lands with its card-specific Text+ etch ALREADY APPLIED.
    // User direction: "When you select the card from a card reward,
    // they can't have a text change in them as an upgrade — they can
    // come pre-loaded with one. So if you get a legendary Grinch, it
    // could be he got a stat increase, a discount, AND maybe his
    // tricks-cost-less. Each time you see a card it could have gotten
    // a Text+. Now it's rare to have that happen, but it could."
    //
    // Rarity-scaled odds — common can't roll Text+ (zero starter etches
    // anyway), legendary has the best shot:
    //   common    → 0% (no starter etch slots)
    //   rare      → 5%   (1 etch slot)
    //   special   → 10%  (2 etch slots — better odds, more interesting cards)
    //   legendary → 20%  (3 etch slots — the jackpot pull)
    //
    // When it triggers we REPLACE one of the rolled etches (not add a
    // new slot) so the total power level matches the rarity tier —
    // a legendary Grinch with Text+ has 2 stat/trait etches + Text+,
    // not 3 stat/trait etches + Text+.
    const textEtch = this.cardTextUpgrade(defName);
    if (textEtch && out.length > 0) {
      const textChance = { rare: 0.05, special: 0.10, legendary: 0.20 }[rarity] || 0;
      if (Math.random() < textChance) {
        const slot = Math.floor(Math.random() * out.length);
        out[slot] = textEtch.id;
      }
    }
    return out;
  },

  // Stat-roll variance per drawn card. User spec: "Batman is a 7/5 base.
  // Damage and health are variables we can play with. ±2 range. So he
  // could be a 5/3 (bad roll) or a 9/7 (insane). Same for the vanilla
  // bodies." Higher rarity = upside-skewed roll so a Legendary is rarely
  // ----- Tier-based stat bumps (replaces RNG variance) -----
  // User direction: "drop the RNG, base stats = rare value, common is
  // a downgrade, legendary is upgraded." Deterministic progression so
  // players can read their deck at a glance and feel earned upgrades:
  //
  //   common    → base −1 ATK, base −1 HP   (floor at 1/1)
  //   rare      → base values exactly (the "true" listed stats)
  //   special   → base +1 ATK, base +1 HP
  //   legendary → base +2 ATK, base +2 HP
  //
  // Starter deck cards (Goon/Thug/Brute) are TAGGED `_isStarter` so
  // they bypass the Common −1/−1 penalty and display at face stats —
  // user spec: "starter deck should all have just their baseline stats
  // shouldn't be increased or decreased."
  STAT_TIER_BUMP: {
    common:    -1,
    rare:       0,
    special:    1,
    legendary:  2,
  },
  // Final stat = base + tierBump (for both ATK and HP), floored at
  // ATK 1 and HP 1 so even a Common version of a 1/1 Goon stays
  // playable. `isStarter` only skips the COMMON tier's −1 penalty —
  // starter cards still gain stat bumps when leveled to special /
  // legendary, so progression on the starter deck still feels like
  // progression. (User: "starter deck should have baseline stats.")
  //
  // 0-base passive cards (Mr. Fantastic 0/0, Vision 0/3, Captain
  // America 0/8, etc.) NEVER scale: those zeros are a design signal
  // that the card is a totem / aura source, not a combatant. User
  // direction: "Discards can't gain health or damage stats — saw
  // Mr. Fantastic as a reward with stats, that can't happen." Each
  // axis is gated independently so a 0/3 Vision keeps 0 ATK but
  // still scales HP (3 → 4 → 5 etc.) on tier-up.
  _resolveStats(def, rarity, isStarter) {
    const baseAtk = def.attack || 0;
    const baseHp = def.health || 0;
    // Curses bypass tier scaling entirely — they're a fixed dud-shape
    // by design. Only thing variable is whether the player decides to
    // pay the cost to remove them at the Merchant.
    if (def._isCurse) {
      return { atk: baseAtk, hp: Math.max(1, baseHp) };
    }
    let bump = this.STAT_TIER_BUMP[rarity] != null ? this.STAT_TIER_BUMP[rarity] : 0;
    if (isStarter && bump < 0) bump = 0; // starter cards bypass the Common penalty only
    return {
      atk: baseAtk === 0 ? 0 : Math.max(1, baseAtk + bump),
      hp:  baseHp  === 0 ? 0 : Math.max(1, baseHp  + bump),
    };
  },

  // ----- AI deck + difficulty for a node -----
  // Returns { deckNames, tricks, hp, difficulty, persona } per node so
  // Game.startMatch (when wired) can build the AI side of the fight.
  // Difficulty curve, designed to feel like a Spire-flavored ramp:
  //
  //   NODE TYPE       AI HP      DIFF       DECK POOL                    TRICKS
  //   ─────────────────────────────────────────────────────────────────────────
  //   combat (Act 1)   25       easy        cost 1-4, no legendaries     2 cheap
  //   combat (Act 2)   30       normal      cost 2-6                     3
  //   combat (Act 3)   35       normal      cost 3-8                     4
  //   elite            +10 hp   hard        same act pool + 1 elite-only 5
  //   shop / event     —        —           (no fight)                   —
  //   rest             —        —           (no fight)                   —
  //   boss (Act 1)     45       hard        themed: Lex Luthor "control" handcrafted
  //   boss (Act 2)     55       hard        themed: Doctor Doom "summon" handcrafted
  //   final-boss       80       hard        themed: Galactus "devour"    handcrafted
  //
  // Theme decks are designed by hand — see BOSS_DECKS below. All other
  // decks are randomly drawn from the act-tier pool (2 copies max per name).
  // Per-act boss preview metadata. Surface at the top of the map so
  // the player can plan their route around the boss's archetype. User
  // direction: "Slay the Spire-shaped polish — boss preview banner."
  BOSS_PREVIEWS: {
    1: { key: 'act1-luthor',  persona: 'Lex Luthor', archetype: 'Control',
         flavor: 'Locks down lanes, fears your high-cost cards, snipes your low-HP bodies. Pack ATK debuff and Bullseye.',
         hpRange: '28–38',
         signature: ['Lex Luthor', 'Joker', 'Magneto'] },
    2: { key: 'act2-doom',    persona: 'Doctor Doom', archetype: 'Summon Swarm',
         flavor: 'Floods the board with Doombots and revives. Pack lane denial, Splash, and direct destroy.',
         hpRange: '40–55',
         signature: ['Doctor Doom', 'Hela', 'Mother Box'] },
    3: { key: 'act3-galactus', persona: 'Galactus', archetype: 'Devour / Cosmic',
         flavor: 'Devours weak cards, drops 10-cost titans, slows energy. Pack Untrickable and Armor.',
         hpRange: '70–90',
         signature: ['Galactus', 'Trigon', 'Cosmic Cube'] },
  },

  BOSS_DECKS: {
    'act1-luthor': {
      persona: 'Lex Luthor',
      deck: [
        'Lex Luthor', 'Lex Luthor',
        'Bane', 'Bane',
        'Sandman', 'Sandman',
        'Joker',
        'Loki', 'Loki',
        'Solomon Grundy', 'Solomon Grundy',
        'Magneto',
        'Catwoman', 'Catwoman',
        'Carnage', 'Carnage',
        'Red Skull',
        'Drax', 'Drax',
        'Deathstroke',
        'Sabertooth', 'Sabertooth',
        'King Shark', 'King Shark',
        'Harley Quinn', 'Harley Quinn',
        'Jango Fett', 'Jango Fett',
        'Winter Soldier',
        'Green Goblin',
      ],
      tricks: ['Smoke Pellet', 'Anti-Life Equation', 'Joker\'s Playing Card', 'Fear Toxin', 'Bat Signal'],
    },
    'act2-doom': {
      persona: 'Doctor Doom',
      deck: [
        'Dr. Doom', 'Dr. Doom',
        'Hela', 'Hela',
        'Knull',
        'Aquaman', 'Aquaman',
        'Cyborg', 'Cyborg',
        'Hulk', 'Hulk',
        'Ultron', 'Ultron',
        'Magneto',
        'Anti-Venom',
        'Venom', 'Venom',
        'Wolverine', 'Wolverine',
        'Spider-Man',
        'Iron Man',
        'Predator', 'Predator',
        'Thor',
        'Black Panther',
        'Optimus Prime',
        'Carnage',
        'Deathstroke',
        'Darkseid',
      ],
      tricks: ['Lazarus Pit', 'Soul Stone', 'Vibranium', 'Mother Box', 'Mobius Chair'],
    },
    'act3-galactus': {
      persona: 'Galactus',
      deck: [
        'Galactus', 'Galactus',
        'Knull', 'Knull',
        'Trigon',
        'Dr. Manhattan',
        'Anakin Skywalker',
        'Dormammu',
        'Thanos', 'Thanos',
        'Superman',
        'Batman',
        'Darkseid', 'Darkseid',
        'Emperor Palpatine', 'Emperor Palpatine',
        'Darth Vader', 'Darth Vader',
        'Luke Skywalker',
        'Yoda',
        'Gojo',
        'Gorr',
        'Mahoraga',
        'Hulk',
        'Hela',
        'Iron Man',
      ],
      tricks: ['Phantom Zone', 'Power Battery', 'Eye of Agamotto', 'Cosmic Cube', 'Infinity Gauntlet'],
    },
  },

  // Hand-crafted etches per boss signature card. User feedback: "I
  // got a 24/33 Grinch via the trick-return combo. Do enemies get
  // cards like this?" — they didn't. Now they do, scaled per act so
  // the boss matchup actually contests a buffed player deck.
  //
  // These etches are APPLIED ON TOP OF the per-act base rarity bump
  // applied in buildAiEncounter (Act 1 boss = rare base / Act 2 = special /
  // Act 3 = legendary). So Act 3 Galactus = legendary base (+2/+2 stats)
  // + the etches listed below = the strongest single body in the run.
  //
  // Cards NOT in the map for a given boss still get the base rarity
  // bump (no extra etch), so even unlisted Galactus cards land at a
  // healthier level than today's raw-stats AI.
  BOSS_DECK_ETCHES: {
    'act1-luthor': {
      'Lex Luthor':     ['armor-1'],          // tankier draw-blocker
      'Joker':          ['plus1-atk'],        // chaos pressure
      'Magneto':        ['plus1-atk-hp'],     // signature secondary
      'Solomon Grundy': ['plus1-hp'],         // bigger bag of stats
    },
    'act2-doom': {
      'Dr. Doom':   ['plus2-atk-hp'],         // signature presence
      'Hela':       ['echo'],                 // doubles her hand-spam
      'Magneto':    ['plus1-atk-hp'],
      'Knull':      ['plus1-atk-hp'],
      'Iron Man':   ['plus1-atk-hp'],
      'Hulk':       ['plus1-hp'],
    },
    'act3-galactus': {
      'Galactus':           ['plus2-atk-hp', 'echo'],   // signature double-tap
      'Trigon':             ['plus2-atk-hp'],
      'Knull':              ['plus2-atk-hp'],
      'Dr. Manhattan':      ['plus1-atk-hp'],
      'Darth Vader':        ['plus1-atk-hp'],
      'Emperor Palpatine':  ['plus1-atk-hp'],
      'Thanos':             ['plus1-atk-hp'],
      'Anakin Skywalker':   ['plus1-atk-hp'],
    },
  },

  // Vanilla-strength AI bodies — direct mirror of the player's starter
  // deck (Goon/Thug/Brute) so Act 1 fights feel like grunts on grunts.
  // User spec: "First couple fights, have them only have like, three
  // real 1-3 cost cards in the game and the rest be Soldier, Mercenary,
  // Operator. Similar to how Goon, Thug, and Brute act."
  AI_VANILLA_DEFS: [
    { name: 'Soldier',   cost: 1, attack: 1, health: 1, type: 'villain', abilities: [], desc: '' },
    { name: 'Mercenary', cost: 2, attack: 2, health: 2, type: 'villain', abilities: [], desc: '' },
    { name: 'Operator',  cost: 3, attack: 3, health: 4, type: 'villain', abilities: [], desc: '' },
  ],
  // Inject the vanilla defs into CARD_DEFS once on module init so the
  // engine's name-lookup expand resolves them without any special path.
  _ensureVanillaDefsRegistered() {
    if (this._vanillaRegistered) return;
    if (typeof CARD_DEFS === 'undefined') return;
    this.AI_VANILLA_DEFS.forEach(def => {
      if (!CARD_DEFS.find(d => d.name === def.name)) CARD_DEFS.push(def);
    });
    // Same for the player's starter goons — they need to be in CARD_DEFS
    // so summoned/peek/Lazarus references resolve consistently.
    this.STARTER_DEFS.forEach(def => {
      if (!CARD_DEFS.find(d => d.name === def.name)) CARD_DEFS.push(def);
    });
    // Re-merge CARD_ABILITIES onto the freshly-registered defs.
    // abilities.js's load-time `CARD_DEFS.forEach(...)` ran BEFORE
    // these were added, so callbacks (Goon's onPlay/onDeath, Thug's
    // damage prompt, etc.) wouldn't have landed without this step.
    if (typeof CARD_ABILITIES !== 'undefined') {
      [...this.AI_VANILLA_DEFS, ...this.STARTER_DEFS].forEach(def => {
        const liveDef = CARD_DEFS.find(d => d.name === def.name);
        if (!liveDef) return;
        const ab = CARD_ABILITIES[def.name];
        if (ab) Object.assign(liveDef, ab);
      });
    }
    this._vanillaRegistered = true;
  },

  // HP is rolled in a range per node tier so each fight feels different
  // — sometimes a 9-HP weakling, sometimes a 17-HP brawler. User spec:
  // "I don't think the enemy should always have the same health. It
  // should always be a little bit different." randInRange(min, max) is
  // inclusive on both sides.
  _randInRange(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  },

  buildAiEncounter(node, run) {
    if (typeof CARD_DEFS === 'undefined') return null;
    this._ensureVanillaDefsRegistered();
    // Ascension difficulty multiplier — A1+ adds 10% enemy HP across
    // the board. A4 adds an extra trick to bosses.
    const asc = (run && run.ascension) || 0;
    // Ascension HP scaling — stacks each tier. A1 = +10%, A2 = +20%
    // (was +10% with a player-HP nerf at A2; user moved the difficulty
    // onto the enemy side instead). Higher tiers stay at 1.20× because
    // A3 / A4 attach their own difficulty levers (relic pool, trick
    // count) — bumping enemy HP further would compound too aggressively.
    let ascHpMul = 1.0;
    if (asc >= 1) ascHpMul = 1.10;
    if (asc >= 2) ascHpMul = 1.20;
    // Boss / final-boss — handcrafted decks (full power) with a small
    // HP wobble so even bosses don't always read the same. AI cards
    // come pre-built via _buildAiCardInstances with a per-act base
    // rarity bump + signature etches from BOSS_DECK_ETCHES so a Doom
    // / Galactus body actually contests a buffed player late-game.
    if (node.type === 'final-boss') {
      const key = 'act3-galactus';
      const t = this.BOSS_DECKS[key];
      const hp = Math.floor(this._randInRange(70, 90) * ascHpMul);
      const tricks = t.tricks.slice();
      if (asc >= 4 && tricks.length) tricks.push(tricks[Math.floor(Math.random() * tricks.length)]);
      const cardInstances = this._buildAiCardInstances(t.deck, {
        bossKey: key,
        baseRarity: 'legendary',  // Galactus' deck = +2/+2 base on every card
      });
      return { deckNames: t.deck.slice(), cardInstances, tricks, hp, difficulty: 'hard', persona: t.persona };
    }
    if (node.type === 'boss') {
      const key = node.tier === 1 ? 'act1-luthor' : 'act2-doom';
      const t = this.BOSS_DECKS[key];
      const baseHp = node.tier === 1 ? this._randInRange(28, 38) : this._randInRange(40, 55);
      const hp = Math.floor(baseHp * ascHpMul);
      const tricks = t.tricks.slice();
      if (asc >= 4 && tricks.length) tricks.push(tricks[Math.floor(Math.random() * tricks.length)]);
      const cardInstances = this._buildAiCardInstances(t.deck, {
        bossKey: key,
        baseRarity: node.tier === 1 ? 'rare' : 'special',
      });
      return { deckNames: t.deck.slice(), cardInstances, tricks, hp, difficulty: 'normal', persona: t.persona };
    }
    // Random fight — scaled by tier. Tier 1 follows a strict spec:
    // exactly 3 real (cost 1-3) cards, rest are vanilla bodies. So the
    // player's Goon/Thug/Brute starter has a parity opener to fight
    // before they ramp into real threats. Tier 2 mixes 30% vanilla
    // 70% real (cost 2-5). Tier 3 is full pool, cost 3-8.
    let costMin, costMax, hpMin, hpMax, difficulty, trickCount;
    if (node.tier === 1) {
      // Tier 1 HP nudged down (was 9-17). With baseline keyword strip
      // applied to the player's deck (no Bullseye / Hunt / Splash on
      // baseline cards), early fights need a slightly lower ceiling
      // so a 1/1 Goon line can actually finish a fight in 4-5 rounds.
      costMin = 1; costMax = 3; hpMin = 8;  hpMax = 14; difficulty = 'easy';   trickCount = 1;
    } else if (node.tier === 2) {
      costMin = 2; costMax = 5; hpMin = 17; hpMax = 30; difficulty = 'normal'; trickCount = 2;
    } else {
      costMin = 3; costMax = 8; hpMin = 25; hpMax = 45; difficulty = 'normal'; trickCount = 3;
    }
    let hp = this._randInRange(hpMin, hpMax);
    if (node.type === 'elite') { hp += this._randInRange(8, 14); difficulty = 'hard'; trickCount += 1; }
    // Apply ascension HP multiplier to regular + elite fights.
    if (ascHpMul > 1) hp = Math.floor(hp * ascHpMul);

    // Tier 1 vanilla pool excludes Operator (3/4). User feedback:
    // "too many operators for the opponent in the first couple rounds —
    // it's hard to kill the AI." With round 2 = 4 energy, the AI was
    // dropping Operator (3/4) + Soldier (1/1) every round, which the
    // player's starter Goons (1/1) and Thugs (2/2) couldn't match.
    // Restricting tier 1 to Soldier + Mercenary keeps early fights
    // tractable; Operator returns at tier 2+ when the player has
    // upgraded cards, etches, and tricks to handle 3/4 bodies.
    const vanillaPool = this.AI_VANILLA_DEFS.filter(c => {
      if (c.cost < costMin || c.cost > costMax) return false;
      if (node.tier === 1 && c.name === 'Operator') return false;
      return true;
    });
    const realPool = CARD_DEFS.filter(c =>
      (c.cost || 0) >= costMin && (c.cost || 0) <= costMax
      && !this.AI_VANILLA_DEFS.find(v => v.name === c.name)
      && !this.STARTER_DEFS.find(s => s.name === c.name)
    );
    const counts = {};
    const deck = [];
    const pickFrom = (pool) => pool[Math.floor(Math.random() * pool.length)];
    if (node.tier === 1) {
      // Tier 1: pick 3 unique real cards (cost 1-3), then fill the
      // remaining 27 slots from the vanilla pool. Cap each card at 2
      // copies so a deck doesn't read as "Soldier × 27".
      const realPicks = new Set();
      while (realPicks.size < 3 && realPool.length > realPicks.size) {
        const pick = pickFrom(realPool);
        if (!realPicks.has(pick.name)) realPicks.add(pick.name);
      }
      Array.from(realPicks).forEach(n => deck.push(n));
      // Soft cap per vanilla so a deck doesn't read as "Soldier × 27"
      // — but the cap has to be loose enough that the deck can still
      // reach 30 cards. After excluding Operator from tier 1 (so the
      // pool is just Soldier + Mercenary), the old cap=12 made the
      // loop infinite (max fill = 24, target = 27 leftover). Cap
      // bumped to ⌈(target / pool.length) + 2⌉ so it always converges,
      // and we break out when every pool member is at cap.
      const target = 30 - deck.length;
      const cap = Math.ceil(target / Math.max(1, vanillaPool.length)) + 2;
      while (deck.length < 30 && vanillaPool.length) {
        const allCapped = vanillaPool.every(v => (counts[v.name] || 0) >= cap);
        if (allCapped) break;
        const pick = pickFrom(vanillaPool);
        if ((counts[pick.name] || 0) >= cap) continue;
        counts[pick.name] = (counts[pick.name] || 0) + 1;
        deck.push(pick.name);
      }
    } else {
      // Tier 2/3: weighted-mix the two pools; cap real cards at 2 each.
      const vanillaRatio = node.tier === 2 ? 0.30 : 0;
      while (deck.length < 30 && (vanillaPool.length || realPool.length)) {
        const useVanilla = Math.random() < vanillaRatio;
        const pool = useVanilla && vanillaPool.length ? vanillaPool : (realPool.length ? realPool : vanillaPool);
        if (!pool.length) break;
        const pick = pickFrom(pool);
        counts[pick.name] = (counts[pick.name] || 0) + 1;
        if (counts[pick.name] > 2) continue;
        deck.push(pick.name);
      }
    }
    // Tricks — use only basic cheap utility tricks for early acts so
    // a tier-1 AI doesn't suddenly drop a Bat Signal + Cosmic Cube.
    const trickAllowList = node.tier === 1
      ? ['Bat Signal', 'Mother Box', 'Bifrost', 'Smoke Pellet']
      : node.tier === 2
        ? ['Bat Signal', 'Mother Box', 'Bifrost', 'Smoke Pellet', 'Vibranium', 'Mobius Chair', 'Fear Toxin']
        : null;  // tier 3 → any trick
    const trickPool = (typeof TRICK_DEFS !== 'undefined')
      ? TRICK_DEFS.filter(t => (t.cost || 0) <= costMax + 1
          && (!trickAllowList || trickAllowList.includes(t.name)))
      : [];
    const tricks = [];
    while (tricks.length < trickCount && trickPool.length > 0) {
      const pick = trickPool[Math.floor(Math.random() * trickPool.length)];
      if (!tricks.includes(pick.name)) tricks.push(pick.name);
    }
    // Per-tier AI rarity scaling — gives a small chunk of the AI deck
    // bumped stats so a buffed player late-game has someone to fight.
    // User feedback: "I got a 24/33 Grinch, do enemies get cards like
    // this?" Tier 1 stays gentle (pure vanilla feel), tier 2 sprinkles
    // rare bumps, tier 3 sprinkles rare + occasional special. Vanilla
    // bodies (Soldier/Mercenary/Operator) skip promotion — they stay
    // in their identity as raw bodies.
    let cardInstances = null;
    if (node.tier >= 2) {
      cardInstances = this._buildAiCardInstances(deck, {
        // Tier 2: 20% rare, no special. Tier 3: 30% rare, 10% special.
        rareChance: node.tier === 2 ? 0.20 : 0.30,
        specialChance: node.tier === 3 ? 0.10 : 0,
        // Elite scales tighter — +10% to both odds — so the relic-
        // payoff route still feels like a serious fight.
        eliteBoost: node.type === 'elite',
        skipNames: this.AI_VANILLA_DEFS.map(d => d.name),
      });
    }
    return { deckNames: deck, cardInstances, tricks, hp, difficulty, persona: 'AI' };
  },

  // ----- AI deck instance builder ------------------------------------
  // Turns a deck of names into an array of pre-built card instances
  // with per-card rarity bumps and (optional) signature etches. The
  // engine accepts these via aiDeck.cardInstances (game.js line ~824).
  //
  // Two scaling modes:
  //   • Boss decks: opts.bossKey + opts.baseRarity. Every card gets
  //     baseRarity (so all Doom/Galactus cards land at rare/special/
  //     legendary), and any name in BOSS_DECK_ETCHES[bossKey] also
  //     receives those etches. Result: Galactus = legendary base
  //     (+2/+2) + ['plus2-atk-hp', 'echo'] = a 12 ATK / 14 HP body
  //     that fires twice. Player Grinch territory.
  //   • Regular tier-2/3 fights: opts.rareChance / opts.specialChance.
  //     Each card rolls independently. Vanilla bodies (skipNames) are
  //     never promoted — they stay raw 1/1 / 2/2 / 3/4. Etches not
  //     applied here, just rarity stat bump.
  _buildAiCardInstances(deckNames, opts) {
    opts = opts || {};
    const out = [];
    const bossEtches = (opts.bossKey && this.BOSS_DECK_ETCHES && this.BOSS_DECK_ETCHES[opts.bossKey]) || null;
    const skipSet = new Set(opts.skipNames || []);
    const eliteBoost = opts.eliteBoost ? 0.10 : 0;
    deckNames.forEach(name => {
      let rarity = opts.baseRarity || 'common';
      let statuses = [];
      if (bossEtches && bossEtches[name]) {
        statuses = bossEtches[name].slice();
      }
      // Regular-fight rarity roll — only if no baseRarity (i.e. not boss).
      if (!opts.baseRarity && !skipSet.has(name)) {
        const r = Math.random();
        const rareChance = (opts.rareChance || 0) + eliteBoost;
        const specialChance = (opts.specialChance || 0) + eliteBoost;
        if (r < specialChance) rarity = 'special';
        else if (r < specialChance + rareChance) rarity = 'rare';
      }
      const deckCard = this._makeDeckCard(name, rarity, statuses, /*isStarter*/ false);
      const inst = this.buildRunCard(deckCard, 'ai');
      if (inst) out.push(inst);
    });
    return out;
  },

  // ----- XP attribution after a fight -----
  // Walks the player's dead pile + lane survivors and credits XP based on
  // damage dealt + kills + survival, then bumps rarity if thresholds hit.
  // Stat-etch detector. Anything that's a flat ATK / HP / cost mod
  // counts as "boring stat" — those are the safe pulls. Everything
  // else (Bullseye, Splash, Cantrip, Echo, etc.) is a "text upgrade"
  // and rolls at lower frequency. Used by level-up bucket roller.
  _isStatEtch(id) {
    return /^(plus\d|discount-\d)/.test(id);
  },
  // Four-bucket categorization for level-up choices.
  //
  //   stats   — flat ATK/HP bumps (plus*)
  //   energy  — cost reductions (discount-*)
  //   trait   — keyword etches the card "wears" (Bullseye, Hunt,
  //             Armor, Taunt, Evade, Splash, Untrickable, Overdrive,
  //             Thorns, Cantrip, Echo, Phoenix, Lifesteal, Berserker,
  //             Zealot, Fear, etc.)
  //   text    — the legendary-rarity Text+ etch that scales the
  //             card's PRINTED ability up one tier (Splash 1 → 2,
  //             Freeze 1 → 2). User direction: "Thorns is a trait
  //             like Bullseye. The text tech is the Legendary quality
  //             upgrade so it's rare to get."
  //
  // The auto-grant on common→rare pulls from a smaller TRAIT pool of
  // basic keywords — Thorns/Cantrip/Echo/Phoenix etc. are too strong
  // to hand out for free, so they're trait *etches* (player can pick
  // them) but NOT in the auto-grant list.
  TRAIT_ETCH_IDS: ['bullseye', 'hunt', 'armor-1', 'taunt-1', 'evade-1', 'untrickable', 'splash-1', 'overdrive'],
  TEXT_ETCH_IDS:  ['text-upgrade'],
  _isStatBumpEtch(id) { return /^plus\d/.test(id); },
  _isEnergyEtch(id)   { return /^discount-\d/.test(id); },
  _isTextEtch(id)     { return this.TEXT_ETCH_IDS.includes(id); },
  // Trait = anything that isn't stats / energy / text. So Thorns,
  // Cantrip, Echo, Phoenix, Berserker, etc. all classify as traits.
  _isTraitEtch(id)    { return !this._isStatBumpEtch(id) && !this._isEnergyEtch(id) && !this._isTextEtch(id); },

  // Cards whose abilities scale via Game.rarityValue() — these get the
  // generic 'text-upgrade' etch which bumps the effective rarity tier.
  // (Hawkeye Splash 1 → 2, Black Widow Freeze 1 → 2, etc.)
  RARITY_SCALED_CARDS: new Set([
    'Black Widow', 'Gorilla Grodd', 'Hawkeye', 'Mr. Freeze', 'Xenomorph',
    'Rocket Raccoon', 'Loki', 'Star-Lord', 'Captain America', 'Iron Man',
    'Joker', 'Hela', 'Magneto', 'Thanos', 'Anakin Skywalker', 'Galactus',
    'Trigon', 'Sandman',
  ]),

  // ----- Per-card Text+ definitions (Phase 2) -----
  // User direction: "The text upgrade has to be specific to each card.
  // Winter Soldier's text upgrade should be 'destroy enemy with 4 ATK
  // or less' or '+2/+2 on destroy'. Every text is different."
  //
  // Each entry is { id, name, desc, apply } where apply mutates the
  // runtime card instance with a flag the card's onPlay / onDeath /
  // etc. reads. CRITICAL: ROGUELITE-ONLY — the card's ability code
  // reads each flag with a classic-mode default (e.g. `self._wsCostThreshold || 3`)
  // so Classic-mode behavior is completely unchanged.
  //
  // A card is "Text+-eligible" if EITHER:
  //   1. It's in RARITY_SCALED_CARDS (uses the generic rarity-tier bump), OR
  //   2. It has an entry in CARD_TEXT_UPGRADES (gets its specific upgrade)
  CARD_TEXT_UPGRADES: {
    'Winter Soldier': {
      id: 'ws-text', name: 'Bigger Targets',
      desc: 'WHEN PLAYED destroys enemies with ≤4 ATK (was 3). WHILE ACTIVE buff bumps to +2/+2.',
      apply: c => { c._wsCostThreshold = 4; c._wsBuffSize = 2; },
    },
    'Drax': {
      id: 'drax-text', name: 'Reach',
      desc: 'Drax now Splashes 1 on attack.',
      apply: c => { c.splashRange = (c.splashRange || 0) + 1; if (!c.abilities.includes('Splash 1')) c.abilities.push('Splash 1'); },
    },
    'Cyborg': {
      id: 'cyborg-text', name: 'Replication',
      desc: 'Summon TWO random cards in Cyborg\'s lane on death (was 1).',
      apply: c => { c._cyborgSummons = 2; },
    },
    'Jason Voorhees': {
      id: 'jason-text', name: 'Crystal Lake Killer',
      desc: 'Removes the once-per-game lock — Jason can revive on every kill.',
      apply: c => { c._jasonNoOnceLimit = true; },
    },
    'Wolverine': {
      id: 'wolverine-text', name: 'Adamantium',
      desc: 'Slays attackers with cost ≤8 (was 7). Revive 2 (was 1).',
      apply: c => { c._wolverineKillThreshold = 8; c.reviveCharges = (c.reviveCharges || 0) + 1; },
    },
    'Bane': {
      id: 'bane-text', name: 'Venom Surge',
      desc: 'Bane rages for +2/+2 when damaged (was +1/+1).',
      apply: c => { c._baneRageSize = 2; },
    },
    'Catwoman': {
      id: 'catwoman-text', name: 'Cat Burglar',
      desc: 'WHEN DISCARDED steals 2 Energy from the opponent next turn (was 1).',
      apply: c => { c._catwomanSteal = 2; },
    },
    /* Dr. Strange Text+ deferred — his peek mechanic is already
       roguelite-specific (peek 3 vs 2) and the upgrade would need
       deeper plumbing through handleDrStrangeReorder. Skipped for
       this batch. */
    'Ghostface': {
      id: 'ghostface-text', name: 'Mass Hysteria',
      desc: 'WHEN PLAYED summons TWO (2/1) Ghostfaces with Bullseye (was 1).',
      apply: c => { c._ghostfaceSpawns = 2; },
    },
    'Harley Quinn': {
      id: 'harley-text', name: 'Chaos!',
      desc: 'Both players draw 2 instead of 1.',
      apply: c => { c._harleyDraw = 2; },
    },
    'Invisible Woman': {
      id: 'iw-text', name: 'Force Field',
      desc: 'Grant Evade 2 instead of Evade 1.',
      apply: c => { c._iwEvadeAmount = 2; },
    },
    'Sabertooth': {
      id: 'sabertooth-text', name: 'Bloodthirst',
      desc: 'Sabertooth gains +2 ATK per kill (was +1).',
      apply: c => { c._sabertoothRageSize = 2; },
    },
    'Solomon Grundy': {
      id: 'grundy-text', name: 'Born on Monday',
      desc: 'WHEN DESTROYED draw 2 cards from the shared dead pile (was 1).',
      apply: c => { c._grundyDeathDraw = 2; },
    },
    'Mr. Fantastic': {
      id: 'fantastic-text', name: 'Maximum Stretch',
      desc: 'Next card drawn costs 4 less (was 2).',
      apply: c => { c._fantasticDiscount = 4; },
    },
    'Anti-Venom': {
      id: 'antivenom-text', name: 'Cleanse',
      desc: 'Heals you for 6 (was 4).',
      apply: c => { c._antivenomHeal = 6; },
    },
    'The Grinch': {
      id: 'grinch-text', name: 'Heart Two Sizes Bigger',
      desc: 'Kept stolen tricks cost +0 (was +1) — keep them all without penalty.',
      apply: c => { c._grinchKeepCostBump = 0; },
    },
    'Aquaman': {
      id: 'aquaman-text', name: 'Trident\'s Edge',
      desc: 'Creature of the Deep summons as a 6/4 (was 5/3).',
      apply: c => { c._aquamanCreatureBump = 1; },
    },
    'Carnage': {
      id: 'carnage-text', name: 'Bloodbath',
      desc: 'WHILE ACTIVE heals you for 2× the enemy count (was 1×).',
      apply: c => { c._carnageHealMul = 2; },
    },
    'Wonder Woman': {
      id: 'wonder-woman-text', name: 'Lasso of Truth',
      desc: 'WHEN PLAYED adds 4 Block Meter (was 2).',
      apply: c => { c._wonderWomanBlockGain = 4; },
    },
    'Deathstroke': {
      id: 'deathstroke-text', name: 'Master Strategist',
      desc: 'Assassinates enemies with ≤5 HP (was ≤3).',
      apply: c => { c._deathstrokeKillThreshold = 5; },
    },
    'Spider-Man': {
      id: 'spiderman-text', name: 'Spider-Sense',
      desc: 'WHILE ACTIVE buff bumps to +2/+2 on each evade (was +1/+1).',
      apply: c => { c._spiderManEvadeBuff = 2; },
    },
    'Predator': {
      id: 'predator-text', name: 'Plasma Caster',
      desc: 'WHEN PLAYED deals 5 damage (was 3).',
      apply: c => { c._predatorStrikeDamage = 5; },
    },
    'Black Panther': {
      id: 'black-panther-text', name: 'King of Wakanda',
      desc: 'WHEN PLAYED can free-cast cards with cost ≤5 (was ≤3).',
      apply: c => { c._blackPantherFreeThreshold = 5; },
    },
    'Venom': {
      id: 'venom-text', name: 'Symbiote Bond',
      desc: 'WHILE ACTIVE heals you for 2× the ally count (was 1×).',
      apply: c => { c._venomHealMul = 2; },
    },
    'Hulk': {
      id: 'hulk-text', name: 'World Breaker',
      desc: 'WHEN PLAYED deals 4 damage to all enemies (was 2).',
      apply: c => { c._hulkSmashDamage = 4; },
    },
    'Ant-Man': {
      id: 'antman-text', name: 'Subatomic Strike',
      desc: 'Destroys enemies with ≤2 ATK or ≤2 HP (was ≤1).',
      apply: c => { c._antManKillThreshold = 2; },
    },
    'Jango Fett': {
      id: 'jango-text', name: 'Jetpack Salvo',
      desc: 'Splash 2 on arrival when moved (was 1).',
      apply: c => { c._jangoSplashOnMove = 2; },
    },
    'Gamora': {
      id: 'gamora-text', name: 'Most Dangerous Woman',
      desc: 'Executes enemies with ≤4 HP (was ≤2).',
      apply: c => { c._gamoraExecuteThreshold = 4; },
    },
    'Human Torch': {
      id: 'humantorch-text', name: 'Nova Burst',
      desc: 'WHEN PLAYED targeted blast does 4 damage (was 2).',
      apply: c => { c._humanTorchBlast = 4; },
    },
    'Green Goblin': {
      id: 'goblin-text', name: 'Bigger Bombs',
      desc: 'Pumpkin bombs Splash 2 then Splash 3 (was 1 then 2).',
      apply: c => { c._goblinBombBoost = 1; },
    },
    'Dr. Doom': {
      id: 'doom-text', name: 'Latverian Discount',
      desc: 'Revived ally\'s cost is permanently reduced by 5 (was 3).',
      apply: c => { c._doomReviveDiscount = 5; },
    },
    'Thor': {
      id: 'thor-text', name: 'Stormbreaker',
      desc: 'Thunder strikes lane ±1 enemies for 7 (was 5).',
      apply: c => { c._thorThunderDamage = 7; },
    },
    'Luke Skywalker': {
      id: 'luke-text', name: 'A New Hope',
      desc: 'Inspires allies +2/+2 and weakens enemies -2/-2 (was 1/1).',
      apply: c => { c._lukeAuraSize = 2; },
    },
    'Batman': {
      id: 'batman-text', name: 'Dark Knight',
      desc: 'Each batarang strike deals 3 damage (was 2).',
      apply: c => { c._batmanStrikeDamage = 3; },
    },
    'Knull': {
      id: 'knull-text', name: 'God of Symbiotes',
      desc: 'Random pulls draw only cost 4+ cards (skips the cheap chaff).',
      apply: c => { c._knullCostFloor = 4; },
    },
    'Optimus Prime': {
      id: 'optimus-text', name: 'Roll Out',
      desc: 'Commands BOTH adjacent allies to attack (was 1).',
      apply: c => { c._optimusCommandsBoth = true; },
    },
    'Nightwing': {
      id: 'nightwing-text', name: 'Escrima Strike',
      desc: 'Removes 3 ATK from an enemy (was 2).',
      apply: c => { c._nightwingDebuff = 3; },
    },
    'Peacemaker': {
      id: 'peacemaker-text', name: 'Whatever It Takes',
      desc: 'Eliminates enemies with ≤4 ATK (was ≤2).',
      apply: c => { c._peacemakerKillThreshold = 4; },
    },
    'The Flash': {
      id: 'flash-text', name: 'Speed Force',
      desc: 'Freezes BOTH adjacent enemies (was 1).',
      apply: c => { c._flashFreezeAll = true; },
    },
    'Ahsoka': {
      id: 'ahsoka-text', name: 'Padawan Forever',
      desc: 'Bonus attack +2 per ally death (was +1).',
      apply: c => { c._ahsokaBonusAttacksPerKill = 2; },
    },
    'Red Skull': {
      id: 'redskull-text', name: 'Hydra Vanguard',
      desc: 'Empowers an ally +3/+3 (was +2/+2).',
      apply: c => { c._redSkullEmpower = 3; },
    },
    'Michael Myers': {
      id: 'myers-text', name: 'The Shape',
      desc: 'Stalks alone +2/+2 when no other ally is on the board (was +1/+1).',
      apply: c => { c._myersAloneBuff = 2; },
    },
    'Red Hulk': {
      id: 'redhulk-text', name: 'Rampage',
      desc: 'WHILE ACTIVE retaliation hits for +2 extra damage (block & splash both scale).',
      apply: c => { c._redHulkRetaliateBonus = 2; },
    },
    'Ultron': {
      id: 'ultron-text', name: 'Singularity',
      desc: 'Replicates as 7/5 Ultrons on death (was 5/3).',
      apply: c => { c._ultronReplicateAtk = 7; c._ultronReplicateHp = 5; },
    },
    'Yoda': {
      id: 'yoda-text', name: 'Grand Master',
      desc: 'Empowers ally with Evade + 6/+6 (was +4/+4).',
      apply: c => { c._yodaEmpowerSize = 6; },
    },
    'Superman': {
      id: 'superman-text', name: 'Last Son of Krypton',
      desc: 'Heat-vision blast deals 8 damage (was 5).',
      apply: c => { c._supermanBlast = 8; },
    },
    'Dormammu': {
      id: 'dormammu-text', name: 'Dark Dimension',
      desc: 'Drains up to 5 enemies (was 3).',
      apply: c => { c._dormammuDrainMax = 5; },
    },
    'Man-Bat': {
      id: 'manbat-text', name: 'Sonar Scream',
      desc: 'On move, weakens adj enemy by -2/-2 (was -1/-1).',
      apply: c => { c._manBatDebuffSize = 2; },
    },
    'Groot': {
      id: 'groot-text', name: 'I Am Groot',
      desc: 'Also grants Damage Immunity to Groot himself.',
      apply: c => { c._grootProtectsSelf = true; },
    },
    'Silver Surfer': {
      id: 'surfer-text', name: 'Power Cosmic',
      desc: 'Removes 5 ATK from an enemy (was 3).',
      apply: c => { c._surferDebuff = 5; },
    },
    'Green Lantern': {
      id: 'gl-text', name: 'Brightest Day',
      desc: '+2 bonus energy on top of damage-converted energy each round.',
      apply: c => { c._lanternEnergyBonus = 2; },
    },
    'Omni-Man': {
      id: 'omniman-text', name: 'Viltrumite Pride',
      desc: 'Devastates all enemies for 5 (was 3).',
      apply: c => { c._omniManSweep = 5; },
    },
    'Dr. Manhattan': {
      id: 'manhattan-text', name: 'Quantum Leap',
      desc: 'WHEN PLAYED heals you for 10 (was 5).',
      apply: c => { c._manhattanHeal = 10; },
    },
    'Raven': {
      id: 'raven-text', name: 'Soul Self',
      desc: 'STEALS the opponent\'s block instead of just emptying it.',
      apply: c => { c._ravenStealsBlock = true; },
    },
    'Poison Ivy': {
      id: 'ivy-text', name: 'Femme Fatale',
      desc: 'Charms the HIGHEST-ATK ally each round (was random).',
      apply: c => { c._ivyChooseHighest = true; },
    },
    'Gorr': {
      id: 'gorr-text', name: 'Necrosword',
      desc: 'Devours from the OPPONENT\'S hand only (no self-cost).',
      apply: c => { c._gorrEnemyOnly = true; },
    },
    'Scarlet Witch': {
      id: 'witch-text', name: 'Chaos Magic',
      desc: 'Hexes for the enemy\'s stats +2/+2 (outright over-trade).',
      apply: c => { c._witchHexBonus = 2; },
    },
    'Jigsaw': {
      id: 'jigsaw-text', name: 'Game Master',
      desc: 'WHEN DISCARDED places 5 Reverse Bear Traps (was 3).',
      apply: c => { c._jigsawTrapCount = 5; },
    },
    'Moder': {
      id: 'moder-text', name: 'Echo of Silence',
      desc: 'Strips abilities from the next 2 enemies in his lane (was 1).',
      apply: c => { c._moderStripCount = 2; },
    },
    'Professor X': {
      id: 'profx-text', name: 'Master Telepath',
      desc: 'Converts enemies with cost ≤6 (was ≤4).',
      apply: c => { c._profXConvertCost = 6; },
    },
    'Mahoraga': {
      id: 'mahoraga-text', name: 'Adaptive Wheel',
      desc: 'Revives at 9/12 with Armor 1 + Immunity 1 (was 7/9).',
      apply: c => { c._mahoragaReviveAtk = 9; c._mahoragaReviveHp = 12; },
    },
    'Obi-Wan': {
      id: 'obiwan-text', name: 'Will of the Force',
      desc: 'Reflected damage doubles (1:2 instead of 1:1).',
      apply: c => { c._obiWanReflectMul = 2; },
    },
    'The Batman Who Laughs': {
      id: 'bwl-text', name: 'Endless Hex',
      desc: 'Removes the once-per-game lock — every BWL play arms a fresh steal.',
      apply: c => { c._bwlUnlimited = true; },
    },
    'Symbiote Spider-Man': {
      id: 'symbiote-text', name: 'Black Suit',
      desc: 'Shuffles ONLY the opponent\'s hand back (your hand stays put).',
      apply: c => { c._symbioteSkipSelf = true; },
    },
    'Homelander': {
      id: 'homelander-text', name: 'Above the Law',
      desc: 'Sacrifice damage = ally cost + 3 (was ally cost only).',
      apply: c => { c._homelanderDmgBonus = 3; },
    },
    'Darth Vader': {
      id: 'vader-text', name: 'Power of the Dark Side',
      desc: 'Chain opens at 9 damage (was 7) — every chain step shifts up.',
      apply: c => { c._vaderChainDamage = 9; },
    },
    'Deadpool': {
      id: 'deadpool-text', name: 'Maximum Effort',
      desc: 'Skip the give-back — steal an enemy card without trade.',
      apply: c => { c._deadpoolNoGiveBack = true; },
    },
  },

  cardCanUseTextUpgrade(cardName) {
    return this.RARITY_SCALED_CARDS.has(cardName)
        || (this.CARD_TEXT_UPGRADES && this.CARD_TEXT_UPGRADES[cardName] != null);
  },
  // Returns the per-card Text+ definition for a given card name, or
  // null if the card uses the generic rarity-bump path (or is
  // ineligible). Used by the level-up picker + buildRunCard.
  cardTextUpgrade(cardName) {
    return (this.CARD_TEXT_UPGRADES && this.CARD_TEXT_UPGRADES[cardName]) || null;
  },

  // Pick one Common-tier trait etch the card doesn't already have.
  // Returns null if the card has every trait already (rare).
  _rollAutoTrait(cardRef) {
    const owned = new Set(cardRef.statuses || []);
    // Also treat the card's def-side baseline keywords as "owned" so
    // the auto-grant doesn't dupe an ability the card was already
    // shipped with (matters for starters like Brute → already Taunt 1).
    const candidates = this.TRAIT_ETCH_IDS.filter(id => !owned.has(id));
    if (!candidates.length) return null;
    const id = candidates[Math.floor(Math.random() * candidates.length)];
    return this._findEtch(id);
  },

  // Common→Rare ("Uncommon"): 3 picks, one from each of {Stats, Trait,
  // Energy}. SCOPED to the common etch tier only — the first promotion
  // is a small bump, not a power spike. So picks are +1 ATK / +1 HP /
  // +1/+1 (stats), Evade 1 / Splash 1 / Armor 1 / Hunt / Untrickable /
  // Taunt 1 / Bullseye (traits), Discount 1 (energy). User feedback:
  // "+3/+3 stats is insane, Evade 4 is ridiculous, Discount 3 is
  // ridiculous. These scalars have to be toned down."
  //
  // Text+ (legendary) gets a small (~5%) chance to substitute — that's
  // the rare jackpot drop. Otherwise the player picks from the
  // common-tier-only buckets.
  _rollCommonToRareChoices(cardRef) {
    const pool = this.ETCHES.common.slice();
    const stats  = pool.filter(e => this._isStatBumpEtch(e.id));
    const energy = pool.filter(e => this._isEnergyEtch(e.id));
    const ownedTraits = new Set(cardRef && cardRef.statuses ? cardRef.statuses : []);
    const traits = pool.filter(e =>
      this._isTraitEtch(e.id) && !this._isTextEtch(e.id) && !ownedTraits.has(e.id)
    );
    // Text+ only applies to cards with rarity-scaled abilities — for
    // cards with fixed text (most of the pool), Text+ does nothing,
    // so we hide it from the picker. User feedback: "I got Text+ on
    // Winter Soldier — but Winter Soldier doesn't have anything that
    // scales. The text upgrade has to be specific to each card."
    const cardName = cardRef && cardRef.defName;
    const textEtch = this._resolveTextEtchForCard(cardName);
    const pickFrom = (poolArr, label) => {
      if (!poolArr.length) return null;
      const e = poolArr[Math.floor(Math.random() * poolArr.length)];
      return { id: e.id, name: e.name, bucket: label, desc: this.etchDesc(e.id), tier: this._etchTier(e.id) };
    };
    // DISCARD-ONLY cards: only Energy + Text picks (stat/trait etches
    // do nothing on a card that never enters a lane).
    if (this._isDiscardOnlyCard(cardName)) {
      const out = [];
      const e = pickFrom(energy, 'Energy');
      if (e) out.push(e);
      if (textEtch) {
        out.push({ id: textEtch.id, name: textEtch.name, bucket: 'Text', desc: textEtch.desc || this.etchDesc(textEtch.id), tier: this._etchTier(textEtch.id) });
      }
      return out.slice(0, 2);
    }
    // Standard pickers: roll TWO distinct buckets out of {Stats, Trait,
    // Energy}. User direction: "for the level up screen I just want
    // two choices." Drop the third — picking 2 of 3 buckets gives the
    // player a meaningful choice while keeping the screen tight.
    // Text+ jackpot still has a small chance to substitute one of the
    // picks for the card's specific upgrade.
    const buckets = [
      { name: 'Stats',  pool: stats  },
      { name: 'Trait',  pool: traits },
      { name: 'Energy', pool: energy },
    ].filter(b => b.pool.length > 0);
    // Fisher-Yates shuffle
    for (let i = buckets.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [buckets[i], buckets[j]] = [buckets[j], buckets[i]];
    }
    const picks = buckets.slice(0, 2)
      .map(b => pickFrom(b.pool, b.name))
      .filter(Boolean);
    if (textEtch && picks.length > 0 && Math.random() < 0.05) {
      const slot = Math.floor(Math.random() * picks.length);
      picks[slot] = { id: textEtch.id, name: textEtch.name, bucket: 'Text', desc: textEtch.desc || this.etchDesc(textEtch.id), tier: this._etchTier(textEtch.id) };
    }
    return picks;
  },

  // Returns the Text+ etch object for a given card name. Card-specific
  // upgrades win — they have hand-tuned text describing what changes.
  // Falls back to the generic 'text-upgrade' etch (rarity-tier bump)
  // for the 18 cards in RARITY_SCALED_CARDS. Cards in neither set
  // return null (Text+ skipped from the picker).
  _resolveTextEtchForCard(cardName) {
    if (!cardName) return null;
    const custom = this.cardTextUpgrade(cardName);
    if (custom) return custom;
    if (this.RARITY_SCALED_CARDS.has(cardName)) return this._findEtch('text-upgrade');
    return null;
  },

  _rollLevelUpChoices(targetRarity, n, cardRef) {
    // Higher-tier promotions (rare→special, special→legendary) scale
    // their pick pool to the target tier so the upgrade strength
    // tracks the promotion's importance. User feedback: "+3/+3 stats
    // is insane on a common→rare bump." Now the SCOPE is bounded:
    //
    //   target = rare       → pool = common + rare       (small/mid)
    //   target = special    → pool = rare + special      (mid/strong)
    //   target = legendary  → pool = special + legendary (strong/max)
    //
    // Plus a small Text+ chance at the special / legendary promotions
    // (5% bucket weight). Buckets weighted:
    //   60% Stats / 25% Trait / 10% Energy / 5% Text.
    let tierPool;
    if (targetRarity === 'special') {
      tierPool = [...this.ETCHES.rare, ...this.ETCHES.special];
    } else if (targetRarity === 'legendary') {
      tierPool = [...this.ETCHES.special, ...this.ETCHES.legendary];
    } else {
      // rare or fallback — common-floor upgrade band.
      tierPool = [...this.ETCHES.common, ...this.ETCHES.rare];
    }
    // Resolve the per-card Text+ entry. Card-specific custom upgrade
    // wins; falls back to the generic rarity-bump etch for cards in
    // RARITY_SCALED_CARDS; otherwise null = no Text+ for this card.
    const cardName = cardRef && cardRef.defName;
    const cardTextEtch = this._resolveTextEtchForCard(cardName);
    // DISCARD-ONLY cards: no Stats / Trait buckets — those etches do
    // nothing on a card that never enters a lane. User direction:
    // "Discards can't gain stats. It can only be energy reduction.
    // And text." The rollBucket function below already falls back to
    // a non-empty bucket when its first roll lands on an empty one,
    // so muting the two buckets is sufficient.
    const isDiscard = this._isDiscardOnlyCard(cardName);
    const buckets = {
      stats:  isDiscard ? [] : tierPool.filter(e => this._isStatBumpEtch(e.id)),
      trait:  isDiscard ? [] : tierPool.filter(e => this._isTraitEtch(e.id) && !this._isTextEtch(e.id)),
      energy: tierPool.filter(e => this._isEnergyEtch(e.id)),
      text:   cardTextEtch ? [cardTextEtch] : [],
    };
    const labelOf = { stats: 'Stats', trait: 'Trait', energy: 'Energy', text: 'Text' };
    const rollBucket = () => {
      const r = Math.random();
      if (r < 0.60) return 'stats';
      if (r < 0.85) return 'trait';
      if (r < 0.95) return 'energy';
      return 'text';
    };
    const choices = [];
    const usedIds = new Set();
    let attempts = 0;
    while (choices.length < n && attempts < 80) {
      attempts++;
      let bucket = rollBucket();
      // Fall back if the chosen bucket is empty (e.g. text unavailable).
      if (!buckets[bucket].length) {
        const nonEmpty = Object.keys(buckets).filter(k => buckets[k].length);
        if (!nonEmpty.length) break;
        bucket = nonEmpty[Math.floor(Math.random() * nonEmpty.length)];
      }
      const pool = buckets[bucket];
      const cand = pool[Math.floor(Math.random() * pool.length)];
      if (usedIds.has(cand.id)) continue;
      usedIds.add(cand.id);
      // Card-specific Text+ entries carry their own `desc` field; for
      // generic etches, fall back to the ETCH_DESCS lookup. The `tier`
      // field drives the level-up picker border color (per the user's
      // rarity-based-borders direction).
      const desc = cand.desc || this.etchDesc(cand.id);
      choices.push({ id: cand.id, name: cand.name, bucket: labelOf[bucket], desc, tier: this._etchTier(cand.id) });
    }
    return choices;
  },

  // Apply XP to one deck card. Returns a level-up bucket object if the
  // card crossed its tier threshold (caller pushes into the modal list),
  // or null when there's no level-up to surface. Curse cards and
  // already-legendary cards short-circuit immediately.
  _grantXp(ref, amount) {
    if (!ref || amount <= 0) return null;
    if (ref._isCurse) return null;
    ref.xp = (ref.xp || 0) + amount;
    const tierIdx = this.TIER_INDEX[ref.rarity];
    if (tierIdx == null || tierIdx >= 3) return null;
    const threshold = this.XP_THRESHOLDS[ref.rarity];
    if (ref.xp < threshold) return null;
    ref.rarity = this.TIERS[tierIdx + 1];
    ref.xp = 0;  // reset on bump
    // Level-up bucket logic. User direction (most recent): "From
    // uncommon to rare you auto-get a trait and also 1 upgrade for
    // stats / text / energy. Then from rare to special it's just
    // random."
    //
    // common → rare: AUTO-GRANT a random Trait keyword (Bullseye,
    //   Hunt, Armor 1, Taunt 1, Evade 1, Untrickable, Splash 1,
    //   Overdrive — the keywords stripped from base cards). Plus a
    //   1-of-3 picker spanning Stats / Trait / Energy buckets.
    //
    // rare → special / special → legendary: random 2-pick from the
    // existing weighted bucket roller (60/25/10/5 Stats/Trait/
    // Energy/Text).
    let autoTrait = null;
    let choices;
    if (ref.rarity === 'rare') {
      const trait = this._rollAutoTrait(ref);
      if (trait) {
        ref.statuses = ref.statuses || [];
        ref.statuses.push(trait.id);
        autoTrait = { id: trait.id, name: trait.name, desc: this.etchDesc(trait.id) };
      }
      choices = this._rollCommonToRareChoices(ref);
    } else {
      choices = this._rollLevelUpChoices(ref.rarity, 2, ref);
    }
    return {
      defName: ref.defName,
      newRarity: ref.rarity,
      choices,
      autoTrait,
      cardRef: ref,
    };
  },

  attributeXp(run, s, won) {
    if (!run || !s || !s.player) return [];
    const pool = [];
    for (let i = 0; i < Game.LANE_COUNT; i++) {
      const c = s.lanes[i].player;
      if (c && c._runDeckCardRef) pool.push({ card: c, survived: c.currentHealth > 0 });
    }
    (s.player.deadPile || []).forEach(c => {
      if (c._runDeckCardRef) pool.push({ card: c, survived: false });
    });
    const levelUps = [];
    pool.forEach(({ card, survived }) => {
      const dmg = (card.statsHealthbarDamage || 0) + (card.statsEnemyDamage || 0);
      const kills = card.statsKills || 0;
      const earned = dmg * 1 + kills * 5 + (survived ? 10 : 0);
      const lu = this._grantXp(card._runDeckCardRef, earned);
      if (lu) levelUps.push(lu);
    });
    // PARTICIPATION XP — every deck card that didn't play gets a small
    // XP boost on a win, so the player isn't punished for finishing
    // fast. User direction: "if you finish a match quickly, all your
    // cards should get XP because you shouldn't be punished for
    // winning early." Amount scales inversely with round count so a
    // round-1 stomp pays MORE than a round-5 grind: bigger consolation
    // when the fight ended before most of the deck got dealt out.
    //
    // Formula: max(3, 12 - 2*round), clamped to a 3-XP floor.
    //   Round 1 win → +10 XP per unplayed card  (heavy reward for fast wins)
    //   Round 2 win → +8 XP
    //   Round 3 win → +6 XP
    //   Round 4 win → +4 XP
    //   Round 5+    → +3 XP                     (floor — every win pays)
    if (won) {
      const round = (s && s.round) || 1;
      const participationXp = Math.max(3, 12 - 2 * round);
      const playedRefs = new Set();
      pool.forEach(p => { if (p.card._runDeckCardRef) playedRefs.add(p.card._runDeckCardRef); });
      (run.deck || []).forEach(deckCard => {
        if (!deckCard) return;
        if (playedRefs.has(deckCard)) return;     // already got fight XP
        if (deckCard._isCurse) return;            // curses can't level up
        const lu = this._grantXp(deckCard, participationXp);
        if (lu) levelUps.push(lu);
      });
    }
    return levelUps;
  },

  // ----- Toast notifications -----
  // Stackable corner toasts for relic / trick / curse pickups so the
  // player notices acquisitions instead of seeing the count change
  // silently. Variants: 'relic' (gold), 'trick' (purple), 'curse'
  // (curse-purple), 'card' (theme accent).
  showToast(text, variant) {
    if (typeof document === 'undefined') return;
    let stack = document.getElementById('rl-toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'rl-toast-stack';
      stack.className = 'rl-toast-stack';
      document.body.appendChild(stack);
    }
    const t = document.createElement('div');
    t.className = `rl-toast rl-toast-${variant || 'card'}`;
    t.innerHTML = text;
    stack.appendChild(t);
    setTimeout(() => {
      t.classList.add('rl-toast-out');
      setTimeout(() => t.remove(), 350);
    }, 2200);
  },

  // Boss-clear splash. Full-screen 1.6s celebratory overlay with the
  // boss name + "DEFEATED" banner, then fires the callback so the
  // existing reward / end-of-run flow can proceed. Adds a real
  // "moment" between killing the boss and being handed loot.
  _showBossClearSplash(act, bossName, onComplete) {
    const existing = document.getElementById('rl-boss-clear-splash');
    if (existing) existing.remove();
    const splash = document.createElement('div');
    splash.id = 'rl-boss-clear-splash';
    splash.className = 'rl-boss-clear-splash';
    splash.innerHTML = `
      <div class="rl-boss-clear-inner">
        <div class="rl-boss-clear-act">ACT ${act} CLEARED</div>
        <div class="rl-boss-clear-name">${bossName}</div>
        <div class="rl-boss-clear-tag">DEFEATED</div>
      </div>`;
    document.body.appendChild(splash);
    setTimeout(() => {
      splash.classList.add('rl-boss-clear-splash-out');
      setTimeout(() => {
        if (splash.parentNode) splash.parentNode.removeChild(splash);
        if (onComplete) onComplete();
      }, 350);
    }, 1300);
  },

  // ----- Phase entry helpers -----
  // Run start has THREE pick screens, in order:
  //   roguelite-pick-relic  — pick 1 of 3 common relics (excludes Steel Heart)
  //   roguelite-pick-card   — pick 1 of 3 random Common cards (cost 1-3)
  //   roguelite-start       — pick 1 of 4 boons (existing)
  // User dropped the trick pick: "I don't want you drawing a trick at
  // the beginning of the game before your boon. I feel like that's
  // kinda overpowered."
  // ----- Save / resume run -----
  // localStorage key + serialization. Run state is plain data (deck
  // entries, relic IDs, map graph, gold, hp, etc.) — no functions —
  // so JSON round-trip is safe. Saved on every node transition + on
  // significant in-modal resolutions so a tab close mid-run doesn't
  // lose progress.
  SAVE_KEY: 'clb_roguelite_run_v1',

  _saveRun() {
    if (typeof localStorage === 'undefined') return;
    const run = Game.state.roguelite;
    if (!run) return;
    try {
      // Strip transient flight state — these get rebuilt on resume so
      // a stale "_fightActive" doesn't make resume re-enter combat.
      // activeNode is a reference into run.map.nodes; we serialize the
      // ID and re-link on load.
      const snapshot = {
        ...run,
        _fightActive: false,
        _fightNode: null,
        _shopInventory: null,    // shop rerolls on revisit anyway
        _activeEvent: null,      // event modal cleared on resume
        _pendingEtchBuy: null,
        _pendingCardRemoval: false,
        _pendingRestEtch: null,
        _pendingLevelUps: null,
        _marketBuyPending: false,
        activeNode: null,
        activeNodeId: run.activeNode ? run.activeNode.id : null,
      };
      localStorage.setItem(this.SAVE_KEY, JSON.stringify(snapshot));
    } catch (e) { console.warn('[ROGUELITE] save failed', e); }
  },

  hasSavedRun() {
    if (typeof localStorage === 'undefined') return false;
    try {
      const raw = localStorage.getItem(this.SAVE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      return !!(data && data.deck && data.map && data.hp > 0);
    } catch (e) { return false; }
  },

  _loadSavedRun() {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(this.SAVE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      // Re-link activeNode by ID so callers can still read run.activeNode
      if (data.activeNodeId != null && data.map && data.map.nodes) {
        data.activeNode = data.map.nodes.find(n => n.id === data.activeNodeId) || null;
      }
      return data;
    } catch (e) { console.warn('[ROGUELITE] load failed', e); return null; }
  },

  _clearSavedRun() {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.removeItem(this.SAVE_KEY); } catch (e) {}
  },

  // Resume from a saved run — restore Game.state.roguelite, ensure
  // vanilla defs are registered, and route to the map screen. Called
  // by the "Continue Run" main-menu option.
  resumeRun() {
    const saved = this._loadSavedRun();
    if (!saved) return;
    this._ensureVanillaDefsRegistered();
    // Sanitize any stale incompatible etches on discard cards in the
    // saved deck + pendingRewards. Old saves may have stat/trait
    // etches baked onto Catwoman / Mr. Fantastic / Jigsaw / Professor X
    // from before the discard filter shipped — sweep them out so the
    // codex display matches the actual behavior.
    if (Array.isArray(saved.deck)) saved.deck.forEach(d => this._sanitizeDeckCardStatuses(d));
    if (Array.isArray(saved.pendingRewards)) saved.pendingRewards.forEach(d => this._sanitizeDeckCardStatuses(d));
    Game.state.roguelite = saved;
    Game.state.phase = 'roguelite-map';
    UI.render();
  },

  // ----- Ascension difficulty levels -----
  // StS-style ascension. Each level stacks on top of the lower ones,
  // so A4 = A1+A2+A3+A4 cumulative. v1 ships 5 tiers; persistent in
  // localStorage so the player's chosen difficulty survives reloads.
  ASCENSION_LEVELS: [
    { level: 0, name: 'Standard',  desc: 'No modifiers — the baseline run.' },
    { level: 1, name: 'Hardened',  desc: 'Enemies have +10% HP.' },
    // A2 used to drop the player's max HP from 30 → 25. User feedback:
    // "I don't like how max HP goes down. That's lazy. Don't touch my
    // max HP. Just make their max health more." So A2 now stacks
    // ANOTHER +10% on enemy HP (cumulative 20% over baseline) instead
    // of cutting the player's pool.
    { level: 2, name: 'Reinforced', desc: '+ Enemies have +20% HP (cumulative).' },
    { level: 3, name: 'Spartan',   desc: '+ Battery and Old Manuscript removed from the starter pool.' },
    { level: 4, name: 'Cosmic',    desc: '+ Bosses gain an extra trick in their deck.' },
  ],
  _ASCENSION_KEY: 'clb_ascension',
  // ----- First-run tutorial -----
  // Stores which tutorial steps the player has seen so they only fire
  // once. Steps surface as small toasts at key beats (relic pick, first
  // map view, first reward, first level-up, first curse).
  _TUTORIAL_KEY: 'clb_rl_tutorial_seen',
  _tutorialSeen() {
    if (typeof localStorage === 'undefined') return {};
    try {
      const raw = localStorage.getItem(this._TUTORIAL_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  },
  _markTutorialSeen(stepId) {
    if (typeof localStorage === 'undefined') return;
    try {
      const seen = this._tutorialSeen();
      seen[stepId] = true;
      localStorage.setItem(this._TUTORIAL_KEY, JSON.stringify(seen));
    } catch (e) {}
  },
  // Show a tutorial toast IF the step hasn't fired yet. Toasts read
  // as flavored teaching moments — no big modals, no flow blocking.
  _maybeTutorial(stepId, text) {
    const seen = this._tutorialSeen();
    if (seen[stepId]) return;
    this._markTutorialSeen(stepId);
    this.showToast(`<span class="rl-toast-glyph">?</span><span class="rl-toast-text"><b>Tip</b><span class="rl-toast-sub">${text}</span></span>`, 'tutorial');
  },

  // ----- Lifetime per-card XP / play count -----
  // Persistent stat per card name across all runs. Pure ego stat, no
  // gameplay impact. Surfaced in the codex via getLifetimeCardStat().
  // User polish: "career-mode bait — Hawkeye total: 1,240 XP across
  // 8 runs."
  _CARD_LIFETIME_KEY: 'clb_card_lifetime',
  _loadLifetimeCardStats() {
    if (typeof localStorage === 'undefined') return {};
    try {
      const raw = localStorage.getItem(this._CARD_LIFETIME_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  },
  _saveLifetimeCardStats(stats) {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(this._CARD_LIFETIME_KEY, JSON.stringify(stats)); } catch (e) {}
  },
  // Bumps lifetime totals for every non-starter, non-curse card in
  // the run's deck at run end. Tracks { xp, plays, runs } per name.
  recordLifetimeCardStats(run) {
    if (!run || !run.deck) return;
    const stats = this._loadLifetimeCardStats();
    run.deck.forEach(d => {
      if (d._isStarter || d._isCurse) return;
      const name = d.defName;
      if (!stats[name]) stats[name] = { xp: 0, runs: 0 };
      stats[name].xp += (d.xp || 0);
      stats[name].runs += 1;
    });
    this._saveLifetimeCardStats(stats);
  },
  getLifetimeCardStat(name) {
    const stats = this._loadLifetimeCardStats();
    return stats[name] || { xp: 0, runs: 0 };
  },

  // ----- Per-run achievements -----
  // Computed at run end from run state + lifetime stats. Pure cosmetic
  // badges on the summary screen — no metaprogression / unlocks. Adds
  // variety goals so players self-impose challenge runs.
  computeRunAchievements(run, won) {
    if (!run) return [];
    const stats = run._stats || {};
    const out = [];
    // Ironclad — won AND no HP lost across the entire run.
    if (won && (stats.totalHpLost || 0) === 0) {
      out.push({ id: 'ironclad', label: 'Ironclad', desc: 'Cleared the run without losing a single HP.', tier: 'gold' });
    }
    // Pacifist — won OR cleared most of the run AND zero elites engaged.
    if ((stats.fightsWon || 0) >= 6 && (stats.elitesWon || 0) === 0) {
      out.push({ id: 'pacifist', label: 'Pacifist', desc: '6+ fights cleared without engaging an elite.', tier: 'silver' });
    }
    // Cursed Path — completed run with 3+ curses still in deck.
    const curseCount = (run.deck || []).filter(d => d._isCurse).length;
    if (curseCount >= 3) {
      out.push({ id: 'cursed', label: 'Cursed Path', desc: `Carried ${curseCount} curses through the run.`, tier: 'purple' });
    }
    // Purist — won AND no Special / Legendary cards in final deck.
    const hasHigh = (run.deck || []).some(d => d.rarity === 'special' || d.rarity === 'legendary');
    if (won && !hasHigh) {
      out.push({ id: 'purist', label: 'Purist', desc: 'Cleared the run with only Common and Uncommon cards.', tier: 'green' });
    }
    // Hoarder — finished with 200+ gold (used or unused).
    if ((run.gold || 0) >= 200) {
      out.push({ id: 'hoarder', label: 'Hoarder', desc: 'Ended the run with 200+ gold in pocket.', tier: 'gold' });
    }
    // Speedrun — won in under 15 minutes.
    if (won && stats.startTime && (Date.now() - stats.startTime) < 15 * 60 * 1000) {
      out.push({ id: 'speedrun', label: 'Speedrun', desc: 'Cleared the run in under 15 minutes.', tier: 'cyan' });
    }
    // Boss Sweeper — defeated all 3 act bosses.
    if ((stats.bossesWon || 0) >= 3) {
      out.push({ id: 'boss-sweep', label: 'Boss Sweeper', desc: 'Defeated all three act bosses in one run.', tier: 'gold' });
    }
    // Ascended — won at A2+.
    if (won && (run.ascension || 0) >= 2) {
      out.push({ id: 'ascended', label: `Ascended A${run.ascension}`, desc: `Cleared the run at Ascension ${run.ascension}.`, tier: 'cyan' });
    }
    return out;
  },

  // ----- Run history (last 10) -----
  // Persisted to localStorage so the player has a "career stats" page.
  // Each entry: { date, ascension, won, fightsWon, bossesWon, deckSize,
  // mvpName, mvpRarity, finalHp, maxHp, timeStr }. Cap at 10 entries
  // FIFO so the storage doesn't grow unbounded.
  _RUN_HISTORY_KEY: 'clb_run_history',
  _RUN_HISTORY_MAX: 10,
  _saveRunHistoryEntry(run, won) {
    if (typeof localStorage === 'undefined' || !run) return;
    try {
      const stats = run._stats || {};
      const elapsedMs = stats.startTime ? Math.max(0, Date.now() - stats.startTime) : 0;
      const totalSec = Math.floor(elapsedMs / 1000);
      const mm = Math.floor(totalSec / 60);
      const ss = totalSec % 60;
      const timeStr = `${mm}:${String(ss).padStart(2, '0')}`;
      // MVP — top tier non-starter card.
      const tierIdx = (r) => this.TIER_INDEX[r] || 0;
      const sortedByXp = (run.deck || []).slice()
        .filter(d => !d._isStarter && !d._isCurse)
        .sort((a, b) => (tierIdx(b.rarity) - tierIdx(a.rarity)) || ((b.xp || 0) - (a.xp || 0)));
      const mvp = sortedByXp[0];
      const entry = {
        date: Date.now(),
        ascension: run.ascension || 0,
        won: !!won,
        fightsWon: stats.fightsWon || 0,
        elitesWon: stats.elitesWon || 0,
        bossesWon: stats.bossesWon || 0,
        goldEarned: stats.goldEarned || 0,
        deckSize: (run.deck || []).length,
        mvpName: mvp ? mvp.defName : null,
        mvpRarity: mvp ? mvp.rarity : null,
        finalHp: run.hp || 0,
        maxHp: run.maxHp || 0,
        timeStr,
      };
      const raw = localStorage.getItem(this._RUN_HISTORY_KEY);
      const list = raw ? JSON.parse(raw) : [];
      list.unshift(entry);
      // Keep only the most recent N.
      if (list.length > this._RUN_HISTORY_MAX) list.length = this._RUN_HISTORY_MAX;
      localStorage.setItem(this._RUN_HISTORY_KEY, JSON.stringify(list));
    } catch (e) { console.warn('[RUN HISTORY] save failed', e); }
  },
  _loadRunHistory() {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(this._RUN_HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  },
  openRunHistory() {
    const list = this._loadRunHistory();
    if (!list.length) {
      this._modal('RUN HISTORY', '<div class="rl-empty-state">No runs recorded yet. Climb the grid to start your career log.</div>');
      return;
    }
    const fmtDate = (ts) => {
      const d = new Date(ts);
      const mo = d.getMonth() + 1;
      const da = d.getDate();
      const yr = d.getFullYear();
      return `${mo}/${da}/${yr}`;
    };
    const rows = list.map((e, i) => `
      <div class="rl-history-row ${e.won ? 'rl-history-win' : 'rl-history-loss'}">
        <div class="rl-history-result">${e.won ? '★ WIN' : '✕ LOSS'}</div>
        <div class="rl-history-meta">
          <span class="rl-history-date">${fmtDate(e.date)}</span>
          <span class="rl-history-asc">A${e.ascension || 0}</span>
        </div>
        <div class="rl-history-stats">
          <span><b>${e.fightsWon || 0}</b> fights</span>
          <span>·</span>
          <span><b>${e.bossesWon || 0}</b> bosses</span>
          <span>·</span>
          <span><b>${e.timeStr || '0:00'}</b></span>
          <span>·</span>
          <span><b>${e.finalHp || 0}/${e.maxHp || 0}</b> HP</span>
        </div>
        ${e.mvpName ? `<div class="rl-history-mvp">MVP: <span class="rl-tier-${e.mvpRarity}-text">${e.mvpName}</span> (${this.displayRarity(e.mvpRarity || 'common')})</div>` : ''}
      </div>`).join('');
    const body = `<div class="rl-history-list">${rows}</div>`;
    this._modal('RUN HISTORY', body);
  },

  currentAscension() {
    if (typeof localStorage === 'undefined') return 0;
    const raw = parseInt(localStorage.getItem(this._ASCENSION_KEY) || '0', 10);
    if (isNaN(raw)) return 0;
    return Math.max(0, Math.min(this.ASCENSION_LEVELS.length - 1, raw));
  },
  setAscension(level) {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(this._ASCENSION_KEY, String(level));
  },

  enterRun() {
    // Confirm before nuking an in-progress save. The Continue Run
    // button on the main menu is the safe path; clicking the regular
    // Roguelite button after a save exists would silently overwrite.
    if (this.hasSavedRun() && typeof confirm === 'function') {
      const ok = confirm('You have a saved run in progress. Start a new run anyway? (Your save will be overwritten when you reach the map.)');
      if (!ok) return;
    }
    // Show ascension picker first so the player can up the difficulty
    // before committing to relic / card / boon picks.
    this._renderAscensionPicker();
  },

  _renderAscensionPicker() {
    const cur = this.currentAscension();
    const buttons = this.ASCENSION_LEVELS.map(a => {
      const isCur = a.level === cur;
      const cls = isCur ? 'rl-event-choice rl-asc-cur' : 'rl-event-choice';
      return `<button type="button" class="${cls}" onclick="Roguelite._pickAscension(${a.level})">
        <span class="rl-levelup-bucket">Ascension ${a.level}</span>
        <span class="rl-levelup-name">${a.name}</span>
        <span class="rl-levelup-desc">${a.desc}</span>
      </button>`;
    }).join('');
    const body = `
      <div class="rl-event-flavor">Pick your difficulty. Higher tiers stack: A2 includes A1, A3 includes A2, and so on.</div>
      <div class="rl-event-choices">${buttons}</div>`;
    this._modal('ASCENSION', body);
  },

  _pickAscension(level) {
    this.setAscension(level);
    this._closeModal();
    Game.state._starterPicks = {};
    Game.state._starterRelicPool = this._rollStarterRelicPool();
    Game.state._starterCardPool  = this._rollStarterCardPool();
    Game.state.phase = 'roguelite-pick-relic';
    UI.render();
  },

  // Common relics minus Steel Heart (always excluded — too strong for
  // a starter). At Ascension 3+, Battery and Old Manuscript are also
  // removed — losing the burst-tempo comfort picks ramps the early
  // difficulty meaningfully.
  _rollStarterRelicPool() {
    const asc = this.currentAscension();
    const a3Excluded = new Set(asc >= 3 ? ['steel-heart', 'battery', 'old-manuscript'] : ['steel-heart']);
    const pool = this.RELICS.filter(r => r.rarity === 'common' && !a3Excluded.has(r.id));
    const shuffled = pool.slice().sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 4);
  },
  // Roll 3 unique cards from the act-1 cost range (1-4) — same range
  // post-combat rewards use in act 1, so the starter pick reads as a
  // first reward rather than a separately-clipped pool. User direction:
  // "If act 1 is correct (1-4), I like that — revert the starter pool
  // change." Pre-rolled with no etches, treated as Common rarity at
  // pickup (so they take the -1/-1 tier penalty until leveled up).
  _rollStarterCardPool() {
    if (typeof CARD_DEFS === 'undefined') return [];
    const pool = CARD_DEFS.filter(d =>
      (d.cost || 0) >= 1 && (d.cost || 0) <= 4
      && !this.AI_VANILLA_DEFS.find(v => v.name === d.name)
      && !this.STARTER_DEFS.find(s => s.name === d.name)
      && (!this.isRogueliteOnlyName || !this.isRogueliteOnlyName(d.name))
    );
    const shuffled = pool.slice().sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 3).map(d => ({ name: d.name, cost: d.cost, attack: d.attack, health: d.health, abilities: d.abilities, desc: d.desc }));
  },
  pickStarterRelic(idx) {
    const pool = Game.state._starterRelicPool || [];
    Game.state._starterPicks = Game.state._starterPicks || {};
    Game.state._starterPicks.relic = pool[idx] && pool[idx].id;
    Game.state.phase = 'roguelite-pick-card';
    UI.render();
  },
  pickStarterCard(idx) {
    const pool = Game.state._starterCardPool || [];
    Game.state._starterPicks = Game.state._starterPicks || {};
    Game.state._starterPicks.card = pool[idx] && pool[idx].name;
    Game.state.phase = 'roguelite-start';
    UI.render();
  },

  startWithBoon(boonId) {
    const boon = this.BOONS.find(b => b.id === boonId);
    const params = boon ? boon.apply() : {};
    Game.state._boonRoll = null;
    Game.state.roguelite = this.initRun(params);
    // Apply starter picks (relic, extra card, extra trick).
    const picks = Game.state._starterPicks || {};
    if (picks.relic) {
      this.grantRelic(Game.state.roguelite, picks.relic);
    }
    if (picks.card) {
      // Common-tier real card, no etches yet — grows via XP like any
      // other deckbuilding pick. Not _isStarter, so it carries the
      // Common tier penalty (−1/−1 to base, floor 1/1).
      Game.state.roguelite.deck.push(this._makeDeckCard(picks.card, 'common', [], false));
    }
    Game.state._starterPicks = null;
    Game.state._starterRelicPool = null;
    Game.state._starterCardPool = null;
    if (params.extraStartingCards) {
      params.extraStartingCards.forEach(name => {
        // Boon-granted starter bodies are also tagged _isStarter so
        // they sit at face stats just like the default starter deck.
        Game.state.roguelite.deck.push(this._makeDeckCard(name, 'common', [], true));
      });
    }
    if (params.hiredHelpCard) {
      // Hired Help boon: add a random low-cost Rare card. Pre-roll one
      // etch from the rare tier so it lands with a meaningful body —
      // matches the Rare drop-from-rewards shape (1 etch on rare).
      const rareEtches = this._rollEtchesForRarity('rare', params.hiredHelpCard);
      Game.state.roguelite.deck.push(this._makeDeckCard(params.hiredHelpCard, 'rare', rareEtches, false));
    }
    Game.state.roguelite.map = this.generateMap(Game.state.roguelite);
    Game.state.phase = 'roguelite-map';
    UI.render();
  },

  enterNode(nodeId) {
    const run = Game.state.roguelite;
    if (!run) return;
    const node = run.map.nodes.find(n => n.id === nodeId);
    if (!node) return;
    // Legality check: must be reachable from current node
    const legal = this.legalNextNodes(run);
    if (!legal.find(n => n.id === nodeId)) return;
    run.activeNode = node;
    // Sync run.act to whichever act this node belongs to. run.act is
    // initialised to 1 at run start and never auto-bumped — without
    // this update, post-combat reward rolls (rollRewards(run.act, ...))
    // would always pull from the act-1 weight table even after the
    // player crosses into Act 2 / 3. ACT_BOUNDS row ranges are the
    // single source of truth for which act a row belongs to.
    const bounds = this.ACT_BOUNDS && this.ACT_BOUNDS.find(a => node.row >= a.startRow && node.row <= a.endRow);
    if (bounds) run.act = bounds.act;
    if (node.type === 'combat' || node.type === 'boss' || node.type === 'elite' || node.type === 'final-boss') {
      this._launchFight(node);
    } else if (node.type === 'event') {
      this._showEvent(node);
    } else if (node.type === 'shop') {
      this._showShop(node);
    } else if (node.type === 'rest') {
      this._showRest(node);
    } else if (node.type === 'treasure') {
      this._showTreasure(node);
    }
  },

  // ----- Treasure chest node -----
  // Roll a tier-appropriate relic and grant it. Modal pops with a
  // big neon chest and the relic card spec — feels like a payoff
  // moment between fights. User: "every act should have a treasure
  // chest that contains a relic." Tier-1 chest = common, tier-2 =
  // rare, tier-3 = boss (legendary).
  _showTreasure(node) {
    const run = Game.state.roguelite;
    if (!run) return;
    run.currentNodeId = node.id;
    run.currentRow = node.row;
    const rarity = node.tier === 1 ? 'common' : node.tier === 2 ? 'rare' : 'boss';
    const relic = this.rollRelic(run, rarity);
    if (!relic) {
      run.lastResult = { event: 'The chest is empty (no new relics available).' };
      Game.state.phase = 'roguelite-map';
      UI.render();
      return;
    }
    this.grantRelic(run, relic.id);
    run.lastResult = { event: `Treasure! Gained relic: ${relic.name}` };
    const body = `
      <div class="rl-event-flavor">A neon chest hums on the path. You crack it open.</div>
      <div class="rl-treasure-burst" aria-hidden="true">
        <span class="rl-treasure-ray rl-treasure-ray-1"></span>
        <span class="rl-treasure-ray rl-treasure-ray-2"></span>
        <span class="rl-treasure-ray rl-treasure-ray-3"></span>
        <span class="rl-treasure-ray rl-treasure-ray-4"></span>
        <span class="rl-treasure-flash"></span>
      </div>
      <div class="rl-relic-grid rl-relic-grid-tron rl-treasure-reveal" style="margin-top:8px;">
        <div class="rl-relic-card rl-relic-card-tron rl-relic-${relic.rarity}">
          <span class="rl-relic-card-corner rl-relic-card-corner-tl"></span>
          <span class="rl-relic-card-corner rl-relic-card-corner-tr"></span>
          <span class="rl-relic-card-corner rl-relic-card-corner-bl"></span>
          <span class="rl-relic-card-corner rl-relic-card-corner-br"></span>
          <div class="rl-relic-card-icon">${this._relicIcon(relic)}</div>
          <div class="rl-relic-card-name">${relic.name}</div>
          <div class="rl-relic-card-rarity">${this.displayRarity(relic.rarity).toUpperCase()}</div>
          <div class="rl-relic-card-desc">${relic.desc}</div>
        </div>
      </div>
      <div class="rl-event-choices">
        <button type="button" class="rl-event-choice" onclick="Roguelite._closeTreasure()">Take it</button>
      </div>`;
    this._modal('TREASURE', body);
  },
  _closeTreasure() {
    this._closeModal();
    Game.state.phase = 'roguelite-map';
    UI.render();
  },

  _launchFight(node) {
    const run = Game.state.roguelite;
    if (!run) return;
    const encounter = this.buildAiEncounter(node, run);
    if (!encounter) { console.warn('Roguelite: no encounter built'); return; }
    // FULL FIGHT RESET — the previous fight's state (lanes with cards,
    // round number, energy, dead piles, status flags, log, gameOver,
    // selected card, etc.) lingered on Game.state if we just call
    // startMatch again. User report: "It's keeping the same cards on
    // board that were there last time, and the energy. Each fight needs
    // to reset into a new fight." Solution: nuke Game.state via init()
    // and re-attach the run reference so all per-fight fields rebuild
    // from scratch. The run state (HP carry-over, deck, relics, gold,
    // map progress) lives on `run` (a closure reference here), so it
    // survives the wipe and gets re-pinned to Game.state.roguelite.
    //
    // ORDER MATTERS: init() before buildRunCard() — the card-instance
    // ID counter resets in init(), so building cards AFTER ensures
    // each new fight's player cards get fresh IDs that won't collide
    // with the AI's IDs (also starting fresh from 1 in createCardInstance).
    const _preservedRun = run;
    Game.init();
    Game.state.roguelite = _preservedRun;
    _preservedRun._fightActive = true;
    _preservedRun._fightNode = node;
    // Build the player's deck instances AFTER reset, so they pick up
    // fresh IDs from the reset counter and aren't carrying any state
    // from previous fights.
    const playerCardInstances = run.deck
      .map(dc => this.buildRunCard(dc, 'player'))
      .filter(Boolean);
    // Reset per-fight relic-driven counters (extraEnergy/extraDraw rebuild
    // each fight from relic onFightStart hooks).
    _preservedRun._extraEnergy = 0;
    _preservedRun._extraDraw = 0;
    // Every-other-round counters from starter Battery / Old Manuscript.
    // Apply on odd rounds only (1, 3, 5, …).
    _preservedRun._extraEnergyAlt = 0;
    _preservedRun._extraDrawAlt = 0;
    this._applyRelicHook(_preservedRun, 'onFightStart');
    // Hand off to the existing combat engine. The mode shape:
    //   players:1v1, deck:deckbuilder (per-side piles, no shared)
    //   customDeck.cardInstances → pre-built roguelite cards w/ etches
    //   aiDeck.cards → encounter deck names (CARD_DEFS lookup)
    //   aiDeck.tricks → encounter trick names
    //   playerHp/aiHp → run-HP carry-over and per-node AI HP scaling
    //   aiDifficulty → easy/normal/hard per encounter
    //   _roguelite flag so we can detect & route the gameOver flip
    Game.startMatch({
      players: '1v1',
      deck: 'deckbuilder',
      _roguelite: true,
      customDeck: {
        cardInstances: playerCardInstances,
        tricks: run.tricks.map(t => t.defName),
      },
      aiDeck: {
        name: encounter.persona,
        cards: encounter.deckNames,
        // Pre-built instances with rarity stat bumps + boss signature
        // etches (when available — buildAiEncounter only emits these
        // for boss / final-boss / tier 2/3 fights). Engine prefers
        // cardInstances over cards when present.
        cardInstances: encounter.cardInstances || null,
        tricks: encounter.tricks,
      },
      playerHp: run.hp,
      playerMaxHp: run.maxHp,
      aiHp: encounter.hp,
      aiDifficulty: encounter.difficulty,
    });
    // Hide the roguelite overlay so the actual combat UI shows.
    this.hideOverlay();
    // Watch for gameOver flip — when the engine ends the match, route
    // back to the roguelite flow (rewards / end / death).
    this._armFightEndWatcher();
  },

  // Poll Game.state.gameOver while a roguelite fight is in flight.
  // When it flips, run the result-capture + transition.
  _armFightEndWatcher() {
    if (this._fightWatcher) clearInterval(this._fightWatcher);
    const tick = () => {
      if (!Game.state || !Game.state.gameOver) return;
      clearInterval(this._fightWatcher);
      this._fightWatcher = null;
      this._onFightEnd();
    };
    this._fightWatcher = setInterval(tick, 250);
  },

  _onFightEnd() {
    const run = Game.state.roguelite;
    if (!run || !run._fightActive) return;
    run._fightActive = false;
    const node = run._fightNode;
    const won = Game.state.winner === 'player';
    let hpRemaining = Math.max(0, Game.state.player.health || 0);
    let hpLoss = Math.max(0, run.hp - hpRemaining);
    // Iron Maiden — flat HP loss reduction every fight.
    if (run._dmgReduction && hpLoss > 0) {
      const reduced = Math.min(run._dmgReduction, hpLoss);
      hpLoss -= reduced;
      hpRemaining = run.hp - hpLoss;
    }
    // Phoenix Feather — once per run, save from death at 1 HP.
    if (run._phoenixFeatherCharged && hpRemaining <= 0) {
      hpRemaining = 1;
      hpLoss = run.hp - 1;
      run._phoenixFeatherCharged = false;
      run._phoenixFeatherFired = true;
    }
    run.hp = hpRemaining;
    // ONE-SHOT TRICKS — user direction: "once you use those tricks,
    // they're out of your deck." Walk this fight's played-trick pile
    // and remove ONE matching entry from run.tricks per play. So if
    // you had 2 Mother Box tricks and played both, both get burned.
    // Played-once-but-not-yet-used tricks (still in hand at fight end)
    // remain in run.tricks for the next fight.
    if (won && Game.state.player && Game.state.player.playedTrickPile) {
      Game.state.player.playedTrickPile.forEach(played => {
        const idx = run.tricks.findIndex(t => t.defName === played.name);
        if (idx >= 0) run.tricks.splice(idx, 1);
      });
    }
    // XP attribution + level-ups for cards that participated. Pass
    // `won` so the participation-XP path inside attributeXp can reward
    // unplayed deck cards on a win (round-scaled — fast wins pay
    // more, see _grantXp / participationXp formula in attributeXp).
    const levelUps = this.attributeXp(run, Game.state, won);
    // Run relic onFightEnd (gold gain, post-fight heals, gauntlet ticks).
    const goldBefore = run.gold || 0;
    this._applyRelicHook(run, 'onFightEnd', won);
    const relicGoldGain = Math.max(0, (run.gold || 0) - goldBefore);
    // Lifetime stat counters — surfaced on the end-of-run summary.
    if (run._stats) {
      if (won) {
        run._stats.fightsWon = (run._stats.fightsWon || 0) + 1;
        if (node.type === 'elite') run._stats.elitesWon = (run._stats.elitesWon || 0) + 1;
        if (node.type === 'boss' || node.type === 'final-boss') run._stats.bossesWon = (run._stats.bossesWon || 0) + 1;
      }
      run._stats.totalHpLost = (run._stats.totalHpLost || 0) + (hpLoss || 0);
      // Track gold gain from relic hooks (Lucky Coin, etc.) here. Combat
      // gold + boss reward gold is added in the branches below — wrap
      // those increments through _trackGold so the lifetime total stays
      // accurate.
      run._stats.goldEarned = (run._stats.goldEarned || 0) + relicGoldGain;
    }
    run.lastResult = { hpLoss, won, levelUps, nodeType: node.type, phoenixFeather: !!run._phoenixFeatherFired };
    run._phoenixFeatherFired = false;
    // Suppress the engine's game-over overlay — we own the post-match flow.
    const goOverlay = document.getElementById('game-over-overlay');
    if (goOverlay) goOverlay.style.display = 'none';
    // Restore difficulty (in case the encounter overrode it).
    if (Game._priorDifficulty != null && typeof UI !== 'undefined' && UI.settings) {
      UI.settings.difficulty = Game._priorDifficulty;
      Game._priorDifficulty = null;
    }
    // Roguelite progression
    if (!won) {
      // Defeat — run ends regardless of HP value.
      Game.state.phase = 'roguelite-end';
      UI.render();
      return;
    }
    if (run.hp <= 0) {
      Game.state.phase = 'roguelite-end';
      UI.render();
      return;
    }
    // Final-boss kill = victorious run end
    if (node.type === 'final-boss') {
      run.currentNodeId = node.id;
      run.currentRow = node.row;
      Game.state.phase = 'roguelite-end';
      UI.render();
      return;
    }
    // Boss-clear payoff (act 1 + 2). User direction: "in Slay the
    // Spire when you beat a boss you get a boss relic, a guaranteed
    // legendary card, and gold." Surface as a special boss-reward
    // modal, then route to standard reward screen for the card pick.
    if (node.type === 'boss') {
      const goldGained = 50;
      run.gold += goldGained;
      if (run._stats) run._stats.goldEarned = (run._stats.goldEarned || 0) + goldGained;
      const bossRelic = this.rollRelic(run, 'boss');
      if (bossRelic) this.grantRelic(run, bossRelic.id);
      // Boss always drops a trick reward — guaranteed alongside the
      // boss relic + legendary cards. User: "tricks should drop, like
      // card rewards. They're a little more rare." Boss = 100%.
      const bossTrick = this._rollTrickReward(run, 'boss');
      if (bossTrick) run.pendingTrickReward = bossTrick;
      run.lastResult = {
        boss: true,
        bossRelic: bossRelic ? bossRelic.name : null,
        gold: goldGained,
      };
      // Pre-roll 3 LEGENDARY cards for the next reward screen.
      run.pendingRewards = this.rollRewards(run.act, { rarityFloor: 'legendary' });
      // Boss-clear splash banner — 1.6s celebratory full-screen
      // overlay before the rewards modal opens. User polish: "drop
      // a 1.5s flash 'ACT N CLEARED' between the boss death and the
      // reward screen." Pulls boss persona from BOSS_PREVIEWS and
      // figures out the act from the node tier.
      const bossAct = node.tier || this._currentAct(run) || 1;
      const bossPrev = this.BOSS_PREVIEWS[bossAct];
      const bossName = (bossPrev && bossPrev.persona) || 'Boss';
      this._showBossClearSplash(bossAct, bossName, () => {
        Game.state.phase = 'roguelite-rewards';
        UI.render();
      });
      return;
    }
    // Gold drops on every non-boss combat win. User direction: "in Slay
    // the Spire, you get a certain number of gold for winning a combat."
    // Regular = 10–15g, Elite = 25–35g. Boss handled above (50g flat).
    let combatGold = 0;
    if (node.type === 'elite') {
      combatGold = 25 + Math.floor(Math.random() * 11);
    } else if (node.type === 'combat') {
      combatGold = 10 + Math.floor(Math.random() * 6);
    }
    if (combatGold > 0) {
      run.gold += combatGold;
      if (run._stats) run._stats.goldEarned = (run._stats.goldEarned || 0) + combatGold;
      run.lastResult = run.lastResult || {};
      run.lastResult.gold = combatGold;
    }
    // Trick reward roll. User direction: "tricks should drop, like card
    // rewards. They're a little more rare, but they should drop." So
    // regular fights drop ~30% of the time, elites ~60%. Boss is 100%
    // (handled above). Stored in run.pendingTrickReward; the rewards
    // screen surfaces it after the card pick.
    const trickRoll = this._rollTrickReward(run, node.type);
    if (trickRoll) run.pendingTrickReward = trickRoll;
    // Elite payoff — rare-floor card + guaranteed common relic.
    // Combat — standard 3-card reward.
    if (node.type === 'elite') {
      const eliteRelic = this.rollRelic(run, 'common');
      if (eliteRelic) {
        this.grantRelic(run, eliteRelic.id);
        run.lastResult = run.lastResult || {};
        run.lastResult.eliteRelic = eliteRelic.name;
      }
      run.pendingRewards = this.rollRewards(run.act, { rarityFloor: 'rare' });
    } else {
      run.pendingRewards = this.rollRewards(run.act, {});
    }
    Game.state.phase = 'roguelite-rewards';
    UI.render();
  },

  // ----- Trick-reward roller -----
  // Returns { defName } for a trick to offer, or null. Drop chance by
  // node type (regular = 30%, elite = 60%, boss = 100%). Trick pool
  // is filtered by act so act 1 can't roll a Cosmic Cube — we want
  // the trick economy to scale alongside the card economy. Avoids
  // duplicates the player already has 3+ of (no oversaturation).
  _rollTrickReward(run, nodeType) {
    if (typeof TRICK_DEFS === 'undefined') return null;
    const dropChance = { combat: 0.30, elite: 0.60, boss: 1.0 }[nodeType] || 0;
    if (dropChance < 1.0 && Math.random() > dropChance) return null;
    // Act-tier filter — same shape as the AI encounter trick allow-list.
    // Act 1 = simple cheap utility, act 2 adds mid-tier, act 3 = anything.
    const act = run.act || 1;
    const allowList = act === 1
      ? ['Bat Signal', 'Mother Box', 'Bifrost', 'Smoke Pellet']
      : act === 2
        ? ['Bat Signal', 'Mother Box', 'Bifrost', 'Smoke Pellet',
           'Vibranium', 'Mobius Chair', 'Fear Toxin', 'Lazarus Pit',
           'Joker\'s Playing Card', 'Anti-Life Equation']
        : null;  // act 3 → any
    let pool = TRICK_DEFS.slice();
    if (allowList) pool = pool.filter(t => allowList.includes(t.name));
    // De-saturate: skip tricks the player already has 3+ copies of.
    const counts = {};
    (run.tricks || []).forEach(t => { counts[t.defName] = (counts[t.defName] || 0) + 1; });
    pool = pool.filter(t => (counts[t.name] || 0) < 3);
    if (!pool.length) return null;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return { defName: pick.name, rarity: 'common' };
  },

  // ----- Event pool (random narrative encounters) -----
  // Each event is a 1-shot with multiple choices. Generally a tradeoff:
  // a relic for max-HP loss, a Special card for gold, etc. Picked at
  // random when the player enters an event node. User input drives
  // resolution via the modal — no auto-resolution.
  EVENTS: [
    {
      id: 'wandering-merchant',
      name: 'Wandering Merchant',
      flavor: 'A hooded figure rolls a cart of curiosities through the gridscape. "First taste is free, friend."',
      choices: [
        { label: 'Take the herbal tonic (+10 HP)', resolve(run) { run.hp = Math.min(run.maxHp, run.hp + 10); return '+10 HP'; } },
        { label: 'Pay 30g for a relic', cost: 30, resolve(run) {
          if (run.gold < 30) return 'Not enough gold.';
          run.gold -= 30;
          const r = Roguelite.rollRelic(run, 'common');
          if (!r) return 'Vendor is fresh out.';
          Roguelite.grantRelic(run, r.id);
          return `Picked up: ${r.name}`;
        } },
        { label: 'Pass quietly', resolve() { return 'You move along.'; } },
      ],
    },
    {
      id: 'shrine',
      name: 'Forgotten Shrine',
      flavor: 'A flickering data-shrine hums beside the path. The interface glows: "OFFER PROCESSING REQUIRED."',
      choices: [
        { label: 'Sacrifice 5 HP for a Rare relic', resolve(run) {
          if (run.hp <= 5) return 'Too weak to sacrifice.';
          run.hp -= 5;
          const r = Roguelite.rollRelic(run, 'rare');
          if (!r) { run.hp += 5; return 'No relic granted.'; }
          Roguelite.grantRelic(run, r.id);
          return `−5 HP. Gained: ${r.name}`;
        } },
        { label: 'Donate 50g for a Common relic', cost: 50, resolve(run) {
          if (run.gold < 50) return 'Not enough gold.';
          run.gold -= 50;
          const r = Roguelite.rollRelic(run, 'common');
          if (!r) { run.gold += 50; return 'No relic granted.'; }
          Roguelite.grantRelic(run, r.id);
          return `−50g. Gained: ${r.name}`;
        } },
        { label: 'Walk past', resolve() { return 'The shrine fades behind you.'; } },
      ],
    },
    {
      id: 'broken-cipher',
      name: 'Broken Cipher',
      flavor: 'A glitched terminal flashes encrypted code. Decrypting it might cost you, but reveals secrets.',
      choices: [
        { label: 'Decrypt (+50 gold but lose a deck card)', resolve(run) {
          if (run.deck.length <= 5) return 'Deck too thin to lose a card.';
          run.gold += 50;
          // Remove a random common card
          const commons = run.deck.map((d,i) => ({d,i})).filter(x => x.d.rarity === 'common');
          const pool = commons.length ? commons : run.deck.map((d,i) => ({d,i}));
          const pick = pool[Math.floor(Math.random() * pool.length)];
          const removed = run.deck[pick.i];
          run.deck.splice(pick.i, 1);
          return `+50g. Removed ${removed.defName} from deck.`;
        } },
        { label: 'Try to repair (+1 etch on random card)', resolve(run) {
          // Pick a random card and apply a common etch
          if (!run.deck.length) return 'No deck cards.';
          const idx = Math.floor(Math.random() * run.deck.length);
          const card = run.deck[idx];
          const pool = Roguelite.ETCHES.common;
          const etch = pool[Math.floor(Math.random() * pool.length)];
          card.statuses = card.statuses || [];
          card.statuses.push(etch.id);
          return `${card.defName} gains etch: ${etch.name}`;
        } },
        { label: 'Leave it alone', resolve() { return 'Some mysteries stay buried.'; } },
      ],
    },
    {
      id: 'lost-traveler',
      name: 'Lost Traveler',
      flavor: 'A weary traveler stumbles toward you. "Please... I just need supplies. I can offer guidance in return."',
      choices: [
        { label: 'Donate 20g for +max HP', cost: 20, resolve(run) {
          if (run.gold < 20) return 'Not enough gold.';
          run.gold -= 20;
          run.maxHp += 8;
          run.hp = Math.min(run.maxHp, run.hp + 8);
          return '+8 max HP, +8 HP.';
        } },
        { label: 'Refuse — keep your gold', resolve() { return 'You walk past, jaw set.'; } },
      ],
    },
    {
      id: 'market-stall',
      name: 'Hidden Market',
      flavor: 'A merchant pulls back a tarp. "Hot deal, just for you."',
      choices: [
        { label: 'Buy a card (50g) — pick from 3', cost: 50, resolve(run) {
          if (run.gold < 50) return 'Not enough gold.';
          run.gold -= 50;
          run.pendingRewards = Roguelite.rollRewards(run.act, { rarityFloor: 'rare' });
          // Side effect: jump to rewards screen, but mark it
          run._marketBuyPending = true;
          return 'PICK_REWARD';
        } },
        { label: 'Buy a relic (75g)', cost: 75, resolve(run) {
          if (run.gold < 75) return 'Not enough gold.';
          run.gold -= 75;
          const r = Roguelite.rollRelic(run, 'common');
          if (!r) { run.gold += 75; return 'No relic available.'; }
          Roguelite.grantRelic(run, r.id);
          return `−75g. Gained: ${r.name}`;
        } },
        { label: 'Pass on the deals', resolve() { return 'You decline.'; } },
      ],
    },
    {
      id: 'cursed-shrine',
      name: 'Cursed Shrine',
      flavor: 'A blackened obelisk hums with malice. The reward feels real — but so does the bite.',
      choices: [
        { label: 'Take the offering — gain a Rare relic + 1 curse', resolve(run) {
          const r = Roguelite.rollRelic(run, 'rare');
          if (!r) return 'The shrine flickers and goes dark.';
          Roguelite.grantRelic(run, r.id);
          const curse = Roguelite.addRandomCurse(run);
          return `Gained: ${r.name}. Curse added to deck: ${curse}.`;
        } },
        { label: 'Drink from the well (+30 gold + 1 curse)', resolve(run) {
          run.gold += 30;
          const curse = Roguelite.addRandomCurse(run);
          return `+30 gold. Curse added: ${curse}.`;
        } },
        { label: 'Walk past', resolve() { return 'The shrine grows fainter behind you.'; } },
      ],
    },
    {
      id: 'old-battlefield',
      name: 'Old Battlefield',
      flavor: 'Ash and broken metal. Buried under it: a worn artifact and a memory of pain.',
      choices: [
        { label: 'Dig — gain a random Common card OR a Wound (50/50)', resolve(run) {
          if (Math.random() < 0.5) {
            const cards = Roguelite._rollStarterCardPool ? Roguelite._rollStarterCardPool() : [];
            const pick = cards.length ? cards[0] : null;
            if (pick) {
              run.deck.push(Roguelite._makeDeckCard(pick.name, 'common', [], false));
              return `Dug up: ${pick.name} (Common). Added to deck.`;
            }
          }
          const curse = Roguelite.addRandomCurse(run);
          return `Bad dig. Curse added: ${curse}.`;
        } },
        { label: 'Lose 5 HP for a Common relic', resolve(run) {
          if (run.hp <= 5) return 'Too weak to risk it.';
          run.hp -= 5;
          const r = Roguelite.rollRelic(run, 'common');
          if (!r) { run.hp += 5; return 'Nothing of value.'; }
          Roguelite.grantRelic(run, r.id);
          return `−5 HP. Gained: ${r.name}.`;
        } },
        { label: 'Move on', resolve() { return 'You leave the dead in peace.'; } },
      ],
    },
    // ----- Slay-the-Spire-style add/remove card events -----
    // User direction: "some events should allow you to add cards and
    // remove cards just like Slay the Spire."
    {
      id: 'pruning-shears',
      name: 'Pruning Shears',
      flavor: 'A pair of mirror-blade shears glints on a stone table. The grid hums: "FOR EVERY CUT, A COST."',
      choices: [
        // Pay 5 HP to remove any card from the deck. Return the
        // OPEN_REMOVAL sentinel so _resolveEventChoice routes to the
        // card-removal picker instead of just setting lastResult.
        { label: 'Lose 5 HP — remove a card from your deck', resolve(run) {
          if (run.hp <= 5) return 'You are too wounded to spare any blood.';
          if (run.deck.length <= 1) return 'Your deck is too thin to prune further.';
          run.hp -= 5;
          return 'OPEN_REMOVAL';
        } },
        { label: 'Pay 75 gold — remove a card from your deck', cost: 75, resolve(run) {
          if (run.gold < 75) return 'Not enough gold.';
          if (run.deck.length <= 1) return 'Your deck is too thin to prune further.';
          run.gold -= 75;
          return 'OPEN_REMOVAL';
        } },
        { label: 'Walk past — leave the shears behind', resolve() { return 'The blades go untouched.'; } },
      ],
    },
    {
      id: 'strange-library',
      name: 'Strange Library',
      flavor: 'A flickering library of grid-shadows. The shelves whisper: "READ ME — CHOOSE WISELY."',
      choices: [
        // Pick 1 of 3 random Rare-or-better cards (free).
        { label: 'Pick from 3 Rare-or-better cards', resolve(run) {
          run.pendingRewards = Roguelite.rollRewards(run.act, { rarityFloor: 'rare' });
          return 'PICK_REWARD';
        } },
        // Lose 6 HP for a Special-floor card pick (better odds).
        { label: 'Lose 6 HP — pick from 3 Special-or-better cards', resolve(run) {
          if (run.hp <= 6) return 'You are too wounded to risk it.';
          run.hp -= 6;
          run.pendingRewards = Roguelite.rollRewards(run.act, { rarityFloor: 'special' });
          return 'PICK_REWARD';
        } },
        { label: 'Skip — close the book', resolve() { return 'The whispers fade.'; } },
      ],
    },
    {
      id: 'forgotten-forge',
      name: 'Forgotten Forge',
      flavor: 'A dormant grid-forge sparks back to life. Its furnace asks for fuel — gold or pain.',
      choices: [
        // Pay 40 gold to add a free Common card to your deck.
        { label: 'Pay 40 gold — add a Common card from 3 picks', cost: 40, resolve(run) {
          if (run.gold < 40) return 'Not enough gold.';
          run.gold -= 40;
          run.pendingRewards = Roguelite.rollRewards(run.act, {});
          return 'PICK_REWARD';
        } },
        // Pay 8 HP for a free Rare-or-better pick.
        { label: 'Lose 8 HP — pick a Rare-or-better card', resolve(run) {
          if (run.hp <= 8) return 'Your wounds would kill you.';
          run.hp -= 8;
          run.pendingRewards = Roguelite.rollRewards(run.act, { rarityFloor: 'rare' });
          return 'PICK_REWARD';
        } },
        { label: 'Walk away — let the forge sleep', resolve() { return 'The sparks die down.'; } },
      ],
    },
  ],

  _showEvent(node) {
    const run = Game.state.roguelite;
    if (!run) return;
    // Pick a random event from the pool
    const evt = this.EVENTS[Math.floor(Math.random() * this.EVENTS.length)];
    run._activeEvent = evt;
    run.currentNodeId = node.id;
    run.currentRow = node.row;
    this._renderEventModal(evt);
  },

  _renderEventModal(evt) {
    const run = Game.state.roguelite;
    const choices = evt.choices.map((ch, i) => {
      const tooExpensive = ch.cost && run.gold < ch.cost;
      const disabled = tooExpensive ? 'disabled' : '';
      const dim = tooExpensive ? 'opacity:0.45;cursor:not-allowed;' : '';
      return `<button type="button" class="rl-event-choice" ${disabled} style="${dim}" onclick="Roguelite._resolveEventChoice(${i})">${ch.label}</button>`;
    }).join('');
    const body = `
      <div class="rl-event-flavor">${evt.flavor}</div>
      <div class="rl-event-choices">${choices}</div>`;
    this._modal(evt.name, body);
  },

  _resolveEventChoice(idx) {
    const run = Game.state.roguelite;
    if (!run || !run._activeEvent) return;
    const choice = run._activeEvent.choices[idx];
    if (!choice) return;
    const result = choice.resolve(run);
    run._activeEvent = null;
    this._closeModal();
    if (result === 'PICK_REWARD') {
      Game.state.phase = 'roguelite-rewards';
      UI.render();
      return;
    }
    // Card-removal sentinel — paid the cost in resolve(), now open the
    // deck picker so the player chooses which card to prune.
    if (result === 'OPEN_REMOVAL') {
      this._renderEventCardRemoval();
      return;
    }
    run.lastResult = { event: result };
    Game.state.phase = 'roguelite-map';
    UI.render();
  },

  // Event-driven card-removal picker — same affordance as the Merchant's
  // remove service but invoked from a Pruning Shears event. The cost
  // (HP / gold) was already deducted in the event's resolve(); this
  // step just lets the player commit the cut.
  _renderEventCardRemoval() {
    const run = Game.state.roguelite;
    if (!run) return;
    const cards = run.deck.map((d, i) => `
      <div class="rl-deck-slot rl-tier-${d.rarity}" onclick="Roguelite._executeEventCardRemoval(${i})" style="cursor:pointer">
        ${this._renderCodexCard(d)}
      </div>`).join('');
    const body = `
      <div class="rl-event-flavor">Pick a card to remove from your deck.</div>
      <div class="rl-deck-grid">${cards}</div>`;
    this._modal('REMOVE A CARD', body);
  },

  _executeEventCardRemoval(cardIdx) {
    const run = Game.state.roguelite;
    if (!run || cardIdx < 0 || cardIdx >= run.deck.length) return;
    const removed = run.deck[cardIdx];
    run.deck.splice(cardIdx, 1);
    run.lastResult = { event: `Pruned: ${removed.defName} removed from your deck.` };
    this._closeModal();
    Game.state.phase = 'roguelite-map';
    UI.render();
  },

  // ----- Shop -----
  // Real shop with rolled inventory: 3 cards + 2 etches + 1-2 relics +
  // a "remove card" service. Player browses, buys, leaves when done.
  _showShop(node) {
    const run = Game.state.roguelite;
    if (!run) return;
    run.currentNodeId = node.id;
    run.currentRow = node.row;
    // Roll inventory if not already set (shop persists per-visit)
    if (!run._shopInventory || run._shopInventory.nodeId !== node.id) {
      run._shopInventory = this._rollShopInventory(run, node);
      run._shopInventory.nodeId = node.id;
    }
    this._renderShopModal();
  },

  _rollShopInventory(run, node) {
    // Card prices: common 30, rare 60, special 100, legendary 200
    const cards = this.rollRewards(run.act, {});
    const cardPrices = { common: 30, rare: 60, special: 100, legendary: 200 };
    const cardItems = cards.map(c => ({ kind: 'card', payload: c, price: cardPrices[c.rarity] || 30 }));
    // 2 random etches at price 40 / 80
    const tier1 = this.ETCHES.common;
    const tier2 = this.ETCHES.rare;
    const etchA = tier1[Math.floor(Math.random() * tier1.length)];
    const etchB = tier2[Math.floor(Math.random() * tier2.length)];
    const etchItems = [
      { kind: 'etch', payload: etchA, price: 40 },
      { kind: 'etch', payload: etchB, price: 80 },
    ];
    // 1-2 relics at common/rare. Boss relics never appear in shops.
    const relicA = this.rollRelic(run, 'common');
    const relicB = Math.random() < 0.5 ? this.rollRelic(run, 'rare') : null;
    const relicItems = [];
    if (relicA) relicItems.push({ kind: 'relic', payload: relicA, price: 80 });
    if (relicB) relicItems.push({ kind: 'relic', payload: relicB, price: 150 });
    return { cards: cardItems, etches: etchItems, relics: relicItems, removeCardPrice: 50, removeEtchPrice: 75, soldIdx: new Set() };
  },

  _renderShopModal() {
    const run = Game.state.roguelite;
    const inv = run._shopInventory;
    if (!inv) return;
    // Reusable Tron-styled BUY button — same neon hover treatment as
    // the .mm-option / boon-pick buttons. Sold = dimmed + "SOLD" label;
    // cant-afford = dimmed + still shows price.
    const buyBtn = (kind, idx, sold, cant, price) => {
      const disable = sold || cant ? 'disabled' : '';
      const cls = sold ? 'rl-shop-buy rl-shop-buy-sold'
                : cant ? 'rl-shop-buy rl-shop-buy-cant'
                : 'rl-shop-buy rl-shop-buy-ready tron-fx tron-fx-breathe';
      const onclick = idx == null
        ? `Roguelite._buyShopItem('${kind}')`
        : `Roguelite._buyShopItem('${kind}', ${idx})`;
      const label = sold ? 'SOLD' : `${price}<span class="rl-shop-buy-suffix">g</span>`;
      const sweep = (sold || cant) ? '' : '<span class="tron-sweep" aria-hidden="true"></span>';
      return `<button type="button" class="${cls}" ${disable} onclick="${onclick}">${label}${sweep}</button>`;
    };
    const renderCard = (item, idx) => {
      const sold = inv.soldIdx.has('card-' + idx);
      const cant = run.gold < item.price;
      const stateCls = sold ? 'rl-shop-slot-sold' : (cant ? 'rl-shop-slot-cant' : '');
      return `
        <div class="rl-shop-slot rl-shop-slot-card rl-tier-${item.payload.rarity} ${stateCls}">
          <div class="rl-shop-slot-rarity">${this.displayRarity(item.payload.rarity).toUpperCase()}</div>
          <div class="rl-shop-slot-card-wrap">
            ${this._renderCodexCard(item.payload)}
          </div>
          ${buyBtn('card', idx, sold, cant, item.price)}
        </div>`;
    };
    const renderEtch = (item, idx) => {
      const sold = inv.soldIdx.has('etch-' + idx);
      const cant = run.gold < item.price;
      const stateCls = sold ? 'rl-shop-slot-sold' : (cant ? 'rl-shop-slot-cant' : '');
      return `
        <div class="rl-shop-slot rl-shop-slot-etch ${stateCls}">
          <span class="rl-shop-slot-corner rl-shop-slot-corner-tl"></span>
          <span class="rl-shop-slot-corner rl-shop-slot-corner-tr"></span>
          <span class="rl-shop-slot-corner rl-shop-slot-corner-bl"></span>
          <span class="rl-shop-slot-corner rl-shop-slot-corner-br"></span>
          <div class="rl-shop-etch-glyph">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12 L12 5 L19 12 L12 19 Z"/><circle cx="12" cy="12" r="2"/></svg>
          </div>
          <div class="rl-shop-etch-name">${item.payload.name}</div>
          <div class="rl-shop-etch-flavor">Etch onto a deck card</div>
          ${buyBtn('etch', idx, sold, cant, item.price)}
        </div>`;
    };
    const renderRelic = (item, idx) => {
      const sold = inv.soldIdx.has('relic-' + idx);
      const cant = run.gold < item.price;
      const stateCls = sold ? 'rl-shop-slot-sold' : (cant ? 'rl-shop-slot-cant' : '');
      return `
        <div class="rl-shop-slot rl-shop-slot-relic rl-relic-${item.payload.rarity} ${stateCls}">
          <span class="rl-shop-slot-corner rl-shop-slot-corner-tl"></span>
          <span class="rl-shop-slot-corner rl-shop-slot-corner-tr"></span>
          <span class="rl-shop-slot-corner rl-shop-slot-corner-bl"></span>
          <span class="rl-shop-slot-corner rl-shop-slot-corner-br"></span>
          <div class="rl-shop-relic-icon">${this._relicIcon(item.payload)}</div>
          <div class="rl-shop-relic-name">${item.payload.name}</div>
          <div class="rl-shop-relic-rarity">${this.displayRarity(item.payload.rarity).toUpperCase()}</div>
          <div class="rl-shop-relic-desc">${item.payload.desc}</div>
          ${buyBtn('relic', idx, sold, cant, item.price)}
        </div>`;
    };
    const removeUsed = inv.soldIdx.has('remove');
    const removeCant = !removeUsed && run.gold < inv.removeCardPrice;
    const removeStateCls = removeUsed ? 'rl-shop-slot-sold' : (removeCant ? 'rl-shop-slot-cant' : '');
    const removeBtnLabel = removeUsed ? 'USED' : `${inv.removeCardPrice}<span class="rl-shop-buy-suffix">g</span>`;
    const removeBtnCls = removeUsed ? 'rl-shop-buy rl-shop-buy-sold'
                       : removeCant ? 'rl-shop-buy rl-shop-buy-cant'
                       : 'rl-shop-buy rl-shop-buy-ready tron-fx tron-fx-breathe';
    const removeBtn = `<button type="button" class="${removeBtnCls}" ${removeUsed || removeCant ? 'disabled' : ''} onclick="Roguelite._buyShopItem('remove')">${removeBtnLabel}${(!removeUsed && !removeCant) ? '<span class="tron-sweep" aria-hidden="true"></span>' : ''}</button>`;
    // Remove-an-Etch service — symmetric with Remove a Card. Lets the
    // player undo a bad Hunt roll on a Goon, etc. Slightly more
    // expensive (75g vs 50g) so card removal stays the cheap option.
    const reEtchUsed = inv.soldIdx.has('remove-etch');
    const reEtchCant = !reEtchUsed && run.gold < inv.removeEtchPrice;
    const reEtchStateCls = reEtchUsed ? 'rl-shop-slot-sold' : (reEtchCant ? 'rl-shop-slot-cant' : '');
    const reEtchBtnLabel = reEtchUsed ? 'USED' : `${inv.removeEtchPrice}<span class="rl-shop-buy-suffix">g</span>`;
    const reEtchBtnCls = reEtchUsed ? 'rl-shop-buy rl-shop-buy-sold'
                       : reEtchCant ? 'rl-shop-buy rl-shop-buy-cant'
                       : 'rl-shop-buy rl-shop-buy-ready tron-fx tron-fx-breathe';
    const reEtchBtn = `<button type="button" class="${reEtchBtnCls}" ${reEtchUsed || reEtchCant ? 'disabled' : ''} onclick="Roguelite._buyShopItem('remove-etch')">${reEtchBtnLabel}${(!reEtchUsed && !reEtchCant) ? '<span class="tron-sweep" aria-hidden="true"></span>' : ''}</button>`;
    const body = `
      <div class="rl-shop-hud rl-shop-hud-tron">
        <div class="rl-shop-hud-pill">
          <svg class="rl-hud-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M9 9 h6 M9 15 h6 M12 7 v10"/></svg>
          <span class="rl-shop-hud-label">GOLD</span>
          <span class="rl-shop-hud-value">${run.gold}g</span>
        </div>
      </div>
      <div class="rl-shop-section rl-shop-section-tron">
        <div class="rl-shop-section-title rl-shop-section-title-tron"><span>CARDS</span></div>
        <div class="rl-shop-row rl-shop-row-cards">${inv.cards.map((it, i) => renderCard(it, i)).join('')}</div>
      </div>
      <div class="rl-shop-section rl-shop-section-tron">
        <div class="rl-shop-section-title rl-shop-section-title-tron"><span>ETCHES</span></div>
        <div class="rl-shop-row rl-shop-row-etches">${inv.etches.map((it, i) => renderEtch(it, i)).join('')}</div>
      </div>
      <div class="rl-shop-section rl-shop-section-tron">
        <div class="rl-shop-section-title rl-shop-section-title-tron"><span>RELICS</span></div>
        <div class="rl-shop-row rl-shop-row-relics">${inv.relics.length ? inv.relics.map((it, i) => renderRelic(it, i)).join('') : '<div class="rl-empty-state">No relics in stock.</div>'}</div>
      </div>
      <div class="rl-shop-section rl-shop-section-tron">
        <div class="rl-shop-section-title rl-shop-section-title-tron"><span>SERVICES</span></div>
        <div class="rl-shop-row rl-shop-row-services">
          <div class="rl-shop-slot rl-shop-slot-service ${removeStateCls}">
            <span class="rl-shop-slot-corner rl-shop-slot-corner-tl"></span>
            <span class="rl-shop-slot-corner rl-shop-slot-corner-tr"></span>
            <span class="rl-shop-slot-corner rl-shop-slot-corner-bl"></span>
            <span class="rl-shop-slot-corner rl-shop-slot-corner-br"></span>
            <div class="rl-shop-etch-glyph">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12 h14 M9 8 l-4 4 4 4"/></svg>
            </div>
            <div class="rl-shop-etch-name">Remove a Card</div>
            <div class="rl-shop-etch-flavor">Wipe a card from your deck.</div>
            ${removeBtn}
          </div>
          <div class="rl-shop-slot rl-shop-slot-service ${reEtchStateCls}">
            <span class="rl-shop-slot-corner rl-shop-slot-corner-tl"></span>
            <span class="rl-shop-slot-corner rl-shop-slot-corner-tr"></span>
            <span class="rl-shop-slot-corner rl-shop-slot-corner-bl"></span>
            <span class="rl-shop-slot-corner rl-shop-slot-corner-br"></span>
            <div class="rl-shop-etch-glyph">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4 L20 20 M20 4 L4 20"/></svg>
            </div>
            <div class="rl-shop-etch-name">Remove an Etch</div>
            <div class="rl-shop-etch-flavor">Strip one etch from a card.</div>
            ${reEtchBtn}
          </div>
        </div>
      </div>
      <div class="rl-shop-footer">
        <button type="button" class="rl-shop-leave tron-fx tron-fx-breathe" onclick="Roguelite._leaveShop()">Leave Shop<span class="tron-sweep" aria-hidden="true"></span></button>
      </div>`;
    this._modal('SHOP', body);
  },

  _buyShopItem(kind, idx) {
    const run = Game.state.roguelite;
    const inv = run._shopInventory;
    if (!inv) return;
    const key = idx == null ? kind : `${kind}-${idx}`;
    if (inv.soldIdx.has(key)) return;
    if (kind === 'card') {
      const it = inv.cards[idx];
      if (run.gold < it.price) return;
      run.gold -= it.price;
      const { _def, ...deckCard } = it.payload;
      run.deck.push(deckCard);
      inv.soldIdx.add(key);
    } else if (kind === 'etch') {
      const it = inv.etches[idx];
      if (run.gold < it.price) return;
      run.gold -= it.price;
      // Need card-pick UI — open card-pick modal with the etch payload
      run._pendingEtchBuy = { etchId: it.payload.id, key };
      this._renderEtchPicker();
      return;
    } else if (kind === 'relic') {
      const it = inv.relics[idx];
      if (run.gold < it.price) return;
      run.gold -= it.price;
      this.grantRelic(run, it.payload.id);
      inv.soldIdx.add(key);
    } else if (kind === 'remove') {
      if (run.gold < inv.removeCardPrice) return;
      if (run.deck.length <= 4) return; // floor at 4 to prevent empty deck
      run.gold -= inv.removeCardPrice;
      inv.soldIdx.add('remove');
      run._pendingCardRemoval = true;
      this._renderCardRemovalPicker();
      return;
    } else if (kind === 'remove-etch') {
      if (run.gold < inv.removeEtchPrice) return;
      // Confirm at least one card has at least one etch.
      const hasAnyEtches = run.deck.some(d => Array.isArray(d.statuses) && d.statuses.length > 0);
      if (!hasAnyEtches) return;
      run.gold -= inv.removeEtchPrice;
      inv.soldIdx.add('remove-etch');
      this._renderEtchRemovalCardPicker();
      return;
    }
    this._renderShopModal();
  },

  // ----- Etch removal flow -----
  // Step 1: pick a card that HAS etches.
  // Step 2: pick which etch to strip.
  // Step 3: splice it from card.statuses, return to shop.
  _renderEtchRemovalCardPicker() {
    const run = Game.state.roguelite;
    if (!run) return;
    const cards = run.deck.map((d, i) => {
      const has = Array.isArray(d.statuses) && d.statuses.length > 0;
      const dim = has ? '' : 'opacity:0.35;cursor:not-allowed;';
      const click = has ? `onclick="Roguelite._renderEtchRemovalEtchPicker(${i})"` : '';
      return `
        <div class="rl-deck-slot rl-tier-${d.rarity}" ${click} style="cursor:pointer;${dim}">
          ${this._renderCodexCard(d)}
        </div>`;
    }).join('');
    const body = `
      <div class="rl-event-flavor">Pick a card. (Cards with no etches are dimmed.)</div>
      <div class="rl-deck-grid">${cards}</div>
      <div class="rl-shop-footer">
        <button type="button" class="rl-shop-leave" onclick="Roguelite._cancelEtchRemoval()">Cancel (refund)</button>
      </div>`;
    this._modal('REMOVE AN ETCH', body);
  },

  _renderEtchRemovalEtchPicker(cardIdx) {
    const run = Game.state.roguelite;
    if (!run) return;
    const card = run.deck[cardIdx];
    if (!card || !card.statuses || !card.statuses.length) {
      this._renderEtchRemovalCardPicker();
      return;
    }
    const etchHtml = card.statuses.map((id, i) => {
      const e = this._findEtch(id);
      const name = e ? e.name : id;
      const desc = this.etchDesc(id);
      return `
        <button type="button" class="rl-event-choice rl-levelup-choice" onclick="Roguelite._executeEtchRemoval(${cardIdx}, ${i})">
          <span class="rl-levelup-name">${name}</span>
          ${desc ? `<span class="rl-levelup-desc">${desc}</span>` : ''}
        </button>`;
    }).join('');
    const body = `
      <div class="rl-event-flavor">Strip which etch from <b>${card.defName}</b>?</div>
      <div class="rl-event-choices">${etchHtml}</div>
      <div class="rl-shop-footer">
        <button type="button" class="rl-shop-leave" onclick="Roguelite._renderEtchRemovalCardPicker()">Back</button>
      </div>`;
    this._modal('STRIP ETCH', body);
  },

  _executeEtchRemoval(cardIdx, etchIdx) {
    const run = Game.state.roguelite;
    if (!run) return;
    const card = run.deck[cardIdx];
    if (!card || !card.statuses || !card.statuses[etchIdx]) return;
    const etch = this._findEtch(card.statuses[etchIdx]);
    const removed = etch ? etch.name : card.statuses[etchIdx];
    card.statuses.splice(etchIdx, 1);
    run.lastResult = { event: `Stripped ${removed} from ${card.defName}.` };
    this._closeModal();
    this._renderShopModal();
  },

  _cancelEtchRemoval() {
    const run = Game.state.roguelite;
    if (!run) return;
    const inv = run._shopInventory;
    if (inv) {
      inv.soldIdx.delete('remove-etch');
      run.gold += inv.removeEtchPrice;
    }
    this._renderShopModal();
  },

  _renderEtchPicker() {
    const run = Game.state.roguelite;
    const etchId = run._pendingEtchBuy && run._pendingEtchBuy.etchId;
    if (!etchId) return;
    const etch = this._findEtch(etchId);
    const cards = run.deck.map((d, i) => `
      <div class="rl-deck-slot rl-tier-${d.rarity}" onclick="Roguelite._applyBoughtEtch(${i})" style="cursor:pointer">
        ${this._renderCodexCard(d)}
      </div>`).join('');
    const body = `
      <div class="rl-event-flavor">Apply <b>${etch.name}</b> to which card?</div>
      <div class="rl-deck-grid">${cards}</div>
      <div class="rl-shop-footer">
        <button type="button" class="rl-shop-leave" onclick="Roguelite._cancelEtchBuy()">Cancel (refund)</button>
      </div>`;
    this._modal('APPLY ETCH', body);
  },

  _applyBoughtEtch(cardIdx) {
    const run = Game.state.roguelite;
    const inv = run._shopInventory;
    const pending = run._pendingEtchBuy;
    if (!pending) return;
    const card = run.deck[cardIdx];
    if (!card) return;
    card.statuses = card.statuses || [];
    card.statuses.push(pending.etchId);
    inv.soldIdx.add(pending.key);
    run._pendingEtchBuy = null;
    this._renderShopModal();
  },

  _cancelEtchBuy() {
    const run = Game.state.roguelite;
    const inv = run._shopInventory;
    const pending = run._pendingEtchBuy;
    if (!pending) return;
    // Refund
    const it = inv.etches.find((e,i) => `etch-${i}` === pending.key);
    if (it) run.gold += it.price;
    run._pendingEtchBuy = null;
    this._renderShopModal();
  },

  _renderCardRemovalPicker() {
    const run = Game.state.roguelite;
    const cards = run.deck.map((d, i) => `
      <div class="rl-deck-slot rl-tier-${d.rarity}" onclick="Roguelite._executeCardRemoval(${i})" style="cursor:pointer">
        ${this._renderCodexCard(d)}
      </div>`).join('');
    const body = `
      <div class="rl-event-flavor">Pick a card to remove from your deck.</div>
      <div class="rl-deck-grid">${cards}</div>
      <div class="rl-shop-footer">
        <button type="button" class="rl-shop-leave" onclick="Roguelite._cancelCardRemoval()">Cancel (refund)</button>
      </div>`;
    this._modal('REMOVE CARD', body);
  },

  _executeCardRemoval(cardIdx) {
    const run = Game.state.roguelite;
    if (cardIdx < 0 || cardIdx >= run.deck.length) return;
    run.deck.splice(cardIdx, 1);
    run._pendingCardRemoval = false;
    this._renderShopModal();
  },

  _cancelCardRemoval() {
    const run = Game.state.roguelite;
    const inv = run._shopInventory;
    inv.soldIdx.delete('remove');
    run.gold += inv.removeCardPrice;
    run._pendingCardRemoval = false;
    this._renderShopModal();
  },

  _leaveShop() {
    this._closeModal();
    Game.state.phase = 'roguelite-map';
    UI.render();
  },

  // ----- Rest sites -----
  // Choice: heal 30% max HP, or upgrade a card with a free common etch.
  _showRest(node) {
    const run = Game.state.roguelite;
    if (!run) return;
    run.currentNodeId = node.id;
    run.currentRow = node.row;
    this._renderRestModal();
  },

  _renderRestModal() {
    const run = Game.state.roguelite;
    // Defensive: make sure no stale rest pending state lingers if the
    // player bounced through a sub-modal and came back.
    run._pendingRestEtch = null;
    run._pendingStatBumpIdx = null;
    const heal = Math.floor(run.maxHp * 0.3);
    const body = `
      <div class="rl-event-flavor">A safe pocket of unused grid. Spend the moment as you choose.</div>
      <div class="rl-event-choices">
        <button type="button" class="rl-event-choice" onclick="Roguelite._restHeal()">Rest — heal ${heal} HP</button>
        <button type="button" class="rl-event-choice" onclick="Roguelite._restUpgrade()">Etch a card — apply a random Common etch</button>
        <button type="button" class="rl-event-choice" onclick="Roguelite._restStatBump()">Sharpen a card — pick which stat to +1 (ATK or HP)</button>
        <button type="button" class="rl-shop-leave" onclick="Roguelite._restLeave()">Leave site (no action)</button>
      </div>`;
    this._modal('REST SITE', body);
  },

  // Bail out of the rest site cleanly. User report: "He clicked etch a
  // card, it gave him Taunt 1, he didn't want to taunt a card, so he
  // tried to quit out of it — and it kinda glitched his game out."
  // The X button closed the modal but left _pendingRestEtch hanging
  // and the player on the rest node with no resolution. Now there's
  // an explicit Leave option, and any back-out routes through here
  // so pending state always clears.
  _restLeave() {
    const run = Game.state.roguelite;
    if (run) {
      run._pendingRestEtch = null;
      run._pendingStatBumpIdx = null;
      run.lastResult = { event: 'You leave the rest site without taking action.' };
    }
    this._closeModal();
    Game.state.phase = 'roguelite-map';
    UI.render();
  },

  // Card upgrade at rest — user direction: "pick which stat to +1
  // (ATK or HP) for non-XP stat agency at rest sites." Player picks
  // a card from their deck, then chooses ATK or HP. Permanent +1 to
  // the chosen stat for all future runs of that card.
  _restStatBump() {
    const run = Game.state.roguelite;
    const cards = run.deck.map((d, i) => `
      <div class="rl-deck-slot rl-tier-${d.rarity}" onclick="Roguelite._chooseStatBumpCard(${i})" style="cursor:pointer">
        ${this._renderCodexCard(d)}
      </div>`).join('');
    const body = `
      <div class="rl-event-flavor">Pick a card to sharpen. You'll choose +1 ATK or +1 HP next.</div>
      <div class="rl-deck-grid">${cards}</div>
      <div class="rl-shop-footer">
        <button type="button" class="rl-shop-leave" onclick="Roguelite._renderRestModal()">Back</button>
      </div>`;
    this._modal('SHARPEN A CARD', body);
  },
  _chooseStatBumpCard(cardIdx) {
    const run = Game.state.roguelite;
    const card = run.deck[cardIdx];
    if (!card) return;
    run._pendingStatBumpIdx = cardIdx;
    const body = `
      <div class="rl-event-flavor">Sharpen <b>${card.defName}</b> — which stat?</div>
      <div class="rl-event-choices">
        <button type="button" class="rl-event-choice" onclick="Roguelite._applyStatBump('atk')">+1 ATK</button>
        <button type="button" class="rl-event-choice" onclick="Roguelite._applyStatBump('hp')">+1 HP</button>
      </div>
      <div class="rl-shop-footer">
        <button type="button" class="rl-shop-leave" onclick="Roguelite._restStatBump()">Back</button>
      </div>`;
    this._modal('STAT TO SHARPEN', body);
  },
  _applyStatBump(stat) {
    const run = Game.state.roguelite;
    const idx = run._pendingStatBumpIdx;
    if (idx == null) return;
    const card = run.deck[idx];
    if (!card) return;
    // Apply via etch — same pipeline as etch-driven stat bumps. So
    // re-builds always restore the bump. plus1-atk / plus1-hp.
    const etchId = stat === 'atk' ? 'plus1-atk' : 'plus1-hp';
    card.statuses = card.statuses || [];
    card.statuses.push(etchId);
    run.lastResult = { event: `Sharpened ${card.defName} (+1 ${stat.toUpperCase()})` };
    run._pendingStatBumpIdx = null;
    this._closeModal();
    Game.state.phase = 'roguelite-map';
    UI.render();
  },

  _restHeal() {
    const run = Game.state.roguelite;
    const heal = Math.floor(run.maxHp * 0.3);
    run.hp = Math.min(run.maxHp, run.hp + heal);
    run.lastResult = { event: `Rest site — healed ${heal} HP.` };
    this._closeModal();
    Game.state.phase = 'roguelite-map';
    UI.render();
  },

  // Step 1 of the etch flow: roll a random Common etch, show it in a
  // preview modal with Apply / Reroll / Cancel. Player gets to see what
  // they're getting BEFORE committing to a card. User report fixed:
  // they were forced into a card-pick screen with a pre-rolled etch
  // and the only escape was X-out, which left state inconsistent.
  _restUpgrade() {
    const run = Game.state.roguelite;
    const pool = this.ETCHES.common;
    const etch = pool[Math.floor(Math.random() * pool.length)];
    run._pendingRestEtch = etch.id;
    this._renderRestEtchPreview();
  },

  _renderRestEtchPreview() {
    const run = Game.state.roguelite;
    const etch = this._findEtch(run._pendingRestEtch);
    if (!etch) { this._renderRestModal(); return; }
    const body = `
      <div class="rl-event-flavor">The grid offers <b>${etch.name}</b>. Apply it to a card, reroll, or back out.</div>
      <div class="rl-event-choices">
        <button type="button" class="rl-event-choice" onclick="Roguelite._renderRestEtchPicker()">Apply ${etch.name} to a card</button>
        <button type="button" class="rl-event-choice" onclick="Roguelite._restEtchReroll()">Reroll the etch</button>
        <button type="button" class="rl-shop-leave" onclick="Roguelite._restEtchCancel()">Back</button>
      </div>`;
    this._modal('ETCH OFFER', body);
  },

  _restEtchReroll() {
    const run = Game.state.roguelite;
    const pool = this.ETCHES.common;
    // Avoid rolling the same etch twice in a row when possible.
    let etch = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1) {
      let attempts = 0;
      while (etch.id === run._pendingRestEtch && attempts < 8) {
        etch = pool[Math.floor(Math.random() * pool.length)];
        attempts++;
      }
    }
    run._pendingRestEtch = etch.id;
    this._renderRestEtchPreview();
  },

  _restEtchCancel() {
    const run = Game.state.roguelite;
    if (run) run._pendingRestEtch = null;
    this._renderRestModal();
  },

  // Step 2: pick which card receives the previewed etch.
  _renderRestEtchPicker() {
    const run = Game.state.roguelite;
    const etch = this._findEtch(run._pendingRestEtch);
    if (!etch) { this._renderRestModal(); return; }
    const cards = run.deck.map((d, i) => `
      <div class="rl-deck-slot rl-tier-${d.rarity}" onclick="Roguelite._applyRestEtch(${i})" style="cursor:pointer">
        ${this._renderCodexCard(d)}
      </div>`).join('');
    const body = `
      <div class="rl-event-flavor">Apply <b>${etch.name}</b> to which card?</div>
      <div class="rl-deck-grid">${cards}</div>
      <div class="rl-shop-footer">
        <button type="button" class="rl-shop-leave" onclick="Roguelite._renderRestEtchPreview()">Back</button>
      </div>`;
    this._modal('APPLY ETCH', body);
  },

  _applyRestEtch(cardIdx) {
    const run = Game.state.roguelite;
    const card = run.deck[cardIdx];
    if (!card || !run._pendingRestEtch) return;
    card.statuses = card.statuses || [];
    card.statuses.push(run._pendingRestEtch);
    run.lastResult = { event: `Etched ${card.defName} with ${this._findEtch(run._pendingRestEtch).name}` };
    run._pendingRestEtch = null;
    this._closeModal();
    Game.state.phase = 'roguelite-map';
    UI.render();
  },

  pickReward(rewardIdx) {
    const run = Game.state.roguelite;
    if (!run) return;
    if (rewardIdx != null && run.pendingRewards && run.pendingRewards[rewardIdx]) {
      const rolled = run.pendingRewards[rewardIdx];
      // Strip the _def back-reference before pushing to deck (it's a
      // serializable run-state object).
      const { _def, ...deckCard } = rolled;
      run.deck.push(deckCard);
    } else if (rewardIdx == null && run.pendingRewards && run.pendingRewards.length) {
      // SKIP CONSOLATION. User direction (paraphrased): "StS rewards
      // skipping a card with a small consolation — lets thin-deck
      // strategies thrive." 50g if you skip the card pick; gives the
      // skip a real economic option instead of pure deck-thinning.
      run.gold += 50;
      run.lastResult = run.lastResult || {};
      run.lastResult.skippedCardReward = 50;
    }
    run.pendingRewards = null;
    // Trick reward — if rolled at fight end, surface it now (after the
    // card pick, before the level-up picker). User direction: "tricks
    // should drop, like card rewards." Take or skip.
    if (run.pendingTrickReward) {
      this._renderTrickRewardModal();
      return;
    }
    this._afterRewardChain();
  },

  _afterRewardChain() {
    const run = Game.state.roguelite;
    if (!run) return;
    // After card + trick pick, check pending level-ups — if any cards
    // earned a tier bump, surface a pick-1-of-N etch modal for each.
    const lastResult = run.lastResult;
    if (lastResult && lastResult.levelUps && lastResult.levelUps.length) {
      run._pendingLevelUps = [...lastResult.levelUps];
      lastResult.levelUps = []; // consumed
      this._renderLevelUpPicker();
      return;
    }
    if (run.activeNode) {
      run.currentNodeId = run.activeNode.id;
      run.currentRow = run.activeNode.row;
    }
    // Note: Act 1 + 2 bosses route here after rewards. Final boss kill
    // already short-circuits to 'roguelite-end' inside handleCombatEnd
    // (see line ~2542). So at this point the player has cleared a
    // non-final boss and SHOULD return to the map — the cross-act edges
    // (see generateMap line ~910) connect the boss node into the next
    // act's row-0 entries. User report: "Roguelike stops at act one. I
    // defeated the Lex Luthor Boss and it showed YOU FELL. I want to go
    // all the way to act 3."
    Game.state.phase = 'roguelite-map';
    UI.render();
  },

  // ----- Trick-reward modal -----
  // Single trick offer with Take or Skip buttons. Pulls the def from
  // TRICK_DEFS so we can render the full chrome (purple cost diamond,
  // banner, description). Take pushes to run.tricks, Skip discards.
  _renderTrickRewardModal() {
    const run = Game.state.roguelite;
    const offer = run.pendingTrickReward;
    if (!offer) { this._afterRewardChain(); return; }
    const def = (typeof TRICK_DEFS !== 'undefined')
      ? TRICK_DEFS.find(d => d.name === offer.defName) : null;
    const flavor = 'A trick recovered from the wreckage. Take it or leave it.';
    const cardHtml = def ? this._renderTrickCard({ defName: def.name, rarity: 'common' }) : '';
    const body = `
      <div class="rl-event-flavor">${flavor}</div>
      <div class="rl-rewards-grid rl-trick-reward-grid">
        <div class="rl-reward-slot rl-tier-common">
          ${cardHtml}
        </div>
      </div>
      <div class="rl-event-choices rl-trick-reward-actions">
        <button type="button" class="rl-event-choice" onclick="Roguelite.pickTrickReward(true)">Take this trick</button>
        <button type="button" class="rl-shop-leave" onclick="Roguelite.pickTrickReward(false)">Skip</button>
      </div>`;
    this._modal('TRICK REWARD', body);
  },

  pickTrickReward(take) {
    const run = Game.state.roguelite;
    if (!run) return;
    if (take && run.pendingTrickReward) {
      const defName = run.pendingTrickReward.defName;
      run.tricks.push({ defName, rarity: 'common' });
      // Acquire toast so the player notices a new trick joined the deck.
      this.showToast(`<span class="rl-toast-glyph">✦</span><span class="rl-toast-text"><b>${defName}</b><span class="rl-toast-sub">NEW TRICK</span></span>`, 'trick');
    }
    run.pendingTrickReward = null;
    this._closeModal();
    this._afterRewardChain();
  },

  _renderLevelUpPicker() {
    const run = Game.state.roguelite;
    if (!run || !run._pendingLevelUps || !run._pendingLevelUps.length) {
      // All level-ups resolved — proceed to map. Final-boss end is
      // handled in handleCombatEnd before rewards, so a 'boss' here is
      // always an Act 1/2 boss that should advance to the next act.
      run._pendingLevelUps = null;
      if (run.activeNode) {
        run.currentNodeId = run.activeNode.id;
        run.currentRow = run.activeNode.row;
      }
      Game.state.phase = 'roguelite-map';
      UI.render();
      return;
    }
    const lu = run._pendingLevelUps[0];
    // First level-up triggers a teaching tip.
    this._maybeTutorial('level-up', 'Cards level up by earning XP from damage and kills. Each tier gives you a new etch.');
    // Choice cards — each gets:
    //   • a small bucket caption (Stats / Trait / Energy / Text) so
    //     the player can read which bucket fed the option
    //   • the etch name, big and centered, theme-tinted
    //   • a description line below the name explaining what the etch
    //     actually does — pulled from ETCH_DESCS via etchDesc(id).
    //     User direction: "when it says Thorns I want a description
    //     of what that means."
    // Border color = etch RARITY TIER (not bucket type). User direction:
    // "I don't want HP to always be green and trait to always be blue
    // and energy always to be gold. I want it based on the rarity of
    // the etch you get." So a +1 ATK (common) gets a green border, a
    // +2/+2 (rare) gets cyan, +3/+3 (special) white, +4/+4 / Text+
    // (legendary) gold. The bucket caption stays as a small uppercase
    // tag inside the button — useful info, but no longer the color
    // driver.
    const bucketClassMap = { Stats: 'rl-bucket-stats', Trait: 'rl-bucket-trait', Energy: 'rl-bucket-energy', Text: 'rl-bucket-text' };
    const choices = lu.choices.map((c, i) => {
      const bucketCls = bucketClassMap[c.bucket] || '';
      const tierCls = c.tier ? `rl-levelup-tier-${c.tier}` : 'rl-levelup-tier-common';
      const bucket = c.bucket
        ? `<span class="rl-levelup-bucket ${bucketCls}">${c.bucket}</span>`
        : '';
      const desc = c.desc
        ? `<span class="rl-levelup-desc">${c.desc}</span>`
        : '';
      return `<button type="button" class="rl-event-choice rl-levelup-choice ${tierCls}" onclick="Roguelite._pickLevelUpEtch(${i})">
        ${bucket}
        <span class="rl-levelup-name">${c.name}</span>
        ${desc}
      </button>`;
    }).join('');
    // Auto-trait header — shown when a common→rare bump auto-granted
    // a baseline keyword. Includes the trait's description for clarity.
    const autoTraitLine = lu.autoTrait
      ? `<div class="rl-levelup-auto-trait">
           <span class="rl-levelup-auto-tag">Auto-granted</span>
           <span class="rl-levelup-auto-name">${lu.autoTrait.name}</span>
           ${lu.autoTrait.desc ? `<span class="rl-levelup-auto-desc">${lu.autoTrait.desc}</span>` : ''}
         </div>`
      : '';
    const body = `
      <div class="rl-levelup-card-line">
        <span class="rl-levelup-card-name">${lu.defName}</span>
        <span class="rl-levelup-arrow">▸</span>
        <span class="rl-tier-${lu.newRarity}-text rl-levelup-new-tier">${this.displayRarity(lu.newRarity).toUpperCase()}</span>
      </div>
      ${autoTraitLine}
      <div class="rl-levelup-prompt">Pick an etch:</div>
      <div class="rl-levelup-choice-grid">${choices}</div>`;
    this._modal('LEVEL UP', body);
  },

  _pickLevelUpEtch(choiceIdx) {
    const run = Game.state.roguelite;
    if (!run || !run._pendingLevelUps || !run._pendingLevelUps.length) return;
    const lu = run._pendingLevelUps.shift();
    const pick = lu.choices[choiceIdx];
    if (pick && lu.cardRef) {
      lu.cardRef.statuses = lu.cardRef.statuses || [];
      lu.cardRef.statuses.push(pick.id);
    }
    this._closeModal();
    // Queue next or finish
    if (run._pendingLevelUps.length) {
      this._renderLevelUpPicker();
    } else {
      // Last level-up consumed — return to the map. Same rule as the
      // empty-pendingLevelUps early-exit above: only final-boss should
      // ever end the run, and that's handled at fight end, not here.
      run._pendingLevelUps = null;
      if (run.activeNode) {
        run.currentNodeId = run.activeNode.id;
        run.currentRow = run.activeNode.row;
      }
      Game.state.phase = 'roguelite-map';
      UI.render();
    }
  },

  abandonRun() {
    // If a deck/trick/relic modal is open, the click might have been
    // intercepted by the modal backdrop — close it first so clicking
    // Menu always works in one shot. Then surface a confirm to avoid
    // accidentally nuking a long run. User report: "the abandon button
    // doesn't work."
    this._closeModal();
    // Only confirm when there's an active run to lose; pre-run picks
    // can return to main menu directly without a prompt.
    if (Game.state.roguelite) {
      const ok = (typeof confirm === 'function')
        ? confirm('Abandon this run? Your deck, relics, and progress will be lost.')
        : true;
      if (!ok) return;
    }
    Game.state.roguelite = null;
    Game.state.phase = 'main-menu';
    Game.state._boonRoll = null;
    Game.state._starterPicks = null;
    Game.state._starterRelicPool = null;
    Game.state._starterCardPool = null;
    // Wipe the saved run too — abandoning is a clean reset.
    this._clearSavedRun();
    // Hide the roguelite overlay explicitly — UI.render's else-branch
    // already does this for non-roguelite phases, but doing it here
    // belt-and-suspenders avoids a flash of stale map content during
    // the main-menu transition.
    this.hideOverlay();
    UI.render();
  },

  // ----- Render dispatch -----
  // Called from UI.render when phase starts with 'roguelite-'.
  // Returns true if it handled the phase (so UI.render returns early).
  renderPhase(s) {
    const phase = s.phase;
    if (!phase || !phase.startsWith('roguelite')) return false;
    let el = document.getElementById('roguelite-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'roguelite-overlay';
      el.className = 'roguelite-overlay';
      document.body.appendChild(el);
    }
    el.style.display = 'flex';
    if (phase === 'roguelite-pick-relic') {
      el.innerHTML = this._renderPickRelic();
      this._maybeTutorial('relic-pick', 'Relics are run-long buffs. Pick the one that fits your playstyle.');
    }
    else if (phase === 'roguelite-pick-card') el.innerHTML = this._renderPickCard();
    else if (phase === 'roguelite-start') el.innerHTML = this._renderStart();
    else if (phase === 'roguelite-map') {
      el.innerHTML = this._renderMap();
      this._maybeTutorial('map', 'Click a node to enter. Combat, events, shops, treasures, rests — pick your path.');
    }
    else if (phase === 'roguelite-rewards') {
      el.innerHTML = this._renderRewards();
      this._maybeTutorial('reward', 'Pick one card to add. Skip for +50 gold and a thinner deck.');
    }
    else if (phase === 'roguelite-end') el.innerHTML = this._renderEnd();
    // Save / clear hooks — every map render snapshots state to
    // localStorage; the run-end screen clears the save (no resuming
    // a finished run).
    if (phase === 'roguelite-map') this._saveRun();
    else if (phase === 'roguelite-end') {
      this._clearSavedRun();
      // Append this run to the lifetime history (last-10 buffer).
      // Guarded by a flag so re-renders of the same end screen don't
      // duplicate the entry.
      const run = Game.state.roguelite;
      if (run && !run._historySaved) {
        run._historySaved = true;
        const finalBossKilled = run.lastResult && run.lastResult.nodeType === 'final-boss' && run.lastResult.won;
        const won = finalBossKilled || (run.hp > 0 && run.currentNode >= (run.totalNodes || 0) && run.totalNodes > 0);
        this._saveRunHistoryEntry(run, won);
        // Lifetime per-card XP / runs counters — career-stats bait.
        this.recordLifetimeCardStats(run);
      }
    }
    if (UI.applyTronFx) UI.applyTronFx();
    // Gold-gain floater. Compare the gold-pill's data-gold from the
    // PREVIOUS render to the new value; if it went up, spawn a "+N"
    // floater that rises off the pill. Mirrors the in-combat HP-bar
    // damage popup for visual symmetry. User polish: "every income
    // source should get a floater to confirm gold actually moved."
    if (phase === 'roguelite-map' && Game.state.roguelite) {
      const newGold = Game.state.roguelite.gold || 0;
      const prevGold = this._prevGold == null ? newGold : this._prevGold;
      const delta = newGold - prevGold;
      if (delta > 0) {
        requestAnimationFrame(() => {
          const pill = document.getElementById('rl-hud-gold');
          if (!pill) return;
          const float = document.createElement('div');
          float.className = 'rl-gold-float';
          float.textContent = `+${delta}g`;
          pill.style.position = pill.style.position || 'relative';
          pill.appendChild(float);
          setTimeout(() => float.remove(), 1300);
        });
      }
      this._prevGold = newGold;
    } else if (phase !== 'roguelite-map') {
      this._prevGold = null; // reset on non-map screens
    }
    // Auto-scroll the map to the player's current row so a tall 18-row
    // run doesn't dump the player at the top of the SVG. Defer one frame
    // to let the freshly-rendered DOM settle.
    if (phase === 'roguelite-map') {
      requestAnimationFrame(() => {
        const wrap = document.getElementById('rl-map-scroll');
        if (!wrap) return;
        const run = Game.state.roguelite;
        const totalH = wrap.scrollHeight;
        // The current row is at the bottom of the visible track, so
        // scroll-position = bottom-anchor - row-offset.
        const rowFrac = run && run.currentRow != null ? run.currentRow / Math.max(1, this.TOTAL_ROWS - 1) : 0;
        // svg is bottom-up: row 0 at bottom. So scroll-from-bottom = rowFrac.
        const targetTop = totalH - wrap.clientHeight - (rowFrac * (totalH - wrap.clientHeight));
        wrap.scrollTop = Math.max(0, targetTop);
      });
    }
    return true;
  },

  hideOverlay() {
    const el = document.getElementById('roguelite-overlay');
    if (el) el.style.display = 'none';
  },

  // Reusable progress strip — renders the 3-step Tron progress pills
  // matching the active step. Uses the .mm-option theme system so the
  // colors auto-flip to whatever neon theme the user has selected.
  _renderProgressStrip(active) {
    const steps = ['RELIC', 'CARD', 'BOON'];
    const idx = steps.indexOf(active);
    return `<div class="rl-pick-progress">${steps.map((s, i) => {
      const cls = i < idx ? 'rl-pick-step-done'
                : i === idx ? 'rl-pick-step-active' : '';
      return `<span class="rl-pick-step ${cls}">${s}</span>`;
    }).join('')}</div>`;
  },

  // Step 1 of 3: pick 1 of 3 common relics. Buttons centered as a
  // single column inside a max-width container — user feedback: "the
  // buttons are all left-centered. Just center them."
  _renderPickRelic() {
    const pool = Game.state._starterRelicPool || [];
    const buttons = pool.map((r, i) => `
      <button type="button" class="mm-option mm-option-rl tron-fx tron-fx-breathe" onclick="Roguelite.pickStarterRelic(${i})">
        <div class="mm-option-icon"><span class="rl-mm-glyph">${this._relicIcon(r)}</span></div>
        <div class="mm-option-text">
          <div class="mm-option-label">${r.name}</div>
          <div class="mm-option-sub">${r.desc}</div>
        </div>
        <span class="tron-sweep" aria-hidden="true"></span>
      </button>
    `).join('');
    return `
      <div class="rl-panel rl-pick-panel">
        <button type="button" class="md-back tron-fx tron-fx-breathe" onclick="Roguelite.abandonRun()" title="Back to main menu">&larr; Menu<span class="tron-sweep" aria-hidden="true"></span></button>
        <h1 class="rl-title mm-title">A New Run</h1>
        <p class="rl-subtitle mm-subtitle">Step 1 of 3 — Choose a starting Relic</p>
        ${this._renderProgressStrip('RELIC')}
        <div class="mm-options rl-mm-options-2col">${buttons}</div>
      </div>`;
  },

  // Step 2 of 3: pick 1 of 3 random Common cards (cost 1-3, real cards).
  // Layout: 3 large cards in a row, draft-screen-sized so they actually
  // fill the panel. User direction: "the cards can be bigger. You could
  // probably fit three cards here. Just like the draft screen."
  _renderPickCard() {
    const pool = Game.state._starterCardPool || [];
    const cards = pool.map((d, i) => `
      <div class="rl-pick-cardslot rl-pick-cardslot-big" onclick="Roguelite.pickStarterCard(${i})" role="button" tabindex="0">
        ${this._renderCodexCard({ defName: d.name, rarity: 'common', xp: 0, statuses: [], _isStarter: false })}
      </div>`).join('');
    return `
      <div class="rl-panel rl-pick-panel rl-pick-panel-cards">
        <button type="button" class="md-back tron-fx tron-fx-breathe" onclick="Roguelite.abandonRun()" title="Back to main menu">&larr; Menu<span class="tron-sweep" aria-hidden="true"></span></button>
        <h1 class="rl-title mm-title">A New Run</h1>
        <p class="rl-subtitle mm-subtitle">Step 2 of 3 — Choose a starting Card</p>
        ${this._renderProgressStrip('CARD')}
        <div class="rl-pick-cards-row">${cards}</div>
      </div>`;
  },

  _renderStart() {
    // Step 3 of 3: pick 1 of 4 random boons in a 2x2 grid. User
    // feedback: "I'd rather be like 2 buttons on the left and 2
    // buttons on the right. I think that would look good."
    if (!Game.state._boonRoll) {
      const shuffled = [...this.BOONS].sort(() => Math.random() - 0.5);
      Game.state._boonRoll = shuffled.slice(0, 4);
    }
    const buttons = Game.state._boonRoll.map(b => `
      <button type="button" class="mm-option mm-option-rl tron-fx tron-fx-breathe" onclick="Roguelite.startWithBoon('${b.id}')">
        <div class="mm-option-icon"><span class="rl-mm-glyph">✦</span></div>
        <div class="mm-option-text">
          <div class="mm-option-label">${b.name}</div>
          <div class="mm-option-sub">${b.desc}</div>
        </div>
        <span class="tron-sweep" aria-hidden="true"></span>
      </button>
    `).join('');
    return `
      <div class="rl-panel rl-pick-panel">
        <button type="button" class="md-back tron-fx tron-fx-breathe" onclick="Roguelite.abandonRun()" title="Back to main menu">&larr; Menu<span class="tron-sweep" aria-hidden="true"></span></button>
        <h1 class="rl-title mm-title">A New Run</h1>
        <p class="rl-subtitle mm-subtitle">Step 3 of 3 — Choose your Boon</p>
        ${this._renderProgressStrip('BOON')}
        <div class="mm-options rl-mm-options-2col">${buttons}</div>
      </div>`;
  },

  _renderMap() {
    const run = Game.state.roguelite;
    if (!run) return '';
    const lastNote = run.lastResult ? this._formatLastResult(run.lastResult) : '';
    const legalIds = new Set(this.legalNextNodes(run).map(n => n.id));
    const visitedIds = new Set();
    // Walk the graph from start to current to mark visited nodes (for
    // dim "done" styling). For v2 we just consider currentNodeId visited.
    if (run.currentNodeId != null) visitedIds.add(run.currentNodeId);
    // Build SVG: rows × cols grid, nodes as circles, edges as polylines.
    const ROWS = run.map.rows;
    // Wider grid (5 cols) + a bigger overall canvas to absorb the
    // denser node layout introduced when we bumped the per-row count
    // from 2-3 to 3-5. User direction: "more nodes."
    const COLS = 5;
    const W = 720;
    const ROW_SPACING = 70;
    const H = 60 + ROWS * ROW_SPACING;
    const xFor = (col) => 70 + col * ((W - 140) / (COLS - 1));
    const yFor = (row) => H - 40 - row * ROW_SPACING;
    const icon = ({ combat: '⚔', event: '✦', shop: '$', rest: '☾', elite: '☄', boss: '☠', 'final-boss': '★' });
    const tierColor = ({ 1: '#5be39a', 2: '#7fd0ff', 3: '#ffe066' });
    // Act divider lines — horizontal bars between acts so the player can
    // see the structure at a glance.
    const dividerSvg = this.ACT_BOUNDS.map(act => {
      // Place the label between the act-boss row and the next act's
      // entry row. For act 3 (final), label sits above the final boss.
      const y = act.act === 3
        ? yFor(act.endRow) - 36
        : yFor(act.endRow) - (ROW_SPACING / 2);
      return `
        <line x1="20" y1="${y}" x2="${W - 20}" y2="${y}" stroke="rgba(255,225,150,0.20)" stroke-width="1" stroke-dasharray="4 4"/>
        <text x="${W / 2}" y="${y - 6}" text-anchor="middle" class="rl-act-divider-text">ACT ${act.act}</text>`;
    }).join('');
    // Edges
    const edgeSvg = run.map.nodes.map(n => n.edges.map(eid => {
      const target = run.map.nodes.find(t => t.id === eid);
      if (!target) return '';
      const x1 = xFor(n.col), y1 = yFor(n.row);
      const x2 = xFor(target.col), y2 = yFor(target.row);
      const reachable = run.currentNodeId === n.id && legalIds.has(target.id);
      const stroke = reachable ? 'rgba(46,204,113,0.85)' : 'rgba(255,255,255,0.18)';
      const sw = reachable ? 2 : 1;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`;
    }).join('')).join('');
    // Nodes — pure SVG icons (no Unicode glyphs) so each node-type reads
    // crisply at small sizes and matches the .mm-svg Tron iconography
    // from the main menu. State drives a class on the <g>; the CSS
    // (.rl-mapnode-current, .rl-mapnode-legal, etc.) handles the neon
    // pulse, the active-theme tint, and the dimmed-done state.
    const nodeIconSvg = (type) => {
      switch (type) {
        case 'combat': return '<path d="M5 5 L19 19 M19 5 L5 19"/>';   // X / crossed swords
        case 'event':  return '<path d="M12 4 L14 10 L20 12 L14 14 L12 20 L10 14 L4 12 L10 10 Z"/>';  // 4-point star
        case 'shop':   return '<circle cx="12" cy="12" r="7"/><path d="M9 9 h6 M9 12 h6 M9 15 h6 M12 7 v10"/>';  // coin
        case 'rest':   return '<path d="M16 6 a8 8 0 1 0 2 9 a6 6 0 0 1 -2 -9 z"/>';  // crescent
        case 'elite':  return '<path d="M5 5 L19 19 M19 5 L5 19 M12 3 v3 M12 18 v3 M3 12 h3 M18 12 h3"/>';  // X with rays
        case 'treasure': return '<path d="M4 9 h16 v10 h-16 z M4 9 v-2 a2 2 0 0 1 2 -2 h12 a2 2 0 0 1 2 2 v2"/><path d="M11 13 h2 v3 h-2 z"/>'; // chest with keyhole
        case 'boss':   return '<path d="M7 5 a5 5 0 0 1 10 0 v6 a5 5 0 0 1 -10 0 z M9 9 v1 M15 9 v1 M9 13 v3 M12 13 v4 M15 13 v3"/>';  // skull
        case 'final-boss': return '<path d="M12 3 L14.5 10 L22 11 L16 16 L18 22 L12 18 L6 22 L8 16 L2 11 L9.5 10 Z"/>';  // crown star
        default:       return '<circle cx="12" cy="12" r="6"/>';
      }
    };
    // Tooltip text per node type — surfaced on hover via SVG <title>
    // (which the browser renders as a native tooltip). Concise: type +
    // tier/HP range + a one-line description. User direction: "map node
    // tooltips so the player can plan a route instead of clicking
    // blindly."
    const nodeTooltip = (n) => {
      const tier = n.tier || 1;
      switch (n.type) {
        case 'combat':
          return `Combat — Tier ${tier}\n${tier === 1 ? '9–17 HP, 3 real cards + vanilla bodies' : tier === 2 ? '17–30 HP, mixed deck' : '25–45 HP, real-card deck'}\nReward: 1 of 3 cards`;
        case 'elite':
          return `Elite — Tier ${tier}\n${tier === 1 ? '17–31 HP' : tier === 2 ? '25–44 HP' : '33–59 HP'} + extra trick, harder AI\nReward: 1 of 3 cards (Rare floor)`;
        case 'event':
          return 'Event\nNarrative encounter — pick from 2-3 outcomes (heal, gold, relic, etch, or risk).';
        case 'shop':
          return 'Shop\n3 cards · 2 etches · 1-2 relics · remove-card service. Spend gold here.';
        case 'rest':
          return 'Rest Site\nHeal 30% max HP, OR sharpen a card (etch).';
        case 'treasure':
          return `Treasure Chest\n${tier === 1 ? 'Common' : tier === 2 ? 'Rare' : 'Boss-tier'} relic, guaranteed.`;
        case 'boss': {
          const preview = this.BOSS_PREVIEWS[tier];
          return preview
            ? `Act ${tier} Boss — ${preview.persona}\n${preview.archetype}, ${preview.hpRange} HP\nReward: 1 of 3 cards (Special floor)`
            : `Act ${tier} Boss\nThemed deck, big HP. Reward floor: Special.`;
        }
        case 'final-boss':
          return 'Final Boss — Galactus\nDevour / Cosmic, 70-90 HP. Win the run.';
        default: return '';
      }
    };
    const nodeSvg = run.map.nodes.map(n => {
      const cx = xFor(n.col), cy = yFor(n.row);
      const isCurrent = n.id === run.currentNodeId;
      const isLegal = legalIds.has(n.id);
      const isDone = visitedIds.has(n.id) && !isCurrent;
      const stateCls = isCurrent ? 'rl-mapnode-current'
                     : isLegal ? 'rl-mapnode-legal'
                     : isDone ? 'rl-mapnode-done' : 'rl-mapnode-locked';
      const click = isLegal ? `onclick="Roguelite.enterNode(${n.id})"` : '';
      const tt = nodeTooltip(n);
      // Tier modifier on treasure nodes — drives a tier-specific size
      // + glow class in CSS so the player can read loot quality from
      // the map at a glance.
      const tierMod = n.type === 'treasure' && n.tier ? ` rl-mapnode-tier-${n.tier}` : '';
      return `
        <g class="rl-mapnode rl-mapnode-${n.type} ${stateCls}${tierMod}" ${click}>
          <title>${tt}</title>
          <circle class="rl-mapnode-halo" cx="${cx}" cy="${cy}" r="26"/>
          <circle class="rl-mapnode-ring" cx="${cx}" cy="${cy}" r="20"/>
          <g class="rl-mapnode-icon" transform="translate(${cx - 12}, ${cy - 12})">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" overflow="visible">${nodeIconSvg(n.type)}</svg>
          </g>
        </g>`;
    }).join('');
    const startHint = run.currentNodeId == null ? '<div class="rl-map-hint">Pick an entry point ↓</div>' : '';
    // HUD now lives in a single in-flow row that includes the Menu
    // button on the left — no more position:absolute back button
    // overlapping the HP pill. User feedback: "the bend button is
    // kind of inner layered on top of the HP. Just say a menu."
    // The relic chip strip below the HUD has also been removed since
    // the RELICS button on the right + the relic viewer modal cover
    // the same job. User: "you can get rid of the relic chips that
    // you have like it's shown here. You have the relic tab on the
    // right."
    const hpPct = Math.round(((run.hp || 0) / Math.max(1, run.maxHp || 1)) * 100);
    const hudHtml = `
      <div class="rl-hud rl-hud-tron">
        <button type="button" class="rl-hud-pill rl-hud-btn rl-hud-menu tron-fx tron-fx-breathe" onclick="Roguelite.abandonRun()" title="Return to main menu (abandon run)">
          <svg class="rl-hud-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
          <span class="rl-hud-label">MENU</span>
          <span class="tron-sweep" aria-hidden="true"></span>
        </button>
        <div class="rl-hud-pill rl-hud-hp" title="HP ${run.hp}/${run.maxHp}">
          <svg class="rl-hud-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.4-7-10.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 7 4.5C19 16.6 12 21 12 21z"/></svg>
          <span class="rl-hud-label">HP</span>
          <span class="rl-hud-value">${run.hp}<span class="rl-hud-sep">/</span>${run.maxHp}</span>
          <span class="rl-hud-bar"><span class="rl-hud-bar-fill" style="width:${hpPct}%"></span></span>
        </div>
        <div class="rl-hud-pill rl-hud-gold" id="rl-hud-gold" title="Gold ${run.gold}" data-gold="${run.gold}">
          <svg class="rl-hud-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M9 9h6M9 15h6M12 7v10"/></svg>
          <span class="rl-hud-label">GOLD</span>
          <span class="rl-hud-value">${run.gold}</span>
        </div>
        <button type="button" class="rl-hud-pill rl-hud-btn tron-fx tron-fx-breathe" onclick="Roguelite.openDeckViewer()" title="View deck">
          <svg class="rl-hud-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="10" height="14" rx="1"/><rect x="9" y="6" width="10" height="14" rx="1" stroke-opacity="0.55"/></svg>
          <span class="rl-hud-label">DECK</span>
          <span class="rl-hud-value">${run.deck.length}</span>
          <span class="tron-sweep" aria-hidden="true"></span>
        </button>
        <button type="button" class="rl-hud-pill rl-hud-btn tron-fx tron-fx-breathe" onclick="Roguelite.openTrickViewer()" title="View tricks">
          <svg class="rl-hud-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12 L20 12 M12 4 L12 20"/><circle cx="12" cy="12" r="3"/></svg>
          <span class="rl-hud-label">TRICKS</span>
          <span class="rl-hud-value">${run.tricks.length}</span>
          <span class="tron-sweep" aria-hidden="true"></span>
        </button>
        <button type="button" class="rl-hud-pill rl-hud-btn tron-fx tron-fx-breathe ${this._relicPulseRecent(run) ? 'rl-hud-relic-pulse' : ''}" onclick="Roguelite.openRelicViewer()" title="View relics">
          <svg class="rl-hud-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 L20 8 L17 19 L7 19 L4 8 Z"/><circle cx="12" cy="11" r="2"/></svg>
          <span class="rl-hud-label">RELICS</span>
          <span class="rl-hud-value">${run.relics.length}</span>
          <span class="tron-sweep" aria-hidden="true"></span>
        </button>
      </div>`;
    return `
      <div class="rl-panel rl-map-panel">
        ${hudHtml}
        ${this._renderBossPreview(run)}
        ${lastNote}
        ${startHint}
        <div class="rl-map-svg-wrap" id="rl-map-scroll">
          <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" style="height:${H}px;">
            ${dividerSvg}
            ${edgeSvg}
            ${nodeSvg}
          </svg>
        </div>
        <div class="rl-map-legend rl-map-legend-tron">
          <span class="rl-legend-pill rl-legend-combat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5 L19 19 M19 5 L5 19"/></svg>Combat</span>
          <span class="rl-legend-pill rl-legend-event"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 L14 10 L20 12 L14 14 L12 20 L10 14 L4 12 L10 10 Z"/></svg>Event</span>
          <span class="rl-legend-pill rl-legend-shop"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><path d="M9 9 h6 M9 12 h6 M9 15 h6 M12 7 v10"/></svg>Shop</span>
          <span class="rl-legend-pill rl-legend-rest"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 6 a8 8 0 1 0 2 9 a6 6 0 0 1 -2 -9 z"/></svg>Rest</span>
          <span class="rl-legend-pill rl-legend-elite"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5 L19 19 M19 5 L5 19 M12 3 v3 M12 18 v3 M3 12 h3 M18 12 h3"/></svg>Elite</span>
          <span class="rl-legend-pill rl-legend-treasure"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9 h16 v10 h-16 z M4 9 v-2 a2 2 0 0 1 2 -2 h12 a2 2 0 0 1 2 2 v2"/><path d="M11 13 h2 v3 h-2 z"/></svg>Treasure</span>
          <span class="rl-legend-pill rl-legend-boss"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5 a5 5 0 0 1 10 0 v6 a5 5 0 0 1 -10 0 z M9 9 v1 M15 9 v1 M9 13 v3 M12 13 v4 M15 13 v3"/></svg>Boss</span>
        </div>
      </div>`;
  },

  // Deck viewer modal — Spire-style "view your deck from the map".
  openDeckViewer() {
    this._modal('YOUR DECK', this._renderDeckList());
  },
  openTrickViewer() {
    this._modal('YOUR TRICKS', this._renderTrickList());
  },
  openRelicViewer() {
    this._modal('YOUR RELICS', this._renderRelicList());
  },
  // Compact strip below the HUD showing relic icons + tooltips. Always
  // visible on the map screen so the player remembers what's running.
  // Determine which act the player is currently in based on currentRow.
  // Used by the boss-preview banner + future act-aware UI.
  _currentAct(run) {
    if (!run) return 1;
    const row = run.currentRow != null ? run.currentRow : 0;
    const found = this.ACT_BOUNDS.find(a => row >= a.startRow && row <= a.endRow);
    return (found && found.act) || 1;
  },

  // Boss preview banner — shows the upcoming act boss + their archetype
  // + flavor text so the player can plan their deck shape around the
  // matchup. Surfaces at the top of the map between the HUD and the
  // node graph. Tapping the banner expands a longer "what to pack" tip.
  _renderBossPreview(run) {
    if (!run) return '';
    const act = this._currentAct(run);
    const preview = this.BOSS_PREVIEWS[act];
    if (!preview) return '';
    return `
      <div class="rl-boss-preview rl-boss-preview-act${act}" title="${preview.flavor.replace(/"/g, '&quot;')}">
        <div class="rl-boss-preview-corner rl-boss-preview-corner-tl"></div>
        <div class="rl-boss-preview-corner rl-boss-preview-corner-tr"></div>
        <div class="rl-boss-preview-corner rl-boss-preview-corner-bl"></div>
        <div class="rl-boss-preview-corner rl-boss-preview-corner-br"></div>
        <div class="rl-boss-preview-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7 5 a5 5 0 0 1 10 0 v6 a5 5 0 0 1 -10 0 z"/>
            <path d="M9 9 v1 M15 9 v1 M9 13 v3 M12 13 v4 M15 13 v3"/>
          </svg>
        </div>
        <div class="rl-boss-preview-text">
          <div class="rl-boss-preview-act-tag">ACT ${act} BOSS</div>
          <div class="rl-boss-preview-name">${preview.persona}</div>
          <div class="rl-boss-preview-meta">
            <span class="rl-boss-preview-arch">${preview.archetype}</span>
            <span class="rl-boss-preview-sep">·</span>
            <span class="rl-boss-preview-hp">${preview.hpRange} HP</span>
          </div>
          <div class="rl-boss-preview-flavor">${preview.flavor}</div>
          ${preview.signature && preview.signature.length ? `
            <div class="rl-boss-preview-sig">
              <span class="rl-boss-preview-sig-label">Signature:</span>
              ${preview.signature.map(n => `<span class="rl-boss-preview-sig-card">${n}</span>`).join('<span class="rl-boss-preview-sig-sep">·</span>')}
            </div>` : ''}
        </div>
      </div>`;
  },

  _renderRelicStrip(run) {
    if (!run.relics || !run.relics.length) return '';
    const html = run.relics.map(rid => {
      const r = this.RELICS.find(x => x.id === rid);
      if (!r) return '';
      const icon = this._relicIcon(r);
      return `<div class="rl-relic-chip rl-relic-${r.rarity}" title="${r.name} — ${r.desc.replace(/"/g, '&quot;')}">
                <span class="rl-relic-chip-icon">${icon}</span>
                <span class="rl-relic-chip-name">${r.name}</span>
              </div>`;
    }).join('');
    return `<div class="rl-relic-strip">${html}</div>`;
  },
  _renderRelicList() {
    const run = Game.state.roguelite;
    if (!run) return '';
    if (!run.relics.length) return '<div class="rl-empty-state">No relics yet — earn them through events, shops, and bosses.</div>';
    // Relics now render as proper Tron cards — beveled corners, neon
    // border-glow ring, theme-driven accent. User feedback: "the relic
    // looks fine here, but that needs to look way more Tron. Maybe
    // like a card or something. It looks very flat right now."
    return `<div class="rl-relic-grid rl-relic-grid-tron">${run.relics.map(rid => {
      const r = this.RELICS.find(x => x.id === rid);
      if (!r) return '';
      return `
        <div class="rl-relic-card rl-relic-card-tron rl-relic-${r.rarity}">
          <span class="rl-relic-card-corner rl-relic-card-corner-tl"></span>
          <span class="rl-relic-card-corner rl-relic-card-corner-tr"></span>
          <span class="rl-relic-card-corner rl-relic-card-corner-bl"></span>
          <span class="rl-relic-card-corner rl-relic-card-corner-br"></span>
          <div class="rl-relic-card-icon">${this._relicIcon(r)}</div>
          <div class="rl-relic-card-name">${r.name}</div>
          <div class="rl-relic-card-rarity">${this.displayRarity(r.rarity).toUpperCase()}</div>
          <div class="rl-relic-card-desc">${r.desc}</div>
          <span class="rl-relic-card-glow" aria-hidden="true"></span>
        </div>`;
    }).join('')}</div>`;
  },
  // Glyph for each relic (Tron-flavored ASCII / Unicode marks). Falls
  // back to first letter of name when no explicit glyph defined.
  // Glyphs that have emoji presentation by default (⚡, ♥, ✊) get the
  // U+FE0E variation selector appended so the OS renders them as text
  // characters instead of colored emoji — that way the CSS neon glow
  // (color + drop-shadow filters on .rl-mm-glyph) actually paints them.
  _relicIcon(r) {
    const map = {
      'crimson-cuirass':  '♥︎',  // ♥
      'lucky-coin':       '⌽',
      'old-manuscript':   '✎',
      'battery':          '⚡︎',  // ⚡ forced to text presentation
      'healing-brew':     '⚗',
      'steel-heart':      '◈',
      'anchor':           '⚓︎',  // ⚓ forced to text presentation
      'whetstone':        '⌖',
      'toy-ornithopter':  '⌬',
      'spider-web':       '✱',
      'vampire-fang':     '◢',
      'iron-maiden':      '☗',
      'phoenix-feather':  '☼',
      'gamblers-glove':   '◇',
      'bag-of-marbles':   '◉',
      'smiling-mask':     '☻',
      'mirror-shard':     '◢◣',
      'speed-force':      '⟪',
      'reality-stone':    '◎',
      'thanos-gauntlet':  '✊︎',  // ✊
      'cursed-key':       '⚷',
    };
    return map[r.id] || (r.name[0] || '?');
  },
  _modal(title, body) {
    let modal = document.getElementById('rl-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'rl-modal';
      modal.className = 'rl-modal';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `
      <div class="rl-modal-backdrop" onclick="Roguelite._closeModal()"></div>
      <div class="rl-modal-panel">
        <button type="button" class="rl-modal-close" onclick="Roguelite._closeModal()">×</button>
        <h2 class="rl-modal-title">${title}</h2>
        ${body}
      </div>`;
    modal.style.display = 'flex';
  },
  _closeModal() {
    const m = document.getElementById('rl-modal');
    if (m) m.style.display = 'none';
  },
  _renderDeckList() {
    const run = Game.state.roguelite;
    if (!run || !run.deck || !run.deck.length) {
      return '<div class="rl-empty-state">Deck is empty.</div>';
    }
    // No more wrapping .rl-deck-slot box around each card. User: "get
    // rid of the boxes around the cards. Just have the cards." The
    // rarity tinting flows through the card chrome itself, so the
    // individual box was redundant.
    return `<div class="rl-deck-grid rl-deck-grid-bare">${run.deck.map(d => this._renderCodexCard(d)).join('')}</div>`;
  },
  _renderTrickList() {
    const run = Game.state.roguelite;
    if (!run || !run.tricks || !run.tricks.length) {
      return '<div class="rl-empty-state">No tricks in your deck yet.</div>';
    }
    // 3-across grid using full trick-card chrome (matches the codex
    // grid). User: "the trick cards should literally be like the codex
    // where it's like the same trick cards. Where they're three across
    // and you just go down."
    return `<div class="rl-deck-grid rl-deck-grid-tricks">${run.tricks.map(t => this._renderTrickCard(t)).join('')}</div>`;
  },
  _renderTrickCard(t) {
    const def = (typeof TRICK_DEFS !== 'undefined') ? TRICK_DEFS.find(d => d.name === t.defName) : null;
    if (!def) return `<div class="rl-card-tile rl-tier-${t.rarity || 'common'}">${t.defName}</div>`;
    // Render as a full trick card with the in-game .trick-card chrome —
    // big purple cost diamond, name banner, description block. Mirrors
    // the codex/deck-builder presentation so trick + card modals feel
    // consistent.
    const costClass = 'cost-' + Math.min(10, Math.max(0, def.cost || 0));
    // UI.formatDesc may rely on `this` (calls this.stripTraitDesc),
    // so bind it before invoking.
    const formatDesc = (typeof UI !== 'undefined' && UI.formatDesc)
      ? UI.formatDesc.bind(UI) : (s => s);
    return `
      <div class="card hand-card trick-card ${costClass}" data-card-name="${def.name}">
        <span class="card-cost">${def.cost}</span>
        <div class="card-name-banner"><div class="card-name">${def.name}</div></div>
        <div class="card-desc">${formatDesc(def.desc || '')}</div>
      </div>`;
  },

  _formatLastResult(r) {
    if (r.boss) {
      const bits = [];
      if (r.bossRelic) bits.push(`Boss relic: <b>${r.bossRelic}</b>`);
      if (r.gold) bits.push(`+${r.gold} gold`);
      return `<div class="rl-last-note rl-last-note-boss">★ Act boss defeated! ${bits.join(' · ')}</div>`;
    }
    if (r.eliteRelic) {
      const goldBit = r.gold ? ` · +${r.gold} gold` : '';
      return `<div class="rl-last-note rl-last-note-elite">Elite vanquished — gained relic: <b>${r.eliteRelic}</b>${goldBit}.</div>`;
    }
    if (r.event) return `<div class="rl-last-note">${r.event}</div>`;
    if (r.shop)  return `<div class="rl-last-note">${r.shop}</div>`;
    if (r.hpLoss != null) {
      const goldBit = r.gold ? ` · <b>+${r.gold}g</b>` : '';
      return `<div class="rl-last-note">Combat won — took <b>${r.hpLoss}</b> HP damage${goldBit}.</div>`;
    }
    return '';
  },

  _renderRewards() {
    const run = Game.state.roguelite;
    if (!run || !run.pendingRewards) return '';
    // Wire up keyboard shortcuts on the rewards screen — 1/2/3 picks
    // the matching card, S/Esc skips. Only attach once per render.
    this._installRewardKeyboard();
    return `
      <div class="rl-panel rl-rewards-panel">
        <h1 class="rl-title">Victory</h1>
        <p class="rl-subtitle">Pick one card to add to your deck — <span class="rl-kb-hint">1/2/3 to pick · S to skip</span></p>
        <div class="rl-rewards-grid">
          ${run.pendingRewards.map((deckCard, i) => `
            <button type="button" class="rl-reward-slot rl-tier-${deckCard.rarity}" onclick="Roguelite.pickReward(${i})">
              <span class="rl-reward-kb">${i + 1}</span>
              <div class="rl-reward-rarity">${this.displayRarity(deckCard.rarity).toUpperCase()}</div>
              ${this._renderCodexCard(deckCard)}
            </button>
          `).join('')}
        </div>
        <div class="rl-rewards-skip">
          <button type="button" class="rl-skip-btn" onclick="Roguelite.pickReward(null)">Skip — +50g <span class="rl-kb-hint">(S)</span></button>
        </div>
      </div>`;
  },

  // Keyboard handler for the reward screen — 1/2/3 picks, S/Esc skips.
  // User polish: "faster runs for keyboard players." Idempotent —
  // re-installs cleanly on every render without leaking old listeners.
  _installRewardKeyboard() {
    if (this._rewardKbHandler) {
      document.removeEventListener('keydown', this._rewardKbHandler);
    }
    this._rewardKbHandler = (e) => {
      // Only fire while we're on the rewards phase and not typing in an input.
      if (Game.state.phase !== 'roguelite-rewards') return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1;
        const run = Game.state.roguelite;
        if (run && run.pendingRewards && run.pendingRewards[idx]) {
          e.preventDefault();
          this.pickReward(idx);
        }
      } else if (e.key === 's' || e.key === 'S' || e.key === 'Escape') {
        e.preventDefault();
        this.pickReward(null);
      }
    };
    document.addEventListener('keydown', this._rewardKbHandler);
  },

  // Render a deck card using the EXACT same chrome as the codex /
  // encyclopedia (.card.hand-card.cost-N + cost diamond top-left, ATK
  // orb bottom-left, HP orb bottom-right, abilities, description). The
  // rarity color decorates via the .rl-tier-<r> wrapper class — green
  // for common, cyan for rare, silver for special, gold for legendary.
  // Etches stack into the abilities row so they read inline.
  _renderCodexCard(deckCard) {
    // Sanitize stale incompatible etches first so the renderer reads
    // the cleaned-up etch list. Idempotent — no-op for non-discard
    // cards or already-clean ones. Defensively also runs in
    // buildRunCard at fight-start time.
    this._sanitizeDeckCardStatuses(deckCard);
    const def = deckCard._def
      || (typeof CARD_DEFS !== 'undefined' ? CARD_DEFS.find(d => d.name === deckCard.defName) : null)
      || this.STARTER_DEFS.find(d => d.name === deckCard.defName)
      || this.AI_VANILLA_DEFS.find(d => d.name === deckCard.defName);
    if (!def) return `<div class="card hand-card cost-0">${deckCard.defName}</div>`;
    // Step 1: tier-based stat resolution. Common −1/−1, Rare base,
    // Special +1/+1, Legendary +2/+2 (1/1 floor; starter cards skip
    // the Common penalty).
    const resolved = this._resolveStats(def, deckCard.rarity, deckCard._isStarter);
    let atk = resolved.atk;
    let hp = resolved.hp;
    let cost = def.cost || 0;
    // Strip baseline keyword badges in roguelite — same rule as
    // buildRunCard, so the codex display matches what the card
    // actually does in-game. Etch-added abilities still flow in
    // through the etch.apply probe loop below.
    const rawAbilities = (def.abilities || []).slice();
    const abilities = (deckCard._isStarter || def._isCurse)
      ? rawAbilities
      : rawAbilities.filter(ab => /^Revive(\s|$)/i.test(ab));
    // Step 2: stack each etch on a probe so we can read final stats +
    // capture cost mods + ability adds without touching the live card.
    (deckCard.statuses || []).forEach(id => {
      const etch = this._findEtch(id);
      if (!etch) return;
      const probe = {
        attack: atk, health: hp, maxHealth: hp, currentHealth: hp,
        cost, baseCost: cost,
        evadeCharges: 0, splashRange: 0, armorValue: 0,
        isBullseye: false, isOverdrive: false, hasHunt: false,
        isUntrickable: false, isCrazy: false,
        invincibleTurns: 0, unresistibleTurns: 0, tauntTurns: 0,
        reviveCharges: 0,
        abilities,
      };
      try { etch.apply(probe); } catch (e) {}
      atk = probe.attack;
      hp = probe.health;
      cost = probe.cost;
    });
    const costClass = 'cost-' + Math.min(10, Math.max(0, cost));
    // Pip count tracks RUN rarity, not intrinsic cost — common=1, rare=2,
    // special=3, legendary=4. So a Legendary Goon shows 4 gold pips.
    const pipsByRarity = { common: 1, rare: 2, special: 3, legendary: 4 };
    const pips = pipsByRarity[deckCard.rarity] || 1;
    const rarityPips = `<span class="rarity-strip" aria-hidden="true">${'<span class="rpip"></span>'.repeat(pips)}</span>`;
    const abilitiesHtml = abilities.length
      ? `<div class="card-abilities status-badges">${(typeof UI !== 'undefined' && UI.formatAbilityBadges) ? UI.formatAbilityBadges(abilities) : abilities.map(a => `<span class="status-badge">${a}</span>`).join('')}</div>` : '';
    // Per-rarity description swap (roguelite-only). Cards with a
    // RARITY_DESCS entry override their def desc so the text matches
    // the actual ability variant at this tier. Falls through to base
    // def text when the card has no rarity-specific variant.
    //
    // Common-tier cards explicitly read the BASE (rare) text. User
    // direction: "don't touch the text for common cards — revert that
    // change." So a Common Hawkeye displays the same printed ability
    // as a Rare Hawkeye; the only common-tier nerf is the -1/-1 stat
    // penalty. Special and Legendary still get their scaled-up text
    // variants. Text+ etches earned via level-up promote the displayed
    // tier (Rare card with Text+ reads as Special).
    const variantDescs = this.RARITY_DESCS[def.name];
    const tiers = ['common', 'rare', 'special', 'legendary'];
    let dispTier = deckCard.rarity || 'rare';
    if (dispTier === 'common') dispTier = 'rare';
    // If the card carries text-upgrade etches in its statuses, bump
    // the display tier up by that count so the printed ability matches
    // what the engine will actually do at runtime.
    const textBumps = (deckCard.statuses || []).filter(id => id === 'text-upgrade').length;
    if (textBumps) {
      let i = tiers.indexOf(dispTier);
      i = Math.min(tiers.length - 1, i + textBumps);
      dispTier = tiers[i];
    }
    const variantDesc = variantDescs && variantDescs[dispTier];
    const descText = variantDesc || def.desc;
    const descHtml = descText
      ? `<div class="card-desc">${(typeof UI !== 'undefined' && UI.formatDesc) ? UI.formatDesc.call(UI, descText) : descText}</div>`
      : '';
    // Stat-deviation indicator vs. the def's RARE-tier base. Common
    // versions show ▼ on stats below base, Special/Legendary show ▲
    // on stats above. Etch bumps also push stats above base → ▲.
    // Starter cards always read clean (no indicator) since they
    // sit at face stats by design.
    const baseAtk = def.attack || 0;
    const baseHp = def.health || 0;
    const atkClass = !deckCard._isStarter && atk > baseAtk ? 'stat-rolled-up' : (!deckCard._isStarter && atk < baseAtk ? 'stat-rolled-down' : '');
    const hpClass  = !deckCard._isStarter && hp  > baseHp  ? 'stat-rolled-up' : (!deckCard._isStarter && hp  < baseHp  ? 'stat-rolled-down' : '');
    // XP progress display — shown as a thin bar at the bottom of the
    // card so the player can see how close their card is to the next
    // tier. Legendary cards are capped, no bar shown.
    const xpHtml = this._renderCodexXp(deckCard);
    const curseCls = deckCard._isCurse ? ' rl-curse' : '';
    return `
      <div class="card hand-card ${costClass} rl-tier-${deckCard.rarity}${curseCls}" data-card-name="${def.name}">
        <span class="card-cost">${cost}</span>
        ${rarityPips}
        <div class="card-name-banner"><div class="card-name">${def.name}</div></div>
        ${abilitiesHtml}
        ${descHtml}
        <span class="stat-circle stat-atk ${atkClass}">${atk}</span>
        <span class="stat-circle stat-hp ${hpClass}">${hp}</span>
        ${xpHtml}
      </div>`;
  },

  // Compact XP progress strip — shown at the bottom of each codex card
  // so the player can see how much XP each card has accumulated and
  // how close it is to its next tier. Legendaries are capped, no bar.
  _renderCodexXp(deckCard) {
    if (!deckCard) return '';
    if (deckCard.rarity === 'legendary') {
      return '<div class="rl-card-xp rl-card-xp-cap">MAX</div>';
    }
    const xp = deckCard.xp || 0;
    const threshold = (this.XP_THRESHOLDS && this.XP_THRESHOLDS[deckCard.rarity]) || 0;
    if (!threshold) return '';
    const pct = Math.min(100, Math.max(0, Math.round((xp / threshold) * 100)));
    return `
      <div class="rl-card-xp">
        <div class="rl-card-xp-bar">
          <div class="rl-card-xp-fill" style="width:${pct}%"></div>
        </div>
        <div class="rl-card-xp-label">${xp}/${threshold} XP</div>
      </div>`;
  },

  _renderEnd() {
    const run = Game.state.roguelite;
    if (!run) return '';
    // Detect victory by reaching the final boss row, not by node count
    // (the saved-run path doesn't always update currentNode).
    const finalBossKilled = run.lastResult && run.lastResult.nodeType === 'final-boss' && run.lastResult.won;
    const won = finalBossKilled || run.hp > 0 && run.currentNode >= (run.totalNodes || 0) && run.totalNodes > 0;
    const stats = run._stats || {};
    // Run-time formatter — m:ss or h:mm:ss.
    const elapsedMs = stats.startTime ? Math.max(0, Date.now() - stats.startTime) : 0;
    const totalSec = Math.floor(elapsedMs / 1000);
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    const timeStr = hh > 0
      ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
      : `${mm}:${String(ss).padStart(2, '0')}`;
    // MVP card — top XP-earning card from the run deck. Skip starters
    // (they level slow and would dominate by participation). XP since
    // last promotion is what's stored on deckCard.xp; pair with rarity
    // for a "value" sort.
    const tierIdx = (r) => this.TIER_INDEX[r] || 0;
    const sortedByXp = (run.deck || []).slice()
      .filter(d => !d._isStarter && !d._isCurse)
      .sort((a, b) => (tierIdx(b.rarity) - tierIdx(a.rarity)) || ((b.xp || 0) - (a.xp || 0)));
    const mvp = sortedByXp[0];
    // Best relic — rarest one collected (boss > rare > common).
    const relicRank = { common: 1, rare: 2, special: 3, boss: 4 };
    const sortedRelics = (run.relics || []).map(rid => this.RELICS.find(r => r.id === rid)).filter(Boolean)
      .sort((a, b) => (relicRank[b.rarity] || 0) - (relicRank[a.rarity] || 0));
    const bestRelic = sortedRelics[0];
    const titleLine = won ? 'RUN COMPLETE' : 'YOU FELL';
    const ascLevel = run.ascension || 0;
    const ascName = (this.ASCENSION_LEVELS[ascLevel] || {}).name || 'Standard';
    const ascTag = ascLevel > 0 ? ` · A${ascLevel} ${ascName}` : '';
    const subtitle = (won
      ? 'You reached the top of the grid.'
      : (stats.fightsWon || 0) >= 5 ? 'A long climb, but the grid claimed you in the end.'
      : 'A short run. The grid didn\'t make it easy.') + ascTag;
    return `
      <div class="rl-panel rl-end-panel">
        <h1 class="rl-title rl-end-title ${won ? 'rl-end-victory' : 'rl-end-defeat'}">${titleLine}</h1>
        <p class="rl-end-subtitle">${subtitle}</p>
        <div class="rl-end-stat-grid">
          <div class="rl-end-stat-tile">
            <div class="rl-end-stat-label">Fights Won</div>
            <div class="rl-end-stat-value">${stats.fightsWon || 0}</div>
          </div>
          <div class="rl-end-stat-tile">
            <div class="rl-end-stat-label">Elites</div>
            <div class="rl-end-stat-value">${stats.elitesWon || 0}</div>
          </div>
          <div class="rl-end-stat-tile">
            <div class="rl-end-stat-label">Bosses</div>
            <div class="rl-end-stat-value">${stats.bossesWon || 0}</div>
          </div>
          <div class="rl-end-stat-tile">
            <div class="rl-end-stat-label">Gold Earned</div>
            <div class="rl-end-stat-value">${stats.goldEarned || run.gold || 0}</div>
          </div>
          <div class="rl-end-stat-tile">
            <div class="rl-end-stat-label">Final HP</div>
            <div class="rl-end-stat-value">${run.hp}/${run.maxHp}</div>
          </div>
          <div class="rl-end-stat-tile">
            <div class="rl-end-stat-label">Deck Size</div>
            <div class="rl-end-stat-value">${run.deck.length}</div>
          </div>
          <div class="rl-end-stat-tile">
            <div class="rl-end-stat-label">Run Time</div>
            <div class="rl-end-stat-value">${timeStr}</div>
          </div>
          <div class="rl-end-stat-tile">
            <div class="rl-end-stat-label">HP Lost</div>
            <div class="rl-end-stat-value">${stats.totalHpLost || 0}</div>
          </div>
        </div>
        ${(() => {
          const achievements = this.computeRunAchievements(run, won);
          if (!achievements.length) return '';
          const badges = achievements.map(a =>
            `<div class="rl-end-achievement rl-end-achievement-${a.tier}" title="${a.desc.replace(/"/g, '&quot;')}">
              <span class="rl-end-achievement-glyph">★</span>
              <span class="rl-end-achievement-label">${a.label}</span>
            </div>`
          ).join('');
          return `
            <div class="rl-end-section-title">★ ACHIEVEMENTS</div>
            <div class="rl-end-achievements">${badges}</div>`;
        })()}
        ${mvp ? `
          <div class="rl-end-mvp">
            <div class="rl-end-section-title">★ MVP CARD</div>
            <div class="rl-end-mvp-row">
              <span class="rl-end-mvp-name rl-tier-${mvp.rarity}-text">${mvp.defName}</span>
              <span class="rl-end-mvp-meta">${this.displayRarity(mvp.rarity)} · ${mvp.xp || 0} XP</span>
            </div>
          </div>` : ''}
        ${bestRelic ? `
          <div class="rl-end-relic">
            <div class="rl-end-section-title">★ STANDOUT RELIC</div>
            <div class="rl-end-mvp-row">
              <span class="rl-end-mvp-name">${bestRelic.name}</span>
              <span class="rl-end-mvp-meta">${this.displayRarity(bestRelic.rarity || 'common')}</span>
            </div>
            <div class="rl-end-relic-desc">${bestRelic.desc || ''}</div>
          </div>` : ''}
        <div class="rl-end-section-title">★ FINAL DECK (${run.deck.length})</div>
        <div class="rl-end-deck">
          ${run.deck.map(d => `<span class="rl-deck-card rl-rarity-${d.rarity}">${d.defName}</span>`).join('')}
        </div>
        <div class="rl-end-actions">
          <button type="button" class="btn btn-primary" onclick="Roguelite.enterRun()">New Run</button>
          <button type="button" class="btn btn-secondary" onclick="Roguelite.openRunHistory()">Run History</button>
          <button type="button" class="btn btn-secondary" onclick="Roguelite.abandonRun()">Main Menu</button>
        </div>
      </div>`;
  },
};

// Globally exposed for inline onclick handlers (matches the rest of the
// codebase's pattern — Game / UI / Multiplayer all expose the same way).
if (typeof window !== 'undefined') window.Roguelite = Roguelite;
