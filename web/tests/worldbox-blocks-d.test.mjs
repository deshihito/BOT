// AGO WORLD BOX 設置物の動作D（看板・棚・井戸と水）のテスト。
// - 看板テキスト: 所有者だけ・整形（制御文字/長さ）・空で消去・parse 往復
// - 棚の展示: 消費して展示・回収で返却・展示中は差し替え不可
// - 井戸と水: バケツ→水入りバケツ、飲むとバケツに戻る（containerReturn）
// - ルートとクライアントの配線（ソース確認）
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

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
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
    out.push(line.replace(/^export\s+/, ""));
  }
  return out.join("\n");
}

function bundleModule(files, names) {
  const code = files.map((name) => stripModuleSyntax(transpile(name))).join("\n");
  return dataUrl(`${code}\nexport { ${names.join(", ")} };`);
}

function loadBundle(files, names) {
  const code = files.map((name) => stripModuleSyntax(transpile(name))).join("\n");
  return new Function(`${code}\nreturn { ${names.join(", ")} };`)();
}

const invUrl = bundleModule(
  ["worldbox/items.ts", "worldbox/profile.ts"],
  ["parseProfile", "countItem", "itemById"],
);
const inv = await import(invUrl);

const tilesUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts"],
  [
    "worldTileSource", "mapTileAt", "T_GRASS",
    "applyPlaceBlock", "applySetSign", "applyDisplayAction", "applyDrawWater",
    "sanitizeSignText", "parseTileOverride", "presenceIdFor",
  ],
);
const T = await import(tilesUrl);

const eco = loadBundle(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/roles.ts", "worldbox/vitals.ts", "worldbox/economy.ts"],
  ["parseProfile", "countItem", "eatItem"],
);

const map = T.worldTileSource();
function findTile(id) {
  for (let y = 0; y < 1024; y++) {
    for (let x = 0; x < 1024; x++) {
      if (T.mapTileAt(map, x, y) === id) return { x, y };
    }
  }
  throw new Error(`tile ${id} not found`);
}
const grassAt = findTile(T.T_GRASS);

const NOW = 1_700_000_000_000;
const ME_KEY = "discord:611111111111111111";
const OTHER_KEY = "discord:622222222222222222";
const NO_CTX = { onCapital: false };
const withItems = (items) => inv.parseProfile({ items });
const place = (profile, at, itemId, key = ME_KEY) =>
  T.applyPlaceBlock(null, profile, map, key, at.x, at.y, itemId, NOW, NO_CTX);

test("看板: 所有者だけが書け、整形され、空で消え、parse を往復する", () => {
  const placed = place(withItems({ sign_board: 1 }), grassAt, "sign_board");
  assert.equal(placed.ok, true);
  const written = T.applySetSign(placed.override, placed.profile, map, ME_KEY, grassAt.x, grassAt.y, "  ようこそ\n店 ", NOW);
  assert.equal(written.ok, true);
  assert.equal(written.override.signText, "ようこそ 店");
  // 他人は書けない
  assert.equal(T.applySetSign(placed.override, placed.profile, map, OTHER_KEY, grassAt.x, grassAt.y, "x", NOW).ok, false);
  // 長すぎる文字は切れる
  const long = T.applySetSign(placed.override, placed.profile, map, ME_KEY, grassAt.x, grassAt.y, "あ".repeat(60), NOW);
  assert.equal([...long.override.signText].length, 40);
  // 空文字で消去
  const cleared = T.applySetSign(written.override, written.profile, map, ME_KEY, grassAt.x, grassAt.y, "  ", NOW);
  assert.equal(cleared.override.signText, undefined);
  // parse の往復
  const parsed = T.parseTileOverride(JSON.stringify(written.override));
  assert.equal(parsed.signText, "ようこそ 店");
  // 看板でないタイルには書けない
  const dirt = place(withItems({ dirt_block: 1 }), grassAt, "dirt_block");
  assert.equal(T.applySetSign(dirt.override, dirt.profile, map, ME_KEY, grassAt.x, grassAt.y, "x", NOW).ok, false);
  assert.equal(T.sanitizeSignText(42), "");
});

