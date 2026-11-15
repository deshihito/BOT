// AGO WORLD BOX の敵（純粋ロジック）。
// 「暗い場所」に現れる歩行型（v2.2〜: 夜の地表だけでなく、昼でも
// 暗い洞窟の中に出る。松明で照らした場所には出ない）。
// プレイヤーへ歩いて近づき、触れるとダメージ＋ノックバックを与える。
// 朝になっても燃えるのは上空に開けた場所にいる個体だけ（洞窟内は残る）。
// 倒すと確率でハート（回復の拾い物）を落とす。
import { GRAVITY, MAX_FALL, oneWayLandingTop, oneWayStandTop, rectCollidesFull } from "./physics";
import { isNightPhase } from "./daynight";
import { isDarkAt, isSkyExposed, type LightField } from "./light";
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

/** スポーン候補を探す試行回数（暗い着地点が見つからなければ今回は出ない）。 */
const SPAWN_ATTEMPTS = 8;
/** スポーン地点とプレイヤーの最低距離（中心間、タイル）。 */
const SPAWN_MIN_PLAYER_DIST = 6.5;

/**
 * 暗い場所に敵1体をスポーンさせる（条件を満たさなければ null）。
 * プレイヤーを中心とする半径 9〜14 の輪の内側から候補を引き、
 * 「足場がある・暗い・プレイヤーに近すぎない」地点にだけ出す。
 * 昼の地表は明るいので自然と出ず、夜の地表と暗い洞窟に出る。
 */
export function trySpawnEnemy(
  world: World,
  field: LightField,
  phase: number,
  player: { x: number; y: number },
  aliveCount: number,
  rng: () => number,
): Enemy | null {
  if (aliveCount >= MAX_ENEMIES) return null;
  const pcx = player.x + 0.4;
  const pcy = player.y + 0.9;
  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
    const angle = rng() * Math.PI * 2;
    const dist = 9 + rng() * 5;
    const tx = Math.max(1, Math.min(world.width - 2, Math.floor(pcx + Math.cos(angle) * dist)));
    const ty = Math.max(1, Math.min(world.height - 3, Math.floor(pcy + Math.sin(angle) * dist)));
    // 候補地点から下へ走査して「空きセルの真下に足場がある」着地点を探す
    for (let gy = ty; gy < Math.min(world.height - 1, ty + 7); gy++) {
      if (isSolidBlock(getTile(world, tx, gy))) break; // 岩盤の中には出ない
      if (!isSolidBlock(getTile(world, tx, gy + 1))) continue;
      // (tx, gy) が足元セル、(tx, gy+1) が足場
      const ex = tx + 0.05;
      const ey = gy + 1 - ENEMY_H;
      const ecx = ex + ENEMY_W / 2;
      const ecy = ey + ENEMY_H / 2;
      if (Math.hypot(ecx - pcx, ecy - pcy) < SPAWN_MIN_PLAYER_DIST) break;
      if (rectCollidesFull(world, ex, ey, ENEMY_W, ENEMY_H)) break;
      if (!isDarkAt(field, world, tx, gy, phase)) break;
      return createEnemy(ex, ey);
    }
  }
  return null;
}

/** 敵を1ステップ進める（重力＋プレイヤー方向への歩行＋1段の段差は跳んで登る）。 */
export function stepEnemy(world: World, e: Enemy, playerCenterX: number, dt: number): void {
  const dir = playerCenterX < e.x + ENEMY_W / 2 ? -1 : 1;
  e.face = dir > 0 ? 1 : -1;
  e.vx = dir * ENEMY_SPEED + e.kx;
  e.kx *= Math.max(0, 1 - dt * 8);
  if (Math.abs(e.kx) < 0.05) e.kx = 0;
  e.vy = Math.min(MAX_FALL, e.vy + GRAVITY * dt);

  // X 軸（one-way は横からは通り抜けるので全面固体だけを見る）
  if (e.vx !== 0) {
    let nx = e.x + e.vx * dt;
    if (rectCollidesFull(world, nx, e.y, ENEMY_W, ENEMY_H)) {
      // 1段だけなら跳んで登る。それ以外は壁際で止まる
      if (e.onGround && !rectCollidesFull(world, nx, e.y - 1.05, ENEMY_W, ENEMY_H)) {
        e.vy = -9.5;
        nx = e.x;
      } else {
        nx = e.vx > 0 ? Math.floor(nx + ENEMY_W - 1e-6) - ENEMY_W - 1e-4 : Math.floor(nx) + 1 + 1e-4;
        if (rectCollidesFull(world, nx, e.y, ENEMY_W, ENEMY_H)) nx = e.x;
      }
      e.vx = 0;
    }
    e.x = nx;
  }

  // Y 軸
  e.onGround = false;
  if (e.vy !== 0) {
    const prevBottom = e.y + ENEMY_H;
    let ny = e.y + e.vy * dt;
    if (rectCollidesFull(world, e.x, ny, ENEMY_W, ENEMY_H)) {
      if (e.vy > 0) {
        ny = Math.floor(ny + ENEMY_H - 1e-6) - ENEMY_H - 1e-4;
        e.onGround = true;
      } else {
        ny = Math.floor(ny) + 1 + 1e-4;
      }
      if (rectCollidesFull(world, e.x, ny, ENEMY_W, ENEMY_H)) ny = e.y;
      e.vy = 0;
    } else if (e.vy > 0) {
      // one-way の上面は着地面として扱う（葉の天蓋などに乗る）
      const top = oneWayLandingTop(world, e.x, ny, ENEMY_W, ENEMY_H, prevBottom);
      if (top !== null) {
        ny = top - ENEMY_H - 1e-4;
        e.onGround = true;
        e.vy = 0;
      }
    }
    e.y = ny;
  }
  if (!e.onGround && e.vy === 0) {
    e.onGround =
      rectCollidesFull(world, e.x, e.y + 0.05, ENEMY_W, ENEMY_H) ||
      oneWayStandTop(world, e.x, e.y, ENEMY_W, ENEMY_H) !== null;
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
 * 夜明けの燃焼。昼間、上空に開けた場所にいる個体だけが燃えて HP が減る。
 * 洞窟の中など空光が届かない場所の個体は燃えずに残る。
 * 燃え尽きた敵の id 一覧を返す（ドロップは出さない）。
 */
export function burnEnemiesAtDawn(world: World, field: LightField, enemies: Enemy[], phase: number, dt: number): number[] {
  if (isNightPhase(phase)) return [];
  const dead: number[] = [];
  for (const e of enemies) {
    const cx = Math.floor(e.x + ENEMY_W / 2);
    const cy = Math.floor(e.y + ENEMY_H / 2);
    if (!isSkyExposed(field, world, cx, cy)) continue;
    e.hp -= DAWN_BURN_PER_SEC * dt;
    if (e.hp <= 0) dead.push(e.id);
  }
  return dead;
}

/** 倒した敵がハートを落とすか（乱数は呼び出し側から注入して決定的に保つ）。 */
export function rollsHeartDrop(rng: () => number): boolean {
  return rng() < HEART_DROP_CHANCE;
}
