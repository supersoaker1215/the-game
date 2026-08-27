// Tournament modifier audit — verifies each modifier's engine effect headlessly.
//   jsc sim/modtest.js
load('./sim/shim.js');

Game.init();
function def(name) { for (var i=0;i<CARD_DEFS.length;i++) if (CARD_DEFS[i].name===name) return CARD_DEFS[i]; return null; }
function freshMatch(mods) {
  if (!Game.state) Game.init();
  // A clean 1v1 with two vanilla-ish opening hands and the given modifiers.
  Game.startMatch({
    players: '1v1', deck: 'classic',
    _presetHands: { player: { cards: [def('Gamora')], tricks: [] }, ai: { cards: [def('Bane')], tricks: [] } },
    _mods: mods || {},
  });
  Game.state.player.isHuman = false; Game.state.ai.isHuman = false;
}
function setMods(m) { Game.state.mode = { players:'1v1', deck:'classic', _mods: m }; }

var pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; print('  PASS  ' + name); }
  else { fail++; print('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

print('=== TOURNAMENT MODIFIER AUDIT ===');

// 1. Glass Cannon — both open at 15 HP.
freshMatch({ glassCannon: true });
check('glassCannon: player 15 HP', Game.state.player.health === 15, 'got ' + Game.state.player.health);
check('glassCannon: ai 15 HP',     Game.state.ai.health === 15, 'got ' + Game.state.ai.health);

// 2. Power Surge — round-1 energy doubled (2 instead of 1).
freshMatch({ powerSurge: true });
check('powerSurge: round-1 energy = 2', Game.state.player.currency === 2, 'got ' + Game.state.player.currency);
freshMatch({});
check('control: round-1 energy = 1', Game.state.player.currency === 1, 'got ' + Game.state.player.currency);

// 3. Anarchy — cost 1 less (min 0).
freshMatch({ anarchy: true });
var g = Game.createCardInstance(def('Groot'), 'player');  // base cost 3
check('anarchy: Groot cost 3 -> 2', Game.getCardCost('player', g) === 2, 'got ' + Game.getCardCost('player', g));
var h = Game.createCardInstance(def('Hawkeye'), 'player'); // base cost 1
check('anarchy: 1-cost -> 0 (floored)', Game.getCardCost('player', h) === 0, 'got ' + Game.getCardCost('player', h));

// 4. Glass Jaw — HP halved (floor) at creation.
setMods({ glassJaw: true });
var gj = Game.createCardInstance(def('Groot'), 'player');  // 4 HP -> 2
check('glassJaw: Groot 4 HP -> 2', gj.currentHealth === 2 && gj.maxHealth === 2, 'got ' + gj.currentHealth);
var gj2 = Game.createCardInstance(def('Hawkeye'), 'player'); // 2 HP -> 1
check('glassJaw: 2 HP -> 1', gj2.currentHealth === 1, 'got ' + gj2.currentHealth);

// 5. Blood Bath — combat damage doubled.
setMods({ bloodBath: true });
var atk = Game.createCardInstance(def('Gamora'), 'player'); atk.attack = 3;
var dmg = Game._computeIncomingDamage(atk, Game.createCardInstance(def('Bane'), 'ai'), { silent: true });
check('bloodBath: 3 ATK -> 6 combat dmg', dmg === 6, 'got ' + dmg);
setMods({});
var dmg0 = Game._computeIncomingDamage(atk, Game.createCardInstance(def('Bane'), 'ai'), { silent: true });
check('control: 3 ATK -> 3 combat dmg', dmg0 === 3, 'got ' + dmg0);

// 6. Battlefield — card takes 1 on play. Test via _applyBattlefieldDamage.
setMods({ battlefield: true });
var bf = Game.createCardInstance(def('Gamora'), 'player'); var beforeHp = bf.currentHealth;
Game.state.lanes[0].player = bf;
Game._applyBattlefieldDamage(bf);
check('battlefield: -1 HP on play', bf.currentHealth === beforeHp - 1, 'got ' + bf.currentHealth + ' (was ' + beforeHp + ')');

// 7. Chain Reaction — a death hits adjacent lanes for 1.
setMods({ chainReaction: true });
Game.state.lanes.forEach(function (l) { l.player = null; l.ai = null; });
var dying = Game.createCardInstance(def('Bane'), 'ai'); dying.currentHealth = 0;
var neighborL = Game.createCardInstance(def('Gamora'), 'player'); var nHp = neighborL.currentHealth;
var neighborR = Game.createCardInstance(def('Gamora'), 'ai');  var nHp2 = neighborR.currentHealth;
Game.state.lanes[1].ai = dying;
Game.state.lanes[0].player = neighborL;
Game.state.lanes[2].ai = neighborR;
Game.handleDeath(dying, 1, null);
check('chainReaction: left neighbor -1', neighborL.currentHealth === nHp - 1, 'got ' + neighborL.currentHealth + ' (was ' + nHp + ')');
check('chainReaction: right neighbor -1', neighborR.currentHealth === nHp2 - 1, 'got ' + neighborR.currentHealth + ' (was ' + nHp2 + ')');

// 8. Bounty Hunter — killing an enemy grants the killer's side +1 energy.
setMods({ bounty: true });
Game.state.player.currency = 0;
var victim = Game.createCardInstance(def('Bane'), 'ai');
var killer = Game.createCardInstance(def('Gamora'), 'player');
Game.applyKillBounty(victim, killer);
check('bounty: killer side +1 energy', Game.state.player.currency === 1, 'got ' + Game.state.player.currency);

// 9. King of the Hill — a hill lane is designated; sole holder gains +2 HP.
freshMatch({ kingOfHill: true });
check('kingOfHill: a hill lane is set', Game.state._hillLane != null, 'got ' + Game.state._hillLane);
// place a lone player card on the hill, then run the end-of-round payout.
var hl = Game.state._hillLane;
Game.state.lanes.forEach(function (l) { l.player = null; l.ai = null; });
Game.state.lanes[hl].player = Game.createCardInstance(def('Gamora'), 'player');
Game.state.player.health = 20; Game.state.player.maxHealth = 30;
Game._tournamentEndOfRound();
check('kingOfHill: sole holder +2 HP', Game.state.player.health === 22, 'got ' + Game.state.player.health);

// 10. Shuffle — cards are re-scattered each round.
setMods({ shuffle: true });
Game.state.lanes.forEach(function (l) { l.player = null; l.ai = null; l.destroyed = false; });
var c1 = Game.createCardInstance(def('Gamora'), 'player');
Game.state.lanes[0].player = c1;
var before = 0; for (var i=0;i<Game.LANE_COUNT;i++) if (Game.state.lanes[i].player === c1) before = i;
var moved = false;
for (var trial = 0; trial < 20 && !moved; trial++) {
  Game._tournamentStartOfRound();
  var now = -1; for (var j=0;j<Game.LANE_COUNT;j++) if (Game.state.lanes[j].player === c1) now = j;
  if (now !== before) moved = true;
}
check('shuffle: card relocated within 20 rounds', moved, 'stayed in lane ' + before);

print('');
print('RESULT: ' + pass + ' passed, ' + fail + ' failed.');
