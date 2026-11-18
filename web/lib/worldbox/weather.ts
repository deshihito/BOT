// AGO WORLD BOX の天候ゲーム連動ロジック（純粋ロジック・軽量）。
// 時刻決定の式は fx.ts の weatherAt / WEATHER_PERIOD_SEC と同一に保ち、
// サーバー側（農業・自動収穫・釣り）でも Canvas/FX を読み込まずに使えるようにする。

export type WeatherKind = "clear" | "rain";

/** 天候1区間の長さ（秒）。fx.ts の WEATHER_PERIOD_SEC と一致。 */
export const WEATHER_PERIOD_SEC = 360;

/** 雨天の名称マップ（UI 表示用）。 */
export const WEATHER_NAMES: Record<WeatherKind, string> = {
  clear: "晴れ",
  rain: "雨",
};

/** 雨天時の作物成長時間倍率（0.75 = 自然灌漑で 25% 短縮）。 */
export const RAIN_CROP_GROWTH_MULT = 0.75;

/** 雨天時の釣り追加ドロップ抽選確率（25%）。 */
export const RAIN_FISHING_BONUS_CHANCE = 0.25;

/**
 * unix 時刻（秒）からその区間の天候を決める（決定的、fx.ts と完全一致）。
 */
export function weatherAt(unixSec: number): WeatherKind {
  const idx = Math.floor(unixSec / WEATHER_PERIOD_SEC);
  let h = idx | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296 < 0.35 ? "rain" : "clear";
}

/** 天候による作物成長時間の倍率（雨なら 0.75、晴れなら 1）。 */
export function weatherGrowthMult(unixSec: number): number {
  return weatherAt(unixSec) === "rain" ? RAIN_CROP_GROWTH_MULT : 1;
}

/**
 * 雨天時の釣りボーナス抽選（純粋関数）。
 * 雨かつ 25% で当たり、raw_fish（85%）または pearl（15%）を 1 個追加する。
 */
export function rollRainFishingBonus(
  weather: WeatherKind,
  rand: () => number = Math.random,
): Record<string, number> {
  if (weather !== "rain") return {};
  if (rand() >= RAIN_FISHING_BONUS_CHANCE) return {};
  return rand() < 0.15 ? { pearl: 1 } : { raw_fish: 1 };
}
