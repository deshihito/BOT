// AGO WORLD BOX アイテム基盤の検証:
// - カタログの物量（250種以上・ブロック60種以上は耐久つき・道具4種×4段・作物22種）
// - インベントリ（ホットバー5枠＋ストレージ10枠、旧かばんからの無損失移行、
//   注ぐ順・引き出し順・枠入れ替え）
// - タイル行為（伐採/採掘/耕作/作付け/収穫の検証、木の再生、所有者収穫）
// - タイル API（認証・隣接検証・範囲つき GET）
// - クライアント配線（ホットバー・ストレージ・種ピッカー・農業スプライト）
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

const invUrl = bundleModule(
  ["worldbox/items.ts", "worldbox/profile.ts"],
  [
    "ITEMS", "itemById", "CROPS", "cropById", "cropBySeedId", "itemsWithTool",
    "parseProfile", "serializeProfile", "countItem", "addItem", "removeItem",
    "swapSlots", "overflowCount", "HOTBAR_SLOTS", "STORAGE_SLOTS", "STACK_MAX",
  ],
);
const inv = await import(invUrl);

const tilesUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts"],
  [
    "worldTileSource", "mapTileAt", "T_GRASS", "T_TREE", "T_ROCK", "T_DIRT", "T_SNOW", "T_SNOW_TREE",
    "parseProfile", "addItem", "countItem",
    "applyTileAction", "applyPlaceBlock", "applyMineBlock", "applyFlowerAction", "applyToggleGate", "tileView", "actionForTile", "tileKey",
    "applySetSign", "applyDisplayAction", "applyDrawWater",
    "tileIvsAt", "fertilityGrowthFactor", "fertilityBonusYield", "purityBonusStone", "purityBonusCoal",
    "parseTileOverride", "parseTileOverrides", "isOverrideActive", "TREE_REGROW_MS",
    "TERRAIN_ROCK_HP", "TERRAIN_TREE_HP",
  ],
);
const T = await import(tilesUrl);

const mapgenUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts"],
  ["worldTileSource", "WORLD_COORD_LIMIT"],
);

// ---------- カタログ ----------

test("カタログ: 120種以上・ID一意・価格が正", () => {
  assert.ok(inv.ITEMS.length >= 320, `items=${inv.ITEMS.length}`);
  const ids = new Set(inv.ITEMS.map((i) => i.id));
  assert.equal(ids.size, inv.ITEMS.length);
  for (const item of inv.ITEMS) assert.ok(item.price > 0, item.id);
});

test("カタログ: ブロックは30種以上で全て耐久を持ち、硬さに幅がある", () => {
  const blocks = inv.ITEMS.filter((i) => i.category === "block");
  assert.ok(blocks.length >= 70, `blocks=${blocks.length}`);
  for (const b of blocks) assert.ok(typeof b.durability === "number" && b.durability > 0, b.id);
  const hardest = blocks.reduce((a, b) => (a.durability >= b.durability ? a : b));
  assert.equal(hardest.id, "bedrock_block");
  const softest = blocks.reduce((a, b) => (a.durability <= b.durability ? a : b));
  assert.ok(softest.durability < hardest.durability / 10);
});

test("カタログ: 道具は4種×4段（木・石・鉄・ミスリル）", () => {
  for (const kind of ["axe", "pickaxe", "sword", "hoe"]) {
    const tools = inv.itemsWithTool(kind);
    assert.equal(tools.length, 4, kind);
    assert.deepEqual(tools.map((t) => t.tier), [1, 2, 3, 4], kind);
    for (const t of tools) assert.equal(t.category, "tool");
  }
});

test("カタログ: 作物は10種以上で種・収穫物・成長時間が揃う", () => {
  assert.ok(inv.CROPS.length >= 25, `crops=${inv.CROPS.length}`);
  for (const crop of inv.CROPS) {
    const seed = inv.itemById(crop.seedId);
    assert.ok(seed, crop.id);
    assert.equal(seed.category, "seed", crop.id);
    assert.ok(inv.itemById(crop.produceId), crop.id);
    assert.ok(crop.growthMinutes > 0, crop.id);
    assert.ok(crop.produceCount >= 1, crop.id);
    assert.equal(inv.cropBySeedId(crop.seedId)?.id, crop.id);
    assert.equal(inv.cropById(crop.id)?.seedId, crop.seedId);
  }
});

test("カタログ: 家具は10種以上（ロビーの調度と同系統）", () => {
  const furniture = inv.ITEMS.filter((i) => i.category === "furniture");
  assert.ok(furniture.length >= 10, `furniture=${furniture.length}`);
  for (const name of ["bench", "sofa", "bookshelf", "lamp", "planter"]) {
    assert.ok(inv.itemById(name), name);
  }
});

