// WORLD BOX: テレポーター役職 + ユニオンポーター + 転職コストの検証。
// - 純粋ロジック: 役職定義（porter は戦闘技として返さない）、転職コスト
//   （初回無料 / 以降 100,000 / 同一役職は無料）、ポーターの設置検証
//   （距離・通行可否・解釈）と着地点、warp 演出プリセット
// - ブリッジ: spend 理由 "role_change" は TS / Python 両側でホワイトリスト
//   無しに通ること（earn / gamble の集合は両側で一致すること）
// - API: roles ルートの設置分岐（所属必須・距離・通行不能・上書きで1つ）と
//   set_role の課金、warp ルートの利用検証（他ユニオン不可・ロビー不可）
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

const L = await loadBundle(
  [
    "worldbox/fx.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/roles.ts",
    "worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/move.ts", "worldbox/warp.ts",
    "worldbox/economy-bridge.ts",
  ],
  [
    "ADVENTURE_ROLES", "ADVENTURE_ROLE_IDS", "SKILLS", "activeSkillFor", "addMasteryXp",
    "masteryRankOf", "isAdventureRoleId", "roleChangeCost", "applyRoleChange",
    "ROLE_CHANGE_COST", "ROLE_CHANGE_REASON", "skillCooldownLeft",
    "parseProfile", "serializeProfile",
    "SKILL_FX_DURATION_MS", "skillFxProgress", "skillFxStage", "createFxSystem", "spawnSkillFx",
    "tileAt", "worldTileSource", "MAP_SEED", "T_WATER", "T_GRASS",
    "parsePorter", "porterInRange", "porterTileError", "porterDestination", "PORTER_PLACE_RANGE",
    "buildEconomyOp", "EARN_REASONS", "GAMBLE_REASONS",
  ],
);

function profileWith(role, over = {}) {
  const p = L.parseProfile(null);
  p.role = role;
  return { ...p, ...over };
}

/** 決定的マップから指定タイル種の座標を探す（テストの足場）。 */
function findTile(kind, cx = 0, cy = 0, radius = 200) {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (L.tileAt(x, y, L.MAP_SEED) === kind) return { x, y };
    }
  }
  throw new Error("tile not found");
}

// ---------- 役職定義 ----------

test("teleporter: 役職一覧に含まれ、定義はポーター設置", () => {
  assert.ok(L.ADVENTURE_ROLE_IDS.includes("teleporter"));
  assert.equal(L.ADVENTURE_ROLE_IDS.length, 7);
  assert.equal(L.isAdventureRoleId("teleporter"), true);
  const def = L.ADVENTURE_ROLES.teleporter;
  assert.equal(def.name, "テレポーター");
  assert.equal(def.symbol, "ポ");
  assert.equal(def.passiveName, "ポーター設置");
  assert.equal(def.specialtyName, "ポーター設置");
  assert.deepEqual(def.skills, ["porter"]);
});

test("teleporter: porter スキルは warp 演出・30秒クールダウン・ランク1", () => {
  const s = L.SKILLS.porter;
  assert.equal(s.fx, "warp");
  assert.equal(s.cooldownMs, 30_000);
  assert.equal(s.minRank, 1);
  assert.ok(L.SKILL_FX_DURATION_MS.warp > 0);
});

test("teleporter: activeSkillFor は porter を戦闘技として返さない", () => {
  assert.equal(L.activeSkillFor(profileWith("teleporter")), null);
  const r5 = profileWith("teleporter", { mastery: { teleporter: { xp: 300 } } });
  assert.equal(L.activeSkillFor(r5), null);
  // 他役職の発動技は従来どおり
  assert.equal(L.activeSkillFor(profileWith("blade"))?.id, "sweep");
  assert.equal(L.activeSkillFor(profileWith("medic"))?.id, "heal_zone");
});

test("teleporter: 熟練は既存役職と同じ仕組みで保持される", () => {
  let p = profileWith("teleporter");
  p = L.addMasteryXp(p, "teleporter", 30).profile;
  assert.equal(L.masteryRankOf(p, "teleporter"), 2);
  p = { ...p, role: "blade" };
  assert.equal(L.masteryRankOf(p, "teleporter"), 2, "転職しても熟練は残る");
  // クールダウンは skillAt が正
  const now = 1_000_000;
  const cast = { ...profileWith("teleporter"), skillAt: { porter: now } };
  assert.equal(L.skillCooldownLeft(cast, "porter", now + 1000), 29_000);
  assert.equal(L.skillCooldownLeft(cast, "porter", now + 30_000), 0);
});

