// ============================================================
// A CROP EDIT CHANGES EVERY VAR EXCEPT THE ONE THE CACHE COMPARES.
//
//   jsc sim/portrait-refresh.js
//
// Owner: "so n hnad mr freeze hea dis cut off but in daraft and codex its not
// this needs to be fixed, how are they different?"
//
// They were different because the hand and the board were showing a STALE art
// node. `_preserveCardArt` is the art-flicker fix: when a render rebuilds a
// card's subtree it keeps the already-composited `.card-portrait` alive instead
// of letting replaceChildren destroy it, so the decoded bitmap never blinks.
// Its guard is the art URL — and the URL is exactly the one thing a crop edit
// does NOT change. `_artFocalCard` stamps the crop as --portrait-pos, the zoom
// as --portrait-size and the brightness normalisation as --art-grade, all
// beside a byte-identical --portrait-bg. So the guard matched, the old node
// survived carrying the old crop, and only surfaces that build a card FRESH
// every time (draft, codex, tap, gallery) ever showed the new one.
//
// Measured in the browser with the focal repointed live and a re-render forced:
//
//     UI._artFocalCard('Mr. Freeze') ....... ';--portrait-pos:50% 100%;...'
//     live hand   .card-portrait ........... '--portrait-pos: 50% 0%'   STALE
//     live board  .card-portrait ........... '--portrait-pos: 50% 0%'   STALE
//
// Re-swapping the node would fix the crop and bring the blink straight back, so
// the fix syncs the three vars ONTO the live node. This suite runs the real
// method against a stub DOM rather than grepping it — a text assertion here
// would match the comment prose above, which is the trap art-accent.js hit.
// See [[art-flicker-fix]] and [[fix-the-source-not-the-surface]].
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

var UISRC = read('ui.js');

// Balance braces so a nested arrow body cannot end the slice early.
function methodBody(name) {
  var open = UISRC.indexOf('\n  ' + name + '(');
  if (open < 0) return '';
  var brace = UISRC.indexOf('{', open);
  if (brace < 0) return '';
  var depth = 0, i = brace;
  for (; i < UISRC.length; i++) {
    var ch = UISRC.charAt(i);
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  return UISRC.slice(brace, i + 1);
}
function decomment(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); })
          .replace(/\/\/[^\n]*/g, '');
}

// ---- the real method, pulled out of ui.js and made runnable ----
var PRESERVE_SRC = methodBody('_preserveCardArt');

