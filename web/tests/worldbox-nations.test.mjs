// AGO WORLD BOX 国家レイヤー＋建物の検証:
// - 純粋ロジック（渦巻き首都探索・首都間隔・パレット・状態遷移・役職導出・ギルド注釈）
// - 国家 API（国 = Discord サーバー: 建国はオーナーのみ・国名はサーバー名・
//   参加はメンバーのみ・役職は権限由来・旧形式の保存は破棄・ギルドキャッシュ）
// - 建物（個人所有: 所属なしでも建築可・首都/広場は保護・所有者だけが取り壊し可・解散しても残る）
// - クライアント配線（国家 API・建物 API・首都マーカー・サーバー別建国/参加 UI）
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
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/presence.ts", "worldbox/buildings.ts", "worldbox/nations.ts", "worldbox/guilds.ts"],
  [
    "MAP_W", "MAP_H", "T_GRASS", "T_WATER", "T_DIRT", "T_SAND", "T_TREE", "T_ROCK", "generateMap", "mapTileAt",
    "isSpawnPlazaTile", "presenceIdFor",
    "TERRITORY_RADIUS", "NATION_PALETTE", "NATIONS_STATE_VERSION", "emptyNationsState",
    "pickNationColor", "capitalFits", "findCapitalTile", "memberCounts",
    "applyFound", "applyJoin", "applyLeave", "parseNationsState", "nationViews", "playerNationMap",
    "buildNationsResponse",
    "roleInGuild", "annotateMyGuilds", "parseGuildCache", "GUILD_CACHE_TTL_MS",
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

const GUILD_1 = "900000000000000001";
const GUILD_2 = "900000000000000002";

// ---------- 渦巻き首都探索 ----------

test("nations: 空きマップでは中央が最初の首都になる", () => {
  const map = wb.generateMap();
  assert.deepEqual(wb.findCapitalTile(map, []), { x: 512, y: 512 });
});

test("nations: 2つ目の首都は領地が重ならない距離に置かれる", () => {
  const map = fakeMap(wb.T_GRASS);
  const first = wb.findCapitalTile(map, []);
  assert.deepEqual(first, { x: 64, y: 64 });
  const nations = [{ guildId: GUILD_1, name: "一国", color: wb.NATION_PALETTE[0], kingKey: KING_A, capital: first, createdAt: 1 }];
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
  const map = wb.generateMap();
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
  const map = wb.generateMap();
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
  const map = wb.generateMap();
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
  const map = wb.generateMap();
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
        bad2: { guildId: GUILD_2, name: "首都が範囲外", color: wb.NATION_PALETTE[0], kingKey: KING_A, capital: { x: 9999, y: 1 }, createdAt: 1 },
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
  const map = wb.generateMap();
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
  const withGuilds = wb.buildNationsResponse(joined.state, USER_B, wb.emptyBuildings(), {
    myGuilds: [{ guildId: GUILD_1, name: "あご鯖", owner: false, hasNation: true, myRole: "citizen" }],
    guildsScopeRequired: true,
  });
  assert.equal(withGuilds.myGuilds.length, 1);
  assert.equal(withGuilds.guildsScopeRequired, true);
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
  const founded = wb.applyFound(wb.emptyNationsState(), KING_A, { id: GUILD_1, name: "あご鯖" }, map, 1000);
  const joined = wb.applyJoin(founded.state, USER_B, GUILD_1, "citizen");
  const state = joined.state;
  const buildings = {
    "59,64": { ownerId: wb.presenceIdFor(KING_A), type: "house", at: 1 },
    "58,64": { ownerId: wb.presenceIdFor(KING_A), type: "house", at: 1 },
    "57,64": { ownerId: wb.presenceIdFor(USER_B), type: "farm", at: 1 },
    "30,30": { ownerId: wb.presenceIdFor(USER_C), type: "tower", at: 1 },
  };
  // 国民2人 ×5 + 王の家2棟 ×3 + 国民の畑 ×2 = 18（非国民の塔は算入しない）
  assert.equal(wb.prosperityOf(state, buildings, GUILD_1), 18);
  assert.equal(wb.prosperityOf(state, wb.emptyBuildings(), GUILD_1), 10);
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
      .replaceAll('"@/lib/worldbox/buildings-online"', JSON.stringify(buildingsOnlineUrl))
      .replaceAll('"@/lib/worldbox/guilds"', JSON.stringify(guildsUrl)),
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
globalThis.__wbWebSessions = {};
globalThis.__wbGuildsByToken = {};
globalThis.__wbGuildFetchCount = {};

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

test("API(buildings): 個人所有の建築・繁栄度・所有者だけが取り壊し可・解散しても残る", async () => {
  const EPSILON = "900000000000000015";
  const cookieD = guildUser("200000000000000010", "king-d", "d0", [
    discordGuild(EPSILON, "建築鯖", true, "0"),
  ]);
  const cookieE = guildUser("200000000000000011", "user-e", "e1", [
    discordGuild(EPSILON, "建築鯖", false, "0"),
  ]);
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
  const found = await nationsRoute.POST(nationsRequest("POST", cookieD, { action: "found", guildId: EPSILON }));
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
  assert.equal((await nationsRoute.POST(nationsRequest("POST", cookieE, { action: "join", guildId: EPSILON }))).status, 200);
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

test("クライアント: 建国・参加はサーバー単位（国名の自由入力は無い）", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(!client.includes('placeholder="国名"'), "国名の自由入力が残っている");
  assert.ok(!client.includes("nationName"), "国名の入力状態が残っている");
  assert.ok(!client.includes('action: "found", name'), "建国で名前を送っている");
  assert.ok(!client.includes('action: "join", nationId'), "参加が国 ID 指定のまま");
  assert.ok(client.includes("建国できるサーバー"), "建国できるサーバーの一覧が無い");
  assert.ok(client.includes("国があるサーバー"), "国があるサーバーの一覧が無い");
  assert.ok(client.includes('action: "found", guildId'), "建国がサーバー指定でない");
  assert.ok(client.includes('action: "join", guildId'), "参加がサーバー指定でない");
  assert.ok(client.includes("guildsScopeRequired"), "再ログイン導線の分岐が無い");
  assert.ok(client.includes("/api/auth/discord/authorize?next=/games/worldbox"), "再ログインリンクが無い");
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
  // 建物は移動の当たり判定に入る（空間でマップと固体集合を切り替える）
  assert.ok(client.includes("stepMove(activeMap(), player, vel, dt, activeBlocked(), { swim: space === \"world\" })"), "建物が当たり判定に入っていない");
  assert.ok(client.includes("blockedRef.current"), "ワールドの固体集合に建物が入っていない");
  assert.ok(client.includes("blockedRef"), "建物の固体集合が無い");
});
