# AI Coaching Plan

Living doc tracking what we've learned and what's next. Claude doesn't have
memory across sessions, so keeping state here.

## Where we are

- Debug mode (`?debug=1`) live. Shows AI hand as compact tags + floating
  toolbar (Export / Clear / F=note).
- Play logger (`logger.js`) captures every card play, jump, trick, draft
  pick, and game end to localStorage. Export via modal (textarea +
  Download .json + execCommand copy).
- F-key annotation modal works (native `prompt()` was blocked by preview
  sandbox — replaced with in-page modal).
- ~136 moves captured across 6 games (1 complete). Enough to verify the
  tooling works; not yet enough to mine patterns statistically.

## AI rules encoded this session

All changes live and working. Grouped by what triggered them:

1. **Ghostface jump window** — AI trick in Phase 3 now raises the jump
   modal before combat so player gets a real window. `endPhase3` check
   in `game.js`.
2. **Vader chain start pick** — AI no longer wastes Vader's first hit
   into Evade/Invincible/Immune targets. Scores candidates by kill +
   chain reach. `game.js:startVaderChain`.
3. **Damage trick targets** — `evalTrick`'s damage branch filters out
   Invincible/DmgImmune/Evading enemies. AI holds Batarang into Flash
   Invincible 2 instead of wasting it.
4. **Contested placement vs unkillable** — if enemy is Invincible/DmgImmune
   and my card dies, big negative penalty. Stops Peacemaker-vs-Flash feed.
5. **Bullseye placement bonus** — Bullseye cards prefer open lanes (+2)
   for recurring face damage instead of one-time trades.
6. **Homelander sacrifice picker** — finds the cheapest ally whose cost
   is enough to kill a high-threat enemy. Stops Joker-sacrificed-for-3-dmg.
7. **Darkseid AI** — summon Parademon strategically (into lane with
   juicy enemy), only destroy lanes where trade is favorable, pick
   odd/even by net trade value (not count).
8. **Frozen cards can't move** — `moveCard` blocks Bifrost/Ahsoka/Gojo
   swap if target is Frozen/Stunned.
9. **Adjacency splash hazard** — AI penalizes placing near enemy
   `splashRange > 0` or Red Hulk (reactive splash). Fixes King-Shark-
   next-to-Red-Hulk.
10. **Man-Bat handling** — AI treats Man-Bat's lane as uncontested for
    blocking purposes (Man-Bat will move before combat). Fragile
    placements get small penalty when Man-Bat is on the board.
11. **Tokens skip dead pile** — Ant / Parademon / Undead Warrior etc.
    no longer resurrect via Lazarus Pit, Grundy onDeath, or Hela.
12. **Gojo Hollow Purple timing** — fires the moment Gojo survives his
    2nd lane's combat, not end-of-round. Uses new `onLaneResolved` hook.
13. **Jigsaw rebalanced** to 2 cost (was 3).
14. **Batman Who Laughs intercept awareness** — AI detects
    `nextCardStolen` and plays its cheapest affordable card first as a
    sacrifice so finishers aren't stolen. Real cards beat discard-effect
    cards at same cost tier.
15. **Strategic threat bonus for energy generators** — Dr. Octopus
    (+5) and Green Lantern (+3 + atk) now score higher in `threatScore`
    than their combat stats suggest, cascading into lane blocking,
    trick targeting, freeze/stun/fear/MC prioritization. Bonus
    suppressed while the card is stunned/frozen/feared/mind-controlled.

## Patterns suggested from current log (need more data to confirm)

From 2 captured drafts + your flagged moves:

- **Draft curve leans late-game.** Game-5 draft: Yoda/Anakin/Black
  Widow/Palpatine/Manhattan — 4 of 5 cards at 8+ cost. High-variance
  build. Worked in one game but needs stats across more drafts.
- **Keyword weight over stats.** Consistently pick Bullseye / Evade /
  Unresistible / Immunity over plain-stat cards (Black Widow > Ultron,
  Palpatine > Gorr, Cap > Red Skull).
