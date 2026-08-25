// ============================================================
// CLOUDFLARE WORKER — the shared leaderboard (stats server)
// ============================================================
//
// A direct port of partykit/stats-server.js. PartyKit's free hosting zone
// (partykit.dev) hit Cloudflare's 10,000-subdomain cap and can no longer
// provision new projects, so the same server runs here as a Worker + a single
// Durable Object instead. The wire protocol is byte-for-byte identical, and the
// client URL shape is unchanged: it still opens `wss://<worker>/parties/stats/
// global`, and this Worker routes any WebSocket upgrade to the one global room.
//
// Persistence: Durable Object storage (SQLite-backed, free-tier eligible). The
// whole player map lives under one key — the board is a friend group, so one
// read/write per update is cheaper and simpler than a key per player.
//
// Anti stat-padding is enforced here exactly as in the PartyKit version: a
// result counts only when a real opponent corroborates the same matchId (one
// win + one loss from two distinct devices), each applied once; a report with no
// matchId (vs-AI, or fabricated) is never counted. See stats-server.js for the
// full rationale — this file keeps the same logic so the two can't drift.

const PLAYERS_KEY = 'players';
const PENDING_KEY = 'pendingMatches';   // matchId -> { at, reps: { deviceId: {win,cards,ms,name,applied} } }
const MAX_NAME = 24;
const MAX_CARD = 48;
const MAX_CARDS_PER_REPORT = 24;   // a game can't credit more than a full board+hand
const PENDING_TTL_MS = 6 * 3600 * 1000;   // forget un-corroborated matches after 6h

function clampStr(v, max) {
  if (typeof v !== 'string') return '';
  // Drop control characters (incl. newlines) so a name can't smuggle markup or
  // line breaks into the board; then trim and cap the length.
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

// Apply ONE corroborated result to a player record: win/loss, hours, and (on a
// win) +1 to every distinct card they played, for the MVP tally.
function applyResult(rec, r) {
  if (r.win) rec.wins = (rec.wins || 0) + 1;
  else rec.losses = (rec.losses || 0) + 1;
  rec.playMs = (rec.playMs || 0) + Math.max(0, Math.min(6 * 3600 * 1000, r.ms | 0));
  if (r.win && Array.isArray(r.cards)) {
    rec.cardWins = rec.cardWins || {};
    const seen = new Set();
    for (const raw of r.cards.slice(0, MAX_CARDS_PER_REPORT)) {
      const name = clampStr(raw, MAX_CARD);
      if (!name || seen.has(name)) continue;   // one credit per card per game
      seen.add(name);
      rec.cardWins[name] = (rec.cardWins[name] || 0) + 1;
    }
  }
}

// Drop pending matches older than the TTL so un-corroborated reports (a lone
// fabricated win, a disconnect before the opponent reported) can't pile up.
function prunePending(pending) {
  const now = Date.now();
  for (const mid in pending) {
    if (now - (pending[mid].at || 0) > PENDING_TTL_MS) delete pending[mid];
  }
}

// Derive the MVP (most-winning card) for one record from its cardWins map.
function mvpOf(rec) {
  let best = null, bestN = 0;
  const cw = rec.cardWins || {};
  for (const name in cw) {
    if (cw[name] > bestN) { bestN = cw[name]; best = name; }
  }
  return { mvp: best, mvpWins: bestN };
}

// The public, render-ready board: sorted by wins desc, then win-rate, and
// stripped of the internal cardWins map (only the derived MVP goes out).
function boardFrom(players) {
  const rows = Object.keys(players).map(id => {
    const r = players[id];
    const { mvp, mvpWins } = mvpOf(r);
    return {
      id,
      name: r.name || 'Anonymous',
      wins: r.wins || 0,
      losses: r.losses || 0,
      playMs: r.playMs || 0,
      favorite: r.favorite || null,
      mvp, mvpWins,
    };
  });
  rows.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    const ar = a.wins / Math.max(1, a.wins + a.losses);
    const br = b.wins / Math.max(1, b.wins + b.losses);
    return br - ar;
  });
  return rows;
}

