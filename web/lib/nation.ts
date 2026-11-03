// 国づくりのデータ取得（サーバー専用。BOT_API_KEYをクライアントへ出さない）
import type { Guild, Tile } from "./nation-map";

export type NationData = { ok: true; tiles: Tile[]; guilds: Guild[] } | { ok: false; reason: "no-env" | "fetch-failed" };

type QueryResponse<T> = { data: T[] };

async function select<T>(table: string, columns: string, limit?: number): Promise<T[]> {
  const baseUrl = process.env.BOT_API_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.BOT_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("database API environment is missing");

  const res = await fetch(`${baseUrl}/v1/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ table, action: "select", columns, ...(limit === undefined ? {} : { limit }) }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`database API returned ${res.status}`);
  const result = (await res.json()) as QueryResponse<T>;
  return Array.isArray(result.data) ? result.data : [];
}

export async function loadNation(): Promise<NationData> {
  if (!process.env.BOT_API_BASE_URL || !process.env.BOT_API_KEY) return { ok: false, reason: "no-env" };
  try {
    const [tiles, guilds] = await Promise.all([
      select<Tile>("nation_tiles", "x,y,owner_guild_id,owner_user_id,tile_type,hp,max_hp,connected", 10_000),
      select<Guild>("nation_guilds", "guild_id,capital_x,capital_y,treasury_coins"),
    ]);
    return { ok: true, tiles, guilds };
  } catch {
    return { ok: false, reason: "fetch-failed" };
  }
}
