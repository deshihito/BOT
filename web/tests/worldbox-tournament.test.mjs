// AGO WORLD BOX 闘技場大会（バッチ7c）の検証:
// - トーナメント表の作成（2/3/5/8人、不戦勝の送り出し）
// - 勝者の送り出しと優勝の決定（無効な勝者は弾く）
// - 募集の締め切り（期限・満員・不成立）
// - 期限切れ試合のシード上位による決着
// - 賞金総額と決定的 ID
// - 保存→復元の往復（壊れた値は落とす）
// - クライアント表示（他者の Discord ID は出さない）
// - 大会の対戦は PvP 決闘エンジンで fighting から始まる
// - 経済ブリッジの earn ホワイトリストに大会の理由がある
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

const T = await import(dataUrl(transpile("worldbox/tournament.ts")));
const P = await import(dataUrl(transpile("worldbox/pvp.ts")));
const E = await import(dataUrl(transpile("worldbox/economy-bridge.ts")));

const NOW = 1_700_000_000_000;
const A = "111111111111111111";
const B = "222222222222222222";
const C = "333333333333333333";
const D = "444444444444444444";
const E5 = "555555555555555555";

function tournament(entrants, status = "entry") {
  return {
    id: `t-${NOW}`, status, createdAt: NOW, entryEndsAt: NOW + T.TOURNAMENT_ENTRY_MS,
    entrants: [...entrants], matches: [], champion: null,
    prizePaid: false, refundPaid: false, closedAt: null,
  };
}

// ---------- トーナメント表 ----------

test("tournament: 2人は決勝1試合、不戦勝なし", () => {
  const matches = T.buildBracket([A, B]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].a, A);
  assert.equal(matches[0].b, B);
  assert.equal(matches[0].state, "pending");
});

test("tournament: 3人は4枠表で上位シードが不戦勝", () => {
  const matches = T.buildBracket([A, B, C]);
  assert.equal(matches.length, 3);
  const bye = matches.find((m) => m.id === "m0-0");
  assert.equal(bye.a, A);
  assert.equal(bye.b, null);
  assert.equal(bye.winner, A);
  assert.equal(bye.state, "done");
  const play = matches.find((m) => m.id === "m0-1");
  assert.equal(play.a, B);
  assert.equal(play.b, C);
  assert.equal(play.state, "pending");
  const semi = matches.find((m) => m.id === "m1-0");
  assert.equal(semi.a, A);
  assert.equal(semi.b, null);
});

test("tournament: 5人は8枠表で不戦勝が3件、総試合7", () => {
  const matches = T.buildBracket([A, B, C, D, E5]);
  assert.equal(matches.length, 7);
  assert.equal(matches.filter((m) => m.state === "done").length, 3);
  // 1回戦で戦うのは1組だけ。不戦勝同士の準決勝（e1 vs e2）も対戦者が揃う
  assert.equal(matches.filter((m) => m.state === "pending" && m.a && m.b).length, 2);
  const semi = matches.find((m) => m.id === "m1-1");
  assert.equal(semi.a, B);
  assert.equal(semi.b, C);
});

test("tournament: 8人は不戦勝なし、総試合7・3回戦", () => {
  const matches = T.buildBracket([A, B, C, D, E5, "666666666666666666", "777777777777777777", "888888888888888888"]);
  assert.equal(matches.length, 7);
  assert.equal(matches.filter((m) => m.state === "done").length, 0);
  assert.equal(matches.filter((m) => m.round === 2).length, 1);
});

// ---------- 勝者の送り出し ----------

test("tournament: 勝者は次ラウンドへ送られ、決勝の勝者が優勝する", () => {
  let t = tournament([A, B, C, D]);
  t = { ...t, status: "running", matches: T.buildBracket([A, B, C, D]) };
  const afterSemiA = T.advanceMatch(t, "m0-0", A, NOW);
  assert.ok(afterSemiA);
  assert.equal(afterSemiA.matches.find((m) => m.id === "m1-0").a, A);
  assert.equal(afterSemiA.champion, null);
  const afterSemiB = T.advanceMatch(afterSemiA, "m0-1", C, NOW);
  assert.ok(afterSemiB);
  assert.equal(afterSemiB.matches.find((m) => m.id === "m1-0").b, C);
  const afterFinal = T.advanceMatch(afterSemiB, "m1-0", A, NOW);
  assert.ok(afterFinal);
  assert.equal(afterFinal.champion, A);
  assert.equal(afterFinal.status, "done");
  assert.equal(afterFinal.closedAt, NOW);
});

test("tournament: 対戦者でない勝者・決着済みの試合は弾く", () => {
  const t = { ...tournament([A, B]), status: "running", matches: T.buildBracket([A, B]) };
  assert.equal(T.advanceMatch(t, "m0-0", C, NOW), null);
  assert.equal(T.advanceMatch(t, "m9-9", A, NOW), null);
  const done = T.advanceMatch(t, "m0-0", A, NOW);
  assert.ok(done);
  assert.equal(T.advanceMatch(done, "m0-0", B, NOW), null);
});

test("tournament: 決闘がまだの試合だけが ready", () => {
  const t = { ...tournament([A, B, C, D]), status: "running", matches: T.buildBracket([A, B, C, D]) };
  assert.deepEqual(T.readyMatches(t).map((m) => m.id), ["m0-0", "m0-1"]);
  const withDuel = {
    ...t,
    matches: t.matches.map((m) => (m.id === "m0-0" ? { ...m, duelId: "pvp-x", state: "dueling" } : m)),
  };
  assert.deepEqual(T.readyMatches(withDuel).map((m) => m.id), ["m0-1"]);
});

