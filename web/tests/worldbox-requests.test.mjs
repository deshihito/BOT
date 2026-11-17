// AGO WORLD BOX ギルド依頼の検証:
// - 純粋ロジック（投稿=spend預かり・納品=アイテム移動+earn報酬・取消=earn返金、
//   上限と検証、保存形式の読み書き）
// - ロビーのギルドボード（station "guild" のオブジェクト配置）
// - クライアント配線（ステーションチップ→ギルドボードパネル、役職の移設）
// - API ルート（投稿/納品/取消の3アクションとブリッジの理由ホワイトリスト）
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
    out.push(line.replace(/^export\s+/, ""));
  }
  return out.join("\n");
}

function loadBundle(files, names) {
  const code = files.map((name) => stripModuleSyntax(transpile(name))).join("\n");
  return new Function(`${code}\nreturn { ${names.join(", ")} };`)();
}

const rq = loadBundle(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/vitals.ts", "worldbox/economy.ts", "worldbox/requests.ts"],
  [
    "itemById", "parseProfile", "countItem",
    "emptyRequestsState", "postRequest", "fulfillRequest", "cancelRequest",
    "requestsForGuild", "parseRequestsState", "serializeRequestsState",
    "MAX_OPEN_PER_GUILD", "MAX_OPEN_PER_POSTER",
  ],
);

const POSTER = "discord:111";
const MEMBER = "discord:222";
const GUILD = "guild-1";

function post(state, over = {}, balance = 1000) {
  return rq.postRequest(state, {
    id: "req-00000001",
    guildId: GUILD,
    posterKey: POSTER,
    posterName: "投稿者",
    itemId: "wood",
    count: 3,
    reward: 150,
    now: 1000,
    ...over,
  }, balance);
}

test("投稿: 依頼が載り、報酬は spend（guild_request_escrow）で預かる", () => {
  const result = post(rq.emptyRequestsState());
  assert.equal(result.ok, true);
  assert.deepEqual(result.coin, { kind: "spend", amount: 150, reason: "guild_request_escrow" });
  const list = rq.requestsForGuild(result.state, GUILD);
  assert.equal(list.length, 1);
  assert.equal(list[0].itemId, "wood");
  assert.equal(rq.requestsForGuild(result.state, "other-guild").length, 0);
});

test("投稿の検証: 不正なアイテム・個数・報酬・残高不足を弾く", () => {
  const s = rq.emptyRequestsState();
  assert.equal(post(s, { itemId: "nope" }).error, "unknown_item");
  assert.equal(post(s, { count: 0 }).error, "invalid_count");
  assert.equal(post(s, { count: 100 }).error, "invalid_count");
  assert.equal(post(s, { reward: 0 }).error, "invalid_reward");
  assert.equal(post(s, { reward: 1_000_001 }).error, "invalid_reward");
  assert.equal(post(s, {}, 100).error, "not_enough_coins");
});

test("投稿の上限: 1人5件・ユニオン20件", () => {
  let state = rq.emptyRequestsState();
  for (let i = 0; i < rq.MAX_OPEN_PER_POSTER; i++) {
    const r = post(state, { id: `req-0000000${i}` });
    assert.equal(r.ok, true);
    state = r.state;
  }
  assert.equal(post(state, { id: "req-00000009" }).error, "too_many_poster");
  // 別々の投稿者でユニオン上限まで
  let s2 = rq.emptyRequestsState();
  for (let i = 0; i < rq.MAX_OPEN_PER_GUILD; i++) {
    const r = post(s2, {
      id: `req-x${String(i).padStart(6, "0")}`,
      posterKey: `discord:${1000 + i}`,
    });
    assert.equal(r.ok, true);
    s2 = r.state;
  }
  assert.equal(
    post(s2, { id: "req-x999999", posterKey: "discord:9999" }).error,
    "too_many_guild",
  );
});

test("納品: アイテムが投稿者へ動き、報酬は earn（guild_request_reward）、依頼は消える", () => {
  const posted = post(rq.emptyRequestsState());
  const fulfiller = rq.parseProfile(null);
  fulfiller.items = { wood: 5 };
  const poster = rq.parseProfile(null);
  const result = rq.fulfillRequest(posted.state, "req-00000001", GUILD, MEMBER, fulfiller, poster);
  assert.equal(result.ok, true);
  assert.deepEqual(result.coin, { kind: "earn", amount: 150, reason: "guild_request_reward" });
  assert.equal(rq.countItem(result.fulfillerProfile, "wood"), 2);
  assert.equal(rq.countItem(result.posterProfile, "wood"), 3);
  assert.equal(rq.requestsForGuild(result.state, GUILD).length, 0);
});

