// ペグソリティア（英式33穴）の純粋ロジック（UI 非依存）。
// 7×7 の四隅 2×2 を除いた33穴。ペグが隣のペグを飛び越えて空き穴に入ると、
// 飛び越えられたペグが取り除かれる。最後に1つ残せば完全クリア。

/** 0=盤外, 1=ペグあり, 2=空き穴。index = row*7+col。 */
export type PegCell = 0 | 1 | 2;

export interface PegMove {
  from: number;
  over: number;
  to: number;
}

export type PegStatus = "playing" | "stuck" | "cleared";

export type PegState = {
  cells: PegCell[];
  moves: number;
  status: PegStatus;
};

export const PEG_SIZE = 7;

/** (row, col) が33穴の盤内かどうか。 */
export function isPegHole(row: number, col: number): boolean {
  if (row < 0 || col < 0 || row >= PEG_SIZE || col >= PEG_SIZE) return false;
  const cornerRow = row < 2 || row > 4;
  const cornerCol = col < 2 || col > 4;
  return !(cornerRow && cornerCol);
}

/** 初期配置: 中央（3,3）だけ空き、他は全てペグ。 */
export function createPegGame(): PegState {
  const cells: PegCell[] = [];
  for (let r = 0; r < PEG_SIZE; r++) {
    for (let c = 0; c < PEG_SIZE; c++) {
      if (!isPegHole(r, c)) cells.push(0);
      else if (r === 3 && c === 3) cells.push(2);
      else cells.push(1);
    }
  }
  return { cells, moves: 0, status: "playing" };
}

export function pegCount(state: PegState): number {
  return state.cells.filter((c) => c === 1).length;
}

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/** 指定マスのペグが打てる合法手の一覧。 */
export function pegMovesFrom(state: PegState, from: number): PegMove[] {
  if (!Number.isInteger(from) || from < 0 || from >= PEG_SIZE * PEG_SIZE) return [];
  if (state.cells[from] !== 1) return [];
  const r = Math.floor(from / PEG_SIZE);
  const c = from % PEG_SIZE;
  const out: PegMove[] = [];
  for (const [dr, dc] of DIRS) {
    const or = r + dr;
    const oc = c + dc;
    const tr = r + dr * 2;
    const tc = c + dc * 2;
    if (!isPegHole(or, oc) || !isPegHole(tr, tc)) continue;
    const over = or * PEG_SIZE + oc;
    const to = tr * PEG_SIZE + tc;
    if (state.cells[over] === 1 && state.cells[to] === 2) {
      out.push({ from, over, to });
    }
  }
  return out;
}

/** 盤全体の合法手の一覧。 */
export function pegLegalMoves(state: PegState): PegMove[] {
  const out: PegMove[] = [];
  for (let i = 0; i < state.cells.length; i++) {
    if (state.cells[i] === 1) out.push(...pegMovesFrom(state, i));
  }
  return out;
}

export function isPegMoveLegal(state: PegState, move: PegMove): boolean {
  if (!move || typeof move !== "object") return false;
  return pegMovesFrom(state, move.from).some((m) => m.over === move.over && m.to === move.to);
}

/** 手を適用する。不合法な手は状態を変えない（同一参照を返す）。 */
export function applyPegMove(state: PegState, move: PegMove): PegState {
  if (state.status !== "playing") return state;
  if (!isPegMoveLegal(state, move)) return state;
  const cells = [...state.cells];
  cells[move.from] = 2;
  cells[move.over] = 2;
  cells[move.to] = 1;
  const next: PegState = { cells, moves: state.moves + 1, status: "playing" };
  const count = pegCount(next);
  if (count === 1) {
    return { ...next, status: "cleared" };
  }
  if (pegLegalMoves(next).length === 0) {
    return { ...next, status: "stuck" };
  }
  return next;
}

/** これ以上打てる手が無いか（残り1つのクリア含む）。 */
export function isPegStuck(state: PegState): boolean {
  return pegLegalMoves(state).length === 0;
}

/** 残りペグ数による評価文。 */
export function pegRating(count: number): string {
  if (count <= 1) return "パーフェクト！天才の域です";
  if (count === 2) return "素晴らしい！あと少しで完璧でした";
  if (count === 3) return "よくできました！";
  if (count === 4) return "あと一歩！";
  if (count === 5) return "なかなか良い読みです";
  return "おつかれさまでした。もう一局どうぞ";
}
