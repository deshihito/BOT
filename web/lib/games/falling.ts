// フォーリングブロック（落下パズル）の純粋ロジック（UI 非依存・シード決定的）。
// 盤は 10列×20行の一次元配列（index = row*10+col、row0=最上段）。
// セルはピース種別文字列か null。落下中のピースは盤に含めず active として別に持つ。
// すべての操作は元の state を破壊せず、新しい state を返す。

export const FALLING_COLS = 10;
export const FALLING_ROWS = 20;
export const FALLING_CELLS = FALLING_COLS * FALLING_ROWS;

export type FallingPieceType = "I" | "O" | "T" | "S" | "Z" | "J" | "L";
export type FallingCell = FallingPieceType | null;
export type FallingStatus = "playing" | "gameover";

export type FallingActive = {
  type: FallingPieceType;
  /** 0〜3（時計回りの回転数）。 */
  rotation: number;
  /** バウンディングボックス左上の列（盤外の負値もありうる）。 */
  x: number;
  /** バウンディングボックス左上の行（天井より上は負値）。 */
  y: number;
};

export type FallingState = {
  board: FallingCell[];
  active: FallingActive;
  next: FallingPieceType;
  hold: FallingPieceType | null;
  /** この落下中ピースでホールドを使えるか（固定すると true に戻る）。 */
  canHold: boolean;
  score: number;
  lines: number;
  level: number;
  status: FallingStatus;
  rng: number;
  /** 7種1巡（バッグ）の残り。先頭から取り出す。 */
  bag: FallingPieceType[];
  /** 固定したピースの総数。 */
  placed: number;
};

export const FALLING_PIECE_TYPES: readonly FallingPieceType[] = ["I", "O", "T", "S", "Z", "J", "L"];

export const FALLING_PIECE_COLORS: Record<FallingPieceType, string> = {
  I: "#22b8cf",
  O: "#f2c531",
  T: "#9b5de5",
  S: "#3fbf72",
  Z: "#ef476f",
  J: "#4361ee",
  L: "#f4842b",
};

type PieceDef = { size: number; cells: ReadonlyArray<readonly [number, number]> };

