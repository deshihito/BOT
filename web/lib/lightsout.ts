// ライツアウトの純粋ロジック（UI 非依存・シード決定的）。
// 解ける初期盤を保証するため、全消灯盤からランダムな押下を逆再生して生成する。
// 押下は自己逆操作なので、生成手順と同じマスを押せば必ず消灯に戻る。

export type LightsOutSize = 3 | 4 | 5;
export type LightsOutDifficulty = "easy" | "normal" | "hard";
export type LightsOutStatus = "playing" | "won";

export type LightsOutState = {
  size: LightsOutSize;
  difficulty: LightsOutDifficulty;
  seed: number;
  /** 一次元配列。true = 点灯。 */
  cells: boolean[];
  moves: number;
  status: LightsOutStatus;
  /** 生成に使った押下手順（検証・ヒント用）。 */
  generation: number[];
};

function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function normalizeLightsSize(size: number): LightsOutSize {
  if (size === 3 || size === 4 || size === 5) return size;
  return 5;
}

export function normalizeLightsDifficulty(d: string): LightsOutDifficulty {
  if (d === "easy" || d === "hard") return d;
  return "normal";
}

/** 難易度ごとの生成押下回数の目安。 */
export function generationPresses(size: number, difficulty: LightsOutDifficulty): number {
  const n = normalizeLightsSize(size);
  if (difficulty === "easy") return Math.max(3, n);
  if (difficulty === "hard") return n * n;
  return Math.max(5, n * 2);
}

export function affectedIndexes(size: number, index: number): number[] {
  const n = normalizeLightsSize(size);
  if (!Number.isInteger(index) || index < 0 || index >= n * n) return [];
  const r = Math.floor(index / n);
  const c = index % n;
  const out = [index];
  if (r > 0) out.push(index - n);
  if (r < n - 1) out.push(index + n);
  if (c > 0) out.push(index - 1);
  if (c < n - 1) out.push(index + 1);
  return out;
}

export function toggleCells(cells: boolean[], size: number, index: number): boolean[] {
  const next = [...cells];
  for (const i of affectedIndexes(size, index)) next[i] = !next[i];
  return next;
}

export function isAllOff(cells: boolean[]): boolean {
  return cells.every((v) => !v);
}

export function litCount(cells: boolean[]): number {
  return cells.filter(Boolean).length;
}

export function createLightsOutGame(
  size: number,
  seed: number,
  difficulty: LightsOutDifficulty = "normal",
): LightsOutState {
  const n = normalizeLightsSize(size);
  const diff = normalizeLightsDifficulty(difficulty);
  const total = n * n;
  let cells = Array<boolean>(total).fill(false);
  let rng = seed | 0;
  const presses = generationPresses(n, diff);
  const generation: number[] = [];
  // 全消灯からランダムに押していく。同じマスの連続押下（相殺）は避ける。
  let last = -1;
  for (let step = 0; step < presses; step++) {
    let pick = -1;
    for (let attempt = 0; attempt < 10; attempt++) {
      const r = nextRandom(rng);
      rng = r.rng;
      pick = Math.floor(r.value * total);
      if (pick !== last) break;
    }
    last = pick;
    generation.push(pick);
    cells = toggleCells(cells, n, pick);
  }
  // 消灯盤のまま生成されてしまったら1手押して点灯盤にする
  if (isAllOff(cells)) {
    const center = Math.floor(total / 2);
    generation.push(center);
    cells = toggleCells(cells, n, center);
  }
  return {
    size: n,
    difficulty: diff,
    seed: seed | 0,
    cells,
    moves: 0,
    status: "playing",
    generation,
  };
}

export function pressCell(state: LightsOutState, index: number): LightsOutState {
  if (state.status === "won") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.cells.length) return state;
  const cells = toggleCells(state.cells, state.size, index);
  const moves = state.moves + 1;
  const won = isAllOff(cells);
  return { ...state, cells, moves, status: won ? "won" : "playing" };
}

export function isComplete(state: LightsOutState): boolean {
  return isAllOff(state.cells);
}

/**
 * 生成手順をそのまま適用すると消灯に戻ることを利用した解法ヒント。
 * 生成手順の中で奇数回押されたマスの集合が1つの解になる。
 */
export function solutionPresses(state: LightsOutState): number[] {
  const counts = new Map<number, number>();
  for (const g of state.generation) counts.set(g, (counts.get(g) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n % 2 === 1).map(([i]) => i);
}
