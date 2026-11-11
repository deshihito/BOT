// 15パズル（スライディングパズル）の純粋ロジック（UI 非依存・シード決定的）。
// 解可能性を保証するため、完成盤からランダムな合法手を重ねてシャッフルする。

export type FifteenSize = 3 | 4 | 5;
export type FifteenStatus = "playing" | "won";

export type FifteenState = {
  size: FifteenSize;
  seed: number;
  /** 一次元配列。0 = 空白、1〜size*size-1 = タイル番号。 */
  tiles: number[];
  moves: number;
  status: FifteenStatus;
};

function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function normalizeSize(size: number): FifteenSize {
  if (size === 3 || size === 5) return size;
  return 4;
}

export function solvedTiles(size: number): number[] {
  const n = normalizeSize(size);
  const total = n * n;
  return Array.from({ length: total }, (_, i) => (i + 1) % total);
}

export function blankIndex(tiles: number[]): number {
  return tiles.indexOf(0);
}

function neighborsOfBlank(tiles: number[], size: number): number[] {
  const n = normalizeSize(size);
  const blank = blankIndex(tiles);
  const r = Math.floor(blank / n);
  const c = blank % n;
  const out: number[] = [];
  if (r > 0) out.push(blank - n);
  if (r < n - 1) out.push(blank + n);
  if (c > 0) out.push(blank - 1);
  if (c < n - 1) out.push(blank + 1);
  return out;
}

export function isSolvedTiles(tiles: number[], size: number): boolean {
  const solved = solvedTiles(size);
  return tiles.length === solved.length && tiles.every((v, i) => v === solved[i]);
}

/**
 * 解可能性の判定（パリティ）。
 * - 幅が奇数: 逆転数が偶数なら解ける。
 * - 幅が偶数: 逆転数 + 空白の行（下から数えて） が奇数なら解ける。
 */
export function isSolvable(tiles: number[], size: number): boolean {
  const n = normalizeSize(size);
  if (tiles.length !== n * n) return false;
  const seq = tiles.filter((v) => v !== 0);
  let inversions = 0;
  for (let i = 0; i < seq.length; i++) {
    for (let j = i + 1; j < seq.length; j++) {
      if (seq[i] > seq[j]) inversions++;
    }
  }
  if (n % 2 === 1) return inversions % 2 === 0;
  const blankRowFromBottom = n - Math.floor(blankIndex(tiles) / n);
  return (inversions + blankRowFromBottom) % 2 === 1;
}

export function createFifteenGame(size: number, seed: number): FifteenState {
  const n = normalizeSize(size);
  let tiles = solvedTiles(n);
  let rng = seed | 0;
  let prevBlank = -1;
  // 完成盤から合法手を重ねるので必ず解ける。直前の逆手は避けてよく混ぜる。
  const steps = n * n * 20;
  for (let step = 0; step < steps; step++) {
    const blank = blankIndex(tiles);
    let candidates = neighborsOfBlank(tiles, n);
    if (candidates.length > 1) candidates = candidates.filter((i) => i !== prevBlank);
    const r = nextRandom(rng);
    rng = r.rng;
    const pick = candidates[Math.floor(r.value * candidates.length)];
    const next = [...tiles];
    next[blank] = next[pick];
    next[pick] = 0;
    prevBlank = blank;
    tiles = next;
  }
  // 万一完成盤に戻っていたら1手ずらす
  if (isSolvedTiles(tiles, n)) {
    const blank = blankIndex(tiles);
    const cand = neighborsOfBlank(tiles, n)[0];
    const next = [...tiles];
    next[blank] = next[cand];
    next[cand] = 0;
    tiles = next;
  }
  return { size: n, seed: seed | 0, tiles, moves: 0, status: "playing" };
}

/** 空白と隣接したタイルをスライドさせる。動かせなければ元の状態をそのまま返す。 */
export function slideTile(state: FifteenState, index: number): FifteenState {
  if (state.status === "won") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.tiles.length) return state;
  if (state.tiles[index] === 0) return state;
  const blank = blankIndex(state.tiles);
  const n = state.size;
  const br = Math.floor(blank / n);
  const bc = blank % n;
  const r = Math.floor(index / n);
  const c = index % n;
  const adjacent = Math.abs(br - r) + Math.abs(bc - c) === 1;
  if (!adjacent) {
    // 同じ行・列なら空白までまとめてスライドできる（複数タイルの一括移動）
    if (br === r || bc === c) {
      return slideLineToBlank(state, index);
    }
    return state;
  }
  const tiles = [...state.tiles];
  tiles[blank] = tiles[index];
  tiles[index] = 0;
  const moves = state.moves + 1;
  const won = isSolvedTiles(tiles, n);
  return { ...state, tiles, moves, status: won ? "won" : "playing" };
}

function slideLineToBlank(state: FifteenState, index: number): FifteenState {
  const n = state.size;
  const blank = blankIndex(state.tiles);
  const br = Math.floor(blank / n);
  const bc = blank % n;
  const r = Math.floor(index / n);
  const c = index % n;
  if (br !== r && bc !== c) return state;
  const tiles = [...state.tiles];
  if (br === r) {
    const rowStart = br * n;
    if (c < bc) {
      for (let cc = bc; cc > c; cc--) tiles[rowStart + cc] = tiles[rowStart + cc - 1];
    } else {
      for (let cc = bc; cc < c; cc++) tiles[rowStart + cc] = tiles[rowStart + cc + 1];
    }
    tiles[rowStart + c] = 0;
  } else {
    if (r < br) {
      for (let rr = br; rr > r; rr--) tiles[rr * n + bc] = tiles[(rr - 1) * n + bc];
    } else {
      for (let rr = br; rr < r; rr++) tiles[rr * n + bc] = tiles[(rr + 1) * n + bc];
    }
    tiles[r * n + bc] = 0;
  }
  const moves = state.moves + 1;
  const won = isSolvedTiles(tiles, n);
  return { ...state, tiles, moves, status: won ? "won" : "playing" };
}

/** そのマスが今スライドできるか（空白と隣接 or 同一行列）。 */
export function canSlide(state: FifteenState, index: number): boolean {
  if (state.status === "won") return false;
  if (!Number.isInteger(index) || index < 0 || index >= state.tiles.length) return false;
  if (state.tiles[index] === 0) return false;
  const blank = blankIndex(state.tiles);
  const n = state.size;
  return (
    Math.floor(blank / n) === Math.floor(index / n) || blank % n === index % n
  );
}

export function isComplete(state: FifteenState): boolean {
  return isSolvedTiles(state.tiles, state.size);
}
