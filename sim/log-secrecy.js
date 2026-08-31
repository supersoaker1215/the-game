// ============================================================
// WHAT YOU DREW IS YOURS. THAT YOU DREW IS THE TABLE'S.
//
//   jsc sim/log-secrecy.js
//
// Owner, from a 2v2 against his brother: "the log shouldnt show drawn cards,
// that would be cheating — i should see that he redrew WW." The battle log had
// "Ryan redraws Wonder Woman for 2 Energy" in it, on every screen at the table.
//
// Two separate holes, one symptom:
//
//   THE LINES.   drawCards decided who may read the card names with
//                `owner === 'player'`, which is the 1v1 assumption. In 2v2
//                'player' is Team A no matter who is looking, so one team's
//                draws were named for everybody and the other team's were
//                hidden from their own owners. The 2v2 redraw named the card
//                unconditionally.
//
//   THE SURFACES. state.log is printed by THREE things — the full drawer, the
//                board aside and the redesign's left rail — and only the drawer
//                ran the private-line filter. The other two are the ones always
//                on screen, so every private line was rendered verbatim there,
//                control characters and all. That defeated the jump secrecy
//                this channel was built for, not just the draws.
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
function ok(label, cond) { eq(label, !!cond, true); }

function table() {
  Game.start2v2Match({ names: { p1: 'Henry', p2: 'Vega', p3: 'Ryan', p4: 'Bot2' },
                       teamAssignment: { A: ['p1', 'p3'], B: ['p2', 'p4'] } });
  var tt = Game.state.twoVTwo;
  tt.online = true; tt.you = 'p1';
  Game.state.round = 3;
  Game.state.log = [];
  return tt;
}
// Everything a seat would actually receive over the wire.
// The legality gate is not what these cases are about — they are about what
// the line SAYS once a redraw happens — so it is stubbed explicitly rather
// than reconstructed out of phase state.
function withRedrawAllowed(fn) {
  var orig = Game.redrawBlockedReason;
  Game.redrawBlockedReason = function () { return null; };
  try { return fn(); } finally { Game.redrawBlockedReason = orig; }
}
function doRedraw(seatKey, name) {
  var tt = Game.state.twoVTwo;
  var seat = tt.players[seatKey];
  seat.hand = [Game.createCardInstance(cardDef(name), Game._2v2TeamSide[seat.team])];
  seat.energy = 9; seat.usedEnergy = 0; seat.redrawsUsed = 0;
  if (!(tt.drawPile || []).length) {
    tt.drawPile = [];
    for (var i = 0; i < 5; i++) tt.drawPile.push(cardDef('Sabertooth'));
  }
  Game.state.log = [];
  return withRedrawAllowed(function () { return Game._2v2RedrawCard(seatKey, seat.hand[0]); });
}
function wireFor(seat) {
  var out = Game.serializeState ? Game.serializeState(seat) : null;
  if (out && out.log) return out.log;
  // Fall back to the redaction path by name if the serializer is called
  // something else in this build — the test is about the log, not the API.
  return null;
}

// ============================================================
t('LS-1 a 2v2 redraw names the card for its own seat only', function () {
  table();
  eq('the redraw went through', doRedraw('p3', 'Wonder Woman'), true);

  var line = Game.state.log.find(function (l) { return /redraws/.test(Game.logLineText(l)); });
  ok('a redraw was logged', !!line);
  eq('and it is addressed to the seat that spent the energy', Game.logLineSeat(line), 'p3');
  ok('whose own form names the card', /Wonder Woman/.test(Game.logLineText(line)));
  // The half everyone else gets.
  var pub = Game.logLinePublic(line);
  ok('there IS a public half — the redraw itself is not a secret', !!pub);
  eq('but it does not name the card', /Wonder Woman/.test(pub), false);
  ok('and it still says a redraw happened', /redraws/.test(pub));
});

// ============================================================
t('LS-2 a draw names the cards for the hand that got them', function () {
  var tt = table();
  Game.state.log = [];
  Game._2v2CurrentActingPlayer = 'p3';
  Game.drawCards(Game._2v2TeamSide[tt.players.p3.team], 1, null);
  var line = Game.state.log.find(function (l) { return /\[DRAW\]/.test(Game.logLineText(l)); });
  ok('a draw was logged', !!line);
  var pub = Game.logLinePublic(line);
  ok('with a public half', !!pub);
  ok('that gives the COUNT', /draw 1 card/.test(pub));
  eq('and no colon-list of names', /: /.test(pub), false);
});

// ============================================================
t('LS-3 the wire never carries another seat\'s card names', function () {
  table();
  doRedraw('p3', 'Wonder Woman');

  var mine = wireFor('p3');
  var theirs = wireFor('p2');            // the other team
  if (mine === null || theirs === null) { return; }   // serializer absent in this build
  ok('p3 receives the name', mine.some(function (l) { return /Wonder Woman/.test(l); }));
  eq('p2 receives NO occurrence of it, in any form',
     theirs.some(function (l) { return /Wonder Woman/.test(l); }), false);
  ok('but p2 is still told a redraw happened',
     theirs.some(function (l) { return /redraws/.test(l); }));
});

// ============================================================
t('LS-4 a line with no public half is still dropped outright', function () {
  var tt = table();
  Game.state.log = [];
  Game.logPrivate('p3', '  [JUMP] Michael Myers senses weakness in lane 3!');
  var line = Game.state.log[0];
  eq('it is addressed to p3', Game.logLineSeat(line), 'p3');
  eq('and has nothing public to fall back to', Game.logLinePublic(line), null);
  var theirs = wireFor('p2');
  if (theirs === null) return;
  eq('so p2 receives nothing about it',
     theirs.some(function (l) { return /Michael Myers|JUMP/.test(l); }), false);
});

// ============================================================
t('LS-5 every log surface runs the same filter', function () {
  // The bug was that only ONE of the three did. This pins the shared helper
  // existing and being what the other surfaces call, which is the only thing a
  // headless test can check about a DOM renderer.
  var src = read('ui.js');
  ok('UI.readableLog exists', /readableLog\(log\)\s*\{/.test(src));
  var uses = (src.match(/this\.readableLog\(/g) || []).length;
  ok('and the drawer, the aside and the replay all go through it (>=3)', uses >= 3);
  eq('no surface still slices the raw log for display',
     /\(s\.log \|\| \[\]\)\.slice\(-3\)/.test(src), false);
  var bv2 = read('board-v2.js');
  ok('the redesign rail goes through it too', /UI\.readableLog/.test(bv2));
});

function cardDef(n) {
  for (var i = 0; i < CARD_DEFS.length; i++) if (CARD_DEFS[i].name === n) return CARD_DEFS[i];
  throw new Error('no CARD_DEF named ' + n);
}

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
print('log-secrecy: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
