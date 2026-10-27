// ============================================================
// THE UI, RUN — not grepped.
//
//   jsc sim/ui-render.js
//
// ui.js is 40,106 lines, 27% of the codebase, and until now no test executed a
// line of it. Twenty-eight suites in sim/ `read('ui.js')` as TEXT and match
// regexes against the source, which verifies the code LOOKS right — a different
// claim from working, and the reason several visual fixes in this repo's
// history shipped inert. A selector that matches nothing, a class that is never
// added, an element built in the wrong branch: every one of those passes a grep.
//
// sim/shim-dom.js gives ui.js a DOM real enough to build into and the app shell
// parsed out of index.html, so a renderer can be CALLED and the tree it
// produces inspected. What this cannot answer is anything downstream of the
// cascade — specificity, animation fill-mode, what a rule actually paints.
// Those stay headless-Chrome questions (see sim/gfx-budget.js, sim/card-tube.js
// and the fixtures in the commit history). The split is deliberate: structure
// here, appearance there.
//
// This is the seed, not the migration. Each of the 28 text suites should move
// the half of its claim that is structural into a test like these as its area
// is next touched — not as a project.
// ============================================================

var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');

var __pass = 0, __fail = 0, __fails = [];
function test(name, fn) {
  try { fn(); __pass++; print('  PASS  ' + name); }
  catch (e) { __fail++; __fails.push(name + ' — ' + (e && e.message || e)); print('  FAIL  ' + name + ' — ' + (e && e.message || e)); }
}
// A DOM node is cyclic (parentNode ↔ children), so the obvious JSON.stringify
// in an assertion message throws and reports a serializer failure where the
// real answer was "these two nodes are not the same node".
function show(v) {
  if (v == null) return String(v);
  if (typeof v === 'object') {
    if (v.tagName) return '<' + String(v.tagName).toLowerCase() + (v.className ? ' class="' + v.className + '"' : '') + '>';
    return '[object]';
  }
  return JSON.stringify(v);
}
function eq(a, b, msg) {
  if (a !== b) throw new Error('expected ' + show(b) + ', got ' + show(a) + (msg ? ' — ' + msg : ''));
}
function ok(v, msg) { if (!v) throw new Error('expected truthy' + (msg ? ' — ' + msg : '')); }

function fresh() {
  Game.init();
  Game.seedMatch(0x5EED);
  Game.state.mode = { deck: 'classic', players: '1v1' };
  Game.state.phase = 'player-cards';
  Game.state.round = 1;
  Game.state.firstPlayer = 'player';
  Game.state.activePlayer = 'player';
  Game.history = [];
  return Game;
}
function inst(name, side) {
  return Game.createCardInstance(CARD_DEFS.find(function (c) { return c.name === name; }), side || 'player');
}
function text(el, sel) { var n = el.querySelector(sel); return n ? n.textContent.trim() : null; }

print('=== ui-render.js (the real renderer, against a real tree) ===');

// ---- THE CANONICAL RENDERER ACTUALLY BUILDS THE CARD -------------------
// Every surface in the game funnels through makeCardEl. A grep can confirm the
// function mentions `.card-name-overlay`; only running it confirms a card comes
// out with the right name, cost and stats on it.
test('makeCardEl builds a card carrying its own name, cost and stats', function () {
  fresh();
  var thor = inst('Thor');
  var el = UI.makeCardEl(thor, false, 'player', {});
  eq(el.tagName, 'DIV', 'it is an element');
  ok(el.classList.contains('card'), 'it is a .card');
  eq(text(el, '.cn-text'), 'Thor', 'the name is rendered');
  eq(text(el, '.card-cost'), String(thor.baseCost), 'the cost pill shows the real cost');
  eq(text(el, '.stat-atk'), String(thor.attack), 'attack matches the instance');
  eq(text(el, '.stat-hp'), String(thor.currentHealth), 'health matches the instance');
  ok(!!el.querySelector('.card-portrait'), 'and it has a portrait to hang art on');
});

// ---- A KEYWORD REACHES THE SCREEN AS A BADGE ---------------------------
// The badge row is built from the instance's keyword fields. This is the step
// between "the card has Splash" and "the player can see it has Splash", and it
// is exactly the step a source grep cannot check.
test('a keyword on the instance becomes a badge in the tree', function () {
  fresh();
  var el = UI.makeCardEl(inst('Thor'), false, 'player', {});
  var badges = el.querySelectorAll('.status-badge');
  ok(badges.length >= 2, 'Thor prints more than one keyword');
  var names = badges.map(function (b) { return b.className; }).join(' ');
  ok(names.indexOf('badge-splash') >= 0, 'Splash is on screen');
  ok(names.indexOf('badge-unresistible') >= 0, 'Unresistible is on screen');
  // The number matters as much as the word — a Splash badge with no radius is
  // the same badge every splasher would get.
  var splash = el.querySelector('.badge-splash');
  eq(text(splash, '.sb-n'), String(inst('Thor').splashRange), 'and it carries the radius');
});

