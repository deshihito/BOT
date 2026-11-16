// AGO WORLD BOX の闘技場大会（バッチ7c）。
// 参加費 200 のトーナメント。最大8人のシングルエリミネーションで、
// 対戦は既存の PvP 決闘エンジン（pvp.ts）で戦う。大会の対戦は参加費に
// 含まれ、試合ごとの参加費・賞金は無い。優勝者が参加費の総額を
// earn（arena_tournament_prize、Plan A の原資ルール内）で受け取る。
// 参加後の取消はできない。2人未満で募集が締め切られた大会は不成立で、
// 参加費は earn（arena_tournament_refund）で返す。
// このファイルは純粋ロジックのみ（乱数は使わない）。

/** 参加費。 */
export const TOURNAMENT_FEE = 200;
/** 最大参加人数（シングルエリミネーションの上限）。 */
export const TOURNAMENT_MAX_ENTRANTS = 8;
/** 募集期間（最初の参加から）。 */
export const TOURNAMENT_ENTRY_MS = 30 * 60 * 1000;
/** 優勝賞金の earn 理由。 */
export const TOURNAMENT_PRIZE_REASON = "arena_tournament_prize";
/** 不成立時の返金の earn 理由。 */
export const TOURNAMENT_REFUND_REASON = "arena_tournament_refund";

export type TournamentStatus = "entry" | "running" | "done";
export type TournamentMatchState = "pending" | "dueling" | "done";

export interface TournamentMatch {
  /** `m<ラウンド>-<ラウンド内番号>`。 */
  id: string;
  /** 0 = 1回戦。 */
  round: number;
  index: number;
  /** 対戦者の Discord ID（未定は null）。 */
  a: string | null;
  b: string | null;
  winner: string | null;
  /** 進行中の PvP 決闘の ID（無いとき null）。 */
  duelId: string | null;
  state: TournamentMatchState;
}

export interface Tournament {
  /** `t-<作成ms>`。 */
  id: string;
  status: TournamentStatus;
  createdAt: number;
  entryEndsAt: number;
  /** 参加順＝シード順（先に参加した方が上位シード）。 */
  entrants: string[];
  matches: TournamentMatch[];
  champion: string | null;
  prizePaid: boolean;
  refundPaid: boolean;
  closedAt: number | null;
}

export function tournamentId(now: number): string {
  return `t-${now}`;
}

/** 優勝賞金（参加費の総額）。 */
export function tournamentPrizePool(t: Pick<Tournament, "entrants">): number {
  return t.entrants.length * TOURNAMENT_FEE;
}

/** 優勝賞金オプの決定的 ID（1大会1件）。 */
export function tournamentPrizeOpId(tournamentId: string): string {
  return `t-prize-${tournamentId}`;
}

/** 参加費オプの決定的 ID（1大会・1人1件）。Discord ID は末尾4桁でなく全文を使う: 末尾4桁だと他人のオプとキーが衝突し、enqueueEconomyOpOnce の存在確認（userKey 一致）を通り抜けて kvSet で上書きしてしまう。 */
export function tournamentFeeOpId(tournamentId: string, discordId: string): string {
  return `t-fee-${tournamentId}-${discordId}`;
}

/** 不成立時の返金オプの決定的 ID（1大会・1人1件）。 */
export function tournamentRefundOpId(tournamentId: string, discordId: string): string {
  return `t-refund-${tournamentId}-${discordId}`;
}

/** トーナメント表の段数（2/4/8 人用）。 */
function bracketRounds(size: number): number {
  return size === 2 ? 1 : size === 4 ? 2 : 3;
}

/** 標準的なシード配置（上位シード同士が決勝まで当たらない並び）。 */
function bracketOrder(size: number): number[] {
  if (size === 2) return [0, 1];
  if (size === 4) return [0, 3, 1, 2];
  return [0, 7, 3, 4, 1, 6, 2, 5];
}

function matchId(round: number, index: number): string {
  return `m${round}-${index}`;
}

/**
 * トーナメント表を作る。参加人数を上回る枠は空き（bye）で、上位シードが
 * 不戦勝で次ラウンドへ進む。不戦勝の勝者は作表時に次ラウンドへ送る。
 */
export function buildBracket(entrants: readonly string[]): TournamentMatch[] {
  const size = entrants.length <= 2 ? 2 : entrants.length <= 4 ? 4 : 8;
  const rounds = bracketRounds(size);
  const order = bracketOrder(size);
  const matches: TournamentMatch[] = [];
  for (let r = 0; r < rounds; r++) {
    const count = size >> (r + 1);
    for (let i = 0; i < count; i++) {
      matches.push({
        id: matchId(r, i), round: r, index: i,
        a: null, b: null, winner: null, duelId: null, state: "pending",
      });
    }
  }
  const at = (round: number, index: number): TournamentMatch => matches.find((m) => m.round === round && m.index === index)!;
  for (let i = 0; i < size / 2; i++) {
    const m = at(0, i);
    m.a = order[i * 2] < entrants.length ? entrants[order[i * 2]] : null;
    m.b = order[i * 2 + 1] < entrants.length ? entrants[order[i * 2 + 1]] : null;
    if (m.a && !m.b) {
      m.winner = m.a;
      m.state = "done";
      propagateWinner(matches, rounds, m);
    }
  }
  return matches;
}

/** 勝者を次ラウンドの空き枠へ送る（決勝の勝者はここでは送らない）。 */
function propagateWinner(
  matches: TournamentMatch[], rounds: number, m: TournamentMatch,
): void {
  if (!m.winner) return;
  if (m.round >= rounds - 1) return;
  const next = matches.find((x) => x.round === m.round + 1 && x.index === Math.floor(m.index / 2));
  if (!next) return;
  if (m.index % 2 === 0) next.a = m.winner;
  else next.b = m.winner;
}

