// AGO WORLD BOX のインベントリ（純粋ロジック）。
// v2 からホットバー兼インベントリは「5枠固定」。ブロックとインゴットは
// 枠の中で無制限にスタックし、道具（ツルハシ・剣）は1枠を1つで使う。
// 枠が満杯で受け取れないときは addItem が 0 を返し、掘削・クラフト側が
// 「拾えない／作れない」を判断できるようにする（黙って消したりしない）。
import { isStackable, isTool } from "./items";

export const SLOT_COUNT = 5;

export type InvSlot = { id: number; count: number } | null;

export type InventoryV2 = {
  /** 常に SLOT_COUNT 長。中身がない枠は null。 */
  slots: InvSlot[];
};

export function createInventory(): InventoryV2 {
  return { slots: Array.from({ length: SLOT_COUNT }, () => null) };
}

export function countOf(inv: InventoryV2, id: number): number {
  let total = 0;
  for (const slot of inv.slots) if (slot && slot.id === id) total += slot.count;
  return total;
}

export function slotIndexOf(inv: InventoryV2, id: number): number {
  return inv.slots.findIndex((slot) => slot !== null && slot.id === id);
}

export function emptySlotIndex(inv: InventoryV2): number {
  return inv.slots.findIndex((slot) => slot === null);
}

/** 空き枠が1つもないか。 */
export function isInventoryFull(inv: InventoryV2): boolean {
  return emptySlotIndex(inv) < 0;
}

/** そのアイテムを n 個受け取れるか（道具は未所持＋空き枠が必要）。 */
export function canAdd(inv: InventoryV2, id: number, n = 1): boolean {
  if (n <= 0) return true;
  if (isTool(id)) {
    return countOf(inv, id) === 0 && emptySlotIndex(inv) >= 0;
  }
  if (isStackable(id) && slotIndexOf(inv, id) >= 0) return true;
  return emptySlotIndex(inv) >= 0;
}

/**
 * アイテムを加える。実際に入った数を返す（満杯なら 0 で、インベントリは無変更）。
 * 道具は1つまでしか持てない。
 */
export function addItem(inv: InventoryV2, id: number, n = 1): number {
  if (n <= 0) return 0;
  if (isTool(id)) {
    if (countOf(inv, id) > 0) return 0;
    const empty = emptySlotIndex(inv);
    if (empty < 0) return 0;
    inv.slots[empty] = { id, count: 1 };
    return 1;
  }
  const existing = slotIndexOf(inv, id);
  if (existing >= 0) {
    const slot = inv.slots[existing];
    if (slot) slot.count += n;
    return n;
  }
  const empty = emptySlotIndex(inv);
  if (empty < 0) return 0;
  inv.slots[empty] = { id, count: n };
  return n;
}

/** アイテムを n 個取り除く。足りなければ false で無変更（原子的）。 */
export function removeItem(inv: InventoryV2, id: number, n = 1): boolean {
  if (n <= 0) return true;
  if (countOf(inv, id) < n) return false;
  let left = n;
  for (let i = 0; i < inv.slots.length && left > 0; i++) {
    const slot = inv.slots[i];
    if (!slot || slot.id !== id) continue;
    const take = Math.min(left, slot.count);
    slot.count -= take;
    left -= take;
    if (slot.count <= 0) inv.slots[i] = null;
  }
  return left === 0;
}

/** スロット配列の複製（HUD 表示・保存用に安全なコピーを作る）。 */
export function cloneInventory(inv: InventoryV2): InventoryV2 {
  return { slots: inv.slots.map((slot) => (slot ? { id: slot.id, count: slot.count } : null)) };
}
