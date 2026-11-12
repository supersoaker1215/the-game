// ============================================================
// CARD ABILITIES — callback functions and special properties
// Keyed by card name; merged into CARD_DEFS at load time.
// ============================================================

// AI target picker — `aiPicker` callback for damage / destroy / control
// abilities, so the AI removes the most impactful threat rather than the
// most expensive or highest-ATK card.
// Routes through Game.pickBiggestThreat (board-aware: an enemy about to kill
// one of ours outranks one already walled off by an invincible blocker), the
// same question the trick pickers ask. AI.threatScore reads only a card's own
// keywords and attack, so it is the fallback; cost+ATK covers AI not loaded
// (abilities.js loads before ai.js).
const _aiThreatPicker = (cards) => {
  if (!cards || !cards.length) return null;
  if (typeof Game !== 'undefined' && Game.pickBiggestThreat && cards[0] && cards[0].owner) {
    const picker = Game.opponent(cards[0].owner);
    const best = Game.pickBiggestThreat(cards, picker);
    if (best) return best;
  }
  return cards.slice().sort((a, b) => {
    if (typeof AI !== 'undefined' && AI.threatScore) {
      return AI.threatScore(b) - AI.threatScore(a);
    }
    return ((b.attack || 0) + (b.cost || 0) * 0.5) - ((a.attack || 0) + (a.cost || 0) * 0.5);
  })[0];
};

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

// ============================================================
// HABITAT -> MONSTER, ONCE
// ============================================================
// Boiler Room → Freddy, Sewers → Pennywise, Open Water → Jaws, Wetlands →
// Spinosaurus, Enclosure → T-Rex all run the same sequence. Only the Enclosure
// uses this helper; the other four keep their own copies and are the next
// migration, one card at a time, against the golden suite.
//
//   1. hand the lane back — every habitat is REPLACED by what it births
//   2. get the ally in the lane out of the way, or absorb it
//   3. clear a corpse the death machinery has not swept yet
//   4. summon, and verify something actually landed before touching its stats
//   5. announce
function releaseHabitatMonster(G, o) {
  const owner = o.owner;
  // The monster's side is not always the habitat owner's: Jaws, Pennywise,
  // Freddy and Spinosaurus join the owner, the Enclosure (a toll) releases
  // onto the OPPONENT's side. Read from the def (actsOnOpponentSide), not
  // passed in, because the lane backdrop paints on the same half and must
  // read the same declaration. `into` still overrides; everything else here,
  // including the env slot handed back, belongs to `owner`.
  const side = o.into
    || ((o.habitat && o.habitat.actsOnOpponentSide) ? G.opponent(owner) : owner);
  const laneIdx = o.laneIdx;
  const lane = G.state && G.state.lanes && G.state.lanes[laneIdx];
  if (!lane) return;
  const tag = o.tag || String(o.name || '').toUpperCase();
  // THE HABITAT HANDS THE LANE BACK FIRST. Done after the summon it would be
  // the env slot of a lane the monster is already standing in.
  if (o.clearEnv && lane._env && lane._env[owner] === o.habitat) lane._env[owner] = null;
  const def = (typeof CARD_DEFS !== 'undefined')
    ? CARD_DEFS.find(d => d.name === o.name) : null;
  // The card that has to make room is the one on the MONSTER's side of the
  // lane.
  const allyInLane = lane[side];

  const finishSpawn = (atk, hp) => {
    // A DEAD OCCUPANT STILL HOLDS THE SLOT. handleDeath defers clearing to
    // cleanupDead (and may only queue the death), and summonCard bails on an
    // occupied lane.
    if (lane[side] && lane[side].currentHealth <= 0) lane[side] = null;
    const before = G.state.lanes[laneIdx][side];
    G.summonCard(side, laneIdx, o.name, o.cost || 0, atk, hp, o.abilities || [], def);
    const born = G.state.lanes[laneIdx][side];
    // VERIFY BEFORE STAMPING: never write the monster's stats onto a card
    // that was already there.
    if (!born || born === before || born.name !== o.name) {
      G.log(`  [${tag}] ${o.name} can't take lane ${laneIdx + 1} — it is still occupied.`);
      return;
    }
    // summonCard ignores atk/hp when a sourceDef is passed; set them directly.
    born.attack = atk;
    born.currentHealth = hp;
    born.maxHealth = hp;
    G.log(`${o.name} is released into lane ${laneIdx + 1}!`);
    if (o.onSpawned) { try { o.onSpawned(born, laneIdx); } catch (e) {} }
  };

  if (allyInLane && allyInLane.currentHealth > 0) {
    const openLanes = G.getOpenLanes(side).filter(l => l !== laneIdx);
    if (openLanes.length > 0) {
      G.promptLaneChoice(side, openLanes,
        `${o.name} — Move ${allyInLane.name}`,
        `${o.name} takes this lane. Move ${allyInLane.name} to another lane.`,
        (targetLaneArg) => {
          let targetLane = targetLaneArg;
          // RE-CHECK ON RESOLVE. The ally was alive when this armed; a prompt is
          // answered later and a kill can still be cascading, so putting it back
          // on the board unchecked resurrects a corpse.
          const stillThere = allyInLane
            && allyInLane.currentHealth > 0
            && lane[side] === allyInLane;
          if (!stillThere) {
            G.log(`  [DISPLACE SKIPPED] ${allyInLane ? allyInLane.name : 'the ally'} did not survive to be moved.`);
            finishSpawn(o.atk, o.hp);
            return;
          }
          // THE DESTINATION IS RE-CHECKED, NOT TRUSTED. openLanes was computed
          // when the prompt armed; a summon, jump or another release may have
          // taken that lane since. Writing into it anyway puts one card in two
          // places (events fire every 3 rounds, so this path is frequent).
          const dest = G.state.lanes[targetLane];
          if (!dest || dest.destroyed || dest[side]) {
            const retry = G.getOpenLanes(side).filter(l => l !== laneIdx);
            if (!retry.length) {
              G.log(`  [DISPLACE SKIPPED] no lane left for ${allyInLane.name} — ${o.name} takes the lane anyway.`);
              finishSpawn(o.atk, o.hp);
              return;
            }
            targetLane = retry[0];
          }
          lane[side] = null;
          G.state.lanes[targetLane][side] = allyInLane;
          G.log(`  [DISPLACED] ${allyInLane.name} moved to lane ${targetLane + 1} to make room for ${o.name}.`);
          G.checkLaneTrap(allyInLane, targetLane);
          if (allyInLane.onMoved) allyInLane.onMoved(G, allyInLane, targetLane);
          finishSpawn(o.atk, o.hp);
        });
    } else {
      const extraAtk = allyInLane.attack;
      const extraHp  = allyInLane.currentHealth;
      G.log(`  [ABSORB] ${o.name} absorbs ${allyInLane.name} (+${extraAtk}/+${extraHp})!`);
      // Absorbed is genuinely dead: zero it BEFORE handleDeath so nothing
      // downstream reads it as alive, then free the slot here (handleDeath
      // does not reliably clear it — see finishSpawn).
      allyInLane.currentHealth = 0;
      G.handleDeath(allyInLane, laneIdx, null);
      if (lane[side] === allyInLane) lane[side] = null;
      finishSpawn(o.atk + extraAtk, o.hp + extraHp);
    }
  } else {
    finishSpawn(o.atk, o.hp);
  }
}
if (typeof window !== 'undefined') window.releaseHabitatMonster = releaseHabitatMonster;

