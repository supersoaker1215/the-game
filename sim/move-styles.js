// ============================================================
// MOVES HAVE PERSONALITY.
//
//   jsc sim/move-styles.js
//
// Owner (2026-11-11): "more animations for cards like catwoman, killer moth
// move, omni man". Every move funnels through moveCard -> emitFX('move') ->
// UI._fxCardSlide; a card's travel style is ONE entry in UI.MOVE_STYLES.
// Measured live (sandbox, 1600x1000): Killer Moth 0->3 shed 11 dust motes by
// 420ms and grew to 1/2; Omni-Man 5->1 drew the sonic streak at 140ms;
// Catwoman's steal launched an energy orb from the enemy counter.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var SRC = (read('ui.js') + '\n' + read('fx.js'))   /* fx.js = the effects library split out of ui.js */, CSS = read('style.css');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
check('Killer Moth flutters', UI.MOVE_STYLES['Killer Moth'] === 'moth');
check('Omni-Man breaks the sound barrier', UI.MOVE_STYLES['Omni-Man'] === 'boom');
var slide = SRC.slice(SRC.indexOf('  _fxCardSlide(ev) {'), SRC.indexOf('  _fxMothDust('));
check('the slide reads the style table by card name', /this\.MOVE_STYLES && this\.MOVE_STYLES\[ev\.name\]/.test(slide));
check('…and each style has its own path + effect', /this\._fxMothDust\(/.test(slide) && /this\._fxSonicBoom\(/.test(slide));
check('the card can never stay hidden (timeout fallback kept)', /setTimeout\(land, DUR \+ 90\)/.test(slide));
check('Catwoman shows the stolen energy travelling', /this\._fxEnergyTheft\(self\.owner\)/.test(SRC) && /\.fx-energy-orb \{/.test(CSS));
check('dust + streak styles exist', /\.fx-moth-dust \{/.test(CSS) && /\.fx-sonic-streak \{/.test(CSS));
var GSRC = read('game.js');
check('a Jump emits its own FX event from the one door every jumper uses', /emitFX\('jump', \{ cardId: card\.id, owner, name: card\.name, lane \}\)/.test(GSRC));
check('…which the UI routes to the jump entrance', /if \(ev\.type === 'jump'\) \{\s*this\._fxJumpIn\(ev\);/.test(SRC));
check('…waiting for the card to LAND before firing (it flies in from the hand)', /if \(\+\+tries < 90\) requestAnimationFrame\(poll\)/.test(SRC));
check('the snap survives the render diff', UI._FX_TRANSIENT_CLASSES.indexOf('fx-jump-snap') >= 0);
check('Deadpool shows the swap both ways', (SRC.match(/_fxHandSwap\(/g) || []).length >= 1 && /_fxHandSwap',"self\.owner, 'steal'"|UI\._fxHandSwap\(self\.owner, 'steal'\)/.test(read('abilities.js')) && /UI\._fxHandSwap\(self\.owner, 'give'\)/.test(read('abilities.js')));
check('Wolverine throws adamantium sparks on every hit', /UI\._fxAdamantium\(self\)/.test(read('abilities.js')));
print('move-styles: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('move-styles failed');
