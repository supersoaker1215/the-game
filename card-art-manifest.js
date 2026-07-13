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
  'Emperor Palpatine':   ['Emperor Palpatine 2.png'],
  'Hulk':                ['Hulk 2.png',               'Hulk.png'],
  'Iron Man':            ['Iron Man 2.png',           'Iron Man.png',              'Iron Man 3.png'],
  'Jason Voorhees':      ['Jason Voorhees 3.png',     'Jason Voorhees 2.png',      'Jason Voorhees.png'],
  'Omni-Man':            ['Omni-Man 2.png',           'Omni-Man.png'],
  'Bane':                ['Bane 2.jpg',               'Bane.png'],
  'Spider-Man':          ['Spider-Man 3.jpg',         'Spider-Man 2.png',      'Spider-Man.png'],
  'Superman':            ['Superman 3.jpg',           'Superman 2.png',        'Superman.png'],
  'Symbiote Spider-Man': ['Symbiote Spider-Man 3.jpg','Symbiote Spider-Man 2.png','Symbiote Spider-Man.png'],
  'The Flash':           ['The Flash 2.png',          'The Flash.png'],
  // ── Variant-2 promoted in second pass (2026-05-18 follow-up) ──
  'Ahsoka':              ['Ahsoka 2.png'],
  'Xenomorph':           ['Xenomorph 2.png',          'Xenomorph.png'],
  // ── Silver Surfer chrome / cosmic portrait additions (2026-05-26) ──
  'Silver Surfer':       ['Silver Surfer 3.png',      'Silver Surfer 2.png',     'Silver Surfer.png'],
  'Galactus':            ['Galactus 2.png',           'Galactus.png'],
  'Scarlet Witch':       ['Scarlet Witch 2.png',      'Scarlet Witch.png'],
  'Deathstroke':         ['Deathstroke 2.png',        'Deathstroke.png'],
  // ── Single-art entries (webp) ──
  'Pennywise':           ['Pennywise 2.jpg',          'Pennywise.png'],
  'Freddy Krueger':      ['Freddy Krueger 2.png'],
  'Black Panther':       ['Black Panther 2.png',      'Black Panther.png'],
  // ── Variant-1 default kept (user kept original) ──
  'Anakin Skywalker':    ['Anakin Skywalker 2.png',   'Anakin Skywalker.png'],
  'Batman':              ['Batman.png',               'Batman 2.png'],
  'Venom':               ['Venom.png',                'Venom 2.png'],
  'Wolverine':           ['Wolverine.png'],
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
  'Paul Atreides':       ['Paul Atreides.jpg'],
  'Jack Sparrow':        ['Jack Sparrow.jpg'],
  // Michael Myers — new fiery portrait as the primary (menu hero + in-game
  // default); original kept as a gallery variant.
  'Michael Myers':       ['Michael Myers 2.jpg',     'Michael Myers.png'],
  'Captain America':     ['Captain America 2.jpg',   'Captain America.png'],
};

