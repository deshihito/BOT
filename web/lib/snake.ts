// スネークの純粋ロジック（UI 非依存・シード決定的）。
// グリッド上の進行・食事・成長・壁/自分衝突・速度段階を純粋関数で扱う。
// 状態は JSON 化可能な値のみで構成する。

export type SnakeDir = "up" | "down" | "left" | "right";
export type SnakeStatus = "ready" | "playing" | "paused" | "gameover" | "won";

export type SnakePoint = { x: number; y: number };

export type SnakeState = {
  cols: number;
  rows: number;
  /** 先頭が頭（index 0）。 */
  snake: SnakePoint[];
  food: SnakePoint | null;
  dir: SnakeDir;
  pendingDir: SnakeDir;
  score: number;
  foodsEaten: number;
  status: SnakeStatus;
  rng: number;
  tick: number;
};

export const SNAKE_DEFAULT_COLS = 20;
export const SNAKE_DEFAULT_ROWS = 20;

const DIR_VEC: Record<SnakeDir, SnakePoint> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITE: Record<SnakeDir, SnakeDir> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function isOppositeDir(a: SnakeDir, b: SnakeDir): boolean {
  return OPPOSITE[a] === b;
}

function placeFood(
  cols: number,
  rows: number,
  snake: SnakePoint[],
  rng: number,
): { food: SnakePoint | null; rng: number } {
  const occupied = new Set(snake.map((p) => p.y * cols + p.x));
  const empty: number[] = [];
  for (let i = 0; i < cols * rows; i++) {
    if (!occupied.has(i)) empty.push(i);
  }
  if (empty.length === 0) return { food: null, rng };
  const r = nextRandom(rng);
  const idx = empty[Math.floor(r.value * empty.length)];
  return { food: { x: idx % cols, y: Math.floor(idx / cols) }, rng: r.rng };
}

export function createSnakeGame(
  cols: number = SNAKE_DEFAULT_COLS,
  rows: number = SNAKE_DEFAULT_ROWS,
  seed: number = 1,
): SnakeState {
  const cy = Math.floor(rows / 2);
  const cx = Math.floor(cols / 2);
  const snake: SnakePoint[] = [
    { x: cx, y: cy },
    { x: cx - 1, y: cy },
    { x: cx - 2, y: cy },
  ];
  const placed = placeFood(cols, rows, snake, seed | 0);
  return {
    cols,
    rows,
    snake,
    food: placed.food,
    dir: "right",
    pendingDir: "right",
    score: 0,
    foodsEaten: 0,
    status: "ready",
    rng: placed.rng,
    tick: 0,
  };
}

/** 進行方向を予約する。真逆への反転は無効（長さ1のときだけ許可）。 */
export function setSnakeDirection(state: SnakeState, dir: SnakeDir): SnakeState {
  if (state.status !== "playing" && state.status !== "ready") return state;
  if (state.snake.length > 1 && isOppositeDir(state.dir, dir)) return state;
  if (state.pendingDir === dir) return state;
  return { ...state, pendingDir: dir };
}

export function startSnake(state: SnakeState): SnakeState {
  if (state.status === "ready" || state.status === "paused") {
    return { ...state, status: "playing" };
  }
  return state;
}

export function pauseSnake(state: SnakeState): SnakeState {
  if (state.status === "playing") return { ...state, status: "paused" };
  if (state.status === "paused") return { ...state, status: "playing" };
  return state;
}

/** スコアに応じた 1 tick の間隔（ms）。食べるほど速くなる（下限あり）。 */
export function snakeIntervalMs(state: Pick<SnakeState, "foodsEaten">): number {
  const level = Math.floor(state.foodsEaten / 5);
  return Math.max(70, 170 - level * 14);
}

/** 速度段階（0 始まり）。 */
export function snakeSpeedLevel(state: Pick<SnakeState, "foodsEaten">): number {
  return Math.floor(state.foodsEaten / 5);
}

/** 餌1個あたりの得点。速度段階が上がると少し増える。 */
export function snakeFoodPoints(state: Pick<SnakeState, "foodsEaten">): number {
  return 10 + snakeSpeedLevel(state) * 2;
}

/** 1 tick 進める。壁・自分への衝突で gameover、餌で成長＋得点。 */
export function tickSnake(state: SnakeState): SnakeState {
  if (state.status !== "playing") return state;
  const dir = state.pendingDir;
  const vec = DIR_VEC[dir];
  const head = state.snake[0];
  const nextHead: SnakePoint = { x: head.x + vec.x, y: head.y + vec.y };

  // 壁衝突
  if (nextHead.x < 0 || nextHead.y < 0 || nextHead.x >= state.cols || nextHead.y >= state.rows) {
    return { ...state, dir, status: "gameover", tick: state.tick + 1 };
  }

  const willEat = state.food !== null && nextHead.x === state.food.x && nextHead.y === state.food.y;
  // 食べない場合、末尾はこの tick で離れるので衝突判定から除く
  const bodyToCheck = willEat ? state.snake : state.snake.slice(0, -1);
  if (bodyToCheck.some((p) => p.x === nextHead.x && p.y === nextHead.y)) {
    return { ...state, dir, status: "gameover", tick: state.tick + 1 };
  }

  const snake = [nextHead, ...state.snake];
  if (!willEat) {
    snake.pop();
    return { ...state, snake, dir, tick: state.tick + 1 };
  }

  const gained = snakeFoodPoints(state);
  const foodsEaten = state.foodsEaten + 1;
  const placed = placeFood(state.cols, state.rows, snake, state.rng);
  if (placed.food === null) {
    // 盤面を埋め尽くした
    return {
      ...state,
      snake,
      dir,
      food: null,
      score: state.score + gained,
      foodsEaten,
      status: "won",
      rng: placed.rng,
      tick: state.tick + 1,
    };
  }
  return {
    ...state,
    snake,
    dir,
    food: placed.food,
    score: state.score + gained,
    foodsEaten,
    rng: placed.rng,
    tick: state.tick + 1,
  };
}
