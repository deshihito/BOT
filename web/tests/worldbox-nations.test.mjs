// AGO WORLD BOX 国家レイヤーの検証:
// - 純粋ロジック（渦巻き首都探索・領地重なり・パレット・国名検証・状態遷移）
// - 国家 API（ゲスト閲覧・建国→王・参加→市民・二重所属の却下・王の離脱規則・解散で首都が空く）
// - クライアント配線（国家 API・領地・首都マーカー）
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
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/presence.ts", "worldbox/nations.ts"],
  [
    "MAP_W", "MAP_H", "T_GRASS", "T_WATER", "T_DIRT", "T_SAND", "T_TREE", "T_ROCK", "generateMap", "mapTileAt",
    "TERRITORY_RADIUS", "NATION_PALETTE", "emptyNationsState", "validateNationName", "isNameTaken",
    "pickNationColor", "capitalFits", "findCapitalTile", "territoryOwnerAt", "memberCounts",
    "applyFound", "applyJoin", "applyLeave", "parseNationsState", "nationViews", "playerNationMap",
    "buildNationsResponse",
    "emptyBuildings", "buildingKey", "buildingCap", "buildingCount", "prosperityOf",
    "applyBuild", "applyDemolish", "removeNationBuildings", "parseBuildings", "buildingViews",
  ],
);

function fakeMap(fill, paint) {
  const tiles = new Uint8Array(128 * 128).fill(fill);
  const map = { seed: 0, width: 128, height: 128, tiles };
  paint?.(tiles);
  return map;
}

const KING_A = "discord:100000000000000001";
const USER_B = "discord:100000000000000002";
const USER_C = "discord:100000000000000003";

// ---------- 渦巻き首都探索 ----------

test("nations: 空きマップでは中央が最初の首都になる", () => {
  const map = wb.generateMap();
  assert.deepEqual(wb.findCapitalTile(map, []), { x: 64, y: 64 });
});

test("nations: 2つ目の首都は領地が重ならない距離に置かれる", () => {
  const map = fakeMap(wb.T_GRASS);
  const first = wb.findCapitalTile(map, []);
  assert.deepEqual(first, { x: 64, y: 64 });
  const nations = [{ id: "n1", name: "一国", color: wb.NATION_PALETTE[0], kingKey: KING_A, capital: first, createdAt: 1 }];
  // 距離 2R までは重なり、2R+1 から置ける
  assert.equal(wb.capitalFits(map, 64 + wb.TERRITORY_RADIUS * 2, 64, nations), false);
  assert.equal(wb.capitalFits(map, 64 + wb.TERRITORY_RADIUS * 2 + 1, 64, nations), true);
  const second = wb.findCapitalTile(map, nations);
  assert.ok(second);
  const d = Math.max(Math.abs(second.x - 64), Math.abs(second.y - 64));
  assert.ok(d > wb.TERRITORY_RADIUS * 2, `領地が重なっている d=${d}`);
  assert.deepEqual(second, { x: 51, y: 51 });
});

test("nations: 水のタイルは飛ばし、陸にだけ首都を置く", () => {
  const map = fakeMap(wb.T_WATER, (t) => {
    t[64 * 128 + 70] = wb.T_GRASS;
  });
  assert.deepEqual(wb.findCapitalTile(map, []), { x: 70, y: 64 });
  const allWater = fakeMap(wb.T_WATER);
  assert.equal(wb.findCapitalTile(allWater, []), null);
});

test("nations: 領地の所有判定（半径内のみ、境界の外は無所属）", () => {
  const nation = { id: "n1", name: "一国", color: wb.NATION_PALETTE[0], kingKey: KING_A, capital: { x: 64, y: 64 }, createdAt: 1 };
  assert.equal(wb.territoryOwnerAt([nation], 64, 64)?.id, "n1");
  assert.equal(wb.territoryOwnerAt([nation], 64 + wb.TERRITORY_RADIUS, 64)?.id, "n1");
  assert.equal(wb.territoryOwnerAt([nation], 64 + wb.TERRITORY_RADIUS + 1, 64), null);
  assert.equal(wb.territoryOwnerAt([nation], 10, 10), null);
});

