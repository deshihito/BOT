// AGO WORLD BOX のプレイヤーセーブ変換（純粋ロジック）。
// localStorage / サーバー（bot_kv）の読み書き自体は呼び出し側で行い、ここは
// 「状態 ⇄ JSON 文字列」の変換と検証だけを担う（壊れたデータは null を返す）。
//
// v3: 世界は全員で共有する1つになったため、セーブはプレイヤー状態だけ
// （5枠スロット・HP・位置）を持つ。タイルと昼夜の位相は保存しない
// （位相は共有時計 daynight.phaseAtTime が決める）。
// v2 以前のセーブは読み込み時に移行する: 所持品・HP・位置を引き継ぎ、
// 保存されていたタイルは破棄する（世界は共有側が正）。
// v1（枠なし Record 形）は所持品を先着5種でスロット化する。
import { HOTBAR_BLOCKS } from "./blocks";
import { PLAYER_MAX_HP } from "./health";
import { SLOT_COUNT, createInventory, type InventoryV2, type InvSlot } from "./inventory";
import { isTool } from "./items";
import { WORLD_H, WORLD_W } from "./worldgen";

export const SAVE_VERSION = 3;

export type WorldBoxSaveData = {
  version: number;
  /** 5枠スロット（空きは null）。 */
  slots: ({ id: number; count: number } | null)[];
  player: { x: number; y: number };
  hp: number;
};

/** プレイヤー状態（世界タイルは含まない）。 */
export type WorldBoxState = {
  inventory: InventoryV2;
  player: { x: number; y: number };
  hp: number;
};

export function encodeTiles(tiles: Uint8Array): string {
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < tiles.length; i += chunk) {
    bin += String.fromCharCode(...tiles.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function decodeTiles(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    if (bin.length !== WORLD_W * WORLD_H) return null;
    const tiles = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) tiles[i] = bin.charCodeAt(i);
    return tiles;
  } catch {
    return null;
  }
}

function sanitizeSlot(raw: unknown): InvSlot {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as { id?: unknown; count?: unknown };
  if (!Number.isInteger(v.id) || typeof v.count !== "number" || !Number.isFinite(v.count) || v.count <= 0) return null;
  const id = v.id as number;
  // 道具は1つまで（壊れたデータで増殖させない）
  return { id, count: isTool(id) ? 1 : Math.floor(v.count) };
}

function sanitizeSlots(raw: unknown): InvSlot[] {
  const slots: InvSlot[] = Array.from({ length: SLOT_COUNT }, () => null);
  if (!Array.isArray(raw)) return slots;
  const seenTools = new Set<number>();
  for (let i = 0; i < Math.min(SLOT_COUNT, raw.length); i++) {
    const slot = sanitizeSlot(raw[i]);
    if (slot && isTool(slot.id)) {
      if (seenTools.has(slot.id)) continue;
      seenTools.add(slot.id);
    }
    slots[i] = slot;
  }
  return slots;
}

function sanitizeHp(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.max(1, Math.min(PLAYER_MAX_HP, Math.floor(raw)))
    : PLAYER_MAX_HP;
}

export function serializeSave(state: WorldBoxState): string {
  const data: WorldBoxSaveData = {
    version: SAVE_VERSION,
    slots: state.inventory.slots.map((slot) => (slot ? { id: slot.id, count: slot.count } : null)),
    player: { x: state.player.x, y: state.player.y },
    hp: sanitizeHp(state.hp),
  };
  return JSON.stringify(data);
}

type RawSave = {
  version?: unknown;
  inventory?: unknown;
  slots?: unknown;
  player?: { x?: unknown; y?: unknown };
  hp?: unknown;
};

/** v1 の Record 形インベントリを5枠スロットへ移行する（ホットバー順に先着5種）。 */
function migrateV1Inventory(raw: unknown): InventoryV2 {
  const inv = createInventory();
  if (!raw || typeof raw !== "object") return inv;
  const record = raw as Record<string, unknown>;
  let placed = 0;
  for (const id of HOTBAR_BLOCKS) {
    if (placed >= SLOT_COUNT) break;
    const count = record[String(id)];
    if (typeof count === "number" && count > 0) {
      inv.slots[placed++] = { id, count: Math.floor(count) };
    }
  }
  return inv;
}

/**
 * 壊れている・形が違う場合は null（新規プレイヤー状態にフォールバック）。
 * v1/v2 のセーブはタイルを破棄してプレイヤー状態だけ移行する。
 */
export function parseSave(json: string | null | undefined): WorldBoxState | null {
  if (!json) return null;
  try {
    const data = JSON.parse(json) as RawSave;
    if (data.version !== 1 && data.version !== 2 && data.version !== SAVE_VERSION) return null;
    if (!data.player || typeof data.player.x !== "number" || typeof data.player.y !== "number") return null;
    if (!Number.isFinite(data.player.x) || !Number.isFinite(data.player.y)) return null;
    const player = { x: data.player.x, y: data.player.y };
    if (data.version === 1) {
      return { inventory: migrateV1Inventory(data.inventory), player, hp: PLAYER_MAX_HP };
    }
    // v2 / v3: スロット・HP・位置だけを引き継ぐ（v2 のタイル・位相・シードは破棄）
    return {
      inventory: { slots: sanitizeSlots(data.slots) },
      player,
      hp: sanitizeHp(data.hp),
    };
  } catch {
    return null;
  }
}
