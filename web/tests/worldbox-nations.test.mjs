// AGO WORLD BOX 国家レイヤーの検証:
// - 純粋ロジック（渦巻き首都探索・首都間隔・パレット・状態遷移・役職導出・ギルド注釈）
// - 国家 API（国 = Discord サーバー: 建国はオーナーのみ・国名はサーバー名・
//   参加はメンバーのみ・役職は権限由来・旧形式の保存は破棄・ギルドキャッシュ）
// - 繁栄度は国民数のみ（旧プレハブ建物の算入は廃止済み）
// - クライアント配線（国家 API・首都マーカー・サーバー別建国/参加 UI）
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
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/move.ts", "worldbox/presence.ts", "worldbox/nations.ts", "worldbox/guilds.ts"],
  [
    "T_GRASS", "T_WATER", "T_DIRT", "T_SAND", "T_TREE", "T_ROCK", "worldTileSource", "tilesSource", "mapTileAt",
    "presenceIdFor", "fastTravelDestination", "FAST_TRAVEL_COST", "FAST_TRAVEL_COOLDOWN_MS",
    "TERRITORY_RADIUS", "NATION_PALETTE", "NATIONS_STATE_VERSION", "emptyNationsState",
    "pickNationColor", "capitalFits", "findCapitalTile", "memberCounts",
    "applyFound", "applyJoin", "applyLeave", "parseNationsState", "nationViews", "playerNationMap",
    "buildNationsResponse", "prosperityOf",
    "roleInGuild", "annotateMyGuilds", "parseGuildCache", "GUILD_CACHE_TTL_MS",
  ],
);

function fakeMap(fill, paint) {
  const tiles = new Uint8Array(128 * 128).fill(fill);
  paint?.(tiles);
  return wb.tilesSource(0, 128, 128, tiles);
}

const KING_A = "discord:100000000000000001";
const USER_B = "discord:100000000000000002";
const USER_C = "discord:100000000000000003";

const GUILD_1 = "900000000000000001";
const GUILD_2 = "900000000000000002";

// ---------- 渦巻き首都探索 ----------

test("nations: 空きマップでは中央が最初の首都になる", () => {
  const map = wb.worldTileSource();
  assert.deepEqual(wb.findCapitalTile(map, []), { x: 512, y: 512 });
});

test("nations: 2つ目の首都は領地が重ならない距離に置かれる", () => {
  const map = fakeMap(wb.T_GRASS);
  const first = wb.findCapitalTile(map, [], { x: 64, y: 64 });
  assert.deepEqual(first, { x: 64, y: 64 });
  const nations = [{ guildId: GUILD_1, name: "一国", color: wb.NATION_PALETTE[0], kingKey: KING_A, capital: first, createdAt: 1 }];
  // 距離 2R までは重なり、2R+1 から置ける
  assert.equal(wb.capitalFits(map, 64 + wb.TERRITORY_RADIUS * 2, 64, nations), false);
  assert.equal(wb.capitalFits(map, 64 + wb.TERRITORY_RADIUS * 2 + 1, 64, nations), true);
  const second = wb.findCapitalTile(map, nations, { x: 64, y: 64 });
  assert.ok(second);
  const d = Math.max(Math.abs(second.x - 64), Math.abs(second.y - 64));
  assert.ok(d > wb.TERRITORY_RADIUS * 2, `領地が重なっている d=${d}`);
  assert.deepEqual(second, { x: 51, y: 51 });
});

test("nations: 水のタイルは飛ばし、陸にだけ首都を置く", () => {
  const map = fakeMap(wb.T_WATER, (t) => {
    t[64 * 128 + 70] = wb.T_GRASS;
  });
  assert.deepEqual(wb.findCapitalTile(map, [], { x: 64, y: 64 }), { x: 70, y: 64 });
  const allWater = fakeMap(wb.T_WATER);
  assert.equal(wb.findCapitalTile(allWater, [], { x: 64, y: 64 }), null);
});

// ---------- パレット ----------

test("nations: 色は使用数の少ないものから割り当てる", () => {
  const empty = wb.emptyNationsState();
  assert.equal(wb.pickNationColor(empty), wb.NATION_PALETTE[0]);
  const one = {
    nations: { [GUILD_1]: { guildId: GUILD_1, name: "一国", color: wb.NATION_PALETTE[0], kingKey: KING_A, capital: { x: 64, y: 64 }, createdAt: 1 } },
    members: {},
  };
  assert.equal(wb.pickNationColor(one), wb.NATION_PALETTE[1]);
});

// ---------- 役職導出とギルド注釈 ----------

test("guilds: 役職は Discord 権限から（オーナー=王、ADMINISTRATOR=大臣、それ以外=国民）", () => {
  assert.equal(wb.roleInGuild({ owner: true, permissions: "0" }), "king");
  assert.equal(wb.roleInGuild({ owner: true, permissions: "8" }), "king");
  assert.equal(wb.roleInGuild({ owner: false, permissions: "8" }), "minister");
  // 大きなビットフィールドでも bit 3 だけを見る（2^40 は管理者ではない）
  assert.equal(wb.roleInGuild({ owner: false, permissions: "1099511627776" }), "citizen");
  assert.equal(wb.roleInGuild({ owner: false, permissions: "1099511627784" }), "minister");
  assert.equal(wb.roleInGuild({ owner: false, permissions: "32" }), "citizen"); // MANAGE_GUILD のみは国民
  assert.equal(wb.roleInGuild({ owner: false, permissions: "0" }), "citizen");
  assert.equal(wb.roleInGuild({ owner: false, permissions: "abc" }), "citizen");
  assert.equal(wb.roleInGuild({ owner: false, permissions: "" }), "citizen");
});

