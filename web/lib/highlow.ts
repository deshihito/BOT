// ハイ＆ローの純粋ロジック（UI 非依存・シード決定的）。
// ルール:
// - ジョーカーなし52枚。現在のカードを見て、次にめくるカードが
//   「今より高い」か「今より低い」かを当てる。
// - 当たると連続記録（ストリーク）が伸びて続行、外すとその場でゲーム終了。
// - 次のカードが今と同数なら引き分け: ストリークはそのままで続行できる。
// - 山札が尽きたらクリアとして終了する。

export type HighLowGuess = "high" | "low";
export type HighLowResult = "correct" | "wrong" | "draw";
export type HighLowStatus = "playing" | "finished";
export type HighLowFinishReason = "wrong" | "cleared" | null;

export const HIGHLOW_SUITS = ["♠", "♥", "♦", "♣"] as const;
export const HIGHLOW_RED_SUITS: ReadonlySet<string> = new Set(["♥", "♦"]);

export interface HighLowLast {
  guess: HighLowGuess;
  /** めくられたカード id。 */
  card: number;
  result: HighLowResult;
}

export interface HighLowState {
  /** 先頭が現在のカード、以降が山札の順序（カード id 0〜51）。 */
  pile: number[];
  streak: number;
  bestStreak: number;
  correctTotal: number;
  status: HighLowStatus;
  finishReason: HighLowFinishReason;
  last: HighLowLast | null;
  seed: number;
}

export function highLowSuit(card: number): string {
  return HIGHLOW_SUITS[Math.floor(card / 13)] ?? "♠";
}

export function highLowRank(card: number): number {
  return (card % 13) + 1;
}

export function highLowRankLabel(card: number): string {
  const rank = highLowRank(card);
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

export function highLowCardName(card: number): string {
  return `${highLowSuit(card)}${highLowRankLabel(card)}`;
}

export function isHighLowRed(card: number): boolean {
  return HIGHLOW_RED_SUITS.has(highLowSuit(card));
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

export function createHighLowGame(seed: number): HighLowState {
  const rng = makeRng(seed);
  const pile = Array.from({ length: 52 }, (_, i) => i);
  for (let i = pile.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pile[i], pile[j]] = [pile[j], pile[i]];
  }
  return {
    pile,
    streak: 0,
    bestStreak: 0,
    correctTotal: 0,
    status: "playing",
    finishReason: null,
    last: null,
    seed,
  };
}

export function highLowCurrent(state: HighLowState): number | null {
  return state.pile[0] ?? null;
}

/** 残り山札（次にめくれるカード）の数。 */
export function highLowRemaining(state: HighLowState): number {
  return Math.max(0, state.pile.length - 1);
}

/** 2枚の強弱比較。next が current より高ければ 1、低ければ -1、同数なら 0。 */
export function compareHighLow(current: number, next: number): number {
  const a = highLowRank(current);
  const b = highLowRank(next);
  if (b > a) return 1;
  if (b < a) return -1;
  return 0;
}

export function guessHighLow(state: HighLowState, guess: HighLowGuess): HighLowState {
  if (state.status !== "playing") return state;
  if (guess !== "high" && guess !== "low") return state;
  const current = state.pile[0];
  const next = state.pile[1];
  if (current === undefined) {
    return { ...state, status: "finished", finishReason: "cleared" };
  }
  if (next === undefined) {
    return { ...state, status: "finished", finishReason: "cleared" };
  }
  const cmp = compareHighLow(current, next);
  const result: HighLowResult = cmp === 0 ? "draw" : (cmp > 0) === (guess === "high") ? "correct" : "wrong";
  const pile = state.pile.slice(1); // めくったカードが新しい現在カードになる
  if (result === "wrong") {
    return {
      ...state,
      pile,
      status: "finished",
      finishReason: "wrong",
      last: { guess, card: next, result },
    };
  }
  const streak = result === "correct" ? state.streak + 1 : state.streak;
  const cleared = pile.length < 2;
  return {
    ...state,
    pile,
    streak,
    bestStreak: Math.max(state.bestStreak, streak),
    correctTotal: state.correctTotal + (result === "correct" ? 1 : 0),
    status: cleared ? "finished" : "playing",
    finishReason: cleared ? "cleared" : null,
    last: { guess, card: next, result },
  };
}
