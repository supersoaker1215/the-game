// ============================================================
// STATUS CARDS STILL PLAY THEIR ONE-SHOTS
//
//   jsc sim/status-oneshots.js -- [--verbose]
//
// The bug: Normal (body.fx-lean) stops the idle status loops on the CARD with
// `animation: none !important`. An !important `animation` outranks every
// one-shot class, so a crazy / critical / stunned / frozen / feared /
// mind-controlled / burning card never lunged, never flashed on a hit, never
// knocked back and never landed. Measured in the browser before the fix:
// every one of those resolved to animationName `none`. Even at High the base
// loops tied-and-won against the later one-shots (statusGlowPulse ate the
// knockback and the landing; burning's !important pulse ate everything).
//
// The rule now: a status loop YIELDS while a one-shot is on the card, at every
// tier — `:where(:not(<one-shot>))`, so specificity is unchanged and nothing
// else in the cascade moves. The idle loops still stop at Normal (the owner's
// power call) — this checks that too.
//
// This RESOLVES THE CASCADE (importance → specificity → order, media-gated)
// for a modelled board card, rather than grepping, because a grep says the
// one-shot rule is there; only the cascade says it paints.
// ============================================================
var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

var CSS = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('')).replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) { pass++; if (VERBOSE) print('  ok  ' + name); } else fails.push(name + (detail ? ' — ' + detail : '')); }

// ---- 1. rules, with the at-rule conditions they sit under ------------------
var RULES = [];
var NL = []; for (var q = CSS.indexOf('\n'); q >= 0; q = CSS.indexOf('\n', q + 1)) NL.push(q);
function lineAt(pos) { var lo = 0, hi = NL.length; while (lo < hi) { var mid = (lo + hi) >> 1; if (NL[mid] < pos) lo = mid + 1; else hi = mid; } return lo + 1; }
(function parse() {
  var stack = [], i = 0, n = CSS.length, start = 0, order = 0;
  while (i < n) {
    var ch = CSS[i];
    if (ch === '"' || ch === "'") { var q = ch; i++; while (i < n && CSS[i] !== q) { if (CSS[i] === '\\') i++; i++; } i++; continue; }
    if (ch === '{') {
      var prelude = CSS.slice(start, i).trim();
      if (prelude.charAt(0) === '@') { stack.push(prelude); start = i + 1; i++; continue; }
      // a style rule: body runs to the matching }
      var depth = 1, j = i + 1;
      while (j < n && depth) { if (CSS[j] === '{') depth++; else if (CSS[j] === '}') depth--; j++; }
      var inKeyframes = stack.some(function (s) { return /^@(-webkit-)?keyframes/.test(s); });
      if (!inKeyframes) RULES.push({ prelude: prelude, body: CSS.slice(i + 1, j - 1), at: stack.slice(), order: order++,
                                     line: lineAt(i) });
      i = j; start = i; continue;
    }
    if (ch === '}') { stack.pop(); i++; start = i; continue; }
    if (ch === ';' && !stack.length) { start = i + 1; }
    i++;
  }
})();

