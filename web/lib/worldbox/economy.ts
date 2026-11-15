// AGO WORLD BOX の経済の状態遷移（純粋ロジック）。
// Discord ボット側の経済機能（アイテム売買・合成・steal・労働）の規則を
// ワールドボックス向けに写したもの。保存は呼び出し側（API ルート）が行う。
import {
  STEAL_ACTOR_COOLDOWN_SECONDS, STEAL_BALANCE_RATE, STEAL_FINE_AMOUNT,
  STEAL_MAX_AMOUNT, STEAL_SUCCESS_RATE, STEAL_TARGET_COOLDOWN_SECONDS,
  STEAL_TARGET_MIN_COINS, THIEF_MASK_BONUS, WORK_HUNGER_COST, WORK_REWARD_COINS,
  itemById, recipeById, sellPrice, type ItemDef, type Recipe,
} from "./items";
import {
  HUNGER_MAX, addItem, countItem, removeItem, type PlayerProfile,
} from "./profile";

export type EconomyError =
  | "unknown_item" | "unknown_recipe" | "not_enough_coins" | "not_enough_items"
  | "hunger_full" | "too_tired" | "invalid_count"
  | "steal_cooldown" | "target_protected" | "target_recently_stolen" | "self_target";

export type Transition<T extends object = object> =
  | ({ ok: true; profile: PlayerProfile } & T)
  | { ok: false; error: EconomyError };

function clampCount(v: unknown): number | null {
  if (v === undefined) return 1;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  return n >= 1 && n <= 99 ? n : null;
}

/** ショップで買う（かばんに入る）。 */
export function buyItem(profile: PlayerProfile, itemId: unknown, countRaw?: unknown): Transition {
  const item = itemById(itemId);
  if (!item) return { ok: false, error: "unknown_item" };
  const count = clampCount(countRaw);
  if (count === null) return { ok: false, error: "invalid_count" };
  const cost = item.price * count;
  if (profile.coins < cost) return { ok: false, error: "not_enough_coins" };
  return {
    ok: true,
    profile: addItem({ ...profile, coins: profile.coins - cost }, item.id, count),
  };
}

/** かばんのアイテムを売る。 */
export function sellItem(profile: PlayerProfile, itemId: unknown, countRaw?: unknown): Transition {
  const item = itemById(itemId);
  if (!item) return { ok: false, error: "unknown_item" };
  const count = clampCount(countRaw);
  if (count === null) return { ok: false, error: "invalid_count" };
  const removed = removeItem(profile, item.id, count);
  if (!removed) return { ok: false, error: "not_enough_items" };
  return {
    ok: true,
    profile: { ...removed, coins: removed.coins + sellPrice(item) * count },
  };
}

/** かばんの食事・飲み物を消費して空腹度を回復する。 */
export function eatItem(profile: PlayerProfile, itemId: unknown): Transition<{ item: ItemDef }> {
  const item = itemById(itemId);
  if (!item || !item.hunger) return { ok: false, error: "unknown_item" };
  if (profile.hunger >= HUNGER_MAX) return { ok: false, error: "hunger_full" };
  const removed = removeItem(profile, item.id, 1);
  if (!removed) return { ok: false, error: "not_enough_items" };
  return {
    ok: true,
    item,
    profile: { ...removed, hunger: Math.min(HUNGER_MAX, removed.hunger + item.hunger) },
  };
}

/** 労働する（空腹度を消費して所持金を得る）。 */
export function doWork(profile: PlayerProfile): Transition {
  if (profile.hunger < WORK_HUNGER_COST) return { ok: false, error: "too_tired" };
  return {
    ok: true,
    profile: {
      ...profile,
      hunger: profile.hunger - WORK_HUNGER_COST,
      coins: profile.coins + WORK_REWARD_COINS,
    },
  };
}

/** 合成する（素材を消費して成果物を得る。レア結果つき）。 */
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
      /** 成功時は奪った額、失敗時は払った罰金。 */
      amount: number;
      actor: PlayerProfile;
      target: PlayerProfile;
    }
  | { ok: false; error: EconomyError };

/**
 * steal の解決（ボット側 circulation/steal と同じ規則）。
 * - 実行者はクールダウン中は実行できない
 * - 対象は所持金が下限未満なら保護、防犯チャーム所持でも保護、
 *   直近に盗まれたばかりでも保護
 * - 成功: 対象の所持金の割合（上限つき）を奪う
 * - 失敗: 実行者が対象へ罰金を払う（自分の所持金が上限）
 */
export function resolveSteal(
  actor: PlayerProfile,
  target: PlayerProfile,
  now: number,
  rng: () => number = Math.random,
): StealOutcome {
  if (now - actor.stealActorAt < STEAL_ACTOR_COOLDOWN_SECONDS * 1000) {
    return { ok: false, error: "steal_cooldown" };
  }
  if (target.coins < STEAL_TARGET_MIN_COINS || countItem(target, "guard_charm") > 0) {
    return { ok: false, error: "target_protected" };
  }
  if (now - target.stealTargetAt < STEAL_TARGET_COOLDOWN_SECONDS * 1000) {
    return { ok: false, error: "target_recently_stolen" };
  }
  const rate = STEAL_SUCCESS_RATE + (countItem(actor, "thief_mask") > 0 ? THIEF_MASK_BONUS : 0);
  const stampedActor = { ...actor, stealActorAt: now };
  if (rng() < rate) {
    const amount = Math.max(1, Math.min(STEAL_MAX_AMOUNT, Math.floor(target.coins * STEAL_BALANCE_RATE)));
    return {
      ok: true,
      success: true,
      amount,
      actor: { ...stampedActor, coins: stampedActor.coins + amount },
      target: { ...target, coins: target.coins - amount, stealTargetAt: now },
    };
  }
  const fine = Math.min(STEAL_FINE_AMOUNT, actor.coins);
  return {
    ok: true,
    success: false,
    amount: fine,
    actor: { ...stampedActor, coins: stampedActor.coins - fine },
    target: { ...target, coins: target.coins + fine, stealTargetAt: now },
  };
}
