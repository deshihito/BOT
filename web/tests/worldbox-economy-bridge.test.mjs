// AGO WORLD BOX 経済ブリッジ（economy-bridge）の検証:
// - オプの検証（金額・理由・ID・earn ホワイトリスト・送金/steal の相手）
// - オプの解釈（オブジェクト / JSON文字列 / 壊れた値）と自分の直近抽出
// - API: 残高読み取り（users への select のみ）と自分のオプ一覧
// - API: 送金オプの受付（spend / earn はクライアントから積めない）
// - クライアント配線（経済パネルの残高・銀行タブ・処理中表示）
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

const economyUrl = dataUrl(transpile("worldbox/economy-bridge.ts"));
const eco = await import(economyUrl);

const ME = "611111111111111111";
const OTHER = "622222222222222222";
const MY_KEY = `discord:${ME}`;

// ---------- 純粋ロジック: 検証 ----------

test("economy: 金額は整数 1..1,000,000 だけ通る", () => {
  assert.equal(eco.validateEconomyAmount(1), 1);
  assert.equal(eco.validateEconomyAmount(1_000_000), 1_000_000);
  for (const bad of [0, -5, 1_000_001, 1.5, Number.NaN, "100", null, undefined, true]) {
    assert.equal(eco.validateEconomyAmount(bad), null, `amount=${String(bad)}`);
  }
});

test("economy: 理由は空白を落として 1..40 文字だけ通る", () => {
  assert.equal(eco.validateEconomyReason("  harvest "), "harvest");
  assert.equal(eco.validateEconomyReason("あ".repeat(40)), "あ".repeat(40));
  for (const bad of ["", "   ", "x".repeat(41), 42, null]) {
    assert.equal(eco.validateEconomyReason(bad), null);
  }
});

test("economy: Discord ID は数字 5..25 桁だけ通る", () => {
  assert.equal(eco.validateDiscordId(ME), ME);
  for (const bad of ["", "abc", "1234", "1".repeat(26), 123, null]) {
    assert.equal(eco.validateDiscordId(bad), null);
  }
});

test("economy: buildEconomyOp は種類ごとの制約を守る", () => {
  const transfer = eco.buildEconomyOp(
    { kind: "transfer", userKey: MY_KEY, discordId: ME, amount: 500, reason: "transfer", toDiscordId: OTHER },
    "12345678-abcd-4abc-8abc-1234567890ab",
    1_700_000_000_000,
  );
  assert.deepEqual(transfer, {
    id: "12345678-abcd-4abc-8abc-1234567890ab",
    kind: "transfer",
    userKey: MY_KEY,
    discordId: ME,
    amount: 500,
    reason: "transfer",
    status: "pending",
    createdAt: 1_700_000_000_000,
    toDiscordId: OTHER,
  });
  // 自分宛ての送金は不可
  assert.equal(eco.buildEconomyOp(
    { kind: "transfer", userKey: MY_KEY, discordId: ME, amount: 1, reason: "transfer", toDiscordId: ME },
    "12345678-abcd-4abc-8abc-1234567890ab", 1,
  ), null);
  // 受け手が無い送金は不可
  assert.equal(eco.buildEconomyOp(
    { kind: "transfer", userKey: MY_KEY, discordId: ME, amount: 1, reason: "transfer" },
    "12345678-abcd-4abc-8abc-1234567890ab", 1,
  ), null);
  // earn はホワイトリストの理由だけ
  for (const reason of ["harvest", "guild_shop_sale", "arena_prize", "arena_pvp_fee_refund", "shop_sale"]) {
    const op = eco.buildEconomyOp(
      { kind: "earn", userKey: MY_KEY, discordId: ME, amount: 10, reason },
      "12345678-abcd-4abc-8abc-1234567890ab", 1,
    );
    assert.equal(op?.kind, "earn");
  }
  assert.equal(eco.buildEconomyOp(
    { kind: "earn", userKey: MY_KEY, discordId: ME, amount: 10, reason: "cheat" },
    "12345678-abcd-4abc-8abc-1234567890ab", 1,
  ), null);
  // 労働は廃止（2026-11-16）: earn の許可リストから外れたため作れない
  assert.equal(eco.buildEconomyOp(
    { kind: "earn", userKey: MY_KEY, discordId: ME, amount: 10, reason: "work" },
    "12345678-abcd-4abc-8abc-1234567890ab", 1,
  ), null);
  // spend は理由自由（サーバー側の呼び出し専用）
  const spend = eco.buildEconomyOp(
    { kind: "spend", userKey: MY_KEY, discordId: ME, amount: 300, reason: "build_house" },
    "12345678-abcd-4abc-8abc-1234567890ab", 1,
  );
  assert.equal(spend?.kind, "spend");
  // steal は一旦廃止（2026-11-16）: 形が正しくても作れない
  assert.equal(eco.buildEconomyOp(
    { kind: "steal", userKey: MY_KEY, discordId: ME, amount: 20, reason: "steal", fromDiscordId: OTHER },
    "12345678-abcd-4abc-8abc-1234567890ab", 1,
  ), null);
});