// =============================================================================
// PUBLISHED GALLERY EDITS  (Gallery Audit → "Export for repo")
// =============================================================================
// The WORLDWIDE defaults for manual crops + zoom, baked into the repo so they
// apply for everyone. A player's local edits (localStorage) override these for
// that browser. Keys are exactly "Card Name|file.png|jpg".
// Reorder (primary) + deletions are baked into CARD_ART_VARIANTS above (array
// order = priority; a removed entry = deleted), not here.
window.CARD_ART_OVERRIDES = {
  // Gallery Audit → "Publish to repo" (2026-07-12). Drafts merged over the
  // earlier repo crops; Captain America / Pennywise / Bane kept (not re-edited
  // in this publish, so absent from the export).
  focalCard: {   // "name|file" -> "X% Y%"   in-game card crop focal
    'Anakin Skywalker|Anakin Skywalker 2.png': '50% 49%',
    'Batman|Batman.png': '37% 47%',
    'Cyborg|Cyborg.png': '50% 42%',
    'Darth Maul|Darth Maul.jpg': '53% 50%',
    'Darth Vader|Darth Vader 2.png': '50% 48%',
    'Dr. Strange|Dr. Strange 2.png': '96% 50%',
    'Emperor Palpatine|Emperor Palpatine 2.png': '50% 51%',
    'Freddy Fazbear|Freddy Fazbear.png': '50% 51%',
    'Freddy Krueger|Freddy Krueger 2.png': '50% 51%',
    'Jack Sparrow|Jack Sparrow.jpg': '50% 53%',
    'Joker|Joker.png': '50% 0%',
    'Luke Skywalker|Luke Skywalker 2.jpg': '50% 54%',
    'Martian Manhunter|Martian Manhunter.png': '50% 7%',
    'Michael Myers|Michael Myers 2.jpg': '50% 0%',
    'Mr. Fantastic|Mr. Fantastic.png': '50% 4%',
    'Padme Amidala|Padme Amidala.png': '50% 49%',
    'Raven|Raven.png': '50% 48%',
    'Red Hulk|Red Hulk.png': '90% 50%',
    'Revan|Revan.png': '100% 50%',
    'Sandman|Sandman.png': '50% 0%',
    'Scarlet Witch|Scarlet Witch 2.png': '50% 49%',
    'Solomon Grundy|Solomon Grundy.png': '50% 17%',
    'Spider-Man|Spider-Man 3.jpg': '50% 0%',
    'Superman|Superman 3.jpg': '50% 22%',
    'Symbiote Spider-Man|Symbiote Spider-Man 3.jpg': '50% 100%',
    'The Grinch|The Grinch.png': '48% 50%',
    'Captain America|Captain America 2.jpg': '50% 12%',
    'Pennywise|Pennywise 2.jpg': '50% 20%',
    'Bane|Bane 2.jpg': '50% 15%',
    'Paul Atreides|Paul Atreides.jpg': '50% 55%',
  },
  focalMenu: {   // "name|file" -> "X% Y%"   menu-hero crop focal
    'Darth Maul|Darth Maul.jpg': '50% 50%',
    'Dormammu|Dormammu.png': '71% 50%',
    'Dr. Strange|Dr. Strange 2.png': '91% 50%',
    'Freddy Krueger|Freddy Krueger 2.png': '50% 49%',
    'Joker|Joker.png': '50% 0%',
    'Martian Manhunter|Martian Manhunter.png': '50% 14%',
    'Michael Myers|Michael Myers 2.jpg': '45% 0%',
    'Mr. Fantastic|Mr. Fantastic.png': '50% 1%',
    'Red Hulk|Red Hulk.png': '63% 50%',
    'Revan|Revan.png': '95% 50%',
    'Sandman|Sandman.png': '50% 28%',
    'Solomon Grundy|Solomon Grundy.png': '50% 23%',
    'Spider-Man|Spider-Man 3.jpg': '50% 0%',
    'Superman|Superman 3.jpg': '50% 14%',
    'Symbiote Spider-Man|Symbiote Spider-Man 3.jpg': '50% 100%',
    'Captain America|Captain America 2.jpg': '50% 10%',
    'Pennywise|Pennywise 2.jpg': '50% 15%',
    'Bane|Bane 2.jpg': '50% 12%',
    'Paul Atreides|Paul Atreides.jpg': '50% 50%',
  },
  zoomCard:  {   // "name|file" -> scale (1 = cover, e.g. 1.3)
    'Darth Maul|Darth Maul.jpg': 1.6,
    'Jack Sparrow|Jack Sparrow.jpg': 2.2,
    'The Grinch|The Grinch.png': 1.8,
    'Batman|Batman.png': 1.1,
  },
  zoomMenu:  {   // "name|file" -> scale
    'Darth Maul|Darth Maul.jpg': 1.6,
    'The Grinch|The Grinch.png': 1.9,
    'Batman|Batman.png': 1.1,
  },
};
