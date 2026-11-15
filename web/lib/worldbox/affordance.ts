// AGO WORLD BOX 感覚面 B2: アフォーダンス（純粋ロジック、DOM 非依存）。
// - 近くの「使えるもの」（施設・宝箱・扉・出入口）に脈動する輪を出す。
//   輪は鉱脈の脈動（fx の miner pulse）と同じ周期・同じ色味の家族で、
//   「使える」は金色の輪、「だめ」は赤い輪、と色で分ける。
// - 初回だけ誘導バウンス（強めの脈動＋上下の揺れ、900ms で収束）。
// - 無効操作は文言だけに頼らない: 赤い輪＋小刻みな揺れ＋ error SE。
//   SE の対応は sound.ts の "error"（低い矩形波 2 連）。
// - スティックの押下感: 掴んだらノブを大きくする。
// 描画はクライアントの描画ループ側、判定と数値はここが正。

/** アフォーダンスの輪を出す距離（フットプリント端からのチェビシェフ距離）。 */
export const AFFORDANCE_RANGE_TILES = 2;
/** 脈動の周期（鉱脈の脈動 now/240 と同じ家族: 2π×240 ≈ 1508ms）。 */
export const AFFORDANCE_PULSE_DIVISOR = 240;
/** 脈動の不透明度（0.35 ± 0.25、鉱脈と同じ）。 */
export const AFFORDANCE_PULSE_BASE = 0.35;
export const AFFORDANCE_PULSE_AMP = 0.25;
/** 初回誘導バウンスの持続時間。 */
export const AFFORDANCE_NUDGE_MS = 900;
/** 初回誘導中の輪の最大不透明度。 */
export const AFFORDANCE_NUDGE_ALPHA_MAX = 0.85;
/** 初回誘導バウンスの振幅（px）。 */
export const AFFORDANCE_NUDGE_BOB_PX = 4;
/** 無効操作フィードバックの持続時間。 */
export const DENIED_MS = 260;
/** 無効操作の輪の最大不透明度。 */
export const DENIED_ALPHA_MAX = 0.9;
/** 無効操作の揺れの振幅（px）。 */
export const DENIED_SHAKE_PX = 2.5;
/** スティックのノブ半径（通常 / 掴んでいる時）。 */
export const STICK_KNOB_RADIUS = 22;
export const STICK_KNOB_RADIUS_ACTIVE = 26;
/** アフォーダンスの輪の色（使える＝金、無効＝赤）。 */
export const AFFORDANCE_RING_RGB = "255,210,62";
export const DENIED_RING_RGB = "226,72,58";

/** 脈動する輪の不透明度（0.10〜0.60）。鉱脈の脈動と同じ式。 */
export function affordancePulseAlpha(nowMs: number): number {
  const a = AFFORDANCE_PULSE_BASE + AFFORDANCE_PULSE_AMP * Math.sin(nowMs / AFFORDANCE_PULSE_DIVISOR);
  return Math.max(0.1, Math.min(0.6, a));
}

/**
 * 点 (px, py) が矩形 [ox, oy, ox+w, oy+h] の端から range タイル以内か。
 * チェビシェフ距離で測る（斜めも同じ扱い。タイルタップの隣接判定と同じ家族）。
 */
export function isWithinAffordanceRange(
  px: number,
  py: number,
  ox: number,
  oy: number,
  w: number,
  h: number,
  range: number = AFFORDANCE_RANGE_TILES,
): boolean {
  const dx = px < ox ? ox - px : px > ox + w ? px - (ox + w) : 0;
  const dy = py < oy ? oy - py : py > oy + h ? py - (oy + h) : 0;
  return Math.max(dx, dy) <= range;
}

/** 初回誘導の進捗（0〜1）。900ms で終わる。 */
export function nudgeProgress(ageMs: number): number {
  if (ageMs <= 0) return 0;
  if (ageMs >= AFFORDANCE_NUDGE_MS) return 1;
  return ageMs / AFFORDANCE_NUDGE_MS;
}

/**
 * 初回誘導バウンスの上下オフセット（px）。2 回跳ねて収束する。
 * ageMs が範囲外なら 0（誘導は初回の 900ms だけ）。
 */
export function nudgeBobPx(ageMs: number): number {
  const p = nudgeProgress(ageMs);
  if (p >= 1) return 0;
  const v = -AFFORDANCE_NUDGE_BOB_PX * Math.sin(p * Math.PI * 2) * (1 - p);
  return v === 0 ? 0 : v;
}

/** 初回誘導中の輪の不透明度（通常の脈動より強く、900ms で通常へ戻る）。 */
export function nudgeRingAlpha(nowMs: number, ageMs: number): number {
  const p = nudgeProgress(ageMs);
  if (p >= 1) return affordancePulseAlpha(nowMs);
  return Math.min(
    AFFORDANCE_NUDGE_ALPHA_MAX,
    affordancePulseAlpha(nowMs) + 0.25 * (1 - p),
  );
}

/** 無効操作フィードバックがまだ有効か。 */
export function deniedActive(ageMs: number): boolean {
  return ageMs >= 0 && ageMs < DENIED_MS;
}

/**
 * 無効操作の輪と揺れ。ageMs が DENIED_MS を過ぎたら null。
 * 輪は赤くフェードアウトし、横に小刻みに揺れる（文言ではなく動きで伝える）。
 */
export function deniedFeedback(ageMs: number): { alpha: number; dx: number } | null {
  if (!deniedActive(ageMs)) return null;
  const remain = 1 - ageMs / DENIED_MS;
  return {
    alpha: DENIED_ALPHA_MAX * remain,
    dx: DENIED_SHAKE_PX * remain * Math.sin(ageMs / 24),
  };
}

/** スティックのノブ半径。掴んだら大きくする（押下感）。 */
export function stickKnobRadius(active: boolean): number {
  return active ? STICK_KNOB_RADIUS_ACTIVE : STICK_KNOB_RADIUS;
}
