// =============================================================================
// CARD ART VARIANTS MANIFEST
// =============================================================================
// Each entry lists every available portrait file for a card. The first entry
// is treated as the DEFAULT (shown until the player picks an alternate via
// the codex variant picker). File names are exactly as they appear under
// audio/cards/art/ — extension included, no path prefix.
//
// To add a new variant for an existing card:
//   1. Save the new image as `audio/cards/art/<CardName> N.png` (N = next
//      available number, starting at 2).
//   2. Add or extend the card's entry here, e.g.
//        'Hulk': ['Hulk.png', 'Hulk 2.png'],
//   3. Bump _CARD_ART_VERSION in ui.js so browsers refetch.
//
// Cards NOT listed in this manifest just use `<CardName>.png` — no variants,
// no picker UI rendered. Adding a card here with one entry is a no-op.
// =============================================================================

window.CARD_ART_VARIANTS = {
  'Batman':              ['Batman.png',              'Batman 2.png'],
  'Hulk':                ['Hulk.png',                'Hulk 2.png'],
  'Dr. Strange':         ['Dr. Strange.png',         'Dr. Strange 2.png'],
  'Darth Vader':         ['Darth Vader.png',         'Darth Vader 2.png'],
  'Symbiote Spider-Man': ['Symbiote Spider-Man.png', 'Symbiote Spider-Man 2.png'],
  'Venom':               ['Venom.png',               'Venom 2.png'],
  'The Flash':           ['The Flash.png',           'The Flash 2.png'],
};
