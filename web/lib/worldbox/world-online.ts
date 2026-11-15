// AGO WORLD BOX の共有ワールド保存（サーバー専用、v3）。
// 保存先は既存の bot_kv 機構（lib/bot-api 経由）で、名前空間 "worldbox_world"、
// キーは単一の "shared"。値は { epoch, diffs } の JSON 文字列。
// 検証・整形は lib/worldbox/world-sync.ts の parseSharedWorld が担う。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import { emptySharedWorld, parseSharedWorld, serializeSharedWorld, type SharedWorldData } from "./world-sync";

export const WORLDBOX_WORLD_NAMESPACE = "worldbox_world";
export const SHARED_WORLD_KEY = "shared";

/** 共有ワールド JSON の上限（全タイル差分でも収まる大きさ）。 */
export const MAX_WORLD_JSON_LENGTH = 1_048_576;

export function isWorldOnlineEnabled(): boolean {
  return isBotApiConfigured();
}

/** 共有ワールドを読む。未保存・読めない場合は空の共有状態を返す。 */
export async function loadSharedWorld(): Promise<SharedWorldData> {
  if (!isBotApiConfigured()) return emptySharedWorld();
  try {
    const raw = await kvGet(WORLDBOX_WORLD_NAMESPACE, SHARED_WORLD_KEY);
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_WORLD_JSON_LENGTH) return emptySharedWorld();
    return parseSharedWorld(raw) ?? emptySharedWorld();
  } catch {
    return emptySharedWorld();
  }
}

/** 共有ワールドを保存する。成功したら true。 */
export async function storeSharedWorld(data: SharedWorldData): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    const json = serializeSharedWorld(data);
    if (json.length > MAX_WORLD_JSON_LENGTH) return false;
    await kvSet(WORLDBOX_WORLD_NAMESPACE, SHARED_WORLD_KEY, json);
    return true;
  } catch {
    return false;
  }
}
