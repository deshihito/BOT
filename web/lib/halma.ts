// ハルマ（チャイニーズチェッカー2人戦）の純粋ロジック（UI 非依存・決定的）。
//
// 盤面表現（実装可能性を優先した選択）:
// - キューブ座標 (q, r, s)（q + r + s = 0）で六角グリッドを表す。
// - 盤は「半径4の六角形（61マス）」＋「6方向の三角陣地（各10マス）」の
//   計121マスで、本物の星形盤と同じ形にする。
// - 2人戦に簡略化し、使う陣地は正対する2つだけ（各10個のコマ）。
//   残り4つの陣地は通常の通過マスとして使う。
// 簡略化点:
// - コマ数・陣地は本家どおり10個だが、対戦は2人専用。
// - ジャンプは「隣のコマを飛び越えて真後ろの空きマスへ」を連鎖でき、
//   1手の中で何回でも続けられる（本家どおり）。
// - 陣地への出入り制限などの細則は入れない。
//
// 座標の向き: プレイヤー0は (-8, 4) 側の陣地（左下）から始めて
// プレイヤー1の陣地 (8, -4) 側（右上）を目指す。逆も同様。

export type HalmaPlayer = 0 | 1;
export type HalmaStatus = "playing" | "won";

/** マス。x/y は描画用の相対座標（比率）。 */
export type HalmaCell = { q: number; r: number; x: number; y: number };

export type HalmaMove = {
  from: number;
  to: number;
  /** from から to までの通過マス列（ジャンプ連鎖の内訳）。 */
  path: number[];
  jump: boolean;
};

export type HalmaState = {
  /** マス index → 0:空き / 1:プレイヤー0 / 2:プレイヤー1。 */
  board: number[];
  turn: HalmaPlayer;
  winner: HalmaPlayer | null;
  status: HalmaStatus;
  moves: number;
  seed: number;
  lastMove: { from: number; to: number } | null;
};

/** キューブ座標の6方向（(dq, dr)。s = -q - r が従属する）。 */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, -1],
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
];

function keyOf(q: number, r: number): string {
  return `${q},${r}`;
}

/** 60度回転 (q, r) -> (q + r, -q)。 */
function rot60(q: number, r: number): [number, number] {
  return [q + r, -q];
}

function buildCells(): { cells: HalmaCell[]; camps: [number[], number[]] } {
  const coords: Array<[number, number]> = [];
  const seen = new Set<string>();
  const push = (q: number, r: number) => {
    const k = keyOf(q, r);
    if (seen.has(k)) return;
    seen.add(k);
    coords.push([q, r]);
  };
  // 半径4の六角形
  for (let q = -4; q <= 4; q++) {
    const rMin = Math.max(-4, -q - 4);
    const rMax = Math.min(4, -q + 4);
    for (let r = rMin; r <= rMax; r++) push(q, r);
  }
  // 基準の三角陣地（方向 (1,-1,0)、頂点 (8,-4)）: 10マス
  const base: Array<[number, number]> = [];
  for (let q = 5; q <= 8; q++) {
    for (let r = -4; r <= 4 - q; r++) base.push([q, r]);
  }
  const triangles: Array<Array<[number, number]>> = [];
  let tri = base;
  for (let k = 0; k < 6; k++) {
    triangles.push(tri);
    for (const [q, r] of tri) push(q, r);
    tri = tri.map(([q, r]) => rot60(q, r));
  }
  const indexOf = new Map<string, number>();
  coords.forEach(([q, r], i) => indexOf.set(keyOf(q, r), i));
  const cells: HalmaCell[] = coords.map(([q, r]) => ({
    q,
    r,
    x: Math.sqrt(3) * (q + r / 2),
    y: 1.5 * r,
  }));
  const toIndices = (t: Array<[number, number]>) =>
    t.map(([q, r]) => indexOf.get(keyOf(q, r)) as number).sort((a, b) => a - b);
  // プレイヤー1の陣地 = 基準三角（右上）、プレイヤー0の陣地 = 正対する三角（左下）。
  const camp1 = toIndices(triangles[0]);
  const camp0 = toIndices(triangles[3]);
  return { cells, camps: [camp0, camp1] };
}

