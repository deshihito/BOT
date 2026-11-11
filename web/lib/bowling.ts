// ボウリングの純粋ロジック（UI 非依存・シード決定的）。
// スコア計算は10フレームの正式ルール（ストライク/スペア/10フレーム目3投）。
//
// ピンの倒れ方の簡易モデル（決定的）:
// - 狙い aim（-1.4〜1.4）がボールの到達横位置 hitX = aim * 1.7 を決める。
// - 強さ power（0〜100）で直撃範囲 radius = 0.5 + 0.45 * power/100。
//   power が 25 未満だとボールが弱く radius は 0.72 倍、
//   95 超だとコントロールを失い hitX に乱数ジッターが入る。
// - 直撃したピンの近く（距離 1.02 以内）にあるピンは、1本ごとに
//   確率 0.72 で連鎖して倒れる（乱数は状態内の mulberry32 で決定的）。
// ピン配置は標準の三角配置（奥が y 大、単位はピン間隔）。

export const PIN_POSITIONS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0, y: 0 }, // 1
  { x: -0.5, y: 1 }, { x: 0.5, y: 1 }, // 2,3
  { x: -1, y: 2 }, { x: 0, y: 2 }, { x: 1, y: 2 }, // 4,5,6
  { x: -1.5, y: 3 }, { x: -0.5, y: 3 }, { x: 0.5, y: 3 }, { x: 1.5, y: 3 }, // 7,8,9,10
];

export const AIM_MIN = -1.4;
export const AIM_MAX = 1.4;

export interface BowlingState {
  seed: number;
  rng: number;
  /** 全投球の倒した本数（フレームをまたいで時系列）。 */
  rolls: number[];
  /** 現在のフレーム（0〜9）。 */
  frame: number;
  /** 現在のフレーム内の投球数。 */
  ballInFrame: number;
  /** 現在立っているピン（index 0〜9 = 1〜10番ピン）。 */
  standing: boolean[];
  finished: boolean;
}

function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

const FULL_RACK: boolean[] = Array.from({ length: 10 }, () => true);

export function createBowlingGame(seed: number): BowlingState {
  return {
    seed,
    rng: seed | 0,
    rolls: [],
    frame: 0,
    ballInFrame: 0,
    standing: [...FULL_RACK],
    finished: false,
  };
}

export interface ThrowResult {
  state: BowlingState;
  /** 今回倒れたピンの番号（1〜10）。 */
  knockedPins: number[];
  knocked: number;
}

/** 倒れ方モデル本体。standing のうち今回倒れるピンを返す。 */
export function computeKnocked(
  standing: boolean[],
  aim: number,
  power: number,
  rng: number,
): { knocked: boolean[]; rng: number } {
  const clampedAim = Math.max(AIM_MIN, Math.min(AIM_MAX, aim));
  const clampedPower = Math.max(0, Math.min(100, power));
  let hitX = clampedAim * 1.7;
  let radius = 0.5 + 0.45 * (clampedPower / 100);
  if (clampedPower < 25) radius *= 0.72;
  let r = rng;
  if (clampedPower > 95) {
    const j = nextRandom(r);
    r = j.rng;
    hitX += (j.value - 0.5) * 0.5;
  }
  const knocked = standing.map(() => false);
  // 直撃
  for (let i = 0; i < 10; i++) {
    if (!standing[i]) continue;
    if (Math.abs(PIN_POSITIONS[i].x - hitX) <= radius) knocked[i] = true;
  }
  // 連鎖（倒れたピンの近くにあるピンを1本ずつ判定し、広がらなくなるまで繰り返す）
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < 10; i++) {
      if (!standing[i] || knocked[i]) continue;
      let near = false;
      for (let j = 0; j < 10; j++) {
        if (!knocked[j]) continue;
        const dx = PIN_POSITIONS[i].x - PIN_POSITIONS[j].x;
        const dy = PIN_POSITIONS[i].y - PIN_POSITIONS[j].y;
        if (Math.sqrt(dx * dx + dy * dy) <= 1.02) { near = true; break; }
      }
      if (!near) continue;
      const roll = nextRandom(r);
      r = roll.rng;
      if (roll.value < 0.72) {
        knocked[i] = true;
        changed = true;
      }
    }
  }
  return { knocked, rng: r };
}