// ---------- インベントリ ----------

const slotSum = (slots) => slots.reduce((n, s) => n + (s ? s.count : 0), 0);

test("インベントリ: 旧かばんは枠へ注がれて移行する（総数は不変）", () => {
  const p = inv.parseProfile(JSON.stringify({ coins: 0, hunger: 80, items: { wood: 250, stone: 3 } }));
  assert.equal(inv.countItem(p, "wood"), 250);
  assert.equal(slotSum(p.hotbar), 253, "木材250＋石3がホットバーに収まる");
  assert.equal(p.hotbar[0].count, inv.STACK_MAX);
  assert.equal(p.hotbar[2].count, 52);
  assert.equal(inv.countItem(p, "stone"), 3);
  // 往復しても形が保たれる
  const again = inv.parseProfile(inv.serializeProfile(p));
  assert.equal(inv.countItem(again, "wood"), 250);
  assert.deepEqual(again.hotbar, p.hotbar);
});

test("インベントリ: 枠に入りきらない分はあふれ分として無損失に残る", () => {
  const p = inv.parseProfile({ items: { wood: 9999 } });
  const capacity = (inv.HOTBAR_SLOTS + inv.STORAGE_SLOTS) * inv.STACK_MAX;
  assert.equal(slotSum(p.hotbar) + slotSum(p.storage), capacity);
  assert.equal(inv.overflowCount(p, "wood"), 9999 - capacity);
  assert.equal(inv.countItem(p, "wood"), 9999);
  const again = inv.parseProfile(inv.serializeProfile(p));
  assert.equal(inv.countItem(again, "wood"), 9999);
});

test("インベントリ: 注ぐ順はホットバーのスタック→ストレージのスタック→空き枠", () => {
  const base = inv.parseProfile({
    hotbar: [{ id: "wood", count: 90 }, null, null, null, null],
    storage: [{ id: "wood", count: 90 }, null, null, null, null, null, null, null, null, null],
    items: { wood: 180 },
  });
  const added = inv.addItem(base, "wood", 30);
  assert.equal(added.hotbar[0].count, 99, "ホットバーのスタックが先に満ちる");
  assert.equal(added.storage[0].count, 99, "次にストレージのスタック");
  assert.deepEqual(added.hotbar[1], { id: "wood", count: 12 }, "残りはホットバーの空き枠へ");
  assert.equal(inv.countItem(added, "wood"), 210);
});

test("インベントリ: 引き出しはホットバー→ストレージ→あふれ分の順で、足りなければ null", () => {
  const base = inv.parseProfile({
    hotbar: [{ id: "wood", count: 5 }, null, null, null, null],
    storage: [{ id: "wood", count: 5 }, null, null, null, null, null, null, null, null, null],
    items: { wood: 12 },
  });
  assert.equal(inv.countItem(base, "wood"), 12);
  const removed = inv.removeItem(base, "wood", 7);
  assert.equal(removed.hotbar[0], null, "ホットバーから先に引く");
  assert.deepEqual(removed.storage[0], { id: "wood", count: 3 });
  assert.equal(inv.removeItem(removed, "wood", 6), null, "総数5しかない");
  const rest = inv.removeItem(removed, "wood", 5);
  assert.equal(inv.countItem(rest, "wood"), 0, "あふれ分まで含めて引き切る");
  assert.deepEqual(rest.items, {});
});

test("インベントリ: 枠の入れ替え（swap）と不正な添字", () => {
  const base = inv.parseProfile({
    hotbar: [{ id: "wooden_axe", count: 1 }, null, null, null, null],
    storage: [null, { id: "wheat_seed", count: 4 }, null, null, null, null, null, null, null, null],
    items: { wooden_axe: 1, wheat_seed: 4 },
  });
  const swapped = inv.swapSlots(base, 0, 1);
  assert.deepEqual(swapped.hotbar[0], { id: "wheat_seed", count: 4 });
  assert.deepEqual(swapped.storage[1], { id: "wooden_axe", count: 1 });
  assert.equal(inv.countItem(swapped, "wooden_axe"), 1);
  assert.equal(inv.swapSlots(base, 5, 0), null);
  assert.equal(inv.swapSlots(base, 0, 10), null);
  assert.equal(inv.swapSlots(base, "0", 0), null);
});

// ---------- タイル行為 ----------

