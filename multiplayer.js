// ============================================================
// MULTIPLAYER CLIENT ADAPTER
// ============================================================
// Transport-agnostic client for the multiplayer flow. Same module
// drives all three deployment modes:
//
//   • LocalTabTransport   — BroadcastChannel between two tabs
//                           on the same machine. Used for dev /
//                           testing without any server. Pick this
//                           when running the static server locally.
//
//   • WebSocketTransport  — connects to a PartyKit (or any ws://)
//                           endpoint. Production.
//
//   • (future) WebRTCTransport — P2P friend-direct via peerjs or
//                           similar; needs signaling. Out of scope
//                           for v1.
//
// The adapter exposes ONE public API to the rest of the game:
//
//   Multiplayer.init(transport)   — bind a transport, hook events
//   Multiplayer.createRoom()      — host a new room, returns code
//   Multiplayer.joinRoom(code)    — join an existing room
//   Multiplayer.send(action)      — send a game action (playCard,
//                                   playTrick, doneTurn, etc.)
//   Multiplayer.leave()           — leave the room
//
// Events emitted (subscribe via Multiplayer.on(name, fn)):
//   'connected'        — transport opened
//   'roomCreated'      — { code, you: 'player' | 'ai' }
//   'roomJoined'       — { code, you }
//   'opponentJoined'   — { name }
//   'opponentLeft'     — {}
//   'state'            — { state: GameState }   (already rehydrated)
//   'error'            — { message }
//
// User spec: "I want this on a mobile phone and I want to share
// it with friends and we play multiplayer vs each other."
// ============================================================

