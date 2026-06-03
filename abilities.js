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
        // Roguelite Text+ override — _antManKillThreshold raises the
        // pick window. Default 1 (classic ≤1 ATK or ≤1 HP); Text+
        // bumps to 2 so 2/2 bodies are also valid targets.
        const t = self._antManKillThreshold || 1;
        const targets = G.getEnemiesOf(self.owner).filter(c => c.attack <= t || c.currentHealth <= t);
        if (targets.length) {
          G.promptCardChoice(self.owner, targets, "Ant-Man — Destroy", `Choose an enemy to destroy (${t} ATK or ${t} HP)`, (target) => {
            G.log(`[KILL] ${self.name} destroys ${target.name}!`); G.killCard(target, self);
          }, _aiThreatPicker);
        }
      };
      // _antManAntAtk / _antManAntHp let Text+ bump the summoned Ant
      // beyond its 1/1 base. Default 1/1 (classic); Text+ sets 4/4.
      const antAtk = self._antManAntAtk || 1;
      const antHp  = self._antManAntHp  || 1;
      G.summonCardChoice(self.owner, "Ant", 1, antAtk, antHp, ["Bullseye"], afterSummon);
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
      // Clear the previous charm target's "_charmedByIvy" tag (if any)
      // so the badge moves cleanly when we re-pick. The tag mirrors
      // _ivyAlly/.id so the badge renderer doesn't depend on object
      // identity (which can break across re-instantiations / saves).
      if (self._ivyAlly && self._ivyAlly._charmedByIvy === self.id) {
        delete self._ivyAlly._charmedByIvy;
      }
      // Belt-and-suspenders: scan board for any stale tag pointing at
      // this Ivy and clear it. Cheap (≤12 cards) and survives weird
      // re-instantiation flows.
      G.getAllCardsOnBoard().forEach(c => {
        if (c._charmedByIvy === self.id) delete c._charmedByIvy;
      });
      self._ivyAlly = null;
      self._ivyCharmedId = null;
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id && a.currentHealth > 0 && (a.attack || 0) > 0);
      if (!allies.length) {
        G.log(`[POISON IVY] No allies available to charm this turn.`);
        return;
      }
      // Roguelite Text+ override — _ivyChooseHighest copies the strongest
      // ally's attack instead of a random one. Default random (classic);
      // Text+ true picks max-attack each round, so a Hulk on the board
      // means Ivy reliably swings as a Hulk-1.
      const pick = self._ivyChooseHighest
        ? allies.slice().sort((a, b) => (b.attack || 0) - (a.attack || 0))[0]
        : allies[Math.floor(Math.random() * allies.length)];
      self._ivyAlly = pick;
      self._ivyCharmedId = pick.id; // tracked so handleDeath can strip the buff
      // Stamp a direct flag on the charmed ally pointing back at Ivy.
      // The badge renderer reads this flag — much more reliable than
      // matching object identity across getAllCardsOnBoard calls. User
      // report: "the charm status badge isn't on any ally card for ivy
      // so I can't tell who she's gaining attack from."
      pick._charmedByIvy = self.id;
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
      const target = self._ivyAlly;
      const alive = target && target.currentHealth > 0 && G.findCardLane(target) >= 0;
      if (alive) return;
      CARD_ABILITIES['Poison Ivy']._charm(G, self);
    },
    onAnyCardPlayed(G, self) {
      // Persistent charm coverage during the PLAY phase — when Ivy
      // enters before any ally lands (or when her current target is
      // gone), re-charm as soon as a fresh ally arrives so the
      // CHARMED badge tracks board state in real time. Locked once
      // tricks/combat begin: the charm is fixed for the round, and
      // if the target dies during attack phase the buff is gone with
      // no re-pick. User spec: "no ally can be charmed during the
      // attack phase, but right when the next turn starts ivy
      // charms iron man." onEndOfTurn (post-combat) handles the
      // "next turn starts" re-pick.
      const phase = (G.state && G.state.phase) || '';
      if (phase.indexOf('tricks') >= 0 || phase === 'combat') return;
      const target = self._ivyAlly;
      const alive = target && target.currentHealth > 0 && G.findCardLane(target) >= 0;
      if (alive) return;
      CARD_ABILITIES['Poison Ivy']._charm(G, self);
    }
  },
  "Black Widow": {
    onPlay(G, self, lane) {
      // Roguelite Text+ ("Wide Web") — _blackWidowSplashFreeze freezes
      // the front enemy AND both adjacent enemies (splash radius)
      // automatically. Skips the choice prompt since the targets are
      // fully implied by lane geometry.
      if (self._blackWidowSplashFreeze) {
        const opp = G.opponent(self.owner);
        const targets = [];
        const front = G.state.lanes[lane] && G.state.lanes[lane][opp];
        if (front && front.currentHealth > 0) targets.push(front);
        for (const dir of [-1, 1]) {
          const adjLane = lane + dir;
          if (adjLane < 0 || adjLane >= Game.LANE_COUNT) continue;
          const t = G.state.lanes[adjLane] && G.state.lanes[adjLane][opp];
          if (t && t.currentHealth > 0 && !t.isFrozen) targets.push(t);
        }
        if (!targets.length) return;
        targets.forEach(t => G.freezeCard(t, self));
        G.log(`Black Widow's web freezes ${targets.length} enemies in splash radius!`);
        return;
      }
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
      // Roguelite Text+ override — _manBatDebuffSize scales the on-arrival
      // weaken. Default 1 (classic -1/-1); Text+ raises to 2 (-2/-2).
      const debuffSize = self._manBatDebuffSize || 1;
      const applyDebuff = (enemy) => {
        if (!enemy) return;
        G.debuffCard(enemy, debuffSize, debuffSize, true, self);
        enemy._debuffStacks = (enemy._debuffStacks || 0) + 1;
        G.log(`[DEBUFF] Man-Bat weakens ${enemy.name} by -${debuffSize}/-${debuffSize}`);
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
      // Roguelite Text+ override — _harleyDraw scales the draw amount.
      const n = self._harleyDraw || 1;
      G.drawCards(self.owner, n);
      G.drawCards(G.opponent(self.owner), n);
      G.log(`Harley Quinn makes everyone draw ${n}!`);
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
    },
    onDamaged(G, self) {
      // Roguelite Text+ ("Chaos!") — _harleyBlockOnDmg adds N to the
      // owner's Block Meter every time Harley takes damage. Default
      // 0 (classic — no block gain); Text+ sets 3 so the chaos pivots
      // into a hard-block defensive payoff.
      const gain = self._harleyBlockOnDmg || 0;
      if (gain <= 0) return;
      const meter = G.state[self.owner].blockMeter || 0;
      G.state[self.owner].blockMeter = Math.min(Game.BLOCK_MAX, meter + gain);
      G.log(`Harley Quinn cackles — +${gain} Block Meter!`);
    }
  },
  "Jango Fett": {
    onMoved(G, self, toLane) {
      // Roguelite Text+ override — _jangoSplashOnMove scales the
      // arrival splash. Default 1 (classic); Text+ raises to 2 so
      // moving him hits a wider cone for double the damage.
      const dmg = self._jangoSplashOnMove || 1;
      G.splashDamage(toLane, self.owner, dmg);
      G.log(`Jango Fett splashes lane ${toLane + 1} for ${dmg} on arrival!`);
    },
    onBeforeTricks(G, self, lane) {
      // Roguelite Text+ ("Jetpack Salvo") — _jangoMoveLikeManBat gives
      // Jango a Man-Bat-style relocation at Start of Tricks. The
      // existing onMoved handler picks up the arrival splash. Classic
      // Jango has no movement of his own — this hook is gated.
      if (!self._jangoMoveLikeManBat) return;
      if (self.isStunned || self.isFrozen) {
        G.log(`  [SKIP] ${self.name} is ${self.isStunned ? 'STUNNED' : 'FROZEN'} — stays put.`);
        return;
      }
      const open = G.getOpenLanes(self.owner).filter(l => l !== lane);
      if (!open.length) return;
      if (Game.isHuman(self.owner)) {
        const choices = [lane, ...open];
        G.promptLaneChoice(self.owner, choices, "Jango Fett — Move", "Choose a lane to move to (current = stay)", (to) => {
          if (to === lane) {
            G.log(`Jango Fett holds his position in lane ${lane + 1}.`);
            return;
          }
          G.moveCard(self, lane, to);
        });
      } else {
        const to = open[Math.floor(Math.random() * open.length)];
        G.moveCard(self, lane, to);
      }
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
      // Roguelite Text+ ("Brute Telepath") — _groddMcCostMax overrides
      // the rarity-tier cost gate with a fixed ceiling (5).
      const maxCost = self._groddMcCostMax
        ? self._groddMcCostMax
        : G.rarityValue(self, { common: 1, rare: 3, special: 5, legendary: 9 });
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
      // Roguelite Text+ ("Trick Arrows") — _hawkeyeSplash overrides the
      // rarity-driven splash count with a fixed value (3).
      const splash = self._hawkeyeSplash
        ? self._hawkeyeSplash
        : G.rarityValue(self, { common: 1, rare: 1, special: 2, legendary: 2 });
      G.splashDamage(lane, self.owner, splash);
      G.log(`Hawkeye splashes adjacent enemies for ${splash}!`);
    },
    passive: "splashWeaken"
  },
  "Mr. Fantastic": {
    isDiscardEffect: true,
    onDiscard(G, owner, self) {
      // User spec (May 2026): "the next two cards drawn are reduced
      // by one energy" + has the "Draw 1" keyword.
      // Default (classic) = 1 off each of the next 2 draws.
      // Roguelite Text+ overrides — _fantasticDiscount scales the
      // per-draw rate; _fantasticCount sets how many draws benefit.
      const disc = (self && self._fantasticDiscount) || 1;
      const count = (self && self._fantasticCount) || 2;
      // Per-draw rate is the max in flight (multi-Mr.F overlap is rare;
      // the larger discount wins). Count accumulates so back-to-back
      // discards still hand out their share of cheaper draws.
      G.state[owner].nextDrawDiscount = Math.max(G.state[owner].nextDrawDiscount || 0, disc);
      G.state[owner].nextDrawDiscountCount = (G.state[owner].nextDrawDiscountCount || 0) + count;
      // Track the Mr. Fantastic instance that set this so drawCards can
      // credit him with actual `statsDiscountValue` at apply time.
      if (self) G.state[owner]._nextDrawDiscountSource = self;
      // "Draw 1" keyword effect — fire the actual draw. Done AFTER
      // setting the discount above so the drawn card itself benefits
      // from the cheaper-draw aura (the user's intent: discarding
      // Mr. F should immediately give them a cheaper card).
      G.drawCards(owner, 1);
    }
  },
  "Mr. Freeze": {
    onPlay(G, self, lane) {
      // Targets scale with tier: just front (common/rare), front + 1
      // adjacent (special), front + both adjacents (legendary).
      const reach = G.rarityValue(self, { common: 0, rare: 0, special: 1, legendary: 2 });
      // Roguelite Text+ ("Cryo Wall") — _mrFreezeFreezeSize raises the
      // freeze duration on each card from 1 turn to N. _mrFreezeHpFreezeHits
      // sets how many incoming HP-bar hits the shield negates (default 1).
      const freezeN = self._mrFreezeFreezeSize || 1;
      const hpHits = self._mrFreezeHpFreezeHits || 1;
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
      targets.forEach(t => G.freezeCard(t, self, freezeN));
      G.state[self.owner].healthFrozen = hpHits;
      G.state[self.owner]._healthFrozenBy = self;
      const who = Game.isHuman(self.owner) ? 'your' : 'its';
      const list = targets.length ? targets.map(t => t.name).join(', ') + ' and ' : '';
      G.log(`Mr. Freeze freezes ${list}${who} health bar (${hpHits} hits)!`);
    }
  },
  "Sabertooth": {
    onDamagePlayer(G, self) {
      // Roguelite Text+ override — _sabertoothRageSize scales the buff.
      const n = self._sabertoothRageSize || 1;
      G.buffCard(self, n, n);
      G.log(`Sabertooth grows! +${n}/+${n}`);
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
  "King Shark": {
    // Classic King Shark is a vanilla 3/3 Overdrive — no special hooks.
    // Roguelite Text+ ("Apex Predator") wires onKill to buff +N/+N
    // every time he destroys an enemy. The flag is set in apply, so
    // un-upgraded King Sharks fall through with no buff.
    onKill(G, self) {
      const buff = self._kingSharkKillBuff || 0;
      if (buff <= 0) return;
      G.buffCard(self, buff, buff);
      G.log(`King Shark feasts! +${buff}/+${buff} → ${self.attack}/${self.currentHealth}`);
    }
  },
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
      // Roguelite Text+ override — _baneRageSize scales the +N/+N buff.
      const n = self._baneRageSize || 1;
      self.attack += n;
      self.maxHealth += n;
      self.currentHealth += n;
      G.log(`Bane rages! +${n}/+${n} → ${self.attack}/${self.currentHealth}`);
    }
  },
  "Catwoman": {
    onPlay(G, self, lane) {
      // Cost-1 1/1 with Bullseye + Evade 1 (def-side). On play she
      // steals N energy from the opponent next turn — same swing the
      // old isDiscardEffect Catwoman had, just on a real body now.
      // Roguelite Text+ override — _catwomanSteal scales the swing.
      const owner = self && self.owner;
      if (!owner) return;
      const n = (self && self._catwomanSteal) || 1;
      const opp = G.opponent(owner);
      G.addNextTurnCurrency(owner, n);
      G.addNextTurnCurrency(opp, -n);
      G.log(`Catwoman steals ${n} energy from the enemy next turn!`);
      // v3 — credit Catwoman with the energy swing (gain N self, deny N enemy).
      G._creditChain(self, 'statsDiscountValue', n * 2);
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
      // Roguelite Text+ override — _gamoraExecuteThreshold raises the
      // execute ceiling. Default 2 (classic); Text+ bumps to 4 so mid-
      // tier targets are also one-shot eligible.
      const threshold = self._gamoraExecuteThreshold || 2;
      const targets = G.getEnemiesOf(self.owner).filter(c => c.currentHealth <= threshold);
      if (targets.length) {
        G.promptCardChoice(self.owner, targets, "Gamora — Execute", `Choose enemy with ${threshold} or less HP to destroy`, (t) => {
          G.log(`Gamora executes ${t.name}!`); G.killCard(t, self);
        }, _aiThreatPicker);
      }
    },
    onKill(G, self) {
      // Roguelite Text+ ("Most Dangerous Woman") — _gamoraKillBuff
      // scales the on-kill buff. Default 1 (classic +1/+1); Text+ to 3.
      const buff = self._gamoraKillBuff || 1;
      G.buffCard(self, buff, buff);
      G.log(`Gamora grows stronger! +${buff}/+${buff} → ${self.attack}/${self.currentHealth}`);
    }
  },
  "Ghostface": {
    onPlay(G, self, lane) {
      // Roguelite Text+ ("Mass Hysteria") swaps the classic (2/1)
      // Bullseye summon for a personal-power upgrade: Overdrive + Evade
      // 3 (set in apply) plus +1/+1 per card in hand on play. Apply
      // path already added Overdrive and Evade 3 to the runtime card,
      // so we only need to handle the hand-count buff here.
      // Classic path: spawn the (2/1) Bullseye summon (legacy behavior).
      if (self._ghostfaceHandBuff) {
        const handCount = (G.state[self.owner].hand || []).length;
        if (handCount > 0) {
          G.buffCard(self, handCount, handCount);
          G.log(`Ghostface stalks the crowd! +${handCount}/+${handCount} (one for each card in hand).`);
        }
        return;
      }
      // _ghostfaceSpawns left for save-state compatibility — defaults
      // to 1 if undefined so classic Ghostface still summons one body.
      const count = self._ghostfaceSpawns || 1;
      for (let i = 0; i < count; i++) {
        G.summonCardChoice(self.owner, "Ghostface", 2, 2, 1, ["Bullseye"]);
      }
    }
  },
  "Human Torch": {
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _humanTorchBlast scales the targeted
      // damage. Default 2 (classic); Text+ raises to 4 so the directed
      // blast can finish mid-cost bodies on its own.
      const blast = self._humanTorchBlast || 2;
      // _humanTorchArrivalSplash scales the splash on entry. Default 1
      // (classic); Text+ raises to 3.
      const arrival = self._humanTorchArrivalSplash || 1;
      G.splashDamage(lane, self.owner, arrival);
      G.log(`Human Torch ignites on arrival — Splash ${arrival}!`);
      const enemies = G.getEnemiesOf(self.owner);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Human Torch — Blast", `Choose enemy to deal ${blast} damage`, (t) => {
          G.dealDamage(t, blast); G.log(`Human Torch blasts ${t.name} for ${blast}!`);
        }, cards => _aiKillPicker(cards, blast));
      }
    }
  },
  "Invisible Woman": {
    onPlay(G, self, lane) {
      // Roguelite Text+ ("Force Field") swaps the classic Evade grant
      // for Invincibility N turns + (+M/+M). _iwInvincibility / _iwBuffSize
      // are set by the apply hook; default falls back to the classic
      // Evade-1 grant scaled by _iwEvadeAmount.
      const invincN = self._iwInvincibility || 0;
      const buffN = self._iwBuffSize || 0;
      const evadeN = self._iwEvadeAmount || 1;
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id);
      const grant = (a) => {
        if (invincN > 0) {
          // Permanent stat bump (no temp-buff turns) so the +3/+3 sticks
          // beyond the Invincibility window — matches the Yoda /
          // Star-Lord buff convention. Invincibility itself uses
          // grantTempBuff so it expires after N turns.
          if (buffN > 0) G.buffCard(a, buffN, buffN);
          G.grantTempBuff(a, { invincibleTurns: invincN }, invincN);
          const tail = buffN > 0 ? ` and (+${buffN}/+${buffN})` : '';
          G.log(`Invisible Woman grants Invincibility ${invincN}${tail} to ${a.name}!`);
        } else {
          G.grantTempBuff(a, { evadeCharges: evadeN });
          G.log(`Invisible Woman grants Evade ${evadeN} to ${a.name} for 1 turn!`);
        }
      };
      if (allies.length) {
        const title = invincN > 0 ? "Invisible Woman — Invincibility" : "Invisible Woman — Evade";
        const desc = invincN > 0
          ? `Choose ally to give Invincibility ${invincN}${buffN > 0 ? ` and (+${buffN}/+${buffN})` : ''}`
          : `Choose ally to give Evade ${evadeN} (1 turn)`;
        G.promptCardChoice(self.owner, allies, title, desc, grant,
          cards => cards.sort((a, b) => b.attack - a.attack)[0]);
      }
    },
    passive: "faceDownOption"
  },
  "Nightwing": {
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _nightwingDebuff scales the ATK strip.
      // Default 2 (classic); Text+ raises to 3 so big bodies (Hulk, Doom)
      // get reduced to swingable numbers in one play.
      const debuff = self._nightwingDebuff || 2;
      const enemies = G.getEnemiesOf(self.owner);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Nightwing — Weaken", `Choose enemy to remove ${debuff} Attack from`, (t) => {
          G.debuffCard(t, debuff, 0, false, self); G.log(`Nightwing weakens ${t.name} by ${debuff} ATK!`);
        }, _aiThreatPicker);
      }
    }
  },
  "Peacemaker": {
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _peacemakerKillThreshold raises the
      // ATK ceiling for the eliminate. Default 2 (classic); Text+ to 4
      // so mid-range threats (Spawn, Wonder Woman) are valid targets.
      const threshold = self._peacemakerKillThreshold || 2;
      const targets = G.getEnemiesOf(self.owner).filter(c => c.attack <= threshold);
      if (targets.length) {
        G.promptCardChoice(self.owner, targets, "Peacemaker — Eliminate", `Choose enemy with ${threshold} or less ATK to destroy`, (t) => {
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
      // Roguelite Text+ override — _flashFreezeAll skips the picker and
      // freezes BOTH adjacent enemies. Default false (classic — pick 1);
      // Text+ true (freeze all adj). User direction: Speed Force scaling
      // — the Flash literally moves twice.
      const freezeAll = !!self._flashFreezeAll;
      const freezeTarget = () => {
        if (freezeAll && adj.length) {
          adj.forEach(e => G.freezeCard(e, self));
          chooseFirst();
        } else if (adj.length > 1) {
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
      // Roguelite Text+ override — _ahsokaBonusAttacksPerKill scales the
      // bonus attacks granted per ally death. Default 1 (classic);
      // Text+ raises to 2 so a 2-ally trade gives Ahsoka 4 free swings.
      const grant = self._ahsokaBonusAttacksPerKill || 1;
      self.bonusAttack = (typeof self.bonusAttack === 'number' ? self.bonusAttack : 0) + grant;
    }
  },
  "Carnage": {
    onBeforeTricks(G, self, lane) {
      if (self.carnageHealed) return;
      // Roguelite Text+ ("Bloodbath") — _carnageHealAllCards counts
      // EVERY card on the board (your allies + opp's enemies).
      // Classic / no-upgrade path counts only enemies × _carnageHealMul.
      let amount;
      if (self._carnageHealAllCards) {
        amount = G.getAllCardsOnBoard().length;
      } else {
        const ct = G.getEnemiesOf(self.owner).length;
        const mul = self._carnageHealMul || 1;
        amount = ct * mul;
      }
      if (amount > 0) {
        G.healPlayer(self.owner, amount, self);
        G.log(`Carnage heals you for ${amount}!`);
        self.carnageHealed = true;
      }
    }
  },
  "Deathstroke": {
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _deathstrokeKillThreshold raises the
      // assassinate ceiling. Default 3 (classic); Text+ sets to 5 so
      // mid-tier targets are also one-shot-able.
      const threshold = self._deathstrokeKillThreshold || 3;
      const targets = G.getEnemiesOf(self.owner).filter(c => c.currentHealth <= threshold);
      if (targets.length) {
        G.promptCardChoice(self.owner, targets, "Deathstroke — Assassinate", `Choose enemy with ${threshold} or less HP to destroy`, (t) => {
          G.log(`Deathstroke assassinates ${t.name}!`); G.killCard(t, self);
        }, _aiThreatPicker);
      }
    },
    onKill(G, self) {
      // Roguelite Text+ override — _deathstrokeKillBuff scales the
      // on-kill buff. Default 1 (classic +1/+1); Text+ raises to 2.
      const buff = self._deathstrokeKillBuff || 1;
      G.buffCard(self, buff, buff);
      G.log(`Deathstroke sharpens! +${buff}/+${buff} → ${self.attack}/${self.currentHealth}`);
    }
  },
  "Dr. Octopus": {
    passive: "extraCurrency"
  },
  "Spawn": {
    // Classic Spawn has no special onDeath — he's a vanilla 3/3 with
    // Bullseye + Overdrive. The Roguelite Text+ ("Hellspawn Rises")
    // upgrade flips his death into a self-revive with +5/+5 by
    // setting reviveCharges = 1 and _draxReviveBuff = 5. (Internal
    // `_draxReviveBuff` name kept for save-data back-compat — the
    // card was renamed from Drax but the state property name
    // stays put.)
    onDeath(G, self, lane) {
      if (!(self.reviveCharges > 0) || !self._draxReviveBuff) return;
      self.reviveCharges--;
      const buff = self._draxReviveBuff;
      self.attack += buff;
      self.maxHealth += buff;
      self.currentHealth = self.maxHealth;
      G.placeInLane(self.owner, self, lane);
      G.log(`Spawn rises from the abyss! +${buff}/+${buff} → ${self.attack}/${self.maxHealth}`);
      return true;
    }
  },
  "Green Goblin": {
    _recurringBT: true,
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _goblinBombBoost adds +1 to each
      // pumpkin-bomb splash. Default 0 (classic 1+2); Text+ sets to 1
      // so the bombs hit for 2+3 (one extra damage on each splash).
      const boost = self._goblinBombBoost || 0;
      G.splashDamage(lane, self.owner, 1 + boost);
      G.splashDamage(lane, self.owner, 2 + boost);
      G.log(`Green Goblin throws pumpkin bombs! Splash ${1 + boost} then Splash ${2 + boost}!`);
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
      // Roguelite Text+ override — _grootProtectsSelf includes Groot
      // himself in the immunity grant. Default false (classic protects
      // adjacent allies only); Text+ true so Groot is also untouchable
      // for the round (3 cards safe instead of 2).
      const includeSelf = !!self._grootProtectsSelf;
      const lanes = [lane - 1, lane + 1];
      if (includeSelf) lanes.push(lane);
      lanes.forEach(l => {
        if (l >= 0 && l < Game.LANE_COUNT && G.state.lanes[l][own]) {
          G.grantTempBuff(G.state.lanes[l][own], { hasDamageImmunity: true });
        }
      });
      G.log(includeSelf
        ? "Groot protects himself AND adjacent allies for 1 turn!"
        : "Groot protects adjacent allies for 1 turn!");
    }
  },
  "Jigsaw": {
    isDiscardEffect: true,
    onDiscard(G, owner, self) {
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
      // Roguelite Text+ override — _jigsawTrapCount scales the trap
      // count. Default 3 (classic); Text+ to 5 so a fresh Jigsaw can
      // mine the entire enemy side.
      const trapCount = (self && self._jigsawTrapCount) || 3;
      const placeTrapStep = (remaining) => {
        // Only lanes that are empty on the enemy side AND not already trapped qualify.
        const open = [];
        for (let i = 0; i < G.LANE_COUNT; i++) {
          const l = G.state.lanes[i];
          if (!l.destroyed && !l[opp] && !l.trap) open.push(i);
        }
        if (remaining <= 0) { moveEnemyStep(); return; }
        if (open.length === 0) {
          G.log(`Jigsaw — no empty enemy lanes, ${remaining} bear trap${remaining === 1 ? '' : 's'} wasted.`);
          moveEnemyStep();
          return;
        }
        // Trap N of 3 wording — user feedback: "Jigsaw is only placing
        // two traps for me." The previous "(3 remaining)" / "(2
        // remaining)" / "(1 remaining)" wording was ambiguous —
        // "remaining" reads to some users as "already placed" so they
        // stop after seeing "1 remaining" thinking the chain is over.
        // "Trap N of 3" makes it unambiguous which step you're on.
        const stepNumber = trapCount - remaining + 1;
        G.promptLaneChoice(owner, open,
          `Jigsaw — Set Bear Trap`,
          `Choose an enemy lane to set Bear Trap ${stepNumber} of ${trapCount}`,
          (lane) => {
            const debuff = (self && self._jigsawTrapDebuff) || 1;
            G.state.lanes[lane].trap = { placedBy: owner, debuff };
            G.log(`[BEAR TRAP ${stepNumber}/${trapCount}] Jigsaw sets a Reverse Bear Trap in lane ${lane + 1}!`);
            placeTrapStep(remaining - 1);
          },
          opp);
      };

      G.log(`Jigsaw's game begins — set ${trapCount} traps, then drag an enemy.`);
      placeTrapStep(trapCount);
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
    // Fields that get nulled / zeroed on strip. Listed once so the strip
    // and restore paths can't drift.
    const STRIP_FIELDS = [
      'onPlay', 'onDeath', 'onDamaged', 'onKill', 'onBeforeTricks',
      'onBeforeAttack', 'onEndOfTurn', 'onAnyCardPlayed', 'onAllyKilled',
      'onEvade', 'onDamagePlayer', 'onTurnStart', 'passive',
      'evadeCharges', 'armorValue', 'isOverdrive', 'isBullseye',
      'immunityCharges', 'hasHunt', 'hasDamageImmunity',
      'unresistibleCharges', 'splashRange', 'invincibleTurns', 'tauntTurns',
      'isUntrickable',
    ];
    const strip = (card, G) => {
      // Bug fix: previously a stripped card that returned to hand via
      // Phantom Zone (or any future bounce) stayed permanently de-fanged
      // because addToHand had no restore path. Snapshot the original
      // values so unstrip() can put them back when the card leaves the
      // board. Only snapshot once — re-stripping shouldn't overwrite the
      // backup with already-stripped values.
      if (!card._moderBackup) {
        const backup = {};
        for (const k of STRIP_FIELDS) backup[k] = card[k];
        backup._permanentUntrickable = !!card.permanentUntrickable;
        card._moderBackup = backup;
      }
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
      // Stamp the restore function ON the card so the engine can call
      // card._unstripModer() without importing Moder's internals. Engine
      // calls this from addToHand() when a stripped card bounces back.
      card._unstripModer = () => {
        if (!card._moderStripped || !card._moderBackup) return;
        const b = card._moderBackup;
        for (const k of STRIP_FIELDS) card[k] = b[k];
        card._moderStripped = false;
        card._moderBackup = null;
        card._unstripModer = null;
      };
      G.log(`Moder strips all abilities from ${card.name}!`);
    };
    return {
      onPlay(G, self, lane) {
        const opp = G.opponent(self.owner);
        // Force opponent's next card into Moder's lane. Do NOT strip anyone
        // already there — only the single forced arrival loses abilities.
        // Roguelite Text+ override — _moderStripCount lets Moder strip
        // multiple subsequent arrivals. Default 1 (classic); Text+ to 2
        // so two consecutive enemies coming into his lane both lose
        // their kits. The forcedLane only fires once per round (engine
        // limitation), but the strip-pending counter persists until
        // exhausted, so the SECOND target gets stripped on whichever
        // round it lands.
        G.state[opp].forcedLane = lane;
        self._moderStripPending = (self._moderStripCount || 1);
        G.log(`Moder compels the next enemy card into lane ${lane + 1}!`);
      },
      onAnyCardPlayed(G, self) {
        // Strip the next N cards that land in Moder's lane, where N is
        // _moderStripPending (1 or 2). Each strip decrements the counter.
        if (!self._moderStripPending || self._moderStripPending <= 0) return;
        const myLane = G.findCardLane(self);
        if (myLane < 0) return;
        const opp = G.opponent(self.owner);
        const enemy = G.state.lanes[myLane][opp];
        if (enemy && !enemy._moderStripped) {
          strip(enemy, G);
          self._moderStripPending -= 1;
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
      // Roguelite Text+ override — _redSkullEmpower scales the buff.
      // Default 2 (classic +2/+2); Text+ raises to 3 (+3/+3) for an
      // even bigger finisher buff.
      const empower = self._redSkullEmpower || 2;
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id);
      const grant = (a) => {
        G.buffCard(a, empower, empower);
        G.log(`Red Skull empowers ${a.name} +${empower}/+${empower}!`);
      };
      if (allies.length) {
        G.promptCardChoice(self.owner, allies, "Red Skull — Empower", `Choose an ally to give +${empower}/+${empower}`, grant,
          // AI picks the highest-cost ally — biggest absolute swing
          // from the flat buff (a 9-cost finisher gets disproportionately
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
      // Roguelite Text+ override — _witchHexBonus adds extra ATK/HP on
      // top of the copied stats. Default 0 (classic mirrors exactly);
      // Text+ raises to 2 so Scarlet Witch comes in +2/+2 over her
      // hex target — turns mirror into outright trade.
      const bonus = self._witchHexBonus || 0;
      if (enemy && enemy.currentHealth > 0) {
        const adoptAtk = (enemy.attack || 0) + bonus;
        const adoptHp  = (enemy.currentHealth || enemy.maxHealth || 1) + bonus;
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
        self.attack = 3 + bonus;
        self.baseAttack = 3 + bonus;
        self.currentHealth = 4 + bonus;
        self.maxHealth = 4 + bonus;
        self.baseHealth = 4 + bonus;
        self.copiesOpposite = false;
        G.log(`Scarlet Witch finds nothing to copy — defaults to ${3 + bonus}/${4 + bonus}.`);
      }
    }
  },
  "Solomon Grundy": {
    onDeath(G, self, lane) {
      // Roguelite Text+ ("Born on Monday") replaces the dead-pile draw
      // with a revive-and-grow loop. _grundyReviveBuff is the per-revive
      // ATK/HP gain; reviveCharges (set in apply) gates how many times
      // he can come back. When the upgrade is active we revive him in
      // place and skip the classic draw entirely.
      if (self._grundyReviveBuff && self.reviveCharges > 0) {
        self.reviveCharges--;
        const buff = self._grundyReviveBuff;
        self.attack += buff;
        self.maxHealth += buff;
        self.currentHealth = self.maxHealth;
        G.placeInLane(self.owner, self, lane);
        G.log(`Solomon Grundy returns from the muck! +${buff}/+${buff} → ${self.attack}/${self.maxHealth} (${self.reviveCharges} revives left)`);
        return true;
      }
      // Classic / non-upgraded path — draw from dead pile.
      const draws = self._grundyDeathDraw || 1;
      // ROGUELITE-ONLY: Grundy scavenges from his OWN dead pile only.
      // User feedback: "Solomon Grundy is such a broken card because
      // you just get more card draw" — the cross-side scavenge stacks
      // with the Lex-block bypass to make Grundy mandatory in roguelite.
      // Classic Grundy keeps the canonical "shared Dead Pile" text.
      const isRoguelite = G.state.mode && G.state.mode._roguelite;
      const ownDead = G.state[self.owner] && G.state[self.owner].deadPile;
      const oppDead = G.state[G.opponent(self.owner)] && G.state[G.opponent(self.owner)].deadPile;
      for (let i = 0; i < draws; i++) {
        const dead = isRoguelite
          ? (ownDead || [])
          : [...(ownDead || []), ...(oppDead || [])];
        if (!dead.length) break;
        const idx = Math.floor(Math.random() * dead.length);
        let card;
        if (isRoguelite) {
          card = ownDead.splice(idx, 1)[0];
        } else if (idx < (ownDead || []).length) {
          card = ownDead.splice(idx, 1)[0];
        } else {
          card = oppDead.splice(idx - ownDead.length, 1)[0];
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
      // Roguelite Text+ override — _symbioteSkipSelf makes the shuffle
      // hit only the OPPONENT's hand (your own hand stays put). Default
      // false (classic shuffles both); Text+ true makes it pure
      // disruption with no self-cost.
      const skipSelf = !!self._symbioteSkipSelf;
      const finish = () => {
        G.healPlayer(self.owner, 2, self);
        G.log("Symbiote Spider-Man heals you for 2!");
      };
      if (skipSelf) {
        doPlayerShuffle(opp, finish);
      } else {
        doPlayerShuffle(self.owner, () => doPlayerShuffle(opp, finish));
      }
    }
  },
  "Winter Soldier": {
    onPlay(G, self, lane) {
      // Roguelite Text+ override — promotes destroy threshold from 3
      // to whatever's in self._wsCostThreshold. Defaults to 3 so classic
      // mode is unchanged.
      const threshold = self._wsCostThreshold || 3;
      const targets = G.getEnemiesOf(self.owner).filter(c => c.attack <= threshold);
      if (targets.length) {
        G.promptCardChoice(self.owner, targets, "Winter Soldier — Eliminate", `Choose enemy with ${threshold} or less ATK to destroy`, (t) => {
          G.log(`Winter Soldier eliminates ${t.name}!`); G.killCard(t, self);
        }, _aiThreatPicker);
      }
    },
    onKill(G, self) {
      // Roguelite Text+ override — buff size scales via _wsBuffSize.
      const buff = self._wsBuffSize || 1;
      G.buffCard(self, buff, buff);
      G.log(`Winter Soldier toughens! +${buff}/+${buff} → ${self.attack}/${self.currentHealth}`);
    }
  },

  // ==================== COST 4 ====================
  "Anti-Venom": {
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _antivenomHeal scales heal amount.
      const heal = self._antivenomHeal || 4;
      G.healPlayer(self.owner, heal, self);
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
      // Roguelite Text+ override — _blackPantherFreeThreshold raises the
      // ceiling for free-cast picks. Default 3 (classic); Text+ raises
      // to 5 so mid-cost cards (Wonder Woman, Superman, etc.) become
      // free-cast candidates.
      const threshold = self._blackPantherFreeThreshold || 3;
      const freeCards = hand.filter(c => (c.baseCost != null ? c.baseCost : c.cost) <= threshold && !c.isDiscardEffect);
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
      // Classic: random card pulled from your hand and summoned in
      // Cyborg's slot. Roguelite Text+ ("Replication") sets
      // _cyborgChooseFromHand so the human player gets to PICK which
      // card to summon — turning Cyborg into a controllable late-game
      // closer instead of a roll of the dice.
      const hand = G.state[self.owner].hand;
      // Clear Cyborg from the slot so the summon can take its place.
      if (G.state.lanes[lane] && G.state.lanes[lane][self.owner] === self) {
        G.state.lanes[lane][self.owner] = null;
      }
      const eligible = hand.filter(c => !c.isDiscardEffect);
      if (!eligible.length) return;
      // Pick destination — prefer Cyborg's old lane, fall back to any open.
      const pickTargetLane = () => {
        if (G.state.lanes[lane] && !G.state.lanes[lane][self.owner]) return lane;
        const open = G.getOpenLanes(self.owner);
        return open.length ? open[0] : -1;
      };
      const summonChoice = (card) => {
        const targetLane = pickTargetLane();
        if (targetLane < 0) return;
        const handIdx = hand.indexOf(card);
        if (handIdx >= 0) hand.splice(handIdx, 1);
        const def = (typeof CARD_DEFS !== 'undefined' && CARD_DEFS.find(d => d.name === card.name)) || card;
        G.log(`Cyborg's last act: summoning ${card.name} from your hand!`);
        G.summonCard(
          self.owner, targetLane, card.name,
          card.baseCost || card.cost,
          card.attack,
          card.maxHealth || card.health,
          card.abilities || [],
          def
        );
      };
      if (self._cyborgChooseFromHand && Game.isHuman(self.owner)) {
        G.promptCardChoice(self.owner, eligible,
          'Cyborg — Replication',
          'Choose a card from your hand to summon in Cyborg\'s lane',
          summonChoice,
          cards => cards.slice().sort((a, b) => (b.baseCost || b.cost) - (a.baseCost || a.cost))[0]);
      } else {
        // Classic / AI path — random pick (matches the previous default
        // behavior; AI can also follow this branch for the upgraded
        // card since prompting an AI seat for a hand pick has no UX).
        const pick = eligible[Math.floor(Math.random() * eligible.length)];
        summonChoice(pick);
      }
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
      // Roguelite Text+ override — _deadpoolNoGiveBack skips the trade
      // step entirely. Default false (classic — give one back); Text+
      // true makes Deadpool a pure card thief: steal one, no return.
      const skipGiveBack = !!self._deadpoolNoGiveBack;
      // When AI's Deadpool dies, the AI auto-picks both cards in
      // the trade — the player sees their hand silently change. To
      // make the swap legible, fire a single AI-trick toast with
      // both card names once the trade resolves. Only shows when
      // the human player is the victim (self.owner === 'ai'); a
      // human Deadpool already chose the cards themselves.
      const showVictimToast = (stolenName, givenName) => {
        if (self.owner === 'ai' && typeof UI !== 'undefined' && UI.showAITrickToast) {
          const desc = givenName
            ? `Stole <b>${stolenName}</b> · gave you <b>${givenName}</b>`
            : `Stole <b>${stolenName}</b> — no trade.`;
          try { UI.showAITrickToast("Deadpool's Final Trick", desc, 'trick'); } catch (e) {}
        }
      };
      G.promptCardChoice(self.owner, faceDownDeck,
        "Deadpool's Final Trick",
        "Pick a face-down card from the enemy's hand to steal",
        (stolen) => {
          const idx = G.state[opp].hand.indexOf(stolen);
          if (idx >= 0) G.state[opp].hand.splice(idx, 1);
          stolen.owner = self.owner;
          G.addToHand(self.owner, stolen, self);
          G.log(`Deadpool steals ${stolen.name} from the enemy's hand!`);

          if (skipGiveBack) {
            G.log(`Deadpool keeps ${stolen.name} — no trade!`);
            showVictimToast(stolen.name, null);
            return;
          }

          // Step 2: Player picks a card from their own hand to give to the enemy.
          // Exclude the just-stolen card so the player can't immediately give it back.
          const myHand = G.state[self.owner].hand.filter(c => c.id !== stolen.id);
          if (!myHand.length) {
            G.log("Deadpool has no cards to give in return.");
            showVictimToast(stolen.name, null);
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
              showVictimToast(stolen.name, given.name);
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
        // Roguelite Text+ override — _lanternEnergyBonus adds flat energy
        // on top of the damage conversion. Default 0 (classic 1:1);
        // Text+ to 2 so a 4-damage round becomes +6 energy next turn.
        const bonus = self._lanternEnergyBonus || 0;
        const grant = dmg + bonus;
        G.addNextTurnCurrency(self.owner, grant);
        G.log(`Green Lantern channels ${dmg} damage into +${grant} energy next round${bonus > 0 ? ` (+${bonus} bonus)` : ''}!`);
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
      // Jason revives ONCE PER GAME (not per-instance) by default. If a
      // prior Jason already revived this game, subsequent plays/jumps
      // get no revive. Flag lives on the owner's state so a freshly-
      // played Jason can't "reset" the revive by being a new instance.
      // Roguelite Text+ override — _jasonNoOnceLimit removes the once-
      // per-game lock so Jason can revive on every kill (provided he
      // still has reviveCharges). Default false (classic single-use);
      // Text+ true makes him a recurring slasher.
      if (!self._jasonNoOnceLimit && G.state[self.owner].jasonReviveUsed) {
        return; // already used this game
      }
      if (self.reviveCharges > 0) {
        self.reviveCharges--;
        if (!self._jasonNoOnceLimit) {
          G.state[self.owner].jasonReviveUsed = true;
        }
        // Roguelite Text+ ("Crystal Lake Killer") — _jasonReviveBuff
        // raises the per-revive ATK and HP gain. Default classic
        // behavior is +1 ATK / +2 HP; Text+ sets +3/+3 each revive.
        const buff = self._jasonReviveBuff;
        if (buff) {
          self.attack += buff;
          self.maxHealth += buff;
        } else {
          self.attack += 1;
          self.maxHealth += 2;
        }
        self.currentHealth = self.maxHealth;
        G.placeInLane(self.owner, self, lane);
        // Revive bypasses Game.playCard, so the registry-based play cue
        // wouldn't auto-fire here — call it explicitly so the ki-ki-ki /
        // ma-ma-ma sting lands on resurrection too.
        if (typeof UI !== 'undefined' && UI.sfx) UI.sfx.playCardSfx('Jason Voorhees', 'play');
        const limitText = self._jasonNoOnceLimit ? '' : ' (once per game)';
        G.log(`Jason Voorhees rises again as ${self.attack}/${self.maxHealth}${limitText}`);
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
        // Wrap the chain attack so an Overdrive ally (Michael Myers,
        // King Shark, Wolverine post-revive, etc.) still gets its
        // "attack again on kill" bonus when the kill came from
        // Optimus's command rather than the normal combat phase.
        //
        // User report: "I played Optimus Prime on Michael Myers, and
        // he killed somebody in front of him. He has Overdrive. So
        // technically he should attack again and hit face."
        //
        // The vanilla combat path (Game.resolveCombatLane) already
        // calls handleOverdrive after combat damage when a kill
        // happens (game.js:2799-2800). dealDamage doesn't — it has
        // no concept of "this was an attack." So when the chain
        // damage finishes off the target, we manually fire
        // handleOverdrive at the ally's lane. handleOverdrive picks
        // its own next target (post-cleanup opposite-lane enemy or
        // face damage) and recurses on subsequent kills, matching
        // the in-combat behavior exactly.
        const chainAttack = (ally, target) => {
          const targetHpBefore = target.currentHealth;
          G.dealDamage(target, ally.attack, ally);
          // Determine if THIS specific dealDamage landed the kill —
          // can't just check ally.currentHealth or target.currentHealth
          // alone since the target could already be dead from another
          // ability earlier this frame.
          const killed = targetHpBefore > 0 && target.currentHealth <= 0;
          if (killed && ally.isOverdrive && ally.currentHealth > 0) {
            const allyLane = G.findCardLane(ally);
            if (allyLane >= 0) G.handleOverdrive(ally, allyLane);
          }
        };
        const doAttack = (ally) => {
          const opp = G.opponent(self.owner);
          let targets = [];
          const oppLane = G.state.lanes[lane][opp];
          if (oppLane && oppLane.currentHealth > 0) targets.push(oppLane);
          G.getAdjacentEnemiesInContext(lane, self.owner).forEach(e => { if (e.currentHealth > 0 && !targets.includes(e)) targets.push(e); });
          if (Game.isHuman(self.owner) && targets.length) {
            G.promptCardChoice(self.owner, targets, "Optimus — Target", `Choose enemy for ${ally.name} to attack`, (target) => {
              chainAttack(ally, target);
              G.log(`Optimus commands ${ally.name} to attack ${target.name} for ${ally.attack}!`);
            });
          } else if (targets.length) {
            chainAttack(ally, targets[0]);
            G.log(`Optimus commands ${ally.name} to attack ${targets[0].name} for ${ally.attack}!`);
          }
        };
        // Roguelite Text+ override — _optimusCommandsBoth makes him
        // command BOTH adjacent allies to attack instead of just one.
        // Default false (classic — pick one); Text+ true (skip the
        // pick, fire both). User direction: scaling that fits the
        // Autobot-leader fantasy.
        if (self._optimusCommandsBoth) {
          adj.forEach(ally => doAttack(ally));
        } else if (Game.isHuman(self.owner)) {
          G.promptCardChoice(self.owner, adj, "Optimus — Choose Ally", "Choose adjacent ally to command", doAttack);
        } else {
          doAttack(adj[0]);
        }
      }
    }
  },
  "Predator": {
    // Trophy buff applied on every Predator kill — the body shape is
    // shared between the on-play strike that finishes off the target
    // and the generic onKill that fires when Predator wins a normal
    // combat exchange. Classic = +1/+0; Text+ "_predatorTrophyBuff"
    // bumps to +N/+N (apply-side default 2).
    _claimTrophy(G, self) {
      const atk = self._predatorTrophyBuff || 1;
      const hp  = self._predatorTrophyBuff || 0;
      G.buffCard(self, atk, hp);
      G.log(`Predator claims a trophy! +${atk}/+${hp} → ${self.attack}/${self.currentHealth}`);
    },
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _predatorStrikeDamage scales the
      // initial strike. Default 3 (classic); Text+ raises to 5 so
      // bigger targets eat the opener.
      const dmg = self._predatorStrikeDamage || 3;
      const enemies = G.getEnemiesOf(self.owner);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Predator — Strike", `Choose enemy to deal ${dmg} damage`, (t) => {
          G.dealDamage(t, dmg);
          G.log(`Predator strikes ${t.name} for ${dmg}!`);
          if (t.currentHealth <= 0) CARD_ABILITIES.Predator._claimTrophy(G, self);
        }, cards => _aiKillPicker(cards, dmg));
      }
    },
    onKill(G, self) {
      CARD_ABILITIES.Predator._claimTrophy(G, self);
    }
  },
  "Michael Myers": {
    // Jump mechanic — actual logic lives in Game.checkJumpConditions / Game.playJumpCard.
    // When Played: lone-wolf bonus. If no other allies are on the board when he arrives,
    // Michael Myers is at his deadliest — +1/+1 (or +2/+2 with Text+).
    onPlay(G, self, lane) {
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id && a.currentHealth > 0);
      if (!allies.length) {
        // Roguelite Text+ override — _myersAloneBuff scales the lone-
        // wolf reward. Default 1 (classic +1/+1); Text+ raises to 2
        // so the stalker fantasy hits harder when isolation pays off.
        const buff = self._myersAloneBuff || 1;
        G.buffCard(self, buff, buff);
        G.log(`Michael Myers stalks alone — +${buff}/+${buff}!`);
      }
    },
    onDeath(G, self) { self.jumpReady = false; self.jumpLane = undefined; }
  },
  "Raven": {
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      // Capture the opp's meter BEFORE zeroing so the Text+ steal path
      // can transfer it to the player. _ravenStealsBlock = true sets
      // the steal mode; default is just-drain.
      const drainedAmount = G.state[opp].blockMeter || 0;
      G.state[opp].blockMeter = 0;
      G.log(`Raven empties the opponent's Block Meter!`);
      G.getAlliesOf(self.owner).forEach(a => {
        // Clear counters AND booleans together — debuff stacking
        // refactor uses counters as the source of truth.
        a.stunnedTurns = 0; a.isStunned = false;
        a.frozenTurns  = 0; a.isFrozen  = false;
      });
      G.log("Raven cleanses all allies!");
      // Roguelite Text+ override — _ravenStealsBlock converts the
      // drain into a transfer. Default false (classic just zeroes
      // opp); Text+ pours the drained amount into your own meter.
      if (self._ravenStealsBlock && drainedAmount > 0) {
        G.state[self.owner].blockMeter = Math.min(Game.BLOCK_MAX, (G.state[self.owner].blockMeter || 0) + drainedAmount);
        G.log(`Raven steals ${drainedAmount} block from the opponent!`);
      }
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
        // Roguelite Text+ override — _grinchKeepCostBump scales the cost
        // penalty on kept tricks. Default 1 (classic); Text+ sets to 0
        // so kept tricks are completely free.
        const keepBump = (self._grinchKeepCostBump != null) ? self._grinchKeepCostBump : 1;
        const keep = () => {
          // Clamp at 0 — multiple Text+ stacks can drive keepBump
          // negative (refund), but a trick can't have a sub-zero cost
          // in the engine. Negative bumps still floor the trick to 0.
          chosen.cost = Math.max(0, (chosen.cost || 0) + keepBump);
          G.addToTrickHand(self.owner, chosen);
          const label = keepBump > 0 ? ` (cost +${keepBump})`
            : keepBump < 0 ? ` (cost ${keepBump} → ${chosen.cost})`
            : ' (free!)';
          G.log(`The Grinch keeps ${chosen.name}${label}!`);
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
              { name: `Keep ${chosen.name}`, desc: keepBump > 0
                ? `Add to your tricks (cost +${keepBump}, becomes ${chosen.cost + keepBump})`
                : keepBump < 0
                  ? `Add to your tricks at reduced cost (${Math.max(0, chosen.cost + keepBump)})`
                  : `Add to your tricks at the same cost (${chosen.cost}) — free!`, _action: 'keep' },
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
      // Roguelite Text+ — _venomFreezeSize scales the freeze. Default
      // 1 (classic); Text+ sets 2.
      const freezeN = self._venomFreezeSize || 1;
      const enemies = G.getEnemiesOf(self.owner);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Venom — Freeze", `Choose enemy to Freeze ${freezeN}`, (e) => {
          G.freezeCard(e, self, freezeN);
        }, _aiThreatPicker);
      }
    },
    onBeforeTricks(G, self, lane) {
      if (self.venomHealed) return;
      // Roguelite Text+ ("Symbiote Bond") — _venomHealAllCards counts
      // every card on board (your allies + opp's). Classic path heals
      // ally count × _venomHealMul.
      let amount;
      if (self._venomHealAllCards) {
        amount = G.getAllCardsOnBoard().length;
      } else {
        const ct = G.getAlliesOf(self.owner).length;
        const mul = self._venomHealMul || 1;
        amount = ct * mul;
      }
      if (amount > 0) {
        G.healPlayer(self.owner, amount, self);
        G.log(`Venom heals you for ${amount}!`);
        self.venomHealed = true;
      }
    }
  },
  "Wolverine": {
    onDamaged(G, self, attacker) {
      // Roguelite Text+ ("Adamantium") can raise the kill ceiling via
      // self._wolverineKillThreshold; classic mode falls back to 7.
      const threshold = (self && self._wolverineKillThreshold) || 7;
      if (attacker && (attacker.baseCost || attacker.cost) <= threshold) { G.killCard(attacker, self); G.log(`Wolverine slays ${attacker.name}!`); }
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
      // Roguelite Text+ — _wwStunSize scales the stun duration. Default
      // 1 (classic); Text+ sets 2.
      const stunN = self._wwStunSize || 1;
      const e = G.state.lanes[lane] ? G.state.lanes[lane][G.opponent(self.owner)] : null;
      if (e) { G.stunCard(e, self, stunN); }
      // _wonderWomanBlockGain scales the block meter add. Default 2
      // (classic); Text+ bumps to 4.
      const blockGain = self._wonderWomanBlockGain || 2;
      G.state[self.owner].blockMeter = Math.min(Game.BLOCK_MAX, G.state[self.owner].blockMeter + blockGain);
      G.log(`Wonder Woman Stuns ${e ? e.name : 'nothing'} (${stunN}) and adds ${blockGain} Block Meter!`);
    },
    onBeforeAttack(G, self) {
      const chainDmg = self.attack - 1;
      if (chainDmg <= 0) return;
      const myLane = G.findCardLane(self);
      if (myLane < 0) return;
      // Chain only fires when Wonder Woman's main swing lands on an
      // enemy CARD — card-to-card only.
      const opp = G.opponent(self.owner);
      const target = G.state.lanes[myLane][opp];
      if (!target || target.currentHealth <= 0) return;
      // Roguelite Text+ ("Lasso of Truth") — _wwChainAllAdj fires the
      // chain at BOTH adjacent enemies simultaneously (no direction
      // prompt). Classic path keeps the single-direction chain so the
      // human picks left or right.
      if (self._wwChainAllAdj) {
        const both = [];
        for (const dir of [-1, 1]) {
          const adjLane = myLane + dir;
          if (adjLane < 0 || adjLane >= Game.LANE_COUNT) continue;
          const t = G.state.lanes[adjLane] && G.state.lanes[adjLane][opp];
          if (t && t.currentHealth > 0) both.push(t);
        }
        if (both.length === 0) return;
        G.log(`Wonder Woman's lasso fans out — ${chainDmg} damage to ${both.length} adjacent enemies!`);
        both.forEach(t => G.dealDamage(t, chainDmg, self));
        return;
      }
      G.log(`Wonder Woman's lasso chains — ${chainDmg} chain damage!`);
      G.autoChainDamage(self.owner, myLane, chainDmg, 0, null, "LASSO CHAIN");
    }
  },

  // ==================== COST 5 ====================
  "Davy Jones": {
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _aquamanCreatureAtkBump and
      // _aquamanCreatureHpBump scale the summoned Kraken above its
      // 5/3 base. Default 0/0 (classic 5/3); Text+ sets +4/+6 (9/9)
      // so the summon is a real threat. (Roguelite property names
      // kept as `_aquaman*` for save-data compatibility — the card
      // is functionally the same, just rebranded to Davy Jones.)
      const atkBump = self._aquamanCreatureAtkBump || 0;
      const hpBump  = self._aquamanCreatureHpBump  || 0;
      G.summonCardChoice(self.owner, "The Kraken", 4, 5 + atkBump, 3 + hpBump, []);
    }
  },
  "Captain America": {
    onPlay(G, self, lane) {
      // Cost reduction is now LIVE — no card.cost mutation here.
      // Game.getCardCost subtracts the discount per active CA at
      // query time, so the moment Cap dies the discount vanishes
      // automatically. This onPlay only handles the Invincible
      // grant on an ally. User-facing log message is fired here
      // (one-time at play) so the player still gets the "Cap
      // rallied the team" feedback at the play moment.
      const disc = G.rarityValue(self, { common: 1, rare: 1, special: 2, legendary: 2 });
      const count = G.state[self.owner].hand.filter(c => c.cost > 0).length;
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
      // infected AND restore their pre-Crazy ATK (which Game.applyCrazyToCard
      // snapshotted onto `_preCrazyAttack` when the trait was applied).
      //
      // User bug report 2026-05-19: "Joker died, but Dormammu's stats
      // stayed at whatever debuff he rolled for the crazy. That's not
      // how it works. He should now get his stats back to what they
      // were previously because he no longer has the crazy status
      // trait." Previously this hook only stripped the flag and left
      // the rolled value pinned — fixed by restoring the snapshot.
      // Falls back to baseAttack if for some reason the snapshot is
      // missing (e.g. a card that got Crazy'd before the snapshot
      // logic shipped). Restoration also clears the per-roll memory
      // so a future re-Crazy (different Joker enters play later)
      // starts fresh.
      G.getAllCardsOnBoard().forEach(c => {
        if (c._crazyAppliedBy) {
          c.isCrazy = false;
          delete c._crazyAppliedBy;
          const restoreTo = (c._preCrazyAttack != null) ? c._preCrazyAttack : (c.baseAttack || c.attack);
          if (typeof restoreTo === 'number' && restoreTo !== c.attack) {
            const wasAtk = c.attack;
            c.attack = restoreTo;
            G.log(`  [CRAZY] ${c.name} is no longer Crazy — ATK restored ${wasAtk} → ${restoreTo}.`);
          } else {
            G.log(`  [CRAZY] ${c.name} is no longer Crazy — Joker is gone.`);
          }
          delete c._preCrazyAttack;
          delete c._lastCrazyRoll;
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
    onDiscard(G, owner, self) {
      const opp = G.opponent(owner);
      // Roguelite Text+ override — _profXConvertCost raises the cost
      // ceiling for convertible enemies. Default 4 (classic); Text+
      // to 6 so even Iron Man / Captain America are valid targets.
      const maxCost = (self && self._profXConvertCost) || 4;
      const enemies = G.getEnemiesOf(owner).filter(e => (e.baseCost != null ? e.baseCost : e.cost) <= maxCost);
      if (!enemies.length) return;
      G.promptCardChoice(owner, enemies, "Professor X — Convert", `Choose enemy with base cost ${maxCost} or less to permanently join your team`, (t) => {
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
          // "Its abilities reactivate" — re-fire When Played first,
          // THEN sweep sibling reactions (onAnyCardPlayed) and the
          // cardPlayedBuff passive. Order matters: cards like Scarlet
          // Witch (copiesOpposite) start at 0/0 placeholder stats and
          // resolve real stats inside their own onPlay. If sibling
          // auras (Luke Skywalker -1/-1) fire FIRST, they kill her
          // at 0/0 before she can copy the enemy. User report: "I
          // [used] Professor X [on] a Scarlet Witch which was 0/1,
          // tried to place her in front of Dormammu, but they had
          // Luke Skywalker on the board. It should copy the stats
          // of Dormammu, not die."
          G._runHook(t, 'onPlay', G, t, l);
          G.getAllCardsOnBoard().forEach(c => {
            if (c.onAnyCardPlayed && c.id !== t.id) c.onAnyCardPlayed(G, c);
          });
          G.getAllCardsOf(owner).forEach(c => {
            if (c.passive === 'cardPlayedBuff' && c.id !== t.id) { const n = c._bpAuraSize || 1; G.buffCard(t, n, n); }
          });
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
      let dmg = (typeof actual === 'number' && actual > 0)
        ? actual
        : (attacker ? attacker.attack : 1);
      if (dmg <= 0) return;
      // Roguelite Text+ override — _redHulkRetaliateBonus adds extra
      // damage to the splash AND block-meter add. Default 0 (classic);
      // Text+ sets to 2 so a 3-damage hit triggers a 5-damage splash
      // and 5 block meter — the rage feedback loop scales harder.
      const bonus = self._redHulkRetaliateBonus || 0;
      dmg += bonus;
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
      // Roguelite Text+ — _spiderManFreezeSize raises the freeze
      // duration. Default 1 turn (classic); Text+ sets 2 turns.
      const freezeN = self._spiderManFreezeSize || 1;
      const enemies = G.getEnemiesOf(self.owner);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Spider-Man — Freeze", `Choose enemy to Freeze ${freezeN}`, (t) => {
          G.freezeCard(t, self, freezeN); G.log(`Spider-Man freezes ${t.name} for ${freezeN}!`);
        }, _aiThreatPicker);
      }
    },
    onEvade(G, self) {
      // Roguelite Text+ overrides — _spiderManEvadeBuff scales the
      // grow buff (default +1/+1, Text+ +2/+2); _spiderManRegainChance
      // raises the chance of getting another evade charge back
      // (default 0.5, Text+ 0.75).
      const buff = self._spiderManEvadeBuff || 1;
      const regain = (typeof self._spiderManRegainChance === 'number') ? self._spiderManRegainChance : 0.5;
      G.buffCard(self, buff, buff);
      G.log(`Spider-Man evades and grows! +${buff}/+${buff}`);
      if (Math.random() < regain) {
        self.evadeCharges += 1;
        G.log(`Spider-Man's spider-sense tingles! Extra evade charge!`);
      }
    }
  },
  "The Batman Who Laughs": {
    onPlay(G, self, lane) {
      // Every BWL play arms a fresh intercept. The previous once-per-
      // owner-per-game lock (bwlInterceptUsed) was removed per user
      // direction — running multiple BWLs in a deck is a legitimate
      // synergy and each copy should fire its hex independently. The
      // `bwlInterceptUsed` state field is left in place (still flipped
      // by _resolveBwlIntercept) so save data / multiplayer sync stays
      // schema-compatible, but it no longer gates new plays.
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
      // User spec: "if there's only two open spaces, I shouldn't have
      // to place the warriors. They should be placed for me." When
      // open-lane count is ≤ zombies-to-summon, every choice is
      // forced — the warriors are identical 3/1 tokens, no
      // meaningful strategic differentiation. Auto-place all in
      // order without prompting. If there are MORE open lanes than
      // zombies, the player still gets prompted for each one (since
      // they're choosing WHERE to place each warrior among multiple
      // candidates).
      const openLanes = G.getOpenLanes(self.owner);
      if (openLanes.length <= zombies) {
        // Auto-place: fill each open lane in order with one warrior.
        // If zombies > openLanes, only openLanes-many actually summon
        // (no choice, no overflow). The remainder is silently
        // dropped — same outcome as the prompt path returning
        // early when no lanes remain.
        for (let i = 0; i < openLanes.length && i < zombies; i++) {
          G.summonCard(self.owner, openLanes[i], "Undead Warrior", 1, 3, 1, []);
        }
        drawFromDead(pulls);
        return;
      }
      // More open lanes than warriors → meaningful placement
      // choices remain; use the prompt chain.
      let summonCount = 0;
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
        // Match the human-path dmg formula: ally.cost + Text+ bonus.
        const aiBonus = self._homelanderDmgBonus || 0;
        const dmg = (trade.ally.baseCost || trade.ally.cost) + aiBonus;
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
          // Roguelite Text+ override — _homelanderDmgBonus adds flat
          // damage on top of the sacrificed ally's cost. Default 0
          // (classic = ally cost); Text+ to 3 so a 2-cost sacrifice
          // does 5 damage / destroys ≤5 cost. Cheap allies become a
          // viable currency for big trades.
          const homeBonus = self._homelanderDmgBonus || 0;
          const dmg = (victim.baseCost || victim.cost) + homeBonus;
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
        }, { inlineTray: true });
    }
  },
  "Hulk": {
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _hulkSmashDamage scales the SMASH
      // sweep. Default 2 (classic, hits all enemies for 2); Text+
      // raises to 4 for a board-clearing alpha strike.
      const smashDmg = self._hulkSmashDamage || 2;
      self.splashRange = self.attack;
      const opp = G.opponent(self.owner);
      const hit = [];
      for (let i = 0; i < Game.LANE_COUNT; i++) {
        const e = G.state.lanes[i][opp];
        if (e && e.currentHealth > 0) {
          G.dealDamage(e, smashDmg, self);
          hit.push(e.name);
        }
      }
      if (hit.length) G.log(`Hulk SMASH! Deals ${smashDmg} damage to all enemies: ${hit.join(', ')}!`);
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
      // Roguelite Text+ override — _obiWanReflectMul scales the reflect
      // damage. Default 1 (classic 1:1); Text+ to 2 so a 5-damage hit
      // bounces back as 10. Big bodies that swing across lanes pay
      // double for the trade.
      const mul = self._obiWanReflectMul || 1;
      const reflectDmg = dmg * mul;
      G.log(`  [REFLECT] Obi-Wan deflects ${reflectDmg} damage back to ${attacker.name}!`);
      G.dealDamage(attacker, reflectDmg, self);
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
      // Roguelite Text+ override — _ultronReplicateStats bumps each
      // replica's stats. Default { atk: 5, hp: 3 } (classic); Text+
      // sets to { atk: 7, hp: 5 } so the replication line is closer
      // to a fresh Ultron each time.
      const repAtk = (self._ultronReplicateAtk != null) ? self._ultronReplicateAtk : 5;
      const repHp  = (self._ultronReplicateHp  != null) ? self._ultronReplicateHp  : 3;
      if (open.length >= 1) G.summonCard(self.owner, open[0], "Ultron", 6, repAtk, repHp, []);
      if (open.length >= 2) G.summonCard(self.owner, open[open.length - 1], "Ultron", 6, repAtk, repHp, []);
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
          // Roguelite Text+ override — _doomReviveDiscount scales the
          // cost cut on revive. Default 3 (classic); Text+ raises to 5
          // so even legendary revives drop to a reasonable curve cost.
          const reviveCut = self._doomReviveDiscount || 3;
          card.cost = Math.max(0, card.cost - reviveCut);
          G.addToHand(owner, card, self);
          G.log(`Dr. Doom revives ${card.name} to hand! Cost permanently reduced by ${reviveCut} → ${card.cost}.`);
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
      // Roguelite Text+ override — _gorrEnemyOnly limits the devour to
      // the OPPONENT'S hand (skips your own). Default false (classic
      // hits both); Text+ true makes the play purely punitive.
      const enemyOnly = !!self._gorrEnemyOnly;
      const sides = enemyOnly ? [G.opponent(self.owner)] : ['player', 'ai'];
      const killed = { player: null, ai: null };
      sides.forEach(p => {
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
        // Roguelite Text+ ("Adaptive Wheel") — _mahoragaReviveBuff
        // adds +N/+N on top of base stats at revive. Falls back to
        // explicit revAtk/revHp legacy flags, then to classic 7/9.
        let revAtk, revHp;
        if (self._mahoragaReviveBuff) {
          const buff = self._mahoragaReviveBuff;
          revAtk = (self.baseAttack || 7) + buff;
          revHp  = (self.baseHealth || 9) + buff;
        } else if (self._mahoragaReviveAtk != null || self._mahoragaReviveHp != null) {
          revAtk = (self._mahoragaReviveAtk != null) ? self._mahoragaReviveAtk : 7;
          revHp  = (self._mahoragaReviveHp  != null) ? self._mahoragaReviveHp  : 9;
        } else {
          revAtk = 7;
          revHp  = 9;
        }
        // Adapts: revives at the chosen stats with Immunity 1 AND Armor 1.
        // The armor stacks with the immunity so the first hit on the
        // revived body is fully blocked, the second is reduced by 1, and
        // subsequent hits go through.
        self.attack = revAtk;
        self.currentHealth = revHp;
        self.maxHealth = revHp;
        self.immunityCharges = 1;
        self.armorValue = Math.max(self.armorValue || 0, 1);
        G.placeInLane(self.owner, self, lane);
        G.log(`Mahoraga adapts! ${revAtk}/${revHp} Armor 1 + Immunity 1! (Revive ${self.reviveCharges} left)`);
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
      // Roguelite Text+ override — _omniManSweep scales the AOE damage.
      // Default 3 (classic); Text+ raises to 5 so the entry sweep clears
      // 5-HP bodies and softens up everything else.
      const sweep = self._omniManSweep || 3;
      G.getEnemiesOf(self.owner).forEach(e => G.dealDamage(e, sweep, self));
      G.log(`Omni-Man devastates all enemies for ${sweep}!`);
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
      // Roguelite Text+ ("Viltrumite Pride") — _omniManBlockOnKill
      // scales the per-kill block meter add. Default 1 (classic);
      // Text+ raises to 2.
      const gain = self._omniManBlockOnKill || 1;
      G.state[self.owner].blockMeter = Math.min(Game.BLOCK_MAX, G.state[self.owner].blockMeter + gain);
      G.log(`Omni-Man adds ${gain} Block Meter!`);
    }
  },
  "Silver Surfer": {
    onPlay(G, self, lane) {
      // Roguelite Text+ overrides — _surferDebuff scales the ATK strip
      // (default 3 / Text+ 4); _surferTargets sets how many enemies
      // get hit (default 1 / Text+ 2). The cost-bump passive uses
      // _surferCostBump (default 1 / Text+ 2) read in game.js's
      // enemyCostIncrease site.
      const debuff = self._surferDebuff || 3;
      const targets = self._surferTargets || 1;
      const debuffed = new Set();
      const pickNext = () => {
        if (debuffed.size >= targets) return;
        const remaining = G.getEnemiesOf(self.owner).filter(e => !debuffed.has(e.id) && e.currentHealth > 0);
        if (!remaining.length) return;
        G.promptCardChoice(self.owner, remaining, "Silver Surfer — Weaken",
          `Choose enemy to remove ${debuff} ATK from (${debuffed.size + 1}/${targets})`,
          (t) => {
            G.debuffCard(t, debuff, 0, false, self);
            G.log(`Silver Surfer weakens ${t.name} by ${debuff} ATK!`);
            debuffed.add(t.id);
            if (debuffed.size < targets) pickNext();
          }, _aiThreatPicker);
      };
      pickNext();
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
      // Pass `self` so startVaderChain can read the Text+ damage flag.
      moveStep(() => {
        fearStep(() => {
          absfx('throw');
          G.startVaderChain(self.owner, () => {
            G.cleanupDead();
            if (typeof UI !== 'undefined' && UI.render) UI.render();
          }, self);
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
      // Roguelite Text+ override — _lukeAuraSize scales the buff/debuff
      // magnitude. Default 1 (classic +1/+1 / -1/-1); Text+ raises to
      // 2 so a 2-ally board jumps +4/+4 in one play and 1-HP enemies
      // get cleared by the aura alone.
      const auraSize = self._lukeAuraSize || 1;
      G.getAlliesOf(self.owner).filter(a => a.id !== self.id).forEach(a => {
        G.buffCard(a, auraSize, auraSize);
        a._lukeBuff = true;
      });
      G.getEnemiesOf(self.owner).forEach(e => {
        G.debuffCard(e, auraSize, auraSize, true, self);
        e._lukeDebuff = true;
      });
      G.log(`Luke Skywalker inspires allies (+${auraSize}/+${auraSize}) and weakens enemies (-${auraSize}/-${auraSize})!`);
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
      // Apply aura to any new card that enters the board. Text+ scaling
      // shared with the onPlay call (same _lukeAuraSize flag).
      const auraSize = self._lukeAuraSize || 1;
      G.getAlliesOf(self.owner).filter(a => a.id !== self.id && !a._lukeBuff).forEach(a => {
        G.buffCard(a, auraSize, auraSize);
        a._lukeBuff = true;
      });
      G.getEnemiesOf(self.owner).filter(e => !e._lukeDebuff).forEach(e => {
        // allowKill=true mirrors the onPlay call — a freshly-played
        // 1/1 token should die to Luke's aura the moment it lands.
        G.debuffCard(e, auraSize, auraSize, true, self);
        e._lukeDebuff = true;
      });
    },
    onDeath(G, self, lane) {
      // Remove aura when Luke dies. Use the same _lukeAuraSize so a
      // Text+ Luke pulls back the right amount when he falls.
      const auraSize = self._lukeAuraSize || 1;
      G.getAllCardsOnBoard().forEach(c => {
        if (c._lukeBuff) {
          G.debuffCard(c, auraSize, auraSize);
          delete c._lukeBuff;
        }
        if (c._lukeDebuff) {
          G.buffCard(c, auraSize, auraSize);
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
      // Roguelite Text+ override — _thorThunderDamage scales the lane-
      // adjacent strike. Default 5 (classic); Text+ raises to 7 for a
      // crushing 3-lane finisher.
      const thunderDmg = self._thorThunderDamage || 5;
      const splashBurst = () => {
        [lane - 1, lane, lane + 1].forEach(li => {
          if (li >= 0 && li < Game.LANE_COUNT) {
            const e = G.state.lanes[li][opp];
            if (e && e.currentHealth > 0) {
              G.dealDamage(e, thunderDmg, self);
              G.log(`Thor's thunder strikes ${e.name} for ${thunderDmg}!`);
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
  "Revan": {
    // 2026-05-26 — Revan rebuilt at cost 7 (6/8) per user spec:
    // "Give another ally card Revive 1." The previous Revan
    // (cost 8, 6/5 Evade/Immunity/Splash empower) is now Yoda
    // (entry below). Revan now reads as a defensive enabler —
    // sacrifices nothing immediately but lets a chosen ally
    // come back swinging once if it dies.
    onPlay(G, self, lane) {
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id && a.currentHealth > 0);
      const grant = (a) => {
        // Stack with any existing Revive charges. Cards born with
        // Revive (Jason, Mahoraga, Wolverine) already have
        // reviveCharges set in applyAbilities; we add 1 more.
        a.reviveCharges = (a.reviveCharges || 0) + 1;
        a.canRevive = true;
        G.log(`Revan grants ${a.name} Revive 1! (${a.reviveCharges} charge${a.reviveCharges === 1 ? '' : 's'})`);
      };
      if (!allies.length) {
        G.log("Revan finds no other allies to empower.");
        return;
      }
      G.promptCardChoice(self.owner, allies, "Revan — Grant Revive",
        "Choose an ally to give Revive 1", grant);
    }
  },
  "Yoda": {
    // 2026-05-26 — restored as a fresh cost-8 hero. Same buff/cleanse
    // pattern the old Yoda (pre-rename) had, with Immunity bolted on
    // for trait depth. Lone-wolf fallback +2/+3 + a board-wide
    // debuff sweep — the cleanse turns him into an "elder Jedi"
    // counter to Frozen / Stunned / Fear / Mind-Control lockouts.
    onPlay(G, self, lane) {
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id && a.currentHealth > 0);
      if (allies.length) {
        G.promptCardChoice(self.owner, allies, "Yoda — Empower",
          "Choose an ally to buff (+4/+4)", (a) => {
            G.buffCard(a, 4, 4);
            G.log(`Yoda empowers ${a.name} +4/+4!`);
          });
      } else {
        G.buffCard(self, 2, 3);
        G.log("Yoda empowers himself +2/+3!");
      }
      // Cleanse always fires — remove all debuffs from every ally.
      G.getAlliesOf(self.owner).forEach(a => {
        let cleared = 0;
        if (a.isStunned)        { a.isStunned = false; a.stunnedTurns = 0; cleared++; }
        if (a.isFrozen)         { a.isFrozen  = false; a.frozenTurns  = 0; cleared++; }
        if (a.isFeared)         { a.isFeared  = false; a.fearedTurns  = 0; cleared++; }
        if (a.isMindControlled) { a.isMindControlled = false; cleared++; }
        if (a.isBurning)        { a.isBurning = false; cleared++; }
        if (cleared > 0) G.log(`  [CLEANSE] ${a.name} is freed from ${cleared} debuff${cleared === 1 ? '' : 's'}.`);
      });
    }
  },
  "Darth Maul": {
    // 2026-05-26 — onPlay draws a Trick at -1 cost; passive grants
    // +2/+0 each time a Trick is played by EITHER player. The
    // per-trick buff fires via the global onAnyTrickPlayed hook
    // (game.js dispatches it from playTrick) — Maul's
    // `_maulSawTricks` flag could track triggers for cooldown but
    // we just buff straight on each event.
    onPlay(G, self, lane) {
      // Draw a trick — find the next trick in the deck or pool.
      // drawTrickCards isn't exposed publicly the same way as
      // drawCards; fall through to direct trick-hand population
      // by drawing from trickDrawPile.
      const tdraw = G.state.trickDrawPile || [];
      if (!tdraw.length) {
        G.log(`Darth Maul finds no Tricks to draw.`);
        return;
      }
      const trick = tdraw.shift();
      // -1 cost discount on the drawn trick (floors at 0).
      trick.cost = Math.max(0, (trick.cost || 0) - 1);
      G.addToTrickHand(self.owner, trick);
      G.log(`Darth Maul draws ${trick.name} (cost ${trick.cost} after -1 discount).`);
    },
    onAnyTrickPlayed(G, self, owner, trick) {
      if (self.currentHealth <= 0) return;
      if (owner !== self.owner) return;
      G.buffCard(self, 2, 0);
      G.log(`Darth Maul fuels his rage with ${trick.name} — +2/+0! (now ${self.attack}/${self.currentHealth})`);
    }
  },
  "General Grievous": {
    // 2026-05-26 — passive: while Grievous is alive on the AI's
    // (or player's) board, the OPPOSING player cannot charge their
    // Block Meter from face damage. The damagePlayer path reads
    // state._grievousActiveFor[opp] to decide whether to fill the
    // block. State flag is set on play and cleared on death.
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      if (!G.state._grievousActiveFor) G.state._grievousActiveFor = {};
      G.state._grievousActiveFor[opp] = (G.state._grievousActiveFor[opp] || 0) + 1;
      G.log(`General Grievous strangles ${opp === 'ai' ? "the AI's" : "your"} Block Meter — no more block charges while he stands!`);
    },
    onDeath(G, self) {
      const opp = G.opponent(self.owner);
      if (G.state._grievousActiveFor && G.state._grievousActiveFor[opp] > 0) {
        G.state._grievousActiveFor[opp]--;
        if (G.state._grievousActiveFor[opp] === 0) {
          G.log(`Grievous falls — ${opp === 'ai' ? "AI's" : "your"} Block Meter recharges normally.`);
        }
      }
    }
  },

  // ==================== COST 9 ====================
  "Batman": {
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      // Lock the opponent's highest-cost hand card for their NEXT round.
      // Store the start round (always round + 1) and the inclusive end
      // round (round + lockTurns). Classic Text+ defaults to 1 turn so
      // start === end; "Dark Knight" Text+ sets lockTurns = 2 for a
      // two-round lock.
      const lockTurns = self._batmanLockTurns || 1;
      const start = (G.state.round || 0) + 1;
      const until = (G.state.round || 0) + lockTurns;
      G.state[opp].batmanBlocked = start;
      G.state[opp].batmanBlockedUntil = Math.max(G.state[opp].batmanBlockedUntil || 0, until);
      G.log(`Batman locks down the opponent's highest cost card for ${lockTurns} turn${lockTurns === 1 ? '' : 's'}!`);
      const enemies = G.getEnemiesOf(self.owner);
      if (!enemies.length) return;
      // Roguelite Text+ override — _batmanStrikeDamage scales each of
      // the two batarang strikes. Default 2 (classic); Text+ raises to
      // 3 so a feared enemy + 3 + 3 = 6 damage / play. The lockout +
      // fear sequence stays unchanged.
      const strikeDmg = self._batmanStrikeDamage || 2;
      const pickThreat = cards => cards.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0];
      const pickDamage = cards => {
        // Kill-threshold tracks the per-strike ceiling so the AI prefers
        // a one-shot trade when one is available.
        const killable = cards.filter(c => c.currentHealth <= strikeDmg);
        const pool = killable.length ? killable : cards;
        return pool.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0];
      };

      // Step 3: second strike — any live enemy.
      const strike2 = () => {
        const pool = G.getEnemiesOf(self.owner).filter(e => e.currentHealth > 0);
        if (!pool.length) return;
        G.promptCardChoice(self.owner, pool, "Batman — Strike 2", `Deal ${strikeDmg} damage to any enemy`, (t) => {
          G.dealDamage(t, strikeDmg, self);
          G.log(`Batman strike 2: deals ${strikeDmg} to ${t.name}!`);
        }, pickDamage);
      };
      // Step 2: first strike — any live enemy (may be the feared one).
      const strike1 = () => {
        const pool = G.getEnemiesOf(self.owner).filter(e => e.currentHealth > 0);
        if (!pool.length) return;
        G.promptCardChoice(self.owner, pool, "Batman — Strike 1", `Deal ${strikeDmg} damage to any enemy`, (t) => {
          G.dealDamage(t, strikeDmg, self);
          G.log(`Batman strike 1: deals ${strikeDmg} to ${t.name}!`);
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
      // Roguelite Text+ ("Apokoliptan Legion") — _darkseidAnyContested
      // drops the odd/even gate and accepts any contested lane.
      const anyContested = !!self._darkseidAnyContested;
      const pickLanes = (isOdd) => {
        const eligible = [];
        for (let i = 0; i < Game.LANE_COUNT; i++) {
          if (i === lane) continue;
          const laneIsOdd = (i + 1) % 2 === 1;
          const passesParity = anyContested ? true : (laneIsOdd === isOdd);
          if (passesParity && G.state.lanes[i][self.owner] && G.state.lanes[i][opp]) {
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
      // summon resolves.
      const startPurge = () => {
        // Text+ ("Apokoliptan Legion") skips the odd/even prompt entirely
        // and lets the player pick from ALL contested lanes at once.
        if (anyContested) {
          pickLanes(true /* unused — anyContested overrides */);
          return;
        }
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

      // Step 1: Summon Parademon(s). Roguelite Text+ ("Apokoliptan
      // Legion") spawns 2 of them at (4/4); classic spawns 1 at (2/1).
      // Each summon chains into the next via onComplete; the final one
      // chains into startPurge.
      const parademonCount = self._darkseidParademonCount || 1;
      const parademonAtk = self._darkseidParademonAtk || 2;
      const parademonHp  = self._darkseidParademonHp  || 1;
      const summonChain = (remaining) => {
        if (remaining <= 0) { startPurge(); return; }
        const next = () => summonChain(remaining - 1);
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
            G.summonCardChoice(self.owner, "Parademon", 1, parademonAtk, parademonHp, [], [bestLane], next);
          } else {
            next();
          }
        } else {
          G.summonCardChoice(self.owner, "Parademon", 1, parademonAtk, parademonHp, [], null, next);
        }
      };
      summonChain(parademonCount);
    },
    onBeforeAttack(G, self) {
      if (self.isFeared || self.isMindControlled) return;
      const enemies = G.getEnemiesOf(self.owner).filter(e => e.currentHealth > 0);
      self._skipNormalAttack = true;
      if (enemies.length === 0) return;
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
      // Roguelite Text+ override — _supermanBlast scales the heat-vision
      // damage. Default 5 (classic); Text+ raises to 8 so a Doom or
      // Hulk eats one nuke instead of needing chip first.
      const blastDmg = self._supermanBlast || 5;
      // _supermanFreezeSize raises the freeze duration on each Freeze
      // pick. Default 1 (classic); Text+ sets 2.
      const freezeN = self._supermanFreezeSize || 1;
      const doBlast = () => {
        const enemies = G.getEnemiesOf(self.owner);
        if (enemies.length) {
          G.promptCardChoice(self.owner, enemies, "Superman — Blast", `Choose enemy to deal ${blastDmg} damage`, (t) => {
            G.dealDamage(t, blastDmg); G.log(`Superman blasts ${t.name} for ${blastDmg}!`);
          }, cards => {
            const killable = cards.filter(c => c.currentHealth <= blastDmg);
            const pool = killable.length ? killable : cards;
            return pool.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0];
          });
        }
      };
      const unfrozen1 = G.getEnemiesOf(self.owner).filter(e => !e.isFrozen);
      if (!unfrozen1.length) { doBlast(); return; }
      G.promptCardChoice(self.owner, unfrozen1, `Superman — Freeze (1 of 2)`, `Choose the first enemy to Freeze ${freezeN}`, (t1) => {
        G.freezeCardUnresistible(t1, self, freezeN);
        G.log(`Superman freezes ${t1.name} for ${freezeN}!`);
        const unfrozen2 = G.getEnemiesOf(self.owner).filter(e => !e.isFrozen);
        if (!unfrozen2.length) { doBlast(); return; }
        G.promptCardChoice(self.owner, unfrozen2, `Superman — Freeze (2 of 2)`, `Choose the second enemy to Freeze ${freezeN}`, (t2) => {
          G.freezeCardUnresistible(t2, self, freezeN);
          G.log(`Superman freezes ${t2.name} for ${freezeN}!`);
          doBlast();
        }, cards => cards.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0]);
      }, cards => cards.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0]);
    }
  },
  "Thanos": {
    trickPhasePlayable: true,
    onPlay(G, self, lane) {
      // Lanes destroyed scales with tier: 2 / 3 / 4 / 5.
      // Roguelite Text+ ("Reality Snap") — _thanosLanes pins the count
      // at a fixed value (4) regardless of rarity.
      const numRolls = self._thanosLanes
        ? self._thanosLanes
        : G.rarityValue(self, { common: 2, rare: 3, special: 4, legendary: 5 });
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
      if (self.isStunned || self.isFrozen) {
        G.log(`  [SKIP] ${self.name} is ${self.isStunned ? 'STUNNED' : 'FROZEN'} — stays put.`);
        return;
      }
      // Roguelite Text+ ("Twin Strike") — _anakinDoubleMove lets Anakin
      // move TWICE per turn, queueing a bonus attack each time. Classic
      // is single-move.
      const moveCount = self._anakinDoubleMove ? 2 : 1;
      const opp = G.opponent(self.owner);
      const eligibleNow = () => {
        const out = [];
        const cur = G.findCardLane(self);
        for (let i = 0; i < Game.LANE_COUNT; i++) {
          if (i === cur) continue;
          if (G.state.lanes[i].destroyed) continue;
          if (!G.state.lanes[i][self.owner]) out.push(i);
        }
        return out;
      };
      const doMove = (toLane) => {
        const cur = G.findCardLane(self);
        G.moveCard(self, cur, toLane);
        self.bonusAttack = (typeof self.bonusAttack === 'number' ? self.bonusAttack : 0) + 1;
        const targetNote = G.state.lanes[toLane][opp] ? ` — locked on ${G.state.lanes[toLane][opp].name}` : '';
        G.log(`Anakin moves to lane ${toLane + 1} and strikes${targetNote}!`);
        G.drainBonusAttacks(self);
      };
      const moveChain = (remaining) => {
        if (remaining <= 0) { self.anakinMoved = true; return; }
        const eligible = eligibleNow();
        if (!eligible.length) { self.anakinMoved = true; return; }
        if (Game.isHuman(self.owner)) {
          const laneChoices = eligible.map(i => {
            const e = G.state.lanes[i][opp];
            const desc = e && e.currentHealth > 0
              ? `Move here — bonus attack on ${e.name} (${e.attack}/${e.currentHealth})`
              : `Move here — bonus attack on enemy HP`;
            return { name: `Lane ${i + 1}`, desc, _lane: i };
          });
          G.promptCardChoice(self.owner, laneChoices, `Anakin — Move & Bonus Attack (${moveCount - remaining + 1}/${moveCount})`,
            "Choose an open lane to move to",
            (choice) => { doMove(choice._lane); moveChain(remaining - 1); },
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
          moveChain(remaining - 1);
        }
      };
      moveChain(moveCount);
    },
    onAllyKilled(G, self) {
      if (self.isStunned || self.isFrozen) return;
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
      // Roguelite Text+ override — _dormammuDrainMax raises the drain
      // ceiling. Default 3 (classic); Text+ to 5 so the full board
      // can be drained when Dormammu lands on a packed lane.
      const drainCap = self._dormammuDrainMax || 3;
      const drainCount = Math.min(drainCap, enemies.length);
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
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _manhattanHeal scales the heal-on-play.
      // Default 5 (classic); Text+ raises to 10 so a single play double-
      // dips on the run-HP economy.
      const heal = self._manhattanHeal || 5;
      G.healPlayer(self.owner, heal, self);
      G.log(`Dr. Manhattan heals ${heal}!`);
    },
    passive: "extraCurrency2"
  },
  "Galactus": {
    onBeforeTricks(G, self, lane) {
      if (self.galactusDevoured) return;   // fires exactly once per instance
      // Pass {source: self} so getEnemiesOf strips 10-cost enemies
      // from the devour menu — Galactus can't pick Dr. Manhattan
      // (or another Galactus, Knull, Trigon, Anakin). User
      // direction 2026-05-19: "you can't target tens with other
      // tens abilities. So even if Galactus' devour doesn't work
      // on Manhattan, you shouldn't even have the option to target
      // Manhattan." Engine-level is10CostImmune still backs this
      // up if a trick or future code path slips through.
      const enemies = G.getEnemiesOf(self.owner, { source: self });
      if (!enemies.length) return;
      self.galactusDevoured = true;
      // Devour count scales: 1 / 2 (listed) / 3 / 4. Roguelite Text+
      // ("World Eater") — _galactusDevourCount pins it at 3 regardless
      // of rarity.
      const baseDevour = self._galactusDevourCount
        ? self._galactusDevourCount
        : G.rarityValue(self, { common: 1, rare: 2, special: 3, legendary: 4 });
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
      // Roguelite Text+ override — _knullCostFloor raises the minimum
      // cost of the random pull pool. Default 1 (classic); Text+ sets
      // to 4 so the lottery skips the cheap chaff and only pulls
      // mid-or-higher cost cards (Wonder Woman, Carnage, Doom, etc.).
      const minCost = self._knullCostFloor || 1;
      // _knullCostCeiling raises the upper bound from 9 to 10 with Text+
      // ("God of Symbiotes") so the lottery can roll 10-cost titans.
      const maxCost = self._knullCostCeiling || 9;
      G.getOpenLanes(self.owner).filter(l => l !== lane).forEach(l => {
        // Pull from the shared summon deck so Knull's lottery spreads
        // across the full 95-card pool. Filter: cost minCost-maxCost,
        // attack > 0, not a discard-effect card.
        const d = G.drawFromSummonDeck(c => !c.isDiscardEffect && c.cost >= minCost && c.cost <= maxCost && (c.attack || 0) > 0);
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
      // Passive: each kill triggers one bonus random kill. Re-entry guard
      // prevents the bonus kill from spawning another bonus kill.
      if (self._trigonChaining) return;
      const targets = G.getEnemiesOf(self.owner).filter(
        e => e.currentHealth > 0 && (e.baseCost || e.cost) < 10
      );
      if (!targets.length) return;
      const t = targets[Math.floor(Math.random() * targets.length)];
      self._trigonChaining = true;
      G.killCard(t, self);
      self._trigonChaining = false;
      G.log(`Trigon destroys ${t.name}!`);
    }
  },
  "Boiler Room": {
    _markBurning(card, boilerRoom) {
      if (!card || card.isBurning || card.isEnvironment) return;
      card.isBurning = true;
      if (boilerRoom) {
        const orig = card.onDeath || null;
        card.onDeath = function(G, self, laneIdx) {
          if (orig) orig.call(this, G, self, laneIdx);
          const AB = CARD_ABILITIES['Boiler Room'];
          if (AB && !boilerRoom._brSpawned) {
            const brLane = G.findCardLane(boilerRoom);
            if (brLane >= 0) {
              boilerRoom._brSpawned = true;
              AB._spawnFreddy(G, boilerRoom.owner, brLane);
            }
          }
        };
      }
    },
    _spawnFreddy(G, owner, laneIdx) {
      const lane = G.state.lanes[laneIdx];
      // Clear the environment sub-slot
      if (lane._env) lane._env[owner] = null;

      const fredDef = (typeof CARD_DEFS !== 'undefined')
        ? CARD_DEFS.find(d => d.name === 'Freddy Krueger') : null;
      const allyInLane = lane[owner];

      const finishSpawn = (atk, hp) => {
        G.summonCard(owner, laneIdx, 'Freddy Krueger', 2, atk, hp, [], fredDef);
        const freddy = G.state.lanes[laneIdx][owner];
        if (freddy) {
          freddy._envLane = laneIdx;
          // summonCard ignores atk/hp when sourceDef is provided; set directly
          freddy.attack = atk;
          freddy.currentHealth = hp;
          freddy.maxHealth = hp;
        }
        G.log(`Freddy Krueger rises from the Boiler Room in lane ${laneIdx + 1}!`);
        if (typeof UI !== 'undefined' && UI._freddyJumpscare) {
          setTimeout(() => UI._freddyJumpscare(laneIdx, owner), 60);
        }
      };

      if (allyInLane && allyInLane.currentHealth > 0) {
        const openLanes = G.getOpenLanes(owner).filter(l => l !== laneIdx);
        if (openLanes.length > 0) {
          G.promptLaneChoice(owner, openLanes,
            `Freddy Krueger — Move ${allyInLane.name}`,
            `Freddy needs this lane. Move ${allyInLane.name} to another lane.`,
            (targetLane) => {
              lane[owner] = null;
              G.state.lanes[targetLane][owner] = allyInLane;
              G.log(`  [DISPLACED] ${allyInLane.name} moved to lane ${targetLane + 1} to make room for Freddy.`);
              G.checkLaneTrap(allyInLane, targetLane);
              if (allyInLane.onMoved) allyInLane.onMoved(G, allyInLane, targetLane);
              finishSpawn(1, 4);
            }
          );
        } else {
          const extraAtk = allyInLane.attack;
          const extraHp  = allyInLane.currentHealth;
          G.log(`  [ABSORB] Freddy Krueger absorbs ${allyInLane.name} (+${extraAtk}/+${extraHp})!`);
          G.handleDeath(allyInLane, laneIdx, null);
          finishSpawn(1 + extraAtk, 4 + extraHp);
        }
      } else {
        finishSpawn(1, 4);
      }
    },
    onPlay(G, self, lane) {
      const AB = CARD_ABILITIES['Boiler Room'];
      const opp = G.opponent(self.owner);
      const enemy = G.state.lanes[lane][opp];
      if (enemy && enemy.currentHealth > 0) AB._markBurning(enemy, self);
      self._adjBurnPending = true;
      G.log('Boiler Room ignites — the enemy in this lane is burning!');
    },
    onAnyCardPlayed(G, self) {
      if (self._brSpawned) return;
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;
      const AB = CARD_ABILITIES['Boiler Room'];
      const opp = G.opponent(self.owner);
      const enemy = G.state.lanes[laneIdx][opp];
      if (enemy && enemy.currentHealth > 0) AB._markBurning(enemy, self);
    },
    onTurnStart(G, self) {
      if (self._brSpawned) return;
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;
      const AB = CARD_ABILITIES['Boiler Room'];
      const opp = G.opponent(self.owner);

      // Spread burn mark to adjacent lanes after the first round.
      if (self._adjBurnPending) {
        self._adjBurnPending = false;
        [laneIdx - 1, laneIdx + 1].forEach(adj => {
          if (adj >= 0 && adj < G.LANE_COUNT) {
            const c = G.state.lanes[adj][opp];
            if (c && c.currentHealth > 0) {
              AB._markBurning(c, self);
              G.log(`[BURN] Boiler Room spreads — ${c.name} in lane ${adj + 1} is now burning!`);
            }
          }
        });
      }

      // Deal 1 damage to every burning enemy in and around this lane.
      // Freddy spawns via onDeath chain set in _markBurning — no kill
      // tracking needed here.
      const burnLanes = [laneIdx - 1, laneIdx, laneIdx + 1].filter(l => l >= 0 && l < G.LANE_COUNT);
      burnLanes.forEach(l => {
        const c = G.state.lanes[l][opp];
        if (c && c.isBurning && c.currentHealth > 0) {
          G.dealDamage(c, 1, null);
          G.log(`[BURN] ${c.name} takes 1 burn damage!`);
        }
      });
    },
  },
  "Freddy Krueger": {
    onAnyCardPlayed(G, self) {
      const AB = CARD_ABILITIES['Boiler Room'];
      if (AB) G.getEnemiesOf(self.owner).forEach(e => AB._markBurning(e));
    },
    onBeforeAttack(G, self) {
      const opp = G.opponent(self.owner);
      const hand = (G.state[opp] && G.state[opp].hand) || [];
      const targets = hand.filter(c => (c.currentHealth !== undefined ? c.currentHealth : (c.health || 0)) > 0);
      if (!targets.length) return;
      const t = targets[Math.floor(Math.random() * targets.length)];
      const dmg = self.attack || 1;
      const curHp = t.currentHealth !== undefined ? t.currentHealth : (t.health || 0);
      t.currentHealth = Math.max(0, curHp - dmg);
      G.log(`[FREDDY] Freddy slashes ${t.name} in the enemy's hand for ${dmg}!`);
      // Flag the card so the render system applies freddy-hand-slash during
      // the next paint. Direct DOM class manipulation was lost immediately
      // because UI.render() rebuilds the element when currentHealth changes.
      t._freddySlashing = true;
      setTimeout(() => { t._freddySlashing = false; }, 900);
      const handIdx = hand.indexOf(t);
      const destroyed = t.currentHealth <= 0;
      if (destroyed) {
        if (handIdx >= 0) hand.splice(handIdx, 1);
        G.log(`[FREDDY] ${t.name} was destroyed before it could be played!`);
      }
      if (typeof UI !== 'undefined' && UI._freddyHandSlash) {
        setTimeout(() => UI._freddyHandSlash(t.name, dmg, t.id, handIdx, opp, destroyed), 60);
      }
      self._skipNormalAttack = true;
    },
    onDeath(G, self, laneIdx) {
      // Clear the Boiler Room that spawned this Freddy
      const l = (self._envLane !== undefined) ? self._envLane : laneIdx;
      const lane = G.state.lanes[l];
      if (lane && lane._env) lane._env[self.owner] = null;
    },
  },
  "Freddy Fazbear": {
    onTurnStart(G, self) {
      if (!self._triggerNextRound) return;
      self._triggerNextRound = false;
      const opp = G.opponent(self.owner);
      // Drain 1 energy from opponent
      if (G.state[opp].currency > 0) {
        const before = G.state[opp].currency;
        G.state[opp].currency = Math.max(0, before - 1);
        G.log(`[FREDDY FAZBEAR] Drains 1 Energy from ${opp}! (${before} → ${G.state[opp].currency} this round)`);
        G._creditChain(self, 'statsEnergyGenerated', 1);
      }
      // Gain 1 HP permanently (grows beyond starting max)
      self.maxHealth += 1;
      self.currentHealth += 1;
      G.log(`[FREDDY FAZBEAR] Gains +1 HP! (${self.currentHealth}/${self.maxHealth})`);
    },
  },
  "Padme Amidala": {
    onEndOfTurn(G, self) {
      G.getAlliesOf(self.owner).forEach(c => {
        if (c.currentHealth > 0) {
          c.currentHealth = Math.min(c.currentHealth + 1, c.maxHealth);
        }
      });
      G.log(`Padme Amidala heals all allies for 1 HP.`);
    }
  },
  "Sewers": {
    _spawnPennywise(G, owner, laneIdx) {
      const lane = G.state.lanes[laneIdx];
      // Clear the environment sub-slot
      if (lane._env) lane._env[owner] = null;

      const def = (typeof CARD_DEFS !== 'undefined')
        ? CARD_DEFS.find(d => d.name === 'Pennywise') : null;
      const allyInLane = lane[owner];

      const finishSpawn = (atk, hp) => {
        G.summonCard(owner, laneIdx, 'Pennywise', 4, atk, hp, [], def);
        const pennywise = G.state.lanes[laneIdx][owner];
        if (pennywise) {
          pennywise._envLane = laneIdx;
          // summonCard ignores atk/hp when sourceDef is provided; set directly
          pennywise.attack = atk;
          pennywise.currentHealth = hp;
          pennywise.maxHealth = hp;
        }
        G.log(`Pennywise rises from the Sewers in lane ${laneIdx + 1}!`);
        if (typeof UI !== 'undefined' && UI._pennywiseJumpscare) {
          setTimeout(() => UI._pennywiseJumpscare(laneIdx, owner), 60);
        }
      };

      if (allyInLane && allyInLane.currentHealth > 0) {
        const openLanes = G.getOpenLanes(owner).filter(l => l !== laneIdx);
        if (openLanes.length > 0) {
          G.promptLaneChoice(owner, openLanes,
            `Pennywise — Move ${allyInLane.name}`,
            `Pennywise needs this lane. Move ${allyInLane.name} to another lane.`,
            (targetLane) => {
              lane[owner] = null;
              G.state.lanes[targetLane][owner] = allyInLane;
              G.log(`  [DISPLACED] ${allyInLane.name} moved to lane ${targetLane + 1} to make room for Pennywise.`);
              G.checkLaneTrap(allyInLane, targetLane);
              if (allyInLane.onMoved) allyInLane.onMoved(G, allyInLane, targetLane);
              finishSpawn(3, 5);
            }
          );
        } else {
          const extraAtk = allyInLane.attack;
          const extraHp  = allyInLane.currentHealth;
          G.log(`  [ABSORB] Pennywise absorbs ${allyInLane.name} (+${extraAtk}/+${extraHp})!`);
          G.handleDeath(allyInLane, laneIdx, null);
          finishSpawn(3 + extraAtk, 5 + extraHp);
        }
      } else {
        finishSpawn(3, 5);
      }
    },
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      const existing = G.state.lanes[lane][opp];
      // Record current enemy so onAnyCardPlayed only fires on a NEW arrival
      self._sewersTrackedEnemy = (existing && existing.currentHealth > 0) ? existing.id : null;
    },
    onAnyCardPlayed(G, self) {
      if (self._sewersTriggered) return;
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;
      const opp = G.opponent(self.owner);
      const enemy = G.state.lanes[laneIdx][opp];
      const enemyId = (enemy && enemy.currentHealth > 0) ? enemy.id : null;
      if (enemyId && enemyId !== self._sewersTrackedEnemy) {
        self._sewersTriggered = true;
        CARD_ABILITIES['Sewers']._spawnPennywise(G, self.owner, laneIdx);
      } else if (!self._sewersTriggered) {
        self._sewersTrackedEnemy = enemyId;
      }
    },
  },
  "Pennywise": {
    onPlay(G, self) {
      self._bullseyeRoundsLeft = 3;
      G.log(`[PENNYWISE] Fear takes hold — enemy Block Meter bypassed for 3 rounds!`);
    },
    onEndOfTurn(G, self) {
      if (self._bullseyeRoundsLeft > 0) {
        self._bullseyeRoundsLeft--;
        if (self._bullseyeRoundsLeft > 0) {
          G.log(`[PENNYWISE] Bullseye aura: ${self._bullseyeRoundsLeft} round${self._bullseyeRoundsLeft === 1 ? '' : 's'} remaining.`);
        } else {
          G.log(`[PENNYWISE] Fear fades — enemy Block Meter restored.`);
        }
      }
    },
    onDeath(G, self, laneIdx) {
      // Clear the Sewers that spawned this Pennywise
      const l = (self._envLane !== undefined) ? self._envLane : laneIdx;
      const lane = G.state.lanes[l];
      if (lane && lane._env) lane._env[self.owner] = null;
    },
  },
};

// Merge abilities into CARD_DEFS (cards.js must load before this file)
CARD_DEFS.forEach(card => {
  const ab = CARD_ABILITIES[card.name];
  if (ab) Object.assign(card, ab);
});
