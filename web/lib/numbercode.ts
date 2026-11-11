// ナンバーコード（数字当て）の純粋ロジック（UI 非依存・シード決定的）。
// 重複なしの3桁コード（0〜9、先頭の0も可）を当てる。
// EAT = 数字も位置も一致、BITE = 数字は含まれるが位置が違う。
// 10回以内に3つとも EAT させれば勝ち。

export const NC_CODE_LENGTH = 3;
export const NC_MAX_TRIES = 10;

export type NcStatus = "playing" | "won" | "lost";

export type NcGuess = {
  digits: number[];
  eat: number;
  bite: number;
};

export type NcState = {
  seed: number;
  /** 正解コード（長さ NC_CODE_LENGTH、重複なし）。 */
  code: number[];
  guesses: NcGuess[];
  status: NcStatus;
};

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

/** EAT / BITE を数える。コード側も推測側も重複なし前提だが、重複があっても数え方は一貫する。 */
export function judgeCode(code: number[], guess: number[]): { eat: number; bite: number } {
  let eat = 0;
  let bite = 0;
  const len = Math.min(code.length, guess.length);
  for (let i = 0; i < len; i++) {
    if (guess[i] === code[i]) eat += 1;
    else if (code.includes(guess[i])) bite += 1;
  }
  return { eat, bite };
}

/** 推測として妥当か（長さ3・各桁0〜9の整数・重複なし）。 */
export function isValidNcGuess(digits: unknown): digits is number[] {
  if (!Array.isArray(digits) || digits.length !== NC_CODE_LENGTH) return false;
  const seen = new Set<number>();
  for (const d of digits) {
    if (!Number.isInteger(d) || d < 0 || d > 9) return false;
    if (seen.has(d)) return false;
    seen.add(d);
  }
  return true;
}

export function createNumberCodeGame(seed: number): NcState {
  let rng = seed | 0;
  const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let i = digits.length - 1; i > 0; i--) {
    const nr = nextRandom(rng);
    rng = nr.rng;
    const j = Math.floor(nr.value * (i + 1));
    [digits[i], digits[j]] = [digits[j], digits[i]];
  }
  return {
    seed: seed | 0,
    code: digits.slice(0, NC_CODE_LENGTH),
    guesses: [],
    status: "playing",
  };
}

/** 推測を提出する。不正な推測・終了後は同状態を返す。 */
export function submitNcGuess(state: NcState, digits: number[]): NcState {
  if (state.status !== "playing") return state;
  if (!isValidNcGuess(digits)) return state;
  const { eat, bite } = judgeCode(state.code, digits);
  const guesses = [...state.guesses, { digits: [...digits], eat, bite }];
  const status: NcStatus = eat === NC_CODE_LENGTH ? "won" : guesses.length >= NC_MAX_TRIES ? "lost" : "playing";
  return { ...state, guesses, status };
}

export function ncRemainingTries(state: NcState): number {
  return Math.max(0, NC_MAX_TRIES - state.guesses.length);
}
