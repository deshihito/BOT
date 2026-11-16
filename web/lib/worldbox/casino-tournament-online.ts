// カジノ大会の永続化（bot_kv `worldbox_casino_tournament`）。
// 大会は1件だけ（キー "current"）。スコアはカジノルートが gamble オプの
// 確定時に recordCasinoTournamentScore で加える（ベットと配当の実績値）。
// 募集→対局→賞金の進行は lazy に進める（決まった時刻に走る処理は
// 持たない）。内部関数はロックを取らない（呼び出し側が
// withUserLock("casino-tournament") を1回だけ取る。再入すると
// デッドロックするため）。recordCasinoTournamentScore だけが
// カジノルートから呼ばれるロック付きの入口。
import { kvGet, kvSet } from "../bot-api";
import { buildEconomyOp } from "./economy-bridge";
import { enqueueEconomyOpOnce } from "./economy-bridge-online";
import {
  casinoPrizeSplit, casinoTournamentPrizeOpId, casinoTournamentRefundOpId,
  closeCasinoEntry, closeCasinoPlay, recordScore, CASINO_TOURNAMENT_FEE,
  CASINO_TOURNAMENT_PRIZE_REASON, CASINO_TOURNAMENT_REFUND_REASON,
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

/**
 * 1プレイの純益をスコアへ加える（カジノルートの gamble オプ確定時に呼ぶ）。
 * 大会が対局時間中で、遊んだ人が参加者のときだけ加算する。
 * 失敗してもカジノの決済は変えない（ここでは例外を出さない）。
 */
export async function recordCasinoTournamentScore(
  discordId: string, bet: number, payout: number,
): Promise<void> {
  try {
    await withUserLock("casino-tournament", async () => {
      const t = await loadCasinoTournament();
      if (!t) return;
      const before = JSON.stringify(t);
      let out = await advanceCasinoTournamentInner(t, Date.now());
      const scored = recordScore(out, discordId, bet, payout);
      if (scored !== out) out = scored;
      if (JSON.stringify(out) !== before) await saveCasinoTournament(out);
    });
  } catch {
    // スコア記録の失敗はカジノのプレイを壊さない
  }
}

/** 賞金を決定的 ID で積む（1大会・1順位1件。失敗しても大会の決着は変えない）。 */
export async function payCasinoPrizesInner(t: CasinoTournament): Promise<CasinoTournament> {
  if (t.status !== "done" || t.prizesPaid) return t;
  const split = casinoPrizeSplit(t);
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

/** 不成立の返金を決定的 ID で積む（1大会・1人1件）。 */
export async function payCasinoRefundsInner(t: CasinoTournament): Promise<CasinoTournament> {
  if (t.status !== "done" || t.prizesPaid || t.refundPaid) return t;
  if (t.entrants.length >= 2) return t;
  let allPaid = true;
  for (const discordId of t.entrants) {
    const op = buildEconomyOp(
      {
        kind: "earn", userKey: `discord:${discordId}`, discordId,
        amount: CASINO_TOURNAMENT_FEE, reason: CASINO_TOURNAMENT_REFUND_REASON,
      },
      casinoTournamentRefundOpId(t.id, discordId),
      Date.now(),
    );
    if (!op || !(await enqueueEconomyOpOnce(op))) allPaid = false;
  }
  return allPaid ? { ...t, refundPaid: true } : t;
}

/**
 * lazy な進行（募集締め切り・対局終了・賞金/返金の支払い）を1段進める。
 * ロックは取らない。呼び出し側が withUserLock("casino-tournament") で囲うこと。
 */
export async function advanceCasinoTournamentInner(
  t: CasinoTournament, now: number,
): Promise<CasinoTournament> {
  let out = closeCasinoEntry(t, now);
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
