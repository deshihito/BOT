// 2x2 ルービックキューブの純粋ロジック（UI 非依存・シード決定的）。
// ステッカーモデル: 6面 × 4枚 = 24枚。各ステッカーは
// 「キューブ上の位置（x,y,z ∈ {-1,1}）＋ 法線ベクトル」で定義し、
// 面の回転は3次元座標の回転として計算するので、実際のキューブと同じ
// 置換になることが保証される。
// スクランブルは完成状態からのランダムな回転列なので、必ず解ける。
// 手順の逆再生で必ず完成に戻る。

export type CubeFace = "U" | "D" | "F" | "B" | "L" | "R";
export type CubeColor = "white" | "yellow" | "green" | "blue" | "orange" | "red";
export type CubeMove = CubeFace | `${CubeFace}'`;

export const CUBE_FACES: CubeFace[] = ["U", "D", "F", "B", "L", "R"];

export const CUBE_FACE_COLOR: Record<CubeFace, CubeColor> = {
  U: "white",
  D: "yellow",
  F: "green",
  B: "blue",
  L: "orange",
  R: "red",
};

export const CUBE_MOVES: CubeMove[] = [
  "U", "U'", "D", "D'", "F", "F'", "B", "B'", "L", "L'", "R", "R'",
];

export type CubeState = {
  seed: number;
  /** 24枚のステッカー色。面の順序は CUBE_FACES、各面は [左上, 右上, 左下, 右下]。 */
  stickers: CubeColor[];
  /** 適用したスクランブル手順（作成時のみ。解くための逆手順が導ける）。 */
  scramble: CubeMove[];
  moves: number;
  status: "playing" | "won";
};

type Vec = [number, number, number];

type StickerDef = { face: CubeFace; pos: Vec; normal: Vec };

/**
 * ステッカー定義テーブルを作成する（モジュール読み込み時に一回だけ）。
 * 各面の4枚は、その面を外側から見たときの [左上, 右上, 左下, 右下] 順。
 */
function buildStickerDefs(): StickerDef[] {
  const defs: StickerDef[] = [];
  const push = (face: CubeFace, pos: Vec, normal: Vec) => defs.push({ face, pos, normal });
  // U（上から見て奥が B）: 左上=奥左, 右上=奥右, 左下=手前左, 右下=手前右
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) push("U", [x, 1, z], [0, 1, 0]);
  // D（下から見て手前 F が上）: 左上=手前左, 右上=手前右, 左下=奥左, 右下=奥右
  for (const [x, z] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const) push("D", [x, -1, z], [0, -1, 0]);
  // F: 左上, 右上, 左下, 右下（x, y）
  for (const [x, y] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const) push("F", [x, y, 1], [0, 0, 1]);
  // B（後ろから見るので左右が反転）: 左上=右, 右上=左, 左下=右下, 右下=左下
  for (const [x, y] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) push("B", [x, y, -1], [0, 0, -1]);
  // L（左から見る。右側が F）: 左上=奥上, 右上=手前上, 左下=奥下, 右下=手前下（z, y）
  for (const [z, y] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const) push("L", [-1, y, z], [-1, 0, 0]);
  // R（右から見る。左側が F）: 左上=手前上, 右上=奥上, 左下=手前下, 右下=奥下（z, y）
  for (const [z, y] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) push("R", [1, y, z], [1, 0, 0]);
  return defs;
}

const STICKER_DEFS = buildStickerDefs();

function vecKey(v: Vec): string {
  return `${v[0]},${v[1]},${v[2]}`;
}

const STICKER_INDEX = new Map<string, number>();
STICKER_DEFS.forEach((def, i) => {
  STICKER_INDEX.set(`${vecKey(def.pos)}|${vecKey(def.normal)}`, i);
});

/** 面を外側から見て時計回りの回転（位置・法線の両方に適用する）。 */
const FACE_ROTATION: Record<CubeFace, { axis: 0 | 1 | 2; layer: number; rotate: (v: Vec) => Vec }> = {
  U: { axis: 1, layer: 1, rotate: ([x, y, z]) => [-z, y, x] },
  D: { axis: 1, layer: -1, rotate: ([x, y, z]) => [z, y, -x] },
  R: { axis: 0, layer: 1, rotate: ([x, y, z]) => [x, z, -y] },
  L: { axis: 0, layer: -1, rotate: ([x, y, z]) => [x, -z, y] },
  F: { axis: 2, layer: 1, rotate: ([x, y, z]) => [y, -x, z] },
  B: { axis: 2, layer: -1, rotate: ([x, y, z]) => [-y, x, z] },
};

