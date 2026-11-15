// AGO WORLD BOX ショップのジャンル分けの検証:
// - ジャンル定義: 全アイテムカテゴリがちょうど1ジャンルに割り当たる
// - 全アイテムがどこかの店で買える（itemsForGenre の和集合 = 全カタログ）
// - ロビーの全 shop オブジェクトに genre が付き、5ジャンルが揃う
// - カウンター前のタイルから stationGenreNear で店のジャンルが引ける
// - 購入のジャンル検証（純粋関数 checkBuyGenre: 不一致は wrong_shop）
// - 配線: クライアントが genre を経済パネルへ渡し、パネルは品目を選別し、
//   API はサーバー側で genre を検証する
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

const shops = await loadBundle(
  ["worldbox/items.ts", "worldbox/shops.ts"],
  ["ITEMS", "SHOP_GENRES", "genreById", "genreForCategory", "genreOfItem", "itemsForGenre", "checkBuyGenre"],
);
const wb = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/lobby.ts"],
  ["LOBBY_OBJECTS", "stationNear", "stationGenreNear"],
);

const ALL_CATEGORIES = ["block", "crafted", "crop", "food", "furniture", "material", "seed", "special", "tool"];

test("shops: 全カテゴリがちょうど1ジャンルに割り当たる", () => {
  const assigned = shops.SHOP_GENRES.flatMap((g) => g.categories);
  assert.deepEqual([...assigned].sort(), ALL_CATEGORIES, "カテゴリの割当てが全カテゴリと一致しない");
  assert.equal(new Set(assigned).size, assigned.length, "同じカテゴリが複数ジャンルに割り当たっている");
  for (const category of ALL_CATEGORIES) {
    assert.ok(shops.genreForCategory(category), `${category} のジャンルが無い`);
  }
});

test("shops: ジャンル定義は想定の6種（鍛冶屋含む）", () => {
  assert.deepEqual(
    shops.SHOP_GENRES.map((g) => [g.id, g.name]),
    [
      ["tools", "道具屋"],
      ["blocks", "建築屋"],
      ["furniture", "家具屋"],
      ["food", "食料屋"],
      ["farm", "種・素材屋"],
      ["smith", "鍛冶屋"],
    ],
  );
  assert.equal(shops.genreById("tools")?.name, "道具屋");
  assert.equal(shops.genreById("nope"), null);
  assert.equal(shops.genreById(null), null);
});

test("shops: 全アイテムがどこかの店で買える", () => {
  const buyable = shops.SHOP_GENRES.flatMap((g) => shops.itemsForGenre(g.id));
  assert.equal(buyable.length, shops.ITEMS.length, "どの店でも買えないアイテムがある");
  for (const item of shops.ITEMS) {
    assert.ok(shops.genreOfItem(item.id), `${item.id} のジャンルが無い`);
  }
  // 代表例: 木材は種・素材屋、斧は道具屋、合成品は鍛冶屋
  assert.equal(shops.genreOfItem("wood"), "farm");
  assert.equal(shops.genreOfItem("wooden_axe"), "tools");
  assert.equal(shops.genreOfItem("carving"), "smith");
  assert.equal(shops.genreOfItem("no-such-item"), null);
});

test("shops: checkBuyGenre はジャンル不一致を wrong_shop にする", () => {
  assert.equal(shops.checkBuyGenre("tools", "wood"), "wrong_shop"); // 素材は道具屋で買えない
  assert.equal(shops.checkBuyGenre("farm", "wood"), null);
  assert.equal(shops.checkBuyGenre("smith", "carving"), null);
  assert.equal(shops.checkBuyGenre("smith", "wooden_axe"), "wrong_shop");
  // 店がジャンルを持たなければ制限しない／未知のアイテムは buyItem 側に委ねる
  assert.equal(shops.checkBuyGenre(null, "wood"), null);
  assert.equal(shops.checkBuyGenre("tools", "no-such-item"), null);
});

test("lobby: 全 shop オブジェクトに genre が付き、5ジャンルが揃う", () => {
  const shopObjects = wb.LOBBY_OBJECTS.filter((o) => o.station === "shop");
  assert.ok(shopObjects.length > 0);
  for (const o of shopObjects) {
    assert.ok(o.genre, `genre が無い shop オブジェクト: ${o.sprite} @${o.x},${o.y}`);
  }
  const genres = new Set(shopObjects.map((o) => o.genre));
  assert.deepEqual([...genres].sort(), ["blocks", "farm", "food", "furniture", "tools"]);
});

test("lobby: カウンター前のタイルから店のジャンルが引ける", () => {
  const cases = [
    ["tools", 5, 21], // 道具屋カウンター（y=20, x=4-6）の前
    ["blocks", 9, 21], // 建築屋カウンター（y=20, x=8-10）の前
    ["furniture", 13, 21], // 家具屋カウンター（y=20, x=12-14）の前
    ["food", 5, 26], // 食料屋カウンター（y=27, x=4-6）の前
    ["farm", 13, 26], // 種・素材屋カウンター（y=27, x=12-14）の前
  ];
  for (const [genre, x, y] of cases) {
    assert.equal(wb.stationNear(wb.LOBBY_OBJECTS, x, y), "shop", `${genre} の前が shop でない`);
    assert.equal(wb.stationGenreNear(wb.LOBBY_OBJECTS, x, y), genre, `${genre} が引けない`);
  }
  // 店から離れた場所・鍛冶屋ではジャンルは引けない（鍛冶屋は station から決まる）
  assert.equal(wb.stationGenreNear(wb.LOBBY_OBJECTS, 28, 28), null);
  assert.equal(wb.stationGenreNear(wb.LOBBY_OBJECTS, 28, 37), null);
});

test("配線: クライアントが genre を経済パネルへ渡し、API がサーバー検証する", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("stationGenreNear"), "クライアントが店のジャンルを引いていない");
  assert.ok(client.includes("genre={stationGenre}"), "経済パネルへ genre を渡していない");
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"), "utf8");
  assert.ok(panel.includes("itemsForGenre"), "パネルが品目を選別していない");
  assert.ok(panel.includes("wrong_shop"), "パネルに wrong_shop のラベルが無い");
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/profile/route.ts"), "utf8");
  assert.match(route, /loadMyLobbyShopGenre/);
  assert.match(route, /checkBuyGenre/);
  assert.match(route, /wrong_shop|genreError/);
  const stationOnline = fs.readFileSync(path.join(libDir, "worldbox/station-online.ts"), "utf8");
  assert.match(stationOnline, /loadMyLobbyShopGenre/);
  assert.match(stationOnline, /stationGenreNear/);
});
