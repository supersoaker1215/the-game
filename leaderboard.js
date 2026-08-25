// ============================================================
// LEADERBOARD CLIENT — the shared, cross-player scoreboard
// ============================================================
//
// Talks to the PartyKit "stats" party (partykit/stats-server.js), one global
// room every player joins from the main menu. It reports each finished game
// (win/loss, the cards you played, how long it ran) and receives the ranked
// board back, which UI renders on the menu.
//
// Identity, without accounts or passwords:
//   • A per-DEVICE anonymous id, generated once and kept in localStorage. It
//     is the server key, so your history follows you across sessions and a
//     rename never splits or collides it.
//   • Your REAL NAME, typed on first launch (so everyone knows who is who),
//     stored locally and sent as display text.
//
// Configuration: the deployed stats URL lives in `window.CLB_STATS_URL`
// (set in index.html after you `npx partykit deploy`). Until it's set the
// client stays in LOCAL-ONLY mode — no socket, and the menu shows just your
// own record built from local stats — so nothing breaks before deploy.
//
// Best-effort throughout: a down server, a bad URL, or a blocked WebSocket
// never throws into the game. The board simply doesn't update.

const Leaderboard = {
  _ID_KEY:   'clb_device_id',
  _NAME_KEY: 'clb_player_name',
  _FAV_KEY:  'clb_favorite_card',

  _socket: null,
  _connected: false,
  _board: [],            // last board received from the server
  _listeners: [],        // fns called whenever the board changes
  _retryMs: 2000,        // reconnect backoff, grows to a cap
  _helloSent: false,
  _wantOpen: false,      // true once connect() is called; drives reconnect

  // ---- configuration -------------------------------------------------
  // Deployed base URL, e.g. "https://card-lane-battle.<you>.partykit.dev".
  // http(s) is fine — we rewrite the scheme to ws(s) when opening the socket.
  baseUrl() {
    const u = (typeof window !== 'undefined' && window.CLB_STATS_URL) || '';
    return String(u).replace(/\/+$/, '');
  },
  isConfigured() { return !!this.baseUrl(); },

  // ---- identity ------------------------------------------------------
  deviceId() {
    let id = this._ls(this._ID_KEY);
    if (!id) {
      id = 'd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      this._lsSet(this._ID_KEY, id);
    }
    return id;
  },
  name() { return this._ls(this._NAME_KEY) || ''; },
  hasName() { return !!this.name(); },
  setName(n) {
    const clean = String(n || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
    if (!clean) return false;
    this._lsSet(this._NAME_KEY, clean);
    this._send({ t: 'hello', id: this.deviceId(), name: clean });
    return true;
  },
  favorite() { return this._ls(this._FAV_KEY) || null; },
  setFavorite(card) {
    const clean = String(card || '').slice(0, 48);
    this._lsSet(this._FAV_KEY, clean);
    this._send({ t: 'favorite', id: this.deviceId(), name: this.name(), card: clean });
    if (typeof UI !== 'undefined' && UI._renderLeaderboard) { try { UI._renderLeaderboard(); } catch (e) {} }
  },

  // ---- connection ----------------------------------------------------
  connect() {
    this._wantOpen = true;
    if (!this.isConfigured()) return;          // local-only until deployed
    if (typeof WebSocket === 'undefined') return;
    if (this._socket && (this._socket.readyState === 0 || this._socket.readyState === 1)) return;
    let url;
    try {
      url = this.baseUrl().replace(/^http/, 'ws') + '/parties/stats/global';
    } catch (e) { return; }
    let sock;
    try { sock = new WebSocket(url); } catch (e) { this._scheduleReconnect(); return; }
    this._socket = sock;
    this._helloSent = false;
    sock.onopen = () => {
      this._connected = true;
      this._retryMs = 2000;
      // Announce ourselves so the server has our current name on file.
      if (this.hasName()) { this._sendRaw({ t: 'hello', id: this.deviceId(), name: this.name() }); }
      this._sendRaw({ t: 'getBoard' });
    };
    sock.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && msg.t === 'board' && Array.isArray(msg.players)) {
        this._board = msg.players;
        this._notify();
      }
    };
    sock.onclose = () => { this._connected = false; this._socket = null; this._scheduleReconnect(); };
    sock.onerror = () => { try { sock.close(); } catch (e) {} };
  },
  _scheduleReconnect() {
    if (!this._wantOpen || !this.isConfigured()) return;
    const wait = this._retryMs;
    this._retryMs = Math.min(30000, Math.round(this._retryMs * 1.6));
    setTimeout(() => { if (this._wantOpen) this.connect(); }, wait);
  },

  // ---- reporting -----------------------------------------------------
  // Called from Game.finalizeStats at game over.
  reportResult(result) {
    if (!result) return;
    const payload = {
      t: 'report',
      id: this.deviceId(),
      name: this.name(),
      win: !!result.win,
      cards: Array.isArray(result.cards) ? result.cards.slice(0, 24) : [],
      ms: Math.max(0, result.ms | 0),
    };
    // Keep a local mirror so the menu updates instantly even offline; the
    // server's authoritative board overwrites it on the next push.
    this._applyLocalMirror(payload);
    this._send(payload);
  },

  // ---- board access for the UI --------------------------------------
  board() { return this._board.slice(); },
  myRow() {
    const id = this.deviceId();
    return this._board.find(r => r.id === id) || null;
  },
  onChange(fn) { if (typeof fn === 'function') this._listeners.push(fn); },
  _notify() {
    this._listeners.forEach(fn => { try { fn(this._board); } catch (e) {} });
    if (typeof UI !== 'undefined' && UI._renderLeaderboard) { try { UI._renderLeaderboard(); } catch (e) {} }
  },

  // ---- internals -----------------------------------------------------
  _send(msg) {
    if (this._socket && this._socket.readyState === 1) { this._sendRaw(msg); return; }
    // Not open yet — a hello/favorite will be re-sent on the next open();
    // reports are best-effort and already mirrored locally.
    if (this._wantOpen) this.connect();
  },
  _sendRaw(msg) { try { this._socket.send(JSON.stringify(msg)); } catch (e) {} },

  // Update the cached board for OUR row without waiting for the server, so a
  // just-finished game shows immediately. Mirrors the server's report math.
  _applyLocalMirror(payload) {
    const id = this.deviceId();
    let row = this._board.find(r => r.id === id);
    if (!row) {
      row = { id, name: this.name() || 'You', wins: 0, losses: 0, playMs: 0, favorite: this.favorite(), mvp: null, mvpWins: 0, _cardWins: {} };
      this._board.push(row);
    }
    row.name = this.name() || row.name;
    if (payload.win) row.wins = (row.wins || 0) + 1; else row.losses = (row.losses || 0) + 1;
    row.playMs = (row.playMs || 0) + (payload.ms || 0);
    if (payload.win) {
      row._cardWins = row._cardWins || {};
      const seen = new Set();
      payload.cards.forEach(n => {
        if (!n || seen.has(n)) return; seen.add(n);
        row._cardWins[n] = (row._cardWins[n] || 0) + 1;
        if (row._cardWins[n] > (row.mvpWins || 0)) { row.mvpWins = row._cardWins[n]; row.mvp = n; }
      });
    }
    this._notify();
  },

  _ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  _lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

if (typeof window !== 'undefined') window.Leaderboard = Leaderboard;
