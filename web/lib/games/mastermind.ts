// マスターマインドの純粋ロジック（UI 非依存・シード決定的）。
// 4つのペグの色並びを当てる。正解は重複あり、10回までに当てる。
// ヒット＝色も位置も一致、ブロー＝色は合っているが位置が違う。
// 重複色の集計は「ヒット分を除いた残りで色ごとの最小一致数」を数える標準ルール。

export type MmDifficulty = "easy" | "normal";
export type MmStatus = "playing" | "won" | "lost";

export type MmColor = { id: string; label: string; value: string };

export const MASTERMIND_COLORS: MmColor[] = [
  { id: "red", label: "赤", value: "#e5484d" },
  { id: "blue", label: "青", value: "#3e7bdb" },
  { id: "green", label: "緑", value: "#3d9a50" },
  { id: "yellow", label: "黄", value: "#e6b800" },
  { id: "purple", label: "紫", value: "#8b5cf6" },
  { id: "orange", label: "橙", value: "#f07818" },
];

export const MM_CODE_LENGTH = 4;
export const MM_MAX_GUESSES = 10;

export type MmGuess = {
  pegs: string[];
  hits: number;
  blows: number;
};

export type MmState = {
  difficulty: MmDifficulty;
  /** 使える色数（easy=5 / normal=6）。 */
  colorCount: number;
  secret: string[];
  guesses: MmGuess[];
  status: MmStatus;
  seed: number;
};

export function normalizeMmDifficulty(d: string): MmDifficulty {
  return d === "easy" ? "easy" : "normal";
}

export function mmColorCount(difficulty: MmDifficulty): number {
  return difficulty === "easy" ? 5 : 6;
}

export function mmPalette(difficulty: MmDifficulty): MmColor[] {
  return MASTERMIND_COLORS.slice(0, mmColorCount(difficulty));
}

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

/** ヒット＆ブローを数える。長さが違う・空なら {0,0}。 */
export function scoreGuess(secret: string[], guess: string[]): { hits: number; blows: number } {
  if (secret.length === 0 || secret.length !== guess.length) return { hits: 0, blows: 0 };
  let hits = 0;
  const secretRest = new Map<string, number>();
  const guessRest = new Map<string, number>();
  for (let i = 0; i < secret.length; i++) {
    if (secret[i] === guess[i]) {
      hits++;
    } else {
      secretRest.set(secret[i], (secretRest.get(secret[i]) ?? 0) + 1);
      guessRest.set(guess[i], (guessRest.get(guess[i]) ?? 0) + 1);
    }
  }
  let blows = 0;
  for (const [color, n] of guessRest) {
    blows += Math.min(n, secretRest.get(color) ?? 0);
  }
  return { hits, blows };
}

/** 予想として受理できる形か（長さ・色 ID が難易度の色範囲内）。 */
export function isValidGuess(state: MmState, pegs: unknown): pegs is string[] {
  if (!Array.isArray(pegs) || pegs.length !== MM_CODE_LENGTH) return false;
  const allowed = new Set(mmPalette(state.difficulty).map((c) => c.id));
  return pegs.every((p) => typeof p === "string" && allowed.has(p));
}

export function createMastermindGame(seed: number, difficulty: MmDifficulty | string = "normal"): MmState {
  const diff = normalizeMmDifficulty(difficulty);
  const palette = mmPalette(diff);
  let rng = seed | 0;
  const secret: string[] = [];
  for (let i = 0; i < MM_CODE_LENGTH; i++) {
    const r = nextRandom(rng);
    rng = r.rng;
    secret.push(palette[Math.floor(r.value * palette.length)].id);
  }
  return {
    difficulty: diff,
    colorCount: palette.length,
    secret,
    guesses: [],
    status: "playing",
    seed: seed | 0,
  };
}

/** 予想を1件提出する。不正な予想・終了済みなら同じ状態を返す。 */
export function submitGuess(state: MmState, pegs: string[]): MmState {
  if (state.status !== "playing") return state;
  if (!isValidGuess(state, pegs)) return state;
  const { hits, blows } = scoreGuess(state.secret, pegs);
  const guesses = [...state.guesses, { pegs: [...pegs], hits, blows }];
  const status: MmStatus =
    hits === MM_CODE_LENGTH ? "won" : guesses.length >= MM_MAX_GUESSES ? "lost" : "playing";
  return { ...state, guesses, status };
}

export function remainingGuesses(state: MmState): number {
  return Math.max(0, MM_MAX_GUESSES - state.guesses.length);
}
