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
// Message shapes (client → server):
//   { t:'hello',    id, name }                         — announce / rename
//   { t:'report',   id, name, win:bool, cards:[str], ms:int }
//   { t:'favorite', id, name, card:str }
//   { t:'getBoard' }                                   — explicit refresh
// Server → client:
//   { t:'board', players:[ {id,name,wins,losses,playMs,favorite,mvp,mvpWins} ] }

const PLAYERS_KEY = 'players';
const MAX_NAME = 24;
const MAX_CARD = 48;
const MAX_CARDS_PER_REPORT = 24;   // a game can't credit more than a full board+hand

function clampStr(v, max) {
  if (typeof v !== 'string') return '';
  // Drop control characters (incl. newlines) so a name can't smuggle
  // markup or line breaks into the board; then trim and cap the length.
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
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
      const won = !!msg.win;
      if (won) rec.wins = (rec.wins || 0) + 1;
      else rec.losses = (rec.losses || 0) + 1;
      // Hours played: accumulate the reported match length, clamped so a bad
      // clock can't post a decade. 6h ceiling per game is generous headroom.
      const ms = Math.max(0, Math.min(6 * 3600 * 1000, (msg.ms | 0)));
      rec.playMs = (rec.playMs || 0) + ms;
      // MVP credit: every card the winner played this game gets +1. Losers
      // credit nothing — MVP is "the card you WIN the most with."
      if (won && Array.isArray(msg.cards)) {
        rec.cardWins = rec.cardWins || {};
        const seen = new Set();
        for (const raw of msg.cards.slice(0, MAX_CARDS_PER_REPORT)) {
          const name = clampStr(raw, MAX_CARD);
          if (!name || seen.has(name)) continue;   // one credit per card per game
          seen.add(name);
          rec.cardWins[name] = (rec.cardWins[name] || 0) + 1;
        }
      }
    } else {
      return;   // unknown type — ignore
    }

    players[id] = rec;
    await room.storage.put(PLAYERS_KEY, players);

    // Fan the fresh board out to everyone connected to the lobby.
    const board = JSON.stringify({ t: 'board', players: boardFrom(players) });
    for (const c of room.getConnections()) c.send(board);
  },
};
