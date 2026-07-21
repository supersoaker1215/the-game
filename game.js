// ============================================================
// GAME ENGINE — shared decks, separate piles, detailed log
// ============================================================
let nextCardId = 1;

// ----- Deterministic RNG seam (Phase 1, see Plan agent output) -----
// Adds the primitive without migrating any callsites. Math.random()
// stays the default everywhere; opt-in seeding via Game.startSeededRun
// or by setting state._rng directly. Lets future fuzzer / replay /
// daily-challenge work plug in without touching the resolver.
function mulberry32(seed) {
  let s = (seed | 0) >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashString(str) {
  // 32-bit FNV-1a — stable, dependency-free, fine for seed derivation.
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const Game = {
  LANE_COUNT: 6,
  LANE_COUNT_2V2: 8,
  BLOCK_MAX: 8,
  state: null,
  // ===================== FX EVENT STREAM (System 3/3) =====================
  // Engine → UI events live ON GAME STATE (state._fx), not the singleton, so
  // they ride multiplayer state broadcasts: the guest replays the exact events
  // the host's engine resolved (hit floats, BLOCKED banners, titan entrances,
  // env reveals) instead of diffing renders to guess what changed. The ring is
  // seq-numbered; each client keeps a consume cursor (_fxCursor) plus the
  // stream's identity stamp (_fxMid) so a fresh match or a mid-match join
  // fast-forwards past the backlog without animating it, and an undo (which
  // restores an older ring) clamps the cursor instead of ghost-firing.
  emitFX(type, payload) {
    // Silent preview sims (previewPlacement / previewPlay swap this.state for
    // a _silentSim clone and run a card's onPlay to forecast the outcome)
    // must NOT emit: selecting a card whose onPlay strikes the face
    // (Superman, etc.) would roll the block meter and pop a real "BLOCKED!"
    // banner before you'd even played it (user report). Sim clones carry the
    // stamp, so the guard also keeps their rings from leaking anywhere.
    const s = this.state;
    if (!s || s._silentSim) return;
    if (!s._fx) s._fx = { seq: 0, events: [], mid: Date.now() + ':' + Math.floor(Math.random() * 1e6) };
    s._fx.events.push(Object.assign({ seq: ++s._fx.seq, type }, payload || {}));
    if (s._fx.events.length > 60) s._fx.events.splice(0, s._fx.events.length - 60);
  },
  emitDmg(cardId, amount, type, owner, attackerId, lethal) {
    // Damage-flavored emit — types 'hit'|'heal'|'block'|'blocked'|'evade'|
    // 'armor'|'hpHit', consumed by UI.showDamageFloats.
    this.emitFX(type, { cardId, amount, owner, attackerId, lethal: !!lethal });
  },
  _fxCursor: null,
  _fxMid: null,
  flushDmg() {
    const fx = this.state && this.state._fx;
    if (!fx) { this._fxCursor = null; this._fxMid = null; return []; }
    if (this._fxMid !== fx.mid || this._fxCursor == null || this._fxCursor > fx.seq) {
      // New stream (fresh match / joined mid-match) or an undo rolled the
      // ring back — sync to the head without replaying the backlog.
      this._fxMid = fx.mid;
      this._fxCursor = fx.seq;
      return [];
    }
    if (this._fxCursor === fx.seq) return [];
    const cur = this._fxCursor;
    this._fxCursor = fx.seq;
    return fx.events.filter(e => e.seq > cur);
  },

  // ----- Deterministic RNG (state-based) -----
  // The RNG POSITION lives in state._rngState (a uint32 counter), NOT a
  // closure — so it serializes across the MP wire, survives undo/snapshot
  // (an undo restores the exact RNG position, so a replay can't diverge after
  // an undo), and lets a fuzzer/replay reproduce a match bit-for-bit from its
  // seed. Every gameplay Math.random() is migrated to Game.rng() (cosmetic
  // randomness in ui.js stays Math.random — it must NOT consume the stream).
  // Unseeded (no _rngState) falls back to Math.random so any un-migrated or
  // pre-seed callsite is still safe.
  rng() {
    const s = this.state;
    if (!s || s._rngState == null) return Math.random();
    // mulberry32 step, advancing the counter in-place.
    let a = (s._rngState + 0x6D2B79F5) >>> 0;
    s._rngState = a;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  },
  // Integer in [0, n) from the seeded stream.
  rngInt(n) { return Math.floor(this.rng() * n); },
  // Pick a random element from an array via the seeded stream.
  rngPick(arr) { return (arr && arr.length) ? arr[this.rngInt(arr.length)] : undefined; },
  // Seed the current match. String seeds hash to uint32. Records _seed (the
  // original, for display/replay) and installs the RNG position.
  seedMatch(seed) {
    const s = this.state; if (!s) return;
    const numeric = (typeof seed === 'string') ? hashString(seed) : (seed | 0);
    s._seed = seed;
    s._rngState = numeric >>> 0;
  },
  // Entry point for seeded runs (daily challenge / replay / fuzz).
  startSeededRun(seed, mode) {
    if (typeof this.init === 'function') this.init();
    this.seedMatch(seed);
    this._seedLocked = true; // startMatch must not overwrite an explicit seed
    if (typeof this.startMatch === 'function') this.startMatch(mode || 'classic');
    this._seedLocked = false;
  },

  // Check if any player prompt is pending and defer continuation until resolved
  hasPendingPrompt() {
    return !!(
      this.state.pendingCardChoice ||
      this.state.pendingLaneChoice ||
      this.state.pendingBlockTrick ||
      this.state.pendingKangChoice ||
      this.state.pendingJumpOffer ||
      this.state.pendingTimeStoneIntercept ||
      // AI auto-resolved actions are also "pending" while their delay
      // is in flight — without this, the AI queue advances mid-chain
      // (e.g. Jigsaw places only 2 of 3 bear traps because the queue
      // moves to the next play before the second trap's setTimeout
      // callback fires). User report: "Jigsaw is making two bear
      // traps instead of three."
      (this.state._pendingAIActions && this.state._pendingAIActions > 0) ||
      (this.state.player && this.state.player.stolenByBWL) ||
      (this.state.ai && this.state.ai.stolenByBWL)
    );
  },
  // Run `fn` now if no prompt is pending, otherwise defer until prompt resolves
  whenPromptCleared(fn) {
    if (!this.hasPendingPrompt()) { fn(); return; }
    this.state._combatContinuation = fn;
    // In multiplayer, broadcast so the guest sees the pending prompt (block trick,
    // card/lane choice from onKill/onDamaged hooks, etc.) and can resolve it.
    // Without this, any mid-combat prompt set inside resolveLaneCombat is never
    // pushed to the guest, so the guest never sends promptResolve, and combat hangs.
    if (this.isMultiplayer && this.isMultiplayer() && this.mp.role === 'host') this._mpBroadcast();
  },
  // Called by UI when any prompt is resolved — fires stored continuation
  // ===================== PROMPT QUEUE =====================
  // The engine has ONE slot per prompt kind (pendingCardChoice /
  // pendingLaneChoice). Any code that arms two prompts in one synchronous
  // pass used to CLOBBER the first — two Man-Bats, a Knull volley summoning
  // two prompt-heavy cards, two deaths wanting placement picks. Now: arming
  // while any prompt slot is occupied queues the arm as a THUNK that
  // re-enters the full arm function when the current prompt resolves — so
  // target lists are re-validated against the board as it is AT FIRE TIME,
  // not as it was when the collision happened.
  _promptQueue: [],
  // "Busy" = a real occupied slot whose resolution runs through
  // resumeCombatIfWaiting (our drain point). Deliberately NOT
  // hasPendingPrompt(): that also counts in-flight AI action delays, which
  // decrement without a resolve path — gating on them could strand the queue.
  _promptBusy() {
    const s = this.state;
    return !!(s && (s.pendingCardChoice || s.pendingLaneChoice
      || s.pendingBlockTrick || s.pendingKangChoice
      || s.pendingJumpOffer || s.pendingTimeStoneIntercept));
  },

  resumeCombatIfWaiting() {
    // If the callback chained a new prompt (e.g. Omega Beam target→amount),
    // keep the continuation parked and let the next resolve fire it.
    if (this.hasPendingPrompt()) return;
    // Drain deferred prompt arms BEFORE the combat continuation — queued
    // prompts belong to the current beat. Each thunk re-enters its arm
    // function: if it raises a visible prompt we stop and wait (that
    // prompt's own resolve re-enters here and continues the drain); if it
    // auto-resolves or finds its targets gone, the loop keeps draining.
    // The re-entrancy flag makes nested resumeCombat calls (from an
    // auto-resolving thunk's callback) no-op while the outer loop owns
    // the queue.
    if (this._drainingPromptQueue) return;
    if (this._promptQueue && this._promptQueue.length) {
      this._drainingPromptQueue = true;
      try {
        while (this._promptQueue.length && !this.hasPendingPrompt()) {
          const arm = this._promptQueue.shift();
          try { arm(); } catch (e) { console.error('[promptQueue] queued arm threw:', e); }
        }
      } finally { this._drainingPromptQueue = false; }
      if (this.hasPendingPrompt()) return;
    }
    // Drain queued stack events (deaths, later: broadcasts/summons) before
    // the combat continuation — they belong to the beat that just resolved.
    // A prompt raised mid-drain pauses the drain again; that prompt's own
    // resolve re-enters here and continues it.
    this.resolveStack();
    if (this.hasPendingPrompt()) return;
    const cont = this.state._combatContinuation;
    if (cont) {
      this._bumpCombatProgress(); // watchdog: a park just resolved
      delete this.state._combatContinuation;
      // Guard the continuation: a throw here used to halt the combat
      // timeline outright (no scheduler above it), freezing the board with
      // no recovery. Log and let the watchdog force-end if it can't proceed.
      try { cont(); } catch (e) { console.error('[resumeCombatIfWaiting] continuation threw:', e); }
    }
  },

  // ===================== EVENT RESOLUTION QUEUE ("THE STACK") =====================
  // Studio-style central resolution: a game event that fires WHILE another
  // event is resolving — a bonus attack killing mid-death-aftermath, an
  // onDeath summon whose On Play kills, a broadcast handler destroying a
  // card — queues and resolves AFTER the current event fully completes, in
  // the order caused, instead of nesting on the call stack. Top-level fires
  // stay synchronous and byte-identical to the old behavior; only nested
  // fires linearize. Stage 1 routes DEATHS through it via handleDeath's
  // entrance gate; reactive broadcasts, summon arrivals, and bonus attacks
  // convert in later stages. Prompts pause the drain (same contract as the
  // prompt queue above); resumeCombatIfWaiting re-enters it. Lives on Game,
  // not state — never serialized, never crosses the MP wire.
  _stack: [],
  _stackResolving: false,
  _stackHighWater: 0,        // telemetry: deepest cascade seen this match
  STACK_STEP_BOUND: 500,     // runaway-cascade fuse, not a gameplay limit

  _stackDrain() {
    let steps = 0;
    while (this._stack.length) {
      if (this._promptBusy()) return;  // prompt owns the turn; resume re-enters
      if (++steps > this.STACK_STEP_BOUND) {
        const msg = `[STACK] runaway cascade — ${this._stack.length} events dropped`;
        console.error(msg);
        try {
          if (typeof window !== 'undefined' && window.__clbErrors) window.__clbErrors.report('stack', new Error(msg));
        } catch (e) { /* reporter must never break the game */ }
        this._stack.length = 0;
        return;
      }
      const ev = this._stack.shift();
      try {
        if (ev.type === 'death') {
          const c = ev.card;
          c._deathQueued = false;
          const l = this.findCardLane(c);
          if (l < 0) {
            // Left the board while queued (silent removal / slot replaced).
            if (c.currentHealth <= 0 && !c._deathHandled) console.warn(`[STACK] queued death skipped — ${c.name || '?'} left the board unresolved`);
            continue;
          }
          if (c.currentHealth > 0 || c._deathHandled) continue; // saved, or already processed
          // The ui.js death wrapper (derez visual + death cue) already ran
          // when this death was CAUSED — resolve the engine side only.
          this._handleDeathNow(c, l, ev.killer);
        } else if (ev.type === 'call') {
          ev.fn();
        }
      } catch (e) { console.error('[STACK] event threw:', ev.label || ev.type, e); }
    }
  },

  // Kind check that survives ability-copying (Martian Manhunter). Copiers
  // stamp _copiedFrom with the source card's name; every engine system that
  // keys behavior off a card NAME (Magneto/Luke auras, Ivy's charm unbuff,
  // Stripe's jump trigger, the ui.js charm badge scan) must match through
  // this instead of a bare name comparison, or copies silently lose the
  // machinery half of the ability.
  isCardKind(card, name) {
    return !!card && (card.name === name || card._copiedFrom === name);
  },

  // Public drain entry — safe to call anywhere; no-ops while a drain owns
  // the loop or when the queue is empty.
  resolveStack() {
    if (this._stackResolving || !this._stack.length) return;
    this._stackResolving = true;
    try { this._stackDrain(); } finally { this._stackResolving = false; }
  },

  // Run one resolution unit through the stack: fired at top level it runs
  // NOW and drains whatever it caused (synchronous, old behavior); fired
  // while another event is resolving it queues behind the current batch.
  _stackRun(label, fn) {
    if (this._stackResolving) {
      this._stack.push({ type: 'call', label, fn });
      this._stackHighWater = Math.max(this._stackHighWater, this._stack.length);
      return;
    }
    this._stackResolving = true;
    try { fn(); this._stackDrain(); } finally { this._stackResolving = false; }
  },

  // STAGE 2 — reactive broadcasts as stack events. Snapshots the listener
  // list at broadcast time (board order: lanes ascending, player before ai),
  // fires each listener as its own event with liveness re-validated at fire
  // time — so a handler that kills or summons mutates the BOARD, never the
  // iteration it rides in, and a nested broadcast (a summon inside a
  // handler) appends behind the current batch instead of recursing. At top
  // level this drains immediately — synchronous, same beat as the old
  // forEach; during a drain it appends and the outer loop reaches the
  // events in order.
  broadcastHook(hook, source, args) {
    const extra = args || [];
    const listeners = this.getAllCardsOnBoard().filter(c => c[hook] && (!source || c.id !== source.id));
    if (!listeners.length) return;
    listeners.forEach(c => {
      this._stack.push({
        type: 'call', label: `${hook}:${c.name}`,
        fn: () => {
          if (c.currentHealth <= 0) return;                    // died before firing
          if (!this.getAllCardsOnBoard().includes(c)) return;  // left the board (combat or env slot)
          c[hook](this, c, ...extra);
        },
      });
    });
    this._stackHighWater = Math.max(this._stackHighWater, this._stack.length);
    this.resolveStack();
  },

  // Lifecycle reset — queued events must never survive a boot, a new match,
  // a new round, or an undo (they closure over pre-restore card objects).
  _stackClear(where) {
    if (this._stack.length) {
      if (where === 'startRound') console.warn(`[STACK] ${this._stack.length} unresolved events crossed into a new round — a drain path was skipped`);
      this._stack.forEach(ev => { if (ev.card) ev.card._deathQueued = false; });
      this._stack.length = 0;
    }
    this._stackResolving = false;
  },

  // ===================== ENTITY REGISTRY =====================
  // Canonical id -> live card-instance index. One source of truth for
  // "which object IS card N", so systems that reference cards by id (the
  // FX stream, MP payloads, prompt targets, undo) resolve to the ONE live
  // instance instead of scanning every zone or holding a stale reference —
  // the class behind the "two slots point at the same card" / "undo made a
  // second Ahsoka" bugs. The index is DERIVED (rebuildable from the zones),
  // so it lives on Game, NOT in state: never cloned or snapshotted, rebuilt
  // at every state-restore boundary (startMatch, undo, MP push).
  _entities: null,

  rebuildEntityIndex() {
    const m = this._entities || (this._entities = new Map());
    m.clear();
    const s = this.state;
    if (!s) return m;
    const add = c => { if (c && c.id != null) m.set(c.id, c); };
    if (s.lanes) {
      for (let i = 0; i < s.lanes.length; i++) {
        const l = s.lanes[i]; if (!l) continue;
        add(l.player); add(l.ai);
        if (l._env) { add(l._env.player); add(l._env.ai); }
      }
    }
    ['player', 'ai'].forEach(side => {
      const p = s[side]; if (!p) return;
      (p.hand || []).forEach(add);
      (p.trickHand || []).forEach(add);
    });
    if (s.twoVTwo && s.twoVTwo.players) {
      Object.keys(s.twoVTwo.players).forEach(pk => {
        const pp = s.twoVTwo.players[pk]; if (!pp) return;
        (pp.hand || []).forEach(add);
        (pp.trickHand || []).forEach(add);
      });
    }
    return m;
  },

  // Register a freshly-created instance. Called by createCardInstance so
  // every card is indexed the moment it exists.
  registerEntity(card) {
    if (!card || card.id == null) return card;
    if (!this._entities) this._entities = new Map();
    this._entities.set(card.id, card);
    return card;
  },

  // O(1) id -> live card. Self-healing: a miss or a stale hit triggers ONE
  // rebuild-and-retry, so a lookup can never miss a card that exists in a
  // zone (covers a caller that moved an instance without re-registering, or
  // an index gone stale after the predictor's clone-and-restore swap).
  findCard(id) {
    if (id == null) return null;
    if (!this._entities) this.rebuildEntityIndex();
    let c = this._entities.get(id);
    if (c && c.id === id) return c;
    this.rebuildEntityIndex();
    c = this._entities.get(id);
    return (c && c.id === id) ? c : null;
  },

  // ===================== UNDO HISTORY =====================
  // Snapshots of full game state taken before player actions, ability resolutions,
  // and combat. Cleared at the start of each new player sub-phase so undo can never
  // cross a turn boundary. The list lives outside `state` so it isn't itself cloned.
  history: [],
  HISTORY_LIMIT: 100,

  // ===================== MULTIPLAYER =====================
  // mp.role:    'host' | 'guest' | null  — null = single-player vs AI
  // mp.you:     'player' | 'ai'           — which side this client controls
  // mp.opp:     'player' | 'ai'           — the OTHER side
  // The host runs the canonical engine; the guest runs a mirror that
  // accepts authoritative state pushes. Inputs from EITHER side flow
  // through Multiplayer.send and are applied on the host, then the
  // updated state is broadcast back. For LocalTabTransport, the host
  // also applies its own inputs locally (no round-trip needed).
  mp: { role: null, you: null, opp: null },
  isMultiplayer() { return !!(this.mp && this.mp.role); },
  // Monotonic match id — bumped on every startMatch and on quit-to-menu.
  // Combat/AI/game-over timers capture it and bail if it changed, so an
  // abandoned match's setTimeouts can't resume over the menu (or double-run
  // against a freshly started match that reuses this.state in place).
  _matchGen: 0,
  // Schedule a match-scoped timeout: fires only if we're still in the same
  // match. Use for any deferred step that advances match flow.
  _matchTimeout(fn, ms) {
    const gen = this._matchGen;
    return setTimeout(() => { if (this._matchGen !== gen) return; fn(); }, ms);
  },

  // ===================== LOGIC / PRESENTATION SEAM =====================
  // The ONE explicit boundary where the engine's LOGIC hands off to
  // PRESENTATION pacing. Combat lane cadence, the post-combat beat, AI move
  // delays, and the round-open delay are pure PRESENTATION — how fast the
  // player watches the already-decided result unfold. Routing them through this
  // single seam means:
  //   • LIVE play (default): _matchTimeout — the timed, watchable cadence,
  //     generation-guarded, byte-for-byte the same as before.
  //   • SYNC mode (_syncMode = true): the engine resolves the whole beat
  //     SYNCHRONOUSLY with no timers — a first-class headless/fuzz/replay
  //     mode instead of monkey-patching global setTimeout. The FX event stream
  //     (state._fx) already carries what happened, so a UI can replay it at its
  //     own pace; the engine never blocks on presentation.
  // The fuzz's 3000-game clean run (timers collapsed) is the proof the engine
  // LOGIC is fully timing-independent — this seam just makes that swappable.
  _syncMode: false,
  _schedule(fn, ms) {
    if (this._syncMode) { try { fn(); } catch (e) { console.error('[schedule:sync] threw:', e); } return 0; }
    return this._matchTimeout(fn, ms);
  },

  // ===================== COMBAT WATCHDOG =====================
  // A combat freeze — a continuation that threw, an orphaned prompt park
  // (e.g. an MP guest prompt the guest never answered), a dropped pacing
  // timer — leaves the board stuck mid-combat with NO way to recover. It's
  // the #1 "the game froze and we can't keep playing" report, and it never
  // shows in the headless sim (that stubs UI + fires timers synchronously).
  // This watchdog force-ends combat once it has been idle longer than any
  // legitimate pause could last: the prompt auto-pick timeout is 30s, so a
  // real prompt always resolves (and bumps progress) well before the 45s
  // limit — only a TRUE stall reaches it. On trip we drop every pending
  // flag + parked continuation and run postCombat(), so the round advances
  // instead of hanging forever.
  _COMBAT_WATCHDOG_MS: 45000,
  _combatWatchdogTimer: null,
  _combatProgressAt: 0,
  _bumpCombatProgress() { this._combatProgressAt = Date.now(); },
  _armCombatWatchdog() {
    // Headless sim resolves combat synchronously and has no setInterval —
    // it can't stall, so skip. Browser only.
    if (typeof __HEADLESS_SIM !== 'undefined') return;
    if (typeof setInterval === 'undefined') return;
    // Never arm during a silent preview sim (previewPlay clones the state and
    // runs resolveCombat on it to forecast outcomes). Its combat runs against
    // a throwaway clone; a real setInterval armed there would outlive the sim
    // and tick against the restored live state.
    if (this.state && this.state._silentSim) return;
    this._clearCombatWatchdog();
    this._bumpCombatProgress();
    this._watchdogTrips = 0; // fresh combat — reset the recovery-retry cap
    const gen = this._matchGen;
    this._combatWatchdogTimer = setInterval(() => {
      // Liveness: watch the WHOLE combat phase, not just while _inCombat is
      // set. resolveCombat() can park on a pre-combat prompt (onBeforeCombat /
      // before-tricks hooks) and return BEFORE _inCombat is set — an orphaned
      // MP prompt there used to hang with no watchdog at all. state.phase is
      // 'combat' from the moment we enter until postCombat advances the round.
      if (this._matchGen !== gen || !this.state ||
          (this.state.phase !== 'combat' && !this.state._inCombat)) {
        this._clearCombatWatchdog();
        return;
      }
      if (Date.now() - (this._combatProgressAt || 0) < this._COMBAT_WATCHDOG_MS) return;
      // Stalled longer than any real prompt could last — recover.
      const s = this.state;
      try {
        console.error('[COMBAT WATCHDOG] combat stalled — force-ending. state:', JSON.stringify({
          phase: s.phase, inCombat: !!s._inCombat,
          activeLane: s._activeLane, parked: !!s._combatContinuation,
          cardChoice: !!s.pendingCardChoice, laneChoice: !!s.pendingLaneChoice,
          blockTrick: !!s.pendingBlockTrick, kang: !!s.pendingKangChoice,
          jumpOffer: !!s.pendingJumpOffer, timeStone: !!s.pendingTimeStoneIntercept,
          aiActions: s._pendingAIActions || 0,
        }));
      } catch (e) {}
      // Do NOT disarm before recovering. If _forceEndStalledCombat throws or
      // its recovery doesn't actually unstick the phase, a one-shot watchdog
      // would leave the match bricked with nothing left to save it. Instead
      // reset the progress clock and let the interval keep running: a healthy
      // recovery flips the phase off 'combat' and the liveness check at the top
      // disarms us on the next tick; a failed one gets retried after another
      // full window. Cap the retries so a permanently-throwing recovery doesn't
      // log-spam forever.
      this._bumpCombatProgress();
      this._watchdogTrips = (this._watchdogTrips || 0) + 1;
      try { this._forceEndStalledCombat(); }
      catch (e) { console.error('[COMBAT WATCHDOG] recovery threw:', e); }
      if (this._watchdogTrips >= 4) {
        console.error('[COMBAT WATCHDOG] recovery failed repeatedly — giving up.');
        this._clearCombatWatchdog();
      }
    }, 3000);
  },
  _clearCombatWatchdog() {
    if (this._combatWatchdogTimer) { clearInterval(this._combatWatchdogTimer); this._combatWatchdogTimer = null; }
  },
  _forceEndStalledCombat() {
    const s = this.state;
    if (!s || (s.phase !== 'combat' && !s._inCombat)) return;
    // Drop every blocker so hasPendingPrompt() can't re-park combat.
    s.pendingCardChoice = null; s.pendingLaneChoice = null;
    s.pendingBlockTrick = null; s.pendingKangChoice = null;
    s.pendingJumpOffer = null; s.pendingTimeStoneIntercept = null;
    s._pendingAIActions = 0;
    if (s.player) s.player.stolenByBWL = null;
    if (s.ai) s.ai.stolenByBWL = null;
    delete s._combatContinuation;
    this._clearPromptTimeout();
    if (s._inCombat) {
      // Mid-combat stall — force to the normal end-of-combat path. Imperfect
      // (a lane or two may be left unresolved) but the game continues. If
      // postCombat itself throws, fall through to a hard round advance so the
      // match can't brick on a broken end-of-combat hook.
      this.log('[COMBAT WATCHDOG] Combat was stuck — force-resolving to end of combat.');
      try { this.postCombat(); }
      catch (e) {
        console.error('[COMBAT WATCHDOG] postCombat threw:', e);
        try { this.drawPhase(() => this.startRound()); }
        catch (e2) { console.error('[COMBAT WATCHDOG] forced drawPhase threw:', e2); try { this.startRound(); } catch (e3) {} }
      }
    } else if (s._combatFinishedThisRound) {
      // POST-combat stall — combat already resolved this round (that flag is
      // set at the end of postCombat), but the round never advanced: the
      // round-summary crossfade promise hung, or the drawPhase/startRound
      // pacing timer was dropped. Re-running combat here would double-resolve
      // the board, so instead force the round forward exactly the way a clean
      // postCombat would. This is the branch the "combat finished but frozen"
      // freeze lands in now that the watchdog stays armed through postCombat.
      this.log('[COMBAT WATCHDOG] Post-combat stall — forcing next round.');
      try { this.drawPhase(() => this.startRound()); }
      catch (e) { console.error('[COMBAT WATCHDOG] forced drawPhase threw:', e); try { this.startRound(); } catch (e2) {} }
    } else {
      // Pre-combat stall: an onBeforeCombat / before-tricks prompt was
      // orphaned before _inCombat was set (e.g. an MP guest prompt never
      // answered). Prompts are cleared now, so re-enter resolveCombat — it
      // passes the pending-prompt guards and actually RUNS combat instead of
      // skipping it. Force _beforeCombatFired so the onBeforeCombat hooks that
      // raised the stuck prompt don't re-fire and re-raise it.
      s._beforeCombatFired = true;
      this.log('[COMBAT WATCHDOG] Pre-combat prompt was stuck — resuming combat.');
      try { this.resolveCombat(); }
      catch (e) {
        console.error('[COMBAT WATCHDOG] resolveCombat threw:', e);
        try { this.postCombat(); } catch (e2) { console.error('[COMBAT WATCHDOG] postCombat threw:', e2); }
      }
    }
    if (typeof UI !== 'undefined' && UI.render) UI.render();
    if (this.isMultiplayer && this.isMultiplayer() && this.mp.role === 'host') this._mpBroadcast();
  },

  // ===================== 1v1 LOCAL (pass-and-play hotseat) =====================
  // Two humans, one device, the SAME classic draft/board pipeline as solo.
  // Rides the multiplayer machinery: both seats isHuman (prompts raise modals
  // instead of AI auto-picks), and at every seat handoff we show an opaque
  // "pass the device" gate, then _mpFlipPerspective the LIVE state in place so
  // the active person is always 'player' — every existing UI assumption
  // (hand at the bottom, phase gating, Done buttons) holds unchanged.
  isHotseat() { return !!(this.state && this.state.hotseat); },

  startLocal1v1() {
    this.init();
    // mode.hotseat makes startMatch mark the state + both seats human, and
    // rematch()'s captured config rebuilds the same setup automatically.
    this.startMatch({ players: '1v1', deck: 'classic', hotseat: true });
  },

  // Queue the pass gate. The seat about to act is always 'ai' pre-flip
  // (every call site sits where solo would have invoked the AI), so the
  // gate names that seat's owner. UI renders an opaque full-screen cover —
  // the next player confirms before any of their cards hit the screen.
  _hotseatHandoff() {
    const names = this.state._mpNames || { player: 'Player 1', ai: 'Player 2' };
    this.state.pendingHotseatPass = { name: names.ai };
    if (typeof UI !== 'undefined') UI.render();
  },

  confirmHotseatPass() {
    if (!this.state || !this.state.pendingHotseatPass) return;
    delete this.state.pendingHotseatPass;
    this._mpFlipPerspective(this.state);
    // Undo snapshots must never cross a handoff — restoring the other
    // player's pre-flip turn would leak their hand and corrupt seat labels.
    this.clearHistory();
    if (typeof UI !== 'undefined') UI.render();
  },

  // Called by UI._mpInit() opponentJoined handler. Host kicks off a
  // standard classic match — the opponent will pick up the state via
  // the host's first broadcastState call below.
  startMultiplayerHost() {
    this.mp = { role: 'host', you: 'player', opp: 'ai' };
    // Subscribe to inbound action messages from the guest. Idempotent
    // — only register once even if startMultiplayerHost runs twice.
    if (!this._mpActionBound && typeof Multiplayer !== 'undefined') {
      this._mpActionBound = true;
      Multiplayer.on('action', (msg) => this._mpApplyAction(msg, 'ai'));
      // Wrap host-side action entry points so every successful local
      // action (host clicking play/trick/etc.) automatically broadcasts
      // the new state to the guest. The guest path returns early before
      // these wrappers do their post-call broadcast (mp guard above).
      const wrapBroadcast = (name) => {
        if (typeof this[name] !== 'function') return;
        const orig = this[name].bind(this);
        this[name] = (...args) => {
          const r = orig(...args);
          if (this.isMultiplayer() && this.mp.role === 'host') this._mpBroadcast();
          return r;
        };
      };
      wrapBroadcast('playCard');
      wrapBroadcast('playCardFree');
      wrapBroadcast('playTrick');
      wrapBroadcast('endTurn');
      wrapBroadcast('endPlayerTurn');
      wrapBroadcast('endPhase1');
      wrapBroadcast('endPhase2');
      wrapBroadcast('endPhase3');
      wrapBroadcast('draftPick');
      wrapBroadcast('mulligan');
      wrapBroadcast('startRound');
      wrapBroadcast('resolveLanes');
      wrapBroadcast('resumeCombatIfWaiting');
    }
    // Both seats are humans now; the existing isHuman flag governs
    // whether ability prompts raise modals or auto-pick.
    if (!this.state) this.init();
    // Run the standard classic-mode startMatch so all the existing
    // draft / round / combat machinery just works. Both side's
    // .isHuman gets set true here so prompts fire on the right
    // client. We intentionally route the opponent's prompts as
    // local prompts on the host for v1 — the host's UI shows them
    // and resolves them by sending a promptResolve action; in
    // practice for LocalTabTransport that's fine because the
    // opponent IS the host's other tab. PartyKit phase will move
    // prompt routing to the actual seat owner.
    // Set both seats human BEFORE startMatch so any prompt that could fire
    // during match setup sees isHuman('ai')===true (startMatch reuses
    // this.state in the classic path and never re-runs init()/makePlayer(),
    // so these flags survive). Closes the only window where the makePlayer
    // isHuman:false default could let a guest prompt auto-resolve to lanes[0]
    // on the host. Re-asserted after startMatch too (idempotent).
    if (this.state.player) this.state.player.isHuman = true;
    if (this.state.ai)     this.state.ai.isHuman = true;
    this.startMatch({ players: '1v1', deck: 'classic' });
    if (this.state.player) this.state.player.isHuman = true;
    if (this.state.ai)     this.state.ai.isHuman = true;
    // SEAT HYGIENE — startMatch reuses this.state without re-running init(),
    // so forced-lane residue from an abandoned SOLO match (Moder's forcedLane,
    // the old Magneto's magnetoForcedLanes queue) survives into this MP match.
    // On the host that residue made reqLaneChoice collapse the guest's open
    // lanes to ONE entry and auto-play with no picker — cards marched into
    // lane 1, 2, 3… ascending. Root cause of the long-standing "guest can't
    // choose their lane" bug: the MP wiring was correct; the state was poisoned.
    ['player', 'ai'].forEach(s => {
      const seat = this.state[s];
      if (!seat) return;
      seat.forcedLane = null;
      delete seat.magnetoForcedLanes;
    });
    // Embed both players' display names in state so they broadcast to the guest
    // and remain accurate after any perspective flip.
    if (typeof UI !== 'undefined') {
      this.state._mpNames = {
        player: UI._mpName ? UI._mpName() : 'Host',
        ai: (UI._mpState && UI._mpState.opponent) || 'Opponent',
      };
    }
    this._mpBroadcast();
  },

  // ===================== COMMAND PIPELINE (Step 1) =====================
  // One validated intake for PLAYER-ORIGINATED actions. Every action a human
  // takes — play a card, play a trick, jump — enters here as a typed command
  // { type, payload, actor? }. submitCommand decides, in ONE place:
  //   1. who is acting (actor defaults to this client's local seat),
  //   2. whether they own the target (ownership validation), and
  //   3. whether to APPLY locally (solo / host) or FORWARD to the host (guest).
  // This replaces the forward-or-apply guard that was copy-pasted at the top
  // of playCard / playCardFree / playTrick / playJumpCard. The backbone is
  // unchanged — still host-authoritative + snapshot broadcast, and the wire
  // messages are the exact ones _mpApplyAction already understands.
  //
  // NOT for engine-internal calls. Abilities, AI, and summon code keep calling
  // the engine functions directly — those aren't player commands and must
  // never be re-validated or forwarded. Only UI action handlers submit here.
  //
  // Step 1 scope: submitCommand is the single validated DOOR. It resolves +
  // ownership-checks the target once, then dispatches to the existing engine
  // entry point — which still owns the guest-forward / SFX-wrapper / _silentSim
  // behavior it always had, so this layer changes ZERO runtime behavior. The
  // per-function guest-forward guards therefore stay for now; a later step
  // relocates forwarding into the pipeline (and moves the SFX trigger with it).
  // 2v2 and prompt resolutions are not routed here yet.

  // Which seat THIS client's human controls. Solo and 1v1 (host OR guest) all
  // render the local human as 'player' (the guest's state is seat-flipped). In
  // 2v2 the local player maps to their TEAM SIDE — during your own sub-turn
  // _2v2SyncActivePlayer has put your hand into state[side] (same ref), so
  // _cmdCard(side,…) resolves your card + index identically to the wire.
  _localSeat() {
    if (this.is2v2 && this.is2v2() && this.state.twoVTwo) {
      const me = this.state.twoVTwo.players[this.state.twoVTwo.you];
      if (me && this._2v2TeamSide) return this._2v2TeamSide[me.team] || 'player';
    }
    return 'player';
  },

  // The 2v2 arm of the door — 2v2 online uses a different transport
  // (Multiplayer4, playerKey envelope) and authority test (you==='p1', not
  // mp.role==='host'), so submitCommand branches here. Replicates the existing
  // 2v2 hand/trick onclick logic EXACTLY so routing through the door is
  // behavior-identical. Returns true if dispatched.
  _submitCommand2v2(type, p) {
    const tt = this.state.twoVTwo;
    if (!tt) return false;
    const you = tt.you;
    if (this._2v2ActivePlayer && this._2v2ActivePlayer() !== you) return false; // not your sub-turn
    const isHost = (you === 'p1');
    const ap = tt.players[you];
    if (!ap) return false;
    if (type === 'playCard') {
      const wantId = p.card ? p.card.id : p.cardId;
      const idx = (ap.hand || []).findIndex(c => c.id === wantId);
      if (idx < 0) return false;
      // 2v2 playCard = the lane-REQUEST path (lane is chosen by the ensuing
      // lane prompt), so payload.lane is intentionally ignored here.
      if (isHost) { this._2v2RequestLaneChoice(you, idx); this._2v2OnlineBroadcast(); }
      else if (typeof Multiplayer4 !== 'undefined') { Multiplayer4.send({ t: 'req2v2LaneChoice', playerKey: you, cardIdx: idx }); }
      return true;
    }
    if (type === 'playTrick') {
      const wantId = p.trick ? p.trick.id : p.trickId;
      const idx = (ap.trickHand || []).findIndex(t => t.id === wantId);
      if (idx < 0) return false;
      if (isHost) {
        this._2v2CurrentActingPlayer = 'p1';
        this._2v2OnlinePlayTrick(you, idx);
        if (!this.state.pendingLaneChoice && !this.state.pendingCardChoice) this._2v2CurrentActingPlayer = null;
        this._2v2OnlineBroadcast();
      } else if (typeof Multiplayer4 !== 'undefined') {
        Multiplayer4.send({ t: 'play2v2Trick', playerKey: you, trickIdx: idx });
      }
      return true;
    }
    return false; // playJump / playCardFree not routed for 2v2 yet
  },

  // Resolve the card/trick instance a command refers to, from the actor's own
  // hand. Accepts a pre-resolved object (local UI has it) or an id (the wire).
  _cmdCard(actor, p) {
    if (p.card) return p.card;
    const hand = (this.state[actor] && this.state[actor].hand) || [];
    return hand.find(c => c.id === p.cardId) || null;
  },
  _cmdTrick(actor, p) {
    if (p.trick) return p.trick;
    const th = (this.state[actor] && this.state[actor].trickHand) || [];
    return th.find(t => t.id === p.trickId) || null;
  },

  COMMANDS: {
    playCard: {
      resolve(G, actor, p) { return G._cmdCard(actor, p); },
      apply(G, actor, p, card) { return G.playCard(actor, card, p.lane); },
    },
    playCardFree: {
      resolve(G, actor, p) { return G._cmdCard(actor, p); },
      apply(G, actor, p, card) { return G.playCardFree(actor, card, p.lane); },
    },
    playTrick: {
      resolve(G, actor, p) { return G._cmdTrick(actor, p); },
      apply(G, actor, p, trick) { return G.playTrick(actor, trick); },
    },
    playJump: {
      resolve(G, actor, p) { const c = G._cmdCard(actor, p); return (c && c.jumpReady) ? c : null; },
      apply(G, actor, p, card) { return G.playJumpCard(actor, card); },
    },
  },

  // The single door. Returns the engine fn's result; false when the command
  // is unknown or the actor doesn't own the target.
  submitCommand(cmd) {
    if (!cmd || !cmd.type) return false;
    const def = this.COMMANDS[cmd.type];
    if (!def) { console.warn('[cmd] unknown command type:', cmd.type); return false; }
    const p = cmd.payload || {};
    // Normalize object ↔ id so both the local object and the wire id are set.
    if (p.card && p.cardId == null) p.cardId = p.card.id;
    if (p.trick && p.trickId == null) p.trickId = p.trick.id;
    const actor = cmd.actor || this._localSeat();
    // 2v2 online diverges: different transport (Multiplayer4, playerKey) and
    // authority (you==='p1'), so it has its own arm. Branch BEFORE resolve/apply
    // — the 1v1/solo path below is untouched.
    if (this.is2v2 && this.is2v2() && this.state.twoVTwo && this.state.twoVTwo.online) {
      return this._submitCommand2v2(cmd.type, p);
    }
    // Ownership, decided ONCE at the door: the target must belong to the
    // actor's own hand. Previously this was implicit / trusted from the caller.
    const target = def.resolve ? def.resolve(this, actor, p) : null;
    if (def.resolve && !target) {
      console.warn('[cmd] ownership/resolve failed:', cmd.type, 'actor=', actor);
      return false;
    }
    // Dispatch to the existing engine entry point. It keeps its own
    // guest-forward / _silentSim / SFX behavior, so nothing else changes yet.
    const result = def.apply(this, actor, p, target);
    // Replay recording — capture the command on the authoritative side (this
    // apply path is host/solo; a guest forwards and the host records). Only
    // ids are stored so the log is serializable and re-appliable.
    if (result !== false) {
      this._recordCmd({ k: 'cmd', type: cmd.type, actor, cardId: p.cardId, trickId: p.trickId, lane: p.lane });
    }
    return result;
  },

  // ===================== CLIENT-SIDE PREDICTION =====================
  // Optimistic-input netcode. Today the guest FORWARDS a command and WAITS
  // for the host's authoritative state broadcast — so every play carries a
  // full network round-trip of visible lag. Prediction lets the guest apply
  // its own command LOCALLY the instant it's issued (0-latency feel), then
  // reconcile when the authoritative state lands. Determinism (serializable
  // _rngState + the single command door) is what makes this sound: the
  // guest's local prediction reproduces the host's result, so a correct
  // prediction reconciles invisibly; only a genuine divergence snaps.
  //
  // This is the deterministic CORE + its tests. It is gated by
  // _predictionEnabled (default false) because flipping the guest from
  // forward-and-wait to apply-then-forward is a real desync risk that needs
  // a live 2-client test — same rollout gate as the deferred secret-reveal
  // work. The reconcile math below is proven headlessly (sim/golden RG-14/15).
  _predictionEnabled: false,
  _predictions: null,    // [{seq, cmd}] applied locally, not yet host-acked
  _predictSeq: 0,
  _silentReapply: false, // true while re-simulating during reconcile

  // Issue a command optimistically: apply it locally NOW and remember it as
  // in-flight so reconcile can re-apply it if the next authoritative state
  // hasn't folded it in yet. Returns the sequence number (the ack key).
  predictCommand(cmd) {
    if (!cmd || !cmd.type) return -1;
    if (!this._predictions) this._predictions = [];
    const seq = ++this._predictSeq;
    const result = this.submitCommand(cmd);
    if (result !== false) this._predictions.push({ seq, cmd });
    return (result !== false) ? seq : -1;
  },

  // Adopt the authoritative state, drop the predictions the host has already
  // folded in (seq <= ackedThrough), then RE-SIMULATE the ones still in
  // flight on top of the fresh base — so the guest keeps seeing its own
  // un-acked inputs instead of rubber-banding back a round-trip. The re-sim
  // is silent (no SFX, no replay-record, no re-forward to the host). Any
  // prediction that no longer resolves against the authoritative state (the
  // host rejected or superseded it) simply drops — self-correcting.
  reconcile(authState, ackedThrough) {
    if (authState) { this.state = authState; this.rebuildEntityIndex(); }
    const ack = ackedThrough || 0;
    this._predictions = (this._predictions || []).filter(p => p.seq > ack);
    if (this._predictions.length) {
      this._silentReapply = true;
      try {
        // Re-run survivors in issue order. filter() keeps a copy of any that
        // still applied cleanly; a stale one (returns false) is dropped.
        this._predictions = this._predictions.filter(p => this.submitCommand(p.cmd) !== false);
      } finally { this._silentReapply = false; }
    }
    return this.state;
  },

  // ===================== REPLAY (record + reproduce) =====================
  // A match is fully reproducible from its SEED + the log of player COMMANDS:
  // the AI is seeded-deterministic (Game.rng re-derives its moves), so only
  // human inputs need recording. Recording captures the seed at start and every
  // command that flows through the door (plays + prompt resolutions). Replaying
  // re-seeds and re-issues the log through the SAME door → the exact same match.
  // Foundation for a replay viewer, shareable "send me your replay" bug reports,
  // and (with the command pipeline) command-log MP.
  _replayLog: null,   // null = not recording; array while recording
  _replaySeed: null,
  _replayMode: null,
  startReplayRecording() {
    this._replayLog = [];
    this._replaySeed = this.state ? this.state._seed : null;
    this._replayMode = this.state ? (this.state.mode || 'classic') : 'classic';
  },
  stopReplayRecording() { const r = this.exportReplay(); this._replayLog = null; return r; },
  _recordCmd(entry) {
    // Never record preview/silent-sim actions, re-simulated predictions, and
    // only while recording. A reconcile re-apply is not a NEW input — the
    // original prediction already recorded (or the host owns the log), so
    // recording it again would double-count the replay.
    if (this._replayLog && !this._silentReapply && !(this.state && this.state._silentSim)) this._replayLog.push(entry);
  },
  exportReplay() {
    return { v: 1, seed: this._replaySeed, mode: this._replayMode, log: (this._replayLog || []).slice() };
  },
  // Re-issue one recorded log entry against the current (re-seeded) state.
  // Returns whatever the underlying door returned.
  applyReplayEntry(entry) {
    if (!entry) return false;
    if (entry.k === 'cmd') {
      const payload = { cardId: entry.cardId, trickId: entry.trickId, lane: entry.lane };
      return this.submitCommand({ type: entry.type, actor: entry.actor, payload });
    }
    if (entry.k === 'resolve') {
      return this.resolveActivePrompt(entry.kind, entry.payload || {});
    }
    return false;
  },

  // ===================== PROMPT OWNERSHIP AUTHORITY =====================
  // ONE source of truth for "who owns a pending prompt" — read by BOTH the
  // render gates (who sees the interactive picker) and the resolution path
  // (who may resolve it). Before this, that predicate was re-derived in ~7
  // renderers and every resolve handler, with real gaps (the hand-target
  // gate ignored 2v2; the blockTrick/kang/jump host branches skipped the
  // ownership check). Divergence between "who sees it" and "who can resolve
  // it" is exactly the wrong-player prompt bug class (Mobius Chair et al.).
  //
  // Each prompt kind stashes its owning SIDE ('player' | 'ai') in a different
  // field — this map is the single place that knowledge lives.
  _promptOwnerSeat(prompt, kind) {
    if (!prompt) return null;
    switch (kind) {
      case 'card':
      case 'lane':
      case 'kang':      return prompt.owner || 'player';
      case 'blockTrick':return prompt._btOwner || 'player';
      case 'timeStone': return prompt.defender || 'player';
      case 'jump': {
        // Jump has no owner field — the owner is whichever side's hand holds
        // the offered card. Matches the render gate's hand-membership infer.
        const id = prompt.cardId;
        if ((this.state.player && this.state.player.hand || []).some(c => c.id === id)) return 'player';
        if ((this.state.ai && this.state.ai.hand || []).some(c => c.id === id)) return 'ai';
        return 'player';
      }
      default: return prompt.owner || 'player';
    }
  },

  // Is the currently-pending prompt of this kind owned by THIS client's seat?
  // Solo: always true (the AI's prompts auto-resolve and never reach a gate).
  // 1v1 online: the local human is always rendered as 'player' (state is
  //   seat-flipped on the guest), so a prompt is mine iff its owner is
  //   'player'. 2v2 online: ownership is the playerKey token _2v2ActingPlayer.
  promptIsMine(prompt, kind) {
    if (!prompt) return true; // nothing to gate
    if (this.is2v2 && this.is2v2() && this.state.twoVTwo && this.state.twoVTwo.online) {
      return !prompt._2v2ActingPlayer || prompt._2v2ActingPlayer === this.state.twoVTwo.you;
    }
    if (!this.isMultiplayer()) return true; // solo — AI prompts resolve elsewhere
    return this._promptOwnerSeat(prompt, kind) === 'player';
  },

  // Resolve the pending card/lane prompt LOCALLY — the client resolving its
  // OWN prompt (solo, 1v1 host-own, 2v2 acting player). The guest-forward and
  // 2v2-teammate-forward stay in the UI handler ABOVE this call; this is the
  // shared local tail both handlers funnel through, so the resolve path reads
  // the SAME ownership authority (promptIsMine) the render gates do — they can
  // no longer diverge. Payload is validated the way the host validates a
  // guest's wire resolve (bad idx / out-of-set lane rejected), and the
  // null-before-snapshot → callback → cleanupDead → resume ordering (the undo
  // stale-closure rule) is preserved exactly. Returns true if it resolved.
  // NOT for the host applying a GUEST's resolve — that path (in _mpApplyAction)
  // is actor-relative and keeps its own owner!==actor gate; promptIsMine here
  // is seat-relative to THIS client and would reject an 'ai'-owned prompt.
  resolveActivePrompt(kind, payload) {
    const slotKey = kind === 'lane' ? 'pendingLaneChoice' : 'pendingCardChoice';
    const prompt = this.state[slotKey];
    if (!prompt) return false;
    if (!this.promptIsMine(prompt, kind)) return false;
    let arg;
    if (kind === 'lane') {
      const laneIdx = (payload && payload.laneIdx);
      if (laneIdx == null) return false;
      if (prompt.lanes && !prompt.lanes.includes(laneIdx)) return false; // out-of-set guard
      arg = laneIdx;
    } else {
      const idx = (payload && payload.idx);
      if (idx == null || !prompt.cards || !prompt.cards[idx]) return false;
      arg = prompt.cards[idx];
    }
    this._clearPromptTimeout();
    // Null the slot BEFORE snapshotting — a snapshot must never capture an
    // armed prompt (its callback is a live closure; undoing to it replays the
    // original timeline's objects → the duplicate-Ahsoka class).
    this.state[slotKey] = null;
    if (prompt.owner === 'player' && this.isPlayerTurn()) this.snapshot();
    // Replay recording — capture the prompt resolution (kind + validated
    // payload) before the callback runs, so a replay resolves it identically.
    this._recordCmd({ k: 'resolve', kind, payload: (kind === 'lane') ? { laneIdx: arg } : { idx: payload.idx } });
    if (prompt.callback) prompt.callback(arg);
    this.cleanupDead();
    this.resumeCombatIfWaiting();
    return true;
  },

  // Apply an action message arriving from the wire. `actor` is the
  // owner side ('player' or 'ai') the action originated from — for
  // host receiving guest msgs, actor is always 'ai' (the guest sits
  // on the AI seat in v1). Looks up the card/trick by id, then routes
  // through the same engine entry points that the local UI uses.
  // Errors are caught and logged so a malformed message doesn't kill
  // the host's session.
  _mpApplyAction(msg, actor) {
    if (!msg || !this.isMultiplayer() || this.mp.role !== 'host') return;
    try {
      const findCardById = (id) => {
        const p = this.state[actor];
        if (p) {
          const inHand = (p.hand || []).find(c => c.id === id);
          if (inHand) return inHand;
        }
        return null;
      };
      const findTrickById = (id) => {
        const p = this.state[actor];
        if (p) return (p.trickHand || []).find(t => t.id === id);
        return null;
      };
      switch (msg.t) {
        case 'playCard': {
          const card = findCardById(msg.cardId);
          console.log('[MP HOST] playCard from guest: cardId=', msg.cardId, 'name=', card && card.name, 'lane=', msg.lane, '(0-based), visual lane:', msg.lane + 1, 'found:', !!card);
          if (card) {
            // If a lane-choice prompt is still armed for THIS card (the
            // guest's reqLaneChoice raced a direct playCard — e.g. one
            // client on stale code, or a double-send), clear it now so
            // the guest's "Choose a lane" banner dies with this broadcast
            // instead of dangling over an already-played card.
            const lc = this.state.pendingLaneChoice;
            if (lc && lc.previewCard && lc.previewCard.id === card.id) {
              this._clearPromptTimeout();
              this.state.pendingLaneChoice = null;
            }
            const placed = this.playCard(actor, card, msg.lane);
            // Surface SILENT host-side rejections so a guest's "card didn't
            // land where I clicked" is diagnosable instead of vanishing.
            if (placed === false) {
              const lane = this.state.lanes[msg.lane] || {};
              console.warn('[MP HOST] guest playCard REJECTED:', card && card.name,
                '→ lane', (msg.lane + 1),
                '| your-side slot occupied:', !!lane[actor],
                '| lane destroyed:', !!lane.destroyed,
                '| guest energy:', this.state[actor] && this.state[actor].currency,
                '| card cost:', card && card.cost);
            }
          } else {
            console.warn('[MP HOST] guest playCard: card id', msg.cardId, 'NOT FOUND in', actor, 'hand — nothing placed');
          }
          break;
        }
        case 'playCardFree': {
          const card = findCardById(msg.cardId);
          if (card) this.playCardFree(actor, card, msg.lane);
          break;
        }
        case 'playJump': {
          // Guest clicked a jump-ready card outside the combat modal.
          // Run playJumpCard on the host so lane selection is authoritative:
          // if multiple lanes are open, host sets pendingLaneChoice and
          // broadcasts; guest picks via the normal promptResolve lane flow.
          const jCard = (this.state[actor].hand || []).find(c => c.id === msg.cardId);
          if (jCard && jCard.jumpReady) this.playJumpCard(actor, jCard);
          else this.resumeCombatIfWaiting();
          break;
        }
        case 'reqLaneChoice': {
          // Guest selected a card from hand and wants to pick a lane.
          // Uses the same promptLaneChoice path as summons (proven working) so the
          // guest sees highlighted lane targets and sends promptResolve:lane back.
          const card = findCardById(msg.cardId);
          if (!card) break;
          if (card._neverPlayable) break; // Iron Giant — no picker, ever
          const phase = this.state.phase;
          if (phase !== 'ai-cards' && phase !== 'ai-cards-tricks') break;
          if (card.isDiscardEffect) { this.playCard(actor, card, 0); break; }
          const cost = this.getCardCost(actor, card);
          if (this.state[actor].currency < cost) break;
          // Candidate lanes — every open lane on the guest's side. The old
          // Moder/Magneto forced-lane narrowing was REMOVED here: Moder is a
          // roguelite-only (solo) boss and Magneto's redesign no longer forces
          // placements, so nothing in a 1v1 online match legitimately sets
          // forcedLane/magnetoForcedLanes. The narrowing could only ever fire
          // from STALE residue carried over from an abandoned solo match —
          // which collapsed openLanes to one entry and auto-played the guest's
          // card with no picker (the "guest can't choose their lane" bug).
          let openLanes;
          if (card.isEnvironment) {
            openLanes = this.state.lanes.map((l, i) => i).filter(i => !this.state.lanes[i].destroyed);
          } else {
            openLanes = this.getOpenLanes(actor);
          }
          if (!openLanes.length) break;
          if (openLanes.length === 1) {
            // Only one option — skip the picker, play directly. Log it so a
            // "my card auto-placed" report is diagnosable from the host console.
            console.log('[MP HOST] reqLaneChoice: single open lane', openLanes[0] + 1,
              'for', card.name, '— playing directly (no picker needed)');
            this.playCard(actor, card, openLanes[0]);
            break;
          }
          // Multiple lanes: promptLaneChoice broadcasts pendingLaneChoice to guest.
          // Guest picks via laneChoicePick → promptResolve:lane → playCard fires here.
          this.promptLaneChoice(actor, openLanes,
            `Play ${card.name}`,
            `Choose a lane for ${card.name}`,
            (lane) => {
              // Validate at RESOLVE time, not just arm time — if this card
              // already left the hand (played by a racing playCard message,
              // a stale client, or any other path), replaying it here would
              // duplicate it on the board. Drop the stale pick and let the
              // trailing broadcast resync the guest instead.
              if (!this.state[actor].hand.some(c => c.id === card.id)) {
                console.warn('[MP HOST] stale lane pick for', card.name, '— card no longer in hand, ignoring');
                return;
              }
              this.playCard(actor, card, lane);
            },
            actor, card);
          break;
        }
        case 'playTrick': {
          const trick = findTrickById(msg.trickId);
          if (trick && this.playTrick) this.playTrick(actor, trick);
          break;
        }
        case 'reqState': {
          // Guest asking for a (re)send of the authoritative state —
          // fired on a join that never received the first broadcast
          // (flaky data channel, dropped message). No mutation here;
          // the unconditional _mpBroadcast at the end of this function
          // is the answer. User report: guest paired but stuck on
          // "Dropping into the match…" while the host was in the draft.
          break;
        }
        case 'doneTurn': {
          // The guest hit Done — dispatch to the right phase-end based
          // on the current phase. Guest sends 'doneTurn' with no extra
          // payload; host's current phase determines what to advance.
          // (We don't trust the guest to tell us what phase is
          // active — host is authoritative on state.)
          const ph = this.state && this.state.phase;
          // Only honor a Done from the seat whose phase is actually active.
          // The guest's Done button stays clickable for a full round-trip, so
          // a double-tap would otherwise land in the NEXT phase (the host's own
          // turn) and end it — silently skipping the host's cards/tricks turn.
          const _seatPhases = actor === 'ai'
            ? ['ai-cards', 'ai-cards-tricks', 'ai-tricks']
            : ['player-cards', 'player-cards-tricks', 'player-tricks'];
          if (!_seatPhases.includes(ph)) break;
          if (ph === 'player-cards' || ph === 'ai-cards') {
            if (this.endPhase1) this.endPhase1();
          } else if (ph === 'player-cards-tricks' || ph === 'ai-cards-tricks') {
            if (this.endPhase2) this.endPhase2();
          } else if (ph === 'player-tricks' || ph === 'ai-tricks') {
            if (this.endPhase3) this.endPhase3();
          }
          break;
        }
        case 'draftPick': {
          // Guest's draft pick — they're picking from their own (the
          // 'ai' side's) draft choices on the host. `actor` here is
          // 'ai' since the guest sits on the AI seat from the host's
          // perspective. draftPick handles the 'who' arg correctly.
          if (this.draftPick) this.draftPick(msg.index, actor);
          break;
        }
        case 'draftMulligan': {
          // Guest requested a mulligan on their own choices (ai side on host).
          if (this.draftMulligan) this.draftMulligan(actor);
          break;
        }
        case 'mulligan': {
          if (this.mulligan) this.mulligan(actor);
          break;
        }
        case 'forfeit': {
          // Treat as instant loss for the actor.
          if (this.state[actor]) this.state[actor].health = 0;
          this.state.gameOver = true;
          this.state.winner = (actor === 'player') ? 'ai' : 'player';
          break;
        }
        case 'promptResolve': {
          // Guest resolved an ability prompt (card or lane choice). Apply on
          // the authoritative host state so the result is canonical, then
          // broadcast so both clients see the outcome.
          if (msg.choiceType === 'card') {
            const cc = this.state.pendingCardChoice;
            if (!cc) break;
            // The prompt must belong to the actor's seat. A stale guest resolve
            // (prompt already closed, or a host-owned prompt now pending) must
            // not consume a prompt it doesn't own with a wrong index.
            if (cc.owner !== actor) break;
            const idx = msg.idx;
            if (idx == null || !cc.cards[idx]) break;
            this._clearPromptTimeout();
            this.state.pendingCardChoice = null;
            if (cc.callback) cc.callback(cc.cards[idx]);
            this.cleanupDead();
            this.resumeCombatIfWaiting();
          } else if (msg.choiceType === 'lane') {
            const lc = this.state.pendingLaneChoice;
            if (!lc) break;
            if (lc.owner !== actor) break;
            // Validate the guest's lane index against the ALLOWED set before
            // invoking the callback — mirrors the card branch's !cc.cards[idx]
            // guard. The host is authoritative for guest choices, so a
            // tampered/desynced guest sending an out-of-range laneIdx (e.g. 7
            // with LANE_COUNT 6) would otherwise reach callbacks like Jigsaw's
            // `lanes[lane][owner] = ...` and crash/hang the host engine.
            if (msg.laneIdx == null || !lc.lanes || !lc.lanes.includes(msg.laneIdx)) break;
            this._clearPromptTimeout();
            this.state.pendingLaneChoice = null;
            if (lc.callback) lc.callback(msg.laneIdx);
            this.cleanupDead();
            this.resumeCombatIfWaiting();
          } else if (msg.choiceType === 'laneCancel') {
            // Guest deselected the hand card whose picker was armed — close
            // the prompt WITHOUT resolving. Only hand-play placements
            // (reqLaneChoice) are cancellable: the card must still be in the
            // actor's hand, so dropping the callback loses nothing. Summon
            // placements also carry a previewCard, but cancelling one would
            // strand the summoned card — the in-hand check excludes them.
            const lc = this.state.pendingLaneChoice;
            if (!lc) break;
            if (lc.owner !== actor) break;
            if (!lc.previewCard || lc.previewCard.id !== msg.cardId) break;
            if (!(this.state[actor].hand || []).some(c => c.id === msg.cardId)) break;
            this._clearPromptTimeout();
            this.state.pendingLaneChoice = null;
            this.resumeCombatIfWaiting();
          } else if (msg.choiceType === 'tsCounter' || msg.choiceType === 'tsAllow') {
            // Guest resolved a Time Stone reaction. Only the DEFENDING seat's
            // owner may decide — a stale/mischievous message from the caster
            // must not consume (or waive) the defender's counter.
            const ti = this.state.pendingTimeStoneIntercept;
            if (!ti) break;
            if ((ti.defender || 'player') !== actor) break;
            if (msg.choiceType === 'tsCounter') this.timeStoneCounter();
            else this.timeStoneAllow();
          } else if (msg.choiceType === 'jumpPlay') {
            const offer = this.state.pendingJumpOffer;
            if (!offer) break;
            this.state.pendingJumpOffer = null;
            const card = (this.state[actor].hand || []).find(c => c.id === offer.cardId);
            if (card && card.jumpReady) this.playJumpCard(actor, card);
            else this.resumeCombatIfWaiting();
          } else if (msg.choiceType === 'jumpSkip') {
            const offer = this.state.pendingJumpOffer;
            if (!offer) break;
            this.state.pendingJumpOffer = null;
            const card = (this.state[actor].hand || []).find(c => c.id === offer.cardId);
            if (card) { card.jumpReady = false; card.jumpLane = undefined; }
            this.resumeCombatIfWaiting();
          } else if (msg.choiceType === 'blockTrick') {
            const bt = this.state.pendingBlockTrick;
            if (!bt) break;
            // Ownership: the guest may only resolve a block trick they own —
            // matches the card/lane branches (was an unchecked gap: a guest
            // could resolve the host's block trick).
            if (this._promptOwnerSeat(bt, 'blockTrick') !== actor) break;
            this._clearPromptTimeout();
            this.state.pendingBlockTrick = null;
            const owner = bt._btOwner || actor;
            if (msg.play) {
              this.state[owner].playedTrickPile.push({ name: bt.name, cost: bt.cost });
              if (this.state._roundStats) this.state._roundStats.aiTricks.push(bt.name);
              // Host sees the guest's block-earned trick via the same reveal
              // theater (the guest's own screen gets it from the pile diff).
              if (typeof UI !== 'undefined' && UI.showTrickReveal) UI.showTrickReveal(bt.name, bt.desc || '', bt.cost, owner === 'player');
              if (bt.play) { try { bt.play(this, owner); } catch(e) { console.error(e); } }
              this.cleanupDead();
            } else {
              this.addToTrickHand(owner, bt);
            }
            this.resumeCombatIfWaiting();
          } else if (msg.choiceType === 'kang') {
            // Guest resolved Kang's "keep one card" choice. Apply on host.
            const kc = this.state.pendingKangChoice;
            if (!kc) break;
            // Ownership parity with card/lane — the guest may only resolve a
            // Kang choice they own (was an unchecked gap).
            if (this._promptOwnerSeat(kc, 'kang') !== actor) break;
            this._clearPromptTimeout();
            this.state.pendingKangChoice = null;
            const idx = msg.idx != null ? msg.idx : 0;
            const picked = kc.cards[idx];
            const other  = kc.cards[1 - idx];
            if (picked && other) {
              this.getDrawPile(kc.owner).push(other);
              const card = this.createCardInstance(picked, kc.owner);
              card.cost = Math.max(0, card.cost - 2);
              this.log(`  [KANG] Kept ${card.name} (cost reduced to ${card.cost})`);
              this.addToHand(kc.owner, card);
              this.state[kc.owner]._kangSkipDraw = true;
              if (card.cost <= 2 && !card.isDiscardEffect) {
                const open = card.isEnvironment
                  ? this.state.lanes.map((l, i) => i).filter(i => !this.state.lanes[i].destroyed)
                  : this.getOpenLanes(kc.owner);
                // Use promptLaneChoice so the guest gets to pick the lane
                // (matching the single-player kangChoicePick path). The MP guard
                // inside promptLaneChoice broadcasts pendingLaneChoice to the guest;
                // the guest sends promptResolve:lane and playCardFree fires there.
                if (open.length) {
                  this.promptLaneChoice(kc.owner, open,
                    `Play ${card.name} FREE`,
                    `Paul Atreides — place ${card.name} (cost ${card.cost}) in a lane`,
                    (lane) => { this.playCardFree(kc.owner, card, lane); });
                }
              }
            }
            this.cleanupDead();
            this.resumeCombatIfWaiting();
          }
          break;
        }
      }
    } catch (e) {
      console.error('mp apply action failed', msg, e);
    }
    // Push the new state to the guest unconditionally — even if the
    // action was a no-op, the guest expects an ack to know its
    // attempt landed.
    this._mpBroadcast();
    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },

  // Called by the joining client when the host pushes a state. The
  // incoming state has already been rehydrated (function refs reattached)
  // by Multiplayer._rehydrateState — we just swap it in and re-render.
  // The guest doesn't run any engine logic; its job is to display.
  //
  // Seat-flip: from the host's perspective, host=player and guest=ai.
  // For UI sanity (guest expects their own hand at the BOTTOM of the
  // screen, opponent's hand at the top — same as single-player), we
  // mirror the state on receive so guest's local view labels them as
  // 'player' and the host as 'ai'. Lane indices stay identical (lanes
  // are shared between both perspectives), only the per-lane player/ai
  // sub-pointers and per-card .owner fields flip.
  acceptMultiplayerState(state) {
    if (!this.mp.role) {
      // First state we receive lands us as guest. Locally we pretend
      // to be 'player' so the existing UI's seat assumptions all work.
      this.mp = { role: 'guest', you: 'player', opp: 'ai' };
    }
    // Preserve the guest's card/trick selection across host state pushes.
    // Each broadcast replaces Game.state entirely; without this, a card the
    // guest clicked (setting selectedCard) gets deselected the moment the
    // host sends any update (e.g. the previous play completing), requiring
    // a re-select and causing the subsequent lane click to silently no-op
    // because selectedCard is null. User sees the card "placed itself" on
    // the retry in whatever lane they accidentally hit second.
    const prevSelected     = this.state && this.state.selectedCard;
    const prevSelectedTrick = this.state && this.state.selectedTrick;

    if (this.mp.role === 'guest') state = this._mpFlipPerspective(state);
    this.state = state;
    // Authoritative push replaces every card object — reindex so findCard
    // resolves ids against the incoming instances, not the pre-push ones.
    this.rebuildEntityIndex();

    // Any selection in the pushed state belongs to the HOST's UI, not the
    // guest's — discard it unconditionally (it points at a card the guest
    // doesn't hold). Then restore the guest's OWN pick if it's still in hand.
    // Doing this regardless of the incoming value is what fixes the guest
    // "card auto-places into a stray lane" bug: the old `!selectedCard` guard
    // was bypassed whenever the host's selection leaked through.
    this.state.selectedCard = null;
    this.state.selectedTrick = null;
    if (prevSelected) {
      const stillInHand = (this.state.player && this.state.player.hand || [])
        .find(c => c.id === prevSelected.id);
      if (stillInHand) this.state.selectedCard = stillInHand;
    }
    if (prevSelectedTrick) {
      const stillInTrick = (this.state.player && this.state.player.trickHand || [])
        .find(t => t.id === prevSelectedTrick.id);
      if (stillInTrick) this.state.selectedTrick = stillInTrick;
    }
  },

  _mpFlipPerspective(state) {
    if (!state) return state;
    // Top-level player/ai swap.
    const tmp = state.player; state.player = state.ai; state.ai = tmp;
    // Per-lane player/ai swap.
    for (let i = 0; i < (state.lanes || []).length; i++) {
      const lane = state.lanes[i]; if (!lane) continue;
      const t = lane.player; lane.player = lane.ai; lane.ai = t;
    }
    // Flip card .owner fields so any code that reads card.owner (e.g.
    // ability targeting) still works on the guest's local view.
    const flip = (c) => {
      if (!c) return;
      if (c.owner === 'player') c.owner = 'ai';
      else if (c.owner === 'ai') c.owner = 'player';
    };
    for (let i = 0; i < (state.lanes || []).length; i++) {
      flip(state.lanes[i].player); flip(state.lanes[i].ai);
    }
    ['player', 'ai'].forEach(side => {
      const p = state[side]; if (!p) return;
      (p.hand || []).forEach(flip);
      (p.deadPile || []).forEach(flip);
      (p.drawPile || []).forEach(flip);
      (p.discardPile || []).forEach(flip);
    });
    (state.drawPile || []).forEach(flip);
    // FX stream events carry seat labels in the host's frame — flip them so
    // the guest's consumer (UI.showDamageFloats) reads its own perspective.
    if (state._fx && state._fx.events) {
      state._fx.events.forEach(ev => {
        if (ev.owner === 'player') ev.owner = 'ai';
        else if (ev.owner === 'ai') ev.owner = 'player';
      });
    }
    // Top-level turn/winner labels follow the swap.
    if (state.currentTurn === 'player') state.currentTurn = 'ai';
    else if (state.currentTurn === 'ai') state.currentTurn = 'player';
    if (state.winner === 'player') state.winner = 'ai';
    else if (state.winner === 'ai') state.winner = 'player';
    // ---- Phase-string seat swap (2026-05-19) ----
    // The phase names hard-encode whose seat is acting — e.g.
    // `player-cards`, `ai-cards`, `player-cards-tricks`,
    // `ai-cards-tricks`, `player-tricks`, `ai-tricks`. Without
    // flipping these on the guest, the guest's local view sees
    // (for example) `phase = 'ai-cards'` when the host has set
    // 'ai-cards' meaning "AI seat plays" — but from the guest's
    // perspective they ARE the AI seat and it's THEIR turn. The
    // UI reads `phase` to gate hand-click handlers (only allow
    // plays during the right phase), so without this flip the
    // guest couldn't actually play any cards — the host would
    // wait for guest input that the guest's own UI was blocking.
    // User report 2026-05-19: "we are not facing each other…
    // direct PvP where it's random who plays first and we just
    // take turns with NO AI." The AI logic IS correctly gated
    // off in multiplayer (the host doesn't auto-play for the
    // 'ai' seat); the missing piece was the guest's UI couldn't
    // tell it was their turn.
    //
    // `firstPlayer`, `oddPlayer`, and other seat-label fields
    // also get swapped here for parity — anywhere the UI / game
    // logic reads "who is X" should be consistent post-flip.
    if (typeof state.phase === 'string') {
      if (state.phase.startsWith('player-')) state.phase = 'ai-' + state.phase.slice(7);
      else if (state.phase.startsWith('ai-')) state.phase = 'player-' + state.phase.slice(3);
    }
    if (state.firstPlayer === 'player') state.firstPlayer = 'ai';
    else if (state.firstPlayer === 'ai') state.firstPlayer = 'player';
    if (state.oddPlayer === 'player') state.oddPlayer = 'ai';
    else if (state.oddPlayer === 'ai') state.oddPlayer = 'player';
    if (state.activePlayer === 'player') state.activePlayer = 'ai';
    else if (state.activePlayer === 'ai') state.activePlayer = 'player';
    // Per-side stats blob (block triggers, peakRoundDamage, kills, etc.)
    // — swap so each side's UI dashboard reads its own numbers.
    if (state._stats) {
      const _tStat = state._stats.player;
      state._stats.player = state._stats.ai;
      state._stats.ai = _tStat;
    }
    // Hero avatar chips follow their seats through the flip.
    if (state._avatars) {
      const _tAv = state._avatars.player;
      state._avatars.player = state._avatars.ai;
      state._avatars.ai = _tAv;
    }
    // Pending-choice owner/targetSide labels — when the host
    // emits a prompt, the OWNER (who needs to pick) is encoded as
    // 'player' or 'ai' from the host's perspective. Flip to the
    // guest's perspective so the guest's UI shows the prompt to
    // the right side. Skipped silently when no pending choice
    // is active.
    const flipSeat = (s) => s === 'player' ? 'ai' : s === 'ai' ? 'player' : s;
    if (state.pendingCardChoice) {
      const pc = state.pendingCardChoice;
      pc.owner = flipSeat(pc.owner);
      pc.targetSide = flipSeat(pc.targetSide);
    }
    if (state.pendingLaneChoice) {
      const lc = state.pendingLaneChoice;
      lc.owner = flipSeat(lc.owner);
      lc.targetSide = flipSeat(lc.targetSide);
    }
    if (state.pendingBlockTrick) {
      const bt = state.pendingBlockTrick;
      if (bt.owner) bt.owner = flipSeat(bt.owner);
      if (bt._btOwner) bt._btOwner = flipSeat(bt._btOwner);
    }
    if (state.pendingTimeStoneIntercept) {
      const ts = state.pendingTimeStoneIntercept;
      ts.incomingOwner = flipSeat(ts.incomingOwner);
      ts.defender = flipSeat(ts.defender || 'player');
    }
    if (state.pendingKangChoice) {
      state.pendingKangChoice.owner = flipSeat(state.pendingKangChoice.owner);
    }
    if (state._mpNames) {
      const t = state._mpNames.player;
      state._mpNames.player = state._mpNames.ai;
      state._mpNames.ai = t;
    }
    // ---- Draft-state perspective swap (2026-05-19) ----
    // Without this, both players see the HOST's draft picks in
    // their own "your choices" slot — i.e. one shared draft room
    // instead of each player picking from their own offers. User
    // report: "we get into the same draft room… there needs to be 2
    // separate draft rooms but drafting from the same deck just
    // how AI vs a player would be."
    //
    // The architecture already supports independent picking
    // (presentDraftChoices skips the auto-AI-pick in multiplayer,
    // draftPick advances only when both sides have committed, and
    // the guest's pick forwards to the host as 'draftPick'). The
    // ONLY missing piece was this swap on the guest's local state
    // copy — host's `aiChoices` IS the guest's "your choices."
    //
    // Choices and drafted lists swap; the shared holding pools and
    // history snapshots don't (cardHolding / trickHolding are a
    // single pool of leftovers both sides draw from; history is a
    // local undo stack and undo is disabled in multiplayer
    // anyway). pickedThisRound, mulliganUsed, phase, round are
    // perspective-neutral.
    const d = state.draft;
    if (d) {
      const swap = (a, b) => { const t = d[a]; d[a] = d[b]; d[b] = t; };
      swap('playerChoices',       'aiChoices');
      swap('playerDrafted',       'aiDrafted');
      swap('playerTrickDrafted',  'aiTrickDrafted');
      swap('playerMulliganUsed',  'aiMulliganUsed');
    }
    // Never expose the host's selected card to the guest — it leaks
    // information about which card the opponent has highlighted. Clear
    // both so acceptMultiplayerState always restores the guest's own
    // selection from prevSelected rather than inheriting the host's.
    state.selectedCard = null;
    state.selectedTrick = null;
    return state;
  },

  // Helper for the host to push state to the guest. Wraps the
  // serialize step (drop functions, convert object refs to ids) and
  // delegates to whichever transport is active. Called whenever the
  // host applies an action — keeps the guest in sync with no extra
  // bookkeeping at call sites.
  _mpBroadcast() {
    if (!this.isMultiplayer() || this.mp.role !== 'host') return;
    // _silentSim guard: previewPlacement()/previewPlay() swap this.state to a
    // deep clone (stamped _silentSim) and call playCard/resolveLanes on it to
    // compute the damage preview. Those methods are wrapBroadcast-wrapped, so
    // without this guard every preview the host renders would broadcast the
    // HYPOTHETICAL placement to the guest — the opponent saw whatever card the
    // host was hovering appear in a lane before it was ever committed. A dry
    // run must never touch the wire; the real broadcast fires when the host
    // actually plays (this.state is the live state, _silentSim unset).
    if (this.state && this.state._silentSim) return;
    if (typeof Multiplayer === 'undefined') return;
    const t = Multiplayer._transport;
    if (!t || typeof t.broadcastState !== 'function') return;
    const clone = Multiplayer.serializeState(this.state);
    try { t.broadcastState(clone); } catch (e) { console.error('mp broadcast error', e); }
  },

  init() {
    // Initial boot — show the main menu. Actual match setup (buildDecks,
    // draft) runs in startMatch() after the user picks a mode from the
    // PLAY sub-screen. Headless sim harnesses call startMatch('classic')
    // directly without going through the UI, so init() doesn't build
    // decks here.
    this._promptQueue = [];            // deferred prompt arms never cross a boot
    this._drainingPromptQueue = false;
    this._stackClear('init');          // stack events never cross a boot either
    this._stackHighWater = 0;
    if (this._entities) this._entities.clear();  // ids reset below → drop stale cross-match entries so findCard can't return a previous game's card
    this.LANE_COUNT = 6;  // reset to 1v1 default; 2v2 entry points override to 8 AFTER init() (never before — this line clobbers it)
    nextCardId = 1;
    this.state = {
      phase: 'main-menu',
      // mode: { players: '1v1'|'2v2', deck: 'classic'|'deckbuilder' }
      // Stays null until the user picks one; the sim sets it to classic.
      mode: null,
      round: 0,
      draft: null, // populated in startMatch
      oddPlayer: Math.random() < 0.5 ? 'player' : 'ai',
      firstPlayer: null,
      activePlayer: null,
      // SHARED draw piles (Classic). Deckbuilder mode will additionally
      // populate per-player piles in phase 2.
      drawPile: [],
      trickDrawPile: [],
      voidPile: [],       // devoured cards — cannot be recovered
      player: Object.assign(this.makePlayer(), { isHuman: true }),
      ai: Object.assign(this.makePlayer(), { isHuman: false }),
      lanes: Array.from({ length: this.LANE_COUNT }, () => ({ player: null, ai: null, _env: null, destroyed: false, destroyedTurns: 0, protected: null, trap: null })),
      selectedCard: null, selectedTrick: null,
      log: [], gameOver: false, winner: null,
      // FX event stream (see emitFX) — created eagerly so the UI cursor syncs
      // to seq 0 before the first emit; a lazy-created ring would swallow the
      // match's first event during the mid-stamp resync.
      _fx: { seq: 0, events: [], mid: Date.now() + ':' + Math.floor(Math.random() * 1e6) },
      _stats: {
        player: { blockTriggers: 0, peakRoundDamage: 0, cardsKilled: 0, energySpent: 0 },
        ai:     { blockTriggers: 0, peakRoundDamage: 0, cardsKilled: 0, energySpent: 0 },
      }
    };
    UI.render();
  },

  // Entry point for "Deckbuilder" from the mode picker — opens the
  // deck-builder screen so the user can build / pick a deck before the
  // match starts. The sim never goes through this path (it jumps straight
  // to startMatch with the default starter deck).
  enterDeckBuilder(seed) {
    this.state.phase = 'deckbuilder-build';
    this.state.mode = { players: '1v1', deck: 'deckbuilder' };
    // In-progress deck the UI mutates as the user adds / removes cards.
    // Starts empty unless a seed { cards, tricks, presetName? } is passed
    // in (used by My Decks → Edit to preload a saved deck).
    this.state.deckbuilder = seed
      ? { cards: (seed.cards || []).slice(), tricks: (seed.tricks || []).slice(), presetName: seed.presetName || null }
      : { cards: [], tricks: [], presetName: null };
    // Restore last-used filter state (section / cost / search query)
    // from localStorage so the deckbuilder reopens to where the user
    // left off, not to a generic "Cards · All" default. Pure UX
    // refinement; no game-state impact.
    if (typeof UI !== 'undefined' && UI._persistGet) {
      const savedFilter = UI._persistGet('deckbuilder', null);
      if (savedFilter && typeof savedFilter === 'object') {
        UI._dbFilter = Object.assign(
          { section: 'cards', cost: 'all', query: '', sort: 'cost' },
          savedFilter
        );
      }
    }
    UI.render();
  },

  // ---- Main-menu navigation (phase 4a) ----
  // Light helpers that just flip phase + clear transient state, so the
  // render router can route to the right overlay. Everything else
  // (styling, content) lives in UI.render* methods.
  // Clear multiplayer seat state on any return to a non-MP context. Without
  // this, mp.role stays 'host'/'guest' after a match, so every later SOLO
  // playCard/endPhase hits the host/guest guards and posts actions into a
  // dead transport — cards never land and the AI never moves until reload.
  resetMultiplayer() {
    this.mp = { role: null, you: null, opp: null };
  },
  goToMainMenu() {
    this.resetMultiplayer();
    // Abandon any in-flight match: bump the generation so queued combat/AI/
    // game-over timers bail instead of resuming over the menu, and cancel the
    // ability-prompt auto-pick timeout that would otherwise fire into a dead board.
    this._matchGen++;
    if (this._promptTimeout) { clearTimeout(this._promptTimeout); this._promptTimeout = null; }
    this._clearCombatWatchdog();
    this.state.phase = 'main-menu';
    this.state.mode = null;
    this.state.deckbuilder = null;
    // Entering the menu fresh always lands on the main list, not a stale
    // in-place submenu (e.g. Solo Match's sub-options) left over from before.
    if (typeof UI !== 'undefined') UI._mmSub = null;
    UI.render();
  },
  goToModeSelect() {
    this.state.phase = 'mode-select';
    UI.render();
  },
  goToMyDecks() {
    this.state.phase = 'my-decks';
    UI.render();
  },
  goToStats() {
    this.state.phase = 'stats';
    UI.render();
  },

  // ---- Stats telemetry (phase 4c, v2) ----
  // Writes per-card stats for the just-finished game to localStorage.
  // Guards: skipped in the headless sim (no localStorage) and skipped if
  // the user opted out in Settings. Draws are skipped — they don't tell
  // us anything about card balance.
  //
  // v2 adds:
  //  • gamesInDeck (unique, vs `drafts` which counts copies)
  //  • contributionSum/N (per-game share of side impact; cost-agnostic)
  //  • weighted-impact components (hp, card, absorbed, energy, advantage)
  //  • action counters (kills/freezes/stuns/fears/mc/draws)
  finalizeStats() {
    if (typeof localStorage === 'undefined') return;
    if (typeof UI === 'undefined' || !UI._statsGet) return;
    if (UI.settings && UI.settings.trackStats === false) return;
    const s = this.state;
    const winner = s.winner;
    if (!winner) return;

    const store = UI._statsGet();
    store.__meta.gamesPlayed = (store.__meta.gamesPlayed || 0) + 1;
    store.__meta.lastPlayed = Date.now();
    // Running total of rounds across all tracked games — divided by
    // gamesPlayed at render time to show the average game length next to
    // the total-games counter in the Stats header.
    store.__meta.totalRounds = (store.__meta.totalRounds || 0) + (s.round || 0);

    // Weighted impact v7 — sabermetrics refactor. Two key shifts:
    //   1. Face damage and board damage have DIFFERENT weights since
    //      face damage wins the game directly (lane-based PvZ Heroes-
    //      style — winning the hero is everything).
    //   2. Healing uses a leverage-multiplied stat (statsHealLeveraged)
    //      computed at heal time based on the healer's HP%, so clutch
    //      heals score higher than "topping off" heals.
    //   3. Kill value is now just kill TEMPO (sum of victim baseCost) —
    //      damage that did the killing already counts in face/board
    //      damage; double-counting was inflating destroy effects.
    //   4. damageDenied = absorbed (existing freeze phantom-swing
    //      attribution + armor/evade/invincible attributions are all
    //      already credited to statsDamageAbsorbed; just re-weighted).
    //   5. Card draw rolls into advantage but with a runtime-computed
    //      avgCardImpact multiplier (per-game) so deck synergy matters.
    // Must stay in sync with UI._IMPACT_WEIGHTS and SimStats `W`.
    const WEIGHTS = {
      // 20K-sim sabermetric audit found Spider-Man (2.73× idx, 50.7% WR)
      // and The Flash (2.29× idx, 50.8% WR) bloating impact via Splash
      // chip damage that didn't translate to wins. Dropping boardDamage
      // from 0.6 → 0.4 deflates "splash spammers without face presence"
      // and lets face-damage carriers (Anakin / Trigon / Galactus) climb
      // the impact ranking where they belong. Tested at 20K games.
      faceDamage:   1.2,   // statsHealthbarDamage — wins the game directly
      boardDamage:  0.4,   // statsEnemyDamage — chip / softening, not lethal
      energy:       2.0,   // 1 energy ≈ 2 damage downstream + compounds
      discount:     1.5,   // future energy with slight conditionality discount
      damageDenied: 0.9,   // statsDamageAbsorbed (armor/evade/invincible/freeze phantom)
      debuff:       0.7,   // ATK/HP stripped from enemies
      heal:         1.0,   // statsHealLeveraged is already leverage-multiplied
      killTempo:    1.0    // baseCost of cards destroyed (no damage double-count)
    };
    // Compute avgCardImpact PER GAME so card-draw value scales with the
    // current deck's actual quality. Run a first pass collecting raw
    // impact (without the cardAdvantage component to avoid recursion),
    // average across real-card instances, then use that as the per-card-
    // drawn multiplier.
    const baseImpact = (c) =>
      WEIGHTS.faceDamage   * (c.statsHealthbarDamage || 0) +
      WEIGHTS.boardDamage  * (c.statsEnemyDamage     || 0) +
      WEIGHTS.energy       * (c.statsEnergyGenerated || 0) +
      WEIGHTS.discount     * (c.statsDiscountValue   || 0) +
      WEIGHTS.damageDenied * (c.statsDamageAbsorbed  || 0) +
      WEIGHTS.debuff       * (c.statsDebuffValue     || 0) +
      WEIGHTS.heal         * (c.statsHealLeveraged   || 0) +
      WEIGHTS.killTempo    * (c.statsKillTempo       || c.statsKillValue || 0);
    const weighted = (c) => {
      const draws = c.statsCardAdvantage || 0;
      // Card draws weighted by per-game avgCardImpact × 0.85 ("in hand"
      // discount — drawn ≠ played). avgCardImpact is set during the
      // sweep below; before that, use the boardDamage fallback so the
      // first pass produces sensible numbers.
      const drawValue = draws * (this._avgCardImpact || 5) * 0.85;
      return baseImpact(c) + drawValue;
    };

    // Per-side MVP + side-total weighted impact (for contribution share).
    // Skip TOKEN instances — names not in CARD_DEFS (Undead Warrior,
    // Doombot, Ant, Null, Parademon, Loki Clone, The Kraken,
    // etc.). Their stats are already credited up-chain via _creditChain
    // and counting the tokens themselves would double-attribute damage
    // AND pollute the stats table with rows for undraftable cards.
    // Real-card instances that arrived via tricks (Bat Signal pulling
    // Ant-Man, Super Soldier Serum transforming into Thanos) DO count —
    // the trick brought a real card to the board and its performance
    // is what we want to measure.
    const validCardNames = new Set((typeof CARD_DEFS !== 'undefined' ? CARD_DEFS : []).map(d => d.name));
    const isRealCard = (c) => c && validCardNames.has(c.name);
    const sides = ['player', 'ai'];
    const perSideInstances = {};
    const perSideMvp = {};        // Aaron Judge — highest raw impact
    const perSideMvpPlus = {};    // Mike Trout — highest MVP+ rate stat
    const perSideTotal = {};
    // First pass: collect all real-card instances + their BASE impact
    // (excluding card-advantage which uses avgCardImpact below).
    const allInstances = [];
    sides.forEach(side => {
      const boardDead = this.getAllCardsOf(side).concat(s[side].deadPile || []);
      const discardLive = (s[side].discardPile || []).map(c => c._sourceInstance || c);
      const rawInstances = boardDead.concat(discardLive);
      const instances = rawInstances.filter(isRealCard);
      perSideInstances[side] = instances;
      allInstances.push(...instances);
    });
    // Compute per-game avgCardImpact = mean base-impact across all real
    // cards. Used to weight `cardAdvantage` (cards drawn) so decks with
    // strong synergy reward draw effects more. Falls back to 5 when
    // there are no instances yet (shouldn't happen post-game).
    const baseImpactSum = allInstances.reduce((sum, c) => sum + baseImpact(c), 0);
    this._avgCardImpact = allInstances.length > 0
      ? Math.max(2, baseImpactSum / allInstances.length)
      : 5;
    // Second pass: full weighted score (now with card-draw bonus) +
    // pick BOTH MVPs per side (raw Impact + MVP+ rate).
    sides.forEach(side => {
      let topImpact = null, topImpactScore = -1;
      let topPlus = null, topPlusScore = -1;
      let total = 0;
      perSideInstances[side].forEach(c => {
        const w = weighted(c);
        total += w;
        if (w > topImpactScore) { topImpactScore = w; topImpact = c; }
        // MVP+ = (impact / baseCost). Skip 0-cost cards (free reactions
        // like Time Stone) — dividing by 0 would post Infinity. Cards
        // with cost ≥ 1 only.
        const cost = c.baseCost || c.cost || 0;
        if (cost >= 1) {
          const rate = w / cost;
          if (rate > topPlusScore) { topPlusScore = rate; topPlus = c; }
        }
      });
      perSideMvp[side] = topImpact;
      perSideMvpPlus[side] = topPlus;
      perSideTotal[side] = total;
    });
    // League-average impact-per-cost — used to normalize MVP+ to a
    // 100-baseline scale ("100 = average, 200 = bomb"). Computed across
    // the current game's real-card instances rather than baked-in so
    // the rating self-calibrates per match. Once the stats dashboard
    // has historical data, swap this for a localStorage average.
    let leagueRates = [];
    allInstances.forEach(c => {
      const cost = c.baseCost || c.cost || 0;
      if (cost >= 1) leagueRates.push(weighted(c) / cost);
    });
    const leagueAvgImpactPerCost = leagueRates.length > 0
      ? Math.max(0.5, leagueRates.reduce((a, b) => a + b, 0) / leagueRates.length)
      : 5;
    // Stash on state so UI / dashboard can read it for display.
    s._mvpPlusBaseline = leagueAvgImpactPerCost;
    s._mvpDual = {
      player: perSideMvp.player ? {
        impactCard: perSideMvp.player.name,
        impactScore: weighted(perSideMvp.player),
        mvpPlusCard: perSideMvpPlus.player ? perSideMvpPlus.player.name : null,
        mvpPlus: perSideMvpPlus.player
          ? Math.round((weighted(perSideMvpPlus.player) / (perSideMvpPlus.player.baseCost || perSideMvpPlus.player.cost || 1)) / leagueAvgImpactPerCost * 100)
          : null
      } : null,
      ai: perSideMvp.ai ? {
        impactCard: perSideMvp.ai.name,
        impactScore: weighted(perSideMvp.ai),
        mvpPlusCard: perSideMvpPlus.ai ? perSideMvpPlus.ai.name : null,
        mvpPlus: perSideMvpPlus.ai
          ? Math.round((weighted(perSideMvpPlus.ai) / (perSideMvpPlus.ai.baseCost || perSideMvpPlus.ai.cost || 1)) / leagueAvgImpactPerCost * 100)
          : null
      } : null
    };

    // Decks per side — for `drafts` (by-copy) + `gamesInDeck` (unique).
    const startersFallback = (typeof STARTER_DECKS !== 'undefined') ? STARTER_DECKS.balanced : { cards: [], tricks: [] };
    const isDb = s.mode && s.mode.deck === 'deckbuilder';
    const sideDeck = {
      player: isDb
        ? (s.mode.customDeck ? s.mode.customDeck.cards : startersFallback.cards)
        : (s.draft ? s.draft.playerDrafted.map(d => d.name) : []),
      ai: isDb
        ? startersFallback.cards
        : (s.draft ? s.draft.aiDrafted.map(d => d.name) : [])
    };
    const sideTrickDeck = {
      player: isDb
        ? (s.mode.customDeck ? s.mode.customDeck.tricks : startersFallback.tricks)
        : (s.draft ? s.draft.playerTrickDrafted.map(d => d.name) : []),
      ai: isDb
        ? startersFallback.tricks
        : (s.draft ? s.draft.aiTrickDrafted.map(d => d.name) : [])
    };

    // Lazy record initializers — every new field defaults to 0 so the
    // dashboard can always read it unconditionally.
    const bumpCard = (name, key, amt) => {
      const rec = store.cards[name] || (store.cards[name] = {
        drafts: 0, draftsInWin: 0, gamesInDeck: 0, gamesInDeckInWin: 0,
        gamesPlayed: 0,
        plays: 0, deaths: 0,
        hpDamage: 0, cardDamage: 0, absorbed: 0, energyGen: 0, cardAdvantage: 0,
        healing: 0, discount: 0, debuff: 0,
        // v7 sabermetrics fields — leveraged heal + tempo-based kill
        // value. Old `healing` and `killValue` retained for back-compat
        // with persisted dashboards; new entries get both.
        healLeveraged: 0, killTempo: 0, killValue: 0,
        // Damage-denied breakdown — five discrete prevention types
        // that sum to `absorbed`. Lets the dashboard render per-type
        // stat rows so the player can see what kind of defense each
        // card actually provided.
        absorbArmor: 0, absorbInvincible: 0, absorbEvade: 0,
        absorbRedirect: 0, absorbLockdown: 0, absorbShield: 0,
        mvp: 0, mvpPlus: 0, mvpPlusBest: 0,
        contributionSum: 0, contributionN: 0,
        kills: 0, freezesApplied: 0, stunsApplied: 0, fearsApplied: 0, mcApplied: 0
      });
      rec[key] = (rec[key] || 0) + (amt || 0);
    };
    const bumpTrick = (name, key, amt) => {
      const rec = store.tricks[name] || (store.tricks[name] = { drafts: 0, draftsInWin: 0, casts: 0 });
      rec[key] = (rec[key] || 0) + (amt || 0);
    };

    // gamesPlayed dedupes across sides within a single game — bumped once
    // per unique card NAME regardless of how many instances hit the board.
    const appearedThisGame = {};
    sides.forEach(side => {
      const won = winner === side;
      const total = perSideTotal[side] || 0;
      // Drafts — every copy of every card in the deck list.
      const unique = new Set();
      (sideDeck[side] || []).forEach(name => {
        bumpCard(name, 'drafts', 1);
        if (won) bumpCard(name, 'draftsInWin', 1);
        unique.add(name);
      });
      // gamesInDeck — once per unique name, regardless of copy count.
      unique.forEach(name => {
        bumpCard(name, 'gamesInDeck', 1);
        if (won) bumpCard(name, 'gamesInDeckInWin', 1);
      });
      (sideTrickDeck[side] || []).forEach(name => {
        bumpTrick(name, 'drafts', 1);
        if (won) bumpTrick(name, 'draftsInWin', 1);
      });
      perSideInstances[side].forEach(c => {
        bumpCard(c.name, 'plays', 1);
        if (c.currentHealth <= 0 || c._deathHandled) bumpCard(c.name, 'deaths', 1);
        bumpCard(c.name, 'hpDamage',       c.statsHealthbarDamage || 0);
        bumpCard(c.name, 'cardDamage',     c.statsEnemyDamage     || 0);
        bumpCard(c.name, 'absorbed',       c.statsDamageAbsorbed  || 0);
        bumpCard(c.name, 'energyGen',      c.statsEnergyGenerated || 0);
        bumpCard(c.name, 'cardAdvantage',  c.statsCardAdvantage   || 0);
        // v3 captures
        bumpCard(c.name, 'healing',        c.statsHealingDone     || 0);
        bumpCard(c.name, 'discount',       c.statsDiscountValue   || 0);
        bumpCard(c.name, 'debuff',         c.statsDebuffValue     || 0);
        // v7 sabermetrics — leveraged heal + tempo-based kill
        bumpCard(c.name, 'healLeveraged',  c.statsHealLeveraged   || 0);
        bumpCard(c.name, 'killTempo',      c.statsKillTempo       || c.statsKillValue || 0);
        bumpCard(c.name, 'killValue',      c.statsKillValue       || 0);
        // Damage-denied breakdown — sum of these 6 = `absorbed`.
        bumpCard(c.name, 'absorbArmor',      c.statsAbsorbArmor      || 0);
        bumpCard(c.name, 'absorbInvincible', c.statsAbsorbInvincible || 0);
        bumpCard(c.name, 'absorbEvade',      c.statsAbsorbEvade      || 0);
        bumpCard(c.name, 'absorbRedirect',   c.statsAbsorbRedirect   || 0);
        bumpCard(c.name, 'absorbLockdown',   c.statsAbsorbLockdown   || 0);
        bumpCard(c.name, 'absorbShield',     c.statsAbsorbShield     || 0);
        bumpCard(c.name, 'kills',          c.statsKills           || 0);
        bumpCard(c.name, 'freezesApplied', c.statsFreezesApplied  || 0);
        bumpCard(c.name, 'stunsApplied',   c.statsStunsApplied    || 0);
        bumpCard(c.name, 'fearsApplied',   c.statsFearsApplied    || 0);
        bumpCard(c.name, 'mcApplied',      c.statsMcApplied       || 0);
        if (total > 0) {
          const share = weighted(c) / total;
          bumpCard(c.name, 'contributionSum', share);
          bumpCard(c.name, 'contributionN', 1);
        }
        // gamesPlayed: once per name per game, dedupes across sides.
        if (!appearedThisGame[c.name]) {
          appearedThisGame[c.name] = true;
          bumpCard(c.name, 'gamesPlayed', 1);
        }
      });
      // Trick casts — from playedTrickPile.
      (s[side].playedTrickPile || []).forEach(t => bumpTrick(t.name, 'casts', 1));
      // MVP — winning side's top-weighted-impact card gets credit.
      if (won && perSideMvp[side]) bumpCard(perSideMvp[side].name, 'mvp', 1);
    });

    UI._statsSet(store);
  },

  // Start a match after the user picks a mode. Accepts either a mode string
  // ('classic' — backwards-compat shortcut the sim uses) or a full
  // { players, deck, customDeck? } object. Populates the draft state and
  // kicks off the normal draft → play → combat cycle.
  //
  // `customDeck` { cards: [name,...], tricks: [name,...] } lets the
  // deck-builder UI feed the player's finished deck in — buildDecks
  // picks it up when present and falls back to STARTER_DECKS.balanced
  // (for AI and for the sim) otherwise.
  startMatch(mode) {
    if (typeof mode === 'string') mode = { players: '1v1', deck: mode };
    if (!mode) mode = { players: '1v1', deck: 'classic' };
    // New match — queued prompt arms from the previous match must not fire
    // into this one (startMatch reuses this.state without init()).
    this._promptQueue = [];
    this._drainingPromptQueue = false;
    this._stackClear('startMatch');
    this._stackHighWater = 0;
    // New match — invalidate any timers still queued from a previous one
    // (startMatch reuses this.state in place, so stale combat/AI callbacks
    // would otherwise run against the new board).
    this._matchGen++;
    // Seed the match RNG so EVERY match is reproducible from its seed
    // (replay + fuzz). startSeededRun sets _seedLocked to keep its explicit
    // seed; otherwise generate a fresh random one and record it. The MP guest
    // inherits the host's seed via the state broadcast, so we only seed on the
    // authoritative side (host/solo).
    if (!this._seedLocked && !(this.isMultiplayer && this.isMultiplayer() && this.mp.role === 'guest')) {
      this.seedMatch((Math.random() * 0xFFFFFFFF) >>> 0);
      if (typeof console !== 'undefined') console.log('[SEED] match seed =', this.state._seed);
    }
    // Re-derive the first-player coin flip from the seeded stream (it was set
    // at init via Math.random, before any seed existed) — so a replay/fuzz of
    // this seed opens the same way. Guest inherits it via the broadcast.
    if (!(this.isMultiplayer && this.isMultiplayer() && this.mp.role === 'guest') && this.state._rngState != null) {
      this.state.oddPlayer = this.rng() < 0.5 ? 'player' : 'ai';
      // Auto-record the match (host/solo) so every game is replayable — the
      // seed + command log is exportable at any time via Game.exportReplay().
      this.startReplayRecording();
    }
    this.state.mode = mode;
    // 1v1 local pass-and-play — both seats are humans on one device.
    // Set here (not just in startLocal1v1) so rematch() reconstitutes
    // the mode from its captured config without extra wiring.
    if (mode.hotseat) {
      this.state.hotseat = true;
      if (this.state.player) this.state.player.isHuman = true;
      if (this.state.ai) this.state.ai.isHuman = true;
      this.state._mpNames = { player: 'Player 1', ai: 'Player 2' };
    } else {
      // Seat hygiene for every NON-hotseat match. startMatch reuses
      // this.state without re-running init(), so a prior hotseat or
      // multiplayer match leaves ai.isHuman=true (and state.hotseat)
      // behind — the AI then plays its own cards but its ABILITY
      // prompts route to the human. User report: "the AI played Venom
      // and my buddy got to choose who to freeze... then the AI
      // blocked and my buddy got to choose how to play the trick."
      this.state.hotseat = false;
      if (!this.isMultiplayer()) {
        if (this.state.player) this.state.player.isHuman = true;
        if (this.state.ai) this.state.ai.isHuman = false;
        this.state._mpNames = null;
      }
    }
    // Every startMatch mode is a 1v1 six-lane match (2v2 has its own
    // entry points that never come through here). A finished 2v2 leaves
    // LANE_COUNT=8 and an 8-slot lanes array behind — without this reset
    // the next solo/MP match plays on a phantom 8-lane board.
    if (this.LANE_COUNT !== 6 || (this.state.lanes || []).length !== 6) {
      this.LANE_COUNT = 6;
      this.state.lanes = Array.from({ length: 6 }, () => ({
        player: null, ai: null, _env: null, destroyed: false, destroyedTurns: 0, protected: null, trap: null,
      }));
    }
    this.state.twoVTwo = null;
    // Two flavors of deckbuilder mode:
    //   • mode.withDraft === true  → run the full draft phase, but draw
    //     from the player's customDeck instead of the global pool.
    //     Used by My Decks "Play" so saved decks still go through
    //     the draft experience. User spec: "for my decks can you
    //     still incorporate the whole draft phase".
    //   • default (no withDraft)   → skip draft, deal directly from
    //     the saved deck (legacy deckbuilder flow / sim).
    if (mode.deck === 'deckbuilder' && !mode.withDraft) {
      this.state.phase = 'deckbuilder-start';
      this.state.draft = null;
      this.buildDecks();
      this.dealDeckbuilderOpeningHands();
      // Roguelite hooks: optional HP overrides per encounter so a node
      // can dial AI HP up (boss = 80, elite = +10, normal combat = 25-35)
      // and the player keeps their run HP across fights instead of
      // resetting to 30 every match.
      if (mode.playerHp != null) {
        this.state.player.health = mode.playerHp;
        this.state.player.maxHealth = mode.playerMaxHp || mode.playerHp;
      }
      if (mode.aiHp != null) {
        this.state.ai.health = mode.aiHp;
        this.state.ai.maxHealth = mode.aiHp;
      }
      // Roguelite difficulty override — engine reads UI.settings.difficulty
      // for AI behavior. Cache the prior value so we restore it after.
      if (mode.aiDifficulty && typeof UI !== 'undefined' && UI.settings) {
        this._priorDifficulty = UI.settings.difficulty;
        UI.settings.difficulty = mode.aiDifficulty;
      }
      this.log('[DECKBUILDER] Decks shuffled — starting hands dealt.');
      this.startRound();
      UI.render();
      return;
    }
    // Classic AND deckbuilder-with-draft path. buildDecks already
    // branches on mode.deck, so per-player piles are wired up for
    // the deckbuilder variant; presentDraftChoices reads from
    // getDrawPile('player') which returns the right pile in each
    // mode. The draft UX is identical from here.
    this.state.phase = 'draft-cards';
    this.state.draft = {
      round: 1, phase: 'cards',
      playerChoices: [], aiChoices: [],
      playerDrafted: [], aiDrafted: [],
      playerTrickDrafted: [], aiTrickDrafted: [],
      cardHolding: [], trickHolding: [],
      // One mulligan per draft phase — resets when tricks phase starts.
      mulliganUsed: false
    };
    this.buildDecks();
    if (mode.deck === 'deckbuilder' && mode.withDraft) {
      this.log('[MY DECKS] Drafting from your saved deck — same draft flow as Classic.');
    }
    this.presentDraftChoices();
    UI.render();
  },

  makePlayer() {
    return {
      // isHuman — controls whether ability prompts ("pick an ally to buff",
      // "choose a lane to move to") raise a modal or auto-pick via AI logic.
      // Single-player: player=true, ai=false (default, set by init()).
      // Multiplayer: both true (both seats are humans, both get prompts).
      // Sim/headless: both false (shim overrides to force AI-branch in all
      // abilities, which gives symmetric behavior for balance measurement).
      isHuman: false,
      health: 30, maxHealth: 30, currency: 0,
      hand: [], trickHand: [],
      deadPile: [],       // cards that died on board
      discardPile: [],    // cards discarded from hand
      playedTrickPile: [], // tricks that were played
      blockMeter: 0, cardsPlayedCount: 0, discount: 0, nextDrawDiscount: 0, nextDrawDiscountCount: 0,
      nextTurnCurrency: 0, maxHandSize: 7, maxTrickHandSize: 3,
      nextCardStolen: false, stolenByBWL: null, bwlInterceptUsed: false,
      drStrangeReorder: false, faceDownAvailable: false,
      // Per-player piles — used only in Deckbuilder mode. In Classic these
      // stay empty; the shared state.drawPile / state.trickDrawPile are
      // used instead via the same getDrawPile/getTrickPile helpers.
      drawPile: [],
      trickDrawPile: []
    };
  },

  // Pile accessors — branch on mode so every call site can stay
  // owner-agnostic. Classic returns the shared state.drawPile /
  // state.trickDrawPile; Deckbuilder returns the per-player pile. Call
  // sites mutate the returned array directly (push/pop/splice/shuffle);
  // because it's a live reference, the mutations persist correctly.
  getDrawPile(owner) {
    if (this.state.mode && this.state.mode.deck === 'deckbuilder') {
      return this.state[owner].drawPile;
    }
    return this.state.drawPile;
  },
  getTrickPile(owner) {
    if (this.state.mode && this.state.mode.deck === 'deckbuilder') {
      return this.state[owner].trickDrawPile;
    }
    return this.state.trickDrawPile;
  },

  buildDecks() {
    if (this.state.mode && this.state.mode.deck === 'deckbuilder') {
      // Per-player Deckbuilder piles. Player's deck is mode.customDeck if
      // the UI supplied one; otherwise both sides fall back to the default
      // starter. Every instance is a fresh shallow copy so card mutations
      // don't leak across matches.
      const defaultStarter = (typeof STARTER_DECKS !== 'undefined')
        ? STARTER_DECKS.balanced
        : { cards: CARD_DEFS.slice(0, 30).map(d => d.name),
            tricks: TRICK_DEFS.slice(0, 8).map(t => t.name) };
      const playerDeck = (this.state.mode.customDeck) ? this.state.mode.customDeck : defaultStarter;
      // AI deck selection. Roguelite path passes an explicit aiDeck on
      // the mode object — those are encounter-specific (Lex Luthor's
      // control deck, Doom's summon deck, random act-tier rolls); skip
      // the random STARTER_DECKS pick. Otherwise: never-mirror random
      // pick (existing My Decks behavior).
      let aiDeck;
      let aiDeckKey = null;
      if (this.state.mode.aiDeck) {
        aiDeck = this.state.mode.aiDeck;
        this.log(`[AI DECK] Encounter: ${aiDeck.name || aiDeck.persona || 'roguelite opponent'}`);
      } else if (typeof STARTER_DECKS !== 'undefined') {
        const keys = Object.keys(STARTER_DECKS);
        const normalize = (list) => (list || []).slice().sort().join('|');
        const pFingerprint = normalize(playerDeck.cards);
        const nonMirrorKeys = keys.filter(k => normalize(STARTER_DECKS[k].cards) !== pFingerprint);
        const poolKeys = nonMirrorKeys.length > 0 ? nonMirrorKeys : keys;
        const pickKey = poolKeys[Math.floor(this.rng() * poolKeys.length)];
        aiDeck = STARTER_DECKS[pickKey];
        aiDeckKey = pickKey;
        this.log(`[AI DECK] Opponent drew "${aiDeck.name || pickKey}" — prepare to counter.`);
      } else {
        aiDeck = defaultStarter;
      }
      this.state.aiArchetype = aiDeckKey || (aiDeck && aiDeck.name) || null;
      this.state.aiArchetypeName = (aiDeck && aiDeck.name) || aiDeckKey || 'Unknown';
      const expand = (names, pool) => this.shuffle(
        names.map(name => {
          const def = pool.find(d => d.name === name);
          return def ? { ...def } : null;
        }).filter(Boolean)
      );
      // Player deck — accept pre-built instances (roguelite passes these
      // pre-loaded with etches via Roguelite.buildRunCard) or expand
      // names from CARD_DEFS (My Decks / Classic).
      if (playerDeck.cardInstances) {
        this.state.player.drawPile = this.shuffle(playerDeck.cardInstances.slice());
      } else {
        this.state.player.drawPile = expand(playerDeck.cards, CARD_DEFS);
      }
      // AI deck — same dual-path. Roguelite's late-act AI passes pre-
      // built instances with rarity stat bumps + boss-deck signature
      // etches via Roguelite._buildAiCardInstances; classic / starter
      // decks fall through to expand-by-names.
      if (aiDeck.cardInstances) {
        this.state.ai.drawPile = this.shuffle(aiDeck.cardInstances.slice());
      } else {
        this.state.ai.drawPile = expand(aiDeck.cards, CARD_DEFS);
      }
      this.state.player.trickDrawPile  = expand(playerDeck.tricks, TRICK_DEFS);
      this.state.ai.trickDrawPile      = expand(aiDeck.tricks,     TRICK_DEFS);
      // Leave shared piles empty so any missed retrofit reads an empty
      // array instead of a stale shared copy.
      this.state.drawPile = [];
      this.state.trickDrawPile = [];
      // Summon deck is shared across both modes — pulls from full
      // CARD_DEFS regardless of either player's drafted deck so summons
      // remain a 1/95 lottery rather than a 1/30 trivial pull.
      this._initSummonDeck();
      return;
    }
    // Classic — single shared card draw pile — one copy of every card definition (95 total).
    // Filter out roguelite-only entries (STARTER_DEFS Goon/Thug/Brute,
    // AI_VANILLA_DEFS Soldier/Mercenary/Operator, CURSE_DEFS Wound/Doubt/
    // Regret) — they live in CARD_DEFS so the engine can name-resolve
    // them during a run, but they shouldn't appear in classic draft pulls.
    const isRL = (typeof Roguelite !== 'undefined' && Roguelite.isRogueliteOnlyName)
      ? (n) => Roguelite.isRogueliteOnlyName(n) : () => false;
    const deck = CARD_DEFS.filter(d => !isRL(d.name) && !d._spawnOnly).map(d => ({ ...d }));
    this.state.drawPile = this.shuffle(deck);

    // Single shared trick draw pile — one copy of every trick (27 total)
    const td = TRICK_DEFS.map(d => ({ ...d }));
    this.state.trickDrawPile = this.shuffle(td);

    // SUMMON DECK — independent reference pool used by every summon-from-
    // deck effect (Mother Box, Bat Signal, Knull, Gorr, Super Soldier
    // Serum). User spec: "the summon deck is an exact copy of the 95
    // card deck where now you can technically have duplicates of the
    // same card. If you summon Ant-Man from Mother Box you could still
    // have Ant-Man in hand." Decoupling summon-source from each
    // player's drawPile means:
    //   • Boss cards (Batman, Darkseid) get rarer (1/95 instead of 1/30).
    //   • Knull/Gorr can pull high-cost cards but the odds are diluted
    //     across the full 95.
    //   • Cards in your hand or on the board don't disappear from the
    //     summon pool, so summoned duplicates are now legal.
    this._initSummonDeck();
  },

  // Build a fresh summon deck from CARD_DEFS. Called from buildDecks
  // and from drawFromSummonDeck() when the pool runs low. Each entry
  // is a shallow copy so callers that mutate the picked def don't
  // corrupt the shared CARD_DEFS table.
  _initSummonDeck() {
    if (typeof CARD_DEFS === 'undefined') {
      this.state.summonDeck = [];
      return;
    }
    // Mother Box / Bat Signal / Super Soldier Serum etc. pull from this
    // pool — exclude roguelite-only names so a Classic match can't
    // randomly summon a Goon or a Wound. Inside a roguelite run, the
    // run-scoped summon paths build their own pools, so filtering here
    // doesn't break those.
    const isRL = (typeof Roguelite !== 'undefined' && Roguelite.isRogueliteOnlyName)
      ? (n) => Roguelite.isRogueliteOnlyName(n) : () => false;
    const summonDeck = CARD_DEFS
      .filter(d => !d.isDiscardEffect) // discard-effect cards are 0/0 — never sensible to summon
      .filter(d => !isRL(d.name))
      .filter(d => !d._spawnOnly)      // spawn-only cards enter only via their trigger (e.g. Freddy)
      .filter(d => !d._neverPlayable)  // Iron Giant can never stand on the field — hand-guard only
      .filter(d => !d.isEnvironment)   // environments deploy via their own play flow — summoning
                                       // one drops it as a plain 0/1 card (user report: Mother Box
                                       // pulled Boiler Room onto the board as a creature)
      .map(d => ({ ...d }));
    this.state.summonDeck = this.shuffle(summonDeck);
  },

  // Pull a single random card matching the predicate from the summon
  // deck. The deck is a CONSTANT-SIZE 90-card pool — pulled cards are
  // NOT removed, so every summon has an equal chance of returning any
  // given card on every call. User spec: "When that card gets summoned,
  // it gets reintroduced into the summon pile. So there's always an
  // equal chance to pull each card." (Same model as PvZ Heroes summon
  // pools.)
  //
  // Returns a SHALLOW COPY of the picked def so the caller can mutate
  // it (e.g. assign owner, attach to lane) without corrupting the
  // shared pool. Returns null if the predicate matches nothing.
  drawFromSummonDeck(predicate) {
    if (!this.state.summonDeck || !this.state.summonDeck.length) {
      this._initSummonDeck();
    }
    const pool = this.state.summonDeck.filter(predicate);
    if (!pool.length) return null;
    const pick = pool[Math.floor(this.rng() * pool.length)];
    // Spread into a fresh object so subsequent calls that mutate the
    // result (summonCard adds owner/id/etc.) don't bleed into the
    // shared deck entry.
    return { ...pick };
  },

  // Deckbuilder has no draft — we hand-deal the opening 5 cards + 2 tricks
  // directly from each player's own deck so the match starts in the same
  // shape Classic does right after the draft (5/2 in hand, round 1 begins).
  dealDeckbuilderOpeningHands() {
    ['player', 'ai'].forEach(owner => {
      const p = this.state[owner];
      const cardPile = p.drawPile;
      const trickPile = p.trickDrawPile;
      const openingCards = 5, openingTricks = 2;
      for (let i = 0; i < openingCards && cardPile.length; i++) {
        const def = cardPile.pop();
        // Roguelite paths put pre-built card instances into drawPile via
        // Roguelite.buildRunCard — those already have correct attack/HP,
        // etches applied, _runDeckCardRef set, and any onPlay/onDeath
        // callbacks. Re-running createCardInstance on them treats the
        // instance as a def: def.health is undefined → safeHp floors to
        // 1, every etch is lost, runRef vanishes. Detect via
        // _isCardInstance and use directly.
        let card;
        if (def && def._isCardInstance) {
          card = def;
          card.currentHealth = card.maxHealth;
        } else {
          card = this.createCardInstance(def, owner);
        }
        p.hand.push(card);
      }
      for (let i = 0; i < openingTricks && trickPile.length; i++) {
        const def = trickPile.pop();
        p.trickHand.push({ ...def, id: nextCardId++ });
      }
    });
  },

  shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  // ===================== DRAFT =====================

  presentDraftChoices() {
    const d = this.state.draft;
    // Draft only runs in Classic — the helper falls back to the shared
    // pile here because Deckbuilder never enters the draft phase.
    const pile = d.phase === 'cards' ? this.getDrawPile('player') : this.getTrickPile('player');

    if (d.phase === 'cards') {
      // Player sees 2, AI sees 2 (separate draws from same pile)
      d.playerChoices = [pile.pop(), pile.pop()].filter(Boolean);
      d.aiChoices = [pile.pop(), pile.pop()].filter(Boolean);
      // In multiplayer, the "ai" seat is a real human on the guest
      // client. They make their own pick via UI → guest sends a
      // 'draftPick' action → host calls draftPick(idx, 'ai') below.
      // Skip the auto-pick path so the round only advances when both
      // humans have actually chosen. User report: "the draft shared
      // and you continue when the other person is ready."
      // Hotseat: same — the 'ai' seat is the other human, who picks
      // after the pass-the-device flip.
      const bothHumans = this.isMultiplayer() || this.isHotseat();
      if (!bothHumans && d.aiChoices.length >= 2) {
        const picked = (typeof AI !== 'undefined' && AI.pickDraftCard)
          ? AI.pickDraftCard(d.aiChoices, d.aiDrafted)
          : d.aiChoices[0];
        const pickIdx = d.aiChoices.indexOf(picked);
        d.aiDrafted.push(d.aiChoices[pickIdx]);
        d.cardHolding.push(d.aiChoices[1 - pickIdx]);
      } else if (!bothHumans && d.aiChoices.length === 1) {
        d.aiDrafted.push(d.aiChoices[0]);
      }
    } else {
      d.playerChoices = [pile.pop(), pile.pop()].filter(Boolean);
      d.aiChoices = [pile.pop(), pile.pop()].filter(Boolean);
      const bothHumans = this.isMultiplayer() || this.isHotseat();
      if (!bothHumans && d.aiChoices.length >= 2) {
        const picked = (typeof AI !== 'undefined' && AI.pickDraftTrick)
          ? AI.pickDraftTrick(d.aiChoices, d.aiTrickDrafted)
          : d.aiChoices[0];
        const pickIdx = d.aiChoices.indexOf(picked);
        d.aiTrickDrafted.push(d.aiChoices[pickIdx]);
        d.trickHolding.push(d.aiChoices[1 - pickIdx]);
      } else if (!bothHumans && d.aiChoices.length === 1) {
        d.aiTrickDrafted.push(d.aiChoices[0]);
      }
    }
  },

  // draftPick(index, who?)
  //   index — which of the 2 visible choices was picked (0 or 1)
  //   who   — 'player' or 'ai' (defaults to 'player' for single-player).
  //           In multiplayer, the host calls draftPick('ai') when the
  //           guest's pick arrives via _mpApplyAction.
  // Multiplayer flow: each side picks at its own pace. The round only
  // advances when BOTH sides have picked their card for this round.
  // User spec: "the draft shared and you continue when the other
  // person is ready."
  draftPick(index, who) {
    // Guest forwards the pick to the host instead of executing locally
    // — guest's local state is overwritten by host's broadcast anyway,
    // and the host's pile / pickedThisRound flags are the canonical
    // truth. Same pattern as playCard / playTrick.
    if (this.isMultiplayer() && this.mp && this.mp.role === 'guest') {
      if (typeof Multiplayer !== 'undefined') {
        Multiplayer.send({ t: 'draftPick', index });
        // Clear local choices immediately so the guest can't double-pick
        // while waiting for the host's state broadcast.
        if (this.state && this.state.draft) this.state.draft.playerChoices = [];
        if (typeof UI !== 'undefined') UI.render();
      }
      return;
    }
    who = who || 'player';
    const d = this.state.draft;
    // Snapshot for the Back button — captures pre-pick state so draftUndo
    // can restore it verbatim (choices shown, piles, drafted lists, holding,
    // mulligan flag, AI's already-committed pick for this round).
    if (!d.history) d.history = [];
    d.history.push(this._snapshotDraftState());
    // Pick from the right side's choices array, push to the right
    // drafted array, leftover goes to the shared holding pool.
    const choicesKey  = who === 'player' ? 'playerChoices' : 'aiChoices';
    const draftedKey  = d.phase === 'cards'
      ? (who === 'player' ? 'playerDrafted' : 'aiDrafted')
      : (who === 'player' ? 'playerTrickDrafted' : 'aiTrickDrafted');
    const holdingKey  = d.phase === 'cards' ? 'cardHolding' : 'trickHolding';
    const choices = d[choicesKey] || [];
    const picked = choices[index];
    if (!picked) { this.presentDraftChoices(); UI.render(); return; }
    d[draftedKey].push(picked);
    if (choices[1 - index]) d[holdingKey].push(choices[1 - index]);
    if (d.phase === 'cards') {
      this.log(`[DRAFT] ${who === 'player' ? 'You' : 'Opponent'} picked: ${picked.name} (${picked.attack}/${picked.health})`);
    } else {
      this.log(`[DRAFT] ${who === 'player' ? 'You' : 'Opponent'} picked trick: ${picked.name}`);
    }
    // Mark this side as having picked this round; advance the round
    // only when BOTH sides have picked (or in single-player where the
    // AI's pick was already pushed by presentDraftChoices, which
    // means aiDrafted is already 1-ahead-of-d.round so the comparison
    // always passes immediately after the player's pick).
    //
    // In MULTIPLAYER, on partial-pick (one side committed but the
    // other hasn't) we CLEAR the committed side's `*Choices` array
    // so the UI shows a waiting state instead of the stale picker
    // (the picked card would still be visible because we read
    // without splicing). The OTHER side's choices stay populated
    // so they can still pick. Once they do, the bothPicked branch
    // below fires presentDraftChoices which clears + redraws both.
    if (d.phase === 'cards') {
      const bothPicked = d.playerDrafted.length === d.aiDrafted.length;
      if (!bothPicked) {
        // Hotseat: the other human picks next — gate with the pass
        // screen; confirming flips so their offers become playerChoices.
        if (this.isHotseat()) { this._hotseatHandoff(); return; }
        if (this.isMultiplayer()) {
          if (who === 'player') d.playerChoices = [];
          else if (who === 'ai') d.aiChoices = [];
        }
        this._mpBroadcast();
        UI.render();
        return;
      }
      d.round++;
      if (d.round > 5) { this.finishCardDraft(); return; }
    } else {
      const bothPicked = d.playerTrickDrafted.length === d.aiTrickDrafted.length;
      if (!bothPicked) {
        if (this.isHotseat()) { this._hotseatHandoff(); return; }
        if (this.isMultiplayer()) {
          if (who === 'player') d.playerChoices = [];
          else if (who === 'ai') d.aiChoices = [];
        }
        this._mpBroadcast();
        UI.render();
        return;
      }
      d.round++;
      if (d.round > 2) { this.finishTrickDraft(); return; }
    }
    // Clear choice arrays so the in-MP "waiting for opponent" branch
    // doesn't render stale slots before presentDraftChoices repopulates.
    d.playerChoices = [];
    d.aiChoices = [];
    this.presentDraftChoices();
    // Sync fresh offers + advanced round to the guest. _mpBroadcast
    // is a no-op when this client isn't the host, so the host's
    // own pick path triggers the broadcast while the guest's pick
    // path (which forwarded to host and never reaches this line)
    // is broadcast by _mpApplyAction's trailing broadcast call.
    this._mpBroadcast();
    UI.render();
  },

  // Snapshot everything a draftPick mutates. Card/trick defs are shared
  // references (static defs, not instances), so shallow array copies are
  // safe — we're not going to mutate the defs themselves, only the arrays
  // that hold them. The pile IS a live reference that presentDraftChoices
  // pops from, so we copy it here and restore in place on undo.
  _snapshotDraftState() {
    const d = this.state.draft;
    const pile = d.phase === 'cards' ? this.getDrawPile('player') : this.getTrickPile('player');
    return {
      phase: d.phase,
      round: d.round,
      playerChoices: (d.playerChoices || []).slice(),
      aiChoices:     (d.aiChoices     || []).slice(),
      playerDrafted: (d.playerDrafted || []).slice(),
      aiDrafted:     (d.aiDrafted     || []).slice(),
      playerTrickDrafted: (d.playerTrickDrafted || []).slice(),
      aiTrickDrafted:     (d.aiTrickDrafted     || []).slice(),
      cardHolding:  (d.cardHolding  || []).slice(),
      trickHolding: (d.trickHolding || []).slice(),
      mulliganUsed: !!d.mulliganUsed,
      pile: pile.slice(),
      logLen: Array.isArray(this.state.log) ? this.state.log.length : 0
    };
  },

  // Back-button handler — pops the last snapshot and restores draft state
  // in-place. Restoration is confined to a single draft phase (cards OR
  // tricks) because finishCardDraft also mutates hands + shuffles the
  // pile; history is cleared there so the undo stack never crosses that
  // boundary.
  draftUndo() {
    // Undo is disabled in multiplayer — snapshots are host-perspective
    // so restoring them on the guest would show wrong cards, and undoing
    // an opponent's already-seen pick doesn't make sense.
    // Hotseat too: snapshots cross the pass-the-device flips, so undoing
    // would restore (and reveal) the other player's pre-flip picks.
    if (this.isMultiplayer() || this.isHotseat()) return false;
    const d = this.state.draft;
    if (!d || !d.history || !d.history.length) return false;
    const snap = d.history.pop();
    d.phase = snap.phase;
    d.round = snap.round;
    d.playerChoices = snap.playerChoices.slice();
    d.aiChoices     = snap.aiChoices.slice();
    d.playerDrafted = snap.playerDrafted.slice();
    d.aiDrafted     = snap.aiDrafted.slice();
    d.playerTrickDrafted = snap.playerTrickDrafted.slice();
    d.aiTrickDrafted     = snap.aiTrickDrafted.slice();
    d.cardHolding  = snap.cardHolding.slice();
    d.trickHolding = snap.trickHolding.slice();
    d.mulliganUsed = snap.mulliganUsed;
    // Restore the pile in-place so any live references stay consistent.
    const pileRef = d.phase === 'cards' ? this.getDrawPile('player') : this.getTrickPile('player');
    pileRef.length = 0;
    for (let i = 0; i < snap.pile.length; i++) pileRef.push(snap.pile[i]);
    // Trim the log back so the "[DRAFT] Picked: ..." line vanishes too —
    // leaves the log clean, as if the pick never happened.
    if (Array.isArray(this.state.log) && typeof snap.logLen === 'number'
        && this.state.log.length > snap.logLen) {
      this.state.log.length = snap.logLen;
    }
    this.state.phase = d.phase === 'cards' ? 'draft-cards' : 'draft-tricks';
    this.log('[DRAFT] Undo — previous pick reverted.');
    UI.render();
    return true;
  },

  finishCardDraft() {
    const d = this.state.draft;
    // Unpicked (held) cards return to the shared pile. Classic only —
    // Deckbuilder never enters this path because the draft is skipped.
    const pile = this.getDrawPile('player');
    d.cardHolding.forEach(c => pile.push(c));
    this.state.player.hand = d.playerDrafted.map(def => this.createCardInstance(def, 'player'));
    this.state.ai.hand = d.aiDrafted.map(def => this.createCardInstance(def, 'ai'));
    this.shuffle(pile);
    d.phase = 'tricks'; d.round = 1;
    d.mulliganUsed = false; // legacy single-player flag
    d.playerMulliganUsed = false; // fresh mulligan for trick phase (per-side)
    d.aiMulliganUsed = false;
    // Undo history doesn't cross the card→trick boundary (hands are
    // already instantiated, pile has been shuffled). Reset so the Back
    // button only walks backward through the current phase's picks.
    d.history = [];
    this.state.phase = 'draft-tricks';
    this.presentDraftChoices();
    UI.render();
  },

  // One re-draw of the current 2 player choices per draft phase. Returns
  // the rejected pair to the bottom of the appropriate pile so they can
  // still resurface later, then pops 2 fresh picks. AI's choices stay put
  // — AI has already committed its pick for this round.
  draftMulligan(who) {
    // Guest forwards to host instead of modifying local state directly.
    if (this.isMultiplayer() && this.mp && this.mp.role === 'guest') {
      if (typeof Multiplayer !== 'undefined') {
        Multiplayer.send({ t: 'draftMulligan' });
        if (this.state && this.state.draft) this.state.draft.playerChoices = [];
        if (typeof UI !== 'undefined') UI.render();
      }
      return false;
    }
    who = who || 'player';
    const d = this.state.draft;
    // Per-side mulligan flags so each player gets one per phase.
    const mulliganKey = who === 'player' ? 'playerMulliganUsed' : 'aiMulliganUsed';
    if (d[mulliganKey]) return false;
    const choicesKey = who === 'player' ? 'playerChoices' : 'aiChoices';
    if (!d[choicesKey] || d[choicesKey].length === 0) return false;
    const pile = d.phase === 'cards' ? this.getDrawPile('player') : this.getTrickPile('player');
    // Mulliganed choices go to HOLDING, not back into the pile. They used to
    // be unshifted back and reshuffled, which put them right back in
    // circulation — the OPPONENT could be dealt the two cards you just
    // mulliganed away, since both sides draw from this same shared pile.
    // Holding is already the draft's "seen but not taken" area (the rejected
    // half of every pick lands there) and is flushed back into the pile by
    // finishCardDraft / finishTrickDraft when the draft ends.
    const holdingKey = d.phase === 'cards' ? 'cardHolding' : 'trickHolding';
    if (!d[holdingKey]) d[holdingKey] = [];
    d[choicesKey].forEach(c => { if (c) d[holdingKey].push(c); });
    // Refill from the pile; if it's dry, recycle holding as a last resort so
    // the draft can't stall on an empty offer.
    const draw = () => {
      if (!pile.length && d[holdingKey].length) {
        pile.push(...this.shuffle(d[holdingKey].splice(0, d[holdingKey].length)));
      }
      return pile.pop();
    };
    const fresh = [draw(), draw()].filter(Boolean);
    d[choicesKey] = fresh;
    d[mulliganKey] = true;
    if (who === 'player') d.mulliganUsed = true; // keep legacy UI flag in sync so the button disables
    this.log(`[DRAFT] Mulligan used — new ${d.phase === 'cards' ? 'cards' : 'tricks'} drawn.`);
    this._mpBroadcast();
    if (typeof UI !== 'undefined') UI.render();
    return true;
  },

  finishTrickDraft() {
    const d = this.state.draft;
    // Unpicked tricks return to the shared trick pile. Classic only.
    const pile = this.getTrickPile('player');
    d.trickHolding.forEach(t => pile.push({ ...t }));
    this.state.player.trickHand = d.playerTrickDrafted.map(t => ({ ...t, id: nextCardId++ }));
    this.state.ai.trickHand = d.aiTrickDrafted.map(t => ({ ...t, id: nextCardId++ }));
    this.shuffle(pile);
    this.log('[DRAFT] Draft complete! The battle begins.');
    this.startRound();
  },

  // ===================== ROUNDS =====================

  startRound() {
    // Defensive: a queued prompt arm surviving into a new round means its
    // resolve path was dropped — firing it now against a changed board
    // would be wrong. Log + discard.
    if (this._promptQueue && this._promptQueue.length) {
      console.warn('[promptQueue]', this._promptQueue.length, 'stale queued prompt(s) discarded at round start');
      this._promptQueue = [];
    }
    this._stackClear('startRound');
    // Invariant-report dedup is per-round — fresh round, fresh eyes.
    this._invariantSeen = null;
    this.state.round++;
    const r = this.state.round;
    // Sanitize all living cards — heal any currentHealth/maxHealth/attack
    // that drifted to NaN/undefined over the previous round. Belt-and-
    // suspenders vs. the fix-at-the-source work in buffCard/debuffCard/
    // applyCombatDamage. Caught by sim/test.js invariant sweep.
    this._sanitizeAllCards();
    // New round — reset the late-round markers so debuffs applied in
    // this round's normal phases clear normally at its postCombat.
    this.state._combatFinishedThisRound = false;
    // Clear per-card "has swung" flags from the previous round so
    // fresh-round debuffs (Mind Stone in phase 2 pre-combat) don't get
    // mistakenly stamped as persistent.
    this.getAllCardsOnBoard().forEach(c => { delete c._combatSwungThisRound; });
    // Time Stone intercept bookkeeping — clear any tricks flagged last
    // round so they can be played / intercept-checked fresh this round.
    ['player', 'ai'].forEach(o => {
      (this.state[o].trickHand || []).forEach(t => {
        if (t && t._timeStonedAtRound && t._timeStonedAtRound < this.state.round) {
          delete t._timeStonedAtRound;
        }
        if (t && t._timeStoneChecked) delete t._timeStoneChecked;
      });
    });
    // Snapshot HP at the top of each round so the end-of-game panel can
    // show the HP-over-rounds curve. Stored as plain ints; the chart
    // reads .player / .ai for the two lines.
    if (!this.state._hpHistory) this.state._hpHistory = [];
    this.state._hpHistory.push({
      round: r,
      player: this.state.player.health,
      ai:     this.state.ai.health
    });
    const isOdd = r % 2 === 1;
    // Flash override — if someone used Flash's "choose first next turn", honor it.
    if (this.state._nextFirstPlayer === 'player' || this.state._nextFirstPlayer === 'ai') {
      this.state.firstPlayer = this.state._nextFirstPlayer;
      delete this.state._nextFirstPlayer;
    } else {
      this.state.firstPlayer = isOdd ? this.state.oddPlayer : this.opponent(this.state.oddPlayer);
    }
    // Reset per-round stat trackers so the end-of-round recap reflects only this round.
    this.state._roundStats = {
      round: r,
      playerDamageDealt: 0, playerDamageTaken: 0,
      aiDamageDealt: 0,     aiDamageTaken: 0,
      playerKills: [], aiKills: [],
      playerTricks: [], aiTricks: []
    };
    this.log(`--- Round ${r} --- ${this.seatVerb(this.state.firstPlayer, 'go', 'goes')} first`);

    // Roguelite faster-pacing: energy = round × 2 (round 1 → 2 energy,
    // round 2 → 4, ... round 5 → 10) instead of += 1 per round. Snappier
    // matches that end in 5-6 rounds. User spec: "should just start on
    // round two and then each round we go up to. So two, four, six,
    // eight, 10."
    const rogueliteEnergyMul = (this.state.mode && this.state.mode._roguelite) ? 2 : 1;
    // Relic-driven energy bonus (Battery, Speed Force) — only applies
    // to the player side. Stacks across multiple relics. Pulled from
    // the run state which Roguelite._launchFight refreshed via the
    // onFightStart hook chain right before startMatch fired.
    const relicEnergyBonus = (this.state.roguelite && this.state.roguelite._extraEnergy) || 0;
    // Every-other-round energy bonus from starter relic Battery.
    // Applies on odd rounds only (1, 3, 5, …) so the player gets
    // ~half the upside of a flat per-round bonus. User direction:
    // "Have it for every other turn." Stronger than round-1-only,
    // weaker than every-round.
    const relicEnergyBonusAlt = (this.state.roguelite && this.state.roguelite._extraEnergyAlt && (r % 2 === 1)) || 0;
    ['player', 'ai'].forEach(o => {
      // batmanBlocked is now a round-number marker set to R+1 when Batman
      // plays in round R. Clearing it unconditionally here would wipe the
      // lock before the opponent's scheduled turn; isCardBatmanBlocked
      // compares against the current round, so a stale value from a past
      // round is already treated as inactive without a forced reset.
      let cur = (r * rogueliteEnergyMul) + this.state[o].nextTurnCurrency;
      if (o === 'player' && relicEnergyBonus) cur += relicEnergyBonus;
      if (o === 'player' && relicEnergyBonusAlt) cur += relicEnergyBonusAlt;
      this.getAllCardsOf(o).forEach(c => {
        // Attribute each passive's energy bonus to the generating card +
        // its summon chain so the MVP formula credits every ancestor.
        if (c.passive === 'extraCurrency3') {
          cur += 3;
          this._creditChain(c, 'statsEnergyGenerated', 3);
        }
        if (c.passive === 'extraCurrency2') {
          cur += 2;
          this._creditChain(c, 'statsEnergyGenerated', 2);
        }
        if (c.passive === 'extraCurrency') {
          cur += 1;
          this._creditChain(c, 'statsEnergyGenerated', 1);
        }
        // Defensive: zero the per-card landed-damage counter on currencyOnDamage
        // cards (e.g. Green Lantern) so the bonus from last round can never carry
        // over or stack into this round. The counter is also reset in onEndOfTurn,
        // but this guard handles edge cases where the card died mid-combat (no
        // onEndOfTurn fired) and was later revived.
        if (c.passive === 'currencyOnDamage') c._damageDealtThisTurn = 0;
      });
      // Green Lantern's nextTurnCurrency was already credited last round
      // — add it to GL + chain for MVP attribution.
      if (this.state[o].nextTurnCurrency > 0) {
        const gl = this.getAllCardsOf(o).find(c => c.passive === 'currencyOnDamage');
        if (gl) this._creditChain(gl, 'statsEnergyGenerated', this.state[o].nextTurnCurrency);
      }
      this.state[o].currency = cur;
      this.state[o].nextTurnCurrency = 0;
      this.state[o].discount = 0;
      this.state[o].faceDownAvailable = this.getAllCardsOf(o).some(c => c.passive === 'faceDownOption');
    });

    this.getAllCardsOnBoard().forEach(c => {
      if (c.onTurnStart) c.onTurnStart(this, c);
    });
    // Per-round Crazy / Insane reroll — any card carrying either
    // trait re-randomizes its ATK at the top of every round. Joker /
    // Harley plus whichever enemy Joker has stamped with Crazy.
    this.getAllCardsOnBoard().forEach(c => this.rerollCrazyInsane(c));
    // Apply Magneto debuffs each round
    this.applyMagnetoDebuffs();
    this.state.lanes.forEach(l => l.protected = null);
    // Clear Parlay — one-round effect from Jack Sparrow (per-card flag;
    // legacy side-wide key deleted too for old saves)
    this.getAllCardsOnBoard().forEach(c => { delete c._parlayedThisRound; });
    delete this.state._parlayActive;
    // Resolve any upkeep prompts (e.g. Gargantua) before starting the phase.
    this._resolveUpkeepPrompts(() => this.startPhase1());
  },

  _resolveUpkeepPrompts(callback) {
    const queue = this.state._pendingUpkeep || [];
    this.state._pendingUpkeep = [];
    const processNext = (idx) => {
      if (idx >= queue.length) { callback(); return; }
      const { card, owner, label } = queue[idx];
      const optional = !!queue[idx].onDecline; // onDecline = skip is harmless (no collapse)
      const next = () => processNext(idx + 1);
      if (card.currentHealth <= 0 || this.findCardLane(card) < 0) { next(); return; }
      if (!this.isHuman(owner)) {
        // AI always auto-pays if it can afford.
        if (this.state[owner].currency >= 1) {
          this.state[owner].currency -= 1;
          if (queue[idx].onPay) queue[idx].onPay();
        } else if (optional) {
          if (queue[idx].onDecline) queue[idx].onDecline();
        } else {
          const l = this.findCardLane(card);
          card.currentHealth = 0;
          if (l >= 0) this.handleDeath(card, l, null);
        }
        next(); return;
      }
      // Can't afford — optional upkeep just skips; mandatory collapses.
      if (this.state[owner].currency < 1) {
        if (optional) {
          if (queue[idx].onDecline) queue[idx].onDecline();
          next(); return;
        }
        this.log(`[UPKEEP] Not enough Energy — ${label || card.name} collapses!`);
        const l = this.findCardLane(card);
        card.currentHealth = 0;
        if (l >= 0) this.handleDeath(card, l, null);
        if (typeof UI !== 'undefined' && UI.render) UI.render();
        next(); return;
      }
      const payOpt  = { _upkeepPay:  true, name: 'Pay 1 Energy', cost: 1, attack: 0, health: 1,
        type: 'environment', desc: (optional ? 'Activate pull — ' : 'Keep ') + (label || card.name) + (optional ? ' pulls all enemies 1 lane closer.' : ' active.'), isEnvironment: true };
      const skipName = optional ? 'Skip' : 'Let it Collapse';
      const skipDesc = optional
        ? 'No pull this round — ' + (label || card.name) + ' stays put.'
        : (label || card.name) + ' disappears — no energy spent.';
      const skipOpt = { _upkeepSkip: true, name: skipName, cost: 0, attack: 0, health: 0,
        type: 'environment', desc: skipDesc, isEnvironment: true };
      const promptDesc = optional
        ? 'Pay 1 Energy to pull all enemies 1 lane closer, or skip.'
        : 'Pay 1 Energy to keep it active, or let it collapse.';
      this.promptCardChoice(owner, [payOpt, skipOpt],
        (label || card.name) + ' — Upkeep',
        promptDesc,
        (picked) => {
          if (picked && picked._upkeepPay) {
            this.state[owner].currency -= 1;
            this.log(`[UPKEEP] You pay 1 Energy — ${label || card.name} activates.`);
            if (queue[idx].onPay) queue[idx].onPay();
          } else if (optional) {
            this.log(`[UPKEEP] You skip — ${label || card.name} stays, no pull.`);
            if (queue[idx].onDecline) queue[idx].onDecline();
          } else {
            this.log(`[UPKEEP] ${label || card.name} collapses.`);
            const l = this.findCardLane(card);
            card.currentHealth = 0;
            if (l >= 0) this.handleDeath(card, l, null);
            if (typeof UI !== 'undefined' && UI.render) UI.render();
          }
          next();
        },
        (choices) => choices.find(c => c._upkeepPay) || choices[0]
      );
    };
    processNext(0);
  },

  // "Foresee" pipeline: show top 2 of the draw pile, owner picks 1 to take,
  // the other goes straight to the enemy's hand. Triggered from drawPhase().
  // The flag value can be `true` (default Dr. Strange label) or a string source name
  // (e.g. "Eye of Agamotto") so different effects share the mechanic with their own UI text.
  handleDrStrangeReorder(callback) {
    const queue = ['player', 'ai'].filter(o => this.state[o].drStrangeReorder);
    // Track which owners actually pulled a card via the Foresee pipeline.
    // drawPhase uses this to skip the normal "draw 1" for those owners so
    // peek-and-keep counts as the round's draw instead of stacking with it.
    const peeked = new Set();
    if (!queue.length) { callback(peeked); return; }

    const processNext = (i) => {
      if (i >= queue.length) { callback(peeked); return; }
      const owner = queue[i];
      const opp = this.opponent(owner);
      const flag = this.state[owner].drStrangeReorder;
      const source = (typeof flag === 'string' && flag) ? flag : 'Dr. Strange';
      const tag = source.toUpperCase();
      // Dormammu foresight persists for multiple turns
      if (this.state[owner]._dormammuForesight > 1) {
        this.state[owner]._dormammuForesight--;
        // Keep drStrangeReorder active for next draw phase
      } else {
        this.state[owner].drStrangeReorder = false;
        delete this.state[owner]._dormammuForesight;
      }

      // Foresee peeks the OWNER's pile — in Deckbuilder it's their own
      // deck, in Classic the shared pile.
      //
      // ROGUELITE MODE: pop the top 3 from the owner's deck, owner picks
      // 1 to draw, the rest go to the BOTTOM of the owner's own deck.
      // User direction: "you're scrying your own deck. So you choose
      // the card you want to draw. And the one(s) you don't draw go to
      // the bottom of your deck." Same for Eye of Agamotto / Dormammu
      // (which all share this `drStrangeReorder` flag).
      //
      // CLASSIC MODE: top 2 → keep 1, other goes to opponent's hand
      // (the original drift mechanic, kept intact for non-roguelite).
      const isRoguelite = !!(this.state.mode && this.state.mode._roguelite);
      const pile = this.getDrawPile(owner);
      if (pile.length === 0) {
        this.log(`  [${tag}] Draw pile empty — vision fizzles.`);
        processNext(i + 1);
        return;
      }
      if (pile.length === 1) {
        const def = pile.pop();
        this.addToHand(owner, this.createCardInstance(def, owner));
        this.log(`  [${tag}] Only one card remains — ${this.seatVerb(owner, 'take', 'takes')} ${def.name}.`);
        peeked.add(owner);
        processNext(i + 1);
        return;
      }

      if (isRoguelite) {
        // Pop top 3 (or fewer if pile is small)
        const peekCount = Math.min(3, pile.length);
        const choices = [];
        for (let k = 0; k < peekCount; k++) choices.push(pile.pop());

        const distributeR = (picked) => {
          const others = choices.filter(c => c !== picked);
          // Picked card → owner's hand
          this.addToHand(owner, this.createCardInstance(picked, owner));
          // Others → bottom of OWNER's pile (unshift = front-of-array =
          // bottom-of-stack since pop() draws from the end). Order
          // randomized so the player can't perfectly predict next draw.
          const shuffled = others.slice().sort(() => this.rng() - 0.5);
          shuffled.forEach(c => pile.unshift(c));
          const ownWho = owner === 'player' ? 'You take' : 'AI takes';
          const otherList = others.map(c => c.name).join(', ');
          this.log(`  [${tag}] ${ownWho} ${picked.name}; ${otherList} sent to the bottom of your deck.`);
          peeked.add(owner);
          processNext(i + 1);
        };

        if (this.isHuman(owner)) {
          // Build runtime instances for the prompt UI so they render
          // with their full cards. Distribute receives the original
          // def by name back since we map through choices.
          this.promptCardChoice(owner, choices, `${source} — Scry`,
            "Choose 1 card to draw. The others go to the bottom of your deck.",
            distributeR,
            (cards) => cards.slice().sort((a, b) => b.cost - a.cost)[0]);
        } else {
          const best = choices.slice().sort((a, b) => b.cost - a.cost)[0];
          distributeR(best);
        }
        return;
      }

      // Classic / non-roguelite — original "give the other to opponent"
      // behavior. Pop top 2 from the owner's draw pile.
      const top1 = pile.pop();
      const top2 = pile.pop();
      const choices = [top1, top2];

      const distribute = (picked) => {
        const other = choices.find(c => c !== picked);
        this.addToHand(owner, this.createCardInstance(picked, owner));
        this.addToHand(opp, this.createCardInstance(other, opp));
        const ownWho = owner === 'player' ? 'You take' : 'AI takes';
        const oppWho = opp === 'player' ? 'you receive' : 'AI receives';
        this.log(`  [${tag}] ${ownWho} ${picked.name}; ${oppWho} ${other.name}.`);
        peeked.add(owner);
        peeked.add(opp);
        processNext(i + 1);
      };

      if (this.isHuman(owner)) {
        this.promptCardChoice(owner, choices, `${source} — Foresee`,
          "Choose 1 card to draw. The other goes to your enemy's hand.",
          distribute,
          (cards) => cards.slice().sort((a, b) => b.cost - a.cost)[0]);
      } else {
        const best = choices.slice().sort((a, b) => b.cost - a.cost)[0];
        distribute(best);
      }
    };
    processNext(0);
  },

  startPhase1() {
    const fp = this.state.firstPlayer;
    this.state.activePlayer = fp;
    this.state.selectedCard = null;
    this.state.selectedTrick = null;
    if (fp === 'player') {
      this.state.phase = 'player-cards';
      this.clearHistory(); // new player turn — undo cannot cross this boundary
      UI.render();
    } else {
      this.state.phase = 'ai-cards';
      UI.render();
      // In multiplayer, the "ai" side is actually the OTHER human
      // player. Don't run AI logic — wait for their actions to arrive
      // via Multiplayer / _mpApplyAction (host) or for the host to
      // broadcast updated state (guest). User report: "the ai plays
      // for the person im playing there should be no ai opponet PvP"
      if (this.isMultiplayer()) return;
      // Hotseat: the "ai" seat is the other human on THIS device —
      // gate with a pass screen, then flip so they play as 'player'.
      if (this.isHotseat()) { this._hotseatHandoff(); return; }
      // Defer the AI's first move until the boot-sequence curtain is
      // off-screen. The boot animation runs ~2200ms; without this gate
      // the AI used to start playing while the scan was still closing,
      // which made its move feel like it appeared from nowhere. The
      // boot publishes _bootSequenceEndsAt; we wait for it + a short
      // 200ms breathing room. Falls through to the normal 1200ms cadence
      // for every later turn.
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const bootEnd = this.state._bootSequenceEndsAt || 0;
      const bootRemain = Math.max(0, bootEnd - now);
      const aiDelay = Math.max(1200, bootRemain + 200);
      if (bootRemain > 0) delete this.state._bootSequenceEndsAt; // one-shot
      this._schedule(() => { AI.playCards('ai', () => this.endPhase1()); }, aiDelay);
    }
  },

  // Freddy Fazbear — jump offer + passive flag check at end of a player's card phase.
  // Called from endPhase1 (first player) and endPhase2 (second player) with the
  // player whose phase just ended. REWORKED (user direction): Freddy feeds on the
  // OPPONENT's waste — when the phase-ender banks unspent energy, it's the OTHER
  // side's Freddy that wakes: the hand copy offers its free deploy, the board copy
  // arms the round-start drain. (Previously both keyed on his own owner's energy.)
  _checkFreddyFazbear(ender) {
    if (!this.state[ender] || this.state[ender].currency <= 0) return;
    const owner = this.opponent(ender);
    // Jump: Freddy in the OPPONENT's hand → offer free play
    const inHand = this.state[owner].hand.find(c => c.name === 'Freddy Fazbear');
    if (inHand && !inHand.jumpReady) {
      inHand.jumpReady = true;
      this.log(`  [JUMP] Freddy Fazbear senses the opponent's ${this.state[ender].currency} unspent energy — free play available!`);
      if (this.isHuman(owner) && !this.state.pendingJumpOffer) {
        this.state.pendingJumpOffer = { cardId: inHand.id };
        if (typeof UI !== 'undefined') UI.render();
      } else if (!this.isHuman(owner)) {
        const open = this.getOpenLanes(owner);
        inHand.jumpReady = false;
        if (open.length) this.playCardFree(owner, inHand, open[0]);
      }
    }
    // Passive: Freddy on the OPPONENT's board → arm the round-start drain.
    // isCardKind + forEach: a Manhunter copy drains too, and two Freddys
    // both arm (audit fix — the old name-keyed find() missed copies).
    this.getAlliesOf(owner)
      .filter(c => this.isCardKind(c, 'Freddy Fazbear') && c.currentHealth > 0)
      .forEach(c => { c._triggerNextRound = true; });
  },

  endPhase1() {
    // Guest forwards Done to the host — host is authoritative on the
    // engine. Without this, the guest's local engine would advance
    // independently and then get clobbered by the next state broadcast,
    // racing against the host. Send-and-let-broadcast keeps both sides
    // in lockstep.
    if (this.isMultiplayer() && this.mp && this.mp.role === 'guest') {
      if (typeof Multiplayer !== 'undefined') Multiplayer.send({ t: 'doneTurn' });
      return;
    }
    this.whenPromptCleared(() => {
      const sp = this.opponent(this.state.firstPlayer);
      this.state.activePlayer = sp;
      this.state.selectedCard = null;
      this.state.selectedTrick = null;
      if (sp === 'player') {
        this.state.phase = 'player-cards-tricks';
        this.clearHistory(); // new player turn — undo cannot cross this boundary
        UI.render();
      } else {
        this.state.phase = 'ai-cards-tricks';
        UI.render();
        // Multiplayer: don't run AI for the opponent (they're a real
        // human on the other side). Wait for their actions.
        if (this.isMultiplayer()) return;
        // Hotseat: pass the device instead of running AI.
        if (this.isHotseat()) { this._hotseatHandoff(); return; }
        // Phase 2 = AI going second: it's the AI's full turn (cards + tricks).
        // Call playTrickPhaseCards BETWEEN playCards and playTricks so Thanos /
        // Iron Man still fire — playCards() now defers them waiting for a
        // Phase 3 that never comes when AI goes second. Calling
        // playTrickPhaseCards here gives them their "post-opponent-commit"
        // timing: Phase 1 (opponent plays) → Phase 2 (AI plays cards, then
        // trick-phase cards against the committed board, then tricks).
        this._schedule(() => {
          AI.playCards('ai', () => {
            AI.playTrickPhaseCards('ai', () => {
              AI.playTricks('ai', () => this.endPhase2());
            });
          });
        }, 1200);
      }
    });
  },

  endPhase2() {
    // Guest forwards Done to host (same as endPhase1).
    if (this.isMultiplayer() && this.mp && this.mp.role === 'guest') {
      if (typeof Multiplayer !== 'undefined') Multiplayer.send({ t: 'doneTurn' });
      return;
    }
    // Freddy Fazbear jump / passive check for the second player (who just committed their phase)
    this._checkFreddyFazbear(this.opponent(this.state.firstPlayer));
    this.whenPromptCleared(() => {
      // Reveal face-down cards before the final trick phase.
      // revealFaceDownCards fires onPlay for revealed cards, which may open
      // a prompt (e.g. Anakin's Fear picker). Gate everything that follows
      // behind a second whenPromptCleared so the reveal prompt resolves
      // before runBeforeTricks fires its own prompts (e.g. Anakin's move).
      this.revealFaceDownCards();

      this.whenPromptCleared(() => {
        // Run "Before Tricks" effects for all cards on board
        this.runBeforeTricks();
        this.cleanupDead();

        const fp = this.state.firstPlayer;
        this.state.activePlayer = fp;
        this.state.selectedCard = null;
        this.state.selectedTrick = null;
        if (fp === 'player') {
          this.state.phase = 'player-tricks';
          this.clearHistory(); // new player turn — undo cannot cross this boundary
          UI.render();
          if (typeof Tutorial !== 'undefined' && Tutorial.active) Tutorial.notify('phase-tricks', {});
        } else {
          this.state.phase = 'ai-tricks';
          UI.render();
          // Multiplayer: don't run AI for the opponent.
          if (this.isMultiplayer()) return;
          // Hotseat: pass the device instead of running AI.
          if (this.isHotseat()) { this._hotseatHandoff(); return; }
          this._schedule(() => {
            const nextStep = () => {
              AI.playTrickPhaseCards('ai', () => {
                AI.playTricks('ai', () => this.endPhase3());
              });
            };
            // Red Skull: AI may also deploy character cards during its trick phase.
            if (this.getAllCardsOf('ai').some(c => c.passive === 'allowCardsInTricksPhase')) {
              AI.playCards('ai', nextStep);
            } else {
              nextStep();
            }
          }, 1200);
        }
      });
    });
  },

  runBeforeTricks() {
    // SEQUENTIAL pass — hooks that raise prompts (Man-Bat's move, Anakin's
    // pick) fire ONE AT A TIME: each next hook waits for the previous
    // prompt to resolve via whenPromptCleared. The old forEach fired every
    // hook synchronously, so two Man-Bats armed two lane prompts into the
    // single pendingLaneChoice slot — the second overwrote the first and
    // only one bat ever moved (user: "when there are 2 Man-Bats on the
    // field I could only move 1"). Order stays lane 1→6, so the
    // lower-lane bat prompts first — deterministic and readable.
    const queue = this.getAllCardsOnBoard().filter(c => c.onBeforeTricks && !c.beforeTricksFired);
    const finish = () => {
      // Drain bonus attacks queued during this pass (Anakin's fires NOW,
      // not at end of round — drainBonusAttacks is idempotent) and sweep
      // deaths. Runs once after ALL hooks + their prompts resolved.
      this.getAllCardsOnBoard().forEach(c => this.drainBonusAttacks(c));
      this.cleanupDead();
    };
    const step = () => {
      const c = queue.shift();
      if (!c) { finish(); return; }
      // Re-verify liveness at FIRE time, not just snapshot time — an earlier
      // hook in this same pass can remove this card from the board (Galactus's
      // devour voided Man-Bat, yet his move prompt still popped and the -1/-1
      // landed). Devour is removal, not damage — currentHealth stays intact —
      // so board presence (findCardLane) is the check that catches it; the
      // health check also skips kill-pending cards awaiting cleanupDead.
      const laneNow = this.findCardLane(c);
      if (laneNow < 0 || c.currentHealth <= 0 || c.beforeTricksFired) { step(); return; }
      c.beforeTricksFired = true;
      try { c.onBeforeTricks(this, c, laneNow); } catch (e) { console.error(e); }
      if (this.hasPendingPrompt()) this.whenPromptCleared(step);
      else step();
    };
    step();
  },

  endPhase3() {
    // Guest forwards Done to host (same as endPhase1/2).
    if (this.isMultiplayer() && this.mp && this.mp.role === 'guest') {
      if (typeof Multiplayer !== 'undefined') Multiplayer.send({ t: 'doneTurn' });
      return;
    }
    // Freddy Fazbear jump / passive check for the first player — after their
    // tricks phase so unspent energy is measured after ALL spending is done.
    this._checkFreddyFazbear(this.state.firstPlayer);
    // If Phase 3 left any player card jump-ready (Ghostface, Freddy Fazbear,
    // etc.), offer the jump modal before combat.
    if (this.isHuman('player') && !this.state.pendingJumpOffer) {
      const readyCard = this.state.player.hand.find(c => c.jumpReady);
      if (readyCard) this.state.pendingJumpOffer = { cardId: readyCard.id };
    }
    this.state.phase = 'combat';
    this.state.activePlayer = null;
    UI.render();
    this._schedule(() => this.resolveCombat(), 1000);
  },

  // ===================== PLAY CARDS / TRICKS =====================

  getCardCost(owner, card) {
    let cost = Math.max(0, card.cost - this.state[owner].discount);
    const opp = this.opponent(owner);
    this.getAllCardsOf(opp).forEach(c => { if (c.passive === 'enemyCostIncrease') cost += (c._surferCostBump || 1); });
    // Captain America's "WHILE ACTIVE: All cards in your hand cost
    // 1 less" — computed LIVE here so the discount automatically
    // vanishes when CA dies. User report: "his ability should go
    // away when he dies. Right now in hand, my card still cost
    // less when he was dead." Each active CA on the owner's side
    // contributes its rarity-tier discount (1 / 1 / 2 / 2). When
    // CA dies, getAllCardsOf no longer returns it → no discount
    // applied → next render shows full cost.
    this.getAllCardsOf(owner).forEach(c => {
      if (c.passive === 'allyCostReduction' && c.currentHealth > 0) {
        const disc = this.rarityValue(c, { common: 1, rare: 1, special: 2, legendary: 2 });
        cost -= disc;
      }
    });
    return Math.max(0, cost);
  },

  isCardBatmanBlocked(owner, card) {
    // batmanBlocked is the round the lock STARTS (always round + 1 from
    // Batman's onPlay). batmanBlockedUntil is the inclusive END round —
    // classic Batman omits it (single-turn lock, end = start), Text+
    // "Dark Knight" sets it to round + lockTurns for multi-turn locks.
    const start = this.state[owner].batmanBlocked;
    const until = this.state[owner].batmanBlockedUntil || start;
    if (!start || this.state.round < start || this.state.round > until) return false;
    const hand = this.state[owner].hand;
    if (!hand.length) return false;
    // Only lock the highest-cost card the opponent could actually play
    // this turn. Previously this locked the absolute highest cost in hand
    // — a 10-cost card they couldn't afford with round-6 energy made the
    // lock meaningless because they weren't going to play it anyway. The
    // intent is to deny their best playable card, so anchor the "highest"
    // to what they can currently pay for.
    // Snapshot the blocked cost the first time this is called each round (before the
    // player has spent any currency). Without caching, spending energy mid-turn lowers
    // "highest affordable" so that cheaper cards get locked on subsequent play attempts.
    // e.g. round 9, hand [10,5,5]: block correctly locks 10s. Player plays a 4-cost on
    // round 9 and enters the Batman-lock round with 5 currency — without caching the
    // check would recalculate and lock the 5s instead.
    if (this.state[owner].batmanBlockedCostRound !== this.state.round) {
      const currency = this.state[owner].currency || 0;
      const affordable = hand.filter(c => this.getCardCost(owner, c) <= currency);
      this.state[owner].batmanBlockedCost = affordable.length
        ? Math.max(...affordable.map(c => c.baseCost || c.cost))
        : null;
      this.state[owner].batmanBlockedCostRound = this.state.round;
    }
    const blockedCost = this.state[owner].batmanBlockedCost;
    if (blockedCost == null) return false;
    return (card.baseCost || card.cost) === blockedCost;
  },

  // ===================== playCard helpers =====================

  // Moder + Magneto can pre-empt the player's chosen lane. Returns the
  // (possibly redirected) laneIdx. Discard-effect cards bypass both
  // mechanics entirely. Idempotent — clears the forced-lane state once
  // the redirect either lands or fails (lane destroyed / occupied).
  _redirectForForcedLane(owner, card, laneIdx) {
    const _origLane = laneIdx;
    if (card.isDiscardEffect) return laneIdx;
    // Environments are a separate category — Moder/Magneto force COMBAT cards
    // into a lane, not the terrain. Return untouched so the forced-lane state
    // stays armed for the next real card played.
    if (card.isEnvironment) return laneIdx;
    // In multiplayer the guest's UI already visually locks them to the forced
    // lane — they can only click the forced lane, so their msg.lane IS the
    // forced lane. Trust their choice and only clear the state; don't override
    // their pick, which would create a race-condition window between the UI
    // lock appearing and the server processing the play.
    const mpGuestPlay = this.isMultiplayer() && this.mp.role === 'host' && owner !== 'player';
    // Moder forced lane — next non-discard card is pulled into forced lane.
    if (this.state[owner].forcedLane != null) {
      const fl = this.state[owner].forcedLane;
      this.state[owner].forcedLane = null;
      if (!mpGuestPlay) {
        const flLane = this.state.lanes[fl];
        if (flLane && !flLane.destroyed && !flLane[owner]) {
          laneIdx = fl;
          this.log(`[MODER] ${card.name} is pulled into lane ${fl + 1} by Moder!`);
        }
      }
    }
    // Old-Magneto forced-lane queue: the reader lived here until 2026-07-15.
    // Magneto's redesign (move 2 cards + parity aura) removed the only setter
    // of magnetoForcedLanes, so the queue-consumption block was deleted — a
    // stale queue in a reused/saved state could only misroute cards (it
    // auto-placed multiplayer guests into ascending lanes with no picker).
    // Defensive sweep: drop any residue so nothing downstream ever sees it.
    if (this.state[owner].magnetoForcedLanes) delete this.state[owner].magnetoForcedLanes;
    if (this.isMultiplayer() && laneIdx !== _origLane) {
      console.log('[MP HOST] _redirectForForcedLane:', card.name, 'owner:', owner, 'requested lane:', _origLane, '→ redirected to:', laneIdx);
    }
    return laneIdx;
  },

  // Batman Who Laughs intercept — when the playing side has a flagged
  // pending steal, the card transfers to the opponent's hand instead of
  // landing on the board. Player gets a destroy/keep choice; AI auto-
  // decides by cost. Returns true if the intercept fired (caller bails).
  _resolveBwlIntercept(owner, card, cost) {
    if (!this.state[owner].nextCardStolen) return false;
    // Environments are a separate category — Batman Who Laughs intercepts the
    // next enemy CARD, not the terrain. Don't consume the steal here so it
    // still lands on the next real card the opponent plays.
    if (card.isEnvironment) return false;
    this.state[owner].nextCardStolen = false;
    const opp = this.opponent(owner);
    // Mark BWL's owner as having consumed their 1-per-game intercept so
    // subsequent BWL plays on that side don't re-arm the steal.
    this.state[opp].bwlInterceptUsed = true;
    const idx = this.state[owner].hand.indexOf(card);
    if (idx > -1) this.state[owner].hand.splice(idx, 1);
    this.state[owner].currency -= cost;
    card.owner = opp;
    this.log(`[STOLEN] ${card.name} is intercepted by Batman Who Laughs!`);
    const bwl = this.getAllCardsOf(opp).find(c => c.name === 'The Batman Who Laughs');
    // isHuman(opp), NOT `opp === 'player'`. The 'ai' seat is a REAL PERSON in
    // 1v1 online (the guest), hotseat, and 2v2 (Team B) — the old literal seat
    // check handed all of them the AI's auto-decision, so those players were
    // never offered the keep/destroy choice at all. User report: "batman who
    // laughs hasnt been giving me the option to keep the card or kill."
    if (this.isHuman(opp)) {
      // Owner chooses keep or destroy via prompt.
      this.state[opp].stolenByBWL = { card, bwl };
      UI.render();
      this._startPromptTimeout(() => {
        const data = this.state[opp].stolenByBWL;
        if (!data) return;
        this.state[opp].stolenByBWL = null;
        // Default: keep (matches typical player intent — preserves a card)
        this.addToHand(opp, data.card, data.bwl);
        this.log(`  [BWL] You keep ${data.card.name} in hand!`);
        this.resumeCombatIfWaiting();
        UI.render();
      });
    } else {
      // AI auto-keeps high cost, destroys low cost.
      if (card.baseCost <= 3 && bwl) {
        this.buffCard(bwl, 2, 2);
        this.log(`  [BWL] ${this.seatLabel(opp)} destroys ${card.name} — Batman Who Laughs gains +2/+2!`);
      } else {
        this.addToHand(opp, card, bwl);
        this.log(`  [BWL] ${this.seatLabel(opp)} keeps ${card.name} in hand!`);
      }
    }
    return true;
  },

  // Hunt mechanic — any opponent card with hasHunt may chase the card
  // into its lane (frozen/stunned hunters can't move). Direct lane
  // assignment; onMoved fires post-relocation.
  _resolveHuntChase(opp, card, laneIdx) {
    this.getAllCardsOf(opp).forEach(c => {
      if (!c.hasHunt) return;
      if (c.isFrozen || c.isStunned) {
        this.log(`[HUNT BLOCKED] ${c.name} is ${c.isFrozen ? 'FROZEN' : 'STUNNED'} — can't hunt.`);
        return;
      }
      const from = this.findCardLane(c);
      if (from >= 0 && from !== laneIdx && !this.state.lanes[laneIdx][opp]) {
        this.state.lanes[from][opp] = null;
        this.state.lanes[laneIdx][opp] = c;
        this.log(`[HUNT] ${c.name} hunts ${card.name} to lane ${laneIdx + 1}!`);
        this.checkLaneTrap(c, laneIdx);
        if (c.onMoved) c.onMoved(this, c, laneIdx);
      }
    });
  },

  playCard(owner, card, laneIdx) {
    if (this.state.gameOver) return false;
    // Same anti-duplication guard as playCardFree: never place a card that is
    // already on the board (see the comment there for how 2v2 bridging let the
    // hand removal silently miss).
    if (card && this.findCardLane(card) >= 0) return false;
    // Iron Giant (and any future hand-guardian) can NEVER be placed on the
    // field — his whole card is the in-hand death-guard sacrifice, handled
    // by _ironGiantIntercept in handleDeath. Rejecting here covers every
    // entry point at once: UI lane clicks, AI plan queues, MP forwards.
    if (card && card._neverPlayable) {
      this.log(`[GUARD] ${card.name} can't be played onto the field — he guards from your hand.`);
      return false;
    }
    // Multiplayer guest: forward to host instead of executing locally.
    // Host applies the action and broadcasts the new state. We return
    // true so the UI's selectedCard state still advances optimistically;
    // the visible board update lands when the host's state push arrives.
    // _silentSim guard: previewPlacement() clones the state, stamps it
    // _silentSim, and calls playCard on the clone to compute the damage
    // preview. Without this guard the guest FORWARDS a real network play
    // for that dry-run — and since the board renders a preview for EVERY
    // open lane, selecting a card fired 6 phantom plays and the host
    // placed the card into lane 0 (the "jumps to lane 1 on click" bug).
    // In a sim we fall through to the local placement so the prediction
    // is real and nothing is sent.
    if (this.isMultiplayer() && this.mp.role === 'guest' && owner === this.mp.you && !(this.state && this.state._silentSim)) {
      if (typeof Multiplayer !== 'undefined' && card && card.id != null) {
        console.log('[MP GUEST] playCard:', card.name, 'lane:', laneIdx, '(0-based), visual lane:', laneIdx + 1);
        Multiplayer.send({ t: 'playCard', cardId: card.id, lane: laneIdx });
      }
      return true;
    }
    if (this.isCardBatmanBlocked(owner, card) && !card.isDiscardEffect) {
      this.log(`[BATMAN] ${card.name} is locked by Batman — cannot be played!`);
      return false;
    }
    laneIdx = this._redirectForForcedLane(owner, card, laneIdx);
    const lane = this.state.lanes[laneIdx];
    if (!lane || lane.destroyed) return false;
    // Snapshot before any player-initiated card play so the action can be undone.
    if (owner === 'player' && this.isPlayerTurn()) this.snapshot();
    const who = owner === 'player' ? 'You' : 'AI';

    // Discard effects — card is spent for its onDiscard effect and goes
    // to the DISCARD pile (not the dead pile). This keeps them out of
    // revival / summon-from-dead mechanics: Lazarus Pit, Hela's "draw
    // from the dead pile", and any other card that recycles the dead
    // pile will not see discard-effect cards. Previously these lived
    // in deadPile, which meant Mr. Fantastic / Catwoman / Jigsaw could
    // be revived and re-played multiple times per game — a big reason
    // their plays-per-draft ratio was 6-22× in the sim.
    if (card.isDiscardEffect) {
      const cost = this.getCardCost(owner, card);
      if (this.state[owner].currency < cost) return false;
      // Pre-consume gate — a discard effect with no valid use must refuse
      // BEFORE the card and energy are spent. Prof X with a full board (or
      // no convertible enemy) used to consume the card and then strand the
      // conversion (user MP report: "Prof X can't be played because there
      // is no space to place the converted card").
      if (card.canDiscard && !card.canDiscard(this, owner, card)) {
        const reason = card._discardBlockReason || 'No valid use right now';
        this.log(`[DISCARD] ${card.name} can't be used — ${reason}`);
        if (typeof UI !== 'undefined' && UI.showAITrickToast) {
          UI.showAITrickToast(card.name, reason, 'error');
        }
        return false;
      }
      this.state[owner].currency -= cost;
      if (this.state._stats && this.state._stats[owner]) this.state._stats[owner].energySpent += cost;
      const idx = this.state[owner].hand.indexOf(card);
      if (idx > -1) this.state[owner].hand.splice(idx, 1);
      this.state[owner].discardPile.push({
        name: card.name, cost: card.baseCost || card.cost,
        type: card.type, abilities: card.abilities, desc: card.desc,
        isDiscardEffect: true,
        // Keep a reference to the original card instance so stats hooks
        // (e.g. statsDiscountValue credit in drawCards) can attribute
        // to the real instance that still has its stat fields.
        _sourceInstance: card
      });
      this.log(`[DISCARD] ${who} discard ${card.name} for its effect`);
      // Pass the card instance into onDiscard so ability hooks can
      // self-reference (e.g. to set discount sources for stats credit).
      if (card.onDiscard) card.onDiscard(this, owner, card);
      this.state[owner].discount = 0;
      // Surface AI discard plays to the player via the same toast that
      // announces AI tricks — discards were previously invisible unless
      // the player was watching the log carefully.
      if (owner === 'ai' && typeof UI !== 'undefined' && UI.showAITrickToast) {
        UI.showAITrickToast(card.name, card.desc || '', 'discard');
      }
      return true;
    }

    // Environments go to the _env sub-slot; normal cards go to the main combat slot.
    // Envs can always be played (replacing an existing env); only regular cards block on the main slot.
    if (!card.isEnvironment && lane[owner]) return false;
    const cost = this.getCardCost(owner, card);
    if (this.state[owner].currency < cost) return false;

    const opp = this.opponent(owner);
    // Batman Who Laughs intercept — extracted to _resolveBwlIntercept;
    // returns true if the steal fired, in which case we bail out of the
    // normal play flow.
    if (this._resolveBwlIntercept(owner, card, cost)) return true;

    this.state[owner].currency -= cost;
    if (this.state._stats && this.state._stats[owner]) this.state._stats[owner].energySpent += cost;
    // MVP — if this card was drawn by another card's ability (e.g. Hela's
    // dead-pile pull), credit the drawer + its chain with the card's
    // base cost as energy generated. Only fires on successful play,
    // matching user spec: "if you don't play the drawn card, Hela gets
    // 0 for it; if you do, she gets its cost".
    if (card._drawnBy && card._drawnBy.id !== card.id) {
      this._creditChain(card._drawnBy, 'statsEnergyGenerated', card.baseCost || card.cost || 0);
    }
    const idx = this.state[owner].hand.indexOf(card);
    if (idx > -1) this.state[owner].hand.splice(idx, 1);

    // Environment cards occupy the _env sub-slot so allies can share the lane.
    // They don't participate in combat, can't be attacked, and skip most on-play hooks.
    if (card.isEnvironment) {
      if (!lane._env) lane._env = {};
      // Only one environment may be active per lane — kill any existing env from
      // either side before placing the new one so its effects are cleaned up.
      // CRITICAL: also null the slot. handleDeath doesn't know about _env
      // sub-slots, so a replaced OPPONENT env would otherwise stay referenced
      // as a dead zombie — still receiving onAnyCardPlayed / onTurnStart
      // broadcasts. User report: replaced enemy Boiler Room kept burning
      // newly arrived cards (Jaws spawned in already on fire).
      const envOpp = this.opponent(owner);
      [owner, envOpp].forEach(side => {
        const existing = lane._env[side];
        if (existing && existing !== card) {
          existing.currentHealth = 0;
          this.handleDeath(existing, laneIdx, null);
          lane._env[side] = null;
        }
      });
      lane._env[owner] = card;
      this.emitFX('envReveal', { lane: laneIdx, owner, name: card.name });
      if (card.statsEnteredRound == null) card.statsEnteredRound = this.state.round || 1;
      this.state[owner].discount = 0;
      this.log(`[PLAY] ${who} place ${card.name} in lane ${laneIdx + 1} for ${cost} energy`);
      this._runHook(card, 'onPlay', this, card, laneIdx);
      this.broadcastHook('onAnyCardPlayed', card, [card]);
      this.checkJumpConditions('cardPlayed', { owner, cost: card.baseCost || card.cost, laneIdx, isEnvironment: true });
      this.applyMagnetoDebuffs();
      if (typeof UI !== 'undefined' && UI.render) UI.render();
      return true;
    }

    // Slot and card.owner must always agree — the engine's cleanup invariant
    // checks it, and a mismatch makes combat/targeting read the wrong side.
    // 2v2 jump/free plays surfaced this: a card owned by one side landing in
    // the other side's slot. placeInLane already stamped; these paths didn't.
    card.owner = owner;
    lane[owner] = card;
    this._emitEntranceFX(card);
    if (card.statsEnteredRound == null) card.statsEnteredRound = this.state.round || 1;
    this.state[owner].discount = 0;

    // Face-down play — suppress all abilities, hide from opponent
    if (card._playFaceDown) {
      card.isFaceDown = true;
      card._faceDownOriginals = {
        onPlay: card.onPlay, onDeath: card.onDeath, onDamaged: card.onDamaged,
        onKill: card.onKill, onBeforeTricks: card.onBeforeTricks, onBeforeAttack: card.onBeforeAttack,
        onEndOfTurn: card.onEndOfTurn, onAnyCardPlayed: card.onAnyCardPlayed, onAllyKilled: card.onAllyKilled,
        onEnemyKilled: card.onEnemyKilled,
        onEvade: card.onEvade, onDamagePlayer: card.onDamagePlayer, onTurnStart: card.onTurnStart,
        onLaneResolved: card.onLaneResolved,
        passive: card.passive
      };
      card.onPlay = null; card.onDeath = null; card.onDamaged = null;
      card.onKill = null; card.onBeforeTricks = null; card.onBeforeAttack = null;
      card.onEndOfTurn = null; card.onAnyCardPlayed = null; card.onAllyKilled = null;
      card.onEnemyKilled = null;
      card.onEvade = null; card.onDamagePlayer = null; card.onTurnStart = null;
      card.onLaneResolved = null;
      card.passive = null;
      delete card._playFaceDown;
      this.log(`[PLAY] ${who} play a card face down in lane ${laneIdx + 1} for ${cost} energy`);
      this.state[owner].discount = 0;
      this.checkLaneTrap(card, laneIdx);
      this.checkJumpConditions('cardPlayed', { owner, cost: card.baseCost || card.cost, laneIdx });
      return true;
    }

    this.log(`[PLAY] ${who} play ${card.name} (${card.attack}/${card.currentHealth}) in lane ${laneIdx + 1} for ${cost} energy`);
    this.checkLaneTrap(card, laneIdx);

    // Lone wolf: +1/+1 when played with no other allies on the board (environments don't count)
    const otherAllies = this.getAllCardsOf(owner).filter(c => c.id !== card.id && c.currentHealth > 0 && !c.isEnvironment);
    if (otherAllies.length === 0) {
      this.buffCard(card, 1, 1);
      this.log(`  [LONE WOLF] ${card.name} enters alone — +1/+1!`);
    }

    // Activate "While Active" passives immediately
    if (card.passive === 'faceDownOption') this.state[owner].faceDownAvailable = true;

    this.broadcastHook('onAnyCardPlayed', card, [card]);
    this.getAllCardsOf(owner).forEach(c => {
      if (c.passive === 'cardPlayedBuff' && c.id !== card.id) { const n = c._bpAuraSize || 1; this.buffCard(card, n, n); }
    });

    // Hunt mechanic — extracted to _resolveHuntChase. Frozen/stunned
    // hunters can't move; direct-lane assignment fires onMoved post-jump.
    this._resolveHuntChase(opp, card, laneIdx);

    this._runHook(card, 'onPlay', this, card, laneIdx);
    // Draw-on-play trait — resolves after onPlay. Zeroing drawOnPlay removes the badge from the board display.
    if (card.drawOnPlay > 0) {
      const n = card.drawOnPlay;
      card.drawOnPlay = 0;
      // Snapshot pre-draw hand so we can credit only the cards that
      // actually entered hand (hand-cap / empty-pile can short the draw).
      const before = this.state[owner].hand.length;
      this.drawCards(owner, n);
      const actuallyDrawn = this.state[owner].hand.length - before;
      if (actuallyDrawn > 0) this._creditChain(card, 'statsCardAdvantage', actuallyDrawn);
      this.log(`${card.name} draws ${n} card${n > 1 ? 's' : ''}.`);
    }
    // Cantrip etch — draw 1 (per stack) right after onPlay + drawOnPlay.
    this._resolveCantripOnPlay(card);
    // Status etches — fire on play. Fear/Freeze pick a single enemy
    // for N turns; MC picks up to N enemies for the turn; Mark grants
    // adjacent allies Bullseye.
    this._resolveFearOnPlay(card);
    this._resolveFreezeOnPlay(card);
    this._resolveMindControlOnPlay(card);
    this._resolveMarkOnPlay(card);
    this.cleanupDead();
    // Apply Magneto debuffs to newly placed cards
    this.applyMagnetoDebuffs();
    // Check jump conditions — enemy played a card (pass laneIdx so MM can lock its lane)
    this.checkJumpConditions('cardPlayed', { owner, cost: card.baseCost || card.cost, laneIdx });
    this._scaleDoomsdayOnOwnerPlay(owner);
    if (owner === 'player' && typeof Tutorial !== 'undefined' && Tutorial.active) {
      Tutorial.notify('card-played', { laneIdx, card });
    }
    return true;
  },

  playCardFree(owner, card, laneIdx) {
    // A card already standing on the board can NEVER be placed again. The jump
    // / free-play path removes the card from hand with hand.indexOf(card), and
    // in 2v2 the side proxy is bridged to whichever player is ACTIVE — so when
    // a jump fires for a different seat (Freddy Fazbear wakes on the opponent's
    // unspent energy; Stripe/Jason trigger off damage) the card isn't in that
    // hand, the splice silently no-ops, and the very same object gets assigned
    // into a second lane. The fuzzer saw one Stripe instance occupying two
    // lanes ~900x per 60 games, plus cards sitting on the wrong side. Refusing
    // an already-placed card kills that corruption at the source.
    if (card && this.findCardLane(card) >= 0) return false;
    // Iron Giant guards from HAND and must never stand on the field. playCard
    // enforced this but the jump / free-play path did not, so he still reached
    // the board (the fuzzer caught him there). Same guard, every placement path.
    if (card && card._neverPlayable) {
      this.log(`[GUARD] ${card.name} can't be played onto the field — he guards from your hand.`);
      return false;
    }
    // Multiplayer guest: forward the free-play action and let the host run it.
    // _silentSim guard — see playCard: a preview sim must place locally on
    // the clone, never forward a network play.
    if (this.isMultiplayer() && this.mp.role === 'guest' && owner === this.mp.you && !(this.state && this.state._silentSim)) {
      if (typeof Multiplayer !== 'undefined' && card && card.id != null) {
        Multiplayer.send({ t: 'playCardFree', cardId: card.id, lane: laneIdx });
      }
      return true;
    }
    if ((!card.isEnvironment && this.state.lanes[laneIdx][owner]) || this.state.lanes[laneIdx].destroyed) return;
    const opp = this.opponent(owner);
    // Intercepted by Batman Who Laughs — even jump/free plays should be
    // stolen. Previously jump-path cards (Michael Myers locking onto his
    // target, Ghostface / Jason jumping into an open lane) skipped the
    // intercept check that lives in playCard(), so they'd land on the
    // board normally while BWL's nextCardStolen flag remained active.
    if (this.state[owner].nextCardStolen) {
      this.state[owner].nextCardStolen = false;
      // Mark BWL's owner as having consumed their 1-per-game intercept.
      this.state[opp].bwlInterceptUsed = true;
      const idx0 = this.state[owner].hand.indexOf(card);
      if (idx0 > -1) this.state[owner].hand.splice(idx0, 1);
      card.owner = opp;
      this.log(`[STOLEN] ${card.name} is intercepted by Batman Who Laughs (via jump)!`);
      const bwl = this.getAllCardsOf(opp).find(c => c.name === 'The Batman Who Laughs');
      // Same isHuman gate as _resolveBwlIntercept — the jump path had the
      // identical hardcoded-seat bug.
      if (this.isHuman(opp)) {
        this.state[opp].stolenByBWL = { card, bwl };
        UI.render();
        this._startPromptTimeout(() => {
          const data = this.state[opp].stolenByBWL;
          if (!data) return;
          this.state[opp].stolenByBWL = null;
          this.addToHand(opp, data.card, data.bwl);
          this.log(`  [BWL] You keep ${data.card.name} in hand!`);
          this.resumeCombatIfWaiting();
          UI.render();
        });
      } else {
        if (card.baseCost <= 3 && bwl) {
          this.buffCard(bwl, 2, 2);
          this.log(`  [BWL] ${this.seatLabel(opp)} destroys ${card.name} — Batman Who Laughs gains +2/+2!`);
        } else {
          this.addToHand(opp, card, bwl);
          this.log(`  [BWL] ${this.seatLabel(opp)} keeps ${card.name} in hand`);
        }
      }
      return;
    }
    const idx = this.state[owner].hand.indexOf(card);
    if (idx > -1) this.state[owner].hand.splice(idx, 1);
    const freeLane = this.state.lanes[laneIdx];
    if (card.isEnvironment) {
      if (!freeLane._env) freeLane._env = {};
      // Only one environment per lane — kill any existing from either side.
      // Null the slot too (same zombie-env fix as the playCard branch).
      const envOpp = this.opponent(owner);
      [owner, envOpp].forEach(side => {
        const existing = freeLane._env[side];
        if (existing && existing !== card) {
          existing.currentHealth = 0;
          this.handleDeath(existing, laneIdx, null);
          freeLane._env[side] = null;
        }
      });
      card.owner = owner;   // slot/owner must agree (see playCard)
      freeLane._env[owner] = card;
      this.emitFX('envReveal', { lane: laneIdx, owner, name: card.name });
    } else {
      card.owner = owner;   // slot/owner must agree (see playCard)
      freeLane[owner] = card;
      this._emitEntranceFX(card);
    }
    if (card.statsEnteredRound == null) card.statsEnteredRound = this.state.round || 1;
    this.log(`[FREE PLAY] ${card.name} in lane ${laneIdx + 1}`);
    this.checkLaneTrap(card, laneIdx);

    // Trigger "While Active" buffs from allies (e.g. Black Panther +1/+1)
    this.broadcastHook('onAnyCardPlayed', card, [card]);
    this.getAllCardsOf(owner).forEach(c => {
      if (c.passive === 'cardPlayedBuff' && c.id !== card.id) {
        const n = c._bpAuraSize || 1;
        this.buffCard(card, n, n);
        this.log(`  [BUFF] ${c.name} gives ${card.name} +${n}/+${n}`);
      }
    });

    this._runHook(card, 'onPlay', this, card, laneIdx);
    // Draw-on-play — free/jump plays honor Draw N exactly like playCard
    // (user report: jumped Ahsoka's Draw 1 never fired).
    if (card.drawOnPlay > 0) {
      const n = card.drawOnPlay;
      card.drawOnPlay = 0;
      const before = this.state[owner].hand.length;
      this.drawCards(owner, n);
      const actuallyDrawn = this.state[owner].hand.length - before;
      if (actuallyDrawn > 0) this._creditChain(card, 'statsCardAdvantage', actuallyDrawn);
      this.log(`${card.name} draws ${n} card${n > 1 ? 's' : ''}.`);
    }
    // Cantrip etch — draw 1 on play (jump / free-play path).
    this._resolveCantripOnPlay(card);
    this._resolveFearOnPlay(card);
    this._resolveFreezeOnPlay(card);
    this._resolveMindControlOnPlay(card);
    this._resolveMarkOnPlay(card);
    this.cleanupDead();
    this._scaleDoomsdayOnOwnerPlay(owner);
  },

  getTrickCost(owner, trick) {
    let cost = trick.cost;
    const opp = this.opponent(owner);
    // Each Sandman adds his rarity-scaled tax to the enemy's trick cost.
    // Common: +0 (just a body), Rare: +1 (listed), Special: +2,
    // Legendary: +3. Defaults to +1 in classic mode (no _runRarity).
    this.getAllCardsOf(opp).forEach(c => {
      if (c.passive === 'trickCostIncrease') {
        const tax = this.rarityValue(c, { common: 0, rare: 1, special: 2, legendary: 3 });
        cost += tax;
      }
    });
    return cost;
  },

  playTrick(owner, trick) {
    if (this.state.gameOver) return false;
    // Multiplayer guest: forward and bail. _silentSim guard — see playCard:
    // a preview/prediction sim must run locally on the clone, never forward.
    if (this.isMultiplayer() && this.mp.role === 'guest' && owner === this.mp.you && !(this.state && this.state._silentSim)) {
      if (typeof Multiplayer !== 'undefined' && trick && trick.id != null) {
        Multiplayer.send({ t: 'playTrick', trickId: trick.id });
      }
      return true;
    }
    const cost = this.getTrickCost(owner, trick);
    if (this.state[owner].currency < cost) return false;
    // Time Stone freeze — a countered trick is locked out for the rest of
    // the round no matter WHO tries to replay it. The block used to live
    // only in AI.playTricks' filter, so a human whose trick was countered
    // could replay it immediately (MP report: "I got the stone back... but
    // then I was able to play it again"). Enforce at the engine gate.
    if (trick._timeStonedAtRound === this.state.round) {
      this.log(`[TIME STONE] ${trick.name} is frozen this round — it cannot be replayed.`);
      if (typeof UI !== 'undefined' && UI.showAITrickToast) {
        UI.showAITrickToast('Frozen by Time Stone', `${trick.name} is blocked until next round`, 'error');
      }
      return false;
    }
    // Check if the trick has valid targets before consuming it
    if (trick.canPlay && !trick.canPlay(this, owner)) {
      this.log(`[TRICK] ${trick.name} cannot be played — no valid targets!`);
      UI.render();
      return false;
    }
    // ---- Time Stone counter-intercept ----
    // SEAT-AGNOSTIC: whenever any owner plays a hostile trick and the
    // DEFENDING seat (the caster's opponent) is a human holding Time Stone,
    // pause and offer the counter to that defender. Covers solo (AI plays →
    // you counter, as always — the AI seat is never human in solo so your
    // plays don't intercept) and BOTH directions of 1v1 online. The old
    // wiring hardcoded owner==='ai' countered by the host's 'player' seat,
    // so in multiplayer the modal broadcast ungated to BOTH clients and the
    // guest's own Time Stone could never react at all.
    const tsDefender = this.opponent(owner);
    if (!trick._timeStoneChecked && this.isHuman(tsDefender)
        && !this.state.pendingTimeStoneIntercept
        && this._seatHasTimeStone(tsDefender) && this._isHostileTrick(trick)
        && trick.name !== 'Time Stone') {
      this.state.pendingTimeStoneIntercept = {
        incomingTrick: trick,
        incomingOwner: owner,
        defender: tsDefender
      };
      if (typeof UI !== 'undefined' && UI.render) UI.render();
      // Host: push the armed intercept to the guest immediately — the guest
      // may be the defender and needs the modal now, not on the next action.
      if (this.isMultiplayer() && this.mp.role === 'host') this._mpBroadcast();
      return false; // caller's loop pauses via whenPromptCleared / hasPendingPrompt
    }
    // Snapshot before any player-initiated trick play so the action can be undone.
    if (owner === 'player' && this.isPlayerTurn()) this.snapshot();
    this.state[owner].currency -= cost;
    if (this.state._stats && this.state._stats[owner]) this.state._stats[owner].energySpent += cost;
    const idx = this.state[owner].trickHand.indexOf(trick);
    if (idx > -1) this.state[owner].trickHand.splice(idx, 1);
    // Move to played trick pile
    this.state[owner].playedTrickPile.push({ name: trick.name, cost: trick.cost });
    // Track tricks for the round recap
    if (this.state._roundStats) {
      const rs = this.state._roundStats;
      (owner === 'player' ? rs.playerTricks : rs.aiTricks).push(trick.name);
    }
    const who = owner === 'player' ? 'You' : 'AI';
    this.log(`[TRICK] ${who} play ${trick.name} for ${cost} energy`);
    // Surface EVERY trick as the center-screen reveal — yours labelled
    // "You play a Trick", the opponent's with their name (user: "I played
    // Eye of Agamotto and the new trick screen didn't pop up").
    // showTrickReveal queues sequential plays and falls back under reduced
    // motion. Covers solo both ways and, on the MP host, both seats; the
    // MP guest sees ALL plays via the playedTrickPile diff in the
    // state-accept handler (never runs this engine path locally).
    if (typeof UI !== 'undefined') {
      if (UI.showTrickReveal) UI.showTrickReveal(trick.name, trick.desc || '', trick.cost, owner === 'player');
      else if (owner === 'ai' && UI.showAITrickToast) UI.showAITrickToast(trick.name, trick.desc || '');
    }
    if (trick.play) {
      // Flag the trick-execution window so _trickBlocked can gate effects
      // targeting Untrickable cards (including every 10-cost titan, which
      // applyAbilities auto-flags). The flag clears even if the trick
      // throws, so a broken trick can't leave the game in trick-mode.
      this.state._inTrick = true;
      this.state._trickOwner = owner;
      try { trick.play(this, owner); } catch (e) { console.error(e); }
      this.state._inTrick = false;
      this.state._trickOwner = null;
    }
    this.cleanupDead();
    // Check jump conditions — a trick was played
    this.checkJumpConditions('trickPlayed', { owner });
    // Dispatch onAnyTrickPlayed to every live card with that hook.
    // Used by Darth Maul (passive: +2/+0 each time a Trick is played
    // by either player) and any future "react to tricks" passive.
    // Fired AFTER cleanupDead so we only buff survivors, and after
    // checkJumpConditions so jumps stay event-ordered consistently.
    this.broadcastHook('onAnyTrickPlayed', null, [owner, trick]);
    return true;
  },

  // ---- Time Stone helpers ----
  // Seat-agnostic: does this seat hold a usable Time Stone? (One that was
  // itself frozen this round doesn't count.)
  _seatHasTimeStone(seat) {
    const p = this.state[seat];
    return !!(p && p.trickHand
      && p.trickHand.find(t => t && t.name === 'Time Stone'
          && t._timeStonedAtRound !== this.state.round));
  },
  // Predicate: does this trick negatively affect the opponent of its
  // caster? Uses an explicit `hostile` flag when set on the trick def,
  // else falls back to a keyword scan of the description. The list is
  // permissive — marginal tricks pop the modal; the player just clicks
  // "let it resolve" if they don't want to spend Time Stone on it.
  _isHostileTrick(trick) {
    if (!trick) return false;
    if (trick.hostile === true) return true;
    if (trick.hostile === false) return false;
    // Explicit whitelist of tricks that harm player cards when played
    // by the AI. All other tricks (buffs / summons / peeks) don't
    // trigger Time Stone's counter prompt — spec: "whenever an enemy
    // plays a trick … that would negatively effect [your cards]".
    const HOSTILE_TRICKS = new Set([
      'Batarangs',       // direct damage
      'Kryptonite',      // -3 ATK from enemy
      'The Darkhold',    // destroy low-ATK enemies
      'Fear Toxin',      // fear
      'Phantom Zone',    // bounce enemy to hand
      'Soul Stone',      // destroys one enemy (+own card)
      'Anti-Life Equation', // destroys contested-lane cards both sides
      'Mind Stone',      // mind control
      'Reality Stone'    // swap stats — net-positive for AI, hurts player
    ]);
    if (HOSTILE_TRICKS.has(trick.name)) return true;
    return false;
  },
  // Defender chose to counter. Consume THEIR Time Stone, freeze the
  // incoming trick for this round (it stays in the caster's hand), draw
  // the defender a card, resume whatever loop was paused. Seat-agnostic:
  // intercept.defender is 'player' in solo and either seat in 1v1 online.
  timeStoneCounter() {
    const intercept = this.state.pendingTimeStoneIntercept;
    if (!intercept) return;
    const trick = intercept.incomingTrick;
    const defender = intercept.defender || 'player';
    this.state.pendingTimeStoneIntercept = null;
    const hand = this.state[defender].trickHand;
    const idx = hand.findIndex(t => t && t.name === 'Time Stone');
    if (idx < 0) {
      this.log('[TIME STONE] Not in hand — trick resolves normally.');
      // Pass the intercept through — it was already cleared above, so the
      // old re-read-from-state fallback silently dropped the trick here.
      this.timeStoneAllow(intercept);
      return;
    }
    hand.splice(idx, 1);
    this.state[defender].playedTrickPile.push({ name: 'Time Stone', cost: 0 });
    if (this.state._roundStats) {
      const rs = this.state._roundStats;
      (defender === 'player' ? rs.playerTricks : rs.aiTricks).push('Time Stone');
    }
    // Freeze the incoming trick for the rest of this round. Enforced at the
    // playTrick gate for EVERY caller (human replay included) + the solo
    // AI.playTricks filter; startRound clears the flag next round.
    trick._timeStonedAtRound = this.state.round;
    this.log(`[TIME STONE] ${defender === 'player' ? 'You' : 'Opponent'} freeze${defender === 'player' ? '' : 's'} time! ${trick.name} is undone and returned to the caster's hand.`);
    // Reward for countering — draw a card.
    this.drawCards(defender, 1);
    this.log(`[TIME STONE] ${defender === 'player' ? 'You draw' : 'Opponent draws'} a card.`);
    if (typeof UI !== 'undefined' && UI.render) UI.render();
    if (this.isMultiplayer() && this.mp.role === 'host') this._mpBroadcast();
    this.resumeCombatIfWaiting();
  },
  // Defender declined. Flag the trick so the intercept doesn't re-fire,
  // then re-enter playTrick as the ORIGINAL caster (not hardcoded 'ai').
  // Accepts an intercept override for the counter's not-in-hand fallback.
  timeStoneAllow(_intercept) {
    const intercept = _intercept || this.state.pendingTimeStoneIntercept;
    if (!intercept) return;
    const trick = intercept.incomingTrick;
    this.state.pendingTimeStoneIntercept = null;
    trick._timeStoneChecked = true;
    this.playTrick(intercept.incomingOwner || 'ai', trick);
    if (typeof UI !== 'undefined' && UI.render) UI.render();
    if (this.isMultiplayer() && this.mp.role === 'host') this._mpBroadcast();
    this.resumeCombatIfWaiting();
  },

  // ===================== COMBAT =====================

  revealFaceDownCards() {
    for (let i = 0; i < this.LANE_COUNT; i++) {
      ['player', 'ai'].forEach(side => {
        const card = this.state.lanes[i][side];
        if (card && card.isFaceDown && card._faceDownOriginals) {
          const orig = card._faceDownOriginals;
          card.onPlay = orig.onPlay; card.onDeath = orig.onDeath; card.onDamaged = orig.onDamaged;
          card.onKill = orig.onKill; card.onBeforeTricks = orig.onBeforeTricks; card.onBeforeAttack = orig.onBeforeAttack;
          card.onEndOfTurn = orig.onEndOfTurn; card.onAnyCardPlayed = orig.onAnyCardPlayed; card.onAllyKilled = orig.onAllyKilled;
          card.onEnemyKilled = orig.onEnemyKilled;
          card.onEvade = orig.onEvade; card.onDamagePlayer = orig.onDamagePlayer; card.onTurnStart = orig.onTurnStart;
          card.onLaneResolved = orig.onLaneResolved;
          card.passive = orig.passive;
          delete card._faceDownOriginals;
          card.isFaceDown = false;
          this.log(`[REVEAL] ${card.name} is revealed in lane ${i + 1}!`);
          this._runHook(card, 'onPlay', this, card, i);
          // Fire draw-on-play / cantrip that were suppressed while face-down.
          if (card.drawOnPlay > 0) {
            const n = card.drawOnPlay;
            card.drawOnPlay = 0;
            this.drawCards(card.owner, n);
            this.log(`${card.name} draws ${n} card${n > 1 ? 's' : ''}.`);
          }
          this._resolveCantripOnPlay(card);
          this.applyMagnetoDebuffs();
        }
      });
    }
    this.cleanupDead();
  },

  // Poison Ivy charmed allies — each charmed ally takes a free pre-combat
  // swing in Ivy's recorded lane (stored as _ivyCharmedLane on the ally
  // when she charmed them). Works even if Ivy is already dead — the lane
  // is locked in at charm time and the swing fires regardless. After the
  // swing, _ivyCharmedLane is cleared so the ally only gets ONE extra
  // swing per charm, and their normal combat attack proceeds in their own
  // lane as usual.
  resolveIvyCharms() {
    // Snapshot the list once (mutation during the loop is OK because we
    // use the pre-combat stamp). If the originally-charmed ally died /
    // was stunned / lost its ATK, transfer the charm to another living
    // ally on the same side — matches spec: "if the person with the
    // trait dies, it just switches to a different ally."
    const charmed = this.getAllCardsOnBoard().filter(c => c._ivyCharmedLane !== undefined);
    charmed.forEach(ally => {
      const laneIdx = ally._ivyCharmedLane;
      const owner = ally._ivyCharmOwner;
      delete ally._ivyCharmedLane;
      delete ally._ivyCharmOwner;
      const canSwing = (c) => c && c.currentHealth > 0 && !c.isStunned && !c.isFrozen && (c.attack || 0) > 0;
      let swinger = ally;
      if (!canSwing(swinger)) {
        // Find another living ally on the same side to inherit the charm.
        // Prefer highest-attack so the swing is still meaningful.
        const candidates = this.getAllCardsOf(owner)
          .filter(c => c.id !== ally.id && canSwing(c));
        if (candidates.length) {
          swinger = candidates.sort((a, b) => (b.attack || 0) - (a.attack || 0))[0];
          this.log(`[POISON IVY] ${ally.name} fell — charm transfers to ${swinger.name}!`);
        } else {
          this.log(`[POISON IVY] ${ally.name} is unable to assist and no ally can inherit the charm.`);
          return;
        }
      }
      if (laneIdx < 0 || laneIdx >= this.LANE_COUNT || this.state.lanes[laneIdx].destroyed) return;
      const opp = this.opponent(owner);
      const enemy = this.state.lanes[laneIdx][opp];
      if (enemy && enemy.currentHealth > 0) {
        this.log(`[POISON IVY] ${swinger.name} attacks ${enemy.name} in Ivy's lane for ${swinger.attack}!`);
        this.applyCombatDamage(swinger, enemy);
      } else {
        this.log(`[POISON IVY] ${swinger.name} hits opponent HP for ${swinger.attack} from Ivy's lane!`);
        this.damagePlayer(opp, swinger.attack, swinger.isBullseye, swinger);
      }
    });
    this.cleanupDead();
  },

  // Delay (ms) between each lane resolving in combat so the player can watch.
  // Rebalanced: Normal bumped up (users were finding it too fast to follow);
  // Slow noticeably more contemplative than before so the three tiers feel
  // distinct. Fast kept close to original for players who want to blitz.
  get COMBAT_LANE_DELAY() {
    const mode = (typeof UI !== 'undefined' && UI.settings && UI.settings.aiSpeed) || 'normal';
    return { fast: 280, normal: 900, slow: 1500 }[mode] || 900;
  },
  get COMBAT_POST_DELAY() {
    const mode = (typeof UI !== 'undefined' && UI.settings && UI.settings.aiSpeed) || 'normal';
    return { fast: 350, normal: 1100, slow: 1800 }[mode] || 1100;
  },

  resolveCombat() {
    // Arm the anti-freeze watchdog at the TOP — before the pre-combat prompt
    // guards below can park and return. Those parks (onBeforeCombat /
    // before-tricks hooks raising a prompt) happen BEFORE _inCombat is set, so
    // an orphaned MP prompt there would otherwise hang with no watchdog armed.
    // The watchdog's liveness now keys on phase==='combat', so it covers this
    // whole window. Idempotent + skipped in sims/headless (see _armCombatWatchdog).
    this._armCombatWatchdog();
    // Pre-combat choices (e.g. Han Solo lane redirect) — fire onBeforeCombat
    // hooks once per combat, then re-enter. Prompt-setting hooks will be
    // picked up by the hasPendingPrompt guard below on the next call.
    if (!this.state._beforeCombatFired) {
      this.state._beforeCombatFired = true;
      this.getAllCardsOnBoard().forEach(c => {
        if (c.onBeforeCombat && c.currentHealth > 0) {
          try { c.onBeforeCombat(this, c, this.findCardLane(c)); } catch (e) { console.error(e); }
        }
      });
      if (this.hasPendingPrompt()) {
        this.whenPromptCleared(() => this.resolveCombat());
        return;
      }
    }
    delete this.state._beforeCombatFired;
    // If an async prompt from Before-Tricks (e.g. Man-Bat's lane choice) is still pending,
    // wait for it to resolve before starting combat. Otherwise combat captures cached
    // lane references and can land a hit on a card that has already moved out.
    if (this.hasPendingPrompt()) {
      this.whenPromptCleared(() => this.resolveCombat());
      return;
    }
    // Phase 1 dual-run instrument — captures the predictor's forecast
    // BEFORE combat runs so postCombat can compare actual outcomes vs.
    // predicted. Off by default; set Game.DEBUG_DUAL_RUN = true in
    // devtools to surface predictor/resolver divergences.
    if (this.DEBUG_DUAL_RUN) {
      try {
        // predictCombatGlobal returns { byId: Map<id, {hpAfter, dies, dmgIn}> }.
        // Stash the Map directly so dualRunDiff sees the right shape.
        const pred = this.predictCombatGlobal();
        this._dualRunForecast = pred && pred.byId ? pred.byId : null;
      } catch (e) { console.warn('[DUAL-RUN] forecast capture failed', e); }
    }
    // Snapshot pre-combat state so the player can undo a "Done Playing Tricks" click.
    this.snapshot();
    this.log('--- Combat Phase ---');
    // Combat batches queued bonus attacks to postCombat; flag so handleDeath
    // doesn't also drain them mid-lane and cause double-fires.
    this.state._inCombat = true;
    // Re-arm as real combat begins — this resets the watchdog's progress clock
    // so any time spent waiting on a pre-combat prompt above doesn't eat into
    // the mid-combat idle budget. (Already armed at the top of resolveCombat.)
    this._armCombatWatchdog();
    // Board-wide circuit reveal — one-shot opacity pulse on a pre-drawn grid overlay
    if (typeof UI !== 'undefined' && UI.flashCombatReveal) UI.flashCombatReveal();

    // Poison Ivy charm moved from PRE-combat to post-combat (see
    // postCombat). Running pre-combat killed Ivy's opposite before
    // the main lane's simultaneous swing could land — e.g. Ivy vs
    // Man-Bat would have a charmed ally snipe Man-Bat before he
    // could hit Ivy back. Spec: Ivy + her opposite trade normally,
    // THEN the charmed ally swings in Ivy's lane.

    // Resolve lanes one-by-one with a delay between each so the player can see results.
    const resolveLane = (i) => {
      this._bumpCombatProgress(); // watchdog: combat is advancing
      // Game-over short-circuit — if a previous lane's face damage took
      // either HP to 0, stop resolving combat. damagePlayer already
      // triggered the game-over screen; we just need to bail before
      // running more lanes.
      if (this.state.gameOver) {
        delete this.state._activeLane;
        UI.render();
        return;
      }
      // Skip empty/destroyed lanes without delay
      while (i < this.LANE_COUNT) {
        const lane = this.state.lanes[i];
        if (!lane.destroyed && (lane.player || lane.ai)) break;
        i++;
      }
      if (i >= this.LANE_COUNT) {
        // All lanes done — clear active lane highlight and proceed to post-combat
        delete this.state._activeLane;
        UI.render();
        this._schedule(() => this.postCombat(), this.COMBAT_POST_DELAY);
        return;
      }

      this.state._activeLane = i;
      UI.render();
      // Broadcast active-lane highlight to guest so they see which lane is fighting.
      if (this.isMultiplayer && this.isMultiplayer() && this.mp.role === 'host') this._mpBroadcast();

      const lane = this.state.lanes[i];
      const p = lane.player;
      const a = lane.ai;
      const advance = () => {
        // If any prompt is pending (block trick, card/lane choice, etc.), pause combat
        this.whenPromptCleared(() => {
          UI.render();
          // Broadcast resolved lane result to guest before moving on.
          if (this.isMultiplayer && this.isMultiplayer() && this.mp.role === 'host') this._mpBroadcast();
          this._schedule(() => resolveLane(i + 1), this.COMBAT_LANE_DELAY);
        });
      };
      if (p && a) {
        this.log(`[LANE ${i + 1}] ${p.name} (${p.attack}/${p.currentHealth}) vs ${a.name} (${a.attack}/${a.currentHealth})`);
        this.resolveLaneCombat(i, advance);
        return; // advance called by resolveLaneCombat when done
      } else if (p) {
        const async = this.resolveUncontestedLane(i, 'player', advance);
        if (p.isMindControlled || async) return; // async prompt
      } else if (a) {
        const async = this.resolveUncontestedLane(i, 'ai', advance);
        if (a.isMindControlled || async) return; // async prompt
      }
      advance();
    };

    resolveLane(0);
  },

  postCombat() {
    // Phase 1 dual-run instrument — compare forecast to actual.
    // Runs before cleanupDead so dead cards still have currentHealth
    // visible for the diff. console.warn each divergence; production
    // unaffected when DEBUG_DUAL_RUN is false (forecast never captured).
    if (this._dualRunForecast) {
      try {
        const playerCards = this.state.lanes.map(l => l.player).filter(Boolean);
        const aiCards     = this.state.lanes.map(l => l.ai).filter(Boolean);
        const diffs = CombatEngine.dualRunDiff(this._dualRunForecast, playerCards, aiCards);
        if (diffs.length) {
          console.warn(`[DUAL-RUN] ${diffs.length} predictor/resolver divergence(s):`, diffs);
        }
      } catch (e) {
        console.warn('[DUAL-RUN] diff failed', e);
      }
      delete this._dualRunForecast;
    }
    this.cleanupDead();
    // Primary stack drain point — resolve any events combat queued (bonus-
    // attack chains, deathrattle summons, collapse kills) so nothing lingers
    // into the round transition. cleanupDead only drains when it finds a fresh
    // death; this guarantees a drain even when it doesn't.
    this.resolveStack();

    // Poison Ivy's charm mechanic was simplified: the charmed ally's
    // ATK is now added to Ivy's own ATK as a temp buff in _charm. No
    // more bonus swing, so this path is gone. `resolveIvyCharms` is
    // kept as a no-op safety net for any legacy `_ivyCharmedLane` tags
    // that might persist through a save-load edge case.
    this.resolveIvyCharms();

    // Bonus-attack safety net — handleDeath now drains immediately on
    // every death (user spec: "shouldn't happen at the end of the round
    // but instead immediately"). This pass remains as a backstop for
    // any path that queues a bonus attack outside of handleDeath
    // (passive ticks, future card effects, etc.) — drainBonusAttacks
    // is idempotent (clears the flag on entry) so this is a no-op on
    // already-drained cards.
    this.getAllCardsOnBoard().forEach(c => this.drainBonusAttacks(c));
    this.cleanupDead();
    // Combat phase is done — trick-triggered deaths from here on drain immediately.
    delete this.state._inCombat;
    // NOTE: the watchdog is deliberately NOT cleared here. postCombat still has
    // a long tail — end-of-turn hooks, status ticking, the round-summary
    // crossfade promise, drawPhase, then startRound — and the phase stays
    // 'combat' through ALL of it. A hang anywhere in that tail (a round-summary
    // promise that never resolves, a dropped drawPhase timer) used to leave the
    // board frozen on the COMBAT header with no watchdog, since we'd disarmed it
    // right here. This was the actual "stalled again in 1v1" freeze: combat
    // visually finished, yet the round never advanced. The watchdog now stays
    // armed and self-clears via its liveness check the instant startRound flips
    // the phase off 'combat' (~80ms later in the normal path, so it never trips
    // on a healthy round).

    // End-of-turn effects
    this.getAllCardsOnBoard().forEach(c => {
      if (c.onEndOfTurn) { try { c.onEndOfTurn(this, c, this.findCardLane(c)); } catch (e) { console.error(e); } }
    });
    this.cleanupDead();

    // Restore any attack stats Obi-Wan zeroed for the duration of this combat phase
    this.getAllCardsOnBoard().forEach(c => {
      if (c._obiWanAttackZeroed !== undefined) {
        c.attack = c._obiWanAttackZeroed;
        delete c._obiWanAttackZeroed;
      }
    });

    this.getAllCardsOnBoard().forEach(c => {
      // Debuffs applied AFTER combat resolved this round (block-trick
      // plays like Mind Stone on a filled block meter, or any trick
      // fired while _combatFinishedThisRound is true) carry over one
      // round so the target actually gets to act under the debuff
      // once. The `_debuffDelayedClear` flag is set by tryApplyDebuff;
      // here we consume the flag instead of the debuff, leaving the
      // status to clear naturally after next round's combat.
      if (c._debuffDelayedClear) {
        // Late-applied debuff — preserve full count for next round.
        delete c._debuffDelayedClear;
      } else {
        // DECREMENT counters; sync booleans from counters. A Frozen 2
        // card ticks to Frozen 1 here, NOT to Frozen 0 — that's
        // what makes stacking actually mean "lasts longer."
        c.stunnedTurns = Math.max(0, (c.stunnedTurns || (c.isStunned ? 1 : 0)) - 1);
        c.isStunned    = c.stunnedTurns > 0;
        c.frozenTurns  = Math.max(0, (c.frozenTurns  || (c.isFrozen  ? 1 : 0)) - 1);
        c.isFrozen     = c.frozenTurns > 0;
        c.fearedTurns  = Math.max(0, (c.fearedTurns  || (c.isFeared  ? 1 : 0)) - 1);
        c.isFeared     = c.fearedTurns > 0;
        // Mind-control isn't stacked (single binary state) — clear
        // both the flag and the target. Same for damageImmuneTurn.
        c.isMindControlled = false;
        c.mindControlTarget = null;
        c.damageImmuneTurn = false;
      }
      // Iron Giant's rescue shield is scoped to the combat that triggered it.
      delete c._igSavedThisCombat;
      if (c._recurringBT) c.beforeTricksFired = false;
      if (c.tauntTurns > 0 && !c.permanentTaunt) c.tauntTurns--;
      if (c.tauntTurns === 0 && c.tauntOnlyLowestAttack) c.tauntOnlyLowestAttack = false;
      if (c.invincibleTurns > 0) c.invincibleTurns--;
    });
    // Flip the late-round flag so tricks played between now and the
    // next startRound get marked persistent. Cleared in startRound.
    this.state._combatFinishedThisRound = true;
    // Tick down destroyed-lane timers. Lanes are destroyed for 3 full rounds
    // (set via destroyLane() — Darkseid, Anti-Life Equation) and restore to
    // playable automatically when the counter hits 0. Tick cadence matches
    // tauntTurns / invincibleTurns above so the lane's "3 → 2 → 1 → open"
    // progression lines up with every other round-scoped effect.
    this.state.lanes.forEach((lane, i) => {
      if (lane.destroyed && lane.destroyedTurns > 0) {
        lane.destroyedTurns--;
        if (lane.destroyedTurns === 0) {
          lane.destroyed = false;
          this.log(`[LANE] Lane ${i + 1} reforms — the void collapses.`);
        }
      }
    });
    // Capture peak-round HP damage for the victory stats panel. _roundStats
    // resets each round at startRound, so "how much HP damage did this
    // player deal THIS round" is in {player,ai}DamageDealt — we keep the
    // running max across the whole game on state._stats.
    if (this.state._roundStats && this.state._stats) {
      const rs = this.state._roundStats;
      const ps = this.state._stats;
      if (rs.playerDamageDealt > ps.player.peakRoundDamage) ps.player.peakRoundDamage = rs.playerDamageDealt;
      if (rs.aiDamageDealt > ps.ai.peakRoundDamage) ps.ai.peakRoundDamage = rs.aiDamageDealt;
    }
    // Expire 1-turn granted buffs (default duration for ally buffs)
    this.expireGrantedBuffs();
    // Expire stale jump opportunities: if a card had jumpReady/jumpLane set this
    // round (e.g. Michael Myers locked onto an enemy played last turn) and the
    // holder never took the jump, clear the flags so the stored lane target
    // can't trigger a stale auto-play on a later turn.
    ['player', 'ai'].forEach(o => {
      this.state[o].hand.forEach(c => {
        if (c.jumpReady || c.jumpLane !== undefined) {
          if (c.jumpReady) this.log(`  [JUMP] ${c.name}'s jump window closed — opportunity expired.`);
          c.jumpReady = false;
          c.jumpLane = undefined;
        }
      });
    });
    this.cleanupDead();
    // Mr. Freeze HP shield persists until the next damage hit consumes
    // it (see damagePlayer → `if (p.healthFrozen) { ...; return; }`).
    // The old unconditional reset here wiped the shield every round;
    // the card text reads "freezes your HP bar (until triggered)" so
    // letting it carry over across rounds matches intent.

    UI.render();
    if (typeof Tutorial !== 'undefined' && Tutorial.active) Tutorial.notify('post-combat', {});

    if (this.state.player.health <= 0) { this.state.gameOver = true; this.state.winner = 'ai'; this.log(`=== GAME OVER — ${this.seatLabel('ai')} Wins! ===`); }
    if (this.state.ai.health <= 0) { this.state.gameOver = true; this.state.winner = 'player'; this.log('=== GAME OVER — You Win! ==='); }
    // Pin the final HP state at the tail of the history curve so the
    // game-over chart shows the killing blow, not just the last round-
    // start HP (which would miss the final 5 HP swing that ended the
    // match). Wrapped in _pinFinalHpHistory so the same logic also
    // fires from damagePlayer's immediate game-over hook (which
    // bypasses postCombat).
    if (this.state.gameOver) this._pinFinalHpHistory();
    if (this.state.gameOver) this.finalizeStats();

    if (!this.state.gameOver) {
      // 2v2 owns its own post-combat sequence: read team health back from
      // the player/ai combat proxies, broadcast (online), then the 2v2 draw
      // phase and next 2v2 round. Falling through to the 1v1
      // drawPhase/startRound below is what derailed 2v2 matches into the
      // 1v1 engine after round 1's combat — phase flipped to 'player-cards',
      // "--- Round 1 --- You go first" re-logged, and the endPhase chain
      // handed Team B's turns to the AI.
      if (this.is2v2()) { this._2v2PostCombat(); return; }
      // Show round recap before draw phase, if the player has it enabled.
      const rs = this.state._roundStats;
      const showRecap = typeof UI !== 'undefined' && UI.showRoundSummary;
      const proceed = () => this.drawPhase(() => { this.startRound(); });
      if (rs && showRecap) {
        const data = {
          round: rs.round,
          playerHp: Math.max(0, this.state.player.health), playerMaxHp: this.state.player.maxHealth,
          aiHp: Math.max(0, this.state.ai.health),         aiMaxHp: this.state.ai.maxHealth,
          playerDamageDealt: rs.playerDamageDealt, playerDamageTaken: rs.playerDamageTaken,
          playerKills: rs.playerKills, aiKills: rs.aiKills,
          playerTricks: rs.playerTricks, aiTricks: rs.aiTricks
        };
        Promise.resolve(UI.showRoundSummary(data)).then(proceed);
      } else {
        proceed();
      }
    } else {
      UI.render();
    }
  },

  getAttackTarget(attackerOwner, attackerLane) {
    const defOwner = this.opponent(attackerOwner);
    // Lazy compute: is the current attacker among the lowest-attack cards on its
    // own side? Used by selective taunters (Deadpool's tauntOnlyLowestAttack).
    let attackerIsLowestCache = null;
    const attackerIsLowest = () => {
      if (attackerIsLowestCache !== null) return attackerIsLowestCache;
      const sameSide = this.getAllCardsOf(attackerOwner);
      if (!sameSide.length) return (attackerIsLowestCache = false);
      const minAtk = Math.min(...sameSide.map(a => a.attack));
      const cur = this.state.lanes[attackerLane][attackerOwner];
      attackerIsLowestCache = !!(cur && cur.attack === minAtk);
      return attackerIsLowestCache;
    };
    const attackerCard = this.state.lanes[attackerLane][attackerOwner];
    for (let i = 0; i < this.LANE_COUNT; i++) {
      const c = this.state.lanes[i][defOwner];
      if (!c || c.tauntTurns <= 0 || c.currentHealth <= 0) continue;
      // 10-cost titans don't answer each other's taunts — Manhattan's
      // taunt can't drag Galactus out of his lane. Same mutual-immunity
      // rule as drain / devour / freeze / debuffs (is10CostImmune).
      if (this.is10CostImmune(attackerCard, c)) continue;
      if (c.tauntOnlyLowestAttack) {
        // Selective taunt: only pull attackers tied for the lowest attack value.
        if (attackerIsLowest()) return c;
        continue; // higher-attack attackers ignore this taunter
      }
      return c;
    }
    return this.state.lanes[attackerLane][defOwner];
  },

  // Get mind control target for a card. controller = the player who cast MC (opponent of card.owner).
  // If controller is 'player', prompt for choice. If 'ai', auto-pick highest HP ally.
  // healthBarOwner = card.owner (the MC'd card hits its own side's health bar).
  // callback(target) where target is a card or null (null = hit health bar).
  getMindControlTarget(card, controller, callback) {
    // Environments (Sewers, Open Water, Boiler Room, Gargantua pull-tiles) are
    // a SEPARATE category and are never attackable — exclude them so a mind-
    // controlled card can't be turned on its own side's environment.
    const allies = this.getAllCardsOf(card.owner).filter(c => c.id !== card.id && c.currentHealth > 0 && !c.isEnvironment);
    // Check for stored target (Gorilla Grodd pre-picked — legacy path,
    // still honored in case some upstream flow sets it).
    const stored = card.mindControlTarget;
    if (stored && stored.currentHealth > 0 && this.findCardLane(stored) >= 0) {
      callback(stored);
      return;
    }
    // Mind-controlled cards turn on their OWN side's cards only — the
    // HP bar is never a legal target. Previously a "Health Bar"
    // pseudo-option was offered, which let the controller deal direct
    // face damage through any MC'd enemy. Removed: if no allies exist,
    // the swing whiffs (combat code falls through to its null-target
    // path and the MC'd card does nothing this round).
    if (!allies.length) { callback(null); return; }
    if (this.isHuman(controller)) {
      // ALWAYS prompt the human controller — even when only 1 ally
      // remains. User report: "I mind controlled Gojo to attack Iron
      // Man, and he decided to attack Red Hulk instead. Using Luke
      // Skywalker." Root cause was the `allies.length > 1` gate: when
      // Luke's While-Active −1/−1 aura killed Iron Man on entry (1 HP
      // → 0), the MC prompt path saw `allies = [Red Hulk]`, skipped
      // the prompt, and auto-resolved. The user expected a deliberate
      // confirm beat — same spec as Galactus/Dormammu: "the user
      // always chooses". The single-target prompt makes the targeting
      // visible and gives the player a chance to course-correct (or
      // at least understand what's happening).
      // AI picker: target the HIGHEST-THREAT ally on the controlled
      // card's side. Highest-HP was a crude proxy — it ignores armor
      // (which makes the swing wasteful), evade (which dodges the
      // swing), strategic value, etc. Threat score captures the full
      // calculus: an AI with Mind Control should aim its victim at
      // the player card whose removal hurts the player most. Falls
      // back to raw HP if AI module isn't loaded yet.
      const threatPicker = (cards) => cards.slice().sort((a, b) =>
        (typeof AI !== 'undefined' && AI.threatScore
          ? (AI.threatScore(b) - AI.threatScore(a))
          : (b.currentHealth || 0) - (a.currentHealth || 0)))[0];
      this.promptCardChoice(controller, allies, `Mind Control — ${card.name}`,
        `Choose which of ${this.seatPossessive(card.owner)} cards ${card.name} (${card.attack} ATK) attacks`,
        (pick) => { callback(pick); },
        threatPicker);
    } else {
      // AI controller — auto-pick highest-threat ally on victim's side.
      const threatPicker = (cards) => cards.slice().sort((a, b) =>
        (typeof AI !== 'undefined' && AI.threatScore
          ? (AI.threatScore(b) - AI.threatScore(a))
          : (b.currentHealth || 0) - (a.currentHealth || 0)))[0];
      callback(threatPicker(allies));
    }
  },

  resolveLaneCombat(laneIdx, doneCallback) {
    let pCard = this.state.lanes[laneIdx].player;
    let aCard = this.state.lanes[laneIdx].ai;
    if (!pCard || !aCard) { if (doneCallback) doneCallback(); return; }
    // Snapshot pre-combat stats so the UI can show a "what happened
    // here?" recap after the lane resolves. Captured before any
    // damage / deaths so the summary reads the REAL starting values
    // even if the cards got demolished.
    const _laneSummary = {
      laneIdx,
      pName: pCard.name, pAtkBefore: pCard.attack || 0, pHpBefore: pCard.currentHealth,
      aName: aCard.name, aAtkBefore: aCard.attack || 0, aHpBefore: aCard.currentHealth
    };

    let pTarget = this.getAttackTarget('player', laneIdx);
    let aTarget = this.getAttackTarget('ai', laneIdx);

    if (pCard.isFeared) pTarget = pCard;
    if (aCard.isFeared) aTarget = aCard;

    const pCanAttack = pCard.currentHealth > 0 && !pCard.isStunned && !pCard.isFrozen && pCard.attack > 0;
    const aCanAttack = aCard.currentHealth > 0 && !aCard.isStunned && !aCard.isFrozen && aCard.attack > 0;

    if (!pCanAttack && pCard.currentHealth > 0 && pCard.attack > 0)
      this.log(`  ${pCard.name} is ${pCard.isStunned ? 'STUNNED' : 'FROZEN'} — can't attack or dodge!`);
    if (!aCanAttack && aCard.currentHealth > 0 && aCard.attack > 0)
      this.log(`  ${aCard.name} is ${aCard.isStunned ? 'STUNNED' : 'FROZEN'} — can't attack or dodge!`);

    // Resolve mind control targeting (may be async if player chooses)
    const resolveMC = (pMCTarget, aMCTarget) => {
      // Safety: re-check cards are still alive after async callbacks
      const pAlive = () => pCard.currentHealth > 0 && this.findCardLane(pCard) >= 0;
      const aAlive = () => aCard.currentHealth > 0 && this.findCardLane(aCard) >= 0;
      if (!pAlive() && !aAlive()) { if (doneCallback) doneCallback(); return; }

      if (pCard.isMindControlled) pTarget = pMCTarget;
      if (aCard.isMindControlled) aTarget = aMCTarget;

      let pKilled = false, aKilled = false;

      // --- TRULY SIMULTANEOUS COMBAT (v2) ---
      // Both sides' onBeforeAttack callbacks fire BEFORE either side's
      // main-swing damage applies. Then both damages apply using the
      // post-onBeforeAttack / pre-swing state. Target validity is captured
      // once; if pCard's swing kills aCard (or vice-versa), the other
      // side's swing still fires as if it had landed at the same instant.
      // This eliminates the "player-always-attacks-first" bias that the
      // old stepPlayerAttack → stepAIAttack sequential structure created.

      // Snapshot swing-eligibility and targets BEFORE anything resolves.
      // These capture the "what would you have swung at" state, so that
      // side effects within either onBeforeAttack or applyCombatDamage
      // don't retroactively cancel the other side's swing.
      const pWouldSwing = pCanAttack && !!pTarget;
      const aWouldSwing = aCanAttack && !!aTarget;

      // Step 1: Fire BOTH onBeforeAttack hooks, in sequence but before
      // either main swing lands. The order (player first, then AI) only
      // matters for async prompts queued by the hook — actual damage from
      // the main swing is applied in Step 2, simultaneously.
      const fireBeforeAttacks = (next) => {
        const firePlayer = () => {
          if (pWouldSwing && pCard.onBeforeAttack && pCard.currentHealth > 0) {
            pCard.onBeforeAttack(this, pCard);
          }
          this.whenPromptCleared(fireAI);
        };
        const fireAI = () => {
          if (aWouldSwing && aCard.onBeforeAttack && aCard.currentHealth > 0) {
            aCard.onBeforeAttack(this, aCard);
          }
          this.whenPromptCleared(next);
        };
        firePlayer();
      };

      // Step 2: Apply BOTH main-swing damages. Neither side's swing is
      // canceled by the other killing their target — applyCombatDamage
      // safely no-ops on a dead target (returns false), so a dead target
      // just eats the swing harmlessly. But the attacker's swing still
      // FIRED, counting for stats and any triggers tied to attacking.
      const applyBothDamages = () => {
        const pSwings = pWouldSwing && !pCard._skipNormalAttack;
        const aSwings = aWouldSwing && !aCard._skipNormalAttack;
        delete pCard._skipNormalAttack;
        delete aCard._skipNormalAttack;

        // Player swing — log Mind Control BEFORE the damage resolution
        // so the transcript reads "[MIND CTRL] … → [HIT] …" in causal
        // order. applyCombatDamage logs its own [HIT] lines, so if we
        // logged MC after, they'd land out of sequence.
        // Both swings pass { deferOnKill: true } so the onKill hook
        // is suppressed during damage. We fire onKill for both winners
        // AFTER both swings have landed — otherwise Peacemaker's +1/+1
        // kill buff would land between his swing and Sabertooth's, so
        // Peacemaker would soak Sabertooth's retaliation on his BUFFED
        // HP instead of his pre-swing HP. User spec: "Peacemaker
        // should've died as they attack simultaneously".
        const deferOpts = { deferOnKill: true };
        if (pSwings) {
          if (pCard.isMindControlled) {
            if (pTarget && pTarget.currentHealth > 0) {
              this.log(`  [MIND CTRL] ${pCard.name} attacks ${pTarget.name}!`);
              pKilled = this.applyCombatDamage(pCard, pTarget, deferOpts);
            } else {
              // No valid ally target to turn on — MC'd card's swing
              // whiffs this round. Previously the damage fell through
              // to the owner's HP bar, which effectively made MC a
              // face-damage-dealing debuff. Per spec, MC'd cards only
              // attack their own side's cards.
              this.log(`  [MIND CTRL] ${pCard.name} has no valid ally to attack — swing whiffs.`);
            }
          } else {
            pKilled = this.applyCombatDamage(pCard, pTarget, deferOpts);
          }
        }

        // AI swing — fires regardless of whether pTarget/aTarget changed
        // during pSwings above. aCard was alive and had a target at lane
        // start; it swings now. If aTarget is already dead, the swing
        // whiffs (applyCombatDamage no-ops) but the onBeforeAttack
        // already fired in Step 1.
        if (aSwings) {
          if (aCard.isMindControlled) {
            if (aTarget && aTarget.currentHealth > 0) {
              this.log(`  [MIND CTRL] ${aCard.name} attacks ${aTarget.name}!`);
              aKilled = this.applyCombatDamage(aCard, aTarget, deferOpts);
            } else {
              this.log(`  [MIND CTRL] ${aCard.name} has no valid ally to attack — swing whiffs.`);
            }
          } else {
            aKilled = this.applyCombatDamage(aCard, aTarget, deferOpts);
          }
        }

        // Fire deferred onKill hooks — only for killers who are STILL
        // ALIVE after both swings. A dead card's onKill shouldn't
        // retroactively buff a corpse. Mutual-kill scenario (both die
        // simultaneously) correctly produces zero onKill fires.
        if (pKilled && pCard.onKill && pCard.currentHealth > 0) {
          try { pCard.onKill(this, pCard); } catch (e) { console.error(e); }
        }
        if (aKilled && aCard.onKill && aCard.currentHealth > 0) {
          try { aCard.onKill(this, aCard); } catch (e) { console.error(e); }
        }

        stepFinish();
      };

      // Step 3: Splash, cleanup, overdrive, done
      const stepFinish = () => {
        // Splash fires for any swinger that HAD a valid attack at lane
        // start (pCanAttack/aCanAttack snapshot pre-damage). The current-
        // health check was preventing splash when the attacker died in
        // the same exchange — but splash is part of the swing itself, so
        // it should land regardless of whether the attacker survived the
        // trade. User report: "Hulk in lane 6 (3/5) attacked Magneto and
        // his splash didn't hit Joker (lane 5) or stack onto Magneto."
        // (Hulk took 5 from Magneto and died → splash was suppressed.)
        // Suppress splash for mind-controlled or feared cards — their
        // attack is redirected to their own side, so splash must not
        // radiate outward onto the opposing team.
        if (pCard.splashRange > 0 && pCanAttack && !pCard.isMindControlled && !pCard.isFeared) this.applySplash(pCard, laneIdx);
        if (aCard.splashRange > 0 && aCanAttack && !aCard.isMindControlled && !aCard.isFeared) this.applySplash(aCard, laneIdx);

        // Per-card "has swung this round" marker. Set after THIS card
        // resolves combat so any debuff landed AFTER this point (e.g.
        // Mind Stone played as a block trick mid-combat, or the next
        // lane's ability firing a debuff at an already-swung card) is
        // tagged _debuffDelayedClear by tryApplyDebuff — keeping the
        // status live until NEXT round's combat instead of clearing
        // it in this round's postCombat (which would make the debuff
        // a no-op since the card already acted).
        if (pCard) pCard._combatSwungThisRound = true;
        if (aCard) aCard._combatSwungThisRound = true;

        this.cleanupDead();

        // Overdrive's bonus attack re-targets the NORMAL lane opponent
        // (handleOverdrive → getAttackTarget). A mind-controlled or feared
        // card's swing is redirected to its own side, so it must NOT earn a
        // second, clean hit on the enemy — same rationale as the splash
        // suppression above. (Bug: MC'd Spawn killed an env, then overdrove
        // into the enemy hero opposite and killed it.)
        if (pCard.isOverdrive && pCard.currentHealth > 0 && pKilled && !pCard.justResurrected && !pCard.isMindControlled && !pCard.isFeared) this.handleOverdrive(pCard, laneIdx);
        if (aCard.isOverdrive && aCard.currentHealth > 0 && aKilled && !aCard.justResurrected && !aCard.isMindControlled && !aCard.isFeared) this.handleOverdrive(aCard, laneIdx);
        if (pCard.justResurrected) pCard.justResurrected = false;
        if (aCard.justResurrected) aCard.justResurrected = false;

        this.cleanupDead();
        // onLaneResolved — fires as soon as a lane's combat completes, while
        // other lanes are still pending. Gojo uses this to land Hollow Purple
        // mid-combat instead of at end-of-round, so enemies in opposite-parity
        // lanes die before they get to swing in their own lanes.
        if (pCard.currentHealth > 0 && pCard.onLaneResolved) {
          try { pCard.onLaneResolved(this, pCard, laneIdx); } catch (e) { console.error(e); }
        }
        if (aCard.currentHealth > 0 && aCard.onLaneResolved) {
          try { aCard.onLaneResolved(this, aCard, laneIdx); } catch (e) { console.error(e); }
        }
        this.cleanupDead();
        // Lane recap hook — UI renders a brief "who hit what" overlay
        // so the player doesn't need to dig through the log to see
        // what actually resolved. Captures post-combat state diffed
        // against the pre-combat snapshot from the top of this fn.
        if (typeof UI !== 'undefined' && UI.showLaneRecap) {
          _laneSummary.pHpAfter = Math.max(0, pCard.currentHealth);
          _laneSummary.aHpAfter = Math.max(0, aCard.currentHealth);
          _laneSummary.pDied = pCard.currentHealth <= 0;
          _laneSummary.aDied = aCard.currentHealth <= 0;
          try { UI.showLaneRecap(_laneSummary); } catch (e) { console.error(e); }
        }
        if (doneCallback) doneCallback();
      };

      // Kick off: fire both onBeforeAttacks in sequence, then apply both
      // damages simultaneously, then stepFinish (splash + overdrive + done).
      fireBeforeAttacks(applyBothDamages);
    };

    // Chain MC targeting prompts, then resolve combat
    const pMC = pCard.isMindControlled && pCanAttack;
    const aMC = aCard.isMindControlled && aCanAttack;
    if (pMC && aMC) {
      // Both mind-controlled — AI controls player's card, player controls AI's card
      this.getMindControlTarget(pCard, 'ai', (pMCT) => {
        this.getMindControlTarget(aCard, 'player', (aMCT) => {
          resolveMC(pMCT, aMCT);
        });
      });
    } else if (pMC) {
      this.getMindControlTarget(pCard, 'ai', (pMCT) => { resolveMC(pMCT, null); });
    } else if (aMC) {
      this.getMindControlTarget(aCard, 'player', (aMCT) => { resolveMC(null, aMCT); });
    } else {
      resolveMC(null, null);
    }
  },

  // ----- Etch effect helpers (Roguelite mode keyword etches) -----
  // These run at fixed combat events to give Thorns / Lifesteal /
  // Berserker / Zealot / Phoenix their declared engine effects. The
  // boolean stack counters (hasThorns, hasLifesteal, etc.) are set by
  // Roguelite.ETCHES[*].apply on cards that earn the etch, so a card
  // can carry multiple stacks for compounding effect (Thorns 2 = deal
  // 2 back, Lifesteal 2 = heal 2 per damage instance, etc.).

  // Berserker (+1 ATK while damaged) + Zealot (+1 ATK at full HP).
  // Returns the bonus to apply to attacker's damage roll for this swing.
  // Both stack with their counter so a card with hasBerserker=2 swings
  // for +2 while damaged.
  _getEtchAttackBonus(attacker) {
    if (!attacker) return 0;
    let bonus = 0;
    if (attacker.hasBerserker && attacker.currentHealth < attacker.maxHealth) {
      bonus += attacker.hasBerserker;
    }
    if (attacker.hasZealot && attacker.currentHealth >= attacker.maxHealth) {
      bonus += attacker.hasZealot;
    }
    return bonus;
  },

  // Thorns retaliation — when `target` takes damage from `attacker`,
  // chip the attacker for hasThorns dmg. Direct HP subtract (NOT
  // dealDamage) to avoid recursive Thorns/Lifesteal/death-handler
  // triggers — purely a reactive chip. Skips when attacker is null
  // (trick / passive damage), already dead, or the same card (self-hit).
  _resolveThorns(target, attacker) {
    if (!target || !target.hasThorns) return;
    if (!attacker || attacker.id == null || attacker === target) return;
    if (attacker.currentHealth <= 0) return;
    if (attacker.owner === target.owner) return;
    if (attacker.invincibleTurns > 0 || attacker.hasDamageImmunity) return;
    const n = target.hasThorns;
    // Armor reduces Thorns chip — feels right since armor is a flat
    // mitigation and Thorns is small chip damage. If armor fully soaks,
    // no chip lands.
    let chip = n;
    if (attacker.armorValue > 0) {
      if (chip <= attacker.armorValue) {
        this.log(`  [THORNS] ${target.name} retaliates ${n} → ${attacker.name}'s Armor ${attacker.armorValue} absorbs all`);
        this._creditAbsorb(attacker, 'Armor', chip);
        return;
      }
      this._creditAbsorb(attacker, 'Armor', attacker.armorValue);
      chip -= attacker.armorValue;
    }
    if (this.state._yodaShieldFor && this.state._yodaShieldFor[attacker.owner] > 0) {
      chip = Math.ceil(chip / 2);
      if (chip <= 0) return;
    }
    attacker.currentHealth -= chip;
    attacker.statsHpTaken = (attacker.statsHpTaken || 0) + chip;
    this.emitDmg(attacker.id, chip, 'hit', undefined, target && target.id, attacker.currentHealth <= 0);
    this.log(`  [THORNS] ${target.name} retaliates ${chip} damage to ${attacker.name} → ${Math.max(0, attacker.currentHealth)}/${attacker.maxHealth} HP`);
    this._creditChain(target, 'statsEnemyDamage', chip);
    if (attacker.currentHealth <= 0) {
      this._creditChain(target, 'statsKills', 1);
      const l = this.findCardLane(attacker);
      if (l >= 0) this.handleDeath(attacker, l, target);
    }
  },

  // Lifesteal — `attacker` deals `actual` damage and heals its owner's
  // HP by hasLifesteal × 1 (per stack). Capped to maxHealth via
  // healPlayer's existing clamp. Counts toward the etched card's
  // statsHealingDone (and feeds the leveraged-heal MVP component).
  _resolveLifesteal(attacker, actual) {
    if (!attacker || !attacker.hasLifesteal) return;
    if (actual <= 0) return;
    const heal = attacker.hasLifesteal;
    this.log(`  [LIFESTEAL] ${attacker.name} drains ${heal} HP for ${this.seatLabel(attacker.owner)}`);
    this.healPlayer(attacker.owner, heal, attacker);
  },

  // Cantrip — draw 1 (per stack) when this card is played. Fires after
  // onPlay so the card itself has resolved. Mirrors drawOnPlay behavior
  // but stacks independently. Echoes once per Echo stack.
  // Roguelite-only rarity variants — read a per-tier value off a map
  // for the calling card. Common = nerfed branch, Rare = baseline (the
  // listed text), Special = upgraded, Legendary = biggest. Cards opt
  // in by reading `Game.rarityValue(self, { common, rare, special,
  // legendary })` inside their ability hooks. Classic mode + summoned
  // tokens have no `_runRarity` → default to 'rare' → baseline behavior
  // unchanged. User direction: "do not change cards from roguelite
  // into the game — they're two separate entities." Same code, but
  // the only behavioral fork is when the runtime card carries the
  // roguelite rarity tag.
  rarityValue(self, map) {
    const tiers = ['common', 'rare', 'special', 'legendary'];
    let baseTier = (self && self._runRarity) || 'rare';
    // Common-tier cards resolve abilities as if they were Rare. User
    // direction: "don't touch the text for common cards." So the only
    // common-tier nerf is the -1/-1 stat penalty applied in
    // Roguelite._resolveStats — printed text + ability behavior match
    // the rare baseline.
    if (baseTier === 'common') baseTier = 'rare';
    let idx = tiers.indexOf(baseTier);
    if (idx < 0) idx = 1; // default to rare
    // Text-upgrade etches scale the card's ability up one tier per
    // stack. So a Rare Hawkeye with one Text+ etch reads as Special
    // for rarityValue lookups (Splash 1 → Splash 2). User direction:
    // "the text etch should effect the text like Splash 1 → Splash 2.
    // Text is the legendary quality upgrade so it's rare to get."
    const bumps = (self && self.textTierBumps) || 0;
    idx = Math.min(tiers.length - 1, idx + bumps);
    const tier = tiers[idx];
    if (map[tier] != null) return map[tier];
    return map.rare != null ? map.rare : map.common;
  },

  _resolveCantripOnPlay(card) {
    if (!card || !card.hasCantrip) return;
    const echoMul = 1 + (card.hasEcho || 0);
    const n = card.hasCantrip * echoMul;
    const before = this.state[card.owner].hand.length;
    this.drawCards(card.owner, n);
    const drawn = this.state[card.owner].hand.length - before;
    if (drawn > 0) {
      const tag = echoMul > 1 ? 'CANTRIP+ECHO' : 'CANTRIP';
      this.log(`  [${tag}] ${card.name} draws ${drawn} card${drawn > 1 ? 's' : ''}`);
      this._creditChain(card, 'statsCardAdvantage', drawn);
    }
  },

  // Fear etch — fire `Fear N` on a random enemy when this card is
  // played. User report: "I etched Fear 1 onto my Thug but he didn't
  // get the ability — fear 1 isn't a status thing." Now it IS: hasFear
  // counter triggers fearCard on a chosen target. AI auto-picks the
  // highest-ATK enemy so the debuff lands where it hurts.
  _resolveFearOnPlay(card) {
    if (!card || !card.hasFear) return;
    const n = card.hasFear * (1 + (card.hasEcho || 0));
    const enemies = this.getEnemiesOf(card.owner).filter(e => e.currentHealth > 0 && !e.isFeared);
    if (!enemies.length) return;
    // Pick highest-ATK target — usually the highest-impact lock.
    const target = enemies.slice().sort((a, b) => (b.attack || 0) - (a.attack || 0))[0];
    this.fearCard(target, card, n);
  },

  // Freeze etch — Freeze 1 (rare) and Freeze 2 (special) etches add
  // hasFreeze to the carrier. User report: "[Freeze 1] auto chose the
  // enemy to freeze, that shouldn't happen — the user should choose."
  // Human-owned carriers now prompt; AI seats fall back to the highest-
  // ATK heuristic so non-human plays don't stall.
  _resolveFreezeOnPlay(card) {
    if (!card || !card.hasFreeze) return;
    const n = card.hasFreeze * (1 + (card.hasEcho || 0));
    const enemies = this.getEnemiesOf(card.owner).filter(e => e.currentHealth > 0 && !e.isFrozen);
    if (!enemies.length) return;
    if (this.isHuman(card.owner)) {
      const aiPicker = (cards) => cards.slice().sort((a, b) => (b.attack || 0) - (a.attack || 0))[0];
      this.promptCardChoice(card.owner, enemies, `${card.name} — Freeze ${n}`,
        `Choose an enemy to Freeze ${n}`, (target) => {
          this.freezeCard(target, card, n);
        }, aiPicker);
      return;
    }
    const target = enemies.slice().sort((a, b) => (b.attack || 0) - (a.attack || 0))[0];
    this.freezeCard(target, card, n);
  },

  // Mind Control etch — MC 1 (rare) / MC 2 (special) set hasMc on the
  // carrier. On play, mind-control up to N distinct enemies for this
  // turn. Mirrors the Fear / Freeze etch pattern; humans get a target
  // prompt per pick, AI auto-picks highest-threat.
  _resolveMindControlOnPlay(card) {
    if (!card || !card.hasMc) return;
    const total = card.hasMc * (1 + (card.hasEcho || 0));
    const aiPicker = (cards) => cards.slice().sort((a, b) =>
      (typeof AI !== 'undefined' && AI.threatScore
        ? (AI.threatScore(b) - AI.threatScore(a))
        : (b.attack || 0) - (a.attack || 0)))[0];
    const picked = new Set();
    const pickNext = (remaining) => {
      if (remaining <= 0) return;
      const pool = this.getEnemiesOf(card.owner).filter(e =>
        e.currentHealth > 0 && !e.isMindControlled && !picked.has(e.id));
      if (!pool.length) return;
      if (this.isHuman(card.owner)) {
        this.promptCardChoice(card.owner, pool, `${card.name} — Mind Control`,
          `Choose an enemy to Mind Control (${total - remaining + 1}/${total})`,
          (target) => {
            this.mindControlCard(target, card);
            picked.add(target.id);
            pickNext(remaining - 1);
          }, aiPicker);
      } else {
        const target = aiPicker(pool);
        this.mindControlCard(target, card);
        picked.add(target.id);
        pickNext(remaining - 1);
      }
    };
    pickNext(total);
  },

  // Mark etch — adjacent allies gain Bullseye for the turn when this
  // card is played. Etch counterpart to Black Widow's legendary-tier
  // signal effect.
  _resolveMarkOnPlay(card) {
    if (!card || !card.hasMark) return;
    const lane = this.findCardLane(card);
    if (lane < 0) return;
    const owner = card.owner;
    [lane - 1, lane + 1].forEach(l => {
      if (l < 0 || l >= this.LANE_COUNT) return;
      const ally = this.state.lanes[l] && this.state.lanes[l][owner];
      if (!ally || ally.id === card.id || ally.currentHealth <= 0) return;
      this.grantTempBuff(ally, { isBullseye: true });
    });
    this.log(`[MARK] ${card.name} marks adjacent allies — they gain Bullseye this turn.`);
  },

  // Phoenix — once-per-life revive at full HP. Returns true if the
  // card was rezzed (caller should treat the death as canceled).
  // Marked _phoenixUsed so subsequent deaths don't loop.
  _resolvePhoenix(card) {
    if (!card || !card.hasPhoenix || card._phoenixUsed) return false;
    card._phoenixUsed = true;
    card.currentHealth = card.maxHealth;
    this.log(`  [PHOENIX] ${card.name} rises from the ashes at full HP!`);
    if (typeof UI !== 'undefined' && UI.sfx && UI.sfx.playEffectSfx) {
      try { UI.sfx.playEffectSfx('Phoenix', card); } catch (e) {}
    }
    return true;
  },

  // opts.deferOnKill — when true, the `onKill` hook is NOT fired here
  // even if the swing killed the target. Caller (resolveLaneCombat) is
  // responsible for firing it AFTER both sides' simultaneous swings have
  // landed. Used to preserve TRUE simultaneous combat: Peacemaker's
  // on-kill buff must not increase his HP before Sabertooth's retaliation
  // lands in the same instant. [KILLED] log and statsKills credit still
  // happen at damage time since those are factual telemetry, not gameplay
  // state mutations.
  // ===================== applyCombatDamage helpers =====================
  // Extracted from the combat-damage hot path so each step is unit-testable
  // and the main applyCombatDamage stays under ~75 lines.

  // Defensive coerce — guard against NaN drift from earlier corruption.
  // No-op for healthy cards; bumps NaN stats back to base values.
  _coerceCombatStats(attacker, target) {
    if (typeof target.currentHealth !== 'number' || !Number.isFinite(target.currentHealth)) {
      target.currentHealth = target.baseHealth || 1;
    }
    if (typeof target.maxHealth !== 'number' || !Number.isFinite(target.maxHealth)) {
      target.maxHealth = target.baseHealth || 1;
    }
    if (attacker && (typeof attacker.attack !== 'number' || !Number.isFinite(attacker.attack))) {
      attacker.attack = attacker.baseAttack || 0;
    }
  },

  // Compute the raw damage value AFTER attacker-side modifiers but BEFORE
  // target-side reductions (armor). Stacks: base ATK → Berserker/Zealot
  // etch bonus → Palpatine frozen-double. Logs each step.
  // Effective ATK for a card, accounting for Yoda's combined-force mark
  // and Han Solo's Critical. Used for both contested and uncontested paths.
  _cardEffectiveAtk(card) {
    let atk = (card._yodaCombinedAtk != null) ? card._yodaCombinedAtk : card.attack;
    if (card._criticalThisRound) atk *= 2;
    return atk;
  },
  _computeIncomingDamage(attacker, target) {
    let dmg = attacker.attack;
    const etchBonus = this._getEtchAttackBonus(attacker);
    if (etchBonus > 0) {
      const tag = (attacker.hasBerserker && attacker.currentHealth < attacker.maxHealth)
        ? 'BERSERKER' : 'ZEALOT';
      this.log(`  [${tag}] ${attacker.name} +${etchBonus} ATK (${dmg} → ${dmg + etchBonus})`);
      dmg += etchBonus;
    }
    // Yoda combined-force strike — both chosen allies deal combined ATK
    if (attacker._yodaCombinedAtk) {
      const combined = attacker._yodaCombinedAtk;
      this.log(`  [YODA] ${attacker.name} strikes with combined Force! (${dmg} → ${combined})`);
      dmg = combined;
    }
    // Han Solo Critical — double damage for this round
    if (attacker._criticalThisRound) {
      const crit = dmg * 2;
      this.log(`  [CRITICAL] ${attacker.name} CRITICAL HIT! (${dmg} → ${crit})`);
      dmg = crit;
    }
    // Yoda shield — target's side takes half combat damage (rounded up)
    if (this.state._yodaShieldFor && this.state._yodaShieldFor[target.owner] > 0 && dmg > 0) {
      const halved = Math.ceil(dmg / 2);
      this.log(`  [YODA SHIELD] ${target.name} takes half damage (${dmg} → ${halved})`);
      dmg = halved;
    }
    if (target.isFrozen) {
      const hasDoubleFrozen = this.getAllCardsOf(attacker.owner).some(
        c => c.passive === 'doubleFrozenDamage' && c.currentHealth > 0
      );
      if (hasDoubleFrozen) {
        const doubled = dmg * 2;
        this.log(`  [PALPATINE] ${target.name} is frozen — ${attacker.name}'s damage doubled (${dmg} → ${doubled})`);
        dmg = doubled;
      }
    }
    return dmg;
  },

  // Apply Armor reduction. Returns the reduced damage to apply, or null
  // if Armor fully absorbed the hit (caller bails out early). Credits
  // absorb stats and emits the block visualization.
  _applyArmorReduction(attacker, target, dmg) {
    if (attacker && attacker.ignoresArmor) return dmg;
    if (target.armorValue <= 0) return dmg;
    if (dmg <= target.armorValue) {
      this.log(`  [ARMOR] ${target.name}'s Armor ${target.armorValue} absorbs ${attacker.name}'s ${dmg} damage`);
      this.emitDmg(target.id, 0, 'armor');
      this._creditAbsorb(target, 'Armor', dmg);
      return null;
    }
    this._creditAbsorb(target, 'Armor', target.armorValue);
    const reduced = dmg - target.armorValue;
    this.log(`  [ARMOR] ${target.name}'s Armor ${target.armorValue} reduces damage to ${reduced}`);
    return reduced;
  },

  // Resolve a target dropping to <=0 HP. Phoenix etch revival fires first;
  // on revival, thorns still chips but the target is declared alive (return
  // false → caller treats as survived). On true death, kill log + onKill +
  // thorns. Returns true if the target died, false if revived.
  _resolveTargetDeath(attacker, target, opts) {
    if (this._resolvePhoenix(target)) {
      this._resolveThorns(target, attacker);
      return false;
    }
    this.log(`  [KILLED] ${target.name} is destroyed by ${attacker.name}!`);
    this._creditChain(attacker, 'statsKills', 1);
    // Tag the dying card with its killer so handleDeath can fire kill audio
    // even though cleanupDead passes null for the killer argument.
    target._killedBy = attacker;
    if (attacker.onKill && !(opts && opts.deferOnKill)) attacker.onKill(this, attacker);
    // Thorns can still chip the attacker even after target died — the
    // hit landed, and the victim's last-gasp bramble retaliates.
    this._resolveThorns(target, attacker);
    return true;
  },

  // Canonical pre-damage absorb ORDER, in ONE place so the live resolver
  // (applyCombatDamage / dealDamage / dealChainDamage) and the combat predictor
  // (predictCombatGlobal) can never disagree again — the four had each
  // hand-rolled Invincible-vs-Evade ordering and drifted, which wasted evade
  // charges and made the preview/AI diverge from real resolution. PURE: returns
  // the absorb kind ('invincible' | 'immunity' | 'evade' | null) and mutates
  // nothing, so the predictor can call it on cloned state too. The CALLER owns
  // the side effects (consume the evade charge, emit events, fire onEvade, log)
  // and decides evade-eligibility via `canEvade` (e.g. stunned/frozen target,
  // ignoresEvade attacker, or bullseye all pass canEvade=false). Order is fixed
  // here: Invincible → Damage Immunity → Evade, since the first two block for
  // FREE and must never burn an evade charge.
  _classifyAbsorb(target, canEvade) {
    if (!target) return null;
    if (target.invincibleTurns > 0) return 'invincible';
    // An Iron Giant sacrifice means "it survives" — so the ally is shielded for
    // the REST of this combat round. Without this the save was worthless in a
    // real fight: combat applies every lane's damage, queues the deaths, and
    // the intercept restores the ally to 1 HP — then the remaining swings in
    // that same round land on the restored card and kill it anyway. With two
    // allies dying at once, BOTH Giants got spent and BOTH allies still died.
    // User report: "iron giant protect 2 cards, when both cards died at the
    // same time he can only save one." Cleared in postCombat.
    // Gated on _inCombat as well as the flag: postCombat clears it from every
    // card ON THE BOARD, but an instance that leaves play mid-combat (bounced
    // to hand by Phantom Zone, say) would otherwise carry a stale shield into
    // a later round. Scoping the check to live combat makes that impossible.
    if (target._igSavedThisCombat && this.state && this.state._inCombat) return 'immunity';
    if (target.hasDamageImmunity) return 'immunity';
    if (canEvade && (target.evadeCharges || 0) > 0) return 'evade';
    return null;
  },

  applyCombatDamage(attacker, target, opts) {
    if (!target || target.currentHealth <= 0) return false;
    this._coerceCombatStats(attacker, target);

    // Pre-damage absorbs via the shared _classifyAbsorb (canonical order:
    // Invincible → Damage Immunity → Evade). Stunned/Frozen target or an
    // ignoresEvade attacker disable Evade up front. Each branch keeps its own
    // log / emit / credit / onEvade side effects.
    const canDodge = !target.isStunned && !target.isFrozen && !(attacker && attacker.ignoresEvade);
    const absorb = this._classifyAbsorb(target, canDodge);
    if (absorb === 'invincible') {
      this.log(`  [INVINCIBLE] ${target.name} takes no damage! (${target.invincibleTurns} turns left)`);
      this.emitDmg(target.id, 0, 'block');
      this._creditAbsorb(target, 'Invincible', attacker.attack || 0);
      return false;
    }
    if (absorb === 'immunity') {
      this.log(`  [DMG IMMUNE] ${target.name} is damage-immune!`);
      this.emitDmg(target.id, 0, 'block');
      this._creditAbsorb(target, 'Invincible', attacker.attack || 0);
      return false;
    }
    if (absorb === 'evade') {
      target.evadeCharges--;
      this.log(`  [EVADE] ${target.name} dodges ${attacker.name}! (${target.evadeCharges} charges left)`);
      this.emitDmg(target.id, 0, 'evade');
      this._creditAbsorb(target, 'Evade', attacker.attack || 0);
      if (target.onEvade) target.onEvade(this, target);
      return false;
    }

    let dmg = this._computeIncomingDamage(attacker, target);
    const afterArmor = this._applyArmorReduction(attacker, target, dmg);
    if (afterArmor === null) return false;
    dmg = afterArmor;

    target.currentHealth -= dmg;
    // Tank-XP tracker — credit the target with HP it just ate. Drives
    // the roguelite "damage taken = XP" path. Snapshotted into the dead
    // pile so resurrects keep the credit.
    target.statsHpTaken = (target.statsHpTaken || 0) + dmg;
    // Lethal flag drives the UI magnitude tier — a hit that drops the
    // card to 0 HP gets the full escalation (heavy shake + hit-pause
    // freeze + max-scale flash/burst/float). currentHealth was already
    // reduced above, so this read is the post-hit state.
    this.emitDmg(target.id, dmg, 'hit', undefined, attacker && attacker.id, target.currentHealth <= 0);
    this.log(`  [HIT] ${attacker.name} deals ${dmg} to ${target.name} → ${Math.max(0, target.currentHealth)}/${target.maxHealth} HP`);
    if (attacker.passive === 'currencyOnDamage' && dmg > 0) {
      attacker._damageDealtThisTurn = (attacker._damageDealtThisTurn || 0) + dmg;
    }
    this._creditChain(attacker, 'statsEnemyDamage', dmg);
    if (dmg > 0) this._resolveLifesteal(attacker, dmg);
    if (target.onDamaged) target.onDamaged(this, target, attacker, dmg);

    if (target.currentHealth <= 0) {
      return this._resolveTargetDeath(attacker, target, opts);
    }
    // Survivor thorns retaliation — only on landed damage, not whiffs.
    if (dmg > 0) this._resolveThorns(target, attacker);
    return false;
  },

  applySplash(card, laneIdx) {
    // Splash X = cone: hits enemy in front (same lane) + adjacent lanes for splashRange damage.
    // Front damage stacks on top of the normal attack.
    const opp = this.opponent(card.owner);
    const splashDmg = card.splashRange;
    const splashed = [];
    // Front (same lane)
    const front = this.state.lanes[laneIdx][opp];
    if (front && front.currentHealth > 0) {
      const hpBefore = front.currentHealth;
      this.dealDamage(front, splashDmg, card);
      this.log(`  [SPLASH] ${card.name} hits ${front.name} in lane ${laneIdx + 1} for ${splashDmg}`);
      // Hawkeye's ATK debuff only triggers on enemies that actually TOOK damage —
      // invincible / evade / full-armor blocks mean the splash "didn't hit".
      if (front.currentHealth > 0 && front.currentHealth < hpBefore) splashed.push(front);
    }
    // Adjacent lanes
    [laneIdx - 1, laneIdx + 1].forEach(li => {
      if (li >= 0 && li < this.LANE_COUNT) {
        const t = this.state.lanes[li][opp];
        if (t && t.currentHealth > 0) {
          const hpBefore = t.currentHealth;
          this.dealDamage(t, splashDmg, card);
          this.log(`  [SPLASH] ${card.name} hits ${t.name} in lane ${li + 1} for ${splashDmg}`);
          if (t.currentHealth > 0 && t.currentHealth < hpBefore) splashed.push(t);
        }
      }
    });
    this.applyHawkeyePassive(card.owner, splashed);
  },

  handleOverdrive(card, laneIdx) {
    const defOwner = this.opponent(card.owner);
    this.log(`  [OVERDRIVE] ${card.name} attacks again!`);
    let target = this.getAttackTarget(card.owner, laneIdx);
    if (!target || target.currentHealth <= 0) target = this.state.lanes[laneIdx][defOwner];
    if (!target || target.currentHealth <= 0) {
      const overdriveDmg = this._cardEffectiveAtk(card);
      this.log(`  [OVERDRIVE] ${card.name} hits health bar for ${overdriveDmg}!`);
      this.damagePlayer(defOwner, overdriveDmg, card.isBullseye, card);
      return;
    }
    const killed = this.applyCombatDamage(card, target);
    this.cleanupDead();
    if (killed && card.currentHealth > 0) this.handleOverdrive(card, laneIdx);
  },

  resolveUncontestedLane(laneIdx, side, advanceCallback) {
    const lane = this.state.lanes[laneIdx];
    const card = lane[side];
    if (!card || card.currentHealth <= 0) return;

    // Mind-controlled cards take precedence over the gating early
    // returns below. Even if the card is frozen / stunned / 0-atk
    // and can't actually swing, we MUST run the async MC chain so
    // its callback fires advanceCallback — otherwise combat stalls.
    // Repro: fuzzer seed 263 round 10 — Flash was MC + Frozen, the
    // frozen-early-return bailed before MC handling, the caller
    // (resolveLane) deferred on `isMindControlled` assuming an
    // async chain was in flight, no chain ever fired, combat hung.
    if (card.isMindControlled) {
      const controller = this.opponent(card.owner);
      this.getMindControlTarget(card, controller, (target) => {
        const canSwing = !card.isStunned && !card.isFrozen
          && (card.attack || 0) > 0 && card.currentHealth > 0;
        if (canSwing) {
          if (card.onBeforeAttack) card.onBeforeAttack(this, card);
          if (target && target.currentHealth > 0) {
            this.log(`[LANE ${laneIdx + 1}] [MIND CTRL] ${card.name} attacks ${target.name}!`);
            this.applyCombatDamage(card, target);
          } else {
            // No valid ally target — swing whiffs. Mind Control never
            // routes through the controlled side's HP bar.
            this.log(`[LANE ${laneIdx + 1}] [MIND CTRL] ${card.name} has no valid ally to attack — swing whiffs.`);
          }
        } else {
          this.log(`[LANE ${laneIdx + 1}] [MIND CTRL] ${card.name} can't act this turn (stunned / frozen / 0 ATK).`);
        }
        this.cleanupDead();
        if (advanceCallback) advanceCallback();
      });
      return;
    }

    if (card.attack <= 0) return;
    if (card.isStunned || card.isFrozen) return;
    // Parlay — Jack Sparrow singled this card out before combat
    if (card._parlayedThisRound) {
      this.log(`[LANE ${laneIdx + 1}] ${card.name} held by Parlay — cannot attack this round!`);
      return;
    }

    // Feared card attacks itself even when uncontested
    if (card.isFeared) {
      if (card.onBeforeAttack) card.onBeforeAttack(this, card);
      this.log(`[LANE ${laneIdx + 1}] ${card.name} is FEARED and attacks itself!`);
      this.applyCombatDamage(card, card);
      this.cleanupDead();
      return;
    }

    const protectedFromSide = side === 'player' ? 'ai' : 'player';
    if (lane.protected === protectedFromSide) {
      this.log(`  Lane ${laneIdx + 1} protected!`);
      return;
    }
    const targetOwner = this.opponent(side);

    // Check if a taunter redirects this uncontested card
    const tauntTarget = this.getAttackTarget(side, laneIdx);
    if (tauntTarget && tauntTarget.currentHealth > 0) {
      if (card.onBeforeAttack) card.onBeforeAttack(this, card);
      if (card._skipNormalAttack) {
        delete card._skipNormalAttack;
        this.whenPromptCleared(() => { this.cleanupDead(); if (advanceCallback) advanceCallback(); });
        return true;
      }
      this.log(`[LANE ${laneIdx + 1}] ${card.name} is uncontested but redirected by ${tauntTarget.name}'s TAUNT!`);
      this.applyCombatDamage(card, tauntTarget);
      if (card.splashRange > 0) {
        const tauntLane = this.findCardLane(tauntTarget);
        if (tauntLane >= 0) this.applySplash(card, tauntLane);
      }
      this.cleanupDead();
      return;
    }

    if (card.onBeforeAttack) card.onBeforeAttack(this, card);
    if (card._skipNormalAttack) {
      delete card._skipNormalAttack;
      this.whenPromptCleared(() => { this.cleanupDead(); if (advanceCallback) advanceCallback(); });
      return true;
    }
    // Splash only hits enemy cards — it does NOT stack on the main
    // swing when the lane is uncontested. A splash-5 attacker with
    // 7 ATK hitting an open lane deals 7 to the HP bar (not 12); the
    // splash then fires to adjacent lanes as its own effect.
    const uncontestedDmg = this._cardEffectiveAtk(card);
    this.log(`[LANE ${laneIdx + 1}] ${card.name} (${uncontestedDmg} ATK) is uncontested`);
    // Mark the attacker as having swung BEFORE damagePlayer fires so
    // any block-trick that triggers inside (e.g. Fear Toxin played as
    // a free block-meter trick) sees `_combatSwungThisRound = true`
    // on this attacker, which makes tryApplyDebuff stamp
    // `_debuffDelayedClear` so the debuff survives this round's
    // postCombat decrement and lands for next round's swing.
    // User report: "if i use a trick like fear toxin when i block
    // mid combat phase, that debuff should stick until the lane does
    // combat again." Pre-fix the contested path covered this (line
    // 2773), the uncontested path did not.
    card._combatSwungThisRound = true;
    const _hpLanded = this.damagePlayer(targetOwner, uncontestedDmg, card.isBullseye, card);
    // Only fire the on-face-damage hook (Sabertooth's grow) when HP actually
    // dropped — a fully blocked / frozen / absorbed hit must not count.
    if (_hpLanded > 0 && card.onDamagePlayer) card.onDamagePlayer(this, card);
    if (card.splashRange > 0) this.applySplash(card, laneIdx);
    // Uncontested survivor fires onLaneResolved same as a contested winner.
    if (card.currentHealth > 0 && card.onLaneResolved) {
      try { card.onLaneResolved(this, card, laneIdx); } catch (e) { console.error(e); }
    }
    this.cleanupDead();
  },

  // ===================== BLOCK METER =====================

  damagePlayer(owner, amount, isBullseye, source) {
    if (amount <= 0) return;
    // Yoda shield — hero health takes half damage (rounded up)
    if (this.state._yodaShieldFor && this.state._yodaShieldFor[owner] > 0) {
      amount = Math.ceil(amount / 2);
      if (amount <= 0) return;
    }
    const p = this.state[owner];
    const who = owner === 'player' ? 'You' : 'AI';

    // Mr Freeze health bar freeze — negate damage. healthFrozen is a
    // counter (truthy when > 0); classic Mr. Freeze sets it to 1 for a
    // single negation, Text+ "Cryo Wall" sets 2 so the next 2 hits are
    // both negated.
    if (p.healthFrozen) {
      const remaining = (typeof p.healthFrozen === 'number' ? p.healthFrozen : 1) - 1;
      p.healthFrozen = remaining > 0 ? remaining : false;
      if (p._healthFrozenBy) {
        this._creditAbsorb(p._healthFrozenBy, 'Shield', amount);
        if (!p.healthFrozen) p._healthFrozenBy = null;
      }
      const tail = p.healthFrozen ? ` (${p.healthFrozen} more left)` : '';
      this.log(`  [FROZEN HP] ${who} health bar was frozen — ${amount} damage negated!${tail}`);
      return;
    }

    // Mahoraga — "Absorb all damage that would hit your HP". If the player whose
    // HP is about to take damage has a living Mahoraga on their board, redirect
    // the incoming damage to Mahoraga instead of the health bar.
    const mahoraga = this.getAllCardsOf(owner).find(c => c.passive === 'absorbPlayerDamage' && c.currentHealth > 0);
    if (mahoraga && source !== mahoraga) {
      // Credit Mahoraga via Redirect — he took the hit instead of HP.
      this._creditAbsorb(mahoraga, 'Redirect', amount);
      this.log(`  [ABSORB] ${mahoraga.name} absorbs ${amount} damage meant for ${who} HP!`);
      // Invincibility / damage immunity apply to the redirected hit too.
      // Previously this path decremented Mahoraga's HP without checking,
      // so Captain America's Invincible 1 (or any other source) didn't
      // protect him from HP-bar-absorbed damage.
      if (mahoraga.invincibleTurns > 0) {
        this.log(`  [INVINCIBLE] ${mahoraga.name} shrugs off the absorbed damage!`);
        this.emitDmg(mahoraga.id, 0, 'block');
        return;
      }
      if (mahoraga.hasDamageImmunity) {
        this.log(`  [DMG IMMUNE] ${mahoraga.name} ignores the absorbed damage!`);
        this.emitDmg(mahoraga.id, 0, 'block');
        return;
      }
      // Armor reduces the absorbed hit the same way it reduces normal damage.
      let dmg = amount;
      if (mahoraga.armorValue > 0) {
        if (dmg <= mahoraga.armorValue) {
          this.log(`  [ARMOR] ${mahoraga.name}'s Armor ${mahoraga.armorValue} absorbs the ${dmg} damage fully`);
          this.emitDmg(mahoraga.id, 0, 'block');
          return;
        }
        dmg -= mahoraga.armorValue;
        this.log(`  [ARMOR] ${mahoraga.name}'s Armor ${mahoraga.armorValue} reduces damage to ${dmg}`);
      }
      mahoraga.currentHealth -= dmg;
      mahoraga.statsHpTaken = (mahoraga.statsHpTaken || 0) + dmg;
      this.emitDmg(mahoraga.id, dmg, 'hit', undefined, undefined, mahoraga.currentHealth <= 0);
      this.log(`  [HIT] ${mahoraga.name} takes ${dmg} → ${Math.max(0, mahoraga.currentHealth)}/${mahoraga.maxHealth} HP`);
      if (mahoraga.onDamaged) mahoraga.onDamaged(this, mahoraga, source, dmg);
      if (mahoraga.currentHealth <= 0) {
        const lane = this.findCardLane(mahoraga);
        if (lane >= 0) this.handleDeath(mahoraga, lane, source || null);
      }
      return;
    }

    let blockedByMeter = false;
    // Pennywise aura — for 3 rounds after spawning, all face damage on
    // the attacker's side bypasses the block meter (treated as Bullseye).
    if (!isBullseye) {
      const attackerSide = this.opponent(owner);
      if (this.getAllCardsOf(attackerSide).some(c => c._bullseyeRoundsLeft > 0 && c.currentHealth > 0)) {
        isBullseye = true;
      }
    }
    // General Grievous passive — while he's alive on the OPPOSING
    // board, the victim's Block Meter doesn't charge from face hits.
    // _grievousActiveFor[victim_owner] is set/cleared in his
    // onPlay / onDeath hooks. User direction 2026-05-19: "the
    // opposing player cannot charge block when hit for as long
    // as Grievous is alive." Bullseye-skip path doesn't run this
    // either since Grievous's gate is broader than Bullseye.
    const grievousGate = this.state._grievousActiveFor
      && (this.state._grievousActiveFor[owner] || 0) > 0;
    if (!isBullseye && !grievousGate) {
      const roll = 1 + Math.floor(this.rng() * 3);
      p.blockMeter += roll;
      this.log(`  [BLOCK METER] ${who} roll d3=${roll} → meter ${p.blockMeter}/${this.BLOCK_MAX}`);
      if (p.blockMeter >= this.BLOCK_MAX) {
        p.blockMeter = 0;
        blockedByMeter = true;
        // Track block-meter trigger for the victory-screen stats panel.
        if (this.state._stats && this.state._stats[owner]) {
          this.state._stats[owner].blockTriggers++;
        }
        this.log(`  [BLOCKED!] ${amount} damage fully blocked! Meter reset to 0`);
        this.emitDmg(null, amount, 'blocked', owner);
        // 2v2: both teammates draw a trick directly from the shared 2v2 trick pile
        if (this.is2v2()) {
          const tt = this.state.twoVTwo;
          const team = owner === 'player' ? 'A' : 'B';
          Object.keys(tt.players)
            .filter(pk => tt.players[pk].team === team)
            .forEach(pk => {
              if (tt.trickDrawPile.length > 0) {
                const def = tt.trickDrawPile.pop();
                tt.players[pk].trickHand.push({ ...def, id: nextCardId++ });
                this.log(`  [BLOCK DRAW] ${tt.players[pk].name} draws: ${def.name}`);
              }
            });
          return;
        }
        // Draw a trick card on block — can play free now or keep at regular cost.
        // Pulls from the owner's trick pile (Classic = shared, Deckbuilder = per-player).
        const blockTrickPile = this.getTrickPile(owner);
        if (blockTrickPile.length) {
          const def = blockTrickPile.pop();
          const trick = { ...def, id: nextCardId++ };
          this.log(`  [BLOCK DRAW] ${who} draw trick: ${trick.name}`);
          if (this.isHuman(owner)) {
            // Human: gets choice via UI modal — render immediately so the
            // modal appears, otherwise combat parks in whenPromptCleared
            // with no prompt visible to click (soft-lock).
            this.state.pendingBlockTrick = { ...trick, _btOwner: owner };
            if (typeof UI !== 'undefined' && UI.render) UI.render();
          } else {
            // AI-controlled: auto-play free if it has cards on board, else keep
            if (this.getAllCardsOf(owner).length > 0 && trick.play) {
              this.log(`  [BLOCK TRICK] ${this.seatLabel(owner)} plays ${trick.name} for free!`);
              this.state[owner].playedTrickPile.push({ name: trick.name, cost: trick.cost });
              if (this.state._roundStats) this.state._roundStats.aiTricks.push(trick.name);
              // Surface to the player. This path BYPASSES Game.playTrick
              // (which has its own toast at line ~1739), so without an
              // explicit toast call here the player has no way to know
              // what the AI just played for free off their block. User
              // report: "When the opponent draws a trick when they block
              // and play it, I never know what trick they play. I need
              // to have it shown to me." Prefix with BLOCK so the player
              // also sees that it came from a block-meter trigger, not a
              // normal play.
              if (owner === 'ai' && typeof UI !== 'undefined' && UI.showAITrickToast) {
                UI.showAITrickToast(`${this.seatLabel(owner).toUpperCase()} BLOCKED → ${trick.name}`, trick.desc || '', 'trick');
              }
              this.state._inTrick = true;
              this.state._trickOwner = owner;
              try { trick.play(this, owner); } catch (e) { console.error(e); }
              this.state._inTrick = false;
              this.state._trickOwner = null;
            } else {
              this.addToTrickHand(owner, trick);
              this.log(`  [BLOCK TRICK] ${this.seatLabel(owner)} keeps ${trick.name} in hand`);
              // Toast for the "kept it in hand" case too so the player
              // knows the AI now has a block-trick stashed for later.
              if (owner === 'ai' && typeof UI !== 'undefined' && UI.showAITrickToast) {
                UI.showAITrickToast(`${this.seatLabel(owner).toUpperCase()} BLOCKED → kept ${trick.name}`, 'Held in hand for a future trick phase.', 'info');
              }
            }
          }
        }
        return;
      }
    } else {
      this.log(`  [BULLSEYE] No block meter charge`);
    }

    // Floor HP at 0. gameOver still triggers on `<= 0` (see the two
    // checks in endPhase3 / applyCombatDamage), so this only prevents
    // the UI/stats from seeing a transient "-7 HP" after a killing
    // blow that overkilled the defender. Caught by the invariant
    // sweep in sim/test.js.
    p.health = Math.max(0, p.health - amount);
    this.emitDmg(null, amount, 'hpHit', owner);
    // Stripe's jump trigger — face damage landed on EITHER hero. Fired
    // here (post-floor, damage actually applied) so blocked/absorbed
    // hits never arm the jump.
    this.checkJumpConditions('heroDamaged', { owner });
    // Yoda passive — when an ally deals direct hero damage, a random ally
    // (never Yoda himself) gains a buff it doesn't already have at cap.
    if (source && source.id != null) {
      const attackerOwner = source.owner || this.opponent(owner);
      if (this.state._yodaShieldFor && this.state._yodaShieldFor[attackerOwner] > 0) {
        const pool = this.getAllCardsOf(attackerOwner).filter(
          c => c.currentHealth > 0 && c.name !== 'Yoda'
        );
        if (pool.length) {
          const tgt = pool[Math.floor(this.rng() * pool.length)];
          const available = [];
          if (!(tgt.armorValue >= 1))   available.push('armor');
          if (!(tgt.evadeCharges >= 1)) available.push('evade');
          if (!tgt.isBullseye)          available.push('bullseye');
          if (available.length) {
            const choice = available[Math.floor(this.rng() * available.length)];
            if (choice === 'armor') {
              tgt.armorValue = 1;
              this.log(`  [YODA AURA] ${tgt.name} gains Armor 1!`);
            } else if (choice === 'evade') {
              tgt.evadeCharges = 1;
              this.log(`  [YODA AURA] ${tgt.name} gains Evade 1!`);
            } else {
              tgt.isBullseye = true;
              this.log(`  [YODA AURA] ${tgt.name} gains Bullseye!`);
            }
          }
        }
      }
    }
    // Track face damage for the round recap. Damage to player = damage AI dealt.
    if (this.state._roundStats) {
      const rs = this.state._roundStats;
      if (owner === 'player') { rs.playerDamageTaken += amount; rs.aiDamageDealt += amount; }
      else                    { rs.aiDamageTaken += amount;     rs.playerDamageDealt += amount; }
    }
    // Per-card + per-player stats for the victory-screen top-performer board.
    if (source && source.id != null) {
      this._creditChain(source, 'statsHealthbarDamage', amount);
    }
    if (isBullseye && source) {
      const attackerSide = source.owner || this.opponent(owner);
      if (this.state._stats && this.state._stats[attackerSide]) {
        this.state._stats[attackerSide].bullseyeDamage += amount;
      }
    }
    this.log(`  [DAMAGE] ${who} take ${amount} damage → ${Math.max(0, p.health)}/${p.maxHealth} HP`);
    // Track landed health-bar damage for the currencyOnDamage passive (e.g. Green Lantern).
    // Skip damage that was negated by Block Meter (logically blocked even if HP still ticks down).
    if (source && source.passive === 'currencyOnDamage' && !blockedByMeter && amount > 0) {
      source._damageDealtThisTurn = (source._damageDealtThisTurn || 0) + amount;
    }
    // Immediate game-over check — if this hit dropped HP to 0, end the
    // match RIGHT NOW. Any remaining lanes / queued effects skip via the
    // gameOver gate added in resolveLane and other entry points. User
    // spec: "When the enemy's health or your health goes to 0, the game
    // should be over. There shouldn't be any extra playing." Previously
    // the check only ran at endPhase3 (postCombat), so face damage in
    // lane 1 could let lanes 2-6 still resolve.
    if (p.health <= 0 && !this.state.gameOver) {
      this.state.gameOver = true;
      this.state.winner = (owner === 'player') ? 'ai' : 'player';
      this.log(`=== GAME OVER — ${this.state.winner === 'player' ? 'You Win!' : this.seatLabel('ai') + ' Wins!'} ===`);
      // Pin the killing blow into the HP history BEFORE finalizeStats
      // / showGameOverScreen consume it. Without this push the chart
      // would stop at round-start of the final round (the engine's
      // last snapshot) and never show the actual killing blow. User
      // report: "the graph doesn't show the last round — the round
      // where you killed them."
      this._pinFinalHpHistory();
      if (typeof this.finalizeStats === 'function') this.finalizeStats();
      if (typeof UI !== 'undefined' && UI.showGameOverScreen) {
        // Defer one tick so the killing-blow render has a chance to
        // paint the final HP before the overlay slides in.
        this._matchTimeout(() => UI.showGameOverScreen(this.state.winner), 60);
      }
    }
    // Return the HP damage that actually landed. Every negation path above
    // (frozen HP, Mahoraga absorb, Block Meter, Yoda-to-zero) returns early
    // with undefined, so callers can gate on-hit hooks (e.g. Sabertooth's
    // grow-on-face-damage) on a truthy return instead of firing on blocked hits.
    return amount;
  },

  // Append a final-state datapoint to _hpHistory at the moment the
  // match ends. Idempotent — if the last entry already matches the
  // current HP it skips. Called from BOTH game-over paths:
  //   • postCombat (round resolved, then HP check) → end-of-round kills
  //   • damagePlayer (immediate gameOver on face damage) → mid-combat kills
  // The half-step round number (e.g. round 5 → 5.5) marks "end of
  // round N" on the X-axis without overlapping the round-start
  // snapshot, so the chart line clearly extends from the last
  // round-start point down to zero.
  _pinFinalHpHistory() {
    if (!this.state._hpHistory) return;
    const last = this.state._hpHistory[this.state._hpHistory.length - 1];
    const currentP = Math.max(0, this.state.player.health);
    const currentA = Math.max(0, this.state.ai.health);
    if (!last || last.player !== currentP || last.ai !== currentA) {
      this.state._hpHistory.push({
        round: (this.state.round || 1) + 0.5,
        player: currentP,
        ai: currentA
      });
    }
  },

  // ===================== DRAW PHASE =====================

  drawPhase(onComplete) {
    this.log('--- Draw Phase ---');
    // Dr. Strange / Eye of Agamotto / Dormammu foresight fires here.
    // When a peek resolves and the owner takes a card, it counts AS
    // their draw for this round — the card they picked came from the
    // draw pile, so drawing again would be double-dipping. handleDrStrangeReorder's
    // callback reports which owners consumed their draw via peek; we
    // skip drawCards for them.
    // Roguelite faster-pacing: draw 2 per round instead of 1. User spec:
    // "each time we draw two cards." Doubles the option density per turn
    // and ramps deck-cycling to match the energy curve.
    const baseDraw = (this.state.mode && this.state.mode._roguelite) ? 2 : 1;
    // Relic-driven extra draws (Old Manuscript) — player only. Flat
    // per-round bonus from rare/boss relics, plus an every-other-round
    // bonus from the starter Old Manuscript. User direction:
    // "Have it for every other turn" — applies on odd rounds (1, 3, 5).
    const relicDrawBonus = (this.state.roguelite && this.state.roguelite._extraDraw) || 0;
    const isOddRound = ((this.state.round || 1) % 2) === 1;
    const relicDrawBonusAlt = (isOddRound && this.state.roguelite && this.state.roguelite._extraDrawAlt) || 0;
    const playerDraw = baseDraw + relicDrawBonus + relicDrawBonusAlt;
    this.handleDrStrangeReorder((peeked) => {
      const playerKang = !!this.state.player._kangSkipDraw;
      const aiKang     = !!this.state.ai._kangSkipDraw;
      this.state.player._kangSkipDraw = false;
      this.state.ai._kangSkipDraw     = false;
      if (!peeked.has('player') && !playerKang) this.drawCards('player', playerDraw);
      else this.log(`  [KANG/FORESEE] Pick counts as your draw this round.`);
      if (!peeked.has('ai') && !aiKang) this.drawCards('ai', baseDraw);
      else this.log(`  [KANG/FORESEE] Pick counts as ${this.seatPossessive('ai')} draw this round.`);
      if (onComplete) onComplete();
    });
  },

  drawCards(owner, count) {
    const p = this.state[owner];
    const opp = this.opponent(owner);
    const who = owner === 'player' ? 'You' : 'AI';

    // Lex Luthor's preventDraw passive. In CLASSIC mode this is a hard
    // block (matches the canonical "opponent cannot draw cards" text on
    // his card). In ROGUELITE the default behavior softens to a 1-draw
    // cap per turn — user direction: "Have Lex Luthor say while active,
    // the opponent only draws one card per turn. That's his rare
    // ability." A Lex carrying the Text+ etch (`_lexFullLock`) restores
    // the original full lockdown so the upgrade is a meaningful power
    // spike. With multiple Lexes alive, ANY full-lock Lex on the board
    // wins (full block); otherwise the cap is 1 regardless of count.
    const lexes = this.getAllCardsOf(opp).filter(c => c.passive === 'preventDraw');
    if (lexes.length) {
      const isRoguelite = this.state.mode && this.state.mode._roguelite;
      if (isRoguelite) {
        const fullLock = lexes.some(c => c._lexFullLock);
        if (fullLock) {
          this.log(`[BLOCKED] Lex Luthor (Total Lockdown) prevents ${who} from drawing!`);
          return;
        }
        if (count > 1) {
          this.log(`  [LEX] Lex Luthor caps ${who}'s draw at 1.`);
          count = 1;
        }
      } else {
        this.log(`[BLOCKED] Lex Luthor prevents ${who} from drawing!`);
        return;
      }
    }

    const drawn = [];
    for (let i = 0; i < count; i++) {
      if (p.hand.length >= p.maxHandSize) {
        // Auto-discard floor — if the next-to-draw is a discard-only
        // card (Mr. Fantastic / Catwoman / Jigsaw / Professor X), fire
        // its effect for FREE instead of silently losing the card to
        // the hand cap. Audit finding: discard-onlys felt useless late
        // in a roguelite run when the player's hand stayed full.
        // Roguelite-only + player-only — AI's discard plays are
        // handled by the AI's strategic card-selection layer; classic
        // mode behavior unchanged.
        const isRogueliteAuto = this.state.mode && this.state.mode._roguelite;
        if (isRogueliteAuto && owner === 'player') {
          const drawPile = this.getDrawPile(owner);
          const top = drawPile.length ? drawPile[drawPile.length - 1] : null;
          if (top && top.isDiscardEffect) {
            drawPile.pop();
            // Rebuild via the same path drawCards uses below for normal
            // draws, so etches / _runDeckCardRef / XP attribution stay
            // intact. Roguelite player cards always carry _runDeckCardRef.
            const ref = top._runDeckCardRef;
            let card;
            if (ref && typeof Roguelite !== 'undefined' && Roguelite.buildRunCard) {
              card = Roguelite.buildRunCard(ref, owner) || top;
            } else if (top._isCardInstance) {
              card = top;
            } else {
              card = this.createCardInstance(top, owner);
            }
            this.log(`  [AUTO-DISCARD] ${who} discard ${card.name} at hand cap — effect fires free.`);
            this.state[owner].discardPile.push({
              name: card.name, cost: card.baseCost || card.cost,
              type: card.type, abilities: card.abilities, desc: card.desc,
              isDiscardEffect: true,
              _sourceInstance: card,
            });
            if (card.onDiscard) card.onDiscard(this, owner, card);
            continue;  // try the next draw — multi-stack discards keep firing
          }
        }
        this.log(`  [HAND FULL] ${who} hand at max (${p.maxHandSize}) — stop drawing.`);
        break;
      }
      const drawPile = this.getDrawPile(owner);
      if (!drawPile.length) {
        // Roguelite mode: reshuffle the dead pile back into the draw
        // pile so deck doesn't bottom out mid-fight. User spec: "when
        // your deck is empty, it's not drawing from the dead pile and
        // reintroducing the cards back into your deck. Can we fix
        // that?" Cards keep their _runDeckCardRef so XP still tracks.
        // Deck-cycling is intentional in roguelite — energy ramps fast,
        // matches end in 5-6 rounds, the player will run out of cards.
        const isRoguelite = this.state.mode && this.state.mode._roguelite;
        const dead = this.state[owner] && this.state[owner].deadPile;
        // Roguelite reshuffle now applies to BOTH sides. Player-only
        // gating used to make boss fights win-by-attrition: against
        // Lex Luthor especially, the AI's 30-card deck would deplete
        // and the player ran out the clock. Boss intent is "outpunch
        // them," not "outlast them." User report: "the way I win is
        // that the AI runs out of cards." Fix: AI reshuffles its
        // dead pile too so each fight stays an HP race.
        if (isRoguelite && dead && dead.length) {
          const recycled = dead.splice(0, dead.length);
          // Fisher-Yates shuffle in-place before merging back
          for (let j = recycled.length - 1; j > 0; j--) {
            const k = Math.floor(this.rng() * (j + 1));
            [recycled[j], recycled[k]] = [recycled[k], recycled[j]];
          }
          drawPile.push(...recycled);
          this.log(`[RESHUFFLE] ${owner}'s draw pile empty — ${recycled.length} dead-pile cards shuffled back in.`);
        } else {
          this.log(`[DECK] Draw pile empty — no cards to draw!`);
          break;
        }
      }
      const def = drawPile.pop();
      // Roguelite paths populate the draw pile with PRE-BUILT card
      // instances from buildRunCard — they already carry the right
      // attack/baseHealth/etches/relics/_runDeckCardRef. Re-running
      // createCardInstance would treat them as defs (via def.health
      // which is undefined on instances → safeHp=1 floor → all cards
      // come out as ATK/1) AND zero out their etches. Detect a pre-
      // built instance via the marker `_isCardInstance` (set during
      // createCardInstance) and bypass the rebuild — we still need
      // to refresh per-fight state (currentHealth = maxHealth, status
      // counters cleared) but not full re-instantiation.
      let card;
      // ROGUELITE STARTER GUARD. User report: "There's still a Brute
      // in the deck that doesn't have Taunt 1." Root cause was the
      // dead-pile reshuffle path leaving a Brute's abilities array in
      // a drifted state across the fight. Whenever a player-side card
      // comes through the reshuffle with a `_runDeckCardRef` (meaning
      // it's a roguelite deck card), defer to Roguelite.buildRunCard
      // which always reconstructs from the canonical STARTER_DEFS / def
      // source + applies fresh etches. Guarantees a starter Brute is
      // always ['Taunt 1'].
      const ref = def && def._runDeckCardRef;
      if (ref && owner === 'player' && typeof Roguelite !== 'undefined' && Roguelite.buildRunCard) {
        const rebuilt = Roguelite.buildRunCard(ref, 'player');
        if (rebuilt) {
          card = rebuilt;
          card.currentHealth = card.maxHealth;
        } else {
          card = def;
        }
      } else if (def && def._isCardInstance) {
        card = def;
        // Fresh-fight reset on per-fight transient state (statuses,
        // bonus-attack queue, etc.). Etches and stat bumps stay; HP
        // tops back up to maxHealth.
        card.currentHealth = card.maxHealth;
        card.isStunned = false; card.isFrozen = false; card.isFeared = false; card.isMindControlled = false;
        card.stunnedTurns = 0; card.frozenTurns = 0; card.fearedTurns = 0;
        card.bonusAttack = false;
        card.tauntTurns = 0;
        card._deathHandled = false;
        card._phoenixUsed = false;
        // Re-stamp Taunt counter for cards whose abilities still list
        // a Taunt N keyword. Starter Brute (always ['Taunt 1']) and
        // any card that earned Taunt via etch rely on this — without
        // it, the previous reset zeroes their taunt for every fight.
        if (Array.isArray(card.abilities)) {
          card.abilities.forEach(ab => {
            const m = /^Taunt\s+(\d+)$/i.exec(ab);
            if (m) card.tauntTurns = Math.max(card.tauntTurns, parseInt(m[1]) || 1);
          });
        }
      } else {
        card = this.createCardInstance(def, owner);
        // Preserve roguelite run metadata from a dead-pile→draw-pile
        // reshuffle path (createCardInstance doesn't know about these
        // run-only fields, so re-attach them so XP attribution + the
        // rarity-tinted UI both keep working on respawned cards).
        if (def && def._runDeckCardRef) card._runDeckCardRef = def._runDeckCardRef;
        if (def && def._runRarity) card._runRarity = def._runRarity;
        // Fallback: pull rarity from the deckCardRef if the direct
        // _runRarity wasn't set (e.g. older saves from before the
        // rarity-preservation fix). User: "they're placed on board
        // and they're blue. They should keep the same rarity."
        if (!card._runRarity && card._runDeckCardRef && card._runDeckCardRef.rarity) {
          card._runRarity = card._runDeckCardRef.rarity;
        }
        // SAFETY NET — if the dead-pile entry's callback fields were
        // somehow stripped (e.g. a buggy face-down handler that nulled
        // them on the live card before death, or an old save state),
        // re-pull the canonical callbacks from CARD_DEFS where the
        // CARD_ABILITIES merge already lives. User report: "Thug died,
        // got redrawn from the dead pile. I played him. His on-play
        // ability did not happen. Same for Gorilla Grodd."
        if (typeof CARD_DEFS !== 'undefined') {
          const liveDef = CARD_DEFS.find(d => d.name === card.name);
          if (liveDef) {
            if (!card.onPlay && liveDef.onPlay) card.onPlay = liveDef.onPlay;
            if (!card.onDeath && liveDef.onDeath) card.onDeath = liveDef.onDeath;
            if (!card.onDamaged && liveDef.onDamaged) card.onDamaged = liveDef.onDamaged;
            if (!card.onKill && liveDef.onKill) card.onKill = liveDef.onKill;
            if (!card.onEvade && liveDef.onEvade) card.onEvade = liveDef.onEvade;
            if (!card.onAllyKilled && liveDef.onAllyKilled) card.onAllyKilled = liveDef.onAllyKilled;
            if (!card.onEnemyKilled && liveDef.onEnemyKilled) card.onEnemyKilled = liveDef.onEnemyKilled;
            if (!card.onBeforeAttack && liveDef.onBeforeAttack) card.onBeforeAttack = liveDef.onBeforeAttack;
            if (!card.onDamagePlayer && liveDef.onDamagePlayer) card.onDamagePlayer = liveDef.onDamagePlayer;
            if (!card.onAnyCardPlayed && liveDef.onAnyCardPlayed) card.onAnyCardPlayed = liveDef.onAnyCardPlayed;
            if (!card.onTurnStart && liveDef.onTurnStart) card.onTurnStart = liveDef.onTurnStart;
            if (!card.onBeforeTricks && liveDef.onBeforeTricks) card.onBeforeTricks = liveDef.onBeforeTricks;
            if (!card.onEndOfTurn && liveDef.onEndOfTurn) card.onEndOfTurn = liveDef.onEndOfTurn;
            if (!card.onMoved && liveDef.onMoved) card.onMoved = liveDef.onMoved;
            if (!card.passive && liveDef.passive) card.passive = liveDef.passive;
          }
        }
      }
      // Apply Mr. Fantastic next-draw discount permanently. Stash the
      // source amount on the card so hover tooltips can attribute "why
      // is this card cheaper than its base cost?" post-hoc.
      // Mr. Fantastic next-draw discount. nextDrawDiscount is the
      // per-draw rate; nextDrawDiscountCount tracks how many draws still
      // get the discount (Text+ sets it to 2 for the "next 2 draws"
      // upgrade; classic onDiscard sets it to 1).
      if (p.nextDrawDiscount > 0 && (p.nextDrawDiscountCount || 0) > 0) {
        const applied = Math.min(card.cost, p.nextDrawDiscount);
        card.cost -= applied;
        card._nextDrawDiscount = (card._nextDrawDiscount || 0) + applied;
        this.log(`  [DISCOUNT] ${card.name} costs ${applied} less! Now costs ${card.cost}`);
        if (p._nextDrawDiscountSource) {
          this._creditChain(p._nextDrawDiscountSource, 'statsDiscountValue', applied);
        }
        p.nextDrawDiscountCount -= 1;
        if (p.nextDrawDiscountCount <= 0) {
          p.nextDrawDiscount = 0;
          p._nextDrawDiscountSource = null;
        }
      }
      // (Captain America discount is now applied LIVE in
      // Game.getCardCost — no mutation needed at draw time. This
      // means CA's discount tracks the LIVE board state: if CA
      // dies, the next getCardCost call returns full cost. User
      // spec: "his ability should go away when he dies.")
      // Doomsday: set stats from the owner's card-play counter so his
      // strength reflects every card played up to this draw, regardless
      // of whether he was in the pile the whole time.
      if (card.passive === 'doomsdayScaling') {
        const count = (p.cardsPlayedCount || 0);
        card.attack       = 1 + count;
        card.health       = 1 + count;
        card.maxHealth    = 1 + count;
        card.currentHealth = 1 + count;
        this.log(`[DOOMSDAY] Drawn — ${count} cards played, enters as ${card.attack}/${card.maxHealth}`);
      }
      if (!this.addToHand(owner, card)) break;
      drawn.push(card.name);
    }
    if (drawn.length) {
      if (owner === 'player') {
        this.log(`[DRAW] ${who} draw ${drawn.length}: ${drawn.join(', ')}`);
      } else {
        this.log(`[DRAW] ${who} draw ${drawn.length} cards`);
      }
    }
    this.log(`  Draw pile: ${this.getDrawPile(owner).length} cards remaining`);
  },

  // Centralized hand/trick gainers — respect max hand (7) / max trick (3) caps.
  // Return true if added, false if the hand was full (card/trick silently discarded).
  addToHand(owner, card, source) {
    const p = this.state[owner];
    if (p.hand.length >= p.maxHandSize) {
      this.log(`  [HAND FULL] ${this.seatPossessive(owner)} hand is full (${p.maxHandSize}) — ${card && card.name ? card.name : 'card'} discarded.`);
      return false;
    }
    // Bug fix: Moder-stripped cards that bounce back to hand (Phantom
    // Zone, future bounce mechanics) used to stay permanently de-fanged
    // because nobody restored their abilities. The card class stamps a
    // _unstripModer() restore on itself when it gets stripped; we call
    // it here so the card returns to hand with its original kit intact.
    // Idempotent + null-safe — runs on any card, no-op for unstripped.
    if (card && typeof card._unstripModer === 'function') {
      try { card._unstripModer(); } catch (e) { console.error('[unstripModer]', e); }
    }
    p.hand.push(card);
    // Card advantage — if a specific source card caused this hand gain
    // (Hela resurrect, Grundy onDeath, Dr. Doom revive, BWL steal, etc.),
    // credit it with +1 advantage. Deck-draws credit via drawCards path.
    if (source && source.id != null) {
      this._creditChain(source, 'statsCardAdvantage', 1);
    }
    // Retroactive Jump scan. The event-driven checkJumpConditions only
    // fires AT THE MOMENT a triggering card is played — so if Michael
    // Myers is drawn AFTER a lower-cost enemy already landed, his
    // jump window stayed shut. User report: "Michael didn't get the
    // option to jump even though these mercenaries are too low cost."
    // Fix: when Michael Myers enters the hand, scan the current enemy
    // board and trigger if any live card has cost < his cost.
    this._checkJumpOnDraw(owner, card);
    return true;
  },

  // State-based jump check — fires at draw/addToHand time. Only Michael
  // Myers has a state-based trigger (any enemy card with cost < his on
  // board). Ghostface (enemy trick) and Jason Voorhees (ally died) are
  // event-only — by the time the card lands in hand, the trick is
  // resolved or the death already happened, so retroactive doesn't fit.
  _checkJumpOnDraw(owner, card) {
    if (!card || card.jumpReady) return;
    if (card.name !== 'Michael Myers') return;
    // Don't trigger during the end-of-round draw phase — combat is already
    // done and the jumpReady would bleed into the next round. Myers must
    // be in hand WHEN a triggering card is played, not drawn afterwards.
    if (this.state._combatFinishedThisRound) return;
    const opp = this.opponent(owner);
    const myCost = (card.baseCost != null ? card.baseCost : card.cost);
    // User direction 2026-05-19: "Michael's jump needs to be
    // contained to each round. He can't jump against an enemy
    // played last round." The event-driven path
    // (checkJumpConditions on cardPlayed) already only fires for
    // this-round plays. The retroactive scan here was the loophole
    // — Michael drawn mid-round would scan ALL living enemies,
    // including ones who entered prior rounds. Gate by
    // statsEnteredRound (stamped at addToLane / playCardFree) so
    // only enemies who entered THIS round count.
    const thisRound = this.state.round || 1;
    for (let i = 0; i < Game.LANE_COUNT; i++) {
      const e = this.state.lanes[i] && this.state.lanes[i][opp];
      if (!e || e.currentHealth <= 0) continue;
      if (e.statsEnteredRound !== thisRound) continue;
      const eCost = (e.baseCost != null ? e.baseCost : e.cost);
      if (eCost < myCost) {
        card.jumpReady = true;
        card.jumpLane = i;
        this.log(`  [JUMP] Michael Myers senses weakness in lane ${i + 1}! Free play available.`);
        return;
      }
    }
  },
  addToTrickHand(owner, trick) {
    const p = this.state[owner];
    if (p.trickHand.length >= p.maxTrickHandSize) {
      this.log(`  [TRICKS FULL] ${this.seatPossessive(owner)} trick hand is full (${p.maxTrickHandSize}) — ${trick && trick.name ? trick.name : 'trick'} discarded.`);
      return false;
    }
    p.trickHand.push(trick);
    return true;
  },

  // ===================== DEATH =====================

  handleDeath(card, laneIdx, killer) {
    // THE STACK entrance gate — a death fired while another death is
    // resolving (bonus-attack chains, deathrattle summons that kill,
    // on-kill broadcast handlers) queues and resolves after the current
    // one fully completes, in the order caused. Top-level deaths run
    // inline exactly as before. The ui.js wrapper (derez + death cue)
    // has already run by the time we get here, so a queued death keeps
    // its instant visual while the engine bookkeeping linearizes.
    if (this._stackResolving) {
      if (card._deathQueued || card._deathHandled) return;
      card._deathQueued = true;
      this._stack.push({ type: 'death', card, killer, label: `death:${card.name || '?'}` });
      this._stackHighWater = Math.max(this._stackHighWater, this._stack.length);
      return;
    }
    this._stackResolving = true;
    try {
      this._handleDeathNow(card, laneIdx, killer);
      this._stackDrain();
    } finally { this._stackResolving = false; }
  },

  _handleDeathNow(card, laneIdx, killer) {
    if (card._deathHandled) return;
    card._deathHandled = true;
    // Phoenix etch — once-per-life revive at full HP. Cancels the
    // death entirely: clear the guard, restore HP, fire onDeath-style
    // visuals via the helper, return early so dead-pile push and
    // killer-credit don't fire. Killer still got the [HIT] log + damage
    // credit (those happen in applyCombatDamage / dealDamage), so the
    // sting against the attacker is preserved — they just don't get
    // the kill counter. For Echo+Phoenix, the multiple revive charges
    // are spent across separate deaths (not a single one).
    if (this._resolvePhoenix(card)) {
      card._deathHandled = false;
      // Re-credit the killer's miss — they thought they killed it. The
      // [KILLED] line in applyCombatDamage already logged the swing as
      // lethal; statsKills was already incremented. We don't undo those
      // here (it'd be very expensive to track), but the in-game flow is
      // correct: card is back at full HP and on the board.
      return;
    }
    // IRON GIANT death-guard — if the dying card's owner holds Iron Giant
    // in hand, the death PAUSES on a sacrifice offer (prompt for humans,
    // heuristic for AI). Runs AFTER Phoenix (a free full-HP revive should
    // never burn the Giant) and BEFORE kill-stats/onDeath (a saved card
    // was never killed). While the offer is pending the card sits in its
    // lane at ≤0 HP with _deathHandled=true, so cleanupDead re-entries
    // no-op at the guard above. Returns true when the death is deferred
    // (pending prompt) or cancelled (save applied) — we bail out here and
    // the resolve callback either restores the card or re-enters
    // handleDeath to finish the death for real.
    if (this._ironGiantIntercept(card, laneIdx, killer)) return;
    // Track the kill for the round recap. Card dying on AI side = player's kill.
    if (this.state._roundStats) {
      const rs = this.state._roundStats;
      if (card.owner === 'ai') rs.playerKills.push(card.name);
      else if (card.owner === 'player') rs.aiKills.push(card.name);
    }
    // Poison Ivy reactive-unbuff — if the dying card is someone's Ivy
    // charm target, strip her charm ATK buff. The buff represents a
    // bonus "while this ally is still alive"; if the ally dies mid-
    // turn the bonus shouldn't persist to Ivy's swing. User-reported
    // bug: "Poison Ivy charmed Human Torch. Human Torch died. Poison
    // Ivy shouldn't gain extra attack anymore."
    try {
      const deadId = card.id;
      this.getAllCardsOnBoard().forEach(c => {
        if (!this.isCardKind(c, 'Poison Ivy') || c._ivyCharmedId !== deadId) return;
        if (!c._grantedBuffs || !c._grantedBuffs.length) return;
        const idx = c._grantedBuffs.findIndex(b => b._ivyCharm);
        if (idx < 0) return;
        const b = c._grantedBuffs[idx];
        // Reverse the buff manually (expireGrantedBuffs won't fire
        // until end of turn, and the swing happens before that).
        if (b.set) {
          c[b.prop] = b.prev;
        } else {
          c[b.prop] = (c[b.prop] || 0) - (b.delta || 0);
          if (b.prop === 'attack') c[b.prop] = Math.max(0, c[b.prop]);
        }
        c._grantedBuffs.splice(idx, 1);
        c._ivyAlly = null;
        c._ivyCharmedId = null;
        // Mirror the cleanup of the dead ally's _charmedByIvy tag so
        // any in-flight references stay consistent (re-summons via
        // Hela / Lazarus / etc. won't carry a stale charm flag).
        if (card && card._charmedByIvy === c.id) delete card._charmedByIvy;
        this.log(`[POISON IVY] ${card.name} died — charm bonus fades (-${b.delta || 0} ATK, now ${c.attack}).`);
      });
    } catch (e) { console.error(e); }
    if (card.onDeath) {
      const prevented = this._runHook(card, 'onDeath', this, card, laneIdx);
      if (prevented) {
        // Card survived (e.g. resurrection) — clear the guard so future deaths are processed
        card._deathHandled = false;
        return;
      }
    }
    // Generic Revive — for any card granted reviveCharges by an ability
    // (e.g. Revan). Cards with custom revive logic (Jason, Grundy, Drax)
    // consume their charges inside onDeath and return true, so they never
    // reach here.
    // REVIVE = PLAYED ANEW (user spec): the card re-enters the board as if it
    // were just played for the first time — not just stats dropped back on:
    //   1) base keyword abilities re-initialize (Evade / Armor / Immunity /
    //      Taunt / … charges come back fresh),
    //   2) its On Play re-triggers (Loki refills the Block Meter, etc.),
    //   3) Draw-on-play resolves again (Dormammu draws).
    // The decremented revive count is preserved across the ability re-parse so
    // a base "Revive N" ability can't re-grant itself an infinite loop.
    if (card.reviveCharges > 0) {
      // Voided lane — a revive can NEVER fire from a destroyed lane. No
      // card can stand in a destroyed lane, so there is nowhere to rise
      // (user: "the revive wouldn't happen for Wolverine — no card can be
      // in a destroyed lane"). The old behavior relocated the reviver to
      // an open lane ("thrown clear of the void"), which made Darkseid's
      // purge soft against Revive bodies; now the void simply claims them.
      const deathLane = this.findCardLane(card);
      let reviveBlocked = false;
      if (deathLane >= 0 && this.state.lanes[deathLane].destroyed) {
        reviveBlocked = true;
        this.log(`  [VOID] ${card.name} cannot revive — the lane is destroyed. The void claims them.`);
      }
      if (!reviveBlocked) {
      card.reviveCharges--;
      card.currentHealth = card.maxHealth;
      card._deathHandled = false;
      const chargesLeft = card.reviveCharges;
      try { this.applyAbilities(card); } catch (e) {}
      card.reviveCharges = chargesLeft;
      this.log(`  [REVIVE] ${card.name} revives — and is played anew! (${chargesLeft} charge${chargesLeft === 1 ? '' : 's'} left)`);
      if (typeof UI !== 'undefined' && UI.sfx && UI.sfx.playEffectSfx) {
        try { UI.sfx.playEffectSfx('Revive', card); } catch (e) {}
      }
      const reviveLane = this.findCardLane(card);
      if (reviveLane >= 0) {
        try { this._runHook(card, 'onPlay', this, card, reviveLane); } catch (e) {}
        // Draw-on-play trait — same consumption as the playCard path.
        if (card.drawOnPlay > 0) {
          const n = card.drawOnPlay;
          card.drawOnPlay = 0;
          const before = this.state[card.owner].hand.length;
          this.drawCards(card.owner, n);
          const actuallyDrawn = this.state[card.owner].hand.length - before;
          if (actuallyDrawn > 0) this._creditChain(card, 'statsCardAdvantage', actuallyDrawn);
          this.log(`${card.name} draws ${n} card${n > 1 ? 's' : ''}.`);
        }
      }
      return;
      } // !reviveBlocked — blocked revives fall through to normal death
    }
    const who = card.owner === 'player' ? 'Your' : "AI's";
    this.log(`[DEAD] ${who} ${card.name} destroyed in lane ${laneIdx + 1} → dead pile`);
    // Spawn destroy particles at the card's current DOM location so the
    // board reads as "the card shattered here" before the next render
    // sweeps the DOM. No-op in sim mode where UI is stubbed.
    if (typeof UI !== 'undefined' && UI.spawnDestroyParticles) UI.spawnDestroyParticles(card.id, card.owner);
    if (card.statsLeftRound == null) card.statsLeftRound = this.state.round || 1;
    // Victory-panel stat: count kills on the killer's side. Every death
    // of an enemy card counts toward the opposing side's total — even if
    // the `killer` object has no owner (tricks use anonymous source
    // objects like `{name:'Fear Toxin'}`, Galactus devour passes null,
    // etc.). Previously these untraceable kills weren't counted, which
    // is why cardsKilled under-reported. Per-card statsKills (+5 MVP per
    // kill) still only fires when we have a real killer with an owner.
    const killerSide = (killer && killer.owner && killer.owner !== card.owner)
      ? killer.owner
      : this.opponent(card.owner);
    if (this.state._stats && this.state._stats[killerSide]) {
      this.state._stats[killerSide].cardsKilled++;
    }
    if (killer && killer.owner && killer.owner !== card.owner) {
      this._creditChain(killer, 'statsKills', 1);
      // Kill TEMPO — sum of baseCost of cards destroyed. Credits the
      // killer with the energy the opponent had to invest in the card
      // we removed. Sabermetrics-MVP refactor: damage already counts
      // in faceDamage/boardDamage, so the kill itself is rewarded with
      // tempo (cost) rather than the previous attack+maxHP+cost lump
      // (which double-counted the damage that did the killing).
      const killTempo = (card.baseCost || card.cost || 0);
      this._creditChain(killer, 'statsKillTempo', killTempo);
      // Keep statsKillValue populated for back-compat / dashboard
      // displays that still read it; set to the simpler tempo number.
      this._creditChain(killer, 'statsKillValue', killTempo);
    }
    this.removeFromLane(card, laneIdx);
    // Tokens (inline-summoned Ant/Parademon/etc. — see _isToken flag in
    // summonCard) skip the dead pile entirely. They're ephemeral and
    // shouldn't be resurrected by Lazarus Pit / Solomon Grundy / Hela.
    // Stats for living tokens are still tracked while alive; we just
    // drop the persistent record on death so no pile effect can see them.
    if (card._isToken) {
      // onDeath already fired at the top of handleDeath. Run the other
      // death-adjacent hooks (killer onKill, ally onAllyKilled, jump
      // checks, bonus-attack drain) but skip the deadPile push and the
      // passive-cleanup branches (Magneto / faceDownOption) since
      // tokens don't carry those passives.
      if (killer && killer.onKill) killer.onKill(this, killer);
      const livingAllies = this.getAllCardsOf(card.owner);
      livingAllies.forEach(a => { if (a.onAllyKilled) a.onAllyKilled(this, a); });
      const livingEnemiesT = this.getAllCardsOf(this.opponent(card.owner));
      livingEnemiesT.forEach(a => { if (a.onEnemyKilled) a.onEnemyKilled(this, a); });
      this._scaleDoomsdayInHands(card.owner);
      livingAllies.forEach(a => this.drainBonusAttacks(a));
      this.checkJumpConditions('allyDied', { owner: card.owner, laneIdx });
      return;
    }
    // Coerce any NaN/undefined stats before archiving — a dead-pile
    // entry with corrupted health/attack will reanimate via Solomon
    // Grundy / Hela / Lazarus Pit as a NaN card that propagates the
    // corruption into live combat. Fall back to baseAttack/baseHealth
    // (the def's starting stats, captured at createCardInstance time)
    // when the current value is bad. Caught by sim/test.js's invariant
    // sweep.
    // RESET ON DEATH — when a card hits the dead pile, snapshot its
    // BASE stats and abilities (not the buffed/debuffed/status-laden
    // current state). User spec: "when a card dies and is in the dead
    // pile, return its stats and status badges to their original
    // numbers, so if they are revived they are just like new."
    //
    // What gets reset (via base lookup):
    //   • attack (baseAttack)              — buffs/debuffs cleared
    //   • health/maxHealth (baseHealth)    — back to full
    //   • cost (baseCost)                  — discount/inflation cleared
    //   • abilities (baseAbilities)        — Loki temp keywords gone
    //
    // What gets cleared by virtue of NOT being copied:
    //   • frozenTurns / stunnedTurns / fearedTurns / mind-control flags
    //   • _grantedBuffs (Ivy charm, Power Stone +3, etc.)
    //   • Magneto even-lane debuff, Man-Bat -1/-1 stacks
    //   • Anakin buff stacks, Sabretooth's accumulated kills
    // The revived card comes back exactly as it was drafted, fresh.
    const baseAtk = (typeof card.baseAttack === 'number' && Number.isFinite(card.baseAttack))
                      ? card.baseAttack
                      : ((typeof card.attack === 'number' && Number.isFinite(card.attack)) ? card.attack : 0);
    const baseHp  = (typeof card.baseHealth === 'number' && Number.isFinite(card.baseHealth) && card.baseHealth > 0)
                      ? card.baseHealth
                      : ((typeof card.maxHealth === 'number' && Number.isFinite(card.maxHealth) && card.maxHealth > 0) ? card.maxHealth : 1);
    // Defensive: if the card lost its owner pointer somehow (e.g. a
    // dev-console-injected card or a malformed clone), don't deadlock
    // the whole combat loop — log + skip the dead-pile archive. The
    // card was already pulled from the lane above; missing it from the
    // dead pile only means resurrection abilities (Solomon Grundy /
    // Lazarus Pit / Hela) can't see it. Better than a hard freeze.
    if (!card.owner || !this.state[card.owner] || !this.state[card.owner].deadPile) {
      this.log(`  [WARN] handleDeath: card "${card.name || '?'}" has no owner — skipping dead-pile archive.`);
      return;
    }
    this.state[card.owner].deadPile.push({
      name: card.name, cost: card.baseCost || card.cost, attack: baseAtk,
      health: baseHp,
      // Restore the original ability list. createCardInstance stamps
      // baseAbilities = abilities at draft time, so this captures the
      // truly fresh keywords. Loki's stolen-keyword "Untrickable", Ivy's
      // charm-derived ATK, etc. all evaporate.
      abilities: (Array.isArray(card.baseAbilities) ? card.baseAbilities.slice() : (card.abilities || [])),
      type: card.type,
      desc: card.desc, onPlay: card.onPlay, onDeath: card.onDeath,
      onDamaged: card.onDamaged, onKill: card.onKill, passive: card.passive,
      // Preserve roguelite run metadata so XP attribution can find this
      // dead card's deckCard-of-record + the deck-reshuffle-into-draw
      // path can reconstruct the run instance with all etches/relics
      // intact (re-enters via Roguelite._reshuffleDeadIntoDraw).
      _runDeckCardRef: card._runDeckCardRef || null,
      _runRarity: card._runRarity || null,
      // Preserve per-card stats so the victory screen can tally top performers
      // across the whole game (cards that died count just as much as living).
      statsHealthbarDamage: card.statsHealthbarDamage || 0,
      statsEnemyDamage: card.statsEnemyDamage || 0,
      statsDamageAbsorbed: card.statsDamageAbsorbed || 0,
      statsAbsorbArmor:      card.statsAbsorbArmor      || 0,
      statsAbsorbInvincible: card.statsAbsorbInvincible || 0,
      statsAbsorbEvade:      card.statsAbsorbEvade      || 0,
      statsAbsorbRedirect:   card.statsAbsorbRedirect   || 0,
      statsAbsorbLockdown:   card.statsAbsorbLockdown   || 0,
      statsAbsorbShield:     card.statsAbsorbShield     || 0,
      statsHpTaken:          card.statsHpTaken          || 0,
      statsKills: card.statsKills || 0,
      statsEnergyGenerated: card.statsEnergyGenerated || 0,
      statsHealLeveraged: card.statsHealLeveraged || 0,
      statsKillTempo: card.statsKillTempo || 0,
      statsEnteredRound: card.statsEnteredRound,
      statsLeftRound: card.statsLeftRound,
      owner: card.owner,
    });
    if (killer && killer.onKill) killer.onKill(this, killer);
    const livingAllies = this.getAllCardsOf(card.owner);
    livingAllies.forEach(a => { if (a.onAllyKilled) a.onAllyKilled(this, a); });
    const livingEnemies = this.getAllCardsOf(this.opponent(card.owner));
    livingEnemies.forEach(a => { if (a.onEnemyKilled) a.onEnemyKilled(this, a); });
    this._scaleDoomsdayInHands(card.owner);
    // Drain bonus attacks immediately on every death — combat or
    // trick-triggered. User spec: "Anakin and bonus attacks in general
    // shouldn't happen at the end of the round but instead immediately."
    // Previously combat deaths batched these to postCombat so a chain
    // of "Ahsoka swings → kills → triggers Anakin" landed all at once
    // at end-of-round; now each link of the chain fires in real time
    // alongside the death that triggered it.
    livingAllies.forEach(a => this.drainBonusAttacks(a));
    // Check jump conditions — an ally died. Pass laneIdx so Jason
    // Voorhees locks to the exact lane that opened up (mirrors the
    // token-death path at the top of handleDeath which already passed
    // laneIdx). Without it, Jason's jumpLane was undefined and the
    // jump fell through to the "pick any open lane" generic branch.
    this.checkJumpConditions('allyDied', { owner: card.owner, laneIdx });
    // Remove Magneto debuffs if Magneto died
    if (this.isCardKind(card, 'Magneto')) this.removeMagnetoDebuffs(card.owner);
    // Revoke faceDownOption if the card granting it died
    if (card.passive === 'faceDownOption') {
      this.state[card.owner].faceDownAvailable = this.getAllCardsOf(card.owner).some(c => c.passive === 'faceDownOption');
    }
  },

  // Doomsday "while in hand" scaling — called after every card death.
  // deadOwner = owner of the card that just died ('player' or 'ai').
  // - In hand: cost drops only when an ally (same owner) is killed.
  // - In draw pile: stats grow for every death, cost stays locked.
  // Ally death: cost drops by 1 for any Doomsday the same owner has in hand.
  // Draw-pile Doomsday is unaffected by deaths — stats only grow on card plays.
  _scaleDoomsdayInHands(deadOwner) {
    for (const side of ['player', 'ai']) {
      const hand = this.state[side] && this.state[side].hand;
      if (!hand) continue;
      hand.forEach(c => {
        if (c.passive !== 'doomsdayScaling') return;
        if (c.owner === deadOwner) {
          c.cost = Math.max(0, (c.cost || 0) - 1);
          this.log(`[DOOMSDAY] Ally fell — cost drops to ${c.cost}`);
        }
      });
    }
  },

  // Called after the owner plays any card. Grows +1/+1 whether Doomsday
  // is in hand OR still in the draw pile — so a late draw still arrives
  // buffed. Cost never changes here; cost only drops on ally deaths while
  // Doomsday is already in hand (_scaleDoomsdayInHands above).
  _scaleDoomsdayOnOwnerPlay(owner) {
    // Track total cards played so that a Doomsday still in the draw pile
    // gets the right stats the moment it's drawn (see drawCards).
    const p = this.state[owner];
    if (p) p.cardsPlayedCount = (p.cardsPlayedCount || 0) + 1;

    // If Doomsday is already in hand, scale him live so the card updates visually.
    const hand = p && p.hand;
    if (hand) {
      hand.forEach(c => {
        if (c.passive !== 'doomsdayScaling') return;
        c.attack = (c.attack || 0) + 1;
        c.maxHealth = (c.maxHealth || 0) + 1;
        c.currentHealth = (c.currentHealth || 0) + 1;
        this.log(`[DOOMSDAY] Owner played a card — grows to ${c.attack}/${c.maxHealth} (cost ${c.cost})`);
      });
    }
    // Draw-pile Doomsday is NOT mutated here. His stats are set from
    // cardsPlayedCount the moment he is drawn (see drawCards).
  },

  // Execute queued bonus attacks on one card (Ahsoka, Superman, etc.).
  // `bonusAttack` may be a boolean (1 attack) or an integer (N queued attacks).
  // Called from postCombat (batched combat deaths) and handleDeath (immediate
  // drain after trick-triggered deaths, so a dying ally can still retaliate).
  // Lex Luthor's aura suppresses all bonus attacks of his enemies while alive.
  drainBonusAttacks(c) {
    if (!c) return;
    let remaining = typeof c.bonusAttack === 'number' ? c.bonusAttack : (c.bonusAttack ? 1 : 0);
    if (remaining <= 0) return;
    const oppSide = this.opponent(c.owner);
    // Lex Luthor's bonus-attack suppression. CLASSIC: any Lex on the
    // opposite side blocks bonus attacks (matches his canonical card
    // text). ROGUELITE: only Lexes carrying the Text+ etch
    // (`_lexFullLock`) suppress — default Lex just caps draws to 1.
    // User direction: "Have Lex Luthor say while active, the opponent
    // only draws one card per turn. If you upgrade it for the text,
    // it would be the opponent cannot draw any cards or make bonus
    // attacks."
    const isRoguelite = this.state.mode && this.state.mode._roguelite;
    const lexes = this.getAllCardsOf(oppSide).filter(e => e.name === 'Lex Luthor');
    const suppress = isRoguelite ? lexes.some(e => e._lexFullLock) : lexes.length > 0;
    if (suppress) {
      this.log(`  [LUTHOR] ${c.name}'s bonus attack is suppressed by Lex Luthor!`);
      c.bonusAttack = false;
      return;
    }
    c.bonusAttack = false;
    while (remaining > 0 && c.currentHealth > 0) {
      remaining--;
      const lane = this.findCardLane(c);
      if (lane < 0) break;
      const opp = this.opponent(c.owner);
      const enemy = this.state.lanes[lane][opp];
      if (enemy && enemy.currentHealth > 0) {
        // Say "bonus attack" outright rather than "strikes" so the log
        // unambiguously identifies this as a queued bonus-attack hit
        // (Ahsoka / Anakin / Superman) vs a normal combat swing.
        this.log(`  [BONUS ATTACK] ${c.name} makes a bonus attack on ${enemy.name} for ${c.attack}!`);
        this.applyCombatDamage(c, enemy);
        this.cleanupDead();
      } else if (!enemy) {
        // Splash does NOT stack on the HP-bar hit when the lane is
        // uncontested — same rule as normal attacks (see line ~3105
        // and the long comment there). User report: Ahsoka with 1 ATK
        // and Splash 1 was hitting the HP bar for 2 on a bonus attack.
        // The bug was here adding splashRange to the direct-HP damage;
        // normal attacks correctly omit it. Now bonus attacks deal
        // pure ATK to the HP bar, and splash fires separately to
        // adjacent lanes via applySplash.
        const dmg = c.attack;
        // Log BEFORE the damagePlayer call so that if Mr Freeze negates the
        // hit (damagePlayer logs [FROZEN HP] and returns early), the
        // transcript reads "attempt then outcome" instead of showing a
        // misleading "hits for N" line AFTER the negation line.
        this.log(`  [BONUS ATTACK] ${c.name} hits ${opp} health bar for ${dmg}!`);
        this.damagePlayer(opp, dmg, c.isBullseye, c);
        if (c.splashRange > 0) this.applySplash(c, lane);
      }
    }
  },

  cleanupDead() {
    for (let i = 0; i < this.LANE_COUNT; i++) {
      ['player', 'ai'].forEach(o => {
        const c = this.state.lanes[i][o];
        if (c && c.currentHealth <= 0) this.handleDeath(c, i, null);
      });
    }
    // Aura reconcile rides every death sweep — a source that just died has
    // its aura lifted here. Hostile aura kills reap themselves (debuffCard's
    // allowKill path calls killCard), but if a reconcile strands a card at
    // 0 HP through any other path, one bounded re-sweep collects it.
    this.recomputeAuras();
    if (!this._auraReaping) {
      let stranded = false;
      for (let i = 0; i < this.LANE_COUNT && !stranded; i++) {
        const l = this.state.lanes[i];
        stranded = !!((l.player && l.player.currentHealth <= 0) || (l.ai && l.ai.currentHealth <= 0));
      }
      if (stranded) {
        this._auraReaping = true;
        try { this.cleanupDead(); } finally { this._auraReaping = false; }
        return;
      }
    }
    // Centralized void enforcement — evict any LIVING card left in a destroyed
    // lane (a collapse survivor, a pull-in, a move race), regardless of the
    // path that stranded it. Fixes the fuzz-found "X occupies DESTROYED lane"
    // limbo class at the source.
    this._evictAllVoidSurvivors();
    this.checkInvariants('cleanup');
  },

  // ===================== INVARIANT SWEEP =====================
  // Studio-style board-state assertions, run after every death sweep (which
  // follows nearly every action). Each check encodes a bug CLASS this game
  // has actually shipped: limbo cards in destroyed lanes (Wolverine's void
  // revive, Prof X full-board), duplicate slot references (Jason's old
  // relocation), owner/side mismatches (perspective-flip class), multiple
  // Joker Crazy stamps, Crazy+Feared coexistence, NaN stats, environments
  // in combat slots. Violations log ONCE per round per key (no spam) and
  // feed the __clbErrors ring buffer so they survive reload and show up in
  // "Copy bug report" — a violation seen in telemetry = a bug caught before
  // anyone had to notice it on the board.
  _invariantSeen: null,
  // Returns an array of violation strings (empty == clean) so callers — the
  // live engine (fire-and-forget) AND the headless fuzzer — share ONE
  // invariant definition instead of drifting copies. Console + __clbErrors
  // reporting stays deduped per round; the RETURNED array collects every hit.
  checkInvariants(tag) {
    const s = this.state;
    const violations = [];
    if (!s || !s.lanes || s.gameOver) return violations;
    const report = (key, msg) => {
      const line = `[INVARIANT${tag ? ' @' + tag : ''}] ${msg}`;
      violations.push(line); // always collect for the caller (fuzz reads this)
      this._invariantSeen = this._invariantSeen || new Set();
      const k = key + '|' + (s.round || 0);
      if (this._invariantSeen.has(k)) return; // console/telemetry dedup only
      this._invariantSeen.add(k);
      console.error(line);
      try {
        if (typeof window !== 'undefined' && window.__clbErrors) {
          window.__clbErrors.report('invariant', new Error(line));
        }
      } catch (e) { /* reporter must never break the game */ }
    };
    const seenInstances = new Map();
    const seenIds = new Map();
    let crazyStamps = 0;
    for (let i = 0; i < this.LANE_COUNT; i++) {
      const lane = s.lanes[i];
      if (!lane) continue;
      ['player', 'ai'].forEach(side => {
        const c = lane[side];
        if (c) {
          if (lane.destroyed) report('destLane:' + c.name, `${c.name} occupies DESTROYED lane ${i + 1} (limbo class)`);
          if (seenInstances.has(c)) report('dupRef:' + c.name, `${c.name} referenced by two slots (lanes ${seenInstances.get(c)} and ${i + 1})`);
          seenInstances.set(c, i + 1);
          // Registry identity — two DIFFERENT objects must never share an id
          // (the class the entity registry exists to kill: a stale clone
          // colliding with a live card so findCard/FX/MP resolve the wrong
          // instance). dupRef above is same-object-twice; this is
          // same-id-different-object.
          if (c.id != null) {
            const prior = seenIds.get(c.id);
            if (prior && prior !== c) report('idCollision:' + c.id, `id ${c.id} shared by two DIFFERENT cards (${prior.name} lane ${seenInstances.get(prior) || '?'} and ${c.name} lane ${i + 1})`);
            else seenIds.set(c.id, c);
          }
          // Stuck-buff guard — a granted temp buff whose turn counter is
          // non-finite can never expire, welding its stat delta on forever
          // (the "stuck buff" class); a buff missing its prop is equally
          // un-revertable. Both are construction errors the buff-object
          // formalization exists to prevent.
          if (c._grantedBuffs && c._grantedBuffs.length) {
            for (const b of c._grantedBuffs) {
              if (!b || b.prop == null || typeof b.turnsLeft !== 'number' || !Number.isFinite(b.turnsLeft)) {
                report('stuckBuff:' + c.name, `${c.name} holds a malformed granted buff (prop=${b && b.prop}, turnsLeft=${b && b.turnsLeft}) — it can never expire`);
                break;
              }
            }
          }
          if (c.owner !== side) report('owner:' + c.name, `${c.name} sits on '${side}' side but owner='${c.owner}' (flip/placement class)`);
          if (c.isEnvironment) report('envSlot:' + c.name, `${c.name} is an ENVIRONMENT in a combat slot (lane ${i + 1})`);
          if (!Number.isFinite(c.attack) || !Number.isFinite(c.currentHealth) || !Number.isFinite(c.maxHealth)) {
            report('nan:' + c.name, `${c.name} has non-finite stats (${c.attack}/${c.currentHealth}/${c.maxHealth})`);
          }
          if (c._crazyAppliedBy) crazyStamps++;
          // Only a JOKER-STAMPED Crazy (_crazyAppliedBy) must never coexist
          // with Fear — fearCard strips the stamp. INTRINSIC Crazy (Harley's
          // identity) legitimately persists while feared, only suppressed
          // (ATK reverts to base), resuming when fear ends. The old check
          // flagged intrinsic-crazy-while-feared as a false positive (caught
          // by the fuzz on Harley Quinn).
          if (c._crazyAppliedBy && (c.isFeared || (c.fearedTurns | 0) > 0)) {
            report('crazyFear:' + c.name, `${c.name} holds a Joker Crazy stamp AND is Feared — the stamp should have been shattered`);
          }
          // Zombie guard — a card at ≤0 HP that is neither death-handled
          // nor queued for death on the Stack is stuck on the board dead:
          // some damage path drove HP to 0 without routing through
          // handleDeath. Iron-Giant pending offers keep _deathHandled=true;
          // Stack-queued deaths set _deathQueued — both legitimate, both
          // excluded. (This closes a gap: sim/test.js's HUNTER caught these
          // zombies but the engine sweep the fuzz uses did not.)
          if (c.currentHealth != null && c.currentHealth <= 0 && !c._deathHandled && !c._deathQueued) {
            report('zombie:' + c.name, `${c.name} has ${c.currentHealth} HP but no _deathHandled/_deathQueued flag (dead-but-unresolved)`);
          }
        }
        const env = lane._env && lane._env[side];
        if (env && !env.isEnvironment) {
          report('combatEnv:' + env.name, `${env.name} (combat card) is in the ENV slot of lane ${i + 1}`);
        }
      });
      if (lane.destroyed && !(lane.destroyedTurns > 0)) {
        report('destTurns:' + i, `lane ${i + 1} destroyed with no countdown (destroyedTurns=${lane.destroyedTurns})`);
      }
    }
    if (crazyStamps > 1) report('multiCrazy', `${crazyStamps} Joker Crazy stamps on board — must be at most 1`);
    ['player', 'ai'].forEach(side => {
      const p = s[side];
      if (!p) return;
      if (!Number.isFinite(p.currency) || p.currency < 0) report('energy:' + side, `${side} energy invalid: ${p.currency}`);
      if (!Number.isFinite(p.health)) report('hp:' + side, `${side} hero HP non-finite: ${p.health}`);
      const bm = p.blockMeter | 0;
      if (bm < 0 || bm > (this.BLOCK_MAX || 8)) report('block:' + side, `${side} block meter out of range: ${p.blockMeter}`);
    });
    return violations;
  },

  // ===================== GAME API (for card effects) =====================

  log(m) { this.state.log.push(m); if (this.state.log.length > 300) this.state.log.shift(); },

  // MVP attribution — walk up the _summonedBy chain, crediting every
  // ancestor with `amount` on `field`. A cycle guard prevents infinite
  // loops if _summonedBy somehow becomes self-referential (shouldn't
  // happen, but cheap insurance). Safe to call with null/0 — early-exits.
  _creditChain(card, field, amount) {
    if (!card || !amount) return;
    let c = card;
    const seen = new Set();
    while (c && !seen.has(c.id)) {
      c[field] = (c[field] || 0) + amount;
      seen.add(c.id);
      c = c._summonedBy;
    }
  },
  // Damage-denied bookkeeping helper. Credits both the master
  // `statsDamageAbsorbed` total (what the impact formula consumes) AND
  // a per-prevention-type subfield so the dashboard can break down
  // "what kind of defense did this card actually do?" into:
  //   Armor       — armor value reduced/absorbed an incoming hit
  //   Invincible  — Invincible / Damage Immunity negated a hit (full)
  //   Evade       — evade charge ate a swing
  //   Redirect    — Mahoraga / taunt took the hit instead of the target
  //   Lockdown    — freeze/stun phantom-swing (an enemy that COULDN'T
  //                 attack because of this card's freeze/stun lock)
  //   Shield      — Mr. Freeze HP shield (one-shot HP-bar negation)
  // The sum of the subfields must equal the master total.
  _creditAbsorb(card, type, amount) {
    if (!card || amount <= 0) return;
    this._creditChain(card, 'statsDamageAbsorbed', amount);
    this._creditChain(card, 'statsAbsorb' + type, amount);
  },

  // Summon-context stack — an ability hook (onPlay, onDeath, etc.) that
  // summons more cards needs to tell summonCard which card is the source.
  // Instead of threading a summoner param through every ability-file
  // call site, we stash the active source here while a hook is running.
  // Stack (not single slot) supports nested hooks: Cyborg.onDeath fires
  // during mid-play of whatever killed Cyborg; its summon should credit
  // Cyborg, not the killer.
  _pushSummonSource(card) {
    if (!this._summonSourceStack) this._summonSourceStack = [];
    this._summonSourceStack.push(card || null);
  },
  _popSummonSource() {
    if (this._summonSourceStack) this._summonSourceStack.pop();
  },
  _currentSummonSource() {
    const st = this._summonSourceStack;
    return (st && st.length) ? st[st.length - 1] : null;
  },
  // Wrapper around an ability hook that automatically pushes the card as
  // the current summon source and pops on exit. Summons inside the hook
  // will credit this card as _summonedBy. Mirrors the try/catch the
  // manual call sites used previously so ability bugs don't crash.
  _runHook(card, hookName, ...args) {
    if (!card || typeof card[hookName] !== 'function') return undefined;
    this._pushSummonSource(card);
    let result;
    try {
      result = card[hookName](...args);
    } catch (e) {
      console.error('[' + hookName + ']', e);
    } finally {
      this._popSummonSource();
    }
    // Echo etch — re-fire `onPlay` and `onDeath` once per stack of
    // hasEcho. Only the splashy "play" / "death" hooks echo (re-firing
    // onDamaged or onAnyCardPlayed would explode reactive chains and
    // double-credit defensive stats). The card must still be alive
    // for re-fires (a Phoenix-revived card can echo its onPlay; a
    // hard-killed card can't). For onDeath we explicitly allow the
    // re-fire even when currentHealth ≤ 0 since onDeath itself fires
    // on a dying card.
    const echoable = (hookName === 'onPlay' || hookName === 'onDeath');
    if (echoable && card.hasEcho && !card._echoing) {
      const stacks = card.hasEcho;
      card._echoing = true;
      try {
        for (let i = 0; i < stacks; i++) {
          if (typeof card[hookName] !== 'function') break;
          if (hookName === 'onPlay' && card.currentHealth <= 0) break;
          this.log(`  [ECHO] ${card.name}'s ${hookName === 'onPlay' ? 'arrival' : 'death'} effect repeats!`);
          this._pushSummonSource(card);
          try {
            card[hookName](...args);
          } catch (e) {
            console.error('[ECHO ' + hookName + ']', e);
          } finally {
            this._popSummonSource();
          }
        }
      } finally {
        card._echoing = false;
      }
    }
    return result;
  },
  opponent(o) { return o === 'player' ? 'ai' : 'player'; },
  // True if `owner` is controlled by a human (gets modal prompts). False
  // for AI-controlled seats (ability auto-picks the non-prompt branch).
  // Used by every `self.owner === 'player'` check in abilities.js / tricks.js
  // — replacing those with `Game.isHuman(self.owner)` enables multiplayer
  // (both seats human) and makes the sim fully symmetric (both seats AI).
  // ===================== SEAT DISPLAY NAMES =====================
  // Every log line used to hardcode "AI" for the opposing seat, so a human
  // opponent read as a robot: "Gorr devours Thor from AI's hand", "AI Wins!".
  // These resolve a seat to what the local client should actually call it:
  //   • "You" for the seat this client controls
  //   • the real person's name in 1v1 online / hotseat (state._mpNames) and
  //     in 2v2 (twoVTwo.players[].name)
  //   • "AI" only when the opponent genuinely is the computer
  seatLabel(owner) {
    const s = this.state;
    if (!s) return owner === 'player' ? 'You' : 'AI';

    // 2v2 — a SIDE is a whole team, but during a bridged action the side maps
    // to the one player currently acting, so prefer that name; otherwise name
    // both teammates.
    if (this.is2v2 && this.is2v2() && s.twoVTwo) {
      const tt = s.twoVTwo;
      const team = (owner === this._2v2TeamSide.A) ? 'A' : 'B';
      const active = this._2v2ActivePlayer && this._2v2ActivePlayer();
      if (active && tt.players[active] && tt.players[active].team === team) {
        if (tt.you && active === tt.you) return 'You';
        return tt.players[active].name || `Player ${active[1]}`;
      }
      const mates = ['p1', 'p2', 'p3', 'p4']
        .filter(k => tt.players[k] && tt.players[k].team === team)
        .map(k => tt.players[k].name || `P${k[1]}`);
      return mates.length ? mates.join(' & ') : (owner === 'player' ? 'You' : 'AI');
    }

    // 1v1: the local client is always the 'player' seat (guest state is
    // perspective-flipped), so 'player' is "You" and the far seat gets its
    // real name when one exists.
    if (owner === 'player') return 'You';
    const names = s._mpNames;
    if (names && names.ai) return names.ai;
    return 'AI';
  },

  // "your" / "Max's" / "AI's"
  seatPossessive(owner) {
    const l = this.seatLabel(owner);
    if (l === 'You') return 'your';
    return /s$/i.test(l) ? `${l}'` : `${l}'s`;
  },

  // Subject + correctly-agreeing verb: "You take" / "Max takes" / "Max & Sam
  // take". A 2v2 side can resolve to BOTH teammates, which is grammatically
  // plural and needs the same form as "You".
  seatVerb(owner, singular, thirdPerson) {
    const l = this.seatLabel(owner);
    const isPlural = (l === 'You') || l.includes(' & ');
    return `${l} ${isPlural ? singular : thirdPerson}`;
  },

  isHuman(owner) {
    // 1v1 ONLINE: both seats are real people (host=player, guest=ai). Treat
    // EVERY seat as human at all times so ability/summon lane + target choices
    // PROMPT the seat's owner (routed to the guest via promptLaneChoice/
    // promptCardChoice MP handling) instead of falling through to the AI
    // auto-resolve branch, which auto-picks lanes[0] (= lane 1). This is the
    // robust form of the user's directive "treat the joining player as human,
    // never AI" — it no longer depends on the per-seat isHuman flag actually
    // being set at runtime. Single-player keeps the per-seat flag (so the AI
    // seat stays non-human); 2v2 sets its own flags and does not use this.mp.
    if (this.isMultiplayer && this.isMultiplayer()) return true;
    return !!(this.state[owner] && this.state[owner].isHuman);
  },

  // General stat buff: +atk ATK, +hp HP (increases maxHealth and currentHealth)
  buffCard(card, atk, hp) {
    if (!card) return;
    if (this._trickBlocked(card)) return;
    // Defensive: if the card's stats have already been corrupted to
    // NaN/undefined by some earlier bug (see sim/test.js invariant
    // sweep), heal them back to a known-safe floor before applying
    // the new buff — else NaN propagates forever.
    if (typeof card.attack !== 'number' || !Number.isFinite(card.attack)) card.attack = card.baseAttack || 0;
    if (typeof card.currentHealth !== 'number' || !Number.isFinite(card.currentHealth)) card.currentHealth = card.baseHealth || 1;
    if (typeof card.maxHealth !== 'number' || !Number.isFinite(card.maxHealth)) card.maxHealth = card.baseHealth || 1;
    if (typeof atk === 'number' && Number.isFinite(atk) && atk) card.attack += atk;
    if (typeof hp  === 'number' && Number.isFinite(hp)  && hp)  { card.currentHealth += hp; card.maxHealth += hp; }
  },

  // 10-cost cards cannot affect enemy 10-cost cards with abilities.
  is10CostImmune(source, target) {
    if (!source || !target) return false;
    // skipAutoUntrickable marks a card as NOT a titan for the "tens can't
    // touch tens" rule, whichever side of the interaction it's on. Doomsday
    // prints at cost 12 but is a 1/1 that scales down; his Stun/Freeze
    // immunity is earned by reviving, not granted by the printed cost. This
    // is the authoritative engine guard behind drain / devour / destroy /
    // debuff / freeze — getEnemiesOf only hides invalid targets, so without
    // the same exemption here Dormammu's drain still refused to land even
    // once Doomsday was offered.
    if (source.skipAutoUntrickable || target.skipAutoUntrickable) return false;
    return (source.baseCost || source.cost) >= 10 && (target.baseCost || target.cost) >= 10
      && source.owner !== target.owner;
  },

  // ===================== "WHOSE HAND?" — OPPONENT-PLAYER TARGETING ==========
  // Any effect that READS or STEALS from an opponent's hand needs to know
  // WHICH opponent. In 1v1 there's exactly one, so this resolves instantly and
  // nothing about the old behavior changes. In 2v2 there are TWO enemies, and
  // the acting player now gets to choose.
  //
  // Before this, every such effect just used G.state[opp] — the side proxy —
  // which in 2v2 holds whichever enemy happened to be synced there. So you
  // never got the choice and it often hit the wrong player. User report: "my
  // brother played Lasso of Truth and he didn't get to choose what player he
  // wanted to see a card from" (+ "make it the same for any other card where
  // you should [pick] a player to steal a card from or look at cards").
  //
  // `run(oppSide, chosenKey)` is invoked with the chosen player's hand and
  // trickHand temporarily ALIASED onto the opposing side proxy — same array
  // references, so every existing `G.state[opp].hand` read, splice and steal
  // inside these effects works unchanged and mutates the real player's hand.
  // Callers: Lasso of Truth, Deadpool, The Grinch, Mace Windu, Freddy Krueger.
  // opts.autoPick — skip the prompt and choose an enemy automatically
  // (preferring one that actually has cards). For effects that fire on their
  // own every combat rather than by player action: Freddy Krueger slashes the
  // enemy hand on EVERY attack, and asking "whose hand?" on each swing would
  // bury the match in prompts. Player-initiated effects always prompt.
  withChosenOpponent(owner, title, run, opts) {
    const opp = this.opponent(owner);
    const tt = this.state && this.state.twoVTwo;
    if (!this.is2v2() || !tt || !tt.players) { run(opp, null); return; }

    const actingKey = this._2v2CurrentActingPlayer || this._2v2ActivePlayer();
    const myTeam = tt.players[actingKey] ? tt.players[actingKey].team : null;
    const enemyKeys = ['p1', 'p2', 'p3', 'p4']
      .filter(k => tt.players[k] && tt.players[k].team && tt.players[k].team !== myTeam);
    if (!enemyKeys.length) { run(opp, null); return; }

    // Alias the chosen player's hand onto the side proxy for the effect's
    // duration, then always restore — even if the effect throws.
    const bridge = (pk) => {
      const ap = tt.players[pk];
      const proxy = this.state[opp];
      if (!ap || !proxy) { run(opp, null); return; }
      const savedHand = proxy.hand, savedTricks = proxy.trickHand;
      proxy.hand = ap.hand;
      proxy.trickHand = ap.trickHand;
      const restore = () => { proxy.hand = savedHand; proxy.trickHand = savedTricks; };
      let threw = true;
      try { run(opp, pk); threw = false; }
      finally {
        // Several of these effects (Deadpool's face-down swap, The Grinch's
        // steal) chain ANOTHER prompt and do their stealing in that second
        // callback. Restoring synchronously here would un-alias the proxy
        // before the player picks, and the steal would then splice the wrong
        // hand. Hold the alias for exactly as long as the effect's prompt
        // chain is live.
        if (!threw && this.hasPendingPrompt && this.hasPendingPrompt()) this.whenPromptCleared(restore);
        else restore();
      }
    };

    // Only one living enemy seat — no point asking.
    if (enemyKeys.length === 1) { bridge(enemyKeys[0]); return; }

    if (opts && opts.autoPick) {
      const withCards = enemyKeys.filter(k => ((tt.players[k].hand || []).length > 0));
      const poolKeys = withCards.length ? withCards : enemyKeys;
      bridge(poolKeys[Math.floor(this.rng() * poolKeys.length)]);
      return;
    }

    const tiles = enemyKeys.map(k => ({
      name: tt.players[k].name || k,
      desc: `Team ${tt.players[k].team} · ${(tt.players[k].hand || []).length} cards in hand`,
      _playerKey: k,
      _isPlayerTile: true,
    }));
    this.promptCardChoice(
      owner, tiles,
      title || 'Choose an opponent',
      'Which opponent should this target?',
      (picked) => { if (picked && picked._playerKey) bridge(picked._playerKey); },
      (cards) => cards[Math.floor(this.rng() * cards.length)],
      { inlineTray: true }
    );
  },

  // True when we're currently inside a trick.play callback AND the target
  // has the Untrickable flag. Used by damage / kill / debuff / move paths
  // to short-circuit any trick effect that tries to touch an Untrickable
  // card. Card-ability paths don't set _inTrick, so cards can still
  // interact with Untrickable targets normally.
  // ===================== EFFECT-VALIDITY GATE =====================
  // "Will this even land?" — one predicate the UI and target-list builders
  // consult BEFORE offering a target, mirroring the engine's own runtime
  // shields (_trickBlocked, invincible/damage-immune, 10-cost immunity).
  // The runtime guards stay authoritative; this gate stops the player from
  // paying for a guaranteed no-op (user spec: Pym Particles must not be
  // playable onto an Untrickable Dr. Strange; Winter Soldier must not
  // offer an Invincible enemy — "the same mechanism").
  // kinds: 'trick' (any trick touching the card), 'destroy', 'damage',
  // 'debuff'. ctx: { owner, source } — owner = seat playing the effect,
  // source = the acting card for ability effects.
  canEffectLand(target, kind, ctx) {
    if (!target || target.isEnvironment) return false;
    if (target.currentHealth != null && target.currentHealth <= 0) return false;
    const owner = ctx && ctx.owner;
    const source = ctx && ctx.source;
    if (source && source.id != null && this.is10CostImmune(source, target)) return false;
    switch (kind) {
      case 'trick':
        // Mirror _trickBlocked without needing state._inTrick: 10-costs
        // are immune to ALL tricks (friendly included); Untrickable
        // blocks enemy tricks only.
        if ((target.baseCost || target.cost || 0) >= 10) return false;
        if (target.isUntrickable && owner && target.owner !== owner) return false;
        return true;
      case 'destroy':
        return !(target.invincibleTurns > 0);
      case 'damage':
      case 'debuff':
        return !(target.invincibleTurns > 0 || target.hasDamageImmunity);
      default:
        return true;
    }
  },

  // Composite for tricks that hurt: must pass the trick gate AND the
  // effect-kind gate (a Pym debuff needs a trickable AND debuffable body).
  canTrickLand(target, kind, owner) {
    if (!this.canEffectLand(target, 'trick', { owner })) return false;
    if (kind && kind !== 'trick') return this.canEffectLand(target, kind, { owner });
    return true;
  },

  // Gate-filtered target lists — card-targeting tricks build BOTH their
  // canPlay predicate and their play() prompt list through these, so the
  // tray grey-out and the offered targets can never disagree.
  trickableEnemies(owner, kind) {
    return this.getEnemiesOf(owner).filter(t => this.canTrickLand(t, kind, owner));
  },
  trickableAllies(owner, kind) {
    return this.getAlliesOf(owner).filter(t => this.canTrickLand(t, kind, owner));
  },

  _trickBlocked(target) {
    if (!this.state._inTrick || !target) return false;
    // 10-cost titans are immune to ALL tricks, including friendly ones.
    if ((target.baseCost || target.cost || 0) >= 10) { this.log(`  [UNTRICKABLE] ${target.name} is a 10-cost card and cannot be affected by tricks!`); return true; }
    // isUntrickable (keyword) only blocks ENEMY tricks — the card's own
    // team can still affect it. Anti-Life destroying your own lane card,
    // for example, should go through even if that card is Untrickable.
    if (target.isUntrickable) {
      if (this.state._trickOwner && this.state._trickOwner === target.owner) return false;
      this.log(`  [UNTRICKABLE] ${target.name} cannot be affected by enemy tricks!`);
      return true;
    }
    return false;
  },

  // General stat debuff: -atk ATK, -hp HP (ATK floors at 0, HP floors at 1).
  // Pass allowKill=true to let the HP drop to 0 and kill the card (used by
  // Magneto's aura so low-HP cards like Rocket can't survive -1/-2).
  debuffCard(card, atk, hp, allowKill, source) {
    if (!card) return;
    if (this._trickBlocked(card)) return;
    // Invincibility / Damage Immunity blocks stat-debuffs the same way
    // it blocks raw damage — stat reductions ARE damage in spirit
    // (they pre-kill the card or remove its offensive value), so an
    // Invincible card should be untouched. User spec: "Flash has
    // Invincibility, the Bear Trap -1/-1 shouldn't apply. Luke's aura
    // -1/-1 also shouldn't apply while Invincibility is active. Once
    // Invincibility wears off, debuffs apply normally."
    if (card.invincibleTurns > 0 || card.hasDamageImmunity) {
      const tag = card.invincibleTurns > 0 ? 'INVINCIBLE' : 'DMG IMMUNE';
      const srcName = source && source.name ? source.name : 'a debuff';
      this.log(`  [${tag}] ${card.name} shrugs off the ${srcName} debuff!`);
      // Credit absorbed value via the same statsDamageAbsorbed path used
      // for raw-damage blocks — a -2 ATK debuff that didn't land is
      // worth ~2 to the absorber's defensive contribution.
      const absorbedValue = (atk || 0) + (hp || 0);
      if (absorbedValue > 0) this._creditAbsorb(card, 'Invincible', absorbedValue);
      return;
    }
    // Defensive coerce — see buffCard; stops NaN from surviving a round.
    if (typeof card.attack !== 'number' || !Number.isFinite(card.attack)) card.attack = card.baseAttack || 0;
    if (typeof card.currentHealth !== 'number' || !Number.isFinite(card.currentHealth)) card.currentHealth = card.baseHealth || 1;
    if (typeof card.maxHealth !== 'number' || !Number.isFinite(card.maxHealth)) card.maxHealth = card.baseHealth || 1;
    // Reject NaN/undefined inputs silently rather than propagate.
    atk = (typeof atk === 'number' && Number.isFinite(atk)) ? atk : 0;
    hp  = (typeof hp  === 'number' && Number.isFinite(hp))  ? hp  : 0;
    // Actual ATK reduction can be capped by the target's current attack
    // (you can't reduce below 0). Credit the source with what was
    // ACTUALLY removed, so a -3 on a 1-ATK card only counts as -1.
    const atkReduced = atk ? Math.min(atk, card.attack || 0) : 0;
    if (atk) card.attack = Math.max(0, card.attack - atk);
    if (hp) {
      if (allowKill) {
        card.maxHealth = Math.max(1, card.maxHealth - hp);
        card.currentHealth -= hp;
        if (card.currentHealth <= 0) {
          this.killCard(card, source);
        }
      } else {
        card.maxHealth = Math.max(1, card.maxHealth - hp);
        card.currentHealth = Math.max(1, card.currentHealth - hp);
      }
    }
    // v3 instrumentation — credit the source for stat reductions. HP
    // already gets captured via killCard (if kill) or is implicit damage
    // in other paths; we count ATK debuff as the primary debuff value
    // since that's the hard-to-measure effect (Hawkeye splashWeaken,
    // Kryptonite -3 ATK, Magneto aura, etc.). Valued 1:1 with ATK points
    // removed — Impact-formula weight decides relative importance.
    if (source && atkReduced > 0) {
      this._creditChain(source, 'statsDebuffValue', atkReduced);
    }
  },

  dealDamage(card, amount, source) {
    if (!card || card.currentHealth <= 0) return;
    if (card.isEnvironment) return;
    if (this._trickBlocked(card)) return;
    // Invincible / Damage Immunity blocks — attribute the full amount to
    // the blocking card's `statsDamageAbsorbed` so the Stats dashboard
    // sees defensive contribution beyond just armor. Previously this
    // function exited silently and these cards looked like they did
    // nothing defensively.
    // Invincible / Immunity first (free, before any amount reduction) via the
    // shared classifier; canEvade=false so this only catches those two.
    const preAbsorb = this._classifyAbsorb(card, false);
    if (preAbsorb === 'invincible') {
      this.log(`  [INVINCIBLE] ${card.name} blocks ${amount} damage${source ? ` from ${source.name}` : ''}!`);
      this._creditAbsorb(card, 'Invincible', amount);
      return;
    }
    if (preAbsorb === 'immunity') {
      this.log(`  [DMG IMMUNE] ${card.name} ignores ${amount} damage${source ? ` from ${source.name}` : ''}!`);
      this._creditAbsorb(card, 'Invincible', amount);
      return;
    }
    if (this.is10CostImmune(source, card)) { this.log(`  [IMMUNE] ${card.name} is immune to ${source.name}'s ability!`); return; }
    // Yoda shield — allies take half damage (rounded up) while Yoda is active
    if (this.state._yodaShieldFor && this.state._yodaShieldFor[card.owner] > 0) {
      amount = Math.ceil(amount / 2);
      if (amount <= 0) return;
    }
    // Evade last (after Invincible/Immunity already returned above) — same
    // shared classifier, evade-eligible only when not stunned/frozen.
    if (this._classifyAbsorb(card, !card.isStunned && !card.isFrozen) === 'evade') {
      card.evadeCharges--;
      this.log(`  [EVADE] ${card.name} dodges ${amount} damage! (${card.evadeCharges} charges left)`);
      this._creditAbsorb(card, 'Evade', amount);
      if (card.onEvade) card.onEvade(this, card);
      return;
    }
    // Taunt intercept — taunter ate the hit, so the prevention here is
    // "amount that would have hit the original target." We credit the
    // taunter via _creditAbsorb('Redirect', ...) so the dashboard can
    // distinguish redirect from direct armor blocks.
    // Only ENEMY-originated damage gets redirected to a friendly taunter.
    // Self-inflicted burn (dealDamage(self, 1, null)), friendly abilities,
    // and friendly tricks must bypass taunt so they can still affect/kill
    // your own cards — otherwise a permanent taunter (e.g. Obi-Wan) makes
    // burning cards literally unkillable and Boiler Room's onDeath never fires.
    const _dmgFromEnemy = source
      ? (source.owner !== card.owner)
      : (this.state._trickOwner != null && this.state._trickOwner !== card.owner);
    const taunter = _dmgFromEnemy
      ? this.getAllCardsOf(card.owner).find(c => c.tauntTurns > 0 && c.currentHealth > 0 && c.id !== card.id)
      : null;
    if (taunter) {
      this.log(`  [TAUNT] ${taunter.name} intercepts damage meant for ${card.name}!`);
      card = taunter;
      if (card.invincibleTurns > 0) {
        this._creditAbsorb(card, 'Redirect', amount);
        this._creditAbsorb(card, 'Invincible', amount);  // bonus — taunter ALSO blocked it
        return;
      }
      if (card.hasDamageImmunity) {
        this._creditAbsorb(card, 'Redirect', amount);
        this._creditAbsorb(card, 'Invincible', amount);
        return;
      }
      // Plain redirect — taunter takes the hit on its own HP. Credit
      // 'Redirect' for the SHIFTED damage; if armor reduces it further
      // below, that armor portion gets its own credit too.
      this._creditAbsorb(card, 'Redirect', amount);
    }
    if (card.armorValue > 0 && amount <= card.armorValue) {
      this.log(`  [ARMOR] ${card.name}'s Armor ${card.armorValue} absorbs all ${amount} damage${source ? ` from ${source.name}` : ''}!`);
      this.emitDmg(card.id, 0, 'armor');
      this._creditAbsorb(card, 'Armor', amount);
      return;
    }
    const actual = card.armorValue > 0 ? amount - card.armorValue : amount;
    if (card.armorValue > 0 && actual > 0) {
      this.log(`  [ARMOR] ${card.name}'s Armor ${card.armorValue} reduces ${amount} → ${actual}${source ? ` from ${source.name}` : ''}`);
      this._creditAbsorb(card, 'Armor', card.armorValue);
    }
    card.currentHealth -= actual;
    if (actual > 0) card.statsHpTaken = (card.statsHpTaken || 0) + actual;
    // Track landed damage for the currencyOnDamage passive (e.g. Green Lantern)
    if (source && source.passive === 'currencyOnDamage' && actual > 0) {
      source._damageDealtThisTurn = (source._damageDealtThisTurn || 0) + actual;
    }
    // Per-card stats — attribute ability damage (tricks, splash, chain, etc.)
    // to the source card + walk up its summon chain.
    if (actual > 0 && source && source.id != null && source.owner !== card.owner) {
      this._creditChain(source, 'statsEnemyDamage', actual);
    }
    // Lifesteal etch — when source is a card with the etch and it
    // dealt actual dmg, heal source's owner. Mirrors combat-damage
    // path so splash / on-hit triggers also drain.
    if (actual > 0 && source && source.id != null && source.owner !== card.owner) {
      this._resolveLifesteal(source, actual);
    }
    if (card.onDamaged) card.onDamaged(this, card, source, actual);
    if (card.currentHealth <= 0) {
      // Credit the source with this kill — ability/splash/trick damage
      // that finishes off a card should count toward `statsKills` just
      // like combat damage does (applyCombatDamage crediting is adjacent).
      if (source && source.id != null && source.owner !== card.owner) {
        this._creditChain(source, 'statsKills', 1);
      }
      // Thorns even on the killing blow — target's bramble can chip
      // the source post-mortem. Skipped for non-card sources (tricks).
      if (source && source.id != null && source.owner !== card.owner) {
        this._resolveThorns(card, source);
      }
      const l = this.findCardLane(card);
      if (l >= 0) this.handleDeath(card, l, source || null);
    } else if (actual > 0 && source && source.id != null && source.owner !== card.owner) {
      // Thorns chip on surviving hit — same gating as combat path.
      this._resolveThorns(card, source);
    }
  },

  // Destroy a lane temporarily. Duration (default 3 rounds) ticks down in
  // drawPhase's per-round cleanup; when it reaches 0 the lane reforms and
  // both sides can place cards there again. Any cards currently IN the
  // lane should be killed separately by the caller before this fires —
  // this helper only manages the lane state, not its occupants.
  destroyLane(laneIdx, duration = 3) {
    const lane = this.state.lanes[laneIdx];
    if (!lane) return;
    // Invincible cards block lane destruction — if any living card in
    // the lane is invincible (killCard already returned early for it),
    // the collapse is cancelled entirely.
    const cards = ['player', 'ai'].map(s => lane[s]).filter(c => c && c.currentHealth > 0);
    const invCard = cards.find(c => c.invincibleTurns > 0);
    if (invCard) {
      this.log(`  [INVINCIBLE] ${invCard.name} blocks lane ${laneIdx + 1} from collapsing!`);
      return;
    }
    lane.destroyed = true;
    lane.destroyedTurns = duration;
    // Any environment in this lane is also destroyed by the collapse —
    // clear its effects via handleDeath, then null the slot.
    if (lane._env) {
      ['player', 'ai'].forEach(side => {
        const env = lane._env[side];
        if (env) {
          env.currentHealth = 0;
          this.handleDeath(env, laneIdx, null);
          lane._env[side] = null;
        }
      });
    }
  },

  // Throw any still-living card clear of a collapsed (void) lane.
  //
  // Callers collapse a lane and THEN kill its occupants. One-shot death saves
  // (Yoda's shield, Phoenix etch, revives) can leave a card alive inside the
  // void — and a void has no lane for 3 rounds, so that card is stranded:
  // untargetable yet still swinging in combat. The engine's cleanup invariant
  // reports it as the "limbo class". Anti-Life Equation already did this
  // rescue inline; Darkseid did not, which is where most of the stranded
  // cards came from. Shared here so every collapse path behaves the same.
  // MUST be called AFTER the caller's kills — evicting earlier would let
  // cards escape the collapse entirely.
  evictVoidSurvivors(laneIdx) {
    const lane = this.state.lanes[laneIdx];
    if (!lane || !lane.destroyed) return;
    ['player', 'ai'].forEach(side => {
      const c = lane[side];
      if (!c || !(c.currentHealth > 0)) return;
      const open = this.getOpenLanes(side);
      if (open.length) {
        lane[side] = null;
        this.placeInLane(side, c, open[0]);
        this.log(`  [VOID] ${c.name} is thrown clear of the collapsing lane into lane ${open[0] + 1}!`);
      } else {
        // Nowhere to go — a void has no lane for its remaining rounds, so a
        // survivor with no open lane is CLAIMED by the void (it cannot keep
        // standing in a lane that does not exist). Removing it upholds the
        // no-card-in-a-destroyed-lane invariant. Rare (needs a full board +
        // a collapse / a pull-in). Silent removal — the collapse already
        // narrated the lane's destruction.
        lane[side] = null;
        this.log(`  [VOID] ${c.name} is claimed by the void — no lane to be thrown to.`);
      }
    });
  },

  // Sweep EVERY destroyed lane for living occupants and evict them. Centralized
  // enforcement of the no-card-in-a-void invariant: any path that leaves a
  // living card in a collapsed lane (a survivor of the kill, a pull-in, a move
  // race) is caught here at the cleanupDead choke point, not just at the
  // collapse site. Runs after the death sweep, so to-be-killed cards (health
  // <= 0, awaiting the queued death) are correctly skipped.
  _evictAllVoidSurvivors() {
    for (let i = 0; i < this.LANE_COUNT; i++) {
      const lane = this.state.lanes[i];
      if (lane && lane.destroyed) this.evictVoidSurvivors(i);
    }
  },

  // ===================== IRON GIANT DEATH-GUARD =====================
  // Cheap, side-effect-free lookahead used by the UI's handleDeath wrapper
  // to suppress the death sound + derez visual for a card that's about to
  // be saved (or offered a save) by Iron Giant. Mirrors the ENTRY gate of
  // _ironGiantIntercept but must NOT consume the _igOffered decline flag —
  // when a decline is in progress this returns false so the real death
  // gets its normal cue. Without this, a SAVED ally still derezzes and
  // plays a death sound, and that death cue grabs the combat lane-audio
  // slot and steps on the sacrifice sting fired a moment later.
  _willIronGiantIntercept(card) {
    try {
      if (!card || card.isEnvironment || !card.owner) return false;
      if (this.state.gameOver) return false;
      if (card._igOffered) return false; // decline re-entry — real death proceeds
      const hand = (this.state[card.owner] && this.state[card.owner].hand) || [];
      return hand.some(c => c.name === 'Iron Giant');
    } catch (e) { return false; }
  },

  // "While in Hand: when an ally would die, you may sacrifice Iron Giant
  // to save it." Called from handleDeath after the Phoenix check.
  // Returns true if the death is deferred (human prompt pending) or
  // cancelled (save applied); false lets handleDeath proceed normally.
  _ironGiantIntercept(card, laneIdx, killer) {
    try {
      if (!card || card.isEnvironment || !card.owner) return false;
      if (this.state.gameOver) return false;
      // Consume-on-read decline guard: doDecline re-enters handleDeath
      // with this flag set so the offer isn't repeated for the same
      // death. Deleting it immediately means a card that later survives
      // by other means (onDeath revive, reviveCharges) gets a fresh
      // offer on its NEXT death.
      if (card._igOffered) { delete card._igOffered; return false; }
      const owner = card.owner;
      const hand = (this.state[owner] && this.state[owner].hand) || [];
      const ig = hand.find(c => c.name === 'Iron Giant');
      if (!ig) return false;
      // Capture the restore HP now (consume-on-read so a stale snapshot
      // from an earlier survived kill can never leak into a later save):
      // direct destroys keep their pre-zeroing HP, damage deaths clamp to 1.
      const hpSnapshot = (card._hpBeforeKill != null) ? card._hpBeforeKill : card.currentHealth;
      delete card._hpBeforeKill;
      const restoreHp = Math.max(1, hpSnapshot);
      const doSave = () => {
        // Consume the Giant from hand → DISCARD pile, not the dead pile:
        // he can never stand on the field, so revival pools (Lazarus Pit,
        // Hela) must never see him — and this is a SACRIFICE, so nothing
        // that reacts to discards fires either.
        const idx = this.state[owner].hand.indexOf(ig);
        if (idx > -1) this.state[owner].hand.splice(idx, 1);
        this.state[owner].discardPile.push(ig);
        card.currentHealth = restoreHp;
        card._deathHandled = false;
        // Shield the rescued ally for the remainder of THIS combat round (see
        // _classifyAbsorb). "It survives" has to mean it survives the fight
        // that killed it — otherwise the still-pending swings from this same
        // round immediately re-kill it and the sacrifice buys nothing.
        card._igSavedThisCombat = true;
        this.log(`[IRON GIANT] Iron Giant gives himself — ${card.name} survives at ${restoreHp} HP!`);
        if (typeof UI !== 'undefined' && UI.sfx && UI.sfx.playCardSfx) {
          try { UI.sfx.playCardSfx('Iron Giant', 'ability'); } catch (e) {}
        }
        this._ironGiantBlast(owner, ig);
      };
      const doDecline = () => {
        card._igOffered = true;
        card._deathHandled = false;
        const lane = this.findCardLane(card);
        this.handleDeath(card, lane >= 0 ? lane : laneIdx, killer);
      };
      if (!this.isHuman(owner)) {
        // AI heuristic: spend the Giant on a valuable ally, or whenever
        // the board-wide 1-damage blast has a rich enemy line to sweep.
        const enemies = this.getEnemiesOf(owner).filter(e => e.currentHealth > 0 && !e.isEnvironment);
        const worth = ((card.baseCost || card.cost || 0) >= 4) || enemies.length >= 3;
        if (!worth) return false; // death proceeds inline
        doSave();
        return true;
      }
      this.promptCardChoice(owner, [
        { name: 'Sacrifice Iron Giant', desc: `Iron Giant gives himself — ${card.name} survives at ${restoreHp} HP, and all enemies take 1 damage.`, id: 'ig_save' },
        { name: `Let ${card.name} Die`, desc: 'Keep Iron Giant in your hand.', id: 'ig_decline' },
      ], 'Iron Giant — Sacrifice?',
        `${card.name} is about to be destroyed. Sacrifice Iron Giant from your hand to save it?`,
        (pick) => {
          if (pick && pick.id === 'ig_save') doSave();
          else doDecline();
        });
      return true;
    } catch (e) { console.error('[IRON GIANT] intercept error:', e); return false; }
  },

  // "When Sacrificed: deal 1 damage to ALL enemy cards on the field."
  // Board-wide, no targeting prompt — the blast washes over every enemy.
  _ironGiantBlast(owner, ig) {
    const enemies = this.getEnemiesOf(owner).filter(e => e.currentHealth > 0 && !e.isEnvironment);
    if (!enemies.length) {
      this.log(`  [IRON GIANT] No enemies on the field — the blast fades into the night sky.`);
      return;
    }
    this.log(`  [IRON GIANT] The blast washes over the enemy line — 1 damage to all!`);
    enemies.forEach(t => this.dealDamage(t, 1, ig));
    this.cleanupDead();
  },

  killCard(card, source) {
    if (!card) return;
    if (card.isEnvironment) return;
    if (this._trickBlocked(card)) return;
    if (this.is10CostImmune(source, card)) { this.log(`  [IMMUNE] ${card.name} is immune to ${source.name}'s destruction!`); return; }
    if (card.invincibleTurns > 0) {
      // Invincible is a ROUND-scoped shield (Invincible 3 = 3 full rounds),
      // ticked once per round in the end-of-turn cleanup at the top of this
      // file. Do NOT decrement here — otherwise a destruction attempt like
      // Deathstroke's assassinate against a card with Invincible 1 would
      // both block the kill AND burn the round's worth of shield, leaving
      // the card unprotected against the next trick in the same round.
      this.log(`[INVINCIBLE] ${card.name} survives destruction! (${card.invincibleTurns} turn${card.invincibleTurns === 1 ? '' : 's'} remaining)`);
      return;
    }
    const l = this.findCardLane(card);
    if (l >= 0) {
      // Attribute the victim's remaining HP to the killer (+ chain) as
      // "damage dealt to enemies" — e.g. Thanos snap on 20-HP Dormammu
      // counts as 20 damage toward Thanos's MVP. Also credit the kill
      // counter (statsKills) the same way applyCombatDamage / dealDamage
      // do when they finish off a target — otherwise direct-destroy
      // effects (Thanos, Dr. Doom, Darkhold) would show 0 kills.
      if (source && source.id != null && card.owner !== source.owner && card.currentHealth > 0) {
        this._creditChain(source, 'statsEnemyDamage', card.currentHealth);
        this._creditChain(source, 'statsKills', 1);
      }
      // Stash pre-destroy HP for Iron Giant's death-guard: "the ally
      // survives with whatever HP it had remaining". Damage deaths arrive
      // here at ≤0 HP (min-1 clamp applies); direct destroys would lose
      // the real remaining HP to the zeroing below without this snapshot.
      // Consumed (and deleted) by _ironGiantIntercept.
      card._hpBeforeKill = card.currentHealth;
      card.currentHealth = 0;
      this.handleDeath(card, l, source || null);
    }
  },

  killCardSilent(card) { const l = this.findCardLane(card); if (l >= 0) this.removeFromLane(card, l); },

  // True when a revive/resurrection cannot fire because the death lane is
  // destroyed — no card can occupy a destroyed lane, so there is nowhere
  // to rise (user: "the revive wouldn't happen for Wolverine — no card can
  // be in a destroyed lane"). Shared by the generic Revive-N path and every
  // CUSTOM revive (Wolverine / Jason / Grundy Text+ / Mahoraga / Doomsday),
  // which previously bypassed the generic gate entirely — Wolverine's
  // "revives as 6/5" fired in a voided lane and left him in limbo.
  reviveVoided(card, laneIdx) {
    const l = (typeof laneIdx === 'number' && laneIdx >= 0) ? laneIdx : this.findCardLane(card);
    if (l >= 0 && this.state.lanes[l] && this.state.lanes[l].destroyed) {
      this.log(`  [VOID] ${card.name} cannot revive — the lane is destroyed. The void claims them.`);
      return true;
    }
    return false;
  },

  // Player-driven chain effect.
  // Player picks a starting enemy (any enemy on board); then repeatedly picks a direction
  // (left/right/stop) — chain continues only into consecutive occupied enemy lanes.
  // AI uses getChainedEnemies (starting from source lane) for equivalent behavior.
  runPlayerChain(source, applyFn, title, verb, maxTargets) {
    const owner = source.owner;
    const opp = this.opponent(owner);
    const enemies = this.getEnemiesOf(owner).filter(e => e.currentHealth > 0);
    if (!enemies.length) { this.log(`${source.name}: no enemies to chain.`); return; }

    // AI (single-player) ONLY: auto-spread from the source lane. In
    // multiplayer the guest sits on the 'ai' seat but is a HUMAN — gate on
    // isHuman, not the literal seat, so the guest gets the same interactive
    // start-lane + direction picks the host does (the prompts route to the
    // guest via promptCardChoice's MP handling). User directive: treat the
    // joining player as human at all times, never as AI.
    if (!this.isHuman(owner)) {
      let targets = this.getChainedEnemies(source);
      if (maxTargets) targets = targets.slice(0, maxTargets);
      targets.forEach(t => { try { applyFn(t); } catch (e) { console.error(e); } });
      this.log(`${source.name} chains ${verb} to ${targets.length} enemies!`);
      return;
    }

    const hit = new Set();
    const applyAndLog = (t) => {
      if (!t || hit.has(t.id)) return false;
      hit.add(t.id);
      try { applyFn(t); } catch (e) { console.error(e); }
      return true;
    };
    // Step 2+: prompt for direction once a starting lane is set. Direction
    // locks after the first step — chain is one-way (pick left or right,
    // stick with it until a gap or the chain ends). Previously either
    // direction was offered at every step, which let the chain bounce
    // back and cover both sides of the source lane.
    const chainFrom = (startLane) => {
      let current = startLane;
      let lockedDir = null; // null until first directional step, then 'left' | 'right'
      const extendLeft = () => {
        let idx = current;
        while (idx - 1 >= 0) {
          const e = this.state.lanes[idx - 1][opp];
          if (!e || e.currentHealth <= 0) return null;
          idx--;
          if (!hit.has(e.id)) return { idx, card: e };
        }
        return null;
      };
      const extendRight = () => {
        let idx = current;
        while (idx + 1 < this.LANE_COUNT) {
          const e = this.state.lanes[idx + 1][opp];
          if (!e || e.currentHealth <= 0) return null;
          idx++;
          if (!hit.has(e.id)) return { idx, card: e };
        }
        return null;
      };
      const askNext = () => {
        if (maxTargets && hit.size >= maxTargets) return; // cap reached
        const left  = (lockedDir === 'right') ? null : extendLeft();
        const right = (lockedDir === 'left')  ? null : extendRight();
        const options = [];
        if (left)  options.push({ name: `← ${left.card.name} (lane ${left.idx + 1})`,  desc: `Chain ${verb} to ${left.card.name}`,  _dir: 'left',  _target: left });
        if (right) options.push({ name: `${right.card.name} (lane ${right.idx + 1}) →`, desc: `Chain ${verb} to ${right.card.name}`, _dir: 'right', _target: right });
        options.push({ name: `Stop Chain`, desc: `End the ${verb} chain here`, _dir: 'stop' });
        if (options.length === 1) return; // only 'stop' available
        this.promptCardChoice(owner, options, `${title} — Direction`,
          `Chain continues from lane ${current + 1}. Pick next target or stop.`,
          (pick) => {
            if (pick._dir === 'stop' || !pick._target) return;
            if (!lockedDir) lockedDir = pick._dir;
            applyAndLog(pick._target.card);
            current = pick._target.idx;
            askNext();
          }, cards => cards[0]);
      };
      askNext();
    };

    // Step 1: prompt for starting enemy
    this.promptCardChoice(owner, enemies, title,
      `Choose a starting enemy — chain ${verb} spreads from there.`,
      (start) => {
        const startLane = this.findCardLane(start);
        if (startLane < 0) return;
        applyAndLog(start);
        chainFrom(startLane);
      }, cards => cards[0]);
  },

  // Get enemies reachable by chaining through consecutive occupied lanes
  // from a source card's lane. One-directional: includes the front-lane
  // enemy plus the longer unbroken sequence on one side. Previously this
  // spread both left AND right from the source, which felt like splash
  // (all adjacent enemies hit) rather than a chain (one-way propagation).
  // Ties go to whichever direction has an enemy closer to the source.
  getChainedEnemies(source) {
    const lane = this.findCardLane(source);
    if (lane < 0) return [];
    const opp = this.opponent(source.owner);
    const collect = (step) => {
      const arr = [];
      for (let i = lane + step; i >= 0 && i < this.LANE_COUNT; i += step) {
        const e = this.state.lanes[i][opp];
        if (e && e.currentHealth > 0) arr.push(e);
        else break;
      }
      return arr;
    };
    const leftChain  = collect(-1);
    const rightChain = collect(+1);
    const chosen = rightChain.length > leftChain.length ? rightChain
                 : leftChain.length  > rightChain.length ? leftChain
                 : rightChain; // tie-break: right (arbitrary but deterministic)
    const result = [];
    const front = this.state.lanes[lane][opp];
    if (front && front.currentHealth > 0) result.push(front);
    result.push(...chosen);
    return result;
  },

  devourCard(card, source) {
    if (!card) return;
    if (this._trickBlocked(card)) return;
    if (this.is10CostImmune(source, card)) { this.log(`  [IMMUNE] ${card.name} is immune to ${source.name}'s devour!`); return; }
    // INVINCIBLE blocks Devour; DAMAGE IMMUNITY does not.
    //
    // Invincible is an anti-DESTRUCTION shield — it's what killCard() honors —
    // and devour is destruction-class (the card hits the void pile and can
    // never come back), so it has to refuse the consumption entirely. That was
    // the 2026-05-19 report: "Galactus devour eats through invincible. That
    // shouldn't be the case."
    //
    // Damage Immunity is a different promise: "takes no DAMAGE" (granted as a
    // 1-turn buff to adjacent allies). Devour deals no damage — it consumes —
    // so the shield was never the right thing to stop it. That fix blocked
    // both flags together and over-applied to this one. User: "galactus should
    // be able to devour through damage immunity, right now he cant."
    if (card.invincibleTurns > 0) {
      this.log(`  [INVINCIBLE] ${card.name} resists ${source ? source.name : 'devour'}!`);
      this._creditAbsorb(card, 'Invincible', (card.maxHealth || 0) + (card.attack || 0));
      return;
    }
    const l = this.findCardLane(card);
    if (l >= 0) {
      // Credit the devourer's side with a kill. Devour skips handleDeath
      // entirely (void pile, not dead pile), so without this hook
      // Galactus's devours wouldn't count toward cardsKilled or the
      // devourer's MVP statsKills.
      const side = (source && source.owner && source.owner !== card.owner)
        ? source.owner
        : this.opponent(card.owner);
      if (this.state._stats && this.state._stats[side]) {
        this.state._stats[side].cardsKilled++;
      }
      if (source && source.owner && source.owner !== card.owner) {
        this._creditChain(source, 'statsKills', 1);
        // Victim's current HP also credits to source as "damage dealt to
        // enemies" so Galactus's devour shows up in his MVP damage total.
        if (card.currentHealth > 0) this._creditChain(source, 'statsEnemyDamage', card.currentHealth);
        // Kill value — same treatment handleDeath gives combat/destroy kills.
        const killValue = (card.attack || 0) + (card.maxHealth || 0) + (card.baseCost || card.cost || 0);
        this._creditChain(source, 'statsKillValue', killValue);
      }
      this.removeFromLane(card, l);
      this.state.voidPile.push({ name: card.name, cost: card.cost });
      this.log(`  [DEVOUR] ${card.name} is devoured to the void!`);
    }
  },

  // Central debuff immunity/unresistible handler.
  // Returns true if debuff landed, false if blocked by Immunity.
  tryApplyDebuff(source, target, debuffName, applyFn) {
    if (!target) return false;
    if (this._trickBlocked(target)) return false;
    if (this.is10CostImmune(source, target)) { this.log(`  [IMMUNE] ${target.name} is immune to ${source.name}'s ${debuffName}!`); return false; }
    if (target._doomsdayRevived && (debuffName === 'Stun' || debuffName === 'Freeze')) {
      this.log(`  [DOOMSDAY] ${target.name} is permanently immune to ${debuffName}!`);
      return false;
    }
    // Wrap applyFn so every landed debuff also stamps the late-round
    // persistence flag when:
    //   (a) combat has already wrapped up this round (`_combatFinishedThisRound`),
    //       e.g. a trick fired after postCombat via some future hook
    //   (b) the SPECIFIC TARGET has already done its combat swing this
    //       round (`_combatSwungThisRound`), e.g. Mind Stone played as
    //       a block trick mid-combat, hitting a card that already
    //       attacked on an earlier lane
    // In either case, the debuff should carry into next round's combat
    // instead of being wiped by this round's postCombat clear (which
    // would make the debuff useless since the target already acted).
    const landed = () => {
      applyFn();
      if (this.state && this.state._combatFinishedThisRound) {
        target._debuffDelayedClear = true;
      } else if (target && target._combatSwungThisRound) {
        target._debuffDelayedClear = true;
      }
    };
    if (target.immunityCharges > 0) {
      if (source && source.unresistibleCharges > 0) {
        // Unresistible bypasses Immunity — ONLY Unresistible is spent.
        // Immunity is NOT consumed here because it never actually blocked
        // anything (the debuff sailed past). Previously Immunity was also
        // decremented, which deleted the card's protection without it ever
        // doing its job — e.g. Palpatine (Unresistible 1) freezing Gorr
        // (Immunity 1) wiped Gorr's Immunity while Palpatine's Unresistible
        // was also consumed, leaving Gorr with no defense for later debuffs
        // in the same turn.
        source.unresistibleCharges--;
        landed();
        this.log(`  [UNRESISTIBLE] ${source.name} bypasses ${target.name}'s Immunity! ${debuffName} lands! (Immunity ${target.immunityCharges} untouched, Unresistible ${source.unresistibleCharges} remaining)`);
        return true;
      }
      target.immunityCharges--;
      this.log(`  [IMMUNITY] ${target.name}'s Immunity blocks ${debuffName}! (${target.immunityCharges} remaining)`);
      return false;
    }
    // No immunity — debuff lands normally, Unresistible NOT consumed
    landed();
    return true;
  },

  freezeCardUnresistible(card, source, n) {
    if (!card) return;
    if (this._trickBlocked(card)) return;
    const turns = Math.max(1, n || 1);
    if (this.is10CostImmune(source, card)) { this.log(`  [IMMUNE] ${card.name} is immune to ${source.name ? source.name + "'s " : ''}freeze!`); return; }
    if (card._doomsdayRevived) { this.log(`  [DOOMSDAY] ${card.name} is permanently immune to Freeze!`); return; }
    if (card.immunityCharges > 0) {
      // If the source has Unresistible, it bypasses Immunity — only
      // Unresistible is spent; Immunity is NOT consumed because it never
      // actually blocked anything (same rule as tryApplyDebuff above).
      // If the source does NOT have Unresistible, the forced-freeze
      // forcibly burns the Immunity charge to protect the card.
      if (source && source.unresistibleCharges > 0) {
        source.unresistibleCharges--;
        this.log(`  [UNRESISTIBLE] ${source.name} bypasses ${card.name}'s Immunity! (Immunity ${card.immunityCharges} untouched, Unresistible ${source.unresistibleCharges} remaining)`);
      } else {
        // No Unresistible to pierce → Immunity BLOCKS the freeze. Consume the
        // charge and STOP — the freeze does NOT land. (Was a bug: this path
        // consumed Immunity but then froze the card anyway, so a source that
        // ran out of Unresistible could still lock down every immune target —
        // e.g. Palpatine (Unresistible 1) freezing two immune enemies back to
        // back. Now matches tryApplyDebuff: block == no effect.)
        card.immunityCharges--;
        this.log(`  [IMMUNITY] ${card.name}'s Immunity blocks the freeze! (${card.immunityCharges} remaining)`);
        return;
      }
    }
    // Stack-aware: increment counter + sync flag. Default 1 turn;
    // callers (e.g. Superman Text+) may pass `n` for multi-turn freezes.
    card.frozenTurns = (card.frozenTurns || 0) + turns;
    card.isFrozen = true;
    this.log(`  [FREEZE] ${card.name} is frozen (${card.frozenTurns})!`);
    this._simulatePhantomSwing(source, card);
  },

  // Phantom-swing simulation — when `source` locks down `frozen` (stun,
  // freeze, fear), credit `source` with the GROSS attack value of the
  // locked-down enemy as "damage denied." User spec (sabermetrics MVP
  // refactor): "freeze/stun: damageDenied += target.attack × turnsLocked."
  // Linear with the attacker's ATK, not with downstream board state —
  // freezing an 8-ATK threat is worth 8 regardless of whether the target
  // it would have hit had armor / HP / a tank in front. The user's
  // intuition: "stunning a 7-attack Wonder Woman is clearly defensive
  // value, not 0 — which is what the old net-prevention math credited
  // when the swing target had enough HP to soak the hit."
  // Splash from the frozen card is added on top: a frozen splasher
  // would have hit multiple lanes too, so the lockdown denies that
  // splash damage as well (one tick per adjacent lane on the same side
  // as the frozen enemy's targets).
  // Returns total damage prevented (for logging / testing).
  _simulatePhantomSwing(source, frozen) {
    if (!source || !frozen || source.owner === frozen.owner) return 0;
    const atk = frozen.attack || 0;
    if (atk <= 0) return 0;
    const lane = this.findCardLane(frozen);
    if (lane < 0) return 0;
    const opp = this.opponent(frozen.owner);

    // Gross lockdown value — frozen.attack credited 1:1 (1 turn of lock).
    // For multi-turn locks (Fear N, future stun durations), this can be
    // multiplied by the duration, but currently every freeze/stun/fear
    // is 1-round so that's just `× 1`.
    let absorbed = atk;
    // Splash credit — if the frozen card has Splash N, freezing it also
    // denied that N damage on each adjacent lane it would have splashed
    // into. We don't model evade/armor on the splash targets here since
    // the user's spec is gross prevention; the lockdown itself is what's
    // being measured, not the downstream defenses.
    const splash = frozen.splashRange || 0;
    if (splash > 0) {
      // Front (same lane) splash + each adjacent lane that has an enemy
      // card to splash onto. Up to 3 splash hits total.
      let splashTargets = 0;
      if (this.state.lanes[lane][opp]) splashTargets++;
      if (lane > 0 && this.state.lanes[lane - 1][opp]) splashTargets++;
      if (lane < this.LANE_COUNT - 1 && this.state.lanes[lane + 1][opp]) splashTargets++;
      absorbed += splash * splashTargets;
    }

    // Legacy-removed: the old post-defense + HP-cap math is retained as
    // dead code below for reference. Net-prevention undercounted "true"
    // defensive value of a freeze when the swing target had high HP.
    // If you ever need a "what would have ACTUALLY landed" stat
    // (post-Armor / Evade / Invincible), fork this function rather
    // than replacing the gross credit above. The gross figure is
    // intentional — it represents how much pressure the lockdown
    // actually relieved, regardless of downstream defensive blocks.

    if (absorbed > 0) this._creditAbsorb(source, 'Lockdown', absorbed);
    return absorbed;
  },

  // ===================== DEBUFF STACKING =====================
  // Stun / Freeze / Fear use COUNTER + BOOLEAN dual representation:
  //   - <effect>Turns (counter): how many rounds the effect persists.
  //     Applying the same effect again INCREMENTS this counter — so
  //     two Freeze 1's stack into Frozen 2 (two rounds locked, not
  //     one). Per user spec: "if you freeze an enemy twice, it
  //     should just have the status of frozen 2."
  //   - is<Effect> (boolean): cached `counter > 0` for the 30+
  //     existing call sites that read the boolean. Always kept in
  //     sync with the counter (the counter is the source of truth;
  //     the boolean is a derived view). Backward-compatible — no
  //     callsite changes needed.
  // Round tick (in cleanupDead → startRound) DECREMENTS the counter
  // and re-syncs the boolean, so a Frozen 2 card unfreezes to 1 the
  // next round, then to 0 the round after.
  // Cards stack via tryApplyDebuff so Immunity / Unresistible still
  // gate properly — applying an extra Freeze through Immunity still
  // costs the Immunity charge, doesn't increment the counter.
  stunCard(card, source, n) {
    if (!card) return;
    const turns = Math.max(1, n || 1);
    this.tryApplyDebuff(source, card, 'Stun', () => {
      card.stunnedTurns = (card.stunnedTurns || 0) + turns;
      card.isStunned = true;
      const total = card.stunnedTurns;
      this.log(`  [STUN] ${card.name} is stunned (${total})!`);
      this._simulatePhantomSwing(source, card);
      this._creditChain(source, 'statsStunsApplied', turns);
      if (typeof UI !== 'undefined' && UI.sfx && UI.sfx.play) {
        try { UI.sfx.play('statusStun'); } catch (e) {}
      }
    });
  },
  freezeCard(card, source, n) {
    if (!card) return;
    const turns = Math.max(1, n || 1);
    this.tryApplyDebuff(source, card, 'Freeze', () => {
      card.frozenTurns = (card.frozenTurns || 0) + turns;
      card.isFrozen = true;
      const total = card.frozenTurns;
      this.log(`  [FREEZE] ${card.name} is frozen (${total})!`);
      this._simulatePhantomSwing(source, card);
      this._creditChain(source, 'statsFreezesApplied', turns);
      if (typeof UI !== 'undefined' && UI.sfx && UI.sfx.play) {
        try { UI.sfx.play('statusFreeze'); } catch (e) {}
      }
    });
  },
  fearCard(card, source, n) {
    if (!card) return;
    const turns = Math.max(1, n || 1);
    this.tryApplyDebuff(source, card, 'Fear', () => {
      card.fearedTurns = (card.fearedTurns || 0) + turns;
      card.isFeared = true;
      // Fear vs Crazy — two flavors (user: "when Joker fears a card, that
      // card cannot have a Crazy debuff on it"):
      //   • JOKER-STAMPED Crazy (_crazyAppliedBy) is STRIPPED entirely —
      //     badge gone, ATK restored to the pre-Crazy snapshot. The next
      //     start-of-tricks re-check stamps a different enemy instead.
      //   • INTRINSIC Crazy (Harley's identity) is only suppressed: ATK
      //     reverts to base while feared, the flag persists, and the
      //     next rerollCrazyInsane sweep resumes it once fear ends.
      // Insane (Joker's own) is untouched — it rolls through fear.
      if (card.isCrazy) {
        if (card._crazyAppliedBy) {
          card.isCrazy = false;
          delete card._crazyAppliedBy;
          const restoreTo = (card._preCrazyAttack != null) ? card._preCrazyAttack : (card.baseAttack || 0);
          if (typeof restoreTo === 'number') card.attack = restoreTo;
          delete card._preCrazyAttack;
          card._lastCrazyRoll = null;
          this.log(`  [CRAZY] Fear shatters the Crazy stamp on ${card.name}.`);
        } else {
          card.attack = card.baseAttack || 0;
          card._lastCrazyRoll = null;
        }
      }
      const total = card.fearedTurns;
      this.log(`  [FEAR] ${card.name} is feared (${total})!`);
      this._simulatePhantomSwing(source, card);
      this._creditChain(source, 'statsFearsApplied', turns);
      if (typeof UI !== 'undefined' && UI.sfx && UI.sfx.play) {
        try { UI.sfx.play('statusFear'); } catch (e) {}
      }
    });
  },

  // Mind-control helper — cleanly funnels every MC application through
  // the same credit-the-source-with-prevented-damage pipeline that
  // freeze / stun / fear use. Callsites (Gorilla Grodd, Luke Skywalker,
  // Mind Stone, etc.) should call this AFTER any custom target-selection
  // step; it tryApplyDebuff-guards for Immunity automatically. `onApply`
  // runs after the flag flips, so Grodd can still set mindControlTarget
  // or any other per-source side effects.
  mindControlCard(card, source, onApply) {
    if (!card) return false;
    return this.tryApplyDebuff(source, card, 'Mind Control', () => {
      card.isMindControlled = true;
      // Phantom swing — credit the source with the damage the target
      // would have dealt this round. MC is strictly better than freeze
      // (the card ALSO hits the controller's enemies), but that bonus
      // lives in the weighted-impact formula at display time, not here.
      this._simulatePhantomSwing(source, card);
      this._creditChain(source, 'statsMcApplied', 1);
      if (typeof UI !== 'undefined' && UI.sfx && UI.sfx.play) {
        try { UI.sfx.play('statusMindCtrl'); } catch (e) {}
      }
      if (typeof onApply === 'function') onApply();
    });
  },

  drainCard(source, target) {
    if (!source || !target) return;
    this.tryApplyDebuff(source, target, 'Drain', () => {
      const stolenAtk = target.attack;
      const stolenHp = Math.max(0, target.currentHealth - 1);
      source.attack += stolenAtk; source.currentHealth += stolenHp; source.maxHealth += stolenHp;
      target.attack = 0; target.currentHealth = 1; target.maxHealth = 1;
      this.log(`  [DRAIN] ${source.name} drains ${target.name} for +${stolenAtk}/+${stolenHp} → ${target.name} left at 0/1`);
    });
  },

  healPlayer(owner, amount, source) {
    const before = this.state[owner].health;
    const maxHP = this.state[owner].maxHealth;
    this.state[owner].health = Math.min(maxHP, this.state[owner].health + amount);
    const healed = this.state[owner].health - before;
    if (healed > 0) {
      this.log(`  [HEAL] ${this.seatVerb(owner, 'heal', 'heals')} ${healed} → ${this.state[owner].health}/${maxHP} HP`);
      if (source) {
        // Raw heal — kept for back-compat dashboards.
        this._creditChain(source, 'statsHealingDone', healed);
        // Leverage-weighted heal — sabermetrics-MVP refactor.
        // Healing at low HP is clutch (prevented near-lethal damage);
        // healing at full HP is mostly wasted. The multiplier is keyed
        // off the BEFORE-heal HP percentage so a heal that pulls you
        // off the brink scores higher than a "topping off" heal.
        const hpPct = before / Math.max(1, maxHP);
        const leverage = hpPct > 0.75 ? 0.2
                       : hpPct >= 0.4 ? 0.6
                                      : 1.2;
        this._creditChain(source, 'statsHealLeveraged', healed * leverage);
      }
    }
  },

  addNextTurnCurrency(owner, n) { this.state[owner].nextTurnCurrency += n; },

  // For player: show lane choice UI. For AI: auto-pick best lane.
  // callback(laneIdx) is called once the lane is chosen.
  // `targetSide` (optional) controls which slot the UI highlights — defaults to `owner`.
  // Pass the opponent's side when the choice targets enemy lanes (e.g. Jigsaw's traps).
  _promptTimeout: null,
  _clearPromptTimeout() {
    if (this._promptTimeout) { clearTimeout(this._promptTimeout); this._promptTimeout = null; }
    if (this.state) this.state._promptDeadline = null;
    if (typeof UI !== 'undefined' && UI.stopPromptCountdown) UI.stopPromptCountdown();
  },
  _startPromptTimeout(autoPickFn, ms) {
    this._clearPromptTimeout();
    const duration = ms || 30000;
    const deadline = Date.now() + duration;
    // Expose deadline so the UI can render a live countdown.
    this.state._promptDeadline = deadline;
    if (typeof UI !== 'undefined' && UI.startPromptCountdown) UI.startPromptCountdown(deadline);
    this._promptTimeout = setTimeout(() => {
      this._promptTimeout = null;
      this.state._promptDeadline = null;
      if (typeof UI !== 'undefined' && UI.stopPromptCountdown) UI.stopPromptCountdown();
      this.log(`  [TIMEOUT] Auto-picking — no response in ${duration / 1000}s`);
      autoPickFn();
    }, duration);
  },

  // ===================== AI ACTION DELAY =====================
  // When the AI auto-resolves a prompt (target pick, lane pick, etc.),
  // fire a brief toast + target-card highlight, wait the configured
  // step delay, THEN run the callback. Without this, every AI choice
  // resolves in the same render frame and the player can't tell what
  // the AI just did. User report: "my opponent played Gojo in lane 1,
  // but I have no idea which person he moved... could you have a
  // system where I see the person Gojo moved." Same fix for Jigsaw
  // bear traps, Captain America's Invincible target, Black Panther's
  // free-play pick, etc. Delay is configurable (UI.aiStepDelay) so
  // players who like fast AI can dial it down via settings.
  //   info: { title, desc, kind?, targetCard?, targetLane? }
  _aiActionDelay(callback, info) {
    info = info || {};
    const delayMs = (typeof UI !== 'undefined' && UI.aiStepDelay) ? UI.aiStepDelay() : 450;
    // Increment pending-AI-actions counter so the AI queue's
    // `hasPendingPrompt()` gate correctly waits for this delay
    // before advancing to the next play. Critical for chained
    // calls (Jigsaw's 3 traps, Hela's multi-summon, etc.) — each
    // recursive prompt schedules another _aiActionDelay; without
    // this counter the queue would race ahead and only the first
    // 1-2 actions would actually resolve before the round ends.
    this.state._pendingAIActions = (this.state._pendingAIActions || 0) + 1;
    // Toast immediately so the player has time to read it during the wait.
    if (info.title && typeof UI !== 'undefined' && UI.showAITrickToast) {
      try { UI.showAITrickToast(info.title, info.desc || '', info.kind || 'info'); } catch (e) { /* swallow */ }
    }
    // Brief target-highlight pulse on the affected card so the player
    // SEES which card the AI is targeting/moving/buffing/etc.
    if (info.targetCard && info.targetCard.id != null) {
      setTimeout(() => {
        try {
          const el = document.querySelector(`.card[data-card-id="${info.targetCard.id}"]`);
          if (el) {
            el.classList.add('target-highlight');
            setTimeout(() => { try { el.classList.remove('target-highlight'); } catch (e) {} }, Math.max(700, delayMs));
          }
        } catch (e) { /* swallow */ }
      }, 30);
    }
    setTimeout(() => {
      try { callback(); } catch (e) { console.error('[_aiActionDelay] callback threw:', e); }
      this.state._pendingAIActions = Math.max(0, (this.state._pendingAIActions || 0) - 1);
      this.resumeCombatIfWaiting();
      if (typeof UI !== 'undefined') UI.render();
    }, delayMs);
  },

  promptLaneChoice(owner, lanes, title, desc, callback, targetSide, previewCard, previewDamage) {
    // PROMPT QUEUE — a prompt is already open, so defer this arm instead of
    // clobbering the slot. The thunk re-enters this function on drain with
    // destroyed lanes filtered out; callbacks with stricter needs (summon
    // placement into a lane that filled meanwhile) already validate on
    // resolve, same as the timeout auto-pick path.
    if (this._promptBusy()) {
      this._promptQueue.push(() => this.promptLaneChoice(owner,
        (lanes || []).filter(i => this.state.lanes[i] && !this.state.lanes[i].destroyed),
        title, desc, callback, targetSide, previewCard, previewDamage));
      return;
    }
    if (!lanes || !lanes.length) {
      // No valid lanes — caller's effect can't resolve. Unstick combat so
      // the engine doesn't hang waiting on a callback that will never fire.
      console.warn('[promptLaneChoice] no valid lanes for', title, '(owner=' + owner + ') — unsticking combat');
      this.resumeCombatIfWaiting();
      return;
    }
    if (this.isHuman(owner) && lanes.length > 1) {
      // previewCard (optional) — synthetic card representing what lands
      //   in the chosen lane. Used for summon placement; UI renders
      //   makeDamagePreview against the lane's opposing enemy.
      // previewDamage (optional) — flat damage value to show on each
      //   highlighted enemy when targetSide is the opponent (chain
      //   abilities like Vader's 7-damage chain start, Darkseid's
      //   chain hit). UI shows one-way "−N HP" on each candidate.
      // Both are optional and independent; previewCard is for own-side
      //   placement, previewDamage is for own-side abilities targeting
      //   enemies. User spec: "When you place a summon, [show] damage
      //   preview. Or when you're using a chain ability and selecting
      //   an enemy, [show] damage preview as well, for Vader and stuff."
      this.state.pendingLaneChoice = { owner, lanes, title, desc, callback, targetSide: targetSide || owner, previewCard: previewCard || null, previewDamage: previewDamage || 0 };
      // 2v2 online: if this choice belongs to a guest (non-host), annotate
      // it so the guest's client knows to show the modal. The host skips
      // rendering/timeout here — the broadcast in _apply2v2OnlineAction
      // delivers the pending choice to the correct guest.
      const _cap = this._2v2CurrentActingPlayer;
      if (this.is2v2() && this.state.twoVTwo && this.state.twoVTwo.online && _cap && _cap !== 'p1') {
        this.state.pendingLaneChoice._2v2ActingPlayer = _cap;
        return;
      }
      // 1v1 online: a lane choice owned by the guest seat ('ai') must be
      // resolved on the GUEST's client, not auto-picked here. Store it (the
      // trailing _mpBroadcast in _mpApplyAction delivers it) and broadcast
      // explicitly to cover prompts armed outside a wrapped action (e.g. a
      // summon firing from the detached postCombat/drawPhase path). Skip the
      // host's local render + 30s auto-pick — without this, the host's timeout
      // silently picks lanes[0] (then 1, 2 for chained summons) before the
      // guest ever sees a picker. The guest forwards a promptResolve
      // choiceType:'lane' which the host applies authoritatively.
      if (this.isMultiplayer() && this.mp.role === 'host' && owner === 'ai') {
        // Kill any stale auto-pick timer from an earlier prompt — a live
        // timer's closure would otherwise fire against THIS guest-owned
        // prompt and silently place the guest's card in lanes[0] (root
        // cause of the recurring "guest card always plays into the
        // lowest open lane with no picker" report).
        this._clearPromptTimeout();
        this._mpBroadcast();
        return;
      }
      UI.render();
      const armedLc = this.state.pendingLaneChoice;
      this._startPromptTimeout(() => {
        const cur = this.state.pendingLaneChoice;
        if (!cur) return;
        // Identity check — only resolve the EXACT prompt this timer was
        // armed for. A stale timer surviving into a newer prompt (the
        // other root cause of the lowest-lane bug) must never pick for it.
        if (cur !== armedLc) return;
        // Ownership check — never auto-resolve a prompt owned by the
        // other human in multiplayer; their client resolves it.
        if (this.isMultiplayer() && cur.owner !== this.mp.you) return;
        const pick = cur.lanes[0];
        this.state.pendingLaneChoice = null;
        callback(pick);
        this.resumeCombatIfWaiting();
        UI.render();
      });
    } else if (this.isHuman(owner) && lanes.length === 1) {
      // Single valid lane — auto-resolve. Match promptCardChoice and
      // surface a toast so the player sees WHY no choice screen
      // appeared. Wording is intentionally neutral ("Lane N — only
      // option") because callers split between placement-style
      // ("Place X") and damage-targeting ("Vader chain start") and
      // a more specific verb would be wrong half the time.
      try {
        if (typeof UI !== 'undefined' && UI.showAITrickToast) {
          UI.showAITrickToast(
            `Lane ${lanes[0] + 1} — only option`,
            title.replace(/^[^—]*—\s*/, '') || title,
            'info'
          );
        }
      } catch (e) { /* swallow */ }
      callback(lanes[0]);
    } else {
      // AI auto-resolve. Add a delay + toast so the player sees
      // WHICH lane the AI picked instead of the choice happening
      // invisibly in the same frame as the play.
      const pick = lanes.length ? lanes[0] : -1;
      if (pick >= 0) {
        this._aiActionDelay(() => callback(pick), {
          title: title.replace(/\s*—.*$/, ''),
          desc: `${desc || 'Lane ' + (pick + 1)}`,
          kind: 'info',
        });
      }
    }
  },

  promptCardChoice(owner, cards, title, desc, callback, aiPicker, options) {
    // PROMPT QUEUE — see promptLaneChoice. The thunk drops board cards that
    // died while waiting (entries WITHOUT currentHealth — synthetic choices
    // like Darkseid's lane list or Kang's defs — pass through untouched).
    if (this._promptBusy()) {
      this._promptQueue.push(() => this.promptCardChoice(owner,
        (cards || []).filter(c => !c || c.currentHealth == null || c.currentHealth > 0),
        title, desc, callback, aiPicker, options));
      return;
    }
    if (!cards || !cards.length) {
      // No valid targets — log and unstick combat so an empty filter
      // upstream (e.g. chain ability with no enemies) doesn't strand
      // the engine waiting on a callback. Previously returned silently.
      console.warn('[promptCardChoice] no valid targets for', title, '(owner=' + owner + ') — unsticking combat');
      this.resumeCombatIfWaiting();
      return;
    }
    const forcePrompt = !!(options && options.forcePrompt);
    if (this.isHuman(owner) && (cards.length > 1 || forcePrompt)) {
      this.state.pendingCardChoice = { owner, cards, title, desc, callback, faceDown: !!(options && options.faceDown), inlineTray: !!(options && options.inlineTray) };
      // 2v2 online: route guest choices to the guest client (same as lane choice)
      const _cap = this._2v2CurrentActingPlayer;
      if (this.is2v2() && this.state.twoVTwo && this.state.twoVTwo.online && _cap && _cap !== 'p1') {
        this.state.pendingCardChoice._2v2ActingPlayer = _cap;
        return;
      }
      // 1v1 online: a card/target choice owned by the guest seat ('ai')
      // resolves on the GUEST's client. Store + broadcast explicitly (covers
      // prompts armed outside a wrapped action, e.g. Dr. Strange's Foresee
      // raised from the detached postCombat/drawPhase path) and skip the host's
      // local render + 30s auto-pick — that timeout was silently selecting the
      // guest's ability target. Guest forwards promptResolve choiceType:'card';
      // host applies it authoritatively.
      if (this.isMultiplayer() && this.mp.role === 'host' && owner === 'ai') {
        // Same stale-timer kill as promptLaneChoice — see comment there.
        this._clearPromptTimeout();
        this._mpBroadcast();
        return;
      }
      UI.render();
      const armedCc = this.state.pendingCardChoice;
      this._startPromptTimeout(() => {
        const cur = this.state.pendingCardChoice;
        if (!cur) return;
        // Identity + ownership checks — mirror promptLaneChoice: a stale
        // timer must never resolve a newer prompt, and the host must never
        // auto-resolve the guest's choice (their client owns it).
        if (cur !== armedCc) return;
        if (this.isMultiplayer() && cur.owner !== this.mp.you) return;
        // Never use the AI picker in any multiplayer/2v2 context — all seats
        // are human; cards[0] is a neutral fallback when the timer expires.
        const pick = (!this.isMultiplayer() && !this.is2v2() && aiPicker)
          ? aiPicker(cur.cards)
          : cur.cards[0];
        this.state.pendingCardChoice = null;
        callback(pick);
        this.resumeCombatIfWaiting();
        UI.render();
      });
    } else if (this.isHuman(owner) && cards.length === 1) {
      // Auto-resolve when there's only one valid target. The 'Auto-targeted
      // X' toast that used to fire here was removed (user circled it: "this
      // is still here") — its header masqueraded as the old 'AI played a
      // Trick' banner, and the trick reveal + the visible on-board effect
      // already tell the story. The log line below keeps it diagnosable.
      const target = cards[0];
      this.log(`  [AUTO-TARGET] ${title.replace(/\s*—.*$/, '')} → ${target.name} (only valid target)`);
      callback(target);
    } else {
      // AI auto-resolve. Show a toast naming the chosen target +
      // briefly highlight the target card so the player SEES which
      // ally/enemy the AI's effect is hitting.
      const pick = aiPicker ? aiPicker(cards) : cards[0];
      this._aiActionDelay(() => callback(pick), {
        title: title.replace(/\s*—.*$/, ''),
        desc: `Targeting ${pick.name}`,
        targetCard: pick,
        kind: 'info',
      });
    }
  },

  // Summon with player lane choice. Optional onComplete callback for chaining.
  summonCardChoice(owner, name, cost, attack, health, abilities, preferredLanesOrCb, onComplete, sourceDef) {
    // Handle overloaded args: if 7th arg is function, it's onComplete
    let preferredLanes = preferredLanesOrCb;
    if (typeof preferredLanesOrCb === 'function') { onComplete = preferredLanesOrCb; preferredLanes = null; }
    const open = preferredLanes || this.getOpenLanes(owner);
    if (!open.length) { if (onComplete) onComplete(); return; }
    if (!this.isHuman(owner) || open.length === 1) {
      // The summon itself fires immediately (its own card-build-in
      // animation IS the visual cue showing WHERE the summon went).
      // For AI summons specifically, delay the onComplete so chained
      // summons (Hela's 2 warriors, etc.) feel sequential rather
      // than all flashing in one frame.
      const lane = open[0];
      this.summonCard(owner, lane, name, cost, attack, health, abilities, sourceDef);
      if (onComplete) {
        if (!this.isHuman(owner)) {
          this._aiActionDelay(onComplete, {
            title: `${name} summoned`,
            desc: `Lane ${lane + 1}`,
            kind: 'info',
          });
        } else {
          onComplete();
        }
      }
    } else {
      // Build a synthetic preview card matching what would land in the
      // chosen lane so the per-lane damage preview can show the trade
      // math against each candidate's opposite enemy.
      const previewCard = {
        name, cost, attack, currentHealth: health, maxHealth: health,
        baseAttack: attack, baseHealth: health,
        abilities: [...(abilities || [])],
        owner,
        // Sane defaults — applyAbilities mutates these from the keyword
        // array so badges like "Splash N" / "Evade N" / "Bullseye"
        // factor into the projected combat resolution.
        evadeCharges: 0, armorValue: 0, splashRange: 0,
        invincibleTurns: 0, immunityCharges: 0, unresistibleCharges: 0,
        isOverdrive: false, isBullseye: false, hasDamageImmunity: false,
        tauntTurns: 0, hasHunt: false,
        isStunned: false, isFrozen: false, isFeared: false, isMindControlled: false,
        // Counter representation — drives stacking. Booleans above are
        // derived (true iff counter > 0) and synced by *Card methods +
        // round-tick. See "DEBUFF STACKING" comment block.
        stunnedTurns: 0, frozenTurns: 0, fearedTurns: 0
      };
      this.applyAbilities(previewCard);
      this.promptLaneChoice(owner, open, `Place ${name}`, `Choose a lane for ${name} (${attack}/${health})`, (lane) => {
        this.summonCard(owner, lane, name, cost, attack, health, abilities, sourceDef);
        if (onComplete) onComplete();
      }, owner, previewCard);
    }
  },

  summonCard(owner, laneIdx, name, cost, attack, health, abilities, sourceDef) {
    if (laneIdx < 0 || laneIdx >= this.LANE_COUNT) return;
    if (this.state.lanes[laneIdx][owner] || this.state.lanes[laneIdx].destroyed) return;

    // DEFENSE-IN-DEPTH: refuse to summon discard-effect cards onto the
    // board. Their entire kit lives in `onDiscard` — they're 0/0 stats,
    // so summoning one places a dead body that does nothing AND the
    // discard effect never fires (because it requires being discarded
    // FROM HAND, not being summoned). User reported: "cant draw discards
    // from a summon — Catwoman was summoned onto board from Mother Box."
    // Mother Box itself does filter, but Cyborg's onDeath (summons random
    // from hand) and a few other paths don't — guarding here ensures
    // any caller, present or future, can't make this mistake. Returns
    // a falsy value so callers that branch on the return get a
    // consistent "didn't summon" signal.
    const flaggedDiscard = !!(sourceDef && sourceDef.isDiscardEffect);
    // Cross-check by name lookup so even callers passing a stripped def
    // (e.g. Cyborg passing the in-hand card object) still get filtered.
    let nameDiscardFlag = false;
    if (typeof CARD_DEFS !== 'undefined' && name) {
      const fullDef = CARD_DEFS.find(d => d.name === name);
      if (fullDef && fullDef.isDiscardEffect) nameDiscardFlag = true;
    }
    if (flaggedDiscard || nameDiscardFlag) {
      this.log(`  [SUMMON] ${name} not summoned — discard-effect cards can't be placed on the board.`);
      return;
    }
    // DEFENSE-IN-DEPTH: environments must NEVER be summoned into a COMBAT slot
    // — they deploy via their own env-slot flow (playCard's isEnvironment
    // branch). summonCard writes lanes[i][owner] (a combat slot), so a summon
    // pool that includes an environment (Knull's random 1-9, a dead-pile
    // reanimate, etc.) would drop it there and strand it. Caught by the fuzz
    // invariant sweep: "Gargantua is an ENVIRONMENT in a combat slot".
    let flaggedEnv = !!(sourceDef && (sourceDef.isEnvironment || sourceDef.type === 'environment'));
    if (!flaggedEnv && typeof CARD_DEFS !== 'undefined' && name) {
      const envDef = CARD_DEFS.find(d => d.name === name);
      if (envDef && (envDef.isEnvironment || envDef.type === 'environment')) flaggedEnv = true;
    }
    if (flaggedEnv) {
      this.log(`  [SUMMON] ${name} not summoned — environments can't be placed in a combat slot.`);
      return;
    }

    // Build definition: use full source def for draw-pile summons, minimal for tokens
    let def;
    if (sourceDef) {
      def = sourceDef;
    } else {
      // Tokens get an EMPTY desc — the badges row already shows the
      // full keyword set ("EVADE 1", "BULLSEYE", etc.), so a string
      // like "Bullseye. Evade 1" at the bottom of the card was just
      // duplicating what the badges already render. User flagged the
      // duplicate "Evade 1" text appearing under the Ant. Empty desc
      // keeps the token's body clean — badges only.
      def = { name, cost, attack, health, abilities, type: 'neutral', desc: '' };
    }

    const card = this.createCardInstance(def, owner);
    // Flag tokens so they can be excluded from the dead pile on death.
    // Tokens are inline-defined summons (Ant, Parademon, Undead Warrior,
    // The Kraken, etc.) — they're not part of either player's
    // drafted deck, so they shouldn't come back via Lazarus Pit, Solomon
    // Grundy's onDeath draw, Hela's resurrection, or any other dead-pile
    // effect. Real-card summons (Bat Signal pulling a drafted card from
    // the pile) pass a full sourceDef and are NOT flagged — those live
    // and die like any drafted card.
    if (!sourceDef) card._isToken = true;
    // MVP chain attribution — tag this card with the ability source that
    // produced it (Hela → zombie, Cyborg → Null) and credit the summoner
    // with the summoned card's cost as energy generated. _creditChain
    // walks up the chain so every ancestor gets the credit.
    const summoner = this._currentSummonSource();
    if (summoner && summoner.id !== card.id) {
      card._summonedBy = summoner;
      this._creditChain(summoner, 'statsEnergyGenerated', card.baseCost || card.cost || 0);
    }
    // Slot and card.owner must always agree — the engine's cleanup invariant
    // checks it, and a mismatch makes combat/targeting read the wrong side.
    // 2v2 jump/free plays surfaced this: a card owned by one side landing in
    // the other side's slot. placeInLane already stamped; these paths didn't.
    card.owner = owner;
    this.state.lanes[laneIdx][owner] = card;
    this._emitEntranceFX(card);
    card.statsEnteredRound = this.state.round || 1;
    this.log(`  [SUMMON] ${name} (${card.attack}/${card.currentHealth}) in lane ${laneIdx + 1}`);
    this.checkLaneTrap(card, laneIdx);

    // Persistent auras (Luke's -1/-1, Magneto, etc.) need to fire on EVERY
    // arrival including TOKEN summons (Hela's Undead Warriors, Cyborg's
    // Doombot, Ant-Man's Ant). User report: "Luke is on board, Hela
    // summons three 3/1 zombies, they survive — but Luke's While Active
    // -1/-1 should kill them (3/1 → 3/0)." Bug: this branch was gated
    // on `sourceDef`, so token summons skipped the aura ping entirely.
    // Now we always fire `onAnyCardPlayed` (auras) and Magneto's
    // even-lane debuff sweep, plus the cardPlayedBuff passive. The
    // `onPlay` hook for the SUMMONED card itself stays gated on
    // `sourceDef` so tokens don't re-fire their own play hooks (and
    // there's no infinite-recursion risk via the chain guard).
    // THE STACK stage 3 — the ARRIVAL SEQUENCE rides the resolution queue.
    // Placement (slot + entrance FX + lane trap, above) is already done
    // synchronously — the summoner sees the card on board immediately. The
    // hooks resolve as one stack event: a top-level summon runs them right
    // here (old behavior); a summon fired inside another event's resolution
    // (Ghost Rider's death → Knull → volley) queues each arrival and they
    // resolve breadth-first in summon order — Knull's volley stays
    // left-to-right, every card's onPlay and aura ping fires. This retires
    // the depth-4 counter that SILENTLY dropped the whole block on deep
    // chains (the old Knull-volley bug one level deeper); the drain's
    // 500-step fuse is the runaway guard now.
    this._stackRun(`arrival:${card.name}`, () => {
      // Lone wolf is a real-summon flavor only — skip for tokens.
      if (sourceDef) {
        const otherAllies = this.getAllCardsOf(owner).filter(c => c.id !== card.id && c.currentHealth > 0 && !c.isEnvironment);
        if (otherAllies.length === 0) {
          this.buffCard(card, 1, 1);
          this.log(`  [LONE WOLF] ${card.name} enters alone — +1/+1!`);
        }
      }
      // Aura ping — fires for tokens too so existing while-active auras
      // (Luke's debuff, Captain America's squad buff, etc.) hit them.
      this.broadcastHook('onAnyCardPlayed', card, [card]);
      this.getAllCardsOf(owner).forEach(c => {
        if (c.passive === 'cardPlayedBuff' && c.id !== card.id) { const n = c._bpAuraSize || 1; this.buffCard(card, n, n); }
      });
      // onPlay still only fires for real-card summons.
      if (sourceDef) {
        this._runHook(card, 'onPlay', this, card, laneIdx);
        // Draw-on-play keyword resolution — mirrors the path in
        // playCard so cards entering via SUMMON (Super Soldier Serum
        // transform, Bat Signal pull, Hela revive, etc.) still honor
        // their `Draw N` keyword. User report: "Used SSS on Rocket
        // and got Groot, but his Draw 1 status badge didn't fire."
        if (card.drawOnPlay > 0) {
          const n = card.drawOnPlay;
          card.drawOnPlay = 0;
          const before = this.state[owner].hand.length;
          this.drawCards(owner, n);
          const actuallyDrawn = this.state[owner].hand.length - before;
          if (actuallyDrawn > 0) this._creditChain(card, 'statsCardAdvantage', actuallyDrawn);
          this.log(`${card.name} draws ${n} card${n > 1 ? 's' : ''}.`);
        }
        // Cantrip etch — fire on summon-spawned real cards too.
        this._resolveCantripOnPlay(card);
        // Fear / Freeze / MC / Mark etches — same on-play firing.
        this._resolveFearOnPlay(card);
        this._resolveFreezeOnPlay(card);
        this._resolveMindControlOnPlay(card);
        this._resolveMarkOnPlay(card);
      }
      this.cleanupDead();
      this.applyMagnetoDebuffs();
    });
  },

  // A 9+/10-cost card ENTERING the board (played, summoned, revived — not
  // moved) gets the titan-entrance FX. Event-driven so it fires once, on
  // every client, and never on undo-restores.
  _emitEntranceFX(card) {
    if (card && !card.isEnvironment && (card.baseCost || card.cost || 0) >= 9) {
      this.emitFX('titan', { cardId: card.id, owner: card.owner });
    }
  },

  placeInLane(owner, card, laneIdx) {
    if (this.state.lanes[laneIdx][owner] || this.state.lanes[laneIdx].destroyed) return;
    if (card && card._neverPlayable) return;   // Iron Giant — hand-guard only
    if (card && this.findCardLane(card) >= 0) return;   // never place a card twice
    card.owner = owner;
    this.state.lanes[laneIdx][owner] = card;
    this._emitEntranceFX(card);
    this.checkLaneTrap(card, laneIdx);
  },

  moveCard(card, from, to) {
    if (from < 0 || to < 0 || to >= this.LANE_COUNT || this.state.lanes[to][card.owner]) return;
    // No moving into a destroyed (voided) lane — the lane doesn't exist for
    // its remaining rounds. Callers usually filter via getOpenLanes, but
    // direct movers (swaps, displacement effects) hit this guard instead.
    if (this.state.lanes[to].destroyed) {
      this.log(`  [MOVE BLOCKED] Lane ${to + 1} is a void — ${card.name} can't enter.`);
      return;
    }
    if (this._trickBlocked(card)) return;
    // Frozen / stunned cards can't move — they're locked in their lane
    // until the status clears. Previously tricks and abilities that moved
    // cards (Bifrost, Ahsoka's swap, Gojo's displace) bypassed the freeze.
    if (card.isFrozen || card.isStunned) {
      this.log(`  [MOVE BLOCKED] ${card.name} is ${card.isFrozen ? 'FROZEN' : 'STUNNED'} — can't move.`);
      return;
    }
    this.state.lanes[from][card.owner] = null;
    this.state.lanes[to][card.owner] = card;
    this.log(`  [MOVE] ${card.name} moves from lane ${from + 1} to lane ${to + 1}`);
    this.checkLaneTrap(card, to);
    if (card.onMoved) card.onMoved(this, card, to);
    // Magneto's parity aura is positional — reconcile after EVERY move, not
    // just the ones Magneto's own On Play makes. Without this, a card that
    // changed lane parity via Man-Bat's flight / Gojo / Bifrost / a hunt
    // carried a stale buff (or missed a due one) until the next round tick.
    this.applyMagnetoDebuffs();
  },

  removeFromLane(card, l) {
    if (l < 0 || l >= this.LANE_COUNT) return;
    const lane = this.state.lanes[l];
    if (lane[card.owner] === card) { lane[card.owner] = null; return; }
    if (lane._env && lane._env[card.owner] === card) lane._env[card.owner] = null;
  },

  // Reverse Bear Trap (placed by Jigsaw): when an enemy of the trap-placer enters
  // the lane, the card immediately loses -1/-1 and the trap is consumed.
  // Call this after placing a card into a lane via any mechanism.
  checkLaneTrap(card, laneIdx) {
    if (!card || laneIdx < 0 || laneIdx >= this.LANE_COUNT) return;
    const lane = this.state.lanes[laneIdx];
    if (!lane || !lane.trap || lane.trap.placedBy === card.owner) return;
    // Invincibility / Damage Immunity blocks the Bear Trap entirely —
    // the card "stepped on the trap but nothing happened." User spec:
    // "If Flash has Invincibility he should still be 2/1 because he
    // didn't get damaged by the bear trap. Same for any card."
    if (card.invincibleTurns > 0 || card.hasDamageImmunity) {
      lane.trap = null;
      this.log(`  [BEAR TRAP] ${card.name} steps on a Reverse Bear Trap — Invincibility absorbs it!`);
      return;
    }
    // Trap-set Text+ ("Game Master") stamps a custom debuff on each
    // trap; default is the classic 1 (so -1/-1).
    const debuff = (lane.trap && lane.trap.debuff) || 1;
    lane.trap = null;
    card.attack = Math.max(0, card.attack - debuff);
    card.maxHealth = Math.max(1, card.maxHealth - debuff);
    card.currentHealth = Math.max(0, card.currentHealth - debuff);
    this.log(`  [BEAR TRAP] ${card.name} triggers a Reverse Bear Trap! -${debuff}/-${debuff} → ${card.attack}/${card.currentHealth}`);
    // A trap that drops the card to 0 HP is lethal — route through the
    // canonical death path so it can't sit on the board as a 0-HP
    // "zombie" (dead-but-unresolved). checkLaneTrap has 8 callers and most
    // don't run cleanupDead afterward, so fixing it here (the source) is
    // what makes every caller safe. Fuzz/HUNTER-caught: a trapped Magneto /
    // Mr. Freeze survived at 0 HP into the next round.
    if (card.currentHealth <= 0) this.handleDeath(card, laneIdx, null);
  },

  applyHawkeyePassive(owner, splashedEnemies) {
    if (!splashedEnemies.length) return;
    const hawkeye = this.getAllCardsOf(owner).find(c => c.passive === 'splashWeaken');
    if (!hawkeye) return;
    // Roguelite Text+ ("Trick Arrows") — _hawkeyeSplashWeaken raises
    // the per-hit ATK strip from 1 to 3.
    const strip = hawkeye._hawkeyeSplashWeaken || 1;
    splashedEnemies.forEach(e => {
      if (e.attack > 0) {
        const taken = Math.min(strip, e.attack);
        e.attack = Math.max(0, e.attack - taken);
        this.log(`  [HAWKEYE] ${e.name} loses ${taken} ATK from splash! (now ${e.attack})`);
        this._creditChain(hawkeye, 'statsDebuffValue', taken);
      }
    });
  },

  splashDamage(laneIdx, owner, amount) {
    const opp = this.opponent(owner);
    const splashed = [];
    // Only surviving enemies that ACTUALLY took damage count for Hawkeye's
    // ATK-debuff passive — invincible / evade / full-armor blocks mean the
    // splash bounced off and the target should keep its attack.
    // Front (same lane)
    const front = this.state.lanes[laneIdx][opp];
    if (front && front.currentHealth > 0) {
      const hpBefore = front.currentHealth;
      this.dealDamage(front, amount);
      if (front.currentHealth > 0 && front.currentHealth < hpBefore) splashed.push(front);
    }
    // Adjacent lanes
    if (laneIdx > 0 && this.state.lanes[laneIdx - 1][opp]) {
      const t = this.state.lanes[laneIdx - 1][opp];
      const hpBefore = t.currentHealth;
      this.dealDamage(t, amount);
      if (t.currentHealth > 0 && t.currentHealth < hpBefore) splashed.push(t);
    }
    if (laneIdx < this.LANE_COUNT - 1 && this.state.lanes[laneIdx + 1][opp]) {
      const t = this.state.lanes[laneIdx + 1][opp];
      const hpBefore = t.currentHealth;
      this.dealDamage(t, amount);
      if (t.currentHealth > 0 && t.currentHealth < hpBefore) splashed.push(t);
    }
    this.applyHawkeyePassive(owner, splashed);
  },

  // ===================== VADER CHAIN DAMAGE =====================

  // Deals chain damage to a card. Returns true if damage was actually dealt (chain continues).
  // Returns false if blocked by Evade/Invincible/Armor(0)/DamageImmunity (chain stops).
  dealChainDamage(card, amount, label) {
    if (!card || card.currentHealth <= 0) return false;
    const tag = label || 'CHAIN';

    // Shared absorb order (Invincible → Immunity → Evade). Chain evade ignores
    // Stunned/Frozen (pre-existing behavior), so canEvade = has-charges.
    const absorb = this._classifyAbsorb(card, true);
    if (absorb === 'invincible') {
      this.log(`  [INVINCIBLE] ${card.name} is invincible — chain stops!`);
      return false;
    }
    if (absorb === 'immunity') {
      this.log(`  [DMG IMMUNE] ${card.name} is damage-immune — chain stops!`);
      return false;
    }
    if (absorb === 'evade') {
      card.evadeCharges--;
      this.log(`  [EVADE] ${card.name} dodges the chain! (${card.evadeCharges} charges left)`);
      return false;
    }
    if (card.armorValue > 0) {
      if (amount <= card.armorValue) {
        this.log(`  [ARMOR] ${card.name}'s Armor ${card.armorValue} fully absorbs ${amount} chain damage — chain stops!`);
        return false;
      }
      amount -= card.armorValue;
      this.log(`  [ARMOR] ${card.name}'s Armor ${card.armorValue} reduces chain damage to ${amount}`);
    }

    if (this.state._yodaShieldFor && this.state._yodaShieldFor[card.owner] > 0) {
      amount = Math.ceil(amount / 2);
      if (amount <= 0) return true;
    }
    card.currentHealth -= amount;
    this.log(`  [${tag}] ${card.name} takes ${amount} → ${Math.max(0, card.currentHealth)} HP`);
    if (card.onDamaged) card.onDamaged(this, card, null, amount);
    return true;
  },

  // ===================== OMEGA BEAM (Darkseid) =====================
  // Distributes Darkseid's attack damage among all enemies. Each enemy targeted once.
  // Evade blocks the entire allocated amount (counts as one attack instance).
  distributeOmegaBeam(card) {
    const enemies = this.getEnemiesOf(card.owner).filter(e => e.currentHealth > 0);
    if (!enemies.length) return;
    let remaining = card.attack;
    const targeted = new Set();
    this.log(`[OMEGA BEAM] ${card.name} distributes ${remaining} damage!`);

    const doNext = () => {
      const available = enemies.filter(e => !targeted.has(e.id) && e.currentHealth > 0);
      if (remaining <= 0 || !available.length) {
        if (remaining > 0) this.log(`  [OMEGA BEAM] ${remaining} damage wasted — no more targets`);
        this.cleanupDead();
        return;
      }
      // ALWAYS prompt the human controller — even when only 1 target
      // remains. User report: "i am splitting darkseids beams and it
      // wont let me finish the rest of his damage, i did 4 to predator
      // and have 2 left but it seems to have froze." Root cause was
      // the `available.length === 1` auto-assign block: with only one
      // enemy left, the beam dumped the remaining damage silently and
      // returned. From the player's POV it felt stuck — they were
      // expecting a target prompt for the remaining 2 damage. The AI
      // path (below) still auto-resolves; only the human gets the
      // explicit confirm beat. Same spec as Galactus / Dormammu /
      // Mind Control: "the user always chooses".
      const promptTarget = (cb) => {
        if (Game.isHuman(card.owner)) {
          // Smart picker: prefer high-threat enemies we can KILL with
          // available damage. Falls back to highest-threat if nothing
          // killable. The old "lowest HP" heuristic killed weak units
          // even when a 1-HP-extra spend could've removed a much
          // bigger threat.
          const smartPick = (cards) => {
            const noEvade = cards.filter(c => !c.evadeCharges);
            const pool = noEvade.length ? noEvade : cards;
            // Killable = current HP + armor ≤ remaining damage
            const killable = pool.filter(c => {
              const armor = c.armorValue || 0;
              return (c.currentHealth || 0) + armor <= remaining;
            });
            const score = (c) => (typeof AI !== 'undefined' && AI.threatScore)
              ? AI.threatScore(c)
              : (c.attack || 0) + (c.cost || 0) * 0.5;
            if (killable.length) {
              // Highest-threat killable target — efficient damage use.
              return killable.slice().sort((a, b) => score(b) - score(a))[0];
            }
            // Nothing killable — dump on highest-threat (chip + setup
            // for next damage source / round combat).
            return pool.slice().sort((a, b) => score(b) - score(a))[0];
          };
          this.promptCardChoice(card.owner, available,
            `Omega Beam — ${remaining} damage left`, "Choose enemy to target",
            cb,
            smartPick);
        } else {
          // AI controller — same smart pick, no modal round-trip.
          const noEvade = available.filter(c => !c.evadeCharges);
          const pool = noEvade.length ? noEvade : available;
          const score = (c) => (typeof AI !== 'undefined' && AI.threatScore)
            ? AI.threatScore(c)
            : (c.attack || 0) + (c.cost || 0) * 0.5;
          const killable = pool.filter(c => {
            const armor = c.armorValue || 0;
            return (c.currentHealth || 0) + armor <= remaining;
          });
          const target = killable.length
            ? killable.slice().sort((a, b) => score(b) - score(a))[0]
            : pool.slice().sort((a, b) => score(b) - score(a))[0];
          cb(target);
        }
      };
      promptTarget((target) => {
        targeted.add(target.id);
        // Pick amount
        const amounts = [];
        for (let n = 1; n <= remaining; n++) {
          amounts.push({ name: `${n} Damage`, desc: `Deal ${n} to ${target.name}`, _amount: n });
        }
        if (Game.isHuman(card.owner)) {
          this.promptCardChoice(card.owner, amounts,
            `Omega Beam — ${target.name}`, `Allocate damage (${remaining} remaining)`,
            (choice) => {
              const dmg = choice._amount;
              this.log(`  [OMEGA BEAM] Fires ${dmg} at ${target.name}!`);
              this.dealDamage(target, dmg, card);
              remaining -= dmg;
              this.cleanupDead();
              doNext();
            },
            (amts) => {
              // AI fallback for amount picker (when human prompt collapses
              // because amounts.length === 1, i.e., only 1 damage left).
              const hp = target.currentHealth;
              const armor = target.armorValue || 0;
              const needed = hp + armor;
              return needed <= remaining
                ? amts.find(a => a._amount === needed) || amts[amts.length - 1]
                : amts[amts.length - 1];
            }
          );
        } else {
          // AI controller — pick amount directly, no modal.
          const hp = target.currentHealth;
          const armor = target.armorValue || 0;
          const needed = hp + armor;
          const dmg = needed <= remaining ? needed : remaining;
          this.log(`  [OMEGA BEAM] Fires ${dmg} at ${target.name}!`);
          this.dealDamage(target, dmg, card);
          remaining -= dmg;
          this.cleanupDead();
          doNext();
        }
      });
    };
    doNext();
  },

  // Generic directional auto-chain. Player picks left or right, then chain continues
  // automatically until damage runs out or is negated (evade/invincible/armor/dmg immune).
  // damageReducePerStep: 0 for constant-damage chains (Cap, WW), 1 for Vader.
  autoChainDamage(owner, startLane, damage, damageReducePerStep, callback, label) {
    const opp = this.opponent(owner);
    const canLeft = startLane - 1 >= 0 && this.state.lanes[startLane - 1][opp] &&
                    this.state.lanes[startLane - 1][opp].currentHealth > 0;
    const canRight = startLane + 1 < this.LANE_COUNT && this.state.lanes[startLane + 1][opp] &&
                     this.state.lanes[startLane + 1][opp].currentHealth > 0;

    if (!canLeft && !canRight) { if (callback) callback(); return; }

    const doChain = (direction) => {
      this._chainInDirection(owner, startLane, direction, damage, damageReducePerStep, callback, label);
    };

    if (canLeft && canRight) {
      if (!this.isHuman(owner)) {
        // AI-controlled: pick direction with more consecutive enemies
        let leftCount = 0, rightCount = 0;
        for (let l = startLane - 1; l >= 0; l--) {
          const e = this.state.lanes[l][opp];
          if (e && e.currentHealth > 0) leftCount++; else break;
        }
        for (let l = startLane + 1; l < this.LANE_COUNT; l++) {
          const e = this.state.lanes[l][opp];
          if (e && e.currentHealth > 0) rightCount++; else break;
        }
        doChain(leftCount >= rightCount ? -1 : 1);
      } else {
        this.promptLaneChoice(owner, [startLane - 1, startLane + 1],
          label ? `${label} — Pick Direction` : 'Chain — Pick Direction',
          `Choose left or right to chain ${damage} damage`,
          (chosen) => { doChain(chosen < startLane ? -1 : 1); }
        );
      }
    } else {
      doChain(canLeft ? -1 : 1);
    }
  },

  // Internal: chain in a fixed direction from fromLane, hitting each consecutive enemy.
  _chainInDirection(owner, fromLane, direction, damage, damageReducePerStep, callback, label) {
    const opp = this.opponent(owner);
    const nextLane = fromLane + direction;
    if (nextLane < 0 || nextLane >= this.LANE_COUNT || damage <= 0) { if (callback) callback(); return; }

    const target = this.state.lanes[nextLane][opp];
    if (!target || target.currentHealth <= 0) { if (callback) callback(); return; }

    const dealt = this.dealChainDamage(target, damage, label);
    this.cleanupDead();

    if (!dealt) { if (callback) callback(); return; }

    const nextDmg = damage - damageReducePerStep;
    if (nextDmg <= 0) { if (callback) callback(); return; }

    this._chainInDirection(owner, nextLane, direction, nextDmg, damageReducePerStep, callback, label);
  },

  // Start Vader's chain. Player picks starting target, then direction for auto-chain.
  startVaderChain(owner, callback, vader) {
    const opp = this.opponent(owner);
    const enemyLanes = [];
    for (let i = 0; i < this.LANE_COUNT; i++) {
      const e = this.state.lanes[i][opp];
      if (e && e.currentHealth > 0) enemyLanes.push(i);
    }
    if (!enemyLanes.length) { if (callback) callback(); return; }

    // Roguelite Text+ override — _vaderChainDamage scales the opening
    // chain hit. Default 7 (classic); Text+ to 9 so a Doombot or Hulk
    // eats the opening swing instead of just chipping. Subsequent
    // chain steps still reduce by 1 per step from the new ceiling.
    const startDmg = (vader && vader._vaderChainDamage) || 7;
    const followDmg = startDmg - 1;

    const hitAndChain = (lane) => {
      const target = this.state.lanes[lane][opp];
      if (!target || target.currentHealth <= 0) { if (callback) callback(); return; }

      const dealt = this.dealChainDamage(target, startDmg, "VADER CHAIN");
      this.cleanupDead();

      if (!dealt) { if (callback) callback(); return; }

      // Continue chain from this lane with reduced damage, reducing by 1 per step
      this.autoChainDamage(owner, lane, followDmg, 1, callback, "VADER CHAIN");
    };

    if (!this.isHuman(owner)) {
      // AI-controlled Vader: score each candidate start lane. Reject
      // targets that absorb the opening hit outright (evade /
      // invincible / dmg-immune / armor ≥ startDmg). Prefer clean kills + long
      // chain reach.
      const scoreStart = (lane) => {
        const t = this.state.lanes[lane][opp];
        if (!t || t.currentHealth <= 0) return -Infinity;
        if (t.evadeCharges > 0) return -Infinity;
        if (t.invincibleTurns > 0) return -Infinity;
        if (t.hasDamageImmunity) return -Infinity;
        const dmg = Math.max(0, startDmg - (t.armorValue || 0));
        if (dmg === 0) return -Infinity; // armor soaks, chain aborts
        let lReach = 0, rReach = 0;
        for (let l = lane - 1; l >= 0; l--) {
          const e = this.state.lanes[l][opp];
          if (e && e.currentHealth > 0) lReach++; else break;
        }
        for (let l = lane + 1; l < this.LANE_COUNT; l++) {
          const e = this.state.lanes[l][opp];
          if (e && e.currentHealth > 0) rReach++; else break;
        }
        const reach = Math.max(lReach, rReach);
        const willKill = t.currentHealth <= dmg;
        const dmgLanded = Math.min(dmg, t.currentHealth);
        // killBonus=10 to clearly prefer clean kills; reach*3 weights
        // chain spread; dmgLanded breaks ties toward bigger first hits.
        return (willKill ? 10 : 0) + reach * 3 + dmgLanded;
      };
      let best = enemyLanes[0];
      let bestScore = scoreStart(best);
      enemyLanes.forEach(l => {
        const s = scoreStart(l);
        if (s > bestScore) { bestScore = s; best = l; }
      });
      // If every candidate is -Infinity (all enemies evade/immune), fall
      // back to the old highest-HP heuristic — at least we don't crash.
      if (bestScore === -Infinity) {
        best = enemyLanes[0];
        enemyLanes.forEach(l => {
          const c = this.state.lanes[l][opp];
          const bc = this.state.lanes[best][opp];
          if (c && bc && c.currentHealth > bc.currentHealth) best = l;
        });
      }
      hitAndChain(best);
    } else {
      // targetSide defaults to `owner` in promptLaneChoice, which
      // highlights the PLAYER's lane slots — wrong for Vader's chain
      // since the click is supposed to pick an ENEMY card. Pass the
      // opponent explicitly so the UI glows the enemy row and clicks
      // land on the right targets.
      this.promptLaneChoice(owner, enemyLanes,
        "Vader's Chain — Pick Starting Target",
        `Choose any enemy card to start the ${startDmg}-damage chain`,
        (lane) => { hitAndChain(lane); },
        this.opponent(owner),
        null,    // previewCard not used for own-side placement
        startDmg // previewDamage — Vader's chain start hits for startDmg
      );
    }
  },

  // ===================== CARD INSTANCE =====================

  createCardInstance(def, owner) {
    // Defensive coercion — if a def arrives with NaN/undefined stats
    // (possible when a dead-pile entry was corrupted by an earlier
    // NaN propagation, or when summonCard is fed stale values from a
    // moved/swapped card), normalize to safe defaults so the new
    // instance can participate in combat without poisoning state.
    // Caught by the sim/test.js setter-based NaN tracer.
    const safeAtk = (typeof def.attack === 'number' && Number.isFinite(def.attack)) ? def.attack : 0;
    const safeHp  = (typeof def.health === 'number' && Number.isFinite(def.health) && def.health > 0) ? def.health : 1;
    const card = {
      id: nextCardId++,
      // Marker so drawCards can detect a pre-built card instance vs a
      // raw def — roguelite drives drawPile with pre-built instances.
      _isCardInstance: true,
      isEnvironment: !!def.isEnvironment,
      name: def.name, cost: def.actualCost || def.cost, baseCost: def.cost,
      attack: safeAtk, currentHealth: safeHp, maxHealth: safeHp,
      // Snapshot of the def's starting stats so the UI can tell at render
      // time whether the card is currently buffed or debuffed (attack and
      // maxHealth can drift from these via Luke/Magneto/Man-Bat/etc.).
      baseAttack: safeAtk, baseHealth: safeHp,
      abilities: [...(def.abilities || [])], type: def.type || 'neutral',
      // Pristine ability list captured at instance creation. Used by
      // handleDeath's dead-pile reset so a revived card comes back with
      // its original keywords (Loki's stolen ability gone, Ivy's
      // charm-derived buffs gone, etc.).
      baseAbilities: [...(def.abilities || [])],
      desc: def.desc || '', owner,
      evadeCharges: 0, armorValue: 0, invincibleTurns: 0,
      splashRange: 0, tauntTurns: 0,
      isOverdrive: false, isBullseye: false, immunityCharges: 0,
      unresistibleCharges: 0, hasHunt: false, hasDamageImmunity: false, isUntrickable: false,
      drawOnPlay: 0,
      isStunned: false, isFrozen: false, isFeared: false, isMindControlled: false,
        // Counter representation — drives stacking. Booleans above are
        // derived (true iff counter > 0) and synced by *Card methods +
        // round-tick. See "DEBUFF STACKING" comment block.
        stunnedTurns: 0, frozenTurns: 0, fearedTurns: 0,
      bonusAttack: false, hasResurrected: false, reviveCharges: 0,
      damageImmuneTurn: false,
      // Summon-chain attribution — _summonedBy points to the card whose
      // ability produced this one (Hela → zombies, Cyborg → Null, etc.).
      // _creditChain walks this chain so every ancestor inherits a
      // descendant's damage / absorbs / kills / energy-generated for MVP
      // scoring (per user spec: "full chain — every ancestor credited").
      // _drawnBy mirrors the same idea for hand cards pulled from the
      // dead pile (Hela's second effect) — if the drawn card is played,
      // its cost credits the drawer as energy generated.
      _summonedBy: null,
      _drawnBy: null,

      // Per-card stats, accumulated across the game — feed the victory
      // screen's 3 MVP component rows + the composite MVP row.
      //
      // Damage done components:
      //   statsHealthbarDamage  — damage this card landed on opponent HP
      //   statsEnemyDamage      — damage this card landed on enemy cards
      //
      // Damage absorbed — damage this card actively prevented from landing:
      //   Armor reducing/fully blocking a hit, Invincible/DamageImmunity,
      //   Evade (attacker's ATK value), Mr Freeze HP shield, Mahoraga
      //   redirect, and approximate freeze/stun prevention (min of the
      //   stunned enemy's ATK and the HP of what they would have hit).
      //
      // statsKills — count of enemy cards this card destroyed. MVP formula
      // adds +5 per kill on top of damage/absorb/energy sums.
      //
      // statsEnergyGenerated — currency this card contributed (Dr. Octopus
      // aura, Green Lantern's damage-to-energy conversion, etc.).
      statsHealthbarDamage: 0,
      statsEnemyDamage: 0,
      statsDamageAbsorbed: 0,
      // Tank stat — actual HP this card LOST to incoming damage (after
      // armor / evade / etc. have done their work). Drives roguelite
      // tank-XP: a card that ate 5 HP earns +5 XP whether it lived or
      // died, replacing the old flat "+10 if survived" bonus that
      // rewarded passive bench cards.
      statsHpTaken: 0,
      // v7 sabermetrics — per-prevention-type breakdown of damage
      // denied. Sum of these five = statsDamageAbsorbed. Surfaced in
      // the dashboard as discrete stat rows so the player can see
      // "what kind of defense did this card actually do?" rather than
      // a single rolled-up "absorbed N" total.
      statsAbsorbArmor: 0,         // armor value reduced/absorbed
      statsAbsorbInvincible: 0,    // Invincible / Damage Immunity negated
      statsAbsorbEvade: 0,         // evade charge ate a swing
      statsAbsorbRedirect: 0,      // Mahoraga / taunt took the hit
      statsAbsorbLockdown: 0,      // freeze/stun phantom-prevented attack
      statsAbsorbShield: 0,        // Mr. Freeze HP shield (one-shot HP-bar)
      // v3 instrumentation — three new fields that capture effects the
      // old formula couldn't see. Weighted into the Impact Index so
      // cards like Mr. Fantastic (discount aura), Dr. Manhattan (heal),
      // and Hawkeye (ATK debuff on splashed enemies) get credit.
      statsHealingDone: 0,      // HP healed to your own HP bar (healPlayer)
      statsDiscountValue: 0,    // Energy saved by cost reductions this card set/aura'd
      statsDebuffValue: 0,      // ATK/HP debuffs applied to enemies (Hawkeye, Kryptonite, etc.)
      // Card advantage — cards DRAWN because of this one (Draw N keyword
      // + Eye of Agamotto foresight + Mobius Chair if card-sourced, etc).
      // Counted as tempo value since each draw is a future play-option.
      statsCardAdvantage: 0,
      // Kill value — captures the WEIGHT of each kill, not just the count.
      // Damage tracking (statsEnemyDamage) undercounts cards that finish
      // off already-damaged enemies with direct-destroy effects (Gamora,
      // Ant-Man, Deathstroke, Kryptonite, devour). Kill value credits
      // `attack + maxHealth + baseCost` of the killed card, so removing a
      // 10-cost Galactus counts much more than removing a 1-cost token.
      statsKillValue: 0,
      // Action counters — not weighted into the headline Impact score,
      // just for the Stats detail modal so designers can see WHY a card
      // is ranking high (lots of kills? lots of freezes? big damage?).
      statsKills: 0,
      statsFreezesApplied: 0,
      statsStunsApplied: 0,
      statsFearsApplied: 0,
      statsMcApplied: 0,
      statsEnergyGenerated: 0,
      statsEnteredRound: null,
      statsLeftRound: null,
      onPlay: def.onPlay || null, onDeath: def.onDeath || null,
      onDamaged: def.onDamaged || null, onKill: def.onKill || null,
      onEvade: def.onEvade || null, onAllyKilled: def.onAllyKilled || null, onEnemyKilled: def.onEnemyKilled || null,
      onBeforeAttack: def.onBeforeAttack || null, onDamagePlayer: def.onDamagePlayer || null,
      onAnyCardPlayed: def.onAnyCardPlayed || null, onTurnStart: def.onTurnStart || null,
      onBeforeTricks: def.onBeforeTricks || null, onEndOfTurn: def.onEndOfTurn || null,
      onBeforeCombat: def.onBeforeCombat || null,
      onMoved: def.onMoved || null,
      onLaneResolved: def.onLaneResolved || null,
      // onAnyTrickPlayed — fires for every trick played by either
      // player, AFTER cleanupDead. Used by Darth Maul (passive
      // +2/+0 per trick). Dispatched from playTrick in game.js.
      onAnyTrickPlayed: def.onAnyTrickPlayed || null,
      beforeTricksFired: false,
      passive: def.passive || null,
      skipAutoUntrickable: !!def.skipAutoUntrickable,
      isDiscardEffect: def.isDiscardEffect || false, onDiscard: def.onDiscard || null,
      canDiscard: def.canDiscard || null,
      _neverPlayable: !!def._neverPlayable, // Iron Giant — hand-guard only, never placeable
      trickPhasePlayable: def.trickPhasePlayable || false,
      // Scarlet Witch: stats are unknown until she's placed. Her ATK/HP
      // copy the enemy directly opposite at play-time. While in hand
      // and on the draft, the renderer shows "?" instead of her base
      // 0/0. Cleared by her onPlay once she takes a stance.
      copiesOpposite: !!def.copiesOpposite,
      _grantedBuffs: null,
      _recurringBT: def._recurringBT || false,
    };
    this.applyAbilities(card);
    this.registerEntity(card);
    return card;
  },

  // Re-roll ATK for a Crazy / Insane card. Centralized so both the
  // onPlay spike and the per-turn re-roll share the same logic and
  // can't diverge. No-op for cards without either trait. Logs only
  // when the roll actually changes attack (cuts noise on the Joker
  // / Harley side when the same value is picked twice).
  rerollCrazyInsane(card) {
    if (!card || card.currentHealth <= 0) return;
    const before = card.attack;
    // INSANE always fires — Joker's intrinsic chaos isn't stoppable by
    // Fear. He keeps rolling 2-7 even when terrified.
    if (card.isInsane) {
      let r; do { r = 2 + Math.floor(this.rng() * 6); } while (r === card._lastInsaneRoll);
      card._lastInsaneRoll = r; card.attack = r;
      this.log(`  [INSANE] ${card.name} rolls ATK ${before} → ${r}`);
      return;
    }
    // CRAZY is suppressed by Fear. ATK stays at base for the duration;
    // the flag persists so the next reroll post-fear resumes Crazy
    // normally (intrinsic Harley regains her identity once fear ends,
    // Joker-stamped Crazy on enemies likewise resumes).
    if (card.isCrazy && !card.isFeared) {
      // STEADY etch — consumes one charge to cancel this reroll. ATK
      // reverts to base (or stays at base if it never moved). Roguelite-
      // only counterplay to Joker / Harley pressure. Stacks; once
      // hasSteady drops to 0, Crazy rerolls resume normally.
      if (card.hasSteady > 0) {
        card.hasSteady--;
        card.attack = card.baseAttack || card.attack;
        const left = card.hasSteady;
        this.log(`  [STEADY] ${card.name} negates Crazy reroll (${left} charge${left === 1 ? '' : 's'} left)`);
        return;
      }
      let r; do { r = 1 + Math.floor(this.rng() * 4); } while (r === card._lastCrazyRoll);
      card._lastCrazyRoll = r; card.attack = r;
      this.log(`  [CRAZY] ${card.name} rolls ATK ${before} → ${r}`);
    }
  },
  // Apply the Crazy trait to the target — marks the card so the
  // per-round re-roll sweeps re-roll its ATK 1-4, and rolls once
  // immediately so the new attack value shows this turn. Used by
  // Joker to CRAZY the highest-attack enemy.
  applyCrazyToCard(card) {
    if (!card || card.isCrazy || card.currentHealth <= 0) return;
    // Feared cards can't ALSO be Crazy. User direction (cross-mode):
    // "Crazy cannot be applied to feared enemies." Two reasons:
    //   1. Both flags hijack the card's combat target — Feared makes
    //      it attack its own ally; Crazy rerolls its ATK roll. Stacking
    //      them creates ambiguous "feared crazy" behavior with no
    //      coherent design intent.
    //   2. The application order is incidental: a card that's Feared
    //      first then Crazy'd second would behave differently than
    //      the reverse, breaking the "the user always sees the same
    //      result" rule.
    // Skip silently — Joker / Sandman flavor still fires on un-feared
    // cards in the same swing.
    if (card.isFeared || (card.fearedTurns || 0) > 0) return;
    card.isCrazy = true;
    card._crazyAppliedBy = true;
    // Snapshot the pre-Crazy ATK so it can be RESTORED if the source
    // (Joker) dies. User bug report 2026-05-19: "Joker died, but
    // Dormammu's stats stayed at whatever debuff he rolled for the
    // crazy. That's not how it works. He should now get his stats
    // back to what they were previously because he no longer has the
    // crazy status trait." The snapshot captures whatever the card's
    // current attack is (base + any pre-existing buffs), so the
    // restore goes back to exactly the value the player saw before
    // Crazy hijacked the orb. Joker.onDeath reads this and resets.
    card._preCrazyAttack = card.attack;
    this.rerollCrazyInsane(card);
  },

  // Sweep all living cards (hands + board) and coerce any NaN/undefined
  // stats back to safe bases. A catch-all that runs once per round — if
  // any of the sharper guards in buffCard/debuffCard/applyCombatDamage
  // miss a corruption path, the next round heals it silently instead of
  // letting the invariant drift.
  _sanitizeAllCards() {
    const fix = (c) => {
      if (!c) return;
      if (typeof c.attack        !== 'number' || !Number.isFinite(c.attack))        c.attack        = c.baseAttack || 0;
      if (typeof c.currentHealth !== 'number' || !Number.isFinite(c.currentHealth)) c.currentHealth = c.baseHealth || 1;
      if (typeof c.maxHealth     !== 'number' || !Number.isFinite(c.maxHealth))     c.maxHealth     = c.baseHealth || 1;
    };
    const s = this.state;
    if (!s) return;
    ['player', 'ai'].forEach(side => {
      (s[side].hand || []).forEach(fix);
    });
    (s.lanes || []).forEach(lane => {
      if (lane.player) fix(lane.player);
      if (lane.ai)     fix(lane.ai);
    });
  },

  // Apply a temporary buff that auto-expires after `duration` turns (default 1).
  // `buffs` is an object: numeric values are additive (+N), boolean values are
  // set-and-revert. Optional `source` tags each buff object with its granter's
  // id/name so a source-death handler can strip exactly the buffs that source
  // handed out (removeGrantedBuffsFromSource) without touching buffs from other
  // granters on the same target.
  // Example: G.grantTempBuff(ally, { attack: 2, maxHealth: 2, currentHealth: 2 }, 1, self)
  grantTempBuff(target, buffs, duration = 1, source) {
    if (!target || !buffs) return;
    if (this._trickBlocked(target)) return;
    if (!target._grantedBuffs) target._grantedBuffs = [];
    const sourceId = (source && source.id != null) ? source.id : null;
    const sourceName = (source && source.name) || null;
    Object.entries(buffs).forEach(([prop, value]) => {
      if (typeof value === 'boolean') {
        const prev = target[prop];
        target[prop] = value;
        target._grantedBuffs.push({ prop, prev, set: true, turnsLeft: duration, sourceId, sourceName });
      } else {
        target[prop] = (target[prop] || 0) + value;
        target._grantedBuffs.push({ prop, delta: value, turnsLeft: duration, sourceId, sourceName });
      }
    });
  },

  // Revert a single granted buff on `c`. Shared by the turn-based expiry AND
  // the source-death cleanup so the two unwind paths can never drift — one
  // definition of "how a buff comes back off".
  _revertGrantedBuff(c, b) {
    if (b.set) {
      // Boolean set-and-revert. If `prev` was captured as undefined (e.g. the
      // card was mid-creation or the prop wasn't yet initialized), restoring
      // undefined corrupts the stat. Coerce numeric stats back to safe bases.
      c[b.prop] = b.prev;
      if (b.prop === 'currentHealth' && (typeof c.currentHealth !== 'number' || !Number.isFinite(c.currentHealth))) c.currentHealth = c.baseHealth || 1;
      if (b.prop === 'maxHealth'     && (typeof c.maxHealth     !== 'number' || !Number.isFinite(c.maxHealth)))     c.maxHealth     = c.baseHealth || 1;
      if (b.prop === 'attack'        && (typeof c.attack        !== 'number' || !Number.isFinite(c.attack)))        c.attack        = c.baseAttack || 0;
    } else {
      c[b.prop] = (c[b.prop] || 0) - b.delta;
      if (b.prop === 'attack' || b.prop === 'evadeCharges' || b.prop === 'armorValue' || b.prop === 'splashRange') {
        c[b.prop] = Math.max(0, c[b.prop]);
      }
      if (b.prop === 'maxHealth') {
        // Ensure both maxHealth AND currentHealth survive the clamp
        // as finite numbers before the Math.min below is reached.
        if (typeof c.maxHealth !== 'number' || !Number.isFinite(c.maxHealth)) c.maxHealth = c.baseHealth || 1;
        if (typeof c.currentHealth !== 'number' || !Number.isFinite(c.currentHealth)) c.currentHealth = c.baseHealth || 1;
        c.currentHealth = Math.min(c.currentHealth, c.maxHealth);
      }
      if (b.prop === 'currentHealth') c[b.prop] = Math.max(0, c[b.prop]);
    }
  },

  // Decrement and expire granted temp buffs at end of turn.
  expireGrantedBuffs() {
    this.getAllCardsOnBoard().forEach(c => {
      if (!c._grantedBuffs || !c._grantedBuffs.length) return;
      c._grantedBuffs = c._grantedBuffs.filter(b => {
        b.turnsLeft--;
        if (b.turnsLeft > 0) return true;
        this._revertGrantedBuff(c, b);
        return false;
      });
    });
  },

  // Source-death cleanup — strip (and unwind) every granted buff a given source
  // card handed out, wherever it landed. A While-Active / "while I stand" buff
  // whose granter just left the board should not linger (the "stuck buff"
  // class). Only touches buffs tagged with this sourceId, so timed buffs from
  // OTHER granters on the same target are left to expire on their own clock.
  removeGrantedBuffsFromSource(sourceId) {
    if (sourceId == null) return;
    this.getAllCardsOnBoard().forEach(c => {
      if (!c._grantedBuffs || !c._grantedBuffs.length) return;
      c._grantedBuffs = c._grantedBuffs.filter(b => {
        if (b.sourceId !== sourceId) return true;
        this._revertGrantedBuff(c, b);
        return false;
      });
    });
  },

  applyAbilities(card) {
    (card.abilities || []).forEach(ab => {
      const parts = ab.split(' ');
      const name = parts[0];
      const n = parts.length > 1 ? parseInt(parts[parts.length - 1]) : null;
      switch (name) {
        case 'Armor': card.armorValue = Math.max(card.armorValue, n || 1); break;
        case 'Evade': card.evadeCharges = Math.max(card.evadeCharges, n || 1); break;
        case 'Taunt': card.tauntTurns = Math.max(card.tauntTurns, n || 99); break;
        case 'Invincible': card.invincibleTurns = Math.max(card.invincibleTurns, n || 1); break;
        case 'Splash': card.splashRange = Math.max(card.splashRange, n || 1); break;
        case 'Overdrive': card.isOverdrive = true; break;
        case 'Bullseye': card.isBullseye = true; break;
        case 'Immunity': card.immunityCharges = Math.max(card.immunityCharges, n || 1); break;
        case 'Unresistible': card.unresistibleCharges = Math.max(card.unresistibleCharges, n || 1); break;
        case 'Hunt': card.hasHunt = true; break;
        case 'Revive': card.reviveCharges = Math.max(card.reviveCharges, n || 1); break;
        case 'Untrickable': card.isUntrickable = true; card.permanentUntrickable = true; break;
        case 'Damage': if (parts[1] === 'Immunity') card.hasDamageImmunity = true; break;
        case 'Draw': card.drawOnPlay = Math.max(card.drawOnPlay || 0, n || 1); break;
        case 'Fear': card.hasFear = Math.max(card.hasFear || 0, n || 1); break; // When Played: Fear N the highest-ATK enemy
        case 'Crazy':  card.isCrazy  = true; break; // ATK re-rolls 1-4 each turn + onPlay
        case 'Insane': card.isInsane = true; break; // ATK re-rolls 2-7 each turn + onPlay
      }
    });
    // Auto-Untrickable: every 10-cost+ titan is trick-immune by default so
    // a cheap 1-cost trick can't nuke a 10-cost card. Flag is permanent —
    // buff-clear sweeps that wipe temporary Untrickable (abilities.js ~266
    // and ~608) leave permanent=true cards alone.
    if (!card.skipAutoUntrickable && (card.baseCost || card.cost || 0) >= 10) {
      card.isUntrickable = true;
      card.permanentUntrickable = true;
    }
  },

  // ===================== QUERIES =====================

  getEnemiesOf(owner, options) {
    // Base list — every living enemy. `options.source` and the
    // engine's `_inTrick` flag drive contextual filters so trick /
    // 10-cost abilities don't even SEE invalid targets in their
    // prompt lists.
    //
    // User direction 2026-05-19:
    //   "Untrickable should mean that any tricks, ally or enemy,
    //    should not be able to work or target the card. The card
    //    should not even be targetable from tricks."
    //   "for 10-cost abilities, they shouldn't target tens. You
    //    can't target tens with other tens abilities. So even if
    //    Galactus' devour doesn't work on Manhattan, you shouldn't
    //    even have the option to target Manhattan."
    //
    // Two filters layered on top of the base list:
    //   • In-trick path: drop every Untrickable enemy. The
    //     engine-side _trickBlocked guard already aborts effects
    //     mid-resolution, but several tricks (Phantom Zone,
    //     Eye of Agamotto, etc.) bypass it by calling
    //     removeFromLane / addToHand directly — pre-filtering
    //     prevents the player from picking the target at all,
    //     no matter what raw API the trick calls afterward.
    //   • source-10-cost path: when the caller passes its own
    //     instance via options.source AND that source is cost ≥10,
    //     drop every enemy that's also cost ≥10. Mirrors
    //     is10CostImmune so the "I can't even pick this" UX
    //     matches the "the effect refuses to land" engine guard.
    let list = this.getAllCardsOf(this.opponent(owner)).filter(c => !c.isEnvironment);
    if (this.state && this.state._inTrick) {
      list = list.filter(c => !c.isUntrickable && (c.skipAutoUntrickable || (c.baseCost || c.cost || 0) < 10));
    }
    if (options && options.source) {
      const srcCost = options.source.baseCost || options.source.cost || 0;
      if (srcCost >= 10) {
        // skipAutoUntrickable opts a card OUT of the titan class, so it stays
        // targetable by 10-costs. Doomsday prints at 12 but is a 1/1 that
        // scales DOWN — his protection is earned by his revive, not handed to
        // him by a printed cost. Without this the list dropped him and
        // Dormammu couldn't even offer to drain him.
        list = list.filter(c => c.skipAutoUntrickable || (c.baseCost || c.cost || 0) < 10);
      }
    }
    return list;
  },
  // getAlliesOf excludes environment cards so buffs/heals only reach combat cards.
  // Untrickable allies are still targetable by their OWNER'S tricks (friendly buffs land).
  // Only the 10-cost self-target block is kept here; enemy-side Untrickable filtering
  // lives in getEnemiesOf so cross-side trick attacks can't land on immune cards.
  getAlliesOf(owner) {
    let list = this.getAllCardsOf(owner).filter(c => !c.isEnvironment);
    if (this.state && this.state._inTrick) {
      list = list.filter(c => c.skipAutoUntrickable || (c.baseCost || c.cost || 0) < 10);
    }
    return list;
  },

  getAllCardsOf(owner) {
    const out = [];
    for (let i = 0; i < this.LANE_COUNT; i++) {
      const c = this.state.lanes[i][owner];
      if (c && c.currentHealth > 0) out.push(c);
      const e = this.state.lanes[i]._env && this.state.lanes[i]._env[owner];
      if (e) out.push(e);
    }
    return out;
  },

  getAllCardsOnBoard() {
    const out = [];
    for (let i = 0; i < this.LANE_COUNT; i++) {
      const l = this.state.lanes[i];
      if (l.player && l.player.currentHealth > 0) out.push(l.player);
      if (l.ai    && l.ai.currentHealth    > 0) out.push(l.ai);
      // Env slots get the same alive-filter as combat slots — a killed env
      // whose slot wasn't cleared must never keep receiving onTurnStart /
      // onAnyCardPlayed broadcasts (zombie Boiler Room kept burning cards).
      if (l._env) {
        if (l._env.player && l._env.player.currentHealth > 0) out.push(l._env.player);
        if (l._env.ai     && l._env.ai.currentHealth     > 0) out.push(l._env.ai);
      }
    }
    return out;
  },

  getAdjacentEnemiesInContext(l, owner) {
    const opp = this.opponent(owner);
    const out = [];
    if (l > 0 && this.state.lanes[l - 1][opp]) out.push(this.state.lanes[l - 1][opp]);
    if (l < this.LANE_COUNT - 1 && this.state.lanes[l + 1][opp]) out.push(this.state.lanes[l + 1][opp]);
    return out;
  },

  getOpenLanes(owner) {
    const out = [];
    for (let i = 0; i < this.LANE_COUNT; i++) if (!this.state.lanes[i][owner] && !this.state.lanes[i].destroyed) out.push(i);
    return out;
  },

  findCardLane(card) {
    for (let i = 0; i < this.LANE_COUNT; i++) {
      const l = this.state.lanes[i];
      if (l.player === card || l.ai === card) return i;
      if (l._env && (l._env.player === card || l._env.ai === card)) return i;
    }
    return -1;
  },

  // ===================== JUMP MECHANIC =====================

  // Check jump conditions after game events. trigger: 'trickPlayed', 'cardPlayed', 'allyDied'
  checkJumpConditions(trigger, data) {
    ['player', 'ai'].forEach(owner => {
      const opp = this.opponent(owner);
      // Track if a PLAYER-side jump just became available during this call
      // so combat can pause (via state.pendingJumpOffer) to give the player
      // time to play the card for free instead of the combat timeline
      // rolling past the window.
      let playerJumpNowReady = null;
      this.state[owner].hand.forEach(card => {
        if (card.jumpReady) return; // Already glowing
        if (card.name === 'Ghostface' && trigger === 'trickPlayed' && data.owner !== owner) {
          card.jumpReady = true;
          this.log(`  [JUMP] Ghostface senses a trick! Free play available.`);
          if (this.isHuman(owner)) playerJumpNowReady = card;
        }
        if (card.name === 'Michael Myers' && trigger === 'cardPlayed' && !data.isEnvironment && data.owner !== owner && data.cost < card.cost) {
          card.jumpReady = true;
          // Lock MM to the lane directly in front of the enemy card that triggered the jump
          card.jumpLane = data.laneIdx;
          this.log(`  [JUMP] Michael Myers senses weakness in lane ${data.laneIdx + 1}! Free play available.`);
          if (this.isHuman(owner)) playerJumpNowReady = card;
        }
        if (this.isCardKind(card, 'Stripe') && trigger === 'heroDamaged') {
          // "Either player's hero takes damage" — deliberately no owner
          // filter: your face or theirs, Stripe smells blood either way.
          card.jumpReady = true;
          this.log(`  [JUMP] Stripe smells blood! Free play available.`);
          if (this.isHuman(owner)) playerJumpNowReady = card;
        }
        if (card.name === 'Jason Voorhees' && trigger === 'allyDied' && data.owner === owner) {
          const tgtLane = (typeof data.laneIdx === 'number') ? data.laneIdx : undefined;
          // Don't offer jump into a destroyed lane (e.g. Anti-Life Equation / Darkseid Collapse)
          if (tgtLane !== undefined && this.state.lanes[tgtLane] && this.state.lanes[tgtLane].destroyed) return;
          card.jumpReady = true;
          card.jumpLane = tgtLane;
          const laneStr = card.jumpLane !== undefined ? ` in lane ${card.jumpLane + 1}` : '';
          this.log(`  [JUMP] Jason Voorhees rises to avenge${laneStr}! Free play available.`);
          if (this.isHuman(owner)) playerJumpNowReady = card;
        }
      });
      // A human-owned jump became ready — surface the "play free / skip"
      // modal IMMEDIATELY, in or out of combat. The old behavior only
      // prompted mid-combat and left out-of-combat jumps as a subtle glow
      // in hand, which players missed. User direction: "for all the jump
      // cards, make sure the prompts pop up — play the jump card or skip."
      // pendingJumpOffer counts as a pending prompt, so phase flow and the
      // combat timeline both wait for the choice before advancing.
      if (playerJumpNowReady && !this.state.pendingJumpOffer) {
        // Shim sets __HEADLESS_SIM; browser leaves it undefined.
        const inBrowser = typeof __HEADLESS_SIM === 'undefined';
        if (inBrowser) {
          this.state.pendingJumpOffer = { cardId: playerJumpNowReady.id };
          if (typeof UI !== 'undefined' && UI.render) UI.render();
        } else if (this.state._inCombat) {
          // Headless sim: no UI to resolve the modal → combat would stall
          // forever in whenPromptCleared. Auto-play the jump into the first
          // open lane (or clear the flag if no valid target).
          const card = playerJumpNowReady;
          const tgt = card.jumpLane !== undefined
            ? card.jumpLane
            : (this.getOpenLanes('player')[0] !== undefined ? this.getOpenLanes('player')[0] : -1);
          const validLane = tgt >= 0 && tgt < this.LANE_COUNT
            && !this.state.lanes[tgt].player
            && !this.state.lanes[tgt].destroyed;
          card.jumpReady = false;
          card.jumpLane = undefined;
          if (validLane) this.playCardFree('player', card, tgt);
        }
      }
      // AI-controlled seats auto-play jump-ready cards immediately (humans
      // click the glowing card themselves).
      if (!this.isHuman(owner)) {
        const jumpCards = this.state[owner].hand.filter(c => c.jumpReady);
        jumpCards.forEach(card => {
          let target;
          if (card.jumpLane !== undefined) {
            if (!this.state.lanes[card.jumpLane][owner] && !this.state.lanes[card.jumpLane].destroyed) {
              target = card.jumpLane;
            } else {
              card.jumpReady = false;
              card.jumpLane = undefined;
              this.log(`  [JUMP] ${card.name}'s target lane is blocked — jump cancelled.`);
              return;
            }
          } else {
            const open = this.getOpenLanes(owner);
            target = open.length ? open[0] : -1;
          }
          if (target >= 0) {
            card.jumpReady = false;
            card.jumpLane = undefined;
            this.playCardFree(owner, card, target);
          }
        });
      }
    });
  },

  // Play a jump card for free from hand. Does NOT consume energy and does NOT end the player's turn.
  playJumpCard(owner, card) {
    if (!card.jumpReady) return;
    // Guest: forward to host so the host runs promptLaneChoice authoritatively.
    // Running it locally creates a dangling 30-second timeout whose auto-pick
    // callback fires and places the card at open[0] (lowest lane) regardless
    // of which lane the guest clicked. The host's pendingLaneChoice → broadcast
    // → guest picks → promptResolve flow handles this cleanly instead.
    // _silentSim guard — see playCard: never forward from a preview clone.
    if (this.isMultiplayer() && this.mp && this.mp.role === 'guest' && owner === this.mp.you && !(this.state && this.state._silentSim)) {
      if (typeof Multiplayer !== 'undefined' && card && card.id != null) {
        Multiplayer.send({ t: 'playJump', cardId: card.id });
      }
      return;
    }
    // Jump clicks are undoable player decisions — snapshot BEFORE jumpReady
    // is consumed so an undo restores a still-jumpable card. Previously the
    // only boundary was the lane-choice resolve, which fired after the flag
    // was cleared: undo gave the card back but silently ate the jump.
    if (owner === 'player' && this.isPlayerTurn()) this.snapshot();
    // If the modal-driven jump offer referenced THIS card, clear it and
    // resume combat so the lane timeline continues after Jason lands.
    if (this.isHuman(owner) && this.state.pendingJumpOffer && this.state.pendingJumpOffer.cardId === card.id) {
      this.state.pendingJumpOffer = null;
      setTimeout(() => this.resumeCombatIfWaiting(), 0);
    }

    // If the card has a locked jumpLane (Michael Myers), use it directly — no choice prompt.
    if (card.jumpLane !== undefined) {
      const lockedLane = card.jumpLane;
      if (lockedLane >= 0 && lockedLane < this.LANE_COUNT
          && !this.state.lanes[lockedLane][owner]
          && !this.state.lanes[lockedLane].destroyed) {
        card.jumpReady = false;
        card.jumpLane = undefined;
        this.playCardFree(owner, card, lockedLane);
        UI.render();
        return;
      }
      // Locked lane is blocked — clear flags but do not allow free play
      card.jumpReady = false;
      card.jumpLane = undefined;
      this.log(`  [JUMP] ${card.name}'s target lane is blocked — jump cancelled.`);
      UI.render();
      return;
    }

    // Generic jump (Ghostface, Jason Voorhees) — let player pick any open lane
    card.jumpReady = false;
    const open = this.getOpenLanes(owner);
    if (!open.length) return;
    if (this.isHuman(owner) && open.length > 1) {
      this.promptLaneChoice(owner, open, `Jump: ${card.name}`, `Choose lane for ${card.name} (FREE)`, (lane) => {
        this.playCardFree(owner, card, lane);
        UI.render();
      });
    } else if (open.length) {
      this.playCardFree(owner, card, open[0]);
    }
    UI.render();
  },

  // ===================== MAGNETO WHILE ACTIVE =====================

  applyMagnetoDebuffs() {
    // Legacy name — every historical call site (moveCard, summonCard,
    // startRound, Magneto's own On Play) routes into the generic aura
    // reconcile, which also owns Luke's aura.
    this.recomputeAuras();
  },

  removeMagnetoDebuffs(magnetoOwner) {
    // Legacy name — killCard zeroes health before calling this, so the
    // reconcile already sees the dead Magneto and lifts his aura.
    this.recomputeAuras();
  },

  // ===================== AURA RECOMPUTE =====================
  // Studio-style stat reconciliation. Instead of each aura stamping flags on
  // its targets and trying to unwind them on every move/death (the bug family
  // behind stuck +1/+1s and phantom sheds), the board's TOTAL aura
  // contribution per card is recomputed from live sources and diffed against
  // what's recorded on the card (_auraAtk/_auraHp). Only the difference is
  // applied — and the record tracks what MEASURABLY landed, so a card that
  // shrugs a debuff (Invincible, trick-block, 0-ATK floor) never later
  // "sheds" a stat it never lost; the aura simply retries while the shield
  // holds and lands when it drops. Sources today: Magneto's parity aura and
  // Luke's ±aura (stacks per living Luke, Text+ sized via _lukeAuraSize).
  // The Gremlin swarm keeps its own additive bookkeeping by design — its
  // buff is permanent-per-arrival, not a While Active aura.
  recomputeAuras() {
    const s = this.state;
    if (!s || !s.lanes) return;
    // Re-entrancy: an aura kill mid-pass can fire onDeath → summon →
    // applyMagnetoDebuffs. Queue a follow-up pass instead of nesting so two
    // passes never interleave their measurements.
    if (this._recomputingAuras) { this._auraRecomputeQueued = true; return; }
    this._recomputingAuras = true;
    try {
      do {
        this._auraRecomputeQueued = false;
        this._recomputeAurasPass();
      } while (this._auraRecomputeQueued);
    } finally {
      this._recomputingAuras = false;
    }
  },

  _recomputeAurasPass() {
    const s = this.state;
    const live = [];
    for (let i = 0; i < this.LANE_COUNT; i++) {
      const l = s.lanes[i];
      ['player', 'ai'].forEach(side => {
        const c = l && l[side];
        if (c && c.currentHealth > 0 && !c.isEnvironment) live.push({ card: c, lane: i, side });
      });
    }
    // One-time migration of pre-recompute stamp flags (mid-match update or a
    // resumed save): fold each legacy flag into the recorded aura state so
    // the diff below doesn't double-apply on first contact.
    live.forEach(({ card: c }) => {
      if (c._magnetoDebuffed) { c._auraAtk = (c._auraAtk || 0) - 1; c._auraHp = (c._auraHp || 0) - 1; delete c._magnetoDebuffed; }
      if (c._magnetoBuffed)   { c._auraAtk = (c._auraAtk || 0) + 1; c._auraHp = (c._auraHp || 0) + 1; delete c._magnetoBuffed; }
      if (c._lukeBuff)        { c._auraAtk = (c._auraAtk || 0) + 1; c._auraHp = (c._auraHp || 0) + 1; delete c._lukeBuff; }
      if (c._lukeDebuff)      { c._auraAtk = (c._auraAtk || 0) - 1; c._auraHp = (c._auraHp || 0) - 1; delete c._lukeDebuff; }
    });
    // Desired NET aura per card from every living source.
    const want = new Map(); // card -> {atk, hp, hostile, src}
    const add = (card, atk, hp, hostile, src) => {
      const w = want.get(card) || { atk: 0, hp: 0, hostile: false, src: null };
      w.atk += atk; w.hp += hp;
      if (hostile) { w.hostile = true; w.src = w.src || src; }
      want.set(card, w);
    };
    ['player', 'ai'].forEach(owner => {
      // — Magneto's parity aura: enemies in even lanes -1/-1, own allies in
      //   odd lanes +1/+1 (himself included). One per side, matching the
      //   original find() semantics.
      const magneto = live.find(e => e.side === owner && this.isCardKind(e.card, 'Magneto'));
      if (magneto) {
        live.forEach(({ card: c, lane, side }) => {
          const even = (lane + 1) % 2 === 0;
          if (side !== owner && even) add(c, -1, -1, true, magneto.card);
          if (side === owner && !even) add(c, 1, 1, false, magneto.card);
        });
      }
      // — Luke's aura: allies +N/+N, enemies -N/-N. Stacks per living Luke
      //   (the old stamp flags collided when two Lukes shared a board).
      live.filter(e => e.side === owner && this.isCardKind(e.card, 'Luke Skywalker')).forEach(({ card: luke }) => {
        const size = luke._lukeAuraSize || 1;
        live.forEach(({ card: c, side }) => {
          if (c === luke) return;
          if (side === owner) add(c, size, size, false, luke);
          else add(c, -size, -size, true, luke);
        });
      });
    });
    // Reconcile: apply only the measured difference.
    live.forEach(({ card: c }) => {
      const w = want.get(c) || { atk: 0, hp: 0, hostile: false, src: null };
      let dAtk = w.atk - (c._auraAtk || 0);
      const dHp = w.hp - (c._auraHp || 0);
      // Crazy owns the ATK stat (re-rolled each round, restored from
      // _preCrazyAttack — which froze WITH the recorded aura inside it).
      // Leave both the stat and the record alone until the stamp lifts;
      // the diff trues it up automatically on the next pass after restore.
      if (c.isCrazy) dAtk = 0;
      if (!dAtk && !dHp) return;
      const beforeAtk = c.attack, beforeMax = c.maxHealth;
      if (dAtk > 0 || dHp > 0) this.buffCard(c, Math.max(0, dAtk), Math.max(0, dHp));
      if ((dAtk < 0 || dHp < 0) && c.currentHealth > 0) {
        this.debuffCard(c, Math.max(0, -dAtk), Math.max(0, -dHp), w.hostile, w.src || { name: 'an aura' });
      }
      const landedAtk = c.attack - beforeAtk;
      const landedHp = c.maxHealth - beforeMax;
      if (!c.isCrazy) c._auraAtk = (c._auraAtk || 0) + landedAtk;
      c._auraHp = (c._auraHp || 0) + landedHp;
      if (landedAtk || landedHp) {
        const fmt = n => (n > 0 ? `+${n}` : `${n}`);
        this.log(`  [AURA] ${c.name} ${fmt(landedAtk)}/${fmt(landedHp)}`);
      }
    });
  },

  // ===================== UNDO / SNAPSHOT API =====================

  // Custom deep clone that preserves function references (which point at the
  // shared CARD_DEFS / TRICK_DEFS / CARD_ABILITIES tables) and maintains object
  // identity via a `seen` map (so a card on the board and the same reference in
  // `pendingCardChoice.cards` resolve to the same cloned object after restore).
  cloneStateDeep(obj, seen) {
    if (obj === null || typeof obj !== 'object') return obj; // primitives + functions
    if (!seen) seen = new Map();
    if (seen.has(obj)) return seen.get(obj);
    if (Array.isArray(obj)) {
      const out = [];
      seen.set(obj, out);
      for (const v of obj) out.push(this.cloneStateDeep(v, seen));
      return out;
    }
    const out = {};
    seen.set(obj, out);
    for (const k in obj) out[k] = this.cloneStateDeep(obj[k], seen);
    return out;
  },

  // Capture the current state and push it onto the undo history.
  // No-op if there's no state yet or if the game is over.
  // DISABLED IN MULTIPLAYER — undo is a purely local state restore: the
  // host rolling back never re-broadcast, and a guest rollback is clobbered
  // by the next host push, so one side rewound while the other didn't
  // (user report: "the opponent clicked undo and the entire turn reset for
  // him, but for me it stayed the same and glitched the game out"). Online
  // 1v1 has no undo, same as every competitive TCG — skipping snapshots
  // also saves a deep state clone on every play.
  snapshot() {
    if (!this.state || this.state.gameOver) return;
    if (this.isMultiplayer()) return;
    if (this.history.length >= this.HISTORY_LIMIT) this.history.shift();
    this.history.push(this.cloneStateDeep(this.state));
  },

  // Restore the most recent snapshot. Returns true if anything was restored.
  undo() {
    if (this.isMultiplayer()) return false; // no undo in online play — see snapshot()
    if (!this.history.length) return false;
    if (!this.isPlayerTurn()) return false; // safety: undo is a player-turn action
    // Abuse prevention — cancel any live prompt timer + deadline before the
    // restore so a stale timer from the snapshot can't linger.
    this._clearPromptTimeout();
    this._promptQueue = [];   // queued arms closure over pre-undo card objects
    this._stackClear('undo'); // queued deaths closure over pre-undo card objects
    const snap = this.history.pop();
    this.state = snap;
    // The restored snapshot holds a fresh set of card OBJECTS — reindex so
    // findCard resolves ids to the post-undo instances, not the pre-undo
    // ones (same duplicate-Ahsoka class the prompt/stack purges guard).
    this.rebuildEntityIndex();
    // Also wipe any deadline that may have been in the snapshot itself.
    this.state._promptDeadline = null;
    // Stale-closure purge — a prompt or parked continuation inside a
    // snapshot closes over the ORIGINAL timeline's live objects
    // (cloneStateDeep passes functions through untouched). Resolving one
    // after a restore replays foreign card objects into this state — the
    // duplicate-Ahsoka class. No prompt survives an undo, period.
    this.state.pendingLaneChoice = null;
    this.state.pendingCardChoice = null;
    this.state.pendingBlockTrick = null;
    this.state.pendingKangChoice = null;
    this.state.pendingJumpOffer = null;
    this.state.pendingTimeStoneIntercept = null;
    delete this.state._combatContinuation;
    this.log('[UNDO] Reverted to previous action');
    UI.render();
    return true;
  },

  // Clear all snapshots — called at the start of each new player sub-phase.
  clearHistory() {
    this.history = [];
  },

  // True when the player is in one of their own action sub-phases.
  isPlayerTurn() {
    if (!this.state) return false;
    const p = this.state.phase;
    return p === 'player-cards' || p === 'player-cards-tricks' || p === 'player-tricks';
  },

  // ===================== LANE-OUTCOME SIMULATION =====================
  //
  // PURE-FUNCTION simulation of a single lane's combat. Operates only on
  // shallow snapshots of the card objects involved — never writes to
  // live state, never calls UI/setTimeout/log/Game.*, never recurses
  // through the combat resolver. This is the safe replacement for the
  // arithmetic heuristic the renderer used for death-skull / HP-after
  // previews.
  //
  // The previous "full simulator" attempt (Game.previewPlay) broke real
  // play because it cloned + ran resolveCombat (which fires setTimeouts,
  // UI calls, and chained ability hooks). This version trades some
  // depth-of-coverage for absolute safety:
  //
  //   • Covered: ATK swings (simultaneous), Armor / Evade / Invincible /
  //     Damage Immunity, Bullseye-vs-Evade, Splash from front + adjacent
  //     enemies, Stun / Freeze gating outgoing swings.
  //   • Not covered (yet): onDamaged retaliation chains (Wolverine), Wonder
  //     Woman lasso chain, Obi-Wan reflect, Hulk on-play splash setup,
  //     mid-combat trick interactions.
  //   • If a not-yet-covered case mispredicts in a way the user notices,
  //     the fix is to add the specific math here, NOT to re-introduce
  //     the full-engine simulator.
  //
  // Returns: { player: { hpAfter, dies, dmgIn }, ai: { hpAfter, dies, dmgIn } }
  // OR null when the lane is empty / destroyed.
  // Snapshot the fields that affect combat math. Plain object copy —
  // never returns a reference to the live card. Exposed so the UI's
  // damage-preview can build snaps for hypothetical (in-hand) cards.
  // Forward to engine/combat.js — single source of truth for the
  // snap shape used by predictors. See engine/combat.js header for
  // the full Phase 1 extraction rationale.
  _snapForPredict(c) {
    return CombatEngine.snapCard(c);
  },

  // Forward to engine/combat.js — single source of truth for the
  // swing-forward gate.
  _canSwingForward(c) {
    return CombatEngine.canSwingForward(c);
  },

  // hypothetical: optional `{ player?: snap, ai?: snap }` — replaces the
  // matching side's snap before running the prediction. Used by the
  // damage-preview when previewing a card-in-hand: pass the projected
  // card stats as `hypothetical.player`. Adjacent splash is still read
  // from the live state.
  predictLaneOutcome(laneIdx, hypothetical) {
    if (!this.state || !this.state.lanes) return null;
    const lane = this.state.lanes[laneIdx];
    if (!lane || lane.destroyed) return null;
    if (!lane.player && !lane.ai && !(hypothetical && (hypothetical.player || hypothetical.ai))) return null;

    const snap = (c) => this._snapForPredict(c);

    const p = (hypothetical && hypothetical.player) ? hypothetical.player : snap(lane.player);
    const a = (hypothetical && hypothetical.ai)     ? hypothetical.ai     : snap(lane.ai);

    // Local damage applier — operates ONLY on the snapshot. Returns the
    // amount that actually landed after Armor / Evade / Invincible.
    // Mirrors live-combat dodge rule (game.js:~2596): a stunned/frozen
    // target CANNOT consume an evade charge — they can't react.
    const applyHit = (tgt, raw, attacker) => {
      if (!tgt || tgt.currentHealth <= 0 || raw <= 0) return 0;
      // Mirror the live resolver's absorb policy (applyCombatDamage):
      // Invincible/Immunity absorb for free; Evade consumes a charge. A
      // stunned/frozen target can't dodge, and only an ignoresEvade attacker
      // (Jaws) pierces Evade — Bullseye does NOT (it only bypasses the block
      // meter on face hits).
      const canEvade = !tgt.isStunned && !tgt.isFrozen && !(attacker && attacker.ignoresEvade);
      const absorb = this._classifyAbsorb(tgt, canEvade);
      if (absorb) { if (absorb === 'evade') tgt.evadeCharges--; return 0; }
      let dmg = raw;
      // Yoda shield — target's side takes half combat damage (rounded up).
      if (this.state._yodaShieldFor && this.state._yodaShieldFor[tgt.owner] > 0) dmg = Math.ceil(dmg / 2);
      // Palpatine passive — a frozen target takes DOUBLE damage when the
      // attacker's side fields an active doubleFrozenDamage card.
      if (tgt.isFrozen && attacker && this.getAllCardsOf(attacker.owner).some(
            c => c.passive === 'doubleFrozenDamage' && c.currentHealth > 0)) {
        dmg *= 2;
      }
      const landed = (attacker && attacker.ignoresArmor) ? Math.max(0, dmg) : Math.max(0, dmg - tgt.armorValue);
      tgt.currentHealth -= landed;
      return landed;
    };

    // Track incoming totals separately for the renderer's tooltip text.
    let pDmgIn = 0, aDmgIn = 0;

    // Snapshot pre-swing ATKs — both swings happen "simultaneously",
    // so a card that dies in this exchange still gets to swing.
    // _canSwingForward gates: stunned/frozen can't swing at all;
    // feared/mind-controlled swing at own side (zero forecast damage
    // to the opposing lane).
    const pCanSwing = this._canSwingForward(p);
    const aCanSwing = this._canSwingForward(a);
    const pAtk = pCanSwing ? p.attack : 0;
    const aAtk = aCanSwing ? a.attack : 0;
    const pSplash = pCanSwing ? p.splashRange : 0;
    const aSplash = aCanSwing ? a.splashRange : 0;

    // Step 0 (PRE-SPLASH from LEFT adjacent): real combat resolves
    // lanes left-to-right, so the splash from idx-1's stepFinish lands
    // on idx's cards BEFORE idx's front-on-front swing happens. This
    // can KILL the front cards before their own swing, turning what
    // looks like a TRADE into a WIN/LOSE. Concrete case the user hit:
    // Yoda (Splash 4) in lane 3 + Kang (1 HP) + Venom in lane 4 →
    // lane 3 resolves, Yoda splash kills Kang, lane 4 becomes
    // uncontested → Venom strikes face. Without this step the
    // forecast counts Kang's swing landing on Venom and reads TRADE.
    // Right-adjacent (idx+1) splash is handled as POST below since
    // those lanes resolve AFTER this one — their splash adds damage
    // but doesn't prevent THIS lane's front swing.
    const leftAdj = laneIdx > 0 ? this.state.lanes[laneIdx - 1] : null;
    if (leftAdj) {
      if (p) {
        const e = leftAdj.ai;
        if (e && e.currentHealth > 0 && (e.splashRange | 0) > 0
            && !e.isStunned && !e.isFrozen && !e.isFeared && !e.isMindControlled) {
          pDmgIn += applyHit(p, e.splashRange | 0, e);
        }
      }
      if (a) {
        const e = leftAdj.player;
        if (e && e.currentHealth > 0 && (e.splashRange | 0) > 0
            && !e.isStunned && !e.isFrozen && !e.isFeared && !e.isMindControlled) {
          aDmgIn += applyHit(a, e.splashRange | 0, e);
        }
      }
    }

    // Step 1: front-on-front swings (only when BOTH cards are still
    // ALIVE after pre-splash). SEMANTICS: pDmgIn = damage incoming to
    // the PLAYER side, aDmgIn = damage incoming to the AI side. So the
    // AI's swing (aAtk) lands on p (player) → adds to pDmgIn. Player's
    // swing (pAtk) lands on a (AI) → adds to aDmgIn. If pre-splash from
    // step 0 already killed one or both, the front swing doesn't fire
    // — real combat skips contested-lane resolution when one side is
    // already dead before the lane starts.
    if (p && a && p.currentHealth > 0 && a.currentHealth > 0) {
      pDmgIn += applyHit(p, aAtk, a);   // AI's swing damages player
      aDmgIn += applyHit(a, pAtk, p);   // Player's swing damages AI
    }

    // Step 2: own-lane splash from each side (splash also lands on the
    // front enemy in the same lane). Skipped when the splasher's front
    // didn't get to swing (already-dead from pre-splash → no swing →
    // no splash). The pre-step pre-emptively zeroes pSplash/aSplash
    // for status-locked cards already, but not for "killed by left-adj
    // splash" — hence the explicit alive-gate via the swing condition.
    if (p && p.currentHealth > 0 && pSplash > 0 && a) { aDmgIn += applyHit(a, pSplash, p); }
    if (a && a.currentHealth > 0 && aSplash > 0 && p) { pDmgIn += applyHit(p, aSplash, a); }

    // Step 3 (POST-SPLASH from RIGHT adjacent): idx+1's lane resolves
    // AFTER this lane, so its splash lands AFTER this lane's outcome
    // is decided. It still adds damage that can flip pDies/aDies, but
    // it doesn't prevent step 1's swings (those already happened).
    const rightAdj = laneIdx < this.LANE_COUNT - 1 ? this.state.lanes[laneIdx + 1] : null;
    if (rightAdj) {
      if (p) {
        const e = rightAdj.ai;
        if (e && e.currentHealth > 0 && (e.splashRange | 0) > 0
            && !e.isStunned && !e.isFrozen && !e.isFeared && !e.isMindControlled) {
          pDmgIn += applyHit(p, e.splashRange | 0, e);
        }
      }
      if (a) {
        const e = rightAdj.player;
        if (e && e.currentHealth > 0 && (e.splashRange | 0) > 0
            && !e.isStunned && !e.isFrozen && !e.isFeared && !e.isMindControlled) {
          aDmgIn += applyHit(a, e.splashRange | 0, e);
        }
      }
    }

    return {
      player: p ? {
        hpAfter: Math.max(0, p.currentHealth),
        dies: p.currentHealth <= 0,
        dmgIn: pDmgIn,
      } : null,
      ai: a ? {
        hpAfter: Math.max(0, a.currentHealth),
        dies: a.currentHealth <= 0,
        dmgIn: aDmgIn,
      } : null,
    };
  },

  // ===================== GLOBAL COMBAT PREDICTOR =====================
  // predictLaneOutcome runs per-lane and misses cross-lane Taunt
  // redirection: a Brute with Taunt 1 will soak damage from OTHER lanes'
  // enemy attacks, which the per-lane predictor never sees. The result is
  // missing death-skull badges on cards that the engine will actually
  // kill via redirected hits. This function runs all 6 lanes in a single
  // pass with shared snapshot state so taunt redirects are accounted for.
  // User report: "the death skulls are a little bugged because brute in
  // lane 1 will die yet has no death skull."
  //
  // Returns { byId: Map<id, {hpAfter, dmgIn, dies}> }. Looked up by
  // rendering for the per-card incoming-damage badge.
  predictCombatGlobal() {
    const out = new Map();
    if (!this.state || !this.state.lanes) return { byId: out };

    // Snapshot every living card. We track effective HP, accumulated
    // dmgIn, mutable evade charges, and a back-ref to the live card so
    // we can read static stats (armor, status, isBullseye) without
    // mutating live state.
    const snap = new Map();
    for (let i = 0; i < this.LANE_COUNT; i++) {
      const lane = this.state.lanes[i];
      if (!lane || lane.destroyed) continue;
      ['player', 'ai'].forEach(side => {
        const c = lane && lane[side];
        if (c && c.currentHealth > 0) {
          snap.set(c.id, {
            ref: c, owner: c.owner, lane: i,
            hp: c.currentHealth, dmgIn: 0,
            evade: c.evadeCharges | 0,
          });
        }
      });
    }

    const canHitEnemy = this._canSwingForward.bind(this);

    // applyHit handles taunt redirect → evade → armor → HP. The first
    // taunter on the target's side that ISN'T the target absorbs the
    // hit, mirroring live combat's `getAllCardsOf().find()` lookup.
    const applyHit = (targetCard, raw, attackerIgnoresEvade) => {
      if (!targetCard || raw <= 0) return 0;
      let final = snap.get(targetCard.id);
      if (!final || final.hp <= 0) return 0;
      // Taunt redirection — pick the first non-target taunter by lane order.
      const owner = targetCard.owner;
      let taunterPick = null;
      let taunterPickLane = Infinity;
      snap.forEach(s => {
        if (s.owner !== owner) return;
        if (s.id === targetCard.id) return;
        if (!s.ref.tauntTurns || s.ref.tauntTurns <= 0) return;
        if (s.hp <= 0) return;
        if (s.lane < taunterPickLane) {
          taunterPick = s;
          taunterPickLane = s.lane;
        }
      });
      if (taunterPick) final = taunterPick;
      // After possible redirect, re-check for kill-block defenses.
      if (final.ref.invincibleTurns > 0 || final.ref.hasDamageImmunity) return 0;
      const canDodge = !final.ref.isStunned && !final.ref.isFrozen;
      // Evade is only pierced by an ignoresEvade attacker — NOT by Bullseye.
      // (Real combat gates on attacker.ignoresEvade at ~line 4048; this used to
      // pass isBullseye, so a Bullseye attacker like Spawn wrongly cancelled an
      // Evade defender's dodge and the lane read TRADE instead of WIN.)
      if (canDodge && final.evade > 0 && !attackerIgnoresEvade) { final.evade--; return 0; }
      const landed = Math.max(0, raw - (final.ref.armorValue | 0));
      final.hp -= landed;
      final.dmgIn += landed;
      return landed;
    };

    // For each lane in left-to-right order: pre-splash from left adj,
    // front-on-front swings, own-lane splash. Right-adjacent splash is
    // handled implicitly by the next lane's "left-adjacent" step.
    for (let i = 0; i < this.LANE_COUNT; i++) {
      const lane = this.state.lanes[i];
      if (!lane || lane.destroyed) continue;
      const p = lane.player, a = lane.ai;

      // Step 0: pre-splash from left adj (only when this lane has cards
      // that could be hit).
      if (i > 0) {
        const left = this.state.lanes[i - 1];
        if (left && !left.destroyed) {
          if (left.ai && (left.ai.splashRange | 0) > 0 && canHitEnemy(left.ai) && p) {
            applyHit(p, left.ai.splashRange | 0, !!left.ai.ignoresEvade);
          }
          if (left.player && (left.player.splashRange | 0) > 0 && canHitEnemy(left.player) && a) {
            applyHit(a, left.player.splashRange | 0, !!left.player.ignoresEvade);
          }
        }
      }

      // Step 1: front-on-front (simultaneous — snapshot ATK first).
      const pSnap = snap.get(p && p.id);
      const aSnap = snap.get(a && a.id);
      if (pSnap && aSnap && pSnap.hp > 0 && aSnap.hp > 0) {
        const pAtk = canHitEnemy(p) ? (p.attack | 0) : 0;
        const aAtk = canHitEnemy(a) ? (a.attack | 0) : 0;
        applyHit(p, aAtk, !!a.ignoresEvade);
        applyHit(a, pAtk, !!p.ignoresEvade);
      }

      // Step 2: own-lane splash.
      if (pSnap && pSnap.hp > 0 && (p.splashRange | 0) > 0 && a) {
        applyHit(a, p.splashRange | 0, !!p.ignoresEvade);
      }
      if (aSnap && aSnap.hp > 0 && (a.splashRange | 0) > 0 && p) {
        applyHit(p, a.splashRange | 0, !!a.ignoresEvade);
      }
    }

    // Build the result map keyed by card id.
    snap.forEach(s => {
      out.set(s.ref.id, {
        hpAfter: Math.max(0, s.hp),
        dmgIn: s.dmgIn,
        dies: s.hp <= 0,
      });
    });
    return { byId: out };
  },

  // ===================== PLACEMENT PREVIEW (safe onPlay sim) =====================
  // Like predictLaneOutcome but RUNS the card's onPlay first against a
  // deep-clone of state, so the prediction reflects abilities + buffs +
  // debuffs the placement would actually trigger. Hulk's onPlay damages
  // all enemies → preview shows post-damage HPs. Cap's onPlay buffs an
  // ally → preview shows the ally with its boosted stats. Storm freezes
  // enemies → frozen ones don't swing in the prediction.
  //
  // CRITICALLY: this does NOT call resolveCombat. The previous full-sim
  // attempt (Game.previewPlay below) ran combat too, which fires a swarm
  // of side effects (death hooks, lane-resolved hooks, post-combat ticks)
  // that even with UI stubbing leaked back into real state on edge cases.
  // We run ONLY the placement (cost deducted on the clone, onPlay fired,
  // aura sweep, drawOnPlay) and then read off predictLaneOutcome for
  // every lane on the modified clone state. Combat math is the pure
  // arithmetic predictor — no engine state mutation.
  //
  // Args: side ('player'|'ai'), cardId (number), laneIdx (0-5).
  // Returns: array of 6 per-lane outcome objects (same shape as
  //   predictLaneOutcome), or null on failure (caller falls back to
  //   the static placement preview).
  previewPlacement(side, cardId, laneIdx) {
    if (!this.state || this.state.gameOver) return null;
    if (!this.cloneStateDeep) return null;
    if (laneIdx == null || laneIdx < 0 || laneIdx >= this.LANE_COUNT) return null;
    const origState = this.state;
    const origSetTimeout = (typeof window !== 'undefined') ? window.setTimeout : null;
    const savedUI = {};
    let result = null;
    try {
      const clone = this.cloneStateDeep(origState);
      clone._silentSim = true;
      this.state = clone;
      // Stub UI so any render / animation / SFX call inside the
      // placement chain becomes a no-op. The const binding can't be
      // replaced; we patch known method keys and restore in finally.
      if (typeof UI !== 'undefined') {
        const noop = () => {};
        const STUB_KEYS = [
          'render', 'showPhaseBanner', 'showLaneRecap', 'showRoundSummary',
          'showGameOverScreen', 'animateStatChanges', 'flashLanes',
          'flashUnaffordable', 'showFloatingPrompt', 'showCardChoice',
          'showLaneChoice', 'launchVictoryConfetti', 'stopVictoryConfetti',
          'startPromptCountdown', 'stopPromptCountdown', 'spawnLandingBurst',
          'pulseHpEdge', 'killingBlowCinema', 'hitPause', 'showFearPrompt',
          'showMindControlPrompt', 'showBlockTrickPrompt', 'closeAllPrompts',
          'showAITrickToast', 'spawnDestroyParticles', 'animateCountUp',
          'showDamageFloats', 'spawnBlockSpark', '_hideHoverMagnify',
        ];
        STUB_KEYS.forEach(k => {
          if (k in UI) { savedUI[k] = UI[k]; UI[k] = noop; }
        });
        // SFX subsystem — proxy so any method call returns null.
        if (UI.sfx) {
          savedUI._sfx = UI.sfx;
          UI.sfx = new Proxy(UI.sfx, {
            get(t, p) { const v = t[p]; return typeof v === 'function' ? () => null : v; }
          });
        }
      }
      // Override setTimeout so engine pacing fires synchronously inside
      // the sim. Combat-pacing setTimeouts collapse to immediate; that's
      // safe because we don't run combat. The autopick timeout used by
      // promptCardChoice / promptLaneChoice ALSO fires sync — meaning
      // any prompt the card raises during onPlay auto-resolves to its
      // AI-picker default (or the first option). Imperfect but better
      // than no preview, and consistent with how the AI side resolves
      // its own prompts.
      if (typeof window !== 'undefined' && origSetTimeout) {
        window.setTimeout = (fn) => { try { if (typeof fn === 'function') fn(); } catch (e) {} return 0; };
      }
      // Apply the play. playCard handles cost deduction (on the clone),
      // placement, onPlay hook, draw-on-play keyword, aura sweep.
      const card = (clone[side] && clone[side].hand || []).find(c => c.id === cardId);
      if (!card) throw new Error('hypothetical card not in hand');
      const ok = this.playCard(side, card, laneIdx);
      if (!ok) throw new Error('playCard returned false in sim');
      // Read out per-lane predictions on the post-play clone state.
      const lanes = [];
      for (let i = 0; i < this.LANE_COUNT; i++) {
        let r = null;
        try { r = this.predictLaneOutcome(i); } catch (e) { /* swallow */ }
        lanes.push(r);
      }
      result = {
        lanes,
        // Surface the post-onPlay lane the card landed in for UI display.
        placedLane: laneIdx,
        // Game-over check — onPlay can drain HP via direct face damage.
        gameOver: !!clone.gameOver,
      };
    } catch (e) {
      result = null;
    } finally {
      this.state = origState;
      if (typeof UI !== 'undefined') {
        for (const k in savedUI) {
          if (k === '_sfx') UI.sfx = savedUI[k];
          else UI[k] = savedUI[k];
        }
      }
      if (typeof window !== 'undefined' && origSetTimeout) {
        window.setTimeout = origSetTimeout;
      }
    }
    return result;
  },

  // ===================== SIMULATION-BASED PREVIEW =====================
  //
  // Runs ONE round forward against a deep-clone of the current state with
  // a hypothetical card play applied first, then reads out the predicted
  // HP for every card and both players. This is the foundation for the
  // damage-preview feature — instead of static arithmetic that misses
  // ability chains (Ivy charm dependent on a Juggernaut surviving lane 1,
  // Xenomorph passive granting +1/+1 on enter, Fear toxin redirecting an
  // enemy's attack onto itself, etc.) we let the engine itself compute
  // the answer.
  //
  // hypothesis: { side, cardId, laneIdx }   — required
  //   side:      'player' | 'ai' (defaults to 'player')
  //   cardId:    id of the card in `side.hand`
  //   laneIdx:   target lane index
  // OR { side, trickId } for trick previews (no laneIdx).
  //
  // Returns an outcome record:
  //   { lanes: [{player:{id,name,hp,maxHp}, ai:{...}}, ...],
  //     playerHp, aiHp,
  //     playerHpDelta, aiHpDelta,
  //     gameOver, winner }
  // OR null on failure (simulation aborted — caller falls back to
  // heuristic preview).
  //
  // Implementation strategy: deep-clone state, swap UI for a no-op stub,
  // override setTimeout for the contained window so combat resolves
  // synchronously, run the play + combat, capture results, restore.
  previewPlay(hypothesis) {
    if (!this.state || !hypothesis) return null;
    if (this.state.gameOver) return null;
    if (!this.cloneStateDeep) return null;
    const origState = this.state;
    const origUI = (typeof UI !== 'undefined') ? UI : null;
    const origSetTimeout = (typeof window !== 'undefined') ? window.setTimeout : null;
    let result = null;
    try {
      const clone = this.cloneStateDeep(origState);
      clone._silentSim = true;
      this.state = clone;
      // Stub UI methods in place for the duration of the sim. UI is a
      // top-level `const` so we can't replace the binding — instead we
      // overwrite a known list of methods the engine touches with no-ops,
      // then restore. Anything missed simply runs as normal (best case
      // no-op, worst case throws → we catch + fall back).
      this._simSavedUI = {};
      if (typeof UI !== 'undefined') {
        const noop = () => {};
        const STUB_KEYS = [
          'render', 'showPhaseBanner', 'showLaneRecap', 'showRoundSummary',
          'showGameOverScreen', 'animateStatChanges', 'flashLanes',
          'flashUnaffordable', 'showFloatingPrompt', 'showCardChoice',
          'showLaneChoice', 'launchVictoryConfetti', 'stopVictoryConfetti',
          'startPromptCountdown', 'stopPromptCountdown', 'spawnLandingBurst',
          'pulseHpEdge', 'killingBlowCinema', 'hitPause', 'showFearPrompt',
          'showMindControlPrompt', 'showBlockTrickPrompt', 'closeAllPrompts'
        ];
        STUB_KEYS.forEach(k => {
          if (k in UI) { this._simSavedUI[k] = UI[k]; UI[k] = noop; }
        });
        // SFX subsystem — shadow with noop'd surface.
        if (UI.sfx) {
          this._simSavedUI._sfx = UI.sfx;
          UI.sfx = new Proxy(UI.sfx, {
            get(t, p) {
              const v = t[p];
              if (typeof v === 'function') return () => null;
              return v;
            }
          });
        }
        if (UI.audio) {
          this._simSavedUI._audio = UI.audio;
          UI.audio = new Proxy(UI.audio, {
            get(t, p) {
              const v = t[p];
              if (typeof v === 'function') return () => null;
              return v;
            }
          });
        }
      }
      // Override setTimeout to fire synchronously. The engine uses it
      // for combat pacing (lane stagger, post-combat delay). Inside the
      // sim window, only engine code uses setTimeout — UI is stubbed —
      // so collapsing them all to immediate is safe.
      if (typeof window !== 'undefined' && origSetTimeout) {
        window.setTimeout = (fn, ms) => { try { if (typeof fn === 'function') fn(); } catch (e) {} return 0; };
      }

      // Apply the hypothetical play
      const side = hypothesis.side || 'player';
      if (hypothesis.cardId != null && hypothesis.laneIdx != null) {
        const card = (clone[side] && clone[side].hand || []).find(c => c.id === hypothesis.cardId);
        if (card) {
          // Use playCard if available (handles cost, onPlay, etc.). If
          // it returns false (couldn't play), bail.
          const ok = this.playCard(side, card, hypothesis.laneIdx);
          if (!ok) { result = null; throw new Error('playCard returned false in sim'); }
        } else {
          throw new Error('hypothesis card not found in hand');
        }
      } else if (hypothesis.trickId != null) {
        const trick = (clone[side] && clone[side].trickHand || []).find(t => t.id === hypothesis.trickId);
        if (trick && this.playTrick) {
          this.playTrick(side, trick);
        }
      }

      // Drive the round forward to combat resolution. We call resolveCombat
      // directly instead of stepping phases, since trick-phase prompts
      // would deadlock (no auto-resolver in sim mode for arbitrary prompts).
      // For now this means: previewing a CARD play simulates that play
      // PLUS this round's combat, but doesn't simulate enemy reactions
      // they haven't queued yet. Good enough for the stated use case.
      try {
        this.resolveCombat();
      } catch (e) {
        // Some prompts may throw if their UI is missing — swallow and
        // continue with whatever state survived.
      }

      // Capture outcomes
      const lanesOut = clone.lanes.map((l) => ({
        player: l.player ? {
          id: l.player.id, name: l.player.name,
          hp: Math.max(0, l.player.currentHealth || 0),
          maxHp: l.player.maxHealth || l.player.health || 0,
          atk: l.player.attack || 0,
          died: (l.player.currentHealth || 0) <= 0
        } : null,
        ai: l.ai ? {
          id: l.ai.id, name: l.ai.name,
          hp: Math.max(0, l.ai.currentHealth || 0),
          maxHp: l.ai.maxHealth || l.ai.health || 0,
          atk: l.ai.attack || 0,
          died: (l.ai.currentHealth || 0) <= 0
        } : null,
      }));
      result = {
        lanes: lanesOut,
        playerHp: Math.max(0, clone.player.health || 0),
        aiHp: Math.max(0, clone.ai.health || 0),
        playerHpDelta: (clone.player.health || 0) - (origState.player.health || 0),
        aiHpDelta: (clone.ai.health || 0) - (origState.ai.health || 0),
        gameOver: !!clone.gameOver,
        winner: clone.winner || null,
      };
    } catch (e) {
      result = null;
    } finally {
      this.state = origState;
      // Restore UI methods we mutated. Property assignments survive the
      // const binding intact.
      if (this._simSavedUI && typeof UI !== 'undefined') {
        for (const k in this._simSavedUI) {
          if (k === '_sfx') UI.sfx = this._simSavedUI[k];
          else if (k === '_audio') UI.audio = this._simSavedUI[k];
          else UI[k] = this._simSavedUI[k];
        }
        this._simSavedUI = null;
      }
      if (typeof window !== 'undefined' && origSetTimeout) {
        window.setTimeout = origSetTimeout;
      }
    }
    return result;
  },

  // ===================== 2v2 GAME MODE =====================
  // Team A (p1+p2) maps to the 'player' combat side.
  // Team B (p3+p4) maps to the 'ai'    combat side.
  // Per-player hand/energy/trickHand live in state.twoVTwo.players[pN].
  // Team health, block meter, and dead pile live in state.twoVTwo.teams.
  // 6-phase turn order rotates on a 4-round cycle:
  //   Round 1: p1-cards → p3-cards → p2-cards-tricks → p4-cards-tricks → p1-tricks → p3-tricks
  //   Round 2: p2-cards → p3-cards → p4-cards-tricks → p1-cards-tricks → p2-tricks → p3-tricks
  //   Round 3: p3-cards → p4-cards → p1-cards-tricks → p2-cards-tricks → p3-tricks → p4-tricks
  //   Round 4: p4-cards → p1-cards → p3-cards-tricks → p2-cards-tricks → p4-tricks → p1-tricks
  //   (then repeats)
  // Between each player's phase, a "pass the device" splash screen is shown.

  _2v2PlayerTeam: { p1: 'A', p2: 'A', p3: 'B', p4: 'B' },
  _2v2TeamSide:   { A: 'player', B: 'ai' },

  _2v2ComputePhaseOrder(round) {
    const patterns = [
      ['p1-cards', 'p3-cards', 'p2-cards-tricks', 'p4-cards-tricks', 'p1-tricks', 'p3-tricks'],
      ['p2-cards', 'p3-cards', 'p4-cards-tricks', 'p1-cards-tricks', 'p2-tricks', 'p3-tricks'],
      ['p3-cards', 'p4-cards', 'p1-cards-tricks', 'p2-cards-tricks', 'p3-tricks', 'p4-tricks'],
      ['p4-cards', 'p1-cards', 'p3-cards-tricks', 'p2-cards-tricks', 'p4-tricks', 'p1-tricks'],
    ];
    return patterns[(round - 1) % 4];
  },

  _2v2CanPlayCards(subPhase) {
    return !!subPhase && subPhase.includes('cards');
  },

  _2v2CanPlayTricks(subPhase) {
    return !!subPhase && subPhase.includes('tricks');
  },

  _2v2ActivePlayer() {
    const tt = this.state.twoVTwo;
    if (!tt) return null;
    const order = this._2v2ComputePhaseOrder(tt.round || 1);
    const subPhase = order[tt.subPhaseIdx];
    return subPhase ? subPhase.split('-')[0] : null;  // 'p1', 'p2', etc.
  },

  _2v2ActiveTeam() {
    const ap = this._2v2ActivePlayer();
    return ap ? this._2v2PlayerTeam[ap] : null;
  },

  _2v2ActiveSide() {
    const team = this._2v2ActiveTeam();
    return team ? this._2v2TeamSide[team] : null;
  },

  _2v2SubPhase() {
    const tt = this.state.twoVTwo;
    if (!tt) return null;
    const order = this._2v2ComputePhaseOrder(tt.round || 1);
    return order[tt.subPhaseIdx] || null;
  },

  start2v2Match(opts) {
    // opts: { names: { p1, p2, p3, p4 }, teamAssignment: 'random'|{ A: [p1,p2], B: [p3,p4] } }
    this.init();  // resets state (LANE_COUNT goes back to 6 inside init)
    this.LANE_COUNT = this.LANE_COUNT_2V2;  // expand to 8 after init
    this.state.lanes = Array.from({ length: this.LANE_COUNT }, () => ({
      player: null, ai: null, _env: null, destroyed: false, destroyedTurns: 0, protected: null, trap: null,
    }));
    const s = this.state;
    s.phase = '2v2-team-setup';
    s.mode = { players: '2v2', deck: 'classic' };

    // Build per-player name map
    const names = (opts && opts.names) || { p1: 'Player 1', p2: 'Player 2', p3: 'Player 3', p4: 'Player 4' };

    // Build 2v2 state
    s.twoVTwo = {
      players: {
        p1: { name: names.p1, team: 'A', hand: [], trickHand: [], energy: 0, usedEnergy: 0 },
        p2: { name: names.p2, team: 'A', hand: [], trickHand: [], energy: 0, usedEnergy: 0 },
        p3: { name: names.p3, team: 'B', hand: [], trickHand: [], energy: 0, usedEnergy: 0 },
        p4: { name: names.p4, team: 'B', hand: [], trickHand: [], energy: 0, usedEnergy: 0 },
      },
      teams: {
        A: { health: 30, maxHealth: 30, blockMeter: 0, deadPile: [] },
        B: { health: 30, maxHealth: 30, blockMeter: 0, deadPile: [] },
      },
      subPhaseIdx: 0,
      round: 0,
      // Shared draw piles
      drawPile: [],
      trickDrawPile: [],
    };

    // Sync team health into state.player / state.ai so existing combat engine reads correctly
    s.player.health = s.player.maxHealth = 30;
    s.ai.health     = s.ai.maxHealth     = 30;
    s.player.isHuman = true;
    s.ai.isHuman     = true;  // both sides are human in 2v2

    this._2v2BuildDecks();
    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },

  _2v2BuildDecks() {
    const s = this.state;
    // Shuffle a fresh card pool and deal initial hands (no draft for 2v2 — straight deal)
    const allCards = (typeof CARD_DEFS !== 'undefined' ? CARD_DEFS : []).slice();
    const allTricks = (typeof TRICK_DEFS !== 'undefined' ? TRICK_DEFS : []).slice();

    // Shuffle helpers
    const shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };

    // Each player gets their own draw pile (equal share of shuffled pool)
    const tt = s.twoVTwo;
    // Same summon-token exclusion as the draft — _spawnOnly cards must never
    // be dealt or drawn, only spawned by their trigger.
    const cardPool = shuffle(allCards.filter(c => !c.isEnvironment && !c._spawnOnly));
    const trickPool = shuffle(allTricks.slice());

    // Deal: 5 cards + 2 tricks to each player
    const dealCards = (playerKey, start, count) => {
      const hand = [];
      for (let i = 0; i < count; i++) {
        const def = cardPool[(start * count + i) % cardPool.length];
        if (def) hand.push(this.createCardInstance(def, this._2v2TeamSide[tt.players[playerKey].team]));
      }
      return hand;
    };
    const dealTricks = (start, count) => {
      const hand = [];
      for (let i = 0; i < count; i++) {
        const def = trickPool[(start * count + i) % trickPool.length];
        if (def) hand.push(Object.assign({}, def));
      }
      return hand;
    };

    ['p1', 'p2', 'p3', 'p4'].forEach((pk, idx) => {
      tt.players[pk].hand      = dealCards(pk, idx, 5);
      tt.players[pk].trickHand = dealTricks(idx, 2);
      tt.players[pk].energy    = 0;
    });

    // Shared draw piles (remainder)
    tt.drawPile      = shuffle(cardPool.slice());
    tt.trickDrawPile = shuffle(trickPool.slice());
  },

  start2v2Round() {
    const s = this.state;
    const tt = s.twoVTwo;
    tt.round = (tt.round || 0) + 1;
    tt.subPhaseIdx = 0;

    // Grant energy for this round (round number)
    const energy = tt.round;
    Object.values(tt.players).forEach(p => { p.energy = energy; p.usedEnergy = 0; });

    this.log(`=== 2v2 Round ${tt.round} begins ===`);
    this._2v2StartSubPhase();
  },

  _2v2StartSubPhase() {
    const s = this.state;
    const tt = s.twoVTwo;
    const subPhase = this._2v2SubPhase();
    const activeKey = this._2v2ActivePlayer();
    const activeTeam = this._2v2ActiveTeam();

    if (!subPhase || !activeKey) {
      // All 6 sub-phases done — resolve combat
      this._2v2ResolveCombat();
      return;
    }

    const playerName = tt.players[activeKey].name;
    this.log(`[2v2] ${playerName}'s turn — ${subPhase}`);

    // Sync the active player's hand/energy into state.player or state.ai
    // so existing UI/ability code can read it
    const side = this._2v2ActiveSide();
    this._2v2SyncActivePlayer();

    // Set the game phase so UI knows what to show
    // Online: no pass-device needed; local: show pass screen between players
    if (tt.online) {
      s.phase = '2v2-' + subPhase;
      this._2v2OnlineBroadcast();
    } else if (tt.subPhaseIdx === 0) {
      s.phase = '2v2-' + subPhase;
    } else {
      s.phase = '2v2-pass';  // "Pass to [playerName]" screen
      s._2v2NextPhase = '2v2-' + subPhase;  // phase to go to after confirmation
    }

    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },

  _2v2SyncActivePlayer() {
    const s = this.state;
    const tt = s.twoVTwo;
    const activeKey = this._2v2ActivePlayer();
    if (!activeKey) return;
    const ap = tt.players[activeKey];
    const side = this._2v2TeamSide[ap.team];

    // Sync hand and energy so existing card-play code works
    s[side].hand      = ap.hand;
    s[side].trickHand = ap.trickHand;
    s[side].currency  = ap.energy - ap.usedEnergy;
    // Block meter and health come from team state
    s[side].health    = tt.teams[ap.team].health;
    s[side].maxHealth = tt.teams[ap.team].maxHealth;
    s[side].blockMeter = tt.teams[ap.team].blockMeter;
    // Dead pile is shared per team
    s[side].deadPile  = tt.teams[ap.team].deadPile;
  },

  _2v2ReadBackActivePlayer() {
    const s = this.state;
    const tt = s.twoVTwo;
    const activeKey = this._2v2ActivePlayer();
    if (!activeKey) return;
    const ap = tt.players[activeKey];
    const side = this._2v2TeamSide[ap.team];

    // Read back any changes made by ability code
    ap.hand      = s[side].hand;
    ap.trickHand = s[side].trickHand;
    ap.usedEnergy = ap.energy - s[side].currency;
    // Read back team state
    tt.teams[ap.team].health    = s[side].health;
    tt.teams[ap.team].blockMeter = s[side].blockMeter;
    tt.teams[ap.team].deadPile  = s[side].deadPile;
  },

  end2v2Phase() {
    const s = this.state;
    const tt = s.twoVTwo;

    // Save any changes made during this sub-phase
    this._2v2ReadBackActivePlayer();

    // Advance to next sub-phase
    tt.subPhaseIdx++;
    this._2v2StartSubPhase();
  },

  confirm2v2Pass() {
    const s = this.state;
    if (s._2v2NextPhase) {
      s.phase = s._2v2NextPhase;
      delete s._2v2NextPhase;
    }
    const activeKey = this._2v2ActivePlayer();
    if (activeKey) this._2v2SyncActivePlayer();
    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },

  _2v2ResolveCombat() {
    const s = this.state;
    const tt = s.twoVTwo;

    // Sync both teams' health into state.player/ai before combat
    s.player.health    = tt.teams.A.health;
    s.player.maxHealth = tt.teams.A.maxHealth;
    s.player.blockMeter = tt.teams.A.blockMeter;
    s.player.deadPile  = tt.teams.A.deadPile;
    s.ai.health    = tt.teams.B.health;
    s.ai.maxHealth = tt.teams.B.maxHealth;
    s.ai.blockMeter = tt.teams.B.blockMeter;
    s.ai.deadPile  = tt.teams.B.deadPile;

    s.phase = '2v2-combat';
    if (typeof UI !== 'undefined' && UI.render) UI.render();

    // Run standard combat. Its lanes resolve on ASYNC timers, so the
    // read-back + next-round handoff can NOT happen here — it lives in
    // _2v2PostCombat, invoked by postCombat() when combat truly finishes.
    // (The old +300ms read-back here captured pre-damage health AND let
    // postCombat's 1v1 drawPhase/startRound chain stomp the 2v2 flow.)
    setTimeout(() => { this.resolveCombat(); }, 300);
  },

  // Combat finished (called from postCombat) — read team results back from
  // the player/ai combat proxies and advance the 2v2 round loop.
  _2v2PostCombat() {
    const s = this.state;
    const tt = s.twoVTwo;
    if (!tt) return;
    tt.teams.A.health     = s.player.health;
    tt.teams.A.blockMeter = s.player.blockMeter;
    tt.teams.A.deadPile   = s.player.deadPile;
    tt.teams.B.health     = s.ai.health;
    tt.teams.B.blockMeter = s.ai.blockMeter;
    tt.teams.B.deadPile   = s.ai.deadPile;
    if (tt.online) this._2v2OnlineBroadcast();
    this._2v2DrawPhase();
  },

  _2v2DrawPhase() {
    const s = this.state;
    const tt = s.twoVTwo;

    // Each player draws exactly ONE card per round — matching 1v1's draw
    // phase (baseDraw = 1, no per-round trick). This used to hand out 2 cards
    // AND a trick every round, which flooded hands and handed out free tricks
    // no other mode grants (tricks come from the draft + the block meter).
    // User report: "we drew a trick and a card when it should only be a card."
    ['p1', 'p2', 'p3', 'p4'].forEach(pk => {
      const p = tt.players[pk];
      const side = this._2v2TeamSide[p.team];
      if (tt.drawPile.length > 0) {
        const def = tt.drawPile.pop();
        if (def) p.hand.push(this.createCardInstance(def, side));
      }
    });

    // Start next round
    this.start2v2Round();
  },

  // Check if 2v2 is active
  is2v2() {
    return !!(this.state && this.state.mode && this.state.mode.players === '2v2' && this.state.twoVTwo);
  },

  // Enter 2v2 mode setup from main menu
  goTo2v2Setup() {
    // ORDER MATTERS: init() resets LANE_COUNT to 6 and builds 6 lanes, so
    // the 2v2 expansion must come AFTER it (same as goTo2v2OnlineLobby and
    // start2v2Match). Setting it first got silently clobbered — the whole
    // local 2v2 match played on a 6-lane board. User report (x4): "there
    // needs to be 8 lanes on the board and every time I look it's only 6."
    this.init();
    this.LANE_COUNT = this.LANE_COUNT_2V2;
    this.state.lanes = Array.from({ length: this.LANE_COUNT }, () => ({
      player: null, ai: null, _env: null, destroyed: false, destroyedTurns: 0, protected: null, trap: null,
    }));
    this.state.phase = '2v2-team-setup';
    this.state.mode = { players: '2v2', deck: 'classic' };
    this.state.twoVTwo = {
      players: {
        p1: { name: 'Player 1', team: 'A', hand: [], trickHand: [], energy: 0, usedEnergy: 0 },
        p2: { name: 'Player 2', team: 'A', hand: [], trickHand: [], energy: 0, usedEnergy: 0 },
        p3: { name: 'Player 3', team: 'B', hand: [], trickHand: [], energy: 0, usedEnergy: 0 },
        p4: { name: 'Player 4', team: 'B', hand: [], trickHand: [], energy: 0, usedEnergy: 0 },
      },
      teams: {
        A: { health: 30, maxHealth: 30, blockMeter: 0, deadPile: [] },
        B: { health: 30, maxHealth: 30, blockMeter: 0, deadPile: [] },
      },
      subPhaseIdx: 0,
      round: 0,
      drawPile: [],
      trickDrawPile: [],
    };
    this.state.player.health = this.state.player.maxHealth = 30;
    this.state.ai.health     = this.state.ai.maxHealth     = 30;
    this.state.player.isHuman = true;
    this.state.ai.isHuman     = true;
    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },

  // ===================== 2v2 DRAFT =====================

  _2v2StartDraft() {
    const s = this.state;
    const tt = s.twoVTwo;
    // _spawnOnly cards (Gremlin, Freddy Krueger, Jaws, …) are summon tokens —
    // they enter play ONLY through the trigger that spawns them, never by
    // being drafted or drawn. 1v1 already filtered them out of its deck build
    // (see buildDecks); the 2v2 draft didn't, so Freddy Krueger and friends
    // showed up as draftable picks. User report: "in the 2v2 draft the summons
    // like freddy krueger was able to be picked."
    const allCards = (typeof CARD_DEFS !== 'undefined' ? CARD_DEFS : [])
      .filter(c => !c.isEnvironment && !c._spawnOnly).slice();
    const allTricks = (typeof TRICK_DEFS !== 'undefined' ? TRICK_DEFS : []).slice();

    tt.draft = {
      phase: 'cards',
      round: 1,
      // Sequential fields — used by LOCAL pass-and-play only (one device, so
      // players must take turns behind a pass screen).
      pickerOrder: ['p1', 'p2', 'p3', 'p4'],
      pickerIdx: 0,
      choices: [],
      // SIMULTANEOUS draft (online): all four players see their OWN offers and
      // pick at the same time, like 1v1 online. choicesByPlayer holds each
      // player's two offers; picked tracks who has locked in this round; the
      // round advances once all four have picked. User: "during the draft we
      // had to draft 1 by 1 … I would like it all at the same time."
      simultaneous: !!tt.online,
      choicesByPlayer: {},
      picked: {},
      cardPool: this.shuffle(allCards),
      trickPool: this.shuffle(allTricks),
      // Holding areas — every card/trick a player has SEEN but not taken
      // (the rejected half of a pick, plus anything mulliganed away) lands
      // here instead of going back in the pool. Nothing in holding can be
      // offered again, so no two players are ever shown the same option.
      // Both are shuffled back into the draw piles when the draft ends.
      // Mirrors 1v1's d.cardHolding / d.trickHolding.
      cardHolding: [],
      trickHolding: [],
      mulliganUsed: {},      // { p1: bool, … } — cards phase, one per player
      trickMulliganUsed: {}, // { p1: bool, … } — tricks phase, one per player
    };

    ['p1','p2','p3','p4'].forEach(pk => {
      tt.players[pk].hand = [];
      tt.players[pk].trickHand = [];
      tt.players[pk].energy = 0;
      tt.players[pk].usedEnergy = 0;
    });

    this._2v2PresentDraftChoices();
    if (tt.online) {
      s.phase = '2v2-draft';
      // Broadcast happens from twov2OnlineStart() right after this returns
    } else {
      s.phase = '2v2-draft-pass';
      s._2v2DraftNextPhase = '2v2-draft';
      if (typeof UI !== 'undefined' && UI.render) UI.render();
    }
  },

  // Names already spoken for — every card/trick sitting in a hand, plus (for
  // the simultaneous online draft) every OTHER player's currently-visible
  // offers, so no two players are ever shown the same option at once.
  _2v2TakenSet(isCards, excludePk) {
    const tt = this.state.twoVTwo;
    const d = tt.draft;
    const taken = new Set();
    Object.values(tt.players).forEach(ap => {
      const held = isCards ? ap.hand : ap.trickHand;
      (held || []).forEach(c => { if (c && c.name) taken.add(c.name); });
    });
    if (d.simultaneous && d.choicesByPlayer) {
      Object.keys(d.choicesByPlayer).forEach(pk => {
        if (pk === excludePk) return;
        (d.choicesByPlayer[pk] || []).forEach(c => { if (c && c.name) taken.add(c.name); });
      });
    }
    return taken;
  },

  // Draw two distinct, not-already-taken options from the pool, adding each to
  // `taken` as it's dealt. Recycles the holding pile as a last resort so the
  // draft can't stall on an empty offer (tightest case: the 2v2 trick draft).
  _2v2DealTwo(isCards, taken) {
    const d = this.state.twoVTwo.draft;
    const pool = isCards ? d.cardPool : d.trickPool;
    const holding = isCards ? d.cardHolding : d.trickHolding;
    const out = [];
    const skipped = [];
    while (out.length < 2) {
      if (!pool.length) {
        if (!holding.length) break;
        pool.push(...this.shuffle(holding.splice(0, holding.length)));
        continue;
      }
      const card = pool.pop();
      if (!card) break;
      if (taken.has(card.name)) skipped.push(card);
      else { out.push(card); taken.add(card.name); }
    }
    // Already-owned names go to the bottom of the pool, not to holding —
    // holding is only for things a player CHOSE to pass on.
    if (skipped.length) pool.unshift(...skipped);
    return out;
  },

  _2v2PresentDraftChoices() {
    const tt = this.state.twoVTwo;
    const d = tt.draft;
    const isCards = d.phase === 'cards';

    if (d.simultaneous) {
      // Deal all four players their own two offers at once, from one shared
      // `taken` so nobody's offers collide, and clear the per-round picked map.
      const taken = this._2v2TakenSet(isCards, null);
      d.choicesByPlayer = {};
      ['p1', 'p2', 'p3', 'p4'].forEach(pk => { d.choicesByPlayer[pk] = this._2v2DealTwo(isCards, taken); });
      d.picked = { p1: false, p2: false, p3: false, p4: false };
      return;
    }

    // Sequential (local pass-and-play): one shared offer for the current picker.
    d.choices = this._2v2DealTwo(isCards, this._2v2TakenSet(isCards, null));
  },

  _2v2DraftPick(index, playerKey) {
    const s = this.state;
    const tt = s.twoVTwo;
    const d = tt.draft;
    if (!d) return;

    // SIMULTANEOUS (online): each player picks from their own offers whenever
    // they're ready; the round advances only once all four have locked in.
    if (d.simultaneous) {
      const pk = playerKey;
      if (!pk || d.picked[pk]) return;                 // no double-picks
      const mine = d.choicesByPlayer[pk] || [];
      const chosen = mine[index];
      const rejected = mine[1 - index];
      if (!chosen) return;
      const side = this._2v2TeamSide[tt.players[pk].team];
      if (d.phase === 'cards') tt.players[pk].hand.push(this.createCardInstance(chosen, side));
      else                     tt.players[pk].trickHand.push({ ...chosen, id: nextCardId++ });
      if (rejected) (d.phase === 'cards' ? d.cardHolding : d.trickHolding).push(rejected);
      d.choicesByPlayer[pk] = [];
      d.picked[pk] = true;

      // Everyone in? Advance the round (or the phase, or finish the draft).
      if (['p1', 'p2', 'p3', 'p4'].every(k => d.picked[k])) {
        d.round++;
        const maxRounds = d.phase === 'cards' ? 4 : 2;
        if (d.round > maxRounds) {
          if (d.phase === 'cards') { d.phase = 'tricks'; d.round = 1; }
          else {
            tt.drawPile      = this.shuffle(d.cardPool.concat(d.cardHolding || []));
            tt.trickDrawPile = this.shuffle(d.trickPool.concat(d.trickHolding || []));
            delete tt.draft;
            this.start2v2Round();
            return;
          }
        }
        this._2v2PresentDraftChoices();  // deal the next round to all four, reset picked
      }
      s.phase = '2v2-draft';
      this._2v2OnlineBroadcast();
      return;
    }

    const chosen = d.choices[index];
    const rejected = d.choices[1 - index];
    if (!chosen) return;

    const pickerKey = d.pickerOrder[d.pickerIdx];
    const pickerSide = this._2v2TeamSide[tt.players[pickerKey].team];

    if (d.phase === 'cards') {
      tt.players[pickerKey].hand.push(this.createCardInstance(chosen, pickerSide));
    } else {
      tt.players[pickerKey].trickHand.push({ ...chosen, id: nextCardId++ });
    }

    // The half the picker passed on goes to HOLDING, not back to the pool.
    // Previously it was unshifted back so it could "resurface" — which meant
    // the very next player could be offered the card the previous player had
    // just turned down. Holding keeps it out of circulation for the rest of
    // the draft; it returns to the deck when the draft ends. Matches 1v1,
    // where the rejected half already went to d.cardHolding.
    if (rejected) {
      const holding = d.phase === 'cards' ? d.cardHolding : d.trickHolding;
      holding.push(rejected);
    }

    d.pickerIdx++;
    if (d.pickerIdx >= d.pickerOrder.length) {
      d.pickerIdx = 0;
      d.round++;
      const maxRounds = d.phase === 'cards' ? 4 : 2;
      if (d.round > maxRounds) {
        if (d.phase === 'cards') {
          d.phase = 'tricks';
          d.round = 1;
        } else {
          // Draft complete — everything held back during the draft (passed-on
          // halves + mulliganed options, cards and tricks alike) returns to
          // the deck here, shuffled in with whatever's left of the pools.
          tt.drawPile      = this.shuffle(d.cardPool.concat(d.cardHolding || []));
          tt.trickDrawPile = this.shuffle(d.trickPool.concat(d.trickHolding || []));
          delete tt.draft;
          this.start2v2Round();
          return;
        }
      }
    }

    this._2v2PresentDraftChoices();
    if (tt.online) {
      s.phase = '2v2-draft';
      this._2v2OnlineBroadcast();
    } else {
      s.phase = '2v2-draft-pass';
      s._2v2DraftNextPhase = '2v2-draft';
      if (typeof UI !== 'undefined' && UI.render) UI.render();
    }
  },

  _2v2DraftMulligan(playerKey) {
    const tt = this.state.twoVTwo;
    const d = tt && tt.draft;
    if (!d) return false;

    // SIMULTANEOUS (online): a player redraws only their OWN offers, once per
    // phase, and only before they've locked in this round.
    if (d.simultaneous) {
      const pk = playerKey;
      if (!pk || d.picked[pk]) return false;
      const isCards = d.phase === 'cards';
      const mulliganKey = isCards ? 'mulliganUsed' : 'trickMulliganUsed';
      if (!d[mulliganKey]) d[mulliganKey] = {};
      if (d[mulliganKey][pk]) return false;
      const holding = isCards ? d.cardHolding : d.trickHolding;
      (d.choicesByPlayer[pk] || []).forEach(c => { if (c) holding.push(c); });
      d.choicesByPlayer[pk] = this._2v2DealTwo(isCards, this._2v2TakenSet(isCards, pk));
      d[mulliganKey][pk] = true;
      this.log(`[2v2 DRAFT] Mulligan used by ${pk}`);
      this._2v2OnlineBroadcast();
      return true;
    }

    if (!d.choices || !d.choices.length) return false;
    const pickerKey = d.pickerOrder[d.pickerIdx];
    const mulliganKey = d.phase === 'cards' ? 'mulliganUsed' : 'trickMulliganUsed';
    if (!d[mulliganKey]) d[mulliganKey] = {};
    if (d[mulliganKey][pickerKey]) return false; // already used this phase
    // Mulliganed options go to HOLDING, never back to the pool. They used to
    // be unshifted back and reshuffled, which meant the cards you rejected
    // could be dealt straight to the next player — the thing a mulligan is
    // supposed to prevent. Holding withholds them for the rest of the draft
    // and returns them to the deck once it's over.
    const holding = d.phase === 'cards' ? d.cardHolding : d.trickHolding;
    d.choices.forEach(c => { if (c) holding.push(c); });
    d.choices = [];
    this._2v2PresentDraftChoices();
    d[mulliganKey][pickerKey] = true;
    this.log(`[2v2 DRAFT] Mulligan used by ${pickerKey}`);
    if (tt.online) {
      this._2v2OnlineBroadcast();
    } else {
      if (typeof UI !== 'undefined' && UI.render) UI.render();
    }
    return true;
  },

  confirm2v2DraftPass() {
    const s = this.state;
    if (s._2v2DraftNextPhase) {
      s.phase = s._2v2DraftNextPhase;
      delete s._2v2DraftNextPhase;
    }
    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },

  // ===================== 2v2 ONLINE =====================

  goTo2v2OnlineLobby() {
    this.init();
    this.LANE_COUNT = this.LANE_COUNT_2V2;
    this.state.lanes = Array.from({ length: this.LANE_COUNT }, () => ({
      player: null, ai: null, _env: null, destroyed: false, destroyedTurns: 0, protected: null, trap: null,
    }));
    const s = this.state;
    s.phase = '2v2-online-lobby';
    s.mode = { players: '2v2', deck: 'classic', online: true };
    s.twoVTwo = {
      players: {
        p1: { name: 'Player 1', team: 'A', hand: [], trickHand: [], energy: 0, usedEnergy: 0 },
        p2: { name: 'Player 2', team: 'A', hand: [], trickHand: [], energy: 0, usedEnergy: 0 },
        p3: { name: 'Player 3', team: 'B', hand: [], trickHand: [], energy: 0, usedEnergy: 0 },
        p4: { name: 'Player 4', team: 'B', hand: [], trickHand: [], energy: 0, usedEnergy: 0 },
      },
      teams: {
        A: { health: 30, maxHealth: 30, blockMeter: 0, deadPile: [] },
        B: { health: 30, maxHealth: 30, blockMeter: 0, deadPile: [] },
      },
      subPhaseIdx: 0,
      round: 0,
      drawPile: [],
      trickDrawPile: [],
      online: true,
      you: null,       // set when room is joined ('p1'|'p2'|'p3'|'p4')
      joinedPlayers: { p1: false, p2: false, p3: false, p4: false },
    };
    s.player.health = s.player.maxHealth = 30;
    s.ai.health     = s.ai.maxHealth     = 30;
    s.player.isHuman = true;
    s.ai.isHuman     = true;
    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },

  // Host: start online match once all players have joined
  start2v2OnlineMatch() {
    const s = this.state;
    const tt = s.twoVTwo;
    tt.joinedPlayers = { p1: true, p2: true, p3: true, p4: true };
    this._2v2StartDraft();
  },

  // Apply an action received from a joiner (host only)
  _apply2v2OnlineAction(msg) {
    const pk = msg.playerKey;
    if (!pk) return;
    const activeKey = this._2v2ActivePlayer();
    const draftActive = !!(this.state.twoVTwo && this.state.twoVTwo.draft);
    switch (msg.t) {
      case 'play2v2Card':
        if (pk !== activeKey) break;
        this._2v2CurrentActingPlayer = pk; // track who triggered any ability prompts
        this._2v2OnlinePlayCard(pk, msg.cardIdx, msg.laneIdx);
        break;
      case 'req2v2LaneChoice':
        this._2v2RequestLaneChoice(pk, msg.cardIdx);
        break;
      case 'play2v2Trick':
        if (pk !== activeKey) break;
        this._2v2CurrentActingPlayer = pk;
        this._2v2OnlinePlayTrick(pk, msg.trickIdx);
        break;
      case 'end2v2Phase':
        if (pk !== activeKey) break;
        this.end2v2Phase();
        break;
      case 'req2v2State':
        // A joiner asking the host to (re)send state — its first push may
        // have been lost (data channel settling / flaky Wi-Fi). No-op here;
        // the trailing _2v2OnlineBroadcast answers. Mirrors 1v1's reqState.
        break;
      case '2v2DraftPick':
        // Simultaneous online draft: each player picks from their own offers,
        // so route the pick to whoever sent it. _2v2DraftPick guards against
        // double-picks and out-of-turn picks itself.
        this._2v2DraftPick(msg.index, pk);
        break;
      case '2v2DraftMulligan':
        this._2v2DraftMulligan(pk);
        break;
      case '2v2LaneChoiceResult': {
        const lc = this.state.pendingLaneChoice;
        if (lc && lc._2v2ActingPlayer === pk) {
          // Re-arm acting player for chained ability prompts that may fire inside callback
          this._2v2CurrentActingPlayer = pk;
          this.state.pendingLaneChoice = null;
          this._clearPromptTimeout();
          if (lc.callback) lc.callback(msg.laneIdx);
          this.cleanupDead();
          this.resumeCombatIfWaiting();
        }
        break;
      }
      case '2v2CardChoiceResult': {
        const cc = this.state.pendingCardChoice;
        if (cc && cc._2v2ActingPlayer === pk) {
          this._2v2CurrentActingPlayer = pk;
          this.state.pendingCardChoice = null;
          this._clearPromptTimeout();
          const pick = cc.cards[msg.idx] || cc.cards[0];
          if (cc.callback) cc.callback(pick);
          this.cleanupDead();
          this.resumeCombatIfWaiting();
        }
        break;
      }
    }
    // Clear acting-player flag now (any chained pending choice has been annotated)
    if (!this.state.pendingLaneChoice && !this.state.pendingCardChoice) {
      this._2v2CurrentActingPlayer = null;
    }
    this._2v2OnlineBroadcast();
  },

  // A player clicked a card in hand and needs to pick a lane for it. This is
  // the SINGLE path every online seat uses — host included. It mirrors 1v1
  // online exactly: select the card, the open lanes light up on the board,
  // click one to place it.
  //
  // The host used to have its own separate flow (a numbered lane-strip driven
  // by UI._2v2SelectedCardIdx). That strip was the thing that broke — the host
  // could click a card and then have no way to choose a lane — while the
  // guests' prompt-based path kept working. Rather than repair a second
  // implementation, the host now runs this same method locally that guests
  // reach via the 'req2v2LaneChoice' message, so there is one code path to
  // keep correct instead of two.
  _2v2RequestLaneChoice(playerKey, cardIdx) {
    const pk = playerKey;
    if (!pk || cardIdx == null) return;
    if (pk !== this._2v2ActivePlayer()) return;                       // not your turn
    if (this.state.pendingLaneChoice || this.state.pendingCardChoice) return;  // already prompting
    const ap = this.state.twoVTwo && this.state.twoVTwo.players[pk];
    if (!ap) return;
    const card = ap.hand[cardIdx];
    if (!card) return;
    const side = this._2v2TeamSide[ap.team];
    if ((ap.energy - (ap.usedEnergy || 0)) < (card.cost || 0)) return; // can't afford
    // Discard-effect cards never take a lane — play them straight away.
    if (card.isDiscardEffect) {
      this._2v2CurrentActingPlayer = pk;
      this._2v2OnlinePlayCard(pk, cardIdx, null);
      return;
    }
    const openLanes = this.getOpenLanes(side);
    if (!openLanes.length) return;
    this._2v2CurrentActingPlayer = pk;
    if (openLanes.length === 1) {
      this._2v2OnlinePlayCard(pk, cardIdx, openLanes[0]);
    } else {
      this.promptLaneChoice(
        side, openLanes,
        `Place ${card.name}`,
        `Choose a lane for ${card.name} (${card.attack}/${card.currentHealth || card.health})`,
        (lane) => this._2v2OnlinePlayCard(pk, cardIdx, lane)
      );
    }
  },

  // Stamp whichever prompt an effect just raised with the acting player, so
  // only that client can resolve it. Covers effects that assign
  // pendingCardChoice / pendingLaneChoice directly instead of going through
  // promptCardChoice (which stamps them itself).
  _2v2StampPendingActor() {
    const cap = this._2v2CurrentActingPlayer;
    if (!cap) return;
    const cc = this.state.pendingCardChoice;
    const lc = this.state.pendingLaneChoice;
    if (cc && !cc._2v2ActingPlayer) cc._2v2ActingPlayer = cap;
    if (lc && !lc._2v2ActingPlayer) lc._2v2ActingPlayer = cap;
  },

  // Bridge the 2v2 world onto the 1v1 side-proxy that every engine routine
  // expects, run `fn`, then unbridge. state[side].hand is the acting player's
  // ACTUAL array (same reference), and state[side].currency is their remaining
  // energy, so the readback turns any spend back into usedEnergy.
  //
  // If `fn` leaves a prompt open (an onPlay that asks for a target), the
  // unbridge is deferred until that whole prompt chain resolves — otherwise a
  // Draw-N firing from inside the callback would pull from the 1v1 pile
  // instead of the 2v2 deck, and the energy readback would miss the spend.
  _2v2WithSideBridge(fn) {
    const s = this.state, tt = s.twoVTwo;
    this._2v2SyncActivePlayer();
    const savedDraw = s.drawPile, savedTrickDraw = s.trickDrawPile;
    s.drawPile = tt.drawPile;
    s.trickDrawPile = tt.trickDrawPile;
    const unbridge = () => {
      tt.drawPile = s.drawPile;
      tt.trickDrawPile = s.trickDrawPile;
      s.drawPile = savedDraw;
      s.trickDrawPile = savedTrickDraw;
      this._2v2ReadBackActivePlayer();
    };
    let out, threw = true;
    try { out = fn(); threw = false; }
    finally {
      if (!threw && this.hasPendingPrompt && this.hasPendingPrompt()) this.whenPromptCleared(unbridge);
      else unbridge();
    }
    return out;
  },

  // Play a card in 2v2 by DELEGATING to the real playCard().
  //
  // This used to be a ~15-line reimplementation that only moved the card into
  // a lane and called onPlay. It silently skipped nearly everything playCard
  // does, so a long tail of cards were quietly broken in 2v2 only:
  //   • _neverPlayable — Iron Giant could be PLAYED ONTO THE BOARD (he is
  //     supposed to guard from hand); the fuzzer hit this 338x in 60 games
  //   • lane.destroyed  — cards could be placed into destroyed lanes
  //   • isEnvironment   — environments were dropped into the creature slot
  //     instead of lane._env
  //   • getCardCost     — cost discounts ignored (raw card.cost was charged)
  //   • Batman lock, Batman Who Laughs intercept — never fired
  //   • onAnyCardPlayed broadcast, cardPlayedBuff auras, Lone Wolf +1/+1
  //   • drawOnPlay ("Draw 1"), Cantrip/Fear/Freeze/MindControl/Mark on-play
  //   • checkLaneTrap, hunt chase, jump conditions, Magneto debuffs,
  //     Doomsday scaling, cleanupDead, face-down plays, stats/energy credit
  // Delegating means 2v2 inherits all of it — and every future 1v1 fix — for
  // free, instead of the two paths drifting further apart.
  _2v2OnlinePlayCard(playerKey, cardIdx, laneIdx) {
    const s = this.state, tt = s.twoVTwo;
    if (!tt) return;
    const ap = tt.players[playerKey];
    if (!ap) return;
    const card = ap.hand[cardIdx];
    if (!card) return;
    const side = this._2v2TeamSide[ap.team];
    this._2v2WithSideBridge(() => this.playCard(side, card, laneIdx));
    // Stamp any prompt the play raised with the acting player so the right
    // client resolves it (and the others can't).
    this._2v2StampPendingActor();
  },

  // Same delegation for tricks — playTrick() owns Time Stone intercept,
  // canPlay validation, trick cost discounts, the _inTrick flag that
  // Untrickable/10-cost guards depend on, played-pile bookkeeping and stats.
  // The old inline version called trick.play() raw and skipped all of it.
  _2v2OnlinePlayTrick(playerKey, trickIdx) {
    const s = this.state, tt = s.twoVTwo;
    if (!tt) return;
    const ap = tt.players[playerKey];
    if (!ap) return;
    const trick = ap.trickHand[trickIdx];
    if (!trick) return;
    const side = this._2v2TeamSide[ap.team];
    this._2v2WithSideBridge(() => this.playTrick(side, trick));
    this._2v2StampPendingActor();
  },

  // Host broadcasts current state to all joiners via Multiplayer4
  _2v2OnlineBroadcast() {
    // Never let a serialize/send failure abort the host's own turn. A throw
    // here used to leave the host playing on while every guest froze on a
    // stale state (the broadcast never reached them). serializeState is now
    // cycle-safe, but the try/catch is belt-and-suspenders: if a broadcast
    // ever fails again it gets logged instead of silently stranding guests.
    if (typeof Multiplayer4 !== 'undefined' && Multiplayer4.broadcastState) {
      try {
        const clone = (typeof Multiplayer !== 'undefined' && Multiplayer.serializeState)
          ? Multiplayer.serializeState(this.state)
          : JSON.parse(JSON.stringify(this.state));
        Multiplayer4.broadcastState(clone);
      } catch (e) {
        console.error('[2v2] state broadcast failed — guests will not see this update:', e);
        if (typeof window !== 'undefined' && window.__clbErrors) window.__clbErrors.report('2v2-broadcast', e);
      }
    }
    if (typeof UI !== 'undefined' && UI.render) UI.render();
  },

  // Called from team setup UI once player names (and optionally team assignments) are set
  confirm2v2Teams(names, teams) {
    const s = this.state;
    const tt = s.twoVTwo;

    // Apply names
    if (names) {
      ['p1', 'p2', 'p3', 'p4'].forEach(pk => {
        if (names[pk]) tt.players[pk].name = names[pk];
      });
    }

    // Apply team assignments (teams.A = [playerKey, playerKey], teams.B = [...])
    if (teams) {
      teams.A.forEach((pk, i) => { tt.players[pk].team = 'A'; });
      teams.B.forEach((pk, i) => { tt.players[pk].team = 'B'; });
    }

    // Start the draft phase (pick 4 cards + 2 tricks per player)
    this._2v2StartDraft();
  },
};
