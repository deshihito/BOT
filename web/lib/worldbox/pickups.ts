// AGO WORLD BOX の拾い物（純粋ロジック）。
// 敵を倒したときのハートと、死亡時に落とした所持品がこの形で地面に残る。
// 重力で落ちて地面に止まり、プレイヤーが触れると回収される（実際の
// 回収効果は呼び出し側: ハートは回復、ブロックはインベントリへ）。
import { isSolidBlock } from "./blocks";
import { getTile, type World } from "./worldgen";

export const PICKUP_SIZE = 0.5;
/** ハート1つの回復量（HP は最大10 = ハート5個分）。 */
export const HEART_HEAL = 2;

export type Pickup = {
  id: number;
  kind: "heart" | "block";
  /** kind="block" のときのブロック ID。 */
  blockId: number;
  /** kind="block" のときの個数。 */
  count: number;
  x: number;
  y: number;
  vy: number;
  onGround: boolean;
};

let pickupSeq = 1;

export function createPickup(kind: "heart" | "block", blockId: number, count: number, x: number, y: number): Pickup {
  return { id: pickupSeq++, kind, blockId, count, x, y, vy: 0, onGround: false };
}

const PICKUP_GRAVITY = 26;
const PICKUP_MAX_FALL = 14;

/** 拾い物を1ステップ進める（落下して地面に止まるだけ。横移動はしない）。 */
export function stepPickup(world: World, p: Pickup, dt: number): void {
  p.vy = Math.min(PICKUP_MAX_FALL, p.vy + PICKUP_GRAVITY * dt);
  let ny = p.y + p.vy * dt;
  // 底辺が入るセルが固体なら、そのセルの上に止める
  const cellBelow = Math.floor(ny + PICKUP_SIZE);
  if (isSolidBlock(getTile(world, Math.floor(p.x + PICKUP_SIZE / 2), cellBelow))) {
    ny = cellBelow - PICKUP_SIZE;
    p.vy = 0;
    p.onGround = true;
  } else {
    p.onGround = false;
  }
  if (ny > world.height - PICKUP_SIZE) {
    ny = world.height - PICKUP_SIZE;
    p.vy = 0;
    p.onGround = true;
  }
  p.y = ny;
}

/** プレイヤー矩形と拾い物が触れているか。 */
export function pickupTouches(p: Pickup, body: { x: number; y: number; w: number; h: number }): boolean {
  return p.x < body.x + body.w && p.x + PICKUP_SIZE > body.x && p.y < body.y + body.h && p.y + PICKUP_SIZE > body.y;
}
