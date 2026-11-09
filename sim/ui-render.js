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

// ---- THE MENU IS FOUR ROWS, AND THE KEYS WORK (2026-11-06) ----------------
// Executed against the real renderer rather than grepped: a row count is a
// fact about the tree, and "ArrowDown moves the highlight" only means
// something if the handler ran. The reference is a console title menu — four
// big rows on a rail, one lit, a hero on the right, PRESS START in front.
function menuShell() {
  // renderMainMenu wants the overlay and a state; the shim parses index.html
  // so #main-menu-overlay is already in the tree.
  if (!document.getElementById('main-menu-overlay')) {
    var ov = document.createElement('div'); ov.id = 'main-menu-overlay'; document.body.appendChild(ov);
  }
  Game.init();
  UI._mmSub = null; UI._titleDone = true;      // the gate is tested on its own below
  UI.renderMainMenu(Game.state);
  return document.getElementById('main-menu-overlay');
}
function rowLabels(root) {
  return [...root.querySelectorAll('.mm-panel .mm-option')].map(function (b) {
    var l = b.querySelector('.mm-option-label');
    return (l ? l.textContent : b.textContent).replace(/\s+/g, '').toUpperCase();
  });
}
test('the main menu is exactly four rows, in order, with no boxed feature', function () {
  var el = menuShell();
  eq(rowLabels(el).join(','), 'PLAY,MULTIPLAYER,LIBRARY,SETTINGS', 'the four');
  eq(el.querySelectorAll('.mm-feature').length, 0, 'the Multiplayer callout box is gone');
  eq(el.querySelectorAll('.mm-panel .mm-option .mm-rail-seg').length, 4, 'every row carries its rail segment');
  eq(el.querySelectorAll('.mm-legend').length, 0, 'no on-screen key legend (owner removed it)');
  ok(el.classList.contains('mm-four'), 'the overlay is in four-row mode');
});
test('PLAY and LIBRARY each open four rows plus a Back, one level down', function () {
  var el = menuShell();
  UI.mmShowSub('play');
  eq(rowLabels(el).join(','), 'SOLOMATCH,ROGUELITE,TOURNAMENT,TUTORIAL,BACK', 'play submenu');
  UI.mmShowSub('library');
  eq(rowLabels(el).join(','), 'MYDECKS,CODEX,STATS,TOOLS,BACK', 'library submenu');
  UI.mmShowSub('mp');
  ok(!!el.querySelector('.mm-subback'), 'multiplayer has a Back now too');
  UI.mmShowSub(null);
});
test('Back goes up ONE level: Solo -> Play -> main', function () {
  menuShell();
  UI.mmShowSub('solo');
  UI.mmBack();
  eq(UI._mmSub, 'play', 'Solo sits under Play');
  UI.mmBack();
  eq(UI._mmSub, null, 'and Play sits under the main list');
});
test('ArrowDown / ArrowUp move the single highlighted row; Enter picks it; Esc backs out', function () {
  var el = menuShell();
  var active = function () { return [...el.querySelectorAll('.mm-panel .mm-option')].findIndex(function (b) { return b.classList.contains('is-active'); }); };
  eq(active(), 0, 'the first row is lit on entry');
  UI._mmKey({ key: 'ArrowDown', preventDefault: function () {} });
  eq(active(), 1, 'ArrowDown moves it down');
  UI._mmKey({ key: 'ArrowUp', preventDefault: function () {} });
  UI._mmKey({ key: 'ArrowUp', preventDefault: function () {} });
  eq(active(), 3, 'ArrowUp wraps from the top to the bottom');
  eq(el.querySelectorAll('.mm-panel .mm-option.is-active').length, 1, 'only ever ONE row is lit');
  // Enter CLICKS the lit row. The shim's click() fires addEventListener
  // listeners only, never an onclick attribute, so prove the mechanism — the
  // handler reached for THIS row — by stubbing click on it.
  UI._mmSetActive(0);
  var rows = el.querySelectorAll('.mm-panel .mm-option');
  var clicked = -1;
  [...rows].forEach(function (b, k) { b.click = function () { clicked = k; }; });
  UI._mmKey({ key: 'Enter', preventDefault: function () {}, target: el });
  eq(clicked, 0, 'Enter clicked the lit row (PLAY)');
  ok(/mmShowSub\('play'\)/.test(rows[0].getAttribute('onclick') || ''), 'and that row opens the Play submenu');
  UI.mmShowSub('play');
  UI._mmKey({ key: 'Escape', preventDefault: function () {} });
  eq(UI._mmSub, null, 'Esc backed out of it');
});
test('the title screen gates the menu once, and a press dismisses it into the menu', function () {
  var el = (function () {
    if (!document.getElementById('main-menu-overlay')) { var ov = document.createElement('div'); ov.id = 'main-menu-overlay'; document.body.appendChild(ov); }
    return document.getElementById('main-menu-overlay');
  })();
  Game.init();
  UI._titleDone = false; UI._titleArmed = false; UI._mmSub = null;
  Game.state.phase = 'main-menu';
  UI.render();
  ok(el.classList.contains('is-title'), 'render() shows the title screen first');
  ok(!!el.querySelector('.ts-prompt'), 'with a PRESS START prompt');
  eq(el.querySelectorAll('.mm-panel .mm-option').length, 0, 'and no menu rows yet');
  var tbg = el.querySelector('.ts-bg');
  ok(tbg && /audio\/cards\/art\//.test(String(tbg.style.backgroundImage || '')), 'the hero art is set on the title background (was url("") via a quote-terminated style attribute)');
  var realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function (fn) { fn(); return 0; };   // land the crossfade now
  try { UI.dismissTitle(); } finally { globalThis.setTimeout = realSetTimeout; }
  eq(UI._titleDone, true, 'the gate is spent');
  ok(!el.classList.contains('is-title'), 'the title classes are gone');
  eq(rowLabels(el).length, 4, 'and the four rows are up');
  UI.render();
  eq(rowLabels(el).length, 4, 'a later render stays on the menu — once per load, not per render');
});

test('the first-run "New here?" prompt waits behind the title screen instead of landing on top of it', function () {
  var el = document.getElementById('main-menu-overlay');
  Game.init();
  UI._titleDone = false; UI._titleArmed = false; UI._mmSub = null; UI._firstRunShown = false;
  try { localStorage.removeItem('clb-onboarded'); } catch (e) {}
  if (typeof globalThis.Tutorial === 'undefined') globalThis.Tutorial = { start: function () {} };
  Game.state.phase = 'main-menu';
  UI.render();
  ok(el.classList.contains('is-title'), 'title screen is up');
  UI._maybeShowFirstRun();                                   // what the 950ms boot timer does
  eq(document.querySelectorAll('.first-run-overlay').length, 0, 'the prompt does NOT appear over the title');
  eq(UI._firstRunShown, false, 'and the one-shot flag is not spent by the early ask');
  var realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function (fn) { fn(); return 0; };
  try { UI.dismissTitle(); } finally { globalThis.setTimeout = realSetTimeout; }
  eq(document.querySelectorAll('.first-run-overlay').length, 1, 'it appears once the menu is up');
  document.querySelectorAll('.first-run-overlay').forEach(function (n) { n.remove(); });
  try { localStorage.setItem('clb-onboarded', '1'); } catch (e) {}
});

test('multiplayer setup is simple: one back, modes + CREATE ROOM as rail rows, no boxed panels', function () {
  var el = menuShell();
  UI.mmShowSub('mp');
  eq(el.querySelectorAll('.mm-subback, .mp-crumb-back').length, 1, 'exactly one way back (it printed once per mode)');
  eq(rowLabels(el).join('|'), '2V2ONLINE|1V1ONLINE|1V1CUSTOMDECKS|CREATEROOM',
     'the three modes and CREATE ROOM are the rail rows, so arrows/Enter and gold work here too');
  eq(el.querySelectorAll('.mm-panel .mps-mode.mm-option').length, 3, 'each mode IS a menu row');
  eq(el.querySelectorAll('.mm-panel .mm-rail-seg').length, 4, 'one rail segment per row');
  eq(el.querySelectorAll('.mps-mode.is-on').length, 1, 'exactly one chosen mode');
  eq(el.querySelectorAll('.mps-cta, .mps-mode-head, .mps-create-sub').length, 0, 'the old boxed CTA and card heads are gone');
  ok(!!el.querySelector('#mp-name-input') && !!el.querySelector('#mp-code-slots'), 'name field and code slots keep their ids');
});

test('the MULTIPLAYER menu row runs the full multiplayer entry (room listeners), not just the panel swap', function () {
  var el = menuShell();
  var row = el.querySelector('#mm-four-multi');
  ok(!!row && /UI\.openMultiplayer\(\)/.test(row.getAttribute('onclick') || ''),
     'onclick is ' + (row && row.getAttribute('onclick')));
});

test('the 1v1 waiting lobby is simple: code, seat lines, rail rows — no dead START, one copy action', function () {
  var el = menuShell();
  UI.mmShowSub('mp');
  UI._mpState = { tab: 'create', status: 'waiting', code: 'QX7K', mode: 'classic', you: 'player', opponent: null };
  UI._mpLobby = { oppName: '' };
  UI._mpRender();
  eq(el.querySelectorAll('.mpl-tron').length, 1, 'the lobby renders');
  eq(el.querySelectorAll('.mpl-code-tile').length, 4, 'the code is still four letters (tap to copy)');
  eq(el.querySelectorAll('button[disabled], .mpl-start').length, 0, 'no START button nothing could ever enable');
  eq(el.querySelectorAll('.mpl-code-act, .mpl-vs, .mpl-summary, .mpl-seat-dot').length, 0, 'Copy/Share pair, VS rule, summary and seat dots are gone');
  eq(el.querySelectorAll('#mpl-copy.mm-option').length, 1, 'one COPY CODE rail row');
  UI._mpLobby = { oppName: 'Ryan' };
  UI._mpRender();
  eq(el.querySelectorAll('#mpl-copy').length, 0, 'a full room drops the copy row');
  eq(el.querySelectorAll('.mpl-seat.is-opp').length, 1, 'the opponent seat appears');
  UI._mpState = { tab: 'create', code: null, status: 'idle', you: null, opponent: null };
  UI._mpLobby = {};
});

test('2v2 waiting room: seat names are text not HTML, rows not boxes, Start/Shuffle are rail rows', function () {
  var host = document.createElement('div');
  document.body.appendChild(host);
  Game.init();
  Game.goTo2v2OnlineLobby();
  var tt = Game.state.twoVTwo;
  tt.you = 'p1';
  tt.players.p1.name = 'Henry'; tt.players.p2.name = '<b>Ryan</b>';
  tt.players.p3.name = 'Bot'; tt.players.p3.isAI = true;
  tt.players.p4.name = 'Bot 2'; tt.players.p4.isAI = true;
  tt.joinedPlayers = { p1: true, p2: true, p3: false, p4: false };
  UI._2v2OnlineRoomCode = 'QX7K';
  UI._render2v2OnlineLobby(host, Game.state, tt);
  eq(host.querySelectorAll('.twov2-tron').length, 1, 'the waiting room uses the sleek layout');
  eq(host.querySelectorAll('.twov2-mm-pname b').length, 0, 'a peer-supplied name is escaped, never parsed as HTML');
  var names = []; host.querySelectorAll('.twov2-mm-pname').forEach(function (n) { names.push(n.textContent); });
  ok(names.indexOf('<b>Ryan</b>') >= 0, 'the name prints literally (got ' + names.join(',') + ')');
  eq(host.querySelectorAll('.twov2-mm-ic, .twov2-mm-label').length, 0, 'no ▷ icons, no barred label');
  var labels = []; host.querySelectorAll('.twov2-row-label').forEach(function (n) { labels.push(n.textContent); });
  eq(labels.join('|'), 'Start Match|Shuffle Teams', 'a full balanced room offers Start then Shuffle as rail rows');
  host.remove();
  UI._2v2OnlineRoomCode = null;
});

test('VOICE: a 2v2 room left behind does not keep the panel on the main menu, and it clears the build badge', function () {
  if (typeof Voice === 'undefined') load('./voice.js');
  Game.init();
  Game.goTo2v2OnlineLobby();
  eq(Voice._inOnlineMatch(), true, 'inside the 2v2 lobby, voice is live');
  Game.state.phase = 'main-menu';   // what going back to the menu leaves behind: the room record, still online
  ok(Game.state.twoVTwo && Game.state.twoVTwo.online, 'the stale room record is still marked online');
  eq(Voice._inOnlineMatch(), false, 'on the main menu, voice is not live — so mount() removes the panel');
  var css = read('style.css');
  ok(/body\.on-main-menu \.voice-panel\s*\{\s*bottom:\s*34px/.test(css), 'when both show, VOICE sits above the badge');
  ok(/'voice-gate'/.test(read('ui.js')), 'the voice check runs before the menu screens return');
});

test('the wordmark carries its subtitle on the menu, every submenu and the title screen', function () {
  var el = menuShell();
  eq((el.querySelector('.mm-header .mm-tagline') || {}).textContent, 'Card Lane Battle', 'main menu');
  UI.mmShowSub('play');
  ok(!!el.querySelector('.mm-panel .mm-tagline'), 'Play submenu');
  UI.mmShowSub('mp');
  ok(!!el.querySelector('.mm-panel .mm-tagline'), 'multiplayer');
  UI._mmSub = null;
  ok(/class="ts-tagline">Card Lane Battle</.test(read('ui.js')), 'title screen lockup');
});

print('');
print('ui-render: ' + __pass + ' passed, ' + __fail + ' failed');
if (__fail) {
  __fails.forEach(function (f) { print('  • ' + f); });
  throw new Error('ui-render failed: ' + __fail);
}