test("teleporter: warp 演出は段階を持ち、粒が出る", () => {
  const eff = { kind: "warp", x: 3, y: 4, fromX: 3, fromY: 4, startedAt: 1000, seed: 5 };
  assert.equal(L.skillFxStage(eff, 1000), 0);
  assert.equal(L.skillFxStage(eff, 1000 + L.SKILL_FX_DURATION_MS.warp * 0.5), 1);
  assert.ok(L.skillFxProgress(eff, 1000 + L.SKILL_FX_DURATION_MS.warp) >= 1);
  const sys = L.createFxSystem(9);
  L.spawnSkillFx(sys, eff, 1);
  assert.ok(sys.particles.length > 0, "warp の粒が出る");
});

// ---------- プロフィール保存互換 ----------

test("profile: teleporter と rolePicked が往復で保持される", () => {
  const p = profileWith("teleporter", { rolePicked: true });
  const back = L.parseProfile(L.serializeProfile(p));
  assert.equal(back.role, "teleporter");
  assert.equal(back.rolePicked, true);
  const fresh = L.parseProfile(null);
  assert.equal(fresh.role, "free");
  assert.equal(fresh.rolePicked, false);
  const freshBack = L.parseProfile(L.serializeProfile(fresh));
  assert.equal(freshBack.rolePicked, false, "未選択のまま保存しても立たない");
});

test("profile: 旧データ（フラグなし）で役職持ちは「選んだ」扱い", () => {
  const legacy = L.parseProfile(JSON.stringify({ role: "blade", items: {}, hotbar: [], storage: [] }));
  assert.equal(legacy.role, "blade");
  assert.equal(legacy.rolePicked, true);
  const legacyFree = L.parseProfile(JSON.stringify({ role: "free", items: {}, hotbar: [], storage: [] }));
  assert.equal(legacyFree.rolePicked, false);
});

// ---------- 転職コスト ----------

test("転職: 初めての選択は無料で、選んだフラグが立つ", () => {
  const fresh = L.parseProfile(null);
  assert.equal(L.roleChangeCost(fresh, "blade"), 0);
  const { profile, cost } = L.applyRoleChange(fresh, "blade");
  assert.equal(cost, 0);
  assert.equal(profile.role, "blade");
  assert.equal(profile.rolePicked, true);
});

test("転職: 2回目以降は 100,000、同じ役職は無料 no-op", () => {
  assert.equal(L.ROLE_CHANGE_COST, 100_000);
  const blade = profileWith("blade", { rolePicked: true });
  assert.equal(L.roleChangeCost(blade, "miner"), 100_000);
  assert.equal(L.roleChangeCost(blade, "free"), 100_000, "自由人へ戻る変更も課金対象");
  const same = L.applyRoleChange(blade, "blade");
  assert.equal(same.cost, 0);
  assert.equal(same.profile, blade, "同一役職はプロフィールを変えない");
  // 旧データ（rolePicked が false でも役職持ち）は課金対象
  const legacy = { ...L.parseProfile(null), role: "guard", rolePicked: false };
  assert.equal(L.roleChangeCost(legacy, "scout"), 100_000);
  // 一度選んで自由人へ戻った人も、次は初回扱いにならない
  const returned = profileWith("free", { rolePicked: true });
  assert.equal(L.roleChangeCost(returned, "medic"), 100_000);
  // 未選択の自由人が自由人を選ぶのは no-op でフラグも立たない
  const fresh = L.parseProfile(null);
  const noop = L.applyRoleChange(fresh, "free");
  assert.equal(noop.cost, 0);
  assert.equal(noop.profile.rolePicked, false);
});

// ---------- ポーター純粋ロジック ----------

test("porter: 保存値の解釈（壊れた値は null）", () => {
  assert.deepEqual(
    L.parsePorter({ x: 12, y: -34, by: "discord:1", at: 123.9 }),
    { x: 12, y: -34, by: "discord:1", at: 123 },
  );
  assert.deepEqual(
    L.parsePorter(JSON.stringify({ x: 1, y: 2, by: "discord:1", at: 5 })),
    { x: 1, y: 2, by: "discord:1", at: 5 },
  );
  for (const bad of [null, 42, "壊れた", { x: 1.5, y: 2, by: "d", at: 5 }, { x: 1, y: 2, by: "", at: 5 }, { x: 1, y: 2, by: "d", at: 0 }, { x: 2_000_000, y: 2, by: "d", at: 5 }]) {
    assert.equal(L.parsePorter(bad), null, JSON.stringify(bad));
  }
});

