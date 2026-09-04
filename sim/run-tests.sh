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
    # SAY WHY. The filter above prints only "passed," / "Failures:" / "  - "
    # lines, so a suite that reports `0 failed` and still trips this — because
    # an error TOKEN appeared anywhere in its output, including a console.error
    # the engine deliberately swallowed — printed a bare ❌ with nothing to act
    # on. That happened twice, and the second time it was mistaken for a real
    # failure and then for noise, which is the worst of both. Echo the lines
    # that actually tripped it.
    if ! echo "$out" | grep -qE "[1-9][0-9]* failed"; then
      echo "     (suite reported 0 failed — tripped by an error token in its output:)"
      echo "$out" | grep -nE "Exception|SyntaxError|TypeError|ReferenceError|threw:" | head -5 | sed 's/^/     /'
    fi
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
echo "=== before-tricks.js (Start of Tricks recurs unless the card says once) ==="
run_suite sim/before-tricks.js

echo ""
echo "=== prompt-clock.js (every 2v2 prompt slot has a timeout) ==="
run_suite sim/prompt-clock.js

echo ""
echo "=== hand-empower.js (an empower needs a body to land on) ==="
run_suite sim/hand-empower.js

echo ""
echo "=== local-2v2.js (a local 2v2 is still a 2v2) ==="
run_suite sim/local-2v2.js

echo ""
echo "=== lategame-growth.js (a round-16 match is the same game as a round-5 one) ==="
run_suite sim/lategame-growth.js

echo ""
echo "=== moder-lane-lock.js (one answer to which lanes are placeable) ==="
run_suite sim/moder-lane-lock.js

echo ""
echo "=== ai-targeting.js (the bot's target picks) ==="
run_suite sim/ai-targeting.js

echo ""
echo "=== absorbed-hit.js (a shield stops the damage, not the swing) ==="
run_suite sim/absorbed-hit.js

echo ""
echo "=== seat-scope.js (your cards, not your team's) ==="
run_suite sim/seat-scope.js
echo ""
echo "=== log-secrecy.js (what you drew is yours) ==="
run_suite sim/log-secrecy.js

echo ""
echo "=== card-tube.js (the frame's neon stack is reachable, not dead code) ==="
run_suite sim/card-tube.js

echo ""
echo "=== css-parse.js (the stylesheet says what it looks like it says) ==="
run_suite sim/css-parse.js

echo ""
if [ "$FAIL" -ne 0 ]; then
  echo "❌ TESTS FAILED — see suites above."
  exit 1
fi
echo "✅ ALL GOLDEN/SNAPSHOT SUITES PASSED."
