import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { MAP_SEED, WORLD_COORD_LIMIT } from "@/lib/worldbox/mapgen";
import { makeRng } from "@/lib/worldbox/rng";
import {
  objectRespawned, rollObjectLoot, specialObjectById, surfaceObjectAt,
} from "@/lib/worldbox/objects";
import {
  isObjectsEnabled, loadHarvestedAt, loadObjectStates, storeHarvestedAt,
} from "@/lib/worldbox/objects-online";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { addItem, maxHpFor, wearTool } from "@/lib/worldbox/profile";
import { loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { addMasteryXp, MINER_BONUS_CHANCE } from "@/lib/worldbox/roles";
import { bestToolTier } from "@/lib/worldbox/tiles";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import { withUserLock } from "@/lib/worldbox/user-lock";

export const runtime = "nodejs";

// AGO WORLD BOX の地表オブジェクト（採取・採掘・宝箱・温泉・探索）。
// 配置は決定的計算（objects.ts）が正で、サーバーは保存しない。
// 枯渇だけを bot_kv（名前空間 worldbox_objects、キー "x,y" → 採取時刻）
// に共有状態として持ち、再出現は定義の respawnMs で判定する
// （respawnMs=0 は一回きり: 宝箱・石柱・温泉の恵みは全員で一度だけ）。
// GET ?x0&y0&x1&y1: 範囲内の枯渇状態を返す（表示同期用）。
// POST { x, y }: 対象を検証（存在・道具・段位・隣接・再出現）して
// ルート付与/回復/罠を適用し、枯渇を記録する。検証はすべてサーバー側。
// Bot API 未設定なら 503（クライアントはオブジェクト無しで遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const MAX_RECT_SPAN = 128;
const MAX_ACTION_DISTANCE = 2;
/** 宝箱の罠ダメージ（洞窟・遺跡の宝箱と同値）。 */
const TRAP_DAMAGE = 10;

function err(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function parseRect(request: Request): { x0: number; y0: number; x1: number; y1: number } | null {
  const q = new URL(request.url).searchParams;
  const nums = ["x0", "y0", "x1", "y1"].map((k) => {
    const v = q.get(k);
    return v === null ? NaN : Math.floor(Number(v));
  });
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [x0, y0, x1, y1] = nums;
  if (Math.abs(x0) > WORLD_COORD_LIMIT || Math.abs(y0) > WORLD_COORD_LIMIT) return null;
  if (x1 < x0 || y1 < y0 || x1 - x0 > MAX_RECT_SPAN || y1 - y0 > MAX_RECT_SPAN) return null;
  return { x0, y0, x1, y1 };
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isObjectsEnabled()) return err("objects_unavailable", 503);
  const rect = parseRect(request);
  if (!rect) return err("invalid_rect", 400);
  const all = await loadObjectStates();
  const states: Record<string, number> = {};
  for (const [key, at] of Object.entries(all)) {
    const m = /^(-?\d+),(-?\d+)$/.exec(key);
    if (!m) continue;
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) states[key] = at;
  }
  return NextResponse.json({ states }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return err("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isObjectsEnabled()) return err("objects_unavailable", 503);
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
  const placed = surfaceObjectAt(MAP_SEED, x, y);
  if (!placed || placed.objectId === "fishing_spot") return err("no_object", 404);
  const def = specialObjectById(placed.objectId);
  if (!def) return err("no_object", 404);
  const ownerKey = sessionOwnerKey(session);

  // 枯渇は全員共有のため、同じオブジェクトへの同時行為を直列化する
  // （洞窟が空間ロックで二重開封を防ぐのと同じ対策）。
  return withUserLock(`surface-object:${x},${y}`, async () => {
    const profile = await loadProfile(ownerKey);
    if (!profile) return err("profile_unavailable", 503);
    // 道具・段位（定義が正。ツルハシは洞窟と同じエラー名を使う）
    if (def.tool) {
      const tier = bestToolTier(profile, def.tool);
      if (tier <= 0) return err(def.tool === "pickaxe" ? "needs_pickaxe" : "tool_required", 409);
      if (tier < (def.minTier ?? 0)) return err(def.tool === "pickaxe" ? "pickaxe_tier" : "tool_required", 409);
    }
    // 隣接検証（プレゼンス → セーブ。釣りと同じチェビシェフ ≤2）
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
    const harvestedAt = await loadHarvestedAt(x, y);
    if (!objectRespawned(def, harvestedAt, now)) return err("depleted", 409);

    const rng = makeRng((now ^ x * 131 ^ y * 17) >>> 0);
    const loot = rollObjectLoot(def, rng);
    let next = profile;
    for (const [itemId, count] of Object.entries(loot.gained)) {
      next = addItem(next, itemId, count);
    }
    let trapped = false;
    if (def.interaction === "open") {
      trapped = loot.trapped;
      // 斥候の専門: 宝箱の罠を半減で回避する（洞窟・遺跡と同仕様）
      if (trapped && profile.role === "scout" && rng() < 0.5) trapped = false;
      if (trapped) next = { ...next, hp: Math.max(0, next.hp - TRAP_DAMAGE) };
    }
    if (def.interaction === "mine" && profile.role === "miner") {
      // 採掘者の常時効果: 追加ドロップ抽選 + 熟練（洞窟の採掘と同仕様）
      if (Math.random() < MINER_BONUS_CHANCE) {
        const bonus = rollObjectLoot(def, makeRng((now ^ 0x5eed) >>> 0));
        for (const [itemId, count] of Object.entries(bonus.gained)) {
          next = addItem(next, itemId, count);
        }
      }
      next = addMasteryXp(next, "miner", (def.minTier ?? 0) >= 2 ? 4 : 1).profile;
    }
    let healed = 0;
    if (def.interaction === "rest" && def.heal) {
      // 温泉: 定義の heal 分だけ回復する（洞窟温泉の全回復とは別物）
      healed = Math.min(maxHpFor(next), next.hp + def.heal) - next.hp;
      next = { ...next, hp: next.hp + healed };
    }
    // 道具の耐久: 道具を使う行為（鉱脈・倒木など）は最良の1本が摩耗する
    let broke: string | null = null;
    if (def.tool) {
      const worn = wearTool(next, def.tool);
      next = worn.profile;
      broke = worn.brokeItemId;
    }
    if (!(await storeProfile(ownerKey, next))) return err("store_failed", 503);
    await storeHarvestedAt(x, y, now);
    return NextResponse.json(
      { ok: true, gained: loot.gained, trapped, healed, profile: next, ...(broke ? { broke } : {}) },
      { headers: NO_STORE },
    );
  });
}
