// ============================================================
// CARD-TUBE AUDIT — static. Proves the card frame's neon stack is actually
// REACHABLE, not just present.
//
// This bug class has now cost three separate passes, always the same shape: a
// glow is authored on the card frame, it looks right in the file, and nothing
// changes on screen because a different rule wins.
//
//   .cf-frame  filter ......... zeroed outright by `.card .cf-frame{filter:none}`
//   .card      var(--card-tube) loses to `.card.card` — a 0,2,0 selector 500
//              lines earlier — so the stack wired to --neon-boost never painted
//              and the knob genuinely did nothing
//   .cf-edge::after ........... `display:none`, and before that it was parked
//              inside the hole its own parent's clip-path punches
//
// `filter` is the trap in every case: it is ONE property, so a second
// declaration REPLACES the stack rather than merging with it. A grep for
// "--card-tube" says the tube is there; only resolving the cascade says it
// paints. So this resolves it — !important, then specificity, then order — and
// asserts the rule that actually wins.
//
//   jsc sim/card-tube.js -- [--verbose]
// ============================================================

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var VERBOSE = false;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--verbose') VERBOSE = true;

var CSS = read('style.css');
// Comments can contain anything that looks like a rule — this file is full of
// quoted CSS in its own commentary — so they go first. Newlines are kept so
// reported line numbers stay true.
var BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, function (c) {
  return c.replace(/[^\n]/g, ' ');
});

var pass = 0, fails = [];
function ok(name) { pass++; if (VERBOSE) print('  ok  ' + name); }
function bad(name, detail) { fails.push(name + (detail ? ' — ' + detail : '')); }
function check(name, cond, detail) { if (cond) ok(name); else bad(name, detail); }

function lineOf(idx) { return BARE.slice(0, idx).split('\n').length; }

