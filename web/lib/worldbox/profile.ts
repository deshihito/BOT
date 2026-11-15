// AGO WORLD BOX のプレイヤープロフィール（純粋ロジック）。
// 仕様書（Discord仮想国家経済MMO 基本仕様書）3.3 の個人データ:
// 所持金（coins）・空腹度（hunger, 0〜100）に、かばん（items）と
// steal のクールダウン時刻を加えたもの。
// 保存・通信は profile-online.ts / API ルート側が担い、ここは検証と
// かばん操作だけを行う。経済の状態遷移は economy.ts。
import { itemById } from "./items";

/** 空腹度の上限（仕様書 3.3: 0〜100）。 */
export const HUNGER_MAX = 100;
/** 新規プレイヤーの初期所持金。 */
export const STARTING_COINS = 100;

export type PlayerProfile = {
  coins: number;
  hunger: number;
  /** アイテムID → 所持数（0 のものは持たない）。 */
  items: Record<string, number>;
  /** 最後に steal を実行した時刻（epoch ms）。 */
  stealActorAt: number;
  /** 最後に steal された時刻（epoch ms）。 */
  stealTargetAt: number;
};

export const DEFAULT_PROFILE: PlayerProfile = {
  coins: STARTING_COINS,
  hunger: HUNGER_MAX,
  items: {},
  stealActorAt: 0,
  stealTargetAt: 0,
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function parseItems(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const items: Record<string, number> = {};
  for (const [id, count] of Object.entries(raw as Record<string, unknown>)) {
    if (!itemById(id)) continue; // 定義が無いアイテムは捨てる
    const n = clampInt(count, 0, 9999, 0);
    if (n > 0) items[id] = n;
  }
  return items;
}

/** 壊れたデータは既定値に落とす（範囲外はクランプ）。文字列でもオブジェクトでも受ける。 */
export function parseProfile(raw: unknown): PlayerProfile {
  let data: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ...DEFAULT_PROFILE, items: {} };
    }
  } else if (raw && typeof raw === "object") {
    data = raw as Record<string, unknown>;
  }
  if (!data) return { ...DEFAULT_PROFILE, items: {} };
  return {
    coins: clampInt(data.coins, 0, Number.MAX_SAFE_INTEGER, DEFAULT_PROFILE.coins),
    hunger: clampInt(data.hunger, 0, HUNGER_MAX, DEFAULT_PROFILE.hunger),
    items: parseItems(data.items),
    stealActorAt: clampInt(data.stealActorAt, 0, Number.MAX_SAFE_INTEGER, 0),
    stealTargetAt: clampInt(data.stealTargetAt, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

export function serializeProfile(profile: PlayerProfile): string {
  return JSON.stringify({
    coins: clampInt(profile.coins, 0, Number.MAX_SAFE_INTEGER, 0),
    hunger: clampInt(profile.hunger, 0, HUNGER_MAX, 0),
    items: parseItems(profile.items),
    stealActorAt: clampInt(profile.stealActorAt, 0, Number.MAX_SAFE_INTEGER, 0),
    stealTargetAt: clampInt(profile.stealTargetAt, 0, Number.MAX_SAFE_INTEGER, 0),
  });
}

// ---------------------------------------------------------------- かばん
export function countItem(profile: PlayerProfile, itemId: string): number {
  return profile.items[itemId] ?? 0;
}

export function addItem(profile: PlayerProfile, itemId: string, count: number): PlayerProfile {
  const items = { ...profile.items };
  const next = (items[itemId] ?? 0) + count;
  if (next > 0) items[itemId] = next;
  else delete items[itemId];
  return { ...profile, items };
}

/** 足りなければ null（何も変えない）。 */
export function removeItem(
  profile: PlayerProfile,
  itemId: string,
  count: number,
): PlayerProfile | null {
  if (countItem(profile, itemId) < count) return null;
  return addItem(profile, itemId, -count);
}
