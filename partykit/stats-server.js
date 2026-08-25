// ============================================================
// PARTYKIT STATS SERVER — one global room, the shared leaderboard
// ============================================================
//
// Unlike the match relay (server.js, one party == one room), this party
// has a SINGLE room that every player connects to: `/parties/stats/global`.
// It owns the persistent leaderboard — wins, losses, hours played, the card
// each player wins the most with (MVP), and their chosen favorite card.
//
// Persistence: everything lives in `room.storage`, PartyKit's durable
// key-value store, so the board survives the room hibernating and the
// worker restarting. We keep the whole player map under one key ("players")
// — the board is small (a friend group), so one read/write per update is
// cheaper and simpler than a key per player.
//
// Trust model (v1): friends board. Clients self-report their own results;
// the server does not referee. A player reports from their OWN perspective
// (their win/loss + the cards THEY played), so an online match produces two
// independent reports, one per device.
//
// Identity: a per-device anonymous id the client generates once and keeps in
// localStorage, plus the real name the player typed. The id is the key (so a
// rename doesn't split someone's history or collide with a namesake); the
// name is display only.
//
// ANTI STAT-PADDING. A player cannot inflate their record by firing reports:
// a result is counted ONLY when a real opponent corroborates the same match.
// Every online match carries one shared `matchId` (the host stamps it and it
// syncs to every seat). A report is parked under its matchId; a device's result
// is committed only once BOTH outcomes have been reported for that match by two
// different devices (one win + one loss) — so a fabricated lone win never
// scores, and each device's result for a match is applied exactly once (no
// replay). A report with no matchId (a vs-AI game, or a fabricated one) is
// simply never counted here. (Residual: two devices controlled by one person
// could still corroborate each other — closing that needs real accounts, which
// this game intentionally doesn't have.)
//
// Message shapes (client → server):
//   { t:'hello',    id, name }                                    — announce / rename
//   { t:'report',   id, name, win:bool, cards:[str], ms:int, matchId:str }
//   { t:'favorite', id, name, card:str }
//   { t:'getBoard' }                                              — explicit refresh
// Server → client:
//   { t:'board', players:[ {id,name,wins,losses,playMs,favorite,mvp,mvpWins} ] }

const PLAYERS_KEY = 'players';
const PENDING_KEY = 'pendingMatches';   // matchId -> { at, reps: { deviceId: {win,cards,ms,name,applied} } }
const MAX_NAME = 24;
const MAX_CARD = 48;
const MAX_CARDS_PER_REPORT = 24;   // a game can't credit more than a full board+hand
const PENDING_TTL_MS = 6 * 3600 * 1000;   // forget un-corroborated matches after 6h

function clampStr(v, max) {
  if (typeof v !== 'string') return '';
  // Drop control characters (incl. newlines) so a name can't smuggle
  // markup or line breaks into the board; then trim and cap the length.
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

export default {
  async onConnect(conn, room) {
    // Greet the new connection with the current board so the menu can render
    // immediately without waiting for anyone to act.
    const players = (await room.storage.get(PLAYERS_KEY)) || {};
    conn.send(JSON.stringify({ t: 'board', players: boardFrom(players) }));
  },

  async onMessage(message, sender, room) {
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'getBoard') {
      const players = (await room.storage.get(PLAYERS_KEY)) || {};
      sender.send(JSON.stringify({ t: 'board', players: boardFrom(players) }));
      return;
    }

    const id = clampStr(msg.id, 64);
    if (!id) return;                       // every write is keyed by a device id
    const players = (await room.storage.get(PLAYERS_KEY)) || {};
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
      // NO MATCH ID → NEVER COUNTED. This is the anti-pad gate: only online PvP
      // games carry a shared, host-stamped matchId, and a fabricated report has
      // no real opponent to stamp one. A vs-AI game lands here too and is
      // intentionally not scored on the shared board. We still persist the name
      // update above so the player appears, just with no fabricated record.
      const matchId = clampStr(msg.matchId, 64);
      if (matchId) {
        const pending = (await room.storage.get(PENDING_KEY)) || {};
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
        // Corroboration: commit results only once this match has been reported
        // by ≥2 distinct devices AND carries BOTH a win and a loss. Then apply
        // every not-yet-applied reporter (covers 1v1's two and 2v2's four).
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
        await room.storage.put(PENDING_KEY, pending);
      }
    } else {
      return;   // unknown type — ignore
    }

    // Persist the sender's own record (name/favorite updates, and — if this
    // report just corroborated — their committed result). Other devices touched
    // by a corroboration commit were written into `players` inside the loop.
    players[id] = rec;
    await room.storage.put(PLAYERS_KEY, players);

    // Fan the fresh board out to everyone connected to the lobby.
    const board = JSON.stringify({ t: 'board', players: boardFrom(players) });
    for (const c of room.getConnections()) c.send(board);
  },
};
