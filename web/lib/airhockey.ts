// エアホッケーの純粋ロジック（UI 非依存・シード決定的）。
// - 自分（下側）対 CPU（上側）。先に AIR_WIN_SCORE 点で勝ち。
// - 固定ステップ（1/60 秒）のシミュレーションを純関数 stepAirHockey で進める。
//   1ステップの中でパックを小刻みに動かし、壁反射・パドル衝突・ゴールを判定する。
// - プレイヤーの入力は「パドルの目標座標」として与え、ステップごとに
//   最大速度で制限して移動させる（瞬間移動はしない）。
// - CPU パドルは決定的な追跡方針: パックが向かってくる間は到達位置を予測して
//   追い、それ以外はホームポジションへ戻る。難易度で移動速度と読みのブレが変わる。
// - ゴール後は決着方向へサーブし直す。乱数は mulberry32 を状態に保持する。

export const AIR_FIELD_W = 400;
export const AIR_FIELD_H = 640;
export const AIR_PUCK_R = 12;
export const AIR_PADDLE_R = 26;
export const AIR_GOAL_W = 160;
export const AIR_WIN_SCORE = 7;

const DT = 1 / 60;
const PLAYER_MAX_SPEED = 1150;
const MAX_PUCK_SPEED = 1020;
const MIN_BOUNCE_SPEED = 280;
const SERVE_STEPS = 45; // ゴール/開始後にパックが止まっているステップ数
const SERVE_SPEED = 330;
const CPU_HOME = { x: AIR_FIELD_W / 2, y: 92 };
const PLAYER_HOME = { x: AIR_FIELD_W / 2, y: AIR_FIELD_H - 92 };

export type AirDifficulty = "easy" | "normal" | "hard";
export type AirStatus = "playing" | "finished";
export type AirSide = "player" | "cpu";

export interface AirDifficulties {
  cpuSpeed: number;
  /** CPU の狙いのブレ（px）。決定的な sin 波で与える。 */
  cpuError: number;
  /** パックが向かってこない時にホームへ戻る割合（0〜1）。 */
  homeBias: number;
}

export const AIR_DIFFICULTIES: Record<AirDifficulty, AirDifficulties> = {
  easy: { cpuSpeed: 300, cpuError: 30, homeBias: 0.85 },
  normal: { cpuSpeed: 435, cpuError: 15, homeBias: 0.55 },
  hard: { cpuSpeed: 580, cpuError: 5, homeBias: 0.25 },
};

export interface AirVec {
  x: number;
  y: number;
}

export interface AirHockeyState {
  puck: AirVec & { vx: number; vy: number };
  player: AirVec;
  cpu: AirVec;
  /** 直近ステップのパドル速度（衝突時の勢い付けに使う）。 */
  playerVel: AirVec;
  cpuVel: AirVec;
  playerScore: number;
  cpuScore: number;
  status: AirStatus;
  winner: AirSide | null;
  /** 0 より大きい間はパックが中央で静止している。 */
  serveTimer: number;
  /** 次のサーブの向き（1 = プレイヤー側へ、-1 = CPU 側へ）。 */
  serveDir: 1 | -1;
  lastScorer: AirSide | null;
  difficulty: AirDifficulty;
  step: number;
  seed: number;
  rng: number;
}

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** パドル中心の可動範囲（自陣ハーフのみ）に収める。 */
function clampPaddle(pos: AirVec, side: AirSide): AirVec {
  const x = clamp(pos.x, AIR_PADDLE_R, AIR_FIELD_W - AIR_PADDLE_R);
  const y =
    side === "player"
      ? clamp(pos.y, AIR_FIELD_H / 2 + 4, AIR_FIELD_H - AIR_PADDLE_R)
      : clamp(pos.y, AIR_PADDLE_R, AIR_FIELD_H / 2 - 4);
  return { x, y };
}

/** target へ maxDist 以内だけ近づけた位置を返す。 */
function moveToward(pos: AirVec, target: AirVec, maxDist: number): AirVec {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= maxDist || dist === 0) return { x: target.x, y: target.y };
  return { x: pos.x + (dx / dist) * maxDist, y: pos.y + (dy / dist) * maxDist };
}

