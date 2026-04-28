// ============================================================
// CARD ABILITIES — callback functions and special properties
// Keyed by card name; merged into CARD_DEFS at load time.
// ============================================================

// AI target picker — picks the highest-threat card from a list.
// Used as the `aiPicker` callback for damage / destroy / control
// abilities (Ant-Man's destroy, Bane's debuff, Gamora's execute, etc.)
// so the AI removes the most impactful threat instead of just the
// most expensive or highest-ATK one. Threat score factors in armor /
// evade / invincibility / strategic value (a 4/8 with Armor 2 is
// worth more to remove than a 7/4 glass cannon).
//
// Falls back to a cost+ATK approximation when the AI module isn't
// loaded yet (defensive — abilities.js loads before ai.js, but the
// callback only runs at game-time when AI is available).
const _aiThreatPicker = (cards) => cards.slice().sort((a, b) => {
  if (typeof AI !== 'undefined' && AI.threatScore) {
    return AI.threatScore(b) - AI.threatScore(a);
  }
  return ((b.attack || 0) + (b.cost || 0) * 0.5) - ((a.attack || 0) + (a.cost || 0) * 0.5);
})[0];

// Variant — picks the LOWEST-HP enemy that is also high-threat.
// For damage abilities where the goal is execution (Rocket Raccoon's
// 4-damage blast, Predator's 3-damage strike, Human Torch's 2-damage
// blast). Tries to find a kill-shot first; if no kill is possible,
// dumps onto the highest-threat enemy.
const _aiKillPicker = (cards, damage) => {
  const score = (c) => (typeof AI !== 'undefined' && AI.threatScore)
    ? AI.threatScore(c)
    : (c.attack || 0) + (c.cost || 0) * 0.5;
  const killable = cards.filter(c => {
    const armor = c.armorValue || 0;
    return (c.currentHealth || 0) <= (damage - armor);
  });
  if (killable.length) {
    return killable.slice().sort((a, b) => score(b) - score(a))[0];
  }
  return cards.slice().sort((a, b) => score(b) - score(a))[0];
};

