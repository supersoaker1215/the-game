# Sourced (not executed) by sim/*.sh to locate the JavaScriptCore shell.
# Sets JSC to the first that works:
#   1. $JSC, if the caller already set it to an executable (explicit override)
#   2. the macOS system framework binary
#   3. `jsc` on PATH — on Debian/Ubuntu: apt-get install libjavascriptcoregtk-bin
# Leaves JSC empty if none is found; callers report that and exit.
_find_jsc() {
  if [ -n "$JSC" ] && [ -x "$JSC" ]; then return; fi
  local c
  for c in /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
           /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc; do
    if [ -x "$c" ]; then JSC="$c"; return; fi
  done
  JSC="$(command -v jsc 2>/dev/null)"
}
_find_jsc
unset -f _find_jsc
