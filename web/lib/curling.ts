// カーリング（CPU 対戦・全2エンド）の純粋ロジック（UI 非依存・シード決定的）。
// シートは縦長（幅320×高さ780）。ストーンは下（y=700）から上部のハウスへ投げる。
// 投げは「強さ」と「カール」の2パラメータで決まり、決定的なステップシミュレーション
// （氷の摩擦・カールによる横移動・ストーン同士の衝突）で滑る。
// 簡略化の明示: サイドラインは本物ではアウトだが、ここでは壁として跳ね返る。
// ホッグライン（y=560）を越えられなかったストーンと、バックライン（y=30）を
// 越えたストーンは取り除かれる（本物のルールどおり）。
// エンドの得点: ハウスに触れているストーンのうち、相手の最寄りストーンより
// 中心に近い自軍のストーンの数だけ、その側が得点する。
// CPU の狙いと誤差はシード決定的（状態内の rng を持ち回る）。

export const CU_WIDTH = 320;
export const CU_HEIGHT = 780;
export const CU_STONE_RADIUS = 13;
export const CU_BUTTON = { x: 160, y: 140 };
/** ハウスの円（外から）。 */
export const CU_HOUSE_RADII = [88, 56, 28];
export const CU_THROW_Y = 700;
export const CU_HOG_Y = 560;
export const CU_BACK_Y = 30;
export const CU_STONES_PER_END = 4;
export const CU_TOTAL_ENDS = 2;

const STEP = 1 / 120;
const MAX_STEPS = 120 * 30;
const FRICTION = 95; // px/s^2
const CURL_ACCEL = 0.06; // カール値1あたりの横加速度 px/s^2
const STONE_RESTITUTION = 0.96;
const WALL_RESTITUTION = 0.45;
const STOP_SPEED = 4;
/** 強さ 0〜100 を初速（px/s）へ変換する。 */
const BASE_SPEED = 60;
const SPEED_PER_POWER = 3.4;

export type CuSide = "player" | "cpu";

export interface CuPoint {
  x: number;
  y: number;
}

export interface CuStone extends CuPoint {
  id: number;
  side: CuSide;
}

export type CuPhase = "aiming" | "endScored" | "finished";

export interface CuEndScore {
  player: number;
  cpu: number;
}

export interface CurlingState {
  seed: number;
  rng: number;
  /** 現在のエンド（1始まり）。 */
  end: number;
  /** このエンドで投げ終わった数（0〜8）。 */
  throwIndex: number;
  /** 次に投げる側。 */
  turn: CuSide;
  /** 現在のエンドでシートに残っているストーン。 */
  stones: CuStone[];
  /** エンドごとの得点（終了したエンドのみ）。 */
  endScores: CuEndScore[];
  scores: CuEndScore;
  phase: CuPhase;
  /** 直近に締まったエンドの得点（表示用）。 */
  lastEnd: CuEndScore | null;
  winner: CuSide | "draw" | null;
}

