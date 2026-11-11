// エイム（的あて）の純粋ロジック（UI 非依存・シード決定的）。
// 的の出現スケジュール/位置生成、ヒット判定、スコア計算をここに寄せる。
// 座標はプレイエリアに対する 0〜100 の正規化座標（%）で表す。

export const AIM_GAME_MS = 30_000;
/** 的の半径の範囲（正規化座標）。小さいほど高得点で、終盤ほど小さくなる。 */
export const AIM_MAX_RADIUS = 5.5;
export const AIM_MIN_RADIUS = 3.5;

export type AimTarget = {
  id: number;
  /** 中心座標（0〜100）。 */
  x: number;
  y: number;
  /** 半径（0〜100 座標系）。 */
  radius: number;
  /** ゲーム開始からの出現時刻（ms）。 */
  spawnAtMs: number;
  /** 出続けている時間（ms）。 */
  durationMs: number;
  /** 命中時の基本点。 */
  points: number;
};

/** mulberry32。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 経過時間に応じた的の出現間隔（ms）。終盤ほど短くなる。 */
export function aimSpawnIntervalMs(elapsedMs: number): number {
  const t = clamp01(elapsedMs / AIM_GAME_MS);
  return Math.round(950 - t * 400); // 950 -> 550
}

/** 経過時間に応じた的の出現継続時間（ms）。終盤ほど短くなる。 */
export function aimDurationMs(elapsedMs: number): number {
  const t = clamp01(elapsedMs / AIM_GAME_MS);
  return Math.round(1150 - t * 350); // 1150 -> 800
}

/** 経過時間に応じた的の半径。終盤ほど小さい。 */
export function aimRadiusAt(elapsedMs: number): number {
  const t = clamp01(elapsedMs / AIM_GAME_MS);
  return AIM_MAX_RADIUS + (AIM_MIN_RADIUS - AIM_MAX_RADIUS) * t;
}

/** 的の基本点。小さい的ほど高い。 */
export function pointsForRadius(radius: number): number {
  if (radius <= 3.75) return 30;
  if (radius <= 4.75) return 20;
  return 10;
}

/** スピードボーナス。出現直後に当てるほど上乗せされる（最大 +10）。 */
export function speedBonusFor(target: AimTarget, hitElapsedMs: number): number {
  if (!Number.isFinite(hitElapsedMs) || target.durationMs <= 0) return 0;
  const elapsed = Math.min(Math.max(0, hitElapsedMs - target.spawnAtMs), target.durationMs);
  const remainRatio = 1 - elapsed / target.durationMs;
  return Math.round(remainRatio * 10);
}

/** 命中時の合計得点（基本点 + スピードボーナス）。 */
export function pointsForHit(target: AimTarget, hitElapsedMs: number): number {
  return target.points + speedBonusFor(target, hitElapsedMs);
}

/** ヒット判定。タップ座標が的の円内にあるか。 */
export function hitTest(target: AimTarget, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const dx = x - target.x;
  const dy = y - target.y;
  return dx * dx + dy * dy <= target.radius * target.radius;
}

/** 命中率（0〜1）。試射が無ければ 0。 */
export function accuracyFor(hits: number, shots: number): number {
  if (!Number.isFinite(hits) || !Number.isFinite(shots) || shots <= 0) return 0;
  return Math.min(1, Math.max(0, hits / shots));
}

/**
 * 1ゲーム分（30秒）の的スケジュールをシードから決定的に生成する。
 * 的はエリア内に収まり、連続する的は位置が離れるようにする。
 */
export function createAimSchedule(seed: number, durationMs: number = AIM_GAME_MS): AimTarget[] {
  let rng = seed | 0;
  const schedule: AimTarget[] = [];
  let t = 500;
  let prev: { x: number; y: number } | null = null;
  let id = 0;
  while (t < durationMs) {
    const radius = aimRadiusAt(t);
    const draw = () => {
      const r = nextRandom(rng);
      rng = r.rng;
      return r.value;
    };
    let x = radius + draw() * (100 - radius * 2);
    let y = radius + draw() * (100 - radius * 2);
    if (prev) {
      const dx = x - prev.x;
      const dy = y - prev.y;
      if (dx * dx + dy * dy < 20 * 20) {
        // 前の的から離れた位置へ寄せる（決定的な補正）
        x = x < 50 ? Math.min(100 - radius, x + 30) : Math.max(radius, x - 30);
        y = y < 50 ? Math.min(100 - radius, y + 25) : Math.max(radius, y - 25);
      }
    }
    prev = { x, y };
    const dur = aimDurationMs(t);
    schedule.push({
      id: id++,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      radius: Math.round(radius * 100) / 100,
      spawnAtMs: t,
      durationMs: Math.min(dur, durationMs - t + 300),
      points: pointsForRadius(radius),
    });
    const gap = aimSpawnIntervalMs(t) * (0.8 + draw() * 0.4);
    t += Math.round(gap);
  }
  return schedule;
}

/** 指定時刻に表示されているはずの的（Client の描画用ヘルパー）。 */
export function activeTargetsAt(schedule: AimTarget[], elapsedMs: number, hitIds: ReadonlySet<number>): AimTarget[] {
  return schedule.filter(
    (t) => elapsedMs >= t.spawnAtMs && elapsedMs < t.spawnAtMs + t.durationMs && !hitIds.has(t.id),
  );
}