// The shipped list of art vars, read from source so this suite tracks the real
// one instead of a copy that can drift away from it.
var LIST_SRC = (UISRC.match(/_PORTRAIT_ART_VARS:\s*\[([^\]]*)\]/) || [])[1] || '';
var ART_VARS = LIST_SRC
  ? LIST_SRC.split(',').map(function (s) { return s.trim().replace(/^['"]|['"]$/g, ''); })
            .filter(function (s) { return s.length; })
  : [];

var HOST = {
  _PORTRAIT_ART_VARS: ART_VARS,
  _preserveCardArt: new Function('cached', 'fresh',
    PRESERVE_SRC.slice(PRESERVE_SRC.indexOf('{') + 1, PRESERVE_SRC.lastIndexOf('}')))
};

// ---- the smallest DOM the method actually touches ----
function styleOf(vars) {
  var m = {};
  var api = {
    getPropertyValue: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : ''; },
    setProperty: function (k, v) { m[k] = String(v); },
    removeProperty: function (k) { delete m[k]; },
    _keys: function () { return Object.keys(m); }
  };
  if (vars) Object.keys(vars).forEach(function (k) { api.setProperty(k, vars[k]); });
  return api;
}
function node(className, vars) {
  var e = {
    className: className,
    style: styleOf(vars),
    childNodes: [],
    querySelector: function (sel) {
      for (var i = 0; i < e.childNodes.length; i++) {
        if (e.childNodes[i].className === 'card-portrait') return e.childNodes[i];
      }
      return null;
    },
    replaceChildren: function () { e.childNodes = Array.prototype.slice.call(arguments); },
    replaceChild: function (nu, old) {
      for (var i = 0; i < e.childNodes.length; i++) if (e.childNodes[i] === old) e.childNodes[i] = nu;
    }
  };
  return e;
}
// A card whose only child is its portrait.
function card(portraitVars) {
  var c = node('card', null);
  var p = node('card-portrait', portraitVars);
  c.childNodes = [p];
  return { el: c, portrait: p };
}

var URL_A = "url('audio/cards/art/Mr.%20Freeze.png?v=99')";
var URL_B = "url('audio/cards/art/Mr.%20Freeze%202.png?v=99')";

t('PR-1 the flicker fix is still here and still keyed on the art URL', function () {
  eq('_preserveCardArt found', PRESERVE_SRC.length > 100, true);
  var body = decomment(PRESERVE_SRC);
  eq('still guards on --portrait-bg', body.indexOf('--portrait-bg') > 0, true);
  eq('still keeps the old node alive', /fresh\.replaceChild\(oldP,\s*newP\)/.test(body), true);
});

t('PR-2 a crop edit reaches the live node (the reported bug)', function () {
  // Same art, new focal — exactly what publishing a gallery crop produces.
  var cached = card({ '--portrait-bg': URL_A, '--portrait-pos': '50% 0%' });
  var fresh  = card({ '--portrait-bg': URL_A, '--portrait-pos': '50% 100%' });
  HOST._preserveCardArt(cached.el, fresh.el);
  eq('the composited node is still the one that survives',
     fresh.el.childNodes[0] === cached.portrait, true);
  eq('and it now carries the NEW crop',
     cached.portrait.style.getPropertyValue('--portrait-pos'), '50% 100%');
});

t('PR-3 zoom and grade travel with the crop', function () {
  var cached = card({ '--portrait-bg': URL_A, '--portrait-pos': '50% 0%',
                      '--portrait-size': '95% auto', '--art-grade': '0.84' });
  var fresh  = card({ '--portrait-bg': URL_A, '--portrait-pos': '50% 40%',
                      '--portrait-size': '120% auto', '--art-grade': '1.12' });
  HOST._preserveCardArt(cached.el, fresh.el);
  eq('focal', cached.portrait.style.getPropertyValue('--portrait-pos'), '50% 40%');
  eq('zoom',  cached.portrait.style.getPropertyValue('--portrait-size'), '120% auto');
  eq('grade', cached.portrait.style.getPropertyValue('--art-grade'), '1.12');
});

t('PR-4 a var that goes back to default is REMOVED, not left behind', function () {
  // Zoom reset to cover / grade reset to 1 make _artFocalCard emit nothing at
  // all for them. Setting-only would strand the old value forever.
  var cached = card({ '--portrait-bg': URL_A, '--portrait-size': '140% auto', '--art-grade': '1.3' });
  var fresh  = card({ '--portrait-bg': URL_A });
  HOST._preserveCardArt(cached.el, fresh.el);
  eq('zoom cleared',  cached.portrait.style.getPropertyValue('--portrait-size'), '');
  eq('grade cleared', cached.portrait.style.getPropertyValue('--art-grade'), '');
});

t('PR-5 a real art swap still replaces the node outright', function () {
  // The variant changed, so the bitmap has to be re-decoded anyway — the
  // preserve path must NOT keep the old node here.
  var cached = card({ '--portrait-bg': URL_A, '--portrait-pos': '50% 0%' });
  var fresh  = card({ '--portrait-bg': URL_B, '--portrait-pos': '50% 60%' });
  HOST._preserveCardArt(cached.el, fresh.el);
  eq('the fresh node is the one kept', fresh.el.childNodes[0] === fresh.portrait, true);
  eq('with its own art', fresh.portrait.style.getPropertyValue('--portrait-bg'), URL_B);
});

t('PR-6 the sync list covers every var _artFocalCard stamps', function () {
  // Self-maintaining: add a fourth var to the canonical fragment builder and
  // this fails until the preserve path syncs it too. That coupling is the whole
  // bug — the two lists silently disagreed.
  var builder = decomment(methodBody('_artFocalCard'));
  var stamped = {};
  var re = /';--([a-zA-Z-]+):'/g, m;
  while ((m = re.exec(builder))) stamped[m[1]] = true;
  var want = Object.keys(stamped).map(function (n) { return '--' + n; }).sort();
  eq('_artFocalCard still stamps some vars', want.length > 0, true);
  eq('every stamped var is synced onto the live node',
     want.filter(function (v) { return ART_VARS.indexOf(v) >= 0; }).join(','), want.join(','));
});

t('PR-7 the fit loop\'s imperative sizing on the live node survives', function () {
  // The live node also carries height / aspect-ratio written by the
  // measure-then-apply fit loop, which `fresh` has never had. A wholesale style
  // copy would wipe those and the portrait would jump on every render.
  var cached = card({ '--portrait-bg': URL_A, '--portrait-pos': '50% 0%' });
  cached.portrait.style.setProperty('height', '139px');
  cached.portrait.style.setProperty('aspect-ratio', 'auto');
  var fresh = card({ '--portrait-bg': URL_A, '--portrait-pos': '50% 100%' });
  HOST._preserveCardArt(cached.el, fresh.el);
  eq('height kept',       cached.portrait.style.getPropertyValue('height'), '139px');
  eq('aspect-ratio kept', cached.portrait.style.getPropertyValue('aspect-ratio'), 'auto');
  eq('crop still updated', cached.portrait.style.getPropertyValue('--portrait-pos'), '50% 100%');
});

t('PR-8 the card snapshot carries the art revision', function () {
  // GATE 1. Both card caches compare `_cardVisualSnapshot`, and a crop lives in
  // no card field — so without this the hand and board reuse their element
  // whole and the transplant that PR-2 pins never even runs.
  var snap = decomment(methodBody('_cardVisualSnapshot'));
  eq('_cardVisualSnapshot found', snap.length > 200, true);
  eq('the art revision rides the snapshot', /ar:\s*this\._artRev/.test(snap), true);
});

t('PR-9 every art mutator bumps that revision', function () {
  // Self-maintaining: find every method that PERSISTS an art preference and
  // require it to bump. A new gallery control that forgets the bump fails here
  // rather than shipping as another surface that silently disagrees.
  var KEYS = ['artFocal_', 'artZoom_', 'artOrder', 'cardArtSelections', 'deletedArt'];
  // _gallerySave re-commits maps that _setArtFocal/_setArtZoom already bumped
  // for; nothing changes there, so it is the one documented exception.
  var ALLOW = ['_gallerySave'];
  // Index every top-level method so a hit can be attributed to its owner.
  var methods = [];
  var re = /\n  ([_a-zA-Z][_a-zA-Z0-9]*)\(/g, m;
  while ((m = re.exec(UISRC))) methods.push({ name: m[1], at: m.index });
  function ownerOf(idx) {
    var best = null;
    for (var i = 0; i < methods.length; i++) {
      if (methods[i].at <= idx && (!best || methods[i].at > best.at)) best = methods[i];
    }
    return best ? best.name : '(none)';
  }
  var offenders = [], checked = 0;
  var pre = /_persistSet\('([^']+)'/g, pm;
  while ((pm = pre.exec(UISRC))) {
    var key = pm[1];
    var isArt = KEYS.some(function (k) { return key.indexOf(k) === 0; });
    if (!isArt) continue;
    var owner = ownerOf(pm.index);
    if (ALLOW.indexOf(owner) >= 0) continue;
    checked++;
    var body = decomment(methodBody(owner));
    if (body.indexOf('_bumpArtRev') < 0) offenders.push(owner + " persists '" + key + "' without bumping");
  }
  eq('some art mutators were found to check', checked > 0, true);
  eq('none persist art without bumping', offenders.join(' | '), '');
});

t('PR-10 the portrait height is re-derived when the width moves without a render', function () {
  // The other half of the owner's report. _snapPortraits writes an inline
  // height from the portrait's width and blanks aspect-ratio, so once a resize
  // changes the card width without changing game state, nothing re-derives it
  // and `cover` crops. Measured 1307 -> 420 CSS px: hand card 106 -> 88 wide,
  // portrait height stuck at 139, aspect 0.762 -> 0.633, 17% clipped off the
  // sides. Draft/codex pin their height with !important and never showed it.
  var inst = decomment(methodBody('_installPortraitSnap'));
  eq('_installPortraitSnap exists', inst.length > 100, true);
  eq('it listens for resize', /addEventListener\('resize'/.test(inst), true);
  eq('and for orientationchange (a phone rotating is the resize that matters)',
     /addEventListener\('orientationchange'/.test(inst), true);
  eq('it re-runs the snap', inst.indexOf('_snapPortraits') > 0, true);
  // Two passes: the hand/board fits finish their width solve in their own rAF
  // (the hand in a setTimeout after that), so one frame reads a stale width.
  eq('a frame pass', /requestAnimationFrame/.test(inst), true);
  eq('and a trailing pass', /setTimeout/.test(inst), true);
});

t('PR-11 the snap install is NOT behind the hover gate', function () {
  // It was written next to the other resize handlers first. Those live inside
  // _installCombatForecast, which returns early unless the device has a fine
  // hover pointer — so the fix silently did nothing on touch, which is exactly
  // where an orientation change makes it matter most. Verified live: the
  // method was present in the served file and undefined on the UI object.
  var forecast = decomment(methodBody('_installCombatForecast'));
  eq('the hover gate is still there (that is why this case exists)',
     /hover: hover/.test(forecast), true);
  eq('the portrait snap is not installed inside it',
     forecast.indexOf('_snapPortraits') < 0, true);
  // ...and it IS called from the unconditional init cluster.
  var init = UISRC.indexOf('this._installPortraitSnap();');
  eq('installed from init', init > 0, true);
  var around = UISRC.slice(Math.max(0, init - 400), init);
  eq('beside the other unconditional installers',
     /this\.installNavSounds\(\)|this\.installCardSfx\(\)/.test(around), true);
});

// ---- run ----------------------------------------------------
__cases.forEach(function (c) {
  __caseFailed = false; __caseMsgs = [];
  try { c.fn(); } catch (e) {
    __caseFailed = true;
    __caseMsgs.push('threw: ' + (e && e.message ? e.message : String(e)));
  }
  if (__caseFailed) { __failed++; __failures.push({ name: c.name, msgs: __caseMsgs.slice(0, 5) }); }
  else __passed++;
});
print('portrait-refresh: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
