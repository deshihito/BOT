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
const casinoGamesUrl = dataUrl(transpile("worldbox/casino-games.ts"));
const games = await import(casinoGamesUrl);
const blackjackUrl = dataUrl(transpile("games/blackjack.ts"));
const casinoSessionUrl = dataUrl(
  transpile("worldbox/casino-session.ts")
    .replaceAll('"../games/blackjack"', JSON.stringify(blackjackUrl))
    .replaceAll('"./casino-games"', JSON.stringify(casinoGamesUrl)),
);
const sessionLib = await import(casinoSessionUrl);
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
  assert.equal(casino.casinoMachineNear(objects, 46, 20), "slot7");
  assert.equal(casino.casinoMachineNear(objects, 44, 23), "dice");
  assert.equal(casino.casinoMachineNear(objects, 48, 23), "blackjack");
  assert.equal(casino.casinoMachineNear(objects, 40, 28), "double");
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
const casinoSessionOnlineUrl = dataUrl(
  transpile("worldbox/casino-session-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./casino-session"', JSON.stringify(casinoSessionUrl))
    .replaceAll('"./casino-games"', JSON.stringify(casinoGamesUrl)),
);
const casinoTournamentOnlineUrl = dataUrl(`
globalThis.__wbCasinoTournamentScores ??= [];
export async function reconcileCasinoTournamentScores(userKey, discordId, ops) {
  for (const op of ops) {
    if (op.kind === "gamble" && op.status === "done") {
      globalThis.__wbCasinoTournamentScores.push({ discordId, bet: op.amount, payout: op.payout ?? 0 });
    }
  }
}
`);
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
      .replaceAll('"@/lib/games/blackjack"', JSON.stringify(blackjackUrl))
      .replaceAll('"@/lib/worldbox/casino-games"', JSON.stringify(casinoGamesUrl))
      .replaceAll('"@/lib/worldbox/casino-session"', JSON.stringify(casinoSessionUrl))
      .replaceAll('"@/lib/worldbox/casino-session-online"', JSON.stringify(casinoSessionOnlineUrl))
      .replaceAll('"@/lib/worldbox/casino-tournament-online"', JSON.stringify(casinoTournamentOnlineUrl))
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

test("API(casino): 大会スコアは gamble オプの確定後にだけ記録される", async () => {
  globalThis.__wbCasinoUsers.set(ME, 10000);
  globalThis.__wbCasinoTournamentScores.length = 0;
  setPresence(39.5, 20.5, "lobby");
  const res = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { game: "slot", bet: 100 }));
  assert.equal(res.status, 200);
  const data = await res.json();
  // 登録直後（pending）ではスコアは記録されない。後から failed に
  // なりうるオプの純益を順位に入れないため。
  assert.equal(globalThis.__wbCasinoTournamentScores.length, 0);
  // ワーカーが適用して done になった後の照合で初めて記録される
  const stored = globalThis.__wbCasinoStore.get(`worldbox_economy ${data.opId}`);
  stored.status = "done";
  await casinoRoute.GET(apiRequest(URL_C, "GET", cookie));
  assert.equal(globalThis.__wbCasinoTournamentScores.length, 1);
  assert.deepEqual(globalThis.__wbCasinoTournamentScores[0], {
    discordId: ME, bet: 100, payout: data.payout,
  });
});

