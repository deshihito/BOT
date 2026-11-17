// AGO WORLD BOX 大会の参加費照合とカジノ大会スコア確定（2026-11-17 是正）:
// - 闘技場大会: 締め切り時に参加費 failed の参加者を表から外す
// - 闘技場大会: 返金は参加費 done の参加者だけ。pending の間は完了しない
// - 闘技場大会: 優勝賞金は参加費 done の参加者分だけを原資にする
// - カジノ大会: 締め切り時に参加費 failed の参加者を外し、不成立なら
//   返金も done の参加者だけに行う
// - カジノ大会: スコアは gamble オプが done に確定してから加わり、
//   二重に数えない。failed / 対局時間外のオプは数えない
// - カジノ大会: 対局終了時の最終精算で、終了間際に確定したオプも
//   賞金の前に順位へ入る。賞金は参加費 done の参加者だけで数え直す
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

const botApiStubUrl = dataUrl(`
const store = new Map();
const users = new Map();
globalThis.__wbFeeStore = store;
globalThis.__wbFeeUsers = users;
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
  if (table === "transaction_history") return;
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
export async function rpc(name, params) { throw new Error("unexpected rpc " + name); }
`);

const economyUrl = dataUrl(transpile("worldbox/economy-bridge.ts"));
const economyOnlineUrl = dataUrl(
  transpile("worldbox/economy-bridge-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./economy-bridge"', JSON.stringify(economyUrl)),
);
const arenaUrl = dataUrl(transpile("worldbox/arena.ts"));
const tournamentUrl = dataUrl(transpile("worldbox/tournament.ts"));
const pvpUrl = dataUrl(transpile("worldbox/pvp.ts"));
const itemsUrl = dataUrl(transpile("worldbox/items.ts"));
const profileUrl = dataUrl(
  transpile("worldbox/profile.ts")
    .replaceAll('"./items"', JSON.stringify(itemsUrl)),
);
const profileOnlineUrl = dataUrl(
  transpile("worldbox/profile-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./profile"', JSON.stringify(profileUrl)),
);
const pvpOnlineUrl = dataUrl(
  transpile("worldbox/pvp-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./pvp"', JSON.stringify(pvpUrl)),
);
const userLockUrl = dataUrl(transpile("worldbox/user-lock.ts"));
const tournamentOnlineUrl = dataUrl(
  transpile("worldbox/tournament-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./economy-bridge-online"', JSON.stringify(economyOnlineUrl))
    .replaceAll('"./economy-bridge"', JSON.stringify(economyUrl))
    .replaceAll('"./profile-online"', JSON.stringify(profileOnlineUrl))
    .replaceAll('"./pvp-online"', JSON.stringify(pvpOnlineUrl))
    .replaceAll('"./arena"', JSON.stringify(arenaUrl))
    .replaceAll('"./tournament"', JSON.stringify(tournamentUrl))
    .replaceAll('"./pvp"', JSON.stringify(pvpUrl))
    .replaceAll('"./user-lock"', JSON.stringify(userLockUrl)),
);
const casinoTournamentUrl = dataUrl(transpile("worldbox/casino-tournament.ts"));
const casinoTournamentOnlineUrl = dataUrl(
  transpile("worldbox/casino-tournament-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./economy-bridge-online"', JSON.stringify(economyOnlineUrl))
    .replaceAll('"./economy-bridge"', JSON.stringify(economyUrl))
    .replaceAll('"./casino-tournament"', JSON.stringify(casinoTournamentUrl))
    .replaceAll('"./user-lock"', JSON.stringify(userLockUrl)),
);

const eco = await import(economyUrl);
const T = await import(tournamentUrl);
const TOnline = await import(tournamentOnlineUrl);
const C = await import(casinoTournamentUrl);
const COnline = await import(casinoTournamentOnlineUrl);

const store = globalThis.__wbFeeStore;
const A = "111111111111111111";
const B = "222222222222222222";
const D = "333333333333333333";

function resetStore() {
  store.clear();
}

/** オプを組み立てて状態を指定し、経済名前空間へ直接置く（ワーカー適用後の姿）。 */
function seedOp({ kind, discordId, amount, reason, payout, status, id, at }) {
  const op = eco.buildEconomyOp(
    { kind, userKey: `discord:${discordId}`, discordId, amount, reason, payout },
    id,
    at,
  );
  assert.ok(op, `オプが作れない: ${id}`);
  op.status = status;
  store.set(`worldbox_economy ${op.id}`, op);
  return op;
}

function storedOp(id) {
  return store.get(`worldbox_economy ${id}`) ?? null;
}

// ---------- 闘技場大会 ----------

function arenaTournament(entrants, extra = {}) {
  return {
    id: "t-1000", status: "entry", createdAt: 1000, entryEndsAt: 2000,
    entrants: [...entrants], matches: [], champion: null,
    prizePaid: false, refundPaid: false, closedAt: null, ...extra,
  };
}

function seedArenaFee(discordId, status) {
  return seedOp({
    kind: "spend", discordId, amount: T.TOURNAMENT_FEE, reason: "arena_tournament_entry",
    status, id: T.tournamentFeeOpId("t-1000", discordId), at: 1500,
  });
}

test("fees(arena): 締め切り時に参加費 failed の参加者は表から外れる", async () => {
  resetStore();
  seedArenaFee(A, "done");
  seedArenaFee(B, "failed");
  seedArenaFee(D, "done");
  const out = await TOnline.closeEntryInner(arenaTournament([A, B, D]), 3000);
  assert.equal(out.status, "running");
  assert.deepEqual(out.entrants, [A, D]);
  const players = out.matches.flatMap((m) => [m.a, m.b]).filter(Boolean);
  assert.ok(!players.includes(B), "未払いの参加者が表に残っている");
  assert.ok(players.includes(A) && players.includes(D));
});

test("fees(arena): 返金は参加費 done の参加者だけ、pending の間は完了しない", async () => {
  resetStore();
  seedArenaFee(A, "done");
  const feeB = seedArenaFee(B, "pending");
  const t = arenaTournament([A, B], { status: "done", closedAt: 3000 });
  const first = await TOnline.payRefundsInner(t);
  assert.equal(first.refundPaid, false, "pending が残る間は返金を完了扱いにしない");
  assert.ok(storedOp(T.tournamentRefundOpId("t-1000", A)), "done の参加者へは返金が積まれる");
  assert.equal(storedOp(T.tournamentRefundOpId("t-1000", B)), null, "pending の参加者へはまだ積まない");
  // ワーカーが適用して done になったら、次回の進行で返金が完了する
  feeB.status = "done";
  const second = await TOnline.payRefundsInner(first);
  assert.equal(second.refundPaid, true);
  assert.ok(storedOp(T.tournamentRefundOpId("t-1000", B)));
});

test("fees(arena): 参加費 failed の参加者には返金せず、完了扱いにする", async () => {
  resetStore();
  seedArenaFee(A, "failed");
  seedArenaFee(B, "done");
  const t = arenaTournament([A, B], { status: "done", closedAt: 3000 });
  const out = await TOnline.payRefundsInner(t);
  assert.equal(out.refundPaid, true);
  assert.equal(storedOp(T.tournamentRefundOpId("t-1000", A)), null, "払っていない参加費は返らない");
  assert.ok(storedOp(T.tournamentRefundOpId("t-1000", B)));
});

test("fees(arena): 優勝賞金は参加費 done の参加者分だけを原資にする", async () => {
  resetStore();
  seedArenaFee(A, "done");
  seedArenaFee(B, "done");
  seedArenaFee(D, "failed");
  const t = arenaTournament([A, B, D], { status: "done", champion: A, closedAt: 3000 });
  const out = await TOnline.payChampionPrizeInner(t);
  assert.equal(out.prizePaid, true);
  const prize = storedOp(T.tournamentPrizeOpId("t-1000"));
  assert.ok(prize, "賞金オプが積まれていない");
  assert.equal(prize.amount, T.TOURNAMENT_FEE * 2, "未払い分まで原資に数えている");
  assert.equal(prize.discordId, A);
});

test("fees(arena): 参加費が未確定の間は優勝賞金を払わない", async () => {
  resetStore();
  seedArenaFee(A, "done");
  seedArenaFee(B, "pending");
  const t = arenaTournament([A, B], { status: "done", champion: A, closedAt: 3000 });
  const out = await TOnline.payChampionPrizeInner(t);
  assert.equal(out.prizePaid, false);
  assert.equal(storedOp(T.tournamentPrizeOpId("t-1000")), null);
});

// ---------- カジノ大会 ----------

function casinoTournament(entrants, extra = {}) {
  return {
    id: "ct-1000", status: "entry", createdAt: 1000, entryEndsAt: 2000,
    playEndsAt: 2000 + C.CASINO_TOURNAMENT_PLAY_MS, playStartedAt: null,
    entrants: [...entrants], scores: {},
    prizesPaid: false, refundPaid: false, closedAt: null, ...extra,
  };
}

function seedCasinoFee(discordId, status) {
  return seedOp({
    kind: "spend", discordId, amount: C.CASINO_TOURNAMENT_FEE, reason: "casino_tournament_entry",
    status, id: C.casinoTournamentFeeOpId("ct-1000", discordId), at: 1500,
  });
}

test("fees(casino): 締め切り時に参加費 failed の参加者を外し、不成立の返金は done だけ", async () => {
  resetStore();
  seedCasinoFee(A, "done");
  seedCasinoFee(B, "failed");
  const out = await COnline.advanceCasinoTournamentInner(casinoTournament([A, B]), 3000);
  assert.equal(out.status, "done", "残り1人では不成立");
  assert.deepEqual(out.entrants, [A]);
  assert.equal(out.refundPaid, true);
  assert.ok(storedOp(C.casinoTournamentRefundOpId("ct-1000", A)), "done の参加者へ返金が積まれる");
  assert.equal(storedOp(C.casinoTournamentRefundOpId("ct-1000", B)), null, "failed の参加者へは返金しない");
});

test("fees(casino): スコアは gamble オプの確定後にだけ加わり、二重に数えない", async () => {
  resetStore();
  const NOW = Date.now();
  const t = casinoTournament([A, B], {
    status: "running",
    createdAt: NOW - 10_000, entryEndsAt: NOW - 5_000,
    playStartedAt: NOW - 5_000, playEndsAt: NOW + C.CASINO_TOURNAMENT_PLAY_MS,
  });
  store.set("worldbox_casino_tournament current", JSON.stringify(t));
  const base = { kind: "gamble", discordId: A, amount: 100, reason: "casino_slot" };
  const done = seedOp({ ...base, payout: 300, status: "done", id: "g-done-0001", at: NOW - 4_000 });
  const pending = seedOp({ ...base, payout: 500, status: "pending", id: "g-pend-0001", at: NOW - 4_000 });
  seedOp({ ...base, payout: 900, status: "failed", id: "g-fail-0001", at: NOW - 4_000 });
  seedOp({ ...base, payout: 700, status: "done", id: "g-early-001", at: NOW - 6_000 }); // 対局開始前
  seedOp({ kind: "gamble", discordId: D, amount: 100, reason: "casino_slot", payout: 800, status: "done", id: "g-other-001", at: NOW - 4_000 }); // 非参加者

  const mine = [done, pending];
  await COnline.reconcileCasinoTournamentScores(`discord:${A}`, A, mine);
  let cur = await COnline.loadCasinoTournament();
  assert.deepEqual(cur.scores[A], { bet: 100, payout: 300 }, "done のオプだけが数えられる");

  // 同じオプを再照合しても二重に数えない
  await COnline.reconcileCasinoTournamentScores(`discord:${A}`, A, mine);
  cur = await COnline.loadCasinoTournament();
  assert.deepEqual(cur.scores[A], { bet: 100, payout: 300 });

  // pending が done になったら次回の照合で加わる
  pending.status = "done";
  await COnline.reconcileCasinoTournamentScores(`discord:${A}`, A, mine);
  cur = await COnline.loadCasinoTournament();
  assert.deepEqual(cur.scores[A], { bet: 200, payout: 800 });
});

test("fees(casino): 対局終了の最終精算で遅れて確定したオプも順位に入り、賞金は done の参加費だけ", async () => {
  resetStore();
  // 対局中: A は確定済みプレイ1件を記録済み、B の参加費は締め切り後に failed が判明
  const t = casinoTournament([A, B], {
    status: "running", createdAt: 1000, entryEndsAt: 2000,
    playStartedAt: 2000, playEndsAt: 9000,
    scores: { [A]: { bet: 100, payout: 300 } },
  });
  store.set("worldbox_casino_tournament current", JSON.stringify(t));
  store.set("worldbox_casino_tournament scored-ct-1000", JSON.stringify(["g-early-001"]));
  seedCasinoFee(A, "done");
  seedCasinoFee(B, "failed");
  seedOp({
    kind: "gamble", discordId: A, amount: 100, reason: "casino_slot", payout: 300,
    status: "done", id: "g-early-001", at: 3000,
  });
  seedOp({
    kind: "gamble", discordId: A, amount: 100, reason: "casino_slot", payout: 200,
    status: "done", id: "g-late-0001", at: 8000,
  });
  const out = await COnline.advanceCasinoTournamentInner(t, 9500);
  assert.equal(out.status, "done");
  assert.deepEqual(out.scores[A], { bet: 200, payout: 500 }, "終了間際の確定オプが最終精算で入る");
  assert.equal(out.prizesPaid, true);
  const prize = storedOp(C.casinoTournamentPrizeOpId("ct-1000", 1));
  assert.ok(prize, "賞金オプが積まれていない");
  // 原資は done の参加費1人分（200）、A の純益 300 で1位 50% = 100
  assert.equal(prize.amount, 100);
  assert.equal(prize.discordId, A);
});
