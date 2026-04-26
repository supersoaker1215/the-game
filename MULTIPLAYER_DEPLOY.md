# Multiplayer deploy — going live

Your multiplayer infrastructure is **fully built and ready to deploy**. This
guide takes you from a local-tab dev mode to friends-over-the-internet
play in about 5 minutes.

## What's already in place

- **`partykit/server.js`** — relay server (per-room WebSocket; first
  connection becomes host, second becomes guest, third gets rejected).
- **`partykit/partykit.json`** — PartyKit config.
- **`multiplayer.js`** — client adapter with two transports:
  - `LocalTabTransport` — BroadcastChannel between two tabs of the
    same browser (current default for dev).
  - `WebSocketTransport` — connects to your deployed PartyKit URL.
- **Lobby UI** — already rendered in the multiplayer overlay with a
  "Set server URL" link in the transport-status footer.
- **Cross-tab tested** — the LocalTabTransport flow has been
  verified end-to-end (`UI.openMultiplayer` → generate code →
  synthetic guest joins → host pushes state).

You don't need to write any new code. You need to **ship the server**
and **set the URL on the client**.

## Step 1 — install PartyKit CLI (one time)

```sh
npm install -g partykit
```

Or use `npx partykit` directly if you don't want a global install.

## Step 2 — deploy the server

```sh
cd partykit
partykit deploy
```

First time, this will prompt you to log in (GitHub OAuth). After login
it deploys to `https://<your-team>-<project-name>.partykit.dev`.

The CLI prints the deployment URL when it finishes. **Copy it.**

Example output:

```
🎈 PartyKit
✔ Deployment ready: https://card-lane-battle.henrytagleiv.partykit.dev
```

## Step 3 — point the client at the deployment

Two options:

**Option A — UI (per-user):**
1. Open the game in your browser.
2. Open the Multiplayer panel (main menu → MULTIPLAYER).
3. Click "set server URL" in the footer.
4. Paste `wss://<your-deployment-url>` — note the `wss://` prefix
   (not `https://`). Convert by replacing `https` → `wss`.
5. Click OK. The footer now reads `Server: wss://...` and any
   future Create/Join in this browser uses the deployed server.

The URL is saved in `localStorage` under `clb-mp-server` so it
persists across reloads.

**Option B — bake it in (everyone gets it by default):**
1. Open `multiplayer.js`.
2. Search for `WebSocketTransport`.
3. Above the class, add a constant for your URL:
   ```js
   const DEFAULT_PARTYKIT_URL = 'wss://card-lane-battle.henrytagleiv.partykit.dev';
   ```
4. Open `ui.js`, find `_mpCreateRoom` and `_mpJoinRoom`. Replace:
   ```js
   const url = (localStorage.getItem('clb-mp-server') || '').trim();
   ```
   with:
   ```js
   const url = (localStorage.getItem('clb-mp-server') || '').trim() || DEFAULT_PARTYKIT_URL;
   ```
5. Bump the `multiplayer.js` `?v=` query in `index.html`.

Now Multiplayer works for any user without any setup on their end.

## Step 4 — test it

Open the game in two different browsers (or one browser + a phone
on the same WiFi):

1. **Browser A**: Multiplayer → "Generate Code" — copy the 4-letter code.
2. **Browser B**: Multiplayer → "Join Room" — paste the code.
3. Both clients show "CONNECTED!" and drop into a draft together.

If it doesn't work, check the browser DevTools Console for
WebSocket errors. Most common: wrong protocol (`https` instead
of `wss`), or PartyKit URL has a path you didn't include.

## How the URL routing works

PartyKit uses path-based routing:

```
wss://<deployment>/parties/main/<ROOM-CODE>?role=host&name=Alice
```

- `parties/main` — references the default party defined in
  `partykit.json` (`main` is the conventional name).
- `<ROOM-CODE>` — the 4-letter code (e.g. `BFLY`). PartyKit
  routes all clients with the same code to the same Durable
  Object instance.
- `?role=host` or `?role=guest` — assignment hint. The first
  client becomes host regardless of hint; the second becomes
  guest. A third gets rejected.

The client builds this URL automatically in
`Multiplayer.WebSocketTransport._buildUrl` — you just provide
the base.

## What v1 doesn't do (and what to do about it)

- **No reconnect** — if a client drops, the room ends. Workaround:
  use stable URLs and small game lengths.
- **No spectators** — only 2 connections per room. To add: tweak
  `onConnect` in `partykit/server.js` to allow extra connections
  with `role=spectator` and route state broadcasts to them too.
- **No state on the server** — the host's machine is authoritative.
  This is fine for friend-share but if you want ranked / public
  matches, you'd port `game.js` into the worker runtime so the
  server can validate every action. The engine is pure JS, so it
  should mostly Just Work.
- **No matchmaking** — friend-code only. For public matchmaking,
  add a "lobby" party that holds a queue of waiting players and
  pairs them.

See `multiplayer-architecture.md` for full design context, including
the planned phased rollout.

## Custom domain (optional)

PartyKit supports custom domains via Cloudflare. Add `--domain
play.yourgame.com` to the deploy command after configuring DNS.

## Costs

PartyKit's free tier covers roughly 100k requests/month, which is
plenty for friend-share. Each game is ~50 messages × 2 players +
state pushes = ~200 messages, so you can host ~500 matches/month
for free. Heavy usage moves you to the paid tier (currently
~$10/month for ~10x more).

## Troubleshooting

**"Connection error" toast on Generate Code**
- Server URL is wrong (typo, missing `wss://`)
- PartyKit deployment failed (re-run `partykit deploy`)
- Browser blocking mixed content (must be `wss://` from
  `https://` origin; `ws://` works only from `http://`)

**Code generated but guest can't join**
- Different server URLs on the two clients (one is dev, one is prod)
- Code typo (codes are case-insensitive but exact-letter)
- Host's tab closed (room died)

**Game starts but state desyncs**
- Engine bug — capture both clients' `Game.state` and diff
- Card hooks not rehydrating correctly (check
  `Multiplayer._rehydrateState` against your `CARD_DEFS`)
