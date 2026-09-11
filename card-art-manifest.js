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
  // ── MC Ballyhoo and his candies ──
  // Listed because the default filename a card falls back to is
  // `<CardName>.png`, and these five shipped as JPEG. One entry each, no
  // variants — the manifest is the only way to name a .jpg without renaming
  // the file. MC Ballyhoo is not a card at all (he is the round-start event in
  // Game._maybeBallyhoo) but his announcement goes through the same
  // showCardReveal panel, which asks getCardArtPath for a portrait by name.
  'MC Ballyhoo':         ['MC Ballyhoo.jpg'],
  'Twice Candy':         ['Twice Candy.jpg'],
  'Cashzap Candy':       ['Cashzap Candy.jpg'],
  'Vampire Candy':       ['Vampire Candy.jpg'],
  'Bloway Candy':        ['Bloway Candy.jpg'],
  // ── Cog Invasion Gags (earned tricks; art trickles in, listed as it lands) ──
  'High Dive':           ['High Dive.jpeg'],
  'Presentation':        ['Presentation.jpeg'],
  'Opera Singer':        ['Opera Singer.jpeg'],
  'Geyser':              ['Geyser.jpeg'],
  'Railroad':            ['Railroad.jpeg'],
  'Wedding Cake':        ['Wedding Cake.jpeg'],
  'Toontanic':           ['Toontanic.jpeg'],
  // ── Shadow Man and his Wonder Weapons ──
  // Same reason as the candies: no manifest entry means a card falls back to
  // <Name>.png, and these shipped as JPEG. Entries are added as the art
  // arrives — a weapon with no entry yet simply draws no portrait.
  'Shadow Man':          ['Shadow Man.jpg'],
  'Thundergun':          ['Thundergun.jpg'],
  'Lightning Bow':       ['Lightning Bow.jpg'],
  'Wunderwaffe DG-3 JZ': ['Wunderwaffe DG-3 JZ.jpg'],
  'Apothicon Servant':   ['Apothicon Servant.jpg'],
  // Pre-wired ahead of the file landing: no art on disk yet, and a 404 simply
  // draws no portrait rather than breaking the card.
  'Ray Gun':             ['Ray Gun.jpg'],
  // The Rift is a LANE state, not a card — no def carries this name. The entry
  // exists so the lane overlay can ask getCardArtPath for it by name like
  // anything else.
  'Apothicon Rift':      ['Apothicon Rift.jpg'],
  'Pinhead':             ['Pinhead.jpg'],
  // ── Variant-2 promoted (user-picked defaults, 2026-05-18) ──
  'Darth Vader':         ['Darth Vader 2.png'],
  'Dr. Doom':            ['Dr. Doom 3.png', 'Dr. Doom.png'],
  'Dr. Strange':         ['Dr. Strange 2.png'],
  'Emperor Palpatine':   ['Emperor Palpatine 2.png'],
  'Hulk':                ['Hulk 2.png'],
  'Iron Man':            ['Iron Man 2.png', 'Iron Man 3.png'],
  'Jason Voorhees':      ['Jason Voorhees 3.png', 'Jason Voorhees 2.png'],
  'Omni-Man':            ['Omni-Man 2.png'],
  'Bane':                ['Bane 2.jpg',               'Bane.png'],
  'Spider-Man':          ['Spider-Man 3.jpg', 'Spider-Man 2.png'],
  'Superman':            ['Superman 3.jpg', 'Superman.png'],
  'Symbiote Spider-Man': ['Symbiote Spider-Man 3.jpg', 'Symbiote Spider-Man 2.png'],
  'The Flash':           ['The Flash 2.png'],
  // ── Variant-2 promoted in second pass (2026-05-18 follow-up) ──
  'Ahsoka':              ['Ahsoka 2.png'],
  'Homelander':          ['Homelander.png',           'Homelander 2.jpg'],
  'Xenomorph':           ['Xenomorph 2.png',          'Xenomorph.png'],
  // ── Silver Surfer chrome / cosmic portrait additions (2026-05-26) ──
  'Silver Surfer':       ['Silver Surfer 3.png', 'Silver Surfer.png'],
  'Galactus':            ['Galactus 2.png'],
  'Scarlet Witch':       ['Scarlet Witch 3.png', 'Scarlet Witch 2.png'],
  'Deathstroke':         ['Deathstroke 2.png'],
  // ── 2026-08-14 art drop. New portrait FIRST so it is the default; the
  //    previous art stays in the list rather than being deleted, so the
  //    name-click cycle can still reach it and nothing is lost if one of
  //    these reads worse in-match than it does full-size.
  'Black Widow':         ['Black Widow 2.png',        'Black Widow.png'],
  'Yoda':                ['Yoda 2.png',               'Yoda.png'],
  'General Grievous':    ['General Grievous 2.png',   'General Grievous.png'],
  'Gamora':              ['Gamora 2.png'],
  // Ultron had no manifest entry at all — a single art file means no variant
  // picker is rendered. Adding him here is what makes the new portrait
  // reachable AND leaves the original one cycle-click away.
  'Ultron':              ['Ultron 2.png',             'Ultron.png'],
  // Invisible Woman and Sandman were in the same position as Ultron above:
  // one art file each, so no manifest entry and no variant picker. New
  // portrait leads, original stays one cycle-click behind it.
  'Invisible Woman':     ['Invisible Woman 2.png'],
  'Sandman':             ['Sandman 2.png'],
  // ── Single-art entries (webp) ──
  'Pennywise':           ['Pennywise 2.jpg'],
  'Freddy Krueger':      ['Freddy Krueger 2.png'],
  'Black Panther':       ['Black Panther.png',        'Black Panther 2.png'],
  // ── Variant-1 default kept (user kept original) ──
  'Anakin Skywalker':    ['Anakin Skywalker 2.png',   'Anakin Skywalker.png'],
  'Batman':              ['Batman.png', 'Batman 2.png'],
  'Venom':               ['Venom.png',                'Venom 2.png'],
  'Wolverine':           ['Wolverine.png'],
  // ── New art additions ──
  // Green Lantern had no manifest entry (single art = no picker). Original
  // stays the default; the new variant is one name-click cycle behind it.
  'Green Lantern':       ['Green Lantern.png',        'Green Lantern 2.png'],
  'Han Solo':            ['Han Solo.jpg'],
  'Darth Maul':          ['Darth Maul.jpg'],
  'Padme Amidala':       ['Padme Amidala.png'],
  'Luke Skywalker':      ['Luke Skywalker.png',       'Luke Skywalker 2.jpg'],
  // ── New portraits (2026-06-15) ──
  'Joker':               ['Joker 2.jpg'],
  'Carnage':             ['Carnage.png'],
  'Ghost Rider':         ['Ghost Rider.jpg'],
  'Rocket Raccoon':      ['Rocket Raccoon.png'],
  'Paul Atreides':       ['Paul Atreides.jpg'],
  'Jack Sparrow':        ['Jack Sparrow.jpg'],
  // Michael Myers — new fiery portrait as the primary (menu hero + in-game
  // default); original kept as a gallery variant.
  'Michael Myers':       ['Michael Myers 2.jpg'],
  'Captain America':     ['Captain America 2.jpg',   'Captain America.png'],
  // New horror portraits (2026-07-13) — new art as the primary, originals kept.
  'Ghostface':           ['Ghostface 2.jpg'],
  'Jigsaw':              ['Jigsaw 3.jpg'],
  // New character portraits (2026-07-14) — new art as the primary, originals kept.
  'Red Skull':           ['Red Skull 2.jpg'],
  'Martian Manhunter':   ['Martian Manhunter 2.jpg'],
  'Loki':                ['Loki 2.jpg'],
  'Predator':            ['Predator 2.jpg'],
  'Hela':                ['Hela 2.jpg'],
  'Optimus Prime':       ['Optimus Prime 2.jpg'],
  // Doomsday — new portrait as primary; artist signature cropped off the
  // bottom strip (card frames the head/torso, so nothing important is lost).
  'Doomsday':            ['Doomsday 2.jpg'],
  'Sabertooth':          ['Sabertooth 2.jpg'],
  'The Batman Who Laughs': ['The Batman Who Laughs 2.jpg', 'The Batman Who Laughs.png'],
  'Obi-Wan':             ['Obi-Wan 2.jpg'],
  'The Grinch':          ['The Grinch 2.jpg'],
  // Gremlins set (2026-07-15) — Stripe's art is a jpg, so it needs a manifest
  // entry (default lookup assumes <Name>.png). Gizmo/Gremlin resolve as pngs.
  'Stripe':              ['Stripe.jpg'],
  // Iron Giant (2026-07-15) — jpg art, same manifest-entry reason as Stripe.
  'Iron Giant':          ['Iron Giant.jpg'],
  // Killer Moth — default is the Gotham skyline pose (user preference); the
  // close-up portrait is the alternate. Name-click cycles between them.
  'Killer Moth':         ['Killer Moth 2.png',        'Killer Moth.png'],
  // Godzilla (2026-08-04) — jpg art, same manifest-entry reason as Stripe /
  // Iron Giant (default lookup assumes <Name>.png).
  'Godzilla':            ['Godzilla.jpg'],
  // Assimilate (2026-08-25) — the John Carpenter "The Thing" poster; the trick
  // is named "Assimilate" to avoid colliding with Marvel's The Thing (Ben
  // Grimm). jpg art, same manifest-entry reason as Stripe / Iron Giant /
  // Godzilla (default lookup assumes <Name>.png).
  'Assimilate':          ['Assimilate.jpg'],
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
    // THE ONLY LANDSCAPE ENVIRONMENT ART IN THE SET. Every other one is
    // portrait (Sewers 898x1280, Open Water 1024x1280, Boiler Room 897x1280);
    // this is 1536x1024, and the two things that make the picture readable —
    // the gate and the TYRANNOSAUR PADDOCK sign — sit left of centre. A default
    // 50% crop into a portrait card, and again into a lane four times taller
    // than it is wide, throws both away and leaves fence and rain. Pulled left
    // to the middle of the gate so the sign survives both crops.
    'Enclosure|Enclosure.png': '34% 45%',
    'Anakin Skywalker|Anakin Skywalker 2.png': '50% 46.7%',
    'Batman|Batman.png': '83.1% 39.8%',
    'Ghost Rider|Ghost Rider.jpg': '50% 28.9%',
    'Darth Maul|Darth Maul.jpg': '53.1% 47.4%',
    'Darth Vader|Darth Vader 2.png': '50% 0%',
    'Dr. Strange|Dr. Strange 2.png': '96% 30.5%',
    'Emperor Palpatine|Emperor Palpatine 2.png': '50% 71.4%',
    'Freddy Fazbear|Freddy Fazbear.png': '50% 51%',
    'Freddy Krueger|Freddy Krueger 2.png': '50% 0.6%',
    'Jack Sparrow|Jack Sparrow.jpg': '50% 53%',
    'Joker|Joker.png': '50% 0%',
    'Joker|Joker 2.jpg': '50% 38%',
    'Luke Skywalker|Luke Skywalker 2.jpg': '50% 35.9%',
    'Michael Myers|Michael Myers 2.jpg': '50% 0%',
    'Mr. Fantastic|Mr. Fantastic.png': '50% 0%',
    'Padme Amidala|Padme Amidala.png': '56.7% 0%',
    'Raven|Raven.png': '50% 0%',
    'Red Hulk|Red Hulk.png': '90% 81.9%',
    'Revan|Revan.png': '100% 20.7%',
    'Sandman|Sandman.png': '50% 0%',
    'Scarlet Witch|Scarlet Witch 2.png': '50% 49%',
    'Solomon Grundy|Solomon Grundy.png': '50% 9.4%',
    'Spider-Man|Spider-Man 3.jpg': '50% 0%',
    'Superman|Superman 3.jpg': '50% 21.5%',
    'Symbiote Spider-Man|Symbiote Spider-Man 3.jpg': '50% 72.1%',
    'The Grinch|The Grinch.png': '48% 50%',
    'Captain America|Captain America 2.jpg': '50% 14.8%',
    'Pennywise|Pennywise 2.jpg': '50% 35.7%',
    'Bane|Bane 2.jpg': '50% 11.6%',
    'Paul Atreides|Paul Atreides.jpg': '50% 50.3%',
    'Ghostface|Ghostface 2.jpg': '82% 70.3%',
    'Jigsaw|Jigsaw 2.jpg': '81% 50%',
    'Jigsaw|Jigsaw 3.jpg': '50% 0%',
    'Black Panther|Black Panther.png': '86.1% 72.9%',
    'Deadpool|Deadpool.png': '50% 74.6%',
    'Green Lantern|Green Lantern.png': '52.1% 50.6%',
    'Groot|Groot.png': '50% 65%',
    'Hela|Hela.png': '50% 46%',
    'Iron Man|Iron Man 2.png': '50% 0%',
    'Red Skull|Red Skull 2.jpg': '50% 0%',
    'Martian Manhunter|Martian Manhunter 2.jpg': '50% 0%',
    'Loki|Loki 2.jpg': '50% 67.7%',
    'Predator|Predator 2.jpg': '50% 8%',
    'Hela|Hela 2.jpg': '0% 45.7%',
    'Optimus Prime|Optimus Prime 2.jpg': '59.9% 21.8%',
    'Doomsday|Doomsday 2.jpg': '50% 0%',
    'Sabertooth|Sabertooth 2.jpg': '52% 10.7%',
    'The Batman Who Laughs|The Batman Who Laughs 2.jpg': '50% 45%',
    'Obi-Wan|Obi-Wan 2.jpg': '100% 68.4%',
    'Obi-Wan|Obi-Wan.png': '60% 50%',
    'The Grinch|The Grinch 2.jpg': '53.4% 23.4%',
    'Godzilla|Godzilla.jpg': '50% 0%',
    'Yoda|Yoda 2.png': '50% 50%',
    'Homelander|Homelander 2.jpg': '50.2% 55.6%',
    // ---- Gallery Audit → Publish to repo (2026-09-11) ----
    'Ahsoka|Ahsoka 2.png': '46.7% 1.4%',
    'Anakin Skywalker|Anakin Skywalker.png': '50% 40.1%',
    'Ant-Man|Ant-Man.png': '50% 67.8%',
    'Apocalypse|Apocalypse.png': '50% 55%',
    'Big Wig|Big Wig.png': '50% 23%',
    'Black Panther|Black Panther 2.png': '50% 0%',
    'Black Widow|Black Widow 2.png': '50% 64.1%',
    'Brainiac|Brainiac.png': '50% 0%',
    'Carnage|Carnage.png': '50% 25.2%',
    'Darkseid|Darkseid.png': '50% 69.4%',
    'Davy Jones|Davy Jones.png': '50% 53.4%',
    'Deathstroke|Deathstroke 2.png': '50% 39%',
    'Dormammu|Dormammu.png': '50% 27.8%',
    'Dr. Doom|Dr. Doom 3.png': '50% 52.9%',
    'Dr. Manhattan|Dr. Manhattan.png': '54.1% 14.4%',
    'Dr. Octopus|Dr. Octopus.png': '50% 0%',
    'Galactus|Galactus 2.png': '50% 24.9%',
    'Gamora|Gamora 2.png': '50% 23.5%',
    'Gargantua|Gargantua.png': '50% 57.2%',
    'General Grievous|General Grievous 2.png': '50% 0%',
    'General Grievous|General Grievous.png': '50% 54%',
    'Gojo|Gojo.png': '50% 44.1%',
    'Gorilla Grodd|Gorilla Grodd.png': '50% 55.4%',
    'Gorr|Gorr.png': '50% 48.5%',
    'Green Goblin|Green Goblin.png': '50% 52.1%',
    'Han Solo|Han Solo.jpg': '50% 48.1%',
    'Harley Quinn|Harley Quinn.png': '50% 0%',
    'Hawkeye|Hawkeye.png': '50% 41.1%',
    'Homelander|Homelander.png': '50% 49.3%',
    'Hulk|Hulk 2.png': '50% 65.6%',
    'Human Torch|Human Torch.png': '50% 51.7%',
    'Invisible Woman|Invisible Woman 2.png': '50% 0%',
    'Iron Giant|Iron Giant.jpg': '50% 15.7%',
    'Iron Man|Iron Man 3.png': '50% 8.8%',
    'Jango Fett|Jango Fett.png': '50% 40.2%',
    'Jason Voorhees|Jason Voorhees 3.png': '50% 4.5%',
    'Jason Voorhees|Jason Voorhees 2.png': '50% 0%',
    'Killer Moth|Killer Moth.png': '50% 0%',
    'King Shark|King Shark.png': '50% 50%',
    'Knull|Knull.png': '50% 44.6%',
    'Lex Luthor|Lex Luthor.png': '50% 0%',
    'Mace Windu|Mace Windu.png': '50% 32%',
    'Mahoraga|Mahoraga.png': '50% 28.1%',
    'Moder|Moder.png': '50% 50%',
    'Mr. Freeze|Mr. Freeze.png': '50% 0%',
    'Mr. Hollywood|Mr. Hollywood.png': '50% 20.3%',
    'Omni-Man|Omni-Man 2.png': '50% 6.5%',
    'Peacemaker|Peacemaker.png': '50% 42.3%',
    'Pinhead|Pinhead.jpg': '71.7% 50%',
    'Professor X|Professor X.png': '50% 65.4%',
    'Robber Baron|Robber Baron.png': '50% 28%',
    'Rocket Raccoon|Rocket Raccoon.png': '50% 55.2%',
    'Sandman|Sandman 2.png': '50% 32.1%',
    'Scarlet Witch|Scarlet Witch 3.png': '50% 0%',
    'Silver Surfer|Silver Surfer 3.png': '50% 93.9%',
    'Spawn|Spawn.png': '50% 0%',
    'Spider-Man|Spider-Man 2.png': '50% 28.5%',
    'Spinosaurus|Spinosaurus.png': '50% 27.2%',
    'T-Rex|T-Rex.png': '50% 26.5%',
    'Thanos|Thanos.png': '50% 63.7%',
    'The Big Cheese|The Big Cheese.png': '50% 11.1%',
    'The Flash|The Flash 2.png': '50% 34.1%',
    'Thor|Thor.png': '50% 67.2%',
    'Ultron|Ultron 2.png': '50% 0%',
    'Venom|Venom.png': '50% 67.2%',
    'Voldemort|Voldemort.png': '50% 7.2%',
    'Winter Soldier|Winter Soldier.png': '50% 57.7%',
    'Wolverine|Wolverine.png': '50% 33.5%',
    'Xenomorph|Xenomorph 2.png': '50% 23.3%',
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
    'Yoda|Yoda 2.png': '50% 0%',
    'Godzilla|Godzilla.jpg': '40% 0%',
    'Homelander|Homelander 2.jpg': '50% 60%',
    'Iron Giant|Iron Giant.jpg': '73% 30%',
    // ---- Gallery Audit → Publish to repo (2026-09-11) ----
    'Anakin Skywalker|Anakin Skywalker 2.png': '50% 50%',
    'Batman|Batman.png': '50% 50%',
    'Black Widow|Black Widow 2.png': '50% 50%',
  },
  zoomCard:  {   // "name|file" -> scale (1 = cover, e.g. 1.3)
    'Darth Maul|Darth Maul.jpg': 1.35,
    'Jack Sparrow|Jack Sparrow.jpg': 2.2,
    'The Grinch|The Grinch.png': 1.8,
    'Batman|Batman.png': 1.05,
    'Black Panther|Black Panther.png': 1.05,
    'Ghostface|Ghostface 2.jpg': 1.3,
    'Green Lantern|Green Lantern.png': 1.1,
    'Padme Amidala|Padme Amidala.png': 1.1,
    'Obi-Wan|Obi-Wan 2.jpg': 1.1,
    'Optimus Prime|Optimus Prime 2.jpg': 1.1,
    'The Grinch|The Grinch 2.jpg': 1.25,
    'Batman|Batman 2.png': 0.95,
    'Homelander|Homelander 2.jpg': 1.3,
    // ---- Gallery Audit → Publish to repo (2026-09-11) ----
    'Bane|Bane.png': 0.85,
    'Anakin Skywalker|Anakin Skywalker 2.png': 0.95,
    'Anti-Venom|Anti-Venom.png': 0.95,
    'Art the Clown|Art the Clown.png': 0.95,
    'Bane|Bane 2.jpg': 0.95,
    'Black Panther|Black Panther 2.png': 0.95,
    'Black Widow|Black Widow 2.png': 0.95,
    'Brainiac|Brainiac.png': 0.95,
    'Carnage|Carnage.png': 0.95,
    'Darkseid|Darkseid.png': 0.95,
    'Deadpool|Deadpool.png': 0.95,
    'Doomsday|Doomsday 2.jpg': 0.95,
    'Dormammu|Dormammu.png': 0.95,
    'Dr. Manhattan|Dr. Manhattan.png': 1.2,
    'Gargantua|Gargantua.png': 0.6,
    'Gojo|Gojo.png': 0.95,
    'Gorilla Grodd|Gorilla Grodd.png': 0.95,
    'Loki|Loki 2.jpg': 0.95,
    'Mahoraga|Mahoraga.png': 0.9,
    'Omni-Man|Omni-Man 2.png': 0.95,
    'Paul Atreides|Paul Atreides.jpg': 0.95,
    'Predator|Predator 2.jpg': 0.95,
    'Rocket Raccoon|Rocket Raccoon.png': 0.95,
    'Sabertooth|Sabertooth 2.jpg': 0.95,
    'Ultron|Ultron.png': 1.15,
  },
  zoomMenu:  {   // "name|file" -> scale
    'Darth Maul|Darth Maul.jpg': 1.6,
    'The Grinch|The Grinch.png': 1.9,
    'Batman|Batman.png': 1.05,
    'Ghostface|Ghostface 2.jpg': 1.3,
    'Padme Amidala|Padme Amidala.png': 1.1,
    'Obi-Wan|Obi-Wan 2.jpg': 1.1,
    'Optimus Prime|Optimus Prime 2.jpg': 1.1,
    'The Grinch|The Grinch 2.jpg': 1.15,
    'Yoda|Yoda 2.png': 1.05,
    'Godzilla|Godzilla.jpg': 1.05,
    // ---- Gallery Audit → Publish to repo (2026-09-11) ----
    'Anakin Skywalker|Anakin Skywalker 2.png': 1.1,
    'Black Widow|Black Widow 2.png': 0.9,
  },
};

