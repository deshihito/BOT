// パットゴルフ（9ホール）の純粋ロジック（UI 非依存・シード決定的）。
// コースは 720×440 のフィールド（座標は px）。ボールは角度と強さを選んで打ち、
// 決定的なステップシミュレーション（摩擦・傾斜加速・壁反射）で転がる。
//
// 到達可能性の設計:
// コース生成では、ティー→中継点2つ→カップを結ぶ「通路（コリドー）」を先に決め、
// 壁は通路から十分離れた場所にしか置かない。通路の中は壁が無いので、
// 中継点を順に狙う打ち方をすれば必ずカップまで進める（テストで自動プレイ検証）。
// 傾斜ゾーンは進行を妨げない補助要素として通路の上にも置くことがある。

export const PG_WIDTH = 720;
export const PG_HEIGHT = 440;
export const PG_HOLES = 9;
export const PG_BALL_RADIUS = 7;
export const PG_CUP_RADIUS = 11;
/** カップを捉える最大速度（これより速いと通り過ぎる）。 */
export const PG_CUP_MAX_SPEED = 340;
/** 強さ 0〜100 を初速（px/s）へ変換する係数。 */
export const PG_BASE_SPEED = 140;
export const PG_SPEED_PER_POWER = 8.6;

const FRICTION = 300; // px/s^2
const SLOPE_ACCEL = 170; // px/s^2
const RESTITUTION = 0.62;
const STEP = 1 / 120;
const MAX_STEPS = 120 * 30;

export interface PgPoint {
  x: number;
  y: number;
}