test("API(casino): ルーレットはテーブルの前で pick 必須", async () => {
  setPresence(40.5, 23.5, "lobby");
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

// ---------- 移行ゲームの純粋ロジック（Bot ギャンブル原典） ----------

test("casino-games: セブンスロットの配当（7つ揃い・天井・6ペナルティ）", () => {
  // rng=0 は常に数字0 → 7つ揃いで基本倍率 2000
  const st1 = games.emptyCasinoUserState();
  const all0 = games.spinSlot7(st1, 10, () => 0);
  assert.deepEqual(all0.reels, [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(all0.reward, 10 * 2000);
  // 連敗3の次は天井（ベット×50）
  const st2 = games.emptyCasinoUserState();
  st2.loseStreak = 3;
  const pity = games.spinSlot7(st2, 10, () => 0.13);
  assert.equal(pity.reward, 10 * 50);
  assert.ok(pity.events.includes("pity"));
  assert.equal(st2.loseStreak, 0);
  // 7が7つ揃うと ×2000×5 と確変7
  const st3 = games.emptyCasinoUserState();
  const sevens = games.spinSlot7(st3, 10, () => 0.78);
  assert.deepEqual(sevens.reels, [7, 7, 7, 7, 7, 7, 7]);
  assert.equal(sevens.reward, 10 * 2000 * 5);
  assert.equal(st3.kakuhen, games.SLOT7_KAKUHEN_SPINS);
  // 6が2つだけ揃うとペナルティ（ベット×9 の追加引き落とし）。
  // 先頭の 0.99 は six カウンタ判定が消費する分。
  const st4 = games.emptyCasinoUserState();
  const seq = [0.99, 0.6, 0.6, 0, 0.1, 0.2, 0.3, 0.45];
  let i = 0;
  const pen = games.spinSlot7(st4, 10, () => seq[i++ % seq.length]);
  assert.deepEqual(pen.reels, [6, 6, 0, 1, 2, 3, 4]);
  assert.equal(pen.reward, 0);
  assert.equal(pen.penalty, 10 * 9);
  assert.ok(pen.events.includes("six_penalty"));
});

test("casino-games: ダブルアップの倍率・内部モード・キャッシュアウト", () => {
  const st = games.emptyCasinoUserState();
  const s = { bet: 100, multiplier: 1, streak: 0 };
  const win = games.doubleGo(s, st, () => 0.5);
  assert.equal(win.win, true);
  assert.equal(s.multiplier, games.DOUBLE_MULTIPLIER_STEP);
  assert.equal(win.currentValue, 160);
  const lose = games.doubleGo(s, st, () => 0.9);
  assert.equal(lose.win, false);
  assert.equal(lose.finished, true);
  // キャッシュアウトが 500 超で HELL 落ち（原典どおり）
  const st2 = games.emptyCasinoUserState();
  const payout = games.doubleCashout({ bet: 1000, multiplier: 1, streak: 0 }, st2);
  assert.equal(payout, 1000);
  assert.equal(st2.internalMode, "HELL");
  const st3 = games.emptyCasinoUserState();
  assert.equal(games.doubleCashout({ bet: 100, multiplier: 1.6, streak: 1 }, st3), 160);
  assert.equal(st3.internalMode, "NORMAL");
});

test("casino-games: ダイスの検証と抽選", () => {
  assert.equal(games.validateDice(6, 3), null);
  assert.equal(games.validateDice(4, 1), "invalid_dice_range");
  assert.equal(games.validateDice(6, 7), "invalid_dice_number");
  assert.equal(games.validateDice(6, 0), "invalid_dice_number");
  assert.equal(games.rollDice(6, () => 0), 1);
  assert.equal(games.rollDice(6, () => 0.999), 6);
  assert.deepEqual([...games.DICE_RANGES], [6, 20, 100]);
});

test("casino: セッションの整形とブラックジャックの伏せ札", () => {
  const s7 = sessionLib.cleanCasinoSession({
    kind: "slot7", bet: 10, total: 10, remaining: 3, prepayOpId: "op1",
    pendingReward: 50, pendingPenalty: 0, lastReels: [1, 2], lastEvents: [], createdAt: 100,
  });
  assert.equal(s7?.kind, "slot7");
  assert.equal(s7?.remaining, 3);
  assert.equal(sessionLib.cleanCasinoSession({ kind: "slot7", bet: -1 }), null);
  assert.equal(sessionLib.cleanCasinoSession({ kind: "nope", createdAt: 1 }), null);
  assert.equal(sessionLib.cleanCasinoSession("junk"), null);
  const bjView = sessionLib.publicSessionView({
    kind: "blackjack", bet: 100, spendOpIds: ["op1"], createdAt: 1,
    bj: {
      chips: 900, bet: 100, doubled: false, deck: [], round: 1, rng: 0,
      playerHand: [{ suit: "spade", rank: 10 }, { suit: "heart", rank: 7 }],
      dealerHand: [{ suit: "club", rank: 5 }, { suit: "diamond", rank: 13 }],
      phase: "player", result: null,
    },
  });
  assert.equal(bjView.dealerHand.length, 1, "プレイ中はディーラーの2枚目を隠す");
  assert.equal(bjView.dealerHidden, true);
});

test("casino: prepaid な gamble オプと新理由がブリッジを通る", () => {
  for (const reason of ["casino_dice", "casino_slot7", "casino_blackjack", "casino_double"]) {
    const op = eco.buildEconomyOp(
      { kind: "gamble", userKey: MY_KEY, discordId: ME, amount: 100, reason, payout: 250, prepaid: true },
      "12345678-abcd-4abc-8abc-1234567890ab", 1,
    );
    assert.equal(op?.prepaid, true, reason);
    assert.equal(eco.parseEconomyOp(op)?.prepaid, true, reason);
  }
  // prepaid でないオプには付けない
  const plain = eco.buildEconomyOp(
    { kind: "gamble", userKey: MY_KEY, discordId: ME, amount: 100, reason: "casino_slot", payout: 0 },
    "12345678-abcd-4abc-8abc-1234567890ab", 1,
  );
  assert.equal(plain?.prepaid, undefined);
});

// ---------- API: 移行ゲーム ----------

function markPendingSpendsDone() {
  for (const [k, v] of globalThis.__wbCasinoStore) {
    if (k.startsWith("worldbox_economy ") && v && typeof v === "object" && v.kind === "spend" && v.status === "pending") {
      v.status = "done";
    }
  }
}
function findOps(pred) {
  const out = [];
  for (const [k, v] of globalThis.__wbCasinoStore) {
    if (k.startsWith("worldbox_economy ") && v && typeof v === "object" && pred(v)) out.push(v);
  }
  return out;
}
function clearSession() {
  globalThis.__wbCasinoStore.delete(`worldbox_casino session:${MY_KEY}`);
}

test("API(casino): ダイスはテーブルの前で遊べ、当たれば bet×範囲", async () => {
  globalThis.__wbCasinoUsers.set(ME, 10000);
  clearSession();
  setPresence(44.5, 23.5, "lobby");
  const bad = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { action: "play", game: "dice", bet: 10, maxValue: 6, number: 9 }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "invalid_dice_number");
  const res = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { action: "play", game: "dice", bet: 10, maxValue: 6, number: 3 }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.result.rolled >= 1 && data.result.rolled <= 6);
  assert.equal(data.payout, data.result.hit ? 60 : 0);
  const stored = globalThis.__wbCasinoStore.get(`worldbox_economy ${data.opId}`);
  assert.equal(stored.reason, "casino_dice");
});

test("API(casino): ダブルアップは先払い→キャッシュアウトで prepaid 精算される", async () => {
  globalThis.__wbCasinoUsers.set(ME, 10000);
  clearSession();
  setPresence(40.5, 28.5, "lobby");
  const start = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { action: "double_start", bet: 100 }));
  assert.equal(start.status, 200);
  const startData = await start.json();
  assert.equal(startData.session.kind, "double");
  const spends = findOps((o) => o.kind === "spend" && o.reason === "casino_double_bet");
  assert.equal(spends.length, 1);
  assert.equal(spends[0].amount, 100);
  // コイン API 直接化: 先払い spend は登録と同時に適用され、残高もその場で減る
  assert.equal(spends[0].status, "done");
  assert.equal(globalThis.__wbCasinoUsers.get(ME), 10000 - 100);
  // そのままキャッシュアウトできる（倍率1 → ベット返し）
  const cash = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { action: "double_cashout" }));
  assert.equal(cash.status, 200);
  assert.equal((await cash.json()).payout, 100);
  const settles = findOps((o) => o.kind === "gamble" && o.reason === "casino_double");
  assert.equal(settles.length, 1);
  assert.equal(settles[0].prepaid, true);
  assert.equal(settles[0].payout, 100);
  const after = await (await casinoRoute.GET(apiRequest(URL_C, "GET", cookie))).json();
  assert.equal(after.session, null);
});

