// 色文字マッチ（ストループ課題）の純粋ロジック（UI 非依存・シード決定的）。
// 色の名前が、その文字の色（インク）と一致しているかを当てる。
// 問題生成・正誤判定・スコア計算を純粋関数で扱い、制限時間は UI 側で管理する。

export type CmColor = {
  /** 表示する色名（ひらがな）。 */
  name: string;
  /** インク色（CSS カラー）。 */
  css: string;
};

export const CM_COLORS: CmColor[] = [
  { name: "あか", css: "#e53935" },
  { name: "あお", css: "#1e6fd9" },
  { name: "みどり", css: "#2e9e4f" },
  { name: "きいろ", css: "#d9a400" },
  { name: "むらさき", css: "#8e44ad" },
  { name: "オレンジ", css: "#ef7d1a" },
];

export type CmQuestion = {
  wordIndex: number;
  inkIndex: number;
  /** 文字の意味とインク色が一致しているか。 */
  match: boolean;
};

export type CmState = {
  question: CmQuestion;
  score: number;
  combo: number;
  maxCombo: number;
  answered: number;
  correct: number;
  /** 直前の回答が正解だったか（未回答なら null）。 */
  lastCorrect: boolean | null;
  rng: number;
};

export const CM_GAME_SECONDS = 30;

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function genQuestion(rng: number): { question: CmQuestion; rng: number } {
  const r1 = nextRandom(rng);
  const wordIndex = Math.floor(r1.value * CM_COLORS.length);
  const r2 = nextRandom(r1.rng);
  const makeMatch = r2.value < 0.5;
  let inkIndex = wordIndex;
  if (!makeMatch) {
    const r3 = nextRandom(r2.rng);
    // 一致しない色から1つ選ぶ
    const others = CM_COLORS.map((_, i) => i).filter((i) => i !== wordIndex);
    inkIndex = others[Math.floor(r3.value * others.length)];
    return { question: { wordIndex, inkIndex, match: false }, rng: r3.rng };
  }
  return { question: { wordIndex, inkIndex, match: true }, rng: r2.rng };
}

export function createColorMatchGame(seed: number): CmState {
  const { question, rng } = genQuestion(seed | 0);
  return {
    question,
    score: 0,
    combo: 0,
    maxCombo: 0,
    answered: 0,
    correct: 0,
    lastCorrect: null,
    rng,
  };
}

/** コンボ数に応じた1問の得点（コンボが伸びるほど少しずつ増える、上限あり）。 */
export function scoreForCombo(combo: number): number {
  return 100 + Math.min(combo, 10) * 10;
}

/**
 * 回答を適用する。saidMatch = 「文字と色があっている」と思ったかどうか。
 * 正解ならスコアとコンボが伸び、不正解ならコンボが切れる。次の問題も生成する。
 */
export function answerColorMatch(state: CmState, saidMatch: boolean): CmState {
  const correct = saidMatch === state.question.match;
  const combo = correct ? state.combo + 1 : 0;
  const { question, rng } = genQuestion(state.rng);
  return {
    ...state,
    question,
    score: correct ? state.score + scoreForCombo(state.combo) : state.score,
    combo,
    maxCombo: Math.max(state.maxCombo, combo),
    answered: state.answered + 1,
    correct: state.correct + (correct ? 1 : 0),
    lastCorrect: correct,
    rng,
  };
}