// ---- 2. media evaluation for a context -------------------------------------
function mediaOk(text, ctx) {
  return text.split(',').some(function (q) {
    q = q.trim().replace(/^only\s+/, '').replace(/^screen\s+and\s+/, '').replace(/^screen$/, '').replace(/^all\s+and\s+/, '');
    if (!q) return true;
    var neg = /^not\s+/.test(q); if (neg) q = q.replace(/^not\s+(all\s+and\s+)?/, '');
    var ok = q.split(/\s+and\s+/).every(function (f) {
      var m = /^\(\s*([\w-]+)\s*(?::\s*([^)]+))?\)$/.exec(f.trim());
      if (!m) return false;
      var k = m[1], v = (m[2] || '').trim();
      if (k === 'pointer') return v === (ctx.coarse ? 'coarse' : 'fine');
      if (k === 'any-pointer') return v === (ctx.coarse ? 'coarse' : 'fine');
      if (k === 'hover' || k === 'any-hover') return v === (ctx.coarse ? 'none' : 'hover');
      if (k === 'max-width') return ctx.w <= parseFloat(v);
      if (k === 'min-width') return ctx.w >= parseFloat(v);
      if (k === 'max-height') return ctx.h <= parseFloat(v);
      if (k === 'min-height') return ctx.h >= parseFloat(v);
      if (k === 'orientation') return v === (ctx.w >= ctx.h ? 'landscape' : 'portrait');
      if (k === 'prefers-reduced-motion') return v === 'no-preference';
      if (k === 'prefers-color-scheme') return v === 'dark';
      return false;
    });
    return neg ? !ok : ok;
  });
}
function atOk(at, ctx) {
  return at.every(function (a) {
    var m;
    if ((m = /^@media\s+([\s\S]*)$/.exec(a))) return mediaOk(m[1], ctx);
    if (/^@supports/.test(a)) return true;
    return false;                                   // @container etc: not modelled → excluded
  });
}

