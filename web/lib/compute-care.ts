// 端末への配慮（負荷の度合い）の設定。
// ラベルは使用量そのものの表現にする（ひかえめ = 使用率が低い）。
// 参加者の端末を守るため、使用率100%の設定は用意しない。最速の設定でも
// 使用率は75%を目安とし、論理コアが2つ以上ある環境では常に
// 1コアぶん以上の余力を残す。
export type CareLevel = "light" | "medium" | "heavy";

export const CARE_LEVELS: { key: CareLevel; label: string; usagePercent: number }[] = [
  { key: "light", label: "ひかえめ", usagePercent: 25 },
  { key: "medium", label: "ふつう", usagePercent: 50 },
  { key: "heavy", label: "しっかり", usagePercent: 75 },
];

export type CareSettings = {
  /** 使用率の目安（%）。100 にはならない。 */
  usagePercent: number;
  /** CPU / WASM 方式で同時に使うワーカー数。 */
  workerCount: number;
  /** バッチの合間に入れる休止（ミリ秒）。 */
  restMs: number;
  /** WebGPU 方式で1回のディスパッチにまとめる部分局面数の目標。 */
  gpuTargetSubs: number;
  /** WebGPU 方式で1回に借りるタスク数。 */
  gpuBatch: number;
};

const TUNING: Record<CareLevel, { restMs: number; gpuTargetSubs: number; gpuBatch: number }> = {
  light: { restMs: 600, gpuTargetSubs: 4096, gpuBatch: 4 },
  medium: { restMs: 300, gpuTargetSubs: 16384, gpuBatch: 8 },
  heavy: { restMs: 150, gpuTargetSubs: 32768, gpuBatch: 8 },
};

/** 配慮レベルと端末の論理コア数から、実際の負荷設定を決める（純粋関数）。 */
export function careSettings(level: CareLevel, hardwareConcurrency: number): CareSettings {
  const meta = CARE_LEVELS.find((entry) => entry.key === level) ?? CARE_LEVELS[1];
  const cores = Math.max(1, Math.floor(hardwareConcurrency) || 1);
  let workerCount = Math.floor((cores * meta.usagePercent) / 100);
  // コアが2つ以上なら、最も速い設定でも最低1コアは空ける（100%にしない）
  if (cores > 1) workerCount = Math.min(workerCount, cores - 1);
  workerCount = Math.max(1, workerCount);
  return { usagePercent: meta.usagePercent, workerCount, ...TUNING[level] };
}
