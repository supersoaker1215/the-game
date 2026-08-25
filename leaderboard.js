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
  _ID_KEY:     'clb_device_id',
  _NAME_KEY:   'clb_player_name',
  _FAV_KEY:    'clb_favorite_card',
  _JOINED_KEY: 'clb_joined',

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
    // Only touch the server if we're actually on the board. A rename before
    // joining is purely local; once joined, push the new name via a join upsert.
    if (this.hasJoined()) this._send({ t: 'join', id: this.deviceId(), name: clean });
    return true;
  },

  // ---- opt-in membership --------------------------------------------
  // A player appears on the shared board ONLY after explicitly adding
  // themselves. Merely having a name does nothing — that is the whole point of
  // "they have to add themselves." join() records the choice locally and tells
  // the server to list us; the server persists rec.joined so it sticks.
  hasJoined() { return this._ls(this._JOINED_KEY) === '1'; },
  join(n) {
    if (n != null) {
      const clean = String(n || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
      if (clean) this._lsSet(this._NAME_KEY, clean);
    }
    if (!this.hasName()) return false;   // need a name to be listed
    this._lsSet(this._JOINED_KEY, '1');
    this._send({ t: 'join', id: this.deviceId(), name: this.name() });
    return true;
  },
  leave() {
    this._lsSet(this._JOINED_KEY, '0');
    this._send({ t: 'leave', id: this.deviceId(), name: this.name() });
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
      // Re-assert membership so the server lists us with our current name.
      // Opt-in only: a player who never joined announces nothing and stays off
      // the board, even if they have a local name.
      if (this.hasJoined()) { this._sendRaw({ t: 'join', id: this.deviceId(), name: this.name() }); }
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
  // Called from Game.finalizeStats at game over. Only ONLINE PvP games carry a
  // matchId (stamped by the host, synced to every seat); a game without one —
  // vs-AI, or any fabricated call — is never sent, because the server would not
  // count it anyway (it needs a real opponent to corroborate the same matchId).
  // This is the anti stat-padding gate on the client side; the server enforces
  // the same rule authoritatively. Deliberately NO optimistic local mirror:
  // your record only moves once the opponent's report corroborates it on the
  // server, so a win can never be shown before it's real.
  reportResult(result) {
    if (!result || !result.matchId) return;
    this._send({
      t: 'report',
      id: this.deviceId(),
      name: this.name(),
      win: !!result.win,
      cards: Array.isArray(result.cards) ? result.cards.slice(0, 24) : [],
      ms: Math.max(0, result.ms | 0),
      matchId: String(result.matchId).slice(0, 64),
    });
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
    if (typeof UI !== 'undefined') {
      if (UI._renderLeaderboard)     { try { UI._renderLeaderboard(); } catch (e) {} }      // modal, if open
      if (UI._renderMenuLeaderboard) { try { UI._renderMenuLeaderboard(); } catch (e) {} }  // always-on menu rail
    }
  },

  // ---- internals -----------------------------------------------------
  _send(msg) {
    if (this._socket && this._socket.readyState === 1) { this._sendRaw(msg); return; }
    // Not open yet — a hello/favorite will be re-sent on the next open();
    // reports are best-effort and already mirrored locally.
    if (this._wantOpen) this.connect();
  },
  _sendRaw(msg) { try { this._socket.send(JSON.stringify(msg)); } catch (e) {} },

  _ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  _lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

if (typeof window !== 'undefined') window.Leaderboard = Leaderboard;
