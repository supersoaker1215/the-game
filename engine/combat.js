// @ts-check
// ============================================================
// COMBAT ENGINE — pure helpers shared by resolver + predictor.
// ============================================================
// Owns the helpers both Game.applyCombatDamage and Game.predictCombatGlobal
// call (canSwingForward, snapCard, applyArmor) plus a dual-run divergence
// checker for diagnostic mode. Loaded BEFORE game.js in index.html so Game.*
// methods can forward to it. Side effects, ability hooks, the stat credit
// chain and async prompts stay in game.js.
//
// The engine never reads from Game.state directly. Inputs in,
// pure outputs out. That's the seam.

/**
 * @typedef {Object} CardLike
 * @property {string=} name
 * @property {number=} currentHealth
 * @property {number=} attack
 * @property {number=} splashRange
 * @property {number=} armorValue
 * @property {number=} evadeCharges
 * @property {number=} invincibleTurns
 * @property {boolean=} hasDamageImmunity
 * @property {boolean=} isStunned
 * @property {boolean=} isFrozen
 * @property {boolean=} isFeared
 * @property {boolean=} isMindControlled
 * @property {boolean=} isBullseye
 * @property {string=} owner
 */

/**
 * @typedef {Object} CardSnap
 * @property {string} name
 * @property {number} currentHealth
 * @property {number} attack
 * @property {number} splashRange
 * @property {number} armorValue
 * @property {number} evadeCharges
 * @property {number} invincibleTurns
 * @property {boolean} hasDamageImmunity
 * @property {boolean} isStunned
 * @property {boolean} isFrozen
 * @property {boolean} isFeared
 * @property {boolean} isMindControlled
 * @property {boolean} isBullseye
 * @property {string} owner
 */

/**
 * @typedef {Object} ArmorResult
 * @property {boolean} absorbed True if the hit was fully absorbed by armor.
 * @property {number} remaining Damage that landed after armor reduction.
 */

/**
 * @typedef {Object} PredictedOutcome
 * @property {number} hpAfter
 * @property {number=} dmgIn
 * @property {boolean} dies
 */

/**
 * @typedef {Object} Divergence
 * @property {number} id
 * @property {string} name
 * @property {number} predHpAfter
 * @property {number} actualHp
 * @property {boolean} predDies
 * @property {boolean} actuallyDied
 */

