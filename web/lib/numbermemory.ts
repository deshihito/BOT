// 数字記憶の純粋ロジック（UI 非依存・シード決定的）。
// 表示された数字を覚えて入力し、正解するたびに桁数が1つ増える。
// 数字の生成と判定を純粋関数で扱い、表示時間の管理は UI 側で行う。

export type NmState = {
  /** 現在の桁数。 */
  digits: number;
  /** 覚える対象の数字（文字列。先頭は 0 にならない）。 */
  number: string;
  /** このセッションで正解した最大桁数。 */
  bestDigits: number;
  /** 正解した回数（＝進んだラウンド数）。 */
  cleared: number;
  status: "playing" | "failed";
  rng: number;
};

export const NM_START_DIGITS = 3;

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function genNumber(rng: number, digits: number): { number: string; rng: number } {
  let r = rng;
  let out = "";
  for (let i = 0; i < digits; i++) {
    const n = nextRandom(r);
    r = n.rng;
    // 先頭は 1〜9、それ以外は 0〜9
    const d = i === 0 ? 1 + Math.floor(n.value * 9) : Math.floor(n.value * 10);
    out += String(d);
  }
  return { number: out, rng: r };
}

export function createNumberMemoryGame(
  seed: number,
  startDigits: number = NM_START_DIGITS,
): NmState {
  const digits = Math.max(1, Math.floor(startDigits));
  const { number, rng } = genNumber(seed | 0, digits);
  return {
    digits,
    number,
    bestDigits: 0,
    cleared: 0,
    status: "playing",
    rng,
  };
}

/** 入力検証: 数字だけの文字列かどうか（空は不可）。 */
export function isValidNumberInput(input: unknown): input is string {
  return typeof input === "string" && /^[0-9]+$/.test(input.trim());
}

/**
 * 回答を判定する。
 * 正解なら桁数+1 の次の数字を出し、不正解なら status が "failed" になる。
 */
export function submitNumberAnswer(
  state: NmState,
  input: unknown,
): { state: NmState; correct: boolean } {
  if (state.status !== "playing") return { state, correct: false };
  const correct = isValidNumberInput(input) && input.trim() === state.number;
  if (!correct) {
    return { state: { ...state, status: "failed" }, correct: false };
  }
  const digits = state.digits + 1;
  const { number, rng } = genNumber(state.rng, digits);
  return {
    state: {
      ...state,
      digits,
      number,
      bestDigits: Math.max(state.bestDigits, state.digits),
      cleared: state.cleared + 1,
      rng,
    },
    correct: true,
  };
}

/** その桁数を表示する時間（ミリ秒）。桁が増えるほど少し長くする。 */
export function showDurationMs(digits: number): number {
  return 1200 + digits * 450;
}
