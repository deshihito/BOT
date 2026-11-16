// ヤッツィーの純粋ロジック（UI 非依存・シード決定的）。
// ダイス5個を振り（振り直しは最大2回まで）、13の役カテゴリのどれか1つに
// スコアを記録する。各カテゴリは1回だけ記録でき、13ターンで終了。
// 上段（1〜6の数え役）の合計が63以上でボーナス35点。

export const YAHTZEE_CATEGORIES = [
  "ones",
  "twos",
  "threes",
  "fours",
  "fives",
  "sixes",
  "threeOfAKind",
  "fourOfAKind",
  "fullHouse",
  "smallStraight",
  "largeStraight",
  "yahtzee",
  "chance",
] as const;

export type YahtzeeCategory = (typeof YAHTZEE_CATEGORIES)[number];

export const YAHTZEE_CATEGORY_LABELS: Record<YahtzeeCategory, string> = {
  ones: "ワンズ（1）",
  twos: "ツーズ（2）",
  threes: "スリーズ（3）",
  fours: "フォーズ（4）",
  fives: "ファイブズ（5）",
  sixes: "シックスズ（6）",
  threeOfAKind: "スリーカード",
  fourOfAKind: "フォーカード",
  fullHouse: "フルハウス",
  smallStraight: "Sストレート",
  largeStraight: "Lストレート",
  yahtzee: "ヤッツィー",
  chance: "チャンス",
};

/** 上段のカテゴリ index は 0〜5（出目 1〜6 に対応）。 */
export const UPPER_BONUS_THRESHOLD = 63;
export const UPPER_BONUS = 35;
export const MAX_ROLLS_PER_TURN = 3;

export type YahtzeeState = {
  dice: number[];
  held: boolean[];
  /** このターンで振った回数（0〜3）。 */
  rollsUsed: number;
  /** カテゴリ index → 記録済みスコア（未記録は null）。 */
  scores: (number | null)[];
  /** 終了したターン数（0〜13）。 */
  turnsDone: number;
  status: "playing" | "finished";
  seed: number;
  rng: number;
};

/** mulberry32（minesweeper 等と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function createYahtzee(seed: number): YahtzeeState {
  return {
    dice: [1, 1, 1, 1, 1],
    held: [false, false, false, false, false],
    rollsUsed: 0,
    scores: new Array<number | null>(YAHTZEE_CATEGORIES.length).fill(null),
    turnsDone: 0,
    status: "playing",
    seed: seed | 0,
    rng: seed | 0,
  };
}

function countsOf(dice: number[]): number[] {
  const counts = new Array<number>(7).fill(0);
  for (const d of dice) {
    if (Number.isInteger(d) && d >= 1 && d <= 6) counts[d]++;
  }
  return counts;
}

function sumOf(dice: number[]): number {
  return dice.reduce((a, b) => a + b, 0);
}

function hasStraight(dice: number[], length: number): boolean {
  const set = new Set(dice);
  const starts = length === 4 ? [1, 2, 3] : [1, 2];
  return starts.some((s) => {
    for (let k = 0; k < length; k++) {
      if (!set.has(s + k)) return false;
    }
    return true;
  });
}

/** ダイスの出目に対するカテゴリの得点（記録候補の表示にも使う）。 */
export function yahtzeeScoreFor(dice: number[], category: YahtzeeCategory): number {
  if (!Array.isArray(dice) || dice.length !== 5) return 0;
  const counts = countsOf(dice);
  switch (category) {
    case "ones":
      return counts[1] * 1;
    case "twos":
      return counts[2] * 2;
    case "threes":
      return counts[3] * 3;
    case "fours":
      return counts[4] * 4;
    case "fives":
      return counts[5] * 5;
    case "sixes":
      return counts[6] * 6;
    case "threeOfAKind":
      return counts.some((c) => c >= 3) ? sumOf(dice) : 0;
    case "fourOfAKind":
      return counts.some((c) => c >= 4) ? sumOf(dice) : 0;
    case "fullHouse":
      return counts.includes(3) && counts.includes(2) ? 25 : 0;
    case "smallStraight":
      return hasStraight(dice, 4) ? 30 : 0;
    case "largeStraight":
      return hasStraight(dice, 5) ? 40 : 0;
    case "yahtzee":
      return counts.some((c) => c === 5) ? 50 : 0;
    case "chance":
      return sumOf(dice);
    default:
      return 0;
  }
}

/** ダイスを振る。保持していないダイスだけ振り直す。振れる回数は1ターン3回まで。 */
export function rollYahtzeeDice(state: YahtzeeState): YahtzeeState {
  if (state.status !== "playing") return state;
  if (state.rollsUsed >= MAX_ROLLS_PER_TURN) return state;
  let rng = state.rng;
  const dice = state.dice.map((d, i) => {
    if (state.rollsUsed > 0 && state.held[i]) return d;
    const r = nextRandom(rng);
    rng = r.rng;
    return 1 + Math.floor(r.value * 6);
  });
  return { ...state, dice, rng, rollsUsed: state.rollsUsed + 1 };
}

/** ダイスの保持を切り替える（1回以上振った後だけ有効）。 */
export function toggleYahtzeeHold(state: YahtzeeState, index: number): YahtzeeState {
  if (state.status !== "playing") return state;
  if (state.rollsUsed === 0) return state;
  if (!Number.isInteger(index) || index < 0 || index >= 5) return state;
  const held = [...state.held];
  held[index] = !held[index];
  return { ...state, held };
}

/** カテゴリに現在のダイスでスコアを記録し、次のターンへ進める。 */
export function applyYahtzeeScore(
  state: YahtzeeState,
  category: YahtzeeCategory,
): YahtzeeState {
  if (state.status !== "playing") return state;
  if (state.rollsUsed === 0) return state;
  const idx = YAHTZEE_CATEGORIES.indexOf(category);
  if (idx < 0) return state;
  if (state.scores[idx] !== null) return state;
  const scores = [...state.scores];
  scores[idx] = yahtzeeScoreFor(state.dice, category);
  const turnsDone = state.turnsDone + 1;
  return {
    ...state,
    scores,
    turnsDone,
    held: [false, false, false, false, false],
    rollsUsed: 0,
    status: turnsDone >= YAHTZEE_CATEGORIES.length ? "finished" : "playing",
  };
}

export type YahtzeeTotals = {
  upper: number;
  upperBonus: number;
  lower: number;
  total: number;
  recorded: number;
};

export function yahtzeeTotals(state: YahtzeeState): YahtzeeTotals {
  let upper = 0;
  let lower = 0;
  let recorded = 0;
  state.scores.forEach((score, i) => {
    if (score === null) return;
    recorded++;
    if (i < 6) upper += score;
    else lower += score;
  });
  const upperBonus = upper >= UPPER_BONUS_THRESHOLD ? UPPER_BONUS : 0;
  return { upper, upperBonus, lower, total: upper + upperBonus + lower, recorded };
}
