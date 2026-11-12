// ============================================================
// OVERDRIVE IS SEEN, NOT JUST LOGGED.
//
//   jsc sim/overdrive-callout.js
//
// Overdrive ("attacks again after killing an enemy") had no tell:
// handleOverdrive only wrote a log line, so the chain read as ordinary extra
// hits. Measured live after: King Shark (Overdrive, 9 ATK) kills a 2-HP
// blocker → "OVERDRIVE" callout over King Shark at 421ms (the kill's beat),
// colour rgb(255,138,122) = --kw-overdrive, then the extra swing hits face for 9.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');
var GAME = read('game.js'), UIJS = (read('ui.js') + '\n' + read('fx.js'))   /* fx.js = the effects library split out of ui.js */, CSS = (read('style-parts.txt').trim().split('\n').map(function (f) { return read(f); }).join(''));
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }

// Engine: a real contested lane, through the real door.
Game.init(); Game.seedMatch(0x0d);
var s = Game.state; s.mode = { deck: 'classic', players: '1v1' }; s.round = 4; s.phase = 'combat';
for (var i = 0; i < Game.LANE_COUNT; i++) { s.lanes[i].player = null; s.lanes[i].ai = null; s.lanes[i].destroyed = false; }
var od = CARD_DEFS.find(function (d) { return (d.abilities || []).indexOf('Overdrive') >= 0 && d.attack > 0 && !d._spawnOnly; });
var plain = CARD_DEFS.filter(function (d) { return d.attack > 0 && d.health > 0 && !d._spawnOnly && !d.isEnvironment && !d.isDiscardEffect && !(d.abilities || []).length; });
var me = Game.createCardInstance(od, 'player'); me.owner = 'player'; me.attack = 9; me.currentHealth = me.maxHealth = 12; s.lanes[1].player = me;
var foe = Game.createCardInstance(plain[1], 'ai'); foe.owner = 'ai'; foe.attack = 1; foe.currentHealth = foe.maxHealth = 2; s.lanes[1].ai = foe;
var seqBefore = (s._fx && s._fx.seq) || 0;
Game.resolveLaneCombat(1, function () {});
var evs = ((s._fx && s._fx.events) || []).filter(function (e) { return e.type === 'overdrive'; });
check('a kill by an Overdrive card emits an overdrive FX event', evs.length >= 1, JSON.stringify(evs));
if (evs.length) {
  check('…carrying the card, its lane, its owner and the chain link', evs[0].cardId === me.id && evs[0].lane === 1 && evs[0].owner === 'player' && evs[0].chain === 1, JSON.stringify(evs[0]));
  check('…grouped with the kill that triggered it (attackerId)', evs[0].attackerId === me.id);
}
check('a chained Overdrive counts the next link', /this\.handleOverdrive\(card, laneIdx, chain \+ 1\)/.test(GAME));

// Presentation.
check('it plays on the combat track (in order with its hits)', /combat:\s*\[[^\]]*'overdrive'/.test(UIJS));
check('the dispatcher draws it', /if \(ev\.type === 'overdrive'\) \{\s*this\._fxOverdrive\(ev\);/.test(UIJS));
check('drawn on the body-level FX layer (survives renders)', /_fxOverdrive\(ev\) \{[\s\S]{0,300}this\._fxLaneStage\(ev\.lane, 'overdrive-stage'\)/.test(UIJS));
check('in the keyword\'s own colour token', /\.od-callout \{[^}]*color:\s*var\(--kw-overdrive\)/.test(CSS));
check('reduced motion keeps the text (beats the 0.01ms catch-all)', /\.od-callout \{ animation: odFade[^}]*animation-duration: 800ms !important/.test(CSS));

print('overdrive-callout: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('overdrive-callout failed');
