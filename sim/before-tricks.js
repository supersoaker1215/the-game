// ============================================================
// "START OF TRICKS" MEANS EVERY ROUND UNLESS THE CARD SAYS (ONCE).
//
//   jsc sim/before-tricks.js
//
// Owner report: "yoda ability didnt fire in 2v2".
//
// It is not a 2v2 bug — 2v2 runs the same runBeforeTricks() the 1v1
// path does. Yoda fired exactly once, in the round he landed, and
// never again, in every mode.
//
// runBeforeTricks latches `beforeTricksFired` on each card so a hook
// can't fire twice in one pass. postCombat clears that latch again —
// but ONLY for cards carrying `_recurringBT`. Yoda never had the flag,
// so the latch was permanent. His hook is written to recur (it clears
// the previous apprentice mark before re-picking) and the Invincible
// he hands out lasts "this turn", so a one-shot reading is not even
// self-consistent.
//
// Sweeping the 17 cards with the hook found four missing the flag:
//   Yoda         "Start of Tricks: ... Invincible this turn"   (reported)
//   Thor         "Start of Tricks: Freeze 1 a random unfrozen enemy."
//   Dr. Strange  aura upkeep, alongside onBeforeAttack/onAllyKilled
//   Jango Fett   the roguelite Man-Bat-style move (Man-Bat's recurs)
//
// BT-1 is the durable part: it makes the printed card text the spec.
// A card that says "(once)" must not recur; a card that says plain
// "Start of Tricks" must. Any new card gets checked for free, and the
// six deliberate one-shots are protected from being swept up.
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

function reset() {
  Game.init();
  Game.state.mode = { deck: 'classic', players: '1v1' };
  Game.state.phase = 'combat';
  Game.state.round = 2;
  Game.state.firstPlayer = 'player';
  Game.state.activePlayer = 'player';
  for (var i = 0; i < Game.LANE_COUNT; i++) {
    Game.state.lanes[i].player = null;
    Game.state.lanes[i].ai = null;
    Game.state.lanes[i].destroyed = false;
  }
  return Game;
}
function realCard(name, owner) {
  var def = null;
  for (var i = 0; i < CARD_DEFS.length; i++) if (CARD_DEFS[i].name === name) { def = CARD_DEFS[i]; break; }
  if (!def) throw new Error('no CARD_DEF named ' + name);
  var c = Game.createCardInstance(def, owner || 'player');
  Game.applyAbilities(c);
  return c;
}

// ============================================================
// BT-1 — the card text IS the spec.
// ============================================================

// Cards that use the hook without printing a "Start of Tricks" line — upkeep,
// a mode-gated upgrade, or the same idea worded differently. Listed by name
// AND expected value, so a new card with this hook fails the sweep until
// somebody decides which it is, rather than silently defaulting either way.
var NO_PRINTED_LINE = {
  'Dr. Strange': true,   // Untrickable aura upkeep, beside onBeforeAttack/onAllyKilled
  'Jango Fett':  true,   // roguelite "Jetpack Salvo" — a Man-Bat-style move
  'Poison Ivy':  true,   // "Each Turn: Charm a random ally" — re-charmed every round
  'Art the Clown': true, // "Each round choose one" weapon from the bag
  'Joker':       true,   // "While Active: Give Crazy to the highest-ATK enemy" — re-stamped
};

t('BT-1 "(once)" in the text means one-shot; plain "Start of Tricks" means every round', function () {
  reset();
  var checked = 0;
  for (var i = 0; i < CARD_DEFS.length; i++) {
    var def = CARD_DEFS[i];
    var c;
    try { c = Game.createCardInstance(def, 'player'); Game.applyAbilities(c); } catch (e) { continue; }
    if (!c.onBeforeTricks) continue;
    checked++;
    var desc = def.desc || '';
    var once  = /Start of Tricks\s*\(once\)/i.test(desc);
    var plain = !once && /Start of Tricks\s*:/i.test(desc);
    if (once)       eq(def.name + ' says (once) so must NOT recur', !!c._recurringBT, false);
    else if (plain) eq(def.name + ' says Start of Tricks so MUST recur', !!c._recurringBT, true);
    else            eq(def.name + ' has a hook but no printed line — pinned by name',
                       !!c._recurringBT, !!NO_PRINTED_LINE[def.name]);
  }
  eq('swept every card with the hook', checked >= 17, true);
});

// ============================================================
// BT-2 — the mechanism: postCombat re-arms a recurring card and only that.
// ============================================================
t('BT-2 postCombat re-arms Yoda and leaves Carnage spent', function () {
  reset();
  var yoda    = realCard('Yoda', 'player');
  var carnage = realCard('Carnage', 'player');
  Game.state.lanes[0].player = yoda;
  Game.state.lanes[1].player = carnage;
  // Both have fired this round.
  yoda.beforeTricksFired = true;
  carnage.beforeTricksFired = true;
  Game.postCombat();
  eq('Yoda re-armed',      yoda.beforeTricksFired, false);
  eq('Carnage stays spent', carnage.beforeTricksFired, true);
});

// ============================================================
// BT-3 — end to end: Yoda's gift lands in TWO consecutive rounds.
//        This is the report, reproduced.
// ============================================================
t('BT-3 Yoda teaches an apprentice two rounds running', function () {
  reset();
  var yoda  = realCard('Yoda', 'player');
  var ally  = realCard('Gizmo', 'player');
  Game.state.lanes[0].player = yoda;
  Game.state.lanes[1].player = ally;

  Game.runBeforeTricks();
  var round1 = !!ally._mastersApprentice || (ally.invincibleTurns > 0);
  eq('round 1: the gift landed', round1, true);

  // Between rounds: the marks clear and the latch is re-armed.
  delete ally._mastersApprentice;
  ally.invincibleTurns = 0;
  Game.postCombat();
  eq('round 2: Yoda is re-armed', yoda.beforeTricksFired, false);

  Game.runBeforeTricks();
  var round2 = !!ally._mastersApprentice || (ally.invincibleTurns > 0);
  eq('round 2: the gift landed again', round2, true);
});

// ============================================================
// BT-4 — the guard rail: a genuine one-shot still fires only once.
// ============================================================
t('BT-4 Carnage still heals exactly once across two rounds', function () {
  reset();
  var carnage = realCard('Carnage', 'player');
  Game.state.lanes[0].player = carnage;
  Game.state.lanes[2].ai = realCard('Gizmo', 'ai');

  Game.runBeforeTricks();
  eq('round 1: healed', !!carnage.carnageHealed, true);
  eq('round 1: latched', carnage.beforeTricksFired, true);

  Game.postCombat();
  eq('round 2: still latched (not recurring)', carnage.beforeTricksFired, true);
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
print('before-tricks: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
