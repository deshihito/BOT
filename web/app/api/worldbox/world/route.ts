import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin } from "@/lib/auth";
import { isWorldOnlineEnabled, loadSharedWorld, storeSharedWorld } from "@/lib/worldbox/world-online";
import { MAX_CHANGE_BATCH, mergeChanges, type TileChange } from "@/lib/worldbox/world-sync";

export const runtime = "nodejs";

// AGO WORLD BOX の共有ワールド（全員で1つの世界）。
// GET: { epoch, diffs }（誰でも読める。ゲストも共有世界で遊ぶ）
// PUT { changes: [{x, y, tile}] }: ログイン中のみ。タイル単位 LWW でマージし、
//   { epoch, rejected: [{x, y, tile, reason}] } を返す。
// 保存先は bot_kv（名前空間 worldbox_world、キー "shared"）。
// Bot API 未設定なら 503（クライアントはローカル世界で遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

export async function GET() {
  if (!isWorldOnlineEnabled()) {
    return NextResponse.json({ error: "world_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const data = await loadSharedWorld();
  return NextResponse.json({ epoch: data.epoch, diffs: data.diffs }, { headers: NO_STORE });
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isWorldOnlineEnabled()) {
    return NextResponse.json({ error: "world_unavailable" }, { status: 503, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const changes = (body as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes) || changes.length > MAX_CHANGE_BATCH) {
    return NextResponse.json({ error: "invalid_changes" }, { status: 400, headers: NO_STORE });
  }
  const current = await loadSharedWorld();
  const { data, rejected } = mergeChanges(current, changes as TileChange[]);
  if (data.epoch !== current.epoch) {
    const stored = await storeSharedWorld(data);
    if (!stored) {
      return NextResponse.json({ error: "world_save_failed" }, { status: 500, headers: NO_STORE });
    }
  }
  return NextResponse.json({ epoch: data.epoch, rejected }, { headers: NO_STORE });
}
