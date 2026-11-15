// AGO WORLD BOX の昼夜サイクル（純粋ロジック）。
// 位相 t は 0〜1（0=真夜中、0.3 付近が朝、0.5=真昼、0.74=夕方、0.84=日没）。
// v1 は空の色だけが変わっていたが、v2 からはこの時計が敵の出現も支配する。

/** 1 日の長さ（秒）。 */
export const DAY_CYCLE_SEC = 240;

/** 新規ワールドの開始位相（昼）。 */
export const START_PHASE = 0.3;

/** 位相を dt 秒進める（0〜1 に正規化）。 */
export function advancePhase(phase: number, dt: number): number {
  const next = (phase + dt / DAY_CYCLE_SEC) % 1;
  return next < 0 ? next + 1 : next;
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
