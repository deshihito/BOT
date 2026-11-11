// しかく（四角に切れ）の純粋ロジック（UI 非依存・シード決定的）。
// ルール: 盤面を長方形に分割し、各長方形は数字をちょうど1つ含み、
//   その数字が長方形の面積（マス数）と等しくなければならない。
// 生成は「解を先に作る」方式: 長方形の分割を先に完成させ、各長方形に
//   面積と等しい数字を1つ置いて問題にする（可解性は生成で保証）。
// 完成判定は正解との一致ではなくルール検証で行うため、別解でもクリアになる。

export type ShikakuSize = 5 | 6;

/** 長方形（両端を含む行・列）。 */
export type ShikakuRect = { r1: number; c1: number; r2: number; c2: number };

export type ShikakuViolationType = "noClue" | "multiClue" | "areaMismatch";

export type ShikakuViolation = {
  type: ShikakuViolationType;
  /** 関係する長方形（rects の index）。 */
  rectIndex: number;
  /** 強調表示用のセル index 一覧。 */
  cells: number[];
  message: string;
};

export type ShikakuState = {
  size: ShikakuSize;
  seed: number;
  /** 数字セルの値（数字でないセルは null）。 */
  clues: (number | null)[];
  /** 生成に使った解の分割（検証用に保持する）。 */
  solution: ShikakuRect[];
  /** プレイヤーが描いた長方形。互いに重ならない。 */
  rects: ShikakuRect[];
  moves: number;
  status: "playing" | "won";
};

/** mulberry32（minesweeper 等と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function normalizeShikakuSize(size: number): ShikakuSize {
  return size === 5 ? 5 : 6;
}

export function rectCells(rect: ShikakuRect, size: number): number[] {
  const out: number[] = [];
  for (let r = rect.r1; r <= rect.r2; r++) {
    for (let c = rect.c1; c <= rect.c2; c++) out.push(r * size + c);
  }
  return out;
}

export function rectArea(rect: ShikakuRect): number {
  return (rect.r2 - rect.r1 + 1) * (rect.c2 - rect.c1 + 1);
}

function rectsIntersect(a: ShikakuRect, b: ShikakuRect): boolean {
  return a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
}

/** セルが属する長方形の index（無ければ -1）。 */
export function rectIndexAt(state: ShikakuState, index: number): number {
  const r = Math.floor(index / state.size);
  const c = index % state.size;
  return state.rects.findIndex(
    (rect) => r >= rect.r1 && r <= rect.r2 && c >= rect.c1 && c <= rect.c2,
  );
}

/** 長方形内の数字セル一覧。 */
export function cluesInRect(state: ShikakuState, rect: ShikakuRect): { index: number; value: number }[] {
  const out: { index: number; value: number }[] = [];
  for (const idx of rectCells(rect, state.size)) {
    const v = state.clues[idx];
    if (v !== null) out.push({ index: idx, value: v });
  }
  return out;
}

