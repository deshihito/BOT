// AGO WORLD BOX 見下ろし型の移動と当たり判定（純粋ロジック）。
// プレイヤーは半径 PLAYER_RADIUS の円として、固体タイル（水・木・岩）と
// 軸分離で衝突する。位置はタイル単位の浮動小数（タイル中心が .5）。
// swim オプションを渡すと水タイルだけは固体でなくなり、水に入れる。
import { T_WATER, isSolidMapTile, mapTileAt, type TopDownMap } from "./mapgen";

/** 歩行速度（タイル/秒）。 */
export const WALK_SPEED = 4.4;
/** ダッシュ速度（タイル/秒）。 */
export const DASH_SPEED = 7.0;
/** 泳ぎ速度（タイル/秒）。 */
export const SWIM_SPEED = 3.0;
/** ダッシュ泳ぎ速度（タイル/秒）。 */
export const SWIM_DASH_SPEED = 5.4;
/** プレイヤーの当たり半径（タイル）。 */
export const PLAYER_RADIUS = 0.32;

/** 移動オプション。swim=true のとき水タイルを通れる（ロビーでは使わない）。 */
export type MoveOptions = { swim?: boolean };

function isSolidFor(map: TopDownMap, tx: number, ty: number, swim: boolean): boolean {
  const id = mapTileAt(map, tx, ty);
  if (swim && id === T_WATER) return false;
  return isSolidMapTile(id);
}

export type MoveResult = {
  x: number;
  y: number;
  hitX: boolean;
  hitY: boolean;
};

/** 追加で固体扱いするタイル集合（"x,y" キー）。建物など動的な障害物用。 */
export type BlockedTiles = ReadonlySet<string>;

/** 円（中心 cx, cy・半径 r）が固体タイルに触れているか。 */
export function circleHitsSolid(map: TopDownMap, cx: number, cy: number, r: number, blocked?: BlockedTiles, opts?: MoveOptions): boolean {
  const swim = opts?.swim === true;
  const x0 = Math.floor(cx - r);
  const x1 = Math.floor(cx + r);
  const y0 = Math.floor(cy - r);
  const y1 = Math.floor(cy + r);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const solid = isSolidFor(map, tx, ty, swim) || (blocked?.has(`${tx},${ty}`) ?? false);
      if (!solid) continue;
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
 * ワールドに境界は無い（座標は実質無制限）。有限空間（ロビー）は
 * タイル源の範囲外が岩になることで端が壁になる。
 */
export function stepMove(
  map: TopDownMap,
  pos: { x: number; y: number },
  vel: { x: number; y: number },
  dt: number,
  blocked?: BlockedTiles,
  opts?: MoveOptions,
): MoveResult {
  const r = PLAYER_RADIUS;
  let { x, y } = pos;
  let hitX = false;
  let hitY = false;

  const nx = x + vel.x * dt;
  if (circleHitsSolid(map, nx, y, r, blocked, opts)) hitX = true;
  else x = nx;

  const ny = y + vel.y * dt;
  if (circleHitsSolid(map, x, ny, r, blocked, opts)) hitY = true;
  else y = ny;

  return { x, y, hitX, hitY };
}

/** その地点に立てるか（固体にめり込んでいないか）。 */
export function canStandAt(map: TopDownMap, x: number, y: number, blocked?: BlockedTiles, opts?: MoveOptions): boolean {
  return !circleHitsSolid(map, x, y, PLAYER_RADIUS, blocked, opts);
}

/** 固体に埋まっていたら、近くの立てる場所を探す（ロード時の救済）。 */
export function findFreeNear(map: TopDownMap, x: number, y: number, blocked?: BlockedTiles, opts?: MoveOptions): { x: number; y: number } {
  if (canStandAt(map, x, y, blocked, opts)) return { x, y };
  for (let ring = 1; ring <= 8; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const cx = x + dx;
        const cy = y + dy;
        if (canStandAt(map, cx, cy, blocked, opts)) return { x: cx, y: cy };
      }
    }
  }
  return { x, y };
}

/** その地点の足元が水か（中心タイルで判定）。 */
export function isWaterAt(map: TopDownMap, x: number, y: number): boolean {
  return mapTileAt(map, Math.floor(x), Math.floor(y)) === T_WATER;
}