const Multiplayer = {
  _transport: null,
  _listeners: {},
  _room: null,
  _you: null, // 'player' | 'ai' — server tells us which side we are

  // ---- Public API ----

  init(transport) {
    if (this._transport) this.leave();
    this._transport = transport;
    transport.onMessage((msg) => this._handleServerMsg(msg));
    transport.onClose(() => this._emit('opponentLeft', {}));
    transport.onError((e) => this._emit('error', { message: String(e) }));
  },

  createRoom(opts) {
    const code = this._genCode();
    this._send({ t: 'createRoom', code, deck: opts && opts.deck, name: opts && opts.name });
    return code;
  },

  joinRoom(code, opts) {
    this._send({ t: 'joinRoom', code: code.toUpperCase(), deck: opts && opts.deck, name: opts && opts.name });
  },

  // Send a game action. The server validates and broadcasts new
  // state. Caller is responsible for serializing complex action
  // payloads (target card refs → IDs etc.).
  send(action) { this._send(action); },

  leave() {
    if (this._transport) {
      try { this._transport.close(); } catch (e) {}
    }
    this._transport = null;
    this._room = null;
    this._you = null;
  },

  on(eventName, fn) {
    (this._listeners[eventName] = this._listeners[eventName] || []).push(fn);
  },

  off(eventName, fn) {
    const arr = this._listeners[eventName];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  },

  // ---- Internals ----

  _emit(name, payload) {
    (this._listeners[name] || []).forEach(fn => {
      try { fn(payload); } catch (e) { console.error('multiplayer listener error', e); }
    });
  },

  _send(msg) {
    if (!this._transport) return;
    this._transport.send(msg);
  },

  // 4-char alphabet code, easy to read aloud / type. Avoids 0/O, 1/I
  // confusion. Generated client-side so the host can show it before
  // the server confirms — the createRoom message includes the code
  // so server uses the same one.
  _genCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  },

  // Server message handler — broadcasts to UI subscribers. Game-action
  // messages (playCard / playTrick / doneTurn / etc.) are emitted as a
  // single 'action' event so the host's Game engine can route them
  // through one handler instead of dozens of listeners.
  _GAME_ACTION_TYPES: new Set([
    'playCard', 'playCardFree', 'playTrick', 'doneTurn', 'mulligan',
    'draftPick', 'promptResolve', 'forfeit'
  ]),
  _handleServerMsg(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (this._GAME_ACTION_TYPES.has(msg.t)) {
      // The HOST receives game actions from the guest via the channel;
      // forward to the engine handler. The guest itself never receives
      // its own actions back (transports filter out the echo).
      this._emit('action', msg);
      return;
    }
    switch (msg.t) {
      case 'roomCreated':
        this._room = msg.code;
        this._you = msg.you;
        this._emit('roomCreated', msg);
        break;
      case 'roomJoined':
        this._room = msg.code;
        this._you = msg.you;
        this._emit('roomJoined', msg);
        break;
      case 'opponentJoined':
        this._emit('opponentJoined', msg);
        break;
      case 'opponentLeft':
        this._emit('opponentLeft', msg);
        break;
      case 'state': {
        // Rehydrate function references on every received state.
        // This is what makes the JSON-roundtripped engine usable
        // again on the client — without rehydration, every onPlay /
        // play / canPlay callback is null after the trip. Block
        // scope so const doesn't leak across case clauses.
        const rehydrated = this._rehydrateState(msg.state);
        this._emit('state', { state: rehydrated });
        break;
      }
      case 'error':
        this._emit('error', msg);
        break;
      default:
        // Unknown messages are ignored (forward-compat — server may
        // add new types future versions handle).
        break;
    }
  },

  // Walk a parsed game state and re-attach all the function hooks
  // that JSON.stringify dropped on the way out. Card hooks come
  // from CARD_ABILITIES[name] + the def's own onPlay/canPlay/play.
  // Tricks come from TRICK_DEFS by name.
  _rehydrateState(state) {
    if (!state || typeof state !== 'object') return state;
    const cardDefs = (typeof CARD_DEFS !== 'undefined' ? CARD_DEFS : []);
    const trickDefs = (typeof TRICK_DEFS !== 'undefined' ? TRICK_DEFS : []);
    const cardAbilities = (typeof CARD_ABILITIES !== 'undefined' ? CARD_ABILITIES : {});

    // Build a card-id → card-instance map so _summonedById
    // back-references can be repaired into real object references
    // after rehydration.
    const idMap = new Map();
    const collect = (c) => { if (c && c.id != null) idMap.set(c.id, c); };
    const sides = ['player', 'ai'];
    for (let i = 0; i < (state.lanes || []).length; i++) {
      const lane = state.lanes[i];
      if (!lane) continue;
      collect(lane.player); collect(lane.ai);
    }
    sides.forEach(side => {
      const p = state[side];
      if (!p) return;
      (p.hand || []).forEach(collect);
      (p.deadPile || []).forEach(collect);
      (p.drawPile || []).forEach(collect);
    });

    const rehydrateCard = (c) => {
      if (!c || !c.name) return;
      const def = cardDefs.find(d => d.name === c.name);
      if (def) {
        // Copy hooks from the merged def + abilities
        c.onPlay        = def.onPlay        || null;
        c.onDeath       = def.onDeath       || null;
        c.onDamaged     = def.onDamaged     || null;
        c.onKill        = def.onKill        || null;
        c.onBeforeTricks= def.onBeforeTricks|| null;
        c.onBeforeAttack= def.onBeforeAttack|| null;
        c.onEndOfTurn   = def.onEndOfTurn   || null;
        c.onAnyCardPlayed = def.onAnyCardPlayed || null;
        c.onAllyKilled  = def.onAllyKilled  || null;
        c.onEvade       = def.onEvade       || null;
        c.onDamagePlayer= def.onDamagePlayer|| null;
        c.onTurnStart   = def.onTurnStart   || null;
        c.onLaneResolved= def.onLaneResolved|| null;
        c.onMoved       = def.onMoved       || null;
        c.onDiscard     = def.onDiscard     || null;
      }
      // Repair _summonedBy from id-based reference.
      if (c._summonedById != null) {
        c._summonedBy = idMap.get(c._summonedById) || null;
      }
      if (c._drawnById != null) {
        c._drawnBy = idMap.get(c._drawnById) || null;
      }
    };

    const rehydrateTrick = (t) => {
      if (!t || !t.name) return;
      const def = trickDefs.find(d => d.name === t.name);
      if (def) {
        t.canPlay = def.canPlay || null;
        t.play    = def.play    || null;
      }
    };

    // Walk and rehydrate
    for (let i = 0; i < (state.lanes || []).length; i++) {
      const lane = state.lanes[i];
      if (!lane) continue;
      rehydrateCard(lane.player); rehydrateCard(lane.ai);
    }
    sides.forEach(side => {
      const p = state[side];
      if (!p) return;
      (p.hand || []).forEach(rehydrateCard);
      (p.deadPile || []).forEach(rehydrateCard);
      (p.drawPile || []).forEach(rehydrateCard);
      (p.trickHand || []).forEach(rehydrateTrick);
      (p.playedTrickPile || []).forEach(rehydrateTrick);
      (p.trickDrawPile || []).forEach(rehydrateTrick);
    });
    (state.drawPile || []).forEach(rehydrateCard);
    (state.trickDrawPile || []).forEach(rehydrateTrick);
    return state;
  },

  // Inverse of rehydrate — strip non-serializable fields BEFORE
  // sending state across the wire. Game.state is mutated in place
  // by the engine; we don't want to mutate it here, so we deep-
  // clone via JSON round-trip (which conveniently ALSO drops the
  // function refs for free) and then patch _summonedBy / _drawnBy
  // to id-based form.
  serializeState(state) {
    const clone = JSON.parse(JSON.stringify(state));
    const fixRefs = (c) => {
      if (!c) return;
      // Functions already gone via JSON.stringify; just convert
      // the object refs to ids.
      if (c._summonedBy && c._summonedBy.id != null) {
        c._summonedById = c._summonedBy.id;
      }
      delete c._summonedBy;
      if (c._drawnBy && c._drawnBy.id != null) {
        c._drawnById = c._drawnBy.id;
      }
      delete c._drawnBy;
    };
    // Walk same shape as rehydrate
    for (let i = 0; i < (clone.lanes || []).length; i++) {
      const lane = clone.lanes[i];
      if (!lane) continue;
      fixRefs(lane.player); fixRefs(lane.ai);
    }
    ['player', 'ai'].forEach(side => {
      const p = clone[side];
      if (!p) return;
      (p.hand || []).forEach(fixRefs);
      (p.deadPile || []).forEach(fixRefs);
      (p.drawPile || []).forEach(fixRefs);
    });
    (clone.drawPile || []).forEach(fixRefs);
    return clone;
  }
};

