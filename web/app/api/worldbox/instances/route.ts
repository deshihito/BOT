import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { MAP_SEED } from "@/lib/worldbox/mapgen";
import { loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { addItem } from "@/lib/worldbox/profile";
import { itemById } from "@/lib/worldbox/items";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave, storeWorldBoxSave } from "@/lib/worldbox/save-online";
import { serializeSave } from "@/lib/worldbox/save";
import {
  buildCaveLayer, parseInstanceSpace, CAVE_CHEST_RESPAWN_MS,
} from "@/lib/worldbox/instances";
import { isInstancesEnabled, loadInstanceState, storeInstanceState } from "@/lib/worldbox/instances-online";
import { rollObjectLoot, specialObjectById } from "@/lib/worldbox/objects";
import { makeRng } from "@/lib/worldbox/rng";
import { applyRest } from "@/lib/worldbox/vitals";

export const runtime = "nodejs";

// AGO WORLD BOX のインスタンス内アクション（洞窟の採掘・宝箱・温泉）。
// 配置は instances.ts の決定的生成が正で、サーバーは毎回再生成して検証する。
// 位置検証は REST ハートビート（プレゼンス）の自空間エントリで行い、
// 無ければセーブ位置で代替する（WS 中継中は bot_kv プレゼンスが凍結するため）。
// GET ?space=cave:x,y:層: 枯渇状態 { veins, chest }。
// POST { action: "mine", space, veinKey } / { action: "open_chest", space }
//      / { action: "onsen", space }。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const REACH = 2.4;

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function bestToolTier(profile: { items: Record<string, number> }, tool: string): number {
  let best = 0;
  for (const [id, count] of Object.entries(profile.items)) {
    if (count <= 0) continue;
    const def = itemById(id);
    if (def?.tool === tool && (def.tier ?? 0) > best) best = def.tier ?? 0;
  }
  return best;
}

