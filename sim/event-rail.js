// ============================================================
// ONE RAIL, EVERY EVENT TYPE.
//
//   jsc sim/event-rail.js
//
// Before this, the things an event does were announced in three shapes: an
// environment counted down on its own card, a collapsed lane showed a number
// under the lane, and the Cog Invasion had a permanently-open panel in the
// corner — the only event type with a surface of its own. Three grammars, and
// no single place answering "what is currently acting on this board".
//
// The rules pinned here are the ones a later pass would undo without knowing:
//   · the TICK is the ONLY thing carrying type colour (that is what lets a
//     rail of eight events read as one list instead of eight objects)
//   · names are sentence case (uppercase belongs to the rail's own labels)
//   · RED IS NOT A TYPE COLOUR — it means the opposing player everywhere else
//     in this game, so a hostile event is orange or purple, never red
// ============================================================

var CSS = read('style.css');
var BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
var UI  = read('ui.js');
// Comments in this file explain what was REMOVED by name, so a plain substring
// search finds the explanation and calls it the defect. Strip them first.
var UI_CODE = UI.replace(/^\s*\/\/.*$/gm, '');

var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
// Every rule for a selector, in order — a selector authored more than once
// (sizing in one block, layout in another) cannot be judged from just the last.
function allRuleBodies(sel) {
  var re = new RegExp('(^|[};])\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^{}]*)\\}', 'gm');
  var m, out = [];
  while ((m = re.exec(BARE))) out.push(m[2]);
  return out;
}
function ruleBody(sel) {
  var re = new RegExp('(^|[};])\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^{}]*)\\}', 'gm');
  var m, last = null;
  while ((m = re.exec(BARE))) last = m[2];
  return last;
}

// ---- the four type colours, and the one that is absent --------------------
var types = (UI.match(/_EVENT_TYPES:\s*\{[\s\S]*?\n  \},/) || [''])[0];
check('the rail declares exactly four types', /boss:/.test(types) && /modifier:/.test(types) &&
      /hazard:/.test(types) && /boon:/.test(types));
[['boss', '176, 97, 255'], ['modifier', '255, 209, 102'],
 ['hazard', '255, 122, 24'], ['boon', '38, 255, 156']].forEach(function (p) {
  check(p[0] + ' is ' + p[1], types.indexOf(p[1]) >= 0);
});
check('RED is not a type colour',
      !/255,\s*47,\s*69/.test(types) && !/#ff2f45/i.test(types),
      'red is the opposing player everywhere else — a hostile event is orange or purple');

// ---- the row grammar: three parts, no exceptions --------------------------
var tick = ruleBody('.ev-tick');
check('the tick is a 3px bar', !!tick && /width:\s*3px/.test(tick));
check('the tick is the only thing carrying type colour',
      !!tick && /background:\s*rgb\(var\(--ev-rgb\)\)/.test(tick));
var name = ruleBody('.ev-name');
check('names are sentence case, never uppercase',
      !!name && /text-transform:\s*none/.test(name) && !/uppercase/.test(name),
      'uppercase belongs to the rail\'s own labels; if the rows shout too, nothing is a heading');
check('the name is 12px #dbe7ee', !!name && /12px/.test(name) && /#dbe7ee/i.test(name));
var line = ruleBody('.ev-line');
check('a collapsed row is 34px', !!line && /height:\s*34px/.test(line));
var perm = ruleBody('.ev-clock.is-perm');
check('PERMANENT is grey, not a type colour',
      !!perm && !/--ev-rgb/.test(perm), perm || 'rule missing');

// ---- stacking rules --------------------------------------------------------
check('six rows max', /_EVENT_MAX_ROWS:\s*6/.test(UI));
check('past six collapse into "+N more"', /ev-more/.test(UI) && /\+\$\{hidden\} more/.test(UI));
check('one open at a time — the NEWEST opens',
      /const openId = model\.length \? model\[model\.length - 1\]\.id : null;/.test(UI),
      'the newest event is the one you have had least time to read');
check('an ended event is visible for one round, struck through',
      /_eventRailGone/.test(UI) && /round - g\.round\) < 1/.test(UI) &&
      /line-through/.test(BARE.slice(BARE.indexOf('.ev-gone'))));

// ---- no dead code, and no lost controls -----------------------------------
check('the boss set is fed from the REAL cog state',
      /const cog = s\._cog;/.test(UI_CODE) && !/_eventSpawnOf/.test(UI_CODE),
      'the first draft grouped by a `_eventSpawnOf` tag that nothing in the engine sets — ' +
      'dead code wearing the shape of a feature');
