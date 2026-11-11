// モンテカルロ（ソリティア）の純粋ロジック（UI 非依存・シード決定的）。
// 25枚を 5x5 に表向きで並べ、縦・横・斜めに隣接する同じランクのペアを
// 取り除く。残り27枚は山札。
//
// 方式の明示（詰め方）:
// - ペアを除去した直後は空きマスがそのまま残る（自動では詰めない）。
// - 「詰める」操作（montecarloConsolidate）で、残りのカードを読み順に
//   前へ寄せ、空いた後方へ山札から補充する。
// - 山札が尽き、盤が詰まった状態（空きが後方にしかない）で、取り除ける
//   ペアが無くなったら手詰まり（stuck）。
// - 盤と山札のカードをすべて取り除けたらクリア（won）。

export type McCard = { id: number; suit: number; rank: number };
export type McStatus = "playing" | "won" | "stuck";

export type McState = {
  /** 25マス（5x5）。空きは null。 */
  board: (McCard | null)[];
  stock: McCard[];
  removed: number;
  moves: number;
  status: McStatus;
  seed: number;
};

export const MC_COLS = 5;
export const MC_CELLS = 25;

function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function mcAreAdjacent(a: number, b: number): boolean {
  if (a === b) return false;
  const ar = Math.floor(a / MC_COLS);
  const ac = a % MC_COLS;
  const br = Math.floor(b / MC_COLS);
  const bc = b % MC_COLS;
  return Math.abs(ar - br) <= 1 && Math.abs(ac - bc) <= 1;
}

/** 取り除けるペア（index の組）をすべて返す。 */
export function montecarloPairs(state: McState): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < MC_CELLS; i++) {
    const a = state.board[i];
    if (!a) continue;
    for (let j = i + 1; j < MC_CELLS; j++) {
      const b = state.board[j];
      if (!b || b.rank !== a.rank) continue;
      if (mcAreAdjacent(i, j)) out.push([i, j]);
    }
  }
  return out;
}

/** 盤が「詰まった」状態か（空きマスがすべて後方にある）。 */
function mcIsCompact(board: (McCard | null)[]): boolean {
  let seenNull = false;
  for (const cell of board) {
    if (cell === null) seenNull = true;
    else if (seenNull) return false;
  }
  return true;
}

function settleStatus(state: McState): McStatus {
  const boardEmpty = state.board.every((c) => c === null);
  if (boardEmpty && state.stock.length === 0) return "won";
  if (state.stock.length === 0 && mcIsCompact(state.board)) {
    if (montecarloPairs(state).length === 0) return "stuck";
  }
  return "playing";
}

export function createMonteCarlo(seed: number): McState {
  const deck: McCard[] = [];
  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 1; rank <= 13; rank++) {
      deck.push({ id: suit * 13 + (rank - 1), suit, rank });
    }
  }
  let rng = seed | 0;
  for (let i = deck.length - 1; i > 0; i--) {
    const r = nextRandom(rng);
    rng = r.rng;
    const j = Math.floor(r.value * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  const state: McState = {
    board: deck.slice(0, MC_CELLS),
    stock: deck.slice(MC_CELLS),
    removed: 0,
    moves: 0,
    status: "playing",
    seed: seed | 0,
  };
  return { ...state, status: settleStatus(state) };
}

/** テスト・カスタム局面用。 */
export function montecarloCustomState(
  board: (McCard | null)[],
  stock: McCard[],
): McState {
  const copy: (McCard | null)[] = new Array<McCard | null>(MC_CELLS).fill(null);
  for (let i = 0; i < Math.min(board.length, MC_CELLS); i++) copy[i] = board[i];
  const total = copy.filter((c) => c !== null).length + stock.length;
  const state: McState = {
    board: copy,
    stock: [...stock],
    removed: 52 - total,
    moves: 0,
    status: "playing",
    seed: 0,
  };
  return { ...state, status: settleStatus(state) };
}

/** ペアを取り除く。不正な組なら同じ state を返す。 */
export function montecarloRemovePair(state: McState, a: number, b: number): McState {
  if (state.status !== "playing") return state;
  const valid = montecarloPairs(state).some(
    ([i, j]) => (i === a && j === b) || (i === b && j === a),
  );
  if (!valid) return state;
  const board = [...state.board];
  board[a] = null;
  board[b] = null;
  const next: McState = {
    ...state,
    board,
    removed: state.removed + 2,
    moves: state.moves + 1,
  };
  return { ...next, status: settleStatus(next) };
}

/** 盤を前へ詰め、空きへ山札から補充する。変化が無ければ同じ state。 */
export function montecarloConsolidate(state: McState): McState {
  if (state.status !== "playing") return state;
  const kept = state.board.filter((c): c is McCard => c !== null);
  const need = MC_CELLS - kept.length;
  const drawn = state.stock.slice(0, Math.min(need, state.stock.length));
  const board: (McCard | null)[] = [...kept, ...drawn];
  while (board.length < MC_CELLS) board.push(null);
  const unchanged =
    drawn.length === 0 && board.every((c, i) => (c?.id ?? -1) === (state.board[i]?.id ?? -1));
  if (unchanged) return state;
  const next: McState = {
    ...state,
    board,
    stock: state.stock.slice(drawn.length),
    moves: state.moves + 1,
  };
  return { ...next, status: settleStatus(next) };
}
