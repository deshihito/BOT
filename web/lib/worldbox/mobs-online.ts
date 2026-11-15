// AGO WORLD BOX のモブ個体状態の保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_mobs"、キー = 個体キー "mobId@x,y"）。
// 状態があるのは「傷ついた/倒された」個体だけ（まばら）なので一覧読みで足りる。
import { isBotApiConfigured, kvDelete, kvGet, kvList, kvSet } from "../bot-api";
import { parseMobState, parseMobStates, type MobState } from "./combat";

export const WORLDBOX_MOBS_NAMESPACE = "worldbox_mobs";

export function isMobsEnabled(): boolean {
  return isBotApiConfigured();
}

/** 保存済みの個体状態をすべて読む。無い・読めない・未設定なら空。 */
export async function loadMobStates(): Promise<Record<string, MobState>> {
  if (!isBotApiConfigured()) return {};
  try {
    return parseMobStates(await kvList(WORLDBOX_MOBS_NAMESPACE));
  } catch {
    return {};
  }
}

/** 1個体の状態を読む。 */
export async function loadMobState(key: string): Promise<MobState | null> {
  if (!isBotApiConfigured()) return null;
  try {
    return parseMobState(await kvGet(WORLDBOX_MOBS_NAMESPACE, key));
  } catch {
    return null;
  }
}

/** 1個体の状態を保存する（null は削除）。成功したら true。 */
export async function storeMobState(key: string, state: MobState | null): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    if (state === null) await kvDelete(WORLDBOX_MOBS_NAMESPACE, key);
    else await kvSet(WORLDBOX_MOBS_NAMESPACE, key, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
