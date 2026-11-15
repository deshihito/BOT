// AGO WORLD BOX のプレイヤープロフィール保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_profiles"、キー = 所有者キー）。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import { DEFAULT_PROFILE, parseProfile, serializeProfile, type PlayerProfile } from "./profile";

export const WORLDBOX_PROFILE_NAMESPACE = "worldbox_profiles";

export function isProfileEnabled(): boolean {
  return isBotApiConfigured();
}

/** 新規プレイヤーのスポーン保護（分）。 */
export const SPAWN_PROTECT_MS = 5 * 60 * 1000;

/** 保存済みプロフィールを読む。無い・読めない場合は新規プレイヤーの既定値。 */
export async function loadProfile(ownerKey: string): Promise<PlayerProfile> {
  if (!isBotApiConfigured()) return { ...DEFAULT_PROFILE };
  try {
    const raw = await kvGet(WORLDBOX_PROFILE_NAMESPACE, ownerKey);
    if (raw === null || raw === undefined) {
      // 初回: スポーン保護を刻んで保存する（新規プレイヤーだけが対象）
      const fresh: PlayerProfile = {
        ...parseProfile(null),
        spawnProtectedUntil: Date.now() + SPAWN_PROTECT_MS,
      };
      await kvSet(WORLDBOX_PROFILE_NAMESPACE, ownerKey, serializeProfile(fresh));
      return fresh;
    }
    return parseProfile(raw);
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

/** プロフィールを保存する。成功したら true。 */
export async function storeProfile(ownerKey: string, profile: PlayerProfile): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_PROFILE_NAMESPACE, ownerKey, serializeProfile(profile));
    return true;
  } catch {
    return false;
  }
}