// ============================================================
// LOCAL TAB TRANSPORT — cross-tab state sync via BroadcastChannel
// ============================================================
// Two tabs of the game on the same machine can talk to each other
// without any server. Useful for dev / showing the multiplayer
// flow before deploying PartyKit. Each tab acts as both client AND
// "server" — the host tab generates the room code and authoritatively
// holds the state; joiner tab just relays actions.
//
// This is NOT robust networking — it doesn't survive a closed tab,
// it only works on the same browser, and there's no validation. But
// it's enough to verify the lobby flow + state sync wiring.

class LocalTabTransport {
  constructor() {
    this._channel = null;
    this._handlers = { message: [], close: [], error: [] };
    this._isHost = false;
    this._roomCode = null;
    this._opponentReady = false;
  }

  // Init connects the BroadcastChannel and listens. Auto-fires
  // open immediately since BroadcastChannel doesn't have a handshake.
  open() {
    this._channel = new BroadcastChannel('clb-multiplayer');
    this._channel.onmessage = (ev) => this._handleChannelMsg(ev.data);
  }

  send(msg) {
    if (!this._channel) this.open();
    if (msg.t === 'createRoom') {
      this._isHost = true;
      this._roomCode = msg.code;
      // Host doesn't broadcast createRoom — it just acts as server.
      // Reply locally with roomCreated.
      this._dispatch({ t: 'roomCreated', code: msg.code, you: 'player' });
      return;
    }
    if (msg.t === 'joinRoom') {
      this._roomCode = msg.code;
      // Tell the host we're joining.
      this._channel.postMessage({ kind: 'joinReq', code: msg.code, name: msg.name });
      return;
    }
    // Game actions — relay to opposite tab via channel. The host's
    // copy of Game runs the action and broadcasts the new state.
    this._channel.postMessage({ kind: 'action', code: this._roomCode, msg });
  }

