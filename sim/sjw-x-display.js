// ============================================================
// SUNG JIN-WOO PRINTS "X" UNTIL HE HAS AN X.
//
//   jsc sim/sjw-x-display.js
//
// Owner: "for sung jin woo these should all be X" (draft card: cost, ATK, HP
// all read 5). Measured live after: a draft/codex tile reads X / X / X with
// its art. In hand he still prints the live X (his cost = your energy), and on
// the board the body he was paid for.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
function readEl(el) {
  var h = el.innerHTML || el.outerHTML || '';
  var c = /class="card-cost"[^>]*>([^<]*)</.exec(h), a = /stat-atk[^"]*"[^>]*>(?:<[^>]*>)*\s*([^<\s]+)/.exec(h), p = /stat-hp[^"]*"[^>]*>(?:<[^>]*>)*\s*([^<\s]+)/.exec(h);
  return { cost: c && c[1].trim(), atk: a && a[1], hp: p && p[1] };
}
Game.init(); Game.seedMatch(3);
var s = Game.state;
for (var i = 0; i < Game.LANE_COUNT; i++) { s.lanes[i].player = null; s.lanes[i].ai = null; }
var def = CARD_DEFS.find(function (d) { return d.name === 'Sung Jin-Woo'; });

var draft = readEl(UI.makeCardEl(Game.createCardInstance(def, 'player'), false, 'ally'));
check('draft / codex instance prints X for cost, ATK and HP', draft.cost === 'X' && draft.atk === 'X' && draft.hp === 'X', JSON.stringify(draft));
var raw = readEl(UI.makeCardEl(def, false, 'ally'));
check('a raw def (pickers) prints X too', raw.cost === 'X' && raw.atk === 'X' && raw.hp === 'X', JSON.stringify(raw));

var inHand = Game.createCardInstance(def, 'player'); inHand.owner = 'player'; s.player.hand = [inHand]; s.player.currency = 7;
var hand = readEl(UI.makeCardEl(inHand, true, 'ally'));
check('in hand he prints the live X (energy 7)', hand.cost === '7' && hand.atk === '7' && hand.hp === '7', JSON.stringify(hand));

var onBoard = Game.createCardInstance(def, 'player'); onBoard.owner = 'player';
Game._lockEnergyScaled(onBoard, 6); s.lanes[2].player = onBoard;
var board = readEl(UI.makeCardEl(onBoard, false, 'ally'));
check('on the board he prints the body he was paid for', board.cost === '6' && board.atk === '6' && board.hp === '6', JSON.stringify(board));

var other = readEl(UI.makeCardEl(Game.createCardInstance(CARD_DEFS.find(function (d) { return d.name === 'Thor'; }), 'player'), false, 'ally'));
check('every other card is untouched', other.cost !== 'X' && other.atk !== 'X', JSON.stringify(other));

print('sjw-x-display: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('sjw-x-display failed');
