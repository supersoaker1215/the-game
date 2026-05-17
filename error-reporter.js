// ============================================================
// ERROR REPORTER — client-side crash capture for bug reports
// ============================================================
// Always-on. Hooks window.onerror and unhandledrejection; when a
// crash fires, captures a structured bug report (error + stack +
// game phase + sanitized lane snapshot + last 30 log lines) into
// localStorage and surfaces a floating "Copy bug report" button.
//
// Zero overhead until an error happens — listeners are passive.
// Privacy-aware: only captures the user's OWN game state, no
// network calls. The user clicks "Copy" to opt into sharing.
// ============================================================
(function () {
  if (typeof window === 'undefined') return;

  var STORAGE_KEY  = 'errorReports';
  var MAX_REPORTS  = 5;       // ring buffer in localStorage
  var MAX_LOG_LINE = 30;      // recent game log lines per report
  var BTN_ID       = 'err-report-btn';

  function load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
    catch (e) { return []; }
  }
  function save(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_REPORTS))); }
    catch (e) {}
  }

  // Pull the last MAX_LOG_LINE entries from Game.state.log if present.
  // Game.state.log is the in-game text log fed by Game.log(); already
  // user-readable, no PII concerns. Falls back to empty array.
  function recentLog() {
    var log;
    try {
      if (typeof Game === 'undefined' || !Game.state || !Game.state.log) return [];
      log = Game.state.log;
      return log.slice(Math.max(0, log.length - MAX_LOG_LINE));
    } catch (e) { return []; }
  }

  // Sanitized snapshot of the lane state — just enough to repro a
  // bug, no internal flags that change the report shape week to
  // week. Strips _* private fields.
  function laneSnap() {
    try {
      if (typeof Game === 'undefined' || !Game.state || !Game.state.lanes) return null;
      return Game.state.lanes.map(function (lane) {
        return {
          destroyed: !!lane.destroyed,
          player: lane.player ? cardSnap(lane.player) : null,
          ai:     lane.ai     ? cardSnap(lane.ai)     : null,
        };
      });
    } catch (e) { return null; }
  }
  function cardSnap(c) {
    if (!c) return null;
    return {
      name: c.name, owner: c.owner, attack: c.attack | 0,
      currentHealth: c.currentHealth | 0, maxHealth: c.maxHealth | 0,
      isStunned: !!c.isStunned, isFrozen: !!c.isFrozen,
      isFeared:  !!c.isFeared,  isMindControlled: !!c.isMindControlled,
    };
  }

  function gameMeta() {
    try {
      if (typeof Game === 'undefined' || !Game.state) return null;
      return {
        phase:    Game.state.phase || null,
        round:    Game.state.round || 0,
        gameOver: !!Game.state.gameOver,
        playerHp: Game.state.player && Game.state.player.health,
        aiHp:     Game.state.ai     && Game.state.ai.health,
        roguelite: Game.state.roguelite ? {
          act:  Game.state.roguelite.act,
          node: Game.state.roguelite.currentNode && Game.state.roguelite.currentNode.kind,
          hp:   Game.state.roguelite.hp,
          asc:  Game.state.roguelite.ascension,
        } : null,
      };
    } catch (e) { return null; }
  }

  function record(kind, err, extra) {
    var report = {
      kind: kind,
      time: new Date().toISOString(),
      ua:   navigator.userAgent,
      url:  location.href,
      msg:  (err && err.message) || String(err),
      stack: (err && err.stack) || null,
      meta: gameMeta(),
      lanes: laneSnap(),
      log:  recentLog(),
    };
    if (extra) {
      Object.keys(extra).forEach(function (k) { report[k] = extra[k]; });
    }
    var all = load();
    all.push(report);
    save(all);
    showButton(all.length);
    try { console.warn('[error-reporter]', kind, report.msg); } catch (e) {}
  }

  // Floating button — appears bottom-right when there's at least one
  // captured report. Click to copy the most recent report as JSON
  // to the clipboard for pasting into a bug ticket / chat thread.
  function showButton(count) {
    if (typeof document === 'undefined') return;
    var btn = document.getElementById(BTN_ID);
    if (!btn) {
      btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      btn.style.cssText = [
        'position:fixed', 'bottom:12px', 'right:12px', 'z-index:99999',
        'background:#c0392b', 'color:#fff', 'border:none',
        'padding:8px 12px', 'border-radius:6px', 'font:13px system-ui',
        'cursor:pointer', 'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
      ].join(';');
      btn.addEventListener('click', onClick);
      document.body.appendChild(btn);
    }
    btn.textContent = '⚠ Copy bug report (' + count + ')';
  }

  function onClick() {
    var all = load();
    if (!all.length) return;
    var latest = all[all.length - 1];
    var text = JSON.stringify(latest, null, 2);
    var ok = false;
    var ta;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { ok = true; });
      } else {
        // Legacy fallback for older Safari etc.
        ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        ok = true;
      }
    } catch (e) {}
    var btn = document.getElementById(BTN_ID);
    if (btn) {
      btn.textContent = ok ? '✓ Copied to clipboard' : '✗ Copy failed (see console)';
      if (!ok) console.log('[error-reporter] report:', text);
      setTimeout(function () { showButton(load().length); }, 2000);
    }
  }

  // Listen for synchronous JS errors AND unhandled promise rejections.
  // Both forward to record() with a normalized Error object.
  window.addEventListener('error', function (ev) {
    var err = ev.error || new Error(ev.message || 'unknown error');
    record('error', err, {
      file:   ev.filename,
      line:   ev.lineno,
      column: ev.colno,
    });
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var reason = ev.reason || new Error('unhandled promise rejection');
    var err = (reason instanceof Error) ? reason : new Error(String(reason));
    record('unhandledrejection', err);
  });

  // Surface any reports captured before this script loaded (e.g. an
  // error during initial game.js parse). Show the button on init.
  if (load().length) showButton(load().length);

  // Devtools entry point: ErrorReporter.list() → recent reports;
  // ErrorReporter.clear() → wipe localStorage.
  window.ErrorReporter = {
    list:  load,
    clear: function () { try { localStorage.removeItem(STORAGE_KEY); } catch (e) {} var b = document.getElementById(BTN_ID); if (b) b.remove(); },
    test:  function () { record('test', new Error('synthetic test error')); },
  };
})();
