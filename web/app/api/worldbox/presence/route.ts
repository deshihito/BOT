import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { MAP_H, MAP_W } from "@/lib/worldbox/mapgen";
import { isPresenceEnabled, listPresence, putPresence, removePresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor, sanitizeHeartbeat, selectVisiblePlayers } from "@/lib/worldbox/presence";

export const runtime = "nodejs";

// AGO WORLD BOX の同時接続プレゼンス。
// GET: { players }（誰でも読める。ゲストも他プレイヤーが見える）
// PUT { name, x, y, vx, vy, face }: ハートビート（ログイン中のみ、約1秒間隔）
// DELETE: 退室（自分のキーを消す）
// 保存先は bot_kv（名前空間 worldbox_presence、キー = 所有者キー）。
// 表示名はセッションの username を正とし、body の name は予備。
// Bot API 未設定なら 503（クライアントは一人で遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

export async function GET(request: Request) {
  if (!isPresenceEnabled()) {
    return NextResponse.json({ error: "presence_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  const selfId = session ? presenceIdFor(sessionOwnerKey(session)) : null;
  const entries = await listPresence();
  const players = selectVisiblePlayers(entries, selfId, Date.now()).map((e) => ({
    id: e.id,
    name: e.name,
    x: e.x,
    y: e.y,
    vx: e.vx,
    vy: e.vy,
    face: e.face,
    ts: e.ts,
  }));
  return NextResponse.json({ players }, { headers: NO_STORE });
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isPresenceEnabled()) {
    return NextResponse.json({ error: "presence_unavailable" }, { status: 503, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const heartbeat = sanitizeHeartbeat(body, { width: MAP_W, height: MAP_H });
  if (!heartbeat) {
    return NextResponse.json({ error: "invalid_heartbeat" }, { status: 400, headers: NO_STORE });
  }
  const name = session.username?.trim() || heartbeat.name || "プレイヤー";
  const stored = await putPresence(sessionOwnerKey(session), { ...heartbeat, name }, Date.now());
  if (!stored) {
    return NextResponse.json({ error: "presence_failed" }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  await removePresence(sessionOwnerKey(session));
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
