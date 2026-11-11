// あかり（Akari）の純粋ロジック（UI 非依存・シード決定的）。
// 白マスに電球を置くと、そのマスから上下左右が黒マスに当たるまで照らされる。
// 完成条件: 全ての白マスが照らされている／電球同士が照らし合わない／
// 数字付き黒マスに接する電球の数が数字と一致する。
// 問題の生成: 壁を先に置き、「まだ照らされていない白マスに電球を置く」貪欲配置で
// 解を構築してから、解の電球数に合わせて壁へ数字を割り当てる。
// 解が存在すること（可解性）はこの構成で保証される。完成判定は解との一致ではなく
// ルール検証で行うため、別解でもクリアできる。
// 状態は JSON 化可能な値のみ。遷移関数は状態を破壊せず新しい状態を返す。

export const AKARI_SIZE = 7;

export type AkariStatus = "playing" | "won";

export interface AkariState {
  rows: number;
  cols: number;
  /** 黒マスの index（row-major）一覧。 */
  walls: number[];
  /** 数字付き黒マス: index -> 数字（0〜4）。数字の無い黒マスは含まない。 */
  numbers: Record<number, number>;
  /** プレイヤーが置いた電球の index 一覧。 */
  bulbs: number[];
  status: AkariStatus;
  moves: number;
  seed: number;
  /** 生成時に構築した解（電球の index 一覧）。検証用に保持する。 */
  solution: number[];
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

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

const DIRS = [
  { dr: -1, dc: 0 },
  { dr: 1, dc: 0 },
  { dr: 0, dc: -1 },
  { dr: 0, dc: 1 },
] as const;

/** 電球配置から照らされているマスを求める（壁マスは false）。 */
export function akariLitCells(
  rows: number,
  cols: number,
  walls: number[],
  bulbs: number[],
): boolean[] {
  const wallSet = new Set(walls);
  const lit = new Array<boolean>(rows * cols).fill(false);
  for (const bulb of bulbs) {
    const r = Math.floor(bulb / cols);
    const c = bulb % cols;
    lit[bulb] = true;
    for (const { dr, dc } of DIRS) {
      let nr = r + dr;
      let nc = c + dc;
      while (nr >= 0 && nc >= 0 && nr < rows && nc < cols) {
        const idx = nr * cols + nc;
        if (wallSet.has(idx)) break;
        lit[idx] = true;
        nr += dr;
        nc += dc;
      }
    }
  }
  return lit;
}

export interface AkariNumberError {
  index: number;
  expected: number;
  actual: number;
  /** まだ電球を置ける隣接白マス（未配置）の数。actual + adjacentOpen < expected なら到達不能。 */
  adjacentOpen: number;
}

export interface AkariEvaluation {
  /** 照らされているマス（index 順ではなく盤面順の boolean 配列）。 */
  lit: boolean[];
  /** 照らされている白マスの数。 */
  litCount: number;
  /** 白マスの総数。 */
  whiteCount: number;
  /** 別の電球と照らし合っている電球の index 一覧。 */
  conflictBulbs: number[];
  /** 数字と接する電球数が一致していない数字付き黒マス。 */
  numberErrors: AkariNumberError[];
  solved: boolean;
}

/** 現在の電球配置をルールで評価する。 */
export function evaluateAkari(state: AkariState): AkariEvaluation {
  const { rows, cols, walls, numbers, bulbs } = state;
  const wallSet = new Set(walls);
  const bulbSet = new Set(bulbs);
  const lit = akariLitCells(rows, cols, walls, bulbs);

  // 電球同士の照らし合い: 各電球から4方向に光を伸ばし、壁より先に別の電球に当たれば衝突。
  const conflict = new Set<number>();
  for (const bulb of bulbs) {
    const r = Math.floor(bulb / cols);
    const c = bulb % cols;
    for (const { dr, dc } of DIRS) {
      let nr = r + dr;
      let nc = c + dc;
      while (nr >= 0 && nc >= 0 && nr < rows && nc < cols) {
        const idx = nr * cols + nc;
        if (wallSet.has(idx)) break;
        if (bulbSet.has(idx)) {
          conflict.add(bulb);
          conflict.add(idx);
          break;
        }
        nr += dr;
        nc += dc;
      }
    }
  }

  const numberErrors: AkariNumberError[] = [];
  for (const [key, expected] of Object.entries(numbers)) {
    const index = Number(key);
    const r = Math.floor(index / cols);
    const c = index % cols;
    let actual = 0;
    let adjacentOpen = 0;
    for (const { dr, dc } of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      const idx = nr * cols + nc;
      if (wallSet.has(idx)) continue;
      if (bulbSet.has(idx)) actual++;
      else adjacentOpen++;
    }
    if (actual !== expected) numberErrors.push({ index, expected, actual, adjacentOpen });
  }

  let litCount = 0;
  let whiteCount = 0;
  for (let i = 0; i < rows * cols; i++) {
    if (wallSet.has(i)) continue;
    whiteCount++;
    if (lit[i]) litCount++;
  }

  const solved =
    litCount === whiteCount && conflict.size === 0 && numberErrors.length === 0;
  return {
    lit,
    litCount,
    whiteCount,
    conflictBulbs: [...conflict].sort((a, b) => a - b),
    numberErrors,
    solved,
  };
}

interface BuiltPuzzle {
  walls: number[];
  numbers: Record<number, number>;
  solution: number[];
}

/** 壁配置と解を先に作る。品質条件を満たさなければ null。 */
function buildPuzzle(rng: () => number, rows: number, cols: number): BuiltPuzzle | null {
  const total = rows * cols;
  const wallCount = randInt(rng, 11, 15);
  const wallSet = new Set<number>();
  for (let tries = 0; tries < 200 && wallSet.size < wallCount; tries++) {
    wallSet.add(randInt(rng, 0, total - 1));
  }
  const walls = [...wallSet].sort((a, b) => a - b);

  // 解の構築: まだ照らされていない白マスをランダムに選び、電球を置く。
  // 照らされていないマスの上下左右の直線範囲には電球が無いため、
  // ここに置いても電球同士が照らし合うことはない。
  const solution: number[] = [];
  for (let guard = 0; guard < total * 2; guard++) {
    const lit = akariLitCells(rows, cols, walls, solution);
    const unlit: number[] = [];
    for (let i = 0; i < total; i++) {
      if (!wallSet.has(i) && !lit[i]) unlit.push(i);
    }
    if (unlit.length === 0) break;
    solution.push(unlit[Math.floor(rng() * unlit.length)]);
  }
  const finalLit = akariLitCells(rows, cols, walls, solution);
  for (let i = 0; i < total; i++) {
    if (!wallSet.has(i) && !finalLit[i]) return null; // 念のための安全確認
  }
  if (solution.length < 6) return null; // 簡単すぎる問題は作り直す
  solution.sort((a, b) => a - b);
  const solutionSet = new Set(solution);

  // 数字の割り当て: 解における隣接電球数を、そのまま壁の数字にする。
  // 隣に白マスがある壁の一部にだけ数字を付け、最低でも3つは数字付きにする。
  const numbers: Record<number, number> = {};
  const eligible: number[] = [];
  for (const wall of walls) {
    const r = Math.floor(wall / cols);
    const c = wall % cols;
    let adjacentBulbs = 0;
    let adjacentWhite = 0;
    for (const { dr, dc } of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      const idx = nr * cols + nc;
      if (wallSet.has(idx)) continue;
      adjacentWhite++;
      if (solutionSet.has(idx)) adjacentBulbs++;
    }
    if (adjacentWhite === 0) continue;
    eligible.push(wall);
    if (rng() < 0.6) numbers[wall] = adjacentBulbs;
  }
  if (Object.keys(numbers).length < 3) {
    for (const wall of eligible) {
      if (Object.keys(numbers).length >= 3) break;
      if (numbers[wall] !== undefined) continue;
      const r = Math.floor(wall / cols);
      const c = wall % cols;
      let count = 0;
      for (const { dr, dc } of DIRS) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        if (solutionSet.has(nr * cols + nc)) count++;
      }
      numbers[wall] = count;
    }
  }
  if (Object.keys(numbers).length === 0) return null;
  return { walls, numbers, solution };
}

