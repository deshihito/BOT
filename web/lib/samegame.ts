// セイムゲームの純粋ロジック（UI 非依存・シード決定的）。
// 5色のブロックが並んだ 12列×10行 の盤面で、同色でつながった2個以上の
// グループをタップして消す。消すと上のブロックが落ち（重力）、列が空に
// なると左へ詰める。もう消せるグループが無くなったら終了。
// スコア: グループ n 個を消すと n×(n-1) 点。終了時に残り個数ボーナス
// （残り0で1000点、それ以外は max(0, 10-残り)×10 点）が入る。

export const SG_COLS = 12;
export const SG_ROWS = 10;
export const SG_COLORS = 5;

export type SameGameStatus = "playing" | "finished";

export type SameGameState = {
  cols: number;
  rows: number;
  /** index = row*cols+col（row 0 が一番上）。null は空き。 */
  cells: (number | null)[];
  score: number;
  /** 終了時に加算されたボーナス（未終了は 0）。 */
  bonus: number;
  removed: number;
  moves: number;
  status: SameGameStatus;
  seed: number;
};

/** mulberry32（minesweeper 等と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function createSameGame(seed: number): SameGameState {
  let rng = seed | 0;
  const cells: (number | null)[] = [];
  for (let i = 0; i < SG_COLS * SG_ROWS; i++) {
    const r = nextRandom(rng);
    rng = r.rng;
    cells.push(Math.floor(r.value * SG_COLORS));
  }
  const state: SameGameState = {
    cols: SG_COLS,
    rows: SG_ROWS,
    cells,
    score: 0,
    bonus: 0,
    removed: 0,
    moves: 0,
    status: "playing",
    seed: seed | 0,
  };
  // ごく稀に最初から消せるグループが無い盤面になるため、その場合は終了扱い。
  if (!sameGameHasMoves(state)) return finishGame(state);
  return state;
}

/** index のセルを含む同色連結グループ（4方向）の index 一覧。空きや範囲外は空配列。 */
export function sameGameGroupAt(state: SameGameState, index: number): number[] {
  const { cols, rows, cells } = state;
  if (!Number.isInteger(index) || index < 0 || index >= cells.length) return [];
  const color = cells[index];
  if (color === null) return [];
  const seen = new Array<boolean>(cells.length).fill(false);
  const group: number[] = [];
  const stack = [index];
  seen[index] = true;
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    group.push(cur);
    const r = Math.floor(cur / cols);
    const c = cur % cols;
    const neighbors: number[] = [];
    if (r > 0) neighbors.push(cur - cols);
    if (r < rows - 1) neighbors.push(cur + cols);
    if (c > 0) neighbors.push(cur - 1);
    if (c < cols - 1) neighbors.push(cur + 1);
    for (const n of neighbors) {
      if (!seen[n] && cells[n] === color) {
        seen[n] = true;
        stack.push(n);
      }
    }
  }
  return group;
}

/** グループ n 個を消したときの得点。 */
export function sameGameGroupScore(n: number): number {
  return n >= 2 ? n * (n - 1) : 0;
}

/** 残り個数に対する終了ボーナス。 */
export function sameGameEndBonus(remaining: number): number {
  if (remaining === 0) return 1000;
  return Math.max(0, 10 - remaining) * 10;
}

export function sameGameRemaining(state: SameGameState): number {
  return state.cells.filter((c) => c !== null).length;
}

/** 消せるグループ（2個以上の連結）が残っているか。 */
export function sameGameHasMoves(state: SameGameState): boolean {
  const { cols, rows, cells } = state;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === null) continue;
    const r = Math.floor(i / cols);
    const c = i % cols;
    if (c < cols - 1 && cells[i + 1] === cells[i]) return true;
    if (r < rows - 1 && cells[i + cols] === cells[i]) return true;
  }
  return false;
}

/** 重力（下へ落下）と列の左詰めを適用した cells を返す。 */
export function sameGameSettle(cellsIn: (number | null)[], cols: number, rows: number): (number | null)[] {
  // 列ごとに下へ詰める
  const columns: (number | null)[][] = [];
  for (let c = 0; c < cols; c++) {
    const kept: (number | null)[] = [];
    for (let r = rows - 1; r >= 0; r--) {
      const v = cellsIn[r * cols + c];
      if (v !== null) kept.push(v);
    }
    // kept は下から上の順。列の配列は上→下に直す
    const col: (number | null)[] = new Array(rows).fill(null);
    for (let i = 0; i < kept.length; i++) {
      col[rows - 1 - i] = kept[i];
    }
    columns.push(col);
  }
  // 空列を右へ寄せ、非空列を左へ詰める
  const nonEmpty = columns.filter((col) => col.some((v) => v !== null));
  while (nonEmpty.length < cols) nonEmpty.push(new Array(rows).fill(null));
  const out: (number | null)[] = new Array(cols * rows).fill(null);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      out[r * cols + c] = nonEmpty[c][r];
    }
  }
  return out;
}

function finishGame(state: SameGameState): SameGameState {
  const bonus = sameGameEndBonus(sameGameRemaining(state));
  return { ...state, status: "finished", bonus, score: state.score + bonus };
}

/**
 * index のグループを消す。グループが2個未満・終了後・範囲外は同状態を返す。
 */
export function removeSameGameGroup(state: SameGameState, index: number): SameGameState {
  if (state.status !== "playing") return state;
  const group = sameGameGroupAt(state, index);
  if (group.length < 2) return state;
  const cells = [...state.cells];
  for (const i of group) cells[i] = null;
  const settled = sameGameSettle(cells, state.cols, state.rows);
  const next: SameGameState = {
    ...state,
    cells: settled,
    score: state.score + sameGameGroupScore(group.length),
    removed: state.removed + group.length,
    moves: state.moves + 1,
  };
  if (!sameGameHasMoves(next)) return finishGame(next);
  return next;
}
