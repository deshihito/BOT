// バランスタワーの純粋ロジック（UI 非依存・シード決定的）。
// 土台の上に、提示されたブロック（幅と重さ）を左右位置を選んで1つずつ積む。
//
// 安定判定モデル（決定的）:
//   段 i のブロックと、その下の段（最下段なら土台）との「接触区間」を支持範囲とする。
//   段 i 以上のブロック全体の重心が、その支持範囲の中に入っていなければ、
//   その段でタワーは崩れる。全ての段について下から順にこれを検証する。
//   接触区間が空（下の段と全く重なっていない）場合も崩壊。
//   安定度は「各段の重心から支持範囲の端までの距離」の最小値（単位は盤面座標）。
//
// 状態は JSON 化可能な値のみ。遷移関数は状態を破壊せず新しい状態を返す。

/** 盤面の幅（座標系は 0〜100）。 */
export const BALANCE_FIELD_WIDTH = 100;
/** 土台の区間。 */
export const BALANCE_BASE = { left: 35, right: 65 };

export type BalanceBlockSpec = {
  width: number;
  weight: number;
};

export type PlacedBalanceBlock = BalanceBlockSpec & {
  /** 中心の x 座標。 */
  center: number;
};

export type BalanceStatus = "playing" | "collapsed";

export type BalanceState = {
  seed: number;
  rng: number;
  /** 積まれたブロック（下から順）。崩壊した段も含む。 */
  blocks: PlacedBalanceBlock[];
  /** 次に積むブロック。 */
  current: BalanceBlockSpec;
  status: BalanceStatus;
  /** 安定して積めた個数（＝スコア）。 */
  score: number;
  /** 崩れた段（0始まり）。崩れていなければ null。 */
  collapsedLevel: number | null;
  /** 直近に積んだときの安定度（重心から端までの最小距離）。 */
  lastMargin: number | null;
};

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

const WIDTH_CHOICES = [16, 20, 24, 28, 32];

function drawBlock(rng: number): { spec: BalanceBlockSpec; rng: number } {
  const a = nextRandom(rng);
  const b = nextRandom(a.rng);
  const width = WIDTH_CHOICES[Math.min(WIDTH_CHOICES.length - 1, Math.floor(a.value * WIDTH_CHOICES.length))];
  const weight = 1 + Math.floor(b.value * 3); // 1〜3
  return { spec: { width, weight }, rng: b.rng };
}

export function createBalanceGame(seed: number): BalanceState {
  const first = drawBlock(seed | 0);
  return {
    seed: seed | 0,
    rng: first.rng,
    blocks: [],
    current: first.spec,
    status: "playing",
    score: 0,
    collapsedLevel: null,
    lastMargin: null,
  };
}

export type StabilityResult = {
  stable: boolean;
  /** 崩れる段（0始まり）。安定なら null。 */
  failLevel: number | null;
  /** 重心から支持範囲の端までの距離の最小値。 */
  minMargin: number;
};

function intervalOf(block: PlacedBalanceBlock): { left: number; right: number } {
  return { left: block.center - block.width / 2, right: block.center + block.width / 2 };
}

/** 積まれたブロック列の安定性を検証する。 */
export function checkStability(blocks: PlacedBalanceBlock[]): StabilityResult {
  let minMargin = Number.POSITIVE_INFINITY;
  for (let i = 0; i < blocks.length; i++) {
    const supportBase = i === 0 ? BALANCE_BASE : intervalOf(blocks[i - 1]);
    const mine = intervalOf(blocks[i]);
    const left = Math.max(supportBase.left, mine.left);
    const right = Math.min(supportBase.right, mine.right);
    if (right <= left) {
      return { stable: false, failLevel: i, minMargin: Math.min(minMargin, -1) };
    }
    // 段 i 以上の重心。
    let weighted = 0;
    let total = 0;
    for (let j = i; j < blocks.length; j++) {
      weighted += blocks[j].weight * blocks[j].center;
      total += blocks[j].weight;
    }
    const com = weighted / total;
    const margin = Math.min(com - left, right - com);
    if (margin < minMargin) minMargin = margin;
    if (com < left || com > right) {
      return { stable: false, failLevel: i, minMargin };
    }
  }
  return { stable: true, failLevel: null, minMargin: blocks.length === 0 ? 0 : minMargin };
}

/** 現在のブロックを center に置いた場合の安定性を先読みする（状態は変えない）。 */
export function previewStability(state: BalanceState, center: number): StabilityResult {
  const clamped = clampCenter(center, state.current.width);
  return checkStability([...state.blocks, { ...state.current, center: clamped }]);
}

/** ブロックが盤面からはみ出さないよう中心を制限する。 */
export function clampCenter(center: number, width: number): number {
  const half = width / 2;
  return Math.min(BALANCE_FIELD_WIDTH - half, Math.max(half, center));
}

/**
 * 現在のブロックを center の位置に積む。
 * 安定すれば次ブロックが提示され、崩れれば status が collapsed になる。
 */
export function placeBlock(state: BalanceState, center: number): BalanceState {
  if (state.status !== "playing") return state;
  const placed: PlacedBalanceBlock = {
    ...state.current,
    center: clampCenter(center, state.current.width),
  };
  const blocks = [...state.blocks, placed];
  const result = checkStability(blocks);
  if (!result.stable) {
    return {
      ...state,
      blocks,
      status: "collapsed",
      collapsedLevel: result.failLevel,
      lastMargin: result.minMargin,
    };
  }
  const next = drawBlock(state.rng);
  return {
    ...state,
    blocks,
    current: next.spec,
    rng: next.rng,
    score: state.score + 1,
    lastMargin: result.minMargin,
  };
}

/** 全体の重心 x（表示用）。ブロックが無ければ土台の中心。 */
export function overallCenterOfMass(blocks: PlacedBalanceBlock[]): number {
  if (blocks.length === 0) return (BALANCE_BASE.left + BALANCE_BASE.right) / 2;
  let weighted = 0;
  let total = 0;
  for (const b of blocks) {
    weighted += b.weight * b.center;
    total += b.weight;
  }
  return weighted / total;
}
