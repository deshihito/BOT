// AGO WORLD BOX ブロック動作A（未実装だった設置物の動作 第1弾）の検証:
// - 木箱・収納箱のコンテナ化は worldbox-containers.test.mjs 側で検証
// - 植木鉢・プランターへの花の植え付け（サーバー検証つき純粋ロジック）
// - 設置物の光源半径（発光ブロック・マグマ・溶岩を含む）
// - プレゼンスの sit 申告（座りの見た目）の整形
// - クライアント配線（ピアノ・座る・花・じゅうたん・噴水・夜の明かり穴）
// - SE「note」（ピアノの単音）の定義
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
  ["itemById", "parseProfile", "countItem", "addItem"],
);
const inv = await import(invUrl);

const tilesUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts"],
  [
    "worldTileSource", "mapTileAt", "T_GRASS",
    "parseProfile", "countItem",
    "applyPlaceBlock", "applyMineBlock", "applyFlowerAction",
    "isFlowerPotItem", "isSeatItem", "parseTileOverride", "presenceIdFor",
  ],
);
const T = await import(tilesUrl);

const instUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/lobby.ts", "worldbox/items.ts", "worldbox/mobs.ts", "worldbox/objects.ts", "worldbox/instances.ts"],
  ["placedLightRadiusTiles", "PLACED_LIGHT_RADIUS"],
);
const I = await import(instUrl);

const presenceUrl = bundleModule(
  ["worldbox/presence.ts"],
  ["sanitizeHeartbeat"],
);
const P = await import(presenceUrl);

// ---------- 花の植え付け ----------

const map = T.worldTileSource();
function findGrass() {
  for (let y = 0; y < 1024; y++) {
    for (let x = 0; x < 1024; x++) {
      if (T.mapTileAt(map, x, y) === T.T_GRASS) return { x, y };
    }
  }
  throw new Error("grass not found");
}
const grassAt = findGrass();
const NOW = 1_700_000_000_000;
const ME_KEY = "discord:611111111111111111";
const OTHER_KEY = "discord:622222222222222222";
const NO_CTX = { onCapital: false };
const withItems = (items) => inv.parseProfile({ items });

function placedPot(ownerKey = ME_KEY, potId = "planter", items = { [potId]: 1, flower: 2 }) {
  const placed = T.applyPlaceBlock(null, withItems(items), map, ownerKey, grassAt.x, grassAt.y, potId, NOW, NO_CTX);
  assert.equal(placed.ok, true, `設置できる: ${JSON.stringify(placed)}`);
  return placed;
}

test("花: 植木鉢・プランターの判定", () => {
  assert.equal(T.isFlowerPotItem("planter"), true);
  assert.equal(T.isFlowerPotItem("flower_pot"), true);
  assert.equal(T.isFlowerPotItem("bench"), false);
  assert.equal(T.isFlowerPotItem(null), false);
});

test("花: 植えると花を1つ消費して deco に残る", () => {
  const placed = placedPot();
  const r = T.applyFlowerAction(placed.override, placed.profile, map, ME_KEY, grassAt.x, grassAt.y, "plant_flower", NOW);
  assert.equal(r.ok, true);
  assert.equal(r.override.deco, "flower");
  assert.equal(inv.countItem(r.profile, "flower"), 1, "花は2→1");
});

test("花: 植えてある鉢には重ねて植えられない", () => {
  const placed = placedPot();
  const r1 = T.applyFlowerAction(placed.override, placed.profile, map, ME_KEY, grassAt.x, grassAt.y, "plant_flower", NOW);
  const r2 = T.applyFlowerAction(r1.override, r1.profile, map, ME_KEY, grassAt.x, grassAt.y, "plant_flower", NOW);
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "tile_blocked");
});

test("花: 取り除くと花が手元に戻る", () => {
  const placed = placedPot();
  const r1 = T.applyFlowerAction(placed.override, placed.profile, map, ME_KEY, grassAt.x, grassAt.y, "plant_flower", NOW);
  const r2 = T.applyFlowerAction(r1.override, r1.profile, map, ME_KEY, grassAt.x, grassAt.y, "remove_flower", NOW);
  assert.equal(r2.ok, true);
  assert.equal(r2.override.deco, undefined);
  assert.equal(inv.countItem(r2.profile, "flower"), 2, "花は1→2に戻る");
  assert.deepEqual(r2.gained, { flower: 1 });
});

test("花: 他人の鉢には植えられない・花が無ければ植えられない", () => {
  const placed = placedPot();
  const byOther = T.applyFlowerAction(placed.override, withItems({ flower: 1 }), map, OTHER_KEY, grassAt.x, grassAt.y, "plant_flower", NOW);
  assert.equal(byOther.ok, false);
  assert.equal(byOther.error, "not_owner");
  const noFlower = T.applyFlowerAction(placed.override, withItems({}), map, ME_KEY, grassAt.x, grassAt.y, "plant_flower", NOW);
  assert.equal(noFlower.ok, false);
  assert.equal(noFlower.error, "not_enough_items");
});

test("花: 鉢でないブロック・素のタイルには植えられない", () => {
  const bench = T.applyPlaceBlock(null, withItems({ bench: 1 }), map, ME_KEY, grassAt.x, grassAt.y, "bench", NOW, NO_CTX);
  assert.equal(bench.ok, true);
  const r = T.applyFlowerAction(bench.override, withItems({ flower: 1 }), map, ME_KEY, grassAt.x, grassAt.y, "plant_flower", NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, "no_block");
  const bare = T.applyFlowerAction(null, withItems({ flower: 1 }), map, ME_KEY, grassAt.x, grassAt.y, "plant_flower", NOW);
  assert.equal(bare.ok, false);
});

