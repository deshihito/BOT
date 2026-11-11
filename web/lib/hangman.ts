// ハングマンの純粋ロジック（UI 非依存・シード決定的）。
// 英単語の文字を1文字ずつ当てる。ミス6回で終了。
// 同じ文字の再入力・不正な入力・終了後の入力は状態を変えない。

export type HangmanStatus = "playing" | "won" | "lost";

export type HangmanWord = { word: string; category: string };

export const HANGMAN_MAX_MISSES = 6;

export const HANGMAN_WORDS: HangmanWord[] = [
  // 動物
  { word: "ELEPHANT", category: "動物" },
  { word: "GIRAFFE", category: "動物" },
  { word: "PENGUIN", category: "動物" },
  { word: "DOLPHIN", category: "動物" },
  { word: "OCTOPUS", category: "動物" },
  { word: "RABBIT", category: "動物" },
  { word: "TURTLE", category: "動物" },
  { word: "MONKEY", category: "動物" },
  { word: "ZEBRA", category: "動物" },
  { word: "PANDA", category: "動物" },
  { word: "KOALA", category: "動物" },
  { word: "TIGER", category: "動物" },
  { word: "LION", category: "動物" },
  { word: "HORSE", category: "動物" },
  { word: "DONKEY", category: "動物" },
  { word: "CAMEL", category: "動物" },
  { word: "KANGAROO", category: "動物" },
  { word: "CROCODILE", category: "動物" },
  { word: "BUTTERFLY", category: "動物" },
  { word: "SQUIRREL", category: "動物" },
  { word: "BEAR", category: "動物" },
  { word: "WOLF", category: "動物" },
  // 食べ物
  { word: "PIZZA", category: "食べ物" },
  { word: "BURGER", category: "食べ物" },
  { word: "SUSHI", category: "食べ物" },
  { word: "RAMEN", category: "食べ物" },
  { word: "PASTA", category: "食べ物" },
  { word: "SALAD", category: "食べ物" },
  { word: "CHEESE", category: "食べ物" },
  { word: "BUTTER", category: "食べ物" },
  { word: "APPLE", category: "食べ物" },
  { word: "BANANA", category: "食べ物" },
  { word: "ORANGE", category: "食べ物" },
  { word: "GRAPE", category: "食べ物" },
  { word: "MELON", category: "食べ物" },
  { word: "PEACH", category: "食べ物" },
  { word: "BREAD", category: "食べ物" },
  { word: "CURRY", category: "食べ物" },
  { word: "SOUP", category: "食べ物" },
  { word: "CAKE", category: "食べ物" },
  // スポーツ
  { word: "SOCCER", category: "スポーツ" },
  { word: "TENNIS", category: "スポーツ" },
  { word: "BASEBALL", category: "スポーツ" },
  { word: "BASKETBALL", category: "スポーツ" },
  { word: "SWIMMING", category: "スポーツ" },
  { word: "SKIING", category: "スポーツ" },
  { word: "BOXING", category: "スポーツ" },
  { word: "GOLF", category: "スポーツ" },
  { word: "RUGBY", category: "スポーツ" },
  { word: "VOLLEYBALL", category: "スポーツ" },
  { word: "KARATE", category: "スポーツ" },
  { word: "JUDO", category: "スポーツ" },
  // 自然
  { word: "MOUNTAIN", category: "自然" },
  { word: "RIVER", category: "自然" },
  { word: "OCEAN", category: "自然" },
  { word: "FOREST", category: "自然" },
  { word: "DESERT", category: "自然" },
  { word: "ISLAND", category: "自然" },
  { word: "RAINBOW", category: "自然" },
  { word: "THUNDER", category: "自然" },
  { word: "SNOW", category: "自然" },
  { word: "CLOUD", category: "自然" },
  { word: "BEACH", category: "自然" },
  { word: "VALLEY", category: "自然" },
  { word: "VOLCANO", category: "自然" },
  { word: "GLACIER", category: "自然" },
  // 職業
  { word: "TEACHER", category: "職業" },
  { word: "DOCTOR", category: "職業" },
  { word: "FARMER", category: "職業" },
  { word: "PILOT", category: "職業" },
  { word: "NURSE", category: "職業" },
  { word: "BAKER", category: "職業" },
  { word: "SINGER", category: "職業" },
  { word: "DRIVER", category: "職業" },
  { word: "PAINTER", category: "職業" },
  { word: "COOK", category: "職業" },
  // 音楽
  { word: "PIANO", category: "音楽" },
  { word: "GUITAR", category: "音楽" },
  { word: "VIOLIN", category: "音楽" },
  { word: "TRUMPET", category: "音楽" },
  { word: "FLUTE", category: "音楽" },
  { word: "DRUMS", category: "音楽" },
  { word: "HARP", category: "音楽" },
  { word: "CELLO", category: "音楽" },
];

export type HangmanState = {
  word: string;
  category: string;
  /** 入力済みの文字（大文字 A-Z、重複なし）。 */
  guessed: string[];
  misses: number;
  maxMisses: number;
  status: HangmanStatus;
  seed: number;
};

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function normalizeLetter(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim().toUpperCase();
  if (s.length !== 1 || s < "A" || s > "Z") return null;
  return s;
}

function freshState(word: string, category: string, seed: number): HangmanState {
  return {
    word,
    category,
    guessed: [],
    misses: 0,
    maxMisses: HANGMAN_MAX_MISSES,
    status: "playing",
    seed,
  };
}

export function createHangmanGame(seed: number): HangmanState {
  const r = nextRandom(seed | 0);
  const picked = HANGMAN_WORDS[Math.floor(r.value * HANGMAN_WORDS.length)];
  return freshState(picked.word, picked.category, seed | 0);
}

/** 指定した単語で開始する（テスト・固定出題用）。単語が不正なら null。 */
export function createHangmanFromWord(word: unknown, category: unknown): HangmanState | null {
  if (typeof word !== "string") return null;
  const w = word.trim().toUpperCase();
  if (!/^[A-Z]{2,}$/.test(w)) return null;
  const c = typeof category === "string" && category.trim() !== "" ? category.trim() : "ことば";
  return freshState(w, c, 0);
}

/** 1文字当てる。再入力・不正入力・終了後は同じ状態を返す。 */
export function guessLetter(state: HangmanState, input: unknown): HangmanState {
  if (state.status !== "playing") return state;
  const letter = normalizeLetter(input);
  if (letter === null) return state;
  if (state.guessed.includes(letter)) return state;
  const guessed = [...state.guessed, letter];
  const hit = state.word.includes(letter);
  const misses = hit ? state.misses : state.misses + 1;
  const allRevealed = [...new Set(state.word.split(""))].every((ch) => guessed.includes(ch));
  const status: HangmanStatus = allRevealed ? "won" : misses >= state.maxMisses ? "lost" : "playing";
  return { ...state, guessed, misses, status };
}

/** 表示用文字列。未開示は "_"、敗北時は全開示。 */
export function displayWord(state: HangmanState): string {
  if (state.status === "lost") return state.word;
  return state.word
    .split("")
    .map((ch) => (state.guessed.includes(ch) ? ch : "_"))
    .join("");
}

export function remainingMisses(state: HangmanState): number {
  return Math.max(0, state.maxMisses - state.misses);
}

export function isLetterInWord(state: HangmanState, letter: string): boolean {
  const normalized = normalizeLetter(letter);
  return normalized !== null && state.word.includes(normalized);
}
