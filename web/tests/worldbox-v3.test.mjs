// AGO WORLD BOX v3 の検証:
// - 共有ワールド同期ロジック（差分適用・LWWマージ・検証・スポーン保護）
// - 共有ワールド API（ゲスト読取可・書込はログイン必須・却下理由・上限）
// - セーブ v2→v3 移行（タイル破棄、所持品・HP・位置は保持）
// - 共有時計（unix 時刻から位相が決定的に決まる）
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
    "worldbox/blocks.ts", "worldbox/items.ts", "worldbox/worldgen.ts", "worldbox/inventory.ts",
    "worldbox/daynight.ts", "worldbox/health.ts", "worldbox/save.ts", "worldbox/world-sync.ts",
  ],
  [
    "AIR", "GRASS", "DIRT", "STONE", "WOOD", "BEDROCK", "TORCH",
    "WORLD_W", "WORLD_H", "WORLD_SEED", "generateWorld", "getTile", "findSpawn",
    "SLOT_COUNT", "createInventory", "countOf", "addItem",
    "phaseAtTime", "DAY_CYCLE_SEC",
    "serializeSave", "parseSave", "encodeTiles", "SAVE_VERSION",
    "diffKey", "emptySharedWorld", "isSpawnProtected", "validateChange", "mergeChanges",
    "applyDiffs", "diffTilesAgainst", "serializeSharedWorld", "parseSharedWorld", "MAX_CHANGE_BATCH",
  ],
);

const clientSrc = fs.readFileSync(path.join(rootDir, "app", "games", "worldbox", "WorldBoxClient.tsx"), "utf8");

/** スポーンから遠い石セルを1つ探す（変更テスト用）。 */
function findStoneCell(world) {
  for (let x = 10; x < 100; x++) {
    for (let y = 30; y < 55; y++) {
      if (wb.getTile(world, x, y) === wb.STONE) return { x, y };
    }
  }
  throw new Error("stone cell not found");
}

// ---------- 共有時計 ----------

test("共有時計: 位相は unix 時刻だけで決まり、周期で繰り返す", () => {
  assert.equal(wb.phaseAtTime(0), 0);
  assert.equal(wb.phaseAtTime(wb.DAY_CYCLE_SEC / 2), 0.5);
  assert.equal(wb.phaseAtTime(37.5), wb.phaseAtTime(37.5 + wb.DAY_CYCLE_SEC));
  assert.equal(wb.phaseAtTime(37.5), wb.phaseAtTime(37.5 + wb.DAY_CYCLE_SEC * 7));
  assert.equal(wb.phaseAtTime(-wb.DAY_CYCLE_SEC / 2), 0.5, "負の時刻でも 0〜1 に収まる");
  const p = wb.phaseAtTime(1_700_000_000);
  assert.ok(p >= 0 && p < 1);
  assert.equal(p, wb.phaseAtTime(1_700_000_000), "同じ時刻は同じ位相（決定的）");
});

// ---------- world-sync ----------

test("world-sync: 差分を適用すると生成地形が書き換わる", () => {
  const world = wb.generateWorld(wb.WORLD_SEED);
  const cell = findStoneCell(world);
  const key = wb.diffKey(cell.x, cell.y);
  wb.applyDiffs(world, { [key]: wb.AIR });
  assert.equal(wb.getTile(world, cell.x, cell.y), wb.AIR);
  // 範囲外・不正な差分は無視される
  wb.applyDiffs(world, { "999,999": wb.STONE, "bad-key": wb.STONE, [`${cell.x},${cell.y}`]: 999 });
  assert.equal(wb.getTile(world, cell.x, cell.y), wb.AIR);
});

