// ババ抜き（2〜4人）のルールモジュール。ジョーカー1枚入りの53枚を使う。
// モジュール契約は lib/online/types.ts の OnlineGameModule に従う。
// 実行時 import は禁止（テストが import を剥がして連結するため type のみ）。
//
// カード表現: id 0〜51 が通常札（suit = floor(id/13)、rank = (id % 13) + 1）、
// id 52 がジョーカー。ペアは「同じランクの2枚」で成立する。
// 手番のプレイヤーは隣（seat 順で次の現役プレイヤー）の手札から、
// 位置を指定して1枚引く。引いた札と手札でペアができたらその場で捨てる。
// 手札が0枚になったプレイヤーから上がり、最後まで残った1人が
// ジョーカー保持者として負けになる。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export const BABANUKI_JOKER = 52;

export interface BabanukiLogEntry {
  seat: number;
  kind: "draw" | "pair" | "finish" | "lose" | "left";
  /** draw / pair のとき、引かれた側の seat。 */
  from?: number;
}

export interface BabanukiState {
  players: SeatInfo[];
  hands: number[][];
  turn: number;
  finishOrder: number[];
  loser: number | null;
  finished: boolean;
  leftSeats: number[];
  lastDraw: { seat: number; from: number; paired: boolean } | null;
  log: BabanukiLogEntry[];
}

export type BabanukiAction = { type: "draw"; index: number };

export interface BabanukiOtherView {
  seat: number;
  name: string;
  count: number;
  rank: number | null;
  left: boolean;
}

export interface BabanukiView {
  yourHand: number[];
  others: BabanukiOtherView[];
  turn: number;
  drawFrom: number | null;
  finishOrder: number[];
  yourRank: number | null;
  loser: number | null;
  finished: boolean;
  lastDraw: { seat: number; from: number; paired: boolean } | null;
  log: BabanukiLogEntry[];
  players: SeatInfo[];
}

function babClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 通常札のランク（1〜13）。ジョーカーは null。 */
export function babRankOf(id: number): number | null {
  if (id === BABANUKI_JOKER) return null;
  return (id % 13) + 1;
}

function babSortKey(id: number): number {
  return id === BABANUKI_JOKER ? 100 : (babRankOf(id) as number);
}

export function babSortHand(hand: number[]): number[] {
  return [...hand].sort((a, b) => babSortKey(a) - babSortKey(b) || a - b);
}

/**
 * 手札からランクのペアを取り除く。各ランクは偶数枚ぶん捨て、
 * 奇数なら1枚だけ残す。ジョーカーは常に対象外で残る。
 * 戻り値は表示用にソート済み。
 */
export function babRemovePairs(hand: number[]): number[] {
  const byRank = new Map<number, number[]>();
  let hasJoker = false;
  for (const id of hand) {
    if (id === BABANUKI_JOKER) {
      hasJoker = true;
      continue;
    }
    const rank = babRankOf(id) as number;
    if (!byRank.has(rank)) byRank.set(rank, []);
    (byRank.get(rank) as number[]).push(id);
  }
  const kept: number[] = [];
  for (const ids of byRank.values()) {
    if (ids.length % 2 === 1) kept.push(ids[0]);
  }
  if (hasJoker) kept.push(BABANUKI_JOKER);
  return babSortHand(kept);
}

function babIsActive(state: BabanukiState, seat: number): boolean {
  return !state.finishOrder.includes(seat) && !state.leftSeats.includes(seat);
}

function babActiveSeats(state: BabanukiState): number[] {
  const out: number[] = [];
  for (let s = 0; s < state.players.length; s++) {
    if (babIsActive(state, s)) out.push(s);
  }
  return out;
}

/** seat の次に現役の seat（循環）。現役が seat だけなら seat 自身を返す。 */
function babNextActive(state: BabanukiState, seat: number): number {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const s = (seat + step) % n;
    if (babIsActive(state, s)) return s;
  }
  return seat;
}

function babPushLog(state: BabanukiState, entry: BabanukiLogEntry): void {
  state.log = [...state.log, entry].slice(-20);
}

/** 現役が1人以下になったら終局処理をする。変化があれば true。 */
function babSettleEnd(state: BabanukiState): boolean {
  const remaining = babActiveSeats(state);
  if (remaining.length > 1) return false;
  state.finished = true;
  if (remaining.length === 1) {
    const last = remaining[0];
    // 通常の終局では最後の1人は必ずジョーカーだけを持っている。
    // 退出が絡んでジョーカーが場に無い場合は負けなしにする。
    state.loser = state.hands[last].includes(BABANUKI_JOKER) ? last : null;
    state.turn = last;
    if (state.loser !== null) babPushLog(state, { seat: last, kind: "lose" });
  } else {
    state.loser = null;
  }
  return true;
}

