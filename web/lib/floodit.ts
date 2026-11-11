// フラッドフィル（Flood-It）の純粋ロジック（UI 非依存・シード決定的）。
// 左上の領域と同じ色のマスを広げていき、制限手数以内に盤全体を1色にそろえる。
// 解ける盤面の保証: 生成時に貪欲法（毎回いちばん広がる色を選ぶ）で実際に解き、
// その手数 + 余裕（8手）を制限手数にする。貪欲で解ける以上、必ず解が存在する。

export const FLOOD_SIZE = 12;
export const FLOOD_COLOR_COUNT = 6;
/** 貪欲解の手数に足す余裕。 */
export const FLOOD_SLACK = 8;

export type FloodStatus = "playing" | "won" | "lost";

export interface FloodState {
  size: number;
  colorCount: number;
  cells: number[];
  movesUsed: number;
  /** 制限手数。これを超えると負け。 */
  maxMoves: number;
  /** 生成時に貪欲法で解いた手数（目安表示用）。 */
  parMoves: number;
  status: FloodStatus;
  seed: number;
}

/** mulberry32。生成専用に局所で使う。 */
function makeRng(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** 左上（index 0）と同色でつながっている領域の index 一覧（ソート済み）。 */
export function floodRegionIndices(cells: number[], size: number): number[] {
  const color = cells[0];
  const seen = new Set<number>([0]);
  const stack = [0];
  while (stack.length > 0) {
    const idx = stack.pop() as number;
    const r = Math.floor(idx / size);
    const c = idx % size;
    const neighbors = [
      r > 0 ? idx - size : -1,
      r < size - 1 ? idx + size : -1,
      c > 0 ? idx - 1 : -1,
      c < size - 1 ? idx + 1 : -1,
    ];
    for (const n of neighbors) {
      if (n < 0 || seen.has(n) || cells[n] !== color) continue;
      seen.add(n);
      stack.push(n);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

function applyColor(cells: number[], size: number, color: number): number[] {
  const region = floodRegionIndices(cells, size);
  const next = [...cells];
  for (const idx of region) next[idx] = color;
  return next;
}

/** 貪欲法で解くのに必要な手数（解けることの検証を兼ねる）。 */
function greedyMoves(cells: number[], size: number, colorCount: number): number {
  let current = [...cells];
  let moves = 0;
  while (!current.every((c) => c === current[0])) {
    const regionColor = current[0];
    let bestColor = -1;
    let bestSize = -1;
    let bestCells: number[] | null = null;
    for (let color = 0; color < colorCount; color++) {
      if (color === regionColor) continue;
      const trial = applyColor(current, size, color);
      const sizeAfter = floodRegionIndices(trial, size).length;
      if (sizeAfter > bestSize) {
        bestSize = sizeAfter;
        bestColor = color;
        bestCells = trial;
      }
    }
    if (bestCells === null || bestColor < 0) break; // 到達不能（通常起きない）
    current = bestCells;
    moves++;
    if (moves > size * size) break; // 安全弁
  }
  return moves;
}

export function createFloodGame(seed: number): FloodState {
  const rng = makeRng(seed);
  const cells = Array.from({ length: FLOOD_SIZE * FLOOD_SIZE }, () =>
    Math.floor(rng() * FLOOD_COLOR_COUNT),
  );
  const par = greedyMoves(cells, FLOOD_SIZE, FLOOD_COLOR_COUNT);
  return {
    size: FLOOD_SIZE,
    colorCount: FLOOD_COLOR_COUNT,
    cells,
    movesUsed: 0,
    maxMoves: par + FLOOD_SLACK,
    parMoves: par,
    status: "playing",
    seed: seed | 0,
  };
}

/** 指定色で領域を塗り広げる。今の領域と同じ色・終了後・不正な色は無効（同一状態を返す）。 */
export function applyFloodMove(state: FloodState, color: number): FloodState {
  if (state.status !== "playing") return state;
  if (!Number.isInteger(color) || color < 0 || color >= state.colorCount) return state;
  if (state.cells[0] === color) return state;
  const cells = applyColor(state.cells, state.size, color);
  const movesUsed = state.movesUsed + 1;
  const won = cells.every((c) => c === cells[0]);
  const status: FloodStatus = won ? "won" : movesUsed >= state.maxMoves ? "lost" : "playing";
  return { ...state, cells, movesUsed, status };
}
