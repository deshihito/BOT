// AGO WORLD BOX の Discord ギルド検証（サーバー専用 + 純粋ヘルパー）。
// 国 = Discord サーバーなので、建国・参加の可否と役職は、本人の参加ギルド
// 一覧（Discord API /users/@me/guilds）で都度検証する。
//
// アクセストークンの置き場は既存の仕組みをそのまま使う: OAuth スコープは
// 認可ルートが "identify guilds" を既に要求しており、コールバックが
// lib/dashboard の createWebSession で bot_kv "web_sessions" にトークンを
// 保存し、セッション Cookie にはその sid だけが入る。ここでは sid から
// loadWebSession でトークンを引き、fetchDiscordGuilds で一覧を取る。
// sid の無いセッション（トークン保存が始まる前のログイン、Bot API 未設定時の
// ログイン、Google ログイン）では一覧を引けないため guilds_scope_required
// を返し、クライアントは Discord 再ログインを促す。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import { fetchDiscordGuilds, loadWebSession } from "../dashboard";
import { sessionOwnerKey, type SessionInfo } from "../auth";
import type { OAuthGuild } from "../dashboard-core";
import type { MyGuildView, NationRole, NationsState } from "./nations";

/** ギルドキャッシュの保存先（bot_kv）。キーは所有者キー。 */
export const WORLDBOX_AUTH_NAMESPACE = "worldbox_auth";
/** ギルド一覧キャッシュの TTL（約5分）。 */
export const GUILD_CACHE_TTL_MS = 5 * 60 * 1000;

/** WORLD BOX が使うギルドの最小形（dashboard-core の OAuthGuild から抜粋）。 */
export type UserGuild = Pick<OAuthGuild, "id" | "name" | "owner" | "permissions">;

const ADMINISTRATOR_BIT = 1n << 3n; // 0x8

/**
 * Discord 権限から役職を導く: オーナー → 王、ADMINISTRATOR（bit 3）→ 大臣、
 * それ以外 → 国民。permissions は Discord が返す10進文字列を BigInt で読む。
 */
export function roleInGuild(guild: { owner: boolean; permissions: string }): NationRole {
  if (guild.owner) return "king";
  try {
    return (BigInt(guild.permissions) & ADMINISTRATOR_BIT) !== 0n ? "minister" : "citizen";
  } catch {
    return "citizen";
  }
}

/** 自分の参加ギルド一覧に、国の有無と自分の役職を注釈した表示用リスト。 */
export function annotateMyGuilds(guilds: UserGuild[], state: NationsState): MyGuildView[] {
  return guilds.map((g) => ({
    guildId: g.id,
    name: g.name,
    owner: g.owner,
    hasNation: Boolean(state.nations[g.id]),
    myRole: roleInGuild(g),
  }));
}

type GuildCache = { fetchedAt: number; guilds: UserGuild[] };

function asUserGuild(raw: unknown): UserGuild | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.name !== "string") return null;
  if (typeof v.permissions !== "string") return null;
  return { id: v.id, name: v.name, owner: v.owner === true, permissions: v.permissions };
}

/** キャッシュの保存値を検証し、TTL 内ならギルド一覧を返す。期限切れ・破損は null。 */
export function parseGuildCache(raw: unknown, now: number): UserGuild[] | null {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const v = data as Record<string, unknown>;
  if (typeof v.fetchedAt !== "number" || !Number.isFinite(v.fetchedAt)) return null;
  if (now - v.fetchedAt < 0 || now - v.fetchedAt >= GUILD_CACHE_TTL_MS) return null;
  if (!Array.isArray(v.guilds)) return null;
  const guilds: UserGuild[] = [];
  for (const item of v.guilds) {
    const guild = asUserGuild(item);
    if (!guild) return null;
    guilds.push(guild);
  }
  return guilds;
}

export type UserGuildsResult =
  | { ok: true; guilds: UserGuild[] }
  | { ok: false; error: "guilds_scope_required" | "guilds_unavailable" };

/**
 * セッション中ユーザーの参加ギルド一覧を返す（bot_kv に約5分キャッシュ）。
 * トークンを引けないセッションは guilds_scope_required（一覧の権限ではなく
 * 保存済みトークンの有無の問題なので、再ログインで解消する）。
 */
export async function getUserGuilds(session: SessionInfo): Promise<UserGuildsResult> {
  if (session.provider !== "discord" || !session.sid || !isBotApiConfigured()) {
    return { ok: false, error: "guilds_scope_required" };
  }
  const cacheKey = sessionOwnerKey(session);
  try {
    const cached = parseGuildCache(await kvGet(WORLDBOX_AUTH_NAMESPACE, cacheKey), Date.now());
    if (cached) return { ok: true, guilds: cached };
  } catch {
    // キャッシュが読めなくても本体の取得は続ける
  }
  const record = await loadWebSession(session.sid);
  if (!record || record.user_id !== session.id) {
    return { ok: false, error: "guilds_scope_required" };
  }
  const fetched = await fetchDiscordGuilds(record.access_token);
  if (!fetched) return { ok: false, error: "guilds_unavailable" };
  const guilds: UserGuild[] = fetched.map((g) => ({
    id: g.id, name: g.name, owner: g.owner, permissions: g.permissions,
  }));
  const cache: GuildCache = { fetchedAt: Date.now(), guilds };
  try {
    await kvSet(WORLDBOX_AUTH_NAMESPACE, cacheKey, JSON.stringify(cache));
  } catch {
    // キャッシュ保存の失敗は致命的ではない（次回また取得する）
  }
  return { ok: true, guilds };
}
