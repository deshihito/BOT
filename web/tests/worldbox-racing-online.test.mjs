// AGO WORLD BOX 競馬の永続化・精算・経済配線の検証:
// - 人気集計は実馬券だけを数える
// - 精算: 先払い done の的中馬券だけ gamble オプが1回積まれ、failed は無効、
//   pending は次回へ回る（カジノと同じ先払いゲート規則）
// - gamble 理由 horse_racing が TS/Python 両側のホワイトリストで一致する
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");
const repoDir = path.join(rootDir, "..");

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
globalThis.__wbRacingStore = store;
export function isBotApiConfigured() { return true; }
export async function kvGet(ns, key) { const v = store.get(ns + " " + key); return v === undefined ? null : v; }
export async function kvSet(ns, key, value) { store.set(ns + " " + key, value); }
export async function kvDelete(ns, key) { store.delete(ns + " " + key); }
export async function kvList(ns) {
  const m = new Map();
  for (const [k, v] of store) if (k.startsWith(ns + " ")) m.set(k.slice(ns.length + 1), v);
  return m;
}
export async function tableSelect() { return []; }
export class BotApiError extends Error {}
export async function rpc() { return null; }
export async function tableInsert() { return null; }
export async function tableUpdate() { return null; }
`);
const bridgeUrl = dataUrl(transpile("worldbox/economy-bridge.ts"));
const bridgeOnlineUrl = dataUrl(
  transpile("worldbox/economy-bridge-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./economy-bridge"', JSON.stringify(bridgeUrl)),
);
const rngUrl = dataUrl(transpile("worldbox/rng.ts"));
const horsesUrl = dataUrl(transpile("worldbox/racing/horses.ts"));
const racingUrl = dataUrl(
  transpile("worldbox/racing.ts")
    .replaceAll('"./rng"', JSON.stringify(rngUrl))
    .replaceAll('"./racing/horses"', JSON.stringify(horsesUrl)),
);
const onlineUrl = dataUrl(
  transpile("worldbox/racing-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./economy-bridge-online"', JSON.stringify(bridgeOnlineUrl))
    .replaceAll('"./racing"', JSON.stringify(racingUrl)),
);
const online = await import(onlineUrl);
const racing = await import(racingUrl);
const bridge = await import(bridgeUrl);

const OWNER = "discord:123456789012345678";

function seedSpendOp(opId, status) {
  const store = globalThis.__wbRacingStore;
  store.set(`worldbox_economy ${opId}`, JSON.stringify({
    id: opId, kind: "spend", userKey: OWNER, discordId: "123456789012345678",
    amount: 500, reason: "horse_racing_bet", status, createdAt: 1,
  }));
}

test("人気集計: 馬ごとの単勝/複勝の票数を数える", () => {
  const counts = online.popularityCounts([
    { horseId: 1, type: "win", amount: 100 },
    { horseId: 1, type: "win", amount: 500 },
    { horseId: 1, type: "place", amount: 100 },
    { horseId: 2, type: "place", amount: 1000 },
  ]);
  assert.deepEqual(counts.get(1), { win: 2, place: 1 });
  assert.deepEqual(counts.get(2), { win: 0, place: 1 });
});

test("精算: 的中は gamble 登録コールバックが1回呼ばれ、払戻が記録される", async () => {
  const post = 1_800_000_000_000;
  const core = racing.generateRaceCore(post);
  const winner = core.placings[0];
  seedSpendOp("race-bet-b1", "done");
  const calls = [];
  const bet = {
    betId: "b1", postMs: post, horseId: winner, type: "win", amount: 500,
    oddsWin: 3.5, oddsPlace: 1.5, spendOpId: "race-bet-b1",
    settle: "open", payout: null, createdAt: 1,
  };
  const { bets, changed } = await online.settleMyBets(OWNER, [bet], post + racing.RACE_DURATION_MS + 1, async (b, payout) => {
    calls.push([b.betId, payout]);
    return true;
  });
  assert.equal(changed, true);
  assert.deepEqual(calls, [["b1", 1750]]);
  assert.equal(bets[0].settle, "settled");
  assert.equal(bets[0].payout, 1750);
});

test("精算: ハズレはオプなしで settled、先払い failed は void、pending は据え置き", async () => {
  const post = 1_800_000_000_000;
  const core = racing.generateRaceCore(post);
  const loser = core.placings[core.placings.length - 1];
  seedSpendOp("race-bet-b2", "done");
  seedSpendOp("race-bet-b3", "failed");
  seedSpendOp("race-bet-b4", "pending");
  const mk = (betId, horseId) => ({
    betId, postMs: post, horseId, type: "win", amount: 100,
    oddsWin: 2.0, oddsPlace: 1.2, spendOpId: `race-bet-${betId}`,
    settle: "open", payout: null, createdAt: 1,
  });
  let calls = 0;
  const { bets } = await online.settleMyBets(
    OWNER, [mk("b2", loser), mk("b3", loser), mk("b4", loser)],
    post + racing.RACE_DURATION_MS + 1,
    async () => { calls++; return true; },
  );
  assert.equal(calls, 0);
  assert.equal(bets[0].settle, "settled");
  assert.equal(bets[0].payout, 0);
  assert.equal(bets[1].settle, "void");
  assert.equal(bets[2].settle, "open");
});

test("精算: レース終了前は手を付けない", async () => {
  const post = 1_800_000_000_000;
  seedSpendOp("race-bet-b5", "done");
  const bet = {
    betId: "b5", postMs: post, horseId: 1, type: "win", amount: 100,
    oddsWin: 2.0, oddsPlace: 1.2, spendOpId: "race-bet-b5",
    settle: "open", payout: null, createdAt: 1,
  };
  const { bets, changed } = await online.settleMyBets(OWNER, [bet], post + 1000, async () => true);
  assert.equal(changed, false);
  assert.equal(bets[0].settle, "open");
});

test("経済配線: gamble 理由 horse_racing が TS で通り、Python 側と集合が一致する", () => {
  const op = bridge.buildEconomyOp(
    { kind: "gamble", userKey: OWNER, discordId: "123456789012345678", amount: 500, reason: "horse_racing", payout: 1750, prepaid: true },
    "race-settle-testbet1",
    Date.now(),
  );
  assert.ok(op, "horse_racing gamble op builds");
  const py = fs.readFileSync(path.join(repoDir, "core/general/circulation/worldbox_economy.py"), "utf8");
  const m = py.match(/GAMBLE_REASONS = frozenset\(\{([^}]+)\}\)/);
  assert.ok(m, "python GAMBLE_REASONS found");
  const pySet = new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  assert.deepEqual(pySet, new Set(bridge.GAMBLE_REASONS));
});