- **Targeted removal tricks preferred** over random-effect tricks
  (Kryptonite > Power Stone, Mother Box > Time Stone).
- **Active jump-card user** — multiple Michael Myers / Ghostface / Jason
  / Ahsoka free-plays. Suggests draft weight on horror cards if a jump
  enabler is already in hand.

These are impressions, not rules yet. Need more data to encode confidently.

## What to do next time you play

Highest signal → lowest effort:

1. **Play 5–10 complete games** (all the way to gameEnd). The win/loss
   correlation is the single most valuable signal — without it I can't
   tell which patterns actually win.
2. **F-note 3–5 moves per game.** Target AI moves that felt dumb. One
   flagged move with "AI should've X because Y" = one rule I can encode.
3. **Try different deck archetypes** on purpose. Play a low-curve aggro
   draft, then a control draft, then a combo draft. Right now the log
   only captures "henry's preferred build" — for draft AI to improve
   it needs to see how different curves play out.
4. **Export after each session.** Keep the JSON files — if you label
   them by date (`playlog-2026-04-21.json` etc.) we can track AI
   improvement over time.

## What I'll do when you paste the next log

In order, assuming 5+ complete games:

1. **Draft analysis.** Compute your pick rate for each card when
   offered, cross-referenced with wins vs losses. Cards you always
   pick + always win with = high-weight for AI drafting. Cards you
   pick but lose with = overvalued in your heuristic.
2. **Turn-by-turn mining.** Average curve played per turn, average
   cards held vs played, trick-cast timing. Build a profile of "what
   does a good player do" and bolt it onto `ai.js` scoring.
3. **F-note harvest.** Each flagged move → concrete rule in
   `chooseLane` / `evalTrick` / `chooseDraft`. These are the highest
   signal per minute of your time.
4. **Concrete diff plan.** Show you the proposed `ai.js` changes
   before I apply any. You approve/reject each.

## Strategic topics noted but not yet coded

- **Catwoman timing.** She's a 2-cost discard-effect with a +1/-1
  energy swing next turn. Currently AI discards her ASAP. Optimal
  human play: hold until the turn before a finisher you're 1 energy
  short of (e.g. turn 8 → turn 9 with 10 energy while opponent stuck
  at 8). Needs hand-reading — "do I have a 9-10 cost card, and would
  the swing unlock it a turn earlier?" Deferred.
- **Green Lantern counterplay — armor in front.** Armor reduces
  landed damage, which directly reduces GL's next-turn energy aura.
  AI's `chooseLane` doesn't currently prefer armor-carrying bodies
  for GL's lane specifically. Strategic threat bonus (#15) partially
  covers this by raising GL's blocking priority, but a dedicated
  "prefer armor blockers for damage-converter enemies" rule is the
  real fix. Deferred.
- **Block meter management vs GL.** Filling the block meter before
  GL swings negates the damage entirely = zero energy gained. AI
  doesn't track block meter timing. Deferred.

## Open threads

- Seat bias. Original sim showed AI (going 2nd) wins 55.4% vs player
  44.3% in 5000 games. We haven't tested if the seat bias is still
  there after this session's changes. Worth a run of `sim/run.js`
  with current weights once stuff calms down.
- CEM tuner has never been run to produce `weights-current.json`. If
  you want the AI stronger than rule-based alone, a tuner run
  (1–2 hours of compute) could squeeze out a few more % WR.
- Lookahead is currently disabled (`lookaheadMult: 0`). Fixing the
  simplified combat sim to handle onPlay / tricks / chains would
  unlock re-enabling it with real benefit.

## Session continuity

If you come back to a fresh Claude: point it at this file, show it the
latest play log, and ask it to continue the plan. Debug mode URL is
`http://127.0.0.1:8080/?debug=1`. Start the preview from the Claude
`.claude/launch.json` config. Preview stub still lives in
`~/Downloads/The Game/.claude/` pointing at the real project at
`~/The Game/` — can be removed once you start future sessions from
`~/The Game/` directly.
