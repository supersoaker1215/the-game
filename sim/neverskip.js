// THE RULE: A HUMAN'S TURN IS ONLY EVER ENDED BY THAT HUMAN.
//   jsc sim/neverskip.js
//
// Owner, after this recurred for weeks: "PLAYERS ARE GETTING SKIPPED IN 2V2 —
// A HUMAN PLAYER CAN NEVER GET SKIPPED MAKE THAT A RULE NOW."
//
// end2v2Phase is the single door every 2v2 advance goes through — tt.subPhaseIdx++
// exists nowhere else — so the rule lives there and this pins it. Six callers
// reach that door; the one that was skipping people is the last-resort stall
// watchdog, which force-ended whoever was on the clock without ever asking
// whether that was a person.
//
// The two cases that matter most and are easy to get backwards:
//   - a seat mid-DROP-GRACE is still protected. That flag means the seat is
//     being HELD for someone whose connection blipped; skipping them is the
//     exact thing the grace exists to prevent.
//   - a seat that finished the grace (_dropped/isAI) is NOT protected, or the
//     table would deadlock on a player who really has gone.
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim.js');
function mk2v2(){
  Game.state = Game.state || {};
  Game.state.log = [];
  var tt = {
    online: true, you: 'p1', subPhaseIdx: 0,
    order: ['p1','p2','p3','p4'],
    players: {
      p1:{name:'Henry', isAI:false, hand:[], trickHand:[], energy:5},
      p2:{name:'Bot',   isAI:true,  hand:[], trickHand:[], energy:5},
      p3:{name:'Ryan',  isAI:false, hand:[], trickHand:[], energy:5},
      p4:{name:'Bot2',  isAI:true,  hand:[], trickHand:[], energy:5}
    },
    teams:{A:{health:30},B:{health:30}}
  };
  Game.state.twoVTwo = tt;
  return tt;
}
var tt = mk2v2();
var results = [];
function attempt(label, activeSeat, fn){
  tt.subPhaseIdx = 0;
  Game._2v2ActivePlayer = function(){ return activeSeat; };
  Game._2v2StartSubPhase = function(){};              // isolate the advance
  Game._2v2ActionsLocked = function(){ return false; };
  Game._2v2ReadBackActivePlayer = function(){};
  var before = tt.subPhaseIdx;
  try { fn(); } catch(e) { results.push({label:label, err:e.message}); print("  THREW: "+label+" -> "+e.message); return; }
  var advanced = tt.subPhaseIdx > before;
  results.push({label:label, seat:activeSeat, advanced:advanced});
}

// 1. The watchdog path (no actor) against a LIVE HUMAN — must NOT advance.
attempt('watchdog vs live human',    'p1', function(){ Game.end2v2Phase(); });
// 2. Same against a BOT — must advance (bots may be recovered).
attempt('watchdog vs bot',           'p2', function(){ Game.end2v2Phase(); });
// 3. The human ending their OWN turn — must advance.
attempt('human ends own turn',       'p1', function(){ Game.end2v2Phase(null,{actor:'p1'}); });
// 4. A DIFFERENT human ending someone else's turn — must NOT advance.
attempt('other human ends p1',       'p1', function(){ Game.end2v2Phase(null,{actor:'p3'}); });
// 5. A human who genuinely dropped — must advance (no deadlock).
tt.players.p1._dropped = true;
attempt('watchdog vs dropped human', 'p1', function(){ Game.end2v2Phase(); });
tt.players.p1._dropped = false;
// 6. A human mid-drop-grace — must NOT advance.
tt.players.p1._dropPending = true;
attempt('watchdog vs dropPending',   'p1', function(){ Game.end2v2Phase(); });
tt.players.p1._dropPending = false;

var expect = [false, true, true, false, true, false];  // 6: mid-grace human stays protected
var pass = true;
results.forEach(function(r,i){
  var ok = (r.advanced === expect[i]);
  if (!ok) pass = false;
  print((ok?'  ok  ':'  FAIL') + '  ' + r.label + '  -> advanced=' + r.advanced + ' (want ' + expect[i] + ')');
});
print(pass ? '=== 6 passed, 0 failed ==='
           : '=== 1 failed: the never-skip-a-human rule does not hold ===');

// NOT TESTED HERE: "a named human seat is never rerouted to a driving bot"
// (the promptCardChoice/promptLaneChoice safety-net fix). sim/shim.js resolves
// prompts SYNCHRONOUSLY, so a headless test can never observe a prompt sitting
// PENDING for a seat — the callback always fires and the thing under test is
// exactly whether it should not have. Verified in the browser instead: with a
// bot teammate driving, promptCardChoice(..., { seat: <human> }) must leave
// pendingCardChoice stamped with that human and must NOT log "auto-picked for".
