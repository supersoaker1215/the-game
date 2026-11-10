// ============================================================
// THE TURN BANNER IS SNAP-FAST.
//
//   jsc sim/phase-banner-fast.js
//
// Owner: "make the turn banner faster". Measured live, same page, "Your Turn —
// Cards & Tricks": before readable 1042ms / gone 2075ms; after 336 / 1211.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var CSS = read('style.css').replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

// Drive the real function with stubbed banner nodes; capture the hide timer.
var html = '', toggles = {}, hideMs = null;
var cl = { add: function () {}, remove: function () {}, toggle: function (c, on) { toggles[c] = on; } };
UI.phaseBanner = { classList: cl };
UI.phaseBannerText = { classList: cl, set innerHTML(v) { html = v; }, get innerHTML() { return html; } };
var realST = this.setTimeout;
this.setTimeout = function (fn, ms) { hideMs = ms; return 1; };
window.setTimeout = this.setTimeout;
UI.showPhaseBanner('Your Turn — Cards & Tricks');
this.setTimeout = realST; window.setTimeout = realST;
var delays = (html.match(/animation-delay:(\d+)ms/g) || []).map(function (d) { return +d.replace(/\D/g, ''); });
var last = Math.max.apply(null, delays);
check('every letter starts within 240ms (was 875ms)', last <= 240 && delays.length >= 20, 'last ' + last);
check('short phase banner holds 1000ms (was 1800)', hideMs === 1000, hideMs);
// Long informational text keeps its reading-time rule.
var longText = 'Gorr the God Butcher has claimed a lane — every god in it is marked';
this.setTimeout = function (fn, ms) { hideMs = ms; return 1; }; window.setTimeout = this.setTimeout;
UI.showPhaseBanner(longText);
this.setTimeout = realST; window.setTimeout = realST;
check('long messages keep their reading time', hideMs === Math.min(5000, 1800 + (longText.length - 40) * 55), hideMs);
function lastRule(sel) { var re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g'), m, b = null; while ((m = re.exec(CSS))) b = m[1]; return b || ''; }
check('letters reveal in 220ms (was 380)', /animation-duration:\s*220ms/.test(lastRule('.phase-banner-text .letter')));
check('fade-out 0.2s (was 0.3s)', /transition:\s*opacity 0\.2s/.test(lastRule('.phase-banner')));
check('the sweep fits inside the shorter banner', /animation-duration:\s*0\.65s/.test(lastRule('.phase-banner.active .phase-banner-text::after')));
print('phase-banner-fast: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('phase-banner-fast failed');
