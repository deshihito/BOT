import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { worldTileSource } from "@/lib/worldbox/mapgen";
import { isNationsEnabled, loadNationsState } from "@/lib/worldbox/nations-online";
import { isProfileEnabled, loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { withUserLock } from "@/lib/worldbox/user-lock";
import {
  HOME_WARP_COMBAT_COOLDOWN_MS, HOME_WARP_COOLDOWN_MS, homeDestination, porterDestination,
} from "@/lib/worldbox/warp";
import { isWarpEnabled, loadPorter } from "@/lib/worldbox/warp-online";
import { parseSave, serializeSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave, storeWorldBoxSave } from "@/lib/worldbox/save-online";
import { putPresence } from "@/lib/worldbox/presence-online";

export const runtime = "nodejs";

// AGO WORLD BOX のユニオンポーター / 自宅（ベッド）ワープ利用。
// GET: 自分のユニオンのポーター位置（マップ表示用）。未所属・未設置は porter: null。
// POST { action: "teleport" }: 自ユニオンのポーターへ移動する。
// POST { action: "home" }: 自分がベッドで設定したリスポーン地点へ帰還する（被弾後15秒・再使用60秒制限つき）。
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
  const action = (body as { action?: unknown } | null)?.action;
  if (action !== "teleport" && action !== "home") {
    return err("invalid_request", 400);
  }
  const ownerKey = sessionOwnerKey(session);
  const prev = parseSave(await loadWorldBoxSave(ownerKey));
  // ワールド空間にいるときだけ（ロビー・テント・インスタンス内からは不可）。
  // 現在空間の正はセーブ（ワープ・遷移のたびに更新される）。
  if (prev && prev.space !== "world") return err("not_in_world", 409);

  if (action === "home") {
    if (!isProfileEnabled()) return err("warp_unavailable", 503);
    const now = Date.now();
    const outcome = await withUserLock(ownerKey, async () => {
      const profile = await loadProfile(ownerKey);
      if (!profile.respawn) return err("no_home", 409);
      if (now - profile.lastDamageAt < HOME_WARP_COMBAT_COOLDOWN_MS) {
        return err("combat_cooldown", 409);
      }
      if (now - (profile.homeWarpAt ?? 0) < HOME_WARP_COOLDOWN_MS) {
        return err("warp_cooldown", 409);
      }
      const dest = homeDestination(worldTileSource(), profile.respawn);
      const nextProfile = { ...profile, homeWarpAt: now };
      if (!(await storeProfile(ownerKey, nextProfile))) {
        return err("store_failed", 500);
      }
      return { dest, profile: nextProfile };
    });
    if (outcome instanceof NextResponse) return outcome;
    await storeWorldBoxSave(
      ownerKey,
      serializeSave(
        { space: "world", x: outcome.dest.x, y: outcome.dest.y, worldReturn: prev?.worldReturn ?? null },
        { tpAt: now },
      ),
    );
    await putPresence(
      ownerKey,
      {
        name: session.username?.trim() || "プレイヤー",
        x: outcome.dest.x, y: outcome.dest.y, vx: 0, vy: 0, face: 1, space: "world",
      },
      now,
      { tpTs: now },
    );
    return NextResponse.json(
      { ok: true, x: outcome.dest.x, y: outcome.dest.y, profile: outcome.profile },
      { headers: NO_STORE },
    );
  }

  const state = await loadNationsState();
  const mine = state.members[ownerKey];
  if (!mine || !state.nations[mine.nationId]) return err("not_in_union", 409);
  const porter = await loadPorter(mine.nationId);
  if (!porter) return err("no_porter", 409);
  const dest = porterDestination(worldTileSource(), porter);
  const now = Date.now();
  await storeWorldBoxSave(
    ownerKey,
    serializeSave({ space: "world", x: dest.x, y: dest.y, worldReturn: prev?.worldReturn ?? null }, { tpAt: now }),
  );
  await putPresence(
    ownerKey,
    {
      name: session.username?.trim() || "プレイヤー",
      x: dest.x, y: dest.y, vx: 0, vy: 0, face: 1, space: "world",
    },
    now,
    { tpTs: now },
  );
  return NextResponse.json(
    { ok: true, x: dest.x, y: dest.y, guildId: mine.nationId },
    { headers: NO_STORE },
  );
}
