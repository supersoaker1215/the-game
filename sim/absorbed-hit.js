// ============================================================
// A SHIELD STOPS THE DAMAGE, NOT THE SWING.
//
//   jsc sim/absorbed-hit.js
//
// Owner: "obi wan had nth metal and he didnt reflect the damage back at the
// attackers, he should reflect."
//
// Nth Metal makes an ally Invincible. Invincible is checked BEFORE the damage
// is applied and the damage call returns right there — so onDamaged never
// fires, and Obi-Wan's whole ability is "reflect damage you took". Shielding
// the reflecting wall switched the wall off, which is the exact opposite of
// what shielding it is for.
//
// onAbsorbedHit is a SEPARATE hook rather than a zero-damage onDamaged,
// because six other cards read onDamaged — Bane, Gizmo, Wolverine, Red Hulk,
// Hulk, Harley — and several would start firing on hits that dealt nothing.
// Red Hulk in particular falls back to `attacker.attack` when the amount is 0,
// so a zero-damage call would have him retaliating against absorbed swings.
// This changes exactly one card.
//
// EVADE IS DELIBERATELY EXCLUDED. Invincible and Damage Immunity mean the
// attack LANDED and was absorbed; Evade means it MISSED. There is nothing to
// reflect off a miss, and AH-3 pins that so a later tidy-up cannot fold the
// three "absorb" outcomes into one.
//
// There are TWO damage paths and they are separate callers, not copies:
// applyCombatDamage (a combat swing) and _absorbsDamage (ability/trick damage).
// AH-1 and AH-2 cover one each.
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

function board() {
  Game.init();
  for (var i = 0; i < Game.LANE_COUNT; i++) {
    Game.state.lanes[i].player = null;
    Game.state.lanes[i].ai = null;
    Game.state.lanes[i].destroyed = false;
  }
  Game.state.log = [];
}
function mk(name, owner) {
  var def = null;
  for (var i = 0; i < CARD_DEFS.length; i++) if (CARD_DEFS[i].name === name) { def = CARD_DEFS[i]; break; }
  if (!def) throw new Error('no CARD_DEF named ' + name);
  var c = Game.createCardInstance(def, owner);
  Game.applyAbilities(c);
  return c;
}
// Obi-Wan in lane 1, an attacker in lane 4 — a DIFFERENT lane, which is the
// condition his reflect is written for ("the enemy opposite is exempt").
function setup(shield) {
  board();
  var obi = mk('Obi-Wan', 'player');
  Game.state.lanes[0].player = obi;
  var atk = mk('Hulk', 'ai');
  atk.attack = 5; atk.currentHealth = 9; atk.maxHealth = 9;
  Game.state.lanes[3].ai = atk;
  if (shield) obi.invincibleTurns = 1;      // Nth Metal
  return { obi: obi, atk: atk };
}
function reflected() {
  return (Game.state.log || []).some(function (l) { return /REFLECT/.test(l); });
}

// ============================================================
// AH-1 — ability / trick damage (dealDamage -> _absorbsDamage).
// ============================================================
t('AH-1 a shielded Obi-Wan still reflects ability damage', function () {
  // The attacker's own Armor eats part of the reflect, so assert that it TOOK
  // damage and that both paths agree, rather than a hand-computed number.
  var a = setup(false);
  Game.dealDamage(a.obi, 5, a.atk);
  var unshielded = a.atk.currentHealth;
  eq('unshielded: he took it',    a.obi.currentHealth, 3);
  eq('unshielded: and reflected', unshielded < 9, true);

  var b = setup(true);
  Game.dealDamage(b.obi, 5, b.atk);
  eq('shielded: he took nothing', b.obi.currentHealth, 8);
  eq('shielded: and STILL reflected', b.atk.currentHealth < 9, true);
  eq('the same reflect either way', b.atk.currentHealth, unshielded);
  eq('the log says so', reflected(), true);
});

// ============================================================
// AH-2 — a combat swing (applyCombatDamage), the separate caller.
// ============================================================
t('AH-2 a shielded Obi-Wan still reflects a combat swing', function () {
  var s = setup(true);
  Game.applyCombatDamage(s.atk, s.obi);
  eq('he took nothing', s.obi.currentHealth, 8);
  eq('the attacker took it back', s.atk.currentHealth < 9, true);
});

// ============================================================
// AH-3 — an EVADED attack missed. Nothing to reflect.
// ============================================================
t('AH-3 an evaded attack is a miss and reflects nothing', function () {
  var s = setup(false);
  s.obi.evadeCharges = 1;
  Game.dealDamage(s.obi, 5, s.atk);
  eq('he dodged',              s.obi.currentHealth, 8);
  eq('the attacker is untouched', s.atk.currentHealth, 9);
  eq('nothing reflected',      reflected(), false);
});

// ============================================================
// AH-4 — the enemy directly opposite is exempt, shielded or not.
// ============================================================
t('AH-4 the enemy opposite is still exempt', function () {
  board();
  var obi = mk('Obi-Wan', 'player');
  Game.state.lanes[2].player = obi;
  obi.invincibleTurns = 1;
  var atk = mk('Hulk', 'ai');
  atk.attack = 5; atk.currentHealth = 9; atk.maxHealth = 9;
  Game.state.lanes[2].ai = atk;                 // same lane = directly opposite
  Game.dealDamage(obi, 5, atk);
  eq('untouched', atk.currentHealth, 9);
  eq('nothing reflected', reflected(), false);
});

// ============================================================
// AH-5 — and NO other card started answering absorbed hits.
// ============================================================
t('AH-5 only Obi-Wan answers an absorbed hit', function () {
  var answering = [];
  for (var i = 0; i < CARD_DEFS.length; i++) {
    var c;
    try { c = Game.createCardInstance(CARD_DEFS[i], 'player'); Game.applyAbilities(c); } catch (e) { continue; }
    if (c.onAbsorbedHit) answering.push(CARD_DEFS[i].name);
  }
  eq('exactly one card', answering.join(','), 'Obi-Wan');
  // Moder strips every hook a card can carry; a new one has to be on her list
  // or "strips ALL abilities" quietly means "strips all but this".
  eq('Moder strips it too', /'onAbsorbedHit'/.test(readFile('./abilities.js')), true);
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
print('absorbed-hit: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
