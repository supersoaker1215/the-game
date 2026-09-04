#!/bin/bash
# CI-ready self-play fuzz runner. Drives both seats with random legal moves
# and asserts BOTH the sim's structural checks AND the engine's own
# Game.checkInvariants sweep after every phase. Fails (exit 1) on any crash or
# invariant violation so it can gate a build.
#
# Usage:   sim/run-fuzz.sh [RUNS] [SEED]      (defaults: 500 games, seed 0)
# Repro a failure:  jsc sim/fuzz.js -- --runs 1 --seed <SEED>
JSC="/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"
RUNS="${1:-500}"
SEED="${2:-0}"
cd "$(dirname "$0")/.." || exit 2
if [ ! -x "$JSC" ]; then echo "jsc not found at $JSC"; exit 2; fi
OUT="$("$JSC" sim/fuzz.js -- --runs "$RUNS" --seed "$SEED" 2>&1)"
echo "$OUT" | grep -E "FUZZ-VIOLATION|=== fuzzed" | tail -20
if echo "$OUT" | grep -qE "[1-9][0-9]* crashes|[1-9][0-9]* invariant violations|FUZZ-VIOLATION|threw:"; then
  echo "❌ FUZZ FAILED — crashes or invariant violations detected (see above)."
  exit 1
fi

# ---- 2v2, which was silently covering nothing until 2026-09-03 -------------
# sim/fuzz2v2.js called end2v2Phase() with no actor, and end2v2Phase refuses to
# end a live human's turn for them — so every game stalled on its first
# sub-phase and the fuzzer reported "avg 1.0 rounds" while exercising zero
# cards. Now that it names the acting seat it plays real games, so it gates too.
G2V2="${3:-60}"
OUT2="$("$JSC" sim/fuzz2v2.js -- --games "$G2V2" 2>&1)"
echo "$OUT2" | grep -E "=== 2v2 FUZZ|distinct cards|WITHOUT an owning seat|invariant violations" | tail -6
if echo "$OUT2" | grep -qE "games with invariant violations: [1-9]|FATAL|STALLED|TURN CAP"; then
  echo "❌ 2v2 FUZZ FAILED — see above."
  exit 1
fi
# A run that plays no rounds is a pass by vacuum — refuse it.
if echo "$OUT2" | grep -qE "avg (0\.[0-9]|1\.[0-4]) rounds"; then
  echo "❌ 2v2 FUZZ FAILED — games are not progressing (avg rounds too low to be covering anything)."
  exit 1
fi
echo "✅ FUZZ PASSED — $RUNS 1v1 games + $G2V2 2v2 games, 0 crashes, 0 invariant violations."
