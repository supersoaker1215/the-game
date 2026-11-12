// ============================================================
// MOVES HAVE PERSONALITY.
//
//   jsc sim/move-styles.js
//
// Every move funnels through moveCard -> emitFX('move') -> UI._fxCardSlide; a
// card's travel style is ONE entry in UI.MOVE_STYLES. These checks RUN the
// slide, the jump entrance and the card hooks, and watch what they do.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var CSS = read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join('');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
function attempt(name, fn) { try { fn(); } catch (e) { fails.push(name + ' threw: ' + (e.message || e)); } }

// ---- harness ---------------------------------------------------------------
var timers = [];   // queued instead of run, so "what if the animation never ends" is testable
setTimeout = function (fn, ms) { timers.push({ fn: fn, ms: ms || 0 }); return timers.length; };
var rafs = [];
window.requestAnimationFrame = requestAnimationFrame = function (fn) { rafs.push(fn); return rafs.length; };
function flushRaf(max) { for (var i = 0; i < (max || 200) && rafs.length; i++) rafs.shift()(); }
function rect(el, x, y) { el.getBoundingClientRect = function () { return { left: x, top: y, right: x + 100, bottom: y + 140, width: 100, height: 140, x: x, y: y }; }; return el; }
var spy = {};
function stub(name) { spy[name] = []; UI[name] = function () { spy[name].push(Array.prototype.slice.call(arguments)); }; }
['_fxMothDust', '_fxSonicBoom', '_fxEnergyTheft', '_fxSlash', '_fxRing', '_screenShake', '_fxSparks', '_fxHandSwap', '_fxAdamantium', '_fxDeadpoolChaos'].forEach(stub);
UI._reducedMotion = function () { return false; };
var animated = [];
var proto = Object.getPrototypeOf(document.createElement('div'));
proto.animate = function (frames, opts) { animated.push({ el: this, frames: frames, opts: opts }); return { finished: { then: function () {} }, cancel: function () {}, onfinish: null }; };

var fromLane = document.createElement('div');
var fromSlot = rect(document.createElement('div'), 0, 0); fromSlot.className = 'player-slot';
fromLane.appendChild(fromSlot);
UI.laneElAt = function () { return fromLane; };
function board() { return document.getElementById('board') || (function () { var b = document.createElement('div'); b.id = 'board'; document.body.appendChild(b); return b; })(); }
var nextId = 7000;
function tile(x) { var el = rect(document.createElement('div'), x, 0); el.className = 'card'; el.dataset.cardId = String(++nextId); board().appendChild(el); return el; }
function slide(name) {
  var el = tile(400); timers.length = 0; animated.length = 0;
  var bodyKids = document.body.children.length;
  UI._fxCardSlide({ cardId: +el.dataset.cardId, owner: 'player', from: 0, to: 3, name: name });
  return { el: el, added: document.body.children.length - bodyKids };
}

// ---- the style table -------------------------------------------------------
check('Killer Moth flutters', UI.MOVE_STYLES['Killer Moth'] === 'moth');
check('Omni-Man breaks the sound barrier', UI.MOVE_STYLES['Omni-Man'] === 'boom');

