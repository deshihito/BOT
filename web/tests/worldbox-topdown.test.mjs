// AGO WORLD BOX 見下ろし型の検証:
// - マップ生成（決定的・分布・スポーン広場）
// - 移動と当たり判定（固体で止まる・壁ずり・マップ端）
// - プレゼンス純粋ロジック（検証・鮮度・自己除外・上限・デッドレコニング）
// - プレゼンス API（認証・往復・鮮度・自己除外・退室）
// - セーブ v6（往復・旧バージョン破棄）
// - クライアント配線（横スクロール層が残っていないこと）
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
    out.push(
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    );
  }
  return out.join("\n");
}

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import(dataUrl(code));
}

const wb = await loadBundle(
  [
    "worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/move.ts", "worldbox/presence.ts",
    "worldbox/lobby.ts", "worldbox/save.ts", "worldbox/save-source.ts", "worldbox/daynight.ts",
  ],
  [
    "MAP_W", "MAP_H", "MAP_SEED", "T_GRASS", "T_WATER", "T_SAND", "T_TREE", "T_ROCK", "T_DIRT",
    "T_SNOW", "T_SNOW_TREE", "MINIMAP_SIZE", "sampleMinimapTiles", "snowBoundaryAt",
    "generateMap", "isSolidMapTile", "mapTileAt", "mapSpawn",
    "WALK_SPEED", "PLAYER_RADIUS", "stepMove", "canStandAt", "findFreeNear", "circleHitsSolid",
    "PRESENCE_FRESH_MS", "PRESENCE_MAX_PLAYERS", "sanitizeHeartbeat", "parsePresenceEntry",
    "isFreshPresence", "selectVisiblePlayers", "predictPosition", "presenceIdFor",
    "SAVE_VERSION", "serializeSave", "parseSave", "chooseInitialSave", "phaseAtTime",
  ],
);

// ---------- マップ生成 ----------

test("mapgen: 同じシードでは完全に同じマップ、別シードでは異なる", () => {
  const a = wb.generateMap();
  const b = wb.generateMap(wb.MAP_SEED);
  assert.deepEqual([...a.tiles], [...b.tiles]);
  const c = wb.generateMap(42);
  assert.notDeepEqual([...a.tiles], [...c.tiles]);
  assert.equal(a.width, 1024);
  assert.equal(a.height, 1024);
  assert.equal(a.tiles.length, 1024 * 1024);
});

test("mapgen: 生成時間の回帰ガード（実測は約130ms、1秒を超えたら劣化）", () => {
  const t0 = performance.now();
  wb.generateMap();
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `生成が遅すぎる ${ms.toFixed(0)}ms`);
});

test("mapgen: タイル分布（草が最大、水・砂・森・岩・土・雪がすべて存在する）", () => {
  const map = wb.generateMap();
  const counts = new Map();
  for (const t of map.tiles) counts.set(t, (counts.get(t) ?? 0) + 1);
  const total = map.tiles.length;
  const share = (id) => (counts.get(id) ?? 0) / total;
  for (const id of counts.keys()) {
    assert.ok(id >= wb.T_GRASS && id <= wb.T_SNOW_TREE, `未知のタイル ${id}`);
  }
  assert.ok(share(wb.T_GRASS) > 0.3, `草が少なすぎる ${(share(wb.T_GRASS) * 100).toFixed(1)}%`);
  for (const [id, name] of [[wb.T_WATER, "水"], [wb.T_SAND, "砂"], [wb.T_TREE, "森"], [wb.T_DIRT, "土"]]) {
    assert.ok(share(id) > 0.01, `${name}がほぼ無い ${(share(id) * 100).toFixed(2)}%`);
  }
  assert.ok(share(wb.T_WATER) < 0.3, `水が多すぎる ${(share(wb.T_WATER) * 100).toFixed(1)}%`);
  assert.ok(share(wb.T_ROCK) > 0.0005, "岩が無い");
  // 雪原（北の帯）: 雪と雪の木が一定量ある
  assert.ok(share(wb.T_SNOW) > 0.08, `雪が少なすぎる ${(share(wb.T_SNOW) * 100).toFixed(1)}%`);
  assert.ok(share(wb.T_SNOW_TREE) > 0.01, `雪の木がほぼ無い ${(share(wb.T_SNOW_TREE) * 100).toFixed(2)}%`);
  // 草が最大シェア
  const maxOther = Math.max(
    share(wb.T_WATER), share(wb.T_SAND), share(wb.T_TREE), share(wb.T_ROCK), share(wb.T_DIRT),
    share(wb.T_SNOW), share(wb.T_SNOW_TREE),
  );
  assert.ok(share(wb.T_GRASS) > maxOther);
});

