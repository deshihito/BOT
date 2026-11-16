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
 * 店で売る品目は入口だけのホワイトリスト（ユーザー決定 2026-11-16、案C）。
 * 以前の「レア品だけ除外」（特殊全品・ミスリル道具・宝石ブロック）から
 * 進めて、販売は下の SHOP_STOCK_IDS ＋ 種カテゴリ全種の計86品だけにする。
 * それ以外（合成品・調理済み食品・作物そのもの・宝石/貴金属素材・
 * 鉱石/金属ブロック・採取/ドロップ素材など）は店では売らず、合成・栽培・
 * 採取・ドロップ・ギルドショップで入手する。売却は従来どおり全品可
 * （ジャンル不問で売れる）。
 * 種はカテゴリで一括許可する（畑の入口であり、店以外に入手経路が無い）。
 * 種以外の品目は明示 ID 集合で判定する: 店以外に入手経路が無い基礎素材
 * （棒・ガラス・粘土・紙・竹・木炭・砂糖・鉄/銅インゴット・塩）は
 * 合成が詰まないよう必ず含める。鍛冶屋ジャンル（合成品・特殊）は
 * 販売品目ゼロになり、鍛冶屋は合成・強化の施設としてのみ使う。
 */
const SHOP_STOCK_IDS: ReadonlySet<string> = new Set([
  // 道具屋: 木/石/鉄の道具（ミスリルは合成のみ）と開拓のコンパス
  "wooden_axe", "wooden_pickaxe", "wooden_sword", "wooden_hoe",
  "stone_axe", "stone_pickaxe", "stone_sword", "stone_hoe",
  "iron_axe", "iron_pickaxe", "iron_sword", "iron_hoe",
  "explorer_compass",
  // 建築屋: 基本の地形ブロックと原木だけ（鉱石/金属/加工ブロックは売らない）
  "dirt_block", "sand_block", "snow_block", "mud_block", "grass_block",
  "gravel_block", "moss_block", "clay_block", "packed_snow_block", "ice_block",
  "leaves_block", "path_block", "forest_floor_block", "cactus_block", "flower_block",
  "oak_log", "pine_log", "birch_log", "sakura_log", "dark_log",
  "autumn_log", "dead_log", "log_block",
  // 家具屋: 施設と最低限の家具だけ（他は合成で作る）
  "torch", "workbench", "furnace", "storage_chest", "chest_box", "bed",
  // 食料屋: 基本食だけ（調理済み料理と作物そのものは売らない）
  "onigiri", "energy_drink", "meal", "cake", "bento", "feast",
  // 種・素材屋: 基礎素材だけ（種はカテゴリで許可。採取素材は売らない）
  "wood", "stone", "stick", "clay", "glass", "paper", "bamboo", "charcoal",
  "sugar", "iron_ingot", "copper_ingot", "salt",
]);

export function isShopExcluded(item: ItemDef): boolean {
  if (item.category === "seed") return false;
  return !SHOP_STOCK_IDS.has(item.id);
}

/** そのジャンルで売られている品目（カタログ順、ホワイトリスト内のみ）。 */
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
 * 購入の在庫検証: ホワイトリスト外（isShopExcluded）はどの店でも売っていないので
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
