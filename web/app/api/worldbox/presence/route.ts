import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionAvatarUrl, sessionOwnerKey } from "@/lib/auth";
import { rectBounds, worldBounds } from "@/lib/worldbox/mapgen";
import { LOBBY_H, LOBBY_W } from "@/lib/worldbox/lobby";
import { LOBBY2_H, LOBBY2_W, LOBBY3_H, LOBBY3_W } from "@/lib/worldbox/lobby-floors";
import { TENT_MAX_H, TENT_MAX_W } from "@/lib/worldbox/tent";
import { isPresenceEnabled, listPresence, loadStoredPresence, putPresenceTabGuarded, removePresence } from "@/lib/worldbox/presence-online";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import { recordFirstStep, recordPresenceMetric } from "@/lib/worldbox/metrics-online";
import { checkMovementContinuity, checkSaveFallbackContinuity, presenceIdFor, sanitizeHeartbeat, sanitizePresenceSpace, selectVisiblePlayers, thinPresenceNear } from "@/lib/worldbox/presence";

export const runtime = "nodejs";

// AGO WORLD BOX の同時接続プレゼンス。
// GET ?space=world|lobby|lobby2|lobby3|tent: { players }（誰でも読める。同じ空間の者だけ返す）
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
    ...(e.sit === true ? { sit: true } : {}),
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
  const bounds = space === "lobby" ? rectBounds(LOBBY_W, LOBBY_H) : space === "lobby2" ? rectBounds(LOBBY2_W, LOBBY2_H) : space === "lobby3" ? rectBounds(LOBBY3_W, LOBBY3_H) : space === "tent" ? rectBounds(TENT_MAX_W, TENT_MAX_H) : isCave ? rectBounds(64, 64) : isRuins ? rectBounds(48, 48) : isDungeon ? rectBounds(52, 52) : worldBounds();
  const heartbeat = sanitizeHeartbeat(body, bounds);
  if (!heartbeat) {
    return NextResponse.json({ error: "invalid_heartbeat" }, { status: 400, headers: NO_STORE });
  }
  const name = session.username?.trim() || heartbeat.name || "プレイヤー";
  // アバター（ユーザーアイコン）はクライアント申告を受けず、セッションから付与する
  const avatar = sessionAvatarUrl(session);
  const ownerKey = sessionOwnerKey(session);
  const now = Date.now();
  // 移動連続性（B4）: 申告位置が保管位置から移動可能な距離を超えていたら
  // 却下する（station ゲートのスクリプト突破を防ぐ）。基準は保存済み
  // プレゼンス（時刻基準）、無ければサーバー保存のセーブ（固定距離）。
  // 却下されたハートビートは保存せず、保管位置は最後の正規位置のまま。
  // 応答に保管位置を載せるので、クライアントはそこへ戻れる。
  const prev = await loadStoredPresence(ownerKey);
  if (prev) {
    if (!checkMovementContinuity(prev, heartbeat, now).ok) {
      return NextResponse.json(
        { error: "position_jump", x: prev.x, y: prev.y, space: prev.space },
        { status: 409, headers: NO_STORE },
      );
    }
  } else {
    const saved = parseSave(await loadWorldBoxSave(ownerKey));
    if (saved && !checkSaveFallbackContinuity(saved, heartbeat).ok) {
      return NextResponse.json(
        { error: "position_jump", x: saved.x, y: saved.y, space: saved.space },
        { status: 409, headers: NO_STORE },
      );
    }
  }
  // タブ世代（分身防止）: 新しい世代のタブだけが保存できる。旧タブは 409。
  const stored = await putPresenceTabGuarded(ownerKey, { ...heartbeat, name, ...(avatar ? { avatar } : {}) }, now);
  if (stored === "rejected") {
    return NextResponse.json({ error: "tab_superseded" }, { status: 409, headers: NO_STORE });
  }
  if (stored !== "stored") {
    return NextResponse.json({ error: "presence_failed" }, { status: 500, headers: NO_STORE });
  }
  // 計測（ベストエフォート）: DAU・同時接続ピーク・初回ステップ
  const fresh = (await listPresence()).filter((e) => now - e.ts <= 15_000).length;
  void recordPresenceMetric(ownerKey, fresh, now);
  if (space === "lobby" || space === "lobby2" || space === "lobby3") {
    void recordFirstStep(ownerKey, "lobby", now);
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
