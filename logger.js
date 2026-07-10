// ============================================================
// PLAY LOGGER — debug-mode instrumentation for AI coaching
// ============================================================
// Enable with ?debug=1 in the URL (or localStorage.debugMode = '1').
//
// What it does when enabled:
//   - Reveals the AI's hand face-up so you can reason about its options.
//   - Records every playCard / playCardFree / playTrick to localStorage
//     with a full snapshot of both players' state at the moment of the move.
//   - Press F to annotate the last logged move with a one-line note.
//   - Floating top-left toolbar with Export (copies JSON to clipboard) and
//     Clear. Paste the export back to Claude to mine patterns from.
//
// Zero effect when debug mode is off — wraps are only installed inside the
// DEBUG branch. Safe to leave the file loaded in production.
// ============================================================
(function () {
  const params = new URLSearchParams(location.search);
  const DEBUG =
    params.get('debug') === '1' ||
    (typeof localStorage !== 'undefined' && localStorage.getItem('debugMode') === '1');
  if (!DEBUG) return;
  if (typeof Game === 'undefined' || typeof UI === 'undefined') {
    console.warn('[logger] Game/UI not loaded yet — logger disabled.');
    return;
  }

  // ----- storage -----
  const STORAGE_KEY = 'playLog';
  function reportLoggerError(error, context) {
    if (typeof window !== 'undefined' && window.ErrorReporter && window.ErrorReporter.capture) {
      window.ErrorReporter.capture(error, { source: 'logger', context });
    } else {
      console.error(`[logger:${context}]`, error);
    }
  }
  function loadLog() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch (e) {
      reportLoggerError(e, 'storage-read');
      return [];
    }
  }
  function saveLog() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(log));
    } catch (e) {
      reportLoggerError(e, 'storage-write');
    }
    updateCount();
  }
  let log = loadLog();

  // ----- snapshot -----
  // Capture the full decision context. Keys short to keep the JSON small
  // across hundreds of moves per session.
  function cardSnap(c) {
    if (!c) return null;
    return { n: c.name, c: c.cost, a: c.attack, h: c.currentHealth };
  }
  function snap() {
    const s = Game.state;
    return {
      t: Date.now(),
      round: s.round,
      phase: s.phase,
      firstPlayer: s.firstPlayer,
      pHP: s.player.health,
      aHP: s.ai.health,
      pE: s.player.currency,
      aE: s.ai.currency,
      pHand: s.player.hand.map(cardSnap),
      aHand: s.ai.hand.map(cardSnap),
      pTricks: s.player.trickHand.map(t => t.name),
      aTricks: s.ai.trickHand.map(t => t.name),
      lanes: s.lanes.map(l => ({ p: cardSnap(l.player), a: cardSnap(l.ai) })),
    };
  }

  // ----- wrap game actions -----
  const origPlayCard = Game.playCard.bind(Game);
  Game.playCard = function (owner, card, laneIdx) {
    const before = snap();
    const handSizeBefore = Game.state[owner].hand.length;
    const result = origPlayCard(owner, card, laneIdx);
    // origPlayCard returns true on success; early-return paths don't log.
    // Some abilities return early without returning explicitly — check hand
    // delta as a fallback signal of actual play.
    const played = result === true || Game.state[owner].hand.length < handSizeBefore;
    if (played) {
      log.push({
        kind: 'playCard', owner, card: card.name, cost: card.cost, lane: laneIdx, before,
      });
      saveLog();
    }
    return result;
  };

  const origPlayCardFree = Game.playCardFree.bind(Game);
  Game.playCardFree = function (owner, card, laneIdx) {
    const before = snap();
    const result = origPlayCardFree(owner, card, laneIdx);
    log.push({
      kind: 'playCardFree', owner, card: card.name, cost: card.cost, lane: laneIdx, before, jump: true,
    });
    saveLog();
    return result;
  };

  const origPlayTrick = Game.playTrick.bind(Game);
  Game.playTrick = function (owner, trick) {
    const before = snap();
    const handSizeBefore = Game.state[owner].trickHand.length;
    const result = origPlayTrick(owner, trick);
    const played = result === true || Game.state[owner].trickHand.length < handSizeBefore;
    if (played) {
      log.push({
        kind: 'playTrick', owner, trick: trick.name, cost: trick.cost, before,
      });
      saveLog();
    }
    return result;
  };

  // Draft picks — capture what was offered, what you picked, and what the
  // AI picked in the same round. Both picks happen per round: AI pre-picks
  // inside presentDraftChoices before the player sees their own choices,
  // so by the time draftPick fires the AI's pick is already in *Drafted[-1].
  // Logged entry:
  //   kind: 'draftPick'
  //   phase: 'cards' | 'tricks'
  //   round: 1..5 (cards) or 1..2 (tricks)
  //   pOffered, pPicked, aOffered, aPicked — card/trick snapshots
  //   pDraftedBefore, aDraftedBefore — what each side already had
  const origDraftPick = Game.draftPick ? Game.draftPick.bind(Game) : null;
  if (origDraftPick) {
    Game.draftPick = function (index) {
      const d = this.state.draft;
      if (!d) return origDraftPick(index);
      const phase = d.phase;
      const round = d.round;
      const pOffered = (d.playerChoices || []).map(c => ({
        n: c.name, c: c.cost, a: c.attack, h: c.health,
        abilities: c.abilities || []
      }));
      const aOffered = (d.aiChoices || []).map(c => ({
        n: c.name, c: c.cost, a: c.attack, h: c.health,
        abilities: c.abilities || []
      }));
      const pPicked = pOffered[index] || null;
      const draftedList = phase === 'cards' ? d.aiDrafted : d.aiTrickDrafted;
      const aPicked = draftedList && draftedList.length
        ? (() => {
            const last = draftedList[draftedList.length - 1];
            return { n: last.name, c: last.cost, a: last.attack, h: last.health,
                     abilities: last.abilities || [] };
          })()
        : null;
      const pDraftedBefore = (phase === 'cards' ? d.playerDrafted : d.playerTrickDrafted)
        .map(c => c.name);
      const aDraftedBefore = (phase === 'cards' ? d.aiDrafted.slice(0, -1) : d.aiTrickDrafted.slice(0, -1))
        .map(c => c.name);
      const result = origDraftPick(index);
      log.push({
        kind: 'draftPick', phase, round,
        pOffered, pPicked, aOffered, aPicked,
        pDraftedBefore, aDraftedBefore,
        t: Date.now(),
      });
      saveLog();
      return result;
    };
  }

  // Game end — record winner so post-hoc analysis can filter by outcome.
  const origFinalizeStats = Game.finalizeStats ? Game.finalizeStats.bind(Game) : null;
  if (origFinalizeStats) {
    Game.finalizeStats = function () {
      const r = origFinalizeStats();
      log.push({
        kind: 'gameEnd',
        winner: Game.state.winner,
        round: Game.state.round,
        pHP: Game.state.player.health,
        aHP: Game.state.ai.health,
        t: Date.now(),
      });
      saveLog();
      return r;
    };
  }

  // ----- reveal AI hand face-up, as tiny name tags -----
  // Full card elements overlap the AI HP bar. Compact tag form keeps
  // everything visible — just cost + name (+ a/h for cards).
  const origRenderAIHand = UI.renderAIHand.bind(UI);
  UI.renderAIHand = function (s) {
    origRenderAIHand(s);
    this.aiHand.innerHTML = '';
    const baseTag = [
      'display:inline-flex', 'align-items:center', 'gap:4px',
      'padding:2px 6px', 'margin:2px',
      'font:10px ui-monospace,Menlo,monospace',
      'border-radius:3px', 'white-space:nowrap',
      'line-height:1.2',
    ].join(';');
    s.ai.hand.forEach(card => {
      const el = document.createElement('div');
      el.className = 'debug-reveal debug-reveal-card';
      el.style.cssText = baseTag + ';border:1px solid #0cf;background:rgba(0,30,45,0.7);color:#7ff';
      el.textContent = `${card.cost}⚡ ${card.name} ${card.attack}/${card.currentHealth}`;
      el.title = (card.desc || '') + (card.abilities && card.abilities.length ? ` [${card.abilities.join(', ')}]` : '');
      this.aiHand.appendChild(el);
    });
    s.ai.trickHand.forEach(trick => {
      const el = document.createElement('div');
      el.className = 'debug-reveal debug-reveal-trick';
      el.style.cssText = baseTag + ';border:1px dashed #f90;background:rgba(40,20,0,0.7);color:#fc6';
      el.textContent = `${trick.cost}⚡ ${trick.name}`;
      el.title = trick.desc || '';
      this.aiHand.appendChild(el);
    });
  };

  // ----- F hotkey: annotate last move -----
  // The preview sandbox blocks native prompt(), so this uses an in-page
  // modal. Enter saves, Escape cancels.
  function showNoteModal(entry) {
    const prior = document.getElementById('debug-note-modal');
    if (prior) prior.remove();
    const label = entry.card || entry.trick || entry.kind;
    const round = entry.before && entry.before.round;

    const modal = document.createElement('div');
    modal.id = 'debug-note-modal';
    modal.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:100000',
      'background:rgba(0,0,0,0.8)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'padding:20px',
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'background:#0a1420', 'border:1px solid #0cf', 'border-radius:6px',
      'padding:16px', 'width:520px', 'max-width:90vw',
      'display:flex', 'flex-direction:column', 'gap:10px',
      'font:13px ui-monospace,Menlo,monospace', 'color:#7ff',
    ].join(';');

    const header = document.createElement('div');
    header.innerHTML = `<div style="color:#0cf;font-weight:bold;margin-bottom:4px">Note on ${entry.kind}: ${label}</div>
      <div style="font-size:11px;color:#89a">Round ${round} · ${entry.owner || ''}${entry.lane !== undefined ? ` · lane ${entry.lane + 1}` : ''}</div>`;

    const ta = document.createElement('textarea');
    ta.value = entry.note || '';
    ta.placeholder = 'e.g. "AI played Peacemaker in front of Flash — wasted body into Invincible"';
    ta.rows = 3;
    ta.style.cssText = [
      'width:100%', 'background:#000', 'color:#7ff',
      'border:1px solid #234', 'border-radius:3px',
      'padding:8px', 'font:12px ui-monospace,Menlo,monospace',
      'resize:vertical', 'min-height:60px', 'box-sizing:border-box',
    ].join(';');

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:11px;color:#89a;margin-top:-4px';
    hint.textContent = 'Enter to save · Esc to cancel';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:6px 12px;cursor:pointer;background:#222;color:#7ff;border:1px solid #0cf;border-radius:3px;font:12px ui-monospace';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save Note';
    saveBtn.style.cssText = 'padding:6px 14px;cursor:pointer;background:#0cf;color:#001;border:none;border-radius:3px;font:12px ui-monospace;font-weight:bold';

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);

    panel.appendChild(header);
    panel.appendChild(ta);
    panel.appendChild(hint);
    panel.appendChild(btnRow);
    modal.appendChild(panel);

    const cleanup = () => {
      modal.remove();
      document.removeEventListener('keydown', onKey);
    };
    const save = () => {
      entry.note = ta.value.trim();
      saveLog();
      cleanup();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); cleanup(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    };

    cancelBtn.addEventListener('click', cleanup);
    saveBtn.addEventListener('click', save);
    modal.addEventListener('click', (e) => { if (e.target === modal) cleanup(); });
    document.addEventListener('keydown', onKey);

    document.body.appendChild(modal);
    setTimeout(() => { ta.focus(); ta.select(); }, 50);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'f' && e.key !== 'F') return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    // Ignore if the note modal is already open (don't stack)
    if (document.getElementById('debug-note-modal')) return;
    const last = log[log.length - 1];
    if (!last) return;
    e.preventDefault();
    showNoteModal(last);
  });

  // ----- floating toolbar -----
  function mountBar() {
    if (document.getElementById('debug-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'debug-bar';
    bar.style.cssText = [
      'position:fixed', 'top:8px', 'left:8px', 'z-index:99999',
      'display:flex', 'gap:6px', 'align-items:center',
      'font:12px ui-monospace,Menlo,monospace',
      'background:rgba(0,20,30,0.85)', 'padding:6px 8px',
      'border:1px solid #0cf', 'border-radius:4px',
      'color:#7ff', 'box-shadow:0 0 10px rgba(0,200,255,0.3)',
    ].join(';');
    bar.innerHTML = [
      '<span style="font-weight:bold;color:#0cf">DEBUG</span>',
      '<button id="dbg-export" style="padding:3px 8px;cursor:pointer">Export</button>',
      '<button id="dbg-clear" style="padding:3px 8px;cursor:pointer">Clear</button>',
      '<span id="dbg-count" style="margin-left:4px"></span>',
      '<span style="opacity:0.7;margin-left:8px">F=note</span>',
    ].join('');
    document.body.appendChild(bar);
    document.getElementById('dbg-export').addEventListener('click', exportLog);
    document.getElementById('dbg-clear').addEventListener('click', clearLog);
    updateCount();
  }
  function updateCount() {
    const el = document.getElementById('dbg-count');
    if (!el) return;
    const games = log.filter(e => e.kind === 'gameEnd').length;
    const moves = log.length - games;
    const annotated = log.filter(e => e.note).length;
    el.textContent = `${games} games · ${moves} moves · ${annotated} notes`;
  }
  function exportLog() {
    // The preview sandbox blocks navigator.clipboard AND window.open(), so
    // show an in-page modal with a textarea. User hits "Select All + Copy"
    // (uses document.execCommand as a fallback) or just Cmd/Ctrl+A, Cmd/Ctrl+C.
    // Also offers a "Download JSON" link via Blob URL in case clipboard is
    // also blocked — Blob URLs work inside the preview because they're
    // same-origin.
    const json = JSON.stringify(log, null, 2);
    const prior = document.getElementById('debug-export-modal');
    if (prior) prior.remove();

    const modal = document.createElement('div');
    modal.id = 'debug-export-modal';
    modal.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:100000',
      'background:rgba(0,0,0,0.85)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'padding:20px',
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'background:#0a1420', 'border:1px solid #0cf', 'border-radius:6px',
      'padding:16px', 'max-width:90vw', 'max-height:90vh',
      'display:flex', 'flex-direction:column', 'gap:10px',
      'width:800px',
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;font:13px ui-monospace,Menlo,monospace;color:#7ff';
    const games = log.filter(e => e.kind === 'gameEnd').length;
    header.innerHTML = `<div>Play log — <strong>${log.length}</strong> entries (${games} games)</div>`;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕ Close';
    closeBtn.style.cssText = 'padding:4px 10px;cursor:pointer;background:#222;color:#7ff;border:1px solid #0cf;border-radius:3px;font:12px ui-monospace';
    closeBtn.addEventListener('click', () => modal.remove());
    header.appendChild(closeBtn);

    const ta = document.createElement('textarea');
    ta.value = json;
    ta.readOnly = true;
    ta.style.cssText = [
      'flex:1', 'min-height:400px', 'width:100%',
      'background:#000', 'color:#7ff',
      'border:1px solid #234', 'border-radius:3px',
      'padding:8px', 'font:11px ui-monospace,Menlo,monospace',
      'resize:vertical',
    ].join(';');

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center';

    const selectAllBtn = document.createElement('button');
    selectAllBtn.textContent = 'Select All';
    selectAllBtn.style.cssText = 'padding:6px 12px;cursor:pointer;background:#0cf;color:#001;border:none;border-radius:3px;font:12px ui-monospace;font-weight:bold';
    selectAllBtn.addEventListener('click', () => { ta.focus(); ta.select(); });

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy (execCommand)';
    copyBtn.style.cssText = 'padding:6px 12px;cursor:pointer;background:#222;color:#7ff;border:1px solid #0cf;border-radius:3px;font:12px ui-monospace';
    copyBtn.addEventListener('click', () => {
      ta.focus(); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      copyBtn.textContent = ok ? '✓ Copied!' : 'Copy failed — use Select All + Cmd/Ctrl+C';
      setTimeout(() => { copyBtn.textContent = 'Copy (execCommand)'; }, 2500);
    });

    const downloadLink = document.createElement('a');
    const blob = new Blob([json], { type: 'application/json' });
    const blobUrl = URL.createObjectURL(blob);
    downloadLink.href = blobUrl;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadLink.download = `playlog-${stamp}.json`;
    downloadLink.textContent = 'Download .json';
    downloadLink.style.cssText = 'padding:6px 12px;cursor:pointer;background:#222;color:#7ff;border:1px solid #0cf;border-radius:3px;font:12px ui-monospace;text-decoration:none';

    const hint = document.createElement('span');
    hint.textContent = 'or: click in the box, Cmd/Ctrl+A, Cmd/Ctrl+C';
    hint.style.cssText = 'font:11px ui-monospace,Menlo,monospace;color:#89a;margin-left:auto';

    btnRow.appendChild(selectAllBtn);
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(downloadLink);
    btnRow.appendChild(hint);

    panel.appendChild(header);
    panel.appendChild(ta);
    panel.appendChild(btnRow);
    modal.appendChild(panel);

    // Click outside panel closes
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    // Esc closes
    const onKey = (e) => {
      if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(modal);
    // Autofocus + select for immediate Cmd+C
    setTimeout(() => { ta.focus(); ta.select(); }, 50);
  }
  function clearLog() {
    if (!confirm(`Clear ${log.length} log entries? This cannot be undone.`)) return;
    log = [];
    saveLog();
  }

  // Defer mounting until DOM is ready so the toolbar doesn't race index.html
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountBar);
  } else {
    mountBar();
  }

  console.log('[logger] Debug mode active. Log has', log.length, 'entries.');
})();
