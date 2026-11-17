// AGO WORLD BOX カジノ大会（バッチ7c）の検証:
// - 順位表（純益の降順、同点は先に参加した方を上位に）
// - 賞金の配分（50%/30%/20%、純益プラスだけ、端数はハウスへ）
// - スコアの記録（対局時間中の参加者だけ、加算される）
// - 募集の締め切りと対局時間の終了（不成立は2人未満）
// - 賞金・参加費・返金の決定的 ID
// - 保存→復元の往復（壊れた値は落とす）
// - クライアント表示（他者の Discord ID は出さない、上位5件まで）
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

const C = await import(dataUrl(transpile("worldbox/casino-tournament.ts")));

const NOW = 1_700_000_000_000;
const A = "111111111111111111";
const B = "222222222222222222";
const D = "333333333333333333";
const E5 = "444444444444444444";

function tournament(entrants, status = "entry", scores = {}) {
  return {
    id: `ct-${NOW}`, status, createdAt: NOW,
    entryEndsAt: NOW + C.CASINO_TOURNAMENT_ENTRY_MS,
    playEndsAt: NOW + C.CASINO_TOURNAMENT_ENTRY_MS + C.CASINO_TOURNAMENT_PLAY_MS,
    playStartedAt: null,
    entrants: [...entrants], scores: { ...scores },
    prizesPaid: false, refundPaid: false, closedAt: null,
  };
}

// ---------- 順位表 ----------

test("casino-tournament: 順位は純益の降順、同点は先に参加した方", () => {
  const t = tournament([A, B, D], "running", {
    [A]: { bet: 100, payout: 300 },
    [B]: { bet: 100, payout: 300 },
    [D]: { bet: 100, payout: 50 },
  });
  const rows = C.casinoStandings(t);
  assert.deepEqual(rows.map((r) => r.discordId), [A, B, D]);
  assert.deepEqual(rows.map((r) => r.net), [200, 200, -50]);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3]);
});

test("casino-tournament: 未プレイは純益 0", () => {
  const t = tournament([A, B], "running");
  assert.deepEqual(C.casinoStandings(t).map((r) => r.net), [0, 0]);
});

// ---------- 賞金の配分 ----------

test("casino-tournament: プラス上位3人が 50%/30%/20% で分ける", () => {
  const t = tournament([A, B, D, E5], "running", {
    [A]: { bet: 100, payout: 400 },
    [B]: { bet: 100, payout: 250 },
    [D]: { bet: 100, payout: 150 },
    [E5]: { bet: 100, payout: 0 },
  });
  // 総額 800（4人×200）→ 400 / 240 / 160
  assert.deepEqual(C.casinoPrizeSplit(t), [
    { rank: 1, discordId: A, amount: 400 },
    { rank: 2, discordId: B, amount: 240 },
    { rank: 3, discordId: D, amount: 160 },
  ]);
});

test("casino-tournament: プラスが1人だけなら 50% だけ、残りはハウスへ", () => {
  const t = tournament([A, B], "running", {
    [A]: { bet: 100, payout: 500 },
    [B]: { bet: 100, payout: 0 },
  });
  assert.deepEqual(C.casinoPrizeSplit(t), [{ rank: 1, discordId: A, amount: 200 }]);
});

test("casino-tournament: プラスが誰もいなければ配分なし", () => {
  const t = tournament([A, B], "running", {
    [A]: { bet: 100, payout: 0 },
    [B]: { bet: 100, payout: 100 },
  });
  assert.deepEqual(C.casinoPrizeSplit(t), []);
});

// ---------- スコアの記録 ----------

test("casino-tournament: 対局時間中の参加者のスコアだけ加算される", () => {
  const t = tournament([A, B], "running");
  const scored = C.recordScore(t, A, 100, 350);
  assert.deepEqual(scored.scores[A], { bet: 100, payout: 350 });
  const again = C.recordScore(scored, A, 50, 0);
  assert.deepEqual(again.scores[A], { bet: 150, payout: 350 });
  // 参加者でない人・募集中の大会は記録されない
  assert.equal(C.recordScore(t, D, 100, 300), t);
  assert.equal(C.recordScore(tournament([A, B], "entry"), A, 100, 300).scores[A], undefined);
});

// ---------- 進行 ----------

test("casino-tournament: 期限前・満員でなければ募集は続く", () => {
  const t = tournament([A, B]);
  assert.equal(C.closeCasinoEntry(t, NOW + 1000), t);
});

test("casino-tournament: 募集期限を過ぎたら対局時間へ入る", () => {
  const t = tournament([A, B]);
  const closed = C.closeCasinoEntry(t, NOW + C.CASINO_TOURNAMENT_ENTRY_MS + 1);
  assert.equal(closed.status, "running");
  assert.equal(closed.closedAt, null);
  // 対局開始時刻が記録される（スコアに数えるオプの時刻の下限）
  assert.equal(closed.playStartedAt, NOW + C.CASINO_TOURNAMENT_ENTRY_MS + 1);
});

