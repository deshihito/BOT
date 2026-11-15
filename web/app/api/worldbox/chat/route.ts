import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import {
  CHAT_NAME_MAX, CHAT_RANGE_TILES, canPostChat, sanitizeChatText, selectAudibleMessages,
  type ChatMessage,
} from "@/lib/worldbox/chat";
import { appendChatMessage, isChatEnabled, loadChatLog } from "@/lib/worldbox/chat-online";
import { loadMyPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor, sanitizePresenceSpace } from "@/lib/worldbox/presence";

export const runtime = "nodejs";

// AGO WORLD BOX の近距離チャット。
// GET ?space=world|lobby: 自分のプレゼンス位置から CHAT_RANGE_TILES 以内の発言だけを
//   距離（distanceTiles）つきで返す（ログイン必須。範囲外の発言は返さない）。
// POST { space, text }: 発言する。位置はクライアント申告ではなくサーバー側の
//   プレゼンス（現在位置）が正。表示名はセッションの username が正。
// 保存先は bot_kv（名前空間 worldbox_chat、キー = 空間）。
// Bot API 未設定なら 503（クライアントはチャット無しで遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

export async function GET(request: Request) {
  if (!isChatEnabled()) {
    return NextResponse.json({ error: "chat_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  const ownerKey = sessionOwnerKey(session);
  const selfId = presenceIdFor(ownerKey);
  const space = sanitizePresenceSpace(new URL(request.url).searchParams.get("space"));
  const me = await loadMyPresence(ownerKey);
  // プレゼンスが無い（いない）空間では何も聞こえない
  if (!me || me.space !== space) {
    return NextResponse.json({ messages: [], range: CHAT_RANGE_TILES }, { headers: NO_STORE });
  }
  const log = await loadChatLog(space);
  const messages = selectAudibleMessages(log, me, Date.now()).map((m) => ({
    id: m.id,
    name: m.name,
    text: m.text,
    at: m.at,
    distanceTiles: m.distanceTiles,
    mine: m.from === selfId,
  }));
  return NextResponse.json({ messages, range: CHAT_RANGE_TILES }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isChatEnabled()) {
    return NextResponse.json({ error: "chat_unavailable" }, { status: 503, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const space = sanitizePresenceSpace((body as { space?: unknown } | null)?.space);
  const text = sanitizeChatText((body as { text?: unknown } | null)?.text);
  if (text === null) {
    return NextResponse.json({ error: "invalid_text" }, { status: 400, headers: NO_STORE });
  }
  const ownerKey = sessionOwnerKey(session);
  const selfId = presenceIdFor(ownerKey);
  const me = await loadMyPresence(ownerKey);
  if (!me || me.space !== space) {
    return NextResponse.json({ error: "no_presence" }, { status: 409, headers: NO_STORE });
  }
  const now = Date.now();
  const log = await loadChatLog(space);
  if (!canPostChat(log, selfId, now)) {
    return NextResponse.json({ error: "too_fast" }, { status: 429, headers: NO_STORE });
  }
  const name = (session.username?.trim() || "プレイヤー").slice(0, CHAT_NAME_MAX);
  const msg: ChatMessage = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    from: selfId,
    name,
    space,
    x: me.x,
    y: me.y,
    text,
    at: now,
  };
  const saved = await appendChatMessage(space, msg, now);
  if (!saved) {
    return NextResponse.json({ error: "chat_failed" }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json(
    { ok: true, message: { id: msg.id, name, text, at: now, distanceTiles: 0, mine: true } },
    { headers: NO_STORE },
  );
}
