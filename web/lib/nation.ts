// 国づくりのデータ取得（サーバー専用。SUPABASE_KEY をクライアントに出さない）
import type { Guild, Tile } from "./nation-map";

export type NationData = { ok: true; tiles: Tile[]; guilds: Guild[] } | { ok: false; reason: "no-env" | "fetch-failed" };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: process.env.SUPABASE_KEY!, Authorization: `Bearer ${process.env.SUPABASE_KEY}` },
    next: { revalidate: 60 },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`supabase ${res.status}`);
  return (await res.json()) as T;
}

export async function loadNation(): Promise<NationData> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) return { ok: false, reason: "no-env" };
  try {
    const [tiles, guilds] = await Promise.all([
      get<Tile[]>("nation_tiles?select=x,y,owner_guild_id,owner_user_id,tile_type,hp,max_hp,connected&limit=10000"),
      get<Guild[]>("nation_guilds?select=guild_id,capital_x,capital_y,treasury_coins"),
    ]);
    return { ok: true, tiles, guilds };
  } catch {
    return { ok: false, reason: "fetch-failed" };
  }
}
