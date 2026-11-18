// AGO WORLD BOX の地面に落ちたアイテム（純粋ロジック、DOM 非依存）。
// インベントリから捨てたアイテムは、その場のタイルに落ちて、誰でも
// （捨てた本人以外でも）拾える。保存は ground-items-online が bot_kv
// （名前空間 worldbox_ground_items、キー = 空間）へ配列で持つ。
// 古いものは TTL で消え、空間の上限を超えたら古い順に消える。

export type GroundItem = {
  /** ドロップごとの一意 ID。 */
  id: string;
  itemId: string;
  count: number;
  /** タイル座標。 */
  x: number;
  y: number;
  /** 落とした時刻（ミリ秒）。 */
  at: number;
};

/** 1空間に残せるドロップの上限（超えた分は古い順に消える）。 */
export const GROUND_ITEMS_CAP = 200;
/** ドロップが消えるまでの時間（24時間）。 */
export const GROUND_ITEM_TTL_MS = 24 * 60 * 60 * 1000;
/** 拾える距離（チェビシェフ）。タイル操作の上限と同じ。 */
export const GROUND_PICKUP_RANGE = 2;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseGroundItem(raw: unknown): GroundItem | null {
  if (!isRecord(raw)) return null;
  const { id, itemId, count, x, y, at } = raw;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
  if (typeof itemId !== "string" || itemId.length === 0) return null;
  if (typeof count !== "number" || !Number.isFinite(count)) return null;
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  const c = Math.floor(count);
  if (c < 1) return null;
  return { id, itemId, count: c, x: Math.floor(x), y: Math.floor(y), at: Math.floor(at) };
}

export function parseGroundItems(raw: unknown): GroundItem[] {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return [];
  const out: GroundItem[] = [];
  for (const entry of raw.items) {
    const item = parseGroundItem(entry);
    if (item) out.push(item);
  }
  return out;
}

export function serializeGroundItems(items: readonly GroundItem[]): { items: GroundItem[] } {
  return { items: items.map((i) => ({ ...i })) };
}

/** TTL を過ぎたドロップを取り除く。 */
export function pruneGroundItems(items: readonly GroundItem[], now: number): GroundItem[] {
  return items.filter((i) => now - i.at < GROUND_ITEM_TTL_MS);
}

/** ドロップを足す（TTL 掃除＋上限で古い順に落とす）。 */
export function addGroundItem(
  items: readonly GroundItem[],
  item: GroundItem,
  now: number,
): GroundItem[] {
  const next = [...pruneGroundItems(items, now), item];
  return next.length > GROUND_ITEMS_CAP ? next.slice(next.length - GROUND_ITEMS_CAP) : next;
}

/** ID のドロップを取り出す。無ければ null。 */
export function takeGroundItem(
  items: readonly GroundItem[],
  id: string,
): { item: GroundItem; rest: GroundItem[] } | null {
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return null;
  const rest = [...items];
  const [item] = rest.splice(idx, 1);
  return { item, rest };
}

/** そのタイルに落ちている最初のドロップ。 */
export function groundItemAt(items: readonly GroundItem[], x: number, y: number): GroundItem | null {
  return items.find((i) => i.x === x && i.y === y) ?? null;
}

/** 拾える距離（チェビシェフ GROUND_PICKUP_RANGE 以内）か。 */
export function canPickupAt(item: GroundItem, px: number, py: number): boolean {
  return Math.max(Math.abs(item.x - px), Math.abs(item.y - py)) <= GROUND_PICKUP_RANGE;
}
