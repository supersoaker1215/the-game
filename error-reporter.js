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

  const STORAGE_KEY  = 'errorReports';
  const MAX_REPORTS  = 5;       // ring buffer in localStorage
  const MAX_LOG_LINE = 30;      // recent game log lines per report
  const BTN_ID       = 'err-report-btn';
  let memoryReports = [];

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw != null) {
        const stored = JSON.parse(raw) || [];
        if (Array.isArray(stored)) memoryReports = stored.slice(-MAX_REPORTS);
      }
    } catch (e) {
      try { console.warn('[error-reporter] could not read saved reports', e); } catch (_) {}
    }
    return memoryReports.slice();
  }
  function save(list) {
    memoryReports = list.slice(-MAX_REPORTS);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryReports));
      return true;
    } catch (e) {
      try { console.warn('[error-reporter] could not persist report', e); } catch (_) {}
      return false;
    }
  }

  // Pull the last MAX_LOG_LINE entries from Game.state.log if present.
  // Game.state.log is the in-game text log fed by Game.log(); already
  // user-readable, no PII concerns. Falls back to empty array.
  function recentLog() {
    let log;
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
    if (!(err instanceof Error)) err = new Error(String(err));
    const report = {
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
    const all = load();
    all.push(report);
    save(all);
    showButton(all.length);
    try { console.warn('[error-reporter]', kind, report.msg); } catch (e) {}
    return report;
  }

  // Floating button — appears bottom-right when there's at least one
  // captured report. Click to copy the most recent report as JSON
  // to the clipboard for pasting into a bug ticket / chat thread.
  function showButton(count) {
    if (typeof document === 'undefined') return;
    let wrap = document.getElementById(BTN_ID + '-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = BTN_ID + '-wrap';
      wrap.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:99999;display:flex;gap:4px;align-items:center';
      const btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      btn.style.cssText = 'background:#c0392b;color:#fff;border:none;padding:8px 12px;border-radius:6px;font:13px system-ui;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.3)';
      btn.addEventListener('click', onClick);
      const clrBtn = document.createElement('button');
      clrBtn.type = 'button';
      clrBtn.title = 'Dismiss';
      clrBtn.style.cssText = 'background:#555;color:#fff;border:none;padding:8px 10px;border-radius:6px;font:13px system-ui;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.3)';
      clrBtn.textContent = '✕';
      clrBtn.addEventListener('click', function () {
        memoryReports = [];
        try { localStorage.removeItem(STORAGE_KEY); } catch(e) {
          try { console.warn('[error-reporter] could not clear reports', e); } catch (_) {}
        }
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      });
      wrap.appendChild(btn);
      wrap.appendChild(clrBtn);
      document.body.appendChild(wrap);
    }
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.textContent = '⚠ Copy bug report (' + count + ')';
  }

  function onClick() {
    const all = load();
    if (!all.length) return;
    const latest = all[all.length - 1];
    const text = JSON.stringify(latest, null, 2);
    function finish(ok, error) {
      const btn = document.getElementById(BTN_ID);
      if (btn) {
        btn.textContent = ok ? '✓ Copied to clipboard' : '✗ Copy failed (see console)';
        if (!ok) {
          try { console.warn('[error-reporter] clipboard copy failed', error); } catch (_) {}
          console.log('[error-reporter] report:', text);
        }
        setTimeout(function () { showButton(load().length); }, 2000);
      }
    }
    function fallbackCopy() {
      const ta = document.createElement('textarea');
      try {
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        const copied = document.execCommand('copy');
        finish(copied, copied ? null : new Error('execCommand returned false'));
      } catch (e) {
        finish(false, e);
      } finally {
        if (ta.parentNode) ta.parentNode.removeChild(ta);
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        navigator.clipboard.writeText(text).then(function () {
          finish(true);
        }, function (e) {
          fallbackCopy(e);
        });
      } catch (e) {
        fallbackCopy(e);
      }
    } else {
      fallbackCopy();
    }
  }

  // Listen for synchronous JS errors AND unhandled promise rejections.
  // Both forward to record() with a normalized Error object.
  window.addEventListener('error', function (ev) {
    const err = ev.error || new Error(ev.message || 'unknown error');
    record('error', err, {
      file:   ev.filename,
      line:   ev.lineno,
      column: ev.colno,
    });
  });
  window.addEventListener('unhandledrejection', function (ev) {
    const reason = ev.reason || new Error('unhandled promise rejection');
    const err = (reason instanceof Error) ? reason : new Error(String(reason));
    record('unhandledrejection', err);
  });

  // Surface any reports captured in an earlier page load.
  if (load().length) showButton(load().length);

  // Devtools entry point: ErrorReporter.list() → recent reports;
  // ErrorReporter.capture(error, extra) → record a caught error;
  // ErrorReporter.clear() → wipe localStorage.
  window.ErrorReporter = {
    list:  load,
    capture: function (error, extra) { return record('handled-error', error, extra); },
    clear: function () {
      memoryReports = [];
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {
        try { console.warn('[error-reporter] could not clear reports', e); } catch (_) {}
      }
      const wrap = document.getElementById(BTN_ID + '-wrap');
      if (wrap) wrap.remove();
    },
    test:  function () { record('test', new Error('synthetic test error')); },
  };
})();
