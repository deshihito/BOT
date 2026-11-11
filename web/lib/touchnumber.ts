// タッチザナンバー（シュルテ表形式）の純粋ロジック（UI 非依存・シード決定的）。
// 1から順番にタップする。タイマーとペナルティ秒の換算は UI 側の責務で、
// ここでは配置・次の数字の判定・ミス集計だけを持つ。

export type TouchSize = 25 | 50;

export type TouchState = {
  size: number;
  seed: number;
  /** セル index → 数字（1..size）の配置。 */
  board: number[];
  /** 次にタップすべき数字。 */
  next: number;
  misses: number;
  status: "playing" | "won";
  taps: number;
};

/** mulberry32。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function normalizeTouchSize(size: number): TouchSize {
  return size === 50 ? 50 : 25;
}

/** グリッドの列数（25→5列、50→5列×10行）。 */
export function touchColumns(size: number): number {
  return normalizeTouchSize(size) === 50 ? 5 : 5;
}

export function createTouchGame(size: number, seed: number): TouchState {
  const n = normalizeTouchSize(size);
  const board = Array.from({ length: n }, (_, i) => i + 1);
  let rng = seed | 0;
  for (let i = board.length - 1; i > 0; i--) {
    const r = nextRandom(rng);
    rng = r.rng;
    const j = Math.floor(r.value * (i + 1));
    [board[i], board[j]] = [board[j], board[i]];
  }
  return { size: n, seed: seed | 0, board, next: 1, misses: 0, status: "playing", taps: 0 };
}

/**
 * セル index をタップする。
 * - 次の数字なら進む（最後なら won）。
 * - まだの数字（次の数字より大きい）ならミス+1。
 * - 片付け済みの数字は無視（ミスにしない）。範囲外・終了後も無視。
 */
export function tapCell(state: TouchState, index: number): TouchState {
  if (state.status !== "playing") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.board.length) return state;
  const value = state.board[index];
  if (value < state.next) return state;
  if (value > state.next) {
    return { ...state, misses: state.misses + 1, taps: state.taps + 1 };
  }
  const next = state.next + 1;
  return {
    ...state,
    next,
    taps: state.taps + 1,
    status: next > state.size ? "won" : "playing",
  };
}

/** 数字そのものをタップした場合の等価操作（テスト・補助用）。 */
export function tapValue(state: TouchState, value: number): TouchState {
  const index = state.board.indexOf(value);
  if (index < 0) return state;
  return tapCell(state, index);
}

/** 片付け済みかどうか。 */
export function isCleared(state: TouchState, index: number): boolean {
  const v = state.board[index];
  return typeof v === "number" && v < state.next;
}
