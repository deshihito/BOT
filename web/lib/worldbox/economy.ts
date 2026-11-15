// AGO WORLD BOX の経済の状態遷移（純粋ロジック）。
// Discord ボット側の経済機能（アイテム売買・合成・steal・労働）の規則を
// ワールドボックス向けに写したもの。保存は呼び出し側（API ルート）が行う。
//
// コインの正は AGO コイン本体（案B ブリッジ）: このモジュールは
// プロフィールの coins を読み書きしない。コインが動く遷移は、動かすべき
// 額を `coin`（spend / earn オプの材料）として返し、API ルートが
// economy-bridge 経由で Bot 本体へ依頼する。残高の検証は、ルートが
// 読み取った実残高を引数で渡す。
import {
  STEAL_ACTOR_COOLDOWN_SECONDS, STEAL_BALANCE_RATE, STEAL_FINE_AMOUNT,
  STEAL_MAX_AMOUNT, STEAL_SUCCESS_RATE, STEAL_TARGET_COOLDOWN_SECONDS,
  STEAL_TARGET_MIN_COINS, THIEF_MASK_BONUS, WORK_HUNGER_COST, WORK_REWARD_COINS,
  itemById, recipeById, sellPrice, type ItemDef, type Recipe,
} from "./items";
import {
  HP_MAX, HUNGER_MAX, addItem, countItem, removeItem, type PlayerProfile,
} from "./profile";

export type EconomyError =
  | "unknown_item" | "unknown_recipe" | "not_enough_coins" | "not_enough_items"
  | "hunger_full" | "too_tired" | "invalid_count"
  | "steal_cooldown" | "target_protected" | "target_recently_stolen" | "self_target";

/** 遷移に伴うコインの移動（ブリッジのオプとして積む材料）。 */
export type CoinMovement =
  | { kind: "spend"; amount: number; reason: string }
  | { kind: "earn"; amount: number; reason: string };

export type Transition<T extends object = object> =
  | ({ ok: true; profile: PlayerProfile; coin?: CoinMovement } & T)
  | { ok: false; error: EconomyError };

function clampCount(v: unknown): number | null {
  if (v === undefined) return 1;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  return n >= 1 && n <= 99 ? n : null;
}

/** ショップで買う（かばんに入る）。残高は実残高（引数）を検証する。 */
export function buyItem(
  profile: PlayerProfile,
  itemId: unknown,
  countRaw: unknown,
  balance: number,
): Transition {
  const item = itemById(itemId);
  if (!item) return { ok: false, error: "unknown_item" };
  const count = clampCount(countRaw);
  if (count === null) return { ok: false, error: "invalid_count" };
  const cost = item.price * count;
  if (balance < cost) return { ok: false, error: "not_enough_coins" };
  return {
    ok: true,
    profile: addItem(profile, item.id, count),
    coin: { kind: "spend", amount: cost, reason: "shop_buy" },
  };
}

/** かばんのアイテムを売る（対価は earn オプ。pay_house の上限で減ることがある）。 */
export function sellItem(profile: PlayerProfile, itemId: unknown, countRaw?: unknown): Transition {
  const item = itemById(itemId);
  if (!item) return { ok: false, error: "unknown_item" };
  const count = clampCount(countRaw);
  if (count === null) return { ok: false, error: "invalid_count" };
  const removed = removeItem(profile, item.id, count);
  if (!removed) return { ok: false, error: "not_enough_items" };
  return {
    ok: true,
    profile: removed,
    coin: { kind: "earn", amount: sellPrice(item) * count, reason: "shop_sale" },
  };
}

/** かばんの食事・飲み物を消費して空腹度を回復する。 */
export function eatItem(profile: PlayerProfile, itemId: unknown): Transition<{ item: ItemDef }> {
  const item = itemById(itemId);
  if (!item || (!item.hunger && !item.heal && !item.curePoison)) return { ok: false, error: "unknown_item" };
  const poisoned = Array.isArray(profile.status) && profile.status.some((e) => e.kind === "poison");
  if (
    profile.hunger >= HUNGER_MAX
    && (!item.heal || (typeof profile.hp === "number" ? profile.hp : HP_MAX) >= HP_MAX)
    && (!item.curePoison || !poisoned)
  ) {
    return { ok: false, error: "hunger_full" };
  }
  const removed = removeItem(profile, item.id, 1);
  if (!removed) return { ok: false, error: "not_enough_items" };
  return {
    ok: true,
    item,
    profile: {
      ...removed,
      hunger: Math.min(HUNGER_MAX, removed.hunger + (item.hunger ?? 0)),
      hp: Math.min(HP_MAX, (typeof removed.hp === "number" ? removed.hp : HP_MAX) + (item.heal ?? 0)),
      status: item.curePoison && Array.isArray(removed.status) ? removed.status.filter((e) => e.kind !== "poison") : removed.status,
    },
  };
}

