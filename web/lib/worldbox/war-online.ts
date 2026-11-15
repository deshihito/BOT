// AGO WORLD BOX ユニオン戦争の保存（bot_kv）。
// 状態は1キー（worldbox_war / "state"）に持ち、検証・遷移は war.ts が担う。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import { parseWarState, pruneWars, type WarState } from "./war";

export const WORLDBOX_WAR_NAMESPACE = "worldbox_war";
const WAR_KEY = "state";

export function isWarEnabled(): boolean {
  return isBotApiConfigured();
}

export async function loadWarState(): Promise<WarState> {
  if (!isBotApiConfigured()) return parseWarState(null);
  try {
    const raw = await kvGet(WORLDBOX_WAR_NAMESPACE, WAR_KEY);
    return pruneWars(parseWarState(raw), Date.now());
  } catch {
    return parseWarState(null);
  }
}

export async function storeWarState(state: WarState): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_WAR_NAMESPACE, WAR_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
