import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { MAP_SEED, WORLD_COORD_LIMIT } from "@/lib/worldbox/mapgen";
import { fishingNonce, fishingReady, fishingSpotAt } from "@/lib/worldbox/fishing";
import { isFishingEnabled, loadCaughtAt, storeCaughtAt } from "@/lib/worldbox/fishing-online";
import { lootForObjectAt } from "@/lib/worldbox/objects";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { addItem } from "@/lib/worldbox/profile";
import { loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import { withUserLock } from "@/lib/worldbox/user-lock";

export const runtime = "nodejs";

// AGO WORLD BOX の釣り。
// POST { x, y }: 魚影のある座標で釣る。検証はサーバー側: 魚影の存在
// （決定的配置）、釣り竿の所持、本人の隣接（プレゼンス→セーブ、
// チェビシェフ ≤2）、再出現（10分）。ルートは座標とサイクルから決定的。
// 食いつきのタイミング勝負はクライアント側の演出で、結果はここが正。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const MAX_ACTION_DISTANCE = 2;

function err(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return err("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isFishingEnabled()) return err("fishing_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("invalid_request", 400);
  }
  const fields = (body ?? {}) as { x?: unknown; y?: unknown };
  const x = typeof fields.x === "number" ? Math.floor(fields.x) : NaN;
  const y = typeof fields.y === "number" ? Math.floor(fields.y) : NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > WORLD_COORD_LIMIT || Math.abs(y) > WORLD_COORD_LIMIT) {
    return err("invalid_coord", 400);
  }
  const ownerKey = sessionOwnerKey(session);
  if (!fishingSpotAt(MAP_SEED, x, y)) return err("no_spot", 404);

  return withUserLock(ownerKey, async () => {
    const profile = await loadProfile(ownerKey);
    if ((profile.items["fishing_rod"] ?? 0) <= 0) return err("tool_required", 409);
    // 隣接検証（プレゼンス → セーブ）
    const selfId = presenceIdFor(ownerKey);
    const now = Date.now();
    const entries = await listPresence();
    const entry = entries.find((e) => e.id === selfId && e.space === "world" && now - e.ts <= 15_000);
    let pos: { x: number; y: number } | null = entry ? { x: entry.x, y: entry.y } : null;
    if (!pos) {
      const saved = parseSave(await loadWorldBoxSave(ownerKey));
      if (saved && saved.space === "world") pos = { x: saved.x, y: saved.y };
    }
    if (!pos) return err("position_unknown", 409);
    if (Math.max(Math.abs(Math.floor(pos.x) - x), Math.abs(Math.floor(pos.y) - y)) > MAX_ACTION_DISTANCE) {
      return err("too_far", 409);
    }
    const caughtAt = await loadCaughtAt(x, y);
    if (!fishingReady(caughtAt, now)) return err("not_respawned", 409);
    const loot = lootForObjectAt(MAP_SEED, "fishing_spot", x, y, fishingNonce(caughtAt, now));
    if (!loot) return err("no_spot", 404);
    let next = profile;
    for (const [itemId, count] of Object.entries(loot.gained)) {
      next = addItem(next, itemId, count);
    }
    if (!(await storeProfile(ownerKey, next))) return err("store_failed", 503);
    await storeCaughtAt(x, y, now);
    return NextResponse.json({ ok: true, gained: loot.gained, profile: next }, { headers: NO_STORE });
  });
}
