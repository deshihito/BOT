// 闘技場大会の永続化（bot_kv `worldbox_tournament`）。
// 大会は1件だけ（キー "current"）。募集→対戦→優勝の進行は
// lazy に進める（決まった時刻に走る処理は持たない）。
// 対戦は既存の PvP 決闘（worldbox_pvp）に作り、決着は pvp ルートが
// advanceTournamentMatch でここへ返す。決闘が期限切れで消えた試合は
// シード上位の進出で決着させる（tournament.ts の timeoutWinner）。
// 内部関数はロックを取らない（呼び出し側が withUserLock("tournament")
// を1回だけ取る。再入するとデッドロックするため）。
import { kvGet, kvSet } from "../bot-api";
import { playerAttack } from "./arena";
import { buildEconomyOp } from "./economy-bridge";
import { enqueueEconomyOpOnce, findEconomyOp } from "./economy-bridge-online";
import { loadProfile } from "./profile-online";
import {
  advanceMatch, closeEntry, readyMatches, timeoutWinner, tournamentFeeOpId, tournamentPrizeOpId,
  tournamentRefundOpId, TOURNAMENT_FEE, TOURNAMENT_MAX_ENTRANTS, TOURNAMENT_PRIZE_REASON,
  TOURNAMENT_REFUND_REASON, parseTournament, type Tournament,
} from "./tournament";
import { createTournamentDuel } from "./pvp";
import { loadMyPvpDuel, loadPvpDuel, savePvpDuel } from "./pvp-online";
import { withUserLock } from "./user-lock";

export const WORLDBOX_TOURNAMENT_NAMESPACE = "worldbox_tournament";

const CURRENT_KEY = "current";

export async function loadTournament(): Promise<Tournament | null> {
  const raw = await kvGet(WORLDBOX_TOURNAMENT_NAMESPACE, CURRENT_KEY);
  if (typeof raw !== "string" || !raw) return null;
  try {
    return parseTournament(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveTournament(t: Tournament): Promise<void> {
  await kvSet(WORLDBOX_TOURNAMENT_NAMESPACE, CURRENT_KEY, JSON.stringify(t));
}

/** 参加者の攻撃力（決闘の作成に使う。所有者キーは `discord:<id>`）。 */
export async function attackOf(discordId: string): Promise<number> {
  const profile = await loadProfile(`discord:${discordId}`);
  // 剣の強化レベルも攻撃力に含める（PvP / アリーナと同じ計算に揃える）
  return playerAttack(profile.items, profile.enhance);
}

// ---------- 参加費オプの照合 ----------
// 参加は参加費オプを積んだ時点で登録されるため、オプが後から failed に
// なると無料参加になりうる。進行・確定の各時点で決定的 ID のオプを
// 照合し、failed の参加者は表・賞金・返金から外す。pending / 読み取り
// 不能（unknown）は「まだ確定していない」として判断を次回へ回す
// （払った人を誤って外さないため）。

type FeeStatus = "done" | "failed" | "pending" | "unknown";

async function feeStatusOf(t: Tournament, discordId: string): Promise<FeeStatus> {
  const op = await findEconomyOp(`discord:${discordId}`, tournamentFeeOpId(t.id, discordId));
  if (!op) return "unknown";
  return op.status;
}

async function feeStatusesOf(t: Tournament): Promise<Map<string, FeeStatus>> {
  const statuses = new Map<string, FeeStatus>();
  for (const discordId of t.entrants) {
    statuses.set(discordId, await feeStatusOf(t, discordId));
  }
  return statuses;
}

/** 対戦者が揃った試合に決闘を作る（どちらかが他の決闘中なら後回し）。 */
export async function startReadyMatchesInner(t: Tournament): Promise<Tournament> {
  if (t.status !== "running") return t;
  const now = Date.now();
  let out = t;
  for (const m of readyMatches(out)) {
    const busyA = await loadMyPvpDuel(`discord:${m.a}`);
    const busyB = await loadMyPvpDuel(`discord:${m.b}`);
    if (busyA || busyB) continue;
    const duel = createTournamentDuel(
      { ownerKey: `discord:${m.a}`, discordId: m.a!, attack: await attackOf(m.a!), queuedAt: now },
      { ownerKey: `discord:${m.b}`, discordId: m.b!, attack: await attackOf(m.b!), queuedAt: now },
      now, out.id, m.id,
    );
    await savePvpDuel(duel);
    out = {
      ...out,
      matches: out.matches.map((x) =>
        x.id === m.id ? { ...x, duelId: duel.id, state: "dueling" as const } : x,
      ),
    };
  }
  return out;
}

/** 決闘が期限切れで消えた試合をシード上位の進出で決着させる。 */
export async function settleExpiredMatchesInner(
  t: Tournament,
): Promise<{ tournament: Tournament; changed: boolean }> {
  if (t.status !== "running") return { tournament: t, changed: false };
  const now = Date.now();
  let out = t;
  let changed = false;
  for (const m of out.matches.filter((x) => x.state === "dueling" && x.duelId)) {
    const duel = await loadPvpDuel(m.duelId!);
    if (duel) continue;
    const winner = timeoutWinner(out, m);
    if (!winner) continue;
    const advanced = advanceMatch(out, m.id, winner, now);
    if (!advanced) continue;
    out = advanced;
    changed = true;
  }
  if (changed) out = await startReadyMatchesInner(out);
  return { tournament: out, changed };
}

/**
 * 優勝賞金を決定的 ID で積む（1大会1件。失敗しても大会の決着は変えない）。
 * 賞金の原資は参加費が done の参加者分だけ数える。全員の参加費が
 * 終端するまで支払いは次回へ回し、優勝者自身の参加費が failed なら
 * 賞金は出さずに終端する（払っていない優勝は無い）。
 */
export async function payChampionPrizeInner(t: Tournament): Promise<Tournament> {
  if (t.status !== "done" || !t.champion || t.prizePaid) return t;
  const statuses = await feeStatusesOf(t);
  for (const discordId of t.entrants) {
    const s = statuses.get(discordId);
    if (s === "pending" || s === "unknown") return t;
  }
  if (statuses.get(t.champion) !== "done") return { ...t, prizePaid: true };
  const paidCount = t.entrants.filter((id) => statuses.get(id) === "done").length;
  const op = buildEconomyOp(
    {
      kind: "earn", userKey: `discord:${t.champion}`, discordId: t.champion,
      amount: paidCount * TOURNAMENT_FEE, reason: TOURNAMENT_PRIZE_REASON,
    },
    tournamentPrizeOpId(t.id),
    Date.now(),
  );
  if (!op) return t;
  if (await enqueueEconomyOpOnce(op)) return { ...t, prizePaid: true };
  return t;
}

/**
 * 不成立の返金を決定的 ID で積む（1大会・1人1件）。
 * 返金は参加費が done の参加者だけに行う。failed の参加者は払って
 * いないので対象外（確定として扱う）。pending / unknown が残る間は
 * refundPaid を立てず、次回の進行で照合からやり直す。
 */
export async function payRefundsInner(t: Tournament): Promise<Tournament> {
  if (t.status !== "done" || t.champion || t.refundPaid) return t;
  // refundPaid は全員ぶん決着したときだけ立てる。1件でも未確定なら
  // フラグを立てず、次回の進行で決定的 ID の冪等登録により再試行する
  // （成功済みの人へは二重に積まれない）。
  const statuses = await feeStatusesOf(t);
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
        amount: TOURNAMENT_FEE, reason: TOURNAMENT_REFUND_REASON,
      },
      tournamentRefundOpId(t.id, discordId),
      Date.now(),
    );
    if (!op || !(await enqueueEconomyOpOnce(op))) allSettled = false;
  }
  return allSettled ? { ...t, refundPaid: true } : t;
}

