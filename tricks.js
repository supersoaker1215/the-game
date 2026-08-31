// ============================================================
// TRICK DEFINITIONS — descs follow the glossary in card-text-audit.md
// All player targeting uses promptCardChoice for manual selection.
// ============================================================
const TRICK_DEFS = [
  // Cost 0
  { name: "Space Stone", cost: 0,
    desc: "Choose a card in your hand. It can be played during the Trick Phase at its normal cost.",
    play(G, owner) {
      const hand = G.state[owner].hand.filter(c => !c.isDiscardEffect && !c.trickPhasePlayable);
      if (!hand.length) {
        G.log(`Space Stone fizzles — no eligible cards in hand!`);
        return;
      }
      const grant = (card) => {
        card.trickPhasePlayable = true;
        G.log(`Space Stone: ${card.name} can be played during the Trick Phase (costs ${card.cost} energy).`);
      };
      if (Game.isHuman(owner)) {
        G.promptCardChoice(owner, hand, "Space Stone",
          "Choose a card — it can be played during the Trick Phase (at its normal cost)",
          grant, cards => cards.sort((a, b) => (b.cost || 0) - (a.cost || 0))[0]);
      } else {
        grant(hand[0]);
      }
    }
  },
  { name: "Time Stone", cost: 0,
    anytime: true,
    unique: true, // Only 1 copy in the entire trick deck (honored by deck builder in game.js)
    reactive: true, // Not played from the trick phase — only via counter-intercept
    hostile: false, // Never triggers itself (defensive)
    // Badge only — the actual draw is fired by Game.timeStoneCounter. Tricks
    // don't run applyAbilities on their play path, so this won't double-draw.
    abilities: ["Draw 1"],
    desc: "Reaction: When an enemy plays a hostile trick, cancel it. That trick stays in their hand and cannot be played again this round.",
    // `canPlay` returns false so the player can't manually click Time Stone
    // from the tricks panel — it only ever fires via the Counter prompt
    // (Game._playerHasTimeStone + Game.timeStoneCounter). Keeps the card in
    // the trick hand, visible as an available reaction but not a proactive play.
    canPlay(G, owner) { return false; },
    play(G, owner) {
      // Real effect (consume Time Stone + block enemy trick + draw) is handled
      // by Game.timeStoneCounter via the pendingTimeStoneIntercept prompt.
      G.log("Time Stone waits — it only activates to counter an enemy trick.");
    }
  },
  // Cost 1
  { name: "Batarangs", cost: 1,
    // Text-only change: dropped the "Untrickable enemies cannot be targeted"
    // line since that's a GENERAL trick rule (all tricks are blocked by
    // Untrickable), not Batarangs-specific. Behavior is unchanged — Untrickable
    // enemies are still filtered out.
    desc: "Deal 2 damage to an enemy 2 times. Each hit can target a different enemy.",
    canPlay(G, owner) {
      return G.getEnemiesOf(owner).some(e => G.canTrickLand(e, 'damage', owner));
    },
    play(G, owner) {
      const trickable = () => G.getEnemiesOf(owner).filter(e => G.canTrickLand(e, 'damage', owner));
      const pickLow = cards => cards.slice().sort((a, b) => a.currentHealth - b.currentHealth)[0];
      // Two SEPARATE 2-damage hits — split between two enemies or double-tap one.
      const strike2 = () => {
        const pool = trickable();
        if (!pool.length) return;
        G.promptCardChoice(owner, pool, "Batarangs — Strike 2", "Deal 2 damage to which enemy?", (t) => {
          if (typeof UI !== 'undefined' && UI._fxTrickStrike) { try { UI._fxTrickStrike(t, '#cfd8e3', '#7f95ad'); } catch (e) {} }
          G.dealDamage(t, 2);
          G.log(`Batarang strike 2: hits ${t.name} for 2!`);
        }, pickLow);
      };
      const strike1 = () => {
        const pool = trickable();
        if (!pool.length) return;
        G.promptCardChoice(owner, pool, "Batarangs — Strike 1", "Deal 2 damage to which enemy?", (t) => {
          if (typeof UI !== 'undefined' && UI._fxTrickStrike) { try { UI._fxTrickStrike(t, '#cfd8e3', '#7f95ad'); } catch (e) {} }
          G.dealDamage(t, 2);
          G.log(`Batarang strike 1: hits ${t.name} for 2!`);
          strike2();
        }, pickLow);
      };
      strike1();
    }
  },
  { name: "Seismic Charge", cost: 2,
    desc: "Deal 3 damage to an enemy, 2 to enemies one lane away, and 1 to enemies two lanes away.",
    // The seismic-charge cue fires on DETONATION (inside the target callback),
    // not the instant the trick is played — so with multiple targets it lands
    // when you actually pick, in sync with the blast. deferPlaySfx tells the
    // generic playTrick sound-hook to stay quiet for this trick (see ui.js).
    deferPlaySfx: true,
    canPlay(G, owner) {
      return G.getEnemiesOf(owner).some(e => G.canTrickLand(e, 'damage', owner));
    },
    play(G, owner) {
      const pool = G.getEnemiesOf(owner).filter(e => G.canTrickLand(e, 'damage', owner));
      if (!pool.length) return;
      // BLAST FALLOFF, by distance from the epicentre. Owner: "3 damage on the
      // lane it's played on, 2 to lanes next door, 1 to lanes two away."
      // Index IS the distance, so the shape of the blast is the shape of this
      // array — adding a 4th ring later means adding a number, nothing else.
      const SEISMIC_FALLOFF = [3, 2, 1];
      // Every enemy the blast reaches, paired with what it takes. Walks outward
      // from the epicentre lane rather than reusing getAdjacentEnemiesInContext,
      // which only knows about immediate neighbours and would silently cap the
      // blast at one ring.
      const seismicTargets = (laneIdx) => {
        const opp = G.opponent(owner);
        const hits = [];
        for (let d = 0; d < SEISMIC_FALLOFF.length; d++) {
          const lanes = d === 0 ? [laneIdx] : [laneIdx - d, laneIdx + d];
          lanes.forEach(l => {
            if (l < 0 || l >= G.LANE_COUNT) return;
            const e = G.state.lanes[l][opp];
            if (e && e.currentHealth > 0) hits.push({ card: e, dmg: SEISMIC_FALLOFF[d] });
          });
        }
        return hits;
      };
      G.promptCardChoice(owner, pool, "Seismic Charge — Detonate",
        "Deal 3 damage to an enemy, 2 one lane out, 1 two lanes out",
        (t) => {
          // Detonation cue — fires now that the target is locked in.
          if (typeof UI !== 'undefined' && UI.sfx && UI.sfx.playTrickSfx) {
            try { UI.sfx.playTrickSfx('Seismic Charge', 'play'); } catch (e) {}
          }
          const lane = G.findCardLane(t);
          // Center target, then splash the enemy cards in the adjacent lanes.
          // Adjacent damage goes through dealDamage, so Damage Immunity /
          // Invincible on a neighbor still shrug it like any other splash.
          const hits = seismicTargets(lane);
          if (typeof UI !== 'undefined' && UI._fxTrickStrike) {
            try {
              hits.forEach(h => UI._fxTrickStrike(h.card, '#ffb15a', '#e0631a'));
              if (UI._screenShake) UI._screenShake('medium');
            } catch (e) {}
          }
          // Damage every ring through dealDamage, so Damage Immunity /
          // Invincible on any card in the blast shrugs it like any other hit.
          hits.forEach(h => G.dealDamage(h.card, h.dmg));
          G.log(`Seismic Charge detonates on ${t.name} — ${hits.map(h => `${h.card.name} ${h.dmg}`).join(', ')}!`);
        },
        // AI picker: detonate where it catches the most cards; tie-break on the
        // lowest-HP center so the blast is most likely to kill.
        // AI picker: detonate where the blast does the most TOTAL damage, not
        // where it merely touches the most cards — a ring-1 hit is worth twice a
        // ring-2 one now, so counting bodies would pick the wrong epicentre.
        cards => cards.slice().sort((a, b) => {
          const tot = (c) => seismicTargets(G.findCardLane(c))
            .reduce((n, h) => n + Math.min(h.dmg, h.card.currentHealth), 0);
          return (tot(b) - tot(a)) || (a.currentHealth - b.currentHealth);
        })[0]);
    }
  },
  { name: "Bat Signal", cost: 1,
    desc: "Summon a random card with cost ≤ 1. From round 4, Batman can be pulled too.",
    play(G, owner) {
      // Pull from the SHARED summon deck (95-card reference pool) rather
      // than this player's drawPile so summoned cards can duplicate
      // cards already in hand. Filter: cost ≤ 1 OR Batman, no discard-
      // effect cards. Restored balance: previously cost ≤ 2 made
      // mid-cost cards (Black Widow, Thanos's tier-2 etc.) too cheap.
      //
      // Roguelite-only: Batman is excluded from the pool. User direction:
      // "remove the spawn Darkseid and Batman from Mother Box / Bat
      // Signal only in the roguelite." Classic mode keeps the legendary
      // boss-card jackpot.
      const isRoguelite = !!(G.state.mode && G.state.mode._roguelite);
      // ROUND GATE — the boss card is a late-game jackpot, not a turn-one one.
      // Owner: "darkseid and batman can only be pulled from these cards on
      // round 4 and above."
      const bossOk = !isRoguelite && (G.state.round || 1) >= 4;
      const d = G.drawFromSummonDeck(c => !c.isDiscardEffect && (c.cost <= 1 || (bossOk && c.name === 'Batman')));
      if (d) {
        G.summonCardChoice(owner, d.name, d.cost, d.attack, d.health, d.abilities || [], null, null, d);
        G.log(`Bat Signal summons ${d.name}!`);
      }
    }
  },
  { name: "Bifrost", cost: 1,
    abilities: ["Draw 1"],
    desc: "Move an ally to another empty lane.",
    // Needs a live target — greys out in the tray + refused by playTrick otherwise.
    canPlay(G, owner) { return G.getAlliesOf(owner).some(x => G.canTrickLand(x, 'trick', owner) && !x.isFrozen && !x.isStunned) && G.getOpenLanes(owner).length > 0; },
    play(G, owner) {
      G.drawCards(owner, 1);
      const a = G.getAlliesOf(owner).filter(x => G.canTrickLand(x, 'trick', owner) && !x.isFrozen && !x.isStunned);
      const o = G.getOpenLanes(owner);
      if (a.length && o.length) {
        const doMove = (ally) => {
          const from = G.findCardLane(ally);
          if (typeof UI !== 'undefined' && UI._fxTrickBuff) { try { UI._fxTrickBuff(ally, '#7ad0ff', '#b06bff'); } catch (e) {} }
          if (Game.isHuman(owner)) {
            G.promptLaneChoice(owner, o, `Move ${ally.name}`, `Choose lane for ${ally.name}`, (l) => {
              G.moveCard(ally, from, l);
            });
          } else {
            G.moveCard(ally, from, o[0]);
          }
        };
        if (Game.isHuman(owner)) {
          G.promptCardChoice(owner, a, "Bifrost — Move", "Choose ally to move", doMove);
        } else {
          doMove(a[0]);
        }
      }
      G.log("Bifrost!");
    }
  },
  { name: "Kryptonite", cost: 1,
    desc: "Remove 3 ATK from an enemy. If the enemy is Superman, remove all his ATK.",
    // Needs a live target — greys out in the tray + refused by playTrick otherwise.
    canPlay(G, owner) { return G.getEnemiesOf(owner).some(e => G.canTrickLand(e, 'debuff', owner)); },
    play(G, owner) {
      const enemies = G.getEnemiesOf(owner).filter(e => G.canTrickLand(e, 'debuff', owner));
      if (enemies.length) {
        G.promptCardChoice(owner, enemies, "Kryptonite — Weaken", "Choose enemy to weaken", (t) => {
          const r = t.name === "Superman" ? t.attack : 3;
          if (typeof UI !== 'undefined' && UI._fxTrickDebuff) { try { UI._fxTrickDebuff(t, '#4fe07a', '#1f9a3a'); } catch (e) {} }
          G.debuffCard(t, r, 0, false, { name: 'Kryptonite' });
          G.log(`Kryptonite: ${t.name} -${r} ATK!`);
          // Threat, not raw ATK — see Game.threatOf. Weakening a feared enemy
          // stops it killing itself, which is the opposite of the point.
        }, cards => G.pickBiggestThreat(cards, owner));
      }
    }
  },
  { name: "Lasso of Truth", cost: 1,
    abilities: ["Draw 1"],
    desc: "Reveal a random card from the opponent's hand.",
    play(G, owner) {
      G.drawCards(owner, 1);
      // 2v2 has two enemies — let the caster pick whose hand to peek at.
      // 1v1 resolves instantly with the only opponent (unchanged behavior).
      G.withChosenOpponent(owner, 'Lasso of Truth — whose hand?', (opp) => {
      const h = G.state[opp].hand;
      if (!h.length) {
        G.log("Lasso of Truth: opponent's hand is empty.");
        return;
      }
      const c = h[Math.floor(G.rng() * h.length)];
      G.log(`[REVEAL] Lasso of Truth reveals from opponent's hand: ${c.name} (${c.cost} cost, ${c.attack || '?'}/${c.currentHealth || c.maxHealth || c.health || '?'})`);
      // Show the revealed card prominently to the player via the
      // pending-choice modal. Single-card "choice" — clicking
      // dismisses it.
      //
      // BUG FIX 2026-05-19: `owner` field was hardcoded 'player',
      // which in multiplayer routed the prompt to the host's UI
      // regardless of who actually played the trick. In a guest-
      // played Lasso of Truth the host got a phantom "Revealed"
      // modal pointing at a card the guest revealed from the host
      // (the host already knows what they hold) — a state mismatch
      // that desynced the two clients and could disconnect the
      // session. User report: "the Lasso of Truth is bugging out
      // the game when I play it. The game will log itself out."
      // Routing the prompt to the actual `owner` (the player who
      // played the trick) restores the canonical "reveal goes to
      // the trick caster" semantics on both sides.
      if (Game.isHuman(owner)) {
        // Routed through promptCardChoice rather than assigning
        // state.pendingCardChoice directly: the helper stamps the 2v2
        // _2v2ActingPlayer annotation, so the player who actually cast the
        // trick is the one who can dismiss the reveal. A hand-rolled prompt
        // carries no actor, and the resolve guard in cardChoicePick then lets
        // ANY client try to clear it — on a guest that only mutates their
        // display copy and the modal sticks. forcePrompt because a single
        // card would otherwise auto-resolve without ever being shown.
        G.promptCardChoice(
          owner, [c],
          'Lasso of Truth — Revealed',
          `The opponent is holding ${c.name}. Tap the card to read it.`,
          () => {}, null,
          { forcePrompt: true, inlineTray: true }
        );
      }
      });
    }
  },
  { name: "Assimilate", cost: 4,
    desc: "Copy a random card from the opponent's hand into your hand. Their card stays with them.",
    play(G, owner) {
      // 2v2 has two enemies — let the caster pick whose hand to copy from.
      // 1v1 resolves instantly with the only opponent.
      G.withChosenOpponent(owner, 'Assimilate — whose hand?', (opp) => {
        const h = G.state[opp].hand;
        if (!h.length) {
          G.log("Assimilate finds nothing to copy — the opponent's hand is empty.");
          return;
        }
        // Pick a random card. The original is untouched.
        const src = h[Math.floor(G.rng() * h.length)];
        // Build the copy from a DEF, not from the hand instance. A hand
        // instance stores health as maxHealth/currentHealth and has no
        // `.health` field, so feeding it straight to createCardInstance made
        // safeHp fall through to its "1" fallback — Knull came out 7/1. Prefer
        // the canonical CARD_DEFS entry (pristine base stats); fall back to a
        // def synthesized from the instance's base* snapshot for tokens/summons
        // not in CARD_DEFS. Using base* also means any in-hand debuff (Brainiac
        // drain, Magneto, etc.) is stripped — the copy is a clean full-health
        // version of the card.
        const canonical = (typeof CARD_DEFS !== 'undefined')
          ? CARD_DEFS.find(d => d.name === src.name) : null;
        const def = canonical || {
          name: src.name,
          cost: src.baseCost != null ? src.baseCost : src.cost,
          attack: src.baseAttack != null ? src.baseAttack : src.attack,
          health: src.baseHealth != null ? src.baseHealth : src.maxHealth,
          type: src.type,
          abilities: src.baseAbilities || src.abilities || [],
          desc: src.desc || ''
        };
        const copy = G.createCardInstance(def, owner);
        if (typeof G.applyAbilities === 'function') G.applyAbilities(copy);
        const added = (typeof G.addToHand === 'function')
          ? G.addToHand(owner, copy, null, null, 'Assimilated from the enemy hand')
          : (G.state[owner].hand.push(copy), true);
        if (added !== false) {
          G.log(`Assimilate copies ${copy.name} from the opponent's hand!`);
        }
      });
    }
  },
  { name: "Lazarus Pit", cost: 1,
    desc: "Return a random card from your Dead Pile to your hand.",
    play(G, owner) {
      const d = G.state[owner].deadPile;
      if (d.length) {
        const archived = d.splice(Math.floor(G.rng() * d.length), 1)[0];
        // The dead-pile archive stores BASE stats (`attack`, `health`,
        // `cost`) but lacks the runtime fields a playable card needs
        // (`id`, `currentHealth`, `maxHealth`, `baseAttack`, `armorValue`,
        // `evadeCharges`, all the ability-derived flags). Pushing the
        // raw archive into the hand spawned cards with `currentHealth`
        // undefined → on the next combat / damage check they read as
        // 0 HP and immediately died. User report: "cards revived from
        // lazarus pit are glitched, they can be played but kill
        // themlsleves on board."
        // Fix: rehydrate via createCardInstance (treats the archive
        // like a card def) + applyAbilities so keyword-derived flags
        // (Armor N, Evade N, Bullseye, etc.) get re-stamped on the
        // fresh instance.
        const fresh = G.createCardInstance(archived, owner);
        if (typeof G.applyAbilities === 'function') G.applyAbilities(fresh);
        if (typeof G.addToHand === 'function') G.addToHand(owner, fresh, null, null, 'Returned by Lazarus Pit');
        else G.state[owner].hand.push(fresh);
        G.log(`Lazarus Pit revives ${fresh.name} to your hand!`);
      }
    }
  },
  { name: "Mother Box", cost: 1,
    desc: "Summon a random card with cost ≤ 1. From round 4, Darkseid can be pulled too.",
    play(G, owner) {
      // Pulls from the shared summon deck. Filter: cost ≤ 1 OR Darkseid,
      // no discard-effect cards. Same scope shift as Bat Signal — was
      // cost ≤ 2 which routinely produced 2-cost cards from a 1-cost
      // trick.
      //
      // Roguelite-only: Darkseid is excluded from the pool. User
      // direction: "remove the spawn Darkseid and Batman from Mother
      // Box / Bat Signal only in the roguelite." Classic mode keeps
      // the boss-card jackpot.
      const isRoguelite = !!(G.state.mode && G.state.mode._roguelite);
      // Same round-4 gate as Bat Signal — see the note there.
      const bossOk = !isRoguelite && (G.state.round || 1) >= 4;
      const d = G.drawFromSummonDeck(c => !c.isDiscardEffect && (c.cost <= 1 || (bossOk && c.name === 'Darkseid')));
      if (d) {
        G.summonCardChoice(owner, d.name, d.cost, d.attack, d.health, d.abilities || [], null, null, d);
        G.log(`Mother Box summons ${d.name}!`);
      }
    }
  },
  { name: "Smoke Pellet", cost: 1,
    desc: "Give an ally Evade 1 and (+1/+1).",
    // Needs a live target — greys out in the tray + refused by playTrick otherwise.
    canPlay(G, owner) { return G.getAlliesOf(owner).some(x => G.canTrickLand(x, 'trick', owner)); },
    play(G, owner) {
      const a = G.getAlliesOf(owner).filter(x => G.canTrickLand(x, 'trick', owner));
      if (Game.isHuman(owner) && a.length) {
        G.promptCardChoice(owner, a, "Smoke Pellet — Buff", "Choose ally to give Evade +1/+1", (t) => {
          if (typeof UI!=='undefined'&&UI._fxTrickBuff){try{UI._fxTrickBuff(t,'#c8ccd0','#7a8088');}catch(e){}} t.evadeCharges += 1; G.buffCard(t, 1, 1);
          G.log(`Smoke Pellet buffs ${t.name}!`);
        });
      } else if (a.length) {
        const t = a.sort((x, y) => y.cost - x.cost)[0];
        if (typeof UI!=='undefined'&&UI._fxTrickBuff){try{UI._fxTrickBuff(t,'#c8ccd0','#7a8088');}catch(e){}} t.evadeCharges += 1; G.buffCard(t, 1, 1);
        G.log(`Smoke Pellet buffs ${t.name}!`);
      }
    }
  },
  // Cost 2
  { name: "Adamantium", cost: 2,
    desc: "Add (+2/+2) to an ally.",
    // Needs a live target — greys out in the tray + refused by playTrick otherwise.
    canPlay(G, owner) { return G.getAlliesOf(owner).some(x => G.canTrickLand(x, 'trick', owner)); },
    play(G, owner) {
      const a = G.getAlliesOf(owner).filter(x => G.canTrickLand(x, 'trick', owner));
      if (Game.isHuman(owner) && a.length) {
        G.promptCardChoice(owner, a, "Adamantium — Buff", "Choose ally to give +2/+2", (t) => {
          if (typeof UI!=='undefined'&&UI._fxTrickBuff){try{UI._fxTrickBuff(t,'#dfe7ee','#9fb3c8');}catch(e){}} G.buffCard(t, 2, 2); G.log(`Adamantium buffs ${t.name}!`);
        });
      } else if (a.length) {
        const t = a.sort((x, y) => y.cost - x.cost)[0];
        if (typeof UI!=='undefined'&&UI._fxTrickBuff){try{UI._fxTrickBuff(t,'#dfe7ee','#9fb3c8');}catch(e){}} G.buffCard(t, 2, 2); G.log(`Adamantium buffs ${t.name}!`);
      }
    }
  },
  { name: "Eye of Agamotto", cost: 1,
    desc: "Next draw phase: peek at the top 2 cards — keep one, the other goes to the opponent. Permanently +1 max hand size.",
    play(G, owner) {
      // Reuse the "Foresee" pipeline (handleDrStrangeReorder in game.js, triggered
      // at the start of drawPhase). Pass the source name so the prompt/log say
      // "Eye of Agamotto" instead of "Dr. Strange".
      G.state[owner].drStrangeReorder = "Eye of Agamotto";
      // 2v2: bump only the acting seat (see Mobius Chair). In 1v1, bump the
      // player proxy directly. Guard the +1 so an unset maxHandSize can't become
      // NaN (which would break the hand-full check outright).
      const eyeIn2v2 = !!(G.is2v2 && G.is2v2() && G.state.twoVTwo && G.state.twoVTwo.online);
      if (eyeIn2v2) {
        if (G._2v2BumpHandSize) G._2v2BumpHandSize();
      } else {
        const eyeCur = (typeof G.state[owner].maxHandSize === 'number' && isFinite(G.state[owner].maxHandSize))
          ? G.state[owner].maxHandSize : 7;
        G.state[owner].maxHandSize = eyeCur + 1;
      }
      // 2v2: peek the top 2 next-draw cards and hand each to a player.
      if (G._2v2QueueForesight) G._2v2QueueForesight(2, "Eye of Agamotto");
      G.log(`Eye of Agamotto opens — foresight queued for next draw phase, max hand size → ${G.state[owner].maxHandSize}.`);
    }
  },
  { name: "Mobius Chair", cost: 2,
    desc: "Your max hand size increases by 1. Look at 3 random cards from the draw pile. Add one to your hand.",
    play(G, owner) {
      // The +1 lands FIRST, and unconditionally — before the empty-pile bail
      // and before the pick. addToHand refuses at the cap and silently bins the
      // card (it only logs [HAND FULL]), so a Chair played on a full hand used
      // to show you three cards, take your pick, charge you 2 Energy and hand
      // you nothing. Raising the cap up front is what makes the card it gives
      // you actually fit.
      // 2v2: bump ONLY the acting seat (via _2v2BumpHandSize), which also mirrors
      // the raised cap onto the side proxy for this play's own scry. The direct
      // state[owner] bump below is the 1v1 path — in 2v2 it would bump the shared
      // team proxy and log "both allies … now 9" (stacking), which is exactly the
      // bug. (User: "if I play Mobius Chair only MY max hand size should increase,
      // not both allies.") Same split for Eye of Agamotto above.
      const mobiusIn2v2 = !!(G.is2v2 && G.is2v2() && G.state.twoVTwo && G.state.twoVTwo.online);
      if (mobiusIn2v2) {
        if (G._2v2BumpHandSize) G._2v2BumpHandSize();
      } else {
        const p = G.state[owner];
        if (p) {
          p.maxHandSize = (p.maxHandSize | 0) + 1;
          G.log(`Mobius Chair: ${G.seatPossessive(owner)} max hand size is now ${p.maxHandSize}.`);
        }
      }
      const pile = G.getDrawPile(owner);
      if (!pile.length) { G.log(`Mobius Chair finds nothing — draw pile empty!`); return; }
      const count = Math.min(3, pile.length);
      const indices = [];
      while (indices.length < count) {
        const r = Math.floor(G.rng() * pile.length);
        if (!indices.includes(r)) indices.push(r);
      }
      const choices = indices.map(i => pile[i]);
      G.promptCardChoice(owner, choices, "Mobius Chair — Scry", "Pick a card to add to your hand", (picked) => {
        const idx = pile.indexOf(picked);
        if (idx >= 0) pile.splice(idx, 1);
        G.addToHand(owner, G.createCardInstance(picked, owner), null, null, 'Taken with Mobius Chair');
        G.log(`Mobius Chair reveals ${choices.map(c => c.name).join(', ')} — takes ${picked.name}!`);
      }, cards => cards.sort((a, b) => (b.baseCost || b.cost) - (a.baseCost || a.cost))[0]);
    }
  },
  { name: "Power Stone", cost: 1,
    desc: "Add (+2/+0) to an ally.",
    // Needs a live target — greys out in the tray + refused by playTrick otherwise.
    canPlay(G, owner) { return G.getAlliesOf(owner).some(x => G.canTrickLand(x, 'trick', owner)); },
    play(G, owner) {
      const a = G.getAlliesOf(owner).filter(x => G.canTrickLand(x, 'trick', owner));
      if (Game.isHuman(owner) && a.length) {
        G.promptCardChoice(owner, a, "Power Stone — Empower", "Choose ally to give +2 ATK", (t) => {
          if (typeof UI!=='undefined'&&UI._fxTrickBuff){try{UI._fxTrickBuff(t,'#c07bff','#7a2ec8');}catch(e){}} G.buffCard(t, 2, 0); G.log(`Power Stone: ${t.name} +2 ATK!`);
        });
      } else if (a.length) {
        const t = a.sort((x, y) => y.cost - x.cost)[0];
        if (typeof UI!=='undefined'&&UI._fxTrickBuff){try{UI._fxTrickBuff(t,'#c07bff','#7a2ec8');}catch(e){}} G.buffCard(t, 2, 0); G.log(`Power Stone: ${t.name} +2 ATK!`);
      }
    }
  },
  { name: "The Darkhold", cost: 2,
    desc: "Destroy all enemies with ≤ 2 ATK.",
    // Needs a live target — greys out in the tray + refused by playTrick otherwise.
    canPlay(G, owner) { return G.getEnemiesOf(owner).some(e => (e.attack || 0) <= 2 && G.canTrickLand(e, 'destroy', owner)); },
    play(G, owner) {
      G.getEnemiesOf(owner).filter(e => e.attack <= 2 && G.canTrickLand(e, 'destroy', owner)).forEach(t => {
        if (typeof UI!=='undefined'&&UI._fxTrickBurst){try{UI._fxTrickBurst(t,'#7a1020','#ff3b5a');}catch(e){}} G.log(`Darkhold destroys ${t.name}!`); G.killCard(t);
      });
    }
  },
  { name: "Two-Face Coin", cost: 2,
    desc: "Add a random 1-8 to your Block Meter.",
    play(G, owner) {
      const roll = 1 + Math.floor(G.rng() * 8);
      G.state[owner].blockMeter = Math.min(Game.BLOCK_MAX, G.state[owner].blockMeter + roll);
      G.log(`Two-Face Coin rolls ${roll}! Block Meter +${roll} → ${G.state[owner].blockMeter}`);
    }
  },
  { name: "Vibranium", cost: 2,
    desc: "Add (+1/+1) to all allies.",
    // Needs a live target — greys out in the tray + refused by playTrick otherwise.
    canPlay(G, owner) { return G.getAlliesOf(owner).some(x => G.canTrickLand(x, 'trick', owner)); },
    play(G, owner) {
      G.getAlliesOf(owner).filter(x => G.canTrickLand(x, 'trick', owner)).forEach(a => { if (typeof UI!=='undefined'&&UI._fxTrickBuff){try{UI._fxTrickBuff(a,'#8fe6ff','#2f9fd6');}catch(e){}} G.buffCard(a, 1, 1); });
      G.log("Vibranium +1/+1 all allies!");
    }
  },
  // Cost 3
  { name: "Fear Toxin", cost: 2,
    abilities: ["Unresistible 1"],
    desc: "Fear 1 an enemy.",
    canPlay(G, owner) { return G.getEnemiesOf(owner).some(e => G.canTrickLand(e, 'trick', owner)); },
    play(G, owner) {
      // Kind 'trick' ONLY — Fear Toxin's Unresistible source pierces Immunity
      // and fear ignores Invincible, so 'debuff' would hide legal targets.
      const enemies = G.getEnemiesOf(owner).filter(e => G.canTrickLand(e, 'trick', owner));
      if (enemies.length) {
        // Synthetic Unresistible source — bypasses Immunity once via the central debuff handler.
        const source = { name: 'Fear Toxin', unresistibleCharges: 1 };
        G.promptCardChoice(owner, enemies, "Fear Toxin — Fear", "Choose enemy to fear", (t) => {
          if (typeof UI !== 'undefined' && UI._fxFearGas) { try { UI._fxFearGas(t); } catch (e) {} }
          G.fearCard(t, source); G.log(`Fear Toxin terrifies ${t.name}!`);
        }, cards => G.pickBiggestThreat(cards, owner));
      }
    }
  },
  { name: "Nth Metal", cost: 2,
    desc: "Give an ally Invincible 1.",
    // Needs a live target — greys out in the tray + refused by playTrick otherwise.
    canPlay(G, owner) { return G.getAlliesOf(owner).some(x => G.canTrickLand(x, 'trick', owner)); },
    play(G, owner) {
      const a = G.getAlliesOf(owner).filter(x => G.canTrickLand(x, 'trick', owner));
      if (Game.isHuman(owner) && a.length) {
        G.promptCardChoice(owner, a, "Nth Metal — Invincible", "Choose ally to make invincible", (t) => {
          if (typeof UI!=='undefined'&&UI._fxTrickBuff){try{UI._fxTrickBuff(t,'#ffe07a','#c8962e');}catch(e){}} t.invincibleTurns += 1; G.log(`Nth Metal: ${t.name} invincible!`);
        });
      } else if (a.length) {
        const t = a.sort((x, y) => y.cost - x.cost)[0];
        if (typeof UI!=='undefined'&&UI._fxTrickBuff){try{UI._fxTrickBuff(t,'#ffe07a','#c8962e');}catch(e){}} t.invincibleTurns += 1; G.log(`Nth Metal: ${t.name} invincible!`);
      }
    }
  },
  { name: "Bacta Tank", cost: 2,
    desc: "Fully heal an ally to max HP. It takes no damage for the rest of this round.",
    // Needs a live ally — greys out in the tray + refused by playTrick otherwise.
    canPlay(G, owner) { return G.getAlliesOf(owner).some(x => G.canTrickLand(x, 'trick', owner)); },
    play(G, owner) {
      const a = G.getAlliesOf(owner).filter(x => G.canTrickLand(x, 'trick', owner));
      if (!a.length) return;
      const submerge = (t) => {
        if (typeof UI !== 'undefined' && UI._fxTrickBuff) { try { UI._fxTrickBuff(t, '#5affc8', '#1fbf7a'); } catch (e) {} }
        t.currentHealth = t.maxHealth;
        // Damage Immunity for the REST of this round. grantTempBuff(duration 1)
        // sets the flag now and reverts it at postCombat's expireGrantedBuffs,
        // so it shields through this round's combat and then clears.
        G.grantTempBuff(t, { hasDamageImmunity: true }, 1);
        G.log(`Bacta Tank: ${t.name} is fully healed and takes no damage this round!`);
      };
      // AI picks the most-wounded ally (falls back to the highest-cost body).
      const pickBest = cards => cards.slice().sort((x, y) =>
        ((y.maxHealth - y.currentHealth) - (x.maxHealth - x.currentHealth)) || (y.cost - x.cost))[0];
      if (Game.isHuman(owner)) {
        G.promptCardChoice(owner, a, "Bacta Tank — Submerge",
          "Choose an ally to fully heal and shield this round", submerge, pickBest);
      } else {
        submerge(pickBest(a));
      }
    }
  },
  { name: "Super Soldier Serum", cost: 3,
    desc: "Transform an ally into a random card that costs exactly 1 more.",
    // The "leap" — transforming the ally always produces a card that
    // costs EXACTLY ONE MORE than the picked ally. User refinement:
    // "It can only upgrade the card one cost. So if you have a 1-cost
    // card it can only go to a 2. If you have a 7-cost it can only go
    // to an 8. So you can't get a 1-cost and turn it into Batman."
    // Tradeoff curve is now clean and predictable:
    //   • 1 → 2-cost,  2 → 3-cost,  ..., 8 → 9-cost,  9 → 10-cost
    // The 9-cost case is still the killshot (only 10-cost bosses
    // qualify) but reaching it requires actually placing a 9-cost
    // ally first — no more turn-3 Batman from a 1-drop.
    //
    // Implementation:
    //   • Ally must have cost ≤ 9 (10-cost can't upgrade further).
    //   • Cost-comparison uses BASE cost so buffs/discounts can't
    //     game the math (e.g. a Captain America–discounted card still
    //     leaps from its true base cost).
    canPlay(G, owner) {
      const allAllies = G.getAlliesOf(owner).filter(a => (a.baseCost || a.cost || 0) <= 9 && G.canTrickLand(a, 'trick', owner));
      return allAllies.length > 0;
    },
    play(G, owner) {
      const allAllies = G.getAlliesOf(owner).filter(a => (a.baseCost || a.cost || 0) <= 9 && G.canTrickLand(a, 'trick', owner));
      if (!allAllies.length) return;
      // Player picks the ally FIRST so the leap target's tier is known
      // before we sample. The prompt then narrates "Spider-Man (4) →
      // 5-cost upgrade" so the player can plan around the result tier.
      G.promptCardChoice(owner, allAllies,
        "Super Soldier Serum — Leap +1",
        "Choose an ally to transform into a card that costs exactly +1 more.",
        (t) => {
          const baseCost = t.baseCost || t.cost || 0;
          const targetCost = baseCost + 1;
          // Predicate: cost EXACTLY one more, no discard-effect cards.
          // The cost === targetCost equality is the difference between
          // the old "anything higher" exploit and the new ladder rule.
          const d = G.drawFromSummonDeck(c => !c.isDiscardEffect && (c.cost || 0) === targetCost);
          if (!d) {
            G.log(`Super Soldier Serum: no ${targetCost}-cost cards available to leap into.`);
            return;
          }
          const l = G.findCardLane(t);
          if (typeof UI !== 'undefined' && UI._fxTrickBuff) { try { UI._fxTrickBuff(t, '#ff6b6b', '#c81e1e'); } catch (e) {} }
          G.killCardSilent(t);
          G.summonCard(owner, l, d.name, d.cost, d.attack, d.health, d.abilities || [], d);
          G.log(`Serum LEAPS ${t.name} (${baseCost}-cost) → ${d.name} (${targetCost}-cost)!`);
        },
        // AI fallback picker: prefer the highest-cost ally so the leap's
        // result tier is the strongest possible. A 9-cost ally beats a
        // 1-cost ally because the 9→10 leap is the most valuable.
        cards => cards.sort((x, y) => (y.baseCost || y.cost || 0) - (x.baseCost || x.cost || 0))[0]
      );
    }
  },
  { name: "Pym Particles", cost: 2,
    // Time Stone reads this flag FIRST. Pym Particles takes (−2/−2) off one of
    // your cards and can destroy it outright, which is about as hostile as a
    // trick gets — but it was missing from the hardcoded name list in
    // _isHostileTrick, so the counter was never offered. Owner: "time stone did
    // not block pym particles or kryptonite".
    hostile: true,
    desc: "Remove (−2/−2) from an enemy. This can destroy it.",
    canPlay(G, owner) { return G.getEnemiesOf(owner).some(e => G.canTrickLand(e, 'debuff', owner)); },
    play(G, owner) {
      const enemies = G.getEnemiesOf(owner).filter(e => G.canTrickLand(e, 'debuff', owner));
      if (!enemies.length) return;
      G.promptCardChoice(owner, enemies, "Pym Particles — Shrink", "Choose an enemy to shrink", (t) => {
        // allowKill=true — shrinking a ≤3-HP enemy destroys it outright.
        // Without the flag, debuffCard floors HP at 1 (user: "Pym Particles
        // can kill an enemy; right now it leaves it at 1 health").
        if (typeof UI !== 'undefined' && UI._fxTrickDebuff) { try { UI._fxTrickDebuff(t, '#ff9a3a', '#c8501a'); } catch (e) {} }
        G.debuffCard(t, 2, 2, true, { name: 'Pym Particles' });
        if (t.currentHealth <= 0) G.log(`Pym Particles: ${t.name} shrinks into nothing — destroyed!`);
        else G.log(`Pym Particles: ${t.name} shrunk to ${t.attack}/${t.currentHealth}!`);
      }, cards => cards.sort((a, b) => (b.attack + b.maxHealth) - (a.attack + a.maxHealth))[0]);
    }
  },
  // Cost 4
  { name: "Phantom Zone", cost: 3,
    desc: "Return an enemy to their hand at base stats. If their hand is full, it is lost.",
    // Needs a live target — greys out in the tray + refused by playTrick otherwise.
    canPlay(G, owner) { return G.getEnemiesOf(owner).some(e => G.canTrickLand(e, 'trick', owner)); },
    play(G, owner) {
      const enemies = G.getEnemiesOf(owner).filter(e => G.canTrickLand(e, 'trick', owner));
      if (enemies.length) {
        G.promptCardChoice(owner, enemies, "Phantom Zone — Bounce", "Choose enemy to bounce back to hand", (t) => {
          const l = G.findCardLane(t);
          if (typeof UI !== 'undefined' && UI._fxTrickBurst) { try { UI._fxTrickBurst(t, '#4a6bff', '#bcd0ff'); } catch (e) {} }
          G.removeFromLane(t, l);
          // Create a fresh instance so the bounced card returns to hand at
          // base stats — no accumulated buffs, debuffs, or status effects.
          const def = CARD_DEFS.find(d => d.name === t.name) || t;
          const fresh = G.createCardInstance(def, t.owner);
          // Route through addToHand so the hand-size cap (maxHandSize=7)
          // is honored. Previously a direct push let Phantom Zone push
          // a hand to 8 — caught by the sim/test.js invariant sweep.
          // If the target's hand is full, addToHand logs and returns
          // false; the card is lost (same semantics as any cap-hit).
          // 2v2: return the card to its EXACT owner seat (the player who
          // played it), not just their team's side proxy — briefly point the
          // hand-router at that seat while addToHand runs, then restore.
          const _dpTt = G.state.twoVTwo, _savedActor = G._2v2CurrentActingPlayer;
          if (_dpTt && _dpTt.online && t._2v2PlayedBy && _dpTt.players[t._2v2PlayedBy]) {
            G._2v2CurrentActingPlayer = t._2v2PlayedBy;
          }
          G.addToHand(t.owner, fresh, null, null, 'Bounced by Phantom Zone');
          if (_dpTt && _dpTt.online) G._2v2CurrentActingPlayer = _savedActor;
          G.log(`Phantom Zone bounces ${t.name}!`);
        }, cards => cards.sort((a, b) => b.cost - a.cost)[0]);
      }
    }
  },
  { name: "Power Battery", cost: 4,
    desc: "Add 2 Energy for next turn.",
    play(G, owner) { G.addNextTurnCurrency(owner, 2); G.log("Power Battery: +2 next turn!"); }
  },
  { name: "Soul Stone", cost: 3,
    desc: "Destroy an ally and an enemy within 4 base cost of it.",
    // Needs a live target — greys out in the tray + refused by playTrick otherwise.
    canPlay(G, owner) { const allies = G.getAlliesOf(owner).filter(a => G.canTrickLand(a, 'destroy', owner)), enemies = G.getEnemiesOf(owner).filter(e => G.canTrickLand(e, 'destroy', owner)); return allies.some(a => enemies.some(e => Math.abs((a.baseCost || a.cost || 0) - (e.baseCost || e.cost || 0)) <= 4)); },
    play(G, owner) {
      const allies = G.getAlliesOf(owner).filter(a => G.canTrickLand(a, 'destroy', owner) && G.getEnemiesOf(owner).some(e => G.canTrickLand(e, 'destroy', owner) && Math.abs((e.baseCost || e.cost || 0) - (a.baseCost || a.cost || 0)) <= 4));
      if (allies.length) {
        const doSoulStone = (al) => {
          const baseCostAl = al.baseCost || al.cost;
          const enemies = G.getEnemiesOf(owner).filter(e => G.canTrickLand(e, 'destroy', owner) && Math.abs((e.baseCost || e.cost) - baseCostAl) <= 4);
          if (enemies.length) {
            G.promptCardChoice(owner, enemies, "Soul Stone — Destroy Enemy", `Choose enemy within 4 base cost of ${al.name} (cost ${baseCostAl})`, (en) => {
              G.log(`Soul Stone: ${al.name} + ${en.name}!`);
              if (typeof UI !== 'undefined' && UI._fxTrickBurst) { try { UI._fxTrickBurst(al, '#e8801a', '#ffd9a0'); UI._fxTrickBurst(en, '#e8801a', '#ffd9a0'); } catch (e) {} }
              G.killCard(al); G.killCard(en);
            }, cards => cards.sort((x, y) => y.cost - x.cost)[0]);
          }
        };
        if (Game.isHuman(owner)) {
          G.promptCardChoice(owner, allies, "Soul Stone — Choose Your Card", "Choose your card to sacrifice", doSoulStone);
        } else {
          // THE AI USED TO SACRIFICE allies[0] — the first eligible ally in LANE
          // ORDER, with no evaluation of any kind. In a real 2v2 that was the one
          // body standing in front of a 15-ATK Doomsday, and throwing it away to
          // kill a Hulk opened the lane that lost the match on the same swing.
          // (Owner: "he gets soul stone kills my omni man for the hulk, doomsday
          // with 15 attack is uncontested and hits us for the win — literally the
          // worst possible plays.")
          //
          // A sacrifice costs more than the body. What it really costs is the
          // body PLUS whatever that body was holding back: an ally facing a big
          // attacker is a wall, and removing it hands the enemy a free swing at
          // the team. Weighted x2 so a wall is never traded for stats, and
          // ranked ascending so the cheapest thing to lose goes first. Ties go
          // to whichever sacrifice kills the bigger enemy.
          //
          // Note this reads the ALLY's lane from the shared board, so in 2v2 it
          // protects a TEAMMATE's blocker exactly as it protects its own — the
          // whole team's cards are allies here, which is the case that broke.
          const _oppSide = G.opponent(owner);
          const _bestEnemyFor = (a) => {
            const bc = a.baseCost || a.cost || 0;
            return G.getEnemiesOf(owner)
              .filter(e => G.canTrickLand(e, 'destroy', owner)
                        && Math.abs((e.baseCost || e.cost || 0) - bc) <= 4)
              .sort((x, y) => ((y.attack || 0) + (y.currentHealth || 0))
                            - ((x.attack || 0) + (x.currentHealth || 0)))[0] || null;
          };
          const _costOfLosing = (a) => {
            const lane = G.findCardLane(a);
            const facing = lane >= 0 && G.state.lanes[lane] ? G.state.lanes[lane][_oppSide] : null;
            const shielding = (facing && facing.currentHealth > 0) ? (facing.attack || 0) : 0;
            return (a.attack || 0) + (a.currentHealth || 0) + shielding * 2;
          };
          const _ranked = allies.slice().sort((a, b) => {
            const d = _costOfLosing(a) - _costOfLosing(b);
            if (d !== 0) return d;
            const ea = _bestEnemyFor(a), eb = _bestEnemyFor(b);
            const va = ea ? (ea.attack || 0) + (ea.currentHealth || 0) : 0;
            const vb = eb ? (eb.attack || 0) + (eb.currentHealth || 0) : 0;
            return vb - va;
          });
          doSoulStone(_ranked[0]);
        }
      }
    }
  },
  // Cost 5
  { name: "Anti-Life Equation", cost: 4,
    desc: "Destroy both cards in a contested lane and collapse it into the void for 2 rounds. Only lanes where both cards can be destroyed may be chosen.",
    play(G, owner) {
      const opp = G.opponent(owner);
      const contested = [];
      for (let i = 0; i < Game.LANE_COUNT; i++) {
        const mine = G.state.lanes[i][owner];
        const theirs = G.state.lanes[i][opp];
        if (mine && theirs && !G.state.lanes[i].destroyed) {
          // Only offer lanes where BOTH cards will actually die — any
          // survivor would be left standing inside the collapsed void
          // (user report: Invincible Spider-Man stranded in a voided lane).
          //   • 10-cost titans: immune to all tricks.
          //   • Invincible: killCard refuses ("that character can't die").
          //   • ENEMY Untrickable: blocks the kill (own-side Untrickable
          //     dies fine — friendly tricks are exempt).
          const survives = !G.canTrickLand(mine, 'destroy', owner) || !G.canTrickLand(theirs, 'destroy', owner);
          if (!survives) contested.push(i);
        }
      }
      const collapse = (i) => {
        // Collapse first so Jason's allyDied trigger sees lane.destroyed = true
        if (typeof UI !== 'undefined' && UI._fxTrickBurst) { try { UI._fxTrickBurst(G.state.lanes[i][owner], '#7a1a9a', '#e0a0ff'); UI._fxTrickBurst(G.state.lanes[i][opp], '#7a1a9a', '#e0a0ff'); } catch (e) {} }
        G.destroyLane(i, 2);
        G.killCard(G.state.lanes[i][owner]);
        G.killCard(G.state.lanes[i][opp]);
        // One-shot death saves can leave a card alive inside the collapsed
        // lane; throw survivors clear. Shared with Darkseid via the helper.
        G.evictVoidSurvivors(i);
        G.log(`Anti-Life destroys lane ${i + 1}!`);
      };
      if (Game.isHuman(owner) && contested.length) {
        G.promptLaneChoice(owner, contested, "Anti-Life — Destroy Lane", "Choose contested lane to destroy", collapse);
      } else if (contested.length) {
        collapse(contested[0]);
      }
    }
  },
  { name: "Mind Stone", cost: 4,
    abilities: ["Unresistible 1"],
    desc: "Mind Control 1 an enemy.",
    canPlay(G, owner) { return G.getEnemiesOf(owner).some(e => G.canTrickLand(e, 'trick', owner)); },
    play(G, owner) {
      // Kind 'trick' ONLY — Mind Stone's Unresistible source pierces Immunity,
      // so 'debuff' would hide targets it can actually control.
      const enemies = G.getEnemiesOf(owner).filter(e => G.canTrickLand(e, 'trick', owner));
      if (enemies.length) {
        // Synthetic Unresistible source — routes through tryApplyDebuff so Immunity is
        // bypassed (consuming one charge on each side) rather than blocking the effect.
        const source = { name: 'Mind Stone', unresistibleCharges: 1 };
        G.promptCardChoice(owner, enemies, "Mind Stone — Control", "Choose enemy to mind control", (t) => {
          G.tryApplyDebuff(source, t, 'Mind Control', () => {
            t.isMindControlled = true;
            // Route the combat target prompt to the seat that played Mind Stone
            // (2v2 online) — see Game._stampMcSeat / getMindControlTarget.
            if (G._stampMcSeat) G._stampMcSeat(t, source);
            if (typeof UI !== 'undefined' && UI._fxTrickDebuff) { try { UI._fxTrickDebuff(t, '#f1c40f', '#b8860b'); } catch (e) {} }
            G.log(`Mind Stone controls ${t.name}!`);
          });
          // `cards[0]` — the first enemy in BOARD ORDER, with no evaluation of
          // any kind. On the reported board that was Optimus Prime in lane 7,
          // while a Michael Myers stood uncontested in lane 8 with lethal on the
          // team. Controlling him is the whole point of the card: the swing
          // never lands. Threat ranks lethal above everything, so it is taken.
        }, cards => G.pickBiggestThreat(cards, owner));
      }
    }
  },
  { name: "Reality Stone", cost: 3,
    desc: "Permanently swap an ally's ATK and HP with an enemy's.",
    // Needs a live target — greys out in the tray + refused by playTrick otherwise.
    canPlay(G, owner) { return G.getAlliesOf(owner).some(a => G.canTrickLand(a, 'trick', owner)) && G.getEnemiesOf(owner).some(e => G.canTrickLand(e, 'debuff', owner)); },
    play(G, owner) {
      const allies = G.getAlliesOf(owner).filter(a => G.canTrickLand(a, 'trick', owner));
      if (allies.length) {
        const doSwap = (al) => {
          const enemies = G.getEnemiesOf(owner).filter(e => G.canTrickLand(e, 'debuff', owner));
          if (enemies.length) {
            G.promptCardChoice(owner, enemies, "Reality Stone — Swap With", "Choose enemy to swap stats with", (en) => {
              const ta = al.attack, th = al.currentHealth;
              al.attack = en.attack; al.currentHealth = en.currentHealth; al.maxHealth = en.currentHealth;
              en.attack = ta; en.currentHealth = th; en.maxHealth = th;
              // Make the swap PERMANENT: update baseAttack/baseHealth so
              // any system that reads "natural" stats sees the new values,
              // and scrub the transient revert flags (Gojo's onEndOfTurn
              // attack-restore, granted-buff attack/maxHealth entries)
              // on BOTH cards so nothing resets the swap next turn.
              al.baseAttack = al.attack; al.baseHealth = al.currentHealth;
              en.baseAttack = en.attack; en.baseHealth = en.currentHealth;
              [al, en].forEach(c => {
                delete c._gojoAttackZeroed;
                delete c._gojoZeroedBy;
                delete c._obiWanAttackZeroed;
                if (Array.isArray(c._grantedBuffs)) {
                  c._grantedBuffs = c._grantedBuffs.filter(b =>
                    b.prop !== 'attack' && b.prop !== 'currentHealth' && b.prop !== 'maxHealth'
                  );
                }
              });
              if (typeof UI !== 'undefined' && UI._fxTrickStrike) { try { UI._fxTrickStrike(al, '#ff2d55', '#a00d2a'); UI._fxTrickStrike(en, '#ff2d55', '#a00d2a'); } catch (e) {} }
              G.log(`Reality Stone permanently swaps ${al.name} and ${en.name}!`);
            }, cards => cards.sort((a, b) => b.attack - a.attack)[0]);
          }
        };
        if (Game.isHuman(owner)) {
          G.promptCardChoice(owner, allies, "Reality Stone — Choose Your Card", "Choose your card to swap stats", doSwap);
        } else {
          doSwap(allies.sort((a, b) => a.attack - b.attack)[0]);
        }
      }
    }
  },
  // Cost 5
  { name: "Joker's Playing Card", cost: 4,
    // Deals no damage, but shuts your uncontested attackers out of a whole
    // round — squarely "negatively affects your cards", which is the stated
    // bar for a Time Stone counter.
    hostile: true,
    desc: "Choose 3 lanes. Uncontested enemies in those lanes cannot attack this round.",
    play(G, owner) {
      const PICKS = 3;
      const opp = G.opponent(owner);
      // Any lane that still exists is pickable. Deliberately NOT filtered to
      // lanes that currently hold an uncontested enemy: the protection is
      // checked at combat, and the board can change between playing this and
      // combat resolving, so pre-filtering would quietly remove lanes that turn
      // out to matter.
      const eligible = () => {
        const out = [];
        for (let i = 0; i < Game.LANE_COUNT; i++) {
          const ln = G.state.lanes[i];
          if (ln && !ln.destroyed && ln.protected !== owner) out.push(i);
        }
        return out;
      };
      const claim = (i) => {
        G.state.lanes[i].protected = owner;
        const foe = G.state.lanes[i] && G.state.lanes[i][opp];
        if (foe && foe.currentHealth > 0 && typeof UI !== 'undefined' && UI._fxTrickDebuff) { try { UI._fxTrickDebuff(foe, '#39ff5e', '#0f8a2a'); } catch (e) {} }
      };

      if (!Game.isHuman(owner)) {
        // Protect where it actually saves face damage first: a lane holding an
        // uncontested enemy is a swing straight at the hero. Highest attack
        // first, then anything else to fill the three.
        const pool = eligible();
        const threat = pool.filter(i => {
          const e = G.state.lanes[i][opp];
          return e && e.currentHealth > 0 && !G.state.lanes[i][owner];
        }).sort((a, b) => (G.state.lanes[b][opp].attack || 0) - (G.state.lanes[a][opp].attack || 0));
        const rest = pool.filter(i => threat.indexOf(i) < 0);
        const chosen = threat.concat(rest).slice(0, PICKS);
        chosen.forEach(claim);
        G.log(`Joker's Card protects lanes ${chosen.map(i => i + 1).join(', ')}!`);
        return;
      }

      // Human: one lane at a time, the same recursive-prompt idiom the other
      // PICK-N abilities use. `forced` auto-resolves the tail when exactly as
      // many lanes remain as picks, so the last prompt never asks a question
      // with one answer.
      const chosen = [];
      const step = () => {
        if (chosen.length >= PICKS) {
          G.log(`Joker's Card protects lanes ${chosen.map(i => i + 1).join(', ')}!`);
          return;
        }
        const open = eligible();
        if (!open.length) {
          if (chosen.length) G.log(`Joker's Card protects lanes ${chosen.map(i => i + 1).join(', ')}!`);
          else G.log(`Joker's Card finds no lanes to protect.`);
          return;
        }
        G.promptLaneChoice(owner, open,
          "Joker's Playing Card",
          `Choose lane ${chosen.length + 1} of ${PICKS} to protect`,
          (l) => { claim(l); chosen.push(l); step(); },
          owner, null, null,
          { forced: open.length <= (PICKS - chosen.length) });
      };
      step();
    }
  }
];


