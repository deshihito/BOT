import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import type { UnionChatMode } from "@/lib/worldbox/chat";
import { isChatEnabled, loadUnionChatSettings, storeUnionChatSettings } from "@/lib/worldbox/chat-online";
import { loadDiscordDirectory } from "@/lib/worldbox/discord-directory-online";
import { loadNationsState } from "@/lib/worldbox/nations-online";
import { memberKeysOf, resolveMemberRole } from "@/lib/worldbox/nation-settings";
import { loadNationSettings } from "@/lib/worldbox/nation-settings-online";

export const runtime = "nodejs";

// ユニオンの Discord 連携設定（掲示板↔Discord 連動）。
// GET: 自分のユニオンの設定 + Bot が公開したチャンネルディレクトリ（所属者のみ）
// POST { mode, channelId }: 設定の保存。王/大臣のみ。
// チャンネルは ID 手入力ではなく、Bot が bot_kv `worldbox_discord_directory`
// に公開したチャンネル名一覧から選ぶ（mode: "global" | "channel" | "none"）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function err(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

async function myRole(ownerKey: string) {
  const nations = await loadNationsState();
  const membership = nations.members[ownerKey];
  if (!membership) return null;
  const nation = nations.nations[membership.nationId];
  const nationSettings = await loadNationSettings(membership.nationId);
  const resolved = nation
    ? resolveMemberRole(nation, nationSettings, ownerKey, membership.role, memberKeysOf(nations, membership.nationId))
    : null;
  return { guildId: membership.nationId, role: resolved?.role ?? membership.role };
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isChatEnabled()) return err("chat_unavailable", 503);
  const me = await myRole(sessionOwnerKey(session));
  if (!me) return err("no_union", 409);
  const [settings, directory] = await Promise.all([
    loadUnionChatSettings(me.guildId),
    loadDiscordDirectory(me.guildId),
  ]);
  return NextResponse.json(
    {
      guildId: me.guildId,
      role: me.role,
      canEdit: me.role === "king" || me.role === "minister",
      settings: { mode: settings.mode, channelId: settings.channelId },
      directory: directory
        ? { channels: directory.channels, globalChatChannelId: directory.globalChatChannelId }
        : null,
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return err("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isChatEnabled()) return err("chat_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("invalid_request", 400);
  }
  const mode = (body as { mode?: unknown } | null)?.mode;
  const channelIdRaw = (body as { channelId?: unknown } | null)?.channelId;
  if (mode !== "global" && mode !== "channel" && mode !== "none") {
    return err("invalid_mode", 400);
  }
  const me = await myRole(sessionOwnerKey(session));
  if (!me) return err("no_union", 409);
  if (me.role !== "king" && me.role !== "minister") {
    return err("forbidden_role", 403);
  }
  const m = mode as UnionChatMode;
  let channelId: string | null = null;
  if (m !== "none") {
    const directory = await loadDiscordDirectory(me.guildId);
    if (!directory) return err("directory_unavailable", 409);
    if (m === "global") {
      if (!directory.globalChatChannelId) return err("global_not_available", 400);
    } else {
      // 専用チャンネルはディレクトリに載っているものだけを受け付ける
      if (typeof channelIdRaw !== "string" || !directory.channels.some((c) => c.id === channelIdRaw)) {
        return err("channel_not_listed", 400);
      }
      channelId = channelIdRaw;
    }
  }
  if (!(await storeUnionChatSettings(me.guildId, { mode: m, channelId }))) {
    return err("store_failed", 503);
  }
  return NextResponse.json({ ok: true, settings: { mode: m, channelId } }, { headers: NO_STORE });
}
