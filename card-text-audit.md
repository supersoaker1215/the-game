# Card Text Audit

Tracking document for the 122-entry card/trick description standardization.

---

## Glossary (canonical forms)

### Triggers

| Canonical | Meaning |
|---|---|
| `When Played:` | Fires once when the card enters the board. |
| `When Destroyed:` | Fires once when the card dies. |
| `When Discarded:` | Fires when discarded from hand (discard-effect cards). |
| `When Damaged:` | Fires each time the card takes damage. |
| `Start of Tricks:` | Recurring — fires at the start of every trick phase. |
| `Start of Tricks (once):` | Same timing, fires once per game. |
| `Each Turn:` | Fires at the start of every round. |
| `While Active:` | Passive, always-on while the card is alive. |
| `On Kill:` | Fires when the card destroys an enemy. |
| `Jump:` | Conditional fast-play from hand (glowing, free). |

### Effect verbs

| Canonical | Replaces / avoids |
|---|---|
| `Summon a (X/Y) <Name>` | Create, Spawn |
| `Destroy` | Kill |
| `Deal N damage` | Do N damage |
| `Add (+X/+Y)` | Gain, Buff |
| `Remove (−X/−Y)` or `Remove N ATK` | Debuff, Reduce |
| `Heal N` / `Heal yourself for N` | Restore |
| `Draw a card` / `Draw N cards` | — |
| `Freeze 1` | (matches keyword) |
| `Devour` | (dead-pile removal, keeps current usage) |
| `Give <Keyword N>` | (already consistent) |
| `Steal` | (already consistent) |
| `Move to an empty lane` | Teleport, Swap |

### Target phrases

| Canonical | Use for |
|---|---|
| `an enemy` | Any single enemy (player chooses) |
| `a random enemy` | Engine picks uniformly |
| `the enemy opposite` | Same lane as this card |
| `an adjacent enemy` | Lane ±1 |
| `all enemies` | Everything on the opposing side |
| `an enemy with ≤ N ATK` | Conditional filter (use `≤` not `or less`) |
| `an enemy with ≤ N HP` | Same |
| `an ally` / `all allies` | Mirror of enemy forms |

### Numeric & stat format

- Summoned stats: **`(X/Y)`** — `(2/1)`, `(6/5)`. Always parens, slash, no spaces.
- Buff: **`(+X/+Y)`** — `(+1/+1)`, `(+2/+0)`. Always wrapped, always signed.
- Debuff: **`(−X/−Y)`** with a real minus `−` (U+2212), not hyphen.
- Ranges: hyphen-minus, e.g., `2-7`.
- Numerals always digits — no "two", no "three".

### Keywords (badges — never in desc text)

| Parameterized | Flag |
|---|---|
| `Evade N`, `Armor N`, `Invincible N`, `Revive N`, `Splash N`, `Taunt N`, `Immunity N` | `Bullseye`, `Overdrive`, `Hunt`, `Unresistible`, `Untrickable`, `Damage Immunity`, `Frozen`, `Stunned`, `Feared`, `Mind Control` |

**Rule:** If a keyword is in the `abilities` array, it must not appear in the `desc`. Bespoke twists on a keyword are fine (e.g., "When evading, gain (+1/+1)").

### Sentence mechanics

- Sentences end with `.`
- Multiple effects under one trigger separate with `.` (new sentence).
- Order inside a trigger: **self-effects → interactions with enemies → incidental draws/heals**.
- Card names inside desc text are not bolded or quoted.

### Mismatch resolution policy

Code is the source of truth. When desc and code disagree, rewrite the desc to match code unless flagged ⚠️ for explicit override.

---

## Batch progress

- [x] **Batch 1** — Glossary (this doc)
- [x] **Batch 2** — Cost 1 cards
- [x] **Batch 3** — Cost 2 cards
- [x] **Batch 4** — Cost 3 cards
- [x] **Batch 5** — Cost 4 cards
- [x] **Batch 6** — Cost 5 cards
- [x] **Batch 7** — Cost 6 cards
- [x] **Batch 8** — Cost 7–8 cards
- [x] **Batch 9** — Cost 9–10 cards
- [x] **Batch 10** — All tricks

---

## ⚠️ Mismatch resolution log

Surfaced as each batch is reviewed. Each entry: card name, what disagreed, the decision.

