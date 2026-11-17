// AGO WORLD BOX 地形 HP・道具耐久・道具の棲み分けの検証（2026-11-17）:
// - 岩・木は HP 制（ミスリルでも岩は1発で壊れない）
// - 道具は使うたびに摩耗し、尽きたら壊れる（カタログの durability が正）
// - 剣はブロック採掘に使えない（ピッケル枠に入らない）
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
    "ITEMS", "itemById", "parseProfile", "serializeProfile", "countItem",
    "bestToolItem", "toolHpOf", "toolDurabilityFraction", "wearTool", "parseToolHp",
  ],
);
const inv = await import(invUrl);

const tilesUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts"],
  [
    "worldTileSource", "mapTileAt", "T_GRASS", "T_TREE", "T_ROCK", "T_DIRT",
    "applyTileAction", "applyPlaceBlock", "applyMineBlock", "tileView", "actionForTile", "tileKey",
    "TERRAIN_ROCK_HP", "TERRAIN_TREE_HP", "terrainMaxHp", "terrainHpFraction",
  ],
);
const T = await import(tilesUrl);

const NOW = 1_700_000_000_000;
const ME_KEY = "discord:611111111111111111";
const withItems = (items, extra = {}) => inv.parseProfile({ items, ...extra });
const map = T.worldTileSource();

function findTile(id, sx = 60, sy = 60) {
  for (let y = sy; y < sy + 400; y++) {
    for (let x = sx; x < sx + 400; x++) {
      if (T.mapTileAt(map, x, y) === id) return { x, y };
    }
  }
  throw new Error(`tile ${id} not found`);
}
const rockAt = findTile(T.T_ROCK);
const grassAt = findTile(T.T_GRASS, 300, 300);

// ---------- 道具の耐久（profile 層） ----------

test("耐久: wearTool は最良の道具から削れ、尽きたら1本壊れて次が満タンになる", () => {
  const p = withItems({ wooden_pickaxe: 1, mithril_pickaxe: 1 });
  // 最良（ミスリル）が使われる
  assert.equal(inv.bestToolItem(p, "pickaxe").id, "mithril_pickaxe");
  const w1 = inv.wearTool(p, "pickaxe");
  assert.equal(w1.brokeItemId, null);
  assert.equal(inv.toolHpOf(w1.profile, "mithril_pickaxe"), 499);
  assert.equal(inv.toolHpOf(w1.profile, "wooden_pickaxe"), 60, "使っていない道具は減らない");
  // 残り1まで削ってから使うと壊れる
  const almost = withItems({ wooden_pickaxe: 2 }, { toolHp: { wooden_pickaxe: 1 } });
  const w2 = inv.wearTool(almost, "pickaxe");
  assert.equal(w2.brokeItemId, "wooden_pickaxe");
  assert.equal(inv.countItem(w2.profile, "wooden_pickaxe"), 1, "壊れたのは1本だけ");
  assert.equal(inv.toolHpOf(w2.profile, "wooden_pickaxe"), 60, "次の1本は満タン");
  // 道具が無ければ無変化
  const w3 = inv.wearTool(withItems({}), "pickaxe");
  assert.equal(w3.brokeItemId, null);
});

test("耐久: toolHp は parse/serialize を往復し、不正値は落ちる", () => {
  const p = inv.parseProfile({ items: { iron_axe: 1 }, toolHp: { iron_axe: 100, stone_sword: 9999, wood: 5 } });
  assert.equal(inv.toolHpOf(p, "iron_axe"), 100);
  const s = inv.serializeProfile(p);
  const p2 = inv.parseProfile(JSON.parse(s));
  assert.equal(inv.toolHpOf(p2, "iron_axe"), 100);
  assert.deepEqual(p2.toolHp, { iron_axe: 100 }, "満タン以上・道具以外は保存されない");
  assert.equal(inv.toolDurabilityFraction(p, "iron_axe"), 100 / 250);
  assert.equal(inv.toolDurabilityFraction(p, "wood"), null, "道具でないものは null");
});

// ---------- 地形 HP と行為の配線 ----------

