// Логика сервера «Слова» без привязки к хостингу: подбор соперника, партии, очки, бот.
// Соединение (conn) — любой объект с методами send(obj) и isOpen().
// Хранилище профилей (store) — объект с синхронными методами:
//   get(id) -> профиль или null, save(профиль), rank(rating) -> место, top(n) -> [профили]
// Используется Node-сервером (server.js) и Cloudflare (cloudflare/src/index.js).

const R = require("./rules");

const BOT_NAMES = ["Кузьма", "Варя", "Филя", "Нюра", "Степан", "Тася", "Гоша"];

// Уровни бота: задержка ответа (мс), шанс «не вспомнить» (растёт с длиной партии), поправка рейтинга
const BOT_LEVELS = {
  easy:   { name: "лёгкий",  min: 7000, max: 20000, stuck: (n) => Math.min(0.2, 0.05 + n * 0.006), rating: -100 },
  medium: { name: "средний", min: 3000, max: 13000, stuck: (n) => Math.min(0.12, 0.02 + n * 0.004), rating: 0 },
  hard:   { name: "сложный", min: 1500, max: 6000,  stuck: (n) => Math.min(0.05, 0.005 + n * 0.0015), rating: 100, smart: true },
};

const RATING_START = 1000;
const RATING_STEP = 25;

// Хранилище в памяти — для тестов и как запасной вариант
function memoryStore() {
  const m = new Map();
  return {
    get: (id) => (m.has(id) ? { ...m.get(id) } : null),
    save: (p) => m.set(p.id, { ...p }),
    rank: (rating) => 1 + [...m.values()].filter((p) => p.rating > rating).length,
    top: (n) => [...m.values()].sort((a, b) => b.rating - a.rating || b.wins - a.wins).slice(0, n),
    remove: (id) => m.delete(id),
    all: () => [...m.values()],
  };
}

