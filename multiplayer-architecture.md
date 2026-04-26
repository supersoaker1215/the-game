# Multiplayer Architecture

Decision summary for the multiplayer rollout. Goal: ship a "share with friends" PWA where two players each on their own phone/computer play head-to-head over the internet.

## Transport: PartyKit (Cloudflare Workers)

**Why:** Free tier covers indie use. Per-room WebSocket model maps cleanly to "one match = one party." No server state to manage outside the room. Deploy is a single `npx partykit deploy`. Latency is good globally.

**Adapter pattern:** the client talks to a small `Multiplayer` JS module that abstracts the transport. The same client code works over:
- PartyKit (production)
- Plain Node `ws` server (local dev / self-host)
- localStorage broadcast (cross-tab fake transport for testing without any server)

So the architecture isn't locked to PartyKit — we can swap if the free tier ever stops being free.

## Authority model: server-authoritative, client-prediction-light

The PartyKit room is the **canonical** game state. Each client maintains a local copy that mirrors the server's. Players send ACTIONS over WebSocket; the server validates, applies them through the existing `Game` engine, and broadcasts a state diff (or the whole state for simplicity in v1).

This means:
- Anti-cheat is server-side (the server runs `Game.playCard` etc.; clients can't fabricate state they don't have)
- AI is replaced by another human (the existing `AI` module is unused in PvP rooms)
- The `Game` engine code runs identically on the server (it's pure-JS, no DOM dependencies in the engine itself)

Client-side prediction is intentionally minimal in v1: the player taps "play card", we send the action, and wait for the server's authoritative response (~50-150ms). UX-wise this is fine for turn-based; real-time games would need rollback.

## Action protocol

Every player input is one of these messages, sent as JSON over the WebSocket:

```ts
// Client → Server
type ClientMsg =
  | { t: 'hello',         playerId: string, name: string }
  | { t: 'createRoom',    deck?: { cards: string[], tricks: string[] } }
  | { t: 'joinRoom',      code: string, deck?: { cards: string[], tricks: string[] } }
  | { t: 'playCard',      cardId: number, lane: number }
  | { t: 'playCardFree',  cardId: number, lane: number }    // jump / free plays
  | { t: 'playTrick',     trickName: string, target?: any } // target shape varies per trick
  | { t: 'doneTurn' }                                       // end current sub-phase
  | { t: 'mulligan' }                                       // draft mulligan
  | { t: 'draftPick',     index: 0 | 1 }
  | { t: 'promptResolve', kind: 'card' | 'lane' | 'block' | 'timestone', payload: any }
  | { t: 'forfeit' };

// Server → Client
type ServerMsg =
  | { t: 'roomCreated', code: string, you: 'player' | 'ai' }
  | { t: 'roomJoined',  code: string, you: 'player' | 'ai' }
  | { t: 'opponentJoined', name: string }
  | { t: 'opponentLeft' }
  | { t: 'state',       state: GameState }                  // full state broadcast
  | { t: 'log',         line: string }                      // play-by-play log line (optional optimization)
  | { t: 'error',       message: string };
```

In v1 we send the full state on every change. ~85KB per snapshot — fine for any modern connection. A diff-based protocol is a v2 optimization.

## Room lifecycle

1. **Create**: Player A opens "Multiplayer" → "Create Room". Server generates a 4-letter code (e.g. `BFLY`). Client receives `roomCreated` and shows the code.
2. **Share**: Player A texts the code to Player B (manual sharing — no contact list needed).
3. **Join**: Player B opens the same site, taps "Join Room", enters `BFLY`. Server pairs them.
4. **Match**: Server runs the existing draft → play → combat → end-game flow, broadcasting state after each action.
5. **Disconnect**: If a player drops, the server holds the room for 60s. If they reconnect with the same `playerId` (stored in localStorage), they resume. Otherwise, opponent gets a forfeit win.

## Serialization layer

Game.state has 187 function references (card hooks like `onPlay`, `play`, `canPlay`). These do NOT serialize — `JSON.stringify` silently drops functions. On the receive end, we **rehydrate** by:

1. Walking every card-shaped object in the parsed state (board lanes, hand, trickHand, deadPile, drawPile, etc.)
2. Looking up its `name` in `CARD_DEFS` (or `TRICK_DEFS`)
3. Re-attaching every callback from the def + every behavior from `CARD_ABILITIES[name]`

Card-instance fields like `attack`, `currentHealth`, `evadeCharges`, `_grantedBuffs`, etc. survive JSON intact.

`_summonedBy` is a CARD reference — it loses identity through round-trip (becomes a plain object). On serialize we replace it with `_summonedById: card._summonedBy.id`. On rehydrate we walk the state once to build an `id → card` map, then patch the references back.

## Client state sync

- **Source of truth**: the server's last-broadcast state.
- **Local rendering**: client stores the server's state as `Game.state`. Every WebSocket `state` message replaces it (with rehydration), then triggers `UI.render()`.
- **No optimistic updates in v1**: when you tap "play card", we do NOT update the local state immediately — we send the action, wait for the server response, then apply. ~150ms feel for the first deploy. Optimistic prediction is v2.

## File structure

```
The Game/
├── index.html              (existing, add multiplayer.js + lobby UI)
├── game.js                 (existing engine, runs unchanged on the server too)
├── ui.js                   (existing, add lobby render + multiplayer mode flag)
├── multiplayer.js          (NEW — client transport adapter, lobby logic, state sync)
├── partykit/
│   ├── partykit.json       (PartyKit config)
│   └── server.js           (NEW — server-side Party class, validates actions)
└── multiplayer-architecture.md  (this file)
```

`partykit/server.js` imports `game.js` directly (it's pure JS, runs on any V8 / Workers runtime). The same engine that runs in the browser also runs on the server — there's only one source of truth for game logic.

## Open issues to resolve in implementation

1. **Promise-based prompts**: `Game.promptCardChoice`, `Game.promptLaneChoice`, etc. take callbacks that fire when the user clicks. In multiplayer, the prompt should fire on the OWNER's client only, and their resolution sends a `promptResolve` action that the server applies. The server-side game engine needs to PAUSE at each prompt and wait for the matching client to respond. Need to refactor the prompt flow into a Promise-based contract that can serialize state mid-prompt.

2. **Replay determinism**: existing replay system records state snapshots per round; that should naturally Just Work over multiplayer since the snapshots come from the server.

3. **Card definitions sync**: server and client MUST run the same `CARD_DEFS`/`TRICK_DEFS`/`CARD_ABILITIES` versions. Bake a version hash into `hello`/`roomCreated` and reject mismatches early.

4. **AI fallback for one-player rooms**: if Player B never joins, the room can fall back to AI-vs-Player so Player A still gets a game. Optional UX nicety.

## Phased rollout

- **Phase 1 (this session)**: Build the lobby UI, the transport adapter (with localStorage-cross-tab mock for testing), and the action protocol skeleton. Mock state sync between two browser tabs.
- **Phase 2**: PartyKit server.js with validated action handlers. Deploy. Two real clients on different machines.
- **Phase 3**: Disconnect handling + reconnect via stored `playerId`.
- **Phase 4**: Polish — opponent thinking indicator, latency display, public matchmaking pool.
