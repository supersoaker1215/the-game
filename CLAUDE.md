# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Card Lane Battle — a browser-based lane card battler. Pure vanilla JS/HTML/CSS:
no build tools, no package manager, no framework. Deployed to GitHub Pages at
https://supersoaker1215.github.io/the-game/

- **142 cards, 47 tricks** (counted from `cards.js` / `tricks.js`)
- **1v1 on 6 lanes** (`Game.LANE_COUNT`), **2v2 on 8** (`Game.LANE_COUNT_2V2`)
- Human vs AI, **and online multiplayer** — 1v1 over PeerJS (`multiplayer.js`)
  and 4-seat 2v2 (`Game.state.twoVTwo`), with AI filling any empty seat
- Draft, roguelite mode, tournament modifiers, random events

**2v2 is not a skin on 1v1.** A "side" (`state.player` / `state.ai`) is a proxy
for a TEAM of two; the real hands, energy and tricks live on
`twoVTwo.players[p1..p4]`, and anything written to the side proxy is silently
discarded on the next bridge. Most 2v2 bugs in this repo's history are one of
two shapes: a write that went to the proxy instead of the seat, or per-round
work that `startRound` does in 1v1 and `start2v2Round` was never taught.

## Running the Game

```bash
python3 -m http.server 8080
```
Then open `http://localhost:8080`. A launch.json config exists at `.claude/launch.json` for the preview server.

There is no linter and no build step. There ARE tests — a lot of them — and they gate every push.

## Tests and audits — run these before you push

```bash
./sim/run-tests.sh     # 64 suites: unit tests, golden matches, and static audits
./sim/run-fuzz.sh      # 500 1v1 + 60 2v2 fuzzed games, invariant checks
```

**Gate on the EXIT CODE, never on the printed text** — several suites print
per-case lines that contain the word "failed" while still passing overall.

`sim/test.js` is the main unit suite (500+ cases). The rest of `sim/` is a mix
of behavioural suites and static audits that parse the source: `css-parse.js`
(a comment that closes early eats the rule below it), `card-tube.js` (which
glow actually wins the cascade), `gfx-budget.js` (nothing may repaint every
frame at the Normal graphics tier), `mpwire.js` (multiplayer payload budget).

When you fix a bug, write the regression test FIRST and prove it fails against
the current HEAD before you fix it:

```bash
git archive HEAD | tar -x -C /tmp/pre && cp sim/test.js /tmp/pre/sim/test.js
cd /tmp/pre && jsc sim/test.js     # your new case must FAIL here
```

## Deploying

**This is automatic now — you should not be editing version numbers by hand.**

```bash
cp tools/pre-commit.sample .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

Run that once per clone. From then on every commit stamps itself: any file
whose contents changed gets its `?v=N` incremented in `index.html`, and
`CACHE_VERSION` in `sw.js` is bumped once for the deploy. It is idempotent, so
a commit that touched nothing versioned is silent.

Both numbers matter. The `?v=` alone does not refresh a returning player's
service worker — it keeps serving the old `CODE_CACHE` until `CACHE_VERSION`
changes, so they stay on stale code and re-report bugs you already fixed.
Measured over 30 days before this existed: **42 of 343** commits that touched
engine JS shipped with no `sw.js` bump. One deploy in eight went out invisible.

`./sim/run-tests.sh` checks this against **HEAD**, not your working tree — so
it tells you whether what you already pushed is correct, and never nags while
you are mid-edit. To fix a commit that slipped through (a co-author without the
hook, a `--no-verify`):

```bash
jsc tools/stamp-cache.js
```

`?v=` values stay INTEGERS on purpose. `multiplayer.js` derives its version
handshake from them with `/(game|ui|multiplayer|cards|abilities)\.js\?v=(\d+)/`
— a content hash there would silently break the check that warns two players
they are on different builds.

`CACHE_VERSION` keeps its `clb-v<N>-<name>` shape: the stamper only moves the
number, so you are free to rename the tail to describe what shipped.

## Vendored code

`peerjs.min.js` is committed directly — 93KB of third-party code that is the
entire multiplayer transport, and **nothing in `sim/` exercises it**.
`tools/vendor.json` pins its version and sha256, and the test gate verifies the
hash every run, so a silent change shows up there instead of as a multiplayer
bug nobody can place. Upgrading it means testing a real two-client game before
pushing.

## Running simulations

Headless self-play uses JavaScriptCore (macOS built-in). Node is NOT required. Driver scripts live in `sim/`.

```bash
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc

