// AGO WORLD BOX のアイテム定義（純粋ロジック）。
// Discord ボット側の経済機能（core/general/items・workshop/craft・
// circulation/steal）の仕組みをワールドボックスに持ち込んだもの。
// カタログは「母数」を厚くし、食事・素材・合成品・特殊の4系統を用意する。
// 効果が未実装のアイテムは作らない（ボット側 items.py と同じ方針）。

export type ItemCategory = "food" | "material" | "crafted" | "special";

export type ItemDef = {
  id: string;
  name: string;
  desc: string;
  category: ItemCategory;
  /** ショップの販売価格（コイン）。売却はこの割合（SELL_RATE）。 */
  price: number;
  /** 食べたときの空腹度回復量（food のみ）。 */
  hunger?: number;
};

export const ITEMS: readonly ItemDef[] = [
  // ---- 食事（食べると空腹度が回復する） -------------------------------
  { id: "wheat", name: "小麦", desc: "そのままでも少し食べられる素材", category: "food", price: 6, hunger: 5 },
  { id: "bread", name: "パン", desc: "軽くつまむ", category: "food", price: 10, hunger: 20 },
  { id: "onigiri", name: "おにぎり", desc: "手軽な携行食", category: "food", price: 15, hunger: 30 },
  { id: "energy_drink", name: "エナジードリンク", desc: "すばやく回復", category: "food", price: 25, hunger: 15 },
  { id: "meal", name: "定食", desc: "しっかり食べる", category: "food", price: 30, hunger: 55 },
  { id: "cake", name: "ケーキ", desc: "甘いごほうび", category: "food", price: 40, hunger: 45 },
  { id: "bento", name: "幕の内弁当", desc: "品数たっぷり", category: "food", price: 45, hunger: 80 },
  { id: "feast", name: "フルコース", desc: "満腹まで食べる", category: "food", price: 50, hunger: 100 },
  // ---- 素材（合成の材料） ---------------------------------------------
  { id: "wood", name: "木材", desc: "基本の素材", category: "material", price: 8 },
  { id: "stone", name: "石材", desc: "基本の素材", category: "material", price: 8 },
  { id: "herb", name: "薬草", desc: "薬の素材になる草", category: "material", price: 12 },
  { id: "cloth", name: "布", desc: "織物の素材", category: "material", price: 16 },
  { id: "glass", name: "ガラス", desc: "透明な素材", category: "material", price: 18 },
  { id: "iron_ore", name: "鉄鉱石", desc: "金属の素材", category: "material", price: 20 },
  { id: "gold_ore", name: "金鉱石", desc: "高価な金属の素材", category: "material", price: 60 },
  { id: "mithril", name: "ミスリル", desc: "希少な魔法金属", category: "material", price: 150 },
  // ---- 合成品（合成で作る。売ると素材代より高くなる） -----------------
  { id: "carving", name: "木彫りの置物", desc: "木材を彫った工芸品", category: "crafted", price: 45 },
  { id: "lantern", name: "石のランタン", desc: "石とガラスの明かり", category: "crafted", price: 60 },
  { id: "blanket", name: "毛布", desc: "布を重ねた防寒具", category: "crafted", price: 56 },
  { id: "potion", name: "薬草ポーション", desc: "飲むと空腹度が大きく回復", category: "crafted", price: 76, hunger: 60 },
  { id: "toolbox", name: "鉄の道具箱", desc: "鉄と木の実用品", category: "crafted", price: 85 },
  { id: "tent", name: "テント", desc: "布と木の野営道具", category: "crafted", price: 110 },
  { id: "accessory", name: "金のアクセサリー", desc: "金とガラスの装飾品", category: "crafted", price: 140 },
  { id: "special_course", name: "特上コース料理", desc: "定食を超える一品", category: "crafted", price: 130, hunger: 100 },
  // ---- 特殊（所持しているだけで効く） ---------------------------------
  { id: "guard_charm", name: "防犯チャーム", desc: "持っていると steal されなくなる", category: "special", price: 200 },
  { id: "thief_mask", name: "怪盗マスク", desc: "持っていると steal の成功率が上がる", category: "special", price: 200 },
  { id: "star_shard", name: "星の欠片", desc: "合成のレア結果でたまに手に入る", category: "special", price: 300 },
  { id: "crown", name: "王冠", desc: "最高峰の合成品", category: "special", price: 500 },
];

