#!/bin/bash
# CI-ready golden/snapshot test runner. Runs every headless regression
# suite and fails (exit 1) if ANY case fails or a suite crashes, so it
# can gate a build alongside sim/run-fuzz.sh.
#
#   sim/snapshots.js — pins Game.predictCombatGlobal (combat-math forecast)
#   sim/golden.js    — pins actual engine resolution of the trickiest
#                      status/keyword rules (Immunity/Unresistible,
#                      forced-freeze, canEffectLand gate, Revive)
#   sim/test.js      — mechanic-level unit suite (if present)
#
# Usage:  sim/run-tests.sh
JSC="/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"
cd "$(dirname "$0")/.." || exit 2
if [ ! -x "$JSC" ]; then echo "jsc not found at $JSC"; exit 2; fi

FAIL=0
run_suite() {
  local file="$1"
  [ -f "$file" ] || { echo "· skip $file (not present)"; return; }
  local out
  out="$("$JSC" "$file" 2>&1)"
  # Print the suite's summary line + any failure block.
  echo "$out" | grep -E "passed,|Failures:|^  - " | tail -40
  # A suite is bad if it reports a non-zero failed count, throws, or
  # emits a syntax/runtime error line.
  if echo "$out" | grep -qE "[1-9][0-9]* failed|Exception|SyntaxError|TypeError|ReferenceError|threw:"; then
    echo "  ❌ $file FAILED"
    FAIL=1
  else
    echo "  ✅ $file"
  fi
}

echo "=== snapshots.js (predictor goldens) ==="
run_suite sim/snapshots.js
echo ""
echo "=== golden.js (resolution goldens) ==="
run_suite sim/golden.js
echo ""
echo "=== test.js (mechanic units) ==="
run_suite sim/test.js

echo ""
echo "=== mpwire.js (MP wire budget + broadcast coalescing) ==="
run_suite sim/mpwire.js

echo "=== neverskip.js (a human's turn is only ended by that human) ==="
run_suite sim/neverskip.js

echo ""
echo "=== revive-and-record.js (revive resets once-per-life; dossier says HOW) ==="
run_suite sim/revive-and-record.js

echo ""
if [ "$FAIL" -ne 0 ]; then
  echo "❌ TESTS FAILED — see suites above."
  exit 1
fi
echo "✅ ALL GOLDEN/SNAPSHOT SUITES PASSED."
