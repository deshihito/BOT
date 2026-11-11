// バイナリー（Binairo）の純粋ロジック（UI 非依存・シード決定的）。
// ルール: 6x6 の各マスに 0 か 1 を入れる。
// - 各行・各列で 0 と 1 が同数（3つずつ）になる。
// - 同じ数字が縦横に3つ以上連続しない。
// - 完全に埋まった行同士・列同士が同じ並びにならない。
// 生成は「解を先に作る」方式: ルールを満たす完成盤を作り、一部のマスを伏せる。
// 伏せた盤面の一意解であることは保証しない（完成判定は正解との一致ではなく
// ルール検証で行うため、ルールを満たす別解でもクリアになる）。

export const BINAIRO_SIZE = 6;
/** -1 = 空き。 */
export type BinairoValue = -1 | 0 | 1;

export type BinairoViolationType = "triple" | "count" | "dupRow" | "dupCol";

export type BinairoViolation = {
  type: BinairoViolationType;
  cells: number[];
  message: string;
};

export type BinairoState = {
  size: number;
  seed: number;
  /** 正解盤面（0/1）。生成の検証用に保持する。 */
  solution: number[];
  /** 最初から与えられたマスかどうか。 */
  givens: boolean[];
  /** 現在の盤面（-1 = 空き）。 */
  board: BinairoValue[];
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

function shuffled<T>(items: T[], rng: number): { items: T[]; rng: number } {
  const arr = [...items];
  let r = rng;
  for (let i = arr.length - 1; i > 0; i--) {
    const n = nextRandom(r);
    r = n.rng;
    const j = Math.floor(n.value * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return { items: arr, rng: r };
}

/** 行として有効な並び（0/1 が3つずつ・3連続なし）の一覧。 */
function rowPatterns(): number[][] {
  const out: number[][] = [];
  for (let mask = 0; mask < 64; mask++) {
    const row = Array.from({ length: BINAIRO_SIZE }, (_, i) => (mask >> (BINAIRO_SIZE - 1 - i)) & 1);
    if (row.reduce((a, b) => a + b, 0) !== 3) continue;
    let ok = true;
    for (let i = 0; i + 2 < BINAIRO_SIZE; i++) {
      if (row[i] === row[i + 1] && row[i + 1] === row[i + 2]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(row);
  }
  return out;
}

const ROW_PATTERNS = rowPatterns();

function buildSolution(rng: number): { solution: number[]; rng: number } {
  // 行パターンを候補に、列の条件（3連続禁止・0/1 各3つまで・列の重複禁止）を
  // 満たす組み合わせを深さ優先のバックトラックで探す。解は必ず存在する。
  let cur = rng;
  const rows: number[][] = [];
  const used = new Set<string>();

  const canPlace = (p: number[]): boolean => {
    if (used.has(p.join(""))) return false;
    const r = rows.length;
    for (let c = 0; c < BINAIRO_SIZE; c++) {
      if (r >= 2 && rows[r - 1][c] === p[c] && rows[r - 2][c] === p[c]) return false;
      let ones = p[c];
      for (let k = 0; k < r; k++) ones += rows[k][c];
      if (ones > 3) return false;
      if (r + 1 - ones > 3) return false;
    }
    return true;
  };

  const columnsDistinct = (): boolean => {
    const seen = new Set<string>();
    for (let c = 0; c < BINAIRO_SIZE; c++) {
      const col = rows.map((row) => row[c]).join("");
      if (seen.has(col)) return false;
      seen.add(col);
    }
    return true;
  };

  const dfs = (): boolean => {
    if (rows.length === BINAIRO_SIZE) return columnsDistinct();
    const order = shuffled(ROW_PATTERNS, cur);
    cur = order.rng;
    for (const p of order.items) {
      if (!canPlace(p)) continue;
      rows.push(p);
      used.add(p.join(""));
      if (dfs()) return true;
      rows.pop();
      used.delete(p.join(""));
    }
    return false;
  };

  dfs();
  const solution: number[] = [];
  for (const row of rows) solution.push(...row);
  return { solution, rng: cur };
}

export function createBinairoGame(seed: number, hiddenCount = 22): BinairoState {
  let rng = seed | 0;
  const built = buildSolution(rng);
  rng = built.rng;
  const total = BINAIRO_SIZE * BINAIRO_SIZE;
  const order = shuffled(
    Array.from({ length: total }, (_, i) => i),
    rng,
  );
  const hidden = Math.max(0, Math.min(hiddenCount, total - 6));
  const hiddenSet = new Set(order.items.slice(0, hidden));
  const givens = Array.from({ length: total }, (_, i) => !hiddenSet.has(i));
  const board: BinairoValue[] = built.solution.map((v, i) =>
    givens[i] ? (v as BinairoValue) : -1,
  );
  return {
    size: BINAIRO_SIZE,
    seed: seed | 0,
    solution: built.solution,
    givens,
    board,
    moves: 0,
    status: "playing",
  };
}

/** ルール違反を列挙する（空きマス自体は違反にしない）。 */
export function binairoViolations(state: BinairoState): BinairoViolation[] {
  const { size, board } = state;
  const out: BinairoViolation[] = [];
  const at = (r: number, c: number): BinairoValue => board[r * size + c];

  // 3連続（行・列）。
  for (let r = 0; r < size; r++) {
    for (let c = 0; c + 2 < size; c++) {
      const v = at(r, c);
      if (v !== -1 && v === at(r, c + 1) && v === at(r, c + 2)) {
        out.push({
          type: "triple",
          cells: [r * size + c, r * size + c + 1, r * size + c + 2],
          message: `${v} が横に3つ並んでいます`,
        });
      }
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r + 2 < size; r++) {
      const v = at(r, c);
      if (v !== -1 && v === at(r + 1, c) && v === at(r + 2, c)) {
        out.push({
          type: "triple",
          cells: [r * size + c, (r + 1) * size + c, (r + 2) * size + c],
          message: `${v} が縦に3つ並んでいます`,
        });
      }
    }
  }
  // 個数の上限（行・列とも各3つまで）。
  for (let r = 0; r < size; r++) {
    for (const v of [0, 1] as const) {
      const cells: number[] = [];
      for (let c = 0; c < size; c++) if (at(r, c) === v) cells.push(r * size + c);
      if (cells.length > 3) {
        out.push({ type: "count", cells, message: `${r + 1}行目に ${v} が4つ以上あります` });
      }
    }
  }
  for (let c = 0; c < size; c++) {
    for (const v of [0, 1] as const) {
      const cells: number[] = [];
      for (let r = 0; r < size; r++) if (at(r, c) === v) cells.push(r * size + c);
      if (cells.length > 3) {
        out.push({ type: "count", cells, message: `${c + 1}列目に ${v} が4つ以上あります` });
      }
    }
  }
  // 埋まった行同士・列同士の重複。
  const rowKey = (r: number): string | null => {
    const vals: BinairoValue[] = [];
    for (let c = 0; c < size; c++) {
      const v = at(r, c);
      if (v === -1) return null;
      vals.push(v);
    }
    return vals.join("");
  };
  const colKey = (c: number): string | null => {
    const vals: BinairoValue[] = [];
    for (let r = 0; r < size; r++) {
      const v = at(r, c);
      if (v === -1) return null;
      vals.push(v);
    }
    return vals.join("");
  };
  for (let r = 0; r < size; r++) {
    const key = rowKey(r);
    if (key === null) continue;
    for (let r2 = r + 1; r2 < size; r2++) {
      if (rowKey(r2) === key) {
        out.push({
          type: "dupRow",
          cells: [
            ...Array.from({ length: size }, (_, c) => r * size + c),
            ...Array.from({ length: size }, (_, c) => r2 * size + c),
          ],
          message: `${r + 1}行目と ${r2 + 1}行目が同じ並びです`,
        });
      }
    }
  }
  for (let c = 0; c < size; c++) {
    const key = colKey(c);
    if (key === null) continue;
    for (let c2 = c + 1; c2 < size; c2++) {
      if (colKey(c2) === key) {
        out.push({
          type: "dupCol",
          cells: [
            ...Array.from({ length: size }, (_, r) => r * size + c),
            ...Array.from({ length: size }, (_, r) => r * size + c2),
          ],
          message: `${c + 1}列目と ${c2 + 1}列目が同じ並びです`,
        });
      }
    }
  }
  return out;
}

export function checkBinairo(state: BinairoState): { complete: boolean; violations: BinairoViolation[] } {
  const violations = binairoViolations(state);
  const complete = state.board.every((v) => v !== -1) && violations.length === 0;
  return { complete, violations };
}

/** マスを 空き→0→1→空き と循環させる。与えられたマスは変更できない。 */
export function cycleBinairoCell(state: BinairoState, index: number): BinairoState {
  if (state.status === "won") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.board.length) return state;
  if (state.givens[index]) return state;
  const board = [...state.board];
  const cur = board[index];
  board[index] = cur === -1 ? 0 : cur === 0 ? 1 : -1;
  const next: BinairoState = { ...state, board, moves: state.moves + 1 };
  if (checkBinairo(next).complete) next.status = "won";
  return next;
}

export function setBinairoCell(state: BinairoState, index: number, value: BinairoValue): BinairoState {
  if (state.status === "won") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.board.length) return state;
  if (value !== -1 && value !== 0 && value !== 1) return state;
  if (state.givens[index]) return state;
  if (state.board[index] === value) return state;
  const board = [...state.board];
  board[index] = value;
  const next: BinairoState = { ...state, board, moves: state.moves + 1 };
  if (checkBinairo(next).complete) next.status = "won";
  return next;
}
