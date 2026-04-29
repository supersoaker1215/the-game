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
    return pick.name;
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
  ETCHES: {
    common: [
      { id: 'plus1-atk',     name: '+1 ATK',    apply: c => { c.attack += 1; } },
      { id: 'plus1-hp',      name: '+1 HP',     apply: c => { c.health += 1; c.maxHealth += 1; c.currentHealth += 1; } },
      { id: 'plus1-atk-hp',  name: '+1/+1',     apply: c => { c.attack += 1; c.health += 1; c.maxHealth += 1; c.currentHealth += 1; } },
      { id: 'evade-1',       name: 'Evade 1',   apply: c => { c.evadeCharges = (c.evadeCharges || 0) + 1; if (!c.abilities.includes('Evade 1')) c.abilities.push('Evade 1'); } },
      { id: 'bullseye',      name: 'Bullseye',  apply: c => { c.isBullseye = true; if (!c.abilities.includes('Bullseye')) c.abilities.push('Bullseye'); } },
      { id: 'splash-1',      name: 'Splash 1',  apply: c => { c.splashRange = (c.splashRange || 0) + 1; if (!c.abilities.includes('Splash 1')) c.abilities.push('Splash 1'); } },
      { id: 'armor-1',       name: 'Armor 1',   apply: c => { c.armorValue = (c.armorValue || 0) + 1; if (!c.abilities.includes('Armor 1')) c.abilities.push('Armor 1'); } },
      { id: 'hunt',          name: 'Hunt',      apply: c => { c.hasHunt = true; if (!c.abilities.includes('Hunt')) c.abilities.push('Hunt'); } },
      { id: 'untrickable',   name: 'Untrickable', apply: c => { c.isUntrickable = true; if (!c.abilities.includes('Untrickable')) c.abilities.push('Untrickable'); } },
      { id: 'discount-1',    name: 'Discount 1', apply: c => { c.cost = Math.max(0, (c.cost || 0) - 1); c.baseCost = Math.max(0, (c.baseCost || c.cost || 0) - 1); if (!c.abilities.includes('Discount 1')) c.abilities.push('Discount 1'); } },
      { id: 'taunt-1',       name: 'Taunt 1',   apply: c => { c.tauntTurns = Math.max(c.tauntTurns || 0, 1); if (!c.abilities.includes('Taunt 1')) c.abilities.push('Taunt 1'); } },
      // Crazy + Insane intentionally NOT in the etch pool — they're
      // ATK-randomizers (debuff-shaped), not upgrades. User: "kinda
      // like debuffs to the cards, just get those out of there."
    ],
    rare: [
      { id: 'plus2-atk',     name: '+2 ATK',    apply: c => { c.attack += 2; } },
      { id: 'plus2-hp',      name: '+2 HP',     apply: c => { c.health += 2; c.maxHealth += 2; c.currentHealth += 2; } },
      { id: 'plus2-atk-hp',  name: '+2/+2',     apply: c => { c.attack += 2; c.health += 2; c.maxHealth += 2; c.currentHealth += 2; } },
      { id: 'evade-2',       name: 'Evade 2',   apply: c => { c.evadeCharges = (c.evadeCharges || 0) + 2; if (!c.abilities.includes('Evade 2')) c.abilities.push('Evade 2'); } },
      { id: 'overdrive',     name: 'Overdrive', apply: c => { c.isOverdrive = true; if (!c.abilities.includes('Overdrive')) c.abilities.push('Overdrive'); } },
      { id: 'splash-2',      name: 'Splash 2',  apply: c => { c.splashRange = (c.splashRange || 0) + 2; if (!c.abilities.includes('Splash 2')) c.abilities.push('Splash 2'); } },
      { id: 'armor-2',       name: 'Armor 2',   apply: c => { c.armorValue = (c.armorValue || 0) + 2; if (!c.abilities.includes('Armor 2')) c.abilities.push('Armor 2'); } },
      { id: 'fear-1',        name: 'Fear 1',    apply: c => { c.hasFear = (c.hasFear || 0) + 1; if (!c.abilities.includes('Fear 1')) c.abilities.push('Fear 1'); } },
      { id: 'discount-2',    name: 'Discount 2', apply: c => { c.cost = Math.max(0, (c.cost || 0) - 2); c.baseCost = Math.max(0, (c.baseCost || c.cost || 0) - 2); if (!c.abilities.includes('Discount 2')) c.abilities.push('Discount 2'); } },
      { id: 'thorns',        name: 'Thorns',    apply: c => { c.hasThorns = (c.hasThorns || 0) + 1; if (!c.abilities.includes('Thorns')) c.abilities.push('Thorns'); } },
      { id: 'cantrip',       name: 'Cantrip',   apply: c => { c.hasCantrip = (c.hasCantrip || 0) + 1; if (!c.abilities.includes('Cantrip')) c.abilities.push('Cantrip'); } },
    ],
    special: [
      { id: 'plus3-atk',     name: '+3 ATK',    apply: c => { c.attack += 3; } },
      { id: 'plus3-hp',      name: '+3 HP',     apply: c => { c.health += 3; c.maxHealth += 3; c.currentHealth += 3; } },
      { id: 'plus3-atk-hp',  name: '+3/+3',     apply: c => { c.attack += 3; c.health += 3; c.maxHealth += 3; c.currentHealth += 3; } },
      { id: 'splash-3',      name: 'Splash 3',  apply: c => { c.splashRange = (c.splashRange || 0) + 3; if (!c.abilities.includes('Splash 3')) c.abilities.push('Splash 3'); } },
      { id: 'invincible-1',  name: 'Invincible 1', apply: c => { c.invincibleTurns = 1; if (!c.abilities.includes('Invincible 1')) c.abilities.push('Invincible 1'); } },
      { id: 'unresistible-1',name: 'Unresistible 1', apply: c => { c.unresistibleTurns = 1; if (!c.abilities.includes('Unresistible 1')) c.abilities.push('Unresistible 1'); } },
      { id: 'discount-3',    name: 'Discount 3', apply: c => { c.cost = Math.max(0, (c.cost || 0) - 3); c.baseCost = Math.max(0, (c.baseCost || c.cost || 0) - 3); if (!c.abilities.includes('Discount 3')) c.abilities.push('Discount 3'); } },
      { id: 'lifesteal',     name: 'Lifesteal', apply: c => { c.hasLifesteal = (c.hasLifesteal || 0) + 1; if (!c.abilities.includes('Lifesteal')) c.abilities.push('Lifesteal'); } },
      { id: 'berserker',     name: 'Berserker', apply: c => { c.hasBerserker = (c.hasBerserker || 0) + 1; if (!c.abilities.includes('Berserker')) c.abilities.push('Berserker'); } },
      { id: 'zealot',        name: 'Zealot',    apply: c => { c.hasZealot = (c.hasZealot || 0) + 1; if (!c.abilities.includes('Zealot')) c.abilities.push('Zealot'); } },
    ],
    legendary: [
      { id: 'plus4-atk',     name: '+4 ATK',    apply: c => { c.attack += 4; } },
      { id: 'plus4-atk-hp',  name: '+4/+4',     apply: c => { c.attack += 4; c.health += 4; c.maxHealth += 4; c.currentHealth += 4; } },
      { id: 'splash-4',      name: 'Splash 4',  apply: c => { c.splashRange = (c.splashRange || 0) + 4; if (!c.abilities.includes('Splash 4')) c.abilities.push('Splash 4'); } },
      { id: 'evade-4',       name: 'Evade 4',   apply: c => { c.evadeCharges = (c.evadeCharges || 0) + 4; if (!c.abilities.includes('Evade 4')) c.abilities.push('Evade 4'); } },
      { id: 'echo',          name: 'Echo',      apply: c => { c.hasEcho = (c.hasEcho || 0) + 1; if (!c.abilities.includes('Echo')) c.abilities.push('Echo'); } },
      { id: 'phoenix',       name: 'Phoenix',   apply: c => { c.hasPhoenix = (c.hasPhoenix || 0) + 1; if (!c.abilities.includes('Phoenix')) c.abilities.push('Phoenix'); } },
      { id: 'discount-4',    name: 'Discount 4', apply: c => { c.cost = Math.max(0, (c.cost || 0) - 4); c.baseCost = Math.max(0, (c.baseCost || c.cost || 0) - 4); if (!c.abilities.includes('Discount 4')) c.abilities.push('Discount 4'); } },
    ],
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
    {
      id: 'crimson-cuirass', name: 'Crimson Cuirass', rarity: 'common',
      desc: '+5 max HP. Heal 5 HP on pickup.',
      onAcquire(run) { run.maxHp += 5; run.hp = Math.min(run.maxHp, run.hp + 5); },
    },
    {
      id: 'lucky-coin', name: 'Lucky Coin', rarity: 'common',
      desc: 'Gain +5 gold after every fight won.',
      onFightEnd(run, won) { if (won) run.gold += 5; },
    },
    {
      id: 'old-manuscript', name: 'Old Manuscript', rarity: 'common',
      desc: 'Start each combat round with +1 card drawn.',
      onFightStart(run) { run._extraDraw = (run._extraDraw || 0) + 1; },
    },
    {
      id: 'battery', name: 'Battery', rarity: 'common',
      desc: 'Start each combat round with +1 energy.',
      onFightStart(run) { run._extraEnergy = (run._extraEnergy || 0) + 1; },
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
  ],

  // Apply a hook across all owned relics. Errors caught + logged so a
  // bad relic def doesn't kill the run.
  _applyRelicHook(run, hookName, ...args) {
    if (!run || !run.relics) return;
    run.relics.forEach(rid => {
      const r = this.RELICS.find(x => x.id === rid);
      if (r && typeof r[hookName] === 'function') {
        try { r[hookName](run, ...args); } catch (e) { console.warn('[RELIC]', rid, hookName, e); }
      }
    });
  },

  // Grant a relic to the run. Idempotent — duplicates rejected.
  // Fires onAcquire so any one-shot effect (HP bump, gold, etc.) lands
  // immediately. Caller is responsible for showing the toast / cue.
  grantRelic(run, relicId) {
    if (!run || !relicId) return false;
    if (run.relics.includes(relicId)) return false;
    const r = this.RELICS.find(x => x.id === relicId);
    if (!r) return false;
    run.relics.push(relicId);
    if (typeof r.onAcquire === 'function') {
      try { r.onAcquire(run); } catch (e) { console.warn('[RELIC onAcquire]', relicId, e); }
    }
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
  CARD_DROP_WEIGHTS: { common: 60, rare: 25, special: 12, legendary: 3 },
  CARD_RARITY_ETCH_COUNT: { common: 0, rare: 1, special: 2, legendary: 3 },
  // When a leveled-up card hits a new tier, that's worth its own etch
  // count. XP thresholds increase per tier so legendary takes commitment.
  XP_THRESHOLDS: { common: 40, rare: 120, special: 280 },
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
    };
    if (boon) {
      if (boon.bonusCard) {
        run.deck.push(this._makeDeckCard(boon.bonusCard, 'rare'));
      }
      if (boon.startingHp != null) { run.hp = boon.startingHp; run.maxHp = boon.startingHp; }
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
      apply: () => ({ startingHp: 40 }),
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
    const rawAbilities = [...(def.abilities || [])];
    const abilities = (deckCard._isStarter || def._isCurse)
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
    if (owner === 'player') {
      const run = Game.state && Game.state.roguelite;
      if (run) this._applyRelicHook(run, 'onCardBuild', card);
    }
    // Tag the card with its run metadata so XP can be credited at end of fight
    card._runDeckCardRef = deckCard;
    card._runRarity = deckCard.rarity;
    // Curse flag — Game.createCardInstance doesn't pass through arbitrary
    // def fields, so re-stamp it from the def/deckCard. The dim purple
    // tint, deck-removal hint, and tier-bypass logic all key off this.
    if (def._isCurse || deckCard._isCurse) card._isCurse = true;
    return card;
  },

  _findEtch(etchId) {
    for (const tier of Object.keys(this.ETCHES)) {
      const e = this.ETCHES[tier].find(x => x.id === etchId);
      if (e) return e;
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
    let pool;
    if (act === 1) {
      pool = CARD_DEFS.filter(c => (c.cost || 0) <= 4);
    } else if (act === 2) {
      pool = CARD_DEFS.filter(c => (c.cost || 0) >= 3 && (c.cost || 0) <= 7);
    } else {
      pool = CARD_DEFS.filter(c => (c.cost || 0) >= 5);
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
      const rarity = this._rollRarity(opts.rarityFloor);
      const deckCard = this._makeDeckCard(def.name, rarity, this._rollEtchesForRarity(rarity));
      // Reference to the def for the reward picker UI (cost, stats, desc).
      deckCard._def = def;
      out.push(deckCard);
    }
    return out;
  },

  // Rarity dice — weighted roll across CARD_DROP_WEIGHTS.
  _rollRarity(floor) {
    const w = this.CARD_DROP_WEIGHTS;
    const tiers = ['common', 'rare', 'special', 'legendary'];
    const startIdx = floor ? this.TIER_INDEX[floor] : 0;
    let total = 0;
    for (let i = startIdx; i < tiers.length; i++) total += w[tiers[i]];
    let roll = Math.random() * total;
    for (let i = startIdx; i < tiers.length; i++) {
      roll -= w[tiers[i]];
      if (roll <= 0) return tiers[i];
    }
    return tiers[startIdx];
  },

  // Pre-populate etches based on the rolled rarity. A rare gets 1 random
  // etch from common/rare; a legendary gets 3 from any tier.
  _rollEtchesForRarity(rarity) {
    const count = this.CARD_RARITY_ETCH_COUNT[rarity] || 0;
    if (!count) return [];
    // Build a pool of etch IDs allowed at this rarity (current tier
    // plus all lower tiers).
    const tierIdx = this.TIER_INDEX[rarity];
    const allowed = [];
    for (let i = 0; i <= tierIdx; i++) {
      const t = this.TIERS[i];
      this.ETCHES[t].forEach(e => allowed.push(e.id));
    }
    const out = [];
    while (out.length < count && allowed.length > 0) {
      const pick = allowed[Math.floor(Math.random() * allowed.length)];
      if (out.includes(pick)) continue;
      out.push(pick);
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
         hpRange: '28–38' },
    2: { key: 'act2-doom',    persona: 'Doctor Doom', archetype: 'Summon Swarm',
         flavor: 'Floods the board with Doombots and revives. Pack lane denial, Splash, and direct destroy.',
         hpRange: '40–55' },
    3: { key: 'act3-galactus', persona: 'Galactus', archetype: 'Devour / Cosmic',
         flavor: 'Devours weak cards, drops 10-cost titans, slows energy. Pack Untrickable and Armor.',
         hpRange: '70–90' },
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
    // Boss / final-boss — handcrafted decks (full power) with a small
    // HP wobble so even bosses don't always read the same.
    if (node.type === 'final-boss') {
      const t = this.BOSS_DECKS['act3-galactus'];
      return { deckNames: t.deck.slice(), tricks: t.tricks.slice(), hp: this._randInRange(70, 90), difficulty: 'hard', persona: t.persona };
    }
    if (node.type === 'boss') {
      const key = node.tier === 1 ? 'act1-luthor' : 'act2-doom';
      const t = this.BOSS_DECKS[key];
      const hp = node.tier === 1 ? this._randInRange(28, 38) : this._randInRange(40, 55);
      return { deckNames: t.deck.slice(), tricks: t.tricks.slice(), hp, difficulty: 'normal', persona: t.persona };
    }
    // Random fight — scaled by tier. Tier 1 follows a strict spec:
    // exactly 3 real (cost 1-3) cards, rest are vanilla bodies. So the
    // player's Goon/Thug/Brute starter has a parity opener to fight
    // before they ramp into real threats. Tier 2 mixes 30% vanilla
    // 70% real (cost 2-5). Tier 3 is full pool, cost 3-8.
    let costMin, costMax, hpMin, hpMax, difficulty, trickCount;
    if (node.tier === 1) {
      costMin = 1; costMax = 3; hpMin = 9;  hpMax = 17; difficulty = 'easy';   trickCount = 1;
    } else if (node.tier === 2) {
      costMin = 2; costMax = 5; hpMin = 17; hpMax = 30; difficulty = 'normal'; trickCount = 2;
    } else {
      costMin = 3; costMax = 8; hpMin = 25; hpMax = 45; difficulty = 'normal'; trickCount = 3;
    }
    let hp = this._randInRange(hpMin, hpMax);
    if (node.type === 'elite') { hp += this._randInRange(8, 14); difficulty = 'hard'; trickCount += 1; }

    const vanillaPool = this.AI_VANILLA_DEFS.filter(c => c.cost >= costMin && c.cost <= costMax);
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
      while (deck.length < 30 && vanillaPool.length) {
        const pick = pickFrom(vanillaPool);
        counts[pick.name] = (counts[pick.name] || 0) + 1;
        if (counts[pick.name] > 12) continue;  // soft cap so it varies
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
    return { deckNames: deck, tricks, hp, difficulty, persona: 'AI' };
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

  _rollLevelUpChoices(targetRarity, n) {
    // Pull from the leveled-up tier's pool + common fallback so the
    // bucket has variety; deduplicate by ID so the same etch can't
    // appear twice in a single 1-of-2 prompt.
    const tierPool = this.ETCHES[targetRarity] || [];
    const allEtches = [...tierPool, ...this.ETCHES.common];
    const stats = allEtches.filter(e => this._isStatEtch(e.id));
    const text  = allEtches.filter(e => !this._isStatEtch(e.id));
    const choices = [];
    const usedIds = new Set();
    let attempts = 0;
    while (choices.length < n && attempts < 50) {
      attempts++;
      const useStat = Math.random() < 0.80;  // 80% stat / 20% text
      const pool = useStat
        ? (stats.length ? stats : text)
        : (text.length ? text : stats);
      if (!pool.length) break;
      const cand = pool[Math.floor(Math.random() * pool.length)];
      if (usedIds.has(cand.id)) continue;
      usedIds.add(cand.id);
      choices.push({ id: cand.id, name: cand.name });
    }
    return choices;
  },

  attributeXp(run, s) {
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
      const ref = card._runDeckCardRef;
      ref.xp += earned;
      // Check rarity bump
      const tierIdx = this.TIER_INDEX[ref.rarity];
      if (tierIdx < 3) {
        const threshold = this.XP_THRESHOLDS[ref.rarity];
        if (ref.xp >= threshold) {
          ref.rarity = this.TIERS[tierIdx + 1];
          ref.xp = 0;  // reset on bump
          // Pick-1-of-2 etch options on level-up. User direction:
          // "reduce to 2 possibilities. Most likely roll discount /
          // damage / health. Text-based upgrade is rare." So we roll
          // each slot via a weighted bucket pick:
          //   80% → STAT bucket (damage/HP/discount/+combined-stat)
          //   20% → TEXT bucket (keyword/trait — Cantrip, Echo, etc.)
          // The buckets pull from the new tier's pool + common
          // fallback so a rare card-up-card can still see common
          // stat etches as the boring safe pick.
          const choices = this._rollLevelUpChoices(ref.rarity, 2);
          levelUps.push({
            defName: ref.defName,
            newRarity: ref.rarity,
            choices,
            cardRef: ref,
          });
        }
      }
    });
    return levelUps;
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
    Game.state.roguelite = saved;
    Game.state.phase = 'roguelite-map';
    UI.render();
  },

  enterRun() {
    // Confirm before nuking an in-progress save. The Continue Run
    // button on the main menu is the safe path; clicking the regular
    // Roguelite button after a save exists would silently overwrite.
    if (this.hasSavedRun() && typeof confirm === 'function') {
      const ok = confirm('You have a saved run in progress. Start a new run anyway? (Your save will be overwritten when you reach the map.)');
      if (!ok) return;
    }
    Game.state._starterPicks = {};
    // Roll 3 common relics for the relic-pick screen, excluding Steel
    // Heart since the user flagged it as too strong for a starter.
    Game.state._starterRelicPool = this._rollStarterRelicPool();
    Game.state._starterCardPool  = this._rollStarterCardPool();
    Game.state.phase = 'roguelite-pick-relic';
    UI.render();
  },

  // Common relics minus Steel Heart (user direction). Sample 4 unique
  // for the 2x2 grid layout. User: "make it four relics at the
  // beginning that you can pick. Just like the boon."
  _rollStarterRelicPool() {
    const pool = this.RELICS.filter(r => r.rarity === 'common' && r.id !== 'steel-heart');
    const shuffled = pool.slice().sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 4);
  },
  // Roll 3 unique common cards (cost 1-3, real cards — no vanillas, no
  // starter bodies). Pre-rolled with no etches; treated as Common rarity
  // when added to the deck (so they get the −1/−1 tier penalty).
  _rollStarterCardPool() {
    if (typeof CARD_DEFS === 'undefined') return [];
    const pool = CARD_DEFS.filter(d =>
      (d.cost || 0) >= 1 && (d.cost || 0) <= 3
      && !this.AI_VANILLA_DEFS.find(v => v.name === d.name)
      && !this.STARTER_DEFS.find(s => s.name === d.name)
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
      const rareEtches = this._rollEtchesForRarity('rare');
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
      <div class="rl-relic-grid rl-relic-grid-tron" style="margin-top:8px;">
        <div class="rl-relic-card rl-relic-card-tron rl-relic-${relic.rarity}">
          <span class="rl-relic-card-corner rl-relic-card-corner-tl"></span>
          <span class="rl-relic-card-corner rl-relic-card-corner-tr"></span>
          <span class="rl-relic-card-corner rl-relic-card-corner-bl"></span>
          <span class="rl-relic-card-corner rl-relic-card-corner-br"></span>
          <div class="rl-relic-card-icon">${this._relicIcon(relic)}</div>
          <div class="rl-relic-card-name">${relic.name}</div>
          <div class="rl-relic-card-rarity">${relic.rarity.toUpperCase()}</div>
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
    // XP attribution + level-ups for cards that participated.
    const levelUps = this.attributeXp(run, Game.state);
    // Run relic onFightEnd (gold gain, post-fight heals, gauntlet ticks).
    this._applyRelicHook(run, 'onFightEnd', won);
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
      Game.state.phase = 'roguelite-rewards';
      UI.render();
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
    run.lastResult = { event: result };
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
    return { cards: cardItems, etches: etchItems, relics: relicItems, removeCardPrice: 50, soldIdx: new Set() };
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
          <div class="rl-shop-slot-rarity">${item.payload.rarity.toUpperCase()}</div>
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
          <div class="rl-shop-relic-rarity">${item.payload.rarity.toUpperCase()}</div>
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
    const heal = Math.floor(run.maxHp * 0.3);
    const body = `
      <div class="rl-event-flavor">A safe pocket of unused grid. Spend the moment as you choose.</div>
      <div class="rl-event-choices">
        <button type="button" class="rl-event-choice" onclick="Roguelite._restHeal()">Rest — heal ${heal} HP</button>
        <button type="button" class="rl-event-choice" onclick="Roguelite._restUpgrade()">Etch a card — apply a random Common etch</button>
        <button type="button" class="rl-event-choice" onclick="Roguelite._restStatBump()">Sharpen a card — pick which stat to +1 (ATK or HP)</button>
      </div>`;
    this._modal('REST SITE', body);
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

  _restUpgrade() {
    const run = Game.state.roguelite;
    // Pick a random common etch to offer
    const pool = this.ETCHES.common;
    const etch = pool[Math.floor(Math.random() * pool.length)];
    run._pendingRestEtch = etch.id;
    const cards = run.deck.map((d, i) => `
      <div class="rl-deck-slot rl-tier-${d.rarity}" onclick="Roguelite._applyRestEtch(${i})" style="cursor:pointer">
        ${this._renderCodexCard(d)}
      </div>`).join('');
    const body = `
      <div class="rl-event-flavor">You etch <b>${etch.name}</b> into a card. Which one?</div>
      <div class="rl-deck-grid">${cards}</div>
      <div class="rl-shop-footer">
        <button type="button" class="rl-shop-leave" onclick="Roguelite._renderRestModal()">Back</button>
      </div>`;
    this._modal('SHARPEN A CARD', body);
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
    if (run.activeNode && run.activeNode.type === 'boss') {
      Game.state.phase = 'roguelite-end';
      UI.render();
      return;
    }
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
      run.tricks.push({ defName: run.pendingTrickReward.defName, rarity: 'common' });
    }
    run.pendingTrickReward = null;
    this._closeModal();
    this._afterRewardChain();
  },

  _renderLevelUpPicker() {
    const run = Game.state.roguelite;
    if (!run || !run._pendingLevelUps || !run._pendingLevelUps.length) {
      // All level-ups resolved — proceed to map
      run._pendingLevelUps = null;
      if (run.activeNode) {
        run.currentNodeId = run.activeNode.id;
        run.currentRow = run.activeNode.row;
      }
      if (run.activeNode && run.activeNode.type === 'boss') {
        Game.state.phase = 'roguelite-end';
      } else {
        Game.state.phase = 'roguelite-map';
      }
      UI.render();
      return;
    }
    const lu = run._pendingLevelUps[0];
    const choices = lu.choices.map((c, i) => `
      <button type="button" class="rl-event-choice" onclick="Roguelite._pickLevelUpEtch(${i})">${c.name}</button>
    `).join('');
    const body = `
      <div class="rl-event-flavor"><b>${lu.defName}</b> leveled up to <span class="rl-tier-${lu.newRarity}-text">${lu.newRarity.toUpperCase()}</span>! Pick an etch:</div>
      <div class="rl-event-choices">${choices}</div>`;
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
      run._pendingLevelUps = null;
      if (run.activeNode) {
        run.currentNodeId = run.activeNode.id;
        run.currentRow = run.activeNode.row;
      }
      if (run.activeNode && run.activeNode.type === 'boss') {
        Game.state.phase = 'roguelite-end';
      } else {
        Game.state.phase = 'roguelite-map';
      }
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
    if (phase === 'roguelite-pick-relic') el.innerHTML = this._renderPickRelic();
    else if (phase === 'roguelite-pick-card') el.innerHTML = this._renderPickCard();
    else if (phase === 'roguelite-start') el.innerHTML = this._renderStart();
    else if (phase === 'roguelite-map') el.innerHTML = this._renderMap();
    else if (phase === 'roguelite-rewards') el.innerHTML = this._renderRewards();
    else if (phase === 'roguelite-end') el.innerHTML = this._renderEnd();
    // Save / clear hooks — every map render snapshots state to
    // localStorage; the run-end screen clears the save (no resuming
    // a finished run).
    if (phase === 'roguelite-map') this._saveRun();
    else if (phase === 'roguelite-end') this._clearSavedRun();
    if (UI.applyTronFx) UI.applyTronFx();
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
      return `
        <g class="rl-mapnode rl-mapnode-${n.type} ${stateCls}" ${click}>
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
        <div class="rl-hud-pill rl-hud-gold" title="Gold ${run.gold}">
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
        <button type="button" class="rl-hud-pill rl-hud-btn tron-fx tron-fx-breathe" onclick="Roguelite.openRelicViewer()" title="View relics">
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
          <div class="rl-relic-card-rarity">${r.rarity.toUpperCase()}</div>
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
      'spider-web':       '✱',
      'vampire-fang':     '◢',
      'iron-maiden':      '☗',
      'phoenix-feather':  '☼',
      'gamblers-glove':   '◇',
      'mirror-shard':     '◢◣',
      'speed-force':      '⟪',
      'reality-stone':    '◎',
      'thanos-gauntlet':  '✊︎',  // ✊
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
    return `
      <div class="rl-panel rl-rewards-panel">
        <h1 class="rl-title">Victory</h1>
        <p class="rl-subtitle">Pick one card to add to your deck</p>
        <div class="rl-rewards-grid">
          ${run.pendingRewards.map((deckCard, i) => `
            <button type="button" class="rl-reward-slot rl-tier-${deckCard.rarity}" onclick="Roguelite.pickReward(${i})">
              <div class="rl-reward-rarity">${deckCard.rarity.toUpperCase()}</div>
              ${this._renderCodexCard(deckCard)}
            </button>
          `).join('')}
        </div>
        <div class="rl-rewards-skip">
          <button type="button" class="rl-skip-btn" onclick="Roguelite.pickReward(null)">Skip (no card)</button>
        </div>
      </div>`;
  },

  // Render a deck card using the EXACT same chrome as the codex /
  // encyclopedia (.card.hand-card.cost-N + cost diamond top-left, ATK
  // orb bottom-left, HP orb bottom-right, abilities, description). The
  // rarity color decorates via the .rl-tier-<r> wrapper class — green
  // for common, cyan for rare, silver for special, gold for legendary.
  // Etches stack into the abilities row so they read inline.
  _renderCodexCard(deckCard) {
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
    const variantDescs = this.RARITY_DESCS[def.name];
    const variantDesc = variantDescs && variantDescs[deckCard.rarity];
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
    const won = run.hp > 0 && run.currentNode >= run.totalNodes;
    return `
      <div class="rl-panel rl-end-panel">
        <h1 class="rl-title rl-end-title ${won ? 'rl-end-victory' : 'rl-end-defeat'}">${won ? 'RUN COMPLETE' : 'YOU FELL'}</h1>
        <div class="rl-end-stats">
          <div><b>Final HP</b> ${run.hp}/${run.maxHp}</div>
          <div><b>Gold</b> ${run.gold}</div>
          <div><b>Deck size</b> ${run.deck.length}</div>
          <div><b>Nodes cleared</b> ${run.currentNode}/${run.totalNodes}</div>
        </div>
        <div class="rl-end-deck">
          ${run.deck.map(d => `<span class="rl-deck-card rl-rarity-${d.rarity}">${d.defName}</span>`).join('')}
        </div>
        <div class="rl-end-actions">
          <button type="button" class="btn btn-primary" onclick="Roguelite.enterRun()">New Run</button>
          <button type="button" class="btn btn-secondary" onclick="Roguelite.abandonRun()">Main Menu</button>
        </div>
      </div>`;
  },
};

// Globally exposed for inline onclick handlers (matches the rest of the
// codebase's pattern — Game / UI / Multiplayer all expose the same way).
if (typeof window !== 'undefined') window.Roguelite = Roguelite;
