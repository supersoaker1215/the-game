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

// ============================================================
// L2-6 — THE BLOCK QUEUE IS HOST-AUTHORITATIVE.
//
// Every client resolves combat locally for its own animation. Without a gate,
// all four of them ran the block-meter branch: each POPPED the shared
// tt.trickDrawPile — one block consuming up to eight cards instead of two —
// each built its own queue, and each armed its own pendingBlockTrick. The host
// then broadcast its version over the top, so a guest's offer could be replaced
// mid-decision by a different one, or vanish outright.
//
// That is the "free trick on block is STILL skipping" that survived two earlier
// fixes: both of those were on the host's path, and the host's path was never
// the broken one. This case is written from the GUEST's chair for that reason.
// ============================================================
t('L2-6 a guest neither draws the block tricks nor arms the offer', function () {
  // Drive a REAL block: prime the meter to one short and take a hit. That is
  // the path that pops the pile, and it is the one all four clients were
  // running. A test that only pokes _2v2NextBlockTrick misses it entirely —
  // that function returns early on an empty queue either way.
  var run = function (youSeat) {
    var tt = table(true);
    tt.you = youSeat;
    tt.players.p3.isAI = true;
    Game.state.phase = '2v2-combat';
    Game.state.pendingBlockTrick = null;
    Game.state._2v2BlockQueue = null;
    Game.state.log = [];
    var side = Game._2v2TeamSide['A'];
    var pile0 = tt.trickDrawPile.length;
    Game.state[side].blockMeter = Game.BLOCK_MAX - 1;
    Game.damagePlayer(side, 3, false, null);
    var drew = 0;
    (Game.state.log || []).forEach(function (l) { if (/BLOCK DRAW/.test(l)) drew++; });
    return { authority: Game._2v2IsAIAuthority(), taken: pile0 - tt.trickDrawPile.length, drew: drew };
  };

  var guest = run('p2');
  eq('a guest is not the authority', guest.authority, false);
  eq('so it takes NO cards from the shared pile', guest.taken, 0);
  eq('and logs no draws',                          guest.drew, 0);

  var host = run('p1');
  eq('the host is the authority', host.authority, true);
  eq('and draws exactly one per teammate', host.taken, 2);
  eq('logging both',                       host.drew, 2);
});

t('L2-7 local pass-and-play still counts as the authority', function () {
  var tt = table(false);               // not online
  tt.you = 'p1';
  eq('local play drives its own queue', Game._2v2IsAIAuthority(), true);
});

// ============================================================
// L2-8 — A SECOND BLOCK MUST NOT EAT THE FIRST ONE'S QUEUE.
//
// Combat resolves lane by lane, so both teams can fill a meter in the same
// combat (and one team can fill it twice). The queue was ASSIGNED, so the
// second block threw away whatever the first was still working through — a
// teammate who had not been offered their trick yet never was, and the card
// already popped off the shared pile was gone. The same call then re-entered
// the drain over a live modal and overwrote the offer being decided on.
// (Owner: "the tricks being drawn in 2v2 is still not working all the time,
// its like it passe sthrough the syetm and sometimes doenst haoppen
// immediatly ... its so simple")
// ============================================================
t('L2-8 a second block queues behind the first instead of erasing it', function () {
  var tt = table(false);                 // local host = the authority
  Game.state.phase = '2v2-combat';
  Game.state.pendingBlockTrick = null;
  Game.state._2v2BlockQueue = null;
  Game.state.log = [];
  var pile0 = tt.trickDrawPile.length;
  // The engine decides which teammate is offered first (the seat that plays
  // cards+tricks this round, then the seat that plays tricks before combat) —
  // read it rather than assuming, so this pins the QUEUE, not the order.
  var order = Game._2v2BlockTrickOrder('A');

  // Team A (p1 + p3, both human) blocks. The first offer arms a modal and the
  // queue PAUSES there with the other seat's entry still in it.
  Game.state[Game._2v2TeamSide['A']].blockMeter = Game.BLOCK_MAX - 1;
  Game.damagePlayer(Game._2v2TeamSide['A'], 3, false, null);
  var firstOffer = Game.state.pendingBlockTrick;
  eq('an offer is up', !!firstOffer, true);
  eq('routed to the first seat', firstOffer._2v2Seat, order[0]);
  eq('one teammate still waiting', (Game.state._2v2BlockQueue || []).length, 1);

  // Now team B blocks, mid-decision.
  Game.state[Game._2v2TeamSide['B']].blockMeter = Game.BLOCK_MAX - 1;
  Game.damagePlayer(Game._2v2TeamSide['B'], 3, false, null);

  eq('the live offer is untouched', Game.state.pendingBlockTrick, firstOffer);
  eq('the teammate is still owed a trick, and B is queued behind',
     (Game.state._2v2BlockQueue || []).length, 3);
  eq('four cards left the pile, one per teammate', pile0 - tt.trickDrawPile.length, 4);

  // The first seat answers: the queue advances to their TEAMMATE, not past them.
  Game._2v2ResolveBlockTrick(order[0], firstOffer, false);
  eq('now it is the teammate\'s turn', (Game.state.pendingBlockTrick || {})._2v2Seat, order[1]);

  // And once they answer, both AI seats on team B resolve themselves.
  Game._2v2ResolveBlockTrick(order[1], Game.state.pendingBlockTrick, false);
  eq('queue drained', (Game.state._2v2BlockQueue || []).length, 0);
  eq('no offer left hanging', Game.state.pendingBlockTrick, null);
});

