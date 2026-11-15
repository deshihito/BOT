// AGO WORLD BOX カジノ（ロビー右翼）の検証:
// - 純粋ロジック: スロット（倍率・RTP・抽選）、ルーレット（色・配当・RTP）、
//   ベット検証、機器の隣接判定（ロビーの実配置に対して）
// - ブリッジ: gamble オプの検証と解釈（理由ホワイトリスト・配当必須）
// - API: 位置検証（プレゼンスがロビーの機器の前でなければ遊べない）、
//   実質残高（処理中ベット差し引き）、プレイで gamble オプが積まれること、
//   Web が残高を直接動かさないこと
// - クライアント配線: ステーションチップの「遊ぶ」とパネルの存在
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

const casinoUrl = dataUrl(transpile("worldbox/casino.ts"));
const casino = await import(casinoUrl);
const rngUrl = dataUrl(transpile("worldbox/rng.ts"));
const mapgenUrl = dataUrl(transpile("worldbox/mapgen.ts").replaceAll('"./rng"', JSON.stringify(rngUrl)));
const lobbyUrl = dataUrl(transpile("worldbox/lobby.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)));
const lobby = await import(lobbyUrl);
const economyUrl = dataUrl(transpile("worldbox/economy-bridge.ts"));
const eco = await import(economyUrl);

const ME = "611111111111111111";
const MY_KEY = `discord:${ME}`;

// ---------- 純粋ロジック ----------

test("casino: ベットは整数 10..1,000,000 だけ通る", () => {
  assert.equal(casino.validateCasinoBet(10), 10);
  assert.equal(casino.validateCasinoBet(1_000_000), 1_000_000);
  for (const bad of [0, 9, -10, 1_000_001, 10.5, "100", null, undefined]) {
    assert.equal(casino.validateCasinoBet(bad), null, `bet=${String(bad)}`);
  }
  assert.deepEqual([...casino.CASINO_BET_TIERS], [10, 100, 1000]);
});

test("casino: スロットの倍率（3つ揃い・ペア・はずれ）", () => {
  assert.equal(casino.slotMultiplier([0, 0, 0]), 300);
  assert.equal(casino.slotMultiplier([5, 5, 5]), 3);
  assert.equal(casino.slotMultiplier([1, 1, 2]), casino.SLOT_PAIR_MULTIPLIER);
  assert.equal(casino.slotMultiplier([2, 1, 2]), casino.SLOT_PAIR_MULTIPLIER);
  assert.equal(casino.slotMultiplier([0, 1, 2]), 0);
});

test("casino: スロット抽選は rng で決まり、配当は floor(ベット×倍率)", () => {
  const zero = casino.playSlot(100, () => 0);
  assert.deepEqual(zero.reels, [0, 0, 0]);
  assert.equal(zero.payout, 100 * 300);
  const last = casino.playSlot(10, () => 0.999999);
  assert.deepEqual(last.reels, [5, 5, 5]);
  assert.equal(last.payout, 30);
  const seq = [0.5, 0.5, 0];
  let call = 0;
  const pair = casino.playSlot(10, () => seq[call++ % seq.length]);
  assert.deepEqual(pair.reels, [4, 4, 0]);
  assert.equal(pair.payout, Math.floor(10 * casino.SLOT_PAIR_MULTIPLIER));
});

test("casino: スロットの理論 RTP は 0.85..0.95", () => {
  const rtp = casino.slotRtp();
  assert.ok(rtp > 0.85 && rtp < 0.95, `rtp=${rtp}`);
});

test("casino: ルーレットの色と配当", () => {
  assert.equal(casino.rouletteColor(0), "green");
  assert.equal(casino.rouletteColor(1), "red");
  assert.equal(casino.rouletteColor(2), "black");
  assert.equal(casino.rouletteColor(36), "red");
  const green = casino.playRoulette(100, "red", () => 0);
  assert.equal(green.number, 0);
  assert.equal(green.payout, 0);
  const red = casino.playRoulette(100, "red", () => 1.5 / 37);
  assert.equal(red.number, 1);
  assert.equal(red.payout, 200);
  const miss = casino.playRoulette(100, "black", () => 1.5 / 37);
  assert.equal(miss.payout, 0);
  assert.ok(Math.abs(casino.rouletteRtp() - 36 / 37) < 1e-12);
});

test("casino: 機器の隣接判定はロビーの実配置で決まる", () => {
  const { objects } = lobby.buildLobby();
  // スロットマシン (39,19) の前
  assert.equal(casino.casinoMachineNear(objects, 39, 20), "slot");
  // カジノテーブル (41,23) の前
  assert.equal(casino.casinoMachineNear(objects, 41, 24), "roulette");
  // 広場の中央はどの機器でもない
  assert.equal(casino.casinoMachineNear(objects, 28, 28), null);
  // ショップカウンターの前では遊べない
  assert.equal(casino.casinoMachineNear(objects, 5, 21), null);
});

// ---------- ブリッジ: gamble オプ ----------

test("casino: gamble オプは理由ホワイトリストと配当が必須", () => {
  const op = eco.buildEconomyOp(
    { kind: "gamble", userKey: MY_KEY, discordId: ME, amount: 100, reason: "casino_slot", payout: 0 },
    "12345678-abcd-4abc-8abc-1234567890ab", 1_700_000_000_000,
  );
  assert.equal(op?.kind, "gamble");
  assert.equal(op?.payout, 0);
  // 理由がホワイトリスト外なら不可
  assert.equal(eco.buildEconomyOp(
    { kind: "gamble", userKey: MY_KEY, discordId: ME, amount: 100, reason: "cheat", payout: 0 },
    "12345678-abcd-4abc-8abc-1234567890ab", 1,
  ), null);
  // 配当が欠けたら不可
  assert.equal(eco.buildEconomyOp(
    { kind: "gamble", userKey: MY_KEY, discordId: ME, amount: 100, reason: "casino_slot" },
    "12345678-abcd-4abc-8abc-1234567890ab", 1,
  ), null);
  // 解釈でも配当を保持し、欠けた gamble は落とす
  const raw = {
    id: "12345678-abcd-4abc-8abc-1234567890ab", kind: "gamble", userKey: MY_KEY,
    discordId: ME, amount: 100, reason: "casino_roulette", status: "pending",
    createdAt: 10, payout: 200,
  };
  assert.equal(eco.parseEconomyOp(raw)?.payout, 200);
  const { payout: _p, ...broken } = raw;
  assert.equal(eco.parseEconomyOp(broken), null);
});

// ---------- API ----------

const botApiStubUrl = dataUrl(`
const store = new Map();
const users = new Map();
globalThis.__wbCasinoStore = store;
globalThis.__wbCasinoUsers = users;
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
const nextServerStubUrl = dataUrl(`
export class NextResponse {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
`);
const casinoRoute = await import(
  dataUrl(
    transpile("api/worldbox/casino/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/casino"', JSON.stringify(casinoUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge"', JSON.stringify(economyUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge-online"', JSON.stringify(economyOnlineUrl))
      .replaceAll('"@/lib/worldbox/lobby"', JSON.stringify(lobbyUrl))
      .replaceAll('"@/lib/worldbox/presence-online"', JSON.stringify(presenceOnlineUrl)),
  ),
);

process.env.DISCORD_SESSION_SECRET = ["unit", "test", "only"].join("-");
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
const URL_C = "http://localhost/api/worldbox/casino";
const cookie = sessionCookie(ME, "casino-user");

function setPresence(x, y, space = "lobby", ts = Date.now()) {
  globalThis.__wbCasinoStore.set(`worldbox_presence ${MY_KEY}`, JSON.stringify({
    name: "casino-user", x, y, vx: 0, vy: 0, face: 1, space, ts,
  }));
}
function clearPresence() {
  globalThis.__wbCasinoStore.delete(`worldbox_presence ${MY_KEY}`);
}

test("API(casino): 未ログインは 401、Google セッションは 403", async () => {
  assert.equal((await casinoRoute.GET(apiRequest(URL_C, "GET", null))).status, 401);
  assert.equal((await casinoRoute.POST(apiRequest(URL_C, "POST", null, { game: "slot", bet: 10 }))).status, 401);
  const google = sessionCookie("633333333333333333", "g-user", "google");
  assert.equal((await casinoRoute.GET(apiRequest(URL_C, "GET", google))).status, 403);
});

test("API(casino): 機器の前にいなければ遊べない（位置検証）", async () => {
  globalThis.__wbCasinoUsers.set(ME, 10000);
  clearPresence();
  const noPresence = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { game: "slot", bet: 10 }));
  assert.equal(noPresence.status, 409);
  assert.equal((await noPresence.json()).error, "not_at_casino");
  // ワールドにいてもダメ
  setPresence(39.5, 20.5, "world");
  const inWorld = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { game: "slot", bet: 10 }));
  assert.equal(inWorld.status, 409);
  // ロビーでも広場ではダメ
  setPresence(28.5, 28.5, "lobby");
  const atPlaza = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { game: "slot", bet: 10 }));
  assert.equal(atPlaza.status, 409);
  // 鮮度切れのプレゼンスは「いない」扱い
  setPresence(39.5, 20.5, "lobby", Date.now() - 60_000);
  const stale = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { game: "slot", bet: 10 }));
  assert.equal(stale.status, 409);
  // スロットの前でルーレットは遊べない
  setPresence(39.5, 20.5, "lobby");
  const wrong = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { game: "roulette", bet: 10, pick: "red" }));
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).error, "wrong_machine");
});

test("API(casino): スロットを回すと gamble オプが積まれ、残高は Web では動かない", async () => {
  globalThis.__wbCasinoUsers.set(ME, 10000);
  setPresence(39.5, 20.5, "lobby");
  const res = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { game: "slot", bet: 100 }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.bet, 100);
  assert.ok(Number.isInteger(data.payout) && data.payout >= 0);
  assert.equal(data.result.reels.length, 3);
  const stored = globalThis.__wbCasinoStore.get(`worldbox_economy ${data.opId}`);
  assert.equal(stored.kind, "gamble");
  assert.equal(stored.amount, 100);
  assert.equal(stored.payout, data.payout);
  assert.equal(stored.reason, "casino_slot");
  assert.equal(stored.status, "pending");
  const after = await (await casinoRoute.GET(apiRequest(URL_C, "GET", cookie))).json();
  assert.equal(after.balance, 10000, "Web は残高を直接動かさない");
  assert.equal(after.machine, "slot");
  // 処理中ベットは実質残高から引かれる
  assert.equal(after.effectiveBalance, 10000 - 100);
  assert.equal(after.ops[0].id, data.opId);
});

test("API(casino): ルーレットはテーブルの前で pick 必須", async () => {
  setPresence(41.5, 24.5, "lobby");
  const noPick = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { game: "roulette", bet: 10 }));
  assert.equal(noPick.status, 400);
  assert.equal((await noPick.json()).error, "invalid_pick");
  const res = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { game: "roulette", bet: 10, pick: "black" }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.result.number >= 0 && data.result.number <= 36);
  assert.ok(data.payout === 0 || data.payout === 20);
  const stored = globalThis.__wbCasinoStore.get(`worldbox_economy ${data.opId}`);
  assert.equal(stored.reason, "casino_roulette");
});

test("API(casino): 実質残高を超えるベットは 409、ベット検証は 400", async () => {
  globalThis.__wbCasinoUsers.set(ME, 150);
  setPresence(39.5, 20.5, "lobby");
  // 既存の処理中ベット 100 があるため実質残高は 50
  const tooMuch = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { game: "slot", bet: 100 }));
  assert.equal(tooMuch.status, 409);
  assert.equal((await tooMuch.json()).error, "not_enough_coins");
  for (const bet of [0, 5, 10.5, "100"]) {
    const res = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { game: "slot", bet }));
    assert.equal(res.status, 400, `bet=${String(bet)}`);
    assert.equal((await res.json()).error, "invalid_bet");
  }
  const badGame = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { game: "poker", bet: 10 }));
  assert.equal(badGame.status, 400);
  const cross = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { game: "slot", bet: 10 }, { origin: "http://evil.example" }));
  assert.equal(cross.status, 403);
});

// ---------- クライアント配線 ----------

test("casino: クライアントはステーションチップからパネルを開き、パネルは API を使う", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("WorldBoxCasinoPanel"), "パネルを import している");
  assert.ok(client.includes('stationUi === "casino"'), "カジノの前で導線が出る");
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxCasinoPanel.tsx"), "utf8");
  assert.ok(panel.includes("/api/worldbox/casino"), "カジノ API を使う");
  assert.ok(!panel.includes("残高を直接"), "残高を直接触る実装はない");
});
