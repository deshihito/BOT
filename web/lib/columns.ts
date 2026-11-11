// コラムス（落下マッチ3パズル）の純粋ロジック（UI 非依存・シード決定的）。
// 盤は 6列×12行の一次元配列（index = row*COLS+col、row0=最上段）。
// 3個縦の宝石ブロックが落ち、左右移動と回転（並び替え）ができる。
// 着地後、縦・横・斜めに3つ以上そろった宝石が消え、落ちて連鎖する。
// 落下エンジンの作法（状態に rng を持つ・非破壊遷移）は lib/falling.ts と同じだが、
// この lib は単体で完結する。

export const COLUMNS_COLS = 6;
export const COLUMNS_ROWS = 12;
export const COLUMNS_CELLS = COLUMNS_COLS * COLUMNS_ROWS;
/** 宝石の色数（0..GEM_COLORS-1）。 */
export const GEM_COLORS = 5;

export const GEM_FILL = ["#ef476f", "#f2c531", "#3fbf72", "#4361ee", "#9b5de5"];
export const GEM_LABEL = ["赤", "黄", "緑", "青", "紫"];

/** 3個縦ブロック。gems[0] が一番上。 */
export type ColumnsPiece = {
  col: number;
  /** 一番上の宝石の行（盤内 0..ROWS-3 で収まる範囲で動く）。 */
  y: number;
  gems: [number, number, number];
};

export type ColumnsState = {
  board: (number | null)[];
  active: ColumnsPiece | null;
  next: [number, number, number];
  score: number;
  /** 消した宝石の総数。 */
  cleared: number;
  /** このゲームで出た最大連鎖数。 */
  maxChain: number;
  status: "playing" | "gameover";
  rng: number;
  /** 固定したブロックの総数。 */
  placed: number;
};

/** mulberry32（他 lib と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function drawGems(rng: number): { gems: [number, number, number]; rng: number } {
  let cur = rng;
  const gems: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = nextRandom(cur);
    cur = r.rng;
    gems.push(Math.floor(r.value * GEM_COLORS));
  }
  return { gems: gems as [number, number, number], rng: cur };
}

function pieceFits(board: (number | null)[], col: number, y: number): boolean {
  if (col < 0 || col >= COLUMNS_COLS) return false;
  for (let k = 0; k < 3; k++) {
    const row = y + k;
    if (row < 0 || row >= COLUMNS_ROWS) return false;
    if (board[row * COLUMNS_COLS + col] !== null) return false;
  }
  return true;
}

function spawnPiece(
  board: (number | null)[],
  gems: [number, number, number],
  next: [number, number, number],
  rng: number,
): { active: ColumnsPiece | null; next: [number, number, number]; rng: number; gameover: boolean } {
  const drawn = drawGems(rng);
  const active: ColumnsPiece = { col: Math.floor(COLUMNS_COLS / 2) - 1, y: 0, gems };
  if (!pieceFits(board, active.col, active.y)) {
    return { active: null, next, rng: drawn.rng, gameover: true };
  }
  return { active, next: drawn.gems, rng: drawn.rng, gameover: false };
}

export function createColumnsGame(seed: number): ColumnsState {
  const board = new Array<number | null>(COLUMNS_CELLS).fill(null);
  const first = drawGems(seed | 0);
  const second = drawGems(first.rng);
  const active: ColumnsPiece = { col: Math.floor(COLUMNS_COLS / 2) - 1, y: 0, gems: first.gems };
  return {
    board,
    active,
    next: second.gems,
    score: 0,
    cleared: 0,
    maxChain: 0,
    status: "playing",
    rng: second.rng,
    placed: 0,
  };
}

/** 縦・横・斜め（両方向）で3つ以上連続した同色セルに印を付ける。 */
export function findColumnMatches(board: (number | null)[]): boolean[] {
  const marked = new Array<boolean>(COLUMNS_CELLS).fill(false);
  const dirs: ReadonlyArray<readonly [number, number]> = [
    [0, 1], // 横
    [1, 0], // 縦
    [1, 1], // 斜め（右下）
    [1, -1], // 斜め（左下）
  ];
  for (let r = 0; r < COLUMNS_ROWS; r++) {
    for (let c = 0; c < COLUMNS_COLS; c++) {
      const color = board[r * COLUMNS_COLS + c];
      if (color === null) continue;
      for (const [dr, dc] of dirs) {
        // ランの先頭だけから数える。
        const pr = r - dr;
        const pc = c - dc;
        if (pr >= 0 && pr < COLUMNS_ROWS && pc >= 0 && pc < COLUMNS_COLS && board[pr * COLUMNS_COLS + pc] === color) {
          continue;
        }
        let len = 0;
        let rr = r;
        let cc = c;
        while (rr >= 0 && rr < COLUMNS_ROWS && cc >= 0 && cc < COLUMNS_COLS && board[rr * COLUMNS_COLS + cc] === color) {
          len++;
          rr += dr;
          cc += dc;
        }
        if (len >= 3) {
          for (let k = 0; k < len; k++) {
            marked[(r + dr * k) * COLUMNS_COLS + (c + dc * k)] = true;
          }
        }
      }
    }
  }
  return marked;
}

