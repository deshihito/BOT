// ハノイの塔の純粋ロジック（UI 非依存）。
// 円盤は数値（1=最小 … n=最大）で表し、各柱は「下→上」の順の配列で持つ。
// 目標は右端の柱（index 2）へ全ての円盤を移すこと。

export interface HanoiMove {
  from: number;
  to: number;
}

export type HanoiState = {
  disks: number;
  /** pegs[p] は下→上の円盤サイズ列。 */
  pegs: number[][];
  moves: number;
  status: "playing" | "solved";
};

export const HANOI_MIN_DISKS = 3;
export const HANOI_MAX_DISKS = 8;

function clampDisks(disks: number): number {
  if (!Number.isFinite(disks)) return 5;
  return Math.min(HANOI_MAX_DISKS, Math.max(HANOI_MIN_DISKS, Math.floor(disks)));
}

/** 最少手数 = 2^n - 1。 */
export function hanoiMinMoves(disks: number): number {
  return 2 ** clampDisks(disks) - 1;
}

export function createHanoiGame(disks: number): HanoiState {
  const n = clampDisks(disks);
  const first: number[] = [];
  for (let d = n; d >= 1; d--) first.push(d);
  return { disks: n, pegs: [first, [], []], moves: 0, status: "playing" };
}

/** 柱の一番上の円盤（空なら null）。 */
export function hanoiTop(state: HanoiState, peg: number): number | null {
  const stack = state.pegs[peg];
  if (!stack || stack.length === 0) return null;
  return stack[stack.length - 1];
}

export function isHanoiSolved(state: HanoiState): boolean {
  return state.pegs[2].length === state.disks;
}

function isValidPegIndex(peg: number): boolean {
  return Number.isInteger(peg) && peg >= 0 && peg <= 2;
}

/** 大きい円盤の上に小さい円盤だけが置ける、等の合法判定。 */
export function canMoveDisk(state: HanoiState, from: number, to: number): boolean {
  if (state.status === "solved") return false;
  if (!isValidPegIndex(from) || !isValidPegIndex(to) || from === to) return false;
  const disk = hanoiTop(state, from);
  if (disk === null) return false;
  const target = hanoiTop(state, to);
  return target === null || disk < target;
}

/** 円盤を1枚動かす。不合法な手は状態を変えない（同一参照を返す）。 */
export function moveDisk(state: HanoiState, from: number, to: number): HanoiState {
  if (!canMoveDisk(state, from, to)) return state;
  const pegs = state.pegs.map((stack) => [...stack]);
  const disk = pegs[from].pop() as number;
  pegs[to].push(disk);
  const next: HanoiState = { ...state, pegs, moves: state.moves + 1, status: "playing" };
  if (isHanoiSolved(next)) {
    return { ...next, status: "solved" };
  }
  return next;
}

/** 初期配置からの最短解答の手続きを生成する（再帰）。 */
export function hanoiSolution(disks: number, from = 0, to = 2, via = 1): HanoiMove[] {
  const n = clampDisks(disks);
  const out: HanoiMove[] = [];
  const rec = (count: number, src: number, dst: number, aux: number) => {
    if (count <= 0) return;
    rec(count - 1, src, aux, dst);
    out.push({ from: src, to: dst });
    rec(count - 1, aux, dst, src);
  };
  rec(n, from, to, via);
  return out;
}
