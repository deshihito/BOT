// AGO WORLD BOX のカジノ大会（バッチ7c）。
// 参加費 200 のスコア制大会。募集 30 分のあと 60 分の対局時間があり、
// その間にカジノで遊んだ gamble オプの純益（配当 - ベット）の合計で
// 順位を競う。純益がプラスの上位 3 人が参加費の総額を 50% / 30% / 20%
// で分ける（earn casino_tournament_prize、Plan A の原資ルール内）。
// 2人未満で募集が締め切られた大会は不成立で、参加費は
// earn（casino_tournament_refund）で返す。スコアは gamble オプの
// 記録だけから決まり、Web が残高を直接動かすことはない。
// このファイルは純粋ロジックのみ（乱数は使わない）。

/** 参加費。 */
export const CASINO_TOURNAMENT_FEE = 200;
/** 最大参加人数。 */
export const CASINO_TOURNAMENT_MAX_ENTRANTS = 16;
/** 募集期間（最初の参加から）。 */
export const CASINO_TOURNAMENT_ENTRY_MS = 30 * 60 * 1000;
/** 対局時間（募集締め切りから）。 */
export const CASINO_TOURNAMENT_PLAY_MS = 60 * 60 * 1000;
/** 賞金の earn 理由。 */
export const CASINO_TOURNAMENT_PRIZE_REASON = "casino_tournament_prize";
/** 不成立時の返金の earn 理由。 */
export const CASINO_TOURNAMENT_REFUND_REASON = "casino_tournament_refund";
/** 賞金配分（1位/2位/3位）。端数はハウスに残る。 */
export const CASINO_TOURNAMENT_SHARES = [0.5, 0.3, 0.2] as const;

export type CasinoTournamentStatus = "entry" | "running" | "done";

export interface CasinoTournamentScore {
  /** 賭けた合計。 */
  bet: number;
  /** 配当の合計。 */
  payout: number;
}

export interface CasinoTournament {
  /** `ct-<作成ms>`。 */
  id: string;
  status: CasinoTournamentStatus;
  createdAt: number;
  entryEndsAt: number;
  playEndsAt: number;
  /** 対局開始時刻（募集が締め切って running になった時刻。旧データは null）。
   * スコアに数える gamble オプの作成時刻の下限として使う。 */
  playStartedAt: number | null;
  /** 参加順（同点のとき先に参加した方を上位にする）。 */
  entrants: string[];
  scores: Record<string, CasinoTournamentScore>;
  prizesPaid: boolean;
  refundPaid: boolean;
  closedAt: number | null;
}

export function casinoTournamentId(now: number): string {
  return `ct-${now}`;
}

/** 賞金の総額（参加費の総額）。 */
export function casinoTournamentPrizePool(t: Pick<CasinoTournament, "entrants">): number {
  return t.entrants.length * CASINO_TOURNAMENT_FEE;
}

/** 賞金オプの決定的 ID（1大会・1順位1件）。 */
export function casinoTournamentPrizeOpId(tournamentId: string, rank: number): string {
  return `ct-prize-${tournamentId}-${rank}`;
}

/** 参加費オプの決定的 ID（1大会・1人1件）。 */
export function casinoTournamentFeeOpId(tournamentId: string, discordId: string): string {
  return `ct-fee-${tournamentId}-${discordId}`;
}

/** 不成立時の返金オプの決定的 ID（1大会・1人1件）。 */
export function casinoTournamentRefundOpId(tournamentId: string, discordId: string): string {
  return `ct-refund-${tournamentId}-${discordId}`;
}

/** 1人の純益（配当 - ベット）。 */
export function netScore(score: CasinoTournamentScore): number {
  return score.payout - score.bet;
}

