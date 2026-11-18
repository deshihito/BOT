import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { worldTileSource } from "@/lib/worldbox/mapgen";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { parseSave, serializeSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave, storeWorldBoxSave } from "@/lib/worldbox/save-online";
import { putPresence } from "@/lib/worldbox/presence-online";
import { loadNationsState } from "@/lib/worldbox/nations-online";
import { isTilesEnabled, loadTileOverrides } from "@/lib/worldbox/tiles-online";
import { isOverrideActive, tileKey, type TileOverridesMap } from "@/lib/worldbox/tiles";
import { componentTouchesCapital, isRailAt, railComponent, railRideError, railStops } from "@/lib/worldbox/rails";
import { findFreeNear } from "@/lib/worldbox/move";

export const runtime = "nodejs";

// AGO WORLD BOX の線路ワープ（経済仕様書 §6.2 鉄道）。
// GET: 自分が線路の上に立っていれば、同じ路線（連結成分）の行き先一覧と
//   自国の首都への接続有無を返す。線路の上でなければ onRail: false。
// POST { action: "ride", x, y }: 行き先の線路タイルへ移動する。
//   検証はすべてサーバー側: 本人の現在位置（プレゼンス→セーブ）が正で、
//   乗り場・降り場が同じ連結成分の線路であることを確かめる。
//   移動はセーブとプレゼンスに反映し、応答の座標が移動先になる
//   （ユニオンポーターと同じ流儀）。スタミナ消費なし。
// Bot API 未設定なら 503。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function err(error: string, status = 409) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/** サーバーが知る本人のワールド位置（プレゼンス → セーブの順）。無ければ null。 */
async function actorWorldPosition(ownerKey: string): Promise<{ x: number; y: number } | null> {
  const selfId = presenceIdFor(ownerKey);
  const entries = await listPresence();
  const now = Date.now();
  const entry = entries.find((e) => e.id === selfId && e.space === "world" && now - e.ts <= 15_000);
  if (entry) return { x: entry.x, y: entry.y };
  const saved = parseSave(await loadWorldBoxSave(ownerKey));
  if (saved && saved.space === "world") return { x: saved.x, y: saved.y };
  return null;
}

/** 有効な上書きだけに絞る（失効分は地形どおり）。 */
async function activeOverrides(): Promise<TileOverridesMap> {
  const all = await loadTileOverrides();
  const now = Date.now();
  const active: TileOverridesMap = {};
  for (const [key, ov] of Object.entries(all)) {
    if (isOverrideActive(ov, now)) active[key] = ov;
  }
  return active;
}

/** 本人の所属国の首都。未所属・未建国なら null。 */
async function myCapital(ownerKey: string): Promise<{ x: number; y: number } | null> {
  const state = await loadNationsState();
  const mine = (state.members ?? {})[ownerKey];
  if (!mine) return null;
  return (state.nations ?? {})[mine.nationId]?.capital ?? null;
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isTilesEnabled()) return err("rails_unavailable", 503);
  const ownerKey = sessionOwnerKey(session);
  const pos = await actorWorldPosition(ownerKey);
  if (!pos) {
    return NextResponse.json({ onRail: false, stops: [] }, { headers: NO_STORE });
  }
  const tx = Math.floor(pos.x);
  const ty = Math.floor(pos.y);
  const overrides = await activeOverrides();
  if (!isRailAt(overrides, tx, ty)) {
    return NextResponse.json({ onRail: false, stops: [] }, { headers: NO_STORE });
  }
  const fromKey = tileKey(tx, ty);
  const capital = await myCapital(ownerKey);
  const component = railComponent(overrides, fromKey);
  return NextResponse.json(
    {
      onRail: true,
      capitalConnected: capital !== null && componentTouchesCapital(component, capital),
      stops: railStops(overrides, fromKey, capital),
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return err("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isTilesEnabled()) return err("rails_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("invalid_request", 400);
  }
  const fields = (body ?? {}) as { action?: unknown; x?: unknown; y?: unknown };
  if (fields.action !== "ride" || typeof fields.x !== "number" || typeof fields.y !== "number" || !Number.isFinite(fields.x) || !Number.isFinite(fields.y)) {
    return err("invalid_request", 400);
  }
  const ownerKey = sessionOwnerKey(session);
  const pos = await actorWorldPosition(ownerKey);
  if (!pos) return err("position_unknown", 409);
  const fromKey = tileKey(Math.floor(pos.x), Math.floor(pos.y));
  const toKey = tileKey(Math.floor(fields.x), Math.floor(fields.y));
  const overrides = await activeOverrides();
  const rideError = railRideError(overrides, fromKey, toKey);
  if (rideError) return err(rideError, 409);
  const destTile = { x: Math.floor(fields.x), y: Math.floor(fields.y) };
  const dest = findFreeNear(worldTileSource(), destTile.x + 0.5, destTile.y + 0.5, undefined, { swim: true });
  const prev = parseSave(await loadWorldBoxSave(ownerKey));
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
  return NextResponse.json({ ok: true, x: dest.x, y: dest.y }, { headers: NO_STORE });
}
