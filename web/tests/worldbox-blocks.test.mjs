// AGO WORLD BOX 自由建築とアイテムアイコンの検証:
// - アイコン対応（道具・素材は全種、実ファイルの存在と PNG 形式）
// - ブロック設置/採掘（地形・占有・首都/広場・建物・所有者・道具ルール）
// - 設置ブロックの当たり判定（move の blocked 集合）
// - タイル API（place_block / mine_block の認証・保護・往復）
// - クライアント配線（アイコン描画・ブロック描画・固体化）
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
    "ITEMS", "ITEM_ICON_IDS", "itemById",
    "parseProfile", "serializeProfile", "countItem", "addItem", "moveSlot",
  ],
);
const inv = await import(invUrl);

const tilesUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts"],
  [
    "worldTileSource", "mapTileAt",
    "T_GRASS", "T_TREE", "T_ROCK", "T_DIRT", "T_SAND", "T_SNOW", "T_WATER",
    "parseProfile", "addItem", "countItem",
    "applyTileAction", "applyPlaceBlock", "applyMineBlock", "applyFlowerAction", "applyToggleGate", "tileView", "actionForTile", "isOverrideActive", "placedBlockSolid",
    "applySetSign", "applyDisplayAction", "applyDrawWater",
    "tileKey", "parseTileOverride", "parseTileOverrides", "presenceIdFor", "HARD_BLOCK_DURABILITY", "blockMineTool",
  ],
);
const T = await import(tilesUrl);

const moveUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/move.ts"],
  ["worldTileSource", "circleHitsSolid", "canStandAt", "PLAYER_RADIUS"],
);
const MV = await import(moveUrl);

const mapgenUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts"],
  ["worldTileSource", "WORLD_COORD_LIMIT"],
);

// ---------- アイコン ----------

const ICON_DIR = path.join(rootDir, "public/img/worldbox/items");

