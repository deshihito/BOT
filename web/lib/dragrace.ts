// ドラッグレースの純粋ロジック（UI 非依存・シード決定的）。
// 勝敗は2要素で決まる決定的モデル:
//  1) スタートライト（グリーン）への反応時間
//  2) 各ギアのシフトアップのタイミング誤差（最適点からのズレが加速ロスになる）
// 時刻の計測そのものは Client が行い、ここには「何 ms で押したか」だけが渡る。
// CPU の反応とシフト誤差はシードと難易度から決定的に生成する。
// 状態は JSON 化可能な値のみで構成する。

export type DragDifficulty = "easy" | "normal" | "hard";

export type DragPhase = "ready" | "waiting" | "running" | "fouled" | "finished";

export type DragWinner = "player" | "cpu" | "draw";

/** ギア数。シフト回数は GEAR_COUNT - 1 = 4回。 */
export const GEAR_COUNT = 5;
/** 各シフトの最適タイミング（発進からの経過 ms）。 */
export const OPTIMAL_SHIFT_MS = [1500, 2800, 4200, 5700];
/** 反応0・シフト完璧だった場合の走行時間（ms）。 */
export const IDEAL_RUN_MS = 7600;
/** この誤差以内ならペナルティなし（パーフェクト）。 */
export const PERFECT_WINDOW_MS = 40;
/** 最適点をこの ms 過ぎてもシフトしなければ自動で「遅れシフト」として記録する。 */
export const MAX_SHIFT_ERROR_MS = 600;
/** グリーンまでの待ち時間の範囲。 */
export const WAIT_MIN_MS = 1400;
export const WAIT_MAX_MS = 3400;

export type DragState = {
  phase: DragPhase;
  difficulty: DragDifficulty;
  seed: number;
  /** グリーンまでの待ち時間（ms）。 */
  waitMs: number;
  /** プレイヤーの反応時間（ms）。発進前は null。 */
  reactionMs: number | null;
  /** 各シフトの誤差（符号付き ms、最適点より早いと負）。未実施は null。 */
  shiftErrors: (number | null)[];
  shiftsDone: number;
  /** 最後にシフトした発進後経過（ms）。RPM メーターの基準。 */
  gearStartMs: number;
  /** プレイヤーの合計タイム（反応＋走行）。4回目のシフト確定で決まる。 */
  playerTotalMs: number | null;
  cpuReactionMs: number;
  cpuShiftErrors: number[];
  cpuTotalMs: number;
  winner: DragWinner | null;
};

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

/** シフト誤差（ms）に対するタイムペナルティ（ms）。 */
export function shiftPenaltyMs(errorMs: number): number {
  const a = Math.abs(errorMs);
  if (a <= PERFECT_WINDOW_MS) return 0;
  let p = (a - PERFECT_WINDOW_MS) * 0.55;
  if (a > 260) p += (a - 260) * 1.1; // 大きく外すと吹け上がり／失速でさらにロス
  return Math.round(p);
}

/** シフト誤差への評価区分。 */
export function shiftQuality(errorMs: number): "perfect" | "good" | "ok" | "bad" {
  const a = Math.abs(errorMs);
  if (a <= PERFECT_WINDOW_MS) return "perfect";
  if (a <= 130) return "good";
  if (a <= 320) return "ok";
  return "bad";
}

/** シフト誤差への評価ラベル（表示用）。 */
export function shiftQualityLabel(errorMs: number): string {
  const q = shiftQuality(errorMs);
  if (q === "perfect") return "パーフェクト!";
  if (q === "good") return "いいシフト";
  if (q === "ok") return "ふつうのシフト";
  return errorMs < 0 ? "早すぎた…" : "遅すぎた…";
}

const CPU_PROFILE: Record<
  DragDifficulty,
  { reaction: [number, number]; error: [number, number] }
> = {
  easy: { reaction: [400, 680], error: [140, 400] },
  normal: { reaction: [290, 500], error: [70, 240] },
  hard: { reaction: [195, 340], error: [25, 130] },
};

export function createDragRace(seed: number, difficulty: DragDifficulty): DragState {
  let rng = seed | 0;
  const draw = () => {
    const n = nextRandom(rng);
    rng = n.rng;
    return n.value;
  };
  const waitMs = Math.round(WAIT_MIN_MS + draw() * (WAIT_MAX_MS - WAIT_MIN_MS));
  const prof = CPU_PROFILE[difficulty] ?? CPU_PROFILE.normal;
  const cpuReactionMs = Math.round(
    prof.reaction[0] + draw() * (prof.reaction[1] - prof.reaction[0]),
  );
  const cpuShiftErrors: number[] = [];
  for (let i = 0; i < GEAR_COUNT - 1; i++) {
    const mag = prof.error[0] + draw() * (prof.error[1] - prof.error[0]);
    cpuShiftErrors.push(Math.round((draw() < 0.5 ? -1 : 1) * mag));
  }
  const cpuTotalMs =
    cpuReactionMs +
    IDEAL_RUN_MS +
    cpuShiftErrors.reduce((sum, e) => sum + shiftPenaltyMs(e), 0);
  return {
    phase: "ready",
    difficulty,
    seed: seed | 0,
    waitMs,
    reactionMs: null,
    shiftErrors: Array(GEAR_COUNT - 1).fill(null),
    shiftsDone: 0,
    gearStartMs: 0,
    playerTotalMs: null,
    cpuReactionMs,
    cpuShiftErrors,
    cpuTotalMs,
    winner: null,
  };
}

