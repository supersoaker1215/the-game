// ============================================================
// EVERY BOARD STAT CHANGE POPS — the number moves, and you SEE it move.
//
//   jsc sim/stat-pop.js -- [--verbose]
//
// Owner: Marvel-Snap-quality feel — Snap punches the power number every time
// it changes. Ours has the punch (`_flipStatOrb` → .stat-changed + .stat-up /
// .stat-down: a 1.5x green spring up, a 1.32x red shake down, the digit
// counting over 380ms) but three things kept it off the screen:
//
//   1. THE HIT NEVER POPPED ON A HURT CARD. A board card below max HP carries
//      .card-damaged, whose idle HP pulse (`.card.card-damaged .stat-circle
//      .stat-hp`, 0,4,0) outranks `.stat-circle.stat-changed.stat-down`
//      (0,3,0) at High — and at the default tier (fx-lean) and on every touch
//      device `.card-damaged .stat-hp { animation: none !important }` removed
//      it outright. The first hit popped; every hit after it was silent.
//      Measured with the resolver below (damaged card, HP orb mid-pop):
//        before  High: hpDamagedPulse   Normal: none   touch: none
//        after   High: statPopDown      Normal: statPopDown   touch: statPopDown
//      The idle pulse itself is unchanged: High keeps it, Normal/touch stay off.
//   2. ATK POPS MISSED THE NUMBER ON THE ORB. animateStatChanges compared raw
//      card.attack; the orb prints the boosted value (Critical x2, Droideka
//      overcharge, Yoda's combined force). Those changes never popped.
//   3. A SNAPSHOT-BUSTING RE-RENDER INSIDE THE 600ms POP rebuilt the card's
//      children and threw the popping orb away mid-animation (same class as
//      the lunge / art-flicker bugs). The live orb is now kept when it already
//      shows the value the fresh render would print.
//
// The sim cannot lay out or paint, so 1 resolves the cascade (with @media
// modelled per environment) and 2-3 RUN the real ui.js against shim-dom.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var __i = 0; __i < argv.length; __i++) if (argv[__i] === '--verbose') VERBOSE = true;

var pass = 0, fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; if (VERBOSE) print('  ok  ' + name + (detail ? ' — ' + detail : '')); }
  else fails.push(name + (detail ? ' — ' + detail : ''));
}

// ============================================================
// 1. THE CASCADE — which `animation` a stat orb actually resolves to
// ============================================================
var CSS = read('style.css').replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });

// Walk the sheet keeping the @media stack, so a rule inside
// `@media (pointer: coarse)` only applies in the touch environment.
var RULES = (function () {
  var out = [], i = 0, n = CSS.length, order = 0;
  function block(from, media) {
    var k = from;
    while (k < n) {
      while (k < n && /\s/.test(CSS[k])) k++;
      if (k >= n) return k;
      if (CSS[k] === '}') return k + 1;
      var open = CSS.indexOf('{', k), semi = CSS.indexOf(';', k);
      if (CSS[k] === '@' && semi >= 0 && (open < 0 || semi < open)) { k = semi + 1; continue; }  // @import etc.
      if (open < 0) return n;
      var prelude = CSS.slice(k, open).replace(/\s+/g, ' ').trim();
      if (/^@media/i.test(prelude)) { k = block(open + 1, media.concat([prelude.slice(6).trim()])); continue; }
      if (/^@(supports|layer|container)/i.test(prelude)) { k = block(open + 1, media); continue; }
      // a plain rule, or an at-rule whose body we skip (@keyframes, @font-face)
      var depth = 0, j = open;
      for (; j < n; j++) { if (CSS[j] === '{') depth++; else if (CSS[j] === '}' && --depth === 0) break; }
      if (prelude.charAt(0) !== '@') out.push({ prelude: prelude, body: CSS.slice(open + 1, j), media: media, at: open });
      k = j + 1;
    }
    return k;
  }
  block(0, []);
  return out;
})();