function assertIconFile(item) {
  // 失敗作 mystery_lump は新規 png を作らず slime のアイコンを明示指定で
  // 流用する（PR-B の決定。ITEM_ICON_IDS にも登録しない）。流用元が実在し
  // PNG であることは従来どおり検証する。
  if (item.id === "mystery_lump") {
    assert.equal(item.icon, "/img/worldbox/items/slime.png", "mystery_lump の流用アイコン");
    const reuse = path.join(ICON_DIR, "slime.png");
    assert.ok(fs.existsSync(reuse), "流用元アイコンが無い: slime.png");
    const rbuf = fs.readFileSync(reuse);
    assert.deepEqual([...rbuf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "slime.png が PNG でない");
    return;
  }
  assert.equal(item.icon, `/img/worldbox/items/${item.id}.png`, `${item.id} の icon パス`);
  const file = path.join(ICON_DIR, `${item.id}.png`);
  assert.ok(fs.existsSync(file), `アイコンが無い: ${item.id}.png`);
  const buf = fs.readFileSync(file);
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${item.id}.png が PNG でない`);
  const w = buf.readUInt32BE(16);
  assert.ok(w === 16 || w === 64, `${item.id}.png の幅が想定外: ${w}`);
}

test("アイコン: 道具は全種アイコンつき", () => {
  const tools = inv.ITEMS.filter((i) => i.category === "tool");
  // 作業道具16種（4種×4段）＋開拓のコンパス（種別なしの探索道具）
  assert.equal(tools.length, 17);
  for (const item of tools) assertIconFile(item);
});

test("アイコン: 素材は全種アイコンつき", () => {
  const materials = inv.ITEMS.filter((i) => i.category === "material");
  assert.ok(materials.length >= 20, `materials=${materials.length}`);
  for (const item of materials) assertIconFile(item);
});

test("アイコン: ブロックと種は全種、全体で100種以上にアイコンがある", () => {
  for (const item of inv.ITEMS) {
    if (item.category === "block" || item.category === "seed") assertIconFile(item);
    else if (item.icon) assertIconFile(item);
  }
  const withIcon = inv.ITEMS.filter((i) => i.icon);
  assert.ok(withIcon.length >= 300, `icons=${withIcon.length}`);
  assert.equal(new Set(inv.ITEM_ICON_IDS).size, inv.ITEM_ICON_IDS.length, "アイコン ID に重複");
  for (const id of inv.ITEM_ICON_IDS) assert.ok(inv.itemById(id), `アイコン ID が実在しない: ${id}`);
});

// ---------- 設置・採掘（純粋ロジック） ----------

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
const dirtAt = findTile(T.T_DIRT);
const sandAt = findTile(T.T_SAND);
const snowAt = findTile(T.T_SNOW);
const waterAt = findTile(T.T_WATER);
const rockAt = findTile(T.T_ROCK);
const treeAt = findTile(T.T_TREE);

const NOW = 1_700_000_000_000;
const ME_KEY = "discord:611111111111111111";
const OTHER_KEY = "discord:622222222222222222";
const NO_CTX = { onCapital: false };
const withItems = (items) => inv.parseProfile({ items });
const place = (current, profile, key, at, itemId, ctx = NO_CTX) =>
  T.applyPlaceBlock(current, profile, map, key, at.x, at.y, itemId, NOW, ctx);
const mineBlock = (current, profile, key, at) =>
  T.applyMineBlock(current, profile, map, key, at.x, at.y, NOW);

test("設置: 更地（草・土・砂・雪）に置け、アイテムを1つ消費する", () => {
  for (const at of [grassAt, dirtAt, sandAt, snowAt]) {
    const p = withItems({ dirt_block: 2 });
    const ok = place(null, p, ME_KEY, at, "dirt_block");
    assert.equal(ok.ok, true, `tile at ${at.x},${at.y}`);
    assert.equal(ok.override.block.itemId, "dirt_block");
    assert.equal(ok.override.block.ownerId, T.presenceIdFor(ME_KEY));
    assert.equal(inv.countItem(ok.profile, "dirt_block"), 1);
    assert.equal(ok.view.block.itemId, "dirt_block");
    assert.equal(ok.view.block.mine, true);
    const otherView = T.tileView(map, { [T.tileKey(at.x, at.y)]: ok.override }, at.x, at.y, NOW, OTHER_KEY);
    assert.equal(otherView.block.mine, false, "他人からは自分のブロックに見えない");
  }
});

test("設置: 基本素材（木材・石材）はそのままブロックとして置ける", () => {
  // 木材 → オークの原木として設置され、消費は木材
  const p = withItems({ wood: 2 });
  const ok = place(null, p, ME_KEY, grassAt, "wood");
  assert.equal(ok.ok, true);
  assert.equal(ok.override.block.itemId, "oak_log");
  assert.equal(ok.view.block.itemId, "oak_log");
  assert.equal(inv.countItem(ok.profile, "wood"), 1);
  // 石材 → 石ブロック
  const p2 = withItems({ stone: 1 });
  const ok2 = place(null, p2, ME_KEY, dirtAt, "stone");
  assert.equal(ok2.ok, true);
  assert.equal(ok2.override.block.itemId, "stone_block");
  assert.equal(inv.countItem(ok2.profile, "stone"), 0);
  // 在庫がなければ置けない
  assert.equal(place(null, withItems({}), ME_KEY, grassAt, "wood").error, "not_enough_items");
});

test("設置: ブロック以外・在庫なし・置けない地形は拒む", () => {
  const p = withItems({ herb: 3, dirt_block: 1 });
  assert.equal(place(null, p, ME_KEY, grassAt, "herb").error, "unknown_block");
  assert.equal(place(null, p, ME_KEY, grassAt, "nope").error, "unknown_block");
  assert.equal(place(null, withItems({}), ME_KEY, grassAt, "dirt_block").error, "not_enough_items");
  for (const at of [waterAt, rockAt, treeAt]) {
    assert.equal(place(null, p, ME_KEY, at, "dirt_block").error, "tile_blocked", `tile at ${at.x},${at.y}`);
  }
});

test("設置: 首都（ユニオンマーク）のあるタイルは保護される", () => {
  const p = withItems({ dirt_block: 1 });
  assert.equal(place(null, p, ME_KEY, grassAt, "dirt_block", { ...NO_CTX, onCapital: true }).error, "on_capital");
});

test("設置: 畑・作物・既存ブロック・切り株（再生待ち）の上には置けない", () => {
  const farmer = withItems({ wooden_hoe: 1, wheat_seed: 1, dirt_block: 3 });
  const tilled = T.applyTileAction(null, farmer, map, ME_KEY, "till", grassAt.x, grassAt.y, undefined, NOW);
  assert.equal(place(tilled.override, farmer, ME_KEY, grassAt, "dirt_block").error, "tile_blocked", "畑");
  const planted = T.applyTileAction(tilled.override, farmer, map, ME_KEY, "plant", grassAt.x, grassAt.y, "wheat_seed", NOW);
  assert.equal(place(planted.override, farmer, ME_KEY, grassAt, "dirt_block").error, "tile_blocked", "作物");
  const placed = place(null, withItems({ dirt_block: 2 }), ME_KEY, dirtAt, "dirt_block");
  assert.equal(place(placed.override, withItems({ dirt_block: 1 }), ME_KEY, dirtAt, "dirt_block").error, "tile_blocked", "既存ブロック");
  // HP制: 木（HP30）を木の斧（10/ヒット）で倒れるまで叩く
  let chopped = T.applyTileAction(null, withItems({ wooden_axe: 1 }), map, ME_KEY, "chop", treeAt.x, treeAt.y, undefined, NOW);
  for (let i = 0; i < 5 && !chopped.override?.stump; i++) {
    chopped = T.applyTileAction(chopped.override, chopped.profile, map, ME_KEY, "chop", treeAt.x, treeAt.y, undefined, NOW);
  }
  assert.equal(chopped.override.stump, true);
  assert.equal(place(chopped.override, withItems({ dirt_block: 1 }), ME_KEY, treeAt, "dirt_block").error, "tile_blocked", "切り株");
});

test("設置→採掘: 掘った岩跡（土）にも置け、掘り戻すと土だけが残る", () => {
  const miner = withItems({ wooden_pickaxe: 1, stone_block: 1 });
  // HP制: 岩（HP60）を木ツルハシ（10/ヒット）で壊れるまで掘る
  let mined = T.applyTileAction(null, miner, map, ME_KEY, "mine", rockAt.x, rockAt.y, undefined, NOW);
  for (let i = 0; i < 10 && mined.override?.tile !== T.T_DIRT; i++) {
    mined = T.applyTileAction(mined.override, mined.profile, map, ME_KEY, "mine", rockAt.x, rockAt.y, undefined, NOW);
  }
  assert.equal(mined.override.tile, T.T_DIRT);
  const placed = place(mined.override, mined.profile, ME_KEY, rockAt, "stone_block");
  assert.equal(placed.ok, true);
  assert.equal(placed.override.tile, T.T_DIRT, "下地の土は保持される");
  // HP制: 石ブロック（HP40）を木ツルハシ（10/ヒット）で壊れるまで掘る
  let cur = placed.override;
  let dug;
  for (let i = 0; i < 10; i++) {
    dug = mineBlock(cur, placed.profile, ME_KEY, rockAt);
    assert.equal(dug.ok, true);
    cur = dug.override;
    if (!cur?.block) break;
    assert.deepEqual(dug.gained, {}, "壊れるまでは何も得られない");
  }
  assert.deepEqual(dug.gained, { stone_block: 1 });
  assert.equal(dug.override.tile, T.T_DIRT);
  assert.equal(dug.override.block, undefined);
});

test("採掘: 柔らかいブロックは素手で掘れてアイテムに戻る", () => {
  const placed = place(null, withItems({ dirt_block: 1 }), ME_KEY, grassAt, "dirt_block");
  const dug = mineBlock(placed.override, withItems({}), ME_KEY, grassAt);
  assert.equal(dug.ok, true);
  assert.deepEqual(dug.gained, { dirt_block: 1 });
  assert.equal(dug.override, null, "ブロックだけの上書きは消える");
  assert.equal(inv.countItem(dug.profile, "dirt_block"), 1);
});

test("採掘: 硬いブロック（耐久50以上）は道具が要る", () => {
  assert.equal(T.HARD_BLOCK_DURABILITY, 50);
  assert.equal(T.blockMineTool(inv.itemById("dirt_block")), null);
  assert.equal(T.blockMineTool(inv.itemById("iron_block")), "pickaxe");
  const placed = place(null, withItems({ iron_block: 1 }), ME_KEY, grassAt, "iron_block");
  assert.equal(mineBlock(placed.override, withItems({}), ME_KEY, grassAt).error, "tool_required");
  assert.equal(mineBlock(placed.override, withItems({ wooden_axe: 1 }), ME_KEY, grassAt).error, "tool_required", "斧では掘れない");
  // HP制: 鉄ブロック（HP120）を木ツルハシ（10/ヒット）で壊れるまで掘る
  let cur = placed.override;
  let dug;
  for (let i = 0; i < 20; i++) {
    dug = mineBlock(cur, withItems({ wooden_pickaxe: 1 }), ME_KEY, grassAt);
    assert.equal(dug.ok, true);
    cur = dug.override;
    if (!cur?.block) break;
    assert.deepEqual(dug.gained, {}, "壊れるまでは何も得られない");
  }
  assert.deepEqual(dug.gained, { iron_block: 1 });
});

test("採掘: 他人のブロックは掘れず、ブロックが無ければ no_block", () => {
  const placed = place(null, withItems({ dirt_block: 1 }), ME_KEY, grassAt, "dirt_block");
  assert.equal(mineBlock(placed.override, withItems({}), OTHER_KEY, grassAt).error, "not_owner");
  assert.equal(mineBlock(null, withItems({}), ME_KEY, grassAt).error, "no_block");
});

test("設置: ブロックのあるタイルは耕せない", () => {
  const placed = place(null, withItems({ dirt_block: 1 }), ME_KEY, grassAt, "dirt_block");
  const tilled = T.applyTileAction(placed.override, withItems({ wooden_hoe: 1 }), map, ME_KEY, "till", grassAt.x, grassAt.y, undefined, NOW);
  assert.equal(tilled.error, "tile_blocked");
});

test("ブロック: 上書きの解釈は壊れたブロックを落とす", () => {
  const ok = T.parseTileOverride({ block: { itemId: "dirt_block", ownerId: "abc" }, ownerId: "abc" });
  assert.deepEqual(ok.block, { itemId: "dirt_block", ownerId: "abc" });
  assert.equal(T.parseTileOverride({ block: { itemId: "wood", ownerId: "abc" }, ownerId: "abc" }).block, undefined);
  assert.equal(T.parseTileOverride({ block: { itemId: "dirt_block", ownerId: "" }, ownerId: "abc" }).block, undefined);
  assert.equal(T.parseTileOverride({ block: "x", ownerId: "abc" }).block, undefined);
});

test("タップ判定: ブロック選択で設置、道具選択で自分のブロックを採掘", () => {
  const grass = { x: 0, y: 0, tile: T.T_GRASS, farmland: false, stump: false, crop: null, block: null, mine: false };
  assert.deepEqual(T.actionForTile(grass, { blockId: "dirt_block" }), { action: "place_block", itemId: "dirt_block" });
  assert.equal(T.actionForTile({ ...grass, stump: true }, { blockId: "dirt_block" }), null, "切り株には置かない");
  assert.equal(T.actionForTile({ ...grass, tile: T.T_WATER }, { blockId: "dirt_block" }), null, "水には置かない");
  const ownBlock = { ...grass, block: { itemId: "dirt_block", mine: true } };
  assert.deepEqual(T.actionForTile(ownBlock, { tool: "pickaxe" }), { action: "mine_block" });
  assert.equal(T.actionForTile(ownBlock, null), null, "素手選択では掘らない");
  assert.equal(T.actionForTile(ownBlock, { blockId: "stone_block" }), null, "ブロックの上に置かない");
  const otherBlock = { ...grass, block: { itemId: "dirt_block", mine: false } };
  assert.equal(T.actionForTile(otherBlock, { tool: "pickaxe" }), null, "他人のブロックは触れない");
});

// ---------- 当たり判定 ----------

test("当たり判定: 設置ブロックのタイルは固体になる", () => {
  const key = T.tileKey(grassAt.x, grassAt.y);
  const cx = grassAt.x + 0.5;
  const cy = grassAt.y + 0.5;
  assert.equal(MV.canStandAt(map, cx, cy), true, "素の草地には立てる");
  assert.equal(MV.canStandAt(map, cx, cy, new Set([key])), false, "ブロックがあると立てない");
  assert.equal(MV.circleHitsSolid(map, cx, cy, MV.PLAYER_RADIUS, new Set([key])), true);
  assert.equal(MV.circleHitsSolid(map, cx, cy, MV.PLAYER_RADIUS, new Set()), false);
});

// ---------- タイル API（設置・採掘） ----------

const subdomainUrl = dataUrl(transpile("subdomain.ts"));
const headersStubUrl = dataUrl("export async function cookies() { throw new Error('tests do not use cookies()'); }");
const authUrl = dataUrl(
  transpile("auth.ts").replaceAll('"./subdomain"', JSON.stringify(subdomainUrl)).replaceAll('"next/headers"', JSON.stringify(headersStubUrl)),
);
const auth = await import(authUrl);

const presenceBundleUrl = bundleModule(["worldbox/presence.ts"], ["presenceIdFor"]);
const profileOnlineStubUrl = dataUrl(`
import { parseProfile, serializeProfile } from ${JSON.stringify(invUrl)};
const store = (globalThis.__wbBlockProfiles ??= new Map());
export function isProfileEnabled() { return true; }
export async function loadProfile(key) { const raw = store.get(key); return raw ? parseProfile(raw) : parseProfile(null); }
export async function storeProfile(key, profile) { store.set(key, serializeProfile(profile)); return true; }
`);
const presenceOnlineStubUrl = dataUrl(`
export function isPresenceEnabled() { return true; }
export async function listPresence() { return globalThis.__wbBlockPresence ?? []; }
`);
const saveStubUrl = dataUrl("export function parseSave() { return null; }");
const saveOnlineStubUrl = dataUrl("export async function loadWorldBoxSave() { return null; }");
const tilesOnlineStubUrl = dataUrl(`
import { parseTileOverride, parseTileOverrides } from ${JSON.stringify(tilesUrl)};
const store = (globalThis.__wbBlockTiles ??= new Map());
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
const store = (globalThis.__wbBlockContainers ??= new Map());
export function isContainersEnabled() { return true; }
export async function loadContainer(space, x, y, itemId) { const v = store.get(space + "|" + x + "," + y); return v === undefined ? null : parseContainerState(v, itemId); }
export async function storeContainer(space, x, y, state) { if (state === null) store.delete(space + "|" + x + "," + y); else store.set(space + "|" + x + "," + y, serializeContainerState(state)); return true; }
`);
const nationsOnlineStubUrl = dataUrl(`
export function isNationsEnabled() { return true; }
export async function loadNationsState() { return globalThis.__wbBlockNations ?? { nations: {} }; }
`);
// 戦争のスタブ: 空の戦争状態を返す（平時＝他者ブロックは掘れない）。
const warUrl = bundleModule(["worldbox/war.ts"], ["canBreakOthersBlock"]);
const warsOnlineStubUrl = dataUrl(`
export async function loadWarState() { return globalThis.__wbBlockWars ?? { v: 1, wars: {}, history: [], lastDeclaredAt: {} }; }
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

process.env["DISCORD_SESSION" + "_SECRET"] = "worldbox-blocks-test-secret";
const ME = "611111111111111111";
const OTHER = "622222222222222222";
const MY_KEY = `discord:${ME}`;
const OTHER_KEY2 = `discord:${OTHER}`;
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
const KEY = T.tileKey(grassAt.x, grassAt.y);

function resetStores() {
  globalThis.__wbBlockTiles.clear();
  globalThis.__wbBlockProfiles.clear();
  globalThis.__wbBlockContainers?.clear();
  // 位置ゲート（位置不明は拒否）が前提にする「本人がそのタイルに立っている」
  // プレゼンス。旧仕様の素通しに依存していた往復テストのための種。
  globalThis.__wbBlockPresence = [
    { id: T.presenceIdFor(MY_KEY), space: "world", x: grassAt.x, y: grassAt.y, ts: Date.now() },
    { id: T.presenceIdFor(OTHER_KEY2), space: "world", x: grassAt.x, y: grassAt.y, ts: Date.now() },
  ];
  globalThis.__wbBlockNations = { nations: {} };
}

test("API(blocks): 未ログインの設置は 401", async () => {
  resetStores();
  const res = await tilesRoute.POST(apiRequest(URL_T, "POST", null, { action: "place_block", x: grassAt.x, y: grassAt.y, itemId: "dirt_block" }));
  assert.equal(res.status, 401);
});

test("API(blocks): 設置→GET(selfId)→採掘の往復", async () => {
  resetStores();
  const cookie = sessionCookie(ME, "builder");
  globalThis.__wbBlockProfiles.set(MY_KEY, inv.serializeProfile(inv.parseProfile({ items: { dirt_block: 2 } })));
  const placed = await tilesRoute.POST(apiRequest(URL_T, "POST", cookie, { action: "place_block", x: grassAt.x, y: grassAt.y, itemId: "dirt_block" }));
  assert.equal(placed.status, 200);
  const placedData = await placed.json();
  assert.equal(placedData.override.block.itemId, "dirt_block");
  assert.equal(inv.countItem(placedData.profile, "dirt_block"), 1, "1つ消費する");
  assert.ok(globalThis.__wbBlockTiles.has(KEY), "上書きが保存される");

  const got = await tilesRoute.GET(apiRequest(`${URL_T}?x0=${grassAt.x}&y0=${grassAt.y}&x1=${grassAt.x}&y1=${grassAt.y}`, "GET", cookie));
  const gotData = await got.json();
  assert.equal(gotData.selfId, T.presenceIdFor(MY_KEY), "自分の ID が返る");
  assert.equal(gotData.overrides[KEY].block.itemId, "dirt_block");

  // 他人は掘れない
  const otherCookie = sessionCookie(OTHER, "intruder");
  globalThis.__wbBlockProfiles.set(OTHER_KEY2, inv.serializeProfile(inv.parseProfile({ items: {} })));
  const denied = await tilesRoute.POST(apiRequest(URL_T, "POST", otherCookie, { action: "mine_block", x: grassAt.x, y: grassAt.y }));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "not_owner");

  // 本人は掘れてアイテムが戻る
  const dug = await tilesRoute.POST(apiRequest(URL_T, "POST", cookie, { action: "mine_block", x: grassAt.x, y: grassAt.y }));
  assert.equal(dug.status, 200);
  const dugData = await dug.json();
  assert.deepEqual(dugData.gained, { dirt_block: 1 });
  assert.equal(dugData.override, null);
  assert.equal(globalThis.__wbBlockTiles.has(KEY), false);
});

test("API(blocks): 首都タイルは 409 で保護され、旧スポーン地点は保護されない", async () => {
  resetStores();
  const cookie = sessionCookie(ME, "builder");
  globalThis.__wbBlockProfiles.set(MY_KEY, inv.serializeProfile(inv.parseProfile({ items: { dirt_block: 5 } })));
  // 首都（ユニオンマーク）
  globalThis.__wbBlockNations = { nations: { g1: { capital: { x: grassAt.x, y: grassAt.y } } } };
  const cap = await tilesRoute.POST(apiRequest(URL_T, "POST", cookie, { action: "place_block", x: grassAt.x, y: grassAt.y, itemId: "dirt_block" }));
  assert.equal(cap.status, 409);
  assert.equal((await cap.json()).error, "on_capital");
  globalThis.__wbBlockNations = { nations: {} };
  // 固定のスポーン広場は無い（旧マップ中央の草タイルにも置ける）
  globalThis.__wbBlockPresence = [
    { id: T.presenceIdFor(MY_KEY), space: "world", x: 512, y: 512, ts: Date.now() },
  ];
  const center = await tilesRoute.POST(apiRequest(URL_T, "POST", cookie, { action: "place_block", x: 512, y: 512, itemId: "dirt_block" }));
  assert.equal(center.status, 200);
});

// ---------- 施設（占有あり・当たり判定なし） ----------

test("施設: 家具は置けるが固体ではなく、置いたマスは占有される", () => {
  assert.equal(inv.itemById("bench").facility, true);
  assert.equal(inv.itemById("dirt_block").facility, undefined);
  assert.equal(T.placedBlockSolid("dirt_block"), true);
  assert.equal(T.placedBlockSolid("bench"), false, "施設は当たり判定を持たない");
  const placed = place(null, withItems({ bench: 1, dirt_block: 1 }), ME_KEY, grassAt, "bench");
  assert.equal(placed.ok, true, "施設もブロック層に置ける");
  assert.equal(placed.override.block.itemId, "bench");
  // 占有: そのマスには他のブロックを置けない
  assert.equal(place(placed.override, withItems({ dirt_block: 1 }), ME_KEY, grassAt, "dirt_block").error, "tile_blocked");
  // 解釈でも施設は落ちない
  const parsed = T.parseTileOverride(JSON.parse(JSON.stringify(placed.override)));
  assert.equal(parsed.block.itemId, "bench");
  // 固体集合の作り方（クライアント syncBlockBlocked と同じ）では施設は入らない
  const solids = new Set();
  for (const [k, ov] of Object.entries({ [T.tileKey(grassAt.x, grassAt.y)]: placed.override })) {
    if (ov.block && T.placedBlockSolid(ov.block.itemId)) solids.add(k);
  }
  assert.equal(solids.size, 0);
  assert.equal(MV.canStandAt(map, grassAt.x + 0.5, grassAt.y + 0.5, solids), true, "施設のマスは立てる（通過できる）");
  // 施設は素手で回収できる（耐久未定義→既定 HP10、素手6で2ヒット）
  const hit = mineBlock(placed.override, withItems({}), ME_KEY, grassAt);
  assert.equal(hit.ok, true);
  assert.deepEqual(hit.gained, {}, "1ヒットでは回収できない");
  assert.equal(hit.override.block.hp, 4);
  const dug = mineBlock(hit.override, withItems({}), ME_KEY, grassAt);
  assert.equal(dug.ok, true);
  assert.deepEqual(dug.gained, { bench: 1 });
});

// ---------- インベントリ整理（moveSlot） ----------

const profWith = (hotbar, storage) => {
  const p = inv.parseProfile(null);
  return inv.parseProfile(JSON.parse(JSON.stringify({ ...p, hotbar, storage })));
};
const slot = (id, count) => ({ id, count });

test("整理: 空き枠への移動・異種の交換・同種の合算（あふれは残る）", () => {
  // 移動: hotbar0 の木材を storage3 へ
  let p = profWith([slot("wood", 5), null, null, null, null], Array(10).fill(null));
  p = inv.moveSlot(p, { zone: "hotbar", index: 0 }, { zone: "storage", index: 3 });
  assert.equal(p.hotbar[0], null);
  assert.deepEqual(p.storage[3], { id: "wood", count: 5 });
  // 交換: hotbar0 の石と storage0 の木材
  p = profWith([slot("stone", 2), null, null, null, null], [slot("wood", 7), ...Array(9).fill(null)]);
  p = inv.moveSlot(p, { zone: "hotbar", index: 0 }, { zone: "storage", index: 0 });
  assert.deepEqual(p.hotbar[0], { id: "wood", count: 7 });
  assert.deepEqual(p.storage[0], { id: "stone", count: 2 });
  // 合算: 90 + 20 → 99 + 残り11
  p = profWith([slot("wood", 20), null, null, null, null], [slot("wood", 90), ...Array(9).fill(null)]);
  p = inv.moveSlot(p, { zone: "hotbar", index: 0 }, { zone: "storage", index: 0 });
  assert.deepEqual(p.storage[0], { id: "wood", count: 99 });
  assert.deepEqual(p.hotbar[0], { id: "wood", count: 11 });
  assert.equal(inv.countItem(p, "wood"), 110, "総量は保存される");
  // 同枠・空枠・満杯同種は現状維持、不正な住所は null
  assert.equal(inv.moveSlot(p, { zone: "hotbar", index: 0 }, { zone: "hotbar", index: 0 }), p);
  const p2 = inv.moveSlot(p, { zone: "storage", index: 5 }, { zone: "hotbar", index: 1 });
  assert.equal(p2.hotbar[1], null, "空枠からは動かない");
  assert.equal(inv.moveSlot(p, { zone: "hotbar", index: 9 }, { zone: "storage", index: 0 }), null);
  assert.equal(inv.moveSlot(p, { zone: "vault", index: 0 }, { zone: "storage", index: 0 }), null);
  assert.equal(inv.moveSlot(p, null, { zone: "storage", index: 0 }), null);
});

// ---------- クライアント配線 ----------

test("クライアント: アイコン・設置ブロック描画・固体化が配線されている", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("ItemIcon"), "アイコンコンポーネントが無い");
  assert.ok(client.includes('imageRendering: "pixelated"'), "ピクセル描画指定が無い");
  assert.ok(client.includes("itemIcons"), "設置ブロック用アイコン読み込みが無い");
  assert.ok(client.includes("ov!.block"), "設置ブロックを描いていない");
  assert.ok(client.includes("blockId"), "ブロック選択をタップ判定へ渡していない");
  assert.ok(client.includes("syncBlockBlocked"), "ブロックの固体化が無い");
  assert.ok(client.includes("placedBlockSolid"), "施設を固体から外していない");
  assert.ok(client.includes("selfId"), "自分の ID を受け取っていない");
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"), "utf8");
  assert.ok(panel.includes("ItemIcon"), "経済パネルにアイコンが無い");
  // アイコン描画は共通部品 ItemSlotGrid.tsx へ移設された（PR-A スロット共通化）:
  // パネルはそこから import し、icon を見るのは共通部品側
  assert.ok(panel.includes('from "./ItemSlotGrid"'), "経済パネルが共通スロット部品を使っていない");
  const slotGrid = fs.readFileSync(path.join(rootDir, "app/games/worldbox/ItemSlotGrid.tsx"), "utf8");
  assert.ok(slotGrid.includes(".icon"), "共通スロット部品が icon を見ていない");
});

