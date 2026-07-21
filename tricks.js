// ============================================================
// TRICK DEFINITIONS — descs follow the glossary in card-text-audit.md
// All player targeting uses promptCardChoice for manual selection.
// ============================================================
const TRICK_DEFS = [
  // Cost 0
  { name: "Space Stone", cost: 0,
    desc: "Choose a card from your hand — it can be played during the Trick Phase this round at its normal cost.",
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
    desc: "Reaction: When the enemy plays a hostile trick against your cards, negate it. The enemy's trick returns to their hand and is blocked this round. Time Stone is consumed.",
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
    desc: "Deal 2 damage 2 separate times to enemies.",
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
          G.dealDamage(t, 2);
          G.log(`Batarang strike 2: hits ${t.name} for 2!`);
        }, pickLow);
      };
      const strike1 = () => {
        const pool = trickable();
        if (!pool.length) return;
        G.promptCardChoice(owner, pool, "Batarangs — Strike 1", "Deal 2 damage to which enemy?", (t) => {
          G.dealDamage(t, 2);
          G.log(`Batarang strike 1: hits ${t.name} for 2!`);
          strike2();
        }, pickLow);
      };
      strike1();
    }
  },
  { name: "Bat Signal", cost: 1,
    desc: "Summon a random 1-cost card (or Batman) from the summon deck.",
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
      const d = G.drawFromSummonDeck(c => !c.isDiscardEffect && (c.cost <= 1 || (!isRoguelite && c.name === 'Batman')));
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
          G.debuffCard(t, r, 0);
          G.log(`Kryptonite: ${t.name} -${r} ATK!`);
        }, cards => cards.sort((a, b) => b.attack - a.attack)[0]);
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
      const c = h[Math.floor(Math.random() * h.length)];
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
          `The opponent is holding ${c.name}. Click to acknowledge.`,
          () => {}, null,
          { forcePrompt: true, inlineTray: true }
        );
      }
      });
    }
  },
  { name: "Lazarus Pit", cost: 1,
    desc: "Return a random card from your Dead Pile to your hand.",
    play(G, owner) {
      const d = G.state[owner].deadPile;
      if (d.length) {
        const archived = d.splice(Math.floor(Math.random() * d.length), 1)[0];
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
        if (typeof G.addToHand === 'function') G.addToHand(owner, fresh);
        else G.state[owner].hand.push(fresh);
        G.log(`Lazarus Pit revives ${fresh.name} to your hand!`);
      }
    }
  },
  { name: "Mother Box", cost: 1,
    desc: "Summon a random 1-cost card (or Darkseid) from the summon deck.",
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
      const d = G.drawFromSummonDeck(c => !c.isDiscardEffect && (c.cost <= 1 || (!isRoguelite && c.name === 'Darkseid')));
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
          t.evadeCharges += 1; G.buffCard(t, 1, 1);
          G.log(`Smoke Pellet buffs ${t.name}!`);
        });
      } else if (a.length) {
        const t = a.sort((x, y) => y.cost - x.cost)[0];
        t.evadeCharges += 1; G.buffCard(t, 1, 1);
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
          G.buffCard(t, 2, 2); G.log(`Adamantium buffs ${t.name}!`);
        });
      } else if (a.length) {
        const t = a.sort((x, y) => y.cost - x.cost)[0];
        G.buffCard(t, 2, 2); G.log(`Adamantium buffs ${t.name}!`);
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
      G.state[owner].maxHandSize += 1;
      G.log(`Eye of Agamotto opens — foresight queued for next draw phase, max hand size → ${G.state[owner].maxHandSize}.`);
    }
  },
  { name: "Mobius Chair", cost: 2,
    desc: "Look at 3 random cards from the draw pile. Add one to your hand.",
    play(G, owner) {
      const pile = G.getDrawPile(owner);
      if (!pile.length) { G.log(`Mobius Chair finds nothing — draw pile empty!`); return; }
      const count = Math.min(3, pile.length);
      const indices = [];
      while (indices.length < count) {
        const r = Math.floor(Math.random() * pile.length);
        if (!indices.includes(r)) indices.push(r);
      }
      const choices = indices.map(i => pile[i]);
      G.promptCardChoice(owner, choices, "Mobius Chair — Scry", "Pick a card to add to your hand", (picked) => {
        const idx = pile.indexOf(picked);
        if (idx >= 0) pile.splice(idx, 1);
        G.addToHand(owner, G.createCardInstance(picked, owner));
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
          G.buffCard(t, 2, 0); G.log(`Power Stone: ${t.name} +2 ATK!`);
        });
      } else if (a.length) {
        const t = a.sort((x, y) => y.cost - x.cost)[0];
        G.buffCard(t, 2, 0); G.log(`Power Stone: ${t.name} +2 ATK!`);
      }
    }
  },
  { name: "The Darkhold", cost: 2,
    desc: "Destroy all enemies with ≤ 2 ATK.",
    // Needs a live target — greys out in the tray + refused by playTrick otherwise.
    canPlay(G, owner) { return G.getEnemiesOf(owner).some(e => (e.attack || 0) <= 2 && G.canTrickLand(e, 'destroy', owner)); },
    play(G, owner) {
      G.getEnemiesOf(owner).filter(e => e.attack <= 2 && G.canTrickLand(e, 'destroy', owner)).forEach(t => {
        G.log(`Darkhold destroys ${t.name}!`); G.killCard(t);
      });
    }
  },
  { name: "Two-Face Coin", cost: 2,
    desc: "Roll a die (1-8). Add the result to your Block Meter.",
    play(G, owner) {
      const roll = 1 + Math.floor(Math.random() * 8);
      G.state[owner].blockMeter = Math.min(Game.BLOCK_MAX, G.state[owner].blockMeter + roll);
      G.log(`Two-Face Coin rolls ${roll}! Block Meter +${roll} → ${G.state[owner].blockMeter}`);
    }
  },
  { name: "Vibranium", cost: 2,
    desc: "Add (+1/+1) to all allies.",
    // Needs a live target — greys out in the tray + refused by playTrick otherwise.
    canPlay(G, owner) { return G.getAlliesOf(owner).some(x => G.canTrickLand(x, 'trick', owner)); },
    play(G, owner) {
      G.getAlliesOf(owner).filter(x => G.canTrickLand(x, 'trick', owner)).forEach(a => { G.buffCard(a, 1, 1); });
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
          G.fearCard(t, source); G.log(`Fear Toxin terrifies ${t.name}!`);
        }, cards => cards.sort((a, b) => b.attack - a.attack)[0]);
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
          t.invincibleTurns += 1; G.log(`Nth Metal: ${t.name} invincible!`);
        });
      } else if (a.length) {
        const t = a.sort((x, y) => y.cost - x.cost)[0];
        t.invincibleTurns += 1; G.log(`Nth Metal: ${t.name} invincible!`);
      }
    }
  },
  { name: "Super Soldier Serum", cost: 3,
    desc: "LEAP +1 — Transform an ally into a random card that costs EXACTLY one more.",
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
    desc: "Shrink an enemy — (−3/−3).",
    canPlay(G, owner) { return G.getEnemiesOf(owner).some(e => G.canTrickLand(e, 'debuff', owner)); },
    play(G, owner) {
      const enemies = G.getEnemiesOf(owner).filter(e => G.canTrickLand(e, 'debuff', owner));
      if (!enemies.length) return;
      G.promptCardChoice(owner, enemies, "Pym Particles — Shrink", "Choose an enemy to shrink", (t) => {
        // allowKill=true — shrinking a ≤3-HP enemy destroys it outright.
        // Without the flag, debuffCard floors HP at 1 (user: "Pym Particles
        // can kill an enemy; right now it leaves it at 1 health").
        G.debuffCard(t, 3, 3, true, { name: 'Pym Particles' });
        if (t.currentHealth <= 0) G.log(`Pym Particles: ${t.name} shrinks into nothing — destroyed!`);
        else G.log(`Pym Particles: ${t.name} shrunk to ${t.attack}/${t.currentHealth}!`);
      }, cards => cards.sort((a, b) => (b.attack + b.maxHealth) - (a.attack + a.maxHealth))[0]);
    }
  },
  // Cost 4
  { name: "Phantom Zone", cost: 3,
    desc: "Return an enemy to their hand. (May exceed max hand size for 1 turn.)",
    // Needs a live target — greys out in the tray + refused by playTrick otherwise.
    canPlay(G, owner) { return G.getEnemiesOf(owner).some(e => G.canTrickLand(e, 'trick', owner)); },
    play(G, owner) {
      const enemies = G.getEnemiesOf(owner).filter(e => G.canTrickLand(e, 'trick', owner));
      if (enemies.length) {
        G.promptCardChoice(owner, enemies, "Phantom Zone — Bounce", "Choose enemy to bounce back to hand", (t) => {
          const l = G.findCardLane(t);
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
          G.addToHand(t.owner, fresh);
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
    desc: "Destroy one of your cards and an enemy within 4 base cost of it.",
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
              G.killCard(al); G.killCard(en);
            }, cards => cards.sort((x, y) => y.cost - x.cost)[0]);
          }
        };
        if (Game.isHuman(owner)) {
          G.promptCardChoice(owner, allies, "Soul Stone — Choose Your Card", "Choose your card to sacrifice", doSoulStone);
        } else {
          doSoulStone(allies[0]);
        }
      }
    }
  },
  // Cost 5
  { name: "Anti-Life Equation", cost: 4,
    desc: "Destroy both cards in a contested lane and collapse it into the void for 3 rounds. Can't target lanes holding an Invincible, Untrickable, or 10-cost card.",
    play(G, owner) {
      const opp = G.opponent(owner);
      const contested = [];
      for (let i = 0; i < Game.LANE_COUNT; i++) {
        const mine = G.state.lanes[i][owner];
        const theirs = G.state.lanes[i][opp];
        if (mine && theirs && !G.state.lanes[i].destroyed) {
          // Only offer lanes where BOTH cards will actually die — any
          // survivor would be left standing inside the void for 3 rounds
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
        G.destroyLane(i, 3);
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
    desc: "Mind Control 1 an enemy this turn.",
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
            G.log(`Mind Stone controls ${t.name}!`);
          });
        }, cards => cards[0]);
      }
    }
  },
  { name: "Reality Stone", cost: 4,
    desc: "Permanently swap an ally's ATK/HP with an enemy's ATK/HP.",
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
    desc: "Protect either odd or even lanes from damage this round.",
    play(G, owner) {
      if (Game.isHuman(owner)) {
        G.promptCardChoice(owner,
          [{ name: 'Protect Odd Lanes', desc: 'Lanes 1, 3, 5', _choice: 'odd' },
           { name: 'Protect Even Lanes', desc: 'Lanes 2, 4, 6', _choice: 'even' }],
          "Joker's Playing Card", "Choose which lanes to protect",
          (choice) => {
            const odd = choice._choice === 'odd';
            for (let i = 0; i < Game.LANE_COUNT; i++) {
              if (((i + 1) % 2 === 1) === odd) G.state.lanes[i].protected = owner;
            }
            G.log(`Joker's Card protects ${odd ? 'odd' : 'even'} lanes!`);
          });
      } else {
        const odd = Math.random() < 0.5;
        for (let i = 0; i < Game.LANE_COUNT; i++) {
          if (((i + 1) % 2 === 1) === odd) G.state.lanes[i].protected = owner;
        }
        G.log(`Joker's Card protects ${odd ? 'odd' : 'even'} lanes!`);
      }
    }
  }
];