/** 時計回り1回の置換。forward[i] = ステッカー i の移動先 index。 */
function buildClockwisePermutation(face: CubeFace): number[] {
  const { axis, layer, rotate } = FACE_ROTATION[face];
  const forward = STICKER_DEFS.map((_, i) => i);
  STICKER_DEFS.forEach((def, i) => {
    if (def.pos[axis] !== layer) return;
    const newPos = rotate(def.pos);
    const newNormal = rotate(def.normal);
    const j = STICKER_INDEX.get(`${vecKey(newPos)}|${vecKey(newNormal)}`);
    if (j === undefined) throw new Error("ステッカー定義が不完全です");
    forward[i] = j;
  });
  return forward;
}

const CW_PERMUTATION: Record<CubeFace, number[]> = {
  U: buildClockwisePermutation("U"),
  D: buildClockwisePermutation("D"),
  F: buildClockwisePermutation("F"),
  B: buildClockwisePermutation("B"),
  L: buildClockwisePermutation("L"),
  R: buildClockwisePermutation("R"),
};

function applyPermutation(stickers: CubeColor[], forward: number[]): CubeColor[] {
  const next = new Array<CubeColor>(stickers.length);
  for (let i = 0; i < stickers.length; i++) {
    next[forward[i]] = stickers[i];
  }
  return next;
}

/** 完成状態のステッカー。 */
export function solvedStickers(): CubeColor[] {
  return STICKER_DEFS.map((def) => CUBE_FACE_COLOR[def.face]);
}

/** 全面が単色にそろっているか。 */
export function isCubeSolved(stickers: CubeColor[]): boolean {
  for (let f = 0; f < CUBE_FACES.length; f++) {
    const base = stickers[f * 4];
    for (let k = 1; k < 4; k++) {
      if (stickers[f * 4 + k] !== base) return false;
    }
  }
  return true;
}

export function parseCubeMove(move: unknown): CubeMove | null {
  if (typeof move !== "string") return null;
  return (CUBE_MOVES as string[]).includes(move) ? (move as CubeMove) : null;
}

/** 回転の逆（U ↔ U'）。 */
export function inverseCubeMove(move: CubeMove): CubeMove {
  return move.endsWith("'") ? (move[0] as CubeFace) : (`${move}'` as CubeMove);
}

function applyMoveToStickers(stickers: CubeColor[], move: CubeMove): CubeColor[] {
  const face = move[0] as CubeFace;
  const forward = CW_PERMUTATION[face];
  if (!move.endsWith("'")) return applyPermutation(stickers, forward);
  // 逆回転は時計回りを3回適用したものと等しい。
  let cur = stickers;
  for (let i = 0; i < 3; i++) cur = applyPermutation(cur, forward);
  return cur;
}

/** 完成状態のキューブ（スクランブルなし）。 */
export function createSolvedCube(): CubeState {
  return { seed: 0, stickers: solvedStickers(), scramble: [], moves: 0, status: "playing" };
}

/** mulberry32（minesweeper 等と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export const CUBE_SCRAMBLE_LENGTH = 14;

/** スクランブル済みの新しいキューブを作る。 */
export function createCubeGame(seed: number): CubeState {
  let rng = seed | 0;
  let stickers = solvedStickers();
  const scramble: CubeMove[] = [];
  let prevFace: CubeFace | null = null;
  while (scramble.length < CUBE_SCRAMBLE_LENGTH || isCubeSolved(stickers)) {
    const pickFace = nextRandom(rng);
    rng = pickFace.rng;
    const face = CUBE_FACES[Math.floor(pickFace.value * CUBE_FACES.length)];
    if (face === prevFace) continue;
    const pickDir = nextRandom(rng);
    rng = pickDir.rng;
    const move: CubeMove = pickDir.value < 0.5 ? face : (`${face}'` as CubeMove);
    scramble.push(move);
    stickers = applyMoveToStickers(stickers, move);
    prevFace = face;
    if (scramble.length > 40) break; // 念のための上限（通常は到達しない）
  }
  return { seed: seed | 0, stickers, scramble, moves: 0, status: "playing" };
}

export function applyCubeMove(state: CubeState, move: CubeMove): CubeState {
  if (state.status === "won") return state;
  if (parseCubeMove(move) === null) return state;
  const stickers = applyMoveToStickers(state.stickers, move);
  const won = isCubeSolved(stickers);
  return { ...state, stickers, moves: state.moves + 1, status: won ? "won" : "playing" };
}
