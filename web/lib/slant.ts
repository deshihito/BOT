// スラント（ごきげんななめ）の純粋ロジック（UI 非依存・シード決定的）。
// ルール: 5×5 の各マスに斜線（/ か \）を1本ずつ引く。
// - 格子点の数字は、その点に接する斜線の端点の数と一致する。
// - 斜線同士で閉じたループを作ってはいけない。
// 生成は「解を先に作る」方式: ループを作らない斜線の配置を深さ優先で構築し、
// 各格子点に接する端点の数を計算して、一部の点の数字だけを表示する。
// 表示されなかった点には制約がないため解の一意性は保証しない。完成判定は
// 正解との一致ではなくルール検証で行うため、ルールを満たす別解でもクリアになる。
// 斜線の向き: 1 = "/"（左下と右上を結ぶ）、2 = "\"（左上と右下を結ぶ）、0 = 未定。

export const SLANT_WIDTH = 5;
export const SLANT_HEIGHT = 5;

export type SlantMark = 0 | 1 | 2;

export type SlantViolationType = "point" | "loop";

export type SlantViolation = {
  type: SlantViolationType;
  /** ハイライト用のマス index。 */
  cells: number[];
  /** ハイライト用の格子点 index。 */
  points: number[];
  message: string;
};

export type SlantState = {
  width: number;
  height: number;
  seed: number;
  /** 正解の斜線配置。生成の検証用に保持する。 */
  solution: SlantMark[];
  /** 各格子点の数字（null = 非表示で制約なし）。点は (height+1) 行 × (width+1) 列。 */
  clues: (number | null)[];
  /** 現在の盤面（0 = 未定、1 = /、2 = \）。 */
  board: SlantMark[];
  moves: number;
  status: "playing" | "won";
};

/** mulberry32（minesweeper 等と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function pointIndex(width: number, pr: number, pc: number): number {
  return pr * (width + 1) + pc;
}

/** マスの斜線が結ぶ2つの格子点 index を返す。 */
export function slantEndpoints(
  width: number,
  height: number,
  index: number,
  mark: SlantMark,
): [number, number] | null {
  if (mark === 0) return null;
  const r = Math.floor(index / width);
  const c = index % width;
  if (r < 0 || r >= height || c < 0 || c >= width) return null;
  const tl = pointIndex(width, r, c);
  const tr = pointIndex(width, r, c + 1);
  const bl = pointIndex(width, r + 1, c);
  const br = pointIndex(width, r + 1, c + 1);
  return mark === 1 ? [bl, tr] : [tl, br];
}

function findRoot(parent: number[], x: number): number {
  let cur = x;
  while (parent[cur] !== cur) cur = parent[cur];
  return cur;
}

