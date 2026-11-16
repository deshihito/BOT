// AGO WORLD BOX 設置ブロックの HP 制（耐久度）の検証:
// - 最大 HP = アイテムの durability（未定義は既定値）、設置で満タンになる
// - 採掘は1回=1ヒット: HP が残ればアイテムは得られず、0以下で壊れて戻る
// - ダメージは道具ティアで変わる（道具ゲートは維持）
// - 戦争中の他者ブロック破壊も同じ HP 経路
// - hp の無い旧データは満タン扱い、parse は壊れた hp を落とす
// - クライアント配線（ひび割れ描画・ヒット/破壊の FX 分岐・ビューへの hpFrac）
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
  ["itemById", "parseProfile", "countItem"],
);
const inv = await import(invUrl);

const tilesUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts"],
  [
    "worldTileSource", "mapTileAt", "T_GRASS",
    "parseProfile", "countItem",
    "applyPlaceBlock", "applyMineBlock", "tileView", "tileKey", "parseTileOverride", "presenceIdFor",
    "blockMaxHp", "blockHpFraction", "blockMineDamage", "bestToolTier", "BLOCK_MINE_DAMAGE", "DEFAULT_BLOCK_HP",
  ],
);
const T = await import(tilesUrl);

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
const place = (profile, key, itemId) =>
  T.applyPlaceBlock(null, profile, map, key, grassAt.x, grassAt.y, itemId, NOW, NO_CTX);
const mineBlock = (current, profile, key, ctx) =>
  T.applyMineBlock(current, profile, map, key, grassAt.x, grassAt.y, NOW, ctx);

/** 壊れるまで掘り続け、ヒット数を返す。 */
function hitsToBreak(placed, profile, key = ME_KEY, ctx = undefined) {
  let cur = placed.override;
  let hits = 0;
  for (let i = 0; i < 200; i++) {
    const r = mineBlock(cur, profile, key, ctx);
    assert.equal(r.ok, true, `hit ${i + 1} が失敗: ${r.error ?? ""}`);
    hits++;
    if (!r.override?.block) {
      assert.deepEqual(r.gained, { [placed.override.block.itemId]: 1 }, "壊れたときにだけアイテムが戻る");
      return { hits, last: r };
    }
    assert.deepEqual(r.gained, {}, "壊れるまではアイテムは得られない");
    assert.ok(r.override.block.hp > 0, "残っている間は hp が正");
    cur = r.override;
  }
  throw new Error("200ヒットでも壊れなかった");
}

test("HP: 最大 HP はアイテムの durability、未定義（家具）は既定値", () => {
  assert.equal(T.DEFAULT_BLOCK_HP, 10);
  assert.deepEqual([...T.BLOCK_MINE_DAMAGE], [6, 10, 16, 25, 40]);
  assert.equal(T.blockMaxHp(inv.itemById("dirt_block")), 5);
  assert.equal(T.blockMaxHp(inv.itemById("stone_block")), 40);
  assert.equal(T.blockMaxHp(inv.itemById("iron_block")), 120);
  assert.equal(T.blockMaxHp(inv.itemById("bench")), 10, "耐久未定義の家具は既定値");
});

test("HP: 設置すると hp が最大値で保存され、ビューは満タン", () => {
  const placed = place(withItems({ stone_block: 1 }), ME_KEY, "stone_block");
  assert.equal(placed.ok, true);
  assert.equal(placed.override.block.hp, 40);
  assert.equal(placed.view.block.hpFrac, 1);
  const furniture = place(withItems({ bench: 1 }), ME_KEY, "bench");
  assert.equal(furniture.override.block.hp, 10);
});

test("HP: ヒットで減り、残っている間はアイテムが得られない", () => {
  const placed = place(withItems({ stone_block: 1 }), ME_KEY, "stone_block");
  const hit = mineBlock(placed.override, withItems({}), ME_KEY);
  assert.equal(hit.ok, true);
  assert.equal(hit.override.block.hp, 34, "素手ダメージ6");
  assert.deepEqual(hit.gained, {});
  assert.equal(inv.countItem(hit.profile, "stone_block"), 0, "プロフィールに増えない");
  assert.equal(hit.view.block.hpFrac, 34 / 40);
  assert.equal(T.blockHpFraction(hit.override.block), 34 / 40);
});

test("HP: 柔らかいブロックは従来どおり素手1ヒットで壊れてアイテムに戻る", () => {
  const placed = place(withItems({ dirt_block: 1 }), ME_KEY, "dirt_block");
  const { hits, last } = hitsToBreak(placed, withItems({}));
  assert.equal(hits, 1, "土ブロック HP5 < 素手ダメージ6");
  assert.equal(last.override, null);
  assert.equal(inv.countItem(last.profile, "dirt_block"), 1);
});

