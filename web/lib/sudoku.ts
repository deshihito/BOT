// 数独の純粋ロジック（UI 非依存・シード決定的）。
// 完成盤を生成し、唯一解を保ちながら穴あけする。状態は JSON 化可能な値のみで持ち、
// 関数は状態を破壊せず新しい状態を返す。

export type SudokuDifficulty = "easy" | "normal" | "hard";
export type SudokuStatus = "playing" | "won";

export type SudokuState = {
  difficulty: SudokuDifficulty;
  seed: number;
  /** 完成盤（81マス、1〜9）。 */
  solution: number[];
  /** 初期盤（0 = 空き）。 */
  puzzle: number[];
  /** 与えられた数字かどうか（81マス）。 */
  givens: boolean[];
  /** 現在の盤面（0 = 空き、1〜9 = 入力）。 */
  board: number[];
  /** メモ（各マスに候補数字の昇順配列）。 */
  notes: number[][];
  mistakes: number;
  hintsLeft: number;
  hintsTotal: number;
  status: SudokuStatus;
  /** 直近にヒントで埋めたマス（表示用、無ければ null）。 */
  lastHint: number | null;
};

export const SUDOKU_HOLES: Record<SudokuDifficulty, number> = {
  easy: 36,
  normal: 46,
  hard: 54,
};

export const SUDOKU_HINTS: Record<SudokuDifficulty, number> = {
  easy: 5,
  normal: 3,
  hard: 3,
};

function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function shuffled<T>(items: T[], rng: number): { items: T[]; rng: number } {
  const arr = [...items];
  let cur = rng;
  for (let i = arr.length - 1; i > 0; i--) {
    const r = nextRandom(cur);
    cur = r.rng;
    const j = Math.floor(r.value * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return { items: arr, rng: cur };
}

function isSafe(board: number[], index: number, value: number): boolean {
  const row = Math.floor(index / 9);
  const col = index % 9;
  for (let c = 0; c < 9; c++) if (board[row * 9 + c] === value) return false;
  for (let r = 0; r < 9; r++) if (board[r * 9 + col] === value) return false;
  const br = Math.floor(row / 3) * 3;
  const bc = Math.floor(col / 3) * 3;
  for (let r = br; r < br + 3; r++) {
    for (let c = bc; c < bc + 3; c++) {
      if (board[r * 9 + c] === value) return false;
    }
  }
  return true;
}

function candidatesFor(board: number[], index: number): number[] {
  if (board[index] !== 0) return [];
  const out: number[] = [];
  for (let v = 1; v <= 9; v++) if (isSafe(board, index, v)) out.push(v);
  return out;
}

/** 解の数を数える（limit で打ち切り）。唯一解判定に使う。 */
export function countSolutions(board: number[], limit = 2): number {
  const work = [...board];
  // 与えられた数字同士の矛盾を先に検出する
  for (let i = 0; i < 81; i++) {
    if (work[i] === 0) continue;
    const v = work[i];
    work[i] = 0;
    if (!isSafe(work, i, v)) return 0;
    work[i] = v;
  }
  let count = 0;
  const solve = (): boolean => {
    if (count >= limit) return true;
    // MRV: 候補が最小の空きマスを選ぶ
    let best = -1;
    let bestCands: number[] | null = null;
    for (let i = 0; i < 81; i++) {
      if (work[i] !== 0) continue;
      const cands = candidatesFor(work, i);
      if (cands.length === 0) return false;
      if (bestCands === null || cands.length < bestCands.length) {
        best = i;
        bestCands = cands;
        if (cands.length === 1) break;
      }
    }
    if (best === -1) {
      count++;
      return count >= limit;
    }
    for (const v of bestCands as number[]) {
      work[best] = v;
      solve();
      work[best] = 0;
      if (count >= limit) return true;
    }
    return false;
  };
  solve();
  return count;
}

/** 盤が完成盤として正しいか（全マス 1〜9 で行列ブロックに重複なし）。 */
export function isValidCompleteBoard(board: number[]): boolean {
  if (board.length !== 81) return false;
  if (board.some((v) => v < 1 || v > 9)) return false;
  const unitOk = (indices: number[]) => {
    const set = new Set(indices.map((i) => board[i]));
    return set.size === 9;
  };
  for (let r = 0; r < 9; r++) {
    if (!unitOk(Array.from({ length: 9 }, (_, c) => r * 9 + c))) return false;
  }
  for (let c = 0; c < 9; c++) {
    if (!unitOk(Array.from({ length: 9 }, (_, r) => r * 9 + c))) return false;
  }
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const idx: number[] = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) idx.push((br * 3 + r) * 9 + (bc * 3 + c));
      if (!unitOk(idx)) return false;
    }
  }
  return true;
}

/** 完成盤をバックトラックで生成する。 */
function generateSolution(rng: number): { solution: number[]; rng: number } {
  const board = Array<number>(81).fill(0);
  let cur = rng;
  const fill = (pos: number): boolean => {
    if (pos === 81) return true;
    if (board[pos] !== 0) return fill(pos + 1);
    const s = shuffled([1, 2, 3, 4, 5, 6, 7, 8, 9], cur);
    cur = s.rng;
    for (const v of s.items) {
      if (isSafe(board, pos, v)) {
        board[pos] = v;
        if (fill(pos + 1)) return true;
        board[pos] = 0;
      }
    }
    return false;
  };
  fill(0);
  return { solution: board, rng: cur };
}

