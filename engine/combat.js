// @ts-check
// ============================================================
// COMBAT ENGINE — pure helpers shared by resolver + predictor.
// ============================================================
// Phase 1 of the rules-engine extraction (see Plan agent output).
// At this stage the engine is INSTRUMENT-ONLY: it owns the small
// helpers that both Game.applyCombatDamage and Game.predictCombatGlobal
// call (canSwingForward, snapCard, applyArmor) and provides a
// dual-run divergence checker for diagnostic mode.
//
// Loaded BEFORE game.js in index.html so Game.* methods can forward
// to it. No build step — plain global namespace, ES2017+.
//
// What lives here:
//   - snapCard(card)        — frozen-shape snapshot used by predictors
//   - canSwingForward(card) — swing gate (stunned/frozen/feared/MC)
//   - applyArmor(raw, av)   — pure armor reduction math
//   - assertSnapComplete    — debug-only: throws on missing fields
//   - dualRunDiff(a, b)     — debug-only: compares two predicted maps
//
// What stays in game.js (for now):
//   - applyCombatDamage / dealDamage / damagePlayer side effects
//   - All onPlay / onKill / onDeath / onDamaged ability hooks
//   - Stat credit chain (_creditChain, _creditAbsorb)
//   - Async prompts (mind-control target picks, fear retargets)
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
   * Frozen snapshot of a card with only the fields combat math reads.
   * Mirrors what predictCombatGlobal needs; ensures both paths see the
   * exact same field names. If a future field gets read live by the
   * resolver but isn't in here, dualRunDiff will surface the gap.
   * @param {CardLike|null|undefined} c
   * @returns {CardSnap|null}
   */
  snapCard(c) {
    return c ? {
      name: c.name,
      currentHealth: c.currentHealth | 0,
      attack: c.attack | 0,
      splashRange: c.splashRange | 0,
      armorValue: c.armorValue | 0,
      evadeCharges: c.evadeCharges | 0,
      invincibleTurns: c.invincibleTurns | 0,
      hasDamageImmunity: !!c.hasDamageImmunity,
      isStunned: !!c.isStunned,
      isFrozen:  !!c.isFrozen,
      // Feared cards swing at their own allies; MC'd cards swing for
      // the opponent. From the forecast's "what enemy/face damage
      // will this lane produce?" angle, both behaviors mean the card
      // produces ZERO damage on the enemy side — same effective gate
      // as stun/freeze.
      isFeared:  !!c.isFeared,
      isMindControlled: !!c.isMindControlled,
      isBullseye: !!c.isBullseye,
      owner: c.owner,
    } : null;
  },

  /**
   * Combat predicate shared by both predictors and (via forwarder) the
   * resolver: a card can land its swing on the enemy front iff it
   * isn't stunned, frozen, feared, or mind-controlled. Feared cards
   * swing at allies, MC'd cards swing at their own side — both
   * contribute zero forecast damage to the opposing lane.
   * @param {CardLike|null|undefined} c
   * @returns {boolean}
   */
  canSwingForward(c) {
    return !!c && !c.isStunned && !c.isFrozen && !c.isFeared && !c.isMindControlled;
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
   * return = no divergence.
   *
   * Called only when Game.DEBUG_DUAL_RUN is true. The resolver wraps
   * its own resolveCombat call to capture the forecast first, run
   * combat, then call this to log divergences. Pure read; no mutation.
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

// Expose globally — matches the rest of the codebase's namespace style
// (Roguelite, Game, UI, AI, Multiplayer all live as top-level globals).
if (typeof globalThis !== 'undefined') globalThis.CombatEngine = CombatEngine;
else if (typeof window !== 'undefined') window.CombatEngine = CombatEngine;
