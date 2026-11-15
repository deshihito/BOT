// AGO WORLD BOX のアニメーション曲線（純粋ロジック）。
// 描画側（WorldBoxClient）はここで計算した位相・角度・バネ・ゆらぎだけを使い、
// 「動きの手触り」をテスト可能な形に切り出す。状態は持たない（時刻と入力から決まる）。

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

export function smoothstep(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

/** 指数減衰で target へ寄せる（カメラ追従などフレームレート非依存のなめらかさ）。 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  if (dt <= 0) return current;
  return target + (current - target) * Math.exp(-rate * dt);
}

// ---- 歩行サイクル ----
/** 歩行位相の進み（ラジアン/タイル）。速さに比例して足運びが速くなる。 */
export const WALK_PHASE_PER_TILE = 2.6;

export function advanceWalkPhase(phase: number, speed: number, dt: number): number {
  return phase + Math.abs(speed) * WALK_PHASE_PER_TILE * Math.max(0, dt);
}

/** 足が地面に着く拍の番号（変わった瞬間が「一歩」）。 */
export function stepBeatIndex(phase: number): number {
  return Math.floor(phase / Math.PI);
}

/** 歩行の上下動（0〜1、位相の半周期ごとに1回跳ねる）。 */
export function walkBob(phase: number): number {
  return Math.abs(Math.sin(phase));
}

/** 歩行の潰れ（scaleY、1 が等倍）。 */
export function walkSquashY(phase: number): number {
  return 1 - 0.055 * Math.abs(Math.sin(phase));
}

/** 移動方向への体の傾き（ラジアン、比率 -1〜1 → 最大 ±0.09）。 */
export function moveLean(speedRatio: number): number {
  return clamp(speedRatio, -1, 1) * 0.09;
}

// ---- 空中の姿勢 ----
/**
 * ジャンプ/落下の伸びと傾き。
 * vy はタイル/秒（負=上昇）。上昇中は最大 1.07、落下中は速さに応じて最大 1.11 まで伸びる。
 * forwardRatio は向き方向の水平速度比（-1〜1）で、落下ほど前に傾く。
 */
export function airPose(vy: number, forwardRatio: number): { scaleY: number; tilt: number } {
  const f = clamp(forwardRatio, -1, 1);
  if (vy < 0) {
    const k = Math.min(1, -vy / 12);
    return { scaleY: 1 + 0.07 * k, tilt: f * 0.04 * k };
  }
  const k = Math.min(1, vy / 19);
  return { scaleY: 1 + 0.11 * k, tilt: f * 0.12 * k };
}

// ---- バネ（着地の潰れ・カメラの沈み込み・被弾の凹み） ----
export type SpringState = { x: number; v: number };

/** 半陰的オイラーでバネを1ステップ進める。十分な時間で target に収束する。 */
export function springStep(s: SpringState, target: number, stiffness: number, damping: number, dt: number): SpringState {
  if (dt <= 0) return { x: s.x, v: s.v };
  const v = (s.v + (target - s.x) * stiffness * dt) * Math.exp(-damping * dt);
  return { x: s.x + v * dt, v };
}

/** 着地時の潰れ量（scaleY の初期値）。落下距離に応じて最大 0.84 まで潰れる。 */
export function landingSquashY(fallTiles: number): number {
  const depth = Math.min(0.16, Math.max(0, fallTiles - 0.4) * 0.024);
  return 1 - depth;
}

// ---- 掘り/攻撃のスイング ----
/** 振りかぶり（後方、ラジアン）。正の値が「向き方向へ振り抜く」側。 */
export const SWING_WINDUP = -0.95;
/** 振り抜き（前方、ラジアン）。 */
export const SWING_STRIKE = 0.62;
/** 待機時の構え角（低く構える）。 */
export const ARM_REST_ANGLE = 0.45;
/** 掘りのヒビ段階数（スイングはこの段階ごとに繰り返す）。 */
export const DIG_STAGES = 4;

/**
 * 掘りスイング角。進捗（0〜1）をヒビ段階ごとに区切り、各区間の終わり
 * （=段階が上がる瞬間）に振り抜き角へ到達し、次区間は振りかぶりから再開する。
 */
export function digSwingAngle(progress: number): number {
  const p = clamp01(progress);
  const seg = Math.min(DIG_STAGES - 1, Math.floor(p * DIG_STAGES));
  const local = p * DIG_STAGES - seg;
  const e = Math.pow(local, 1.7);
  return SWING_WINDUP + (SWING_STRIKE - SWING_WINDUP) * e;
}

/** 攻撃スイング角（0〜1: 構え→振りかぶり→振り抜き→構えに戻る）。 */
export function attackSwingAngle(t: number): number {
  const x = clamp01(t);
  if (x < 0.3) return ARM_REST_ANGLE + (SWING_WINDUP - ARM_REST_ANGLE) * smoothstep(x / 0.3);
  if (x < 0.55) {
    const k = (x - 0.3) / 0.25;
    return SWING_WINDUP + (SWING_STRIKE - SWING_WINDUP) * (1 - Math.pow(1 - k, 3));
  }
  return SWING_STRIKE + (ARM_REST_ANGLE - SWING_STRIKE) * smoothstep((x - 0.55) / 0.45);
}

// ---- 炎・光のゆらぎ ----
/** 時刻とシードから決まる 0〜1 のなめらかなゆらぎ（乱数でなく決定的）。 */
export function flickerNoise(t: number, seed: number): number {
  const a = Math.sin(t * 11.3 + seed * 12.9898);
  const b = Math.sin(t * 23.7 + seed * 78.233);
  const c = Math.sin(t * 5.1 + seed * 37.719);
  return 0.5 + (a * 0.5 + b * 0.3 + c * 0.2) / 2;
}

/** 松明の炎の大きさの倍率（0.88〜1.12）。 */
export function torchFlameScale(t: number, seed: number): number {
  return 0.88 + 0.24 * flickerNoise(t, seed);
}

/** 松明の光の倍率（0.95〜1.05 = ±5%）。光フィールド自体は作り直さず描画時にだけ掛ける。 */
export function torchLightFlicker(t: number, seed: number): number {
  return 0.95 + 0.1 * flickerNoise(t, seed);
}

// ---- 拾い物のマグネット ----
/** 目標へ最大 maxStep だけ近づける（行き過ぎない）。dist は移動後の残り距離。 */
export function magnetStep(
  x: number,
  y: number,
  tx: number,
  ty: number,
  maxStep: number,
): { x: number; y: number; dist: number } {
  const dx = tx - x;
  const dy = ty - y;
  const d = Math.hypot(dx, dy);
  if (d === 0 || maxStep <= 0) return { x, y, dist: d };
  if (d <= maxStep) return { x: tx, y: ty, dist: 0 };
  return { x: x + (dx / d) * maxStep, y: y + (dy / d) * maxStep, dist: d - maxStep };
}

// ---- 消滅・出現のポーズ ----
/** 死亡ポフ: 膨らみながら薄くなる（k は 0〜1 の経過比）。 */
export function poofPose(k: number): { scale: number; alpha: number } {
  const c = clamp01(k);
  return { scale: 1 + 0.7 * easeOutCubic(c), alpha: 1 - c };
}

/** 敵の撃破: 倒れ込む回転とフェード（k は 0〜1）。 */
export function flipDeathPose(k: number): { rot: number; alpha: number } {
  const c = clamp01(k);
  return { rot: Math.PI * (1 - Math.pow(1 - c, 2)), alpha: 1 - c * c };
}

/** 復活: 小さく薄い状態から膨らんで現れる（k は 0〜1）。 */
export function respawnPose(k: number): { scale: number; alpha: number } {
  const c = clamp01(k);
  return { scale: 0.65 + 0.35 * easeOutCubic(c), alpha: Math.min(1, c * 1.6) };
}

// ---- 敵の歩行・構え ----
/** 敵の歩行位相の進み（ラジアン/秒相当、速さ比例）。 */
export function advanceEnemyPhase(phase: number, speed: number, dt: number): number {
  return phase + Math.abs(speed) * 3.4 * Math.max(0, dt);
}

/** 歩行の左右の揺れ（ラジアン、最大 ±0.07 ≒ ±4°）。 */
export function enemyRock(speed: number, phase: number): number {
  return Math.sin(phase) * 0.07 * clamp01(Math.abs(speed) / 1.7);
}

/** 攻撃前の溜め（しゃがみ）の潰れ（scaleY、k は 0〜1 の溜め進捗）。 */
export function telegraphSquashY(k: number): number {
  return 1 - 0.22 * smoothstep(k);
}
