// Сервер игры «Слова» на Cloudflare Workers.
// Все игроки подключаются к одному Durable Object «Lobby»: он сводит пары и ведёт партии.
import { DurableObject } from "cloudflare:workers";
import R from "./rules.js";
import Core from "./core.js";
import DATA from "./data.js";
import Privacy from "./privacy.js";

// Словари строятся один раз при запуске (без случайностей — так требует Cloudflare)
const lines = (src, name) => (src[name] ? src[name].split("\n") : []);
const DICTS = R.buildDicts((n) => lines(DATA.data, n), (n) => lines(DATA.keys, n));

// Профили игроков — во встроенной базе SQLite у Durable Object
function sqlStore(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY, name TEXT, rating INTEGER, wins INTEGER, losses INTEGER,
    games INTEGER, words INTEGER, best INTEGER, created INTEGER, updated INTEGER)`);
  sql.exec("CREATE INDEX IF NOT EXISTS players_rating ON players (rating DESC)");
  const one = (cur) => { const r = cur.toArray(); return r.length ? r[0] : null; };
  return {
    get: (id) => one(sql.exec("SELECT * FROM players WHERE id = ?", id)),
    save: (p) => sql.exec(
      `INSERT INTO players (id, name, rating, wins, losses, games, words, best, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, rating = excluded.rating, wins = excluded.wins,
         losses = excluded.losses, games = excluded.games, words = excluded.words, best = excluded.best, updated = excluded.updated`,
      p.id, p.name, p.rating, p.wins, p.losses, p.games, p.words || 0, p.best || 0, p.created || Date.now(), p.updated || Date.now()),
    rank: (rating) => 1 + one(sql.exec("SELECT COUNT(*) AS n FROM players WHERE rating > ?", rating)).n,
    top: (n) => sql.exec("SELECT * FROM players ORDER BY rating DESC, wins DESC LIMIT ?", n).toArray(),
    remove: (id) => sql.exec("DELETE FROM players WHERE id = ?", id),
  };
}

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.hub = Core.createHub(DICTS, env, sqlStore(ctx.storage.sql));
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, ws] = Object.values(pair);
    ws.accept();
    const player = this.hub.connect({
      send: (msg) => ws.send(JSON.stringify(msg)),
      isOpen: () => ws.readyState === 1,
    });
    ws.addEventListener("message", (e) => this.hub.message(player, typeof e.data === "string" ? e.data : ""));
    const bye = () => this.hub.disconnect(player);
    ws.addEventListener("close", bye);
    ws.addEventListener("error", bye);
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    if (request.headers.get("Upgrade") === "websocket") {
      const lobby = env.LOBBY.get(env.LOBBY.idFromName("main"));
      return lobby.fetch(request);
    }
    const url = new URL(request.url);
    if (url.pathname.startsWith("/privacy")) {
      return new Response(Privacy.privacyHtml(env.CONTACT_EMAIL), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("Слова: сервер работает\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },
};
