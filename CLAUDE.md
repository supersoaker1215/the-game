# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Card Lane Battle — a browser-based 2-player (human vs AI) strategy card game. ~95 hero/villain cards, ~27 tricks, 6-lane board, draft system, turn-based combat. Pure vanilla JS/HTML/CSS with no build tools, no package manager, no framework.

## Running the Game

```bash
python3 -m http.server 8080
```
Then open `http://localhost:8080`. A launch.json config exists at `.claude/launch.json` for the preview server.

There are no tests, no linter, and no build step. Cache-bust by incrementing the `?v=N` query params on script tags in `index.html` when changing JS files.

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
