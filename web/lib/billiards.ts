// ビリヤード（簡易プール）の純粋ロジック（UI 非依存・シード決定的）。
// 手球1つ＋的球6つを、角度と強さで打ち、決定的なステップシミュレーション
// （ボール同士の弾性衝突・壁反射・摩擦・6つのポケット）で転がす。
// 的球を全て落とすまでの「打数＋スクラッチ（手球落ち）のペナルティ」の合計がスコアで、
// 小さいほど良い。初期配置はシード決定的（手球の縦位置とラック位置が少し変わる）。
// シミュレーション自体に乱数は使わないので、同じ入力は必ず同じ結果になる。

export const BL_WIDTH = 800;
export const BL_HEIGHT = 450;
export const BL_BALL_RADIUS = 11;
export const BL_POCKET_RADIUS = 21;
export const BL_OBJECT_BALLS = 6;
/** 手球を置き直す位置（ヘッドスポット）。 */
export const BL_HEAD_SPOT = { x: 190, y: 225 };

/** 6つのポケット（四隅＋左右の中央）。 */
export const BL_POCKETS: { x: number; y: number }[] = [
  { x: 22, y: 22 },
  { x: 400, y: 14 },
  { x: 778, y: 22 },
  { x: 22, y: 428 },
  { x: 400, y: 436 },
  { x: 778, y: 428 },
];

const STEP = 1 / 240;
const MAX_STEPS = 240 * 25;
const FRICTION = 130; // px/s^2
const BALL_RESTITUTION = 0.95;
const WALL_RESTITUTION = 0.75;
const STOP_SPEED = 5;
/** 強さ 0〜100 を初速（px/s）へ変換する。 */
const BASE_SPEED = 120;
const SPEED_PER_POWER = 12;

export interface BlPoint {
  x: number;
  y: number;
}

export interface BlBall extends BlPoint {
  /** 0 が手球、1〜6 が的球。 */
  id: number;
  pocketed: boolean;
}

export type BlPhase = "aiming" | "cleared";

export interface BilliardsState {
  seed: number;
  balls: BlBall[];
  /** 打った回数。 */
  shots: number;
  /** スクラッチ（手球落ち）の回数。スコアに +1 ずつ加算される。 */
  scratches: number;
  phase: BlPhase;
  /** 直前の1打で落ちた的球の id 列（表示用）。 */
  lastPocketed: number[];
  /** 直前の1打でスクラッチしたか。 */
  lastScratch: boolean;
}

export interface BlShotResult {
  /** アニメーション用フレーム列。各フレームは全ボールの位置（落ちた球は pocketed=true）。 */
  frames: BlBall[][];
  /** この1打で落ちた的球の id 列。 */
  pocketedIds: number[];
  /** 手球が落ちたか（スクラッチ）。 */
  scratch: boolean;
}

// ---------------------------------------------------------------- utilities

/** mulberry32。状態を数値で持ち回る。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 的球の色（id 1〜6）。Client の描画と共通の並び。 */
export const BL_BALL_COLORS: Record<number, string> = {
  1: "#f6c90e",
  2: "#2456c8",
  3: "#d43a2f",
  4: "#6b3fa0",
  5: "#ef7d1a",
  6: "#1d9e4b",
};

// ---------------------------------------------------------------- setup

export function createBilliardsGame(seed: number): BilliardsState {
  let rng = seed | 0;
  const draw = () => {
    const n = nextRandom(rng);
    rng = n.rng;
    return n.value;
  };
  // 手球の縦位置とラックの位置をシードで少しだけ動かす（重なりは起きない範囲）。
  const cueY = Math.round(165 + draw() * 120);
  const rackX = Math.round(545 + draw() * 40);
  const rackY = Math.round(205 + draw() * 40);
  const balls: BlBall[] = [{ id: 0, x: BL_HEAD_SPOT.x, y: cueY, pocketed: false }];
  // 三角ラック（1・2・3個の3列）。列間隔は直径の約0.87倍、縦間隔は直径+1。
  const dx = BL_BALL_RADIUS * 2 * 0.87;
  const dy = BL_BALL_RADIUS * 2 + 1;
  let id = 1;
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row <= col; row++) {
      balls.push({
        id: id++,
        x: rackX + col * dx,
        y: rackY + (row - col / 2) * dy,
        pocketed: false,
      });
    }
  }
  return {
    seed: seed | 0,
    balls,
    shots: 0,
    scratches: 0,
    phase: "aiming",
    lastPocketed: [],
    lastScratch: false,
  };
}

/** スコア（小さいほど良い）= 打数＋スクラッチ回数。 */
export function billiardsScore(state: BilliardsState): number {
  return state.shots + state.scratches;
}

/** 残っている的球の数。 */
export function remainingBalls(state: BilliardsState): number {
  return state.balls.filter((b) => b.id > 0 && !b.pocketed).length;
}

// ---------------------------------------------------------------- physics

interface SimBall extends BlPoint {
  id: number;
  vx: number;
  vy: number;
  pocketed: boolean;
}

/**
 * 1打のシミュレーション。決定的（同じ入力は必ず同じ結果）。
 * angleDeg は 0 が右、90 が下（画面座標 y 下向き）。puttgolf と同じ規約。
 */