/** 列ごとに宝石を下へ詰める。 */
export function collapseColumns(board: (number | null)[]): (number | null)[] {
  const out = new Array<number | null>(COLUMNS_CELLS).fill(null);
  for (let c = 0; c < COLUMNS_COLS; c++) {
    let write = COLUMNS_ROWS - 1;
    for (let r = COLUMNS_ROWS - 1; r >= 0; r--) {
      const v = board[r * COLUMNS_COLS + c];
      if (v !== null) {
        out[write * COLUMNS_COLS + c] = v;
        write--;
      }
    }
  }
  return out;
}

export type ColumnsResolveResult = {
  board: (number | null)[];
  /** 消去で得た得点（1連鎖目=消去数×10、連鎖ごとに倍）。 */
  gained: number;
  /** 消えた宝石の数。 */
  clearedCount: number;
  /** 連鎖数（消去が起きなかったら 0）。 */
  chains: number;
};

/** 盤面のマッチ消去と連鎖をすべて解決する（盤面レベルの純関数）。 */
export function resolveColumnsBoard(boardIn: (number | null)[]): ColumnsResolveResult {
  let board = [...boardIn];
  let gained = 0;
  let clearedCount = 0;
  let chains = 0;
  for (let guard = 0; guard < 40; guard++) {
    const marked = findColumnMatches(board);
    const count = marked.filter(Boolean).length;
    if (count === 0) break;
    chains++;
    gained += count * 10 * chains;
    clearedCount += count;
    board = board.map((v, i) => (marked[i] ? null : v));
    board = collapseColumns(board);
  }
  return { board, gained, clearedCount, chains };
}

/** 着地処理: ブロックを盤へ固定し、消去を解決して次のブロックを出す。 */
function lockPiece(state: ColumnsState): ColumnsState {
  const piece = state.active;
  if (!piece) return state;
  const board = [...state.board];
  for (let k = 0; k < 3; k++) {
    board[(piece.y + k) * COLUMNS_COLS + piece.col] = piece.gems[k];
  }
  const resolved = resolveColumnsBoard(board);
  const spawned = spawnPiece(resolved.board, state.next, state.next, state.rng);
  return {
    ...state,
    board: resolved.board,
    active: spawned.active,
    next: spawned.next,
    rng: spawned.rng,
    score: state.score + resolved.gained,
    cleared: state.cleared + resolved.clearedCount,
    maxChain: Math.max(state.maxChain, resolved.chains),
    placed: state.placed + 1,
    status: spawned.gameover ? "gameover" : "playing",
  };
}

/** 左右へ1列動かす。動けなければ同じ状態を返す。 */
export function moveColumns(state: ColumnsState, dir: -1 | 1): ColumnsState {
  if (state.status !== "playing" || !state.active) return state;
  const nextCol = state.active.col + dir;
  if (!pieceFits(state.board, nextCol, state.active.y)) return state;
  return { ...state, active: { ...state.active, col: nextCol } };
}

/** 宝石の並びを回転させる（一番下が一番上へ）。 */
export function rotateColumns(state: ColumnsState): ColumnsState {
  if (state.status !== "playing" || !state.active) return state;
  const [a, b, c] = state.active.gems;
  return { ...state, active: { ...state.active, gems: [c, a, b] } };
}

/** 1段落下させる。下に着いたら固定する。 */
export function stepColumns(state: ColumnsState): ColumnsState {
  if (state.status !== "playing" || !state.active) return state;
  if (pieceFits(state.board, state.active.col, state.active.y + 1)) {
    return { ...state, active: { ...state.active, y: state.active.y + 1 } };
  }
  return lockPiece(state);
}

/** 一番下まで落として固定する（ハードドロップ）。 */
export function dropColumns(state: ColumnsState): ColumnsState {
  if (state.status !== "playing" || !state.active) return state;
  let y = state.active.y;
  while (pieceFits(state.board, state.active.col, y + 1)) y++;
  return lockPiece({ ...state, active: { ...state.active, y } });
}
