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
  'Homelander':          ['Homelander.png',           'Homelander 2.jpg'],
  'Xenomorph':           ['Xenomorph 2.png',          'Xenomorph.png'],
  // ── Silver Surfer chrome / cosmic portrait additions (2026-05-26) ──
  'Silver Surfer':       ['Silver Surfer 3.png',      'Silver Surfer 2.png',     'Silver Surfer.png'],
  'Galactus':            ['Galactus 2.png',           'Galactus.png'],
  'Scarlet Witch':       ['Scarlet Witch 2.png',      'Scarlet Witch.png'],
  'Deathstroke':         ['Deathstroke 2.png',        'Deathstroke.png'],
  // ── Single-art entries (webp) ──
  'Pennywise':           ['Pennywise 2.jpg',          'Pennywise.png'],
  'Freddy Krueger':      ['Freddy Krueger 2.png'],
  'Black Panther':       ['Black Panther.png',        'Black Panther 2.png'],
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
  'Joker':               ['Joker 2.jpg',             'Joker.png'],
  'Carnage':             ['Carnage.png'],
  'Ghost Rider':         ['Ghost Rider.jpg'],
  'Rocket Raccoon':      ['Rocket Raccoon.png'],
  'Paul Atreides':       ['Paul Atreides.jpg'],
  'Jack Sparrow':        ['Jack Sparrow.jpg'],
  // Michael Myers — new fiery portrait as the primary (menu hero + in-game
  // default); original kept as a gallery variant.
  'Michael Myers':       ['Michael Myers 2.jpg',     'Michael Myers.png'],
  'Captain America':     ['Captain America 2.jpg',   'Captain America.png'],
  // New horror portraits (2026-07-13) — new art as the primary, originals kept.
  'Ghostface':           ['Ghostface 2.jpg',         'Ghostface.png'],
  'Jigsaw':              ['Jigsaw 3.jpg',            'Jigsaw 2.jpg',            'Jigsaw.png'],
  // New character portraits (2026-07-14) — new art as the primary, originals kept.
  'Red Skull':           ['Red Skull 2.jpg',         'Red Skull.png'],
  'Martian Manhunter':   ['Martian Manhunter 2.jpg'],
  'Loki':                ['Loki 2.jpg',              'Loki.png'],
  'Predator':            ['Predator 2.jpg',          'Predator.png'],
  'Hela':                ['Hela 2.jpg',              'Hela.png'],
  'Optimus Prime':       ['Optimus Prime 2.jpg',     'Optimus Prime.png'],
  // Doomsday — new portrait as primary; artist signature cropped off the
  // bottom strip (card frames the head/torso, so nothing important is lost).
  'Doomsday':            ['Doomsday 2.jpg',          'Doomsday.png'],
  'Sabertooth':          ['Sabertooth 2.jpg',        'Sabertooth.png'],
  'The Batman Who Laughs': ['The Batman Who Laughs 2.jpg', 'The Batman Who Laughs.png'],
  'Obi-Wan':             ['Obi-Wan 2.jpg',           'Obi-Wan.png'],
  'The Grinch':          ['The Grinch 2.jpg',        'The Grinch.png'],
  // Gremlins set (2026-07-15) — Stripe's art is a jpg, so it needs a manifest
  // entry (default lookup assumes <Name>.png). Gizmo/Gremlin resolve as pngs.
  'Stripe':              ['Stripe.jpg'],
  // Iron Giant (2026-07-15) — jpg art, same manifest-entry reason as Stripe.
  'Iron Giant':          ['Iron Giant.jpg'],
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
  // Gallery Audit → "Publish to repo" (2026-07-12, refreshed 2026-07-13). The
  // 2026-07-13 publish updated Darth Vader / Padme / Ghostface / Jigsaw crops
  // and added Black Panther, Deadpool, Green Lantern, Groot, Hela, Iron Man,
  // Harley Quinn, Hawkeye, Mr. Freeze. Reorders (Black Panther, Jigsaw) baked
  // into CARD_ART_VARIANTS above.
  focalCard: {   // "name|file" -> "X% Y%"   in-game card crop focal
    'Anakin Skywalker|Anakin Skywalker 2.png': '50% 49%',
    'Batman|Batman.png': '37% 47%',
    'Ghost Rider|Ghost Rider.jpg': '50% 35%',
    'Darth Maul|Darth Maul.jpg': '53% 50%',
    'Darth Vader|Darth Vader 2.png': '50% 61%',
    'Dr. Strange|Dr. Strange 2.png': '96% 50%',
    'Emperor Palpatine|Emperor Palpatine 2.png': '50% 51%',
    'Freddy Fazbear|Freddy Fazbear.png': '50% 51%',
    'Freddy Krueger|Freddy Krueger 2.png': '50% 51%',
    'Jack Sparrow|Jack Sparrow.jpg': '50% 53%',
    'Joker|Joker.png': '50% 0%',
    'Joker|Joker 2.jpg': '50% 38%',
    'Luke Skywalker|Luke Skywalker 2.jpg': '50% 54%',
    'Michael Myers|Michael Myers 2.jpg': '50% 0%',
    'Mr. Fantastic|Mr. Fantastic.png': '50% 4%',
    'Padme Amidala|Padme Amidala.png': '50% 0%',
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
    'Ghostface|Ghostface 2.jpg': '82% 73%',
    'Jigsaw|Jigsaw 2.jpg': '81% 50%',
    'Jigsaw|Jigsaw 3.jpg': '50% 3%',
    'Black Panther|Black Panther.png': '74% 100%',
    'Deadpool|Deadpool.png': '50% 73%',
    'Green Lantern|Green Lantern.png': '50% 82%',
    'Groot|Groot.png': '50% 65%',
    'Hela|Hela.png': '50% 46%',
    'Iron Man|Iron Man 2.png': '50% 41%',
    // New character portraits (2026-07-14)
    'Red Skull|Red Skull 2.jpg': '50% 8%',
    'Martian Manhunter|Martian Manhunter 2.jpg': '50% 8%',
    'Loki|Loki 2.jpg': '50% 40%',
    'Predator|Predator 2.jpg': '50% 14%',
    'Hela|Hela 2.jpg': '50% 8%',
    'Optimus Prime|Optimus Prime 2.jpg': '51% 18%',
    'Doomsday|Doomsday 2.jpg': '50% 12%',
    'Sabertooth|Sabertooth 2.jpg': '52% 12%',
    'The Batman Who Laughs|The Batman Who Laughs 2.jpg': '50% 45%',
    'Obi-Wan|Obi-Wan 2.jpg': '100% 84%',
    'Obi-Wan|Obi-Wan.png': '60% 50%',
    'The Grinch|The Grinch 2.jpg': '50% 24%',
  },
  focalMenu: {   // "name|file" -> "X% Y%"   menu-hero crop focal
    'Darth Maul|Darth Maul.jpg': '50% 50%',
    'Dormammu|Dormammu.png': '71% 50%',
    'Dr. Strange|Dr. Strange 2.png': '91% 50%',
    'Freddy Krueger|Freddy Krueger 2.png': '50% 49%',
    'Joker|Joker.png': '50% 0%',
    'Joker|Joker 2.jpg': '50% 34%',
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
    'Ghostface|Ghostface 2.jpg': '82% 64%',
    'Jigsaw|Jigsaw 2.jpg': '50% 22%',
    'Jigsaw|Jigsaw 3.jpg': '45% 0%',
    'Black Panther|Black Panther.png': '50% 100%',
    'Green Lantern|Green Lantern.png': '50% 80%',
    'Harley Quinn|Harley Quinn.png': '50% 0%',
    'Hawkeye|Hawkeye.png': '50% 42%',
    'Hela|Hela.png': '50% 0%',
    'Iron Man|Iron Man 2.png': '50% 0%',
    'Iron Man|Iron Man 3.png': '50% 31%',
    'Mr. Freeze|Mr. Freeze.png': '50% 0%',
    'Padme Amidala|Padme Amidala.png': '50% 0%',
    // New character portraits (2026-07-14)
    'Red Skull|Red Skull 2.jpg': '50% 6%',
    'Martian Manhunter|Martian Manhunter 2.jpg': '50% 10%',
    'Loki|Loki 2.jpg': '50% 32%',
    'Predator|Predator 2.jpg': '50% 12%',
    'Hela|Hela 2.jpg': '50% 4%',
    'Optimus Prime|Optimus Prime 2.jpg': '50% 23%',
    'Doomsday|Doomsday 2.jpg': '50% 10%',
    'Sabertooth|Sabertooth 2.jpg': '52% 14%',
    'The Batman Who Laughs|The Batman Who Laughs 2.jpg': '50% 45%',
    'Obi-Wan|Obi-Wan 2.jpg': '100% 74%',
    'The Grinch|The Grinch 2.jpg': '50% 26%',
  },
  zoomCard:  {   // "name|file" -> scale (1 = cover, e.g. 1.3)
    'Darth Maul|Darth Maul.jpg': 1.6,
    'Jack Sparrow|Jack Sparrow.jpg': 2.2,
    'The Grinch|The Grinch.png': 1.8,
    'Batman|Batman.png': 1.1,
    'Black Panther|Black Panther.png': 1.1,
    'Ghostface|Ghostface 2.jpg': 1.3,
    'Green Lantern|Green Lantern.png': 1.1,
    'Padme Amidala|Padme Amidala.png': 1.1,
    'Obi-Wan|Obi-Wan 2.jpg': 1.15,
    'Optimus Prime|Optimus Prime 2.jpg': 1.1,
    'The Grinch|The Grinch 2.jpg': 1.25,
  },
  zoomMenu:  {   // "name|file" -> scale
    'Darth Maul|Darth Maul.jpg': 1.6,
    'The Grinch|The Grinch.png': 1.9,
    'Batman|Batman.png': 1.1,
    'Ghostface|Ghostface 2.jpg': 1.3,
    'Padme Amidala|Padme Amidala.png': 1.1,
    'Obi-Wan|Obi-Wan 2.jpg': 1.1,
    'Optimus Prime|Optimus Prime 2.jpg': 1.1,
    'The Grinch|The Grinch 2.jpg': 1.15,
  },
};