// ============================================================
// MC BALLYHOO'S CANDIES
// ============================================================
// Four one-shot tricks handed out by MC Ballyhoo, who is not a card: he is a
// round-start EVENT (see Game._maybeBallyhoo). Every match he turns up once, at
// an unpredictable round, and gives every player at the table one candy — a
// different one each, dealt at random from these four. (He was a coin flip when
// this was written; _BALLYHOO_MATCH_CHANCE is the one number that decides it.)
//
// DELIBERATELY NOT IN TRICK_DEFS. Four separate places build a trick pool
// straight off that array (the 1v1 shared pile, the deckbuilder piles, the 2v2
// deal and the 2v2 draft) and none of them filter, so anything living there is
// draftable and drawable. Candies must only ever arrive from Ballyhoo's hand,
// so they live in their own table and nothing that reads TRICK_DEFS can see
// them. Multiplayer._rehydrateState looks them up here as well, so a candy
// still comes back with its `play` function after crossing the wire.
//
// Cost 0: they are a gift, not a purchase, and the player already paid for
// them by being at the table when Ballyhoo showed up.
const CANDY_DEFS = [
  {
    name: "Twice Candy", cost: 0, _isCandy: true,
    desc: "Give an ally Overdrive and +2/+2 for 1 turn.",
    canPlay(G, owner) { return G.getAlliesOf(owner).length > 0; },
    play(G, owner) {
      const allies = G.getAlliesOf(owner).filter(a => a.currentHealth > 0);
      if (!allies.length) { G.log('Twice Candy: no ally to feed it to.'); return; }
      G.promptCardChoice(owner, allies, "Twice Candy — Sugar Rush",
        "Choose an ally to gain Overdrive and +2/+2 for a turn",
        (t) => {
          if (!t) return;
          if (typeof UI !== 'undefined' && UI._fxCandyTwice) { try { UI._fxCandyTwice(t); } catch (e) {} }
          // ONE TURN, per the house rule: a buff granted to ANOTHER card with
          // no stated duration lasts a turn. grantTempBuff takes the numeric
          // props additively and the boolean set-and-revert, so Overdrive
          // arrives and leaves with the stats rather than sticking forever.
          G.grantTempBuff(t, { attack: 2, currentHealth: 2, maxHealth: 2, isOverdrive: true }, 1,
            { name: 'Twice Candy' });
          G.log(`Twice Candy: ${t.name} gains Overdrive and +2/+2 for a turn!`);
        },
        // AI: the biggest attacker gets the most out of Overdrive, since it
        // only pays out when the card kills.
        cards => cards.slice().sort((a, b) => (b.attack | 0) - (a.attack | 0))[0]);
    }
  },
  {
    name: "Cashzap Candy", cost: 0, _isCandy: true,
    desc: "Steal 1 Energy from every other player — they each start next round with 1 less, and you start with that much more.",
    play(G, owner) {
      if (typeof UI !== 'undefined' && UI._fxCandyCash) { try { UI._fxCandyCash(null); } catch (e) {} }
      const tt = G.state.twoVTwo;
      // 2v2 keeps energy on the SEAT, not on the side proxy, so a side-level
      // spend would take it from whichever teammate the bridge happens to be
      // pointing at. Walk the seats instead.
      //
      // "Every other player" INCLUDES YOUR TEAMMATE, confirmed by the owner
      // after playtesting — so in a 2v2 room the caster takes 3 and their own
      // partner is down 1. That is the card working as written, not a bug to
      // be tidied up later: it is a free candy nobody paid for, and the cost of
      // taking it is that your partner feels it too.
      //
      // THE THEFT HAS TO SURVIVE THE ROUND. It used to take energy by bumping
      // the victims' usedEnergy and adding to the caster's energy — and the top
      // of every round runs `p.energy = energy + bonus; p.usedEnergy = 0`, which
      // wipes BOTH. Unless the caster still had plays left in that same round,
      // the candy did nothing anybody could see: no one lost anything and the
      // caster never got to spend the gain. (Owner: "my teamate played the
      // cashzap candy and all 3 players never lost an energy for the next turn
      // and he never gained 3".) nextTurnCurrency is the bucket the round start
      // ADDS to rather than overwrites — the same one Power Battery and Green
      // Lantern bank into — so the steal lands where it is actually felt.
      //
      // tt.players and not tt.online: gated on the network it was completely
      // inert in LOCAL 2v2, falling through to the 1v1 branch below and moving
      // side currency that no seat ever reads.
      if (tt && tt.players) {
        const caster = (G._2v2AbilityOwner && G._2v2AbilityOwner())
          || (G._2v2SeatOfPlay ? G._2v2SeatOfPlay(null) : null)
          || G._2v2CurrentActingPlayer || null;
        let taken = 0;
        (G._2v2SLOTS || ['p1', 'p2', 'p3', 'p4']).forEach(pk => {
          const p = tt.players[pk];
          if (!p || pk === caster) return;
          p.nextTurnCurrency = (p.nextTurnCurrency | 0) - 1;
          taken++;
        });
        const mine = caster && tt.players[caster];
        if (mine && taken) mine.nextTurnCurrency = (mine.nextTurnCurrency | 0) + taken;
        G.log(`Cashzap Candy: stole ${taken} Energy — each of them starts next round 1 down, the thief starts ${taken} up.`);
        return;
      }
      // 1v1 banks the same way — startRound adds nextTurnCurrency into the
      // round's grant, so a negative value is a real deduction next round.
      const opp = G.opponent(owner);
      G.state[opp].nextTurnCurrency = (G.state[opp].nextTurnCurrency | 0) - 1;
      G.state[owner].nextTurnCurrency = (G.state[owner].nextTurnCurrency | 0) + 1;
      G.log('Cashzap Candy: stole 1 Energy — they start next round 1 down, you start 1 up.');
    }
  },
  {
    name: "Vampire Candy", cost: 0, _isCandy: true,
    desc: "Steal 5 health from the enemy team. It cannot reduce them below 1.",
    play(G, owner) {
      const opp = G.opponent(owner);
      // FLOORED, NOT SKIPPED. "Can't kill the enemy team" has to clamp the
      // amount — refusing the whole effect when they are under 5 would make
      // the candy do nothing precisely when it matters most.
      const theirHp = G.state[opp].health | 0;
      const drain = Math.max(0, Math.min(5, theirHp - 1));
      if (drain <= 0) {
        G.log('Vampire Candy: the enemy team is already down to 1 — nothing left to drain.');
        return;
      }
      if (typeof UI !== 'undefined' && UI._fxCandyVampire) { try { UI._fxCandyVampire(); } catch (e) {} }
      // Straight through damagePlayer/healPlayer so block meters, damage
      // tracking and the 2v2 team read-back all behave as they do for any
      // other hit. You gain exactly what they lost.
      G.damagePlayer(opp, drain, false, { name: 'Vampire Candy' });
      G.healPlayer(owner, drain, { name: 'Vampire Candy' });
      G.log(`Vampire Candy: drained ${drain} health from the enemy team!`);
    }
  },
  {
    name: "Bloway Candy", cost: 0, _isCandy: true,
    desc: "Bounce a RANDOM enemy card. If it is played again, its abilities do not fire.",
    canPlay(G, owner) { return G.getEnemiesOf(owner).some(e => G.canTrickLand(e, 'trick', owner)); },
    play(G, owner) {
      const enemies = G.getEnemiesOf(owner).filter(e => G.canTrickLand(e, 'trick', owner));
      if (!enemies.length) { G.log('Bloway Candy: no enemy on the board to blow away.'); return; }
      // RANDOM, not chosen — through G.rng so a seeded run stays reproducible.
      const t = enemies[Math.floor(G.rng() * enemies.length)];
      const l = G.findCardLane(t);
      // Fired BEFORE removeFromLane, or there is no card element left to blow.
      if (typeof UI !== 'undefined' && UI._fxCandyBloway) { try { UI._fxCandyBloway(t); } catch (e) {} }
      G.removeFromLane(t, l);
      // Fresh instance at base stats, exactly as Phantom Zone does.
      const def = (typeof CARD_DEFS !== 'undefined' && CARD_DEFS.find(d => d.name === t.name)) || t;
      const fresh = G.createCardInstance(def, t.owner);
      // THE SILENCE. Null every hook on the returning copy, the same set the
      // face-down play suppresses — that is what "doesn't get to fire its
      // abilities" means, and it has to be baked into the instance rather than
      // checked at play time so no play path can forget to look.
      // Deliberately NOT Moder's strip: addToHand calls _unstripModer() on
      // anything entering a hand, so a Moder-style strip would be undone by
      // the very bounce that applied it.
      fresh._blowaySilenced = true;
      ['onPlay', 'onDeath', 'onDamaged', 'onKill', 'onBeforeTricks', 'onBeforeAttack',
       'onEndOfTurn', 'onAnyCardPlayed', 'onAllyKilled', 'onEnemyKilled', 'onEvade',
       'onDamagePlayer', 'onTurnStart', 'onLaneResolved', 'onLaneCombat',
       'onAnyCardDamaged', 'onBlockMeterFired', 'onRevive', 'onDiscard', 'onMoved']
        .forEach(h => { fresh[h] = null; });
      fresh.passive = null;
      // Back to the seat that owned it, not just their side — same routing
      // Phantom Zone uses, for the same reason.
      const _tt = G.state.twoVTwo, _saved = G._2v2CurrentActingPlayer;
      if (_tt && _tt.online && t._2v2PlayedBy && _tt.players[t._2v2PlayedBy]) {
        G._2v2CurrentActingPlayer = t._2v2PlayedBy;
      }
      G.addToHand(t.owner, fresh, null, null, 'Blown away by Bloway Candy');
      if (_tt && _tt.online) G._2v2CurrentActingPlayer = _saved;
      G.log(`Bloway Candy: blows ${t.name} back to hand — it will come back silenced!`);
    }
  }
];
if (typeof window !== 'undefined') window.CANDY_DEFS = CANDY_DEFS;