// ============================================================
// COG INVASION — shared Cog combat helpers
// ============================================================
// A Cog is a neutral invader seated on one side; it swings automatically, so
// its signature attack aims at the enemy directly opposite, falling back to
// any live enemy. freezeCard IS the Stun/knock-down (Stun is deprecated; see
// game.js near tickStun).
function _cogTarget(G, self) {
  const opp = G.opponent(self.owner);
  const lane = G.findCardLane(self);
  const front = lane >= 0 && G.state.lanes[lane] ? G.state.lanes[lane][opp] : null;
  if (front && front.currentHealth > 0 && !front.isFaceDown) return front;
  const enemies = G.getEnemiesOf(self.owner).filter(e => e.currentHealth > 0 && !e.isFaceDown);
  return enemies.length ? enemies[Math.floor(G.rng() * enemies.length)] : null;
}
// Power Trip: every 3rd round since this copy spawned, 2 damage to ALL enemies.
// Runs at most once per round. Three of the four Cogs share it (the Big Cheese
// trades it for a bigger single hit).
function _cogPowerTrip(G, self) {
  const spawn = self._cogSpawnRound || self.statsEnteredRound || (G.state.round || 1);
  const elapsed = (G.state.round || 1) - spawn;
  if (elapsed <= 0 || elapsed % 3 !== 0) return;
  if (self._cogPowerTripRound === (G.state.round || 1)) return;
  self._cogPowerTripRound = (G.state.round || 1);
  const enemies = G.getEnemiesOf(self.owner).filter(c => c && c.currentHealth > 0);
  if (typeof UI !== 'undefined' && UI._fxPowerTrip) { try { UI._fxPowerTrip(self, enemies); } catch (e) {} }
  enemies.forEach(c => G.dealDamage(c, 2, self));
  if (enemies.length) G.log(`  [POWER TRIP] ${self.name} shocks all enemies for 2!`);
}
if (typeof window !== 'undefined') { window._cogTarget = _cogTarget; window._cogPowerTrip = _cogPowerTrip; }

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
    // DESTROY FIRST, THEN SUMMON. The summon opens a lane prompt; killing
    // first means the board the player places the Ant into is the board they
    // will actually have.
    onPlay(G, self, lane) {
      if (typeof UI !== 'undefined' && UI._fxAntManPym) { try { UI._fxAntManPym(self); } catch (e) {} }
      // _antManAntAtk / _antManAntHp let Text+ bump the summoned Ant
      // beyond its 1/1 base. Default 1/1 (classic); Text+ sets 4/4.
      const summonAnt = () => {
        const antAtk = self._antManAntAtk || 1;
        const antHp  = self._antManAntHp  || 1;
        G.summonCardChoice(self.owner, "Ant", 1, antAtk, antHp, ["Bullseye"]);
      };
      // Roguelite Text+ override — _antManKillThreshold raises the
      // pick window. Default 1 (classic ≤1 ATK or ≤1 HP); Text+
      // bumps to 2 so 2/2 bodies are also valid targets.
      const t = self._antManKillThreshold || 1;
      const targets = G.getEnemiesOf(self.owner).filter(c => (c.attack <= t || c.currentHealth <= t) && G.canEffectLand(c, 'destroy', { owner: self.owner, source: self }));
      if (!targets.length) { summonAnt(); return; }
      G.promptCardChoice(self.owner, targets, "Ant-Man — Destroy", `Choose an enemy to destroy (${t} ATK or ${t} HP)`, (target) => {
        G.log(`[KILL] ${self.name} destroys ${target.name}!`); G.killCard(target, self);
        // Summon AFTER the kill resolves, so any death trigger it sets off has
        // finished before the player is asked where the Ant goes.
        summonAnt();
      }, _aiThreatPicker);
    }
  },
  "Poison Ivy": {
    // Simplified charm — picks an ally each round and ADDS that ally's
    // current attack to Ivy's for this turn only (base 1 + Venom's 3 → 4).
    // grantTempBuff(duration=1) auto-expires in postCombat via
    // expireGrantedBuffs — no custom cleanup path.
    _charm(G, self) {
      // Also keep a direct ref on Ivy for the damage-preview UI (_ivyAlly).
      // Strip any existing _ivyCharm buff before re-charming — onPlay and
      // onBeforeTricks can both fire in one round and would double-stack.
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
      // Clear the previous target's _charmedByIvy tag so the badge moves on
      // re-pick. The tag mirrors _ivyAlly.id so the badge renderer doesn't
      // depend on object identity (breaks across re-instantiation / saves).
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
      // ally's attack instead of a random one (default random).
      const pick = self._ivyChooseHighest
        ? allies.slice().sort((a, b) => (b.attack || 0) - (a.attack || 0))[0]
        : allies[Math.floor(Game.rng() * allies.length)];
      self._ivyAlly = pick;
      self._ivyCharmedId = pick.id; // tracked so handleDeath can strip the buff
      // Stamp a flag on the charmed ally pointing back at Ivy; the badge
      // renderer reads it (more reliable than object identity across
      // getAllCardsOnBoard calls).
      pick._charmedByIvy = self.id;
      // Pheromone bloom on the charmed ally + a vine drawing its strength to Ivy.
      if (typeof UI !== 'undefined' && UI._fxIvyCharm) { try { UI._fxIvyCharm(self, pick); } catch (e) {} }
      const bonus = pick.attack || 0;
      if (bonus > 0) {
        // Temp buff, auto-expires after 1 turn. Tagged _ivyCharm so
        // handleDeath can reverse it if the charmed ally dies mid-turn (the
        // bonus is tied to a living target).
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
      // Re-charm at start of tricks (endPhase2), after BOTH players have
      // deployed, so freshly played allies are in the pool. The target is
      // LOCKED for the rest of the round — combat doesn't re-pick.
      CARD_ABILITIES['Poison Ivy']._charm(G, self);
    },
    onEndOfTurn(G, self) {
      // Post-combat — if the charmed ally died, re-charm a living ally so the
      // CHARMED badge is always on someone (mirrors Joker's onEndOfTurn).
      const target = self._ivyAlly;
      const alive = target && target.currentHealth > 0 && G.findCardLane(target) >= 0;
      if (alive) return;
      CARD_ABILITIES['Poison Ivy']._charm(G, self);
    },
    onAnyCardPlayed(G, self) {
      // During the PLAY phase, re-charm as soon as an ally arrives if Ivy
      // has no living target, so the badge tracks the board. Once tricks or
      // combat begin the charm is fixed for the round: if the target dies,
      // the buff goes with it and there is no re-pick until onEndOfTurn.
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
      // Roguelite Text+ ("Wide Web") — _blackWidowSplashFreeze freezes the
      // front enemy AND both adjacent enemies automatically (no prompt).
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
    // Arrival sting — fires wherever Man-Bat lands, by ANY mover (his own
    // flight, Magneto, Gojo, Bifrost, hunts): moveCard and every direct-
    // assignment mover fire onMoved after relocation, so the sting tracks the
    // LANDING lane, and never fires when moveCard refuses the move.
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
      // Freeze gates the whole ability. The arrival debuff lives in onMoved,
      // so no debuff here or it would double-sting.
      // isMoveLocked, not isActionLocked: covers freeze/fear PLUS Gargantua's
      // hold. moveCard refuses either way, but asking here stops the card
      // offering a lane prompt it cannot honour. Every self-mover does this.
      if (Game.isMoveLocked(self)) {
        G.log(`  [SKIP] ${self.name} is ${Game.moveLockLabel(self)} — stays put.`);
        return;
      }
      const open = G.getOpenLanes(self.owner).filter(l => l !== lane);
      if (!open.length) return;
      // The player may decline to move — no move, no sting.
      if (Game.isHuman(self.owner)) {
        // STAY is a BUTTON, not a lane (promptLaneChoice options.declineLabel):
        // his own lane is covered by the card itself, so it can't be clicked.
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
    // GROWTH IS THE MOVE — ANY move, not just his own flutter. moveCard fires
    // this hook for every mover (Bifrost, Magneto, Gargantua's pull, Gojo,
    // hunts), so the card text is literally true. Enemy-caused moves count
    // too, deliberately.
    // Only NEW ground pays: he tallies every lane he has stood in, and a new
    // lane is +1/+1 while a revisited one is nothing. Without the tally a
    // 1→2→1→2 bounce makes him an infinite engine; six lanes caps him at 5/6.
    // The lane he was PLAYED into is seeded as visited in onPlay, so the
    // first flutter is his first buff.
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
      // See Man-Bat for why this asks isMoveLocked and not isActionLocked.
      if (Game.isMoveLocked(self)) {
        G.log(`  [SKIP] ${self.name} is ${Game.moveLockLabel(self)} — stays put.`);
        return;
      }
      // "Open" means EMPTY ON BOTH SIDES — he relocates to unoccupied ground,
      // never into an enemy-held lane (getOpenLanes(owner) checks only his own
      // side, so it isn't enough).
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
        // No growth stamped here — it lives in onMoved so every mover pays,
        // not just his own flutter.
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
      // 2v2 a side is a team whose proxy is bound to the acting seat, so a
      // plain call draws once per team. forEachSeatOnSide draws for each real
      // seat; in 1v1 a side IS a player.
      G.forEachSeatOnSide(self.owner, () => G.drawCards(self.owner, n));
      G.forEachSeatOnSide(G.opponent(self.owner), () => G.drawCards(G.opponent(self.owner), n));
      G.log(`Harley Quinn makes everyone draw ${n}!`);
      if (typeof UI !== 'undefined' && UI._fxHarleyChaos) { try { UI._fxHarleyChaos(self); } catch (e) {} }
      // First ATK roll happens immediately on play — startRound's
      // sweep handles subsequent rerolls via the Crazy trait.
      G.rerollCrazyInsane(self);
    },
    // No onTurnStart — the Crazy trait is rerolled centrally in startRound
    // via G.rerollCrazyInsane; a per-card hook would double the log line.
    onBeforeAttack(G, self) {
      G.damagePlayer(self.owner, 1, false);
      G.log(`[HIT] Harley Quinn deals 1 to her own team before attacking!`);
    },
    onDamaged(G, self) {
      // Roguelite Text+ ("Chaos!") — _harleyBlockOnDmg adds N to the owner's
      // Block Meter whenever Harley takes damage (default 0, Text+ 3).
      const gain = self._harleyBlockOnDmg || 0;
      if (gain <= 0) return;
      const meter = G.getBlockMeter(self.owner);
      G.addBlockMeter(self.owner, gain);
      G.log(`Harley Quinn cackles — +${gain} Block Meter!`);
    }
  },
  "Jango Fett": {
    // The roguelite "Jetpack Salvo" upgrade is a Man-Bat-style relocation,
    // which recurs; without this flag it moved him once per run.
    _recurringBT: true,
    onMoved(G, self, toLane) {
      // Roguelite Text+ override — _jangoSplashOnMove scales the arrival
      // splash (default 1, Text+ 2).
      const dmg = self._jangoSplashOnMove || 1;
      if (typeof UI !== 'undefined' && UI._fxJangoRockets) { try { UI._fxJangoRockets(self, toLane); } catch (e) {} }
      G.splashDamage(toLane, self.owner, dmg, self);
      G.log(`Jango Fett splashes lane ${toLane + 1} for ${dmg} on arrival!`);
    },
    onBeforeTricks(G, self, lane) {
      // Roguelite Text+ ("Jetpack Salvo") — _jangoMoveLikeManBat gives Jango
      // a Man-Bat-style relocation at Start of Tricks; onMoved supplies the
      // splash. Gated — classic Jango doesn't move.
      if (!self._jangoMoveLikeManBat) return;
      // See Man-Bat for why this asks isMoveLocked and not isActionLocked.
      if (Game.isMoveLocked(self)) {
        G.log(`  [SKIP] ${self.name} is ${Game.moveLockLabel(self)} — stays put.`);
        return;
      }
      const open = G.getOpenLanes(self.owner).filter(l => l !== lane);
      if (!open.length) return;
      if (Game.isHuman(self.owner)) {
        // STAY is a BUTTON, not a lane (promptLaneChoice options.declineLabel):
        // his own lane is covered by the card itself, so it can't be clicked.
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
      // Roguelite rarity variant — cost gate scales with tier (classic, no
      // _runRarity, = 'rare' ≤3): common ≤1, rare ≤3, special ≤5,
      // legendary ≤9.
      // Roguelite Text+ ("Brute Telepath") — _groddMcCostMax overrides the
      // rarity gate with a fixed ceiling (5).
      const maxCost = self._groddMcCostMax
        ? self._groddMcCostMax
        : G.rarityValue(self, { common: 1, rare: 3, special: 5, legendary: 9 });
      // JUGGERNAUT PROTECTS ONLY WHAT HIS TEXT SAYS (himself + adjacent allies
      // via Immunity), not the whole board. mindControlCard routes through
      // tryApplyDebuff, which spends Immunity, so every enemy under the cost
      // gate is offered and whoever holds Immunity resists when it lands.
      const eligible = G.getEnemiesOf(self.owner)
        .filter(e => (e.baseCost || e.cost) <= maxCost);
      if (!eligible.length) {
        G.log(`Gorilla Grodd finds no weak minds (no enemy with base cost ≤ ${maxCost}) to control.`);
        return;
      }
      // Seat declared from the card itself — see promptCardChoice's note on
      // options.seat; otherwise the prompt can reach the wrong client.
      G.promptCardChoice(self.owner, eligible,
        "Gorilla Grodd — Mind Control",
        `Choose an enemy with base cost ${maxCost} or less`,
        (target) => {
          if (G.mindControlCard(target, self, () => { target.mindControlTarget = null; })) {
            G.log(`Gorilla Grodd seizes ${target.name}'s mind!`);
            if (typeof UI !== 'undefined' && UI._fxGroddMindControl) { try { UI._fxGroddMindControl(self, target); } catch (e) {} }
          }
        },
        cards => cards.slice().sort((a, b) => (b.baseCost || b.cost) - (a.baseCost || a.cost))[0],
        // Same tray as Deathstroke, for the same reason — see the note there.
        { inlineTray: true, seat: self._2v2PlayedBy || null });
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
      // The next two cards drawn cost 1 less, plus the "Draw 1" keyword.
      // Roguelite Text+ overrides — _fantasticDiscount scales the per-draw
      // rate; _fantasticCount sets how many draws benefit.
      const disc = (self && self._fantasticDiscount) || 1;
      const count = (self && self._fantasticCount) || 2;
      // Per-draw rate is the max in flight (larger discount wins); count
      // accumulates so back-to-back discards each hand out their share.
      // WRITE IT WHERE drawCards READS IT. In 1v1 that is the side. In 2v2
      // drawCards resolves a SEAT (_2v2HandTarget) and reads the discount off
      // it; writes to the shared side proxy are never seen. `self` makes the
      // seat resolve to whoever played HIM, not whoever is acting.
      const tgt = (G._2v2HandTarget ? G._2v2HandTarget(owner, self) : G.state[owner]) || G.state[owner];
      tgt.nextDrawDiscount = Math.max(tgt.nextDrawDiscount || 0, disc);
      tgt.nextDrawDiscountCount = (tgt.nextDrawDiscountCount || 0) + count;
      // Track the Mr. Fantastic instance that set this so drawCards can
      // credit him with actual `statsDiscountValue` at apply time.
      if (self) tgt._nextDrawDiscountSource = self;
      // "Draw 1" keyword effect — done AFTER setting the discount so the
      // drawn card itself is cheaper.
      G.drawCards(owner, 1);
    }
  },
  "Pinhead": {
    // Discard trigger, like Mr. Fantastic / Jigsaw / Brainiac — Pinhead is
    // isDiscardEffect, so he is never seated; discarding him fires this. He
    // CHAINS two cards in one enemy hand (both badged, linked by
    // _chainPartnerId): neither can be played alone, and playing one drags in
    // its partner, both at -1/-1 (Game._playChainedCard). He also moves one
    // Block Meter section from the enemy to you.
    isDiscardEffect: true,
    onDiscard(G, owner, self) {
      // No chain FX here: this runs before the cards are chosen, and they sit
      // in the ENEMY's hand off-screen, so there is nothing to anchor to.
      const opp = G.opponent(owner);
      // Which hand to raid. 1v1: the opponent's. 2v2: a random ENEMY seat that
      // has ≥2 cards (the two chained cards must share a hand, per "2 random
      // cards in the opponent's hand"). Falls back to any enemy seat.
      let victimHand = null, victimName = 'the enemy';
      const tt = G.state.twoVTwo;
      if (G.is2v2 && G.is2v2() && tt) {
        const myTeam = (tt.players[self._2v2PlayedBy] && tt.players[self._2v2PlayedBy].team)
          || (owner === 'player' ? 'A' : 'B');
        const foes = ['p1', 'p2', 'p3', 'p4'].filter(pk => tt.players[pk] && tt.players[pk].team !== myTeam);
        const withTwo = foes.filter(pk => (tt.players[pk].hand || []).length >= 2);
        // THE PLAYER PICKS THE HAND, through _2v2ChooseEnemySeat like
        // Brainiac and Catwoman, so the prompt looks and routes identically.
        // It auto-resolves with one legal target, and the AI picker keeps AI
        // seats from stalling.
        const _pref = withTwo.length ? withTwo : foes;
        let _chosen = null;
        if (G._2v2ChooseEnemySeat && _pref.length > 1) {
          G._2v2ChooseEnemySeat(owner, 'Pinhead — Choose a Hand',
            'Whose hand should the chains bind?',
            (seat) => { if (seat && _pref.indexOf(seat) >= 0) _chosen = seat; });
        }
        const pick = _chosen || _pref[Math.floor(G.rng() * _pref.length)];
        if (pick && tt.players[pick]) { victimHand = tt.players[pick].hand; victimName = tt.players[pick].name || 'the enemy'; }
      } else {
        victimHand = G.state[opp] && G.state[opp].hand;
      }

      // ── Chain the CHEAPEST card to a random one ──
      // The cheap card is the one they were counting on playing; it becomes
      // hostage to something they usually can't afford the same turn. Cost
      // ties break at random so the same 1-drop isn't always picked.
      const pool = (victimHand || []).filter(c => c && !c._chained);
      if (pool.length >= 2) {
        const costOf = (c) => (c.baseCost != null ? c.baseCost : (c.cost | 0));
        let low = Infinity;
        pool.forEach(c => { const v = costOf(c); if (v < low) low = v; });
        const cheapest = pool.filter(c => costOf(c) === low);
        const a = cheapest[Math.floor(G.rng() * cheapest.length)];
        const rest = pool.filter(c => c !== a);
        const b = rest[Math.floor(G.rng() * rest.length)];
        a._chained = true; a._chainPartnerId = b.id; a._chainPartnerName = b.name;
        b._chained = true; b._chainPartnerId = a.id; b._chainPartnerName = a.name;
        G.log(`[PINHEAD] Chains bind ${victimName}'s cheapest card ${a.name} (${low}) to ${b.name} — they must be played together, each at -1/-1.`);
      } else {
        G.log(`[PINHEAD] ${victimName} hasn't enough cards to chain.`);
      }

      // ── Steal 1 Block Meter from the enemy ──
      // getBlockMeter/setBlockMeter handle the 2v2 team meter, so no
      // hand-written 2v2 branch here.
      try {
        const take = Math.min(1, G.getBlockMeter(opp));
        if (take > 0) {
          G.addBlockMeter(opp, -take);
          G.addBlockMeter(owner, take);
          G.log(`[PINHEAD] Drags 1 Block Meter from the enemy${G.is2v2 && G.is2v2() ? ' team' : ''} onto yours.`);
        }
      } catch (e) { console.error('[Pinhead block steal]', e); }
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
      if (typeof UI !== 'undefined' && UI._fxSabertoothRage) { try { UI._fxSabertoothRage(self); } catch (e) {} }
      G.log(`Sabertooth grows! +${n}/+${n}`);
    }
  },
  "Xenomorph": {
    onAnyCardPlayed(G, self, played) {
      // NOT FED BY ENVIRONMENTS. playCard's environment branch broadcasts
      // onAnyCardPlayed like the normal branch, but an environment never
      // enters a combat slot (it sits in the lane's _env sub-slot), so it
      // isn't "a card entering the board" — same rule as Apocalypse.
      // The played card is the hook's THIRD argument (broadcastHook calls
      // c[hook](G, c, ...args) with args = [card]).
      if (played && played.isEnvironment) return;
      // Roguelite rarity variant — buff size scales with tier (classic +1/+1):
      // common +1 ATK only (a real downside), rare +1/+1, special +1/+2,
      // legendary +2/+2.
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
    // Roguelite Text+ ("Apex Predator") wires onKill to buff +N/+N per kill;
    // the flag is set in apply, so un-upgraded King Sharks get no buff.
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
          // allowKill=true so a 1-HP enemy actually dies from the -1/-1
          // (otherwise HP floors at 1).
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
      // Cost-1 1/1 with Bullseye + Evade 1 (def-side). On play she steals N
      // energy from the opponent next turn.
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
      // 2v2: Catwoman's owner CHOOSES which enemy player to steal from, and
      // the energy goes to the player who placed her. 1v1 resolves immediately.
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
      // The aura refresh has to run EVERY round, like the two hooks under
      // it. It is not a one-shot effect; it is upkeep.
      _recurringBT: true,
      onBeforeTricks(G, self) { refreshAura(G, self); },
      onBeforeAttack(G, self) { refreshAura(G, self); },
      onAllyKilled(G, self) { refreshAura(G, self); },
      // When Dr. Strange dies, strip the aura from any tagged allies
      onDeath(G, self) { clearAura(G, self); }
    };
  })(),
  "Gamora": {
    onPlay(G, self, lane) {
      // Lone Wolf is a universal engine rule (playCard/summonCard apply +1/+1
      // to any card entering alone); Gamora must not add her own or it
      // double-stacks. She only does her execute on entry.
      // Roguelite Text+ override — _gamoraExecuteThreshold raises the execute
      // ceiling (default 2, Text+ 4).
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
      // Roguelite Text+ ("Mass Hysteria") swaps the classic (2/1) Bullseye
      // summon for Overdrive + Evade 3 (added in apply) plus +1/+1 per card
      // in hand on play; only the hand-count buff is handled here.
      // Classic path: spawn the (2/1) Bullseye summon.
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
      // CAPTURE THE ACTING SEAT NOW, before the arrival splash. splashDamage
      // fires other cards' onDamaged/onDeath hooks, which can reassign
      // G._2v2CurrentActingPlayer; an unowned Burning prompt stalls the online
      // table. Name the seat explicitly, like Symbiote Spider-Man.
      const tt = G.state && G.state.twoVTwo;
      const blastSeat = (tt && tt.online)
        ? (self._2v2PlayedBy || G._2v2CurrentActingPlayer || (G._2v2ActivePlayer && G._2v2ActivePlayer()))
        : null;
      // Flame-on cue — fire Human Torch's ability sound (CARD_SFX) from his
      // own onPlay, like Predator / Spider-Man. Guarded so the sim no-ops.
      if (typeof UI !== 'undefined' && UI.sfx) {
        try { UI.sfx.playCardSfx('Human Torch', 'ability', self); } catch (e) {}
      }
      // Roguelite Text+ override — _humanTorchBlast scales the burn (default
      // 2, Text+ 4). It applies Burning N (ticks N, N-1, … 0 on the target's
      // lane) through the shared applier every Burning source uses.
      const blast = self._humanTorchBlast || 2;
      // Total damage the burn will eventually deal — N + (N-1) + … + 1. The
      // AI kill-picker needs the TOTAL, not the first tick.
      const blastTotal = (blast * (blast + 1)) / 2;
      // _humanTorchArrivalSplash scales the splash on entry. Default 1
      // (classic); Text+ raises to 3.
      const arrival = self._humanTorchArrivalSplash || 1;
      G.splashDamage(lane, self.owner, arrival, self);
      G.log(`Human Torch ignites on arrival — Splash ${arrival}!`);
      const enemies = G.getEnemiesOf(self.owner).filter(t => G.canEffectLand(t, 'damage', { owner: self.owner, source: self }));
      if (enemies.length) {
        // Re-assert the captured seat: the splash above may have moved the
        // acting-seat global, and the { seat } option is what routes this prompt
        // to Torch's own player instead of stranding the table.
        if (blastSeat) G._2v2CurrentActingPlayer = blastSeat;
        G.promptCardChoice(self.owner, enemies, "Human Torch — Blast", `Choose enemy to apply Burning ${blast}`, (t) => {
          if (typeof UI !== 'undefined' && UI._fxHumanTorchFlame) { try { UI._fxHumanTorchFlame(self, t); } catch (e) {} }
          CARD_ABILITIES['Godzilla']._ignite(G, t, blast);
          G.log(`Human Torch sets ${t.name} ablaze — Burning ${t.burnStacks}!`);
        }, cards => _aiKillPicker(cards, blastTotal), blastSeat ? { seat: blastSeat } : undefined);
      }
    }
  },
  "Invisible Woman": {
    onPlay(G, self, lane) {
      // Roguelite Text+ ("Force Field") swaps the classic Evade grant for
      // Invincibility N turns + (+M/+M) (_iwInvincibility / _iwBuffSize, set
      // in apply); default is the Evade grant scaled by _iwEvadeAmount.
      const invincN = self._iwInvincibility || 0;
      const buffN = self._iwBuffSize || 0;
      const evadeN = self._iwEvadeAmount || 1;
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id);
      const grant = (a) => {
        if (typeof UI !== 'undefined' && UI._fxInvisibleWomanField) { try { UI._fxInvisibleWomanField(self, a); } catch (e) {} }
        if (invincN > 0) {
          // Permanent stat bump so the +3/+3 outlasts the Invincibility window
          // (Yoda / Star-Lord convention); Invincibility uses grantTempBuff.
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
      // Roguelite Text+ override — _nightwingDebuff scales the ATK strip
      // (default 2, Text+ 3).
      const debuff = self._nightwingDebuff || 2;
      const enemies = G.getEnemiesOf(self.owner).filter(t => (t.attack || 0) > 0 && G.canEffectLand(t, 'debuff', { owner: self.owner, source: self }));
      if (enemies.length) {
        // { seat } routes the choice to the Nightwing owner's seat: an AI
        // owner auto-picks via _aiThreatPicker, only a HUMAN owner is asked.
        // Without it an AI-played Nightwing in 2v2 hands the pick to a human
        // teammate — whoever plays the card chooses.
        G.promptCardChoice(self.owner, enemies, "Nightwing — Weaken", `Choose enemy to remove ${debuff} Attack from`, (t) => {
          if (typeof UI !== 'undefined' && UI._fxNightwingStrike) { try { UI._fxNightwingStrike(self, t); } catch (e) {} }
          G.debuffCard(t, debuff, 0, false, self); G.log(`Nightwing weakens ${t.name} by ${debuff} ATK!`);
        }, _aiThreatPicker, { seat: self._2v2PlayedBy });
      }
    }
  },
  "Peacemaker": {
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _peacemakerKillThreshold raises the ATK
      // ceiling for the eliminate (default 2, Text+ 4).
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
      // freezes BOTH adjacent enemies (default false — pick 1).
      const freezeAll = !!self._flashFreezeAll;
      if (typeof UI !== 'undefined' && UI._fxFlashDash) { try { UI._fxFlashDash(self, adj[0] || null); } catch (e) {} }
      const freezeTarget = () => {
        if (freezeAll && adj.length) {
          adj.forEach(e => G.freezeCard(e, self));
        } else if (adj.length > 1) {
          G.promptCardChoice(self.owner, adj, "The Flash — Freeze", "Choose adjacent enemy to freeze", (t) => {
            G.freezeCard(t, self);
          });
        } else {
          if (adj.length === 1) G.freezeCard(adj[0], self);
        }
      };
      const setFirst = (who) => {
        G.state._nextFirstPlayer = who;
        G.log(`[FLASH] ${G.seatVerb(who, 'go', 'goes')} first next turn.`);
      };
      const chooseFirst = () => {
        // 2v2 online: "first player" is one of FOUR seats. Offer the whole
        // table; _2v2FirstOverride (read by _2v2ComputePhaseOrder) makes only
        // NEXT round's first play the picked seat — the other three follow
        // the usual interleave.
        const tt = G.state && G.state.twoVTwo;
        if (tt && tt.online) {
          const nextRound = (tt.round || 0) + 1;
          const myTeam = self.owner === 'player' ? 'A' : 'B';
          const actingSeat = G._2v2CurrentActingPlayer;
          if (Game.isHuman(self.owner) && !G._2v2ActingIsAI()) {
            const tiles = G._2v2SLOTS
              .filter(pk => tt.players[pk] && tt.players[pk].team)
              .map(pk => ({
                // ALWAYS THE SEAT'S REAL NAME, never "You": `tt.you` on the
                // machine building these tiles is the host, so "You" would
                // mislabel the host's tile for all four players. Which tile
                // is yours is said once, in the desc.
                name: tt.players[pk].name || pk,
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
      // WHO GOES FIRST IS NOT PART OF THE FREEZE. The card prints two
      // independent effects, so the first-player choice must not wait on the
      // freeze prompt's callback: a stall recovery can clear pending prompts
      // (_forceEndStalledCombat), and a 2v2 prompt raised for the wrong seat
      // is answered by nobody — either would silently drop the choice.
      // AFTER the freeze (unlike Thor, whose thunder can kill the freeze
      // target): nothing here affects the other half, so ask in printed order.
      // freezeTarget() returns once it ARMS its prompt, and the prompt queue
      // keeps the two in order.
      freezeTarget();
      chooseFirst();
    }
  },

  // ==================== COST 3 ====================
  "Ahsoka": {
    onAllyKilled(G, self) {
      // Queue a bonus attack for every ally death, not just the first this combat.
      // Roguelite Text+ override — _ahsokaBonusAttacksPerKill scales bonus
      // attacks per ally death (default 1, Text+ 2).
      const grant = self._ahsokaBonusAttacksPerKill || 1;
      self.bonusAttack = (typeof self.bonusAttack === 'number' ? self.bonusAttack : 0) + grant;
      if (typeof UI !== 'undefined' && UI._fxAhsokaReady) { try { UI._fxAhsokaReady(self); } catch (e) {} }
    }
  },
  "Carnage": {
    onBeforeTricks(G, self, lane) {
      if (self.carnageHealed) return;
      // Roguelite Text+ ("Bloodbath") — _carnageHealAllCards counts EVERY
      // card on the board; classic counts only enemies × _carnageHealMul.
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
        G.log(`${G.seatVerb(self.owner, 'heal', 'heals')} for ${amount} — Carnage!`);
        self.carnageHealed = true;
        if (typeof UI !== 'undefined' && UI._fxCarnageFrenzy) { try { UI._fxCarnageFrenzy(self); } catch (e) {} }
      }
    }
  },
  "Deathstroke": {
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _deathstrokeKillThreshold raises the
      // assassinate ceiling (default 3, Text+ 5).
      const threshold = self._deathstrokeKillThreshold || 3;
      const enemies = G.getEnemiesOf(self.owner);
      const targets = enemies.filter(c => c.currentHealth <= threshold && G.canEffectLand(c, 'destroy', { owner: self.owner, source: self }));
      if (targets.length) {
        G.promptCardChoice(self.owner, targets, "Deathstroke — Assassinate", `Choose enemy with ${threshold} or less HP to destroy`, (t) => {
          if (typeof UI !== 'undefined' && UI._fxDeathstrokeKill) { try { UI._fxDeathstrokeKill(self, t); } catch (e) {} }
          G.log(`Deathstroke assassinates ${t.name}!`); G.killCard(t, self);
          // inlineTray — pick from a tray (its own DOM and buttons, same as the
          // Symbiote shuffle and Deadpool's give-back), so a board click is no
          // longer the only way to answer.
        }, _aiThreatPicker, { inlineTray: true, seat: self._2v2PlayedBy || null });
      } else {
        // NEVER FAIL SILENTLY: with nothing legal to hit, log which case it was
        // and why, so a no-op is distinguishable from a broken ability.
        const low = enemies.filter(c => c.currentHealth <= threshold);
        if (!enemies.length) {
          G.log(`[DEATHSTROKE] No enemy on the field — nobody to assassinate.`);
        } else if (!low.length) {
          G.log(`[DEATHSTROKE] No enemy at ${threshold} HP or less — the closest is ${Math.min.apply(null, enemies.map(c => c.currentHealth))} HP.`);
        } else {
          G.log(`[DEATHSTROKE] ${low.map(c => c.name).join(', ')} ${low.length === 1 ? 'is' : 'are'} in range but cannot be destroyed (invincible, hidden, or titan-immune).`);
        }
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
    // When Damaged (once): spawn a Gremlin into any open lane + add Stripe to
    // hand. Fires on the FIRST hit even if lethal (onDamaged runs before
    // handleDeath in both combat and dealDamage). The once-guard lives on the
    // instance so a revived Gizmo comes back re-armed ("played anew").
    onDamaged(G, self) {
      if (self._gizmoTriggered) return;
      self._gizmoTriggered = true;
      G.log(`[GIZMO] Bright light! Something's multiplying — a Gremlin appears, and Stripe is coming!`);
      if (typeof UI !== 'undefined' && UI._fxGizmoFlash) { try { UI._fxGizmoFlash(self); } catch (e) {} }
      const gremDef = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS.find(d => d.name === 'Gremlin') : null;
      G.summonCardChoice(self.owner, 'Gremlin', 2, 2, 3, [], null, null, gremDef);
      const stripeDef = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS.find(d => d.name === 'Stripe') : null;
      if (stripeDef) {
        const stripe = G.createCardInstance(stripeDef, self.owner);
        if (G.addToHand(self.owner, stripe, self, null, 'Spawned by Gizmo') !== false) {
          G.log(`  [GIZMO] Stripe joins ${G.seatPossessive(self.owner)} hand.`);
        }
      }
    },
  },
  "Gremlin": {
    // Swarm — +1 ATK per other living Gremlin ON THE FIELD (both sides).
    // STRIPE COUNTS AS A GREMLIN for the count but doesn't carry Swarm
    // himself (his bookkeeping lives in his own onPlay/onDeath).
    // Event-driven additive bookkeeping, not a per-tick recalc, so buffs from
    // other sources (Padme, Power Stone) are never clobbered: each arrival
    // buffs itself by the existing count and every existing Gremlin by +1;
    // each death walks it back. onPlay fires for spawns too (summonCard runs
    // the summoned card's onPlay when a full sourceDef is passed).
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
    // His kill feeds the SWARM, not just himself — so it still counts when he
    // dies making it. See the deferred-onKill block in resolveLaneCombat.
    onKillWhenDead: true,
    // Jump condition ("either player takes hero damage") lives in
    // Game.checkJumpConditions under 'heroDamaged', fired from damagePlayer
    // when face damage actually lands.
    // Swarm kinship: Stripe COUNTS AS a Gremlin, so his arrival gives every
    // living Gremlin +1 ATK and his death takes it back. No self-buff; the
    // new-Gremlin side lives in Gremlin's onPlay (kin filter includes Stripe).
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
      // NO "ONLY IF HE SURVIVED" GUARD. Combat DEFERS onKill so both sides'
      // simultaneous swings land first, so in a trade Stripe is already dead
      // when this runs. The condition is the kill, not his survival.
      G.log(`[STRIPE] Stripe tears one down — the swarm feeds!`);
      // Kill feed: PERMANENT +1/+1 to every living friendly Gremlin AND
      // Stripe himself — a deliberate exception to the 1-turn cross-card buff
      // default (the swarm's growth engine). Buff lands BEFORE the spawn so
      // the newcomer arrives at base stats.
      const brood = G.getAlliesOf(self.owner).filter(c =>
        c.name === 'Gremlin' && c.currentHealth > 0);
      brood.forEach(g => { g.attack += 1; g.maxHealth += 1; g.currentHealth += 1; });
      // …but a corpse does not grow. Buffing a dead Stripe's currentHealth
      // above zero would quietly un-kill him on the next sweep.
      if (self.currentHealth > 0) { self.attack += 1; self.maxHealth += 1; self.currentHealth += 1; }
      G.log(`  [STRIPE] Stripe${brood.length ? ` and ${brood.length} Gremlin${brood.length > 1 ? 's' : ''}` : ''} feed on the kill — +1/+1.`);
      const gremDef = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS.find(d => d.name === 'Gremlin') : null;
      G.summonCardChoice(self.owner, 'Gremlin', 2, 2, 3, [], null, null, gremDef);
    },
  },
  "Spawn": {
    // Classic Spawn has no onDeath — a vanilla 3/3 with Bullseye + Overdrive.
    // Roguelite Text+ ("Hellspawn Rises") makes death a self-revive with
    // +5/+5 via reviveCharges = 1 and _draxReviveBuff = 5 (the property keeps
    // its pre-rename Drax name for save-data back-compat).
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
      // Roguelite Text+ override — _goblinBombBoost adds N to each
      // pumpkin-bomb splash (default 0 → 1+2; Text+ 1 → 2+3).
      const boost = self._goblinBombBoost || 0;
      if (typeof UI !== 'undefined' && UI._fxGoblinBombs) { try { UI._fxGoblinBombs(self, lane, self.owner); } catch (e) {} }
      G.splashDamage(lane, self.owner, 1 + boost, self);
      G.splashDamage(lane, self.owner, 2 + boost, self);
      G.log(`Green Goblin throws pumpkin bombs! Splash ${1 + boost} then Splash ${2 + boost}!`);
    },
    onBeforeTricks(G, self, lane) {
      // Freeze blocks the move AND the follow-up splash — moveCard alone isn't
      // enough because the splash fires after a refused move.
      // See Man-Bat for why this asks isMoveLocked and not isActionLocked.
      if (Game.isMoveLocked(self)) {
        G.log(`  [SKIP] ${self.name} is ${Game.moveLockLabel(self)} — stays put.`);
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
        // STAY is a BUTTON, not a lane (promptLaneChoice options.declineLabel):
        // his own lane is covered by the card itself, so it can't be clicked.
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
      // Roguelite Text+ override — _grootProtectsSelf includes Groot in the
      // immunity grant (default false: adjacent allies only).
      const includeSelf = !!self._grootProtectsSelf;
      const lanes = [lane - 1, lane + 1];
      if (includeSelf) lanes.push(lane);
      lanes.forEach(l => {
        if (l >= 0 && l < Game.LANE_COUNT && G.state.lanes[l][own]) {
          G.grantTempBuff(G.state.lanes[l][own], { hasDamageImmunity: true });
        }
      });
      // A LANE SHIELD on the adjacent lanes, like Joker's Playing Card:
      // lane.protected = own stops an UNCONTESTED enemy there swinging at
      // Groot's owner (resolveUncontestedLane and the bonus-attack path honour
      // it). Reset every startRound, so one turn. Adjacent only, never his own
      // lane, matching the immunity grant.
      [lane - 1, lane + 1].forEach(l => {
        if (l >= 0 && l < Game.LANE_COUNT && G.state.lanes[l] && !G.state.lanes[l].destroyed) {
          G.state.lanes[l].protected = own;
          const foe = G.state.lanes[l][G.opponent(own)];
          if (foe && foe.currentHealth > 0 && typeof UI !== 'undefined' && UI._fxTrickDebuff) {
            try { UI._fxTrickDebuff(foe, '#39ff5e', '#0f8a2a'); } catch (e) {}
          }
        }
      });
      G.log(includeSelf
        ? "Groot protects himself AND adjacent allies — and shields the adjacent lanes for 1 turn!"
        : "Groot protects adjacent allies — and shields the adjacent lanes for 1 turn!");
      if (typeof UI !== 'undefined' && UI._fxGrootGuard) { try { UI._fxGrootGuard(self, lane, own); } catch (e) {} }
    }
  },
  "Jigsaw": {
    // Not a discard effect: Jigsaw is _spawnOnly and arrives through the Saw
    // event. The _placeRoom / onDiscard logic below is the basis for the
    // event-driven rework.
    // Environments are normally placed by playCard, which inlines the slot
    // handling and exposes nothing, so this mirrors that block: clear the
    // sub-slot on EITHER side (a live env left dangling keeps receiving
    // broadcasts), seat the new room, announce it, run its own On Play.
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
        // Frozen enemies are locked in their lane, so they're not pickable.
        const enemies = G.getEnemiesOf(owner).filter(e => !e.isFrozen && !e.isStunned);
        if (!enemies.length) { G.log("Jigsaw finds no enemy cards left to drag."); return; }
        // Same guard as Gojo / Darth Vader: with no open enemy-side lane there
        // is no destination, so don't spend the player's choice timer.
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

      // ROOMS, NOT TRAPS: two environments; the relocate step below is kept.
      // Placed into lanes EMPTY ON THE ENEMY SIDE, since a room only matters
      // to a card that walks in afterwards.
      const ROOMS = ['The Bathroom', 'Game Over'];
      const placeRoomStep = (idx) => {
        if (idx >= ROOMS.length) { moveEnemyStep(); return; }
        const name = ROOMS[idx];
        const open = [];
        for (let i = 0; i < G.LANE_COUNT; i++) {
          const l = G.state.lanes[i];
          if (l.destroyed || l[opp]) continue;
          // Cover rule: a room may land on a lane with an environment only
          // when no free lane is left. Placement is sequential, so the second
          // room sees the first's lane as taken — intended.
          if (typeof G.canPlaceEnvironment === 'function' && !G.canPlaceEnvironment(owner, i)) continue;
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

  // ==================== COG INVASION — the four Cogs ====================
  // 3-cost 4/6 invaders. The signature fires on landing (onPlay); the shared
  // Power Trip runs on the combat step (onBeforeAttack) as a bonus — the Cog
  // also swings normally. Their VP's protection (§2.5) is enforced from the
  // damage path in game.js while the VP lives.
  "Mr. Hollywood": {
    onPlay(G, self, lane) {
      const t = _cogTarget(G, self);
      if (!t) return;
      G.log(`  [BEGUILE] Mr. Hollywood dazzles ${t.name} — 3 damage and Stun.`);
      if (typeof UI !== 'undefined' && UI._fxCogStrike) { try { UI._fxCogStrike(self, t, 'beguile'); } catch (e) {} }
      G.dealDamage(t, 3, self);
      if (t.currentHealth > 0) G.freezeCard(t, self, 1);   // Stun == freeze in this engine
    },
    onBeforeAttack(G, self) {
      if (self.isFrozen || self.isFeared || self.isMindControlled) return;
      _cogPowerTrip(G, self);
    }
  },
  "Robber Baron": {
    onPlay(G, self, lane) {
      const t = _cogTarget(G, self);
      if (!t) return;
      G.log(`  [EMBEZZLE] Robber Baron shakes down ${t.name} — 3 damage, steals 1 Energy.`);
      if (typeof UI !== 'undefined' && UI._fxCogStrike) { try { UI._fxCogStrike(self, t, 'embezzle'); } catch (e) {} }
      G.dealDamage(t, 3, self);
      // Steal 1 Energy. In 2v2 a side has separate energy pools, so it is taken
      // from ONE RANDOM player on the victim's team and credited to a random
      // player on the Cog's team. In 1v1 it is side-to-side.
      try {
        const tt = G.state.twoVTwo;
        if (tt && tt.online && G.is2v2 && G.is2v2()) {
          const seatsOn = (side) => (G._2v2SLOTS || ['p1', 'p2', 'p3', 'p4'])
            .filter(pk => tt.players[pk] && G._2v2SeatOnSide(pk, side));
          const vseats = seatsOn(t.owner);
          if (vseats.length) {
            const vpk = vseats[Math.floor(G.rng() * vseats.length)];
            tt.players[vpk].usedEnergy = (tt.players[vpk].usedEnergy | 0) + 1;
            G.log(`  [EMBEZZLE] 1 Energy taken from ${tt.players[vpk].name || vpk}.`);
          }
          const cseats = seatsOn(self.owner);
          if (cseats.length) {
            const cpk = cseats[Math.floor(G.rng() * cseats.length)];
            tt.players[cpk].usedEnergy = Math.max(0, (tt.players[cpk].usedEnergy | 0) - 1);
          }
        } else {
          const victim = G.state[t.owner], mine = G.state[self.owner];
          if (victim) victim.usedEnergy = (victim.usedEnergy | 0) + 1;
          if (mine) mine.usedEnergy = Math.max(0, (mine.usedEnergy | 0) - 1);
        }
      } catch (e) {}
    },
    onBeforeAttack(G, self) {
      if (self.isFrozen || self.isFeared || self.isMindControlled) return;
      _cogPowerTrip(G, self);
    }
  },
  "Big Wig": {
    onPlay(G, self, lane) {
      const t = _cogTarget(G, self);
      if (!t) return;
      G.log(`  [FIRED!] Big Wig fires ${t.name} — 3 damage, then a transfer.`);
      if (typeof UI !== 'undefined' && UI._fxCogStrike) { try { UI._fxCogStrike(self, t, 'fired'); } catch (e) {} }
      G.dealDamage(t, 3, self);
      if (t.currentHealth > 0 && !t.isFaceDown) {
        const from = G.findCardLane(t);
        const empties = G.getOpenLanes(t.owner);
        if (from >= 0 && empties.length) {
          const to = empties[Math.floor(G.rng() * empties.length)];
          G.moveCard(t, from, to);
        }
      }
    },
    onBeforeAttack(G, self) {
      if (self.isFrozen || self.isFeared || self.isMindControlled) return;
      _cogPowerTrip(G, self);
    }
  },
  "The Big Cheese": {
    onPlay(G, self, lane) {
      // No Power Trip — the Chairman's Cog trades the group hit for a bigger one.
      const t = _cogTarget(G, self);
      if (!t) return;
      G.log(`  [GLOWER POWER] The Big Cheese glares at ${t.name} — 5 damage and a knock-down.`);
      if (typeof UI !== 'undefined' && UI._fxCogStrike) { try { UI._fxCogStrike(self, t, 'glower'); } catch (e) {} }
      G.dealDamage(t, 5, self);
      if (t.currentHealth > 0) G.freezeCard(t, self, 1);
    }
  },
  "Brainiac": {
    // Discard-only, like Mr. Fantastic and Jigsaw — 0/0, isDiscardEffect keeps
    // playCard from ever seating it in a lane. His whole payload is the scan.
    isDiscardEffect: true,
    // Name one enemy PLAYER and read their HAND, live, for two rounds — every
    // card in it and every card that arrives — and each arriving card comes
    // in at −1 ATK. Only the player who played him sees it (not a whole side).
    // The window lives in Game.setBrainiacSpy: the engine owns it because it
    // must survive the round loop, gate redaction on the wire, and shave every
    // card that lands in the watched hand.
    onDiscard(G, owner, self) {
      // Bank the caster's +1/+1 harvest BEFORE he draws, so the card he draws
      // right now arrives charged.
      try { G._brainiacBankHarvest(owner, self); } catch (e) {}
      // He draws for himself on top of the scan.
      try { G.drawCards(owner, 1); G.log('[BRAINIAC] Brainiac draws a card.'); } catch (e) {}
      const tt = G.state && G.state.twoVTwo;
      const arm = (victimSeat) => {
        const caster = G.setBrainiacSpy(owner, victimSeat, G.BRAINIAC_SPY_ROUNDS, self);
        const view = G.brainiacSpiedHand(caster, caster ? null : owner);
        const who = view ? view.name : (G.seatPossessive ? G.seatPossessive(G.opponent(owner)) : 'the opponent');
        G.log(`[BRAINIAC] Brainiac opens ${who}'s hand for ${G.BRAINIAC_SPY_ROUNDS} rounds — everything they draw arrives at −1/−1.`);
        // No whole-hand dump: each draw by the watched hand pops on the
        // caster's screen at reduced stats (Game._brainiacRecordDraw), and the
        // scan strip shows the live hand and drawn history.
        // ANNOUNCE IT. Brainiac is a discard card with no body on the board, so
        // without a reveal the window is indistinguishable from nothing
        // happening. The reveal carries WHO and WHOSE HAND only — every seat
        // may know a scan is running; only the caster may read the cards.
        const casterName = (tt && tt.online && caster && tt.players[caster] && tt.players[caster].name)
          || (G.seatLabel ? G.seatLabel(owner) : 'Your side');
        const victimName = (tt && tt.online && victimSeat && tt.players[victimSeat] && tt.players[victimSeat].name)
          || (view ? view.name : 'the opponent');
        const label = `${casterName} scans ${victimName}'s hand`;
        const publicDesc = `Sees every card ${victimName} holds or draws for ${G.BRAINIAC_SPY_ROUNDS} rounds. Everything they draw arrives at (\u22121/\u22121).`;
        if (typeof UI !== 'undefined' && UI.showCardReveal) {
          try { UI.showCardReveal('Brainiac', publicDesc, self.cost, localIsCaster, label); } catch (e) {}
        }
        // ...and over the wire: in 2v2 online the host runs every seat's
        // abilities, so guests never execute this. Same channel as the trick
        // reveal and Iron Giant's save.
        if (G.emitFX) {
          G.emitFX('brainiacScan', { name: 'Brainiac', desc: publicDesc, cost: self.cost,
                                     seat: caster || null, label });
        }
      };
      // 2v2: the caster picks WHOSE hand. Routed to Brainiac's own seat only —
      // not the whole table.
      if (tt && tt.online && G._2v2ChooseEnemySeat) {
        G._2v2ActFor(self);
        G._2v2ChooseEnemySeat(owner, 'Brainiac — Scan',
          'Choose an enemy — you will see their hand for the next 2 rounds',
          (seat) => arm(seat));
      } else {
        // 1v1: no pick, there is only one other player.
        arm(null);
      }
    }
  },
  "Art the Clown": {
    // Jump ("enemy has more cards on the field") lives in
    // Game.checkJumpConditions under 'beforeTricks', fired at the start of the
    // trick phase after both sides finish playing.
    //
    // The bag: four weapons, each used at most once until all four are spent,
    // then Art is a plain body. The choice fires ONCE per round — on play and
    // via onBeforeTricks after. Both go through _step, whose per-round guard
    // stops the play-round's own onBeforeTricks handing out a second weapon.
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
      // Only weapons that remain in the bag AND have a legal target are
      // offered, so "no weapon twice" can't strand Art with nothing to hit.
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
      // Synthetic option tiles (like the Upkeep prompt); the callback reads
      // _artWeaponKey. No attack/health fields keeps them ACTION tiles, so the
      // picker draws the weapon glyph, not a 0/1 card face (UI's _artWeaponKey
      // branch).
      const tiles = usable.map(w => ({
        _artWeaponKey: w.key, name: w.name, cost: 0, type: 'horror', desc: w.desc,
      }));
      // { seat } — the weapon choice belongs to whoever PLAYED Art. It is
      // raised from the before-tricks pass, where no seat is acting, and the
      // engine's fallback ("first human on Art's team") hands a guest's Art to
      // the host. _2v2PlayedBy is stamped on every played card and survives
      // the round loop (null in 1v1, where the engine's path is correct).
      const artSeat = self._2v2PlayedBy || null;
      G.promptCardChoice(owner, tiles,
        'Art the Clown — Pick a Weapon',
        `Choose one (${self._artWeaponsUsed.length + 1} of ${AB.WEAPONS.length}). Each can be used only once until all four are spent.`,
        (picked) => { AB._resolve(G, self, picked && picked._artWeaponKey); },
        // AI heuristic: a lethal Sledgehammer first, then Scythe on the biggest
        // threat, then Scissors on a keyworded enemy, else Hacksaw.
        (tilesList) => AB._aiPick(G, self, tilesList),
        artSeat ? { seat: artSeat } : null);
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
        // Same declared seat as the weapon picker above — a chained prompt is
        // raised from inside a callback, which is exactly where the engine's
        // acting-seat global is least likely to still be right.
        G.promptCardChoice(owner, enemies, `Art the Clown — ${title}`, 'Choose an enemy card.',
          (picked) => cb(picked),
          // AI: highest ATK+HP threat (scissors picks the most-keyworded).
          (list) => (key === 'scissors'
            ? list.slice().sort((a, b) => AB._strippable(b).length - AB._strippable(a).length)[0]
            : list.slice().sort((a, b) => (b.attack + b.currentHealth) - (a.attack + a.currentHealth))[0]),
          self._2v2PlayedBy ? { seat: self._2v2PlayedBy } : null);
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
          // Badge lands immediately (driven by _bleedRounds) AND the wound
          // bleeds NOW. tickBleed then decrements to one remaining tick, which
          // bleeds at the next round start.
          t._bleedRounds = 2;
          t._bleedAmount = 2;
          t._bleedSourceOwner = owner;
          fx(t.id);
          G.tickBleed(t);            // immediate blood FX + 2 damage, → 1 round left
          G.cleanupDead();
          G.log(`[ART] Hacksaw! ${t.name} bleeds 2 now, and again at the start of the next round.`);
          if (typeof UI !== 'undefined' && UI.render) { try { UI.render(); } catch (e) {} }
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
      // Block-meter fill % scales with tier: common 50%, rare 100%, special
      // 100% + 1 random ally Evade 1, legendary 100% + ALL allies Evade 1.
      const fillPct = G.rarityValue(self, { common: 0.5, rare: 1.0, special: 1.0, legendary: 1.0 });
      const allyEvade = G.rarityValue(self, { common: 'none', rare: 'none', special: 'one', legendary: 'all' });
      const fillAmt = Math.floor(Game.BLOCK_MAX * fillPct);
      G.addBlockMeter(self.owner, fillAmt);
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
    // Fields nulled / zeroed on strip — EVERY hook createCardInstance can
    // assign, listed once so strip and restore can't drift (e.g. Parlay lives
    // on onBeforeCombat, Voldemort's curses on onLaneCombat). sim/test.js
    // fails if game.js gains a hook that is not listed here.
    const STRIP_HOOKS = [
      'onPlay', 'onDeath', 'onDamaged', 'onKill', 'onBeforeTricks',
      'onBeforeAttack', 'onEndOfTurn', 'onAnyCardPlayed', 'onAllyKilled', 'onEnemyKilled',
      'onEvade', 'onDamagePlayer', 'onTurnStart', 'passive',
      'onBeforeCombat', 'onLaneCombat', 'onLaneResolved', 'onAnyTrickPlayed',
      'onDiscard', 'onMoved',
      'onAnyCardDamaged', 'onBlockMeterFired', 'onRevive', 'onAbsorbedHit',
    ];
    const STRIP_FIELDS = [
      ...STRIP_HOOKS,
      'evadeCharges', 'armorValue', 'isOverdrive', 'isBullseye',
      'immunityCharges', 'hasHunt', 'hasHuntMeter', 'hasDamageImmunity',
      'unresistibleCharges', 'splashRange', 'invincibleTurns', 'tauntTurns',
      'isUntrickable',
    ];
    const strip = (card, G) => {
      // Snapshot the original values so unstrip() can restore them when the
      // card leaves the board (e.g. bounced to hand by Phantom Zone). Only
      // snapshot once — re-stripping mustn't overwrite the backup with
      // already-stripped values.
      if (!card._moderBackup) {
        const backup = {};
        for (const k of STRIP_FIELDS) backup[k] = card[k];
        backup._permanentUntrickable = !!card.permanentUntrickable;
        card._moderBackup = backup;
      }
      // Driven from STRIP_HOOKS, not a second hand-written list, so it can't
      // drift.
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
      // Exposed so the ENGINE runs the strip at lane-entry time, like Bear
      // Trap. onAnyCardPlayed broadcasts AFTER the arriving card's own onPlay,
      // so the card would keep its When Played — and if that killed Moder,
      // nothing would be stripped at all.
      _strip: (card, G) => strip(card, G),
      onPlay(G, self, lane) {
        const opp = G.opponent(self.owner);
        // Force opponent's next card into Moder's lane. Do NOT strip anyone
        // already there — only the single forced arrival loses abilities.
        // Roguelite Text+ override — _moderStripCount lets Moder strip multiple
        // subsequent arrivals (default 1, Text+ 2). forcedLane fires once per
        // round, but the strip-pending counter persists until exhausted, so
        // the second target is stripped on whichever round it lands.
        G.state[opp].forcedLane = lane;
        self._moderStripPending = (self._moderStripCount || 1);
        // Expose the strip so game.js neutralizes the forced card the instant
        // it is PULLED into Moder's lane — before its When Played fires, since
        // the card "loses all abilities and keywords" including that. Stamped
        // on Game (not state) so it survives serialization; the closure
        // carries strip.
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
      // Buff applies to ANY card, not just villains, so hero decks can use
      // Red Skull too.
      // Roguelite Text+ override — _redSkullEmpower scales the buff (default
      // 2, Text+ 3).
      const empower = self._redSkullEmpower || 2;
      // TARGETS THE HAND, AT RANDOM: a setup card that makes a future play
      // bigger, not an aimed board buff — so no prompt.
      //
      // G.rng(), never Math.random — this is the seeded engine RNG, and the
      // fuzz harness and replay system both depend on the same seed producing
      // the same game.
      const hand = (G.state && G.state[self.owner] && G.state[self.owner].hand) || [];
      // A CARD WITH NO BODY CANNOT BE EMPOWERED (discard effects like Jigsaw,
      // Brainiac, Professor X, Mr. Fantastic; Iron Giant; environments) — the
      // +2/+2 would never reach a lane. Game.cardHasBody is the canonical
      // "does this card fight?" test, the same one the renderer uses to print
      // stats, so this can't drift from what the card visibly is.
      const pool = hand.filter(c => c && c.id !== self.id && G.cardHasBody(c));
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
    // What she is when there is nothing to copy. Named because the AI's lane
    // picker has to know it too — see AI._asPlacedIn. One number, two readers.
    COPY_FALLBACK: { atk: 3, hp: 4 },
    // Hex-mirror: on entering a lane she ADOPTS the ATK and HP of the enemy
    // directly opposite for this match. Base 0/0 with `copiesOpposite`, which
    // makes the renderer show "?" stats in hand; the flag is cleared once her
    // stats resolve here.
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      const enemy = G.state.lanes[lane] && G.state.lanes[lane][opp];
      // Roguelite Text+ override — _witchHexBonus adds ATK/HP on top of the
      // copied stats (default 0, Text+ 2).
      const bonus = self._witchHexBonus || 0;
      // A HIDDEN CARD CANNOT BE READ. A face-down (Invisible Woman) card is
      // unknown and untouchable until it reveals — every other path honours
      // that — and it carries BASE numbers with an HP floor, so copying it
      // gives nonsense. Nothing to read means she takes her 3/4 default.
      if (enemy && enemy.currentHealth > 0 && !enemy.isFaceDown) {
        // SHE ENDS AS AN EXACT MIRROR — AFTER the aura, not before it.
        // A While Active aura (Magneto's parity, Luke's) lands on her one step
        // AFTER this hook (rule: On Play first, then passives), and copying
        // raw stats would let it push her off the copy — or kill her on entry.
        // So she copies the target OFFSET BY THE AURA SHE IS ABOUT TO RECEIVE.
        // That is HER aura, not the target's: they're on opposite sides, so
        // the same Magneto buffs one and debuffs the other. auraWantFor shares
        // the engine's source scan, so future auras mirror correctly too.
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
        const fb = CARD_ABILITIES['Scarlet Witch'].COPY_FALLBACK;
        self.attack = fb.atk + bonus;
        self.baseAttack = fb.atk + bonus;
        self.currentHealth = fb.hp + bonus;
        self.maxHealth = fb.hp + bonus;
        self.baseHealth = fb.hp + bonus;
        self.copiesOpposite = false;
        G.log(`Scarlet Witch finds nothing to copy — defaults to ${fb.atk + bonus}/${fb.hp + bonus}.`);
      }
      if (typeof UI !== 'undefined' && UI._fxScarletHex) { try { UI._fxScarletHex(self, (enemy && enemy.currentHealth > 0 && !enemy.isFaceDown) ? enemy : null); } catch (e) {} }
    }
  },
  "Solomon Grundy": {
    onDeath(G, self, lane) {
      if (typeof UI !== 'undefined' && UI._fxGrundyGrave) { try { UI._fxGrundyGrave(self); } catch (e) {} }
      // Roguelite Text+ ("Born on Monday") replaces the dead-pile draw with a
      // revive-and-grow loop: _grundyReviveBuff is the per-revive ATK/HP gain,
      // reviveCharges (set in apply) caps the revives. When active, revive in
      // place and skip the classic draw.
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
      // ROGUELITE-ONLY: Grundy scavenges from his OWN dead pile only — the
      // cross-side scavenge stacked with the Lex-block bypass to make him
      // mandatory. Classic keeps the canonical "shared Dead Pile" text.
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
        G.addToHand(self.owner, G.createCardInstance(card, self.owner), self, null, 'Scavenged from the Dead Pile');
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
      // Each card shuffles back to its OWNER's pile — in Deckbuilder their
      // personal deck, in Classic the shared pile (same ref).
      // HELD BACK UNTIL AFTER THE DRAW, so a card just chosen to get rid of
      // can't be drawn straight back. flushShuffleBack inserts them after the
      // draw, then shuffles — later rounds still see them randomised in.
      const pendingBack = [];
      const shuffleBack = (card, ownerKey) => {
        // GUARDED: a throw here stops every seat after this one in the
        // per-seat chain. A card that can't be shuffled back costs only this
        // seat its cycle.
        const pile = G.getDrawPile(ownerKey);
        if (!Array.isArray(pile)) {
          G.log(`  [SSM] No draw pile for ${ownerKey} — ${card.name} stays put.`);
          return;
        }
        // BUILT ON THE REAL DEFINITION, not a hand-written stats literal. A
        // CARD_DEFS entry carries its ability hooks (merged at the end of this
        // file); a stats-only record drawn later gets null hooks from
        // createCardInstance and its When Played never fires.
        // The live stats are captured on top (a buffed card goes back buffed);
        // run metadata rides along so a roguelite card keeps its etches and XP
        // attribution.
        const _base = (typeof CARD_DEFS !== 'undefined')
          ? CARD_DEFS.find(d => d.name === card.name) : null;
        const _backDef = Object.assign({}, _base, {
          name: card.name, cost: card.baseCost || card.cost,
          attack: card.attack, health: card.maxHealth,
          abilities: card.abilities, type: card.type, desc: card.desc,
        });
        if (card._runDeckCardRef) _backDef._runDeckCardRef = card._runDeckCardRef;
        if (card._runRarity) _backDef._runRarity = card._runRarity;
        pendingBack.push({ ownerKey, def: _backDef });
      };
      // Draw the replacements from the deck WITHOUT the cards just chosen,
      // then put those back and shuffle. If the deck runs dry, the returns go
      // in first and the shortfall is drawn from them — "N back, N up" must
      // hold, so a returned card comes back only when nothing else is left.
      const cycleDraw = (ownerKey, n, getHand) => {
        if (n <= 0) { flushShuffleBack(); return; }
        const before = (getHand() || []).length;
        G.drawCards(ownerKey, n);
        const got = (getHand() || []).length - before;
        flushShuffleBack();
        if (got < n) G.drawCards(ownerKey, n - got);
      };
      // Put the held cards into the deck and shuffle. Called AFTER the draw.
      const flushShuffleBack = () => {
        if (!pendingBack.length) return;
        const piles = [];
        pendingBack.splice(0, pendingBack.length).forEach(({ ownerKey, def }) => {
          const pile = G.getDrawPile(ownerKey);
          if (Array.isArray(pile)) { pile.push(def); if (piles.indexOf(pile) < 0) piles.push(pile); }
        });
        piles.forEach(pile => G.shuffle(pile));
      };
      const doPlayerShuffle = (p, onDone) => {
        const hand = G.state[p].hand;
        if (hand.length <= 2) {
          // YOU DRAW WHAT YOU PUT BACK — never more. The card is a wash (2
          // back, 2 up); an empty hand shuffles nothing and draws nothing.
          const back = hand.length;
          hand.splice(0).forEach(c => shuffleBack(c, p));
          if (back > 0) {
            cycleDraw(p, back, () => G.state[p].hand);
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
          cycleDraw(p, 2, () => G.state[p].hand);
          G.log(`Symbiote Spider-Man: ${p} shuffles 2 cards back and draws 2!`);
          if (onDone) onDone();
        } else {
          // Human: picks each card via prompt.
          // fromHand — the hand itself is highlighted and you pick from it
          // with a decision notice. A tap on a card is a READ everywhere else,
          // so the tap does NOT commit: a lit hand card opens the inspect view
          // and the Pick button lives inside it (UI._handPickIndexOf) — read
          // first, commit second. A tray can't work here: it would offer the
          // WHOLE hand as small duplicates of cards already on screen.
          G.promptCardChoice(p, [...hand], "Symbiote Spider-Man — Shuffle", "Choose 1st card to shuffle back into the deck (pick 2 total)", (c1) => {
            const idx1 = hand.findIndex(c => c.id === c1.id);
            if (idx1 >= 0) hand.splice(idx1, 1);
            shuffleBack(c1, p);
            G.promptCardChoice(p, [...hand], "Symbiote Spider-Man — Shuffle", "Choose 2nd card to shuffle back into the deck", (c2) => {
              const idx2 = hand.findIndex(c => c.id === c2.id);
              if (idx2 >= 0) hand.splice(idx2, 1);
              shuffleBack(c2, p);
              cycleDraw(p, 2, () => G.state[p].hand);
              G.log("Symbiote Spider-Man: You shuffle 2 cards back and draw 2!");
              if (onDone) onDone();
            }, null, { fromHand: true, pickLabel: 'Shuffle' });
          }, null, { fromHand: true, pickLabel: 'Shuffle' });
        }
      };
      // Process owner first, then opponent, then heal
      const opp = G.opponent(self.owner);
      // Roguelite Text+ override — _symbioteSkipSelf makes the shuffle hit
      // only the OPPONENT's hand (default false: both).
      const skipSelf = !!self._symbioteSkipSelf;
      const finish = () => {
        // Heals ONLY the caster's side (self.owner). healPlayer already logs a
        // team-accurate [HEAL] line, so this one just names the team.
        G.healPlayer(self.owner, 2, self);
        G.log(`Symbiote Spider-Man heals its own team for 2!`);
      };
      // ANY 2v2, local or online. The seat-aware branch gives each of the four
      // players their OWN hand and lets AI seats auto-pick; the else-branch
      // works on the SIDE proxy and asks isHuman(side), which is true for any
      // side holding a human, so a bot seat would raise an unanswerable prompt.
      const symIn2v2 = !!(G.is2v2 && G.is2v2() && G.state.twoVTwo);
      if (skipSelf) {
        doPlayerShuffle(opp, finish);
      } else if (symIn2v2) {
        // 2v2: EVERY player cycles 2 of their own cards. doPlayerShuffle reads
        // the SIDE proxy — wrong with 2 seats per side — so shuffle each
        // seat's REAL hand, routed to that seat (humans get the prompt on
        // their own client; AI seats auto-cycle their 2 lowest-cost cards).
        const tt = G.state.twoVTwo;
        // EVERY HUMAN CHOOSES, whoever cast it. The chain hops one seat at a
        // time (single prompt slot) and the watchdog below keeps a lost
        // network answer from freezing the table.
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
              G._2v2CurrentActingPlayer = seatKey;   // re-assert before the draw routes
              cycleDraw(seatSide, back, () => sp.hand);
              G.log(`Symbiote Spider-Man: ${sp.name} shuffles ${back} card${back === 1 ? '' : 's'} back and draws ${back}!`);
            } else {
              G.log(`Symbiote Spider-Man: ${sp.name} has an empty hand — nothing to cycle.`);
            }
            onDone && onDone();
          };
          const lowest = (cards) => cards.slice().sort((a, b) => (a.cost || 0) - (b.cost || 0))[0];
          // AI seats always take their two lowest. A bot's cast still prompts
          // the human seats, deliberately — what must hold is that a human's
          // pick is never made for them (enforced in forceComplete below).
          // One prompt is raced by several recoveries (3s stall watchdog, 12s
          // drive watchdog, this card's nudge/force-complete), which is why
          // the per-answer clock and human guard below exist.
          if (sp.isAI || hand.length <= 2) {
            // AI seat (auto-take its 2 lowest), or a hand small enough that
            // the pick is forced. Every HUMAN seat chooses their own two; the
            // watchdog never auto-skips them, so the pick waits and each answer
            // drains the chain to the next seat.
            for (let i = 0; i < back; i++) {
              const c = lowest(hand); if (!c) break;
              const idx = hand.findIndex(x => x.id === c.id);
              if (idx >= 0) { shuffleBack(hand[idx], seatSide); hand.splice(idx, 1); }
            }
            finalizeDraw();
          } else {
            // { seat: seatKey } — NAME the seat. Three of the four prompts are
            // raised outside that seat's sub-phase, and the engine's fallback
            // ("first human on that team") would hand a player's hand to their
            // teammate.
            G.promptCardChoice(seatSide, [...hand], "Symbiote Spider-Man — Shuffle",
              "Choose 1st card to shuffle back into the deck (pick 2 total)", (c1) => {
                const i1 = hand.findIndex(c => c.id === c1.id);
                if (i1 >= 0) { shuffleBack(hand[i1], seatSide); hand.splice(i1, 1); }
                // EACH ANSWER GETS ITS OWN CLOCK: a human owes TWO answers, so
                // a per-seat timer would expire mid-pair.
                if (typeof armTimer === 'function') armTimer();
                G._2v2CurrentActingPlayer = seatKey;
                G.promptCardChoice(seatSide, [...hand], "Symbiote Spider-Man — Shuffle",
                  "Choose 2nd card to shuffle back into the deck", (c2) => {
                    const i2 = hand.findIndex(c => c.id === c2.id);
                    if (i2 >= 0) { shuffleBack(hand[i2], seatSide); hand.splice(i2, 1); }
                    finalizeDraw();
                  }, lowest, { seat: seatKey, fromHand: true, pickLabel: 'Shuffle' });
              }, lowest, { seat: seatKey, fromHand: true, pickLabel: 'Shuffle' });
          }
        };
        // Owner first, then the rest — chained so pick prompts never collide
        // (one prompt slot). Humans choose; AI seats auto-take their lowest.
        const order = [self._2v2PlayedBy, 'p1', 'p2', 'p3', 'p4']
          .filter((k, i, a) => k && tt.players[k] && a.indexOf(k) === i);
        G.log(`[SSM] Symbiote cycle order: ${order.join(' → ')}`);
        let done = false;
        let idx = 0;
        // KEEP-ALIVE + LAST-RESORT WATCHDOG. Never auto-picks for a responsive
        // player; it exists so a lost answer or unrendered prompt can't freeze
        // the table. On a stall it FIRST re-broadcasts the pending prompt, and
        // only if still stuck the second time forces the remaining seats.
        // GIVEUP must sit ABOVE the engine's fair wait for a human prompt
        // (_2v2_PROMPT_MS, 30s), or it decides for people still choosing.
        const NUDGE_MS = 8000, GIVEUP_MS = 35000;
        let timer = null, stallStartAt = 0, nudged = false;
        const clearTimer = () => { if (timer && typeof clearTimeout !== 'undefined') { clearTimeout(timer); timer = null; } };
        const finishOnce = () => { if (done) return; done = true; clearTimer(); G.log('[SSM] cycle complete — healing caster.'); try { finish(); } catch (e) { console.error('[SSM] finish threw', e); } };
        const forceComplete = (fromIndex) => {
          // THE SAME RULE AS end2v2Phase: NEVER PICK FOR A LIVE HUMAN.
          // If the seat is a live human, keep waiting and re-arm so their
          // answer drains the chain normally; if they are genuinely gone, the
          // drop path converts the seat (_dropped/isAI) and the next tick
          // completes it for a bot.
          const blocker = order[fromIndex];
          if (blocker && G._2v2SeatIsLiveHuman && G._2v2SeatIsLiveHuman(blocker)) {
            const nm = (tt.players[blocker] && tt.players[blocker].name) || blocker;
            console.warn('[SSM] still waiting on', blocker, '— a live human, so NOT picking for them');
            G.log(`[SSM] still waiting on ${nm} — their cards will not be chosen for them.`);
            if (G.state.twoVTwo && G.state.twoVTwo.online) { try { G._2v2OnlineBroadcast(); } catch (e) {} }
            if (typeof UI !== 'undefined' && UI.render) { try { UI.render(); } catch (e) {} }
            clearTimer(); stallStartAt = Date.now(); nudged = true;
            timer = setTimeout(tick, GIVEUP_MS);   // ask again later, do not decide
            return;
          }
          console.warn('[SSM] chain still stuck after nudge — force-completing from index', fromIndex);
          G.log('[SSM] a client never answered — completing the remaining shuffle so the table can continue.');
          const pc = G.state.pendingCardChoice;
          if (pc && /Symbiote Spider-Man/.test(pc.title || '')) { G.state.pendingCardChoice = null; if (G._clearPromptTimeout) G._clearPromptTimeout(); }
          for (let i = fromIndex; i < order.length; i++) {
            const seatKey = order[i]; const sp2 = tt.players[seatKey]; if (!sp2) continue;
            const seatSide2 = G._2v2TeamSide[sp2.team];
            const hand2 = sp2.hand || [];
            // ALREADY GAVE ONE BACK? Then they owe one, not two — otherwise the
            // mid-pick seat is cycled again from the top (three back, two drawn).
            const already = pendingBack.filter(e => e.ownerKey === seatSide2).length;
            const back2 = Math.max(0, Math.min(2, hand2.length) - already);
            G._2v2CurrentActingPlayer = seatKey;
            for (let j = 0; j < back2; j++) {
              const c = hand2.slice().sort((a, b) => (a.cost || 0) - (b.cost || 0))[0]; if (!c) break;
              const k = hand2.findIndex(x => x.id === c.id);
              if (k >= 0) { shuffleBack(hand2[k], seatSide2); hand2.splice(k, 1); }
            }
            if (back2 > 0) { G._2v2CurrentActingPlayer = seatKey; cycleDraw(seatSide2, back2, () => sp2.hand); }
          }
          finishOnce();
          if (G.state.twoVTwo && G.state.twoVTwo.online) { try { G._2v2OnlineBroadcast(); } catch (e) {} }
          if (typeof UI !== 'undefined' && UI.render) { try { UI.render(); } catch (e) {} }
        };
        const tick = () => {
          if (done) return;
          const stuckFor = Date.now() - stallStartAt;
          if (!nudged && stuckFor >= NUDGE_MS) {
            // NUDGE: re-broadcast the stuck prompt so the seat that owns it sees
            // it again and can still make their own choice.
            nudged = true;
            console.warn('[SSM] no progress for', stuckFor, 'ms — re-broadcasting the pending pick to the stuck seat.');
            G.log('[SSM] nudging the current seat — re-sending their shuffle pick.');
            if (G.state.twoVTwo && G.state.twoVTwo.online) { try { G._2v2OnlineBroadcast(); } catch (e) {} }
            if (typeof UI !== 'undefined' && UI.render) { try { UI.render(); } catch (e) {} }
            timer = setTimeout(tick, GIVEUP_MS - NUDGE_MS);
            return;
          }
          if (stuckFor >= GIVEUP_MS) { forceComplete(idx); return; }
          timer = setTimeout(tick, 1000);
        };
        const armTimer = () => {
          if (G._syncMode || typeof setTimeout === 'undefined') return;   // headless is synchronous
          clearTimer(); stallStartAt = Date.now(); nudged = false;
          timer = setTimeout(tick, NUDGE_MS);
        };
        const run = (i) => {
          idx = i;
          if (i >= order.length) { finishOnce(); return; }
          const sk = order[i]; const spk = tt.players[sk];
          G.log(`[SSM] → ${sk} (${spk ? spk.name : '?'}${spk && spk.isAI ? ', AI' : ', human'}) shuffles`);
          armTimer();                       // reset the stall clock on every hop
          const next = () => {
            if (done) return;
            if (G.hasPendingPrompt && G.hasPendingPrompt()) G.whenPromptCleared(() => run(i + 1));
            else run(i + 1);
          };
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
      // Roguelite Text+ override — destroy threshold from
      // self._wsCostThreshold (default 3).
      const threshold = self._wsCostThreshold || 3;
      const wsEnemies = G.getEnemiesOf(self.owner);
      const targets = wsEnemies.filter(c => c.attack <= threshold && G.canEffectLand(c, 'destroy', { owner: self.owner, source: self }));
      if (!targets.length) {
        // Same silent-no-op gap Deathstroke had — see the note there.
        G.log(wsEnemies.length
          ? `[WINTER SOLDIER] No enemy at ${threshold} ATK or less that he can destroy.`
          : `[WINTER SOLDIER] No enemy on the field to eliminate.`);
      }
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
      G.log(`${G.seatVerb(self.owner, 'heal', 'heals')} for ${heal} — Anti-Venom!`);

      // THE CURE CUTS BOTH WAYS: move a card; an ally gains (+1/+1), an enemy
      // loses (−1/−1).
      //   • the pool is every card, so destinations are computed PER TARGET —
      //     a card can only slide into an empty lane on its OWN side;
      //   • the stat change hangs off the move LANDING, not the pick. moveCard
      //     refuses silently (occupied, voided lane, frozen/feared, face-down)
      //     and a refused move must not pay out (same as Man-Bat's sting).
      // Roguelite Text+ hook — _antivenomShift scales both halves together.
      const shift = self._antivenomShift || 1;

      const openLanesFor = (c) => {
        const from = G.findCardLane(c);
        const out = [];
        for (let i = 0; i < G.LANE_COUNT; i++) {
          if (i !== from && !G.state.lanes[i][c.owner] && !G.state.lanes[i].destroyed) out.push(i);
        }
        return out;
      };

      // getAlliesOf / getEnemiesOf read the lane slots and do NOT filter what
      // moveCard would refuse, so every one of those doors is applied here
      // instead — otherwise the tray offers picks that quietly do nothing.
      const pool = [...G.getAlliesOf(self.owner), ...G.getEnemiesOf(self.owner)]
        .filter(c => c && c !== self && c.currentHealth > 0 && G.findCardLane(c) >= 0
                     && !c.isFaceDown && !G.isActionLocked(c)
                     && openLanesFor(c).length > 0);
      if (!pool.length) return;

      const settle = (target, to) => {
        if (!target) return;
        const from = G.findCardLane(target);
        if (target.currentHealth <= 0 || from < 0) return;
        G.moveCard(target, from, to);
        // READ THE BOARD BACK. moveCard returns nothing and bails silently on
        // several conditions that can become true between pick and move.
        if (G.findCardLane(target) !== to) {
          G.log(`Anti-Venom reaches for ${target.name}, but it holds its lane.`);
          return;
        }
        // THE ARRIVAL CAN BE FATAL BY ITSELF: moveCard fires onMoved and the
        // destination trap before returning (Reverse Bear Trap → killCard), so
        // the card may already be a corpse; debuffCard would kill it twice.
        if (target.currentHealth <= 0) return;
        if (target.owner === self.owner) {
          G.buffCard(target, shift, shift);
          G.log(`Anti-Venom's cure strengthens ${target.name} (+${shift}/+${shift})`);
        } else {
          // allowKill=true — a printed (−N/−N) finishes a small card instead of
          // flooring its HP at 1 (same canon as Bane, Man-Bat, Crucio).
          G.debuffCard(target, shift, shift, true, self);
          G.log(`[DEBUFF] Anti-Venom's cure burns ${target.name} (−${shift}/−${shift})`);
          G.cleanupDead();
        }
      };

      // Burning an enemy is the stronger half — a (−1/−1) that finishes the
      // target beats any repositioning, so lethal outranks everything and a
      // friendly buff is the fallback. Invincible shields the HP half of a stat
      // strip (see debuffCard), so an Invincible enemy is never "lethal".
      const scoreFor = (c) => {
        const power = (c.attack || 0) + (c.currentHealth || 0);
        if (c.owner !== self.owner) {
          const lethal = !G.statStripShieldsHp(c) && (c.currentHealth || 0) <= shift;
          // KILLING ONE IS STILL THE BEST OUTCOME — that is unchanged.
          if (lethal) return 1000 + power;
          // A non-lethal burn is worth the stats it removes, not a flat
          // threat-removed price, so it competes honestly with the ally half.
          return shift * 2 + power * 0.25;
        }
        // FREEING A BLOCKED ALLY IS FACE DAMAGE. Prefer the ally being WASTED —
        // in a contested lane trading with a blocker while an unopposed lane
        // is open — since moving it lands its whole swing on the health bar;
        // raw power alone ties equal bodies and falls to board order.
        // Weighted by the attack it would land plus the +N the move grants.
        // aiLaneFor already sends a moved ally to an unopposed lane, so the
        // two halves agree without a second search.
        const opp2 = G.opponent(self.owner);
        const myLane = G.findCardLane(c);
        const blocker = myLane >= 0 && G.state.lanes[myLane] ? G.state.lanes[myLane][opp2] : null;
        const blockedNow = !!(blocker && blocker.currentHealth > 0);
        const canGoFree = openLanesFor(c).some(l => !G.state.lanes[l][opp2]);
        let s = power * 0.5;
        if (blockedNow && canGoFree) s += ((c.attack || 0) + shift) * 2;
        return s;
      };
      const aiPickCard = (list) => (list || []).slice()
        .sort((a, b) => scoreFor(b) - scoreFor(a))[0] || null;
      // Lane choice is worth very little on its own (measured), so this stays
      // deliberately cheap: shove an enemy where we already out-stat it, and
      // put a buffed ally somewhere unopposed.
      const aiLaneFor = (c) => {
        const lanes = openLanesFor(c);
        if (!lanes.length) return -1;
        const opp = G.opponent(self.owner);
        if (c.owner !== self.owner) {
          const winnable = lanes.filter(l => {
            const mine = G.state.lanes[l][self.owner];
            return mine && mine.currentHealth > 0
                   && (mine.attack || 0) >= (c.currentHealth || 0) - shift;
          });
          return winnable.length ? winnable[0] : lanes[0];
        }
        const unopposed = lanes.filter(l => !G.state.lanes[l][opp]);
        return unopposed.length ? unopposed[0] : lanes[0];
      };

      if (Game.isHuman(self.owner)) {
        // MAY move, not must — the opt-out predates this change and survives it:
        // the stat swing is always upside, but the LANE it costs you need not be.
        G.promptCardChoice(self.owner, pool, "Anti-Venom — Move",
          "Move any card to an empty lane — an ally gains (+1/+1), an enemy loses (−1/−1)",
          (target) => {
            // Re-check on RESOLVE: the target can die between choosing a card
            // and the move landing. The sim can't show this — its shim
            // resolves prompts synchronously.
            if (!target || target.currentHealth <= 0 || G.findCardLane(target) < 0) return;
            const lanes = openLanesFor(target);
            if (!lanes.length) return;
            G.promptLaneChoice(self.owner, lanes, `Anti-Venom — Move ${target.name}`,
              `Choose a new lane for ${target.name}`, (to) => settle(target, to),
              target.owner, null, 0,
              { declineLabel: 'LEAVE THEM', onDecline: () => G.log(`${target.name} holds position.`), seat: self._2v2PlayedBy || null });
          },
          aiPickCard,
          // NAME THE SEAT (2v2). self.owner is the team SIDE, and isHuman(side)
          // is true for any team holding a human, so a bot's prompt would go
          // unanswered and stall. Same cure as Symbiote / Human Torch.
          { declineLabel: 'MOVE NO ONE', onDecline: () => G.log('Anti-Venom moves no one.'), seat: self._2v2PlayedBy || null });
      } else {
        const target = aiPickCard(pool);
        const to = target ? aiLaneFor(target) : -1;
        if (target && to >= 0) settle(target, to);
      }
    }
  },
  "Black Panther": {
    onPlay(G, self, lane) {
      if (typeof UI !== 'undefined' && UI._fxBlackPantherKinetic) { try { UI._fxBlackPantherKinetic(self); } catch (e) {} }
      const hand = G.state[self.owner].hand;
      // Roguelite Text+ override — _blackPantherFreeThreshold raises the
      // free-cast cost ceiling (default 3, Text+ 5).
      const threshold = self._blackPantherFreeThreshold || 3;
      const freeCards = hand.filter(c => (c.baseCost != null ? c.baseCost : c.cost) <= threshold && !c.isDiscardEffect);
      if (freeCards.length) {
        const playFree = (freeCard) => {
          const open = G.getOpenLanes(self.owner);
          if (open.length) {
            if (Game.isHuman(self.owner)) {
              // Pass `freeCard` as previewCard so the lane-placement damage
              // preview shows the trade math per lane; without it
              // makeDamagePreview never runs in the lane-choice render path
              // (same as summonCardChoice for Hela / Cyborg / Ant-Man).
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
          // PICK OUT OF THE HAND, THE WAY YOU PLAY ANY OTHER CARD: eligible
          // cards (cost ≤ 3) are highlighted in hand. The hand IS the list —
          // a tray would duplicate cards already on screen and push Skip
          // below the fold. Skip is a decline, so it renders as a button in
          // the decision notice and can't be scrolled off.
          // `handDrop`: a free PLAY needs a lane, so dragging a lit card onto
          // a lane answers both questions in one gesture. Tapping opens the
          // full face first with the commit button inside — read, then commit.
          G.promptCardChoice(self.owner, [...freeCards], "Black Panther — Free Play",
            "Choose a card with base cost 3 or less to play free — or skip", (picked) => {
              playFree(picked);
            },
            cards => cards.slice().sort((a, b) => (b.baseCost || b.cost) - (a.baseCost || a.cost))[0],
            { fromHand: true, handDrop: true, pickLabel: 'Play Free',
              // The free play is optional — the player may be saving a cheap
              // card. declineLabel also stops the prompt auto-resolving when
              // exactly one card qualifies.
              declineLabel: 'Skip — Save Your Cards',
              onDecline: () => G.log('Black Panther holds back — no free play.') });
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
      // When Played: Fear 1 a chosen enemy. AI auto-picks the highest-ATK
      // threat. The Fear badge lands on the VICTIM, not Ghost Rider.
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
      // Classic: random card pulled from your hand and summoned in Cyborg's
      // slot. Roguelite Text+ ("Replication") sets _cyborgChooseFromHand so
      // the human picks which card.
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
        G.log(`Ghost Rider's last act: playing ${card.name} from ${G.seatPossessive(self.owner)} hand!`);
        // PLAYED, NOT SUMMONED. playCardFree is the door every free play
        // walks through (jumps, Mother Box, Boiler Room), so the card gets the
        // normal treatment: onPlay via _runOnPlayWithUndoPoint, the Moder lane
        // strip, the aura ping, trap settling, entrance FX. summonCard can drop
        // onPlay when a prompt is already armed (the normal mid-combat state).
        // playCardFree owns the hand removal — don't splice as well, or the
        // card is dropped twice. Its guards come along too: Iron Giant can't
        // be forced onto the field, a placed card can't take a second lane,
        // and a sleeping card stays asleep.
        G.playCardFree(self.owner, card, targetLane);
      };
      if (self._cyborgChooseFromHand && Game.isHuman(self.owner)) {
        G.promptCardChoice(self.owner, eligible,
          'Ghost Rider — Replication',
          'Choose a card from your hand to summon in Ghost Rider\'s lane',
          summonChoice,
          cards => cards.slice().sort((a, b) => (b.baseCost || b.cost) - (a.baseCost || a.cost))[0]);
      } else {
        // Classic / AI path — random pick (an AI seat has no use for a hand
        // prompt, so the upgraded card takes this branch for AI too).
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
      let deadpoolOwnerSeat = (dpIs2v2 && self._2v2PlayedBy) || G._2v2CurrentActingPlayer || (G._2v2ActivePlayer && G._2v2ActivePlayer());
      // THE GIVE-BACK COMES FROM DEADPOOL'S OWN HAND — never the enemy's, never
      // the wrong team's. If deadpoolOwnerSeat landed on a seat NOT on
      // self.owner's side (unstamped card + foreign acting seat during
      // combat), snap it back to a seat on his team.
      if (dpIs2v2 && G.state.twoVTwo) {
        const _dtt = G.state.twoVTwo;
        const _onOwnerSide = (pk) => !!(pk && _dtt.players[pk] && G._2v2TeamSide[_dtt.players[pk].team] === self.owner);
        if (!_onOwnerSide(deadpoolOwnerSeat)) {
          deadpoolOwnerSeat = ['p1', 'p2', 'p3', 'p4'].find(_onOwnerSide) || deadpoolOwnerSeat;
        }
      }
      G.withChosenOpponent(self.owner, "Deadpool — whose hand?", (opp, victimKey) => {
      const enemyHand = G.state[opp].hand;
      // 2v2: the give-back must read/splice the DEADPOOL OWNER's seat hand, not
      // state[self.owner].hand — during combat that side proxy is bound to
      // whichever teammate synced last.
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
      // BOTH HALVES OR NEITHER: with no card to trade, the ability doesn't
      // fire — checked before any prompt, so it never becomes a free steal or
      // a pointless blind pick. Reads the owner's hand as it stands now (the
      // stolen card is excluded from the give-back, so the card must exist
      // BEFORE the steal).
      // Roguelite Text+ ("no give-back") makes Deadpool a pure thief, so that
      // mode skips this requirement.
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
      // Roguelite Text+ override — _deadpoolNoGiveBack skips the trade step
      // (default false: give one back).
      const skipGiveBack = _dpSkipGiveBack;
      // An AI Deadpool auto-picks both cards, so the human's hand changes
      // silently; fire one AI-trick toast naming both cards once the trade
      // resolves. Only when the human is the victim (self.owner === 'ai').
      const showVictimToast = (stolenName, givenName) => {
        if (self.owner === 'ai' && typeof UI !== 'undefined' && UI.showAITrickToast) {
          const desc = givenName
            ? `Stole <b>${stolenName}</b> · gave you <b>${givenName}</b>`
            : `Stole <b>${stolenName}</b> — no trade.`;
          try { UI.showAITrickToast("Deadpool's Final Trick", desc, 'trick'); } catch (e) {}
        }
      };
      // AI-OWNED DEADPOOL — resolve the ENTIRE trade synchronously, no prompts.
      // The prompt flow puts steal and give-back on two separate
      // _aiActionDelay timeouts, and a round advance or the combat watchdog
      // between them leaves a steal with no give-back. The give-back always
      // picks the LOWEST-cost card.
      const _dpOwnerIsAI = dpIs2v2
        ? !!(G.state.twoVTwo && deadpoolOwnerSeat && G.state.twoVTwo.players[deadpoolOwnerSeat] && G.state.twoVTwo.players[deadpoolOwnerSeat].isAI)
        : (self.owner === 'ai' && !(G.isMultiplayer && G.isMultiplayer()));
      if (_dpOwnerIsAI) {
        const victimHand = G.state[opp].hand;
        if (!victimHand.length) { G.log("Deadpool's final trick fails — the enemy has no cards in hand!"); return; }
        const stolen = victimHand[Math.floor(Game.rng() * victimHand.length)];
        const sIdx = victimHand.indexOf(stolen);
        if (sIdx >= 0) victimHand.splice(sIdx, 1);
        stolen.owner = self.owner;
        G.addToHand(self.owner, stolen, self, null, 'Stolen by Deadpool');
        G.log(`Deadpool steals ${stolen.name} from the enemy's hand!`); if (typeof UI !== 'undefined' && UI._fxHandSwap) { try { UI._fxHandSwap(self.owner, 'steal'); } catch (e) {} }
        if (skipGiveBack) { G.log(`Deadpool keeps ${stolen.name} — no trade!`); showVictimToast(stolen.name, null); if (dpIs2v2 && G._2v2OnlineBroadcast) { try { G._2v2OnlineBroadcast(); } catch (e) {} } return; }
        const givePool = ownerHand().filter(c => c.id !== stolen.id);
        if (!givePool.length) { G.log("Deadpool has no cards to give in return."); showVictimToast(stolen.name, null); if (dpIs2v2 && G._2v2OnlineBroadcast) { try { G._2v2OnlineBroadcast(); } catch (e) {} } return; }
        const given = givePool.slice().sort((a, b) => (a.baseCost || a.cost) - (b.baseCost || b.cost))[0];
        const gHand = ownerHand();
        const gIdx = gHand.indexOf(given);
        if (gIdx >= 0) gHand.splice(gIdx, 1);
        given.owner = opp;
        // GIVE BACK TO THE SAME PLAYER HE STOLE FROM: route by victimKey, not a
        // bare side, or addToHand falls back to "first player on that team".
        G.addToHand(opp, given, null, victimKey ? { _2v2PlayedBy: victimKey } : null, 'Slipped in by Deadpool');
        G.log(`Deadpool slips ${given.name} into the enemy's hand!`); if (typeof UI !== 'undefined' && UI._fxHandSwap) { try { UI._fxHandSwap(self.owner, 'give'); } catch (e) {} }
        showVictimToast(stolen.name, given.name);
        if (dpIs2v2 && G._2v2OnlineBroadcast) { try { G._2v2OnlineBroadcast(); } catch (e) {} }
        return;
      }
      const onStolen = (stolen) => {
          // Back to the OWNER for the trade-back decision (2v2 routing).
          if (dpIs2v2) G._2v2CurrentActingPlayer = deadpoolOwnerSeat;
          const idx = G.state[opp].hand.indexOf(stolen);
          if (idx >= 0) G.state[opp].hand.splice(idx, 1);
          stolen.owner = self.owner;
          G.addToHand(self.owner, stolen, self, null, 'Stolen by Deadpool');
          G.log(`Deadpool steals ${stolen.name} from the enemy's hand!`); if (typeof UI !== 'undefined' && UI._fxHandSwap) { try { UI._fxHandSwap(self.owner, 'steal'); } catch (e) {} }

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
              // Same-seat give-back — route to victimKey so the trade returns to
              // the exact player Deadpool stole from, not a random teammate.
              G.addToHand(opp, given, null, victimKey ? { _2v2PlayedBy: victimKey } : null, 'Slipped in by Deadpool');
              G.log(`Deadpool slips ${given.name} into the enemy's hand!`); if (typeof UI !== 'undefined' && UI._fxHandSwap) { try { UI._fxHandSwap(self.owner, 'give'); } catch (e) {} }
              showVictimToast(stolen.name, given.name);
            },
            cards => cards.slice().sort((a, b) => (a.baseCost || a.cost) - (b.baseCost || b.cost))[0],
            // Show the give-back as the full-card TRAY (same as the Symbiote
            // Spider-Man redraw) so it is unmistakable; a hand-highlight is
            // easy to miss.
            // seat — see promptCardChoice's note: the owning seat is DECLARED,
            // not inferred from a global that any async gap can drop.
            { inlineTray: true, seat: dpIs2v2 ? deadpoolOwnerSeat : null });
      };
      // Step 1: DEADPOOL'S OWNER blind-picks a face-down card from the chosen
      // enemy's (shuffled) hand. Same in 1v1 and 2v2: in 2v2 the prompt routes
      // to the owner's seat (an AI owner picks at random via stealPicker), and
      // withChosenOpponent has aliased the victim's hand onto state[opp], so
      // faceDownDeck IS the victim's.
      const stealPicker = cards => cards[Math.floor(Game.rng() * cards.length)];
      if (dpIs2v2) G._2v2CurrentActingPlayer = deadpoolOwnerSeat;
      G.promptCardChoice(self.owner, faceDownDeck, "Deadpool's Final Trick",
        "Pick a face-down card from the enemy's hand to steal", onStolen, stealPicker,
        { faceDown: true, seat: dpIs2v2 ? deadpoolOwnerSeat : null });
      });
    }
  },
  "Green Lantern": {
    // currencyOnDamage is recognized in Game.applyCombatDamage and
    // Game.damagePlayer, which accumulate LANDED damage (not negated by Evade,
    // Invincible, Damage Immunity, full Armor, Mr Freeze, or Block Meter) on
    // self._damageDealtThisTurn. Harvested here at end of round.
    //
    // SPEC: bonus energy applies to the IMMEDIATELY FOLLOWING round only, then
    // resets; it must NOT carry over or stack. Three guards:
    //   1. Flag harvested + zeroed here at end of round.
    //   2. nextTurnCurrency bucket consumed + zeroed in Game.startRound.
    //   3. Flag defensively re-zeroed at the top of Game.startRound (handles edge
    //      cases like a GL that died mid-combat and is later revived).
    passive: "currencyOnDamage",
    onEndOfTurn(G, self) {
      const dmg = self._damageDealtThisTurn || 0;
      self._damageDealtThisTurn = 0;
      if (dmg > 0) {
        // Roguelite Text+ override — _lanternEnergyBonus adds flat energy on
        // top of the damage conversion (default 0, Text+ 2).
        const bonus = self._lanternEnergyBonus || 0;
        const grant = dmg + bonus;
        // Pass SELF: this fires in the end-of-turn sweep, when no seat is
        // acting, so the grant has to name the seat that played him.
        G.addNextTurnCurrency(self.owner, grant, self);
        G.log(`Green Lantern channels ${dmg} damage into +${grant} energy next round${bonus > 0 ? ` (+${bonus} bonus)` : ''}!`);
        if (typeof UI !== 'undefined' && UI._fxGreenLantern) { try { UI._fxGreenLantern(self); } catch (e) {} }
      }
    },
    // If Green Lantern dies in combat, onEndOfTurn won't fire for him
    // (getAllCardsOnBoard filters the dead), so harvest here — his damage
    // still banks. onEndOfTurn zeroes the counter if he survived, so only
    // one path harvests per round.
    onDeath(G, self) {
      const dmg = self._damageDealtThisTurn || 0;
      self._damageDealtThisTurn = 0;
      if (dmg > 0) {
        G.addNextTurnCurrency(self.owner, dmg, self);   // see onEndOfTurn
        G.log(`Green Lantern's last act: +${dmg} energy channeled to next round!`);
      }
    }
  },
  "Jason Voorhees": {
    onDeath(G, self, lane) {
      // Jason revives ONCE PER GAME (not per-instance): the flag lives on the
      // owner's state so a freshly played Jason can't reset it.
      // Roguelite Text+ override — _jasonNoOnceLimit removes the lock so he
      // revives on every kill while reviveCharges last (default false).
      if (!self._jasonNoOnceLimit && G.state[self.owner].jasonReviveUsed) {
        // Once-per-game lock hit — consume the keyword charge so the generic
        // Revive in handleDeath can't fire behind our back (a replayed or
        // copied Jason carries a fresh Revive 1). Doomsday template.
        self.reviveCharges = 0;
        return; // already used this game
      }
      if (self.reviveCharges > 0) {
        // A destroyed lane blocks the revive outright — no relocation (no card
        // can be in a destroyed lane). Charge and once-per-game flag stay
        // unspent; Jason dies normally.
        if (G.reviveVoided(self, lane)) return;
        self.reviveCharges--;
        if (!self._jasonNoOnceLimit) {
          G.state[self.owner].jasonReviveUsed = true;
        }
        // Roguelite Text+ ("Crystal Lake Killer") — _jasonReviveBuff raises
        // the per-revive gain (classic +1 ATK / +2 HP; Text+ +3/+3).
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
        // Revive bypasses Game.playCard, so the registry play cue won't
        // auto-fire — call it explicitly so the sting lands on resurrection.
        try { if (typeof UI !== 'undefined' && UI.sfx) UI.sfx.playCardSfx('Jason Voorhees', 'play'); } catch (e) {}
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
      // Lex Luthor blocks this: Paul's keep is a deck draw (it sets
      // _kangSkipDraw in place of the round's draw) but uses addToHand(),
      // which skips the drawCards() guard. Gate BEFORE popping so a blocked
      // Paul disturbs nothing.
      if (!G.canDrawToHand(self.owner, 'Paul Atreides')) return;
      if (pile.length < 2) {
        G.drawCards(self.owner, Math.min(2, pile.length));
        G.log("Paul Atreides glimpses the future! Not enough cards for full effect.");
        return;
      }
      const card1 = pile.pop();
      const card2 = pile.pop();
      // The "keep this one" resolution — shared by the AI auto-pick, the 2v2
      // human choice below, AND the 1v1 modal in ui.js (kangChoicePick). One
      // door, so the modes can't disagree (e.g. on asking for the lane).
      const keepCard = (pick) => CARD_ABILITIES['Paul Atreides']._keepOne(
        G, self.owner, pick, (pick === card1 ? card2 : card1), self);
      // 2v2 HUMAN: the pendingKangChoice modal has no 2v2 render path, so route
      // through promptCardChoice's inlineTray, which has full 2v2 routing
      // (stamped to the owning seat, renderInlineChoiceFallback,
      // 2v2CardChoiceResult).
      if (Game.isHuman(self.owner) && G.is2v2()) {
        if (G.state && G.state._silentSim) { keepCard(card1.cost >= card2.cost ? card1 : card2); return; }
        G.promptCardChoice(self.owner, [card1, card2],
          'Paul Atreides — Foresee',
          'Keep one card — the other returns to the top of the deck.',
          (kept) => keepCard(kept),
          cards => (cards[0].cost >= cards[1].cost ? cards[0] : cards[1]),
          { inlineTray: true });
        return;
      }
      // 2v2 has no render/resolution path for this modal, and isHuman(side) is
      // true for BOTH teams there, so an AI seat would stall on the prompt +
      // 30s auto-pick. Auto-pick immediately (keep the higher-cost card, as the
      // timeout would).
      if (Game.isHuman(self.owner) && !G.is2v2()) {
        G.state.pendingKangChoice = { owner: self.owner, cards: [card1, card2], kangCard: self };
        // A silent forecast sim (previewPlacement clones the state and runs
        // onPlay on every hover) must NOT drive the UI or arm a real prompt
        // timer. Bail once the choice is recorded on the clone.
        if (G.state && G.state._silentSim) return;
        // 1v1 online: the guest's Kang (owner==='ai') resolves on the guest's
        // client. Broadcast the pending choice but skip the host's render + 30s
        // auto-pick, which would choose and free-play for the guest.
        // Host applies the result via _mpApplyAction promptResolve choiceType:'kang'.
        if (G.isMultiplayer() && G.mp.role === 'host' && self.owner === 'ai') {
          if (typeof G._mpBroadcast === 'function') G._mpBroadcast();
          return;
        }
        try { if (typeof UI !== 'undefined' && UI.render) UI.render(); } catch (e) {}
        G._startPromptTimeout(() => {
          const kc = G.state.pendingKangChoice;
          if (!kc) return;
          const idx = kc.cards[0].cost >= kc.cards[1].cost ? 0 : 1;
          if (typeof kangChoicePick === 'function') { kangChoicePick(idx); }
        });
      } else {
        // AI seat (or a side with no live human): keep the higher-cost card —
        // exactly what the human timeout would have chosen. Doomsday deck-scaling
        // is applied inside keepCard so the AI's Paul doesn't hand him over reset.
        keepCard(card1.cost >= card2.cost ? card1 : card2);
      }
    },
    // ONE KEEP, FOR EVERY MODE — see the note at its caller. Takes `owner` and
    // `source` rather than closing over the ability's `self`, so ui.js's 1v1
    // modal can call it with nothing but the pending choice in hand.
    _keepOne(G, owner, pick, other, source) {
      G.getDrawPile(owner).push(other);
      const card = G._applyDoomsdayDrawScaling(G.createCardInstance(pick, owner), owner);
      card.cost = Math.max(0, card.cost - 2);
      G.addToHand(owner, card, source || null, null, 'Chosen by Paul Atreides');
      // Paul's keep stands in for this round's draw, so the rejected card is
      // not pulled straight back off the top of the pile.
      G.state[owner]._kangSkipDraw = true;
      G.log(`Paul Atreides keeps ${card.name} (cost reduced to ${card.cost})`);
      if (card.cost > 2 || card.isDiscardEffect) return;
      // openEnvLanes, not "any lane that is not destroyed" — the two copies
      // disagreed here as well, and this one asks canPlaceEnvironment.
      const open = card.isEnvironment ? G.openEnvLanes(owner) : G.getOpenLanes(owner);
      if (!open.length) return;
      // THE LANE IS THE PLAYER'S, AND SO IS THE DECISION: "If the kept card
      // costs <= 2, you MAY play it for free" — optional, and placed by the
      // player.
      // An AI seat goes straight to the lowest open lane (promptLaneChoice
      // would auto-pick anyway). A silent forecast sim must never raise a
      // prompt either.
      if (!Game.isHuman(owner) || (G.state && G.state._silentSim)) {
        G.playCardFree(owner, card, open[0]);
        return;
      }
      G.promptLaneChoice(owner, open,
        `${card.name} — Free Play`,
        `Paul Atreides' vision drops ${card.name} to ${card.cost}. Choose a lane, or keep it in hand.`,
        (laneIdx) => { if (laneIdx != null) G.playCardFree(owner, card, laneIdx); },
        owner, card, 0,
        {
          // NOT `forced`, even with one lane open: forcing is for a pick with
          // ONE outcome, and the decline makes this two — play it here, or
          // hold it.
          declineLabel: 'Keep in Hand',
          onDecline: () => G.log(`${card.name} stays in hand.`)
        });
    },
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
        // Full canonical hook list — every hook name any def uses. A missing
        // hook silently drops part of the copied ability (e.g. Ivy's
        // once-per-round re-charm).
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
    // DO NOT SPEND THE FREE SWING ON SOMETHING ALREADY DYING.
    // A free attack is worth what it CHANGES, so each candidate is scored by
    // that, not by board position:
    //   • a kill this swing lands that would NOT have happened otherwise: best
    //   • a kill on something our own body was already going to finish: nearly
    //     worthless
    //   • no kill: chip the biggest real threat (Game.threatOf, so a feared
    //     enemy hurting itself is not treated as a target)
    _targetScore(G, self, ally, t) {
      if (!t || t.currentHealth <= 0) return -1;
      const tl = G.findCardLane(t);
      const facing = tl >= 0 && G.state.lanes[tl] ? G.state.lanes[tl][self.owner] : null;
      // ARMOR COUNTS: a 3-ATK swing into 1 HP with Armor 2 deals 1 and doesn't
      // kill, so a raw `attack >= currentHealth` would score an impossible kill.
      // (Pinned by AT-9.)
      const effective = (atkr) => Math.max(0, (atkr && atkr.attack || 0) - (t.armorValue || 0));
      // Is one of OUR bodies already positioned to finish it this combat?
      const alreadyDoomed = !!(facing && facing.currentHealth > 0
                               && effective(facing) >= t.currentHealth);
      const kills = effective(ally) >= t.currentHealth;
      if (kills && !alreadyDoomed) return 1000 + (t.attack || 0);
      if (kills && alreadyDoomed)  return 10;               // it was dying anyway
      const threat = (G.threatOf ? G.threatOf(t, self.owner) : (t.attack || 0));
      return 100 + threat;
    },
    _bestTarget(G, self, ally, targets) {
      if (!targets || !targets.length) return null;
      const AB = CARD_ABILITIES['Optimus Prime'];
      let best = targets[0], bs = AB._targetScore(G, self, ally, targets[0]);
      for (let i = 1; i < targets.length; i++) {
        const s2 = AB._targetScore(G, self, ally, targets[i]);
        if (s2 > bs) { best = targets[i]; bs = s2; }
      }
      return best;
    },
    // And WHICH ally is commanded follows from that: take the one whose best
    // available swing is worth the most.
    _bestAlly(G, self, lane, allies) {
      if (!allies || !allies.length) return null;
      const AB = CARD_ABILITIES['Optimus Prime'];
      const opp = G.opponent(self.owner);
      const targetsFor = () => {
        const out = [];
        const o = G.state.lanes[lane] ? G.state.lanes[lane][opp] : null;
        if (o && o.currentHealth > 0) out.push(o);
        G.getAdjacentEnemiesInContext(lane, self.owner)
          .forEach(e => { if (e.currentHealth > 0 && out.indexOf(e) < 0) out.push(e); });
        return out;
      };
      const ts = targetsFor();
      if (!ts.length) return allies[0];
      let best = allies[0], bs = -1;
      allies.forEach((a) => {
        let s2 = -1;
        ts.forEach((t) => { s2 = Math.max(s2, AB._targetScore(G, self, a, t)); });
        if (s2 > bs) { best = a; bs = s2; }
      });
      return best;
    },
    onPlay(G, self, lane) {
      const own = self.owner;
      const adj = [];
      // A LOCKED ALLY CANNOT BE COMMANDED. Optimus's swing is an EXTRA action,
      // like a queued bonus attack (_drainBonusAttacks refuses frozen /
      // stunned / feared / mind-controlled cards). isActionLocked is that
      // shared predicate, so a new lock is honoured here for free. Checked on
      // the ALLY being commanded, not on Optimus.
      const canCommand = (a) => !!a && !G.isActionLocked(a);
      if (lane > 0 && canCommand(G.state.lanes[lane-1][own])) adj.push(G.state.lanes[lane-1][own]);
      if (lane < Game.LANE_COUNT-1 && canCommand(G.state.lanes[lane+1][own])) adj.push(G.state.lanes[lane+1][own]);
      if (!adj.length) {
        // Say so rather than failing silently — a card that visibly did nothing
        // looks broken.
        const blocked = [G.state.lanes[lane-1] && G.state.lanes[lane-1][own],
                         G.state.lanes[lane+1] && G.state.lanes[lane+1][own]].filter(Boolean);
        if (blocked.length) {
          G.log(`  [OPTIMUS] ${blocked[0].name} can't answer the call (${G.actionLockLabel(blocked[0])}).`);
        }
      }
      if (adj.length) {
        // Wrap the chain attack so an Overdrive ally (Michael Myers, King
        // Shark, Wolverine post-revive…) still gets "attack again on kill"
        // when the kill came from Optimus's command. resolveCombatLane calls
        // handleOverdrive after a combat kill, but dealDamage has no concept
        // of an attack — so on a chain kill we fire handleOverdrive at the
        // ally's lane manually. It picks its own next target and recurses on
        // further kills, matching in-combat behaviour.
        const chainAttack = (ally, target) => {
          const targetHpBefore = target.currentHealth;
          G.dealDamage(target, ally.attack, ally);
          // Determine if THIS dealDamage landed the kill — HP alone isn't
          // enough, the target may already be dead from an earlier ability.
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
            }, (cs) => CARD_ABILITIES['Optimus Prime']._bestTarget(G, self, ally, cs));
          } else if (targets.length) {
            const pick = CARD_ABILITIES['Optimus Prime']._bestTarget(G, self, ally, targets) || targets[0];
            chainAttack(ally, pick);
            G.log(`Optimus commands ${ally.name} to attack ${pick.name} for ${ally.attack}!`);
          }
        };
        // Roguelite Text+ override — _optimusCommandsBoth commands BOTH
        // adjacent allies (no pick). Default false (pick one).
        if (self._optimusCommandsBoth) {
          adj.forEach(ally => doAttack(ally));
        } else if (Game.isHuman(self.owner)) {
          G.promptCardChoice(self.owner, adj, "Optimus — Choose Ally", "Choose adjacent ally to command", doAttack,
            (cs) => CARD_ABILITIES['Optimus Prime']._bestAlly(G, self, lane, cs));
        } else {
          doAttack(CARD_ABILITIES['Optimus Prime']._bestAlly(G, self, lane, adj) || adj[0]);
        }
      }
    }
  },
  "Predator": {
    // Trophy buff on every Predator kill — shared by the on-play strike and
    // the generic onKill. Classic +1/+0; Text+ "_predatorTrophyBuff" +N/+N
    // (apply-side default 2).
    _claimTrophy(G, self) {
      const atk = self._predatorTrophyBuff || 1;
      const hp  = self._predatorTrophyBuff || 0;
      G.buffCard(self, atk, hp);
      G.log(`Predator claims a trophy! +${atk}/+${hp} → ${self.attack}/${self.currentHealth}`);
    },
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _predatorStrikeDamage scales the initial
      // strike (default 3, Text+ 5).
      const dmg = self._predatorStrikeDamage || 3;
      const enemies = G.getEnemiesOf(self.owner).filter(t => G.canEffectLand(t, 'damage', { owner: self.owner, source: self }));
      if (enemies.length) {
        G.promptCardChoice(self.owner, enemies, "Predator — Strike", `Choose enemy to deal ${dmg} damage`, (t) => {
          try { if (typeof UI !== 'undefined' && UI.sfx) UI.sfx.playCardSfx('Predator', 'ability', self); } catch (e) {}
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
        // Roguelite Text+ override — _myersAloneBuff scales the lone-wolf
        // reward (default +1/+1, Text+ +2/+2).
        const buff = self._myersAloneBuff || 1;
        G.buffCard(self, buff, buff);
        G.log(`Michael Myers stalks alone — +${buff}/+${buff}!`);
      }
      if (typeof UI !== 'undefined' && UI._fxMyersStalk) { try { UI._fxMyersStalk(self); } catch (e) {} }
    },
    onDeath(G, self) { self.jumpReady = false; self.jumpLane = undefined; }
  },
  "Death": {
    // When Played: reap the card that woke him. _deathTriggerId is stamped by
    // the jump condition (Game._armJumpForCard) as the longest-standing card on
    // the board; a Death played the ordinary way (bought, not jumped) has no
    // trigger and simply arrives.
    onPlay(G, self, lane) {
      const tId = self._deathTriggerId;
      const wokeIds = self._deathWokeBy;
      self._deathTriggerId = null;
      self._deathWokeBy = null;
      if (tId == null) return;
      const reap = (target) => {
        if (!target || target.id === self.id || target.currentHealth <= 0) return;
        G.log(`Death reaps ${target.name} for 3!`);
        try { if (typeof UI !== 'undefined' && UI._fxImpact) UI._fxImpact(target); } catch (e) {}
        G.dealDamage(target, 3, self);
      };
      const live = (id) => G.getAllCardsOnBoard().find(c => c && c.id === id && c.currentHealth > 0);
      // WHOEVER WOKE HIM IS A CHOICE: _deathWokeBy holds every card that had
      // stood long enough to raise him, each a legal answer, so the player
      // picks. One candidate needs no modal; an AI owner or unanswered prompt
      // falls back to the longest-standing card.
      const choices = (Array.isArray(wokeIds) ? wokeIds : [tId])
        .map(live).filter(c => c && c.id !== self.id);
      if (choices.length <= 1) { reap(choices[0] || live(tId)); return; }
      G.promptCardChoice(self.owner, choices, 'Death — Reap',
        'Choose who Death rose for — he deals 3 to them.',
        reap,
        (cards) => cards.find(c => c.id === tId) || cards[0],
        self._2v2PlayedBy ? { seat: self._2v2PlayedBy } : undefined);
    },
    // Every kill feeds the hunt — brand another enemy the instant one falls.
    onKill(G, self) {
      G._deathMarkRandomEnemy(self, 'Death claims another soul');
    },
    // While Active: at the top of every round, each Marked enemy withers 1 HP.
    // Gated on Death still standing (onTurnStart runs for every board card, but
    // this drain is HIS aura, not the marks' own).
    onTurnStart(G, self) {
      if (self.currentHealth <= 0) return;
      G.getEnemiesOf(self.owner).forEach(e => {
        if (e && e.isMarked && e.currentHealth > 0) {
          G.log(`  [MARK] The mark withers ${e.name} for 1.`);
          G.dealDamage(e, 1, self);
        }
      });
    },
    // At the end of every round Death survives, one more enemy is Marked.
    onEndOfTurn(G, self) {
      if (self.currentHealth <= 0) return;
      G._deathMarkRandomEnemy(self, 'Death marks the living');
    },
    onDeath(G, self) { self.jumpReady = false; self.jumpLane = undefined; }
  },
  "Raven": {
    onPlay(G, self, lane) {
      if (typeof UI !== 'undefined' && UI._fxRavenSoul) { try { UI._fxRavenSoul(self); } catch (e) {} }
      const opp = G.opponent(self.owner);
      // Capture the opp's meter BEFORE zeroing so the Text+ steal path can
      // transfer it.
      const drainedAmount = G.getBlockMeter(opp);
      G.setBlockMeter(opp, 0);
      if (drainedAmount > 0) G.emitFX('blockDrain', { owner: opp, amount: drainedAmount });
      G.log(`Raven empties the opponent's Block Meter!`);
      G.getAlliesOf(self.owner).forEach(a => {
        // Clear counters AND booleans together — debuff stacking
        // refactor uses counters as the source of truth.
        a.stunnedTurns = 0; a.isStunned = false;
        a.frozenTurns  = 0; a.isFrozen  = false;
      });
      G.log("Raven cleanses all allies!");
      // Roguelite Text+ override — _ravenStealsBlock turns the drain into a
      // transfer into your own meter (default false: just zero the opp).
      if (self._ravenStealsBlock && drainedAmount > 0) {
        G.addBlockMeter(self.owner, drainedAmount);
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
      // A FULL TRICK HAND DOESN'T KILL THE STEAL: keep() routes through
      // _gainTrickWithTrade, which offers a trade when full (addToTrickHand
      // would discard at maxTrickHandSize), or gives it back + triples on
      // decline. So no early-out here.
      // Two choices in sequence, each gated on a different seat's isHuman:
      //   1. OPP picks which trick to give up (human → prompt; AI → lowest cost)
      //   2. Grinch OWNER picks keep-or-give-back (human → prompt; AI → threshold)
      const resolveGrinchChoice = (chosen) => {
        // Back to the OWNER for the keep/give-back decision (the victim only
        // chose which trick to surrender).
        if (G.state.twoVTwo && G.state.twoVTwo.online) G._2v2CurrentActingPlayer = grinchOwnerSeat;
        // Remove the EXACT chosen object, not the first same-named one — decks
        // hold up to 2 copies (COPY_MAX=2) that can differ in mutated state.
        // Same identity pattern as Deadpool and game.js trick removal.
        const idx = th.indexOf(chosen);
        if (idx >= 0) th.splice(idx, 1);
        // Roguelite Text+ override — _grinchKeepCostBump scales the cost
        // penalty on kept tricks (default 1, Text+ 0).
        const keepBump = (self._grinchKeepCostBump != null) ? self._grinchKeepCostBump : 1;
        const keep = () => {
          // Via _gainTrickWithTrade: a FULL hand offers a trade; declining runs
          // giveBack() (trick returns, Grinch triples). The cost bump applies
          // to the copy that actually LANDS (negative bumps floor at 0), so a
          // declined trade never leaves a bumped trick behind.
          const grinchIs2v2 = !!(G.state.twoVTwo && G.state.twoVTwo.online);
          G._gainTrickWithTrade(self.owner, chosen, {
            seat: grinchIs2v2 ? grinchOwnerSeat : null,
            isAI: grinchOwnerIsAI,
            title: 'The Grinch — trick hand full',
            desc: `Choose a trick to discard to keep ${chosen.name}, or give it back.`,
            declineLabel: 'Give it back (triple stats)',
            onKept: (landed) => {
              if (landed) landed.cost = Math.max(0, (landed.cost || 0) + keepBump);
              const c = landed ? landed.cost : Math.max(0, (chosen.cost || 0) + keepBump);
              const label = keepBump > 0 ? ` (cost +${keepBump})`
                : keepBump < 0 ? ` (cost ${keepBump} → ${c})`
                : ' (free!)';
              G.log(`The Grinch keeps ${chosen.name}${label}!`);
            },
            onDecline: () => giveBack(),
          });
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
          if (typeof UI !== 'undefined' && UI.render) { try { UI.render(); } catch (e) {} }
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
        G.promptCardChoice(opp, [...th], "The Grinch — Steal", "The Grinch is stealing! Choose a trick to give up",
          resolveGrinchChoice, lowestCost, victimKey ? { seat: victimKey } : null);
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
      // Roguelite Text+ ("Symbiote Bond") — _venomHealAllCards counts every
      // card on board; classic heals ally count × _venomHealMul.
      let amount;
      if (self._venomHealAllCards) {
        amount = G.getAllCardsOnBoard().length;
      } else {
        const ct = G.getAlliesOf(self.owner).length;
        const mul = self._venomHealMul || 1;
        amount = ct * mul;
      }
      if (amount > 0) {
        if (typeof UI !== 'undefined' && UI._fxSymbioteHeal) { try { UI._fxSymbioteHeal(self); } catch (e) {} }
        G.healPlayer(self.owner, amount, self);
        G.log(`${G.seatVerb(self.owner, 'heal', 'heals')} for ${amount} — Venom!`);
        self.venomHealed = true;
      }
    }
  },
  "Wolverine": {
    onDamaged(G, self, attacker) {
      if (typeof UI !== 'undefined' && UI._fxAdamantium) { try { UI._fxAdamantium(self); } catch (e) {} }
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
        // No `justResurrected` stamp — see the Overdrive check in
        // resolveLaneCombat; nothing reads it.
        // While-Active passive (onDamaged "destroy attacker cost ≤ 7") is
        // intentionally DISABLED on revive: the second life is raw 6/5
        // Overdrive with no retaliation, so the passive can't be used across
        // two bodies in one match.
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
      // Roguelite Text+ — _wwStunSize scales the freeze duration (default 1,
      // Text+ 2). Stun is merged into Freeze.
      const freezeN = self._wwStunSize || 1;
      const e = G.state.lanes[lane] ? G.state.lanes[lane][G.opponent(self.owner)] : null;
      if (e) { G.freezeCard(e, self, freezeN); }
      if (typeof UI !== 'undefined' && UI._fxWonderWomanLasso) { try { UI._fxWonderWomanLasso(self, e); } catch (err) {} }
      // _wonderWomanBlockGain scales the block meter add. Default 2
      // (classic); Text+ bumps to 4.
      const blockGain = self._wonderWomanBlockGain || 2;
      G.addBlockMeter(self.owner, blockGain);
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
      // ...and only if that swing CONNECTS. Evade / Invincible / Damage
      // Immunity on the front target whiffs the whole strike, lasso included.
      // Armor doesn't block the chain — the hit still lands.
      const canDodge = !target.isStunned && !target.isFrozen && !self.ignoresEvade;
      if (G._classifyAbsorb(target, canDodge)) return;
      // Roguelite Text+ ("Lasso of Truth") — _wwChainAllAdj chains BOTH
      // adjacent enemies (no direction prompt). Classic picks left or right.
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
      // ONE chained enemy, not the whole consecutive run. She still picks left
      // or right when both sides have a body; the chain stops after the first.
      G.log(`Wonder Woman's lasso chains — ${chainDmg} chain damage!`);
      G.autoChainDamage(self.owner, myLane, chainDmg, 0, null, "LASSO CHAIN", 1);
    }
  },

  // ==================== COST 5 ====================
  "Davy Jones": {
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _aquamanCreatureAtkBump /
      // _aquamanCreatureHpBump scale the Kraken above its 5/3 base (default
      // 0/0, Text+ +4/+6 → 9/9). The `_aquaman*` names are kept for save-data
      // compatibility (card rebranded to Davy Jones).
      const atkBump = self._aquamanCreatureAtkBump || 0;
      const hpBump  = self._aquamanCreatureHpBump  || 0;
      if (typeof UI !== 'undefined' && UI._fxDavyKraken) { try { UI._fxDavyKraken(self); } catch (e) {} }
      G.summonCardChoice(self.owner, "The Kraken", 4, 5 + atkBump, 6 + hpBump, []);
    }
  },
  "Captain America": {
    onPlay(G, self, lane) {
      // Cost reduction is LIVE — no card.cost mutation here. Game.getCardCost
      // subtracts the discount per active CA at query time, so it vanishes
      // when Cap dies. This onPlay only grants Invincible to an ally and logs
      // the rally once.
      const disc = G.rarityValue(self, { common: 1, rare: 1, special: 2, legendary: 2 });
      const count = G.state[self.owner].hand.filter(c => c.cost > 0).length;
      G.log(`Captain America rallies the team — ${count} card${count === 1 ? '' : 's'} in hand cost ${disc} less!`);
      if (typeof UI !== 'undefined' && UI._fxRallyHand) { try { UI._fxRallyHand(self); } catch (e) {} }
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
      const doomed = G.getEnemiesOf(self.owner)
        .filter(e => e.currentHealth < e.maxHealth && (e.baseCost || e.cost) <= maxCost);
      if (typeof UI !== 'undefined' && UI._fxIronManScan) { try { UI._fxIronManScan(self, doomed); } catch (e) {} }
      doomed.forEach((t, i) => {
          if (typeof UI !== 'undefined' && UI._fxIronManRepulsor) { try { UI._fxIronManRepulsor(self, t, i); } catch (e) {} }
          G.log(`Iron Man finishes off ${t.name}!`); G.killCard(t, self);
        });
    }
  },
  "Joker": {
    // Joker has Insane (his ATK rolls 2-7 each turn, via the reroll sweep in
    // game.startRound) and stamps Crazy on the highest-ATK enemy, persisting
    // while Joker lives.
    // STAMP TIMING: at Start of Tricks, not Start of Round — the play phase
    // comes after round start, so this lands on the strongest enemy actually
    // on the board when tricks resolve. Also re-stamped at onEndOfTurn so a
    // target dying in combat leaves no "no-target" gap.
    // _recurringBT lets onBeforeTricks fire EVERY round; otherwise
    // beforeTricksFired locks it to one trigger per instance.
    _recurringBT: true,
    onPlay(G, self, lane) {
      // Fear cost gate scales with tier: common ≤2, rare ≤4, special ≤6,
      // legendary ≤9. The Crazy stamp fires regardless of tier.
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
          cards => G.pickBiggestThreat(cards, self.owner));
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
      // Post-combat — if the Crazy target died this round, stamp the next-
      // highest enemy so there's never a "no target" gap. No-op if a target
      // already carries Crazy (_stampTopEnemyCrazy guard).
      CARD_ABILITIES.Joker._stampTopEnemyCrazy(G, self);
    },
    onDeath(G, self) {
      // When Joker dies, strip Crazy from his victims AND restore their
      // pre-Crazy ATK (snapshotted to `_preCrazyAttack` by
      // Game.applyCrazyToCard), falling back to baseAttack. Clears the
      // per-roll memory so a later re-Crazy starts fresh.
      // EVERYWHERE, not just the board: a victim off-board when Joker dies
      // (dead pile, mid-revive, in hand — Mahoraga constantly) would keep the
      // stamp with nothing left to clear it.
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
      // Feared enemies can never hold Crazy — skipped so the stamp falls to
      // the next-highest eligible enemy instead of whiffing in
      // applyCrazyToCard.
      const enemies = G.getAllCardsOf(G.opponent(self.owner))
        .filter(e => e.currentHealth > 0 && !e.isEnvironment
          && !e.isFeared && !((e.fearedTurns || 0) > 0));
      if (!enemies.length) return;
      // Rank by EFFECTIVE attack: the current Crazy target's ATK is
      // suppressed to a 1-4 roll, so compare it by its pre-Crazy snapshot or a
      // weaker enemy steals the stamp. Everyone else uses live ATK.
      const effAtk = (c) => (c.isCrazy && c._preCrazyAttack != null)
        ? c._preCrazyAttack : (c.attack || 0);
      const top = enemies.slice().sort((a, b) => effAtk(b) - effAtk(a))[0];
      if (!top) return;
      if (top.isCrazy) return; // already the stamped target — sweep rerolls it
      // EXCLUSIVE stamp — exactly ONE enemy carries Joker's Crazy. Strip +
      // restore the old target before re-stamping; the stamp rolls over
      // round-to-round until this re-check moves it.
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
      if (typeof UI !== 'undefined' && UI._fxJokerCrazy) { try { UI._fxJokerCrazy(top); } catch (e) {} }
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
    // lane on the caster's side, or the lifted target is stranded in limbo.
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
      // Roguelite Text+ override — _profXConvertCost raises the cost ceiling
      // for convertible enemies. Default 4 (classic); Text+ 6.
      const maxCost = (self && self._profXConvertCost) || 4;
      const enemies = G.getEnemiesOf(owner).filter(e => (e.baseCost != null ? e.baseCost : e.cost) <= maxCost);
      if (!enemies.length) return;
      G.promptCardChoice(owner, enemies, "Professor X — Convert", `Choose enemy with base cost ${maxCost} or less to permanently join your team`, (t) => {
        // Re-check space at RESOLVE time (a lane can fill while the prompt is
        // open) and BEFORE the target is lifted off its lane, or it ends up
        // off-board, in no hand, no pile.
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
        // The convert is now yours, including its prompts: wipe the original
        // player's provenance and stamp the new owner, or later choices (Han
        // Solo's shot, re-run onPlays) route to the wrong seat. Same move
        // Batman Who Laughs makes when it steals a card.
        G._clearProvenance(t);
        delete t._mcSeat;
        const casterSeat = (self && self._2v2PlayedBy)
          || (G._2v2SeatOwning ? G._2v2SeatOwning(self) : null);
        if (casterSeat) t._2v2PlayedBy = casterSeat;
        G.log(`Professor X converts ${t.name} to ${G.seatPossessive(self.owner)} team!`);
        if (typeof UI !== 'undefined' && UI._fxProfessorX) { try { UI._fxProfessorX(t); } catch (e) {} }
        const open = G.getOpenLanes(owner);
        if (!open.length) return;
        G.promptLaneChoice(owner, open, `Place ${t.name}`, `Choose a lane for ${t.name}`, (l) => {
          G.state.lanes[l][owner] = t;
          // Re-stamp the rest of the provenance now it has landed, so "played
          // by" reads as the converter and not as a card with no history.
          if (G._stampProvenance) G._stampProvenance(t, owner);
          G.log(`${t.name} joins ${G.seatPossessive(owner)} side in lane ${l + 1}!`);
          // Entering a lane by ANY mechanism must spring a waiting Bear Trap —
          // direct lane assignment bypasses checkLaneTrap. Also reconcile
          // Magneto's parity aura for the lane he landed in.
          G.checkLaneTrap(t, l);
          G.applyMagnetoDebuffs();
          if (t.currentHealth <= 0) { G.cleanupDead(); return; }  // trap killed the arrival
          // "Its abilities reactivate" — re-fire When Played first, THEN sweep
          // sibling reactions (onAnyCardPlayed) and the cardPlayedBuff passive.
          // Order matters: copiers like Scarlet Witch start at 0/0 and resolve
          // real stats inside onPlay; sibling auras (Luke −1/−1) firing first
          // would kill her before she copies.
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
    // 4th param `actual` is the damage that actually landed (after armor /
    // reductions) — matches "Splash THAT damage back". Falls back to
    // attacker.attack when a caller doesn't supply it.
    onDamaged(G, self, attacker, actual) {
      let dmg = (typeof actual === 'number' && actual > 0)
        ? actual
        : (attacker ? attacker.attack : 1);
      if (dmg <= 0) return;
      // Roguelite Text+ override — _redHulkRetaliateBonus adds extra damage to
      // the splash AND block-meter add. Default 0 (classic); Text+ 2.
      const bonus = self._redHulkRetaliateBonus || 0;
      dmg += bonus;
      G.addBlockMeter(self.owner, dmg);
      if (typeof UI !== 'undefined' && UI._fxRedHulkRage) { try { UI._fxRedHulkRage(self); } catch (e) {} }
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
          try { if (typeof UI !== 'undefined' && UI.sfx) UI.sfx.playCardSfx('Spider-Man', 'ability', self); } catch (e) {}
          if (typeof UI !== 'undefined' && UI._fxSpiderWeb) { try { UI._fxSpiderWeb(self, t); } catch (e) {} }
        }, _aiThreatPicker);
      }
    },
    onEvade(G, self) {
      // Roguelite Text+ overrides — _spiderManEvadeBuff scales the grow buff
      // (default +1/+1, Text+ +2/+2); _spiderManRegainChance is the chance to
      // regain an evade charge (default 0.5, Text+ 0.75).
      const buff = self._spiderManEvadeBuff || 1;
      const regain = (typeof self._spiderManRegainChance === 'number') ? self._spiderManRegainChance : 0.5;
      G.buffCard(self, buff, buff);
      if (typeof UI !== 'undefined' && UI._fxSpiderDodge) { try { UI._fxSpiderDodge(self, false); } catch (e) {} }
      G.log(`Spider-Man evades and grows! +${buff}/+${buff}`);
      if (Game.rng() < regain) {
        self.evadeCharges += 1;
        if (typeof UI !== 'undefined' && UI._fxSpiderDodge) { try { UI._fxSpiderDodge(self, true); } catch (e) {} }
        G.log(`Spider-Man's spider-sense tingles! Extra evade charge!`);
      }
    }
  },
  "The Batman Who Laughs": {
    onPlay(G, self, lane) {
      // Every BWL play arms a fresh intercept — multiple BWLs each fire
      // independently. `bwlInterceptUsed` is still flipped by
      // _resolveBwlIntercept for save/MP schema compatibility but no longer
      // gates new plays.
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
      // When open lanes ≤ zombies to summon, every choice is forced (identical
      // 3/1 tokens), so auto-place without prompting. With more open lanes
      // than warriors, prompt for each placement.
      const openLanes = G.getOpenLanes(self.owner);
      if (openLanes.length <= zombies) {
        // Auto-place: fill each open lane in order with one warrior; any
        // warriors beyond the open-lane count are silently dropped.
        const _helaWarriors = [];
        // Marked: several bodies into lanes chosen up front, synchronously.
        G._withSummonLoop(() => {
          for (let i = 0; i < openLanes.length && i < zombies; i++) {
            G.summonCard(self.owner, openLanes[i], "Undead Warrior", 1, 3, 1, []);
            if (G.state.lanes[openLanes[i]]) _helaWarriors.push(G.state.lanes[openLanes[i]][self.owner]);
          }
        });
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
    // WHEN DESTROYED — the dead-pile draw, deliberately matching Solomon
    // Grundy's onDeath: the same shared pile (both sides' dead piles), the
    // same canDrawToHand gate so Lex Luthor blocks it (addToHand bypasses the
    // drawCards() guard, so the check must be explicit), one card per pull.
    // Her count scales with rarity, unlike Grundy's flat 1.
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
        G.addToHand(self.owner, drawn, self, null, 'Raised from the Dead Pile');
        G.log(`Hela's death draws ${card.name} from the dead pile!`);
      }
    }
  },
  "Homelander": {
    onPlay(G, self, lane) {
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id).sort((a, b) => a.cost - b.cost);
      if (!allies.length) return;

      // Per-mode targeting through the canonical gate (canEffectLand):
      //   DESTROY — blocked by Invincible only. Evade dodges an ATTACK, not a
      //   destroy effect, so Evade cards stay valid destroy targets.
      //   DAMAGE — Evade cards stay targetable; dealDamage spends the charge
      //   to absorb the hit.
      // The gate also excludes environments, face-down cards, already-dead
      // cards and 10-cost source immunity.
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
          // Roguelite Text+ override — _homelanderDmgBonus adds flat damage on
          // top of the sacrificed ally's cost. Default 0 (classic); Text+ 3.
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
          // destroyable but not damageable (Damage Immunity) still deserves
          // the prompt.
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
      if (typeof UI !== 'undefined' && UI._fxHulkLanding) { try { UI._fxHulkLanding(self); } catch (e) {} }
      // Roguelite Text+ override — _hulkSmashDamage scales the SMASH sweep.
      // Default 2 (classic); Text+ 4.
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
        // lane slots and do NOT filter the dead, so a card killed earlier in
        // this resolution (e.g. by Magneto's own parity aura, before
        // cleanupDead) must not be offered.
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
        // RE-VALIDATE AT THE MOMENT OF THE MOVE. Each completed move runs
        // moveCard -> applyMagnetoDebuffs -> recomputeAuras, and the parity
        // aura can KILL an enemy pushed into an even lane, so the target can
        // die between pick and move (two separate interactions — the sim
        // can't show this, its shim resolves prompts synchronously).
        const from = G.findCardLane(target);
        if (!target || target.currentHealth <= 0 || from < 0) {
          // The target died before the move landed. Do NOT count it: re-run
          // step() to offer another LIVING card so Magneto still gets both
          // moves. candidates() excludes the dead, so no loop.
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
      // Declared once, used by every prompt below — see promptCardChoice's
      // note on options.seat. A card->lane->card chain is exactly where a
      // derived seat goes stale. _2v2PlayedBy alone is not enough (AI seats'
      // plays aren't always tagged, leaving prompts ownerless); _2v2SeatOwning
      // derives the seat from the card's side when the stamp is missing and
      // refuses a stale stamp from a card that changed hands.
      const magSeat = self._2v2PlayedBy
        || (Game._2v2SeatOwning && Game._2v2SeatOwning(self))
        || null;
      const magOpts = magSeat ? { seat: magSeat } : null;
      const magTray = Object.assign({ inlineTray: true }, magOpts || {});
      const step = () => {
        if (moved.length >= MOVE_COUNT) { G.applyMagnetoDebuffs(); return; }
        const pool = candidates();
        if (!pool.length) {
          // Never silent: with nothing legal to move, say so, or a card that
          // did exactly what it should reads as a card that did nothing.
          G.log(moved.length
            ? `  [MAGNETO] Nothing else can be moved — magnetism settles.`
            : `  [MAGNETO] No card can be moved right now (every card is frozen, stunned, or has nowhere to slide).`);
          G.applyMagnetoDebuffs();
          return;
        }
        if (Game.isHuman(self.owner)) {
          // One candidate is not a choice: promptCardChoice skips the tray for
          // a single-option list, so offer an explicit confirm instead.
          // Deliberately ONLY at 1 — with two or more options the move stays
          // mandatory, because then it IS a decision.
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
                  `Choose a new lane for ${only.name}`, (to) => finishMove(only, to), only.owner,
                  null, 0, magOpts);
              },
              cards => cards[0], magTray);
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
                `Choose a new lane for ${target.name}`, (to) => finishMove(target, to), target.owner,
                null, 0, magOpts);
            },
            cards => { const p = aiPick(cards); return p ? p.card : cards[0]; }, magTray);
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
    // ONE REFLECT, TWO DOORS IN: damage he TOOK (onDamaged) and damage
    // ABSORBED before it reached him (onAbsorbedHit). Nth Metal / Invincible
    // make dealDamage return before _afterDamage, so without the second door
    // shielding Obi-Wan would switch his ability off.
    _reflect(G, self, attacker, dmg) {
      if (!attacker || !dmg || dmg <= 0) return;
      if (self._obiWanReflecting) return;
      const selfLane = G.findCardLane(self);
      const atkLane = G.findCardLane(attacker);
      if (selfLane < 0 || atkLane < 0 || atkLane === selfLane) return;
      self._obiWanReflecting = true;
      // Roguelite Text+ override — _obiWanReflectMul scales the reflect damage.
      // Default 1 (classic 1:1); Text+ 2.
      const mul = self._obiWanReflectMul || 1;
      const reflectDmg = dmg * mul;
      G.log(`  [REFLECT] Obi-Wan deflects ${reflectDmg} damage back to ${attacker.name}!`);
      if (typeof UI !== 'undefined' && UI._fxObiReflect) { try { UI._fxObiReflect(self, attacker); } catch (e) {} }
      G.dealDamage(attacker, reflectDmg, self);
      self._obiWanReflecting = false;
    },
    onDamaged(G, self, attacker, dmg) {
      CARD_ABILITIES['Obi-Wan']._reflect(G, self, attacker, dmg);
    },
    onAbsorbedHit(G, self, attacker, wouldHave) {
      CARD_ABILITIES['Obi-Wan']._reflect(G, self, attacker, wouldHave);
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
      // Roguelite Text+ override — _ultronReplicateStats bumps each replica's
      // stats. Default { atk: 5, hp: 3 } (classic); Text+ { atk: 7, hp: 5 }.
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
        // Doombot is 5/5 to mirror Dr. Doom's own 5/5 line.
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
          // Permanent -3 cost reduction (clamped to 0), revived card only.
          // Touch `cost` only — baseCost drives the rarity tier, which must not
          // change just because Doom dropped the play cost.
          // Roguelite Text+ override — _doomReviveDiscount scales the cut.
          // Default 3 (classic); Text+ 5.
          const reviveCut = self._doomReviveDiscount || 3;
          card.cost = Math.max(0, card.cost - reviveCut);
          G.addToHand(owner, card, self, null, 'Revived by Dr. Doom');
          if (typeof UI !== 'undefined' && UI._fxDoomRevive) { try { UI._fxDoomRevive(self); } catch (e) {} }
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
        // for every candidate (empty, undestroyed enemy-side lanes), so if it
        // is empty the prompt cannot lead anywhere.
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
          // CONE LANES FIRST, ALWAYS — not just for the AI. A human still sees
          // every lane; but every path that does NOT choose (30s timeout, stall
          // watchdog, force-recovery) takes lanes[0], and a destination inside
          // the cone is the only one that makes the ATK strip do anything.
          const cone = new Set([lane - 1, lane, lane + 1]);
          openLanes.sort((a, b) => (cone.has(a) ? 0 : 1) - (cone.has(b) ? 0 : 1));
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
    // 2nd round, so the destruction lands mid-combat: enemies in the erased
    // lanes die before they swing that same turn.
    onLaneResolved(G, self, laneIdx) {
      if (self._gojoFired) return;
      if (self._gojoCombats === undefined) return;
      // Only count combats that resolve in Gojo's own lane (the card moved or
      // lanes destroyed could otherwise mis-credit the counter).
      if (laneIdx !== G.findCardLane(self)) return;
      self._gojoCombats++;
      if (self._gojoCombats < 2) return;
      self._gojoFired = true;
      // Hollow Purple cue — fires only when the ability ACTUALLY resolves, not
      // when Gojo enters play.
      try { if (typeof UI !== 'undefined' && UI.sfx) UI.sfx.playCardSfx('Gojo', 'ability', self); } catch (e) {}
      const opp = G.opponent(self.owner);
      const gojoLane = G.findCardLane(self);
      if (gojoLane < 0) return;
      // THREE RANDOM LANES — same reach as the old opposite-parity rule (three
      // lanes) but cannot be dodged by placement.
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
      const erased = [];
      for (const i of picked) {
        const e = G.state.lanes[i][opp];
        if (e && e.currentHealth > 0) {
          // Name it BEFORE the kill — killCard can clear the slot and a death
          // hook can move the object, so reading it afterwards is a race.
          const who = e.name;
          if (typeof UI !== 'undefined' && UI._fxHollowPurple) { try { UI._fxHollowPurple(self, e); } catch (er) {} }
          G.killCard(e, self);
          if (e.currentHealth <= 0) erased.push({ lane: i, name: who });
          G.log(`  Gojo destroys ${who} in lane ${i + 1}!`);
        }
      }
      // Record the strike: the lanes are seeded-random and resolve mid-combat,
      // so this is the only clear answer to "which lanes did it hit".
      G.noteLaneStrike(self, 'Hollow Purple', picked, erased);
    }
  },
  "Gorr": {
    onPlay(G, self, lane) {
      // Kill the highest-cost card in BOTH players' hands and show the victims.
      // Roguelite Text+ override — _gorrEnemyOnly limits the devour to the
      // OPPONENT'S hand. Default false (classic hits both); Text+ true.
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
          if (typeof UI !== 'undefined' && UI.render) { try { UI.render(); } catch (e) {} }
        }
        const dd = G.drawFromSummonDeck(c => !c.isDiscardEffect && c.cost >= 2 && c.cost <= 9 && (c.attack || 0) > 0);
        if (dd) G.summonCardChoice(self.owner, dd.name, dd.cost, dd.attack, dd.health, dd.abilities || [], null, null, dd);
        return;
      }
      // 2v2: the side proxy only holds the ACTIVE player's hand, so
      // withChosenOpponent aliases one chosen enemy PLAYER's hand onto it for
      // the duration — same bridge as every hand-reaching card (Mace Windu,
      // Freddy, Deadpool, The Grinch, Lasso of Truth). 1v1 resolves instantly.
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
      // Stash a banner payload so the player sees which cards died. STRUCTURED
      // PER SEAT, not a baked sentence: each client words it at render time via
      // Game.seatLabel, so online matches name real players and the guest reads
      // its own perspective. _mpFlipPerspective swaps the two seat keys for the
      // guest.
      if (killed.player || killed.ai) {
        G.state._gorrBanner = {
          player: killed.player ? { name: killed.player.name, cost: killed.player.cost } : null,
          ai:     killed.ai     ? { name: killed.ai.name,     cost: killed.ai.cost     } : null,
          at: Date.now()
        };
        if (typeof UI !== 'undefined' && UI.render) { try { UI.render(); } catch (e) {} }
      }
      // Pull from the shared summon deck. Duplicates of cards in hand are
      // allowed, so no in-play exclusion. Filter: cost 2-9, attack > 0, not a
      // discard-effect card.
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
        // Roguelite Text+ ("Adaptive Wheel") — _mahoragaReviveBuff adds +N/+N
        // on top of base stats at revive. Falls back to explicit revAtk/revHp
        // flags, then to classic 7/9.
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
    // _recurringBT lets onBeforeTricks fire every round (not just the entry
    // round) — same plumbing as Man-Bat's recurring move. Without it,
    // beforeTricksFired locks the hook to one trigger per instance.
    _recurringBT: true,
    onPlay(G, self, lane) {
      // Roguelite Text+ override — _omniManSweep scales the AOE damage.
      // Default 3 (classic); Text+ 5.
      // Effects-as-data: the sweep runs as a declarative step through
      // G.runEffect (deal `sweep` to every living enemy) — pinned by golden RG-16.
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
    // relocates to an empty ally lane (if one exists); stun/freeze gates the
    // move identically. Unlike Man-Bat, no -1/-1 lands on the destination's
    // opposite enemy — the move is purely repositioning.
    onBeforeTricks(G, self, lane) {
      // See Man-Bat for why this asks isMoveLocked and not isActionLocked.
      if (Game.isMoveLocked(self)) {
        G.log(`  [SKIP] ${self.name} is ${Game.moveLockLabel(self)} — stays put.`);
        return;
      }
      const open = G.getOpenLanes(self.owner).filter(l => l !== lane);
      if (!open.length) return;
      // The player may decline to stay in place.
      if (Game.isHuman(self.owner)) {
        // STAY is a BUTTON, not a lane (see promptLaneChoice
        // options.declineLabel) — Omni-Man's own lane square is covered by the
        // card itself, so it can't be reliably clicked.
        G.promptLaneChoice(self.owner, open, "Omni-Man — Move", "Choose a lane to move to", (to) => {
          G.moveCard(self, lane, to);
        }, null, null, 0, { declineLabel: 'STAY PUT', onDecline: () => G.log(`Omni-Man stays put in lane ${lane + 1}.`) });
      } else {
        const to = open[Math.floor(Game.rng() * open.length)];
        G.moveCard(self, lane, to);
      }
    },
    onKill(G, self) {
      // Roguelite Text+ ("Viltrumite Pride") — _omniManBlockOnKill scales the
      // per-kill block meter add. Default 1 (classic); Text+ 2.
      const gain = self._omniManBlockOnKill || 1;
      G.addBlockMeter(self.owner, gain);
      G.log(`Omni-Man adds ${gain} Block Meter!`);
    }
  },
  "Silver Surfer": {
    onPlay(G, self, lane) {
      // Roguelite Text+ overrides — _surferDebuff scales the ATK strip
      // (default 3 / Text+ 4); _surferTargets sets how many enemies get hit
      // (default 1 / Text+ 2). _surferCostBump (default 1 / Text+ 2) is read
      // in game.js's enemyCostIncrease site.
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
    onAllyKilled(G, self, dead) {
      if (self.currentHealth <= 0) return;
      // HIS OWN FALLEN, NOT THE TEAM'S. A 2v2 side is a team of two; counting
      // the teammate's losses would grow Mace at twice his printed rate.
      // _2v2SameSeat is always true in 1v1.
      if (dead && G._2v2SameSeat && !G._2v2SameSeat(self, dead)) return;
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
      // A HORSEMAN ARRIVES FIRST — pulled from the shared summon deck, so the
      // body is a real 1-cost card with its own abilities. Same exclusions as
      // Bat Signal / Mother Box (no discard-effect cards, no 0-ATK bodies).
      const horseman = G.drawFromSummonDeck(c =>
        !c.isDiscardEffect && (c.cost || 0) === 1 && (c.attack || 0) > 0);
      if (horseman) {
        G.summonCardChoice(self.owner, horseman.name, horseman.cost, horseman.attack,
                           horseman.health, horseman.abilities || [], null, null, horseman);
        G.log(`Apocalypse raises ${horseman.name}!`);
      }
      const KEYWORDS = ["Armor 1", "Evade 1", "Bullseye", "Overdrive"];
      // WHOSE hand? In 2v2 a team holds two separate hands, so the caster
      // chooses one — buffing BOTH would be a much stronger card than printed.
      // seatKey is null outside 2v2 online, where the side proxy IS your hand.
      const empower = (seatKey) => {
        const tt = G.state && G.state.twoVTwo;
        const holder = (seatKey && tt && tt.players[seatKey]) ? tt.players[seatKey] : G.state[self.owner];
        const whose = (seatKey && tt && tt.players[seatKey]) ? `${tt.players[seatKey].name || seatKey}'s` : 'your';
        // 10-cost titans don't get handouts — same exemption logic as
        // auto-Untrickable, so Doomsday (skipAutoUntrickable) still
        // qualifies despite his 12 starting cost.
        (holder.hand || []).filter(card =>
          // A combat keyword only means something on a card that fights.
          // cardHasBody is the whole rule (environments and bodiless cards like
          // Jigsaw / Brainiac / Prof X excluded) — the same predicate the
          // renderer uses to decide whether a card shows stats. Filtering here
          // also keeps phantom entries out of card.abilities and the log.
          G.cardHasBody(card) &&
          (card.skipAutoUntrickable || (card.baseCost || card.cost || 0) < 10)
        ).forEach(card => {
          const kw = KEYWORDS[Math.floor(Game.rng() * KEYWORDS.length)];
          if (!card.abilities.includes(kw)) card.abilities.push(kw);
          G.applyAbilities(card);
          G.log(`[APOCALYPSE] ${card.name} in ${whose} hand permanently gains ${kw}.`);
        });
        // Blue empower haze rolls over the empowered hand as it is charged.
        if (typeof UI !== 'undefined' && UI._fxHandHaze) { try { UI._fxHandHaze(self.owner, { color: '#4aa3ff' }); } catch (e) {} }
      };
      if (G._2v2ChooseAllySeat) {
        G._2v2ChooseAllySeat(self.owner, 'Apocalypse — Empower',
          'Choose whose hand gains the keywords', (seat) => empower(seat), self);
      } else {
        empower(null);
      }
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
      // Short-hand for per-ability SFX — silent in the headless sim (no UI) and
      // if no file is registered in CARD_SFX['Darth Vader'].abilities.
      // GUARDED: it runs first in each of Vader's three steps, and
      // _runHookBody would silently swallow a throw along with the rest of the
      // ability. A sound is never worth an ability.
      const absfx = (key) => {
        try { if (typeof UI !== 'undefined' && UI.sfx) UI.sfx.playCardAbility('Darth Vader', key); }
        catch (e) { console.error('[Darth Vader sfx]', e); }
      };
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
                if (typeof UI !== 'undefined' && UI._fxForcePull) { try { UI._fxForcePull(self, target); } catch (e) {} }
                G.moveCard(target, fromLane, toLane);
                G.log(`Darth Vader moves ${target.name} to lane ${toLane + 1}!`);
                afterMove();
              }, opp);
          } else {
            // AI-controlled: pick the lane where we'd most like the enemy
            // displaced — biggest disruption is moving them out of their
            // favorable trade or into a lane we can now chain into.
            const toLane = openLanes[0];
            if (typeof UI !== 'undefined' && UI._fxForcePull) { try { UI._fxForcePull(self, target); } catch (e) {} }
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
            if (typeof UI !== 'undefined' && UI.render) { try { UI.render(); } catch (e) {} }
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
      // Apply aura FIRST so the -1/-1 lands and 1-HP enemies die before the MC
      // prompt opens — otherwise dead cards get offered as MC targets.
      // Roguelite Text+ override — _lukeAuraSize scales the buff/debuff
      // magnitude. Default 1 (classic); Text+ 2.
      // Presence-based: Game.recomputeAuras reads living Lukes off the board
      // and reconciles every card's recorded aura — no stamp flags to unwind.
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
    // Start of Tricks, EVERY round — the card text says so, and
    // beforeTricksFired is only cleared in postCombat for cards carrying
    // this flag. Without it the hook fires once, in the round the card
    // lands, and never again.
    _recurringBT: true,
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      // The player picks where the freeze lands; the AI picks the
      // highest-threat unfrozen enemy.
      // Roguelite Text+ override — _thorThunderDamage scales the lane-adjacent
      // strike. Default 5 (classic); Text+ 7.
      const thunderDmg = self._thorThunderDamage || 5;
      // ONCE, whoever calls it. The burst is 15 damage across three lanes; a
      // second call from a future refactor would be a silent doubling.
      let _thorBurstDone = false;
      const splashBurst = () => {
        if (_thorBurstDone) return;
        _thorBurstDone = true;
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
      // THE THUNDER IS NOT PART OF THE FREEZE. The card prints two independent
      // effects: the damage doesn't read the freeze target. A prompt can go
      // unanswered (stall recovery clears pending prompts in
      // _forceEndStalledCombat; a 2v2 prompt raised for the wrong seat), so
      // the burst fires here, unconditionally, once — a dropped prompt loses
      // one Freeze 1, not 15 damage.
      // BEFORE the freeze, deliberately: the player picks a freeze target after
      // seeing what the thunder killed. Freeze is Unresistible either way.
      splashBurst();
      const unfrozen = G.getEnemiesOf(self.owner).filter(e => !e.isFrozen && e.currentHealth > 0);
      if (unfrozen.length) {
        G.promptCardChoice(self.owner, unfrozen, "Thor — Freeze", "Choose an enemy to Freeze 1", (t) => {
          if (!t || t.currentHealth <= 0) return;   // the thunder may have taken it
          G.freezeCardUnresistible(t, self);
          G.log(`Thor's lightning freezes ${t.name}!`);
        }, cards => cards.slice().sort((a, b) => AI.threatScore(b) - AI.threatScore(a))[0]);
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
    // Revan: cost 7 (6/8) — "Give another ally card Revive 1." A defensive
    // enabler: lets a chosen ally come back once if it dies.
    onPlay(G, self, lane) {
      // Revive grant is capped to allies of cost <= 9 — 10-cost titans can't
      // be handed a revive.
      const allies = G.getAlliesOf(self.owner).filter(a => a.id !== self.id && a.currentHealth > 0 && (a.baseCost || a.cost || 0) <= 9);
      const grant = (a) => {
        // Stack with any existing Revive charges. Cards born with
        // Revive (Jason, Mahoraga, Wolverine) already have
        // reviveCharges set in applyAbilities; we add 1 more.
        a.reviveCharges = (a.reviveCharges || 0) + 1;
        // WHO GAVE IT. The revive line fires whole combats later, long after
        // this one has scrolled away — see the note on _reviveSourceLabel.
        a._reviveFrom = 'Revan';
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
    // THE UNFORGIVABLE CURSES. Each curse is strong enough to be a whole
    // turn's play; spending each only once is what keeps him from being three
    // cards at once.
    // Every curse routes through the engine's existing door — killCard,
    // debuffCard, mindControlCard — so it inherits the rules that govern it:
    // Invincible refuses the kill, Immunity refuses Crucio and Imperio unless
    // the caster is Unresistible, Juggernaut shrugs the mind control, and the
    // end-of-round sweep releases Imperio like any Mind Control.
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
    // so it targets the board as it stands after earlier lanes resolved.
    onLaneCombat(G, self, lane) {
      if (self.currentHealth <= 0) return;
      // A silenced Dark Lord casts nothing — same lock every other
      // pre-combat caster honours.
      if (Game.isActionLocked(self)) {
        G.log(`  [SKIP] ${self.name} is ${G.actionLockLabel(self)} — no curse this round.`);
        return;
      }
      const defs = CARD_ABILITIES['Voldemort'];
      // ONCE EACH, EVER: at most three casts per game, so every choice spends
      // a curse permanently. Stored per instance, so two Voldemorts have their
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
            // allowKill TRUE: the (-4/-4) finishes a card with ≤4 HP outright
            // instead of flooring it at 1 — same allowKill path Pym Particles
            // uses. No Stun rider, so Imperio keeps a role of its own.
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
    // Parlay: right before every combat while he's active, Jack picks ONE
    // uncontested enemy lane — that enemy sits the round out.
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
        // Stamp the negotiator. A parlay is an ARRANGEMENT WITH JACK, so it has
        // to end when he does — and with two Jacks possible on a board, clearing
        // "any parlay" on one death would cancel the other one's too.
        target._parlayedBy = self.id;
        if (typeof UI !== 'undefined' && UI._fxParlay) { try { UI._fxParlay(target); } catch (e) {} }
        G.log(`[JACK SPARROW] Parlay! ${target.name} in lane ${i + 1} cannot attack this round.`);
      };
      if (Game.isHuman(self.owner)) {
        // NAME THE SEAT. This fires from resolveCombat's before-combat pass,
        // when NO 2v2 seat is taking a turn, so the acting-seat global is
        // unreliable and the fallback ("first human on that team") would hand
        // the decision to the teammate. A combat-time prompt must carry its own
        // owner (same as Symbiote Spider-Man and Human Torch).
        const _seat = self._2v2PlayedBy || self._mcSeat || null;
        G.promptLaneChoice(self.owner, lanes,
          'Jack Sparrow — Parlay',
          'Choose an enemy in an uncontested lane — they cannot attack this combat.',
          parley, opp, null, 0, _seat ? { seat: _seat } : undefined);
      } else {
        // AI: silence the biggest uncontested threat.
        lanes.sort((a, b) => {
          const ea = G.state.lanes[a][opp], eb = G.state.lanes[b][opp];
          const score = (c) => (typeof AI !== 'undefined' && AI.threatScore) ? AI.threatScore(c) : (c.attack * c.currentHealth);
          return score(eb) - score(ea);
        });
        parley(lanes[0]);
      }
    },
    // THE DEAL DIES WITH HIM. The flag he stamped earlier in the round would
    // otherwise outlive him until next round start (game.js, "Clear Parlay").
    // Only HIS parlays are lifted, by id, so a second Jack keeps his own.
    // Returns nothing: a truthy onDeath means "this death was PREVENTED".
    onDeath(G, self) {
      G.getAllCardsOnBoard().forEach(c => {
        if (c && c._parlayedBy === self.id) {
          delete c._parlayedThisRound;
          delete c._parlayedBy;
          G.log(`  [PARLAY] ${self.name} is gone — ${c.name} is released from the deal.`);
        }
      });
    }
  },
  "Han Solo": {
    onPlay(G, self) {
      // First Strike — Han takes his shot at the very START of combat, before
      // the lane-by-lane exchange, whatever lane he's in. Read by
      // Game._resolveFirstStrikes().
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
      // directly. Flag that lane so the board labels it "STRIKE HERO" instead
      // of drawing a reticle on an empty lane.
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
        // THE BOT SCORES THE SHOT, AND IT SCORES STAYING TOO.
        //   1. His own lane is a candidate: a redirect sets _skipNormalAttack,
        //      so the enemy opposite him is not hit by anyone this combat — the
        //      shot is moved, not added.
        //   2. A first strike only earns anything when it KILLS (a corpse
        //      doesn't swing back), so score kill-first, then by
        //      AI.threatScore (which sees armor / evade / invincibility /
        //      strategic value). Raw atk*hp would prefer an unkillable wall.
        // Ties keep the lowest lane so the choice stays deterministic.
        const score = (i) => {
          const e = G.state.lanes[i][opp];
          if (!e || e.currentHealth <= 0) {
            // An uncontested own lane is a free hit on the enemy HERO. Worth
            // taking when nothing on the board is worth killing, and worth less
            // than any kill — a dead attacker is damage prevented every round,
            // the hero hit is damage dealt once.
            return (i === lane) ? 1 : -1;
          }
          const threat = (typeof AI !== 'undefined' && AI.threatScore)
            ? AI.threatScore(e) : (e.attack || 0) * (e.currentHealth || 0);
          const kills = (typeof AI !== 'undefined' && AI.wouldKill)
            ? AI.wouldKill(self, e)
            : Math.max(0, (self.attack || 0) - (e.armorValue || 0)) >= e.currentHealth;
          // A kill is worth more than any amount of chip, whatever the numbers
          // underneath say — hence the offset rather than a multiplier.
          return (kills ? 1000 : 0) + threat;
        };
        let best = lane, bestScore = score(lane);
        for (const i of redirectLanes) {
          const sc = score(i);
          if (sc > bestScore) { best = i; bestScore = sc; }
        }
        if (best !== lane) {
          self._hanRedirectLane = best;
          G.log(`[HAN SOLO] Lining up a shot into lane ${best + 1}!`);
        } else {
          G.log(`[HAN SOLO] Han Solo stays and fights his own lane.`);
        }
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
    // His gifts are re-chosen every Trick phase (the hook clears the prior
    // mark first) and the Invincible he hands out lasts "this turn" — both
    // only make sense if it recurs.
    _recurringBT: true,
    passive: 'yodaShield',
    onPlay(G, self, lane) {
      // Activate the half-damage shield passive on entry. Yoda's active gift
      // is Master's Apprentice, handed out each Trick phase.
      // NOTHING TO STAMP. The shield is derived from the board by
      // Game.yodaShieldCount — `passive: 'yodaShield'` IS the source of truth,
      // so exits that skip onDeath (killCardSilent, devour, bounce, Moder
      // strip) can't leave it stuck on.
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
      // Clear only THIS Yoda's own prior apprentice, keyed by his id, so two
      // Yodas each keep their own gift. _mastersApprenticeBy is a plain id-map
      // so it survives the 2v2 state serialize; _mastersApprentice stays as the
      // derived boolean every combat path reads.
      G.getAllCardsOf(self.owner).forEach(a => {
        if (a._mastersApprenticeBy) {
          delete a._mastersApprenticeBy[self.id];
          a._mastersApprentice = Object.keys(a._mastersApprenticeBy).length > 0;
        }
      });
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
        a._mastersApprenticeBy = a._mastersApprenticeBy || {};
        a._mastersApprenticeBy[self.id] = true;
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
      // Only THIS Yoda's apprentice loses the gift when he falls — a second
      // Yoda still standing keeps teaching his own. Same id-keyed map as
      // onBeforeTricks so one master's death can't cancel the other's lesson.
      G.getAllCardsOf(self.owner).forEach(a => {
        if (a._mastersApprenticeBy) {
          delete a._mastersApprenticeBy[self.id];
          a._mastersApprentice = Object.keys(a._mastersApprenticeBy).length > 0;
        }
      });
    }
  },
  "Darth Maul": {
    // onPlay draws a Trick at -1 cost; passive grants +2/+0 each time a Trick
    // is played by EITHER player, via the global onAnyTrickPlayed hook
    // (game.js dispatches it from playTrick).
    onPlay(G, self, lane) {
      if (typeof UI !== 'undefined' && UI._fxMaulSaber) { try { UI._fxMaulSaber(self); } catch (e) {} }
      // Draw from THIS owner's trick pile via getTrickPile(owner) —
      // state.trickDrawPile is empty in Deckbuilder mode (the real pile is
      // per-player there).
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
    onAnyTrickPlayed(G, self, owner, trick, trickSeat) {
      if (self.currentHealth <= 0) return;
      if (owner !== self.owner) return;
      // 2v2: ONLY the seat that played Maul fuels him — not a teammate sharing
      // the side. In 1v1 the side check above is the whole rule.
      if (G.is2v2 && G.is2v2() && self._2v2PlayedBy) {
        const seat = trickSeat || G._2v2CurrentActingPlayer || (G._2v2ActivePlayer && G._2v2ActivePlayer());
        if (seat && seat !== self._2v2PlayedBy) return;
      }
      G.buffCard(self, 2, 0);
      G.log(`Darth Maul fuels his rage with ${trick.name} — +2/+0! (now ${self.attack}/${self.currentHealth})`);
    }
  },
  // ===== SUNG JIN-WOO and his shadows =====
  // The rules for all three live in the ENGINE, read off these flags:
  //   scalesWithEnergy — Game.isEnergyScaled / getCardCost / _lockEnergyScaled
  //   commandsShadows / isShadow — Game.reconcileShadows
  // This file holds only what each card DOES when it lands.
  "Sung Jin-Woo": {
    scalesWithEnergy: true,
    commandsShadows: true,
    // Revive odds, by the revived card's printed cost.
    reviveChance(cost) { const c = cost | 0; return c <= 6 ? 1 : (c <= 8 ? 2 / 3 : 1 / 3); },
    onPlay(G, self, lane) {
      const owner = self.owner;
      if (typeof UI !== 'undefined' && UI._fxSungArise) { try { UI._fxSungArise(self, self.attack); } catch (e) {} }
      const here = (lane != null && lane >= 0) ? lane : G.findCardLane(self);
      // 1. ARISE — Igris first, then Beru, each into a lane the PLAYER picks.
      //    Chained through onComplete so Beru's prompt only opens once Igris
      //    stands, and the revive only once both do. Lanes are ordered
      //    nearest-first, so every path that does NOT choose (AI, timeout,
      //    one open lane) takes the nearest.
      const nearest = () => G.getOpenLanes(owner)
        .sort((a, b) => (Math.abs(a - here) - Math.abs(b - here)) || (a - b));
      // summonCardChoice does not hand back the card it placed, so bind the
      // new arrival by name: the one shadow of that name on our side that has
      // no master yet. (reconcileShadows may already have adopted it to us —
      // that is the same answer.)
      const bind = (name) => {
        for (let i = 0; i < G.LANE_COUNT; i++) {
          const c = G.state.lanes[i] && G.state.lanes[i][owner];
          if (c && c.name === name && (c._shadowOf == null || c._shadowOf === self.id) && !c._isToken) {
            c._shadowOf = self.id;
            // A shadow is not a deck card: it never enters the dead pile, so
            // nothing can raise it apart from its master.
            c._isToken = true;
            return;
          }
        }
      };
      const raise = (name, next) => {
        const d = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS.find(x => x.name === name) : null;
        const open = nearest();
        if (!d || !open.length) {
          if (d) G.log(`  [SUNG JIN-WOO] No empty lane for ${name}.`);
          next();
          return;
        }
        G.summonCardChoice(owner, d.name, d.cost, d.attack, d.health, d.abilities || [], open,
          () => {
            bind(name); G.reconcileShadows();
            // The shadow climbs out of the ground — find the one just bound.
            try {
              for (let i = 0; i < G.LANE_COUNT; i++) {
                const c = G.state.lanes[i] && G.state.lanes[i][owner];
                if (c && c.name === name) { if (typeof UI !== 'undefined' && UI._fxShadowRise) { try { UI._fxShadowRise(c); } catch (e) {} } break; }
              }
            } catch (e) {}
            next();
          }, d);
      };
      raise('Igris', () => raise('Beru', () => revive()));
      // (called once Igris and Beru are both placed)
      function revive() {
        // 2. THE REVIVE. A chosen card from your own dead pile, at the owner's
        //    odds by its cost. A miss leaves it where it lay.
        const pile = (G.state[owner].deadPile || []).filter(e => e && e.name
          && typeof CARD_DEFS !== 'undefined' && CARD_DEFS.some(d => d.name === e.name)
          && !(CARD_ABILITIES[e.name] && CARD_ABILITIES[e.name].isShadow));
        if (!pile.length) { G.log('  [SUNG JIN-WOO] The dead pile is empty — nothing to raise.'); return; }
        if (!G.getOpenLanes(owner).length) { G.log('  [SUNG JIN-WOO] No empty lane — nothing can be raised.'); return; }
        const chance = (e) => CARD_ABILITIES['Sung Jin-Woo'].reviveChance(e.cost);
        G.promptCardChoice(owner, pile, 'Sung Jin-Woo — Arise',
          'Choose a card to revive. Cost ≤ 6: always. 7–8: 66%. 9 or more: 33%.',
          (picked) => {
            if (!picked) return;
            const p = chance(picked);
            const roll = G.rng();
            const pct = Math.round(p * 100);
            if (roll >= p) {
              G.log(`  [ARISE] ${picked.name} does not answer (${pct}% chance) — it stays in the dead pile.`);
              if (typeof UI !== 'undefined' && UI.showAITrickToast) { try { UI.showAITrickToast('Arise', `${picked.name} did not rise (${pct}% chance).`, 'info'); } catch (e) {} }
              return;
            }
            const dp = G.state[owner].deadPile || [];
            const idx = dp.indexOf(picked);
            if (idx > -1) dp.splice(idx, 1);
            const def = CARD_DEFS.find(d => d.name === picked.name) || picked;
            G.log(`  [ARISE] ${picked.name} rises${p < 1 ? ` (${pct}% chance)` : ''}!`);
            if (typeof UI !== 'undefined' && UI.sfx && UI.sfx.playEffectSfx) { try { UI.sfx.playEffectSfx('Revive', self); } catch (e) {} }
            G.summonCardChoice(owner, def.name, def.cost, def.attack, def.health, def.abilities || [], null, () => {
              // The revived card climbs out as a shadow.
              try {
                for (let i = 0; i < G.LANE_COUNT; i++) {
                  const c = G.state.lanes[i] && G.state.lanes[i][owner];
                  if (c && c.name === def.name) { if (typeof UI !== 'undefined' && UI._fxShadowRise) { try { UI._fxShadowRise(c); } catch (e) {} } break; }
                }
              } catch (e) {}
            }, def);
          },
          // AI: the most cost it can EXPECT to get back.
          cards => cards.slice().sort((a, b) =>
            ((b.cost | 0) * chance(b)) - ((a.cost | 0) * chance(a)))[0],
          { forcePrompt: true });
      }
    },
  },
  "Beru": {
    isShadow: true,
    shadowAtkOffset: 3,
    onPlay(G, self) {
      if (typeof UI !== 'undefined' && UI._fxShadowRise) { try { UI._fxShadowRise(self); } catch (e) {} }
      const foes = G.getEnemiesOf(self.owner)
        .filter(e => e && e.currentHealth > 0 && !e.isFaceDown);
      if (!foes.length) { G.log('  [BERU] No enemy to freeze.'); return; }
      const top = Math.max(...foes.map(e => e.baseCost || e.cost || 0));
      const target = G.rngPick(foes.filter(e => (e.baseCost || e.cost || 0) === top));
      G.log(`  [BERU] Freezes the highest-cost enemy, ${target.name}.`);
      G.freezeCard(target, self, 1);
    },
  },
  "Igris": {
    isShadow: true,
    shadowAtkOffset: 4,
  },
  // Grievous's escort — a token with a CARD_ABILITIES entry; summonCard's
  // token branch merges hooks onto token defs, so any token can have one.
  //
  // `tokenDesc` — the text the SUMMONED body carries. Tokens normally ship an
  // empty desc so the badge row is not duplicated in prose, but "grows when it
  // comes back" is not a keyword the Revive 2 badge can say. It is a separate
  // key from `desc` on purpose: the merge copies this object onto the
  // SUMMON_TOKEN_DEFS entry, and a `desc` here would overwrite the codex
  // entry's own line (which also names who summons it).
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
    // THE MULTIPLIER LIVES HERE AND NOWHERE ELSE: both _cardEffectiveAtk (the
    // ATK orb) and _computeIncomingDamage (the damage dealt) read it, so the
    // shown and dealt numbers can't drift.
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
    // A duelist: Evade 1 and Overdrive on the body (keywords, so they carry
    // their own badges), a droid escort on arrival, and a trophy taken off
    // every kill and handed to someone else.
    onPlay(G, self, lane) {
      if (typeof UI !== 'undefined' && UI._fxGrievousSabers) { try { UI._fxGrievousSabers(self); } catch (e) {} }
      G.summonCardChoice(self.owner, 'Battle Droid', 2, 1, 1, ['Revive 2']);
    },
    // ANOTHER ALLY GETS THE TROPHY, NEVER HIM — a self-buff would double up
    // with Overdrive, which already pays him for killing. Environments are
    // excluded — a (+1/+1) on a card that never fights is a stat nobody reads.
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
      // Stores the start round (round + 1) and the inclusive end round
      // (round + lockTurns). Classic = 1 turn (start === end); "Dark Knight"
      // Text+ sets lockTurns = 2.
      const lockTurns = self._batmanLockTurns || 1;
      const start = (G.state.round || 0) + 1;
      const until = (G.state.round || 0) + lockTurns;
      G.state[opp].batmanBlocked = start;
      G.state[opp].batmanBlockedUntil = Math.max(G.state[opp].batmanBlockedUntil || 0, until);
      G.log(`Batman locks down the opponent's highest cost card for ${lockTurns} turn${lockTurns === 1 ? '' : 's'}!`);
      if (typeof UI !== 'undefined' && UI._fxBatmanLockdown) { try { UI._fxBatmanLockdown(self); } catch (e) {} }
      const enemies = G.getEnemiesOf(self.owner);
      if (!enemies.length) return;
      // Roguelite Text+ override — _batmanStrikeDamage scales each of the two
      // batarang strikes. Default 2 (classic); Text+ 3.
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
        // alive inside the void — throw survivors clear so none is stranded
        // untargetable but still swinging.
        G.evictVoidSurvivors(i);
        G.log(`Darkseid destroys lane ${i + 1}!`);
      };
      // Purge: ANY contested lane except Darkseid's own is eligible (no
      // parity gate), capped at 3 destructions. Roguelite Text+
      // ("Apokoliptan Legion") lifts the cap entirely.
      const purgeCap = self._darkseidAnyContested ? Infinity : 3;
      let purgedCount = 0;
      const pickLanes = () => {
        const eligible = [];
        for (let i = 0; i < Game.LANE_COUNT; i++) {
          if (i === lane) continue;
          const mineC = G.state.lanes[i][self.owner];
          const theirsC = G.state.lanes[i][opp];
          if (!mineC || !theirsC) continue;
          // An Invincible / Damage-Immune occupant PROTECTS its whole lane from
          // the purge — the option must not even exist. Matches devour:
          // destruction-class effects respect Invincibility outright.
          const laneProtected = [mineC, theirsC].some(c =>
            c && ((c.invincibleTurns || 0) > 0 || c.hasDamageImmunity));
          if (laneProtected) continue;
          eligible.push(i);
        }
        if (!eligible.length) { G.log(`Darkseid finds no purgeable contested lanes (Invincible cards protect their lanes).`); return; }
        if (!Game.isHuman(self.owner)) {
          // The AI loses its own card too, so only destroy favorable trades.
          // Score every eligible lane, destroy the BEST trades first up to the
          // cap: destroy when the trade is even or favorable, our body is a
          // Parademon/low-value token, or the enemy out-costs us by 2+.
          const scored = [];
          eligible.forEach(i => {
            const myCard = G.state.lanes[i][self.owner];
            const enemy = G.state.lanes[i][opp];
            if (!myCard || !enemy) return;
            const mine = AI.threatScore(myCard);
            const theirs = AI.threatScore(enemy);
            // (Invincible/immune lanes never reach here — excluded from
            // `eligible` above.)
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
          // AUTO-PICK CONTINUES THE PURGE — it does NOT stop at "Done". Each
          // lane is its own prompt (in 2v2 online, its own round-trip, 30s
          // timeout and stall watchdog), so when one goes unanswered the
          // fallback picks the best remaining TRADE (same scoring as the AI arm)
          // and the chain still delivers the full purge. A human who wants to
          // stop early still clicks Done; this only fires when nobody answered.
          const autoPick = (cs) => {
            const laneOpts = cs.filter(o => o && o._lane != null);
            if (!laneOpts.length) return cs[cs.length - 1]; // only Done left
            let best = laneOpts[0], bestScore = -Infinity;
            laneOpts.forEach(o => {
              const myCard = G.state.lanes[o._lane][self.owner];
              const enemy = G.state.lanes[o._lane][opp];
              const mine = (myCard && AI.threatScore) ? AI.threatScore(myCard) : 0;
              const theirs = (enemy && AI.threatScore) ? AI.threatScore(enemy) : 0;
              const score = theirs - mine;
              if (score > bestScore) { bestScore = score; best = o; }
            });
            return best;
          };
          G.promptCardChoice(self.owner, choices,
            "Darkseid — Purge", `Pick a contested lane to destroy${left}, or Done`,
            (choice) => {
              if (choice.name === "Done") return;
              destroyLane(choice._lane);
              purgedCount++;
              pickNext();
            }, autoPick);
        };
        pickNext();
      };
      // Purge step is wrapped in a function so it fires AFTER the Parademon
      // summon resolves.
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
          if (typeof UI !== 'undefined' && UI._fxSupermanStrike) { try { UI._fxSupermanStrike(self, target); } catch (e) {} }
          G.dealDamage(target, self.attack, self);
          G.log(`Superman bonus attacks ${target.name} for ${self.attack}!`);
        } else {
          if (typeof UI !== 'undefined' && UI._fxSupermanStrike) { try { UI._fxSupermanStrike(self, null, self.owner); } catch (e) {} }
          G.damagePlayer(opp, self.attack, self.isBullseye);
          G.log(`Superman bonus attacks health bar for ${self.attack}!`);
        }
      }
      // Freeze 2 enemies chosen by the player. Chains two promptCardChoice
      // calls: the first pick filters out of the pool for the second so the
      // same enemy can't be picked twice. AI picks the top two threat scores.
      // Roguelite Text+ override — _supermanBlast scales the heat-vision
      // damage. Default 5 (classic); Text+ 8.
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
        if (typeof UI !== 'undefined' && UI._fxSupermanFreezeBreath) { try { UI._fxSupermanFreezeBreath(self, t1); } catch (e) {} }
        G.freezeCardUnresistible(t1, self, freezeN);
        G.log(`Superman freezes ${t1.name} for ${freezeN}!`);
        const unfrozen2 = G.getEnemiesOf(self.owner).filter(e => !e.isFrozen);
        if (!unfrozen2.length) { doBlast(); return; }
        G.promptCardChoice(self.owner, unfrozen2, `Superman — Freeze (2 of 2)`, `Choose the second enemy to Freeze ${freezeN}`, (t2) => {
          if (typeof UI !== 'undefined' && UI._fxSupermanFreezeBreath) { try { UI._fxSupermanFreezeBreath(self, t2); } catch (e) {} }
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
      // HALF THE BOARD, WHATEVER THE BOARD IS: the count derives from
      // LANE_COUNT (3 of 6 in 1v1, 4 of 8 in 2v2), so any board size inherits
      // it. The roguelite rarity ladder is an OFFSET above half:
      //   classic       half + 0
      //   rogue special half + 1
      //   rogue legend  half + 2
      // Roguelite Text+ ("Reality Snap") still pins an absolute count.
      const halfBoard = Math.floor(G.LANE_COUNT / 2);
      const numRolls = self._thanosLanes
        ? self._thanosLanes
        : halfBoard + G.rarityValue(self, { common: 0, rare: 0, special: 1, legendary: 2 });
      const rolled = new Set();
      const erased = [];
      let killed = 0;
      if (typeof UI !== 'undefined' && UI._fxThanosSnap) { try { UI._fxThanosSnap(self); } catch (e) {} }
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
            // DEVOUR, not destroy: the snap erases from existence — void pile,
            // no dead pile, no When Destroyed, no revive. devourCard is the
            // canonical door, so the snap inherits its rules (Invincible refuses
            // it, Damage Immunity does not, kill credit still lands).
            // Named before the devour — the card is gone a statement later.
            const who = e.name;
            erased.push({ lane: r, name: who });
            G.devourCard(e, self); killed++; G.log(`Thanos snaps lane ${r + 1}: ${who} erased from existence!`);
          }
        }
      }
      G.log(`Thanos snaps! Lanes ${[...rolled].map(n => n + 1).sort().join(', ')} — ${killed} enemies erased!`);
      // Record the strike, same as Hollow Purple — the 2.6s lane flash is
      // gone long before the card is read.
      G.noteLaneStrike(self, 'Snap', [...rolled], erased);
      try { if (typeof UI !== 'undefined' && UI.sfx) UI.sfx.playCardSfx('Thanos', 'ability', self); } catch (e) {}
      // Flash the rolled lanes so the player can SEE which 3 lanes got hit
      // (some may have had no target).
      // GUARDED, like every presentation call in card code: a throw would abort
      // the hook, and anything added after it would silently never run.
      if (typeof UI !== 'undefined' && UI.flashLanes) {
        try { UI.flashLanes([...rolled], 'lane-thanos-snap', 2600); } catch (e) {}
      }
    }
  },

  // ==================== COST 10 ====================
  "Anakin Skywalker": {
    onPlay(G, self, lane) {
      // When Played: deal 10 damage to a chosen enemy. Pass {source:self} —
      // the engine's "tens can't target tens" rule drops other 10-cost titans
      // from the picker. (Draw 1 fires separately via the `Draw 1` keyword.)
      const enemies = G.getEnemiesOf(self.owner, { source: self }).filter(t => G.canEffectLand(t, 'damage', { owner: self.owner, source: self }));
      if (!enemies.length) return;
      G.promptCardChoice(self.owner, enemies, "Anakin — Strike",
        "Choose an enemy to deal 10 damage",
        (t) => { if (typeof UI !== 'undefined' && UI._fxSaberStrike) { try { UI._fxSaberStrike(self, t); } catch (e) {} } G.dealDamage(t, 10, self); G.log(`Anakin unleashes the dark side on ${t.name} for 10!`); },
        cards => _aiKillPicker(cards, 10));
    },
    onBeforeTricks(G, self, lane) {
      if (self.anakinMoved) return;           // fires exactly once per instance
      // See Man-Bat for why this asks isMoveLocked and not isActionLocked.
      if (Game.isMoveLocked(self)) {
        G.log(`  [SKIP] ${self.name} is ${Game.moveLockLabel(self)} — stays put.`);
        return;
      }
      // Roguelite Text+ ("Twin Strike") — _anakinDoubleMove lets Anakin move
      // TWICE per turn, queueing a bonus attack each time. Classic is single.
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
          // Anakin's current lane. The strike is decoupled from the move.
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
      // Roguelite Text+ override — _dormammuDrainMax raises the drain ceiling.
      // Default 3 (classic); Text+ 5.
      const drainCap = self._dormammuDrainMax || 3;
      const drainCount = Math.min(drainCap, enemies.length);
      const drainChain = (remaining, picked) => {
        // Guard on `remaining` only — `picked` is empty at the start, and
        // `available.length === 0` below handles "nothing left to drain".
        if (remaining <= 0) return;
        const available = enemies.filter(e => e.currentHealth > 0 && !picked.includes(e.id));
        if (!available.length) return;
        // ALWAYS prompt the human player, even for 1 target (same as
        // Galactus's devour) — the user always chooses.
        // AI picker: highest threat, not raw ATK — threatScore factors armor /
        // evade / invincibility / strategic value, and stealing from the
        // highest threat is the biggest swing.
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
      // Default 5 (classic); Text+ 10.
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
      // Pass {source: self} so 10-cost enemies are stripped from the devour
      // menu — tens can't target tens, so they must not even be offered.
      // Engine-level is10CostImmune still backs this up for other paths.
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
        // 'destroy', not 'damage': devour deals no damage, so the gate that
        // matters is the anti-DESTRUCTION one (Invincible). 'damage' would also
        // exclude damage-immune enemies, which devour can take.
        const available = enemies.filter(e => e.currentHealth > 0 && !picked.includes(e.id) && G.findCardLane(e) >= 0 && G.canEffectLand(e, 'destroy', { owner: self.owner, source: self }));
        if (!available.length) return;
        // AI picker: devour highest threat — threatScore captures strategic
        // impact (e.g. Captain America's shield) that raw cost misses.
        const threatPicker = (cards) => cards.slice().sort((a, b) =>
          (AI && AI.threatScore ? (AI.threatScore(b) - AI.threatScore(a))
                                : (b.cost || 0) - (a.cost || 0)))[0];
        if (Game.isHuman(self.owner)) {
          // Auto-resolve when the choice is forced: if every remaining
          // candidate will be devoured anyway (available <= remaining), the
          // pick can't change the outcome, so skip the modal (options.forced).
          // With more targets than devours, the choice is real and prompts.
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
      // Floor of 2 so the 10-cost lottery never pays out 1-cost chaff.
      // Roguelite Text+ override — _knullCostFloor raises the minimum cost of
      // the pull pool. Default 2 (classic); Text+ 4.
      const minCost = self._knullCostFloor || 2;
      // _knullCostCeiling raises the upper bound from 9 to 10 with Text+
      // ("God of Symbiotes") so the lottery can roll 10-cost titans.
      const maxCost = self._knullCostCeiling || 9;
      G._suppressSummonSfx = true;
      const _knullSummoned = [];
      // Marked: fills every open lane synchronously — see Game._withSummonLoop.
      G._withSummonLoop(() => G.getOpenLanes(self.owner).filter(l => l !== lane).forEach(l => {
        // RE-CHECK LIVE: the open-lane list is a snapshot, but a summoned card's
        // own On Play can claim lanes mid-loop (Hela raising Undead Warriors).
        // Check BEFORE drawing so we don't burn a summon-deck card on a lane we
        // can no longer fill — Knull summons that many fewer, by design.
        const ln = G.state.lanes[l];
        if (!ln || ln.destroyed || ln[self.owner]) return;
        // Pull from the shared summon deck. Filter: cost minCost-maxCost,
        // attack > 0, not a discard-effect card.
        const d = G.drawFromSummonDeck(c => !c.isDiscardEffect && c.cost >= minCost && c.cost <= maxCost && (c.attack || 0) > 0);
        if (d) {
          G.summonCard(self.owner, l, d.name, d.cost, d.attack, d.health, d.abilities || [], d);
          const sc = G.state.lanes[l] && G.state.lanes[l][self.owner];
          if (sc) _knullSummoned.push(sc);
        }
      }));
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
      const enemyMeter = G.getBlockMeter(opp);
      const stolen = Math.floor(enemyMeter * stealPct);
      if (stolen > 0) {
        G.addBlockMeter(self.owner, stolen);
        G.setBlockMeter(opp, enemyMeter - stolen);
        G.log(`Trigon steals ${stolen} Block Meter!`);
      } else {
        G.log(`Trigon reaches for the Block Meter — empty!`);
      }
      if (fillSelfToMax) {
        G.setBlockMeter(self.owner, Game.BLOCK_MAX);
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
        // Mark the freeze as fired anyway so a re-summoned Trigon (Lazarus /
        // reanimation) doesn't snap-freeze the field. Once per instance.
        self.trigonFrozen = true;
        return;
      }
      self.trigonFrozen = true;
      if (typeof UI !== 'undefined' && UI._fxHellfire) { try { UI._fxHellfire(self, targets); } catch (e) {} }
      targets.forEach(e => G.freezeCardUnresistible(e, self));
      G.log(`Trigon freezes ${targets.length} enem${targets.length === 1 ? 'y' : 'ies'}!`);
    },
    onBeforeTricks(G, self, lane) {
      // Mass-freeze ALL enemies — Start of Tricks (once), in the same beat as
      // Galactus's devour and Anakin's move (runBeforeTricks at endPhase2).
      // The once-flag stops a re-summoned Trigon re-freezing every round.
      CARD_ABILITIES.Trigon._massFreezeOnce(G, self);
    },
    onKill(G, self) {
      // Passive: each kill triggers one bonus random kill. Re-entry guard
      // prevents the bonus kill from spawning another bonus kill.
      if (self._trigonChaining) return;
      // The titan test is canEffectLand's job (via is10CostImmune, which
      // honors skipAutoUntrickable). Don't add a hand-rolled `cost < 10` —
      // it would wrongly exclude Doomsday, who prints at 12 but is not a titan.
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
    // BOILER ROOM BURNS WITH THE SAME BURNING AS EVERYONE ELSE: it goes
    // through the shared applier at Burning 1, so one keyword means one rule.
    // Damage per turn is kept by the re-stoke in onTurnStart. It ticks before
    // the card's LANE fights rather than before that card ATTACKS, so a
    // burning card with no one to swing at still burns.
    _markBurning(card, boilerRoom) {
      if (!card || card.isEnvironment) return;
      // isBurning, the ignite one-shot FX and the decaying counter all live in
      // _ignite. Its first arg (G) is unused, hence null.
      CARD_ABILITIES['Godzilla']._ignite(null, card, 1);
      // _brDeathHooked is only a "this Boiler Room has already lit you" marker,
      // read by onAnyCardPlayed so a cleansed card is not silently re-lit. The
      // spawn lives in _watchBurningDeath.
      if (boilerRoom) card._brDeathHooked = true;
    },
    // ANY CARD THAT DIES BURNING, WHOEVER LIT IT (Godzilla, Knull, Freddy's
    // own passive...). The Boiler Room watches every death, from either side,
    // through the hooks the engine already broadcasts — so a future burn
    // source inherits this without knowing the Boiler Room exists.
    // Death-PREVENTION is respected: these hooks fire only after handleDeath
    // ran the dying card's own onDeath and it didn't cancel, so a card that
    // revives cannot also raise Freddy.
    _watchBurningDeath(G, self, dead) {
      if (!dead || !dead.isBurning) return;
      if (self._brSpawned || self.currentHealth <= 0) return;
      const brLane = G.findCardLane(self);
      if (brLane < 0) return;
      self._brSpawned = true;
      G.log(`[BOILER ROOM] ${dead.name} burns to nothing — something stirs in the boiler room.`);
      CARD_ABILITIES['Boiler Room']._spawnFreddy(G, self.owner, brLane);
    },
    onAllyKilled(G, self, dead)  { CARD_ABILITIES['Boiler Room']._watchBurningDeath(G, self, dead); },
    onEnemyKilled(G, self, dead) { CARD_ABILITIES['Boiler Room']._watchBurningDeath(G, self, dead); },
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
          setTimeout(() => { try { UI._freddyJumpscare(laneIdx, owner); } catch (e) {} }, 60);
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
              // the prompt opened, but the effect that spawned Freddy can still
              // be killing things meanwhile (e.g. Soul Stone) — without this
              // the callback would place a corpse back on the board.
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

      // RE-STOKE. Boiler Room never re-marks a card it already lit (the spread
      // pass and onAnyCardPlayed both skip those), so a decaying counter would
      // tick once and go out. Re-stoking every burning enemy back to 1 each
      // turn keeps the damage at 1 per turn. _ignite takes the HIGHER number,
      // so a Godzilla's Burning 3 in this lane is not dragged down to 1.
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
    // The number IS the damage: Burning 3 deals 3 → Burning 2 deals 2 →
    // Burning 1 deals 1 and goes out.
    // TIMING: it ticks on onLaneCombat, so a card burns immediately BEFORE ITS
    // OWN LANE fights — not at the top of the phase (same hook and reasoning as
    // Voldemort). onBeforeAttack is NOT an option: it only fires for cards that
    // actually swing, so a burning card with no target would never tick.
    BURN_START: 3,
    // THE SHARED BURNING APPLIER. It lives under Godzilla (the first source)
    // but every card that sets a card alight goes through here, so Burning
    // means exactly one thing no matter who lit it.
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
      if (G.yodaShieldCount(opp) > 0) dmg = G.yodaHalve(opp, dmg);
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
        setTimeout(() => { try { UI._freddyHandSlash(t.name, dmg, t.id, handIdx, opp, destroyed); } catch (e) {} }, 60);
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
          setTimeout(() => { try { UI._freddyHandSlash(t.name, 1, t.id, handIdx, opp, destroyed); } catch (e) {} }, 60);
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
      // seat's freshly-granted Energy directly.
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
      // Drain only — the opponent loses 1, Freddy's side gains NOTHING (like
      // Catwoman).
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
      // comes next: the _doomsdayRevived guard in tryApplyDebuff /
      // freezeCardUnresistible only refuses NEW Stun/Freeze, so counters from
      // before his death would ride through the revive.
      self.stunnedTurns = 0; self.isStunned = false;
      self.frozenTurns  = 0; self.isFrozen  = false;
      // NO TAUNT ON THE REVIVE: Taunt is his one-time arrival keyword, spent on
      // landing. The revive never re-arms it, and also wipes any leftover
      // tauntTurns from dying mid-Taunt.
      self.tauntTurns = 0; self.permanentTaunt = false;
      // He rises with IMMUNITY, the real keyword — the _doomsdayRevived guard
      // only covers Stun/Freeze, while Immunity blocks all debuffs, shows the
      // standard badge, and canEffectLand already honours it.
      self.immunityCharges = Math.max(self.immunityCharges || 0, 1);
      self.permanentImmunity = true;
      // UNTRICKABLE TOO. Immunity refuses status debuffs; Untrickable refuses
      // enemy TRICKS outright (Phantom Zone, Anti-Life). skipAutoUntrickable
      // stays set, so this is a flag he EARNS by rising, not one his cost hands
      // him.
      self.isUntrickable = true;
      // The printed "Taunt 1" keyword stays on the def and still arms when he
      // lands; it simply does not come back with him (see above).
      G.log(`[DOOMSDAY] Cannot be stopped — Doomsday rises with Immunity and Untrickable.`);
      if (typeof UI !== 'undefined' && UI._fxDoomsdayRise) { try { UI._fxDoomsdayRise(self); } catch (e) {} }
      return true; // prevent death
    }
  },
  "Padme Amidala": {
    onEndOfTurn(G, self) {
      if (typeof UI !== 'undefined' && UI._fxPadmeBlessing) { try { UI._fxPadmeBlessing(G.getAlliesOf(self.owner).filter(c => c !== self)); } catch (e) {} }
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
        // returns truthy to CANCEL the death. Dropping it would let the reviver
        // restore HP, die anyway AND spawn Jaws off a death that never happened.
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
      if (typeof UI !== 'undefined' && UI._fxJawsFeed) { try { UI._fxJawsFeed(self); } catch (e) {} }
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
    // "Enters this lane" uses the SEWERS pattern: record who is standing
    // opposite when the room lands, then watch for a DIFFERENT card showing up.
    // Reusing that idiom keeps the rooms consistent with Sewers and Open Water
    // about what an arrival is.
    //
    // Rule: enemy cards that enter this lane take (−2/−2) and are chained,
    // losing (−1/−1) every turn they stay. No victim cap; the room runs the
    // standard environment clock (ENV_TURNS), which the lane's countdown pip
    // shows.
    onPlay(G, self, lane) {
      const opp = G.opponent(self.owner);
      const existing = G.state.lanes[lane][opp];
      // The ids this room chained, so it can release them when it leaves —
      // `_chained` is SHARED with Pinhead's hand-chain (told apart everywhere
      // else by _chainPartnerId, which only Pinhead sets), so clearing the flag
      // off anything else would break a card this room never touched.
      // Set BEFORE the chain below, which pushes into it.
      self._bathroomChained = [];
      // A ROOM THAT OPENS UNDER A CARD HAS THAT CARD — like Gargantua's black
      // hole, Boiler Room and Open Water, it takes the occupant on arrival, so
      // the placement roll doesn't decide whether the card works. (Sewers is
      // deliberately different — its trigger is a SPAWN, and "the first NEW
      // enemy to enter" is its printed rule.)
      if (existing && existing.currentHealth > 0 && !existing.isEnvironment) {
        self._bathroomTracked = existing.id;
        CARD_ABILITIES['The Bathroom']._chain(G, self, existing, lane);
      } else {
        self._bathroomTracked = null;
      }
    },
    _chain(G, self, victim, laneIdx) {
      if (!self._bathroomChained) self._bathroomChained = [];
      if (self._bathroomChained.indexOf(victim.id) === -1) self._bathroomChained.push(victim.id);
      // THE CHAIN ICON. A visible status, not just an invisible flag — the
      // player has to be able to see which cards the room owns.
      victim._chained = true;
      // (−2/−2) applied with the CANONICAL shield rule — the same
      // statStripShieldsHp predicate checkLaneTrap and debuffCard use, so
      // Invincible / Damage Immunity blocks the health loss while the ATK strip
      // still lands. Don't re-implement that rule here.
      const D = 2;
      const hpShielded = G.statStripShieldsHp(victim);
      victim.attack = Math.max(0, victim.attack - D);
      if (!hpShielded) {
        victim.maxHealth = Math.max(1, victim.maxHealth - D);
        victim.currentHealth = Math.max(0, victim.currentHealth - D);
      }
      if (typeof UI !== 'undefined' && UI._fxBathroomChain) { try { UI._fxBathroomChain(victim); } catch (e) {} }
      G.log(hpShielded
        ? `  [THE BATHROOM] ${victim.name} wakes up chained! −${D} ATK — health shielded → ${victim.attack}/${victim.currentHealth}`
        : `  [THE BATHROOM] ${victim.name} wakes up chained! −${D}/−${D} → ${victim.attack}/${victim.currentHealth}`);
      G.log(`  [THE BATHROOM] ${victim.name} is Chained — every round it stays costs another (−1/−1).`);
      // A chain that drops the victim to 0 is lethal — route through the
      // canonical death path so it cannot sit as a 0-HP zombie (same as
      // checkLaneTrap).
      if (victim.currentHealth <= 0) G.handleDeath(victim, laneIdx, null);
    },
    // STAYING COSTS: the clock runs while you are in there, and leaving is the
    // answer.
    onTurnStart(G, self) {
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;
      const opp = G.opponent(self.owner);
      const victim = G.state.lanes[laneIdx][opp];
      if (!victim || victim.currentHealth <= 0 || victim.isEnvironment) return;
      // Only a body THIS room chained — a card chained by Pinhead's hand-link,
      // or standing here before the room opened, is not the room's to drain.
      if ((self._bathroomChained || []).indexOf(victim.id) === -1) return;
      const D = 1;
      const hpShielded = G.statStripShieldsHp(victim);
      victim.attack = Math.max(0, victim.attack - D);
      if (!hpShielded) {
        victim.maxHealth = Math.max(1, victim.maxHealth - D);
        victim.currentHealth = Math.max(0, victim.currentHealth - D);
      }
      G.log(hpShielded
        ? `  [THE BATHROOM] The chains bite ${victim.name} — −${D} ATK, health shielded → ${victim.attack}/${victim.currentHealth}`
        : `  [THE BATHROOM] The chains bite ${victim.name} — −${D}/−${D} → ${victim.attack}/${victim.currentHealth}`);
      if (victim.currentHealth <= 0) G.handleDeath(victim, laneIdx, null);
    },
    // THE ROOM LETS GO WHEN IT LEAVES. Its own clock removes it (ENV_TURNS, the
    // same countdown the lane pip prints), and a status applied by a room that
    // is no longer there must not keep its badge — or keep reading as Pinhead's
    // chain to anything that checks `_chained` later.
    onDeath(G, self) {
      const held = self._bathroomChained || [];
      if (!held.length) return;
      G.getAllCardsOf(G.opponent(self.owner)).forEach(c => {
        // _chainPartnerId is Pinhead's and only Pinhead's — never release one
        // of his pairs on the way out.
        if (c && held.indexOf(c.id) !== -1 && c._chainPartnerId == null) c._chained = false;
      });
    },
    onAnyCardPlayed(G, self) {
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;
      const opp = G.opponent(self.owner);
      const enemy = G.state.lanes[laneIdx][opp];
      const enemyId = (enemy && enemy.currentHealth > 0) ? enemy.id : null;
      // ALREADY-CHAINED BODIES ARE NOT NEW ARRIVALS. Without this the victim
      // standing in the lane reads as an unseen arrival on EVERY card played
      // and takes (−2/−2) again, and again. Two guards on purpose — `_chained`
      // also covers a body chained by some other source.
      if (enemy && enemy._chained) { self._bathroomTracked = enemyId; return; }
      if (enemyId && enemyId !== self._bathroomTracked) {
        self._bathroomTracked = enemyId;
        CARD_ABILITIES['The Bathroom']._chain(G, self, enemy, laneIdx);
      } else {
        self._bathroomTracked = enemyId;
      }
    },
  },
  "Game Over": {
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
      const AB = CARD_ABILITIES['Game Over'];
      // ENEMY bodies only ("the 1st enemy card to die in this lane") — the room
      // must not raise one of your own dead.
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
      // ONE BODY, THEN THE ROOM IS SPENT — otherwise an infinite loop: _rise
      // summons into the lane, the summon broadcasts onAnyCardPlayed, that
      // re-hooks the raised body, and if it dies in the same cascade it rises
      // again forever (the full-match tests hang). Sewers and Open Water are
      // one-shot for the same reason. Set BEFORE the summon, so the broadcast
      // it triggers already sees a spent room.
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
      // summonCard would see the lane as occupied and bail (same as Sewers).
      if (lane[owner] && lane[owner].currentHealth <= 0) lane[owner] = null;

      // AN ALLY MOVES TO MAKE ROOM — the Sewers idiom, deliberately reused.
      // Sewers' handling of the pending-prompt window is copied too: the ally
      // can DIE while the lane choice is open (a death cascade keeps resolving
      // underneath it), so the callback re-checks before moving it.
      const _riser = dead;
      const _ally = lane[owner];
      if (_ally && _ally.currentHealth > 0) {
        const openLanes = G.getOpenLanes(owner).filter(l => l !== laneIdx);
        if (!openLanes.length) {
          // Nowhere to put them. Game Over has no absorb rule the way Sewers
          // feeds Pennywise the body, so the rise is simply refused — it does
          // NOT kill your own card to make space.
          G.log(`  [GAME OVER] ${_riser.name} twitches — lane ${laneIdx + 1} is taken and there is nowhere to move ${_ally.name}.`);
          return;
        }
        G.promptLaneChoice(owner, openLanes,
          `Game Over — Move ${_ally.name}`,
          `${_riser.name} is getting up in lane ${laneIdx + 1}. Move ${_ally.name} to another lane.`,
          (targetLane) => {
            if (_ally.currentHealth <= 0) {
              if (lane[owner] === _ally) lane[owner] = null;
              CARD_ABILITIES['Game Over']._finishRise(G, self, _riser, laneIdx);
              return;
            }
            lane[owner] = null;
            G.state.lanes[targetLane][owner] = _ally;
            G.log(`  [DISPLACED] ${_ally.name} moved to lane ${targetLane + 1} to make room for ${_riser.name}.`);
            G.checkLaneTrap(_ally, targetLane);
            if (_ally.onMoved) _ally.onMoved(G, _ally, targetLane);
            CARD_ABILITIES['Game Over']._finishRise(G, self, _riser, laneIdx);
          },
          // ASK THE PERSON WHOSE ROOM IT IS. Without a seat, the derivation
          // via _2v2AbilityOwner names the seat of the card that just DIED (an
          // opponent), gets rejected by the cross-team guard, and falls to the
          // "lowest-numbered human on the team" — possibly the wrong teammate.
          // _2v2SeatOwning reads the room's stamp and re-checks it against the
          // side the card is on now.
          null, null, null,
          { forced: openLanes.length <= 1, seat: (G._2v2SeatOwning && G._2v2SeatOwning(self)) || null }
        );
        return;
      }
      CARD_ABILITIES['Game Over']._finishRise(G, self, dead, laneIdx);
    },
    // The summon itself, split out so both paths — an empty lane, and a lane
    // an ally has just vacated — land on exactly one body of code.
    _finishRise(G, self, dead, laneIdx) {
      const owner = self.owner;
      const lane = G.state.lanes[laneIdx];
      if (lane[owner] && lane[owner].currentHealth <= 0) lane[owner] = null;
      if (lane[owner]) {
        G.log(`  [GAME OVER] ${dead.name} twitches — but lane ${laneIdx + 1} is already taken.`);
        return;
      }
      const realDef = (typeof CARD_DEFS !== 'undefined')
        ? CARD_DEFS.find(d => d.name === dead.name) : null;
      // Summon from a def COPY carrying the (2/2), rather than stamping stats
      // after the summon — the death cascade re-derives stats from the def and
      // would revert a stamp. Spread, never JSON: a JSON clone of a def strips
      // its ability hooks.
      const def = realDef ? Object.assign({}, realDef, { attack: 2, health: 2 }) : null;
      const before = lane[owner];
      G.summonCard(owner, laneIdx, dead.name, dead.cost || 0, 2, 2, [], def);
      const risen = G.state.lanes[laneIdx][owner];
      if (!risen || risen === before) {
        G.log(`  [GAME OVER] ${dead.name} does not get up.`);
        return;
      }
      // NOTE: no post-summon stat stamp — it would run BEFORE summonCard's
      // arrival step drains, so it couldn't hold anyway. The body may
      // legitimately exceed the def stats (Lone Wolf's +1/+1 to a lone summon).
      // The room is used up — clear the sub-slot so the board shows it is done,
      // the way Sewers hands its lane over to Pennywise.
      if (lane._env && lane._env[owner] === self) lane._env[owner] = null;
      G.log(`[GAME OVER] ${dead.name} gets up in lane ${laneIdx + 1} — a (2/2) on ${G.seatPossessive(owner)} side, played anew. The room is spent.`);
      if (typeof UI !== 'undefined' && UI.emitFX) { try { G.emitFX('envReveal', { lane: laneIdx, owner, name: 'Game Over' }); } catch (e) {} }
    },
    onPlay(G, self) { CARD_ABILITIES['Game Over']._hookOccupants(G, self); },
    onAnyCardPlayed(G, self) { CARD_ABILITIES['Game Over']._hookOccupants(G, self); },
    onTurnStart(G, self) { CARD_ABILITIES['Game Over']._hookOccupants(G, self); },
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
        // lane and bail.
        if (lane[owner] && lane[owner].currentHealth <= 0) lane[owner] = null;
        const before = G.state.lanes[laneIdx][owner];
        G.summonCard(owner, laneIdx, 'Pennywise', 4, atk, hp, [], def);
        const pennywise = G.state.lanes[laneIdx][owner];
        // Only stamp stats if the summon actually placed a NEW Pennywise. When
        // summonCard bails on an occupied lane the slot still holds the old
        // card, and writing here would hand IT Pennywise's stats.
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
          setTimeout(() => { try { UI._pennywiseJumpscare(laneIdx, owner); } catch (e) {} }, 60);
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
          // handleDeath does NOT reliably clear the lane: if another death is
          // already resolving (THE STACK gate, _stackResolving) it only QUEUES
          // this one — and Sewers fires from onAnyCardPlayed, often mid-death.
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
      // A ROOM THAT OPENS UNDER AN ENEMY HAS ITS FIRST ENEMY — like every
      // other environment, it takes the occupant on arrival so the placement
      // roll doesn't decide whether the card does anything.
      // TRIGGERED IS LATCHED BEFORE THE SPAWN, not after — _spawnPennywise
      // summons, the summon broadcasts onAnyCardPlayed, and that re-enters this
      // card's own onAnyCardPlayed (an infinite loop otherwise; see Game Over).
      if (existing && existing.currentHealth > 0 && !existing.isEnvironment) {
        self._sewersTrackedEnemy = existing.id;
        self._sewersTriggered = true;
        CARD_ABILITIES['Sewers']._spawnPennywise(G, self.owner, lane);
        return;
      }
      // Record current enemy so onAnyCardPlayed only fires on a NEW arrival
      self._sewersTrackedEnemy = null;
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
  // The third habitat environment. Like every environment it runs on the
  // shared four-round clock and is replaced by what it births.
  //
  // Its clock is the BLOCK METER, not a card entering or dying: every time
  // either side's meter fills and eats a hit, the swamp loses 1 Power. Starting
  // Power is 1, so a single block — from anyone — and the water breaks.
  // ============================================================
  // ---- T-REX ------------------------------------------------
  // ============================================================
  // ============================================================
  // ---- THE ENCLOSURE ----------------------------------------
  // ============================================================
  // The only habitat with a PRICE rather than a trigger, and the only one whose
  // monster is not a reward: the other habitats hand their monster to the
  // owner; the gate opens the moment you stop paying, and what gets out is
  // pointed at YOU. So `into` is the opponent: the paddock is the gate
  // owner's, the T-Rex is their problem.
  //
  // It rides the SAME upkeep queue as Gargantua (state._pendingUpkeep, drained
  // by _resolveUpkeepPrompts before phase 1), which is what makes "pay 1 Energy
  // or skip" a real prompt in every mode instead of a second private one.
  "Enclosure": {
    // ONE CLOCK, NOT TWO. The paddock runs down on the SHARED environment
    // clock (Game.ENV_TURNS, ticked in postCombat) — without a lifetime the
    // AI would pay forever and the gate would never leave; a private toll
    // counter would drift from the lane's pip.
    // Refusing still lets the T-Rex out at any point in those rounds.
    onTurnStart(G, self) {
      if (self._encReleased) return;
      if (G.findCardLane(self) < 0) return;
      // Last round on the clock — the tick at the end of THIS round takes the
      // paddock away, so this is the final toll it will ever ask for.
      const lastToll = (self._envTurns | 0) <= 1;
      if (!G.state._pendingUpkeep) G.state._pendingUpkeep = [];
      G.state._pendingUpkeep.push({
        card: self, owner: self.owner, label: 'Enclosure',
        // Its own labels — the resolver's defaults are Gargantua's.
        payLabel: 'Pay the Park',
        payDesc: lastToll
          ? 'The last toll — the park closes at the end of this round.'
          : 'The gate holds for another round — nothing gets out.',
        skipLabel: 'Refuse',
        skipDesc: 'The gate opens and the T-Rex is released AGAINST you.',
        promptDesc: lastToll
          ? 'The final toll. Pay 1 Energy and the park closes for good, or refuse and let the T-Rex out against you.'
          : 'Pay 1 Energy to keep the gate shut, or refuse and let the T-Rex out against you.',
        // NO aiPrefer: the resolver's default (pay while affordable) is right
        // for a toll. Energy refills at the top of the round (game.js,
        // `state[o].currency = cur`) BEFORE upkeep runs, so a bot always pays —
        // the gate only opens when a HUMAN refuses or a side is broke. That is
        // intended.
        onPay() {
          G.log(lastToll
            ? '  [ENCLOSURE] The last toll is paid. The park closes for good.'
            : '  [ENCLOSURE] The park is paid. The gate holds.');
        },
        onDecline() {
          const AB = CARD_ABILITIES['Enclosure'];
          // SKIP ONCE AND IT IS OUT. The latch is set before the release because
          // the release can prompt (ally displacement) and a second decline
          // resolving against a still-standing gate would let out a second
          // T-Rex — same trap as Wetlands' second Block Meter.
          if (self._encReleased) return;
          const laneIdx = G.findCardLane(self);
          if (laneIdx < 0) return;
          self._encReleased = true;
          G.log('  [ENCLOSURE] The park goes unpaid. The gate swings open.');
          AB._release(G, self.owner, laneIdx, self);
        },
      });
    },
    _release(G, owner, laneIdx, habitat) {
      releaseHabitatMonster(G, {
        owner, laneIdx, habitat,
        // No `into` — the direction lives on the card (actsOnOpponentSide),
        // so the release and the lane backdrop read the same declaration.
        // REPLACED, NOT KEPT: the paddock does not outlive the T-Rex.
        clearEnv: true,
        tag: 'ENCLOSURE',
        name: 'T-Rex', cost: 5, atk: 3, hp: 7,
        abilities: ['Armor 1', 'Hunt', 'Overdrive'],
        onSpawned() {
          G.log(`  [ENCLOSURE] The T-Rex is loose on ${G.seatLabel ? G.seatLabel(G.opponent(owner)) : 'the other'} side — against the gate that would not pay.`);
          if (typeof UI !== 'undefined' && UI.emitFX) {
            try { G.emitFX('envReveal', { lane: laneIdx, owner: G.opponent(owner), name: 'T-Rex' }); } catch (e) {}
          }
        },
      });
    },
  },

  "T-Rex": {
    onMoved(G, self, to) {
      // ONE HOOK, EVERY MOVER. moveCard fires onMoved for every relocation
      // (Hunt chase, Bifrost, Magneto, Gojo, enemy shoves), so hanging the roar
      // here makes "each time the T-Rex moves" literally true — same as
      // Killer Moth's growth.
      const opp = G.opponent(self.owner);
      const targets = [];
      for (let i = 0; i < G.LANE_COUNT; i++) {
        const c = G.state.lanes[i][opp];
        if (c && c.currentHealth > 0 && !c.isEnvironment) targets.push(c);
      }
      if (!targets.length) return;
      // G.rng(), never Math.random — the engine's RNG is seeded, so a replay and
      // a fuzz seed both reproduce exactly which card the roar caught.
      const pick = targets[Math.floor(G.rng() * targets.length)];
      G.log(`  [T-REX] The roar carries down the lanes — ${pick.name} freezes.`);
      // freezeCard is the canonical door: it runs tryApplyDebuff, so Immunity
      // and Untrickable refuse this like any other freeze.
      // FREEZE, NOT STUN — stunCard() is a one-line alias for freezeCard() and
      // nothing sets isStunned, so a "Stun" here would print one word and log
      // another.
      G.freezeCard(pick, self, 1);
    },
  },

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
    // (No onTurnStart self-heal needed: the habitat is consumed at release, so
    // Spinosaurus leaving without dying (bounce, devour) can't strand it.)
    _release(G, owner, laneIdx, habitat) {
      const lane = G.state.lanes[laneIdx];
      // THE HABITAT IS CONSUMED, like all its siblings — the shared environment
      // clock answers "how long does the swamp last".
      // Cleared up front rather than on a successful spawn, matching
      // releaseHabitatMonster: the others hand the lane back before they
      // summon, so a blocked spawn leaves the same board either way.
      if (lane._env && lane._env[owner] === habitat) {
        lane._env[owner] = null;
        if (typeof UI !== 'undefined' && UI._fxWetlandsDrain) {
          try { UI._fxWetlandsDrain(laneIdx, owner); } catch (e) {}
        }
      }
      const opp = G.opponent(owner);
      const def = (typeof CARD_DEFS !== 'undefined')
        ? CARD_DEFS.find(d => d.name === 'Spinosaurus') : null;

      // The enemy standing in this lane is taken the instant he surfaces.
      // Routed through canEffectLand so Invincible / Damage Immunity refuse it
      // like any other instant-destroy (shield canon).
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
        // summonCard would see an occupied lane and bail. Same as Sewers.
        if (lane[owner] && lane[owner].currentHealth <= 0) lane[owner] = null;
        const before = G.state.lanes[laneIdx][owner];
        G.summonCard(owner, laneIdx, 'Spinosaurus', 5, atk, hp, [], def);
        const spino = G.state.lanes[laneIdx][owner];
        // Only stamp stats if a NEW Spinosaurus actually landed — otherwise
        // they'd land on the card already standing there.
        if (!spino || spino === before || spino.name !== 'Spinosaurus') {
          G.log(`  [WETLANDS] Spinosaurus can't surface in lane ${laneIdx + 1} — the lane is still occupied.`);
          return;
        }
        // summonCard ignores atk/hp when sourceDef is provided; set directly.
        spino.attack = atk;
        spino.currentHealth = hp;
        spino.maxHealth = hp;
        G.log(`Spinosaurus is released into lane ${laneIdx + 1}!`);
        if (typeof UI !== 'undefined' && UI._spinosaurusRelease) {
          setTimeout(() => { try { UI._spinosaurusRelease(laneIdx, owner); } catch (e) {} }, 60);
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
    // Movement is the real `Hunt` keyword (same _resolveHuntChase path as
    // Jason and Jango), not a bespoke start-of-round stalk.
    // HUNT METER — every damage instance anywhere on the field, from the one
    // post-damage notifier.
    onAnyCardDamaged(G, self, damaged) {
      if (self.currentHealth <= 0) return;
      if (self._spinoHuntSpent) return;          // meter already cashed in
      // ENEMY damage feeds the meter ("hunt meter goes up each time an enemy
      // is damaged"). Every instance counts, no per-round cap.
      if (!damaged || damaged.owner === self.owner) return;
      const AB = CARD_ABILITIES['Spinosaurus'];
      self._spinoMeter = (self._spinoMeter | 0) + 1;
      if (self._spinoMeter >= AB.METER_MAX) {
        // THE METER IS SPENT, NOT RESET: it pays out ONCE — the counter is
        // cleared, the badge stops rendering (_spinoHuntSpent gates it), and
        // Overdrive is granted permanently.
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
    // (No rampage hook and no onDeath: the meter pays out as permanent
    // Overdrive, and the swamp is consumed the moment he surfaces.)
  },

  // ==================== GARGANTUA ====================
  // One neutral lane, no Energy toll, for 3 rounds. At the start of each round
  // it pulls every card (both sides) 1 lane closer. A card in the hole loses
  // (−3/−3) its first turn there and is destroyed its second. A black hole is
  // weather — nobody buys it, and it belongs to neither side.
  //
  // ONE LANE, TWO INSTANCES. The event seats Gargantua on BOTH sides of its
  // lane (see _ONE_LANE_EVENTS) so the whole lane reads as the hole, which
  // means onTurnStart fires twice per round. The round stamp on the lane is
  // what keeps that one event rather than two — without it the board is pulled
  // two lanes a round and every card inside takes −6/−6.
  "Gargantua": {
    // THE HOLE CATCHES WHOEVER IS ALREADY STANDING IN IT — the clock starts
    // the moment the hole is there, not at the next onTurnStart.
    // THE ROUND STAMP IS LOAD-BEARING: Gargantua is seated TWICE (once per side
    // of its lane, _ONE_LANE_EVENTS, keepOpposite), so without it the second
    // call would find the first call's mark and kill the occupant outright.
    // It is the same stamp onTurnStart uses, so the opening round doesn't
    // crush again a moment later.
    onPlay(G, self, laneIdx) {
      // CRUSH ONLY, NOT PULL. The pull is a start-of-round beat; the opening
      // round's pull still runs from onTurnStart.
      CARD_ABILITIES['Gargantua']._crush(G, laneIdx);
      if (typeof UI !== 'undefined' && UI.render) { try { UI.render(); } catch (e) {} }
    },
    onTurnStart(G, self) {
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;
      const lane = G.state.lanes[laneIdx];
      if (!lane) return;
      const r = G.state.round | 0;
      if (lane._gargRound === r) return;      // the other half already ran it
      lane._gargRound = r;
      const AB = CARD_ABILITIES['Gargantua'];
      // A CARD THAT GOT OUT IS OUT. The hold is a fact about standing in the
      // hole — a card moved clear (Magneto, Bifrost, Hunt, the Enclosure's
      // release) loses the mark, or it would be destroyed the instant the pull
      // dragged it back, skipping its weakened round.
      for (let i = 0; i < G.LANE_COUNT; i++) {
        if (i === laneIdx) continue;
        ['player', 'ai'].forEach(side => {
          const c = G.state.lanes[i][side];
          if (c && c._gargHeld) delete c._gargHeld;
        });
      }
      // CRUSH BEFORE PULL. A card marked last round dies at the top of this
      // one; anything dragged in a moment later is marked, not killed, so it
      // gets its full round of being weakened first. Run the other way round, a
      // card pulled in would be marked and destroyed in the same breath.
      AB._crush(G, laneIdx);
      AB._pull(G, laneIdx);
      if (typeof UI !== 'undefined' && UI.render) { try { UI.render(); } catch (e) {} }
    },

    // Everything standing in the hole: first round inside loses (−3/−3),
    // second round inside it is gone.
    _crush(G, laneIdx) {
      const lane = G.state.lanes[laneIdx];
      if (!lane) return;
      // ONCE A ROUND PER LANE, WHOEVER ASKS. Two callers can reach this in the
      // same round — onPlay fires TWICE (both seats of its one lane), and
      // onTurnStart follows on the round it opens. Unguarded, the second pass
      // finds the _gargHeld mark and kills the occupant on arrival.
      // Its OWN stamp, not onTurnStart's: sharing that one would also cancel
      // the PULL on the round the hole opens.
      const r = G.state.round | 0;
      if (lane._gargCrushRound === r) return;
      lane._gargCrushRound = r;
      ['player', 'ai'].forEach(side => {
        const c = lane[side];
        if (!c || c.currentHealth <= 0 || c.isEnvironment) return;
        if (c._gargHeld) {
          G.log(`[GARGANTUA] ${c.name} is crushed by the singularity.`);
          G.killCard(c, { name: 'Gargantua' });
          return;
        }
        CARD_ABILITIES['Gargantua']._catch(G, c);
      });
    },

    // THE HOLE CATCHES YOU WHEN YOU WALK IN (played or moved in), not at the
    // next round tick.
    // Hangs off onAnyCardPlayed because checkLaneTrap already pokes every room
    // in a lane a card settled in, from the play path AND from _trapOnSettle on
    // the move path. No second definition of "entered", no per-mover patching.
    // The broadcast also fires for cards played in OTHER lanes, which is
    // harmless: _catch is a no-op on anything already held.
    onAnyCardPlayed(G, self) {
      const laneIdx = G.findCardLane(self);
      if (laneIdx < 0) return;
      const lane = G.state.lanes[laneIdx];
      if (!lane) return;
      ['player', 'ai'].forEach(side => {
        CARD_ABILITIES['Gargantua']._catch(G, lane[side]);
      });
    },

    // One card, once. The mark is the guard, NOT a round stamp: two seats and
    // two doors can reach this in the same round (Gargantua is seated on both
    // sides of its lane, and a play broadcasts while checkLaneTrap also pokes),
    // and a card must not pay (-3/-3) twice for one arrival.
    _catch(G, c) {
      if (!c || c.currentHealth <= 0 || c.isEnvironment) return;
      if (c._gargHeld) return;
      c._gargHeld = true;
      G.log(`[GARGANTUA] ${c.name} is caught in the pull — (\u22123/\u22123).`);
      // allowKill true: a card small enough to be finished by the weaken is
      // finished by it, rather than sitting at 0 HP waiting a round for the
      // crush to notice.
      G.debuffCard(c, 3, 3, true, { name: 'Gargantua' });
    },

    // One lane closer, both sides, no toll.
    _pull(G, laneIdx) {
      const targets = [];
      for (let i = 0; i < G.LANE_COUNT; i++) {
        if (i === laneIdx) continue;                       // already home
        ['player', 'ai'].forEach(side => {
          const c = G.state.lanes[i][side];
          if (c && c.currentHealth > 0 && !c.isEnvironment) targets.push({ card: c, side: side, origLane: i });
        });
      }
      if (!targets.length) return;
      if (typeof UI !== 'undefined' && UI._fxGargantuaPull) {
        try { UI._fxGargantuaPull(G.state.lanes[laneIdx]._env && (G.state.lanes[laneIdx]._env.player || G.state.lanes[laneIdx]._env.ai)); } catch (e) {}
      }
      // Closest first, so a card stepping into a lane the one ahead of it has
      // just vacated is not blocked by a body that is about to move.
      targets.sort((a, b) => {
        const da = Math.abs(a.origLane - laneIdx);
        const db = Math.abs(b.origLane - laneIdx);
        return da !== db ? da - db : a.origLane - b.origLane;
      });

      targets.forEach(t => {
        const card = t.card, side = t.side;
        if (card.currentHealth <= 0) return;
        const curLane = G.findCardLane(card);
        if (curLane < 0 || curLane === laneIdx) return;
        const dir = laneIdx > curLane ? 1 : -1;
        const targetLane = curLane + dir;
        const dest = G.state.lanes[targetLane];
        // A destroyed (voided) lane blocks the pull — there is no lane to stand
        // in for its remaining rounds, so the card holds position.
        if (dest && dest.destroyed) {
          G.log(`[GARGANTUA] ${card.name} braces against the void in lane ${targetLane + 1} — the pull fails.`);
          return;
        }
        const occupant = dest && dest[side];
        if (occupant && occupant.currentHealth > 0) {
          G.log(`[GARGANTUA] ${card.name} is blocked — lane ${targetLane + 1} is occupied.`);
          return;
        }
        // CLEAR BY IDENTITY, FROM A FRESH READ. Hooks fired between moves
        // (habitat release, Hunt chase, bounce) can move THIS card, so nulling
        // the stale curLane index would leave one object in two lanes (fuzz
        // caught "duplicate id on lane").
        const now = G.findCardLane(card);
        if (now >= 0 && G.state.lanes[now][side] === card) G.state.lanes[now][side] = null;
        dest[side] = card;
        G.log(`[GARGANTUA] ${card.name} pulled from lane ${curLane + 1} \u2192 lane ${targetLane + 1}.`);
        G.checkLaneTrap(card, targetLane);
        if (card.onMoved) card.onMoved(G, card, targetLane);
        // ARRIVED IN THE HOLE THIS ROUND. Weakened now, marked so the next
        // round's crush finds it — its "1st turn" is the turn it lands.
        if (targetLane === laneIdx && card.currentHealth > 0 && !card._gargHeld) {
          card._gargHeld = true;
          G.log(`[GARGANTUA] ${card.name} is caught in the pull — (\u22123/\u22123).`);
          G.debuffCard(card, 3, 3, true, { name: 'Gargantua' });
        }
      });
    },
  },
};

// Merge abilities into CARD_DEFS (cards.js must load before this file)
CARD_DEFS.forEach(card => {
  const ab = CARD_ABILITIES[card.name];
  if (ab) Object.assign(card, ab);
});

// …and into the SUMMON TOKEN defs, on the same terms. Tokens are not
// draftable, but anything built from their def (codex entry, test instance)
// must carry the same hooks a drafted card would.
if (typeof SUMMON_TOKEN_DEFS !== 'undefined') {
  SUMMON_TOKEN_DEFS.forEach(tok => {
    const ab = CARD_ABILITIES[tok.name];
    if (ab) Object.assign(tok, ab);
  });
}
