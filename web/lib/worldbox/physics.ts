// AGO WORLD BOX のプレイヤー物理（純粋ロジック）。
// 座標はタイル単位の浮動小数。x/y はプレイヤー矩形の左上。
import { isFullSolidBlock, isOneWayBlock, isSolidBlock } from "./blocks";
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
  /** ノックバックの横速度（入力速度に加算され、時間で減衰する）。 */
  kx: number;
  /** 空中での最高到達点（最小 y）。落下ダメージ計算用。 */
  airPeakY: number | null;
  /** このステップで着地した場合の落下距離（タイル）。着地しなければ 0。 */
  landedFall: number;
  /** すり抜け中（one-way を無効化する）残り秒数。 */
  dropTimer: number;
};

export type MoveInput = {
  left: boolean;
  right: boolean;
  jump: boolean;
  fastFall: boolean;
  /** アナログ入力（ジョイスティック）: -1〜1。指定時は left/right より優先。 */
  moveX?: number;
  /** one-way の上に立っているときの下入力（すり抜けて落ちる）。 */
  dropThrough?: boolean;
};

/** すり抜けの持続秒数（1〜2タイル厚の葉の層を抜け切れる長さ）。 */
export const DROP_THROUGH_SEC = 0.25;

export function createBody(x: number, y: number): PlayerBody {
  return { x, y, vx: 0, vy: 0, face: 1, onGround: false, kx: 0, airPeakY: null, landedFall: 0, dropTimer: 0 };
}

function solidAt(world: World, tx: number, ty: number): boolean {
  return isSolidBlock(getTile(world, tx, ty));
}

/** 任意サイズの矩形が固体タイルと重なっているか。 */
export function rectCollides(world: World, x: number, y: number, w: number, h: number): boolean {
  const x0 = Math.floor(x);
  const x1 = Math.floor(x + w - 1e-6);
  const y0 = Math.floor(y);
  const y1 = Math.floor(y + h - 1e-6);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (solidAt(world, tx, ty)) return true;
    }
  }
  return false;
}

/** プレイヤー矩形が固体タイルと重なっているか。 */
export function bodyCollides(world: World, x: number, y: number): boolean {
  return rectCollides(world, x, y, PLAYER_W, PLAYER_H);
}

function fullSolidAt(world: World, tx: number, ty: number): boolean {
  return isFullSolidBlock(getTile(world, tx, ty));
}

/** 任意サイズの矩形が「全面固体」タイルと重なっているか（one-way・松明は除く）。壁判定はこちら。 */
export function rectCollidesFull(world: World, x: number, y: number, w: number, h: number): boolean {
  const x0 = Math.floor(x);
  const x1 = Math.floor(x + w - 1e-6);
  const y0 = Math.floor(y);
  const y1 = Math.floor(y + h - 1e-6);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (fullSolidAt(world, tx, ty)) return true;
    }
  }
  return false;
}

/** プレイヤー矩形が全面固体タイルと重なっているか。 */
export function bodyCollidesFull(world: World, x: number, y: number): boolean {
  return rectCollidesFull(world, x, y, PLAYER_W, PLAYER_H);
}

/**
 * 落下中の矩形が「このステップで上面を横切った」one-way タイルの上面（最小の ty）。
 * 前フレームの足元（prevBottom）が上面より上（≒同位置含む）にあったタイルだけが対象で、
 * 下から跳び上がっている途中・既に下に入り込んでいるタイルは通り抜ける。
 * 該当がなければ null。
 */
export function oneWayLandingTop(world: World, x: number, y: number, w: number, h: number, prevBottom: number): number | null {
  const x0 = Math.floor(x);
  const x1 = Math.floor(x + w - 1e-6);
  const y0 = Math.floor(y);
  const y1 = Math.floor(y + h - 1e-6);
  let best: number | null = null;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (!isOneWayBlock(getTile(world, tx, ty))) continue;
      if (prevBottom <= ty + 0.01 && (best === null || ty < best)) best = ty;
    }
  }
  return best;
}

/**
 * 矩形の足元が one-way タイルの上面付近（±0.09）にある場合、その上面（最小の ty）。
 * 「上に立っている」判定用。タイルの中にめり込んでいる場合は対象外。
 */
export function oneWayStandTop(world: World, x: number, y: number, w: number, h: number): number | null {
  const bottom = y + h;
  const x0 = Math.floor(x);
  const x1 = Math.floor(x + w - 1e-6);
  const y0 = Math.floor(y);
  const y1 = Math.floor(bottom + 0.09);
  let best: number | null = null;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (!isOneWayBlock(getTile(world, tx, ty))) continue;
      if (Math.abs(ty - bottom) <= 0.09 && (best === null || ty < best)) best = ty;
    }
  }
  return best;
}

/**
 * 1 ステップ分の移動と衝突解決。軸分離で解くので、壁ずり・着地が安定する。
 * body を直接書き換える。dt はクライアント側で上限を切って渡すこと。
 */