test("porter: 設置距離はチェビシェフ 8 タイルまで", () => {
  assert.equal(L.PORTER_PLACE_RANGE, 8);
  assert.equal(L.porterInRange(10, 10, 18, 10), true);
  assert.equal(L.porterInRange(10, 10, 18, 18), true, "斜めも 8 まで");
  assert.equal(L.porterInRange(10, 10, 19, 10), false);
  assert.equal(L.porterInRange(10, 10, 10, 1), false);
  assert.equal(L.porterInRange(-5, -5, -13, -13), true);
});

test("porter: 水・固体・ブロック設置済みのタイルには置けない", () => {
  const water = findTile(L.T_WATER);
  assert.equal(L.porterTileError(L.tileAt(water.x, water.y, L.MAP_SEED), false), "blocked_tile");
  const grass = findTile(L.T_GRASS, 0, 400); // 草は雪原帯より南
  assert.equal(L.porterTileError(L.tileAt(grass.x, grass.y, L.MAP_SEED), false), null);
  assert.equal(L.porterTileError(L.tileAt(grass.x, grass.y, L.MAP_SEED), true), "blocked_tile");
});

test("porter: 着地点はポータータイルの中心", () => {
  const grass = findTile(L.T_GRASS, 0, 400);
  const dest = L.porterDestination(L.worldTileSource(), { x: grass.x, y: grass.y, by: "d", at: 1 });
  assert.deepEqual(dest, { x: grass.x + 0.5, y: grass.y + 0.5 });
});

test("presence: テレポーターは REST / WS 中継の役職許可リストでも落ちない", async () => {
  const P = await loadBundle(["worldbox/presence.ts"], ["sanitizeHeartbeat", "parsePresenceEntry"]);
  const hb = P.sanitizeHeartbeat(
    { name: "p", x: 1, y: 2, vx: 0, vy: 0, face: 1, space: "world", role: "teleporter", rank: 3 },
    { minX: -1_000_000, maxX: 1_000_000, minY: -1_000_000, maxY: 1_000_000 },
  );
  assert.equal(hb.role, "teleporter");
  const entry = P.parsePresenceEntry("id1", JSON.stringify({ ...hb, ts: 1000 }));
  assert.equal(entry.role, "teleporter");
  assert.equal(entry.rank, 3);
  const relay = fs.readFileSync(path.join(rootDir, "realtime", "relay-core.js"), "utf8");
  assert.match(relay, /ROLE_IDS = \[[^\]]*"teleporter"[^\]]*\]/);
});

// ---------- ブリッジ理由の TS / Python 一致 ----------

test("bridge: spend の role_change は作れる（earn では作れない）", () => {
  assert.equal(L.ROLE_CHANGE_REASON, "role_change");
  const op = L.buildEconomyOp(
    { kind: "spend", userKey: "discord:1", discordId: "1".repeat(18), amount: 100_000, reason: L.ROLE_CHANGE_REASON },
    "op-role-change-1",
    1000,
  );
  assert.ok(op);
  assert.equal(op.kind, "spend");
  assert.equal(op.reason, "role_change");
  const earn = L.buildEconomyOp(
    { kind: "earn", userKey: "discord:1", discordId: "1".repeat(18), amount: 100_000, reason: "role_change" },
    "op-role-change-2",
    1000,
  );
  assert.equal(earn, null, "role_change は earn のホワイトリストに無い");
});

test("bridge: earn / gamble の理由集合は Python ワーカーと一致し、spend に理由ホワイトリストは無い", () => {
  const py = fs.readFileSync(
    path.join(rootDir, "..", "core", "general", "circulation", "worldbox_economy.py"),
    "utf8",
  );
  const extractSet = (name) => {
    const m = new RegExp(`${name} = frozenset\\(\\{([^}]*)\\}\\)`).exec(py);
    assert.ok(m, `${name} が Python 側に見つからない`);
    return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  };
  assert.deepEqual(extractSet("EARN_REASONS"), new Set(L.EARN_REASONS));
  assert.deepEqual(extractSet("GAMBLE_REASONS"), new Set(L.GAMBLE_REASONS));
  // spend の適用は理由をホワイトリスト照合しない（両側とも）。だから
  // role_change の spend は Web 側で積めばワーカーがそのまま適用する。
  const spendBody = py.slice(py.indexOf("async def _apply_spend"), py.indexOf("async def _apply_earn"));
  assert.ok(spendBody.length > 0);
  assert.ok(!/REASONS/.test(spendBody), "Python の spend 適用に理由ホワイトリストがある");
  assert.ok(!/SPEND_REASONS/.test(py), "Python に SPEND_REASONS がある");
});

// ---------- API（roles ルート / warp ルート） ----------