/**
 * 1試合の勝者を決める。勝者は次ラウンドへ送られ、決勝なら優勝者が決まる。
 * 対象外（試合が無い・決着済み・勝者が対戦者でない）は null。
 */
export function advanceMatch(
  t: Tournament, matchIdValue: string, winnerDiscordId: string, now: number,
): Tournament | null {
  const m = t.matches.find((x) => x.id === matchIdValue);
  if (!m || m.state === "done") return null;
  if (m.a !== winnerDiscordId && m.b !== winnerDiscordId) return null;
  const matches = t.matches.map((x) =>
    x.id === m.id ? { ...x, winner: winnerDiscordId, state: "done" as const } : { ...x },
  );
  const rounds = bracketRounds(t.entrants.length <= 2 ? 2 : t.entrants.length <= 4 ? 4 : 8);
  const done = matches.find((x) => x.id === m.id)!;
  propagateWinner(matches, rounds, done);
  const out: Tournament = { ...t, matches };
  const final = matches.find((x) => x.round === rounds - 1 && x.index === 0);
  if (final?.state === "done" && final.winner) {
    out.champion = final.winner;
    out.status = "done";
    out.closedAt = now;
  }
  return out;
}

/** 対戦者が揃い、決闘がまだ始まっていない試合。 */
export function readyMatches(t: Tournament): TournamentMatch[] {
  return t.matches.filter((m) => m.state === "pending" && m.a && m.b && !m.duelId);
}

/**
 * 決闘が期限切れで消えた試合の勝者。決闘の記録が残っていないため、
 * シード上位（先に参加した方）が進出する。
 */
export function timeoutWinner(t: Tournament, m: TournamentMatch): string | null {
  if (!m.a || !m.b) return m.a ?? m.b;
  return t.entrants.indexOf(m.a) <= t.entrants.indexOf(m.b) ? m.a : m.b;
}

/**
 * 募集の締め切り。募集期間を過ぎるか満員になったら表を作って開始する。
 * 2人未満なら不成立で終了する（返金は route 側）。
 */
export function closeEntry(t: Tournament, now: number): Tournament {
  if (t.status !== "entry") return t;
  if (now < t.entryEndsAt && t.entrants.length < TOURNAMENT_MAX_ENTRANTS) return t;
  if (t.entrants.length < 2) {
    return { ...t, status: "done", closedAt: now };
  }
  return { ...t, status: "running", matches: buildBracket(t.entrants) };
}

/** クライアントへ出す表示（他者の Discord ID は出さない）。 */
export function publicTournamentView(t: Tournament | null, viewerDiscordId: string) {
  if (!t) {
    return {
      status: "none" as const, fee: TOURNAMENT_FEE, maxEntrants: TOURNAMENT_MAX_ENTRANTS,
      entrantCount: 0, entryEndsAt: null as number | null, prizePool: 0,
      entered: false, champion: null as "you" | "decided" | null,
      myMatch: null as { round: number; state: TournamentMatchState; won: boolean | null } | null,
      decidedMatches: 0, totalMatches: 0,
    };
  }
  const mine = t.matches.filter((m) => m.a === viewerDiscordId || m.b === viewerDiscordId);
  const myMatch = mine.length > 0
    ? mine.reduce((best, m) => (m.round > best.round ? m : best))
    : undefined;
  return {
    status: t.status,
    fee: TOURNAMENT_FEE,
    maxEntrants: TOURNAMENT_MAX_ENTRANTS,
    entrantCount: t.entrants.length,
    entryEndsAt: t.status === "entry" ? t.entryEndsAt : null,
    prizePool: tournamentPrizePool(t),
    entered: t.entrants.includes(viewerDiscordId),
    champion: t.champion === null ? null : t.champion === viewerDiscordId ? "you" : "decided",
    myMatch: myMatch
      ? {
          round: myMatch.round,
          state: myMatch.state,
          won: myMatch.state === "done" ? myMatch.winner === viewerDiscordId : null,
        }
      : null,
    decidedMatches: t.matches.filter((m) => m.state === "done").length,
    totalMatches: t.matches.length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 保存→復元の往復で形を検証する（壊れた値は null）。 */
export function parseTournament(raw: unknown): Tournament | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || !/^t-\d+$/.test(raw.id)) return null;
  if (raw.status !== "entry" && raw.status !== "running" && raw.status !== "done") return null;
  if (typeof raw.createdAt !== "number" || typeof raw.entryEndsAt !== "number") return null;
  if (!Array.isArray(raw.entrants) || raw.entrants.some((e) => typeof e !== "string")) return null;
  if (!Array.isArray(raw.matches)) return null;
  const matches: TournamentMatch[] = [];
  for (const item of raw.matches as unknown[]) {
    if (!isRecord(item)) return null;
    if (typeof item.id !== "string" || typeof item.round !== "number" || typeof item.index !== "number") return null;
    if (item.a !== null && typeof item.a !== "string") return null;
    if (item.b !== null && typeof item.b !== "string") return null;
    if (item.winner !== null && typeof item.winner !== "string") return null;
    if (item.duelId !== null && typeof item.duelId !== "string") return null;
    if (item.state !== "pending" && item.state !== "dueling" && item.state !== "done") return null;
    matches.push(item as unknown as TournamentMatch);
  }
  if (raw.champion !== null && typeof raw.champion !== "string") return null;
  if (typeof raw.prizePaid !== "boolean" || typeof raw.refundPaid !== "boolean") return null;
  if (raw.closedAt !== null && typeof raw.closedAt !== "number") return null;
  return raw as unknown as Tournament;
}