test("地形HP: 岩はミスリルでも1発で壊れず、ヒットでツルハシが摩耗する", () => {
  const p = withItems({ mithril_pickaxe: 1 });
  const hit = T.applyTileAction(null, p, map, ME_KEY, "mine", rockAt.x, rockAt.y, undefined, NOW);
  assert.equal(hit.ok, true);
  assert.deepEqual(hit.gained, {});
  assert.equal(hit.override.hp, T.TERRAIN_ROCK_HP - 40);
  assert.equal(hit.view.hpFrac, (T.TERRAIN_ROCK_HP - 40) / T.TERRAIN_ROCK_HP, "ビューに残り割合が出る");
  assert.equal(inv.toolHpOf(hit.profile, "mithril_pickaxe"), 499, "1ヒットで耐久が1減る");
  const hit2 = T.applyTileAction(hit.override, hit.profile, map, ME_KEY, "mine", rockAt.x, rockAt.y, undefined, NOW);
  assert.equal(hit2.override.tile, T.T_DIRT);
  assert.deepEqual(hit2.gained, { stone: 2 });
});

test("地形HP: 残り耐久1のツルハシは掘った瞬間に壊れて結果に載る", () => {
  const p = withItems({ wooden_pickaxe: 1 }, { toolHp: { wooden_pickaxe: 1 } });
  const hit = T.applyTileAction(null, p, map, ME_KEY, "mine", rockAt.x, rockAt.y, undefined, NOW);
  assert.equal(hit.ok, true);
  assert.equal(hit.broke, "wooden_pickaxe");
  assert.equal(inv.countItem(hit.profile, "wooden_pickaxe"), 0);
  // ツルハシが無くなれば次は掘れない
  const next = T.applyTileAction(hit.override, hit.profile, map, ME_KEY, "mine", rockAt.x, rockAt.y, undefined, NOW);
  assert.equal(next.error, "tool_required");
});

test("地形HP: 耕すとクワが摩耗する", () => {
  const p = withItems({ wooden_hoe: 1 });
  const tilled = T.applyTileAction(null, p, map, ME_KEY, "till", grassAt.x, grassAt.y, undefined, NOW);
  assert.equal(tilled.ok, true);
  assert.equal(inv.toolHpOf(tilled.profile, "wooden_hoe"), 59);
});

// ---------- ブロック採掘の摩耗と棲み分け ----------

test("ブロック採掘: ダメージ源の道具が摩耗する（柔らかいブロック×斧）", () => {
  const p = withItems({ dirt_block: 1, wooden_axe: 1 });
  const placed = T.applyPlaceBlock(null, p, map, ME_KEY, grassAt.x, grassAt.y, "dirt_block", NOW, { onCapital: false });
  assert.equal(placed.ok, true);
  const dug = T.applyMineBlock(placed.override, placed.profile, map, ME_KEY, grassAt.x, grassAt.y, NOW);
  assert.equal(dug.ok, true);
  assert.deepEqual(dug.gained, { dirt_block: 1 });
  assert.equal(inv.toolHpOf(dug.profile, "wooden_axe"), 59);
});

test("棲み分け: 自分のブロックでも剣・クワでは掘れず、斧・ツルハシでのみ掘れる", () => {
  const view = {
    x: 0, y: 0, tile: T.T_GRASS, farmland: false, stump: false, crop: null, hpFrac: 1,
    block: { itemId: "stone_block", mine: true, hpFrac: 1 }, mine: true,
  };
  assert.equal(T.actionForTile(view, { tool: "sword" }), null, "剣はピッケル枠に入らない");
  assert.equal(T.actionForTile(view, { tool: "hoe" }), null, "クワでも掘れない");
  assert.deepEqual(T.actionForTile(view, { tool: "axe" }), { action: "mine_block" });
  assert.deepEqual(T.actionForTile(view, { tool: "pickaxe" }), { action: "mine_block" });
  // 門は剣タップで開閉に戻る（採掘優先にならない）
  const gate = { ...view, block: { itemId: "wooden_gate", mine: true, hpFrac: 1 } };
  assert.deepEqual(T.actionForTile(gate, { tool: "sword" }), { action: "toggle_gate" });
  assert.deepEqual(T.actionForTile(gate, { tool: "pickaxe" }), { action: "mine_block" });
});

test("地形HP: 対象外タイルの最大 HP は 0 で割合は常に 1", () => {
  assert.equal(T.terrainMaxHp(T.T_GRASS), 0);
  assert.equal(T.terrainMaxHp(T.T_ROCK), T.TERRAIN_ROCK_HP);
  assert.equal(T.terrainHpFraction(null, T.T_ROCK), 1);
  assert.equal(T.terrainHpFraction({ ownerId: "x", hp: 30 }, T.T_ROCK), 0.5);
});
