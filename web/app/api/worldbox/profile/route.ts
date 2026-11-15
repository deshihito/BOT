import { addMasteryXp } from "@/lib/worldbox/roles";
import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import {
  buyItem, craftItem, eatItem, sellItem,
  type CoinMovement, type EconomyError,
} from "@/lib/worldbox/economy";
import { buildEconomyOp, type EconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  enqueueEconomyOp, isEconomyEnabled, readUserBalance,
} from "@/lib/worldbox/economy-bridge-online";
import { moveSlot, swapSlots, type PlayerProfile } from "@/lib/worldbox/profile";
import { itemById } from "@/lib/worldbox/items";
import { findPresenceOwnerKey, isPresenceEnabled } from "@/lib/worldbox/presence-online";
import { checkBuyGenre, checkBuySold, checkDailyStock, dailyPriceFor, shopDayKeyOf } from "@/lib/worldbox/shops";
import { loadMyLobbyShopGenre, loadMyLobbyStation } from "@/lib/worldbox/station-online";
import { isProfileEnabled, loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { withUserLock } from "@/lib/worldbox/user-lock";

export const runtime = "nodejs";

// AGO WORLD BOX の経済（プロフィール＋かばん＋ショップ＋合成。steal・労働は廃止済み）。
// 状態遷移の規則は lib/worldbox/economy（ボット側経済機能の写し）。
// コインの正は AGO コイン本体: このルートは残高を書き換えず、遷移が
// 返した coin を経済ブリッジ（bot_kv worldbox_economy）のオプとして
// 積むだけ（案B）。実際の移動は Bot 本体のワーカーが適用する。
// GET: 自分のプロフィール
// POST { action: "buy" | "sell", itemId, count? }: ショップ売買
//   （場所制約: ロビーの店か鍛冶屋の前にいること。サーバー側でプレゼンス検証。
//    購入は店ごとの品目ジャンルもサーバー側で検証する）
// POST { action: "eat", itemId }: かばんの食事を食べて空腹度を回復
// POST { action: "craft", recipeId }: 合成
//   （場所制約: ロビー鍛冶屋の作業台の前にいること。サーバー側で検証）
// POST { action: "work" }: 労働は廃止（2026-11-16）。常に拒否する
// POST { action: "steal", targetId }: steal は一旦廃止（2026-11-16）。常に拒否する
// プロフィールの保存先は bot_kv（名前空間 worldbox_profiles、
// キー = 所有者キー）。コインが動くアクションは Discord ログイン必須。
// Bot API 未設定なら 503。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

const BAD_REQUEST_ERRORS = new Set(["invalid_request", "invalid_action", "unknown_item", "unknown_recipe", "invalid_count", "self_target"]);

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function errorResponse(error: string) {
  const status = BAD_REQUEST_ERRORS.has(error) ? 400 : 409;
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function statusError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/** コインの本人キーは Discord ユーザーID。Discord セッション以外は null。 */
function discordIdOf(session: { provider: string; id: string }): string | null {
  return session.provider === "discord" ? session.id : null;
}

/** coin をブリッジのオプとして積む。積めたら true。 */
async function enqueueCoin(
  ownerKey: string,
  discordId: string,
  coin: CoinMovement,
): Promise<boolean> {
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
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isProfileEnabled()) {
    return NextResponse.json({ error: "profile_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const profile = await loadProfile(sessionOwnerKey(session));
  return NextResponse.json({ profile, loggedIn: true }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isProfileEnabled()) {
    return NextResponse.json({ error: "profile_unavailable" }, { status: 503, headers: NO_STORE });
  }
  // 同一ユーザーのリクエストを直列化する（カジノ #943 と同型の対策）。
  // プロフィールの read-modify-write とコインオプの登録が並行すると、
  // 同じ所持品の二重売却（earn 2件 = コイン生成）や二重購入
  // （spend 2件・アイテムは1つ）が起きうる。
  return withUserLock(sessionOwnerKey(session), () => handlePost(request, session));
}

type AuthedSession = NonNullable<ReturnType<typeof getRequestSession>>;

async function handlePost(request: Request, session: AuthedSession) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const data = (body ?? {}) as {
    action?: unknown; itemId?: unknown; count?: unknown; recipeId?: unknown; targetId?: unknown;
    hotbarIndex?: unknown; storageIndex?: unknown; from?: unknown; to?: unknown;
  };
  const ownerKey = sessionOwnerKey(session);
  const current = await loadProfile(ownerKey);

  const saveAndReturn = async (
    result: { ok: true; profile: PlayerProfile } | { ok: false; error: EconomyError },
    extra: Record<string, unknown> = {},
  ) => {
    if (!result.ok) return errorResponse(result.error);
    if (!(await storeProfile(ownerKey, result.profile))) {
      return NextResponse.json({ error: "store_failed" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ profile: result.profile, ...extra }, { headers: NO_STORE });
  };

  /**
   * コインが動く遷移の保存: プロフィールを先に保存し、続けてオプを積む。
   * オプを積めなければプロフィールを元へ戻して 503（コインだけ動いて
   * アイテムが付かない／その逆の事故を避ける）。
   */
  const saveWithCoin = async (
    result:
      | { ok: true; profile: PlayerProfile; coin?: CoinMovement }
      | { ok: false; error: EconomyError },
    discordId: string,
    extra: Record<string, unknown> = {},
  ) => {
    if (!result.ok) return errorResponse(result.error);
    if (!(await storeProfile(ownerKey, result.profile))) {
      return NextResponse.json({ error: "store_failed" }, { status: 503, headers: NO_STORE });
    }
    if (result.coin && !(await enqueueCoin(ownerKey, discordId, result.coin))) {
      await storeProfile(ownerKey, current);
      return statusError("economy_failed", 503);
    }
    return NextResponse.json({ profile: result.profile, ...extra }, { headers: NO_STORE });
  };

  /** コインが動くアクションの前段: Discord セッションとブリッジ有効性。 */
  const coinGate = (): { discordId: string } | { response: NextResponse } => {
    const discordId = discordIdOf(session);
    if (!discordId) return { response: statusError("discord_required", 403) };
    if (!isEconomyEnabled()) return { response: statusError("economy_unavailable", 503) };
    return { discordId };
  };

  /** 場所制約の検証: 本人がロビーの対象ステーションの前にいなければ 409。 */
  const stationGate = async (station: string, error: string) => {
    return (await loadMyLobbyStation(ownerKey)) === station ? null : statusError(error, 409);
  };

  /** 売買の場所制約: 店（shop）か鍛冶屋（smith）の前にいなければ 409。 */
  const shopGate = async () => {
    const station = await loadMyLobbyStation(ownerKey);
    return station === "shop" || station === "smith" ? null : statusError("not_at_shop", 409);
  };

  switch (data.action) {
    case "buy": {
      const gate = coinGate();
      if ("response" in gate) return gate.response;
      const place = await shopGate();
      if (place) return place;
      // 品目は店ごとに違う: いる店のジャンルと買うアイテムのジャンルが
      // 一致しなければ買えない（鍛冶屋はジャンル "smith"）
      const myGenre = await loadMyLobbyShopGenre(ownerKey);
      const genreError = checkBuyGenre(myGenre, data.itemId);
      if (genreError) return statusError(genreError, 409);
      // レア品（特殊・ミスリル tier4・宝石ブロック）はどの店でも売っていない
      const soldError = checkBuySold(data.itemId);
      if (soldError) return statusError(soldError, 409);
      // 日次ローテーション: その日の品目に無いものは買えない（価格も日次）
      const dayKey = shopDayKeyOf(Date.now());
      const dailyError = checkDailyStock(myGenre, data.itemId, dayKey);
      if (dailyError) return statusError(dailyError, 409);
      const balance = await readUserBalance(gate.discordId);
      if (balance === null) return statusError("economy_unavailable", 503);
      const itemDef = itemById(data.itemId as string);
      const unitPrice = myGenre && itemDef ? dailyPriceFor(itemDef, dayKey) : undefined;
      return saveWithCoin(buyItem(current, data.itemId, data.count, balance, unitPrice), gate.discordId);
    }
    case "sell": {
      const gate = coinGate();
      if ("response" in gate) return gate.response;
      const place = await shopGate();
      if (place) return place;
      return saveWithCoin(sellItem(current, data.itemId, data.count), gate.discordId);
    }
    case "swap": {
      // ホットバー⇔ストレージの枠入れ替え（コインは動かない）
      const swapped = swapSlots(current, data.hotbarIndex, data.storageIndex);
      if (!swapped) return errorResponse("invalid_action");
      return saveAndReturn({ ok: true, profile: swapped });
    }
    case "move": {
      // 任意スロット間の移動・合算・入れ替え（インベントリ整理。コインは動かない）
      const movedProfile = moveSlot(current, data.from, data.to);
      if (!movedProfile) return errorResponse("invalid_action");
      return saveAndReturn({ ok: true, profile: movedProfile });
    }
    case "eat": {
      const result = eatItem(current, data.itemId);
      if (result.ok && current.role === "medic" && result.item.heal) {
        const withXp = { ...result, profile: addMasteryXp(result.profile, "medic", 2).profile };
        return saveAndReturn(withXp, { itemName: result.item.name });
      }
      return saveAndReturn(result, result.ok ? { itemName: result.item.name } : {});
    }
    case "craft": {
      const place = await stationGate("smith", "not_at_workbench");
      if (place) return place;
      const result = craftItem(current, data.recipeId);
      return saveAndReturn(result, result.ok
        ? { craftedId: result.recipe.output, rareId: result.rare?.id ?? null }
        : {});
    }
    case "work": {
      // 労働は廃止（2026-11-16 ユーザー指示）。どの経路からも実行できない。
      return errorResponse("work_disabled");
    }
    case "steal": {
      // steal は一旦廃止（2026-11-16 ユーザー指示）。どの経路からも実行できない。
      return errorResponse("steal_disabled");
    }
    default:
      return NextResponse.json({ error: "invalid_action" }, { status: 400, headers: NO_STORE });
  }
}
