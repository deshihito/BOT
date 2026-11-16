// AGO WORLD BOX のユニオンポーターの保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_warp"、キー = ギルド ID）。
// ユニオンに1つだけ: 置き直しは同じキーへの上書き（= 移動）になる。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import { parsePorter, type UnionPorter } from "./warp";

export const WORLDBOX_WARP_NAMESPACE = "worldbox_warp";

export function isWarpEnabled(): boolean {
  return isBotApiConfigured();
}

/** そのユニオンのポーターを読む。無ければ null。 */
export async function loadPorter(guildId: string): Promise<UnionPorter | null> {
  if (!isBotApiConfigured()) return null;
  try {
    return parsePorter(await kvGet(WORLDBOX_WARP_NAMESPACE, guildId));
  } catch {
    return null;
  }
}

/** そのユニオンのポーターを保存する（既存は上書き = 移動）。成功したら true。 */
export async function storePorter(guildId: string, porter: UnionPorter): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_WARP_NAMESPACE, guildId, JSON.stringify(porter));
    return true;
  } catch {
    return false;
  }
}
