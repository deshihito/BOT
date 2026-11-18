// AGO WORLD BOX の地面ドロップの保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_ground_items"、キー = 空間）。
// 追加と回収は withUserLock で直列化し、二人同時に拾って二重に
// 増える事故を防ぐ。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import {
  addGroundItem, parseGroundItems, serializeGroundItems, takeGroundItem,
  type GroundItem,
} from "./ground-items";
import { loadMyPresence } from "./presence-online";
import { parseSave } from "./save";
import { loadWorldBoxSave } from "./save-online";
import { withUserLock } from "./user-lock";

export const WORLDBOX_GROUND_ITEMS_NAMESPACE = "worldbox_ground_items";

export function isGroundItemsEnabled(): boolean {
  return isBotApiConfigured();
}

/** 空間キーの検証（プレゼンスの空間 ID の形だけを許す）。 */
export function isValidGroundSpace(space: unknown): space is string {
  return typeof space === "string" && /^[a-z0-9_:,-]{1,64}$/.test(space);
}

export async function loadGroundItems(space: string): Promise<GroundItem[]> {
  if (!isBotApiConfigured() || !isValidGroundSpace(space)) return [];
  try {
    return parseGroundItems(await kvGet(WORLDBOX_GROUND_ITEMS_NAMESPACE, space));
  } catch {
    return [];
  }
}

async function storeGroundItems(space: string, items: readonly GroundItem[]): Promise<boolean> {
  try {
    await kvSet(WORLDBOX_GROUND_ITEMS_NAMESPACE, space, serializeGroundItems(items));
    return true;
  } catch {
    return false;
  }
}

/** ドロップを足す。成功したら true。 */
export async function addGroundItemDrop(space: string, item: GroundItem): Promise<boolean> {
  if (!isBotApiConfigured() || !isValidGroundSpace(space)) return false;
  return withUserLock(`ground-items:${space}`, async () => {
    const current = await loadGroundItems(space);
    return storeGroundItems(space, addGroundItem(current, item, Date.now()));
  });
}

/** ドロップを回収する（拾えたらそのドロップ、無ければ null）。 */
export async function takeGroundItemDrop(space: string, id: string): Promise<GroundItem | null> {
  if (!isBotApiConfigured() || !isValidGroundSpace(space)) return null;
  return withUserLock(`ground-items:${space}`, async () => {
    const current = await loadGroundItems(space);
    const taken = takeGroundItem(current, id);
    if (!taken) return null;
    if (!(await storeGroundItems(space, taken.rest))) return null;
    return taken.item;
  });
}

/**
 * 本人の現在位置（空間＋タイル座標）。プレゼンス（新鮮なハートビート）を
 * 正とし、無ければセーブの入口位置で代替する（station-online と同じ方式）。
 */
export async function loadMyPosition(
  ownerKey: string,
): Promise<{ space: string; tx: number; ty: number } | null> {
  const presence = await loadMyPresence(ownerKey);
  if (presence) {
    return { space: presence.space, tx: Math.floor(presence.x), ty: Math.floor(presence.y) };
  }
  const saved = parseSave(await loadWorldBoxSave(ownerKey));
  if (!saved) return null;
  return { space: saved.space, tx: Math.floor(saved.x), ty: Math.floor(saved.y) };
}
