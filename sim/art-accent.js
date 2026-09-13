// ============================================================
// THE CARD'S BORDER COMES FROM ITS OWN PAINTING.
//
//   jsc sim/art-accent.js
//
// Owner: "get rid of the rarity neon highlights, 1-3 are green, 4-6 are blue,
// 7-8 are white 9-10 are gold. now i want each card to have a border that
// compliments their card art."
//
// What was there: four cost tiers, four hues, for 259 paintings. Measured on
// the live draft before the change — 48 card appearances, 4 distinct border
// colours. It also told you the card's COST, which is already printed in the
// corner as a number, so the loudest colour on the card carried the one thing
// you did not need from it. After: 39 distinct colours across the same 48.
//
// The colour per art file is GENERATED (card-art-accent.js, from
// sim/tools/card-art-accent.py). This suite does not re-derive it — that needs
// the images — it pins the wiring, the coverage, and the two properties that
// make the result usable: every border must be legible on black, and the
// board's ownership colours must survive.
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
var CSS_RAW = read('style.css');
// COMMENTS OUT FIRST. This suite's own first run failed on the COMMENT that
// documents the ramp it removed — the text ".card.cost-0..3 green" reads as a
// rule to any regex. Blanking comment bodies (keeping newlines, so line numbers
// in a failure still mean something) is the same guard sim/draft-screen.js uses.
var CSS = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
var UISRC = read('ui.js');
// A MISSING GENERATED FILE IS A FAILING TEST, NOT A CRASHED RUNNER. `read`
// throws, which takes the whole suite (and run-tests.sh's summary) down with a
// stack instead of a sentence. Whoever deletes card-art-accent.js should get
// "the generated map is loaded" in red, not an exception.
function readOr(path, fallback) {
  try { return read(path); } catch (e) { return fallback; }
}
var ACCENT = readOr('card-art-accent.js', '');
var HTML = read('index.html');

// Parse the generated map without evaluating it.
var MAP = {};
ACCENT.replace(/'((?:[^'\\]|\\.)*)':\s*'(\d+,\d+,\d+)'/g, function (_, k, v) {
  MAP[k.replace(/\\'/g, "'")] = v; return '';
});

