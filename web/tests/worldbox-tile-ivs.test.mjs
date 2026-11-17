// WORLD BOX マスの個体値（仕様書 §3.1 / §4.2）の検証。
// - 個体値は座標＋固定シードからの決定的な純関数（保存しない）
// - 豊穣度は作物の成長時間と収穫量に、純度は岩の採掘ボーナスに効く
import assert from "node:assert/strict";
import test from "node:test";
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

const mapgenUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts"],
  ["tileIvsAt", "worldTileSource", "mapTileAt", "T_GRASS", "T_ROCK"],
);
const G = await import(mapgenUrl);

const invUrl = bundleModule(
  ["worldbox/items.ts", "worldbox/profile.ts"],
  ["parseProfile", "countItem", "cropBySeedId"],
);
const inv = await import(invUrl);

const tilesUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts"],
  [
    "worldTileSource", "mapTileAt", "T_GRASS", "T_ROCK",
    "applyTileAction", "tileView",
    "fertilityGrowthFactor", "fertilityBonusYield", "purityBonusStone", "purityBonusCoal",
  ],
);
const T = await import(tilesUrl);

// ---------- 個体値そのもの ----------

test("個体値: 決定的で、同じ座標は常に同じ値", () => {
  for (const [x, y] of [[0, 0], [123, -456], [-999, 888], [60, 60]]) {
    assert.deepEqual(G.tileIvsAt(x, y), G.tileIvsAt(x, y));
  }
});

test("個体値: 豊穣度・純度・標高はすべて 0〜100 の整数", () => {
  for (let y = -120; y < 120; y += 7) {
    for (let x = -120; x < 120; x += 7) {
      const ivs = G.tileIvsAt(x, y);
      for (const v of [ivs.fertility, ivs.purity, ivs.altitude]) {
        assert.ok(Number.isInteger(v) && v >= 0 && v <= 100, `${x},${y}: ${v}`);
      }
    }
  }
});

test("個体値: 座標が違えば値もばらつく（全タイル一律ではない）", () => {
  const ferts = new Set();
  const pures = new Set();
  for (let i = 0; i < 200; i++) {
    const ivs = G.tileIvsAt(i * 13, i * 29);
    ferts.add(ivs.fertility);
    pures.add(ivs.purity);
  }
  assert.ok(ferts.size > 30, `fertility kinds=${ferts.size}`);
  assert.ok(pures.size > 30, `purity kinds=${pures.size}`);
});

// ---------- 効果の純粋関数 ----------

test("効果: 豊穣度の成長倍率は 0→1.25 / 50→1 / 100→0.75", () => {
  assert.equal(T.fertilityGrowthFactor(0), 1.25);
  assert.equal(T.fertilityGrowthFactor(50), 1);
  assert.equal(T.fertilityGrowthFactor(100), 0.75);
});

test("効果: 収穫ボーナスは 65 で +1、85 で +2", () => {
  assert.equal(T.fertilityBonusYield(0), 0);
  assert.equal(T.fertilityBonusYield(64), 0);
  assert.equal(T.fertilityBonusYield(65), 1);
  assert.equal(T.fertilityBonusYield(84), 1);
  assert.equal(T.fertilityBonusYield(85), 2);
  assert.equal(T.fertilityBonusYield(100), 2);
});

test("効果: 純度ボーナスは石材 70 で +1、石炭 85 で +1", () => {
  assert.equal(T.purityBonusStone(69), 0);
  assert.equal(T.purityBonusStone(70), 1);
  assert.equal(T.purityBonusCoal(84), 0);
  assert.equal(T.purityBonusCoal(85), 1);
});

// ---------- タイル行為への統合 ----------

const NOW = 1_700_000_000_000;
const ME_KEY = "discord:611111111111111111";
const map = T.worldTileSource();
const withItems = (items) => inv.parseProfile({ items });

function findTileWhere(tileId, pred, startX = -300, startY = -300) {
  for (let y = startY; y < startY + 600; y++) {
    for (let x = startX; x < startX + 600; x++) {
      if (T.mapTileAt(map, x, y) === tileId && pred(G.tileIvsAt(x, y))) return { x, y };
    }
  }
  throw new Error("tile not found");
}

test("統合: 豊穣な土地は作物の成長が速く、収穫量も増える", () => {
  const rich = findTileWhere(G.T_GRASS, (ivs) => ivs.fertility >= 85);
  const poor = findTileWhere(G.T_GRASS, (ivs) => ivs.fertility < 65);
  const crop = inv.cropBySeedId("wheat_seed");
  assert.ok(crop, "wheat_seed の作物がある");

  const plantOn = (at) => {
    const tilled = T.applyTileAction(null, withItems({ wooden_hoe: 1, wheat_seed: 1 }), map, ME_KEY, "till", at.x, at.y, undefined, NOW);
    assert.equal(tilled.ok, true, "till");
    const planted = T.applyTileAction(tilled.override, tilled.profile, map, ME_KEY, "plant", at.x, at.y, "wheat_seed", NOW);
    assert.equal(planted.ok, true, "plant");
    return planted;
  };
  const richPlanted = plantOn(rich);
  const poorPlanted = plantOn(poor);
  const richSpan = richPlanted.override.crop.readyAt - NOW;
  const poorSpan = poorPlanted.override.crop.readyAt - NOW;
  assert.ok(richSpan < poorSpan, `豊穣 ${richSpan} < 貧地 ${poorSpan}`);

  const harvested = T.applyTileAction(
    richPlanted.override, richPlanted.profile, map, ME_KEY, "harvest", rich.x, rich.y, undefined,
    richPlanted.override.crop.readyAt,
  );
  assert.equal(harvested.ok, true, "harvest");
  assert.equal(harvested.gained[crop.produceId], crop.produceCount + 2, "豊穣度85以上は収穫+2");
});

test("統合: 純度が高い岩は石材+1と石炭+1が混ざる", () => {
  const rich = findTileWhere(G.T_ROCK, (ivs) => ivs.purity >= 85);
  let r = T.applyTileAction(null, withItems({ mithril_pickaxe: 1 }), map, ME_KEY, "mine", rich.x, rich.y, undefined, NOW);
  assert.equal(r.ok, true, "mine 1");
  // 岩 HP60・ミスリル 40/ヒット → 2ヒットで壊れる。1ヒット目は何も得られない
  assert.deepEqual(r.gained, {});
  r = T.applyTileAction(r.override, r.profile, map, ME_KEY, "mine", rich.x, rich.y, undefined, NOW);
  assert.equal(r.ok, true, "mine 2");
  assert.equal(r.gained.stone, 3, "石材は基本2+純度ボーナス1");
  assert.equal(r.gained.coal, 1, "純度85以上は石炭+1");
});

test("統合: 純度が低い岩はボーナスなし", () => {
  const poor = findTileWhere(G.T_ROCK, (ivs) => ivs.purity < 70);
  let r = T.applyTileAction(null, withItems({ mithril_pickaxe: 1 }), map, ME_KEY, "mine", poor.x, poor.y, undefined, NOW);
  r = T.applyTileAction(r.override, r.profile, map, ME_KEY, "mine", poor.x, poor.y, undefined, NOW);
  assert.equal(r.ok, true, "mine");
  assert.equal(r.gained.stone, 2);
  assert.equal(r.gained.coal, undefined);
});

test("統合: TileView に個体値が載る", () => {
  const view = T.tileView(map, {}, 60, 60, NOW, null);
  assert.deepEqual(view.ivs, G.tileIvsAt(60, 60));
});
