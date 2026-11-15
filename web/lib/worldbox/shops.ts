// AGO WORLD BOX のショップのジャンル分け（純粋ロジック、DOM 非依存）。
// ロビーの店は店員ごとに扱う品目が違う: アイテムカテゴリを各ジャンルへ
// ちょうど1回ずつ割り当て、購入は「いる店のジャンル」と「買うアイテムの
// ジャンル」が一致する時だけ通す（サーバー側でも検証する）。
// 鍛冶屋（station "smith"）はジャンル "smith" として扱う。
import { ITEMS, itemById, type ItemCategory, type ItemDef } from "./items";

export type ShopGenreId = "tools" | "blocks" | "furniture" | "food" | "farm" | "smith";

export type ShopGenre = {
  id: ShopGenreId;
  /** 店名（タブ見出し・名前札に出す断片ラベル）。 */
  name: string;
  categories: readonly ItemCategory[];
};

/** ジャンル定義。カテゴリは全 ItemCategory をちょうど1回ずつ覆う。 */
export const SHOP_GENRES: readonly ShopGenre[] = [
  { id: "tools", name: "道具屋", categories: ["tool"] },
  { id: "blocks", name: "建築屋", categories: ["block"] },
  { id: "furniture", name: "家具屋", categories: ["furniture"] },
  { id: "food", name: "食料屋", categories: ["food", "crop"] },
  { id: "farm", name: "種・素材屋", categories: ["seed", "material"] },
  { id: "smith", name: "鍛冶屋", categories: ["crafted", "special"] },
];

const GENRE_BY_ID = new Map<string, ShopGenre>(SHOP_GENRES.map((g) => [g.id, g]));
const GENRE_BY_CATEGORY = new Map<ItemCategory, ShopGenre>(
  SHOP_GENRES.flatMap((g) => g.categories.map((c) => [c, g] as const)),
);

export function genreById(id: unknown): ShopGenre | null {
  return typeof id === "string" ? (GENRE_BY_ID.get(id) ?? null) : null;
}

export function genreForCategory(category: ItemCategory): ShopGenre | null {
  return GENRE_BY_CATEGORY.get(category) ?? null;
}

/** アイテムが売られているジャンル。未知のアイテムは null。 */
export function genreOfItem(itemId: unknown): ShopGenreId | null {
  const item = itemById(itemId);
  if (!item) return null;
  return genreForCategory(item.category)?.id ?? null;
}

/**
 * 店で売らないレア品（ユーザー決定）: 特殊カテゴリ全品・道具の tier 4
 * （ミスリル）・宝石ブロック4種。入手は合成・ドロップ・探索のみ。
 * 売却は従来どおり可（ジャンル不問で売れる）。
 * 宝石ブロックは「宝石名+_block」が鉱石ブロック（diamond_ore_block 等）と
 * 紛らわしいため、名前パターンでなく明示 ID 集合で判定する。
 */
const GEM_BLOCK_IDS: ReadonlySet<string> = new Set([
  "diamond_block",
  "emerald_block",
  "ruby_block",
  "sapphire_block",
]);

export function isShopExcluded(item: ItemDef): boolean {
  if (item.category === "special") return true;
  if (item.category === "tool" && item.tier === 4) return true;
  return GEM_BLOCK_IDS.has(item.id);
}

/** そのジャンルで売られている品目（カタログ順、レア品は除く）。 */
export function itemsForGenre(genreId: ShopGenreId): ItemDef[] {
  return ITEMS.filter((item) => genreOfItem(item.id) === genreId && !isShopExcluded(item));
}

/**
 * 購入のジャンル検証: いる店のジャンルと買うアイテムのジャンルが
 * 一致しなければ "wrong_shop"。店がジャンルを持たない場合は制限しない
 * （従来どおり全品目）。未知のアイテムはここでは弾かず、buyItem 側の
 * unknown_item に委ねる。
 */
export function checkBuyGenre(shopGenre: ShopGenreId | null, itemId: unknown): "wrong_shop" | null {
  if (shopGenre === null) return null;
  const itemGenre = genreOfItem(itemId);
  if (itemGenre === null) return null;
  return itemGenre === shopGenre ? null : "wrong_shop";
}

/**
 * 購入の在庫検証: レア品（isShopExcluded）はどの店でも売っていないので
 * "not_sold"。未知のアイテムはここでは弾かず、buyItem 側の
 * unknown_item に委ねる。
 */
export function checkBuySold(itemId: unknown): "not_sold" | null {
  const item = itemById(itemId);
  if (!item) return null;
  return isShopExcluded(item) ? "not_sold" : null;
}

/** 日次ローテーション用の日キー（UTC の日付）。 */
export function shopDayKeyOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function shopHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * その日の価格（決定的）。基準価格から 5% 刻みで ±10% の範囲で揺れる。
 * Plan A の原資ルールの内側の揺れで、上下は日とアイテムで決まる。
 */
export function dailyPriceFor(item: ItemDef, dayKey: string): number {
  const step = (shopHash(`${dayKey}:${item.id}`) % 5) - 2; // -2..2
  return Math.max(1, Math.round(item.price * (1 + step * 0.05)));
}

/**
 * その日の品目（決定的ローテーション）。ジャンル品目が多い店では
 * 毎日 75% の窓が回り、少ない店では全品目が出る。
 */
export function dailyStockForGenre(genreId: ShopGenreId, dayKey: string): ItemDef[] {
  const all = itemsForGenre(genreId);
  if (all.length <= 8) return all;
  const window = Math.ceil(all.length * 0.75);
  const offset = shopHash(`${dayKey}:stock:${genreId}`) % all.length;
  const out: ItemDef[] = [];
  for (let i = 0; i < window; i++) out.push(all[(offset + i) % all.length]);
  return out;
}

/** その日その店で買えるか（ジャンル店での日次品目チェック）。 */
export function checkDailyStock(genreId: ShopGenreId | null, itemId: unknown, dayKey: string): "not_sold" | null {
  if (genreId === null) return null;
  if (typeof itemId !== "string") return null;
  return dailyStockForGenre(genreId, dayKey).some((i) => i.id === itemId) ? null : "not_sold";
}