export function createSudokuGame(difficulty: SudokuDifficulty, seed: number): SudokuState {
  const safeDifficulty: SudokuDifficulty =
    difficulty === "easy" || difficulty === "normal" || difficulty === "hard" ? difficulty : "easy";
  const { solution, rng: rngAfter } = generateSolution(seed | 0);
  let rng = rngAfter;
  const puzzle = [...solution];
  const targetHoles = SUDOKU_HOLES[safeDifficulty];
  const order = shuffled(
    Array.from({ length: 81 }, (_, i) => i),
    rng,
  );
  rng = order.rng;
  let holes = 0;
  for (const idx of order.items) {
    if (holes >= targetHoles) break;
    const backup = puzzle[idx];
    puzzle[idx] = 0;
    if (countSolutions(puzzle, 2) !== 1) {
      puzzle[idx] = backup;
    } else {
      holes++;
    }
  }
  const givens = puzzle.map((v) => v !== 0);
  const hintsTotal = SUDOKU_HINTS[safeDifficulty];
  return {
    difficulty: safeDifficulty,
    seed: seed | 0,
    solution,
    puzzle: [...puzzle],
    givens,
    board: [...puzzle],
    notes: Array.from({ length: 81 }, () => [] as number[]),
    mistakes: 0,
    hintsLeft: hintsTotal,
    hintsTotal,
    status: "playing",
    lastHint: null,
  };
}

/** 盤面が完成（解答と完全一致）しているか。 */
export function isComplete(state: SudokuState): boolean {
  return state.board.every((v, i) => v === state.solution[i]);
}

/** 矛盾しているマスの集合（同じ行・列・ブロックで重複している入力）。ヒント用にも使う。 */
export function conflictIndexes(state: SudokuState): Set<number> {
  const out = new Set<number>();
  const board = state.board;
  const checkUnit = (indices: number[]) => {
    const seen = new Map<number, number[]>();
    for (const i of indices) {
      const v = board[i];
      if (v === 0) continue;
      const list = seen.get(v) ?? [];
      list.push(i);
      seen.set(v, list);
    }
    for (const list of seen.values()) {
      if (list.length > 1) list.forEach((i) => out.add(i));
    }
  };
  for (let r = 0; r < 9; r++) checkUnit(Array.from({ length: 9 }, (_, c) => r * 9 + c));
  for (let c = 0; c < 9; c++) checkUnit(Array.from({ length: 9 }, (_, r) => r * 9 + c));
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const idx: number[] = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) idx.push((br * 3 + r) * 9 + (bc * 3 + c));
      checkUnit(idx);
    }
  }
  return out;
}

/** 解答と食い違っているマスかどうか（ミス表示用）。 */
export function isMistake(state: SudokuState, index: number): boolean {
  const v = state.board[index];
  return v !== 0 && v !== state.solution[index];
}

export function setCell(state: SudokuState, index: number, value: number): SudokuState {
  if (state.status === "won") return state;
  if (!Number.isInteger(index) || index < 0 || index >= 81) return state;
  if (!Number.isInteger(value) || value < 0 || value > 9) return state;
  if (state.givens[index]) return state;
  if (state.board[index] === value) return state;
  const board = [...state.board];
  board[index] = value;
  const notes = state.notes.map((n, i) => (i === index ? [] : [...n]));
  // 同じ行・列・ブロックのメモから入力した数字を取り除く
  if (value !== 0) {
    const row = Math.floor(index / 9);
    const col = index % 9;
    const br = Math.floor(row / 3) * 3;
    const bc = Math.floor(col / 3) * 3;
    const peers = new Set<number>();
    for (let c = 0; c < 9; c++) peers.add(row * 9 + c);
    for (let r = 0; r < 9; r++) peers.add(r * 9 + col);
    for (let r = br; r < br + 3; r++) for (let c = bc; c < bc + 3; c++) peers.add(r * 9 + c);
    peers.forEach((p) => {
      if (notes[p].includes(value)) notes[p] = notes[p].filter((v) => v !== value);
    });
  }
  const wasMistake = value !== 0 && value !== state.solution[index];
  const next: SudokuState = {
    ...state,
    board,
    notes,
    mistakes: state.mistakes + (wasMistake ? 1 : 0),
    lastHint: null,
  };
  if (isComplete(next)) return { ...next, status: "won" };
  return next;
}

export function clearCell(state: SudokuState, index: number): SudokuState {
  return setCell(state, index, 0);
}

export function toggleNote(state: SudokuState, index: number, value: number): SudokuState {
  if (state.status === "won") return state;
  if (!Number.isInteger(index) || index < 0 || index >= 81) return state;
  if (!Number.isInteger(value) || value < 1 || value > 9) return state;
  if (state.givens[index]) return state;
  if (state.board[index] !== 0) return state;
  const notes = state.notes.map((n) => [...n]);
  const cur = notes[index];
  notes[index] = cur.includes(value)
    ? cur.filter((v) => v !== value)
    : [...cur, value].sort((a, b) => a - b);
  return { ...state, notes, lastHint: null };
}

/** ヒント対象のマス（空き or 誤りで最も行番号が小さいもの）。無ければ -1。 */
export function findHintIndex(state: SudokuState): number {
  for (let i = 0; i < 81; i++) {
    if (state.givens[i]) continue;
    if (state.board[i] !== state.solution[i]) return i;
  }
  return -1;
}

export function applyHint(state: SudokuState): SudokuState {
  if (state.status === "won") return state;
  if (state.hintsLeft <= 0) return state;
  const idx = findHintIndex(state);
  if (idx === -1) return state;
  const board = [...state.board];
  board[idx] = state.solution[idx];
  const notes = state.notes.map((n, i) => (i === idx ? [] : [...n]));
  const next: SudokuState = {
    ...state,
    board,
    notes,
    hintsLeft: state.hintsLeft - 1,
    lastHint: idx,
  };
  if (isComplete(next)) return { ...next, status: "won" };
  return next;
}

export function emptyCount(state: SudokuState): number {
  return state.board.filter((v) => v === 0).length;
}