test("棚: 展示は消費、回収は返却、展示中は差し替え不可、他人は不可", () => {
  const placed = place(withItems({ item_shelf: 1, bread: 2 }), grassAt, "item_shelf");
  assert.equal(placed.ok, true);
  const shown = T.applyDisplayAction(placed.override, placed.profile, map, ME_KEY, grassAt.x, grassAt.y, "set_display", "bread", NOW);
  assert.equal(shown.ok, true);
  assert.equal(shown.override.display, "bread");
  assert.equal(inv.countItem(shown.profile, "bread"), 1);
  // 展示中は差し替え不可
  assert.equal(T.applyDisplayAction(shown.override, shown.profile, map, ME_KEY, grassAt.x, grassAt.y, "set_display", "bread", NOW).ok, false);
  // 他人は回収できない
  assert.equal(T.applyDisplayAction(shown.override, shown.profile, map, OTHER_KEY, grassAt.x, grassAt.y, "clear_display", undefined, NOW).ok, false);
  // 回収で戻る
  const back = T.applyDisplayAction(shown.override, shown.profile, map, ME_KEY, grassAt.x, grassAt.y, "clear_display", undefined, NOW);
  assert.equal(back.ok, true);
  assert.equal(back.override.display, undefined);
  assert.equal(inv.countItem(back.profile, "bread"), 2);
  // parse の往復
  assert.equal(T.parseTileOverride(JSON.stringify(shown.override)).display, "bread");
});

test("井戸と水: バケツで汲め、飲むとバケツに戻る", () => {
  const placed = place(withItems({ well: 1 }), grassAt, "well");
  assert.equal(placed.ok, true);
  // バケツが無ければ汲めない
  assert.equal(T.applyDrawWater(placed.override, placed.profile, map, ME_KEY, grassAt.x, grassAt.y, NOW).ok, false);
  const withBucket = inv.parseProfile({ items: { bucket: 1 } });
  const drawn = T.applyDrawWater(placed.override, withBucket, map, ME_KEY, grassAt.x, grassAt.y, NOW);
  assert.equal(drawn.ok, true);
  assert.equal(inv.countItem(drawn.profile, "bucket"), 0);
  assert.equal(inv.countItem(drawn.profile, "water_bucket"), 1);
  // 飲む（空腹が満タンでない状態で）とバケツが戻る
  const hungry = { ...drawn.profile, hunger: 10 };
  const drank = eco.eatItem(hungry, "water_bucket", NOW);
  assert.equal(drank.ok, true);
  assert.equal(eco.countItem(drank.profile, "water_bucket"), 0);
  assert.equal(eco.countItem(drank.profile, "bucket"), 1);
  // 水入りバケツは売却リスト（ショップ）に入っていない想定の価格であること
  assert.ok(inv.itemById("water_bucket").price <= 100);
});

test("屋台: 出品の検証と売れた後の残数、parse の往復", async () => {
  const stallsUrl = bundleModule(
    ["worldbox/items.ts", "worldbox/stalls.ts"],
    ["parseStall", "serializeStall", "stallAfterSale", "validStallPrice", "validStallCount", "isStallItem"],
  );
  const S = await import(stallsUrl);
  assert.equal(S.isStallItem("market_stall"), true);
  assert.equal(S.validStallPrice(0), null);
  assert.equal(S.validStallPrice(100), 100);
  assert.equal(S.validStallPrice(1_000_001), null);
  assert.equal(S.validStallCount(0), null);
  assert.equal(S.validStallCount(99), 99);
  const state = { ownerKey: ME_KEY, itemId: "bread", price: 300, count: 2 };
  const parsed = S.parseStall(S.serializeStall(state));
  assert.deepEqual(parsed, state);
  assert.equal(S.parseStall(JSON.stringify({ ...state, itemId: "nope" })), null);
  assert.equal(S.parseStall("{"), null);
  assert.deepEqual(S.stallAfterSale(state), { ...state, count: 1 });
  assert.equal(S.stallAfterSale({ ...state, count: 1 }), null);
});

test("配線: ルートの分岐とクライアントの看板/棚/井戸/屋台", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/tiles/route.ts"), "utf8");
  assert.match(route, /applySetSign/);
  assert.match(route, /applyDisplayAction/);
  assert.match(route, /applyDrawWater/);
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /signEdit/);
  assert.match(client, /set_display/);
  assert.match(client, /draw_water/);
  assert.match(client, /signText/);
  assert.match(client, /postStallAction/);
  assert.match(client, /\/api\/worldbox\/stalls/);
  const stallsRoute = fs.readFileSync(path.join(rootDir, "app/api/worldbox/stalls/route.ts"), "utf8");
  assert.match(stallsRoute, /kind: "transfer"/);
  assert.match(stallsRoute, /readUserBalance/);
  // 出品中の屋台はタイルルートで掘れない
  assert.match(route, /loadStall/);
});
