// AGO WORLD BOX 闘技場PvP（バッチ7c）の検証:
// - マッチング待ち行列（先着順・期限切れの間引き）
// - 決闘の生成（決定的 ID・参加費オプ ID・賞金オプ ID）
// - 交互ターンの決闘（攻撃/強攻撃/まもる・手番違反・勝敗）
// - 期限切れ（待ち5分・決闘10分）
// - 保存→復元の往復（壊れた値は落とす）
// - クライアント表示（相手の Discord ID は出さない）
// ルート配線（待ち→参加費先払い→決着で賞金）は route 側の責務で、
// ここでは純粋ロジックの不変条件に加え、B3 の不成立時精算の配線だけを
// ソース確認で検証する。
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

const P = await import(dataUrl(transpile("worldbox/pvp.ts")));

const NOW = 1_700_000_000_000;
const A = { ownerKey: "discord:111111111111111111", discordId: "111111111111111111", attack: 12, queuedAt: NOW };
const B = { ownerKey: "discord:222222222222222222", discordId: "222222222222222222", attack: 16, queuedAt: NOW };
const C = { ownerKey: "discord:333333333333333333", discordId: "333333333333333333", attack: 8, queuedAt: NOW };

function duel() {
  return P.createDuel(A, B, NOW);
}

function rngSeq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

// ---------- マッチング ----------

test("pvp: 待ちが2人で組まれ、3人目は残る", () => {
  const m = P.tryMatch([A, B, C], NOW);
  assert.ok(m);
  assert.deepEqual(m.pair, [A, B]);
  assert.deepEqual(m.rest, [C]);
});

test("pvp: 待ちが1人では組まれない", () => {
  assert.equal(P.tryMatch([A], NOW), null);
  assert.equal(P.tryMatch([], NOW), null);
});

test("pvp: 期限切れの待ちは間引かれて組まれない", () => {
  const stale = { ...A, queuedAt: NOW - P.PVP_QUEUE_TTL_MS - 1 };
  assert.equal(P.tryMatch([stale, B], NOW), null);
  assert.deepEqual(P.pruneQueue([stale, B], NOW), [B]);
});

// ---------- 決闘の生成 ----------

test("pvp: 決闘は決定的 ID と両者の参加費オプ ID を持つ", () => {
  const d = duel();
  assert.equal(d.id, `pvp-${A.discordId}-${B.discordId}-${NOW}`);
  assert.equal(d.state, "paying");
  assert.equal(d.hp[0], P.PVP_PLAYER_HP);
  assert.equal(d.hp[1], P.PVP_PLAYER_HP);
  assert.equal(d.turn, 0);
  assert.notEqual(d.feeOpIds[0], d.feeOpIds[1]);
  assert.ok(d.feeOpIds[0].startsWith("pvp-fee-"));
  assert.ok(d.feeOpIds[1].startsWith("pvp-fee-"));
  // 経済オプ ID の形（8〜64文字の英数・ハイフン）に収まる
  for (const id of [...d.feeOpIds, P.pvpPrizeOpId(d.code)]) {
    assert.match(id, /^[A-Za-z0-9-]{8,64}$/);
  }
});

test("pvp: 賞金オプ ID は1試合で1つに決まる", () => {
  const d = duel();
  assert.equal(P.pvpPrizeOpId(d.code), P.pvpPrizeOpId(P.pvpDuelCode(A.discordId, B.discordId, NOW)));
});

test("pvp: 参加費の返金オプ ID は1試合・1人で1つに決まる（B3）", () => {
  const d = duel();
  const refundA = P.pvpFeeRefundOpId(d.code, A.discordId);
  const refundB = P.pvpFeeRefundOpId(d.code, B.discordId);
  assert.notEqual(refundA, refundB);
  assert.notEqual(refundA, d.feeOpIds[0]);
  assert.notEqual(refundA, P.pvpPrizeOpId(d.code));
  assert.equal(refundA, P.pvpFeeRefundOpId(P.pvpDuelCode(A.discordId, B.discordId, NOW), A.discordId));
  // 経済オプ ID の形（8〜64文字の英数・ハイフン）に収まる
  for (const id of [refundA, refundB]) {
    assert.match(id, /^[A-Za-z0-9-]{8,64}$/);
  }
  // 25桁の Discord ID でも64文字に収まる（末6桁だけ使うため）
  const long = P.pvpFeeRefundOpId(d.code, "9".repeat(25));
  assert.match(long, /^[A-Za-z0-9-]{8,64}$/);
});

// ---------- ルート配線（不成立時の参加費精算） ----------

test("pvp: ルートは不成立時に参加費を精算する（B3）", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/pvp/route.ts"), "utf8");
  // マッチ時: 片方の参加費だけ積まれたら決闘を作らず精算する
  // （参加費は submitFee の直接提出。unavailable 時は提出済み側を精算）
  assert.match(route, /settleVoidedFees\(next, \[feeA\?\.op \?\? null, null\]\)/);
  // 直接適用で確定失敗した側は待ちから外して組み直す
  assert.match(route, /feeA\.state === "failed"/);
  assert.match(route, /feeB\.state === "failed"/);
  // paying 失敗時: act / forfeit の両方で決闘を消す前に精算する
  assert.equal(route.match(/await settleVoidedFees\(current, feeStates\);/g)?.length, 2);
  // done は返金、pending は削除してから再読で done なら返金
  assert.match(route, /arena_pvp_fee_refund/);
  assert.match(route, /pvpFeeRefundOpId\(duel\.code, player\.discordId\)/);
  assert.match(route, /await deleteEconomyOp\(state\.id\);/);
  // 参加費は両方そろって初めて確定する（「戻らない」は残っていない）
  assert.doesNotMatch(route, /参加費は戻らない/);
});

