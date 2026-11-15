import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { generateMap } from "@/lib/worldbox/mapgen";
import {
  applyBuild, applyDemolish, buildingViews, type BuildResult,
} from "@/lib/worldbox/buildings";
import { isBuildingsEnabled, loadBuildings, storeBuildings } from "@/lib/worldbox/buildings-online";
import { loadNationsState } from "@/lib/worldbox/nations-online";

export const runtime = "nodejs";

// AGO WORLD BOX の建物（個人所有。国への所属は建築に関係しない）。
// GET: { buildings, loggedIn }（誰でも読める。建物には本人のものかの印が付く）
// POST { action: "build", type, x, y } : 建築（家・畑・塔）
// POST { action: "demolish", x, y } : 自分の建物を取り壊す
// 保存先は bot_kv（名前空間 worldbox_nations の "buildings"）。
// Bot API 未設定なら 503（クライアントは建物なしで遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** 入力起因のエラーは 400、所有権エラーは 403、状態競合は 409 に寄せる。 */
const BAD_REQUEST_ERRORS = new Set(["invalid_action", "invalid_request", "invalid_type"]);

function errorStatus(error: string): number {
  if (error === "not_owner") return 403;
  return BAD_REQUEST_ERRORS.has(error) ? 400 : 409;
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

export async function GET(request: Request) {
  if (!isBuildingsEnabled()) {
    return NextResponse.json({ error: "buildings_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  const buildings = await loadBuildings();
  const selfKey = session ? sessionOwnerKey(session) : null;
  return NextResponse.json(
    { buildings: buildingViews(buildings, selfKey), loggedIn: selfKey !== null },
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
  if (!isBuildingsEnabled()) {
    return NextResponse.json({ error: "buildings_unavailable" }, { status: 503, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const action = (body as { action?: unknown } | null)?.action;
  if (action !== "build" && action !== "demolish") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400, headers: NO_STORE });
  }
  const ownerKey = sessionOwnerKey(session);
  const fields = body as { type?: unknown; x?: unknown; y?: unknown };
  const buildings = await loadBuildings();

  let result: BuildResult;
  if (action === "build") {
    // 首都タイルの保護にだけ国家データを参照する（所属は不問）。
    const state = await loadNationsState();
    const capitals = Object.values(state.nations).map((n) => n.capital);
    result = applyBuild(buildings, ownerKey, capitals, generateMap(), fields.type, fields.x, fields.y, Date.now());
  } else {
    result = applyDemolish(buildings, ownerKey, fields.x, fields.y);
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: errorStatus(result.error), headers: NO_STORE });
  }
  const stored = await storeBuildings(result.buildings);
  if (!stored) {
    return NextResponse.json({ error: "buildings_failed" }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json(
    { ok: true, buildings: buildingViews(result.buildings, ownerKey) },
    { headers: NO_STORE },
  );
}