/** 壁で反射する到達予測位置（左右の壁で折り返す）。 */
function foldX(x: number): number {
  const min = AIR_PUCK_R;
  const max = AIR_FIELD_W - AIR_PUCK_R;
  const span = max - min;
  let v = (x - min) % (2 * span);
  if (v < 0) v += 2 * span;
  return v <= span ? min + v : min + 2 * span - v;
}

export function createAirHockeyGame(seed: number, difficulty: AirDifficulty = "normal"): AirHockeyState {
  return {
    puck: { x: AIR_FIELD_W / 2, y: AIR_FIELD_H / 2, vx: 0, vy: 0 },
    player: { ...PLAYER_HOME },
    cpu: { ...CPU_HOME },
    playerVel: { x: 0, y: 0 },
    cpuVel: { x: 0, y: 0 },
    playerScore: 0,
    cpuScore: 0,
    status: "playing",
    winner: null,
    serveTimer: SERVE_STEPS,
    serveDir: 1,
    lastScorer: null,
    difficulty,
    step: 0,
    seed,
    rng: seed | 0,
  };
}

function serve(state: AirHockeyState): AirHockeyState {
  const r = nextRandom(state.rng);
  const angle = (r.value * 2 - 1) * 0.5; // 真正面から ±0.5 rad
  return {
    ...state,
    rng: r.rng,
    puck: {
      x: AIR_FIELD_W / 2,
      y: AIR_FIELD_H / 2,
      vx: Math.sin(angle) * SERVE_SPEED,
      vy: Math.cos(angle) * SERVE_SPEED * state.serveDir,
    },
  };
}

function onGoal(state: AirHockeyState, scorer: AirSide): AirHockeyState {
  const playerScore = state.playerScore + (scorer === "player" ? 1 : 0);
  const cpuScore = state.cpuScore + (scorer === "cpu" ? 1 : 0);
  const finished = playerScore >= AIR_WIN_SCORE || cpuScore >= AIR_WIN_SCORE;
  return {
    ...state,
    playerScore,
    cpuScore,
    status: finished ? "finished" : "playing",
    winner: finished ? (playerScore > cpuScore ? "player" : "cpu") : null,
    lastScorer: scorer,
    // 取られた側へサーブする。
    serveDir: scorer === "player" ? -1 : 1,
    serveTimer: SERVE_STEPS,
    puck: { x: AIR_FIELD_W / 2, y: AIR_FIELD_H / 2, vx: 0, vy: 0 },
    player: { ...state.player },
    cpu: { ...state.cpu },
  };
}

/** パドルとパックの衝突を解消したパックを返す（衝突が無ければそのまま）。 */
function collidePaddle(
  puck: AirHockeyState["puck"],
  paddle: AirVec,
  paddleVel: AirVec,
): AirHockeyState["puck"] {
  const dx = puck.x - paddle.x;
  const dy = puck.y - paddle.y;
  const dist = Math.hypot(dx, dy);
  const minDist = AIR_PUCK_R + AIR_PADDLE_R;
  if (dist >= minDist || dist === 0) return puck;
  const nx = dx / dist;
  const ny = dy / dist;
  const x = paddle.x + nx * minDist;
  const y = paddle.y + ny * minDist;
  let vx = puck.vx;
  let vy = puck.vy;
  const vn = vx * nx + vy * ny;
  if (vn < 0) {
    vx -= 2 * vn * nx;
    vy -= 2 * vn * ny;
  }
  // パドルの動きを少しだけ伝える。
  vx += paddleVel.x * 0.35;
  vy += paddleVel.y * 0.35;
  let speed = Math.hypot(vx, vy);
  if (speed > MAX_PUCK_SPEED) {
    vx = (vx / speed) * MAX_PUCK_SPEED;
    vy = (vy / speed) * MAX_PUCK_SPEED;
    speed = MAX_PUCK_SPEED;
  } else if (speed > 0 && speed < MIN_BOUNCE_SPEED) {
    vx = (vx / speed) * MIN_BOUNCE_SPEED;
    vy = (vy / speed) * MIN_BOUNCE_SPEED;
  }
  return { x, y, vx, vy };
}

/**
 * 1ステップ（1/60秒）進める。input はプレイヤーパドルの目標座標（null は現状維持）。
 * 終了済みの state はそのまま返す。
 */