/** ジョイスティックのデッドゾーン（これ未満の傾きは停止扱い）。 */
export const STICK_DEADZONE = 0.18;

export function stepPlayer(world: World, body: PlayerBody, input: MoveInput, dt: number): void {
  body.landedFall = 0;
  const wasGround = body.onGround;
  body.dropTimer = Math.max(0, body.dropTimer - dt);
  // one-way の上に立っているときの下入力: しばらく one-way を無効化して落ちる
  if (input.dropThrough && body.onGround && oneWayStandTop(world, body.x, body.y, PLAYER_W, PLAYER_H) !== null) {
    body.dropTimer = DROP_THROUGH_SEC;
  }
  let dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let analog = 0;
  if (typeof input.moveX === "number" && Number.isFinite(input.moveX)) {
    const mx = Math.max(-1, Math.min(1, input.moveX));
    analog = Math.abs(mx) < STICK_DEADZONE ? 0 : mx;
    dir = analog !== 0 ? Math.sign(analog) : 0;
  }
  // アナログ時は傾きの大きさがそのまま速さになる（小さい傾き = 歩き、最大 = 走り）
  body.vx = (analog !== 0 ? analog * RUN_SPEED : dir * RUN_SPEED) + body.kx;
  if (dir !== 0) body.face = dir > 0 ? 1 : -1;
  // ノックバックは時間で減衰する
  const decay = Math.max(0, 1 - dt * 9);
  body.kx *= decay;
  if (Math.abs(body.kx) < 0.05) body.kx = 0;

  if (input.jump && body.onGround) {
    body.vy = -JUMP_VELOCITY;
    body.onGround = false;
  }
  body.vy += GRAVITY * dt * (input.fastFall ? 2.2 : 1);
  const maxFall = input.fastFall ? MAX_FALL * 1.6 : MAX_FALL;
  if (body.vy > maxFall) body.vy = maxFall;

  // 落下距離の計測: 空中では最高点を覚え、着地した瞬間に距離を確定する
  if (!wasGround) {
    body.airPeakY = body.airPeakY === null ? body.y : Math.min(body.airPeakY, body.y);
  }

  // X 軸（one-way は横からは通り抜けるので全面固体だけを見る）
  if (body.vx !== 0) {
    let nx = body.x + body.vx * dt;
    if (bodyCollidesFull(world, nx, body.y)) {
      if (body.vx > 0) nx = Math.floor(nx + PLAYER_W - 1e-6) - PLAYER_W - 1e-4;
      else nx = Math.floor(nx) + 1 + 1e-4;
      // 一回で寄せきれない場合（高速時）は元の位置に戻す
      if (bodyCollidesFull(world, nx, body.y)) nx = body.x;
      body.vx = 0;
    }
    body.x = nx;
  }

  // Y 軸
  body.onGround = false;
  if (body.vy !== 0) {
    const prevBottom = body.y + PLAYER_H;
    let ny = body.y + body.vy * dt;
    if (bodyCollidesFull(world, body.x, ny)) {
      if (body.vy > 0) {
        ny = Math.floor(ny + PLAYER_H - 1e-6) - PLAYER_H - 1e-4;
        body.onGround = true;
        // 着地: 空中の最高点からの落下距離を確定する
        if (!wasGround && body.airPeakY !== null) {
          body.landedFall = Math.max(0, ny - body.airPeakY);
        }
        body.airPeakY = null;
      } else {
        ny = Math.floor(ny) + 1 + 1e-4;
      }
      if (bodyCollidesFull(world, body.x, ny)) ny = body.y;
      body.vy = 0;
    } else if (body.vy > 0 && body.dropTimer <= 0) {
      // one-way の上面着地: 落下中で、直前の足元が上面より上にあったときだけ乗る
      const top = oneWayLandingTop(world, body.x, ny, PLAYER_W, PLAYER_H, prevBottom);
      if (top !== null) {
        ny = top - PLAYER_H - 1e-4;
        body.onGround = true;
        if (!wasGround && body.airPeakY !== null) {
          body.landedFall = Math.max(0, ny - body.airPeakY);
        }
        body.airPeakY = null;
        body.vy = 0;
      }
    }
    body.y = ny;
  }

  // 静止していても足元が無くなったら落ちるように、接地を再確認する
  if (!body.onGround && body.vy === 0) {
    body.onGround =
      bodyCollidesFull(world, body.x, body.y + 0.05) ||
      (body.dropTimer <= 0 && oneWayStandTop(world, body.x, body.y, PLAYER_W, PLAYER_H) !== null);
  }
  if (body.onGround) body.airPeakY = null;
  // ワールド左右端の外には出ない
  body.x = Math.max(0, Math.min(world.width - PLAYER_W, body.x));
  body.y = Math.min(world.height - PLAYER_H, body.y);
}
