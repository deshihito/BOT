// AGO WORLD BOX の収納コンテナ（純粋ロジック、DOM 非依存）。
// 設置した樽・宝箱に物をしまう仕組み。コンテナは furniture（facility）
// としてタイルに置かれ、中身はタイル単位で別に持つ（保存は
// containers-online.ts、bot_kv 名前空間 "worldbox_containers"）。
// 中身は全員共有（誰でも開けて出し入れできる）。スロット移動の意味論は
// インベントリ整理（profile.ts の moveSlot）に揃える: 空き枠へは移動、
// 同種は合算（上限 STACK_MAX、あふれた分は元の枠に残る）、異種は入れ替え。
import { itemById } from "./items";
import {
  HOTBAR_SLOTS, STACK_MAX, STORAGE_SLOTS,
  type ItemSlot, type PlayerProfile,
} from "./profile";

/** コンテナとして使える家具と、その容量（枠数）。 */
export const CONTAINER_DEFS: Readonly<Record<string, { capacity: number }>> = {
  crate: { capacity: 8 },
  barrel: { capacity: 10 },
  chest_box: { capacity: 15 },
  storage_chest: { capacity: 20 },
};

/** そのアイテムのコンテナ容量。コンテナでないアイテムは 0。 */
export function containerCapacity(itemId: unknown): number {
  if (typeof itemId !== "string") return 0;
  return CONTAINER_DEFS[itemId]?.capacity ?? 0;
}

/** そのアイテムが収納コンテナかどうか。 */
export function isContainerItem(itemId: unknown): boolean {
  return containerCapacity(itemId) > 0;
}

/** コンテナの中身。slots の長さは容量と一致する。 */
export type ContainerState = {
  /** 所有者の不透明 ID（設置ブロックの ownerId と同じ）。 */
  ownerId: string;
  slots: ItemSlot[];
};

export function emptyContainer(ownerId: string, itemId: string): ContainerState {
  return {
    ownerId,
    slots: Array.from({ length: containerCapacity(itemId) }, () => null),
  };
}

/** 中身が空かどうか（null は「状態なし＝空」として扱う）。 */
export function containerIsEmpty(state: ContainerState | null | undefined): boolean {
  return !state || state.slots.every((s) => s === null);
}

function clampContainerInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function parseContainerSlot(raw: unknown): ItemSlot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as { id?: unknown; count?: unknown };
  if (!itemById(v.id)) return null;
  const n = clampContainerInt(v.count, 1, STACK_MAX, 0);
  return n > 0 ? { id: v.id as string, count: n } : null;
}

/**
 * bot_kv の1値からコンテナ状態を復元する。容量はアイテム定義が正。
 * 壊れたデータ・コンテナでないアイテムは null。
 */
export function parseContainerState(raw: unknown, itemId: string): ContainerState | null {
  const capacity = containerCapacity(itemId);
  if (capacity === 0) return null;
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const v = data as Record<string, unknown>;
  if (typeof v.ownerId !== "string" || v.ownerId.length === 0) return null;
  if (!Array.isArray(v.slots)) return null;
  const slots: ItemSlot[] = Array.from({ length: capacity }, () => null);
  for (let i = 0; i < Math.min(capacity, v.slots.length); i++) {
    slots[i] = parseContainerSlot(v.slots[i]);
  }
  return { ownerId: v.ownerId, slots };
}

export function serializeContainerState(state: ContainerState): string {
  return JSON.stringify({ ownerId: state.ownerId, slots: state.slots });
}

// ---------------------------------------------------------------- スロット移動
/** コンテナパネルで扱うスロットの住所。 */
export type ContainerSlotSide = "profile_hotbar" | "profile_storage" | "container";
export type ContainerSlotRef = { side: ContainerSlotSide; index: number };

