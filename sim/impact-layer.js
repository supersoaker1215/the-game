// ============================================================
// HEAVY HITS AND KILLS LAND LIKE AAA HITS.
//
//   jsc sim/impact-layer.js
//
// Owner (2026-11-11): "triple AAA animation" -> combat feel. Before (measured
// live, a 7-damage Hulk hit): no freeze, no contact flash, no camera motion —
// only the card's own tint. After: a 70ms hit-stop, a contact flash + shock
// ring + 14 sparks at the target's edge facing the attacker, and the view
// kicks 6px along the blow (translate, so it never fights the shake).
// ============================================================
var __SIM_ROOT_OVERRIDE = '.';
load('./sim/shim-dom.js');
var SRC = read('ui.js');
var pass = 0, fails = [];
function check(name, cond, detail) { if (cond) pass++; else fails.push(name + (detail ? ' — ' + detail : '')); }
var T = UI._TIER_FX;
check('heavy hits freeze briefly now (hit-stop), not only kills', T.heavy.hitPause > 0 && T.heavy.hitPause <= 90, T.heavy.hitPause);
check('a kill\'s freeze is a few frames, not a stall (<= 160ms)', T.lethal.hitPause > T.heavy.hitPause && T.lethal.hitPause <= 160, T.lethal.hitPause);
check('light/medium stay snappy: no freeze, no kick', !T.light.hitPause && !T.medium.hitPause && !T.light.kick && !T.medium.kick);
check('heavy + lethal kick the camera, lethal harder and with a zoom punch', T.heavy.kick > 0 && T.lethal.kick > T.heavy.kick && T.lethal.zoom > 1);
check('the hit bundle runs the impact layer', /if \(fx\.kick\) this\._impactLayer\(cardEl, ev\.attackerId, fx\);/.test(SRC));
check('…and so does a killing blow whose card is already gone', /if \(fx\.kick\) this\._impactLayer\(null, ev\.attackerId, fx, ev\.cardId\);/.test(SRC));
var body = SRC.slice(SRC.indexOf('  _impactLayer(targetEl, attackerId, fx, deadId) {'), SRC.indexOf('  // Brief board-wide freeze-frame on lethal hits'));
check('the kick rides `translate`, never the shake\'s transform', /area\.style\.translate = '0 ' \+ k \+ 'px'/.test(body) && !/area\.style\.transform/.test(body));
check('the kick is skipped on the low-fx tier and under reduced motion', /classList\.contains\('low-fx'\)/.test(body) && /_reducedMotion/.test(body));
print('impact-layer: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(function (f) { print('  FAIL  ' + f); });
if (fails.length) throw new Error('impact-layer failed');
