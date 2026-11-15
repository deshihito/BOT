import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { MAP_SEED, WORLD_COORD_LIMIT } from "@/lib/worldbox/mapgen";
import { isNightPhase, phaseAtTime } from "@/lib/worldbox/daynight";
import { mobById } from "@/lib/worldbox/mobs";
import { mobDistance, mobExistsAt, MOB_ATTACK_MAX_DISTANCE } from "@/lib/worldbox/combat";
import { isProfileEnabled, loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import { loadNationsState } from "@/lib/worldbox/nations-online";
import { loadTileOverride } from "@/lib/worldbox/tiles-online";
import { buildCaveLayer, parseInstanceSpace, weekKeyOf } from "@/lib/worldbox/instances";
import { loadRuinsPersonal } from "@/lib/worldbox/instances-online";
import type { PlayerProfile, RespawnPoint } from "@/lib/worldbox/profile";
import {
  applyDeath, applyMobDamage, resolveRespawnPoint, setBedRespawn, stepVitals,
} from "@/lib/worldbox/vitals";

export const runtime = "nodejs";

// AGO WORLD BOX のプレイヤーバイタル（HP・空腹・毒・死亡・リスポーン）。
// 状態の正は profile（bot_kv worldbox_profiles）で、遷移規則は vitals.ts。
// POST { action: "sync" }: 時間経過の精算（空腹・毒・飢え）。死亡したら死亡処理まで行う
// POST { action: "damage", mobId, x, y, px?, py? }: モブ接触ダメージ。
//   配置の再計算で実在を検証し、距離は mobs ルートと同じ方式（プレゼンス→申告→セーブ）
// POST { action: "set_bed", x, y }: そのタイルのベッドをリスポーン点にする（近接検証）
// 死亡時は { died: true, dropped, respawn: {x, y} } を返し、クライアントが移動する。
// REST ハートビートには触らない（サーバー検証の正はプレゼンス側）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function errorResponse(error: string, status = 409) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/** 距離検証に使う本人のワールド位置（mobs ルートと同じ優先順）。 */
async function actorWorldPosition(
  ownerKey: string,
  reported?: { x: number; y: number } | null,
  space: string = "world",
): Promise<{ x: number; y: number } | null> {
  const selfId = presenceIdFor(ownerKey);
  const entries = await listPresence();
  const now = Date.now();
  const entry = entries.find((e) => e.id === selfId && e.space === space && now - e.ts <= 15_000);
  if (entry) return { x: entry.x, y: entry.y };
  if (reported) return reported;
  const saved = parseSave(await loadWorldBoxSave(ownerKey));
  if (saved && saved.space === space) return { x: saved.x, y: saved.y };
  return null;
}

/** 所属国のマーク（首都タイル中心）。未所属・未建国なら null。 */
async function unionMarkOf(ownerKey: string): Promise<RespawnPoint | null> {
  const state = await loadNationsState();
  const membership = state.members[ownerKey];
  if (!membership) return null;
  const nation = state.nations[membership.nationId];
  if (!nation) return null;
  return { x: nation.capital.x + 0.5, y: nation.capital.y + 0.5 };
}

/** 死亡処理まで行い、保存して返す。 */
async function settleDeath(
  ownerKey: string,
  profile: PlayerProfile,
  now: number,
): Promise<NextResponse> {
  const { profile: revived, dropped } = applyDeath(profile, now);
  const mark = await unionMarkOf(ownerKey);
  const { point, source } = resolveRespawnPoint(
    revived, mark, { x: 0.5, y: 0.5 },
  );
  if (!(await storeProfile(ownerKey, revived))) return errorResponse("store_failed", 503);
  return NextResponse.json(
    { profile: revived, died: true, dropped, respawn: { x: point.x, y: point.y, source } },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorResponse("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return errorResponse("unauthorized", 401);
  if (!isProfileEnabled()) return errorResponse("profile_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid_request", 400);
  }
  const data = (body ?? {}) as {
    action?: unknown; mobId?: unknown; x?: unknown; y?: unknown; px?: unknown; py?: unknown; space?: unknown;
  };
  const ownerKey = sessionOwnerKey(session);
  const now = Date.now();
  const current = await loadProfile(ownerKey);

  if (data.action === "sync") {
    const { profile, died } = stepVitals(current, now);
    if (died) return settleDeath(ownerKey, profile, now);
    if (profile !== current && !(await storeProfile(ownerKey, profile))) {
      return errorResponse("store_failed", 503);
    }
    return NextResponse.json({ profile, died: false }, { headers: NO_STORE });
  }

  if (data.action === "damage") {
    const def = mobById(data.mobId);
    const instDmg = typeof data.space === "string" ? parseInstanceSpace(data.space) : null;
    const inCave = instDmg?.kind === "cave";
    const inRuins = instDmg?.kind === "ruins";
    if (!def || def.temperament === "passive" || def.attack <= 0 || (def.instanceOnly && !inCave) || (inCave && def.instanceOnly && def.instanceOnly !== "cave")) {
      return errorResponse("unknown_mob", 400);
    }
    if (typeof data.x !== "number" || typeof data.y !== "number") {
      return errorResponse("invalid_request", 400);
    }
    const x = Math.floor(data.x);
    const y = Math.floor(data.y);
    if (Math.abs(x) > WORLD_COORD_LIMIT || Math.abs(y) > WORLD_COORD_LIMIT) return errorResponse("unknown_mob", 400);
    if (inCave && instDmg) {
      const cave = buildCaveLayer(MAP_SEED, instDmg.entranceX, instDmg.entranceY, instDmg.layer);
      if (!cave.mobs.some((m) => m.mobId === def.id && m.x === x && m.y === y)) {
        return errorResponse("unknown_mob", 400);
      }
    } else if (inRuins && instDmg && typeof data.space === "string") {
      const personal = await loadRuinsPersonal(data.space, ownerKey, weekKeyOf(now));
      if (!personal.summons.some((m) => m.mobId === def.id && m.x === x && m.y === y)) {
        return errorResponse("unknown_mob", 400);
      }
    } else {
      const isNight = isNightPhase(phaseAtTime(now / 1000));
      if (!mobExistsAt(MAP_SEED, def.id, x, y, isNight) && !mobExistsAt(MAP_SEED, def.id, x, y, !isNight)) {
        return errorResponse("unknown_mob", 400);
      }
    }
    const reported =
      typeof data.px === "number" && typeof data.py === "number" &&
      Number.isFinite(data.px) && Number.isFinite(data.py) &&
      Math.abs(data.px) <= WORLD_COORD_LIMIT && Math.abs(data.py) <= WORLD_COORD_LIMIT
        ? { x: data.px, y: data.py }
        : null;
    const pos = await actorWorldPosition(ownerKey, reported, (inCave || inRuins) && typeof data.space === "string" ? data.space : "world");
    if (pos) {
      const dist = mobDistance(Math.floor(pos.x), Math.floor(pos.y), { x, y, size: def.size });
      if (dist > MOB_ATTACK_MAX_DISTANCE) return errorResponse("too_far", 409);
    }
    const result = applyMobDamage(current, def.id, def.attack, now, Math.random);
    if (result.died) return settleDeath(ownerKey, result.profile, now);
    if (!(await storeProfile(ownerKey, result.profile))) return errorResponse("store_failed", 503);
    return NextResponse.json(
      { profile: result.profile, died: false, applied: result.applied, poisoned: result.poisoned },
      { headers: NO_STORE },
    );
  }

  if (data.action === "set_bed") {
    if (typeof data.x !== "number" || typeof data.y !== "number") {
      return errorResponse("invalid_request", 400);
    }
    const x = Math.floor(data.x);
    const y = Math.floor(data.y);
    if (Math.abs(x) > WORLD_COORD_LIMIT || Math.abs(y) > WORLD_COORD_LIMIT) return errorResponse("invalid_request", 400);
    const override = await loadTileOverride(x, y);
    if (!override?.block || override.block.itemId !== "bed") return errorResponse("not_a_bed", 409);
    const pos = await actorWorldPosition(ownerKey, null);
    if (pos && Math.max(Math.abs(Math.floor(pos.x) - x), Math.abs(Math.floor(pos.y) - y)) > 2) {
      return errorResponse("too_far", 409);
    }
    const next = setBedRespawn(current, x, y);
    if (!(await storeProfile(ownerKey, next))) return errorResponse("store_failed", 503);
    return NextResponse.json({ profile: next, respawn: next.respawn }, { headers: NO_STORE });
  }

  return errorResponse("invalid_action", 400);
}