export function stepAirHockey(state: AirHockeyState, input: AirVec | null): AirHockeyState {
  if (state.status !== "playing") return state;
  const diff = AIR_DIFFICULTIES[state.difficulty] ?? AIR_DIFFICULTIES.normal;
  const step = state.step + 1;

  // --- プレイヤーパドル（目標へ最大速度で移動）
  const playerTarget = clampPaddle(input ?? state.player, "player");
  const playerPos = moveToward(state.player, playerTarget, PLAYER_MAX_SPEED * DT);
  const playerVel = { x: (playerPos.x - state.player.x) / DT, y: (playerPos.y - state.player.y) / DT };

  // --- CPU パドル（決定的な追跡）
  const puck = state.puck;
  let cpuTarget = CPU_HOME;
  if (puck.vy < -20) {
    const t = (state.cpu.y - puck.y) / puck.vy;
    const predictedX = foldX(puck.x + puck.vx * t);
    const wobble = Math.sin(step * 0.13) * diff.cpuError;
    cpuTarget = {
      x: clamp(predictedX + wobble, AIR_PADDLE_R, AIR_FIELD_W - AIR_PADDLE_R),
      y: clamp(puck.y - 56, AIR_PADDLE_R, AIR_FIELD_H / 2 - 4),
    };
  } else {
    const wobble = Math.sin(step * 0.05) * diff.cpuError * 0.6;
    cpuTarget = {
      x: CPU_HOME.x + (puck.x - CPU_HOME.x) * (1 - diff.homeBias) + wobble,
      y: CPU_HOME.y,
    };
  }
  const cpuPos = moveToward(state.cpu, cpuTarget, diff.cpuSpeed * DT);
  const cpuPosClamped = clampPaddle(cpuPos, "cpu");
  const cpuVel = { x: (cpuPosClamped.x - state.cpu.x) / DT, y: (cpuPosClamped.y - state.cpu.y) / DT };

  let s: AirHockeyState = {
    ...state,
    step,
    player: playerPos,
    cpu: cpuPosClamped,
    playerVel,
    cpuVel,
  };

  // --- サーブ待ち
  if (s.serveTimer > 0) {
    const next = { ...s, serveTimer: s.serveTimer - 1 };
    return next.serveTimer === 0 ? serve(next) : next;
  }

  // --- パック移動（トンネリング防止に小刻みに進める）
  let p = { ...s.puck };
  const distPerStep = Math.hypot(p.vx, p.vy) * DT;
  const subSteps = Math.max(1, Math.ceil(distPerStep / (AIR_PUCK_R / 2)));
  const subDt = DT / subSteps;
  for (let i = 0; i < subSteps; i++) {
    p = { x: p.x + p.vx * subDt, y: p.y + p.vy * subDt, vx: p.vx, vy: p.vy };
    // 左右の壁
    if (p.x < AIR_PUCK_R) {
      p = { ...p, x: AIR_PUCK_R, vx: Math.abs(p.vx) };
    } else if (p.x > AIR_FIELD_W - AIR_PUCK_R) {
      p = { ...p, x: AIR_FIELD_W - AIR_PUCK_R, vx: -Math.abs(p.vx) };
    }
    // 上下の壁とゴール
    const inGoalMouth = Math.abs(p.x - AIR_FIELD_W / 2) <= AIR_GOAL_W / 2;
    if (p.y < AIR_PUCK_R) {
      if (inGoalMouth && p.y < -AIR_PUCK_R) {
        return onGoal({ ...s, puck: p }, "player");
      }
      if (!inGoalMouth) p = { ...p, y: AIR_PUCK_R, vy: Math.abs(p.vy) };
    } else if (p.y > AIR_FIELD_H - AIR_PUCK_R) {
      if (inGoalMouth && p.y > AIR_FIELD_H + AIR_PUCK_R) {
        return onGoal({ ...s, puck: p }, "cpu");
      }
      if (!inGoalMouth) p = { ...p, y: AIR_FIELD_H - AIR_PUCK_R, vy: -Math.abs(p.vy) };
    }
    p = collidePaddle(p, s.player, s.playerVel);
    p = collidePaddle(p, s.cpu, s.cpuVel);
  }
  return { ...s, puck: p };
}

/** スコア表示用のヘルパー。 */
export function airHockeyWinnerLabel(state: AirHockeyState): string | null {
  if (state.status !== "finished" || !state.winner) return null;
  return state.winner === "player" ? "あなた" : "CPU";
}
