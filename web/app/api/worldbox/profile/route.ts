import { addMasteryXp } from "@/lib/worldbox/roles";
import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import {
  buyItem, craftFromInputs, craftItem, eatItem, sellItem,
  type CoinMovement, type EconomyError,
} from "@/lib/worldbox/economy";
import { buildEconomyOp, type EconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  deleteEconomyOp, deleteEconomyOpLedger, findEconomyOp, isEconomyEnabled, readUserBalance, submitEconomyOp, waitForOpDone,
} from "@/lib/worldbox/economy-bridge-online";
import { TENT_MAX_TIER, TENT_TIERS } from "@/lib/worldbox/tent";
import {
  countItem, ENHANCE_BASE_COST, ENHANCE_MATERIALS, ENHANCE_MAX_LEVEL, moveSlot, removeItem,
  swapSlots, type PlayerProfile,
} from "@/lib/worldbox/profile";
import { itemById, recipeById, recipeKind } from "@/lib/worldbox/items";
import { findPresenceOwnerKey, isPresenceEnabled } from "@/lib/worldbox/presence-online";
import { checkBuyGenre, checkBuySold, checkDailyStock, dailyPriceFor, shopDayKeyOf } from "@/lib/worldbox/shops";
import { loadMyLobbyShopGenre, loadMyLobbyStation, loadMyWorldStationKinds } from "@/lib/worldbox/station-online";
import type { StationKind } from "@/lib/worldbox/tiles";
import { isProfileEnabled, loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { withUserLock } from "@/lib/worldbox/user-lock";

export const runtime = "nodejs";

// AGO WORLD BOX の経済（プロフィール＋かばん＋ショップ＋合成。steal・労働は廃止済み）。
// 状態遷移の規則は lib/worldbox/economy（ボット側経済機能の写し）。
// コインの正は AGO コイン本体: 遷移が返した coin は経済ブリッジの
// オプとして submitEconomyOp へ渡す。spend は bot-api 経由でその場で
// 適用され、直接適用できない種別・環境では bot_kv のキュー経由で
// Bot 本体のワーカーが適用する（案B の冪等規則は両経路で共通）。
// GET: 自分のプロフィール
// POST { action: "buy" | "sell", itemId, count? }: ショップ売買
//   （場所制約: ロビーの店か鍛冶屋の前にいること。サーバー側でプレゼンス検証。
//    購入は店ごとの品目ジャンルもサーバー側で検証する）
// POST { action: "eat", itemId }: かばんの食事を食べて空腹度を回復
// POST { action: "craft", inputs }: 自由セット式の合成（PR-B。レシピは
//   サーバー側の照合表のみ。recipeId 形式も互換のため残す）
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

/** coin からブリッジのオプを組み立てる。提出は submitEconomyOp が行う。 */
function buildCoinOp(
  ownerKey: string,
  discordId: string,
  coin: CoinMovement,
): EconomyOp | null {
  return buildEconomyOp(
    { kind: coin.kind, userKey: ownerKey, discordId, amount: coin.amount, reason: coin.reason },
    crypto.randomUUID(),
    Date.now(),
  );
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
    inputs?: unknown;
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
   * 積んだオプが server-side wait のうちに failed になった場合も同じく
   * プロフィールを元へ戻して 409 を返す（構造問題#4「即時 spend の
   * 無担保交付」の是正: 交付だけ残してコインが動かない状態を作らない）。
   * wait を超えて pending のままの場合は従来どおり交付し、クライアントの
   * ポーリングに引き継ぐ（その後 failed になる窓は残る。将来の是正課題）。
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
    if (result.coin) {
      const op = buildCoinOp(ownerKey, discordId, result.coin);
      if (!op) {
        await storeProfile(ownerKey, current);
        return statusError("economy_failed", 503);
      }
      // 提出は直接適用が正（submitEconomyOp）: spend はその場で終端する。
      // 直接適用できずキューへ寄せた（pending）ときだけ、従来どおり
      // server-side wait で追い、終端していれば最終残高も同一レスポンス
      // で返す。予算を超えて pending のままなら従来どおり（残高は
      // クライアントの次の取得で反映される）。
      const submitted = await submitEconomyOp(op);
      if (submitted.state === "unavailable") {
        await storeProfile(ownerKey, current);
        return statusError("economy_failed", 503);
      }
      const settled = submitted.state === "pending" ? await waitForOpDone(ownerKey, op.id) : submitted.op;
      if (settled && settled.status === "failed") {
        await storeProfile(ownerKey, current);
        return NextResponse.json(
          { error: "economy_failed", opError: settled.error ?? null },
          { status: 409, headers: NO_STORE },
        );
      }
      if (settled && settled.status !== "pending") {
        const balance = await readUserBalance(discordId);
        return NextResponse.json(
          {
            profile: result.profile, ...extra, opStatus: settled.status,
            ...(balance !== null ? { balance } : {}),
          },
          { headers: NO_STORE },
        );
      }
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

  /** 作業場所の検証: ロビーの鍛冶屋は全種別可。ワールドでは設置した
   * 作業台・鍛冶台・金床・かまど・焚き火・調理鍋・織り機の近くでも可。 */
  const workGate = async (kind: StationKind) => {
    if ((await loadMyLobbyStation(ownerKey)) === "smith") return null;
    const kinds = await loadMyWorldStationKinds(ownerKey);
    return kinds.has(kind) ? null : statusError("not_at_workbench", 409);
  };

  /** 購入の場所制約: 店（shop）か鍛冶屋（smith）の前にいなければ 409。
   * 売却専用カウンター（sell）では買えない（売るだけの店）。 */
  const shopGate = async () => {
    const station = await loadMyLobbyStation(ownerKey);
    return station === "shop" || station === "smith" ? null : statusError("not_at_shop", 409);
  };

  /** 売却の場所制約: 店・鍛冶屋に加えて売却専用カウンター（sell）でも可。 */
  const sellGate = async () => {
    const station = await loadMyLobbyStation(ownerKey);
    return station === "shop" || station === "smith" || station === "sell"
      ? null
      : statusError("not_at_shop", 409);
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
      // ホワイトリスト外の品目はどの店でも売っていない
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
    case "expand_tent": {
      // テント（個人空間）の拡張: 次の段階の価格を spend し、段階を上げる。
      // オプ ID は決定的（tent-expand-<discordId>-<tier>）で二重課金しない。
      // 決済が failed なら段階は上げない（無担保交付にしない）。pending の
      // ままなら従来どおり上げてクライアントのポーリングに引き継ぐ。
      const gate = coinGate();
      if ("response" in gate) return gate.response;
      const nextTier = current.tentTier + 1;
      if (nextTier > TENT_MAX_TIER) return statusError("max_tier", 409);
      const price = TENT_TIERS[nextTier].price;
      const balance = await readUserBalance(gate.discordId);
      if (balance === null) return statusError("economy_unavailable", 503);
      if (balance < price) return statusError("insufficient_balance", 409);
      const opId = `tent-expand-${gate.discordId}-${nextTier}`;
      const existing = await findEconomyOp(ownerKey, opId);
      if (existing && existing.status === "failed") {
        // 前の試行の失敗オプが残っていると決定的 ID が塞がれて再試行できない。
        // 金は動いていない終端オプなので消してから積み直す。適用台帳の
        // failed も対で消す（台帳が残ると再提出が即 failed に戻る）。
        // 消せなくても下の判定が failed を見て 409 を返す（安全側）。
        await deleteEconomyOp(opId);
        await deleteEconomyOpLedger(opId);
      }
      const op = buildEconomyOp(
        { kind: "spend", userKey: ownerKey, discordId: gate.discordId, amount: price, reason: "tent_expand" },
        opId,
        Date.now(),
      );
      if (!op) return statusError("economy_failed", 503);
      const submitted = await submitEconomyOp(op);
      if (submitted.state === "unavailable") return statusError("economy_failed", 503);
      const settled = submitted.state === "pending" ? await waitForOpDone(ownerKey, op.id) : submitted.op;
      if (settled && settled.status === "failed") {
        return NextResponse.json(
          { error: "economy_failed", opError: settled.error ?? null },
          { status: 409, headers: NO_STORE },
        );
      }
      return saveAndReturn({ ok: true, profile: { ...current, tentTier: nextTier } });
    }
    case "sell": {
      const gate = coinGate();
      if ("response" in gate) return gate.response;
      const place = await sellGate();
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
    case "enhance": {
      // 道具強化: 鍛冶の前で、素材とコインを払って道具のレベルを上げる（最大3）。
      const gate = coinGate();
      if ("response" in gate) return gate.response;
      const place = await workGate("enhance");
      if (place) return place;
      const def = itemById(data.itemId as string);
      if (!def || !def.tool) return errorResponse("unknown_item");
      if ((current.items[def.id] ?? 0) <= 0) return errorResponse("not_enough_items");
      const level = current.enhance[def.id] ?? 0;
      if (level >= ENHANCE_MAX_LEVEL) return statusError("max_level", 409);
      const material = ENHANCE_MATERIALS[def.tier ?? 1] ?? ENHANCE_MATERIALS[1];
      if (countItem(current, material.itemId) < material.count) return errorResponse("not_enough_items");
      const cost = ENHANCE_BASE_COST * (level + 1);
      const balance = await readUserBalance(gate.discordId);
      if (balance === null) return statusError("economy_unavailable", 503);
      if (balance < cost) return statusError("insufficient_balance", 409);
      const removedMat = removeItem(current, material.itemId, material.count);
      if (!removedMat) return errorResponse("not_enough_items");
      return saveWithCoin(
        {
          ok: true,
          profile: { ...removedMat, enhance: { ...removedMat.enhance, [def.id]: level + 1 } },
          coin: { kind: "spend", amount: cost, reason: "tool_enhance" },
        },
        gate.discordId,
      );
    }
    case "craft": {
      // 種別ごとに場所が違う: 合成=作業台/鍛冶台、精錬=かまど、調理=焚き火/調理鍋、
      // 織り=織り機（いずれもロビーの鍛冶屋でも可）
      const recipe = recipeById(data.recipeId);
      const place = await workGate(recipe ? recipeKind(recipe) : "craft");
      if (place) return place;
      // 発見の記録: 完全一致で作れたレシピだけを本人の図鑑へ足す（重複なし）
      const withDiscovery = (profile: PlayerProfile, recipeId: string): PlayerProfile => {
        const found = profile.discoveredRecipes ?? [];
        return found.includes(recipeId)
          ? profile
          : { ...profile, discoveredRecipes: [...found, recipeId] };
      };
      if (data.inputs !== undefined && data.inputs !== null) {
        // 自由セット式（PR-B）: レシピ・確率・レア名は事前に返さず、
        // 結果（craftedId）と気配（hint）だけを返す
        const result = craftFromInputs(current, data.inputs);
        if (!result.ok) return saveAndReturn(result);
        const profile = result.matched && result.recipe
          ? withDiscovery(result.profile, result.recipe.id)
          : result.profile;
        return saveAndReturn({ ok: true, profile }, {
          craftedId: result.resultId,
          rareId: result.rare?.id ?? null,
          hint: result.hint,
          matched: result.matched,
        });
      }
      // recipeId 形式（従来呼び出しの互換）: 成功時は発見を記録し hint は exact
      const result = craftItem(current, data.recipeId);
      if (!result.ok) return saveAndReturn(result);
      return saveAndReturn(
        { ok: true, profile: withDiscovery(result.profile, result.recipe.id) },
        {
          craftedId: result.recipe.output,
          rareId: result.rare?.id ?? null,
          hint: "exact",
          matched: true,
        },
      );
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
