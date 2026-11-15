// AGO WORLD BOX の釣り（バッチ8b-2）。
// 魚影（fishing_spot）は特殊オブジェクトとして水辺に決定的に配置される。
// ここは「その座標に魚影があるか」と再出現の判定だけを持ち、状態の保存は
// fishing-online.ts、検証と付与はルートが担う。
import { CHUNK_SIZE } from "./mapgen";
import { objectsForChunk, specialObjectById, type PlacedObject } from "./objects";

export const FISHING_SPOT_ID = "fishing_spot";

/** その座標にある魚影。無ければ null。 */
export function fishingSpotAt(seed: number, x: number, y: number): PlacedObject | null {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cy = Math.floor(y / CHUNK_SIZE);
  return (
    objectsForChunk(seed, cx, cy).find((o) => o.objectId === FISHING_SPOT_ID && o.x === x && o.y === y) ??
    null
  );
}

/** 釣れる状態か（前回から再出現時間が過ぎているか）。 */
export function fishingReady(caughtAt: number | null, now: number): boolean {
  const def = specialObjectById(FISHING_SPOT_ID);
  if (!def) return false;
  if (caughtAt === null) return true;
  return now - caughtAt >= def.respawnMs;
}

/** ルートの nonce: 再出現サイクルごとに変わる決定的な値。 */
export function fishingNonce(caughtAt: number | null, now: number): number {
  const def = specialObjectById(FISHING_SPOT_ID);
  if (!def || def.respawnMs <= 0) return 0;
  return Math.floor(now / def.respawnMs);
}
