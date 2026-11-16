// 反応速度（リアクション）の純粋ロジック（UI 非依存・シード決定的）。
// 待機時間スケジュール生成、フライング判定の状態遷移、結果の集計をここに寄せる。
// 状態は JSON 化可能な値のみで構成する。時刻の計測そのものは Client 側が行い、
// ここでは「待機中か合図済みか」「何 ms でタップされたか」だけを扱う。

export const REACTION_ROUNDS = 5;
export const REACTION_MIN_WAIT_MS = 2_000;
export const REACTION_MAX_WAIT_MS = 5_000;
/** 1プレイで使う待機時間の本数。フライングで同じラウンドをやり直す分も含む。 */
export const REACTION_WAITS_PER_SESSION = REACTION_ROUNDS * 4;

export type ReactionPhase = "idle" | "waiting" | "ready" | "tooSoon" | "done";

export type ReactionState = {
  phase: ReactionPhase;
  /** 完了したラウンド数（= results の長さ）。 */
  round: number;
  /** 全ラウンド数。 */
  rounds: number;
  /** 決定的に生成された待機時間リスト。 */
  waits: number[];
  /** 次に使う waits の index。 */
  waitIndex: number;
  /** 現在のラウンドで待機中の待機時間（ms）。waiting / ready のときだけ意味を持つ。 */
  currentWaitMs: number;
  /** 各ラウンドの反応時間（ms）。 */
  results: number[];
  /** フライング回数。 */
  fouls: number;
};

export type ReactionSummary = {
  count: number;
  averageMs: number;
  bestMs: number;
  worstMs: number;
};

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

/** 乱数値 0〜1 を待機時間（2000〜5000ms）に変換する。 */
export function waitMsFromRandom(value: number): number {
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  return Math.round(REACTION_MIN_WAIT_MS + v * (REACTION_MAX_WAIT_MS - REACTION_MIN_WAIT_MS));
}

/**
 * 1プレイ分の待機時間スケジュールをシードから決定的に生成する。
 * フライングのやり直しでも枯渇しないよう、ラウンド数の4倍を用意する。
 */
export function createWaitSchedule(seed: number, count: number = REACTION_WAITS_PER_SESSION): number[] {
  let rng = seed | 0;
  const waits: number[] = [];
  const n = Math.max(1, Math.floor(count) || 1);
  for (let i = 0; i < n; i++) {
    const r = nextRandom(rng);
    rng = r.rng;
    waits.push(waitMsFromRandom(r.value));
  }
  return waits;
}

/** セッションを開始する（phase は idle。startRound で待機に入る）。 */
export function createReactionSession(seed: number, rounds: number = REACTION_ROUNDS): ReactionState {
  const safeRounds = Math.min(20, Math.max(1, Math.floor(rounds) || REACTION_ROUNDS));
  return {
    phase: "idle",
    round: 0,
    rounds: safeRounds,
    waits: createWaitSchedule(seed, safeRounds * 4),
    waitIndex: 0,
    currentWaitMs: 0,
    results: [],
    fouls: 0,
  };
}

/**
 * ラウンドを開始して待機状態に入る。
 * idle（次のラウンド待ち）と tooSoon（フライングからのやり直し）からのみ有効。
 * 待機時間は waits から1本消費する。枯渇した場合は最後の1本を使い回す。
 */
export function startRound(state: ReactionState): ReactionState {
  if (state.phase !== "idle" && state.phase !== "tooSoon") return state;
  if (state.round >= state.rounds) return state;
  const idx = Math.min(state.waitIndex, state.waits.length - 1);
  const currentWaitMs = state.waits[idx] ?? REACTION_MIN_WAIT_MS;
  return {
    ...state,
    phase: "waiting",
    currentWaitMs,
    waitIndex: state.waitIndex + 1,
  };
}

/** 待機時間が経過して合図が出た状態にする（Client のタイマーが呼ぶ）。 */
export function signalReady(state: ReactionState): ReactionState {
  if (state.phase !== "waiting") return state;
  return { ...state, phase: "ready" };
}

/** 合図前にタップした（フライング）。ラウンドは進まず、やり直しになる。 */
export function tapTooEarly(state: ReactionState): ReactionState {
  if (state.phase !== "waiting") return state;
  return { ...state, phase: "tooSoon", currentWaitMs: 0, fouls: state.fouls + 1 };
}

/**
 * 合図後にタップした。反応時間（ms）を受け取り結果に記録する。
 * 不正な値（有限でない・負・60秒超）は無効として状態を変えない。
 * 最終ラウンドを記録すると phase は done になる。
 */
export function recordTap(state: ReactionState, reactionMs: number): ReactionState {
  if (state.phase !== "ready") return state;
  if (!Number.isFinite(reactionMs) || reactionMs < 0 || reactionMs > 60_000) return state;
  const results = [...state.results, Math.round(reactionMs)];
  const round = state.round + 1;
  return {
    ...state,
    results,
    round,
    currentWaitMs: 0,
    phase: round >= state.rounds ? "done" : "idle",
  };
}

/** 結果の平均・最速・最遅を集計する。結果が無ければすべて 0。 */
export function summarizeResults(results: number[]): ReactionSummary {
  const valid = results.filter((v) => Number.isFinite(v) && v >= 0);
  if (valid.length === 0) return { count: 0, averageMs: 0, bestMs: 0, worstMs: 0 };
  const sum = valid.reduce((a, b) => a + b, 0);
  return {
    count: valid.length,
    averageMs: Math.round(sum / valid.length),
    bestMs: Math.min(...valid),
    worstMs: Math.max(...valid),
  };
}

/** 平均反応時間への評価ラベル。 */
export function gradeForAverage(averageMs: number): string {
  if (!Number.isFinite(averageMs) || averageMs <= 0) return "未計測";
  if (averageMs <= 200) return "神速";
  if (averageMs <= 250) return "とても速い";
  if (averageMs <= 320) return "速い";
  if (averageMs <= 420) return "ふつう";
  return "ゆっくり";
}
