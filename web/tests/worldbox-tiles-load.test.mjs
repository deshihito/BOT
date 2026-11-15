// AGO WORLD BOX タイル読み込みの高速化と埋没救済の検証:
// - tiles-online の短TTLキャッシュ（kvList の全件スキャン頻度を落とす）
// - 書き込みのキャッシュ即時反映（自分の設置が次回読みで必ず見える）
// - 埋没判定（半径半分では深い重なりだけ拾い、壁への密着では発火しない）
// - クライアント配線（先読み再取得・スポーン時取得・埋没救済ループ）
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

const tilesUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/tiles.ts"],
  ["tileKey", "parseTileOverride", "parseTileOverrides"],
);

// bot-api スタブ（kvList の呼び出し回数を数える）
const botApiStubUrl = dataUrl(`
const store = new Map();
let listCalls = 0;
export function isBotApiConfigured() { return true; }
export async function kvList() { listCalls++; return new Map(store); }
export async function kvGet(ns, key) { return store.has(key) ? store.get(key) : null; }
export async function kvSet(ns, key, value) { store.set(key, value); }
export async function kvDelete(ns, key) { store.delete(key); }
export function __listCalls() { return listCalls; }
export function __seed(key, value) { store.set(key, value); }
`);
const botApi = await import(botApiStubUrl);

const tilesOnlineUrl = dataUrl(
  transpile("worldbox/tiles-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./tiles"', JSON.stringify(tilesUrl)),
);
const online = await import(tilesOnlineUrl);

const OV = { block: { itemId: "dirt_block", ownerId: "abc" }, ownerId: "abc" };

// ---------- キャッシュ ----------

test("tiles-online: キャッシュが TTL 内の全件スキャンを抑え、TTL 後に取り直す", async () => {
  botApi.__seed("3,4", JSON.stringify(OV));
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const first = await online.loadTileOverrides();
    assert.equal(botApi.__listCalls(), 1);
    assert.deepEqual(first["3,4"], OV);
    const second = await online.loadTileOverrides();
    assert.equal(botApi.__listCalls(), 1, "TTL 内は kvList を呼ばない");
    assert.equal(second, first, "同じキャッシュを返す");
    now += 3_001;
    await online.loadTileOverrides();
    assert.equal(botApi.__listCalls(), 2, "TTL を過ぎたら取り直す");
  } finally {
    Date.now = realNow;
  }
});

test("tiles-online: 書き込みはキャッシュへ即時反映される（自分の設置が見える）", async () => {
  await online.loadTileOverrides(); // 実時刻でキャッシュを温める
  const before = botApi.__listCalls();
  assert.equal(await online.storeTileOverride(7, 8, OV), true);
  const map = await online.loadTileOverrides();
  assert.equal(botApi.__listCalls(), before, "書き込み直後の読みはスキャンしない");
  assert.deepEqual(map["7,8"], OV);
  assert.equal(await online.storeTileOverride(7, 8, null), true);
  const after = await online.loadTileOverrides();
  assert.equal(after["7,8"], undefined, "削除も即時反映される");
});

// ---------- 埋没判定 ----------

const moveUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/move.ts"],
  ["worldTileSource", "mapTileAt", "T_GRASS", "circleHitsSolid", "canStandAt", "findFreeNear", "PLAYER_RADIUS"],
);
const MV = await import(moveUrl);

test("move: 埋没判定は深い重なりだけを拾い、壁への密着では発火しない", () => {
  const map = MV.worldTileSource();
  // 草タイルを探して、そのタイルを設置ブロックで固体化した状況を作る
  let gx = 0;
  let gy = 0;
  outer: for (let y = -20; y < 20; y++) {
    for (let x = -20; x < 20; x++) {
      if (MV.mapTileAt(map, x, y) === MV.T_GRASS) { gx = x; gy = y; break outer; }
    }
  }
  const blocked = new Set([`${gx},${gy}`]);
  const half = MV.PLAYER_RADIUS * 0.5;
  // 壁タイルの中心にいる = 深く埋まっている → 救済が発火する
  assert.equal(MV.circleHitsSolid(map, gx + 0.5, gy + 0.5, half, blocked, { swim: true }), true);
  assert.equal(MV.canStandAt(map, gx + 0.5, gy + 0.5, blocked, { swim: true }), false);
  // 壁に密着（円がちょうど接する位置）では発火しない
  const touchX = gx - MV.PLAYER_RADIUS;
  assert.equal(MV.circleHitsSolid(map, touchX, gy + 0.5, half, blocked, { swim: true }), false);
  assert.equal(MV.canStandAt(map, touchX, gy + 0.5, blocked, { swim: true }), true);
  // 救済先は立てる場所
  const free = MV.findFreeNear(map, gx + 0.5, gy + 0.5, blocked, { swim: true });
  assert.equal(MV.canStandAt(map, free.x, free.y, blocked, { swim: true }), true);
});

// ---------- クライアント配線 ----------

test("tiles-load: ルート GET はキャッシュつき読み取りを使い、クライアントは先読みと救済を持つ", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/tiles/route.ts"), "utf8");
  assert.ok(route.includes("loadTileOverrides"), "タイル GET は全件読みを使う");
  const onlineSrc = fs.readFileSync(path.join(libDir, "worldbox/tiles-online.ts"), "utf8");
  assert.ok(onlineSrc.includes("OVERRIDES_CACHE_TTL_MS"), "全件読みは短TTLキャッシュつき");
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("tilesCenterRef"), "取得中心を記録する");
  assert.ok(client.includes("Math.max(dx, dy) >= 48"), "範囲の端に近づいたら先読みする");
  assert.ok((client.match(/refreshTilesRef\.current\(\)/g) ?? []).length >= 3, "スポーン/ワープ/初期位置/先読みから取得する");
  assert.ok(client.includes("PLAYER_RADIUS * 0.5"), "埋没救済は半径半分で判定する");
  assert.ok(client.includes("circleHitsSolid"), "埋没救済が描画ループにある");
});
