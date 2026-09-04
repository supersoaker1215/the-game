// ============================================================
// CARD DEFINITIONS — pure data, no callbacks
// Abilities (callbacks, passives, special props) are in abilities.js
// and merged at the bottom of this file.
//
// See card-text-audit.md for the canonical terminology glossary.
// Key rules:
//   - Keywords in the abilities[] array render as badges. NEVER repeat them in desc.
//   - Numeric formats: (X/Y) for summons, (+X/+Y) buffs, (−X/−Y) debuffs with real minus sign.
//   - Canonical triggers: When Played: / When Destroyed: / When Discarded: / When Damaged:
//     / Start of Tricks: / Start of Tricks (once): / Each Turn: / While Active: / Jump:
//   - Canonical targets: an enemy / the enemy opposite / an adjacent enemy / all enemies
//     / a random enemy / an enemy with ≤ N ATK (use ≤, not "or less")
//   - Splash N as a one-shot verb is allowed in desc (Xenomorph on-death etc.);
//     as a persistent attribute it belongs in the abilities array instead.
// ============================================================

// ============================================================
// SUMMONED TOKENS — display-only rows for the codex.
//
// These bodies are conjured on the fly by abilities (summonCardChoice takes
// name/cost/atk/hp directly) rather than stored in CARD_DEFS, so nothing else
// in the game knows their names. This table exists so the encyclopedia can
// still show them, and it lives HERE, with the rest of the card data, rather
// than inside the codex renderer — a test has to be able to read it, and it
// could not reach a constant declared inside a function.
//
// It MIRRORS the summonCardChoice() calls in abilities.js by hand, which is
// the weak link: nothing connects the two, so a token added to an ability just
// never appeared in the codex. Battle Droid went missing the day it was
// written, and Doombot had been missing far longer — Dr. Doom conjuring a 5/5
// the encyclopedia never admitted existed. sim/test.js reads every ability's
// source for summon-name literals and fails if one is not listed here, so the
// next omission is caught by the suite instead of by a player.
// ============================================================
const SUMMON_TOKEN_DEFS = [
  { name: 'Ant',            cost: 1, attack: 1, health: 1, abilities: ['Bullseye'], desc: 'Token — summoned by Ant-Man.' },
  { name: 'Battle Droid',   cost: 2, attack: 1, health: 1, abilities: ['Revive 2'], desc: 'When Revived: Add (+1/+1) permanently. Token — summoned by General Grievous.' },
  { name: 'Doombot',        cost: 5, attack: 5, health: 5, abilities: [],           desc: 'Token — summoned by Dr. Doom.' },
  { name: 'The Kraken',     cost: 4, attack: 5, health: 6, abilities: [],           desc: 'Token — summoned by Davy Jones.' },
  { name: 'Undead Warrior', cost: 1, attack: 3, health: 1, abilities: [],           desc: 'Token — summoned by Hela.' },
  { name: 'Parademon',      cost: 2, attack: 2, health: 1, abilities: [],           desc: 'Token — summoned by Darkseid.' },
];

