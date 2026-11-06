// ダッシュボードのサーバー側処理（セッションレコード、ギルド権限の再検証、設定の読み書き）
// アクセストークンは bot_kv の web_sessions 名前空間（Pi上のDB）だけに置き、クライアントへ出さない。
import crypto from "node:crypto";
import type { SessionInfo } from "./auth";
import { isBotApiConfigured, kvDelete, kvGet, kvList, kvSet } from "./bot-api";
import {
  manageableGuilds,
  mergeGuildSettings,
  type OAuthGuild,
} from "./dashboard-core";

export const GUILD_SETTINGS_NAMESPACE = "guild_settings";
export const GUILD_REGISTRY_NAMESPACE = "guild_registry";
export const WEB_SESSIONS_NAMESPACE = "web_sessions";

const SESSION_TTL_MS = 60 * 60 * 24 * 7 * 1000;
const GUILD_CACHE_MS = 30 * 1000;

type WebSessionRecord = {
  user_id: string;
  username: string;
  access_token: string;
  expires_at: number;
};

export async function createWebSession(
  user: { id: string; username: string },
  accessToken: string,
): Promise<string | null> {
  if (!isBotApiConfigured()) return null;
  const sid = crypto.randomBytes(32).toString("hex");
  const record: WebSessionRecord = {
    user_id: user.id,
    username: user.username,
    access_token: accessToken,
    expires_at: Date.now() + SESSION_TTL_MS,
  };
  try {
    await kvSet(WEB_SESSIONS_NAMESPACE, sid, record);
    return sid;
  } catch {
    return null;
  }
}

export async function loadWebSession(sid: string): Promise<WebSessionRecord | null> {
  let raw: unknown;
  try {
    raw = await kvGet(WEB_SESSIONS_NAMESPACE, sid);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Partial<WebSessionRecord>;
  if (
    typeof record.user_id !== "string" ||
    typeof record.access_token !== "string" ||
    typeof record.expires_at !== "number"
  ) {
    return null;
  }
  if (record.expires_at <= Date.now()) {
    void kvDelete(WEB_SESSIONS_NAMESPACE, sid).catch(() => undefined);
    return null;
  }
  return record as WebSessionRecord;
}

export async function deleteWebSession(sid: string): Promise<void> {
  try {
    await kvDelete(WEB_SESSIONS_NAMESPACE, sid);
  } catch {
    // ログアウト時の掃除はベストエフォート（失敗してもCookie側は消える）
  }
}

const guildCache = new Map<string, { at: number; guilds: OAuthGuild[] }>();

export async function fetchDiscordGuilds(accessToken: string): Promise<OAuthGuild[] | null> {
  try {
    const res = await fetch("https://discord.com/api/users/@me/guilds", {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return null;
    const guilds: OAuthGuild[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const guild = item as Record<string, unknown>;
      if (typeof guild.id !== "string" || typeof guild.name !== "string" || typeof guild.permissions !== "string") continue;
      guilds.push({
        id: guild.id,
        name: guild.name,
        icon: typeof guild.icon === "string" ? guild.icon : null,
        owner: guild.owner === true,
        permissions: guild.permissions,
      });
    }
    return guilds;
  } catch {
    return null;
  }
}

export type DashboardContext = {
  user: { id: string; username: string };
  /** ログイン中ユーザーが管理できるギルド（Discordから再取得した最新状態） */
  guilds: OAuthGuild[];
};

/** Cookieのセッションから、権限再検証済みのダッシュボード文脈を作る。失敗したら null。 */
export async function getDashboardContext(session: SessionInfo): Promise<DashboardContext | null> {
  if (!session.sid) return null;
  const record = await loadWebSession(session.sid);
  if (!record || record.user_id !== session.id) return null;

  const cached = guildCache.get(session.sid);
  if (cached && Date.now() - cached.at < GUILD_CACHE_MS) {
    return { user: { id: session.id, username: session.username }, guilds: cached.guilds };
  }
  const all = await fetchDiscordGuilds(record.access_token);
  if (!all) return null;
  const guilds = manageableGuilds(all);
  guildCache.set(session.sid, { at: Date.now(), guilds });
  return { user: { id: session.id, username: session.username }, guilds };
}

export type GuildRegistryEntry = {
  name: string;
  member_count: number;
};

export async function loadGuildRegistry(): Promise<Map<string, GuildRegistryEntry>> {
  const raw = await kvList(GUILD_REGISTRY_NAMESPACE);
  const registry = new Map<string, GuildRegistryEntry>();
  for (const [guildId, value] of raw) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    registry.set(guildId, {
      name: typeof entry.name === "string" ? entry.name : "",
      member_count: typeof entry.member_count === "number" ? entry.member_count : 0,
    });
  }
  return registry;
}

export async function loadGuildSettings(guildId: string): Promise<Record<string, unknown>> {
  const raw = await kvGet(GUILD_SETTINGS_NAMESPACE, guildId);
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

/** マージ済みのギルド設定全体を保存する（null なら行を消す）。 */
export async function saveGuildSettingsObject(
  guildId: string,
  merged: Record<string, unknown> | null,
): Promise<void> {
  if (merged === null) {
    await kvDelete(GUILD_SETTINGS_NAMESPACE, guildId);
  } else {
    await kvSet(GUILD_SETTINGS_NAMESPACE, guildId, merged);
  }
}

/** Bot の GuildSettings.update と同じ意味で1セクションを保存する。 */
export async function saveGuildSection(
  guildId: string,
  section: string,
  values: Record<string, unknown>,
): Promise<void> {
  const current = await loadGuildSettings(guildId);
  await saveGuildSettingsObject(guildId, mergeGuildSettings(current, section, values));
}
