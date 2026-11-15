import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import {
  activeWarBetween, applyMarkAttack, declareError, declareWar, isRepairing,
  markHpNow, MARK_HP_MAX, type WarState,
} from "@/lib/worldbox/war";
import { isWarEnabled, loadWarState, storeWarState } from "@/lib/worldbox/war-online";
import { withUserLock } from "@/lib/worldbox/user-lock";
import { loadNationsState } from "@/lib/worldbox/nations-online";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";

export const runtime = "nodejs";

// AGO WORLD BOX のユニオン戦争。
// GET: 自分のユニオンの戦争・マーク HP・全ユニオンのマーク状態
// POST { action: "declare", targetGuildId }: 国王だけが宣言できる
// POST { action: "attack_mark", guildId }: 戦争相手のマーク（首都）を攻撃する。
//   資格は戦争状態 + 首都タイルへの近接（プレゼンス検証）。
// Bot API 未設定なら 503。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const MARK_ATTACK_RANGE = 3.5;
const MARK_ATTACK_INTERVAL_MS = 5_000;
const lastMarkAttackAt = new Map<string, number>();

function err(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function warView(state: WarState, now: number) {
  const marks: Record<string, { hp: number; max: number; repairing: boolean }> = {};
  for (const gid of Object.keys(state.marks)) {
    marks[gid] = {
      hp: markHpNow(state, gid, now),
      max: MARK_HP_MAX,
      repairing: isRepairing(state, gid, now),
    };
  }
  return {
    wars: state.wars.filter((w) => w.expiresAt > now),
    marks,
    raids: state.raids.slice(-10),
  };
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isWarEnabled()) return err("war_unavailable", 503);
  const ownerKey = sessionOwnerKey(session);
  const [state, nations] = await Promise.all([loadWarState(), loadNationsState()]);
  const membership = nations.members[ownerKey];
  return NextResponse.json(
    {
      ...warView(state, Date.now()),
      myGuildId: membership?.nationId ?? null,
      myRole: membership?.role ?? null,
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return err("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isWarEnabled()) return err("war_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("invalid_request", 400);
  }
  const fields = (body ?? {}) as { action?: unknown; targetGuildId?: unknown; guildId?: unknown };
  const ownerKey = sessionOwnerKey(session);
  const now = Date.now();

  return withUserLock("war:state", async () => {
    const [state, nations] = await Promise.all([loadWarState(), loadNationsState()]);
    const membership = nations.members[ownerKey];
    if (!membership) return err("no_union", 409);
    const myGuild = membership.nationId;

    if (fields.action === "declare") {
      if (membership.role !== "king") return err("king_only", 403);
      const target = fields.targetGuildId;
      if (typeof target !== "string" || !nations.nations[target]) return err("unknown_guild", 400);
      const problem = declareError(state, myGuild, target, now);
      if (problem) return err(problem, 409);
      const next = declareWar(state, myGuild, target, now);
      if (!(await storeWarState(next))) return err("store_failed", 503);
      return NextResponse.json({ ok: true, ...warView(next, now) }, { headers: NO_STORE });
    }

    if (fields.action === "attack_mark") {
      const target = fields.guildId;
      if (typeof target !== "string" || !nations.nations[target]) return err("unknown_guild", 400);
      if (!activeWarBetween(state, myGuild, target, now)) return err("not_at_war", 409);
      if (isRepairing(state, target, now)) return err("repairing", 409);
      const last = lastMarkAttackAt.get(ownerKey) ?? 0;
      if (now - last < MARK_ATTACK_INTERVAL_MS) return err("too_fast", 429);
      // 首都タイルへの近接をプレゼンスで検証する
      const capital = nations.nations[target].capital;
      const selfId = presenceIdFor(ownerKey);
      const entries = await listPresence();
      const me = entries.find((e) => e.id === selfId && e.space === "world" && now - e.ts <= 15_000);
      if (!me) return err("position_unknown", 409);
      if (Math.hypot(me.x - (capital.x + 0.5), me.y - (capital.y + 0.5)) > MARK_ATTACK_RANGE) {
        return err("too_far", 409);
      }
      lastMarkAttackAt.set(ownerKey, now);
      const result = applyMarkAttack(state, myGuild, target, now);
      if (!(await storeWarState(result.state))) return err("store_failed", 503);
      return NextResponse.json(
        { ok: true, hp: result.hp, destroyed: result.destroyed, ...warView(result.state, now) },
        { headers: NO_STORE },
      );
    }

    return err("invalid_action", 400);
  });
}
