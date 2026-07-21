// Deterministic zombie-repro harness.
// Overrides Math.random with a seeded PRNG so startMatch's seed entropy
// (and thus the whole match) is reproducible per game index. Runs games
// until a card is caught at <=0 HP with no _deathHandled/_deathQueued at
// a round boundary, then dumps that card's full state to reveal the path.
//
//   jsc sim/repro-zombie.js -- --max 400

var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');

// Seeded Math.random (mulberry32) so each game is reproducible.
var __mrState = 12345 >>> 0;
function reseed(n) { __mrState = (n >>> 0) || 1; }
Math.random = function () {
  __mrState |= 0; __mrState = (__mrState + 0x6D2B79F5) | 0;
  var t = Math.imul(__mrState ^ (__mrState >>> 15), 1 | __mrState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

var MAX = 400;
for (var i = 0; i < arguments.length; i++) {
  if (arguments[i] === '--max' && arguments[i + 1]) MAX = parseInt(arguments[i + 1], 10);
}

function scanZombies(G, tag, hits) {
  var s = G.state;
  if (!s || !s.lanes) return;
  for (var li = 0; li < s.lanes.length; li++) {
    ['player', 'ai'].forEach(function (side) {
      var c = s.lanes[li][side];
      if (!c) return;
      if (c.currentHealth != null && c.currentHealth <= 0 && !c._deathHandled && !c._deathQueued) {
        hits.push({
          tag: tag, round: s.round, lane: li, side: side,
          name: c.name, hp: c.currentHealth, maxHp: c.maxHealth,
          revive: c.reviveCharges, deathHandled: !!c._deathHandled,
          deathQueued: !!c._deathQueued, frozen: c.frozenTurns | 0,
          armor: c.armorValue | 0, immunity: c.immunityCharges | 0,
          passive: c.passive || null, abilities: (c.abilities || []).slice(0, 6),
        });
      }
    });
  }
}

var G = Game;
var origStart = G.startRound.bind(G);
var origPost = G.postCombat ? G.postCombat.bind(G) : null;
var curHits = null;
G.startRound = function () { if (curHits) scanZombies(G, 'round-start', curHits); return origStart(); };
if (origPost) G.postCombat = function () { var r = origPost.apply(this, arguments); if (curHits) scanZombies(G, 'post-combat', curHits); return r; };

var found = null;
for (var seed = 0; seed < MAX && !found; seed++) {
  reseed(seed + 1);
  curHits = [];
  try { runSimGame(null, null, null); } catch (e) { /* keep hunting */ }
  if (curHits.length > 0) { found = { seed: seed, hits: curHits }; }
}

G.startRound = origStart;
if (origPost) G.postCombat = origPost;

if (!found) {
  print('No zombie reproduced in ' + MAX + ' seeded games.');
} else {
  print('ZOMBIE reproduced at game seed ' + found.seed + ' — ' + found.hits.length + ' hit(s):');
  // Dedupe by name+tag so the dump is readable.
  var seen = {};
  found.hits.forEach(function (h) {
    var k = h.name + '|' + h.tag;
    if (seen[k]) return; seen[k] = 1;
    print('  ' + JSON.stringify(h));
  });
}
