// AGO WORLD BOX のオンラインセーブ（サーバー専用）。
// 保存先は既存の bot_kv 機構（lib/bot-api 経由）で、名前空間 "worldbox_save"、
// キーはセッションの所有者キー（"discord:<user_id>" 等）。
// 値は v6 プレイヤーセーブ JSON 文字列そのもの。検証は lib/worldbox/save.ts の
// parseSave が担い、ここは文字列の出し入れだけを行う。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";

export const WORLDBOX_SAVE_NAMESPACE = "worldbox_save";

/** セーブ JSON の上限（タイル base64 + 予備。実測は約22KB）。 */
export const MAX_SAVE_JSON_LENGTH = 262_144;

export function isOnlineSaveEnabled(): boolean {
  return isBotApiConfigured();
}

/** 所有者キー → bot_kv のキー。所有者キー自体が "provider:id" 形式で一意。 */
export function worldboxSaveKey(ownerKey: string): string {
  return ownerKey;
}

/** 保存済みセーブ JSON を返す。無い・読めない・未設定なら null。 */
export async function loadWorldBoxSave(ownerKey: string): Promise<string | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const raw = await kvGet(WORLDBOX_SAVE_NAMESPACE, worldboxSaveKey(ownerKey));
    return typeof raw === "string" && raw.length > 0 && raw.length <= MAX_SAVE_JSON_LENGTH ? raw : null;
  } catch {
    return null;
  }
}

/** セーブ JSON を保存する。成功したら true。 */
export async function storeWorldBoxSave(ownerKey: string, saveJson: string): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  if (typeof saveJson !== "string" || saveJson.length === 0 || saveJson.length > MAX_SAVE_JSON_LENGTH) return false;
  try {
    await kvSet(WORLDBOX_SAVE_NAMESPACE, worldboxSaveKey(ownerKey), saveJson);
    return true;
  } catch {
    return false;
  }
}
