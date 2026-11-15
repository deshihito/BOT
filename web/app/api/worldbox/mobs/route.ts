import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { MAP_H, MAP_W, MAP_SEED } from "@/lib/worldbox/mapgen";
import { loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import { addItem } from "@/lib/worldbox/profile";
import { playerAttack } from "@/lib/worldbox/arena";
import { mobById } from "@/lib/worldbox/mobs";
import { isNightPhase, phaseAtTime } from "@/lib/worldbox/daynight";
import {
  applyMobAttack, mobDistance, mobExistsAt, mobKeyOf, visibleMobs,
  MOB_ATTACK_MAX_DISTANCE, type MobState,
} from "@/lib/worldbox/combat";
import { isMobsEnabled, loadMobState, loadMobStates, storeMobState } from "@/lib/worldbox/mobs-online";

export const runtime = "nodejs";

// AGO WORLD BOX のフィールド戦闘（モブへの攻撃）。
// モブの配置は mobs.ts の決定的配置が正で、個体は "mobId@x,y" で識別する。
// サーバーは攻撃のたびに配置を再計算して実在を検証し、HP と死亡
// （再出現待ち）だけを bot_kv（名前空間 worldbox_mobs）に持つ。
// ダメージは闘技場と同じ式（素手8 + 所持する最良の剣 tier×4）。
// GET ?x0&y0&x1&y1: 範囲内の個体のうち状態がある（傷/死亡）ものだけ返す。
// POST { action: "attack", mobId, x, y }: 攻撃を適用し、HP と戦利品を返す。
// Bot API 未設定なら 503（クライアントはモブなしで遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** GET で返す範囲の上限（1辺のタイル数）。 */
const MAX_RECT_SPAN = 128;

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function clampIntParam(raw: string | null, min: number, max: number, fallback: number): number {
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * 距離検証に使う本人のワールド位置。新鮮なプレゼンス → クライアント申告 →
 * セーブの順。プレゼンスは WS 中継中 bot_kv に届かず凍結するため、申告位置を
 * フォールバックに使う（ハートビート自体が元々クライアント申告制）。
 * どれも無ければ null（検証スキップ）。
 */
async function actorWorldPosition(
  ownerKey: string,
  reported?: { x: number; y: number } | null,
): Promise<{ x: number; y: number } | null> {
  const selfId = presenceIdFor(ownerKey);
  const entries = await listPresence();
  const now = Date.now();
  const entry = entries.find((e) => e.id === selfId && e.space === "world" && now - e.ts <= 15_000);
  if (entry) return { x: entry.x, y: entry.y };
  if (reported) return reported;
  const saved = parseSave(await loadWorldBoxSave(ownerKey));
  if (saved && saved.space === "world") return { x: saved.x, y: saved.y };
  return null;
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isMobsEnabled()) {
    return NextResponse.json({ error: "mobs_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const url = new URL(request.url);
  const x0 = clampIntParam(url.searchParams.get("x0"), 0, MAP_W - 1, 0);
  const y0 = clampIntParam(url.searchParams.get("y0"), 0, MAP_H - 1, 0);
  const x1 = clampIntParam(url.searchParams.get("x1"), x0, Math.min(MAP_W - 1, x0 + MAX_RECT_SPAN - 1), x0);
  const y1 = clampIntParam(url.searchParams.get("y1"), y0, Math.min(MAP_H - 1, y0 + MAX_RECT_SPAN - 1), y0);
  const now = Date.now();
  const isNight = isNightPhase(phaseAtTime(now / 1000));
  const all = await loadMobStates();
  const states: Record<string, MobState> = {};
  for (const placed of visibleMobs(MAP_SEED, x0, y0, x1, y1, isNight)) {
    const key = mobKeyOf(placed);
    const st = all[key];
    if (!st) continue;
    if (st.deadUntil !== undefined && now >= st.deadUntil) continue; // 復活済みは満タン扱い
    states[key] = st;
  }
  return NextResponse.json(
    { states, selfId: presenceIdFor(sessionOwnerKey(session)) },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isMobsEnabled()) {
    return NextResponse.json({ error: "mobs_unavailable" }, { status: 503, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const fields = (body ?? {}) as { action?: unknown; mobId?: unknown; x?: unknown; y?: unknown; px?: unknown; py?: unknown };
  if (fields.action !== "attack" || typeof fields.x !== "number" || typeof fields.y !== "number") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const reported =
    typeof fields.px === "number" && typeof fields.py === "number" &&
    Number.isFinite(fields.px) && Number.isFinite(fields.py) &&
    fields.px >= 0 && fields.py >= 0 && fields.px < MAP_W && fields.py < MAP_H
      ? { x: fields.px, y: fields.py }
      : null;
  const def = mobById(fields.mobId);
  const x = Math.floor(fields.x);
  const y = Math.floor(fields.y);
  if (!def || def.instanceOnly || x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) {
    return NextResponse.json({ error: "unknown_mob" }, { status: 400, headers: NO_STORE });
  }
  const now = Date.now();
  const isNight = isNightPhase(phaseAtTime(now / 1000));
  if (!mobExistsAt(MAP_SEED, def.id, x, y, isNight)) {
    return NextResponse.json({ error: "unknown_mob" }, { status: 400, headers: NO_STORE });
  }
  const ownerKey = sessionOwnerKey(session);
  const placed = { mobId: def.id, x, y, size: def.size, biome: "plains" as const };

  // 隣接検証（本人の位置が分かる場合だけ、占有範囲までの距離）
  const pos = await actorWorldPosition(ownerKey, reported);
  if (pos) {
    const dist = mobDistance(Math.floor(pos.x), Math.floor(pos.y), placed);
    if (dist > MOB_ATTACK_MAX_DISTANCE) {
      return NextResponse.json({ error: "too_far" }, { status: 409, headers: NO_STORE });
    }
  }

  const key = mobKeyOf(placed);
  const state = await loadMobState(key);
  const profile = await loadProfile(ownerKey);
  const result = applyMobAttack(def, state, playerAttack(profile.items), now, Math.random);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 409, headers: NO_STORE });
  }
  if (!(await storeMobState(key, result.state))) {
    return NextResponse.json({ error: "mobs_failed" }, { status: 500, headers: NO_STORE });
  }
  let updatedProfile = null;
  if (result.dead && Object.keys(result.gained).length > 0) {
    let next = profile;
    for (const [itemId, count] of Object.entries(result.gained)) {
      next = addItem(next, itemId, count);
    }
    if (!(await storeProfile(ownerKey, next))) {
      return NextResponse.json({ error: "mobs_failed" }, { status: 500, headers: NO_STORE });
    }
    updatedProfile = next;
  }
  return NextResponse.json(
    {
      ok: true,
      key,
      hp: result.hp,
      maxHp: def.hp,
      dead: result.dead,
      gained: result.gained,
      ...(updatedProfile ? { profile: updatedProfile } : {}),
    },
    { headers: NO_STORE },
  );
}