test("mapgen: 雪原は北の帯だけにあり、境界は直線でない", () => {
  const map = wb.generateMap();
  const isSnow = (t) => t === wb.T_SNOW || t === wb.T_SNOW_TREE;
  // 帯の南限（中心22%＋揺れ26）より南には雪は無い
  const southLimit = Math.floor(wb.MAP_H * 0.35);
  for (let y = southLimit; y < wb.MAP_H; y++) {
    for (let x = 0; x < wb.MAP_W; x++) {
      assert.ok(!isSnow(map.tiles[y * wb.MAP_W + x]), `南に雪がある (${x}, ${y})`);
    }
  }
  // 北端の行には雪がある
  let northSnow = 0;
  for (let x = 0; x < wb.MAP_W; x++) if (isSnow(map.tiles[x])) northSnow++;
  assert.ok(northSnow > wb.MAP_W * 0.3, `北端に雪が少ない ${northSnow}`);
  // 境界は列ごとに揺れる（直線でない）
  let min = Infinity;
  let max = -Infinity;
  for (let x = 0; x < wb.MAP_W; x++) {
    const b = wb.snowBoundaryAt(wb.MAP_SEED, x);
    if (b < min) min = b;
    if (b > max) max = b;
  }
  assert.ok(max - min > 10, `雪原境界が直線すぎる spread=${(max - min).toFixed(1)}`);
  assert.ok(min >= wb.MAP_H * 0.22 - 27 && max <= wb.MAP_H * 0.22 + 27, "境界が想定帯から外れている");
  // 雪は歩行可、雪の木は固体
  assert.equal(wb.isSolidMapTile(wb.T_SNOW), false);
  assert.equal(wb.isSolidMapTile(wb.T_SNOW_TREE), true);
});

test("mapgen: 川は全列を横切り、スポーン広場は草地のまま", () => {
  const map = wb.generateMap();
  for (let x = 0; x < wb.MAP_W; x++) {
    let hasWater = false;
    for (let y = 0; y < wb.MAP_H; y++) {
      if (map.tiles[y * wb.MAP_W + x] === wb.T_WATER) { hasWater = true; break; }
    }
    assert.ok(hasWater, `列 ${x} に水が無い（川が途切れている）`);
  }
});

test("minimap: 間引きサンプリング（ブロック中心を代表値にする）", () => {
  const tiles = new Uint8Array(8 * 8).fill(wb.T_GRASS);
  tiles[2 * 8 + 2] = wb.T_WATER;
  tiles[2 * 8 + 6] = wb.T_SAND;
  tiles[6 * 8 + 2] = wb.T_ROCK;
  tiles[6 * 8 + 6] = wb.T_SNOW;
  const small = { seed: 0, width: 8, height: 8, tiles };
  const sampled = wb.sampleMinimapTiles(small, 2);
  assert.deepEqual([...sampled], [wb.T_WATER, wb.T_SAND, wb.T_ROCK, wb.T_SNOW]);
  // 実マップ: 256×256 で、最北行に雪、最南行に雪は無い
  const map = wb.generateMap();
  const mm = wb.sampleMinimapTiles(map);
  assert.equal(mm.length, wb.MINIMAP_SIZE * wb.MINIMAP_SIZE);
  let topSnow = 0;
  for (let x = 0; x < wb.MINIMAP_SIZE; x++) {
    const t = mm[x];
    assert.ok(t >= wb.T_GRASS && t <= wb.T_SNOW_TREE, `未知のタイル ${t}`);
    if (t === wb.T_SNOW || t === wb.T_SNOW_TREE) topSnow++;
  }
  assert.ok(topSnow > 0, "ミニマップ最北行に雪が無い");
  for (let x = 0; x < wb.MINIMAP_SIZE; x++) {
    const t = mm[(wb.MINIMAP_SIZE - 1) * wb.MINIMAP_SIZE + x];
    assert.ok(t !== wb.T_SNOW && t !== wb.T_SNOW_TREE, "ミニマップ最南行に雪がある");
  }
});

