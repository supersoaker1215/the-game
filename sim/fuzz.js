// Property-based fuzzer for the card game.
// Drives both seats with RANDOM legal moves (instead of optimal AI) and
// asserts engine invariants after every action and at end of every round.
//
// Run with:
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc sim/fuzz.js -- --runs 200 --seed 0
//
// Self-contained — only depends on the same shim as run.js. Does not modify
// any game code. Crashes and invariant violations are reported but do not
// stop the run; the fuzzer keeps going so a single batch surfaces multiple
// classes of failures.

var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');

// ---------------- arg parsing ----------------
function parseArgs(argv) {
  var out = { runs: 200, seed: 0, skipProb: 0.15, maxRounds: 100, verbose: false };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--runs') out.runs = parseInt(argv[++i], 10) || out.runs;
    else if (a === '--seed') out.seed = parseInt(argv[++i], 10) || 0;
    else if (a === '--skip-prob') out.skipProb = parseFloat(argv[++i]);
    else if (a === '--max-rounds') out.maxRounds = parseInt(argv[++i], 10) || out.maxRounds;
    else if (a === '--verbose') out.verbose = true;
  }
  return out;
}

// ---------------- mulberry32 PRNG ----------------
// Seedable so any failure is reproducible by re-running with the same --seed.
// The fuzzer also overrides the SHARED Math.random while a turn is being
// driven so that prompt callbacks (lane/card pickers in shim.js) use the
// same deterministic stream — without that, a "found bug" can vanish on
// rerun because Math.random reseeds every process launch.
function mulberry32(seed) {
  var s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    var t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------- invariant checks ----------------
// Returns an array of violation strings (empty == clean). We collect all
// violations from a single check rather than throwing on the first so a
// single failure mode doesn't mask other simultaneous violations.
function checkInvariants(state, ctx) {
  var violations = [];
  if (!state) return ['no state'];

  // Helper: collect all live cards on the board.
  var lanes = state.lanes || [];
  var idsSeen = {};
  var idCount = 0;
  for (var i = 0; i < lanes.length; i++) {
    var lane = lanes[i];
    if (!lane) continue;
    var slots = ['player', 'ai'];
    for (var s = 0; s < slots.length; s++) {
      var c = lane[slots[s]];
      if (!c) continue;
      idCount++;
      if (c.id != null) {
        if (idsSeen[c.id] != null) {
          violations.push('duplicate card id ' + c.id + ' (name=' + c.name + ') in lanes ' + idsSeen[c.id] + ' and ' + i);
        } else {
          idsSeen[c.id] = i;
        }
      }
      // Negative-HP guard: dead cards may legitimately drop to 0 or below
      // for one tick before cleanup, but a card the engine considers
      // ALIVE (currentHealth > 0) should never have a negative attack or
      // a NaN/undefined HP value.
      if (c.currentHealth > 0) {
        if (typeof c.currentHealth !== 'number' || !isFinite(c.currentHealth)) {
          violations.push('non-finite currentHealth on ' + c.name + ' (' + c.currentHealth + ')');
        }
        if (typeof c.attack !== 'number' || c.attack < 0) {
          violations.push('negative/invalid attack on ' + c.name + ' (' + c.attack + ')');
        }
        if (c.cost != null && c.cost < 0) {
          violations.push('negative cost on ' + c.name + ' (' + c.cost + ')');
        }
      }
    }
  }

  if (typeof state.player.health !== 'number' || !isFinite(state.player.health)) {
    violations.push('non-finite player health: ' + state.player.health);
  }
  if (typeof state.ai.health !== 'number' || !isFinite(state.ai.health)) {
    violations.push('non-finite ai health: ' + state.ai.health);
  }

  // Hand cards: cost should never be negative either (Kang halves cost,
  // some abilities subtract — but the floor is 0).
  var sides = ['player', 'ai'];
  for (var sd = 0; sd < sides.length; sd++) {
    var sideObj = state[sides[sd]];
    var hand = (sideObj && sideObj.hand) || [];
    for (var h = 0; h < hand.length; h++) {
      var hc = hand[h];
      if (!hc) continue;
      if (hc.cost != null && hc.cost < 0) {
        violations.push('negative cost in ' + sides[sd] + ' hand: ' + hc.name + ' (' + hc.cost + ')');
      }
    }
  }

  if (state.gameOver && !state.winner && state.winner !== null) {
    // null is allowed (stalled draw); but `undefined` indicates the engine
    // forgot to set the field at all.
    violations.push('gameOver=true but winner is undefined');
  }

  if (ctx && ctx.round > ctx.maxRounds) {
    violations.push('exceeded max rounds (' + ctx.maxRounds + ') without gameOver');
  }

  // ALSO run the ENGINE's own invariant sweep (Game.checkInvariants) so the
  // fuzzer enforces exactly what the live game asserts — one invariant
  // definition, no drift between the sim's copy and the engine's. The engine
  // sweep returns its violation strings (its console/telemetry dedup is
  // independent of the returned array).
  try {
    if (typeof Game !== 'undefined' && typeof Game.checkInvariants === 'function') {
      var engineV = Game.checkInvariants('fuzz') || [];
      for (var e = 0; e < engineV.length; e++) violations.push(engineV[e]);
    }
  } catch (err) {
    violations.push('engine checkInvariants threw: ' + (err && err.message ? err.message : err));
  }

  return violations;
}

// ---------------- random-move controller ----------------
// Replaces AI.playCards / AI.playTricks for the fuzzer. Picks a UNIFORMLY
// RANDOM legal action each step — that's the property under test: "no
// matter what stupid sequence of legal moves players make, engine
// invariants must hold." The OPTIONAL bias (always-play if energy + lane
// available) is gated behind skipProb so we still cover the no-play branch.
function randomCardsTurn(rng, owner, opts) {
  var s = Game.state;
  var safety = 0;
  while (safety++ < 50) {
    if (s.gameOver) return;
    var hand = (s[owner] && s[owner].hand) ? s[owner].hand.slice() : [];
    if (!hand.length) return;
    // Affordable cards only — playCard returns false otherwise and we'd loop.
    var affordable = [];
    for (var i = 0; i < hand.length; i++) {
      var c = hand[i];
      var cost = Game.getCardCost(owner, c);
      if (cost > s[owner].currency) continue;
      if (c.isDiscardEffect) {
        affordable.push({ card: c, lane: 0, isDiscard: true });
      } else {
        var open = Game.getOpenLanes(owner);
        for (var j = 0; j < open.length; j++) {
          affordable.push({ card: c, lane: open[j], isDiscard: false });
        }
      }
    }
    if (!affordable.length) return;
    // Random skip — but only when there are MULTIPLE options. With a single
    // option we always play it, otherwise the game can perma-stall when one
    // seat draws nothing playable for several turns and the round timer
    // won't fire because both seats keep deferring.
    if (rng() < opts.skipProb && affordable.length > 1) return;
    var pick = affordable[Math.floor(rng() * affordable.length)];
    try {
      Game.playCard(owner, pick.card, pick.lane);
    } catch (e) {
      throw e;
    }
  }
}

function randomTricksTurn(rng, owner, opts) {
  var s = Game.state;
  var safety = 0;
  while (safety++ < 50) {
    if (s.gameOver) return;
    var hand = (s[owner] && s[owner].trickHand) ? s[owner].trickHand.slice() : [];
    if (!hand.length) return;
    var playable = [];
    for (var i = 0; i < hand.length; i++) {
      var t = hand[i];
      var cost = Game.getTrickCost ? Game.getTrickCost(owner, t) : (t.cost || 0);
      if (cost > s[owner].currency) continue;
      // Skip tricks whose canPlay returns false — playTrick refuses them
      // and we'd just spin.
      if (t.canPlay && !t.canPlay(Game, owner)) continue;
      playable.push(t);
    }
    if (!playable.length) return;
    if (rng() < opts.skipProb) return;
    var pick = playable[Math.floor(rng() * playable.length)];
    try {
      Game.playTrick(owner, pick);
    } catch (e) {
      throw e;
    }
  }
}

// ---------------- game driver ----------------
// Mirrors the structure of runSimGame in shim.js, but swaps in our
// random-move controller for the per-turn phases. We intercept Math.random
// during each turn so prompt callbacks (which the shim auto-resolves) also
// pull from our seeded stream — otherwise reruns on the same seed are
// non-deterministic.
function runFuzzedGame(seed, opts, report) {
  var rng = mulberry32(seed);
  // Hijack Math.random for determinism. The native fn is restored on exit.
  var origRandom = Math.random;
  Math.random = rng;

  var lastViolationKeys = {};
  function recordViolations(stage, list) {
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      // Dedupe by (round, stage, message) so a stuck negative-HP card
      // doesn't print N times per round.
      var key = (Game.state ? Game.state.round : 'pre') + '|' + stage + '|' + v;
      if (lastViolationKeys[key]) continue;
      lastViolationKeys[key] = true;
      report.violations++;
      print('[FUZZ-VIOLATION] seed=' + seed + ' round=' + (Game.state ? Game.state.round : '?') + ' phase=' + (Game.state ? Game.state.phase : '?') + ' stage=' + stage + ' :: ' + v);
    }
  }

  try {
    Game.init();
    Game.state.player.isHuman = false;
    Game.state.ai.isHuman = false;
    Game.startMatch('classic');

    // Drive the draft using AI picker (random-pick of cards for fuzzing
    // would just slow things down without exercising new code — the
    // engine code we care about runs after the draft).
    while (Game.state.phase === 'draft-cards' || Game.state.phase === 'draft-tricks') {
      var d = Game.state.draft;
      if (!d.playerChoices || d.playerChoices.length === 0) {
        if (d.phase === 'cards') Game.finishCardDraft(); else Game.finishTrickDraft();
        break;
      }
      var pick = d.phase === 'cards'
        ? AI.pickDraftCard(d.playerChoices, d.playerDrafted)
        : AI.pickDraftTrick(d.playerChoices, d.playerTrickDrafted);
      var idx = d.playerChoices.indexOf(pick);
      Game.draftPick(idx >= 0 ? idx : 0);
    }

    var safety = 0, lastRound = -1;
    while (!Game.state.gameOver) {
      var phase = Game.state.phase;
      var ownerForPhase = phase.indexOf('player') === 0 ? 'player'
                        : phase.indexOf('ai') === 0 ? 'ai' : null;
      switch (phase) {
        case 'player-cards':
        case 'ai-cards':
          randomCardsTurn(rng, ownerForPhase, opts);
          recordViolations('after-cards-' + ownerForPhase, checkInvariants(Game.state));
          Game.endPhase1();
          break;
        case 'player-cards-tricks':
        case 'ai-cards-tricks':
          randomCardsTurn(rng, ownerForPhase, opts);
          randomTricksTurn(rng, ownerForPhase, opts);
          recordViolations('after-cardstricks-' + ownerForPhase, checkInvariants(Game.state));
          Game.endPhase2();
          break;
        case 'player-tricks':
        case 'ai-tricks':
          randomTricksTurn(rng, ownerForPhase, opts);
          recordViolations('after-tricks-' + ownerForPhase, checkInvariants(Game.state));
          Game.endPhase3();
          break;
        case 'combat':
          if (Game.state._combatContinuation) Game.resumeCombatIfWaiting();
          else Game.resolveCombat();
          recordViolations('after-combat', checkInvariants(Game.state));
          break;
        default:
          // Unknown phase — bail rather than spin.
          recordViolations('unknown-phase-' + phase, ['unhandled phase: ' + phase]);
          Game.state.gameOver = true;
          break;
      }
      // End-of-round invariant pass. The phase ticker resets `safety`
      // per-round so a long combat doesn't get falsely flagged as a stall.
      if (Game.state.round !== lastRound) {
        if (lastRound >= 0) {
          recordViolations('end-of-round-' + lastRound, checkInvariants(Game.state, { round: lastRound, maxRounds: opts.maxRounds }));
        }
        lastRound = Game.state.round;
        safety = 0;
      } else {
        safety++;
      }
      if (safety > 500) {
        // Stall — log it as a violation; this is the "no infinite loop"
        // invariant. We still set gameOver so the outer loop terminates.
        recordViolations('stall', ['phase loop stalled at round ' + Game.state.round + ' phase=' + Game.state.phase]);
        Game.state.gameOver = true;
        Game.state.winner = Game.state.player.health > Game.state.ai.health ? 'player'
          : Game.state.ai.health > Game.state.player.health ? 'ai' : null;
        break;
      }
      if (Game.state.round > opts.maxRounds) {
        recordViolations('max-rounds', ['exceeded ' + opts.maxRounds + ' rounds']);
        Game.state.gameOver = true;
        Game.state.winner = Game.state.player.health > Game.state.ai.health ? 'player'
          : Game.state.ai.health > Game.state.player.health ? 'ai' : null;
        break;
      }
    }

    // Final invariant pass once gameOver is set.
    recordViolations('final', checkInvariants(Game.state));
    if (Game.state.gameOver && Game.state.winner === undefined) {
      recordViolations('final', ['gameOver=true but winner is undefined']);
    }
    return { rounds: Game.state.round, winner: Game.state.winner };
  } catch (e) {
    report.crashes++;
    var msg = (e && e.message) ? e.message : String(e);
    var stack = (e && e.stack) ? '\n  ' + e.stack.split('\n').slice(0, 4).join('\n  ') : '';
    print('[FUZZ-CRASH] seed=' + seed + ' round=' + (Game.state ? Game.state.round : '?') + ' phase=' + (Game.state ? Game.state.phase : '?') + ' :: ' + msg + stack);
    return { rounds: Game.state ? Game.state.round : 0, winner: null, crashed: true };
  } finally {
    Math.random = origRandom;
  }
}