test("world-sync: マージは LWW で、生成地形に戻す変更は差分から落ち、epoch は実変更時だけ進む", () => {
  const cell = findStoneCell(wb.generateWorld(wb.WORLD_SEED));
  const key = wb.diffKey(cell.x, cell.y);
  let s = wb.emptySharedWorld();
  let r = wb.mergeChanges(s, [{ x: cell.x, y: cell.y, tile: wb.AIR }]);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.data.diffs[key], wb.AIR);
  assert.equal(r.data.epoch, 1);
  s = r.data;
  // 同じ変更の再送は epoch を進めない
  r = wb.mergeChanges(s, [{ x: cell.x, y: cell.y, tile: wb.AIR }]);
  assert.equal(r.data.epoch, 1, "冪等な再送で epoch が進んだ");
  // 後勝ち（LWW）
  r = wb.mergeChanges(r.data, [{ x: cell.x, y: cell.y, tile: wb.DIRT }]);
  assert.equal(r.data.diffs[key], wb.DIRT);
  assert.equal(r.data.epoch, 2);
  // 生成地形（石）に戻すと差分自体が消える
  r = wb.mergeChanges(r.data, [{ x: cell.x, y: cell.y, tile: wb.STONE }]);
  assert.ok(!(key in r.data.diffs), "地形と同じ値の差分が残った");
  assert.equal(r.data.epoch, 3);
});

test("world-sync: 検証の却下理由（範囲外・不正タイル・岩盤・スポーン保護）", () => {
  const world = wb.generateWorld(wb.WORLD_SEED);
  const spawn = wb.findSpawn(world);
  const surf = world.surfaces[spawn.x];
  assert.equal(wb.validateChange({ x: -1, y: 10, tile: wb.DIRT }), "out_of_bounds");
  assert.equal(wb.validateChange({ x: wb.WORLD_W, y: 10, tile: wb.DIRT }), "out_of_bounds");
  assert.equal(wb.validateChange({ x: 10, y: 10, tile: 999 }), "invalid_tile");
  assert.equal(wb.validateChange({ x: 10, y: 10, tile: wb.BEDROCK }), "bedrock", "岩盤を置けた");
  assert.equal(wb.validateChange({ x: 10, y: wb.WORLD_H - 1, tile: wb.AIR }), "bedrock", "岩盤を掘れた");
  assert.equal(wb.validateChange({ x: spawn.x, y: surf, tile: wb.AIR }), "spawn_protected");
  assert.equal(wb.validateChange({ x: spawn.x, y: surf, tile: wb.STONE }), "spawn_protected");
  assert.equal(wb.isSpawnProtected(spawn.x, surf), true);
  assert.equal(wb.isSpawnProtected(10, surf), false);
  const cell = findStoneCell(world);
  assert.equal(wb.validateChange({ x: cell.x, y: cell.y, tile: wb.AIR }), null);
  // mergeChanges 経由でも却下が返る
  const r = wb.mergeChanges(wb.emptySharedWorld(), [{ x: spawn.x, y: surf, tile: wb.AIR }]);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].reason, "spawn_protected");
  assert.equal(r.data.epoch, 0);
});

test("world-sync: serialize/parse の往復と、parse は不正な差分だけを落とす", () => {
  const cell = findStoneCell(wb.generateWorld(wb.WORLD_SEED));
  const key = wb.diffKey(cell.x, cell.y);
  const data = { epoch: 5, diffs: { [key]: wb.AIR } };
  const back = wb.parseSharedWorld(wb.serializeSharedWorld(data));
  assert.deepEqual(back, data);
  // 生成地形と同じ値・岩盤・壊れたキーは落とす
  const messy = wb.parseSharedWorld(JSON.stringify({
    epoch: 2,
    diffs: { [key]: wb.STONE, "1,1": wb.BEDROCK, "x,y": wb.DIRT, [`${cell.x},${cell.y + 1}`]: wb.TORCH },
  }));
  assert.equal(messy.epoch, 2);
  assert.deepEqual(Object.keys(messy.diffs), [`${cell.x},${cell.y + 1}`]);
  assert.equal(wb.parseSharedWorld(null), null);
  assert.equal(wb.parseSharedWorld("{nope"), null);
  assert.equal(wb.parseSharedWorld(JSON.stringify({ epoch: -1, diffs: {} })), null);
  assert.equal(wb.parseSharedWorld(JSON.stringify({ epoch: 1, diffs: [] })), null);
});