/** 解の分割を作る。未割当セルから長方形を育てていく。 */
function buildSolution(size: ShikakuSize, seed: number): { rects: ShikakuRect[]; clues: (number | null)[]; rng: number } {
  let rng = seed | 0;
  const filled = new Array<boolean>(size * size).fill(false);
  const rects: ShikakuRect[] = [];
  for (let guard = 0; guard < size * size; guard++) {
    const start = filled.indexOf(false);
    if (start < 0) break;
    const sr = Math.floor(start / size);
    const sc = start % size;
    // 候補の (高さ, 幅) を列挙してシャッフルし、収まるものを選ぶ。
    const candidates: [number, number][] = [];
    for (let h = 1; h <= size - sr; h++) {
      for (let w = 1; w <= size - sc; w++) candidates.push([h, w]);
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const r = nextRandom(rng);
      rng = r.rng;
      const j = Math.floor(r.value * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    let chosen: ShikakuRect = { r1: sr, c1: sc, r2: sr, c2: sc };
    for (const [h, w] of candidates) {
      const rect: ShikakuRect = { r1: sr, c1: sc, r2: sr + h - 1, c2: sc + w - 1 };
      if (rectCells(rect, size).every((idx) => !filled[idx])) {
        chosen = rect;
        break;
      }
    }
    for (const idx of rectCells(chosen, size)) filled[idx] = true;
    rects.push(chosen);
  }
  const clues: (number | null)[] = new Array<number | null>(size * size).fill(null);
  for (const rect of rects) {
    const cells = rectCells(rect, size);
    const r = nextRandom(rng);
    rng = r.rng;
    const clueIndex = cells[Math.floor(r.value * cells.length)];
    clues[clueIndex] = rectArea(rect);
  }
  return { rects, clues, rng };
}

export function createShikakuGame(sizeInput: number, seed: number): ShikakuState {
  const size = normalizeShikakuSize(sizeInput);
  const { rects, clues } = buildSolution(size, seed);
  return {
    size,
    seed: seed | 0,
    clues,
    solution: rects,
    rects: [],
    moves: 0,
    status: "playing",
  };
}

/** ルール違反の一覧（未完成は違反ではない）。 */
export function shikakuViolations(state: ShikakuState): ShikakuViolation[] {
  const out: ShikakuViolation[] = [];
  state.rects.forEach((rect, rectIndex) => {
    const cells = rectCells(rect, state.size);
    const clues = cluesInRect(state, rect);
    if (clues.length === 0) {
      out.push({
        type: "noClue",
        rectIndex,
        cells,
        message: "数字が入っていない長方形があります。",
      });
    } else if (clues.length > 1) {
      out.push({
        type: "multiClue",
        rectIndex,
        cells,
        message: "1つの長方形に数字が2つ以上入っています。",
      });
    } else if (clues[0].value !== rectArea(rect)) {
      out.push({
        type: "areaMismatch",
        rectIndex,
        cells,
        message: `数字 ${clues[0].value} と面積 ${rectArea(rect)} が合っていません。`,
      });
    }
  });
  return out;
}

/** 盤面が全て覆われているか。 */
export function coveredCount(state: ShikakuState): number {
  let n = 0;
  for (const rect of state.rects) n += rectArea(rect);
  return n;
}

/** 完成判定: 全マスが覆われ、全ての長方形がルールを満たす。 */
export function isShikakuComplete(state: ShikakuState): boolean {
  return coveredCount(state) === state.size * state.size && shikakuViolations(state).length === 0;
}

/**
 * 長方形を描く。座標は正規化され、盤外なら状態を変えない。
 * 既存の長方形と重なるものは取り除いてから追加する。
 */
export function applyShikakuRect(state: ShikakuState, rect: ShikakuRect): ShikakuState {
  if (state.status === "won") return state;
  const size = state.size;
  const norm: ShikakuRect = {
    r1: Math.min(rect.r1, rect.r2),
    r2: Math.max(rect.r1, rect.r2),
    c1: Math.min(rect.c1, rect.c2),
    c2: Math.max(rect.c1, rect.c2),
  };
  if (norm.r1 < 0 || norm.c1 < 0 || norm.r2 >= size || norm.c2 >= size) return state;
  const rects = state.rects.filter((r) => !rectsIntersect(r, norm));
  rects.push(norm);
  const next: ShikakuState = { ...state, rects, moves: state.moves + 1, status: "playing" };
  return { ...next, status: isShikakuComplete(next) ? "won" : "playing" };
}

/** セルを含む長方形を取り除く。 */
export function removeShikakuRectAt(state: ShikakuState, index: number): ShikakuState {
  if (state.status === "won") return state;
  const ri = rectIndexAt(state, index);
  if (ri < 0) return state;
  const rects = state.rects.filter((_, i) => i !== ri);
  return { ...state, rects, moves: state.moves + 1 };
}

/** 解の長方形を順に適用して完成させる（テスト・検証用）。 */
export function solveShikaku(state: ShikakuState): ShikakuState {
  let s: ShikakuState = { ...state, rects: [], status: "playing" };
  for (const rect of state.solution) s = applyShikakuRect(s, rect);
  return s;
}
