# Phone hand layout — design

Status: approved section by section in conversation (sections 1 and 2 earlier,
section 3 on 2026-11-10: "yes do it"). Scope: the player's hand and trick row in
a match at phone widths (`@container (max-width: 520px)`). Desktop is out of
scope and must not change. 2v2 online keeps its own layout
(`body.twov2-online-game`).

## The problem, measured (375×812, 5 cards in hand, 2 tricks)

| | today |
|---|---|
| hand row width | 232px — the trick column takes 143px beside it |
| hand cards fully visible | 3 of 5 |
| card wrapper vs the card inside it | 52px slot, 92px card — cards overflow their slots and pile up |
| width the card's chrome is drawn for | 110px (the desktop solver's `--hand-card-w`) on a 92px card |
| empty screen under the hand | 154px |

Causes:
1. `body.in-match #game-area { grid-template-columns: 1fr auto }` puts hand and
   tricks side by side at every width. It saves a laptop window height; on a
   phone it costs the hand 38% of its width.
2. `body.in-match .player-hand-section .hand-cards .card { width: var(--hand-card-w) }`
   (0,4,1) outranks the phone flex rule (0,3,0), so the card keeps the desktop
   width while its wrapper shrinks.
3. `.player-hand-section .hand-cards .card { --sb-card: var(--hand-card-w) }`
   tells every chrome system (badges, stat circles, name size, chamfer) the card
   is 110px wide.

The phone board is width-bound (six lanes fill 375px), so spare height cannot
make the board bigger.

## Section 1 — the row arrangement

At phone width the game area becomes one column: the hand owns the full row and
the trick row sits under it, full width. Tricks keep their current tile size;
there are never more than 3, so they fit one row without scrolling.

## Section 2 — the hand card tells the truth about its width

1. After each layout, the real hand card width is measured and published once,
   on the hand row, as `--hand-real-w`. At phone width the card's `--sb-card`
   reads it, so every chrome system scales from the true width. Same pattern as
   `UI._sizeDecisionTrayCards`.
2. Name sizing rides on `--card-w` already, so it follows from (1).
3. At phone width the card fills its wrapper (`width: 100%`), so the flex solve
   that already works governs the card.
4. Floor: a card slot never goes below 56px. The board already ships 51px cards
   with honest chrome that read. A 7-card hand scrolls rather than shrinking into
   slivers.

Feedback-loop safety: the slot width comes from flex (`flex: 1 1 0`, min 56, max
92) and the viewport; nothing that `--hand-real-w` changes can change the width
it was measured from.

## Section 3 — the leftover vertical space

The player's block (info bar, hand, tricks) anchors to the bottom of the screen;
the leftover gap opens between the board and the player's block. Thumb reach,
and the same shape as Marvel Snap. Cost: a drag to the board travels a little
further. Rejected: taller hand cards (bigger art, but pushes 7 cards further from
fitting).

## Tests

- Phone: hand row spans the full width; tricks sit below it, full width.
- Phone: each hand card is no wider than its slot; no two hand cards overlap.
- Phone: the chrome width a hand card reports equals its real width (±1px).
- Phone: 5 cards all visible; 7 cards show at least 5 without scrolling.
- Phone: all tricks visible in one row.
- Phone: the player's block ends at the bottom of the screen.
- Desktop (1280×800): the in-match layout is unchanged.

Every test must fail on the code before this change.