// ---- the slide reads it ----------------------------------------------------
attempt('moth slide', function () {
  var r = slide('Killer Moth');
  check('a moth flies a scripted path (Web Animations)', animated.length === 1 && animated[0].frames.length > 2, animated.length);
  check('…sheds dust instead of a trail line', spy._fxMothDust.length === 1 && r.added === 1, 'dust ' + spy._fxMothDust.length + ', body +' + r.added);
  check('…and its path leaves the straight line (flutter)', animated[0] && animated[0].frames.some(function (f) { return /,-[1-9]/.test(f.transform); }));
});
attempt('boom slide', function () {
  slide('Omni-Man');
  check('a boom mover draws the sonic streak', spy._fxSonicBoom.length === 1 && spy._fxSonicBoom[0][4] === undefined);
  check('…fast: shorter than the default slide', animated[0] && animated[0].opts.duration < 420, animated[0] && animated[0].opts.duration);
});
attempt('jet slide', function () {
  spy._fxSonicBoom.length = 0; slide('Jango Fett');
  check('a jet mover leaves a jet wake', spy._fxSonicBoom.length === 1 && spy._fxSonicBoom[0][4] === 'jet');
});
attempt('plain slide', function () {
  var r = slide('Black Widow');
  check('an ordinary card uses the plain CSS slide', animated.length === 0 && r.added === 2, 'anim ' + animated.length + ', body +' + r.added);
  check('the moving card is hidden while its ghost travels', r.el.classList.contains('card-flying'));
  var fallback = timers.filter(function (t) { return t.ms > 420; });
  check('a fallback timer exists in case the animation never reports done', fallback.length >= 1, timers.map(function (t) { return t.ms; }).join(','));
  fallback.forEach(function (t) { t.fn(); });
  check('…and it un-hides the card: it can never stay invisible', !r.el.classList.contains('card-flying'));
});
check('dust, streak and orb styles exist', /\.fx-moth-dust \{/.test(CSS) && /\.fx-sonic-streak \{/.test(CSS) && /\.fx-energy-orb \{/.test(CSS));

// ---- Catwoman ---------------------------------------------------------------
attempt('Catwoman', function () {
  var el = tile(100);
  UI._fxWhenPainted = function (card, cb) { cb(el); };
  UI._fxCatwomanSteal({ id: +el.dataset.cardId, owner: 'player' });
  check('Catwoman shows the stolen energy travelling', spy._fxEnergyTheft.length === 1 && spy._fxEnergyTheft[0][0] === 'player');
});

// ---- the jump entrance -----------------------------------------------------
attempt('jump door', function () {
  Game.init(); Game.seedMatch(5);
  var def = CARD_DEFS.find(function (d) { return d.name === 'Michael Myers'; });
  var card = Game.createCardInstance(def, 'player');
  Game.state.lanes.forEach(function (l) { l.player = null; l.ai = null; });
  Game.state.player.hand.push(card);
  card.jumpReady = true; card.jumpLane = 1;   // Myers jumps to a lane locked in earlier
  var seen = [], realEmit = Game.emitFX;
  Game.emitFX = function (type, data) { seen.push(type + ':' + (data && data.name)); return realEmit.apply(this, arguments); };
  if (Game.state) Game.state._silentSim = false;
  Game.playJumpCard('player', card);
  timers.splice(0).forEach(function (t) { try { t.fn(); } catch (e) {} });
  Game.emitFX = realEmit;
  check('a Jump emits its own FX event from the door every jumper uses', seen.indexOf('jump:Michael Myers') >= 0, seen.join(','));
});
attempt('jump entrance', function () {
  var el = tile(200); el.classList.add('card-flying');
  rafs.length = 0; spy._fxSlash.length = 0;
  UI._fxJumpIn({ cardId: +el.dataset.cardId });
  flushRaf(5);
  check('the entrance waits while the card is still in flight', !el.classList.contains('fx-jump-snap') && spy._fxSlash.length === 0);
  el.classList.remove('card-flying');
  flushRaf(5);
  check('…and fires once it lands', el.classList.contains('fx-jump-snap') && spy._fxSlash.length === 1);
  var ghost = tile(300); ghost.classList.add('card-flying'); rafs.length = 0;
  UI._fxJumpIn({ cardId: +ghost.dataset.cardId });
  flushRaf(500);
  check('…and stops polling if it never lands (bounded)', rafs.length === 0, rafs.length + ' still queued');
});
check('the snap survives the render diff', UI._FX_TRANSIENT_CLASSES.indexOf('fx-jump-snap') >= 0);

// ---- card hooks ---------------------------------------------------------------
function inst(name, side) { return Game.createCardInstance(CARD_DEFS.find(function (d) { return d.name === name; }), side); }
attempt('Deadpool', function () {
  Game.init(); Game.seedMatch(11);
  var dp = inst('Deadpool', 'ai');
  Game.state.player.hand = [inst('Black Widow', 'player'), inst('Groot', 'player')];
  Game.state.ai.hand = [inst('Catwoman', 'ai')];
  CARD_ABILITIES.Deadpool.onDeath(Game, dp, 0);
  timers.splice(0).forEach(function (t) { try { t.fn(); } catch (e) {} });
  var dirs = spy._fxHandSwap.map(function (c) { return c[1]; });
  check('Deadpool shows the swap both ways', dirs.indexOf('steal') >= 0 && dirs.indexOf('give') >= 0, dirs.join(','));
});
attempt('Wolverine', function () {
  var w = inst('Wolverine', 'player');
  CARD_ABILITIES.Wolverine.onDamaged(Game, w, inst('Black Widow', 'ai'));
  check('Wolverine throws adamantium sparks when hit', spy._fxAdamantium.length === 1 && spy._fxAdamantium[0][0] === w);
});

print('move-styles: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('move-styles failed');