const map = T.worldTileSource();
function findTile(id, startX = 60, startY = 60) {
  for (let y = startY; y < startY + 400; y++) {
    for (let x = startX; x < startX + 400; x++) {
      if (T.mapTileAt(map, x, y) === id) return { x, y };
    }
  }
  throw new Error(`tile ${id} not found`);
}
const treeAt = findTile(T.T_TREE);
const snowTreeAt = findTile(T.T_SNOW_TREE, 60, 10);
const rockAt = findTile(T.T_ROCK);
const grassAt = findTile(T.T_GRASS, 300, 300);

const NOW = 1_700_000_000_000;
const ME_KEY = "discord:611111111111111111";
const OTHER_KEY = "discord:622222222222222222";
const withItems = (items) => inv.parseProfile({ items });

test("タイル: 伐採は素手でもでき（収量1）、斧があると収量2、切り株つきで草地になり再生する", () => {
  // HP制（木=30）: 素手（6/ヒット）は5ヒット、倒れるまで収穫は無い
  let bare = T.applyTileAction(null, withItems({}), map, ME_KEY, "chop", treeAt.x, treeAt.y, undefined, NOW);
  assert.equal(bare.ok, true, "素手でも伐採できる");
  assert.deepEqual(bare.gained, {});
  assert.equal(bare.override.hp, T.TERRAIN_TREE_HP - 6, "素手の1ヒットで HP が減る");
  for (let i = 0; i < 6 && !bare.override?.stump; i++) {
    bare = T.applyTileAction(bare.override, bare.profile, map, ME_KEY, "chop", treeAt.x, treeAt.y, undefined, NOW);
  }
  assert.deepEqual(bare.gained, { wood: 1 });
  // 木の斧（10/ヒット）は3ヒットで倒れ、収量2
  let ok = T.applyTileAction(null, withItems({ wooden_axe: 1 }), map, ME_KEY, "chop", treeAt.x, treeAt.y, undefined, NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.override.hp, T.TERRAIN_TREE_HP - 10);
  for (let i = 0; i < 5 && !ok.override?.stump; i++) {
    ok = T.applyTileAction(ok.override, ok.profile, map, ME_KEY, "chop", treeAt.x, treeAt.y, undefined, NOW);
  }
  assert.equal(ok.override.tile, T.T_GRASS);
  assert.equal(ok.override.stump, true);
  assert.equal(ok.override.until, NOW + T.TREE_REGROW_MS);
  assert.deepEqual(ok.gained, { wood: 2 });
  assert.equal(inv.countItem(ok.profile, "wood"), 2);
  // 再生前は草地、再生後は木に戻る
  const overrides = { [T.tileKey(treeAt.x, treeAt.y)]: ok.override };
  assert.equal(T.tileView(map, overrides, treeAt.x, treeAt.y, NOW + 1000, null).tile, T.T_GRASS);
  const regrown = T.tileView(map, overrides, treeAt.x, treeAt.y, NOW + T.TREE_REGROW_MS + 1, null);
  assert.equal(regrown.tile, T.T_TREE);
  assert.equal(regrown.stump, false);
  // 雪の木は雪地になる（石の斧 16/ヒット → 2ヒット）
  let snow = T.applyTileAction(null, withItems({ stone_axe: 1 }), map, ME_KEY, "chop", snowTreeAt.x, snowTreeAt.y, undefined, NOW);
  for (let i = 0; i < 4 && snow.override?.tile !== T.T_SNOW; i++) {
    snow = T.applyTileAction(snow.override, snow.profile, map, ME_KEY, "chop", snowTreeAt.x, snowTreeAt.y, undefined, NOW);
  }
  assert.equal(snow.override.tile, T.T_SNOW);
  // 草地は伐れない
  assert.equal(
    T.applyTileAction(null, withItems({ wooden_axe: 1 }), map, ME_KEY, "chop", grassAt.x, grassAt.y, undefined, NOW).error,
    "tile_blocked",
  );
});

