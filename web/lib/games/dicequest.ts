// ダイスクエストの純粋ロジック（UI 非依存・シード決定的）。
// スコアシート式ソロダイス: 白ダイス2個＋色ダイス4個（各色1個）を振り、
// 4色の行のうち1マスだけをチェックして進める。
// 使える数字は「白2個の合計（どの行でも可）」か「白1個＋その色のダイスの合計
// （その色の行だけ）」。各行は進行方向（赤・黄は 2→12 の昇順、緑・青は
// 12→2 の降順）にしか進めず、チェック済みの数字より手前には戻れない。
// 行の最後の数字（昇順なら12、降順なら2）は、その行で5つ以上チェック
// 済みのときだけチェックでき、チェックするとその行は閉じる（以降使えない）。
// 振った目で何もチェックしない（できない）場合は「失敗」で、失敗が3回に
// なるとゲーム終了。スコアは行ごとに チェック数×(チェック数+1)/2 点、
// 失敗1回につき -5 点。
// 状態は JSON 化可能な値のみ。遷移関数は状態を破壊せず新しい状態を返す。

export type DqColor = "red" | "yellow" | "green" | "blue";

export type DqDirection = "asc" | "desc";

export const DQ_COLORS: DqColor[] = ["red", "yellow", "green", "blue"];

export const DQ_DIRECTIONS: Record<DqColor, DqDirection> = {
  red: "asc",
  yellow: "asc",
  green: "desc",
  blue: "desc",
};

export const DQ_COLOR_LABELS: Record<DqColor, string> = {
  red: "赤",
  yellow: "黄",
  green: "緑",
  blue: "青",
};

export const DQ_MAX_FAILURES = 3;
/** 行の最後の数字をチェックするために必要な、その行の既チェック数。 */
export const DQ_FINAL_MIN_CHECKS = 5;

export type DqDice = {
  white: [number, number];
  colored: Record<DqColor, number>;
};

export type DqCandidate = {
  color: DqColor;
  value: number;
  /** white=白2個の合計 / color=白1個＋色ダイスの合計。 */
  via: "white" | "color";
};

export type DqPhase = "roll" | "choice" | "finished";

export type DqState = {
  rng: number;
  dice: DqDice | null;
  /** 色ごとのチェック済み数字（チェックした順）。 */
  rows: Record<DqColor, number[]>;
  failures: number;
  rolls: number;
  checks: number;
  phase: DqPhase;
};

export type DqScore = {
  perRow: Record<DqColor, { count: number; points: number }>;
  penalty: number;
  total: number;
};

/** mulberry32（minesweeper 等と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function rollDie(rng: number): { value: number; rng: number } {
  const r = nextRandom(rng);
  return { value: Math.floor(r.value * 6) + 1, rng: r.rng };
}

/** 行に並ぶ数字（進行方向の順）。 */
export function dqRowNumbers(color: DqColor): number[] {
  const asc = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  return DQ_DIRECTIONS[color] === "asc" ? asc : [...asc].reverse();
}

/** 行の最後の数字（その行を閉じる数字）。 */
export function dqFinalNumber(color: DqColor): number {
  return DQ_DIRECTIONS[color] === "asc" ? 12 : 2;
}

/** 行が閉じているか（最後の数字をチェック済み）。 */
export function dqIsRowClosed(state: DqState, color: DqColor): boolean {
  return state.rows[color].includes(dqFinalNumber(color));
}

/**
 * その数字を今チェックできるか（ダイスの目は見ない。行のルールだけ）。
 * - 進行方向で、チェック済みのどの数字よりも先にあること（重複不可）
 * - 最後の数字は、その行で DQ_FINAL_MIN_CHECKS 個以上チェック済みのときだけ
 */
export function dqCanCheck(state: DqState, color: DqColor, value: number): boolean {
  if (state.phase === "finished") return false;
  const numbers = dqRowNumbers(color);
  const pos = numbers.indexOf(value);
  if (pos < 0) return false;
  const checked = state.rows[color];
  if (checked.includes(value)) return false;
  if (dqIsRowClosed(state, color)) return false;
  for (const v of checked) {
    if (numbers.indexOf(v) >= pos) return false; // 手前・同じ位置には戻れない
  }
  if (value === dqFinalNumber(color) && checked.length < DQ_FINAL_MIN_CHECKS) return false;
  return true;
}

/** 現在のダイスでチェックできる候補の一覧（choice フェーズのみ）。 */
export function dqCandidates(state: DqState): DqCandidate[] {
  if (state.phase !== "choice" || !state.dice) return [];
  const { white, colored } = state.dice;
  const out: DqCandidate[] = [];
  const seen = new Set<string>();
  const push = (color: DqColor, value: number, via: "white" | "color") => {
    const key = `${color}:${value}`;
    if (seen.has(key)) return;
    if (!dqCanCheck(state, color, value)) return;
    seen.add(key);
    out.push({ color, value, via });
  };
  const whiteSum = white[0] + white[1];
  for (const color of DQ_COLORS) push(color, whiteSum, "white");
  for (const color of DQ_COLORS) {
    push(color, white[0] + colored[color], "color");
    push(color, white[1] + colored[color], "color");
  }
  return out;
}

export function createDiceQuestGame(seed: number): DqState {
  return {
    rng: seed | 0,
    dice: null,
    rows: { red: [], yellow: [], green: [], blue: [] },
    failures: 0,
    rolls: 0,
    checks: 0,
    phase: "roll",
  };
}

/** ダイスを振る（roll フェーズのみ）。 */
export function rollDqDice(state: DqState): DqState {
  if (state.phase !== "roll") return state;
  let rng = state.rng;
  const take = () => {
    const r = rollDie(rng);
    rng = r.rng;
    return r.value;
  };
  const dice: DqDice = {
    white: [take(), take()],
    colored: { red: take(), yellow: take(), green: take(), blue: take() },
  };
  return { ...state, rng, dice, rolls: state.rolls + 1, phase: "choice" };
}

/** 候補を1つチェックする。候補に無い手は無効（同じ状態を返す）。 */
export function applyDqCheck(state: DqState, color: DqColor, value: number): DqState {
  const candidate = dqCandidates(state).find((c) => c.color === color && c.value === value);
  if (!candidate) return state;
  const rows = { ...state.rows, [color]: [...state.rows[color], value] };
  const next: DqState = { ...state, rows, checks: state.checks + 1 };
  const allClosed = DQ_COLORS.every((c) => dqIsRowClosed(next, c));
  return { ...next, phase: allClosed ? "finished" : "roll" };
}

/** チェックしない（できない）場合の失敗として数え、次へ進める。 */
export function applyDqPass(state: DqState): DqState {
  if (state.phase !== "choice") return state;
  const failures = state.failures + 1;
  return {
    ...state,
    failures,
    phase: failures >= DQ_MAX_FAILURES ? "finished" : "roll",
  };
}

/** スコア集計。行は チェック数×(チェック数+1)/2 点、失敗は1回 -5 点。 */
export function dqScore(state: DqState): DqScore {
  const perRow = {} as DqScore["perRow"];
  let sum = 0;
  for (const color of DQ_COLORS) {
    const count = state.rows[color].length;
    const points = (count * (count + 1)) / 2;
    perRow[color] = { count, points };
    sum += points;
  }
  const penalty = state.failures * 5;
  return { perRow, penalty, total: sum - penalty };
}