test("HP: 道具ティアでヒット数が変わる（硬いブロックほど多く、ミスリルで速い）", () => {
  // 石ブロック HP40・道具不要: 素手6→7ヒット、木ツルハシ（実効ティア1）10→4ヒット
  const stone = () => place(withItems({ stone_block: 1 }), ME_KEY, "stone_block");
  assert.equal(hitsToBreak(stone(), withItems({})).hits, 7);
  assert.equal(hitsToBreak(stone(), withItems({ wooden_pickaxe: 1 })).hits, 4);
  assert.equal(hitsToBreak(stone(), withItems({ wooden_axe: 1 })).hits, 4, "斧でも実効ティアに数える");
  // 鉄ブロック HP120・ツルハシ必須: 木10→12ヒット、石16→8、鉄25→5、ミスリル40→3
  const iron = () => place(withItems({ iron_block: 1 }), ME_KEY, "iron_block");
  assert.equal(hitsToBreak(iron(), withItems({ wooden_pickaxe: 1 })).hits, 12);
  assert.equal(hitsToBreak(iron(), withItems({ stone_pickaxe: 1 })).hits, 8);
  assert.equal(hitsToBreak(iron(), withItems({ iron_pickaxe: 1 })).hits, 5);
  assert.equal(hitsToBreak(iron(), withItems({ mithril_pickaxe: 1 })).hits, 3);
  // ダメージ表の単体確認
  const ironDef = inv.itemById("iron_block");
  assert.equal(T.blockMineDamage(withItems({}), ironDef), 6);
  assert.equal(T.blockMineDamage(withItems({ wooden_pickaxe: 1 }), ironDef), 10);
  assert.equal(T.blockMineDamage(withItems({ mithril_pickaxe: 1 }), ironDef), 40);
  assert.equal(T.bestToolTier(withItems({ stone_pickaxe: 1, wooden_pickaxe: 1 }), "pickaxe"), 2);
  assert.equal(T.bestToolTier(withItems({}), "pickaxe"), 0);
});

test("HP: 道具ゲートは維持される（要求道具なしでは1ヒットも入らない）", () => {
  const placed = place(withItems({ iron_block: 1 }), ME_KEY, "iron_block");
  assert.equal(mineBlock(placed.override, withItems({}), ME_KEY).error, "tool_required");
  assert.equal(mineBlock(placed.override, withItems({ mithril_axe: 1 }), ME_KEY).error, "tool_required", "斧では掘れない");
  assert.equal(placed.override.block.hp, 120, "hp は減っていない");
});

test("HP: 戦争破壊も複数ヒット（1ヒット即消しにしない）", () => {
  const placed = place(withItems({ stone_block: 1 }), OTHER_KEY, "stone_block");
  assert.equal(placed.ok, true);
  // 許可が無ければ従来どおり掘れず、hp も減らない
  assert.equal(mineBlock(placed.override, withItems({}), ME_KEY).error, "not_owner");
  assert.equal(placed.override.block.hp, 40);
  // 戦争許可あり: ヒットごとに減り、壊したときに掘った者へ入る
  const hit = mineBlock(placed.override, withItems({}), ME_KEY, { warBreakAllowed: true });
  assert.equal(hit.ok, true);
  assert.equal(hit.override.block.hp, 34);
  assert.deepEqual(hit.gained, {});
  const { hits, last } = hitsToBreak({ override: hit.override }, withItems({}), ME_KEY, { warBreakAllowed: true });
  assert.equal(hits, 6, "残り34を素手6で掘る");
  assert.equal(inv.countItem(last.profile, "stone_block"), 1, "略奪ルール: 掘った者の所持品に入る");
});

test("HP: hp の無い旧データは満タン扱いで、ヒットから記録が付く", () => {
  const selfId = T.presenceIdFor(ME_KEY);
  const legacy = { block: { itemId: "stone_block", ownerId: selfId }, ownerId: selfId };
  const view = T.tileView(map, { [T.tileKey(grassAt.x, grassAt.y)]: legacy }, grassAt.x, grassAt.y, NOW, ME_KEY);
  assert.equal(view.block.hpFrac, 1, "旧データは満タン");
  assert.equal(T.blockHpFraction(legacy.block), 1);
  const hit = mineBlock(legacy, withItems({}), ME_KEY);
  assert.equal(hit.ok, true);
  assert.equal(hit.override.block.hp, 34, "最大40からダメージ分を引く");
});

test("HP: parse は hp を往復し、壊れた hp は落とす", () => {
  const ok = T.parseTileOverride({ block: { itemId: "stone_block", ownerId: "abc", hp: 17 }, ownerId: "abc" });
  assert.deepEqual(ok.block, { itemId: "stone_block", ownerId: "abc", hp: 17 });
  const roundtrip = T.parseTileOverride(JSON.parse(JSON.stringify(ok)));
  assert.equal(roundtrip.block.hp, 17);
  for (const bad of ["17", -3, 0, NaN, null]) {
    const parsed = T.parseTileOverride({ block: { itemId: "stone_block", ownerId: "abc", hp: bad }, ownerId: "abc" });
    assert.equal(parsed.block.hp, undefined, `hp=${String(bad)} は落とす`);
  }
  const none = T.parseTileOverride({ block: { itemId: "stone_block", ownerId: "abc" }, ownerId: "abc" });
  assert.deepEqual(none.block, { itemId: "stone_block", ownerId: "abc" }, "hp 無しはそのまま");
});

test("クライアント: ひび割れ描画とヒット/破壊の FX 分岐が配線されている", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("drawBlockCracks"), "ひび割れ描画が無い");
  assert.ok(client.includes("BLOCK_CRACK_LINES"), "ひび割れの線定義が無い");
  assert.ok(client.includes("blockHpFraction(ov!.block)"), "描画が HP 割合を見ていない");
  assert.ok(client.includes('data.override?.block ? "mine"'), "残るヒットと破壊で FX を分けていない");
  assert.ok(client.includes("blockHpFraction"), "tiles から HP 割合を import していない");
});
