// AGO WORLD BOX の屋台（個人商店）の保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_stalls"）。キーはワールドの
// タイル座標（"x,y"）。屋台はワールド空間にだけ設置される前提。
import { isBotApiConfigured, kvDelete, kvGet, kvSet } from "../bot-api";
import { parseStall, serializeStall, type StallState } from "./stalls";
import { tileKey } from "./tiles";

export const WORLDBOX_STALLS_NAMESPACE = "worldbox_stalls";

export function isStallsEnabled(): boolean {
  return isBotApiConfigured();
}

/** 1タイルの出品を読む。無い・読めない・未設定なら null。 */
export async function loadStall(x: number, y: number): Promise<StallState | null> {
  if (!isBotApiConfigured()) return null;
  try {
    return parseStall(await kvGet(WORLDBOX_STALLS_NAMESPACE, tileKey(x, y)));
  } catch {
    return null;
  }
}

/** 1タイルの出品を保存する（null は削除）。成功したら true。 */
export async function storeStall(x: number, y: number, state: StallState | null): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    if (state === null) {
      await kvDelete(WORLDBOX_STALLS_NAMESPACE, tileKey(x, y));
    } else {
      await kvSet(WORLDBOX_STALLS_NAMESPACE, tileKey(x, y), serializeStall(state));
    }
    return true;
  } catch {
    return false;
  }
}
