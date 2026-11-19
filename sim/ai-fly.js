// ============================================================
// THE OPPONENT'S PLAYED CARD FLIES IN LIKE YOURS.
//
//   jsc sim/ai-fly.js
//
// A card that was in the opponent's hand on the previous render and is on
// the board now was PLAYED: it flies down from their card backs and its
// landing effects (thump, ring, wave) fire on touchdown, not at placement.
// A card that appears without ever being in their hand (a summon, a revive)
// builds up in place as before. These checks run the real renderBoard.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
function inst(name, side) { return Game.createCardInstance(CARD_DEFS.find(function (d) { return d.name === name; }), side); }

UI._reducedMotion = function () { return false; };
var flights = [], landings = [], thumps = 0;
UI._flyFromEnemyHand = function (el, onLand) { flights.push(el); landings.push(onLand); return true; };
var realThump = UI._landThump;
UI._landThump = function (lane, cost, owner) { if (owner === 'ai') thumps++; };

Game.init(); Game.seedMatch(3);
Game.state.lanes.forEach(function (l) { l.player = null; l.ai = null; });
var played = inst('Bane', 'ai');
Game.state.ai.hand = [played];
UI.renderBoard(Game.state);   // the opponent's hand is recorded as of this render

// The opponent plays it.
Game.state.ai.hand = [];
Game.state.lanes[1].ai = played;
UI.renderBoard(Game.state);
var el = document.querySelector('.board .card[data-card-id="' + played.id + '"]');
check('a card the opponent played flies in from their hand', flights.length === 1 && flights[0] === el, flights.length);
check('…without the in-place build', el && !el.dataset.enterAt);
check('…and does not land before touchdown', thumps === 0, thumps);
if (landings[0]) landings[0]();
check('…and lands (thump) on touchdown', thumps === 1, thumps);

// A summon: on the board without ever being in the opponent's hand.
var summoned = inst('Joker', 'ai');
Game.state.lanes[2].ai = summoned;
UI.renderBoard(Game.state);
var sel = document.querySelector('.board .card[data-card-id="' + summoned.id + '"]');
check('a summoned card does not fly from the hand', flights.length === 1, flights.length);
// The fake DOM runs setTimeout at once, so card-enter is already gone; the
// build path's own stamp (data-enter-at) is what proves it ran.
check('…it builds up in place and lands at once', sel && sel.dataset.enterAt && thumps === 2, (sel && JSON.stringify(sel.dataset)) + ' thumps=' + thumps);

UI._landThump = realThump;
print('ai-fly: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('ai-fly failed');
