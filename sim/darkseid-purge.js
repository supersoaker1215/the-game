// ============================================================
// DARKSEID'S PURGE ONLY OFFERS LANES THAT ARE STILL CONTESTED.
//
//   jsc sim/darkseid-purge.js
//
// The purge prompts once per lane. Destroying a lane runs death triggers
// (Knull, revives, moves) that can empty a side of another lane between two
// prompts; the next prompt must re-check, or building its "X vs Y" label
// dereferences the empty side and the whole chain throws.
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
function inst(name, side) { return Game.createCardInstance(CARD_DEFS.find(function (d) { return d.name === name; }), side); }

Game.init(); Game.seedMatch(7);
var L = Game.state.lanes;
L.forEach(function (l) { l.player = null; l.ai = null; l.destroyed = false; });
var dark = inst('Darkseid', 'player'); L[0].player = dark;
L[1].player = inst('Black Widow', 'player'); L[1].ai = inst('Joker', 'ai');
L[2].player = inst('Groot', 'player');       L[2].ai = inst('Catwoman', 'ai');

// The Parademon summon is not under test: skip straight to the purge.
Game.summonCardChoice = function (owner, name, cost, atk, hp, abil, lanes, onComplete) { if (onComplete) onComplete(); };
var prompts = [];
Game.promptCardChoice = function (owner, choices, title, desc, cb) {
  prompts.push(choices.map(function (c) { return c.name; }));
  if (prompts.length === 1) {
    // A death trigger from the first purge empties lane 3's enemy side.
    L[2].ai = null;
    cb(choices.find(function (c) { return c._lane === 1; }));
  } else {
    cb(choices[choices.length - 1]);   // Done
  }
};

var threw = null;
try { CARD_ABILITIES['Darkseid'].onPlay(Game, dark, 0); } catch (e) { threw = e.message || String(e); }
check('the purge chain does not throw when a lane stops being contested mid-chain', threw === null, threw);
check('the first prompt offered both contested lanes', prompts[0] && prompts[0].indexOf('Lane 2') >= 0 && prompts[0].indexOf('Lane 3') >= 0, JSON.stringify(prompts[0]));
check('the next prompt never offers the lane that is no longer contested',
  prompts.slice(1).every(function (p) { return p.indexOf('Lane 3') < 0; }), JSON.stringify(prompts));
check('lane 2 was purged', L[1].destroyed === true);

print('darkseid-purge: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('darkseid-purge failed');
