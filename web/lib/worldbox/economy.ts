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
  RECIPES, itemById, recipeById, sellPrice, type ItemDef, type Recipe,
} from "./items";
import {
  HP_MAX, HUNGER_MAX, maxHpFor, addItem, countItem, removeItem, type PlayerProfile,
} from "./profile";
import { consumeEffect } from "./vitals";


export type EconomyError =
  | "unknown_item" | "unknown_recipe" | "not_enough_coins" | "not_enough_items"
  | "hunger_full" | "too_tired" | "invalid_count" | "invalid_request"
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
  unitPrice?: number,
): Transition {
  const item = itemById(itemId);
  if (!item) return { ok: false, error: "unknown_item" };
  const count = clampCount(countRaw);
  if (count === null) return { ok: false, error: "invalid_count" };
  const price = typeof unitPrice === "number" && Number.isFinite(unitPrice) && unitPrice > 0 ? Math.floor(unitPrice) : item.price;
  const cost = price * count;
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
  // 金のアクセサリーを持っていると売却額が1割増える（装飾品の持続効果）
  const bonus = (removed.items["accessory"] ?? 0) > 0 || (profile.items["accessory"] ?? 0) > 0 ? 1.1 : 1;
  return {
    ok: true,
    profile: removed,
    coin: { kind: "earn", amount: Math.floor(sellPrice(item) * count * bonus), reason: "shop_sale" },
  };
}

/**
 * かばんの食事・飲み物を消費して空腹度を回復する。
 * 効果の数式（hunger / heal / 解毒 / バフ）は vitals.consumeEffect が正で、
 * ここは消費・容器返却・満腹ゲートだけを持つ（二重実装にしない）。
 * 満腹ゲートの HP 判定は役職込みの最大 HP（守護は 120）で見る: 素の
 * HP_MAX で判定すると、守護が HP 100〜119・満腹のときに回復食が
 * 常時 hunger_full で弾かれる。
 */
export function eatItem(profile: PlayerProfile, itemId: unknown, now: number = Date.now()): Transition<{ item: ItemDef }> {
  const item = itemById(itemId);
  if (!item || (!item.hunger && !item.heal && !item.curePoison && !item.buff)) return { ok: false, error: "unknown_item" };
  const poisoned = Array.isArray(profile.status) && profile.status.some((e) => e.kind === "poison");
  if (
    profile.hunger >= HUNGER_MAX
    && (!item.heal || (typeof profile.hp === "number" ? profile.hp : HP_MAX) >= maxHpFor(profile))
    && (!item.curePoison || !poisoned)
  ) {
    return { ok: false, error: "hunger_full" };
  }
  const removed = removeItem(profile, item.id, 1);
  if (!removed) return { ok: false, error: "not_enough_items" };
  const effected = consumeEffect(removed, item.id, now);
  if (!effected) return { ok: false, error: "unknown_item" };
  // 容器入りの飲食物は、飲み終えた容器が手元に戻る（水入りバケツ→バケツ）
  const withContainer = item.containerReturn ? addItem(effected.profile, item.containerReturn, 1) : effected.profile;
  return { ok: true, item, profile: withContainer };
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

/** 合成の気配（結果そのものは出さず、近いかどうかだけを匂わせる）。 */
export type CraftHint = "exact" | "near" | "far";

/** 自由セット式の合成で失敗したときに残る失敗作のアイテム ID。 */
export const CRAFT_FAILURE_ITEM_ID = "mystery_lump";
/** 台にセットできる素材の種類数と、1種あたりの個数の上限。 */
export const CRAFT_MAX_KINDS = 4;
export const CRAFT_MAX_PER_KIND = 6;

/**
 * 自由セット式の合成（§6: レシピはサーバー側の照合表としてだけ使う）。
 * プレイヤーが台にセットした素材（アイテムID → 個数）を受け取り、
 * RECIPES と完全一致すればその成果物、不一致なら素材を消費して
 * 失敗作（mystery_lump）が残る。結果・確率・レア名は事前に返さず、
 * 気配（hint）だけを返す: exact=完全一致、near=あるレシピと素材種の
 * 半分超を共有、far=それ以外。コインは動かない（craftItem と同じ）。
 */
export function craftFromInputs(
  profile: PlayerProfile,
  inputsRaw: unknown,
  rng: () => number = Math.random,
): Transition<{
  recipe: Recipe | null;
  resultId: string;
  rare: ItemDef | null;
  hint: CraftHint;
  matched: boolean;
}> {
  if (!inputsRaw || typeof inputsRaw !== "object" || Array.isArray(inputsRaw)) {
    return { ok: false, error: "invalid_request" };
  }
  const entries = Object.entries(inputsRaw as Record<string, unknown>);
  if (entries.length < 1 || entries.length > CRAFT_MAX_KINDS) {
    return { ok: false, error: "invalid_request" };
  }
  const inputs: Record<string, number> = {};
  for (const [id, countRaw] of entries) {
    if (!itemById(id)) return { ok: false, error: "unknown_item" };
    if (typeof countRaw !== "number" || !Number.isInteger(countRaw) || countRaw < 1 || countRaw > CRAFT_MAX_PER_KIND) {
      return { ok: false, error: "invalid_request" };
    }
    inputs[id] = countRaw;
  }
  // 完全一致（キー集合と数が一致）するレシピを探す
  const matched = RECIPES.find((recipe) => {
    const keys = Object.keys(recipe.inputs);
    return keys.length === entries.length && keys.every((k) => inputs[k] === recipe.inputs[k]);
  });
  if (matched) {
    const result = craftItem(profile, matched.id, rng);
    if (!result.ok) return result;
    return {
      ok: true,
      profile: result.profile,
      recipe: matched,
      resultId: matched.output,
      rare: result.rare,
      hint: "exact",
      matched: true,
    };
  }
  // 不一致: 先に所持を全部確かめてから消費する（途中失敗で消費しない）
  for (const [id, need] of Object.entries(inputs)) {
    if (countItem(profile, id) < need) return { ok: false, error: "not_enough_items" };
  }
  let next = profile;
  for (const [id, need] of Object.entries(inputs)) {
    const removed = removeItem(next, id, need);
    if (!removed) return { ok: false, error: "not_enough_items" };
    next = removed;
  }
  next = addItem(next, CRAFT_FAILURE_ITEM_ID, 1);
  const inputKinds = new Set(Object.keys(inputs));
  const near = RECIPES.some((recipe) => {
    const keys = Object.keys(recipe.inputs);
    const shared = keys.filter((k) => inputKinds.has(k)).length;
    return shared > keys.length / 2;
  });
  return {
    ok: true,
    profile: next,
    recipe: null,
    resultId: CRAFT_FAILURE_ITEM_ID,
    rare: null,
    hint: near ? "near" : "far",
    matched: false,
  };
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