- **Harley Quinn** (batch 2) — desc said *"Takes 1 self-damage before attacking"* implying she loses 1 HP. Code actually damages the owner's HP bar (`damagePlayer(self.owner, 1)`). **Decision: text-to-match-code.** New desc: *"While Active: Deals 1 damage to your HP before attacking."*
- **Gamora** (batch 3) — desc said *"If no other allies, add (+1/+1)"* but the universal engine Lone Wolf at [game.js:535](game.js:535) already adds +1/+1 to any card entering alone, AND Gamora's own onPlay adds another +1/+1 on top. Net: she gets (+2/+2) when alone, not (+1/+1). **Decision: text-to-match-visible-code.** Removed the alone clause from desc entirely — Lone Wolf is a universal mechanic that doesn't need per-card mention. *Flag: Gamora's onPlay has a legacy +1/+1 that double-stacks with universal Lone Wolf; consider removing the Gamora-specific check in a future cleanup.*
- **Scarlet Witch** / **Star-Lord** / **Michael Myers** (batches 3/5) — all had lone-wolf clauses describing the universal mechanic. **Decision: dropped from desc** (same reasoning as Gamora — universal mechanic).
- **Scarlet Witch** (batch 3) — desc said *"Replace an ally with Scarlet Witch"* but code doesn't swap; it moves an existing ally to another lane while Scarlet Witch stays in her placed lane. **Decision: text-to-match-code.** New desc: *"Move an ally to another empty lane. Draw a card."*
- **Deadpool** (batch 5) — desc said *"Give Taunt 1 to all enemies tied for lowest ATK"*, implying enemies gain Taunt. Code actually gives **Deadpool himself** Taunt 1 with a selective filter (`tauntOnlyLowestAttack`) so only the lowest-ATK enemies are pulled. **Decision: text-to-match-code.**
- **Venom** (batch 5) — desc said *"Start of Tricks (once)"* but `onBeforeTricks` had no "once" guard — fired every tricks phase. **Resolved (code-to-match-text):** added `self.venomHealed` guard; "(once)" restored in desc.
- **Iron Man** (batch 6) — desc said *"Can be played during the Trick Phase"* but the card had no `trickPhasePlayable` flag. **Resolved (code-to-match-text):** added `trickPhasePlayable: true` to Iron Man's ability entry; desc restored.
- **Thor** (batch 8) — desc said *"Splash 5 and Freeze 1 all enemies hit"* implying the front enemy too, but code only iterated `[lane-1, lane+1]`, skipping the front. **Resolved (code-to-match-text):** Thor now iterates the 3-lane cone `[lane-1, lane, lane+1]`, matching every other splash source (game.js#splashDamage, game.js#applySplash). Canonical splash = front + both adjacents across all cards.
- **Yoda** (batch 8) — desc said *"Yoda and adjacent allies cannot be frozen"* but code has no freeze-immunity passive. **Decision: text-to-match-code.** Removed that clause.
- **Anakin Skywalker** (batch 9) — desc said *"Start of Tricks (once)"* but code had no once-guard. **Resolved (code-to-match-text):** added `self.anakinMoved` guard inside `strikeAt` (so the flag only flips after a valid move); "(once)" restored. The *"After destroying an enemy, move to the next lane"* clause still has no code support and stays removed.
- **Dormammu / Galactus / Trigon** (batch 9) — all had *"(once)"* descs that fired every turn in code. **Resolved (code-to-match-text):** added once-guards (`dormammuDrained`, `galactusDevoured`, `trigonFrozen`); "(once)" restored in all three descs. (Galactus's `onEndOfTurn` devour of 4+ ATK enemies remains recurring — that's the "Each Turn" line.)
- **Dormammu** (batch 9) — desc claimed *"Reorder the next 4 deck cards for 2 turns"* but the code uses the Dr. Strange reorder system which is 2 cards per turn. **Decision: text-to-match-code.** Rewrote to describe foresight (peek top 2, keep one, other goes to opponent) for 2 turns.
- **Two-Face Coin** (batch 10) — desc mentioned *"guess odd/even to add full Block or no Block"*, but the code only rolls 1-8 and adds that to Block Meter. **Decision: text-to-match-code.**
- **Lex Luthor** (batch 6) — desc claimed *"All bonus attacks are prevented"* but the `preventDraw` passive only blocked card draws. **Resolved (code-to-match-text):** `drainBonusAttacks` in game.js now checks for a living Lex Luthor on the opposing side and suppresses the queued bonus attack with a `[LUTHOR]` log entry; desc restored.
- **Hela** (batch 7) — desc said *"Draw a card from the shared Dead Pile — keep it or give it to the opponent"* but code just adds a random Dead Pile card to owner's hand without a keep/give prompt. **Decision: text-to-match-code.**
- **Homelander** (batch 7) — desc said *"Choose any allies to destroy. For each, deal damage..."* (plural), but code only prompts to sacrifice ONE ally for ONE damage hit. **Decision: text-to-match-code.** Changed to singular.
- **Magneto** (batch 7) — desc said *"Debuff removed"* noun form. **Decision: rephrased** to *"Debuffs are removed"* for glossary consistency.
- **Obi-Wan** (batch 7) — desc redundantly said *"Permanent Taunt"* even though `Taunt 99` already renders as a keyword badge. **Decision: dropped the redundant line.**

## Glossary amendment (batch 2)

- **Splash N as a one-shot effect** (e.g. Xenomorph's `When Destroyed: Splash 1`) stays in desc text as a verb phrase. The "keywords never in desc" rule only applies to persistent keyword attributes that render as badges via the `abilities` array. If a card triggers a splash effect once (on play, on death, on move), `Splash N` is the canonical verb form.

---

## Styling decision

**Option A — chosen.** `.card-desc` color changed from `#9caab4` (cool grey) to `#c5d2de` (cyan-tinted off-white). Applied in [style.css:1299](style.css:1299). No changes to trigger labels or hairlines — keep it clean.

---

## Re-audit pass — 2026-07-27 (commit 5145e9e)

Full second pass over all **144** entries (116 cards + 28 tricks). Every `desc` was
**re-derived from the implementation** rather than edited as prose, then
adversarially re-checked against that same code by a second reviewer.

**Result:** 84 rewritten, 15 corrected during review, 0 reverted, **93 code/text
mismatches** found and fixed. Verified mechanically that the diff touches zero
`cost`/`attack`/`health`/`abilities` lines — text only, no balance change.

### Notable mismatches (the card was lying to the player)

- **Galactus** — desc implied it devoured the whole ≤4-ATK pool each turn. Code sorts
  by threat and devours **one**. Genuine power-level misread.
- **Phantom Zone** — never said the returned card is a **fresh instance** (every buff,
  debuff and status wiped). That is the entire point of the trick.
- **Xenomorph** — "(not summoned)" was false; `onAnyCardPlayed` fires on summons too.
- **Wonder Woman** — chain damage does **not** decay per step; it recurses at full damage.
- **Dr. Strange** — the Foresee card **is** that round's draw for both seats, not a bonus.
- **Freddy Krueger** — never swings at the lane at all; `_skipNormalAttack` on every path.
- **Open Water** — the env slot clears when Jaws **rises**, not when he dies.
- **Boiler Room** — Burning ticks in `onBeforeAttack`, so a card that never swings never burns.
- **Gizmo** — the Gremlin arrives at its def **(2/2)**; the literal args in the call are
  ignored because the def is passed as `sourceDef`.
- **Jigsaw** — classic default is **2** traps; the adjacent code comment saying 3 is stale.
- **Revan** — "(not a 10-cost card)" was wrong: the filter is `baseCost <= 9`, which also
  excludes printed-above-10 bodies like Doomsday (cost 12).

### Sweeps completed

- No `Stun` wording survives anywhere (merged into Freeze globally — nothing sets `isStunned`).
- No `or less` — all conditional filters use `≤`.
- No hyphen-minus inside debuff parens — all real U+2212 `−`.
- Keyword-badge rule re-verified. Remaining keyword mentions in desc are all legitimate:
  a summoned **token's** keywords (Ghostface), or bespoke twists the glossary permits
  (Revive-as-different-stats, Dr. Manhattan's Taunt exception).

### Known follow-ups (out of scope, text-only pass)

- `Mind Control 1` still appears on **Mind Stone** (tricks.js) and **Luke Skywalker**
  (cards.js). Mind Control is a **flag**, not parameterized — the `1` should be dropped
  for consistency (Gorilla Grodd already fixed).
- **Michael Myers** and **Gamora** both carry a card-specific lone-wolf `+1/+1` that
  double-stacks with the universal engine Lone Wolf — net `(+2/+2)` alone. Code smell,
  not a text problem.
