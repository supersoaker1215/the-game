# Migration guide: static → Vite

The existing workflow (static server + `?v=N` cache-bust on each script
tag) still works — nothing breaks. This file documents the path to the
Vite pipeline when you're ready.

## Current state

- `package.json` scaffolded with `vite` + `typescript` as devDependencies.
- `vite.config.js` bundles `index.html` and its loose `<script>` tags
  into `dist/` with hashed asset names.
- `npm run dev:static` still works (runs `python3 -m http.server 8080`)
  for anyone who wants the old workflow.

## Step 1 — install dependencies

```bash
cd "path/to/The Game"
npm install
```

## Step 2 — try the Vite dev server

```bash
npm run dev
```

This reads `index.html` directly, bundles the `<script>` tags through
Vite's dev server, and serves hot-reload at `http://localhost:8080`.
Reloads are instant vs. the static server's hard refresh.

## Step 3 — build a production bundle

```bash
npm run build
```

Writes `dist/`:
- `dist/index.html` — updated with hashed asset references
- `dist/assets/*.js` — minified, tree-shaken, chunked
- `dist/assets/*.css` — minified
- `dist/audio/*` — copied from the `audio/` public folder

Serve `dist/` with any static host.

## Step 4 (optional) — convert to ES modules

The biggest win from Vite comes after rewriting the loose scripts as
ES modules. Current load order:

```
cards.js → tricks.js → abilities.js → decks.js → game.js → ai.js → ui.js → logger.js
```

Migration path:
1. Turn each file into a module by adding exports (`export const CARD_DEFS = [...]`).
2. Replace globals with imports (`import { CARD_DEFS } from './cards.js'`).
3. Change `index.html` to a single entry: `<script type="module" src="main.js">`.
4. Add `main.js` that imports everything and calls `UI.init()`.

That unlocks code-splitting (abilities.js can lazy-load, 95-card
ability table doesn't block first paint), per-file TypeScript
adoption, and tree-shaking of unused helpers.

## Step 5 (optional) — add TypeScript incrementally

`tsconfig.json` is already scaffolded. With `allowJs: true` + `checkJs: false`,
you can rename files one at a time:

1. `abilities.js` → `abilities.ts` (biggest win — 95 cards × many status flags)
2. `game.js` → `game.ts` (types the entire game state)
3. `ui.js` → `ui.ts` (last, biggest file)

`tsc --noEmit` (via `npm run typecheck`) catches errors without
generating output — Vite handles the actual compilation.

## Rollback

If anything goes wrong:
- Delete `node_modules/`, `dist/`, `package-lock.json`.
- The existing loose-script workflow is unchanged — just serve the
  repo root with any HTTP server.