const ITEM_BY_ID = new Map(ITEMS.map((item) => [item.id, item]));

export function itemById(id: unknown): ItemDef | null {
  return typeof id === "string" ? ITEM_BY_ID.get(id) ?? null : null;
}

/** 売却価格（販売価格の6割）。 */
export const SELL_RATE = 0.6;
export function sellPrice(item: ItemDef): number {
  return Math.max(1, Math.floor(item.price * SELL_RATE));
}

// ---------------------------------------------------------------- 合成
// ボット側 workshop/craft と同じ「2種の素材を組み合わせる」方式。
export type Recipe = {
  id: string;
  inputs: Readonly<Record<string, number>>;
  output: string;
  outputCount: number;
  /** 成功時に追加でレアアイテムが落ちる確率（0〜1）。 */
  rareItem?: string;
  rareChance?: number;
};

export const RECIPES: readonly Recipe[] = [
  { id: "carving", inputs: { wood: 3 }, output: "carving", outputCount: 1 },
  { id: "lantern", inputs: { stone: 2, glass: 1 }, output: "lantern", outputCount: 1 },
  { id: "blanket", inputs: { cloth: 2 }, output: "blanket", outputCount: 1 },
  { id: "potion", inputs: { herb: 2, glass: 1 }, output: "potion", outputCount: 1, rareItem: "star_shard", rareChance: 0.05 },
  { id: "toolbox", inputs: { iron_ore: 2, wood: 1 }, output: "toolbox", outputCount: 1 },
  { id: "tent", inputs: { cloth: 3, wood: 2 }, output: "tent", outputCount: 1 },
  { id: "accessory", inputs: { gold_ore: 1, glass: 1 }, output: "accessory", outputCount: 1, rareItem: "star_shard", rareChance: 0.08 },
  { id: "special_course", inputs: { meal: 1, wheat: 2, herb: 1 }, output: "special_course", outputCount: 1 },
  { id: "bread", inputs: { wheat: 2 }, output: "bread", outputCount: 1 },
  { id: "crown", inputs: { accessory: 1, mithril: 1 }, output: "crown", outputCount: 1 },
];

export function recipeById(id: unknown): Recipe | null {
  return typeof id === "string" ? RECIPES.find((r) => r.id === id) ?? null : null;
}

// ---------------------------------------------------------------- steal
// ボット側 circulation/steal の規則をワールドボックスの経済規模に合わせて
// 縮小したもの（成功率・割合の考え方は同じ）。
/** steal の成功率。 */
export const STEAL_SUCCESS_RATE = 0.4;
/** 奪える額 = 対象の所持金 × この割合（上限つき）。 */
export const STEAL_BALANCE_RATE = 0.05;
/** 奪える額の絶対上限。 */
export const STEAL_MAX_AMOUNT = 50;
/** 対象の所持金がこれ未満なら保護されて盗めない。 */
export const STEAL_TARGET_MIN_COINS = 50;
/** 失敗時に相手へ払う罰金。 */
export const STEAL_FINE_AMOUNT = 20;
/** steal 実行者のクールダウン（秒）。 */
export const STEAL_ACTOR_COOLDOWN_SECONDS = 600;
/** steal された人の保護期間（秒）。 */
export const STEAL_TARGET_COOLDOWN_SECONDS = 3600;
/** 怪盗マスク所持時の成功率ボーナス。 */
export const THIEF_MASK_BONUS = 0.15;

// ---------------------------------------------------------------- 労働
/** 労働1回の空腹度コストと報酬（仕様書の「労働」）。 */
export const WORK_HUNGER_COST = 10;
export const WORK_REWARD_COINS = 20;