/** カウントダウン（ライト点灯待ち）を開始する。 */
export function beginCountdown(state: DragState): DragState {
  if (state.phase !== "ready") return state;
  return { ...state, phase: "waiting" };
}

/** グリーン前に押した（フライング）。失格になる。 */
export function foulStart(state: DragState): DragState {
  if (state.phase !== "waiting") return state;
  return { ...state, phase: "fouled", winner: "cpu" };
}

/**
 * グリーン後に押して発進する。reactionMs はグリーンからの経過 ms。
 * 不正な値（有限でない・負・5秒超）は無効として状態を変えない。
 */
export function launch(state: DragState, reactionMs: number): DragState {
  if (state.phase !== "waiting") return state;
  if (!Number.isFinite(reactionMs) || reactionMs < 0 || reactionMs > 5000) return state;
  return {
    ...state,
    phase: "running",
    reactionMs: Math.round(reactionMs),
    gearStartMs: 0,
  };
}

function totalFromErrors(reactionMs: number, errors: (number | null)[]): number {
  return (
    reactionMs +
    IDEAL_RUN_MS +
    errors.reduce<number>((sum, e) => sum + (e === null ? 0 : shiftPenaltyMs(e)), 0)
  );
}

/**
 * シフトアップする。raceElapsedMs は発進からの経過 ms。
 * 最適点との誤差を記録し、4回目でプレイヤーの合計タイムが確定する。
 */
export function shift(state: DragState, raceElapsedMs: number): DragState {
  if (state.phase !== "running") return state;
  if (state.shiftsDone >= GEAR_COUNT - 1) return state;
  if (!Number.isFinite(raceElapsedMs) || raceElapsedMs < 0) return state;
  const idx = state.shiftsDone;
  const error = Math.round(raceElapsedMs - OPTIMAL_SHIFT_MS[idx]);
  const shiftErrors = [...state.shiftErrors];
  shiftErrors[idx] = error;
  const shiftsDone = idx + 1;
  const playerTotalMs =
    shiftsDone >= GEAR_COUNT - 1 && state.reactionMs !== null
      ? totalFromErrors(state.reactionMs, shiftErrors)
      : state.playerTotalMs;
  return {
    ...state,
    shiftErrors,
    shiftsDone,
    gearStartMs: Math.round(raceElapsedMs),
    playerTotalMs,
  };
}

/**
 * 走行の時間経過に合わせて状態を進める（Client のタイマーが定期的に呼ぶ）。
 * 最適点を MAX_SHIFT_ERROR_MS 過ぎた未シフトは自動で遅れシフトとして記録し、
 * 両車の合計タイムを経過したら finished にして勝者を決める。
 */
export function advanceRace(state: DragState, raceElapsedMs: number): DragState {
  if (state.phase !== "running") return state;
  if (!Number.isFinite(raceElapsedMs) || raceElapsedMs < 0) return state;
  let s = state;
  while (
    s.shiftsDone < GEAR_COUNT - 1 &&
    raceElapsedMs > OPTIMAL_SHIFT_MS[s.shiftsDone] + MAX_SHIFT_ERROR_MS
  ) {
    s = shift(s, OPTIMAL_SHIFT_MS[s.shiftsDone] + MAX_SHIFT_ERROR_MS);
  }
  if (s.playerTotalMs === null || s.reactionMs === null) return s;
  const raceTotalElapsed = s.reactionMs + raceElapsedMs;
  const finishAt = Math.max(s.playerTotalMs, s.cpuTotalMs);
  if (raceTotalElapsed < finishAt) return s;
  const winner: DragWinner =
    s.playerTotalMs < s.cpuTotalMs
      ? "player"
      : s.playerTotalMs > s.cpuTotalMs
        ? "cpu"
        : "draw";
  return { ...s, phase: "finished", winner };
}

/**
 * 現在ギアの RPM メーター位置（0〜1）。
 * ギア開始から次の最適シフト点までを 0→1 とし、最適ゾーンは 0.85 以上。
 */
export function rpmFraction(state: DragState, raceElapsedMs: number): number {
  const start = state.shiftsDone === 0 ? 0 : state.gearStartMs;
  const end =
    state.shiftsDone < GEAR_COUNT - 1
      ? OPTIMAL_SHIFT_MS[state.shiftsDone]
      : IDEAL_RUN_MS;
  const span = Math.max(1, end - start);
  return Math.min(1, Math.max(0, (raceElapsedMs - start) / span));
}

/** 車の進行度（0〜1）。表示用に軽くイージングする決定的関数。 */
export function raceProgress(totalMs: number, elapsedMs: number): number {
  if (totalMs <= 0) return 0;
  const t = Math.min(1, Math.max(0, elapsedMs / totalMs));
  return Math.pow(t, 0.92);
}

/** プレイヤー車の進行度（反応時間の間は動かない）。 */
export function playerProgress(state: DragState, raceTotalElapsedMs: number): number {
  if (state.reactionMs === null) return 0;
  const total = state.playerTotalMs ?? totalFromErrors(state.reactionMs, state.shiftErrors);
  const runMs = Math.max(1, total - state.reactionMs);
  return raceProgress(runMs, raceTotalElapsedMs - state.reactionMs);
}

/** CPU 車の進行度。 */
export function cpuProgress(state: DragState, raceTotalElapsedMs: number): number {
  const runMs = Math.max(1, state.cpuTotalMs - state.cpuReactionMs);
  return raceProgress(runMs, raceTotalElapsedMs - state.cpuReactionMs);
}