test("guilds: 自分のギルド一覧に国の有無と役職が付く", () => {
  const map = wb.worldTileSource();
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, { id: GUILD_1, name: "あご鯖" }, map, 1000);
  const annotated = wb.annotateMyGuilds([
    { id: GUILD_1, name: "あご鯖", owner: true, permissions: "0" },
    { id: GUILD_2, name: "別の鯖", owner: false, permissions: "8" },
  ], founded.state);
  assert.deepEqual(annotated, [
    { guildId: GUILD_1, name: "あご鯖", owner: true, hasNation: true, myRole: "king" },
    { guildId: GUILD_2, name: "別の鯖", owner: false, hasNation: false, myRole: "minister" },
  ]);
});

test("guilds: ギルドキャッシュは TTL 内だけ有効で、壊れた値は弾く", () => {
  const now = 1_000_000;
  const cache = JSON.stringify({
    fetchedAt: now - 1000,
    guilds: [{ id: GUILD_1, name: "あご鯖", owner: true, permissions: "0" }],
  });
  assert.deepEqual(wb.parseGuildCache(cache, now), [
    { id: GUILD_1, name: "あご鯖", owner: true, permissions: "0" },
  ]);
  // オブジェクトのまま渡ってきても読める
  assert.equal(wb.parseGuildCache(JSON.parse(cache), now).length, 1);
  // TTL を過ぎたら無効
  const stale = JSON.stringify({ fetchedAt: now - wb.GUILD_CACHE_TTL_MS, guilds: [] });
  assert.equal(wb.parseGuildCache(stale, now), null);
  // 壊れた値・形式違いは無効
  assert.equal(wb.parseGuildCache("{壊れた", now), null);
  assert.equal(wb.parseGuildCache(null, now), null);
  assert.equal(wb.parseGuildCache(JSON.stringify({ fetchedAt: now, guilds: [{ id: 1 }] }), now), null);
});

// ---------- 状態遷移 ----------

test("nations: 建国→王、参加→渡された役職、二重所属と重複建国は却下", () => {
  const map = wb.worldTileSource();
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, { id: GUILD_1, name: "あご鯖" }, map, 1000);
  assert.equal(founded.ok, true);
  assert.equal(founded.nation.guildId, GUILD_1);
  assert.equal(founded.nation.name, "あご鯖");
  assert.deepEqual(founded.nation.capital, { x: 512, y: 512 });
  assert.equal(founded.state.members[KING_A].role, "king");
  assert.equal(founded.nation.color, wb.NATION_PALETTE[0]);

  // 同じサーバーの国は二つ作れない（建国者でなくても）
  assert.equal(wb.applyFound(founded.state, USER_B, { id: GUILD_1, name: "あご鯖" }, map, 2000).error, "nation_exists");
  // 所属中は別のサーバーでも建国できない（1人1国）
  assert.equal(wb.applyFound(founded.state, KING_A, { id: GUILD_2, name: "別の鯖" }, map, 2000).error, "already_in_nation");
  // ギルド ID の形式が不正なら invalid_request
  assert.equal(wb.applyFound(wb.emptyNationsState(), KING_A, { id: "abc", name: "x" }, map, 2000).error, "invalid_request");

  const joined = wb.applyJoin(founded.state, USER_B, GUILD_1, "citizen");
  assert.equal(joined.ok, true);
  assert.equal(joined.state.members[USER_B].role, "citizen");
  assert.equal(wb.memberCounts(joined.state)[GUILD_1], 2);
  assert.equal(wb.applyJoin(joined.state, USER_B, GUILD_1, "citizen").error, "already_in_nation");
  assert.equal(wb.applyJoin(founded.state, USER_C, "999999999999999999", "citizen").error, "nation_not_found");
  // 大臣としての参加は役職がそのまま保存される
  const minister = wb.applyJoin(founded.state, USER_C, GUILD_1, "minister");
  assert.equal(minister.state.members[USER_C].role, "minister");
});