  close() {
    if (this._channel) { this._channel.close(); this._channel = null; }
    this._handlers.close.forEach(fn => { try { fn(); } catch (e) {} });
  }

  onMessage(fn) { this._handlers.message.push(fn); }
  onClose(fn)   { this._handlers.close.push(fn); }
  onError(fn)   { this._handlers.error.push(fn); }

  _handleChannelMsg(data) {
    if (!data) return;
    if (data.kind === 'joinReq') {
      // Host receives a join request. Tell the joiner they joined,
      // tell ourselves opponent joined, then send current state.
      if (this._isHost && data.code === this._roomCode) {
        this._channel.postMessage({ kind: 'joinAck', code: this._roomCode, you: 'ai' });
        this._dispatch({ t: 'opponentJoined', name: data.name || 'Opponent' });
      }
      return;
    }
    if (data.kind === 'joinAck') {
      // Joiner receives ack with their assigned side.
      if (data.code === this._roomCode && !this._isHost) {
        this._dispatch({ t: 'roomJoined', code: this._roomCode, you: data.you });
      }
      return;
    }
    if (data.kind === 'action') {
      // Either side can produce an action. The HOST is the
      // authoritative state holder — when the host receives an
      // action (whether from itself or the joiner), it applies
      // it via the game engine and broadcasts the new state.
      if (this._isHost && data.code === this._roomCode) {
        this._dispatch(data.msg);  // upper layer (Multiplayer.handleAction-on-host)
                                    // applies the action and follows up with broadcastState
      } else if (data.code === this._roomCode) {
        // Joiner just relayed its own action up (it's already
        // sent it via send()); ignore the echo.
      }
      return;
    }
    if (data.kind === 'state') {
      // Joiner receives broadcasted state from the host.
      if (data.code === this._roomCode) {
        this._dispatch({ t: 'state', state: data.state });
      }
      return;
    }
  }

  // Host-only: broadcast current game state to the joiner. Called
  // by the multiplayer layer after the host applies an action.
  broadcastState(stateClone) {
    if (!this._channel) return;
    if (!this._isHost) return;
    this._channel.postMessage({ kind: 'state', code: this._roomCode, state: stateClone });
  }

  _dispatch(msg) {
    this._handlers.message.forEach(fn => { try { fn(msg); } catch (e) { console.error(e); } });
  }
}

// ============================================================
// WEBSOCKET TRANSPORT — production (PartyKit)
// ============================================================
// Connects to a PartyKit-compatible per-room WebSocket. Unlike the
// LocalTabTransport, room creation isn't a `createRoom` message —
// the URL itself names the party (`/parties/main/<ROOM>`), and the
// `?role=` query string tells the server whether we're hosting or
// joining. So `createRoom` and `joinRoom` are URL-construction
// steps that happen BEFORE we open the socket.
//
// Caller responsibilities:
//   • Pass the PartyKit base URL (e.g. wss://card-lane-battle.example.partykit.dev)
//     as `_baseUrl`. Per-room URL is built when send()ing the first
//     handshake message.
//   • The first send() triggers actual socket open with the room URL.
//
// Once open, subsequent send()s just JSON-stringify and forward;
// inbound messages are parsed and dispatched up to Multiplayer.