// ---- A FACE-DOWN CARD GIVES NOTHING AWAY -------------------------------
// The whole promise of Invisible Woman is that the opponent cannot know what is
// under there. That promise lives in the DOM: a name, a cost, a stat or a
// data-card-id in the tree is a leak no amount of CSS hides, and it is
// inspectable by anyone with devtools.
test('a face-down card leaks no identity into the DOM', function () {
  fresh();
  var el = UI.makeFaceDownEl();
  ok(el.classList.contains('face-down-hidden'), 'it renders as a hidden card');
  var html = el.outerHTML;
  ok(html.indexOf('card-name') < 0, 'no name node');
  ok(html.indexOf('stat-atk') < 0, 'no attack');
  ok(html.indexOf('stat-hp') < 0, 'no health');
  ok(html.indexOf('card-cost') < 0, 'no cost');
  eq(el.getAttribute('data-card-id'), null, 'and no id to look the card up by');
});

// ---- THE BATMAN LOCK HANGS OUTSIDE THE CARD ----------------------------
// sim/bat-lock.js reasons about this from the source, and its trap #2 is a DOM
// fact: `.card.unplayable` carries `filter: grayscale(.95) brightness(.6)`, and
// filter applies to the element AND its descendants as one group — so a marker
// parented inside `.card` is greyed by the very rule it exists to explain. It
// has to be a SIBLING. That is a question about where the node ended up, which
// is answerable here for real rather than inferred.
test('the Batman lock marker is a sibling of the card, never inside it', function () {
  fresh();
  var wrap = document.createElement('div');
  wrap.className = 'hand-card-wrapper';
  var card = UI.makeCardEl(inst('Thor'), true, 'player', {});
  wrap.appendChild(card);

  UI._applyBatLock(wrap, card, true);
  var mark = wrap.querySelector('.bat-lock');
  ok(!!mark, 'the marker was created');
  eq(mark.parentNode, wrap, 'it hangs on the WRAPPER, outside the filtered card');
  eq(card.querySelector('.bat-lock'), null, 'and never inside the card');
  ok(card.classList.contains('batman-locked'), 'the card itself is flagged');
  eq(mark.getAttribute('aria-hidden'), 'true', 'and it is not read out twice');

  // …and it comes off cleanly, which is what a re-render depends on.
  UI._applyBatLock(wrap, card, false);
  eq(wrap.querySelector('.bat-lock'), null, 'clearing removes it');
  eq(card.classList.contains('batman-locked'), false, 'and un-flags the card');
});

// ---- THE BLOCK METER'S CHARGE TIER -------------------------------------
// Shipped with the graphics scale and until now covered only by a browser
// fixture. It is a pure function and the 1v1 ring and the 2v2 pip row both read
// it, so a drift here silently desynchronises the two surfaces.
test('the block meter tier escalates with the meter and caps at full', function () {
  var max = Game.BLOCK_MAX || 8;
  eq(UI._blockTierClass(0), 'block-tier-empty', 'nothing banked');
  eq(UI._blockTierClass(1), 'block-tier-low', 'a little');
  eq(UI._blockTierClass(Math.ceil(max / 2)), 'block-tier-mid', 'past half');
  eq(UI._blockTierClass(max - 1), 'block-tier-brink', 'one hit from firing');
  eq(UI._blockTierClass(max), 'block-tier-full', 'full');
  eq(UI._blockTierClass(max + 5), 'block-tier-full', 'and it cannot go past full');
});

// ---- THE CARD BACK OBEYS THE TIER SYSTEM -------------------------------
// It was a plain string constant, so every platform got the 825x1425 / 0.98MB
// master (4.70MB decoded) to paint a board tile that is 141x185 device px on a
// phone — a 1/8.6 linear oversample, and the single largest image the game
// ships to a phone. art-md/card-back.jpg has existed at 296x512 / 54KB the
// whole time with nothing referencing it.
// Executed rather than grepped because it is now a GETTER whose branch is
// re-evaluated per read: a constant that merely LOOKS tiered would pass a
// regex and still serve the master.
test('the card back is served per tier, re-evaluated on every read', function () {
  var realMM = window.matchMedia;
  var narrow = false;
  window.matchMedia = function (q) {
    return { matches: narrow && /max-width:\s*640px/.test(q),
             addEventListener: function () {}, removeEventListener: function () {},
             addListener: function () {}, removeListener: function () {} };
  };
  try {
    narrow = false;
    var desktop = UI.CARD_BACK_SRC;
    narrow = true;
    var phone = UI.CARD_BACK_SRC;
    ok(/audio\/cards\/art\/card-back/.test(desktop), 'desktop takes the master, got ' + desktop);
    ok(/art-md\/card-back/.test(phone), 'a phone takes the md tier, got ' + phone);
    ok(desktop !== phone, 'the two branches differ');
    // The breakpoint can be crossed mid-session (rotate, resize), so a value
    // captured once at load would be wrong for the rest of the match.
    narrow = false;
    eq(UI.CARD_BACK_SRC, desktop, 're-reads after the viewport changes back');
  } finally {
    window.matchMedia = realMM;
  }
});

print('');
print('ui-render: ' + __pass + ' passed, ' + __fail + ' failed');
if (__fail) {
  __fails.forEach(function (f) { print('  • ' + f); });
  throw new Error('ui-render failed: ' + __fail);
}