const CombatEngine = {
  /**
   * Frozen snapshot of a card with only the fields combat math reads, so both
   * paths see the same field names. A field the resolver reads live but that
   * is missing here is what dualRunDiff surfaces.
   * @param {CardLike|null|undefined} c
   * @returns {CardSnap|null}
   */
  snapCard(c) {
    return c ? {
      name: c.name,
      currentHealth: c.currentHealth | 0,
      attack: c.attack | 0,
      // Live, not stored — a splash that tracks ATK (Hulk) can drift from the
      // stored number, and the forecast must show what will land. See Game.effectiveSplash.
      splashRange: (c._splashTracksAtk ? Math.max(0, c.attack | 0) : (c.splashRange | 0)),
      _splashTracksAtk: !!c._splashTracksAtk,
      armorValue: c.armorValue | 0,
      evadeCharges: c.evadeCharges | 0,
      invincibleTurns: c.invincibleTurns | 0,
      hasDamageImmunity: !!c.hasDamageImmunity,
      isStunned: !!c.isStunned,
      isFrozen:  !!c.isFrozen,
      // Feared cards swing at their own allies; MC'd cards swing for the opponent.
      // Either way the lane produces ZERO enemy-side damage — same gate as stun/freeze.
      isFeared:  !!c.isFeared,
      isMindControlled: !!c.isMindControlled,
      isBullseye: !!c.isBullseye,
      // Pierce flags — the predictor mirrors the live evade/armor gates (Bullseye does
      // NOT pierce card Evade; only ignoresEvade does. ignoresArmor skips armor).
      ignoresEvade: !!c.ignoresEvade,
      ignoresArmor: !!c.ignoresArmor,
      owner: c.owner,
    } : null;
  },

  /**
   * A card lands its swing on the enemy front iff it isn't stunned, frozen,
   * feared, or mind-controlled (feared/MC'd swings contribute zero forecast
   * damage to the opposing lane). Shared by both predictors and the resolver.
   * @param {CardLike|null|undefined} c
   * @returns {boolean}
   */
  canSwingForward(c) {
    return !!c && !c.isStunned && !c.isFrozen && !c.isFeared && !c.isMindControlled;
  },

  /**
   * Splash is NOT a rider on the attack: a 0-ATK card with splash still splashes.
   * Hulk is an instance of the rule, not an exception — `_splashTracksAtk`
   * drives his splashRange FROM his ATK, so zeroing his ATK zeroes his splash.
   *
   * Everything that stops a swing outright (stun, freeze, fear, mind control)
   * still stops the splash; only the "ATK > 0" term is dropped.
   *
   * The health/face-down terms read the PRE-swing snapshot at every call
   * site: a splasher that dies in the exchange it started still splashes.
   * @param {CardLike|null|undefined} c
   * @returns {boolean}
   */
  canSplash(c) {
    return !!c && (c.currentHealth | 0) > 0 && !c.isFaceDown && CombatEngine.canSwingForward(c);
  },

  /**
   * Pure armor math. Side effects (logging, _creditAbsorb, emitDmg)
   * stay in the caller.
   * @param {number} raw         Raw incoming damage.
   * @param {number} armorValue  Defender's armor value.
   * @returns {ArmorResult}
   */
  applyArmor(raw, armorValue) {
    const av = armorValue | 0;
    if (av <= 0) return { absorbed: false, remaining: raw | 0 };
    if ((raw | 0) <= av) return { absorbed: true, remaining: 0 };
    return { absorbed: false, remaining: (raw | 0) - av };
  },

  /**
   * Debug helper — verifies a snap object has every field combat math
   * expects. Throws (loudly) if a field is undefined. Only called when
   * Game.DEBUG_DUAL_RUN is true; production paths skip it.
   * @param {Partial<CardSnap>|null|undefined} snap
   */
  assertSnapComplete(snap) {
    if (!snap) return;
    const required = [
      'name', 'currentHealth', 'attack', 'splashRange', 'armorValue',
      'evadeCharges', 'invincibleTurns', 'hasDamageImmunity',
      'isStunned', 'isFrozen', 'isFeared', 'isMindControlled',
      'isBullseye', 'owner',
    ];
    for (const f of required) {
      if (snap[f] === undefined) {
        throw new Error(`[CombatEngine] snap missing field: ${f}`);
      }
    }
  },

  /**
   * Compares a forecast byId map (from predictCombatGlobal, before
   * resolveCombat ran) to actual post-resolve card states. Empty
   * return = no divergence. Only called when Game.DEBUG_DUAL_RUN is true.
   * Pure read; no mutation.
   * @param {Map<number, PredictedOutcome>|Object<number, PredictedOutcome>|null} forecast
   * @param {Array<CardLike>} livePlayerLanes
   * @param {Array<CardLike>} liveAiLanes
   * @returns {Divergence[]}
   */
  dualRunDiff(forecast, livePlayerLanes, liveAiLanes) {
    const out = [];
    if (!forecast) return out;
    const allLive = [];
    for (let i = 0; i < livePlayerLanes.length; i++) {
      if (livePlayerLanes[i]) allLive.push(livePlayerLanes[i]);
      if (liveAiLanes[i])     allLive.push(liveAiLanes[i]);
    }
    for (const card of allLive) {
      const pred = forecast.get ? forecast.get(card.id) : forecast[card.id];
      if (!pred) continue;
      const actualHp  = card.currentHealth | 0;
      const predHp    = pred.hpAfter | 0;
      const actualDie = actualHp <= 0;
      const predDie   = !!pred.dies;
      if (actualHp !== predHp || actualDie !== predDie) {
        out.push({
          id: card.id,
          name: card.name,
          predHpAfter: predHp,
          actualHp:    actualHp,
          predDies:    predDie,
          actuallyDied: actualDie,
        });
      }
    }
    return out;
  },
};

// Expose globally — matches the codebase's top-level-global namespace style.
if (typeof globalThis !== 'undefined') globalThis.CombatEngine = CombatEngine;
else if (typeof window !== 'undefined') window.CombatEngine = CombatEngine;
