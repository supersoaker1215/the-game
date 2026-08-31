// ============================================================
// THE BOT'S TARGET PICKS.
//
//   jsc sim/ai-targeting.js
//
// Owner, after losing a 2v2 on two of them in the same combat:
//   "he played gojo in 1 which is good but he moved doomsday 5 and didn't have
//    his attack reduced to 0 … he gets soul stone kills my omni man for the
//    hulk, doomsday with 15 attack is uncontested and hits us for the win.
//    literally the worst possible plays"
//
// Both were target-selection, not evaluation weights:
//
//   SOUL STONE  destroys one ally and one enemy. The AI branch was
//               `doSoulStone(allies[0])` — the first ELIGIBLE ally in lane
//               order, with no evaluation of any kind. It happened to be the
//               only body standing in front of a 15-ATK Doomsday, so the trick
//               killed a Hulk and opened the lane that lost the match.
//               (Gojo, standing earlier, was skipped only because his Immunity
//               fails canTrickLand — which is exactly how arbitrary "[0]" is.)
//
//   GOJO        moves an enemy, then strips the ATK off the enemies in his own
//               lane and the two beside it. The destination list was sorted to
//               put those cone lanes first ONLY when the owner was a bot; for
//               everyone else it went out unsorted. Every path that resolves a
//               prompt WITHOUT a person — the 30s timeout, the stall watchdog,
//               the force-recovery — takes lanes[0], so those all moved the
//               enemy somewhere the strip could not reach and the card did
//               nothing. Ordering the list takes no choice away from a human.
// ============================================================

var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');

