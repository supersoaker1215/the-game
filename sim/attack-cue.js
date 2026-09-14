// ============================================================
// A REGISTERED SOUND HAS TO BE REACHABLE.
//
//   jsc sim/attack-cue.js
//
// The SFX registry has always had an `attack` slot and a handful of cards fill
// it — Jango Fett, Padme Amidala, Xenomorph, Thor, Droideka — but a grep for
// playCardSfx(…,
// 'attack') across the whole codebase returned exactly ONE call, inside
// Droideka's own ability. Three recorded cues had been registered, shipped and
// cached by every player, and never once been audible. It only surfaced because
// the owner sent a new Jango blaster clip for a slot that could not play it.
//
// The fix is deliberately narrow, and the narrowness is the thing worth pinning:
// playCardSfx falls back CARD_SFX -> CARD_PROCEDURAL -> DEFAULT_CARD_SFX, and
// CARD_PROCEDURAL carries a synthesised `attack` for 93 characters. Asking for
// the slot by name at the impact frame would have switched all 93 on at once.
// So the swing cue reads CARD_SFX directly and fires for nothing else.
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

var UISRC = read('ui.js');
function decomment(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); })
          .replace(/\/\/[^\n]*/g, '');
}
var SRC = decomment(UISRC);

// Balance braces so a nested block cannot end the slice early.
function methodBody(name) {
  var open = UISRC.indexOf('\n  ' + name + '(');
  if (open < 0) return '';
  var brace = UISRC.indexOf('{', open);
  if (brace < 0) return '';
  var depth = 0;
  for (var i = brace; i < UISRC.length; i++) {
    if (UISRC[i] === '{') depth++;
    else if (UISRC[i] === '}') { depth--; if (!depth) return UISRC.slice(brace, i + 1); }
  }
  return '';
}

t('AC-1 the swing fires the attacker\'s own cue, on its own beat', function () {
  // REWRITTEN. This used to pin the cue to the 'hit' branch, which is precisely
  // where it did not belong: hanging it off the damage meant an evaded or
  // absorbed swing was silent. It rides the 'swing' event now — see AC-12.
  var body = decomment(methodBody('showDamageFloats'));
  eq('found showDamageFloats', body.length > 400, true);
  eq('the drain handles the swing event', /ev\.type === 'swing'/.test(body), true);
  eq('and asks for the attacker cue there', /_playAttackerCue\(ev\.attackerId, ev\.name\)/.test(body), true);
  // Still deferred to its side's beat rather than fired on resolve, so the
  // opponent-then-you ordering holds for the cue as well as the impact.
  var branch = body.slice(body.indexOf("ev.type === 'swing'"), body.indexOf("ev.type === 'swing'") + 600);
  eq('deferred to the beat', /setTimeout\(\(\) => this\._playAttackerCue/.test(branch), true);
  eq('and the lane waits for it', /_bookLaneAudioUntil\(beat\)/.test(branch), true);
});

t('AC-2 …and it reads the recorded registry only, never the procedural fallback', function () {
  var body = decomment(methodBody('_playAttackerCue'));
  eq('found the helper', body.length > 200, true);
  // CARD_SFX directly. Going through playCardSfx's own lookup would pick up
  // CARD_PROCEDURAL and turn on every synthesised attack in the game.
  eq('asks the recorded registry', /this\.sfx\.CARD_SFX\[name\]/.test(body), true);
  eq('and bails when there is no recording', /if \(!entry \|\| !entry\.attack\) return;/.test(body), true);
  eq('never reaches for the procedural table', /CARD_PROCEDURAL/.test(body), false);
  eq('and it does play the slot', /playCardSfx\(name, 'attack'\)/.test(body), true);
});

t('AC-3 one cue per swing, not one per victim', function () {
  // A splashing attacker emits a hit event per card it touches, and they all
  // land on the same deferred impact frame. Without a per-attacker gate the
  // volley fires on top of itself.
  var body = decomment(methodBody('_playAttackerCue'));
  eq('keyed by the attacker', /_attackCueAt\[attackerId\]/.test(body), true);
  eq('with a window', /< 400\) return;/.test(body), true);
  eq('and the map cannot grow forever', /Object\.keys\(this\._attackCueAt\)\.length > 400/.test(body), true);
});