// ---------- 交互ターンの決闘 ----------

test("pvp: 攻撃は手番の側だけが打て、命中すれば相手の HP が減る", () => {
  const d = duel();
  // rng: 命中判定 0.5（<0.85 で命中）、ダメージ倍率 0.5（=1.0倍）
  const r = P.pvpStep(d, 0, "attack", rngSeq([0.5, 0.5]));
  assert.equal(r.ok, true);
  assert.equal(r.result.winner, null);
  assert.equal(r.result.duel.hp[1], P.PVP_PLAYER_HP - 12);
  assert.equal(r.result.duel.turn, 1);
  assert.equal(r.result.duel.turnNo, 1);
});

test("pvp: 手番でない側の手は拒否され、決闘は変わらない", () => {
  const d = duel();
  const r = P.pvpStep(d, 1, "attack", rngSeq([0.5, 0.5]));
  assert.equal(r.ok, false);
  assert.equal(r.error, "not_your_turn");
  assert.equal(d.hp[1], P.PVP_PLAYER_HP);
});

test("pvp: 外れれば HP は減らず手番だけが渡る", () => {
  const d = duel();
  const r = P.pvpStep(d, 0, "attack", rngSeq([0.9, 0.5]));
  assert.equal(r.ok, true);
  assert.equal(r.result.duel.hp[1], P.PVP_PLAYER_HP);
  assert.equal(r.result.duel.turn, 1);
});

test("pvp: 強攻撃は命中率が低く威力が高い", () => {
  const d = duel();
  // 命中判定 0.5（<0.6 で命中）、倍率 0.5（=1.0倍）→ 12×1.9=22.8→23
  const r = P.pvpStep(d, 0, "heavy", rngSeq([0.5, 0.5]));
  assert.equal(r.ok, true);
  assert.equal(r.result.duel.hp[1], P.PVP_PLAYER_HP - 23);
  const miss = P.pvpStep(d, 0, "heavy", rngSeq([0.7, 0.5]));
  assert.equal(miss.result.duel.hp[1], P.PVP_PLAYER_HP);
});

test("pvp: まもるは次の被ダメージを半減させ、1回で切れる", () => {
  const d = duel();
  const g = P.pvpStep(d, 0, "guard", rngSeq([0.5, 0.5]));
  assert.equal(g.ok, true);
  assert.equal(g.result.duel.guarding[0], true);
  assert.equal(g.result.duel.turn, 1);
  // 相手の攻撃 16 → 半減 8
  const hit = P.pvpStep(g.result.duel, 1, "attack", rngSeq([0.5, 0.5]));
  assert.equal(hit.result.duel.hp[0], P.PVP_PLAYER_HP - 8);
  assert.equal(hit.result.duel.guarding[0], false);
});

test("pvp: HP が 0 になればその手の勝ちで決着する", () => {
  const d = { ...duel(), hp: [P.PVP_PLAYER_HP, 5] };
  const r = P.pvpStep(d, 0, "attack", rngSeq([0.5, 0.5]));
  assert.equal(r.ok, true);
  assert.equal(r.result.winner, 0);
  assert.equal(r.result.duel.hp[1], 0);
});

// ---------- 期限切れ ----------

test("pvp: 決闘は10分で期限切れになる", () => {
  const d = duel();
  assert.equal(P.duelExpired(d, NOW + P.PVP_DUEL_TTL_MS), false);
  assert.equal(P.duelExpired(d, NOW + P.PVP_DUEL_TTL_MS + 1), true);
});

// ---------- 保存→復元 ----------

test("pvp: 保存→復元の往復で決闘と待ち行列が残り、壊れた値は落とす", () => {
  const d = duel();
  const round = P.parsePvpDuel(JSON.parse(JSON.stringify(d)));
  assert.deepEqual(round, d);
  assert.equal(P.parsePvpDuel({ kind: "arena" }), null);
  assert.equal(P.parsePvpDuel({ ...d, players: [d.players[0]] }), null);
  assert.equal(P.parsePvpDuel(null), null);
  const q = P.parsePvpQueue(JSON.parse(JSON.stringify([A, B])));
  assert.deepEqual(q, [A, B]);
  assert.deepEqual(P.parsePvpQueue([{ discordId: "x" }, null, "nope"]), []);
  assert.deepEqual(P.parsePvpQueue("broken"), []);
});

// ---------- クライアント表示 ----------

test("pvp: クライアント表示は自分の HP・相手の HP・手番だけを出す", () => {
  const d = duel();
  const viewA = P.publicPvpView(d, A.discordId);
  assert.equal(viewA.yourHp, P.PVP_PLAYER_HP);
  assert.equal(viewA.opponentHp, P.PVP_PLAYER_HP);
  assert.equal(viewA.yourTurn, true);
  assert.equal(viewA.fee, P.PVP_FEE);
  assert.equal(viewA.prize, P.PVP_PRIZE);
  assert.equal("opponentDiscordId" in viewA, false);
  assert.equal(JSON.stringify(viewA).includes(B.discordId), false);
  const viewB = P.publicPvpView(d, B.discordId);
  assert.equal(viewB.yourTurn, false);
});