/**
 * 募集の締め切り（表の作成・不成立の返金まで）。ロックは取らない。
 * 呼び出し側が withUserLock("tournament") で囲うこと。
 * 締め切りの時点で参加費が failed の参加者は表から外す（締め切り後
 * に failed が判明した分は、賞金・返金の照合で対象外にする）。
 */
export async function closeEntryInner(t: Tournament, now: number): Promise<Tournament> {
  let verified = t;
  if (
    t.status === "entry" &&
    (now >= t.entryEndsAt || t.entrants.length >= TOURNAMENT_MAX_ENTRANTS)
  ) {
    const statuses = await feeStatusesOf(t);
    const kept = t.entrants.filter((id) => statuses.get(id) !== "failed");
    if (kept.length !== t.entrants.length) verified = { ...t, entrants: kept };
  }
  const closed = closeEntry(verified, now);
  if (closed === verified && verified === t) return t;
  let out = closed;
  if (out.status === "done") out = await payRefundsInner(out);
  if (out.status === "running") out = await startReadyMatchesInner(out);
  return out;
}

/**
 * 現在の大会を読み、lazy な進行（募集締め切り・期限切れ試合の決着・
 * 優勝賞金の支払い）を進めて保存する。GET/POST の入口で呼ぶ。
 * ロックは取らない。呼び出し側が withUserLock("tournament") で囲うこと。
 */
export async function loadCurrentTournament(now: number): Promise<Tournament | null> {
  const t = await loadTournament();
  if (!t) return null;
  const before = JSON.stringify(t);
  let out = await closeEntryInner(t, now);
  out = (await settleExpiredMatchesInner(out)).tournament;
  out = await payChampionPrizeInner(out);
  if (JSON.stringify(out) !== before) await saveTournament(out);
  return out;
}

/**
 * PvP 決闘の決着を大会へ返す（pvp ルートから呼ぶ）。
 * 決闘が消える前に進めるため、呼び出しは clearPvpDuel より先に行うこと。
 */
export async function advanceTournamentMatch(
  tournamentId: string, matchId: string, winnerDiscordId: string,
): Promise<void> {
  await withUserLock("tournament", async () => {
    const t = await loadTournament();
    if (!t || t.id !== tournamentId) return;
    const advanced = advanceMatch(t, matchId, winnerDiscordId, Date.now());
    if (!advanced) return;
    let out = await startReadyMatchesInner(advanced);
    out = await payChampionPrizeInner(out);
    await saveTournament(out);
  });
}
