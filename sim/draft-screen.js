// ============================================================
// DRAFT — the owner's six changes, pinned.
//
//   jsc sim/draft-screen.js
//
// Each case names the thing that was wrong, because several of these are
// choices a later pass would happily undo as a "consistency" fix.
// ============================================================

var CSS = read('style.css');
var BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, ' '); });
var UI  = read('ui.js');

var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
function ruleBody(sel) {
  var re = new RegExp('(^|[};])\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^{}]*)\\}', 'gm');
  var m, last = null;
  while ((m = re.exec(BARE))) last = m[2];
  return last;
}

// ---- 1 · one header, progress as a five-segment tick -----------------------
check('the header is one row, not three stacked bars',
      /class="dh-left"/.test(UI) && /class="dh-progress"/.test(UI) && /class="dh-actions"/.test(UI));
check('the old stacked rows are gone',
      !/class="draft-hud-row"/.test(UI.slice(UI.indexOf('renderDraft(s) {'))) &&
      !/class="draft-first /.test(UI.slice(UI.indexOf('renderDraft(s) {'))),
      'renderDraft still emits draft-hud-row / draft-first');
check('pick progress is a segmented tick', /class="dh-tick"/.test(UI) && /dh-seg/.test(UI));
check('the numbered round pips are not used by the draft header',
      !/draft-hud-pips/.test(UI.slice(UI.indexOf('renderDraft(s) {'), UI.indexOf('renderDraft(s) {') + 4000)));

// ---- 2 · body neutral, trigger labels keep the accent ----------------------
var body = ruleBody('.draft-card .card-desc,\n.draft-card .card-desc .cd-row,\n.draft-card .card-desc .cd-eff');
if (!body) body = (BARE.match(/\.draft-card \.card-desc[^{]*\{([^{}]*)\}/) || [])[1];
check('rules body is neutral #c9d6de', !!body && /#c9d6de/i.test(body),
      body ? body.replace(/\s+/g, ' ').trim().slice(0, 70) : 'no rule');
var trig = ruleBody('.draft-card .card-desc .cd-trig');
check('trigger labels keep the frame accent',
      !!trig && /--portrait-frame-rgb/.test(trig),
      'the labels are the one place colour does structural work — it marks where one ability ends');

// ---- 3 · the card shrinks and loses the dead gap ---------------------------
var art = ruleBody('.card.card.draft-card .card-portrait');
check('the art is pinned at 328, at the WINNING specificity',
      !!art && /328px/.test(art) && /flex:\s*0 0 328px/.test(art),
      'the owning rule is .card.card.draft-card .card-portrait (0,4,0 + !important) with flex-grow:1 — ' +
      'a 0,2,0 override loses and the art absorbs the card height instead (measured 406px against 328)');
var cardBox = ruleBody('.card.card.draft-card');
check('card height is a FLOOR, so a long card is not clipped',
      !!cardBox && /min-height:\s*var\(--read-card-h\)/.test(cardBox) && /max-height:\s*none/.test(cardBox),
      'pinning the height clipped Thor\'s second ability under the stat row');

// ---- 4 · attack and health must READ APART --------------------------------
// HISTORY, so this is not flipped back by citing the older instruction. The
// mock's caption asked for "health white-cored like attack, since red means
// the opposing side everywhere else", and that shipped: both pips took the
// frame colour. The owner then REVERSED it on sight — with both corners green
// you could not tell attack from health at a glance, which costs more than the
// colour collision did. Attack is the board's green pip, health the board's
// red pip, the same pair the hand and board already use.
//
// So what is pinned here is the REQUIREMENT, not either answer: the two pips
// must differ. That holds whichever palette wins next.
var hpPip  = ruleBody('.draft-card .stat-hp::before');
var atkPip = ruleBody('.draft-card .stat-atk::before');
check('attack and health pips are distinguishable',
      !!hpPip && !!atkPip && hpPip.replace(/\s/g, '') !== atkPip.replace(/\s/g, ''),
      'both corners the same colour means the two stats do not read apart');
check('health takes the board\'s red pip', !!hpPip && /#ff6b6b/i.test(hpPip));
check('attack takes the board\'s green pip', !!atkPip && /#3dff9e/i.test(atkPip));

// ---- 5 · picks rail is chips, not five card-shaped containers --------------
var tile = ruleBody('.draft-rail-left .dpr-slot .dpr-tile');
check('an empty pick is a small chip', !!tile && /width:\s*30px/.test(tile));
var slot = ruleBody('.draft-rail-left .dpr-slot');
check('the pick row itself carries no box',
      !!slot && /background:\s*none/.test(slot) && /border:\s*0/.test(slot));

// ---- 6 · empty state is a dim word, not an outlined container -------------
var none = ruleBody('.draft-rail-right .dcr-kw-none');
check('the empty keyword state drops its box',
      !!none && /border:\s*0/.test(none) && /background:\s*none/.test(none),
      'an outlined container promises something is coming; nothing is, until you pick it');

print('draft-screen: ' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) { print('Failures:'); fails.forEach(function (f) { print('  - ' + f); }); }
