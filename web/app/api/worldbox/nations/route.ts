import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { worldTileSource } from "@/lib/worldbox/mapgen";
import {
  applyFound, applyJoin, applyLeave, buildNationsResponse, fastTravelDestination, nationViews,
  type MyGuildView, type NationActionResult, type NationsState,
} from "@/lib/worldbox/nations";
import { isNationsEnabled, loadNationsState, storeNationsState } from "@/lib/worldbox/nations-online";
import { loadBuildings } from "@/lib/worldbox/buildings-online";
import { parseSave, serializeSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave, storeWorldBoxSave } from "@/lib/worldbox/save-online";
import { putPresence } from "@/lib/worldbox/presence-online";
import { annotateMyGuilds, getUserGuilds, roleInGuild, type UserGuildsResult } from "@/lib/worldbox/guilds";

export const runtime = "nodejs";

// AGO WORLD BOX の国家レイヤー（国 = Discord サーバー、所属区分のみ。建築は buildings ルート）。
// GET: { nations, me, playerNations, loggedIn, myGuilds, guildsScopeRequired }
//   （誰でも読める。ゲストは国一覧のみ。ログイン中は自分の参加サーバー一覧に
//   国の有無と役職を付け、所属中の役職は Discord 権限から読み直して直す）
// POST { action: "found", guildId } : 建国（サーバーオーナーのみ。国名はサーバー名）
// POST { action: "join", guildId } : 参加（そのサーバーのメンバーのみ。役職は権限由来）
// POST { action: "leave" } : 離脱。王は国民がいる間は離脱できず、一人なら解散。
//   解散しても建物は個人所有なので残る。
// POST { action: "travel" } : 所属国のユニオンマーク（首都）へ移動する。
//   所属の検証はサーバー側で行い、移動はセーブとプレゼンスに反映する。
//   料金・クールダウンは当面なし（定数は nations.ts の FAST_TRAVEL_*）。
// 保存先は bot_kv（名前空間 worldbox_nations の "nations" / "members"）。
// 繁栄度の算出にだけ建物（同名前空間の "buildings"）を読み込む。
// Bot API 未設定なら 503（クライアントは国家なしで遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** 所有・所属の検証失敗は 403、入力起因は 400、それ以外（状態競合）は 409。 */
const FORBIDDEN_ERRORS = new Set(["not_owner", "not_member"]);
const BAD_REQUEST_ERRORS = new Set(["invalid_action", "invalid_request"]);

function errorStatus(error: string): number {
  if (FORBIDDEN_ERRORS.has(error)) return 403;
  return BAD_REQUEST_ERRORS.has(error) ? 400 : 409;
}

function errorResponse(error: string, status?: number) {
  return NextResponse.json({ error }, { status: status ?? errorStatus(error), headers: NO_STORE });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

/** ギルド検証が失敗したときの応答。トークン無しは 409 の専用コード、一時失敗は 503。 */
function guildsErrorResponse(result: Extract<UserGuildsResult, { ok: false }>) {
  if (result.error === "guilds_scope_required") return errorResponse("guilds_scope_required", 409);
  return errorResponse("guilds_unavailable", 503);
}

export async function GET(request: Request) {
  if (!isNationsEnabled()) {
    return NextResponse.json({ error: "nations_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  let state = await loadNationsState();
  const buildings = await loadBuildings();
  const selfKey = session ? sessionOwnerKey(session) : null;

  let myGuilds: MyGuildView[] = [];
  let guildsScopeRequired = false;
  if (session && selfKey) {
    const result = await getUserGuilds(session);
    if (result.ok) {
      myGuilds = annotateMyGuilds(result.guilds, state);
      // 役職は Discord 権限が正: 所属中なら読み直し、変わっていれば保存も直す
      const mine = state.members[selfKey];
      const myGuild = mine ? result.guilds.find((g) => g.id === mine.nationId) : undefined;
      if (mine && myGuild) {
        const role = roleInGuild(myGuild);
        if (role !== mine.role) {
          state = {
            ...state,
            members: { ...state.members, [selfKey]: { nationId: mine.nationId, role } },
          } satisfies NationsState;
          await storeNationsState(state);
          myGuilds = annotateMyGuilds(result.guilds, state);
        }
      }
    } else if (result.error === "guilds_scope_required") {
      guildsScopeRequired = true;
    }
  }
  return NextResponse.json(
    buildNationsResponse(state, selfKey, buildings, { myGuilds, guildsScopeRequired }),
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
  const fields = body as { guildId?: unknown };
  const state = await loadNationsState();

  if (action === "travel") {
    // 所属検証はサーバー側の状態が正。未所属は 409 not_in_nation。
    const dest = fastTravelDestination(state, ownerKey, worldTileSource());
    if (!dest.ok) return errorResponse(dest.error);
    // 移動をセーブ（ワールドのマーク位置）とプレゼンスに反映する。
    // どちらもベストエフォートで、応答の座標がクライアントの移動先になる。
    const prev = parseSave(await loadWorldBoxSave(ownerKey));
    await storeWorldBoxSave(
      ownerKey,
      serializeSave({ space: "world", x: dest.x, y: dest.y, worldReturn: prev?.worldReturn ?? null }),
    );
    await putPresence(
      ownerKey,
      {
        name: session.username?.trim() || "プレイヤー",
        x: dest.x, y: dest.y, vx: 0, vy: 0, face: 1, space: "world",
      },
      Date.now(),
    );
    return NextResponse.json(
      { ok: true, x: dest.x, y: dest.y, nationId: dest.nationId },
      { headers: NO_STORE },
    );
  }

  let result: NationActionResult;
  if (action === "found" || action === "join") {
    if (typeof fields.guildId !== "string" || !/^\d+$/.test(fields.guildId)) {
      return errorResponse("invalid_request");
    }
    const guilds = await getUserGuilds(session);
    if (!guilds.ok) return guildsErrorResponse(guilds);
    const guild = guilds.guilds.find((g) => g.id === fields.guildId);
    if (action === "found") {
      // 建国はサーバーのオーナーだけ。一覧に無いサーバーも所有を証明できない
      if (!guild || !guild.owner) return errorResponse("not_owner");
      // 国名はクライアントから受け取らない（サーバー名をそのまま使う）
      result = applyFound(state, ownerKey, guild, worldTileSource(), Date.now());
    } else {
      if (!guild) return errorResponse("not_member");
      result = applyJoin(state, ownerKey, fields.guildId, roleInGuild(guild));
    }
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
  const view = result.nation ? nationViews(result.state, buildings).find((v) => v.id === result.nation!.guildId) ?? null : null;
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