/** 順位表（純益の降順、同点は先に参加した方を上位に）。 */
export function casinoStandings(t: CasinoTournament): { discordId: string; net: number; rank: number }[] {
  return t.entrants
    .map((discordId) => ({
      discordId,
      net: netScore(t.scores[discordId] ?? { bet: 0, payout: 0 }),
    }))
    .sort((a, b) => b.net - a.net || t.entrants.indexOf(a.discordId) - t.entrants.indexOf(b.discordId))
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

/**
 * 賞金の分配。純益がプラスの上位 3 人だけが受け取る（0 以下の順位は
 * 配分なしで、その取り分はハウスに残る）。
 */
export function casinoPrizeSplit(
  t: CasinoTournament,
): { rank: number; discordId: string; amount: number }[] {
  const pool = casinoTournamentPrizePool(t);
  return casinoStandings(t)
    .filter((row) => row.net > 0)
    .slice(0, CASINO_TOURNAMENT_SHARES.length)
    .map((row) => ({
      rank: row.rank,
      discordId: row.discordId,
      amount: Math.floor(pool * CASINO_TOURNAMENT_SHARES[row.rank - 1]),
    }))
    .filter((row) => row.amount >= 1);
}

/** 1プレイの記録を加える（対局時間中の参加者だけ）。 */
export function recordScore(
  t: CasinoTournament, discordId: string, bet: number, payout: number,
): CasinoTournament {
  if (t.status !== "running") return t;
  if (!t.entrants.includes(discordId)) return t;
  const prev = t.scores[discordId] ?? { bet: 0, payout: 0 };
  return {
    ...t,
    scores: { ...t.scores, [discordId]: { bet: prev.bet + bet, payout: prev.payout + payout } },
  };
}

/**
 * 募集の締め切り。募集期間を過ぎるか満員になったら対局時間へ入る。
 * 2人未満なら不成立で終了する（返金は route 側）。
 */
export function closeCasinoEntry(t: CasinoTournament, now: number): CasinoTournament {
  if (t.status !== "entry") return t;
  if (now < t.entryEndsAt && t.entrants.length < CASINO_TOURNAMENT_MAX_ENTRANTS) return t;
  if (t.entrants.length < 2) {
    return { ...t, status: "done", closedAt: now };
  }
  // 対局終了時刻は締め切り時点から数え直す（満員で早期に締め切った場合に
  // 作成時固定の playEndsAt のままだと対局時間が余分に残ってしまう）。
  return { ...t, status: "running", playStartedAt: now, playEndsAt: now + CASINO_TOURNAMENT_PLAY_MS };
}

/** 対局時間の終了（賞金の支払いは route 側）。 */
export function closeCasinoPlay(t: CasinoTournament, now: number): CasinoTournament {
  if (t.status !== "running") return t;
  if (now < t.playEndsAt) return t;
  return { ...t, status: "done", closedAt: now };
}

/** クライアントへ出す表示（他者の Discord ID は出さない）。 */
export function publicCasinoTournamentView(t: CasinoTournament | null, viewerDiscordId: string) {
  if (!t) {
    return {
      status: "none" as const, fee: CASINO_TOURNAMENT_FEE,
      maxEntrants: CASINO_TOURNAMENT_MAX_ENTRANTS,
      entrantCount: 0, entryEndsAt: null as number | null, playEndsAt: null as number | null,
      prizePool: 0, entered: false, myNet: 0, myRank: null as number | null,
      standings: [] as { rank: number; net: number; you: boolean }[],
    };
  }
  const rows = casinoStandings(t);
  const mine = rows.find((r) => r.discordId === viewerDiscordId);
  return {
    status: t.status,
    fee: CASINO_TOURNAMENT_FEE,
    maxEntrants: CASINO_TOURNAMENT_MAX_ENTRANTS,
    entrantCount: t.entrants.length,
    entryEndsAt: t.status === "entry" ? t.entryEndsAt : null,
    playEndsAt: t.status === "running" ? t.playEndsAt : null,
    prizePool: casinoTournamentPrizePool(t),
    entered: t.entrants.includes(viewerDiscordId),
    myNet: mine?.net ?? 0,
    myRank: mine?.rank ?? null,
    standings: rows.slice(0, 5).map((r) => ({
      rank: r.rank, net: r.net, you: r.discordId === viewerDiscordId,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 保存→復元の往復で形を検証する（壊れた値は null）。 */
export function parseCasinoTournament(raw: unknown): CasinoTournament | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || !/^ct-\d+$/.test(raw.id)) return null;
  if (raw.status !== "entry" && raw.status !== "running" && raw.status !== "done") return null;
  if (typeof raw.createdAt !== "number" || typeof raw.entryEndsAt !== "number" || typeof raw.playEndsAt !== "number") return null;
  if (!Array.isArray(raw.entrants) || raw.entrants.some((e) => typeof e !== "string")) return null;
  if (!isRecord(raw.scores)) return null;
  for (const [key, value] of Object.entries(raw.scores)) {
    if (typeof key !== "string" || !isRecord(value)) return null;
    if (typeof value.bet !== "number" || typeof value.payout !== "number") return null;
  }
  if (typeof raw.prizesPaid !== "boolean" || typeof raw.refundPaid !== "boolean") return null;
  if (raw.closedAt !== null && typeof raw.closedAt !== "number") return null;
  const playStartedAt =
    typeof raw.playStartedAt === "number" && Number.isFinite(raw.playStartedAt)
      ? raw.playStartedAt
      : null;
  return { ...(raw as unknown as CasinoTournament), playStartedAt };
}