export function simulateShot(
  ballsIn: BlBall[],
  angleDeg: number,
  power: number,
): BlShotResult {
  if (!Number.isFinite(angleDeg) || !Number.isFinite(power)) {
    return { frames: [clone(ballsIn)], pocketedIds: [], scratch: false };
  }
  const p = Math.max(0, Math.min(100, power));
  const rad = (angleDeg * Math.PI) / 180;
  const speed = BASE_SPEED + p * SPEED_PER_POWER;
  const balls: SimBall[] = ballsIn.map((b) => ({
    id: b.id,
    x: b.x,
    y: b.y,
    vx: b.id === 0 && !b.pocketed ? Math.cos(rad) * speed : 0,
    vy: b.id === 0 && !b.pocketed ? Math.sin(rad) * speed : 0,
    pocketed: b.pocketed,
  }));
  const snapshot = (): BlBall[] =>
    balls.map((b) => ({ id: b.id, x: b.x, y: b.y, pocketed: b.pocketed }));
  const frames: BlBall[][] = [snapshot()];
  const pocketedIds: number[] = [];
  let scratch = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    let anyMoving = false;
    // 摩擦
    for (const b of balls) {
      if (b.pocketed) continue;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp <= 0) continue;
      anyMoving = true;
      const dec = FRICTION * STEP;
      if (sp <= dec || sp < STOP_SPEED) {
        b.vx = 0;
        b.vy = 0;
      } else {
        const k = (sp - dec) / sp;
        b.vx *= k;
        b.vy *= k;
      }
    }
    if (!anyMoving) break;

    for (const b of balls) {
      if (b.pocketed) continue;
      b.x += b.vx * STEP;
      b.y += b.vy * STEP;
    }
    // ポケット（壁より先に判定する）
    for (const b of balls) {
      if (b.pocketed) continue;
      for (const pk of BL_POCKETS) {
        if (Math.hypot(b.x - pk.x, b.y - pk.y) <= BL_POCKET_RADIUS) {
          b.pocketed = true;
          b.vx = 0;
          b.vy = 0;
          if (b.id === 0) scratch = true;
          else pocketedIds.push(b.id);
          break;
        }
      }
    }
    // 壁
    for (const b of balls) {
      if (b.pocketed) continue;
      if (b.x < BL_BALL_RADIUS) {
        b.x = BL_BALL_RADIUS;
        b.vx = -b.vx * WALL_RESTITUTION;
      } else if (b.x > BL_WIDTH - BL_BALL_RADIUS) {
        b.x = BL_WIDTH - BL_BALL_RADIUS;
        b.vx = -b.vx * WALL_RESTITUTION;
      }
      if (b.y < BL_BALL_RADIUS) {
        b.y = BL_BALL_RADIUS;
        b.vy = -b.vy * WALL_RESTITUTION;
      } else if (b.y > BL_HEIGHT - BL_BALL_RADIUS) {
        b.y = BL_HEIGHT - BL_BALL_RADIUS;
        b.vy = -b.vy * WALL_RESTITUTION;
      }
    }
    // ボール同士（等質量の弾性衝突＋めり込み解消）
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        const a = balls[i];
        const c = balls[j];
        if (a.pocketed || c.pocketed) continue;
        const dx = c.x - a.x;
        const dy = c.y - a.y;
        const d = Math.hypot(dx, dy);
        const minD = BL_BALL_RADIUS * 2;
        if (d === 0 || d >= minD) continue;
        const nx = dx / d;
        const ny = dy / d;
        const overlap = (minD - d) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        c.x += nx * overlap;
        c.y += ny * overlap;
        const rel = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
        if (rel < 0) {
          const impulse = (-(1 + BALL_RESTITUTION) * rel) / 2;
          a.vx -= impulse * nx;
          a.vy -= impulse * ny;
          c.vx += impulse * nx;
          c.vy += impulse * ny;
        }
      }
    }
    if (step % 4 === 3) frames.push(snapshot());
  }
  frames.push(snapshot());
  return { frames, pocketedIds, scratch };
}

/**
 * 1打打つ。スクラッチ時は手球をヘッドスポット（埋まっていれば縦にずらす）へ戻し、
 * スコアにペナルティが付く。的球が全て落ちたら cleared。
 */
export function shoot(
  state: BilliardsState,
  angleDeg: number,
  power: number,
): { state: BilliardsState; result: BlShotResult } {
  if (state.phase !== "aiming") throw new Error("今は打てません");
  if (!Number.isFinite(angleDeg) || !Number.isFinite(power) || power < 0 || power > 100) {
    throw new Error("角度と強さが不正です");
  }
  const result = simulateShot(state.balls, angleDeg, power);
  const finalFrame = result.frames[result.frames.length - 1];
  const draft = clone(state);
  draft.balls = clone(finalFrame);
  draft.shots += 1;
  draft.lastPocketed = result.pocketedIds;
  draft.lastScratch = result.scratch;
  if (result.scratch) {
    draft.scratches += 1;
    const cue = draft.balls.find((b) => b.id === 0);
    if (cue) {
      cue.pocketed = false;
      const occupied = (x: number, y: number) =>
        draft.balls.some(
          (b) => b.id !== 0 && !b.pocketed && Math.hypot(b.x - x, b.y - y) < BL_BALL_RADIUS * 2 + 2,
        );
      let y = BL_HEAD_SPOT.y;
      if (occupied(BL_HEAD_SPOT.x, y)) {
        for (const off of [36, -36, 72, -72, 108, -108, 144, -144]) {
          if (!occupied(BL_HEAD_SPOT.x, BL_HEAD_SPOT.y + off)) {
            y = BL_HEAD_SPOT.y + off;
            break;
          }
        }
      }
      cue.x = BL_HEAD_SPOT.x;
      cue.y = Math.max(BL_BALL_RADIUS, Math.min(BL_HEIGHT - BL_BALL_RADIUS, y));
    }
  }
  if (remainingBalls(draft) === 0) draft.phase = "cleared";
  return { state: draft, result };
}