function createHub(dicts, options = {}, store = memoryStore()) {
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

  const cleanName = (n) => String(n || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 20) || "Игрок";
  function profileView(p) {
    if (!p) return null;
    return { name: p.name, rating: p.rating, wins: p.wins, losses: p.losses, games: p.games, words: p.words, best: p.best, place: store.rank(p.rating) };
  }
  // Итог партии в рейтинг: победа +25, поражение −25, не ниже нуля
  function applyResult(player, win, words) {
    if (!player || player.bot || !player.profile) return null;
    const p = store.get(player.profile.id) || player.profile;
    const before = p.rating;
    p.rating = Math.max(0, p.rating + (win ? RATING_STEP : -RATING_STEP));
    p.games += 1;
    if (win) p.wins += 1; else p.losses += 1;
    p.words += words;
    p.updated = Date.now();
    store.save(p);
    player.profile = p;
    return { rating: p.rating, delta: p.rating - before };
  }

  class Game {
    constructor(a, b, cat) {
      this.players = Math.random() < 0.5 ? [a, b] : [b, a];
      this.cat = cat;
      this.used = new Set();
      this.history = [];
      this.letter = "";
      this.turn = 0;
      this.scores = [0, 0];
      this.wordsBy = [0, 0];
      this.timer = null;
      this.botTimer = null;
      this.pending = null; // незнакомое название ждёт решения
      this.over = false;
      const c = R.CAT_BY[cat];
      this.players.forEach((p, i) => {
        p.game = this;
        p.index = i;
        const o = this.players[1 - i];
        send(p.conn, { t: "start", opponent: o.name, oppRating: o.bot ? o.rating : o.profile ? o.profile.rating : undefined, bot: !!o.bot, botLevel: o.bot ? o.level : undefined, first: i === 0, goal: GOAL, cat, catName: c.name, hint: c.hint, seconds: TURN_MS / 1000 });
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
      this.wordsBy[player.index] += 1;
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
      const L = BOT_LEVELS[bot.level] || BOT_LEVELS.medium;
      const d = dicts[this.cat];
      const src = this.letter ? d.byFirst[R.canon(this.letter)] || [] : Object.values(d.byFirst).flat();
      const isNouns = this.cat === "nouns";
      const key = (n) => (isNouns ? n : R.keyOf(n));
      const pool = src.filter((n) => !this.used.has(key(n)));
      if (pool.length === 0 || Math.random() < L.stuck(this.history.length)) return; // «не вспомнил»
      let pick = pool[Math.floor(Math.random() * pool.length)];
      if (L.smart) {
        // Сложный бот выбирает ответ на неудобную букву: где у соперника меньше всего вариантов
        const sample = pool.length > 300 ? Array.from({ length: 300 }, () => pool[Math.floor(Math.random() * pool.length)]) : pool;
        const left = (n) => (d.byFirst[R.canon(R.lastLetter(key(n)))] || []).length;
        sample.sort((a, b) => left(a) - left(b));
        pick = sample[Math.floor(Math.random() * Math.min(3, sample.length))];
      }
      const delay = (L.min + Math.random() * (L.max - L.min)) * BOT_SPEED;
      this.botTimer = setTimeout(() => {
        if (this.over || this.players[this.turn] !== bot) return;
        this.word(bot, pick);
      }, delay);
    }

    // reason: timeout | left | surrender | score
    finish(winnerIndex, reason) {
      if (this.over) return;
      this.over = true;
      clearTimeout(this.timer);
      clearTimeout(this.botTimer);
      if (this.pending) clearTimeout(this.pending.timer);
      // Один и тот же телефон с двух окон — рейтинг не меняем
      const sameDevice = this.players[0].profile && this.players[1].profile && this.players[0].profile.id === this.players[1].profile.id;
      this.players.forEach((p, i) => {
        const win = i === winnerIndex;
        const myWords = this.wordsBy ? this.wordsBy[i] : 0;
        if (!sameDevice && !p.bot && p.profile) {
          const pp = store.get(p.profile.id) || p.profile;
          if (win && this.scores[i] > (pp.best || 0)) { pp.best = this.scores[i]; store.save(pp); p.profile = pp; }
        }
        const r = sameDevice ? null : applyResult(p, win, myWords);
        send(p.conn, { t: "end", win, reason, words: this.history.length, me: this.scores[i], opp: this.scores[1 - i], rating: r ? r.rating : undefined, delta: r ? r.delta : undefined });
        if (p.profile) send(p.conn, { t: "profile", profile: profileView(p.profile) });
        p.game = null;
      });
    }
  }

  function leaveQueue(player) {
    const q = queue.find((x) => x.player === player);
    if (q) clearTimeout(q.botTimer);
    queue = queue.filter((x) => x.player !== player);
  }

  function makeBot(player, level) {
    const L = BOT_LEVELS[level] ? level : "medium";
    const myRating = player.profile ? player.profile.rating : RATING_START;
    const name = "Бот " + BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    return { bot: true, level: L, conn: null, name, rating: Math.max(0, myRating + BOT_LEVELS[L].rating + 25 * Math.round(Math.random() * 2 - 1)), game: null, index: -1 };
  }

  // Игра с ботом выбранного уровня — сразу, без очереди
  function botGame(player, cat, level) {
    leaveQueue(player);
    new Game(player, makeBot(player, level), cat === "random" ? randomCat() : cat);
  }

  // online — только живые игроки, ждём сколько угодно; иначе (старые версии) через 20 с бот
  function findGame(player, cat, online) {
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
    if (!online) {
      entry.botTimer = setTimeout(() => {
        if (!queue.includes(entry)) return;
        botGame(player, cat, "medium");
      }, BOT_AFTER_MS);
    }
    queue.push(entry);
    send(player.conn, { t: "waiting", botIn: online ? 0 : BOT_AFTER_MS / 1000, online: !!online, queue: queue.length });
  }

  return {
    queueSize: () => queue.length,

    // Новое соединение -> объект игрока
    connect(conn) {
      return { conn, name: "Игрок", game: null, index: -1, profile: null };
    },

    message(player, data) {
      let msg;
      try { msg = typeof data === "string" ? JSON.parse(data) : JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "hello") {
        // Профиль без регистрации: id создаёт телефон и хранит у себя
        const id = String(msg.id || "");
        if (!/^[a-f0-9]{16,64}$/.test(id)) return send(player.conn, { t: "error", reason: "bad_id" });
        let p = store.get(id);
        if (!p) p = { id, name: cleanName(msg.name), rating: RATING_START, wins: 0, losses: 0, games: 0, words: 0, best: 0, created: Date.now(), updated: Date.now() };
        if (msg.name) p.name = cleanName(msg.name);
        store.save(p);
        player.profile = p;
        player.name = p.name;
        send(player.conn, { t: "profile", profile: profileView(p) });
      } else if (msg.t === "delete") {
        // Удаление профиля по просьбе игрока: имя, рейтинг и статистика стираются
        const id = String(msg.id || "");
        if (player.profile && player.profile.id === id && store.remove) store.remove(id);
        player.profile = null;
        send(player.conn, { t: "deleted" });
      } else if (msg.t === "top") {
        const list = store.top(50).map((p) => ({ name: p.name, rating: p.rating, wins: p.wins, games: p.games, me: !!player.profile && p.id === player.profile.id }));
        send(player.conn, { t: "top", list, me: profileView(player.profile && store.get(player.profile.id)) });
      } else if (msg.t === "find") {
        if (player.game) return;
        player.name = cleanName(msg.name || player.name);
        if (player.profile && player.profile.name !== player.name) {
          const p = store.get(player.profile.id) || player.profile;
          p.name = player.name; store.save(p); player.profile = p;
        }
        if (msg.mode === "bot") botGame(player, validCat(msg.cat), String(msg.level || ""));
        else findGame(player, validCat(msg.cat), msg.mode === "online");
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

module.exports = { createHub, memoryStore, RATING_START, RATING_STEP, BOT_LEVELS };
