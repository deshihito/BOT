import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { MAP_SEED, WORLD_COORD_LIMIT } from "@/lib/worldbox/mapgen";
import { fishingNonce, fishingReady, fishingSpotAt } from "@/lib/worldbox/fishing";
import { isFishingEnabled, loadAllCaughtAt, loadCaughtAt, storeCaughtAt } from "@/lib/worldbox/fishing-online";
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
const MAX_RECT_SPAN = 128;

function err(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/**
 * GET ?x0&y0&x1&y1: 範囲内の釣果時刻を返す。他プレイヤーが釣った魚影を
 * 自分の画面でも消すための表示同期（従来は共有状態なのに読む経路が
 * 無く、タップして初めて弾かれていた）。
 */
export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isFishingEnabled()) return err("fishing_unavailable", 503);
  const q = new URL(request.url).searchParams;
  const nums = ["x0", "y0", "x1", "y1"].map((k) => {
    const v = q.get(k);
    return v === null ? NaN : Math.floor(Number(v));
  });
  if (nums.some((n) => !Number.isFinite(n))) return err("invalid_rect", 400);
  const [x0, y0, x1, y1] = nums;
  if (Math.abs(x0) > WORLD_COORD_LIMIT || Math.abs(y0) > WORLD_COORD_LIMIT) return err("invalid_rect", 400);
  if (x1 < x0 || y1 < y0 || x1 - x0 > MAX_RECT_SPAN || y1 - y0 > MAX_RECT_SPAN) return err("invalid_rect", 400);
  const all = await loadAllCaughtAt();
  const caught: Record<string, number> = {};
  for (const [key, at] of Object.entries(all)) {
    const m = /^(-?\d+),(-?\d+)$/.exec(key);
    if (!m) continue;
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) caught[key] = at;
  }
  return NextResponse.json({ caught }, { headers: NO_STORE });
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
