// Сервер игры «Слова» на Cloudflare Workers.
// Все игроки подключаются к одному Durable Object «Lobby»: он сводит пары и ведёт партии.
import { DurableObject } from "cloudflare:workers";
import R from "./rules.js";
import Core from "./core.js";
import DATA from "./data.js";

// Словари строятся один раз при запуске (без случайностей — так требует Cloudflare)
const lines = (src, name) => (src[name] ? src[name].split("\n") : []);
const DICTS = R.buildDicts((n) => lines(DATA.data, n), (n) => lines(DATA.keys, n));

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.hub = Core.createHub(DICTS, env);
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
    return new Response("Слова: сервер работает\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },
};
