// カジノ大会の永続化（bot_kv `worldbox_casino_tournament`）。
// 大会は1件だけ（キー "current"）。スコアは gamble オプが done に
// 確定してから加える: カジノルートが自分の確定済みオプを
// reconcileCasinoTournamentScores で照合し、対局終了時には
// advanceCasinoTournamentInner が全参加者ぶんを最終精算する
// （登録時点で加えると、後から failed になったオプの純益まで
// 順位に入ってしまうため）。加えたオプは "scored-<大会ID>" に
// 記録して二重に数えない。
// 募集→対局→賞金の進行は lazy に進める（決まった時刻に走る処理は
// 持たない）。内部関数はロックを取らない（呼び出し側が
// withUserLock("casino-tournament") を1回だけ取る。再入すると
// デッドロックするため）。reconcileCasinoTournamentScores だけが
// カジノルートから呼ばれるロック付きの入口。
import { kvGet, kvSet } from "../bot-api";
import { buildEconomyOp, type EconomyOp } from "./economy-bridge";
import { enqueueEconomyOpOnce, findEconomyOp, loadAllEconomyOps } from "./economy-bridge-online";
import {
  casinoPrizeSplit, casinoTournamentFeeOpId, casinoTournamentPrizeOpId,
  casinoTournamentRefundOpId, closeCasinoEntry, closeCasinoPlay, recordScore,
  CASINO_TOURNAMENT_FEE, CASINO_TOURNAMENT_PRIZE_REASON, CASINO_TOURNAMENT_REFUND_REASON,
  parseCasinoTournament, type CasinoTournament,
} from "./casino-tournament";
import { withUserLock } from "./user-lock";

export const WORLDBOX_CASINO_TOURNAMENT_NAMESPACE = "worldbox_casino_tournament";

const CURRENT_KEY = "current";

