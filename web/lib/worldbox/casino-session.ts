// WORLD BOX カジノのセッション状態（純粋型と整形）。
// セッションはユーザーごとに最大1つ（原典ギャンブルと同じ）。
// お金はセッション開始時に spend オプで先払いし、終了時に prepaid の
// gamble オプ1件で精算する。精算オプは先払いオプが done になるまで作らない
// （先払いが失敗したセッションは無効化され、配当もペナルティも発生しない）。
import type { BjState } from "../games/blackjack";
import { cleanCasinoUserState, type CasinoUserState, type DoubleSessionState } from "./casino-games";

export type CasinoSession =
  | {
      kind: "slot7";
      bet: number;
      total: number;
      remaining: number;
      prepayOpId: string;
      /** 集計中の払い戻し・ペナルティ（精算オプはセッション終了時に1件だけ）。 */
      pendingReward: number;
      pendingPenalty: number;
      lastReels: number[] | null;
      lastEvents: string[];
      createdAt: number;
    }
  | {
      kind: "double";
      bet: number;
      multiplier: number;
      streak: number;
      prepayOpId: string;
      /** バースト済み（精算オプの作成待ち）か。 */
      busted?: boolean;
      createdAt: number;
    }
  | {
      kind: "blackjack";
      bet: number;
      /** 先払い spend オプ（ダブルダウン時は2件目が増える）。 */
      spendOpIds: string[];
      bj: BjState;
      createdAt: number;
    };

/** セッションの有効期限。これを超えたら次回アクセス時に精算/返金して閉じる。 */
export const CASINO_SESSION_TTL_MS = 30 * 60 * 1000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function posInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/** 保存値からセッションを復元する（壊れた値は null）。 */
export function cleanCasinoSession(raw: unknown): CasinoSession | null {
  if (!isRecord(raw)) return null;
  const createdAt = typeof raw.createdAt === "number" && raw.createdAt > 0 ? raw.createdAt : 0;
  if (!createdAt) return null;
  if (raw.kind === "slot7") {
    const bet = posInt(raw.bet);
    const total = posInt(raw.total);
    const remaining = typeof raw.remaining === "number" && raw.remaining >= 0 ? Math.floor(raw.remaining) : null;
    if (!bet || !total || remaining === null || typeof raw.prepayOpId !== "string") return null;
    return {
      kind: "slot7",
      bet,
      total,
      remaining,
      prepayOpId: raw.prepayOpId,
      pendingReward: typeof raw.pendingReward === "number" && raw.pendingReward > 0 ? Math.floor(raw.pendingReward) : 0,
      pendingPenalty: typeof raw.pendingPenalty === "number" && raw.pendingPenalty > 0 ? Math.floor(raw.pendingPenalty) : 0,
      lastReels: Array.isArray(raw.lastReels) ? raw.lastReels.filter((n): n is number => typeof n === "number") : null,
      lastEvents: Array.isArray(raw.lastEvents) ? raw.lastEvents.filter((s): s is string => typeof s === "string") : [],
      createdAt,
    };
  }
  if (raw.kind === "double") {
    const bet = posInt(raw.bet);
    if (!bet || typeof raw.prepayOpId !== "string") return null;
    const session: DoubleSessionState = {
      bet,
      multiplier: typeof raw.multiplier === "number" && raw.multiplier >= 1 ? raw.multiplier : 1,
      streak: typeof raw.streak === "number" && raw.streak >= 0 ? Math.floor(raw.streak) : 0,
    };
    return {
      kind: "double", ...session, prepayOpId: raw.prepayOpId, createdAt,
      ...(raw.busted === true ? { busted: true } : {}),
    };
  }
  if (raw.kind === "blackjack") {
    const bet = posInt(raw.bet);
    if (!bet || !Array.isArray(raw.spendOpIds) || !isRecord(raw.bj)) return null;
    const spendOpIds = raw.spendOpIds.filter((s): s is string => typeof s === "string");
    if (spendOpIds.length === 0) return null;
    return { kind: "blackjack", bet, spendOpIds, bj: raw.bj as unknown as BjState, createdAt };
  }
  return null;
}

/** クライアントへ見せるセッション形（ブラックジャックのディーラー伏せ札と山札は隠す）。 */
export function publicSessionView(session: CasinoSession): Record<string, unknown> {
  if (session.kind === "slot7") {
    return {
      kind: "slot7",
      bet: session.bet,
      total: session.total,
      remaining: session.remaining,
      pendingReward: session.pendingReward,
      pendingPenalty: session.pendingPenalty,
      lastReels: session.lastReels,
      lastEvents: session.lastEvents,
    };
  }
  if (session.kind === "double") {
    return {
      kind: "double",
      bet: session.bet,
      multiplier: session.multiplier,
      streak: session.streak,
      currentValue: Math.floor(session.bet * session.multiplier),
      busted: session.busted === true,
    };
  }
  const bj = session.bj;
  const inPlay = bj.phase === "player";
  return {
    kind: "blackjack",
    bet: session.bet,
    totalBet: bj.bet,
    doubled: bj.doubled,
    playerHand: bj.playerHand,
    dealerHand: inPlay ? bj.dealerHand.slice(0, 1) : bj.dealerHand,
    dealerHidden: inPlay,
    phase: bj.phase,
    outcome: bj.result?.outcome ?? null,
  };
}

export function publicUserStateView(state: CasinoUserState): Record<string, unknown> {
  return {
    kakuhen: state.kakuhen,
    internalMode: state.internalMode,
  };
}

export { cleanCasinoUserState };
export type { CasinoUserState };