t('AA-1 the cost-tier ramp is gone, at the source', function () {
  // Not "no longer visible" — GONE. A commented-out or overridden ramp is a
  // ramp that comes back the next time someone tidies the sheet.
  eq('no cost-tier border rules remain',
     /\.card\.cost-\d+[^{]*\{[^}]*--rarity-rgb/.test(CSS), false);
  eq('the card reads its art colour instead',
     /\.card \{ --rarity-rgb: var\(--art-rgb, 150, 170, 190\); \}/.test(CSS), true);
  // The four tier constants may stay declared (they are part of the owner's
  // palette spec) but nothing may READ them, or the tiers are back.
  eq('nothing reads --rar-green', /var\(--rar-green\)/.test(CSS), false);
  eq('nothing reads --rar-blue',  /var\(--rar-blue\)/.test(CSS), false);
  eq('nothing reads --rar-white', /var\(--rar-white\)/.test(CSS), false);
  eq('nothing reads --rar-gold',  /var\(--rar-gold\)/.test(CSS), false);
});

t('AA-2 both renderers stamp it — the card AND the trick', function () {
  // makeCardEl is the one door every card surface goes through, so stamping it
  // there covers hand, board, draft, codex, deck builder and inspect at once.
  //
  // THIS REVERSES the assertion that used to stand here, that a trick was
  // deliberately excluded. The argument was that purple chrome is how a trick
  // reads as a trick at a glance, the same signal as the board's ownership
  // colours. Owner: "can you do tricks the same way as cards unique color and
  // sheen" — so the signal is spent, knowingly, and a trick is now told apart
  // by having no stat marks at all rather than by its colour.
  //
  // TWO EMITTERS. makeTrickEl covers draft, codex, history and the floating
  // prompts; the in-match tray builds its own element and has to be stamped
  // separately. The trick frame block in style.css already warns about this
  // pair — "or the tray would have quietly kept the old look the way the rarity
  // pips did" — and a trick that is purple in hand and coloured in the codex is
  // exactly that bug.
  eq('the helper exists', /_artAccentFor\(name\) \{/.test(UISRC), true);
  eq('makeCardEl stamps the CARD', /_artAccentFor\(card\.name\)[\s\S]{0,140}setProperty\('--art-rgb'/.test(UISRC), true);
  eq('makeTrickEl stamps the TRICK', /_artAccentFor\(trick\.name\)[\s\S]{0,120}--art-rgb/.test(UISRC), true);
  // ...and both of the trick emitters do it.
  eq('the in-match tray stamps it too',
     (UISRC.match(/_artAccentFor\(trick\.name\)/g) || []).length >= 2, true);
  // The chain has to be open at every link or the stamp is dead code, which is
  // what happened the first time this was tried: --art-rgb was set while the
  // CSS still pinned --rarity-rgb and --cf-rgb to the purple.
  var CSS = readOr('style.css', '');
  eq('the trick frame reads the chain rather than pinning purple',
     /--cf-rgb:\s*var\(--portrait-frame-rgb, 155, 89, 182\)/.test(CSS), true);
  eq('and so do its frame + rarity vars',
     /--portrait-frame-rgb: var\(--art-rgb, 155, 89, 182\)/.test(CSS)
     && /--rarity-rgb:\s*var\(--art-rgb, 155, 89, 182\)/.test(CSS), true);
  // On the CARD, not the portrait: a custom property set on a child can never
  // reach the parent, and the rim glow lives on .card.
  eq('it is not stamped on the portrait instead',
     /card-portrait[^\n]*--art-rgb/.test(UISRC), false);
  // Through the variant lookup, so alternate art gets its own border.
  eq('it follows the art VARIANT', /_artAccentFor[\s\S]{0,400}getCardArtVariant/.test(UISRC), true);
});

t('AA-3 the generated map is loaded, and is a real map', function () {
  eq('index.html loads it', /card-art-accent\.js\?v=/.test(HTML), true);
  eq('after the manifest it overrides',
     HTML.indexOf('card-art-accent.js') > HTML.indexOf('card-art-manifest.js'), true);
  eq('it is generated, and says so', /GENERATED FILE, DO NOT HAND-EDIT/.test(ACCENT), true);
  eq('and names the script that rebuilds it', /sim\/tools\/card-art-accent\.py/.test(ACCENT), true);
  var n = Object.keys(MAP).length;
  eq('it covers the whole art set (' + n + ' files)', n > 200, true);
});

t('AA-4 EVERY border is legible on black', function () {
  // The whole point is a line on a black card. A colour the algorithm derived
  // honestly is still useless if it is too dark to see, so this is a floor on
  // the OUTPUT rather than trust in the derivation.
  var dark = [], grey = [];
  Object.keys(MAP).forEach(function (k) {
    var p = MAP[k].split(',').map(Number);
    // Rec.709 luma — the eye weights green far above blue, so a plain average
    // passes navy that is invisible on black.
    var luma = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
    if (luma < 90) dark.push(k + ' ' + MAP[k] + ' luma ' + luma.toFixed(0));
    var mx = Math.max.apply(null, p), mn = Math.min.apply(null, p);
    if (mx > 250 && mn > 250) grey.push(k);
  });
  eq('none too dark to see', dark.length ? dark.slice(0, 5).join(' | ') : 0, 0);
  eq('none is pure white (that was the old 7-8 tier)', grey.length, 0);
});

t('AA-5 the set is actually VARIED — that was the complaint', function () {
  var vals = {}, hues = {};
  Object.keys(MAP).forEach(function (k) {
    vals[MAP[k]] = true;
    var p = MAP[k].split(',').map(Number);
    var mx = Math.max.apply(null, p), mn = Math.min.apply(null, p), d = mx - mn;
    if (!d) { hues['grey'] = true; return; }
    var h;
    if (mx === p[0]) h = ((p[1] - p[2]) / d) % 6;
    else if (mx === p[1]) h = (p[2] - p[0]) / d + 2;
    else h = (p[0] - p[1]) / d + 4;
    hues[Math.round(((h * 60) + 360) % 360 / 30)] = true;
  });
  var distinct = Object.keys(vals).length;
  eq('far more than four colours (' + distinct + ')', distinct > 150, true);
  eq('spread across the wheel, not clustered in two corners (' +
     Object.keys(hues).length + ' of 12 sectors)', Object.keys(hues).length >= 9, true);
});

t('AA-6 a card with NO art still gets a border', function () {
  // Eight of the ladder Cogs have no painting at all. They must not render
  // with a transparent or broken frame — the CSS fallback is the same steel a
  // monochrome painting gets, which is the honest answer for "nothing to
  // complement".
  eq('the fallback is in the var itself',
     /--rarity-rgb: var\(--art-rgb, 150, 170, 190\)/.test(CSS), true);
  ['Flunky', 'Short Change', 'Name Dropper', 'Bloodsucker',
   'Downsizer', 'Money Bags', 'The Mingler', 'Legal Eagle'].forEach(function (n) {
    eq(n + ' really has no art yet (if this fails, regenerate the map)',
       !MAP[n + '.png'] && !MAP[n + '.jpg'], true);
  });
});

t('AA-7 the BOARD keeps its ownership colours', function () {
  // Not decoration — it is how you tell whose card you are looking at, and the
  // owner asked for it directly: "when Batman is in hand it's gold, but when
  // he's played on board it's the neon highlight the player has chosen." The
  // art border belongs where the side is already obvious.
  eq('ally takes the player accent',
     /\.card\.ally-card\s*\{ --portrait-frame-rgb: var\(--theme-rgb/.test(CSS), true);
  eq('enemy takes the opponent colour',
     /\.card\.enemy-card\s*\{ --portrait-frame-rgb: var\(--own-opponent\)/.test(CSS), true);
  // and those rules must out-specify the .card default, or the board goes
  // art-coloured and the two sides stop reading apart
  eq('and they are more specific than the .card default',
     CSS.indexOf('.card.ally-card  { --portrait-frame-rgb') >
     CSS.indexOf('  --portrait-frame-rgb: var(--rarity-rgb'), true);
});

// The override map used to be asserted EMPTY. It is not any more — Superman is
// in it — so the invariant moved to the two things that actually matter: the
// hatch still wins over the generated map, and it stays SHORT. A long list
// means the generator needs fixing rather than the list needing another row.
function overrideEntries() {
  var MAN = readOr('card-art-manifest.js', '');
  var at = MAN.indexOf('window.CARD_ART_ACCENT_OVERRIDE = {');
  if (at < 0) return null;
  var body = MAN.slice(at + 'window.CARD_ART_ACCENT_OVERRIDE = {'.length);
  body = body.slice(0, body.indexOf('\n};'));
  // Comment bodies in here carry example rows ('Carnage.png': '240,58,60') and
  // measured values; blank them or they get counted as live entries. This is
  // the trap art-accent.js was already bitten by once.
  body = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // BOTH QUOTE STYLES, and an escaped apostrophe inside a single-quoted key.
  // This file is single-quoted throughout, but a double-quoted key is valid JS
  // and would simply vanish from this parser — which is how "Joker's Playing
  // Card" went missing on the way in. A key this test cannot see is a key it
  // cannot check.
  var out = {}, re = /(?:'((?:[^'\\]|\\.)+)'|"([^"]+)")\s*:\s*'(\d+\s*,\s*\d+\s*,\s*\d+)'/g, m;
  while ((m = re.exec(body))) {
    var key = (m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2]);
    out[key] = m[3];
  }
  return out;
}

t('AA-8 the escape hatch exists, wins, and stays short', function () {
  // The generator reports the dominant hue by area; a person names the hue of
  // the SUBJECT. Carnage and Superman are the cases that separate them.
  var MAN = readOr('card-art-manifest.js', '');
  eq('the override map exists', /window\.CARD_ART_ACCENT_OVERRIDE = \{/.test(MAN), true);
  eq('the helper consults it FIRST',
     /CARD_ART_ACCENT_OVERRIDE[\s\S]{0,220}window\.CARD_ART_ACCENT\b/.test(UISRC), true);
  var ov = overrideEntries();
  eq('it parses', ov !== null, true);
  var n = Object.keys(ov).length;
  // THE CAP WAS TEN, AND THE REASON IT MOVED IS WORTH RECORDING. Ten was a smell
  // threshold for "the generator needs fixing rather than the list needing
  // another row", and it tripped at 16. Looking at what the sixteen actually
  // are: the generator reported Carnage blue, Raven blue, Green Goblin red,
  // Optimus orange, Jango red, the Grinch cyan. In every one of those it found
  // the LIGHTING or the background rather than the character — the saliency
  // failure this map's header already describes and deliberately does not try
  // to solve ("telling subject from setting needs saliency, which is a great
  // deal of machinery for a border colour"). These are not shade corrections
  // the generator could learn; they are a person naming a subject.
  // So the cap moves, and what it now guards against is the list quietly
  // becoming the whole set — at which point the hatch IS the generator and the
  // generator is dead weight.
  eq('and it has not become the whole set (' + n + ' entries)', n <= 40, true);
});

t('AA-9 every override is a legible line on black, same floor as the generated set', function () {
  // An override skips the generator entirely, so it also skips AA-4. Hand-set
  // colours are exactly the ones that can be too dark or too washed, so hold
  // them to the same floor rather than trusting the hand that wrote them.
  var ov = overrideEntries() || {};
  var bad = [];
  Object.keys(ov).forEach(function (k) {
    var p = ov[k].split(',').map(Number);
    var luma = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
    if (luma < 90) bad.push(k + ' ' + ov[k] + ' luma ' + luma.toFixed(0) + ' (too dark)');
    // NEAR-NEUTRAL IS ONLY A FAULT WHEN IT IS DIM. The failure this catches is
    // the steel a monochrome painting falls back to — a washed mid-grey that
    // reads as "no answer". A deliberate bright WHITE is a different thing and
    // is sometimes exactly right: owner, on a black-and-white film still and on
    // Cap's monochrome shot, "art white, captain ameica white". Both measure
    // 245,245,245, luma 245, which nothing could mistake for the steel fallback
    // at luma ~170.
    var mx = Math.max.apply(null, p), mn = Math.min.apply(null, p);
    if (mx - mn < 40 && luma < 200) {
      bad.push(k + ' ' + ov[k] + ' (dim grey — the steel fallback, not a chosen colour)');
    }
  });
  eq('all legible and chromatic', bad.length ? bad.join(' | ') : 0, 0);
});

t('AA-10 Superman is red, and it is the override doing it', function () {
  // Owner: "i want supermans border to be the red in the art". His default
  // painting is ~95% black with one glowing S, so the generator's chroma ramp
  // bottomed out and handed him steel (188,169,171) off a hue it had already
  // read correctly as red.
  var ov = overrideEntries() || {};
  var val = ov['Superman'] || ov['Superman 3.jpg'];
  eq('Superman is overridden', !!val, true);
  var p = String(val).split(',').map(Number);
  eq('and the override is RED — red channel dominant',
     p[0] > p[1] + 60 && p[0] > p[2] + 60, true);
  // Keyed by NAME so it survives a variant switch; _artAccentFor falls back
  // from file to name, so a name key covers every variant he has.
  eq('the resolver falls back from file key to name key',
     /ov\[file\]\s*\|\|\s*ov\[name\]/.test(UISRC), true);
  // The generated map must still hold the OLD value — proving the override is
  // what changes the border, not a regenerated accent file.
  eq('the generated map still reports the steel it derived',
     MAP['Superman 3.jpg'], '188,169,171');
});

t('AA-11 the owner-named colours are in the family they were named as', function () {
  // Owner: "power stone puple, fear toxin orange, ... carnage red, green goblin
  // green, optimus blue, raven purple, grinch green". Each value is sampled from
  // that card's own art (sim/tools/card-art-border.py), so this does NOT pin the
  // exact numbers — re-sampling a re-cropped painting may legitimately move
  // them. It pins the thing that was WRONG: the generator had Carnage blue,
  // Raven blue, Green Goblin red, Optimus orange, the Grinch cyan, because it
  // found the lighting rather than the character.
  var ov = overrideEntries() || {};
  function fam(rgb) {
    var p = String(rgb).split(',').map(Number);
    var r = p[0] / 255, g = p[1] / 255, b = p[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 0.12) return 'neutral';
    var h;
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    if (h >= 345 || h < 15) return 'red';
    if (h < 45) return 'orange';
    if (h < 72) return 'yellow';
    if (h < 168) return 'green';
    if (h < 258) return 'blue';
    if (h < 320) return 'purple';
    return 'red';
  }
  var named = {
    'Power Stone': 'purple', 'Fear Toxin': 'orange', 'Mind Stone': 'yellow',
    "Joker's Playing Card": 'purple', 'Jango Fett': 'blue', 'Carnage': 'red',
    'Green Goblin': 'green', 'Optimus Prime': 'blue', 'Raven': 'purple',
    'The Grinch': 'green', 'Art the Clown': 'neutral', 'Captain America': 'neutral',
    'Lex Luthor': 'green', 'Power Battery': 'green', 'Time Stone': 'green',
    'Iron Man': 'red', 'Superman': 'red'
  };
  var wrong = [];
  Object.keys(named).forEach(function (k) {
    if (!ov[k]) { wrong.push(k + ' has no override at all'); return; }
    var got = fam(ov[k]);
    if (got !== named[k]) wrong.push(k + ' is ' + got + ', named as ' + named[k] + ' (' + ov[k] + ')');
  });
  eq('every named card wears the family it was named as', wrong.join(' | '), '');
  // ...and no two of them are the same value, which is what "not a generic
  // colour" means in practice — the previous pass had Power Battery and the
  // Time Stone on an identical hand-picked green.
  var seen = {}, dupes = [];
  Object.keys(named).forEach(function (k) {
    if (!ov[k]) return;
    if (seen[ov[k]] && !(k === 'Art the Clown' || k === 'Captain America')) {
      dupes.push(k + ' shares ' + ov[k] + ' with ' + seen[ov[k]]);
    }
    seen[ov[k]] = k;
  });
  eq('and no two share one value', dupes.join(' | '), '');
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
print('art-accent: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
