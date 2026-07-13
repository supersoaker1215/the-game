// ============================================================
// STARTER DECKS — used by Deckbuilder mode (phase 2)
//
// Each deck is 30 cards + 8 tricks, flat 2-copy limit. Until the deck
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
    // 30 cards — 15 unique × 2 copies (flat 2-copy limit).
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
    ],
    // 8 tricks — 4 unique × 2 copies.
    tricks: [
      'Bat Signal', 'Bat Signal',
      'Batarang', 'Batarang',
      'Fear Toxin', 'Fear Toxin',
      'Mother Box', 'Mother Box',
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
    ],
    tricks: [
      'Batarang', 'Batarang',
      'Bat Signal', 'Bat Signal',
      'Bifrost', 'Bifrost',
      'Power Stone', 'Power Stone',
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
    ],
    tricks: [
      'Kryptonite', 'Kryptonite',
      'Fear Toxin', 'Fear Toxin',
      'Mother Box', 'Mother Box',
      'The Darkhold', 'The Darkhold',
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
      // Cheap fodder — happy to die for the recursion engine
      'Ant-Man', 'Ant-Man',
      'King Shark', 'King Shark',
      'Xenomorph', 'Xenomorph',
      // Mid-cost death-trigger payoffs
      'Solomon Grundy', 'Solomon Grundy',
      'Carnage', 'Carnage',
      'Ghost Rider', 'Ghost Rider',
      'Anti-Venom', 'Anti-Venom',
      'Jason Voorhees', 'Jason Voorhees',
      'Michael Myers', 'Michael Myers',
      'Wolverine', 'Wolverine',
      // Reanimator core — turns death into board presence
      'Hela', 'Hela',
      'Mahoraga', 'Mahoraga',
      'Dr. Doom', 'Dr. Doom',
      'Gorr', 'Gorr',
      'Knull', 'Knull',
    ],
    tricks: [
      'Lazarus Pit', 'Lazarus Pit',         // bring back from dead pile
      'Phantom Zone', 'Phantom Zone',       // banish enemy reanimator targets
      'Soul Stone', 'Soul Stone',           // sacrifice + value
      'Mother Box', 'Mother Box',           // utility / draw
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
      'Poison Ivy', 'Poison Ivy',          // gains ATK from charmed allies
      'Hawkeye', 'Hawkeye',                // splash + atk-remove
      'Invisible Woman', 'Invisible Woman',// evade share
      'Jango Fett', 'Jango Fett',          // splash on attack
      'Scarlet Witch', 'Scarlet Witch',    // ally relocation
      'Captain America', 'Captain America',// squad-leader buff
      'Spider-Man', 'Spider-Man',
      'Iron Man', 'Iron Man',
      'Optimus Prime', 'Optimus Prime',
      'Magneto', 'Magneto',
      'Professor X', 'Professor X',
      'Wolverine', 'Wolverine',
      'Omni-Man', 'Omni-Man',
      'Silver Surfer', 'Silver Surfer',
    ],
    tricks: [
      'Power Battery', 'Power Battery',
      'Super Soldier Serum', 'Super Soldier Serum', // stat buff
      'Nth Metal', 'Nth Metal',                     // Invincible 1
      'Adamantium', 'Adamantium',                   // armor
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
      // Cheap survivability for the early rounds
      'Ant-Man', 'Ant-Man',
      'Mr. Freeze', 'Mr. Freeze',
      'Invisible Woman', 'Invisible Woman',
      // Ramp engine
      'Dr. Octopus', 'Dr. Octopus',        // +1 Energy/round while active
      'Groot', 'Groot',
      'Moder', 'Moder',
      // Mid-curve threats that buy time
      'Davy Jones', 'Davy Jones',
      'Spider-Man', 'Spider-Man',
      'Hulk', 'Hulk',
      'Obi-Wan', 'Obi-Wan',
      // Late-game payoffs (8-10 cost — what the ramp pays for)
      'Ultron', 'Ultron',
      'Silver Surfer', 'Silver Surfer',
      'Darth Vader', 'Darth Vader',
      'Galactus', 'Galactus',
      'Dr. Manhattan', 'Dr. Manhattan',
    ],
    tricks: [
      'Power Battery', 'Power Battery',     // +2 energy next turn
      'Bifrost', 'Bifrost',                 // movement / setup
      'Mobius Chair', 'Mobius Chair',       // tempo
      'Eye of Agamotto', 'Eye of Agamotto', // foresight + hand size
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
      // 1-cost direct-damage punchers
      'Sabertooth', 'Sabertooth',          // +1/+1 on HP damage
      'Harley Quinn', 'Harley Quinn',      // Crazy
      'Hawkeye', 'Hawkeye',                // splash
      // 2-cost burn curve
      'Human Torch', 'Human Torch',
      'Spawn', 'Spawn',
      'Peacemaker', 'Peacemaker',          // grows on kill
      'Gamora', 'Gamora',
      // 3-4 cost — direct damage payoffs
      'Carnage', 'Carnage',
      'Deathstroke', 'Deathstroke',
      'Deadpool', 'Deadpool',
      // Mid-late closers
      'Homelander', 'Homelander',
      'Red Hulk', 'Red Hulk',
      'Joker', 'Joker',
      'Thor', 'Thor',                      // lightning damage
      'Gorr', 'Gorr',                      // god-killer
    ],
    tricks: [
      'Batarang', 'Batarang',               // direct damage
      'Nth Metal', 'Nth Metal',
      'Kryptonite', 'Kryptonite',           // ATK strip on a problem
      'Fear Toxin', 'Fear Toxin',           // damage / disable
    ],
  },
};

// Browser global + (optional) node export for the sim harness.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = STARTER_DECKS;
}
