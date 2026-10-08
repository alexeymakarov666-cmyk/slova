// Правила «Слов»: категории, словари, буквы, очки. Общие для сервера и тестов.

const CATS = [
  { id: "nouns", name: "Существительные", hint: "Любое существительное", src: [] },
  { id: "music", name: "Музыка", hint: "Любой исполнитель или группа", src: ["music"] },
  { id: "toons", name: "Мультфильмы и аниме", hint: "Любой мультфильм или аниме", src: ["cartoons", "anime"] },
  { id: "films", name: "Фильмы и сериалы", hint: "Любой фильм или сериал", src: ["films"] },
  { id: "anime", name: "Аниме", hint: "Любое аниме", src: ["anime"] },
  { id: "places", name: "Города и страны", hint: "Любой город или страна", src: ["places"] },
  { id: "chars", name: "Персонажи", hint: "Любой персонаж", src: ["characters"] },
  { id: "ill", name: "Болезни", hint: "Любая болезнь", src: ["diseases"] },
];
const CAT_BY = Object.fromEntries(CATS.map((c) => [c.id, c]));

const TIERS = [[5, 100], [10, 70], [20, 50], [Infinity, 20]];
const pointsFor = (sec) => TIERS.find(([t]) => sec < t)[1];

// Ключ для сравнения: строчные, ё→е, без диакритики (кроме й), только буквы и цифры
function keyOf(s) {
  return String(s).toLowerCase().replace(/ё/g, "е").replace(/й/g, "\u0001")
    .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\u0001/g, "й")
    .replace(/[^a-z0-9а-я]/g, "");
}
const LAT = { a: "а", b: "б", c: "к", d: "д", e: "е", f: "ф", g: "г", h: "х", i: "и", j: "д", k: "к", l: "л", m: "м", n: "н", o: "о", p: "п", q: "к", r: "р", s: "с", t: "т", u: "у", v: "в", w: "в", x: "к", y: "и", z: "з" };
const toRu = (ch) => LAT[ch] || ch;
const isLetter = (ch) => /[a-zа-я]/.test(ch);
const canon = (x) => ({ "э": "е", "й": "и" })[x] || x;
const same = (a, b) => canon(a) === canon(b);
function firstLetter(k) { for (const ch of k) if (isLetter(ch)) return toRu(ch); return ""; }
function lastLetter(k) {
  for (let i = k.length - 1; i >= 0; i--) if (isLetter(k[i]) && !"ьъы".includes(k[i])) return toRu(k[i]);
  for (let i = k.length - 1; i >= 0; i--) if (isLetter(k[i])) return toRu(k[i]);
  return "";
}

// Словари: ключ -> как показывать; плюс группировка по первой букве для бота.
// read(name) возвращает массив строк файла data/<name>.txt (или [] если нет).
// readKeys(name) — необязательно: заранее посчитанные ключи для тех же строк (ускоряет запуск).
// Без случайностей и файлов — работает и в Node, и в Cloudflare.
const DICTS = {};
function buildDicts(read, readKeys) {
  const pairs = (name) => {
    const names = read(name), keys = readKeys ? readKeys(name) : null;
    return names.map((n, i) => [keys && keys.length === names.length ? keys[i] : keyOf(n), n]);
  };
  for (const c of CATS) {
    const map = new Map();
    if (c.id === "nouns") for (const w of read("nouns")) map.set(w, w);
    else for (const s of c.src) for (const [k, n] of [...pairs(s), ...pairs(s + "_latin")]) {
      if (k && firstLetter(k) && !map.has(k)) map.set(k, n);
    }
    const byFirst = {};
    let latin = 0;
    for (const [k, n] of map) {
      if (c.id === "nouns" && (k.length < 3 || k.length > 7)) continue;
      if (c.id !== "nouns" && !/[а-я]/i.test(n) && latin++ % 7 !== 0) continue; // бот чаще пишет по-русски
      (byFirst[canon(firstLetter(k))] ||= []).push(n);
    }
    DICTS[c.id] = { map, byFirst };
  }
  return DICTS;
}

// Проверка ответа. Возвращает {err} или {k, w, unknown}
function check(cat, raw, letter, used) {
  const w = String(raw || "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (!w) return { err: "Введите ответ" };
  if (cat === "nouns") {
    const k = w.toLowerCase().replace(/ё/g, "е");
    if (!/^[а-я]+$/.test(k)) return { err: "Только русские буквы, одно слово" };
    if (letter && !same(k[0], letter)) return { err: `Нужно слово на «${letter.toUpperCase()}»` };
    if (used.has(k)) return { err: "Это слово уже было" };
    if (!DICTS.nouns.map.has(k)) return { err: "Нет такого существительного в словаре" };
    return { k, w: k };
  }
  const k = keyOf(w);
  if (!firstLetter(k)) return { err: "Нужны буквы" };
  if (letter && !same(firstLetter(k), letter)) return { err: `Нужно название на «${letter.toUpperCase()}»` };
  if (used.has(k)) return { err: "Это уже называли" };
  const known = DICTS[cat].map.get(k);
  if (known) return { k, w: known };
  return { k, w, unknown: true };
}

module.exports = { CATS, CAT_BY, pointsFor, keyOf, firstLetter, lastLetter, same, canon, buildDicts, check, DICTS };
