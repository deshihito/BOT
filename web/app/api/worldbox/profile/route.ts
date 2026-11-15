import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import {
  buyItem, craftItem, doWork, eatItem, resolveSteal, sellItem, type EconomyError,
} from "@/lib/worldbox/economy";
import type { PlayerProfile } from "@/lib/worldbox/profile";
import { findPresenceOwnerKey, isPresenceEnabled } from "@/lib/worldbox/presence-online";
import { isProfileEnabled, loadProfile, storeProfile } from "@/lib/worldbox/profile-online";

export const runtime = "nodejs";

// AGO WORLD BOX の経済（プロフィール＋かばん＋ショップ＋合成＋steal＋労働）。
// Discord ボット側の経済機能（items / workshop craft / circulation steal）の
// 規則をワールドボックスに持ち込んだもの。すべてログイン必須。
// GET: 自分のプロフィール
// POST { action: "buy" | "sell", itemId, count? }: ショップ売買
// POST { action: "eat", itemId }: かばんの食事を食べて空腹度を回復
// POST { action: "craft", recipeId }: 合成
// POST { action: "work" }: 労働（空腹度を消費して所持金を得る）
// POST { action: "steal", targetId }: いま歩いている相手から steal
// 保存先は bot_kv（名前空間 worldbox_profiles、キー = 所有者キー）。
// Bot API 未設定なら 503。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

const BAD_REQUEST_ERRORS = new Set(["invalid_request", "invalid_action", "unknown_item", "unknown_recipe", "invalid_count", "self_target"]);

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function errorResponse(error: string) {
  const status = BAD_REQUEST_ERRORS.has(error) ? 400 : 409;
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isProfileEnabled()) {
    return NextResponse.json({ error: "profile_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const profile = await loadProfile(sessionOwnerKey(session));
  return NextResponse.json({ profile, loggedIn: true }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isProfileEnabled()) {
    return NextResponse.json({ error: "profile_unavailable" }, { status: 503, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const data = (body ?? {}) as {
    action?: unknown; itemId?: unknown; count?: unknown; recipeId?: unknown; targetId?: unknown;
  };
  const ownerKey = sessionOwnerKey(session);
  const current = await loadProfile(ownerKey);

  const saveAndReturn = async (
    result: { ok: true; profile: PlayerProfile } | { ok: false; error: EconomyError },
    extra: Record<string, unknown> = {},
  ) => {
    if (!result.ok) return errorResponse(result.error);
    if (!(await storeProfile(ownerKey, result.profile))) {
      return NextResponse.json({ error: "store_failed" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ profile: result.profile, ...extra }, { headers: NO_STORE });
  };

  switch (data.action) {
    case "buy":
      return saveAndReturn(buyItem(current, data.itemId, data.count));
    case "sell":
      return saveAndReturn(sellItem(current, data.itemId, data.count));
    case "eat": {
      const result = eatItem(current, data.itemId);
      return saveAndReturn(result, result.ok ? { itemName: result.item.name } : {});
    }
    case "craft": {
      const result = craftItem(current, data.recipeId);
      return saveAndReturn(result, result.ok
        ? { craftedId: result.recipe.output, rareId: result.rare?.id ?? null }
        : {});
    }
    case "work":
      return saveAndReturn(doWork(current));
    case "steal": {
      if (typeof data.targetId !== "string" || !isPresenceEnabled()) {
        return errorResponse("invalid_action");
      }
      const targetKey = await findPresenceOwnerKey(data.targetId);
      if (!targetKey) return errorResponse("target_protected");
      if (targetKey === ownerKey) return errorResponse("self_target");
      const target = await loadProfile(targetKey);
      const result = resolveSteal(current, target, Date.now());
      if (!result.ok) return errorResponse(result.error);
      if (!(await storeProfile(ownerKey, result.actor))) {
        return NextResponse.json({ error: "store_failed" }, { status: 503, headers: NO_STORE });
      }
      await storeProfile(targetKey, result.target);
      return NextResponse.json(
        { profile: result.actor, success: result.success, amount: result.amount },
        { headers: NO_STORE },
      );
    }
    default:
      return NextResponse.json({ error: "invalid_action" }, { status: 400, headers: NO_STORE });
  }
}
