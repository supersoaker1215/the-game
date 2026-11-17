// ============================================================
// A LOCKED CARD MUST NOT LOOK LIKE AN EXPENSIVE ONE.
//
//   jsc sim/bat-lock.js
//
// Batman locks the opponent's highest-cost AFFORDABLE card, and the hand marks
// it with a bat silhouette so a locked card reads differently from a card you
// merely cannot pay for. Guarded here, by rendering the real hand
// (UI.renderPlayerHand):
//
//   1. THE BRANCH. The lock is a fact about the card, so it shows whether or
//      not a prompt is open; computed inside the `!hasPending` arm it vanished
//      whenever anybody opened one.
//   2. THE FILTER. `.card.unplayable` greys the card AND its descendants as one
//      group, so the mark must be a sibling on `.hand-card-wrapper`, never a
//      child of `.card`.
//   3. THE ANIMATION FILL. An opacity-touching entrance with fill-mode `both`
//      on `.bat-lock` itself outranks the flip-dim rule; it lives on the inner
//      <svg>. That is a cascade fact, so it is checked as stylesheet text (the
//      shim has no cascade).
// ============================================================

var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');

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

// ---- 2. the marker, as the real hand renderer draws it ----------------------
// Renders the player's hand through UI.renderPlayerHand and reads the tree.
function renderHand(costs, currency, opts) {
  opts = opts || {};
  if (!opts.keep) {
    Game.init();
    UI._handWrappers = null;
    if (UI.playerHand) UI.playerHand.innerHTML = '';
    Game.state.player.hand = costs.map(function (c, i) {
      return Game.createCardInstance({ name: 'Lock Test ' + i, cost: c, attack: 1, health: 1 }, 'player');
    });
  }
  Game.state.round = 3;
  if (currency != null) armLock(currency);
  UI.renderPlayerHand(Game.state);
  return UI.playerHand.querySelectorAll('.hand-card-wrapper');
}
function markOf(wrap) { return wrap.children.filter(function (c) { return c.classList.contains('bat-lock'); })[0] || null; }
function cardOf(wrap) { return wrap.children.filter(function (c) { return c.classList.contains('card'); })[0] || null; }
function marked(wraps) {
  return wraps.filter(function (w) { return !!markOf(w); }).map(function (w) { return +(cardOf(w).className.match(/cost-(\d+)/) || [])[1]; });
}

t('BL-5 the hand shows the lock on exactly the locked cards', function () {
  var wraps = renderHand([2, 5, 10], 5);
  eq('three wrappers', wraps.length, 3);
  eq('the 5 is marked', JSON.stringify(marked(wraps)), '[5]');
  eq('the card carries the locked class', cardOf(wraps[1]).classList.contains('batman-locked'), true);
  eq('an unlocked card does not', cardOf(wraps[0]).classList.contains('batman-locked'), false);
});

t('BL-6 the lock survives an open prompt (it is not owned by the playability branch)', function () {
  var wraps = renderHand([2, 5, 10], 5);
  Game.state.pendingCardChoice = { owner: 'ai', cards: [], prompt: 'someone else is choosing' };
  wraps = renderHand(null, null, { keep: true });
  eq('still marked while a prompt is up', JSON.stringify(marked(wraps)), '[5]');
  Game.state.pendingCardChoice = null;
});

t('BL-7 re-renders keep the same mark, and lifting the lock removes it', function () {
  var wraps = renderHand([2, 5, 10], 5);
  var first = markOf(wraps[1]);
  wraps = renderHand(null, null, { keep: true });
  eq('the mark is not rebuilt on a re-render (the entrance plays once)', markOf(wraps[1]) === first, true);
  eq('and there is exactly one', wraps[1].children.filter(function (c) { return c.classList.contains('bat-lock'); }).length, 1);
  Game.state.player.batmanBlocked = 0; Game.state.player.batmanBlockedUntil = 0;
  wraps = renderHand(null, null, { keep: true });
  eq('the mark is gone once the lock lifts', JSON.stringify(marked(wraps)), '[]');
  eq('and so is the locked class', cardOf(wraps[1]).classList.contains('batman-locked'), false);
});