var __cases = [], __passed = 0, __failed = 0, __failures = [];
function t(name, fn) { __cases.push({ name: name, fn: fn }); }
var __caseFailed = false, __caseMsgs = [];
function eq(label, actual, expected) {
  if (actual !== expected) {
    __caseFailed = true;
    __caseMsgs.push(label + ': expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
  }
}

function clearBoard() {
  Game.init();
  for (var i = 0; i < Game.LANE_COUNT; i++) {
    Game.state.lanes[i].player = null;
    Game.state.lanes[i].ai = null;
    Game.state.lanes[i].destroyed = false;
  }
}
function mk(name, owner) {
  var def = null;
  for (var i = 0; i < CARD_DEFS.length; i++) if (CARD_DEFS[i].name === name) { def = CARD_DEFS[i]; break; }
  if (!def) throw new Error('no CARD_DEF named ' + name);
  var c = Game.createCardInstance(def, owner);
  Game.applyAbilities(c);
  return c;
}
function trick(name) {
  for (var i = 0; i < TRICK_DEFS.length; i++) if (TRICK_DEFS[i].name === name) return TRICK_DEFS[i];
  throw new Error('no TRICK_DEF named ' + name);
}

// ============================================================
// AT-1 — THE REPORTED LOSS. The wall is first in lane order; a worthless
//        body sits further along blocking nothing. The bot must give up
//        the worthless one.
// ============================================================
t('AT-1 Soul Stone does not sacrifice the body holding back a lethal swing', function () {
  clearBoard();
  Game.state.player.isHuman = false;                 // the bot owns this side
  var wall  = mk('Omni-Man', 'player');
  var spare = mk('Gizmo', 'player');
  Game.state.lanes[0].player = wall;                 // lane 1, facing the threat
  Game.state.lanes[3].player = spare;                // lane 4, facing nothing
  var doom = mk('Doomsday', 'ai');
  doom.attack = 15; doom.currentHealth = 15; doom.maxHealth = 15;
  Game.state.lanes[0].ai = doom;
  Game.state.lanes[2].ai = mk('Hulk', 'ai');

  trick('Soul Stone').play(Game, 'player');
  Game.cleanupDead();

  eq('the wall is still standing', !!Game.state.lanes[0].player, true);
  eq('the spare body was given up', !!Game.state.lanes[3].player, false);
  eq('the threat is still contested', !!Game.state.lanes[0].player && !!Game.state.lanes[0].ai, true);
});

// ============================================================
// AT-2 — and it still does its job: one ally and one enemy die.
// ============================================================
t('AT-2 Soul Stone still trades a body for an enemy', function () {
  clearBoard();
  Game.state.player.isHuman = false;
  Game.state.lanes[1].player = mk('Gizmo', 'player');
  Game.state.lanes[4].ai = mk('Hulk', 'ai');
  var alliesBefore  = Game.getAllCardsOf('player').length;
  var enemiesBefore = Game.getAllCardsOf('ai').length;
  trick('Soul Stone').play(Game, 'player');
  Game.cleanupDead();
  eq('one ally died',  Game.getAllCardsOf('player').length, alliesBefore - 1);
  eq('one enemy died', Game.getAllCardsOf('ai').length,     enemiesBefore - 1);
});

// ============================================================
// AT-3 — Gojo must OFFER his cone lanes first, for both owners.
//
// Asserting the ordering, not the outcome. sim/shim.js resolves a lane prompt
// with `lanes[Math.floor(Math.random() * lanes.length)]` — a random pick — so a
// test that checks where the enemy ended up is a coin flip, and it passed for
// me once by luck before failing on the next run. What the product actually
// guarantees is the ORDER of the list: cone lanes first, so every picker that
// takes lanes[0] — the 30s timeout, the stall watchdog, the force-recovery —
// lands somewhere the strip can reach.
// ============================================================
t('AT-3 Gojo offers a cone lane first, whoever owns him', function () {
  [false, true].forEach(function (human) {
    clearBoard();
    Game.state.player.isHuman = human;
    // GOJO IN THE MIDDLE, deliberately. With him in lane 1 the cone is lanes
    // 0-1, which an ascending list already starts with — so the sort is a no-op
    // and the test passes even unfixed. Put him at index 3 and the cone (2,3,4)
    // is NOT where the list naturally begins, so the ordering is what is
    // actually under test.
    var gojo = mk('Gojo', 'player');
    Game.state.lanes[3].player = gojo;               // cone = lane indices 2, 3, 4
    var big = mk('Doomsday', 'ai');
    big.attack = 15;
    Game.state.lanes[0].ai = big;                    // parked at the far end

    var offered = null;
    var realLane = Game.promptLaneChoice;
    Game.promptLaneChoice = function (owner, lanes, title, desc, cb) {
      if (offered === null) offered = lanes.slice();
      return realLane.apply(Game, arguments);
    };
    try { CARD_ABILITIES['Gojo'].onPlay(Game, gojo, 3); }
    finally { Game.promptLaneChoice = realLane; }

    eq('owner human=' + human + ': a destination list was offered', !!(offered && offered.length), true);
    if (offered && offered.length) {
      eq('owner human=' + human + ': the first offer is inside the cone',
         offered[0] >= 2 && offered[0] <= 4, true);
      // and nothing was taken away — the far lanes are still on the list
      eq('owner human=' + human + ': far lanes are still offered too',
         offered.indexOf(5) >= 0, true);
    }
  });
});

// ============================================================
// AT-4 / AT-5 — PLAY ORDER.
//
// Owner: "the ai always plays xenomorph last — if that card is going to be
// played it always is played 1st."
//
// Xenomorph is "+1/+1 each time any other card enters the board", and he costs
// 2. The AI plays most-expensive-first, so he was always LAST and grew by
// nothing — a 0/1 walking into combat. The same is true of every While-Active
// that answers an ENTRY (Juggernaut's adjacent Immunity, Poison Ivy's charm,
// Luke's and Dr. Strange's auras): they only ever reach the bodies that land
// after them. The rule reads the card's own onAnyCardPlayed hook rather than a
// list of names, so a new card of that shape is covered on the day it is added.
//
// AT-5 is the guard rail. Most-expensive-first is worth +6.3pp head to head
// because cheapest-first strands the AI's best body on a third of turns, so the
// jump has to be conditional: a reactive card goes first only when paying for
// it still leaves enough for the dearest card behind it.
// ============================================================
function playOrder(energy, names) {
  Game.init();
  for (var i = 0; i < Game.LANE_COUNT; i++) { Game.state.lanes[i].player = null; Game.state.lanes[i].ai = null; }
  Game.state.phase = 'ai-cards';
  Game.state.ai.currency = energy;
  Game.state.ai.hand = names.map(function (n) { return mk(n, 'ai'); });
  var order = [];
  var real = Game.playCard;
  Game.playCard = function (o, c, l) { order.push(c.name); return real.call(Game, o, c, l); };
  try { AI.playCards('ai'); } catch (e) {}
  Game.playCard = real;
  return order;
}

t('AT-4 a card that grows from later plays is played before them', function () {
  var order = playOrder(12, ['Xenomorph', 'Hulk', 'Gizmo']);
  eq('it played several cards', order.length >= 2, true);
  eq('Xenomorph led', order[0], 'Xenomorph');
  // And he actually grew from the ones that followed.
  var x = null;
  Game.getAllCardsOf('ai').forEach(function (c) { if (c.name === 'Xenomorph') x = c; });
  eq('he is on the board', !!x, true);
  if (x) eq('and he is bigger than his printed 0/1', x.attack > 0, true);
});

t('AT-5 but not when going first would strand the best body', function () {
  // Hulk costs 7 and the budget is 7: leading with the 2-drop leaves 5 and the
  // big body never lands. The desc rule has to win here.
  var order = playOrder(7, ['Xenomorph', 'Hulk']);
  eq('the big body was played', order.indexOf('Hulk') >= 0, true);
  eq('and it was not sacrificed to the 2-drop', order[0], 'Hulk');
});

// ============================================================
// AT-6 / AT-7 — WHICH ENEMY IS ACTUALLY GOING TO HURT US.
//
// Every "weaken or neutralise an enemy" picker sorted by raw ATK. A FEARED card
// attacks ITSELF (resolveLaneCombat: `if (pCard.isFeared) pTarget = pCard`), so
// its attack is not a threat, it is a gift — and taking 3 off it is the
// difference between it dying on its own swing and surviving. The bot spent
// Kryptonite on a feared Droideka and left an uncontested Revan to hit the
// health bar. (Owner: "the ai played kryptonite on the droideka that was feared
// so now he doesnt kill himself, instead of on the enemy revan to reduce damage
// to our healthbar.")
// ============================================================
t('AT-6 threat is not raw ATK: feared scores below zero, uncontested doubles', function () {
  clearBoard();
  var feared = mk('Droideka', 'ai');
  feared.attack = 5; feared.isFeared = true; feared.fearedTurns = 1;
  Game.state.lanes[3].ai = feared;
  Game.state.lanes[3].player = mk('Gizmo', 'player');      // contested
  var open = mk('Revan', 'ai'); open.attack = 4;
  Game.state.lanes[4].ai = open;                            // nothing opposite

  eq('a feared enemy is worth LESS than nothing', Game.threatOf(feared, 'player') < 0, true);
  eq('an uncontested swing counts double',        Game.threatOf(open, 'player'), 8);
  eq('so the bigger number is not the pick',      Game.pickBiggestThreat([feared, open], 'player').name, 'Revan');

  // Frozen and stunned do not swing either.
  var frozen = mk('Hulk', 'ai'); frozen.attack = 9; frozen.isFrozen = true;
  Game.state.lanes[1].ai = frozen;
  eq('a frozen 9-ATK is worth nothing', Game.threatOf(frozen, 'player'), 0);
});

t('AT-7 Kryptonite lands on the card that will actually hit us', function () {
  clearBoard();
  var feared = mk('Droideka', 'ai');
  feared.attack = 5; feared.isFeared = true; feared.fearedTurns = 1;
  Game.state.lanes[3].ai = feared;
  Game.state.lanes[3].player = mk('Gizmo', 'player');
  var open = mk('Revan', 'ai'); open.attack = 4;
  Game.state.lanes[4].ai = open;

  trick('Kryptonite').play(Game, 'player');
  eq('the feared one keeps its attack (it is killing itself)', feared.attack, 5);
  eq('the real threat was weakened', open.attack, 1);

  // And with nothing odd on the board it still takes the biggest hitter.
  clearBoard();
  var big = mk('Hulk', 'ai');  big.attack = 7;  Game.state.lanes[1].ai = big;
  var small = mk('Gizmo', 'ai'); small.attack = 1; Game.state.lanes[2].ai = small;
  trick('Kryptonite').play(Game, 'player');
  eq('plain board: the biggest hitter', big.attack, 4);
  eq('and the small one is untouched',  small.attack, 1);
});

// ============================================================
// AT-8 / AT-9 — OPTIMUS SPENDS THE FREE SWING WHERE IT CHANGES SOMETHING.
//
// Both of his picks were `[0]`: the first adjacent ally, and the enemy OPPOSITE
// him if alive. On the reported board that sent Green Goblin into a 3/1 The
// Thing — which Optimus himself, at 4 ATK, was going to kill in the very next
// combat anyway — while a 3/6 Solomon Grundy stood untouched beside them.
// (Owner: "he had GG attack the thing … he should have had GG attack solomon
// grundy so they can trade. optimus was already going to win the trade vs the
// thing.")
// ============================================================
function optimusBoard() {
  clearBoard();
  Game.state.ai.isHuman = false;
  var gg     = mk('Green Goblin', 'ai');     gg.attack = 3; gg.currentHealth = 3;
  var thing  = mk('The Thing', 'player');    thing.attack = 3; thing.currentHealth = 1;
  var grundy = mk('Solomon Grundy', 'player'); grundy.attack = 3; grundy.currentHealth = 6; grundy.maxHealth = 6;
  var opt    = mk('Optimus Prime', 'ai');    opt.attack = 4; opt.currentHealth = 4;
  Game.state.lanes[3].ai = gg;
  Game.state.lanes[4].player = thing;        // opposite Optimus, already doomed to him
  Game.state.lanes[3].player = grundy;       // opposite Green Goblin, survives
  Game.state.lanes[4].ai = opt;
  return { gg: gg, thing: thing, grundy: grundy, opt: opt };
}

t('AT-8 a target our own body is already killing is worth almost nothing', function () {
  var b = optimusBoard();
  var AB = CARD_ABILITIES['Optimus Prime'];
  var doomed = AB._targetScore(Game, b.opt, b.gg, b.thing);
  var live   = AB._targetScore(Game, b.opt, b.gg, b.grundy);
  eq('the doomed one scores low', doomed < 50, true);
  eq('the live one scores higher', live > doomed, true);
});

t('AT-9 so Optimus sends the swing at the card that survives otherwise', function () {
  var b = optimusBoard();
  CARD_ABILITIES['Optimus Prime'].onPlay(Game, b.opt, 4);
  eq('The Thing is left for Optimus', b.thing.currentHealth, 1);
  eq('Grundy took the free swing',    b.grundy.currentHealth, 3);

  // And a free swing that lands a kill nothing else was getting still wins.
  clearBoard();
  Game.state.ai.isHuman = false;
  var ally  = mk('Green Goblin', 'ai');  ally.attack = 3; ally.currentHealth = 3;
  var opt2  = mk('Optimus Prime', 'ai'); opt2.attack = 1; opt2.currentHealth = 4;
  // Sabertooth, not The Thing — The Thing carries Armor 2, and a target whose
  // armour eats the swing is a different test than the one intended here.
  var frail = mk('Sabertooth', 'player'); frail.attack = 1; frail.currentHealth = 2;  // 1 ATK Optimus cannot finish it
  var fat   = mk('Solomon Grundy', 'player'); fat.attack = 1; fat.currentHealth = 9; fat.maxHealth = 9;
  Game.state.lanes[3].ai = ally;
  Game.state.lanes[4].ai = opt2;
  Game.state.lanes[4].player = frail;
  Game.state.lanes[3].player = fat;
  CARD_ABILITIES['Optimus Prime'].onPlay(Game, opt2, 4);
  eq('it took the kill it could actually land', frail.currentHealth <= 0, true);
  eq('and left the one it could not dent',      fat.currentHealth, 9);
});

// ============================================================
// AT-10 / AT-11 — LETHAL OUTRANKS EVERYTHING.
//
// Mind Stone's AI picker was `cards[0]` — the first enemy in BOARD ORDER, no
// evaluation at all. On the reported board that was Optimus Prime in lane 7,
// while a Michael Myers stood uncontested in lane 8 with lethal on the team.
// Controlling him is the whole point of the card: the swing never lands.
// (Owner: "michael myers is in lane 8 going to win the game, my ai teammate
// mind controls optimus prime, losing us the game — if he mind controls michael
// myers, negating damage to us, we are alive. that should take ultimate
// priority.")
// ============================================================
t('AT-10 an uncontested swing that would finish us outranks everything', function () {
  clearBoard();
  Game.state.player.health = 10;
  var contested = mk('Optimus Prime', 'ai'); contested.attack = 4;
  Game.state.lanes[2].ai = contested;
  Game.state.lanes[2].player = mk('Gizmo', 'player');       // a body absorbs it
  var lethal = mk('Michael Myers', 'ai'); lethal.attack = 10;
  Game.state.lanes[4].ai = lethal;                           // nothing opposite

  eq('our health is read from the side', Game.sideHealth('player'), 10);
  eq('the lethal one dwarfs the rest', Game.threatOf(lethal, 'player') > 1000, true);
  // Ordinary MEANS "nowhere near lethal", not a specific number. It used to be
  // flat attack; a contested swing is now also worth the body it kills, and
  // this Optimus does kill the Gizmo in front of him (see AT-20). What the case
  // is about is the gap to lethal, so that is what it asserts.
  eq('the contested one is ordinary',  Game.threatOf(contested, 'player') < 100, true);
  eq('but not free either — it kills the body blocking it',
     Game.threatOf(contested, 'player') > (contested.attack || 0), true);
  eq('so it is the pick', Game.pickBiggestThreat([contested, lethal], 'player').name, 'Michael Myers');

  // At healthy HP the same board ranks normally — no lethal bonus.
  Game.state.player.health = 30;
  eq('not lethal any more', Game.threatOf(lethal, 'player') < 1000, true);
  eq('but still the bigger threat', Game.threatOf(lethal, 'player') > Game.threatOf(contested, 'player'), true);
});

t('AT-11 Mind Stone controls the card that is about to win the game', function () {
  clearBoard();
  Game.state.player.health = 10;
  var optimus = mk('Optimus Prime', 'ai'); optimus.attack = 4;
  Game.state.lanes[2].ai = optimus;                          // EARLIER in board order
  Game.state.lanes[2].player = mk('Gizmo', 'player');
  var myers = mk('Michael Myers', 'ai'); myers.attack = 10;
  Game.state.lanes[4].ai = myers;

  trick('Mind Stone').play(Game, 'player');
  eq('the lethal attacker is controlled', !!myers.isMindControlled, true);
  eq('and not the first card in board order', !!optimus.isMindControlled, false);
});

// ============================================================
// AT-12 / AT-13 — ANTI-VENOM: FREEING A BLOCKED BODY IS FACE DAMAGE.
//
// Two mispricings, and they compounded. The ALLY branch scored raw power, so
// two equal bodies tied and the pick fell to board order — it could not see
// that one of them was being WASTED in a contested lane while an unopposed one
// sat open. And the ENEMY branch priced any non-lethal burn at a flat 20 + the
// target's stats, which no ally play could ever beat no matter what it
// unlocked. (Owner: "he moves groot, should've moved green lantern … then moved
// him to an open lane to hit the frozen health bar. it's these types of plays
// to make the ai smarter — deny energy and face damage.")
//
// A kill is still the best outcome and AT-13 holds that line.
// ============================================================
t('AT-12 it frees the blocked hitter instead of shuffling the other body', function () {
  clearBoard();
  Game.state.player.isHuman = false;
  // Enemy side crowded so the ally choice is the live one, with two lanes open.
  for (var i = 0; i < Game.LANE_COUNT; i++) Game.state.lanes[i].ai = mk('Sabertooth', 'ai');
  Game.state.lanes[4].ai = null;
  Game.state.lanes[5].ai = null;
  var groot = mk('Groot', 'player');         groot.attack = 2; groot.currentHealth = 4;
  var gl    = mk('Green Lantern', 'player'); gl.attack = 4;    gl.currentHealth = 2;
  Game.state.lanes[0].player = groot;        // blocked, small
  Game.state.lanes[3].player = gl;           // blocked, the real hitter
  var av = mk('Anti-Venom', 'player');
  Game.state.lanes[1].player = av;

  CARD_ABILITIES['Anti-Venom'].onPlay(Game, av, 1);
  var glLane = Game.findCardLane(gl);
  eq('the 4-ATK body moved', glLane !== 3, true);
  eq('and it is unopposed now', glLane >= 0 && !Game.state.lanes[glLane].ai, true);
  eq('the small one stayed put', Game.findCardLane(groot), 0);
});

t('AT-13 but a kill still beats repositioning', function () {
  clearBoard();
  Game.state.player.isHuman = false;
  var frail = mk('Sabertooth', 'ai'); frail.attack = 3; frail.currentHealth = 1;  // a -1/-1 finishes it
  Game.state.lanes[2].ai = frail;
  var gl = mk('Green Lantern', 'player'); gl.attack = 4; gl.currentHealth = 2;
  Game.state.lanes[3].player = gl;
  Game.state.lanes[3].ai = mk('Carnage', 'ai');
  var av = mk('Anti-Venom', 'player');
  Game.state.lanes[1].player = av;

  CARD_ABILITIES['Anti-Venom'].onPlay(Game, av, 1);
  Game.cleanupDead();
  eq('the 1-HP enemy was finished', frail.currentHealth <= 0, true);
});

// ============================================================
// AT-14 — A FREE TRICK IS NOT A REASON TO WASTE IT.
//
// Every trick that needs a target carries a canPlay, and both the tray and
// playTrick refuse it when that fails. The block-meter FREE play went through
// neither: it asked only "do I have any cards on the board", so the bot burned
// The Darkhold ("destroy all enemies with <= 2 ATK") into a board with no such
// enemy and got nothing for it. (Owner: "the ai played the darkhold with no
// body with 2 attack, that shouldnt be possible.")
//
// A trick with no canPlay is unconditional and must still fire — AT-14 pins
// that too, or the guard would quietly disable half the trick pool.
// ============================================================
t('AT-14 the AI only fires a free block trick that would actually land', function () {
  clearBoard();
  Game.state.player.isHuman = false;
  Game.state.lanes[0].player = mk('Gizmo', 'player');       // we have a body
  var fat = mk('Hulk', 'ai'); fat.attack = 7;               // 7 ATK — not a Darkhold target
  Game.state.lanes[2].ai = fat;

  eq('nothing for it to destroy', Game._blockTrickWouldLand(trick('The Darkhold'), 'player'), false);

  var small = mk('Sabertooth', 'ai'); small.attack = 2;     // now a legal target
  Game.state.lanes[4].ai = small;
  eq('now it would land', Game._blockTrickWouldLand(trick('The Darkhold'), 'player'), true);

  // A trick with no canPlay at all is unconditional and still fires.
  eq('unconditional tricks are unaffected',
     Game._blockTrickWouldLand(trick('Two-Face Coin'), 'player'), true);
  // And something with no play function is never fired.
  eq('a trick with no play does not fire', Game._blockTrickWouldLand({ name: 'x' }, 'player'), false);
});

// ============================================================
// AT-15/16/17 — a card whose stats depend on WHERE it lands.
//
// Scarlet Witch is 0/0 in hand with `copiesOpposite` and adopts the ATK/HP of
// the enemy opposite whichever lane she is played into. The lane picker scored
// the literal 0/0: she could never kill, never survive and never deal face
// damage, so every contested lane came back NEGATIVE and she was pushed into an
// empty one — the single placement that throws the card away for a 3/4.
// (Owner: "the scarlet witch should go to the enemy with the most stats.")
// ============================================================
t('AT-15 the witch takes the most STATS, not the most attack', function () {
  clearBoard();
  var loud = mk('Sabertooth', 'player'); loud.attack = 6; loud.currentHealth = 2; //  8
  var fat  = mk('Droideka', 'player');   fat.attack  = 4; fat.currentHealth  = 9; // 13
  var mid  = mk('Sabertooth', 'player'); mid.attack  = 4; mid.currentHealth  = 4; //  8
  Game.state.lanes[1].player = loud;     // scariest, and the old pick
  Game.state.lanes[3].player = fat;      // the body actually worth having
  Game.state.lanes[5].player = mid;

  var witch = mk('Scarlet Witch', 'ai');
  eq('she carries no attack of her own', witch.attack || 0, 0);
  eq('and is flagged as a copier', !!witch.copiesOpposite, true);
  // The only per-lane signal used to be threatScore, and threat is essentially
  // ATK — so the 6/2 won and she came in a 6/2. Half her body was invisible.
  eq('lane chosen', AI.chooseLane(witch, 'ai'), 3);
});

t('AT-16 she will not copy something worse than her own default', function () {
  clearBoard();
  var runt = mk('Sabertooth', 'player'); runt.attack = 2; runt.currentHealth = 1;
  Game.state.lanes[2].player = runt;
  // Opposite a 2/1 she IS a 2/1. With nothing to copy she is a 3/4, so every
  // open lane is a better card than the only contested one — the blocking
  // terms alone used to send her into the runt anyway.
  var witch = mk('Scarlet Witch', 'ai');
  eq('takes the 3/4 instead', AI.chooseLane(witch, 'ai') !== 2, true);
});

t('AT-17 a face-down card cannot be copied, so it is not a target', function () {
  clearBoard();
  var hidden = mk('Droideka', 'player'); hidden.attack = 6; hidden.currentHealth = 7;
  hidden.isFaceDown = true;              // Invisible Woman's promise
  var seen = mk('Sabertooth', 'player'); seen.attack = 5; seen.currentHealth = 5;
  Game.state.lanes[0].player = hidden;
  Game.state.lanes[4].player = seen;

  var witch = mk('Scarlet Witch', 'ai');
  // The ability refuses to read a face-down card (she would land 3/4 there), so
  // the picker must not rate that lane as if it held a 6/7.
  eq('takes the enemy it can actually read', AI.chooseLane(witch, 'ai'), 4);
  // And the effective-body helper agrees with the ability, not with the object.
  var asHidden = AI._asPlacedIn(witch, 0, 'ai');
  eq('hidden lane scores as the fallback', asHidden.attack + '/' + asHidden.currentHealth, '3/4');
  var asSeen = AI._asPlacedIn(witch, 4, 'ai');
  eq('readable lane scores as the copy', asSeen.attack + '/' + asSeen.currentHealth, '5/5');
});

// ============================================================
// AT-18/19 — a bounce is worth what it UNDOES, not what it cost.
//
// Phantom Zone's picker was `cards.sort((a,b) => b.cost - a.cost)[0]`. On the
// reported board that is off by one: Emperor Palpatine at cost 8 beats Silver
// Surfer at 7, so the bot bounced the body and left the tax running. Surfer's
// passive makes every card the bouncing side plays cost 1 more, which is the
// whole reason to remove him. (Owner: "he bounced the Palpatine, which is
// terrible because the enemy had silver surfer on the field — if he bounced
// surfer we could play high cards.")
// ============================================================
t('AT-18 the bounce takes the standing tax over the bigger body', function () {
  clearBoard();
  var surfer = mk('Silver Surfer', 'player');
  var palp   = mk('Emperor Palpatine', 'player');
  eq('Surfer is the CHEAPER of the two', (surfer.baseCost || surfer.cost) < (palp.baseCost || palp.cost), true);
  eq('and he is the one carrying the tax', surfer.passive, 'enemyCostIncrease');
  Game.state.lanes[1].player = palp;
  Game.state.lanes[3].player = surfer;

  var pick = Game.pickBounceTarget([palp, surfer], 'ai');
  eq('so he is the bounce', pick && pick.name, 'Silver Surfer');
  // And the ordering is not an accident of the list order.
  eq('either way round', (Game.pickBounceTarget([surfer, palp], 'ai') || {}).name, 'Silver Surfer');
  // The picker must not reorder the caller's array — it is the live prompt list.
  var arr = [palp, surfer];
  Game.pickBounceTarget(arr, 'ai');
  eq('and the list handed in is untouched', arr[0] === palp && arr[1] === surfer, true);
});

t('AT-19 with nothing standing, the bounce falls back to tempo and buffs', function () {
  clearBoard();
  var small = mk('Sabertooth', 'player');
  var big   = mk('Emperor Palpatine', 'player');
  Game.state.lanes[0].player = small;
  Game.state.lanes[2].player = big;
  eq('the expensive body wins when neither has a passive',
     (Game.pickBounceTarget([small, big], 'ai') || {}).name, 'Emperor Palpatine');

  // A buff above base is erased by the return, so it counts toward the pick.
  // Compared against ANOTHER COPY OF ITSELF, deliberately: Palpatine is not the
  // vanilla control he looks like — he carries doubleFrozenDamage, so bouncing
  // him genuinely undoes something and the scorer is right to pay for it. Two
  // identical cards isolate the buff term and nothing else.
  var plain  = mk('Sabertooth', 'player');
  var pumped = mk('Sabertooth', 'player');
  pumped.attack = (pumped.baseAttack || pumped.attack) + 12;
  Game.state.lanes[4].player = plain;
  Game.state.lanes[5].player = pumped;
  eq('the buffed copy is the bounce', Game.pickBounceTarget([plain, pumped], 'ai') === pumped, true);
  eq('and order does not decide it', Game.pickBounceTarget([pumped, plain], 'ai') === pumped, true);
});

// ============================================================
// AT-20/21/22 — the board decides, not the nameplate.
//
// Owner, on a 2v2 his AI teammate threw away: "my teammate decided to have the
// deathstroke kill the enemy wolverine, who had an invincible battle droid in
// front so he couldn't overdrive — if my teammate kills the joker, deathstroke
// has 7 attack, my captain america survives, and we have energy reduction next
// round, which is massive." And, on the same board: "why would my teammate
// actively play windu in lane 7 when there's a hulk in lane 6 who splashes."
// ============================================================
t('AT-20 an enemy walled off by an invincible blocker is not the threat', function () {
  clearBoard();
  // Their big hitter, facing a body it can never kill.
  var walled = mk('Sabertooth', 'player'); walled.attack = 6; walled.currentHealth = 4;
  var wall   = mk('Droideka', 'ai');       wall.invincibleTurns = 2;
  Game.state.lanes[1].player = walled;
  Game.state.lanes[1].ai = wall;
  // Their small hitter, about to kill one of ours.
  var killer = mk('Sabertooth', 'player'); killer.attack = 3; killer.currentHealth = 4;
  var victim = mk('Sabertooth', 'ai');     victim.currentHealth = 3; victim.attack = 2;
  Game.state.lanes[4].player = killer;
  Game.state.lanes[4].ai = victim;

  eq('the walled-off swing buys us nothing', Game.threatOf(walled, 'ai'), 0);
  eq('the one that kills our body is worth more than its raw attack',
     Game.threatOf(killer, 'ai') > (killer.attack || 0), true);
  // So the shared picker takes the killer, not the bigger nameplate.
  eq('and it is the pick', (Game.pickBiggestThreat([walled, killer], 'ai') || {}) === killer, true);
});

t('AT-21 a swing that only chips is worth its attack, no more', function () {
  clearBoard();
  var chipper = mk('Sabertooth', 'player'); chipper.attack = 3; chipper.currentHealth = 4;
  var tough   = mk('Droideka', 'ai');       tough.currentHealth = 9; tough.armorValue = 0;
  Game.state.lanes[2].player = chipper;
  Game.state.lanes[2].ai = tough;
  eq('flat attack for a swing that kills nothing', Game.threatOf(chipper, 'ai'), 3);
  // Armour that eats the whole hit is the same as not being hit.
  tough.armorValue = 3;
  eq('armour absorbing it all reads as harmless', Game.threatOf(chipper, 'ai'), 0);
});

t('AT-22 splash from the next lane counts, through effectiveSplash', function () {
  clearBoard();
  // Hulk's splash EQUALS HIS ATTACK — the flag the raw splashRange field misses.
  var hulk = mk('Hulk', 'player');
  hulk.attack = 5; hulk.currentHealth = 6;
  hulk._splashTracksAtk = true; hulk.splashRange = 0;   // stale field, live flag
  Game.state.lanes[5].player = hulk;
  eq('the engine says 5 lands', Game.effectiveSplash(hulk), 5);
  eq('the raw field would have said 0', hulk.splashRange, 0);

  eq('the lane beside him is a 5-damage lane', AI.incomingSplash(6, 'ai'), 5);
  eq('and two lanes away is clear',            AI.incomingSplash(7, 'ai'), 0);

  // A 5 HP body does NOT survive there, even against an empty lane in front.
  var windu = mk('Mace Windu', 'ai'); windu.currentHealth = 5; windu.armorValue = 0;
  eq('so survival says no', AI.wouldSurvive(windu, null, AI.incomingSplash(6, 'ai')), false);
  eq('while the lane two over is fine', AI.wouldSurvive(windu, null, AI.incomingSplash(7, 'ai')), true);
  // A frozen splasher is not swinging, so it is not splashing either.
  hulk.isFrozen = true;
  eq('a frozen Hulk splashes nobody', AI.incomingSplash(6, 'ai'), 0);
});

// ---- run ----------------------------------------------------
__cases.forEach(function (c) {
  __caseFailed = false; __caseMsgs = [];
  try { c.fn(); } catch (e) {
    __caseFailed = true;
    __caseMsgs.push('threw: ' + (e && e.message ? e.message : String(e)));
  }
  if (__caseFailed) { __failed++; __failures.push({ name: c.name, msgs: __caseMsgs.slice() }); }
  else __passed++;
});
print('ai-targeting: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
