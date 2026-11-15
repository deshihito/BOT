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

/** 名前空間を全件スキャンする（キャッシュの実読み）。 */
async function scanTileOverrides(): Promise<TileOverridesMap> {
  try {
    return parseTileOverrides(await kvList(WORLDBOX_TILES_NAMESPACE));
  } catch {
    return {};
  }
}

// 全件読みは名前空間が育つほど重く、クライアントは15秒間隔＋移動で
// 繰り返し叩くため、短TTLキャッシュで kvList の頻度を落とす。
// 書き込み（storeTileOverride）はキャッシュへも即時反映するので、
// 自分の行為の結果は次回読みでも必ず見える。
const OVERRIDES_CACHE_TTL_MS = 3_000;
let overridesCache: { at: number; map: TileOverridesMap } | null = null;

/** 保存済みの上書きをすべて読む（短TTLキャッシュつき）。無い・読めない・未設定なら空。 */
export async function loadTileOverrides(): Promise<TileOverridesMap> {
  if (!isBotApiConfigured()) return {};
  if (overridesCache && Date.now() - overridesCache.at < OVERRIDES_CACHE_TTL_MS) {
    return overridesCache.map;
  }
  const map = await scanTileOverrides();
  overridesCache = { at: Date.now(), map };
  return map;
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
    if (overridesCache) {
      const key = tileKey(x, y);
      if (override === null) delete overridesCache.map[key];
      else overridesCache.map[key] = override;
    }
    return true;
  } catch {
    return false;
  }
}