const BUILT = buildCells();

export const HALMA_CELLS: HalmaCell[] = BUILT.cells;
export const HALMA_CELL_COUNT = HALMA_CELLS.length;
/** [プレイヤー0の初期陣地, プレイヤー1の初期陣地]（マス index の配列）。 */
export const HALMA_CAMPS: [number[], number[]] = BUILT.camps;
/** [プレイヤー0の目標陣地, プレイヤー1の目標陣地]。 */
export const HALMA_TARGETS: [number[], number[]] = [BUILT.camps[1], BUILT.camps[0]];

/** マス index → 6方向の隣接マス index（盤外は -1）。 */
export const HALMA_NEIGHBORS: number[][] = (() => {
  const indexOf = new Map<string, number>();
  HALMA_CELLS.forEach((c, i) => indexOf.set(keyOf(c.q, c.r), i));
  return HALMA_CELLS.map((c) =>
    DIRS.map(([dq, dr]) => {
      const hit = indexOf.get(keyOf(c.q + dq, c.r + dr));
      return hit === undefined ? -1 : hit;
    }),
  );
})();

/** 前進度（プレイヤー0は大きいほど前進、プレイヤー1はその逆）。 */
function axisValue(index: number): number {
  const c = HALMA_CELLS[index];
  return c.q - c.r;
}

function progressOf(index: number, player: HalmaPlayer): number {
  return player === 0 ? axisValue(index) : -axisValue(index);
}

export function createHalmaGame(seed: number): HalmaState {
  const board = new Array<number>(HALMA_CELL_COUNT).fill(0);
  for (const i of HALMA_CAMPS[0]) board[i] = 1;
  for (const i of HALMA_CAMPS[1]) board[i] = 2;
  return {
    board,
    turn: 0,
    winner: null,
    status: "playing",
    moves: 0,
    seed: seed | 0,
    lastMove: null,
  };
}

/** テスト・カスタム局面用。board は HALMA_CELL_COUNT 長の 0/1/2 配列。 */
export function halmaCustomState(board: number[], turn: HalmaPlayer): HalmaState {
  const copy = new Array<number>(HALMA_CELL_COUNT).fill(0);
  for (let i = 0; i < Math.min(board.length, HALMA_CELL_COUNT); i++) {
    copy[i] = board[i] === 1 || board[i] === 2 ? board[i] : 0;
  }
  const state: HalmaState = {
    board: copy,
    turn,
    winner: null,
    status: "playing",
    moves: 0,
    seed: 0,
    lastMove: null,
  };
  return { ...state, winner: halmaWinnerOf(copy), status: halmaWinnerOf(copy) ? "won" : "playing" };
}

function halmaWinnerOf(board: number[]): HalmaPlayer | null {
  for (const player of [0, 1] as HalmaPlayer[]) {
    const piece = player + 1;
    if (HALMA_TARGETS[player].every((i) => board[i] === piece)) return player;
  }
  return null;
}