test("花: deco は保存形式を往復し、不正な値は落ちる", () => {
  const placed = placedPot();
  const r = T.applyFlowerAction(placed.override, placed.profile, map, ME_KEY, grassAt.x, grassAt.y, "plant_flower", NOW);
  const parsed = T.parseTileOverride(JSON.parse(JSON.stringify(r.override)));
  assert.equal(parsed.deco, "flower");
  const bogus = T.parseTileOverride({ ownerId: parsed.ownerId, block: parsed.block, deco: "sword" });
  assert.equal(bogus.deco, undefined, "花以外の deco は保存されない");
});

test("花: 鉢を壊すと deco ごと消える", () => {
  const placed = placedPot(ME_KEY, "planter", { planter: 1, flower: 1, wooden_pickaxe: 1, wooden_axe: 1 });
  const r1 = T.applyFlowerAction(placed.override, placed.profile, map, ME_KEY, grassAt.x, grassAt.y, "plant_flower", NOW);
  // HP を削り切るまで掘る（道具ダメージで複数回かかる場合がある）
  let cur = r1.override;
  let prof = r1.profile;
  for (let i = 0; i < 20 && cur?.block; i++) {
    const m = T.applyMineBlock(cur, prof, map, ME_KEY, grassAt.x, grassAt.y, NOW);
    assert.equal(m.ok, true);
    cur = m.override;
    prof = m.profile;
  }
  assert.equal(cur?.block, undefined, "鉢は壊れた");
  assert.equal(cur?.deco, undefined, "花も一緒に消えた");
});

// ---------- 座れる家具 ----------

test("座る: ベンチ・椅子・ソファだけが座れる家具", () => {
  assert.equal(T.isSeatItem("bench"), true);
  assert.equal(T.isSeatItem("chair"), true);
  assert.equal(T.isSeatItem("sofa"), true);
  assert.equal(T.isSeatItem("table_round"), false);
  assert.equal(T.isSeatItem("piano"), false);
  assert.equal(T.isSeatItem(undefined), false);
});

// ---------- 設置物の光 ----------

test("光: 設置物の光源半径（発光ブロック・マグマ・溶岩を含む）", () => {
  assert.equal(I.placedLightRadiusTiles("lamp"), 9);
  assert.equal(I.placedLightRadiusTiles("glowstone_block"), 7);
  assert.equal(I.placedLightRadiusTiles("torch"), 6);
  assert.equal(I.placedLightRadiusTiles("lava_block"), 6);
  assert.equal(I.placedLightRadiusTiles("campfire"), 5);
  assert.equal(I.placedLightRadiusTiles("magma_block"), 5);
  assert.equal(I.placedLightRadiusTiles("stone_block"), 0);
  assert.equal(I.placedLightRadiusTiles("bench"), 0);
  assert.equal(I.placedLightRadiusTiles(null), 0);
  assert.equal(I.placedLightRadiusTiles("nope"), 0);
});

// ---------- プレゼンスの座り申告 ----------

test("プレゼンス: sit は true のときだけ残る", () => {
  const bounds = { minX: -1024, maxX: 1024, minY: -1024, maxY: 1024 };
  const sitting = P.sanitizeHeartbeat({ x: 1, y: 2, vx: 0, vy: 0, face: 1, space: "world", sit: true }, bounds);
  assert.equal(sitting.sit, true);
  const standing = P.sanitizeHeartbeat({ x: 1, y: 2, vx: 0, vy: 0, face: 1, space: "world" }, bounds);
  assert.equal(standing.sit, undefined);
  const fake = P.sanitizeHeartbeat({ x: 1, y: 2, vx: 0, vy: 0, face: 1, space: "world", sit: "yes" }, bounds);
  assert.equal(fake.sit, undefined, "文字列の sit は通さない");
});

// ---------- クライアント配線・SE ----------

const clientSrc = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
const soundSrc = fs.readFileSync(path.join(libDir, "worldbox/sound.ts"), "utf8");
const routeSrc = fs.readFileSync(path.join(rootDir, "app/api/worldbox/tiles/route.ts"), "utf8");

test("配線: ピアノはタップで note SE を音階で鳴らす", () => {
  assert.ok(clientSrc.includes('view.block.itemId === "piano"'), "ピアノのタップ分岐がある");
  assert.ok(clientSrc.includes('playWbSe("note"'), "note SE を鳴らす");
  assert.ok(soundSrc.includes('"note"'), "WbSeName に note がある");
  assert.ok(/note:\s*\(t\)\s*=>/.test(soundSrc), "note のレシピがある");
});

test("配線: 座る・花・明かり・じゅうたん・噴水", () => {
  assert.ok(clientSrc.includes("isSeatItem(view.block.itemId)"), "座れる家具のタップ分岐");
  assert.ok(clientSrc.includes("sitTileRef"), "座り状態を持つ");
  assert.ok(clientSrc.includes('"plant_flower"') && clientSrc.includes('"remove_flower"'), "花の行為を送る");
  assert.ok(routeSrc.includes("applyFlowerAction"), "タイル API が花の行為を検証する");
  assert.ok((clientSrc.match(/placedLightRadiusTiles/g) ?? []).length >= 3, "洞窟と夜の両方で設置物の光を使う");
  assert.ok(clientSrc.includes('ov!.block.itemId === "rug"') || clientSrc.includes('isRug'), "じゅうたんは平たく描く");
  assert.ok(clientSrc.includes('ov.block?.itemId !== "fountain"'), "噴水の水しぶき判定");
  assert.ok(clientSrc.includes('spawnBurst(fxSys, "splash"'), "噴水は splash の粒を出す");
});