// バウンディングボックス内のセル座標（x=列, y=行）。回転はボックス内で行う。
const PIECE_DEFS: Record<FallingPieceType, PieceDef> = {
  I: { size: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  O: { size: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  T: { size: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  S: { size: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  Z: { size: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  J: { size: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { size: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
};

/** ライン消去の基本点（レベル倍率を掛ける前）。index = 同時消去ライン数。 */
const LINE_POINTS: readonly number[] = [0, 100, 300, 500, 800];

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function shuffledBag(rng: number): { bag: FallingPieceType[]; rng: number } {
  const bag: FallingPieceType[] = [...FALLING_PIECE_TYPES];
  let cur = rng;
  for (let i = bag.length - 1; i > 0; i--) {
    const r = nextRandom(cur);
    cur = r.rng;
    const j = Math.floor(r.value * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return { bag, rng: cur };
}

function drawPiece(rng: number, bag: FallingPieceType[]): { piece: FallingPieceType; rng: number; bag: FallingPieceType[] } {
  let curRng = rng;
  let curBag = bag;
  if (curBag.length === 0) {
    const refilled = shuffledBag(curRng);
    curBag = refilled.bag;
    curRng = refilled.rng;
  }
  const [piece, ...rest] = curBag;
  return { piece, rng: curRng, bag: rest };
}

/** ピース種別と回転から、バウンディングボックス内のセル座標を返す。 */
export function getPieceCells(type: FallingPieceType, rotation: number): Array<{ x: number; y: number }> {
  const def = PIECE_DEFS[type];
  if (!def) return [];
  const rot = ((rotation % 4) + 4) % 4;
  return def.cells.map(([cx, cy]) => {
    let x = cx;
    let y = cy;
    for (let i = 0; i < rot; i++) {
      const nx = def.size - 1 - y;
      const ny = x;
      x = nx;
      y = ny;
    }
    return { x, y };
  });
}

function spawnPosition(type: FallingPieceType): { x: number; y: number } {
  const def = PIECE_DEFS[type];
  const cells = getPieceCells(type, 0);
  const minY = Math.min(...cells.map((c) => c.y));
  return { x: Math.floor((FALLING_COLS - def.size) / 2), y: -minY };
}

function makeActive(type: FallingPieceType): FallingActive {
  const pos = spawnPosition(type);
  return { type, rotation: 0, x: pos.x, y: pos.y };
}

/** 指定位置・回転でピースを置けるか（壁・床・既存ブロックとの衝突判定）。 */
export function canPlace(
  board: FallingCell[],
  type: FallingPieceType,
  rotation: number,
  x: number,
  y: number,
): boolean {
  if (!Array.isArray(board) || board.length !== FALLING_CELLS) return false;
  for (const cell of getPieceCells(type, rotation)) {
    const bx = x + cell.x;
    const by = y + cell.y;
    if (bx < 0 || bx >= FALLING_COLS || by >= FALLING_ROWS) return false;
    if (by >= 0 && board[by * FALLING_COLS + bx] !== null) return false;
  }
  return true;
}

/** 落下中ピースの盤上セル座標（盤外上部は y が負になりうる）。 */
export function getActiveCells(state: FallingState): Array<{ x: number; y: number; index: number }> {
  const { active } = state;
  return getPieceCells(active.type, active.rotation).map((cell) => {
    const x = active.x + cell.x;
    const y = active.y + cell.y;
    return { x, y, index: y * FALLING_COLS + x };
  });
}

/** ゴースト（ハードドロップ落下先）の y 座標。 */
export function ghostY(state: FallingState): number {
  if (state.status !== "playing") return state.active.y;
  let y = state.active.y;
  while (canPlace(state.board, state.active.type, state.active.rotation, state.active.x, y + 1)) {
    y++;
  }
  return y;
}

export function levelForLines(lines: number): number {
  return Math.floor(Math.max(0, lines) / 10) + 1;
}

/** レベルごとの自動落下間隔（ミリ秒）。レベルが上がるほど速くなる。 */
export function dropIntervalMs(level: number): number {
  const lv = Math.max(1, Math.floor(level) || 1);
  return Math.max(80, 800 - (lv - 1) * 75);
}

/** そろった行を消した新しい盤と消去ライン数を返す（純粋関数）。 */
export function clearLines(board: FallingCell[]): { board: FallingCell[]; cleared: number } {
  if (!Array.isArray(board) || board.length !== FALLING_CELLS) {
    return { board: Array<FallingCell>(FALLING_CELLS).fill(null), cleared: 0 };
  }
  const kept: FallingCell[][] = [];
  let cleared = 0;
  for (let row = 0; row < FALLING_ROWS; row++) {
    const line = board.slice(row * FALLING_COLS, row * FALLING_COLS + FALLING_COLS);
    if (line.every((cell) => cell !== null)) {
      cleared++;
    } else {
      kept.push(line);
    }
  }
  if (cleared === 0) return { board: [...board], cleared: 0 };
  const next: FallingCell[] = [];
  for (let i = 0; i < cleared; i++) {
    next.push(...Array<FallingCell>(FALLING_COLS).fill(null));
  }
  for (const line of kept) next.push(...line);
  return { board: next, cleared };
}

export function createFallingGame(seed: number): FallingState {
  const firstBag = shuffledBag(seed | 0);
  const first = drawPiece(firstBag.rng, firstBag.bag);
  const second = drawPiece(first.rng, first.bag);
  return {
    board: Array<FallingCell>(FALLING_CELLS).fill(null),
    active: makeActive(first.piece),
    next: second.piece,
    hold: null,
    canHold: true,
    score: 0,
    lines: 0,
    level: 1,
    status: "playing",
    rng: second.rng,
    bag: second.bag,
    placed: 0,
  };
}

/** 次ピースを繰り上げて新しいピースを出現させる。出現位置が塞がっていればゲームオーバー。 */
function spawnNext(state: FallingState, board: FallingCell[], score: number, lines: number): FallingState {
  const drawn = drawPiece(state.rng, state.bag);
  const active = makeActive(state.next);
  const blocked = !canPlace(board, active.type, active.rotation, active.x, active.y);
  return {
    ...state,
    board,
    active,
    next: drawn.piece,
    canHold: true,
    score,
    lines,
    level: levelForLines(lines),
    status: blocked ? "gameover" : "playing",
    rng: drawn.rng,
    bag: drawn.bag,
    placed: state.placed + 1,
  };
}

/** 落下中ピースを盤へ固定し、ライン消去と次ピース出現まで進める。 */
function lockActive(state: FallingState, bonusScore: number): FallingState {
  const board = [...state.board];
  let overflow = false;
  for (const cell of getActiveCells(state)) {
    if (cell.y < 0) {
      overflow = true;
      continue;
    }
    if (cell.y >= 0 && cell.y < FALLING_ROWS && cell.x >= 0 && cell.x < FALLING_COLS) {
      board[cell.y * FALLING_COLS + cell.x] = state.active.type;
    }
  }
  if (overflow) {
    return { ...state, board, score: state.score + bonusScore, status: "gameover" };
  }
  const { board: clearedBoard, cleared } = clearLines(board);
  const gained = (LINE_POINTS[cleared] ?? 0) * state.level;
  const lines = state.lines + cleared;
  return spawnNext(state, clearedBoard, state.score + bonusScore + gained, lines);
}

export function moveLeft(state: FallingState): FallingState {
  if (state.status !== "playing") return state;
  const x = state.active.x - 1;
  if (!canPlace(state.board, state.active.type, state.active.rotation, x, state.active.y)) return state;
  return { ...state, active: { ...state.active, x } };
}

export function moveRight(state: FallingState): FallingState {
  if (state.status !== "playing") return state;
  const x = state.active.x + 1;
  if (!canPlace(state.board, state.active.type, state.active.rotation, x, state.active.y)) return state;
  return { ...state, active: { ...state.active, x } };
}

// 簡易ウォールキック: その場→左右1→左右2→上1 の順に試す。
const WALL_KICKS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [-2, 0],
  [2, 0],
  [0, -1],
];

/** dir=1 で時計回り、dir=-1 で反時計回りに回転させる。 */
export function rotatePiece(state: FallingState, dir: 1 | -1 = 1): FallingState {
  if (state.status !== "playing") return state;
  if (state.active.type === "O") return state;
  const rotation = (((state.active.rotation + dir) % 4) + 4) % 4;
  for (const [dx, dy] of WALL_KICKS) {
    const x = state.active.x + dx;
    const y = state.active.y + dy;
    if (canPlace(state.board, state.active.type, rotation, x, y)) {
      return { ...state, active: { ...state.active, rotation, x, y } };
    }
  }
  return state;
}

/** 1段下へ進める。下がれなければその場で固定する（自動落下・ソフトドロップ共通の下地）。 */
export function moveDown(state: FallingState): FallingState {
  if (state.status !== "playing") return state;
  const y = state.active.y + 1;
  if (canPlace(state.board, state.active.type, state.active.rotation, state.active.x, y)) {
    return { ...state, active: { ...state.active, y } };
  }
  return lockActive(state, 0);
}

/** ソフトドロップ: 1段下げられたら1点、下がれなければ固定する。 */
export function softDrop(state: FallingState): FallingState {
  if (state.status !== "playing") return state;
  const y = state.active.y + 1;
  if (canPlace(state.board, state.active.type, state.active.rotation, state.active.x, y)) {
    return { ...state, score: state.score + 1, active: { ...state.active, y } };
  }
  return lockActive(state, 0);
}

/** ハードドロップ: ゴースト位置まで落として即固定する（落下距離×2点）。 */
export function hardDrop(state: FallingState): FallingState {
  if (state.status !== "playing") return state;
  const targetY = ghostY(state);
  const distance = Math.max(0, targetY - state.active.y);
  const dropped: FallingState = { ...state, active: { ...state.active, y: targetY } };
  return lockActive(dropped, distance * 2);
}

/** ホールド（1落下につき1回まで）。ホールドが空なら次ピースが繰り上がる。 */
export function holdPiece(state: FallingState): FallingState {
  if (state.status !== "playing" || !state.canHold) return state;
  const current = state.active.type;
  if (state.hold === null) {
    const drawn = drawPiece(state.rng, state.bag);
    const active = makeActive(state.next);
    const blocked = !canPlace(state.board, active.type, active.rotation, active.x, active.y);
    return {
      ...state,
      active,
      next: drawn.piece,
      hold: current,
      canHold: false,
      status: blocked ? "gameover" : "playing",
      rng: drawn.rng,
      bag: drawn.bag,
    };
  }
  const active = makeActive(state.hold);
  const blocked = !canPlace(state.board, active.type, active.rotation, active.x, active.y);
  return {
    ...state,
    active,
    hold: current,
    canHold: false,
    status: blocked ? "gameover" : "playing",
  };
}
