// ============================================================
// MULTIPLAYER — SET UP + LOBBY.
//
//   jsc sim/mp-screens.js
//
// Two style rules that are easy to break by accident, because breaking them
// looks like a reasonable local choice (checked as stylesheet text — the shim
// has no cascade):
//
//   1. RED IS THE OPPONENT'S. Never a rarity, never a player pick, and never
//      "empty" — an open seat painted red says a person is sitting in it.
//   2. GLOW IS DROP-SHADOW WITH A 1px WHITE CORE. box-shadow traces the
//      bounding box, which on a chamfered panel paints a lit square corner
//      where the panel has none; without the white core a tube reads as a
//      coloured border rather than as something lit.
//
// And the structure, checked by rendering the real screens
// (UI._mpSubmenuHTML) and pressing Create Room: three modes, one
// random-events row, Active Deck only inside the one mode that has decks, one
// Create button routed by mode, and no dead + ADD AI button.
// ============================================================

var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var CSSTEXT = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join(''));
var BARE = CSSTEXT.replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });

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
           '.mpl-seat.is-opp', '.mps-chip.is-on'];
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

// ---- 3. structure, as rendered ---------------------------------------------
function screen(state, mode) {
  UI._mpState = state;
  UI._mpLobby = {};
  if (mode) UI._mpSetupMode = mode;
  var h = document.createElement('div');
  h.innerHTML = UI._mpSubmenuHTML();
  return h;
}
var IDLE = function () { return { tab: 'create', code: null, status: 'idle', you: null, opponent: null }; };
var setup = screen(IDLE(), '2v2');
check('three modes, in order',
      setup.querySelectorAll('.mps-mode').map(function (e) { return e.id; }).join() === 'mps-mode-2v2,mps-mode-1v1,mps-mode-1v1deck',
      setup.querySelectorAll('.mps-mode').map(function (e) { return e.id; }).join());
check('…exactly one of them chosen', setup.querySelectorAll('.mps-mode.is-on').length === 1 &&
      setup.querySelector('#mps-mode-2v2').getAttribute('aria-checked') === 'true');
check('the random-events row exists exactly once on the set-up screen',
      setup.querySelectorAll('.mps-ev').length === 1, setup.querySelectorAll('.mps-ev').length);
check('no second events toggle hides anywhere else on the screen',
      setup.querySelectorAll('input[type="checkbox"]').length === 1, setup.querySelectorAll('input[type="checkbox"]').length);
check('Active Deck is not shown for a draft mode', setup.querySelectorAll('.mps-deck').length === 0);
check('there is no screen-level deck footer', setup.querySelectorAll('.mp-foot').length === 0);
var deckMode = screen(IDLE(), '1v1deck');
var modesEl = deckMode.querySelector('.mps-modes');
var kids = modesEl ? modesEl.children : [];
var deckAt = kids.map(function (k) { return k.classList.contains('mps-deck'); }).indexOf(true);
check('Active Deck appears for Custom Decks', deckAt >= 0);
check('…nested directly under that mode, inside the mode list',
      deckAt > 0 && kids[deckAt - 1].id === 'mps-mode-1v1deck', kids.map(function (k) { return k.id || k.className; }).join(' | '));
check('…and only once', deckMode.querySelectorAll('.mps-deck').length === 1);

