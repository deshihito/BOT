// 2048 方式スライドパズルの純粋ロジック（UI 非依存・シード決定的）。
// 盤は 4x4 の一次元配列（0 = 空き）。同数タイルをぶつけると合体して2倍になる。

export type SlideDir = "left" | "right" | "up" | "down";
export type SlideStatus = "playing" | "won" | "lost";

export type SlideState = {
  tiles: number[];
  score: number;
  status: SlideStatus;
  /** 2048 到達後も続ける場合に true（won を再表示しない）。 */
  keepGoing: boolean;
  rng: number;
  moves: number;
};

export const SLIDE_SIZE = 4;
const CELL_COUNT = SLIDE_SIZE * SLIDE_SIZE;

function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function spawn(state: SlideState): SlideState {
  const empty: number[] = [];
  state.tiles.forEach((v, i) => {
    if (v === 0) empty.push(i);
  });
  if (empty.length === 0) return state;
  let rng = state.rng;
  const r1 = nextRandom(rng);
  rng = r1.rng;
  const r2 = nextRandom(rng);
  rng = r2.rng;
  const tiles = [...state.tiles];
  tiles[empty[Math.floor(r1.value * empty.length)]] = r2.value < 0.9 ? 2 : 4;
  return { ...state, tiles, rng };
}

export function createSlideGame(seed: number): SlideState {
  const base: SlideState = {
    tiles: Array(CELL_COUNT).fill(0),
    score: 0,
    status: "playing",
    keepGoing: false,
    rng: seed | 0,
    moves: 0,
  };
  return spawn(spawn(base));
}

/** 1列（行）を取り出して左へ詰め＋合体させる。gained は得点。 */
function slideLine(line: number[]): { line: number[]; gained: number } {
  const compact = line.filter((v) => v !== 0);
  const out: number[] = [];
  let gained = 0;
  for (let i = 0; i < compact.length; i++) {
    if (i + 1 < compact.length && compact[i] === compact[i + 1]) {
      const merged = compact[i] * 2;
      out.push(merged);
      gained += merged;
      i++;
    } else {
      out.push(compact[i]);
    }
  }
  while (out.length < SLIDE_SIZE) out.push(0);
  return { line: out, gained };
}

/** dir 方向のライン index 群（各ラインは「進む先が先頭」になる順序）。 */
function lineIndexes(dir: SlideDir): number[][] {
  const lines: number[][] = [];
  for (let a = 0; a < SLIDE_SIZE; a++) {
    const line: number[] = [];
    for (let b = 0; b < SLIDE_SIZE; b++) {
      let r: number;
      let c: number;
      if (dir === "left") { r = a; c = b; }
      else if (dir === "right") { r = a; c = SLIDE_SIZE - 1 - b; }
      else if (dir === "up") { r = b; c = a; }
      else { r = SLIDE_SIZE - 1 - b; c = a; }
      line.push(r * SLIDE_SIZE + c);
    }
    lines.push(line);
  }
  return lines;
}

export function canMove(state: SlideState): boolean {
  if (state.tiles.some((v) => v === 0)) return true;
  for (let r = 0; r < SLIDE_SIZE; r++) {
    for (let c = 0; c < SLIDE_SIZE; c++) {
      const v = state.tiles[r * SLIDE_SIZE + c];
      if (c + 1 < SLIDE_SIZE && state.tiles[r * SLIDE_SIZE + c + 1] === v) return true;
      if (r + 1 < SLIDE_SIZE && state.tiles[(r + 1) * SLIDE_SIZE + c] === v) return true;
    }
  }
  return false;
}

export function moveSlide(state: SlideState, dir: SlideDir): { state: SlideState; moved: boolean } {
  if (state.status === "lost") return { state, moved: false };
  if (state.status === "won" && !state.keepGoing) return { state, moved: false };
  const tiles = [...state.tiles];
  let gained = 0;
  for (const indexes of lineIndexes(dir)) {
    const line = indexes.map((i) => state.tiles[i]);
    const { line: slid, gained: g } = slideLine(line);
    gained += g;
    indexes.forEach((cellIndex, k) => {
      tiles[cellIndex] = slid[k];
    });
  }
  const changed = tiles.some((v, i) => v !== state.tiles[i]);
  if (!changed) return { state, moved: false };
  let next: SlideState = {
    ...state,
    tiles,
    score: state.score + gained,
    moves: state.moves + 1,
    status: "playing",
  };
  next = spawn(next);
  if (!next.keepGoing && next.tiles.some((v) => v >= 2048)) {
    next = { ...next, status: "won" };
  } else if (!canMove(next)) {
    next = { ...next, status: "lost" };
  }
  return { state: next, moved: true };
}

/** 2048 到達（won）のあとも続ける。 */
export function continueSlide(state: SlideState): SlideState {
  if (state.status !== "won") return state;
  return { ...state, status: "playing", keepGoing: true };
}