test("タイル: 採掘はツルハシが要り、岩が土になり石材が得られ、岩は再成長する", () => {
  assert.equal(
    T.applyTileAction(null, withItems({}), map, ME_KEY, "mine", rockAt.x, rockAt.y, undefined, NOW).error,
    "tool_required",
  );
  // HP制（岩=60）: 木ツルハシ（10/ヒット）は6ヒット。ミスリル（40）でも2ヒット
  let ok = T.applyTileAction(null, withItems({ wooden_pickaxe: 1 }), map, ME_KEY, "mine", rockAt.x, rockAt.y, undefined, NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.override.hp, T.TERRAIN_ROCK_HP - 10, "1ヒットでは壊れず HP が減る");
  assert.equal(ok.override.tile, undefined, "壊れるまで地形は岩のまま");
  for (let i = 0; i < 8 && ok.override?.tile !== T.T_DIRT; i++) {
    ok = T.applyTileAction(ok.override, ok.profile, map, ME_KEY, "mine", rockAt.x, rockAt.y, undefined, NOW);
  }
  assert.equal(ok.override.tile, T.T_DIRT);
  assert.equal(ok.override.until, NOW + 3 * 3600 * 1000, "岩の再成長タイマー（3時間）");
  // 石材は基本2＋その土地の純度ボーナス（個体値）
  assert.equal(inv.countItem(ok.profile, "stone"), 2 + T.purityBonusStone(T.tileIvsAt(rockAt.x, rockAt.y).purity));
  const mithril1 = T.applyTileAction(null, withItems({ mithril_pickaxe: 1 }), map, ME_KEY, "mine", rockAt.x, rockAt.y, undefined, NOW);
  assert.equal(mithril1.override.hp, T.TERRAIN_ROCK_HP - 40, "ミスリルでも1発では壊れない");
  const mithril2 = T.applyTileAction(mithril1.override, mithril1.profile, map, ME_KEY, "mine", rockAt.x, rockAt.y, undefined, NOW);
  assert.equal(mithril2.override.tile, T.T_DIRT, "ミスリルは2ヒットで壊れる");
  // 土になった場所は掘れない
  assert.equal(
    T.applyTileAction(ok.override, ok.profile, map, ME_KEY, "mine", rockAt.x, rockAt.y, undefined, NOW).error,
    "tile_blocked",
  );
  // 再成長が終わればまた岩として掘れる
  const regrown = T.applyTileAction(ok.override, ok.profile, map, ME_KEY, "mine", rockAt.x, rockAt.y, undefined, NOW + 3 * 3600 * 1000 + 1);
  assert.equal(regrown.ok, true);
});

test("タイル: 耕す→植える→育つ→所有者だけが収穫できる", () => {
  const farmer = withItems({ wooden_hoe: 1, wheat_seed: 2 });
  assert.equal(
    T.applyTileAction(null, withItems({}), map, ME_KEY, "till", grassAt.x, grassAt.y, undefined, NOW).error,
    "tool_required",
  );
  const tilled = T.applyTileAction(null, farmer, map, ME_KEY, "till", grassAt.x, grassAt.y, undefined, NOW);
  assert.equal(tilled.ok, true);
  assert.equal(tilled.override.farmland, true);
  // 二度耕しは不可
  assert.equal(
    T.applyTileAction(tilled.override, farmer, map, ME_KEY, "till", grassAt.x, grassAt.y, undefined, NOW).error,
    "tile_blocked",
  );
  // 畑でない場所には植えられない
  assert.equal(
    T.applyTileAction(null, farmer, map, ME_KEY, "plant", treeAt.x, treeAt.y, "wheat_seed", NOW).error,
    "tile_blocked",
  );
  // 種の検証
  assert.equal(
    T.applyTileAction(tilled.override, farmer, map, ME_KEY, "plant", grassAt.x, grassAt.y, "wood", NOW).error,
    "unknown_seed",
  );
  assert.equal(
    T.applyTileAction(tilled.override, withItems({ wooden_hoe: 1 }), map, ME_KEY, "plant", grassAt.x, grassAt.y, "wheat_seed", NOW).error,
    "not_enough_items",
  );
  const planted = T.applyTileAction(tilled.override, farmer, map, ME_KEY, "plant", grassAt.x, grassAt.y, "wheat_seed", NOW);
  assert.equal(planted.ok, true);
  assert.equal(planted.override.crop.cropId, "wheat");
  // NOW は秋: 小麦（適季=春）の反対の季節なので ×1.4 で遅く育つ。さらに土地の豊穣度倍率が掛かる
  assert.equal(planted.override.crop.readyAt, NOW + Math.round(10 * 60_000 * 1.4 * T.fertilityGrowthFactor(T.tileIvsAt(grassAt.x, grassAt.y).fertility)));
  assert.equal(inv.countItem(planted.profile, "wheat_seed"), 1, "種を1つ消費する");
  // 育つ前は収穫できない
  assert.equal(
    T.applyTileAction(planted.override, planted.profile, map, ME_KEY, "harvest", grassAt.x, grassAt.y, undefined, NOW + 1000).error,
    "not_ready",
  );
  const readyAt = planted.override.crop.readyAt;
  // 他人は収穫できない
  assert.equal(
    T.applyTileAction(planted.override, withItems({}), map, OTHER_KEY, "harvest", grassAt.x, grassAt.y, undefined, readyAt).error,
    "not_owner",
  );
  // 所有者は収穫できる（畑は残る）
  const harvested = T.applyTileAction(planted.override, planted.profile, map, ME_KEY, "harvest", grassAt.x, grassAt.y, undefined, readyAt);
  assert.equal(harvested.ok, true);
  // 収穫は基本2＋その土地の豊穣度ボーナス（個体値）
  assert.deepEqual(harvested.gained, { wheat: 2 + T.fertilityBonusYield(T.tileIvsAt(grassAt.x, grassAt.y).fertility) });
  assert.equal(inv.countItem(harvested.profile, "wheat"), 2);
  assert.equal(harvested.override.crop, null);
  assert.equal(harvested.override.farmland, true);
  // 収穫後は作物が無い
  assert.equal(
    T.applyTileAction(harvested.override, harvested.profile, map, ME_KEY, "harvest", grassAt.x, grassAt.y, undefined, readyAt).error,
    "no_crop",
  );
});

