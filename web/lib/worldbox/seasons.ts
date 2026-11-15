// AGO WORLD BOX の季節（バッチ8a）。
// 現実の時刻から決定的に決まる4季節（各7日、28日周期）。サーバーと
// クライアントが同じ関数で同じ季節を見る。作物の育ちやすさ（適季）に
// だけ影響し、価格や確率をユーザーへは見せない（構造で返す）。

export type SeasonId = "spring" | "summer" | "autumn" | "winter";

export const SEASON_IDS: readonly SeasonId[] = ["spring", "summer", "autumn", "winter"];

export const SEASON_NAMES: Record<SeasonId, string> = {
  spring: "春",
  summer: "夏",
  autumn: "秋",
  winter: "冬",
};

export const SEASON_LENGTH_MS = 7 * 24 * 3600 * 1000;

export function seasonIndexOf(now: number): number {
  return Math.floor(now / SEASON_LENGTH_MS) % SEASON_IDS.length;
}

export function seasonOf(now: number): SeasonId {
  return SEASON_IDS[seasonIndexOf(now)];
}

export function isSeasonId(raw: unknown): raw is SeasonId {
  return typeof raw === "string" && (SEASON_IDS as readonly string[]).includes(raw);
}

/** その季節が終わるまでの日数（当日は 0）。 */
export function seasonDaysLeft(now: number): number {
  const elapsed = now % SEASON_LENGTH_MS;
  return Math.ceil((SEASON_LENGTH_MS - elapsed) / (24 * 3600 * 1000)) - 1;
}

/**
 * 作物の成長時間の倍率。適季は速く（×0.7）、反対の季節は遅い（×1.4）、
 * それ以外と適季指定なしは等倍。植えた瞬間の季節で決まる。
 */
export function seasonGrowthMult(cropSeason: SeasonId | null | undefined, now: number): number {
  if (!cropSeason) return 1;
  const cur = seasonIndexOf(now);
  const pref = SEASON_IDS.indexOf(cropSeason);
  if (pref < 0) return 1;
  const diff = (cur - pref + SEASON_IDS.length) % SEASON_IDS.length;
  if (diff === 0) return 0.7;
  if (diff === 2) return 1.4;
  return 1;
}