test("casino-tournament: 満員の早期締切では対局終了時刻が締切時点から数え直される", () => {
  const entrants = Array.from({ length: C.CASINO_TOURNAMENT_MAX_ENTRANTS }, (_, i) => `u${i}`);
  const t = tournament(entrants);
  const closed = C.closeCasinoEntry(t, NOW + 60_000);
  assert.equal(closed.status, "running");
  assert.equal(closed.playStartedAt, NOW + 60_000);
  assert.equal(closed.playEndsAt, NOW + 60_000 + C.CASINO_TOURNAMENT_PLAY_MS);
});

test("casino-tournament: 2人未満で締め切られた大会は不成立", () => {
  const t = tournament([A]);
  const closed = C.closeCasinoEntry(t, NOW + C.CASINO_TOURNAMENT_ENTRY_MS + 1);
  assert.equal(closed.status, "done");
  assert.equal(closed.closedAt, NOW + C.CASINO_TOURNAMENT_ENTRY_MS + 1);
});

test("casino-tournament: 対局時間を過ぎたら終了する", () => {
  const t = tournament([A, B], "running");
  assert.equal(C.closeCasinoPlay(t, NOW + 1000), t);
  const closed = C.closeCasinoPlay(t, NOW + C.CASINO_TOURNAMENT_ENTRY_MS + C.CASINO_TOURNAMENT_PLAY_MS + 1);
  assert.equal(closed.status, "done");
});

// ---------- ID ----------

test("casino-tournament: 賞金・参加費・返金の ID は決定的", () => {
  assert.equal(C.casinoTournamentPrizePool(tournament([A, B, D])), 600);
  assert.equal(C.casinoTournamentPrizeOpId(`ct-${NOW}`, 1), `ct-prize-ct-${NOW}-1`);
  assert.equal(C.casinoTournamentFeeOpId(`ct-${NOW}`, A), `ct-fee-ct-${NOW}-${A}`);
  assert.equal(C.casinoTournamentRefundOpId(`ct-${NOW}`, A), `ct-refund-ct-${NOW}-${A}`);
  for (const id of [C.casinoTournamentPrizeOpId(`ct-${NOW}`, 1), C.casinoTournamentFeeOpId(`ct-${NOW}`, A)]) {
    assert.match(id, /^[A-Za-z0-9-]{8,64}$/);
  }
});

// ---------- 保存→復元 ----------

test("casino-tournament: 保存→復元の往復で形が残り、壊れた値は落とす", () => {
  const t = tournament([A, B], "running", { [A]: { bet: 100, payout: 300 } });
  const back = C.parseCasinoTournament(JSON.parse(JSON.stringify(t)));
  assert.deepEqual(back, t);
  assert.equal(C.parseCasinoTournament(null), null);
  assert.equal(C.parseCasinoTournament({ ...t, status: "bogus" }), null);
  assert.equal(C.parseCasinoTournament({ ...t, scores: { [A]: { bet: "x", payout: 0 } } }), null);
  // playStartedAt の無い旧データは null として読む
  const legacy = { ...t };
  delete legacy.playStartedAt;
  assert.equal(C.parseCasinoTournament(legacy).playStartedAt, null);
  const started = { ...t, playStartedAt: NOW + 1000 };
  assert.equal(C.parseCasinoTournament(started).playStartedAt, NOW + 1000);
});

// ---------- クライアント表示 ----------

test("casino-tournament: 表示に他者の Discord ID は出ない", () => {
  const t = tournament([A, B, D], "running", {
    [A]: { bet: 100, payout: 300 },
    [B]: { bet: 100, payout: 250 },
    [D]: { bet: 100, payout: 50 },
  });
  const view = C.publicCasinoTournamentView(t, A);
  assert.equal(view.status, "running");
  assert.equal(view.myNet, 200);
  assert.equal(view.myRank, 1);
  assert.equal(view.standings.length, 3);
  assert.equal(view.standings[0].you, true);
  assert.equal(view.standings[1].you, false);
  assert.equal(JSON.stringify(view).includes(B), false);
  assert.equal(JSON.stringify(view).includes(D), false);
  const none = C.publicCasinoTournamentView(null, A);
  assert.equal(none.status, "none");
  assert.equal(none.myNet, 0);
  assert.equal(none.myRank, null);
});

test("casino-tournament: 順位表は上位5件まで", () => {
  const ids = Array.from({ length: 8 }, (_, i) => String(10 + i).repeat(9).slice(0, 18));
  const scores = {};
  ids.forEach((id, i) => { scores[id] = { bet: 100, payout: 100 + (8 - i) * 10 }; });
  const t = tournament(ids, "running", scores);
  const view = C.publicCasinoTournamentView(t, ids[0]);
  assert.equal(view.standings.length, 5);
  assert.equal(view.myRank, 1);
});
