// AGO WORLD BOX のギルドショップ状態の保存（bot_kv）。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import { parseGuildShopState, type GuildShopState } from "./guild-shop";

export const WORLDBOX_GUILD_SHOP_NAMESPACE = "worldbox_guild_shop";
const STATE_KEY = "state";

export function isGuildShopEnabled(): boolean {
  return isBotApiConfigured();
}

export async function loadGuildShopState(): Promise<GuildShopState> {
  if (!isBotApiConfigured()) return parseGuildShopState(null);
  try {
    return parseGuildShopState(await kvGet(WORLDBOX_GUILD_SHOP_NAMESPACE, STATE_KEY));
  } catch {
    return parseGuildShopState(null);
  }
}

export async function storeGuildShopState(state: GuildShopState): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_GUILD_SHOP_NAMESPACE, STATE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
