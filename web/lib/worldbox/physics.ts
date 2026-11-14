// AGO WORLD BOX のプレイヤー物理（純粋ロジック）。
// 座標はタイル単位の浮動小数。x/y はプレイヤー矩形の左上。
import { isSolidBlock } from "./blocks";
import { getTile, type World } from "./worldgen";

export const PLAYER_W = 0.8;
export const PLAYER_H = 1.8;
export const RUN_SPEED = 6.2; // タイル/秒
export const GRAVITY = 30; // タイル/秒^2
export const JUMP_VELOCITY = 11.8;
export const MAX_FALL = 19;

export type PlayerBody = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 1 = 右向き、-1 = 左向き。 */
  face: 1 | -1;
  onGround: boolean;
};

export type MoveInput = { left: boolean; right: boolean; jump: boolean; fastFall: boolean };

export function createBody(x: number, y: number): PlayerBody {
  return { x, y, vx: 0, vy: 0, face: 1, onGround: false };
}

function solidAt(world: World, tx: number, ty: number): boolean {
  return isSolidBlock(getTile(world, tx, ty));
}

/** 矩形が固体タイルと重なっているか。 */
export function bodyCollides(world: World, x: number, y: number): boolean {
  const x0 = Math.floor(x);
  const x1 = Math.floor(x + PLAYER_W - 1e-6);
  const y0 = Math.floor(y);
  const y1 = Math.floor(y + PLAYER_H - 1e-6);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (solidAt(world, tx, ty)) return true;
    }
  }
  return false;
}

/**
 * 1 ステップ分の移動と衝突解決。軸分離で解くので、壁ずり・着地が安定する。
 * body を直接書き換える。dt はクライアント側で上限を切って渡すこと。
 */
export function stepPlayer(world: World, body: PlayerBody, input: MoveInput, dt: number): void {
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  body.vx = dir * RUN_SPEED;
  if (dir !== 0) body.face = dir > 0 ? 1 : -1;

  if (input.jump && body.onGround) {
    body.vy = -JUMP_VELOCITY;
    body.onGround = false;
  }
  body.vy += GRAVITY * dt * (input.fastFall ? 2.2 : 1);
  const maxFall = input.fastFall ? MAX_FALL * 1.6 : MAX_FALL;
  if (body.vy > maxFall) body.vy = maxFall;

  // X 軸
  if (body.vx !== 0) {
    let nx = body.x + body.vx * dt;
    if (bodyCollides(world, nx, body.y)) {
      if (body.vx > 0) nx = Math.floor(nx + PLAYER_W - 1e-6) - PLAYER_W - 1e-4;
      else nx = Math.floor(nx) + 1 + 1e-4;
      // 一回で寄せきれない場合（高速時）は元の位置に戻す
      if (bodyCollides(world, nx, body.y)) nx = body.x;
      body.vx = 0;
    }
    body.x = nx;
  }

  // Y 軸
  body.onGround = false;
  if (body.vy !== 0) {
    let ny = body.y + body.vy * dt;
    if (bodyCollides(world, body.x, ny)) {
      if (body.vy > 0) {
        ny = Math.floor(ny + PLAYER_H - 1e-6) - PLAYER_H - 1e-4;
        body.onGround = true;
      } else {
        ny = Math.floor(ny) + 1 + 1e-4;
      }
      if (bodyCollides(world, body.x, ny)) ny = body.y;
      body.vy = 0;
    }
    body.y = ny;
  }

  // 静止していても足元が無くなったら落ちるように、接地を再確認する
  if (!body.onGround && body.vy === 0) {
    body.onGround = bodyCollides(world, body.x, body.y + 0.05);
  }
  // ワールド左右端の外には出ない
  body.x = Math.max(0, Math.min(world.width - PLAYER_W, body.x));
  body.y = Math.min(world.height - PLAYER_H, body.y);
}