test("world-sync: diffTilesAgainst は同期済みとの差だけを列挙する", () => {
  const world = wb.generateWorld(wb.WORLD_SEED);
  const known = world.tiles.slice();
  assert.deepEqual(wb.diffTilesAgainst(world.tiles, known), []);
  const cell = findStoneCell(world);
  world.tiles[cell.y * wb.WORLD_W + cell.x] = wb.AIR;
  const changes = wb.diffTilesAgainst(world.tiles, known);
  assert.deepEqual(changes, [{ x: cell.x, y: cell.y, tile: wb.AIR }]);
});

// ---------- セーブ v2→v3 移行 ----------

test("保存: v2 セーブはタイルを破棄し、所持品・HP・位置だけを引き継ぐ", () => {
  const world = wb.generateWorld(21);
  const cell = findStoneCell(world);
  world.tiles[cell.y * wb.WORLD_W + cell.x] = wb.AIR; // v2 では掘った状態が保存されていた
  const inv = wb.createInventory();
  wb.addItem(inv, wb.DIRT, 5);
  wb.addItem(inv, wb.TORCH, 3);
  const v2json = JSON.stringify({
    version: 2,
    seed: 21,
    tilesB64: wb.encodeTiles(world.tiles),
    slots: inv.slots,
    player: { x: 42.5, y: 10.25 },
    hp: 6,
    dayPhase: 0.8,
  });
  const parsed = wb.parseSave(v2json);
  assert.ok(parsed, "v2 セーブが読めない");
  assert.equal(wb.countOf(parsed.inventory, wb.DIRT), 5);
  assert.equal(wb.countOf(parsed.inventory, wb.TORCH), 3);
  assert.equal(parsed.hp, 6);
  assert.deepEqual(parsed.player, { x: 42.5, y: 10.25 });
  assert.equal(parsed.tiles, undefined);
  assert.equal(wb.SAVE_VERSION, 3);
  // 移行後に v3 で保存し直すと往復する（タイルは含まれない）
  const json3 = wb.serializeSave(parsed);
  assert.ok(!json3.includes("tilesB64"));
  const again = wb.parseSave(json3);
  assert.deepEqual(again, parsed);
});

// ---------- クライアント配線 ----------

test("クライアント: 共有ワールド API と共有時計を使い、位相の自前進行は無い", () => {
  assert.ok(clientSrc.includes('fetch("/api/worldbox/world"'), "共有ワールド API を呼んでいない");
  assert.ok(clientSrc.includes("phaseAtTime"), "共有時計を使っていない");
  assert.ok(!clientSrc.includes("advancePhase"), "位相の自前進行が残っている");
  assert.ok(clientSrc.includes("applyDiffs"), "サーバー差分を適用していない");
  assert.ok(clientSrc.includes("diffTilesAgainst"), "自分の変更を差分化していない");
  assert.ok(clientSrc.includes("共有ワールド"), "共有状態の表示が無い");
});

// ---------- 共有ワールド API ルート ----------

