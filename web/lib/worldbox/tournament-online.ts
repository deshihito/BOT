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
import { enqueueEconomyOpOnce } from "./economy-bridge-online";
import { loadProfile } from "./profile-online";
import {
  advanceMatch, closeEntry, readyMatches, timeoutWinner, tournamentPrizeOpId, tournamentPrizePool,
  tournamentRefundOpId, TOURNAMENT_FEE, TOURNAMENT_PRIZE_REASON, TOURNAMENT_REFUND_REASON,
  parseTournament, type Tournament,
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
  return playerAttack(profile.items);
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

/** 優勝賞金を決定的 ID で積む（1大会1件。失敗しても大会の決着は変えない）。 */
export async function payChampionPrizeInner(t: Tournament): Promise<Tournament> {
  if (t.status !== "done" || !t.champion || t.prizePaid) return t;
  const op = buildEconomyOp(
    {
      kind: "earn", userKey: `discord:${t.champion}`, discordId: t.champion,
      amount: tournamentPrizePool(t), reason: TOURNAMENT_PRIZE_REASON,
    },
    tournamentPrizeOpId(t.id),
    Date.now(),
  );
  if (!op) return t;
  if (await enqueueEconomyOpOnce(op)) return { ...t, prizePaid: true };
  return t;
}

/** 不成立の返金を決定的 ID で積む（1大会・1人1件）。 */
export async function payRefundsInner(t: Tournament): Promise<Tournament> {
  if (t.status !== "done" || t.champion || t.refundPaid) return t;
  // refundPaid は全員ぶん積めたときだけ立てる。1件でも失敗したら
  // フラグを立てず、次回の進行で決定的 ID の冪等登録により再試行する
  // （成功済みの人へは二重に積まれない）。
  let allPaid = true;
  for (const discordId of t.entrants) {
    const op = buildEconomyOp(
      {
        kind: "earn", userKey: `discord:${discordId}`, discordId,
        amount: TOURNAMENT_FEE, reason: TOURNAMENT_REFUND_REASON,
      },
      tournamentRefundOpId(t.id, discordId),
      Date.now(),
    );
    if (!op || !(await enqueueEconomyOpOnce(op))) allPaid = false;
  }
  return allPaid ? { ...t, refundPaid: true } : t;
}

/**
 * 募集の締め切り（表の作成・不成立の返金まで）。ロックは取らない。
 * 呼び出し側が withUserLock("tournament") で囲うこと。
 */
export async function closeEntryInner(t: Tournament, now: number): Promise<Tournament> {
  const closed = closeEntry(t, now);
  if (closed === t) return t;
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
