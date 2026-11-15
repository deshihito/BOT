// AGO WORLD BOX のセーブデータ変換（純粋ロジック）。
// localStorage / サーバー（bot_kv）の読み書き自体は呼び出し側で行い、ここは
// 「状態 ⇄ JSON 文字列」の変換と検証だけを担う（壊れたデータは null を返す）。
//
// v2: インベントリが5枠スロット形になり、HP と昼夜の位相も保存する。
// v1（枠なし Record 形）のセーブは読み込み時に v2 へ移行する:
// ホットバーの並び順に先頭から5種までをスロットへ入れ、残りは切り捨てる
// （v1 で6種以上を持っていた場合のみ発生。HP は満タン、位相は昼から）。
import { HOTBAR_BLOCKS } from "./blocks";
import { PLAYER_MAX_HP } from "./health";
import { SLOT_COUNT, createInventory, type InventoryV2, type InvSlot } from "./inventory";
import { isTool } from "./items";
import { START_PHASE } from "./daynight";
import { WORLD_H, WORLD_W } from "./worldgen";

export const SAVE_VERSION = 2;

export type WorldBoxSaveData = {
  version: number;
  seed: number;
  /** タイル配列（WORLD_W * WORLD_H）を base64 化したもの。 */
  tilesB64: string;
  /** 5枠スロット（空きは null）。 */
  slots: ({ id: number; count: number } | null)[];
  player: { x: number; y: number };
  hp: number;
  /** 昼夜の位相 0〜1。 */
  dayPhase: number;
};

export type WorldBoxState = {
  seed: number;
  tiles: Uint8Array;
  inventory: InventoryV2;
  player: { x: number; y: number };
  hp: number;
  dayPhase: number;
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

export function serializeSave(state: WorldBoxState): string {
  const data: WorldBoxSaveData = {
    version: SAVE_VERSION,
    seed: state.seed,
    tilesB64: encodeTiles(state.tiles),
    slots: state.inventory.slots.map((slot) => (slot ? { id: slot.id, count: slot.count } : null)),
    player: { x: state.player.x, y: state.player.y },
    hp: Math.max(1, Math.min(PLAYER_MAX_HP, Math.floor(state.hp) || PLAYER_MAX_HP)),
    dayPhase: ((state.dayPhase % 1) + 1) % 1,
  };
  return JSON.stringify(data);
}

type RawSave = {
  version?: unknown;
  seed?: unknown;
  tilesB64?: unknown;
  inventory?: unknown;
  slots?: unknown;
  player?: { x?: unknown; y?: unknown };
  hp?: unknown;
  dayPhase?: unknown;
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

/** 壊れている・形が違う・寸法が合わない場合は null（新規ワールドにフォールバック）。 */
export function parseSave(json: string | null | undefined): WorldBoxState | null {
  if (!json) return null;
  try {
    const data = JSON.parse(json) as RawSave;
    if (data.version !== 1 && data.version !== SAVE_VERSION) return null;
    if (typeof data.seed !== "number" || !Number.isFinite(data.seed)) return null;
    if (typeof data.tilesB64 !== "string") return null;
    const tiles = decodeTiles(data.tilesB64);
    if (!tiles) return null;
    if (!data.player || typeof data.player.x !== "number" || typeof data.player.y !== "number") return null;
    if (!Number.isFinite(data.player.x) || !Number.isFinite(data.player.y)) return null;
    const player = { x: data.player.x, y: data.player.y };
    if (data.version === 1) {
      return {
        seed: data.seed,
        tiles,
        inventory: migrateV1Inventory(data.inventory),
        player,
        hp: PLAYER_MAX_HP,
        dayPhase: START_PHASE,
      };
    }
    const hp = typeof data.hp === "number" && Number.isFinite(data.hp)
      ? Math.max(1, Math.min(PLAYER_MAX_HP, Math.floor(data.hp)))
      : PLAYER_MAX_HP;
    const dayPhase = typeof data.dayPhase === "number" && Number.isFinite(data.dayPhase)
      ? ((data.dayPhase % 1) + 1) % 1
      : START_PHASE;
    return {
      seed: data.seed,
      tiles,
      inventory: { slots: sanitizeSlots(data.slots) },
      player,
      hp,
      dayPhase,
    };
  } catch {
    return null;
  }
}
