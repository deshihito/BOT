import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { rectBounds, worldBounds } from "@/lib/worldbox/mapgen";
import { LOBBY_H, LOBBY_W } from "@/lib/worldbox/lobby";
import { TENT_H, TENT_W } from "@/lib/worldbox/tent";
import { isPresenceEnabled, listPresence, putPresence, removePresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor, sanitizeHeartbeat, sanitizePresenceSpace, selectVisiblePlayers, thinPresenceNear } from "@/lib/worldbox/presence";

export const runtime = "nodejs";

// AGO WORLD BOX の同時接続プレゼンス。
// GET ?space=world|lobby|tent: { players }（誰でも読める。同じ空間の者だけ返す）
// PUT { name, x, y, vx, vy, face, space }: ハートビート（ログイン中のみ、約1秒間隔）
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
  const space = sanitizePresenceSpace(new URL(request.url).searchParams.get("space"));
  const entries = await listPresence();
  // ワールドでは近傍だけに間引く（スケール対策）。ロビー等の小空間は全員返す。
  // 間引きは「新しい順の上限」より先に効かせるため、ワールドでは上限を広げてから絞る。
  const self = space === "world" && selfId ? (entries.find((e) => e.id === selfId) ?? null) : null;
  let visible = selectVisiblePlayers(entries, selfId, Date.now(), self ? 4096 : undefined, space);
  if (self) visible = thinPresenceNear(visible, self);
  const players = visible.map((e) => ({
    id: e.id,
    name: e.name,
    x: e.x,
    y: e.y,
    vx: e.vx,
    vy: e.vy,
    face: e.face,
    space: e.space,
    role: e.role ?? "free",
    rank: e.rank ?? 1,
    party: e.party ?? "",
    ts: e.ts,
  }));
  // now はクライアント側の時計ずれ補正用（エントリ ts はサーバー時刻のため）
  return NextResponse.json({ players, now: Date.now() }, { headers: NO_STORE });
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
  const space = sanitizePresenceSpace((body as { space?: unknown } | null)?.space);
  // 洞窟（64×64）はインスタンス空間 ID で判定する（instances.ts の形式を複製）
  const isCave = /^cave:-?\d+,-?\d+:\d+$/.test(space);
  const isRuins = /^ruins:-?\d+,-?\d+:\d+$/.test(space);
  const isDungeon = /^dungeon:-?\d+,-?\d+:\d+$/.test(space);
  const bounds = space === "lobby" ? rectBounds(LOBBY_W, LOBBY_H) : space === "tent" ? rectBounds(TENT_W, TENT_H) : isCave ? rectBounds(64, 64) : isRuins ? rectBounds(48, 48) : isDungeon ? rectBounds(52, 52) : worldBounds();
  const heartbeat = sanitizeHeartbeat(body, bounds);
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