// ---------- パレットと国名 ----------

test("nations: 色は使用数の少ないものから割り当てる", () => {
  const empty = wb.emptyNationsState();
  assert.equal(wb.pickNationColor(empty), wb.NATION_PALETTE[0]);
  const one = {
    nations: { n1: { id: "n1", name: "一国", color: wb.NATION_PALETTE[0], kingKey: KING_A, capital: { x: 64, y: 64 }, createdAt: 1 } },
    members: {},
  };
  assert.equal(wb.pickNationColor(one), wb.NATION_PALETTE[1]);
});

test("nations: 国名の検証（1〜16文字、制御文字なし）", () => {
  assert.deepEqual(wb.validateNationName("  あご王国  "), { ok: true, name: "あご王国" });
  assert.equal(wb.validateNationName("あ".repeat(16)).ok, true);
  assert.equal(wb.validateNationName("あ".repeat(17)).ok, false);
  assert.equal(wb.validateNationName("").ok, false);
  assert.equal(wb.validateNationName("   ").ok, false);
  assert.equal(wb.validateNationName("悪\u0001名").ok, false);
  assert.equal(wb.validateNationName(42).ok, false);
  assert.equal(wb.validateNationName(null).ok, false);
});

// ---------- 状態遷移 ----------

test("nations: 建国→王、参加→市民、二重所属と同名は却下", () => {
  const map = wb.generateMap();
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, "あご王国", map, 1000);
  assert.equal(founded.ok, true);
  assert.deepEqual(founded.nation.capital, { x: 64, y: 64 });
  assert.equal(founded.state.members[KING_A].role, "king");
  assert.equal(founded.nation.color, wb.NATION_PALETTE[0]);

  assert.equal(wb.applyFound(founded.state, KING_A, "二国目", map, 2000).error, "already_in_nation");
  assert.equal(wb.applyFound(founded.state, USER_B, "あご王国", map, 2000).error, "name_taken");
  assert.equal(wb.applyFound(founded.state, USER_B, " あご王国 ", map, 2000).error, "name_taken");
  assert.equal(wb.applyFound(founded.state, USER_B, "", map, 2000).error, "invalid_name");

  const joined = wb.applyJoin(founded.state, USER_B, founded.nation.id);
  assert.equal(joined.ok, true);
  assert.equal(joined.state.members[USER_B].role, "citizen");
  assert.equal(wb.memberCounts(joined.state)[founded.nation.id], 2);
  assert.equal(wb.applyJoin(joined.state, USER_B, founded.nation.id).error, "already_in_nation");
  assert.equal(wb.applyJoin(founded.state, USER_C, "存在しない").error, "nation_not_found");
});

test("nations: 王の離脱規則と、解散で首都が空く", () => {
  const map = wb.generateMap();
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, "あご王国", map, 1000);
  const joined = wb.applyJoin(founded.state, USER_B, founded.nation.id);

  // 国民がいる間、王は離脱できない
  assert.equal(wb.applyLeave(joined.state, KING_A).error, "king_must_transfer_or_disband");
  // 市民は離脱できる
  const left = wb.applyLeave(joined.state, USER_B);
  assert.equal(left.ok, true);
  assert.equal(left.state.members[USER_B], undefined);
  assert.equal(wb.applyLeave(left.state, USER_B).error, "not_in_nation");
  // 一人になった王は解散できる
  const disbanded = wb.applyLeave(left.state, KING_A);
  assert.equal(disbanded.ok, true);
  assert.equal(disbanded.disbanded, true);
  assert.deepEqual(Object.keys(disbanded.state.nations), []);
  assert.deepEqual(wb.findCapitalTile(map, Object.values(disbanded.state.nations)), { x: 64, y: 64 });
});