// ============================================================
// WONDER WEAPONS — Shadow Man's prizes
// ============================================================
// Handed to whoever leads a Shadow Man category. They are CARDS, not tricks:
// discard-effect cards (no body, no lane) that sit in your CARD hand and cost
// energy to fire, like Pinhead or Jigsaw. Being earned does not mean being
// free — you still have to afford the shot.
//
// They live OUTSIDE CARD_DEFS so nothing can draft or draw them (four separate
// places build pools off that array and none of them filter), and
// Multiplayer._rehydrateState reads this table so they survive the wire with
// their onDiscard intact.
//
// ALL FOUR COST 3, so choosing between them is about what they DO rather than
// what you can afford. Measured against the existing baseline on a full
// six-lane board, where Seismic Charge (2 energy) removes 4 HP and Phantom Zone
// (3) removes 6 and kills one: a weapon should sit a little above that line,
// because a prize ought to be worth winning — and nowhere near a board wipe,
// which is exactly where the uncapped Lightning Bow measured.
const WONDER_DEFS = [
  {
    // THE RAY GUN. Splash is the whole point, and so is the recoil — this is
    // the only card in the game that damages its owner's own board, which is
    // what lets it carry a bigger number than the other cost-3 prizes without
    // stepping on the Lightning Bow. Fire it at the wrong lane and you finish
    // off your own card.
    name: "Ray Gun", cost: 3, attack: 0, health: 0, type: "wonder",
    isDiscardEffect: true, _isWonder: true,
    desc: "Deal 7 damage to an enemy. The blast splashes the enemies either side for 3. Your own card in that lane takes 3 — mind the recoil.",
    canPlay(G, owner) { return G.getEnemiesOf(owner).length > 0; },
    onDiscard(G, owner) {
      const enemies = G.getEnemiesOf(owner).filter(e => e.currentHealth > 0);
      if (!enemies.length) { G.log('Ray Gun: nothing to shoot.'); return; }
      G.promptCardChoice(owner, enemies, "Ray Gun — WAVE GUN",
        "Choose an enemy to hit. The blast splashes both ways — and back at you.", (t) => {
          if (!t) return;
          const opp = G.opponent(owner);
          const at = G.findCardLane(t);
          if (at < 0) return;
          // FX fires before the damage so the bolt lands on cards that are
          // still on screen — and it is handed the exact splash targets and the
          // recoil victim, so the animation shows what actually resolves.
          if (typeof UI !== 'undefined' && UI._fxRayGun) {
            try {
              const _sides = [-1, 1].map(d => { const l = G.state.lanes[at + d]; return l && l[opp]; })
                .filter(c => c && c.currentHealth > 0);
              const _own = G.state.lanes[at] && G.state.lanes[at][owner];
              UI._fxRayGun(t, _sides, (_own && _own.currentHealth > 0) ? _own : null);
            } catch (e) {}
          }
          G.log(`Ray Gun: a green bolt slams into ${t.name} for 7.`);
          G.dealDamage(t, 7, { name: 'Ray Gun' });
          [-1, 1].forEach(dir => {
            const l = G.state.lanes[at + dir];
            const n = l && l[opp];
            if (n && n.currentHealth > 0) {
              G.log(`  [SPLASH] The blast catches ${n.name} for 3.`);
              G.dealDamage(n, 3, { name: 'Ray Gun' });
            }
          });
          // THE RECOIL. Deliberately not optional and not dodgeable — it is the
          // cost that pays for the 7, and the reason the lane you pick matters.
          const mine = G.state.lanes[at] && G.state.lanes[at][owner];
          if (mine && mine.currentHealth > 0) {
            G.log(`  [RECOIL] The splash washes back over ${mine.name} for 3.`);
            G.dealDamage(mine, 3, { name: 'Ray Gun' });
          }
          G.cleanupDead();
        }, cards => {
          // AI: shoot the biggest threat, but not if the recoil kills its own
          // card outright and the shot does not kill the target anyway.
          const scored = cards.slice().sort((a, b) => (b.attack | 0) - (a.attack | 0));
          const safe = scored.filter(c => {
            const l = G.findCardLane(c);
            const own = l >= 0 && G.state.lanes[l] ? G.state.lanes[l][owner] : null;
            if (!own || own.currentHealth > 3) return true;
            return (c.currentHealth | 0) <= 7;
          });
          return safe[0] || scored[0];
        });
    }
  },
  {
    name: "Thundergun", cost: 3, attack: 0, health: 0, type: "wonder",
    isDiscardEffect: true, _isWonder: true,
    desc: "Blast an enemy 2 lanes sideways for 4. Every enemy it passes through takes 3 and is Stunned. If it crashes into an enemy they collide — each takes damage equal to the other's remaining health, and a survivor is Stunned.",
    canPlay(G, owner) { return G.getEnemiesOf(owner).length > 0; },
    onDiscard(G, owner) {
      const enemies = G.getEnemiesOf(owner).filter(e => e.currentHealth > 0);
      if (!enemies.length) { G.log('Thundergun: nothing to blast.'); return; }
      G.promptCardChoice(owner, enemies, "Thundergun — GET BLASTED",
        "Choose an enemy to blast two lanes sideways", (t) => {
          if (!t) return;
          const opp = G.opponent(owner);
          const from = G.findCardLane(t);
          if (from < 0) return;
          // Two lanes, preferring the direction that HAS a lane. Falling back to
          // the opposite side rather than fizzling is the spec's own rule — a
          // card at the edge still gets blasted, just the other way.
          // TWO LANES. (Owner asked for 3, then "make thundergun jump 2 lanes
          // not 3" — three put it well over the cost-3 line because it passed
          // through two bodies every cast.) The direction is still a coin flip,
          // with the far side tried as a fallback when the first is off the
          // board or collapsed.
          const dir = G.rng() < 0.5 ? -1 : 1;
          const tryLanes = [from + 2 * dir, from - 2 * dir];
          let to = -1;
          for (const cand of tryLanes) {
            if (cand >= 0 && cand < Game.LANE_COUNT && !G.state.lanes[cand].destroyed) { to = cand; break; }
          }
          if (to < 0) { G.log('Thundergun: nowhere to blast it to.'); return; }
          if (typeof UI !== 'undefined' && UI._fxThundergun) {
            try {
              const _step = (to > from) ? 1 : -1;
              const _path = [];
              for (let i = from + _step; i !== to; i += _step) {
                const l = G.state.lanes[i], c = l && l[opp];
                if (c && c !== t && c.currentHealth > 0) _path.push(c);
              }
              UI._fxThundergun(t, _path, G.state.lanes[to] && G.state.lanes[to][opp]);
            } catch (e) {}
          }
          // EVERYTHING IN THE PATH IS HIT ON THE WAY PAST. Previously the card
          // flew straight over an occupied lane and left it untouched, which is
          // not what being blasted through a line of bodies should look like.
          // (Owner: "any card it goes through takes the 3 damage and gets
          // stunned".) Walked from the origin outward so the log reads in the
          // order the card actually travels, and the destination is excluded —
          // that one is a collision, handled below, not a fly-through.
          const step = (to > from) ? 1 : -1;
          for (let i = from + step; i !== to; i += step) {
            const lane = G.state.lanes[i];
            const inPath = lane && lane[opp];
            if (!inPath || inPath === t || inPath.currentHealth <= 0) continue;
            G.log(`  [BLAST PATH] ${t.name} is driven through ${inPath.name} for 3.`);
            G.dealDamage(inPath, 3, { name: 'Thundergun' });
            // Stunned only if it lived — nothing on its way to the dead pile
            // needs to be dazed as well.
            if (inPath.currentHealth > 0) {
              try { G.stunCard(inPath, { name: 'Thundergun' }, 1); } catch (e) {}
            }
          }
          // WHO IS ALREADY STANDING THERE decides whether this is a landing or
          // a collision, so it has to be read BEFORE the move.
          const crash = G.state.lanes[to][opp];
          if (crash && crash !== t && crash.currentHealth > 0) {
            // THE BLAST LANDS FIRST, THEN THEY COLLIDE. The gun's own 4 is not
            // conditional on where the card ends up, so it applies either way.
            G.log(`Thundergun: ${t.name} slams into ${crash.name}!`);
            G.dealDamage(t, 4, { name: 'Thundergun' });
            // A REAL COLLISION: each card takes damage equal to the OTHER's
            // remaining health, so the bigger body walks away and the smaller
            // one is crushed — and equal bodies destroy each other. Both totals
            // are read BEFORE either is applied, or the first hit would shrink
            // the health the second one is measured against and the order of
            // resolution would decide the winner. (Owner: "both cards deal each
            // other's health to each other, and if 1 survives, it's stunned".)
            const tHP = t.currentHealth | 0, cHP = crash.currentHealth | 0;
            if (tHP > 0 && cHP > 0) {
              G.log(`  [COLLISION] ${t.name} (${tHP}) and ${crash.name} (${cHP}) slam into each other.`);
              G.dealDamage(t, cHP, { name: 'Thundergun' });
              G.dealDamage(crash, tHP, { name: 'Thundergun' });
            }
            // Whoever is left standing is dazed by it. Checked after the trade,
            // so a dead card is never "stunned" on its way to the dead pile.
            [t, crash].forEach(c => {
              if (c && c.currentHealth > 0) {
                G.log(`  [COLLISION] ${c.name} survives the impact — Stunned.`);
                try { G.stunCard(c, { name: 'Thundergun' }, 1); } catch (e) {}
              }
            });
          } else {
            G.moveCard(t, from, to);
            G.log(`Thundergun: ${t.name} is blasted to lane ${to + 1} and takes 4!`);
            G.dealDamage(t, 4, { name: 'Thundergun' });
          }
          G.cleanupDead();
        }, cards => cards.slice().sort((a, b) => (b.attack | 0) - (a.attack | 0))[0]);
    }
  },
  {
    name: "Lightning Bow", cost: 3, attack: 0, health: 0, type: "wonder",
    isDiscardEffect: true, _isWonder: true,
    desc: "Deal 4 damage to an enemy and Mark it. At the end of the round lightning strikes the Mark, then chains through the enemies beside it — each jump hits for 2 more.",
    canPlay(G, owner) { return G.getEnemiesOf(owner).length > 0; },
    onDiscard(G, owner) {
      const enemies = G.getEnemiesOf(owner).filter(e => e.currentHealth > 0);
      if (!enemies.length) { G.log('Lightning Bow: no target.'); return; }
      G.promptCardChoice(owner, enemies, "Lightning Bow — STORM MARK",
        "Choose an enemy to shoot and Mark", (t) => {
          if (!t) return;
          if (typeof UI !== 'undefined' && UI._fxStormMark) { try { UI._fxStormMark(t); } catch (e) {} }
          G.dealDamage(t, 4, { name: 'Lightning Bow' });
          // The mark carries its OWNER so the delayed strike can still be
          // credited to the player who fired it — the strike lands at end of
          // round, long after this seat stopped being the acting one.
          t._stormMark = { owner, seat: G._shadowSeatOf ? G._shadowSeatOf({ _2v2PlayedBy: null }) : null };
          t._stormMarkOwner = owner;
          G.log(`Lightning Bow: ${t.name} is Storm Marked!`);
          G.cleanupDead();
        }, cards => cards.slice().sort((a, b) => (b.attack | 0) - (a.attack | 0))[0]);
    }
  },
  {
    // GROUND CURRENT. The Wunderwaffe kept measuring as a second Lightning Bow
    // — both "hit a card, spread to its neighbours" — so the damage kit was
    // the problem, not the numbers. This gives it the one axis NOTHING else in
    // the game touches: no trick in the game damages a player's health
    // directly. It barely kills anything; it ends games. And it is the rare
    // card that WANTS the enemy board full, which inverts every other removal
    // tool the player owns.
    name: "Wunderwaffe DG-3 JZ", cost: 3, attack: 0, health: 0, type: "wonder",
    isDiscardEffect: true, _isWonder: true,
    desc: "The current runs the length of the enemy row, dealing 2 to every enemy card — then earths itself in the enemy for 1 damage per card it passed through, up to 5.",
    canPlay(G, owner) { return G.getEnemiesOf(owner).length > 0; },
    onDiscard(G, owner) {
      // NO TARGET PROMPT. It hits the whole row, so there is nothing to aim —
      // the only weapon in the set you simply fire.
      const opp = G.opponent(owner);
      const row = [];
      for (let i = 0; i < Game.LANE_COUNT; i++) {
        const c = G.state.lanes[i] && G.state.lanes[i][opp];
        if (c && c.currentHealth > 0) row.push(c);
      }
      if (!row.length) { G.log('Wunderwaffe DG-3 JZ: nothing to conduct through.'); return; }
      G.log(`Wunderwaffe DG-3 JZ: the current runs the line through ${row.length} card${row.length === 1 ? '' : 's'}.`);
      if (typeof UI !== 'undefined' && UI._fxGroundCurrent) { try { UI._fxGroundCurrent(row); } catch (e) {} }
      row.forEach(c => {
        G.log(`  [CURRENT] It passes through ${c.name} for 2.`);
        G.dealDamage(c, 2, { name: 'Wunderwaffe DG-3 JZ' });
      });
      // EARTHED. Counted BEFORE cleanup so a card the current killed on its way
      // through still conducted — it was in the line when the bolt travelled.
      // CAPPED AT 5. A full six-lane board would otherwise pay 6 face damage —
      // a fifth of a 30-health player from one 3-cost card. The cap costs the
      // card nothing in the common case (it only bites on a completely full
      // enemy row) while taking the best case off the table.
      const conducted = Math.min(5, row.length);
      G.cleanupDead();
      G.log(`  [EARTHED] The current grounds itself in the enemy for ${conducted}.`);
      G.damagePlayer(opp, conducted, false, { name: 'Wunderwaffe DG-3 JZ' });
    }
  },
  {
    name: "Apothicon Servant", cost: 3, attack: 0, health: 0, type: "wonder",
    isDiscardEffect: true, _isWonder: true,
    desc: "Tear a Rift in a chosen enemy lane for 2 rounds. The first card in is swallowed whole; after that they arrive at −4/−4. Enemies must be played into it, take 2 at each round end, and anything dying inside is consumed — no When Killed.",
    onDiscard(G, owner) {
      const opp = G.opponent(owner);
      // THE PLAYER PICKS THE LANE. It was random to begin with, per the brief —
      // but measured against a typical three-card enemy board, 94 of 200 random
      // placements landed on an OCCUPIED lane, where the compulsion cannot
      // engage until that card leaves. Half the time a 3-cost card's headline
      // effect was decided by a coin flip, on the one weapon where placement IS
      // the card. (Owner: "yes let the player choose where to place the rift.")
      const cand = [];
      for (let i = 0; i < Game.LANE_COUNT; i++) {
        const l = G.state.lanes[i];
        if (l && !l.destroyed && !(l._rift && l._rift.rounds > 0)) cand.push(i);
      }
      if (!cand.length) { G.log('Apothicon Servant: the board will not tear.'); return; }
      const tear = (lane) => {
        if (lane == null || !G.state.lanes[lane]) return;
        G.state.lanes[lane]._rift = { rounds: 2, side: opp, owner, eaten: 0, firstClaimed: false };
        // Its own effect rather than the shared portal: a rift is a hole that
        // pulls inward, so everything contracts instead of bursting outward.
        if (typeof UI !== 'undefined' && UI._fxRiftTear) { try { UI._fxRiftTear(lane, opp); } catch (e) {} }
        G.log(`Apothicon Servant: an Apothicon Rift tears open in lane ${lane + 1}!`);
        // Anything already standing in it is pulled in immediately — and being
        // first, it is the one swallowed whole.
        const sitting = G.state.lanes[lane][opp];
        if (sitting && sitting.currentHealth > 0 && G.riftSwallow) G.riftSwallow(sitting, lane);
        if (typeof UI !== 'undefined' && UI.render) { try { UI.render(); } catch (e) {} }
      };
      G.promptLaneChoice(owner, cand, 'Apothicon Servant — Tear the Rift',
        'Choose the enemy lane to tear open', tear, opp);
    }
  }
];
if (typeof window !== 'undefined') window.WONDER_DEFS = WONDER_DEFS;
