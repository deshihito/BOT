// AGO WORLD BOX ロビー 2F/3F（L2）の検証:
// - 2F ラウンジ（40×28）・3F 展望（32×24）は図形の和集合（長方形だけにしない）
// - 全オブジェクトは床タイルの上にあり重ならず、階段・入口・着地点は歩行可能
// - 床は入口から連結しており、休憩ステーションまで歩いて行ける
// - 使用スプライトはロビー素材＋L3 のアーケード筐体（新規作成・textures.ts 登録済み）
// - セーブ/プレゼンスが "lobby2" / "lobby3" を正しい空間として扱い、座標を階の範囲へ丸める
// - ステーション検証が 2F/3F の休憩でも "rest" を返す（プレゼンス経路・セーブ代替経路とも）
// - プレゼンスルートが 2F/3F のハートビートを階の範囲へ丸め、空間ごとに分離する
// 対象外（L2b、競合 PR マージ後）: WorldBoxClient.tsx の階段遷移・描画、
// relay-core.js の空間分離（#962 と競合中のため今バッチは触らない）。
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

const botApiStubUrl = dataUrl(`
const store = new Map();
globalThis.__wbFloorsStore = store;
export function isBotApiConfigured() { return true; }
export async function kvGet(ns, key) { const v = store.get(ns + " " + key); return v === undefined ? null : v; }
export async function kvSet(ns, key, value) { store.set(ns + " " + key, value); }
export async function kvDelete(ns, key) { store.delete(ns + " " + key); }
export async function kvList(ns) {
  const m = new Map();
  for (const [k, v] of store) if (k.startsWith(ns + " ")) m.set(k.slice(ns.length + 1), v);
  return m;
}
`);
const subdomainUrl = dataUrl(transpile("subdomain.ts"));
const headersStubUrl = dataUrl("export async function cookies() { throw new Error('tests do not use cookies()'); }");
const authUrl = dataUrl(
  transpile("auth.ts").replaceAll('"./subdomain"', JSON.stringify(subdomainUrl)).replaceAll('"next/headers"', JSON.stringify(headersStubUrl)),
);
const auth = await import(authUrl);
const rngUrl = dataUrl(transpile("worldbox/rng.ts"));
const mapgenUrl = dataUrl(transpile("worldbox/mapgen.ts").replaceAll('"./rng"', JSON.stringify(rngUrl)));
const lobbyUrl = dataUrl(transpile("worldbox/lobby.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)));
const tentUrl = dataUrl(
  transpile("worldbox/tent.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl)),
);
const floorsUrl = dataUrl(
  transpile("worldbox/lobby-floors.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl)),
);
const floors = await import(floorsUrl);
const saveUrl = dataUrl(
  transpile("worldbox/save.ts")
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl))
    .replaceAll('"./tent"', JSON.stringify(tentUrl))
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)),
);
const save = await import(saveUrl);
const presenceUrl = dataUrl(transpile("worldbox/presence.ts"));
const presence = await import(presenceUrl);
const presenceOnlineUrl = dataUrl(
  transpile("worldbox/presence-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./presence"', JSON.stringify(presenceUrl)),
);
const saveOnlineUrl = dataUrl(
  transpile("worldbox/save-online.ts").replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl)),
);
const itemsUrl = dataUrl(transpile("worldbox/items.ts"));
const profileUrl = dataUrl(
  transpile("worldbox/profile.ts").replaceAll('"./items"', JSON.stringify(itemsUrl)),
);
const profileOnlineUrl = dataUrl(
  transpile("worldbox/profile-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./profile"', JSON.stringify(profileUrl)),
);
const tilesStubUrl = dataUrl(`export function placedStationKinds() { return []; }`);
const tilesOnlineStubUrl = dataUrl(`export async function loadTileOverride() { return null; }`);
const stationOnlineUrl = dataUrl(
  transpile("worldbox/station-online.ts")
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl))
    .replaceAll('"./lobby-floors"', JSON.stringify(floorsUrl))
    .replaceAll('"./tent"', JSON.stringify(tentUrl))
    .replaceAll('"./presence-online"', JSON.stringify(presenceOnlineUrl))
    .replaceAll('"./save"', JSON.stringify(saveUrl))
    .replaceAll('"./save-online"', JSON.stringify(saveOnlineUrl))
    .replaceAll('"./profile-online"', JSON.stringify(profileOnlineUrl))
    .replaceAll('"./tiles"', JSON.stringify(tilesStubUrl))
    .replaceAll('"./tiles-online"', JSON.stringify(tilesOnlineStubUrl)),
);
const stationOnline = await import(stationOnlineUrl);
const nextServerStubUrl = dataUrl(`
export class NextResponse {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
`);
const metricsOnlineStubUrl = dataUrl(`
export async function recordPresenceMetric() {}
export async function recordFirstStep() {}
export async function bumpMetric() {}
export async function loadDayMetrics() { return null; }
export async function loadUserFirstSteps() { return null; }
export async function loadEconDay() { return null; }
`);
const presenceRoute = await import(
  dataUrl(
    transpile("api/worldbox/presence/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/mapgen"', JSON.stringify(mapgenUrl))
      .replaceAll('"@/lib/worldbox/lobby"', JSON.stringify(lobbyUrl))
      .replaceAll('"@/lib/worldbox/lobby-floors"', JSON.stringify(floorsUrl))
      .replaceAll('"@/lib/worldbox/tent"', JSON.stringify(tentUrl))
      .replaceAll('"@/lib/worldbox/presence-online"', JSON.stringify(presenceOnlineUrl))
      .replaceAll('"@/lib/worldbox/presence"', JSON.stringify(presenceUrl))
      .replaceAll('"@/lib/worldbox/save"', JSON.stringify(saveUrl))
      .replaceAll('"@/lib/worldbox/save-online"', JSON.stringify(saveOnlineUrl))
      .replaceAll('"@/lib/worldbox/metrics-online"', JSON.stringify(metricsOnlineStubUrl)),
  ),
);

process.env.DISCORD_SESSION_SECRET = ["worldbox", "lobby", "floors", "test"].join("-");
const ME = "633333333333333333";
const OTHER = "644444444444444444";
const MY_KEY = `discord:${ME}`;
const OTHER_KEY = `discord:${OTHER}`;
const cookieFor = (id) => `ago_session=${encodeURIComponent(auth.createSession({ id, username: `floor-user-${id.slice(-2)}` }))}`;
function apiRequest(url, method, body, id = ME) {
  return new Request(url, {
    method,
    headers: { cookie: cookieFor(id), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
function putPresenceRaw(key, x, y, space) {
  globalThis.__wbFloorsStore.set(`worldbox_presence ${key}`, JSON.stringify({
    name: "floor-user", x, y, vx: 0, vy: 0, face: 1, space, ts: Date.now(),
  }));
}
function putSaveRaw(key, space, x, y) {
  globalThis.__wbFloorsStore.set(`worldbox_save ${key}`, JSON.stringify({
    version: 6, space, x, y, worldReturn: { x: 512.5, y: 512.5 },
  }));
}

const URL_PRESENCE = "http://localhost/api/worldbox/presence";

// ---------- 階の形状 ----------

function walkableTiles(data) {
  const out = new Set();
  for (let y = 0; y < data.height; y++) {
    for (let x = 0; x < data.width; x++) {
      const id = data.tiles[y * data.width + x];
      if (id !== 0 && id !== 1 && !data.blocked.has(`${x},${y}`)) out.add(`${x},${y}`);
    }
  }
  return out;
}
function reachableFrom(data, sx, sy) {
  const walk = walkableTiles(data);
  const seen = new Set([`${sx},${sy}`]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.pop();
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const k = `${nx},${ny}`;
      if (walk.has(k) && !seen.has(k)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return seen;
}

test("floors: 2F 40×28・3F 32×24 で、1F（126×64）とは別サイズの本物のマップ", () => {
  const f2 = floors.buildLobby2();
  const f3 = floors.buildLobby3();
  assert.equal(f2.width, 40);
  assert.equal(f2.height, 28);
  assert.equal(f3.width, 32);
  assert.equal(f3.height, 24);
  assert.equal(f2.tiles.length, 40 * 28);
  assert.equal(f3.tiles.length, 32 * 24);
  // 決定的キャッシュ（同じインスタンス）
  assert.equal(floors.buildLobby2(), f2);
  assert.equal(floors.buildLobby3(), f3);
});

test("floors: 外形は図形の和集合（長方形ではない）", () => {
  for (const [name, build, w, h, inShape] of [
    ["2F", floors.buildLobby2, 40, 28, floors.inLobby2Shape],
    ["3F", floors.buildLobby3, 32, 24, floors.inLobby3Shape],
  ]) {
    let voidInside = 0;
    let floor = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (inShape(x, y)) floor++;
        else if (x > 0 && y > 0 && x < w - 1 && y < h - 1) voidInside++;
      }
    }
    assert.ok(floor > 0, `${name} に床が無い`);
    assert.ok(voidInside > 0, `${name} が長方形のまま（内側に void が無い）`);
    // 境界はすべて壁（外形の外に接する床セルは L_WALL=1）
    const data = build();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!inShape(x, y)) continue;
        const edge = !inShape(x - 1, y) || !inShape(x + 1, y) || !inShape(x, y - 1) || !inShape(x, y + 1);
        assert.equal(data.tiles[y * w + x] === 1, edge, `${name} (${x},${y}) の壁/床が境界と不一致`);
      }
    }
  }
});

test("floors: 全オブジェクトは床の上にあり重ならず、スプライトは既存素材だけ", () => {
  const spriteDir = path.join(rootDir, "public/img/worldbox/lobby");
  const existing = new Set(fs.readdirSync(spriteDir).map((f) => f.replace(/\.png$/, "")));
  for (const [name, data] of [["2F", floors.buildLobby2()], ["3F", floors.buildLobby3()]]) {
    const seen = new Set();
    for (const o of data.objects) {
      assert.ok(existing.has(o.sprite), `${name} のスプライト ${o.sprite} が素材に無い`);
      for (let dy = 0; dy < o.h; dy++) {
        for (let dx = 0; dx < o.w; dx++) {
          const k = `${o.x + dx},${o.y + dy}`;
          assert.ok(!seen.has(k), `${name} のオブジェクトが重なっている: ${k}`);
          seen.add(k);
          const tile = data.tiles[(o.y + dy) * data.width + o.x + dx];
          assert.notEqual(tile, 0, `${name} の ${o.sprite} が void の上: ${k}`);
          assert.notEqual(tile, 1, `${name} の ${o.sprite} が壁の上: ${k}`);
        }
      }
    }
    // 固体オブジェクトは blocked に載り、通過可の階段は載らない（座席は上に乗って座るため固体でも載らない）
    for (const o of data.objects) {
      const expected = o.solid && !["bench", "chair", "sofa"].includes(o.sprite);
      for (let dy = 0; dy < o.h; dy++) {
        for (let dx = 0; dx < o.w; dx++) {
          assert.equal(data.blocked.has(`${o.x + dx},${o.y + dy}`), expected, `${name} ${o.sprite} の blocked が想定と不一致`);
        }
      }
    }
  }
});

test("floors: 階段・入口・着地点は歩行可能で、入口から全階が連結している", () => {
  const cases = [
    { name: "2F", data: floors.buildLobby2(), entry: floors.LOBBY2_ENTRY, down: floors.LOBBY2_STAIRS_DOWN, up: floors.LOBBY2_STAIRS_UP, landing: floors.LOBBY2_UP_LANDING },
    { name: "3F", data: floors.buildLobby3(), entry: floors.LOBBY3_ENTRY, down: floors.LOBBY3_STAIRS_DOWN, up: [], landing: null },
  ];
  for (const c of cases) {
    const walk = walkableTiles(c.data);
    const entryTile = `${Math.floor(c.entry.x)},${Math.floor(c.entry.y)}`;
    assert.ok(walk.has(entryTile), `${c.name} の入口が歩行不可: ${entryTile}`);
    const reach = reachableFrom(c.data, Math.floor(c.entry.x), Math.floor(c.entry.y));
    for (const s of [...c.down, ...c.up]) {
      const k = `${s.x},${s.y}`;
      assert.ok(walk.has(k), `${c.name} の階段が歩行不可: ${k}`);
      assert.ok(reach.has(k), `${c.name} の階段に入口から行けない: ${k}`);
    }
    if (c.landing) {
      const lk = `${Math.floor(c.landing.x)},${Math.floor(c.landing.y)}`;
      assert.ok(walk.has(lk), `${c.name} の着地点が歩行不可: ${lk}`);
      assert.ok(reach.has(lk), `${c.name} の着地点に入口から行けない: ${lk}`);
    }
    // 休憩ステーションの隣に歩行可能タイルがある（前に立てる）
    const rest = c.data.objects.filter((o) => o.station === "rest");
    assert.ok(rest.length > 0, `${c.name} に休憩ステーションが無い`);
    for (const o of rest) {
      let adjacent = false;
      for (let dy = -1; dy <= o.h; dy++) {
        for (let dx = -1; dx <= o.w; dx++) {
          if (walk.has(`${o.x + dx},${o.y + dy}`) || reach.has(`${o.x + dx},${o.y + dy}`)) adjacent = true;
        }
      }
      assert.ok(adjacent, `${c.name} の休憩 (${o.x},${o.y}) の前に立てない`);
    }
  }
});

test("floors: 2F はラウンジ＋休憩、3F は展望＋休憩の構成", () => {
  const f2 = floors.buildLobby2();
  const f3 = floors.buildLobby3();
  // 2F: 中央にテーブル＋椅子、西翼にソファ、東翼に休憩の本棚＋ソファ
  assert.ok(f2.objects.some((o) => o.sprite === "table_round" && o.x === 20 && o.y === 14), "2F 中央にテーブルが無い");
  assert.ok(f2.objects.some((o) => o.sprite === "sofa" && o.station === "rest"), "2F に休憩ソファが無い");
  assert.ok(f2.objects.some((o) => o.sprite === "bookshelf" && o.station === "rest"), "2F に休憩の本棚が無い");
  // 3F: 北デッキに北向きベンチ、南に休憩コーナー、北の本棚 2 つが L5 の入口アンカー
  assert.ok(f3.objects.some((o) => o.sprite === "bench" && o.y === 3), "3F 北デッキにベンチが無い");
  assert.ok(f3.objects.some((o) => o.sprite === "sofa" && o.station === "rest"), "3F に休憩ソファが無い");
  assert.ok(f3.objects.some((o) => o.sprite === "bookshelf" && o.x === 13 && o.y === 4), "3F の L5 アンカー本棚が無い");
  assert.ok(f3.objects.some((o) => o.sprite === "bookshelf" && o.x === 14 && o.y === 4), "3F の L5 アンカー本棚が無い");
  // 階段の行き先が対応している（2F 上→3F、3F 下→2F の着地点は同じ南踊り場）
  assert.deepEqual(floors.LOBBY3_DOWN_LANDING, floors.LOBBY2_UP_LANDING);
});

test("floors: タイル取得は範囲外で 0 を返す", () => {
  const f2 = floors.buildLobby2();
  const f3 = floors.buildLobby3();
  assert.equal(floors.lobby2TileAt(f2.tiles, -1, 0), 0);
  assert.equal(floors.lobby2TileAt(f2.tiles, 40, 0), 0);
  assert.equal(floors.lobby3TileAt(f3.tiles, 0, 24), 0);
  assert.notEqual(floors.lobby2TileAt(f2.tiles, 20, 14), 0);
  assert.notEqual(floors.lobby3TileAt(f3.tiles, 16, 13), 0);
});

// ---------- セーブ / プレゼンス ----------

test("save: lobby2/lobby3 を空間として保持し、座標を階の範囲へ丸める", () => {
  const s2 = save.parseSave(JSON.stringify({ version: 6, space: "lobby2", x: 999, y: -5, worldReturn: null }));
  assert.equal(s2.space, "lobby2");
  assert.equal(s2.x, 39.5);
  assert.equal(s2.y, 0.5);
  const s3 = save.parseSave(JSON.stringify({ version: 6, space: "lobby3", x: 20, y: 20, worldReturn: null }));
  assert.equal(s3.space, "lobby3");
  assert.deepEqual([s3.x, s3.y], [20, 20]);
  // 往復で空間が保たれる
  const round = save.parseSave(save.serializeSave({ space: "lobby3", x: 15.5, y: 5.5, worldReturn: { x: 1, y: 2 } }));
  assert.equal(round.space, "lobby3");
  assert.deepEqual([round.x, round.y], [15.5, 5.5]);
  // 未知の階はワールドに寄せる（lobby4 は無い）
  const unknown = save.parseSave(JSON.stringify({ version: 6, space: "lobby4", x: 5, y: 5, worldReturn: null }));
  assert.equal(unknown.space, "world");
  // 1F/テントは従来どおり
  assert.equal(save.parseSave(JSON.stringify({ version: 6, space: "lobby", x: 5, y: 5, worldReturn: null })).space, "lobby");
  assert.equal(save.parseSave(JSON.stringify({ version: 6, space: "tent", x: 5, y: 5, worldReturn: null })).space, "tent");
});

test("presence: lobby2/lobby3 を空間として保持し、未知はワールドに寄せる", () => {
  assert.equal(presence.sanitizePresenceSpace("lobby2"), "lobby2");
  assert.equal(presence.sanitizePresenceSpace("lobby3"), "lobby3");
  assert.equal(presence.sanitizePresenceSpace("lobby"), "lobby");
  assert.equal(presence.sanitizePresenceSpace("tent"), "tent");
  assert.equal(presence.sanitizePresenceSpace("lobby4"), "world");
  assert.equal(presence.sanitizePresenceSpace(""), "world");
  assert.equal(presence.sanitizePresenceSpace(null), "world");
});

// ---------- ステーション検証 ----------

test("station: 2F/3F の休憩の前で rest を返す（プレゼンス経路）", async () => {
  // 2F 東翼: 休憩ソファ (35,17) の南に立つ
  putPresenceRaw(MY_KEY, 35.5, 18.5, "lobby2");
  assert.equal(await stationOnline.loadMyLobbyStation(MY_KEY), "rest");
  assert.equal(await stationOnline.loadMyLobbyShopGenre(MY_KEY), null);
  // 3F 南: 休憩ソファ (14,19) の西に立つ
  putPresenceRaw(MY_KEY, 13.5, 19.5, "lobby3");
  assert.equal(await stationOnline.loadMyLobbyStation(MY_KEY), "rest");
  // 2F 中央ラウンジ（どの施設の前でもない）では null
  putPresenceRaw(MY_KEY, 20.5, 15.5, "lobby2");
  assert.equal(await stationOnline.loadMyLobbyStation(MY_KEY), null);
  // 3F 北デッキ（ベンチの前・施設なし）では null
  putPresenceRaw(MY_KEY, 11.5, 4.5, "lobby3");
  assert.equal(await stationOnline.loadMyLobbyStation(MY_KEY), null);
});

test("station: プレゼンスが無い/古い場合はセーブで代替する（2F/3F）", async () => {
  globalThis.__wbFloorsStore.delete(`worldbox_presence ${MY_KEY}`);
  putSaveRaw(MY_KEY, "lobby2", 35.5, 18.5);
  assert.equal(await stationOnline.loadMyLobbyStation(MY_KEY), "rest");
  putSaveRaw(MY_KEY, "lobby3", 13.5, 19.5);
  assert.equal(await stationOnline.loadMyLobbyStation(MY_KEY), "rest");
  putSaveRaw(MY_KEY, "lobby2", 20.5, 15.5);
  assert.equal(await stationOnline.loadMyLobbyStation(MY_KEY), null);
  // ワールドのセーブでは null（室内ではない）
  putSaveRaw(MY_KEY, "world", 512.5, 512.5);
  assert.equal(await stationOnline.loadMyLobbyStation(MY_KEY), null);
});

// ---------- プレゼンスルート ----------

test("presence route: 2F/3F のハートビートを階の範囲へ丸めて保存する", async () => {
  const put2 = await presenceRoute.PUT(apiRequest(URL_PRESENCE, "PUT", {
    name: "floor-user", x: 999, y: -10, vx: 0, vy: 0, face: 1, space: "lobby2",
  }));
  assert.equal(put2.status, 200);
  const stored2 = JSON.parse(globalThis.__wbFloorsStore.get(`worldbox_presence ${MY_KEY}`));
  assert.equal(stored2.space, "lobby2");
  assert.equal(stored2.x, 40);
  assert.equal(stored2.y, 0);
  const put3 = await presenceRoute.PUT(apiRequest(URL_PRESENCE, "PUT", {
    name: "floor-user", x: 999, y: 999, vx: 0, vy: 0, face: 1, space: "lobby3",
  }));
  assert.equal(put3.status, 200);
  const stored3 = JSON.parse(globalThis.__wbFloorsStore.get(`worldbox_presence ${MY_KEY}`));
  assert.equal(stored3.space, "lobby3");
  assert.equal(stored3.x, 32);
  assert.equal(stored3.y, 24);
});

test("presence route: GET は空間ごとに分離する（2F の者は 3F に出ない）", async () => {
  putPresenceRaw(MY_KEY, 20.5, 14.5, "lobby2");
  putPresenceRaw(OTHER_KEY, 16.5, 13.5, "lobby3");
  const res2 = await presenceRoute.GET(apiRequest(`${URL_PRESENCE}?space=lobby2`, "GET"));
  assert.equal(res2.status, 200);
  const players2 = (await res2.json()).players;
  assert.equal(players2.length, 0, "自分以外が 2F にいないはず（他者は 3F）");
  const res3 = await presenceRoute.GET(apiRequest(`${URL_PRESENCE}?space=lobby3`, "GET"));
  const players3 = (await res3.json()).players;
  assert.equal(players3.length, 1);
  assert.equal(players3[0].space, "lobby3");
  // 未知の空間指定はワールドに寄せる（2F/3F の者は出ない）
  const resW = await presenceRoute.GET(apiRequest(`${URL_PRESENCE}?space=lobby4`, "GET"));
  assert.deepEqual((await resW.json()).players, []);
});
