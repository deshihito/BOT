// AGO WORLD BOX のセーブデータ変換（純粋ロジック）。
// localStorage への読み書き自体はクライアント側で行い、ここは
// 「状態 ⇄ JSON 文字列」の変換と検証だけを担う（壊れたデータは null を返す）。
import { WORLD_H, WORLD_W } from "./worldgen";

export const SAVE_VERSION = 1;

export type WorldBoxSaveData = {
  version: number;
  seed: number;
  /** タイル配列（WORLD_W * WORLD_H）を base64 化したもの。 */
  tilesB64: string;
  /** ブロック ID → 所持数。 */
  inventory: Record<string, number>;
  player: { x: number; y: number };
};

export type WorldBoxState = {
  seed: number;
  tiles: Uint8Array;
  inventory: Record<number, number>;
  player: { x: number; y: number };
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

export function serializeSave(state: WorldBoxState): string {
  const inventory: Record<string, number> = {};
  for (const [k, v] of Object.entries(state.inventory)) {
    if (v > 0) inventory[k] = v;
  }
  const data: WorldBoxSaveData = {
    version: SAVE_VERSION,
    seed: state.seed,
    tilesB64: encodeTiles(state.tiles),
    inventory,
    player: { x: state.player.x, y: state.player.y },
  };
  return JSON.stringify(data);
}

/** 壊れている・形が違う・寸法が合わない場合は null（新規ワールドにフォールバック）。 */
export function parseSave(json: string | null | undefined): WorldBoxState | null {
  if (!json) return null;
  try {
    const data = JSON.parse(json) as Partial<WorldBoxSaveData>;
    if (data.version !== SAVE_VERSION) return null;
    if (typeof data.seed !== "number" || !Number.isFinite(data.seed)) return null;
    if (typeof data.tilesB64 !== "string") return null;
    const tiles = decodeTiles(data.tilesB64);
    if (!tiles) return null;
    if (!data.player || typeof data.player.x !== "number" || typeof data.player.y !== "number") return null;
    if (!Number.isFinite(data.player.x) || !Number.isFinite(data.player.y)) return null;
    const inventory: Record<number, number> = {};
    if (data.inventory && typeof data.inventory === "object") {
      for (const [k, v] of Object.entries(data.inventory)) {
        const id = Number(k);
        if (Number.isInteger(id) && typeof v === "number" && v > 0) inventory[id] = Math.floor(v);
      }
    }
    return { seed: data.seed, tiles, inventory, player: { x: data.player.x, y: data.player.y } };
  } catch {
    return null;
  }
}
