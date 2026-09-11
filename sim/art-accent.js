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

t('AA-2 the card renderer stamps it; the TRICK renderer deliberately does not', function () {
  // makeCardEl is the one door every card surface goes through, so stamping it
  // there covers hand, board, draft, codex, deck builder and inspect at once.
  //
  // makeTrickEl is deliberately NOT stamped. Trick chrome is purple everywhere
  // so a trick reads as a trick at a glance — the same kind of signal as the
  // board's ownership colours, and not something to spend on decoration. The
  // cost-tier ramp this replaces only ever applied to CARDS. The first pass did
  // stamp it and it was dead code: tricks pin --rarity-rgb to the purple, so
  // nothing read the variable.
  eq('the helper exists', /_artAccentFor\(name\) \{/.test(UISRC), true);
  eq('makeCardEl stamps the CARD', /_artAccentFor\(card\.name\)[\s\S]{0,140}setProperty\('--art-rgb'/.test(UISRC), true);
  eq('a TRICK is deliberately excluded', /_artAccentFor\(trick\.name\)/.test(UISRC), false);
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
  var out = {}, re = /'([^']+)'\s*:\s*'(\d+\s*,\s*\d+\s*,\s*\d+)'/g, m;
  while ((m = re.exec(body))) out[m[1]] = m[2];
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
  // Ten is not a magic number, it is a smell threshold: past it the honest fix
  // is the generator, not another row.
  eq('and it is still short (' + n + ' entries)', n <= 10, true);
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
    var mx = Math.max.apply(null, p), mn = Math.min.apply(null, p);
    if (mx - mn < 40) bad.push(k + ' ' + ov[k] + ' (grey — the thing an override exists to avoid)');
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
