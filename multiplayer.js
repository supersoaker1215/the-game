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
    'playCard', 'playCardFree', 'playJump', 'playTrick', 'doneTurn', 'mulligan',
    'draftPick', 'draftMulligan', 'promptResolve', 'bwlChoice', 'forfeit',
    'reqLaneChoice', 'reqState', 'undo', 'redraw'
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
      case 'emote':
        // Cosmetic emote from the other player — symmetric: either side
        // can send, the receiver shows it on the opponent's avatar chip.
        this._emit('emote', msg);
        break;
      case 'notice':
        // Host → guest explanation (an ACK-less protocol's missing NACK).
        // When the host REJECTS a guest's action it used to only console.warn
        // on the HOST's own machine and re-broadcast an unchanged state, so on
        // the guest the card simply refused to move with no reason given —
        // the "it never leaves my hand" report. The host now says why.
        // Deliberately NOT in _GAME_ACTION_TYPES: this is host→guest feedback,
        // not a game action, and must never be applied to the engine.
        this._emit('notice', msg);
        break;
      case 'lobby':
        // Deck-building lobby sync. Symmetric like 'emote': both sides
        // publish { name, ready, deckName, deck, counts } whenever their
        // ready state or deck changes, and render the opponent's copy.
        // The match starts only once BOTH sides report ready — see
        // UI._mpOnLobby / _mpMaybeStartFromLobby.
        this._emit('lobby', msg);
        break;
      case 'versionMismatch':
        // Host/guest builds differ (stale PWA cache on one side) —
        // surface so the UI can tell both players to refresh.
        this._emit('versionMismatch', msg);
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

    // 2v2 lives in its OWN sub-tree, which this walk used to skip entirely.
    // JSON.stringify drops every function on the way out, so each guest's
    // cards and tricks came back inert: no onPlay, no onDeath, no trick
    // play(). The host is authoritative for resolution so matches still
    // "worked", but anything the guest evaluates locally — damage previews
    // (they run a silent sim on the guest's own copy), canPlay gating, hook
    // presence checks — was reading hookless cards. Walk it like any other
    // zone. Found by sim/fuzzonline.js round-trip fidelity checks.
    const tt = state.twoVTwo;
    if (tt) {
      ['p1', 'p2', 'p3', 'p4'].forEach(k => {
        const ap = tt.players && tt.players[k];
        if (!ap) return;
        (ap.hand || []).forEach(rehydrateCard);
        (ap.trickHand || []).forEach(rehydrateTrick);
      });
      ['A', 'B'].forEach(t => {
        const team = tt.teams && tt.teams[t];
        if (team) (team.deadPile || []).forEach(rehydrateCard);
      });
      (tt.drawPile || []).forEach(rehydrateCard);
      (tt.trickDrawPile || []).forEach(rehydrateTrick);
      // Draft offers are live cards the guest renders and clicks.
      const d = tt.draft;
      if (d) {
        const isCards = d.phase === 'cards';
        const fix = isCards ? rehydrateCard : rehydrateTrick;
        (d.choices || []).forEach(fix);
        Object.keys(d.choicesByPlayer || {}).forEach(k => (d.choicesByPlayer[k] || []).forEach(fix));
        (d.cardPool || []).forEach(rehydrateCard);
        (d.trickPool || []).forEach(rehydrateTrick);
        (d.cardHolding || []).forEach(rehydrateCard);
        (d.trickHolding || []).forEach(rehydrateTrick);
      }
    }
    return state;
  },

  // Inverse of rehydrate — strip non-serializable fields BEFORE
  // sending state across the wire. Game.state is mutated in place
  // by the engine; we don't want to mutate it here, so we deep-
  // clone via JSON round-trip (which conveniently ALSO drops the
  // function refs for free) and then patch _summonedBy / _drawnBy
  // to id-based form.
  serializeState(state) {
    // Cycle-safe deep clone. The old JSON.parse(JSON.stringify(state)) threw
    // "Converting circular structure to JSON" the instant two cards referenced
    // each other — e.g. a mutual mindControlTarget, or _copiedFrom, or any
    // card back-ref that forms a loop. fixRefs (below) only rewrites
    // _summonedBy / _drawnBy, and it runs AFTER the stringify, so it could
    // never prevent the throw. On the host that throw aborted the broadcast:
    // the host kept playing locally while every guest froze on a stale state,
    // waiting for an update that never came (the "host advances, guest stuck"
    // 2v2 freeze). This replacer walks an ancestor stack and drops any value
    // that is its own ancestor — breaking true cycles only, while leaving
    // shared (non-cyclic) references intact. Functions are dropped too;
    // rehydrate re-attaches them from the card defs.
    const ancestors = [];
    const json = JSON.stringify(state, function (key, value) {
      if (typeof value === 'function') return undefined;
      if (value && typeof value === 'object') {
        while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
        if (ancestors.indexOf(value) !== -1) return undefined; // cycle — drop this back-ref
        ancestors.push(value);
      }
      return value;
    });
    const clone = JSON.parse(json);
    // selectedCard / selectedTrick are per-CLIENT UI state, not shared game
    // state. Broadcasting the host's selection leaks it into the guest's state,
    // where it's a card the guest doesn't hold — the guest's restore-selection
    // guard then sees a non-null selection and skips restoring the guest's OWN
    // pick, so the guest's card "places itself" in a stray lane. Strip them.
    delete clone.selectedCard;
    delete clone.selectedTrick;
    // WIRE TRIM (host-authoritative → guest only RENDERS this state):
    //  • Draw piles are HIDDEN — the guest shows them only as a DECK COUNT
    //    (state.drawPile.length). So replace each hidden card with a tiny
    //    {id,name} stub: the count survives, but ~85 full card objects PER SIDE
    //    (stats + abilities[] + baseAbilities[] + desc string + flags) no longer
    //    ride EVERY action's broadcast. The guest never draws from its own pile
    //    (the host does, and the drawn card arrives via the hand), and
    //    rehydrateCard skips nameless/def-less cards, so this can't desync play.
    //  • The combat LOG is capped to its recent tail — the guest only shows
    //    recent lines, so shipping all 300 every action is wasted bytes.
    //  • The stub carries ONLY {id} — dropping `name` both saves bytes and
    //    closes a fairness hole: the full draw ORDER of both decks was riding
    //    every broadcast, so anything reading the guest's state could see the
    //    next N cards. rehydrateCard bails on !c.name, and the guest renders
    //    hidden piles purely by .length, so nothing downstream needs the name.
    const stubPile = (pile) => Array.isArray(pile)
      ? pile.map(c => (c && c.id != null) ? { id: c.id } : {})
      : pile;
    if (clone.drawPile) clone.drawPile = stubPile(clone.drawPile);
    //  • trickDrawPile is hidden exactly like drawPile — same stub, both the
    //    shared pile and the per-side piles (deckbuilder mode).
    if (clone.trickDrawPile) clone.trickDrawPile = stubPile(clone.trickDrawPile);
    ['player', 'ai'].forEach(side => {
      if (!clone[side]) return;
      if (clone[side].drawPile) clone[side].drawPile = stubPile(clone[side].drawPile);
      if (clone[side].trickDrawPile) clone[side].trickDrawPile = stubPile(clone[side].trickDrawPile);
    });
    //  • summonDeck is the SHARED ~95-card summon lottery pool (Mother Box,
    //    Bat Signal, Knull...). Measured at 41% of a mid-match payload — the
    //    single largest object on the wire — and the guest never draws from it:
    //    the host resolves every summon and broadcasts the RESULT. It is also
    //    self-healing (drawFromSummonDeck re-inits via _initSummonDeck when the
    //    pool is missing or empty), so dropping it cannot desync or strand a
    //    draw. Same fairness note as above: it was leaking the summon order.
    delete clone.summonDeck;
    if (Array.isArray(clone.log) && clone.log.length > 60) clone.log = clone.log.slice(-60);
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
      this._channel.postMessage({ kind: 'joinReq', code: msg.code, name: msg.name, deck: msg.deck || null });
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
        this._dispatch({ t: 'opponentJoined', name: data.name || 'Opponent', deck: data.deck || null });
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
// SHARED ICE SERVER CONFIG (STUN + TURN)
// ============================================================
// Used by both WebRTCTransport (1v1) and WebRTC4Transport (2v2).
// The TURN entries relay traffic through metered.ca's public Open
// Relay servers when direct P2P fails — covers hotel WiFi, mobile
// hotspots, and corporate networks with symmetric NAT that block
// raw UDP. TURNS (TLS on 443) is the last-resort fallback since
// port 443 is open on every network that allows HTTPS.
// ICE servers: two STUN + two independent TURN providers for
// redundancy. openrelay.metered.ca and freestun.net are both
// free, no-signup relays. Having two distinct providers means
// if one is down or blocked the other takes over.
// TURNS (TLS on 443) is the last resort — it looks like HTTPS to
// hotel/corporate firewalls that block all other UDP/TCP.
const _WEBRTC_ICE_SERVERS = [
  // STUN — just address discovery, no relay
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // TURN provider 1: openrelay.metered.ca (free, community-run)
  { urls: 'turn:openrelay.metered.ca:80',               username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443',              username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443',             username: 'openrelayproject', credential: 'openrelayproject' },
  // TURN provider 2: freestun.net (free, independent provider)
  { urls: 'stun:freestun.net:3479' },
  { urls: 'turn:freestun.net:3478',  username: 'freestun', credential: 'freestun' },
  { urls: 'turn:freestun.net:3479',  username: 'freestun', credential: 'freestun' },
  { urls: 'turns:freestun.net:5350', username: 'freestun', credential: 'freestun' },
];

// Build the ICE config from the built-in STUN/TURN list. WebRTC's own
// ICE negotiation tries a direct path first and automatically falls back
// to the TURN relays below when direct fails (hotel/corporate Wi-Fi) —
// so relay coverage is built in without any per-user override.
//
// The old force-relay + custom-TURN localStorage overrides were removed:
// a stale/dead value in either silently broke EVERY later connection
// (force-relay with an unreachable TURN = no direct fallback = never
// connects). User report: "I can't connect in multiplayer — get rid of
// the hotel Wi-Fi thing I added."
function _buildIceConfig() {
  return { iceServers: _WEBRTC_ICE_SERVERS };
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
// and no account setup. TURN relay servers handle hotel WiFi,
// mobile hotspots, and corporate networks with symmetric NAT.
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

// Build stamp for the version handshake — derived from the ?v= params the
// page actually loaded game.js/ui.js/multiplayer.js with, so it updates on
// every deploy with zero maintenance. Two clients on the same deploy always
// agree; a stale-cached client disagrees and both get warned.
function _clbBuildStamp() {
  try {
    const parts = [];
    document.querySelectorAll('script[src]').forEach(s => {
      const m = s.getAttribute('src').match(/(game|ui|multiplayer)\.js\?v=(\d+)/);
      if (m) parts.push(m[1][0] + m[2]);
    });
    return parts.sort().join('-') || null;
  } catch (e) { return null; }
}

class WebRTCTransport {
  constructor() {
    this._peer = null;        // PeerJS instance (signaling client)
    this._conn = null;        // DataConnection to the other peer
    this._isHost = false;
    this._roomCode = null;
    this._handlers = { message: [], close: [], error: [] };
    this._sendQueue = [];     // queued msgs sent before conn opens
    this._versionTimer = null; // joiner-side wait for the host's versionInfo reply
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
    // Game action — relay over the data connection (chunked if large).
    // If the conn isn't open yet (joiner sent something before handshake
    // completed), queue and flush on open.
    if (this._conn && this._conn.open) {
      this._sendChunked(msg);
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
      this._peer = new Peer(peerId, { debug: 1, config: _buildIceConfig() });
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
      this._peer = new Peer({ debug: 1, config: _buildIceConfig() });  // auto-generated ID for joiner
    } catch (e) {
      this._dispatchError('Could not initialize peer: ' + (e && e.message || e));
      return;
    }
    this._peer.on('open', () => {
      const targetId = this._peerIdFor(msg.code);
      const conn = this._peer.connect(targetId, {
        serialization: 'json',    // JSON is more compatible than binary (BinaryPack) on iOS Safari
        // v: build stamp for the version handshake — the host compares it
        // to its own and warns BOTH players on mismatch (see _setupConn).
        metadata: { name: msg.name || 'Opponent', v: _clbBuildStamp(), deck: msg.deck || null },
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
      // Flush anything queued before the channel opened (chunked if large)
      const queued = this._sendQueue; this._sendQueue = [];
      queued.forEach(m => this._sendChunked(m));
      if (this._isHost) {
        const name = (conn.metadata && conn.metadata.name) || 'Opponent';
        // Version handshake — the game is a PWA, so one side can easily be
        // running a weeks-old cached build (every "fixed" bug comes back
        // when the stale side hosts). Compare the joiner's build stamp to
        // ours; on mismatch, surface a warning on BOTH clients so the two
        // players know to refresh. Non-fatal: the match still starts.
        const mine = _clbBuildStamp();
        const theirs = (conn.metadata && conn.metadata.v) || null;
        // Always reply with OUR stamp. The metadata handshake only lets
        // the host compare — without this reply, a fresh guest joining a
        // STALE host (the dangerous direction: the host runs the
        // authoritative engine, so its old bugs decide the match) gets no
        // version signal at all. The joiner arms a timer below and treats
        // "no versionInfo" as "host predates the handshake".
        try { conn.send({ t: 'versionInfo', v: mine }); } catch (e) {}
        if (mine && theirs && mine !== theirs) {
          this._dispatch({ t: 'versionMismatch', mine, theirs });
          try { conn.send({ t: 'versionMismatch', mine: theirs, theirs: mine }); } catch (e) {}
        } else if (mine && !theirs) {
          // Joiner sent no stamp — they're on a build older than the
          // handshake itself. Same warning, same fix (refresh).
          this._dispatch({ t: 'versionMismatch', mine, theirs: 'old build (no stamp)' });
        }
        // Carry the joiner's chosen deck up to the UI so the host can start a
        // deckbuilder match with BOTH players' decks (guest sits on the 'ai'
        // seat, so theirs becomes mode.aiDeck).
        this._dispatch({ t: 'opponentJoined', name, deck: (conn.metadata && conn.metadata.deck) || null });
      } else {
        // Expect the host's versionInfo reply shortly after connecting. A
        // host on a pre-handshake build never sends one — which is exactly
        // the stale-cached-host case the handshake exists to catch (host-
        // side compare can't run when the host is the stale side).
        const mine = _clbBuildStamp();
        if (mine) {
          this._versionTimer = setTimeout(() => {
            this._versionTimer = null;
            this._dispatch({ t: 'versionMismatch', mine, theirs: 'old build (no reply)' });
          }, 6000);
        }
        this._dispatch({ t: 'roomJoined', code: this._roomCode, you: 'ai' });
      }
    });
    conn.on('data', (data) => {
      // Host's build-stamp reply (joiner side) — compare at the transport
      // level; see the versionInfo send in the host branch above.
      if (data && data.t === 'versionInfo') {
        if (this._versionTimer) { clearTimeout(this._versionTimer); this._versionTimer = null; }
        const mine = _clbBuildStamp();
        if (mine && data.v && mine !== data.v) {
          this._dispatch({ t: 'versionMismatch', mine, theirs: data.v });
        }
        return;
      }
      // Reassemble chunked large messages (state broadcasts) before
      // dispatching. Small messages pass straight through.
      if (data && data.t === '__chunk') {
        const full = this._recvChunk(data);
        if (full) this._dispatch(full);
        return;
      }
      // Game actions, state updates, pseudo-server messages — all
      // pass through the same dispatch path. The Multiplayer adapter's
      // _handleServerMsg routes by msg.t.
      this._dispatch(data);
    });
    conn.on('close', () => {
      if (this._versionTimer) { clearTimeout(this._versionTimer); this._versionTimer = null; }
      this._dispatch({ t: 'opponentLeft' });
    });
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
      this._sendChunked(wrapped);
    } else {
      this._sendQueue.push(wrapped);
    }
  }

  // Split any message over the safe single-message size into ordered
  // chunks and reassemble on the far side. WebRTC/SCTP caps a single
  // send at the SMALLER of the two peers' limits — Safari negotiates a
  // much lower cap than Chrome, so a full ~50KB draft-state broadcast
  // silently vanished on a Chrome↔Safari match (guest paired but stuck
  // on "Dropping into the match…"). 8KB chunks are safe on every
  // browser. PeerJS data channels are ordered+reliable, so the pieces
  // arrive in sequence; the index guards against any reordering anyway.
  _sendChunked(msg) {
    if (!(this._conn && this._conn.open)) { this._sendQueue.push(msg); return; }
    let json;
    try { json = JSON.stringify(msg); } catch (e) { return; }
    // Slice size 3500: when a part is re-serialized inside the chunk
    // wrapper, every " and \ in it escapes to two chars (worst case
    // doubling), so a 3500-char part stays well under ~8KB on the wire —
    // safe on every browser's negotiated SCTP message limit, Safari
    // included. A message at/under this size sends whole (no wrapper).
    const LIMIT = 3500;
    if (json.length <= LIMIT) {
      try { this._conn.send(msg); } catch (e) {}
      return;
    }
    const id = (this._chunkSeq = (this._chunkSeq || 0) + 1);
    const total = Math.ceil(json.length / LIMIT);
    for (let i = 0; i < total; i++) {
      const part = json.slice(i * LIMIT, (i + 1) * LIMIT);
      try { this._conn.send({ t: '__chunk', id, i, total, part }); } catch (e) {}
    }
  }

  // Reassemble an inbound chunk. Returns the complete decoded message
  // once the final piece lands, else null while still collecting.
  _recvChunk(c) {
    if (!this._chunkBuf) this._chunkBuf = {};
    let buf = this._chunkBuf[c.id];
    if (!buf) buf = this._chunkBuf[c.id] = { total: c.total, parts: [], count: 0 };
    if (buf.parts[c.i] === undefined) { buf.parts[c.i] = c.part; buf.count++; }
    if (buf.count < buf.total) return null;
    delete this._chunkBuf[c.id];
    try { return JSON.parse(buf.parts.join('')); } catch (e) { return null; }
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

// ============================================================
// WEBRTC 4-PLAYER TRANSPORT — star topology for 2v2 online
// ============================================================
// Host (P1) claims a peer ID and accepts exactly 3 connections.
// Each joiner connects to the same host peer ID; host assigns
// slots p2/p3/p4 in connection order. All game state flows from
// host outward; joiners send action messages to the host only.
//
// Peer ID format: 'clb-4p-ABCD' to avoid collisions with 1v1.
// broadcastState(stateClone) — sends serialized state to all 3 joiners.
// send(msg) — joiners send actions to host.

class WebRTC4Transport {
  constructor() {
    this._peer = null;
    this._isHost = false;
    this._roomCode = null;
    this._conns = {};          // { p2: DataConnection, p3: ..., p4: ... }
    this._hostConn = null;     // joiner's single connection to host
    this._mySlot = null;       // 'p1' | 'p2' | 'p3' | 'p4'
    this._handlers = { message: [], close: [], error: [] };
    this._sendQueue = [];
  }

  _peerIdFor(code) { return 'clb-4p-' + String(code || '').toUpperCase(); }

  open() {}

  send(msg) {
    if (typeof Peer === 'undefined') {
      this._dispatchError('PeerJS not loaded');
      return;
    }
    if (msg && msg.t === 'createRoom') { this._openAsHost(msg); return; }
    if (msg && msg.t === 'joinRoom')   { this._openAsJoiner(msg); return; }
    // Game action — joiner sends to host; host echoes to self via dispatch
    if (this._isHost) {
      this._dispatch(msg);
    } else if (this._hostConn && this._hostConn.open) {
      this._sendChunked(this._hostConn, msg);
    } else {
      this._sendQueue.push(msg);
    }
  }

  // Split any message over the safe single-message size into ordered
  // chunks and reassemble on the far side — the same guard the 1v1
  // transport already carries. A single PeerJS `json` send is NOT
  // chunked by the library, and anything past ~16KB is dropped on the
  // floor with no error: `conn.send()` returns normally and the far
  // side's `data` handler simply never fires. The 2v2 draft-start
  // broadcast is ~30KB (the full card/trick pools ride along inside
  // twoVTwo), so every joiner sat on the lobby forever while the host
  // walked into the draft alone. 3500-char parts stay under ~8KB on the
  // wire even after JSON escaping doubles them, which is safe on every
  // browser's negotiated SCTP limit, Safari included.
  _sendChunked(conn, msg) {
    if (!(conn && conn.open)) return;
    let json;
    try { json = JSON.stringify(msg); } catch (e) { return; }
    const LIMIT = 3500;
    if (json.length <= LIMIT) {
      try { conn.send(msg); } catch (e) {}
      return;
    }
    const id = (this._chunkSeq = (this._chunkSeq || 0) + 1);
    const total = Math.ceil(json.length / LIMIT);
    for (let i = 0; i < total; i++) {
      const part = json.slice(i * LIMIT, (i + 1) * LIMIT);
      try { conn.send({ t: '__chunk', id, i, total, part }); } catch (e) {}
    }
  }

  // Reassemble an inbound chunk. Returns the complete decoded message
  // once the final piece lands, else null while still collecting. The
  // buffer hangs off the connection itself so the host's three joiner
  // streams can't collide on a shared chunk id.
  _recvChunk(conn, c) {
    if (!conn._chunkBuf) conn._chunkBuf = {};
    let buf = conn._chunkBuf[c.id];
    if (!buf) buf = conn._chunkBuf[c.id] = { total: c.total, parts: [], count: 0 };
    if (buf.parts[c.i] === undefined) { buf.parts[c.i] = c.part; buf.count++; }
    if (buf.count < buf.total) return null;
    delete conn._chunkBuf[c.id];
    try { return JSON.parse(buf.parts.join('')); } catch (e) { return null; }
  }

  _openAsHost(msg) {
    this._isHost = true;
    this._mySlot = 'p1';
    this._roomCode = msg.code;
    try {
      this._peer = new Peer(this._peerIdFor(msg.code), { debug: 1, config: _buildIceConfig() });
    } catch (e) {
      this._dispatchError('Peer init failed: ' + (e && e.message || e));
      return;
    }
    this._peer.on('open', () => {
      this._dispatch({ t: 'roomCreated', code: msg.code, you: 'p1' });
    });
    this._peer.on('connection', (conn) => {
      const slots = ['p2', 'p3', 'p4'];
      const taken = Object.keys(this._conns);
      const slot = slots.find(s => !taken.includes(s));
      if (!slot) { conn.close(); return; }  // room full
      this._conns[slot] = conn;
      conn.on('open', () => {
        conn.send({ t: '_slotAssigned', slot });
        const name = (conn.metadata && conn.metadata.name) || `Player ${slot[1]}`;
        this._dispatch({ t: 'playerJoined', playerKey: slot, name });
        if (Object.keys(this._conns).length === 3) {
          this._dispatch({ t: 'allPlayersReady' });
        }
      });
      conn.on('data', (data) => {
        if (data && data.t === '__chunk') {
          const full = this._recvChunk(conn, data);
          if (full && full.t) this._dispatch({ ...full, _from: slot });
          return;
        }
        if (data && data.t) this._dispatch({ ...data, _from: slot });
      });
      conn.on('close', () => {
        delete this._conns[slot];
        this._dispatch({ t: 'playerLeft', playerKey: slot });
      });
      conn.on('error', (err) => this._dispatchError('Conn error: ' + ((err && err.message) || err)));
    });
    this._peer.on('error', (err) => this._handlePeerError(err));
    this._peer.on('disconnected', () => { try { this._peer.reconnect(); } catch (e) {} });
  }

  _openAsJoiner(msg) {
    this._roomCode = msg.code;
    try {
      this._peer = new Peer({ debug: 1, config: _buildIceConfig() });
    } catch (e) {
      this._dispatchError('Peer init failed: ' + (e && e.message || e));
      return;
    }
    this._peer.on('open', () => {
      const conn = this._peer.connect(this._peerIdFor(msg.code), {
        serialization: 'json',    // JSON is more compatible than binary on iOS Safari
        metadata: { name: msg.name || 'Player' },
      });
      this._hostConn = conn;
      conn.on('open', () => {
        this._sendQueue.forEach(m => this._sendChunked(conn, m));
        this._sendQueue = [];
      });
      conn.on('data', (data) => {
        if (!data || !data.t) return;
        if (data.t === '__chunk') {
          const full = this._recvChunk(conn, data);
          if (full) this._dispatch(full);
          return;
        }
        if (data.t === '_slotAssigned') {
          this._mySlot = data.slot;
          this._dispatch({ t: 'roomJoined', code: this._roomCode, you: data.slot });
          return;
        }
        this._dispatch(data);
      });
      conn.on('close', () => this._dispatch({ t: 'playerLeft', playerKey: 'p1' }));
      conn.on('error', (err) => this._dispatchError('Conn error: ' + ((err && err.message) || err)));
    });
    this._peer.on('error', (err) => this._handlePeerError(err));
  }

  // Host broadcasts state to all 3 joiners
  broadcastState(stateClone) {
    const msg = { t: 'state', state: stateClone };
    Object.values(this._conns).forEach(conn => this._sendChunked(conn, msg));
  }

  close() {
    Object.values(this._conns).forEach(c => { try { c.close(); } catch (e) {} });
    if (this._hostConn) { try { this._hostConn.close(); } catch (e) {} }
    if (this._peer) { try { this._peer.destroy(); } catch (e) {} }
    this._conns = {};
    this._hostConn = null;
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
  _handlePeerError(err) {
    const type = err && err.type;
    let msg = (err && err.message) || String(err);
    if (type === 'unavailable-id') msg = 'Room code already in use.';
    else if (type === 'peer-unavailable') msg = "Couldn't find that room — check the code.";
    else if (type === 'network') msg = 'Network error reaching signaling server.';
    this._dispatchError(msg);
  }
}

// ============================================================
// MULTIPLAYER4 — thin adapter over WebRTC4Transport for 2v2 online
// ============================================================
// Same event model as Multiplayer but with 4-player semantics.
// 'you' is 'p1'|'p2'|'p3'|'p4' instead of 'player'|'ai'.
// The host also receives 'playerJoined', 'allPlayersReady', 'playerLeft'.

const Multiplayer4 = {
  _transport: null,
  _listeners: {},
  _you: null,
  _room: null,

  init(transport) {
    if (this._transport) this.leave();
    this._transport = transport;
    transport.onMessage((msg) => this._handleMsg(msg));
    transport.onClose(() => this._emit('playerLeft', {}));
    transport.onError((e) => this._emit('error', { message: String(e) }));
  },

  createRoom(opts) {
    const code = this._genCode();
    this._send({ t: 'createRoom', code, name: opts && opts.name });
    return code;
  },

  joinRoom(code, opts) {
    this._send({ t: 'joinRoom', code: code.toUpperCase(), name: opts && opts.name });
  },

  send(action) { this._send(action); },

  // Host broadcasts current game state to all joiners
  broadcastState(stateClone) {
    if (this._transport && this._transport.broadcastState) {
      this._transport.broadcastState(stateClone);
    }
  },

  leave() {
    if (this._transport) { try { this._transport.close(); } catch (e) {} }
    this._transport = null;
    this._you = null;
    this._room = null;
  },

  on(name, fn)  { (this._listeners[name] = this._listeners[name] || []).push(fn); },
  off(name, fn) {
    const arr = this._listeners[name];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  },

  _emit(name, payload) {
    (this._listeners[name] || []).forEach(fn => {
      try { fn(payload); } catch (e) { console.error('M4 listener error', e); }
    });
  },
  _send(msg) { if (this._transport) this._transport.send(msg); },
  _genCode() {
    const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 4; i++) s += alpha[Math.floor(Math.random() * alpha.length)];
    return s;
  },

  _GAME_ACTION_TYPES: new Set([
    'play2v2Card', 'play2v2Trick', 'end2v2Phase', '2v2DraftPick', 'start2v2',
    'req2v2LaneChoice', '2v2LaneChoiceResult', '2v2CardChoiceResult', '2v2DraftMulligan',
    'req2v2State'
  ]),
  _handleMsg(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (this._GAME_ACTION_TYPES.has(msg.t)) {
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
      case 'playerJoined':
        this._emit('playerJoined', msg);
        break;
      case 'allPlayersReady':
        this._emit('allPlayersReady', msg);
        break;
      case 'playerLeft':
        this._emit('playerLeft', msg);
        break;
      case 'state': {
        const rehydrated = Multiplayer._rehydrateState
          ? Multiplayer._rehydrateState(msg.state)
          : msg.state;
        this._emit('state', { state: rehydrated });
        break;
      }
      case 'error':
        this._emit('error', msg);
        break;
    }
  },
};

if (typeof window !== 'undefined') {
  window.Multiplayer4 = Multiplayer4;
  window.WebRTC4Transport = WebRTC4Transport;
}
