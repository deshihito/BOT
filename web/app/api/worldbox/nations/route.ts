import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { generateMap } from "@/lib/worldbox/mapgen";
import {
  applyFound, applyJoin, applyLeave, buildNationsResponse, nationViews,
  type NationActionResult,
} from "@/lib/worldbox/nations";
import { isNationsEnabled, loadNationsState, storeNationsState } from "@/lib/worldbox/nations-online";
import { loadBuildings } from "@/lib/worldbox/buildings-online";

export const runtime = "nodejs";

// AGO WORLD BOX の国家レイヤー（国は所属区分のみ。建築は buildings ルート）。
// GET: { nations, me, playerNations, loggedIn }（誰でも読める。ゲストは閲覧のみ）
// POST { action: "found", name } : 建国（首都は中央から渦巻き探索、建国者が王）
// POST { action: "join", nationId } : 参加（市民）
// POST { action: "leave" } : 離脱。王は国民がいる間は離脱できず、一人なら解散。
//   解散しても建物は個人所有なので残る。
// 保存先は bot_kv（名前空間 worldbox_nations の "nations" / "members"）。
// 繁栄度の算出にだけ建物（同名前空間の "buildings"）を読み込む。
// Bot API 未設定なら 503（クライアントは国家なしで遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** 入力起因のエラーは 400、状態競合は 409 に寄せる。 */
const BAD_REQUEST_ERRORS = new Set(["invalid_name", "invalid_action", "invalid_request"]);

function errorStatus(error: string): number {
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
  const buildings = await loadBuildings();
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
  const fields = body as { name?: unknown; nationId?: unknown };

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
  const buildings = await loadBuildings();
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
