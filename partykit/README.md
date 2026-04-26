# PartyKit Server — Card Lane Battle Multiplayer

A thin per-room WebSocket relay used as the production transport for
the multiplayer rollout.

## Local dev

```sh
cd partykit
npx partykit dev
```

This runs the worker on `http://127.0.0.1:1999`. Point the client at
it from the browser console:

```js
localStorage.setItem('clb-mp-server', 'ws://127.0.0.1:1999/parties/main/test1');
location.reload();
```

(The `test1` is the room code — the URL itself names the party.)

The lobby UI's `WebSocketTransport` will pick up the saved URL and
connect on the next Create Room / Join Room.

## Deploy

```sh
cd partykit
npx partykit deploy
```

This publishes to `<your-team>.<project>.partykit.dev`. Note the URL
PartyKit prints; that's the base for the client URL pattern:

```
wss://<deployment>.partykit.dev/parties/main/<ROOM>
```

## What's in the server

- `onConnect` — first connection per room becomes host, second becomes
  guest. Third gets a "room is full" error. Sends `roomCreated` or
  `roomJoined` to acknowledge.
- `onMessage` — relays game-action messages to the host and state
  broadcasts to the guest. Doesn't validate (v1 trusts the host's
  engine).
- `onClose` — notifies the surviving connection that their opponent
  dropped.

## What's NOT in the server (v2 work)

- Server-side engine validation. The host can technically lie about
  state. Fine for friend-share but not for ranked / public lobbies.
- Reconnect / 60-second grace window. Currently a closed connection
  drops you immediately.
- Public matchmaking pool / room list / room metadata.

See `../multiplayer-architecture.md` for the full design context.