test("納品の検証: 自分の依頼・他ユニオン・所持不足・不存在を弾く", () => {
  const posted = post(rq.emptyRequestsState());
  const rich = rq.parseProfile(null);
  rich.items = { wood: 9 };
  const poster = rq.parseProfile(null);
  assert.equal(
    rq.fulfillRequest(posted.state, "req-00000001", GUILD, POSTER, rich, poster).error,
    "self_fulfill",
  );
  assert.equal(
    rq.fulfillRequest(posted.state, "req-00000001", "other", MEMBER, rich, poster).error,
    "wrong_guild",
  );
  const poor = rq.parseProfile(null);
  poor.items = { wood: 1 };
  assert.equal(
    rq.fulfillRequest(posted.state, "req-00000001", GUILD, MEMBER, poor, poster).error,
    "not_enough_items",
  );
  assert.equal(
    rq.fulfillRequest(posted.state, "req-99999999", GUILD, MEMBER, rich, poster).error,
    "not_found",
  );
});

test("取消: 投稿者だけができ、預かり金は earn（guild_request_refund）で戻る", () => {
  const posted = post(rq.emptyRequestsState());
  assert.equal(rq.cancelRequest(posted.state, "req-00000001", MEMBER).error, "not_poster");
  const result = rq.cancelRequest(posted.state, "req-00000001", POSTER);
  assert.equal(result.ok, true);
  assert.deepEqual(result.coin, { kind: "earn", amount: 150, reason: "guild_request_refund" });
  assert.equal(rq.requestsForGuild(result.state, GUILD).length, 0);
  assert.equal(rq.cancelRequest(result.state, "req-00000001", POSTER).error, "not_found");
});

test("保存形式: 直列化→復元で往復し、壊れた要素と旧版は捨てる", () => {
  const posted = post(rq.emptyRequestsState());
  const restored = rq.parseRequestsState(rq.serializeRequestsState(posted.state));
  assert.equal(rq.requestsForGuild(restored, GUILD).length, 1);
  const broken = rq.parseRequestsState(JSON.stringify({
    v: 1,
    requests: {
      a: { id: "req-00000001", guildId: GUILD, posterKey: POSTER, posterName: "x", itemId: "wood", count: 1, reward: 10, createdAt: 1 },
      b: { id: "bad", guildId: GUILD },
      c: { id: "req-00000002", guildId: GUILD, posterKey: POSTER, posterName: "x", itemId: "ghost_item", count: 1, reward: 10, createdAt: 1 },
    },
  }));
  assert.deepEqual(Object.keys(broken.requests), ["req-00000001"]);
  assert.deepEqual(rq.parseRequestsState(JSON.stringify({ v: 99, requests: {} })), { requests: {} });
  assert.deepEqual(rq.parseRequestsState("not json"), { requests: {} });
  assert.deepEqual(rq.parseRequestsState(null), { requests: {} });
});

test("ギルドボードの配線: ロビー配置・チップ・パネル・API・理由ホワイトリスト", () => {
  const lobby = fs.readFileSync(path.join(libDir, "worldbox/lobby.ts"), "utf8");
  assert.match(lobby, /"guild"/);
  assert.match(lobby, /guild_board.*station: "guild"/);
  const textures = fs.readFileSync(path.join(libDir, "worldbox/textures.ts"), "utf8");
  assert.match(textures, /guild_board: "\/img\/worldbox\/lobby\/guild_board\.png"/);
  assert.ok(fs.existsSync(path.join(rootDir, "public/img/worldbox/lobby/guild_board.png")));

  const client = fs.readFileSync(
    path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8",
  );
  assert.match(client, /guild: "ギルドボード"/);
  assert.match(client, /stationUi === "guild"/);
  assert.match(client, /WorldBoxGuildBoardPanel/);
  // 役職の home はギルドボード: ≡ の旧パネルには建国/参加ボタンを残さない
  assert.doesNotMatch(client, /action: "found"|action: "join"|action: "leave"/);

  const panel = fs.readFileSync(
    path.join(rootDir, "app/games/worldbox/WorldBoxGuildBoardPanel.tsx"), "utf8",
  );
  assert.match(panel, /\/api\/worldbox\/requests/);
  assert.match(panel, /依頼/);
  assert.match(panel, /役職/);

  const route = fs.readFileSync(
    path.join(rootDir, "app/api/worldbox/requests/route.ts"), "utf8",
  );
  for (const action of ["post", "fulfill", "cancel"]) {
    assert.match(route, new RegExp(`case "${action}"`));
  }
  // 場所制約: 操作はギルドボード前のみ（場所検証の共通方式）
  assert.match(route, /loadMyLobbyStation/);
  assert.match(route, /not_at_guild_board/);
  const bridge = fs.readFileSync(path.join(libDir, "worldbox/economy-bridge.ts"), "utf8");
  assert.match(bridge, /"guild_request_reward"/);
  assert.match(bridge, /"guild_request_refund"/);
  const botWorker = fs.readFileSync(
    path.join(rootDir, "../core/general/circulation/worldbox_economy.py"), "utf8",
  );
  assert.match(botWorker, /"guild_request_reward"/);
  assert.match(botWorker, /"guild_request_refund"/);
});