t('BL-8 the mark hangs on the WRAPPER — inside .card the grayscale filter eats it', function () {
  var wraps = renderHand([2, 5, 10], 5);
  var mark = markOf(wraps[1]);
  eq('the mark exists', !!mark, true);
  eq('its parent is the wrapper', !!mark && mark.parentNode === wraps[1], true);
  eq('nothing .bat-lock lives inside any card', UI.playerHand.querySelectorAll('.card .bat-lock').length, 0);
  eq('it sits after the card, so it paints over it', wraps[1].children.indexOf(mark) > wraps[1].children.indexOf(cardOf(wraps[1])), true);
  eq('it is decoration, hidden from assistive tech', !!mark && mark.getAttribute('aria-hidden'), 'true');
  // And the greying rule this is dodging really does still exist — if it is
  // ever dropped, this test should be revisited rather than silently kept.
  var css = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join(''));
  eq('.card.unplayable still applies a group filter',
     /\.card\.unplayable[^{]*\{[^}]*filter:[^;]*grayscale/.test(css), true);
});

// ---- 3. the CSS traps ------------------------------------------------------
// Comments in this stylesheet quote CSS at length, so they are blanked before
// anything is matched — same discipline as sim/card-tube.js.
function bareCss() {
  return (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('')).replace(/\/\*[\s\S]*?\*\//g, function (c) {
    return c.replace(/[^\n]/g, ' ');
  });
}

t('BL-12 no rule selects .bat-lock as a DESCENDANT of .card', function () {
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

t('BL-13 the entrance animation is not parked on .bat-lock itself', function () {
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

t('BL-14 a flipped card can still be READ — the mark drops back, it does not cover the text', function () {
  var css = bareCss();
  var m = css.match(/\.hand-card-wrapper:has\(>\s*\.card\.face-flipped\)\s*>\s*\.bat-lock\s*\{([^}]*)\}/);
  eq('the flip-dim rule exists', !!m, true);
  if (m) {
    var op = m[1].match(/opacity:\s*([\d.]+)/);
    eq('and it really dims', !!op && parseFloat(op[1]) < 0.5, true);
  }
});

t('BL-15 the mark cannot swallow a click meant for the card', function () {
  var css = bareCss();
  var m = css.match(/\.hand-card-wrapper\s*>\s*\.bat-lock\s*\{([^}]*)\}/);
  eq('base rule exists', !!m, true);
  if (m) eq('pointer-events off', /pointer-events:\s*none/.test(m[1]), true);
});

t('BL-16 the colour is one knob, and it is not a side colour', function () {
  var css = bareCss();
  eq('token declared', /--bat-lock-ink:\s*#/.test(css), true);
  var m = css.match(/\.hand-card-wrapper\s*>\s*\.bat-lock\s+path\s*\{([^}]*)\}/);
  eq('the mark reads the token', !!m && /fill:\s*var\(--bat-lock-ink\)/.test(m[1]), true);
});

t('BL-17 the mark is a SILHOUETTE, and the traced outline survives its own rim', function () {
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

t('BL-18 the viewBox the mark ships matches the coordinate space its path is drawn in', function () {
  var wraps = renderHand([2, 5, 10], 5);
  var mark = markOf(wraps[1]);
  var svg = mark && mark.querySelector('svg'), path = mark && mark.querySelector('path');
  eq('the mark carries an svg and a path', !!(svg && path), true);
  if (!svg || !path) return;
  var vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  eq('viewBox is "0 0 w h"', vb.length === 4 && vb[0] === 0 && vb[1] === 0 && vb[2] > 0 && vb[3] > 0, true);
  var w = vb[2], h = vb[3];
  // A path authored at one scale and shown through another viewBox does not
  // error — it silently crops or floats, which looks like "the shape is wrong".
  var nums = (path.getAttribute('d').match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  var xs = [], ys = [];
  for (var i = 0; i + 1 < nums.length; i += 2) { xs.push(nums[i]); ys.push(nums[i + 1]); }
  var maxX = Math.max.apply(null, xs), maxY = Math.max.apply(null, ys);
  var minX = Math.min.apply(null, xs), minY = Math.min.apply(null, ys);
  eq('no coordinate escapes the box left/top', minX >= -1 && minY >= -1, true);
  eq('no coordinate escapes the box right/bottom', maxX <= w + 1 && maxY <= h + 1, true);
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
