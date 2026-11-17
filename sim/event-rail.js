// ============================================================
// ONE RAIL, EVERY EVENT TYPE.
//
//   jsc sim/event-rail.js
//
// The event rail (UI._renderEventRail) is the one place that answers "what is
// acting on this board": environments, collapsed lanes, the live event slot,
// the Cog Invasion boss set, and what is up next. It docks with the Cog panel
// and the Shadow Man tracker in one right-hand column, and two of its rows are
// doors that open those panels. These checks render the rail, the panels and
// the lane backdrops from real game state and read the DOM that comes out.
//
// Rules pinned here:
//   · the TICK is the ONLY thing carrying type colour
//   · names are sentence case (uppercase belongs to the rail's own labels)
//   · RED IS NOT A TYPE COLOUR — it means the opposing player everywhere else
// Cascade facts (sizes, colours, pointer-events) cannot be computed by the
// shim, so those stay as stylesheet-text checks at the end.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var CSSTEXT = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join(''));
var BARE = CSSTEXT.replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });

var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
// A behaviour this suite proved is broken in SHIPPED code, reported rather than
// fixed here. It does not fail the suite; it starts passing once the code is fixed.
var known = [];
function knownBug(name, cond, detail) { if (cond) pass++; else known.push(name + (detail ? ' — ' + detail : '')); }
function allRuleBodies(sel) {
  var re = new RegExp('(^|[};])\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^{}]*)\\}', 'gm');
  var m, out = [];
  while ((m = re.exec(BARE))) out.push(m[2]);
  return out;
}
function ruleBody(sel) { var all = allRuleBodies(sel); return all.length ? all[all.length - 1] : null; }

