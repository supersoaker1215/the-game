// ============================================================
// AI OPPONENT — smarter lane selection, taunt awareness, strategy
// ============================================================

const AI = {
  // Tunable weights — the CEM tuner (sim/tune.js) perturbs these. Defaults
  // reproduce the hand-tuned behavior exactly. Override at runtime by mutating
  // this object before AI methods are called, or by loading a JSON file via
  // `--weights path.json` in the simulator.
  WEIGHTS: {
    // Draft curve — CEM-tuned 2026-06-02 (gen 10, 30-pop, 40 games/sample)
    draftBucketDeficitMult: 3.384,
    draftBucketOverPenalty: 7.176,
    draftEarlyFloorBase: 2.452,
    draftEarlyFloorRamp: 0.512,
    draftLowBias: 1.550,
    draftHighOverPenalty: 2.218,
    draftStatMult: 1.549,
    // Threat scoring — CEM-tuned
    threatSplashMult: -0.441,
    threatOverdriveBonus: 1.991,
    threatBullseyeBonus: 3.063,
    threatInvincibleBonus: 1.336,
    threatEvadeBonus: 2.047,
    threatArmorMult: 0.490,
    threatTauntBonus: 1.229,
    // Block / defensive play — CEM-tuned
    blockKillBonus: 4.244,
    blockSurviveBonus: 4.237,
    blockTradePenalty: -5.899,
    blockCostDeltaMult: 0.525,
    blockExpensiveOverKillPenalty: -3.369,
    defensiveThresholdNormal: 5.096,
    // Hard is the PRESSURE tier — see the note in playCards. Was 3.135, the
    // LOWEST of the three, which made hard the most defensive AI in the game.
    // Swept hard-vs-normal, seats swapped, 1600 games a point:
    //     thr    defensive turns    hard win%
    //     3.135      54.5%            49.3    <- a coin flip. "Hard" meant nothing.
    //     9          23.5%            50.9
    //     12         14.3%            54.3    <- 3.4 sigma above even (SE 1.25pp)
    // So pressing is not a trade against strength here, it IS the strength:
    // the same change that makes hard 3.8x less defensive also makes it the
    // first version of hard that actually beats normal. 12 rather than 16
    // because it still answers a genuinely big swing — an AI that never blocks
    // reads as broken, not brave.
    // !! TWO PLACES !! sim/data/weights-current.json is fetched at startup in
    // the BROWSER and overwrites every key it shares with this object — and the
    // headless sim does NOT load it. So the value here is what every sim
    // measurement uses, and the value in that file is what the game actually
    // plays. Changing only this one measures a change nobody ever gets.
    defensiveThresholdHard: 12,
    defensiveThresholdEasy: 17.274,
    // Hard does not turtle when it is far behind. Costs win rate or does not —
    // measured in the sweep; either way a losing opponent that hunkers down is
    // the least threatening thing on the board.
    hardPressesWhenBehind: true,
    // Lethal awareness (posture + lane choice). 1 = on. Behind a weight so it
    // can be A/B'd against itself rather than argued about.
    lethalPush: 1,
    // Trick evaluation — CEM-tuned
    trickRemovalHigh: 8.385,
    trickRemovalMid: 2.186,
    trickRemovalLowPenalty: -4.066,
    trickDamageKillable: 4.280,
    trickFreezeBigThreat: 3.457,
    trickBuffAlly: 3.986,
    trickDrawBonus: 2.369,
    trickSummonBonus: 2.392,
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
    // MEASURED DEAD. Giving hard the lookahead that normal lacks was the
    // obvious idea and it is worth nothing: 400 games a side, seats swapped,
    // hard won 50.5% at weight 1 and 47.5% at weight 4. The original A/B that
    // shipped lookaheadMult at 0 was right, and re-running it post-shim-fix
    // only confirmed it. Left at 0 with the wiring intact so the next person
    // does not have to rediscover this — sim/difficulty.js re-runs it.
    hardLookahead: 0,
    // Simulated play evaluation. 0 = off; see the measurement table on
    // AI._simEnabled before turning it on.
    simEval: 0,
    lookaheadHpWeight: 3,
    // ---- 2v2 TEAMPLAY (tunable like everything else) ----
    // How hard to leave an open lane alone when a teammate still has a card
    // turn this round and there is an unanswered enemy body to block instead.
    teamReserveLane: 0,
    // Bonus for answering a threat the TEAM has left unblocked — in 2v2 the
    // damage lands on shared health, so an enemy nobody covered is the team's
    // problem, not the seat's.
    teamCoverUnblocked: 0,
    // Penalty for piling a second body into a lane the team has already
    // answered elsewhere while other lanes leak.
    teamSpreadBias: 0,
    // DIVISION OF LABOUR: how much harder to go after the scariest enemy while
    // a partner still has a card turn coming — they are the one least likely to
    // be answerable cheaply after me.
    teamThreatPriority: 0,
    // Weight on the POST-COMBAT board simulation when placing in 2v2. The 1v1
    // knob (lookaheadMult) ships at 0 because a clean A/B found it a wash
    // there — but an eight-lane board that two players fill between them is a
    // different question, so 2v2 gets its own knob to be measured on its own.
    team2v2Lookahead: 0,
    // ENERGY HELD BACK FOR A TRICK. Cards are played before tricks inside the
    // same turn, so the card loop eats the whole pool and the trick phase finds
    // nothing affordable — measured: 58% of the affordable tricks an AI seat
    // held were never cast, and 2.1 tricks were still in hand when the game
    // ended. This is the minimum evalTrick score that justifies holding its
    // cost back from the card loop. 0 disables the reserve.
    teamTrickReserveMin: 0,
    // 1 = skip the defensive block planner in 2v2. THIS IS THE ONE THAT WORKED.
    // Sensitivity probe: taking the planner AWAY from a seat made that seat
    // BETTER by 5.6pp, and the change measured +4.3pp head to head over 4800
    // games (54.3%, against a 48.6–51.4 no-difference band). It commits the
    // best body to a trade a partner may already be covering, on an eight-lane
    // board where an uncontested lane hits health both partners share — and it
    // front-loads the card loop, which is what made play ORDER look like a 7pp
    // decision in the same probe. Without it, order barely matters (53.6% vs
    // 54.3% between cheapest-first and dearest-first) because nothing is
    // stranding the good body any more.
    teamSkipBlockPlan: 1,
    // The minimum evalTrick score a 2v2 seat will cast at. playTricks starts
    // its search at 0, so a trick the evaluator is merely unexcited about is
    // held — and measured, NOT casting tricks costs a seat 16pp, which is the
    // largest single dimension in the game after simply getting bodies down.
    // Lower bar = cast more freely.
    teamTrickBar: 0,
    // Play order for 2v2 only ('' = inherit the 1v1 rule). Order is the single
    // biggest decision the card loop makes — measured at 7pp between best and
    // worst — so it is worth asking whether an eight-lane game with energy to
    // spare wants a different one. '' | 'asc' | 'desc' | 'rand' | 'quality'.
    team2v2PlayOrder: '',
  },

  // ===================== 2v2 TEAMPLAY =====================
  // The 1v1 brain plays a SIDE. In 2v2 a side is two people who alternate with
  // the enemy, hold separate hands and separate energy, and share one health
  // bar — so the same board means different things depending on who still has
  // a turn coming. This is the context the lane and trick logic consult so an
  // AI seat plays like it has a partner instead of like it is alone.
  // Returns null outside 2v2, and every consumer treats null as "1v1 rules".
  _2v2Ctx(owner) {
    const G = (typeof Game !== 'undefined') ? Game : null;
    if (!G || !G.is2v2 || !G.is2v2()) return null;
    const tt = G.state && G.state.twoVTwo;
    if (!tt || !tt.players || !G._2v2ComputePhaseOrder) return null;
    const seat = G._2v2CurrentActingPlayer || G._2v2AIDriving || (G._2v2ActivePlayer && G._2v2ActivePlayer());
    const me = seat && tt.players[seat];
    if (!me) return null;
    const order = G._2v2ComputePhaseOrder(tt.round || 1) || [];
    const idx = tt.subPhaseIdx || 0;
    const laterTurns = order.slice(idx + 1);
    const playsCards = (step, pk) => step.indexOf(pk + '-') === 0 && step.indexOf('cards') >= 0;
    const teammate = Object.keys(tt.players).find(k => k !== seat && tt.players[k].team === me.team);
    const enemies = Object.keys(tt.players).filter(k => tt.players[k].team !== me.team);
    return {
      seat, teammate,
      // Does my partner still get to place a card after me this round?
      teammateActsLater: !!teammate && laterTurns.some(st => playsCards(st, teammate)),
      // Do I still get a trick window this round? ('cards' seats take their
      // tricks at the END of the round, so their energy has somewhere to go
      // even though this turn is cards-only.)
      iPlayTricksLater: laterTurns.some(st => st.indexOf(seat + '-') === 0 && st.indexOf('tricks') >= 0),
      teammateCards: teammate ? (tt.players[teammate].hand || []).length : 0,
      teammateEnergy: teammate ? Math.max(0, (tt.players[teammate].energy || 0) - (tt.players[teammate].usedEnergy || 0)) : 0,
      // How many enemy card turns are still to come — a trick cast before
      // those lands on a board that is about to change.
      enemyCardTurnsLeft: enemies.reduce((n, pk) => n + laterTurns.filter(st => playsCards(st, pk)).length, 0),
    };
  },

  // Enemy bodies this side has left uncontested — in 2v2 that damage lands on
  // the health BOTH partners share, so covering one is a team play even when
  // the trade looks even for the seat making it.
  _2v2UnansweredLanes(owner) {
    const G = Game, s = G.state, opp = G.opponent(owner), out = [];
    for (let i = 0; i < G.LANE_COUNT; i++) {
      const e = s.lanes[i][opp], mine = s.lanes[i][owner];
      if (e && e.currentHealth > 0 && (!mine || mine.currentHealth <= 0)) out.push(i);
    }
    return out;
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
  // 2v2 DRAFTS A DIFFERENT DECK. pickDraftCard optimises a COST CURVE, because
  // in 1v1 energy is the binding constraint — you need cheap bodies for rounds
  // 1-3 or the curve strands you. Measured in 2v2, energy is not the constraint
  // at all: seats finish a card turn with 47.6% of their energy unspent and an
  // affordable card in hand only a quarter of the time. What is scarce there is
  // CARDS (one draw a round, four seats, eight lanes), so every pick should buy
  // the most power per card and ignore the curve entirely.
  pickDraftCard2v2(choices, drafted) {
    if (!choices || !choices.length) return null;
    if (choices.length === 1) return choices[0];
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < choices.length; i++) {
      var q = this.draftCardQuality(choices[i]);
      if (q > bestScore) { bestScore = q; best = choices[i]; }
    }
    return best;
  },

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
  // `extra` is damage arriving from somewhere OTHER than the card in front —
  // adjacent splash, in practice. It used to be ignored entirely, so the picker
  // asked "do I survive the trade" while the real question was "do I survive
  // the trade AND the splash", and walked bodies into lanes that killed them.
  wouldSurvive(myCard, enemy, extra) {
    if (myCard.invincibleTurns > 0 || myCard.hasDamageImmunity) return true;
    if (myCard.evadeCharges > 0) return true;
    const armor = myCard.armorValue || 0;
    let incoming = Math.max(0, (enemy ? (enemy.attack || 0) : 0) - armor);
    // Splash is a separate hit, so armour applies to it separately too.
    if (extra > 0) incoming += Math.max(0, extra - armor);
    if (!enemy && !(extra > 0)) return true;
    return myCard.currentHealth > incoming;
  },

  // HOW MUCH SPLASH LANDS ON THIS LANE?
  //
  // Game.effectiveSplash is the authority — applySplash calls it, and it is the
  // only thing that knows about `_splashTracksAtk`, the flag that makes Hulk's
  // splash equal his ATTACK. The hazard term below read the raw `splashRange`
  // FIELD instead, which for Hulk is whatever a sync last wrote there, so a
  // 5-ATK Hulk next door scored as no hazard at all and the bot placed a 5 HP
  // body beside him. (Owner: "why would my teammate actively play windu in lane
  // 7 when there's a hulk in lane 6 who splashes.") Splash only ever reaches the
  // two immediately adjacent lanes — never the lane in front — which is exactly
  // the case cost alone cannot see.
  incomingSplash(laneIdx, owner) {
    const s = Game.state, opp = Game.opponent(owner);
    let d = 0;
    [laneIdx - 1, laneIdx + 1].forEach(li => {
      if (li < 0 || li >= Game.LANE_COUNT) return;
      const e = s.lanes[li] && s.lanes[li][opp];
      if (!e || e.currentHealth <= 0) return;
      // Something that is not going to swing is not going to splash.
      if (e.isFrozen || e.isStunned || e.isFeared || e.isMindControlled) return;
      d += (Game.effectiveSplash ? Game.effectiveSplash(e) : (e.splashRange || 0));
    });
    return d;
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
  // PER-SEAT, not global. This read the one global setting, so both seats in a
  // simulated match always had the SAME difficulty — which makes the question
  // "is hard actually harder than normal?" unanswerable, because you can never
  // sit them opposite each other. Every caller passes its owner now; with no
  // override set the answer is the global setting exactly as before, so live
  // play is unchanged.
  //
  // _diffOverride is how the harness pits one against the other:
  //   AI._diffOverride = { ai: 'hard', player: 'normal' }
  _diffOverride: null,
  difficulty(owner) {
    if (this._diffOverride && owner && this._diffOverride[owner]) return this._diffOverride[owner];
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
        // Phase B — post-play hold for animations to settle. Space the next
        // card off the SHORT play-to-play stagger (≤1.4s), not the full SFX
        // length — the cue keeps playing under the next play, so a long unique
        // bite no longer forces a ~5s wait between AI cards even on 'fast'.
        const sfxEndsAt = (typeof UI !== 'undefined' && UI.sfx && UI.sfx._playStaggerUntil) || 0;
        const sfxRemaining = Math.max(0, sfxEndsAt - Date.now());
        const stepDelay = Math.max(postDelay, sfxRemaining + 80);
        if (stepDelay > 0) {
          setTimeout(step, stepDelay);
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

  // ---- WHY DID IT DO THAT? ----
  // The user plays this game and reports the plays that look stupid. Without a
  // record, every such report is a re-derivation from memory: which card, which
  // lane, what else was affordable, what posture the AI was in. This keeps the
  // last few decisions so a report can be answered from what actually happened.
  //
  // Deliberately NOT in Game.state: state rides every multiplayer broadcast and
  // gets snapshotted for undo, and a debug buffer belongs in neither. It is a
  // plain ring buffer on the AI object, dropped on reload, costing one small
  // object per play.
  //
  // Read it from the console with AI.why() after a play that looked wrong.
  _trace: [],
  _TRACE_MAX: 30,
  _note(entry) {
    try {
      this._trace.push(entry);
      if (this._trace.length > this._TRACE_MAX) this._trace.shift();
    } catch (e) {}
  },
  // Human-readable dump of the recent decisions, newest last.
  why(n) {
    const rows = this._trace.slice(-(n || 10));
    if (!rows.length) return 'no AI decisions recorded yet';
    return rows.map(r =>
      `r${r.round} ${r.owner} ${r.posture}  played ${r.card} (${r.cost}e ${r.atk}/${r.hp}) -> lane ${r.lane}`
      + `\n      their HP ${r.oppHp}, my unblocked ${r.myFace}, incoming ${r.incoming}, energy ${r.energyBefore}->${r.energyAfter}`
      + (r.alsoAffordable ? `\n      also affordable: ${r.alsoAffordable}` : '')
    ).join('\n');
  },

  playCards(owner = 'ai', onComplete) {
    if (Game.isMultiplayer && Game.isMultiplayer()) { if (onComplete) onComplete(); return; }
    const s = Game.state;
    const opp = Game.opponent(owner);
    // BWL intercept: if the opponent has a live Batman Who Laughs and our
    // nextCardStolen is set, our NEXT card play gets snatched. Feed the
    // cheapest affordable card first as a sacrifice.
    if (s[owner].nextCardStolen) {
      const candidates = s[owner].hand.filter(c => {
        if (c._neverPlayable) return false; // Iron Giant — can't be bait, can't be played
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
    const diff = this.difficulty(owner);
    const defensiveThreshold = diff === 'easy' ? this.WEIGHTS.defensiveThresholdEasy : diff === 'hard' ? this.WEIGHTS.defensiveThresholdHard : this.WEIGHTS.defensiveThresholdNormal;
    // PRESSURE, NOT DEPTH. Measured over 120 games a tier, the share of turns
    // the AI spent blocking rather than pressing was:
    //     hard 54.4%   normal 41.4%   easy 14.7%
    // Hard was the most passive opponent in the game. Someone who picks HARD
    // and then watches it spend every other turn holding the line is not
    // playing something that feels hard, whatever its win rate says — and its
    // win rate says nothing either: chooseLane's own note records hard vs
    // normal at 150/150, a coin flip, because a 3.1-vs-5.1 threshold is flat
    // in that range. "Hard" was a label on nothing.
    //
    // So hard's threshold is now the HIGHEST of the three: it eats chip damage
    // and keeps developing instead of answering every threat. Easy still plays
    // its own way (17.3) — it barely blocks because it barely plans, which is
    // a different thing from choosing to press.
    //
    // TURTLING WHILE LOSING IS THE WORST OF IT. `farBehind` forced the
    // defensive posture no matter what, so the further behind the AI got the
    // more it hunkered down — the exact moment a human piles on. You cannot
    // win from 10 HP down by blocking. On hard that clause is dropped: behind
    // means race, not retreat.
    const _turtleWhenFarBehind = !(diff === 'hard' && this.WEIGHTS.hardPressesWhenBehind);
    // GOING FOR THE KILL. The AI had no concept of lethal — nowhere in this
    // file did it ask "can I finish them this turn?". It would hold a winning
    // board, answer a threat that no longer mattered, and give the player
    // another turn to find an out. Nothing reads as mercy like an opponent
    // that does not take the kill.
    //
    // unblockedIncoming(opp) is the damage MY uncontested bodies will do to
    // THEM next combat — the function is already parameterised both ways, so
    // this costs one call. The kill is in reach when that plus the best body I
    // could still place this turn covers their remaining health.
    const _bestBody = s[owner].hand.reduce((m, c) =>
      (c && !c._neverPlayable && Game.getCardCost(owner, c) <= s[owner].currency)
        ? Math.max(m, c.attack || 0) : m, 0);
    // ONLY WHEN THEY CANNOT ANSWER IT. First cut of this pushed for lethal
    // whenever the arithmetic worked, and measured 1.7pp WORSE (49.2 vs 50.9,
    // 2500 games a side). The reason is turn order: firstPlayer alternates, so
    // when WE move first an "uncontested" lane is only a lane they have not
    // filled YET. The AI was spending its best body chasing a kill the player
    // then simply blocked, instead of using it where it mattered.
    // When they have already taken their card step, the board they left is the
    // board combat resolves on, and the same arithmetic is real.
    // Reads firstPlayer only — public information. The opponent's HAND is not
    // consulted anywhere here; an AI that peeks is a different complaint.
    const _theyAlreadyMoved = s.firstPlayer !== owner;
    const killInReach = this.WEIGHTS.lethalPush > 0 && _theyAlreadyMoved
      && s[opp].health > 0
      && s[opp].health <= this.unblockedIncoming(opp) + _bestBody;
    const defensive = !killInReach
      && (incoming >= defensiveThreshold || (farBehind && _turtleWhenFarBehind));

    // ---- ENERGY RESERVED FOR A TRICK (2v2) ----
    // The card loop below spends down to zero, and the trick phase runs after
    // it, in the same turn, out of the same pool. So a seat holding a good
    // trick would play a marginal body instead and then find the trick
    // unaffordable — 58% of affordable tricks were never cast, and seats
    // finished games still holding them. If the best trick on this board is
    // worth more than the marginal card, hold its cost back.
    // Capped at 60% of the pool: a reserve that eats the whole turn is just a
    // pass, and a body on the board beats a trick in hand.
    let energyReserve = 0;
    const _teamCtx = this._2v2Ctx(owner);
    if (_teamCtx && this.WEIGHTS.teamTrickReserveMin > 0) {
      const _sub = Game._2v2SubPhase && Game._2v2SubPhase();
      const _trickWindow = (_sub && Game._2v2CanPlayTricks(_sub)) || _teamCtx.iPlayTricksLater;
      if (_trickWindow) {
        let bestCost = 0, bestScore = 0;
        for (const t of (s[owner].trickHand || [])) {
          if (t.reactive) continue;
          const c = Game.getTrickCost(owner, t);
          if (c > s[owner].currency) continue;
          const sc = this.evalTrick(t, owner);
          if (sc > bestScore) { bestScore = sc; bestCost = c; }
        }
        if (bestScore >= this.WEIGHTS.teamTrickReserveMin) {
          energyReserve = Math.min(bestCost, Math.floor(s[owner].currency * 0.6));
        }
      }
    }
    const spendable = () => Math.max(0, s[owner].currency - energyReserve);

    // Plans get collected first, then executed one at a time through
    // _runAIQueue so the player can read each play before the next one
    // fires. Each entry re-checks affordability / open lanes at fire
    // time so the queue survives mid-turn board changes.
    const queue = [];

    // Step 1: commit our best blockers to the biggest threats first.
    const committedIds = new Set();
    if (diff !== 'easy' && !(_teamCtx && this.WEIGHTS.teamSkipBlockPlan)) {
      const blockPlan = this.planDefensiveBlocks(s[owner].hand.filter(c => !c._neverPlayable), spendable(), owner);
      blockPlan.forEach(p => committedIds.add(p.cardId));
      for (const plan of blockPlan) {
        queue.push(() => {
          const card = s[owner].hand.find(c => c.id === plan.cardId);
          if (!card) return;
          const cost = Game.getCardCost(owner, card);
          if (cost > spendable()) return;
          Game.playCard(owner, card, plan.lane);
        });
      }
    }

    // Step 2: play remaining cards using the priority heuristic.
    const remaining = [...s[owner].hand].filter(c => {
      if (c._neverPlayable) return false; // Iron Giant guards from hand — never a play candidate
      if (committedIds.has(c.id)) return false;
      // Iron Man and Thanos are tagged trickPhasePlayable — both are
      // strictly stronger when held for the trick phase (Iron Man finishes
      // off damaged enemies that combat just chipped; Thanos lands the
      // 3-lane purge after the opponent has committed). Always save them,
      // even when behind — playing them in phase 1 wastes the trigger
      // window.
      if (c.trickPhasePlayable) return false;
      return true;
    });
    // PLAY ORDER IS THE DIFFICULTY LEVER. Measured, twice, adversarially:
    // playing the CHEAPEST affordable card first strands the AI's best body on
    // 34.6% of turns. Flipping to most-expensive-first is worth +6.3pp head to
    // head — five to seven times more than anything the lookahead or lane
    // search can buy, from one comparator.
    //   easy          -> 'asc'  : the old, genuinely weak behaviour
    //   normal / hard -> 'desc' : commit the best body it can afford
    // WEIGHTS._playOrder still overrides, so sim/tune.js and A/B harnesses can
    // force any order regardless of tier.
    const __ord = (_teamCtx && this.WEIGHTS.team2v2PlayOrder)
                  || (this.WEIGHTS && this.WEIGHTS._playOrder)
                  || (diff === 'easy' ? 'asc' : 'desc');
    if (__ord === 'quality') {
      // Energy is not the constraint in 2v2 (seats end a turn with ~48% of it
      // unspent), so "the most expensive card I can afford" is a proxy for the
      // wrong thing. Sort by the drafter's own quality measure instead.
      remaining.sort((a, b) => this.draftCardQuality(b) - this.draftCardQuality(a));
    } else if (__ord === 'rand') {
      for (let i = remaining.length - 1; i > 0; i--) {
        const j = Game.rngInt(i + 1);
        const t = remaining[i]; remaining[i] = remaining[j]; remaining[j] = t;
      }
    } else {
      const dir = __ord === 'desc' ? -1 : 1;
      remaining.sort((a, b) => {
        const aHasOnPlay = a.onPlay ? 1 : 0;
        const bHasOnPlay = b.onPlay ? 1 : 0;
        const tie = dir * ((a.cost || 0) - (b.cost || 0));
        if (defensive) {
          if (aHasOnPlay !== bHasOnPlay) return bHasOnPlay - aHasOnPlay;
          return tie;
        }
        if (behind) {
          if (aHasOnPlay !== bHasOnPlay) return bHasOnPlay - aHasOnPlay;
          return (b.cost || 0) - (a.cost || 0);
        }
        return tie;
      });
    }

    // A CARD THAT GROWS FROM LATER PLAYS BELONGS BEFORE THEM.
    //
    // Xenomorph is "+1/+1 each time any other card enters the board". At cost 2
    // under the most-expensive-first rule he was always the LAST thing played,
    // so he grew by exactly nothing and went to combat as a 0/1. (Owner: "the ai
    // always plays xenomorph last — if that card is going to be played it always
    // is played 1st.") It is not only him: every While-Active that answers an
    // ENTRY only ever reaches the bodies that land after it — Juggernaut's
    // adjacent Immunity, Poison Ivy's charm, Luke's and Dr. Strange's auras. So
    // the rule is derived from the card's own hook rather than a name list, and
    // a new card with the same shape is covered the day it is added.
    //
    // BUT PLAY ORDER IS THE DIFFICULTY LEVER — most-expensive-first is worth
    // +6.3pp head to head precisely because cheapest-first strands the AI's best
    // body on 34.6% of turns. So a reactive card jumps the queue ONLY when
    // paying for it still leaves enough energy for the dearest card behind it.
    // It goes first when that is free, and waits when going first would cost the
    // AI its big play. Nothing is dropped either way; this only reorders.
    const _reactsToEntry = (c) => !!(c && c.onAnyCardPlayed && !c.isEnvironment);
    if (remaining.some(_reactsToEntry)) {
      const _budget = spendable();
      const _lift = [];
      remaining.forEach((c) => {
        if (!_reactsToEntry(c)) return;
        const own = Game.getCardCost(owner, c) || 0;
        // The most expensive OTHER card still waiting — the one the desc order
        // exists to protect.
        let dearest = 0;
        remaining.forEach((o) => {
          if (o === c || _lift.indexOf(o) >= 0) return;
          dearest = Math.max(dearest, Game.getCardCost(owner, o) || 0);
        });
        if (own + dearest <= _budget) _lift.push(c);
      });
      // Stable lift: pull them out in place, then put them back at the front in
      // the order the sort above already settled on.
      _lift.forEach((c) => {
        const i = remaining.indexOf(c);
        if (i >= 0) remaining.splice(i, 1);
      });
      for (let i = _lift.length - 1; i >= 0; i--) remaining.unshift(_lift[i]);
    }

    for (const cardRef of remaining) {
      queue.push(() => {
        // Recheck the card is still in hand (another play in this turn
        // may have triggered a Batman intercept etc.) and re-evaluate
        // affordability + lane since the board moves between plays.
        let card = s[owner].hand.find(c => c.id === cardRef.id);
        if (!card) return;
        if (spendable() <= 0) return;
        let cost = Game.getCardCost(owner, card);
        if (cost > spendable()) return;
        if (card.isDiscardEffect) { Game.playCard(owner, card, 0); return; }
        let lane = this.chooseLane(card, owner);
        if (lane < 0) return;
        // SIMULATED RE-RANK (hard only). The heuristic queued these in its own
        // order; before committing THIS one, ask what actually happens if each
        // of the top few affordable cards is played, and take the best real
        // outcome. Reconsidered at play time rather than when the queue was
        // built, because the board moves between plays. Falls straight back to
        // the heuristic when simulation is off or could not run.
        // ONLY WHEN COMBAT ACTUALLY FOLLOWS. previewPlay plays the card and
        // resolves combat IMMEDIATELY — but mid-turn the fight is still several
        // plays away, so scoring by post-combat health answers a question that
        // is not being asked and rewards overextending into a board the
        // opponent has not finished building. Measured that way it came out at
        // 46.5%, WORSE than the heuristic. The forecast is only honest on the
        // last play of the turn, when nothing else will change the board first.
        const _spendAfter = spendable() - cost;
        const _isLastPlay = !s[owner].hand.some(c =>
          c.id !== card.id && !c.isDiscardEffect && Game.getCardCost(owner, c) <= _spendAfter);
        if (_isLastPlay && this._simEnabled(owner)) {
          const _afford = s[owner].hand.filter(c =>
            !c.isDiscardEffect && Game.getCardCost(owner, c) <= spendable());
          const _pick = this.simBestPlay(owner, _afford);
          if (_pick && _pick.card && _pick.card.id !== card.id) {
            const _c = Game.getCardCost(owner, _pick.card);
            if (_c <= spendable()) { card = _pick.card; lane = _pick.lane; cost = _c; }
          } else if (_pick && _pick.lane >= 0) {
            lane = _pick.lane;
          }
        }
        const targetLane = s.lanes[lane];
        const uncontestedHere = !targetLane[opp];
        if (uncontestedHere && this.opponentHasTaunter(owner) && (card.splashRange || 0) <= 0 && !card.isBullseye) {
          if ((card.cost || 0) >= 6 && s[owner].currency < (card.cost || 0) + 2) return;
        }
        // Invisible Woman face-down: when Invisible Woman is on board, the
        // AI gets one face-down play. Reserve it for a high-value finisher
        // (cost ≥ 6 with onPlay) so the protected card carries real swing —
        // hiding a 1-cost token from removal isn't worth burning the slot.
        if (s[owner].faceDownAvailable && (card.cost || 0) >= 6 && card.onPlay && !card.isFaceDown) {
          card._playFaceDown = true;
        }
        this._note({
          round: s.round,
          owner,
          posture: killInReach ? 'GOING FOR THE KILL' : (defensive ? 'defensive' : 'pressing'),
          card: card.name,
          cost,
          atk: card.attack,
          hp: card.currentHealth != null ? card.currentHealth : card.health,
          lane,
          oppHp: s[opp].health,
          myFace: this.unblockedIncoming(opp),
          incoming,
          energyBefore: s[owner].currency,
          energyAfter: s[owner].currency - cost,
          alsoAffordable: s[owner].hand
            .filter(c => c.id !== card.id && !c._neverPlayable
                      && Game.getCardCost(owner, c) <= spendable())
            .map(c => c.name).join(', '),
        });
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
  // ===================== SIMULATED PLAY EVALUATION =====================
  // Owner: build the thing that evaluates a candidate play against the ACTUAL
  // combat outcome instead of a hand-tuned heuristic.
  //
  // WHY THIS AND NOT A BIGGER HEURISTIC. Measured with sim/difficulty.js: the
  // CEM-tuned weights sit on a plateau. Hard vs normal was 150/150; giving hard
  // the lookahead was 50.5%; sweeping its defensive threshold across 1.5-12 was
  // flat. No dial moves it. What the AI lacks is not a better guess — it is
  // ground truth, and Game.previewPlay already produces it: clone the state,
  // play the card, run the REAL resolver, and report the health swing.
  //
  // WHAT IT COSTS. One clone plus one full combat per candidate. So the
  // heuristic stays as the PREFILTER — it ranks every legal play, and only the
  // top few get simulated. That keeps the cost bounded and uses each part for
  // what it is good at: the heuristic to discard the obviously bad, simulation
  // to separate the plausible.
  //
  // NEVER NESTED. previewPlay stamps the clone _silentSim; if the AI is somehow
  // reached inside one, this returns null and the caller falls back to the
  // heuristic rather than cloning a clone.
  // OFF, AND HERE IS WHY. Measured with sim/difficulty.js, seats swapped:
  //
  //     ungated, top-5 shortlist        200 games   46.5%
  //     gated to the last play          300 games   52.0%
  //     gated, top-12 shortlist         800 games   51.6%
  //     gated, top-5 shortlist         1200 games   50.7%
  //     gated, top-5 shortlist         6000 games   48.6%   <-- 2.2 sigma BELOW 50
  //
  // Read that column downwards. The encouraging 52% was noise at n=300 (SE
  // 2.9pp); at n=6000 (SE 0.65pp) the sign FLIPS and the simulating AI is
  // significantly worse than the heuristic it replaced. Shipping on the 52%
  // reading would have made the AI weaker while announcing it was smarter.
  //
  // Why it loses, most likely: previewPlay resolves combat one ply deep and
  // models none of the opponent's reply, so it is not more informed than the
  // heuristic — just differently approximate, and it trades a CEM-tuned
  // estimator for an untuned one. Gating it to the last play recovered most of
  // the loss (46.5 -> ~50), which is consistent with the myopia being the
  // problem rather than the simulation being wrong.
  //
  // The machinery is left wired and disabled, exactly as lookaheadMult is, so
  // the next attempt starts from this evidence instead of rediscovering it.
  // Set simEval to 1 and re-run: jsc sim/difficulty.js -- --games 6000
  SIM_CANDIDATES: 5,      // how many heuristic-ranked plays get simulated
  SIM_WIN_BONUS: 1000,    // a line that ends the game dominates any HP swing

  _simEnabled(owner) {
    if (!this.WEIGHTS.simEval) return false;                 // measured: off
    if (this.difficulty(owner) !== 'hard') return false;
    if (typeof Game === 'undefined' || !Game.previewPlay) return false;
    if (Game.state && Game.state._silentSim) return false;   // no nested sims
    return true;
  },

  // Net health swing from ONE candidate, from `owner`'s point of view.
  // Returns null when the simulation could not run, so callers can tell
  // "no opinion" apart from "scored zero".
  _simScore(owner, card, laneIdx) {
    let r = null;
    try { r = Game.previewPlay({ side: owner, cardId: card.id, laneIdx: laneIdx }); }
    catch (e) { return null; }
    if (!r) return null;
    const opp = owner === 'ai' ? 'player' : 'ai';
    // deltas are negative when health was lost, so a good play makes the
    // OPPONENT's delta very negative and mine near zero.
    const myDelta   = owner === 'ai' ? r.aiHpDelta : r.playerHpDelta;
    const theirDelta = opp === 'ai' ? r.aiHpDelta : r.playerHpDelta;
    let score = (-theirDelta) - (-myDelta);       // damage dealt minus damage taken
    if (r.gameOver) {
      if (r.winner === owner) score += this.SIM_WIN_BONUS;
      else if (r.winner === opp) score -= this.SIM_WIN_BONUS;
    }
    return score;
  },

  // Re-rank the heuristic's top candidates by what actually happens. Returns
  // {card, lane} or null to mean "use the heuristic's answer".
  simBestPlay(owner, affordable) {
    if (!this._simEnabled(owner) || !affordable || !affordable.length) return null;
    // PREFILTER: the heuristic's own ordering, capped.
    const shortlist = affordable.slice(0, this.SIM_CANDIDATES);
    let best = null;
    for (const card of shortlist) {
      const lane = this.chooseLane(card, owner);
      if (lane < 0) continue;
      const sc = this._simScore(owner, card, lane);
      if (sc == null) continue;                 // simulation unavailable — skip it
      if (!best || sc > best.score) best = { card: card, lane: lane, score: sc };
    }
    return best;
  },

  // WHAT WILL THIS CARD ACTUALLY BE, ONCE IT LANDS IN *THIS* LANE?
  //
  // Almost every card is the same body wherever it goes, so the lane picker
  // scores the hand card directly. Scarlet Witch is not: she sits in hand as a
  // 0/0 carrying `copiesOpposite`, and ADOPTS the ATK and HP of whoever stands
  // opposite the lane she is played into.
  //
  // Scored as the literal 0/0, she can never kill, never survive and never deal
  // face damage — so every contested lane came back negative (-2 for "dies
  // without killing") and the picker shoved her into an EMPTY one, which is the
  // single placement that throws the ability away for a 3/4. The bot was not
  // picking a bad target; it was actively avoiding all of them.
  // (Owner: "the scarlet witch should go to the enemy with the most stats.")
  //
  // Hand the scorer the body she will HAVE, and every existing consideration —
  // threat, trade maths, survival, lethal — reads true with no special cases.
  // A face-down card cannot be copied (the ability refuses to read one, so the
  // hidden-card promise holds), so such a lane scores as the fallback.
  _asPlacedIn(card, laneIdx, owner) {
    if (!card || !card.copiesOpposite) return card;
    const AB = (typeof CARD_ABILITIES !== 'undefined' && CARD_ABILITIES['Scarlet Witch']) || null;
    const fb = (AB && AB.COPY_FALLBACK) || { atk: 3, hp: 4 };
    const bonus = card._witchHexBonus || 0;
    const l = Game.state.lanes[laneIdx];
    const foe = l ? l[Game.opponent(owner)] : null;
    const canCopy = foe && foe.currentHealth > 0 && !foe.isFaceDown;
    const atk = (canCopy ? (foe.attack || 0) : fb.atk) + bonus;
    const hp  = (canCopy ? (foe.currentHealth || foe.maxHealth || 1) : fb.hp) + bonus;
    // Prototype proxy: every other trait (keywords, cost, armor, owner) still
    // reads through, only the stat line is overridden. Nothing mutates it.
    const proxy = Object.create(card);
    proxy.attack = atk; proxy.baseAttack = atk;
    proxy.currentHealth = hp; proxy.maxHealth = hp;
    return proxy;
  },

  chooseLane(card, owner = 'ai') {
    const s = Game.state;
    const opp = Game.opponent(owner);
    const open = Game.getOpenLanes(owner);
    if (!open.length) {
      // Environments can go into any lane even if the owner already has a card there.
      if (card && card.isEnvironment) return Math.floor(Game.rng() * Game.LANE_COUNT);
      return -1;
    }
    const hasTaunter = this.opponentHasTaunter(owner);
    // ---- 2v2: what does my partner still get to do? ----
    const team = this._2v2Ctx(owner);
    const laMult = team ? this.WEIGHTS.team2v2Lookahead : this.WEIGHTS.lookaheadMult;
    // HARD GETS THE LOOKAHEAD. Measured, 300 games a side, seats swapped:
    // hard vs normal was 150/150 — exactly a coin flip — because the ONLY thing
    // separating them was a defensive threshold (3.1 vs 5.1) that the same
    // harness shows is flat in that range. The whole 25.7pp gap down to easy
    // comes from easy's 17.3 threshold, not from anything hard does.
    // So "hard" meant nothing. lookaheadMult ships at 0 for everyone, and the
    // A/B that zeroed it ran BEFORE the shim fix that made earlier tuning runs
    // roughly half noise — which makes it worth re-measuring rather than
    // inheriting. _hardLookahead is what hard gets that normal does not; normal
    // and easy are untouched, so nobody's existing game gets harder by surprise.
    const _diff = this.difficulty(owner);
    const _effLa = (_diff === 'hard' && laMult <= 0) ? this.WEIGHTS.hardLookahead : laMult;
    const useLookahead = _diff !== 'easy' && _effLa > 0;
    const leaks = team ? this._2v2UnansweredLanes(owner) : [];

    const baseCard = card;
    const scores = open.map(l => {
      const lane = s.lanes[l];
      const enemy = lane[opp];
      // See _asPlacedIn. For a copier this is a DIFFERENT body in every lane,
      // which is the whole reason the lane matters.
      const card = this._asPlacedIn(baseCard, l, owner);
      let score = 0;

      // THE BODY ITSELF IS THE DECISION HERE.
      //
      // For every other card the stat line is identical in all six lanes, so it
      // cancels out and the scorer rightly never prices it — which is why there
      // is no body term anywhere else in this function. For a copier it is the
      // ENTIRE choice, and the old ranking was blind to half of it: the only
      // per-lane signal was threatScore, and threat is essentially ATK. So a
      // 6/2 outranked a 4/9 and she copied the smaller card. Landing on 13
      // stats instead of 8 outlives whatever trades this turn.
      //
      // Weighted to dominate rather than nudge, because "become the biggest
      // thing you can" IS the card, and the surrounding terms (a +6 kill on a
      // mirror is a mutual trade, not a win) should only break ties. It stays
      // well under the +100 lethal push, which still outranks everything.
      if (baseCard.copiesOpposite) {
        score += ((card.attack || 0) + (card.currentHealth || 0)) * 3;
      }

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
        // Survive the TRADE AND THE SPLASH — see wouldSurvive.
        const iSurvive = this.wouldSurvive(card, enemy, this.incomingSplash(l, owner));
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
        // ---- 2v2 ----
        if (team) {
          // Shared health means an enemy nobody covered is the TEAM's problem,
          // not this seat's, so covering one is worth more than the 1v1
          // trade maths alone says.
          score += this.WEIGHTS.teamCoverUnblocked;
          // DIVISION OF LABOUR. While my partner still has a card turn coming,
          // I take the scariest thing on the board — it is the one they are
          // least likely to be able to answer cheaply after me. When they have
          // already played, this bias switches itself off and I take whatever
          // is left.
          if (team.teammateActsLater) score += threat * this.WEIGHTS.teamThreatPriority;
        }
      } else {
        // Uncontested — uncontested damage matters, but taunter neutralizes it
        // unless we have splash or bullseye to bypass.
        if (hasTaunter && (card.splashRange || 0) <= 0 && !card.isBullseye) {
          score += 0.5; // body value only
        } else {
          score += (card.attack || 0) * 0.8 + (card.splashRange || 0) * 0.6;
        }
        // LETHAL BEATS EVERY OTHER CONSIDERATION. If dropping this body in this
        // open lane takes their last health, no amount of blocking value,
        // adjacency or splash hazard is worth comparing against it. Gated on
        // the same taunter test as the damage above — a taunter eats the swing,
        // so it is not lethal at all unless we can bypass it.
        {
          const _tauntBlocks = hasTaunter && (card.splashRange || 0) <= 0 && !card.isBullseye;
          // Same gate as the posture check — see the note there. A lethal we
          // hand the opponent a turn to answer is not a lethal.
          if (!_tauntBlocks && this.WEIGHTS.lethalPush > 0 && s.firstPlayer !== owner) {
            const _theirHp = s[opp].health;
            const _already = this.unblockedIncoming(opp);
            if (_theirHp > 0 && _already + (card.attack || 0) >= _theirHp) score += 100;
          }
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
        // ---- 2v2 ----
        if (team) {
          // LEAVE THE EMPTY LANE FOR YOUR PARTNER. An open lane is the one
          // placement they can still make after me; an unanswered enemy is
          // damage on the health we share. While they have a card turn coming
          // and something is leaking, taking the free lane is the worse half of
          // that trade — so this only bites while BOTH are true.
          if (team.teammateActsLater && leaks.length) score -= this.WEIGHTS.teamReserveLane;
          // Clustering next to an ally is worth less on an eight-lane board
          // that two players have to cover between them.
          if (leaks.length > 1 && alliedLanes.length) {
            const d2 = Math.min(...alliedLanes.map(x => Math.abs(x - l)));
            if (d2 <= 1) score -= this.WEIGHTS.teamSpreadBias;
          }
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
        // 1. Direct attack splash. Through Game.effectiveSplash, not the raw
        //    field — see AI.incomingSplash for what that field misses.
        const atkSplash = Game.effectiveSplash ? Game.effectiveSplash(e) : (e.splashRange || 0);
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
      // Moder: forces the opponent's next card into Moder's lane and strips
      // its abilities/keywords. Uncontested placement maximizes value — if
      // the lane already has an enemy, the trap effect can't fire (the lane
      // is full). Big bonus for empty lanes; soft penalty for contested.
      if (card.name === 'Moder') {
        if (!enemy || enemy.currentHealth <= 0) score += 5;
        else score -= 4;
      }
      // Obi-Wan: damage from OTHER lanes reflects back; the directly-
      // opposite enemy is exempt. Place him so the exempt slot is the
      // LEAST threatening enemy on the board. Bonus scales with the threat
      // of the OTHER-lane enemies (the more reflectable damage, the better)
      // and penalizes putting him opposite the top threat.
      if (card.name === 'Obi-Wan') {
        let topThreatLane = -1, topThreat = -1;
        let totalOtherLaneAtk = 0;
        for (let i = 0; i < Game.LANE_COUNT; i++) {
          const e = s.lanes[i][opp];
          if (!e || e.currentHealth <= 0) continue;
          const t = this.threatScore(e);
          if (t > topThreat) { topThreat = t; topThreatLane = i; }
          if (i !== l) totalOtherLaneAtk += (e.attack || 0);
        }
        // Penalty: Obi-Wan opposite the top-threat (they're exempt from reflect).
        if (l === topThreatLane && topThreat >= 4) score -= 5;
        // Bonus: more reflectable damage from other lanes = better placement.
        score += totalOtherLaneAtk * 0.4;
      }
      // 1-ply lookahead bonus — simulates placement + the resulting combat
      // round, scores the post-combat board (HP swing + body delta) from
      // the AI's perspective. Catches whole-board interactions the per-lane
      // heuristic above misses (e.g. splash reaching 3 enemies, freeing two
      // other lanes to push uncontested HP damage).
      if (useLookahead) {
        score += _effLa * this._lookaheadScore(card, l, owner);   // _effLa, not laMult — see the note at its declaration
      }
      return { lane: l, score };
    });

    scores.sort((a, b) => b.score - a.score);
    // TIES GO TO A COIN, NOT TO THE LEFT. Array.prototype.sort is stable, so
    // every tie used to resolve to whichever lane came first in `open` —
    // always the lowest index. Measured over 200 games / 1898 placements the
    // AI put 26.4% of its cards in lane 0 and 8.2% in lane 5, a monotonic
    // left-slide, and it compounds: lane 0 fills, the "cluster near an ally"
    // bonus then favours lane 1, and so on across the board. It reads as a
    // script running left to right rather than an opponent making a choice.
    //
    // Only EXACT ties are shuffled, so this cannot cost a single point of
    // strength — the lanes it picks between scored identically. Uses the
    // seeded RNG (never Math.random) so replays, goldens and the fuzz harness
    // stay reproducible.
    const _top = scores[0].score;
    let _tied = 1;
    while (_tied < scores.length && scores[_tied].score === _top) _tied++;
    return _tied > 1 ? scores[Game.rngInt(_tied)].lane : scores[0].lane;
  },

  playTrickPhaseCards(owner = 'ai', onComplete) {
    if (Game.isMultiplayer && Game.isMultiplayer()) { if (onComplete) onComplete(); return; }
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

    'Space Stone': function (ai, owner = 'ai') {
      // Space Stone is a SETUP tool — it lets the AI play a card from
      // hand during the upcoming Trick Phase (at the card's normal
      // cost). User report 2026-05-19: "The AI just played Space
      // Stone in preview after they played Harley Quinn… that is a
      // dumb play." The generic scoring path was giving Space Stone
      // a +1 baseline whenever the AI had any allies on board, so it
      // fired every round it was in hand regardless of whether
      // trick-phase tempo would actually matter.
      //
      // Strategic value test: Space Stone is only worth casting when
      // BOTH of these are true:
      //   (a) The AI has a card in hand it COULDN'T play this turn
      //       (cost > current currency) — otherwise the AI could
      //       just play it normally and the trick wastes a slot.
      //   (b) The card it would unlock will be affordable in the
      //       trick phase. Tricks fire at the end of the round, and
      //       the AI's currency rolls over to the next round, so we
      //       can use the post-cards-phase currency as the
      //       projection — same as currentCurrency since nothing
      //       between this trick and the trick phase spends more
      //       energy. (Refunds aren't part of standard Space-Stone
      //       use; if the AI was holding a finisher, they want to
      //       drop it as a reactive answer, not a setup.)
      //
      // Reactive-finisher heuristic — value scales with the cost of
      // the unlockable card (proxy for "this is a real threat
      // worth saving for trick-phase reveal"). Cards ≤2 cost get a
      // negative score so Ant-Man / Poison Ivy don't trigger a
      // Space Stone. Cards ≥6 cost get a strong positive so titans
      // (Hulk, Dr. Doom, Magneto) reliably unlock.
      const s = Game.state;
      const cur = s[owner].currency || 0;
      const hand = s[owner].hand.filter(c => !c.isDiscardEffect && !c.trickPhasePlayable);
      if (!hand.length) return -1;
      // The card unlocks for play during the trick phase at its
      // normal cost. So it only matters if (a) the AI can't afford
      // it THIS turn (no point Space-Stoning a card you could just
      // play) AND (b) it'll be affordable when the trick phase
      // fires. Trick-phase energy = current + next-turn carryover.
      const nextTurnEnergy = cur + (s[owner].nextTurnCurrency || 0);
      const setupTargets = hand.filter(c => {
        const cost = Game.getCardCost ? Game.getCardCost(owner, c) : (c.cost || 0);
        // Can't afford this turn but COULD afford with carryover.
        // High-cost cards (≥6) are the worthwhile setups.
        return cost > cur && cost <= nextTurnEnergy && cost >= 4;
      });
      if (!setupTargets.length) return -1;
      // Score by the top setup target's cost — 4-5 = modest, 6-7 = good, 8+ = great.
      const top = setupTargets.reduce((a, b) => (b.cost || 0) > (a.cost || 0) ? b : a);
      const c = top.cost || 0;
      if (c >= 8) return 6;
      if (c >= 6) return 4;
      return 2;
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

    // LEGALITY FIRST. TRICK_ALWAYS_CAST short-circuits ahead of both the
    // per-trick evaluators and the keyword scoring below, so a listed trick
    // scored 5 even with nothing legal to point at — and Game.playTrick then
    // refused it on the very same canPlay the evaluator never consulted.
    // The AI re-picked it every step until the safety counter ended its whole
    // trick phase with nothing cast. Reproduces whenever the board denies a
    // listed trick its targets: an all-3+-ATK board against The Darkhold, or
    // any removal against Dr. Manhattan / an Untrickable card.
    if (trick.canPlay && !trick.canPlay(Game, owner)) return -1;

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
    if (Game.isMultiplayer && Game.isMultiplayer()) { if (onComplete) onComplete(); return; }
    // Pause-then-cast loop: thinking dots show first, then the AI
    // commits its best trick (re-evaluated per step against fresh
    // board state). Matches the _runAIQueue pattern — user sees the
    // "think → play → think → play" rhythm instead of instant-drop.
    const s = Game.state;
    const delay = this.aiStepMs();
    let safety = 0;
    // A trick the engine REFUSED. Without this, a refusal changes nothing —
    // the same trick still scores highest next step, so the AI re-picks it
    // until `safety` trips and the trick phase ends having cast nothing, while
    // the seat still holds tricks it could legally have played. The evaluator
    // gate above is the real fix; this is the backstop that makes any future
    // disagreement between "the AI wants it" and "the engine allows it" cost
    // one wasted step instead of the whole phase.
    const refused = new Set();
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
      const _tt = this._2v2Ctx(owner);
      let best = null, bestScore = _tt ? this.WEIGHTS.teamTrickBar : 0;
      for (const t of s[owner].trickHand) {
        const cost = Game.getTrickCost(owner, t);
        if (cost > s[owner].currency) continue;
        // Skip tricks that were countered by Time Stone this round —
        // they bounced back to the AI's hand but are on a 1-round
        // timeout so the AI doesn't instantly re-play the same trick
        // the player just spent Time Stone to cancel.
        if (t._timeStonedAtRound === s.round) continue;
        if (refused.has(t.id)) continue;              // engine already said no
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
          if (!Game.playTrick(owner, best)) refused.add(best.id);
          if (typeof UI !== 'undefined' && UI.render) UI.render();
          step();
        }, delay);
      } else {
        if (!Game.playTrick(owner, best)) refused.add(best.id);
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
