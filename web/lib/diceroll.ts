// ダイスロールの純粋ロジック（UI 非依存・シード決定的）。
// グリッド上をゴールまでサイコロを転がすパズル。ゴールに止まった瞬間に
// 上の目が指定値（targetTop）と一致していればクリア。
// 問題の生成: 障害物を置いた盤面の上で開始マスからランダムウォークを行い、
// その経路と最終到達マス・到達時の上の目を問題にする。経路そのものが解に
// なるため可解性が保証される。状態は JSON 化可能な値のみ。

export const DICE_ROLL_SIZE = 6;

export type DiceDir = "N" | "E" | "S" | "W";
export type DiceRollStatus = "playing" | "won";

/** サイコロの向き。各面の目（反対同士の和は7になる標準配置）。 */
export interface DiceOrientation {
  top: number;
  bottom: number;
  north: number;
  south: number;
  east: number;
  west: number;
}

/** 初期の向き: 上=1、北=2、東=3（下=6、南=5、西=4）。 */
export const DICE_START_ORIENTATION: DiceOrientation = {
  top: 1,
  bottom: 6,
  north: 2,
  south: 5,
  east: 3,
  west: 4,
};

export interface DiceRollState {
  rows: number;
  cols: number;
  /** 障害物マスの index（row-major）一覧。 */
  blocked: number[];
  start: number;
  goal: number;
  /** ゴールに止まったときに必要となる上の目。 */
  targetTop: number;
  pos: number;
  orientation: DiceOrientation;
  moves: number;
  status: DiceRollStatus;
  seed: number;
  /** 生成に使った解の経路（方向の列）。 */
  solution: DiceDir[];
}

const DELTA: Record<DiceDir, { dr: number; dc: number }> = {
  N: { dr: -1, dc: 0 },
  E: { dr: 0, dc: 1 },
  S: { dr: 1, dc: 0 },
  W: { dr: 0, dc: -1 },
};

export const DICE_DIRS: DiceDir[] = ["N", "E", "S", "W"];

