// AGO WORLD BOX 国家レイヤー＋建物の検証:
// - 純粋ロジック（渦巻き首都探索・首都間隔・パレット・国名検証・状態遷移）
// - 国家 API（ゲスト閲覧・建国→王・参加→市民・二重所属の却下・王の離脱規則・解散で首都が空く）
// - 建物（個人所有: 所属なしでも建築可・首都/広場は保護・所有者だけが取り壊し可・解散しても残る）
// - クライアント配線（国家 API・建物 API・首都マーカー）
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
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/presence.ts", "worldbox/buildings.ts", "worldbox/nations.ts"],
  [
    "MAP_W", "MAP_H", "T_GRASS", "T_WATER", "T_DIRT", "T_SAND", "T_TREE", "T_ROCK", "generateMap", "mapTileAt",
    "isSpawnPlazaTile", "presenceIdFor",
    "TERRITORY_RADIUS", "NATION_PALETTE", "emptyNationsState", "validateNationName", "isNameTaken",
    "pickNationColor", "capitalFits", "findCapitalTile", "memberCounts",
    "applyFound", "applyJoin", "applyLeave", "parseNationsState", "nationViews", "playerNationMap",
    "buildNationsResponse",
    "emptyBuildings", "buildingKey", "USER_BUILDING_CAP", "buildingCountByOwner", "prosperityOf",
    "applyBuild", "applyDemolish", "parseBuildings", "buildingViews",
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
  assert.deepEqual(wb.findCapitalTile(map, []), { x: 512, y: 512 });
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
  assert.deepEqual(founded.nation.capital, { x: 512, y: 512 });
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
  assert.deepEqual(wb.findCapitalTile(map, Object.values(disbanded.state.nations)), { x: 512, y: 512 });
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
      bad2: { id: "bad2", name: "首都が範囲外", color: wb.NATION_PALETTE[0], kingKey: KING_A, capital: { x: 9999, y: 1 }, createdAt: 1 },
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

// ---------- 建物（個人所有）と繁栄度 ----------

test("buildings: 建築の検証マトリクス（所属不問・種類・首都・広場・地形・占有）", () => {
  const map = fakeMap(wb.T_GRASS, (t) => {
    t[40 * 128 + 66] = wb.T_WATER;
    t[40 * 128 + 67] = wb.T_TREE;
    t[40 * 128 + 68] = wb.T_ROCK;
    t[40 * 128 + 69] = wb.T_DIRT;
    t[40 * 128 + 70] = wb.T_SAND;
  });
  const capitals = [{ x: 64, y: 64 }];
  const none = wb.emptyBuildings();

  // 不正な種類（所属の有無より先に弾く）
  assert.equal(wb.applyBuild(none, USER_C, capitals, map, "castle", 59, 64, 1).error, "invalid_type");
  assert.equal(wb.applyBuild(none, USER_C, capitals, map, null, 59, 64, 1).error, "invalid_type");
  // 首都タイルは誰のものでも保護、スポーン広場も保護
  assert.equal(wb.applyBuild(none, USER_C, capitals, map, "house", 64, 64, 1).error, "on_capital");
  assert.equal(wb.applyBuild(none, USER_C, [], map, "house", 64, 64, 1).error, "on_spawn");
  assert.equal(wb.applyBuild(none, USER_C, [], map, "house", 61, 62, 1).error, "on_spawn");
  assert.equal(wb.isSpawnPlazaTile(map, 59, 64), false);
  // 水・木・岩には建てられない
  assert.equal(wb.applyBuild(none, USER_C, capitals, map, "house", 66, 40, 1).error, "tile_blocked");
  assert.equal(wb.applyBuild(none, USER_C, capitals, map, "house", 67, 40, 1).error, "tile_blocked");
  assert.equal(wb.applyBuild(none, USER_C, capitals, map, "house", 68, 40, 1).error, "tile_blocked");
  // 範囲外・非数値の座標
  assert.equal(wb.applyBuild(none, USER_C, capitals, map, "house", 999, 64, 1).error, "tile_blocked");
  assert.equal(wb.applyBuild(none, USER_C, capitals, map, "house", "65", 64, 1).error, "tile_blocked");
  // 未所属でも草・土・砂に建てられる（所有者は不透明 ID で記録、国 ID は持たない）
  const onGrass = wb.applyBuild(none, USER_C, capitals, map, "house", 59, 64, 1);
  assert.equal(onGrass.ok, true);
  assert.equal(onGrass.building.ownerId, wb.presenceIdFor(USER_C));
  assert.equal(onGrass.building.type, "house");
  assert.ok(!("nationId" in onGrass.building), "建物が国 ID を持っている");
  assert.equal(wb.applyBuild(none, USER_C, capitals, map, "farm", 69, 40, 1).ok, true);
  assert.equal(wb.applyBuild(none, USER_C, capitals, map, "tower", 70, 40, 1).ok, true);
  // 他国の「領地」内でも建てられる（首都タイル以外は所属で制限されない）
  assert.equal(wb.applyBuild(none, USER_B, capitals, map, "house", 60, 60, 1).ok, true);
  // 既存建物の上には建てられない
  assert.equal(wb.applyBuild(onGrass.buildings, KING_A, capitals, map, "farm", 59, 64, 2).error, "tile_blocked");
});

test("buildings: 建築上限はユーザーごとに 20", () => {
  assert.equal(wb.USER_BUILDING_CAP, 20);
  const map = fakeMap(wb.T_GRASS);
  let buildings = wb.emptyBuildings();
  for (let i = 0; i < 20; i++) {
    const r = wb.applyBuild(buildings, USER_C, [], map, "house", 30 + i, 30, i);
    assert.equal(r.ok, true, `${i} 棟目が建てられなかった`);
    buildings = r.buildings;
  }
  assert.equal(wb.buildingCountByOwner(buildings, wb.presenceIdFor(USER_C)), 20);
  assert.equal(wb.applyBuild(buildings, USER_C, [], map, "house", 55, 30, 99).error, "cap_reached");
  // 上限はユーザーごと: 別人ならまだ建てられる
  assert.equal(wb.applyBuild(buildings, USER_B, [], map, "house", 55, 30, 100).ok, true);
});

test("buildings: 取り壊しは所有者だけ（国の役職は無関係）", () => {
  const buildings = {
    "59,64": { ownerId: wb.presenceIdFor(KING_A), type: "house", at: 1 },
    "30,30": { ownerId: wb.presenceIdFor(USER_B), type: "tower", at: 1 },
  };
  // 同じ国の王でも、他人の建物は壊せない
  assert.equal(wb.applyDemolish(buildings, USER_B, 59, 64).error, "not_owner");
  assert.equal(wb.applyDemolish(buildings, USER_C, 59, 64).error, "not_owner");
  // 空タイルは tile_blocked
  assert.equal(wb.applyDemolish(buildings, KING_A, 90, 90).error, "tile_blocked");
  // 所有者なら壊せる。他の建物と元のマップは不変
  const done = wb.applyDemolish(buildings, KING_A, 59, 64);
  assert.equal(done.ok, true);
  assert.equal(done.buildings["59,64"], undefined);
  assert.ok(done.buildings["30,30"], "他人の建物まで消えている");
  assert.ok(buildings["59,64"], "元のマップを変更している");
});

test("buildings: 保存形式の移行（旧 {nationId, by} → ownerId）と往復", () => {
  // 旧形式: nationId は捨て、by がそのまま所有者になる
  const migrated = wb.parseBuildings(JSON.stringify({
    "59,64": { nationId: "n1", type: "house", by: "abc12345", at: 1 },
    "30,30": { nationId: "n2", type: "tower", by: "def67890", at: 3 },
  }));
  assert.deepEqual(migrated, {
    "59,64": { ownerId: "abc12345", type: "house", at: 1 },
    "30,30": { ownerId: "def67890", type: "tower", at: 3 },
  });
  // 新形式の往復
  const current = { "1,1": { ownerId: "abc12345", type: "farm", at: 7 } };
  assert.deepEqual(wb.parseBuildings(JSON.stringify(current)), current);
  // 所有者が特定できない要素・壊れた要素は落とす
  const dirty = wb.parseBuildings(JSON.stringify({
    "bad-key": { ownerId: "x", type: "house", at: 1 },
    "1,1": { ownerId: "x", type: "castle", at: 1 },
    "2,2": { ownerId: "x", type: "house", at: "時刻でない" },
    "3,3": { nationId: "n1", type: "house", at: 5 },
    "4,4": { ownerId: "", type: "house", at: 5 },
    "5,5": { ownerId: "x", type: "house", at: 5 },
  }));
  assert.deepEqual(Object.keys(dirty), ["5,5"]);
  assert.deepEqual(wb.parseBuildings("{壊れた"), {});
});

test("buildings: 繁栄度 = 国民5 + 国民の建物（家3・畑2・塔2）、ビューに載る", () => {
  const map = wb.generateMap();
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, "あご王国", map, 1000);
  const joined = wb.applyJoin(founded.state, USER_B, founded.nation.id);
  const state = joined.state;
  const buildings = {
    "59,64": { ownerId: wb.presenceIdFor(KING_A), type: "house", at: 1 },
    "58,64": { ownerId: wb.presenceIdFor(KING_A), type: "house", at: 1 },
    "57,64": { ownerId: wb.presenceIdFor(USER_B), type: "farm", at: 1 },
    "30,30": { ownerId: wb.presenceIdFor(USER_C), type: "tower", at: 1 },
  };
  // 国民2人 ×5 + 王の家2棟 ×3 + 国民の畑 ×2 = 18（非国民の塔は算入しない）
  assert.equal(wb.prosperityOf(state, buildings, founded.nation.id), 18);
  assert.equal(wb.prosperityOf(state, wb.emptyBuildings(), founded.nation.id), 10);
  const views = wb.nationViews(state, buildings);
  assert.equal(views[0].prosperity, 18);
  const res = wb.buildNationsResponse(state, USER_B, buildings);
  assert.equal(res.nations[0].prosperity, 18);
  assert.ok(!("buildings" in res), "国家レスポンスに建物が混ざっている");
  // 建物ビュー: 本人には mine が付き、時刻は出ない
  const mineViews = wb.buildingViews(buildings, KING_A);
  assert.equal(mineViews.find((v) => v.x === 59 && v.y === 64).mine, true);
  assert.equal(mineViews.find((v) => v.x === 30 && v.y === 30).mine, false);
  assert.equal(mineViews.find((v) => v.x === 30 && v.y === 30).ownerId, wb.presenceIdFor(USER_C));
  assert.ok(!("at" in mineViews[0]), "建築時刻が露出している");
  assert.ok(wb.buildingViews(buildings, null).every((v) => v.mine === false));
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
const buildingsUrl = dataUrl(
  transpile("worldbox/buildings.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./presence"', JSON.stringify(presenceUrl)),
);
const nationsUrl = dataUrl(
  transpile("worldbox/nations.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./presence"', JSON.stringify(presenceUrl))
    .replaceAll('"./buildings"', JSON.stringify(buildingsUrl)),
);
const nationsOnlineUrl = dataUrl(
  transpile("worldbox/nations-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./nations"', JSON.stringify(nationsUrl)),
);
const buildingsOnlineUrl = dataUrl(
  transpile("worldbox/buildings-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./buildings"', JSON.stringify(buildingsUrl)),
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
      .replaceAll('"@/lib/worldbox/nations-online"', JSON.stringify(nationsOnlineUrl))
      .replaceAll('"@/lib/worldbox/buildings-online"', JSON.stringify(buildingsOnlineUrl)),
  ),
);
const buildingsRoute = await import(
  dataUrl(
    transpile("api/worldbox/buildings/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/mapgen"', JSON.stringify(mapgenUrl))
      .replaceAll('"@/lib/worldbox/buildings"', JSON.stringify(buildingsUrl))
      .replaceAll('"@/lib/worldbox/buildings-online"', JSON.stringify(buildingsOnlineUrl))
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
function buildingsRequest(method, cookie, body, headers = {}) {
  return new Request("http://localhost/api/worldbox/buildings", {
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
  assert.ok(!("buildings" in body), "国家レスポンスに建物が混ざっている");
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
  assert.deepEqual(foundBody.nation.capital, { x: 512, y: 512 });
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
  assert.deepEqual((await refound.json()).nation.capital, { x: 512, y: 512 });
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

test("API(buildings): 個人所有の建築・繁栄度・所有者だけが取り壊し可・解散しても残る", async () => {
  const cookieD = sessionCookie("200000000000000010", "king-d");
  const cookieE = sessionCookie("200000000000000011", "user-e");
  const cookieF = sessionCookie("200000000000000012", "user-f");

  // ゲストは閲覧のみ、書き込みは 401
  const guestView = await (await buildingsRoute.GET(buildingsRequest("GET", null))).json();
  assert.deepEqual(guestView.buildings, []);
  assert.equal(guestView.loggedIn, false);
  assert.equal((await buildingsRoute.POST(buildingsRequest("POST", null, { action: "build", type: "house", x: 1, y: 1 }))).status, 401);
  assert.equal((await buildingsRoute.POST(buildingsRequest("POST", null, { action: "demolish", x: 1, y: 1 }))).status, 401);

  // 建てられるタイルを探す（実マップ準拠: 草・土・砂、広場と首都を除く。
  // 温帯の中心付近を探す。北の雪原帯は建築対象タイルが無い）
  const map = wb.generateMap();
  const buildable = [];
  for (let y = 480; y < 544 && buildable.length < 4; y++) {
    for (let x = 480; x < 544 && buildable.length < 4; x++) {
      if (wb.isSpawnPlazaTile(map, x, y)) continue;
      const t = wb.mapTileAt(map, x, y);
      if (t === wb.T_GRASS || t === wb.T_DIRT || t === wb.T_SAND) buildable.push({ x, y });
    }
  }
  assert.equal(buildable.length, 4, "建てられるタイルが足りない");
  const [t1, t2, t3, t4] = buildable;

  // 未所属でも建てられる（所有者は不透明 ID、本人には mine が付く）
  const fBuild = await buildingsRoute.POST(buildingsRequest("POST", cookieF, { action: "build", type: "house", x: t1.x, y: t1.y }));
  assert.equal(fBuild.status, 200);
  const fBuildings = (await fBuild.json()).buildings;
  assert.equal(fBuildings.length, 1);
  assert.equal(fBuildings[0].mine, true);
  assert.equal(fBuildings[0].type, "house");
  assert.ok(typeof fBuildings[0].ownerId === "string" && fBuildings[0].ownerId.length > 0);
  assert.ok(!("nationId" in fBuildings[0]), "建物ビューが国 ID を持っている");
  const guestView2 = await (await buildingsRoute.GET(buildingsRequest("GET", null))).json();
  assert.equal(guestView2.buildings.length, 1);
  assert.equal(guestView2.buildings[0].mine, false);

  // 建国（繁栄度は国民1人ぶん = 5）
  const found = await nationsRoute.POST(nationsRequest("POST", cookieD, { action: "found", name: "建築王国" }));
  assert.equal(found.status, 200);
  const foundBody = await found.json();
  const nationId = foundBody.nation.id;
  const capital = foundBody.nation.capital;
  assert.equal(foundBody.nation.prosperity, 5, "建国直後の繁栄度は国民1人ぶん");

  // エラーコード: 首都・広場・不正な種類
  const onCapital = await buildingsRoute.POST(buildingsRequest("POST", cookieD, { action: "build", type: "house", x: capital.x, y: capital.y }));
  assert.equal(onCapital.status, 409);
  assert.equal((await onCapital.json()).error, "on_capital");
  const onSpawn = await buildingsRoute.POST(buildingsRequest("POST", cookieD, { action: "build", type: "house", x: 510, y: 512 }));
  assert.equal(onSpawn.status, 409);
  assert.equal((await onSpawn.json()).error, "on_spawn");
  const badType = await buildingsRoute.POST(buildingsRequest("POST", cookieD, { action: "build", type: "castle", x: t2.x, y: t2.y }));
  assert.equal(badType.status, 400);
  assert.equal((await badType.json()).error, "invalid_type");
  const badAction = await buildingsRoute.POST(buildingsRequest("POST", cookieD, { action: "conquer", x: t2.x, y: t2.y }));
  assert.equal(badAction.status, 400);
  assert.equal((await badAction.json()).error, "invalid_action");
  const evil = await buildingsRoute.POST(buildingsRequest("POST", cookieD, { action: "build", type: "house", x: t2.x, y: t2.y }, { origin: "http://evil.example" }));
  assert.equal(evil.status, 403);

  // 王の建築は国の繁栄度に算入される
  const dBuild = await buildingsRoute.POST(buildingsRequest("POST", cookieD, { action: "build", type: "house", x: t2.x, y: t2.y }));
  assert.equal(dBuild.status, 200);
  const view1 = await (await nationsRoute.GET(nationsRequest("GET", null))).json();
  assert.equal(view1.nations.find((n) => n.id === nationId).prosperity, 5 + 3);
  assert.ok(!("buildings" in view1), "国家レスポンスに建物が混ざっている");
  // 同じ場所には建てられない
  const dup = await buildingsRoute.POST(buildingsRequest("POST", cookieD, { action: "build", type: "farm", x: t2.x, y: t2.y }));
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error, "tile_blocked");

  // 国民の建築も算入されるが、非国民の建築は算入されない
  assert.equal((await nationsRoute.POST(nationsRequest("POST", cookieE, { action: "join", nationId }))).status, 200);
  assert.equal((await buildingsRoute.POST(buildingsRequest("POST", cookieE, { action: "build", type: "farm", x: t3.x, y: t3.y }))).status, 200);
  assert.equal((await buildingsRoute.POST(buildingsRequest("POST", cookieF, { action: "build", type: "tower", x: t4.x, y: t4.y }))).status, 200);
  const view2 = await (await nationsRoute.GET(nationsRequest("GET", null))).json();
  assert.equal(view2.nations.find((n) => n.id === nationId).prosperity, 5 * 2 + 3 + 2);

  // 取り壊しは所有者だけ（同じ国の国民でも他人の建物は壊せない）
  const notOwner = await buildingsRoute.POST(buildingsRequest("POST", cookieE, { action: "demolish", x: t2.x, y: t2.y }));
  assert.equal(notOwner.status, 403);
  assert.equal((await notOwner.json()).error, "not_owner");
  const demolished = await buildingsRoute.POST(buildingsRequest("POST", cookieD, { action: "demolish", x: t2.x, y: t2.y }));
  assert.equal(demolished.status, 200);
  assert.equal((await demolished.json()).buildings.some((b) => b.x === t2.x && b.y === t2.y), false);

  // 解散しても建物は残る（個人所有のため）
  assert.equal((await nationsRoute.POST(nationsRequest("POST", cookieE, { action: "leave" }))).status, 200);
  const disband = await nationsRoute.POST(nationsRequest("POST", cookieD, { action: "leave" }));
  assert.equal(disband.status, 200);
  assert.equal((await disband.json()).disbanded, true);
  const afterNations = await (await nationsRoute.GET(nationsRequest("GET", null))).json();
  assert.equal(afterNations.nations.some((n) => n.id === nationId), false);
  const afterBuildings = await (await buildingsRoute.GET(buildingsRequest("GET", null))).json();
  assert.equal(afterBuildings.buildings.length, 3, "解散で建物が消えている");
  assert.ok(afterBuildings.buildings.some((b) => b.x === t3.x && b.y === t3.y), "国民だった人の畑が消えている");
});

// ---------- クライアント配線 ----------

test("クライアント: 国家 API・首都マーカーが配線され、領地ティントは無い", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("/api/worldbox/nations"), "国家 API を使っていない");
  assert.ok(client.includes("drawCapital"), "首都マーカーが無い");
  assert.ok(client.includes("建国"), "建国 UI が無い");
  assert.ok(client.includes("playerNations"), "プレゼンスへの国色付けが無い");
  // 国は所属区分のみ: 領地の塗りは存在しない
  assert.ok(!client.includes("territoryAt"), "領地判定が残っている");
  assert.ok(!client.includes("領地ティント"), "領地ティントが残っている");
});

test("クライアント: 建築モード・建物描画・繁栄度が配線されている", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("/api/worldbox/buildings"), "建物 API を使っていない");
  assert.ok(client.includes("buildingsUi.loggedIn"), "建築セクションがログイン連動でない");
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