test("mapgen: スポーン周辺は歩ける草地で、範囲外は岩（固体）", () => {
  const map = wb.generateMap();
  const s = wb.mapSpawn(map);
  assert.equal(wb.mapTileAt(map, Math.floor(s.x), Math.floor(s.y)), wb.T_GRASS);
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      assert.equal(wb.mapTileAt(map, Math.floor(s.x) + dx, Math.floor(s.y) + dy), wb.T_GRASS);
    }
  }
  assert.equal(wb.mapTileAt(map, -1, 0), wb.T_ROCK);
  assert.equal(wb.mapTileAt(map, 0, wb.MAP_H), wb.T_ROCK);
  assert.equal(wb.isSolidMapTile(wb.T_WATER), true);
  assert.equal(wb.isSolidMapTile(wb.T_TREE), true);
  assert.equal(wb.isSolidMapTile(wb.T_ROCK), true);
  assert.equal(wb.isSolidMapTile(wb.T_GRASS), false);
  assert.equal(wb.isSolidMapTile(wb.T_SAND), false);
  assert.equal(wb.isSolidMapTile(wb.T_DIRT), false);
});

// ---------- 移動と当たり判定 ----------

function fakeMap(fill, paint) {
  const tiles = new Uint8Array(8 * 8).fill(fill);
  const map = { seed: 0, width: 8, height: 8, tiles };
  paint?.(tiles);
  return map;
}

test("move: 草地では自由に進み、斜めは等速", () => {
  const map = wb.generateMap();
  const s = wb.mapSpawn(map);
  const r = wb.stepMove(map, { x: s.x, y: s.y }, { x: wb.WALK_SPEED, y: 0 }, 0.5);
  assert.ok(Math.abs(r.x - (s.x + wb.WALK_SPEED * 0.5)) < 1e-9);
  assert.equal(r.hitX, false);
  const d = wb.stepMove(map, { x: s.x, y: s.y }, { x: 3, y: 3 }, 0.25);
  assert.ok(Math.abs(d.x - (s.x + 0.75)) < 1e-9);
  assert.ok(Math.abs(d.y - (s.y + 0.75)) < 1e-9);
});

test("move: 水には入れず、手前で止まる（めり込まない）", () => {
  const map = fakeMap(wb.T_GRASS, (t) => {
    for (let y = 0; y < 8; y++) t[y * 8 + 4] = wb.T_WATER;
  });
  let pos = { x: 2.5, y: 4.5 };
  let hit = false;
  for (let i = 0; i < 40; i++) {
    const r = wb.stepMove(map, pos, { x: wb.WALK_SPEED, y: 0 }, 1 / 30);
    pos = { x: r.x, y: r.y };
    hit = hit || r.hitX;
  }
  assert.ok(hit, "水に当たらなかった");
  assert.ok(pos.x + wb.PLAYER_RADIUS <= 4 + 1e-9, `水にめり込んだ x=${pos.x}`);
  assert.equal(wb.canStandAt(map, pos.x, pos.y), true);
});

test("move: 壁ずり（軸分離で縦だけ進む）とマップ端クランプ", () => {
  const map = fakeMap(wb.T_GRASS, (t) => {
    for (let y = 0; y < 8; y++) t[y * 8 + 4] = wb.T_ROCK;
  });
  const start = { x: 3.5, y: 2.5 };
  const r = wb.stepMove(map, start, { x: wb.WALK_SPEED, y: wb.WALK_SPEED }, 0.3);
  assert.equal(r.hitX, true);
  assert.ok(r.y > start.y, "縦に滑らなかった");
  const edge = wb.stepMove(map, { x: 0.4, y: 0.4 }, { x: -wb.WALK_SPEED, y: -wb.WALK_SPEED }, 1);
  assert.ok(edge.x >= wb.PLAYER_RADIUS - 1e-9);
  assert.ok(edge.y >= wb.PLAYER_RADIUS - 1e-9);
});

