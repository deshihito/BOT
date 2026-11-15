import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { generateMap } from "@/lib/worldbox/mapgen";
import {
  applyBuild, applyDemolish, applyFound, applyJoin, applyLeave, buildingViews,
  buildNationsResponse, nationViews, removeNationBuildings,
  type BuildResult, type NationActionResult,
} from "@/lib/worldbox/nations";
import {
  isNationsEnabled, loadBuildings, loadNationsState, storeBuildings, storeNationsState,
} from "@/lib/worldbox/nations-online";

export const runtime = "nodejs";

// AGO WORLD BOX の国家レイヤー。
// GET: { nations, buildings, me, playerNations, loggedIn }（誰でも読める。ゲストは閲覧のみ）
// POST { action: "found", name } : 建国（首都は中央から渦巻き探索、建国者が王）
// POST { action: "join", nationId } : 参加（市民）
// POST { action: "leave" } : 離脱。王は国民がいる間は離脱できず、一人なら解散（建物も消える）
// POST { action: "build", type, x, y } : 自国の領地内に建築（家・畑・塔）
// POST { action: "demolish", x, y } : 自国の建物を取り壊す（王・大臣のみ）
// 保存先は bot_kv（名前空間 worldbox_nations の "nations" / "members" / "buildings"）。
// Bot API 未設定なら 503（クライアントは国家なしで遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** 入力起因のエラーは 400、状態競合は 409、権限不足は 403 に寄せる。 */
const BAD_REQUEST_ERRORS = new Set(["invalid_name", "invalid_action", "invalid_request", "invalid_type"]);

function errorStatus(error: string): number {
  if (error === "forbidden") return 403;
  return BAD_REQUEST_ERRORS.has(error) ? 400 : 409;
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

export async function GET(request: Request) {
  if (!isNationsEnabled()) {
    return NextResponse.json({ error: "nations_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  const state = await loadNationsState();
  const buildings = await loadBuildings(state);
  const selfKey = session ? sessionOwnerKey(session) : null;
  return NextResponse.json(buildNationsResponse(state, selfKey, buildings), { headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isNationsEnabled()) {
    return NextResponse.json({ error: "nations_unavailable" }, { status: 503, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const action = (body as { action?: unknown } | null)?.action;
  const ownerKey = sessionOwnerKey(session);
  const state = await loadNationsState();
  const fields = body as { name?: unknown; nationId?: unknown; type?: unknown; x?: unknown; y?: unknown };

  // 建築・取り壊しは建物マップだけを書き換える。
  if (action === "build" || action === "demolish") {
    const buildings = await loadBuildings(state);
    const result: BuildResult = action === "build"
      ? applyBuild(state, buildings, ownerKey, generateMap(), fields.type, fields.x, fields.y, Date.now())
      : applyDemolish(state, buildings, ownerKey, fields.x, fields.y);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: errorStatus(result.error), headers: NO_STORE });
    }
    const stored = await storeBuildings(result.buildings);
    if (!stored) {
      return NextResponse.json({ error: "nations_failed" }, { status: 500, headers: NO_STORE });
    }
    return NextResponse.json(
      { ok: true, buildings: buildingViews(result.buildings) },
      { headers: NO_STORE },
    );
  }

  let result: NationActionResult;
  if (action === "found") {
    result = applyFound(state, ownerKey, fields.name, generateMap(), Date.now());
  } else if (action === "join") {
    result = applyJoin(state, ownerKey, fields.nationId);
  } else if (action === "leave") {
    result = applyLeave(state, ownerKey);
  } else {
    return NextResponse.json({ error: "invalid_action" }, { status: 400, headers: NO_STORE });
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: errorStatus(result.error), headers: NO_STORE });
  }
  const stored = await storeNationsState(result.state);
  if (!stored) {
    return NextResponse.json({ error: "nations_failed" }, { status: 500, headers: NO_STORE });
  }
  // 解散したらその国の建物も消す。
  let buildings = await loadBuildings(state);
  if (result.disbanded) {
    const mine = state.members[ownerKey];
    if (mine) {
      buildings = removeNationBuildings(buildings, mine.nationId);
      await storeBuildings(buildings);
    }
  }
  const view = result.nation ? nationViews(result.state, buildings).find((v) => v.id === result.nation!.id) ?? null : null;
  return NextResponse.json(
    {
      ok: true,
      me: buildNationsResponse(result.state, ownerKey, buildings).me,
      nation: view,
      disbanded: result.disbanded ?? false,
    },
    { headers: NO_STORE },
  );
}