class WebSocketTransport {
  constructor(baseUrl) {
    this._baseUrl = baseUrl.replace(/\/+$/, '');  // strip trailing slash
    this._socket = null;
    this._handlers = { message: [], close: [], error: [] };
    this._sendQueue = [];
    this._pendingHandshake = null; // captured from first createRoom/joinRoom call
  }

  // Build the per-room URL from the handshake. PartyKit routes by
  // path: `/parties/<party-name>/<room-id>`. We use party-name "main"
  // and the 4-letter code as the room id.
  _buildUrl(handshake) {
    const params = new URLSearchParams();
    params.set('role', handshake.t === 'createRoom' ? 'host' : 'guest');
    if (handshake.name) params.set('name', handshake.name);
    return `${this._baseUrl}/parties/main/${handshake.code}?${params.toString()}`;
  }

  open() { /* deferred until first send so we know the room id */ }

  _openWithHandshake(handshake) {
    if (this._socket) return;
    const url = this._buildUrl(handshake);
    this._socket = new WebSocket(url);
    this._socket.onopen = () => {
      // No queued messages need to be sent for the handshake — the
      // server replies automatically based on the URL params. Flush
      // any game actions queued during the connection window.
      this._sendQueue.forEach(m => this._socket.send(JSON.stringify(m)));
      this._sendQueue = [];
    };
    this._socket.onmessage = (ev) => {
      let parsed = null;
      try { parsed = JSON.parse(ev.data); } catch (e) { return; }
      this._handlers.message.forEach(fn => { try { fn(parsed); } catch (e) { console.error(e); } });
    };
    this._socket.onclose = () => {
      this._handlers.close.forEach(fn => { try { fn(); } catch (e) {} });
    };
    this._socket.onerror = (e) => {
      this._handlers.error.forEach(fn => { try { fn(e); } catch (e) {} });
    };
  }

  send(msg) {
    // First send is always the handshake (createRoom or joinRoom)
    // — use it to build the URL and open the socket.
    if (!this._socket && (msg.t === 'createRoom' || msg.t === 'joinRoom')) {
      this._openWithHandshake(msg);
      return;  // server replies with roomCreated/roomJoined; nothing to send
    }
    if (!this._socket) {
      // Edge case: send before handshake. Drop with a console warning.
      console.warn('WebSocketTransport.send before handshake', msg);
      return;
    }
    if (this._socket.readyState === WebSocket.OPEN) {
      this._socket.send(JSON.stringify(msg));
    } else {
      this._sendQueue.push(msg);
    }
  }

  // Host-only state broadcast — same as LocalTabTransport's API. For
  // WebSocket, "broadcast" just means send the state to the server,
  // which fans it out to the guest. We tag t='state' so the server
  // knows to relay it.
  broadcastState(stateClone) {
    if (!this._socket) return;
    const wrapped = { t: 'state', state: stateClone };
    if (this._socket.readyState === WebSocket.OPEN) {
      this._socket.send(JSON.stringify(wrapped));
    } else {
      this._sendQueue.push(wrapped);
    }
  }

  close() {
    if (this._socket) { try { this._socket.close(); } catch (e) {} }
    this._socket = null;
  }

  onMessage(fn) { this._handlers.message.push(fn); }
  onClose(fn)   { this._handlers.close.push(fn); }
  onError(fn)   { this._handlers.error.push(fn); }
}

