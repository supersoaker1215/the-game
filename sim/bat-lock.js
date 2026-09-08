// ============================================================
// A LOCKED CARD MUST NOT LOOK LIKE AN EXPENSIVE ONE.
//
//   jsc sim/bat-lock.js
//
// Owner: "can you put a bat symbol over the highest cost cards that cant be
// played in the opponents hand?"
//
// Batman locks the opponent's highest-cost AFFORDABLE card. Before this, the
// locked card and a card you simply could not pay for rendered identically —
// both `.unplayable`, both grey — and the only thing that told them apart was
// an `el.title`, which needs a hover and a fine pointer. On a phone the rule
// had no representation on screen at all.
//
// Three traps this pins, each of which cost a real measurement:
//
//   1. THE BRANCH. `batBlocked` was computed inside the `!hasPending` arm of
//      the hand renderer, so the instant anybody opened a prompt the marker's
//      input went away and the card fell back to looking merely expensive.
//      The affordability light is documented as "always-on" for exactly this
//      reason; the lock is the same kind of truth about the same card.
//
//   2. THE FILTER. `.card.unplayable` carries `filter: grayscale(.95)
//      brightness(.6)`, and `filter` applies to the element AND its
//      descendants as one group. A marker parented inside `.card` would be
//      greyed and dimmed by the very rule it exists to explain. It has to be
//      a SIBLING, which is why the mark hangs on `.hand-card-wrapper`.
//
//   3. THE ANIMATION FILL. The entrance was first written as
//      `.bat-lock { animation: batLockStamp ... both }`, whose keyframes end
//      `to { opacity: 1 }`. `fill-mode: both` keeps applying that after the
//      animation finishes, and animation values outrank every normal
//      declaration — so it silently ate the flip-dim rule below it no matter
//      how specific that rule was. Measured in-browser: opacity stayed 1 on a
//      flipped card with the animation on `.bat-lock`, and drops to 0.16 with
//      it on the inner `<svg>`. Same keyframes, different element, opposite
//      outcome. Nothing about the source LOOKS different.
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

function handOf(costs) {
  Game.init();
  Game.state.player.hand = costs.map(function (c, i) {
    return { id: 900 + i, name: 'Test ' + i, cost: c, baseCost: c, attack: 1, currentHealth: 1, maxHealth: 1, owner: 'player' };
  });
  return Game.state.player.hand;
}
function armLock(currency) {
  // Round 0 makes `batmanBlocked` falsy, and the engine reads a falsy start as
  // "no lock" — so the arming round has to be a real one.
  if (!Game.state.round) Game.state.round = 3;
  Game.state.player.currency = currency;
  Game.state.player.batmanBlocked = Game.state.round;
  Game.state.player.batmanBlockedUntil = Game.state.round;
  Game.state.player.batmanBlockedCostRound = -1;   // force a fresh snapshot
}
function blockedNames(hand) {
  return hand.filter(function (c) { return Game.isCardBatmanBlocked('player', c); })
             .map(function (c) { return c.cost; });
}

// ---- 1. the engine truth the marker draws --------------------------------
t('BL-1 the lock takes the highest cost you can actually AFFORD, not the highest in hand', function () {
  var hand = handOf([2, 5, 10]);
  armLock(5);
  eq('costs locked', JSON.stringify(blockedNames(hand)), JSON.stringify([5]));
});

t('BL-2 EVERY copy at the blocked cost is marked, not just the first', function () {
  var hand = handOf([4, 4, 4, 2]);
  armLock(6);
  eq('three 4s all locked', JSON.stringify(blockedNames(hand)), JSON.stringify([4, 4, 4]));
});

t('BL-3 nothing is marked when the lock is not live this round', function () {
  var hand = handOf([2, 3]);
  armLock(9);
  Game.state.player.batmanBlocked = Game.state.round + 5;
  Game.state.player.batmanBlockedUntil = Game.state.round + 5;
  eq('no marks', blockedNames(hand).length, 0);
});

t('BL-4 nothing is marked when you cannot afford anything', function () {
  var hand = handOf([7, 8]);
  armLock(1);
  eq('no marks', blockedNames(hand).length, 0);
});

// ---- 2. the marker is wired where the truth is, not where one branch is ----
t('BL-5 the hand renderer asks for the lock OUTSIDE the playability branch', function () {
  var ui = read('ui.js');
  var decl  = ui.indexOf("const batBlocked = Game.isCardBatmanBlocked('player', card)");
  var branch = ui.indexOf('} else if (!hasPending) {');
  eq('the lock is computed', decl > 0, true);
  eq('and computed BEFORE the branch that used to own it', decl < branch, true);
  // Exactly one place decides this. A second copy is how the two branches
  // drifted apart in the first place.
  eq('only one site computes it',
     (ui.match(/const batBlocked = Game\.isCardBatmanBlocked/g) || []).length, 1);
});

