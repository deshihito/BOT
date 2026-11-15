// AGO WORLD BOX のタイル上書きの保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_tiles"、キー = "x,y"）。
// 上書きはまばらにしか存在しないため、一覧は kvList で読み、
// 書き込みはタイル単位で行う。
import { isBotApiConfigured, kvDelete, kvGet, kvList, kvSet } from "../bot-api";
import {
  parseTileOverride, parseTileOverrides, tileKey,
  type TileOverride, type TileOverridesMap,
} from "./tiles";

export const WORLDBOX_TILES_NAMESPACE = "worldbox_tiles";

export function isTilesEnabled(): boolean {
  return isBotApiConfigured();
}

/** 保存済みの上書きをすべて読む。無い・読めない・未設定なら空。 */
export async function loadTileOverrides(): Promise<TileOverridesMap> {
  if (!isBotApiConfigured()) return {};
  try {
    return parseTileOverrides(await kvList(WORLDBOX_TILES_NAMESPACE));
  } catch {
    return {};
  }
}

/** 1タイルの上書きを読む。 */
export async function loadTileOverride(x: number, y: number): Promise<TileOverride | null> {
  if (!isBotApiConfigured()) return null;
  try {
    return parseTileOverride(await kvGet(WORLDBOX_TILES_NAMESPACE, tileKey(x, y)));
  } catch {
    return null;
  }
}

/** 1タイルの上書きを保存する（null は削除）。成功したら true。 */
export async function storeTileOverride(
  x: number,
  y: number,
  override: TileOverride | null,
): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    if (override === null) await kvDelete(WORLDBOX_TILES_NAMESPACE, tileKey(x, y));
    else await kvSet(WORLDBOX_TILES_NAMESPACE, tileKey(x, y), JSON.stringify(override));
    return true;
  } catch {
    return false;
  }
}
