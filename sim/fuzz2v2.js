// ============================================================
// 2v2 FUZZER — plays full 2v2 online games headlessly and reports
// exceptions, stalls, and state-invariant violations.
//   jsc sim/fuzz2v2.js -- --games 200
// ============================================================
load('./sim/shim.js');

var argv = (typeof arguments !== 'undefined') ? arguments : [];
var GAMES = 100, VERBOSE = false;
for (var i = 0; i < argv.length; i++) {
  if (argv[i] === '--games') GAMES = parseInt(argv[++i], 10);
  if (argv[i] === '--verbose') VERBOSE = true;
}

// ---- capture console.error (abilities swallow throws into console.error) ----
var errors = [];
var _origErr = console.error;
console.error = function () {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) {
    var a = arguments[i];
    parts.push(a && a.message ? a.message : String(a));
  }
  errors.push(parts.join(' '));
};

var KEYS = ['p1', 'p2', 'p3', 'p4'];
function rnd(n) { return Math.floor(Math.random() * n); }

// ---- PROMPT OWNERSHIP ----------------------------------------------------
// The fuzzer used to resolve every prompt WITHOUT asking who was supposed to
// answer it, which is exactly why a whole class of live bugs sailed through a
// clean run: a prompt routed to the wrong seat still got resolved here, so it
// looked identical to a correct one. In a real match that difference is a
// player watching their Iron Giant sacrifice itself, or an AI seat silently
// answering a human's decision.
// The invariant: in a 2v2 room, every prompt must carry an owning SEAT. An
// unstamped prompt is not merely untidy — it falls through to team-derivation,
// which is where "the AI played for me" comes from.
var unownedPrompts = 0, promptsSeen = 0;
function notePromptOwner(kind) {
  var tt = Game.state && Game.state.twoVTwo;
  if (!tt || !tt.online) return;
  promptsSeen++;
  var seat = Game._2v2CurrentActingPlayer;
  if (!seat || !tt.players[seat]) {
    unownedPrompts++;
    if (unownedPrompts <= 5) {
      errors.push('[UNOWNED PROMPT] ' + kind + ' raised with no owning seat (phase ' + Game.state.phase + ')');
    }
  }
}

// Resolve any pending prompt so a human-seat 2v2 game can advance.
function drainPrompts(ctx, budget) {
  var n = 0;
  while (n++ < (budget || 60)) {
    var s = Game.state;
    if (s.pendingCardChoice) {
      var cc = s.pendingCardChoice;
      var cards = cc.cards || [];
      if (!cards.length) { s.pendingCardChoice = null; continue; }
      notePromptOwner('cardChoice:' + (cc.title || '?'));
      var pick = cards[rnd(cards.length)];
      s.pendingCardChoice = null;
      try { if (cc.callback) cc.callback(pick); }
      catch (e) { errors.push('[promptCard cb] ' + (e.message || e)); }
      continue;
    }
    if (s.pendingLaneChoice) {
      var lc = s.pendingLaneChoice;
      var lanes = lc.lanes || [];
      if (!lanes.length) { s.pendingLaneChoice = null; continue; }
      notePromptOwner('laneChoice:' + (lc.title || '?'));
      var lane = lanes[rnd(lanes.length)];
      s.pendingLaneChoice = null;
      try { if (lc.callback) lc.callback(lane); }
      catch (e) { errors.push('[promptLane cb] ' + (e.message || e)); }
      continue;
    }
    // BWL keep/destroy
    var seat = (s.player && s.player.stolenByBWL) ? 'player' : (s.ai && s.ai.stolenByBWL) ? 'ai' : null;
    if (seat) {
      var d = s[seat].stolenByBWL; s[seat].stolenByBWL = null;
      try { Game.addToHand(seat, d.card, d.bwl); } catch (e) { errors.push('[bwl] ' + (e.message || e)); }
      continue;
    }
    break;
  }
}