test("economy: parseEconomyOp はオブジェクトと JSON 文字列を受け、壊れた値を落とす", () => {
  const raw = {
    id: "12345678-abcd-4abc-8abc-1234567890ab", kind: "earn", userKey: MY_KEY,
    discordId: ME, amount: 250, reason: "harvest", status: "done",
    appliedAmount: 120, appliedAt: 99, createdAt: 10, claim: { token: "x" },
  };
  const parsed = eco.parseEconomyOp(raw);
  assert.equal(parsed?.appliedAmount, 120);
  assert.equal(parsed?.appliedAt, 99);
  assert.equal("claim" in (parsed ?? {}), false, "未知フィールドは捨てる");
  assert.deepEqual(eco.parseEconomyOp(JSON.stringify(raw)), parsed);
  for (const bad of [null, 42, "{壊れた", [], { ...raw, status: "processing" }, { ...raw, amount: 0 }, { ...raw, kind: "gift" }]) {
    assert.equal(eco.parseEconomyOp(bad), null);
  }
  // steal は fromDiscordId を保持し、欠けていれば落とす
  const stealRaw = {
    id: "12345678-abcd-4abc-8abc-1234567890ab", kind: "steal", userKey: MY_KEY,
    discordId: ME, amount: 20, reason: "steal", status: "pending", createdAt: 10,
    fromDiscordId: OTHER,
  };
  assert.equal(eco.parseEconomyOp(stealRaw)?.fromDiscordId, OTHER);
  const { fromDiscordId: _dropped, ...stealBroken } = stealRaw;
  assert.equal(eco.parseEconomyOp(stealBroken), null);
});

test("economy: recentEconomyOps は自分のオプだけを新しい順に最大20件", () => {
  const ops = [];
  for (let i = 0; i < 25; i++) {
    ops.push(eco.buildEconomyOp(
      { kind: "spend", userKey: MY_KEY, discordId: ME, amount: 1, reason: "r" },
      `12345678-abcd-4abc-8abc-${String(i).padStart(12, "0")}`, 1000 + i,
    ));
  }
  ops.push(eco.buildEconomyOp(
    { kind: "spend", userKey: `discord:${OTHER}`, discordId: OTHER, amount: 1, reason: "r" },
    "12345678-abcd-4abc-8abc-999999999999", 5000,
  ));
  const mine = eco.recentEconomyOps(ops, MY_KEY);
  assert.equal(mine.length, 20);
  assert.equal(mine[0].createdAt, 1024);
  assert.ok(mine.every((op) => op.userKey === MY_KEY));
});

// ---------- API ----------