// ============================================================
// WEBRTC TRANSPORT — peer-to-peer over the public internet
// ============================================================
// Uses PeerJS (https://peerjs.com) for WebRTC signaling. PeerJS
// runs a free public signaling cloud at 0.peerjs.com that brokers
// the initial offer/answer exchange; once peers are connected, all
// game data flows directly P2P via WebRTC DataChannels — no server
// in the middle.
//
// Why this transport: the user wanted to play against a friend on
// a different computer "on the web" without deploying any backend.
// PeerJS public cloud + WebRTC achieves that with zero server cost
// and no account setup. ~95% of home networks (consumer routers
// behind NAT) connect cleanly; the few that need TURN relay
// servers (some corporate / mobile carrier networks with symmetric
// NAT) will fail and fall back to a connection error — that's a
// known WebRTC limitation we accept.
//
// Room code mapping: the 4-letter room code becomes a peer ID with
// a 'clb-game-' prefix so we don't collide with other apps using
// PeerJS's shared cloud. Host claims `clb-game-ABCD`; joiner
// connects to that ID. Joiner's peer ID is auto-generated.
//
// Messages match the LocalTabTransport / WebSocketTransport contract:
//   • Host receives game-action messages from the guest (engine routes)
//   • Host calls broadcastState() to push authoritative state
//   • Both sides see opponentJoined / opponentLeft / state events

class WebRTCTransport {
  constructor() {
    this._peer = null;        // PeerJS instance (signaling client)
    this._conn = null;        // DataConnection to the other peer
    this._isHost = false;
    this._roomCode = null;
    this._handlers = { message: [], close: [], error: [] };
    this._sendQueue = [];     // queued msgs sent before conn opens
  }

  // Convert the 4-letter room code into a globally-unique peer ID.
  // The prefix scopes our IDs so we never collide with other apps
  // using PeerJS's shared cloud.
  _peerIdFor(code) { return 'clb-game-' + String(code || '').toUpperCase(); }

  // Init is deferred — we don't open the peer until the first send,
  // because the host vs. guest flow is determined by the first message.
  open() { /* no-op until first send */ }

  send(msg) {
    if (typeof Peer === 'undefined') {
      this._dispatchError('PeerJS library not loaded — is the network blocking unpkg.com?');
      return;
    }
    if (msg && msg.t === 'createRoom') {
      this._openAsHost(msg);
      return;
    }
    if (msg && msg.t === 'joinRoom') {
      this._openAsJoiner(msg);
      return;
    }
    // Game action — relay over the data connection. If the conn
    // isn't open yet (joiner sent something before handshake
    // completed), queue and flush on open.
    if (this._conn && this._conn.open) {
      this._conn.send(msg);
    } else {
      this._sendQueue.push(msg);
    }
  }

  _openAsHost(msg) {
    this._isHost = true;
    this._roomCode = msg.code;
    const peerId = this._peerIdFor(msg.code);
    try {
      // PeerJS auto-uses Google STUN servers + the public 0.peerjs.com
      // signaling cloud by default. No config needed for typical home
      // networks. `debug: 1` keeps console output minimal (errors only).
      this._peer = new Peer(peerId, { debug: 1 });
    } catch (e) {
      this._dispatchError('Could not initialize peer: ' + (e && e.message || e));
      return;
    }
    this._peer.on('open', (id) => {
      // Peer registered with the signaling cloud — ready to accept
      // incoming connections. Notify upper layer that the room exists.
      this._dispatch({ t: 'roomCreated', code: msg.code, you: 'player' });
    });
    this._peer.on('connection', (conn) => {
      // Joiner connected. Bind handlers, then wait for the data
      // channel to open before announcing.
      this._setupConn(conn);
    });
    this._peer.on('error', (err) => this._handlePeerError(err));
    this._peer.on('disconnected', () => {
      // Lost connection to the signaling cloud — but existing peer
      // connections (if any) keep working. Try to reconnect quietly.
      try { this._peer.reconnect(); } catch (e) {}
    });
  }

  _openAsJoiner(msg) {
    this._roomCode = msg.code;
    try {
      this._peer = new Peer({ debug: 1 });  // auto-generated ID for joiner
    } catch (e) {
      this._dispatchError('Could not initialize peer: ' + (e && e.message || e));
      return;
    }
    this._peer.on('open', () => {
      const targetId = this._peerIdFor(msg.code);
      const conn = this._peer.connect(targetId, {
        reliable: true,           // ordered + reliable like TCP — matches the engine's expectations
        metadata: { name: msg.name || 'Opponent' },
      });
      this._setupConn(conn);
    });
    this._peer.on('error', (err) => this._handlePeerError(err));
  }

