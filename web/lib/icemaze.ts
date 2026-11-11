// 氷の迷路の純粋ロジック（UI 非依存・シード決定的）。
// 方向を選ぶと、壁か障害物にぶつかるまで滑り続ける。ゴールマスに「止まれたら」
// クリアで、ゴールを通過しただけではクリアにならない。
// 生成: シード決定的に壁を配置し、滑り状態の BFS で「スタートからゴールに
// 止まれること」と最短手数（滑りの回数）を検証した盤面だけを採用するため、
// 提示される盤面は必ず到達可能で、最短手数も正確。
// 状態は JSON 化可能な値だけを持ち、遷移は非破壊。

export type IceDir = "up" | "right" | "down" | "left";
export type IceStatus = "playing" | "won";

export type IceState = {
  cols: number;
  rows: number;
  /** 壁マスなら true（row-major）。 */
  walls: boolean[];
  /** スタートマスの index。 */
  start: number;
  /** ゴールマスの index。 */
  goal: number;
  /** 現在位置の index。 */
  player: number;
  /** これまでの滑り回数（undo で戻る）。 */
  moves: number;
  /** 滑る前の位置の履歴（undo 用、古い順）。 */
  history: number[];
  status: IceStatus;
  /** 生成時に BFS で求めた最短の滑り回数。 */
  minMoves: number;
  seed: number;
};

export const ICE_COLS = 9;
export const ICE_ROWS = 9;
/** 壁の密度の目安（外周を除く内側に対する割合）。 */
export const ICE_WALL_DENSITY = 0.16;
/** 採用条件: 最短手数がこれ未満の盤面は簡単すぎるので作り直す。 */
export const ICE_MIN_SOLUTION = 5;

const DIRS: IceDir[] = ["up", "right", "down", "left"];

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function iceIndex(cols: number, row: number, col: number): number {
  return row * cols + col;
}

export function iceRowCol(cols: number, index: number): { row: number; col: number } {
  return { row: Math.floor(index / cols), col: index % cols };
}

function dirDelta(dir: IceDir): { dr: number; dc: number } {
  if (dir === "up") return { dr: -1, dc: 0 };
  if (dir === "down") return { dr: 1, dc: 0 };
  if (dir === "left") return { dr: 0, dc: -1 };
  return { dr: 0, dc: 1 };
}

/**
 * from から dir 方向へ滑ったときの停止位置。
 * 壁マス・盤外の手前で止まる。1マスも動けない場合は from をそのまま返す。
 */
export function slideDestination(
  cols: number,
  rows: number,
  walls: boolean[],
  from: number,
  dir: IceDir,
): number {
  if (!Number.isInteger(from) || from < 0 || from >= cols * rows) return from;
  const { dr, dc } = dirDelta(dir);
  let { row, col } = iceRowCol(cols, from);
  for (;;) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) break;
    if (walls[iceIndex(cols, nr, nc)]) break;
    row = nr;
    col = nc;
  }
  return iceIndex(cols, row, col);
}

/** 滑り状態の BFS で start から goal へ止まれる最短の滑り回数。到達不能なら -1。 */
export function computeMinMoves(
  cols: number,
  rows: number,
  walls: boolean[],
  start: number,
  goal: number,
): number {
  if (start === goal) return 0;
  const dist = new Map<number, number>([[start, 0]]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift() as number;
    const d = dist.get(cur) as number;
    for (const dir of DIRS) {
      const dest = slideDestination(cols, rows, walls, cur, dir);
      if (dest === cur || dist.has(dest)) continue;
      if (dest === goal) return d + 1;
      dist.set(dest, d + 1);
      queue.push(dest);
    }
  }
  return -1;
}

function buildCandidate(
  cols: number,
  rows: number,
  rng: number,
): { walls: boolean[]; rng: number } {
  const walls: boolean[] = new Array(cols * rows).fill(false);
  const start = iceIndex(cols, 0, 0);
  const goal = iceIndex(cols, rows - 1, cols - 1);
  let state = rng;
  for (let i = 0; i < walls.length; i++) {
    if (i === start || i === goal) continue;
    const r = nextRandom(state);
    state = r.rng;
    walls[i] = r.value < ICE_WALL_DENSITY;
  }
  return { walls, rng: state };
}

/**
 * 必ず解ける盤面を生成する。壁配置の試行をシード決定的に繰り返し、
 * BFS で到達可能かつ最短手数が ICE_MIN_SOLUTION 以上の盤面を採用する。
 * 規定回数で見つからなければ、その中で最短手数が最大だった盤面を使う。
 */
export function createIceMaze(seed: number): IceState {
  const cols = ICE_COLS;
  const rows = ICE_ROWS;
  const start = iceIndex(cols, 0, 0);
  const goal = iceIndex(cols, rows - 1, cols - 1);
  let rng = seed | 0;
  let fallback: { walls: boolean[]; minMoves: number } | null = null;
  for (let attempt = 0; attempt < 300; attempt++) {
    const cand = buildCandidate(cols, rows, rng);
    rng = cand.rng;
    const minMoves = computeMinMoves(cols, rows, cand.walls, start, goal);
    if (minMoves < 0) continue;
    if (!fallback || minMoves > fallback.minMoves) fallback = { walls: cand.walls, minMoves };
    if (minMoves >= ICE_MIN_SOLUTION) {
      return makeState(cols, rows, cand.walls, start, goal, minMoves, seed);
    }
  }
  // 300回で条件を満たさなくても、到達可能な盤面が1つでもあればそれを使う。
  if (fallback) return makeState(cols, rows, fallback.walls, start, goal, fallback.minMoves, seed);
  // 最終手段: 壁なし盤面（角から角へ2手で到達可能）。
  const empty: boolean[] = new Array(cols * rows).fill(false);
  return makeState(cols, rows, empty, start, goal, computeMinMoves(cols, rows, empty, start, goal), seed);
}

function makeState(
  cols: number,
  rows: number,
  walls: boolean[],
  start: number,
  goal: number,
  minMoves: number,
  seed: number,
): IceState {
  return {
    cols,
    rows,
    walls: [...walls],
    start,
    goal,
    player: start,
    moves: 0,
    history: [],
    status: "playing",
    minMoves,
    seed,
  };
}

/** dir 方向へ滑る。動けない・終了済みなら同一参照を返す。 */
export function slideIce(state: IceState, dir: IceDir): IceState {
  if (state.status !== "playing") return state;
  if (!DIRS.includes(dir)) return state;
  const dest = slideDestination(state.cols, state.rows, state.walls, state.player, dir);
  if (dest === state.player) return state;
  return {
    ...state,
    player: dest,
    moves: state.moves + 1,
    history: [...state.history, state.player],
    status: dest === state.goal ? "won" : "playing",
  };
}

/** 1手戻す。履歴がなければ同一参照を返す。 */
export function undoIce(state: IceState): IceState {
  if (state.history.length === 0) return state;
  const prev = state.history[state.history.length - 1];
  return {
    ...state,
    player: prev,
    moves: Math.max(0, state.moves - 1),
    history: state.history.slice(0, -1),
    status: "playing",
  };
}