t('AC-4 Jango\'s clip is registered so it can actually be heard in full', function () {
  var reg = (UISRC.match(/'Jango Fett':\s*\{[^\n]*\n?/) || [''])[0];
  eq('found the entry', reg.length > 20, true);
  eq('the attack slot points at the file', /jango-fett-attack\.mp3/.test(reg), true);
  // The attack slot shares playCardSfx's DEATH branch, whose default cap is
  // 1.5s — shorter than this 2.0s volley, so it needs its own maxDur or the
  // tail is cut.
  eq('and carries a cap long enough for it', /maxDur: 2\.0/.test(reg), true);
  var death = (UISRC.match(/opts\.maxDur = opts\.maxDur \?\? 1\.5;\s*\/\/ death/) || [''])[0];
  eq('…because the default really is 1.5s', death.length > 10, true);
  // Same filename, new bytes: without a per-entry bust _bustCache leaves the
  // URL alone and the service worker keeps serving the old clip from
  // ASSET_CACHE, which is cache-first.
  eq('and busts its own cache', /jango-fett-attack\.mp3\?v=/.test(reg), true);
  // _bustCache lives inside the nested sfx object, so it is indented deeper
  // than methodBody's two-space top-level methods — slice it by hand.
  var bi = UISRC.indexOf('_bustCache(src) {');
  var bust = decomment(UISRC.slice(bi, bi + 260));
  eq('…because the global stamp skips a url that has one',
     /indexOf\('\?'\) !== -1\) return src;/.test(bust), true);
});

t('AC-5 only cards with a recorded attack can ever make this sound', function () {
  // The whole safety of AC-2 rests on how few of these there are. If a future
  // edit registers attack cues broadly, that is a mixing decision someone
  // should make on purpose rather than inherit from this wiring.
  var block = (UISRC.match(/CARD_SFX: \{[\s\S]*?\n    \},/) || [''])[0];
  eq('found CARD_SFX', block.length > 2000, true);
  var names = [], re = /'([^']+)':\s*(\{[^\n]*)/g, m;
  while ((m = re.exec(block))) if (/(^|[{,]\s*)attack:/.test(m[2])) names.push(m[1]);
  names.sort();
  eq('five cards, named', JSON.stringify(names),
     JSON.stringify(['Droideka', 'Jango Fett', 'Padme Amidala', 'Thor', 'Xenomorph']));
});


// ---- ONE LANE, ONE BEAT AT A TIME (2026-09-14) ----------------------------
// Owner: "right now the lanes attack simutanously, i want the opponent to
// attack first, if they have an attack sound it fires, then the players card
// attacks just so the sounds dont get jumbled, if theres a death that fires
// opponent then player, then the next lane."
//
// Measured before, on a lane where both cards had a recorded attack cue and
// both died (ms from the start of the lane):
//
//     +2ms    player swings          <- the player went first
//    +23ms    opponent swings
//    +36ms    a death cue fires      <- BEFORE either impact was heard
//   +155ms    impact
//   +156ms    impact                 <- 1ms apart, and the 2nd death muted
//
// After, same lane:
//
//   +220ms    impact + the OPPONENT's cue
//   +567ms    impact + the PLAYER's cue
//   +813ms    the opponent's death
//  +1069ms    the player's death
//
// The engine is not part of any of that and must never become part of it.