// ---- Durable Object: the one global leaderboard room --------------------
export class StatsRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
    // Serialize message handling so two near-simultaneous reports can't
    // interleave their read-modify-write of the player map and lose an update.
    this._chain = Promise.resolve();
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.sockets.add(server);

    // Greet with the current board so the menu renders immediately.
    const players = (await this.state.storage.get(PLAYERS_KEY)) || {};
    try { server.send(JSON.stringify({ t: 'board', players: boardFrom(players) })); } catch (e) {}

    server.addEventListener('message', (ev) => {
      this._chain = this._chain.then(() => this._handle(ev.data, server)).catch(() => {});
    });
    const drop = () => { this.sockets.delete(server); };
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(str) {
    for (const s of this.sockets) {
      try { s.send(str); } catch (e) { this.sockets.delete(s); }
    }
  }

  async _handle(message, sender) {
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    const storage = this.state.storage;

    if (msg.t === 'getBoard') {
      const players = (await storage.get(PLAYERS_KEY)) || {};
      try { sender.send(JSON.stringify({ t: 'board', players: boardFrom(players) })); } catch (e) {}
      return;
    }

    const id = clampStr(msg.id, 64);
    if (!id) return;                       // every write is keyed by a device id
    const players = (await storage.get(PLAYERS_KEY)) || {};
    const rec = players[id] || { name: 'Anonymous', wins: 0, losses: 0, playMs: 0, favorite: null, cardWins: {} };

    if (msg.t === 'hello') {
      const nm = clampStr(msg.name, MAX_NAME);
      if (nm) rec.name = nm;
    } else if (msg.t === 'favorite') {
      const nm = clampStr(msg.name, MAX_NAME);
      if (nm) rec.name = nm;
      rec.favorite = clampStr(msg.card, MAX_CARD) || null;
    } else if (msg.t === 'report') {
      const nm = clampStr(msg.name, MAX_NAME);
      if (nm) rec.name = nm;
      // NO MATCH ID → NEVER COUNTED. Only online PvP games carry a shared,
      // host-stamped matchId; a fabricated report has no real opponent to stamp
      // one, and a vs-AI game has none either. The name update above still
      // persists so the player appears, just with no fabricated record.
      const matchId = clampStr(msg.matchId, 64);
      if (matchId) {
        const pending = (await storage.get(PENDING_KEY)) || {};
        prunePending(pending);
        const entry = pending[matchId] || { at: Date.now(), reps: {} };
        // First report from this device for this match wins — a device can't
        // flip its own result, and a re-send can't double-count.
        if (!entry.reps[id]) {
          entry.reps[id] = {
            win: !!msg.win,
            cards: Array.isArray(msg.cards) ? msg.cards.slice(0, MAX_CARDS_PER_REPORT) : [],
            ms: msg.ms | 0,
            name: rec.name,
            applied: false,
          };
        }
        entry.at = Date.now();
        // Corroboration: commit only once this match has been reported by ≥2
        // distinct devices AND carries BOTH a win and a loss. Then apply every
        // not-yet-applied reporter (covers 1v1's two and 2v2's four).
        const reps = Object.values(entry.reps);
        const distinct = Object.keys(entry.reps).length >= 2;
        const hasWin = reps.some(r => r.win);
        const hasLoss = reps.some(r => !r.win);
        if (distinct && hasWin && hasLoss) {
          for (const devId in entry.reps) {
            const r = entry.reps[devId];
            if (r.applied) continue;
            const target = (devId === id) ? rec : (players[devId] || { name: r.name || 'Anonymous', wins: 0, losses: 0, playMs: 0, favorite: null, cardWins: {} });
            if (r.name) target.name = r.name;
            applyResult(target, r);
            r.applied = true;
            players[devId] = target;
          }
        }
        pending[matchId] = entry;
        await storage.put(PENDING_KEY, pending);
      }
    } else {
      return;   // unknown type — ignore
    }

    // Persist the sender's own record; corroboration commits wrote the other
    // devices into `players` inside the loop above.
    players[id] = rec;
    await storage.put(PLAYERS_KEY, players);

    this.broadcast(JSON.stringify({ t: 'board', players: boardFrom(players) }));
  }
}

// ---- Worker entry: route every WebSocket to the one global room ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Health check for a plain browser hit (no upgrade) so opening the URL
    // shows something friendly instead of a 426.
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Card Lane Battle — leaderboard server. Connect over WebSocket at /parties/stats/global.', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    // One room for everyone. The client path (/parties/stats/global) is kept for
    // URL compatibility with the PartyKit client, but any path maps to 'global'.
    const idName = url.pathname.split('/').filter(Boolean).pop() || 'global';
    const id = env.STATS_ROOM.idFromName(idName || 'global');
    const stub = env.STATS_ROOM.get(id);
    return stub.fetch(request);
  },
};
