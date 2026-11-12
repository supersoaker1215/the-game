// ============================================================
// DRAFT: phone fits one screen; desktop rail trimmed; rarity glow own colour.
//
//   jsc sim/draft-phone.js
//
// Owner (2026-11-11): phone draft "one non scrollable screen … aspect ratio
// for cards doesn't change … side by side … first 2 letters of the name and
// cost underneath for your previous picks … tap … pull up the card"; desktop
// "get rid of the crossed out sections"; "legendary has a blue glow … should
// be the same color as the text … rare has an orange glow it should be blue".
// Measured live (393x852): before the overlay scrolled 1411px, offers stacked,
// a card squeezed to 142x616; after 852/852 (no scroll), two offers side by
// side at the desktop shape (0.55 / 0.57), picks as "Ma 1"/"Ro 2" tiles that
// open the card. Desktop: rail = "Your tricks" only; COMMON / SUPER-RARE
// labels glow their own colour, the offer host no longer tints them.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var SRC = (read('ui-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('\n'));
var CSS = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('')).replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

// Desktop rail: no stats, curve or keywords.
var railFn = SRC.slice(SRC.indexOf('  _draftDeckRailHTML('), SRC.indexOf('  _draftCardFootHTML('));
var ret = railFn.slice(railFn.lastIndexOf('return `<aside'));
check('deck-so-far stats gone from the rail', !/dcr-stats|dcr-curve|dcr-kws|Deck so far/.test(ret), ret.slice(0, 120));
check('…tricks kept', /\$\{trickHtml\}/.test(ret));

// Rarity labels: own-colour glow, offer host halo dropped.
check('offer host no longer tints its label', /\.draft-offer\.card-glow-host \{ filter: none !important; \}/.test(CSS));
check('labels glow in their own colour', /\.draft-foot-rarity,\s*\.draft-foot-rarity\.rarity-tier-4 \{ text-shadow: 0 0 8px currentColor; \}/.test(CSS));

// Pick slot: 2-letter abbreviation + cost + tap to inspect.
var slot = UI._draftSlotHTML({ name: 'Martian Manhunter', cost: 4, baseCost: 4, attack: 4, health: 4 }, 'Pick 1', 'is-filled', 'card');
check('pick tile carries a 2-letter abbreviation', /class="dpr-abbr">Ma</.test(slot), slot.slice(0, 200));
check('…and its cost underneath', /class="dpr-mcost">4</.test(slot));
check('…and opens the card on tap', /data-card-name="Martian Manhunter"[^>]*onclick="UI\.showCardInspect\(this\)"/.test(slot));
var tslot = UI._draftSlotHTML({ name: 'The Grinch', cost: 3 }, 'Trick 1', 'is-filled', 'trick');
check('"The" is skipped in the abbreviation; tricks open by trick name', /class="dpr-abbr">Gr</.test(tslot) && /data-trick-name="The Grinch"/.test(tslot));
var empty = UI._draftSlotHTML(null, 'Pick 3', 'is-empty', 'card');
check('empty slots are not tappable', !/onclick=/.test(empty));

// Phone layout: one screen, side by side, one design width + zoom.
var phone = CSS.slice(CSS.indexOf('.dpr-abbr, .dpr-mcost { display: none; }'));
check('phone overlay does not scroll', /\.draft-overlay:has\(\.draft-stage\) \{\s*overflow: hidden !important;/.test(phone));
check('offers sit in a row', /flex-direction: row !important;\s*flex-wrap: nowrap !important;/.test(phone));
check('one design width (the desktop one), scaled by zoom', /--dph-card-w: 300px;/.test(phone) && /zoom: var\(--dph-zoom/.test(phone));
check('the fit is bounded by the screen width', /Math\.min\(box\.clientWidth, window\.innerWidth - 28\)/.test(SRC));
check('desktop zoom-in leaves phones to the phone fit', /if \(this\._isPhoneDraft\(\)\) \{[\s\S]{0,160}this\._fitDraftPhone\(\);/.test(SRC));

print('draft-phone: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('draft-phone failed');
