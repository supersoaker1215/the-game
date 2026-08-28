// ============================================================
// A LOCAL 2v2 IS STILL A 2v2.
//
//   jsc sim/local-2v2.js
//
// Two owner reports, one mistake underneath both: `tt.online` used as
// a stand-in for "this table has seats". Online says whether there is
// somebody on the far end of a wire. It says nothing about where the
// cards are — and in EVERY 2v2, online or not, the hands live on the
// four seat objects, not on the two side proxies.
//
//   1. "in 2v2 doomsday when player cards die he doesnt reduce cost"
//      His discount walks seatStatesOnSide(), which returned the side
//      proxy unless tt.online. The proxy's hand is empty in 2v2, so the
//      scan found no Doomsday and he cost full price all game. The same
//      helper carries the per-seat sleep tick and a side-wide draw, so
//      those were silently wrong in local play too.
//
//   2. "my ai teammate always gets a trick and it skips me then
//       eventually the next turn my trick will pop up NO — when you
//       block you draw a trick to play for free and the round cannot go
//       on until the 2 players have decided to either play or keep"
//      The block-meter offer queue — the thing that shows each teammate
//      their trick and PAUSES the round until both answer — was gated on
//      tt.online. Local 2v2 instead pushed a free trick silently into
//      each teammate's trick hand: nothing popped up, the bot teammate
//      played its copy on its own turn, and the human's just sat there
//      until they happened to look a turn later. Exactly the report.
//
// The queue was always sequential — one offer at a time — so the old
// reasoning ("two live modals don't fit one device") never applied.
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

function table(online) {
  Game.start2v2Match({ names: { p1: 'Henry', p2: 'Vega', p3: 'Ryan', p4: 'Bot2' },
                       teamAssignment: { A: ['p1', 'p3'], B: ['p2', 'p4'] } });
  var tt = Game.state.twoVTwo;
  tt.online = !!online;
  tt.you = 'p1';
  tt.players.p2.isAI = true; tt.players.p4.isAI = true;
  Game.state.round = 3;
  tt.trickDrawPile = [];
  for (var i = 0; i < 8; i++) tt.trickDrawPile.push({ name: 'Trick' + i, cost: 3, desc: 'x' });
  ['p1', 'p2', 'p3', 'p4'].forEach(function (pk) { tt.players[pk].trickHand = []; });
  return tt;
}
function doomsdayDef() {
  for (var i = 0; i < CARD_DEFS.length; i++) if (CARD_DEFS[i].name === 'Doomsday') return CARD_DEFS[i];
  throw new Error('no Doomsday def');
}

// ============================================================
// L2-1 — the seat helpers see seats in BOTH kinds of 2v2.
// ============================================================
t('L2-1 seatStatesOnSide finds both seats whether or not the table is online', function () {
  [false, true].forEach(function (online) {
    table(online);
    eq('online=' + online + ': side A has 2 seats', Game.seatStatesOnSide('player').length, 2);
    eq('online=' + online + ': side B has 2 seats', Game.seatStatesOnSide('ai').length, 2);
    eq('online=' + online + ': keys pair by index', Game.seatKeysOnSide('player').length, 2);
  });
  // 1v1 is untouched — no twoVTwo at all, so it collapses to the side proxy.
  Game.init();
  eq('1v1 collapses to the proxy', Game.seatStatesOnSide('player').length, 1);
  eq('1v1 has no seat keys', Game.seatKeysOnSide('player')[0], null);
});

// ============================================================
// L2-2 — the reported bug: Doomsday's discount, in a LOCAL 2v2.
// ============================================================
t('L2-2 Doomsday loses 1 cost per ally death in a local 2v2', function () {
  [false, true].forEach(function (online) {
    var tt = table(online);
    var side = Game._2v2TeamSide['A'];
    var mk = function () { var c = Game.createCardInstance(doomsdayDef(), side); Game.applyAbilities(c); return c; };
    var inP1 = mk(), inP3 = mk();
    tt.players.p1.hand.push(inP1);
    tt.players.p3.hand.push(inP3);
    var cost0 = inP1.cost;
    Game._scaleDoomsdayInHands(side);
    eq('online=' + online + ': the seat that is acting gets the discount', inP1.cost, cost0 - 1);
    eq('online=' + online + ': the OTHER teammate does too',              inP3.cost, cost0 - 1);
    // An enemy death must not discount him.
    Game._scaleDoomsdayInHands(Game.opponent(side));
    eq('online=' + online + ': an enemy death changes nothing', inP1.cost, cost0 - 1);
  });
});

// ============================================================
// L2-3 — the block offer queues BOTH teammates in a local 2v2.
// ============================================================
t('L2-3 a local block queues an offer for each teammate', function () {
  var tt = table(false);
  var order = Game._2v2BlockTrickOrder('A');
  eq('both seats on the team are offered', order.length, 2);
  eq('they are the right two', order.slice().sort().join(','), 'p1,p3');
});

// ============================================================
// L2-4 — the human's offer ARMS and holds the round; it is not pushed
//        silently into their trick hand.
// ============================================================
t('L2-4 the human seat gets an offer, not a silent trick', function () {
  var tt = table(false);
  tt.players.p3.isAI = true;          // AI teammate, human p1 — the reported table
  var queue = [];
  Game._2v2BlockTrickOrder('A').forEach(function (pk) {
    var def = tt.trickDrawPile.pop();
    queue.push({ seat: pk, trick: { name: def.name, cost: def.cost, desc: def.desc,
                                    id: 90000 + queue.length, _blockRound: Game.state.round } });
  });
  Game.state._2v2BlockQueue = queue;
  Game.state.pendingBlockTrick = null;
  Game.state.log = [];
  Game._2v2NextBlockTrick();
  // THE ROUND IS NOW WAITING ON THE PERSON. That is the whole ask: the bot
  // teammate resolves itself, and the human's offer sits armed against their
  // seat instead of being dropped into their trick hand behind their back.
  var log = (Game.state.log || []).join('\n');
  var pending = Game.state.pendingBlockTrick;
  eq('the human has a live offer', !!pending, true);
  eq('and it is stamped to their seat', pending && pending._2v2Seat, 'p1');
  eq('nothing was slipped into their trick hand', tt.players.p1.trickHand.length, 0);
  eq('the AI teammate resolved its own', /BLOCK TRICK\] Ryan/.test(log), true);
  eq('nobody got the old silent free-draw', /draws: .* \(free to play\)/.test(log), false);

  // Answering it drains the queue and releases the round.
  Game._2v2ResolveBlockTrick('p1', pending, false);
  eq('the offer cleared', Game.state.pendingBlockTrick, null);
  eq('the human now holds the trick', tt.players.p1.trickHand.length, 1);
  eq('the queue is empty', (Game.state._2v2BlockQueue || []).length, 0);
});

// ============================================================
// L2-5 — the block path no longer forks on `online` at all.
// ============================================================
t('L2-5 one block-trick behaviour for every 2v2', function () {
  var src = readFile('./game.js');
  var i = src.indexOf('the team earns a free trick for EACH teammate');
  eq('found the 2v2 block branch', i > 0, true);
  if (i < 0) return;
  var seg = src.slice(i, i + 1400);
  eq('the queue is not gated on online', /twoVTwo\.online\)\s*\{/.test(seg.split('\n').slice(0, 22).join('\n')), false);
  eq('the silent local draw is gone', src.indexOf('2v2 local pass-and-play: both teammates draw') < 0, true);
  eq('_blockFree is no longer handed out on block', /_blockFree: true/.test(src), false);
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
print('local-2v2: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
