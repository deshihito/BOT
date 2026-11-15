import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { kvGet, kvSet } from "@/lib/bot-api";
import { buildEconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  enqueueEconomyOp, isEconomyEnabled, loadMyEconomyOps, readUserBalance,
} from "@/lib/worldbox/economy-bridge-online";
import { addItem } from "@/lib/worldbox/profile";
import { loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { loadMyLobbyStation } from "@/lib/worldbox/station-online";
import { withUserLock } from "@/lib/worldbox/user-lock";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import { applyRest } from "@/lib/worldbox/vitals";

export const runtime = "nodejs";

// ロビー中央広場と休憩ポッドの小施設。
// - 噴水: コインを投げる（spend 10）とスタミナが全回復し、
//   ときどき素材が1つ手に入る。場所は噴水の前だけ。
// - 休憩: 休憩ポッドで休むとスタミナが全回復する（無料、3分に1回）。
// スタミナ自体はクライアント側の状態なので、サーバーは費用・場所・
// クールダウンを検証し、回復の可否だけを返す。
// POST: { action: "fountain" } / { action: "rest" }

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const FOUNTAIN_COST = 10;
const FOUNTAIN_ITEMS = ["wood", "stone", "herb", "flower", "apple"] as const;
const FOUNTAIN_ITEM_CHANCE = 0.25;
const REST_COOLDOWN_MS = 3 * 60 * 1000;
const REST_NAMESPACE = "worldbox_rest";

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function errorResponse(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorResponse("bad_origin", 403);
  const session = getRequestSession(request);
  if (!session) return errorResponse("unauthorized", 401);
  if (session.provider !== "discord") return errorResponse("unauthorized", 403);
  // 同一ユーザーのリクエストを直列化する（カジノ #943 と同型の対策）。
  // 並行すると噴水は残高検証（処理中 spend の差し引き）をすり抜けて
  // 二重に課金され、休憩はクールダウンの確認→記録が競合して
  // 連続で通ってしまう。
  return withUserLock(sessionOwnerKey(session), () => handlePost(request, session));
}

type AuthedSession = NonNullable<ReturnType<typeof getRequestSession>>;

async function handlePost(request: Request, session: AuthedSession) {
  const ownerKey = sessionOwnerKey(session);
  const discordId = session.id;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_json", 400);
  }

  if (body.action === "fountain") {
    if (!isEconomyEnabled()) return errorResponse("economy_unavailable", 503);
    const station = await loadMyLobbyStation(ownerKey);
    if (station !== "fountain") return errorResponse("not_at_fountain", 409);
    const [balance, ops] = await Promise.all([
      readUserBalance(discordId),
      loadMyEconomyOps(ownerKey),
    ]);
    const pendingSpend = ops
      .filter((op) => op.status === "pending" && op.kind === "spend")
      .reduce((sum, op) => sum + op.amount, 0);
    if (balance === null || balance - pendingSpend < FOUNTAIN_COST) {
      return errorResponse("insufficient_balance", 409);
    }
    const op = buildEconomyOp(
      { kind: "spend", userKey: ownerKey, discordId, amount: FOUNTAIN_COST, reason: "fountain_offering" },
      crypto.randomUUID(),
      Date.now(),
    );
    if (!op || !(await enqueueEconomyOp(op))) return errorResponse("economy_unavailable", 503);
    let item: string | null = null;
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    if (buf[0] / 4294967296 < FOUNTAIN_ITEM_CHANCE) {
      item = FOUNTAIN_ITEMS[Math.floor((buf[1] / 4294967296) * FOUNTAIN_ITEMS.length) % FOUNTAIN_ITEMS.length];
      const profile = await loadProfile(ownerKey);
      await storeProfile(ownerKey, addItem(profile, item, 1));
    }
    return NextResponse.json({ ok: true, stamina: true, item }, { headers: NO_STORE });
  }

  if (body.action === "rest") {
    const station = await loadMyLobbyStation(ownerKey);
    if (station !== "rest") return errorResponse("not_at_rest", 409);
    const key = `last:${ownerKey}`;
    const raw = await kvGet(REST_NAMESPACE, key);
    const last = typeof raw === "string" ? Number(raw) : NaN;
    const now = Date.now();
    if (Number.isFinite(last) && now - last < REST_COOLDOWN_MS) {
      return errorResponse("rest_cooldown", 409, {
        retryAfterSec: Math.ceil((REST_COOLDOWN_MS - (now - last)) / 1000),
      });
    }
    await kvSet(REST_NAMESPACE, key, String(now));
    // 休憩は HP 全回復＋毒消去も兼ね、戻り先（ワールド座標）を最後の休憩地点として記録する
    const saved = parseSave(await loadWorldBoxSave(ownerKey));
    const restPoint = saved?.worldReturn ?? (saved && saved.space === "world" ? { x: saved.x, y: saved.y } : null);
    const profile = await loadProfile(ownerKey);
    const rested = applyRest(profile, restPoint, now);
    await storeProfile(ownerKey, rested);
    return NextResponse.json({ ok: true, stamina: true, profile: rested }, { headers: NO_STORE });
  }

  return errorResponse("bad_action", 400);
}