// ============================================================
// L2-9 — the pile running dry is not an excuse to skip a teammate.
// ============================================================
t('L2-9 both teammates are paid even when the trick pile runs out', function () {
  var tt = table(false);
  Game.state.phase = '2v2-combat';
  Game.state.pendingBlockTrick = null;
  Game.state._2v2BlockQueue = null;
  Game.state.log = [];
  tt.trickDrawPile = [{ name: 'LastOne', cost: 3, desc: 'x' }];   // one card left

  Game.state[Game._2v2TeamSide['A']].blockMeter = Game.BLOCK_MAX - 1;
  Game.damagePlayer(Game._2v2TeamSide['A'], 3, false, null);

  var drew = 0;
  (Game.state.log || []).forEach(function (l) { if (/BLOCK DRAW/.test(l)) drew++; });
  eq('two draws logged, not one', drew, 2);
  // One offered now, one still queued behind it.
  eq('an offer is up', !!Game.state.pendingBlockTrick, true);
  eq('the teammate is queued', (Game.state._2v2BlockQueue || []).length, 1);
});

// ============================================================
// L2-10 — a card acts for ITS OWN seat in a local 2v2, not the last one
//         that happened to move.
// ============================================================
// Owner: "jack sparrow in 2v2 parlay is nt working."
//
// _2v2ActFor is what resolveCombat calls before each card's onBeforeCombat so
// the hook acts for the seat that owns the card, and isHuman(side) in 2v2
// answers by asking that acting seat. It was gated on tt.online — the same
// substitution as L2-1 and L2-2 — so in local play it did nothing and the stale
// seat stood. Jack's Parlay fires from the one moment in a 2v2 round when no
// seat is taking a turn, so the stale seat was routinely the BOT teammate:
// isHuman came back false, Jack took his AI branch, and the human never saw the
// prompt.
//
// The assertion is the MECHANISM, not the outcome. Both branches parlay
// somebody, so "an enemy got parlayed" passes either way; what was wrong is
// WHICH branch ran, and that is what isHuman decides.
function parlayTable(online) {
  var tt = table(online);
  tt.players.p1.isAI = false;   // the human
  tt.players.p3.isAI = true;    // bot teammate, same side
  Game.state.round = 3;
  return tt;
}
function seat(name, side, lane, playedBy) {
  var def = CARD_DEFS.find(function (d) { return d.name === name; });
  var c = Game.createCardInstance(def, side);
  if (playedBy) c._2v2PlayedBy = playedBy;
  Game.state.lanes[lane][side] = c;
  return c;
}

t('L2-10 _2v2ActFor corrects a stale acting seat in a LOCAL 2v2', function () {
  parlayTable(false);
  var jack = seat('Jack Sparrow', 'player', 0, 'p1');   // the HUMAN played him
  // What a real combat leaves behind: the last seat to have acted was the bot.
  Game._2v2CurrentActingPlayer = 'p3';
  eq('a stale bot seat reads the side as non-human', Game.isHuman('player'), false);
  Game._2v2ActFor(jack);
  eq('the acting seat is corrected to the card owner', Game._2v2CurrentActingPlayer, 'p1');
  eq('so the side reads human again', Game.isHuman('player'), true);
});

t('L2-10b local and online agree about who owns a combat-time hook', function () {
  var seen = {};
  [false, true].forEach(function (online) {
    parlayTable(online);
    var jack = seat('Jack Sparrow', 'player', 0, 'p1');
    Game._2v2CurrentActingPlayer = 'p3';
    Game._2v2ActFor(jack);
    seen[online ? 'online' : 'local'] = Game.isHuman('player');
  });
  eq('local answers human', seen.local, true);
  eq('online answers human', seen.online, true);
  eq('and they agree', seen.local, seen.online);
});

t('L2-10c Jack asks the human instead of auto-picking, in a local 2v2', function () {
  parlayTable(false);
  var jack = seat('Jack Sparrow', 'player', 0, 'p1');
  seat('Hulk', 'ai', 2, 'p2');
  seat('Bane', 'ai', 4, 'p4');
  Game._2v2CurrentActingPlayer = 'p3';       // stale bot seat, as combat leaves it

  var asked = null;
  var origPL = Game.promptLaneChoice;
  Game.promptLaneChoice = function (owner, lanes, title) {
    asked = { owner: owner, lanes: lanes.slice(), title: title };
    // Do NOT resolve — the point is whether the question was asked at all.
  };
  // Exactly what resolveCombat's pre-combat pass does.
  Game._2v2ActFor(jack);
  jack.onBeforeCombat(Game, jack, Game.findCardLane(jack));
  Game.promptLaneChoice = origPL;

  eq('the human is asked', !!asked, true);
  eq('and asked about the right lanes', asked && JSON.stringify(asked.lanes), JSON.stringify([2, 4]));
  // Nothing was decided for them.
  eq('no enemy was parlayed behind their back',
     [2, 4].filter(function (i) { return !!Game.state.lanes[i].ai._parlayedThisRound; }).length, 0);
});

