import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { isChatEnabled, loadUnionChatSettings, storeUnionChatSettings } from "@/lib/worldbox/chat-online";
import { loadNationsState } from "@/lib/worldbox/nations-online";
import { memberKeysOf, resolveMemberRole } from "@/lib/worldbox/nation-settings";
import { loadNationSettings } from "@/lib/worldbox/nation-settings-online";

export const runtime = "nodejs";

// ユニオンの Discord チャンネル連携設定（掲示板↔Discord 連動）。
// GET: 自分のユニオンの設定（所属者のみ）
// POST { channelId }: 設定の保存。王/大臣のみ。空文字で連携解除。
// チャンネル ID は Discord のチャンネル ID（17〜20桁の数字）だけを受ける。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const CHANNEL_ID_RE = /^\d{17,20}$/;

function err(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isChatEnabled()) return err("chat_unavailable", 503);
  const ownerKey = sessionOwnerKey(session);
  const nations = await loadNationsState();
  const membership = nations.members[ownerKey];
  if (!membership) return err("no_union", 409);
  const nation = nations.nations[membership.nationId];
  const nationSettings = await loadNationSettings(membership.nationId);
  const resolved = nation
    ? resolveMemberRole(nation, nationSettings, ownerKey, membership.role, memberKeysOf(nations, membership.nationId))
    : null;
  const settings = await loadUnionChatSettings(membership.nationId);
  return NextResponse.json(
    { guildId: membership.nationId, role: resolved?.role ?? membership.role, chatChannelId: settings.chatChannelId },
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
  const channelId = (body as { channelId?: unknown } | null)?.channelId;
  if (typeof channelId !== "string" || (channelId !== "" && !CHANNEL_ID_RE.test(channelId))) {
    return err("invalid_channel_id", 400);
  }
  const ownerKey = sessionOwnerKey(session);
  const nations = await loadNationsState();
  const membership = nations.members[ownerKey];
  if (!membership) return err("no_union", 409);
  // 役職は国家設定込みで解決する（任命大臣も設定できる）
  const nation = nations.nations[membership.nationId];
  const settings = await loadNationSettings(membership.nationId);
  const resolved = nation
    ? resolveMemberRole(nation, settings, ownerKey, membership.role, memberKeysOf(nations, membership.nationId))
    : null;
  const role = resolved?.role ?? membership.role;
  if (role !== "king" && role !== "minister") {
    return err("forbidden_role", 403);
  }
  if (!(await storeUnionChatSettings(membership.nationId, { chatChannelId: channelId }))) {
    return err("store_failed", 503);
  }
  return NextResponse.json({ ok: true, chatChannelId: channelId }, { headers: NO_STORE });
}