export interface CuThrowResult {
  /** アニメーション用フレーム列。各フレームはシート上の全ストーン。 */
  frames: CuStone[][];
  /** 投げたストーンがシートに残ったか。 */
  kept: boolean;
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

export function distanceToButton(p: CuPoint): number {
  return Math.hypot(p.x - CU_BUTTON.x, p.y - CU_BUTTON.y);
}

/** ハウスに触れているか（中心距離が外円＋ストーン半径以内）。 */
export function inHouse(p: CuPoint): boolean {
  return distanceToButton(p) <= CU_HOUSE_RADII[0] + CU_STONE_RADIUS;
}

/**
 * エンドの得点を計算する（純関数）。
 * ハウス内の最寄りストーンの側が、相手の最寄りより内側にある自軍ストーンの数を得る。
 * 両軍ともハウス内ゼロなら 0-0（ブランクエンド）。
 */
export function scoreEndStones(stones: CuStone[]): CuEndScore {
  const result: CuEndScore = { player: 0, cpu: 0 };
  const ds = (["player", "cpu"] as CuSide[]).map((side) => ({
    side,
    dists: stones
      .filter((s) => s.side === side && inHouse(s))
      .map((s) => distanceToButton(s))
      .sort((a, b) => a - b),
  }));
  const [a, b] = ds;
  if (a.dists.length === 0 && b.dists.length === 0) return result;
  const bestA = a.dists.length > 0 ? a.dists[0] : Number.POSITIVE_INFINITY;
  const bestB = b.dists.length > 0 ? b.dists[0] : Number.POSITIVE_INFINITY;
  if (bestA === bestB) return result; // 計測不能な同距離は両者0（簡略化）
  const winnerSide = bestA < bestB ? a : b;
  const loserBest = Math.min(bestA, bestB) === bestA ? bestB : bestA;
  const points = winnerSide.dists.filter((d) => d < loserBest).length;
  result[winnerSide.side] = points;
  return result;
}

// ---------------------------------------------------------------- physics

interface SimStone extends CuPoint {
  id: number;
  side: CuSide;
  vx: number;
  vy: number;
}

/**
 * 1投のシミュレーション。決定的（乱数なし）。
 * 既存ストーンに、新しいストーン（id は呼び出し側で採番）を加えて滑らせる。
 * 返り値の stones は最終的にシートに残ったストーン（範囲外は除去済み）。
 */
export function simulateThrow(
  stonesIn: CuStone[],
  newStone: CuStone,
  power: number,
  curl: number,
): { frames: CuStone[][]; stones: CuStone[]; kept: boolean } {
  const p = Number.isFinite(power) ? Math.max(0, Math.min(100, power)) : 0;
  const c = Number.isFinite(curl) ? Math.max(-100, Math.min(100, curl)) : 0;
  const speed = BASE_SPEED + p * SPEED_PER_POWER;
  const stones: SimStone[] = [
    ...stonesIn.map((s) => ({ id: s.id, side: s.side, x: s.x, y: s.y, vx: 0, vy: 0 })),
    { id: newStone.id, side: newStone.side, x: newStone.x, y: newStone.y, vx: 0, vy: -speed },
  ];
  const snapshot = (): CuStone[] => stones.map((s) => ({ id: s.id, side: s.side, x: s.x, y: s.y }));
  const frames: CuStone[][] = [snapshot()];

  for (let step = 0; step < MAX_STEPS; step++) {
    let anyMoving = false;
    for (const s of stones) {
      const sp = Math.hypot(s.vx, s.vy);
      if (sp <= 0) continue;
      anyMoving = true;
      // 投げたストーンにだけカールがかかる（他のストーンは直進）。
      if (s.id === newStone.id) s.vx += c * CURL_ACCEL * STEP;
      const dec = FRICTION * STEP;
      const nsp = Math.hypot(s.vx, s.vy);
      if (nsp <= dec || nsp < STOP_SPEED) {
        s.vx = 0;
        s.vy = 0;
      } else {
        const k = (nsp - dec) / nsp;
        s.vx *= k;
        s.vy *= k;
      }
    }
    if (!anyMoving) break;

    for (const s of stones) {
      s.x += s.vx * STEP;
      s.y += s.vy * STEP;
    }
    // サイドの壁（簡略化: 跳ね返る）
    for (const s of stones) {
      if (s.x < CU_STONE_RADIUS) {
        s.x = CU_STONE_RADIUS;
        s.vx = -s.vx * WALL_RESTITUTION;
      } else if (s.x > CU_WIDTH - CU_STONE_RADIUS) {
        s.x = CU_WIDTH - CU_STONE_RADIUS;
        s.vx = -s.vx * WALL_RESTITUTION;
      }
    }
    // ストーン同士の衝突（等質量の弾性衝突）
    for (let i = 0; i < stones.length; i++) {
      for (let j = i + 1; j < stones.length; j++) {
        const a = stones[i];
        const b = stones[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const minD = CU_STONE_RADIUS * 2;
        if (d === 0 || d >= minD) continue;
        const nx = dx / d;
        const ny = dy / d;
        const overlap = (minD - d) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;
        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        const rel = rvx * nx + rvy * ny;
        if (rel < 0) {
          const impulse = (-(1 + STONE_RESTITUTION) * rel) / 2;
          a.vx -= impulse * nx;
          a.vy -= impulse * ny;
          b.vx += impulse * nx;
          b.vy += impulse * ny;
        }
      }
    }
    if (step % 2 === 1) frames.push(snapshot());
  }
  frames.push(snapshot());

  // 範囲外のストーンを取り除く: 残すのは CU_BACK_Y <= y <= CU_HOG_Y のもの
  // （ホッグライン未達・バックライン超過・下へ戻り過ぎたストーンは除去）。
  const finalStones: CuStone[] = stones
    .filter((s) => s.y >= CU_BACK_Y && s.y <= CU_HOG_Y)
    .map((s) => ({ id: s.id, side: s.side, x: s.x, y: s.y }));
  return {
    frames,
    stones: finalStones,
    kept: finalStones.some((s) => s.id === newStone.id),
  };
}

/** 指定距離を滑り切るのに必要な強さ（CPU の狙い・Client のガイド用）。 */
export function powerForDistance(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  const v = Math.sqrt(2 * FRICTION * distance);
  return Math.max(0, Math.min(100, (v - BASE_SPEED) / SPEED_PER_POWER));
}

// ---------------------------------------------------------------- game flow

export function createCurlingGame(seed: number): CurlingState {
  return {
    seed: seed | 0,
    rng: seed | 0,
    end: 1,
    throwIndex: 0,
    turn: "player",
    stones: [],
    endScores: [],
    scores: { player: 0, cpu: 0 },
    phase: "aiming",
    lastEnd: null,
    winner: null,
  };
}

function firstThrower(end: number): CuSide {
  return end % 2 === 1 ? "player" : "cpu";
}

/** 1投を適用する共通処理（draft を破壊的に更新する）。 */
function applyThrowDraft(
  draft: CurlingState,
  side: CuSide,
  power: number,
  curl: number,
): CuThrowResult {
  const newStone: CuStone = {
    id: draft.end * 100 + draft.throwIndex,
    side,
    x: CU_BUTTON.x,
    y: CU_THROW_Y,
  };
  const result = simulateThrow(draft.stones, newStone, power, curl);
  draft.stones = result.stones;
  draft.throwIndex += 1;
  if (draft.throwIndex >= CU_STONES_PER_END * 2) {
    const endScore = scoreEndStones(draft.stones);
    draft.endScores = [...draft.endScores, endScore];
    draft.scores = {
      player: draft.scores.player + endScore.player,
      cpu: draft.scores.cpu + endScore.cpu,
    };
    draft.lastEnd = endScore;
    draft.phase = "endScored";
  } else {
    draft.turn = side === "player" ? "cpu" : "player";
  }
  return { frames: result.frames, kept: result.kept };
}

/** プレイヤーの1投。自分の手番でない・進行中以外は例外。 */
export function playerThrow(
  state: CurlingState,
  power: number,
  curl: number,
): { state: CurlingState; result: CuThrowResult } {
  if (state.phase !== "aiming") throw new Error("今は投げられません");
  if (state.turn !== "player") throw new Error("相手の手番です");
  if (!Number.isFinite(power) || power < 0 || power > 100) throw new Error("強さが不正です");
  if (!Number.isFinite(curl) || curl < -100 || curl > 100) throw new Error("カールが不正です");
  const draft = clone(state);
  const result = applyThrowDraft(draft, "player", power, curl);
  return { state: draft, result };
}

/**
 * CPU の狙いを決める（純粋: 引数の rng から誤差を引き、次 rng を返す）。
 * 狙いはボタン付近。相手の最寄りストーンがある場合はそれを弾く狙いも混ぜるが、
 * ここではボタン狙いに誤差を加える決定的方針に統一する。
 */
export function decideCpuThrow(
  state: CurlingState,
): { power: number; curl: number; rng: number } {
  let rng = state.rng | 0;
  const draw = () => {
    const n = nextRandom(rng);
    rng = n.rng;
    return n.value;
  };
  const errX = (draw() * 2 - 1) * 26; // ボタンからの横ずれ（px）
  const errY = (draw() * 2 - 1) * 44; // ボタンからの距離ずれ（px、手前が正）
  const targetY = CU_BUTTON.y + errY;
  const distance = CU_THROW_Y - targetY;
  const power = powerForDistance(distance);
  // 横ずれを打ち消す向きにカールを付ける（滑走時間からの近似）。
  const v = BASE_SPEED + power * SPEED_PER_POWER;
  const t = v / FRICTION;
  const denom = 0.5 * CURL_ACCEL * t * t;
  const curl = Math.max(-80, Math.min(80, denom > 0 ? errX / denom : 0));
  return { power, curl, rng };
}

/** CPU の1投。狙いの決定（rng 消費）から適用までを行う。 */
export function cpuThrow(state: CurlingState): { state: CurlingState; result: CuThrowResult } {
  if (state.phase !== "aiming") throw new Error("今は投げられません");
  if (state.turn !== "cpu") throw new Error("プレイヤーの手番です");
  const decision = decideCpuThrow(state);
  const draft = clone(state);
  draft.rng = decision.rng;
  const result = applyThrowDraft(draft, "cpu", decision.power, decision.curl);
  return { state: draft, result };
}

/** エンド終了後に次へ進む。最終エンドの後は finished で勝者を確定する。 */
export function nextEnd(state: CurlingState): CurlingState {
  if (state.phase !== "endScored") throw new Error("エンドはまだ終わっていません");
  const draft = clone(state);
  if (draft.end >= CU_TOTAL_ENDS) {
    draft.phase = "finished";
    draft.winner =
      draft.scores.player === draft.scores.cpu
        ? "draw"
        : draft.scores.player > draft.scores.cpu
          ? "player"
          : "cpu";
    return draft;
  }
  draft.end += 1;
  draft.throwIndex = 0;
  draft.stones = [];
  draft.turn = firstThrower(draft.end);
  draft.phase = "aiming";
  return draft;
}
