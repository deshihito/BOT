// AGO WORLD BOX の国家データ保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_nations"）。国と所属は相互参照する
// （人数集計・解散時の所属一括削除）ため、独立したプレゼンスと違い
// "nations" / "members" の2キーを read-modify-write でまとめて扱う。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import {
  emptyBuildings, emptyNationsState, parseBuildings, parseNationsState,
  type BuildingsMap, type NationsState,
} from "./nations";

export const WORLDBOX_NATIONS_NAMESPACE = "worldbox_nations";
const NATIONS_KEY = "nations";
const MEMBERS_KEY = "members";
const BUILDINGS_KEY = "buildings";

export function isNationsEnabled(): boolean {
  return isBotApiConfigured();
}

/** 保存済みの国家状態を読む。無い・読めない・未設定なら空の状態。 */
export async function loadNationsState(): Promise<NationsState> {
  if (!isBotApiConfigured()) return emptyNationsState();
  try {
    const [nations, members] = await Promise.all([
      kvGet(WORLDBOX_NATIONS_NAMESPACE, NATIONS_KEY),
      kvGet(WORLDBOX_NATIONS_NAMESPACE, MEMBERS_KEY),
    ]);
    return parseNationsState(nations, members);
  } catch {
    return emptyNationsState();
  }
}

/** 国家状態を保存する。成功したら true。 */
export async function storeNationsState(state: NationsState): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_NATIONS_NAMESPACE, NATIONS_KEY, JSON.stringify(state.nations));
    await kvSet(WORLDBOX_NATIONS_NAMESPACE, MEMBERS_KEY, JSON.stringify(state.members));
    return true;
  } catch {
    return false;
  }
}

/** 保存済みの建物を読む。存在しない国の建物は落とす。無い・読めない・未設定なら空。 */
export async function loadBuildings(state: NationsState): Promise<BuildingsMap> {
  if (!isBotApiConfigured()) return emptyBuildings();
  try {
    const raw = await kvGet(WORLDBOX_NATIONS_NAMESPACE, BUILDINGS_KEY);
    return parseBuildings(raw, new Set(Object.keys(state.nations)));
  } catch {
    return emptyBuildings();
  }
}

/** 建物を保存する。成功したら true。 */
export async function storeBuildings(buildings: BuildingsMap): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_NATIONS_NAMESPACE, BUILDINGS_KEY, JSON.stringify(buildings));
    return true;
  } catch {
    return false;
  }
}
