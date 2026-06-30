// =============================================================================
// CARD ART VARIANTS MANIFEST
// =============================================================================
// Each entry lists every available portrait file for a card. The first entry
// is treated as the DEFAULT (shown until the player picks an alternate via
// the card-name-click cycle). File names are exactly as they appear under
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
//
// 2026-05-18 — promoted variant-2 art to the front for every card the user
// had selected via the name-click cycle (read from localStorage
// clb-ui-prefs.cardArt). New players land on the curated picks instead of
// variant 1. Cards the user kept on variant 1 (or never touched) stay
// original-first. Existing localStorage selections still resolve correctly
// because the stored value matches one of the manifest entries either way.
// =============================================================================

window.CARD_ART_VARIANTS = {
  // ── Variant-2 promoted (user-picked defaults, 2026-05-18) ──
  'Darth Vader':         ['Darth Vader 2.png',        'Darth Vader.png'],
  'Dr. Doom':            ['Dr. Doom 2.png',           'Dr. Doom.png'],
  'Dr. Strange':         ['Dr. Strange 2.png',        'Dr. Strange.png'],
  'Emperor Palpatine':   ['Emperor Palpatine 2.png',  'Emperor Palpatine.png'],
  'Hulk':                ['Hulk 2.png',               'Hulk.png'],
  'Iron Man':            ['Iron Man 2.png',           'Iron Man.png',              'Iron Man 3.png'],
  'Jason Voorhees':      ['Jason Voorhees 3.png',     'Jason Voorhees 2.png',      'Jason Voorhees.png'],
  'Omni-Man':            ['Omni-Man 2.png',           'Omni-Man.png'],
  'Spider-Man':          ['Spider-Man 2.png',         'Spider-Man.png'],
  'Superman':            ['Superman 2.png',           'Superman.png'],
  'Symbiote Spider-Man': ['Symbiote Spider-Man 2.png','Symbiote Spider-Man.png'],
  'The Flash':           ['The Flash 2.png',          'The Flash.png'],
  // ── Variant-2 promoted in second pass (2026-05-18 follow-up) ──
  'Ahsoka':              ['Ahsoka 2.png',             'Ahsoka.png'],
  'Xenomorph':           ['Xenomorph 2.png',          'Xenomorph.png'],
  // ── Silver Surfer chrome / cosmic portrait additions (2026-05-26) ──
  'Silver Surfer':       ['Silver Surfer 2.png',      'Silver Surfer 3.png',     'Silver Surfer.png'],
  'Galactus':            ['Galactus 2.png',           'Galactus.png'],
  'Scarlet Witch':       ['Scarlet Witch 2.png',      'Scarlet Witch.png'],
  'Deathstroke':         ['Deathstroke 2.png',        'Deathstroke.png'],
  // ── Single-art entries (webp) ──
  'Pennywise':           ['Pennywise.png'],
  'Freddy Krueger':      ['Freddy Krueger 2.png',     'Freddy Krueger.png'],
  'Black Panther':       ['Black Panther 2.png',      'Black Panther.png'],
  // ── Variant-1 default kept (user kept original) ──
  'Anakin Skywalker':    ['Anakin Skywalker.png',     'Anakin Skywalker 2.png'],
  'Batman':              ['Batman.png',               'Batman 2.png'],
  'Venom':               ['Venom.png',                'Venom 2.png'],
  'Wolverine':           ['Wolverine.png',            'Wolverine 2.png'],
  // ── New art additions ──
  'Han Solo':            ['Han Solo.jpg'],
  'Darth Maul':          ['Darth Maul.jpg'],
  'Padme Amidala':       ['Padme Amidala.png'],
  'Luke Skywalker':      ['Luke Skywalker.png',       'Luke Skywalker 2.jpg'],
  // ── New portraits (2026-06-15) ──
  'Joker':               ['Joker.png'],
  'Carnage':             ['Carnage.png'],
  'Cyborg':              ['Cyborg.png'],
  'Rocket Raccoon':      ['Rocket Raccoon.png'],
  'Kang':                ['Kang.png'],
  'Jack Sparrow':        ['Jack Sparrow.jpg'],
  // Michael Myers — new fiery portrait as the primary (menu hero + in-game
  // default); original kept as a gallery variant.
  'Michael Myers':       ['Michael Myers 2.jpg',     'Michael Myers.png'],
};