export interface PgWall {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PgSlope extends PgWall {
  /** 傾斜の向き（単位ベクトル）。 */
  dx: number;
  dy: number;
}

export interface PgHole {
  index: number;
  tee: PgPoint;
  cup: PgPoint;
  par: number;
  walls: PgWall[];
  slopes: PgSlope[];
  /** ティーからカップまでの通路の中継点列（両端を含む）。到達可能性の根拠。 */
  guide: PgPoint[];
}

export type PgPhase = "playing" | "holed" | "finished";

export interface PuttState {
  seed: number;
  holes: PgHole[];
  holeIndex: number;
  ball: PgPoint;
  /** ホールごとの打数（未プレーは 0）。 */
  strokes: number[];
  phase: PgPhase;
  totalStrokes: number;
}

export interface PgShotResult {
  /** アニメーション用に間引いた軌跡（開始点と終点を含む）。 */
  points: PgPoint[];
  end: PgPoint;
  holed: boolean;
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

function dist(a: PgPoint, b: PgPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 点と線分の距離。 */
function pointSegmentDistance(p: PgPoint, a: PgPoint, b: PgPoint): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

/** 矩形と線分の最短距離（交わっていれば 0）。 */
function rectSegmentDistance(rect: PgWall, a: PgPoint, b: PgPoint): number {
  const corners: PgPoint[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x, y: rect.y + rect.h },
    { x: rect.x + rect.w, y: rect.y + rect.h },
  ];
  // 矩形の辺と線分の交差、または端点が矩形内なら 0
  const inside = (p: PgPoint) =>
    p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
  if (inside(a) || inside(b)) return 0;
  const edges: [PgPoint, PgPoint][] = [
    [corners[0], corners[1]],
    [corners[1], corners[3]],
    [corners[3], corners[2]],
    [corners[2], corners[0]],
  ];
  const segIntersect = (p1: PgPoint, p2: PgPoint, p3: PgPoint, p4: PgPoint): boolean => {
    const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
    if (d === 0) return false;
    const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
    const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  };
  let min = Number.POSITIVE_INFINITY;
  for (const [e1, e2] of edges) {
    if (segIntersect(a, b, e1, e2)) return 0;
    min = Math.min(min, pointSegmentDistance(e1, a, b), pointSegmentDistance(e2, a, b));
  }
  // 端点から矩形への距離
  const pointRectDistance = (p: PgPoint) => {
    const dx = Math.max(rect.x - p.x, 0, p.x - (rect.x + rect.w));
    const dy = Math.max(rect.y - p.y, 0, p.y - (rect.y + rect.h));
    return Math.hypot(dx, dy);
  };
  min = Math.min(min, pointRectDistance(a), pointRectDistance(b));
  return min;
}

// ---------------------------------------------------------------- physics

/**
 * 1打のシミュレーション。決定的（同じ入力は必ず同じ結果）。
 * angleDeg は 0 が右、反時計回りが正（画面座標では y が下向きなので、
 * 数学的な角度をそのまま画面に写す: 方向ベクトルは (cos, -sin) ではなく
 * (cos, sin) を画面 y 下向きとして扱う。Client も同じ規約で描く）。
 */
export function simulateShot(
  hole: PgHole,
  from: PgPoint,
  angleDeg: number,
  power: number,
): PgShotResult {
  if (!Number.isFinite(angleDeg) || !Number.isFinite(power)) {
    return { points: [{ ...from }], end: { ...from }, holed: false };
  }
  const p = Math.max(0, Math.min(100, power));
  const rad = (angleDeg * Math.PI) / 180;
  const speed = PG_BASE_SPEED + p * PG_SPEED_PER_POWER;
  let vx = Math.cos(rad) * speed;
  let vy = Math.sin(rad) * speed;
  let pos = { ...from };
  const points: PgPoint[] = [{ ...pos }];
  let holed = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    // 傾斜
    for (const s of hole.slopes) {
      if (pos.x >= s.x && pos.x <= s.x + s.w && pos.y >= s.y && pos.y <= s.y + s.h) {
        vx += s.dx * SLOPE_ACCEL * STEP;
        vy += s.dy * SLOPE_ACCEL * STEP;
      }
    }
    // 摩擦
    const sp = Math.hypot(vx, vy);
    if (sp > 0) {
      const dec = FRICTION * STEP;
      if (sp <= dec || sp < 8) {
        vx = 0;
        vy = 0;
      } else {
        const k = (sp - dec) / sp;
        vx *= k;
        vy *= k;
      }
    }
    if (vx === 0 && vy === 0) break;

    let nx = pos.x + vx * STEP;
    let ny = pos.y + vy * STEP;

    // フィールド端
    if (nx < PG_BALL_RADIUS) {
      nx = PG_BALL_RADIUS;
      vx = -vx * RESTITUTION;
    } else if (nx > PG_WIDTH - PG_BALL_RADIUS) {
      nx = PG_WIDTH - PG_BALL_RADIUS;
      vx = -vx * RESTITUTION;
    }
    if (ny < PG_BALL_RADIUS) {
      ny = PG_BALL_RADIUS;
      vy = -vy * RESTITUTION;
    } else if (ny > PG_HEIGHT - PG_BALL_RADIUS) {
      ny = PG_HEIGHT - PG_BALL_RADIUS;
      vy = -vy * RESTITUTION;
    }

    // 壁（AABB、めり込みの浅い軸で跳ね返す）
    for (const w of hole.walls) {
      const expanded = {
        x: w.x - PG_BALL_RADIUS,
        y: w.y - PG_BALL_RADIUS,
        w: w.w + PG_BALL_RADIUS * 2,
        h: w.h + PG_BALL_RADIUS * 2,
      };
      if (nx > expanded.x && nx < expanded.x + expanded.w && ny > expanded.y && ny < expanded.y + expanded.h) {
        const fromLeft = pos.x <= expanded.x;
        const fromRight = pos.x >= expanded.x + expanded.w;
        const fromTop = pos.y <= expanded.y;
        const fromBottom = pos.y >= expanded.y + expanded.h;
        if ((fromLeft || fromRight) && !fromTop && !fromBottom) {
          nx = fromLeft ? expanded.x : expanded.x + expanded.w;
          vx = -vx * RESTITUTION;
        } else if ((fromTop || fromBottom) && !fromLeft && !fromRight) {
          ny = fromTop ? expanded.y : expanded.y + expanded.h;
          vy = -vy * RESTITUTION;
        } else {
          // 角から入った場合は浅い方の軸で押し戻す
          const dxl = Math.min(Math.abs(nx - expanded.x), Math.abs(nx - (expanded.x + expanded.w)));
          const dyl = Math.min(Math.abs(ny - expanded.y), Math.abs(ny - (expanded.y + expanded.h)));
          if (dxl < dyl) {
            nx = Math.abs(nx - expanded.x) < Math.abs(nx - (expanded.x + expanded.w)) ? expanded.x : expanded.x + expanded.w;
            vx = -vx * RESTITUTION;
          } else {
            ny = Math.abs(ny - expanded.y) < Math.abs(ny - (expanded.y + expanded.h)) ? expanded.y : expanded.y + expanded.h;
            vy = -vy * RESTITUTION;
          }
        }
      }
    }

    pos = { x: nx, y: ny };
    if (step % 3 === 0) points.push({ ...pos });

    // カップ
    const curSpeed = Math.hypot(vx, vy);
    if (dist(pos, hole.cup) <= PG_CUP_RADIUS && curSpeed <= PG_CUP_MAX_SPEED) {
      holed = true;
      pos = { ...hole.cup };
      points.push({ ...pos });
      break;
    }
  }
  if (points[points.length - 1] !== pos && dist(points[points.length - 1], pos) > 0.01) {
    points.push({ ...pos });
  }
  return { points, end: pos, holed };
}

/** 距離から「ちょうど届く」強さの目安（Client のガイド・テストの自動プレイ用）。 */
export function powerForDistance(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  const v = Math.sqrt(2 * FRICTION * distance);
  return Math.max(0, Math.min(100, (v - PG_BASE_SPEED) / PG_SPEED_PER_POWER));
}

// ---------------------------------------------------------------- course generation

function generateHole(rng: number, index: number): { hole: PgHole; rng: number } {
  let r = rng | 0;
  const draw = () => {
    const n = nextRandom(r);
    r = n.rng;
    return n.value;
  };
  const margin = 56;
  const tee: PgPoint = { x: 64, y: Math.round(margin + draw() * (PG_HEIGHT - margin * 2)) };
  const cup: PgPoint = {
    x: PG_WIDTH - 64,
    y: Math.round(margin + draw() * (PG_HEIGHT - margin * 2)),
  };
  const mid1: PgPoint = { x: 268, y: Math.round(margin + draw() * (PG_HEIGHT - margin * 2)) };
  const mid2: PgPoint = { x: 472, y: Math.round(margin + draw() * (PG_HEIGHT - margin * 2)) };
  const guide = [tee, mid1, mid2, cup];
  const corridorClear = (rect: PgWall) => {
    for (let i = 0; i + 1 < guide.length; i++) {
      if (rectSegmentDistance(rect, guide[i], guide[i + 1]) < 54) return false;
    }
    return dist({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, tee) > 60 &&
      dist({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, cup) > 60;
  };

  const walls: PgWall[] = [];
  const wallCount = 2 + Math.floor(draw() * 3); // 2〜4
  let attempts = 0;
  while (walls.length < wallCount && attempts < 80) {
    attempts++;
    const vertical = draw() < 0.5;
    const len = Math.round(70 + draw() * 110);
    const thick = 16;
    const rect: PgWall = vertical
      ? {
          x: Math.round(120 + draw() * (PG_WIDTH - 240 - thick)),
          y: Math.round(30 + draw() * (PG_HEIGHT - 60 - len)),
          w: thick,
          h: len,
        }
      : {
          x: Math.round(120 + draw() * (PG_WIDTH - 240 - len)),
          y: Math.round(30 + draw() * (PG_HEIGHT - 60 - thick)),
          w: len,
          h: thick,
        };
    if (!corridorClear(rect)) continue;
    const overlaps = walls.some(
      (w) =>
        rect.x - 10 < w.x + w.w && rect.x + rect.w + 10 > w.x &&
        rect.y - 10 < w.y + w.h && rect.y + rect.h + 10 > w.y,
    );
    if (overlaps) continue;
    walls.push(rect);
  }

  const slopeDirs: PgPoint[] = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ];
  const slopes: PgSlope[] = [];
  const slopeCount = 1 + Math.floor(draw() * 3); // 1〜3
  for (let i = 0; i < slopeCount; i++) {
    const w = Math.round(90 + draw() * 90);
    const h = Math.round(70 + draw() * 70);
    const dir = slopeDirs[Math.floor(draw() * slopeDirs.length)];
    slopes.push({
      x: Math.round(40 + draw() * (PG_WIDTH - 80 - w)),
      y: Math.round(30 + draw() * (PG_HEIGHT - 60 - h)),
      w,
      h,
      dx: dir.x,
      dy: dir.y,
    });
  }

  const straight = dist(tee, cup);
  const par = Math.max(2, Math.min(4, Math.round(straight / 230)));
  return { hole: { index, tee, cup, par, walls, slopes, guide }, rng: r };
}

// ---------------------------------------------------------------- public API

export function createPuttGame(seed: number): PuttState {
  let rng = seed | 0;
  const holes: PgHole[] = [];
  for (let i = 0; i < PG_HOLES; i++) {
    const gen = generateHole(rng, i);
    holes.push(gen.hole);
    rng = gen.rng;
  }
  return {
    seed: seed | 0,
    holes,
    holeIndex: 0,
    ball: { ...holes[0].tee },
    strokes: Array(PG_HOLES).fill(0),
    phase: "playing",
    totalStrokes: 0,
  };
}

/** 1打打つ。アニメーション用の軌跡も返す。 */
export function shoot(
  state: PuttState,
  angleDeg: number,
  power: number,
): { state: PuttState; result: PgShotResult } {
  if (state.phase !== "playing") throw new Error("今は打てません");
  if (!Number.isFinite(angleDeg) || !Number.isFinite(power) || power < 0 || power > 100) {
    throw new Error("角度と強さが不正です");
  }
  const hole = state.holes[state.holeIndex];
  const result = simulateShot(hole, state.ball, angleDeg, power);
  const draft = clone(state);
  draft.ball = { ...result.end };
  draft.strokes[draft.holeIndex] += 1;
  draft.totalStrokes += 1;
  if (result.holed) draft.phase = "holed";
  return { state: draft, result };
}

/** 次のホールへ進む（holed のときだけ）。最終ホール後は finished。 */
export function nextHole(state: PuttState): PuttState {
  if (state.phase !== "holed") throw new Error("まだカップインしていません");
  const draft = clone(state);
  if (draft.holeIndex + 1 >= PG_HOLES) {
    draft.phase = "finished";
    return draft;
  }
  draft.holeIndex += 1;
  draft.ball = { ...draft.holes[draft.holeIndex].tee };
  draft.phase = "playing";
  return draft;
}

/** パーとの差の表記（-2, -1, ±0, +1...）。 */
export function scoreDiffLabel(diff: number): string {
  if (diff === 0) return "±0";
  return diff > 0 ? `+${diff}` : `${diff}`;
}

export function totalPar(state: PuttState): number {
  return state.holes.reduce((sum, h) => sum + h.par, 0);
}
