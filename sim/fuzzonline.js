// ============================================================
// ONLINE FUZZER — exercises the paths that ONLY exist in online play:
//   1. serializeState -> _rehydrateState round-trip fidelity (host->guest)
//   2. _mpFlipPerspective involution (guest sees a flipped copy)
//   3. ability-hook restoration on the guest's rehydrated cards
//   jsc sim/fuzzonline.js -- --games 120
// ============================================================
load('./sim/shim.js');
load('./multiplayer.js');

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var GAMES = 120;
for (var i = 0; i < argv.length; i++) if (argv[i] === '--games') GAMES = parseInt(argv[++i], 10);

var findings = {};
function flag(k) { findings[k] = (findings[k] || 0) + 1; }

var HOOKS = ['onPlay','onDeath','onDamaged','onKill','onBeforeTricks','onBeforeAttack',
             'onEndOfTurn','onAnyCardPlayed','onAllyKilled','onEvade'];

function cardsOf(st) {
  var out = [];
  (st.lanes || []).forEach(function (l, i) {
    ['player','ai'].forEach(function (side) {
      if (l && l[side]) out.push({ where: 'lane' + i + ':' + side, c: l[side] });
    });
  });
  ['player','ai'].forEach(function (side) {
    var p = st[side]; if (!p) return;
    (p.hand || []).forEach(function (c, j) { out.push({ where: side + ':hand' + j, c: c }); });
  });
  if (st.twoVTwo) {
    ['p1','p2','p3','p4'].forEach(function (k) {
      var ap = st.twoVTwo.players[k]; if (!ap) return;
      (ap.hand || []).forEach(function (c, j) { out.push({ where: '2v2:' + k + ':hand' + j, c: c }); });
      (ap.trickHand || []).forEach(function (t, j) { out.push({ where: '2v2:' + k + ':trick' + j, c: t, isTrick: true }); });
    });
  }
  return out;
}

// Structural signature used to compare host state vs guest round-trip.
function sig(st) {
  var s = [];
  (st.lanes || []).forEach(function (l, i) {
    ['player','ai'].forEach(function (side) {
      var c = l && l[side];
      s.push(i + side + (c ? c.name + '/' + c.attack + '/' + c.currentHealth : '-'));
    });
  });
  ['player','ai'].forEach(function (side) {
    var p = st[side];
    s.push(side + 'hp' + (p ? p.health : '?') + 'hand' + (p && p.hand ? p.hand.length : 0));
  });
  if (st.twoVTwo) {
    ['p1','p2','p3','p4'].forEach(function (k) {
      var ap = st.twoVTwo.players[k];
      s.push(k + (ap ? ap.hand.length + ':' + ap.trickHand.length : '-'));
    });
    ['A','B'].forEach(function (t) { s.push(t + st.twoVTwo.teams[t].health); });
  }
  return s.join('|');
}

function checkRoundTrip(tag) {
  var live = Game.state;
  var before = sig(live);
  var clone;
  try { clone = Multiplayer.serializeState(live); }
  catch (e) { flag('serializeState THREW: ' + (e.message || e).slice(0, 60)); return; }
  // host state must be untouched by serialization
  if (sig(live) !== before) flag('serializeState MUTATED the live host state');

  var rehy;
  try { rehy = Multiplayer._rehydrateState(JSON.parse(JSON.stringify(clone))); }
  catch (e) { flag('rehydrate THREW: ' + (e.message || e).slice(0, 60)); return; }

  if (sig(rehy) !== before) flag('ROUND-TRIP DESYNC: guest view != host view (' + tag + ')');

  // ability hooks must be re-attached on the guest copy
  cardsOf(rehy).forEach(function (entry) {
    var c = entry.c; if (!c || !c.name) return;
    if (entry.isTrick) {
      var td = TRICK_DEFS.find(function (d) { return d.name === c.name; });
      if (td && td.play && typeof c.play !== 'function') flag('TRICK lost play(): ' + c.name + ' @' + entry.where.replace(/\d+/g,'N'));
      return;
    }
    var def = CARD_DEFS.find(function (d) { return d.name === c.name; });
    if (!def) return;
    HOOKS.forEach(function (h) {
      if (typeof def[h] === 'function' && typeof c[h] !== 'function') {
        flag('CARD lost ' + h + '(): ' + c.name + ' @' + entry.where.replace(/\d+/g,'N'));
      }
    });
  });

  // perspective flip must be an involution
  var a = Multiplayer._rehydrateState(JSON.parse(JSON.stringify(clone)));
  var once = sig(Game._mpFlipPerspective(a));
  var twice = sig(Game._mpFlipPerspective(a));
  if (twice !== before) flag('FLIP not involutive (flip twice != original)');
  if (once === before && (before.indexOf('-') !== before.length - 1)) { /* symmetric board, fine */ }
}