// ============================================================
// L2-11 — the upkeep queue is drained in a 2v2 too.
// ============================================================
// 1v1's startRound has always ended with
//   this._resolveUpkeepPrompts(() => this.startPhase1())
// and start2v2Round back-ported the rest of that block but not that line —
// while being the only other round-start in the file. So in 2v2 the queue was
// filled every round by onTurnStart and drained by nothing, and the two cards
// that live entirely in it had never worked in a 2v2 at all: Gargantua never
// pulled, and the Enclosure never asked for its toll, so its gate could not
// open and the T-Rex could not be released. (Owner, watching an Enclosure event
// place two paddocks and then do nothing for the rest of the match: "for the t
// rex enclosure event 2 enviromens should spwan like open water and jaws".)
t('L2-11 a 2v2 round drains the upkeep queue', function () {
  table(false);
  Game.state.round = 3;
  var gate = Game._placeEventEnvironment('player', 2, 'Enclosure');
  var garg = Game._placeEventEnvironment('ai', 5, 'Gargantua');
  eq('the gate is standing', !!gate, true);
  eq('Gargantua is standing', !!garg, true);

  var drains = 0;
  var orig = Game._resolveUpkeepPrompts;
  Game._resolveUpkeepPrompts = function (cb) { drains++; return orig.call(Game, cb); };
  Game.state.round = 4;
  Game.start2v2Round();
  Game._resolveUpkeepPrompts = orig;

  eq('the round asked the upkeeps', drains > 0, true);
  eq('and left nothing queued', (Game.state._pendingUpkeep || []).length, 0);
});

// ---- run ----------------------------------------------------
// ============================================================
// L2-9 — THE STACK DOES NOT CROSS A 2v2 ROUND.
// ============================================================
// Owner: "after round 11 the game strats to break doen, it gets laggy and bugs
// start spawing that dont happen ealier on."
//
// _stackDrain returns the instant _promptBusy() is true — correct, a prompt
// owns the turn — so anything queued while a prompt sits armed waits for a
// resume. startRound has cleared the stack since it landed, which bounds that
// wait to one round. start2v2Round back-ported the rest of that block and NOT
// that line, so in 2v2 the queue only ever grew. Measured over a long game
// (sim/lategame-growth.js) it went 0 -> 6 -> 20 -> 49 by round 9 and never came
// back down, with ms/round rising 4.5x alongside it — and the stranded entries
// were real effects (arrival hooks, onAnyCardPlayed reactions) that simply
// stopped firing. That is the shape of the report: not new bad behaviour, but
// old good behaviour quietly switching off partway through a match.
t('L2-9 start2v2Round clears queued stack events, exactly as startRound does', function () {
  table(false);
  var ran = 0;
  Game._stack.push({ type: 'call', label: 'stranded:test', fn: function () { ran++; } });
  Game._stack.push({ type: 'call', label: 'stranded:test2', fn: function () { ran++; } });
  eq('two events are queued', Game._stack.length, 2);
  Game.start2v2Round();
  eq('a new 2v2 round starts with an empty stack', Game._stack.length, 0);
  // and 1v1 has always done this — the two round starts agree now.
  Game.init();
  Game._stack.push({ type: 'call', label: 'stranded:1v1', fn: function () {} });
  Game.startRound();
  eq('1v1 agrees', Game._stack.length, 0);
});

// ============================================================
// L2-10 — a prompt freezes the drain, and clearing it must UNfreeze it.
// ============================================================
// The 2v2 stall watchdog force-clears pendingKangChoice/pendingJumpOffer so a
// wedged table can continue. It did not drain afterwards, so everything the
// prompt had been holding back stayed queued — the table unstuck and the
// effects stayed lost. This pins the underlying contract the watchdog now
// relies on: busy => nothing drains, cleared => it all runs.
t('L2-10 a pending prompt freezes the stack drain; clearing it releases the queue', function () {
  table(false);
  Game._stackClear('test');
  var ran = 0;
  Game.state.pendingJumpOffer = { cardId: 'x', owner: 'player' };
  Game._stack.push({ type: 'call', label: 'held', fn: function () { ran++; } });
  Game.resolveStack();
  eq('nothing runs while a prompt owns the turn', ran, 0);
  eq('and the event is still queued, not dropped', Game._stack.length, 1);
  Game.state.pendingJumpOffer = null;
  Game.resolveStack();
  eq('clearing the prompt releases it', ran, 1);
  eq('and the queue empties', Game._stack.length, 0);
});

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
