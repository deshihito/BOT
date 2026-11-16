// モグラたたきの純粋ロジック（UI 非依存・シード決定的）。
// 出現スケジュールとスコア/コンボ計算をここに寄せる。

export type MoleKind = "normal" | "gold";

export type ScheduledMole = {
  /** 0〜8 の穴 index（3x3）。 */
  hole: number;
  kind: MoleKind;
  /** ゲーム開始からの出現時刻（ms）。 */
  spawnAtMs: number;
  /** 出てい続ける時間（ms）。 */
  durationMs: number;
};

export const MOLE_GAME_MS = 30_000;
export const MOLE_HOLES = 9;
export const MOLE_GOLD_RATE = 0.15;

/** mulberry32。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

/** モグラの基本点。 */
export function pointsForKind(kind: MoleKind): number {
  return kind === "gold" ? 30 : 10;
}

/**
 * コンボ込みの得点。コンボは連続ヒット数（このヒットを含まない直前までの数）。
 * 5コンボごとに倍率が上がる: x1 + floor(combo/5)*0.5 を基本点に掛け切り上げ。
 */
export function pointsWithCombo(kind: MoleKind, comboBefore: number): number {
  const base = pointsForKind(kind);
  const steps = Math.floor(Math.max(0, comboBefore) / 5);
  return Math.ceil(base * (1 + steps * 0.5));
}

/** 経過時間に応じた出現間隔（ms）。終盤ほど短くなる。 */
export function spawnIntervalMs(elapsedMs: number): number {
  const t = Math.min(1, Math.max(0, elapsedMs / MOLE_GAME_MS));
  return Math.round(900 - t * 350); // 900 -> 550
}

/** 経過時間に応じた出現継続時間（ms）。終盤ほど短くなる。 */
export function moleDurationMs(elapsedMs: number): number {
  const t = Math.min(1, Math.max(0, elapsedMs / MOLE_GAME_MS));
  return Math.round(1100 - t * 350); // 1100 -> 750
}

/** 乱数値からモグラ種別を決める。 */
export function decideMoleKind(rngValue: number): MoleKind {
  return rngValue < MOLE_GOLD_RATE ? "gold" : "normal";
}

/**
 * ヒット時のスコア遷移。新しい score / combo / gained を返す純粋関数。
 */
export function applyMoleHit(
  score: number,
  combo: number,
  kind: MoleKind,
): { score: number; combo: number; gained: number; maxCombo: number } {
  const gained = pointsWithCombo(kind, combo);
  const nextCombo = combo + 1;
  return { score: score + gained, combo: nextCombo, gained, maxCombo: nextCombo };
}

/** ミス（空振り・見逃し）時はコンボが 0 に戻る。 */
export function applyMoleMiss(score: number): { score: number; combo: number } {
  return { score, combo: 0 };
}

/**
 * 1ゲーム分（30秒）の出現スケジュールをシードから決定的に生成する。
 * 同時刻に同じ穴へ重ならないよう、直前と違う穴を優先する。
 */
export function createMoleSchedule(seed: number, durationMs: number = MOLE_GAME_MS): ScheduledMole[] {
  let rng = seed | 0;
  const schedule: ScheduledMole[] = [];
  let t = 400;
  let lastHole = -1;
  while (t < durationMs) {
    const rHole = nextRandom(rng);
    rng = rHole.rng;
    let hole = Math.floor(rHole.value * MOLE_HOLES);
    if (hole === lastHole) hole = (hole + 1 + Math.floor(rHole.value * (MOLE_HOLES - 1))) % MOLE_HOLES;
    lastHole = hole;
    const rKind = nextRandom(rng);
    rng = rKind.rng;
    const kind = decideMoleKind(rKind.value);
    const dur = moleDurationMs(t);
    schedule.push({ hole, kind, spawnAtMs: t, durationMs: Math.min(dur, durationMs - t + 400) });
    const rGap = nextRandom(rng);
    rng = rGap.rng;
    // 間隔に少しばらつきを持たせる（0.75〜1.15倍）
    t += Math.round(spawnIntervalMs(t) * (0.75 + rGap.value * 0.4));
  }
  return schedule;
}