// ART GRADE — per-file brightness correction, computed not hand-tuned.
// The set was never graded as a SET: measured across all 229 files the mean
// luminance ran 4.8 to 176.4, a 36x spread, purely because each source image
// landed where it landed. On a pure-black board that makes some cards read as
// lightboxes and others nearly vanish.
//
// This COMPRESSES the range rather than flattening it, because the extremes
// are usually meaningful — Jaws is underwater, Pennywise is a sewer, Freddy
// Fazbear is a dark room, and normalising those to the median would delete the
// intent. Each file is pulled toward the median by (median/lum)^0.55 and then
// HARD CLAMPED to [0.80, 1.30], so nothing moves more than a third and the
// relative order is preserved: darker art stays darker.
//   p10-p90 spread  3.52x -> 2.18x
//   207 files corrected, the rest left alone.
// Regenerate by re-measuring the files; do not hand-edit individual numbers.
window.CARD_ART_GRADE = {
    "Adamantium.png": 1.03,
    "Ahsoka 2.png": 0.80,
    "Ahsoka.png": 0.89,
    "Anakin Skywalker 2.png": 1.16,
    "Anakin Skywalker.png": 1.30,
    "Ant-Man.png": 0.80,
    "Ant.png": 1.30,
    "Anti-Life Equation.png": 1.05,
    "Apocalypse.png": 0.91,
    "Art the Clown.png": 1.25,
    "Bacta Tank.png": 1.19,
    "Bane 2.jpg": 1.30,
    "Bane.png": 0.84,
    "Bat Signal.png": 1.10,
    "Batarangs.png": 0.88,
    "Batman 2.png": 0.80,
    "Batman 3.png": 1.12,
    "Battle Droid.png": 1.30,
    "Bifrost.png": 0.87,
    "Black Panther 2.png": 1.15,
    "Black Panther.png": 0.80,
    "Black Widow 2.png": 1.30,
    "Boiler Room.png": 1.30,
    "Captain America 2.jpg": 1.30,
    "Captain America.png": 0.80,
    "Carnage.png": 1.03,
    "Catwoman.png": 0.94,
    "Collapsed Lane.png": 1.30,
    "Cyborg.png": 0.87,
    "Darkseid.png": 1.30,
    "Darth Maul.jpg": 1.08,
    "Darth Vader 2.png": 1.30,
    "Darth Vader.png": 1.17,
    "Davy Jones.png": 1.03,
    "Deadpool.png": 0.80,
    "Deathstroke 2.png": 1.30,
    "Deathstroke.png": 1.26,
    "Doombot.png": 1.30,
    "Doomsday 2.jpg": 0.92,
    "Doomsday.png": 0.94,
    "Dormammu.png": 0.92,
    "Dr. Doom 2.png": 0.89,
    "Dr. Doom 3.png": 1.30,
    "Dr. Manhattan.png": 0.82,
    "Dr. Octopus.png": 0.92,
    "Dr. Strange.png": 0.85,
    "Droideka.png": 0.81,
    "Emperor Palpatine 2.png": 1.27,
    "Emperor Palpatine.png": 1.30,
    "Fear Toxin.png": 0.96,
    "Freddy Fazbear.png": 1.30,
    "Freddy Krueger 2.png": 1.30,
    "Freddy Krueger.png": 1.26,
    "Galactus 2.png": 0.96,
    "Galactus.png": 1.06,
    "Gamora 2.png": 1.30,
    "Gamora.png": 0.83,
    "Gargantua.png": 1.30,
    "General Grievous 2.png": 0.92,
    "General Grievous.png": 0.87,
    "Ghost Rider.jpg": 1.30,
    "Ghostface 2.jpg": 0.95,
    "Ghostface.png": 1.18,
    "Gizmo.png": 1.30,
    "Godzilla.jpg": 1.05,
    "Gojo.png": 1.30,
    "Gorr.png": 0.93,
    "Green Goblin.png": 0.85,
    "Green Lantern 2.png": 0.97,
    "Green Lantern.png": 0.80,
    "Gremlin.png": 1.30,
    "Groot.png": 0.87,
    "Han Solo.jpg": 1.30,
    "Harley Quinn.png": 0.87,
    "Hawkeye.png": 0.80,
    "Hela 2.jpg": 0.89,
    "Hela.png": 1.28,
    "Homelander 2.jpg": 1.30,
    "Homelander.png": 1.30,
    "Hulk 2.png": 0.97,
    "Human Torch.png": 0.88,
    "Invisible Woman 2.png": 0.81,
    "Invisible Woman.png": 0.92,
    "Iron Giant.jpg": 1.30,
    "Iron Man 2.png": 1.30,
    "Iron Man 3.png": 0.80,
    "Iron Man.png": 0.93,
    "Jack Sparrow.jpg": 0.80,
    "Jango Fett.png": 0.95,
    "Jason Voorhees 2.png": 0.83,
    "Jason Voorhees 3.png": 1.13,
    "Jason Voorhees.png": 0.90,
    "Jaws.png": 1.30,
    "Jigsaw 2.jpg": 1.30,
    "Jigsaw 3.jpg": 1.30,
    "Jigsaw.png": 0.92,
    "Joker 2.jpg": 0.80,
    "Joker's Playing Card.png": 0.84,
    "Joker.png": 1.30,
    "Juggernaut.png": 0.83,
    "Kang.png": 0.80,
    "Killer Moth 2.png": 1.20,
    "Killer Moth.png": 0.84,
    "King Shark.png": 1.06,
    "Knull.png": 1.16,
    "Kryptonite.png": 0.86,
    "Lasso of Truth.png": 0.81,
    "Lazarus Pit.png": 1.17,
    "Lex Luthor.png": 0.96,
    "Loki 2.jpg": 1.24,
    "Loki.png": 0.96,
    "Luke Skywalker 2.jpg": 0.89,
    "Luke Skywalker.png": 0.97,
    "Mace Windu.png": 1.14,
    "Magneto.png": 0.86,
    "Mahoraga.png": 1.06,
    "Man-Bat.png": 1.13,
    "Martian Manhunter 2.jpg": 0.96,
    "Martian Manhunter.png": 1.30,
    "Michael Myers 2.jpg": 1.30,
    "Michael Myers.png": 0.91,
    "Mind Stone.png": 0.92,
    "Mobius Chair.png": 0.85,
    "Mr. Fantastic.png": 0.90,
    "Mr. Freeze.png": 0.84,
    "Nightwing.png": 0.90,
    "Nth Metal.png": 1.27,
    "Obi-Wan 2.jpg": 1.23,
    "Omni-Man 2.png": 0.94,
    "Omni-Man.png": 1.23,
    "Open Water.png": 1.30,
    "Optimus Prime 2.jpg": 0.86,
    "Optimus Prime.png": 0.97,
    "Padme Amidala.png": 0.91,
    "Parademon.png": 0.93,
    "Paul Atreides.jpg": 1.20,
    "Peacemaker.png": 0.80,
    "Pennywise 2.jpg": 1.30,
    "Pennywise.png": 1.30,
    "Phantom Zone.png": 0.91,
    "Poison Ivy.png": 1.30,
    "Power Battery.png": 0.80,
    "Power Stone.png": 0.92,
    "Predator.png": 0.91,
    "Pym Particles.png": 1.30,
    "Reality Stone.png": 0.92,
    "Red Hulk.png": 0.80,
    "Red Skull.png": 1.30,
    "Revan.png": 1.08,
    "Rocket Raccoon.png": 0.87,
    "Sabertooth 2.jpg": 1.12,
    "Sabertooth.png": 0.90,
    "Sandman 2.png": 0.81,
    "Sandman.png": 1.28,
    "Scarlet Witch 2.png": 1.26,
    "Scarlet Witch 3.png": 0.97,
    "Scarlet Witch.png": 0.80,
    "Seismic Charge.png": 1.08,
    "Sewers.png": 1.30,
    "Silver Surfer 2.png": 1.30,
    "Silver Surfer 3.png": 1.30,
    "Silver Surfer.png": 0.89,
    "Smoke Pellet.png": 0.90,
    "Solomon Grundy.png": 1.30,
    "Space Stone.png": 1.05,
    "Spawn.png": 1.12,
    "Spider-Man 2.png": 1.18,
    "Spider-Man 3.jpg": 1.07,
    "Spider-Man.png": 0.91,
    "Star-Lord.png": 0.89,
    "Stripe.jpg": 1.08,
    "Super Soldier Serum.png": 0.80,
    "Superman 2.png": 0.94,
    "Superman 3.jpg": 1.30,
    "Superman.png": 1.13,
    "Symbiote Spider-Man 2.png": 1.16,
    "Symbiote Spider-Man 3.jpg": 1.30,
    "Symbiote Spider-Man.png": 0.80,
    "Thanos.png": 0.96,
    "The Bathroom.png": 0.80,
    "The Batman Who Laughs 2.jpg": 1.30,
    "The Batman Who Laughs.png": 1.30,
    "The Flash 2.png": 0.83,
    "The Flash.png": 0.97,
    "The Grinch 2.jpg": 0.80,
    "The Grinch.png": 1.05,
    "Game Over.png": 1.30,
    "The Thing.png": 0.81,
    "Thor.png": 0.86,
    "Time Stone.png": 0.88,
    "Trigon.png": 1.24,
    "Two-Face Coin.png": 1.27,
    "Ultron 2.png": 1.30,
    "Ultron.png": 1.03,
    "Undead Warrior.png": 1.30,
    "Venom 2.png": 0.83,
    "Venom.png": 0.80,
    "Voldemort.png": 0.93,
    "Wetlands.png": 1.30,
    "Winter Soldier.png": 1.10,
    "Wolverine.png": 1.22,
    "Wonder Woman.png": 0.80,
    "Xenomorph 2.png": 1.15,
    "Xenomorph.png": 1.25,
    "Yoda 2.png": 0.92,
    "Yoda.png": 1.06,
};