/** ループを作らない斜線配置を深さ優先で構築する。 */
function buildSolution(width: number, height: number, seed: number): SlantMark[] {
  const total = width * height;
  const pointCount = (width + 1) * (height + 1);
  let rng = seed | 0;
  const rand = (): number => {
    const n = nextRandom(rng);
    rng = n.rng;
    return n.value;
  };

  for (let attempt = 0; attempt < 64; attempt++) {
    const order = Array.from({ length: total }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const solution: SlantMark[] = new Array(total).fill(0);
    const dfs = (k: number, parent: number[]): boolean => {
      if (k === order.length) return true;
      const idx = order[k];
      const options: SlantMark[] = rand() < 0.5 ? [1, 2] : [2, 1];
      for (const mark of options) {
        const ends = slantEndpoints(width, height, idx, mark);
        if (!ends) continue;
        const ra = findRoot(parent, ends[0]);
        const rb = findRoot(parent, ends[1]);
        if (ra === rb) continue; // この向きはループになる
        const next = [...parent];
        next[ra] = rb;
        solution[idx] = mark;
        if (dfs(k + 1, next)) return true;
        solution[idx] = 0;
      }
      return false;
    };
    const initial = Array.from({ length: pointCount }, (_, i) => i);
    if (dfs(0, initial)) return solution;
  }
  // 到達しないはずだが、安全側に全て "/"（ループなしにはならないため生成し直し側の責務）。
  // 実際には上の試行で必ず見つかる想定。万一の場合は例外にする。
  throw new Error("スラントの生成に失敗しました");
}

/** 斜線配置から各格子点に接する端点の数を数える。 */
export function slantPointCounts(width: number, height: number, board: SlantMark[]): number[] {
  const counts = new Array((width + 1) * (height + 1)).fill(0);
  for (let i = 0; i < board.length; i++) {
    const ends = slantEndpoints(width, height, i, board[i]);
    if (!ends) continue;
    counts[ends[0]]++;
    counts[ends[1]]++;
  }
  return counts;
}

export function createSlantGame(seed: number): SlantState {
  const width = SLANT_WIDTH;
  const height = SLANT_HEIGHT;
  const solution = buildSolution(width, height, seed | 0);
  const counts = slantPointCounts(width, height, solution);
  // 数字の表示: 0 と 4 は必ず表示し、それ以外は約半数を表示する。
  let rng = (seed | 0) ^ 0x5bd1e995;
  const clues: (number | null)[] = counts.map((count) => {
    if (count === 0 || count === 4) return count;
    const n = nextRandom(rng);
    rng = n.rng;
    return n.value < 0.55 ? count : null;
  });
  return {
    width,
    height,
    seed: seed | 0,
    solution,
    clues,
    board: new Array(width * height).fill(0) as SlantMark[],
    moves: 0,
    status: "playing",
  };
}

/** 格子点に隣接するマスの index 一覧。 */
function adjacentCells(width: number, height: number, point: number): number[] {
  const pr = Math.floor(point / (width + 1));
  const pc = point % (width + 1);
  const out: number[] = [];
  const candidates: [number, number][] = [
    [pr - 1, pc - 1], // 点は右下
    [pr - 1, pc], // 点は左下
    [pr, pc - 1], // 点は右上
    [pr, pc], // 点は左上
  ];
  for (const [r, c] of candidates) {
    if (r >= 0 && r < height && c >= 0 && c < width) out.push(r * width + c);
  }
  return out;
}

/** ルール違反を列挙する。 */
export function slantViolations(state: SlantState): SlantViolation[] {
  const { width, height, board, clues } = state;
  const out: SlantViolation[] = [];
  const counts = slantPointCounts(width, height, board);

  // 数字のある格子点: 端点が多すぎる、または周囲が全部埋まったのに数が合わない。
  for (let p = 0; p < clues.length; p++) {
    const clue = clues[p];
    if (clue === null) continue;
    const cells = adjacentCells(width, height, p);
    const touchCells = cells.filter((idx) => {
      const ends = slantEndpoints(width, height, idx, board[idx]);
      return ends !== null && (ends[0] === p || ends[1] === p);
    });
    if (counts[p] > clue) {
      out.push({
        type: "point",
        cells: touchCells,
        points: [p],
        message: `数字 ${clue} の点に斜線が ${counts[p]} 本つながっています`,
      });
    } else if (cells.every((idx) => board[idx] !== 0) && counts[p] !== clue) {
      out.push({
        type: "point",
        cells,
        points: [p],
        message: `数字 ${clue} の点につながる斜線が ${counts[p]} 本しかありません`,
      });
    }
  }

  // ループ検出: 斜線を順に加えていき、既につながっている点同士を結ぶ斜線がループを作る。
  const parent = Array.from({ length: (width + 1) * (height + 1) }, (_, i) => i);
  const loopCells: number[] = [];
  for (let i = 0; i < board.length; i++) {
    const ends = slantEndpoints(width, height, i, board[i]);
    if (!ends) continue;
    const ra = findRoot(parent, ends[0]);
    const rb = findRoot(parent, ends[1]);
    if (ra === rb) {
      loopCells.push(i);
    } else {
      parent[ra] = rb;
    }
  }
  if (loopCells.length > 0) {
    out.push({
      type: "loop",
      cells: loopCells,
      points: [],
      message: "斜線が輪（ループ）を作っています",
    });
  }
  return out;
}

export function checkSlant(state: SlantState): { complete: boolean; violations: SlantViolation[] } {
  const violations = slantViolations(state);
  const complete = state.board.every((v) => v !== 0) && violations.length === 0;
  return { complete, violations };
}

/** マスを 未定→/→\→未定 と循環させる。 */
export function cycleSlantCell(state: SlantState, index: number): SlantState {
  if (state.status === "won") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.board.length) return state;
  const board = [...state.board];
  const cur = board[index];
  board[index] = (cur === 0 ? 1 : cur === 1 ? 2 : 0) as SlantMark;
  const next: SlantState = { ...state, board, moves: state.moves + 1 };
  if (checkSlant(next).complete) next.status = "won";
  return next;
}

export function setSlantCell(state: SlantState, index: number, mark: SlantMark): SlantState {
  if (state.status === "won") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.board.length) return state;
  if (mark !== 0 && mark !== 1 && mark !== 2) return state;
  if (state.board[index] === mark) return state;
  const board = [...state.board];
  board[index] = mark;
  const next: SlantState = { ...state, board, moves: state.moves + 1 };
  if (checkSlant(next).complete) next.status = "won";
  return next;
}