test("API(casino): ブラックジャックは配ってスタンドすると精算オプが積まれる", async () => {
  globalThis.__wbCasinoUsers.set(ME, 10000);
  clearSession();
  setPresence(48.5, 23.5, "lobby");
  const start = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { action: "bj_start", bet: 100 }));
  assert.equal(start.status, 200);
  const startData = await start.json();
  markPendingSpendsDone();
  if (startData.session === null) {
    // ナチュラル（配った時点で決着）: セッションは作られず final が返り、
    // そのまま精算される（API の契約。パネルも final を表示に使う）。
    // この分岐を想定していなかったため、約5%の確率で落ちる flake だった。
    assert.ok(startData.final, "ナチュラルでは final が返る");
    assert.equal(startData.final.playerHand.length, 2);
  } else {
    assert.equal(startData.session.kind, "blackjack");
    assert.equal(startData.session.playerHand.length, 2);
    assert.equal(startData.session.dealerHand.length, startData.session.phase === "player" ? 1 : 2);
    if (startData.session.phase === "player") {
      const stand = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { action: "bj_stand" }));
      assert.equal(stand.status, 200);
      const standData = await stand.json();
      assert.ok(standData.final, "決着した手札が返る");
      assert.equal(standData.final.dealerHand.length >= 2, true);
    }
  }
  const after = await (await casinoRoute.GET(apiRequest(URL_C, "GET", cookie))).json();
  assert.equal(after.session, null, "精算まで終わればセッションは消える");
  const settles = findOps((o) => o.kind === "gamble" && o.reason === "casino_blackjack");
  assert.equal(settles.length, 1);
  assert.equal(settles[0].prepaid, true);
  assert.equal(settles[0].amount, 100);
  assert.ok([0, 100, 200, 250].includes(settles[0].payout), `payout=${settles[0].payout}`);
});