check('the cog panel still exists and is what the boss row opens',
      /_toggleCogPanel\(\)/.test(UI) && /_renderCogPanel/.test(UI),
      'the panel carries the event rules AND the send-a-card-at-a-VP action; ' +
      'deleting it for a tidier column would trade a real control for uniformity');
check('the panel no longer forces itself open every render',
      !/el\.style\.display = '';\s*\n\s*\/\/ Wire the "send a card"/.test(UI));
check('the rail cannot eat a click meant for the board',
      /#event-rail \* \{ pointer-events: none; \}/.test(BARE) &&
      /#event-rail \.ev-row\.is-door \{ pointer-events: auto/.test(BARE));

// ---- 7. one column on the right, and the picture is at the top ------------
// The VP panel, the rail and the Shadow tracker were each position:fixed with
// their own top and z-index, so they were only ever "not overlapping" by luck.
// When a VP arrived they stopped being lucky: measured, the panel ran y267-594
// and the rail y396-669 — straight through each other, with a portrait and a
// tooltip over both. (Owner: "look how messy that is on the right.")
check('both dock in one column, so overlap is impossible',
      /_rightColumn\(\)\.appendChild\(el\)/.test(UI) && /_rightColumn\(\)\.appendChild\(rail\)/.test(UI),
      'a panel that appends to document.body is positioning itself against the others by hand');
var colPanel = allRuleBodies('#right-col > .cog-panel').join(' ');
check('the picture is FIRST in the column',
      !!colPanel && /order:\s*0/.test(colPanel),
      'set by order, not DOM position — the rail mounts earlier in the render ' +
      'pipeline, so whichever happened to mount first would otherwise decide it');
check('the column itself is a layout, not a surface',
      /#right-col \{[^}]*pointer-events: none/.test(BARE));

// ---- 8. what is ALWAYS on screen is what you act on -----------------------
// The title and the four-line "how the invasion works" paragraph used to sit
// permanently over the board. Rules are reference, read once; status is what
// you act on. The rules moved behind the event tab.
check('the always-on panel carries no prose',
      !/cog-title">COG INVASION/.test(UI) && !/Four executives\. Each sends/.test(UI),
      'the invasion rules are still printed in the always-on panel');
check('but the VP is still reachable there',
      /class="cog-hit"/.test(UI),
      'the owner was emphatic that a VP must never sit off to the side unattackable');
check('and the rules are in the event tab instead',
      /how: 'Each executive sends its Cog out/.test(UI) && /ev-how/.test(UI));

// ---- 9. the column lives in the BOARD's band --------------------------------
// It ran top 58 to bottom 984 while the player bar starts at 707, so 277px of
// it — the last VP rows and the "next event" line — sat behind the HUD and the
// hand. --decision-top / --decision-bottom are published from the board
// section's own rect by the layout solver and are what the decision column
// already docks against; sharing them is what stops this column drifting out
// of step with the board the way a hand-picked offset would.
var colRule = ruleBody('#right-col');
check('the column is bound to the board band, not the viewport',
      !!colRule && /--decision-top/.test(colRule) && /--decision-bottom/.test(colRule),
      colRule ? colRule.replace(/\s+/g, ' ').trim().slice(0, 80) : 'no rule');

// ---- 10. the Shadow Man docks too ------------------------------------------
// It was the last right-hand panel still positioning itself — fixed,
// draggable, its own top. It could not collide today only because it never
// happened to be up at the same time as a VP. (Owner: "dock the shadowman in
// the event section with the tracker there.")
check('the tracker is a child of the column',
      /el\.className = 'shadow-tracker';[\s\S]{0,600}this\._rightColumn\(\)\.appendChild\(el\)/.test(UI),
      'the tracker still appends to document.body');
check('and it is laid out, not positioned',
      /#right-col > \.shadow-tracker \{[^}]*position: static/.test(BARE));

// EVERY panel re-parents on each render, not only at creation. An element
// built before the column existed keeps whatever parent it was born with —
// which is exactly what left the tracker loose on its first run after docking.
check('panels re-parent, so one built earlier cannot stay loose',
      (UI.match(/parentNode !== _c\) _c\.appendChild|parentNode !== _col\) _col\.appendChild/g) || []).length >= 3,
      'found ' + ((UI.match(/parentNode !== _c\) _c\.appendChild|parentNode !== _col\) _col\.appendChild/g) || []).length) +
      ' of the 3 right-hand panels re-parenting');