const CARD_ABILITIES = {
  // ==================== ROGUELITE STARTERS ====================
  // The 3 vanilla bodies from Roguelite.STARTER_DEFS. These get
  // re-merged onto the corresponding CARD_DEFS entries when
  // Roguelite._ensureVanillaDefsRegistered runs at fight launch.
  "Goon": {
    passive: 'goonHive',
    onPlay(G, self, lane) {
      // "+1/+1 for every other Goon ally on board." On arrival count
      // existing Goons → buff self by (n,n) AND buff each existing
      // Goon by (1,1) so they all stay in lockstep with the count.
      const others = G.getAlliesOf(self.owner).filter(a => a.id !== self.id && a.name === 'Goon' && a.currentHealth > 0);
      const n = others.length;
      if (n > 0) {
        G.buffCard(self, n, n);
        others.forEach(g => G.buffCard(g, 1, 1));
        G.log(`Goon hive: +${n}/+${n} from ${n} other Goon${n === 1 ? '' : 's'}.`);
      }
    },
    onDeath(G, self, lane) {
      // When a Goon falls, the hive shrinks — every remaining Goon
      // ally loses 1/1 (floors at attack 0, currentHealth 1) so
      // their stats track the new ally count.
      const remaining = G.getAlliesOf(self.owner).filter(a => a.id !== self.id && a.name === 'Goon' && a.currentHealth > 0);
      remaining.forEach(g => {
        g.attack = Math.max(0, (g.attack || 0) - 1);
        g.maxHealth = Math.max(1, (g.maxHealth || 1) - 1);
        g.currentHealth = Math.max(1, Math.min(g.currentHealth, g.maxHealth));
      });
      if (remaining.length) G.log(`Goon hive shrinks — ${remaining.length} remaining Goon${remaining.length === 1 ? '' : 's'} lose 1/1.`);
    },
  },
  "Thug": {
    onPlay(G, self, lane) {
      // Deal 1 damage to a chosen enemy. Prompt the player; AI picks
      // a kill target via _aiKillPicker(cards, 1) so a 1/1 sniped is
      // a kill. If no enemies, no-op.
      const enemies = G.getEnemiesOf(self.owner);
      if (!enemies.length) return;
      G.promptCardChoice(
        self.owner, enemies, 'Thug — Strike', 'Choose an enemy to deal 1 damage',
        (t) => { G.dealDamage(t, 1, self); G.log(`Thug strikes ${t.name} for 1!`); },
        cards => _aiKillPicker(cards, 1)
      );
    },
  },
  "Brute": {
    // No callbacks needed — Armor 1 + Taunt 1 are pure keyword
    // abilities applied via the `abilities` array at applyAbilities
    // time. Listed here so the merge step still runs (no-op merge).
  },

  // ==================== COST 1 ====================
  "Ant-Man": {
    onPlay(G, self, lane) {
      const afterSummon = () => {
        const targets = G.getEnemiesOf(self.owner).filter(c => c.attack <= 1 || c.currentHealth <= 1);
        if (targets.length) {
          G.promptCardChoice(self.owner, targets, "Ant-Man — Destroy", "Choose an enemy to destroy (1 ATK or 1 HP)", (t) => {
            G.log(`[KILL] ${self.name} destroys ${t.name}!`); G.killCard(t, self);
          }, _aiThreatPicker);
        }
      };
      G.summonCardChoice(self.owner, "Ant", 1, 1, 1, ["Bullseye"], afterSummon);
    }
  },
  "Poison Ivy": {
    // Simplified charm mechanic — picks a random ally each round and
    // ADDS that ally's current attack to Poison Ivy's attack for this
    // turn only. Examples (Ivy base 1 ATK):
    //   • Charms Venom (3 ATK) → Ivy's attack becomes 4 this turn
    //   • Charms Man-Bat (1 ATK) → Ivy's attack becomes 2 this turn
    // Uses grantTempBuff(duration=1) so the buff auto-expires in
    // postCombat via expireGrantedBuffs — no custom cleanup path.
    _charm(G, self) {
      // Also keep a direct ref on Ivy for the damage-preview UI (reads
      // _ivyAlly to show "Ivy charm" as a visible bonus). Safe to clear
      // and re-assign each round without affecting combat logic.
      // Strip any pre-existing _ivyCharm buff before re-charming — onPlay
      // and onBeforeTricks can both fire in the same round, so without
      // this cleanup Ivy's ATK would double-stack from the same source.
      if (self._grantedBuffs && self._grantedBuffs.length) {
        const idx = self._grantedBuffs.findIndex(b => b._ivyCharm);
        if (idx >= 0) {
          const b = self._grantedBuffs[idx];
          if (b.set) self[b.prop] = b.prev;
          else {
            self[b.prop] = (self[b.prop] || 0) - (b.delta || 0);
            if (b.prop === 'attack') self[b.prop] = Math.max(0, self[b.prop]);
          }
          self._grantedBuffs.splice(idx, 1);
        }
      }
      self._ivyAlly = null;
      self._ivyCharmedId = null;
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id && a.currentHealth > 0 && (a.attack || 0) > 0);
      if (!allies.length) {
        G.log(`[POISON IVY] No allies available to charm this turn.`);
        return;
      }
      const pick = allies[Math.floor(Math.random() * allies.length)];
      self._ivyAlly = pick;
      self._ivyCharmedId = pick.id; // tracked so handleDeath can strip the buff
      const bonus = pick.attack || 0;
      if (bonus > 0) {
        // Temp buff, auto-expires after 1 turn. Re-charming on the
        // next round will grant a fresh buff based on whoever's picked
        // then; the old one is already gone. Mark the buff with
        // _ivyCharm so handleDeath can find and reverse it if the
        // charmed ally dies mid-turn (buff is tied to a LIVING target;
        // if the target dies, the bonus goes with it).
        G.grantTempBuff(self, { attack: bonus }, 1);
        const last = self._grantedBuffs && self._grantedBuffs[self._grantedBuffs.length - 1];
        if (last) last._ivyCharm = true;
        G.log(`[POISON IVY] ${pick.name} is charmed — Poison Ivy gains +${bonus} ATK this turn (now ${self.attack}).`);
      } else {
        G.log(`[POISON IVY] ${pick.name} is charmed — but offers no ATK bonus.`);
      }
    },
    // Recurring — beforeTricksFired resets each round so the charm re-rolls
    // every round instead of just once.
    _recurringBT: true,
    onPlay(G, self) {
      // Charm immediately when Ivy is played mid-round so she swings
      // with the bonus this turn rather than waiting until next round.
      CARD_ABILITIES['Poison Ivy']._charm(G, self);
    },
    onBeforeTricks(G, self) {
      // Re-charm at start of the tricks phase. This runs in endPhase2()
      // after BOTH players have deployed all their cards, so freshly
      // played allies (e.g. Jango Fett) are in the charm pool. The
      // chosen target is LOCKED for the rest of the round — combat
      // doesn't re-pick. User spec: "its set before tricks it cant
      // change during the combat phase."
      CARD_ABILITIES['Poison Ivy']._charm(G, self);
    },
    onEndOfTurn(G, self) {
      // Post-combat — if the charmed ally died this round, re-charm
      // a new living ally so Ivy's CHARMED badge is always visible
      // on someone (mirrors Joker's onEndOfTurn re-stamp pattern).
      // No-op if the current charm target is still alive (the
      // _ivyAlly check below short-circuits before grantTempBuff
      // would re-grant a duplicate). User spec: "while active all
      // the time when they are on board their debuff/buff is always
      // on board showing."
      const target = self._ivyAlly;
      const alive = target && target.currentHealth > 0 && G.findCardLane(target) >= 0;
      if (alive) return;
      CARD_ABILITIES['Poison Ivy']._charm(G, self);
    }
  },
  "Black Widow": {
    onPlay(G, self, lane) {
      // Roguelite rarity variant — number of freezes scales with tier.
      //   common    → 1 adjacent freeze (listed)
      //   rare      → 1 adjacent freeze (listed)
      //   special   → 2 adjacent freezes (if 2 adjacent enemies)
      //   legendary → 2 adjacent freezes + cards gain Bullseye for 1 turn
      const freezes = G.rarityValue(self, { common: 1, rare: 1, special: 2, legendary: 2 });
      const grantBullseye = G.rarityValue(self, { common: false, rare: false, special: false, legendary: true });
      const adj = G.getAdjacentEnemiesInContext(lane, self.owner);
      if (!adj.length) return;
      let frozen = 0;
      const pickNext = () => {
        const remaining = adj.filter(a => !a.isFrozen);
        if (frozen >= freezes || !remaining.length) return;
        G.promptCardChoice(self.owner, remaining, "Black Widow — Freeze", `Choose adjacent enemy to freeze (${frozen + 1}/${freezes})`, (t) => {
          G.freezeCard(t, self);
          frozen++;
          if (frozen < freezes) pickNext();
        });
      };
      pickNext();
      if (grantBullseye) {
        G.getAlliesOf(self.owner).forEach(a => {
          if (a.id !== self.id) {
            G.grantTempBuff(a, { isBullseye: true });
          }
        });
        G.log("Black Widow's signal: allies gain Bullseye this turn!");
      }
    }
  },
  "Man-Bat": {
    _recurringBT: true,
    onBeforeTricks(G, self, lane) {
      // Stun / freeze gates the whole ability, not just the move. Previously
      // moveCard silently refused the relocation but the -1/-1 debuff still
      // fired on the target opposite Man-Bat's *original* lane (and the
      // lane prompt popped anyway). Skip the full ability when locked.
      if (self.isStunned || self.isFrozen) {
        G.log(`  [SKIP] ${self.name} is ${self.isStunned ? 'STUNNED' : 'FROZEN'} — stays put.`);
        return;
      }
      const open = G.getOpenLanes(self.owner).filter(l => l !== lane);
      if (!open.length) return;
      // Pass allowKill=true so a -1/-1 debuff can actually finish off a
      // 1-HP enemy instead of flooring at 1 HP — Man-Bat moving in front
      // of a 1-HP Undead Warrior now immediately destroys it, matching
      // the intuitive read of "weakens adjacent enemy by -1/-1".
      const applyDebuff = (enemy) => {
        if (!enemy) return;
        G.debuffCard(enemy, 1, 1, true, self);
        enemy._debuffStacks = (enemy._debuffStacks || 0) + 1;
        G.log(`[DEBUFF] Man-Bat weakens ${enemy.name} by -1/-1`);
      };
      // Include the current lane as a "stay" option. User direction:
      // "for moving like man bat and omni man have the choice not to
      // move." Player can click Man-Bat's own lane to stay put — the
      // -1/-1 debuff and move both skip when stay is picked.
      if (Game.isHuman(self.owner)) {
        const choices = [lane, ...open];
        G.promptLaneChoice(self.owner, choices, "Man-Bat — Move", "Choose a lane to move to (current = stay)", (to) => {
          if (to === lane) {
            G.log(`Man-Bat stays put in lane ${lane + 1}.`);
            return;
          }
          G.moveCard(self, lane, to);
          applyDebuff(G.state.lanes[to][G.opponent(self.owner)]);
        });
      } else {
        const to = open[Math.floor(Math.random() * open.length)];
        G.moveCard(self, lane, to);
        applyDebuff(G.state.lanes[to][G.opponent(self.owner)]);
      }
    }
  },
  "Harley Quinn": {
    onPlay(G, self, lane) {
      G.drawCards(self.owner, 1);
      G.drawCards(G.opponent(self.owner), 1);
      G.log("Harley Quinn makes everyone draw!");
      // First ATK roll happens immediately on play — startRound's
      // sweep handles subsequent rerolls via the Crazy trait.
      G.rerollCrazyInsane(self);
    },
    // onTurnStart removed — the Crazy trait is rerolled centrally in
    // startRound via G.rerollCrazyInsane, so we don't need a per-card
    // hook here. Keeping a no-op would just double the log line.
    onBeforeAttack(G, self) {
      G.damagePlayer(self.owner, 1, false);
      G.log(`[HIT] Harley Quinn deals 1 to her own team before attacking!`);
    }
  },
  "Jango Fett": {
    onMoved(G, self, toLane) {
      G.splashDamage(toLane, self.owner, 1);
      G.log(`Jango Fett splashes lane ${toLane + 1} for 1 on arrival!`);
    }
  },
  "Gorilla Grodd": {
    onPlay(G, self, lane) {
      // Roguelite rarity variant — cost gate scales with tier. Classic
      // mode (no _runRarity) defaults to 'rare' → base behavior (≤3).
      //   common    → cost ≤ 1 (only the smallest threats)
      //   rare      → cost ≤ 3 (listed)
      //   special   → cost ≤ 5
      //   legendary → cost ≤ 9 (anything that isn't a 10-cost titan)
      const maxCost = G.rarityValue(self, { common: 1, rare: 3, special: 5, legendary: 9 });
      const enemySide = G.opponent(self.owner);
      const jugg = G.getAllCardsOf(enemySide).find(c => c.name === 'Juggernaut');
      if (jugg) { G.log(`Juggernaut blocks Gorilla Grodd's mind control!`); return; }
      const eligible = G.getEnemiesOf(self.owner)
        .filter(e => (e.baseCost || e.cost) <= maxCost);
      if (!eligible.length) {
        G.log(`Gorilla Grodd finds no weak minds (no enemy with base cost ≤ ${maxCost}) to control.`);
        return;
      }
      G.promptCardChoice(self.owner, eligible,
        "Gorilla Grodd — Mind Control",
        `Choose an enemy with base cost ${maxCost} or less`,
        (target) => {
          if (G.mindControlCard(target, self, () => { target.mindControlTarget = null; })) {
            G.log(`Gorilla Grodd seizes ${target.name}'s mind!`);
          }
        },
        cards => cards.slice().sort((a, b) => (b.baseCost || b.cost) - (a.baseCost || a.cost))[0]);
    }
  },
  "Hawkeye": {
    onPlay(G, self, lane) {
      // Splash radius scales with tier: 1 / 1 / 2 / 2 (and gains Bullseye
      // at legendary so the splash bypasses block meter).
      const splash = G.rarityValue(self, { common: 1, rare: 1, special: 2, legendary: 2 });
      G.splashDamage(lane, self.owner, splash);
      G.log(`Hawkeye splashes adjacent enemies for ${splash}!`);
    },
    passive: "splashWeaken"
  },
  "Mr. Fantastic": {
    isDiscardEffect: true,
    onDiscard(G, owner, self) {
      G.state[owner].nextDrawDiscount += 2;
      // Track the Mr. Fantastic instance that set this so drawCards can
      // credit him with actual `statsDiscountValue` at apply time
      // (matches the amount actually used, not the 2 we just posted).
      if (self) G.state[owner]._nextDrawDiscountSource = self;
    }
  },
  "Mr. Freeze": {
    onPlay(G, self, lane) {
      // Targets scale with tier: just front (common/rare), front + 1
      // adjacent (special), front + both adjacents (legendary).
      const reach = G.rarityValue(self, { common: 0, rare: 0, special: 1, legendary: 2 });
      const opp = G.opponent(self.owner);
      const targets = [];
      const front = G.state.lanes[lane] ? G.state.lanes[lane][opp] : null;
      if (front) targets.push(front);
      if (reach >= 1) {
        const left = lane > 0 && G.state.lanes[lane - 1] ? G.state.lanes[lane - 1][opp] : null;
        if (left) targets.push(left);
      }
      if (reach >= 2) {
        const right = lane < Game.LANE_COUNT - 1 && G.state.lanes[lane + 1] ? G.state.lanes[lane + 1][opp] : null;
        if (right) targets.push(right);
      }
      targets.forEach(t => G.freezeCard(t, self));
      G.state[self.owner].healthFrozen = true;
      G.state[self.owner]._healthFrozenBy = self;
      const who = Game.isHuman(self.owner) ? 'your' : 'its';
      const list = targets.length ? targets.map(t => t.name).join(', ') + ' and ' : '';
      G.log(`Mr. Freeze freezes ${list}${who} health bar!`);
    }
  },
  "Sabertooth": {
    onDamagePlayer(G, self) {
      G.buffCard(self, 1, 1);
      G.log("Sabertooth grows! +1/+1");
    }
  },
  "Xenomorph": {
    onAnyCardPlayed(G, self) {
      // Roguelite rarity variant — buff size scales with tier. Common
      // drops the +1 HP entirely (just +1 ATK growth) so the card has
      // a real downside at low rarity. Classic = baseline +1/+1.
      //   common    → +1 ATK only (no HP growth)
      //   rare      → +1/+1 (listed)
      //   special   → +1/+2
      //   legendary → +2/+2
      const buff = G.rarityValue(self, {
        common:    { atk: 1, hp: 0 },
        rare:      { atk: 1, hp: 1 },
        special:   { atk: 1, hp: 2 },
        legendary: { atk: 2, hp: 2 },
      });
      G.buffCard(self, buff.atk, buff.hp);
      G.log(`Xenomorph grows! Now ${self.attack}/${self.currentHealth}`);
    },
    onDeath(G, self, lane) {
      // Splash radius also scales with tier. Common = 1 (listed), boss
      // tiers get a wider blast.
      const splash = G.rarityValue(self, { common: 1, rare: 1, special: 2, legendary: 3 });
      G.splashDamage(lane, self.owner, splash);
      G.log(`Xenomorph explodes for Splash ${splash}!`);
    }
  },

  // ==================== COST 2 ====================
  "Bane": {
    onPlay(G, self, lane) {
      const enemies = G.getEnemiesOf(self.owner);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Bane — Weaken", "Choose enemy to remove -1/-1 & all evades", (e) => {
          // allowKill=true so a 1-HP enemy (e.g. Nightwing) actually dies
          // from the -1/-1. Previously HP floored at 1 and Bane's debuff
          // couldn't finish off already-low targets.
          G.debuffCard(e, 1, 1, true, self);
          e.evadeCharges = 0;
          G.log(`Bane strips ${e.name}: -1/-1 & all evades removed!`);
        }, _aiThreatPicker);
      }
    },
    onDamaged(G, self) {
      // Only rage if Bane actually survived the hit. No auto-revive from 0 HP.
      if (self.currentHealth <= 0) return;
      self.attack += 1;
      self.maxHealth += 1;
      self.currentHealth += 1;
      G.log(`Bane rages! +1/+1 → ${self.attack}/${self.currentHealth}`);
    }
  },
  "Catwoman": {
    isDiscardEffect: true,
    onDiscard(G, owner, self) {
      const opp = G.opponent(owner);
      G.addNextTurnCurrency(owner, 1);
      G.addNextTurnCurrency(opp, -1);
      G.log("Catwoman steals 1 energy from the enemy next turn!");
      // v3 — credit Catwoman with the 2 energy swing (gain 1 self,
      // deny 1 enemy). Counts as tempo/discount value.
      if (self) G._creditChain(self, 'statsDiscountValue', 2);
    }
  },
  "Dr. Strange": (() => {
    // Strip the Strange-applied tag without breaking other Untrickable sources (e.g. Time Stone).
    const stripTag = (a) => {
      if (!a.drStrangeUntrickable) return;
      a.drStrangeUntrickable = false;
      if (!a.permanentUntrickable) a.isUntrickable = false;
    };
    // Refresh: clear all old aura tags from allies, then re-apply to current adjacents
    const refreshAura = (G, self) => {
      G.getAlliesOf(self.owner).forEach(stripTag);
      const lane = G.findCardLane(self);
      if (lane < 0) return;
      const own = self.owner;
      [lane - 1, lane + 1].forEach(l => {
        if (l >= 0 && l < Game.LANE_COUNT && G.state.lanes[l][own]) {
          G.state.lanes[l][own].isUntrickable = true;
          G.state.lanes[l][own].drStrangeUntrickable = true;
        }
      });
    };
    const clearAura = (G, self) => {
      G.getAlliesOf(self.owner).forEach(stripTag);
    };
    return {
      onPlay(G, self, lane) {
        G.state[self.owner].drStrangeReorder = true;
        const isRl = !!(G.state.mode && G.state.mode._roguelite);
        G.log(isRl
          ? "Dr. Strange peers into the future! Next turn, scry your top 3 — pick 1, the rest sink to the bottom."
          : "Dr. Strange peers into the future! Next turn, choose 1 of 2 top cards — the other goes to your enemy.");
        refreshAura(G, self);
      },
      onTurnStart(G, self) { refreshAura(G, self); },
      // Re-evaluate aura whenever the board changes (cards moving in/out of adjacency)
      onAnyCardPlayed(G, self) { refreshAura(G, self); },
      onBeforeTricks(G, self) { refreshAura(G, self); },
      onBeforeAttack(G, self) { refreshAura(G, self); },
      onAllyKilled(G, self) { refreshAura(G, self); },
      // When Dr. Strange dies, strip the aura from any tagged allies
      onDeath(G, self) { clearAura(G, self); }
    };
  })(),
  "Gamora": {
    onPlay(G, self, lane) {
      // Lone Wolf is a universal engine rule (game.js playCard/summonCard
      // both apply +1/+1 to any card entering alone). The old bespoke
      // block here stacked a SECOND +1/+1 on top — that's why Gamora
      // was gaining (+1/+1) twice after a Bear Trap damage tick. Gamora
      // now delegates entirely to the universal rule and just does her
      // execute on entry.
      const targets = G.getEnemiesOf(self.owner).filter(c => c.currentHealth <= 2);
      if (targets.length) {
        G.promptCardChoice(self.owner, targets, "Gamora — Execute", "Choose enemy with 2 or less HP to destroy", (t) => {
          G.log(`Gamora executes ${t.name}!`); G.killCard(t, self);
        }, _aiThreatPicker);
      }
    },
    onKill(G, self) {
      G.buffCard(self, 1, 1);
      G.log(`Gamora grows stronger! +1/+1 → ${self.attack}/${self.currentHealth}`);
    }
  },
  "Ghostface": {
    onPlay(G, self, lane) {
      G.summonCardChoice(self.owner, "Ghostface", 2, 2, 1, ["Bullseye"]);
    }
  },
  "Human Torch": {
    onPlay(G, self, lane) {
      // Splash 1 at arrival — hits front enemy + adjacent enemy lanes for 1.
      G.splashDamage(lane, self.owner, 1);
      G.log(`Human Torch ignites on arrival — Splash 1!`);
      const enemies = G.getEnemiesOf(self.owner);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Human Torch — Blast", "Choose enemy to deal 2 damage", (t) => {
          G.dealDamage(t, 2); G.log(`Human Torch blasts ${t.name} for 2!`);
        }, cards => _aiKillPicker(cards, 2));
      }
    }
  },
  "Invisible Woman": {
    onPlay(G, self, lane) {
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id);
      const grant = (a) => {
        G.grantTempBuff(a, { evadeCharges: 1 });
        G.log(`Invisible Woman grants Evade to ${a.name} for 1 turn!`);
      };
      if (allies.length) {
        G.promptCardChoice(self.owner, allies, "Invisible Woman — Evade", "Choose ally to give Evade 1 (1 turn)", grant,
          cards => cards.sort((a, b) => b.attack - a.attack)[0]);
      }
    },
    passive: "faceDownOption"
  },
  "Nightwing": {
    onPlay(G, self, lane) {
      const enemies = G.getEnemiesOf(self.owner);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Nightwing — Weaken", "Choose enemy to remove 2 Attack from", (t) => {
          G.debuffCard(t, 2, 0, false, self); G.log(`Nightwing weakens ${t.name} by 2 ATK!`);
        }, _aiThreatPicker);
      }
    }
  },
  "Peacemaker": {
    onPlay(G, self, lane) {
      const targets = G.getEnemiesOf(self.owner).filter(c => c.attack <= 2);
      if (targets.length) {
        G.promptCardChoice(self.owner, targets, "Peacemaker — Eliminate", "Choose enemy with 2 or less ATK to destroy", (t) => {
          G.log(`Peacemaker eliminates ${t.name}!`); G.killCard(t, self);
        }, _aiThreatPicker);
      }
    },
    onKill(G, self) {
      G.buffCard(self, 1, 1);
      G.log(`Peacemaker grows stronger! +1/+1 → ${self.attack}/${self.currentHealth}`);
    }
  },
  "Rocket Raccoon": {
    onPlay(G, self, lane) {
      // Damage scales with tier: 2 / 4 / 5 / 7.
      const dmg = G.rarityValue(self, { common: 2, rare: 4, special: 5, legendary: 7 });
      const enemies = G.getEnemiesOf(self.owner);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Rocket Raccoon — Blast", `Choose enemy to deal ${dmg} damage`, (t) => {
          G.dealDamage(t, dmg, self); G.log(`Rocket Raccoon blasts ${t.name} for ${dmg}!`);
        }, cards => _aiKillPicker(cards, dmg));
      }
    }
  },
  "Sandman": {
    passive: "trickCostIncrease"
  },
  "The Flash": {
    onPlay(G, self, lane) {
      const adj = G.getAdjacentEnemiesInContext(lane, self.owner);
      const freezeTarget = () => {
        if (adj.length > 1) {
          G.promptCardChoice(self.owner, adj, "The Flash — Freeze", "Choose adjacent enemy to freeze", (t) => {
            G.freezeCard(t, self);
            chooseFirst();
          });
        } else {
          if (adj.length === 1) G.freezeCard(adj[0], self);
          chooseFirst();
        }
      };
      const setFirst = (who) => {
        G.state._nextFirstPlayer = who;
        G.log(`[FLASH] ${who === self.owner ? (Game.isHuman(self.owner) ? 'You' : 'AI') + ' go' : (Game.isHuman(self.owner) ? 'AI goes' : 'You go')} first next turn.`);
      };
      const chooseFirst = () => {
        if (Game.isHuman(self.owner)) {
          const youOpt = { name: 'You go first', desc: 'Play first next round', _who: self.owner };
          const aiOpt  = { name: 'Opponent goes first', desc: 'Let the opponent lead next round', _who: G.opponent(self.owner) };
          G.promptCardChoice(self.owner, [youOpt, aiOpt],
            'The Flash — First Player',
            'Choose who plays first next turn',
            (pick) => setFirst(pick._who));
        } else {
          // AI-controlled — pick strategically from self.owner's POV:
          // going first helps set up blockers when behind; going second
          // lets us react when ahead.
          const opp = G.opponent(self.owner);
          const myThreat = G.getAllCardsOf(self.owner).reduce((s, c) => s + (c.attack || 0), 0);
          const oppThreat = G.getAllCardsOf(opp).reduce((s, c) => s + (c.attack || 0), 0);
          const behind = G.state[self.owner].health < G.state[opp].health - 4 || myThreat < oppThreat;
          setFirst(behind ? self.owner : opp);
        }
      };
      freezeTarget();
    }
  },

  // ==================== COST 3 ====================
  "Ahsoka": {
    onAllyKilled(G, self) {
      // Queue a bonus attack for every ally death, not just the first one this combat.
      self.bonusAttack = (typeof self.bonusAttack === 'number' ? self.bonusAttack : 0) + 1;
    }
  },
  "Carnage": {
    onBeforeTricks(G, self, lane) {
      if (self.carnageHealed) return;
      const ct = G.getEnemiesOf(self.owner).length;
      if (ct > 0) {
        G.healPlayer(self.owner, ct, self);
        G.log(`Carnage heals you for ${ct}!`);
        self.carnageHealed = true;
      }
    }
  },
  "Deathstroke": {
    onPlay(G, self, lane) {
      const targets = G.getEnemiesOf(self.owner).filter(c => c.currentHealth <= 3);
      if (targets.length) {
        G.promptCardChoice(self.owner, targets, "Deathstroke — Assassinate", "Choose enemy with 3 or less HP to destroy", (t) => {
          G.log(`Deathstroke assassinates ${t.name}!`); G.killCard(t, self);
        }, _aiThreatPicker);
      }
    },
    onKill(G, self) {
      G.buffCard(self, 1, 1);
      G.log(`Deathstroke sharpens! +1/+1 → ${self.attack}/${self.currentHealth}`);
    }
  },
  "Dr. Octopus": {
    passive: "extraCurrency"
  },
  "Green Goblin": {
    _recurringBT: true,
    onPlay(G, self, lane) {
      G.splashDamage(lane, self.owner, 1);
      G.splashDamage(lane, self.owner, 2);
      G.log("Green Goblin throws pumpkin bombs! Splash 1 then Splash 2!");
    },
    onBeforeTricks(G, self, lane) {
      // Stun / freeze blocks the move AND the follow-up splash. Same
      // guard as Man-Bat — moveCard alone isn't enough because the
      // splash fires after the refused move.
      if (self.isStunned || self.isFrozen) {
        G.log(`  [SKIP] ${self.name} is ${self.isStunned ? 'STUNNED' : 'FROZEN'} — stays put.`);
        return;
      }
      const opp = G.opponent(self.owner);
      // Find lanes with an enemy and no ally (open for Goblin to move to)
      const targetLanes = [];
      for (let i = 0; i < Game.LANE_COUNT; i++) {
        if (i === lane) continue;
        const e = G.state.lanes[i][opp];
        if (e && e.currentHealth > 0 && !G.state.lanes[i][self.owner] && !G.state.lanes[i].destroyed) {
          targetLanes.push(i);
        }
      }
      if (!targetLanes.length) return;
      // Stay-option same as Man-Bat / Omni-Man — pick own lane to skip
      // the relocation. Splash also skips since it fires off the move.
      if (Game.isHuman(self.owner)) {
        const choices = [lane, ...targetLanes];
        G.promptLaneChoice(self.owner, choices, "Green Goblin — Move", "Choose a lane to move to (current = stay)", (to) => {
          if (to === lane) {
            G.log(`Green Goblin stays put in lane ${lane + 1}.`);
            return;
          }
          G.moveCard(self, lane, to);
          G.splashDamage(to, self.owner, 1);
          const e = G.state.lanes[to][opp];
          G.log(`Green Goblin moves to face ${e ? e.name : 'enemy'} in lane ${to + 1} and splashes!`);
        });
      } else {
        const to = targetLanes[Math.floor(Math.random() * targetLanes.length)];
        G.moveCard(self, lane, to);
        G.splashDamage(to, self.owner, 1);
        const e = G.state.lanes[to][opp];
        G.log(`Green Goblin moves to face ${e ? e.name : 'enemy'} in lane ${to + 1} and splashes!`);
      }
    }
  },
  "Groot": {
    onPlay(G, self, lane) {
      const own = self.owner;
      [lane - 1, lane + 1].forEach(l => {
        if (l >= 0 && l < Game.LANE_COUNT && G.state.lanes[l][own]) {
          G.grantTempBuff(G.state.lanes[l][own], { hasDamageImmunity: true });
        }
      });
      G.log("Groot protects adjacent allies for 1 turn!");
    }
  },
  "Jigsaw": {
    isDiscardEffect: true,
    onDiscard(G, owner) {
      const opp = G.opponent(owner);

      // Step 2: After all traps are placed, move an enemy card to any open lane.
      const moveEnemyStep = () => {
        // Frozen / stunned enemies can't be dragged either — they're locked
        // in their lane until the status clears. Filter them out of the
        // pickable pool so Jigsaw can't move a frozen victim.
        const enemies = G.getEnemiesOf(owner).filter(e => !e.isFrozen && !e.isStunned);
        if (!enemies.length) { G.log("Jigsaw finds no enemy cards left to drag."); return; }
        G.promptCardChoice(owner, enemies,
          "Jigsaw — Relocate",
          "Choose an enemy card to drag to any open lane",
          (picked) => {
            const victimOwner = picked.owner;
            const from = G.findCardLane(picked);
            if (from < 0) return;
            // Destination = any open lane on the enemy's side (so the victim stays on its side).
            const dests = [];
            for (let i = 0; i < G.LANE_COUNT; i++) {
              if (i === from) continue;
              const l = G.state.lanes[i];
              if (!l.destroyed && !l[victimOwner]) dests.push(i);
            }
            if (!dests.length) { G.log(`No open lanes to drag ${picked.name} into.`); return; }
            G.promptLaneChoice(owner, dests,
              "Jigsaw — Destination",
              `Choose a lane for ${picked.name}`,
              (lane) => {
                G.state.lanes[from][victimOwner] = null;
                G.state.lanes[lane][victimOwner] = picked;
                G.log(`[JIGSAW] ${picked.name} is dragged from lane ${from + 1} to lane ${lane + 1}!`);
                G.checkLaneTrap(picked, lane);
                G.cleanupDead();
              },
              victimOwner);
          },
          // AI picker (symmetry): pick the enemy with the highest attack
          cards => cards.slice().sort((a, b) => b.attack - a.attack)[0]);
      };

      // Step 1: Place up to 3 Reverse Bear Traps in open enemy lanes.
      const placeTrapStep = (remaining) => {
        // Only lanes that are empty on the enemy side AND not already trapped qualify.
        const open = [];
        for (let i = 0; i < G.LANE_COUNT; i++) {
          const l = G.state.lanes[i];
          if (!l.destroyed && !l[opp] && !l.trap) open.push(i);
        }
        if (remaining <= 0 || open.length === 0) { moveEnemyStep(); return; }
        G.promptLaneChoice(owner, open,
          `Jigsaw — Set Bear Trap`,
          `Choose an enemy lane to set a Reverse Bear Trap (${remaining} remaining)`,
          (lane) => {
            G.state.lanes[lane].trap = { placedBy: owner };
            G.log(`[BEAR TRAP] Jigsaw sets a Reverse Bear Trap in lane ${lane + 1}!`);
            placeTrapStep(remaining - 1);
          },
          opp);
      };

      G.log(`Jigsaw's game begins — choose where to set your traps.`);
      placeTrapStep(3);
    }
  },
  "Loki": {
    onPlay(G, self, lane) {
      // Block-meter fill % scales with tier. Common: 50%, Rare: 100%
      // (listed), Special: 100% + 1 random ally gains Evade 1, Legendary:
      // 100% + ALL allies gain Evade 1.
      const fillPct = G.rarityValue(self, { common: 0.5, rare: 1.0, special: 1.0, legendary: 1.0 });
      const allyEvade = G.rarityValue(self, { common: 'none', rare: 'none', special: 'one', legendary: 'all' });
      const fillAmt = Math.floor(Game.BLOCK_MAX * fillPct);
      G.state[self.owner].blockMeter = Math.min(Game.BLOCK_MAX, G.state[self.owner].blockMeter + fillAmt);
      G.log(`Loki fills the Block Meter by ${fillAmt}!`);
      if (allyEvade !== 'none') {
        const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id);
        const targets = allyEvade === 'all' ? allies : (allies.length ? [allies[Math.floor(Math.random() * allies.length)]] : []);
        targets.forEach(a => {
          a.evadeCharges = (a.evadeCharges || 0) + 1;
          G.log(`Loki grants ${a.name} an Evade charge!`);
        });
      }
    }
  },
  "Moder": (() => {
    const strip = (card, G) => {
      card.onPlay = null; card.onDeath = null; card.onDamaged = null;
      card.onKill = null; card.onBeforeTricks = null; card.onBeforeAttack = null;
      card.onEndOfTurn = null; card.onAnyCardPlayed = null; card.onAllyKilled = null;
      card.onEvade = null; card.onDamagePlayer = null; card.onTurnStart = null;
      card.passive = null;
      card.evadeCharges = 0; card.armorValue = 0; card.isOverdrive = false;
      card.isBullseye = false; card.immunityCharges = 0; card.hasHunt = false;
      card.hasDamageImmunity = false; card.unresistibleCharges = 0;
      card.splashRange = 0; card.invincibleTurns = 0; card.tauntTurns = 0;
      if (!card.permanentUntrickable) card.isUntrickable = false;
      card._moderStripped = true;
      G.log(`Moder strips all abilities from ${card.name}!`);
    };
    return {
      onPlay(G, self, lane) {
        const opp = G.opponent(self.owner);
        // Force opponent's next card into Moder's lane. Do NOT strip anyone
        // already there — only the single forced arrival loses abilities.
        G.state[opp].forcedLane = lane;
        self._moderStripPending = true;
        G.log(`Moder compels the next enemy card into lane ${lane + 1}!`);
      },
      onAnyCardPlayed(G, self) {
        // Strip exactly one card: the first enemy that lands in Moder's lane
        // after he was played. Once consumed, no further cards are affected.
        if (!self._moderStripPending) return;
        const myLane = G.findCardLane(self);
        if (myLane < 0) return;
        const opp = G.opponent(self.owner);
        const enemy = G.state.lanes[myLane][opp];
        if (enemy && !enemy._moderStripped) {
          strip(enemy, G);
          self._moderStripPending = false;
        }
      }
    };
  })(),
  "Red Skull": {
    passive: "allowCardsInTricksPhase",
    onPlay(G, self, lane) {
      G.log(`Red Skull commands the field — character cards may be deployed during the trick phase while he stands.`);
      // Buff applies to ANY ally, not just villains. User spec: "red
      // skull should give an ally +2/+2 not just a villain". Lets
      // hero-leaning decks (e.g. Synergy Swarm) use Red Skull as the
      // tricks-phase enabler without a type-tax on which ally gets the
      // empower.
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id);
      const grant = (a) => {
        G.buffCard(a, 2, 2);
        G.log(`Red Skull empowers ${a.name} +2/+2!`);
      };
      if (allies.length) {
        G.promptCardChoice(self.owner, allies, "Red Skull — Empower", "Choose an ally to give +2/+2", grant,
          // AI picks the highest-cost ally — biggest absolute swing
          // from the +2/+2 (a 9-cost finisher gets disproportionately
          // more value from a flat buff than a 1-cost token).
          cards => cards.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0))[0]);
      }
    }
  },
  "Scarlet Witch": {
    // Hex-mirror: when she enters a lane, Scarlet Witch reads the enemy
    // directly opposite and ADOPTS their ATK and HP for this match.
    // Her base stats are 0/0 with the `copiesOpposite` flag set, which
    // tells the renderer to display "?" on her stat orbs while she
    // sits in hand. The flag is cleared the moment her stats resolve
    // here so subsequent renders show real numbers.
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      const enemy = G.state.lanes[lane] && G.state.lanes[lane][opp];
      if (enemy && enemy.currentHealth > 0) {
        const adoptAtk = enemy.attack || 0;
        const adoptHp  = enemy.currentHealth || enemy.maxHealth || 1;
        self.attack = adoptAtk;
        self.baseAttack = adoptAtk;
        self.currentHealth = adoptHp;
        self.maxHealth = adoptHp;
        self.baseHealth = adoptHp;
        self.copiesOpposite = false; // stats now known
        G.log(`Scarlet Witch hexes ${enemy.name} — becomes ${adoptAtk}/${adoptHp}!`);
      } else {
        // No enemy to copy — fall back to her old 3/4 fingerprint so she
        // isn't a permanent 0/0 dud when played into an empty lane.
        self.attack = 3;
        self.baseAttack = 3;
        self.currentHealth = 4;
        self.maxHealth = 4;
        self.baseHealth = 4;
        self.copiesOpposite = false;
        G.log(`Scarlet Witch finds nothing to copy — defaults to 3/4.`);
      }
    }
  },
  "Solomon Grundy": {
    onDeath(G, self, lane) {
      const allDead = [...G.state.player.deadPile, ...G.state.ai.deadPile];
      if (allDead.length) {
        const idx = Math.floor(Math.random() * allDead.length);
        let card;
        if (idx < G.state.player.deadPile.length) {
          card = G.state.player.deadPile.splice(idx, 1)[0];
        } else {
          card = G.state.ai.deadPile.splice(idx - G.state.player.deadPile.length, 1)[0];
        }
        G.addToHand(self.owner, G.createCardInstance(card, self.owner), self);
        G.log(`Solomon Grundy's death draws ${card.name} from the dead pile!`);
      }
    }
  },
  "Star-Lord": {
    onPlay(G, self, lane) {
      // Ally buff scales with tier: +1/+1, +2/+2, +3/+3, +4/+4.
      const buff = G.rarityValue(self, { common: 1, rare: 2, special: 3, legendary: 4 });
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id);
      const grant = (a) => {
        G.buffCard(a, buff, buff);
        G.log(`Star-Lord buffs ${a.name} +${buff}/+${buff}!`);
      };
      if (allies.length) {
        G.promptCardChoice(self.owner, allies, "Star-Lord — Buff", `Choose ally to give +${buff}/+${buff}`, grant);
      }
    }
  },
  "Symbiote Spider-Man": {
    onPlay(G, self, lane) {
      // Each card shuffles back to its OWNER's pile — in Deckbuilder this
      // is their personal deck, in Classic it's the shared pile (same ref).
      const shuffleBack = (card, ownerKey) => {
        G.getDrawPile(ownerKey).push({ name: card.name, cost: card.baseCost || card.cost, attack: card.attack, health: card.maxHealth, abilities: card.abilities, type: card.type, desc: card.desc });
      };
      const doPlayerShuffle = (p, onDone) => {
        const hand = G.state[p].hand;
        if (hand.length <= 2) {
          // 2 or fewer cards — shuffle all back automatically
          hand.splice(0).forEach(c => shuffleBack(c, p));
          G.shuffle(G.getDrawPile(p));
          G.drawCards(p, 2);
          G.log(`Symbiote Spider-Man: ${p} shuffles ${hand.length === 0 ? 'all' : 'all'} cards back and draws 2!`);
          if (onDone) onDone();
          return;
        }
        if (!Game.isHuman(p)) {
          // AI-controlled: pick 2 lowest-cost cards to shuffle back
          hand.sort((a, b) => a.cost - b.cost);
          for (let i = 0; i < 2; i++) {
            shuffleBack(hand.shift(), p);
          }
          G.shuffle(G.getDrawPile(p));
          G.drawCards(p, 2);
          G.log(`Symbiote Spider-Man: ${p} shuffles 2 cards back and draws 2!`);
          if (onDone) onDone();
        } else {
          // Human: picks each card via prompt
          G.promptCardChoice(p, [...hand], "Symbiote Spider-Man — Shuffle", "Choose 1st card to shuffle back into the deck (pick 2 total)", (c1) => {
            const idx1 = hand.findIndex(c => c.id === c1.id);
            if (idx1 >= 0) hand.splice(idx1, 1);
            shuffleBack(c1, p);
            G.promptCardChoice(p, [...hand], "Symbiote Spider-Man — Shuffle", "Choose 2nd card to shuffle back into the deck", (c2) => {
              const idx2 = hand.findIndex(c => c.id === c2.id);
              if (idx2 >= 0) hand.splice(idx2, 1);
              shuffleBack(c2, p);
              G.shuffle(G.getDrawPile(p));
              G.drawCards(p, 2);
              G.log("Symbiote Spider-Man: You shuffle 2 cards back and draw 2!");
              if (onDone) onDone();
            });
          });
        }
      };
      // Process owner first, then opponent, then heal
      const opp = G.opponent(self.owner);
      doPlayerShuffle(self.owner, () => {
        doPlayerShuffle(opp, () => {
          G.healPlayer(self.owner, 2, self);
          G.log("Symbiote Spider-Man heals you for 2!");
        });
      });
    }
  },
  "Winter Soldier": {
    onPlay(G, self, lane) {
      const targets = G.getEnemiesOf(self.owner).filter(c => c.attack <= 3);
      if (targets.length) {
        G.promptCardChoice(self.owner, targets, "Winter Soldier — Eliminate", "Choose enemy with 3 or less ATK to destroy", (t) => {
          G.log(`Winter Soldier eliminates ${t.name}!`); G.killCard(t, self);
        }, _aiThreatPicker);
      }
    },
    onKill(G, self) {
      G.buffCard(self, 1, 1);
      G.log(`Winter Soldier toughens! +1/+1 → ${self.attack}/${self.currentHealth}`);
    }
  },

  // ==================== COST 4 ====================
  "Anti-Venom": {
    onPlay(G, self, lane) {
      G.healPlayer(self.owner, 4, self);
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id);
      const open = G.getOpenLanes(self.owner);
      if (allies.length && open.length) {
        const doMove = (ally) => {
          const from = G.findCardLane(ally);
          if (from >= 0) {
            if (Game.isHuman(self.owner)) {
              G.promptLaneChoice(self.owner, open, `Move ${ally.name}`, `Choose new lane for ${ally.name}`, (l) => {
                G.moveCard(ally, from, l);
              });
            } else {
              G.moveCard(ally, from, open[0]);
            }
          }
        };
        if (Game.isHuman(self.owner)) {
          G.promptCardChoice(self.owner, allies, "Anti-Venom — Move", "Choose ally to move", doMove);
        } else {
          doMove(allies[0]);
        }
      }
      G.log("Anti-Venom heals you for 4!");
    }
  },
  "Black Panther": {
    onPlay(G, self, lane) {
      const hand = G.state[self.owner].hand;
      const freeCards = hand.filter(c => (c.baseCost != null ? c.baseCost : c.cost) <= 3 && !c.isDiscardEffect);
      if (freeCards.length) {
        const playFree = (freeCard) => {
          const open = G.getOpenLanes(self.owner);
          if (open.length) {
            if (Game.isHuman(self.owner)) {
              // Pass `freeCard` as previewCard so the lane-placement
              // damage preview shows the trade math against each lane's
              // opposing enemy. User report: "you play a card i want
              // it to be the live simulation... if i were to play
              // raven it doesnt show anything." Without previewCard,
              // lc.previewCard is null and makeDamagePreview never
              // runs in the lane-choice render path. Same fix pattern
              // as summonCardChoice (which already passes a
              // synthetic previewCard for Hela / Cyborg / Ant-Man).
              G.promptLaneChoice(self.owner, open, `Play ${freeCard.name} free`, `Black Panther plays ${freeCard.name} for free — choose lane`, (l) => {
                G.playCardFree(self.owner, freeCard, l);
                G.log(`Black Panther plays ${freeCard.name} free!`);
              }, self.owner, freeCard);
            } else {
              G.playCardFree(self.owner, freeCard, open[0]);
              G.log(`Black Panther plays ${freeCard.name} free!`);
            }
          }
        };
        if (Game.isHuman(self.owner)) {
          G.promptCardChoice(self.owner, freeCards, "Black Panther — Free Play", "Choose a card with base cost 3 or less to play free", playFree,
            cards => cards.slice().sort((a, b) => (b.baseCost || b.cost) - (a.baseCost || a.cost))[0]);
        } else {
          const best = freeCards.slice().sort((a, b) => (b.baseCost || b.cost) - (a.baseCost || a.cost))[0];
          playFree(best);
        }
      }
    },
    passive: "cardPlayedBuff"
  },
  "Cyborg": {
    onDeath(G, self, lane) {
      const hand = G.state[self.owner].hand;
      if (!hand.length) return;
      // Filter out discard-effect cards (Catwoman, Loki, etc.) — they
      // have 0/0 stats and would land as a dead body with no discard
      // trigger firing, since Cyborg's last-act path bypasses the
      // hand-discard step. User report: "Catwoman was summoned onto
      // board from a summon — that's a bug."
      const eligible = hand.filter(c => !c.isDiscardEffect);
      if (!eligible.length) return;
      // Clear Cyborg from the slot so the new card can take its place
      if (G.state.lanes[lane] && G.state.lanes[lane][self.owner] === self) {
        G.state.lanes[lane][self.owner] = null;
      }
      const card = eligible[Math.floor(Math.random() * eligible.length)];
      const handIdx = hand.indexOf(card);
      if (handIdx >= 0) hand.splice(handIdx, 1);
      // Look up the full card definition so onPlay / passives fire like a normal play
      const def = (typeof CARD_DEFS !== 'undefined' && CARD_DEFS.find(d => d.name === card.name)) || card;
      G.log(`Cyborg's last act: summoning ${card.name} from your hand!`);
      G.summonCard(
        self.owner, lane, card.name,
        card.baseCost || card.cost,
        card.attack,
        card.maxHealth || card.health,
        card.abilities || [],
        def
      );
    }
  },
  "Deadpool": {
    // onPlay Taunt removed per balance pass. Deadpool now has no onPlay;
    // his kit is purely the onDeath face-down card swap.
    onDeath(G, self, lane) {
      const opp = G.opponent(self.owner);
      const enemyHand = G.state[opp].hand;
      if (!enemyHand.length) {
        G.log("Deadpool's final trick fails — the enemy has no cards in hand!");
        return;
      }
      // Step 1: Show enemy hand face-down, shuffled so the player can't
      // infer which card is which from positional hints.
      const faceDownDeck = enemyHand.slice();
      for (let i = faceDownDeck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [faceDownDeck[i], faceDownDeck[j]] = [faceDownDeck[j], faceDownDeck[i]];
      }
      G.promptCardChoice(self.owner, faceDownDeck,
        "Deadpool's Final Trick",
        "Pick a face-down card from the enemy's hand to steal",
        (stolen) => {
          const idx = G.state[opp].hand.indexOf(stolen);
          if (idx >= 0) G.state[opp].hand.splice(idx, 1);
          stolen.owner = self.owner;
          G.addToHand(self.owner, stolen, self);
          G.log(`Deadpool steals ${stolen.name} from the enemy's hand!`);

          // Step 2: Player picks a card from their own hand to give to the enemy.
          const myHand = G.state[self.owner].hand.slice();
          if (!myHand.length) {
            G.log("Deadpool has no cards to give in return.");
            return;
          }
          G.promptCardChoice(self.owner, myHand,
            "Deadpool's Trade",
            "Choose a card from your hand to give to the enemy",
            (given) => {
              const gIdx = G.state[self.owner].hand.indexOf(given);
              if (gIdx >= 0) G.state[self.owner].hand.splice(gIdx, 1);
              given.owner = opp;
              G.addToHand(opp, given);
              G.log(`Deadpool slips ${given.name} into the enemy's hand!`);
            },
            cards => cards.slice().sort((a, b) => (a.baseCost || a.cost) - (b.baseCost || b.cost))[0]);
        },
        cards => cards[Math.floor(Math.random() * cards.length)],
        { faceDown: true });
    }
  },
  "Green Lantern": {
    // The currencyOnDamage passive is recognized inside Game.applyCombatDamage and
    // Game.damagePlayer (game.js). Those sites accumulate landed damage on
    // self._damageDealtThisTurn — only damage that wasn't negated by Evade,
    // Invincible, Damage Immunity, full-Armor absorption, Mr Freeze health freeze,
    // or Block Meter. We harvest that total here at end of round.
    //
    // SPEC: bonus energy is applied for the IMMEDIATELY FOLLOWING round only, then
    // resets to 0. Each round recalculates fresh based only on that round's damage.
    // Bonus energy must NOT carry over or stack across multiple rounds.
    //
    // ENFORCEMENT (three guards):
    //   1. Flag harvested + zeroed here at end of round.
    //   2. nextTurnCurrency bucket consumed + zeroed in Game.startRound.
    //   3. Flag defensively re-zeroed at the top of Game.startRound (handles edge
    //      cases like a GL that died mid-combat and is later revived).
    passive: "currencyOnDamage",
    onEndOfTurn(G, self) {
      const dmg = self._damageDealtThisTurn || 0;
      self._damageDealtThisTurn = 0;
      if (dmg > 0) {
        G.addNextTurnCurrency(self.owner, dmg);
        G.log(`Green Lantern channels ${dmg} damage into +${dmg} energy next round!`);
      }
    },
    // If Green Lantern dies during combat (e.g. takes lethal damage AFTER
    // his swing lands), onEndOfTurn in postCombat won't fire for him
    // because getAllCardsOnBoard() filters out dead cards. Harvest here
    // so his accumulated damage still banks for next round — the player
    // spec is explicit: "green lantern isnt gaining the extra energy from
    // his damage if he dies but he should". The mirror-flag in
    // onEndOfTurn still zeroes the counter if he survived; only one
    // path harvests per round.
    onDeath(G, self) {
      const dmg = self._damageDealtThisTurn || 0;
      self._damageDealtThisTurn = 0;
      if (dmg > 0) {
        G.addNextTurnCurrency(self.owner, dmg);
        G.log(`Green Lantern's last act: +${dmg} energy channeled to next round!`);
      }
    }
  },
  "Jason Voorhees": {
    onDeath(G, self, lane) {
      // Jason revives ONCE PER GAME (not per-instance). If a prior Jason
      // already revived this game, subsequent plays/jumps get no revive.
      // Flag lives on the owner's state so a freshly-played Jason can't
      // "reset" the revive by being a new instance.
      if (G.state[self.owner].jasonReviveUsed) {
        return; // already used this game
      }
      if (self.reviveCharges > 0) {
        self.reviveCharges--;
        G.state[self.owner].jasonReviveUsed = true;
        self.attack += 1; self.maxHealth += 2; self.currentHealth = self.maxHealth;
        G.placeInLane(self.owner, self, lane);
        // Revive bypasses Game.playCard, so the registry-based play cue
        // wouldn't auto-fire here — call it explicitly so the ki-ki-ki /
        // ma-ma-ma sting lands on resurrection too.
        if (typeof UI !== 'undefined' && UI.sfx) UI.sfx.playCardSfx('Jason Voorhees', 'play');
        G.log(`Jason Voorhees rises again as ${self.attack}/${self.maxHealth} (once per game)`);
        return true;
      }
    }
  },
  "Kang": {
    onPlay(G, self, lane) {
      // Kang peeks the OWNER's pile (Classic = shared, Deckbuilder = personal).
      const pile = G.getDrawPile(self.owner);
      if (pile.length < 2) {
        G.drawCards(self.owner, Math.min(2, pile.length));
        G.log("Kang manipulates time! Not enough cards for full effect.");
        return;
      }
      const card1 = pile.pop();
      const card2 = pile.pop();
      if (Game.isHuman(self.owner)) {
        G.state.pendingKangChoice = { owner: self.owner, cards: [card1, card2], kangCard: self };
        UI.render();
        G._startPromptTimeout(() => {
          const kc = G.state.pendingKangChoice;
          if (!kc) return;
          const idx = kc.cards[0].cost >= kc.cards[1].cost ? 0 : 1;
          if (typeof kangChoicePick === 'function') { kangChoicePick(idx); }
        });
      } else {
        const pick = card1.cost >= card2.cost ? card1 : card2;
        const other = pick === card1 ? card2 : card1;
        pile.push(other);
        const card = G.createCardInstance(pick, self.owner);
        card.cost = Math.max(0, card.cost - 2);
        G.addToHand(self.owner, card, self);
        G.log(`Kang keeps ${card.name} (cost reduced to ${card.cost})`);
        if (card.cost <= 2) {
          const open = G.getOpenLanes(self.owner);
          if (open.length && !card.isDiscardEffect) {
            G.playCardFree(self.owner, card, open[0]);
          }
        }
      }
    }
  },
  "Martian Manhunter": {
    onPlay(G, self, lane) {
      const allDead = [...G.state.player.deadPile, ...G.state.ai.deadPile];
      if (!allDead.length) return;
      const dead = allDead[Math.floor(Math.random() * allDead.length)];

      // Copy string abilities (but keep Evade 1)
      if (dead.abilities) {
        dead.abilities.forEach(ab => { if (!self.abilities.includes(ab)) self.abilities.push(ab); });
        G.applyAbilities(self);
      }

      // Copy all callbacks and passive from CARD_ABILITIES (authoritative source)
      const abilityDef = CARD_ABILITIES[dead.name];
      if (abilityDef) {
        if (abilityDef.onDeath) self.onDeath = abilityDef.onDeath;
        if (abilityDef.onDamaged) self.onDamaged = abilityDef.onDamaged;
        if (abilityDef.onKill) self.onKill = abilityDef.onKill;
        if (abilityDef.onBeforeTricks) self.onBeforeTricks = abilityDef.onBeforeTricks;
        if (abilityDef.onBeforeAttack) self.onBeforeAttack = abilityDef.onBeforeAttack;
        if (abilityDef.onEndOfTurn) self.onEndOfTurn = abilityDef.onEndOfTurn;
        if (abilityDef.onAnyCardPlayed) self.onAnyCardPlayed = abilityDef.onAnyCardPlayed;
        if (abilityDef.onAllyKilled) self.onAllyKilled = abilityDef.onAllyKilled;
        if (abilityDef.onEvade) self.onEvade = abilityDef.onEvade;
        if (abilityDef.onDamagePlayer) self.onDamagePlayer = abilityDef.onDamagePlayer;
        if (abilityDef.onTurnStart) self.onTurnStart = abilityDef.onTurnStart;
        if (abilityDef.passive) {
          self.passive = abilityDef.passive;
          // Activate "While Active" passives immediately
          if (self.passive === 'faceDownOption') G.state[self.owner].faceDownAvailable = true;
        }
      } else {
        // Fallback: copy from dead pile entry
        if (dead.onDeath) self.onDeath = dead.onDeath;
        if (dead.onDamaged) self.onDamaged = dead.onDamaged;
        if (dead.onKill) self.onKill = dead.onKill;
        if (dead.passive) self.passive = dead.passive;
      }

      self.desc = `Copied ${dead.name}: ${dead.desc || (dead.abilities || []).join(', ')}`;
      G.log(`Martian Manhunter copies ${dead.name}'s abilities! Keeps ${self.attack}/${self.currentHealth} + Evade`);

      // Fire the copied card's onPlay as if it was just played
      if (abilityDef && abilityDef.onPlay) {
        try { abilityDef.onPlay(G, self, lane); } catch (e) { console.error(e); }
      }
    }
  },
  "Optimus Prime": {
    onPlay(G, self, lane) {
      const own = self.owner;
      const adj = [];
      if (lane > 0 && G.state.lanes[lane-1][own]) adj.push(G.state.lanes[lane-1][own]);
      if (lane < Game.LANE_COUNT-1 && G.state.lanes[lane+1][own]) adj.push(G.state.lanes[lane+1][own]);
      if (adj.length) {
        const doAttack = (ally) => {
          const opp = G.opponent(self.owner);
          let targets = [];
          const oppLane = G.state.lanes[lane][opp];
          if (oppLane && oppLane.currentHealth > 0) targets.push(oppLane);
          G.getAdjacentEnemiesInContext(lane, self.owner).forEach(e => { if (e.currentHealth > 0 && !targets.includes(e)) targets.push(e); });
          if (Game.isHuman(self.owner) && targets.length) {
            G.promptCardChoice(self.owner, targets, "Optimus — Target", `Choose enemy for ${ally.name} to attack`, (target) => {
              G.dealDamage(target, ally.attack, ally);
              G.log(`Optimus commands ${ally.name} to attack ${target.name} for ${ally.attack}!`);
            });
          } else if (targets.length) {
            G.dealDamage(targets[0], ally.attack, ally);
            G.log(`Optimus commands ${ally.name} to attack ${targets[0].name} for ${ally.attack}!`);
          }
        };
        if (Game.isHuman(self.owner)) {
          G.promptCardChoice(self.owner, adj, "Optimus — Choose Ally", "Choose adjacent ally to command", doAttack);
        } else {
          doAttack(adj[0]);
        }
      }
    }
  },
  "Predator": {
    onPlay(G, self, lane) {
      const enemies = G.getEnemiesOf(self.owner);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Predator — Strike", "Choose enemy to deal 3 damage", (t) => {
          G.dealDamage(t, 3);
          G.log(`Predator strikes ${t.name} for 3!`);
          if (t.currentHealth <= 0) {
            G.buffCard(self, 1, 0);
            G.log(`Predator claims a trophy! +1 ATK → ${self.attack}`);
          }
        }, cards => _aiKillPicker(cards, 3));
      }
    },
    onKill(G, self) {
      G.buffCard(self, 1, 0);
      G.log(`Predator claims a trophy! +1 ATK → ${self.attack}`);
    }
  },
  "Michael Myers": {
    // Jump mechanic — actual logic lives in Game.checkJumpConditions / Game.playJumpCard.
    // When Played: lone-wolf bonus. If no other allies are on the board when he arrives,
    // Michael Myers is at his deadliest — +1/+1.
    onPlay(G, self, lane) {
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id && a.currentHealth > 0);
      if (!allies.length) {
        G.buffCard(self, 1, 1);
        G.log(`Michael Myers stalks alone — +1/+1!`);
      }
    },
    onDeath(G, self) { self.jumpReady = false; self.jumpLane = undefined; }
  },
  "Raven": {
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      G.state[opp].blockMeter = 0;
      G.log(`Raven empties the opponent's Block Meter!`);
      G.getAlliesOf(self.owner).forEach(a => {
        // Clear counters AND booleans together — debuff stacking
        // refactor uses counters as the source of truth.
        a.stunnedTurns = 0; a.isStunned = false;
        a.frozenTurns  = 0; a.isFrozen  = false;
      });
      G.log("Raven cleanses all allies!");
    }
  },
  "The Grinch": {
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      const th = G.state[opp].trickHand;
      if (!th.length) {
        // No tricks to steal — triple stats
        self.attack *= 3; self.currentHealth *= 3; self.maxHealth *= 3;
        G.log(`The Grinch finds nothing to steal — stats tripled! ${self.attack}/${self.currentHealth}`);
        return;
      }
      // Two choices in sequence, each gated on a different seat's isHuman:
      //   1. OPP picks which trick to give up (human → prompt; AI → lowest cost)
      //   2. Grinch OWNER picks keep-or-give-back (human → prompt; AI → threshold)
      const resolveGrinchChoice = (chosen) => {
        const idx = th.findIndex(t => t.name === chosen.name);
        if (idx >= 0) th.splice(idx, 1);
        const keep = () => {
          chosen.cost += 1;
          G.addToTrickHand(self.owner, chosen);
          G.log(`The Grinch keeps ${chosen.name} (cost +1)!`);
        };
        const giveBack = () => {
          G.addToTrickHand(opp, chosen);
          self.attack *= 3; self.currentHealth *= 3; self.maxHealth *= 3;
          G.log(`The Grinch gives back ${chosen.name} — stats tripled! ${self.attack}/${self.currentHealth}`);
        };
        if (Game.isHuman(self.owner)) {
          // Human Grinch owner picks keep-or-giveback via modal
          G.state.pendingCardChoice = {
            owner: self.owner,
            cards: [
              { name: `Keep ${chosen.name}`, desc: `Add to your tricks (cost +1, becomes ${chosen.cost + 1})`, _action: 'keep' },
              { name: "Give it back", desc: "Return the trick — Grinch's stats triple!", _action: 'giveback' }
            ],
            title: "The Grinch — Keep or Discard?",
            description: `Stole ${chosen.name}. Keep or discard?`,
            callback(pick) { pick._action === 'keep' ? keep() : giveBack(); }
          };
          if (typeof UI !== 'undefined' && UI.render) UI.render();
        } else {
          // AI Grinch owner: keep valuable tricks, give back cheap ones
          if (chosen.cost >= 2) keep(); else giveBack();
        }
      };
      if (Game.isHuman(opp)) {
        // Human opp picks which trick to give up
        G.promptCardChoice(opp, [...th], "The Grinch — Steal", "The Grinch is stealing! Choose a trick to give up", resolveGrinchChoice);
      } else {
        // AI opp auto-picks lowest cost to minimize value lost
        const sorted = [...th].sort((a, b) => a.cost - b.cost);
        resolveGrinchChoice(sorted[0]);
      }
    }
  },
  "Venom": {
    onPlay(G, self, lane) {
      const enemies = G.getEnemiesOf(self.owner);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Venom — Freeze", "Choose enemy to freeze", (e) => {
          G.freezeCard(e, self);
        }, _aiThreatPicker);
      }
    },
    onBeforeTricks(G, self, lane) {
      if (self.venomHealed) return;          // fires exactly once per instance
      const ct = G.getAlliesOf(self.owner).length;
      if (ct > 0) {
        G.healPlayer(self.owner, ct, self);
        G.log(`Venom heals you for ${ct}!`);
        self.venomHealed = true;
      }
    }
  },
  "Wolverine": {
    onDamaged(G, self, attacker) {
      if (attacker && (attacker.baseCost || attacker.cost) <= 7) { G.killCard(attacker, self); G.log(`Wolverine slays ${attacker.name}!`); }
    },
    onDeath(G, self, lane) {
      if (self.reviveCharges > 0) {
        self.reviveCharges--;
        self.attack = 6; self.currentHealth = 5; self.maxHealth = 5;
        self.isOverdrive = true;
        self.justResurrected = true;
        // While-Active passive (onDamaged "destroy attacker cost ≤ 7") is
        // intentionally DISABLED on revive. User spec: "Wolverine's
        // while active needs to disable upon revive." Trade-off: he
        // comes back with raw 6/5 Overdrive stats but no retaliation
        // retort, so the second life is offensive-only — no more
        // double-dipping his "any attacker dies" passive across two
        // bodies in the same match.
        self.onDamaged = null;
        G.placeInLane(self.owner, self, lane);
        G.log(`Wolverine revives as 6/5 Overdrive! Berserker rage spent — no retaliation. (Revive ${self.reviveCharges} left)`);
        return true;
      }
    }
  },
  "Wonder Woman": {
    onPlay(G, self, lane) {
      const e = G.state.lanes[lane] ? G.state.lanes[lane][G.opponent(self.owner)] : null;
      if (e) { G.stunCard(e, self); }
      G.state[self.owner].blockMeter = Math.min(Game.BLOCK_MAX, G.state[self.owner].blockMeter + 2);
      G.log(`Wonder Woman stuns ${e ? e.name : 'nothing'} and adds 2 Block Meter!`);
    },
    onBeforeAttack(G, self) {
      const chainDmg = self.attack - 1;
      if (chainDmg <= 0) return;
      const myLane = G.findCardLane(self);
      if (myLane < 0) return;
      // Chain only fires when Wonder Woman's main swing lands on an
      // enemy CARD. If her lane is uncontested (swing goes to HP bar),
      // the lasso has no card to ricochet off of — skip the chain.
      // User spec: "Chain only happens between cards. If Wonder Woman
      // hits the health bar, her damage does not chain to an adjacent
      // enemy. Same goes for any chain — card-to-card only."
      const opp = G.opponent(self.owner);
      const target = G.state.lanes[myLane][opp];
      if (!target || target.currentHealth <= 0) return;
      G.log(`Wonder Woman's lasso chains — ${chainDmg} chain damage!`);
      G.autoChainDamage(self.owner, myLane, chainDmg, 0, null, "LASSO CHAIN");
    }
  },

  // ==================== COST 5 ====================
  "Aquaman": {
    onPlay(G, self, lane) {
      G.summonCardChoice(self.owner, "Creature of the Deep", 4, 5, 3, []);
    }
  },
  "Captain America": {
    onPlay(G, self, lane) {
      // Discount-amount scales with tier: 1 / 1 / 2 / 2.
      const disc = G.rarityValue(self, { common: 1, rare: 1, special: 2, legendary: 2 });
      let count = 0;
      G.state[self.owner].hand.forEach(card => {
        if (card.cost > 0) {
          const amt = Math.min(disc, card.cost);
          card.cost -= amt;
          card._capAmericaDiscount = (card._capAmericaDiscount || 0) + amt;
          count++;
        }
      });
      G.log(`Captain America rallies the team — ${count} card${count === 1 ? '' : 's'} in hand cost ${disc} less!`);
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id);
      const grant = (a) => {
        a.invincibleTurns = Math.max(a.invincibleTurns || 0, 1);
        G.log(`Captain America shields ${a.name} — Invincible for 1 turn!`);
      };
      if (allies.length) {
        G.promptCardChoice(self.owner, allies, "Captain America — Shield", "Choose an ally to grant Invincible 1", grant,
          cards => cards.sort((a, b) => b.attack - a.attack)[0]);
      }
    },
    onDeath(G, self, lane) {
      let count = 0;
      G.state[self.owner].hand.forEach(card => {
        if (card._capAmericaDiscount > 0) {
          card.cost += 1;
          card._capAmericaDiscount -= 1;
          count++;
        }
      });
      G.log(`Captain America falls — the cost reduction fades from ${count} card${count === 1 ? '' : 's'}.`);
    },
    passive: "allyCostReduction"
  },
  "Iron Man": {
    trickPhasePlayable: true,
    onPlay(G, self, lane) {
      // Cost gate scales: kills any DAMAGED enemy with cost ≤ N.
      //   common: ≤ 5    rare: ≤ 8    special: ≤ 9    legendary: any cost
      const maxCost = G.rarityValue(self, { common: 5, rare: 8, special: 9, legendary: 99 });
      G.getEnemiesOf(self.owner)
        .filter(e => e.currentHealth < e.maxHealth && (e.baseCost || e.cost) <= maxCost)
        .forEach(t => {
          G.log(`Iron Man finishes off ${t.name}!`); G.killCard(t, self);
        });
    }
  },
  "Joker": {
    // Joker has Insane (his own ATK rolls 2-7 each turn — handled by the
    // Crazy/Insane reroll sweep in game.startRound) and stamps Crazy on
    // the highest-ATK enemy. The Crazy stamp is persistent on that enemy
    // for as long as Joker is alive — a per-round sweep handles re-rolls.
    //
    // STAMP TIMING (user spec): the per-round stamp fires at Start of
    // Tricks, NOT Start of Round. Two reasons:
    //   1. The play phase happens AFTER start-of-round, so a stamp at
    //      onTurnStart picks the top-ATK enemy *before* the AI plays any
    //      new threats this round. Moving to onBeforeTricks ensures the
    //      stamp lands on the strongest enemy ON THE BOARD AT THE TIME
    //      tricks resolve — which is what the player actually faces.
    //   2. The user wants Joker to ALWAYS have a Crazy target on the
    //      board while he's alive. We also re-stamp at onEndOfTurn so
    //      that if the current target dies in combat, the next-highest
    //      enemy gets the stamp before the player sees the next round's
    //      board — no "no-target" gaps.
    //
    // _recurringBT lets onBeforeTricks fire EVERY round (not just the
    // round Joker entered). Without this flag, beforeTricksFired locks
    // the hook to one trigger per instance and the per-round stamp
    // would only land once.
    _recurringBT: true,
    onPlay(G, self, lane) {
      // Fear cost gate scales with tier. Common: ≤2, Rare: ≤4 (listed),
      // Special: ≤6, Legendary: ≤9. Joker stays a chaos enabler at all
      // tiers — the Crazy stamp on top-ATK enemy fires regardless.
      const fearGate = G.rarityValue(self, { common: 2, rare: 4, special: 6, legendary: 9 });
      const eligible = G.getEnemiesOf(self.owner).filter(e => (e.baseCost || e.cost) <= fearGate);
      if (eligible.length) {
        G.promptCardChoice(self.owner, eligible,
          "Joker — Fear",
          `Choose an enemy with base cost ${fearGate} or less to apply Fear to`,
          (t) => {
            G.fearCard(t, self);
            G.log(`Joker terrifies ${t.name}!`);
          },
          cards => cards.slice().sort((a, b) => b.attack - a.attack)[0]);
      }
      G.rerollCrazyInsane(self);
      CARD_ABILITIES.Joker._stampTopEnemyCrazy(G, self);
    },
    onBeforeTricks(G, self) {
      // Start of Tricks — re-stamp the top-ATK enemy (post-plays). The
      // reroll itself happens in the central sweep in startRound.
      CARD_ABILITIES.Joker._stampTopEnemyCrazy(G, self);
    },
    onEndOfTurn(G, self) {
      // Post-combat — if the previous Crazy target died in this round's
      // combat, immediately stamp the next-highest enemy so Joker's
      // While Active never has a "no target" gap. No-op if a target
      // already carries Crazy (the _stampTopEnemyCrazy guard handles it).
      CARD_ABILITIES.Joker._stampTopEnemyCrazy(G, self);
    },
    onDeath(G, self) {
      // When Joker dies, strip the Crazy stamp from any enemies he had
      // infected — their ATK freezes at its current rolled value (the
      // trait no longer forces a per-round reroll).
      G.getAllCardsOnBoard().forEach(c => {
        if (c._crazyAppliedBy) {
          c.isCrazy = false;
          delete c._crazyAppliedBy;
          G.log(`  [CRAZY] ${c.name} is no longer Crazy — Joker is gone.`);
        }
      });
    },
    _stampTopEnemyCrazy(G, self) {
      const enemies = G.getAllCardsOf(G.opponent(self.owner)).filter(e => e.currentHealth > 0);
      if (!enemies.length) return;
      const top = enemies.slice().sort((a, b) => (b.attack || 0) - (a.attack || 0))[0];
      if (!top) return;
      if (top.isCrazy) return; // already Crazy — the sweep will reroll
      G.applyCrazyToCard(top);
      G.log(`Joker's chaos stamps Crazy on ${top.name}!`);
    }
  },
  "Lex Luthor": {
    passive: "preventDraw"
  },
  "Professor X": {
    isDiscardEffect: true,
    onDiscard(G, owner) {
      const opp = G.opponent(owner);
      const enemies = G.getEnemiesOf(owner).filter(e => (e.baseCost != null ? e.baseCost : e.cost) <= 4);
      if (!enemies.length) return;
      G.promptCardChoice(owner, enemies, "Professor X — Convert", "Choose enemy with base cost 4 or less to permanently join your team", (t) => {
        const oldLane = G.findCardLane(t);
        if (oldLane >= 0) G.state.lanes[oldLane][opp] = null;
        t.owner = owner;
        // Re-apply full card abilities (callbacks, passive, etc.) from CARD_ABILITIES.
        // This restores any callbacks that may have been cleared (e.g. face-down cards).
        const abilityDef = CARD_ABILITIES[t.name];
        if (abilityDef) {
          if (abilityDef.onPlay) t.onPlay = abilityDef.onPlay;
          if (abilityDef.onDeath) t.onDeath = abilityDef.onDeath;
          if (abilityDef.onDamaged) t.onDamaged = abilityDef.onDamaged;
          if (abilityDef.onKill) t.onKill = abilityDef.onKill;
          if (abilityDef.onBeforeTricks) t.onBeforeTricks = abilityDef.onBeforeTricks;
          if (abilityDef.onBeforeAttack) t.onBeforeAttack = abilityDef.onBeforeAttack;
          if (abilityDef.onEndOfTurn) t.onEndOfTurn = abilityDef.onEndOfTurn;
          if (abilityDef.onAnyCardPlayed) t.onAnyCardPlayed = abilityDef.onAnyCardPlayed;
          if (abilityDef.onAllyKilled) t.onAllyKilled = abilityDef.onAllyKilled;
          if (abilityDef.onEvade) t.onEvade = abilityDef.onEvade;
          if (abilityDef.onDamagePlayer) t.onDamagePlayer = abilityDef.onDamagePlayer;
          if (abilityDef.onTurnStart) t.onTurnStart = abilityDef.onTurnStart;
          if (abilityDef.passive) t.passive = abilityDef.passive;
        }
        G.applyAbilities(t);
        // Clear face-down state if the card was face-down
        if (t.isFaceDown) {
          t.isFaceDown = false;
          delete t._faceDownOriginals;
        }
        G.log(`Professor X converts ${t.name} to your team!`);
        const open = G.getOpenLanes(owner);
        if (!open.length) return;
        G.promptLaneChoice(owner, open, `Place ${t.name}`, `Choose a lane for ${t.name}`, (l) => {
          G.state.lanes[l][owner] = t;
          G.log(`${t.name} joins your side in lane ${l + 1}!`);
          // "Its abilities reactivate" — re-fire When Played, the
          // cross-board aura sweep, and any cardPlayedBuff passive,
          // and resolve the Draw N keyword. Mirrors the same trio
          // that summonCard fires for fresh card arrivals so a
          // converted Ghostface re-summons its Bullseye token, a
          // converted Hela re-summons her Undead Warriors, etc.
          // User report: "professor x isnt reactivateing cards when
          // played abilites on my side like ghostface".
          G.getAllCardsOnBoard().forEach(c => {
            if (c.onAnyCardPlayed && c.id !== t.id) c.onAnyCardPlayed(G, c);
          });
          G.getAllCardsOf(owner).forEach(c => {
            if (c.passive === 'cardPlayedBuff' && c.id !== t.id) G.buffCard(t, 1, 1);
          });
          G._runHook(t, 'onPlay', G, t, l);
          if (t.drawOnPlay > 0) {
            const n = t.drawOnPlay;
            t.drawOnPlay = 0;
            const before = G.state[owner].hand.length;
            G.drawCards(owner, n);
            const drawn = G.state[owner].hand.length - before;
            if (drawn > 0) G._creditChain(t, 'statsCardAdvantage', drawn);
            G.log(`${t.name} draws ${n} card${n > 1 ? 's' : ''}.`);
          }
        });
      }, cards => cards.sort((a, b) => (b.baseCost || b.cost) - (a.baseCost || a.cost))[0]);
    }
  },
  "Red Hulk": {
    // 4th param `actual` is the damage that actually landed (after
    // armor / reductions) — matches the desc "Splash THAT damage
    // back" rather than the attacker's raw stat. dealDamage passes
    // it as the 4th arg. Falls back to attacker.attack if actual
    // wasn't supplied (e.g. legacy callers).
    onDamaged(G, self, attacker, actual) {
      const dmg = (typeof actual === 'number' && actual > 0)
        ? actual
        : (attacker ? attacker.attack : 1);
      if (dmg <= 0) return;
      G.state[self.owner].blockMeter = Math.min(Game.BLOCK_MAX, G.state[self.owner].blockMeter + dmg);
      G.log(`Red Hulk adds ${dmg} to Block Meter!`);
      const lane = G.findCardLane(self);
      if (lane >= 0) {
        G.splashDamage(lane, self.owner, dmg);
        G.log(`Red Hulk splashes for ${dmg}!`);
      }
    }
  },
  "Spider-Man": {
    onPlay(G, self, lane) {
      const enemies = G.getEnemiesOf(self.owner);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Spider-Man — Freeze", "Choose enemy to freeze", (t) => {
          G.freezeCard(t, self); G.log(`Spider-Man freezes ${t.name}!`);
        }, _aiThreatPicker);
      }
    },
    onEvade(G, self) {
      G.buffCard(self, 1, 1);
      G.log(`Spider-Man evades and grows! +1/+1`);
      if (Math.random() < 0.5) {
        self.evadeCharges += 1;
        G.log(`Spider-Man's spider-sense tingles! Extra evade charge!`);
      }
    }
  },
  "The Batman Who Laughs": {
    onPlay(G, self, lane) {
      // Only 1 intercept per owner per game. Second+ BWLs on the same
      // side still land as bodies but don't arm another steal.
      if (G.state[self.owner].bwlInterceptUsed) {
        G.log("Batman Who Laughs arrives — but his hex has already been spent this game.");
        return;
      }
      G.state[G.opponent(self.owner)].nextCardStolen = true;
      G.log("Batman Who Laughs lurks... next enemy card will be intercepted!");
    }
  },

  // ==================== COST 6 ====================
  "Hela": {
    onPlay(G, self, lane) {
      // Tiered: number of Undead Warriors summoned + dead-pile pulls.
      //   common    → 1 zombie, 1 dead-pile draw
      //   rare      → 2 zombies, 1 dead-pile draw (listed)
      //   special   → 2 zombies, 2 dead-pile draws
      //   legendary → 3 zombies, 2 dead-pile draws
      const zombies = G.rarityValue(self, { common: 1, rare: 2, special: 2, legendary: 3 });
      const pulls   = G.rarityValue(self, { common: 1, rare: 1, special: 2, legendary: 2 });
      let summonCount = 0;
      const drawFromDead = (n) => {
        for (let i = 0; i < n; i++) {
          const allDead = [...G.state.player.deadPile, ...G.state.ai.deadPile];
          if (!allDead.length) break;
          const idx = Math.floor(Math.random() * allDead.length);
          let card;
          if (idx < G.state.player.deadPile.length) {
            card = G.state.player.deadPile.splice(idx, 1)[0];
          } else {
            card = G.state.ai.deadPile.splice(idx - G.state.player.deadPile.length, 1)[0];
          }
          const drawn = G.createCardInstance(card, self.owner);
          drawn._drawnBy = self;
          G.addToHand(self.owner, drawn, self);
          G.log(`Hela draws ${card.name} from the dead pile!`);
        }
      };
      const doSummon = () => {
        summonCount++;
        if (summonCount < zombies) {
          G.summonCardChoice(self.owner, "Undead Warrior", 1, 3, 1, [], doSummon);
        } else {
          drawFromDead(pulls);
        }
      };
      G.summonCardChoice(self.owner, "Undead Warrior", 1, 3, 1, [], doSummon);
    }
  },
  "Homelander": {
    onPlay(G, self, lane) {
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id).sort((a, b) => a.cost - b.cost);
      if (!allies.length) return;

      const damageableEnemies = () => G.getEnemiesOf(self.owner).filter(e =>
        !(e.invincibleTurns > 0) && !e.hasDamageImmunity && !(e.evadeCharges > 0)
      );

      // AI evaluator — for each ally, find the best Damage and Destroy trade.
      // Destroy bypasses HP/armor entirely so it's higher value when an enemy
      // matches the cost gate. Damage is the fallback when no destroy target
      // exists at the ally's cost. Returns { ally, mode, enemy, score } or null.
      const findBestTrade = (threshold) => {
        const tgts = damageableEnemies();
        if (!tgts.length) return null;
        let best = null, bestScore = -Infinity;
        for (const ally of allies) {
          const d = ally.baseCost || ally.cost || 0;
          // Destroy: any enemy with cost ≤ ally cost. No HP/armor check needed.
          const destroyTargets = tgts.filter(e => (e.baseCost || e.cost || 0) <= d);
          if (destroyTargets.length) {
            const topDestroy = destroyTargets.reduce((x, y) => AI.threatScore(y) > AI.threatScore(x) ? y : x);
            const t = AI.threatScore(topDestroy);
            // 2.5× weight on destroy (no overkill waste, ignores armor)
            const score = t * 2.5 - d;
            if (t >= threshold && score > bestScore) {
              bestScore = score;
              best = { ally, mode: 'destroy', enemy: topDestroy, score };
            }
          }
          // Damage: any enemy whose effective HP fits within d damage.
          const damageKills = tgts.filter(e => (e.currentHealth + (e.armorValue || 0)) <= d);
          if (damageKills.length) {
            const topDmg = damageKills.reduce((x, y) => AI.threatScore(y) > AI.threatScore(x) ? y : x);
            const t = AI.threatScore(topDmg);
            const score = t * 2 - d;
            if (t >= threshold && score > bestScore) {
              bestScore = score;
              best = { ally, mode: 'damage', enemy: topDmg, score };
            }
          }
        }
        return best;
      };

      // AI-controlled: pick the best trade (destroy preferred when both score
      // similar) and execute. Hold if no kill target meets the threat threshold.
      if (!Game.isHuman(self.owner)) {
        const trade = findBestTrade(4);
        if (!trade) {
          G.log(`Homelander surveys the field — no worthwhile sacrifice. Holds the strike.`);
          return;
        }
        const dmg = trade.ally.baseCost || trade.ally.cost;
        G.killCard(trade.ally);
        if (trade.mode === 'destroy') {
          G.killCard(trade.enemy, self);
          G.log(`Homelander sacrifices ${trade.ally.name} — destroys ${trade.enemy.name} (cost ≤ ${dmg})!`);
        } else {
          G.dealDamage(trade.enemy, dmg);
          G.log(`Homelander sacrifices ${trade.ally.name} — ${dmg} damage to ${trade.enemy.name}!`);
        }
        return;
      }

      const skipOption = {
        _isSkipOption: true,
        name: 'No Sacrifice',
        cost: 0,
        desc: "Homelander stands down — no ally is killed.",
        isDiscardEffect: true,
      };
      const choices = [...allies, skipOption];
      G.promptCardChoice(self.owner, choices,
        "Homelander — Sacrifice?",
        "Pick an ally to sacrifice, or choose No Sacrifice to skip.",
        (picked) => {
          if (picked && picked._isSkipOption) {
            G.log(`Homelander stands down — no sacrifice this turn.`);
            return;
          }
          const victim = picked;
          const dmg = victim.baseCost || victim.cost;
          // Step 2 — Damage vs Destroy. Both are synthetic choice tiles.
          const damageOpt = {
            _hlMode: 'damage',
            name: `Deal ${dmg} damage`,
            cost: 0,
            desc: `Deal ${dmg} damage to any enemy.`,
            isDiscardEffect: true,
          };
          const destroyOpt = {
            _hlMode: 'destroy',
            name: 'Destroy an enemy',
            cost: 0,
            desc: `Destroy any enemy with cost ≤ ${dmg}.`,
            isDiscardEffect: true,
          };
          G.killCard(victim);
          const enemies = damageableEnemies();
          if (!enemies.length) return;
          const validDestroyTargets = enemies.filter(e => (e.baseCost || e.cost || 0) <= dmg);
          const modeChoices = validDestroyTargets.length ? [damageOpt, destroyOpt] : [damageOpt];
          G.promptCardChoice(self.owner, modeChoices,
            "Homelander — Strike Mode", `Choose how to spend ${victim.name}'s sacrifice`,
            (modeChoice) => {
              if (modeChoice._hlMode === 'destroy') {
                G.promptCardChoice(self.owner, validDestroyTargets, "Homelander — Destroy", `Destroy which enemy (cost ≤ ${dmg})?`, (target) => {
                  G.killCard(target, self);
                  G.log(`Homelander sacrifices ${victim.name} — destroys ${target.name}!`);
                }, cards => cards.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0]);
                return;
              }
              G.promptCardChoice(self.owner, enemies, "Homelander — Damage", `Deal ${dmg} damage to which enemy?`, (target) => {
                G.dealDamage(target, dmg);
                G.log(`Homelander sacrifices ${victim.name} — ${dmg} damage to ${target.name}!`);
              }, cards => {
                const killable = cards.filter(c => c.currentHealth <= dmg);
                const pool = killable.length ? killable : cards;
                return pool.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0];
              });
            },
            cards => cards.find(c => c._hlMode === 'destroy') || cards[0]);
        },
        cards => {
          const trade = findBestTrade(2);
          if (trade) return trade.ally;
          const skip = cards.find(c => c && c._isSkipOption);
          return skip || cards[0];
        });
    }
  },
  "Hulk": {
    onPlay(G, self, lane) {
      self.splashRange = self.attack;
      const opp = G.opponent(self.owner);
      const hit = [];
      for (let i = 0; i < Game.LANE_COUNT; i++) {
        const e = G.state.lanes[i][opp];
        if (e && e.currentHealth > 0) {
          G.dealDamage(e, 2, self);
          hit.push(e.name);
        }
      }
      if (hit.length) G.log(`Hulk SMASH! Deals 2 damage to all enemies: ${hit.join(', ')}!`);
    },
    onBeforeAttack(G, self) {
      self.splashRange = self.attack;
    },
    onDamaged(G, self) {
      // Only rage if Hulk actually survived the hit. buffCard's +1 HP
      // would otherwise pull him from 0 → 1 HP, un-dying the lethal
      // swing and spamming "Hulk rages!" on top of the kill line.
      // Mirrors Bane's same-shaped guard.
      if (self.currentHealth <= 0) return;
      G.buffCard(self, 1, 1);
      self.splashRange = self.attack;
      G.log(`Hulk rages! +1/+1, Splash now ${self.splashRange}`);
    }
  },
  "Magneto": {
    onPlay(G, self, lane) {
      // Forced placements scale with tier: 1 / 2 (listed) / 3 / 4.
      const forceCount = G.rarityValue(self, { common: 1, rare: 2, special: 3, legendary: 4 });
      G.log("Magneto controls the battlefield! Even-lane enemies get -1/-2.");
      G.applyMagnetoDebuffs();
      const opp = G.opponent(self.owner);
      const openOpp = [];
      for (let i = 0; i < Game.LANE_COUNT; i++) {
        if (!G.state.lanes[i][opp] && !G.state.lanes[i].destroyed) openOpp.push(i);
      }
      if (openOpp.length < forceCount) {
        G.log(`Magneto can't fully control placement — only ${openOpp.length} open lane(s).`);
        if (openOpp.length === 0) return;
      }
      const pickLanes = (lanesChosen) => {
        G.state[opp].magnetoForcedLanes = lanesChosen;
        G.log(`Magneto forces the opponent's next ${lanesChosen.length} cards into lanes ${lanesChosen.map(l => l + 1).join(', ')}!`);
      };
      // Generic chain: keep prompting up to forceCount lanes. Each pick
      // narrows the remaining pool. AI auto-picks N random lanes.
      if (Game.isHuman(self.owner)) {
        const chosen = [];
        const promptNext = () => {
          const remaining = openOpp.filter(l => !chosen.includes(l));
          if (chosen.length >= forceCount || !remaining.length) {
            pickLanes(chosen);
            return;
          }
          const slot = chosen.length + 1;
          G.promptLaneChoice(self.owner, remaining, `Magneto — Force Lane ${slot}`,
            `Choose lane for opponent's ${slot === 1 ? 'NEXT' : `${slot}${slot===2?'ND':slot===3?'RD':'TH'}`} card placement`, (l) => {
              chosen.push(l);
              promptNext();
            }, opp);
        };
        promptNext();
      } else {
        const shuffled = openOpp.slice().sort(() => Math.random() - 0.5);
        pickLanes(shuffled.slice(0, forceCount));
      }
    }
  },
  "Obi-Wan": {
    passive: "reflect",
    onPlay(G, self, lane) {
      self.permanentTaunt = true;
      self.tauntTurns = Math.max(self.tauntTurns, 999);
      G.log(`Obi-Wan stands as the wall — Taunt active and damage from other lanes will be reflected.`);
    },
    onDamaged(G, self, attacker, dmg) {
      if (!attacker || !dmg || dmg <= 0) return;
      if (self._obiWanReflecting) return;
      const selfLane = G.findCardLane(self);
      const atkLane = G.findCardLane(attacker);
      if (selfLane < 0 || atkLane < 0 || atkLane === selfLane) return;
      self._obiWanReflecting = true;
      G.log(`  [REFLECT] Obi-Wan deflects ${dmg} damage back to ${attacker.name}!`);
      G.dealDamage(attacker, dmg, self);
      self._obiWanReflecting = false;
    },
    onDeath(G, self, lane) {
      const e = G.state.lanes[lane] ? G.state.lanes[lane][G.opponent(self.owner)] : null;
      if (e && e.attack > 0) {
        // Credit Obi-Wan with prevented damage BEFORE zeroing — phantom
        // swing reads current attack, so it needs the pre-zero value.
        G._simulatePhantomSwing(self, e);
        e._obiWanAttackZeroed = e.attack;
        e.attack = 0;
        G.log(`Obi-Wan's final lesson — ${e.name} cannot attack for the rest of this combat phase!`);
      }
    }
  },
  "Ultron": {
    onDeath(G, self, lane) {
      const open = G.getOpenLanes(self.owner);
      if (open.length >= 1) G.summonCard(self.owner, open[0], "Ultron", 6, 5, 3, []);
      if (open.length >= 2) G.summonCard(self.owner, open[open.length - 1], "Ultron", 6, 5, 3, []);
      G.log("Ultron replicates!");
    }
  },

  // ==================== COST 7 ====================
  "Dr. Doom": {
    onPlay(G, self, lane) {
      const owner = self.owner;
      const summonDoombot = () => {
        // Doombot rebalanced to 5/5 (was 6/5) — matches Dr. Doom's new
        // 5/5 line so the doppelganger token visually mirrors the boss.
        G.summonCardChoice(owner, "Doombot", 5, 5, 5, []);
      };
      const dp = G.state[owner].deadPile.filter(d => (d.cost || 0) <= 9);
      if (!dp.length) {
        G.log("Dr. Doom finds no fallen allies to revive.");
        summonDoombot();
        return;
      }
      G.promptCardChoice(owner, dp, "Dr. Doom — Revive",
        "Choose a fallen ally (cost 9 or less) to return to your hand. Its cost is permanently reduced by 3.",
        (picked) => {
          // Pull the chosen entry out of the dead pile
          const idx = G.state[owner].deadPile.indexOf(picked);
          if (idx > -1) G.state[owner].deadPile.splice(idx, 1);
          // Build a fresh hand instance from the original card definition (so onPlay/passives survive)
          const def = (typeof CARD_DEFS !== 'undefined' && CARD_DEFS.find(d => d.name === picked.name)) || picked;
          const card = G.createCardInstance(def, owner);
          // Permanent -3 cost reduction (clamped to 0). Applies only to the revived card.
          // baseCost stays at the card's ORIGINAL cost — it drives the
          // rarity tier (common / uncommon / rare / legendary) which
          // shouldn't change just because Doom dropped the play cost.
          // User report: "Wolverine costs 4 normally; Doom revived him
          // for 1 and his card chrome flipped from blue (uncommon) to
          // green (common). The cost should drop but the rarity should
          // stay blue." Bug was reducing baseCost too — fixed by only
          // touching `cost`.
          card.cost = Math.max(0, card.cost - 3);
          G.addToHand(owner, card, self);
          G.log(`Dr. Doom revives ${card.name} to hand! Cost permanently reduced by 3 → ${card.cost}.`);
          summonDoombot();
        },
        // AI picker: highest-cost revive gets the most value out of -3
        cards => cards.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0))[0]
      );
    }
  },
  "Gojo": {
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      // Step 1: Move an enemy to a different lane
      const enemies = G.getEnemiesOf(self.owner);
      const moveEnemy = (afterMove) => {
        if (!enemies.length) { afterMove(); return; }
        G.promptCardChoice(self.owner, enemies, "Gojo — Move Enemy", "Choose an enemy to move to another lane", (target) => {
          const fromLane = G.findCardLane(target);
          const openLanes = [];
          for (let i = 0; i < Game.LANE_COUNT; i++) {
            if (i !== fromLane && !G.state.lanes[i][opp] && !G.state.lanes[i].destroyed) openLanes.push(i);
          }
          // AI bias: prefer destinations inside Gojo's cone (lane ± 1) so the
          // moved enemy gets attack-zeroed by Step 2. Cone-lanes float to the
          // front of the array; the auto-picker takes lanes[0].
          if (!Game.isHuman(self.owner)) {
            const cone = new Set([lane - 1, lane, lane + 1]);
            openLanes.sort((a, b) => (cone.has(a) ? 0 : 1) - (cone.has(b) ? 0 : 1));
          }
          if (openLanes.length) {
            G.promptLaneChoice(self.owner, openLanes, `Move ${target.name}`, `Choose lane to move ${target.name} to`, (toLane) => {
              G.moveCard(target, fromLane, toLane);
              G.log(`Gojo moves ${target.name} to lane ${toLane + 1}!`);
              afterMove();
            }, opp);
          } else {
            G.log(`No open lanes to move ${target.name}!`);
            afterMove();
          }
        }, _aiThreatPicker);
      };

      moveEnemy(() => {
        // Step 2: Remove all attack in a cone (front + adjacent) for 1 turn.
        // Only cards present RIGHT NOW are affected; use the card id so we don't
        // double-zero the same enemy across multiple Gojo plays or turns.
        const gojoLane = G.findCardLane(self);
        if (gojoLane < 0) return;
        const coneLanes = [gojoLane - 1, gojoLane, gojoLane + 1];
        coneLanes.forEach(l => {
          if (l >= 0 && l < Game.LANE_COUNT) {
            const e = G.state.lanes[l][opp];
            if (e && e.currentHealth > 0 && e._gojoAttackZeroed === undefined) {
              // Credit prevention BEFORE zeroing (phantom swing uses current atk).
              G._simulatePhantomSwing(self, e);
              e._gojoAttackZeroed = e.attack;
              e._gojoZeroedBy = self.id;
              e.attack = 0;
              G.log(`Gojo nullifies ${e.name}'s attack in lane ${l + 1}!`);
            }
          }
        });
      });

      // Start combat countdown at 0 — tracked per-instance so a revived Gojo
      // doesn't inherit another instance's progress.
      self._gojoCombats = 0;
      self._gojoFired = false;
    },
    onEndOfTurn(G, self) {
      // Restore attacks zeroed by THIS Gojo instance. After restore, the effect
      // never re-applies — the cone only fires from onPlay.
      G.getAllCardsOnBoard().forEach(c => {
        if (c._gojoAttackZeroed !== undefined && c._gojoZeroedBy === self.id) {
          c.attack = c._gojoAttackZeroed;
          delete c._gojoAttackZeroed;
          delete c._gojoZeroedBy;
        }
      });
    },
    // Hollow Purple — fires the moment Gojo's OWN lane finishes combat on his
    // 2nd round. Moved here from onEndOfTurn so the destruction lands
    // mid-combat, before the other lanes resolve — enemies in opposite-parity
    // lanes die before they get to swing that same turn (matches the card's
    // "Unlimited Void" flavor: time freezes while the spell resolves).
    onLaneResolved(G, self, laneIdx) {
      if (self._gojoFired) return;
      if (self._gojoCombats === undefined) return;
      // Only count combats that resolve in Gojo's own lane (the card moved or
      // lanes destroyed could otherwise mis-credit the counter).
      if (laneIdx !== G.findCardLane(self)) return;
      self._gojoCombats++;
      if (self._gojoCombats < 2) return;
      self._gojoFired = true;
      // Hollow Purple cue — fires only when the ability ACTUALLY resolves
      // (not when Gojo enters play). User spec: "the hollow purple cue is
      // off, it's being played when gojo is played; it should fire when
      // his ability goes off."
      if (typeof UI !== 'undefined' && UI.sfx) UI.sfx.playCardSfx('Gojo', 'ability', self);
      const opp = G.opponent(self.owner);
      const gojoLane = G.findCardLane(self);
      if (gojoLane < 0) return;
      const gojoLaneNum = gojoLane + 1;
      const isEven = gojoLaneNum % 2 === 0;
      const targetParity = isEven ? 'odd' : 'even';
      G.log(`Gojo activates Hollow Purple! Destroying all enemies in ${targetParity} lanes!`);
      for (let i = 0; i < Game.LANE_COUNT; i++) {
        const laneIsEven = (i + 1) % 2 === 0;
        if (laneIsEven === isEven) continue;
        const e = G.state.lanes[i][opp];
        if (e && e.currentHealth > 0) {
          G.killCard(e, self);
          G.log(`  Gojo destroys ${e.name} in lane ${i + 1}!`);
        }
      }
    }
  },
  "Gorr": {
    onPlay(G, self, lane) {
      // Kill the highest-cost card in BOTH players' hands and show the victims.
      const killed = { player: null, ai: null };
      ['player', 'ai'].forEach(p => {
        const hand = G.state[p].hand;
        if (!hand.length) return;
        // Find the highest-cost card without permanently re-sorting the hand.
        let idx = 0;
        for (let i = 1; i < hand.length; i++) {
          if ((hand[i].cost || 0) > (hand[idx].cost || 0)) idx = i;
        }
        const [devoured] = hand.splice(idx, 1);
        killed[p] = devoured;
        G.state.voidPile.push({ name: devoured.name, cost: devoured.cost });
        G.log(`Gorr devours ${devoured.name} (cost ${devoured.cost}) from ${p === 'player' ? 'your' : "AI's"} hand!`);
        // Credit Gorr with card advantage for removing an opponent's card
        // (losing your own is negative, but we credit only the removal
        // side since each removal is symmetric and cancels out on self).
        if (p !== self.owner) {
          G._creditChain(self, 'statsCardAdvantage', 1);
        }
      });
      // Stash a banner payload for the UI so the player sees exactly which cards died.
      const parts = [];
      if (killed.player) parts.push(`You lost: ${killed.player.name} (cost ${killed.player.cost})`);
      if (killed.ai) parts.push(`AI lost: ${killed.ai.name} (cost ${killed.ai.cost})`);
      if (parts.length) {
        G.state._gorrBanner = { text: `Gorr devoured — ${parts.join(' · ')}`, at: Date.now() };
        if (typeof UI !== 'undefined' && UI.render) UI.render();
      }
      // Pull from the shared summon deck. With duplicates now allowed
      // (user spec: "if you summon Ant-Man from Mother Box you could
      // still have Ant-Man in hand"), we no longer need the in-play
      // exclusion that previously kept Gorr from re-conjuring a
      // hand-held card. Filter: cost 2-9, attack > 0, not a discard-
      // effect card.
      const d = G.drawFromSummonDeck(c => !c.isDiscardEffect && c.cost >= 2 && c.cost <= 9 && (c.attack || 0) > 0);
      if (d) {
        G.summonCardChoice(self.owner, d.name, d.cost, d.attack, d.health, d.abilities || [], null, null, d);
      }
    }
  },
  "Mahoraga": {
    passive: "absorbPlayerDamage",
    onDeath(G, self, lane) {
      if (self.reviveCharges > 0) {
        self.reviveCharges--;
        // Adapts: revives at 7/9 with Immunity 1 AND Armor 1 (new). The
        // armor stacks with the immunity so the first hit on the revived
        // body is fully blocked, the second hit is reduced by 1, and
        // subsequent hits go through. Per balance pass: "give Mahoraga
        // armor 1 on revive".
        self.attack = 7;
        self.currentHealth = 9;
        self.maxHealth = 9;
        self.immunityCharges = 1;
        self.armorValue = Math.max(self.armorValue || 0, 1);
        G.placeInLane(self.owner, self, lane);
        G.log(`Mahoraga adapts! 7/9 Armor 1 + Immunity 1! (Revive ${self.reviveCharges} left)`);
        return true;
      }
    }
  },
  "Omni-Man": {
    // _recurringBT lets onBeforeTricks fire every round (not just the
    // round Omni-Man entered) — same plumbing Man-Bat uses for his
    // recurring move. Without this flag, beforeTricksFired locks the
    // hook to one trigger per instance.
    _recurringBT: true,
    onPlay(G, self, lane) {
      G.getEnemiesOf(self.owner).forEach(e => G.dealDamage(e, 3, self));
      G.log("Omni-Man devastates all enemies for 3!");
    },
    // Mobility hook — same shape as Man-Bat's. Start of Tricks, Omni-Man
    // relocates to an empty ally lane (if one exists). Stun/freeze
    // gates the move identically. Per balance pass: "give Omni-Man a
    // move just like Man-Bat." Unlike Man-Bat, no -1/-1 debuff lands
    // on the destination's opposite enemy — Omni-Man is already an
    // AOE damage threat on entry; the move is purely repositioning.
    onBeforeTricks(G, self, lane) {
      if (self.isStunned || self.isFrozen) {
        G.log(`  [SKIP] ${self.name} is ${self.isStunned ? 'STUNNED' : 'FROZEN'} — stays put.`);
        return;
      }
      const open = G.getOpenLanes(self.owner).filter(l => l !== lane);
      if (!open.length) return;
      // Include the current lane as a "stay" option — same affordance
      // as Man-Bat. Player can pick Omni-Man's own lane to skip the
      // relocation entirely.
      if (Game.isHuman(self.owner)) {
        const choices = [lane, ...open];
        G.promptLaneChoice(self.owner, choices, "Omni-Man — Move", "Choose a lane to move to (current = stay)", (to) => {
          if (to === lane) {
            G.log(`Omni-Man stays put in lane ${lane + 1}.`);
            return;
          }
          G.moveCard(self, lane, to);
        });
      } else {
        const to = open[Math.floor(Math.random() * open.length)];
        G.moveCard(self, lane, to);
      }
    },
    onKill(G, self) {
      G.state[self.owner].blockMeter = Math.min(Game.BLOCK_MAX, G.state[self.owner].blockMeter + 1);
      G.log("Omni-Man adds 1 Block Meter!");
    }
  },
  "Silver Surfer": {
    onPlay(G, self, lane) {
      const enemies = G.getEnemiesOf(self.owner);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Silver Surfer — Weaken", "Choose enemy to remove 3 Attack from", (t) => {
          G.debuffCard(t, 3, 0, false, self); G.log(`Silver Surfer weakens ${t.name} by 3 ATK!`);
        }, _aiThreatPicker);
      }
    },
    passive: "enemyCostIncrease"
  },

  // ==================== COST 8 ====================
  "Darth Vader": {
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      // Short-hand for per-ability SFX — silent in the headless sim (no UI)
      // and silent if no file is registered in CARD_SFX['Darth Vader'].abilities.
      const absfx = (key) => { if (typeof UI !== 'undefined' && UI.sfx) UI.sfx.playCardAbility('Darth Vader', key); };
      // Step 1: Move an enemy to another lane.
      const moveStep = (afterMove) => {
        absfx('move');
        const enemies = G.getEnemiesOf(self.owner);
        if (!enemies.length) { afterMove(); return; }
        const doMove = (target) => {
          const fromLane = G.findCardLane(target);
          const openLanes = [];
          for (let i = 0; i < Game.LANE_COUNT; i++) {
            if (i !== fromLane && !G.state.lanes[i][opp] && !G.state.lanes[i].destroyed) openLanes.push(i);
          }
          if (!openLanes.length) {
            G.log(`Darth Vader finds no open lane to move ${target.name} into.`);
            afterMove();
            return;
          }
          if (Game.isHuman(self.owner)) {
            G.promptLaneChoice(self.owner, openLanes, `Vader — Move ${target.name}`,
              `Choose a lane for ${target.name}`, (toLane) => {
                G.moveCard(target, fromLane, toLane);
                G.log(`Darth Vader moves ${target.name} to lane ${toLane + 1}!`);
                afterMove();
              }, opp);
          } else {
            // AI-controlled: pick the lane where we'd most like the enemy
            // displaced — biggest disruption is moving them out of their
            // favorable trade or into a lane we can now chain into.
            const toLane = openLanes[0];
            G.moveCard(target, fromLane, toLane);
            G.log(`Darth Vader moves ${target.name} to lane ${toLane + 1}!`);
            afterMove();
          }
        };
        if (Game.isHuman(self.owner)) {
          G.promptCardChoice(self.owner, enemies, "Vader — Move Enemy",
            "Choose an enemy to displace to another lane", doMove,
            cards => cards.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0]);
        } else {
          // AI-controlled: move the biggest threat
          const pick = enemies.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0];
          doMove(pick);
        }
      };

      // Step 2: Fear 1 an enemy (any enemy, player chooses / AI picks scariest).
      const fearStep = (afterFear) => {
        absfx('fear');
        const enemies = G.getEnemiesOf(self.owner).filter(e => !e.isFeared);
        if (!enemies.length) { afterFear(); return; }
        const doFear = (target) => {
          G.fearCard(target, self);
          afterFear();
        };
        if (Game.isHuman(self.owner)) {
          G.promptCardChoice(self.owner, enemies, "Vader — Fear",
            "Choose an enemy to Fear 1", doFear,
            cards => cards.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0]);
        } else {
          const pick = enemies.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0];
          doFear(pick);
        }
      };

      // Step 3: Vader chain (existing 7-damage chain). Fires the 'throw'
      // ability cue — lightsaber-throw moment in the chain attack.
      moveStep(() => {
        fearStep(() => {
          absfx('throw');
          G.startVaderChain(self.owner, () => {
            G.cleanupDead();
            if (typeof UI !== 'undefined' && UI.render) UI.render();
          });
        });
      });
    }
  },
  "Emperor Palpatine": {
    onPlay(G, self, lane) {
      G.runPlayerChain(self, (target) => G.freezeCardUnresistible(target, self),
        "Palpatine — Chain Freeze", "freeze");
    },
    passive: "doubleFrozenDamage",
    onDeath(G, self, lane) {
      G.runPlayerChain(self, (target) => G.freezeCardUnresistible(target, self),
        "Palpatine's Final Act — Chain Freeze", "freeze");
    }
  },
  "Luke Skywalker": {
    onPlay(G, self, lane) {
      // Apply aura FIRST so the -1/-1 debuff lands and any 1-HP enemies
      // die before the MC choice prompt opens. Otherwise Luke would
      // offer dead cards as MC targets while live survivors went
      // missing from the list (they hadn't been captured yet but the
      // dead ones were). User report: "Luke mind controls an enemy
      // but the choices shown are the ones he killed, not the live
      // ones on the board."
      G.getAlliesOf(self.owner).filter(a => a.id !== self.id).forEach(a => {
        G.buffCard(a, 1, 1);
        a._lukeBuff = true;
      });
      G.getEnemiesOf(self.owner).forEach(e => {
        G.debuffCard(e, 1, 1, true, self);
        e._lukeDebuff = true;
      });
      G.log("Luke Skywalker inspires allies (+1/+1) and weakens enemies (-1/-1)!");
      // Now snapshot the remaining LIVE enemies and prompt for MC.
      // getEnemiesOf already filters by `currentHealth > 0`, so dead
      // cards from the aura won't show up.
      const enemies = G.getEnemiesOf(self.owner);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Luke Skywalker — Mind Control", "Choose an enemy to Mind Control 1", (t) => {
          G.mindControlCard(t, self, () => { G.log(`Luke Skywalker Mind Controls ${t.name}!`); });
        }, _aiThreatPicker);
      }
    },
    onAnyCardPlayed(G, self) {
      // Apply aura to any new card that enters the board.
      G.getAlliesOf(self.owner).filter(a => a.id !== self.id && !a._lukeBuff).forEach(a => {
        G.buffCard(a, 1, 1);
        a._lukeBuff = true;
      });
      G.getEnemiesOf(self.owner).filter(e => !e._lukeDebuff).forEach(e => {
        // allowKill=true mirrors the onPlay call — a freshly-played
        // 1/1 token should die to Luke's aura the moment it lands.
        G.debuffCard(e, 1, 1, true, self);
        e._lukeDebuff = true;
      });
    },
    onDeath(G, self, lane) {
      // Remove aura when Luke dies
      G.getAllCardsOnBoard().forEach(c => {
        if (c._lukeBuff) {
          G.debuffCard(c, 1, 1);
          delete c._lukeBuff;
        }
        if (c._lukeDebuff) {
          G.buffCard(c, 1, 1);
          delete c._lukeDebuff;
        }
      });
      G.log("Luke Skywalker falls — aura fades!");
    }
  },
  "Thor": {
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      // Let the player pick where the freeze lands — was hardcoded to the
      // lane-opposite enemy. AI fallback picks the highest-threat unfrozen
      // enemy so the CPU still plays Thor competently.
      const splashBurst = () => {
        [lane - 1, lane, lane + 1].forEach(li => {
          if (li >= 0 && li < Game.LANE_COUNT) {
            const e = G.state.lanes[li][opp];
            if (e && e.currentHealth > 0) {
              G.dealDamage(e, 5, self);
              G.log(`Thor's thunder strikes ${e.name} for 5!`);
            }
          }
        });
      };
      const unfrozen = G.getEnemiesOf(self.owner).filter(e => !e.isFrozen);
      if (unfrozen.length) {
        G.promptCardChoice(self.owner, unfrozen, "Thor — Freeze", "Choose an enemy to Freeze 1", (t) => {
          G.freezeCardUnresistible(t, self);
          G.log(`Thor's lightning freezes ${t.name}!`);
          splashBurst();
        }, cards => cards.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0]);
      } else {
        splashBurst();
      }
    },
    onBeforeTricks(G, self, lane) {
      const enemies = G.getEnemiesOf(self.owner).filter(e => !e.isFrozen);
      if (enemies.length) {
        const t = enemies[Math.floor(Math.random() * enemies.length)];
        G.freezeCardUnresistible(t);
        G.log(`Thor freezes ${t.name}!`);
      }
    }
  },
  "Yoda": {
    onPlay(G, self, lane) {
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id);
      const grant = (a) => {
        G.grantTempBuff(a, { evadeCharges: 1 });
        G.buffCard(a, 4, 4);
        G.log(`Yoda empowers ${a.name} with Evade +4/+4!`);
      };
      if (allies.length) {
        G.promptCardChoice(self.owner, allies, "Yoda — Empower", "Choose ally to give Evade +4/+4", grant);
      } else {
        G.buffCard(self, 2, 3);
        G.log("Yoda empowers himself +2/+3!");
      }
    }
  },

  // ==================== COST 9 ====================
  "Batman": {
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      // Lock the opponent's highest-cost hand card for their NEXT round.
      // Store the round number at which the lock is active, not a boolean
      // (startRound's per-round reset used to wipe a boolean flag before
      // the opponent ever got their turn).
      G.state[opp].batmanBlocked = (G.state.round || 0) + 1;
      G.log(`Batman locks down the opponent's highest cost card for next turn!`);
      const enemies = G.getEnemiesOf(self.owner);
      if (!enemies.length) return;
      const pickThreat = cards => cards.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0];
      const pickDamage = cards => {
        // Lower kill threshold to match the new 2-damage-per-hit ceiling.
        // Cards with ≤2 HP are now the "this hit alone could kill" pool.
        const killable = cards.filter(c => c.currentHealth <= 2);
        const pool = killable.length ? killable : cards;
        return pool.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0];
      };

      // Step 3: second 2-damage strike — any live enemy.
      const strike2 = () => {
        const pool = G.getEnemiesOf(self.owner).filter(e => e.currentHealth > 0);
        if (!pool.length) return;
        G.promptCardChoice(self.owner, pool, "Batman — Strike 2", "Deal 2 damage to any enemy", (t) => {
          G.dealDamage(t, 2, self);
          G.log(`Batman strike 2: deals 2 to ${t.name}!`);
        }, pickDamage);
      };
      // Step 2: first 2-damage strike — any live enemy (may be the feared one).
      const strike1 = () => {
        const pool = G.getEnemiesOf(self.owner).filter(e => e.currentHealth > 0);
        if (!pool.length) return;
        G.promptCardChoice(self.owner, pool, "Batman — Strike 1", "Deal 2 damage to any enemy", (t) => {
          G.dealDamage(t, 2, self);
          G.log(`Batman strike 1: deals 2 to ${t.name}!`);
          strike2();
        }, pickDamage);
      };
      // Step 1: Fear any unfeared enemy — separate prompt, no damage here.
      const fearable = enemies.filter(e => !e.isFeared && e.currentHealth > 0);
      if (fearable.length) {
        G.promptCardChoice(self.owner, fearable, "Batman — Fear", "Fear any enemy", (t) => {
          G.fearCard(t, self);
          G.log(`Batman fears ${t.name}!`);
          strike1();
        }, pickThreat);
      } else {
        strike1();
      }
    }
  },
  "Darkseid": {
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      const destroyLane = (i) => {
        // Pass self as source — killCard's guard `card.owner !== source.owner`
        // ensures Darkseid isn't credited for killing his own card,
        // only the enemy side.
        G.killCard(G.state.lanes[i][self.owner], self);
        G.killCard(G.state.lanes[i][opp], self);
        G.destroyLane(i, 3);
        G.log(`Darkseid destroys lane ${i + 1}!`);
      };
      const pickLanes = (isOdd) => {
        const eligible = [];
        for (let i = 0; i < Game.LANE_COUNT; i++) {
          if (i === lane) continue;
          const laneIsOdd = (i + 1) % 2 === 1;
          if (laneIsOdd === isOdd && G.state.lanes[i][self.owner] && G.state.lanes[i][opp]) {
            eligible.push(i);
          }
        }
        if (!eligible.length) { G.log(`Darkseid finds no ${isOdd ? 'odd' : 'even'} contested lanes to purge.`); return; }
        if (!Game.isHuman(self.owner)) {
          // Only destroy lanes where the trade is favorable — the AI loses
          // its own card too, so collapsing a Hulk-vs-1/1 trades Hulk for
          // nothing. Trade is "good" when enemy threat ≥ our card's threat
          // plus a small margin. Parademon (just summoned, threat ~2) is
          // expendable so its lane is almost always worth purging.
          const purged = [];
          eligible.forEach(i => {
            const myCard = G.state.lanes[i][self.owner];
            const enemy = G.state.lanes[i][opp];
            if (!myCard || !enemy) return;
            const mine = AI.threatScore(myCard);
            const theirs = AI.threatScore(enemy);
            // Destroy if the trade is even or favorable, the enemy is
            // otherwise unkillable (invincible/immune), or the victim on
            // our side is a Parademon / low-value token. The old +1.5
            // threshold was too conservative — flat-energy trades against
            // mid-cost enemies still net us tempo since we replaced
            // Darkseid's own play turn with the lane purge.
            const unkillableEnemy = enemy.invincibleTurns > 0 || enemy.hasDamageImmunity;
            const sacrificeBody = myCard.name === 'Parademon' || mine <= 2;
            // Also purge when the enemy COSTS more than our card by 2+ —
            // even a "lateral threat" trade is good when we paid much less
            // for our body. Fixes the AI sitting on Darkseid while a 9-cost
            // enemy gummed up a contested lane.
            const costDelta = (enemy.baseCost || enemy.cost || 0) - (myCard.baseCost || myCard.cost || 0);
            if (theirs - mine >= 0.5 || unkillableEnemy || sacrificeBody || costDelta >= 2) {
              destroyLane(i);
              purged.push(i + 1);
            }
          });
          if (purged.length) {
            G.log(`Darkseid purges ${isOdd ? 'odd' : 'even'} lanes: ${purged.join(', ')}`);
          } else {
            G.log(`Darkseid surveys the ${isOdd ? 'odd' : 'even'} lanes — no favorable trades, holds the purge.`);
          }
          return;
        }
        const pickNext = () => {
          const remaining = eligible.filter(i => !G.state.lanes[i].destroyed);
          if (!remaining.length) return;
          const choices = remaining.map(i => {
            const p = G.state.lanes[i][self.owner];
            const a = G.state.lanes[i][opp];
            return { name: `Lane ${i + 1}`, desc: `${p.name} vs ${a.name}`, _lane: i };
          });
          choices.push({ name: "Done", desc: "Stop destroying lanes" });
          G.promptCardChoice(self.owner, choices,
            "Darkseid — Purge", `Pick a ${isOdd ? 'odd' : 'even'} lane to destroy (or Done)`,
            (choice) => {
              if (choice.name === "Done") return;
              destroyLane(choice._lane);
              pickNext();
            }, c => c[c.length - 1]);
        };
        pickNext();
      };
      // Purge step is wrapped in a function so it fires AFTER the Parademon
      // summon resolves. Previously the summon prompt and the purge prompt
      // were queued back-to-back synchronously, which let the purge modal
      // open before the player had placed the Parademon — i.e. lanes got
      // collapsed before the new 2/1 could contest one.
      const startPurge = () => {
        const oddChoice = { name: "Odd Lanes (1, 3, 5)", desc: "Pick which contested odd lanes to destroy" };
        const evenChoice = { name: "Even Lanes (2, 4, 6)", desc: "Pick which contested even lanes to destroy" };
        G.promptCardChoice(self.owner, [oddChoice, evenChoice],
          "Darkseid — Purge", "Choose odd or even, then pick lanes to destroy",
          (choice) => pickLanes(choice === oddChoice),
          (choices) => {
            // Score odd vs even by net trade value (enemy threat minus our
            // threat in each contested lane), not by raw lane count. An
            // odd side with one great trade beats an even side with two bad
            // trades.
            let oddScore = 0, evenScore = 0;
            for (let i = 0; i < Game.LANE_COUNT; i++) {
              if (i === lane) continue;
              const myCard = G.state.lanes[i][self.owner];
              const enemy = G.state.lanes[i][opp];
              if (!myCard || !enemy) continue;
              const mine = AI.threatScore(myCard);
              const theirs = AI.threatScore(enemy);
              const unkillable = enemy.invincibleTurns > 0 || enemy.hasDamageImmunity;
              const sacrificeBody = myCard.name === 'Parademon' || mine <= 2;
              // Only count lanes we'd actually destroy (favorable trade or
              // special case). A negative trade we wouldn't purge contributes 0.
              let delta = 0;
              const costDelta = (enemy.baseCost || enemy.cost || 0) - (myCard.baseCost || myCard.cost || 0);
              if (theirs - mine >= 0.5 || unkillable || sacrificeBody || costDelta >= 2) {
                delta = (theirs - mine) + Math.max(0, costDelta) * 0.5;
                if (unkillable) delta += 3; // bonus for removing an otherwise-unkillable threat
              }
              if ((i + 1) % 2 === 1) oddScore += delta; else evenScore += delta;
            }
            return oddScore >= evenScore ? choices[0] : choices[1];
          }
        );
      };

      // Step 1: Summon Parademon. Step 2 (purge) chains off the summon's
      // onComplete so it only runs once the Parademon has landed. The AI
      // path passes a pre-picked best lane; the human path lets summon-
      // CardChoice prompt for placement. Either way, startPurge fires
      // after the summon (or immediately, if no open lanes were found).
      if (!Game.isHuman(self.owner)) {
        const openLanes = G.getOpenLanes(self.owner).filter(i => i !== lane);
        if (openLanes.length) {
          let bestLane = openLanes[0];
          let bestScore = -Infinity;
          openLanes.forEach(i => {
            const enemy = G.state.lanes[i][opp];
            let score = 0;
            if (enemy && enemy.currentHealth > 0) {
              score += AI.threatScore(enemy) * 2;
              if (enemy.invincibleTurns > 0 || enemy.hasDamageImmunity) score += 3;
            } else {
              score -= 2;
            }
            if (score > bestScore) { bestScore = score; bestLane = i; }
          });
          G.summonCardChoice(self.owner, "Parademon", 1, 2, 1, [], [bestLane], startPurge);
        } else {
          startPurge();
        }
      } else {
        G.summonCardChoice(self.owner, "Parademon", 1, 2, 1, [], null, startPurge);
      }
    },
    onBeforeAttack(G, self) {
      if (self.isFeared || self.isMindControlled) return;
      const enemies = G.getEnemiesOf(self.owner).filter(e => e.currentHealth > 0);
      if (enemies.length === 0) return;
      self._skipNormalAttack = true;
      G.distributeOmegaBeam(self);
    }
  },
  "Superman": {
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      const target = G.state.lanes[lane] ? G.state.lanes[lane][opp] : null;
      if (target && target.currentHealth > 0) {
        G.dealDamage(target, self.attack, self);
        G.log(`Superman bonus attacks ${target.name} for ${self.attack}!`);
      } else {
        G.damagePlayer(opp, self.attack, self.isBullseye);
        G.log(`Superman bonus attacks health bar for ${self.attack}!`);
      }
      // Freeze 2 enemies chosen by the player. Chains two promptCardChoice
      // calls: the first pick filters out of the pool for the second so the
      // same enemy can't be picked twice. AI picks the top two threat scores.
      const doBlast = () => {
        const enemies = G.getEnemiesOf(self.owner);
        if (enemies.length) {
          G.promptCardChoice(self.owner, enemies, "Superman — Blast", "Choose enemy to deal 5 damage", (t) => {
            G.dealDamage(t, 5); G.log(`Superman blasts ${t.name} for 5!`);
          }, cards => {
            const killable = cards.filter(c => c.currentHealth <= 5);
            const pool = killable.length ? killable : cards;
            return pool.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0];
          });
        }
      };
      const unfrozen1 = G.getEnemiesOf(self.owner).filter(e => !e.isFrozen);
      if (!unfrozen1.length) { doBlast(); return; }
      G.promptCardChoice(self.owner, unfrozen1, "Superman — Freeze (1 of 2)", "Choose the first enemy to Freeze 1", (t1) => {
        G.freezeCardUnresistible(t1, self);
        G.log(`Superman freezes ${t1.name}!`);
        const unfrozen2 = G.getEnemiesOf(self.owner).filter(e => !e.isFrozen);
        if (!unfrozen2.length) { doBlast(); return; }
        G.promptCardChoice(self.owner, unfrozen2, "Superman — Freeze (2 of 2)", "Choose the second enemy to Freeze 1", (t2) => {
          G.freezeCardUnresistible(t2, self);
          G.log(`Superman freezes ${t2.name}!`);
          doBlast();
        }, cards => cards.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0]);
      }, cards => cards.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0]);
    }
  },
  "Thanos": {
    trickPhasePlayable: true,
    onPlay(G, self, lane) {
      // Lanes destroyed scales with tier: 2 / 3 / 4 / 5.
      const numRolls = G.rarityValue(self, { common: 2, rare: 3, special: 4, legendary: 5 });
      const rolled = new Set();
      let killed = 0;
      const maxLanes = Game.LANE_COUNT;
      while (rolled.size < Math.min(numRolls, maxLanes)) {
        const r = Math.floor(Math.random() * maxLanes);
        if (!rolled.has(r)) {
          rolled.add(r);
          const opp = G.opponent(self.owner);
          const e = G.state.lanes[r][opp];
          if (e) { G.killCard(e, self); killed++; G.log(`Thanos snaps lane ${r + 1}: ${e.name} destroyed!`); }
        }
      }
      G.log(`Thanos snaps! Lanes ${[...rolled].map(n => n + 1).sort().join(', ')} — ${killed} enemies erased!`);
      // Flash the rolled lanes so the player can SEE which 3 lanes got hit
      // (some may have had no target to kill, which the log line alone
      // doesn't make obvious — the flash surfaces the roll transparently).
      if (typeof UI !== 'undefined' && UI.flashLanes) {
        UI.flashLanes([...rolled], 'lane-thanos-snap', 2600);
      }
    }
  },

  // ==================== COST 10 ====================
  "Anakin Skywalker": {
    onPlay(G, self, lane) {
      // Number of enemies feared scales with tier. Common: 1, Rare: 1
      // (listed), Special: 2, Legendary: 3. The Unresistible charge
      // is on the abilities array (Unresistible 1) — same baseline.
      const fearCount = G.rarityValue(self, { common: 1, rare: 1, special: 2, legendary: 3 });
      const enemies = G.getEnemiesOf(self.owner);
      if (!enemies.length) return;
      const feared = new Set();
      const pickNext = () => {
        if (feared.size >= fearCount) return;
        const remaining = enemies.filter(e => !feared.has(e.id) && !e.isFeared && e.currentHealth > 0);
        if (!remaining.length) return;
        G.promptCardChoice(self.owner, remaining, "Anakin — Fear",
          `Choose an enemy to fear (${feared.size + 1}/${fearCount})`,
          (t) => {
            G.fearCard(t, self);
            feared.add(t.id);
            G.log(`Anakin terrifies ${t.name}!`);
            if (feared.size < fearCount) pickNext();
          },
          cards => cards.slice().sort((a, b) => (b.attack || 0) - (a.attack || 0))[0]);
      };
      pickNext();
    },
    onBeforeTricks(G, self, lane) {
      if (self.anakinMoved) return;           // fires exactly once per instance
      // Stun / freeze blocks the move AND the queued bonus attack. Same
      // guard as Man-Bat / Green Goblin — without this, moveCard refuses
      // silently but self.bonusAttack still queues up.
      if (self.isStunned || self.isFrozen) {
        G.log(`  [SKIP] ${self.name} is ${self.isStunned ? 'STUNNED' : 'FROZEN'} — stays put.`);
        return;
      }
      // "Open lane" = a lane where Anakin's own side is empty (so he can slot
      // in without displacing an ally). The destination may still have an
      // enemy opposite; the queued bonus attack will land on them if so,
      // otherwise it hits the enemy health bar.
      const eligible = [];
      for (let i = 0; i < Game.LANE_COUNT; i++) {
        if (i === lane) continue;
        if (G.state.lanes[i].destroyed) continue;
        if (!G.state.lanes[i][self.owner]) eligible.push(i);
      }
      if (!eligible.length) return;
      const opp = G.opponent(self.owner);
      const doMove = (toLane) => {
        G.moveCard(self, lane, toLane);
        // Queue + drain in the same beat so the bonus attack fires
        // IMMEDIATELY after the move log line, not at end of round.
        // User spec: "Anakin's bonus attack is still firing at the end
        // of the turn — bonus attacks should all act like Superman's
        // strike" (instant). Without the inline drain, drainBonusAttacks
        // didn't run until postCombat (or the end-of-runBeforeTricks
        // safety pass), making the attack feel disconnected from the
        // move that triggered it.
        self.bonusAttack = (typeof self.bonusAttack === 'number' ? self.bonusAttack : 0) + 1;
        const targetNote = G.state.lanes[toLane][opp] ? ` — locked on ${G.state.lanes[toLane][opp].name}` : '';
        G.log(`Anakin moves to lane ${toLane + 1} and strikes${targetNote}!`);
        self.anakinMoved = true;
        G.drainBonusAttacks(self);
      };
      if (Game.isHuman(self.owner)) {
        const laneChoices = eligible.map(i => {
          const e = G.state.lanes[i][opp];
          const desc = e && e.currentHealth > 0
            ? `Move here — bonus attack on ${e.name} (${e.attack}/${e.currentHealth})`
            : `Move here — bonus attack on enemy HP`;
          return { name: `Lane ${i + 1}`, desc, _lane: i };
        });
        G.promptCardChoice(self.owner, laneChoices, "Anakin — Move & Bonus Attack",
          "Choose an open lane to move to",
          (choice) => doMove(choice._lane),
          // AI picks the biggest impact: lane with a killable enemy > lane
          // with a contested enemy > open lane for direct HP damage.
          (choices) => {
            const scored = choices.slice().sort((a, b) => {
              const ea = G.state.lanes[a._lane][opp];
              const eb = G.state.lanes[b._lane][opp];
              const aScore = ea ? (self.attack >= ea.currentHealth ? 10 + (ea.cost || 0) : 5 + (ea.cost || 0)) : 3;
              const bScore = eb ? (self.attack >= eb.currentHealth ? 10 + (eb.cost || 0) : 5 + (eb.cost || 0)) : 3;
              return bScore - aScore;
            });
            return scored[0];
          });
      } else {
        doMove(eligible[0]);
      }
    },
    onAllyKilled(G, self) {
      // Queue a bonus attack for every ally death, not just the first one this combat.
      self.bonusAttack = (typeof self.bonusAttack === 'number' ? self.bonusAttack : 0) + 1;
    }
  },
  "Dormammu": {
    onPlay(G, self, lane) {
      // Foresight (Dr. Strange reorder) for 2 turns
      G.state[self.owner].drStrangeReorder = "Dormammu";
      G.state[self.owner]._dormammuForesight = 2;
      G.log("Dormammu grants foresight for the next 2 draw phases!");
    },
    onBeforeTricks(G, self, lane) {
      if (self.dormammuDrained) return;    // fires exactly once per instance
      const enemies = G.getEnemiesOf(self.owner);
      if (!enemies.length) return;
      self.dormammuDrained = true;
      const drainCount = Math.min(3, enemies.length);
      const drainChain = (remaining, picked) => {
        // Previously this stopped when `picked` was empty — which is the
        // STARTING state, so the chain returned immediately on the first
        // call and Dormammu never drained anyone. Guard on `remaining`
        // only; `available.length === 0` below handles the "nothing left
        // to drain" exit.
        if (remaining <= 0) return;
        const available = enemies.filter(e => e.currentHealth > 0 && !picked.includes(e.id));
        if (!available.length) return;
        // ALWAYS prompt the human player — even when only 1 target remains.
        // Matches Galactus's devour and the user's general spec: "the user
        // always chooses". The single-target prompt confirms intent and
        // makes the targeting visible.
        // AI picker: target highest threat, not raw ATK. Threat score
        // factors armor / evade / invincibility / strategic value (a
        // 4/8 with Armor 2 is worth more to drain than a 7/4 glass
        // cannon). Drain steals stats — taking from the highest-threat
        // enemy yields the biggest swing in the AI's favor.
        const threatPicker = (cards) => cards.slice().sort((a, b) =>
          (AI && AI.threatScore ? (AI.threatScore(b) - AI.threatScore(a))
                                : (b.attack || 0) - (a.attack || 0)))[0];
        if (Game.isHuman(self.owner)) {
          G.promptCardChoice(self.owner, available, `Dormammu — Drain (${remaining} left)`,
            `Choose enemy to drain (${remaining} remaining)`, (t) => {
              G.drainCard(self, t);
              picked.push(t.id);
              drainChain(remaining - 1, picked);
            }, threatPicker);
        } else {
          const t = threatPicker(available);
          G.drainCard(self, t);
          picked.push(t.id);
          drainChain(remaining - 1, picked);
        }
      };
      drainChain(drainCount, []);
      G.log("Dormammu drains the battlefield!");
    }
  },
  "Dr. Manhattan": {
    onPlay(G, self, lane) { G.healPlayer(self.owner, 5, self); G.log("Dr. Manhattan heals 5!"); },
    passive: "extraCurrency2"
  },
  "Galactus": {
    onBeforeTricks(G, self, lane) {
      if (self.galactusDevoured) return;   // fires exactly once per instance
      const enemies = G.getEnemiesOf(self.owner);
      if (!enemies.length) return;
      self.galactusDevoured = true;
      // Devour count scales: 1 / 2 (listed) / 3 / 4.
      const baseDevour = G.rarityValue(self, { common: 1, rare: 2, special: 3, legendary: 4 });
      const devourCount = Math.min(baseDevour, enemies.length);
      const devourChain = (remaining, picked) => {
        if (remaining <= 0) return;
        const available = enemies.filter(e => e.currentHealth > 0 && !picked.includes(e.id) && G.findCardLane(e) >= 0);
        if (!available.length) return;
        // ALWAYS prompt the human player — even when only 1 target remains.
        // User spec: "the user always chooses". The redundant-looking prompt
        // for a single option is intentional — it shows the player exactly
        // who's about to be devoured and gives them a deliberate confirm
        // beat instead of an ambiguous instant resolution.
        // AI picker: devour highest threat. Cost-based picking missed
        // cards like Captain America (7-cost, modest stats but huge
        // strategic impact via shield) — threatScore captures that.
        // For 10-cost titans like Galactus, the goal is to remove the
        // most threatening piece; raw cost is a poor proxy.
        const threatPicker = (cards) => cards.slice().sort((a, b) =>
          (AI && AI.threatScore ? (AI.threatScore(b) - AI.threatScore(a))
                                : (b.cost || 0) - (a.cost || 0)))[0];
        if (Game.isHuman(self.owner)) {
          G.promptCardChoice(self.owner, available, `Galactus — Devour (${remaining} left)`,
            `Choose enemy to devour (${remaining} remaining)`, (t) => {
              G.devourCard(t, self);
              picked.push(t.id);
              devourChain(remaining - 1, picked);
            }, threatPicker);
        } else {
          const t = threatPicker(available);
          G.devourCard(t, self);
          picked.push(t.id);
          devourChain(remaining - 1, picked);
        }
      };
      devourChain(devourCount, []);
    },
    onEndOfTurn(G, self, lane) {
      // Devour weak enemies (≤4 ATK) each turn — Galactus consumes lesser
      // threats and leaves stronger ones to face directly.
      G.getEnemiesOf(self.owner).filter(e => e.attack <= 4).forEach(e => {
        G.devourCard(e);
      });
    }
  },
  "Knull": {
    onPlay(G, self, lane) {
      G.getOpenLanes(self.owner).filter(l => l !== lane).forEach(l => {
        // Pull from the shared summon deck so Knull's lottery spreads
        // across the full 95-card pool. Filter: cost 1-9, attack > 0,
        // not a discard-effect card. The boss-card odds (Batman /
        // Darkseid / Galactus) are now ~1% per slot instead of ~5%
        // when pulling from a 30-card drafted deck.
        const d = G.drawFromSummonDeck(c => !c.isDiscardEffect && c.cost >= 1 && c.cost <= 9 && (c.attack || 0) > 0);
        if (d) {
          G.summonCard(self.owner, l, d.name, d.cost, d.attack, d.health, d.abilities || [], d);
        }
      });
      G.log("Knull fills the battlefield!");
    }
  },
  "Trigon": {
    onPlay(G, self, lane) {
      // Block-steal magnitude scales with tier. Common steals 50%,
      // Rare 100% (listed), Special 100% + tops own meter to max,
      // Legendary same + drains 2 HP from each enemy on board.
      const stealPct = G.rarityValue(self, { common: 0.5, rare: 1.0, special: 1.0, legendary: 1.0 });
      const fillSelfToMax = G.rarityValue(self, { common: false, rare: false, special: true, legendary: true });
      const drainAll = G.rarityValue(self, { common: false, rare: false, special: false, legendary: true });
      const opp = G.opponent(self.owner);
      const enemyMeter = G.state[opp].blockMeter || 0;
      const stolen = Math.floor(enemyMeter * stealPct);
      if (stolen > 0) {
        G.state[self.owner].blockMeter = Math.min(Game.BLOCK_MAX, G.state[self.owner].blockMeter + stolen);
        G.state[opp].blockMeter = enemyMeter - stolen;
        G.log(`Trigon steals ${stolen} Block Meter!`);
      } else {
        G.log(`Trigon reaches for the Block Meter — empty!`);
      }
      if (fillSelfToMax) {
        G.state[self.owner].blockMeter = Game.BLOCK_MAX;
        G.log(`Trigon's hatred crests — Block Meter maxed.`);
      }
      if (drainAll) {
        G.getEnemiesOf(self.owner).forEach(e => {
          if (e.currentHealth > 1) G.dealDamage(e, 2, self);
        });
        G.log(`Trigon drains 2 HP from every enemy.`);
      }
    },
    _massFreezeOnce(G, self) {
      if (self.trigonFrozen) return;
      const targets = G.getEnemiesOf(self.owner).filter(e => e.currentHealth > 0);
      if (!targets.length) {
        // Mark the freeze as fired anyway so a re-summoned Trigon
        // doesn't snap-freeze the field after a Lazarus / reanimation
        // re-deploy. "Once per instance" = once, period.
        self.trigonFrozen = true;
        return;
      }
      self.trigonFrozen = true;
      targets.forEach(e => G.freezeCardUnresistible(e, self));
      G.log(`Trigon freezes ${targets.length} enem${targets.length === 1 ? 'y' : 'ies'}!`);
    },
    onBeforeTricks(G, self, lane) {
      // Mass-freeze ALL enemies — Start of Tricks (once). Fires in the
      // SAME beat as Galactus's devour and Anakin's move (all routed
      // through runBeforeTricks at endPhase2). The once-flag prevents
      // a re-summoned Trigon (Hela / Lazarus Pit) from re-freezing
      // every round.
      CARD_ABILITIES.Trigon._massFreezeOnce(G, self);
    },
    onKill(G, self) {
      const targets = G.getChainedEnemies(self);
      if (targets.length) {
        const t = targets[Math.floor(Math.random() * targets.length)];
        G.killCard(t, self);
        G.log(`Trigon chains destruction to ${t.name}!`);
      }
    }
  }
};

// Merge abilities into CARD_DEFS (cards.js must load before this file)
CARD_DEFS.forEach(card => {
  const ab = CARD_ABILITIES[card.name];
  if (ab) Object.assign(card, ab);
});
