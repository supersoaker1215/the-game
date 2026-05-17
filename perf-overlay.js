// ============================================================
// PERF OVERLAY — devtools-gated FPS / frame-time / long-task HUD
// ============================================================
// Enable with ?perf=1 in the URL (or localStorage.perfOverlay = '1').
// Off by default; zero overhead when disabled.
//
// Surfaces:
//   - Live FPS (rolling 60-frame window)
//   - Frame time avg / p95 (ms)
//   - Long task count (PerformanceObserver — anything ≥50ms blocks UX)
//   - render() pass count per second (set via window.PerfOverlay.tickRender())
//   - Memory (heap used MB if available)
//
// Top-right corner, monospace, semi-transparent. Click to expand a
// 5-second long-task log. Useful for spotting regressions before
// they ship — the goal is sub-2% long task rate at 60fps.
// ============================================================
(function () {
  if (typeof window === 'undefined') return;

  var params = new URLSearchParams(location.search);
  var ENABLED =
    params.get('perf') === '1' ||
    (typeof localStorage !== 'undefined' && localStorage.getItem('perfOverlay') === '1');
  if (!ENABLED) {
    // Stub the API so callers don't blow up when overlay is off.
    window.PerfOverlay = { tickRender: function () {}, isEnabled: false };
    return;
  }

  // ---- Frame-time tracking ----
  var frames = [];           // ring buffer of frame deltas, last 120
  var FRAME_BUF_MAX = 120;
  var lastFrameT = performance.now();
  var renderCount = 0;
  var renderCountLastSec = 0;
  var renderTickerT = performance.now();
  var longTasks = 0;
  var recentLongTasks = []; // last 5s of long task entries

  function rafLoop(now) {
    var delta = now - lastFrameT;
    lastFrameT = now;
    frames.push(delta);
    if (frames.length > FRAME_BUF_MAX) frames.shift();
    // 1Hz render-counter rollover
    if (now - renderTickerT >= 1000) {
      renderCountLastSec = renderCount;
      renderCount = 0;
      renderTickerT = now;
    }
    requestAnimationFrame(rafLoop);
  }
  requestAnimationFrame(rafLoop);

  // ---- Long-task observer ----
  // Anything ≥50ms is a long task per the W3C spec — by definition
  // a missed frame at 60Hz. Count them and keep the last 5s for the
  // expand-on-click detail view.
  function onLongTaskBatch(list) {
    const entries = list.getEntries();
    for (let i = 0; i < entries.length; i++) {
      longTasks++;
      recentLongTasks.push({
        t: entries[i].startTime | 0,
        dur: entries[i].duration | 0,
        name: entries[i].name || 'task',
      });
    }
    // Trim to last 5s of entries to keep memory bounded.
    const now = performance.now();
    while (recentLongTasks.length && (now - recentLongTasks[0].t) > 5000) {
      recentLongTasks.shift();
    }
  }
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      new PerformanceObserver(onLongTaskBatch).observe({ entryTypes: ['longtask'] });
    } catch (e) { /* longtask not supported in some browsers */ }
  }

  // ---- HUD ----
  var hud = null;
  var detail = null;
  var expanded = false;

  function buildHud() {
    hud = document.createElement('div');
    hud.id = 'perf-overlay';
    hud.style.cssText = [
      'position:fixed', 'top:8px', 'right:8px', 'z-index:99998',
      'background:rgba(0,0,0,0.72)', 'color:#0f0',
      'font:11px/1.4 ui-monospace,Menlo,monospace',
      'padding:6px 9px', 'border-radius:4px',
      'pointer-events:auto', 'cursor:pointer',
      'min-width:172px', 'text-align:left',
      'border:1px solid rgba(0,255,0,0.25)',
      'user-select:none',
    ].join(';');
    hud.title = 'Click to toggle long-task log (last 5s)';
    hud.addEventListener('click', function () {
      expanded = !expanded;
      if (detail) detail.style.display = expanded ? 'block' : 'none';
    });
    document.body.appendChild(hud);

    detail = document.createElement('div');
    detail.style.cssText = [
      'position:fixed', 'top:78px', 'right:8px', 'z-index:99998',
      'background:rgba(0,0,0,0.85)', 'color:#fc0',
      'font:10px/1.3 ui-monospace,Menlo,monospace',
      'padding:6px 9px', 'border-radius:4px',
      'max-width:340px', 'max-height:240px', 'overflow:auto',
      'border:1px solid rgba(255,200,0,0.25)',
      'display:none',
    ].join(';');
    document.body.appendChild(detail);
  }

  function pct(arr, p) {
    if (!arr.length) return 0;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    var idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx];
  }
  function avg(arr) {
    if (!arr.length) return 0;
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function updateHud() {
    if (!hud) return;
    var avgMs = avg(frames);
    var p95 = pct(frames, 0.95);
    var fps = avgMs > 0 ? Math.round(1000 / avgMs) : 0;
    var color = fps >= 55 ? '#0f0' : (fps >= 40 ? '#fc0' : '#f33');
    var heap = '';
    if (performance.memory) {
      heap = ' · heap ' + (performance.memory.usedJSHeapSize / 1048576 | 0) + 'MB';
    }
    hud.innerHTML = [
      '<span style="color:' + color + '">FPS ' + fps + '</span>' +
        ' · avg ' + avgMs.toFixed(1) + 'ms · p95 ' + p95.toFixed(1) + 'ms',
      'long tasks: ' + longTasks + ' (5s: ' + recentLongTasks.length + ')',
      'render/sec: ' + renderCountLastSec + heap,
    ].join('<br>');
    if (expanded && detail) {
      let html = '<div style="color:#fc0;font-weight:600;margin-bottom:4px">Long tasks (last 5s)</div>';
      if (!recentLongTasks.length) html += '<div style="color:#666">none — buttery</div>';
      else {
        for (let i = recentLongTasks.length - 1; i >= 0; i--) {
          const lt = recentLongTasks[i];
          html += '<div>' + lt.dur + 'ms @ ' + lt.t + 'ms · ' + lt.name + '</div>';
        }
      }
      detail.innerHTML = html;
    }
  }

  // Update the HUD at 4Hz — stable readout without paint cost
  // dominating the very thing we're measuring.
  function startHud() {
    buildHud();
    updateHud();
    setInterval(updateHud, 250);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startHud);
  } else {
    startHud();
  }

  // Public API for the render path to call. UI.render's coalescer
  // calls tickRender() once per actual rAF-flushed pass so the HUD
  // can show the real (post-coalesce) render rate.
  window.PerfOverlay = {
    isEnabled: true,
    tickRender: function () { renderCount++; },
    longTaskCount: function () { return longTasks; },
    recentLongTasks: function () { return recentLongTasks.slice(); },
    framesP95: function () { return pct(frames, 0.95); },
  };
})();
