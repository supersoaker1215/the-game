// ============================================================
// PHONE HAND LAYOUT — docs/superpowers/specs/2026-11-10-phone-hand-layout-design.md
//
//   jsc sim/phone-hand.js
//
// Layout cannot be computed here, so this asserts the CASCADE that produces it:
// for each property the fix depends on, the rule that wins at phone width
// (inside an `@container (max-width: 520px)` block, later in the file than the
// unconditional desktop rule with the same selector) says what the spec says.
// Each check names the measured failure it guards against. Plus the width
// publisher, run against stubbed layout.
//
// Measured before (375x812): 3 of 5 and 3 of 7 cards visible, cards 92px in
// 52px slots (6 overlaps), chrome drawn for 110px, 145-154px empty below.
// After: 5 of 5 / 6 of 7 (row scrolls), 0 overlaps, chrome = real width,
// player block flush with the bottom; desktop byte-identical.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var CSS = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join(''));
var BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });

var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

// Every phone container block, brace-matched, with its offset in the file.
function phoneBlocks() {
  var out = [], re = /@container\s*\(max-width:\s*520px\)\s*\{/g, m;
  while ((m = re.exec(BARE))) {
    var i = re.lastIndex, depth = 1;
    while (i < BARE.length && depth) { var ch = BARE[i++]; if (ch === '{') depth++; else if (ch === '}') depth--; }
    out.push({ at: m.index, body: BARE.slice(re.lastIndex, i - 1) });
  }
  return out;
}
// Last declaration of `prop` for an exact selector, scanning the given text.
function lastDecl(text, sel, prop) {
  var esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var re = new RegExp('(^|[};])\\s*' + esc + '\\s*\\{([^{}]*)\\}', 'g'), m, val = null, at = -1;
  while ((m = re.exec(text))) {
    var d = new RegExp('(?:^|;)\\s*' + prop.replace(/[-]/g, '\\-') + '\\s*:\\s*([^;]+)').exec(m[2]);
    if (d) { val = d[1].trim(); at = m.index; }
  }
  return { val: val, at: at };
}
function phoneWins(sel, prop) {
  var best = null;
  phoneBlocks().forEach(function (b) {
    var d = lastDecl(b.body, sel, prop);
    if (d.val !== null) best = { val: d.val, at: b.at + d.at };
  });
  return best;
}
function unconditionalAt(sel, prop) {
  // outside any @container/@media: strip those blocks and look at what is left
  var flat = BARE.replace(/@(container|media)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, function (c) { return c.replace(/[^\n]/g, ' '); });
  return lastDecl(flat, sel, prop);
}

// ---- SECTION 1 + 3: one column, player block at the bottom ------------------
var GA = 'body.in-match:not(.twov2-online-game) #game-area';
var d = phoneWins(GA, 'display'), fd = phoneWins(GA, 'flex-direction'), mh = phoneWins(GA, 'min-height');
check('phone: the game area is a column (hand owns the full row; tricks drop beneath it)',
      d && d.val === 'flex' && fd && fd.val === 'column', d ? d.val + '/' + (fd && fd.val) : 'no phone rule — the desktop 1fr auto grid left the hand 232px of 375');
check('phone: the column fills the screen height, so the player block can sit at the bottom',
      mh && /100dvh/.test(mh.val), mh ? mh.val : 'missing — 145-154px of empty screen under the hand');
var mt = phoneWins(GA + ' > .player-bar', 'margin-top');
check('phone: the player bar takes the free space above it (block anchored to the bottom)',
      mt && mt.val === 'auto', mt ? mt.val : 'missing');

// ---- SECTION 2.3: the card fills its slot, beating the desktop rule ---------
var CARD = 'body.in-match .player-hand-section .hand-cards .card';
var pw = phoneWins(CARD, 'width'), dw = unconditionalAt(CARD, 'width');
check('phone: a hand card is as wide as its slot', pw && pw.val === '100%',
      pw ? pw.val : 'missing — a 92px card sat in a 52px slot and overlapped its neighbours');
check('…and that phone rule comes AFTER the same-specificity desktop rule, so it wins',
      pw && dw.at >= 0 && pw.at > dw.at, 'phone at ' + (pw && pw.at) + ', desktop at ' + dw.at);
var mx = phoneWins(CARD, 'max-width');
check('phone: no 92px cap left over to fight the slot', mx && mx.val === 'none', mx ? mx.val : 'missing');
var mnh = phoneWins('.player-hand-section .hand-cards .card', 'min-height');
check('phone: height follows the card shape (no 130px floor under a 56px card)',
      mnh && /^0(px)?$/.test(mnh.val), mnh ? mnh.val : 'missing');

// ---- SECTION 2.4: the 56px floor ------------------------------------------------
var floor = phoneWins('.player-hand-section .hand-cards .hand-card-wrapper', 'min-width');
check('phone: a card slot never goes below 56px (a 7-card hand scrolls instead)',
      floor && floor.val === '56px', floor ? floor.val : 'missing');

// ---- SECTION 2.1: chrome from the real width ---------------------------------
var sb = phoneWins('.player-hand-section .hand-cards .card', '--sb-card');
check('phone: chrome width reads the measured real width',
      sb && /var\(--hand-real-w/.test(sb.val), sb ? sb.val : 'missing — chrome was drawn for 110px on a 92px card');

// ---- the name fits the window you can see ------------------------------------
var pl = phoneWins('.player-hand-section .hand-cards .card .card-name-overlay', 'padding-left');
check('phone: the name plate is inset by the frame, so the fitter targets the visible window',
      pl && /--cf-inset/.test(pl.val), pl ? pl.val : 'missing — plate 40px vs a 36px window; names cut at both edges');

// ---- the publisher ------------------------------------------------------------
var UISRC = read('ui.js');
check('the hand fitter publishes the real width after each pass',
      /_syncHandRealWidth\(\)\s*\{/.test(UISRC) && /this\._syncHandRealWidth\(\)/.test(UISRC));
(function () {
  if (typeof UI === 'undefined' || !UI._syncHandRealWidth) { fails.push('UI._syncHandRealWidth not loaded'); return; }
  // The app shell already has a hand row (empty); use it — the publisher reads
  // the FIRST hand row in the document, exactly as it does in the game.
  var row = document.querySelector('.player-hand-section .hand-cards'), sec = null;
  if (!row) {
    sec = document.createElement('div'); sec.className = 'player-hand-section';
    row = document.createElement('div'); row.className = 'hand-cards';
    sec.appendChild(row); document.body.appendChild(sec);
  }
  var slot = document.createElement('div'); slot.className = 'hand-card-wrapper';
  slot.getBoundingClientRect = function () { return { width: 68.6, height: 136, left: 0, right: 68.6, top: 0, bottom: 136 }; };
  row.appendChild(slot);
  UI._syncHandRealWidth();
  check('the publisher writes the slot width onto the row', row.style.getPropertyValue('--hand-real-w') === '69px',
        'got ' + row.style.getPropertyValue('--hand-real-w'));
  slot.getBoundingClientRect = function () { return { width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 }; };
  UI._syncHandRealWidth();
  check('a hidden / pre-layout row keeps the last good value', row.style.getPropertyValue('--hand-real-w') === '69px');
  slot.remove(); if (sec) sec.remove();
})();

print('phone-hand: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('phone-hand failed');