/** 指定マスにある player のコマの合法手をすべて列挙する。 */
export function halmaMovesFrom(state: HalmaState, from: number): HalmaMove[] {
  const player = state.turn;
  const piece = player + 1;
  if (!Number.isInteger(from) || from < 0 || from >= HALMA_CELL_COUNT) return [];
  if (state.board[from] !== piece) return [];
  const board = state.board;
  const occ = (i: number) => (i === from ? 0 : board[i]);
  const moves: HalmaMove[] = [];
  // 隣接1マス
  for (let d = 0; d < 6; d++) {
    const to = HALMA_NEIGHBORS[from][d];
    if (to >= 0 && board[to] === 0) {
      moves.push({ from, to, path: [from, to], jump: false });
    }
  }
  // ジャンプ連鎖（BFS）。同じマスへは一度だけ着地できる。
  const pathOf = new Map<number, number[]>();
  pathOf.set(from, [from]);
  const seen = new Set<number>([from]);
  let frontier = [from];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const cur of frontier) {
      for (let d = 0; d < 6; d++) {
        const mid = HALMA_NEIGHBORS[cur][d];
        if (mid < 0 || occ(mid) === 0) continue;
        const land = HALMA_NEIGHBORS[mid][d];
        if (land < 0 || land === from || occ(land) !== 0) continue;
        if (seen.has(land)) continue;
        seen.add(land);
        const path = [...(pathOf.get(cur) as number[]), land];
        pathOf.set(land, path);
        moves.push({ from, to: land, path, jump: true });
        next.push(land);
      }
    }
    frontier = next;
  }
  return moves;
}

/** 現在の手番プレイヤーの合法手をすべて列挙する。 */
export function halmaLegalMoves(state: HalmaState): HalmaMove[] {
  if (state.status !== "playing") return [];
  const piece = state.turn + 1;
  const out: HalmaMove[] = [];
  for (let i = 0; i < HALMA_CELL_COUNT; i++) {
    if (state.board[i] === piece) out.push(...halmaMovesFrom(state, i));
  }
  return out;
}

export function halmaApplyMove(state: HalmaState, from: number, to: number): HalmaState {
  if (state.status !== "playing") return state;
  const move = halmaMovesFrom(state, from).find((m) => m.to === to);
  if (!move) return state;
  const board = [...state.board];
  board[to] = board[from];
  board[from] = 0;
  const winner = halmaWinnerOf(board);
  return {
    ...state,
    board,
    winner,
    status: winner !== null ? "won" : "playing",
    moves: state.moves + 1,
    turn: state.turn === 0 ? 1 : 0,
    lastMove: { from, to },
  };
}

/** 局面評価（player 視点。大きいほど有利）。 */
export function halmaEvaluate(state: HalmaState, player: HalmaPlayer): number {
  const piece = player + 1;
  const target = new Set(HALMA_TARGETS[player]);
  let total = 0;
  let minProgress = Infinity;
  for (let i = 0; i < HALMA_CELL_COUNT; i++) {
    if (state.board[i] !== piece) continue;
    const p = progressOf(i, player);
    total += p;
    if (p < minProgress) minProgress = p;
    if (target.has(i)) total += 24;
  }
  // 後方のコマを置き去りにしないよう、最遅コマの前進も少し評価する。
  return total + (minProgress === Infinity ? 0 : minProgress * 0.5);
}

/** CPU の手選択（評価が最大の手。同点は列挙順で決定的に選ぶ）。 */
export function halmaChooseMove(state: HalmaState): HalmaMove | null {
  const moves = halmaLegalMoves(state);
  if (moves.length === 0) return null;
  const player = state.turn;
  let best: HalmaMove | null = null;
  let bestScore = -Infinity;
  for (const move of moves) {
    const next = halmaApplyMove(state, move.from, move.to);
    let score = halmaEvaluate(next, player);
    if (next.winner === player) score += 100000;
    // ジャンプ連鎖は勢いがあるので僅かに優遇する。
    score += (move.path.length - 2) * 1.5;
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return best;
}

/** CPU（現在の手番プレイヤー）の1手を実行した新しい状態を返す。 */
export function halmaCpuTurn(state: HalmaState): HalmaState {
  if (state.status !== "playing") return state;
  const move = halmaChooseMove(state);
  if (!move) {
    // 合法手が無い場合はパスする（通常は起こらない）。
    return { ...state, turn: state.turn === 0 ? 1 : 0, moves: state.moves + 1 };
  }
  return halmaApplyMove(state, move.from, move.to);
}