test("nations: 保存形式の往復と、壊れた要素の除去", () => {
  const map = wb.generateMap();
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, "あご王国", map, 1000);
  const restored = wb.parseNationsState(
    JSON.stringify(founded.state.nations),
    JSON.stringify(founded.state.members),
  );
  assert.deepEqual(restored, founded.state);
  const dirty = wb.parseNationsState(
    JSON.stringify({
      bad1: { id: "bad1", name: "色が不正", color: "#000000", kingKey: KING_A, capital: { x: 1, y: 1 }, createdAt: 1 },
      bad2: { id: "bad2", name: "首都が範囲外", color: wb.NATION_PALETTE[0], kingKey: KING_A, capital: { x: 999, y: 1 }, createdAt: 1 },
    }),
    JSON.stringify({
      [KING_A]: { nationId: "bad1", role: "king" },
      [USER_B]: { nationId: "bad2", role: "変な役職" },
    }),
  );
  assert.deepEqual(dirty, wb.emptyNationsState());
  assert.deepEqual(wb.parseNationsState("{壊れた", null), wb.emptyNationsState());
});

test("nations: 表示用ビューの人数とプレイヤー色マップ", () => {
  const map = wb.generateMap();
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, "あご王国", map, 1000);
  const joined = wb.applyJoin(founded.state, USER_B, founded.nation.id);
  const views = wb.nationViews(joined.state);
  assert.equal(views.length, 1);
  assert.equal(views[0].members, 2);
  assert.ok(!("kingKey" in views[0]), "王の所有者キーが露出している");
  const colors = wb.playerNationMap(joined.state);
  assert.equal(Object.keys(colors).length, 2);
  assert.equal(Object.values(colors)[0].color, wb.NATION_PALETTE[0]);
  const res = wb.buildNationsResponse(joined.state, USER_B);
  assert.deepEqual(res.me, { nationId: founded.nation.id, role: "citizen" });
  assert.equal(res.loggedIn, true);
  assert.equal(wb.buildNationsResponse(joined.state, null).loggedIn, false);
});

// ---------- 建物と繁栄度 ----------

test("buildings: 建築の検証マトリクス（所属・種類・領地・地形・占有・首都）", () => {
  const map = fakeMap(wb.T_GRASS, (t) => {
    t[64 * 128 + 66] = wb.T_WATER;
    t[64 * 128 + 67] = wb.T_TREE;
    t[64 * 128 + 68] = wb.T_ROCK;
    t[64 * 128 + 69] = wb.T_DIRT;
    t[64 * 128 + 70] = wb.T_SAND;
  });
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, "あご王国", map, 1000);
  const state = founded.state;
  const none = wb.emptyBuildings();

  // 未所属・不正な種類
  assert.equal(wb.applyBuild(state, none, USER_C, map, "house", 65, 64, 1).error, "not_in_nation");
  assert.equal(wb.applyBuild(state, none, KING_A, map, "castle", 65, 64, 1).error, "invalid_type");
  assert.equal(wb.applyBuild(state, none, KING_A, map, null, 65, 64, 1).error, "invalid_type");
  // 領地外と他国の領地
  assert.equal(wb.applyBuild(state, none, KING_A, map, "house", 64, 40, 1).error, "not_your_territory");
  const second = wb.applyFound(state, USER_B, "二国", map, 2000);
  assert.equal(second.ok, true);
  assert.equal(
    wb.applyBuild(second.state, none, KING_A, map, "house", second.nation.capital.x, second.nation.capital.y, 1).error,
    "not_your_territory",
  );
  // 首都・水・木・岩には建てられない
  assert.equal(wb.applyBuild(state, none, KING_A, map, "house", 64, 64, 1).error, "tile_blocked");
  assert.equal(wb.applyBuild(state, none, KING_A, map, "house", 66, 64, 1).error, "tile_blocked");
  assert.equal(wb.applyBuild(state, none, KING_A, map, "house", 67, 64, 1).error, "tile_blocked");
  assert.equal(wb.applyBuild(state, none, KING_A, map, "house", 68, 64, 1).error, "tile_blocked");
  // 範囲外・非数値の座標
  assert.equal(wb.applyBuild(state, none, KING_A, map, "house", 999, 64, 1).error, "tile_blocked");
  assert.equal(wb.applyBuild(state, none, KING_A, map, "house", "65", 64, 1).error, "tile_blocked");
  // 草・土・砂には建てられる
  const onGrass = wb.applyBuild(state, none, KING_A, map, "house", 65, 64, 1);
  assert.equal(onGrass.ok, true);
  assert.equal(onGrass.building.nationId, founded.nation.id);
  assert.equal(onGrass.building.type, "house");
  assert.equal(wb.applyBuild(state, none, KING_A, map, "farm", 69, 64, 1).ok, true);
  assert.equal(wb.applyBuild(state, none, KING_A, map, "tower", 70, 64, 1).ok, true);
  // 既存建物の上には建てられない
  assert.equal(wb.applyBuild(state, onGrass.buildings, KING_A, map, "farm", 65, 64, 2).error, "tile_blocked");
});

