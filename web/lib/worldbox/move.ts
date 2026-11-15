// AGO WORLD BOX 見下ろし型の移動と当たり判定（純粋ロジック）。
// プレイヤーは半径 PLAYER_RADIUS の円として、固体タイル（水・木・岩）と
// 軸分離で衝突する。位置はタイル単位の浮動小数（タイル中心が .5）。
import { isSolidMapTile, mapTileAt, type TopDownMap } from "./mapgen";

/** 歩行速度（タイル/秒）。 */
export const WALK_SPEED = 4.4;
/** プレイヤーの当たり半径（タイル）。 */
export const PLAYER_RADIUS = 0.32;

export type MoveResult = {
  x: number;
  y: number;
  hitX: boolean;
  hitY: boolean;
};

/** 円（中心 cx, cy・半径 r）が固体タイルに触れているか。 */
export function circleHitsSolid(map: TopDownMap, cx: number, cy: number, r: number): boolean {
  const x0 = Math.floor(cx - r);
  const x1 = Math.floor(cx + r);
  const y0 = Math.floor(cy - r);
  const y1 = Math.floor(cy + r);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (!isSolidMapTile(mapTileAt(map, tx, ty))) continue;
      const closestX = Math.max(tx, Math.min(cx, tx + 1));
      const closestY = Math.max(ty, Math.min(cy, ty + 1));
      const dx = cx - closestX;
      const dy = cy - closestY;
      if (dx * dx + dy * dy < r * r) return true;
    }
  }
  return false;
}

/**
 * 速度 vel（タイル/秒）で dt 秒進める。軸分離で壁に沿って滑る。
 * マップ外には出ない（端で止まる）。
 */
export function stepMove(map: TopDownMap, pos: { x: number; y: number }, vel: { x: number; y: number }, dt: number): MoveResult {
  const r = PLAYER_RADIUS;
  let { x, y } = pos;
  let hitX = false;
  let hitY = false;

  const nx = x + vel.x * dt;
  if (circleHitsSolid(map, nx, y, r)) hitX = true;
  else x = nx;

  const ny = y + vel.y * dt;
  if (circleHitsSolid(map, x, ny, r)) hitY = true;
  else y = ny;

  x = Math.max(r, Math.min(map.width - r, x));
  y = Math.max(r, Math.min(map.height - r, y));
  return { x, y, hitX, hitY };
}

/** その地点に立てるか（固体にめり込んでいないか）。 */
export function canStandAt(map: TopDownMap, x: number, y: number): boolean {
  return !circleHitsSolid(map, x, y, PLAYER_RADIUS);
}

/** 固体に埋まっていたら、近くの立てる場所を探す（ロード時の救済）。 */
export function findFreeNear(map: TopDownMap, x: number, y: number): { x: number; y: number } {
  if (canStandAt(map, x, y)) return { x, y };
  for (let ring = 1; ring <= 8; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const cx = x + dx;
        const cy = y + dy;
        if (cx < 1 || cy < 1 || cx > map.width - 1 || cy > map.height - 1) continue;
        if (canStandAt(map, cx, cy)) return { x: cx, y: cy };
      }
    }
  }
  return { x: Math.floor(map.width / 2) + 0.5, y: Math.floor(map.height / 2) + 0.5 };
}