function mediaOk(cond, env) {
  return cond.split(/,(?![^()]*\))/).some(function (alt) {
    alt = alt.trim().replace(/^only\s+/, '');
    var neg = /^not\s+/.test(alt); alt = alt.replace(/^not\s+/, '');
    var r = alt.split(/\s+and\s+/).every(function (f) {
      f = f.trim();
      if (f === 'screen' || f === 'all') return true;
      if (f === 'print') return false;
      var m = /^\(\s*([\w-]+)\s*(?::\s*([^)]+))?\)$/.exec(f);
      if (!m) return false;
      var k = m[1], v = (m[2] || '').trim();
      if (k === 'max-width') return env.width <= parseFloat(v);
      if (k === 'min-width') return env.width >= parseFloat(v);
      if (k === 'max-height') return env.height <= parseFloat(v);
      if (k === 'min-height') return env.height >= parseFloat(v);
      if (k === 'pointer' || k === 'any-pointer') return v === env.pointer;
      if (k === 'hover' || k === 'any-hover') return v === env.hover;
      if (k === 'prefers-reduced-motion') return v === (env.reduced ? 'reduce' : 'no-preference');
      if (k === 'orientation') return v === (env.width > env.height ? 'landscape' : 'portrait');
      return false;
    });
    return neg ? !r : r;
  });
}

