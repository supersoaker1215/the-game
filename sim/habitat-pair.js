// ============================================================
// A TWO-ROOM EVENT NEVER SPLITS ITS PAIR.
//
//   jsc sim/habitat-pair.js
//
// Owner (2026-11-11, screenshot): "again why did sewers spawn in a contested
// and open lane that should never happen". The pair rule is: both rooms on a
// card, or both on empty ground. The runner drew the FIRST lane at random and
// only then looked for a matching partner — so with one body on the board and
// the first draw landing on it, no empty lane could match and it fell back to
// a split pair, even though two empty lanes were sitting right there.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
function card(name, side) { var d = CARD_DEFS.find(function (x) { return x.name === name; }); return Game.createCardInstance(d, side); }
function run(seed, setup, place) {
  Game.init(); Game.seedMatch(seed);
  Game.state.lanes.forEach(function (l) { l.player = null; l.ai = null; l._env = null; });
  setup(Game);
  var h = { name: 'IT', place: place || 'Sewers', shows: true, fired: false, appearAt: 3 };
  Game._runHabitatEvent(h, 3);
  return { h: h, kinds: (h.seated || []).map(function (x) { var L = Game.state.lanes[x.lane]; return !!(L.player || L.ai); }) };
}
// The owner's board: one contested lane (an enemy body), the rest empty.
var split = 0, seated = 0;
for (var seed = 1; seed <= 120; seed++) {
  var r = run(seed, function (G) { G.state.lanes[2].ai = card('Black Widow', 'ai'); });
  if (r.kinds.length === 2) { seated++; if (r.kinds[0] !== r.kinds[1]) split++; }
}
check('one enemy body + open lanes: the pair NEVER splits (120 seeds)', split === 0, split + ' of ' + seated + ' split');
check('…and the event still lands (two empty lanes exist)', seated === 120, seated + ' of 120 seated');
// Two bodies: both rooms may go on cards or both on empty ground — never mixed.
split = 0;
for (seed = 1; seed <= 60; seed++) {
  var r2 = run(seed, function (G) { G.state.lanes[0].ai = card('Catwoman', 'ai'); G.state.lanes[1].player = card('Groot', 'player'); });
  if (r2.kinds.length === 2 && r2.kinds[0] !== r2.kinds[1]) split++;
}
check('two bodies on the board: never a mixed pair', split === 0, split + ' split');
// Only two env-free lanes left and they DIFFER: no legal pair exists — it waits.
var w = run(7, function (G) {
  G.state.lanes[0].ai = card('Catwoman', 'ai');
  for (var i = 2; i < G.LANE_COUNT; i++) G.state.lanes[i]._env = { player: { name: 'X' }, ai: null };
});
check('no matching pair possible: the event WAITS instead of splitting', !w.h.fired && !(w.h.seated && w.h.seated.length), JSON.stringify(w.h.seated || null));
print('habitat-pair: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('habitat-pair failed');
