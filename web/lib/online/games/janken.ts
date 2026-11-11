// じゃんけん大会（オンライン対戦）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / tick / onPlayerLeft は純関数。
// 流れ: choosing（15秒・全員提出か時間切れで締切）→ reveal（4秒・開示）→ 次のラウンド。全5ラウンド。
// 多人数じゃんけんの勝敗: 出た手が2種類だけのとき、その2種のうち勝つ手を出した全員に1点。
// 出た手が1種類または3種類のときは、あいこ（引き分け）で誰にも点は入らない。
// 時間切れで未提出の人はそのラウンド不参加（0点）。手は締切まで viewFor で秘匿する。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type JankenHand = "rock" | "scissors" | "paper";
export type JankenPhase = "choosing" | "reveal" | "finished";

export const JK_TOTAL_ROUNDS = 5;
export const JK_TIME_LIMIT_MS = 15000;
export const JK_REVEAL_MS = 4000;

export const JK_HANDS: JankenHand[] = ["rock", "scissors", "paper"];

/** BEATS[a] は a が勝つ手。 */
export const JK_BEATS: Record<JankenHand, JankenHand> = {
  rock: "scissors",
  scissors: "paper",
  paper: "rock",
};

export function isJankenHand(value: unknown): value is JankenHand {
  return value === "rock" || value === "scissors" || value === "paper";
}

export type JankenThrow = { seat: number; hand: JankenHand };

export type JankenHistoryEntry = {
  round: number;
  /** 全プレイヤー分。未提出・退出済みは null。 */
  hands: { seat: number; hand: JankenHand | null }[];
  /** そのラウンドで点を得た seat。 */
  winners: number[];
};

export interface JankenState {
  players: { seat: number; name: string }[];
  leftSeats: number[];
  round: number;
  totalRounds: number;
  phase: JankenPhase;
  roundEndsAt: number | null;
  revealEndsAt: number | null;
  /** 内部のみ。締切まで viewFor で秘匿する。 */
  throws: JankenThrow[];
  scores: Record<number, number>;
  history: JankenHistoryEntry[];
}

export type JankenAction = { type: "throw"; hand: JankenHand };

export interface JankenViewPlayer {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  submitted: boolean;
  /** reveal / finished（直近ラウンド分）でのみ開示される手。それ以外はキー自体なし。 */
  hand?: JankenHand | null;
  /** reveal / finished（直近ラウンド分）で点を得たかどうか。 */
  won?: boolean;
}