  // Bind handlers on a freshly-created DataConnection. Open dispatches
  // the appropriate handshake event for the side we're on.
  _setupConn(conn) {
    this._conn = conn;
    conn.on('open', () => {
      // Flush anything queued before the channel opened
      this._sendQueue.forEach(m => { try { conn.send(m); } catch (e) {} });
      this._sendQueue = [];
      if (this._isHost) {
        const name = (conn.metadata && conn.metadata.name) || 'Opponent';
        this._dispatch({ t: 'opponentJoined', name });
      } else {
        this._dispatch({ t: 'roomJoined', code: this._roomCode, you: 'ai' });
      }
    });
    conn.on('data', (data) => {
      // Game actions, state updates, pseudo-server messages — all
      // pass through the same dispatch path. The Multiplayer adapter's
      // _handleServerMsg routes by msg.t.
      this._dispatch(data);
    });
    conn.on('close', () => this._dispatch({ t: 'opponentLeft' }));
    conn.on('error', (err) => this._dispatchError('Connection error: ' + ((err && err.message) || err)));
  }

  // Friendly error mapping for common PeerJS error types so the
  // lobby can show actionable messages instead of raw codes.
  _handlePeerError(err) {
    const type = err && err.type;
    let friendly = (err && err.message) || String(err);
    if (type === 'unavailable-id') {
      friendly = 'That room code is already in use. Try generating a new code.';
    } else if (type === 'peer-unavailable') {
      friendly = "Couldn't find that room — double-check the code with your friend.";
    } else if (type === 'network') {
      friendly = 'Network error reaching the signaling server. Check your internet connection.';
    } else if (type === 'browser-incompatible') {
      friendly = 'This browser does not support WebRTC peer-to-peer.';
    } else if (type === 'disconnected') {
      friendly = 'Disconnected from signaling server.';
    } else if (type === 'server-error') {
      friendly = 'PeerJS signaling server is having trouble. Try again in a moment.';
    } else if (type === 'webrtc') {
      friendly = 'WebRTC failed — your network may need a TURN relay (some corporate / mobile networks).';
    }
    this._dispatchError(friendly);
  }

  // Host-only state broadcast — same shape as LocalTabTransport's API.
  // For WebRTC there's only ever one peer (the joiner), so "broadcast"
  // is just "send the state to that peer."
  broadcastState(stateClone) {
    const wrapped = { t: 'state', state: stateClone };
    if (this._conn && this._conn.open) {
      try { this._conn.send(wrapped); } catch (e) {}
    } else {
      this._sendQueue.push(wrapped);
    }
  }

  close() {
    if (this._conn) { try { this._conn.close(); } catch (e) {} }
    if (this._peer) { try { this._peer.destroy(); } catch (e) {} }
    this._conn = null;
    this._peer = null;
    this._handlers.close.forEach(fn => { try { fn(); } catch (e) {} });
  }

  onMessage(fn) { this._handlers.message.push(fn); }
  onClose(fn)   { this._handlers.close.push(fn); }
  onError(fn)   { this._handlers.error.push(fn); }

  _dispatch(msg) {
    this._handlers.message.forEach(fn => { try { fn(msg); } catch (e) { console.error(e); } });
  }
  _dispatchError(message) {
    this._handlers.error.forEach(fn => { try { fn(message); } catch (e) {} });
  }
}

// Expose constructors so ui.js can pick a transport at runtime
// based on settings (WebRTC for default internet play, Local for
// same-browser dev/testing, WebSocket for self-hosted PartyKit).
Multiplayer.LocalTabTransport = LocalTabTransport;
Multiplayer.WebSocketTransport = WebSocketTransport;
Multiplayer.WebRTCTransport = WebRTCTransport;

// Browser global so other modules (ui.js, eventually game.js) can
// access without a build step.
if (typeof window !== 'undefined') window.Multiplayer = Multiplayer;