# Smoke test — 20 AI-vs-AI games, clean exit <2s
$JSC sim/run.js -- --games 20

# Stats run — ~30 games/sec, writes card/trick win rates to sim/data/report.md
$JSC sim/run.js -- --games 5000 --stats --quiet

# Load tuned weights before the run
$JSC sim/run.js -- --games 5000 --weights sim/data/weights-current.json --stats
```

`sim/shim.js` stubs `UI` / `document` / `setTimeout` so game.js runs without a browser; `runSimGame(weightsP, weightsA, collect)` is the shared game driver used by both run.js and tune.js.

### CEM weight tuner

`AI.WEIGHTS` (defined at the top of `ai.js`) is the CEM search space — ~30 tunable constants covering draft curve, threat scoring, defensive thresholds, and trick evaluation. Defaults reproduce the hand-tuned behavior exactly.

```bash
# Full run: 10 generations × 30 population × 40 games/sample (~10 min)
$JSC sim/tune.js -- --generations 10 --pop 30 --games 40

# Quick sanity run: 2 gen × 8 pop × 20 games (~15s)
$JSC sim/tune.js -- --generations 2 --pop 8 --games 20

# Resume from a prior champion
$JSC sim/tune.js -- --seed sim/data/weights-current.json --generations 10
```

Output:
- `sim/data/weights-current.json` — running champion (load this in the browser at some point to use the learned AI)
- `sim/data/weights-gen-N.json` — per-generation distribution mean
- `sim/data/tune-log.md` — progress table (best/mean/elite win rates per gen)

### Testing workflows

**Card balance changes** — edit `cards.js` / `abilities.js` / `tricks.js`, then:
```bash
$JSC sim/run.js -- --games 5000 --stats --quiet
```
Diff the new `sim/data/report.md` against the prior one. A card's win rate moving ≥3% (outside the ~±2.5% Wilson CI at n=200) is a real shift. High drafts × low plays means the AI is hoarding the card — usually a sign of an oppressive cost or a dead-in-hand condition.

**2v2 ability audit** — plays EVERY card and EVERY trick in a 2v2 online room and
reports anything that would hold the table up:
```bash
$JSC sim/audit2v2.js -- --verbose
```
Findings are `THREW` (hook raised an exception — the engine swallows these, so
in a live game the card just does nothing), `STUCK` (the table was still locked
after the card resolved), `UNOWNED` / `MISROUTED` (a 2v2 prompt with no owning
seat, or answered by a seat on the wrong side), and `NOFIRE` (a declared hook
that never ran). It uses `sim/shim-real.js`, which loads the same headless
environment as `sim/shim.js` but leaves the engine's REAL prompt system in place
— that is what makes prompt routing observable at all.

**2v2 AI sensitivity probes** — before tuning a dimension, find out whether it
is worth anything. `--cripple X` sabotages ONE of the control arm's decisions
and measures what it costs them:
```bash
$JSC sim/bench2v2.js -- --games 2400 --draft none --cripple lanes
```
Measured (n=2400, band ±2): `lanes` (random lane choice) 49.9% — lane choice is
worth nothing; `order` 57.2%; `blocks` 44.4% — the block planner was NEGATIVE;
`tricks` 66.0%; `onecard` 75.0%. That is how the +5.5pp win was found, after
five hand-designed heuristics measured as noise. Probe before you tune.

**2v2 AI benchmark / tuner** — four AI seats, full matches, A/B on the teamplay
weights (`AI.WEIGHTS.team*`, which are inert in 1v1 because `AI._2v2Ctx` returns
null there, so nothing found here can move 1v1 balance):
```bash
$JSC sim/bench2v2.js -- --games 4800                      # A/B win rate, with a noise band
$JSC sim/tune2v2.js  -- --generations 6 --pop 10 --games 300   # CEM over those four keys
```
Read the band before the number: at n=1200 anything inside 47–53% is noise, and
a tuner "winner" scored over 300 games routinely evaporates at 4800 (one did —
59.3% in the tuner, 49.3% confirmed). The teamplay weights currently ship at 0
because nothing found so far beat the baseline at a sample size that could tell.

**1v1 ↔ 2v2 parity** — the rule is "2v2 mirrors 1v1; only seat/energy/team
plumbing differs". This enforces it: every card is played twice over the same
board, hands and seed, with prompts resolved the same way, and the results are
diffed.
```bash
$JSC sim/parity2v2.js -- --verbose
```
Cards that are SUPPOSED to differ with four players are listed in the script's
`EXPECTED` map with the reason; anything else lands under UNEXPECTED and is a
regression. Re-seed points inside the harness matter — the two modes consume
different amounts of RNG during setup, so the seed AND the summon deck are reset
immediately before the card acts.

**Bug fix verification** — run a small sanity batch first:
```bash
$JSC sim/run.js -- --games 500 --quiet 2>&1 | grep -E "stuck|ERR|WARN"
```
Any output here means the fix introduced a regression (stuck phase, exception in a callback). Clean output + similar seat-split to baseline (~50/50) = safe to ship.

**Applying tuned weights to the browser**
- Quick: paste `sim/data/weights-current.json` values into the `AI.WEIGHTS` defaults at the top of `ai.js`
- Non-destructive: add a `fetch('sim/data/weights-current.json')` at ai.js load time that merges into `AI.WEIGHTS` — lets you re-tune without code edits

**Separating "weak card" from "AI plays it wrong"** — after tuning, re-run stats with `--weights sim/data/weights-current.json`. Cards that climb were AI blind spots. Cards that stay bottom-tier are candidates for design tweaks (cost / stats / ability rework). Look at plays-per-draft: near-100% means the AI plays it and it loses (design issue); lower means the AI leaves it in hand (AI issue).

## Architecture

**Load order** (defined in `index.html`): `cards.js` → `tricks.js` → `abilities.js` → `game.js` → `ai.js` → `ui.js`

All files define globals — there are no modules or imports.

| File | Role |
|------|------|
| `cards.js` | `CARD_DEFS[]` — pure data (name, cost, attack, health, type, abilities, desc). No callbacks. |
| `tricks.js` | `TRICK_DEFS[]` — trick data with `play(G, owner)` callbacks |
| `abilities.js` | `CARD_ABILITIES{}` — card callback functions (`onPlay`, `onDeath`, etc.) and special properties (`passive`, `isDiscardEffect`, `actualCost`). Merges into `CARD_DEFS` at load time. |
| `game.js` | `Game` object — single source of truth for all state, phases, combat resolution, targeting modals, card mechanics |
| `ai.js` | `AI` object — decision-making for the AI opponent; calls `Game.playCard`/`Game.playTrick` |
| `ui.js` | `UI` object — DOM rendering, user click handlers, modal display; reads `Game.state` and calls `Game.*` methods |
| `style.css` | Dark theme; player=green, AI=red, currency=orange, tricks=green-bordered |

**Data flow:** User click → `UI` handler → `Game` mutation → `UI.render()`. AI turn → `AI` calls `Game` → `UI.render()`.

## Game State

`Game.state` is the single mutable state object. Key parts:
- `phase` — controls what the player can do (`draft-cards`, `player-cards`, `player-tricks`, `combat`, etc.)
- `lanes[0..5]` — each has `{ player: card|null, ai: card|null, destroyed, protected }`
- `player` / `ai` — health, currency, hand, trickHand, deadPile, discardPile, blockMeter, flags
- `drawPile` / `trickDrawPile` — shared decks (not per-player)
- `pendingCardChoice` / `pendingLaneChoice` — modal state for targeting prompts

## Card System

Card definitions in `CARD_DEFS` are templates. `Game.createCardInstance(def, owner)` copies them and applies abilities via `Game.applyAbilities(card)`, which parses strings like `"Evade 2"` into `evadeCharges: 2`.

Cards use callback hooks: `onPlay`, `onDeath`, `onDamaged`, `onKill`, `onBeforeTricks`, `onBeforeAttack`, `onEndOfTurn`, `onAnyCardPlayed`, `onAllyKilled`, `onEvade`. Inside callbacks, `G` is the Game object and `self` is the card instance.

Tricks have `play(G, owner)` callbacks.

## Player Targeting

All player-facing choices go through:
- `Game.promptCardChoice(owner, cards, title, desc, callback, aiPicker)` — pick a card from a list
- `Game.promptLaneChoice(owner, lanes, title, desc, callback)` — pick a lane
- `Game.summonCardChoice(owner, name, cost, atk, hp, abilities, onComplete)` — summon + pick lane

These set `pendingCardChoice`/`pendingLaneChoice` on state, then `UI.render()` shows a modal. When the player clicks, the callback fires. The `aiPicker` param is a function the AI uses to auto-select.

## Round Flow

1. **Draft** — 5 card picks + 2 trick picks (pick 1 of 2 each round)
2. **Round loop**: `startRound()` → Phase 1 (first player cards) → Phase 2 (second player cards+tricks) → Phase 3 (first player tricks) → `resolveCombat()` → `drawPhase()` → repeat
3. **Combat** — per-lane: check taunt/fear/mind-control targets, apply evade → armor → damage → splash → overdrive. Uncontested cards hit opponent health directly.

## Key Mechanics

- **Currency/Energy** = round number + passives; resets each round
- **Block Meter** (0-8) — fills from damage taken; at 8 draws a free trick
- **Jump** — horror cards (Jason, Michael Myers, Ghostface) glow in hand when condition met; player can deploy free
- **Batman Who Laughs intercept** — `nextCardStolen` flag on opponent; intercepted card goes to your hand with keep/destroy choice
- **Magneto debuffs** — `applyMagnetoDebuffs()` / `removeMagnetoDebuffs()` run each round; affect even-numbered lanes

## Common Patterns When Adding Cards

New card data in `cards.js`:
```js
{ name: "Name", cost: N, attack: N, health: N, type: "hero"|"villain",
  abilities: ["Evade 1", "Armor 2"],  // parsed by applyAbilities
  desc: "Human-readable description" }
```

New card abilities in `abilities.js` (keyed by card name in `CARD_ABILITIES`):
```js
"Name": {
  onPlay(G, self, lane) {
    // Use G.promptCardChoice for player targeting
    // Use G.getEnemiesOf(self.owner) / G.getAlliesOf(self.owner) for queries
    // Use G.dealDamage(target, amount, source) for damage
    // Use G.killCard(target) for destruction
    // Use G.summonCardChoice for summoning
    // Use G.grantTempBuff(target, { attack: 2, currentHealth: 2, maxHealth: 2 }) for temp buffs
  },
  passive: "passiveName"  // optional
}
```

**Buff duration rule:** Any buff a card grants to ANOTHER card (not self) without an explicit duration defaults to 1 turn. Use `G.grantTempBuff(target, buffs, duration=1)` — numeric props are additive, boolean props are set-and-revert. Self-buffs (e.g., `self.attack += 1` from `onKill`) are permanent. Cards with their own duration counters (`tauntTurns`, `invincibleTurns`) bypass this system.

New trick in `tricks.js`:
```js
{
  name: "Name", cost: N,
  desc: "Description",
  play(G, owner) { /* effect */ }
}
```