const botApiStubUrl = dataUrl(`
const store = new Map();
const users = new Map();
globalThis.__wbEconomyStore = store;
globalThis.__wbEconomyUsers = users;
export function isBotApiConfigured() { return true; }
export async function kvGet(ns, key) { const v = store.get(ns + " " + key); return v === undefined ? null : v; }
export async function kvSet(ns, key, value) { store.set(ns + " " + key, value); }
export async function kvDelete(ns, key) { store.delete(ns + " " + key); }
export async function kvList(ns) {
  const m = new Map();
  for (const [k, v] of store) if (k.startsWith(ns + " ")) m.set(k.slice(ns.length + 1), v);
  return m;
}
const poolState = { pool: 0, treasury: 0, total_recycled: 0, total_house_paid: 0 };
globalThis.__wbPool = poolState;
export async function tableSelect(table, columns, filters, limit) {
  if (table === "economy_pool_state") {
    if (!globalThis.__wbPoolAvailable) throw new Error("table not applied");
    return [{ pool: poolState.pool, treasury: poolState.treasury }];
  }
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
  if (name === "economy_pool_pay_house") {
    const amount = Math.max(0, params.p_amount);
    const poolPart = Math.min(poolState.pool, amount);
    const treasuryPart = Math.min(poolState.treasury, amount - poolPart);
    poolState.pool -= poolPart;
    poolState.treasury -= treasuryPart;
    poolState.total_house_paid += poolPart + treasuryPart;
    return [{ paid: poolPart + treasuryPart, pool_part: poolPart, treasury_part: treasuryPart }];
  }
  if (name === "economy_pool_refund_house") {
    poolState.pool += params.p_pool_part;
    poolState.treasury += params.p_treasury_part;
    poolState.total_house_paid = Math.max(0, poolState.total_house_paid - params.p_pool_part - params.p_treasury_part);
    return poolState.total_house_paid;
  }
  if (name === "economy_pool_add_loss") {
    const amount = Math.max(0, params.p_amount);
    const poolPart = Math.floor((amount * 7) / 10);
    poolState.pool += poolPart;
    poolState.treasury += amount - poolPart;
    poolState.total_recycled += amount;
    return [{ pool_part: poolPart, treasury_part: amount - poolPart }];
  }
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
const stationStubUrl = dataUrl(`
export async function loadMyLobbyStation() { return globalThis.__wbStationValue ?? "shop"; }
export async function loadMyLobbyShopGenre() { return globalThis.__wbShopGenre ?? "farm"; }
export async function loadMyWorldStationKinds() { return new Set(); }
`);
const economyRoute = await import(
  dataUrl(
    transpile("api/worldbox/economy/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge"', JSON.stringify(economyUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge-online"', JSON.stringify(economyOnlineUrl))
      .replaceAll('"@/lib/worldbox/station-online"', JSON.stringify(stationStubUrl)),
  ),
);

process.env.DISCORD_SESSION_SECRET = ["worldbox", "economy", "test", "secret"].join("-");
function sessionCookie(id, username, provider) {
  const value = auth.createSession(provider ? { id, username, provider } : { id, username });
  return `ago_session=${encodeURIComponent(value)}`;
}
function apiRequest(url, method, cookie, body, headers = {}) {
  return new Request(url, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const URL_E = "http://localhost/api/worldbox/economy";

test("API(economy): 未ログインは 401、Google セッションは 403", async () => {
  assert.equal((await economyRoute.GET(apiRequest(URL_E, "GET", null))).status, 401);
  assert.equal((await economyRoute.POST(apiRequest(URL_E, "POST", null, { action: "transfer", toDiscordId: OTHER, amount: 1 }))).status, 401);
  const google = sessionCookie("633333333333333333", "g-user", "google");
  assert.equal((await economyRoute.GET(apiRequest(URL_E, "GET", google))).status, 403);
});

test("API(economy): GET は残高（users の読み取り）と自分のオプだけを返す", async () => {
  globalThis.__wbEconomyUsers.set(ME, 12345);
  const cookie = sessionCookie(ME, "eco-user");
  // 他人のオプと自分の完了オプを直接キューへ入れておく
  const store = globalThis.__wbEconomyStore;
  store.set(`worldbox_economy op-other-1`, {
    id: "op-other-1", kind: "spend", userKey: `discord:${OTHER}`, discordId: OTHER,
    amount: 1, reason: "r", status: "pending", createdAt: 10,
  });
  store.set(`worldbox_economy op-mine-01`, {
    id: "op-mine-01", kind: "earn", userKey: MY_KEY, discordId: ME,
    amount: 250, reason: "harvest", status: "done", appliedAmount: 250, createdAt: 20, appliedAt: 30,
  });
  const data = await (await economyRoute.GET(apiRequest(URL_E, "GET", cookie))).json();
  assert.equal(data.balance, 12345);
  assert.deepEqual(data.ops.map((op) => op.id), ["op-mine-01"]);
  assert.equal(data.ops[0].appliedAmount, 250);
  // 行が無いユーザーの残高は 0
  const fresh = sessionCookie("699999999999999999", "fresh-user");
  const freshData = await (await economyRoute.GET(apiRequest(URL_E, "GET", fresh))).json();
  assert.equal(freshData.balance, 0);
  assert.deepEqual(freshData.ops, []);
});

test("API(economy): POST transfer は RPC で即時適用され、オプは done で保存される", async () => {
  globalThis.__wbStationValue = "bank"; // 銀行の前にいる
  globalThis.__wbEconomyUsers.set(ME, 12345);
  globalThis.__wbEconomyUsers.set(OTHER, 1000);
  const cookie = sessionCookie(ME, "eco-user");
  const res = await economyRoute.POST(apiRequest(URL_E, "POST", cookie, { action: "transfer", toDiscordId: OTHER, amount: 700 }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.op.kind, "transfer");
  assert.equal(data.op.status, "done");
  assert.equal(data.op.appliedAmount, 700);
  assert.equal(data.op.userKey, MY_KEY);
  assert.equal(data.op.discordId, ME);
  assert.equal(data.op.toDiscordId, OTHER);
  assert.equal(data.op.amount, 700);
  assert.equal(data.balance, 12345 - 700, "同一レスポンスで最終残高が返る");
  const stored = globalThis.__wbEconomyStore.get(`worldbox_economy ${data.op.id}`);
  assert.deepEqual(stored, data.op, "終端したオプ記録がそのまま保存される");
  const after = await (await economyRoute.GET(apiRequest(URL_E, "GET", cookie))).json();
  assert.equal(after.balance, 12345 - 700);
  assert.equal(globalThis.__wbEconomyUsers.get(OTHER), 1700);
  assert.equal(after.ops[0].id, data.op.id);
});

test("API(bridge): waitForOpDone は done への遷移をその場で拾う", async () => {
  const bridge = await import(economyOnlineUrl);
  const op = eco.buildEconomyOp(
    { kind: "spend", userKey: MY_KEY, discordId: ME, amount: 10, reason: "arena_entry" },
    "op-wait-01", Date.now(),
  );
  globalThis.__wbEconomyStore.set(`worldbox_economy ${op.id}`, { ...op });
  setTimeout(() => {
    const cur = globalThis.__wbEconomyStore.get(`worldbox_economy ${op.id}`);
    globalThis.__wbEconomyStore.set(`worldbox_economy ${op.id}`, { ...cur, status: "done", appliedAmount: 10 });
  }, 60);
  const settled = await bridge.waitForOpDone(MY_KEY, op.id, { timeoutMs: 2_000, intervalMs: 20 });
  assert.equal(settled.status, "done");
  assert.equal(settled.appliedAmount, 10);
  // 他人のオプは待っても引けない（userKey で弾く）
  assert.equal(await bridge.waitForOpDone("discord:699999999999999999", op.id, { timeoutMs: 50, intervalMs: 10 }), null);
});

test("API(bridge): waitForOpDone はタイムアウトで pending のまま返し、waitForOpsDone は混在を扱う", async () => {
  const bridge = await import(economyOnlineUrl);
  const op = eco.buildEconomyOp(
    { kind: "spend", userKey: MY_KEY, discordId: ME, amount: 10, reason: "arena_entry" },
    "op-wait-02", Date.now(),
  );
  globalThis.__wbEconomyStore.set(`worldbox_economy ${op.id}`, { ...op });
  const started = Date.now();
  const result = await bridge.waitForOpDone(MY_KEY, op.id, { timeoutMs: 120, intervalMs: 20 });
  assert.equal(result.status, "pending");
  assert.ok(Date.now() - started >= 100, "予算までは待つ");
  const many = await bridge.waitForOpsDone(
    [{ userKey: MY_KEY, opId: op.id }, { userKey: MY_KEY, opId: "op-wait-missing" }],
    { timeoutMs: 50, intervalMs: 10 },
  );
  assert.equal(many[0].status, "pending");
  assert.equal(many[1], null);
});

test("API(economy): spend / earn はクライアントから積めない（400）", async () => {
  const cookie = sessionCookie(ME, "eco-user");
  for (const action of ["spend", "earn", "gift", undefined]) {
    const res = await economyRoute.POST(apiRequest(URL_E, "POST", cookie, { action, amount: 10, reason: "harvest" }));
    assert.equal(res.status, 400, `action=${String(action)}`);
    assert.equal((await res.json()).error, "invalid_action");
  }
});

test("API(economy): 送金の検証（自分宛て・金額・受け手・他オリジン）", async () => {
  const cookie = sessionCookie(ME, "eco-user");
  const self = await economyRoute.POST(apiRequest(URL_E, "POST", cookie, { action: "transfer", toDiscordId: ME, amount: 10 }));
  assert.equal(self.status, 400);
  assert.equal((await self.json()).error, "self_transfer");
  for (const amount of [0, -1, 1.5, 1_000_001, "100"]) {
    const res = await economyRoute.POST(apiRequest(URL_E, "POST", cookie, { action: "transfer", toDiscordId: OTHER, amount }));
    assert.equal(res.status, 400, `amount=${String(amount)}`);
    assert.equal((await res.json()).error, "invalid_amount");
  }
  const badTo = await economyRoute.POST(apiRequest(URL_E, "POST", cookie, { action: "transfer", toDiscordId: "abc", amount: 10 }));
  assert.equal(badTo.status, 400);
  assert.equal((await badTo.json()).error, "invalid_recipient");
  const cross = await economyRoute.POST(apiRequest(URL_E, "POST", cookie, { action: "transfer", toDiscordId: OTHER, amount: 10 }, { origin: "http://evil.example" }));
  assert.equal(cross.status, 403);
});

// ---------- プロフィール API（コインはブリッジのオプになる） ----------

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
function bundleModule(files, names) {
  const code = files.map((name) => stripModuleSyntax(transpile(name))).join("\n");
  return dataUrl(`${code}\nexport { ${names.join(", ")} };`);
}
const profileEcoUrl = bundleModule(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/vitals.ts", "worldbox/economy.ts"],
  ["buyItem", "sellItem", "eatItem", "doWork", "craftItem", "craftFromInputs", "resolveSteal"],
);
const bridgeOnlineStubUrl = dataUrl(`
const state = (globalThis.__wbBridge = { ops: [], balances: new Map(), failEnqueue: false });
export function isEconomyEnabled() { return true; }
export async function enqueueEconomyOp(op) { if (state.failEnqueue) return false; state.ops.push(op); return true; }
export async function enqueueEconomyOpOnce(op) { if (state.failEnqueue) return false; if (state.ops.some((o) => o.id === op.id)) return true; state.ops.push(op); return true; }
export async function loadMyEconomyOps() { return []; }
export async function readUserBalance(id) { return state.balances.has(id) ? state.balances.get(id) : 0; }
export async function findEconomyOp(userKey, opId) { const op = state.ops.find((o) => o.id === opId); return op && op.userKey === userKey ? op : null; }
export async function deleteEconomyOp(opId) { const i = state.ops.findIndex((o) => o.id === opId); if (i >= 0) state.ops.splice(i, 1); return true; }
export async function deleteEconomyOpLedger() { return true; }
export async function submitEconomyOp(op) { if (state.failEnqueue) return { state: "unavailable" }; const ex = state.ops.find((o) => o.id === op.id); if (ex) return { state: ex.status === "pending" ? "pending" : ex.status, op: ex }; state.ops.push(op); return { state: "pending", op }; }
export async function waitForOpDone(userKey, opId) { return findEconomyOp(userKey, opId); }
`);
const profileOnlineStubUrl = dataUrl(`
const store = (globalThis.__wbProfiles = new Map());
const DEFAULT = { coins: 100, hunger: 100, items: {}, stealActorAt: 0, stealTargetAt: 0 };
export function isProfileEnabled() { return true; }
export async function loadProfile(key) { const p = store.get(key); return p ? JSON.parse(JSON.stringify(p)) : { ...DEFAULT, items: {} }; }
export async function storeProfile(key, profile) { store.set(key, JSON.parse(JSON.stringify(profile))); return true; }
`);
const presenceStubUrl = dataUrl(`
const map = (globalThis.__wbPresence = new Map());
export function isPresenceEnabled() { return true; }
export async function findPresenceOwnerKey(id) { return map.has(id) ? map.get(id) : null; }
`);
await import(presenceStubUrl); // ルートはもう presence-online を読まないため、状態だけ先に作る
const profileSwapUrl = bundleModule(["worldbox/items.ts", "worldbox/profile.ts"], ["swapSlots", "moveSlot", "countItem", "removeItem", "ENHANCE_BASE_COST", "ENHANCE_MATERIALS", "ENHANCE_MAX_LEVEL"]);
const rolesUrl = bundleModule(["worldbox/items.ts", "worldbox/profile.ts", "worldbox/roles.ts"], ["addMasteryXp"]);
const shopsRealUrl = bundleModule(["worldbox/items.ts", "worldbox/shops.ts"], ["checkBuyGenre", "checkBuySold", "checkDailyStock", "dailyPriceFor", "shopDayKeyOf"]);
// 日次ローテーションは日付依存なので、このブリッジテストでは中立化する
// （日次そのものの検証は worldbox-shop-daily / worldbox-shops が担う）。
const shopsUrl = dataUrl(`
import * as real from ${JSON.stringify(shopsRealUrl)};
export const checkBuyGenre = real.checkBuyGenre;
export const checkBuySold = real.checkBuySold;
export function checkDailyStock() { return null; }
export function dailyPriceFor(item) { return item.price; }
export function shopDayKeyOf() { return "test-day"; }
`);
const itemsOnlyUrl = bundleModule(["worldbox/items.ts"], ["itemById", "recipeById", "recipeKind"]);
const tentStubUrl = dataUrl(`export const TENT_MAX_TIER = 2; export const TENT_TIERS = [{ w: 13, h: 10, price: 0 }, { w: 17, h: 13, price: 3000 }, { w: 22, h: 17, price: 10000 }];`);

const profileRoute = await import(
  dataUrl(
    transpile("api/worldbox/profile/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge-online"', JSON.stringify(bridgeOnlineStubUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge"', JSON.stringify(economyUrl))
      .replaceAll('"@/lib/worldbox/economy"', JSON.stringify(profileEcoUrl))
      .replaceAll('"@/lib/worldbox/presence-online"', JSON.stringify(presenceStubUrl))
      .replaceAll('"@/lib/worldbox/shops"', JSON.stringify(shopsUrl))
      .replaceAll('"@/lib/worldbox/items"', JSON.stringify(itemsOnlyUrl))
      .replaceAll('"@/lib/worldbox/tent"', JSON.stringify(tentStubUrl))
      .replaceAll('"@/lib/worldbox/station-online"', JSON.stringify(stationStubUrl))
      .replaceAll('"@/lib/worldbox/profile-online"', JSON.stringify(profileOnlineStubUrl))
      .replaceAll('"@/lib/worldbox/profile"', JSON.stringify(profileSwapUrl))
      .replaceAll('"@/lib/worldbox/user-lock"', JSON.stringify(userLockUrl))
      .replaceAll('"@/lib/worldbox/roles"', JSON.stringify(rolesUrl)),
  ),
);
const URL_P = "http://localhost/api/worldbox/profile";
function resetBridgeState() {
  globalThis.__wbBridge.ops.length = 0;
  globalThis.__wbBridge.balances.clear();
  globalThis.__wbBridge.failEnqueue = false;
  globalThis.__wbProfiles.clear();
  globalThis.__wbPresence.clear();
  globalThis.__wbStationValue = "shop"; // 既定はショップの前
}

test("API(profile): buy は spend オプを積み、アイテムだけが増える", async () => {
  resetBridgeState();
  globalThis.__wbBridge.balances.set(ME, 1000);
  const cookie = sessionCookie(ME, "eco-user");
  const res = await profileRoute.POST(apiRequest(URL_P, "POST", cookie, { action: "buy", itemId: "wood", count: 2 }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.profile.items.wood, 2);
  assert.equal(data.profile.coins, 100, "プロフィールの coins は動かない");
  const ops = globalThis.__wbBridge.ops;
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, "spend");
  assert.equal(ops[0].amount, 160);
  assert.equal(ops[0].reason, "shop_buy");
  assert.equal(ops[0].discordId, ME);
  assert.equal(ops[0].status, "pending");
});

test("API(profile): buy は実残高不足で 409、オプもアイテムも増えない", async () => {
  resetBridgeState();
  globalThis.__wbBridge.balances.set(ME, 3);
  const cookie = sessionCookie(ME, "eco-user");
  const res = await profileRoute.POST(apiRequest(URL_P, "POST", cookie, { action: "buy", itemId: "wood" }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "not_enough_coins");
  assert.equal(globalThis.__wbBridge.ops.length, 0);
});

test("API(profile): sell は earn(shop_sale) オプを積む", async () => {
  resetBridgeState();
  const cookie = sessionCookie(ME, "eco-user");
  globalThis.__wbProfiles.set(MY_KEY, { coins: 100, hunger: 100, items: { wood: 1 }, stealActorAt: 0, stealTargetAt: 0 });
  const sold = await profileRoute.POST(apiRequest(URL_P, "POST", cookie, { action: "sell", itemId: "wood" }));
  assert.equal(sold.status, 200);
  assert.equal((await sold.json()).profile.items.wood, undefined);
  const ops = globalThis.__wbBridge.ops;
  assert.deepEqual(ops.map((op) => [op.kind, op.reason, op.amount]), [
    ["earn", "shop_sale", 48],
  ]);
});

test("API(profile): work は廃止され、オプもプロフィールも動かない", async () => {
  resetBridgeState();
  const cookie = sessionCookie(ME, "eco-user");
  globalThis.__wbProfiles.set(MY_KEY, { coins: 100, hunger: 100, items: {}, stealActorAt: 0, stealTargetAt: 0 });
  const res = await profileRoute.POST(apiRequest(URL_P, "POST", cookie, { action: "work" }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "work_disabled");
  assert.equal(globalThis.__wbBridge.ops.length, 0);
  assert.equal(globalThis.__wbProfiles.get(MY_KEY)?.hunger, 100);
});

test("API(profile): eat はオプを積まない", async () => {
  resetBridgeState();
  const cookie = sessionCookie(ME, "eco-user");
  globalThis.__wbProfiles.set(MY_KEY, { coins: 100, hunger: 30, items: { bread: 1 }, stealActorAt: 0, stealTargetAt: 0 });
  const res = await profileRoute.POST(apiRequest(URL_P, "POST", cookie, { action: "eat", itemId: "bread" }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).profile.hunger, 50);
  assert.equal(globalThis.__wbBridge.ops.length, 0);
});

test("API(profile): steal は廃止され、オプもプロフィールも動かない", async () => {
  resetBridgeState();
  globalThis.__wbPresence.set("pres-1", `discord:${OTHER}`);
  globalThis.__wbBridge.balances.set(ME, 100);
  globalThis.__wbBridge.balances.set(OTHER, 400);
  const cookie = sessionCookie(ME, "eco-user");
  const res = await profileRoute.POST(apiRequest(URL_P, "POST", cookie, { action: "steal", targetId: "pres-1" }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "steal_disabled");
  assert.equal(globalThis.__wbBridge.ops.length, 0);
  assert.equal(globalThis.__wbProfiles.get(MY_KEY)?.stealActorAt ?? 0, 0);
  const google = sessionCookie("633333333333333333", "g-user", "google");
  const denied = await profileRoute.POST(apiRequest(URL_P, "POST", google, { action: "buy", itemId: "wood" }));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "discord_required");
});

// ---------- クライアント配線 ----------

test("クライアント: 経済パネルに残高・銀行タブ・処理中表示がある", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("WorldBoxEconomyPanel"), "経済パネルが配線されていない");
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"), "utf8");
  assert.ok(panel.includes("/api/worldbox/economy"), "経済ブリッジ API を使っていない");
  assert.ok(panel.includes("残高"), "残高表示が無い");
  assert.ok(panel.includes("銀行"), "銀行タブが無い");
  assert.ok(panel.includes("処理中"), "pending の表示が無い");
  assert.ok(panel.includes("送金を受け付けました"), "送金受付の表示が無い");
  assert.ok(!panel.includes("profile.coins"), "残高表示にプロフィールの coins を使わない");
});

// ---------- 直接適用（submitEconomyOp） ----------

test("API(bridge): submitEconomyOp は spend を CAS で即時適用し、台帳・履歴・計測を残す", async () => {
  const bridge = await import(economyOnlineUrl);
  const user = "644444444444444444";
  const key = `discord:${user}`;
  globalThis.__wbEconomyUsers.set(user, 5000);
  const op = eco.buildEconomyOp(
    { kind: "spend", userKey: key, discordId: user, amount: 800, reason: "shop_buy" },
    "op-direct-spend-1", Date.now(),
  );
  const historyBefore = (globalThis.__wbHistory ?? []).length;
  const result = await bridge.submitEconomyOp(op);
  assert.equal(result.state, "done");
  assert.equal(result.op.status, "done");
  assert.equal(result.op.appliedAmount, 800);
  assert.equal(globalThis.__wbEconomyUsers.get(user), 4200);
  const stored = globalThis.__wbEconomyStore.get(`worldbox_economy ${op.id}`);
  assert.equal(stored.status, "done");
  assert.equal(stored.appliedAmount, 800);
  const ledger = globalThis.__wbEconomyStore.get(`worldbox_economy_applied ${op.id}`);
  assert.equal(ledger.status, "applied");
  assert.equal(ledger.appliedAmount, 800);
  const history = (globalThis.__wbHistory ?? []).slice(historyBefore);
  assert.deepEqual(history, [{ sender_id: user, receiver_id: "WORLD_BOX", amount: 800, reason: "shop_buy" }]);
  const date = new Date().toISOString().slice(0, 10);
  const metric = globalThis.__wbEconomyStore.get(`worldbox_metrics_econ ${date}`);
  assert.equal(metric.spend.shop_buy, 800);
});

test("API(bridge): submitEconomyOp は残高不足の spend を failed で終端し、残高を動かさない", async () => {
  const bridge = await import(economyOnlineUrl);
  const user = "655555555555555555";
  const key = `discord:${user}`;
  globalThis.__wbEconomyUsers.set(user, 100);
  const op = eco.buildEconomyOp(
    { kind: "spend", userKey: key, discordId: user, amount: 800, reason: "shop_buy" },
    "op-direct-spend-2", Date.now(),
  );
  const result = await bridge.submitEconomyOp(op);
  assert.equal(result.state, "failed");
  assert.equal(result.op.error, "insufficient_funds");
  assert.equal(globalThis.__wbEconomyUsers.get(user), 100);
  const ledger = globalThis.__wbEconomyStore.get(`worldbox_economy_applied ${op.id}`);
  assert.equal(ledger.status, "failed");
  assert.equal(ledger.error, "insufficient_funds");
});

test("API(bridge): submitEconomyOp は同一オプの再提出で二重に引かない", async () => {
  const bridge = await import(economyOnlineUrl);
  const user = "666666666666666666";
  const key = `discord:${user}`;
  globalThis.__wbEconomyUsers.set(user, 3000);
  const op = eco.buildEconomyOp(
    { kind: "spend", userKey: key, discordId: user, amount: 500, reason: "tent_expand" },
    "op-direct-spend-3", Date.now(),
  );
  const first = await bridge.submitEconomyOp(op);
  assert.equal(first.state, "done");
  const second = await bridge.submitEconomyOp(op);
  assert.equal(second.state, "done");
  assert.equal(globalThis.__wbEconomyUsers.get(user), 2500, "2回目の提出では引かれない");
});

test("API(bridge): submitEconomyOp は台帳が applying のオプに触らず pending を返す", async () => {
  const bridge = await import(economyOnlineUrl);
  const user = "677777777777777777";
  const key = `discord:${user}`;
  globalThis.__wbEconomyUsers.set(user, 3000);
  const op = eco.buildEconomyOp(
    { kind: "spend", userKey: key, discordId: user, amount: 500, reason: "shop_buy" },
    "op-direct-spend-4", Date.now(),
  );
  globalThis.__wbEconomyStore.set(`worldbox_economy_applied ${op.id}`, { status: "applying", at: Date.now() });
  const result = await bridge.submitEconomyOp(op);
  assert.equal(result.state, "pending");
  assert.equal(globalThis.__wbEconomyUsers.get(user), 3000, "成否曖昧なオプは再適用しない");
});

test("API(bridge): submitEconomyOp は原資 DB が無い環境では earn を従来キューへ積む", async () => {
  const bridge = await import(economyOnlineUrl);
  const user = "688888888888888888";
  const key = `discord:${user}`;
  globalThis.__wbPoolAvailable = false; // economy_pool_state 未適用の環境
  bridge.resetEconomyPoolProbe();
  globalThis.__wbEconomyUsers.set(user, 3000);
  const op = eco.buildEconomyOp(
    { kind: "earn", userKey: key, discordId: user, amount: 500, reason: "harvest" },
    "op-direct-earn-1", Date.now(),
  );
  const result = await bridge.submitEconomyOp(op);
  assert.equal(result.state, "pending");
  const stored = globalThis.__wbEconomyStore.get(`worldbox_economy ${op.id}`);
  assert.equal(stored.status, "pending");
  assert.equal(stored.claim, undefined, "キュー経路のオプに claim は付かない");
  assert.equal(globalThis.__wbEconomyUsers.get(user), 3000);
  assert.equal(globalThis.__wbEconomyStore.get(`worldbox_economy_applied ${op.id}`), undefined);
});

test("API(bridge): submitEconomyOp は transfer の残高不足を failed(insufficient_funds) にする", async () => {
  const bridge = await import(economyOnlineUrl);
  const user = "699999999999999991";
  const key = `discord:${user}`;
  globalThis.__wbEconomyUsers.set(user, 50);
  const op = eco.buildEconomyOp(
    { kind: "transfer", userKey: key, discordId: user, amount: 700, reason: "transfer", toDiscordId: OTHER },
    "op-direct-transfer-1", Date.now(),
  );
  const result = await bridge.submitEconomyOp(op);
  assert.equal(result.state, "failed");
  assert.equal(result.op.error, "insufficient_funds");
  assert.equal(globalThis.__wbEconomyUsers.get(user), 50);
});

// ---------- 直接適用（earn / gamble、第2段） ----------

async function setupPool(pool, treasury) {
  globalThis.__wbPoolAvailable = true;
  globalThis.__wbPool.pool = pool;
  globalThis.__wbPool.treasury = treasury;
  globalThis.__wbPool.total_recycled = 0;
  globalThis.__wbPool.total_house_paid = 0;
  const bridge = await import(economyOnlineUrl);
  bridge.resetEconomyPoolProbe();
}

test("API(bridge): submitEconomyOp は earn を pay_house 経由で即時適用する（売る）", async () => {
  const bridge = await import(economyOnlineUrl);
  const user = "610101010101010101";
  const key = `discord:${user}`;
  await setupPool(1000, 500);
  globalThis.__wbEconomyUsers.set(user, 100);
  const op = eco.buildEconomyOp(
    { kind: "earn", userKey: key, discordId: user, amount: 800, reason: "shop_sale" },
    "op-direct-earn-2", Date.now(),
  );
  const historyBefore = (globalThis.__wbHistory ?? []).length;
  const result = await bridge.submitEconomyOp(op);
  assert.equal(result.state, "done");
  assert.equal(result.op.appliedAmount, 800);
  assert.equal(globalThis.__wbEconomyUsers.get(user), 900);
  assert.equal(globalThis.__wbPool.pool, 200, "原資はプールから先に引かれる");
  assert.equal(globalThis.__wbPool.treasury, 500);
  const history = (globalThis.__wbHistory ?? []).slice(historyBefore);
  assert.deepEqual(history, [{ sender_id: "WORLD_BOX", receiver_id: user, amount: 800, reason: "shop_sale" }]);
  // 再提出しても二重に入金されない
  const again = await bridge.submitEconomyOp(op);
  assert.equal(again.state, "done");
  assert.equal(globalThis.__wbEconomyUsers.get(user), 900);
});

test("API(bridge): submitEconomyOp の earn は原資の残りだけを払う（部分払い）", async () => {
  const bridge = await import(economyOnlineUrl);
  const user = "610202020202020202";
  const key = `discord:${user}`;
  await setupPool(100, 0);
  globalThis.__wbEconomyUsers.set(user, 0);
  const op = eco.buildEconomyOp(
    { kind: "earn", userKey: key, discordId: user, amount: 800, reason: "harvest" },
    "op-direct-earn-3", Date.now(),
  );
  const result = await bridge.submitEconomyOp(op);
  assert.equal(result.state, "done");
  assert.equal(result.op.appliedAmount, 100, "払えた分だけが appliedAmount");
  assert.equal(globalThis.__wbEconomyUsers.get(user), 100);
  // 原資が空なら done で 0（発行しない）
  const op2 = eco.buildEconomyOp(
    { kind: "earn", userKey: key, discordId: user, amount: 800, reason: "harvest" },
    "op-direct-earn-4", Date.now(),
  );
  const result2 = await bridge.submitEconomyOp(op2);
  assert.equal(result2.state, "done");
  assert.equal(result2.op.appliedAmount, 0);
  assert.equal(globalThis.__wbEconomyUsers.get(user), 100);
});

test("API(bridge): submitEconomyOp は gamble の勝ちをベット・原資・配当の規則どおり適用する", async () => {
  const bridge = await import(economyOnlineUrl);
  const user = "610303030303030303";
  const key = `discord:${user}`;
  await setupPool(1000, 0);
  globalThis.__wbEconomyUsers.set(user, 1000);
  const op = eco.buildEconomyOp(
    { kind: "gamble", userKey: key, discordId: user, amount: 100, reason: "casino_dice", payout: 300 },
    "op-direct-gamble-1", Date.now(),
  );
  const result = await bridge.submitEconomyOp(op);
  assert.equal(result.state, "done");
  assert.equal(result.op.appliedAmount, 300);
  assert.equal(globalThis.__wbEconomyUsers.get(user), 1200, "1000 - ベット100 + 配当300");
  assert.equal(globalThis.__wbPool.pool, 800, "利益分200だけが原資から出る");
});

test("API(bridge): submitEconomyOp は gamble の負けを還流し、残高不足は原資を戻して failed にする", async () => {
  const bridge = await import(economyOnlineUrl);
  const user = "610404040404040404";
  const key = `discord:${user}`;
  await setupPool(1000, 0);
  globalThis.__wbEconomyUsers.set(user, 1000);
  const lose = eco.buildEconomyOp(
    { kind: "gamble", userKey: key, discordId: user, amount: 100, reason: "casino_dice", payout: 0 },
    "op-direct-gamble-2", Date.now(),
  );
  const loseResult = await bridge.submitEconomyOp(lose);
  assert.equal(loseResult.state, "done");
  assert.equal(loseResult.op.appliedAmount, 0);
  assert.equal(globalThis.__wbEconomyUsers.get(user), 900);
  assert.equal(globalThis.__wbPool.pool, 1070, "負け分は 70% がプールへ還流");
  assert.equal(globalThis.__wbPool.treasury, 30);
  // 残高不足: 先に確保した原資は refund_house で戻り、残高も原資も動かない
  const poor = "610505050505050505";
  const poorKey = `discord:${poor}`;
  globalThis.__wbEconomyUsers.set(poor, 50);
  const poolBefore = globalThis.__wbPool.pool;
  const op = eco.buildEconomyOp(
    { kind: "gamble", userKey: poorKey, discordId: poor, amount: 100, reason: "casino_dice", payout: 300 },
    "op-direct-gamble-3", Date.now(),
  );
  const result = await bridge.submitEconomyOp(op);
  assert.equal(result.state, "failed");
  assert.equal(result.op.error, "insufficient_funds");
  assert.equal(globalThis.__wbEconomyUsers.get(poor), 50);
  assert.equal(globalThis.__wbPool.pool, poolBefore, "確保した原資は戻っている");
});

test("API(bridge): submitEconomyOp は prepaid gamble の部分返しを還流して精算する", async () => {
  const bridge = await import(economyOnlineUrl);
  const user = "610606060606060606";
  const key = `discord:${user}`;
  await setupPool(1000, 0);
  globalThis.__wbEconomyUsers.set(user, 500);
  const op = eco.buildEconomyOp(
    { kind: "gamble", userKey: key, discordId: user, amount: 100, reason: "casino_slot7", payout: 40, prepaid: true },
    "op-direct-gamble-4", Date.now(),
  );
  const result = await bridge.submitEconomyOp(op);
  assert.equal(result.state, "done");
  assert.equal(result.op.appliedAmount, 40);
  assert.equal(globalThis.__wbEconomyUsers.get(user), 540, "ベットは引かれず返し分だけ入る");
  assert.equal(globalThis.__wbPool.pool, 1042, "戻らなかった60の70%が還流");
  assert.equal(globalThis.__wbPool.treasury, 18);
});
