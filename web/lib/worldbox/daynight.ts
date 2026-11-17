// AGO WORLD BOX の昼夜サイクル（純粋ロジック）。
// 位相 t は 0〜1（0=真夜中、0.3 付近が朝、0.5=真昼、0.74=夕方、0.84=日没）。
// v1 は空の色だけが変わっていたが、v2 からはこの時計が敵の出現も支配する。

/** 1 日の長さ（秒）。 */
export const DAY_CYCLE_SEC = 240;

/**
 * 共有時計（v3）: 位相は unix 時刻から一意に決まる（全員が同じ時刻を生きる）。
 * セーブには位相を持たず、クライアントは毎フレームこれで現在位相を求める。
 */
export function phaseAtTime(unixSec: number): number {
  const t = (unixSec / DAY_CYCLE_SEC) % 1;
  return t < 0 ? t + 1 : t;
}

/** 夜の暗さ（0=昼、1=真夜中）。描画の暗転と敵出現の両方がこの値を共有する。 */
export function nightAmount(t: number): number {
  if (t < 0.18 || t > 0.9) return 1;
  if (t > 0.24 && t < 0.8) return 0;
  if (t <= 0.24) return 1 - (t - 0.18) / 0.06;
  return (t - 0.8) / 0.1;
}

/** ゲームプレイ上の「夜」か（敵が出る時間帯）。 */
export function isNightPhase(t: number): boolean {
  return nightAmount(t) > 0.5;
}