test("タイル: 上書きの解釈は壊れた値を落とす", () => {
  assert.equal(T.parseTileOverride(null), null);
  assert.equal(T.parseTileOverride("{壊れた"), null);
  assert.equal(T.parseTileOverride({ tile: 99, ownerId: "x" }).tile, undefined);
  assert.equal(T.parseTileOverride({ crop: { cropId: "nope", plantedAt: 1, readyAt: 2 }, ownerId: "x" }).crop, undefined);
  const rows = new Map([
    ["1,2", JSON.stringify({ tile: 0, ownerId: "abc" })],
    ["bad-key", { ownerId: "abc" }],
    ["3,4", { ownerId: "" }],
  ]);
  const parsed = T.parseTileOverrides(rows);
  assert.deepEqual(Object.keys(parsed), ["1,2"]);
});

test("タイル: タップ判定（actionForTile）の優先順", () => {
  const ready = { x: 0, y: 0, tile: T.T_GRASS, farmland: true, stump: false, crop: { cropId: "wheat", stage: 2, ready: true }, mine: true };
  assert.deepEqual(T.actionForTile(ready, null), { action: "harvest" }, "実れば素手でも収穫");
  const emptyFarm = { ...ready, crop: null };
  assert.deepEqual(T.actionForTile(emptyFarm, { seedId: "wheat_seed" }), { action: "plant", seedId: "wheat_seed" });
  assert.deepEqual(T.actionForTile(emptyFarm, { tool: "hoe" }), { action: "plant-picker" });
  const tree = { ...ready, tile: T.T_TREE, farmland: false, crop: null };
  assert.deepEqual(T.actionForTile(tree, { tool: "axe" }), { action: "chop" });
  assert.deepEqual(T.actionForTile(tree, null), { action: "chop" }, "素手（未選択）でも伐採");
  assert.deepEqual(T.actionForTile(tree, { tool: "pickaxe" }), { action: "chop" }, "選択中の道具を問わない");
  const rock = { ...tree, tile: T.T_ROCK };
  assert.deepEqual(T.actionForTile(rock, { tool: "pickaxe" }), { action: "mine" });
  const grass = { ...tree, tile: T.T_GRASS };
  assert.deepEqual(T.actionForTile(grass, { tool: "hoe" }), { action: "till" });
  assert.equal(T.actionForTile(grass, null), null);
  const growing = { ...ready, crop: { cropId: "wheat", stage: 1, ready: false } };
  assert.equal(T.actionForTile(growing, { tool: "hoe" }), null, "成長中は何もしない");
});

// ---------- タイル API ----------

const subdomainUrl = dataUrl(transpile("subdomain.ts"));
const headersStubUrl = dataUrl("export async function cookies() { throw new Error('tests do not use cookies()'); }");
const authUrl = dataUrl(
  transpile("auth.ts").replaceAll('"./subdomain"', JSON.stringify(subdomainUrl)).replaceAll('"next/headers"', JSON.stringify(headersStubUrl)),
);
const auth = await import(authUrl);