test("API(casino): セブンスロットは1回分を先払いして回すと精算される（回数指定は廃止）", async () => {
  globalThis.__wbCasinoUsers.set(ME, 10000);
  clearSession();
  setPresence(46.5, 20.5, "lobby");
  const start = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { action: "slot7_start", bet: 10 }));
  assert.equal(start.status, 200);
  const startData = await start.json();
  assert.equal(startData.session.total, 1, "セッションは常に1回分");
  assert.equal(startData.session.remaining, 1);
  const spends = findOps((o) => o.kind === "spend" && o.reason === "casino_slot7_prepay");
  assert.equal(spends.length, 1);
  assert.equal(spends[0].amount, 10, "先払いはベット1回分だけ");
  // セッション中は別のセッションを始められない
  const dup = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { action: "slot7_start", bet: 10 }));
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error, "session_active");
  markPendingSpendsDone();
  const res = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { action: "slot7_spin" }));
  assert.equal(res.status, 200);
  const last = await res.json();
  assert.equal(last.spin.reels.length, 7);
  assert.equal(last.session, null, "1回回すと精算されてセッションが消える");
  const settles = findOps((o) => o.kind === "gamble" && o.reason === "casino_slot7");
  assert.equal(settles.length, 1);
  assert.equal(settles[0].prepaid, true);
  assert.equal(settles[0].amount, 10);
});

test("casino: セブンスロットに回数指定の UI・検証は残っていない", () => {
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxCasinoPanel.tsx"), "utf8");
  assert.ok(!panel.includes("SLOT7_SPIN_CHOICES"), "回数チップが無い");
  assert.ok(!panel.includes("invalid_spins"), "回数エラー表示が無い");
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/casino/route.ts"), "utf8");
  assert.ok(!route.includes("invalid_spins"), "API に回数検証が無い");
  assert.ok(!route.includes("fields.spins"), "API は spins を読まない");
});

test("API(casino): 精算は並行 GET が重なっても1回だけ（二重精算の回帰防止）", async () => {
  globalThis.__wbCasinoUsers.set(ME, 10000);
  clearSession();
  setPresence(40.5, 28.5, "lobby");
  const start = await casinoRoute.POST(apiRequest(URL_C, "POST", cookie, { action: "double_start", bet: 100 }));
  assert.equal(start.status, 200);
  markPendingSpendsDone();
  // バースト済みにして精算待ちの状態を作る
  const key = `worldbox_casino session:${MY_KEY}`;
  const session = JSON.parse(globalThis.__wbCasinoStore.get(key));
  session.busted = true;
  globalThis.__wbCasinoStore.set(key, JSON.stringify(session));
  // パネルの3秒ポーリングが重なった想定で GET を並行に叩く
  const results = await Promise.all([
    casinoRoute.GET(apiRequest(URL_C, "GET", cookie)),
    casinoRoute.GET(apiRequest(URL_C, "GET", cookie)),
    casinoRoute.GET(apiRequest(URL_C, "GET", cookie)),
  ]);
  for (const r of results) assert.equal(r.status, 200);
  const settles = findOps(
    (o) => o.kind === "gamble" && o.reason === "casino_double" && o.id === `settle-${session.prepayOpId}`,
  );
  assert.equal(settles.length, 1, "精算オプは決定的 ID で1件だけ積まれる");
  const after = await (await casinoRoute.GET(apiRequest(URL_C, "GET", cookie))).json();
  assert.equal(after.session, null);
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