// ---------- API（冪等性: 並行リクエストでも預かり・報酬・返金は各1件だけ） ----------

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

const apiBotStubUrl = dataUrl(`
const store = new Map();
const users = new Map();
globalThis.__wbReqStore = store;
globalThis.__wbReqUsers = users;
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
const apiSubdomainUrl = dataUrl(transpile("subdomain.ts"));
const apiHeadersStubUrl = dataUrl("export async function cookies() { throw new Error('tests do not use cookies()'); }");
const apiAuthUrl = dataUrl(
  transpile("auth.ts").replaceAll('"./subdomain"', JSON.stringify(apiSubdomainUrl)).replaceAll('"next/headers"', JSON.stringify(apiHeadersStubUrl)),
);
const apiAuth = await import(apiAuthUrl);
const apiRngUrl = dataUrl(transpile("worldbox/rng.ts"));
const apiMapgenUrl = dataUrl(transpile("worldbox/mapgen.ts").replaceAll('"./rng"', JSON.stringify(apiRngUrl)));
const apiLobbyUrl = dataUrl(transpile("worldbox/lobby.ts").replaceAll('"./mapgen"', JSON.stringify(apiMapgenUrl)));
const apiItemsUrl = dataUrl(transpile("worldbox/items.ts"));
const apiProfileUrl = dataUrl(transpile("worldbox/profile.ts").replaceAll('"./items"', JSON.stringify(apiItemsUrl)));
const apiBridgeUrl = dataUrl(transpile("worldbox/economy-bridge.ts"));
const apiBridgeOnlineUrl = dataUrl(
  transpile("worldbox/economy-bridge-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(apiBotStubUrl))
    .replaceAll('"./economy-bridge"', JSON.stringify(apiBridgeUrl)),
);
const apiPresenceUrl = dataUrl(transpile("worldbox/presence.ts"));
const apiPresenceOnlineUrl = dataUrl(
  transpile("worldbox/presence-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(apiBotStubUrl))
    .replaceAll('"./presence"', JSON.stringify(apiPresenceUrl)),
);
const apiTentUrl = dataUrl(
  transpile("worldbox/tent.ts")
    .replaceAll('"./mapgen"', JSON.stringify(apiMapgenUrl))
    .replaceAll('"./lobby"', JSON.stringify(apiLobbyUrl)),
);
const apiFloorsUrl = dataUrl(
  transpile("worldbox/lobby-floors.ts")
    .replaceAll('"./mapgen"', JSON.stringify(apiMapgenUrl))
    .replaceAll('"./lobby"', JSON.stringify(apiLobbyUrl)),
);
const apiSaveUrl = dataUrl(
  transpile("worldbox/save.ts")
    .replaceAll('"./lobby"', JSON.stringify(apiLobbyUrl))
    .replaceAll('"./tent"', JSON.stringify(apiTentUrl))
    .replaceAll('"./mapgen"', JSON.stringify(apiMapgenUrl)),
);
const apiSaveOnlineUrl = dataUrl(
  transpile("worldbox/save-online.ts").replaceAll('"../bot-api"', JSON.stringify(apiBotStubUrl)),
);
const apiProfileOnlineUrl = dataUrl(
  transpile("worldbox/profile-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(apiBotStubUrl))
    .replaceAll('"./profile"', JSON.stringify(apiProfileUrl)),
);
const tilesStubUrl = dataUrl(`export function placedStationKinds() { return []; }`);
const tilesOnlineStubUrl = dataUrl(`export async function loadTileOverride() { return null; }`);
const apiStationOnlineUrl = dataUrl(
  transpile("worldbox/station-online.ts")
    .replaceAll('"./lobby"', JSON.stringify(apiLobbyUrl))
    .replaceAll('"./lobby-floors"', JSON.stringify(apiFloorsUrl))
    .replaceAll('"./tent"', JSON.stringify(apiTentUrl))
    .replaceAll('"./presence-online"', JSON.stringify(apiPresenceOnlineUrl))
    .replaceAll('"./save"', JSON.stringify(apiSaveUrl))
    .replaceAll('"./save-online"', JSON.stringify(apiSaveOnlineUrl))
    .replaceAll('"./profile-online"', JSON.stringify(apiProfileOnlineUrl))
    .replaceAll('"./tiles"', JSON.stringify(tilesStubUrl))
    .replaceAll('"./tiles-online"', JSON.stringify(tilesOnlineStubUrl)),
);
const apiRequestsUrl = dataUrl(
  transpile("worldbox/requests.ts")
    .replaceAll('"./items"', JSON.stringify(apiItemsUrl))
    .replaceAll('"./profile"', JSON.stringify(apiProfileUrl)),
);
const apiRequestsOnlineUrl = dataUrl(
  transpile("worldbox/requests-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(apiBotStubUrl))
    .replaceAll('"./requests"', JSON.stringify(apiRequestsUrl)),
);
const apiNationsStubUrl = dataUrl(`
let state = { nations: {}, members: {} };
globalThis.__wbReqNations = { set(s) { state = s; } };
export function isNationsEnabled() { return true; }
export async function loadNationsState() { return JSON.parse(JSON.stringify(state)); }
export async function storeNationsState() { return true; }
`);
const apiUserLockUrl = dataUrl(transpile("worldbox/user-lock.ts"));
const apiNextServerStubUrl = dataUrl(`
export class NextResponse {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
`);
const apiRequestsRoute = await import(
  dataUrl(
    transpile("api/worldbox/requests/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(apiNextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(apiAuthUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge"', JSON.stringify(apiBridgeUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge-online"', JSON.stringify(apiBridgeOnlineUrl))
      .replaceAll('"@/lib/worldbox/nations-online"', JSON.stringify(apiNationsStubUrl))
      .replaceAll('"@/lib/worldbox/profile-online"', JSON.stringify(apiProfileOnlineUrl))
      .replaceAll('"@/lib/worldbox/requests"', JSON.stringify(apiRequestsUrl))
      .replaceAll('"@/lib/worldbox/requests-online"', JSON.stringify(apiRequestsOnlineUrl))
      .replaceAll('"@/lib/worldbox/station-online"', JSON.stringify(apiStationOnlineUrl))
      .replaceAll('"@/lib/worldbox/user-lock"', JSON.stringify(apiUserLockUrl)),
  ),
);

process.env.DISCORD_SESSION_SECRET = "wb-requests-test-secret";
const API_GUILD = "123456789012345678";
const API_POSTER = "711111111111111111";
const API_MEMBER1 = "722222222222222222";
const API_MEMBER2 = "733333333333333333";
const apiCookie = (id, name) => `ago_session=${encodeURIComponent(apiAuth.createSession({ id, username: name }))}`;
const API_URL = "http://localhost/api/worldbox/requests";
function apiReq(cookie, body) {
  return new Request(API_URL, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function apiFindOps(pred) {
  const out = [];
  for (const [k, v] of globalThis.__wbReqStore) {
    if (k.startsWith("worldbox_economy ") && v && typeof v === "object" && pred(v)) out.push(v);
  }
  return out;
}
function apiSeedProfile(id, items) {
  globalThis.__wbReqStore.set(`worldbox_profiles discord:${id}`, JSON.stringify({
    coins: 100, hunger: 100, items, stealActorAt: 0, stealTargetAt: 0,
  }));
}
function apiProfileItems(id) {
  const raw = globalThis.__wbReqStore.get(`worldbox_profiles discord:${id}`);
  return JSON.parse(raw).items;
}
function apiReset() {
  const store = globalThis.__wbReqStore;
  store.clear();
  globalThis.__wbReqUsers.clear();
  for (const id of [API_POSTER, API_MEMBER1, API_MEMBER2]) globalThis.__wbReqUsers.set(id, 10000);
  globalThis.__wbReqNations.set({
    nations: {
      [API_GUILD]: {
        guildId: API_GUILD, name: "テスト国", color: "#e5484d",
        kingKey: `discord:${API_POSTER}`, capital: { x: 0, y: 0 }, createdAt: 1,
      },
    },
    members: {
      [`discord:${API_POSTER}`]: { nationId: API_GUILD, role: "king" },
      [`discord:${API_MEMBER1}`]: { nationId: API_GUILD, role: "citizen" },
      [`discord:${API_MEMBER2}`]: { nationId: API_GUILD, role: "citizen" },
    },
  });
  apiSeedProfile(API_POSTER, {});
  apiSeedProfile(API_MEMBER1, { wood: 5 });
  apiSeedProfile(API_MEMBER2, { wood: 5 });
  for (const id of [API_POSTER, API_MEMBER1, API_MEMBER2]) {
    store.set(`worldbox_presence discord:${id}`, JSON.stringify({
      name: "req-user", x: 24.5, y: 16.5, vx: 0, vy: 0, face: 1, space: "lobby", ts: Date.now(),
    }));
  }
}
// Bot ワーカーが escrow オプを処理した状態を再現する（本番では投稿の
// 数秒後に done/failed が付く。納品・取消のゲートはこの状態を見る）。
function apiSetEscrowStatus(id, status) {
  for (const [k, v] of globalThis.__wbReqStore) {
    if (v && typeof v === "object" && v.id === `escrow-${id}`) {
      globalThis.__wbReqStore.set(k, { ...v, status });
      return;
    }
  }
  assert.fail("escrow op not found");
}
async function apiPost(cookie) {
  const res = await apiRequestsRoute.POST(apiReq(cookie, { action: "post", itemId: "wood", count: 2, reward: 100 }));
  assert.equal(res.status, 200);
  return (await res.json()).request.id;
}

test("API(requests): 投稿の預かりは決定的 ID の spend 1件だけ", async () => {
  apiReset();
  const id = await apiPost(apiCookie(API_POSTER, "poster"));
  const escrows = apiFindOps((o) => o.kind === "spend" && o.reason === "guild_request_escrow");
  assert.equal(escrows.length, 1);
  assert.equal(escrows[0].id, `escrow-${id}`);
  assert.equal(escrows[0].amount, 100);
});

test("API(requests): 納品が並行しても報酬 earn は1件だけ（二重納品の回帰防止）", async () => {
  apiReset();
  const id = await apiPost(apiCookie(API_POSTER, "poster"));
  apiSetEscrowStatus(id, "done");
  const results = await Promise.all([
    apiRequestsRoute.POST(apiReq(apiCookie(API_MEMBER1, "m1"), { action: "fulfill", requestId: id })),
    apiRequestsRoute.POST(apiReq(apiCookie(API_MEMBER2, "m2"), { action: "fulfill", requestId: id })),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 1);
  const rewards = apiFindOps((o) => o.kind === "earn" && o.reason === "guild_request_reward");
  assert.equal(rewards.length, 1, "報酬の earn は1件だけ積まれる");
  assert.equal(rewards[0].id, `reward-${id}`);
  assert.equal(apiProfileItems(API_POSTER).wood, 2, "投稿者へ渡るアイテムも1回分だけ");
});

test("API(requests): 納品と取消が競合しても払われるのは報酬か返金のどちらか1件だけ", async () => {
  apiReset();
  const id = await apiPost(apiCookie(API_POSTER, "poster"));
  apiSetEscrowStatus(id, "done");
  const results = await Promise.all([
    apiRequestsRoute.POST(apiReq(apiCookie(API_POSTER, "poster"), { action: "cancel", requestId: id })),
    apiRequestsRoute.POST(apiReq(apiCookie(API_MEMBER1, "m1"), { action: "fulfill", requestId: id })),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  const payouts = apiFindOps(
    (o) => o.id === `reward-${id}` || o.id === `refund-${id}`,
  );
  assert.equal(payouts.length, 1, "報酬と返金が両方払われることはない");
});

test("API(requests): escrow は投稿と同時に確定し、納品・取消が即座に進む", async () => {
  apiReset();
  const id = await apiPost(apiCookie(API_POSTER, "poster"));
  // コイン API 直接化: escrow spend は登録と同時に適用される
  const escrow = apiFindOps((o) => o.id === `escrow-${id}`);
  assert.equal(escrow.length, 1);
  assert.equal(escrow[0].status, "done");
  const f = await apiRequestsRoute.POST(apiReq(apiCookie(API_MEMBER1, "m1"), { action: "fulfill", requestId: id }));
  assert.equal(f.status, 200);
  const reward = apiFindOps((o) => o.id === `reward-${id}`);
  assert.equal(reward.length, 1);
  // 報酬は earn: このスタブ環境は原資 DB が無いので従来キュー（pending）に
  // 落ち、ワーカー適用を待つフォールバックになる
  assert.equal(reward[0].status, "pending");
});

test("API(requests): escrow が failed の依頼は納品不可、取消は返金なしで通る", async () => {
  apiReset();
  const id = await apiPost(apiCookie(API_POSTER, "poster"));
  apiSetEscrowStatus(id, "failed"); // 投稿後に残高を抜いて預かれなかった状態
  const f = await apiRequestsRoute.POST(apiReq(apiCookie(API_MEMBER1, "m1"), { action: "fulfill", requestId: id }));
  assert.equal(f.status, 409);
  assert.equal((await f.json()).error, "escrow_failed");
  const c = await apiRequestsRoute.POST(apiReq(apiCookie(API_POSTER, "poster"), { action: "cancel", requestId: id }));
  assert.equal(c.status, 200);
  // 預かっていないので返金オプは積まれない（無担保の払い戻し防止）
  assert.equal(apiFindOps((o) => o.id === `refund-${id}`).length, 0);
  assert.equal(apiFindOps((o) => o.id === `reward-${id}`).length, 0);
});

/** Bot ワーカーが報酬・返金オプを終端させた状態を再現する（B2・構造問題#4）。 */
function apiArmFlip(pred, status, error = "pay_house_failed") {
  return new Promise((resolve) => {
    let timer;
    const timeout = setTimeout(() => { clearInterval(timer); resolve(false); }, 5000);
    timer = setInterval(() => {
      for (const [k, v] of globalThis.__wbReqStore) {
        if (k.startsWith("worldbox_economy ") && v && typeof v === "object" && v.status === "pending" && pred(v)) {
          globalThis.__wbReqStore.set(k, { ...v, status, error });
          clearInterval(timer);
          clearTimeout(timeout);
          resolve(true);
          return;
        }
      }
    }, 10);
  });
}
async function apiListRequests(cookie) {
  const res = await apiRequestsRoute.GET(new Request(API_URL, { headers: { cookie } }));
  assert.equal(res.status, 200);
  return (await res.json()).requests;
}

test("API(requests): 納品の報酬決済が failed なら納品自体を巻き戻す", async () => {
  apiReset();
  const id = await apiPost(apiCookie(API_POSTER, "poster"));
  apiSetEscrowStatus(id, "done");
  const flipped = apiArmFlip((o) => o.id === `reward-${id}`, "failed", "pay_house_failed");
  const res = await apiRequestsRoute.POST(apiReq(apiCookie(API_MEMBER1, "m1"), { action: "fulfill", requestId: id }));
  assert.equal(await flipped, true, "ワーカーが報酬オプを failed にした");
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.error, "economy_failed");
  assert.equal(data.opError, "pay_house_failed");
  assert.equal(apiProfileItems(API_MEMBER1).wood, 5, "納品者のアイテムは戻っている");
  assert.equal(apiProfileItems(API_POSTER).wood ?? 0, 0, "投稿者へアイテムは渡っていない");
  const listed = await apiListRequests(apiCookie(API_POSTER, "poster"));
  assert.equal(listed.length, 1, "依頼は残っている（納品が巻き戻された）");
  assert.equal(listed[0].id, id);
});

test("API(requests): 取消の返金決済が failed なら取消自体を巻き戻す", async () => {
  apiReset();
  const id = await apiPost(apiCookie(API_POSTER, "poster"));
  apiSetEscrowStatus(id, "done");
  const flipped = apiArmFlip((o) => o.id === `refund-${id}`, "failed", "credit_failed");
  const res = await apiRequestsRoute.POST(apiReq(apiCookie(API_POSTER, "poster"), { action: "cancel", requestId: id }));
  assert.equal(await flipped, true, "ワーカーが返金オプを failed にした");
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.error, "economy_failed");
  assert.equal(data.opError, "credit_failed");
  const listed = await apiListRequests(apiCookie(API_POSTER, "poster"));
  assert.equal(listed.length, 1, "依頼は残っている（取消が巻き戻された）");
  assert.equal(listed[0].id, id);
});