const CARD_DEFS = [
  // ==================== COST 0 ====================
  { name: "Iron Giant", cost: 0, attack: 0, health: 0, type: "scifi",
    _neverPlayable: true,
    // "Draw 1" is carried for the BADGE — the sacrifice draw is real and should
    // be readable at a glance on the tile. The keyword's own drawOnPlay effect
    // is inert here and always will be: it fires only on play paths, and six
    // gates make sure this card is never played. The actual draw lives in
    // _ironGiantIntercept's doSave.
    abilities: ["Draw 1"],
    desc: "Leaves your hand only to save an ally. While in Hand: When an ally would be destroyed, you may sacrifice Iron Giant to save it. When Sacrificed: Deal 1 damage to all enemies. Draw a card." },
  // ==================== COST 1 ====================
  { name: "Ant-Man", cost: 1, attack: 2, health: 1, type: "hero",
    abilities: [],
    desc: "When Played: Destroy an enemy with ≤ 1 ATK or ≤ 1 HP. Summon a (1/1) Ant with Bullseye in any lane." },
  { name: "Poison Ivy", cost: 1, attack: 1, health: 3, type: "villain",
    abilities: [],
    desc: "Each Turn: Charm a random ally. Poison Ivy adds that ally's ATK for this turn. The bonus is lost if that ally is destroyed." },
  { name: "King Shark", cost: 1, attack: 3, health: 3, type: "villain",
    abilities: ["Overdrive"],
    desc: "" },
  { name: "Black Widow", cost: 1, attack: 2, health: 1, type: "hero",
    abilities: ["Bullseye", "Evade 1"],
    desc: "When Played: Freeze 1 an adjacent enemy." },
  { name: "Man-Bat", cost: 1, attack: 1, health: 3, type: "villain",
    abilities: ["Bullseye"],
    desc: "Start of Tricks: Can move to an empty lane. When Man-Bat moves, the enemy opposite takes (−1/−1)." },
  { name: "Harley Quinn", cost: 1, attack: 0, health: 1, type: "villain",
    abilities: ["Crazy", "Splash 1"],
    desc: "When Played: Both players draw a card. While Active: Deal 1 damage to your own HP before attacking." },
  { name: "Gorilla Grodd", cost: 1, attack: 2, health: 3, type: "villain",
    abilities: [],
    desc: "When Played: Mind Control an enemy with cost ≤ 3. You choose which of its own allies it attacks this turn." },
  { name: "Hawkeye", cost: 1, attack: 1, health: 2, type: "hero",
    abilities: ["Bullseye", "Splash 1"],
    desc: "When Played: Splash 1. While Active: Splash damage from allies removes 1 ATK." },
  { name: "Mr. Fantastic", cost: 1, attack: 0, health: 0, type: "hero",
    abilities: ["Draw 1"],
    desc: "When Discarded: The next 2 cards you draw cost 1 less." },
  { name: "Mr. Freeze", cost: 1, attack: 2, health: 3, type: "villain",
    abilities: [],
    desc: "When Played: Freeze 1 the enemy opposite. The next hit to your HP is negated." },
  { name: "Sabertooth", cost: 1, attack: 2, health: 3, type: "villain",
    abilities: [],
    desc: "While Active: Add (+1/+1) when dealing damage to the opponent's HP." },
  { name: "Boiler Room", cost: 1, attack: 0, health: 1, type: "environment",
    _spawnOnly: true,
    isEnvironment: true,
    abilities: [],
    desc: "While Active: Apply Burning 1 to enemies in this lane, and each turn Burning spreads to adjacent enemies. When a Burning enemy is destroyed, Freddy Krueger spawns in this lane, replacing Boiler Room, and Burning ends. If an ally is present, choose a lane to move them — if no open lanes exist, the ally is consumed and Freddy absorbs their stats." },
  { name: "Xenomorph", cost: 2, attack: 0, health: 1, type: "villain",
    abilities: [],
    desc: "While Active: Add (+1/+1) each time any other card enters the board. When Destroyed: Splash 1." },

  // ==================== COST 2 ====================
  { name: "Sewers", cost: 2, attack: 0, health: 1, type: "environment",
    _spawnOnly: true,
    isEnvironment: true,
    abilities: [],
    desc: "While Active: The first enemy card to enter this lane turns Sewers into a (3/5) Pennywise on your side. An ally in that lane moves to an empty lane — with no empty lane it is destroyed and Pennywise adds its stats." },
  { name: "Open Water", cost: 2, attack: 0, health: 1, type: "environment",
    _spawnOnly: true,
    isEnvironment: true,
    abilities: [],
    desc: "While Active: The first card destroyed in this lane turns Open Water into a (4/4) Jaws on your side. An ally in that lane moves to an empty lane — with no empty lane it is destroyed and Jaws adds its stats." },
  { name: "The Bathroom", cost: 2, attack: 0, health: 1, type: "environment",
    isEnvironment: true,
    _spawnOnly: true,
    abilities: [],
    // It never spawns anything — what it does happens entirely to the cards
    // standing OPPOSITE it, so that is the half its picture belongs on. Owner,
    // watching a room on their own half chain the card above it: "if thr
    // bathroom is on my side my cards are gtting chained becasue im in the
    // bathroom." The rule is unchanged; the picture moved to where it applies.
    actsOnOpponentSide: true,
    desc: "While Active: The next 2 enemy cards to enter this lane take (−2/−2) and are Chained — if moved they lose (−2/−2). The room drains away when the second one dies." },
  { name: "Game Over", cost: 2, attack: 0, health: 1, type: "environment",
    isEnvironment: true,
    _spawnOnly: true,
    abilities: [],
    desc: "While Active: The first enemy card to die in this lane rises on your side as a (2/2), as if newly played. An ally in that lane moves to an empty lane to make room. Game Over is then spent." },
  { name: "Enclosure", cost: 2, attack: 0, health: 1, type: "environment",
    _spawnOnly: true,
    // WHICH HALF THIS ROOM ACTS ON. Every other habitat's monster surfaces for
    // the side that owns it; the T-Rex breaks OUT of the paddock and joins the
    // opponent, against whoever stopped paying. One declaration, read twice:
    // releaseHabitatMonster puts the T-Rex on that side, and the lane backdrop
    // paints the picture on that same half, because the picture should be where
    // the room's business happens. (Owner: "the t rex breaks out of the
    // enclousre so he spawns on the enviroment so the enviroment would be
    // opposite the player … same with wetlands, the enemy spino spawns in the
    // envirmonet so if your facing him the enviroment is on the enemy side.")
    actsOnOpponentSide: true,
    // isEnvironment, NOT just type:"environment". They are not the same flag:
    // `type` is what the codex sorts on, `isEnvironment` is what the ENGINE
    // reads — playCard's env-slot branch, canPlaceEnvironment, cleanupDead's
    // invariant sweep. Without it this card was a combat body sitting in an env
    // slot, which is precisely what the sweep prints: "[INVARIANT @cleanup]
    // Enclosure (combat card) is in the ENV slot of lane 3". Every other
    // environment in this file carries both; this one was written with only
    // `type` and nothing had ever placed it, so nothing had ever noticed.
    isEnvironment: true,
    abilities: [],
    desc: "Each Turn: Pay 1 Energy to keep the gate shut, or refuse — refuse once and the T-Rex is released AGAINST you, into this lane on the enemy side. An enemy already standing there moves to an empty lane — with no empty lane it is destroyed and the T-Rex adds its stats. Pay the fourth toll and the park closes for good." },
  { name: "Wetlands", cost: 2, attack: 0, health: 1, type: "environment",
    _spawnOnly: true,
    isEnvironment: true,
    abilities: [],
    desc: "While Active: Each time either player's Block Meter fires, this lane loses 1 Power. At 0, Spinosaurus is released here, destroying the enemy in this lane. An ally there moves to an empty lane — with no empty lane it is destroyed and Spinosaurus adds its stats." },
  { name: "Bane", cost: 2, attack: 2, health: 3, type: "villain",
    abilities: ["Overdrive"],
    desc: "When Played: An enemy takes (−1/−1) and loses all Evade. While Active: Add (+1/+1) when damaged." },
  { name: "Catwoman", cost: 1, attack: 1, health: 1, type: "villain",
    abilities: ["Bullseye", "Evade 1"],
    desc: "When Played: Steal 1 Energy from the opponent next turn." },
  { name: "Spawn", cost: 2, attack: 3, health: 3, type: "villain",
    abilities: ["Bullseye", "Overdrive"],
    desc: "" },
  { name: "Gizmo", cost: 2, attack: 1, health: 1, type: "villain",
    abilities: [],
    desc: "When Damaged (once): Summon a (2/2) Gremlin in any open lane. Add Stripe to your hand." },
  { name: "Killer Moth", cost: 1, attack: 0, health: 1, type: "villain",
    abilities: [],
    desc: "Start of Tricks: Move to a random empty lane. Gains (+1/+1) the first time he reaches each lane. Returning to a lane he has already visited grants nothing." },
  { name: "Gremlin", cost: 2, attack: 2, health: 2, type: "villain",
    _spawnOnly: true,
    abilities: [],
    desc: "While Active: Add (+1/+0) for each other Gremlin or Stripe on the board." },
  { name: "Stripe", cost: 3, attack: 3, health: 3, type: "villain",
    _spawnOnly: true,
    abilities: [],
    desc: "Jump: When either player takes hero damage, play for free into any open lane. While Active: Counts as a Gremlin for Swarm. On Kill: Add (+1/+1) to Stripe and all your Gremlins. Summon a (2/2) Gremlin." },
  { name: "Dr. Strange", cost: 2, attack: 2, health: 1, type: "hero",
    abilities: ["Untrickable", "Evade 1"],
    desc: "When Played: Next draw phase, keep 1 of the top 2 cards as your draw. The other becomes the opponent's draw. While Active: Adjacent allies gain Untrickable." },
  { name: "Freddy Fazbear", cost: 5, attack: 3, health: 3, type: "villain",
    abilities: [],
    desc: "Jump: When the opponent ends their turn with 2 or more unspent Energy, play for free. While Active: Each time the opponent ends a turn with 2 or more unspent Energy, they lose 1 Energy at the start of the next round." },
  { name: "Freddy Krueger", cost: 2, attack: 1, health: 4, type: "villain",
    _spawnOnly: true,
    abilities: [],
    desc: "While Active: Freddy never attacks the card across from him — he stalks the enemy's hand on a two-round cycle (tricks are never targeted). Attack round: slash a random hand card for his ATK. At 0 HP it is destroyed; if it survives it falls Asleep — unplayable on its owner's next turn — and Freddy gains (+1/+1) permanently. Off round: half the enemy's hand cards (rounded down) each lose 1 HP." },
  { name: "Gamora", cost: 2, attack: 2, health: 3, type: "hero",
    abilities: [],
    desc: "When Played: Destroy an enemy with ≤ 2 HP. While Active: Add (+1/+1) when destroying an enemy." },
  { name: "Ghostface", cost: 2, attack: 2, health: 1, type: "villain",
    abilities: ["Bullseye"],
    desc: "Jump: When the enemy plays a Trick. When Played: Summon a (2/1) Ghostface with Bullseye in any lane." },
  { name: "Human Torch", cost: 2, attack: 2, health: 3, type: "hero",
    abilities: [],
    desc: "When Played: Splash 1. Apply Burning 2 to an enemy." },
  { name: "Invisible Woman", cost: 1, attack: 1, health: 1, type: "hero",
    abilities: ["Evade 1"],
    desc: "When Played: Give an ally Evade 1. While Active: You can play cards face-down. A face-down card can't be targeted or damaged, and its abilities fire when it reveals before Tricks." },
  { name: "Jango Fett", cost: 2, attack: 2, health: 4, type: "villain",
    abilities: ["Armor 1", "Hunt"],
    desc: "While Active: Splash 1 when moving to a new lane." },
  { name: "Juggernaut", cost: 2, attack: 2, health: 4, type: "hero",
    abilities: ["Bullseye", "Armor 1", "Immunity"],
    desc: "While Active: Adjacent allies gain Immunity 1." },
  { name: "Nightwing", cost: 2, attack: 3, health: 1, type: "hero",
    abilities: ["Evade 1"],
    desc: "When Played: Remove 2 ATK from an enemy." },
  { name: "Peacemaker", cost: 2, attack: 2, health: 3, type: "hero",
    abilities: [],
    desc: "When Played: Destroy an enemy with ≤ 2 ATK. While Active: Add (+1/+1) when destroying an enemy." },
  { name: "Rocket Raccoon", cost: 2, attack: 2, health: 1, type: "hero",
    abilities: [],
    desc: "When Played: Deal 4 damage to an enemy." },
  { name: "Sandman", cost: 1, attack: 3, health: 3, type: "villain",
    abilities: [],
    desc: "While Active: Enemy Tricks cost 1 more Energy." },
  { name: "The Flash", cost: 2, attack: 2, health: 1, type: "hero",
    abilities: ["Invincible 2"],
    desc: "When Played: Freeze 1 an adjacent enemy. Choose who plays first next turn." },
  { name: "The Thing", cost: 2, attack: 3, health: 2, type: "hero",
    abilities: ["Armor 2"],
    desc: "" },

  // ==================== COST 3 ====================
  { name: "Ahsoka", cost: 3, attack: 2, health: 2, type: "hero",
    abilities: ["Evade 1", "Draw 1"],
    desc: "While Active: Bonus attack each time an ally is destroyed." },
  { name: "Carnage", cost: 3, attack: 3, health: 4, type: "villain",
    abilities: ["Overdrive"],
    desc: "Start of Tricks (once): Heal yourself for each enemy on board." },
  { name: "Deathstroke", cost: 3, attack: 3, health: 3, type: "villain",
    abilities: [],
    desc: "When Played: Destroy an enemy with ≤ 3 HP. On Kill: Add (+1/+1)." },
  { name: "Dr. Octopus", cost: 3, attack: 2, health: 4, type: "villain",
    abilities: ["Splash 2"],
    desc: "While Active: Add 1 extra Energy each round." },
  { name: "Green Goblin", cost: 3, attack: 3, health: 3, type: "villain",
    abilities: [],
    desc: "When Played: Splash 1, then Splash 2. Start of Tricks: Move to an empty lane opposite an enemy and Splash 1." },
  { name: "Groot", cost: 3, attack: 4, health: 4, type: "hero",
    abilities: ["Armor 1"],
    desc: "When Played: Give adjacent allies Damage Immunity, and shield the adjacent lanes so uncontested enemies there can't attack — for 1 turn." },
  { name: "Jigsaw", cost: 2, attack: 0, health: 0, type: "villain",
    abilities: [],
    // EVENT-ONLY now, like the other habitat environments (Sewers, Boiler Room,
    // Open Water, Gargantua, Wetlands, Enclosure). _spawnOnly keeps him out of
    // the classic draw pile, the draft pool AND the summon deck (game.js
    // buildDecks / _initSummonDeck all filter it) so he can only arrive through
    // the Saw event. (Owner: these environments "should not be able to be drawn
    // ... make sure the environments are not draftable or drawable.")
    _spawnOnly: true,
    desc: "Saw event only: opens The Bathroom and Game Over in empty enemy lanes, then moves an enemy to an empty lane." },
  { name: "Brainiac", cost: 2, attack: 0, health: 0, type: "villain",
    // "Draw 1" is carried for the BADGE, the same arrangement Iron Giant uses
    // and for the same reason: his discard really does draw, and that should be
    // readable on the tile. The keyword's own drawOnPlay effect is inert and
    // always will be — it fires only on play paths, and he is isDiscardEffect,
    // which playCard AND summonCard both refuse. The real draw lives in his
    // onDiscard.
    abilities: ["Draw 1"],
    desc: "When Discarded: Draw a card, then see an enemy's hand for 2 rounds — every card they draw arrives at -1/-1 and pops up so you see it, and you steal the stat: your next 2 draws come in at +1/+1. In 2v2, choose which enemy. Only you can see their hand." },
  { name: "Loki", cost: 3, attack: 2, health: 1, type: "villain",
    abilities: ["Evade 1"],
    desc: "When Played: Fill your Block Meter." },
  { name: "Moder", cost: 3, attack: 2, health: 2, type: "villain",
    abilities: [],
    desc: "When Played: The opponent's next card is forced into this lane. That card loses all abilities and keywords." },
  { name: "Padme Amidala", cost: 3, attack: 2, health: 3, type: "hero",
    rarity: 3,
    abilities: ["Draw 1"],
    desc: "Each Turn: Add (+1/+1) to all other allies." },
  { name: "Red Skull", cost: 3, attack: 1, health: 4, type: "villain",
    abilities: [],
    desc: "When Played: Give a random card in your hand (+2/+2). While Active: Your cards can be played during the Trick Phase." },
  { name: "Scarlet Witch", cost: 3, attack: 0, health: 0, type: "hero",
    abilities: ["Draw 1"],
    copiesOpposite: true,
    desc: "When Played: Copy the ATK and HP of the enemy opposite. If there is no enemy opposite, become (3/4)." },
  { name: "Solomon Grundy", cost: 3, attack: 3, health: 6, type: "villain",
    abilities: ["Dead Draw 1"],
    desc: "When Destroyed: Draw a random card from the shared Dead Pile to your hand." },
  { name: "Star-Lord", cost: 3, attack: 2, health: 2, type: "hero",
    abilities: ["Taunt 1", "Evade 1"],
    desc: "When Played: Give an ally (+2/+2)." },
  { name: "Symbiote Spider-Man", cost: 2, attack: 3, health: 3, type: "hero",
    abilities: ["Evade 1"],
    desc: "When Played: Both players shuffle 2 cards back into the deck and draw 2. Heal yourself for 2." },
  { name: "Winter Soldier", cost: 3, attack: 3, health: 2, type: "villain",
    abilities: [],
    desc: "When Played: Destroy an enemy with ≤ 3 ATK. On Kill: Add (+1/+1)." },

  // ==================== COST 4 ====================
  // 3/5 -> 2/7 (owner, 2026-08-14): less swing, far harder to remove, which
  // suits a card whose whole value is surviving long enough for the 3-round
  // Block-Meter bypass to pay out.
  { name: "Pennywise", cost: 4, attack: 2, health: 7, type: "villain",
    _spawnOnly: true,
    abilities: [],
    desc: "When Played: For 3 rounds, all your damage to the enemy player bypasses their Block Meter. (Spawned only by Sewers.)" },
  { name: "Jaws", cost: 3, attack: 4, health: 4, type: "villain",
    _spawnOnly: true,
    abilities: ["Overdrive"],
    desc: "While Active: Ignores Armor and Evade. On Kill: Add (+0/+1) and heal to full. (Spawned by Open Water.)" },
  { name: "Anti-Venom", cost: 3, attack: 3, health: 5, type: "hero",
    abilities: [],
    desc: "When Played: Heal yourself for 4. You may move a card to an empty lane — an ally gains (+1/+1), an enemy loses (−1/−1)." },
  { name: "Black Panther", cost: 4, attack: 2, health: 3, type: "hero",
    abilities: ["Armor 1"],
    desc: "When Played: Play a card from your hand with base cost ≤ 3. While Active: Add (+1/+1) to each card you play." },
  { name: "Ghost Rider", cost: 6, attack: 4, health: 4, type: "hero",
    abilities: [],
    desc: "When Played: Fear 1 an enemy. When Destroyed: Summon a random card from your hand in Ghost Rider's lane." },
  { name: "Deadpool", cost: 4, attack: 3, health: 4, type: "hero",
    abilities: [],
    desc: "When Destroyed: Steal a card from the enemy's hand, then give them a card from yours." },
  { name: "Green Lantern", cost: 4, attack: 2, health: 4, type: "hero",
    abilities: [],
    desc: "While Active: Add Energy next round equal to the damage Green Lantern dealt this round." },
  { name: "Jason Voorhees", cost: 4, attack: 2, health: 2, type: "villain",
    abilities: ["Hunt", "Overdrive", "Revive 1"],
    desc: "Jump: When an ally is destroyed — into its lane. When Destroyed: Revive once per game as (3/4)." },
  { name: "Art the Clown", cost: 4, attack: 2, health: 2, type: "horror",
    abilities: [],
    _recurringBT: true,
    desc: "Jump: At the start of the Trick Phase, if the enemy has more cards on the field than you, play for free. When Played: Pull a weapon from the bag. Each round choose one — no weapon twice until all 4 are used, then Art is stats-only. Scissors: permanently strip a keyword from an enemy. Sledgehammer: deal double Art's ATK to an enemy. Scythe: permanently halve an enemy's ATK and HP. Hacksaw: an enemy bleeds 2 at the start of each of the next 2 rounds." },
  { name: "Paul Atreides", cost: 4, attack: 2, health: 1, type: "villain",
    abilities: [],
    desc: "When Played: Look at the top 2 cards of the draw pile and keep one — its cost drops by 2. If the kept card costs ≤ 2, you may play it for free." },
  { name: "Martian Manhunter", cost: 4, attack: 4, health: 4, type: "hero",
    abilities: ["Evade 1"],
    desc: "When Played: Copy all abilities from a random card in either Dead Pile, then fire its When Played effect." },
  { name: "Optimus Prime", cost: 3, attack: 4, health: 4, type: "hero",
    abilities: ["Armor 1"],
    desc: "When Played: An adjacent ally immediately attacks an enemy opposite or adjacent to Optimus Prime." },
  { name: "Predator", cost: 4, attack: 3, health: 4, type: "villain",
    abilities: ["Bullseye", "Evade 1", "Hunt"],
    desc: "When Played: Deal 3 damage to an enemy. On Kill: Add (+1/+0)." },
  { name: "Darth Maul", cost: 4, attack: 4, health: 4, type: "villain",
    abilities: [],
    desc: "When Played: Draw a Trick — it costs 1 less. While Active: Add (+2/+0) each time you play a Trick." },
  { name: "Raven", cost: 3, attack: 3, health: 4, type: "hero",
    abilities: [],
    desc: "When Played: Empty the opponent's Block Meter. Unfreeze all allies." },
  { name: "The Grinch", cost: 3, attack: 1, health: 2, type: "villain",
    abilities: [],
    desc: "When Played: Steal a Trick (opponent picks). Keep it (cost +1) or return it to triple The Grinch's stats. If opponent has no tricks, stats triple." },
  { name: "Venom", cost: 4, attack: 4, health: 6, type: "villain",
    abilities: [],
    desc: "When Played: Freeze 1 an enemy. Start of Tricks (once): Heal yourself for 1 per ally on the board." },
  { name: "Wolverine", cost: 4, attack: 2, health: 2, type: "hero",
    abilities: ["Revive 1"],
    desc: "When Damaged: Destroy the card that dealt the damage if its cost is ≤ 7. When Destroyed: Revive as (6/5) with Overdrive — When Damaged is removed." },
  { name: "Wonder Woman", cost: 4, attack: 3, health: 3, type: "hero",
    abilities: ["Armor 1", "Unresistible", "Draw 1"],
    desc: "When Played: Freeze 1 the enemy opposite. Add 2 to your Block Meter. While Active: When Wonder Woman's attack lands on an enemy card, deal (ATK−1) to 1 chained enemy." },

  // ==================== COST 5 ====================
  { name: "T-Rex", cost: 5, attack: 3, health: 7, type: "scifi",
    _spawnOnly: true,
    abilities: ["Armor 1", "Hunt", "Overdrive"],
    desc: "While Active: Each time the T-Rex moves to another lane, Freeze a random enemy." },
  { name: "Spinosaurus", cost: 5, attack: 4, health: 6, type: "scifi",
    _spawnOnly: true,
    // "Spawn Only" dropped from the BADGE list only — _spawnOnly above is the
    // engine gate and still keeps him out of every draft and draw pile. Owner
    // struck the badge off a screenshot: he is only ever spawned by Sewers, so
    // the chip stated something the player can never act on.
    // Hunt is the REAL keyword now, the same one Jason and Jango print — it
    // routes through _resolveHuntChase like theirs. It replaces a bespoke
    // start-of-round stalk that shared the name but was a separate mechanic;
    // "Hunt" and "Hunt Meter" parse as two independent entries, so both land.
    abilities: ["Hunt", "Hunt Meter"],
    desc: "While Active: Each time an enemy is damaged the Hunt Meter fills by 1 — at 3, the Hunt Meter is spent and Spinosaurus permanently gains Overdrive." },
  { name: "Davy Jones", cost: 5, attack: 3, health: 6, type: "villain",
    abilities: [],
    desc: "When Played: Summon The Kraken (5/6) in any lane." },
  { name: "Jack Sparrow", cost: 5, attack: 3, health: 5, type: "hero",
    abilities: [],
    desc: "While Active: Before each combat, choose an enemy in an uncontested lane. It cannot attack this round." },
  { name: "Han Solo", cost: 4, attack: 3, health: 4, type: "hero",
    abilities: [],
    desc: "First Strike: Han Solo attacks before other lanes. Choose any enemy lane for him to attack instead of his own. Each Turn: Each ally has a 50% chance to gain Critical — double damage for the round." },
  { name: "Captain America", cost: 5, attack: 3, health: 4, type: "hero",
    abilities: ["Armor 1"],
    desc: "When Played: Give an ally Invincible 1. While Active: All cards in your hand cost 1 less Energy." },
  { name: "Iron Man", cost: 5, attack: 4, health: 5, type: "hero",
    abilities: ["Armor 1"],
    desc: "Can be played during the Trick Phase. When Played: Destroy all hurt enemies with cost ≤ 8." },
  { name: "Joker", cost: 5, attack: 0, health: 5, type: "villain",
    abilities: ["Insane"],
    desc: "When Played: Fear 1 an enemy with cost ≤ 4. While Active: Give Crazy to the highest-ATK enemy. Only one enemy is Crazy at a time." },
  { name: "Lex Luthor", cost: 5, attack: 2, health: 6, type: "villain",
    abilities: [],
    desc: "While Active: The opponent cannot draw cards or do bonus attacks." },
  { name: "Michael Myers", cost: 3, attack: 3, health: 4, type: "villain",
    abilities: ["Overdrive"],
    desc: "Jump: When the enemy plays a card costing less than Michael Myers — into the lane opposite it." },
  { name: "Pinhead", cost: 2, attack: 0, health: 0, type: "horror",
    isDiscardEffect: true,
    abilities: [],
    desc: "When Discarded: Chain the enemy's CHEAPEST card to a random other card in their hand — neither can be played alone, they must be played the same turn, and both enter with -1/-1. Also steals 1 Block Meter from the enemy." },
  { name: "Professor X", cost: 5, attack: 0, health: 0, type: "hero",
    abilities: [],
    desc: "When Discarded: Permanently convert an enemy with cost ≤ 4 to your team and place it in an empty lane. Its When Played fires again." },
  { name: "Red Hulk", cost: 5, attack: 4, health: 5, type: "hero",
    abilities: [],
    desc: "When Damaged: Add the damage taken to your Block Meter, then Splash that much back." },
  { name: "Spider-Man", cost: 5, attack: 4, health: 4, type: "hero",
    abilities: ["Evade 1", "Unresistible"],
    desc: "When Played: Freeze 1 an enemy. While Active: When Spider-Man evades, add (+1/+1) and 50% of the time regain an evade charge." },
  { name: "The Batman Who Laughs", cost: 5, attack: 3, health: 3, type: "villain",
    abilities: [],
    desc: "When Played: Intercept the next card the enemy plays. Keep it in your hand or destroy it to add (+2/+2). Environments are not intercepted." },
  { name: "General Grievous", cost: 4, attack: 3, health: 4, type: "villain",
    abilities: ["Evade 1", "Overdrive"],
    desc: "When Played: Summon a (1/1) Battle Droid in any lane. On Kill: A random other ally gains (+1/+1) permanently." },
  { name: "Droideka", cost: 4, attack: 3, health: 4, type: "scifi",
    abilities: [],
    desc: "While Active: Alternates every round. Shields up (1st round on the field, 3rd, 5th…): Damage Immunity — takes no damage from any source. Shields down (2nd round, 4th…): deals double his ATK when he attacks." },
  { name: "Gargantua", cost: 2, attack: 0, health: 1, type: "environment",
    _spawnOnly: true,
    isEnvironment: true,
    abilities: [],
    desc: "Each Turn: Pay 1 Energy to pull all enemies 1 lane closer, or skip — Gargantua stays either way. An enemy pulled into this lane collides with the enemy already there — each deals its ATK to the other. If the occupant is destroyed, the pulled enemy takes the lane." },

  // ==================== COST 6 ====================
  { name: "Hela", cost: 6, attack: 5, health: 6, type: "villain",
    abilities: ["Dead Draw 1"],
    desc: "When Played: Summon 2 (3/1) Undead Warriors. When Destroyed: Draw a random card from the shared Dead Pile to your hand." },
  { name: "Homelander", cost: 4, attack: 4, health: 5, type: "villain",
    abilities: [],
    desc: "When Played: Choose to sacrifice an ally — either deal damage to an enemy equal to that ally's cost, or destroy an enemy with cost ≤ that ally's cost." },
  { name: "Hulk", cost: 6, attack: 4, health: 6, type: "hero",
    abilities: [],
    desc: "When Played: Deal 2 damage to all enemies. While Active: Splash equals Hulk's ATK. When Damaged: Add (+1/+2)." },
  { name: "Magneto", cost: 6, attack: 3, health: 5, type: "villain",
    abilities: [],
    desc: "When Played: Move 2 cards to empty lanes — allies or enemies. While Active: Remove (−1/−1) from enemies in even lanes. Add (+1/+1) to allies in odd lanes." },
  { name: "Obi-Wan", cost: 6, attack: 4, health: 8, type: "hero",
    abilities: ["Taunt 99"],
    desc: "While Active: Damage from enemies in other lanes is reflected back at the attacker. The enemy opposite is exempt. When Destroyed: Remove all ATK from the enemy opposite for the rest of this combat." },
  { name: "Ultron", cost: 6, attack: 5, health: 3, type: "villain",
    abilities: [],
    desc: "When Destroyed: Summon 2 (5/3) Ultron copies in the lowest and highest empty lanes. Copies don't trigger this effect." },

  // ==================== COST 7 ====================
  { name: "Dr. Doom", cost: 7, attack: 5, health: 5, type: "villain",
    abilities: [],
    desc: "When Played: Return a card from your Dead Pile (cost ≤ 9) to your hand with its cost permanently reduced by 3. Summon a (5/5) Doombot." },
  { name: "Gojo", cost: 7, attack: 6, health: 6, type: "hero",
    abilities: ["Immunity", "Invincible 1"],
    desc: "When Played: Move an enemy to an empty lane. Remove all ATK from the enemy opposite and both adjacent enemies for 1 turn. After Gojo's lane fights 2 combats: Destroy all enemies in 3 random lanes." },
  { name: "Gorr", cost: 7, attack: 4, health: 8, type: "villain",
    abilities: ["Evade 1", "Immunity"],
    desc: "When Played: Devour the highest-cost card from each player's hand. Summon a random card (cost 2-9) in any lane." },
  { name: "Mahoraga", cost: 7, attack: 7, health: 7, type: "villain",
    abilities: ["Revive 1"],
    desc: "While Active: Absorb all damage that would hit your HP. When Destroyed: Revive as (7/9) with Armor 1 and Immunity 1." },
  { name: "Omni-Man", cost: 7, attack: 4, health: 8, type: "villain",
    abilities: ["Overdrive"],
    desc: "When Played: Deal 3 damage to all enemies. Start of Tricks: Move to an empty lane. While Active: Add 1 to your Block Meter when Omni-Man destroys an enemy." },
  { name: "Silver Surfer", cost: 7, attack: 7, health: 7, type: "hero",
    abilities: [],
    desc: "When Played: Remove 3 ATK from an enemy. While Active: Enemy cards cost 1 more Energy. (Tricks unaffected.)" },
  { name: "Mace Windu", cost: 7, attack: 4, health: 5, type: "hero",
    abilities: [],
    desc: "When Played: Remove (−1/−1) from every card in the opponent's hand, permanently. While Active: Add (+0/+2) when an ally is destroyed. Add (+2/+0) when any enemy is destroyed." },
  { name: "Godzilla", cost: 7, attack: 5, health: 8, type: "scifi",
    abilities: [],
    desc: "When Played: Apply Burning 3 to every enemy card." },
  { name: "Revan", cost: 5, attack: 4, health: 6, type: "villain",
    abilities: [],
    desc: "When Played: Give another ally with cost ≤ 9 Revive 1. It comes back as if newly played — abilities reset and its When Played fires again." },

  // ==================== COST 8 ====================
  { name: "Apocalypse", cost: 7, attack: 5, health: 6, type: "villain",
    abilities: [],
    desc: "When Played: Summon a random 1-cost card in any lane. Give each card in one hand — yours, or in 2v2 a teammate's — a random keyword: Armor 1, Evade 1, Bullseye, or Overdrive. Each Turn: Permanently remove 1 ATK from 2 random enemies." },
  { name: "Darth Vader", cost: 8, attack: 6, health: 7, type: "villain",
    abilities: ["Armor 1", "Unresistible 1"],
    desc: "When Played: Move an enemy to an empty lane. Fear 1 an enemy. Deal 7 damage to a chosen enemy, then pick one direction — the chain runs through adjacent enemies for 1 less damage each step." },
  { name: "Emperor Palpatine", cost: 8, attack: 6, health: 8, type: "villain",
    abilities: ["Unresistible"],
    desc: "When Played: Freeze 1 up to 3 enemies in a row — the chain stops at an empty lane. While Active: Frozen enemies take double damage. When Destroyed: Freeze 1 up to 3 enemies in a row again." },
  { name: "Luke Skywalker", cost: 8, attack: 5, health: 6, type: "hero",
    abilities: ["Unresistible"],
    desc: "When Played: Mind Control 1 an enemy. While Active: Add (+1/+1) to your other allies. Remove (−1/−1) from all enemies." },
  { name: "Voldemort", cost: 8, attack: 4, health: 10, type: "villain",
    abilities: ["Unresistible 1"],
    desc: "While Active: When his lane fights, cast an Unforgivable Curse on an enemy — Avada Kedavra destroys one with cost \u2264 6, Crucio deals (\u22124/\u22124) permanently, Imperio Mind Controls it. Each curse can only be cast once." },
  { name: "Thor", cost: 8, attack: 7, health: 7, type: "hero",
    abilities: ["Splash 5", "Unresistible"],
    desc: "When Played: Freeze 1 an enemy. Deal 5 damage to the enemy opposite and both adjacent enemies. Start of Tricks: Freeze 1 a random unfrozen enemy." },
  { name: "Yoda", cost: 8, attack: 4, health: 5, type: "hero",
    abilities: ["Immunity"],
    desc: "While Active: Allies and your hero take half damage, rounded up. Start of Tricks: Give an ally Master's Guidance — when they destroy the enemy in front, the leftover damage carries through and hits the enemy player — and make an ally Invincible this turn (may be the same ally)." },

  // ==================== COST 9 ====================
  { name: "Batman", cost: 9, attack: 7, health: 5, type: "hero",
    abilities: ["Evade 2", "Unresistible"],
    desc: "When Played: The opponent cannot play their highest-cost affordable card next turn. Fear 1 an enemy. Throw Batarangs." },
  { name: "Darkseid", cost: 9, attack: 6, health: 9, type: "villain",
    abilities: ["Immunity"],
    desc: "When Played: Summon a (2/1) Parademon. Destroy up to 3 contested lanes for 2 rounds, destroying both cards in each. While Active: Darkseid splits his ATK among all enemies, and never hits the opponent's HP." },
  { name: "Superman", cost: 9, attack: 8, health: 8, type: "hero",
    abilities: ["Immunity", "Unresistible"],
    desc: "When Played: Do a bonus attack. Choose 2 enemies to Freeze 1. Deal 5 damage to an enemy." },
  { name: "Thanos", cost: 9, attack: 6, health: 9, type: "villain",
    abilities: [],
    desc: "Can be played during the Trick Phase. When Played: Devour enemies in half the lanes at random (no duplicates)." },

  // ==================== COST 10 ====================
  { name: "Anakin Skywalker", cost: 10, attack: 7, health: 9, type: "hero",
    abilities: ["Immunity", "Invincible 1", "Unresistible 1", "Draw 1"],
    desc: "When Played: Deal 10 damage to an enemy. Start of Tricks (once): Can move to an empty lane and do a bonus attack. While Active: Do a bonus attack whenever an ally is destroyed." },
  { name: "Dormammu", cost: 10, attack: 3, health: 3, type: "villain",
    abilities: ["Immunity", "Invincible 1", "Unresistible 3", "Draw 1"],
    desc: "When Played: Gain foresight for 2 draw phases — peek at the top 2 cards and keep one; the other goes to the opponent. Start of Tricks (once): Drain 3 enemies, leaving each at (0/1) and adding their stats to Dormammu." },
  { name: "Dr. Manhattan", cost: 10, attack: 8, health: 10, type: "hero",
    abilities: ["Immunity", "Invincible 1", "Taunt 1", "Draw 1"],
    desc: "When Played: Heal yourself for 5. Each Turn: Add 2 Energy." },
  { name: "Galactus", cost: 10, attack: 9, health: 11, type: "villain",
    abilities: ["Immunity", "Invincible 1", "Unresistible", "Draw 1"],
    desc: "Start of Tricks (once): Devour 2 enemies. Each Turn: Devour 1 enemy with ≤ 4 ATK." },
  { name: "Knull", cost: 10, attack: 7, health: 7, type: "villain",
    abilities: ["Immunity", "Invincible 1"],
    desc: "When Played: Summon a random card (cost 2-9) in each of your empty lanes." },
  { name: "Trigon", cost: 10, attack: 9, health: 8, type: "villain",
    abilities: ["Immunity", "Invincible 1", "Unresistible 3", "Draw 1"],
    desc: "When Played: Steal the opponent's Block Meter. Start of Tricks (once): Freeze 1 all enemies. While Active: Destroy another random enemy when Trigon destroys an enemy." },
  { name: "Doomsday", cost: 12, attack: 1, health: 1, type: "villain",
    // Doomsday is NOT a titan. He prints at 12 only because he starts as a 1/1
    // that scales up while his cost scales DOWN (min 0) — the printed number is
    // a countdown, not a power level. Every "cost >= 10" rule reads baseCost,
    // which stays 12 forever, so without this flag he was silently swept into
    // the titan class: auto-Untrickable (applyAbilities stamps it at >= 10), so
    // NO trick could be played on or against him, and is10CostImmune treated him
    // as a titan so other 10-costs (Dormammu's drain) bounced off him.
    // The engine already had the whole opt-out mechanism — is10CostImmune, the
    // auto-Untrickable stamp and every targeting filter check
    // skipAutoUntrickable, and their comments cite Doomsday by name — but the
    // flag was never actually set on this def, so none of it did anything.
    // User (twice): "you still are counting doomsday as a 10 and tricks cant be
    // played on or against him … he isnt a 10 cost card!"
    skipAutoUntrickable: true,
    // Revive 1 as a real keyword so EVERY surface (board, codex, hand
    // chips, draft, gallery) badges it from the one canonical source.
    // His onDeath consumes the charge when the custom revive fires —
    // same contract as Jason/Grundy/Drax; the desc text stays because
    // his revive differs from generic Revive (full HP + permanent
    // Freeze immunity, NOT played-anew).
    abilities: ["Revive 1", "Taunt 1"],
    desc: "Add (+1/+1) each time you play a card, even before Doomsday is drawn. While in Hand: costs 1 less each time an ally is destroyed. When Destroyed: Revive once at full HP with Immunity and Untrickable." }
];



