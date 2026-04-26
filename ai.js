// ============================================================
// AI OPPONENT — smarter lane selection, taunt awareness, strategy
// ============================================================

const AI = {
  // Tunable weights — the CEM tuner (sim/tune.js) perturbs these. Defaults
  // reproduce the hand-tuned behavior exactly. Override at runtime by mutating
  // this object before AI methods are called, or by loading a JSON file via
  // `--weights path.json` in the simulator.
  WEIGHTS: {
    // Draft curve
    draftBucketDeficitMult: 3,
    draftBucketOverPenalty: 4,
    draftEarlyFloorBase: 4,
    draftEarlyFloorRamp: 2,
    draftLowBias: 1.5,
    draftHighOverPenalty: 3,
    draftStatMult: 1.2,
    // Threat scoring (enemy card danger).
    // Priority order per design:
    //   1. raw attack — damage dominates (added directly as base)
    //   2. bullseye — bypasses block meter, every hit lands on HP
    //   3. splash — area pressure
    //   4. everything else (overdrive / invincible / etc.)
    // Tuned so bullseye > splash at equal attack, but a clearly higher
    // attack card still beats a lower-attack card with bullseye: a plain
    // 6 ATK (threat 6) beats a 4 ATK + Bullseye (threat 4+2 = 6 — tie,
    // at equal attack bullseye edges it). A 7 ATK plain (threat 7) clearly
    // tops any 4 ATK bullseye variant.
    threatSplashMult: 1,        // was 2 — demoted below bullseye
    threatOverdriveBonus: 1.5,
    threatBullseyeBonus: 2,     // was 1.5 — bumped above splash but not enough to beat +2 attack
    threatInvincibleBonus: 1.5,
    threatEvadeBonus: 1,
    threatArmorMult: 0.5,
    threatTauntBonus: 1.5,
    // Block / defensive play
    blockKillBonus: 6,
    blockSurviveBonus: 3,
    blockTradePenalty: -4,
    blockCostDeltaMult: 0.6,
    blockExpensiveOverKillPenalty: -4,
    defensiveThresholdNormal: 5,
    defensiveThresholdHard: 4,
    defensiveThresholdEasy: 8,
    // Trick evaluation
    trickRemovalHigh: 6,
    trickRemovalMid: 3,
    trickRemovalLowPenalty: -3,
    trickDamageKillable: 4,
    trickFreezeBigThreat: 5,
    trickBuffAlly: 3,
    trickDrawBonus: 2.5,
    trickSummonBonus: 3,
    // 1-ply lookahead — runs a simplified combat sim against each
    // candidate placement and adds the post-combat HP swing + body
    // delta as an extra score term. Infrastructure is in place
    // (_snapshotLanes / _simulateCombat / _evaluateBoard below) but
    // lookaheadMult defaults to 0 because a clean 1200-game A/B test
    // showed no win-rate advantage (49.0% ±2.8%) — the existing
    // heuristic already picks the same lane ~95% of the time, and the
    // simplified combat sim (skipping onPlay, tricks, chain/mind-
    // control/taunt-redirect) isn't accurate enough to reliably fix
    // the remaining 5%. Re-enable by raising lookaheadMult (the CEM
    // tuner in sim/tune.js can tune it alongside the other weights)
    // after the sim is extended with onPlay / trick / chain effects.
    lookaheadMult: 0,
    lookaheadHpWeight: 3,
  },

  // ===================== DRAFT =====================
  // Target distribution across 5 card picks — build a playable curve.
  // Low (cost 1-3) fills rounds 1-3, Mid (4-6) fills rounds 3-5, High (7-10) is
  // the late-game finisher. One finisher is plenty; doubling up on cost-9+
  // cards usually means a dead hand in the early rounds.
  DRAFT_TARGET: { low: 2, mid: 2, high: 1 },

  draftBucket(cost) {
    if (cost <= 3) return 'low';
    if (cost <= 6) return 'mid';
    return 'high';
  },

  draftCountBuckets(cards) {
    const b = { low: 0, mid: 0, high: 0 };
    cards.forEach(c => { b[this.draftBucket(c.cost || 0)]++; });
    return b;
  },

  // Keyword weights — more valuable keywords score higher. Tunable.
  DRAFT_KEYWORD_VALUE: {
    Immunity: 2.5, Invincible: 2.5, Evade: 1.5, Unresistible: 1.5,
    Taunt: 1.2, Splash: 2.0, Armor: 1.2, Overdrive: 1.5,
    Bullseye: 1.2, Hunt: 1.0, Damage: 2.0, Untrickable: 1.0
  },

  // Raw quality score — stats-per-cost plus keyword value plus onPlay bonus.
  draftCardQuality(card) {
    const cost = Math.max(1, card.cost || 1);
    const stats = (card.attack || 0) + (card.health || 0);
    // Vanilla stat-efficiency: good vanilla at cost 1 is ~3 stats (2/1); at
    // cost 5 ~8 stats. Subtract the cost so overpriced vanillas score lower.
    let score = stats * this.WEIGHTS.draftStatMult - cost;
    (card.abilities || []).forEach(ab => {
      const parts = ab.split(' ');
      const key = parts[0];
      const n = parseInt(parts[parts.length - 1]);
      const v = this.DRAFT_KEYWORD_VALUE[key] || 0;
      score += v * (isNaN(n) ? 1 : n);
    });
    // onPlay / onDeath / etc. (any registered ability callbacks) add utility.
    if (typeof CARD_ABILITIES !== 'undefined' && CARD_ABILITIES[card.name]) score += 3;
    return score;
  },

  // Choose the better card from a draft pair, factoring in curve fit.
  pickDraftCard(choices, drafted) {
    if (!choices || !choices.length) return null;
    if (choices.length === 1) return choices[0];
    const buckets = this.draftCountBuckets(drafted || []);
    const scored = choices.map(card => {
      let score = this.draftCardQuality(card);
      const b = this.draftBucket(card.cost || 0);
      const target = this.DRAFT_TARGET[b];
      const already = buckets[b];
      const deficit = target - already; // +N need, -N overfull
      score += deficit * this.WEIGHTS.draftBucketDeficitMult;
      if (already >= 3) score -= this.WEIGHTS.draftBucketOverPenalty;
      // Round-1 floor — if we have no cost-1/2 cards yet, strongly reward cheap
      // picks. The penalty ramps with picks remaining so it kicks hardest on the
      // final picks where passing on low means a guaranteed dead round 1.
      const hasEarly = (drafted || []).some(c => (c.cost || 0) <= 2);
      if (!hasEarly && (card.cost || 0) <= 2) {
        const remainingPicks = 5 - (drafted || []).length;
        // +5 if 4 picks remain, scaling up to +12 at last pick.
        score += this.WEIGHTS.draftEarlyFloorBase + (5 - remainingPicks) * this.WEIGHTS.draftEarlyFloorRamp;
      }
      // Extra bias toward filling round-1 even once we have one cheap card,
      // if quality of the cheap option is comparable.
      if ((card.cost || 0) === 1 && buckets.low < 2) score += this.WEIGHTS.draftLowBias;
      // Don't draft a 3rd high-cost unless it's outrageously better.
      if (b === 'high' && buckets.high >= 2) score -= this.WEIGHTS.draftHighOverPenalty;
      return { card, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].card;
  },

  // Simple trick drafting — cheaper tricks are more flexible; prefer variety
  // and effects that name "destroy" / "draw" / "damage".
  pickDraftTrick(choices, drafted) {
    if (!choices || !choices.length) return null;
    if (choices.length === 1) return choices[0];
    const alreadyNames = (drafted || []).map(d => d.name);
    const scored = choices.map(t => {
      let score = 8 - (t.cost || 0); // cheaper = more playable
      const desc = (t.desc || '').toLowerCase();
      if (/destroy/.test(desc)) score += 3;
      if (/draw/.test(desc)) score += 2;
      if (/damage/.test(desc)) score += 1.5;
      if (/heal/.test(desc)) score += 1;
      if (/freeze|stun|fear|mind control/.test(desc)) score += 2;
      if (alreadyNames.includes(t.name)) score -= 10; // avoid duplicates
      return { card: t, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].card;
  },

  // ===================== EVALUATION HELPERS =====================

  // Strategic threat bonus — cards whose VALUE isn't captured by combat
  // stats alone. Energy generators (Dr. Octopus, Green Lantern) give the
  // opponent a currency advantage every turn they're alive, which
  // compounds — one more energy next round usually means one more body
  // on board, one more trick, a cheaper finisher. Killing them early
  // saves every future energy point. These bonuses are added on top of
  // normal stat-based threat so the AI prioritizes removal, blocks, and
  // trick targeting toward them.
  //   Dr. Octopus  — passive aura "+1 energy / round while alive",
  //                  scales with remaining game length. Conservative +5.
  //   Green Lantern — converts damage dealt → energy next turn. Bonus
  //                  scales with its own attack (more attack = more
  //                  damage = more energy). Base +3, plus 1× attack.
  STRATEGIC_THREAT: {
    'Dr. Octopus': (card) => 5,
    'Green Lantern': (card) => 3 + (card.attack || 0),
  },

  // Threat score — how much damage/disruption an enemy card brings. Includes
  // splash, overdrive, hunt, and keywords that make them hard to remove.
  threatScore(card) {
    if (!card || card.currentHealth <= 0) return 0;
    const attackEff = card.isStunned || card.isFrozen ? 0 : (card.attack || 0);
    const W = this.WEIGHTS;
    let s = attackEff + (card.splashRange || 0) * W.threatSplashMult;
    if (card.isOverdrive) s += W.threatOverdriveBonus;
    if (card.hasHunt) s += 1;
    if (card.isBullseye) s += W.threatBullseyeBonus;
    if (card.invincibleTurns > 0) s += W.threatInvincibleBonus;
    if (card.evadeCharges > 0) s += W.threatEvadeBonus;
    if (card.armorValue > 0) s += card.armorValue * W.threatArmorMult;
    if (card.immunityCharges > 0) s += 1;
    if (card.unresistibleCharges > 0) s += 1;
    if (card.tauntTurns > 0) s += W.threatTauntBonus;
    // Stunned / frozen / feared / mind-controlled enemies can't generate
    // energy this turn — their aura is contained. Don't double-count the
    // strategic bonus while they're neutralized.
    const strategic = this.STRATEGIC_THREAT[card.name];
    if (strategic && !card.isStunned && !card.isFrozen && !card.isFeared && !card.isMindControlled) {
      s += strategic(card);
    }
    return s;
  },

  // Unblocked damage the opponent will do to `owner`'s health next combat.
  // Parameterized on owner so the same function powers both seats in sim.
  unblockedIncoming(owner = 'ai') {
    const s = Game.state;
    const opp = Game.opponent(owner);
    let total = 0;
    for (let i = 0; i < Game.LANE_COUNT; i++) {
      const e = s.lanes[i][opp];
      const me = s.lanes[i][owner];
      if (e && !me && (e.attack || 0) > 0 && !e.isStunned && !e.isFrozen && e.currentHealth > 0) {
        total += (e.attack || 0) + (e.splashRange || 0);
      }
    }
    return total;
  },

  // Would `myCard` survive at least 1 combat swing from `enemy`?
  wouldSurvive(myCard, enemy) {
    if (!enemy) return true;
    if (myCard.invincibleTurns > 0 || myCard.hasDamageImmunity) return true;
    if (myCard.evadeCharges > 0) return true;
    const incoming = Math.max(0, (enemy.attack || 0) - (myCard.armorValue || 0));
    return myCard.currentHealth > incoming;
  },

  // Would `myCard` kill `enemy` on the first swing?
  wouldKill(myCard, enemy) {
    if (!enemy) return false;
    if (enemy.invincibleTurns > 0 || enemy.hasDamageImmunity) return false;
    if (enemy.evadeCharges > 0 && !myCard.isBullseye) return false;
    const dmg = Math.max(0, (myCard.attack || 0) - (enemy.armorValue || 0));
    return dmg >= enemy.currentHealth;
  },

  // ===================== PLAY CARDS =====================

  // Score how well `card` would handle blocking `enemy` (placed in enemy's lane).
  // Higher = better trade.
  blockFitScore(card, enemy) {
    if (!enemy || enemy.currentHealth <= 0) return -999;
    const W = this.WEIGHTS;
    let s = this.threatScore(enemy) * 1.5;
    if (this.wouldKill(card, enemy)) s += W.blockKillBonus;
    if (this.wouldSurvive(card, enemy)) s += W.blockSurviveBonus;
    // Prefer "we survive AND kill" > "we survive" > "we trade 1-for-1" > "we die uselessly"
    if (!this.wouldSurvive(card, enemy) && !this.wouldKill(card, enemy)) s += W.blockTradePenalty;
    // Prefer a body on the cheaper side — don't waste a 9-cost blocker on a 2/2
    s += Math.max(0, (enemy.cost || 0) - (card.cost || 0)) * W.blockCostDeltaMult;
    if ((card.cost || 0) >= 7 && this.threatScore(enemy) <= 2) s += W.blockExpensiveOverKillPenalty;
    return s;
  },

  // Assign our best available card to each unblocked enemy lane, greedily
  // starting from the biggest threat. Returns [{cardId, lane}] commitments.
  // Owner-parameterized so both sim seats use this same function.
  planDefensiveBlocks(hand, budget, owner = 'ai') {
    const s = Game.state;
    const opp = Game.opponent(owner);
    const assignments = [];
    const used = new Set();
    let remainingCurrency = budget;
    const unblocked = [];
    for (let i = 0; i < Game.LANE_COUNT; i++) {
      const lane = s.lanes[i];
      if (lane.destroyed || lane[owner]) continue;
      const e = lane[opp];
      if (e && e.currentHealth > 0 && (e.attack || 0) > 0) {
        unblocked.push({ lane: i, threat: this.threatScore(e) });
      }
    }
    unblocked.sort((a, b) => b.threat - a.threat);

    for (const { lane: li } of unblocked) {
      const enemy = s.lanes[li][opp];
      let best = null, bestScore = -Infinity;
      for (const c of hand) {
        if (used.has(c.id)) continue;
        if (c.isDiscardEffect) continue;
        const cost = Game.getCardCost(owner, c);
        if (cost > remainingCurrency) continue;
        const score = this.blockFitScore(c, enemy);
        if (score > bestScore && score >= 1) { best = c; bestScore = score; }
      }
      if (best) {
        assignments.push({ cardId: best.id, lane: li });
        used.add(best.id);
        remainingCurrency -= Game.getCardCost(owner, best);
      }
    }
    return assignments;
  },

  // Difficulty — read from UI.settings and skew how greedy/strategic the AI is.
  difficulty() {
    return (typeof UI !== 'undefined' && UI.settings && UI.settings.difficulty) || 'normal';
  },

  // Owner-parameterized. Same code drives both sim seats, so whatever
  // improvements ship here automatically apply to 'player' AND 'ai'.
  // Delay between each AI card play so the player can follow what
  // happened. Reduced slightly (was 350/700/1100) per user feedback
  // that the pause felt a touch too long.
  //   aiPacing === 'instant'  → 0ms (fire everything at once)
  //   aiPacing === 'animated' → scaled by aiSpeed setting.
  // Pre-play delay — how long the "thinking" dots show BEFORE a card
  // lands. Exists so the AI doesn't appear to play instantly; gives
  // the player a moment to anticipate before the card materializes.
  aiStepMs() {
    const mode = (typeof UI !== 'undefined' && UI.settings && UI.settings.aiPacing) || 'animated';
    if (mode === 'instant') return 0;
    const spd = (typeof UI !== 'undefined' && UI.settings && UI.settings.aiSpeed) || 'normal';
    // Tuned so that pre-play + post-play >= 700ms (the user-spec
    // minimum gap between consecutive AI placements). Normal puts most
    // of the spacing AFTER the card lands so the shockwave + ripple
    // can fully resolve before the next play starts.
    return { fast: 200, normal: 350, slow: 500 }[spd] || 350;
  },

  // Post-play hold — pause AFTER a card lands so the radial ripple +
  // lane shockwave + HP pulse have time to play out before the AI
  // commits the next action. User spec: "After each card lands,
  // hold for ~500ms before the next play begins." Total gap (pre +
  // post) is ~850ms at normal — comfortably above the 700ms floor.
  aiPostPlayMs() {
    const mode = (typeof UI !== 'undefined' && UI.settings && UI.settings.aiPacing) || 'animated';
    if (mode === 'instant') return 0;
    const spd = (typeof UI !== 'undefined' && UI.settings && UI.settings.aiSpeed) || 'normal';
    return { fast: 350, normal: 500, slow: 700 }[spd] || 500;
  },

  // End-of-turn pause — gives the player a beat to read the final
  // board state before control hands back. Reduced 800 → 300 per
  // user feedback: "the time it takes for the enemy to end their
  // turn needs to be reduced by half a second." The post-play hold
  // (aiPostPlayMs) already gives ~500ms after the LAST card lands
  // so the final state is readable; the additional end-of-turn
  // pause was redundant feel-padding.
  aiEndOfTurnMs() {
    const mode = (typeof UI !== 'undefined' && UI.settings && UI.settings.aiPacing) || 'animated';
    if (mode === 'instant') return 0;
    return 300;
  },

  // Queue a list of AI actions. Cadence per step:
  //   1. Show thinking dots (aiStepMs ms) — anticipation
  //   2. Execute the action (card lands, animations fire)
  //   3. Hold (aiPostPlayMs ms) — shockwave / ripple settle
  //   4. Recurse to next action
  // After the queue drains, pause an additional aiEndOfTurnMs ms
  // before invoking onComplete so the final board state has time
  // to read.
  _runAIQueue(actions, onComplete) {
    const preDelay  = this.aiStepMs();
    const postDelay = this.aiPostPlayMs();
    let i = 0;
    const step = () => {
      if (i >= actions.length) {
        document.body && document.body.classList.remove('ai-thinking');
        // End-of-turn pause: hold the final board for a beat before
        // handing control back. Honors the same 'instant' override
        // (aiEndOfTurnMs returns 0 in instant mode).
        const eot = this.aiEndOfTurnMs();
        if (eot > 0 && onComplete) {
          setTimeout(() => onComplete(), eot);
        } else if (onComplete) {
          onComplete();
        }
        return;
      }
      // Hold the queue while the PLAYER has any pending prompt open
      // (e.g. a Start-of-Tricks move modal fired by a player-side
      // card's onBeforeTricks). Without this gate, the AI's next
      // trick fires before the player can respond, which produced
      // cases where Batarang killed a card mid-move-prompt and the
      // player's modal referenced a dead target.
      if (typeof Game !== 'undefined' && Game.hasPendingPrompt && Game.hasPendingPrompt()) {
        document.body && document.body.classList.add('ai-thinking');
        Game.whenPromptCleared(() => {
          document.body && document.body.classList.remove('ai-thinking');
          step();
        });
        return;
      }
      // Phase A: thinking dots → execute. Phase B: post-play hold →
      // recurse. Composed via nested setTimeout so each phase honors
      // the 'instant' override (delay 0 = synchronous fall-through).
      const runAction = () => {
        document.body && document.body.classList.remove('ai-thinking');
        const fn = actions[i++];
        try { fn(); } catch (e) { console.error(e); }
        if (typeof UI !== 'undefined' && UI.render) UI.render();
        // Phase B — post-play hold for animations to settle.
        if (postDelay > 0) {
          setTimeout(step, postDelay);
        } else {
          step();
        }
      };
      // Phase A — anticipation. Skip the dots in instant mode.
      if (preDelay > 0) {
        document.body && document.body.classList.add('ai-thinking');
        setTimeout(runAction, preDelay);
      } else {
        runAction();
      }
    };
    step();
  },

  playCards(owner = 'ai', onComplete) {
    const s = Game.state;
    const opp = Game.opponent(owner);
    // BWL intercept: if the opponent has a live Batman Who Laughs and our
    // nextCardStolen is set, our NEXT card play gets snatched. Feed the
    // cheapest affordable card first as a sacrifice.
    if (s[owner].nextCardStolen) {
      const candidates = s[owner].hand.filter(c => {
        const cost = Game.getCardCost(owner, c);
        if (cost > s[owner].currency) return false;
        if (c.isDiscardEffect) return true;
        return Game.getOpenLanes(owner).length > 0;
      });
      if (candidates.length) {
        candidates.sort((a, b) => {
          const ac = a.baseCost || a.cost || 0;
          const bc = b.baseCost || b.cost || 0;
          if (ac !== bc) return ac - bc;
          const aDisc = a.isDiscardEffect ? 1 : 0;
          const bDisc = b.isDiscardEffect ? 1 : 0;
          return aDisc - bDisc;
        });
        const bait = candidates[0];
        if (bait.isDiscardEffect) {
          Game.playCard(owner, bait, 0);
        } else {
          const openLanes = Game.getOpenLanes(owner);
          if (openLanes.length) Game.playCard(owner, bait, openLanes[0]);
        }
      }
    }
    const hp = { me: s[owner].health, opp: s[opp].health };
    const behind = hp.me < hp.opp - 5;
    const farBehind = hp.me < hp.opp - 10;
    const incoming = this.unblockedIncoming(owner);
    const diff = this.difficulty();
    const defensiveThreshold = diff === 'easy' ? this.WEIGHTS.defensiveThresholdEasy : diff === 'hard' ? this.WEIGHTS.defensiveThresholdHard : this.WEIGHTS.defensiveThresholdNormal;
    const defensive = incoming >= defensiveThreshold || farBehind;

    // Plans get collected first, then executed one at a time through
    // _runAIQueue so the player can read each play before the next one
    // fires. Each entry re-checks affordability / open lanes at fire
    // time so the queue survives mid-turn board changes.
    const queue = [];

    // Step 1: commit our best blockers to the biggest threats first.
    const committedIds = new Set();
    if (diff !== 'easy') {
      const blockPlan = this.planDefensiveBlocks([...s[owner].hand], s[owner].currency, owner);
      blockPlan.forEach(p => committedIds.add(p.cardId));
      for (const plan of blockPlan) {
        queue.push(() => {
          const card = s[owner].hand.find(c => c.id === plan.cardId);
          if (!card) return;
          const cost = Game.getCardCost(owner, card);
          if (cost > s[owner].currency) return;
          Game.playCard(owner, card, plan.lane);
        });
      }
    }

    // Step 2: play remaining cards using the priority heuristic.
    const remaining = [...s[owner].hand].filter(c => {
      if (committedIds.has(c.id)) return false;
      if (c.trickPhasePlayable && !behind) return false;
      return true;
    });
    remaining.sort((a, b) => {
      const aHasOnPlay = a.onPlay ? 1 : 0;
      const bHasOnPlay = b.onPlay ? 1 : 0;
      if (defensive) {
        if (aHasOnPlay !== bHasOnPlay) return bHasOnPlay - aHasOnPlay;
        return (a.cost || 0) - (b.cost || 0);
      }
      if (behind) {
        if (aHasOnPlay !== bHasOnPlay) return bHasOnPlay - aHasOnPlay;
        return (b.cost || 0) - (a.cost || 0);
      }
      return (a.cost || 0) - (b.cost || 0);
    });

    for (const cardRef of remaining) {
      queue.push(() => {
        // Recheck the card is still in hand (another play in this turn
        // may have triggered a Batman intercept etc.) and re-evaluate
        // affordability + lane since the board moves between plays.
        const card = s[owner].hand.find(c => c.id === cardRef.id);
        if (!card) return;
        if (s[owner].currency <= 0) return;
        const cost = Game.getCardCost(owner, card);
        if (cost > s[owner].currency) return;
        if (card.isDiscardEffect) { Game.playCard(owner, card, 0); return; }
        const lane = this.chooseLane(card, owner);
        if (lane < 0) return;
        const targetLane = s.lanes[lane];
        const uncontestedHere = !targetLane[opp];
        if (uncontestedHere && this.opponentHasTaunter(owner) && (card.splashRange || 0) <= 0 && !card.isBullseye) {
          if ((card.cost || 0) >= 6 && s[owner].currency < (card.cost || 0) + 2) return;
        }
        Game.playCard(owner, card, lane);
      });
    }

    this._runAIQueue(queue, onComplete);
  },

  // ===================== LANE SELECTION =====================

  // True if `owner`'s opponent has a taunter on the board.
  // Kept under the old name as an alias since some external call sites may
  // still use `playerHasTaunter()`; new code should prefer `opponentHasTaunter`.
  opponentHasTaunter(owner = 'ai') {
    const opp = Game.opponent(owner);
    for (let i = 0; i < Game.LANE_COUNT; i++) {
      const c = Game.state.lanes[i][opp];
      if (c && c.tauntTurns > 0 && c.currentHealth > 0) return true;
    }
    return false;
  },
  playerHasTaunter() { return this.opponentHasTaunter('ai'); },

  // ===================== 1-PLY LOOKAHEAD =====================
  // Lightweight board snapshot — just the numeric combat state for each
  // lane. Intentionally drops callbacks, IDs, and anything the simplified
  // combat sim doesn't read, so it's cheap to build and doesn't have to
  // worry about deep-clone pitfalls (circular refs, functions, etc.).
  _snapshotLanes() {
    const out = [];
    for (let i = 0; i < Game.LANE_COUNT; i++) {
      const lane = Game.state.lanes[i];
      out.push({
        destroyed: !!lane.destroyed,
        ai: lane.ai ? this._snapshotCard(lane.ai) : null,
        player: lane.player ? this._snapshotCard(lane.player) : null,
      });
    }
    return out;
  },
  _snapshotCard(c) {
    return {
      atk: c.attack || 0,
      hp: c.currentHealth || 0,
      armor: c.armorValue || 0,
      evade: c.evadeCharges || 0,
      invincible: c.invincibleTurns || 0,
      splash: c.splashRange || 0,
      bullseye: !!c.isBullseye,
      overdrive: !!c.isOverdrive,
      dmgImmune: !!c.hasDamageImmunity,
      stunned: !!c.isStunned || !!c.isFrozen,
      cost: c.cost || c.baseCost || 0,
    };
  },
  // Attempt damage from attacker snapshot → defender snapshot. Returns
  // true if the defender was killed (hp <= 0 post-hit), false otherwise.
  // Mutates defender.hp and defender.evade. Skips chain/mind-control/taunt
  // redirects and doesn't fire onKill callbacks — this is a *prediction*
  // sim, not a perfect re-implementation.
  _strike(atkC, defC) {
    if (!atkC || atkC.hp <= 0 || atkC.stunned || atkC.atk <= 0 || !defC || defC.hp <= 0) return false;
    if (defC.evade > 0 && !atkC.bullseye) { defC.evade--; return false; }
    if (defC.invincible > 0 || defC.dmgImmune) return false;
    const dmg = Math.max(0, atkC.atk - defC.armor);
    defC.hp -= dmg;
    return defC.hp <= 0;
  },
  // Splash: an attacker with splashRange deals reduced damage to cards
  // in adjacent lanes (same side as the defender that just got hit).
  // Real game fires the splash after the main swing regardless of whether
  // the main swing connected; this mirrors that.
  _applySplash(board, attackerLaneIdx, attackerCard, defenderSide) {
    if (!attackerCard.splash) return;
    const sides = [attackerLaneIdx - 1, attackerLaneIdx + 1];
    for (const li of sides) {
      if (li < 0 || li >= board.length) continue;
      const lane = board[li];
      if (!lane || lane.destroyed) continue;
      const target = lane[defenderSide];
      if (!target || target.hp <= 0) continue;
      if (target.invincible > 0 || target.dmgImmune) continue;
      const dmg = Math.max(0, attackerCard.splash - target.armor);
      target.hp -= dmg;
    }
  },
  // Run a simplified one-round combat. Mutates the snapshot (cards' hp
  // drops, evade charges deplete). Returns cumulative HP damage dealt to
  // each side. Models: attack / armor / evade / invincible / damage-
  // immunity / splash / overdrive (re-attack on kill). Skips: chain
  // damage, mind-control redirects, taunt redirects, onPlay/onDeath
  // callbacks. Good enough for placement-decision signal.
  _simulateCombat(board) {
    let aiHpDmg = 0, playerHpDmg = 0;

    const swing = (attackerSide) => {
      const defenderSide = attackerSide === 'ai' ? 'player' : 'ai';
      for (let i = 0; i < board.length; i++) {
        const lane = board[i];
        if (lane.destroyed) continue;
        const atk = lane[attackerSide];
        if (!atk || atk.hp <= 0 || atk.stunned || atk.atk <= 0) continue;
        const def = lane[defenderSide];
        if (!def) {
          // Uncontested → HP damage. Splash on uncontested is unusual; the
          // real game adds splash to the HP hit too.
          const hpHit = atk.atk + atk.splash;
          if (attackerSide === 'ai') playerHpDmg += hpHit; else aiHpDmg += hpHit;
          continue;
        }
        const killed = this._strike(atk, def);
        this._applySplash(board, i, atk, defenderSide);
        // Overdrive — if the defender died from the main swing, swing
        // again against whatever's behind (in this simplified model we
        // just re-attack the same lane in case splash dropped another
        // adjacent into range, then stop; full implementation would
        // target another lane, but adjacency-first is a decent proxy).
        if (killed && atk.overdrive) {
          const next = lane[defenderSide];
          if (next && next.hp > 0) this._strike(atk, next);
        }
      }
    };
    // Both sides attack simultaneously (real game alternates per lane,
    // but for a placement heuristic, simultaneous is close enough).
    swing('ai');
    swing('player');
    return { aiHpDmg, playerHpDmg };
  },
  // Score the post-combat board from `owner`'s perspective. HP damage
  // dealt to the opponent is positive, HP damage to self is negative.
  _evaluateBoard(board, damages, owner = 'ai') {
    const W = this.WEIGHTS;
    const opp = owner === 'ai' ? 'player' : 'ai';
    // Damages are stored keyed on side (aiHpDmg = damage to AI's HP bar).
    const hpDoneToOpp = damages[opp + 'HpDmg'] || 0;
    const hpTaken = damages[owner + 'HpDmg'] || 0;
    let score = hpDoneToOpp * W.lookaheadHpWeight - hpTaken * W.lookaheadHpWeight;
    for (const lane of board) {
      if (lane[owner] && lane[owner].hp > 0) score += lane[owner].atk + lane[owner].hp * 0.5;
      if (lane[opp] && lane[opp].hp > 0) score -= lane[opp].atk + lane[opp].hp * 0.5;
    }
    return score;
  },
  // Run a 1-ply sim of placing `card` in `lane`. Returns the post-combat
  // evaluation score; higher = better outcome for `owner`.
  _lookaheadScore(card, laneIdx, owner = 'ai') {
    const board = this._snapshotLanes();
    if (!board[laneIdx] || board[laneIdx][owner]) return 0;
    board[laneIdx][owner] = this._snapshotCard(card);
    const damages = this._simulateCombat(board);
    return this._evaluateBoard(board, damages, owner);
  },

  // Score each candidate lane for placing `card`. Higher is better.
  // Factors:
  //   +++ killing a high-threat enemy we'd otherwise eat splash/overdrive from
  //   ++  blocking a big unblocked attacker (prevents health-bar damage)
  //   +   surviving the trade (keeps our body on board)
  //   -   placing a fragile high-cost card where it'll die for nothing
  //   +   empty-lane uncontested damage, weighted by adjacency / taunter
  //   +   lookahead bonus — weighted post-combat board-state swing (skipped on easy)
  chooseLane(card, owner = 'ai') {
    const s = Game.state;
    const opp = Game.opponent(owner);
    const open = Game.getOpenLanes(owner);
    if (!open.length) return -1;
    const hasTaunter = this.opponentHasTaunter(owner);
    const useLookahead = this.difficulty() !== 'easy' && this.WEIGHTS.lookaheadMult > 0;

    const scores = open.map(l => {
      const lane = s.lanes[l];
      const enemy = lane[opp];
      let score = 0;

      // Some enemies vacate their lane before combat (Man-Bat's recurring
      // onBeforeTricks move-and-debuff). Contesting those lanes provides
      // zero blocking value — the enemy leaves, my card is uncontested,
      // and the opponent uses the move to target MY open lanes instead.
      // Treat these as uncontested for scoring purposes.
      const enemyWillLeave = enemy && enemy._recurringBT && enemy.name === 'Man-Bat';
      if (enemy && enemy.currentHealth > 0 && !enemyWillLeave) {
        // Contested placement — we're blocking
        const threat = this.threatScore(enemy);
        // An enemy is "unkillable this turn" when it fully negates damage —
        // Invincible or DmgImmune eat any hit we land, and Evade charges
        // consume our swing entirely (unless our card has Bullseye to bypass
        // evade charges on the attack itself — but evade on defense still
        // eats our combat hit, so evade still counts as unkillable here).
        const unkillable =
          enemy.invincibleTurns > 0 ||
          enemy.hasDamageImmunity ||
          (enemy.evadeCharges > 0 && !card.isBullseye);
        const iSurvive = this.wouldSurvive(card, enemy);
        const iKill = this.wouldKill(card, enemy);
        score += threat * 1.5;           // prioritize blocking scarier enemies
        if (iKill) score += 6;
        if (iSurvive) score += 3;
        // Trading a 1-cost card for a 6+ cost enemy is great; inverse is bad
        score += Math.max(0, (enemy.cost || 0) - (card.cost || 0)) * 0.8;
        // Avoid committing a big expensive card against a trivial enemy
        if ((card.cost || 0) >= 7 && threat <= 2) score -= 3;
        // Dying without killing = net loss
        if (!iSurvive && !iKill) score -= 2;
        // Big penalty: enemy is unkillable this turn AND my card dies = we
        // just feed them a free body. The Invincible/DmgImmune will fade
        // next turn — committing now is almost always worse than an empty
        // lane with tempo damage. (Keeps AI from feeding Peacemakers into
        // Flash's Invincible 2, Batarang into Invincible targets, etc.)
        if (unkillable && !iSurvive) score -= 8;
      } else {
        // Uncontested — uncontested damage matters, but taunter neutralizes it
        // unless we have splash or bullseye to bypass.
        if (hasTaunter && (card.splashRange || 0) <= 0 && !card.isBullseye) {
          score += 0.5; // body value only
        } else {
          score += (card.attack || 0) * 0.8 + (card.splashRange || 0) * 0.6;
        }
        // Bullseye bodies shine in OPEN lanes — they keep dealing face damage
        // every combat and can't be blocked. Committing a Bullseye card
        // against a threat wastes its recurring face-damage value on a single
        // trade. Extra bonus so the AI prefers an empty lane over a contested
        // trade when the card has Bullseye.
        if (card.isBullseye) score += 2;
        // Slight bonus for being near existing allies (adjacency/synergies)
        const alliedLanes = [];
        for (let i = 0; i < Game.LANE_COUNT; i++) {
          const a = s.lanes[i][owner];
          if (a && a.currentHealth > 0) alliedLanes.push(i);
        }
        if (alliedLanes.length) {
          const dist = Math.min(...alliedLanes.map(x => Math.abs(x - l)));
          score += Math.max(0, 1.5 - dist * 0.5);
        }
        if ((card.splashRange || 0) >= 1 && (l === 0 || l === Game.LANE_COUNT - 1)) {
          score -= 0.5;
        }
      }
      // Incoming splash hazards from ADJACENT enemy lanes. Two sources:
      //   1. Attack splash — enemy with splashRange > 0 will deal that much
      //      to my card when attacking (even through a body, since splash
      //      bypasses the lane's primary trade).
      //   2. Reactive splash — Red Hulk specifically splashes incoming
      //      damage back to adjacent allies. Placing a fragile body next
      //      to Red Hulk is dangerous because any attack on Red Hulk
      //      (likely every turn) will splash onto my card.
      // Penalty scales with how much of my card's HP the incoming damage
      // eats — a lethal splash is a hard no, a chip is a mild preference.
      // Man-Bat debuff hazard: if the opponent has a Man-Bat on the board,
      // it moves to an open lane before combat and debuffs (-1/-1) whatever
      // AI card is in that lane. If my card would DIE from -1/-1 (i.e. 1 HP
      // or 1 ATK post-debuff leaves it at 0), this lane is a potential
      // target. Small penalty — Man-Bat hits at most one lane per round and
      // the user picks which, but fragile placements are still risky.
      const oppCards = Game.getAllCardsOf(opp);
      const manBat = oppCards.find(c => c.name === 'Man-Bat' && c.currentHealth > 0 && c._recurringBT);
      let splashHazard = 0;
      if (manBat) {
        const hpAfter = (card.currentHealth || 0) - 1;
        const atkAfter = (card.attack || 0) - 1;
        if (hpAfter <= 0 || atkAfter <= 0) {
          splashHazard += 2;
        }
      }
      const adjacentLanes = [l - 1, l + 1].filter(i => i >= 0 && i < Game.LANE_COUNT);
      adjacentLanes.forEach(adj => {
        const e = s.lanes[adj][opp];
        if (!e || e.currentHealth <= 0) return;
        // Card immune to all damage — no hazard
        if (card.invincibleTurns > 0 || card.hasDamageImmunity) return;
        const myHP = card.currentHealth || 1;
        // 1. Direct attack splash
        const atkSplash = e.splashRange || 0;
        if (atkSplash > 0) {
          const effective = Math.max(0, atkSplash - (card.armorValue || 0));
          if (effective >= myHP) splashHazard += 6;       // lethal
          else if (effective > 0) splashHazard += effective * 0.8; // chip
        }
        // 2. Red Hulk reactive splash — assume ~4 damage will land on Red
        //    Hulk this combat (its likely the AI's combat step hits it).
        //    Only concerning if my card can't tank it.
        if (e.name === 'Red Hulk') {
          const likely = 4;
          const effective = Math.max(0, likely - (card.armorValue || 0));
          if (effective >= myHP) splashHazard += 5;
          else if (effective > 0) splashHazard += effective * 0.5;
        }
      });
      score -= splashHazard;
      // ---- Placement-aware onPlay bonus ----
      // Some cards' WhenPlayed effect targets ADJACENT lanes, so the
      // base score (which evaluates only the candidate lane itself)
      // misses their full value. Reward placements where the onPlay
      // can actually fire a useful effect on a neighboring enemy.
      // User feedback: AI played Black Widow front-on against Harley
      // Quinn for the trade — but a one-lane-over placement would
      // have FROZEN Harley (taking her attack offline for the round)
      // while Black Widow's Bullseye pushed face damage. The
      // adjacency bonus below catches that.
      if (card.name === 'Black Widow' || card.name === 'Mr. Freeze' || card.name === 'Bane') {
        // Black Widow: Freeze 1 an adjacent enemy.
        // Mr. Freeze: Freeze the enemy opposite — opposite, not adjacent,
        //   so the BASE contested-lane scoring already covers it. Skip.
        // Bane: -1/-1 + strip evade on a target — selectable, not lane-dependent.
        // Only Black Widow's freeze is adjacency-conditional.
        if (card.name === 'Black Widow') {
          const adjLanes = [l - 1, l + 1].filter(i => i >= 0 && i < Game.LANE_COUNT);
          let bestFreezeVal = 0;
          for (const i of adjLanes) {
            const e = s.lanes[i][opp];
            if (!e || e.currentHealth <= 0) continue;
            if (e.invincibleTurns > 0 || e.hasDamageImmunity) continue;
            // Freeze value ≈ attack we're cancelling for 1 turn + a fraction
            // of their cost (high-cost enemies are harder to neutralize so
            // freezing them is worth more). Calibrated to bump score by
            // ~3-6 for typical mid-cost threats — enough to PULL Black Widow
            // off a "would trade" lane onto a one-over "would freeze threat
            // AND push face damage" lane.
            const freezeVal = (e.attack || 0) * 0.9 + (e.cost || 0) * 0.3;
            if (freezeVal > bestFreezeVal) bestFreezeVal = freezeVal;
          }
          score += bestFreezeVal;
        }
      }
      // 1-ply lookahead bonus — simulates placement + the resulting combat
      // round, scores the post-combat board (HP swing + body delta) from
      // the AI's perspective. Catches whole-board interactions the per-lane
      // heuristic above misses (e.g. splash reaching 3 enemies, freeing two
      // other lanes to push uncontested HP damage).
      if (useLookahead) {
        score += this.WEIGHTS.lookaheadMult * this._lookaheadScore(card, l, owner);
      }
      return { lane: l, score };
    });

    scores.sort((a, b) => b.score - a.score);
    return scores[0].lane;
  },

  playTrickPhaseCards(owner = 'ai', onComplete) {
    const s = Game.state;
    const tpCards = [...s[owner].hand].filter(c => c.trickPhasePlayable);
    const queue = tpCards.map(cardRef => () => {
      const card = s[owner].hand.find(c => c.id === cardRef.id);
      if (!card) return;
      const cost = Game.getCardCost(owner, card);
      if (cost > s[owner].currency) return;
      const lane = this.chooseLane(card, owner);
      if (lane >= 0) Game.playCard(owner, card, lane);
    });
    this._runAIQueue(queue, onComplete);
  },

  // ===================== TRICKS =====================

  // Tricks that are always safe to cast (self-contained or reliably helpful).
  // NOTE: context-dependent tricks (Bifrost needs an ally to move) are NOT in
  // this set — they go through evalTrick so their triggers are checked.
  TRICK_ALWAYS_CAST: new Set([
    'Bat Signal', 'Mother Box', 'Eye of Agamotto', 'Power Battery', 'Lasso of Truth',
    'Mobius Chair', 'The Darkhold', 'Cosmic Cube', 'Infinity Gauntlet'
  ]),

  // Per-trick evaluators — keyed by trick name. Each returns a score (or
  // -1 to skip). Registered here for tricks where the generic regex
  // heuristic below gets the preconditions wrong: damage tricks with a
  // fixed amount (Batarang) need an HP-threshold check, stat-debuff tricks
  // (Kryptonite) are misfiled as removal, conditional-destroy tricks
  // (Darkhold, Anti-Life) need constraint checks, and category-orphan
  // tricks (Phantom Zone, Reality Stone, Joker's Card, Super Soldier
  // Serum) had no matching regex so they returned -1 and never cast.
  // Per-trick evaluators. Called with (this, owner) — `ai` is the AI
  // singleton, `owner` is the side ('ai' or 'player') the trick belongs to.
  // Must use `owner` (not hardcoded 'ai') so both sim seats evaluate
  // their own tricks correctly. Default keeps backwards-compat for any
  // future call site that doesn't pass owner.
  TRICK_EVALUATORS: {
    'Batarang': function (ai, owner = 'ai') {
      const enemies = Game.getEnemiesOf(owner);
      if (!enemies.length) return -1;
      const killable = enemies.filter(e => e.currentHealth <= 3 && (e.armorValue || 0) === 0);
      if (killable.length) {
        const best = killable.reduce((x, y) => ai.threatScore(y) > ai.threatScore(x) ? y : x);
        const t = ai.threatScore(best);
        return t >= 3 ? 6 : 3;
      }
      const wounded = enemies.some(e => e.currentHealth <= 5);
      return wounded ? 1.5 : 0.5;
    },

    'Kryptonite': function (ai, owner = 'ai') {
      const enemies = Game.getEnemiesOf(owner);
      if (!enemies.length) return -1;
      const supe = enemies.find(e => e.name === 'Superman');
      if (supe && supe.attack >= 5) return 7;
      const bigAtk = enemies.filter(e => (e.attack || 0) >= 5 && !e.isStunned && !e.isFrozen);
      if (bigAtk.length) return 5;
      const midAtk = enemies.some(e => (e.attack || 0) >= 3);
      return midAtk ? 2 : -1;
    },

    'The Darkhold': function (ai, owner = 'ai') {
      const enemies = Game.getEnemiesOf(owner);
      const hittable = enemies.filter(e => (e.attack || 0) <= 2 && e.currentHealth > 0);
      if (hittable.length >= 3) return 8;
      if (hittable.length === 2) return 5;
      if (hittable.length === 1 && ai.threatScore(hittable[0]) >= 3) return 3;
      return -1;
    },

    'Phantom Zone': function (ai, owner = 'ai') {
      const enemies = Game.getEnemiesOf(owner);
      if (!enemies.length) return -1;
      const big = enemies.filter(e => (e.cost || 0) >= 5 || ai.threatScore(e) >= 5);
      if (big.length) {
        const best = big.reduce((x, y) => ai.threatScore(y) > ai.threatScore(x) ? y : x);
        return ai.threatScore(best) >= 6 ? 8 : 5;
      }
      const mid = enemies.some(e => (e.cost || 0) >= 3);
      return mid ? 2 : -1;
    },

    'Reality Stone': function (ai, owner = 'ai') {
      const enemies = Game.getEnemiesOf(owner);
      const allies = Game.getAlliesOf(owner);
      if (!enemies.length || !allies.length) return -1;
      const ourWeakest = Math.min(...allies.map(a => (a.attack || 0) + a.currentHealth));
      const theirStrongest = Math.max(...enemies.map(e => (e.attack || 0) + e.currentHealth));
      const delta = theirStrongest - ourWeakest;
      if (delta >= 8) return 8;
      if (delta >= 5) return 5;
      if (delta >= 3) return 2;
      return -1;
    },

    "Joker's Playing Card": function (ai, owner = 'ai') {
      const incoming = ai.unblockedIncoming(owner);
      if (incoming >= 8) return 7;
      if (incoming >= 5) return 4;
      if (incoming >= 3) return 2;
      return -1;
    },

    'Super Soldier Serum': function (ai, owner = 'ai') {
      const allies = Game.getAlliesOf(owner);
      if (!allies.length) return -1;
      const weak = allies.filter(a => (a.attack || 0) + a.currentHealth <= 3);
      if (weak.length && Game.getDrawPile(owner).length >= 5) return 4;
      return 1;
    },

    'Anti-Life Equation': function (ai, owner = 'ai') {
      const s = Game.state;
      const opp = Game.opponent(owner);
      let bestDelta = 0;
      for (let i = 0; i < Game.LANE_COUNT; i++) {
        const lane = s.lanes[i];
        if (lane.destroyed) continue;
        if (!lane[owner] || !lane[opp]) continue;
        const delta = ai.threatScore(lane[opp]) - ai.threatScore(lane[owner]);
        if (delta > bestDelta) bestDelta = delta;
      }
      if (bestDelta >= 6) return 9;
      if (bestDelta >= 3) return 5;
      if (bestDelta >= 1) return 2;
      return -1;
    },

    'Lazarus Pit': function (ai, owner = 'ai') {
      const dead = Game.state[owner].deadPile;
      if (!dead || !dead.length) return -1;
      const topCost = dead.reduce((m, c) => Math.max(m, c.baseCost || c.cost || 0), 0);
      if (topCost >= 6) return 5;
      if (topCost >= 4) return 3;
      if (topCost >= 2) return 2;
      return 1;
    },

    'Soul Stone': function (ai, owner = 'ai') {
      const allies = Game.getAlliesOf(owner);
      const enemies = Game.getEnemiesOf(owner);
      if (!allies.length || !enemies.length) return -1;
      let best = 0;
      for (const a of allies) {
        const ac = a.baseCost || a.cost || 0;
        for (const e of enemies) {
          const ec = e.baseCost || e.cost || 0;
          if (Math.abs(ac - ec) > 2) continue;
          const delta = ai.threatScore(e) - ai.threatScore(a);
          if (delta > best) best = delta;
        }
      }
      if (best >= 5) return 7;
      if (best >= 2) return 3;
      return -1;
    },
  },

  // Evaluate whether to play a trick right now. Returns a score; <=0 means hold.
  evalTrick(trick, owner = 'ai') {
    const s = Game.state;
    const opp = Game.opponent(owner);
    const desc = (trick.desc || '').toLowerCase();
    const enemies = Game.getEnemiesOf(owner);
    const allies = Game.getAlliesOf(owner);
    let score = 0;

    if (this.TRICK_ALWAYS_CAST.has(trick.name)) return 5;

    // Per-trick override — pass owner so the evaluator uses the right side.
    if (this.TRICK_EVALUATORS[trick.name]) {
      return this.TRICK_EVALUATORS[trick.name](this, owner);
    }

    const W = this.WEIGHTS;
    if (/destroy|devour|kill/.test(desc)) {
      if (!enemies.length) return -1;
      const best = enemies.reduce((x, y) => this.threatScore(y) > this.threatScore(x) ? y : x);
      const t = this.threatScore(best);
      score += t >= 5 ? W.trickRemovalHigh : t >= 3 ? W.trickRemovalMid : 0;
      if (t < 2) score += W.trickRemovalLowPenalty;
    }
    if (/deal\s+\d+/.test(desc)) {
      if (!enemies.length) return -1;
      const m = desc.match(/deal\s+(\d+)/);
      const dmg = m ? parseInt(m[1], 10) : 0;
      const hittable = enemies.filter(e =>
        !(e.invincibleTurns > 0) && !e.hasDamageImmunity && !(e.evadeCharges > 0)
      );
      if (!hittable.length) return -1;
      const killable = hittable.some(e => e.currentHealth <= dmg && (e.armorValue || 0) < dmg && this.threatScore(e) >= 3);
      score += killable ? W.trickDamageKillable : 1;
    }
    if (/freeze|stun|fear|mind control/.test(desc)) {
      if (!enemies.length) return -1;
      const bigThreat = enemies.some(e => this.threatScore(e) >= 5);
      score += bigThreat ? W.trickFreezeBigThreat : 1.5;
    }
    if (/heal|\+\d|buff|give an ally|give.*evade|armor|invincible|taunt/.test(desc)) {
      if (!allies.length) return -1;
      const topAlly = allies.reduce((x, y) => (y.attack || 0) > (x.attack || 0) ? y : x);
      score += W.trickBuffAlly;
      const l = Game.findCardLane(topAlly);
      if (l >= 0 && s.lanes[l][opp]) score += 1.5;
    }
    if (/draw/.test(desc)) {
      const handCap = 7;
      const room = Math.max(0, handCap - s[owner].hand.length);
      score += room >= 2 ? W.trickDrawBonus : room === 1 ? W.trickDrawBonus * 0.5 : 0;
    }
    if (/summon/.test(desc)) score += W.trickSummonBonus;
    if (/move/.test(desc)) {
      const openLanes = Game.getOpenLanes(owner).length;
      score += (allies.length && openLanes) ? 1 : -2;
    }

    const c = trick.cost || 0;
    if (c >= 4 && score < 3) return -1;

    if (score === 0) return allies.length ? 1 : -1;
    return score;
  },

  playTricks(owner = 'ai', onComplete) {
    // Pause-then-cast loop: thinking dots show first, then the AI
    // commits its best trick (re-evaluated per step against fresh
    // board state). Matches the _runAIQueue pattern — user sees the
    // "think → play → think → play" rhythm instead of instant-drop.
    const s = Game.state;
    const delay = this.aiStepMs();
    let safety = 0;
    const step = () => {
      if (safety++ >= 10) {
        document.body && document.body.classList.remove('ai-thinking');
        if (onComplete) onComplete();
        return;
      }
      // Same guard as _runAIQueue — wait for any player prompt to
      // resolve before casting. Prevents out-of-sync action clashes
      // where an AI trick fires while the player still has a modal
      // (e.g. a Start-of-Tricks move) to respond to.
      if (typeof Game !== 'undefined' && Game.hasPendingPrompt && Game.hasPendingPrompt()) {
        document.body && document.body.classList.add('ai-thinking');
        Game.whenPromptCleared(() => {
          document.body && document.body.classList.remove('ai-thinking');
          step();
        });
        return;
      }
      let best = null, bestScore = 0;
      for (const t of s[owner].trickHand) {
        const cost = Game.getTrickCost(owner, t);
        if (cost > s[owner].currency) continue;
        // Skip tricks that were countered by Time Stone this round —
        // they bounced back to the AI's hand but are on a 1-round
        // timeout so the AI doesn't instantly re-play the same trick
        // the player just spent Time Stone to cancel.
        if (t._timeStonedAtRound === s.round) continue;
        // Also skip tricks marked reactive — they only fire via
        // intercept (e.g. Time Stone itself when AI has it).
        if (t.reactive) continue;
        const score = this.evalTrick(t, owner);
        if (score > bestScore) { best = t; bestScore = score; }
      }
      if (!best) {
        document.body && document.body.classList.remove('ai-thinking');
        if (onComplete) onComplete();
        return;
      }
      if (delay > 0) {
        document.body && document.body.classList.add('ai-thinking');
        setTimeout(() => {
          document.body && document.body.classList.remove('ai-thinking');
          // Re-resolve best-at-fire-time in case state shifted during
          // the pause (another prompt resolved, etc.).
          if (!s[owner].trickHand.includes(best)) { step(); return; }
          if (Game.getTrickCost(owner, best) > s[owner].currency) { step(); return; }
          Game.playTrick(owner, best);
          if (typeof UI !== 'undefined' && UI.render) UI.render();
          step();
        }, delay);
      } else {
        Game.playTrick(owner, best);
        if (typeof UI !== 'undefined' && UI.render) UI.render();
        step();
      }
    };
    step();
  }
};

// ============================================================
// Load tuned weights (non-destructive). If sim/data/weights-current.json
// exists, merge it into AI.WEIGHTS at startup. Runs only in a browser —
// the headless simulator ignores this (no `fetch` + `typeof window` check).
// To refresh: re-run `jsc sim/tune.js -- ...` then reload the page.
// To revert to defaults: delete sim/data/weights-current.json (or rename it).
// ============================================================
if (typeof window !== 'undefined' && typeof fetch === 'function') {
  fetch('sim/data/weights-current.json', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(w => {
      if (!w) return;
      let count = 0;
      for (const k in w) {
        if (k in AI.WEIGHTS) { AI.WEIGHTS[k] = w[k]; count++; }
      }
      console.log(`[AI] loaded ${count} tuned weights from sim/data/weights-current.json`);
    })
    .catch(() => { /* file missing is fine — use defaults */ });
}