export interface JankenView {
  phase: JankenPhase;
  round: number;
  totalRounds: number;
  roundEndsAt: number | null;
  revealEndsAt: number | null;
  you: { seat: number; submitted: boolean; yourHand: JankenHand | null; left: boolean };
  players: JankenViewPlayer[];
  history: JankenHistoryEntry[];
  standings: { seat: number; score: number; rank: number }[] | null;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function playerOf(state: JankenState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function activeSeats(state: JankenState): number[] {
  return state.players.filter((p) => !state.leftSeats.includes(p.seat)).map((p) => p.seat);
}

/**
 * 多人数じゃんけんの勝者 seat を決める純関数。
 * 提出された手が2種類だけなら勝つ手の全員が勝者。それ以外（1種・3種・提出なし）は空（あいこ）。
 */
export function jankenWinners(throwsIn: JankenThrow[]): number[] {
  const kinds = [...new Set(throwsIn.map((t) => t.hand))];
  if (kinds.length !== 2) return [];
  const [a, b] = kinds;
  const winningHand = JK_BEATS[a] === b ? a : b;
  return throwsIn.filter((t) => t.hand === winningHand).map((t) => t.seat);
}

/** 現在のラウンドを締め切り、採点して reveal へ移す（draft を破壊的に更新）。 */
function closeRound(draft: JankenState, now: number): void {
  const winners = jankenWinners(draft.throws);
  for (const seat of winners) {
    draft.scores[seat] = (draft.scores[seat] ?? 0) + 1;
  }
  draft.history.push({
    round: draft.round,
    hands: draft.players.map((p) => {
      const t = draft.throws.find((x) => x.seat === p.seat);
      return { seat: p.seat, hand: t && !draft.leftSeats.includes(p.seat) ? t.hand : null };
    }),
    winners,
  });
  draft.throws = [];
  draft.phase = "reveal";
  draft.roundEndsAt = null;
  draft.revealEndsAt = now + JK_REVEAL_MS;
}

/** reveal を終えて次のラウンドへ進む（draft を破壊的に更新）。 */
function advance(draft: JankenState, now: number): void {
  const next = draft.round + 1;
  draft.revealEndsAt = null;
  if (next >= draft.totalRounds) {
    draft.round = next;
    draft.phase = "finished";
    return;
  }
  draft.round = next;
  draft.phase = "choosing";
  draft.roundEndsAt = now + JK_TIME_LIMIT_MS;
}

/** 全員（脱落を除く）が提出済みなら即締切する。 */
function closeIfAllThrown(draft: JankenState, now: number): void {
  if (draft.phase !== "choosing") return;
  const active = activeSeats(draft);
  if (active.length === 0) return;
  if (active.every((s) => draft.throws.some((t) => t.seat === s))) closeRound(draft, now);
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): JankenState {
  void rng;
  if (!Array.isArray(players) || players.length < 2 || players.length > 8) {
    throw new Error("じゃんけん大会は2〜8人で遊ぶゲームです");
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const scores: Record<number, number> = {};
  for (const p of sorted) scores[p.seat] = 0;
  return {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    leftSeats: [],
    round: 0,
    totalRounds: JK_TOTAL_ROUNDS,
    phase: "choosing",
    roundEndsAt: Date.now() + JK_TIME_LIMIT_MS,
    revealEndsAt: null,
    throws: [],
    scores,
    history: [],
  };
}

function applyAction(state: JankenState, seat: number, action: JankenAction, _rng: Rng): JankenState {
  if (!action || typeof action !== "object" || (action as { type?: unknown }).type !== "throw") {
    throw new Error("不明なアクションです");
  }
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");
  if (state.phase !== "choosing") throw new Error("今は手を出せません");
  if (state.leftSeats.includes(seat)) throw new Error("退出したプレイヤーは手を出せません");
  const hand = (action as { hand?: unknown }).hand;
  if (!isJankenHand(hand)) throw new Error("手が不正です");
  if (state.throws.some((t) => t.seat === seat)) throw new Error("すでに出しています");

  const now = Date.now();
  if (state.roundEndsAt !== null && now > state.roundEndsAt) {
    throw new Error("制限時間を過ぎています");
  }
  const draft = clone(state);
  draft.throws.push({ seat, hand });
  closeIfAllThrown(draft, now);
  return draft;
}

function viewFor(state: JankenState, seat: number): JankenView {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  const finished = state.phase === "finished";
  const revealing = state.phase === "reveal" || finished;
  const lastHistory = state.history[state.history.length - 1];
  const revealForCurrent = revealing && lastHistory && lastHistory.round === (finished ? state.totalRounds - 1 : state.round);

  const players: JankenViewPlayer[] = state.players.map((p) => {
    const entry: JankenViewPlayer = {
      seat: p.seat,
      name: p.name,
      score: state.scores[p.seat] ?? 0,
      left: state.leftSeats.includes(p.seat),
      submitted:
        state.throws.some((t) => t.seat === p.seat) ||
        (revealForCurrent && lastHistory ? lastHistory.hands.some((h) => h.seat === p.seat && h.hand !== null) : false),
    };
    if (revealForCurrent && lastHistory) {
      const h = lastHistory.hands.find((x) => x.seat === p.seat);
      if (h) {
        entry.hand = h.hand;
        entry.won = lastHistory.winners.includes(p.seat);
      }
    }
    return entry;
  });

  const myThrow = state.throws.find((t) => t.seat === seat);
  let yourHand: JankenHand | null = myThrow ? myThrow.hand : null;
  if (yourHand === null && revealForCurrent && lastHistory) {
    const h = lastHistory.hands.find((x) => x.seat === seat);
    if (h) yourHand = h.hand;
  }

  let standings: JankenView["standings"] = null;
  if (finished) {
    const sorted = [...state.players].sort((a, b) => (state.scores[b.seat] ?? 0) - (state.scores[a.seat] ?? 0));
    standings = sorted.map((p) => ({
      seat: p.seat,
      score: state.scores[p.seat] ?? 0,
      rank: 1 + sorted.filter((o) => (state.scores[o.seat] ?? 0) > (state.scores[p.seat] ?? 0)).length,
    }));
  }

  return {
    phase: state.phase,
    round: Math.min(state.round, state.totalRounds - 1),
    totalRounds: state.totalRounds,
    roundEndsAt: state.roundEndsAt,
    revealEndsAt: state.revealEndsAt,
    you: {
      seat,
      submitted: players.find((p) => p.seat === seat)?.submitted ?? false,
      yourHand,
      left: state.leftSeats.includes(seat),
    },
    players,
    history: state.history,
    standings,
  };
}

function parseAction(raw: unknown): JankenAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type !== "throw") return null;
  if (!isJankenHand(rec.hand)) return null;
  return { type: "throw", hand: rec.hand };
}

function onPlayerLeft(state: JankenState, seat: number): JankenState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.leftSeats.includes(seat)) return state;
  const draft = clone(state);
  draft.leftSeats.push(seat);
  if (activeSeats(draft).length < 2) {
    draft.phase = "finished";
    draft.roundEndsAt = null;
    draft.revealEndsAt = null;
    return draft;
  }
  closeIfAllThrown(draft, Date.now());
  return draft;
}

function tick(state: JankenState, now: number): JankenState {
  if (state.phase === "choosing" && state.roundEndsAt !== null && now >= state.roundEndsAt) {
    const draft = clone(state);
    closeRound(draft, now);
    return draft;
  }
  if (state.phase === "reveal" && state.revealEndsAt !== null && now >= state.revealEndsAt) {
    const draft = clone(state);
    advance(draft, now);
    return draft;
  }
  return state;
}

export const gameModule: OnlineGameModule<JankenState, JankenAction, JankenView> = {
  id: "janken",
  title: "じゃんけん大会",
  minPlayers: 2,
  maxPlayers: 8,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: JankenState) => state.phase,
  isFinished: (state: JankenState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
