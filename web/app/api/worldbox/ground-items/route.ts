import { NextResponse } from "next/server";
import { getRequestSession, sessionOwnerKey } from "@/lib/auth";
import { canPickupAt } from "@/lib/worldbox/ground-items";
import {
  addGroundItemDrop, isGroundItemsEnabled, isValidGroundSpace, loadGroundItems, loadMyPosition,
  takeGroundItemDrop,
} from "@/lib/worldbox/ground-items-online";
import { addItem } from "@/lib/worldbox/profile";
import { loadProfile, storeProfile } from "@/lib/worldbox/profile-online";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function errorJson(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

// AGO WORLD BOX の地面ドロップ。
// GET ?space=: その空間に落ちているアイテムの一覧（描画用）
// POST { action: "pickup", space, id }: 近くに落ちているアイテムを拾う
//   （本人の現在位置はサーバー側のプレゼンスで検証し、回収はロック内で
//    一人だけが成功する）。捨てるのは profile ルートの action "drop"。
export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return errorJson("unauthorized", 401);
  if (!isGroundItemsEnabled()) return errorJson("economy_unavailable", 503);
  const space = new URL(request.url).searchParams.get("space") ?? "";
  if (!isValidGroundSpace(space)) return errorJson("invalid_request", 400);
  const items = await loadGroundItems(space);
  return NextResponse.json({ space, items }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const session = getRequestSession(request);
  if (!session) return errorJson("unauthorized", 401);
  if (!isGroundItemsEnabled()) return errorJson("economy_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorJson("invalid_request", 400);
  }
  const data = (body ?? {}) as { action?: unknown; space?: unknown; id?: unknown };
  if (data.action !== "pickup") return errorJson("invalid_action", 400);
  if (!isValidGroundSpace(data.space) || typeof data.id !== "string") {
    return errorJson("invalid_request", 400);
  }
  const ownerKey = sessionOwnerKey(session);
  const position = await loadMyPosition(ownerKey);
  if (!position) return errorJson("position_unknown", 409);
  if (position.space !== data.space) return errorJson("wrong_space", 409);
  const items = await loadGroundItems(data.space);
  const target = items.find((i) => i.id === data.id) ?? null;
  if (!target) return errorJson("already_taken", 409);
  if (!canPickupAt(target, position.tx, position.ty)) return errorJson("too_far", 409);
  const taken = await takeGroundItemDrop(data.space, data.id);
  if (!taken) return errorJson("already_taken", 409);
  const current = await loadProfile(ownerKey);
  const next = addItem(current, taken.itemId, taken.count);
  if (!(await storeProfile(ownerKey, next))) {
    // 保存できなければ拾ったことにはせず、ドロップを元へ戻す
    await addGroundItemDrop(data.space, taken);
    return errorJson("store_failed", 503);
  }
  return NextResponse.json(
    { profile: next, picked: { itemId: taken.itemId, count: taken.count } },
    { headers: NO_STORE },
  );
}