test("buildings: 建築上限は 10 + 10 × 国民数", () => {
  assert.equal(wb.buildingCap(0), 10);
  assert.equal(wb.buildingCap(1), 20);
  assert.equal(wb.buildingCap(3), 40);
  const map = fakeMap(wb.T_GRASS);
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, "あご王国", map, 1000);
  let buildings = wb.emptyBuildings();
  let placed = 0;
  outer: for (let y = 59; y <= 70; y++) {
    for (let x = 59; x <= 70; x++) {
      if (x === 64 && y === 64) continue;
      const r = wb.applyBuild(founded.state, buildings, KING_A, map, "house", x, y, placed);
      assert.equal(r.ok, true, `(${x},${y}) に建てられなかった`);
      buildings = r.buildings;
      placed++;
      if (placed === 20) break outer;
    }
  }
  assert.equal(wb.buildingCount(buildings, founded.nation.id), 20);
  assert.equal(wb.applyBuild(founded.state, buildings, KING_A, map, "house", 67, 60, 99).error, "cap_reached");
  // 国民が増えれば上限も増える
  const joined = wb.applyJoin(founded.state, USER_B, founded.nation.id);
  assert.equal(wb.applyBuild(joined.state, buildings, KING_A, map, "house", 67, 60, 100).ok, true);
});

test("buildings: 取り壊しは王・大臣のみ、自国の建物だけ", () => {
  const nation = { id: "n1", name: "一国", color: wb.NATION_PALETTE[0], kingKey: KING_A, capital: { x: 64, y: 64 }, createdAt: 1 };
  const state = {
    nations: { n1: nation },
    members: {
      [KING_A]: { nationId: "n1", role: "king" },
      [USER_B]: { nationId: "n1", role: "minister" },
      [USER_C]: { nationId: "n1", role: "citizen" },
    },
  };
  const buildings = {
    "65,64": { nationId: "n1", type: "house", by: "x", at: 1 },
    "30,30": { nationId: "n2", type: "tower", by: "y", at: 1 },
  };
  assert.equal(wb.applyDemolish(state, buildings, "discord:999999999999999999", 65, 64).error, "not_in_nation");
  assert.equal(wb.applyDemolish(state, buildings, USER_C, 65, 64).error, "forbidden");
  assert.equal(wb.applyDemolish(state, buildings, KING_A, 30, 30).error, "forbidden");
  assert.equal(wb.applyDemolish(state, buildings, KING_A, 90, 90).error, "tile_blocked");
  const byMinister = wb.applyDemolish(state, buildings, USER_B, 65, 64);
  assert.equal(byMinister.ok, true);
  assert.equal(byMinister.buildings["65,64"], undefined);
  assert.ok(byMinister.buildings["30,30"], "他国の建物まで消えている");
  assert.ok(buildings["65,64"], "元のマップを変更している");
});