// ---- specificity ------------------------------------------------------------
// Enough of the real algorithm for the selectors this file uses: ids, then
// classes/attributes/pseudo-classes, then elements. :not()/:has()/:is() take
// the specificity of their most specific argument, which is what makes
// `.card:not(.face-down):active` a 0,3,0 and not a 0,2,0.
function specificity(sel) {
  var a = 0, b = 0, c = 0;
  var s = sel.replace(/::[\w-]+/g, '');
  s = s.replace(/:(?:not|is|has|where)\(([^()]*)\)/g, function (m, inner) {
    if (/^:where/.test(m)) return ' ';
    var best = [0, 0, 0];
    inner.split(',').forEach(function (part) {
      var sp = specificity(part);
      if (sp[0] > best[0] || (sp[0] === best[0] && (sp[1] > best[1] ||
          (sp[1] === best[1] && sp[2] > best[2])))) best = sp;
    });
    a += best[0]; b += best[1]; c += best[2];
    return ' ';
  });
  a += (s.match(/#[\w-]+/g) || []).length;
  b += (s.match(/\.[\w-]+/g) || []).length;
  b += (s.match(/\[[^\]]*\]/g) || []).length;
  b += (s.match(/:[\w-]+(?:\([^()]*\))?/g) || []).length;
  c += (s.replace(/[#.:][\w-]+(?:\([^()]*\))?/g, ' ').replace(/\[[^\]]*\]/g, ' ')
         .match(/\b[a-zA-Z][\w-]*\b/g) || []).length;
  return [a, b, c];
}
function beats(x, y) {              // does declaration x win over y?
  if (x.important !== y.important) return x.important;
  for (var i = 0; i < 3; i++) {
    if (x.spec[i] !== y.spec[i]) return x.spec[i] > y.spec[i];
  }
  return x.order > y.order;         // equal specificity: later wins
}

// ---- every declaration of `prop`, split per selector in the group ----------
function declarations(prop) {
  var out = [], re = /([^{}]+)\{([^{}]*)\}/g, m, n = 0;
  while ((m = re.exec(BARE))) {
    var body = m[2];
    var d = new RegExp('(?:^|[;{\\s])' + prop + '\\s*:').exec(body);
    if (!d) continue;
    // NOT `[^;]*`. A value can legally CONTAIN a semicolon — an inline SVG mask
    // is `url("data:image/svg+xml;utf8,<svg .../>")`, and stopping at the first
    // one truncated it to `url("data:image/svg+xml`, which made every assertion
    // about the shape of a masked badge silently unanswerable. Walk instead,
    // tracking quotes and paren depth, and stop at a semicolon that is actually
    // a declaration terminator.
    var value = (function (str, from) {
      var depth = 0, q = null, out = '';
      for (var k = from; k < str.length; k++) {
        var ch = str[k];
        if (q) { out += ch; if (ch === q && str[k - 1] !== '\\') q = null; continue; }
        if (ch === '"' || ch === "'") { q = ch; out += ch; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ';' && depth === 0) break;
        out += ch;
      }
      return out;
    })(body, d.index + d[0].length).replace(/\s+/g, ' ').trim();
    var important = /!important/.test(value);
    m[1].split(',').forEach(function (sel) {
      sel = sel.replace(/\s+/g, ' ').trim();
      if (!sel || sel.charAt(0) === '@' || /%$/.test(sel) || sel === 'from' || sel === 'to') return;
      out.push({ sel: sel, value: value, important: important,
                 spec: specificity(sel), order: n++, line: lineOf(m.index) });
    });
  }
  return out;
}

// Which declarations can reach a given element? Modelled, not evaluated: the
// element is described by the classes it carries and the ancestors it has, and
// a selector reaches it only if every compound in the selector is satisfied.
function reaches(sel, el) {
  if (/::/.test(sel)) return false;                       // pseudo-elements are not the card
  if (/:hover|:active|:focus|:checked|:disabled/.test(sel)) return false;  // resting state only
  var parts = sel.split(/\s*[>\s]\s*/).filter(function (p) { return p && p !== '>' && p !== '+' && p !== '~'; });
  var last = parts.pop();
  if (!compoundOk(last, el.classes)) return false;
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i].split(/[.:#\[]/).filter(Boolean).every(function () { return true; })) return false;
    var names = (parts[i].match(/\.[\w-]+/g) || []).map(function (s) { return s.slice(1); });
    if (!names.every(function (n) { return el.ancestors.indexOf(n) >= 0; })) return false;
    if (/^[a-zA-Z]/.test(parts[i])) return false;         // element ancestors: not modelled
  }
  return true;
}
function compoundOk(compound, classes) {
  if (/^[a-zA-Z]/.test(compound)) return false;
  var notOk = true;
  compound.replace(/:not\(([^()]*)\)/g, function (m, inner) {
    inner.split(',').forEach(function (p) {
      var n = (p.match(/\.[\w-]+/g) || []).map(function (s) { return s.slice(1); });
      if (n.length && n.every(function (x) { return classes.indexOf(x) >= 0; })) notOk = false;
    });
    return ' ';
  });
  if (!notOk) return false;
  var stripped = compound.replace(/:(?:not|is|has|where)\([^()]*\)/g, ' ');
  if (/:[\w-]/.test(stripped)) return false;              // an unmodelled pseudo-class
  var names = (stripped.match(/\.[\w-]+/g) || []).map(function (s) { return s.slice(1); });
  return names.length > 0 && names.every(function (n) { return classes.indexOf(n) >= 0; });
}

function winner(prop, el) {
  var best = null;
  declarations(prop).forEach(function (d) {
    if (!reaches(d.sel, el)) return;
    if (!best || beats(d, best)) best = d;
  });
  return best;
}

print('--- card-tube: is the frame\'s neon stack reachable?');

// ---- 1. the stack exists ----------------------------------------------------
check('--card-tube is declared', /--card-tube\s*:/.test(BARE),
      'the canonical tube variable is gone');

// ---- 2. THE ONE THAT MATTERS. A resting board card — no state classes, no
// hover — must end up with a filter that composes the tube. This is the check
// that would have caught all three dead-rule passes.
var restingCard = { classes: ['card'], ancestors: ['board', 'lane', 'card-slot', 'game-area'] };
var wf = winner('filter', restingCard);
check('a resting card\'s winning `filter` composes var(--card-tube)',
      wf && /var\(--card-tube\)/.test(wf.value),
      wf ? 'style.css:' + wf.line + ' wins with `' + wf.value.slice(0, 70) + '` — the tube is dead code'
         : 'no filter declaration reaches a plain .card at all');

// ---- 3. the core. The line has to be LIGHTER than the glow around it, which
// is the entire reason a tube reads as lit. A flat rgb(var(--cf-rgb)) ring is
// the state this audit was written to stop coming back.
var restingEdge = { classes: ['cf-edge'], ancestors: ['card', 'cf-frame', 'board', 'lane'] };
var we = winner('background', restingEdge);
check('the ring colour comes off the --cf-core-lift dial',
      we && (/--cf-core-lift/.test(we.value) || /--cf-core-white/.test(we.value)),
      we ? 'style.css:' + we.line + ' wins with `' + we.value.slice(0, 70) + '`'
         : 'no background declaration reaches .cf-edge');
// and the dial moves LIGHTNESS in oklch rather than mixing toward white, which
// is the difference between a lit core and a pastel one: sRGB's path to #fff
// runs through the desaturated middle, so every step lighter is a step greyer.
// (Owner: "too white more saturation.")
check('the dial holds chroma (oklch lightness, not a white mix)',
      we && /oklch\(from/.test(we.value),
      we ? 'winning value is `' + we.value.slice(0, 70) + '` — that washes the frame colour out'
         : 'no background declaration reaches .cf-edge');
// THE RULING, not a preference. Measured off the board reference: its frame
// line is #4FC3F7, this game's own --cf-rgb, with no lift in it whatever. The
// owner said "too white" three times across three different amounts, and the
// third time put the reference beside a live card. Zero is the answer the art
// gives; anything above it is the thing he rejected.
var lift = /--cf-core-lift:\s*([^;]+);/.exec(BARE);
check('--cf-core-lift ships at 0 (the reference line is the frame colour)',
      lift && parseFloat(lift[1]) === 0,
      lift ? 'default is ' + lift[1].trim() + ' — that is lighter than the reference'
           : 'the dial has no default');
var wht = /--cf-core-white:\s*([^;]+);/.exec(BARE);
check('the no-relative-colour fallback agrees with it',
      wht && parseFloat(wht[1]) === 0,
      wht ? 'fallback whitens by ' + wht[1].trim() + ' where the live path does not'
          : 'the fallback ratio is gone');

// ---- 4. ONE LINE, NOT TWO. The owner has rejected an added white line inside
// the stroke twice. The core is the line itself; the ::after ring stays dead.
var afterHidden = /\.cf-edge::after[^{]*\{[^}]*display:\s*none/.test(BARE);
check('.cf-edge::after stays hidden (one line, not two)', afterHidden,
      'a second white ring is back inside the stroke');

// ---- 5. the persistent states. Each of these declares its own `filter`, so
// each one silently erased the whole glow until it was made to compose it. They
// are listed by hand because they are a decision, not a pattern: a state that
// SHOULD go dark belongs off this list, not quietly failing it.
var MUST_COMPOSE = [
  '.card.moder-stripped', '.card.hand-card.rl-curse', '.card.card-being-dragged',
  '.card.card-asleep', '.hand-cards .card.ballyhoo-locked', '.card.hand-card.selected',
  '.card:not(.face-down):active', '.card.unplayable', '.hand-card-wrapper .card.unafford',
  '.card.unplayable.table-waiting', '.player-hand-section .hand-cards .card.dimmed-by-selection',
  '.player-hand-section .hand-cards .card.is-selected'
];
var all = declarations('filter');
MUST_COMPOSE.forEach(function (want) {
  var mine = all.filter(function (d) { return d.sel === want; });
  if (!mine.length) { bad('state composes the tube: ' + want, 'selector no longer declares filter'); return; }
  var last = mine[mine.length - 1];
  check('state composes the tube: ' + want, /var\(--card-tube\)/.test(last.value),
        'style.css:' + last.line + ' replaces the whole stack with `' + last.value.slice(0, 50) + '`');
});

// ---- 6. and the infinite keyframes, which replace `filter` sixty times a
// second for as long as the card is on the board.
['cardCrazyGlitch', 'vibeCosmicHue', 'vibeMagneticShift', 'table-waiting-breathe'].forEach(function (name) {
  var re = new RegExp('@keyframes\\s+' + name + '\\s*\\{([\\s\\S]*?)\\n\\}', 'g'), m, body = null;
  while ((m = re.exec(BARE))) body = m[1];   // the LAST one is the live definition
  check('infinite keyframe composes the tube: ' + name,
        body && /var\(--card-tube\)/.test(body),
        body ? 'it replaces the filter outright' : 'keyframe not found');
});

// ---- 7. the inner hairline. It is the design note's two INSET stops, which
// nothing else in the frame can express: drop-shadow() only throws light
// outward, and box-shadow: inset on .cf-edge would be erased by that ring's own
// clip-path. So it lives on .cf-frame::before — a sibling of the ring, not a
// child of it — and it ships OFF, because a light line inside the stroke has
// been refused twice. These three assertions are the deal: off by default, the
// note's numbers verbatim, and not parented anywhere a clip-path can eat it.
var hairRe = /\.card \.cf-frame::before[^{]*\{([\s\S]*?)\n\}/;
var hair = hairRe.exec(BARE);
check('the inner hairline exists on .cf-frame::before', !!hair,
      'the opt-in inset stops are gone');
if (hair) {
  var hb = hair[1].replace(/\s+/g, ' ');
  check('inner hairline copies the note\'s inset stops exactly',
        /inset 0 0 4px rgba\(var\(--cf-rgb\), 0\.90\)/.test(hb) &&
        /inset 0 0 10px rgba\(var\(--cf-rgb\), 0\.30\)/.test(hb),
        'the stops drifted from 4px @0.90 / 10px @0.30 inset');
  check('inner hairline is gated on the --cf-hairline token',
        /opacity:\s*var\(--cf-hairline/.test(hb),
        'it is no longer opt-in');
}
var tokenDefault = /--cf-hairline:\s*([^;]+);/.exec(BARE);
check('--cf-hairline ships OFF (0)', tokenDefault && tokenDefault[1].trim() === '0',
      tokenDefault ? 'default is ' + tokenDefault[1].trim() + ', not 0'
                   : 'the token has no default');

// ---- 8. nothing may FILL a lane with the card's own frame colour. A card's
// halo is light thrown onto the dark around it, so a lane state that paints
// that same hue across the space the card sits in does not add to the glow —
// it deletes the contrast the glow is made of. The threat signal was doing
// exactly that at 62% of the card's own bloom strength. It keeps its colour,
// its intensity ladder and its pulse; it just has to be a RIM, which is what a
// negative spread on an inset shadow makes. (Owner: "maybe its the black behind
// it thta makes it pop.")
['\\.lane\\.threat-lane::after',
 '\\.lane\\.threat-lane\\.threat-2::after',
 '\\.lane\\.threat-lane\\.threat-3::after'].forEach(function (sel) {
  var re = new RegExp(sel + '\\s*\\{([\\s\\S]*?)\\n\\}', 'g'), m, body = null;
  while ((m = re.exec(BARE))) { if (/box-shadow/.test(m[1])) body = m[1]; }
  var name = sel.replace(/\\/g, '');
  if (!body) { bad('threat glow is a rim: ' + name, 'no box-shadow rule found'); return; }
  var insets = body.match(/inset[^,;]*/g) || [];
  check('threat glow is a rim, not a fill: ' + name,
        insets.length > 0 && insets.every(function (s) { return /-\d+px\s*rgba/.test(s); }),
        'an inset layer has no negative spread — it fills the lane with the card\'s own frame colour');
});

// ---- the rules text is for READING -----------------------------------------
// Owner, on the tap-to-play card: "i just want the text cleaned up it seems
// like theres a blue tint over the text that shouldnt happen."
//
// TWO layers were tinting it and only one was colour. `.card-desc` resolved
// both its COLOUR and a 5px+10px text-shadow from --portrait-frame-rgb, and on
// an ally card that var points at the THEME — so a 10px cyan bloom sat under
// every letter of every rules paragraph whatever the card's own colour was.
// Measured on Batman: an ORANGE-framed card with rgba(0,229,255) at 0.82 and
// 0.74 under its text.
//
// AND THE VOICE IS WHITE, not the #c9d6de this first shipped with. Owner:
// "have the text you changed for each card be a crisp white." #c9d6de is a
// blue-GREY — against a black card it still read as a tint, only a quieter
// one, which is the same complaint one notch down.
//
// This belongs in this suite specifically: it is the same bug class the file
// exists for. A neutral colour had already been authored for the draft and it
// looked fixed in the file — but scoped to `.draft-card`, so the hand, the
// board and the tap-to-play card kept the tint. Only resolving the cascade for
// each surface says which rule actually wins.
var SURFACES = [
  { name: 'hand card',    classes: ['card-desc'], ancestors: ['card', 'hand-card'] },
  { name: 'board ally',   classes: ['card-desc'], ancestors: ['card', 'ally-card'] },
  { name: 'board enemy',  classes: ['card-desc'], ancestors: ['card', 'enemy-card'] },
  { name: 'draft card',   classes: ['card-desc'], ancestors: ['card', 'draft-card'] },
  { name: 'tap-to-play',  classes: ['card-desc'], ancestors: ['card', 'inspect-card', 'card-inspect-modal'] },
];
SURFACES.forEach(function (sf) {
  var el = { classes: sf.classes, ancestors: sf.ancestors };
  var c = winner('color', el);
  check('rules text is crisp white on the ' + sf.name,
        !!c && /#fff(fff)?\b/i.test(c.value),
        c ? 'winning colour is `' + c.value + '` from `' + c.sel + '`'
          : 'no colour rule reaches it at all');
  var sh = winner('text-shadow', el);
  // A shadow is allowed — it is what keeps 9px type legible over a painting —
  // but it must be BLACK. The tell is whether it resolves a frame/theme var.
  check('and its glow is black, not a colour, on the ' + sf.name,
        !!sh && !/var\(--portrait-frame-rgb|var\(--theme-rgb|var\(--rarity-rgb/.test(sh.value),
        sh ? 'winning text-shadow is `' + sh.value.slice(0, 90) + '` from `' + sh.sel + '`'
           : 'no text-shadow rule reaches it');
});

// The TRIGGER label is the one thing in the paragraph that keeps its colour,
// because there the colour is structural — it marks where one ability ends and
// the next begins. If this ever goes neutral the abilities run together.
(function () {
  var trig = { classes: ['cd-trig'], ancestors: ['card', 'hand-card', 'card-desc'] };
  var c = winner('color', trig);
  check('the trigger label still carries the card\'s accent',
        !!c && /--portrait-frame-rgb|--cf-rgb/.test(c.value),
        c ? 'winning colour is `' + c.value + '`' : 'nothing reaches the trigger label');
})();

// ---- the commit button wears the board's neon ------------------------------
// Owner: "the tap to play should be the neon highlight of the board." It was
// pinned to a fixed green (110,245,139, borrowed from the leaderboard's win
// cell), which made it the one control on screen that ignored the accent the
// player picked.
check('"Play — tap a lane" takes the board accent, not a fixed green',
      /\.card-inspect-play-btn\s*\{[^}]*--rtc:\s*var\(--theme-rgb/.test(BARE),
      'the play button still hard-codes its colour');
check('and the old fixed green is gone from it',
      !/\.card-inspect-play-btn\s*\{[^}]*--rtc:\s*110,\s*245,\s*139/.test(BARE),
      'both declarations are present — the later one wins, but the dead one will confuse the next reader');

// ---- the stat marks: hexagons, at the border's own width -------------------
// Owner, over three rounds: "match the border width and colour exactly" ->
// "do the hex badges" -> "the hexes are not fully complete and the numbers
// inside should be the border colour" -> "the hex is still not closed".
//
// "EXACTLY" is why this is a clip-path ring and not a mask or an SVG stroke.
// Both of those express thickness as a fraction of the BADGE, and the badge
// does not scale with --cf-stroke, so any number chosen there is right at one
// card size and wrong at every other. A traced ring uses the same VALUE the
// frame uses, so the two cannot drift.
(function () {
  check('the stat mark is a hexagon', /--stat-hex:\s*polygon\(evenodd/.test(BARE),
        'the reference badge is a hex, not a square or a circle');
  check('and the earlier conic-mask marks are GONE, not just overridden',
        !/--stat-seg-square|--stat-seg-round/.test(BARE),
        'this suite passed for a commit against those dead declarations rather than ' +
        'against what paints — which is the exact failure it exists to catch');
  check('the ring is stroked at var(--cf-stroke)',
        /--stat-hex[\s\S]{0,900}var\(--cf-stroke\) \* 1\.1547/.test(BARE),
        'insetting a pointy-top hexagon by t moves each vertex 1.1547t along its radius');
  // EACH LOOP HAS TO CLOSE ITSELF. `polygon()` is ONE path: the outer six points
  // followed by the inner six is not two rings, it is a twelve-sided figure
  // with a seam from the last outer point to the first inner one. evenodd
  // renders most of that as a ring and leaves a NOTCH at the seam — the corner
  // the owner circled twice. `.cf-edge` already solved this for the card's own
  // frame by repeating each loop's first point; I had not copied that half.
  var hexDef = (/--stat-hex:([\s\S]*?);/.exec(BARE) || [,''])[1].replace(/\s+/g, ' ');
  check('the OUTER loop closes before the inner one starts',
        /0% 25%, 50% 0%,/.test(hexDef),
        'the outer hexagon must return to its first point or the path seams into the inner one');
  check('and the INNER loop closes too',
        (hexDef.match(/50% calc\(var\(--cf-stroke\) \* 1\.1547\)/g) || []).length >= 2,
        'the inner hexagon must repeat its own first point, for the same reason');
  // THE BOX HAS TO BE REGULAR OR THE STROKE IS NOT UNIFORM. Scaling every vertex
  // toward the centre only gives an even stroke at height = width x 2/sqrt3.
  // The badge was landing SQUARE — a (0,4,0) rule pins it to 0.145w both ways
  // and the traced 1.08 lost at (0,2,0) — so the vertical inset ran 1.1547x the
  // horizontal: two thin upright edges, four fat diagonals.
  check('the badge is a REGULAR hexagon, at the specificity that wins',
        /\.card\.card\.draft-card \.stat-circle[\s\S]{0,300}height: calc\(var\(--stat-h\) \* 1\.1547\)/.test(BARE),
        'height = width x 2/sqrt3, or the ring\'s inset is uneven');
  // 0.190 was 101/533 traced off the reference. Owner, on the shipped card:
  // "i would rather them be smaller and a little more space from the edge."
  check('and it is 0.160 of the card width', /--stat-h:\s*calc\(var\(--card-w\) \* 0\.160\)/.test(BARE),
        'one multiplier, so every surface shrinks together');

  // THE SAME SIZE IN HAND AND ON BOARD, and the fix for that is NOT a size rule.
  // Both surfaces already ran the same --stat-h; --card-w itself was wrong on a
  // board card, reading the authored 140px while the card painted 101px from
  // --board-card-w. Measured hex share of its own card: hand 19.0%, board 26.3%
  // — a constant 1.386x, the "wrong reference" signature. With --card-w tied to
  // the painted width both read 16.0%.
  check('a board card\'s --card-w follows its PAINTED width',
        /body\.in-match \.card-slot > \.card\s*\{[\s\S]{0,1400}--card-w:\s*var\(--board-card-w/.test(BARE),
        'without this the hexes, chamfer and inset are all sized off 140px on a 101px card');
  // The phone-only override is NOT the cause and must not be blamed for it —
  // it lives inside a media query and never applies on desktop. Pinned so the
  // next reader does not "fix" the wrong rule.
  check('and the 16px board override is still phone-only',
        /@media[^{]*\{[\s\S]*?\.board \.card \{ --stat-h: 16px; \}/.test(BARE),
        'if this escapes its media query it WOULD become the cause');

  // --stat-side is named because --stat-bottom subtracts it: the HP hex has to
  // clear the bottom-right chamfer, and the further in it sits horizontally the
  // sooner it clears. A copied literal decouples them the first time either is
  // tuned, which the --stat-bottom comment says has already happened four times.
  check('the stat inset is defined once, as --stat-side',
        /--stat-side:\s*calc\(var\(--card-w\) \* 0\.055\)/.test(BARE),
        'more space from the edge, one definition');
  check('and the bottom offset subtracts that same variable',
        /--stat-bottom:[\s\S]{0,260}-\s*var\(--stat-side\)/.test(BARE),
        'a literal here silently decouples the two');
  check('both edges read it',
        /\.card\.card \.stat-atk \{ left:\s*calc\(var\(--cf-inset\) \+ var\(--stat-side\)\)/.test(BARE) &&
        /\.card\.card \.stat-hp\s+\{ right:\s*calc\(var\(--cf-inset\) \+ var\(--stat-side\)\)/.test(BARE),
        'left and right must stay symmetric');
  // the numerals joined everything else
  var atk = winner('color', { classes: ['stat-atk'], ancestors: ['card'] });
  var hp  = winner('color', { classes: ['stat-hp'],  ancestors: ['card'] });
  check('the damage numeral takes the card colour', !!atk && /var\(--cf-rgb/.test(atk.value),
        atk ? 'winning colour is ' + atk.value : 'nothing reaches it');
  check('the health numeral takes the card colour', !!hp && /var\(--cf-rgb/.test(hp.value),
        hp ? 'winning colour is ' + hp.value : 'nothing reaches it');
  // AND SO DOES ITS GLOW. Changing the colour and leaving the text-shadow is
  // how a green halo survived behind an orange numeral for two commits: the old
  // shadow still carried rgba(61,255,158) behind attack and rgba(255,107,107)
  // behind health. On a red card the health one hid inside the card's own
  // colour, which is why only attack got reported. Owner: "why is there green
  // behind the 1."
  var aGlow = winner('text-shadow', { classes: ['stat-atk'], ancestors: ['card', 'draft-card'] });
  var hGlow = winner('text-shadow', { classes: ['stat-hp'],  ancestors: ['card', 'draft-card'] });
  check('the attack glow is the card colour, not green',
        !!aGlow && /var\(--cf-rgb/.test(aGlow.value) && !/61, ?255, ?158/.test(aGlow.value),
        aGlow ? 'winning text-shadow is `' + aGlow.value.slice(0, 100) + '`' : 'nothing reaches it');
  check('the health glow is the card colour, not red',
        !!hGlow && /var\(--cf-rgb/.test(hGlow.value) && !/255, ?107, ?107/.test(hGlow.value),
        hGlow ? 'winning text-shadow is `' + hGlow.value.slice(0, 100) + '`' : 'nothing reaches it');
})();

// ---- the rest of the traced reference ---------------------------------------
// RESTORED. These nine cases went in with the reference trace and were deleted
// by my own index-splice in the commit after it — the suite went 535 -> 522 and
// still passed, because a shorter suite passes just as well as a correct one.
// Numbers are measured off the reference image (card body 533x1259), expressed
// over 533 in --card-w.
(function () {
  check('ATK / HP labels exist', /content:\s*'ATK'/.test(BARE) && /content:\s*'HP'/.test(BARE));
  check('…on the reading surfaces only',
        /\.card\.card\.draft-card \.stat-atk[^,]*::after/.test(BARE),
        'a 10px label under a 21px board badge is noise — the hexagon is the design, ' +
        'the label is the detail (the owner\'s hand/board rule)');
  check('the keyword chip is a bordered pill, centred',
        /\.card\.card\.draft-card \.status-badge[\s\S]{0,300}border: 1px solid rgba\(var\(--cf-rgb/.test(BARE) &&
        /\.status-badges[\s\S]{0,160}justify-content: center/.test(BARE));
  check('the rules divider runs the full width at the reference\'s own value',
        /border-top: 1px solid rgb\(40, 45, 51\)/.test(BARE),
        'sampled off the reference, not picked');
  // THE ENERGY CORNER IS GLASS. Owner: "for the corner i want the art
  // underneath no black, but i want a border color fill at like 15%."
  //
  // THIS REVERSES the three assertions that used to stand here — that the plate
  // was a gradient, mixed to about a tenth toward #000, and fully OPAQUE. That
  // last one had a real argument behind it ("a see-through plate lets the
  // frame's own border read straight through it") and it was true when it was
  // written: the frame sat UNDER the band then. The z-order has since inverted
  // to band 9 / diag 10 / frame 11 / cost 12, pinned by the block below, so
  // `.cf-frame` paints on top and cannot read through at any alpha. Verified
  // live at alpha 0.15: the ring's top and left segments stay unbroken.
  var plate = winner('background', { classes: ['cf-band'], ancestors: ['card'] });
  check('the energy plate takes the card\'s own colour',
        !!plate && /var\(--cf-rgb/.test(plate.value),
        plate ? 'winning background is `' + plate.value.slice(0, 90) + '`' : 'nothing reaches the plate');
  check('the plate is GLASS — the painting reads through it',
        !!plate && /rgba\(var\(--cf-rgb/.test(plate.value) && !/#000/.test(plate.value),
        plate ? 'winning background is `' + plate.value.slice(0, 110) + '`' : 'no plate rule');
  // 15% first, then the owner looked at it: "just have it fill with the border
  // color 50" / "50%". Half strength, not a tint.
  check('at about 50%',
        !!plate && /,\s*0?\.(4[5-9]|5[0-5])0?\s*\)/.test(plate.value),
        plate ? 'winning background is `' + plate.value.slice(0, 110) + '`' : 'no plate rule');
  // The black plate was what guaranteed the digit's contrast — it carried only
  // a white hairline and a coloured bloom, no dark shadow at all, and against a
  // forced pure-white portrait it very nearly disappeared. Glass means the digit
  // now sits on the art, so it needs the dark core the card NAME already uses.
  var digit = winner('text-shadow', { classes: ['card-cost'], ancestors: ['card'] });
  check('and the digit keeps a dark core, so it survives bright art',
        !!digit && /rgba\(0,\s*0,\s*0,\s*0?\.9/.test(digit.value),
        digit ? 'winning text-shadow is `' + digit.value.slice(0, 120) + '`' : 'nothing reaches the digit');
  check('without losing its accent bloom',
        !!digit && /var\(--cf-rgb/.test(digit.value),
        digit ? 'winning text-shadow is `' + digit.value.slice(0, 120) + '`' : 'no digit rule');
})();

// ---- the energy banner wraps OVER the corner --------------------------------
// Owner: "remove the 2 lines i circled for every card on the energy banner,
// this will make it seem like its wrapped around giving depth."
//
// THIS REVERSES an earlier decision in the same file ("THE FRAME PAINTS OVER
// THE RIBBON"), which raised the frame to z-index 8 precisely so its top and
// left segments would cross the ribbon — "exactly the line that was missing".
// Those are the two lines. Both halves of the argument are kept in style.css;
// this pins which one is live, so the reversal cannot be undone by accident.
(function () {
  var band  = winner('z-index', { classes: ['cf-band'],      ancestors: ['card'] });
  var frame = winner('z-index', { classes: ['cf-frame'],     ancestors: ['card'] });
  var diag  = winner('z-index', { classes: ['cf-band-diag'], ancestors: ['card'] });
  var cost  = winner('z-index', { classes: ['card-cost'],    ancestors: ['card'] });
  var n = function (d) { return d ? parseInt(d.value, 10) : NaN; };
  // THE OUTLINE IS CONTINUOUS. Lifting the banner over the frame was tried and
  // reversed: it stopped the frame's top and left segments crossing the banner,
  // which left the chamfer hanging in space with a gap either side and a blunt
  // end at each tip. Owner: "no i want the line at the end." The ring sits on
  // top, the outline runs left edge -> chamfer -> top edge unbroken, and the
  // banner lies inside it.
  check('the frame is ABOVE the banner, so the outline is unbroken',
        n(frame) > n(band) && n(frame) > n(diag),
        'frame z=' + n(frame) + ' band z=' + n(band) + ' diag z=' + n(diag) +
        ' — a frame under the banner leaves the chamfer detached at both ends');
  check('the cost digit stays above everything',
        n(cost) > n(frame),
        'cost z=' + n(cost) + ' frame z=' + n(frame) + ' — the digit goes under the plate');
  check('and the banner\'s own edge line stays above the plate',
        n(diag) > n(band));
  // THE CHAMFER LINE IS KEPT. It was removed for one commit — the banner ran
  // to (0,0) and covered it — and the owner reversed that on sight: "no i want
  // the line at the end." So the banner's fourth edge stays pulled in by one
  // stroke measured along the diagonal, and the ring still draws the cut.
  var clip = winner('clip-path', { classes: ['cf-band'], ancestors: ['card'] });
  check('the chamfer line is not swallowed by the banner',
        !!clip && /--chamfer\)\s*\+\s*var\(--cf-stroke\)\s*\*\s*var\(--sqrt2\)/.test(clip.value),
        clip ? 'winning clip is `' + clip.value.slice(0, 90) + '`' : 'no clip reaches the banner');
})();

// (The health ring's dash-pattern arithmetic used to be pinned here. It went
// with the SVG mask: the ring is a masked BORDER now, so there is no dash
// pattern to keep closed — the conic mask's wedges are angles, which cannot
// fail to add up. One fewer number to keep in step.)

// ---- the glow lives on the container, and the pass that puts it there -------
// Owner, against a reference card: "i just feel like i want more glow" -> "do
// the wrapper". The glow could never work on the card itself: .card.card clips
// to its own chamfered silhouette and a clip-path clips the FILTERED result,
// so the halo was generated and cut off flush. Measured 19 against the
// reference's 673.
(function () {
  var UIJS = read('ui.js');
  check('the container rule exists', /\.card-glow-host\s*\{[^}]*drop-shadow/.test(BARE),
        'nothing paints the halo');
  check('and it reads the accent carried up to it',
        /\.card-glow-host\s*\{[^}]*var\(--cg-rgb/.test(BARE),
        'the host must read --cg-rgb — a container cannot read its child\'s colour by itself');
  check('low-fx switches it off', /body\.low-fx \.card-glow-host\s*\{[^}]*filter:\s*none/.test(BARE),
        'a per-card blur pass is exactly what the perf escape hatch is for');
  check('the pass exists', /_applyCardGlow\(\)\s*\{/.test(UIJS));
  check('and runs from applyTronFx, which already walks every card',
        /applyTronFx\(\)\s*\{[\s\S]{0,400}_applyCardGlow\(\)/.test(UIJS),
        'wired anywhere else and a surface has to opt in');
  // It reads --portrait-frame-rgb, NOT --art-rgb: in hand/draft/codex that is
  // the card's art colour, on the board it is the SIDE colour. One read, and
  // the halo says the same thing the frame says on every surface.
  check('it takes the frame colour, so the board keeps its side colours',
        /_applyCardGlow[\s\S]{0,3200}--portrait-frame-rgb/.test(UIJS),
        'reading --art-rgb directly would make an enemy card glow in its art colour');
  // Two bugs the first version shipped with, both found by driving it:
  check('a host must hold exactly ONE card',
        /_applyCardGlow[\s\S]{0,2600}querySelectorAll\('\.card, \.trick-card'\)\.length !== 1/.test(UIJS),
        '.trick-cards holds the whole tray — stamping it put one halo around a GROUP');
  check('…counted as CARDS, not children, or draft and tap-to-view are excluded',
        !/host\.children\.length !== 1/.test(UIJS),
        '.draft-offer has 2 children and .card-inspect-modal has 3, but both hold one card — ' +
        'a child count silently skipped exactly the two surfaces the owner asked for');
  check('and the idempotency guard checks the CLASS, not just the signature',
        /dataset\.cgSig === sig && host\.classList\.contains\('card-glow-host'\)/.test(UIJS),
        'a render that rewrites className drops the class while the signature survives, so the glow vanished on the first re-render and never came back');
  check('an unplayable card\'s halo dims with it',
        /_applyCardGlow[\s\S]{0,3600}unplayable/.test(UIJS),
        'a greyed card glowing at full strength undoes the read');
})();

// ---- the stat deltas in the prose keep their sign colours ------------------
// Owner circled the second +1 in "Add (+1/+1)": "that needs to be red". The
// neutral-prose pass had taken it white with the rest of the body; the two
// numbers are attack and health, and stripping the colour off one made the
// pair unreadable as a pair.
(function () {
  var hp  = winner('color', { classes: ['stat-num-hp'],  ancestors: ['card', 'card-desc'] });
  var atk = winner('color', { classes: ['stat-num-atk'], ancestors: ['card', 'card-desc'] });
  check('the health delta is red',  !!hp && /#ff6b6b/i.test(hp.value),
        hp ? 'winning colour is ' + hp.value : 'nothing reaches it');
  check('the attack delta is green', !!atk && /#3dff9e/i.test(atk.value),
        atk ? 'winning colour is ' + atk.value : 'nothing reaches it');
})();

// ---- the card name wears the border's colour -------------------------------
// Owner, circling HAWKEYE and APOCALYPSE on the draft: "the names need to pop
// and match the neon border."
//
// It was a 48% mix toward white — not a tint of the accent so much as white
// with a memory of it. Measured: a crimson rgb(241,64,105) border printed its
// name at rgb(248,163,183), a pale pink. And a `0 0 1px` WHITE halo sat on
// every glyph edge, which at 27px is most of what you see of a letter's
// colour, so the mix was being washed from the inside and the halo washed it
// from the outside.
(function () {
  var el = { classes: ['cn-text'], ancestors: ['card', 'draft-card', 'card-name-overlay'] };
  var c = winner('color', el);
  check('the name reads the shared recipe', !!c && /var\(--cn-colour\)/.test(c.value),
        c ? 'winning colour is `' + c.value + '` — it should defer to --cn-colour' : 'nothing reaches the name');
  var sh = winner('text-shadow', el);
  check('and its glow reads the shared recipe too', !!sh && /var\(--cn-glow\)/.test(sh.value),
        sh ? 'winning text-shadow is `' + sh.value + '`' : 'no shadow reaches it');
  // the recipe itself
  var recipe = /--cn-colour:\s*color-mix\(in srgb, rgb\(var\(--cf-rgb[^)]*\)+\)\s*82%/.test(BARE);
  check('and the recipe is 82% toward the accent', recipe,
        'under 80% and the name reads as white with a tint — measured, a crimson ' +
        'rgb(241,64,105) border used to print its name at rgb(248,163,183)');
  var glowDef = /--cn-glow:[\s\S]{0,400}?;/.exec(BARE);
  var gv = glowDef ? glowDef[0] : '';
  check('and its halo carries no white core',
        !!gv && !/255,\s*255,\s*255/.test(gv),
        'the recipe is `' + gv.slice(0, 110) + '`');
  check('the halo is the accent, in two layers',
        (gv.match(/--cf-rgb/g) || []).length >= 2,
        'one radius reads as an outline; two read as a tube');
  // AND THE RADII ARE THE NAME'S OWN, not the card's. The first pass reused the
  // frame's 0.030/0.070 so the two would "read as one object" — right about the
  // colour, wrong about the size: the frame spreads its glow along a 700px
  // perimeter, the same radii around a 27px letterform just eat the letterform.
  // Owner: "better but too much outer glow." Measured on a black stage with the
  // painting removed, halo energy per unit of glyph 0.617 -> 0.421, with the
  // glyphs themselves unchanged at 242k/239k.
  var radii = gv.match(/var\(--card-w\) \* (0\.\d+)/g) || [];
  check('and they are tighter than the card\'s own glow (0.030 / 0.070)',
        radii.length >= 2 && radii.every(function (r) {
          return parseFloat(r.split('* ')[1]) <= 0.035;
        }),
        'radii found: ' + radii.join(', ') + ' — at 27px type anything wider blooms over the glyph');
  check('with black underneath, because the name sits on the painting',
        /rgba\(0, ?0, ?0/.test(gv),
        'no dark layer and a pale name disappears into a bright art');
})();

// ---- the rules text reads NEON WHITE, not grey ------------------------------
// Owner: "the text should be like neon white not grey." The colour was never
// the problem — declared #fff, measured #fff. At 11px most of a glyph is
// partial-coverage antialiasing, so what the eye averages is not the stroke
// core (which hit 254) but the half-lit pixels around it (median 184). Two
// things were dragging those down: a `0 0 3px` BLACK halo sitting exactly
// under them, and a 500 weight leaving few full-coverage pixels to begin with.
//
// Measured on a black stage with the art and chrome hidden:
//   mean light over the paragraph  19.13 -> 30.00  (+57%)
//   pixels reading white           4,822 -> 6,703  (+39%)
(function () {
  var el = { classes: ['card-desc'], ancestors: ['card', 'draft-card'] };
  var sh = winner('text-shadow', el);
  check('the rules text has no black halo eating its antialiasing',
        !!sh && !/0 0 [0-9.]+px rgba\(0, ?0, ?0/.test(sh.value),
        sh ? 'winning text-shadow is `' + sh.value.slice(0, 100) + '`' : 'no shadow reaches it');
  check('and carries a white bloom instead, which lifts the half-lit pixels',
        !!sh && (sh.value.match(/255, ?255, ?255/g) || []).length >= 2,
        'one layer reads as an outline; two read as lit');
  check('a tight black drop stays, for the panel behind it',
        !!sh && /0 1px 2px rgba\(0, ?0, ?0/.test(sh.value));
  var w = winner('font-weight', el);
  check('and the draft body is 600, not 500',
        !!w && /600|var\(--draft-rules-weight\)/.test(w.value),
        w ? 'winning weight is `' + w.value + '`' : 'nothing sets it');
  check('the draft weight TOKEN is 600',
        /--draft-rules-weight:\s*600/.test(BARE),
        'the token out-specifies the base rule — raising the base alone does nothing on the draft, ' +
        'which is exactly what happened on the first attempt');
})();

// ---- one recipe, every surface ---------------------------------------------
// Owner: "card design elements are all the same, just some have more detail
// than others — hand/board less detail, tap, draft and codex the most detail."
// So the name's treatment is defined ONCE and read everywhere; the only thing
// that varies is --card-w, which every radius is expressed in, so a 110px tile
// gets a proportionally smaller version of the same thing rather than a
// different thing. Measured: hand glow radii 1.32/1.65/3.52px against
// tap-to-view's 3.84/4.8/10.24px, identical colour on both.
(function () {
  var hand = winner('color', { classes: ['cn-text'],
                               ancestors: ['card', 'hand-card', 'card-name-overlay'] });
  check('the HAND name reads the same recipe as the draft',
        !!hand && /var\(--cn-colour\)/.test(hand.value),
        hand ? 'winning colour is `' + hand.value + '`' : 'nothing reaches the hand name');
  check('so no surface hard-codes white for it',
        !/\.card \.card-name-overlay \.cn-text \{[^}]*#ffffff/.test(BARE),
        'a pure-white override on one surface is the thing this replaced');
})();

// ---- the name bars carry the card's own colour ------------------------------
// REVERSED ON SIGHT. They carried the rarity tier for exactly one commit — the
// owner asked for it, looked at it, and asked for the opposite: "the rarity
// line by the name should be the border colour, no rarity line anymore."
(function () {
  var UIJS = read('ui.js');
  check('the bars take the card colour, not a rarity colour',
        /card-name-overlay::before[\s\S]{0,260}rgb\(var\(--cf-rgb/.test(BARE),
        'they should read the same token everything else on the card reads');
  check('and no rarity palette is left behind',
        !/--rarity-tier-rgb:/.test(BARE),
        'a colour block nothing reads is the thing this suite keeps catching');
  // the CLASS stays: it is a fact about the card the draft foot and the inspect
  // ribbon already print, and it costs one line to keep available.
  check('the rarity tier is still stamped on the card',
        /makeCardEl\(card, inHand, side, opts\)[\s\S]{0,2000}rarity-tier-' \+ _r\.tier/.test(UIJS));
  check('and the bars are not dimmed',
        !/card-name-overlay::before[\s\S]{0,260}rgba\([^)]*0\.42\)/.test(BARE),
        'a dimmed 1px rule on a dark panel is invisible, not subtle');
})();

print('card-tube: ' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) {
  print('Failures:');
  fails.forEach(function (f) { print('  - ' + f); });
}