function splitTop(s) {            // split a selector list on top-level commas
  var parts = [], depth = 0, cur = '';
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts.map(function (p) { return p.trim(); }).filter(Boolean);
}
function specificity(sel) {
  var a = 0, b = 0, c = 0, s = sel.replace(/::[\w-]+/g, '');
  // innermost-first so nested :is(:not()) collapse correctly
  var guard = 0;
  while (/:(not|is|has|where)\(([^()]*)\)/.test(s) && guard++ < 50) {
    s = s.replace(/:(not|is|has|where)\(([^()]*)\)/g, function (m, kind, inner) {
      if (kind === 'where') return ' ';
      var best = [0, 0, 0];
      splitTop(inner).forEach(function (p) {
        var sp = specificity(p);
        if (sp[0] > best[0] || (sp[0] === best[0] && (sp[1] > best[1] || (sp[1] === best[1] && sp[2] > best[2])))) best = sp;
      });
      a += best[0]; b += best[1]; c += best[2];
      return ' ';
    });
  }
  a += (s.match(/#[\w-]+/g) || []).length;
  b += (s.match(/\.[\w-]+/g) || []).length + (s.match(/\[[^\]]*\]/g) || []).length
     + (s.match(/:[\w-]+/g) || []).length;
  c += (s.replace(/[#.:][\w-]+/g, ' ').replace(/\[[^\]]*\]/g, ' ').match(/\b[a-zA-Z][\w-]*\b/g) || []).length;
  return [a, b, c];
}

// An element is { tag, classes } and has an ancestor chain (nearest first).
// Compounds support tag, .class, :not/:is/:where(list) and :has (treated as
// unmatched unless the element model says otherwise — the orb has no children
// that any rule here inspects). Any other pseudo-class = the resting state
// does not match it.
function compoundMatches(comp, el) {
  if (!comp) return false;
  var rest = comp, ok = true, guard = 0;
  while (/:(not|is|where|has)\(/.test(rest) && guard++ < 50) {
    var m = /:(not|is|where|has)\(/.exec(rest), start = m.index, depth = 0, j = start + m[0].length - 1;
    for (; j < rest.length; j++) { if (rest[j] === '(') depth++; else if (rest[j] === ')' && --depth === 0) break; }
    var inner = rest.slice(start + m[0].length, j), kind = m[1];
    var any = splitTop(inner).some(function (p) { return selectorMatches(p, el); });
    if (kind === 'not' && any) ok = false;
    if ((kind === 'is' || kind === 'where') && !any) ok = false;
    if (kind === 'has') ok = false;
    rest = rest.slice(0, start) + rest.slice(j + 1);
  }
  if (!ok) return false;
  if (/::/.test(rest) || /:[\w-]/.test(rest) || /\[/.test(rest)) return false;
  var tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag && tag[0].toLowerCase() !== el.tag) return false;
  if (/^\*/.test(rest)) rest = rest.slice(1);
  var names = (rest.match(/\.[\w-]+/g) || []).map(function (x) { return x.slice(1); });
  if (!tag && !names.length && !/^\*?$/.test(rest.replace(/\.[\w-]+/g, ''))) return false;
  return names.every(function (x) { return el.classes.indexOf(x) >= 0; });
}
// selector against el (whose .chain is its ancestors, nearest first)
function selectorMatches(sel, el) {
  var toks = [], cur = '', depth = 0;
  sel = sel.trim();
  for (var i = 0; i < sel.length; i++) {
    var ch = sel[i];
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~')) {
      if (cur) { toks.push(cur); cur = ''; }
      if (ch !== ' ') toks.push(ch);
      continue;
    }
    cur += ch;
  }
  if (cur) toks.push(cur);
  if (!toks.length) return false;
  if (!compoundMatches(toks[toks.length - 1], el)) return false;
  var chain = el.chain || [], ci = 0;
  for (var t = toks.length - 2; t >= 0; t--) {
    var tk = toks[t];
    if (tk === '+' || tk === '~') return false;         // siblings: not modelled
    if (tk === '>') {
      t--; if (t < 0) return false;
      if (ci >= chain.length || !compoundMatches(toks[t], chain[ci])) return false;
      ci++;
      continue;
    }
    var found = false;
    for (; ci < chain.length; ci++) { if (compoundMatches(tk, chain[ci])) { found = true; ci++; break; } }
    if (!found) return false;
  }
  return true;
}

function declValue(body, prop) {
  var re = new RegExp('(?:^|[;\\s])' + prop + '\\s*:\\s*([^;]*)', 'g'), m, last = null;
  while ((m = re.exec(body))) last = m[1].trim();
  return last;
}
// Resolve the winning `animation` shorthand for el in env.
function resolveAnimation(el, env) {
  var best = null;
  RULES.forEach(function (r) {
    if (!r.media.every(function (c) { return mediaOk(c, env); })) return;
    var v = declValue(r.body, 'animation');
    if (v == null) return;
    var imp = /!important/.test(v);
    splitTop(r.prelude).forEach(function (sel) {
      if (!selectorMatches(sel, el)) return;
      var d = { sel: sel, value: v.replace(/\s*!important/, ''), imp: imp, spec: specificity(sel), at: r.at };
      if (!best) { best = d; return; }
      if (d.imp !== best.imp) { if (d.imp) best = d; return; }
      for (var i = 0; i < 3; i++) if (d.spec[i] !== best.spec[i]) { if (d.spec[i] > best.spec[i]) best = d; return; }
      if (d.at > best.at) best = d;
    });
  });
  return best;
}
function animName(w) { return w ? (w.value.split(/\s+/)[0] || '') : '(none declared)'; }
function lineAt(idx) { return CSS.slice(0, idx).split('\n').length; }

var ENVS = {
  'High (desktop)':   { body: [],                  width: 1440, height: 900, pointer: 'fine',   hover: 'hover', reduced: false },
  'Normal (fx-lean)': { body: ['fx-lean'],         width: 1440, height: 900, pointer: 'fine',   hover: 'hover', reduced: false },
  'Reduced (low-fx)': { body: ['fx-lean', 'low-fx'], width: 1440, height: 900, pointer: 'fine', hover: 'hover', reduced: false },
  'touch phone, High': { body: [],                width: 390,  height: 844, pointer: 'coarse', hover: 'none',  reduced: false },
  'touch phone':      { body: ['fx-lean'],         width: 390,  height: 844, pointer: 'coarse', hover: 'none',  reduced: false },
};
function orb(env, cardClasses, orbClasses) {
  return {
    tag: 'span', classes: ['stat-circle'].concat(orbClasses),
    chain: [
      { tag: 'div', classes: ['card'].concat(cardClasses) },
      { tag: 'div', classes: ['card-slot'] },
      { tag: 'div', classes: ['lane'] },
      { tag: 'div', classes: ['board'] },
      { tag: 'div', classes: ['game-area'] },
      { tag: 'body', classes: env.body },
      { tag: 'html', classes: [] },
    ]
  };
}

print('--- stat-pop: what each stat orb resolves to');
Object.keys(ENVS).forEach(function (envName) {
  var env = ENVS[envName];
  [
    { what: 'damaged card, HP hit',          card: ['card-damaged'], orb: ['stat-hp', 'stat-changed', 'stat-down'], want: 'statPopDown' },
    { what: 'damaged card, HP heal',         card: ['card-damaged'], orb: ['stat-hp', 'stat-changed', 'stat-up'],   want: 'statPopUp' },
    { what: 'damaged card, ATK debuff',      card: ['card-damaged'], orb: ['stat-atk', 'stat-changed', 'stat-down'], want: 'statPopDown' },
    { what: 'healthy card, HP hit',          card: [],               orb: ['stat-hp', 'stat-changed', 'stat-down'], want: 'statPopDown' },
    { what: 'healthy card, ATK buff',        card: [],               orb: ['stat-atk', 'stat-changed', 'stat-up'],  want: 'statPopUp' },
    { what: 'previewed HP target, HP hit',   card: ['preview-target-hp', 'card-damaged'], orb: ['stat-hp', 'stat-changed', 'stat-down'], want: 'statPopDown' },
  ].forEach(function (c) {
    var w = resolveAnimation(orb(env, c.card, c.orb), env);
    check(envName + ': ' + c.what + ' pops (' + c.want + ')', animName(w) === c.want,
      'resolves to `' + animName(w) + '` from style.css:' + (w ? lineAt(w.at) + ' ' + w.sel : '?'));
  });
  // The idle pulse is the owner's power decision: High breathes it, every
  // lean/touch tier keeps it stopped. Fixing the pop must not bring it back.
  var idle = resolveAnimation(orb(env, ['card-damaged'], ['stat-hp']), env);
  var wantIdle = (envName === 'High (desktop)') ? 'hpDamagedPulse' : 'none';   // touch: off at every tier
  check(envName + ': resting damaged HP orb idles as ' + wantIdle, animName(idle) === wantIdle,
    'resolves to `' + animName(idle) + '` from style.css:' + (idle ? lineAt(idle.at) + ' ' + idle.sel : '?'));
});
// Reduced motion keeps its blanket stop on the pop.
(function () {
  var env = { body: [], width: 1440, height: 900, pointer: 'fine', hover: 'hover', reduced: true };
  var w = resolveAnimation(orb(env, ['card-damaged'], ['stat-hp', 'stat-changed', 'stat-down']), env);
  check('prefers-reduced-motion: the pop stays off', animName(w) === 'none', animName(w));
})();

// ============================================================
// 2. ATK POPS COMPARE THE NUMBER THE ORB PRINTS
// ============================================================
function fresh() {
  Game.init();
  Game.seedMatch(0x57A7);
  Game.state.mode = { deck: 'classic', players: '1v1' };
  Game.state.phase = 'player-cards';
  Game.state.round = 3;
  Game.state.firstPlayer = 'player';
  Game.state.activePlayer = 'player';
  Game.history = [];
  for (var i = 0; i < Game.LANE_COUNT; i++) { Game.state.lanes[i].player = null; Game.state.lanes[i].ai = null; }
}
function inst(name, side) {
  return Game.createCardInstance(CARD_DEFS.find(function (c) { return c.name === name; }), side || 'player');
}
var flips = [], realFlip = UI._flipStatOrb;
UI._flipStatOrb = function (id, which, delta) { flips.push({ id: id, which: which, delta: delta }); };

fresh();
var thor = inst('Thor');
Game.state.lanes[1].player = thor;
UI._lastCardStats = new Map();
UI.animateStatChanges();                         // baseline
flips = [];
var printedBefore = UI.makeCardEl(thor, false, 'ally').querySelector('.stat-atk').textContent.trim();
thor._criticalThisRound = true;                  // Han Solo's Critical: x2 this round
var printedAfter = UI.makeCardEl(thor, false, 'ally').querySelector('.stat-atk').textContent.trim();
UI.animateStatChanges();
var atkFlip = flips.filter(function (f) { return f.which === 'atk'; })[0];
check('the orb really prints the boosted ATK (premise)', printedAfter === String(thor.attack * 2),
  printedBefore + ' -> ' + printedAfter);
check('a round-scoped ATK boost pops the ATK orb', !!atkFlip, JSON.stringify(flips));
check('the pop counts by the delta the ORB shows', !!atkFlip && atkFlip.delta === (+printedAfter - +printedBefore),
  atkFlip ? 'delta ' + atkFlip.delta + ', orb moved ' + (+printedAfter - +printedBefore) : 'no flip');
flips = [];
UI.animateStatChanges();
check('no phantom re-pop on an unchanged render', flips.length === 0, JSON.stringify(flips));
thor._criticalThisRound = false;
UI.animateStatChanges();
var down = flips.filter(function (f) { return f.which === 'atk'; })[0];
check('the boost wearing off pops DOWN', !!down && down.delta < 0, JSON.stringify(flips));
// One formula: the comparison and the orb share a helper, neither re-derives it.
var UISRC = read('ui.js');
function methodBody(head) {
  var i = UISRC.indexOf('\n  ' + head); if (i < 0) return '';
  var j = UISRC.indexOf('{', i), depth = 0, k = j;
  for (; k < UISRC.length; k++) { if (UISRC[k] === '{') depth++; else if (UISRC[k] === '}' && --depth === 0) break; }
  return UISRC.slice(j, k + 1).replace(/\/\/[^\n]*/g, '');
}
var ase = methodBody('animateStatChanges(');
check('animateStatChanges reads the displayed ATK through UI._displayedAtk', /_displayedAtk\(/.test(ase));
check('animateStatChanges does not copy the boost formula', !/_criticalThisRound|_droidekaOvercharge|_yodaCombinedAtk/.test(ase));
check('the orb renderer uses the same helper', /_displayedAtk\(card, inHand\)/.test(methodBody('makeCardEl(')));
UI._flipStatOrb = realFlip;

// ============================================================
// 3. THE POP SURVIVES A SNAPSHOT-BUSTING RE-RENDER
// ============================================================
fresh();
var hulk = inst('Hulk');
Game.state.lanes[2].player = hulk;
UI._capturedBoardCardEls = null;
var el = UI.makeCardElCached(hulk, false, 'ally');           // first paint
hulk.currentHealth = Math.max(1, hulk.currentHealth - 2);    // a hit
UI._capturedBoardCardEls = new Map([[String(hulk.id), [el]]]);
el = UI.makeCardElCached(hulk, false, 'ally');
var hpOrb = el.querySelector('.stat-circle.stat-hp');
// what _flipStatOrb leaves on the orb mid-pop
hpOrb.classList.add('stat-changed', 'stat-down');
hpOrb.setAttribute('data-prev-stat', String(hulk.currentHealth));
// ...and a different change busts the snapshot inside the 600ms pop
hulk.armorValue = (hulk.armorValue | 0) + 1;
UI._capturedBoardCardEls = new Map([[String(hulk.id), [el]]]);
var el2 = UI.makeCardElCached(hulk, false, 'ally');
var orb2 = el2.querySelector('.stat-circle.stat-hp');
check('premise: the re-render reused the cached card', el2 === el);
check('the popping HP orb is the SAME node after the transplant', orb2 === hpOrb);
check('...still carrying its pop', !!orb2 && orb2.classList.contains('stat-changed') && orb2.classList.contains('stat-down'),
  orb2 ? orb2.className : 'no orb');
check('...and showing the right number', !!orb2 && orb2.textContent.trim() === String(hulk.currentHealth),
  orb2 ? orb2.textContent : '');
// A NEW value means a new pop: the fresh orb goes in, animateStatChanges pops it.
hulk.currentHealth = Math.max(1, hulk.currentHealth - 1);
UI._capturedBoardCardEls = new Map([[String(hulk.id), [el2]]]);
var el3 = UI.makeCardElCached(hulk, false, 'ally');
var orb3 = el3.querySelector('.stat-circle.stat-hp');
check('a changed value takes the fresh orb (it will pop on its own)', !!orb3 && orb3 !== hpOrb
  && orb3.textContent.trim() === String(hulk.currentHealth));
// A resting orb is never kept: nothing to protect, fresh classes win.
var atkOrb3 = el3.querySelector('.stat-circle.stat-atk');
check('a resting orb is rebuilt as before', !!atkOrb3 && !atkOrb3.classList.contains('stat-changed'));
UI._capturedBoardCardEls = null;

print('stat-pop: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('stat-pop failed');