function invariants(tag, played) {
  var s = Game.state, tt = s.twoVTwo, bad = [];
  if (!tt) return bad;
  // energy never negative / never exceeds granted
  KEYS.forEach(function (k) {
    var ap = tt.players[k]; if (!ap) return;
    if ((ap.energy - (ap.usedEnergy || 0)) < 0) bad.push('negative energy ' + k + ' (' + ap.energy + '/' + ap.usedEnergy + ')');
    (ap.hand || []).forEach(function (c) {
      if (c.currentHealth != null && c.maxHealth != null && c.currentHealth > c.maxHealth) bad.push('hand hp>max ' + c.name);
      if (isNaN(c.attack) || isNaN(c.currentHealth)) bad.push('NaN stats in hand: ' + c.name);
    });
  });
  // no card object in two lanes at once; no NaN on board
  var seen = {};
  for (var i = 0; i < s.lanes.length; i++) {
    ['player', 'ai'].forEach(function (side) {
      var c = s.lanes[i][side]; if (!c) return;
      if (c.id != null) { if (seen[c.id]) bad.push('card in two lanes: ' + c.name); seen[c.id] = 1; }
      if (isNaN(c.attack) || isNaN(c.currentHealth)) bad.push('NaN stats on board: ' + c.name);
      if (c.currentHealth > c.maxHealth) bad.push('board hp>max: ' + c.name);
      if (c._neverPlayable) bad.push('NEVER-PLAYABLE card on board: ' + c.name);
      if (c.isDiscardEffect) bad.push('DISCARD-EFFECT card on board: ' + c.name);
      if (c.isEnvironment) bad.push('ENVIRONMENT in a creature slot: ' + c.name);
      if (c._spawnOnly && !c._wasSpawned) { /* spawn tokens may legitimately be summoned */ }
    });
  }
  // team health sane
  ['A', 'B'].forEach(function (t) {
    var h = tt.teams[t].health;
    if (isNaN(h)) bad.push('NaN team health ' + t);
    if (h > tt.teams[t].maxHealth) bad.push('team hp>max ' + t);
  });
  return bad;
}

function playGame(seed) {
  var played = {}, bad = [];
  Game.start2v2Match({ names: { p1: 'A1', p2: 'A2', p3: 'B1', p4: 'B2' } });
  Game.state.twoVTwo.online = true;
  Game.state.twoVTwo.you = 'p1';
  Game._2v2StartDraft();

  // ---- draft (simultaneous) ----
  var guard = 0;
  while (Game.state.twoVTwo.draft && guard++ < 400) {
    var d = Game.state.twoVTwo.draft;
    KEYS.forEach(function (pk) {
      var dd = Game.state.twoVTwo.draft; if (!dd || dd.picked[pk]) return;
      if (Math.random() < 0.25) { try { Game._2v2DraftMulligan(pk); } catch (e) { errors.push('[mulligan] ' + (e.message || e)); } }
    });
    KEYS.forEach(function (pk) {
      var dd = Game.state.twoVTwo.draft; if (!dd || dd.picked[pk]) return;
      try { Game._2v2DraftPick(rnd(2), pk); } catch (e) { errors.push('[draftPick] ' + (e.message || e)); }
    });
  }
  if (Game.state.twoVTwo.draft) bad.push('DRAFT NEVER COMPLETED');

  // ---- rounds ----
  var turns = 0, lastSig = '';
  while (!Game.state.gameOver && turns++ < 260) {
    var s = Game.state, tt = s.twoVTwo;
    if (!tt) break;
    var activeKey = Game._2v2ActivePlayer();
    if (!activeKey) break;
    var ap = tt.players[activeKey];
    var sig = s.phase + '|' + activeKey + '|' + (tt.round || 0) + '|' + (tt.subPhaseIdx || 0);

    // play 0-2 random affordable cards, then maybe a trick, then end phase
    var acts = rnd(3);
    for (var a = 0; a < acts; a++) {
      ap = tt.players[activeKey];
      var avail = [];
      (ap.hand || []).forEach(function (c, idx) {
        if ((ap.energy - (ap.usedEnergy || 0)) >= (c.cost || 0)) avail.push(idx);
      });
      if (!avail.length) break;
      var cardIdx = avail[rnd(avail.length)];
      try { Game._2v2RequestLaneChoice(activeKey, cardIdx); }
      catch (e) { errors.push('[playCard ' + (ap.hand[cardIdx] && ap.hand[cardIdx].name) + '] ' + (e.message || e)); }
      var nm = ap.hand[cardIdx] && ap.hand[cardIdx].name; if (nm) played[nm] = 1;
      drainPrompts();
      bad = bad.concat(invariants('afterPlay', played));
    }
    // trick
    ap = tt.players[activeKey];
    if ((ap.trickHand || []).length && Math.random() < 0.4) {
      var tIdx = rnd(ap.trickHand.length);
      var tn = ap.trickHand[tIdx] && ap.trickHand[tIdx].name;
      try { Game._2v2OnlinePlayTrick(activeKey, tIdx); }
      catch (e) { errors.push('[playTrick ' + tn + '] ' + (e.message || e)); }
      if (tn) played['TRICK:' + tn] = 1;
      drainPrompts();
      bad = bad.concat(invariants('afterTrick', played));
    }
    try { Game.end2v2Phase(); } catch (e) { errors.push('[end2v2Phase] ' + (e.message || e)); }
    drainPrompts();
    bad = bad.concat(invariants('afterPhase', played));

    var newSig = Game.state.phase + '|' + (Game._2v2ActivePlayer() || '-') + '|' + ((Game.state.twoVTwo && Game.state.twoVTwo.round) || 0) + '|' + ((Game.state.twoVTwo && Game.state.twoVTwo.subPhaseIdx) || 0);
    if (newSig === sig && newSig === lastSig) { bad.push('STALLED at ' + newSig); break; }
    lastSig = sig;
  }
  if (turns >= 260) bad.push('TURN CAP HIT (possible infinite loop)');
  return { bad: bad, played: played, rounds: (Game.state.twoVTwo && Game.state.twoVTwo.round) || 0 };
}

