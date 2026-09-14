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

t('AC-1 the swing fires the attacker\'s own cue at the impact frame', function () {
  var body = decomment(methodBody('showDamageFloats'));
  eq('found showDamageFloats', body.length > 400, true);
  eq('the swing asks for the attacker cue', /_playAttackerCue\(ev\.attackerId\)/.test(body), true);
  // It has to sit with the impact, not with the resolve — the generic hit sound
  // is already deferred to the lunge contact frame and the two are one moment.
  // `play('hit')` appears TWICE in here (the killing-blow branch, where the
  // victim's node is already gone, and the impact frame), so this looks for the
  // one immediately BEFORE the cue rather than the first in the function.
  var cue = body.indexOf('_playAttackerCue(ev.attackerId)');
  var hit = body.lastIndexOf("this.sfx.play('hit'", cue);
  eq('right beside the generic impact', cue > -1 && hit > -1 && cue - hit < 200, true);
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
