// ============================================================
// sim/mpwire.js — MULTIPLAYER WIRE BUDGET + BROADCAST COALESCING
//
// The host is authoritative and pushes a FULL state snapshot on every action,
// so two things decide how laggy online play feels:
//   1. how many BYTES each snapshot costs, and
//   2. how many snapshots one player action actually sends.
// Both silently regress the moment someone adds a fat field to state or a new
// broadcast call site, and neither is visible in a normal match — you only feel
// it as "multiplayer is laggy." This suite pins both.
//
// Run via sim/run-tests.sh.
// ============================================================
load('./multiplayer.js');
load('./sim/shim.js');

var pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; print('  ok   ' + label + (detail ? '   (' + detail + ')' : '')); }
  else    { fail++; print('  FAIL ' + label + (detail ? '   (' + detail + ')' : '')); }
}

// ---- Build a representative mid-match state -----------------
function midMatchState() {
  Game.init();
  Game.state.mode = { deck: 'classic', players: '1v1' };
  try { Game.startMatch({ deck: 'classic', players: '1v1' }); } catch (e) {}
  Game.state.phase = 'combat';
  for (var i = 0; i < Game.LANE_COUNT; i++) {
    try {
      Game.state.lanes[i].player = Game.createCardInstance(CARD_DEFS[(i * 4) % CARD_DEFS.length], 'player');
      Game.state.lanes[i].ai     = Game.createCardInstance(CARD_DEFS[(i * 7 + 3) % CARD_DEFS.length], 'ai');
    } catch (e) {}
  }
  for (var j = 0; j < 300; j++) Game.log('filler log line ' + j + ' with some detail text');
  return Game.state;
}

print('=== MP WIRE BUDGET ===');
var st = midMatchState();
var wire = Multiplayer.serializeState(st);
var bytes = JSON.stringify(wire).length;

// Budget: a full mid-match snapshot must stay well under the pre-trim ~55 KB.
// Generous ceiling so ordinary content growth doesn't trip it -- this catches a
// whole hidden pile or pool sneaking back onto the wire, not a few new fields.
check('snapshot under 40 KB budget', bytes < 40000, bytes + ' bytes');

// The shared summon lottery pool must never ride the wire: it was 41% of the
// payload, the guest never draws from it (host resolves + broadcasts results),
// and drawFromSummonDeck self-heals via _initSummonDeck when it is absent.
check('summonDeck stripped', wire.summonDeck === undefined);

// Hidden piles ship as {id} stubs only -- the guest renders them by .length.
// Carrying names would also leak the exact draw order to the other client.
function stubbedOnly(pile) {
  if (!Array.isArray(pile)) return true;
  for (var i = 0; i < pile.length; i++) {
    var c = pile[i];
    if (c && c.name !== undefined) return false;
  }
  return true;
}
check('drawPile carries no card names',      stubbedOnly(wire.drawPile));
check('trickDrawPile carries no card names', stubbedOnly(wire.trickDrawPile));
check('per-side drawPiles stubbed',
  stubbedOnly(wire.player && wire.player.drawPile) && stubbedOnly(wire.ai && wire.ai.drawPile));

// Visible zones must survive intact -- the guest RENDERS these, so a stub here
// would blank the board. Guards against an over-eager future trim.
check('lanes still carry named cards',
  !!(wire.lanes && wire.lanes[0] && wire.lanes[0].player && wire.lanes[0].player.name));

print('');
print('=== BROADCAST COALESCING ===');
// One player action fans out through the 13 wrapBroadcast-wrapped engine fns
// plus _mpApplyAction's trailing push. Only the LAST snapshot is observable, so
// they must collapse to a single send per synchronous action.
var sends = 0;
Game.mp = { role: 'host', you: 'player', opp: 'ai' };
Game.isMultiplayer = function () { return true; };
Multiplayer._transport = { broadcastState: function () { sends++; } };

for (var k = 0; k < 8; k++) Game._mpBroadcast();
check('8 calls send nothing synchronously', sends === 0, sends + ' sends');

Promise.resolve().then(function () {
  check('collapses to ONE send after drain', sends === 1, sends + ' sends');
  sends = 0;
  Game._mpBroadcast();
  Game._mpBroadcast();
  return Promise.resolve();
}).then(function () {
  // A later action must still get through -- coalescing must not swallow the
  // final flush of a chain, or the guest freezes on a stale board.
  check('a second action still sends', sends === 1, sends + ' sends');

  sends = 0;
  Game._mpBroadcast(true);
  check('immediate=true bypasses coalescing', sends === 1, sends + ' sends');

  // Damage-preview dry runs swap in a cloned state; they must never hit the
  // wire or the guest sees cards the host is merely hovering.
  sends = 0;
  Game.state._silentSim = true;
  Game._mpBroadcast();
  delete Game.state._silentSim;
  check('_silentSim preview never sends', sends === 0, sends + ' sends');

  print('');
  print('=== ' + pass + ' passed, ' + fail + ' failed ===');
  if (fail > 0) { print('MP WIRE SUITE FAILED'); throw new Error('mpwire failures: ' + fail); }
});