function babCreateState(
  players: SeatInfo[],
  rng: Rng,
  _options: Record<string, unknown>,
): BabanukiState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 4) {
    throw new Error("ババ抜きは2〜4人で遊びます");
  }
  const deck: number[] = Array.from({ length: 53 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  const n = players.length;
  const dealt: number[][] = Array.from({ length: n }, () => []);
  deck.forEach((card, i) => {
    dealt[i % n].push(card);
  });
  // 配布直後のペアは自動で捨てる。捨てて0枚になった人は即上がり。
  const hands = dealt.map((h) => babRemovePairs(h));
  const finishOrder: number[] = [];
  hands.forEach((h, s) => {
    if (h.length === 0) finishOrder.push(s);
  });
  const state: BabanukiState = {
    players: babClone(players),
    hands,
    turn: 0,
    finishOrder,
    loser: null,
    finished: false,
    leftSeats: [],
    lastDraw: null,
    log: [],
  };
  if (!babSettleEnd(state)) {
    state.turn = babActiveSeats(state)[0] ?? 0;
  }
  return state;
}

function babApplyAction(
  state: BabanukiState,
  seat: number,
  action: BabanukiAction,
  _rng: Rng,
): BabanukiState {
  if (state.finished) throw new Error("ゲームは終了しています");
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (!babIsActive(state, seat)) throw new Error("既に終了したプレイヤーです");
  if (seat !== state.turn) throw new Error("手番ではありません");
  if (!action || typeof action !== "object" || action.type !== "draw") {
    throw new Error("不正なアクションです");
  }
  const target = babNextActive(state, seat);
  if (target === seat) throw new Error("引く相手がいません");
  const index = action.index;
  if (!Number.isInteger(index) || index < 0 || index >= state.hands[target].length) {
    throw new Error("引くカードの位置が不正です");
  }

  const next = babClone(state);
  const card = next.hands[target][index];
  next.hands[target] = next.hands[target].filter((_, i) => i !== index);

  // 引かれた側が0枚になったら、その時点で先に上がる。
  if (next.hands[target].length === 0) {
    next.finishOrder.push(target);
    babPushLog(next, { seat: target, kind: "finish" });
  }

  // 引いた札を手札へ。同じランクがあればペアとして2枚とも捨てる。
  const drawerHand = [...next.hands[seat], card];
  const rank = babRankOf(card);
  let paired = false;
  if (rank !== null) {
    const mateIndex = drawerHand.findIndex(
      (c, i) => i !== drawerHand.length - 1 && babRankOf(c) === rank,
    );
    if (mateIndex >= 0) {
      drawerHand.splice(mateIndex, 1);
      drawerHand.splice(drawerHand.length - 1, 1);
      paired = true;
    }
  }
  next.hands[seat] = babSortHand(drawerHand);
  next.lastDraw = { seat, from: target, paired };
  babPushLog(next, { seat, kind: paired ? "pair" : "draw", from: target });

  if (next.hands[seat].length === 0 && babIsActive(next, seat)) {
    next.finishOrder.push(seat);
    babPushLog(next, { seat, kind: "finish" });
  }

  if (!babSettleEnd(next)) {
    next.turn = babNextActive(next, seat);
  }
  return next;
}

function babViewFor(state: BabanukiState, seat: number): BabanukiView {
  const rankOfSeat = (s: number): number | null => {
    const idx = state.finishOrder.indexOf(s);
    return idx >= 0 ? idx + 1 : null;
  };
  const drawFrom = state.finished ? null : babNextActive(state, state.turn);
  return {
    yourHand: [...(state.hands[seat] ?? [])],
    others: state.players
      .map((p, s) => ({
        seat: s,
        name: p.name,
        count: state.hands[s]?.length ?? 0,
        rank: rankOfSeat(s),
        left: state.leftSeats.includes(s),
      }))
      .filter((o) => o.seat !== seat),
    turn: state.turn,
    drawFrom: drawFrom === state.turn ? null : drawFrom,
    finishOrder: [...state.finishOrder],
    yourRank: rankOfSeat(seat),
    loser: state.loser,
    finished: state.finished,
    lastDraw: state.lastDraw ? { ...state.lastDraw } : null,
    log: babClone(state.log),
    players: babClone(state.players),
  };
}

function babParseAction(raw: unknown): BabanukiAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== "draw") return null;
  if (typeof r.index !== "number" || !Number.isInteger(r.index) || r.index < 0) return null;
  return { type: "draw", index: r.index };
}

function babOnPlayerLeft(state: BabanukiState, seat: number): BabanukiState {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (state.finished) return babClone(state);
  if (!babIsActive(state, seat)) return babClone(state);
  const next = babClone(state);
  // 退出者の手札は場から取り除き、順位は付けず現役から外す。
  next.hands[seat] = [];
  next.leftSeats.push(seat);
  babPushLog(next, { seat, kind: "left" });
  if (!babSettleEnd(next)) {
    if (!babIsActive(next, next.turn)) {
      next.turn = babNextActive(next, seat);
    }
  }
  return next;
}

function babCpuAction(state: BabanukiState, seat: number, rng: Rng): BabanukiAction | null {
  if (state.finished) return null;
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) return null;
  if (!babIsActive(state, seat) || seat !== state.turn) return null;
  const target = babNextActive(state, seat);
  if (target === seat) return null;
  const count = state.hands[target].length;
  if (count === 0) return null;
  const index = Math.min(count - 1, Math.floor(rng() * count));
  return { type: "draw", index };
}

export const gameModule: OnlineGameModule<BabanukiState, BabanukiAction, BabanukiView> = {
  id: "babanuki",
  title: "ババ抜き",
  minPlayers: 2,
  maxPlayers: 4,
  cpuSupported: true,
  chatEnabled: true,
  createState: babCreateState,
  applyAction: babApplyAction,
  viewFor: babViewFor,
  parseAction: babParseAction,
  phaseOf: (state) => (state.finished ? "finished" : "playing"),
  isFinished: (state) => state.finished,
  onPlayerLeft: babOnPlayerLeft,
  cpuAction: babCpuAction,
};
