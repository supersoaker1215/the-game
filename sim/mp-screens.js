// ============================================================
// MULTIPLAYER — SET UP + LOBBY, to the owner's spec sheet.
//
//   jsc sim/mp-screens.js
//
// The spec has two rules that are easy to break by accident later, because
// breaking them looks like a reasonable local choice:
//
//   1. RED IS THE OPPONENT'S. Never a rarity, never a player pick, and never
//      "empty" — an open seat painted red says a person is sitting in it.
//   2. GLOW IS DROP-SHADOW WITH A 1px WHITE CORE. box-shadow traces the
//      bounding box, which on a chamfered panel paints a lit square corner
//      where the panel has none; and without the white core a tube reads as a
//      coloured border rather than as something lit.
//
// Plus the structural fixes: one random-events row (there were two), three
// modes rather than two crossed axes, and Active Deck belonging to the one
// mode that has decks instead of sitting at screen level.
// ============================================================

var CSS = read('style.css');
var BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
var UI  = read('ui.js');

var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

// Anchor the selector to the START of a rule. Without the boundary,
// `.mpl-code-tile` also matched `.mpl-code-tiles.is-closed .mpl-code-tile`,
// so the test read the room-full variant and reported the lit tile as unlit.
function ruleBody(sel) {
  var re = new RegExp('(^|[};])\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^{}]*)\\}', 'gm');
  var m, last = null;
  while ((m = re.exec(BARE))) last = m[2];
  return last;
}

// ---- 1. red stays the opponent's -------------------------------------------
var openSeat = ruleBody('.mpl-seat.is-open .mpl-seat-name');
check('an open seat is neutral, not red',
      !!openSeat && /#5c6f7c|--mp-text-off/i.test(openSeat) && !/--own-opponent|#ff2f45/i.test(openSeat),
      openSeat ? 'reads: ' + openSeat.replace(/\s+/g, ' ').trim().slice(0, 70) : 'rule missing');
var oppSeat = ruleBody('.mpl-seat.is-opp');
check('the opponent seat IS red', !!oppSeat && /--own-opponent/.test(oppSeat));
// and red must not appear in the neon picker at all
check('red is not offered as a player pick',
      !/\.mps-chip-red\b/.test(BARE) && !/mps-chip-[a-z]+\s*\{\s*color:\s*rgb\(var\(--own-opponent\)\)/.test(BARE));

// ---- 2. the glow contract ---------------------------------------------------
var LIT = ['.mps-mode.is-on', '.mps-create', '.mpl-code-tile', '.mpl-seat.is-you',
           '.mpl-seat.is-opp', '.mpl-start.is-ready', '.mps-chip.is-on'];
LIT.forEach(function (sel) {
  var b = ruleBody(sel);
  if (!b) { fails.push('lit element has no rule: ' + sel); return; }
  check(sel + ' glows with drop-shadow, not box-shadow',
        /filter:\s*drop-shadow/.test(b) && !/box-shadow/.test(b),
        b.replace(/\s+/g, ' ').trim().slice(0, 70));
  check(sel + ' keeps the 1px white core',
        /drop-shadow\(0 0 1px rgba\(255,\s*255,\s*255/.test(b),
        'no white core — the tube will read as a coloured border');
});

// ---- 3. structure -----------------------------------------------------------
check('three modes, declared once',
      /_MP_MODES:\s*\[/.test(UI) &&
      /id:\s*'2v2'/.test(UI) && /id:\s*'1v1'/.test(UI) && /id:\s*'1v1deck'/.test(UI));
check('the random-events row exists exactly once on the set-up screen',
      (UI.match(/class="mps-ev\$\{/g) || []).length === 1,
      'found ' + (UI.match(/class="mps-ev\$\{/g) || []).length + ' — it used to be printed twice');
check('the old duplicated toggle is gone from the multiplayer screen',
      !/_mmEventToggle\('twoVTwo'[^)]*\)\s*\}\s*<\/div>\s*<div class="mp-rule"/.test(UI));
check('Active Deck is nested in the custom-decks mode, not screen level',
      /mps-deck/.test(UI) && !/class="mp-foot"/.test(UI),
      'a screen-level deck footer still exists');
check('Create Room routes by mode (one button, three destinations)',
      /_mpCreateFromSetup\(\)\s*\{[\s\S]{0,400}goTo2v2OnlineLobby[\s\S]{0,200}_mpCreateRoom/.test(UI));

// ---- 4. the code closes when the room fills ---------------------------------
var closed = ruleBody('.mpl-code-tiles.is-closed .mpl-code-tile');
check('a full room stops the code glowing',
      !!closed && /filter:\s*none/.test(closed),
      closed ? closed.replace(/\s+/g, ' ').trim().slice(0, 70) : 'rule missing');

// ---- 5. no dead controls ----------------------------------------------------
check('+ ADD AI only renders when a handler exists',
      /opts\.addAi\s*\?\s*`<button[^`]*mpl-addai/.test(UI),
      'the button is rendered unconditionally — nothing in the engine fills an online seat');

print('mp-screens: ' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) { print('Failures:'); fails.forEach(function (f) { print('  - ' + f); }); }