export function parseContainerSlotRef(raw: unknown, capacity: number): ContainerSlotRef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as { side?: unknown; index?: unknown };
  if (v.side !== "profile_hotbar" && v.side !== "profile_storage" && v.side !== "container") {
    return null;
  }
  if (typeof v.index !== "number" || !Number.isFinite(v.index)) return null;
  const index = Math.floor(v.index);
  const max =
    v.side === "profile_hotbar" ? HOTBAR_SLOTS
    : v.side === "profile_storage" ? STORAGE_SLOTS
    : capacity;
  if (index < 0 || index >= max) return null;
  return { side: v.side, index };
}

function normalizeSlots(slots: readonly ItemSlot[] | undefined, size: number): ItemSlot[] {
  const out: ItemSlot[] = Array.from({ length: size }, () => null);
  if (Array.isArray(slots)) {
    for (let i = 0; i < Math.min(size, slots.length); i++) {
      const s = slots[i];
      out[i] = s ? { ...s } : null;
    }
  }
  return out;
}

function containerSlotTotal(slots: readonly ItemSlot[], itemId: string): number {
  let n = 0;
  for (const s of slots) if (s && s.id === itemId) n += s.count;
  return n;
}

/**
 * プロフィール⇔コンテナ間のスロット移動（moveSlot と同じ意味論）。
 * プロフィールをまたぐ移動では items 集計ビューも差分で追随させる
 * （総量は常に保存される）。住所が不正なら null、空枠からの移動や
 * 同枠指定は現状維持で返す。
 */
export function moveContainerSlot(
  profile: PlayerProfile,
  container: ContainerState,
  fromRaw: unknown,
  toRaw: unknown,
): { profile: PlayerProfile; container: ContainerState } | null {
  const capacity = container.slots.length;
  const from = parseContainerSlotRef(fromRaw, capacity);
  const to = parseContainerSlotRef(toRaw, capacity);
  if (!from || !to) return null;
  const unchanged = { profile, container };
  if (from.side === to.side && from.index === to.index) return unchanged;

  const hotbar = normalizeSlots(profile.hotbar, HOTBAR_SLOTS);
  const storage = normalizeSlots(profile.storage, STORAGE_SLOTS);
  const cslots = normalizeSlots(container.slots, capacity);
  const arrays: Record<ContainerSlotSide, ItemSlot[]> = {
    profile_hotbar: hotbar,
    profile_storage: storage,
    container: cslots,
  };
  const src = arrays[from.side][from.index];
  if (!src) return unchanged;
  const dst = arrays[to.side][to.index];
  // 移動前のプロフィール枠内総量（集計ビューの追随に使う）
  const touchedIds = [...new Set([src.id, dst?.id].filter((v): v is string => !!v))];
  const before: Record<string, number> = {};
  for (const id of touchedIds) {
    before[id] = containerSlotTotal(hotbar, id) + containerSlotTotal(storage, id);
  }
  if (dst && dst.id !== src.id) {
    // 入れ替え
    arrays[to.side][to.index] = src;
    arrays[from.side][from.index] = dst;
  } else if (dst) {
    // 同種の合算（あふれた分は元の枠に残る）
    const moved = Math.min(STACK_MAX - dst.count, src.count);
    if (moved <= 0) return unchanged;
    arrays[to.side][to.index] = { id: dst.id, count: dst.count + moved };
    const rest = src.count - moved;
    arrays[from.side][from.index] = rest > 0 ? { id: src.id, count: rest } : null;
  } else {
    arrays[to.side][to.index] = src;
    arrays[from.side][from.index] = null;
  }

  // プロフィールの集計ビューを、枠内総量の差分で追随させる
  const items = { ...profile.items };
  for (const id of touchedIds) {
    const after = containerSlotTotal(hotbar, id) + containerSlotTotal(storage, id);
    const base = Math.max(items[id] ?? 0, before[id]);
    const next = base + (after - before[id]);
    if (next > 0) items[id] = next;
    else delete items[id];
  }
  return {
    profile: { ...profile, hotbar, storage, items },
    container: { ...container, slots: cslots },
  };
}