test("move: findFreeNear は固体の中から立てる場所へ救済する", () => {
  const map = fakeMap(wb.T_WATER, (t) => {
    t[3 * 8 + 3] = wb.T_GRASS;
    t[3 * 8 + 4] = wb.T_GRASS;
    t[4 * 8 + 3] = wb.T_GRASS;
    t[4 * 8 + 4] = wb.T_GRASS;
  });
  const free = wb.findFreeNear(map, 1.5, 1.5);
  assert.equal(wb.canStandAt(map, free.x, free.y), true);
  const same = wb.findFreeNear(map, free.x, free.y);
  assert.deepEqual(same, free);
});

// ---------- プレゼンス純粋ロジック ----------

test("presence: ハートビート検証（補正と却下）", () => {
  const bounds = { width: 128, height: 128 };
  const ok = wb.sanitizeHeartbeat({ name: "  ago  ", x: 10, y: 20, vx: 3, vy: -3, face: -1 }, bounds);
  assert.equal(ok.name, "ago");
  assert.equal(ok.face, -1);
  const clamped = wb.sanitizeHeartbeat({ name: "x".repeat(40), x: 9999, y: -5, vx: 999, vy: 0 }, bounds);
  assert.equal(clamped.x, 128);
  assert.equal(clamped.y, 0);
  assert.equal(clamped.vx, 16);
  assert.equal(clamped.face, 1);
  assert.equal(clamped.name.length, 24);
  assert.equal(wb.sanitizeHeartbeat({ x: "10", y: 5 }, bounds), null);
  assert.equal(wb.sanitizeHeartbeat(null, bounds), null);
  assert.equal(wb.sanitizeHeartbeat({ x: Number.NaN, y: 5 }, bounds), null);
  const ctrl = wb.sanitizeHeartbeat({ name: "a\nb\tc", x: 1, y: 1 }, bounds);
  assert.ok(!/[\n\t]/.test(ctrl.name));
});

test("presence: parse と鮮度・自己除外・上限", () => {
  const now = 1_700_000_000_000;
  const e = wb.parsePresenceEntry("abcd1234", JSON.stringify({ name: "n", x: 1, y: 2, vx: 0, vy: 0, face: 1, ts: now }));
  assert.equal(e.id, "abcd1234");
  assert.equal(wb.isFreshPresence(e, now), true);
  assert.equal(wb.isFreshPresence({ ...e, ts: now - wb.PRESENCE_FRESH_MS - 1 }, now), false);
  assert.equal(wb.parsePresenceEntry("x", "{壊れた"), null);
  assert.equal(wb.parsePresenceEntry("x", { name: "n", x: 1, y: 2 }), null);

  const entries = [];
  for (let i = 0; i < 40; i++) {
    entries.push({ id: `id${i}`, name: `p${i}`, x: 1, y: 1, vx: 0, vy: 0, face: 1, ts: now - i * 100 });
  }
  entries.push({ id: "stale", name: "old", x: 1, y: 1, vx: 0, vy: 0, face: 1, ts: now - 60_000 });
  const visible = wb.selectVisiblePlayers(entries, "id0", now);
  assert.equal(visible.length, wb.PRESENCE_MAX_PLAYERS);
  assert.ok(!visible.some((p) => p.id === "id0"), "自分が含まれている");
  assert.ok(!visible.some((p) => p.id === "stale"), "古いエントリが含まれている");
});