t('AC-6 the opponent swings first, and the player follows a gap behind', function () {
  var swing = decomment(methodBody('_swingBeatMs'));
  eq('found the swing beat', swing.length > 40, true);
  // The gap is added for the PLAYER and not for the opponent. Written this way
  // round so flipping it is a visible edit, not a sign change.
  eq('the player waits',   /attackerOwner === 'player' \? this\.COMBAT_SWING_GAP_MS : 0/.test(swing), true);
  eq('off the impact frame', /_COMBAT_IMPACT_MS/.test(swing), true);
  // Both gaps answer to aiSpeed, like COMBAT_LANE_DELAY — a fixed gap would
  // fight the setting at both ends.
  var src = SRC;
  eq('swing gap scales with speed', /COMBAT_SWING_GAP_MS\(\) \{[\s\S]{0,200}aiSpeed/.test(src), true);
  eq('death gap scales with speed', /COMBAT_DEATH_GAP_MS\(\) \{[\s\S]{0,200}aiSpeed/.test(src), true);
});

t('AC-7 deaths come after BOTH swings, opponent first', function () {
  var death = decomment(methodBody('_deathBeatMs'));
  eq('found the death beat', death.length > 40, true);
  // Built ON the later of the two swings, so no arithmetic can put a death
  // ahead of the swing that caused it.
  eq('after the last swing', /_swingBeatMs\('player'\)/.test(death), true);
  eq('plus a gap',           /\+ this\.COMBAT_DEATH_GAP_MS/.test(death), true);
  eq('and the player last',  /deadOwner === 'player' \? this\.COMBAT_DEATH_GAP_MS : 0/.test(death), true);
});

t('AC-8 the impact beat is the attacker\'s, on both hit paths', function () {
  var body = decomment(methodBody('showDamageFloats'));
  eq('found showDamageFloats', body.length > 400, true);
  // The ordinary path: victim still on the board.
  eq('the live-victim hit uses the attacker\'s beat',
     /_swingBeatMs\(this\._attackerOwner\(ev\.attackerId\)\)/.test(body), true);
  eq('and the flat impact constant no longer drives it alone',
     /setTimeout\(fn, this\._COMBAT_IMPACT_MS \|\| 175\)/.test(body), false);
  // The killing-blow path: victim already gone, so there is no node to anchor
  // to. It used to fire IMMEDIATELY while the surviving side waited for the
  // impact frame — the two halves of one exchange, heard out of order.
  var kill = body.slice(0, body.indexOf('Card-targeted events'));
  eq('found the killing-blow branch', /if \(!cardEl\)/.test(body), true);
  var lethal = body.slice(body.indexOf('if (!cardEl)'), body.indexOf('if (!cardEl)') + 1800);
  eq('the killing blow waits for its beat too', /_swingBeatMs\(owner\)/.test(lethal), true);
  // The attacker's cue is NOT asserted here any more: it left the hit branches
  // entirely when it moved onto the 'swing' event, which is the only way it
  // could also cover an evaded or absorbed swing. AC-12/AC-14 own it now.
  eq('and no longer carries the attacker cue itself',
     /_playAttackerCue\(/.test(lethal), false);
});

t('AC-9 one death-cue door, scheduled, gated per side', function () {
  var door = decomment(methodBody('_playDeathCue'));
  eq('found the door', door.length > 300, true);
  // SCHEDULED, not played where it is decided. It used to run inside the
  // engine's synchronous cleanupDead, which finishes long before the UI's
  // deferred impact frame.
  eq('it waits for the death beat', /_deathBeatMs\(side\)/.test(door), true);
  eq('and schedules rather than plays', /setTimeout\(fire, delay\)/.test(door), true);
  // Per SIDE, so an ordinary trade gets both deaths instead of one.
  eq('the slot is keyed by side', /_laneDeathCost\[side\]/.test(door), true);
  eq('and so is the cut-off of a previous cue', /_laneAudioBySide\[side\]/.test(door), true);
  // BOTH wrappers call it. Only the handleDeath one runs for a combat death, so
  // a second copy of this rule is a fix that changes nothing in a fight.
  var calls = (SRC.match(/this\._playDeathCue\(card,/g) || []).length;
  eq('called from both wrappers', calls, 2);
  eq('and the killCard copy of the gate is gone',
     /const winsLane = \(deadCost > currentDeathCost\)/.test(SRC), false);
});

t('AC-10 the lane cannot advance out from under its own beats', function () {
  var book = decomment(methodBody('_bookLaneAudioUntil'));
  eq('found the booking', book.length > 40, true);
  eq('it only ever extends the window', /if \(at > \(this\.sfx\._laneAudioEndsAt \|\| 0\)\)/.test(book), true);
  var door = decomment(methodBody('_playDeathCue'));
  eq('the death books its own wait', /_bookLaneAudioUntil\(delay \+ capMs/.test(door), true);
  var body = decomment(methodBody('showDamageFloats'));
  eq('and so does a swing', /_bookLaneAudioUntil\(/.test(body), true);
});

t('AC-11 the ENGINE still resolves a lane simultaneously', function () {
  // The whole change above is playback. If a future edit ever "fixes" the order
  // in the engine instead, a trade stops being a trade — so this asserts the
  // outcome, not the source: two cards that can kill each other BOTH die.
  Game.init();
  Game.startMatch && Game.startMatch({ difficulty: 'normal' });
  var s = Game.state;
  s.lanes.forEach(function (l) { l.player = null; l.ai = null; });
  var mk = function (n, side) {
    return Game.createCardInstance(CARD_DEFS.filter(function (d) { return d.name === n; })[0], side);
  };
  var p = mk('Padme Amidala', 'player'), a = mk('Jango Fett', 'ai');
  p.attack = 20; a.attack = 20;
  s.lanes[0].player = p; s.lanes[0].ai = a;
  var done = false;
  Game.resolveLaneCombat(0, function () { done = true; });
  eq('the lane resolved', done, true);
  eq('the opponent died', a.currentHealth <= 0, true);
  eq('and so did the player\'s card', p.currentHealth <= 0, true);
  // …and neither swing was skipped because the other landed first.
  eq('both lanes are empty', !s.lanes[0].player && !s.lanes[0].ai, true);
});


// ---- THE CUE IS THE SWING, NOT THE DAMAGE (2026-09-14) --------------------
// Owner: "padmes attack audio not firing". The case was an EVADE — Padme swung,
// Nightwing dodged, the FX stream carried an 'evade' event and no 'hit', and
// the cue was hanging off 'hit'. Measured before: zero cues on that swing.
//
// Every way a swing can connect without dealing damage had the same hole —
// Invincible, Damage Immunity, a fully-absorbed Armor hit, a face-down target
// — and the killing blow was the SAME mistake, patched in its own branch
// rather than at the cause. So the cue moved to where a swing actually is.

function swingEvents(G) {
  return ((G.state._fx && G.state._fx.events) || []).filter(function (e) { return e.type === 'swing'; });
}
function laneCard(G, name, side, lane) {
  var def = null;
  for (var i = 0; i < CARD_DEFS.length; i++) if (CARD_DEFS[i].name === name) def = CARD_DEFS[i];
  var c = Game.createCardInstance(def, side);
  Game.applyAbilities(c);
  G.state.lanes[lane][side] = c;
  return c;
}

t('AC-12 a swing announces itself even when the target dodges it', function () {
  Game.init();
  Game.startMatch && Game.startMatch({ difficulty: 'normal' });
  var G = Game;
  G.state.lanes.forEach(function (l) { l.player = null; l.ai = null; });
  var padme = laneCard(G, 'Padme Amidala', 'player', 0);
  var dodger = laneCard(G, 'Nightwing', 'ai', 0);
  eq('the dodger really has Evade', (dodger.evadeCharges | 0) > 0, true);

  if (G.state._fx) G.state._fx.events.length = 0;
  G.applyCombatDamage(padme, dodger);

  var evs = (G.state._fx && G.state._fx.events) || [];
  eq('the swing was evaded', evs.some(function (e) { return e.type === 'evade'; }), true);
  eq('…so there is no hit event to hang a cue on',
     evs.some(function (e) { return e.type === 'hit'; }), false);
  // …and the swing still announced itself, which is the whole fix.
  var sw = swingEvents(G);
  eq('but the swing DID announce itself', sw.length, 1);
  eq('with the attacker id',   sw[0].attackerId, padme.id);
  eq('its side',               sw[0].owner, 'player');
  // NAME AND OWNER TRAVEL WITH IT so the UI never looks the attacker back up:
  // by the time the cue's beat comes round, an attacker that died in its own
  // exchange is off the board and out of the entity index.
  eq('and its name',           sw[0].name, 'Padme Amidala');
});

t('AC-13 …and on every other way a swing lands without damage', function () {
  Game.init();
  Game.startMatch && Game.startMatch({ difficulty: 'normal' });
  var G = Game;
  function swingInto(setup) {
    G.state.lanes.forEach(function (l) { l.player = null; l.ai = null; });
    var atk = laneCard(G, 'Padme Amidala', 'player', 0);
    var tgt = laneCard(G, 'Sabertooth', 'ai', 0);
    setup(tgt);
    if (G.state._fx) G.state._fx.events.length = 0;
    G.applyCombatDamage(atk, tgt);
    return swingEvents(G).length;
  }
  eq('an Invincible target',      swingInto(function (t2) { t2.invincibleTurns = 2; }), 1);
  eq('a Damage-Immune target',    swingInto(function (t2) { t2.hasDamageImmunity = true; }), 1);
  eq('a face-down target',        swingInto(function (t2) { t2.isFaceDown = true; }), 1);
  eq('and an ordinary hit',       swingInto(function () {}), 1);

  // A swing into a CORPSE is a whiff nobody sees, and must stay silent — the
  // guard it sits behind.
  G.state.lanes.forEach(function (l) { l.player = null; l.ai = null; });
  var a2 = laneCard(G, 'Padme Amidala', 'player', 0);
  var dead = laneCard(G, 'Sabertooth', 'ai', 0);
  dead.currentHealth = 0;
  if (G.state._fx) G.state._fx.events.length = 0;
  G.applyCombatDamage(a2, dead);
  eq('a swing into a corpse says nothing', swingEvents(G).length, 0);
});

t('AC-14 the UI reads the swing, and no longer the damage', function () {
  var src = decomment(UISRC);
  // ONE source. Two separate 'hit' branches used to fire it — the ordinary one
  // and the killing-blow one — which is how the same mistake got patched twice
  // and still missed the Evade.
  eq('the cue hangs off the swing event', /ev\.type === 'swing'/.test(src), true);
  var body = decomment(methodBody('showDamageFloats'));
  var calls = (body.match(/_playAttackerCue\(/g) || []).length;
  eq('and is fired from exactly one place in the drain', calls, 2);   // deferred + immediate, same branch
  var swingBranch = body.slice(body.indexOf("ev.type === 'swing'"), body.indexOf("ev.type === 'swing'") + 600);
  eq('both of them are in the swing branch', (swingBranch.match(/_playAttackerCue\(/g) || []).length, 2);
  // It still lands on the attacker's own beat, so opponent-then-you holds.
  eq('on the beat its side owns', /_swingBeatMs\(ev\.owner\)/.test(swingBranch), true);
  // The name rides the event; the lookup is only a fallback.
  var cue = decomment(methodBody('_playAttackerCue'));
  eq('the name is taken from the event', /knownName \|\| null/.test(cue), true);
  eq('with a lookup only as fallback', /if \(!name\) \{/.test(cue), true);
});

__cases.forEach(function (c) {
  __caseFailed = false; __caseMsgs = [];
  try { c.fn(); } catch (e) {
    __caseFailed = true;
    __caseMsgs.push('threw: ' + (e && e.message ? e.message : String(e)));
  }
  if (__caseFailed) { __failed++; __failures.push({ name: c.name, msgs: __caseMsgs.slice(0, 5) }); }
  else __passed++;
});
print('attack-cue: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) {
  print('Failures:');
  __failures.forEach(function (f) {
    print('  - ' + f.name);
    f.msgs.forEach(function (m) { print('      ' + m); });
  });
}
