# CI workflows

`ci.yml` runs on every push and pull request to any branch. It mirrors the
three commands the maintainer runs locally before every `sw.js` cache-version
bump. All three must pass for a green build.

## Checks

### 1. JSC regression test suite
- **Command:** `jsc sim/test.js`
- **Enforces:** Card / trick / ability / relic regressions caught in past
  playtests. Each fixed bug gets a test added so it can't silently come back.
- **Pass criteria:** stdout contains `=== N passed, 0 failed ===`. The script
  itself always exits 0, so the workflow greps the line.

### 2. Deno lint
- **Command:** `deno lint`
- **Config:** `deno.json` (`lint.include` covers 12 files: `cards.js`,
  `tricks.js`, `abilities.js`, `decks.js`, `engine/combat.js`, `game.js`,
  `ai.js`, `logger.js`, `multiplayer.js`, `roguelite.js`, `ui.js`, `sw.js`).
- **Enforces:** the `recommended` rule set minus a hand-picked exclude list
  (`no-unused-vars`, `no-empty`, `no-window`, `no-window-prefix`,
  `prefer-const`, `no-var`).
- **Pass criteria:** `deno lint` exits 0; footer reads `Checked 12 files`.

### 3. 500-game balance sim
- **Command:** `jsc sim/run.js -- --games 500 --quiet`
- **Enforces:** AI symmetry — neither seat may have a structural advantage.
  Both seats run the same `AI.WEIGHTS`, so a wide skew points to a sim bug,
  a card whose effect is owner-asymmetric, or a draft / coin-flip imbalance.
- **Pass criteria (balanced):** `|player_wins − ai_wins| ≤ 50`, i.e. each
  side within **±25 of the 250 expected wins**. The workflow also fails on
  zero output (treated as a crash). Draws (often 0–10) don't contribute to
  the balance check.

## Running locally

From the repo root:

```sh
# 1. Test suite — expect "=== 72 passed, 0 failed ==="
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc sim/test.js

# 2. Lint — expect "Checked 12 files" with no rule violations
deno lint

# 3. Balance sim — expect ~250/250 ±25, 0 crashes
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc sim/run.js -- --games 500 --quiet
```

On Ubuntu (CI), `jsc` is installed from `libjavascriptcoregtk-4.1-bin`
(falls back to `4.0-bin` on older runners) and symlinked to
`/usr/local/bin/jsc`. The two `jsc` invocations in CI therefore drop the
macOS Helpers path.

## Caveats

- `sim/test.js` and `sim/run.js` rely on JSC-only globals (`print`,
  `load`, `read`, the `arguments` array). They will not run under Node
  without modification.
- Test/sim scripts always exit 0; the workflow greps stdout for the
  pass / win-count lines and fails the step explicitly when expected
  text is missing.
- The balance threshold (`|diff| ≤ 50`) is a CI gate, not a release
  target — the maintainer eyeballs ±25 in practice. Tighten the gate
  once the sim is provably stable.
