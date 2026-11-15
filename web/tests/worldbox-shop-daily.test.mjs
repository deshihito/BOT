// WORLD BOX バッチ7a: ユニオン戦争・日次ローテーション・戦争採掘の純粋ロジックテスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");

function transpile(name, base = libDir) {
  const src = fs.readFileSync(path.join(base, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function stripModuleSyntax(code) {
  const lines = code.split("\n");
  const out = [];
  let skippingImport = false;
  for (const line of lines) {
    if (skippingImport) {
      if (line.includes(";")) skippingImport = false;
      continue;
    }
    if (/^import\s/.test(line)) {
      if (!line.includes(";")) skippingImport = true;
      continue;
    }
    out.push(
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    );
  }
  return out.join("\n");
}

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import(dataUrl(code));
}


const S = await loadBundle(
  ["worldbox/items.ts", "worldbox/shops.ts"],
  ["shopDayKeyOf", "dailyPriceFor", "dailyStockForGenre", "checkDailyStock", "itemsForGenre", "itemById"],
);

test("shops: daily price is deterministic and within ±10%", () => {
  const item = S.itemById("wooden_axe");
  const day = "2026-11-16";
  const p1 = S.dailyPriceFor(item, day);
  assert.equal(p1, S.dailyPriceFor(item, day));
  assert.ok(p1 >= Math.floor(item.price * 0.9) - 1 && p1 <= Math.ceil(item.price * 1.1) + 1);
  const prices = new Set(
    ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"].map((d) => S.dailyPriceFor(item, d)),
  );
  assert.ok(prices.size >= 2);
});

test("shops: daily stock rotates but stays within the genre list", () => {
  const day = "2026-11-16";
  const all = S.itemsForGenre("tools");
  const stock = S.dailyStockForGenre("tools", day);
  assert.deepEqual(S.dailyStockForGenre("tools", day), stock);
  assert.ok(stock.length <= all.length);
  for (const item of stock) assert.ok(all.some((a) => a.id === item.id));
  if (all.length > 8) assert.ok(stock.length < all.length);
  assert.equal(S.checkDailyStock("tools", stock[0].id, day), null);
  const missing = all.find((a) => !stock.some((s) => s.id === a.id));
  if (missing) assert.equal(S.checkDailyStock("tools", missing.id, day), "not_sold");
  assert.equal(S.checkDailyStock(null, "anything", day), null);
});