t('BL-6 the marker is applied unconditionally, once per hand card', function () {
  var ui = read('ui.js');
  eq('the helper exists', /_applyBatLock\(wrap, el, on\)/.test(ui), true);
  eq('and is called with the live answer',
     (ui.match(/this\._applyBatLock\(wrap, el, batBlocked\)/g) || []).length, 1);
  // Idempotence is the contract: called every render, from every branch.
  // Absent + locked builds it, present + locked leaves it (so the one-shot
  // entrance plays once per lock), present + unlocked removes it.
  var body = ui.slice(ui.indexOf('_applyBatLock(wrap, el, on) {'));
  body = body.slice(0, body.indexOf('\n  },'));
  eq('it removes the mark when the lock lifts', /if \(!on\) \{ if \(mark\) mark\.remove\(\); return; \}/.test(body), true);
  eq('it does not rebuild an existing mark', /if \(mark\) return;/.test(body), true);
});

t('BL-7 the mark hangs on the WRAPPER — inside .card the grayscale filter eats it', function () {
  var ui = read('ui.js');
  var body = ui.slice(ui.indexOf('_applyBatLock(wrap, el, on) {'));
  body = body.slice(0, body.indexOf('\n  },'));
  eq('appended to the wrapper', /wrap\.appendChild\(mark\)/.test(body), true);
  eq('never appended to the card', /el\.appendChild\(mark\)/.test(body), false);
  // And the greying rule this is dodging really does still exist — if it is
  // ever dropped, this test should be revisited rather than silently kept.
  var css = read('style.css');
  eq('.card.unplayable still applies a group filter',
     /\.card\.unplayable\s*\{[^}]*filter:\s*grayscale/.test(css), true);
});

// ---- 3. the CSS traps ------------------------------------------------------
// Comments in this stylesheet quote CSS at length, so they are blanked before
// anything is matched — same discipline as sim/card-tube.js.
function bareCss() {
  return read('style.css').replace(/\/\*[\s\S]*?\*\//g, function (c) {
    return c.replace(/[^\n]/g, ' ');
  });
}

t('BL-8 no rule selects .bat-lock as a DESCENDANT of .card', function () {
  var css = bareCss();
  var offenders = [];
  css.replace(/([^{}]+)\{[^{}]*\}/g, function (whole, sel) {
    sel.split(',').forEach(function (s) {
      s = s.trim();
      if (s.indexOf('.bat-lock') < 0) return;
      // `:has()` / `:not()` / `:is()` arguments are CONDITIONS on the subject,
      // not ancestors of it — `.wrapper:has(> .card.x) > .bat-lock` still puts
      // the mark outside the card. Blank them before looking for a real
      // descendant combinator, or the flip-dim rule reads as a violation of
      // the thing it is part of.
      var flat = s.replace(/:(?:has|not|is|where)\([^()]*\)/g, '');
      var idxCard = flat.indexOf('.card');
      var idxMark = flat.indexOf('.bat-lock');
      if (idxCard >= 0 && idxMark >= 0 && idxCard < idxMark) offenders.push(s);
    });
    return whole;
  });
  eq('descendant-of-card selectors', JSON.stringify(offenders), '[]');
});

t('BL-9 the entrance animation is not parked on .bat-lock itself', function () {
  var css = bareCss();
  // `fill-mode: both`/`forwards` keeps applying the keyframes' end values, and
  // animation values beat every normal declaration — so an opacity-touching
  // animation here outranks the flip-dim regardless of specificity. Measured:
  // 1 with the animation on .bat-lock, 0.16 with it on the inner <svg>.
  var stampTouchesOpacity = /@keyframes\s+batLockStamp\s*\{[^}]*opacity/.test(
    css.replace(/\}\s*\n/g, '}\n').replace(/@keyframes\s+batLockStamp\s*\{([\s\S]*?)\n\}/, function (m) { return m.replace(/\n/g, ' '); })
  );
  eq('the stamp keyframes do set opacity (so the trap is live)', stampTouchesOpacity, true);
  var offenders = [];
  css.replace(/([^{}]+)\{([^{}]*)\}/g, function (whole, sel, body) {
    if (!/animation[^:]*:\s*batLockStamp/.test(body)) return whole;
    sel.split(',').forEach(function (s) {
      s = s.trim();
      if (!s) return;
      if (/\.bat-lock\s*$/.test(s)) offenders.push(s);
    });
    return whole;
  });
  eq('rules animating .bat-lock itself', JSON.stringify(offenders), '[]');
  eq('the animation runs on the inner svg instead',
     /\.bat-lock\s*>\s*svg\s*\{[^}]*animation:\s*batLockStamp/.test(css), true);
});