const presenceBundleUrl = bundleModule(["worldbox/presence.ts"], ["presenceIdFor"]);
const nationsOnlineStubUrl = dataUrl(`
export function isNationsEnabled() { return true; }
export async function loadNationsState() { return { nations: {} }; }
`);
// 戦争のスタブ: 空の戦争状態を返す（平時＝他者ブロックは掘れない）。
const warUrl = bundleModule(["worldbox/war.ts"], ["canBreakOthersBlock"]);
const warsOnlineStubUrl = dataUrl(`
export async function loadWarState() { return globalThis.__wbFarmWars ?? { v: 1, wars: {}, history: [], lastDeclaredAt: {} }; }
`);
const profileOnlineStubUrl = dataUrl(`
import { parseProfile, serializeProfile } from ${JSON.stringify(invUrl)};
const store = (globalThis.__wbFarmProfiles ??= new Map());
export function isProfileEnabled() { return true; }
export async function loadProfile(key) { const raw = store.get(key); return raw ? parseProfile(raw) : parseProfile(null); }
export async function storeProfile(key, profile) { store.set(key, serializeProfile(profile)); return true; }
`);
const presenceOnlineStubUrl = dataUrl(`
export function isPresenceEnabled() { return true; }
export async function listPresence() { return globalThis.__wbFarmPresence ?? []; }
`);
const saveStubUrl = dataUrl("export function parseSave() { return null; }");
const saveOnlineStubUrl = dataUrl("export async function loadWorldBoxSave() { return null; }");
const tilesOnlineStubUrl = dataUrl(`
import { parseTileOverride, parseTileOverrides } from ${JSON.stringify(tilesUrl)};
const store = (globalThis.__wbFarmTiles ??= new Map());
export function isTilesEnabled() { return true; }
export async function loadTileOverrides() { return parseTileOverrides(store); }
export async function loadTileOverride(x, y) { const v = store.get(x + "," + y); return v === undefined ? null : parseTileOverride(v); }
export async function storeTileOverride(x, y, ov) { if (ov === null) store.delete(x + "," + y); else store.set(x + "," + y, JSON.stringify(ov)); return true; }
`);
const containersBundleUrl = bundleModule(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/containers.ts"],
  ["isContainerItem", "containerIsEmpty", "parseContainerState", "serializeContainerState"],
);
const containersOnlineStubUrl = dataUrl(`
import { parseContainerState, serializeContainerState } from ${JSON.stringify(containersBundleUrl)};
const store = (globalThis.__wbFarmContainers ??= new Map());
export function isContainersEnabled() { return true; }
export async function loadContainer(space, x, y, itemId) { const v = store.get(space + "|" + x + "," + y); return v === undefined ? null : parseContainerState(v, itemId); }
export async function storeContainer(space, x, y, state) { if (state === null) store.delete(space + "|" + x + "," + y); else store.set(space + "|" + x + "," + y, serializeContainerState(state)); return true; }
`);
const nextServerStubUrl = dataUrl(`
export class NextResponse {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
`);
const userLockUrl = dataUrl(transpile("worldbox/user-lock.ts"));
// 装置のスタブ: 実ロジック（isMachineItem / machineBufferCount）と空の保存層。
const machinesUrl = bundleModule(["worldbox/items.ts", "worldbox/machines.ts"], ["isMachineItem", "machineBufferCount"]);
const opsOnlineStubUrl = dataUrl(`
export async function loadFrozen() { return false; }
export async function appendTileJournal() {}
`);
const metricsOnlineStubUrl = dataUrl(`
export async function recordPresenceMetric() {}
export async function recordFirstStep() {}
export async function bumpMetric() {}
export async function loadDayMetrics() { return null; }
export async function loadUserFirstSteps() { return null; }
export async function loadEconDay() { return null; }
`);
const machinesOnlineStubUrl = dataUrl(`
export async function loadMachine() { return null; }
export async function deleteMachine() {}
`);
const stallsUrl = bundleModule(["worldbox/items.ts", "worldbox/stalls.ts"], ["isStallItem"]);
const stallsOnlineStubUrl = dataUrl(`
export async function loadStall() { return null; }
export async function storeStall() { return true; }
`);
const tilesRoute = await import(
  dataUrl(
    transpile("api/worldbox/tiles/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/mapgen"', JSON.stringify(mapgenUrl))
      .replaceAll('"@/lib/worldbox/profile-online"', JSON.stringify(profileOnlineStubUrl))
      .replaceAll('"@/lib/worldbox/presence-online"', JSON.stringify(presenceOnlineStubUrl))
      .replaceAll('"@/lib/worldbox/presence"', JSON.stringify(presenceBundleUrl))
      .replaceAll('"@/lib/worldbox/save"', JSON.stringify(saveStubUrl))
      .replaceAll('"@/lib/worldbox/save-online"', JSON.stringify(saveOnlineStubUrl))
      .replaceAll('"@/lib/worldbox/tiles"', JSON.stringify(tilesUrl))
      .replaceAll('"@/lib/worldbox/tiles-online"', JSON.stringify(tilesOnlineStubUrl))
      .replaceAll('"@/lib/worldbox/containers"', JSON.stringify(containersBundleUrl))
      .replaceAll('"@/lib/worldbox/containers-online"', JSON.stringify(containersOnlineStubUrl))
      .replaceAll('"@/lib/worldbox/machines"', JSON.stringify(machinesUrl))
      .replaceAll('"@/lib/worldbox/machines-online"', JSON.stringify(machinesOnlineStubUrl))
      .replaceAll('"@/lib/worldbox/stalls"', JSON.stringify(stallsUrl))
      .replaceAll('"@/lib/worldbox/stalls-online"', JSON.stringify(stallsOnlineStubUrl))
      .replaceAll('"@/lib/worldbox/metrics-online"', JSON.stringify(metricsOnlineStubUrl))
      .replaceAll('"@/lib/worldbox/ops-online"', JSON.stringify(opsOnlineStubUrl))
      .replaceAll('"@/lib/worldbox/user-lock"', JSON.stringify(userLockUrl))
      .replaceAll('"@/lib/worldbox/nations-online"', JSON.stringify(nationsOnlineStubUrl))
      .replaceAll('"@/lib/worldbox/war"', JSON.stringify(warUrl))
      .replaceAll('"@/lib/worldbox/war-online"', JSON.stringify(warsOnlineStubUrl)),
  ),
);

process.env["DISCORD_SESSION" + "_SECRET"] = "worldbox-farm-test-secret";
const ME = "611111111111111111";
const MY_KEY = `discord:${ME}`;
function sessionCookie(id, username) {
  return `ago_session=${encodeURIComponent(auth.createSession({ id, username }))}`;
}
function apiRequest(url, method, cookie, body) {
  return new Request(url, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const URL_T = "http://localhost/api/worldbox/tiles";

test("API(tiles): 未ログインの POST は 401、他オリジンは 403", async () => {
  const anon = await tilesRoute.POST(apiRequest(URL_T, "POST", null, { action: "chop", x: treeAt.x, y: treeAt.y }));
  assert.equal(anon.status, 401);
  const cookie = sessionCookie(ME, "farm-user");
  const cross = new Request(URL_T, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json", origin: "http://evil.example" },
    body: JSON.stringify({ action: "chop", x: treeAt.x, y: treeAt.y }),
  });
  assert.equal((await tilesRoute.POST(cross)).status, 403);
});

test("API(tiles): 伐採は素手でも適用され（収量1）、斧があると収量2、上書きが保存される", async () => {
  const cookie = sessionCookie(ME, "farm-user");
  globalThis.__wbFarmTiles.clear();
  globalThis.__wbFarmProfiles.clear();
  globalThis.__wbFarmPresence = [{
    id: (await import(presenceBundleUrl)).presenceIdFor(MY_KEY),
    name: "farm-user", x: treeAt.x, y: treeAt.y, vx: 0, vy: 0, face: 1, space: "world", ts: Date.now(),
  }];
  // 素手（空のプロフィール）でも伐採できる（HP制: 6/ヒット → 5ヒットで倒れる）
  let bareData = null;
  for (let i = 0; i < 6; i++) {
    const bare = await tilesRoute.POST(apiRequest(URL_T, "POST", cookie, { action: "chop", x: treeAt.x, y: treeAt.y }));
    assert.equal(bare.status, 200);
    bareData = await bare.json();
    if (bareData.tile.tile === T.T_GRASS) break;
    assert.deepEqual(bareData.gained, {}, "倒れるまでは収穫なし");
  }
  assert.deepEqual(bareData.gained, { wood: 1 });
  assert.equal(bareData.tile.tile, T.T_GRASS);
  assert.ok(globalThis.__wbFarmTiles.has(`${treeAt.x},${treeAt.y}`), "上書きが保存される");
  // 斧を持たせると収量2（別の木で確認。10/ヒット → 3ヒット）
  globalThis.__wbFarmTiles.clear();
  globalThis.__wbFarmProfiles.set(MY_KEY, inv.serializeProfile(inv.parseProfile({ items: { wooden_axe: 1 } })));
  let data = null;
  for (let i = 0; i < 4; i++) {
    const ok = await tilesRoute.POST(apiRequest(URL_T, "POST", cookie, { action: "chop", x: treeAt.x, y: treeAt.y }));
    assert.equal(ok.status, 200);
    data = await ok.json();
    if (data.tile.tile === T.T_GRASS) break;
  }
  assert.equal(data.tile.tile, T.T_GRASS);
  assert.deepEqual(data.gained, { wood: 2 });
  assert.equal(inv.countItem(data.profile, "wood"), 2);
});

test("API(tiles): 本人位置が分かる場合は遠くのタイルを拒む（too_far）", async () => {
  const cookie = sessionCookie(ME, "farm-user");
  globalThis.__wbFarmPresence = [{
    id: (await import(presenceBundleUrl)).presenceIdFor(MY_KEY),
    name: "farm-user", x: 10.5, y: 10.5, vx: 0, vy: 0, face: 1, space: "world", ts: Date.now(),
  }];
  const res = await tilesRoute.POST(apiRequest(URL_T, "POST", cookie, { action: "chop", x: treeAt.x, y: treeAt.y }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "too_far");
  globalThis.__wbFarmPresence = [];
});

test("API(tiles): GET は範囲内の有効な上書きだけを返す", async () => {
  globalThis.__wbFarmTiles.clear();
  globalThis.__wbFarmTiles.set("10,10", JSON.stringify({ tile: 0, stump: true, ownerId: "aa", until: Date.now() + 60_000 }));
  globalThis.__wbFarmTiles.set("500,500", JSON.stringify({ tile: 5, ownerId: "aa" }));
  globalThis.__wbFarmTiles.set("11,10", JSON.stringify({ tile: 0, ownerId: "aa", until: 1 })); // 失効済み
  const res = await tilesRoute.GET(apiRequest(`${URL_T}?x0=0&y0=0&x1=20&y1=20`, "GET", null));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(Object.keys(data.overrides), ["10,10"]);
});

test("API(tiles): GET rect は旧境界の外（負座標・2000超）でも上書きを返す", async () => {
  globalThis.__wbFarmTiles.clear();
  const entry = JSON.stringify({ tile: 0, stump: true, ownerId: "aa", until: Date.now() + 60_000 });
  globalThis.__wbFarmTiles.set("-40,-40", entry);
  globalThis.__wbFarmTiles.set("2005,2005", entry);
  globalThis.__wbFarmTiles.set("10,10", entry);
  const neg = await tilesRoute.GET(apiRequest(`${URL_T}?x0=-64&y0=-64&x1=-1&y1=-1`, "GET", null));
  assert.equal(neg.status, 200);
  assert.deepEqual(Object.keys((await neg.json()).overrides), ["-40,-40"]);
  const far = await tilesRoute.GET(apiRequest(`${URL_T}?x0=2000&y0=2000&x1=2100&y1=2100`, "GET", null));
  assert.equal(far.status, 200);
  assert.deepEqual(Object.keys((await far.json()).overrides), ["2005,2005"]);
});

// ---------- クライアント配線 ----------

test("クライアント: ホットバー・ストレージ・種ピッカー・タイル API が配線されている", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("/api/worldbox/tiles"), "タイル API を使っていない");
  assert.ok(client.includes("loadFarmSprites"), "農業スプライトを読み込んでいない");
  assert.ok(client.includes("actionForTile"), "タップ判定を使っていない");
  assert.ok(client.includes("invProfile.hotbar"), "ホットバーを描いていない");
  assert.ok(client.includes("invProfile.storage"), "ストレージを描いていない");
  assert.ok(client.includes("ストレージ"), "ストレージ UI が無い");
  assert.ok(client.includes('action: "move"'), "スロット移動を送っていない");
  const textures = fs.readFileSync(path.join(libDir, "worldbox/textures.ts"), "utf8");
  assert.ok(textures.includes("loadFarmSprites"), "テクスチャ側に農業読み込みが無い");
  for (const name of ["farmland", "stump", "crop_stage0", "crop_stage1", "crop_stage2"]) {
    assert.ok(textures.includes(`/img/worldbox/farm/${name}.png`), `テクスチャ定義に ${name} が無い`);
    const file = path.join(rootDir, "public/img/worldbox/farm", `${name}.png`);
    assert.ok(fs.existsSync(file), `農業スプライトが無い: ${name}.png`);
    const buf = fs.readFileSync(file);
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${name}.png が PNG でない`);
    assert.equal(buf.readUInt32BE(16), 64, `${name}.png の幅が 64 でない`);
    assert.equal(buf.readUInt32BE(20), 64, `${name}.png の高さが 64 でない`);
  }
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"), "utf8");
  assert.ok(panel.includes("かばんは空です"), "かばんの空状態が無い");
  assert.ok(!panel.includes("ショップで買うか、合成で作りましょう"), "案内文が残っている");
});
