#!/bin/bash
# BALANCE DRIFT — a report, not a gate.
#
#   sim/run-balance.sh            compare against the committed baseline
#   sim/run-balance.sh --update   re-baseline (do this WITH the change that
#                                 moved the numbers, in the same commit)
#
# The four tools below MEASURE rather than assert: a balance change SHOULD move
# them, so failing a build on a delta would be wrong. What the baseline buys is
# that the change shows up as a NUMBER instead of a feeling — "hard feels
# easier" becomes "hard winrate 52.0 -> 44.1 over 200 games".
#
# THE NUMBERS ONLY MEAN ANYTHING BECAUSE THE RUNS ARE SEEDED. All four drew from
# Math.random until 2026-09-14, so two runs of an unchanged build disagreed and
# a real change was indistinguishable from noise. Seeding had three separate
# causes to fix: startMatch re-seeds itself from Math.random unless _seedLocked
# is set (so a plain seedMatch beforehand was silently overwritten — use
# Game.startSeededRun), and the shim's prompt pickers had a Math.random coin of
# their own. See the notes in sim/shim.js.
#
# SAMPLE SIZE IS PART OF THE READING. difficulty.js runs 200 games, so its
# winrate carries roughly +/-7pp at 95% — 52.0 and 48.0 are the same number.
# Raise it (`--games 2000`) before concluding anything from a small move.
JSC="/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"
cd "$(dirname "$0")/.." || exit 2
[ -x "$JSC" ] || { echo "jsc not found at $JSC"; exit 2; }
BASE="sim/data/balance-baseline.txt"
TOOLS="aggression difficulty round1-open combat-diff"

CUR="$(mktemp)"
for t in $TOOLS; do
  out="$("$JSC" "sim/$t.js" 2>&1)"
  if ! echo "$out" | grep -q '^METRIC '; then
    echo "❌ sim/$t.js produced no METRIC lines — it threw?"
    echo "$out" | tail -5 | sed 's/^/     /'
    rm -f "$CUR"; exit 2
  fi
  echo "$out" | grep '^METRIC ' | sed 's/^METRIC //' >> "$CUR"
done

if [ "$1" = "--update" ]; then
  mkdir -p sim/data
  { echo "# balance baseline — captured $(date -u +%Y-%m-%dT%H:%MZ)"
    echo "# regenerate with sim/run-balance.sh --update, in the SAME commit as the change that moved it"
    sort "$CUR"; } > "$BASE"
  echo "baselined $(grep -c '=' "$BASE") metrics -> $BASE"
  rm -f "$CUR"; exit 0
fi

if [ ! -f "$BASE" ]; then
  echo "no baseline yet — run: sim/run-balance.sh --update"
  cat "$CUR" | sed 's/^/  /'; rm -f "$CUR"; exit 0
fi

echo "=== BALANCE DRIFT vs $BASE ==="
printf "  %-28s %10s %10s %10s\n" metric baseline now delta
moved=0
while IFS='=' read -r k v; do
  [ -z "$k" ] && continue
  case "$k" in \#*) continue;; esac
  now="$(grep "^$k=" "$CUR" | head -1 | cut -d= -f2)"
  if [ -z "$now" ]; then printf "  %-28s %10s %10s %10s\n" "$k" "$v" "GONE" "-"; moved=1; continue; fi
  d="$(python3 -c "
try:
    a=float('$v'); b=float('$now'); print(('%+.2f'%(b-a)) if abs(b-a)>1e-9 else '-')
except Exception: print('?' if '$v'!='$now' else '-')")"
  [ "$d" != "-" ] && moved=1
  printf "  %-28s %10s %10s %10s\n" "$k" "$v" "$now" "$d"
done < "$BASE"
# a metric that exists now but not in the baseline
while IFS='=' read -r k v; do
  grep -q "^$k=" "$BASE" || { printf "  %-28s %10s %10s %10s\n" "$k" "NEW" "$v" "-"; moved=1; }
done < "$CUR"
rm -f "$CUR"
echo ""
if [ "$moved" = "1" ]; then
  echo "numbers moved. if that was the point, re-baseline in the same commit:"
  echo "  sim/run-balance.sh --update"
else
  echo "no drift — every metric matches the baseline exactly."
fi
exit 0