test("presence: デッドレコニング（外挿は2秒で頭打ち、範囲内に丸める）", () => {
  const bounds = { width: 128, height: 128 };
  const e = { id: "a", name: "n", x: 10, y: 10, vx: 2, vy: -1, face: 1, ts: 1000 };
  assert.deepEqual(wb.predictPosition(e, 1000, bounds), { x: 10, y: 10 });
  const p1 = wb.predictPosition(e, 2000, bounds);
  assert.ok(Math.abs(p1.x - 12) < 1e-9 && Math.abs(p1.y - 9) < 1e-9);
  const p2 = wb.predictPosition(e, 11_000, bounds);
  assert.ok(Math.abs(p2.x - 14) < 1e-9, `外挿が頭打ちでない x=${p2.x}`);
  const p3 = wb.predictPosition({ ...e, x: 127.5, vx: 16 }, 3000, bounds);
  assert.equal(p3.x, 128);
});

test("presence: ID は不透明で安定している", () => {
  const a = wb.presenceIdFor("discord:123456789");
  assert.equal(a, wb.presenceIdFor("discord:123456789"));
  assert.notEqual(a, wb.presenceIdFor("discord:987654321"));
  assert.equal(a.length, 8);
  assert.ok(!a.includes("123456789"));
});

// ---------- セーブ v6 ----------

test("save v6: 往復とクランプ、旧バージョンは破棄される", () => {
  assert.equal(wb.SAVE_VERSION, 6);
  const json = wb.serializeSave({ space: "world", x: 10.5, y: 20.25, worldReturn: null });
  assert.deepEqual(wb.parseSave(json), { space: "world", x: 10.5, y: 20.25, worldReturn: null });
  const clamped = wb.parseSave(wb.serializeSave({ space: "world", x: -3, y: 99999, worldReturn: null }));
  assert.ok(clamped.x >= 0.5 && clamped.y <= wb.MAP_H - 0.5);
  // v5（空間を持たない）以前のセーブは読み込まない
  assert.equal(wb.parseSave(JSON.stringify({ version: 5, x: 64.5, y: 64.5 })), null);
  assert.equal(wb.parseSave(JSON.stringify({ version: 4, x: 64.5, y: 64.5 })), null);
  assert.equal(wb.parseSave(JSON.stringify({ version: 3, slots: [], player: { x: 1, y: 2 }, hp: 10 })), null);
  assert.equal(wb.parseSave(JSON.stringify({ version: 2, player: { x: 1, y: 2 } })), null);
  assert.equal(wb.parseSave(JSON.stringify({ version: 6, space: "world", x: "10", y: 5 })), null);
  assert.equal(wb.parseSave("{壊れた"), null);
  assert.equal(wb.parseSave(null), null);
});

test("save-source: オンライン優先・ローカル移行・新規", () => {
  const pos = { x: 5, y: 6 };
  assert.deepEqual(wb.chooseInitialSave(pos, { x: 1, y: 1 }, true), { state: pos, source: "online", pushLocalToOnline: false });
  const localOnly = wb.chooseInitialSave(null, pos, true);
  assert.equal(localOnly.source, "local");
  assert.equal(localOnly.pushLocalToOnline, true);
  assert.equal(wb.chooseInitialSave(null, pos, false).pushLocalToOnline, false);
  assert.deepEqual(wb.chooseInitialSave(null, null, false), { state: null, source: "new", pushLocalToOnline: false });
});

test("共有時計: 位相は unix 時刻だけで決まり、周期で繰り返す", () => {
  assert.equal(wb.phaseAtTime(1000), wb.phaseAtTime(1000));
  assert.ok(Math.abs(wb.phaseAtTime(1000) - wb.phaseAtTime(1000 + 240)) < 1e-9);
});

// ---------- プレゼンス API ----------