// ============================================================
// EVENT FRANCHISES (2026-09-01)
// ============================================================
// Owner: "i want the events to have titles then from there there will be 2-3
// to choose from", and "id rather have environments be events".
//
// Environments are no longer bought and aimed by a player — every one is now
// `_spawnOnly`, placed by the match itself. This is the list that says WHICH
// event places them, and it is the codex's organising spine: an event is a
// FRANCHISE, and a franchise holds two or three outcomes that share a world.
//
// DEPTH IS THE RARITY DIAL, and that is the reason this is a list of groups
// rather than a flat tag on each card. Rolling a franchise and then rolling
// inside it means a lone outcome fires every time its franchise comes up,
// while one of three fires a third as often — so the swingiest content belongs
// in the deepest group. Gargantua sits alone deliberately: it is an optional
// per-turn pull you can ignore. Anything that puts a body on the board wants
// siblings first.
//
// MEMBERS ARE NAMES, NOT DEFS. A franchise spans four different arrays —
// CARD_DEFS (the environments and their monsters), CANDY_DEFS and WONDER_DEFS
// in tricks.js, and three rows the codex synthesises because they have no def
// anywhere (MC Ballyhoo, the Shadow Man, the Apothicon Rift are events, never
// cards). Names resolve against all of them at render time, so nothing here
// has to know where a member lives.
const EVENT_FRANCHISES = [
  // AN EVENT IS THE THING THAT GETS ROLLED. The monsters are what come OUT of
  // one, not alternatives to it — owner: "jurassic park is 2 events, the
  // wetlands or enclosure, the cards spawn from there ... same with IT its 1
  // event that spawns pennywise. Mario party is 1 because MC is the event that
  // gives cards, there's not another event."
  //
  // The first draft of this list had it flat, which counted Pennywise as a
  // second IT event and made a one-outcome franchise look like a two-outcome
  // one. Depth is the rarity dial, so getting that wrong does not just misread
  // in the codex — it would have made the roll itself wrong.
  { key: 'jurassic', title: 'Jurassic Park',
    blurb: 'Two ways to lose control of the park.',
    events: [
      { name: 'Wetlands',  spawns: ['Spinosaurus'] },
      { name: 'Enclosure', spawns: ['T-Rex'] },
    ] },
  { key: 'jaws', title: 'Jaws',
    blurb: 'Something is already in the water.',
    events: [ { name: 'Open Water', spawns: ['Jaws'] } ] },
  { key: 'elmstreet', title: 'A Nightmare on Elm Street',
    blurb: 'The fire below never quite went out.',
    events: [ { name: 'Boiler Room', spawns: ['Freddy Krueger'] } ] },
  { key: 'it', title: 'IT',
    blurb: 'Everything down here floats.',
    events: [ { name: 'Sewers', spawns: ['Pennywise'] } ] },
  { key: 'saw', title: 'Saw',
    blurb: 'He does not kill anyone. He gives them a choice.',
    events: [ { name: 'Jigsaw', spawns: ['The Bathroom', 'Game Over'] } ] },
  { key: 'interstellar', title: 'Interstellar',
    blurb: 'A tide you can pay to hold back, for as long as you can afford it.',
    events: [ { name: 'Gargantua', spawns: [] } ] },
  { key: 'marioparty', title: 'Mario Party',
    blurb: 'Everybody gets a candy. Nobody gets the same one.',
    events: [ { name: 'MC Ballyhoo', spawns: ['@candies'] } ] },
  { key: 'zombies', title: 'Call of Duty: Zombies',
    blurb: 'Four challenges, named up front, paid out later.',
    events: [ { name: 'Shadow Man', spawns: ['Apothicon Rift', '@wonders'] } ] },
];
if (typeof window !== 'undefined') window.EVENT_FRANCHISES = EVENT_FRANCHISES;