function rnd(n){ return Math.floor(Math.random()*n); }

// ---------- 1v1 online ----------
for (var g = 0; g < GAMES; g++) {
  Game.init();
  Game.startMatch({ players: '1v1', deck: 'classic' });
  Game.state._mpNames = { player: 'Host', ai: 'Guest' };
  var guard = 0;
  while (Game.state.draft && guard++ < 200) {
    var d = Game.state.draft;
    if (d.playerChoices && d.playerChoices.length) Game.draftPick(0, 'player'); else break;
  }
  checkRoundTrip('1v1 post-draft');
  var t = 0;
  while (!Game.state.gameOver && t++ < 14) {
    var p = Game.state.player;
    var avail = [];
    (p.hand || []).forEach(function (c, i) { if ((p.currency || 0) >= (c.cost || 0)) avail.push(i); });
    if (avail.length) {
      var idx = avail[rnd(avail.length)];
      var open = Game.getOpenLanes('player');
      if (open.length) { try { Game.playCard('player', p.hand[idx], open[rnd(open.length)]); } catch (e) { flag('1v1 playCard threw: ' + (e.message||e).slice(0,50)); } }
    }
    checkRoundTrip('1v1 mid-round');
    // Advance whichever phase is actually active (mirrors the doneTurn router).
    try {
      var ph = Game.state.phase;
      if (ph === 'player-cards' || ph === 'ai-cards') Game.endPhase1();
      else if (ph === 'player-cards-tricks' || ph === 'ai-cards-tricks') Game.endPhase2();
      else if (ph === 'player-tricks' || ph === 'ai-tricks') Game.endPhase3();
      else break;
    } catch (e) { flag('1v1 endPhase threw: ' + (e.message||e).slice(0,50)); break; }
  }
  checkRoundTrip('1v1 late');
}

// ---------- 2v2 online ----------
var KEYS = ['p1','p2','p3','p4'];
for (var g2 = 0; g2 < GAMES; g2++) {
  Game.start2v2Match({ names: { p1:'Ryan', p2:'Lexi', p3:'Max', p4:'Sam' } });
  Game.state.twoVTwo.online = true;
  Game.state.twoVTwo.you = 'p1';
  Game._2v2StartDraft();
  var gd = 0;
  while (Game.state.twoVTwo.draft && gd++ < 400) {
    KEYS.forEach(function (pk) {
      var dd = Game.state.twoVTwo.draft; if (dd && !dd.picked[pk]) Game._2v2DraftPick(rnd(2), pk);
    });
  }
  checkRoundTrip('2v2 post-draft');
  var t2 = 0;
  while (!Game.state.gameOver && t2++ < 12) {
    var ak = Game._2v2ActivePlayer(); if (!ak) break;
    var ap = Game.state.twoVTwo.players[ak];
    var av = [];
    (ap.hand || []).forEach(function (c, i) { if ((ap.energy - (ap.usedEnergy||0)) >= (c.cost||0)) av.push(i); });
    if (av.length) { try { Game._2v2RequestLaneChoice(ak, av[rnd(av.length)]); } catch (e) { flag('2v2 play threw: ' + (e.message||e).slice(0,50)); } }
    if (Game.state.pendingLaneChoice) { var lc = Game.state.pendingLaneChoice; Game.state.pendingLaneChoice = null; try { lc.callback && lc.callback((lc.lanes||[0])[0]); } catch(e){} }
    if (Game.state.pendingCardChoice) { var cc = Game.state.pendingCardChoice; Game.state.pendingCardChoice = null; try { cc.callback && cc.callback((cc.cards||[])[0]); } catch(e){} }
    checkRoundTrip('2v2 mid-round');
    try { Game.end2v2Phase(); } catch (e) { flag('2v2 endPhase threw: ' + (e.message||e).slice(0,50)); break; }
  }
  checkRoundTrip('2v2 late');
}

print('=== ONLINE FUZZ: ' + GAMES + ' games per mode ===');
var keys = Object.keys(findings).sort(function (a,b) { return findings[b]-findings[a]; });
if (!keys.length) print('  no findings — round-trip, hooks and flip all clean');
else keys.slice(0, 30).forEach(function (k) { print('  ' + findings[k] + 'x  ' + k); });
