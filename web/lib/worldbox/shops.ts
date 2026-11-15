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

/** そのジャンルで売られている品目（カタログ順）。 */
export function itemsForGenre(genreId: ShopGenreId): ItemDef[] {
  return ITEMS.filter((item) => genreOfItem(item.id) === genreId);
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