async function actorPos(ownerKey: string, space: string): Promise<{ x: number; y: number } | null> {
  const selfId = presenceIdFor(ownerKey);
  const entries = await listPresence();
  const now = Date.now();
  const entry = entries.find((e) => e.id === selfId && e.space === space && now - e.ts <= 15_000);
  if (entry) return { x: entry.x, y: entry.y };
  const saved = parseSave(await loadWorldBoxSave(ownerKey));
  if (saved && saved.space === space) return { x: saved.x, y: saved.y };
  return null;
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  if (!isInstancesEnabled()) return NextResponse.json({ error: "instances_unavailable" }, { status: 503, headers: NO_STORE });
  const space = new URL(request.url).searchParams.get("space") ?? "";
  const inst = parseInstanceSpace(space);
  if (!inst || inst.kind !== "cave") return NextResponse.json({ error: "invalid_space" }, { status: 400, headers: NO_STORE });
  const state = await loadInstanceState(space);
  return NextResponse.json({ veins: state.veins, chest: state.chest }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  const session = getRequestSession(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  if (!isInstancesEnabled()) return NextResponse.json({ error: "instances_unavailable" }, { status: 503, headers: NO_STORE });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const fields = (body ?? {}) as { action?: unknown; space?: unknown; veinKey?: unknown };
  const space = typeof fields.space === "string" ? fields.space : "";
  const inst = parseInstanceSpace(space);
  if (!inst || inst.kind !== "cave") return NextResponse.json({ error: "invalid_space" }, { status: 400, headers: NO_STORE });
  const ownerKey = sessionOwnerKey(session);
  const now = Date.now();
  const cave = buildCaveLayer(MAP_SEED, inst.entranceX, inst.entranceY, inst.layer);
  const pos = await actorPos(ownerKey, space);
  const near = (x: number, y: number) => pos !== null && Math.hypot(pos.x - (x + 0.5), pos.y - (y + 0.5)) <= REACH;

  if (fields.action === "onsen") {
    if (cave.onsen.length === 0 || !cave.onsen.some((t) => near(t.x, t.y))) {
      return NextResponse.json({ error: "not_at_onsen" }, { status: 409, headers: NO_STORE });
    }
    const profile = await loadProfile(ownerKey);
    if (!profile) return NextResponse.json({ error: "profile_unavailable" }, { status: 503, headers: NO_STORE });
    // 休憩地点は入口の外（ワールド座標）として記録する。
    const rested = applyRest(profile, { x: inst.entranceX + 0.5, y: inst.entranceY + 0.5 }, now);
    if (!(await storeProfile(ownerKey, rested))) {
      return NextResponse.json({ error: "profile_unavailable" }, { status: 503, headers: NO_STORE });
    }
    const saved = parseSave(await loadWorldBoxSave(ownerKey));
    if (saved) {
      saved.worldReturn = { x: inst.entranceX + 0.5, y: inst.entranceY + 0.5 };
      await storeWorldBoxSave(ownerKey, serializeSave(saved));
    }
    return NextResponse.json({ ok: true, hp: rested.hp, hunger: rested.hunger, profile: rested }, { headers: NO_STORE });
  }

  if (fields.action === "mine" || fields.action === "open_chest") {
    const profile = await loadProfile(ownerKey);
    if (!profile) return NextResponse.json({ error: "profile_unavailable" }, { status: 503, headers: NO_STORE });
    const state = await loadInstanceState(space);

    if (fields.action === "mine") {
      const vein = cave.veins.find((v) => v.key === fields.veinKey);
      if (!vein) return NextResponse.json({ error: "no_vein" }, { status: 404, headers: NO_STORE });
      if (!near(vein.x, vein.y)) return NextResponse.json({ error: "too_far" }, { status: 409, headers: NO_STORE });
      const def = specialObjectById(vein.objectId);
      if (!def) return NextResponse.json({ error: "no_vein" }, { status: 404, headers: NO_STORE });
      const takenAt = state.veins[vein.key] ?? 0;
      if (takenAt > 0 && now - takenAt < def.respawnMs) {
        return NextResponse.json({ error: "depleted" }, { status: 409, headers: NO_STORE });
      }
      if (bestToolTier(profile, "pickaxe") <= 0) {
        return NextResponse.json({ error: "needs_pickaxe" }, { status: 409, headers: NO_STORE });
      }
      if (bestToolTier(profile, "pickaxe") < (def.minTier ?? 0)) {
        return NextResponse.json({ error: "pickaxe_tier" }, { status: 409, headers: NO_STORE });
      }
      const loot = rollObjectLoot(def, makeRng((now ^ vein.x * 131 ^ vein.y * 17) >>> 0));
      let next = profile;
      for (const [id, count] of Object.entries(loot.gained)) next = addItem(next, id, count);
      state.veins[vein.key] = now;
      await storeInstanceState(space, state);
      if (!(await storeProfile(ownerKey, next))) {
        return NextResponse.json({ error: "profile_unavailable" }, { status: 503, headers: NO_STORE });
      }
      return NextResponse.json({ ok: true, gained: loot.gained, profile: next }, { headers: NO_STORE });
    }

    // open_chest
    if (!cave.chest) return NextResponse.json({ error: "no_chest" }, { status: 404, headers: NO_STORE });
    if (!near(cave.chest.x, cave.chest.y)) return NextResponse.json({ error: "too_far" }, { status: 409, headers: NO_STORE });
    if (state.chest > 0 && now - state.chest < CAVE_CHEST_RESPAWN_MS) {
      return NextResponse.json({ error: "depleted" }, { status: 409, headers: NO_STORE });
    }
    const def = specialObjectById("cave_chest");
    if (!def) return NextResponse.json({ error: "no_chest" }, { status: 404, headers: NO_STORE });
    const loot = rollObjectLoot(def, makeRng((now ^ cave.chest.x * 71 ^ cave.chest.y) >>> 0));
    let next = profile;
    for (const [id, count] of Object.entries(loot.gained)) next = addItem(next, id, count);
    let trapped = false;
    if (loot.trapped) {
      trapped = true;
      next = { ...next, hp: Math.max(0, next.hp - 10) };
    }
    state.chest = now;
    await storeInstanceState(space, state);
    if (!(await storeProfile(ownerKey, next))) {
      return NextResponse.json({ error: "profile_unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ ok: true, gained: loot.gained, trapped, profile: next }, { headers: NO_STORE });
  }

  return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
}