// ---------------- main ----------------
var __argv = (typeof arguments !== 'undefined') ? arguments : [];
var opts = parseArgs(__argv);

print('=== fuzz: runs=' + opts.runs + ' seed=' + opts.seed + ' skipProb=' + opts.skipProb + ' maxRounds=' + opts.maxRounds + ' ===');

var report = { crashes: 0, violations: 0 };
var t0 = Date.now();
for (var g = 0; g < opts.runs; g++) {
  // Per-game seed = base + index so each game's PRNG stream is unique but
  // any individual game can be replayed by setting --seed to that value.
  runFuzzedGame(opts.seed + g, opts, report);
  if (opts.verbose && (g + 1) % 25 === 0) {
    print('[fuzz] completed ' + (g + 1) + '/' + opts.runs + ' (' + report.crashes + ' crashes, ' + report.violations + ' violations so far)');
  }
}
var dt = (Date.now() - t0) / 1000;

print('');
print('=== fuzzed ' + opts.runs + ' games — ' + report.crashes + ' crashes, ' + report.violations + ' invariant violations === (' + dt.toFixed(2) + 's)');

if (report.crashes > 0 || report.violations > 0) {
  // jsc has no process.exit; quit(N) silently succeeds in this build.
  // Throwing yields a non-zero exit (3) which CI can gate on.
  throw new Error('fuzzer found ' + report.crashes + ' crashes and ' + report.violations + ' invariant violations');
}
