// AGO WORLD BOX の屋台（個人商店）の出品状態（純粋ロジック）。
// 屋台（market_stall）のタイルに1品目だけ出品でき、価格は店主が決める。
// コインは Web 側で直接動かさず、購入は経済ブリッジの transfer オプ
// （買手→店主）で処理する（案Bブリッジが唯一の正）。
// 出品中のアイテムは店主の所持から預かり（escrow）として引かれており、
// 売れたら買手へ、取り下げたら店主へ戻る。屋台を掘るのは出品が空のときだけ。
import { itemById } from "./items";

/** 1タイルの出品。count が 0 になったら出品自体を消す（null で表す）。 */
export type StallState = {
  /** 店主の所有者キー（"discord:<id>"）。 */
  ownerKey: string;
  itemId: string;
  /** 1個の価格（コイン）。 */
  price: number;
  /** 残り個数。 */
  count: number;
};

/** 出品価格の上限（コイン）。 */
export const STALL_PRICE_MAX = 1_000_000;
/** 1回の出品の最大個数。 */
export const STALL_COUNT_MAX = 99;

/** 価格の検証: 1〜上限の整数だけ許可。 */
export function validStallPrice(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  return n >= 1 && n <= STALL_PRICE_MAX ? n : null;
}

/** 個数の検証: 1〜上限の整数だけ許可。 */
export function validStallCount(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  return n >= 1 && n <= STALL_COUNT_MAX ? n : null;
}

/** 保存値（JSON 文字列 or オブジェクト）を出品へ戻す。壊れていれば null。 */
export function parseStall(raw: unknown): StallState | null {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object") return null;
  const v = data as Record<string, unknown>;
  if (typeof v.ownerKey !== "string" || v.ownerKey.length === 0) return null;
  if (!itemById(v.itemId)) return null;
  const price = validStallPrice(v.price);
  const count = validStallCount(v.count);
  if (price === null || count === null) return null;
  return { ownerKey: v.ownerKey, itemId: v.itemId as string, price, count };
}

/** 出品を保存値にする。 */
export function serializeStall(state: StallState): string {
  return JSON.stringify(state);
}

/** 1個売れた後の出品（売り切れたら null）。 */
export function stallAfterSale(state: StallState): StallState | null {
  return state.count > 1 ? { ...state, count: state.count - 1 } : null;
}

/** 屋台アイテムかどうか。 */
export function isStallItem(itemId: unknown): boolean {
  return itemId === "market_stall";
}
