# Presentation director — design

Status: approved in conversation ("yes do all 3 steps"). Owner's question: is a
single first-come queue how big games do it, given that "sometimes voicelines,
or animations are missed entirely"?

## What was measured first (step 1)

- The effect stream keeps the newest 60 events. Measured: a full browser round
  emits ~15 events; the largest batch a 2v2 host sent in three 20-round sim games
  was 10. The cap is effectively never what drops an animation.
- The real cause of "skipped" animations is BURSTS: `UI.showDamageFloats` plays
  every event it receives in the same frame. A guest receives a combat as one
  batch, and multi-target abilities emit several at once, so beats collapse
  into one frame. Only relayed signature cinematics were already paced.
- Audio: categories, ducking (play / voice / ability lower others to 60%), and a
  4-voice cap on quick effects already exist. Missing: a rule for two
  foreground cues at once — they simply overlap, so a voice line can be buried.

Instrumentation kept permanently: `Game.fxStats()` (events read, events lost to
the cap, largest batch) and `UI.fxDirectorStats()`.

## Step 2 — the voice channel

Foreground cues have a priority: voice line 3, card play / spawn / kill 2,
ability 1.
- A newer cue of equal priority takes the channel; the older one fades out
  (250ms) instead of playing underneath at 60% (no garble).
- A higher-priority cue takes the channel; what was playing is ducked, not cut.
- A lower-priority cue plays under the current one at 35%, never cut.
- A voice line ducks everything else to 35% (was 60%).
Quick effects keep their 4-voice cap; hover/music rules are unchanged.

## Step 3 — tracks and catch-up

`showDamageFloats` becomes: read events → `_fxDirect(events)`; the old loop body
becomes `_fxPlayOne(ev)` unchanged (each `continue` is now `return`).

Tracks:
- **combat** (swing, hit, hpHit, block, blocked, armor, evade, heal, move,
  enterAndDie, blockDrain, artWeapon, laneVoid): sequential BEATS. Consecutive
  events from the same attacker (or the same event type with no attacker) form
  one beat and play together — an area hit stays simultaneous, separate lane
  fights become separate beats.
- **announce** (trickReveal, discardReveal, envReveal, titan, legendary,
  ballyhoo, shadowman, ironGiantSave): one at a time, spaced.
- **immediate**: sounds (sfx, statusSfx, effectSfx), relayed cinematics (they
  keep their own existing pacing), and any unknown type.

Rules:
- Calm path unchanged: when a track is idle and receives a single beat, it
  plays this frame. The host's normal play feels exactly as before.
- Bursts are paced: beat spacing 240ms (combat) / 700ms (announce).
- Catch-up instead of dropping: spacing shrinks as the backlog grows
  (×1 → ×2.5). Over 24 queued combat beats, purely cosmetic events (swing,
  blockDrain, artWeapon) are merged away first; hits, kills and announcements
  are never dropped.
- A delayed event whose card has left the board is skipped by the existing
  per-type null checks, as today.

## Tests

- Splitting the dispatcher changed nothing: every event type still reaches the
  same handler (the body is moved, not rewritten).
- A single event plays synchronously (calm path); a burst does not.
- Beats group by attacker; an area hit is one beat.
- Backlog shortens spacing; cosmetic events merge away before hits.
- Voice channel: equal priority replaces, lower plays under, voice line ducks
  to 35%.
- Every test fails on the code before this change.