const botApiStubUrl = dataUrl(`
const store = new Map();
globalThis.__wbStore = store;
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
const presenceUrl = dataUrl(transpile("worldbox/presence.ts"));
const presenceOnlineUrl = dataUrl(
  transpile("worldbox/presence-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./presence"', JSON.stringify(presenceUrl)),
);
const nextServerStubUrl = dataUrl(`
export class NextResponse {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
`);
const presenceRoute = await import(
  dataUrl(
    transpile("api/worldbox/presence/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/mapgen"', JSON.stringify(mapgenUrl))
      .replaceAll('"@/lib/worldbox/lobby"', JSON.stringify(lobbyUrl))
      .replaceAll('"@/lib/worldbox/presence-online"', JSON.stringify(presenceOnlineUrl))
      .replaceAll('"@/lib/worldbox/presence"', JSON.stringify(presenceUrl)),
  ),
);

process.env.DISCORD_SESSION_SECRET = ["worldbox", "topdown", "test", "secret"].join("-");
function sessionCookie(id, username) {
  const value = auth.createSession({ id, username });
  return `ago_session=${encodeURIComponent(value)}`;
}
function presenceRequest(method, cookie, body, headers = {}) {
  return new Request("http://localhost/api/worldbox/presence", {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

test("API(presence): ゲストは読めるが書けない・消せない", async () => {
  const res = await presenceRoute.GET(presenceRequest("GET", null));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).players, []);
  assert.equal((await presenceRoute.PUT(presenceRequest("PUT", null, { x: 1, y: 1 }))).status, 401);
  assert.equal((await presenceRoute.DELETE(presenceRequest("DELETE", null))).status, 401);
  assert.equal((await presenceRoute.PUT(presenceRequest("PUT", "ago_session=forged.value", { x: 1, y: 1 }))).status, 401);
});

test("API(presence): ハートビート往復、名前はセッション由来、自分は一覧に出ない", async () => {
  const cookieA = sessionCookie("111111111111111111", "ago-a");
  const cookieB = sessionCookie("222222222222222222", "ago-b");
  const put = await presenceRoute.PUT(presenceRequest("PUT", cookieA, { name: "偽名", x: 64.5, y: 64.5, vx: 2, vy: 0, face: -1 }));
  assert.equal(put.status, 200);
  const seenByB = await (await presenceRoute.GET(presenceRequest("GET", cookieB))).json();
  assert.equal(seenByB.players.length, 1);
  assert.equal(seenByB.players[0].name, "ago-a");
  assert.equal(seenByB.players[0].face, -1);
  assert.ok(!seenByB.players[0].id.includes("111111"));
  const seenByA = await (await presenceRoute.GET(presenceRequest("GET", cookieA))).json();
  assert.equal(seenByA.players.length, 0, "自分が一覧に出ている");
  const seenByGuest = await (await presenceRoute.GET(presenceRequest("GET", null))).json();
  assert.equal(seenByGuest.players.length, 1, "ゲストから見えない");
});

test("API(presence): 不正な body は 400、他オリジンは 403", async () => {
  const cookie = sessionCookie("333333333333333333", "ago-c");
  assert.equal((await presenceRoute.PUT(presenceRequest("PUT", cookie, { x: "abc", y: 1 }))).status, 400);
  assert.equal((await presenceRoute.PUT(presenceRequest("PUT", cookie, { x: 1, y: 1 }, { origin: "http://evil.example" }))).status, 403);
});

test("API(presence): 古いハートビートは一覧から落ち、DELETE で即座に消える", async () => {
  const cookieA = sessionCookie("444444444444444444", "ago-d");
  const cookieB = sessionCookie("555555555555555555", "ago-e");
  await presenceRoute.PUT(presenceRequest("PUT", cookieA, { x: 10, y: 10, vx: 0, vy: 0, face: 1 }));
  let seen = await (await presenceRoute.GET(presenceRequest("GET", cookieB))).json();
  assert.equal(seen.players.filter((p) => p.name === "ago-d").length, 1);
  // 保存値を古く書き換える（鮮度切れの再現）
  const store = globalThis.__wbStore;
  for (const [k, v] of store) {
    if (k.startsWith("worldbox_presence ") && String(v).includes("ago-d")) {
      const parsed = JSON.parse(v);
      parsed.ts = Date.now() - 60_000;
      store.set(k, JSON.stringify(parsed));
    }
  }
  seen = await (await presenceRoute.GET(presenceRequest("GET", cookieB))).json();
  assert.equal(seen.players.filter((p) => p.name === "ago-d").length, 0, "古いエントリが見えている");
  // DELETE の即時反映
  await presenceRoute.PUT(presenceRequest("PUT", cookieA, { x: 10, y: 10, vx: 0, vy: 0, face: 1 }));
  assert.equal((await presenceRoute.DELETE(presenceRequest("DELETE", cookieA))).status, 200);
  seen = await (await presenceRoute.GET(presenceRequest("GET", cookieB))).json();
  assert.equal(seen.players.filter((p) => p.name === "ago-d").length, 0, "DELETE 後も見えている");
});

// ---------- クライアント配線 ----------

test("クライアント: 見下ろし＋プレゼンス配線があり、横スクロール層は残っていない", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("mapgen"), "mapgen を使っていない");
  assert.ok(client.includes("/api/worldbox/presence"), "プレゼンス API を使っていない");
  assert.ok(client.includes("minimap") || client.includes("ミニマップ"), "ミニマップが無い");
  assert.ok(client.includes("/img/nomal.png"), "公式アバターを使っていない");
  // "craft" は旧横スクロール時代の名残チェックだったが、ハンバーガーの
  // クラフトアクション（器のみ）として正規に追加されたため対象から外す。
  for (const dead of ["worldgen", "physics", "enemies", "/api/worldbox/world", "jinrou"]) {
    assert.ok(!client.includes(dead), `旧層が残っている: ${dead}`);
  }
  const catalog = fs.readFileSync(path.join(libDir, "games-catalog.ts"), "utf8");
  const entry = catalog.slice(catalog.indexOf('slug: "worldbox"'), catalog.indexOf('slug: "worldbox"') + 500);
  assert.ok(entry.includes("見下ろし"), "カタログが見下ろし表記でない");
  assert.ok(!entry.includes("横スクロール"), "カタログに旧表記が残っている");
  assert.ok(entry.includes("同時接続"), "カタログに同時接続の表記が無い");
  const textures = fs.readFileSync(path.join(libDir, "worldbox/textures.ts"), "utf8");
  assert.ok(textures.includes("water:"), "水テクスチャが無い");
});

test("クライアント: 地面タイルはダンジョン流用 PNG（grass/dirt/tree/rock）を使う", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("loadDungeonTiles"), "ダンジョンタイルを読み込んでいない");
  assert.ok(client.includes("imageSmoothingEnabled = false"), "ピクセルアートの補間を切っていない");
  assert.ok(!client.includes("textures.leaves"), "木タイルに旧キャノピー合成が残っている");
  const textures = fs.readFileSync(path.join(libDir, "worldbox/textures.ts"), "utf8");
  for (const name of ["grass", "dirt", "tree", "rock"]) {
    assert.ok(textures.includes(`/img/worldbox/${name}.png`), `テクスチャ定義に ${name} が無い`);
    const file = path.join(rootDir, "public/img/worldbox", `${name}.png`);
    assert.ok(fs.existsSync(file), `流用タイルが無い: ${name}.png`);
    const buf = fs.readFileSync(file);
    // PNG 署名 + IHDR の幅・高さ（16〜23バイト目、ビッグエンディアン）
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${name}.png が PNG でない`);
    assert.equal(buf.readUInt32BE(16), 64, `${name}.png の幅が 64 でない`);
    assert.equal(buf.readUInt32BE(20), 64, `${name}.png の高さが 64 でない`);
  }
});

test("クライアント: 雪タイルもダンジョン流用 PNG（snow/snow-tree）を使う", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("sampleMinimapTiles"), "ミニマップの間引きを使っていない");
  assert.ok(client.includes("T_SNOW"), "雪タイルを描画していない");
  const textures = fs.readFileSync(path.join(libDir, "worldbox/textures.ts"), "utf8");
  for (const name of ["snow", "snow-tree"]) {
    assert.ok(textures.includes(`/img/worldbox/${name}.png`), `テクスチャ定義に ${name} が無い`);
    const file = path.join(rootDir, "public/img/worldbox", `${name}.png`);
    assert.ok(fs.existsSync(file), `流用タイルが無い: ${name}.png`);
    const buf = fs.readFileSync(file);
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${name}.png が PNG でない`);
    assert.equal(buf.readUInt32BE(16), 64, `${name}.png の幅が 64 でない`);
    assert.equal(buf.readUInt32BE(20), 64, `${name}.png の高さが 64 でない`);
  }
});