test("家具は全種 facility で置ける（柵・生け垣も設置対象）", () => {
  const furniture = inv.ITEMS.filter((i) => i.category === "furniture");
  assert.ok(furniture.length > 0);
  for (const item of furniture) {
    assert.equal(item.facility, true, `${item.id} に facility が無い（置けない家具）`);
    const placed = place(null, withItems({ [item.id]: 1 }), ME_KEY, grassAt, item.id);
    assert.equal(placed.ok, true, `${item.id} が設置できない: ${placed.error ?? ""}`);
  }
});

test("クライアント: 設置できないタップは無反応で終わらず、置けるタイルを光らせる", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  // 隣接タップで行為が無いときは理由（断片）を出す
  assert.ok(client.includes("TILE_ERROR_LABEL.tile_blocked"), "行為なしタップへのフィードバックが無い");
  // ブロック選択中の遠いタップは「遠すぎる」を出す
  assert.ok(client.includes("TILE_ERROR_LABEL.too_far"), "遠い設置タップへのフィードバックが無い");
  // ブロック/施設の選択中は置ける隣接タイルをハイライトする
  assert.ok(client.includes("置ける隣接タイルを薄く光らせる"), "設置先ハイライトが無い");
  assert.ok(client.includes('actionForTile(v, { blockId: selDef.id })'), "ハイライトが設置可否判定と一致していない");
});