// One Create button, three destinations.
(function () {
  var calls = [];
  var keep = { lobby: Game.goTo2v2OnlineLobby, create: (typeof twov2OnlineCreate !== 'undefined') ? twov2OnlineCreate : undefined, room: UI._mpCreateRoom };
  Game.goTo2v2OnlineLobby = function () { calls.push('2v2-lobby'); };
  twov2OnlineCreate = function () { calls.push('2v2-create'); };
  UI._mpCreateRoom = function (kind) { calls.push('room:' + kind); };
  try {
    [['2v2', '2v2-lobby,2v2-create'], ['1v1', 'room:classic'], ['1v1deck', 'room:deck']].forEach(function (p) {
      calls = [];
      UI._mpSetupMode = p[0];
      UI._mpCreateFromSetup();
      check('Create Room in ' + p[0] + ' goes to ' + p[1], calls.join() === p[1], calls.join());
    });
    UI._mpSetupMode = 'nonsense';
    calls = [];
    UI._mpCreateFromSetup();
    check('an unknown mode falls back to 2v2', calls.join() === '2v2-lobby,2v2-create', calls.join());
  } finally {
    Game.goTo2v2OnlineLobby = keep.lobby; twov2OnlineCreate = keep.create; UI._mpCreateRoom = keep.room;
  }
})();
var createBtn = screen(IDLE(), '1v1').querySelector('#mps-create');
check('the Create button is wired to the router', !!createBtn && /UI\._mpCreateFromSetup\(\)/.test(createBtn.getAttribute('onclick') || ''));

// ---- 4. the code closes when the room fills ---------------------------------
var closed = ruleBody('.mpl-code-tiles.is-closed .mpl-code-tile');
check('a full room stops the code glowing',
      !!closed && /filter:\s*none/.test(closed),
      closed ? closed.replace(/\s+/g, ' ').trim().slice(0, 70) : 'rule missing');

// ---- 5. no dead controls ----------------------------------------------------
// Nothing in the engine fills an online seat with a bot, so the open seat must
// not offer one.
var lobby = screen({ status: 'waiting', code: 'abcd', mode: 'classic' });
check('the lobby shows the code as four tiles', lobby.querySelectorAll('.mpl-code-tile').map(function (t) { return t.textContent; }).join('') === 'ABCD');
check('the lobby has an open seat', lobby.querySelectorAll('.mpl-seat.is-open').length === 1);
check('+ ADD AI is not rendered without a handler', lobby.querySelectorAll('.mpl-addai').length === 0);
check('the host seat is yours, not the opponent\'s', lobby.querySelectorAll('.mpl-seat.is-you').length === 1 && lobby.querySelectorAll('.mpl-seat.is-opp').length === 0);

// ---- 6. the player's neon drives the whole screen ---------------------------
// Everything lit here was first written against --own-cyan, so picking purple
// recoloured the menu chrome and left the multiplayer screen cyan — nine
// elements measured still painting rgb(0,229,255) under a purple theme. The
// neon pick is an OWNERSHIP colour: it means "you", so every surface that
// means "you" follows it. (Owner: "the neon need to apply everywhere.")
var THEMED = ['.mps-mode.is-on', '.mps-create', '.mps-mode.is-on .mps-mode-ind', '.mpl-code-tile',
              '.mpl-seat.is-you', '.mps-ev.is-on .mps-ev-sw'];
THEMED.forEach(function (sel) {
  var b = ruleBody(sel);
  if (!b) { fails.push('themed element has no rule: ' + sel); return; }
  check(sel + ' follows the player pick, not a fixed cyan',
        /--theme-rgb/.test(b) && !/--own-cyan/.test(b),
        b.replace(/\s+/g, ' ').trim().slice(0, 70));
});
// The six swatches are the deliberate exception: each shows the colour it
// SELECTS, not the colour currently selected, so they stay literal.
check('the neon swatches keep their own literal colours',
      /\.mps-chip-blue\s*\{[^}]*--own-cyan/.test(BARE) &&
      /\.mps-chip-purple\s*\{[^}]*--own-purple/.test(BARE),
      'a swatch was rewired to --theme-rgb, so the picker previews one colour six times');
// And the opponent is never the player's colour.
check('the opponent seat stays red under every theme',
      !!ruleBody('.mpl-seat.is-opp') && /--own-opponent/.test(ruleBody('.mpl-seat.is-opp')) &&
      !/--theme-rgb/.test(ruleBody('.mpl-seat.is-opp')));

print('mp-screens: ' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) { print('Failures:'); fails.forEach(function (f) { print('  - ' + f); }); }