/** 1投する。aim は AIM_MIN〜AIM_MAX、power は 0〜100。 */
export function throwBall(state: BowlingState, aim: number, power: number): ThrowResult {
  if (state.finished) return { state, knockedPins: [], knocked: 0 };
  const { knocked, rng } = computeKnocked(state.standing, aim, power, state.rng);
  const knockedPins: number[] = [];
  const standing = state.standing.map((s, i) => {
    if (s && knocked[i]) {
      knockedPins.push(i + 1);
      return false;
    }
    return s;
  });
  const knockedCount = knockedPins.length;
  const rolls = [...state.rolls, knockedCount];
  const frameRolls = currentFrameRolls(state.rolls, state.frame);
  const ball = state.ballInFrame + 1;

  let frame = state.frame;
  let ballInFrame = ball;
  let nextStanding = standing;
  let finished = false;

  if (state.frame < 9) {
    if ((state.ballInFrame === 0 && knockedCount === 10) || state.ballInFrame === 1) {
      frame = state.frame + 1;
      ballInFrame = 0;
      nextStanding = [...FULL_RACK];
    }
  } else {
    // 10フレーム目
    const fr = [...frameRolls, knockedCount];
    if (ball === 1) {
      if (knockedCount === 10) nextStanding = [...FULL_RACK];
    } else if (ball === 2) {
      const first = fr[0];
      const second = fr[1];
      if (first === 10) {
        if (second === 10) nextStanding = [...FULL_RACK];
        // ストライク→非ストライクの場合は残りピンをそのまま狙う
      } else if (first + second === 10) {
        nextStanding = [...FULL_RACK]; // スペアで3投目は新しいラック
      } else {
        finished = true;
      }
    } else {
      finished = true;
    }
    if (finished) {
      frame = 9;
      ballInFrame = ball;
    }
  }

  return {
    state: { ...state, rng, rolls, frame, ballInFrame, standing: nextStanding, finished },
    knockedPins,
    knocked: knockedCount,
  };
}

/** 指定フレーム（0始まり）までに記録された rolls から、そのフレーム分だけを取り出す。 */
export function currentFrameRolls(rolls: number[], frameIndex: number): number[] {
  let i = 0;
  for (let f = 0; f < frameIndex && i < rolls.length; f++) {
    if (f < 9) {
      i += rolls[i] === 10 ? 1 : 2;
    } else {
      i += rolls.length - i;
    }
  }
  if (frameIndex < 9) return rolls.slice(i, i + 2);
  return rolls.slice(i);
}

/** フレームごとの累計スコア。確定していないフレームは null。 */
export function frameScores(rolls: number[]): (number | null)[] {
  const out: (number | null)[] = [];
  let total = 0;
  let i = 0;
  for (let f = 0; f < 10; f++) {
    if (f < 9) {
      if (i >= rolls.length) { out.push(null); continue; }
      if (rolls[i] === 10) {
        // ストライク: 次の2投が必要
        if (rolls[i + 1] === undefined || rolls[i + 2] === undefined) { out.push(null); continue; }
        total += 10 + rolls[i + 1] + rolls[i + 2];
        out.push(total);
        i += 1;
      } else if (rolls[i + 1] !== undefined && rolls[i] + rolls[i + 1] === 10) {
        // スペア: 次の1投が必要
        if (rolls[i + 2] === undefined) { out.push(null); continue; }
        total += 10 + rolls[i + 2];
        out.push(total);
        i += 2;
      } else if (rolls[i + 1] !== undefined) {
        total += rolls[i] + rolls[i + 1];
        out.push(total);
        i += 2;
      } else {
        out.push(null);
      }
    } else {
      const rest = rolls.slice(i);
      if (rest.length === 0) { out.push(null); continue; }
      const needed = rest[0] === 10 || (rest.length > 1 && rest[0] + rest[1] === 10) ? 3 : 2;
      if (rest.length < needed) { out.push(null); continue; }
      total += rest.slice(0, needed).reduce((a, b) => a + b, 0);
      out.push(total);
    }
  }
  return out;
}

/** 総スコア（確定分までの合計。完成したゲームでは最終スコア）。 */
export function scoreRolls(rolls: number[]): number {
  const frames = frameScores(rolls);
  for (let f = 9; f >= 0; f--) {
    if (frames[f] !== null) return frames[f] as number;
  }
  return 0;
}

/** スコア表記（X / / / −）。フレーム内の n 投目（0始まり）のマーク。 */
export function rollMark(rolls: number[], frameIndex: number, ballIndex: number): string {
  const fr = currentFrameRolls(rolls, frameIndex);
  const v = fr[ballIndex];
  if (v === undefined) return "";
  if (v === 0) return "−";
  if (frameIndex < 9) {
    if (ballIndex === 0 && v === 10) return "X";
    if (ballIndex === 1 && fr[0] + v === 10) return "/";
    return String(v);
  }
  // 10フレーム目
  if (ballIndex === 0) return v === 10 ? "X" : String(v);
  if (ballIndex === 1) {
    if (fr[0] === 10) return v === 10 ? "X" : String(v);
    return fr[0] + v === 10 ? "/" : String(v);
  }
  // 3投目: 直前がストライク/スペア系なら X は単独判定
  if (v === 10) return "X";
  if (fr[0] === 10 && fr[1] !== 10 && fr[1] + v === 10) return "/";
  return String(v);
}

export function standingCount(standing: boolean[]): number {
  return standing.filter(Boolean).length;
}
