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
echo "✅ FUZZ PASSED — $RUNS games, 0 crashes, 0 invariant violations."
