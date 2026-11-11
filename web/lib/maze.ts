// めいろの純粋ロジック（UI 非依存・シード決定的）。
// 壁は各マスのビットマスク（1=北 2=東 4=南 8=西）で持ち、JSON 化可能に保つ。
// 生成は反復型の再帰的バックトラッキングで、必ず「全マス到達可能・ループなし」の
// 完全迷路（全域木）になる。同じシードでは同じ迷路になる。

export type MazeSizeKey = "small" | "medium" | "large";
export type MazeDir = "up" | "right" | "down" | "left";
export type MazeStatus = "playing" | "won";

export type MazeState = {
  size: MazeSizeKey;
  cols: number;
  rows: number;
  /** 各マスの壁ビットマスク（row-major）。 */
  walls: number[];
  /** スタートマスの index（常に 0）。 */
  start: number;
  /** ゴールマスの index（常に最終マス）。 */
  goal: number;
  /** 現在位置の index。 */
  player: number;
  moves: number;
  status: MazeStatus;
  /** 生成時に求めた最短路（start → goal の index 列）。 */
  solution: number[];
  seed: number;
};

export const MAZE_SIZES: Record<MazeSizeKey, { cols: number; rows: number; label: string }> = {
  small: { cols: 10, rows: 8, label: "ちいさい" },
  medium: { cols: 16, rows: 12, label: "ふつう" },
  large: { cols: 24, rows: 18, label: "おおきい" },
};

export function normalizeMazeSize(size: string): MazeSizeKey {
  if (size === "small" || size === "large") return size;
  return "medium";
}

const WALL_BIT: Record<MazeDir, number> = { up: 1, right: 2, down: 4, left: 8 };
const OPPOSITE: Record<MazeDir, MazeDir> = { up: "down", right: "left", down: "up", left: "right" };
const DIRS: MazeDir[] = ["up", "right", "down", "left"];

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function mazeIndex(cols: number, row: number, col: number): number {
  return row * cols + col;
}

export function mazeRowCol(cols: number, index: number): { row: number; col: number } {
  return { row: Math.floor(index / cols), col: index % cols };
}

/** index から dir 方向の隣接マス。盤外なら -1。 */
export function mazeNeighbor(cols: number, rows: number, index: number, dir: MazeDir): number {
  const { row, col } = mazeRowCol(cols, index);
  if (dir === "up") return row > 0 ? index - cols : -1;
  if (dir === "down") return row < rows - 1 ? index + cols : -1;
  if (dir === "left") return col > 0 ? index - 1 : -1;
  return col < cols - 1 ? index + 1 : -1;
}

/** index のマスから dir 方向へ壁なしで進めるか。 */
export function canMoveDir(state: MazeState, index: number, dir: MazeDir): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= state.walls.length) return false;
  if ((state.walls[index] & WALL_BIT[dir]) !== 0) return false;
  return mazeNeighbor(state.cols, state.rows, index, dir) >= 0;
}

/** 壁を無視せずに到達可能なマスを BFS で数える（完全性の検証用にも使う）。 */
export function reachableCount(state: MazeState, from: number): number {
  const seen = new Set<number>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift() as number;
    for (const dir of DIRS) {
      if (!canMoveDir(state, cur, dir)) continue;
      const next = mazeNeighbor(state.cols, state.rows, cur, dir);
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen.size;
}

/** 開いている通路の本数（無向辺の数）。完全迷路では マス数-1 になる。 */
export function openPassageCount(state: MazeState): number {
  let count = 0;
  for (let i = 0; i < state.walls.length; i++) {
    if (canMoveDir(state, i, "right")) count++;
    if (canMoveDir(state, i, "down")) count++;
  }
  return count;
}

/** start → goal の最短路を BFS で返す。到達不能なら空配列。 */
export function solveMaze(state: MazeState): number[] {
  const prev = new Map<number, number>();
  const seen = new Set<number>([state.start]);
  const queue = [state.start];
  while (queue.length > 0) {
    const cur = queue.shift() as number;
    if (cur === state.goal) break;
    for (const dir of DIRS) {
      if (!canMoveDir(state, cur, dir)) continue;
      const next = mazeNeighbor(state.cols, state.rows, cur, dir);
      if (!seen.has(next)) {
        seen.add(next);
        prev.set(next, cur);
        queue.push(next);
      }
    }
  }
  if (!seen.has(state.goal)) return [];
  const path = [state.goal];
  let cur = state.goal;
  while (cur !== state.start) {
    cur = prev.get(cur) as number;
    path.push(cur);
  }
  return path.reverse();
}

export function createMazeGame(size: MazeSizeKey | string, seed: number): MazeState {
  const sizeKey = normalizeMazeSize(size);
  const { cols, rows } = MAZE_SIZES[sizeKey];
  const total = cols * rows;
  // 最初は全マス四方を壁で囲む
  const walls = Array<number>(total).fill(15);
  const visited = Array<boolean>(total).fill(false);
  let rng = seed | 0;

  // 再帰的バックトラッキング（反復版）で全域木を掘る
  visited[0] = true;
  const stack = [0];
  while (stack.length > 0) {
    const cur = stack[stack.length - 1];
    const options: { dir: MazeDir; next: number }[] = [];
    for (const dir of DIRS) {
      const next = mazeNeighbor(cols, rows, cur, dir);
      if (next >= 0 && !visited[next]) options.push({ dir, next });
    }
    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const r = nextRandom(rng);
    rng = r.rng;
    const picked = options[Math.floor(r.value * options.length)];
    walls[cur] &= ~WALL_BIT[picked.dir];
    walls[picked.next] &= ~WALL_BIT[OPPOSITE[picked.dir]];
    visited[picked.next] = true;
    stack.push(picked.next);
  }

  const base: MazeState = {
    size: sizeKey,
    cols,
    rows,
    walls,
    start: 0,
    goal: total - 1,
    player: 0,
    moves: 0,
    status: "playing",
    solution: [],
    seed: seed | 0,
  };
  return { ...base, solution: solveMaze(base) };
}

/** 現在位置から dir へ1マス進む。壁に阻まれた・終了済み・不正方向なら同じ状態を返す。 */
export function movePlayer(state: MazeState, dir: MazeDir): MazeState {
  if (state.status !== "playing") return state;
  if (dir !== "up" && dir !== "right" && dir !== "down" && dir !== "left") return state;
  if (!canMoveDir(state, state.player, dir)) return state;
  const player = mazeNeighbor(state.cols, state.rows, state.player, dir);
  const won = player === state.goal;
  return { ...state, player, moves: state.moves + 1, status: won ? "won" : "playing" };
}
