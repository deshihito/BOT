// AGO WORLD BOX の敵（純粋ロジック）。
// 夜だけ地表に現れる歩行型。プレイヤーへ歩いて近づき、触れると
// ダメージ＋ノックバックを与える。朝になると燃えて消える。
// 倒すと確率でハート（回復の拾い物）を落とす。
import { GRAVITY, MAX_FALL, rectCollides } from "./physics";
import { isNightPhase } from "./daynight";
import { getTile, type World } from "./worldgen";
import { isSolidBlock } from "./blocks";

export const ENEMY_W = 0.9;
export const ENEMY_H = 0.9;
export const ENEMY_MAX_HP = 6;
export const ENEMY_SPEED = 1.7;
/** 同時に存在できる敵の上限。 */
export const MAX_ENEMIES = 4;
/** 接触ダメージ（HP は最大10）。 */
export const CONTACT_DAMAGE = 2;
/** スポーン試行の間隔（秒）。 */
export const SPAWN_INTERVAL_SEC = 2.5;
/** 倒したときにハートを落とす確率。 */
export const HEART_DROP_CHANCE = 0.3;
/** 朝の燃焼速度（HP/秒）。夜が明けたら数秒で消える。 */
export const DAWN_BURN_PER_SEC = 3;

export type Enemy = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** ノックバックの横速度（減衰する）。 */
  kx: number;
  hp: number;
  face: 1 | -1;
  onGround: boolean;
};

let enemySeq = 1;

export function createEnemy(x: number, y: number): Enemy {
  return { id: enemySeq++, x, y, vx: 0, vy: 0, kx: 0, hp: ENEMY_MAX_HP, face: 1, onGround: false };
}

/** 地表（上から走査して最初の固体タイル）の y。見つからなければ null。 */
function surfaceYAt(world: World, x: number): number | null {
  for (let y = 0; y < world.height; y++) {
    if (isSolidBlock(getTile(world, x, y))) return y;
  }
  return null;
}

/**
 * 夜なら敵1体をスポーンさせる（条件を満たさなければ null）。
 * プレイヤーの左右 10〜15 タイル先の地表に、プレイヤーとは重ならない位置へ。
 */
export function trySpawnEnemy(
  world: World,
  phase: number,
  player: { x: number; y: number },
  aliveCount: number,
  rng: () => number,
): Enemy | null {
  if (!isNightPhase(phase)) return null;
  if (aliveCount >= MAX_ENEMIES) return null;
  const side = rng() < 0.5 ? -1 : 1;
  const dist = 10 + Math.floor(rng() * 6); // 10〜15
  const tx = Math.max(1, Math.min(world.width - 2, Math.floor(player.x) + side * dist));
  if (Math.abs(tx - player.x) < 8) return null;
  const surf = surfaceYAt(world, tx);
  if (surf === null) return null;
  const ex = tx + 0.05;
  const ey = surf - ENEMY_H;
  if (rectCollides(world, ex, ey, ENEMY_W, ENEMY_H)) return null;
  return createEnemy(ex, ey);
}

/** 敵を1ステップ進める（重力＋プレイヤー方向への歩行＋1段の段差は跳んで登る）。 */
export function stepEnemy(world: World, e: Enemy, playerCenterX: number, dt: number): void {
  const dir = playerCenterX < e.x + ENEMY_W / 2 ? -1 : 1;
  e.face = dir > 0 ? 1 : -1;
  e.vx = dir * ENEMY_SPEED + e.kx;
  e.kx *= Math.max(0, 1 - dt * 8);
  if (Math.abs(e.kx) < 0.05) e.kx = 0;
  e.vy = Math.min(MAX_FALL, e.vy + GRAVITY * dt);

  // X 軸
  if (e.vx !== 0) {
    let nx = e.x + e.vx * dt;
    if (rectCollides(world, nx, e.y, ENEMY_W, ENEMY_H)) {
      // 1段だけなら跳んで登る。それ以外は壁際で止まる
      if (e.onGround && !rectCollides(world, nx, e.y - 1.05, ENEMY_W, ENEMY_H)) {
        e.vy = -9.5;
        nx = e.x;
      } else {
        nx = e.vx > 0 ? Math.floor(nx + ENEMY_W - 1e-6) - ENEMY_W - 1e-4 : Math.floor(nx) + 1 + 1e-4;
        if (rectCollides(world, nx, e.y, ENEMY_W, ENEMY_H)) nx = e.x;
      }
      e.vx = 0;
    }
    e.x = nx;
  }

  // Y 軸
  e.onGround = false;
  if (e.vy !== 0) {
    let ny = e.y + e.vy * dt;
    if (rectCollides(world, e.x, ny, ENEMY_W, ENEMY_H)) {
      if (e.vy > 0) {
        ny = Math.floor(ny + ENEMY_H - 1e-6) - ENEMY_H - 1e-4;
        e.onGround = true;
      } else {
        ny = Math.floor(ny) + 1 + 1e-4;
      }
      if (rectCollides(world, e.x, ny, ENEMY_W, ENEMY_H)) ny = e.y;
      e.vy = 0;
    }
    e.y = ny;
  }
  if (!e.onGround && e.vy === 0) {
    e.onGround = rectCollides(world, e.x, e.y + 0.05, ENEMY_W, ENEMY_H);
  }
  e.x = Math.max(0, Math.min(world.width - ENEMY_W, e.x));
  e.y = Math.min(world.height - ENEMY_H, e.y);
}

/**
 * 敵へ攻撃を当てる。ダメージとノックバックを与え、倒れたら true。
 * fromX は攻撃者の中心 x（ノックバック方向の決定に使う）。
 */
export function attackEnemy(e: Enemy, damage: number, fromX: number): boolean {
  if (damage <= 0 || e.hp <= 0) return e.hp <= 0;
  e.hp -= damage;
  const dir = e.x + ENEMY_W / 2 < fromX ? -1 : 1;
  e.kx = dir * 6.5;
  e.vy = Math.min(e.vy, -4.5);
  return e.hp <= 0;
}

/** 敵矩形と任意矩形の重なり（接触判定）。 */
export function enemyTouches(e: Enemy, body: { x: number; y: number; w: number; h: number }): boolean {
  return e.x < body.x + body.w && e.x + ENEMY_W > body.x && e.y < body.y + body.h && e.y + ENEMY_H > body.y;
}

/**
 * 夜明けの燃焼。昼間は全員が燃えて HP が減る。
 * 燃え尽きた敵の id 一覧を返す（ドロップは出さない）。
 */
export function burnEnemiesAtDawn(enemies: Enemy[], phase: number, dt: number): number[] {
  if (isNightPhase(phase)) return [];
  const dead: number[] = [];
  for (const e of enemies) {
    e.hp -= DAWN_BURN_PER_SEC * dt;
    if (e.hp <= 0) dead.push(e.id);
  }
  return dead;
}

/** 倒した敵がハートを落とすか（乱数は呼び出し側から注入して決定的に保つ）。 */
export function rollsHeartDrop(rng: () => number): boolean {
  return rng() < HEART_DROP_CHANCE;
}
