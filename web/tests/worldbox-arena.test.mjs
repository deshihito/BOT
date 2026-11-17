// AGO WORLD BOX 闘技場＋広場の小施設（噴水・休憩）の検証:
// - 純粋ロジック: 攻撃力（剣 tier）、戦闘ステップ（命中/強攻撃/まもる/決着）
// - ロビー配置: 闘技場・噴水・休憩のステーション隣接判定
// - API: 場所検証、参加費 spend → 適用 done まで対戦不可、勝利で
//   arena_prize の earn、噴水の spend とアイテム付与、休憩のクールダウン
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

const arenaUrl = dataUrl(transpile("worldbox/arena.ts"));
const arena = await import(arenaUrl);
const rngUrl = dataUrl(transpile("worldbox/rng.ts"));
const mapgenUrl = dataUrl(transpile("worldbox/mapgen.ts").replaceAll('"./rng"', JSON.stringify(rngUrl)));
const lobbyUrl = dataUrl(transpile("worldbox/lobby.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)));
const lobby = await import(lobbyUrl);
const economyUrl = dataUrl(transpile("worldbox/economy-bridge.ts"));
const itemsUrl = dataUrl(transpile("worldbox/items.ts"));
const profileUrl = dataUrl(transpile("worldbox/profile.ts").replaceAll('"./items"', JSON.stringify(itemsUrl)));

const ME = "611111111111111111";
const MY_KEY = `discord:${ME}`;

// ---------- 純粋ロジック ----------

test("arena: 攻撃力は所持する最良の剣の tier で決まる", () => {
  assert.equal(arena.playerAttack({}), 8);
  assert.equal(arena.playerAttack({ wooden_sword: 1 }), 12);
  assert.equal(arena.playerAttack({ wooden_sword: 1, iron_sword: 1 }), 20);
  assert.equal(arena.playerAttack({ mithril_sword: 1 }), 24);
  assert.equal(arena.playerAttack({ mithril_axe: 1 }), 8); // 剣以外は数えない
  assert.equal(arena.playerAttack({ iron_sword: 0 }), 8); // 0 個は所持でない
});

test("arena: 階級は参加費より賞金が大きく、倍率は 3 倍未満", () => {
  assert.equal(arena.ARENA_TIERS.length, 3);
  for (const t of arena.ARENA_TIERS) {
    assert.ok(t.prize > t.fee, t.id);
    assert.ok(t.prize / t.fee < 3, t.id);
    assert.ok(t.enemyHp > 0 && t.enemyAttack > 0, t.id);
  }
});

function baseSession(over = {}) {
  return {
    kind: "arena", state: "fighting", tierId: "slime", fee: 50, prize: 120,
    feeOpId: "op", playerHp: 100, enemyHp: 40, guarding: false, turn: 0,
    startedAt: 1, log: [], ...over,
  };
}

test("arena: 攻撃が当たれば敵が減り、敵の反撃を受ける", () => {
  const rng = () => 0; // 命中・最小乱数
  const r = arena.arenaStep(baseSession(), "attack", 20, rng);
  assert.equal(r.outcome, null);
  assert.ok(r.session.enemyHp < 40);
  assert.ok(r.session.playerHp < 100);
  assert.equal(r.session.turn, 1);
});

test("arena: 敵を倒せば win で反撃なし", () => {
  const rng = () => 0;
  const r = arena.arenaStep(baseSession({ enemyHp: 5 }), "attack", 20, rng);
  assert.equal(r.outcome, "win");
  assert.equal(r.session.playerHp, 100);
});

test("arena: まもるは次の敵攻撃を軽減し、1回で消費する", () => {
  const rng = () => 0.5;
  const guarded = arena.arenaStep(baseSession(), "guard", 20, rng);
  const plain = arena.arenaStep(baseSession(), "attack", 20, () => 0.99); // 外れ→反撃のみ比較
  assert.ok(100 - guarded.session.playerHp < 100 - plain.session.playerHp + 20);
  assert.equal(guarded.session.guarding, false);
});

test("arena: HP が尽きれば lose", () => {
  const rng = () => 0.99; // 自分の攻撃は外れ、敵の攻撃は最大寄り
  const r = arena.arenaStep(baseSession({ playerHp: 3 }), "attack", 8, rng);
  assert.equal(r.outcome, "lose");
});

// ---------- ロビー配置 ----------

test("arena: ステーション隣接（闘技場・噴水・休憩）", () => {
  const { objects } = lobby.buildLobby();
  assert.equal(lobby.stationNear(objects, 29, 12), "arena"); // 闘技場の看板前
  assert.equal(lobby.stationNear(objects, 28, 26), "fountain"); // 噴水の南
  assert.equal(lobby.stationNear(objects, 4, 55), "rest"); // 休憩ポッドの本棚前
});

// ---------- API ----------

const botApiStubUrl = dataUrl(`
const store = new Map();
const users = new Map();
globalThis.__wbArenaStore = store;
globalThis.__wbArenaUsers = users;
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
const economyOnlineUrl = dataUrl(
  transpile("worldbox/economy-bridge-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./economy-bridge"', JSON.stringify(economyUrl)),
);
const presenceUrl = dataUrl(transpile("worldbox/presence.ts"));
const presenceOnlineUrl = dataUrl(
  transpile("worldbox/presence-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./presence"', JSON.stringify(presenceUrl)),
);
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
const saveUrl = dataUrl(
  transpile("worldbox/save.ts")
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl))
    .replaceAll('"./tent"', JSON.stringify(tentUrl))
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)),
);
const saveOnlineUrl = dataUrl(
  transpile("worldbox/save-online.ts").replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl)),
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
const arenaOnlineUrl = dataUrl(
  transpile("worldbox/arena-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./arena"', JSON.stringify(arenaUrl)),
);
const userLockUrl = dataUrl(transpile("worldbox/user-lock.ts"));
const nextServerStubUrl = dataUrl(`
export class NextResponse {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
`);
const arenaRoute = await import(
  dataUrl(
    transpile("api/worldbox/arena/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/arena"', JSON.stringify(arenaUrl))
      .replaceAll('"@/lib/worldbox/arena-online"', JSON.stringify(arenaOnlineUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge"', JSON.stringify(economyUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge-online"', JSON.stringify(economyOnlineUrl))
      .replaceAll('"@/lib/worldbox/profile-online"', JSON.stringify(profileOnlineUrl))
      .replaceAll('"@/lib/worldbox/station-online"', JSON.stringify(stationOnlineUrl))
      .replaceAll('"@/lib/worldbox/user-lock"', JSON.stringify(userLockUrl)),
  ),
);
const vitalsUrl = dataUrl(
  transpile("worldbox/vitals.ts")
    .replaceAll('"./items"', JSON.stringify(itemsUrl))
    .replaceAll('"./profile"', JSON.stringify(profileUrl)),
);
const plazaRoute = await import(
  dataUrl(
    transpile("api/worldbox/plaza/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/bot-api"', JSON.stringify(botApiStubUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge"', JSON.stringify(economyUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge-online"', JSON.stringify(economyOnlineUrl))
      .replaceAll('"@/lib/worldbox/profile"', JSON.stringify(profileUrl))
      .replaceAll('"@/lib/worldbox/profile-online"', JSON.stringify(profileOnlineUrl))
      .replaceAll('"@/lib/worldbox/station-online"', JSON.stringify(stationOnlineUrl))
      .replaceAll('"@/lib/worldbox/save"', JSON.stringify(saveUrl))
      .replaceAll('"@/lib/worldbox/save-online"', JSON.stringify(saveOnlineUrl))
      .replaceAll('"@/lib/worldbox/vitals"', JSON.stringify(vitalsUrl))
      .replaceAll('"@/lib/worldbox/user-lock"', JSON.stringify(userLockUrl)),
  ),
);

process.env.DISCORD_SESSION_SECRET = "arena-test-secret";
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
const URL_A = "http://localhost/api/worldbox/arena";
const URL_P = "http://localhost/api/worldbox/plaza";
const cookie = sessionCookie(ME, "arena-user");
const store = globalThis.__wbArenaStore;

function setPresence(x, y) {
  store.set(`worldbox_presence ${MY_KEY}`, JSON.stringify({
    name: "arena-user", x, y, vx: 0, vy: 0, face: 1, space: "lobby", ts: Date.now(),
  }));
}
function findOps(pred) {
  const out = [];
  for (const [k, v] of store) {
    if (k.startsWith("worldbox_economy ") && v && typeof v === "object" && pred(v)) out.push(v);
  }
  return out;
}
function markOpsDone(kind, reason) {
  for (const op of findOps((o) => o.kind === kind && o.reason === reason && o.status === "pending")) {
    op.status = "done";
  }
}
function reset() {
  store.clear();
  globalThis.__wbArenaUsers.set(ME, 100000);
}

test("API(arena): 未ログイン 401、場所が違えば 409", async () => {
  reset();
  assert.equal((await arenaRoute.GET(apiRequest(URL_A, "GET", null))).status, 401);
  setPresence(28, 28); // 広場の真ん中
  const res = await arenaRoute.POST(apiRequest(URL_A, "POST", cookie, { action: "start", tier: "slime" }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "not_at_arena");
});

test("API(arena): 開始で参加費 spend が即時適用され、勝利で賞金 earn", async () => {
  reset();
  setPresence(29, 12);
  const start = await arenaRoute.POST(apiRequest(URL_A, "POST", cookie, { action: "start", tier: "slime" }));
  assert.equal(start.status, 200);
  const fees = findOps((o) => o.kind === "spend" && o.reason === "arena_entry");
  assert.equal(fees.length, 1);
  assert.equal(fees[0].amount, 50);
  // コイン API 直接化: spend は登録と同時に適用され、残高もその場で減る
  assert.equal(fees[0].status, "done");
  assert.equal(globalThis.__wbArenaUsers.get(ME), 100000 - 50);
  // スライム HP40: 攻撃力 8（素手）では数手かかる。決着まで回す
  let outcome = null;
  for (let i = 0; i < 40 && !outcome; i++) {
    const res = await arenaRoute.POST(apiRequest(URL_A, "POST", cookie, { action: "act", move: "attack" }));
    assert.equal(res.status, 200);
    const data = await res.json();
    outcome = data.outcome ?? null;
    if (!outcome) assert.ok(data.session, "対戦中はセッションが返る");
  }
  assert.ok(outcome === "win" || outcome === "lose", `決着する: ${outcome}`);
  if (outcome === "win") {
    const prizes = findOps((o) => o.kind === "earn" && o.reason === "arena_prize");
    assert.equal(prizes.length, 1);
    assert.equal(prizes[0].amount, 120);
  } else {
    assert.equal(findOps((o) => o.reason === "arena_prize").length, 0);
  }
  // セッションは消えている
  const after = await (await arenaRoute.GET(apiRequest(URL_A, "GET", cookie))).json();
  assert.equal(after.session, null);
});

test("API(arena): 残高不足は開始できない、二重開始は 409", async () => {
  reset();
  globalThis.__wbArenaUsers.set(ME, 10);
  setPresence(29, 12);
  const poor = await arenaRoute.POST(apiRequest(URL_A, "POST", cookie, { action: "start", tier: "slime" }));
  assert.equal(poor.status, 409);
  assert.equal((await poor.json()).error, "insufficient_balance");

  globalThis.__wbArenaUsers.set(ME, 100000);
  await arenaRoute.POST(apiRequest(URL_A, "POST", cookie, { action: "start", tier: "slime" }));
  const dup = await arenaRoute.POST(apiRequest(URL_A, "POST", cookie, { action: "start", tier: "slime" }));
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error, "session_active");
});

test("API(plaza): 噴水は場所検証つきで spend 10、休憩はクールダウンつき", async () => {
  reset();
  setPresence(28, 28);
  const wrong = await plazaRoute.POST(apiRequest(URL_P, "POST", cookie, { action: "fountain" }));
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).error, "not_at_fountain");

  setPresence(28, 26);
  const ok = await plazaRoute.POST(apiRequest(URL_P, "POST", cookie, { action: "fountain" }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).stamina, true);
  const spends = findOps((o) => o.kind === "spend" && o.reason === "fountain_offering");
  assert.equal(spends.length, 1);
  assert.equal(spends[0].amount, 10);

  setPresence(4, 55);
  const rest1 = await plazaRoute.POST(apiRequest(URL_P, "POST", cookie, { action: "rest" }));
  assert.equal(rest1.status, 200);
  const rest2 = await plazaRoute.POST(apiRequest(URL_P, "POST", cookie, { action: "rest" }));
  assert.equal(rest2.status, 409);
  assert.equal((await rest2.json()).error, "rest_cooldown");
});

test("API(arena): 開始リクエストが並行しても参加費オプは1件だけ（二重開始の回帰防止）", async () => {
  reset();
  setPresence(29, 12);
  const results = await Promise.all([
    arenaRoute.POST(apiRequest(URL_A, "POST", cookie, { action: "start", tier: "slime" })),
    arenaRoute.POST(apiRequest(URL_A, "POST", cookie, { action: "start", tier: "slime" })),
    arenaRoute.POST(apiRequest(URL_A, "POST", cookie, { action: "start", tier: "slime" })),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 2);
  const fees = findOps((o) => o.kind === "spend" && o.reason === "arena_entry");
  assert.equal(fees.length, 1, "参加費の spend は1件だけ積まれる");
});

test("API(arena): 勝利手の並行リクエストでも賞金オプは決定的 ID で1件だけ（二重賞金の回帰防止）", async () => {
  reset();
  setPresence(29, 12);
  const start = await arenaRoute.POST(apiRequest(URL_A, "POST", cookie, { action: "start", tier: "slime" }));
  assert.equal(start.status, 200);
  markOpsDone("spend", "arena_entry");
  const feeOpId = findOps((o) => o.reason === "arena_entry")[0].id;
  // 敵 HP を 1 にして、次の攻撃ヒットで必ず決着する状態にする
  const key = `worldbox_arena session:${MY_KEY}`;
  const s = JSON.parse(store.get(key));
  s.state = "fighting";
  s.enemyHp = 1;
  store.set(key, JSON.stringify(s));
  // 決着手が並行に重なっても賞金は1回だけ
  await Promise.all([
    arenaRoute.POST(apiRequest(URL_A, "POST", cookie, { action: "act", move: "attack" })),
    arenaRoute.POST(apiRequest(URL_A, "POST", cookie, { action: "act", move: "attack" })),
    arenaRoute.POST(apiRequest(URL_A, "POST", cookie, { action: "act", move: "attack" })),
  ]);
  for (let i = 0; i < 40; i++) {
    const after = await (await arenaRoute.GET(apiRequest(URL_A, "GET", cookie))).json();
    if (!after.session) break;
    await arenaRoute.POST(apiRequest(URL_A, "POST", cookie, { action: "act", move: "attack" }));
  }
  const after = await (await arenaRoute.GET(apiRequest(URL_A, "GET", cookie))).json();
  assert.equal(after.session, null, "決着してセッションは消える");
  const prizes = findOps((o) => o.kind === "earn" && o.reason === "arena_prize");
  assert.equal(prizes.length, 1, "賞金の earn は1件だけ積まれる");
  assert.equal(prizes[0].id, `prize-${feeOpId}`, "賞金オプは参加費オプから決定的に導かれる");
});

test("API(plaza): 噴水の並行リクエストでも spend は1件だけ（残高検証のすり抜け防止）", async () => {
  reset();
  globalThis.__wbArenaUsers.set(ME, 10); // ちょうど1回分だけ残高がある
  setPresence(28, 26);
  const results = await Promise.all([
    plazaRoute.POST(apiRequest(URL_P, "POST", cookie, { action: "fountain" })),
    plazaRoute.POST(apiRequest(URL_P, "POST", cookie, { action: "fountain" })),
    plazaRoute.POST(apiRequest(URL_P, "POST", cookie, { action: "fountain" })),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 2);
  const spends = findOps((o) => o.kind === "spend" && o.reason === "fountain_offering");
  assert.equal(spends.length, 1, "噴水の spend は1件だけ積まれる");
});

test("client: 闘技場パネルとチップ配線がある", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /WorldBoxArenaPanel/);
  assert.match(client, /plazaAction/);
  assert.match(client, /stationUi === "arena"/);
  assert.match(client, /stationUi === "fountain"/);
  assert.match(client, /stationUi === "rest"/);
  assert.ok(fs.existsSync(path.join(rootDir, "app/games/worldbox/WorldBoxArenaPanel.tsx")));
});