const botApiStubUrl = dataUrl(`
const store = new Map();
const users = new Map();
globalThis.__wbTpStore = store;
globalThis.__wbTpUsers = users;
export function isBotApiConfigured() { return true; }
export async function kvGet(ns, key) { const v = store.get(ns + " " + key); return v === undefined ? null : v; }
export async function kvSet(ns, key, value) { store.set(ns + " " + key, value); }
export async function kvDelete(ns, key) { store.delete(ns + " " + key); }
export async function kvList(ns) {
  const m = new Map();
  for (const [k, v] of store) if (k.startsWith(ns + " ")) m.set(k.slice(ns.length + 1), v);
  return m;
}
export async function tableSelect(table, columns, filters, limit) {
  if (table !== "users") throw new Error("unexpected table " + table);
  const id = filters.find((f) => f.column === "user_id")?.value;
  if (!users.has(id)) return [];
  return [{ balance: users.get(id) }];
}
export class BotApiError extends Error { constructor(status, code) { super("api " + status); this.status = status; this.code = code; } }
export async function tableInsert(table, values) {
  if (table === "users") { if (!users.has(values.user_id)) users.set(values.user_id, values.balance); return; }
  if (table === "transaction_history") { (globalThis.__wbHistory ??= []).push(values); return; }
  throw new Error("unexpected table " + table);
}
export async function tableUpdate(table, values, filters) {
  if (table !== "users") throw new Error("unexpected table " + table);
  const id = filters.find((f) => f.column === "user_id")?.value;
  const bal = filters.find((f) => f.column === "balance")?.value;
  if (!users.has(id)) return [];
  if (bal !== undefined && users.get(id) !== bal) return [];
  users.set(id, values.balance);
  return [{ user_id: id, balance: values.balance }];
}
export async function rpc(name, params) {
  if (name !== "transfer_coins") throw new Error("unexpected rpc " + name);
  const senderBalance = users.get(params.p_sender_id) ?? 0;
  if (senderBalance < params.p_amount) throw new BotApiError(400, "P0001");
  users.set(params.p_sender_id, senderBalance - params.p_amount);
  users.set(params.p_receiver_id, (users.has(params.p_receiver_id) ? users.get(params.p_receiver_id) : params.p_new_user_balance) + params.p_amount);
  return users.get(params.p_sender_id);
}
`);
const subdomainUrl = dataUrl(transpile("subdomain.ts"));
const headersStubUrl = dataUrl("export async function cookies() { throw new Error('tests do not use cookies()'); }");
const authUrl = dataUrl(
  transpile("auth.ts").replaceAll('"./subdomain"', JSON.stringify(subdomainUrl)).replaceAll('"next/headers"', JSON.stringify(headersStubUrl)),
);
const auth = await import(authUrl);

