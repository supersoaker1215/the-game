// ============================================================
// PARTYKIT SERVER — one party = one room
// ============================================================
//
// A *very* thin server for v1. Two responsibilities:
//
//   1. Rendezvous: pair the host with the joining guest using the
//      4-letter code that came in via the connection URL. The party
//      ID *is* the room code, so PartyKit's routing already handles
//      this — we just track which connection is the host and which
//      is the guest.
//
//   2. Relay: any game-action message from either client is fanned
//      out to the OTHER client unchanged. State broadcasts from the
//      host are fanned out to the guest. The server doesn't run the
//      game engine in v1; that gives us the simplest possible
//      deployment but trusts the host's machine to be authoritative.
//
// v2 candidates (NOT in this file):
//   • Move the engine onto the server so neither client is trusted.
//     Requires importing game.js into the worker runtime — the engine
//     is pure JS, no DOM, so this should mostly Just Work.
//   • Persist room state across reconnects in storage.
//   • Public matchmaking pool.
//
// Connection URL convention:
//   wss://<deployment>.partykit.dev/parties/main/<ROOM>?role=host&name=Henry
//   wss://<deployment>.partykit.dev/parties/main/<ROOM>?role=guest&name=Friend
//
// The `role` is a hint — if a host hasn't connected yet, the first
// connection becomes host regardless of the hint, so a guest joining
// an empty code gracefully turns into the host.

export default {
  // PartyKit calls this once per party (== room) instance. We use it
  // to build the in-memory state for that single room. Each party's
  // state is isolated from every other party's, which is exactly the
  // shape we want for "one room = one match."
  async onConnect(conn, room, ctx) {
    const url = new URL(ctx.request.url);
    const role = url.searchParams.get('role') || 'guest';
    const name = url.searchParams.get('name') || 'Anonymous';

    // Initialize the room's state lazily on first connect. PartyKit's
    // `room.storage` is durable; for a thin v1 we keep state in
    // ephemeral closure variables instead — that's fine because if a
    // room goes idle the durable object hibernates and reawakens with
    // the connections gone, which is the same as a real disconnect.
    if (!room._mp) room._mp = { hostId: null, guestId: null, code: room.id, hostName: null, guestName: null };

    // First arrival becomes host. Subsequent arrival becomes guest.
    // If both seats are occupied the third arrival is rejected.
    let assigned = role;
    if (!room._mp.hostId) { assigned = 'host'; room._mp.hostId = conn.id; room._mp.hostName = name; }
    else if (!room._mp.guestId && conn.id !== room._mp.hostId) { assigned = 'guest'; room._mp.guestId = conn.id; room._mp.guestName = name; }
    else {
      conn.send(JSON.stringify({ t: 'error', message: 'Room is full.' }));
      conn.close();
      return;
    }

    // Acknowledge to the joining client. Format mirrors the
    // LocalTabTransport messages so the client adapter doesn't care
    // which transport it's on.
    if (assigned === 'host') {
      conn.send(JSON.stringify({ t: 'roomCreated', code: room.id, you: 'player' }));
    } else {
      conn.send(JSON.stringify({ t: 'roomJoined', code: room.id, you: 'ai' }));
      // Notify the host that the guest arrived.
      const hostConn = [...room.getConnections()].find(c => c.id === room._mp.hostId);
      if (hostConn) hostConn.send(JSON.stringify({ t: 'opponentJoined', name }));
    }

    // Stash the role on the connection so onMessage can route correctly.
    conn.serializeAttachment({ role: assigned, name });
  },

  // Per-message router. The set of legal message types matches the
  // ClientMsg / ServerMsg unions defined in multiplayer-architecture.md.
  // Routing rules:
  //   • Game actions (playCard, playTrick, doneTurn, etc.) ALWAYS go
  //     to the host. The host applies them locally and broadcasts a
  //     new state. We don't validate them server-side in v1 — the
  //     host's engine is the authority.
  //   • State broadcasts ALWAYS come from the host and go to the guest.
  //   • Hello / handshake messages stay local.
  async onMessage(message, sender, room) {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      console.warn('[partykit] rejected malformed message', e);
      sender.send(JSON.stringify({ t: 'error', message: 'Invalid multiplayer message.' }));
      return;
    }

    const a = sender.deserializeAttachment() || {};
    const role = a.role;

    // Game actions — relay to host (or apply at host if the host
    // sent them itself). When the action originated from the host's
    // own UI, the client doesn't send it through us at all (the
    // engine just runs locally). So in practice this branch is
    // guest-originated.
    const ACTION_TYPES = new Set(['playCard', 'playCardFree', 'playTrick', 'doneTurn', 'mulligan', 'draftPick', 'draftMulligan', 'promptResolve', 'forfeit']);
    if (ACTION_TYPES.has(msg.t)) {
      if (room._mp && room._mp.hostId) {
        const hostConn = [...room.getConnections()].find(c => c.id === room._mp.hostId);
        if (hostConn) hostConn.send(message);
      }
      return;
    }

    // State broadcast from host → fan to guest.
    if (msg.t === 'state' && role === 'host') {
      if (room._mp && room._mp.guestId) {
        const guestConn = [...room.getConnections()].find(c => c.id === room._mp.guestId);
        if (guestConn) guestConn.send(message);
      }
      return;
    }
  },

  async onClose(conn, room) {
    if (!room._mp) return;
    if (conn.id === room._mp.hostId) {
      // Host left — tell the guest the room is dead.
      room._mp.hostId = null;
      const guestConn = [...room.getConnections()].find(c => c.id === room._mp.guestId);
      if (guestConn) guestConn.send(JSON.stringify({ t: 'opponentLeft' }));
    } else if (conn.id === room._mp.guestId) {
      room._mp.guestId = null;
      const hostConn = [...room.getConnections()].find(c => c.id === room._mp.hostId);
      if (hostConn) hostConn.send(JSON.stringify({ t: 'opponentLeft' }));
    }
  }
};