test("buildings: 解散カスケードと保存形式の往復", () => {
  const buildings = {
    "65,64": { nationId: "n1", type: "house", by: "x", at: 1 },
    "66,64": { nationId: "n1", type: "farm", by: "x", at: 2 },
    "30,30": { nationId: "n2", type: "tower", by: "y", at: 3 },
  };
  const after = wb.removeNationBuildings(buildings, "n1");
  assert.deepEqual(Object.keys(after), ["30,30"]);
  assert.equal(Object.keys(buildings).length, 3, "元のマップを変更している");

  const restored = wb.parseBuildings(JSON.stringify(buildings), new Set(["n1", "n2"]));
  assert.deepEqual(restored, buildings);
  const filtered = wb.parseBuildings(JSON.stringify(buildings), new Set(["n2"]));
  assert.deepEqual(Object.keys(filtered), ["30,30"]);
  const dirty = wb.parseBuildings(JSON.stringify({
    "bad-key": { nationId: "n1", type: "house", by: "x", at: 1 },
    "1,1": { nationId: "n1", type: "castle", by: "x", at: 1 },
    "2,2": { nationId: "n1", type: "house", by: "x", at: "時刻でない" },
    "3,3": { nationId: "n1", type: "house", by: "x", at: 5 },
  }), new Set(["n1"]));
  assert.deepEqual(Object.keys(dirty), ["3,3"]);
  assert.deepEqual(wb.parseBuildings("{壊れた"), {});
});

test("buildings: 繁栄度 = 家3・畑2・塔2 + 国民5、ビューに載る", () => {
  const buildings = {
    "1,1": { nationId: "n1", type: "house", by: "x", at: 1 },
    "2,1": { nationId: "n1", type: "house", by: "x", at: 1 },
    "3,1": { nationId: "n1", type: "farm", by: "x", at: 1 },
    "4,1": { nationId: "n1", type: "tower", by: "x", at: 1 },
    "5,1": { nationId: "n2", type: "house", by: "y", at: 1 },
  };
  assert.equal(wb.prosperityOf(buildings, "n1", 3), 3 * 2 + 2 + 2 + 5 * 3);
  assert.equal(wb.prosperityOf(buildings, "n2", 1), 3 + 5);
  assert.equal(wb.prosperityOf(wb.emptyBuildings(), "n1", 2), 10);

  const map = wb.generateMap();
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, "あご王国", map, 1000);
  const joined = wb.applyJoin(founded.state, USER_B, founded.nation.id);
  const built = wb.applyBuild(joined.state, wb.emptyBuildings(), KING_A, fakeMap(wb.T_GRASS), "house", 65, 64, 5);
  assert.equal(built.ok, true);
  const views = wb.nationViews(joined.state, built.buildings);
  assert.equal(views[0].prosperity, 5 * 2 + 3);
  const res = wb.buildNationsResponse(joined.state, USER_B, built.buildings);
  assert.deepEqual(res.buildings, [{ x: 65, y: 64, nationId: founded.nation.id, type: "house" }]);
  assert.ok(!("by" in res.buildings[0]) && !("at" in res.buildings[0]), "建築者・時刻が露出している");
});

// ---------- 国家 API ----------