function mod(name, reps = {}) {
  let code = transpile(name);
  for (const [from, to] of Object.entries(reps)) code = code.replaceAll(`"${from}"`, JSON.stringify(to));
  return dataUrl(code);
}
const rngUrl = mod("worldbox/rng.ts");
const mapgenUrl = mod("worldbox/mapgen.ts", { "./rng": rngUrl });
const presenceUrl = mod("worldbox/presence.ts");
const itemsUrl = mod("worldbox/items.ts");
const profileUrl = mod("worldbox/profile.ts", { "./items": itemsUrl });
const rolesUrl = mod("worldbox/roles.ts", { "./profile": profileUrl });
const maplogicUrl = mod("worldbox/maplogic.ts", { "./rng": rngUrl, "./mapgen": mapgenUrl });
const mobsUrl = mod("worldbox/mobs.ts", { "./items": itemsUrl, "./mapgen": mapgenUrl, "./maplogic": maplogicUrl });
const combatUrl = mod("worldbox/combat.ts", { "./maplogic": maplogicUrl, "./mobs": mobsUrl });
const arenaUrl = mod("worldbox/arena.ts");
const moveUrl = mod("worldbox/move.ts", { "./mapgen": mapgenUrl });
const nationsUrl = mod("worldbox/nations.ts", { "./mapgen": mapgenUrl, "./move": moveUrl, "./presence": presenceUrl });
const lobbyUrl = mod("worldbox/lobby.ts", { "./mapgen": mapgenUrl });
const tentUrl = mod("worldbox/tent.ts", { "./mapgen": mapgenUrl, "./lobby": lobbyUrl });
const shopsUrl = mod("worldbox/shops.ts", { "./items": itemsUrl });
const floorsUrl = mod("worldbox/lobby-floors.ts", { "./mapgen": mapgenUrl, "./lobby": lobbyUrl, "./shops": shopsUrl });
const saveUrl = mod("worldbox/save.ts", { "./lobby": lobbyUrl, "./tent": tentUrl, "./mapgen": mapgenUrl });
const seasonsUrl = mod("worldbox/seasons.ts");
const tilesUrl = mod("worldbox/tiles.ts", { "./items": itemsUrl, "./mapgen": mapgenUrl, "./profile": profileUrl, "./presence": presenceUrl, "./seasons": seasonsUrl });
const objectsUrl = mod("worldbox/objects.ts", { "./items": itemsUrl, "./mapgen": mapgenUrl, "./maplogic": maplogicUrl, "./rng": rngUrl });
const instancesUrl = mod("worldbox/instances.ts", { "./lobby": lobbyUrl, "./mapgen": mapgenUrl, "./mobs": mobsUrl, "./objects": objectsUrl, "./rng": rngUrl });
const partyUrl = mod("worldbox/party.ts", { "./profile": profileUrl });
const warpUrl = mod("worldbox/warp.ts", { "./mapgen": mapgenUrl, "./move": moveUrl });
const economyUrl = mod("worldbox/economy-bridge.ts");
const profileOnlineUrl = mod("worldbox/profile-online.ts", { "../bot-api": botApiStubUrl, "./profile": profileUrl });
const saveOnlineUrl = mod("worldbox/save-online.ts", { "../bot-api": botApiStubUrl });
const presenceOnlineUrl = mod("worldbox/presence-online.ts", { "../bot-api": botApiStubUrl, "./presence": presenceUrl });
const mobsOnlineUrl = mod("worldbox/mobs-online.ts", { "../bot-api": botApiStubUrl, "./combat": combatUrl });
const nationsOnlineUrl = mod("worldbox/nations-online.ts", { "../bot-api": botApiStubUrl, "./nations": nationsUrl });
const tilesOnlineUrl = mod("worldbox/tiles-online.ts", { "../bot-api": botApiStubUrl, "./tiles": tilesUrl });
const warpOnlineUrl = mod("worldbox/warp-online.ts", { "../bot-api": botApiStubUrl, "./warp": warpUrl });
const economyOnlineUrl = mod("worldbox/economy-bridge-online.ts", { "../bot-api": botApiStubUrl, "./economy-bridge": economyUrl });
const rolesOnlineUrl = mod("worldbox/roles-online.ts", { "../bot-api": botApiStubUrl });
const partyOnlineUrl = mod("worldbox/party-online.ts", { "../bot-api": botApiStubUrl, "./party": partyUrl });
const instancesOnlineUrl = mod("worldbox/instances-online.ts", { "../bot-api": botApiStubUrl, "./instances": instancesUrl, "./profile-online": profileOnlineUrl, "./roles": rolesUrl });
const stationOnlineUrl = mod("worldbox/station-online.ts", {
  "./lobby": lobbyUrl, "./lobby-floors": floorsUrl, "./presence-online": presenceOnlineUrl,
  "./profile-online": profileOnlineUrl, "./save": saveUrl, "./save-online": saveOnlineUrl,
  "./shops": shopsUrl, "./tent": tentUrl, "./tiles": tilesUrl, "./tiles-online": tilesOnlineUrl,
});
const userLockUrl = mod("worldbox/user-lock.ts");
const nextServerStubUrl = dataUrl(`
export class NextResponse {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
`);
function routeMod(name, reps) {
  let code = transpile(name, rootDir + "/app");
  for (const [from, to] of Object.entries(reps)) code = code.replaceAll(`"${from}"`, JSON.stringify(to));
  return dataUrl(code);
}
const rolesRoute = await import(routeMod("api/worldbox/roles/route.ts", {
  "next/server": nextServerStubUrl,
  "@/lib/auth": authUrl,
  "@/lib/worldbox/mapgen": mapgenUrl,
  "@/lib/worldbox/profile-online": profileOnlineUrl,
  "@/lib/worldbox/profile": profileUrl,
  "@/lib/worldbox/arena": arenaUrl,
  "@/lib/worldbox/mobs": mobsUrl,
  "@/lib/worldbox/combat": combatUrl,
  "@/lib/worldbox/mobs-online": mobsOnlineUrl,
  "@/lib/worldbox/presence-online": presenceOnlineUrl,
  "@/lib/worldbox/presence": presenceUrl,
  "@/lib/worldbox/save": saveUrl,
  "@/lib/worldbox/save-online": saveOnlineUrl,
  "@/lib/worldbox/station-online": stationOnlineUrl,
  "@/lib/worldbox/roles": rolesUrl,
  "@/lib/worldbox/instances": instancesUrl,
  "@/lib/worldbox/instances-online": instancesOnlineUrl,
  "@/lib/worldbox/party": partyUrl,
  "@/lib/worldbox/party-online": partyOnlineUrl,
  "@/lib/worldbox/roles-online": rolesOnlineUrl,
  "@/lib/worldbox/nations-online": nationsOnlineUrl,
  "@/lib/worldbox/warp": warpUrl,
  "@/lib/worldbox/warp-online": warpOnlineUrl,
  "@/lib/worldbox/tiles": tilesUrl,
  "@/lib/worldbox/tiles-online": tilesOnlineUrl,
  "@/lib/worldbox/economy-bridge": economyUrl,
  "@/lib/worldbox/economy-bridge-online": economyOnlineUrl,
  "@/lib/worldbox/user-lock": userLockUrl,
}));
const warpRoute = await import(routeMod("api/worldbox/warp/route.ts", {
  "next/server": nextServerStubUrl,
  "@/lib/auth": authUrl,
  "@/lib/worldbox/mapgen": mapgenUrl,
  "@/lib/worldbox/nations-online": nationsOnlineUrl,
  "@/lib/worldbox/warp": warpUrl,
  "@/lib/worldbox/warp-online": warpOnlineUrl,
  "@/lib/worldbox/save": saveUrl,
  "@/lib/worldbox/save-online": saveOnlineUrl,
  "@/lib/worldbox/presence-online": presenceOnlineUrl,
}));
const lobby = await import(lobbyUrl);

