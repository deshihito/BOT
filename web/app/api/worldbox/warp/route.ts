import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { worldTileSource } from "@/lib/worldbox/mapgen";
import { isNationsEnabled, loadNationsState } from "@/lib/worldbox/nations-online";
import { porterDestination } from "@/lib/worldbox/warp";
import { isWarpEnabled, loadPorter } from "@/lib/worldbox/warp-online";
import { parseSave, serializeSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave, storeWorldBoxSave } from "@/lib/worldbox/save-online";
import { putPresence } from "@/lib/worldbox/presence-online";

export const runtime = "nodejs";

// AGO WORLD BOX のユニオンポーター利用。
// GET: 自分のユニオンのポーター位置（マップ表示用）。未所属・未設置は porter: null。
// POST { action: "teleport" }: 自ユニオンのポーターへ移動する。
//   所属の検証はサーバー側の国家状態が正（ポーターは自分の所属ギルドの
//   キーでしか引かないため、他ユニオンのポーターは原理的に使えない）。
//   ワールド空間にいるときだけ使える（ロビー・テント・インスタンス内は不可）。
//   移動はセーブとプレゼンスに反映し、応答の座標がクライアントの移動先になる。
// 設置は roles ルートのスキル分岐（テレポーターのダブルタップ）が担う。
// Bot API 未設定なら 503。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function err(error: string, status = 409) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isNationsEnabled() || !isWarpEnabled()) return err("warp_unavailable", 503);
  const ownerKey = sessionOwnerKey(session);
  const state = await loadNationsState();
  const mine = state.members[ownerKey];
  if (!mine || !state.nations[mine.nationId]) {
    return NextResponse.json({ porter: null, guildId: null }, { headers: NO_STORE });
  }
  const porter = await loadPorter(mine.nationId);
  return NextResponse.json(
    { porter: porter ? { x: porter.x, y: porter.y } : null, guildId: mine.nationId },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return err("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isNationsEnabled() || !isWarpEnabled()) return err("warp_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("invalid_request", 400);
  }
  if ((body as { action?: unknown } | null)?.action !== "teleport") {
    return err("invalid_request", 400);
  }
  const ownerKey = sessionOwnerKey(session);
  const state = await loadNationsState();
  const mine = state.members[ownerKey];
  if (!mine || !state.nations[mine.nationId]) return err("not_in_union", 409);
  const porter = await loadPorter(mine.nationId);
  if (!porter) return err("no_porter", 409);
  // ワールド空間にいるときだけ（ロビー・テント・インスタンス内からは不可）。
  // 現在空間の正はセーブ（ワープ・遷移のたびに更新される）。
  const prev = parseSave(await loadWorldBoxSave(ownerKey));
  if (prev && prev.space !== "world") return err("not_in_world", 409);
  const dest = porterDestination(worldTileSource(), porter);
  await storeWorldBoxSave(
    ownerKey,
    serializeSave({ space: "world", x: dest.x, y: dest.y, worldReturn: prev?.worldReturn ?? null }),
  );
  await putPresence(
    ownerKey,
    {
      name: session.username?.trim() || "プレイヤー",
      x: dest.x, y: dest.y, vx: 0, vy: 0, face: 1, space: "world",
    },
    Date.now(),
  );
  return NextResponse.json(
    { ok: true, x: dest.x, y: dest.y, guildId: mine.nationId },
    { headers: NO_STORE },
  );
}
