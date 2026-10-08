// Готовит src/ к выкладке: копирует общую логику из ../server и упаковывает словари в код.
// Запускать после изменения правил или словарей: node prepare.js
const fs = require("fs");
const path = require("path");
const srv = path.join(__dirname, "..", "server");
const out = path.join(__dirname, "src");

for (const f of ["rules.js", "core.js"]) fs.copyFileSync(path.join(srv, f), path.join(out, f));

const R = require(path.join(srv, "rules.js"));
const data = {}, keys = {};
for (const f of fs.readdirSync(path.join(srv, "data")).filter((f) => f.endsWith(".txt")).sort()) {
  const lines = fs.readFileSync(path.join(srv, "data", f), "utf8").split("\n").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  const name = f.replace(/\.txt$/, "");
  data[name] = lines.join("\n");
  if (name !== "nouns") keys[name] = lines.map((l) => R.keyOf(l)).join("\n");
}
fs.writeFileSync(path.join(out, "data.js"), "// Создано prepare.js — не править вручную\nmodule.exports = " + JSON.stringify({ data, keys }) + ";\n");
console.log("src/ готов:", Object.keys(data).length, "словарей,", fs.statSync(path.join(out, "data.js")).size, "байт");
