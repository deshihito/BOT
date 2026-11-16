// AGO WORLD BOX ショップのジャンル分けの検証:
// - ジャンル定義: 全アイテムカテゴリがちょうど1ジャンルに割り当たる
// - 販売は入口だけのホワイトリスト86品のみ（種カテゴリ全種＋明示60品）。
//   itemsForGenre の和集合 = ホワイトリストちょうど
// - 購入の在庫検証（純粋関数 checkBuySold: リスト外は not_sold）
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
  ["ITEMS", "SHOP_GENRES", "genreById", "genreForCategory", "genreOfItem", "itemsForGenre", "checkBuyGenre", "isShopExcluded", "checkBuySold"],
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

// 店で売る品目（ユーザー決定 2026-11-16、案C）: 入口だけのホワイトリスト86品
// = 種カテゴリ全26種 ＋ ジャンル別の明示60品。鍛冶屋ジャンルは販売ゼロ。
const STOCK_IDS = [
  // 種（カテゴリで一括許可されるが、集合の検証用に全種挙げる）
  "wheat_seed", "carrot_seed", "potato_seed", "cabbage_seed", "strawberry_seed",
  "tomato_seed", "corn_seed", "rice_seed", "pumpkin_seed", "melon_seed",
  "onion_seed", "soybean_seed", "cucumber_seed", "eggplant_seed", "sweet_potato_seed",
  "pepper_seed", "grape_seed", "turnip_seed", "chili_seed", "lettuce_seed",
  "radish_seed", "spinach_seed", "daikon_seed", "apple_seed", "peach_seed", "cotton_seed",
  // 道具屋
  "wooden_axe", "wooden_pickaxe", "wooden_sword", "wooden_hoe",
  "stone_axe", "stone_pickaxe", "stone_sword", "stone_hoe",
  "iron_axe", "iron_pickaxe", "iron_sword", "iron_hoe", "explorer_compass",
  // 建築屋
  "dirt_block", "sand_block", "snow_block", "mud_block", "grass_block",
  "gravel_block", "moss_block", "clay_block", "packed_snow_block", "ice_block",
  "leaves_block", "path_block", "forest_floor_block", "cactus_block", "flower_block",
  "oak_log", "pine_log", "birch_log", "sakura_log", "dark_log",
  "autumn_log", "dead_log", "log_block",
  // 家具屋
  "torch", "workbench", "furnace", "storage_chest", "chest_box", "bed",
  // 食料屋
  "onigiri", "energy_drink", "meal", "cake", "bento", "feast",
  // 種・素材屋の基礎素材
  "wood", "stone", "stick", "clay", "glass", "paper", "bamboo", "charcoal",
  "sugar", "iron_ingot", "copper_ingot", "salt",
];

test("shops: 販売ホワイトリストはちょうど86品", () => {
  assert.equal(STOCK_IDS.length, 86);
  assert.equal(new Set(STOCK_IDS).size, 86, "ホワイトリストに重複がある");
  const buyable = shops.ITEMS.filter((item) => !shops.isShopExcluded(item)).map((item) => item.id);
  assert.deepEqual([...buyable].sort(), [...STOCK_IDS].sort());
  // リスト外の代表例: 合成品・調理済み・作物・宝石/貴金属・鉱石ブロック・採取素材・特殊
  for (const id of ["carving", "potion", "gem_ring", "bread", "carrot", "wheat", "ruby", "diamond", "mithril", "diamond_ore_block", "mithril_block", "herb", "cloth", "piano", "auto_harvester", "star_shard", "mithril_axe", "diamond_block"]) {
    const item = shops.ITEMS.find((i) => i.id === id);
    assert.ok(item, `${id} がカタログに無い`);
    assert.equal(shops.isShopExcluded(item), true, `${id} が販売されている`);
  }
  // 鍛冶屋ジャンルは販売品目ゼロ（合成・強化専用の施設）
  assert.deepEqual(shops.itemsForGenre("smith"), []);
});

test("shops: 買えるのはホワイトリストの品目だけ", () => {
  const buyable = shops.SHOP_GENRES.flatMap((g) => shops.itemsForGenre(g.id));
  assert.equal(buyable.length, STOCK_IDS.length, "ホワイトリスト外の品目が買える／内の品目が買えない");
  assert.deepEqual(buyable.map((i) => i.id).sort(), [...STOCK_IDS].sort());
  for (const item of shops.ITEMS) {
    assert.ok(shops.genreOfItem(item.id), `${item.id} のジャンルが無い`);
    // どのジャンルの品目にもリスト外は含まれない
    for (const g of shops.SHOP_GENRES) {
      assert.ok(!shops.itemsForGenre(g.id).some((i) => i.id === item.id && shops.isShopExcluded(i)), `${item.id} が ${g.id} の品目に残っている`);
    }
  }
  // 代表例: 木材は種・素材屋、斧は道具屋、合成品は鍛冶屋
  assert.equal(shops.genreOfItem("wood"), "farm");
  assert.equal(shops.genreOfItem("wooden_axe"), "tools");
  assert.equal(shops.genreOfItem("carving"), "smith");
  assert.equal(shops.genreOfItem("no-such-item"), null);
  // ジャンル割当て自体は不変（リスト外もカテゴリ上のジャンルは持つ）
  assert.equal(shops.genreOfItem("star_shard"), "smith");
  assert.equal(shops.genreOfItem("mithril_axe"), "tools");
  assert.equal(shops.genreOfItem("diamond_block"), "blocks");
});

test("shops: checkBuySold はホワイトリスト外を not_sold にする", () => {
  assert.equal(shops.checkBuySold("star_shard"), "not_sold"); // 特殊
  assert.equal(shops.checkBuySold("mithril_sword"), "not_sold"); // tier 4
  assert.equal(shops.checkBuySold("ruby_block"), "not_sold"); // 宝石ブロック
  assert.equal(shops.checkBuySold("ruby"), "not_sold"); // 宝石の素材も売らない
  assert.equal(shops.checkBuySold("diamond_ore_block"), "not_sold"); // 鉱石ブロックも売らない
  assert.equal(shops.checkBuySold("carving"), "not_sold"); // 合成品は作るもの
  assert.equal(shops.checkBuySold("wood"), null);
  assert.equal(shops.checkBuySold("wheat_seed"), null); // 種は全種売る
  assert.equal(shops.checkBuySold("iron_sword"), null);
  // 未知のアイテムは buyItem 側の unknown_item に委ねる
  assert.equal(shops.checkBuySold("no-such-item"), null);
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
  assert.ok(panel.includes("isShopExcluded"), "パネルが全品目フォールバック側でレア品を除外していない");
  assert.ok(panel.includes("not_sold"), "パネルに not_sold のラベルが無い");
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/profile/route.ts"), "utf8");
  assert.match(route, /loadMyLobbyShopGenre/);
  assert.match(route, /checkBuyGenre/);
  assert.match(route, /wrong_shop|genreError/);
  assert.match(route, /checkBuySold/);
  assert.match(route, /not_sold|soldError/);
  const stationOnline = fs.readFileSync(path.join(libDir, "worldbox/station-online.ts"), "utf8");
  assert.match(stationOnline, /loadMyLobbyShopGenre/);
  assert.match(stationOnline, /stationGenreNear/);
});