test("nations: 王の離脱規則と、解散で首都が空く", () => {
  const map = wb.worldTileSource();
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, { id: GUILD_1, name: "あご鯖" }, map, 1000);
  const joined = wb.applyJoin(founded.state, USER_B, GUILD_1, "citizen");

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

test("nations: 保存形式の往復（v2）と、旧形式の破棄・壊れた要素の除去", () => {
  const map = wb.worldTileSource();
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, { id: GUILD_1, name: "あご鯖" }, map, 1000);
  const restored = wb.parseNationsState(
    JSON.stringify({ v: wb.NATIONS_STATE_VERSION, nations: founded.state.nations }),
    JSON.stringify(founded.state.members),
  );
  assert.deepEqual(restored, founded.state);

  // 旧プレイヤー建国形式（包み無し・id キー）は丸ごと破棄する
  const legacy = wb.parseNationsState(
    JSON.stringify({
      abc12345: { id: "abc12345", name: "旧王国", color: wb.NATION_PALETTE[0], kingKey: KING_A, capital: { x: 512, y: 512 }, createdAt: 1 },
    }),
    JSON.stringify({ [KING_A]: { nationId: "abc12345", role: "king" } }),
  );
  assert.deepEqual(legacy, wb.emptyNationsState());
  // 版が違う包みも破棄する
  const wrongVersion = wb.parseNationsState(
    JSON.stringify({ v: 1, nations: founded.state.nations }),
    JSON.stringify(founded.state.members),
  );
  assert.deepEqual(wrongVersion, wb.emptyNationsState());

  // v2 でも壊れた要素は落とす
  const dirty = wb.parseNationsState(
    JSON.stringify({
      v: wb.NATIONS_STATE_VERSION,
      nations: {
        bad1: { guildId: GUILD_1, name: "色が不正", color: "#000000", kingKey: KING_A, capital: { x: 1, y: 1 }, createdAt: 1 },
        bad2: { guildId: GUILD_2, name: "首都が範囲外", color: wb.NATION_PALETTE[0], kingKey: KING_A, capital: { x: 2000000, y: 1 }, createdAt: 1 },
      },
    }),
    JSON.stringify({
      [KING_A]: { nationId: GUILD_1, role: "king" },
      [USER_B]: { nationId: GUILD_2, role: "変な役職" },
    }),
  );
  assert.deepEqual(dirty, wb.emptyNationsState());
  assert.deepEqual(wb.parseNationsState("{壊れた", null), wb.emptyNationsState());
});

test("nations: 表示用ビューの人数とプレイヤー色マップ、ギルド情報の素通し", () => {
  const map = wb.worldTileSource();
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, { id: GUILD_1, name: "あご鯖" }, map, 1000);
  const joined = wb.applyJoin(founded.state, USER_B, GUILD_1, "citizen");
  const views = wb.nationViews(joined.state);
  assert.equal(views.length, 1);
  assert.equal(views[0].id, GUILD_1);
  assert.equal(views[0].guildId, GUILD_1);
  assert.equal(views[0].members, 2);
  assert.ok(!("kingKey" in views[0]), "王の所有者キーが露出している");
  const colors = wb.playerNationMap(joined.state);
  assert.equal(Object.keys(colors).length, 2);
  assert.equal(Object.values(colors)[0].color, wb.NATION_PALETTE[0]);
  const res = wb.buildNationsResponse(joined.state, USER_B);
  assert.deepEqual(res.me, { nationId: GUILD_1, role: "citizen" });
  assert.equal(res.loggedIn, true);
  assert.deepEqual(res.myGuilds, []);
  assert.equal(res.guildsScopeRequired, false);
  const withGuilds = wb.buildNationsResponse(joined.state, USER_B, {
    myGuilds: [{ guildId: GUILD_1, name: "あご鯖", owner: false, hasNation: true, myRole: "citizen" }],
    guildsScopeRequired: true,
  });
  assert.equal(withGuilds.myGuilds.length, 1);
  assert.equal(withGuilds.guildsScopeRequired, true);
  assert.equal(wb.buildNationsResponse(joined.state, null).loggedIn, false);
});

// ---------- 繁栄度（国民数のみ） ----------

