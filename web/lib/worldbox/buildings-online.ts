// AGO WORLD BOX の建物データ保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_nations" の "buildings" キー）。
// 建物は個人所有で国家データとは独立に読み書きするが、繁栄度の集計で
// 国家側からも参照するため、保存先の名前空間は国家と共有する。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import { emptyBuildings, parseBuildings, type BuildingsMap } from "./buildings";

export const WORLDBOX_BUILDINGS_NAMESPACE = "worldbox_nations";
const BUILDINGS_KEY = "buildings";

export function isBuildingsEnabled(): boolean {
  return isBotApiConfigured();
}

/** 保存済みの建物を読む。無い・読めない・未設定なら空。旧形式は読み込み時に移行される。 */
export async function loadBuildings(): Promise<BuildingsMap> {
  if (!isBotApiConfigured()) return emptyBuildings();
  try {
    const raw = await kvGet(WORLDBOX_BUILDINGS_NAMESPACE, BUILDINGS_KEY);
    return parseBuildings(raw);
  } catch {
    return emptyBuildings();
  }
}

/** 建物を保存する。成功したら true。 */
export async function storeBuildings(buildings: BuildingsMap): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_BUILDINGS_NAMESPACE, BUILDINGS_KEY, JSON.stringify(buildings));
    return true;
  } catch {
    return false;
  }
}
