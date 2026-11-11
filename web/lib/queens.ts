// クイーン配置（Nクイーン）の純粋ロジック（UI 非依存・シード決定的）。
// 互いに利き合わないようクイーンを N 個置くパズル。
// 作成時にバックトラックで解を1つ構成して保持し、解けることを保証する。
// 配置は自由で、利き合っているクイーンは conflicts として検出できる。
// 完成条件は「N 個置けて、利き合うペアが1つもない」こと。

export type QnStatus = "playing" | "won";

export type QnState = {
  /** 盤の一辺（6 または 8）。置くクイーンの数も同じ。 */
  size: number;
  /** 配置済みクイーンのマス index（昇順）。 */
  queens: number[];
  /** 作成時に構成した解（到達可能性の保証）。 */
  solution: number[];
  status: QnStatus;
  seed: number;
};

/** mulberry32 系。呼び出しごとに rng 関数を返す決定的な乱数。 */
function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2つのマスがクイーンの利き関係（同行・同列・同斜め）にあるか。 */
export function queensAttack(size: number, a: number, b: number): boolean {
  if (a === b) return false;
  const ar = Math.floor(a / size);
  const ac = a % size;
  const br = Math.floor(b / size);
  const bc = b % size;
  return ar === br || ac === bc || Math.abs(ar - br) === Math.abs(ac - bc);
}

/** 利き合っているクイーンのマス index（昇順・重複なし）。 */
export function conflictingQueens(state: QnState): number[] {
  const bad = new Set<number>();
  const qs = state.queens;
  for (let i = 0; i < qs.length; i++) {
    for (let j = i + 1; j < qs.length; j++) {
      if (queensAttack(state.size, qs[i], qs[j])) {
        bad.add(qs[i]);
        bad.add(qs[j]);
      }
    }
  }
  return [...bad].sort((a, b) => a - b);
}

/** いずれかのクイーンの利きが届いているマス（クイーン自身のマスは含まない）。 */
export function attackedSquares(state: QnState): number[] {
  const out = new Set<number>();
  const own = new Set(state.queens);
  for (const q of state.queens) {
    for (let i = 0; i < state.size * state.size; i++) {
      if (own.has(i)) continue;
      if (queensAttack(state.size, q, i)) out.add(i);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** バックトラックで解を1つ構成する（列順を rng でシャッフル）。 */
function buildSolution(size: number, rng: () => number): number[] {
  const cols: number[] = new Array<number>(size).fill(-1);
  const usedCol = new Array<boolean>(size).fill(false);
  const usedDiagA = new Set<number>();
  const usedDiagB = new Set<number>();

  const dfs = (row: number): boolean => {
    if (row >= size) return true;
    const order = Array.from({ length: size }, (_, c) => c);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const col of order) {
      if (usedCol[col] || usedDiagA.has(row - col) || usedDiagB.has(row + col)) continue;
      cols[row] = col;
      usedCol[col] = true;
      usedDiagA.add(row - col);
      usedDiagB.add(row + col);
      if (dfs(row + 1)) return true;
      cols[row] = -1;
      usedCol[col] = false;
      usedDiagA.delete(row - col);
      usedDiagB.delete(row + col);
    }
    return false;
  };

  if (!dfs(0)) return [];
  return cols.map((col, row) => row * size + col).sort((a, b) => a - b);
}

function statusFor(state: QnState): QnStatus {
  if (state.queens.length === state.size && conflictingQueens(state).length === 0) {
    return "won";
  }
  return "playing";
}

export function createQueensGame(size: number, seed: number): QnState {
  const n = size === 6 ? 6 : 8;
  const rng = makeRng(seed);
  const solution = buildSolution(n, rng);
  const state: QnState = { size: n, queens: [], solution, status: "playing", seed };
  return state;
}

/**
 * マスをタップしたときの操作。クイーンがあれば取り除き、
 * 無ければ置く（ただし N 個まで）。不正な操作は state をそのまま返す。
 */
export function toggleQueen(state: QnState, index: number): QnState {
  if (!Number.isInteger(index) || index < 0 || index >= state.size * state.size) return state;
  if (state.status === "won") return state;
  let queens: number[];
  if (state.queens.includes(index)) {
    queens = state.queens.filter((q) => q !== index);
  } else {
    if (state.queens.length >= state.size) return state;
    queens = [...state.queens, index].sort((a, b) => a - b);
  }
  const next: QnState = { ...state, queens, status: "playing" };
  return { ...next, status: statusFor(next) };
}