/** 労働する（空腹度を消費する。報酬は earn オプ）。 */
export function doWork(profile: PlayerProfile): Transition {
  if (profile.hunger < WORK_HUNGER_COST) return { ok: false, error: "too_tired" };
  return {
    ok: true,
    profile: { ...profile, hunger: profile.hunger - WORK_HUNGER_COST },
    coin: { kind: "earn", amount: WORK_REWARD_COINS, reason: "work" },
  };
}

/** 合成する（素材を消費して成果物を得る。レア結果つき）。
 * レシピにコインコストは無い（items.ts の Recipe は素材のみ）ため、
 * コインは動かない。 */
export function craftItem(
  profile: PlayerProfile,
  recipeId: unknown,
  rng: () => number = Math.random,
): Transition<{ recipe: Recipe; rare: ItemDef | null }> {
  const recipe = recipeById(recipeId);
  if (!recipe) return { ok: false, error: "unknown_recipe" };
  let next = profile;
  for (const [inputId, need] of Object.entries(recipe.inputs)) {
    const removed = removeItem(next, inputId, need);
    if (!removed) return { ok: false, error: "not_enough_items" };
    next = removed;
  }
  next = addItem(next, recipe.output, recipe.outputCount);
  let rare: ItemDef | null = null;
  if (recipe.rareItem && recipe.rareChance && rng() < recipe.rareChance) {
    rare = itemById(recipe.rareItem);
    if (rare) next = addItem(next, rare.id, 1);
  }
  return { ok: true, recipe, rare, profile: next };
}

// ---------------------------------------------------------------- steal
export type StealOutcome =
  | {
      ok: true;
      success: boolean;
      /** 成功時は奪う額、失敗時は罰金の額。 */
      amount: number;
      actor: PlayerProfile;
      target: PlayerProfile;
      /** 失敗時の罰金（spend オプ）。成功時・罰金0のときは undefined で、
       * 成功時の移動はルートが steal オプとして別途積む。 */
      coin?: CoinMovement;
    }
  | { ok: false; error: EconomyError };

/** steal の検証に使う両者の実残高（ルートが users から読み取って渡す）。 */
export interface StealBalances {
  actorCoins: number;
  targetCoins: number;
}

/**
 * steal の解決（ボット側 circulation/steal と同じ規則）。
 * - 実行者はクールダウン中は実行できない
 * - 対象は実残高が下限未満なら保護、防犯チャーム所持でも保護、
 *   直近に盗まれたばかりでも保護
 * - 成功: 対象の実残高の割合（上限つき）を奪う（移動は steal オプ）
 * - 失敗: 実行者が罰金を払う（spend オプ。自分の実残高が上限）
 * プロフィール側で変わるのはクールダウン時刻だけで、コインは触らない。
 */
export function resolveSteal(
  actor: PlayerProfile,
  target: PlayerProfile,
  now: number,
  rng: () => number = Math.random,
  balances: StealBalances = { actorCoins: 0, targetCoins: 0 },
): StealOutcome {
  if (now - actor.stealActorAt < STEAL_ACTOR_COOLDOWN_SECONDS * 1000) {
    return { ok: false, error: "steal_cooldown" };
  }
  if (balances.targetCoins < STEAL_TARGET_MIN_COINS || countItem(target, "guard_charm") > 0) {
    return { ok: false, error: "target_protected" };
  }
  if (now - target.stealTargetAt < STEAL_TARGET_COOLDOWN_SECONDS * 1000) {
    return { ok: false, error: "target_recently_stolen" };
  }
  const rate = STEAL_SUCCESS_RATE + (countItem(actor, "thief_mask") > 0 ? THIEF_MASK_BONUS : 0);
  const stampedActor = { ...actor, stealActorAt: now };
  const stampedTarget = { ...target, stealTargetAt: now };
  if (rng() < rate) {
    const amount = Math.max(1, Math.min(STEAL_MAX_AMOUNT, Math.floor(balances.targetCoins * STEAL_BALANCE_RATE)));
    return { ok: true, success: true, amount, actor: stampedActor, target: stampedTarget };
  }
  const fine = Math.min(STEAL_FINE_AMOUNT, balances.actorCoins);
  return {
    ok: true,
    success: false,
    amount: fine,
    actor: stampedActor,
    target: stampedTarget,
    ...(fine > 0 ? { coin: { kind: "spend", amount: fine, reason: "steal_fine" } as CoinMovement } : {}),
  };
}
