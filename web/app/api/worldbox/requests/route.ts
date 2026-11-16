import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import type { CoinMovement } from "@/lib/worldbox/economy";
import { buildEconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  enqueueEconomyOpOnce, findEconomyOp, isEconomyEnabled, readUserBalance, waitForOpDone,
} from "@/lib/worldbox/economy-bridge-online";
import { withUserLock } from "@/lib/worldbox/user-lock";
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

/**
 * coin をブリッジのオプとして積む。積めたら true。
 * オプ ID は依頼 ID から決定的に導く（escrow-/reward-/refund-<依頼ID>）+
 * 冪等登録（enqueueEconomyOpOnce）: 依頼1件につき各オプは最大1件しか
 * 積まれず、再試行や並行リクエストで預かり・報酬・返金が二重に
 * 動くことはない（カジノの精算オプと同じ規則、PR #943）。
 */
/**
 * 預かり（escrow）オプの状態。報酬・返金は escrow が done のときだけ動かす
 * （カジノ・アリーナの「先払い done ゲート」と同じ規則）。
 * これが無いと、投稿直後に残高を抜いて escrow を failed にしたうえで
 * 取消/納品すると、預けていない金の返金・報酬がプールから出てしまう。
 * pending の間はクライアントに待たせ、failed の依頼は返金なしで
 * 取り消すだけにする（納品は不可）。
 */
async function escrowStatus(posterKey: string, requestId: string): Promise<"done" | "pending" | "failed"> {
  const op = await findEconomyOp(posterKey, `escrow-${requestId}`);
  if (!op) return "failed";
  return op.status;
}

async function enqueueCoin(ownerKey: string, discordId: string, coin: CoinMovement, opId: string): Promise<boolean> {
  const op = buildEconomyOp(
    { kind: coin.kind, userKey: ownerKey, discordId, amount: coin.amount, reason: coin.reason },
    opId,
    Date.now(),
  );
  if (!op) return false;
  return enqueueEconomyOpOnce(op);
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
  // 依頼の状態は全ユーザー共有の1ドキュメント（read-modify-write）。
  // 投稿者と納品者が別人同士でも競合するため、ユーザー単位でなく
  // 依頼全体を固定キーで直列化する（カジノ #943 と同型の対策）。
  // これがないと 納品×2 や 納品×取消 が同時に通って報酬と返金が
  // 両方払われうる。決定的なオプ ID と合わせて二重払いを防ぐ。
  return withUserLock("worldbox:requests", () => handlePost(request, session));
}

type AuthedSession = NonNullable<ReturnType<typeof getRequestSession>>;

async function handlePost(request: Request, session: AuthedSession) {
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
      const requestId = crypto.randomUUID();
      const result = postRequest(state, {
        id: requestId,
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
      if (!(await enqueueCoin(ownerKey, discordId, result.coin, `escrow-${requestId}`))) {
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
      const esc = await escrowStatus(target.posterKey, data.requestId);
      if (esc === "pending") return errorResponse("escrow_pending");
      if (esc === "failed") return errorResponse("escrow_failed");
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
      if (!(await enqueueCoin(ownerKey, discordId, result.coin, `reward-${data.requestId}`))) {
        await storeProfile(ownerKey, fulfillerProfile);
        await storeProfile(result.request.posterKey, posterProfile);
        await storeRequestsState(state);
        return statusError("economy_failed", 503);
      }
      // 報酬の決済が server-side wait のうちに failed になったら納品
      // 自体を巻き戻す（構造問題#4と同型: アイテムだけ渡って報酬が出ない
      // 状態を作らない）。pending のままなら従来どおり返し、クライアントの
      // ポーリングに引き継ぐ。
      const settled = await waitForOpDone(ownerKey, `reward-${data.requestId}`);
      if (settled && settled.status === "failed") {
        await storeProfile(ownerKey, fulfillerProfile);
        await storeProfile(result.request.posterKey, posterProfile);
        await storeRequestsState(state);
        return NextResponse.json(
          { error: "economy_failed", opError: settled.error ?? null },
          { status: 409, headers: NO_STORE },
        );
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
      // 取消も escrow の確定が前提: pending は待たせ、failed（残高不足で
      // 預かれなかった）依頼は返金オプなしで取り消す。
      const esc = await escrowStatus(ownerKey, data.requestId);
      if (esc === "pending") return errorResponse("escrow_pending");
      if (!(await storeRequestsState(result.state))) return statusError("store_failed", 503);
      if (esc === "done") {
        if (!(await enqueueCoin(ownerKey, discordId, result.coin, `refund-${data.requestId}`))) {
          await storeRequestsState(state);
          return statusError("economy_failed", 503);
        }
        // 返金の決済が failed なら取消自体を巻き戻す（預かり金が戻らない
        // まま依頼だけ消える状態を作らない）。
        const refundSettled = await waitForOpDone(ownerKey, `refund-${data.requestId}`);
        if (refundSettled && refundSettled.status === "failed") {
          await storeRequestsState(state);
          return NextResponse.json(
            { error: "economy_failed", opError: refundSettled.error ?? null },
            { status: 409, headers: NO_STORE },
          );
        }
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
