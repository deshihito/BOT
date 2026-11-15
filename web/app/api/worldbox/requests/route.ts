import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import type { CoinMovement } from "@/lib/worldbox/economy";
import { buildEconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  enqueueEconomyOp, isEconomyEnabled, readUserBalance,
} from "@/lib/worldbox/economy-bridge-online";
import { loadNationsState } from "@/lib/worldbox/nations-online";
import { isProfileEnabled, loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import {
  cancelRequest, fulfillRequest, postRequest, requestsForGuild,
} from "@/lib/worldbox/requests";
import { isRequestsEnabled, loadRequestsState, storeRequestsState } from "@/lib/worldbox/requests-online";
import { loadMyLobbyStation } from "@/lib/worldbox/station-online";

export const runtime = "nodejs";

// AGO WORLD BOX のギルド依頼（ロビーのギルドボード）。
// 依頼はユニオン（国 = Discord サーバー）単位: 投稿・納品・取消の規則は
// lib/worldbox/requests、保存は bot_kv（名前空間 worldbox_requests）。
// コインの正は AGO コイン本体: 投稿時の預かりは spend オプ、納品の報酬と
// 取消の返金は earn オプとして経済ブリッジへ積むだけ（案B）。
// GET: { loggedIn, me: { guildId, guildName, role } | null, requests }
// POST { action: "post", itemId, count, reward }: 依頼を出す（預かり金を spend）
// POST { action: "fulfill", requestId }: 所持アイテムを納品して報酬を受け取る
// POST { action: "cancel", requestId }: 自分の依頼を取り消す（預かり金を返金）
// Bot API 未設定なら 503（GET は空で返す）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

const BAD_REQUEST_ERRORS = new Set([
  "invalid_request", "invalid_action", "unknown_item", "invalid_count", "invalid_reward",
]);
const FORBIDDEN_ERRORS = new Set(["not_poster", "wrong_guild", "self_fulfill"]);

function errorResponse(error: string) {
  const status = BAD_REQUEST_ERRORS.has(error) ? 400 : FORBIDDEN_ERRORS.has(error) ? 403 : 409;
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function statusError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

/** 自分の依頼かどうかを付けた一覧ビュー。 */
function view(state: Parameters<typeof requestsForGuild>[0], guildId: string, ownerKey: string) {
  return requestsForGuild(state, guildId).map((r) => ({ ...r, mine: r.posterKey === ownerKey }));
}

/** coin をブリッジのオプとして積む。積めたら true。 */
async function enqueueCoin(ownerKey: string, discordId: string, coin: CoinMovement): Promise<boolean> {
  const op = buildEconomyOp(
    { kind: coin.kind, userKey: ownerKey, discordId, amount: coin.amount, reason: coin.reason },
    crypto.randomUUID(),
    Date.now(),
  );
  if (!op) return false;
  return enqueueEconomyOp(op);
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session || !isRequestsEnabled()) {
    return NextResponse.json(
      { loggedIn: false, me: null, requests: [] },
      { headers: NO_STORE },
    );
  }
  const ownerKey = sessionOwnerKey(session);
  const [nations, state] = await Promise.all([loadNationsState(), loadRequestsState()]);
  const mine = nations.members[ownerKey];
  if (!mine) {
    return NextResponse.json(
      { loggedIn: true, me: null, requests: [] },
      { headers: NO_STORE },
    );
  }
  const nation = nations.nations[mine.nationId];
  return NextResponse.json(
    {
      loggedIn: true,
      me: {
        guildId: mine.nationId,
        guildName: nation?.name ?? "",
        role: mine.role,
      },
      requests: view(state, mine.nationId, ownerKey),
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return statusError("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return statusError("unauthorized", 401);
  if (session.provider !== "discord") return statusError("discord_required", 403);
  if (!isRequestsEnabled() || !isProfileEnabled()) return statusError("requests_unavailable", 503);
  if (!isEconomyEnabled()) return statusError("economy_unavailable", 503);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return statusError("invalid_request", 400);
  }
  const data = (body ?? {}) as {
    action?: unknown; itemId?: unknown; count?: unknown; reward?: unknown; requestId?: unknown;
  };
  const ownerKey = sessionOwnerKey(session);
  const discordId = session.id;

  const nations = await loadNationsState();
  const mine = nations.members[ownerKey];
  if (!mine) return errorResponse("not_in_nation");
  const guildId = mine.nationId;
  // 場所制約: 依頼の操作はギルドボードの前でのみ（場所検証の共通方式）
  if ((await loadMyLobbyStation(ownerKey)) !== "guild") {
    return errorResponse("not_at_guild_board");
  }

  const state = await loadRequestsState();

  switch (data.action) {
    case "post": {
      const balance = await readUserBalance(discordId);
      if (balance === null) return statusError("economy_unavailable", 503);
      const result = postRequest(state, {
        id: crypto.randomUUID(),
        guildId,
        posterKey: ownerKey,
        posterName: session.username,
        itemId: data.itemId,
        count: data.count,
        reward: data.reward,
        now: Date.now(),
      }, balance);
      if (!result.ok) return errorResponse(result.error);
      if (!(await storeRequestsState(result.state))) return statusError("store_failed", 503);
      if (!(await enqueueCoin(ownerKey, discordId, result.coin))) {
        await storeRequestsState(state);
        return statusError("economy_failed", 503);
      }
      return NextResponse.json(
        { requests: view(result.state, guildId, ownerKey), request: result.request },
        { headers: NO_STORE },
      );
    }
    case "fulfill": {
      if (typeof data.requestId !== "string") return statusError("invalid_request", 400);
      const target = state.requests[data.requestId];
      if (!target) return errorResponse("not_found");
      const [fulfillerProfile, posterProfile] = await Promise.all([
        loadProfile(ownerKey),
        loadProfile(target.posterKey),
      ]);
      const result = fulfillRequest(
        state, data.requestId, guildId, ownerKey, fulfillerProfile, posterProfile,
      );
      if (!result.ok) return errorResponse(result.error);
      if (!(await storeProfile(ownerKey, result.fulfillerProfile))) {
        return statusError("store_failed", 503);
      }
      if (!(await storeProfile(result.request.posterKey, result.posterProfile))) {
        await storeProfile(ownerKey, fulfillerProfile);
        return statusError("store_failed", 503);
      }
      if (!(await storeRequestsState(result.state))) {
        await storeProfile(ownerKey, fulfillerProfile);
        await storeProfile(result.request.posterKey, posterProfile);
        return statusError("store_failed", 503);
      }
      if (!(await enqueueCoin(ownerKey, discordId, result.coin))) {
        await storeProfile(ownerKey, fulfillerProfile);
        await storeProfile(result.request.posterKey, posterProfile);
        await storeRequestsState(state);
        return statusError("economy_failed", 503);
      }
      return NextResponse.json(
        {
          requests: view(result.state, guildId, ownerKey),
          profile: result.fulfillerProfile,
          request: result.request,
        },
        { headers: NO_STORE },
      );
    }
    case "cancel": {
      if (typeof data.requestId !== "string") return statusError("invalid_request", 400);
      const result = cancelRequest(state, data.requestId, ownerKey);
      if (!result.ok) return errorResponse(result.error);
      if (!(await storeRequestsState(result.state))) return statusError("store_failed", 503);
      if (!(await enqueueCoin(ownerKey, discordId, result.coin))) {
        await storeRequestsState(state);
        return statusError("economy_failed", 503);
      }
      return NextResponse.json(
        { requests: view(result.state, guildId, ownerKey) },
        { headers: NO_STORE },
      );
    }
    default:
      return statusError("invalid_action", 400);
  }
}