test("クライアント: 全パネルはステージ内オーバーレイで、スロットはスプライトのみ", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"), "utf8");
  assert.ok(client.includes("panelOverlay"), "オーバーレイ様式が無い");
  assert.ok(!client.includes('margin: "12px auto 0"'), "ページフローに流れるパネルが残っている");
  assert.ok(!panel.includes('margin: "12px auto 0"'), "経済パネルがページフローのまま");
  assert.ok(panel.includes('position: "absolute"'), "経済パネルがオーバーレイでない");
  // スロットはスプライトのみ（名前テキストを出さない）
  assert.ok(client.includes("SlotContent"), "スロット描画が無い");
  assert.ok(client.includes("<SlotContent slot={slot} durFrac="), "ホットバーがスプライト表示でない");
  // インベントリ整理: 1グリッドに両ゾーン + move アクション + 持ち上げ状態
  assert.ok(client.includes('renderInvSlot("storage"'), "ストレージ側グリッドが無い");
  assert.ok(client.includes('renderInvSlot("hotbar"'), "ホットバー側グリッドが無い");
  assert.ok(client.includes('action: "move"'), "move アクションを送っていない");
  assert.ok(client.includes("heldSlot"), "持ち上げ状態が無い");
  assert.ok(client.includes("tapSlot"), "スロットタップ処理が無い");
});