// ---- 11. a door opens ITS OWN panel ----------------------------------------
// Owner: "for leaderbords for shadow man that should be in the events tab that
// you can click on to view."
//
// The rail has two doors now — the Cog Invasion row and the Shadow Man row —
// and this is the seam where they went wrong. The row builder used to hand the
// consumer a STRING OF ATTRIBUTES (`onclick="UI._toggleShadowTracker()"`) but
// the consumer writes rows through innerHTML on an inner node and wires the
// row's handler as a PROPERTY, so it only ever read `def.door` as a yes/no and
// wired the Cog handler to every door. The Shadow Man row was a perfect button
// that opened the wrong panel. Nothing in the markup looked wrong, which is
// exactly why it needs a test: the builder and the consumer have to agree on
// what `door` IS.
// `const door =`, `def.door` and `doorExpanded` appear ONLY in the rail, so the
// whole file is a safe scope — and a scope that cannot silently shrink to
// nothing the way a brace-counting slice can, which would turn every check
// below into a free pass.
var railFn = UI_CODE;
check('the rail renderer was found', /_renderEventRail\(/.test(railFn));

// The builder must publish a KIND, never markup. An attribute string here is
// the defect itself.
var doorExpr = (railFn.match(/const door = [^;]*;/) || [''])[0];
check('a door names which panel it opens, it does not carry markup',
      !!doorExpr && !/onclick=|role=|tabindex=/.test(doorExpr),
      doorExpr.replace(/\s+/g, ' ').slice(0, 120) || 'no door expression');

// Every kind the builder can produce must have a branch in the consumer, and
// every branch must name a real UI method. A kind with no branch silently
// falls through to whatever the last `else` happens to be.
var kinds = (doorExpr.match(/'([a-z]+)'/g) || []).map(function (q) { return q.slice(1, -1); });
check('the builder produces exactly the two door kinds',
      kinds.length === 2 && kinds.indexOf('cog') >= 0 && kinds.indexOf('shadow') >= 0,
      'kinds: ' + kinds.join(', '));
var wiring = (railFn.match(/if \(def\.door\)[\s\S]*?el\.onkeydown = null;/) || [''])[0];
check('the consumer forks on the door kind, it does not wire one handler to all',
      /def\.door === '/.test(wiring),
      'the consumer still treats every door as the same panel');
check('the shadow door opens the shadow tracker',
      /def\.door === 'shadow'[\s\S]{0,80}_toggleShadowTracker/.test(wiring));
check('and the other door still opens the Cog panel',
      /_toggleCogPanel/.test(wiring));
kinds.forEach(function (k) {
  check("the '" + k + "' door reaches a handler",
        k === 'shadow' ? /_toggleShadowTracker/.test(wiring) : /_toggleCogPanel/.test(wiring));
});

// Rows are REUSED across renders (that is the whole point of the diff), so a
// row whose event changes from one door to the other must re-wire. Keyed on
// the kind, not on "does it have a role yet" — the old guard was
// `!el.hasAttribute('role')`, which is true exactly once per element and then
// never again, so a row that changed door kept the first panel forever.
check('a reused row re-wires when its door kind changes',
      /el\.dataset\.door !== def\.door/.test(wiring),
      'the handler is still wired once per element and never revisited');
check('and a row that loses its door is fully unwired',
      /delete el\.dataset\.door/.test(wiring) && /el\.onclick = null/.test(wiring) &&
      /el\.onkeydown = null/.test(wiring));

// A door is a button, so it answers the keyboard as well as the mouse.
check('a door answers Enter and Space',
      /ev\.key === 'Enter'/.test(wiring) && /ev\.key === ' '/.test(wiring));

// The scoreboard is CLOSED until asked for. It used to stand in the gutter for
// the whole challenge — 178px of a 452px column, permanently, for four numbers
// you look at between rounds.
check('the tracker is closed until the row is clicked',
      /_shadowOpen: false/.test(UI_CODE) &&
      /if \(!live \|\| !this\._shadowOpen\)/.test(UI_CODE),
      'the tracker still draws for the whole challenge');
check('and the row says whether it is open',
      /doorExpanded:/.test(railFn) && /aria-expanded/.test(railFn),
      'a toggle with no aria-expanded is a button that never reports its state');

print('event-rail: ' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) { print('Failures:'); fails.forEach(function (f) { print('  - ' + f); }); }