process.env.DISCORD_SESSION_SECRET = "teleporter-test-secret";
const ME = "611111111111111111";
const OTHER = "622222222222222222";
const LONE = "633333333333333333";
const MY_KEY = `discord:${ME}`;
const OTHER_KEY = `discord:${OTHER}`;
const LONE_KEY = `discord:${LONE}`;
const G1 = "900000000000000021";
const G2 = "900000000000000022";
const URL_R = "http://localhost/api/worldbox/roles";
const URL_W = "http://localhost/api/worldbox/warp";
const store = globalThis.__wbTpStore;
const users = globalThis.__wbTpUsers;

function sessionCookie(id, username) {
  return `ago_session=${encodeURIComponent(auth.createSession({ id, username }))}`;
}
function apiRequest(url, method, cookie, body) {
  return new Request(url, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const cookieMe = sessionCookie(ME, "porter-user");
const cookieOther = sessionCookie(OTHER, "other-user");
const cookieLone = sessionCookie(LONE, "lone-user");

function seedNations() {
  const nations = {
    [G1]: { guildId: G1, name: "いち鯖", color: "#e5484d", kingKey: MY_KEY, capital: { x: 0, y: 400 }, createdAt: 1 },
    [G2]: { guildId: G2, name: "に鯖", color: "#f76b15", kingKey: OTHER_KEY, capital: { x: 10, y: 400 }, createdAt: 2 },
  };
  store.set("worldbox_nations nations", JSON.stringify({ v: 2, nations }));
  store.set("worldbox_nations members", JSON.stringify({
    [MY_KEY]: { nationId: G1, role: "citizen" },
    [OTHER_KEY]: { nationId: G2, role: "citizen" },
  }));
}
function seedProfile(key, role, over = {}) {
  const p = { ...L.parseProfile(null), role, rolePicked: role !== "free", ...over };
  store.set(`worldbox_profiles ${key}`, L.serializeProfile(p));
  return p;
}
function readProfile(key) {
  return L.parseProfile(store.get(`worldbox_profiles ${key}`));
}
function setPresence(key, x, y, space) {
  store.set(`worldbox_presence ${key}`, JSON.stringify({
    name: "p", x, y, vx: 0, vy: 0, face: 1, space, ts: Date.now(),
  }));
}
function setSave(key, space, x, y) {
  store.set(`worldbox_save ${key}`, JSON.stringify({ version: 6, space, x, y, worldReturn: null }));
}
function readSave(key) {
  const raw = store.get(`worldbox_save ${key}`);
  return raw ? JSON.parse(raw) : null;
}
function findOps(pred) {
  const out = [];
  for (const [k, v] of store) {
    if (k.startsWith("worldbox_economy ") && v && typeof v === "object" && pred(v)) out.push(v);
  }
  return out;
}
function guildStandTile() {
  const { objects } = lobby.buildLobby();
  for (let y = 10; y < 22; y++) {
    for (let x = 18; x < 34; x++) {
      if (lobby.stationNear(objects, x, y) === "guild") return { x, y };
    }
  }
  throw new Error("guild stand tile not found");
}
/** プレイヤー位置と設置先に使える草タイルの組（チェビシェフ 8 以内）。 */
function grassPair() {
  const base = findTile(L.T_GRASS, 0, 400, 60);
  for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -8; dx <= 8; dx++) {
      if (dx === 0 && dy === 0) continue;
      const t = { x: base.x + dx, y: base.y + dy };
      if (L.tileAt(t.x, t.y, L.MAP_SEED) === L.T_GRASS) return { at: base, target: t };
    }
  }
  throw new Error("grass pair not found");
}
function reset() {
  store.clear();
  users.clear();
  seedNations();
}