test("nations: 繁栄度 = 国民数 × 5 のみ（旧プレハブ建物の算入は廃止）、ビューに載る", () => {
  const map = wb.worldTileSource();
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, { id: GUILD_1, name: "あご鯖" }, map, 1000);
  assert.equal(wb.prosperityOf(founded.state, GUILD_1), 5);
  const joined = wb.applyJoin(founded.state, USER_B, GUILD_1, "citizen");
  const state = joined.state;
  // 国民2人 ×5 = 10。それ以外の要素（建物など）は算入しない
  assert.equal(wb.prosperityOf(state, GUILD_1), 10);
  assert.equal(wb.prosperityOf(state, GUILD_2), 0);
  const views = wb.nationViews(state);
  assert.equal(views[0].prosperity, 10);
  const res = wb.buildNationsResponse(state, USER_B);
  assert.equal(res.nations[0].prosperity, 10);
  assert.ok(!("buildings" in res), "国家レスポンスに建物が混ざっている");
  // 離脱で国民が減れば繁栄度も下がる
  const left = wb.applyLeave(state, USER_B);
  assert.equal(wb.prosperityOf(left.state, GUILD_1), 5);
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
// dashboard のスタブ: web_sessions（sid → トークン）と Discord 取得を差し替える
const dashboardStubUrl = dataUrl(`
export async function loadWebSession(sid) { return globalThis.__wbWebSessions?.[sid] ?? null; }
export async function fetchDiscordGuilds(token) {
  const counts = (globalThis.__wbGuildFetchCount ??= {});
  counts[token] = (counts[token] ?? 0) + 1;
  const table = globalThis.__wbGuildsByToken ?? {};
  return Object.prototype.hasOwnProperty.call(table, token) ? table[token] : null;
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
const presenceUrl = dataUrl(transpile("worldbox/presence.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)));
const moveUrl = dataUrl(
  transpile("worldbox/move.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)),
);
const nationsUrl = dataUrl(
  transpile("worldbox/nations.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./move"', JSON.stringify(moveUrl))
    .replaceAll('"./presence"', JSON.stringify(presenceUrl))
);
const lobbyUrl = dataUrl(
  transpile("worldbox/lobby.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)),
);
const tentUrl = dataUrl(
  transpile("worldbox/tent.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl)),
);
const saveUrl = dataUrl(
  transpile("worldbox/save.ts")
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl))
    .replaceAll('"./tent"', JSON.stringify(tentUrl))
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)),
);
const saveOnlineUrl = dataUrl(
  transpile("worldbox/save-online.ts").replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl)),
);
const presenceOnlineUrl = dataUrl(
  transpile("worldbox/presence-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./presence"', JSON.stringify(presenceUrl)),
);
const guildsUrl = dataUrl(
  transpile("worldbox/guilds.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"../dashboard"', JSON.stringify(dashboardStubUrl))
    .replaceAll('"../auth"', JSON.stringify(authUrl)),
);
const nationsOnlineUrl = dataUrl(
  transpile("worldbox/nations-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./nations"', JSON.stringify(nationsUrl)),
);
const nationSettingsUrl = dataUrl(
  transpile("worldbox/nation-settings.ts")
    .replaceAll('"./nations"', JSON.stringify(nationsUrl)),
);
const userLockUrl = dataUrl(transpile("worldbox/user-lock.ts"));
const warUrl = dataUrl(transpile("worldbox/war.ts"));
const warOnlineUrl = dataUrl(
  transpile("worldbox/war-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./war"', JSON.stringify(warUrl))
    .replaceAll('"./user-lock"', JSON.stringify(userLockUrl)),
);
const nationSettingsOnlineUrl = dataUrl(
  transpile("worldbox/nation-settings-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./nation-settings"', JSON.stringify(nationSettingsUrl))
    .replaceAll('"./user-lock"', JSON.stringify(userLockUrl)),
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
const stationStubUrl = dataUrl(`
export async function loadMyLobbyStation() {
  return globalThis.__wbStationValue ?? null;
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
      .replaceAll('"@/lib/worldbox/save"', JSON.stringify(saveUrl))
      .replaceAll('"@/lib/worldbox/save-online"', JSON.stringify(saveOnlineUrl))
      .replaceAll('"@/lib/worldbox/presence-online"', JSON.stringify(presenceOnlineUrl))
      .replaceAll('"@/lib/worldbox/station-online"', JSON.stringify(stationStubUrl))
      .replaceAll('"@/lib/worldbox/guilds"', JSON.stringify(guildsUrl))
      .replaceAll('"@/lib/worldbox/nation-settings"', JSON.stringify(nationSettingsUrl))
      .replaceAll('"@/lib/worldbox/nation-settings-online"', JSON.stringify(nationSettingsOnlineUrl))
      .replaceAll('"@/lib/worldbox/war"', JSON.stringify(warUrl))
      .replaceAll('"@/lib/worldbox/war-online"', JSON.stringify(warOnlineUrl)),
  ),
);
const spawnUrl = dataUrl(
  transpile("worldbox/spawn.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./move"', JSON.stringify(moveUrl)),
);
const saveRoute = await import(
  dataUrl(
    transpile("api/worldbox/save/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/save"', JSON.stringify(saveUrl))
      .replaceAll('"@/lib/worldbox/save-online"', JSON.stringify(saveOnlineUrl))
      .replaceAll('"@/lib/worldbox/presence"', JSON.stringify(presenceUrl))
      .replaceAll('"@/lib/worldbox/presence-online"', JSON.stringify(presenceOnlineUrl))
      .replaceAll('"@/lib/worldbox/spawn"', JSON.stringify(spawnUrl)),
  ),
);
process.env.DISCORD_SESSION_SECRET = ["worldbox", "nations", "test", "secret"].join("-");
globalThis.__wbWebSessions = {};
globalThis.__wbGuildsByToken = {};
globalThis.__wbGuildFetchCount = {};
// 役職の操作はギルドボード前が前提（既存シナリオはボード前で操作している）
globalThis.__wbStationValue = "guild";

function sessionCookie(id, username) {
  const value = auth.createSession({ id, username });
  return `ago_session=${encodeURIComponent(value)}`;
}
/** sid 付きセッション（= サーバー側に Discord トークンがあるログイン）を用意する。 */
function guildUser(id, username, sidHex, guilds) {
  const sid = sidHex.repeat(32);
  const token = `token-${id}`;
  globalThis.__wbWebSessions[sid] = {
    user_id: id, username, access_token: token, expires_at: Date.now() + 3600_000,
  };
  globalThis.__wbGuildsByToken[token] = guilds;
  const value = auth.createSession({ id, username }, sid);
  return `ago_session=${encodeURIComponent(value)}`;
}
function discordGuild(id, name, owner, permissions) {
  return { id, name, icon: null, owner, permissions };
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
const ALPHA = "900000000000000011"; // あご鯖
const BETA = "900000000000000012"; // べた鯖

test("API(nations): ゲストは閲覧のみ、書き込みは 401", async () => {
  const res = await nationsRoute.GET(nationsRequest("GET", null));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.nations, []);
  assert.equal(body.me, null);
  assert.equal(body.loggedIn, false);
  assert.deepEqual(body.myGuilds, []);
  assert.equal(body.guildsScopeRequired, false);
  assert.ok(!("buildings" in body), "国家レスポンスに建物が混ざっている");
  assert.equal((await nationsRoute.POST(nationsRequest("POST", null, { action: "found", guildId: ALPHA }))).status, 401);
  assert.equal((await nationsRoute.POST(nationsRequest("POST", null, { action: "leave" }))).status, 401);
});

test("API(nations): 建国はオーナーのみ・国名はサーバー名・参加はメンバーのみ・役職は権限由来", async () => {
  // A: ALPHA のオーナー、BETA の一般メンバー
  const cookieA = guildUser("200000000000000001", "king-a", "a1", [
    discordGuild(ALPHA, "あご鯖", true, "0"),
    discordGuild(BETA, "べた鯖", false, "0"),
  ]);
  // B: ALPHA の一般メンバー、BETA の管理者
  const cookieB = guildUser("200000000000000002", "user-b", "b2", [
    discordGuild(ALPHA, "あご鯖", false, "0"),
    discordGuild(BETA, "べた鯖", false, "8"),
  ]);
  // C: どこのメンバーでもない
  const cookieC = guildUser("200000000000000003", "user-c", "c3", []);
  // D: BETA のオーナー
  const cookieD = guildUser("200000000000000004", "king-d", "d4", [
    discordGuild(BETA, "べた鯖", true, "0"),
  ]);
  // E: ALPHA のオーナー扱い（所有権が移った想定。国が既にあるケース用）
  const cookieE = guildUser("200000000000000005", "user-e", "e5", [
    discordGuild(ALPHA, "あご鯖", true, "0"),
  ]);
  // F: BETA の一般メンバー（国の無いサーバーへの参加用）
  const cookieF = guildUser("200000000000000006", "user-f", "f6", [
    discordGuild(BETA, "べた鯖", false, "0"),
  ]);

  // オーナー以外は建国できない（メンバーでも、部外者でも）
  const memberFound = await nationsRoute.POST(nationsRequest("POST", cookieB, { action: "found", guildId: ALPHA }));
  assert.equal(memberFound.status, 403);
  assert.equal((await memberFound.json()).error, "not_owner");
  const outsiderFound = await nationsRoute.POST(nationsRequest("POST", cookieC, { action: "found", guildId: ALPHA }));
  assert.equal(outsiderFound.status, 403);
  assert.equal((await outsiderFound.json()).error, "not_owner");

  // 建国: クライアントが名前を送ってきても、サーバー名が国名になる
  const found = await nationsRoute.POST(nationsRequest("POST", cookieA, { action: "found", guildId: ALPHA, name: "偽の国名" }));
  assert.equal(found.status, 200);
  const foundBody = await found.json();
  assert.equal(foundBody.me.role, "king");
  assert.equal(foundBody.nation.id, ALPHA);
  assert.equal(foundBody.nation.guildId, ALPHA);
  assert.equal(foundBody.nation.name, "あご鯖");
  assert.deepEqual(foundBody.nation.capital, { x: 512, y: 512 });
  assert.equal(foundBody.nation.members, 1);

  // ゲストからも見える（人数つき）
  const guestView = await (await nationsRoute.GET(nationsRequest("GET", null))).json();
  assert.equal(guestView.nations.length, 1);
  assert.equal(guestView.nations[0].members, 1);
  assert.equal(Object.keys(guestView.playerNations).length, 1);
  assert.equal(Object.values(guestView.playerNations)[0].color, guestView.nations[0].color);

  // 同じサーバーの二重建国は 409（再建国も、別オーナー扱いでも）
  const again = await nationsRoute.POST(nationsRequest("POST", cookieA, { action: "found", guildId: ALPHA }));
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, "nation_exists");
  const transferred = await nationsRoute.POST(nationsRequest("POST", cookieE, { action: "found", guildId: ALPHA }));
  assert.equal(transferred.status, 409);
  assert.equal((await transferred.json()).error, "nation_exists");

  // 参加はそのサーバーのメンバーだけ
  const outsiderJoin = await nationsRoute.POST(nationsRequest("POST", cookieC, { action: "join", guildId: ALPHA }));
  assert.equal(outsiderJoin.status, 403);
  assert.equal((await outsiderJoin.json()).error, "not_member");
  // 国の無いサーバーへの参加は nation_not_found
  const noNation = await nationsRoute.POST(nationsRequest("POST", cookieF, { action: "join", guildId: BETA }));
  assert.equal(noNation.status, 409);
  assert.equal((await noNation.json()).error, "nation_not_found");

  // 参加→市民、二重参加は却下
  const join = await nationsRoute.POST(nationsRequest("POST", cookieB, { action: "join", guildId: ALPHA }));
  assert.equal(join.status, 200);
  assert.equal((await join.json()).me.role, "citizen");
  const joinAgain = await nationsRoute.POST(nationsRequest("POST", cookieB, { action: "join", guildId: ALPHA }));
  assert.equal(joinAgain.status, 409);
  assert.equal((await joinAgain.json()).error, "already_in_nation");

  // GET の myGuilds 注釈（国の有無・自分の役職）
  const viewB = await (await nationsRoute.GET(nationsRequest("GET", cookieB))).json();
  assert.deepEqual(viewB.myGuilds, [
    { guildId: ALPHA, name: "あご鯖", owner: false, hasNation: true, myRole: "citizen" },
    { guildId: BETA, name: "べた鯖", owner: false, hasNation: false, myRole: "minister" },
  ]);
  const viewA = await (await nationsRoute.GET(nationsRequest("GET", cookieA))).json();
  assert.deepEqual(viewA.myGuilds[0], { guildId: ALPHA, name: "あご鯖", owner: true, hasNation: true, myRole: "king" });
  assert.equal(viewA.nations[0].members, 2);

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

  // 管理者権限のメンバーは大臣として参加する
  const foundBeta = await nationsRoute.POST(nationsRequest("POST", cookieD, { action: "found", guildId: BETA }));
  assert.equal(foundBeta.status, 200);
  assert.deepEqual((await foundBeta.json()).nation.capital, { x: 512, y: 512 });
  const joinMinister = await nationsRoute.POST(nationsRequest("POST", cookieB, { action: "join", guildId: BETA }));
  assert.equal(joinMinister.status, 200);
  assert.equal((await joinMinister.json()).me.role, "minister");
  assert.equal((await nationsRoute.POST(nationsRequest("POST", cookieB, { action: "leave" }))).status, 200);
  assert.equal((await nationsRoute.POST(nationsRequest("POST", cookieD, { action: "leave" }))).status, 200);
});

test("API(nations): 役職は GET のたびに Discord 権限から読み直され、ギルド一覧はキャッシュされる", async () => {
  const GAMMA = "900000000000000013";
  const cookieG = guildUser("200000000000000007", "king-g", "a7", [
    discordGuild(GAMMA, "がんま鯖", true, "0"),
  ]);
  const cookieH = guildUser("200000000000000008", "user-h", "b8", [
    discordGuild(GAMMA, "がんま鯖", false, "0"),
  ]);
  assert.equal((await nationsRoute.POST(nationsRequest("POST", cookieG, { action: "found", guildId: GAMMA }))).status, 200);
  const joined = await nationsRoute.POST(nationsRequest("POST", cookieH, { action: "join", guildId: GAMMA }));
  assert.equal((await joined.json()).me.role, "citizen");

  // Discord 側で管理者になった + キャッシュを捨てると、次の GET で大臣に直る
  globalThis.__wbGuildsByToken["token-200000000000000008"] = [
    discordGuild(GAMMA, "がんま鯖", false, "8"),
  ];
  globalThis.__wbNationsStore.delete("worldbox_auth discord:200000000000000008");
  const refreshed = await (await nationsRoute.GET(nationsRequest("GET", cookieH))).json();
  assert.deepEqual(refreshed.me, { nationId: GAMMA, role: "minister" });

  // ギルド一覧は bot_kv キャッシュが効く（2回の GET で Discord 取得は1回だけ）
  const cookieI = guildUser("200000000000000009", "user-i", "c9", [
    discordGuild(GAMMA, "がんま鯖", false, "0"),
  ]);
  await nationsRoute.GET(nationsRequest("GET", cookieI));
  await nationsRoute.GET(nationsRequest("GET", cookieI));
  assert.equal(globalThis.__wbGuildFetchCount["token-200000000000000009"], 1);

  // 後片付け
  assert.equal((await nationsRoute.POST(nationsRequest("POST", cookieH, { action: "leave" }))).status, 200);
  assert.equal((await nationsRoute.POST(nationsRequest("POST", cookieG, { action: "leave" }))).status, 200);
});

test("API(nations): トークンの無いセッションは guilds_scope_required（再ログイン導線）", async () => {
  // sid 無しの Cookie だけのセッション（トークン保存前のログイン想定）
  const cookie = sessionCookie("200000000000000020", "legacy-user");
  const view = await (await nationsRoute.GET(nationsRequest("GET", cookie))).json();
  assert.equal(view.loggedIn, true);
  assert.equal(view.guildsScopeRequired, true);
  assert.deepEqual(view.myGuilds, []);
  const found = await nationsRoute.POST(nationsRequest("POST", cookie, { action: "found", guildId: ALPHA }));
  assert.equal(found.status, 409);
  assert.equal((await found.json()).error, "guilds_scope_required");
  const join = await nationsRoute.POST(nationsRequest("POST", cookie, { action: "join", guildId: ALPHA }));
  assert.equal(join.status, 409);
  assert.equal((await join.json()).error, "guilds_scope_required");
  // 離脱はギルド検証なしで処理される（未所属なので not_in_nation）
  const leave = await nationsRoute.POST(nationsRequest("POST", cookie, { action: "leave" }));
  assert.equal(leave.status, 409);
  assert.equal((await leave.json()).error, "not_in_nation");
});

test("API(nations): 旧形式の保存データは読み込み時に破棄される", async () => {
  const store = globalThis.__wbNationsStore;
  store.set("worldbox_nations nations", JSON.stringify({
    abc12345: { id: "abc12345", name: "旧王国", color: "#e5484d", kingKey: "discord:1", capital: { x: 512, y: 512 }, createdAt: 1 },
  }));
  store.set("worldbox_nations members", JSON.stringify({
    "discord:1": { nationId: "abc12345", role: "king" },
  }));
  const view = await (await nationsRoute.GET(nationsRequest("GET", null))).json();
  assert.deepEqual(view.nations, []);
  assert.deepEqual(view.playerNations, {});
  store.delete("worldbox_nations nations");
  store.delete("worldbox_nations members");
});

test("API(nations): 不正なアクションは 400、他オリジンは 403", async () => {
  const cookie = sessionCookie("200000000000000009", "user-z");
  const bad = await nationsRoute.POST(nationsRequest("POST", cookie, { action: "conquer" }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "invalid_action");
  const badGuild = await nationsRoute.POST(nationsRequest("POST", cookie, { action: "found", guildId: "abc" }));
  assert.equal(badGuild.status, 400);
  assert.equal((await badGuild.json()).error, "invalid_request");
  const evil = await nationsRoute.POST(
    nationsRequest("POST", cookie, { action: "leave" }, { origin: "http://evil.example" }),
  );
  assert.equal(evil.status, 403);
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

test("クライアント: 建国・参加はサーバー単位（国名の自由入力は無い）", () => {
  // 建国・参加の UI はギルドボードの役職タブ（WorldBoxGuildBoardPanel）が home
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxGuildBoardPanel.tsx"), "utf8");
  const ui = client + panel;
  assert.ok(!ui.includes('placeholder="国名"'), "国名の自由入力が残っている");
  assert.ok(!ui.includes("nationName"), "国名の入力状態が残っている");
  assert.ok(!ui.includes('action: "found", name'), "建国で名前を送っている");
  assert.ok(!ui.includes('action: "join", nationId'), "参加が国 ID 指定のまま");
  assert.ok(panel.includes("建国できるサーバー"), "建国できるサーバーの一覧が無い");
  assert.ok(panel.includes("国があるサーバー"), "国があるサーバーの一覧が無い");
  assert.ok(panel.includes('action: "found", guildId'), "建国がサーバー指定でない");
  assert.ok(panel.includes('action: "join", guildId'), "参加がサーバー指定でない");
  assert.ok(panel.includes("guildsScopeRequired"), "再ログイン導線の分岐が無い");
  assert.ok(panel.includes("/api/auth/discord/authorize?next=/games/worldbox"), "再ログインリンクが無い");
});

test("クライアント: 旧プレハブ建物（家・畑・塔）は廃止され、繁栄度表示は残る", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  // 建物 API・建築モード・建物描画は撤去済み（家はブロック自由建築、畑は耕して植える）
  assert.ok(!client.includes("/api/worldbox/buildings"), "建物 API が残っている");
  assert.ok(!client.includes("drawBuilding"), "建物の描画が残っている");
  assert.ok(!client.includes("buildValidity"), "建築可否のハイライトが残っている");
  assert.ok(!client.includes("chooseBuildTool"), "建築ツールの選択が残っている");
  assert.ok(!client.includes('action: "demolish"'), "取り壊しアクションが残っている");
  assert.ok(!client.includes("buildingsRef"), "建物レイヤーの参照が残っている");
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxGuildBoardPanel.tsx"), "utf8");
  assert.ok(panel.includes("繁栄度"), "繁栄度の表示が無い");
  assert.ok(panel.includes("prosperity - a.prosperity") || panel.includes("b.prosperity - a.prosperity"), "国リストが繁栄度順でない");
  // 移動の当たり判定は空間でマップと固体集合を切り替える（固体は設置ブロック＋モブ占有）
  assert.ok(client.includes("stepMove(activeMap(), player, vel, sdt, activeBlocked(), { swim: space === \"world\" })"), "当たり判定の配線が無い");
  assert.ok(client.includes("blockedRef"), "ワールドの固体集合が無い");
});

// ---------- ファストトラベル ----------

test("nations: ファストトラベル先は所属国の首都のみ（料金・クールダウンは当面ゼロ）", () => {
  assert.equal(wb.FAST_TRAVEL_COST, 0);
  assert.equal(wb.FAST_TRAVEL_COOLDOWN_MS, 0);
  const map = wb.worldTileSource();
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, { id: GUILD_1, name: "あご鯖" }, map, 1000);
  const joined = wb.applyJoin(founded.state, USER_B, GUILD_1, "citizen");
  const cap = founded.nation.capital;
  for (const key of [KING_A, USER_B]) {
    const dest = wb.fastTravelDestination(joined.state, key, map);
    assert.equal(dest.ok, true);
    assert.equal(dest.nationId, GUILD_1);
    assert.ok(Math.abs(dest.x - (cap.x + 0.5)) <= 1.5 && Math.abs(dest.y - (cap.y + 0.5)) <= 1.5, `(${dest.x}, ${dest.y})`);
  }
  assert.equal(wb.fastTravelDestination(joined.state, USER_C, map).error, "not_in_nation");
});

test("API(nations): トラベルは所属者だけができ、セーブがユニオンマーク位置になる", async () => {
  const GAMMA = "900000000000000013";
  const cookieG = guildUser("200000000000000101", "king-g", "67", [
    discordGuild(GAMMA, "がま鯖", true, "0"),
  ]);
  const cookieH = guildUser("200000000000000102", "user-h", "88", [
    discordGuild(GAMMA, "がま鯖", false, "0"),
  ]);
  const cookieI = guildUser("200000000000000103", "user-i", "99", []);
  // 未所属は却下（状態競合系の 409）
  const denied = await nationsRoute.POST(nationsRequest("POST", cookieI, { action: "travel" }));
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).error, "not_in_nation");
  // 建国して首都を得る
  const found = await nationsRoute.POST(nationsRequest("POST", cookieG, { action: "found", guildId: GAMMA }));
  assert.equal(found.status, 200);
  const cap = (await found.json()).nation.capital;
  // 王のトラベル: 座標は首都タイル中心付近
  const tv = await nationsRoute.POST(nationsRequest("POST", cookieG, { action: "travel" }));
  assert.equal(tv.status, 200);
  const tvBody = await tv.json();
  assert.equal(tvBody.nationId, GAMMA);
  assert.ok(Math.abs(tvBody.x - (cap.x + 0.5)) <= 1.5 && Math.abs(tvBody.y - (cap.y + 0.5)) <= 1.5, `(${tvBody.x}, ${tvBody.y})`);
  // セーブに反映されている
  const saveMod = await import(saveUrl);
  const savedRaw = globalThis.__wbNationsStore.get("worldbox_save discord:200000000000000101");
  assert.ok(savedRaw, "トラベル先がセーブに保存されていない");
  const saved = saveMod.parseSave(savedRaw);
  assert.equal(saved.space, "world");
  assert.equal(saved.x, tvBody.x);
  assert.equal(saved.y, tvBody.y);
  // 国民もトラベルできる
  assert.equal((await nationsRoute.POST(nationsRequest("POST", cookieH, { action: "join", guildId: GAMMA }))).status, 200);
  const tvH = await nationsRoute.POST(nationsRequest("POST", cookieH, { action: "travel" }));
  assert.equal(tvH.status, 200);
  assert.equal((await tvH.json()).nationId, GAMMA);
  // 後片付け
  await nationsRoute.POST(nationsRequest("POST", cookieH, { action: "leave" }));
  await nationsRoute.POST(nationsRequest("POST", cookieG, { action: "leave" }));
});

// ---------- 初期スポーン（セーブ初回作成） ----------

test("API(save): 初回 GET はランダムな陸スポーンでセーブを作り、以後は同じ位置を返す", async () => {
  const cookie = sessionCookie("200000000000000201", "newbie");
  const req = () => new Request("http://localhost/api/worldbox/save", { headers: { cookie } });
  const res = await saveRoute.GET(req());
  assert.equal(res.status, 200);
  const body = await res.json();
  const saveMod = await import(saveUrl);
  const parsed = saveMod.parseSave(body.save);
  assert.ok(parsed, "初回セーブが解釈できない");
  assert.equal(parsed.space, "world");
  const tx = Math.floor(parsed.x);
  const ty = Math.floor(parsed.y);
  assert.ok(Math.abs(tx) <= 2000 && Math.abs(ty) <= 2000, `スポーン範囲外 (${tx}, ${ty})`);
  // 陸の歩行可能タイル（草・砂・土・雪）の中心に落ちる
  const t = wb.mapTileAt(wb.worldTileSource(), tx, ty);
  assert.ok([wb.T_GRASS, wb.T_SAND, wb.T_DIRT, 6].includes(t), `スポーン不可タイル ${t} at (${tx}, ${ty})`);
  assert.equal(parsed.x, tx + 0.5);
  assert.equal(parsed.y, ty + 0.5);
  // 2回目は作り直さず、保存済みの位置をそのまま返す
  const res2 = await saveRoute.GET(req());
  assert.equal(res2.status, 200);
  assert.equal((await res2.json()).save, body.save);
  // 未ログインは 401
  assert.equal((await saveRoute.GET(new Request("http://localhost/api/worldbox/save"))).status, 401);
});

test("API(nations): 役職の操作はギルドボードの前でのみ（場所ゲート）", async () => {
  const DELTA = "900000000000000014";
  const cookieJ = guildUser("200000000000000090", "king-j2", "f9", [
    discordGuild(DELTA, "でるた鯖", true, "0"),
  ]);
  try {
    // 広場（ギルドボード前でない）からは建国できない
    globalThis.__wbStationValue = null;
    const away = await nationsRoute.POST(nationsRequest("POST", cookieJ, { action: "found", guildId: DELTA }));
    assert.equal(away.status, 409);
    assert.equal((await away.json()).error, "not_at_guild_board");
    // 別の施設の前でもダメ
    globalThis.__wbStationValue = "shop";
    const atShop = await nationsRoute.POST(nationsRequest("POST", cookieJ, { action: "found", guildId: DELTA }));
    assert.equal(atShop.status, 409);
    assert.equal((await atShop.json()).error, "not_at_guild_board");
    // ギルドボードの前なら建国できる
    globalThis.__wbStationValue = "guild";
    assert.equal((await nationsRoute.POST(nationsRequest("POST", cookieJ, { action: "found", guildId: DELTA }))).status, 200);
    // 離脱もギルドボードの前でのみ
    globalThis.__wbStationValue = null;
    const leaveAway = await nationsRoute.POST(nationsRequest("POST", cookieJ, { action: "leave" }));
    assert.equal(leaveAway.status, 409);
    assert.equal((await leaveAway.json()).error, "not_at_guild_board");
    globalThis.__wbStationValue = "guild";
    assert.equal((await nationsRoute.POST(nationsRequest("POST", cookieJ, { action: "leave" }))).status, 200);
  } finally {
    globalThis.__wbStationValue = "guild";
  }
});