// =============================================================================
// CARD ART ACCENT — HAND OVERRIDES
// =============================================================================
// The card's border colour normally comes from its own painting, computed in
// card-art-accent.js (GENERATED — regenerate with sim/tools/card-art-accent.py).
// Anything listed here wins over that, and nothing regenerates this file.
//
// WHY IT EXISTS. The generator answers "which hue occupies the most
// chroma-weighted area of this picture". A person answers "what colour is the
// character". Those usually agree and sometimes do not: Carnage is a red
// symbiote lit blue, and the blue really does cover more of the painting — a
// centre-weighted vote up to 0.80 does not move him, so it is not a background
// ring that can be weighted away. Telling subject from setting needs saliency,
// which is a lot of machinery for a border colour, so the escape hatch is a
// list instead.
//
// Key by FILE (preferred — follows art variants) or by card NAME. Value is an
// "r,g,b" string. Keep it short: every entry here is a place the generated
// answer was overruled, and a long list means the generator needs fixing.
//   'Carnage.png': '240,58,60',
window.CARD_ART_ACCENT_OVERRIDE = {
  // SUPERMAN — owner: "i want supermans border to be the red in the art".
  // Keyed by NAME, not file, so it holds across both of his variants.
  //
  // The generator got the HUE right and lost it on SATURATION. 'Superman 3.jpg'
  // is a near-black painting whose only colour is the glowing S and the red rim
  // light on his face: measured, just 2.2% of its pixels carry any chroma, so
  // chroma_frac came out 0.0151, the sat ramp bottomed out at the 0.12 floor and
  // the border fell through to steel — 188,169,171, a washed beige that reads as
  // dirt on a black card. The hue it found was 355 deg, i.e. it knew the picture
  // was red all along.
  //
  // So this is not a hand-picked colour. The red population of the painting was
  // binned the same way the generator bins hue (peak, not mean — a magenta tail
  // drags a mean) and the peak ran through the shipped neon() at the vividness a
  // colourful painting would have earned:
  //
  //     Superman 3.jpg   red peak 353.7 deg   ->  neon()  ->  240,57,76
  //     Superman.png     red peak 347.6 deg   ->  neon()  ->  241,63,100
  //
  // Six degrees apart, so one entry serves both paintings rather than two, and
  // the value below is the one taken from the art that is actually on screen
  // (Superman 3.jpg is first in CARD_ART_VARIANTS). Proved side by side against
  // both paintings before it was written down.
  //
  // The same steel collapse is sitting on 15 other files (Bane, Han Solo,
  // Freddy Fazbear, Venom 2 ...). Fixing it properly means teaching the
  // generator that a small intense subject on black is not a monochrome image,
  // which re-derives all 259 borders — a much larger change than one card.
  'Superman': '240,57,76',
};
