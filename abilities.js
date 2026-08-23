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
      const enemies = G.getEnemiesOf(self.owner).filter(t => G.canEffectLand(t, 'damage', { owner: self.owner, source: self }));
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
      if (typeof UI !== 'undefined' && UI._fxAntManPym) { try { UI._fxAntManPym(self); } catch (e) {} }
      const afterSummon = () => {
        // Roguelite Text+ override — _antManKillThreshold raises the
        // pick window. Default 1 (classic ≤1 ATK or ≤1 HP); Text+
        // bumps to 2 so 2/2 bodies are also valid targets.
        const t = self._antManKillThreshold || 1;
        const targets = G.getEnemiesOf(self.owner).filter(c => (c.attack <= t || c.currentHealth <= t) && G.canEffectLand(c, 'destroy', { owner: self.owner, source: self }));
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
        : allies[Math.floor(Game.rng() * allies.length)];
      self._ivyAlly = pick;
      self._ivyCharmedId = pick.id; // tracked so handleDeath can strip the buff
      // Stamp a direct flag on the charmed ally pointing back at Ivy.
      // The badge renderer reads this flag — much more reliable than
      // matching object identity across getAllCardsOnBoard calls. User
      // report: "the charm status badge isn't on any ally card for ivy
      // so I can't tell who she's gaining attack from."
      pick._charmedByIvy = self.id;
      // Pheromone bloom on the charmed ally + a vine drawing its strength to Ivy.
      if (typeof UI !== 'undefined' && UI._fxIvyCharm) { try { UI._fxIvyCharm(self, pick); } catch (e) {} }
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
        targets.forEach(t => {
          G.freezeCard(t, self);
          if (typeof UI !== 'undefined' && UI._fxWidowBite) { try { UI._fxWidowBite(self, t); } catch (e) {} }
        });
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
          if (typeof UI !== 'undefined' && UI._fxWidowBite) { try { UI._fxWidowBite(self, t); } catch (e) {} }
          frozen++;
          if (frozen < freezes) pickNext();
        }, undefined, { forced: remaining.length <= (freezes - frozen) });
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
    // Arrival sting — fires WHEREVER Man-Bat lands, by ANY move mechanism:
    // his own Start-of-Tricks flight, Magneto's magnetic throw, Gojo's
    // displacement, Bifrost, hunt chases... moveCard (and every direct-
    // assignment mover) fires onMoved post-relocation, so the sting always
    // tracks the LANDING lane. User report: "Magneto moved Man-Bat and his
    // passive didn't trigger" — the debuff used to live only inside his own
    // move callback. Bonus fix: the old AI branch applied the debuff even
    // when moveCard silently REFUSED the move (destination occupied) —
    // hooking the sting to the actual move kills that too.
    onMoved(G, self, to) {
      const enemy = G.state.lanes[to] && G.state.lanes[to][G.opponent(self.owner)];
      if (!enemy || enemy.currentHealth <= 0 || enemy.isEnvironment) return;
      // allowKill=true so a -1/-1 can finish a 1-HP enemy. Roguelite Text+
      // override — _manBatDebuffSize scales the sting (default 1).
      const debuffSize = self._manBatDebuffSize || 1;
      G.debuffCard(enemy, debuffSize, debuffSize, true, self);
      enemy._debuffStacks = (enemy._debuffStacks || 0) + 1;
      G.log(`[DEBUFF] Man-Bat weakens ${enemy.name} by -${debuffSize}/-${debuffSize}`);
      G.cleanupDead();
    },
    onBeforeTricks(G, self, lane) {
      // Stun / freeze gates the whole ability. The arrival debuff now lives
      // in onMoved (fired by moveCard), so this callback only handles the
      // flight itself — no explicit debuff here or it would double-sting.
      if (Game.isActionLocked(self)) {
        G.log(`  [SKIP] ${self.name} is ${self.isStunned ? 'STUNNED' : 'FROZEN'} — stays put.`);
        return;
      }
      const open = G.getOpenLanes(self.owner).filter(l => l !== lane);
      if (!open.length) return;
      // Include the current lane as a "stay" option. User direction:
      // "for moving like man bat and omni man have the choice not to
      // move." Player can click Man-Bat's own lane to stay put — no move,
      // no sting.
      if (Game.isHuman(self.owner)) {
        // STAY is a BUTTON, not a lane (see promptLaneChoice options.declineLabel).
        // The old affordance listed Man-Bat's own lane among the choices and
        // asked the player to click it — but that square is covered by the card
        // itself, so the click hit the card every time. Owner: "it's hard right
        // now to click their lane that they are in to stay."
        G.promptLaneChoice(self.owner, open, "Man-Bat — Move", "Choose a lane to move to", (to) => {
          G.moveCard(self, lane, to);
        }, null, null, 0, { declineLabel: 'STAY PUT', onDecline: () => G.log(`Man-Bat stays put in lane ${lane + 1}.`) });
      } else {
        const to = open[Math.floor(Game.rng() * open.length)];
        G.moveCard(self, lane, to);
      }
    }
  },
  "Killer Moth": {
    // Fires every Start of Tricks (not just the first) — same re-arm flag
    // Man-Bat / Omni-Man use so beforeTricksFired resets each round.
    _recurringBT: true,
    // GROWTH IS THE MOVE — ANY move, not just his own flutter. moveCard already
    // fires this hook for every mover in the game (Bifrost, Magneto, Gargantua's
    // pull, Gojo's displace, a hunt/chase), so hanging the buff here is what
    // makes his card text literally true. It used to be stamped inline right
    // after his own moveCard call, which meant he grew on the one move he makes
    // himself and rode every other one for free.
    // Fires on ENEMY-caused moves too, deliberately: shoving him around is the
    // thing he feeds on.
    // ...but only for GROUND HE HAS NOT COVERED. He starts 0/1 and keeps a
    // tally of every lane he has stood in (the "counter on the back of his
    // card"); reaching a NEW lane is worth +1/+1, and being shuttled back to
    // somewhere he has already been is worth nothing. Without the tally he was
    // a 1-cost infinite engine: bounce him 1→2→1→2 forever and he outgrows
    // anything in the game. Six lanes is therefore his hard ceiling — 5/6 if he
    // walks the whole board.
    // The lane he was PLAYED into counts as visited (seeded in onPlay), so the
    // very first flutter is his first buff, not his second.
    _mothVisited(self) {
      if (!Array.isArray(self._mothLanes)) self._mothLanes = [];
      return self._mothLanes;
    },
    onPlay(G, self, lane) {
      // Seed the tally with his landing lane — he has "been" there now.
      CARD_ABILITIES['Killer Moth']._mothVisited(self);
      if (self._mothLanes.indexOf(lane) === -1) self._mothLanes.push(lane);
    },
    // Permanent self-buff (self-buffs never expire — see CLAUDE.md).
    onMoved(G, self, to) {
      const seen = CARD_ABILITIES['Killer Moth']._mothVisited(self);
      if (seen.indexOf(to) > -1) {
        G.log(`[KILLER MOTH] Back over lane ${to + 1} — already flown, no growth.`);
        return;
      }
      seen.push(to);
      self.attack = (self.attack || 0) + 1;
      self.maxHealth = (self.maxHealth || 0) + 1;
      self.currentHealth = (self.currentHealth || 0) + 1;
      G.log(`[KILLER MOTH] New ground in lane ${to + 1} — grows to ${self.attack}/${self.currentHealth} (${seen.length}/${G.LANE_COUNT} lanes flown).`);
    },
    onBeforeTricks(G, self, lane) {
      // Stun / freeze grounds him — no flutter and no growth this round.
      if (Game.isActionLocked(self)) {
        G.log(`  [SKIP] ${self.name} is ${self.isStunned ? 'STUNNED' : 'FROZEN'} — stays put.`);
        return;
      }
      // "Open" here means EMPTY ON BOTH SIDES — Killer Moth relocates to
      // unoccupied ground, not into a lane an enemy already holds. User:
      // "killer moth moved into an occupied lane when he shouldn't." The old
      // filter used getOpenLanes(self.owner), which only checks the owner's
      // OWN side, so it let him flutter straight into an enemy-contested lane
      // (player slot empty, enemy slot full) and pick a fight at random. Now he
      // only lands where nothing stands on either side.
      const empty = [];
      for (let i = 0; i < G.LANE_COUNT; i++) {
        if (i === lane) continue;
        const L = G.state.lanes[i];
        if (L && !L.destroyed && !L.player && !L.ai) empty.push(i);
      }
      if (empty.length) {
        // Always random — no player prompt (unlike Man-Bat / Omni-Man, which
        // let the owner choose or stay). Killer Moth relocates on his own.
        const to = empty[Math.floor(Game.rng() * empty.length)];
        // The growth is NOT stamped here any more — moveCard fires onMoved and
        // that is where it lives now. Stamping it at this one call site meant
        // only HIS OWN flutter paid; being moved by anything else relocated him
        // for free. User: "i used bifrost on killer moth, bifrost moved killer
        // moth yet he didnt gain +1/+1."
        G.moveCard(self, lane, to);
      } else {
        // Boxed in. No move, so no growth — he simply sits this round out.
        G.log(`  [KILLER MOTH] No open lane — stays put.`);
      }
    }
  },
  "Harley Quinn": {
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _harleyDraw scales the draw amount.
      const n = self._harleyDraw || 1;
      // "BOTH PLAYERS DRAW" MEANS EVERY PLAYER. drawCards takes a SIDE, and in
      // 2v2 a side is a team of two whose proxy is bound to whichever seat is
      // acting — so this drew one card per TEAM and quietly skipped both
      // teammates. forEachSeatOnSide routes the draw to each real seat in turn,
      // and collapses to exactly the old behaviour in 1v1, where a side IS a
      // player.
      G.forEachSeatOnSide(self.owner, () => G.drawCards(self.owner, n));
      G.forEachSeatOnSide(G.opponent(self.owner), () => G.drawCards(G.opponent(self.owner), n));
      G.log(`Harley Quinn makes everyone draw ${n}!`);
      if (typeof UI !== 'undefined' && UI._fxHarleyChaos) { try { UI._fxHarleyChaos(self); } catch (e) {} }
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
      G.splashDamage(toLane, self.owner, dmg, self);
      G.log(`Jango Fett splashes lane ${toLane + 1} for ${dmg} on arrival!`);
    },
    onBeforeTricks(G, self, lane) {
      // Roguelite Text+ ("Jetpack Salvo") — _jangoMoveLikeManBat gives
      // Jango a Man-Bat-style relocation at Start of Tricks. The
      // existing onMoved handler picks up the arrival splash. Classic
      // Jango has no movement of his own — this hook is gated.
      if (!self._jangoMoveLikeManBat) return;
      if (Game.isActionLocked(self)) {
        G.log(`  [SKIP] ${self.name} is ${self.isStunned ? 'STUNNED' : 'FROZEN'} — stays put.`);
        return;
      }
      const open = G.getOpenLanes(self.owner).filter(l => l !== lane);
      if (!open.length) return;
      if (Game.isHuman(self.owner)) {
        // STAY is a BUTTON, not a lane (see promptLaneChoice options.declineLabel).
        // The old affordance listed Jango Fett's own lane among the choices and
        // asked the player to click it — but that square is covered by the card
        // itself, so the click hit the card every time. Owner: "it's hard right
        // now to click their lane that they are in to stay."
        G.promptLaneChoice(self.owner, open, "Jango Fett — Move", "Choose a lane to move to", (to) => {
          G.moveCard(self, lane, to);
        }, null, null, 0, { declineLabel: 'STAY PUT', onDecline: () => G.log(`Jango Fett holds his position in lane ${lane + 1}.`) });
      } else {
        const to = open[Math.floor(Game.rng() * open.length)];
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
      // JUGGERNAUT PROTECTS HIMSELF AND HIS NEIGHBOURS, NOT THE WHOLE BOARD.
      // This used to be a board-wide cancel: one Juggernaut anywhere on the
      // enemy side and Grodd's entire On Play did nothing, silently, even with
      // other perfectly legal targets standing there. User: "Juggernaut was on
      // the field ... but there was also an open Gorilla Grodd that I could have
      // done my mind control on".
      // His printed text only ever claimed "While Active: Adjacent allies gain
      // Immunity 1", and he carries Immunity himself — and mindControlCard
      // already routes through tryApplyDebuff, which is where Immunity is
      // spent. So the protection was already handled by the normal machinery
      // and this check was both redundant and wider than the card text.
      // Now: every enemy under the cost gate is offered, and whoever actually
      // holds Immunity resists when the control lands and says so.
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
            if (typeof UI !== 'undefined' && UI._fxGroddMindControl) { try { UI._fxGroddMindControl(self, target); } catch (e) {} }
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
      if (typeof UI !== 'undefined' && UI._fxHawkeyeVolley) { try { UI._fxHawkeyeVolley(self, lane, self.owner); } catch (e) {} }
      G.splashDamage(lane, self.owner, splash, self);
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
      if (typeof UI !== 'undefined' && UI._fxFreezeRay) { try { UI._fxFreezeRay(self, targets); } catch (e) {} }
      G.state[self.owner].healthFrozen = hpHits;
      G.state[self.owner]._healthFrozenBy = self;
      // 2v2: the side proxy is discarded when the sub-phase unbridges, so
      // persist the freeze on the team (like team health) — combat sync and
      // the board render read it back from there for the frozen-bar animation.
      if (G.is2v2 && G.is2v2() && G.state.twoVTwo) {
        const _tm = self.owner === 'player' ? 'A' : 'B';
        const _t = G.state.twoVTwo.teams[_tm];
        if (_t) { _t.healthFrozen = hpHits; }
      }
      const who = Game.isHuman(self.owner) ? 'your' : 'its';
      const list = targets.length ? targets.map(t => t.name).join(', ') + ' and ' : '';
      G.log(`Mr. Freeze freezes ${list}${who} health bar (${hpHits} hits)!`);
    }
  },
  "Juggernaut": {
    onPlay(G, self, lane) {
      const own = self.owner;
      [lane - 1, lane + 1].forEach(l => {
        if (l < 0 || l >= Game.LANE_COUNT) return;
        const ally = G.state.lanes[l][own];
        if (ally && ally.id !== self.id && !ally._juggImmunity) {
          ally.immunityCharges = (ally.immunityCharges || 0) + 1;
          ally._juggImmunity = true;
        }
      });
      G.log(`Juggernaut shields adjacent allies with Immunity 1!`);
    },
    onAnyCardPlayed(G, self) {
      const myLane = G.findCardLane(self);
      if (myLane < 0) return;
      const own = self.owner;
      [myLane - 1, myLane + 1].forEach(l => {
        if (l < 0 || l >= Game.LANE_COUNT) return;
        const ally = G.state.lanes[l][own];
        if (ally && ally.id !== self.id && !ally._juggImmunity) {
          ally.immunityCharges = (ally.immunityCharges || 0) + 1;
          ally._juggImmunity = true;
        }
      });
    },
    onDeath(G, self, lane) {
      const own = self.owner;
      [lane - 1, lane + 1].forEach(l => {
        if (l < 0 || l >= Game.LANE_COUNT) return;
        const ally = G.state.lanes[l][own];
        if (ally && ally._juggImmunity) {
          if ((ally.immunityCharges || 0) > 0) ally.immunityCharges--;
          delete ally._juggImmunity;
        }
      });
      G.log(`Juggernaut falls — adjacent immunity fades!`);
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
      if (typeof UI !== 'undefined' && UI._fxXenomorphAcid) { try { UI._fxXenomorphAcid(self); } catch (e) {} }
      const splash = G.rarityValue(self, { common: 1, rare: 1, special: 2, legendary: 3 });
      G.splashDamage(lane, self.owner, splash, self);
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
      const enemies = G.getEnemiesOf(self.owner).filter(t => G.canEffectLand(t, 'debuff', { owner: self.owner, source: self }) || (t.evadeCharges || 0) > 0);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Bane — Weaken", "Choose enemy to remove -1/-1 & all evades", (e) => {
          // allowKill=true so a 1-HP enemy (e.g. Nightwing) actually dies
          // from the -1/-1. Previously HP floored at 1 and Bane's debuff
          // couldn't finish off already-low targets.
          G.debuffCard(e, 1, 1, true, self);
          e.evadeCharges = 0;
          G.log(`Bane strips ${e.name}: -1/-1 & all evades removed!`);
          if (typeof UI !== 'undefined' && UI._fxBaneVenom) { try { UI._fxBaneVenom(self, e); } catch (er) {} }
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
      const tt = G.state && G.state.twoVTwo;
      // Capture the caster's seat NOW — a 2v2 enemy-seat prompt resolves in a
      // later callback, by which point _2v2CurrentActingPlayer may be cleared.
      const casterSeat = (tt && tt.online) ? G._2v2CurrentActingPlayer : null;
      const finish = (enemySeat) => {
        G.addNextTurnCurrency(owner, n, casterSeat);     // caster gains n
        G.addNextTurnCurrency(opp, -n, enemySeat);       // chosen enemy loses n
        G.log(`Catwoman steals ${n} energy from the enemy next turn!`);
        if (typeof UI !== 'undefined' && UI._fxCatwomanSteal) { try { UI._fxCatwomanSteal(self); } catch (e) {} }
        // v3 — credit Catwoman with the energy swing (gain N self, deny N enemy).
        G._creditChain(self, 'statsDiscountValue', n * 2);
      };
      // 2v2: Catwoman's owner CHOOSES which enemy player to steal from (user:
      // "she should get to choose which enemy to steal from and then give it to
      // the player who placed her"). 1v1 has one opponent — resolve immediately.
      if (tt && tt.online) {
        G._2v2ChooseEnemySeat(owner, 'Catwoman — Steal',
          `Choose an enemy to steal ${n} energy from next turn`,
          (enemySeat) => finish(enemySeat));
      } else {
        finish(null);
      }
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
        if (G._2v2QueueForesight) G._2v2QueueForesight(2, "Dr. Strange");
        const isRl = !!(G.state.mode && G.state.mode._roguelite);
        G.log(isRl
          ? "Dr. Strange peers into the future! Next turn, scry your top 3 — pick 1, the rest sink to the bottom."
          : "Dr. Strange peers into the future! Next turn, choose 1 of 2 top cards — the other goes to your enemy.");
        if (typeof UI !== 'undefined' && UI._fxStrangePortal) { try { UI._fxStrangePortal(self); } catch (e) {} }
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
      const targets = G.getEnemiesOf(self.owner).filter(c => c.currentHealth <= threshold && G.canEffectLand(c, 'destroy', { owner: self.owner, source: self }));
      if (targets.length) {
        G.promptCardChoice(self.owner, targets, "Gamora — Execute", `Choose enemy with ${threshold} or less HP to destroy`, (t) => {
          if (typeof UI !== 'undefined' && UI._fxGamoraBlade) { try { UI._fxGamoraBlade(self, t); } catch (e) {} }
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
      if (typeof UI !== 'undefined' && UI._fxGhostfaceSlash) { try { UI._fxGhostfaceSlash(self); } catch (e) {} }
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
      // Flame-on cue — fire Human Torch's ability sound the instant he ignites
      // (registered in CARD_SFX; matches the Predator / Spider-Man pattern of
      // firing 'ability' from the card's own onPlay). Guarded so the headless
      // sim no-ops. User: "add this to human torch ability."
      if (typeof UI !== 'undefined' && UI.sfx) {
        try { UI.sfx.playCardSfx('Human Torch', 'ability', self); } catch (e) {}
      }
      // Roguelite Text+ override — _humanTorchBlast scales the targeted
      // burn. Default 2 (classic); Text+ raises to 4.
      // Owner: "for human torch have apply 2 burning to an enemy instead of
      // 2 damage." It is no longer a lump of damage — it sets the target
      // alight at Burning N, so it ticks N, N-1, … down to 0 on that card's
      // own lane, through the shared applier every Burning source uses.
      const blast = self._humanTorchBlast || 2;
      // Total damage the burn will eventually deal — N + (N-1) + … + 1.
      // The AI's kill-picker needs the TOTAL, not the first tick, or it would
      // pass over a target the burn actually finishes.
      const blastTotal = (blast * (blast + 1)) / 2;
      // _humanTorchArrivalSplash scales the splash on entry. Default 1
      // (classic); Text+ raises to 3.
      const arrival = self._humanTorchArrivalSplash || 1;
      G.splashDamage(lane, self.owner, arrival, self);
      G.log(`Human Torch ignites on arrival — Splash ${arrival}!`);
      const enemies = G.getEnemiesOf(self.owner).filter(t => G.canEffectLand(t, 'damage', { owner: self.owner, source: self }));
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Human Torch — Blast", `Choose enemy to apply Burning ${blast}`, (t) => {
          if (typeof UI !== 'undefined' && UI._fxHumanTorchFlame) { try { UI._fxHumanTorchFlame(self, t); } catch (e) {} }
          CARD_ABILITIES['Godzilla']._ignite(G, t, blast);
          G.log(`Human Torch sets ${t.name} ablaze — Burning ${t.burnStacks}!`);
        }, cards => _aiKillPicker(cards, blastTotal));
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
        if (typeof UI !== 'undefined' && UI._fxInvisibleWomanField) { try { UI._fxInvisibleWomanField(self, a); } catch (e) {} }
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
      const enemies = G.getEnemiesOf(self.owner).filter(t => (t.attack || 0) > 0 && G.canEffectLand(t, 'debuff', { owner: self.owner, source: self }));
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Nightwing — Weaken", `Choose enemy to remove ${debuff} Attack from`, (t) => {
          if (typeof UI !== 'undefined' && UI._fxNightwingStrike) { try { UI._fxNightwingStrike(self, t); } catch (e) {} }
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
      const targets = G.getEnemiesOf(self.owner).filter(c => c.attack <= threshold && G.canEffectLand(c, 'destroy', { owner: self.owner, source: self }));
      if (targets.length) {
        G.promptCardChoice(self.owner, targets, "Peacemaker — Eliminate", `Choose enemy with ${threshold} or less ATK to destroy`, (t) => {
          if (typeof UI !== 'undefined' && UI._fxPeacemakerShot) { try { UI._fxPeacemakerShot(self, t); } catch (e) {} }
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
      const enemies = G.getEnemiesOf(self.owner).filter(t => G.canEffectLand(t, 'damage', { owner: self.owner, source: self }));
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Rocket Raccoon — Blast", `Choose enemy to deal ${dmg} damage`, (t) => {
          if (typeof UI !== 'undefined' && UI._fxRocketBlast) { try { UI._fxRocketBlast(self, t); } catch (e) {} }
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
      if (typeof UI !== 'undefined' && UI._fxFlashDash) { try { UI._fxFlashDash(self, adj[0] || null); } catch (e) {} }
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
        G.log(`[FLASH] ${G.seatVerb(who, 'go', 'goes')} first next turn.`);
      };
      const chooseFirst = () => {
        // 2v2 online: "first player" is one of FOUR seats, not a side. Offer the
        // whole table and rotate NEXT round's turn cycle to start on the picked
        // seat via _2v2FirstOverride (honored by _2v2ComputePhaseOrder). It sets
        // only who plays the NEXT turn first — the other three follow in the
        // usual interleave. (User: "it should give me a prompt for all 4 players
        // about who I want to go first … and the turn would follow suit"; "it's
        // just the next card played, not the next card for each player.")
        const tt = G.state && G.state.twoVTwo;
        if (tt && tt.online) {
          const nextRound = (tt.round || 0) + 1;
          const myTeam = self.owner === 'player' ? 'A' : 'B';
          const actingSeat = G._2v2CurrentActingPlayer;
          if (Game.isHuman(self.owner) && !G._2v2ActingIsAI()) {
            const tiles = G._2v2SLOTS
              .filter(pk => tt.players[pk] && tt.players[pk].team)
              .map(pk => ({
                name: (pk === tt.you ? 'You' : (tt.players[pk].name || pk)),
                desc: `Team ${tt.players[pk].team}${pk === actingSeat ? ' · this is you' : ''}`,
                _seat: pk, _isPlayerTile: true,
              }));
            G.promptCardChoice(self.owner, tiles, 'The Flash — First Player',
              'Choose who plays first next turn',
              (pick) => {
                if (pick && pick._seat) {
                  tt._2v2FirstOverride = { round: nextRound, seat: pick._seat };
                  G.log(`[FLASH] ${tt.players[pick._seat].name || pick._seat} plays first next turn.`);
                }
              },
              (cards) => cards[0], { inlineTray: true });
          } else {
            // AI-held Flash: put its own team ahead next turn.
            const mySeat = actingSeat || G._2v2SLOTS.find(pk => tt.players[pk] && tt.players[pk].team === myTeam);
            if (mySeat) { tt._2v2FirstOverride = { round: nextRound, seat: mySeat }; }
          }
          return;
        }
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
        if (typeof UI !== 'undefined' && UI._fxCarnageFrenzy) { try { UI._fxCarnageFrenzy(self); } catch (e) {} }
      }
    }
  },
  "Deathstroke": {
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _deathstrokeKillThreshold raises the
      // assassinate ceiling. Default 3 (classic); Text+ sets to 5 so
      // mid-tier targets are also one-shot-able.
      const threshold = self._deathstrokeKillThreshold || 3;
      const targets = G.getEnemiesOf(self.owner).filter(c => c.currentHealth <= threshold && G.canEffectLand(c, 'destroy', { owner: self.owner, source: self }));
      if (targets.length) {
        G.promptCardChoice(self.owner, targets, "Deathstroke — Assassinate", `Choose enemy with ${threshold} or less HP to destroy`, (t) => {
          if (typeof UI !== 'undefined' && UI._fxDeathstrokeKill) { try { UI._fxDeathstrokeKill(self, t); } catch (e) {} }
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
  "Gizmo": {
    // When Damaged (once): spawn a Gremlin into any open lane + add Stripe
    // to hand. Fires on the FIRST hit whether or not it's lethal — a killing
    // blow still triggers the horde (onDamaged runs before handleDeath in both
    // the combat and dealDamage paths), so Gizmo dying to the hit still leaves
    // a Gremlin + Stripe behind. The once-guard lives on the instance so a
    // revived Gizmo comes back re-armed, matching "played anew" revive semantics.
    onDamaged(G, self) {
      if (self._gizmoTriggered) return;
      self._gizmoTriggered = true;
      G.log(`[GIZMO] Bright light! Something's multiplying — a Gremlin appears, and Stripe is coming!`);
      const gremDef = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS.find(d => d.name === 'Gremlin') : null;
      G.summonCardChoice(self.owner, 'Gremlin', 2, 2, 3, [], null, null, gremDef);
      const stripeDef = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS.find(d => d.name === 'Stripe') : null;
      if (stripeDef) {
        const stripe = G.createCardInstance(stripeDef, self.owner);
        if (G.addToHand(self.owner, stripe, self) !== false) {
          G.log(`  [GIZMO] Stripe joins your hand.`);
        }
      }
    },
  },
  "Gremlin": {
    // Swarm — +1 ATK per other living Gremlin ON THE FIELD (both sides,
    // per card text). STRIPE COUNTS AS A GREMLIN for the swarm count
    // (user rule) — he raises every Gremlin's count but doesn't carry
    // Swarm himself (his arrival/death bookkeeping lives in his own
    // onPlay/onDeath). Event-driven additive bookkeeping instead of a
    // per-tick recalc so buffs from other sources (Padme, Power Stone)
    // are never clobbered: each arrival buffs itself by the existing
    // count and every existing Gremlin by +1; each death walks it back.
    // onPlay fires for spawns too — summonCard runs the summoned card's
    // own onPlay whenever a full sourceDef is passed (Gizmo/Stripe do).
    onPlay(G, self, lane) {
      const kin = G.getAllCardsOnBoard().filter(c =>
        c.id !== self.id && (c.name === 'Gremlin' || c.name === 'Stripe') && c.currentHealth > 0);
      if (kin.length) {
        self.attack += kin.length;
        kin.forEach(g => { if (g.name === 'Gremlin') g.attack += 1; });
        G.log(`[SWARM] ${kin.length + 1} in the swarm — it grows stronger!`);
      }
    },
    onDeath(G, self, lane) {
      G.getAllCardsOnBoard().forEach(c => {
        if (c.id !== self.id && c.name === 'Gremlin' && c.currentHealth > 0) {
          c.attack = Math.max(0, c.attack - 1);
        }
      });
    },
  },
  "Stripe": {
    // Jump condition ("either player takes hero damage") lives in
    // Game.checkJumpConditions under the 'heroDamaged' trigger — fired
    // from damagePlayer when face damage actually lands.
    // Swarm kinship: Stripe COUNTS AS a Gremlin for the swarm count, so
    // his arrival gives every living Gremlin +1 ATK and his death takes
    // it back. He doesn't carry Swarm himself — no self-buff here; the
    // new-Gremlin side of the count lives in Gremlin's onPlay (kin
    // filter includes Stripe).
    onPlay(G, self, lane) {
      const brood = G.getAllCardsOnBoard().filter(c =>
        c.id !== self.id && c.name === 'Gremlin' && c.currentHealth > 0);
      if (brood.length) {
        brood.forEach(g => { g.attack += 1; });
        G.log(`[SWARM] Stripe joins the swarm — ${brood.length} Gremlin${brood.length > 1 ? 's' : ''} grow${brood.length > 1 ? '' : 's'} stronger!`);
      }
    },
    onDeath(G, self, lane) {
      G.getAllCardsOnBoard().forEach(c => {
        if (c.id !== self.id && c.name === 'Gremlin' && c.currentHealth > 0) {
          c.attack = Math.max(0, c.attack - 1);
        }
      });
    },
    onKill(G, self) {
      if (self.currentHealth <= 0) return;
      G.log(`[STRIPE] Stripe tears one down — the swarm feeds!`);
      // Kill feed: PERMANENT +1/+1 to every living friendly Gremlin AND
      // Stripe himself ("add 1/1 to all Gremlins, including Stripe").
      // Deliberate exception to the 1-turn cross-card buff default —
      // this is the swarm's growth engine, same permanence as an onKill
      // self-buff. Buff lands BEFORE the spawn so the newcomer arrives
      // at base stats (it wasn't on the field for the kill).
      const brood = G.getAlliesOf(self.owner).filter(c =>
        c.name === 'Gremlin' && c.currentHealth > 0);
      brood.forEach(g => { g.attack += 1; g.maxHealth += 1; g.currentHealth += 1; });
      self.attack += 1; self.maxHealth += 1; self.currentHealth += 1;
      G.log(`  [STRIPE] Stripe${brood.length ? ` and ${brood.length} Gremlin${brood.length > 1 ? 's' : ''}` : ''} feed on the kill — +1/+1.`);
      const gremDef = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS.find(d => d.name === 'Gremlin') : null;
      G.summonCardChoice(self.owner, 'Gremlin', 2, 2, 3, [], null, null, gremDef);
    },
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
      if (typeof UI !== 'undefined' && UI._fxGoblinBombs) { try { UI._fxGoblinBombs(self, lane, self.owner); } catch (e) {} }
      G.splashDamage(lane, self.owner, 1 + boost, self);
      G.splashDamage(lane, self.owner, 2 + boost, self);
      G.log(`Green Goblin throws pumpkin bombs! Splash ${1 + boost} then Splash ${2 + boost}!`);
    },
    onBeforeTricks(G, self, lane) {
      // Stun / freeze blocks the move AND the follow-up splash. Same
      // guard as Man-Bat — moveCard alone isn't enough because the
      // splash fires after the refused move.
      if (Game.isActionLocked(self)) {
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
        // STAY is a BUTTON, not a lane (see promptLaneChoice options.declineLabel).
        // The old affordance listed Green Goblin's own lane among the choices and
        // asked the player to click it — but that square is covered by the card
        // itself, so the click hit the card every time. Owner: "it's hard right
        // now to click their lane that they are in to stay."
        G.promptLaneChoice(self.owner, targetLanes, "Green Goblin — Move", "Choose a lane to move to", (to) => {
          G.moveCard(self, lane, to);
          G.splashDamage(to, self.owner, 1, self);
          const e = G.state.lanes[to][opp];
          G.log(`Green Goblin moves to face ${e ? e.name : 'enemy'} in lane ${to + 1} and splashes!`);
        }, null, null, 0, { declineLabel: 'STAY PUT', onDecline: () => G.log(`Green Goblin stays put in lane ${lane + 1}.`) });
      } else {
        const to = targetLanes[Math.floor(Game.rng() * targetLanes.length)];
        G.moveCard(self, lane, to);
        G.splashDamage(to, self.owner, 1, self);
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
      if (typeof UI !== 'undefined' && UI._fxGrootGuard) { try { UI._fxGrootGuard(self, lane, own); } catch (e) {} }
    }
  },
  "Jigsaw": {
    isDiscardEffect: true,
    // Environments are normally placed by playCard, which inlines the slot
    // handling. Nothing exposes it, so this mirrors that block: clear whatever
    // occupies the sub-slot on EITHER side (a live env left dangling keeps
    // receiving broadcasts — the replaced-Boiler-Room bug), seat the new room,
    // announce it, and run its own On Play so it can arm itself.
    _placeRoom(G, owner, laneIdx, name) {
      const def = (typeof CARD_DEFS !== 'undefined')
        ? CARD_DEFS.find(d => d.name === name) : null;
      if (!def) return null;
      const lane = G.state.lanes[laneIdx];
      if (!lane._env) lane._env = {};
      [owner, G.opponent(owner)].forEach(side => {
        const existing = lane._env[side];
        if (existing) {
          existing.currentHealth = 0;
          G.handleDeath(existing, laneIdx, null);
          lane._env[side] = null;
        }
      });
      const room = G.createCardInstance(def, owner);
      lane._env[owner] = room;
      if (room.statsEnteredRound == null) room.statsEnteredRound = G.state.round || 1;
      G.emitFX('envReveal', { lane: laneIdx, owner, name });
      G.log(`[JIGSAW] ${name} opens in lane ${laneIdx + 1}.`);
      if (room.onPlay) room.onPlay(G, room, laneIdx);
      return room;
    },
    onDiscard(G, owner, self) {
      const opp = G.opponent(owner);

      // Step 2: After all traps are placed, move an enemy card to any open lane.
      const moveEnemyStep = () => {
        // Frozen / stunned enemies can't be dragged either — they're locked
        // in their lane until the status clears. Filter them out of the
        // pickable pool so Jigsaw can't move a frozen victim.
        const enemies = G.getEnemiesOf(owner).filter(e => !e.isFrozen && !e.isStunned);
        if (!enemies.length) { G.log("Jigsaw finds no enemy cards left to drag."); return; }
        // Same guard as Gojo / Darth Vader: with no open enemy-side lane there
        // is no destination for ANY pick, so asking wastes the player's choice
        // timer on a dead end.
        if (!G.getOpenLanes(G.opponent(owner)).length) {
          G.log('Jigsaw finds no open lane to drag anyone into — skipping.');
          return;
        }
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

      // ROOMS, NOT TRAPS. Owner: "jigsaw now makes 2 environments." The two
      // rooms replace the Bear Traps entirely; the relocate step below is kept.
      // Placed into lanes that are EMPTY ON THE ENEMY SIDE — the same lane test
      // the traps used, and the same one the rooms need, since both only mean
      // anything to a card that walks in afterwards.
      const ROOMS = ['The Bathroom', 'The Reveal'];
      const placeRoomStep = (idx) => {
        if (idx >= ROOMS.length) { moveEnemyStep(); return; }
        const name = ROOMS[idx];
        const open = [];
        for (let i = 0; i < G.LANE_COUNT; i++) {
          const l = G.state.lanes[i];
          if (l.destroyed || l[opp]) continue;
          // Never stack a room on top of the one just placed.
          if (l._env && l._env[owner]) continue;
          open.push(i);
        }
        if (!open.length) {
          G.log(`Jigsaw has no empty enemy lane left — ${name} goes unused.`);
          moveEnemyStep();
          return;
        }
        G.promptLaneChoice(owner, open,
          `Jigsaw — ${name}`,
          `Choose an enemy lane for ${name} (${idx + 1} of ${ROOMS.length})`,
          (lane) => {
            CARD_ABILITIES['Jigsaw']._placeRoom(G, owner, lane, name);
            placeRoomStep(idx + 1);
          },
          // One reachable outcome resolves itself — the same forced-choice rule
          // the traps already used, and the rest of the game follows.
          opp, null, 0, { forced: open.length <= (ROOMS.length - idx) });
      };

      G.log(`Jigsaw's game begins — two rooms, then drag someone into one.`);
      placeRoomStep(0);
    }
  },
  "Brainiac": {
    // Discard-only, like Mr. Fantastic and Jigsaw — 0/0, isDiscardEffect keeps
    // playCard from ever seating it in a lane. Its whole payload is the scry.
    isDiscardEffect: true,
    // Peek the opponent's next N draws. The draw pile is popped from the END
    // (drawCards → drawPile.pop()), so the "next" cards are the last entries,
    // read back-to-front. Classic shares one pile (getDrawPile returns it for
    // either side); Deckbuilder returns the opponent's own pile — both are
    // "what the opponent is about to draw", which is all this needs.
    _upcoming(G, owner, n) {
      const opp = G.opponent(owner);
      const pile = G.getDrawPile(opp) || [];
      const out = [];
      for (let i = pile.length - 1; i >= 0 && out.length < n; i--) {
        const c = pile[i];
        if (c && c.name) out.push(c);
      }
      return out;
    },
    onDiscard(G, owner, self) {
      const COUNT = 2;
      const reveal = (targetName) => {
        // The reveal is a LIVE scan, not a snapshot: the UI re-reads the top of
        // the pile every render (so reorders / shuffles stay honest). Store only
        // how long it lasts — two rounds, ticked down in startRound.
        G.state[owner]._brainiacScanRounds = Math.max(G.state[owner]._brainiacScanRounds || 0, COUNT);
        const upcoming = CARD_ABILITIES['Brainiac']._upcoming(G, owner, COUNT);
        const who = targetName ? `${targetName}'s` : (G.seatPossessive ? G.seatPossessive(G.opponent(owner)) : "the opponent's");
        if (!upcoming.length) {
          G.log(`[BRAINIAC] ${who} draw pile is empty — nothing to foresee (yet).`);
        } else {
          G.log(`[BRAINIAC] Foreseeing ${who} next ${upcoming.length} draw${upcoming.length === 1 ? '' : 's'}: ${upcoming.map(c => c.name).join(', ')}.`);
        }
        // Surface it immediately to the human when THEY are the one scrying. The
        // persistent strip (UI.render) is the lasting reveal; this is the "ping".
        if (owner === 'player' && typeof UI !== 'undefined' && UI._fxBrainiacScan) {
          try { UI._fxBrainiacScan(upcoming); } catch (e) {}
        }
      };
      // 2v2: the Brainiac player CHOOSES which enemy player to foresee (user:
      // "in 2v2 he should see the next 2 draws for a chosen enemy player"). The
      // shared 2v2 draw pile IS what that player is about to draw from, so the
      // top-N scan reads the same cards; the pick names whose draws you're eyeing.
      const tt = G.state && G.state.twoVTwo;
      if (tt && tt.online && G._2v2ChooseEnemySeat) {
        G._2v2ChooseEnemySeat(owner, 'Brainiac — Foresee',
          'Choose an enemy to foresee their next 2 draws',
          (seat) => reveal(seat && tt.players[seat] ? (tt.players[seat].name || seat) : null));
      } else {
        reveal(null);
      }
    }
  },
  "Art the Clown": {
    // Jump ("enemy has more cards on the field") lives in
    // Game.checkJumpConditions under the 'beforeTricks' trigger, fired at the
    // start of the trick phase after both sides finish playing cards.
    //
    // The bag: four weapons, each used at most once until all four are spent,
    // then Art is a plain body forever. The choice fires ONCE per round — on
    // play (his first swing) and every round after via onBeforeTricks. Both
    // funnel through _step, which the per-round guard makes idempotent so the
    // play-round's own onBeforeTricks pass can't hand out a second weapon.
    _recurringBT: true,
    // key drives logic; icon is the "cool symbol" shown on the choice tile and
    // in the swing animation; the strip fields make each weapon render as a
    // real option card in the picker tray.
    WEAPONS: [
      { key: 'scissors',     name: 'Scissors',     desc: 'Permanently strip one keyword or badge from an enemy.' },
      { key: 'sledgehammer', name: 'Sledgehammer', desc: "Deal double Art's current ATK to one enemy." },
      { key: 'scythe',       name: 'Scythe',        desc: "Permanently halve one enemy's ATK and HP (rounded down)." },
      { key: 'hacksaw',      name: 'Hacksaw',       desc: 'An enemy bleeds 2 immediately, then 2 more at the start of next round.' },
    ],
    onPlay(G, self, lane) { CARD_ABILITIES['Art the Clown']._step(G, self); },
    onBeforeTricks(G, self, lane) { CARD_ABILITIES['Art the Clown']._step(G, self); },
    // Turn Art into a stats-only body: drop every hook so no prompt ever fires
    // again, exactly as the card text promises once the bag is empty.
    _exhaust(G, self) {
      self._artExhausted = true;
      self.onPlay = null; self.onBeforeTricks = null; self._recurringBT = false;
      G.log(`[ART] The bag is empty — Art the Clown is just a body now (${self.attack}/${self.currentHealth}).`);
    },
    _step(G, self) {
      const AB = CARD_ABILITIES['Art the Clown'];
      if (self._artExhausted) return;
      if (!self._artWeaponsUsed) self._artWeaponsUsed = [];
      // If the bag emptied on a prior swing, become a body and stop.
      if (self._artWeaponsUsed.length >= AB.WEAPONS.length) { AB._exhaust(G, self); return; }
      // One swing per round. Guard BEFORE anything else so the play-round's
      // later onBeforeTricks pass is a no-op.
      const round = G.state.round || 1;
      if (self._artWeaponRound === round) return;
      const owner = self.owner;
      // Only weapons that both remain in the bag AND have a legal target this
      // round are offered — so "no weapon twice" can never strand Art on a
      // weapon with nothing to hit.
      const remaining = AB.WEAPONS.filter(w => self._artWeaponsUsed.indexOf(w.key) < 0);
      const enemies = G.getEnemiesOf(owner).filter(e => e.currentHealth > 0);
      const hasKeyworded = enemies.some(e => AB._strippable(e).length > 0);
      const usable = remaining.filter(w => w.key === 'scissors' ? hasKeyworded : enemies.length > 0);
      if (!usable.length) {
        // Nothing to hit — Art waits, no weapon spent.
        if (enemies.length) G.log(`[ART] No keyword left to cut — Art holds the scissors for later.`);
        else G.log(`[ART] No enemy on the field — Art keeps his tools in the bag.`);
        return;
      }
      self._artWeaponRound = round;
      // Build the picker tiles. Synthetic option cards (like the Upkeep prompt)
      // — the _artWeaponKey marker is what the callback reads.
      // No attack/health fields — that keeps them ACTION tiles (not "real
      // cards"), so the picker renders the neon weapon glyph instead of a 0/1
      // card face. See UI's choice-tile builder (_artWeaponKey branch).
      const tiles = usable.map(w => ({
        _artWeaponKey: w.key, name: w.name, cost: 0, type: 'horror', desc: w.desc,
      }));
      G.promptCardChoice(owner, tiles,
        'Art the Clown — Pick a Weapon',
        `Choose one (${self._artWeaponsUsed.length + 1} of ${AB.WEAPONS.length}). Each can be used only once until all four are spent.`,
        (picked) => { AB._resolve(G, self, picked && picked._artWeaponKey); },
        // AI heuristic: a lethal Sledgehammer first, then Scythe on the biggest
        // threat, then Scissors on a keyworded enemy, else Hacksaw.
        (tilesList) => AB._aiPick(G, self, tilesList));
    },
    _aiPick(G, self, tiles) {
      const owner = self.owner;
      const enemies = G.getEnemiesOf(owner).filter(e => e.currentHealth > 0);
      const has = (k) => tiles.find(t => t._artWeaponKey === k);
      const atk = G._cardEffectiveAtk ? G._cardEffectiveAtk(self) : self.attack;
      // Sledgehammer if it one-shots something.
      if (has('sledgehammer') && enemies.some(e => (e.currentHealth <= atk * 2))) return has('sledgehammer');
      // Scythe on the biggest body.
      if (has('scythe') && enemies.some(e => (e.attack + e.currentHealth) >= 6)) return has('scythe');
      // Scissors if an enemy carries a keyword worth removing.
      if (has('scissors')) return has('scissors');
      if (has('sledgehammer')) return has('sledgehammer');
      if (has('hacksaw')) return has('hacksaw');
      return tiles[0];
    },
    _resolve(G, self, key) {
      const AB = CARD_ABILITIES['Art the Clown'];
      if (!key) return;
      const owner = self.owner;
      const spend = () => {
        self._artWeaponsUsed.push(key);
        if (self._artWeaponsUsed.length >= AB.WEAPONS.length) AB._exhaust(G, self);
      };
      const fx = (targetId) => {
        if (targetId != null) { try { G.emitFX('artWeapon', { weapon: key, cardId: targetId, owner }); } catch (e) {} }
      };
      const pickEnemy = (title, filter, cb) => {
        const enemies = G.getEnemiesOf(owner).filter(e => e.currentHealth > 0 && (filter ? filter(e) : true));
        if (!enemies.length) { G.log(`[ART] ${title} — no valid target.`); return; }
        G.promptCardChoice(owner, enemies, `Art the Clown — ${title}`, 'Choose an enemy card.',
          (picked) => cb(picked),
          // AI: highest ATK+HP threat (scissors picks the most-keyworded).
          (list) => (key === 'scissors'
            ? list.slice().sort((a, b) => AB._strippable(b).length - AB._strippable(a).length)[0]
            : list.slice().sort((a, b) => (b.attack + b.currentHealth) - (a.attack + a.currentHealth))[0]));
      };

      if (key === 'sledgehammer') {
        const dmg = 2 * (G._cardEffectiveAtk ? G._cardEffectiveAtk(self) : self.attack);
        pickEnemy('Sledgehammer', null, (t) => {
          G.log(`[ART] Sledgehammer! ${self.name} smashes ${t.name} for ${dmg}.`);
          fx(t.id);
          G.dealDamage(t, dmg, self);
          G.cleanupDead();
          spend();
        });
      } else if (key === 'scythe') {
        pickEnemy('Scythe', null, (t) => {
          const na = Math.floor((t.attack || 0) / 2);
          const nh = Math.floor((t.currentHealth || 0) / 2);
          const nm = Math.max(1, Math.floor((t.maxHealth || t.currentHealth || 1) / 2));
          t.attack = Math.max(0, na);
          t.maxHealth = nm;
          t.currentHealth = nh;
          G.log(`[ART] Scythe! ${t.name} is cut down to ${t.attack}/${t.currentHealth}.`);
          fx(t.id);
          const lane = G.findCardLane(t);
          if (t.currentHealth <= 0 && lane >= 0) G.handleDeath(t, lane, self);
          G.cleanupDead();
          spend();
        });
      } else if (key === 'hacksaw') {
        pickEnemy('Hacksaw', null, (t) => {
          // Badge lands immediately (driven by _bleedRounds) AND the wound bleeds
          // NOW rather than waiting for the next round start. (User: "instead of
          // the start of the next round the bleeding effect happens i want the
          // badge to happen and effect to happen as soon as he chooses who to
          // hacksaw.") First tick fires here; tickBleed decrements it to one
          // remaining tick, which bleeds at the next round start.
          t._bleedRounds = 2;
          t._bleedAmount = 2;
          t._bleedSourceOwner = owner;
          fx(t.id);
          G.tickBleed(t);            // immediate blood FX + 2 damage, → 1 round left
          G.cleanupDead();
          G.log(`[ART] Hacksaw! ${t.name} bleeds 2 now, and again at the start of the next round.`);
          if (typeof UI !== 'undefined' && UI.render) UI.render();
          spend();
        });
      } else if (key === 'scissors') {
        pickEnemy('Scissors', (e) => AB._strippable(e).length > 0, (t) => {
          const opts = AB._strippable(t);
          if (!opts.length) { G.log(`[ART] Scissors — ${t.name} has nothing left to cut.`); return; }
          // Second prompt: WHICH keyword. Synthetic tiles again.
          const kwTiles = opts.map(ab => ({ _artKw: ab, name: ab, cost: 0, type: 'horror', desc: `Permanently remove ${ab}.` }));
          G.promptCardChoice(owner, kwTiles, `Art the Clown — Scissors on ${t.name}`,
            'Choose a keyword or badge to cut away for good.',
            (pk) => {
              const ab = pk && pk._artKw;
              if (!ab) return;
              AB._stripKeyword(G, t, ab);
              G.log(`[ART] Scissors! ${ab} is cut from ${t.name} — gone for good.`);
              fx(t.id);
              G.cleanupDead();
              spend();
            },
            (list) => list[0]);
        });
      }
    },
    // The enemy's removable keywords/badges — the entries in its abilities list
    // that map to a live parsed flag (so cutting one actually changes the card).
    _strippable(card) {
      return (card.abilities || []).filter(ab => CARD_ABILITIES['Art the Clown']._kwField(ab) != null);
    },
    // Maps a keyword string ("Evade 2", "Damage Immunity") to the instance field
    // it set in Game.applyAbilities, plus the "removed" value. Mirrors that
    // switch — the single source of truth for what a keyword becomes on a card.
    _kwField(ab) {
      const parts = String(ab).split(' ');
      const w = parts[0];
      const M = {
        Armor: ['armorValue', 0], Evade: ['evadeCharges', 0], Taunt: ['tauntTurns', 0],
        Invincible: ['invincibleTurns', 0], Splash: ['splashRange', 0], Overdrive: ['isOverdrive', false],
        Bullseye: ['isBullseye', false], Immunity: ['immunityCharges', 0], Unresistible: ['unresistibleCharges', 0],
        Revive: ['reviveCharges', 0], Untrickable: ['isUntrickable', false], Draw: ['drawOnPlay', 0],
        Fear: ['hasFear', 0], Crazy: ['isCrazy', false], Insane: ['isInsane', false],
      };
      if (w === 'Hunt') return parts[1] === 'Meter' ? ['hasHuntMeter', false] : ['hasHunt', false];
      if (w === 'Damage') return parts[1] === 'Immunity' ? ['hasDamageImmunity', false] : null;
      if (w === 'Dead') return parts[1] === 'Draw' ? ['hasDeadDraw', 0] : null;
      if (w === 'Spawn') return parts[1] === 'Only' ? ['isSpawnOnly', false] : null;
      return M[w] || null;
    },
    _stripKeyword(G, card, ab) {
      const AB = CARD_ABILITIES['Art the Clown'];
      // Drop the chosen string from the printed abilities list (so the badge
      // and the def-derived text both lose it)...
      const idx = (card.abilities || []).indexOf(ab);
      if (idx >= 0) card.abilities.splice(idx, 1);
      // ...and clear the live flag it drove in Game.applyAbilities.
      const f = AB._kwField(ab);
      if (f) {
        card[f[0]] = f[1];
        // Untrickable also carries a "permanent" latch set by applyAbilities.
        if (f[0] === 'isUntrickable') card.permanentUntrickable = false;
      }
    },
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
      if (typeof UI !== 'undefined' && UI._fxLokiMagic) { try { UI._fxLokiMagic(self); } catch (e) {} }
      if (allyEvade !== 'none') {
        const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id);
        const targets = allyEvade === 'all' ? allies : (allies.length ? [allies[Math.floor(Game.rng() * allies.length)]] : []);
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
    // EVERY hook createCardInstance can assign. Six were missing —
    // onBeforeCombat, onLaneCombat, onLaneResolved, onAnyTrickPlayed,
    // onDiscard, onMoved — so "strips ALL abilities" quietly meant "strips 13
    // of 19". Reported case: Jack Sparrow played into Moder kept firing Parlay
    // every combat, because Parlay lives on onBeforeCombat. Voldemort's curses
    // (onLaneCombat) had the same hole. sim/test.js now fails if game.js gains
    // a hook that is not listed here.
    const STRIP_HOOKS = [
      'onPlay', 'onDeath', 'onDamaged', 'onKill', 'onBeforeTricks',
      'onBeforeAttack', 'onEndOfTurn', 'onAnyCardPlayed', 'onAllyKilled', 'onEnemyKilled',
      'onEvade', 'onDamagePlayer', 'onTurnStart', 'passive',
      'onBeforeCombat', 'onLaneCombat', 'onLaneResolved', 'onAnyTrickPlayed',
      'onDiscard', 'onMoved',
      'onAnyCardDamaged', 'onBlockMeterFired', 'onRevive',
    ];
    const STRIP_FIELDS = [
      ...STRIP_HOOKS,
      'evadeCharges', 'armorValue', 'isOverdrive', 'isBullseye',
      'immunityCharges', 'hasHunt', 'hasHuntMeter', 'hasDamageImmunity',
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
      // Driven from STRIP_HOOKS rather than hand-written. The old code listed
      // the same hooks a SECOND time here, and that copy is the one that fell
      // behind — the array above already carried the comment "listed once so
      // the strip and restore paths can't drift" while the drift was six lines
      // below it.
      for (const h of STRIP_HOOKS) card[h] = null;
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
      // Exposed so the ENGINE can run the strip at lane-entry time. It used to
      // fire only from onAnyCardPlayed, which broadcasts AFTER the arriving
      // card's own onPlay — so a card played into Moder's lane got its When
      // Played off before losing its abilities, and if that On Play killed
      // Moder (Human Torch's splash + blast did exactly this) she was off the
      // board by the time the broadcast reached her and never stripped at all.
      // Moder's compulsion is a lane trap; it belongs on lane entry, next to
      // Bear Trap, not in the post-play broadcast.
      _strip: (card, G) => strip(card, G),
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
        // Expose the strip so the engine can neutralize the forced card the
        // instant it is PULLED into Moder's lane — before its When Played
        // fires. Deferring to onAnyCardPlayed (post-onPlay) let the forced
        // card resolve its whole entrance first: it kept its When Played, and
        // if that onPlay damaged Moder (e.g. Hulk) it killed him before the
        // strip broadcast ever ran, so nothing got stripped at all. The card
        // is meant to "lose all abilities and keywords" — including its When
        // Played — so game.js calls this at redirect time. Stamped on Game
        // (not state) so it survives serialization; the closure carries strip.
        if (G && typeof G._moderStripCard !== 'function') {
          G._moderStripCard = (target) => strip(target, G);
        }
        G.log(`Moder compels the next enemy card into lane ${lane + 1}!`);
        if (typeof UI !== 'undefined' && UI._fxModerCoil) { try { UI._fxModerCoil(self, lane, self.owner); } catch (e) {} }
      },
      onDeath(G, self) {
        const opp = G.opponent(self.owner);
        if (G.state[opp] && G.state[opp].forcedLane != null) {
          G.state[opp].forcedLane = null;
          G.log(`Moder's forced-lane effect ends.`);
        }
      },
      onAnyCardPlayed(G, self, playedCard) {
        // Strip only the card that was just played directly into Moder's lane.
        // Cards that hunted or moved here (onBeforeTricks, _resolveHuntChase)
        // don't count — the strip pending stays until a card is genuinely
        // played into the lane.
        if (!self._moderStripPending || self._moderStripPending <= 0) return;
        const myLane = G.findCardLane(self);
        if (myLane < 0) return;
        const opp = G.opponent(self.owner);
        const enemy = G.state.lanes[myLane][opp];
        if (enemy && !enemy._moderStripped && playedCard && enemy.id === playedCard.id) {
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
      // Buff applies to ANY card, not just villains. User spec: "red
      // skull should give an ally +2/+2 not just a villain". Lets
      // hero-leaning decks (e.g. Synergy Swarm) use Red Skull as the
      // tricks-phase enabler without a type-tax on which card gets the
      // empower.
      // Roguelite Text+ override — _redSkullEmpower scales the buff.
      // Default 2 (classic +2/+2); Text+ raises to 3 (+3/+3) for an
      // even bigger finisher buff.
      const empower = self._redSkullEmpower || 2;
      // TARGETS THE HAND, AT RANDOM. Owner direction: the empower lands on a
      // card you have not played yet, not on one already on the board. That
      // changes what the card IS — it stops being a board-swing finisher you
      // aim, and becomes a setup card that makes a future play bigger. Random
      // rather than chosen for the same reason: no prompt, no aiming.
      //
      // G.rng(), never Math.random — this is the seeded engine RNG, and the
      // fuzz harness and replay system both depend on the same seed producing
      // the same game.
      const hand = (G.state && G.state[self.owner] && G.state[self.owner].hand) || [];
      const pool = hand.filter(c => c && c.id !== self.id);
      if (pool.length) {
        const pick = pool[Math.floor(G.rng() * pool.length)];
        const pickIdx = hand.indexOf(pick);
        G.buffCard(pick, empower, empower);
        G.log(`Red Skull empowers ${pick.name} in hand +${empower}/+${empower}!`);
        if (typeof UI !== 'undefined' && UI._fxRedSkullCube) { try { UI._fxRedSkullCube(self); } catch (e) {} }
        // Cosmic-Cube GOLD flare on the exact hand card he empowered, so you
        // can see which card was buffed (gold = buff, vs Freddy's red = hit).
        if (typeof UI !== 'undefined' && UI._fxHandCardFlare) {
          try { UI._fxHandCardFlare(self.owner, pick.id, pickIdx, { color: '#ffcc33', core: '#fff3c0' }); } catch (e) {}
        }
      } else {
        G.log(`Red Skull has no card in hand to empower.`);
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
        // SHE ENDS AS AN EXACT MIRROR — AFTER the aura, not before it.
        //
        // A While Active aura (Magneto's parity, Luke's) lands on Scarlet Witch
        // the instant she arrives, one step AFTER this hook. Copying her
        // target's numbers and stopping meant the aura then moved her OFF the
        // body she had just copied — and when the target is small and the aura
        // is hostile, off the board entirely: opposite an enemy Magneto in an
        // even lane, she copied a 1/1 Doomsday, took -1/-1, and died on entry
        // without doing anything. Owner: "magneto was on the field and scarlet
        // witch die on entry in front of doomsday", and the rule they asked
        // for: "the on play happens first then the passives hit".
        //
        // So she copies the target OFFSET BY THE AURA SHE IS ABOUT TO RECEIVE,
        // and lands on the target's exact stats once it does. Note the aura on
        // HER is not the aura on her TARGET — they stand on opposite sides, so
        // Magneto buffing him is the same Magneto debuffing her. Reading the
        // recorded aura off the target would have got the sign backwards half
        // the time; asking what SHE is due is the question that actually
        // matters. auraWantFor shares the engine's own source scan, so any
        // future aura is mirrored correctly without touching this card.
        const incoming = G.auraWantFor ? G.auraWantFor(self) : { atk: 0, hp: 0 };
        const adoptAtk = Math.max(0, (enemy.attack || 0) - incoming.atk) + bonus;
        const adoptHp  = Math.max(1, (enemy.currentHealth || enemy.maxHealth || 1) - incoming.hp) + bonus;
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
      if (typeof UI !== 'undefined' && UI._fxScarletHex) { try { UI._fxScarletHex(self, (enemy && enemy.currentHealth > 0) ? enemy : null); } catch (e) {} }
    }
  },
  "Solomon Grundy": {
    onDeath(G, self, lane) {
      if (typeof UI !== 'undefined' && UI._fxGrundyGrave) { try { UI._fxGrundyGrave(self); } catch (e) {} }
      // Roguelite Text+ ("Born on Monday") replaces the dead-pile draw
      // with a revive-and-grow loop. _grundyReviveBuff is the per-revive
      // ATK/HP gain; reviveCharges (set in apply) gates how many times
      // he can come back. When the upgrade is active we revive him in
      // place and skip the classic draw entirely.
      if (self._grundyReviveBuff && self.reviveCharges > 0) {
        if (G.reviveVoided(self, lane)) return;
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
      // Lex Luthor blocks dead-pile draws — addToHand() skips the drawCards()
      // guard, same bypass Hela had.
      if (!G.canDrawToHand(self.owner, 'Solomon Grundy')) return;
      for (let i = 0; i < draws; i++) {
        const dead = isRoguelite
          ? (ownDead || [])
          : [...(ownDead || []), ...(oppDead || [])];
        if (!dead.length) break;
        const idx = Math.floor(Game.rng() * dead.length);
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
        if (typeof UI !== 'undefined' && UI._fxStarLordRally) { try { UI._fxStarLordRally(self, a); } catch (e) {} }
      };
      if (allies.length) {
        G.promptCardChoice(self.owner, allies, "Star-Lord — Buff", `Choose ally to give +${buff}/+${buff}`, grant);
      }
    }
  },
  "Symbiote Spider-Man": {
    onPlay(G, self, lane) {
      if (typeof UI !== 'undefined' && UI._fxSymbioteSurge) { try { UI._fxSymbioteSurge(self); } catch (e) {} }
      // Each card shuffles back to its OWNER's pile — in Deckbuilder this
      // is their personal deck, in Classic it's the shared pile (same ref).
      const shuffleBack = (card, ownerKey) => {
        // GUARDED. This was an unguarded .push() on whatever getDrawPile
        // returned, so a missing pile threw from inside the per-seat chain
        // below — and one seat throwing there stops every seat after it, which
        // reads as "only one of us redrew". A card that cannot be shuffled back
        // should cost that seat its cycle, never the rest of the table's.
        const pile = G.getDrawPile(ownerKey);
        if (!Array.isArray(pile)) {
          G.log(`  [SSM] No draw pile for ${ownerKey} — ${card.name} stays put.`);
          return;
        }
        pile.push({ name: card.name, cost: card.baseCost || card.cost, attack: card.attack, health: card.maxHealth, abilities: card.abilities, type: card.type, desc: card.desc });
      };
      const doPlayerShuffle = (p, onDone) => {
        const hand = G.state[p].hand;
        if (hand.length <= 2) {
          // YOU DRAW WHAT YOU PUT BACK — never more. This branch used to draw a
          // flat 2 no matter how many cards went back, so an EMPTY hand
          // shuffled nothing and drew two free cards: the card's whole point is
          // a wash (2 back, 2 up), and at 0 cards it became pure advantage for
          // both sides. Owner: "when symbiote spiderman is played and i have 0
          // cards it draws me 2 cards automatically, that shouldn't happen."
          const back = hand.length;
          hand.splice(0).forEach(c => shuffleBack(c, p));
          if (back > 0) {
            G.shuffle(G.getDrawPile(p));
            G.drawCards(p, back);
            G.log(`Symbiote Spider-Man: ${p} shuffles ${back} card${back === 1 ? '' : 's'} back and draws ${back}!`);
          } else {
            G.log(`Symbiote Spider-Man: ${p} has an empty hand — nothing to shuffle, nothing to draw.`);
          }
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
      const symIn2v2 = !!(G.is2v2 && G.is2v2() && G.state.twoVTwo && G.state.twoVTwo.online);
      if (skipSelf) {
        doPlayerShuffle(opp, finish);
      } else if (symIn2v2) {
        // 2v2: EVERY player cycles 2 of their own cards (like 1v1's "both
        // players redraw", extended to all four seats). doPlayerShuffle reads
        // the SIDE proxy — wrong in a 2-seats-per-side game — so shuffle each
        // seat's REAL hand, routed to that seat (humans get the pick prompt on
        // their own client; AI seats auto-cycle their 2 lowest-cost cards).
        const tt = G.state.twoVTwo;
        const seatShuffle = (seatKey, onDone) => {
          const sp = tt.players[seatKey];
          if (!sp) { onDone && onDone(); return; }
          const seatSide = G._2v2TeamSide[sp.team];
          const hand = sp.hand || [];
          const back = Math.min(2, hand.length);
          // Route this seat's prompt + shuffled-back draws to the seat itself.
          G._2v2CurrentActingPlayer = seatKey;
          const finalizeDraw = () => {
            if (back > 0) {
              G.shuffle(G.getDrawPile(seatSide));
              G._2v2CurrentActingPlayer = seatKey;   // re-assert before the draw routes
              G.drawCards(seatSide, back);
              G.log(`Symbiote Spider-Man: ${sp.name} shuffles ${back} card${back === 1 ? '' : 's'} back and draws ${back}!`);
            } else {
              G.log(`Symbiote Spider-Man: ${sp.name} has an empty hand — nothing to cycle.`);
            }
            onDone && onDone();
          };
          const lowest = (cards) => cards.slice().sort((a, b) => (a.cost || 0) - (b.cost || 0))[0];
          if (sp.isAI || hand.length <= 2) {
            // AI seat, or a hand small enough that the pick is forced: auto-cycle.
            for (let i = 0; i < back; i++) {
              const c = lowest(hand); if (!c) break;
              const idx = hand.findIndex(x => x.id === c.id);
              if (idx >= 0) { shuffleBack(hand[idx], seatSide); hand.splice(idx, 1); }
            }
            finalizeDraw();
          } else {
            G.promptCardChoice(seatSide, [...hand], "Symbiote Spider-Man — Shuffle",
              "Choose 1st card to shuffle back into the deck (pick 2 total)", (c1) => {
                const i1 = hand.findIndex(c => c.id === c1.id);
                if (i1 >= 0) { shuffleBack(hand[i1], seatSide); hand.splice(i1, 1); }
                G._2v2CurrentActingPlayer = seatKey;
                G.promptCardChoice(seatSide, [...hand], "Symbiote Spider-Man — Shuffle",
                  "Choose 2nd card to shuffle back into the deck", (c2) => {
                    const i2 = hand.findIndex(c => c.id === c2.id);
                    if (i2 >= 0) { shuffleBack(hand[i2], seatSide); hand.splice(i2, 1); }
                    finalizeDraw();
                  }, lowest);
              }, lowest);
          }
        };
        // Owner first, then the rest — chained so human pick prompts never
        // collide (one seat resolves before the next is offered).
        const order = [self._2v2PlayedBy, 'p1', 'p2', 'p3', 'p4']
          .filter((k, i, a) => k && tt.players[k] && a.indexOf(k) === i);
        const run = (i) => {
          if (i >= order.length) { finish(); return; }
          const next = () => {
            if (G.hasPendingPrompt && G.hasPendingPrompt()) G.whenPromptCleared(() => run(i + 1));
            else run(i + 1);
          };
          // ONE SEAT'S FAILURE MUST NOT END THE TABLE'S TURN. The chain is
          // sequential so human pick prompts never collide, which also means a
          // throw part-way through silently strands every seat that had not gone
          // yet — the shape of "the enemy played Symbiote and only my teammate
          // redrew". Caught per seat so the cycle always reaches all four.
          try { seatShuffle(order[i], next); }
          catch (e) { console.error('[SSM] seat', order[i], 'failed to cycle', e); next(); }
        };
        run(0);
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
      const targets = G.getEnemiesOf(self.owner).filter(c => c.attack <= threshold && G.canEffectLand(c, 'destroy', { owner: self.owner, source: self }));
      if (targets.length) {
        G.promptCardChoice(self.owner, targets, "Winter Soldier — Eliminate", `Choose enemy with ${threshold} or less ATK to destroy`, (t) => {
          if (typeof UI !== 'undefined' && UI._fxWinterShot) { try { UI._fxWinterShot(self, t); } catch (e) {} }
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
      if (typeof UI !== 'undefined' && UI._fxAntiVenomHeal) { try { UI._fxAntiVenomHeal(self); } catch (e) {} }
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
              G.promptLaneChoice(self.owner, open, `Move ${ally.name}`, `Choose a new lane for ${ally.name}`, (l) => {
                G.moveCard(ally, from, l);
              }, null, null, 0, { declineLabel: 'LEAVE THEM', onDecline: () => G.log(`${ally.name} holds position.`) });
            } else {
              G.moveCard(ally, from, open[0]);
            }
          }
        };
        if (Game.isHuman(self.owner)) {
          // MAY move, not must — the card reads "you may move an ally", so the
          // prompt carries its own opt-out instead of forcing a relocation the
          // owner never wanted. Same door as Man-Bat's STAY PUT.
          G.promptCardChoice(self.owner, allies, "Anti-Venom — Move", "Choose an ally to reposition", doMove, null,
            { declineLabel: 'MOVE NO ONE', onDecline: () => G.log('Anti-Venom moves no one.') });
        } else {
          doMove(allies[0]);
        }
      }
      G.log("Anti-Venom heals you for 4!");
    }
  },
  "Black Panther": {
    onPlay(G, self, lane) {
      if (typeof UI !== 'undefined' && UI._fxBlackPantherKinetic) { try { UI._fxBlackPantherKinetic(self); } catch (e) {} }
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
          // Skip option — the free play is a GIFT, not a demand. The player
          // may be saving a cheap card (combo piece, jump body) for later.
          // User direction: "i want the player to have the option in case
          // you were saving that character."
          const skip = { name: 'Skip — Save Your Cards', _artName: 'Black Panther',
            desc: 'Play nothing for free this time. Your hand stays as it is.', _bpSkip: true };
          // inlineTray — force ALL options into the choice tray. Without it
          // the real cards are filtered out of the tray ("already visible on
          // screen" — they glow in the hand instead) and the tray shows ONLY
          // the Skip tile; players read that as the whole choice and think
          // the free play is broken. User report: "he couldn't choose which
          // 3-cost or lower card he wanted to play and could only skip."
          G.promptCardChoice(self.owner, [...freeCards, skip], "Black Panther — Free Play",
            "Choose a card with base cost 3 or less to play free — or skip", (picked) => {
              if (picked && picked._bpSkip) { G.log('Black Panther holds back — no free play.'); return; }
              playFree(picked);
            },
            cards => cards.filter(c => !c._bpSkip).slice().sort((a, b) => (b.baseCost || b.cost) - (a.baseCost || a.cost))[0],
            { inlineTray: true });
        } else {
          const best = freeCards.slice().sort((a, b) => (b.baseCost || b.cost) - (a.baseCost || a.cost))[0];
          playFree(best);
        }
      }
    },
    passive: "cardPlayedBuff"
  },
  "Ghost Rider": {
    onPlay(G, self, lane) {
      // When Played: Fear 1 a chosen enemy. AI auto-picks the highest-
      // ATK threat. The Fear ("Feared 1") badge lands on the VICTIM —
      // Ghost Rider himself carries no persistent Fear badge.
      const enemies = G.getEnemiesOf(self.owner).filter(e => e.currentHealth > 0 && !e.isFeared);
      if (!enemies.length) return;
      G.promptCardChoice(self.owner, enemies, "Ghost Rider — Penance Stare",
        "Choose an enemy to Fear 1",
        (t) => { G.fearCard(t, self); if (typeof UI !== 'undefined' && UI._fxPenanceStare) { try { UI._fxPenanceStare(self, t); } catch (e) {} } G.log(`Ghost Rider's Penance Stare terrifies ${t.name}!`); },
        cards => cards.slice().sort((a, b) => (b.attack || 0) - (a.attack || 0))[0]);
    },
    onDeath(G, self, lane) {
      // Skip the summon if the lane itself was destroyed (Anti-Life Equation / Darkseid Collapse).
      if (G.state.lanes[lane] && G.state.lanes[lane].destroyed) return;
      if (typeof UI !== 'undefined' && UI._fxGhostRiderHellfire) { try { UI._fxGhostRiderHellfire(self); } catch (e) {} }
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
        G.log(`Ghost Rider's last act: playing ${card.name} from your hand!`);
        // PLAYED, NOT SUMMONED. Owner: "that's literally his ability — just make
        // that he plays a card from hand in his place so it goes normally."
        //
        // This used to splice the card out of hand by index and rebuild it
        // through summonCard with a looked-up def. summonCard fires onPlay only
        // as a special case of its own, and reproducibly failed to: with a
        // prompt already armed at the moment Ghost Rider died — the normal
        // mid-combat state — a Luke Skywalker played this way landed with his
        // Mind Control silently gone. Not applied, not even queued.
        //
        // playCardFree is the door every other free play already walks through
        // (jumps, Mother Box, Boiler Room), so the card now gets the SAME
        // treatment as any other play: onPlay via _runOnPlayWithUndoPoint,
        // the Moder lane strip, the aura ping, trap settling, entrance FX.
        // It also owns the hand removal, which is why the manual splice is
        // gone — doing both would have dropped the card twice.
        //
        // Its guards come along too, and that is a gain rather than a cost:
        // Iron Giant can no longer be forced onto the field, an already-placed
        // card cannot be dealt into a second lane, and a sleeping card stays
        // asleep. summonCard enforced none of those.
        G.playCardFree(self.owner, card, targetLane);
      };
      if (self._cyborgChooseFromHand && Game.isHuman(self.owner)) {
        G.promptCardChoice(self.owner, eligible,
          'Ghost Rider — Replication',
          'Choose a card from your hand to summon in Ghost Rider\'s lane',
          summonChoice,
          cards => cards.slice().sort((a, b) => (b.baseCost || b.cost) - (a.baseCost || a.cost))[0]);
      } else {
        // Classic / AI path — random pick (matches the previous default
        // behavior; AI can also follow this branch for the upgraded
        // card since prompting an AI seat for a hand pick has no UX).
        const pick = eligible[Math.floor(Game.rng() * eligible.length)];
        summonChoice(pick);
      }
    }
  },
  "Deadpool": {
    // onPlay Taunt removed per balance pass. Deadpool now has no onPlay;
    // his kit is purely the onDeath face-down card swap.
    onDeath(G, self, lane) {
      if (typeof UI !== 'undefined' && UI._fxDeadpoolChaos) { try { UI._fxDeadpoolChaos(self); } catch (e) {} }
      // 2v2: choose whose hand to raid. The alias is held across the whole
      // face-down pick + trade-back chain (see withChosenOpponent), so the
      // steal and the give-back both land on the chosen player.
      const dpIs2v2 = !!(G.state.twoVTwo && G.state.twoVTwo.online);
      // Anchor to DEADPOOL'S OWN seat (his _2v2PlayedBy), not whatever seat
      // happens to be acting when he dies in combat — _2v2ActFor sets
      // _2v2CurrentActingPlayer from the card, so the whole steal + give-back
      // chain routes to the player who owns Deadpool.
      if (dpIs2v2) G._2v2ActFor(self);
      const deadpoolOwnerSeat = (dpIs2v2 && self._2v2PlayedBy) || G._2v2CurrentActingPlayer || (G._2v2ActivePlayer && G._2v2ActivePlayer());
      G.withChosenOpponent(self.owner, "Deadpool — whose hand?", (opp, victimKey) => {
      const enemyHand = G.state[opp].hand;
      // 2v2: the give-back must read/splice the DEADPOOL OWNER's own seat hand,
      // not state[self.owner].hand — during combat that side proxy is bound to
      // whichever teammate synced last, so the "trade back" was checking (and
      // giving from) the wrong hand, and often bailed with "nothing to trade
      // back". (User: "clicked the person to trade with, never got to choose the
      // face-down card, and wasn't given a choice to give anything back.")
      const ownerHand = () => {
        const dtt = G.state.twoVTwo;
        if (dpIs2v2 && deadpoolOwnerSeat && dtt && dtt.players[deadpoolOwnerSeat]) {
          return dtt.players[deadpoolOwnerSeat].hand;
        }
        return G.state[self.owner].hand;
      };
      if (!enemyHand.length) {
        G.log("Deadpool's final trick fails — the enemy has no cards in hand!");
        return;
      }
      // BOTH HALVES OR NEITHER. Owner: "if deadpool doesn't have a card to
      // trade — like the hand is empty — his ability shouldn't fire."
      // The give-back was already guarded, but only AFTER the steal had
      // resolved: you picked a face-down card, it moved into your hand, and
      // only then did the log say there was nothing to give in return. That
      // turned a TRADE into a free steal whenever your hand was empty, and it
      // made you sit through a blind pick to find out.
      // Checked here, before any prompt is raised, so the ability simply does
      // not fire. Reads the owner's hand as it stands now — the stolen card
      // joins that hand and is then excluded from the give-back, so having a
      // card to trade means having one BEFORE the steal.
      // Roguelite Text+ ("no give-back") turns Deadpool into a pure thief, and
      // a thief owes nothing — that mode skips this requirement.
      const _dpSkipGiveBack = !!self._deadpoolNoGiveBack;
      if (!_dpSkipGiveBack && !ownerHand().length) {
        G.log("Deadpool's final trick fails — he has nothing to trade back!");
        return;
      }
      // Step 1: Show enemy hand face-down, shuffled so the player can't
      // infer which card is which from positional hints.
      const faceDownDeck = enemyHand.slice();
      for (let i = faceDownDeck.length - 1; i > 0; i--) {
        const j = Math.floor(Game.rng() * (i + 1));
        [faceDownDeck[i], faceDownDeck[j]] = [faceDownDeck[j], faceDownDeck[i]];
      }
      // Roguelite Text+ override — _deadpoolNoGiveBack skips the trade
      // step entirely. Default false (classic — give one back); Text+
      // true makes Deadpool a pure card thief: steal one, no return.
      const skipGiveBack = _dpSkipGiveBack;
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
      const onStolen = (stolen) => {
          // Back to the OWNER for the trade-back decision (2v2 routing).
          if (dpIs2v2) G._2v2CurrentActingPlayer = deadpoolOwnerSeat;
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
          const myHand = ownerHand().filter(c => c.id !== stolen.id);
          if (!myHand.length) {
            G.log("Deadpool has no cards to give in return.");
            showVictimToast(stolen.name, null);
            return;
          }
          G.promptCardChoice(self.owner, myHand,
            "Deadpool's Trade",
            "Choose a card from your hand to give to the enemy",
            (given) => {
              const gHand = ownerHand();
              const gIdx = gHand.indexOf(given);
              if (gIdx >= 0) gHand.splice(gIdx, 1);
              given.owner = opp;
              G.addToHand(opp, given);
              G.log(`Deadpool slips ${given.name} into the enemy's hand!`);
              showVictimToast(stolen.name, given.name);
            },
            cards => cards.slice().sort((a, b) => (a.baseCost || a.cost) - (b.baseCost || b.cost))[0],
            // Show the give-back as the full-card TRAY (same as the Symbiote
            // Spider-Man redraw) so it is unmistakable and clickable — the plain
            // hand-highlight was easy to miss, so the trade looked like it never
            // offered. (Owner: "i could steal a card but i couldnt give one back
            // … i want the same prompt to show up to give back as the symbiote
            // spiderman redraw.")
            { inlineTray: true });
      };
      // Step 1: DEADPOOL'S OWNER blind-picks a face-down card from the chosen
      // enemy's hand — the steal is random to them (the hand is shuffled and
      // shown face-down). IDENTICAL in 1v1 and 2v2 per owner direction: "deadpool's
      // selection should work the same in 2v2 as it does in 1v1 … steal a card
      // from me and random just like 1v1 and then give me 1 back." In 2v2 the
      // prompt is routed to the Deadpool OWNER's seat (an AI owner auto-picks at
      // random via stealPicker); withChosenOpponent has already aliased the
      // chosen victim's hand onto state[opp], so faceDownDeck IS the victim's.
      const stealPicker = cards => cards[Math.floor(Game.rng() * cards.length)];
      if (dpIs2v2) G._2v2CurrentActingPlayer = deadpoolOwnerSeat;
      G.promptCardChoice(self.owner, faceDownDeck, "Deadpool's Final Trick",
        "Pick a face-down card from the enemy's hand to steal", onStolen, stealPicker, { faceDown: true });
      });
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
        if (typeof UI !== 'undefined' && UI._fxGreenLantern) { try { UI._fxGreenLantern(self); } catch (e) {} }
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
        // Once-per-game lock hit — consume the keyword charge so the generic
        // Revive path in handleDeath can't fire a second full revive behind
        // our back (double-fire class: a replayed/resurrected/copied Jason
        // carries a fresh Revive 1 that would bypass this rule). Doomsday
        // template.
        self.reviveCharges = 0;
        return; // already used this game
      }
      if (self.reviveCharges > 0) {
        // A destroyed lane blocks the revive outright — no relocation
        // (updated rule: "no card can be in a destroyed lane"). Charge and
        // once-per-game flag stay unspent; Jason dies normally.
        if (G.reviveVoided(self, lane)) return;
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
        if (typeof UI !== 'undefined' && UI._fxJasonRevive) { try { UI._fxJasonRevive(self); } catch (e) {} }
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
  "Paul Atreides": {
    onPlay(G, self, lane) {
      if (typeof UI !== 'undefined' && UI._fxPaulVision) { try { UI._fxPaulVision(self); } catch (e) {} }
      // Peeks the OWNER's pile (Classic = shared, Deckbuilder = personal).
      // (Internally still uses the "kang" prompt keys — the mechanic didn't change.)
      const pile = G.getDrawPile(self.owner);
      // Lex Luthor blocks this: Paul's keep is an explicit deck draw (it even
      // sets _kangSkipDraw, standing in for the round's normal draw), but it
      // hands the card over with addToHand() and so skipped the drawCards()
      // guard. Gate BEFORE popping so a blocked Paul disturbs nothing.
      if (!G.canDrawToHand(self.owner, 'Paul Atreides')) return;
      if (pile.length < 2) {
        G.drawCards(self.owner, Math.min(2, pile.length));
        G.log("Paul Atreides glimpses the future! Not enough cards for full effect.");
        return;
      }
      const card1 = pile.pop();
      const card2 = pile.pop();
      // 2v2 has no render/resolution path for this keep-one modal (the board
      // returns before the shared Kang render), and isHuman(side) is true for
      // BOTH teams there — so it armed the prompt + a 30s auto-pick even for an
      // AI seat, stalling the turn. Auto-pick immediately in 2v2 (keep the
      // higher-cost card — exactly what the timeout would have chosen).
      if (Game.isHuman(self.owner) && !G.is2v2()) {
        G.state.pendingKangChoice = { owner: self.owner, cards: [card1, card2], kangCard: self };
        // A silent forecast sim (previewPlacement clones the state and runs
        // onPlay to preview a placement) must NOT drive the UI or arm a real
        // prompt timer — the kept card goes to hand and never touches the board
        // the forecast measures, and every hover would otherwise re-fire this.
        // Bail once the choice is recorded on the clone.
        if (G.state && G.state._silentSim) return;
        // 1v1 online: the guest's Kang (owner==='ai') is resolved on the guest's
        // client. Broadcast the pending choice (so the guest renders/forwards it)
        // but skip the host's render + 30s auto-pick — that timeout was
        // auto-keeping a card and free-playing it into open[0] for the guest.
        // Host applies the result via _mpApplyAction promptResolve choiceType:'kang'.
        if (G.isMultiplayer() && G.mp.role === 'host' && self.owner === 'ai') {
          if (typeof G._mpBroadcast === 'function') G._mpBroadcast();
          return;
        }
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
        // Doomsday scales in the deck — apply his accumulated stats so the AI's
        // Paul keep doesn't hand him over reset to base 1/1.
        const card = G._applyDoomsdayDrawScaling(G.createCardInstance(pick, self.owner), self.owner);
        card.cost = Math.max(0, card.cost - 2);
        G.addToHand(self.owner, card, self);
        // Kang's pick counts as this round's draw — skip the end-of-round draw.
        G.state[self.owner]._kangSkipDraw = true;
        G.log(`Paul Atreides keeps ${card.name} (cost reduced to ${card.cost})`);
        if (card.cost <= 2) {
          // Environments can go in any non-destroyed lane; normal cards need an open slot.
          const open = card.isEnvironment
            ? G.state.lanes.map((l, i) => i).filter(i => !G.state.lanes[i].destroyed)
            : G.getOpenLanes(self.owner);
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
      if (typeof UI !== 'undefined' && UI._fxMartianShift) { try { UI._fxMartianShift(self); } catch (e) {} }
      const dead = allDead[Math.floor(Game.rng() * allDead.length)];

      // Copy string abilities (but keep Evade 1)
      if (dead.abilities) {
        dead.abilities.forEach(ab => { if (!self.abilities.includes(ab)) self.abilities.push(ab); });
        G.applyAbilities(self);
      }

      // Copy all callbacks and passive from CARD_ABILITIES (authoritative source)
      const abilityDef = CARD_ABILITIES[dead.name];
      if (abilityDef) {
        // Full canonical hook list — every hook name any def uses. A hook
        // missing here is a copy that silently loses part of the ability
        // (user report: Manhunter-as-Ivy charmed once then never again —
        // the once-per-round machinery wasn't copied).
        ['onPlay_SKIP', 'onDeath', 'onDamaged', 'onKill', 'onBeforeTricks',
         'onBeforeAttack', 'onBeforeCombat', 'onLaneCombat', 'onEndOfTurn', 'onAnyCardPlayed',
         'onAnyTrickPlayed', 'onAllyKilled', 'onEnemyKilled', 'onEvade',
         'onDamagePlayer', 'onTurnStart', 'onMoved', 'onDiscard',
         'onLaneResolved'].forEach(k => {
          if (k !== 'onPlay_SKIP' && abilityDef[k]) self[k] = abilityDef[k];
        });
        // Def-level flags the engine reads off the INSTANCE, not the def.
        // _recurringBT: onBeforeTricks re-fires every round (Ivy's re-charm,
        // Man-Bat's flight) — createCardInstance stamps it from the card's
        // own def, so the copy must re-stamp it from the copied def.
        if (abilityDef._recurringBT) self._recurringBT = true;
        // Mark the copy so name-keyed engine machinery (Magneto/Luke auras,
        // Ivy's death-unbuff, Stripe's jump, the charm badge) matches via
        // Game.isCardKind(card, name).
        self._copiedFrom = dead.name;
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
          if (typeof UI !== 'undefined' && UI._fxOptimusCommand) { try { UI._fxOptimusCommand(self, ally); } catch (e) {} }
          const opp = G.opponent(self.owner);
          let targets = [];
          const oppLane = G.state.lanes[lane][opp];
          if (oppLane && oppLane.currentHealth > 0) targets.push(oppLane);
          G.getAdjacentEnemiesInContext(lane, self.owner).forEach(e => { if (e.currentHealth > 0 && !targets.includes(e)) targets.push(e); });
          targets = targets.filter(t => G.canEffectLand(t, 'damage', { owner: self.owner, source: ally }));
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
      const enemies = G.getEnemiesOf(self.owner).filter(t => G.canEffectLand(t, 'damage', { owner: self.owner, source: self }));
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Predator — Strike", `Choose enemy to deal ${dmg} damage`, (t) => {
          if (typeof UI !== 'undefined' && UI.sfx) UI.sfx.playCardSfx('Predator', 'ability', self);
          if (typeof UI !== 'undefined' && UI._fxPredatorPlasma) { try { UI._fxPredatorPlasma(self, t); } catch (e) {} }
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
      if (typeof UI !== 'undefined' && UI._fxMyersStalk) { try { UI._fxMyersStalk(self); } catch (e) {} }
    },
    onDeath(G, self) { self.jumpReady = false; self.jumpLane = undefined; }
  },
  "Raven": {
    onPlay(G, self, lane) {
      if (typeof UI !== 'undefined' && UI._fxRavenSoul) { try { UI._fxRavenSoul(self); } catch (e) {} }
      const opp = G.opponent(self.owner);
      // Capture the opp's meter BEFORE zeroing so the Text+ steal path
      // can transfer it to the player. _ravenStealsBlock = true sets
      // the steal mode; default is just-drain.
      const drainedAmount = G.state[opp].blockMeter || 0;
      G.state[opp].blockMeter = 0;
      if (drainedAmount > 0) G.emitFX('blockDrain', { owner: opp, amount: drainedAmount });
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
      if (typeof UI !== 'undefined' && UI._fxGrinchGrab) { try { UI._fxGrinchGrab(self); } catch (e) {} }
      // 2v2: the Grinch's owner picks WHICH opponent gets robbed; that player
      // then picks which trick to give up. Alias is held across both prompts.
      // grinchOwnerSeat is the acting seat when the Grinch was played — the
      // keep/give-back choice belongs to it; the trick pick belongs to the victim.
      const grinchOwnerSeat = G._2v2CurrentActingPlayer || (G._2v2ActivePlayer && G._2v2ActivePlayer());
      G.withChosenOpponent(self.owner, 'The Grinch — whose tricks?', (opp, victimKey) => {
      const th = G.state[opp].trickHand;
      if (!th.length) {
        // No tricks to steal — triple stats
        self.attack *= 3; self.currentHealth *= 3; self.maxHealth *= 3;
        G.log(`The Grinch finds nothing to steal — stats tripled! ${self.attack}/${self.currentHealth}`);
        return;
      }
      // A FULL TRICK HAND IS THE SAME AS NOTHING TO STEAL.
      // User report: "i had 3 tricks already in hand, the enemy had 1, i chose
      // to steal the trick, it didn't let me." What actually happened is worse
      // than "didn't let me": keep() called addToTrickHand, which returns false
      // and DISCARDS when the hand is at maxTrickHandSize — so the opponent
      // lost the trick, the Grinch's owner never received it, and the Grinch
      // did not triple either. The trick was destroyed by a prompt that had no
      // valid outcome.
      // With a full hand, "keep" is unreachable, so the pick has exactly one
      // outcome — and a one-outcome pick auto-resolves rather than being asked
      // (the same forced-choice rule Galactus and the PICK-N abilities follow).
      // Both prompts are skipped: whichever trick the opponent picked would be
      // handed straight back, so the steal is a no-op and only the triple
      // remains. Checked against the OWNER's hand, not the victim's.
      const gp = G.state[self.owner];
      if (gp.trickHand.length >= gp.maxTrickHandSize) {
        self.attack *= 3; self.currentHealth *= 3; self.maxHealth *= 3;
        G.log(`The Grinch's trick hand is full (${gp.maxTrickHandSize}) — nothing he can carry off, stats tripled! ${self.attack}/${self.currentHealth}`);
        return;
      }
      // Two choices in sequence, each gated on a different seat's isHuman:
      //   1. OPP picks which trick to give up (human → prompt; AI → lowest cost)
      //   2. Grinch OWNER picks keep-or-give-back (human → prompt; AI → threshold)
      const resolveGrinchChoice = (chosen) => {
        // Back to the OWNER for the keep/give-back decision (the victim only
        // chose which trick to surrender).
        if (G.state.twoVTwo && G.state.twoVTwo.online) G._2v2CurrentActingPlayer = grinchOwnerSeat;
        // Remove the EXACT object that was chosen, not the first same-named
        // one — decks can hold 2 copies of a trick (COPY_MAX=2), and a
        // name-based findIndex would splice the wrong copy when they differ in
        // mutated state. Matches the identity pattern used everywhere else
        // (Deadpool indexOf(stolen), game.js trick removal indexOf(trick)).
        const idx = th.indexOf(chosen);
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
          // addToTrickHand DISCARDS and returns false on a full hand. Never let
          // that silently destroy the trick — hand it back and take the triple
          // instead. The early return above covers the normal case; this covers
          // the AI-owner branch and any hand that fills between check and
          // resolve (a queued prompt can resolve much later than it armed).
          if (!G.addToTrickHand(self.owner, chosen)) { giveBack(); return; }
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
        // In 2v2 both sides read as "human", so an AI-owned Grinch would enter
        // the modal branch and strand on this DIRECT prompt (no aiPicker to
        // auto-resolve it). Treat an AI owner seat as non-human here.
        const grinchOwnerIsAI = !!(G.state.twoVTwo && G.state.twoVTwo.online && grinchOwnerSeat && G._2v2SeatIsAI(grinchOwnerSeat));
        if (Game.isHuman(self.owner) && !grinchOwnerIsAI) {
          // Human Grinch owner picks keep-or-giveback via modal
          G.state.pendingCardChoice = {
            owner: self.owner,
            // 2v2: this keep/give-back choice belongs to the Grinch's owner seat.
            _2v2ActingPlayer: (G.state.twoVTwo && G.state.twoVTwo.online) ? grinchOwnerSeat : undefined,
            cards: [
              // _artName paints the stolen trick's real card face on the tile
              // (purple trick chrome via the tray's TRICK_DEFS check); cost gem
              // shows what it will actually cost after the keep bump.
              { name: `Keep ${chosen.name}`, _artName: chosen.name, _isTrick: true,
                cost: Math.max(0, chosen.cost + keepBump),
                desc: keepBump > 0
                ? `Add to your tricks (cost +${keepBump}, becomes ${chosen.cost + keepBump})`
                : keepBump < 0
                  ? `Add to your tricks at reduced cost (${Math.max(0, chosen.cost + keepBump)})`
                  : `Add to your tricks at the same cost (${chosen.cost}) — free!`, _action: 'keep' },
              { name: "Give it back", _artName: 'The Grinch',
                desc: "Return the trick — Grinch's stats triple!", _action: 'giveback' }
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
      // The VICTIM chooses which trick to give up — in 2v2 route the prompt to
      // THEIR seat so the Grinch's owner can't pick for them (an AI victim
      // auto-resolves via the lowest-cost picker). Stamp the acting player to
      // the victim for the duration of arming this prompt.
      if (G.state.twoVTwo && G.state.twoVTwo.online && victimKey) G._2v2CurrentActingPlayer = victimKey;
      const lowestCost = (list) => [...list].sort((a, b) => a.cost - b.cost)[0];
      if (Game.isHuman(opp)) {
        G.promptCardChoice(opp, [...th], "The Grinch — Steal", "The Grinch is stealing! Choose a trick to give up", resolveGrinchChoice, lowestCost);
      } else {
        // Solo AI opp auto-picks lowest cost to minimize value lost
        resolveGrinchChoice(lowestCost([...th]));
      }
      }, { showTricks: true });
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
          if (typeof UI !== 'undefined' && UI._fxSymbioteLash) { try { UI._fxSymbioteLash(self, e); } catch (er) {} }
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
      if (attacker && (attacker.baseCost || attacker.cost) <= threshold) {
        if (typeof UI !== 'undefined' && UI._fxWolverineClaws) { try { UI._fxWolverineClaws(self, attacker); } catch (e) {} }
        G.killCard(attacker, self); G.log(`Wolverine slays ${attacker.name}!`);
      }
    },
    onDeath(G, self, lane) {
      if (self.reviveCharges > 0) {
        if (G.reviveVoided(self, lane)) return;
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
        if (typeof UI !== 'undefined' && UI._fxWolverineRage) { try { UI._fxWolverineRage(self); } catch (e) {} }
        G.log(`Wolverine revives as 6/5 Overdrive! Berserker rage spent — no retaliation. (Revive ${self.reviveCharges} left)`);
        return true;
      }
    }
  },
  "Wonder Woman": {
    onPlay(G, self, lane) {
      // Roguelite Text+ — _wwStunSize scales the freeze duration. Default
      // 1 (classic); Text+ sets 2. (Stun merged into Freeze 2026-07-24.)
      const freezeN = self._wwStunSize || 1;
      const e = G.state.lanes[lane] ? G.state.lanes[lane][G.opponent(self.owner)] : null;
      if (e) { G.freezeCard(e, self, freezeN); }
      if (typeof UI !== 'undefined' && UI._fxWonderWomanLasso) { try { UI._fxWonderWomanLasso(self, e); } catch (err) {} }
      // _wonderWomanBlockGain scales the block meter add. Default 2
      // (classic); Text+ bumps to 4.
      const blockGain = self._wonderWomanBlockGain || 2;
      G.state[self.owner].blockMeter = Math.min(Game.BLOCK_MAX, G.state[self.owner].blockMeter + blockGain);
      G.log(`Wonder Woman Freezes ${e ? e.name : 'nothing'} (${freezeN}) and adds ${blockGain} Block Meter!`);
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
      // ...and only if that swing actually CONNECTS. If the front target
      // Evades / is Invincible / Damage-Immune, Wonder Woman's whole strike
      // (lasso included) whiffs. (User: "WW attacks Spider-Man, he evades,
      // she can't chain.") Armor doesn't block the chain — the hit still lands.
      const canDodge = !target.isStunned && !target.isFrozen && !self.ignoresEvade;
      if (G._classifyAbsorb(target, canDodge)) return;
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
      // ONE chained enemy, not the whole consecutive run (owner call). She still
      // picks left or right when both sides have a body — the direction is the
      // decision, the chain just stops after the first one.
      G.log(`Wonder Woman's lasso chains — ${chainDmg} chain damage!`);
      G.autoChainDamage(self.owner, myLane, chainDmg, 0, null, "LASSO CHAIN", 1);
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
      if (typeof UI !== 'undefined' && UI._fxDavyKraken) { try { UI._fxDavyKraken(self); } catch (e) {} }
      G.summonCardChoice(self.owner, "The Kraken", 4, 5 + atkBump, 6 + hpBump, []);
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
        if (typeof UI !== 'undefined' && UI._fxCapShield) { try { UI._fxCapShield(self, a); } catch (e) {} }
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
          if (typeof UI !== 'undefined' && UI._fxIronManRepulsor) { try { UI._fxIronManRepulsor(self, t); } catch (e) {} }
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
            if (typeof UI !== 'undefined' && UI._fxFearGas) { try { UI._fxFearGas(t); } catch (e) {} }
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
      // EVERYWHERE, not just the board. This swept getAllCardsOnBoard(), so a
      // victim that happened to be off-board at the instant Joker died — in the
      // dead pile, mid-revive, bounced to hand — kept the stamp with nothing
      // alive left to clear it. Mahoraga hit this constantly because dying and
      // coming back IS his card.
      G._allCardsAnywhere().forEach(c => {
        if (c._crazyAppliedBy) {
          const wasAtk = c.attack;
          const restoreTo = (c._preCrazyAttack != null) ? c._preCrazyAttack : (c.baseAttack || c.attack);
          G._stripStampedCrazy(c);
          G.log(`  [CRAZY] ${c.name} is no longer Crazy — ATK restored ${wasAtk} → ${restoreTo}.`);
          delete c._lastCrazyRoll;
        }
      });
    },
    _stampTopEnemyCrazy(G, self) {
      // Feared enemies can never hold Crazy (user spec) — they're skipped
      // outright so the stamp falls to the next-highest eligible enemy
      // instead of silently whiffing inside applyCrazyToCard.
      const enemies = G.getAllCardsOf(G.opponent(self.owner))
        .filter(e => e.currentHealth > 0 && !e.isEnvironment
          && !e.isFeared && !((e.fearedTurns || 0) > 0));
      if (!enemies.length) return;
      // Rank by EFFECTIVE attack, not current. A card that already carries
      // Joker's Crazy has its ATK suppressed to a 1-4 roll, so ranking on the
      // live value let a genuinely weaker enemy outscore the real top threat and
      // steal the stamp every round (user: "Manhattan has 9 ATK — the highest —
      // but Crazy jumped off him onto Luke"). For the current Crazy target we
      // read its pre-Crazy snapshot so it's compared at true strength; everyone
      // else uses their live ATK.
      const effAtk = (c) => (c.isCrazy && c._preCrazyAttack != null)
        ? c._preCrazyAttack : (c.attack || 0);
      const top = enemies.slice().sort((a, b) => effAtk(b) - effAtk(a))[0];
      if (!top) return;
      if (top.isCrazy) return; // already the stamped target — sweep rerolls it
      // EXCLUSIVE stamp — exactly ONE enemy carries Joker's Crazy. The old
      // code never un-stamped the previous target, so every past top-ATK
      // enemy kept its badge and the debuff accumulated across the board
      // (user: "I'm not sure the crazy status badge is being applied
      // correctly"). Strip + restore the old target before re-stamping;
      // the stamp then rolls over round-to-round until this re-check moves it.
      G.getAllCardsOnBoard().forEach(c => {
        if (c._crazyAppliedBy && c.id !== top.id) {
          c.isCrazy = false;
          delete c._crazyAppliedBy;
          const restoreTo = (c._preCrazyAttack != null) ? c._preCrazyAttack : (c.baseAttack || c.attack);
          G.setTrueAttack(c, restoreTo);
          delete c._preCrazyAttack;
          delete c._lastCrazyRoll;
          G.log(`  [CRAZY] The stamp moves on — ${c.name} recovers.`);
        }
      });
      G.applyCrazyToCard(top);
      G.log(`Joker's chaos stamps Crazy on ${top.name}!`);
    }
  },
  "Lex Luthor": {
    passive: "preventDraw"
  },
  "Professor X": {
    isDiscardEffect: true,
    // Pre-play gate — read by playCard's discard branch BEFORE the card and
    // energy are consumed. Prof X needs BOTH a convertible enemy AND an open
    // lane on the caster's side to place the convert. With a full board the
    // old flow consumed the card, lifted the target off its lane, found no
    // space, and stranded it in limbo (user MP report: "played Prof X on
    // Grinch but his board was full — the Grinch just [vanished]; Prof X
    // can't be played when there's no space").
    canDiscard(G, owner, self) {
      const maxCost = (self && self._profXConvertCost) || 4;
      const hasTarget = G.getEnemiesOf(owner).some(e => (e.baseCost != null ? e.baseCost : e.cost) <= maxCost);
      const hasSpace = G.getOpenLanes(owner).length > 0;
      if (self) {
        self._discardBlockReason = !hasTarget
          ? `No convertible enemy (base cost ≤ ${maxCost})`
          : 'No open lane on your side to place the convert';
      }
      return hasTarget && hasSpace;
    },
    onDiscard(G, owner, self) {
      const opp = G.opponent(owner);
      // Roguelite Text+ override — _profXConvertCost raises the cost
      // ceiling for convertible enemies. Default 4 (classic); Text+
      // to 6 so even Iron Man / Captain America are valid targets.
      const maxCost = (self && self._profXConvertCost) || 4;
      const enemies = G.getEnemiesOf(owner).filter(e => (e.baseCost != null ? e.baseCost : e.cost) <= maxCost);
      if (!enemies.length) return;
      G.promptCardChoice(owner, enemies, "Professor X — Convert", `Choose enemy with base cost ${maxCost} or less to permanently join your team`, (t) => {
        // Re-check space at RESOLVE time (a lane can fill while the prompt is
        // open) and BEFORE the target is lifted off its lane. The old order
        // removed it, flipped its owner, then discovered no open lane and
        // returned — leaving the card in limbo: off-board, in no hand, no pile.
        if (!G.getOpenLanes(owner).length) {
          G.log(`[PROF X] No open lane to place ${t.name} — the conversion fizzles; ${t.name} stays put.`);
          return;
        }
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
          if (abilityDef.onMoved) t.onMoved = abilityDef.onMoved;
          if (abilityDef.onBeforeAttack) t.onBeforeAttack = abilityDef.onBeforeAttack;
          if (abilityDef.onEndOfTurn) t.onEndOfTurn = abilityDef.onEndOfTurn;
          if (abilityDef.onAnyCardPlayed) t.onAnyCardPlayed = abilityDef.onAnyCardPlayed;
          if (abilityDef.onAllyKilled) t.onAllyKilled = abilityDef.onAllyKilled;
          if (abilityDef.onEnemyKilled) t.onEnemyKilled = abilityDef.onEnemyKilled;
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
        if (typeof UI !== 'undefined' && UI._fxProfessorX) { try { UI._fxProfessorX(t); } catch (e) {} }
        const open = G.getOpenLanes(owner);
        if (!open.length) return;
        G.promptLaneChoice(owner, open, `Place ${t.name}`, `Choose a lane for ${t.name}`, (l) => {
          G.state.lanes[l][owner] = t;
          G.log(`${t.name} joins your side in lane ${l + 1}!`);
          // Entering a lane by ANY mechanism must spring a waiting Bear Trap —
          // this direct assignment bypassed checkLaneTrap, so a converted card
          // placed onto an enemy Jigsaw trap sailed in unharmed. User report:
          // "played Prof X on Man-Bat, then placed Man-Bat in a Jigsaw trap
          // and it didn't trigger." Also reconcile Magneto's parity aura for
          // the lane he landed in.
          G.checkLaneTrap(t, l);
          G.applyMagnetoDebuffs();
          if (t.currentHealth <= 0) { G.cleanupDead(); return; }  // trap killed the arrival
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
          G.broadcastHook('onAnyCardPlayed', t, []);
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
        G.splashDamage(lane, self.owner, dmg, self);
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
          if (typeof UI !== 'undefined' && UI.sfx) UI.sfx.playCardSfx('Spider-Man', 'ability', self);
          if (typeof UI !== 'undefined' && UI._fxSpiderWeb) { try { UI._fxSpiderWeb(self, t); } catch (e) {} }
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
      if (Game.rng() < regain) {
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
      if (typeof UI !== 'undefined' && UI._fxBWLHex) { try { UI._fxBWLHex(self); } catch (e) {} }
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
        const _helaWarriors = [];
        for (let i = 0; i < openLanes.length && i < zombies; i++) {
          G.summonCard(self.owner, openLanes[i], "Undead Warrior", 1, 3, 1, []);
          if (G.state.lanes[openLanes[i]]) _helaWarriors.push(G.state.lanes[openLanes[i]][self.owner]);
        }
        if (typeof UI !== 'undefined' && UI._fxHelaRaise) { try { UI._fxHelaRaise(self, _helaWarriors); } catch (e) {} }
        return;
      }
      // More open lanes than warriors → meaningful placement
      // choices remain; use the prompt chain.
      let summonCount = 0;
      const doSummon = () => {
        summonCount++;
        if (summonCount < zombies) {
          G.summonCardChoice(self.owner, "Undead Warrior", 1, 3, 1, [], doSummon);
        }
      };
      if (typeof UI !== 'undefined' && UI._fxHelaRaise) { try { UI._fxHelaRaise(self, []); } catch (e) {} }
      G.summonCardChoice(self.owner, "Undead Warrior", 1, 3, 1, [], doSummon);
    },
    // WHEN DESTROYED — the dead-pile draw, moved here from her On Play.
    // Owner: "make hela's draw just like solomon grundy when she dies." Built
    // to match Grundy's onDeath deliberately: the same shared pile (both sides'
    // dead piles concatenated), the same canDrawToHand gate so Lex Luthor
    // blocks it — addToHand bypasses the drawCards() guard, which is why the
    // check has to be explicit — and the same one-card-per-pull loop. Her count
    // still scales with rarity, which is the one thing she keeps over Grundy's
    // flat 1.
    onDeath(G, self, lane) {
      const pulls = G.rarityValue(self, { common: 1, rare: 1, special: 2, legendary: 2 });
      if (!G.canDrawToHand(self.owner, 'Hela')) return;
      for (let i = 0; i < pulls; i++) {
        const pDead = G.state.player.deadPile || [];
        const aDead = G.state.ai.deadPile || [];
        if (!pDead.length && !aDead.length) break;
        const idx = Math.floor(Game.rng() * (pDead.length + aDead.length));
        const card = idx < pDead.length
          ? pDead.splice(idx, 1)[0]
          : aDead.splice(idx - pDead.length, 1)[0];
        const drawn = G.createCardInstance(card, self.owner);
        drawn._drawnBy = self;
        G.addToHand(self.owner, drawn, self);
        G.log(`Hela's death draws ${card.name} from the dead pile!`);
      }
    }
  },
  "Homelander": {
    onPlay(G, self, lane) {
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id).sort((a, b) => a.cost - b.cost);
      if (!allies.length) return;

      // Per-mode targeting through the canonical gate instead of a hand-rolled
      // filter. The old one excluded anything with evadeCharges > 0 from BOTH
      // modes, which is wrong twice over:
      //
      //   DESTROY — canEffectLand('destroy') is blocked by Invincible and
      //   nothing else. Evade dodges an ATTACK; it has no say in a destroy
      //   effect, and the card text ("destroy an enemy with cost <= that ally's
      //   cost") does not mention it. This is the reported bug: Predator has
      //   Evade 1, so a 4-cost sacrifice could destroy 4-cost Jason but not
      //   4-cost Predator.
      //
      //   DAMAGE — Evade should ABSORB the hit and spend a charge when it
      //   lands, which dealDamage already does. Removing the card from the
      //   list entirely made it untargetable, a rule no other ability applies.
      //
      // The gate also catches what the hand-rolled version missed: environments,
      // face-down cards, already-dead cards and 10-cost source immunity.
      const enemiesFor = (kind) => G.getEnemiesOf(self.owner)
        .filter(e => G.canEffectLand(e, kind, { owner: self.owner, source: self }));
      const damageableEnemies = () => enemiesFor('damage');
      const destroyableEnemies = () => enemiesFor('destroy');

      // AI evaluator — for each ally, find the best Damage and Destroy trade.
      // Destroy bypasses HP/armor entirely so it's higher value when an enemy
      // matches the cost gate. Damage is the fallback when no destroy target
      // exists at the ally's cost. Returns { ally, mode, enemy, score } or null.
      const findBestTrade = (threshold) => {
        const dmgTgts = damageableEnemies();
        const destTgts = destroyableEnemies();
        if (!dmgTgts.length && !destTgts.length) return null;
        let best = null, bestScore = -Infinity;
        for (const ally of allies) {
          const d = ally.baseCost || ally.cost || 0;
          // Destroy: any enemy with cost ≤ ally cost. No HP/armor check needed.
          const destroyTargets = destTgts.filter(e => (e.baseCost || e.cost || 0) <= d);
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
          const damageKills = dmgTgts.filter(e => (e.currentHealth + (e.armorValue || 0)) <= d);
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
        if (typeof UI !== 'undefined' && UI._fxHomelanderLaser) { try { UI._fxHomelanderLaser(self, trade.enemy); } catch (e) {} }
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
          const validDestroyTargets = destroyableEnemies()
            .filter(e => (e.baseCost || e.cost || 0) <= dmg);
          // Bail only when NEITHER mode has a target — an enemy that is
          // destroyable but not damageable (Damage Immunity) still deserves the
          // prompt, and the old early-return on the damage list alone threw the
          // whole ability away in that case.
          if (!enemies.length && !validDestroyTargets.length) return;
          const modeChoices = [];
          if (enemies.length) modeChoices.push(damageOpt);
          if (validDestroyTargets.length) modeChoices.push(destroyOpt);
          G.promptCardChoice(self.owner, modeChoices,
            "Homelander — Strike Mode", `Choose how to spend ${victim.name}'s sacrifice`,
            (modeChoice) => {
              if (modeChoice._hlMode === 'destroy') {
                G.promptCardChoice(self.owner, validDestroyTargets, "Homelander — Destroy", `Destroy which enemy (cost ≤ ${dmg})?`, (target) => {
                  if (typeof UI !== 'undefined' && UI._fxHomelanderLaser) { try { UI._fxHomelanderLaser(self, target); } catch (e) {} }
                  G.killCard(target, self);
                  G.log(`Homelander sacrifices ${victim.name} — destroys ${target.name}!`);
                }, cards => cards.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0]);
                return;
              }
              G.promptCardChoice(self.owner, enemies, "Homelander — Damage", `Deal ${dmg} damage to which enemy?`, (target) => {
                if (typeof UI !== 'undefined' && UI._fxHomelanderLaser) { try { UI._fxHomelanderLaser(self, target); } catch (e) {} }
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
      // Hulk's Splash always equals his LIVE ATK — flag it so buffCard/debuffCard
      // keep splashRange synced whenever anything (Pym Particles, Nightwing,
      // auras, his own +1/+1 rage) changes his attack, so the badge + combat
      // forecast never lag behind (e.g. Pym drops him to 1 ATK → Splash 1).
      self._splashTracksAtk = true;
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
      if (hit.length) {
        G.log(`Hulk SMASH! Deals ${smashDmg} damage to all enemies: ${hit.join(', ')}!`);
        if (typeof UI !== 'undefined' && UI._fxHulkSmash) { try { UI._fxHulkSmash(self); } catch (e) {} }
      }
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
      G.buffCard(self, 1, 2);
      self.splashRange = self.attack;
      G.log(`Hulk rages! +1/+2, Splash now ${self.splashRange}`);
      if (typeof UI !== 'undefined' && UI._fxHulkRage) { try { UI._fxHulkRage(self); } catch (e) {} }
    }
  },
  "Magneto": {
    onPlay(G, self, lane) {
      // Magneto's magnetism REPOSITIONS the board. On entry he hurls 2 cards
      // (ally OR enemy) into new lanes; his While-Active aura (see
      // Game.applyMagnetoDebuffs) then punishes enemies in EVEN lanes (-1/-1)
      // and empowers allies in ODD lanes (+1/+1). Moving is the setup — shove
      // an enemy into an even lane, or pull an ally into an odd one — so the
      // two halves of the kit combo.
      const MOVE_COUNT = 2;
      G.log("Magneto seizes the battlefield — repositioning cards with magnetic force!");
      const opp = G.opponent(self.owner);
      const moved = [];
      const openLanesFor = (c) => {
        const from = G.findCardLane(c);
        const lanes = [];
        for (let i = 0; i < Game.LANE_COUNT; i++) {
          if (i !== from && !G.state.lanes[i][c.owner] && !G.state.lanes[i].destroyed) lanes.push(i);
        }
        return lanes;
      };
      // Any living combat card except Magneto himself that can actually move
      // (not frozen/stunned) and has an open lane on its own side to slide into.
      const candidates = () => [...G.getAlliesOf(self.owner), ...G.getEnemiesOf(self.owner)]
        // findCardLane >= 0 as well as HP > 0: getAlliesOf/getEnemiesOf read
        // the lane slots and do NOT filter the dead, so a card killed earlier
        // in this same resolution — Magneto's own parity aura does this, and
        // so does anything that ran before cleanupDead — could still be listed
        // and OFFERED. finishMove already refuses to move a corpse, but the
        // player was being shown one as a choice. User: "magneto shouldn't
        // move dead cards like the grinch."
        .filter(c => c && c !== self && c.currentHealth > 0 && G.findCardLane(c) >= 0
                     && !c.isFrozen && !c.isStunned
                     && !moved.includes(c) && openLanesFor(c).length > 0);
      // AI: shove an enemy into an even lane (-1/-1) or pull an ally into an odd
      // lane (+1/+1); prefer acting on the beefiest card available.
      const aiPick = (pool) => {
        let best = null;
        pool.forEach(c => {
          const isEnemy = c.owner === opp;
          const power = (c.attack || 0) + (c.currentHealth || 0);
          openLanesFor(c).forEach(l => {
            let s = 0;
            const even = (l + 1) % 2 === 0;
            if (isEnemy && even) s += 4;
            if (!isEnemy && !even) s += 4;
            s += isEnemy ? power * 0.15 : power * 0.05;
            if (!best || s > best.score) best = { card: c, lane: l, score: s };
          });
        });
        return best;
      };
      const finishMove = (target, to) => {
        // RE-VALIDATE AT THE MOMENT OF THE MOVE. The pool is filtered for
        // currentHealth > 0 when the picker opens, but each completed move runs
        // moveCard -> applyMagnetoDebuffs -> recomputeAuras, and Magneto's own
        // parity aura can KILL an enemy it pushes into an even lane. Between
        // choosing a card and the move landing there are two separate player
        // interactions, so the target can die in between — and the sim cannot
        // show this, because its shim resolves prompts synchronously.
        // Without the check, moveCard is handed a corpse whose findCardLane is
        // already -1. User: "magneto is forced to move a person he killed with
        // his passive."
        const from = G.findCardLane(target);
        if (!target || target.currentHealth <= 0 || from < 0) {
          // The target died before the move landed — Magneto's OWN parity aura
          // does this when a prior move shoves an enemy into an even lane. Do
          // NOT count it: re-run step() to offer another LIVING card so Magneto
          // still gets his full two moves. candidates() already excludes the
          // dead (currentHealth > 0), so it can never be re-offered — no loop,
          // no consumed slot. (User: "if you kill an enemy card because of his
          // lane manipulation the game makes you waste a move on a dead
          // character … so he doesnt waste his 2 moves.")
          G.log(`  [MAGNETO] ${target && target.name ? target.name : 'That card'} is already gone — Magneto reaches for another.`);
          step();
          return;
        }
        // The destination can also have been taken or destroyed while choosing.
        const destLane = G.state.lanes[to];
        if (!destLane || destLane.destroyed || destLane[target.owner]) {
          G.log(`  [MAGNETO] Lane ${to + 1} is no longer free — ${target.name} stays put.`);
          moved.push(target);
          step();
          return;
        }
        G.moveCard(target, from, to);
        if (typeof UI !== 'undefined' && UI._fxMagnetoHurl) { try { UI._fxMagnetoHurl(self, target, to, target.owner); } catch (e) {} }
        G.log(`Magneto hurls ${target.name} into lane ${to + 1}!`);
        moved.push(target);
        step();
      };
      const step = () => {
        if (moved.length >= MOVE_COUNT) { G.applyMagnetoDebuffs(); return; }
        const pool = candidates();
        if (!pool.length) { G.applyMagnetoDebuffs(); return; }
        if (Game.isHuman(self.owner)) {
          // ONE CANDIDATE IS NOT A CHOICE, AND IT WAS BEING TAKEN FOR YOU.
          // promptCardChoice skips the tray entirely for a single-option list,
          // so once Magneto's own aura thinned the board — which it does, since
          // every move re-runs it and can kill what it shoves into an even lane
          // — the last move resolved with no say at all. Offer it instead.
          // Deliberately ONLY at 1: with two or more real options the move
          // stays mandatory, because then it IS a decision.
          if (pool.length === 1) {
            const only = pool[0];
            G.promptCardChoice(self.owner, [
              { name: `Move ${only.name}`, desc: `Relocate ${only.name} to another lane.`, id: 'mag_move' },
              { name: 'Skip', desc: 'Leave the board where it stands.', id: 'mag_skip' },
            ], 'Magneto — Move a Card',
              `${only.name} is the only card left that can be moved (${moved.length + 1} of ${MOVE_COUNT}).`,
              (pick) => {
                if (!pick || pick.id === 'mag_skip') { G.applyMagnetoDebuffs(); return; }
                const lanes = openLanesFor(only);
                if (!lanes.length) { G.applyMagnetoDebuffs(); return; }
                G.promptLaneChoice(self.owner, lanes, `Magneto — Move ${only.name}`,
                  `Choose a new lane for ${only.name}`, (to) => finishMove(only, to), only.owner);
              },
              cards => cards[0]);
            return;
          }
          G.promptCardChoice(self.owner, pool, "Magneto — Move a Card",
            `Choose any card to relocate (${moved.length + 1} of ${MOVE_COUNT})`,
            (target) => {
              // Re-check on RESOLVE, not just when the tray opened — there are
              // two separate interactions between picking a card and the move
              // landing, and the target can die in between.
              if (!target || target.currentHealth <= 0 || G.findCardLane(target) < 0) {
                G.log(`  [MAGNETO] ${target && target.name ? target.name : 'That card'} is already gone — choosing again.`);
                step(); return;
              }
              const lanes = openLanesFor(target);
              if (!lanes.length) { step(); return; }
              G.promptLaneChoice(self.owner, lanes, `Magneto — Move ${target.name}`,
                `Choose a new lane for ${target.name}`, (to) => finishMove(target, to), target.owner);
            },
            cards => { const p = aiPick(cards); return p ? p.card : cards[0]; });
        } else {
          const pick = aiPick(pool) || { card: pool[0], lane: openLanesFor(pool[0])[0] };
          finishMove(pick.card, pick.lane);
        }
      };
      step();
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
      if (typeof UI !== 'undefined' && UI._fxObiReflect) { try { UI._fxObiReflect(self, attacker); } catch (e) {} }
      G.dealDamage(attacker, reflectDmg, self);
      self._obiWanReflecting = false;
    },
    onDeath(G, self, lane) {
      const e = G.state.lanes[lane] ? G.state.lanes[lane][G.opponent(self.owner)] : null;
      if (e && e.attack > 0) {
        // Credit Obi-Wan with prevented damage BEFORE zeroing — phantom
        // swing reads current attack, so it needs the pre-zero value.
        G._simulatePhantomSwing(self, e);
        G._suppressAttack(e, '_obiWanAttackZeroed');
        if (typeof UI !== 'undefined' && UI._fxObiOneWithForce) { try { UI._fxObiOneWithForce(self, e); } catch (err) {} }
        G.log(`Obi-Wan's final lesson — ${e.name} cannot attack for the rest of this combat phase!`);
      } else if (typeof UI !== 'undefined' && UI._fxObiOneWithForce) {
        try { UI._fxObiOneWithForce(self, null); } catch (err) {}
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
      if (typeof UI !== 'undefined' && UI._fxUltronReplicate) {
        const _reps = [];
        if (open.length >= 1 && G.state.lanes[open[0]]) _reps.push(G.state.lanes[open[0]][self.owner]);
        if (open.length >= 2 && G.state.lanes[open[open.length - 1]]) _reps.push(G.state.lanes[open[open.length - 1]][self.owner]);
        try { UI._fxUltronReplicate(_reps); } catch (e) {}
      }
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
        if (typeof UI !== 'undefined' && UI._fxDoomConjure) { try { UI._fxDoomConjure(self); } catch (e) {} }
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
        cards => cards.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0))[0],
        { forcePrompt: true }  // always show the tray even with 1 dead card
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
        // NOWHERE TO MOVE THEM = DO NOT ASK. The destination set is the same
        // for every candidate (enemy-side lanes that are empty and not
        // destroyed), so if it is empty this prompt cannot lead anywhere. It
        // used to ask anyway, burn the full choice timer, then log "No open
        // lanes" and move on — user report: a board with all six enemy lanes
        // occupied still popped "Gojo — Move Enemy" with a 23s countdown.
        if (!G.getOpenLanes(opp).length) {
          G.log('Gojo finds no open lane to move an enemy into — skipping.');
          afterMove();
          return;
        }
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
              G._suppressAttack(e, '_gojoAttackZeroed', '_gojoZeroedBy', self.id);
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
        // Gives back what it took, so a buff that landed while the card was
        // nullified survives the restore — see _restoreSuppressedAttack.
        G._restoreSuppressedAttack(c, '_gojoAttackZeroed', '_gojoZeroedBy', self.id);
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
      // THREE RANDOM LANES. Was opposite-parity, which is also exactly three
      // lanes (1/3/5 or 2/4/6) — so this keeps the reach identical and only
      // makes WHICH three unpredictable. Owner: "have gojo when he purples
      // destroy 3 random lanes."
      // Parity was learnable: put your board on Gojo's own parity and Hollow
      // Purple hit nothing. Random cannot be dodged by placement, which is the
      // point of a card that erases things.
      // G.rng(), never Math.random — the match seed drives replay and fuzz, and
      // an unseeded call desyncs host and guest into different results.
      const LANES = [];
      for (let i = 0; i < Game.LANE_COUNT; i++) LANES.push(i);
      for (let i = LANES.length - 1; i > 0; i--) {
        const j = Math.floor(G.rng() * (i + 1));
        const t = LANES[i]; LANES[i] = LANES[j]; LANES[j] = t;
      }
      const picked = LANES.slice(0, 3).sort((a, b) => a - b);
      G.log(`Gojo activates Hollow Purple! Erasing lanes ${picked.map(i => i + 1).join(', ')}!`);
      for (const i of picked) {
        const e = G.state.lanes[i][opp];
        if (e && e.currentHealth > 0) {
          if (typeof UI !== 'undefined' && UI._fxHollowPurple) { try { UI._fxHollowPurple(self, e); } catch (er) {} }
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
      const killed = { player: null, ai: null };
      if (typeof UI !== 'undefined' && UI._fxNecrosword) { try { UI._fxNecrosword(self); } catch (e) {} }
      // 2v2: the God-Butcher hits the WHOLE table — every one of the four seats
      // loses their highest-cost card (not just the enemy's), then Gorr summons.
      // A per-seat banner shows exactly what everyone lost.
      if (G.is2v2 && G.is2v2() && G.state.twoVTwo) {
        const tt = G.state.twoVTwo;
        const ownerSeat = self._2v2PlayedBy || G._2v2CurrentActingPlayer || (G._2v2ActivePlayer && G._2v2ActivePlayer());
        const ownerTeam = ownerSeat && tt.players[ownerSeat] ? tt.players[ownerSeat].team : null;
        const bySeat = {};
        G._2v2SLOTS.forEach(pk => {
          const p = tt.players[pk];
          if (!p || !Array.isArray(p.hand) || !p.hand.length) return;
          if (enemyOnly && ownerTeam && p.team === ownerTeam) return;   // Text+ punitive variant
          let idx = 0;
          for (let i = 1; i < p.hand.length; i++) if ((p.hand[i].cost || 0) > (p.hand[idx].cost || 0)) idx = i;
          const [devoured] = p.hand.splice(idx, 1);
          bySeat[pk] = { name: devoured.name, cost: devoured.cost };
          G.state.voidPile.push({ name: devoured.name, cost: devoured.cost });
          G.log(`Gorr devours ${devoured.name} (cost ${devoured.cost}) from ${p.name}'s hand!`);
        });
        if (Object.keys(bySeat).length) {
          G.state._gorrBanner = { bySeat, at: Date.now() };
          if (typeof UI !== 'undefined' && UI.render) UI.render();
        }
        const dd = G.drawFromSummonDeck(c => !c.isDiscardEffect && c.cost >= 2 && c.cost <= 9 && (c.attack || 0) > 0);
        if (dd) G.summonCardChoice(self.owner, dd.name, dd.cost, dd.attack, dd.health, dd.abilities || [], null, null, dd);
        return;
      }
      // 2v2: the side proxy only ever holds the ACTIVE player's hand, so
      // reading G.state[opponentSide].hand devoured from a stale/foreign list
      // (usually empty) instead of a real opponent. withChosenOpponent aliases
      // one chosen enemy PLAYER's hand onto that proxy for the duration, which
      // is how every other hand-reaching card (Mace Windu, Freddy, Deadpool,
      // The Grinch, Lasso of Truth) already stays correct in 2v2. In 1v1 it
      // resolves instantly to the only opponent, so behavior there is unchanged.
      const devourFrom = (p) => {
        const hand = (G.state[p] && G.state[p].hand) || [];
        if (!hand.length) return;
        // Find the highest-cost card without permanently re-sorting the hand.
        let idx = 0;
        for (let i = 1; i < hand.length; i++) {
          if ((hand[i].cost || 0) > (hand[idx].cost || 0)) idx = i;
        }
        const [devoured] = hand.splice(idx, 1);
        killed[p] = devoured;
        G.state.voidPile.push({ name: devoured.name, cost: devoured.cost });
        G.log(`Gorr devours ${devoured.name} (cost ${devoured.cost}) from ${G.seatPossessive(p)} hand!`);
        // Credit Gorr with card advantage for removing an opponent's card
        // (losing your own is negative, but we credit only the removal
        // side since each removal is symmetric and cancels out on self).
        if (p !== self.owner) {
          G._creditChain(self, 'statsCardAdvantage', 1);
        }
      };
      // Your own hand is the ACTIVE player's, already aliased on your side —
      // safe to read directly. The enemy hand goes through the 2v2 bridge.
      if (!enemyOnly) devourFrom(self.owner);
      G.withChosenOpponent(self.owner, 'Gorr — whose hand?', (opp) => {
        devourFrom(opp);
      }, { autoPick: true });
      // Stash a banner payload for the UI so the player sees exactly which cards
      // died. STRUCTURED PER SEAT, not a baked sentence: the wording is built on
      // each client at render time from Game.seatLabel, so (a) an online match
      // names the actual players instead of "You lost / AI lost", and (b) the
      // GUEST reads it in ITS OWN perspective — a host-baked "You lost" would
      // have named the host's card on the guest's screen. _mpFlipPerspective
      // swaps the two seat keys for the guest.
      if (killed.player || killed.ai) {
        G.state._gorrBanner = {
          player: killed.player ? { name: killed.player.name, cost: killed.player.cost } : null,
          ai:     killed.ai     ? { name: killed.ai.name,     cost: killed.ai.cost     } : null,
          at: Date.now()
        };
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
        if (G.reviveVoided(self, lane)) return;
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
        if (typeof UI !== 'undefined' && UI._fxDharmaWheel) { try { UI._fxDharmaWheel(self); } catch (e) {} }
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
      //
      // Effects-as-data migration: the entry sweep is now expressed as a
      // declarative step and run through G.runEffect (the DSL foundation),
      // instead of a hand-written getEnemiesOf().forEach. Identical result
      // (deal `sweep` to every living enemy) — proven by golden RG-16.
      const sweep = self._omniManSweep || 3;
      // Capture the enemy row BEFORE the AoE removes any it kills, so the
      // flight-streak's blood bursts land on every struck card.
      if (typeof UI !== 'undefined' && UI._fxViltrumiteFlight) { try { UI._fxViltrumiteFlight(G.getEnemiesOf(self.owner)); } catch (e) {} }
      G.runEffect(
        { do: 'damage', target: 'allEnemies', amount: sweep },
        { self, lane, log: `Omni-Man devastates all enemies for ${sweep}!` }
      );
    },
    // Mobility hook — same shape as Man-Bat's. Start of Tricks, Omni-Man
    // relocates to an empty ally lane (if one exists). Stun/freeze
    // gates the move identically. Per balance pass: "give Omni-Man a
    // move just like Man-Bat." Unlike Man-Bat, no -1/-1 debuff lands
    // on the destination's opposite enemy — Omni-Man is already an
    // AOE damage threat on entry; the move is purely repositioning.
    onBeforeTricks(G, self, lane) {
      if (Game.isActionLocked(self)) {
        G.log(`  [SKIP] ${self.name} is ${self.isStunned ? 'STUNNED' : 'FROZEN'} — stays put.`);
        return;
      }
      const open = G.getOpenLanes(self.owner).filter(l => l !== lane);
      if (!open.length) return;
      // Include the current lane as a "stay" option — same affordance
      // as Man-Bat. Player can pick Omni-Man's own lane to skip the
      // relocation entirely.
      if (Game.isHuman(self.owner)) {
        // STAY is a BUTTON, not a lane (see promptLaneChoice options.declineLabel).
        // The old affordance listed Omni-Man's own lane among the choices and
        // asked the player to click it — but that square is covered by the card
        // itself, so the click hit the card every time. Owner: "it's hard right
        // now to click their lane that they are in to stay."
        G.promptLaneChoice(self.owner, open, "Omni-Man — Move", "Choose a lane to move to", (to) => {
          G.moveCard(self, lane, to);
        }, null, null, 0, { declineLabel: 'STAY PUT', onDecline: () => G.log(`Omni-Man stays put in lane ${lane + 1}.`) });
      } else {
        const to = open[Math.floor(Game.rng() * open.length)];
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
        const remaining = G.getEnemiesOf(self.owner).filter(e => !debuffed.has(e.id) && e.currentHealth > 0 && G.canEffectLand(e, 'debuff', { owner: self.owner, source: self }));
        if (!remaining.length) return;
        G.promptCardChoice(self.owner, remaining, "Silver Surfer — Weaken",
          `Choose enemy to remove ${debuff} ATK from (${debuffed.size + 1}/${targets})`,
          (t) => {
            G.debuffCard(t, debuff, 0, false, self);
            if (typeof UI !== 'undefined' && UI._fxCosmicWave) { try { UI._fxCosmicWave(self, t); } catch (e) {} }
            G.log(`Silver Surfer weakens ${t.name} by ${debuff} ATK!`);
            debuffed.add(t.id);
            if (debuffed.size < targets) pickNext();
          }, _aiThreatPicker, { forced: remaining.length <= (targets - debuffed.size) });
      };
      pickNext();
    },
    passive: "enemyCostIncrease"
  },

  "Mace Windu": {
    onPlay(G, self) {
      // 2v2: choose whose hand to curse. 1v1 resolves instantly (unchanged).
      G.withChosenOpponent(self.owner, 'Mace Windu — whose hand?', (opp) => {
      const hand = G.state[opp].hand;
      if (!hand.length) { G.log("Mace Windu: opponent's hand is empty."); return; }
      hand.forEach(c => {
        c.attack       = Math.max(0, (c.attack       || 0) - 1);
        c.baseAttack   = Math.max(0, (c.baseAttack   || 0) - 1);
        c.currentHealth = Math.max(1, (c.currentHealth|| 0) - 1);
        c.maxHealth     = Math.max(1, (c.maxHealth    || 0) - 1);
        c.baseHealth    = Math.max(1, (c.baseHealth   || 0) - 1);
      });
      G.log(`Mace Windu curses ${hand.length} card${hand.length === 1 ? '' : 's'} in the opponent's hand (-1/-1 each)!`);
      if (typeof UI !== 'undefined' && UI._fxVaapad) { try { UI._fxVaapad(self); } catch (e) {} }
      // Purple curse haze rolls over the cursed hand (the enemy's whose cards
      // just took -1/-1 — the player's own hand when the AI casts Mace).
      if (typeof UI !== 'undefined' && UI._fxHandHaze) { try { UI._fxHandHaze(opp, { color: '#a24bff' }); } catch (e) {} }
      });
    },
    onAllyKilled(G, self) {
      if (self.currentHealth <= 0) return;
      self.maxHealth     = (self.maxHealth     || 0) + 2;
      self.currentHealth = (self.currentHealth || 0) + 2;
      G.log(`Mace Windu grows stronger from an ally's fall (+0/+2)!`);
    },
    onEnemyKilled(G, self) {
      if (self.currentHealth <= 0) return;
      self.attack = (self.attack || 0) + 2;
      G.log(`Mace Windu grows stronger from an enemy's defeat (+2/+0)!`);
    },
  },

  // ==================== COST 8 ====================
  "Apocalypse": {
    onPlay(G, self, lane) {
      // A HORSEMAN ARRIVES FIRST (owner, 2026-08-09). Pulled from the shared
      // summon deck rather than a fixed token, so the body is a real 1-cost
      // card with its own abilities — same lottery Bat Signal and Mother Box
      // draw from, same exclusions (no discard-effect cards, nothing with 0
      // ATK, which would be a body that cannot fight).
      const horseman = G.drawFromSummonDeck(c =>
        !c.isDiscardEffect && (c.cost || 0) === 1 && (c.attack || 0) > 0);
      if (horseman) {
        G.summonCardChoice(self.owner, horseman.name, horseman.cost, horseman.attack,
                           horseman.health, horseman.abilities || [], null, null, horseman);
        G.log(`Apocalypse raises ${horseman.name}!`);
      }
      const KEYWORDS = ["Armor 1", "Evade 1", "Bullseye", "Overdrive"];
      // 10-cost titans don't get handouts — same exemption logic as
      // auto-Untrickable, so Doomsday (skipAutoUntrickable) still
      // qualifies despite his 12 starting cost.
      G.state[self.owner].hand.filter(card =>
        // Environments are excluded outright — they never fight, so a combat
        // keyword on one is noise. applyAbilities refuses them too, but doing
        // it here as well keeps the phantom entry out of card.abilities and
        // stops the log claiming a grant that never happened.
        !card.isEnvironment &&
        (card.skipAutoUntrickable || (card.baseCost || card.cost || 0) < 10)
      ).forEach(card => {
        const kw = KEYWORDS[Math.floor(Game.rng() * KEYWORDS.length)];
        if (!card.abilities.includes(kw)) card.abilities.push(kw);
        G.applyAbilities(card);
        G.log(`[APOCALYPSE] ${card.name} permanently gains ${kw}.`);
      });
      // Blue empower haze rolls over your whole hand as every card is charged.
      if (typeof UI !== 'undefined' && UI._fxHandHaze) { try { UI._fxHandHaze(self.owner, { color: '#4aa3ff' }); } catch (e) {} }
    },
    onTurnStart(G, self) {
      if (self.currentHealth <= 0) return;
      const enemies = G.getEnemiesOf(self.owner).filter(c => c.currentHealth > 0);
      if (!enemies.length) return;
      // 2 DISTINCT random enemies each lose 1 ATK — a lone enemy only
      // ever loses 1 (never double-dipped).
      const shuffled = enemies.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Game.rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      shuffled.slice(0, 2).forEach(target => {
        target.attack = Math.max(0, (target.attack || 0) - 1);
        G.log(`[APOCALYPSE] ${target.name} permanently loses 1 ATK.`);
      });
    }
  },
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
        // Same guard as Gojo / Jigsaw — no open enemy-side lane means no
        // destination for any pick, so skip rather than prompt into a dead end.
        if (!G.getOpenLanes(opp).length) {
          G.log('Darth Vader finds no open lane to move an enemy into — skipping.');
          afterMove();
          return;
        }
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
          if (typeof UI !== 'undefined' && UI._fxForceChoke) { try { UI._fxForceChoke(self, target); } catch (e) {} }
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
      G.runPlayerChain(self, (target) => {
        G.freezeCardUnresistible(target, self);
        if (typeof UI !== 'undefined' && UI._fxPalpatineLightning) { try { UI._fxPalpatineLightning(self, target); } catch (e) {} }
      }, "Palpatine — Chain Freeze", "freeze", 3);
    },
    passive: "doubleFrozenDamage",
    onDeath(G, self, lane) {
      G.runPlayerChain(self, (target) => {
        G.freezeCardUnresistible(target, self);
        if (typeof UI !== 'undefined' && UI._fxPalpatineLightning) { try { UI._fxPalpatineLightning(self, target); } catch (e) {} }
      }, "Palpatine's Final Act — Chain Freeze", "freeze", 3);
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
      // Presence-based since the aura recompute pass: Game.recomputeAuras
      // reads living Lukes off the board and reconciles every card's
      // recorded aura to match — no per-card stamp flags to unwind.
      const auraSize = self._lukeAuraSize || 1;
      G.recomputeAuras();
      G.log(`Luke Skywalker inspires allies (+${auraSize}/+${auraSize}) and weakens enemies (-${auraSize}/-${auraSize})!`);
      // Now snapshot the remaining LIVE enemies and prompt for MC.
      // getEnemiesOf already filters by `currentHealth > 0`, so dead
      // cards from the aura won't show up.
      const enemies = G.getEnemiesOf(self.owner);
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Luke Skywalker — Mind Control", "Choose an enemy to Mind Control 1", (t) => {
          if (typeof UI !== 'undefined' && UI._fxSaberSlash) { try { UI._fxSaberSlash(self, t, { blade: '#3aa0ff', core: '#eaf4ff' }); } catch (e) {} }
          G.mindControlCard(t, self, () => { G.log(`Luke Skywalker Mind Controls ${t.name}!`); });
        }, _aiThreatPicker);
      }
    },
    onAnyCardPlayed(G, self) {
      // A new arrival gets the aura via the reconcile pass. Most play
      // paths already recompute (placement, summon, move), but this hook
      // stays as a cheap idempotent safety net for any that don't.
      G.recomputeAuras();
    },
    onDeath(G, self, lane) {
      // Luke reads as dead (health 0) the moment this fires, so the
      // reconcile lifts his aura — including from cards that were
      // Invincible when it tried to land (nothing was recorded, so
      // nothing phantom is returned).
      G.recomputeAuras();
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
        let _thorSeq = 0;
        [lane - 1, lane, lane + 1].forEach((li) => {
          if (li >= 0 && li < Game.LANE_COUNT) {
            const e = G.state.lanes[li][opp];
            if (e && e.currentHealth > 0) {
              if (typeof UI !== 'undefined' && UI._fxThorStrike) { try { UI._fxThorStrike(e, _thorSeq++); } catch (er) {} }
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
        const t = enemies[Math.floor(Game.rng() * enemies.length)];
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
      // Revive grant is capped to allies of cost <= 9 — 10-cost titans can't
      // be handed a revive (user cap 2026-07-13).
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id && a.currentHealth > 0 && (a.baseCost || a.cost || 0) <= 9);
      const grant = (a) => {
        // Stack with any existing Revive charges. Cards born with
        // Revive (Jason, Mahoraga, Wolverine) already have
        // reviveCharges set in applyAbilities; we add 1 more.
        a.reviveCharges = (a.reviveCharges || 0) + 1;
        a.canRevive = true;
        G.log(`Revan grants ${a.name} Revive 1! (${a.reviveCharges} charge${a.reviveCharges === 1 ? '' : 's'})`);
        if (typeof UI !== 'undefined' && UI._fxRevanForce) { try { UI._fxRevanForce(self, a); } catch (e) {} }
      };
      if (!allies.length) {
        G.log("Revan finds no other allies to empower.");
        return;
      }
      G.promptCardChoice(self.owner, allies, "Revan — Grant Revive",
        "Choose an ally to give Revive 1", grant);
    }
  },
  "Voldemort": {
    // THE UNFORGIVABLE CURSES. Before every combat while he stands, Voldemort
    // casts one of three — and never the same one twice running, so the round
    // he kills is a round he cannot stun, and the round he stuns is a round he
    // cannot take a body. The rotation IS the card: each curse is strong enough
    // to be a whole turn's play, and being denied last round's answer is what
    // keeps him from being three cards at once.
    //
    // Every curse routes through the engine's existing door for its effect —
    // killCard, debuffCard + stunCard, mindControlCard — so each one inherits
    // the rules that already govern it: Invincible refuses the kill, Immunity
    // refuses Crucio and Imperio unless the caster is Unresistible, Juggernaut
    // shrugs the mind control, and a card taken by Imperio is released by the
    // same end-of-round sweep that releases every other Mind Control. Nothing
    // here re-implements any of that.
    _CURSES: [
      { id: 'ak', name: 'Avada Kedavra', desc: 'Destroy an enemy with cost \u2264 6. No damage — death.' },
      { id: 'cr', name: 'Crucio',        desc: 'An enemy takes (\u22124/\u22124) permanently. This can destroy it.' },
      { id: 'im', name: 'Imperio',       desc: 'Mind Control an enemy for this round.' },
    ],

    // Which enemies a given curse can actually reach. A curse with no legal
    // target is not offered at all — being shown a choice that cannot resolve
    // is worse than being shown two choices.
    _targetsFor(G, self, curseId) {
      const owner = self.owner;
      return G.getEnemiesOf(owner).filter(e => {
        if (!e || e.currentHealth <= 0) return false;
        if (curseId === 'ak') {
          const cost = (e.baseCost != null ? e.baseCost : e.cost) || 0;
          return cost <= 6 && G.canEffectLand(e, 'destroy', { owner, source: self });
        }
        // Crucio and Imperio are debuffs; the debuff gate is what decides.
        return G.canEffectLand(e, 'debuff', { owner, source: self });
      });
    },

    // onLaneCombat, not onBeforeCombat: the curse fires when HIS lane comes up,
    // not at the top of the attack phase (owner, 2026-08-09). It matters — by
    // the time a late lane fights, the earlier ones have resolved, and a curse
    // aimed at a board four lanes ago is aimed at a board that no longer
    // exists. Casting in sequence also lets him answer what he can actually
    // see, which is the whole point of a once-each choice.
    onLaneCombat(G, self, lane) {
      if (self.currentHealth <= 0) return;
      // A silenced Dark Lord casts nothing — same lock every other
      // pre-combat caster honours.
      if (Game.isActionLocked(self)) {
        G.log(`  [SKIP] ${self.name} is ${G.actionLockLabel(self)} — no curse this round.`);
        return;
      }
      const defs = CARD_ABILITIES['Voldemort'];
      // ONCE EACH, EVER (owner, 2026-08-09). Stronger than the rotation it
      // replaces: he casts at most three times in a whole game, so every choice
      // spends a curse permanently and the last round he matters is the round
      // his third one goes. Stored per instance, so two Voldemorts have their
      // own three and a revived one starts clean.
      const used = self._usedCurses || (self._usedCurses = []);
      const available = defs._CURSES
        .filter(c => used.indexOf(c.id) === -1)
        .filter(c => defs._targetsFor(G, self, c.id).length > 0);
      if (!available.length) {
        G.log(used.length >= defs._CURSES.length
          ? `[VOLDEMORT] All three curses are spent.`
          : `[VOLDEMORT] No remaining curse can find a mark this round.`);
        return;
      }

      const cast = (curse) => {
        const targets = defs._targetsFor(G, self, curse.id);
        if (!targets.length) return;
        // Spent on CAST, not on offer — a curse that fizzles for want of a
        // target must not burn its one use.
        if (used.indexOf(curse.id) === -1) used.push(curse.id);
        const strike = (t) => {
          if (typeof UI !== 'undefined' && UI._fxVoldemortCurse) {
            try { UI._fxVoldemortCurse(self, t, curse.id); } catch (e) {}
          }
          if (curse.id === 'ak') {
            G.log(`[VOLDEMORT] Avada Kedavra — ${t.name} falls.`);
            G.killCard(t, self);
          } else if (curse.id === 'cr') {
            G.log(`[VOLDEMORT] Crucio — ${t.name} writhes.`);
            // allowKill TRUE (owner, 2026-08-11): "I want Crucio to be able to
            // kill the enemy if it has 4 or less health and not leave them at
            // 1." So the (-4/-4) now finishes a small card outright instead of
            // flooring its HP at 1 — same allowKill path Pym Particles uses.
            // The Stun rider was removed (owner, 2026-08-09): a (-4/-4) that
            // ALSO took the card's turn was doing two curses' work, which left
            // Imperio with nothing of its own to offer.
            G.debuffCard(t, 4, 4, true, self);
          } else {
            G.mindControlCard(t, self, () => {
              G.log(`[VOLDEMORT] Imperio — ${t.name} turns on its own.`);
            });
          }
        };
        if (Game.isHuman(self.owner)) {
          G.promptCardChoice(self.owner, targets,
            `${curse.name} — Choose a Victim`, curse.desc, strike,
            _aiThreatPicker, { forced: targets.length === 1 });
        } else {
          strike(_aiThreatPicker ? _aiThreatPicker(targets) : targets[0]);
        }
      };

      if (Game.isHuman(self.owner)) {
        // The curse menu is a real prompt, not a local question: in
        // multiplayer the host has to know which curse was cast.
        G.promptCardChoice(self.owner, available.map(c => ({ id: c.id, name: c.name, desc: c.desc })),
          'Voldemort — Unforgivable Curse',
          used.length ? `Choose a curse. ${defs._CURSES.length - used.length} left — each can only be cast once.` : 'Choose a curse. Each can only be cast once.',
          (pick) => {
            const curse = defs._CURSES.find(c => c.id === (pick && pick.id));
            if (curse) cast(curse);
          },
          // AI fallback if the prompt times out: take the kill if it is on the
          // table, otherwise the mind control, otherwise the maiming.
          (opts) => opts.find(o => o.id === 'ak') || opts.find(o => o.id === 'im') || opts[0],
          { forced: available.length === 1 });
      } else {
        const pick = available.find(c => c.id === 'ak') || available.find(c => c.id === 'im') || available[0];
        cast(pick);
      }
    }
  },
  "Jack Sparrow": {
    // Parlay, renegotiated (user direction): instead of a one-shot
    // "all uncontested enemies can't attack this round" on play, Jack
    // picks ONE uncontested enemy lane right before every combat while
    // he's active — that enemy sits the round out.
    onBeforeCombat(G, self, lane) {
      if (Game.isActionLocked(self) || self.currentHealth <= 0) return;
      const opp = G.opponent(self.owner);
      const lanes = [];
      for (let i = 0; i < G.LANE_COUNT; i++) {
        const e = G.state.lanes[i][opp];
        // Uncontested = enemy present, no ally of Jack's side opposite.
        if (e && e.currentHealth > 0 && !G.state.lanes[i][self.owner] && !G.state.lanes[i].destroyed) {
          lanes.push(i);
        }
      }
      if (!lanes.length) return;
      const parley = (i) => {
        const target = G.state.lanes[i][opp];
        if (!target) return;
        target._parlayedThisRound = true;
        if (typeof UI !== 'undefined' && UI._fxParlay) { try { UI._fxParlay(target); } catch (e) {} }
        G.log(`[JACK SPARROW] Parlay! ${target.name} in lane ${i + 1} cannot attack this round.`);
      };
      if (Game.isHuman(self.owner)) {
        G.promptLaneChoice(self.owner, lanes,
          'Jack Sparrow — Parlay',
          'Choose an enemy in an uncontested lane — they cannot attack this combat.',
          parley, opp);
      } else {
        // AI: silence the biggest uncontested threat.
        lanes.sort((a, b) => {
          const ea = G.state.lanes[a][opp], eb = G.state.lanes[b][opp];
          const score = (c) => (typeof AI !== 'undefined' && AI.threatScore) ? AI.threatScore(c) : (c.attack * c.currentHealth);
          return score(eb) - score(ea);
        });
        parley(lanes[0]);
      }
    }
  },
  "Han Solo": {
    onPlay(G, self) {
      // First Strike — Han takes his shot at the very START of combat, before
      // the lane-by-lane exchange, no matter which lane he's in. Read by
      // Game._resolveFirstStrikes(). User: "han solo attacks first no matter
      // what lane he is in, so start of combat he attacks first."
      self.attacksFirst = true;
      if (typeof UI !== 'undefined' && UI._fxHanBlaster) { try { UI._fxHanBlaster(self); } catch (e) {} }
    },
    onBeforeCombat(G, self, lane) {
      if (Game.isActionLocked(self)) return;
      const opp = G.opponent(self.owner);
      const redirectLanes = [];
      for (let i = 0; i < G.LANE_COUNT; i++) {
        if (i === lane) continue;
        const e = G.state.lanes[i][opp];
        if (e && e.currentHealth > 0) redirectLanes.push(i);
      }
      if (!redirectLanes.length) return;

      const choices = [lane, ...redirectLanes];
      // When Han's own lane is uncontested, "staying" strikes the enemy hero
      // directly — there's no card opposite. Flag that lane so the board labels
      // it "STRIKE HERO" instead of drawing a reticle on an empty lane (which
      // read as "targeting nothing").
      const ownEnemy = G.state.lanes[lane][opp];
      const ownUncontested = !(ownEnemy && ownEnemy.currentHealth > 0);
      if (Game.isHuman(self.owner)) {
        const msg = ownUncontested
          ? `Choose an enemy card to strike this combat, or your own lane to strike the hero.`
          : `Choose a lane to attack this combat. Lane ${lane + 1} = stay and fight normally.`;
        G.promptLaneChoice(self.owner, choices,
          'Han Solo — Take the Shot', msg,
          (chosen) => {
            if (chosen !== lane) {
              self._hanRedirectLane = chosen;
              G.log(`[HAN SOLO] Lining up a shot into lane ${chosen + 1}!`);
            } else {
              G.log(`[HAN SOLO] Han Solo stays and fights his own lane.`);
            }
          },
          opp, null, self.attack);
        if (ownUncontested && G.state.pendingLaneChoice) {
          G.state.pendingLaneChoice.heroStrikeLane = lane;
        }
      } else {
        redirectLanes.sort((a, b) => {
          const ea = G.state.lanes[a][opp], eb = G.state.lanes[b][opp];
          return (eb.attack * eb.currentHealth) - (ea.attack * ea.currentHealth);
        });
        self._hanRedirectLane = redirectLanes[0];
        G.log(`[HAN SOLO] Lining up a shot into lane ${redirectLanes[0] + 1}!`);
      }
    },
    onBeforeAttack(G, self) {
      if (self._hanRedirectLane == null) return;
      const targetLane = self._hanRedirectLane;
      self._hanRedirectLane = null;
      const opp = G.opponent(self.owner);
      const enemy = G.state.lanes[targetLane][opp];
      if (enemy && enemy.currentHealth > 0) {
        G.log(`[HAN SOLO] Han fires across to lane ${targetLane + 1}!`);
        G.applyCombatDamage(self, enemy);
        if (self.splash > 0) G.splashDamage(targetLane, self.owner, self.splash, self);
        self._skipNormalAttack = true;
      }
      // If enemy died before combat, Han fights his own lane normally (no skip)
    },
    onTurnStart(G, self) {
      if (self.currentHealth <= 0) return;
      G.getAllCardsOf(self.owner).filter(c => c.currentHealth > 0).forEach(a => {
        a._criticalThisRound = Game.rng() < 0.5;
        if (a._criticalThisRound) G.log(`[HAN SOLO] ${a.name} is feeling lucky — Critical this round!`);
      });
    },
    onEndOfTurn(G, self) {
      G.getAllCardsOf(self.owner).forEach(a => { delete a._criticalThisRound; });
    },
    onDeath(G, self) {
      G.getAllCardsOf(self.owner).forEach(a => { delete a._criticalThisRound; });
    }
  },
  "Yoda": {
    passive: 'yodaShield',
    onPlay(G, self, lane) {
      // Activate the half-damage shield passive on entry (kept). The
      // combined-force strike and the random hero-hit badge are gone — Yoda's
      // active gift is now Master's Apprentice, handed out each Trick phase.
      // NOTHING TO STAMP. The shield is derived from the board by
      // Game.yodaShieldCount — his `passive: 'yodaShield'` above IS the source
      // of truth. The old counter here had to be unwound in onDeath, and every
      // exit that skipped onDeath (Super Soldier Serum's killCardSilent,
      // devour-to-void, bounce, a Moder strip) left it on forever.
      G.log('[YODA] The Force is with you — this side takes half combat damage.');
    },
    onBeforeTricks(G, self) {
      // Start of the Trick phase — Yoda gives TWO gifts, to two allies:
      //   1. Master's Guidance to one ally — their overkill (combat damage
      //      beyond the blocker's HP) carries through and strikes the enemy
      //      player.
      //   2. The Force shield to a DIFFERENT ally — Invincible for 1 turn.
      // Both are re-chosen every Trick phase, so clear the prior mark first.
      if (self.currentHealth <= 0) return;
      G.getAllCardsOf(self.owner).forEach(a => { delete a._mastersApprentice; });
      const allies = G.getAlliesOf(self.owner)
        .filter(a => a.currentHealth > 0 && a.id !== self.id && !a.isEnvironment);
      if (!allies.length) { G.log('[YODA] No apprentice to teach — Yoda waits.'); return; }

      const fx = (a) => {
        if (typeof UI !== 'undefined' && UI._fxForceChannel) { try { UI._fxForceChannel(self, a); } catch (e) {} }
      };
      // The Invincible counter ticks down in the end-of-round pass, matching
      // the Captain America / Invisible Woman convention.
      const shield = (a) => {
        if (!a) return;
        a.invincibleTurns = Math.max(a.invincibleTurns || 0, 1);
        G.log(`[YODA] The Force shields ${a.name} — Invincible this turn.`);
        fx(a);
      };
      const teach = (a) => {
        if (!a) return;
        a._mastersApprentice = true;
        G.log(`[YODA] ${a.name} becomes Yoda's apprentice — overkill will strike the enemy player.`);
        fx(a);
      };

      const pickShield = () => {
        // Shield any ally — the pick is independent of the apprentice, so it
        // may be the same card or a different one, wherever the player wants
        // the Force's protection.
        if (allies.length === 1) { shield(allies[0]); return; }
        G.promptCardChoice(self.owner, allies,
          'Yoda — The Force Shield',
          'Choose an ally to make Invincible this turn (can be the same card).',
          shield,
          cards => cards.slice().sort((a, b) => (b.attack * b.currentHealth) - (a.attack * a.currentHealth))[0]);
      };

      const pickApprentice = (a) => { teach(a); pickShield(); };

      if (allies.length === 1) { pickApprentice(allies[0]); return; }
      G.promptCardChoice(self.owner, allies,
        "Yoda — Master's Guidance",
        'Choose an ally. Their overkill damage carries through to the enemy player.',
        pickApprentice,
        cards => cards.slice().sort((a, b) => b.attack - a.attack)[0]);
    },
    onDeath(G, self) {
      // No counter to unwind — the shield stops the moment he is off the board,
      // because yodaShieldCount reads the board. This log is the only thing
      // left, and it is gated on there being no OTHER Yoda still standing.
      if (G.yodaShieldCount(self.owner) <= 1) G.log('Yoda falls — the Force shield fades.');
      // The apprentice's gift fades when the master falls.
      G.getAllCardsOf(self.owner).forEach(a => { delete a._mastersApprentice; });
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
      if (typeof UI !== 'undefined' && UI._fxMaulSaber) { try { UI._fxMaulSaber(self); } catch (e) {} }
      // Draw a trick from THIS owner's trick pile. Must use getTrickPile(owner)
      // — reading state.trickDrawPile directly is empty in Deckbuilder mode
      // (the real pile is per-player there), so Maul's draw silently did
      // nothing for saved-deck games.
      const tdraw = G.getTrickPile(self.owner) || [];
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
  // Grievous's escort. The FIRST token with an entry here — until now a
  // CARD_ABILITIES entry named after a token was inert, because summonCard's
  // token branch built a pure-data def with no hooks on it (fixed at that
  // branch, so any future token inherits the same way).
  //
  // `tokenDesc` — the text the SUMMONED body carries. Tokens normally ship an
  // empty desc so the badge row is not duplicated in prose, but "grows when it
  // comes back" is not a keyword and the Revive 2 badge cannot say it. It is a
  // separate key from `desc` on purpose: the merge below copies this object
  // onto the SUMMON_TOKEN_DEFS entry, and a `desc` here would overwrite the
  // codex entry's own line (which also names who summons it).
  "Battle Droid": {
    tokenDesc: 'When Revived: Add (+1/+1) permanently.',
    onRevive(G, self) {
      // Self-buff, so permanent by the buff-duration rule — and it must be,
      // since the whole point is a droid that comes back bigger each time.
      // applyAbilities re-runs on revive but only re-parses keywords into
      // flags; it never rewrites attack/maxHealth, so this survives the
      // second death too.
      G.buffCard(self, 1, 1);
      G.log(`  [BATTLE DROID] Reassembled, and better — now ${self.attack}/${self.currentHealth}.`);
    },
  },
  "Droideka": {
    // Two-mode cycle keyed off rounds SPENT ON THE FIELD, not the global round
    // number — his first round is always shields-up regardless of when he lands.
    //   odd count  → shields UP: Damage Immunity, takes no damage.
    //   even count → shields DOWN: no immunity, overcharged ATK when he attacks.
    // THE MULTIPLIER LIVES HERE AND NOWHERE ELSE. It used to be written as a
    // literal 3 in two separate places — _cardEffectiveAtk (which paints the
    // ATK orb) and _computeIncomingDamage (which deals the damage) — so the
    // number the card showed and the number it hit for were two independent
    // copies of the same rule, free to drift. Owner asked for double instead of
    // triple; both readers now take it from here.
    ATK_MULT: 2,
    _apply(G, self) {
      const shieldsUp = (self._droidekaRound % 2) === 1;
      const mult = CARD_ABILITIES['Droideka'].ATK_MULT;
      self.hasDamageImmunity = shieldsUp;
      self._droidekaOvercharge = !shieldsUp;
      if (shieldsUp) {
        G.log(`Droideka's shields snap up — it takes no damage this round.`);
      } else {
        G.log(`Droideka drops its shields and overcharges — x${mult} ATK this round.`);
      }
      if (typeof UI !== 'undefined' && UI._fxDroidekaShield) {
        try { UI._fxDroidekaShield(self, shieldsUp); } catch (e) {}
      }
    },
    onPlay(G, self) {
      self._droidekaRound = 1;   // first round on the field = odd = shields up
      CARD_ABILITIES['Droideka']._apply(G, self);
    },
    onTurnStart(G, self) {
      if (self.currentHealth <= 0) return;
      self._droidekaRound = (self._droidekaRound || 0) + 1;
      CARD_ABILITIES['Droideka']._apply(G, self);
    },
    onBeforeAttack(G, self) {
      // Blaster fire cue on every swing. Guarded — no-op in the headless sim.
      if (typeof UI !== 'undefined' && UI.sfx && UI.sfx.playCardSfx) {
        try { UI.sfx.playCardSfx('Droideka', 'attack', self); } catch (e) {}
      }
    },
  },
  "General Grievous": {
    // REDESIGNED 2026-08-09 (owner), twice. The Block-Meter strangle is gone,
    // and so is the board-wide Bullseye grant that briefly replaced it. He is a
    // duelist now: Evade 1 and Overdrive on the body (both keywords, so they
    // carry their own badges and stay out of the card text), a droid escort on
    // arrival, and a trophy taken off every kill and handed to someone else.
    onPlay(G, self, lane) {
      if (typeof UI !== 'undefined' && UI._fxGrievousSabers) { try { UI._fxGrievousSabers(self); } catch (e) {} }
      G.summonCardChoice(self.owner, 'Battle Droid', 2, 1, 1, ['Revive 2']);
    },
    // ANOTHER ALLY GETS THE TROPHY, NEVER HIM. Same principle as the Bullseye
    // grant he used to have: what he does, he does for the board. A self-buff
    // would also double up with Overdrive, which already pays him for killing.
    // Environments are excluded — a (+1/+1) on a card that never fights is a
    // stat nobody reads.
    onKill(G, self) {
      const allies = G.getAllCardsOf(self.owner)
        .filter(c => c.id !== self.id && c.currentHealth > 0 && !c.isEnvironment);
      if (!allies.length) {
        G.log(`General Grievous claims a trophy — with no one left to give it to.`);
        return;
      }
      const pick = allies[Math.floor(Game.rng() * allies.length)];
      G.buffCard(pick, 1, 1);
      G.log(`[GRIEVOUS] Another trophy — ${pick.name} takes (+1/+1) → ${pick.attack}/${pick.currentHealth}.`);
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
        const pool = G.getEnemiesOf(self.owner).filter(e => e.currentHealth > 0 && G.canEffectLand(e, 'damage', { owner: self.owner, source: self }));
        if (!pool.length) return;
        G.promptCardChoice(self.owner, pool, "Batman — Strike 2", `Deal ${strikeDmg} damage to any enemy`, (t) => {
          if (typeof UI !== 'undefined' && UI._fxBatarang) { try { UI._fxBatarang(self, t); } catch (e) {} }
          G.dealDamage(t, strikeDmg, self);
          G.log(`Batman strike 2: deals ${strikeDmg} to ${t.name}!`);
        }, pickDamage);
      };
      // Step 2: first strike — any live enemy (may be the feared one).
      const strike1 = () => {
        const pool = G.getEnemiesOf(self.owner).filter(e => e.currentHealth > 0 && G.canEffectLand(e, 'damage', { owner: self.owner, source: self }));
        if (!pool.length) return;
        G.promptCardChoice(self.owner, pool, "Batman — Strike 1", `Deal ${strikeDmg} damage to any enemy`, (t) => {
          if (typeof UI !== 'undefined' && UI._fxBatarang) { try { UI._fxBatarang(self, t); } catch (e) {} }
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
          if (typeof UI !== 'undefined' && UI._fxFearBats) { try { UI._fxFearBats(t); } catch (e) {} }
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
        // Omega Beams — fire from Darkseid's eyes at the doomed enemy BEFORE
        // the lane collapses and the cards are swept.
        if (typeof UI !== 'undefined' && UI._fxOmegaBeam) {
          const victim = G.state.lanes[i][opp];
          if (victim) { try { UI._fxOmegaBeam(self, victim); } catch (e) {} }
        }
        // Collapse first so Jason's allyDied trigger sees lane.destroyed = true
        G.destroyLane(i, 2);
        // Pass self as source — killCard's guard `card.owner !== source.owner`
        // ensures Darkseid isn't credited for killing his own card,
        // only the enemy side.
        G.killCard(G.state.lanes[i][self.owner], self);
        G.killCard(G.state.lanes[i][opp], self);
        // A death save (Yoda shield, revive, Iron Giant guard) can leave a card
        // alive inside the void. Anti-Life already threw survivors clear;
        // Darkseid didn't, stranding them in a lane that doesn't exist for 3
        // rounds — untargetable but still swinging. Shared helper now.
        G.evictVoidSurvivors(i);
        G.log(`Darkseid destroys lane ${i + 1}!`);
      };
      // Purge redesign (2026-07-16, user direction): "destroy up to 3
      // contested lanes, not odd/even based." The parity gate is gone —
      // ANY contested lane except Darkseid's own is eligible, capped at
      // 3 destructions. Roguelite Text+ ("Apokoliptan Legion") keeps an
      // upgrade meaning: it lifts the 3-lane cap entirely.
      const purgeCap = self._darkseidAnyContested ? Infinity : 3;
      let purgedCount = 0;
      const pickLanes = () => {
        const eligible = [];
        for (let i = 0; i < Game.LANE_COUNT; i++) {
          if (i === lane) continue;
          const mineC = G.state.lanes[i][self.owner];
          const theirsC = G.state.lanes[i][opp];
          if (!mineC || !theirsC) continue;
          // An Invincible / Damage-Immune occupant PROTECTS its whole lane
          // from the purge — the option must not even exist (user: "if it's
          // invincibility the lane cannot be destroyed, the option shouldn't
          // exist"). Matches the devour precedent: destruction-class effects
          // respect Invincibility outright.
          const laneProtected = [mineC, theirsC].some(c =>
            c && ((c.invincibleTurns || 0) > 0 || c.hasDamageImmunity));
          if (laneProtected) continue;
          eligible.push(i);
        }
        if (!eligible.length) { G.log(`Darkseid finds no purgeable contested lanes (Invincible cards protect their lanes).`); return; }
        if (!Game.isHuman(self.owner)) {
          // Only destroy lanes where the trade is favorable — the AI loses
          // its own card too, so collapsing a Hulk-vs-1/1 trades Hulk for
          // nothing. Trade is "good" when enemy threat ≥ our card's threat
          // plus a small margin. Parademon (just summoned, threat ~2) is
          // expendable so its lane is almost always worth purging.
          // Score every eligible lane, then destroy the BEST trades first,
          // stopping at the purge cap. Destroy when the trade is even or
          // favorable, the enemy is otherwise unkillable, our body is a
          // Parademon/low-value token, or the enemy out-costs us by 2+.
          const scored = [];
          eligible.forEach(i => {
            const myCard = G.state.lanes[i][self.owner];
            const enemy = G.state.lanes[i][opp];
            if (!myCard || !enemy) return;
            const mine = AI.threatScore(myCard);
            const theirs = AI.threatScore(enemy);
            // (Invincible/immune lanes never reach here — excluded from
            // `eligible` above, so the old unkillable-enemy bonus is gone.)
            const sacrificeBody = myCard.name === 'Parademon' || mine <= 2;
            const costDelta = (enemy.baseCost || enemy.cost || 0) - (myCard.baseCost || myCard.cost || 0);
            if (theirs - mine >= 0.5 || sacrificeBody || costDelta >= 2) {
              const value = (theirs - mine) + Math.max(0, costDelta) * 0.5;
              scored.push({ i, value });
            }
          });
          scored.sort((a, b) => b.value - a.value);
          const purged = [];
          scored.slice(0, purgeCap === Infinity ? scored.length : purgeCap).forEach(({ i }) => {
            destroyLane(i);
            purged.push(i + 1);
          });
          if (purged.length) {
            G.log(`Darkseid purges lanes: ${purged.join(', ')}`);
          } else {
            G.log(`Darkseid surveys the field — no favorable trades, holds the purge.`);
          }
          return;
        }
        const pickNext = () => {
          if (purgedCount >= purgeCap) return;
          const remaining = eligible.filter(i => !G.state.lanes[i].destroyed);
          if (!remaining.length) return;
          const choices = remaining.map(i => {
            const p = G.state.lanes[i][self.owner];
            const a = G.state.lanes[i][opp];
            return { name: `Lane ${i + 1}`, desc: `${p.name} vs ${a.name}`, _lane: i };
          });
          choices.push({ name: "Done", desc: "Stop destroying lanes" });
          const left = purgeCap === Infinity ? '' : ` (${purgeCap - purgedCount} left)`;
          G.promptCardChoice(self.owner, choices,
            "Darkseid — Purge", `Pick a contested lane to destroy${left}, or Done`,
            (choice) => {
              if (choice.name === "Done") return;
              destroyLane(choice._lane);
              purgedCount++;
              pickNext();
            }, c => c[c.length - 1]);
        };
        pickNext();
      };
      // Purge step is wrapped in a function so it fires AFTER the Parademon
      // summon resolves. No odd/even prompt anymore — straight to lane picks.
      const startPurge = () => pickLanes();

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
      const isRoguelite = G.state.mode && G.state.mode._roguelite;
      const lexes = G.getAllCardsOf(opp).filter(e => e.name === 'Lex Luthor');
      const lexSuppressed = isRoguelite ? lexes.some(e => e._lexFullLock) : lexes.length > 0;
      if (lexSuppressed) {
        G.log(`  [LUTHOR] Superman's bonus attack is suppressed by Lex Luthor!`);
      } else {
        const target = G.state.lanes[lane] ? G.state.lanes[lane][opp] : null;
        if (target && target.currentHealth > 0) {
          G.dealDamage(target, self.attack, self);
          G.log(`Superman bonus attacks ${target.name} for ${self.attack}!`);
        } else {
          G.damagePlayer(opp, self.attack, self.isBullseye);
          G.log(`Superman bonus attacks health bar for ${self.attack}!`);
        }
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
        const enemies = G.getEnemiesOf(self.owner).filter(t => G.canEffectLand(t, 'damage', { owner: self.owner, source: self }));
        if (enemies.length) {
          G.promptCardChoice(self.owner, enemies, "Superman — Blast", `Choose enemy to deal ${blastDmg} damage`, (t) => {
            if (typeof UI !== 'undefined' && UI._fxHeatVision) { try { UI._fxHeatVision(self, t); } catch (e) {} }
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
      }, cards => cards.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0], { forced: unfrozen1.length <= 2 });
    }
  },
  "Thanos": {
    trickPhasePlayable: true,
    onPlay(G, self, lane) {
      // Lanes destroyed scales with tier: 2 / 3 / 4 / 5.
      // Roguelite Text+ ("Reality Snap") — _thanosLanes pins the count
      // at a fixed value (4) regardless of rarity.
      // 2v2: the snap always erases HALF the board (4 of 8 lanes), per owner
      // request — the "half of all life" fantasy scaled to the bigger arena.
      const is2v2Thanos = !!(G.is2v2 && G.is2v2());
      const numRolls = self._thanosLanes
        ? self._thanosLanes
        : is2v2Thanos
          ? Math.floor(Game.LANE_COUNT / 2)
          : G.rarityValue(self, { common: 2, rare: 3, special: 4, legendary: 5 });
      const rolled = new Set();
      let killed = 0;
      const maxLanes = Game.LANE_COUNT;
      while (rolled.size < Math.min(numRolls, maxLanes)) {
        const r = Math.floor(Game.rng() * maxLanes);
        if (!rolled.has(r)) {
          rolled.add(r);
          const opp = G.opponent(self.owner);
          const e = G.state.lanes[r][opp];
          if (e) {
            // Dust the card away before it's removed, so the clone captures
            // the live portrait (killCard sweeps the element on next render).
            if (typeof UI !== 'undefined' && UI._fxThanosDust) { try { UI._fxThanosDust(e); } catch (err) {} }
            // DEVOUR, not destroy (user, 2026-08-08): the snap erases you from
            // existence — void pile, no dead pile, no When Destroyed trigger,
            // no revive. devourCard is the canonical door for that, so the
            // snap inherits every rule devour already has (Invincible refuses
            // it, Damage Immunity does not, kill credit still lands).
            G.devourCard(e, self); killed++; G.log(`Thanos snaps lane ${r + 1}: ${e.name} erased from existence!`);
          }
        }
      }
      G.log(`Thanos snaps! Lanes ${[...rolled].map(n => n + 1).sort().join(', ')} — ${killed} enemies erased!`);
      if (typeof UI !== 'undefined' && UI.sfx) UI.sfx.playCardSfx('Thanos', 'ability', self);
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
      // When Played: deal 10 damage to a chosen enemy. Anakin is a
      // 10-cost, so pass {source:self} — the engine's "tens can't
      // target tens" rule drops other 10-cost titans from the picker.
      // (Draw 1 fires separately via the `Draw 1` keyword → drawOnPlay.)
      const enemies = G.getEnemiesOf(self.owner, { source: self }).filter(t => G.canEffectLand(t, 'damage', { owner: self.owner, source: self }));
      if (!enemies.length) return;
      G.promptCardChoice(self.owner, enemies, "Anakin — Strike",
        "Choose an enemy to deal 10 damage",
        (t) => { if (typeof UI !== 'undefined' && UI._fxSaberStrike) { try { UI._fxSaberStrike(self, t); } catch (e) {} } G.dealDamage(t, 10, self); G.log(`Anakin unleashes the dark side on ${t.name} for 10!`); },
        cards => _aiKillPicker(cards, 10));
    },
    onBeforeTricks(G, self, lane) {
      if (self.anakinMoved) return;           // fires exactly once per instance
      if (Game.isActionLocked(self)) {
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
        if (!eligible.length) {
          // No open lane to move to — the bonus attack STILL fires, in
          // Anakin's current lane. User direction: "if Anakin can't move
          // during the 1st trick phase his bonus attack should still
          // happen." Decouples the strike from the move.
          self.bonusAttack = (typeof self.bonusAttack === 'number' ? self.bonusAttack : 0) + 1;
          const cur = G.findCardLane(self);
          const e = cur >= 0 ? G.state.lanes[cur][opp] : null;
          const targetNote = e && e.currentHealth > 0 ? ` — locked on ${e.name}` : '';
          G.log(`Anakin can't move — strikes from lane ${cur + 1}${targetNote}!`);
          G.drainBonusAttacks(self);
          self.anakinMoved = true;
          return;
        }
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
      if (Game.isActionLocked(self)) return;
      self.bonusAttack = (typeof self.bonusAttack === 'number' ? self.bonusAttack : 0) + 1;
    }
  },
  "Dormammu": {
    onPlay(G, self, lane) {
      // Foresight (Dr. Strange reorder) for 2 turns
      G.state[self.owner].drStrangeReorder = "Dormammu";
      G.state[self.owner]._dormammuForesight = 2;
      // 2v2: Dormammu peeks 4 and distributes them across the whole draw phase.
      if (G._2v2QueueForesight) G._2v2QueueForesight(4, "Dormammu");
      G.log("Dormammu grants foresight for the next 2 draw phases!");
    },
    onBeforeTricks(G, self, lane) {
      if (self.dormammuDrained) return;    // fires exactly once per instance
      // {source: self} strips 10-cost enemies from the drain picker —
      // tens can't drain tens, so they must not even be offered.
      const enemies = G.getEnemiesOf(self.owner, { source: self });
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
          // Auto-resolve when forced: if every remaining enemy will be
          // drained anyway (available <= remaining drains) the pick can't
          // change the outcome, so skip the modal (options.forced).
          G.promptCardChoice(self.owner, available, `Dormammu — Drain (${remaining} left)`,
            `Choose enemy to drain (${remaining} remaining)`, (t) => {
              if (typeof UI !== 'undefined' && UI._fxDrainSiphon) { try { UI._fxDrainSiphon(self, t); } catch (e) {} }
              G.drainCard(self, t);
              picked.push(t.id);
              drainChain(remaining - 1, picked);
            }, threatPicker, { forced: available.length <= remaining });
        } else {
          const t = threatPicker(available);
          if (typeof UI !== 'undefined' && UI._fxDrainSiphon) { try { UI._fxDrainSiphon(self, t); } catch (e) {} }
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
      if (typeof UI !== 'undefined' && UI._fxManhattan) { try { UI._fxManhattan(self, self.owner); } catch (e) {} }
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
        // 'destroy', not 'damage'. Devour consumes the card into the void pile
        // — it deals no damage — so the gate that matters is the anti-
        // DESTRUCTION one (Invincible). The 'damage' kind also excludes
        // hasDamageImmunity, which quietly filtered damage-immune enemies out
        // of the devour menu, so Galactus couldn't even pick them.
        const available = enemies.filter(e => e.currentHealth > 0 && !picked.includes(e.id) && G.findCardLane(e) >= 0 && G.canEffectLand(e, 'destroy', { owner: self.owner, source: self }));
        if (!available.length) return;
        // AI picker: devour highest threat. Cost-based picking missed
        // cards like Captain America (7-cost, modest stats but huge
        // strategic impact via shield) — threatScore captures that.
        // For 10-cost titans like Galactus, the goal is to remove the
        // most threatening piece; raw cost is a poor proxy.
        const threatPicker = (cards) => cards.slice().sort((a, b) =>
          (AI && AI.threatScore ? (AI.threatScore(b) - AI.threatScore(a))
                                : (b.cost || 0) - (a.cost || 0)))[0];
        if (Game.isHuman(self.owner)) {
          // Auto-resolve when the choice is forced: if every remaining
          // candidate will be devoured anyway (available <= remaining
          // devours), which one you pick first can't change the outcome, so
          // skip the modal (user: "if there are only 2 or less enemies it
          // should happen automatically"). options.forced routes through the
          // engine's shared auto-resolve. When there ARE more targets than
          // devours, the choice is real and still prompts.
          G.promptCardChoice(self.owner, available, `Galactus — Devour (${remaining} left)`,
            `Choose enemy to devour (${remaining} remaining)`, (t) => {
              G.devourCard(t, self);
              picked.push(t.id);
              devourChain(remaining - 1, picked);
            }, threatPicker, { forced: available.length <= remaining });
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
      // Devour 1 weak enemy (≤4 ATK) each turn. Pass {source:self} so 10-cost
      // titans (devour-immune) are stripped from the pool — a random roll
      // could otherwise land on an immune titan and silently whiff the turn.
      // This hook runs in a plain end-of-turn forEach (not a prompt-gated
      // phase), so it can't safely raise a picker; take the highest-threat
      // weak enemy deterministically instead of a random one.
      const weak = G.getEnemiesOf(self.owner, { source: self }).filter(e => e.attack <= 4 && G.canEffectLand(e, 'damage', { owner: self.owner, source: self }));
      if (!weak.length) return;
      const target = weak.slice().sort((a, b) =>
        (AI && AI.threatScore ? (AI.threatScore(b) - AI.threatScore(a))
                              : (b.cost || 0) - (a.cost || 0)))[0];
      G.devourCard(target, self);
    }
  },
  "Knull": {
    onPlay(G, self, lane) {
      // Floor raised 1 -> 2 (owner, 2026-08-09): a 10-cost lottery that could
      // roll a 1-cost body in every empty lane was paying out chaff on the
      // most expensive card in the game.
      // Roguelite Text+ override — _knullCostFloor raises the minimum
      // cost of the random pull pool further. Default 2 (classic); Text+ sets
      // to 4 so the lottery skips the mid tier as well and only pulls
      // high-cost cards (Wonder Woman, Carnage, Doom, etc.).
      const minCost = self._knullCostFloor || 2;
      // _knullCostCeiling raises the upper bound from 9 to 10 with Text+
      // ("God of Symbiotes") so the lottery can roll 10-cost titans.
      const maxCost = self._knullCostCeiling || 9;
      G._suppressSummonSfx = true;
      const _knullSummoned = [];
      G.getOpenLanes(self.owner).filter(l => l !== lane).forEach(l => {
        // RE-CHECK LIVE: the open-lane list is a snapshot, but a summoned card's
        // own On Play can claim lanes mid-loop (Hela raising Undead Warriors).
        // Check BEFORE drawing so we don't burn a card out of the shared summon
        // deck on a lane we can no longer fill — Knull simply summons that many
        // fewer, which is the intended interaction.
        const ln = G.state.lanes[l];
        if (!ln || ln.destroyed || ln[self.owner]) return;
        // Pull from the shared summon deck so Knull's lottery spreads
        // across the full 95-card pool. Filter: cost minCost-maxCost,
        // attack > 0, not a discard-effect card.
        const d = G.drawFromSummonDeck(c => !c.isDiscardEffect && c.cost >= minCost && c.cost <= maxCost && (c.attack || 0) > 0);
        if (d) {
          G.summonCard(self.owner, l, d.name, d.cost, d.attack, d.health, d.abilities || [], d);
          const sc = G.state.lanes[l] && G.state.lanes[l][self.owner];
          if (sc) _knullSummoned.push(sc);
        }
      });
      G._suppressSummonSfx = false;
      G.log("Knull fills the battlefield!");
      // Signature FX — black-and-red symbiote tendrils flood out to each summon.
      if (typeof UI !== 'undefined' && UI._fxSymbioteFlood) { try { UI._fxSymbioteFlood(self, _knullSummoned); } catch (e) {} }
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
      // Signature FX — a hellfire soul-siphon dragging the enemy Block Meter
      // into Trigon (fires regardless of how much is actually stolen).
      if (typeof UI !== 'undefined' && UI._fxTrigonSteal) { try { UI._fxTrigonSteal(self, opp); } catch (e) {} }
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
        // {source: self} — this HP-drain is a Trigon ability, so it
        // skips fellow 10-cost titans (mutual immunity), not just his freeze.
        G.getEnemiesOf(self.owner, { source: self }).forEach(e => {
          if (e.currentHealth > 1) G.dealDamage(e, 2, self);
        });
        G.log(`Trigon drains 2 HP from every enemy.`);
      }
    },
    _massFreezeOnce(G, self) {
      if (self.trigonFrozen) return;
      // {source: self} strips 10-cost enemies — Trigon's freeze can't
      // touch fellow titans (mutual 10-cost immunity), so they don't
      // belong in the target list or the "freezes N enemies" count.
      const targets = G.getEnemiesOf(self.owner, { source: self }).filter(e => e.currentHealth > 0);
      if (!targets.length) {
        // Mark the freeze as fired anyway so a re-summoned Trigon
        // doesn't snap-freeze the field after a Lazarus / reanimation
        // re-deploy. "Once per instance" = once, period.
        self.trigonFrozen = true;
        return;
      }
      self.trigonFrozen = true;
      if (typeof UI !== 'undefined' && UI._fxHellfire) { try { UI._fxHellfire(self, targets); } catch (e) {} }
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
      // The titan test is canEffectLand's job (it calls is10CostImmune, which
      // honors skipAutoUntrickable). A hand-rolled `cost < 10` in front of it
      // was a second, WRONG copy of that rule: it swept in Doomsday, who prints
      // at 12 but is explicitly not a titan — the exact bug the user has called
      // out twice. killCard already allowed the hit; only this filter hid him.
      const targets = G.getEnemiesOf(self.owner).filter(
        e => e.currentHealth > 0
          && G.canEffectLand(e, 'destroy', { owner: self.owner, source: self })
      );
      if (!targets.length) return;
      const t = targets[Math.floor(Game.rng() * targets.length)];
      self._trigonChaining = true;
      G.killCard(t, self);
      self._trigonChaining = false;
      G.log(`Trigon destroys ${t.name}!`);
    }
  },
  "Boiler Room": {
    // BOILER ROOM BURNS WITH THE SAME BURNING AS EVERYONE ELSE.
    // It used to run its own private version of the status: a flat 1 damage on
    // onBeforeAttack, forever, no decay. That made one printed word mean two
    // different rules depending on who applied it, which is why the card had to
    // spend a sentence explaining itself. Now it goes through the shared
    // applier at Burning 1, so the keyword's tooltip is true here too and the
    // sentence could be dropped.
    // Damage per turn is unchanged (see the re-stoke in onTurnStart). The one
    // behavioural difference, accepted deliberately: it ticks before the card's
    // LANE fights rather than before that card ATTACKS, so a burning card with
    // no one to swing at now still burns.
    _markBurning(card, boilerRoom) {
      if (!card || card.isEnvironment) return;
      // isBurning, the ignite one-shot FX and the decaying counter all live in
      // _ignite. Its first arg (G) is unused, hence null.
      CARD_ABILITIES['Godzilla']._ignite(null, card, 1);
      // Add the Freddy spawn onDeath hook independently of isBurning so
      // a card pre-marked by another source (Knull, Freddy Krueger passive)
      // still triggers the spawn when it dies in the Boiler Room's lane.
      if (boilerRoom && !card._brDeathHooked) {
        card._brDeathHooked = true;
        const orig = card.onDeath || null;
        card.onDeath = function(G, self, laneIdx) {
          // Propagate death-prevention (see Open Water) — a burning card that
          // survives via a custom revive must not also spawn Freddy off a
          // canceled death.
          const prevented = orig ? orig.call(this, G, self, laneIdx) : false;
          if (prevented) return true;
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
        // Freddy's arrival ends the burning — all fire is extinguished when he rises.
        const opp = G.opponent(owner);
        G.getAllCardsOf(opp).forEach(e => { e.isBurning = false; });
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
              // RE-CHECK ON RESOLVE, not just on arm. The ally was alive when
              // this prompt opened, but a prompt is answered LATER — and the
              // effect that spawned Freddy can still be killing things in the
              // meantime. Reported case: Boiler Room's lane held Sabertooth and
              // Nightwing, Soul Stone killed BOTH, Freddy rose off Sabertooth's
              // death while Nightwing was still standing, and by the time the
              // player picked a lane Nightwing was dead — so this callback
              // placed a corpse back on the board and resurrected him.
              const stillThere = allyInLane
                && allyInLane.currentHealth > 0
                && lane[owner] === allyInLane;
              if (!stillThere) {
                G.log(`  [DISPLACE SKIPPED] ${allyInLane ? allyInLane.name : 'the ally'} did not survive to be moved.`);
                finishSpawn(1, 4);
                return;
              }
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
      G.log('Boiler Room ignites — the enemy in this lane is burning!');
    },
    onAnyCardPlayed(G, self) {
      if (self._brSpawned) return;
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;
      const AB = CARD_ABILITIES['Boiler Room'];
      const opp = G.opponent(self.owner);
      const enemy = G.state.lanes[laneIdx][opp];
      // Only mark cards that haven't been hooked yet — prevents re-burning
      // a card that was cleansed (by Yoda etc.) since _brDeathHooked stays
      // set even after isBurning is cleared.
      if (enemy && enemy.currentHealth > 0 && !enemy._brDeathHooked) AB._markBurning(enemy, self);
    },
    onTurnStart(G, self) {
      if (self._brSpawned) return;
      if (G.findCardLane(self) < 0) return;
      const AB = CARD_ABILITIES['Boiler Room'];
      const opp = G.opponent(self.owner);

      // Each round, spread burning from every currently burning card to its adjacent lanes.
      const toBurn = [];
      G.getAllCardsOf(opp).filter(c => c.isBurning && c.currentHealth > 0).forEach(burningCard => {
        const bLane = G.findCardLane(burningCard);
        if (bLane < 0) return;
        [bLane - 1, bLane + 1].forEach(adj => {
          if (adj >= 0 && adj < G.LANE_COUNT) {
            const c = G.state.lanes[adj][opp];
            if (c && c.currentHealth > 0 && !c.isBurning && !toBurn.includes(c)) toBurn.push(c);
          }
        });
      });
      toBurn.forEach(c => {
        AB._markBurning(c, self);
        G.log(`[BURN] Boiler Room spreads — ${c.name} in lane ${G.findCardLane(c) + 1} is now burning!`);
      });

      // RE-STOKE. Boiler Room never re-marks a card it has already lit (the
      // spread pass above deliberately skips anything already burning, and
      // onAnyCardPlayed skips anything already hooked), which was harmless
      // while the burn was a permanent flat hook. A decaying counter would
      // instead tick once and go out. Re-stoking every currently-burning enemy
      // back to 1 each turn is what keeps the damage at the old 1-per-turn.
      // _ignite takes the HIGHER number, so a Godzilla's Burning 3 sitting in
      // this lane is not dragged down to 1.
      G.getAllCardsOf(opp).forEach(c => {
        if (c.isBurning && c.currentHealth > 0) CARD_ABILITIES['Godzilla']._ignite(null, c, 1);
      });
    },
    onDeath(G, self) {
      // Boiler Room removed without spawning Freddy (e.g. destroyed by a trick)
      // — clear burning from all enemies so it doesn't persist.
      const opp = G.opponent(self.owner);
      G.getAllCardsOf(opp).forEach(e => { e.isBurning = false; });
    },
  },
  "Godzilla": {
    // ATOMIC BREATH — a decaying burn held as a COUNTER, not a queue.
    //
    // The number IS the damage: Burning 3 deals 3 and decays to Burning 2,
    // which deals 2 and decays to Burning 1, which deals 1 and goes out. Owner:
    // "burning 3 so they take 3 damage then next turn it goes to burning 2 they
    // take 2 damage next turn burning 1." The old shape was a [3,1,1] queue —
    // three ticks, but 3/1/1 rather than 3/2/1, and with no number to show.
    //
    // TIMING: it ticks on onLaneCombat, so a card burns immediately BEFORE ITS
    // OWN LANE fights — not at the top of the phase with every other lane.
    // Owner: "they take burning damage right before their lane not at the
    // beginning of the attack phase." That is the same hook and the same
    // reasoning Voldemort already uses; onBeforeCombat (the previous home) fires
    // for the whole board before lane 1 has swung, which is exactly what was
    // wrong. onBeforeAttack is NOT an option: it only fires for cards that
    // actually swing, so a burning card with no target would never tick.
    BURN_START: 3,
    // THE SHARED BURNING APPLIER. It lives under Godzilla for historical
    // reasons (he was the first source) but every card that sets a card
    // alight goes through here, so Burning means exactly one thing no matter
    // who lit the match — the same reason the keyword's tooltip can now carry
    // the rule instead of each card reprinting it.
    // `stacks` is the starting number; omit it for Godzilla's own 3.
    // NOTE: the outer G is unused — the only G referenced below belongs to the
    // onLaneCombat hook, which takes its own. Callers without one may pass null.
    _ignite(G, card, stacks) {
      if (!card || card.isEnvironment || card.currentHealth <= 0) return;
      const AB = CARD_ABILITIES['Godzilla'];
      const n = stacks || AB.BURN_START;
      // Re-stoking takes the HIGHER number, it does not overwrite. A second
      // Godzilla still refreshes to 3 (max(3,3)), but a Human Torch's Burning 2
      // must never downgrade a card already burning at 3.
      card.burnStacks = Math.max(card.burnStacks | 0, n);
      const _wasBurning = card.isBurning;
      card.isBurning = true;
      if (!_wasBurning && typeof UI !== 'undefined' && UI._fxBurnIgnite) {
        try { UI._fxBurnIgnite(card); } catch (e) {}
      }
      if (card._godzillaBurnHooked) return;
      card._godzillaBurnHooked = true;
      const origLane = card.onLaneCombat || null;
      card.onLaneCombat = function (G, self, laneIdx) {
        const n = self.burnStacks | 0;
        if (n > 0 && self.currentHealth > 0) {
          G.dealDamage(self, n, null);
          G.log(`[BURN] ${self.name} takes ${n} burn damage as its lane ignites!`);
          self.burnStacks = n - 1;
          if (self.burnStacks <= 0) {
            // Fire out — but the flame flag is SHARED with Boiler Room, so it
            // only clears if no Boiler Room is keeping its own burn alive.
            self.burnStacks = 0;
            const anyBoiler = ['player', 'ai'].some(o =>
              G.getAllCardsOf(o).some(c => c.name === 'Boiler Room'));
            if (!anyBoiler) self.isBurning = false;
          }
        }
        if (origLane) origLane.call(this, G, self, laneIdx);
      };
    },
    onPlay(G, self, lane) {
      const enemies = G.getEnemiesOf(self.owner);
      const AB = CARD_ABILITIES['Godzilla'];
      if (!enemies.length) { G.log('Godzilla roars — but there is nothing to burn.'); return; }
      enemies.forEach(e => AB._ignite(G, e));
      G.log(`Godzilla unleashes atomic fire — ${enemies.length} enemy card${enemies.length === 1 ? '' : 's'} set ablaze!`);
      if (typeof UI !== 'undefined' && UI._fxGodzillaFire) { try { UI._fxGodzillaFire(self, enemies); } catch (e) {} }
    },
  },
  "Freddy Krueger": {
    // Freddy never swings at the card across from him — his war is fought in
    // the enemy's dreams (their hand), on a TWO-ROUND CYCLE:
    //   • ATTACK round — slash ONE random non-trick hand card for his ATK.
    //     0 HP → destroyed; survives → falls Asleep + Freddy gains +1/+1.
    //   • OFF round — HALF the non-trick hand (rounded down) each loses 1 HP.
    // Tricks are NEVER targeted: they live in trickHand, not hand, and
    // _hauntTargets guards on the character-card shape on top of that.
    //
    // Living valid hand targets — character cards only.
    _hauntTargets(G, opp) {
      const hand = (G.state[opp] && G.state[opp].hand) || [];
      return hand.filter(c => c && !c.isTrick && c.attack !== undefined &&
        (c.currentHealth !== undefined ? c.currentHealth : (c.health || 0)) > 0);
    },
    onBeforeAttack(G, self) {
      // He makes NO normal swing, ever — set the skip up front so every path
      // below (including an empty enemy hand) leaves the lane enemy untouched.
      self._skipNormalAttack = true;
      // autoPick: fires mid-combat, so it resolves "whose hand?" itself rather
      // than prompting each swing.
      G.withChosenOpponent(self.owner, 'Freddy Krueger', (opp) => {
        const AB = CARD_ABILITIES['Freddy Krueger'];
        // Two-round cycle — first active round is an attack round, then it
        // alternates. Counter advances every round he acts.
        const n = self._freddyCycle || 0;
        const attackRound = (n % 2) === 0;
        self._freddyCycle = n + 1;
        const targets = AB._hauntTargets(G, opp);
        if (!targets.length) return;
        if (attackRound) AB._attackRound(G, self, opp, targets);
        else AB._offRound(G, self, opp, targets);
      }, { autoPick: true });
    },
    // Mark a hand card for the freddy-hand-slash paint flash. Direct DOM class
    // manipulation is lost because UI.render() rebuilds the element on an HP
    // change, so the flag rides on the card and the renderer reapplies it.
    _flashSlash(t) {
      t._freddySlashing = true;
      setTimeout(() => { t._freddySlashing = false; }, 900);
    },
    _attackRound(G, self, opp, targets) {
      const hand = G.state[opp].hand;
      const t = targets[Math.floor(Game.rng() * targets.length)];
      let dmg = self.attack || 1;
      if (G.yodaShieldCount(opp) > 0) dmg = Math.ceil(dmg / 2);
      const curHp = t.currentHealth !== undefined ? t.currentHealth : (t.health || 0);
      t.currentHealth = Math.max(0, curHp - dmg);
      G.log(`[FREDDY] Freddy stalks ${t.name} in the enemy's hand for ${dmg}!`);
      CARD_ABILITIES['Freddy Krueger']._flashSlash(t);
      const handIdx = hand.indexOf(t);
      const destroyed = t.currentHealth <= 0;
      if (destroyed) {
        if (handIdx >= 0) hand.splice(handIdx, 1);
        G.log(`[FREDDY] ${t.name} is slain in its sleep — destroyed before it could be played!`);
      } else if (!t.isAsleep) {
        // SURVIVED → IT SLEEPS. Locked out of its owner's next turn
        // (Game.playCard refuses sleepTurns > 0), woken by Game.tickSleep at
        // the following round's start. The !isAsleep guard stops Freddy
        // farming the same unplayable card for +1/+1 every round.
        t.isAsleep = true;
        t.sleepTurns = 1;
        // Permanent, stacking, through buffCard so every stat surface renders
        // it like any other buff.
        G.buffCard(self, 1, 1);
        G.log(`[FREDDY] ${t.name} falls asleep — Freddy grows to ${self.attack}/${self.currentHealth}.`);
        if (typeof UI !== 'undefined' && UI.emitFX) {
          try { G.emitFX('sleep', { cardId: t.id, owner: opp, name: t.name }); } catch (e) {}
        }
      }
      if (typeof UI !== 'undefined' && UI._freddyHandSlash) {
        setTimeout(() => UI._freddyHandSlash(t.name, dmg, t.id, handIdx, opp, destroyed), 60);
      }
    },
    _offRound(G, self, opp, targets) {
      const hand = G.state[opp].hand;
      const count = Math.floor(targets.length / 2);
      if (count <= 0) {
        G.log(`[FREDDY] Freddy haunts the enemy's dreams — too few cards to grip this round.`);
        return;
      }
      // Random HALF (rounded down) of the non-trick hand each lose 1 HP.
      const pool = targets.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Game.rng() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      G.log(`[FREDDY] Freddy haunts ${count} card${count === 1 ? '' : 's'} in the enemy's hand — each loses 1 HP.`);
      pool.slice(0, count).forEach(t => {
        const curHp = t.currentHealth !== undefined ? t.currentHealth : (t.health || 0);
        t.currentHealth = Math.max(0, curHp - 1);
        CARD_ABILITIES['Freddy Krueger']._flashSlash(t);
        const handIdx = hand.indexOf(t);
        const destroyed = t.currentHealth <= 0;
        if (destroyed && handIdx >= 0) {
          hand.splice(handIdx, 1);
          G.log(`[FREDDY] ${t.name} withers away in the enemy's hand!`);
        }
        if (typeof UI !== 'undefined' && UI._freddyHandSlash) {
          setTimeout(() => UI._freddyHandSlash(t.name, 1, t.id, handIdx, opp, destroyed), 60);
        }
      });
    },
    onDeath(G, self, laneIdx) {
      // Clear burning from all enemies when Freddy dies
      G.getEnemiesOf(self.owner).forEach(e => { e.isBurning = false; });
      // Clear the Boiler Room env slot that spawned this Freddy
      const l = (self._envLane !== undefined) ? self._envLane : laneIdx;
      const lane = G.state.lanes[l];
      if (lane && lane._env) lane._env[self.owner] = null;
    },
  },
  "Freddy Fazbear": {
    onTurnStart(G, self) {
      if (!self._triggerNextRound) return;
      self._triggerNextRound = false;
      // 2v2: bite the specific enemy SEAT that wasted the most Energy last round
      // (captured when Freddy woke). Energy is per-seat there, so drain that
      // seat's freshly-granted Energy directly. (User: "drain from whoever left
      // more.")
      const tt = G.state && G.state.twoVTwo;
      if (tt && tt.players && self._freddyDrainSeat && tt.players[self._freddyDrainSeat]) {
        const seat = tt.players[self._freddyDrainSeat];
        self._freddyDrainSeat = null;
        if ((seat.energy || 0) > 0) {
          const before = seat.energy;
          seat.energy = Math.max(0, before - 1);
          G.log(`[FREDDY FAZBEAR] Drains 1 Energy from ${seat.name}! (${before} → ${seat.energy})`);
          if (typeof UI !== 'undefined' && UI._fxFazbearGlitch) { try { UI._fxFazbearGlitch(self); } catch (e) {} }
        }
        return;
      }
      const opp = G.opponent(self.owner);
      // Drain only — the opponent loses 1, Freddy's side gains NOTHING
      // (user direction: "no gain, like Catwoman").
      if (G.state[opp].currency > 0) {
        const before = G.state[opp].currency;
        G.state[opp].currency = Math.max(0, before - 1);
        G.log(`[FREDDY FAZBEAR] Drains 1 Energy from the opponent! (${before} → ${G.state[opp].currency})`);
        if (typeof UI !== 'undefined' && UI._fxFazbearGlitch) { try { UI._fxFazbearGlitch(self); } catch (e) {} }
      }
    },
  },
  "Doomsday": {
    passive: 'doomsdayScaling',
    onPlay(G, self, lane) {
      // A monstrous entrance — the thing that killed Superman lands hard.
      if (typeof UI !== 'undefined' && UI._fxDoomsdayEntrance) { try { UI._fxDoomsdayEntrance(self); } catch (e) {} }
    },
    // Doomsday starts at cost 12 but scales DOWN — he shouldn't be
    // auto-Untrickable just because of his starting cost. The immunity
    // is earned via his revive, not by being a titan.
    skipAutoUntrickable: true,
    onDeath(G, self, lane) {
      if (G.reviveVoided(self, lane)) return false; // destroyed lane — even Doomsday stays down
      if (self._doomsdayRevived) return false; // already revived once — die permanently
      self._doomsdayRevived = true;
      // Consume the Revive 1 keyword charge (cards.js) — the badge is
      // driven by reviveCharges on every surface, and zeroing it here
      // keeps the generic revive path in handleDeath from ever firing
      // a SECOND revive on top of this custom one.
      self.reviveCharges = 0;
      self.currentHealth = self.maxHealth;
      // Rising immune has to CLEAR what's already on him, not just block what
      // comes next. The _doomsdayRevived guard in tryApplyDebuff /
      // freezeCardUnresistible only refuses NEW Stun/Freeze, so a Doomsday who
      // was stunned or frozen when he died came back still stunned and frozen
      // — the counters rode straight through the revive. User report: "when
      // doomsday revived he was still getting stunned and frozen which he
      // should be immune to."
      self.stunnedTurns = 0; self.isStunned = false;
      self.frozenTurns  = 0; self.isFrozen  = false;
      // He rises with IMMUNITY, the real keyword — not a Doomsday-shaped
      // lookalike. The _doomsdayRevived guard only ever refused Stun and
      // Freeze, so everything else a debuff can do (ATK/HP strip, Fear, Mind
      // Control) still landed on the thing the log called unstoppable. Owner:
      // "when doomsday revives give him immunity". Immunity is the game's
      // existing answer to "blocks all debuffs", it shows the badge every
      // surface already knows how to draw, and canEffectLand honours it
      // without this card teaching anything new.
      self.immunityCharges = Math.max(self.immunityCharges || 0, 1);
      self.permanentImmunity = true;
      // UNTRICKABLE TOO (owner, 2026-08-09). Immunity refuses status debuffs;
      // Untrickable refuses enemy TRICKS outright, which is the other half of
      // "cannot be stopped" — without it a Phantom Zone or an Anti-Life still
      // removed the thing the log calls unstoppable. skipAutoUntrickable stays
      // set, so this is a flag he EARNS by rising, not one his cost hands him.
      self.isUntrickable = true;
      // NO TAUNT ON THE REVIVE. Reversed 2026-08-14 (owner struck "and Taunt"
      // off the revive line on a screenshot). It was briefly re-armed here on
      // the reasoning that Taunt 1 is printed on the def and tauntTurns decays
      // to 0 long before he dies — but that IS the intended shape: Taunt is his
      // arrival keyword, spent once, not something the revive refreshes. The
      // printed "Taunt 1" keyword stays on the def and still arms when he
      // lands; it simply does not come back with him.
      G.log(`[DOOMSDAY] Cannot be stopped — Doomsday rises with Immunity and Untrickable.`);
      if (typeof UI !== 'undefined' && UI._fxDoomsdayRise) { try { UI._fxDoomsdayRise(self); } catch (e) {} }
      return true; // prevent death
    }
  },
  "Padme Amidala": {
    onEndOfTurn(G, self) {
      G.getAlliesOf(self.owner).filter(c => c !== self).forEach(c => {
        c.attack = (c.attack || 0) + 1;
        c.maxHealth = (c.maxHealth || 0) + 1;
        c.currentHealth = (c.currentHealth || 0) + 1;
      });
      G.log(`[PADME] All other allies gain +1 ATK and +1 max HP.`);
    }
  },
  "Open Water": {
    _hookCard(self, G, card) {
      if (!card || card.isEnvironment || card._owHooked) return;
      card._owHooked = true;
      const origDeath = card.onDeath || null;
      card.onDeath = function(G2, dying, laneIdx) {
        // Propagate the wrapped card's death-prevention result — a custom
        // reviver (Jason/Wolverine/Mahoraga/Doomsday, Text+ Grundy/Spawn)
        // returns truthy to CANCEL the death. Dropping it here made the
        // reviver burn its charge, restore HP, then die anyway AND spawn
        // Jaws off a death that never happened.
        const prevented = origDeath ? origDeath.call(this, G2, dying, laneIdx) : false;
        if (prevented) return true;
        if (!self._owSpawned) {
          const owLane = G2.findCardLane(self);
          if (owLane >= 0) {
            self._owSpawned = true;
            CARD_ABILITIES['Open Water']._spawnJaws(G2, self.owner, owLane);
          }
        }
      };
    },
    _spawnJaws(G, owner, laneIdx) {
      const lane = G.state.lanes[laneIdx];
      if (lane._env) lane._env[owner] = null;

      const def = (typeof CARD_DEFS !== 'undefined')
        ? CARD_DEFS.find(d => d.name === 'Jaws') : null;
      const allyInLane = lane[owner];

      const finishSpawn = (atk, hp) => {
        // The dying card may still occupy the slot when onDeath fires — clear it first.
        if (lane[owner] && lane[owner].currentHealth <= 0) lane[owner] = null;
        const beforeJaws = G.state.lanes[laneIdx][owner];
        G.summonCard(owner, laneIdx, 'Jaws', 3, atk, hp, ['Overdrive'], def);
        const jaws = G.state.lanes[laneIdx][owner];
        // Same identity guard as Sewers: never stamp Jaws' stats onto whatever
        // card is standing in the lane if the summon bailed.
        if (!jaws || jaws === beforeJaws || jaws.name !== 'Jaws') {
          G.log(`  [OPEN WATER] Jaws can't surface in lane ${laneIdx + 1} — the lane is still occupied.`);
          return;
        }
        if (jaws) {
          jaws._envLane = laneIdx;
          jaws.attack = atk;
          jaws.currentHealth = hp;
          jaws.maxHealth = hp;
        }
        G.log(`Jaws rises from the Open Water in lane ${laneIdx + 1}!`);
        if (typeof UI !== 'undefined' && UI._fxWaterSurge) { try { UI._fxWaterSurge(jaws); } catch (e) {} }
        if (typeof UI !== 'undefined' && UI._jawsJumpscare) {
          setTimeout(() => UI._jawsJumpscare(laneIdx, owner), 60);
        }
      };

      if (allyInLane && allyInLane.currentHealth > 0) {
        const openLanes = G.getOpenLanes(owner).filter(l => l !== laneIdx);
        if (openLanes.length > 0) {
          G.promptLaneChoice(owner, openLanes,
            `Jaws — Move ${allyInLane.name}`,
            `Jaws needs this lane. Move ${allyInLane.name} to another open lane.`,
            (targetLane) => {
              if (allyInLane.currentHealth <= 0) {
                if (lane[owner] === allyInLane) lane[owner] = null;
                finishSpawn(4, 4);
                return;
              }
              lane[owner] = null;
              G.state.lanes[targetLane][owner] = allyInLane;
              G.log(`  [DISPLACED] ${allyInLane.name} moved to lane ${targetLane + 1} to make room for Jaws.`);
              G.checkLaneTrap(allyInLane, targetLane);
              if (allyInLane.onMoved) allyInLane.onMoved(G, allyInLane, targetLane);
              finishSpawn(4, 4);
            }
          );
        } else {
          const extraAtk = allyInLane.attack;
          const extraHp  = allyInLane.currentHealth;
          G.log(`  [ABSORB] Jaws devours ${allyInLane.name} (+${extraAtk}/+${extraHp})!`);
          G.handleDeath(allyInLane, laneIdx, null);
          finishSpawn(4 + extraAtk, 4 + extraHp);
        }
      } else {
        finishSpawn(4, 4);
      }
    },
    onPlay(G, self, lane) {
      const AB = CARD_ABILITIES['Open Water'];
      const opp = G.opponent(self.owner);
      AB._hookCard(self, G, G.state.lanes[lane][self.owner]);
      AB._hookCard(self, G, G.state.lanes[lane][opp]);
    },
    onAnyCardPlayed(G, self) {
      if (self._owSpawned) return;
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;
      const AB = CARD_ABILITIES['Open Water'];
      const opp = G.opponent(self.owner);
      AB._hookCard(self, G, G.state.lanes[laneIdx][self.owner]);
      AB._hookCard(self, G, G.state.lanes[laneIdx][opp]);
    },
  },
  "Jaws": {
    onPlay(G, self) {
      self.ignoresArmor = true;
      self.ignoresEvade = true;
    },
    onKill(G, self) {
      self.maxHealth += 1;
      self.currentHealth = self.maxHealth;
      G.log(`[JAWS] Jaws grows stronger — now ${self.attack}/${self.maxHealth}!`);
    },
    onDeath(G, self, laneIdx) {
      const l = (self._envLane !== undefined) ? self._envLane : laneIdx;
      const lane = G.state.lanes[l];
      if (lane && lane._env) lane._env[self.owner] = null;
    },
  },
  // ============================================================
  // JIGSAW'S TWO ROOMS — placed by his discard, never drafted.
  // ============================================================
  "The Bathroom": {
    // "First enemy to enter" uses the SEWERS pattern: record who is standing
    // opposite when the room lands, then watch for a DIFFERENT card showing up.
    // Reusing the established idiom rather than inventing a second definition of
    // "entered" is what keeps the two rooms consistent with Sewers and Open
    // Water instead of subtly disagreeing about what an arrival is.
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      const existing = G.state.lanes[lane][opp];
      self._bathroomTracked = (existing && existing.currentHealth > 0) ? existing.id : null;
      // TWO victims, not one. The room holds the next 2 enemy cards, and it
      // only drains away once the SECOND one dies — so the count of bodies
      // still owed and the count already taken both have to survive on the
      // room itself, not in a closure.
      self._bathroomChained = [];
    },
    _chain(G, self, victim, laneIdx) {
      // The room is spent for INTAKE once it holds two, but it stays on the
      // board until the second body dies — those are different lifetimes and
      // conflating them is what would make it vanish with a victim still
      // chained inside it.
      if (!self._bathroomChained) self._bathroomChained = [];
      self._bathroomChained.push(victim.id);
      if (self._bathroomChained.length >= 2) self._bathroomTriggered = true;
      // THE CHAIN ICON. A visible status, not just an invisible movement flag —
      // the owner has to be able to see which two cards the room owns.
      victim._chained = true;
      // Watch this body: when the SECOND chained card dies the room drains.
      // Wraps onDeath the same way The Reveal hooks its occupants, including
      // the death-PREVENTION protocol — a truthy return means the death was
      // cancelled, so a card saved by a revive must not also count as drained.
      if (!victim._bathroomDeathHooked) {
        victim._bathroomDeathHooked = true;
        const prior = victim.onDeath || null;
        victim.onDeath = function (G2, dead, dLane) {
          const prevented = prior ? prior.call(this, G2, dead, dLane) : false;
          if (prevented) return true;
          try { CARD_ABILITIES['The Bathroom']._drain(G2, self, dead); } catch (e) {}
        };
      }
      // (−2/−2) applied with the CANONICAL shield rule — the same
      // statStripShieldsHp predicate checkLaneTrap and debuffCard use, so
      // Invincible / Damage Immunity blocks the health loss while the ATK strip
      // still lands. Re-implementing that rule is exactly how the Bear Trap
      // once ended up shielding a card that Pym Particles did not.
      const D = 2;
      const hpShielded = G.statStripShieldsHp(victim);
      victim.attack = Math.max(0, victim.attack - D);
      if (!hpShielded) {
        victim.maxHealth = Math.max(1, victim.maxHealth - D);
        victim.currentHealth = Math.max(0, victim.currentHealth - D);
      }
      // THE CHAIN. Read by moveCard, the single choke point every mover in the
      // game goes through (Bifrost, Gojo, Ahsoka's swap, a hunt, Jigsaw's own
      // drag), so "can never leave this lane" holds against all of them rather
      // than only against the ones remembered here.
      victim._chainedToLane = laneIdx;
      if (typeof UI !== 'undefined' && UI._fxBathroomChain) { try { UI._fxBathroomChain(victim); } catch (e) {} }
      G.log(hpShielded
        ? `  [THE BATHROOM] ${victim.name} wakes up chained! −${D} ATK — health shielded → ${victim.attack}/${victim.currentHealth}`
        : `  [THE BATHROOM] ${victim.name} wakes up chained! −${D}/−${D} → ${victim.attack}/${victim.currentHealth}`);
      G.log(`  [THE BATHROOM] ${victim.name} can never leave lane ${laneIdx + 1}.`);
      // A chain that drops the victim to 0 is lethal — route through the
      // canonical death path so it cannot sit as a 0-HP zombie. Same reasoning
      // (and same bug class) as checkLaneTrap.
      if (victim.currentHealth <= 0) G.handleDeath(victim, laneIdx, null);
    },
    // THE ROOM DRAINS. Only the SECOND chained body ends it — the first dying
    // leaves the room standing with one victim still owed, which is the whole
    // point of a room that holds two.
    _drain(G, self, dead) {
      const held = self._bathroomChained || [];
      if (!held.includes(dead.id)) return;
      self._bathroomDead = (self._bathroomDead || 0) + 1;
      if (self._bathroomDead < 2) {
        G.log(`  [THE BATHROOM] ${dead.name} stops moving. One chain still holds.`);
        return;
      }
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;
      const lane = G.state.lanes[laneIdx];
      // Clear the sub-slot the way The Reveal and Sewers hand their lane back.
      if (lane._env && lane._env[self.owner] === self) lane._env[self.owner] = null;
      G.log(`[THE BATHROOM] Both chains are empty. The room drains away.`);
      if (typeof UI !== 'undefined' && UI.emitFX) { try { G.emitFX('envReveal', { lane: laneIdx, owner: self.owner, name: 'The Bathroom' }); } catch (e) {} }
    },
    onAnyCardPlayed(G, self) {
      if (self._bathroomTriggered) return;
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;
      const opp = G.opponent(self.owner);
      const enemy = G.state.lanes[laneIdx][opp];
      const enemyId = (enemy && enemy.currentHealth > 0) ? enemy.id : null;
      // ALREADY-CHAINED BODIES ARE NOT NEW ARRIVALS. The one-victim version
      // could skip this: _chain set _bathroomTriggered, and the guard at the
      // top of this method then blocked every later ping. Holding TWO means
      // the flag no longer trips on the first, so without these two lines the
      // victim standing in the lane reads as an unseen arrival on EVERY card
      // played and takes (−2/−2) again, and again. Two guards on purpose —
      // `_chained` also covers a body chained by some other room.
      if (enemy && enemy._chained) { self._bathroomTracked = enemyId; return; }
      if (enemyId && enemyId !== self._bathroomTracked) {
        self._bathroomTracked = enemyId;
        CARD_ABILITIES['The Bathroom']._chain(G, self, enemy, laneIdx);
      } else {
        self._bathroomTracked = enemyId;
      }
    },
  },
  "The Reveal": {
    // "When a card dies in this lane, it rises on YOUR side as a (1/1)."
    // Implemented by hooking the occupants' onDeath, the same way Boiler Room
    // hooks its victims for the Freddy spawn — including the death-PREVENTION
    // protocol (a truthy return means the death was cancelled), so a card saved
    // by a revive does not also rise here off a death that never happened.
    _hookOccupants(G, self) {
      if (self._revealSpent) return;
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;
      const lane = G.state.lanes[laneIdx];
      const AB = CARD_ABILITIES['The Reveal'];
      // ENEMY bodies only (owner spec: "the 1st enemy card to die in this
      // lane"). This hooked BOTH sides, so the room would also raise one of
      // your own dead — which reads as the room helping the wrong player and
      // spends it on a body you did not want back.
      [G.opponent(self.owner)].forEach(side => {
        const c = lane[side];
        if (!c || c.isEnvironment || c.currentHealth <= 0 || c._revealHooked) return;
        c._revealHooked = true;
        const orig = c.onDeath || null;
        c.onDeath = function (G2, dead, dLane) {
          const prevented = orig ? orig.call(this, G2, dead, dLane) : false;
          if (prevented) return true;
          AB._rise(G2, self, dead, (dLane != null && dLane >= 0) ? dLane : laneIdx);
        };
      });
    },
    _rise(G, self, dead, laneIdx) {
      // ONE BODY, THEN THE ROOM IS SPENT. This is not a tidiness rule, it is
      // the difference between a card and an infinite loop: _rise summons into
      // the lane, the summon broadcasts onAnyCardPlayed, that re-hooks the body
      // it just raised, and if that body dies in the same cascade it rises
      // again — forever. The full-match tests hung on exactly that. Sewers and
      // Open Water are one-shot transformations for the same reason.
      // Set BEFORE the summon, so the broadcast it triggers already sees a
      // spent room rather than racing it.
      if (self._revealSpent) return;
      // The room has to still be standing — Jigsaw's rooms can be replaced or
      // cleared, and a dead room must not keep raising bodies.
      const here = G.findCardLane(self);
      if (here < 0 || here !== laneIdx) return;
      self._revealSpent = true;
      const owner = self.owner;
      const lane = G.state.lanes[laneIdx];
      // Clear a dead occupant of OUR side first — handleDeath defers slot
      // clearing to cleanupDead, so the corpse is still in the slot here and
      // summonCard would see the lane as occupied and bail. Sewers had exactly
      // this bug ("Pennywise never destroyed the card that was there").
      if (lane[owner] && lane[owner].currentHealth <= 0) lane[owner] = null;
      if (lane[owner]) {
        G.log(`  [THE REVEAL] ${dead.name} twitches — but lane ${laneIdx + 1} is already taken.`);
        return;
      }
      const realDef = (typeof CARD_DEFS !== 'undefined')
        ? CARD_DEFS.find(d => d.name === dead.name) : null;
      // Summon from a def COPY carrying the (2/2), rather than summoning the
      // real card and stamping the stats afterwards. Stamping looked right —
      // the body read 1/1 the instant it rose — and was then reverted to the
      // def's base stats later in the same death cascade, which re-derives from
      // the def. Handing the summon the stats up front means there is nothing
      // to re-derive back to. Spread, never JSON: a JSON clone of a def strips
      // its ability hooks.
      const def = realDef ? Object.assign({}, realDef, { attack: 2, health: 2 }) : null;
      const before = lane[owner];
      G.summonCard(owner, laneIdx, dead.name, dead.cost || 0, 2, 2, [], def);
      const risen = G.state.lanes[laneIdx][owner];
      if (!risen || risen === before) {
        G.log(`  [THE REVEAL] ${dead.name} does not get up.`);
        return;
      }
      // NOTE: no post-summon stat stamp. The def copy above is what sets the
      // (1/1); a stamp here would run BEFORE summonCard's arrival step drains,
      // so it could not be what holds anyway. And the body may legitimately
      // leave this method at more than (1/1) — Lone Wolf gives +1/+1 to a
      // summon that enters with no other allies, which is a real rule and
      // applies to a body that gets up alone just as it does to any summon.
      // The room is used up — clear the sub-slot so the board shows it is done,
      // the way Sewers hands its lane over to Pennywise.
      if (lane._env && lane._env[owner] === self) lane._env[owner] = null;
      G.log(`[THE REVEAL] ${dead.name} gets up in lane ${laneIdx + 1} — a (2/2) on your side, played anew. The room is spent.`);
      if (typeof UI !== 'undefined' && UI.emitFX) { try { G.emitFX('envReveal', { lane: laneIdx, owner, name: 'The Reveal' }); } catch (e) {} }
    },
    onPlay(G, self) { CARD_ABILITIES['The Reveal']._hookOccupants(G, self); },
    onAnyCardPlayed(G, self) { CARD_ABILITIES['The Reveal']._hookOccupants(G, self); },
    onTurnStart(G, self) { CARD_ABILITIES['The Reveal']._hookOccupants(G, self); },
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
        // Clear a DEAD occupant first. handleDeath defers slot clearing to
        // cleanupDead (and returns early on death-saves), so the absorbed card
        // is still sitting in the lane here — summonCard would see an occupied
        // lane and bail. Open Water/Jaws already did this; Sewers didn't.
        if (lane[owner] && lane[owner].currentHealth <= 0) lane[owner] = null;
        const before = G.state.lanes[laneIdx][owner];
        G.summonCard(owner, laneIdx, 'Pennywise', 4, atk, hp, [], def);
        const pennywise = G.state.lanes[laneIdx][owner];
        // Only stamp stats if the summon actually placed a NEW Pennywise. When
        // summonCard bails on an occupied lane the slot still holds the old
        // card, and writing here handed IT Pennywise's stats — user report:
        // "pennywise never destroyed the card that was there and the other
        // card stayed and gained the stats".
        if (!pennywise || pennywise === before || pennywise.name !== 'Pennywise') {
          G.log(`  [SEWERS] Pennywise can't rise in lane ${laneIdx + 1} — the lane is still occupied.`);
          return;
        }
        {
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
              if (allyInLane.currentHealth <= 0) {
                // Card died while the lane-choice was pending — skip the move
                if (lane[owner] === allyInLane) lane[owner] = null;
                finishSpawn(3, 5);
                return;
              }
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
          // Absorbed = genuinely dead. Zero it BEFORE handleDeath so the card
          // can't be read as alive, then free the slot ourselves.
          //
          // handleDeath does NOT reliably clear the lane: if another death is
          // already resolving (THE STACK gate, _stackResolving) it merely
          // QUEUES this one and returns, leaving the card standing. Sewers
          // fires from onAnyCardPlayed, so any on-play effect that killed
          // something puts us in exactly that state. summonCard then saw an
          // occupied lane, bailed, and Pennywise's stats got stamped onto the
          // surviving card — user report: "pennywise never destroyed the card
          // that was there and the other card stayed and gained the stats".
          allyInLane.currentHealth = 0;
          G.handleDeath(allyInLane, laneIdx, null);
          if (lane[owner] === allyInLane) lane[owner] = null;
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

  // ===================== WETLANDS / SPINOSAURUS =====================
  // The third habitat environment, and the one that does NOT consume itself.
  // Boiler Room and Sewers are replaced by what they birth; Wetlands stays on
  // the board underneath Spinosaurus and drains away only when he dies — so
  // the lane keeps reading "this is his water" for as long as he is standing.
  //
  // Its clock is the BLOCK METER, not a card entering or dying: every time
  // either side's meter fills and eats a hit, the swamp loses 1 Power. Starting
  // Power is 1, so a single block — from anyone — and the water breaks.
  "Wetlands": {
    START_POWER: 1,
    _power(self) {
      if (self._wetPower === undefined || self._wetPower === null) self._wetPower = CARD_ABILITIES['Wetlands'].START_POWER;
      return self._wetPower;
    },
    onPlay(G, self, lane) {
      CARD_ABILITIES['Wetlands']._power(self);
      G.log(`Wetlands floods lane ${lane + 1} — ${CARD_ABILITIES['Wetlands'].START_POWER} Power. Every Block Meter that fires drains it.`);
    },
    onBlockMeterFired(G, self) {
      if (self._wetReleased) return;
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;
      const AB = CARD_ABILITIES['Wetlands'];
      self._wetPower = Math.max(0, AB._power(self) - 1);
      G.log(`[WETLANDS] A Block Meter fires — the water stirs. Power ${self._wetPower}/${AB.START_POWER}.`);
      if (typeof UI !== 'undefined' && UI._fxWetlandsRipple) {
        try { UI._fxWetlandsRipple(laneIdx, self.owner, self._wetPower); } catch (e) {}
      }
      if (self._wetPower <= 0) {
        // Latch BEFORE releasing: _release can prompt (ally displacement), and
        // a second block resolving against the still-standing habitat while
        // that prompt is open would release a second Spinosaurus.
        self._wetReleased = true;
        AB._release(G, self.owner, laneIdx, self);
      }
    },
    // Self-heal: the habitat is supposed to outlive the release and die WITH
    // Spinosaurus, which his onDeath handles. But a Spinosaurus can leave the
    // board without dying — Phantom Zone bounces him to a hand, Devour voids
    // him past handleDeath entirely — and either way onDeath never fires, so
    // the drained habitat would sit in the lane forever with nothing in it.
    // Reconcile from the live board each round instead of trusting the exit.
    onTurnStart(G, self) {
      if (!self._wetReleased) return;
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;
      const spino = G.getAllCardsOf(self.owner)
        .some(c => c.name === 'Spinosaurus' && c.currentHealth > 0);
      if (spino) return;
      const lane = G.state.lanes[laneIdx];
      if (lane._env && lane._env[self.owner] === self) lane._env[self.owner] = null;
      G.log(`  [WETLANDS] No Spinosaurus remains — the wetlands drain away.`);
    },
    _release(G, owner, laneIdx, habitat) {
      const lane = G.state.lanes[laneIdx];
      const opp = G.opponent(owner);
      const def = (typeof CARD_DEFS !== 'undefined')
        ? CARD_DEFS.find(d => d.name === 'Spinosaurus') : null;

      // The enemy standing in this lane is taken the instant he surfaces.
      // Routed through canEffectLand so Invincible / Damage Immunity refuse it
      // like any other instant-destroy (shield canon) rather than this being a
      // second, quieter kill path that ignores them.
      const enemy = lane[opp];
      if (enemy && enemy.currentHealth > 0) {
        if (G.canEffectLand(enemy, 'destroy', { owner, source: habitat })) {
          G.log(`  [WETLANDS] Spinosaurus takes ${enemy.name} in lane ${laneIdx + 1}!`);
          G.killCard(enemy, habitat);
        } else {
          G.log(`  [WETLANDS] ${enemy.name} survives the jaws — the strike can't land.`);
        }
      }

      const allyInLane = lane[owner];

      const finishSpawn = (atk, hp) => {
        // Clear a DEAD occupant first — handleDeath defers slot clearing to
        // cleanupDead (and can merely QUEUE the death when another is already
        // resolving), so the absorbed card is still standing here and
        // summonCard would see an occupied lane and bail. Same trap Sewers hit.
        if (lane[owner] && lane[owner].currentHealth <= 0) lane[owner] = null;
        const before = G.state.lanes[laneIdx][owner];
        G.summonCard(owner, laneIdx, 'Spinosaurus', 5, atk, hp, [], def);
        const spino = G.state.lanes[laneIdx][owner];
        // Only stamp stats if a NEW Spinosaurus actually landed. Writing
        // unconditionally is how Sewers once handed Pennywise's stats to the
        // card that was already standing there.
        if (!spino || spino === before || spino.name !== 'Spinosaurus') {
          G.log(`  [WETLANDS] Spinosaurus can't surface in lane ${laneIdx + 1} — the lane is still occupied.`);
          return;
        }
        spino._habitatLane = laneIdx;
        // summonCard ignores atk/hp when sourceDef is provided; set directly.
        spino.attack = atk;
        spino.currentHealth = hp;
        spino.maxHealth = hp;
        // The habitat STAYS. Unlike Boiler Room / Sewers / Open Water, the env
        // slot is NOT cleared here — Spinosaurus's onDeath is what drains it.
        G.log(`Spinosaurus is released into lane ${laneIdx + 1}!`);
        if (typeof UI !== 'undefined' && UI._spinosaurusRelease) {
          setTimeout(() => UI._spinosaurusRelease(laneIdx, owner), 60);
        }
      };

      if (allyInLane && allyInLane.currentHealth > 0) {
        const openLanes = G.getOpenLanes(owner).filter(l => l !== laneIdx);
        if (openLanes.length > 0) {
          G.promptLaneChoice(owner, openLanes,
            `Spinosaurus — Move ${allyInLane.name}`,
            `Spinosaurus surfaces here. Move ${allyInLane.name} to another lane.`,
            (targetLane) => {
              // RE-CHECK ON RESOLVE. The ally was alive when this prompt armed,
              // but a prompt is answered LATER and the kill above can still be
              // cascading — placing a corpse back on the board resurrects it.
              const stillThere = allyInLane
                && allyInLane.currentHealth > 0
                && lane[owner] === allyInLane;
              if (!stillThere) {
                G.log(`  [DISPLACE SKIPPED] ${allyInLane ? allyInLane.name : 'the ally'} did not survive to be moved.`);
                finishSpawn(4, 6);
                return;
              }
              lane[owner] = null;
              G.state.lanes[targetLane][owner] = allyInLane;
              G.log(`  [DISPLACED] ${allyInLane.name} moved to lane ${targetLane + 1} to make room for Spinosaurus.`);
              G.checkLaneTrap(allyInLane, targetLane);
              if (allyInLane.onMoved) allyInLane.onMoved(G, allyInLane, targetLane);
              finishSpawn(4, 6);
            }
          );
        } else {
          const extraAtk = allyInLane.attack;
          const extraHp  = allyInLane.currentHealth;
          G.log(`  [ABSORB] Spinosaurus absorbs ${allyInLane.name} (+${extraAtk}/+${extraHp})!`);
          // Absorbed = genuinely dead. Zero it BEFORE handleDeath so nothing
          // downstream can read it as alive, then free the slot ourselves
          // (handleDeath does not reliably clear it — see the note above).
          allyInLane.currentHealth = 0;
          G.handleDeath(allyInLane, laneIdx, null);
          if (lane[owner] === allyInLane) lane[owner] = null;
          finishSpawn(4 + extraAtk, 6 + extraHp);
        }
      } else {
        finishSpawn(4, 6);
      }
    },
  },

  "Spinosaurus": {
    METER_MAX: 3,
    // THE START-OF-ROUND STALK IS GONE. He carried a bespoke onTurnStart that
    // walked him toward the opponent's last-played lane — a second, private
    // movement mechanic that happened to be called "Hunt" while not being the
    // Hunt keyword. Owner: "just add Hunt like jason and jango to spino, that
    // easy." He now prints the real `Hunt` keyword instead, so he chases through
    // the same _resolveHuntChase path Jason and Jango already use, and there is
    // one movement rule on this card rather than two that share a name.
    // HUNT METER — every damage instance anywhere on the field, from the one
    // post-damage notifier. Its OWN rampage is excluded: the sweep hits every
    // occupied lane, which is 3-6 damage instances in a single swing, so
    // counting them would refill the meter to full the moment it emptied and
    // the card would rampage every round forever — a meter that is always
    // full is not a meter. Ordinary combat swings still feed it.
    onAnyCardDamaged(G, self, damaged) {
      if (self.currentHealth <= 0) return;
      if (self._spinoHuntSpent) return;          // meter already cashed in
      // ENEMY damage feeds the meter. Owner spec 2026-08-14: "hunt meter goes
      // up each time an enemy is damaged." It previously counted ALLY damage —
      // a revenge meter — which is the opposite reading, so the trigger is
      // inverted rather than widened. Every instance counts, no per-round cap.
      if (!damaged || damaged.owner === self.owner) return;
      const AB = CARD_ABILITIES['Spinosaurus'];
      self._spinoMeter = (self._spinoMeter | 0) + 1;
      if (self._spinoMeter >= AB.METER_MAX) {
        // THE METER IS SPENT, NOT RESET. It used to cap, arm, fire a
        // whole-board rampage and refill forever. Now it pays out ONCE and
        // stops existing: the counter is cleared, the badge stops rendering
        // (_spinoHuntSpent gates it), and Overdrive is granted permanently.
        // Owner: "when hunt meter gains 3 remove hunt meter and permanently
        // gain overdrive."
        self._spinoMeter = 0;
        self._spinoHuntSpent = true;
        self._spinoArmed = false;
        self.hasHuntMeter = false;
        self.isOverdrive = true;                 // the real keyword, not a lookalike
        G.log(`[HUNT METER] Spinosaurus completes the hunt — the meter is spent and he gains Overdrive permanently!`);
        if (typeof UI !== 'undefined' && UI._spinosaurusRampage) {
          try { UI._spinosaurusRampage(self, []); } catch (e) {}
        }
      }
    },
    // THE RAMPAGE IS GONE. onBeforeCombat used to fire a whole-board sweep the
    // moment the meter armed, then reset it to refill. The meter now pays out
    // once as permanent Overdrive (see onAnyCardDamaged), so nothing ever sets
    // _spinoArmed and this hook could only ever be dead code. Deleted rather
    // than left guarded: a hook that can never fire is a trap for the next
    // person reading the card, and _skipNormalAttack with it — he no longer
    // spends his swing on anything.
    onDeath(G, self, laneIdx) {
      // The habitat goes with him, in the same beat.
      const l = (self._habitatLane !== undefined) ? self._habitatLane : laneIdx;
      const lane = G.state.lanes[l];
      const env = lane && lane._env && lane._env[self.owner];
      if (env && env.name === 'Wetlands') {
        lane._env[self.owner] = null;
        G.log(`  [WETLANDS] Spinosaurus falls — the wetlands drain away with him.`);
        if (typeof UI !== 'undefined' && UI._fxWetlandsDrain) {
          try { UI._fxWetlandsDrain(l, self.owner); } catch (e) {}
        }
      }
    },
  },

  "Gargantua": {
    onTurnStart(G, self) {
      const owner = self.owner;
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;

      const AB = CARD_ABILITIES['Gargantua'];
      // Optional upkeep: pay 1 to pull, skip to do nothing (no collapse).
      if (!G.state._pendingUpkeep) G.state._pendingUpkeep = [];
      G.state._pendingUpkeep.push({
        card: self, owner, label: 'Gargantua',
        onPay()    { AB._doPull(G, self); },
        onDecline() { /* no pull this round — card stays */ },
      });
    },

    _doPull(G, self) {
      const owner = self.owner;
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;
      const opp = G.opponent(owner);

      // Snapshot all enemy (non-environment) cards and their current lanes.
      const targets = [];
      for (let i = 0; i < G.LANE_COUNT; i++) {
        const c = G.state.lanes[i][opp];
        if (c && c.currentHealth > 0 && !c.isEnvironment) targets.push({ card: c, origLane: i });
      }
      // Gravity-well vortex over Gargantua as the pull begins.
      if (targets.length && typeof UI !== 'undefined' && UI._fxGargantuaPull) { try { UI._fxGargantuaPull(self); } catch (e) {} }

      // Pull closest enemies first to chain moves without cascading conflicts.
      targets.sort((a, b) => {
        const da = Math.abs(a.origLane - laneIdx);
        const db = Math.abs(b.origLane - laneIdx);
        return da !== db ? da - db : a.origLane - b.origLane;
      });

      for (const { card } of targets) {
        if (card.currentHealth <= 0) continue;
        const curLane = G.findCardLane(card);
        if (curLane < 0 || curLane === laneIdx) continue;

        const dir = laneIdx > curLane ? 1 : -1;
        const targetLane = curLane + dir;
        // A destroyed (voided) lane blocks the pull — there is no lane to
        // stand in for its remaining rounds, so the card holds position.
        // User report: Gargantua dragged a Doombot into an Anti-Life void.
        if (G.state.lanes[targetLane] && G.state.lanes[targetLane].destroyed) {
          G.log(`[GARGANTUA] ${card.name} braces against the void in lane ${targetLane + 1} — the pull fails.`);
          continue;
        }
        const occupant = G.state.lanes[targetLane][opp];

        if (targetLane === laneIdx && occupant && occupant.currentHealth > 0) {
          // Pulled card enters the Gargantua lane where an enemy already stands.
          const existingAtk = occupant.attack || 0;
          const pulledAtk   = card.attack || 0;
          G.log(`[GARGANTUA] ${card.name} is pulled into lane ${laneIdx + 1} — COLLISION with ${occupant.name}!`);
          G.dealDamage(occupant, pulledAtk, card);
          G.dealDamage(card,     existingAtk, occupant);

          if (occupant.currentHealth <= 0 && card.currentHealth > 0) {
            // Occupant was destroyed; pulled card takes the lane.
            G.state.lanes[curLane][opp]    = null;
            G.state.lanes[laneIdx][opp]    = card;
            G.log(`[GARGANTUA] ${card.name} takes lane ${laneIdx + 1}!`);
            G.checkLaneTrap(card, laneIdx);
            if (card.onMoved) card.onMoved(G, card, laneIdx);
          } else if (card.currentHealth > 0) {
            G.log(`[GARGANTUA] ${card.name} is repelled — both cards survive the collision.`);
          }
        } else if (!occupant || occupant.currentHealth <= 0) {
          // Target lane is clear — pull the card one step toward Gargantua.
          G.state.lanes[curLane][opp]     = null;
          G.state.lanes[targetLane][opp]  = card;
          G.log(`[GARGANTUA] ${card.name} pulled from lane ${curLane + 1} → lane ${targetLane + 1}.`);
          G.checkLaneTrap(card, targetLane);
          if (card.onMoved) card.onMoved(G, card, targetLane);
        } else {
          // Another enemy already occupies the intermediate lane — card is blocked.
          G.log(`[GARGANTUA] ${card.name} is blocked — lane ${targetLane + 1} is occupied.`);
        }
      }

      if (typeof UI !== 'undefined' && UI.render) UI.render();
    },
  },
};

// Merge abilities into CARD_DEFS (cards.js must load before this file)
CARD_DEFS.forEach(card => {
  const ab = CARD_ABILITIES[card.name];
  if (ab) Object.assign(card, ab);
});

// …and into the SUMMON TOKEN defs, on the same terms. These are a separate
// list because tokens are not draftable, but they are still card definitions
// and anything built from one (the codex entry, a test instance) must carry
// the same hooks a drafted card would. Battle Droid's grow-on-revive was the
// first token ability, and without this it existed only on the instance
// summonCard happens to build — the def itself was inert.
if (typeof SUMMON_TOKEN_DEFS !== 'undefined') {
  SUMMON_TOKEN_DEFS.forEach(tok => {
    const ab = CARD_ABILITIES[tok.name];
    if (ab) Object.assign(tok, ab);
  });
}