/** サイコロを dir 方向へ1回転がしたときの新しい向き。 */
export function rollOrientation(o: DiceOrientation, dir: DiceDir): DiceOrientation {
  switch (dir) {
    case "N":
      // 北へ倒れる: 北の面が下へ、上の面が北へ。
      return { top: o.south, bottom: o.north, north: o.top, south: o.bottom, east: o.east, west: o.west };
    case "S":
      return { top: o.north, bottom: o.south, north: o.bottom, south: o.top, east: o.east, west: o.west };
    case "E":
      // 東へ倒れる: 東の面が下へ、西の面が上へ。
      return { top: o.west, bottom: o.east, north: o.north, south: o.south, east: o.top, west: o.bottom };
    case "W":
      return { top: o.east, bottom: o.west, north: o.north, south: o.south, east: o.bottom, west: o.top };
  }
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

interface BuiltPuzzle {
  blocked: number[];
  start: number;
  goal: number;
  targetTop: number;
  solution: DiceDir[];
}

/** 障害物＋ランダムウォークで問題を構築する。短すぎる経路は null。 */
function buildPuzzle(rng: () => number, rows: number, cols: number): BuiltPuzzle | null {
  const total = rows * cols;
  const start = randInt(rng, 0, total - 1);
  const blockedSet = new Set<number>();
  const blockedCount = randInt(rng, 4, 7);
  for (let tries = 0; tries < 200 && blockedSet.size < blockedCount; tries++) {
    const idx = randInt(rng, 0, total - 1);
    if (idx !== start) blockedSet.add(idx);
  }
  // 開始マスが障害物に囲まれていたら作り直す。
  const startR = Math.floor(start / cols);
  const startC = start % cols;
  const openDirs = DICE_DIRS.filter((dir) => {
    const nr = startR + DELTA[dir].dr;
    const nc = startC + DELTA[dir].dc;
    return nr >= 0 && nc >= 0 && nr < rows && nc < cols && !blockedSet.has(nr * cols + nc);
  });
  if (openDirs.length === 0) return null;

  const steps = randInt(rng, 10, 14);
  const solution: DiceDir[] = [];
  let pos = start;
  let orientation: DiceOrientation = { ...DICE_START_ORIENTATION };
  for (let s = 0; s < steps; s++) {
    const r = Math.floor(pos / cols);
    const c = pos % cols;
    const options = DICE_DIRS.filter((dir) => {
      const nr = r + DELTA[dir].dr;
      const nc = c + DELTA[dir].dc;
      return nr >= 0 && nc >= 0 && nr < rows && nc < cols && !blockedSet.has(nr * cols + nc);
    });
    if (options.length === 0) break;
    // 直前の逆向きは避けて、経路が往復だけにならないようにする。
    const prev = solution[solution.length - 1];
    const opposite: Record<DiceDir, DiceDir> = { N: "S", S: "N", E: "W", W: "E" };
    const preferred = prev ? options.filter((d) => d !== opposite[prev]) : options;
    const dir = (preferred.length > 0 ? preferred : options)[
      Math.floor(rng() * (preferred.length > 0 ? preferred.length : options.length))
    ];
    solution.push(dir);
    orientation = rollOrientation(orientation, dir);
    pos = (r + DELTA[dir].dr) * cols + (c + DELTA[dir].dc);
  }
  if (solution.length < 8 || pos === start) return null;
  // 途中でゴールに「正解の目」で止まってしまう経路は、最後まで転がせないので作り直す。
  {
    let p = start;
    let o: DiceOrientation = { ...DICE_START_ORIENTATION };
    for (let i = 0; i < solution.length - 1; i++) {
      const r = Math.floor(p / cols);
      const c = p % cols;
      p = (r + DELTA[solution[i]].dr) * cols + (c + DELTA[solution[i]].dc);
      o = rollOrientation(o, solution[i]);
      if (p === pos && o.top === orientation.top) return null;
    }
  }
  return {
    blocked: [...blockedSet].sort((a, b) => a - b),
    start,
    goal: pos,
    targetTop: orientation.top,
    solution,
  };
}

/** フォールバック用の固定パズル（空盤面で固定の経路を転がして作る）。 */
function fallbackPuzzle(rows: number, cols: number): BuiltPuzzle {
  const start = (rows - 1) * cols;
  const path: DiceDir[] = ["E", "E", "N", "E", "N", "W", "N", "E", "E", "S"];
  let pos = start;
  let orientation: DiceOrientation = { ...DICE_START_ORIENTATION };
  for (const dir of path) {
    const r = Math.floor(pos / cols);
    const c = pos % cols;
    pos = (r + DELTA[dir].dr) * cols + (c + DELTA[dir].dc);
    orientation = rollOrientation(orientation, dir);
  }
  return { blocked: [], start, goal: pos, targetTop: orientation.top, solution: path };
}

export function createDiceRollGame(seed: number, size: number = DICE_ROLL_SIZE): DiceRollState {
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
    blocked: built.blocked,
    start: built.start,
    goal: built.goal,
    targetTop: built.targetTop,
    pos: built.start,
    orientation: { ...DICE_START_ORIENTATION },
    moves: 0,
    status: "playing",
    seed: seed | 0,
    solution: built.solution,
  };
}

/** サイコロを dir 方向へ転がす。盤外・障害物・終了後は状態をそのまま返す。 */
export function rollDie(state: DiceRollState, dir: DiceDir): DiceRollState {
  if (state.status !== "playing") return state;
  if (!DICE_DIRS.includes(dir)) return state;
  const r = Math.floor(state.pos / state.cols);
  const c = state.pos % state.cols;
  const nr = r + DELTA[dir].dr;
  const nc = c + DELTA[dir].dc;
  if (nr < 0 || nc < 0 || nr >= state.rows || nc >= state.cols) return state;
  const nextPos = nr * state.cols + nc;
  if (state.blocked.includes(nextPos)) return state;
  const orientation = rollOrientation(state.orientation, dir);
  const won = nextPos === state.goal && orientation.top === state.targetTop;
  return {
    ...state,
    pos: nextPos,
    orientation,
    moves: state.moves + 1,
    status: won ? "won" : "playing",
  };
}
