// スタッカーの純粋ロジック（UI 非依存）。
// 左右に往復するブロックをタイミングよく止め、下の段と重なった部分だけが残る。
// 位置の前進（advance）と落下確定（drop）を純粋関数で扱い、
// 状態は JSON 化可能な値のみ。遷移関数は状態を破壊せず新しい状態を返す。

export type StackRow = {
  start: number;
  width: number;
};

export type StackerStatus = "playing" | "gameover";

export type StackerState = {
  boardWidth: number;
  /** 積み上がった段（下から順）。 */
  rows: StackRow[];
  /** 現在移動中のブロック。 */
  currentStart: number;
  currentWidth: number;
  /** 移動方向: 1=右、-1=左。 */
  dir: 1 | -1;
  status: StackerStatus;
  /** 積んだ段数（＝スコア）。 */
  score: number;
  /** ちょうど重なった回数。 */
  perfects: number;
  /** 直前の drop がちょうど重なりだったか。 */
  lastPerfect: boolean;
};

export const STACKER_BOARD_WIDTH = 7;
export const STACKER_START_WIDTH = 3;

export function createStackerGame(
  boardWidth: number = STACKER_BOARD_WIDTH,
  startWidth: number = STACKER_START_WIDTH,
): StackerState {
  const width = Math.max(3, Math.floor(boardWidth));
  const block = Math.max(1, Math.min(Math.floor(startWidth), width));
  return {
    boardWidth: width,
    rows: [],
    currentStart: 0,
    currentWidth: block,
    dir: 1,
    status: "playing",
    score: 0,
    perfects: 0,
    lastPerfect: false,
  };
}

/** ブロックを1マス進める。端に当たったら反転する。 */
export function advanceStacker(state: StackerState): StackerState {
  if (state.status !== "playing") return state;
  const maxStart = state.boardWidth - state.currentWidth;
  if (maxStart <= 0) return state;
  let dir = state.dir;
  let next = state.currentStart + dir;
  if (next < 0) {
    next = 1;
    dir = 1;
  } else if (next > maxStart) {
    next = maxStart - 1;
    dir = -1;
  }
  return { ...state, currentStart: next, dir };
}

/** 下の段との重なりを計算する（内部用）。 */
export function overlapOf(state: StackerState): StackRow | null {
  const prev: StackRow =
    state.rows.length > 0
      ? state.rows[state.rows.length - 1]
      : { start: 0, width: state.boardWidth };
  const start = Math.max(state.currentStart, prev.start);
  const end = Math.min(state.currentStart + state.currentWidth, prev.start + prev.width);
  if (end - start <= 0) return null;
  return { start, width: end - start };
}

/**
 * ブロックを落として確定させる。
 * 重なりが無ければゲームオーバー、あればはみ出しを切り落として次の段へ。
 */
export function dropStacker(state: StackerState): StackerState {
  if (state.status !== "playing") return state;
  const overlap = overlapOf(state);
  if (!overlap) {
    return { ...state, status: "gameover", lastPerfect: false };
  }
  const perfect =
    state.rows.length > 0 &&
    state.currentStart === state.rows[state.rows.length - 1].start &&
    state.currentWidth === state.rows[state.rows.length - 1].width;
  return {
    ...state,
    rows: [...state.rows, overlap],
    currentStart: 0,
    currentWidth: overlap.width,
    dir: 1,
    score: state.score + 1,
    perfects: state.perfects + (perfect ? 1 : 0),
    lastPerfect: perfect,
  };
}

/** スピード段階（段数に応じて速くなる。UI の落下間隔計算用）。 */
export function stackerIntervalMs(score: number): number {
  return Math.max(70, 240 - score * 12);
}