test("tournament: 期限切れの試合はシード上位が進出する", () => {
  const t = { ...tournament([A, B, C, D]), status: "running", matches: T.buildBracket([A, B, C, D]) };
  const m = t.matches.find((x) => x.id === "m0-1");
  assert.equal(T.timeoutWinner(t, m), B);
});

// ---------- 募集の締め切り ----------

test("tournament: 期限前・満員でなければ募集は続く", () => {
  const t = tournament([A, B]);
  assert.equal(T.closeEntry(t, NOW + 1000), t);
});

test("tournament: 期限を過ぎたら表を作って開始する", () => {
  const t = tournament([A, B, C, D]);
  const closed = T.closeEntry(t, NOW + T.TOURNAMENT_ENTRY_MS + 1);
  assert.equal(closed.status, "running");
  assert.equal(closed.matches.length, 3);
});

test("tournament: 満員になったら期限前でも開始する", () => {
  const ids = [A, B, C, D, E5, "666666666666666666", "777777777777777777", "888888888888888888"];
  const t = tournament(ids);
  const closed = T.closeEntry(t, NOW + 1000);
  assert.equal(closed.status, "running");
  assert.equal(closed.matches.length, 7);
});

test("tournament: 2人未満で締め切られた大会は不成立", () => {
  const t = tournament([A]);
  const closed = T.closeEntry(t, NOW + T.TOURNAMENT_ENTRY_MS + 1);
  assert.equal(closed.status, "done");
  assert.equal(closed.champion, null);
  assert.equal(closed.closedAt, NOW + T.TOURNAMENT_ENTRY_MS + 1);
});

// ---------- 賞金と ID ----------

test("tournament: 賞金総額は参加費の総額、ID は決定的", () => {
  assert.equal(T.tournamentPrizePool(tournament([A, B, C, D])), 800);
  assert.equal(T.tournamentPrizeOpId(`t-${NOW}`), `t-prize-t-${NOW}`);
  assert.equal(T.tournamentFeeOpId(`t-${NOW}`, A), `t-fee-t-${NOW}-${A}`);
  assert.equal(T.tournamentRefundOpId(`t-${NOW}`, A), `t-refund-t-${NOW}-${A}`);
  for (const id of [T.tournamentPrizeOpId(`t-${NOW}`), T.tournamentFeeOpId(`t-${NOW}`, A)]) {
    assert.match(id, /^[A-Za-z0-9-]{8,64}$/);
  }
});

// ---------- 保存→復元 ----------

test("tournament: 保存→復元の往復で形が残り、壊れた値は落とす", () => {
  const t = { ...tournament([A, B]), status: "running", matches: T.buildBracket([A, B]) };
  const back = T.parseTournament(JSON.parse(JSON.stringify(t)));
  assert.deepEqual(back, t);
  assert.equal(T.parseTournament(null), null);
  assert.equal(T.parseTournament({ ...t, status: "bogus" }), null);
  assert.equal(T.parseTournament({ ...t, entrants: "nope" }), null);
});

// ---------- クライアント表示 ----------

test("tournament: 表示に他者の Discord ID は出ない", () => {
  const t = { ...tournament([A, B, C, D]), status: "running", matches: T.buildBracket([A, B, C, D]) };
  const view = T.publicTournamentView(t, A);
  assert.equal(view.status, "running");
  assert.equal(view.entrantCount, 4);
  assert.equal(view.prizePool, 800);
  assert.equal(view.entered, true);
  assert.equal(view.myMatch.round, 0);
  assert.equal(JSON.stringify(view).includes(B), false);
  assert.equal(JSON.stringify(view).includes(C), false);
  const none = T.publicTournamentView(null, A);
  assert.equal(none.status, "none");
  assert.equal(none.entered, false);
});

test("tournament: 優勝者の表示は自分だけが you", () => {
  const t = { ...tournament([A, B]), status: "done", champion: A, closedAt: NOW };
  assert.equal(T.publicTournamentView(t, A).champion, "you");
  assert.equal(T.publicTournamentView(t, B).champion, "decided");
});

// ---------- PvP 決闘エンジンとの接続 ----------

test("tournament: 大会の対戦は fighting から始まり、参加費・賞金は 0", () => {
  const qa = { ownerKey: `discord:${A}`, discordId: A, attack: 12, queuedAt: NOW };
  const qb = { ownerKey: `discord:${B}`, discordId: B, attack: 16, queuedAt: NOW };
  const duel = P.createTournamentDuel(qa, qb, NOW, `t-${NOW}`, "m0-0");
  assert.equal(duel.state, "fighting");
  assert.deepEqual(duel.tournament, { tournamentId: `t-${NOW}`, matchId: "m0-0" });
  assert.equal(duel.feeOpIds.length, 2);
  const back = P.parsePvpDuel(JSON.parse(JSON.stringify(duel)));
  assert.deepEqual(back, duel);
  const view = P.publicPvpView(duel, A);
  assert.equal(view.fee, 0);
  assert.equal(view.prize, 0);
  const normal = P.createDuel(qa, qb, NOW);
  assert.equal(P.publicPvpView(normal, A).fee, 100);
  assert.equal(P.publicPvpView(normal, A).prize, 240);
});

// ---------- 経済ブリッジ ----------

test("tournament: earn ホワイトリストに大会の理由がある", () => {
  for (const reason of [
    "arena_tournament_prize", "arena_tournament_refund",
    "casino_tournament_prize", "casino_tournament_refund",
  ]) {
    assert.ok(E.EARN_REASONS.has(reason), reason);
  }
  const op = E.buildEconomyOp(
    { kind: "earn", userKey: `discord:${A}`, discordId: A, amount: 1600, reason: "arena_tournament_prize" },
    `t-prize-t-${NOW}`, NOW,
  );
  assert.ok(op);
  assert.equal(op.id, `t-prize-t-${NOW}`);
});
