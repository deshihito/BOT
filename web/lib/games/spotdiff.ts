// 間違い探しの純粋ロジック（UI 非依存・シード決定的）。
// 形×色の図形モザイク場面を生成し、右盤だけ N 箇所を別の図形に差し替える。
// 差し替え位置・見つけた位置・ミスタップ数を状態として持つ。

export const SPOT_DIFF_ROWS = 6;
export const SPOT_DIFF_COLS = 8;

export type SpotDiffLevelKey = "easy" | "normal" | "hard";

/** レベルごとの間違いの数。 */
export const SPOT_DIFF_COUNTS: Record<SpotDiffLevelKey, number> = {
  easy: 3,
  normal: 5,
  hard: 7,
};

export type SpotShape = "circle" | "triangle" | "square" | "star" | "diamond" | "heart" | "cross";

export interface SpotDiffSymbol {
  /** 絵柄 ID（盤面のマスに入る）。 */
  id: string;
  shape: SpotShape;
  /** 塗り色（CSS カラー）。 */
  color: string;
}

const SPOT_SHAPES: SpotShape[] = ["circle", "triangle", "square", "star", "diamond", "heart", "cross"];
const SPOT_COLORS: { key: string; value: string }[] = [
  { key: "red", value: "#d93a3a" },
  { key: "blue", value: "#2f6fd0" },
  { key: "green", value: "#2f9e5f" },
  { key: "purple", value: "#8b4fc0" },
];

/** 場面に使う絵柄（形7種×色4色＝28種、全て見分けが付く）。差し替え先もここから選ばれる。 */
export const SPOT_DIFF_SYMBOLS: SpotDiffSymbol[] = SPOT_SHAPES.flatMap((shape) =>
  SPOT_COLORS.map((c) => ({ id: `${shape}-${c.key}`, shape, color: c.value })),
);

/** 絵柄 ID のパレット。 */
export const SPOT_DIFF_PALETTE: string[] = SPOT_DIFF_SYMBOLS.map((s) => s.id);

/** 絵柄 ID から図形定義を引く。 */
export function spotDiffSymbol(id: string): SpotDiffSymbol {
  return SPOT_DIFF_SYMBOLS.find((s) => s.id === id) ?? SPOT_DIFF_SYMBOLS[0];
}

export type SpotDiffStatus = "playing" | "won";

export interface SpotDiffState {
  rows: number;
  cols: number;
  /** 左盤（お手本）。 */
  base: string[];
  /** 右盤（間違い入り）。 */
  altered: string[];
  /** 間違いのあるマスの index（昇順）。 */
  diffIndexes: number[];
  /** 見つけたマスの index（昇順）。 */
  found: number[];
  mistakes: number;
  status: SpotDiffStatus;
  seed: number;
}

/** mulberry32 系の決定的 RNG（生成時にだけ使うローカルクロージャ）。 */
function makeRng(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)];
}

export function createSpotDiffGame(level: SpotDiffLevelKey, seed: number): SpotDiffState {
  const diffTotal = SPOT_DIFF_COUNTS[level] ?? SPOT_DIFF_COUNTS.easy;
  const rng = makeRng(seed);
  const total = SPOT_DIFF_ROWS * SPOT_DIFF_COLS;
  const base: string[] = Array.from({ length: total }, () => pick(SPOT_DIFF_PALETTE, rng));

  // 間違いの位置を重複なく選ぶ
  const pool = Array.from({ length: total }, (_, i) => i);
  const diffIndexes: number[] = [];
  while (diffIndexes.length < diffTotal && pool.length > 0) {
    const pickAt = Math.floor(rng() * pool.length);
    diffIndexes.push(pool.splice(pickAt, 1)[0]);
  }
  diffIndexes.sort((a, b) => a - b);

  const altered = [...base];
  for (const idx of diffIndexes) {
    let next = pick(SPOT_DIFF_PALETTE, rng);
    while (next === base[idx]) next = pick(SPOT_DIFF_PALETTE, rng);
    altered[idx] = next;
  }

  return {
    rows: SPOT_DIFF_ROWS,
    cols: SPOT_DIFF_COLS,
    base,
    altered,
    diffIndexes,
    found: [],
    mistakes: 0,
    status: "playing",
    seed,
  };
}

export function isSpotDiff(state: SpotDiffState, index: number): boolean {
  return state.diffIndexes.includes(index);
}

/** 右盤のマスをタップする。正解なら found に加わり、全て見つけると won。 */
export function tapSpotDiff(state: SpotDiffState, index: number): SpotDiffState {
  if (state.status === "won") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.base.length) return state;
  if (state.found.includes(index)) return state;
  if (state.diffIndexes.includes(index)) {
    const found = [...state.found, index].sort((a, b) => a - b);
    const won = found.length >= state.diffIndexes.length;
    return { ...state, found, status: won ? "won" : "playing" };
  }
  return { ...state, mistakes: state.mistakes + 1 };
}
