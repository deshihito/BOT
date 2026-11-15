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
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts"],
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

// ---------- S4: スキャン中の書き込み競合（epoch ガード） ----------

// kvList を遅延させられる別スタブ（スキャン開始→書き込み→完了を再現する）
const raceBotApiStubUrl = dataUrl(`
const store = new Map();
let listCalls = 0;
let pending = [];
let hold = false;
export function isBotApiConfigured() { return true; }
export async function kvList() {
  listCalls++;
  const snap = new Map(store);
  if (!hold) return snap;
  return new Promise((resolve) => { pending.push(() => resolve(snap)); });
}
export async function kvGet(ns, key) { return store.has(key) ? store.get(key) : null; }
export async function kvSet(ns, key, value) { store.set(key, value); }
export async function kvDelete(ns, key) { store.delete(key); }
export function __listCalls() { return listCalls; }
export function __pendingLists() { return pending.length; }
export function __holdLists(v) { hold = v; }
export function __releaseLists() { const ps = pending; pending = []; for (const p of ps) p(); }
export function __seed(key, value) { store.set(key, value); }
`);
const raceOnlineUrl = dataUrl(
  transpile("worldbox/tiles-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(raceBotApiStubUrl))
    .replaceAll('"./tiles"', JSON.stringify(tilesUrl)),
);
const raceOnline = await import(raceOnlineUrl);
const raceBotApi = await import(raceBotApiStubUrl);

test("tiles-online(S4): スキャン中の書き込みは古いスナップショットに消されない", async () => {
  const realNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  try {
    await raceOnline.loadTileOverrides(); // キャッシュを温める（空）
    assert.equal(raceBotApi.__listCalls(), 1);
    now += 3_001; // TTL を過ぎさせる
    raceBotApi.__holdLists(true);
    const loading = raceOnline.loadTileOverrides(); // スキャン開始（遅延中）
    // スキャンが kvList に到達するまで1ティック待つ
    for (let i = 0; i < 10 && raceBotApi.__pendingLists() === 0; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(raceBotApi.__pendingLists(), 1, "スキャンが走っている");
    // スキャン中に書き込む（キャッシュへ即時反映されるはず）
    assert.equal(await raceOnline.storeTileOverride(9, 9, OV), true);
    raceBotApi.__releaseLists(); // スキャン完了（書き込み前のスナップショット）
    raceBotApi.__holdLists(false);
    const map = await loading;
    assert.deepEqual(map["9,9"], OV, "書き込みがスキャン結果に残る");
    // 次回読み（キャッシュ）でも残る
    const cached = await raceOnline.loadTileOverrides();
    assert.deepEqual(cached["9,9"], OV);
    assert.equal(raceBotApi.__listCalls(), 2, "余計な再スキャンをしていない");
  } finally {
    Date.now = realNow;
  }
});

// ---------- S4: withUserLock の直列化 ----------

const userLockUrl = dataUrl(transpile("worldbox/user-lock.ts"));
const userLock = await import(userLockUrl);

test("user-lock(S4): 同じキーの並行呼び出しは直列化され、違うキーは並走する", async () => {
  const order = [];
  const job = async (key, name, ms) => {
    await userLock.withUserLock(key, async () => {
      order.push(`${name}:in`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:out`);
    });
  };
  await Promise.all([job("k", "a", 10), job("k", "b", 0), job("other", "c", 0)]);
  // a と b は同じキーなので a が出てから b が入る。c は別キーで並走する。
  assert.ok(order.indexOf("a:out") < order.indexOf("b:in"), `直列化されていない: ${order}`);
  assert.equal(order.filter((e) => e.endsWith(":in")).length, 3);
  assert.equal(order.filter((e) => e.endsWith(":out")).length, 3);
});

// ---------- クライアント配線 ----------

test("tiles-load: ルート GET はキャッシュつき読み取りを使い、クライアントは先読みと救済を持つ", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/tiles/route.ts"), "utf8");
  assert.ok(route.includes("loadTileOverrides"), "タイル GET は全件読みを使う");
  const onlineSrc = fs.readFileSync(path.join(libDir, "worldbox/tiles-online.ts"), "utf8");
  assert.ok(onlineSrc.includes("OVERRIDES_CACHE_TTL_MS"), "全件読みは短TTLキャッシュつき");
  assert.ok(onlineSrc.includes("overridesEpoch"), "スキャン中の書き込み競合に epoch ガードが無い（S4）");
  assert.ok(route.includes("withUserLock(`tile:${tx},${ty}`"), "タイル行為がタイル単位で直列化されていない（S4）");
  assert.ok(route.includes("withUserLock(ownerKey"), "タイル行為がユーザー単位で直列化されていない（S4）");
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("tilesCenterRef"), "取得中心を記録する");
  assert.ok(client.includes("Math.max(dx, dy) >= 48"), "範囲の端に近づいたら先読みする");
  assert.ok((client.match(/refreshTilesRef\.current\(\)/g) ?? []).length >= 3, "スポーン/ワープ/初期位置/先読みから取得する");
  assert.ok(client.includes("PLAYER_RADIUS * 0.5"), "埋没救済は半径半分で判定する");
  assert.ok(client.includes("circleHitsSolid"), "埋没救済が描画ループにある");
});