// ---- 3. selector matching against a modelled element chain -----------------
// chain[k] = { tag, classes }, chain[last] is the subject.
function splitTop(s, sep) {            // split on `sep` chars at paren depth 0
  var out = [], d = 0, cur = '';
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if (c === '(') d++; else if (c === ')') d--;
    if (d === 0 && sep.indexOf(c) >= 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur); return out;
}
function compounds(sel) {              // → [{c:compound, comb:' '|'>'}] left to right
  var out = [], d = 0, cur = '', comb = ' ';
  sel = sel.trim();
  for (var i = 0; i < sel.length; i++) {
    var c = sel[i];
    if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') d--;
    if (d === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) {
      if (cur) { out.push({ c: cur, comb: comb }); cur = ''; comb = ' '; }
      if (c !== ' ') comb = c;
      continue;
    }
    cur += c;
  }
  if (cur) out.push({ c: cur, comb: comb });
  return out;
}
function simpleParts(compound) {       // tokens: tag, .cls, :pseudo(arg)
  var out = [], i = 0;
  var m = /^([a-zA-Z*][\w-]*)/.exec(compound);
  if (m) { out.push({ t: 'tag', v: m[1] }); i = m[1].length; }
  while (i < compound.length) {
    var c = compound[i];
    if (c === '.' || c === '#') {
      var mm = /^[.#][\w-]+/.exec(compound.slice(i)); if (!mm) { i++; continue; } out.push({ t: c === '.' ? 'cls' : 'id', v: mm[0].slice(1) }); i += mm[0].length; continue;
    }
    if (c === '[') { var e = compound.indexOf(']', i); if (e < 0) e = compound.length; out.push({ t: 'attr', v: compound.slice(i, e + 1) }); i = e + 1; continue; }
    if (c === ':') {
      var pe = /^::?[\w-]+/.exec(compound.slice(i)); if (!pe) { out.push({ t: 'attr', v: ':' }); i++; continue; } var name = pe[0]; i += name.length; var arg = null;
      if (compound[i] === '(') { var d = 1, j = i + 1; while (d && j <= compound.length) { if (compound[j] === '(') d++; else if (compound[j] === ')') d--; j++; } arg = compound.slice(i + 1, j - 1); i = j; }
      out.push({ t: name.charAt(1) === ':' ? 'pe' : 'pc', v: name.replace(/^::?/, ''), arg: arg }); continue;
    }
    i++;
  }
  return out;
}
function matchCompound(compound, chain, k) {
  var el = chain[k];
  return simpleParts(compound).every(function (p) {
    if (p.t === 'tag') return p.v === '*' || p.v === el.tag;
    if (p.t === 'cls') return el.classes.indexOf(p.v) >= 0;
    if (p.t === 'id' || p.t === 'attr' || p.t === 'pe') return false;
    if (p.v === 'not') return !splitTop(p.arg, ',').some(function (s) { return matchComplex(s, chain, k); });
    if (p.v === 'is' || p.v === 'where' || p.v === 'matches') return splitTop(p.arg, ',').some(function (s) { return matchComplex(s, chain, k); });
    return false;                                   // :hover/:has/:nth-*/… — resting, unmodelled → no
  });
}
function matchComplex(sel, chain, k) {
  var cs = compounds(sel);
  function go(ci, ek) {
    if (!matchCompound(cs[ci].c, chain, ek)) return false;
    if (ci === 0) return true;
    if (cs[ci].comb === '>') return ek > 0 && go(ci - 1, ek - 1);
    if (cs[ci].comb === ' ') { for (var a = ek - 1; a >= 0; a--) if (go(ci - 1, a)) return true; return false; }
    return false;                                   // siblings not modelled
  }
  return go(cs.length - 1, k);
}
function specificity(sel) {
  var a = 0, b = 0, c = 0;
  compounds(sel).forEach(function (cp) {
    simpleParts(cp.c).forEach(function (p) {
      if (p.t === 'id') a++;
      else if (p.t === 'cls' || p.t === 'attr') b++;
      else if (p.t === 'tag') { if (p.v !== '*') c++; }
      else if (p.t === 'pe') c++;
      else if (p.v === 'where') {}
      else if (p.v === 'not' || p.v === 'is' || p.v === 'has' || p.v === 'matches') {
        var best = [0, 0, 0];
        splitTop(p.arg, ',').forEach(function (s) { var sp = specificity(s); if (cmp(sp, best) > 0) best = sp; });
        a += best[0]; b += best[1]; c += best[2];
      } else b++;
    });
  });
  return [a, b, c];
}
function cmp(x, y) { for (var i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; }

// ---- 4. the winning animation name for an element ---------------------------
function lastDecl(body, re) {            // last `animation` / `animation-name` in a body
  var m, last = null; re.lastIndex = 0;
  while ((m = re.exec(body))) last = { prop: m[1], value: m[2].trim() };
  return last;
}
var DECL = /(?:^|[;{\s])(animation(?:-name)?)\s*:\s*([^;]+)/g;
// Index once: every selector that declares an animation, with the classes its
// subject compound REQUIRES (outside any parens) for a cheap pre-filter.
var CANDS = [];
RULES.forEach(function (r) {
  var d = lastDecl(r.body, DECL); if (!d) return;
  var imp = /!important/.test(d.value);
  splitTop(r.prelude, ',').forEach(function (sel) {
    sel = sel.replace(/\s+/g, ' ').trim(); if (!sel) return;
    var cs = compounds(sel), subj = cs[cs.length - 1].c;
    var need = simpleParts(subj).filter(function (p) { return p.t === 'cls'; }).map(function (p) { return p.v; });
    CANDS.push({ r: r, sel: sel, need: need, imp: imp, spec: specificity(sel), d: d });
  });
});
function winner(chain, ctx) {
  var best = null, k = chain.length - 1, cls = chain[k].classes;
  CANDS.forEach(function (c) {
    for (var i = 0; i < c.need.length; i++) if (cls.indexOf(c.need[i]) < 0) return;
    if (!atOk(c.r.at, ctx) || !matchComplex(c.sel, chain, k)) return;
    var cand = { imp: c.imp, spec: c.spec, order: c.r.order, value: c.d.value, prop: c.d.prop, line: c.r.line, sel: c.sel };
    if (!best || (cand.imp !== best.imp ? cand.imp : (cmp(cand.spec, best.spec) || (cand.order - best.order)) > 0)) best = cand;
  });
  return best;
}
function nameOf(w) {
  if (!w) return 'none';
  var v = w.value.replace(/!important/, '').trim();
  if (w.prop === 'animation-name') return v.split(',')[0].trim();
  if (/^none\b/.test(v)) return 'none';
  var KW = /^(infinite|linear|ease|ease-in|ease-out|ease-in-out|both|forwards|backwards|alternate|alternate-reverse|normal|reverse|running|paused|none|step-start|step-end)$/;
  var toks = splitTop(v, ',')[0].trim().split(/\s+(?![^(]*\))/);
  for (var i = 0; i < toks.length; i++) { var t = toks[i]; if (!KW.test(t) && !/^[\d.]+m?s$/.test(t) && !/^[\d.]+$/.test(t) && !/\(/.test(t)) return t; }
  return 'none';
}
function cardChain(body, cardClasses) {
  return [ { tag: 'html', classes: [] }, { tag: 'body', classes: body },
           { tag: 'div', classes: ['board'] }, { tag: 'div', classes: ['lane'] },
           { tag: 'div', classes: ['card-slot'] }, { tag: 'div', classes: cardClasses } ];
}

// ---- 5. the assertions -------------------------------------------------------
var STATUSES = ['crazy', 'critical', 'stunned', 'frozen', 'feared', 'mind-ctrl', 'burning'];
var SHOTS = [['combat-attacker'], ['combat-target'], ['hit-flash'], ['hit-flash', 'hit-flash-heavy'],
             ['hit-flash', 'hit-flash-lethal'], ['card-knockback'], ['card-landing'], ['card-enter'], ['combat-splash-hit']];
var CTX = { desktop: { coarse: false, w: 1400, h: 900 }, phone: { coarse: true, w: 390, h: 844 } };
var TIERS = { Normal: ['fx-lean'], High: [] };
Object.keys(CTX).forEach(function (cx) {
  Object.keys(TIERS).forEach(function (tier) {
    ['ally-card', 'enemy-card'].forEach(function (side) {
      SHOTS.forEach(function (shot) {
        var want = nameOf(winner(cardChain(TIERS[tier], ['card', side].concat(shot)), CTX[cx]));
        STATUSES.forEach(function (st) {
          var w = winner(cardChain(TIERS[tier], ['card', side, 'status-' + st].concat(shot)), CTX[cx]);
          var got = nameOf(w);
          check(cx + '/' + tier + ' ' + side + ' status-' + st + ' + ' + shot.join('.') + ' plays ' + want,
                got === want, 'resolves to `' + got + '` — style.css:' + (w && w.line) + ' `' + (w && w.sel) + '` wins');
        });
      });
    });
  });
});
// Sanity: the one-shots this file is about really do animate on a plain card,
// or every equality above would pass vacuously.
check('a plain card lunges at Normal (non-vacuous)',
      nameOf(winner(cardChain(['fx-lean'], ['card', 'enemy-card', 'combat-attacker']), CTX.desktop)) === 'cardLungeAttackerEnemy');
check('a plain card hit-flashes at Normal (non-vacuous)',
      nameOf(winner(cardChain(['fx-lean'], ['card', 'enemy-card', 'hit-flash']), CTX.desktop)) === 'hitFlash');

// The power decision stays: at Normal, a resting status card runs NO loop on
// the card (crazy's wobble rides the slot); at High the loops are still there.
STATUSES.forEach(function (st) {
  ['desktop', 'phone'].forEach(function (cx) {
    var idle = nameOf(winner(cardChain(['fx-lean'], ['card', 'enemy-card', 'status-' + st]), CTX[cx]));
    check(cx + '/Normal resting status-' + st + ' runs no card loop', idle === 'none', 'runs `' + idle + '`');
  });
  var hi = nameOf(winner(cardChain([], ['card', 'enemy-card', 'status-' + st]), CTX.desktop));
  check('desktop/High resting status-' + st + ' keeps its loop', hi !== 'none', 'runs `' + hi + '`');
});

print('status-oneshots: ' + pass + ' passed, ' + fails.length + ' failed');
fails.slice(0, VERBOSE ? 1e9 : 40).forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length > 40) print('  … and ' + (fails.length - 40) + ' more');
if (fails.length) throw new Error('status-oneshots failed');