// ---------- roles: ポーター設置 ----------

test("API(porter): 設置でき、置き直しは上書きで1つだけ", async () => {
  reset();
  const { at, target } = grassPair();
  seedProfile(MY_KEY, "teleporter");
  setPresence(MY_KEY, at.x + 0.5, at.y + 0.5, "world");
  setSave(MY_KEY, "world", at.x + 0.5, at.y + 0.5);
  const res = await rolesRoute.POST(apiRequest(URL_R, "POST", cookieMe, {
    action: "skill", skill: "porter", tx: target.x + 0.5, ty: target.y + 0.5,
    space: "world", px: at.x + 0.5, py: at.y + 0.5,
  }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.fx, "warp");
  assert.deepEqual(data.porter, { x: target.x, y: target.y, by: MY_KEY, at: data.porter.at });
  const stored = JSON.parse(store.get(`worldbox_warp ${G1}`));
  assert.equal(stored.x, target.x);
  assert.equal(stored.y, target.y);
  assert.equal(readProfile(MY_KEY).skillAt.porter > 0, true, "クールダウンが刻まれる");

  // 置き直し（クールダウンを外してから）: 同じキーへの上書きで件数は1つ
  seedProfile(MY_KEY, "teleporter");
  const res2 = await rolesRoute.POST(apiRequest(URL_R, "POST", cookieMe, {
    action: "skill", skill: "porter", tx: at.x + 0.5, ty: at.y + 0.5,
    space: "world", px: at.x + 0.5, py: at.y + 0.5,
  }));
  assert.equal(res2.status, 200);
  const warpKeys = [...store.keys()].filter((k) => k.startsWith("worldbox_warp "));
  assert.deepEqual(warpKeys, [`worldbox_warp ${G1}`], "ユニオンに1つだけ");
  assert.equal(JSON.parse(store.get(`worldbox_warp ${G1}`)).x, at.x);
});

test("API(porter): 所属必須・距離・通行不能・空間・役職で弾く", async () => {
  reset();
  const { at, target } = grassPair();
  const post = (cookie, body) => rolesRoute.POST(apiRequest(URL_R, "POST", cookie, body));
  const base = {
    action: "skill", skill: "porter", tx: target.x + 0.5, ty: target.y + 0.5,
    space: "world", px: at.x + 0.5, py: at.y + 0.5,
  };
  // 無所属は not_in_union
  seedProfile(LONE_KEY, "teleporter");
  setPresence(LONE_KEY, at.x + 0.5, at.y + 0.5, "world");
  let res = await post(cookieLone, base);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "not_in_union");

  seedProfile(MY_KEY, "teleporter");
  setPresence(MY_KEY, at.x + 0.5, at.y + 0.5, "world");
  // 遠すぎる
  res = await post(cookieMe, { ...base, tx: at.x + 40.5, ty: at.y + 0.5 });
  assert.equal((await res.json()).error, "too_far");
  // 水タイル（自分のタイルとして申告しても地形で弾かれる）
  const water = findTile(L.T_WATER, 0, 0, 60);
  setPresence(MY_KEY, water.x + 0.5, water.y + 0.5, "world");
  res = await post(cookieMe, { ...base, tx: water.x + 0.5, ty: water.y + 0.5, px: water.x + 0.5, py: water.y + 0.5 });
  assert.equal((await res.json()).error, "blocked_tile");
  // ブロック設置済みタイル
  setPresence(MY_KEY, at.x + 0.5, at.y + 0.5, "world");
  store.set(`worldbox_tiles ${target.x},${target.y}`, JSON.stringify({
    block: { itemId: "stone_block", ownerId: MY_KEY }, ownerId: MY_KEY,
  }));
  res = await post(cookieMe, base);
  assert.equal((await res.json()).error, "blocked_tile");
  store.delete(`worldbox_tiles ${target.x},${target.y}`);
  // ロビー空間では設置できない
  res = await post(cookieMe, { ...base, space: "lobby" });
  assert.equal((await res.json()).error, "not_in_world");
  // テレポーターでなければ skill_locked
  seedProfile(MY_KEY, "blade");
  res = await post(cookieMe, base);
  assert.equal((await res.json()).error, "skill_locked");
});

