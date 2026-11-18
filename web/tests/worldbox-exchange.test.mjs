// AGO WORLD BOX 取引所の検証:
// - 価格は決定的（同じティックで同価格）で、範囲 30〜300 に収まる
// - buyToken / sellToken の遷移（残高不足・所持不足・通常売却の拒否）
// - ロビーに station "exchange" のカウンターが置かれ、隣で station が返る
// - アゴトークンのカタログとアイコンの配線
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

const ex = await loadBundle(
  ["worldbox/exchange.ts"],
  ["TOKEN_TICK_MS", "TOKEN_MIN_PRICE", "TOKEN_MAX_PRICE", "tokenTickOf", "tokenPriceAtTick", "tokenPriceAt", "tokenNextTickAt", "tokenPriceHistory"],
);
const eco = await loadBundle(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/vitals.ts", "worldbox/economy.ts"],
  ["buyToken", "sellToken", "sellItem", "itemById", "ITEM_ICON_IDS", "parseProfile"],
);
const lob = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/lobby.ts"],
  ["buildLobby", "stationNear", "EXCHANGE_HALL"],
);

test("価格: 決定的で範囲内に収まり、ティック境界でだけ変わる", () => {
  const now = 1_700_000_000_000;
  assert.equal(ex.tokenPriceAt(now), ex.tokenPriceAt(now + 60_000), "同じティック内は同価格");
  assert.equal(ex.tokenTickOf(now), Math.floor(now / ex.TOKEN_TICK_MS));
  assert.equal(ex.tokenNextTickAt(now), (ex.tokenTickOf(now) + 1) * ex.TOKEN_TICK_MS);
  for (let tick = 0; tick < 20000; tick += 7) {
    const p = ex.tokenPriceAtTick(tick);
    assert.ok(Number.isInteger(p) && p >= ex.TOKEN_MIN_PRICE && p <= ex.TOKEN_MAX_PRICE, `tick=${tick} price=${p}`);
  }
  // 価格は実際に動く（全ティック同価格ではない）
  const prices = new Set();
  for (let tick = 0; tick < 500; tick++) prices.add(ex.tokenPriceAtTick(tick));
  assert.ok(prices.size > 50, `variety=${prices.size}`);
});

test("価格: 履歴は古い順で最後が現在価格", () => {
  const now = 1_700_000_000_000;
  const history = ex.tokenPriceHistory(now, 24);
  assert.equal(history.length, 24);
  assert.equal(history[23].price, ex.tokenPriceAt(now));
  assert.equal(history[23].tick, ex.tokenTickOf(now));
  for (let i = 1; i < history.length; i++) assert.equal(history[i].tick, history[i - 1].tick + 1);
});

test("カタログ: アゴトークンがあり、アイコンも登録されている", () => {
  const def = eco.itemById("ago_token");
  assert.ok(def);
  assert.equal(def.name, "アゴトークン");
  assert.ok(eco.ITEM_ICON_IDS.includes("ago_token"));
  assert.ok(fs.existsSync(path.join(rootDir, "public/img/worldbox/items/ago_token.png")));
});

test("buyToken: 残高が足りれば spend(token_buy) でトークンが増える", () => {
  const profile = eco.parseProfile({ items: {} });
  const ok = eco.buyToken(profile, 3, 120, 1000);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.coin, { kind: "spend", amount: 360, reason: "token_buy" });
  assert.equal(ok.profile.items.ago_token, 3);
  const poor = eco.buyToken(profile, 3, 120, 359);
  assert.equal(poor.ok, false);
  assert.equal(poor.error, "not_enough_coins");
  const bad = eco.buyToken(profile, 0, 120, 1000);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "invalid_count");
});

test("sellToken: earn(token_sell) でトークンが減り、通常売却では売れない", () => {
  const profile = eco.parseProfile({ items: { ago_token: 5 } });
  const ok = eco.sellToken(profile, 2, 150);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.coin, { kind: "earn", amount: 300, reason: "token_sell" });
  assert.equal(ok.profile.items.ago_token, 3);
  const lack = eco.sellToken(profile, 6, 150);
  assert.equal(lack.ok, false);
  assert.equal(lack.error, "not_enough_items");
  // 売却カウンター（固定6割）では売れない（市場価格との差で増殖するため）
  const viaCounter = eco.sellItem(profile, "ago_token", 1);
  assert.equal(viaCounter.ok, false);
  assert.equal(viaCounter.error, "not_sellable");
});

test("ロビー: 取引所はカジノ翼の南の別室（ホール）にあり、隣で station が返る", () => {
  const lobby = lob.buildLobby();
  const counters = lobby.objects.filter((o) => o.station === "exchange");
  assert.equal(counters.length, 8);
  assert.ok(counters.every((o) => o.y === 35 && o.x >= 40 && o.x <= 47));
  assert.equal(lob.stationNear(lobby.objects, 43, 36), "exchange");
  assert.equal(lob.stationNear(lobby.objects, 40, 36), "exchange");
  // ホールは外形に含まれ、通路（カジノ翼の南）から歩いて入れる
  assert.ok(lob.EXCHANGE_HALL.x1 - lob.EXCHANGE_HALL.x0 >= 15);
  assert.notEqual(lobby.tiles[40 * lobby.width + 45], 0); // ホール中央は床
  assert.notEqual(lobby.tiles[31 * lobby.width + 45], 0); // 通路も床
  // 旧・広場のカウンター位置にはもう取引所はない
  assert.equal(lob.stationNear(lobby.objects, 35, 20), null);
});

test("クライアント配線: パネルに取引所タブ、チップに取引所ラベルがある", () => {
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"), "utf8");
  assert.ok(panel.includes('tabBtn("exchange", "取引所")'));
  assert.ok(panel.includes('"token_buy"') && panel.includes('"token_sell"'));
  assert.ok(panel.includes("/api/worldbox/exchange"));
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes('exchange: "取引所"'));
});
