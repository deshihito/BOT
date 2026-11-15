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
    "MAP_W", "MAP_H", "T_GRASS", "T_WATER", "generateMap",
    "TERRITORY_RADIUS", "NATION_PALETTE", "emptyNationsState", "validateNationName", "isNameTaken",
    "pickNationColor", "capitalFits", "findCapitalTile", "territoryOwnerAt", "memberCounts",
    "applyFound", "applyJoin", "applyLeave", "parseNationsState", "nationViews", "playerNationMap",
    "buildNationsResponse",
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

// ---------- クライアント配線 ----------

test("クライアント: 国家 API・領地・首都マーカーが配線されている", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("/api/worldbox/nations"), "国家 API を使っていない");
  assert.ok(client.includes("TERRITORY_RADIUS"), "領地半径を使っていない");
  assert.ok(client.includes("drawCapital"), "首都マーカーが無い");
  assert.ok(client.includes("建国"), "建国 UI が無い");
  assert.ok(client.includes("playerNations"), "プレゼンスへの国色付けが無い");
});
