// ============================================================
// STARTER DECKS — used by Deckbuilder mode (phase 2)
//
// Each deck is 40 cards + 10 tricks, flat 2-copy limit. Until the deck
// builder UI (phase 3) lets the user construct their own, both sides
// default to STARTER_DECKS.balanced.
//
// Deck shape:
//   { name, description, cards: [name, ...], tricks: [name, ...] }
// Card/trick names must match entries in CARD_DEFS / TRICK_DEFS exactly.
// Repeats in the list are intentional (2 copies → list the name twice).
// ============================================================

const STARTER_DECKS = {
  balanced: {
    name: 'Balanced Starter',
    description: 'A mix of aggro, control, and value across the cost curve.',
    // 40 cards — 20 unique × 2 copies (flat 2-copy limit).
    cards: [
      'Ant-Man', 'Ant-Man',
      'King Shark', 'King Shark',
      'Harley Quinn', 'Harley Quinn',
      'Hawkeye', 'Hawkeye',
      'Mr. Freeze', 'Mr. Freeze',
      'Invisible Woman', 'Invisible Woman',
      'Black Panther', 'Black Panther',
      'Captain America', 'Captain America',
      'Scarlet Witch', 'Scarlet Witch',
      'Iron Man', 'Iron Man',
      'Darth Vader', 'Darth Vader',
      'Batman', 'Batman',
      'Superman', 'Superman',
      'Thanos', 'Thanos',
      'Dr. Manhattan', 'Dr. Manhattan',
      'Spider-Man', 'Spider-Man',
      'Wolverine', 'Wolverine',
      'Deadpool', 'Deadpool',
      'Hulk', 'Hulk',
      'Wonder Woman', 'Wonder Woman',
    ],
    // 10 tricks — 5 unique × 2 copies.
    tricks: [
      'Bat Signal', 'Bat Signal',
      'Batarangs', 'Batarangs',
      'Fear Toxin', 'Fear Toxin',
      'Mother Box', 'Mother Box',
      'Nth Metal', 'Nth Metal',
    ],
  },
  aggro: {
    name: 'Aggro Rush',
    description: 'Flood the board early and punch through before the opponent stabilizes.',
    // Low-cost heavy, cheap punchers + Hawkeye splash support.
    cards: [
      'Ant-Man', 'Ant-Man',
      'King Shark', 'King Shark',
      'Black Widow', 'Black Widow',
      'Sabertooth', 'Sabertooth',
      'Hawkeye', 'Hawkeye',
      'Gorilla Grodd', 'Gorilla Grodd',
      'Harley Quinn', 'Harley Quinn',
      'Mr. Freeze', 'Mr. Freeze',
      'Deathstroke', 'Deathstroke',
      'Black Panther', 'Black Panther',
      'Iron Man', 'Iron Man',
      'Darth Vader', 'Darth Vader',
      'Predator', 'Predator',
      'Scarlet Witch', 'Scarlet Witch',
      'Symbiote Spider-Man', 'Symbiote Spider-Man',
      'Bane', 'Bane',
      'Ghostface', 'Ghostface',
      'Winter Soldier', 'Winter Soldier',
      'Peacemaker', 'Peacemaker',
      'Human Torch', 'Human Torch',
    ],
    tricks: [
      'Batarangs', 'Batarangs',
      'Bat Signal', 'Bat Signal',
      'Bifrost', 'Bifrost',
      'Power Stone', 'Power Stone',
      'Super Soldier Serum', 'Super Soldier Serum',
    ],
  },
  control: {
    name: 'Villain Control',
    description: 'Trade efficiently early, dominate the late game with finishers.',
    // Control tools, then the biggest threats.
    cards: [
      'Mr. Freeze', 'Mr. Freeze',
      'Poison Ivy', 'Poison Ivy',
      'Man-Bat', 'Man-Bat',
      'Mr. Fantastic', 'Mr. Fantastic',
      'Invisible Woman', 'Invisible Woman',
      'Captain America', 'Captain America',
      'Venom', 'Venom',
      'Magneto', 'Magneto',
      'Dr. Strange', 'Dr. Strange',
      'Dr. Doom', 'Dr. Doom',
      'Darkseid', 'Darkseid',
      'Superman', 'Superman',
      'Thanos', 'Thanos',
      'Dormammu', 'Dormammu',
      'Galactus', 'Galactus',
      'Loki', 'Loki',
      'Emperor Palpatine', 'Emperor Palpatine',
      'Trigon', 'Trigon',
      'Knull', 'Knull',
      'Lex Luthor', 'Lex Luthor',
    ],
    tricks: [
      'Kryptonite', 'Kryptonite',
      'Fear Toxin', 'Fear Toxin',
      'Mother Box', 'Mother Box',
      'The Darkhold', 'The Darkhold',
      'Phantom Zone', 'Phantom Zone',
    ],
  },
  // ----------------------------------------------------------------
  // REANIMATOR — graveyard recursion. Trade early, then leverage
  // dead-pile triggers (Solomon Grundy onDeath draw, Hela zombies,
  // Cyborg summon-on-destroyed, Lazarus Pit / Phantom Zone) to put
  // threats back on the board faster than the opponent can clear
  // them. The deck WANTS its allies dying — death is the engine.
  // ----------------------------------------------------------------
  reanimator: {
    name: 'Reanimator',
    description: 'Sacrifice your dead pile and revive them stronger. Wear the opponent down with a wave that won\'t stay buried.',
    cards: [
      'Ant-Man', 'Ant-Man',
      'King Shark', 'King Shark',
      'Xenomorph', 'Xenomorph',
      'Solomon Grundy', 'Solomon Grundy',
      'Carnage', 'Carnage',
      'Ghost Rider', 'Ghost Rider',
      'Anti-Venom', 'Anti-Venom',
      'Jason Voorhees', 'Jason Voorhees',
      'Michael Myers', 'Michael Myers',
      'Wolverine', 'Wolverine',
      'Hela', 'Hela',
      'Mahoraga', 'Mahoraga',
      'Dr. Doom', 'Dr. Doom',
      'Gorr', 'Gorr',
      'Knull', 'Knull',
      'Freddy Fazbear', 'Freddy Fazbear',
      'Ghostface', 'Ghostface',
      'Doomsday', 'Doomsday',
      'Spawn', 'Spawn',
      'Venom', 'Venom',
    ],
    tricks: [
      'Lazarus Pit', 'Lazarus Pit',
      'Phantom Zone', 'Phantom Zone',
      'Soul Stone', 'Soul Stone',
      'Mother Box', 'Mother Box',
      'The Darkhold', 'The Darkhold',
    ],
  },
  // ----------------------------------------------------------------
  // SYNERGY SWARM — every ally amplifies every other ally. Poison
  // Ivy steals their ATK; Hawkeye splashes their lanes; Captain
  // America buffs the squad; Invisible Woman shields them. Wins
  // by building a board where every card on it is stronger than it
  // would be alone. Vulnerable to wipes — keep redundancy.
  // ----------------------------------------------------------------
  swarm: {
    name: 'Synergy Swarm',
    description: 'Cards that buff their neighbors. Build a board where every ally makes every other ally stronger.',
    cards: [
      'Ant-Man', 'Ant-Man',
      'Poison Ivy', 'Poison Ivy',
      'Hawkeye', 'Hawkeye',
      'Invisible Woman', 'Invisible Woman',
      'Jango Fett', 'Jango Fett',
      'Scarlet Witch', 'Scarlet Witch',
      'Captain America', 'Captain America',
      'Spider-Man', 'Spider-Man',
      'Iron Man', 'Iron Man',
      'Optimus Prime', 'Optimus Prime',
      'Magneto', 'Magneto',
      'Professor X', 'Professor X',
      'Wolverine', 'Wolverine',
      'Omni-Man', 'Omni-Man',
      'Silver Surfer', 'Silver Surfer',
      'Gizmo', 'Gizmo',
      'Groot', 'Groot',
      'Padme Amidala', 'Padme Amidala',
      'Yoda', 'Yoda',
      'Star-Lord', 'Star-Lord',
    ],
    tricks: [
      'Power Battery', 'Power Battery',
      'Super Soldier Serum', 'Super Soldier Serum',
      'Nth Metal', 'Nth Metal',
      'Adamantium', 'Adamantium',
      'Vibranium', 'Vibranium',
    ],
  },
  // ----------------------------------------------------------------
  // RAMP TITANS — Dr. Octopus's "+1 Energy each round" + Power
  // Battery + Mobius Chair lets you slam 8/9/10-cost finishers two
  // rounds ahead of curve. Cheap defenders to survive the windup,
  // then one of the biggest game-ending bombs in the pool. Loses
  // to aggro that closes before you stabilize.
  // ----------------------------------------------------------------
  ramp: {
    name: 'Ramp Titans',
    description: 'Stall, accelerate, then slam game-ending finishers two rounds ahead of schedule.',
    cards: [
      'Ant-Man', 'Ant-Man',
      'Mr. Freeze', 'Mr. Freeze',
      'Invisible Woman', 'Invisible Woman',
      'Dr. Octopus', 'Dr. Octopus',
      'Groot', 'Groot',
      'Moder', 'Moder',
      'Davy Jones', 'Davy Jones',
      'Spider-Man', 'Spider-Man',
      'Hulk', 'Hulk',
      'Obi-Wan', 'Obi-Wan',
      'Ultron', 'Ultron',
      'Silver Surfer', 'Silver Surfer',
      'Darth Vader', 'Darth Vader',
      'Galactus', 'Galactus',
      'Dr. Manhattan', 'Dr. Manhattan',
      'Anakin Skywalker', 'Anakin Skywalker',
      'Trigon', 'Trigon',
      'Knull', 'Knull',
      'Dormammu', 'Dormammu',
      'Thanos', 'Thanos',
    ],
    tricks: [
      'Power Battery', 'Power Battery',
      'Bifrost', 'Bifrost',
      'Mobius Chair', 'Mobius Chair',
      'Eye of Agamotto', 'Eye of Agamotto',
      'Time Stone', 'Time Stone',
    ],
  },
  // ----------------------------------------------------------------
  // BURN RUSH — beats the opponent's HP bar before they can build a
  // board. Sabertooth's "+1/+1 on HP damage" snowballs each round.
  // Hawkeye splash + Carnage / Spawn direct damage tear through HP.
  // Late finishers (Thor, Homelander, Gorr) close out before turn 5.
  // Loses to taunt / armor / heavy block-meter generation.
  // ----------------------------------------------------------------
  burn: {
    name: 'Burn Rush',
    description: 'Skip the board fight — punch the opponent\'s HP bar directly until it cracks.',
    cards: [
      'Sabertooth', 'Sabertooth',
      'Harley Quinn', 'Harley Quinn',
      'Hawkeye', 'Hawkeye',
      'Human Torch', 'Human Torch',
      'Spawn', 'Spawn',
      'Peacemaker', 'Peacemaker',
      'Gamora', 'Gamora',
      'Carnage', 'Carnage',
      'Deathstroke', 'Deathstroke',
      'Deadpool', 'Deadpool',
      'Homelander', 'Homelander',
      'Red Hulk', 'Red Hulk',
      'Joker', 'Joker',
      'Thor', 'Thor',
      'Gorr', 'Gorr',
      'Ghost Rider', 'Ghost Rider',
      'Omni-Man', 'Omni-Man',
      'Symbiote Spider-Man', 'Symbiote Spider-Man',
      'Winter Soldier', 'Winter Soldier',
      'Bane', 'Bane',
    ],
    tricks: [
      'Batarangs', 'Batarangs',
      'Nth Metal', 'Nth Metal',
      'Kryptonite', 'Kryptonite',
      'Fear Toxin', 'Fear Toxin',
      'Power Stone', 'Power Stone',
    ],
  },
};

// Browser global + (optional) node export for the sim harness.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = STARTER_DECKS;
}
