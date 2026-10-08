// Логика сервера «Слова» без привязки к хостингу: подбор соперника, партии, очки, бот.
// Соединение (conn) — любой объект с методами send(obj) и isOpen().
// Используется Node-сервером (server.js) и Cloudflare (cloudflare/src/index.js).

const R = require("./rules");

const BOT_NAMES = ["Кузьма", "Варя", "Филя", "Нюра", "Степан", "Тася", "Гоша"];

function createHub(dicts, options = {}) {
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  const TURN_MS = num(options.TURN_MS, 30_000);
  const GOAL = num(options.GOAL, 3000);
  const ASK_MS = num(options.ASK_MS, 15_000);          // ждём решения соперника по незнакомому названию
  const BOT_AFTER_MS = num(options.BOT_AFTER_MS, 20_000); // нет соперника — играем с ботом
  const BOT_SPEED = num(options.BOT_SPEED, 1);          // для тестов: <1 — бот быстрее

  const send = (conn, msg) => { if (conn && conn.isOpen()) conn.send(msg); };
  const validCat = (c) => (c === "random" || R.CAT_BY[c] ? c : "random");
  const compat = (a, b) => a === "random" || b === "random" || a === b;
  const randomCat = () => R.CATS[Math.floor(Math.random() * R.CATS.length)].id;

  let queue = []; // {player, cat, botTimer}

  class Game {
    constructor(a, b, cat) {
      this.players = Math.random() < 0.5 ? [a, b] : [b, a];
      this.cat = cat;
      this.used = new Set();
      this.history = [];
      this.letter = "";
      this.turn = 0;
      this.scores = [0, 0];
      this.timer = null;
      this.botTimer = null;
      this.pending = null; // незнакомое название ждёт решения
      this.over = false;
      const c = R.CAT_BY[cat];
      this.players.forEach((p, i) => {
        p.game = this;
        p.index = i;
        const o = this.players[1 - i];
        send(p.conn, { t: "start", opponent: o.name, bot: !!o.bot, first: i === 0, goal: GOAL, cat, catName: c.name, hint: c.hint, seconds: TURN_MS / 1000 });
      });
      this.startTurn();
    }

    startTurn() {
      clearTimeout(this.timer);
      this.turnStart = Date.now();
      this.remaining = TURN_MS;
      this.timer = setTimeout(() => this.finish(1 - this.turn, "timeout"), TURN_MS);
      this.players.forEach((p, i) => send(p.conn, { t: "turn", yours: i === this.turn, letter: this.letter, seconds: TURN_MS / 1000 }));
      if (this.players[this.turn].bot) this.botMove();
    }

    elapsed() { return TURN_MS - this.remaining + (Date.now() - this.turnStart); }

    word(player, raw) {
      if (this.over) return;
      if (player.index !== this.turn) return send(player.conn, { t: "rejected", reason: "Сейчас не ваш ход" });
      if (this.pending) return send(player.conn, { t: "rejected", reason: "Ждём решения соперника" });
      const r = R.check(this.cat, raw, this.letter, this.used);
      if (r.err) return send(player.conn, { t: "rejected", reason: r.err });
      const points = R.pointsFor(this.elapsed() / 1000);
      if (!r.unknown) return this.accept(player, r, points, false);

      const opp = this.players[1 - player.index];
      if (opp.bot) return send(player.conn, { t: "rejected", reason: "Такого нет в списке категории" });
      // Пауза хода, пока соперник решает
      clearTimeout(this.timer);
      this.remaining = TURN_MS - this.elapsed();
      this.pending = { player, r, points, timer: setTimeout(() => this.verdict(opp, true), ASK_MS) };
      send(player.conn, { t: "asking", word: r.w, seconds: ASK_MS / 1000 });
      send(opp.conn, { t: "ask", word: r.w, seconds: ASK_MS / 1000 });
    }

    verdict(from, ok) {
      const pd = this.pending;
      if (this.over || !pd || from.index === pd.player.index) return;
      clearTimeout(pd.timer);
      this.pending = null;
      send(from.conn, { t: "asked_done" });
      if (ok) return this.accept(pd.player, pd.r, pd.points, true);
      send(pd.player.conn, { t: "rejected", reason: `Соперник не засчитал «${pd.r.w}»`, resume: true });
      // Ход продолжается с остатком времени
      this.turnStart = Date.now();
      this.timer = setTimeout(() => this.finish(1 - this.turn, "timeout"), this.remaining);
      this.players.forEach((p, i) => send(p.conn, { t: "turn", yours: i === this.turn, letter: this.letter, seconds: this.remaining / 1000, resume: true }));
    }

    accept(player, r, points, approved) {
      this.scores[player.index] += points;
      this.used.add(r.k);
      this.history.push(r.w);
      this.letter = R.lastLetter(r.k);
      this.players.forEach((p, i) =>
        send(p.conn, { t: "word", word: r.w, mine: p === player, points, approved, me: this.scores[i], opp: this.scores[1 - i] })
      );
      if (this.scores[player.index] >= GOAL) return this.finish(player.index, "score");
      this.turn = 1 - this.turn;
      this.startTurn();
    }

    botMove() {
      const bot = this.players[this.turn];
      const d = dicts[this.cat];
      const src = this.letter ? d.byFirst[R.canon(this.letter)] || [] : Object.values(d.byFirst).flat();
      const isNouns = this.cat === "nouns";
      const pool = src.filter((n) => !this.used.has(isNouns ? n : R.keyOf(n)));
      if (pool.length === 0 || Math.random() < Math.min(0.35, 0.03 + this.history.length * 0.01)) return; // «не вспомнил»
      const delay = (1500 + Math.random() * Math.random() * 20000) * BOT_SPEED;
      this.botTimer = setTimeout(() => {
        if (this.over || this.players[this.turn] !== bot) return;
        this.word(bot, pool[Math.floor(Math.random() * pool.length)]);
      }, delay);
    }

    // reason: timeout | left | surrender | score
    finish(winnerIndex, reason) {
      if (this.over) return;
      this.over = true;
      clearTimeout(this.timer);
      clearTimeout(this.botTimer);
      if (this.pending) clearTimeout(this.pending.timer);
      this.players.forEach((p, i) => {
        send(p.conn, { t: "end", win: i === winnerIndex, reason, words: this.history.length, me: this.scores[i], opp: this.scores[1 - i] });
        p.game = null;
      });
    }
  }

  function leaveQueue(player) {
    const q = queue.find((x) => x.player === player);
    if (q) clearTimeout(q.botTimer);
    queue = queue.filter((x) => x.player !== player);
  }

  function findGame(player, cat) {
    leaveQueue(player);
    queue = queue.filter((x) => x.player.conn.isOpen());
    const i = queue.findIndex((x) => compat(x.cat, cat));
    if (i >= 0) {
      const other = queue[i];
      leaveQueue(other.player);
      const gameCat = cat !== "random" ? cat : other.cat !== "random" ? other.cat : randomCat();
      return new Game(other.player, player, gameCat);
    }
    const entry = { player, cat };
    entry.botTimer = setTimeout(() => {
      if (!queue.includes(entry)) return;
      leaveQueue(player);
      const bot = { bot: true, conn: null, name: "Бот " + BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)], game: null, index: -1 };
      new Game(player, bot, cat === "random" ? randomCat() : cat);
    }, BOT_AFTER_MS);
    queue.push(entry);
    send(player.conn, { t: "waiting", botIn: BOT_AFTER_MS / 1000 });
  }

  return {
    queueSize: () => queue.length,

    // Новое соединение -> объект игрока
    connect(conn) {
      return { conn, name: "Игрок", game: null, index: -1 };
    },

    message(player, data) {
      let msg;
      try { msg = typeof data === "string" ? JSON.parse(data) : JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "find") {
        if (player.game) return;
        player.name = String(msg.name || "Игрок").slice(0, 20);
        findGame(player, validCat(msg.cat));
      } else if (msg.t === "cancel") {
        leaveQueue(player);
      } else if (msg.t === "word" && player.game) {
        player.game.word(player, msg.word);
      } else if (msg.t === "verdict" && player.game) {
        player.game.verdict(player, !!msg.ok);
      } else if (msg.t === "surrender" && player.game) {
        player.game.finish(1 - player.index, "surrender");
      } else if (msg.t === "ping") {
        send(player.conn, { t: "pong" });
      }
    },

    disconnect(player) {
      leaveQueue(player);
      if (player.game) player.game.finish(1 - player.index, "left");
    },
  };
}

module.exports = { createHub };