var allBad = {}, coverage = {}, gamesWithBad = 0, totalRounds = 0;
for (var g = 0; g < GAMES; g++) {
  var before = errors.length;
  var r;
  try { r = playGame(g); }
  catch (e) { errors.push('[FATAL game ' + g + '] ' + (e.message || e) + (e.stack ? ' | ' + String(e.stack).split('\n')[0] : '')); continue; }
  totalRounds += r.rounds;
  Object.keys(r.played).forEach(function (k) { coverage[k] = (coverage[k] || 0) + 1; });
  if (r.bad.length) { gamesWithBad++; r.bad.forEach(function (b) { allBad[b] = (allBad[b] || 0) + 1; }); }
}

console.error = _origErr;
print('=== 2v2 FUZZ: ' + GAMES + ' games, avg ' + (totalRounds / GAMES).toFixed(1) + ' rounds ===');
print('distinct cards/tricks exercised: ' + Object.keys(coverage).length);
// Read the SHIM's prompt log, not pendingCardChoice — the shim replaces the
// prompt system, so a pending prompt never exists here. This is the only place
// routing becomes observable headlessly.
(function () {
  var log = (Game._simPromptLog || []).filter(function (p) { return p.in2v2; });
  var unowned = log.filter(function (p) { return !p.seat; });
  print('prompts raised in 2v2: ' + log.length + ', WITHOUT an owning seat: ' + unowned.length);
  var byTitle = {};
  unowned.forEach(function (p) { byTitle[p.title] = (byTitle[p.title] || 0) + 1; });
  Object.keys(byTitle).sort(function (a, b) { return byTitle[b] - byTitle[a]; })
    .slice(0, 12).forEach(function (t) {
      print('   unowned x' + byTitle[t] + '  ' + (t || '(untitled)'));
    });
})();
print('games with invariant violations: ' + gamesWithBad + '/' + GAMES);
var bk = Object.keys(allBad).sort(function (a, b) { return allBad[b] - allBad[a]; });
if (bk.length) { print('--- INVARIANT VIOLATIONS ---'); bk.slice(0, 25).forEach(function (k) { print('  ' + allBad[k] + 'x  ' + k); }); }
// group errors by signature
var eg = {};
errors.forEach(function (e) { var k = String(e).slice(0, 110); eg[k] = (eg[k] || 0) + 1; });
var ek = Object.keys(eg).sort(function (a, b) { return eg[b] - eg[a]; });
print('--- EXCEPTIONS (' + errors.length + ' total, ' + ek.length + ' distinct) ---');
ek.slice(0, 30).forEach(function (k) { print('  ' + eg[k] + 'x  ' + k); });