const botApiStubUrl = dataUrl(`
const store = new Map();
export function isBotApiConfigured() { return true; }
export async function kvGet(ns, key) { const v = store.get(ns + " " + key); return v === undefined ? null : v; }
export async function kvSet(ns, key, value) { store.set(ns + " " + key, value); }
export async function kvDelete(ns, key) { store.delete(ns + " " + key); }
`);
const subdomainUrl = dataUrl(transpile("subdomain.ts"));
const headersStubUrl = dataUrl("export async function cookies() { throw new Error('tests do not use cookies()'); }");
const authUrl = dataUrl(
  transpile("auth.ts").replaceAll('"./subdomain"', JSON.stringify(subdomainUrl)).replaceAll('"next/headers"', JSON.stringify(headersStubUrl)),
);
const auth = await import(authUrl);
const worldSyncUrl = dataUrl(
  ["worldbox/blocks.ts", "worldbox/worldgen.ts", "worldbox/world-sync.ts"]
    .map((name) => stripModuleSyntax(transpile(name)))
    .join("\n") +
    "\nexport { emptySharedWorld, parseSharedWorld, serializeSharedWorld, mergeChanges, MAX_CHANGE_BATCH };\n",
);
const worldOnlineUrl = dataUrl(
  transpile("worldbox/world-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./world-sync"', JSON.stringify(worldSyncUrl)),
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
const worldRoute = await import(
  dataUrl(
    transpile("api/worldbox/world/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/world-online"', JSON.stringify(worldOnlineUrl))
      .replaceAll('"@/lib/worldbox/world-sync"', JSON.stringify(worldSyncUrl)),
  ),
);

process.env.DISCORD_SESSION_SECRET = "<MASKED_SECRET_001>";

function sessionCookie(id, username) {
  const value = auth.createSession({ id, username });
  return `ago_session=${encodeURIComponent(value)}`;
}

function worldRequest(method, cookie, body) {
  return new Request("http://localhost/api/worldbox/world", {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

test("API(world): ゲストは読めるが書けない", async () => {
  const res = await worldRoute.GET(worldRequest("GET", null));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.epoch, 0);
  assert.deepEqual(body.diffs, {});
  const put = await worldRoute.PUT(worldRequest("PUT", null, { changes: [] }));
  assert.equal(put.status, 401);
  const badCookie = await worldRoute.PUT(worldRequest("PUT", "ago_session=forged.value", { changes: [] }));
  assert.equal(badCookie.status, 401, "偽セッションが通った");
});

test("API(world): 書込→読込の往復、LWW、地形に戻すと差分が消える", async () => {
  const cookie = sessionCookie("333333333333333333", "user-w");
  const cell = findStoneCell(wb.generateWorld(wb.WORLD_SEED));
  const key = wb.diffKey(cell.x, cell.y);
  const put1 = await worldRoute.PUT(worldRequest("PUT", cookie, { changes: [{ x: cell.x, y: cell.y, tile: wb.AIR }] }));
  assert.equal(put1.status, 200);
  const r1 = await put1.json();
  assert.equal(r1.epoch, 1);
  assert.deepEqual(r1.rejected, []);
  let got = await (await worldRoute.GET(worldRequest("GET", null))).json();
  assert.equal(got.diffs[key], wb.AIR);
  // LWW: 同じセルを別のタイルで上書き
  const put2 = await worldRoute.PUT(worldRequest("PUT", cookie, { changes: [{ x: cell.x, y: cell.y, tile: wb.DIRT }] }));
  assert.equal((await put2.json()).epoch, 2);
  got = await (await worldRoute.GET(worldRequest("GET", null))).json();
  assert.equal(got.diffs[key], wb.DIRT);
  // 地形（石）に戻すと差分が消える
  const put3 = await worldRoute.PUT(worldRequest("PUT", cookie, { changes: [{ x: cell.x, y: cell.y, tile: wb.STONE }] }));
  assert.equal((await put3.json()).epoch, 3);
  got = await (await worldRoute.GET(worldRequest("GET", null))).json();
  assert.ok(!(key in got.diffs), "地形に戻した差分が残っている");
});

test("API(world): 岩盤とスポーン保護は却下され、バッチ上限も守られる", async () => {
  const cookie = sessionCookie("444444444444444444", "user-x");
  const world = wb.generateWorld(wb.WORLD_SEED);
  const spawn = wb.findSpawn(world);
  const surf = world.surfaces[spawn.x];
  const before = await (await worldRoute.GET(worldRequest("GET", null))).json();
  const res = await worldRoute.PUT(worldRequest("PUT", cookie, {
    changes: [
      { x: 10, y: wb.WORLD_H - 1, tile: wb.AIR },
      { x: 20, y: 30, tile: wb.BEDROCK },
      { x: spawn.x, y: surf, tile: wb.AIR },
    ],
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rejected.length, 3);
  assert.deepEqual(body.rejected.map((r) => r.reason), ["bedrock", "bedrock", "spawn_protected"]);
  assert.equal(body.epoch, before.epoch, "全却下で epoch が進んだ");
  // バッチ上限（256超は 400）
  const big = Array.from({ length: wb.MAX_CHANGE_BATCH + 1 }, () => ({ x: 10, y: 10, tile: wb.DIRT }));
  const bigRes = await worldRoute.PUT(worldRequest("PUT", cookie, { changes: big }));
  assert.equal(bigRes.status, 400);
  // changes が配列でない
  const badRes = await worldRoute.PUT(worldRequest("PUT", cookie, { changes: "nope" }));
  assert.equal(badRes.status, 400);
});