/** フォールバック用の固定パズル（生成が連続失敗した場合）。固定の壁配置に対して
 *  本体と同じ貪欲配置で解を構築するので、可解性は構成上保証される。 */
function fallbackPuzzle(rows: number, cols: number): BuiltPuzzle {
  const wallSet = new Set<number>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r % 3 === 1 && c % 3 === 1) wallSet.add(r * cols + c);
    }
  }
  const walls = [...wallSet].sort((a, b) => a - b);
  const rng = makeRng(1234567);
  const solution: number[] = [];
  for (let guard = 0; guard < rows * cols * 2; guard++) {
    const lit = akariLitCells(rows, cols, walls, solution);
    const unlit: number[] = [];
    for (let i = 0; i < rows * cols; i++) {
      if (!wallSet.has(i) && !lit[i]) unlit.push(i);
    }
    if (unlit.length === 0) break;
    solution.push(unlit[Math.floor(rng() * unlit.length)]);
  }
  solution.sort((a, b) => a - b);
  const solutionSet = new Set(solution);
  const numbers: Record<number, number> = {};
  for (const wall of walls) {
    const r = Math.floor(wall / cols);
    const c = wall % cols;
    let count = 0;
    for (const { dr, dc } of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      if (solutionSet.has(nr * cols + nc)) count++;
    }
    numbers[wall] = count;
  }
  return { walls, numbers, solution };
}

export function createAkariGame(seed: number, size: number = AKARI_SIZE): AkariState {
  const rows = size;
  const cols = size;
  const rng = makeRng(seed);
  let built: BuiltPuzzle | null = null;
  for (let attempt = 0; attempt < 200 && built === null; attempt++) {
    built = buildPuzzle(rng, rows, cols);
  }
  if (built === null) built = fallbackPuzzle(rows, cols);
  return {
    rows,
    cols,
    walls: built.walls,
    numbers: built.numbers,
    bulbs: [],
    status: "playing",
    moves: 0,
    seed: seed | 0,
    solution: built.solution,
  };
}

/** 白マスの電球を付け外しする。壁マス・終了後・盤外は状態をそのまま返す。 */
export function toggleBulb(state: AkariState, index: number): AkariState {
  if (state.status !== "playing") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.rows * state.cols) return state;
  if (state.walls.includes(index)) return state;
  const has = state.bulbs.includes(index);
  const bulbs = has
    ? state.bulbs.filter((b) => b !== index)
    : [...state.bulbs, index].sort((a, b) => a - b);
  const next: AkariState = { ...state, bulbs, moves: state.moves + 1 };
  if (evaluateAkari(next).solved) next.status = "won";
  return next;
}