// ---- harness ------------------------------------------------------------------
var RAF = [];
requestAnimationFrame = window.requestAnimationFrame = function (f) { RAF.push(f); return RAF.length; };
function flushRaf() { var q = RAF.splice(0); q.forEach(function (f) { f(); }); }
function fresh(round) {
  Game.init();
  Game.state.mode = { deck: 'classic', players: '1v1' };
  Game.state.round = round || 9;
  Game.state._eventsUsed = Game.matchEventPool().slice();   // nothing up next unless a test says so
  ['event-rail', 'right-col', 'cog-panel', 'shadow-tracker'].forEach(function (id) {
    var el = document.getElementById(id); if (el) el.remove();
  });
  UI._eventRailPrev = null; UI._eventRailGone = null; UI._shadowOpen = false;
  RAF.length = 0;
}
function rail() { return document.getElementById('event-rail'); }
function rows() { var r = rail(); return r ? r.querySelector('.ev-list').children : []; }
function row(id) { return rows().filter(function (r) { return r.getAttribute('data-ev-id') === id; })[0] || null; }
function text(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
function render() { UI._renderEventRail(Game.state); }
function cogLive(activeKey) {
  Game._cogInit();
  if (activeKey) { var vp = Game.state._cog.vps[activeKey]; vp.active = true; vp.firstRound = Game.state.round; }
  return Game.state._cog;
}
function shadowLive() {
  Game.state._shadow = { shows: true, appeared: true, returned: false, stats: { player: {}, ai: {} }, prizes: {} };
  Game._eventSlotClaim(Game.state.round, 'The Shadow Man', 'modifier');
}

// ---- 1. the four type colours, and the one that is absent --------------------
var TYPES = UI._EVENT_TYPES;
check('the rail declares exactly four types',
      JSON.stringify(Object.keys(TYPES).sort()) === JSON.stringify(['boon', 'boss', 'hazard', 'modifier']), Object.keys(TYPES).join());
[['boss', '176, 97, 255'], ['modifier', '255, 209, 102'],
 ['hazard', '255, 122, 24'], ['boon', '38, 255, 156']].forEach(function (p) {
  check(p[0] + ' is ' + p[1], TYPES[p[0]] && TYPES[p[0]].rgb === p[1]);
});
check('RED is not a type colour',
      !Object.keys(TYPES).some(function (k) { return /255,\s*47,\s*69/.test(TYPES[k].rgb); }),
      'red is the opposing player everywhere else — a hostile event is orange or purple');

// each kind reaches its row as the --ev-rgb the tick paints with
fresh(9);
Game._eventSlotClaim(9, 'MC Ballyhoo', 'boon');
render();
var slotRow = row('slot9MC Ballyhoo');
check('a slot row carries its type colour on --ev-rgb', !!slotRow && slotRow.style.getPropertyValue('--ev-rgb') === TYPES.boon.rgb,
      slotRow && slotRow.style.getPropertyValue('--ev-rgb'));
check('…and its type class', !!slotRow && slotRow.classList.contains(TYPES.boon.cls));
check('…in three parts: tick, name, clock', !!slotRow && !!slotRow.querySelector('.ev-tick') &&
      text(slotRow.querySelector('.ev-name')) === 'MC Ballyhoo' && text(slotRow.querySelector('.ev-clock')) === '3 left',
      text(slotRow));

// ---- 2. the slot is the one door the rail reads -------------------------------
fresh(9);
Game._eventSlotClaim(9, 'The Shadow Man', 'modifier');
render();
check('the live slot has a row keyed by start and name', !!row('slot9The Shadow Man'), rows().map(function (r) { return r.getAttribute('data-ev-id'); }).join());
fresh(9);
Game.state._ballyhoo = { shows: true, fired: true, appearAt: 9 };   // event state with NO slot behind it
render();
check('event state with no slot claim gets no row of its own (the rail reads the slot, not each event)',
      !rows().some(function (r) { return /ballyhoo/i.test(text(r)); }), rows().map(text).join(' | '));

// ---- 3. stacking: six rows max, newest open, expiry visible for one round -----
check('six rows max', UI._EVENT_MAX_ROWS === 6, UI._EVENT_MAX_ROWS);
fresh(9);
for (var li = 0; li < 6; li++) { Game.state.lanes[li].destroyed = true; Game.state.lanes[li].destroyedTurns = 2; }
cogLive('vp');
Game._eventSlotClaim(9, 'MC Ballyhoo', 'boon');
render();
var shownRows = rows().filter(function (r) { return r.getAttribute('data-ev-id') !== 'upnext'; });
check('eight active events show six rows', shownRows.length === 6, shownRows.length);
check('…and collapse the rest into "+2 more"', /\+2 more/.test(text(rail().querySelector('.ev-tail'))), text(rail().querySelector('.ev-tail')));
check('the head counts every active event', text(rail().querySelector('.ev-head-count')) === '8 active', text(rail().querySelector('.ev-head-count')));
var cogRow = row('cog');
check('the NEWEST event is the one open', !!cogRow && cogRow.classList.contains('is-open') && !!cogRow.querySelector('.ev-open'));
check('…and only that one', rows().filter(function (r) { return r.classList.contains('is-open'); }).length === 1);

fresh(9);
Game._eventSlotClaim(9, 'MC Ballyhoo', 'boon');
render();
Game.state.round = 12;           // the slot has let go
render();
var gone = rail() && rail().querySelector('.ev-gone');
check('an ended event drops to the Expired block', !!gone && /MC Ballyhoo/.test(text(gone)) && /R12/.test(text(gone)), text(gone));
check('…and is no longer an active row', !row('slot9MC Ballyhoo'));
Game.state.round = 13;
render();
check('…for one round only', !(rail() && rail().querySelector('.ev-gone')));
check('struck through (stylesheet)', /line-through/.test(BARE.slice(BARE.indexOf('.ev-gone'))));

// ---- 4. up next keeps the row at zero, and reads "now" ------------------------
fresh(3);
Game.state._eventsUsed = [];
Game.state._habitats = [{ name: 'Wetlands', shows: true, appearAt: 5, fired: false }];
render();
check('up next counts down to a drawn event', /Wetlands/.test(text(row('upnext'))) && /in 2/.test(text(row('upnext'))), text(row('upnext')));
Game.state.round = 5;
render();
check('at zero the row stays — the seam', !!row('upnext'), rows().map(text).join(' | '));
check('…and reads "now"', /\bnow\b/.test(text(row('upnext'))), text(row('upnext')));

// ---- 5. rows are keyed and reused, so they can transition ---------------------
fresh(9);
Game._eventSlotClaim(9, 'MC Ballyhoo', 'boon');
render();
var r1 = row('slot9MC Ballyhoo');
// `is-arriving` is added at creation, then the same pass writes
// `el.className = def.cls`, which wipes it before anything paints: the
// entrance start state never renders (ui.js _renderEventRail).
check('a new row arrives with the entrance class', !!r1 && r1.classList.contains('is-arriving'),
         'className is "' + (r1 && r1.className) + '" straight after the render that created it');
flushRaf(); flushRaf();
check('…and none is left on after it has painted', !!r1 && !r1.classList.contains('is-arriving'));
Game.state.round = 10;
render();
var r2 = row('slot9MC Ballyhoo');
check('a re-render reuses the same row node', r2 === r1);
check('…updates it in place', /2 left/.test(text(r2)), text(r2));
check('…and does not replay the entrance', !!r2 && !r2.classList.contains('is-arriving'));

// ---- 6. the rail removes itself when there is nothing to show -----------------
fresh(9);
render();
check('nothing active, nothing next: no rail', !rail());
Game._eventSlotClaim(9, 'MC Ballyhoo', 'boon');
render();
check('an event mounts it', !!rail());
Game.state.round = 12; render();
check('its expiry line keeps the rail up for a round', !!rail());
Game.state.round = 13; render();
check('and it goes again once the event and its expiry line have passed', !rail());

// ---- 7. the boss set is fed from the REAL cog state ---------------------------
fresh(9);
cogLive('cfo');
render();
cogRow = row('cog');
var vps = Game.state._cog.vps;
check('the boss row lists every executive from s._cog', !!cogRow &&
      Object.keys(vps).every(function (k) { return text(cogRow).indexOf(vps[k].name) >= 0; }), text(cogRow));
check('…marking the live one', !!cogRow && cogRow.querySelectorAll('.ev-member.is-live').length === 1);
vps.cfo.dead = true; vps.cfo.active = false;
render();
check('…and a beaten one', !!row('cog') && row('cog').querySelectorAll('.ev-member.is-dead').length === 1);
check('the rules live in the event tab', !!row('cog') && /Each executive sends its Cog out/.test(text(row('cog').querySelector('.ev-how'))));

// ---- 8. one column on the right; the Cog panel shows status, not prose --------
fresh(9);
cogLive('vp');
render();
UI._renderCogPanel(Game.state);
var col = document.getElementById('right-col'), panel = document.getElementById('cog-panel');
check('the rail docks in the right column', !!rail() && rail().parentNode === col);
check('the Cog panel docks in the same column', !!panel && panel.parentNode === col);
check('the always-on panel carries no prose', !!panel && !/COG INVASION/.test(text(panel)) && !/Four executives/.test(text(panel)), text(panel).slice(0, 120));
check('but a live VP is still reachable there', !!panel && !!panel.querySelector('.cog-hit'));
check('while a VP is attackable the panel is up', !!panel && panel.style.display === '');
fresh(9);
cogLive(null);                    // the engine is on, nobody has arrived yet
UI._renderCogPanel(Game.state);
panel = document.getElementById('cog-panel');
check('with nobody attackable the panel does not force itself open', !!panel && panel.style.display === 'none', panel && panel.style.display);
UI._toggleCogPanel();
UI._renderCogPanel(Game.state);
check('…the rail door opens it', panel.style.display === '' && panel.classList.contains('is-open'));
UI._toggleCogPanel();
UI._renderCogPanel(Game.state);
check('…and closes it again', panel.style.display === 'none');

// every panel re-parents, so one built before the column existed cannot stay loose
fresh(9);
cogLive('vp');
shadowLive();
UI._shadowOpen = true;
['event-rail', 'cog-panel', 'shadow-tracker'].forEach(function (id) {
  var el = document.createElement(id === 'event-rail' ? 'aside' : 'div'); el.id = id; document.body.appendChild(el);
});
render(); UI._renderCogPanel(Game.state); UI._renderShadowTracker(Game.state);
col = document.getElementById('right-col');
['event-rail', 'cog-panel', 'shadow-tracker'].forEach(function (id) {
  check(id + ' built loose is re-parented into the column', document.getElementById(id).parentNode === col);
});

// ---- 9. the Shadow Man tracker: docked, closed until asked --------------------
fresh(9);
shadowLive();
UI._renderShadowTracker(Game.state);
var tr = document.getElementById('shadow-tracker');
check('the tracker starts closed', !tr || tr.style.display === 'none');
UI._shadowOpen = true;
UI._renderShadowTracker(Game.state);
tr = document.getElementById('shadow-tracker');
check('opened, it draws in the column', !!tr && tr.style.display === '' && tr.parentNode === document.getElementById('right-col'));
UI._shadowOpen = false;

// ---- 10. a door opens ITS OWN panel ---------------------------------------------
var opened = [];
var realTS = UI._toggleShadowTracker, realTC = UI._toggleCogPanel;
UI._toggleShadowTracker = function () { opened.push('shadow'); };
UI._toggleCogPanel = function () { opened.push('cog'); };
fresh(9);
shadowLive();
cogLive('vp');
render();
var shRow = row('slot9The Shadow Man'); cogRow = row('cog');
check('the shadow row is a door', !!shRow && shRow.getAttribute('role') === 'button' && shRow.getAttribute('tabindex') === '0');
check('…which says whether it is open', !!shRow && shRow.getAttribute('aria-expanded') === 'false');
opened = []; shRow && shRow.onclick && shRow.onclick();
check('…and clicking it opens the shadow tracker, not the Cog panel', opened.join() === 'shadow', opened.join());
opened = []; cogRow && cogRow.onclick && cogRow.onclick();
check('the boss row opens the Cog panel', opened.join() === 'cog', opened.join());
var prevented = 0;
opened = []; shRow.onkeydown({ key: 'Enter', preventDefault: function () { prevented++; } });
shRow.onkeydown({ key: ' ', preventDefault: function () { prevented++; } });
shRow.onkeydown({ key: 'a', preventDefault: function () { prevented++; } });
check('a door answers Enter and Space, and nothing else', opened.join() === 'shadow,shadow' && prevented === 2, opened.join() + ' / ' + prevented);
UI._shadowOpen = true; render();
check('aria-expanded tracks the panel on every render', shRow.getAttribute('aria-expanded') === 'true');
UI._shadowOpen = false;
// a reused row whose door kind changes is re-wired; one that loses its door is unwired
Game.state._shadow.returned = true;   // no longer live: same row, no door
render();
shRow = row('slot9The Shadow Man');
check('a row that loses its door is fully unwired',
      !!shRow && !shRow.hasAttribute('role') && !shRow.hasAttribute('aria-expanded') && shRow.onclick == null && shRow.onkeydown == null &&
      shRow.getAttribute('data-door') === null, shRow && shRow.outerHTML.slice(0, 120));
fresh(9);
cogLive('vp');
render();
var reused = row('cog');
reused.setAttribute('data-ev-id', 'slot9The Shadow Man');   // the same node now holds the Shadow row
shadowLive();
Game.state._cog = null;
render();
check('a reused row re-wires when its door kind changes', row('slot9The Shadow Man') === reused && reused.getAttribute('data-door') === 'shadow');
opened = []; reused.onclick();
check('…so it opens the new panel, not the first one it was wired to', opened.join() === 'shadow', opened.join());
UI._toggleShadowTracker = realTS; UI._toggleCogPanel = realTC;

// ---- 11. it runs in 2v2, from the shared tail all three paths take ------------
(function () {
  var calls = 0, realRail = UI._renderEventRail;
  var keep = { a: UI._render2v2OnlineBoard, b: UI._render2v2LocalGame, c: UI.render2v2 };
  UI._renderEventRail = function () { calls++; };
  UI._render2v2OnlineBoard = function () {}; UI._render2v2LocalGame = function () {}; UI.render2v2 = function () {};
  Game.init();
  Game.start2v2Match({ names: { p1: 'A1', p2: 'A2', p3: 'B1', p4: 'B2' } });
  function via(phase, online) {
    calls = 0; Game.state.phase = phase; Game.state.twoVTwo.online = online;
    try { UI.renderSync(); } catch (e) { return 'threw ' + e; }
    return calls;
  }
  check('2v2 online game renders the event rail', via('2v2-play', true) === 1);
  check('2v2 local game renders the event rail', via('2v2-play', false) === 1);
  check('the 2v2 overlay path renders the event rail', via('2v2-pass', false) === 1);
  UI._renderEventRail = realRail;
  UI._render2v2OnlineBoard = keep.a; UI._render2v2LocalGame = keep.b; UI.render2v2 = keep.c;
})();

// ---- 12. a one-lane event is one picture and one clock ------------------------
(function () {
  Game.init();
  Game.state.lanes.forEach(function (l) { l._env = null; });
  Game._placeEventEnvironment('player', 0, 'Gargantua');
  Game._placeEventEnvironment('ai', 0, 'Gargantua', { keepOpposite: true });
  Game._placeEventEnvironment('ai', 2, 'Boiler Room');
  Game._placeEventEnvironment('player', 2, 'Sewers', { keepOpposite: true });
  UI.renderBoard(Game.state);
  var L = document.querySelectorAll('.lane');
  function halves(i) { var bg = L[i] && L[i].querySelector('.lane-env-bg'); return bg ? bg.children.map(function (c) { return c.className.replace('env-half ', ''); }).join(',') : ''; }
  function pips(i) { return L[i] ? L[i].querySelectorAll('.glyph-env').map(function (g) { return g.className.replace(/.*glyph-env-/, ''); }).join(',') : ''; }
  check('a full-lane environment paints one full-lane box', halves(0) === 'env-half-full', halves(0));
  check('…and prints one clock, in neutral', pips(0) === 'full', pips(0));
  check('two ordinary environments keep their two halves', halves(2) === 'env-half-top,env-half-bottom', halves(2));
  check('…and their two side-coloured clocks', pips(2) === 'ai,player', pips(2));
  // Framed for the lane, not for a card face: the gallery zoom is ignored.
  var realSize = UI._artSizeFor, realPath = UI.getCardArtPath;
  UI._artSizeFor = function () { return '140%'; };
  UI.getCardArtPath = function (n) { return 'art/' + n + '.jpg'; };
  var full = UI._envArtBackground(Game.state.lanes[0]._env.player);
  var half = UI._envArtBackground(Game.state.lanes[2]._env.ai);
  UI._artSizeFor = realSize; UI.getCardArtPath = realPath;
  check('a full-lane environment is framed to cover the lane', /\/cover no-repeat/.test(full), full);
  check('…while a half keeps its gallery zoom', /\/140% no-repeat/.test(half), half);
})();

// ---- 13. the stylesheet (cascade facts the shim cannot compute) ---------------
var tick = ruleBody('.ev-tick');
check('the tick is a 3px bar', !!tick && /width:\s*3px/.test(tick));
check('the tick is the only thing carrying type colour', !!tick && /background:\s*rgb\(var\(--ev-rgb\)\)/.test(tick));
var name = ruleBody('.ev-name');
check('names are sentence case, never uppercase', !!name && /text-transform:\s*none/.test(name) && !/uppercase/.test(name));
check('the name is 12px #dbe7ee', !!name && /12px/.test(name) && /#dbe7ee/i.test(name));
var line = ruleBody('.ev-line');
check('a collapsed row is 34px', !!line && /height:\s*34px/.test(line));
var perm = ruleBody('.ev-clock.is-perm');
check('PERMANENT is grey, not a type colour', !!perm && !/--ev-rgb/.test(perm), perm || 'rule missing');
check('the rail cannot eat a click meant for the board',
      /#event-rail \* \{ pointer-events: none; \}/.test(BARE) && /#event-rail \.ev-row\.is-door \{ pointer-events: auto/.test(BARE));
var colPanel = allRuleBodies('#right-col > .cog-panel').join(' ');
check('the picture is FIRST in the column', !!colPanel && /order:\s*0/.test(colPanel));
check('the column itself is a layout, not a surface', /#right-col \{[^}]*pointer-events: none/.test(BARE));
var colRule = ruleBody('#right-col');
check('the column is bound to the board band, not the viewport',
      !!colRule && /--decision-top/.test(colRule) && /--decision-bottom/.test(colRule));
check('the tracker is laid out, not positioned', /#right-col > \.shadow-tracker \{[^}]*position: static/.test(BARE));

print('event-rail: ' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) { print('Failures:'); fails.forEach(function (f) { print('  - ' + f); }); }
if (known.length) { print('Known shipped bugs (reported, not fixed by this suite):'); known.forEach(function (f) { print('  * ' + f); }); }