// ---------- roles: 転職コスト ----------

test("API(set_role): 初回無料、2回目は残高不足で不変・十分なら spend が積まれる", async () => {
  reset();
  const stand = guildStandTile();
  seedProfile(MY_KEY, "free", { rolePicked: false });
  setPresence(MY_KEY, stand.x + 0.5, stand.y + 0.5, "lobby");
  setSave(MY_KEY, "lobby", stand.x + 0.5, stand.y + 0.5);
  users.set(ME, 0);
  const post = (role) => rolesRoute.POST(apiRequest(URL_R, "POST", cookieMe, { action: "set_role", role }));

  // 初回は残高 0 でも無料
  let res = await post("blade");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).cost, 0);
  assert.equal(readProfile(MY_KEY).role, "blade");
  assert.equal(findOps(() => true).length, 0, "無料ではオプを作らない");

  // 2回目: 残高不足は 409 で役職は変わらない
  users.set(ME, 50_000);
  res = await post("miner");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "not_enough_coins");
  assert.equal(readProfile(MY_KEY).role, "blade");
  assert.equal(findOps(() => true).length, 0);

  // 残高が足りれば spend role_change 100,000 が1件積まれて変わる
  users.set(ME, 150_000);
  res = await post("miner");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).cost, 100_000);
  assert.equal(readProfile(MY_KEY).role, "miner");
  const ops = findOps((o) => o.kind === "spend" && o.reason === "role_change");
  assert.equal(ops.length, 1);
  assert.equal(ops[0].amount, 100_000);
  assert.equal(ops[0].discordId, ME);

  // 同じ役職の再選択は無料 no-op
  res = await post("miner");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).cost, 0);
  assert.equal(findOps(() => true).length, 1, "オプは増えない");

  // ギルドボードの前でなければ変更できない
  setPresence(MY_KEY, 0.5, 0.5, "world");
  res = await post("scout");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "not_at_guild_board");
  assert.equal(readProfile(MY_KEY).role, "miner");
});

// ---------- warp ルート ----------

test("API(warp): GET は自ユニオンのポーターだけを返す", async () => {
  reset();
  store.set(`worldbox_warp ${G1}`, JSON.stringify({ x: 5, y: 405, by: MY_KEY, at: 1000 }));
  const mine = await (await warpRoute.GET(apiRequest(URL_W, "GET", cookieMe))).json();
  assert.deepEqual(mine.porter, { x: 5, y: 405 });
  assert.equal(mine.guildId, G1);
  const other = await (await warpRoute.GET(apiRequest(URL_W, "GET", cookieOther))).json();
  assert.equal(other.porter, null, "他ユニオンのポーターは見えない");
  assert.equal(other.guildId, G2);
  const lone = await (await warpRoute.GET(apiRequest(URL_W, "GET", cookieLone))).json();
  assert.equal(lone.porter, null);
  assert.equal(lone.guildId, null);
  assert.equal((await warpRoute.GET(apiRequest(URL_W, "GET", null))).status, 401);
});

test("API(warp): テレポートはワールドでのみ、所属ユニオンのポーターへ", async () => {
  reset();
  const { target } = grassPair();
  store.set(`worldbox_warp ${G1}`, JSON.stringify({ x: target.x, y: target.y, by: MY_KEY, at: 1000 }));
  const post = (cookie) => warpRoute.POST(apiRequest(URL_W, "POST", cookie, { action: "teleport" }));

  // ワールドにいる所属員はポーターへ移動し、セーブとプレゼンスが追随する
  setSave(MY_KEY, "world", 0.5, 0.5);
  let res = await post(cookieMe);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.x, target.x + 0.5);
  assert.equal(data.y, target.y + 0.5);
  const saved = readSave(MY_KEY);
  assert.equal(saved.space, "world");
  assert.equal(saved.x, target.x + 0.5);
  const presence = JSON.parse(store.get(`worldbox_presence ${MY_KEY}`));
  assert.equal(presence.x, target.x + 0.5);
  assert.equal(presence.space, "world");

  // ロビーからは使えない
  setSave(MY_KEY, "lobby", 20.5, 20.5);
  res = await post(cookieMe);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "not_in_world");

  // 他ユニオン（ポーター未設置）は no_porter、無所属は not_in_union
  setSave(OTHER_KEY, "world", 0.5, 0.5);
  res = await post(cookieOther);
  assert.equal((await res.json()).error, "no_porter");
  res = await post(cookieLone);
  assert.equal((await res.json()).error, "not_in_union");
});