export async function loadCasinoTournament(): Promise<CasinoTournament | null> {
  const raw = await kvGet(WORLDBOX_CASINO_TOURNAMENT_NAMESPACE, CURRENT_KEY);
  if (typeof raw !== "string" || !raw) return null;
  try {
    return parseCasinoTournament(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveCasinoTournament(t: CasinoTournament): Promise<void> {
  await kvSet(WORLDBOX_CASINO_TOURNAMENT_NAMESPACE, CURRENT_KEY, JSON.stringify(t));
}

// ---------- 参加費オプの照合（闘技場大会と同じ規則） ----------
// failed の参加者は表・賞金・返金から外す。pending / 読み取り不能
// （unknown）は判断を次回へ回す。

type FeeStatus = "done" | "failed" | "pending" | "unknown";

async function casinoFeeStatusOf(t: CasinoTournament, discordId: string): Promise<FeeStatus> {
  const op = await findEconomyOp(`discord:${discordId}`, casinoTournamentFeeOpId(t.id, discordId));
  if (!op) return "unknown";
  return op.status;
}

async function casinoFeeStatusesOf(t: CasinoTournament): Promise<Map<string, FeeStatus>> {
  const statuses = new Map<string, FeeStatus>();
  for (const discordId of t.entrants) {
    statuses.set(discordId, await casinoFeeStatusOf(t, discordId));
  }
  return statuses;
}

/** 募集締め切り時に参加費が failed の参加者を外す（スコアも消す）。 */
async function dropFailedCasinoFeeEntrantsInner(t: CasinoTournament): Promise<CasinoTournament> {
  const statuses = await casinoFeeStatusesOf(t);
  const kept = t.entrants.filter((id) => statuses.get(id) !== "failed");
  if (kept.length === t.entrants.length) return t;
  const scores = { ...t.scores };
  for (const id of t.entrants) {
    if (!kept.includes(id)) delete scores[id];
  }
  return { ...t, entrants: kept, scores };
}

// ---------- スコアの照合（gamble オプの確定後にだけ加える） ----------

const scoredKey = (tournamentId: string) => `scored-${tournamentId}`;

async function loadScoredOpIds(tournamentId: string): Promise<Set<string>> {
  try {
    const raw = await kvGet(WORLDBOX_CASINO_TOURNAMENT_NAMESPACE, scoredKey(tournamentId));
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

async function saveScoredOpIds(tournamentId: string, scored: ReadonlySet<string>): Promise<void> {
  await kvSet(WORLDBOX_CASINO_TOURNAMENT_NAMESPACE, scoredKey(tournamentId), JSON.stringify([...scored]));
}

/** スコアに数える gamble オプの作成時刻の範囲（対局時間の中）。 */
function scoreWindow(t: CasinoTournament): { from: number; to: number } {
  return { from: t.playStartedAt ?? t.entryEndsAt, to: t.playEndsAt };
}

/**
 * 確定済み gamble オプのうち、まだ数えていないものをスコアへ加える。
 * 対局時間中の参加者のオプだけが対象（recordScore が状態と参加を
 * 検証する）。加えたオプは scored へ記録し、二重に数えない。
 * 戻り値: 加算後の大会（変化が無ければ同じ参照）。
 */
async function applyDoneGambleOpsInner(
  t: CasinoTournament, ops: readonly EconomyOp[],
): Promise<CasinoTournament> {
  if (t.status !== "running") return t;
  const { from, to } = scoreWindow(t);
  const candidates = ops.filter(
    (op) =>
      op.kind === "gamble" && op.status === "done" &&
      op.createdAt >= from && op.createdAt <= to &&
      t.entrants.includes(op.discordId),
  );
  if (candidates.length === 0) return t;
  const scored = await loadScoredOpIds(t.id);
  let out = t;
  let changed = false;
  for (const op of candidates) {
    if (scored.has(op.id)) continue;
    scored.add(op.id);
    out = recordScore(out, op.discordId, op.amount, op.payout ?? 0);
    changed = true;
  }
  if (changed) await saveScoredOpIds(t.id, scored);
  return out;
}

/**
 * カジノルートから呼ばれる照合: 自分のオプのうち確定した gamble を
 * スコアへ反映する。対局の進行もここで進める。
 * 失敗してもカジノの決済は変えない（ここでは例外を出さない）。
 */
export async function reconcileCasinoTournamentScores(
  userKey: string, discordId: string, ops: readonly EconomyOp[],
): Promise<void> {
  try {
    await withUserLock("casino-tournament", async () => {
      const t = await loadCasinoTournament();
      if (!t) return;
      const before = JSON.stringify(t);
      let out = await advanceCasinoTournamentInner(t, Date.now());
      const mine = ops.filter((op) => op.userKey === userKey && op.discordId === discordId);
      out = await applyDoneGambleOpsInner(out, mine);
      if (JSON.stringify(out) !== before) await saveCasinoTournament(out);
    });
  } catch {
    // スコア照合の失敗はカジノのプレイを壊さない
  }
}

/**
 * 対局終了時の最終精算: 全参加者の確定済み gamble オプを横断して
 * 数え直す（終了間際のプレイが次回リクエストを待たずに順位へ入る
 * ようにするため）。対局時間中（closeCasinoPlay の直前）に呼ぶこと。
 */
async function sweepCasinoScoresInner(t: CasinoTournament): Promise<CasinoTournament> {
  if (t.status !== "running") return t;
  const ops = await loadAllEconomyOps();
  return applyDoneGambleOpsInner(t, ops);
}

/**
 * 賞金を決定的 ID で積む（1大会・1順位1件。失敗しても大会の決着は変えない）。
 * 順位と原資は参加費が done の参加者だけで数え直す（未払いの参加者は
 * 賞金の対象外で、その分はハウスに残る）。参加費が未確定の間は
 * 支払いを次回へ回す。
 */
export async function payCasinoPrizesInner(t: CasinoTournament): Promise<CasinoTournament> {
  if (t.status !== "done" || t.prizesPaid) return t;
  const statuses = await casinoFeeStatusesOf(t);
  for (const discordId of t.entrants) {
    const s = statuses.get(discordId);
    if (s === "pending" || s === "unknown") return t;
  }
  const paidEntrants = t.entrants.filter((id) => statuses.get(id) === "done");
  const split = casinoPrizeSplit({ ...t, entrants: paidEntrants });
  if (split.length === 0) return { ...t, prizesPaid: true };
  // prizesPaid は全順位ぶん積めたときだけ立てる（同ファイルの返金と同じ規則）。
  let allPaid = true;
  for (const row of split) {
    const op = buildEconomyOp(
      {
        kind: "earn", userKey: `discord:${row.discordId}`, discordId: row.discordId,
        amount: row.amount, reason: CASINO_TOURNAMENT_PRIZE_REASON,
      },
      casinoTournamentPrizeOpId(t.id, row.rank),
      Date.now(),
    );
    if (!op || !(await enqueueEconomyOpOnce(op))) allPaid = false;
  }
  return allPaid ? { ...t, prizesPaid: true } : t;
}

/**
 * 不成立の返金を決定的 ID で積む（1大会・1人1件）。
 * 返金は参加費が done の参加者だけに行う（failed は対象外として確定、
 * pending / unknown が残る間は refundPaid を立てず次回に回す）。
 */
export async function payCasinoRefundsInner(t: CasinoTournament): Promise<CasinoTournament> {
  if (t.status !== "done" || t.prizesPaid || t.refundPaid) return t;
  if (t.entrants.length >= 2) return t;
  const statuses = await casinoFeeStatusesOf(t);
  let allSettled = true;
  for (const discordId of t.entrants) {
    const s = statuses.get(discordId);
    if (s === "failed") continue;
    if (s !== "done") {
      allSettled = false;
      continue;
    }
    const op = buildEconomyOp(
      {
        kind: "earn", userKey: `discord:${discordId}`, discordId,
        amount: CASINO_TOURNAMENT_FEE, reason: CASINO_TOURNAMENT_REFUND_REASON,
      },
      casinoTournamentRefundOpId(t.id, discordId),
      Date.now(),
    );
    if (!op || !(await enqueueEconomyOpOnce(op))) allSettled = false;
  }
  return allSettled ? { ...t, refundPaid: true } : t;
}

/**
 * lazy な進行（募集締め切り・対局終了・賞金/返金の支払い）を1段進める。
 * ロックは取らない。呼び出し側が withUserLock("casino-tournament") で囲うこと。
 * 募集締め切りでは参加費が failed の参加者を外し（残りが2人未満なら
 * その場で不成立にする）、対局終了の直前にはスコアの最終精算を行う。
 */
export async function advanceCasinoTournamentInner(
  t: CasinoTournament, now: number,
): Promise<CasinoTournament> {
  let out = closeCasinoEntry(t, now);
  if (t.status === "entry" && out.status === "running") {
    out = await dropFailedCasinoFeeEntrantsInner(out);
    if (out.entrants.length < 2) out = { ...out, status: "done", closedAt: now };
  }
  if (out.status === "running" && now >= out.playEndsAt) {
    out = await sweepCasinoScoresInner(out);
  }
  out = closeCasinoPlay(out, now);
  if (out.status === "done" && out.closedAt !== null) {
    // 不成立（2人未満）のときだけ返金し、成立した大会は賞金を払う。
    out = out.entrants.length < 2
      ? await payCasinoRefundsInner(out)
      : await payCasinoPrizesInner(out);
  }
  return out;
}

/**
 * 現在の大会を読み、lazy な進行を進めて保存する。GET/POST の入口で呼ぶ。
 * ロックは取らない。呼び出し側が withUserLock("casino-tournament") で囲うこと。
 */
export async function loadCurrentCasinoTournament(now: number): Promise<CasinoTournament | null> {
  const t = await loadCasinoTournament();
  if (!t) return null;
  const before = JSON.stringify(t);
  const out = await advanceCasinoTournamentInner(t, now);
  if (JSON.stringify(out) !== before) await saveCasinoTournament(out);
  return out;
}