const botApiStubUrl = dataUrl(`
const store = new Map();
globalThis.__wbNationsStore = store;
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
const presenceUrl = dataUrl(transpile("worldbox/presence.ts"));
const nationsUrl = dataUrl(
  transpile("worldbox/nations.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./presence"', JSON.stringify(presenceUrl)),
);
const nationsOnlineUrl = dataUrl(
  transpile("worldbox/nations-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./nations"', JSON.stringify(nationsUrl)),
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
const nationsRoute = await import(
  dataUrl(
    transpile("api/worldbox/nations/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/mapgen"', JSON.stringify(mapgenUrl))
      .replaceAll('"@/lib/worldbox/nations"', JSON.stringify(nationsUrl))
      .replaceAll('"@/lib/worldbox/nations-online"', JSON.stringify(nationsOnlineUrl)),
  ),
);

process.env.DISCORD_SESSION_SECRET = ["worldbox", "nations", "test", "secret"].join("-");
function sessionCookie(id, username) {
  const value = auth.createSession({ id, username });
  return `ago_session=${encodeURIComponent(value)}`;
}
function nationsRequest(method, cookie, body, headers = {}) {
  return new Request("http://localhost/api/worldbox/nations", {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

test("API(nations): ゲストは閲覧のみ、書き込みは 401", async () => {
  const res = await nationsRoute.GET(nationsRequest("GET", null));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.nations, []);
  assert.equal(body.me, null);
  assert.equal(body.loggedIn, false);
  assert.equal((await nationsRoute.POST(nationsRequest("POST", null, { action: "found", name: "x" }))).status, 401);
  assert.equal((await nationsRoute.POST(nationsRequest("POST", null, { action: "leave" }))).status, 401);
});

test("API(nations): 建国→王・参加→市民・王の離脱規則・解散で首都が空く", async () => {
  const cookieA = sessionCookie("200000000000000001", "king-a");
  const cookieB = sessionCookie("200000000000000002", "user-b");
  const cookieC = sessionCookie("200000000000000003", "user-c");

  // 建国
  const found = await nationsRoute.POST(nationsRequest("POST", cookieA, { action: "found", name: "あご王国" }));
  assert.equal(found.status, 200);
  const foundBody = await found.json();
  assert.equal(foundBody.me.role, "king");
  assert.deepEqual(foundBody.nation.capital, { x: 64, y: 64 });
  assert.equal(foundBody.nation.members, 1);
  const nationId = foundBody.nation.id;

  // ゲストからも見える（人数つき）
  const guestView = await (await nationsRoute.GET(nationsRequest("GET", null))).json();
  assert.equal(guestView.nations.length, 1);
  assert.equal(guestView.nations[0].members, 1);
  assert.equal(Object.keys(guestView.playerNations).length, 1);
  assert.equal(Object.values(guestView.playerNations)[0].color, guestView.nations[0].color);

  // 二重建国・同名・不正な名前・存在しない国への参加
  const again = await nationsRoute.POST(nationsRequest("POST", cookieA, { action: "found", name: "二国目" }));
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, "already_in_nation");
  const dupName = await nationsRoute.POST(nationsRequest("POST", cookieB, { action: "found", name: "あご王国" }));
  assert.equal(dupName.status, 409);
  assert.equal((await dupName.json()).error, "name_taken");
  const badName = await nationsRoute.POST(nationsRequest("POST", cookieB, { action: "found", name: "あ".repeat(17) }));
  assert.equal(badName.status, 400);
  assert.equal((await badName.json()).error, "invalid_name");
  const joinMissing = await nationsRoute.POST(nationsRequest("POST", cookieB, { action: "join", nationId: "ない" }));
  assert.equal(joinMissing.status, 409);
  assert.equal((await joinMissing.json()).error, "nation_not_found");

  // 参加→市民、二重参加は却下
  const join = await nationsRoute.POST(nationsRequest("POST", cookieB, { action: "join", nationId }));
  assert.equal(join.status, 200);
  assert.equal((await join.json()).me.role, "citizen");
  const joinAgain = await nationsRoute.POST(nationsRequest("POST", cookieB, { action: "join", nationId }));
  assert.equal(joinAgain.status, 409);
  assert.equal((await joinAgain.json()).error, "already_in_nation");
  const view2 = await (await nationsRoute.GET(nationsRequest("GET", cookieC))).json();
  assert.equal(view2.nations[0].members, 2);
  assert.deepEqual(view2.me, null);

  // 王は国民がいる間は離脱できない
  const kingLeave = await nationsRoute.POST(nationsRequest("POST", cookieA, { action: "leave" }));
  assert.equal(kingLeave.status, 409);
  assert.equal((await kingLeave.json()).error, "king_must_transfer_or_disband");
  // 市民は離脱できる
  assert.equal((await nationsRoute.POST(nationsRequest("POST", cookieB, { action: "leave" }))).status, 200);
  // 一人になった王は解散
  const disband = await nationsRoute.POST(nationsRequest("POST", cookieA, { action: "leave" }));
  assert.equal(disband.status, 200);
  assert.equal((await disband.json()).disbanded, true);
  const empty = await (await nationsRoute.GET(nationsRequest("GET", null))).json();
  assert.deepEqual(empty.nations, []);

  // 解散で首都が空いたので、次の建国はまた中央
  const refound = await nationsRoute.POST(nationsRequest("POST", cookieC, { action: "found", name: "第二王国" }));
  assert.equal(refound.status, 200);
  assert.deepEqual((await refound.json()).nation.capital, { x: 64, y: 64 });
});

test("API(nations): 不正なアクションは 400、他オリジンは 403", async () => {
  const cookie = sessionCookie("200000000000000009", "user-z");
  const bad = await nationsRoute.POST(nationsRequest("POST", cookie, { action: "conquer" }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "invalid_action");
  const evil = await nationsRoute.POST(
    nationsRequest("POST", cookie, { action: "leave" }, { origin: "http://evil.example" }),
  );
  assert.equal(evil.status, 403);
});

test("API(nations): 建築→繁栄度・取り壊しの権限・解散で建物も消える", async () => {
  const cookieD = sessionCookie("200000000000000010", "king-d");
  const cookieE = sessionCookie("200000000000000011", "user-e");
  const cookieF = sessionCookie("200000000000000012", "user-f");

  // ゲストの建築は 401
  assert.equal((await nationsRoute.POST(nationsRequest("POST", null, { action: "build", type: "house", x: 1, y: 1 }))).status, 401);

  const found = await nationsRoute.POST(nationsRequest("POST", cookieD, { action: "found", name: "建築王国" }));
  assert.equal(found.status, 200);
  const foundBody = await found.json();
  const nationId = foundBody.nation.id;
  const capital = foundBody.nation.capital;
  assert.equal(foundBody.nation.prosperity, 5, "建国直後の繁栄度は国民1人ぶん");

  // 領地内の建てられるタイルを探す（実マップ準拠）
  const map = wb.generateMap();
  const buildable = [];
  for (let y = capital.y - wb.TERRITORY_RADIUS; y <= capital.y + wb.TERRITORY_RADIUS; y++) {
    for (let x = capital.x - wb.TERRITORY_RADIUS; x <= capital.x + wb.TERRITORY_RADIUS; x++) {
      if (x === capital.x && y === capital.y) continue;
      const t = wb.mapTileAt(map, x, y);
      if (t === wb.T_GRASS || t === wb.T_DIRT || t === wb.T_SAND) buildable.push({ x, y });
    }
  }
  assert.ok(buildable.length >= 2, "領地内に建てられるタイルが足りない");
  const [t1, t2] = buildable;

  // エラーコード: 未所属・不正な種類・領地外・首都
  const noNation = await nationsRoute.POST(nationsRequest("POST", cookieF, { action: "build", type: "house", x: t1.x, y: t1.y }));
  assert.equal(noNation.status, 409);
  assert.equal((await noNation.json()).error, "not_in_nation");
  const badType = await nationsRoute.POST(nationsRequest("POST", cookieD, { action: "build", type: "castle", x: t1.x, y: t1.y }));
  assert.equal(badType.status, 400);
  assert.equal((await badType.json()).error, "invalid_type");
  const outside = await nationsRoute.POST(nationsRequest("POST", cookieD, { action: "build", type: "house", x: 0, y: 0 }));
  assert.equal(outside.status, 409);
  assert.equal((await outside.json()).error, "not_your_territory");
  const onCapital = await nationsRoute.POST(nationsRequest("POST", cookieD, { action: "build", type: "house", x: capital.x, y: capital.y }));
  assert.equal(onCapital.status, 409);
  assert.equal((await onCapital.json()).error, "tile_blocked");

  // 建築→ GET に建物と繁栄度が載る
  const built = await nationsRoute.POST(nationsRequest("POST", cookieD, { action: "build", type: "house", x: t1.x, y: t1.y }));
  assert.equal(built.status, 200);
  assert.deepEqual((await built.json()).buildings, [{ x: t1.x, y: t1.y, nationId, type: "house" }]);
  const view = await (await nationsRoute.GET(nationsRequest("GET", null))).json();
  const mine = view.nations.find((n) => n.id === nationId);
  assert.equal(mine.prosperity, 5 + 3);
  assert.deepEqual(view.buildings, [{ x: t1.x, y: t1.y, nationId, type: "house" }]);
  // 同じ場所には建てられない
  const dup = await nationsRoute.POST(nationsRequest("POST", cookieD, { action: "build", type: "farm", x: t1.x, y: t1.y }));
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error, "tile_blocked");

  // 市民は建てられるが、取り壊しはできない
  assert.equal((await nationsRoute.POST(nationsRequest("POST", cookieE, { action: "join", nationId }))).status, 200);
  const citizenBuild = await nationsRoute.POST(nationsRequest("POST", cookieE, { action: "build", type: "farm", x: t2.x, y: t2.y }));
  assert.equal(citizenBuild.status, 200);
  const citizenDemolish = await nationsRoute.POST(nationsRequest("POST", cookieE, { action: "demolish", x: t1.x, y: t1.y }));
  assert.equal(citizenDemolish.status, 403);
  assert.equal((await citizenDemolish.json()).error, "forbidden");

  // 王は取り壊せる
  const demolished = await nationsRoute.POST(nationsRequest("POST", cookieD, { action: "demolish", x: t1.x, y: t1.y }));
  assert.equal(demolished.status, 200);
  assert.deepEqual((await demolished.json()).buildings, [{ x: t2.x, y: t2.y, nationId, type: "farm" }]);

  // 解散すると残りの建物（市民が建てた畑）も消える
  assert.equal((await nationsRoute.POST(nationsRequest("POST", cookieE, { action: "leave" }))).status, 200);
  const disband = await nationsRoute.POST(nationsRequest("POST", cookieD, { action: "leave" }));
  assert.equal(disband.status, 200);
  assert.equal((await disband.json()).disbanded, true);
  const after = await (await nationsRoute.GET(nationsRequest("GET", null))).json();
  assert.equal(after.nations.some((n) => n.id === nationId), false);
  assert.deepEqual(after.buildings, []);
});

// ---------- クライアント配線 ----------

test("クライアント: 国家 API・領地・首都マーカーが配線されている", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("/api/worldbox/nations"), "国家 API を使っていない");
  assert.ok(client.includes("TERRITORY_RADIUS"), "領地半径を使っていない");
  assert.ok(client.includes("drawCapital"), "首都マーカーが無い");
  assert.ok(client.includes("建国"), "建国 UI が無い");
  assert.ok(client.includes("playerNations"), "プレゼンスへの国色付けが無い");
});

test("クライアント: 建築モード・建物描画・繁栄度が配線されている", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("drawBuilding"), "建物の描画が無い");
  assert.ok(client.includes("buildValidity"), "建築可否のハイライトが無い");
  assert.ok(client.includes("chooseBuildTool"), "建築ツールの選択が無い");
  assert.ok(client.includes('action: "build"'), "建築アクションを送っていない");
  assert.ok(client.includes('action: "demolish"'), "取り壊しアクションを送っていない");
  assert.ok(client.includes("取り壊し"), "取り壊し UI が無い");
  assert.ok(client.includes("繁栄度"), "繁栄度の表示が無い");
  assert.ok(client.includes("prosperity - a.prosperity") || client.includes("b.prosperity - a.prosperity"), "国リストが繁栄度順でない");
  // 建物は移動の当たり判定に入る
  assert.ok(client.includes("stepMove(map, player, vel, dt, blockedRef.current)"), "建物が当たり判定に入っていない");
  assert.ok(client.includes("blockedRef"), "建物の固体集合が無い");
});