t('BL-10 a flipped card can still be READ — the mark drops back, it does not cover the text', function () {
  var css = bareCss();
  var m = css.match(/\.hand-card-wrapper:has\(>\s*\.card\.face-flipped\)\s*>\s*\.bat-lock\s*\{([^}]*)\}/);
  eq('the flip-dim rule exists', !!m, true);
  if (m) {
    var op = m[1].match(/opacity:\s*([\d.]+)/);
    eq('and it really dims', !!op && parseFloat(op[1]) < 0.5, true);
  }
});

t('BL-11 the mark cannot swallow a click meant for the card', function () {
  var css = bareCss();
  var m = css.match(/\.hand-card-wrapper\s*>\s*\.bat-lock\s*\{([^}]*)\}/);
  eq('base rule exists', !!m, true);
  if (m) eq('pointer-events off', /pointer-events:\s*none/.test(m[1]), true);
});

t('BL-12 the colour is one knob, and it is not a side colour', function () {
  var css = bareCss();
  eq('token declared', /--bat-lock-ink:\s*#/.test(css), true);
  var m = css.match(/\.hand-card-wrapper\s*>\s*\.bat-lock\s+path\s*\{([^}]*)\}/);
  eq('the mark reads the token', !!m && /fill:\s*var\(--bat-lock-ink\)/.test(m[1]), true);
});

t('BL-13 the mark is a SILHOUETTE, and the traced outline survives its own rim', function () {
  var css = bareCss();
  var m = css.match(/\.hand-card-wrapper\s*>\s*\.bat-lock\s+path\s*\{([^}]*)\}/);
  eq('rule found', !!m, true);
  if (!m) return;
  // Filled, not hollow — an outline of the reference reads as a drawing OF the
  // mark rather than the mark.
  eq('not hollow', /fill:\s*none/.test(m[1]), false);
  // A centred stroke eats half its width off the shape all the way round. The
  // separation rim is only allowed if it is painted BEHIND the fill, which is
  // what keeps the traced silhouette the silhouette.
  if (/stroke:/.test(m[1]) && !/stroke:\s*none/.test(m[1])) {
    eq('a rim is painted behind the fill', /paint-order:\s*stroke/.test(m[1]), true);
  }
});

t('BL-14 the viewBox matches the coordinate space the path is drawn in', function () {
  var ui = read('ui.js');
  var vb = ui.match(/_BAT_LOCK_VIEWBOX:\s*'0 0 ([\d.]+) ([\d.]+)'/);
  eq('viewBox declared', !!vb, true);
  if (!vb) return;
  var w = +vb[1], h = +vb[2];
  // Pull every coordinate out of the path and check it lands inside the box.
  // A path authored at one scale and shown through another viewBox does not
  // error — it silently crops or floats, which is exactly the kind of failure
  // that looks like "the shape is just wrong".
  var body = ui.slice(ui.indexOf('_BAT_LOCK_PATH:'));
  body = body.slice(0, body.indexOf('\n  _applyBatLock'));
  var nums = (body.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  var xs = [], ys = [];
  for (var i = 0; i + 1 < nums.length; i += 2) { xs.push(nums[i]); ys.push(nums[i + 1]); }
  var maxX = Math.max.apply(null, xs), maxY = Math.max.apply(null, ys);
  var minX = Math.min.apply(null, xs), minY = Math.min.apply(null, ys);
  eq('no coordinate escapes the box left/top', minX >= -1 && minY >= -1, true);
  eq('no coordinate escapes the box right/bottom', maxX <= w + 1 && maxY <= h + 1, true);
  // And it should actually FILL the box, or the mark renders smaller than asked.
  eq('the path fills its box', maxX > w * 0.95 && maxY > h * 0.95, true);
});

// ---- run ----------------------------------------------------
__cases.forEach(function (c) {
  __caseFailed = false; __caseMsgs = [];
  try { c.fn(); } catch (e) {
    __caseFailed = true;
    __caseMsgs.push('threw: ' + (e && e.message ? e.message : String(e)));
  }
  if (__caseFailed) { __failed++; __failures.push({ name: c.name, msgs: __caseMsgs.slice() }); }
  else __passed++;
});
print('bat-lock: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
