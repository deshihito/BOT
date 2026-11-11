// タイピングの純粋ロジック（UI 非依存・シード決定的）。
// 課題文は内蔵リストからシードで決定的に組み立て、正誤・WPM・正確率を計算する。
// WPM は標準式: (正しく打った文字数 / 5) / 経過分。

/** 課題に使う短文（英語）。 */
export const TYPING_SENTENCES: readonly string[] = [
  "The quick brown fox jumps over the lazy dog.",
  "Practice makes perfect, so keep typing every day.",
  "A journey of a thousand miles begins with a single step.",
  "To be or not to be, that is the question.",
  "All that glitters is not gold.",
  "Actions speak louder than words in most situations.",
  "Knowledge is power, and practice is the key to skill.",
  "The early bird catches the worm every morning.",
  "Every cloud has a silver lining if you look closely.",
  "Time flies when you are having fun with friends.",
  "Honesty is the best policy in every situation.",
  "A picture is worth a thousand words, they say.",
  "When in Rome, do as the Romans do on your trip.",
  "Fortune favors the bold and the brave at heart.",
  "Slow and steady wins the race in the end.",
  "Better late than never, but plan ahead to be safe.",
];

/** 課題に使う英単語。 */
export const TYPING_WORDS: readonly string[] = [
  "the", "of", "and", "to", "in", "is", "you", "that", "it", "he",
  "was", "for", "on", "are", "as", "with", "his", "they", "this", "have",
  "from", "one", "had", "word", "but", "not", "what", "all", "were", "when",
  "your", "can", "said", "there", "use", "each", "which", "she", "how", "their",
  "will", "up", "other", "about", "out", "many", "then", "them", "these", "so",
];

/** mulberry32 系。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

/** シードから決定的に短文を選び、課題文を組み立てる（重複なし）。 */
export function createTypingText(seed: number, sentenceCount: number = 3): string {
  const count = Math.max(1, Math.min(sentenceCount, TYPING_SENTENCES.length));
  const indices = TYPING_SENTENCES.map((_, i) => i);
  let rng = seed | 0;
  for (let i = indices.length - 1; i > 0; i--) {
    const r = nextRandom(rng);
    rng = r.rng;
    const j = Math.floor(r.value * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices
    .slice(0, count)
    .map((i) => TYPING_SENTENCES[i])
    .join(" ");
}

/** シードから決定的に英単語を並べた課題文を組み立てる。 */
export function createTypingWords(seed: number, wordCount: number = 20): string {
  const count = Math.max(1, wordCount);
  const words: string[] = [];
  let rng = seed | 0;
  for (let i = 0; i < count; i++) {
    const r = nextRandom(rng);
    rng = r.rng;
    words.push(TYPING_WORDS[Math.floor(r.value * TYPING_WORDS.length)]);
  }
  return words.join(" ");
}

/** 入力済み文字ごとの正誤を返す（長さは入力文字数と同じ）。 */
export function charResults(prompt: string, typed: string): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < typed.length; i++) {
    out.push(i < prompt.length && typed[i] === prompt[i]);
  }
  return out;
}

export function countCorrect(prompt: string, typed: string): number {
  return charResults(prompt, typed).filter(Boolean).length;
}

/** 課題文を最後まで打ち終えたか。 */
export function isTypingComplete(prompt: string, typed: string): boolean {
  return prompt.length > 0 && typed.length >= prompt.length;
}

export type TypingResult = {
  /** 打った文字数。 */
  totalChars: number;
  /** 正しく打った文字数。 */
  correctChars: number;
  /** 間違って打った文字数。 */
  incorrectChars: number;
  /** 正確率（0〜100、小数1桁）。未入力時は 100。 */
  accuracy: number;
  /** 正しく打った文字ベースの WPM（整数）。 */
  wpm: number;
  /** 打った文字全体ベースの WPM（整数）。 */
  grossWpm: number;
};

/**
 * 打鍵結果を集計する。経過秒数が 0 以下なら WPM は 0。
 * WPM = (文字数 / 5) / (経過秒 / 60)。
 */
export function evaluateTyping(prompt: string, typed: string, elapsedSeconds: number): TypingResult {
  const totalChars = typed.length;
  const correctChars = countCorrect(prompt, typed);
  const incorrectChars = totalChars - correctChars;
  const accuracy =
    totalChars === 0 ? 100 : Math.round((correctChars / totalChars) * 1000) / 10;
  const minutes = elapsedSeconds > 0 ? elapsedSeconds / 60 : 0;
  const wpm = minutes > 0 ? Math.round(correctChars / 5 / minutes) : 0;
  const grossWpm = minutes > 0 ? Math.round(totalChars / 5 / minutes) : 0;
  return { totalChars, correctChars, incorrectChars, accuracy, wpm, grossWpm };
}
