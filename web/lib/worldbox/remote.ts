// AGO WORLD BOX の他プレイヤー描画位置（純粋ロジック）。
// プレゼンスのスナップショットは約2秒おきに届くため、そのまま描くと
// 位置が飛び飛びになる。ここでは「最新スナップショットからの予測位置」を
// 目標に、臨界減衰バネで描画位置と描画速度をなめらかに追従させる。
// 予測から大きく離れた更新（ワープ等）はバネで追わず即座に合わせる。
import { predictPosition, type CoordBounds, type PresenceEntry } from "./presence";

/** この距離（タイル）を超える更新はワープとみなして即座に合わせる。 */
export const REMOTE_SNAP_DISTANCE = 8;
/** バネの追従時間（秒）。小さいほど速く、大きいほどなめらかに寄る。 */
export const REMOTE_SMOOTH_TIME_SEC = 0.16;

export type RemoteTrack = {
  /** 最新のスナップショット。 */
  entry: PresenceEntry;
  /** 描画位置（タイル座標）。 */
  rx: number;
  ry: number;
  /** 描画速度（タイル/秒、バネの状態）。 */
  rvx: number;
  rvy: number;
};

type Bounds = CoordBounds;

/** 初めて見えたプレイヤーのトラック（予測位置から始める）。 */
export function createRemoteTrack(entry: PresenceEntry, now: number, bounds: Bounds): RemoteTrack {
  const p = predictPosition(entry, now, bounds);
  return { entry, rx: p.x, ry: p.y, rvx: entry.vx, rvy: entry.vy };
}

/**
 * 新しいスナップショットを受け取る。予測位置が描画位置から
 * REMOTE_SNAP_DISTANCE を超えて離れていたら描画状態ごと合わせ直す。
 */
export function updateRemoteTrack(track: RemoteTrack, entry: PresenceEntry, now: number, bounds: Bounds): RemoteTrack {
  const p = predictPosition(entry, now, bounds);
  if (Math.hypot(p.x - track.rx, p.y - track.ry) > REMOTE_SNAP_DISTANCE) {
    return { entry, rx: p.x, ry: p.y, rvx: entry.vx, rvy: entry.vy };
  }
  return { ...track, entry };
}

/** 臨界減衰バネ（SmoothDamp）で1軸を target へ寄せる。 */
function smoothDampAxis(current: number, target: number, vel: number, smoothTime: number, dt: number): { x: number; v: number } {
  if (dt <= 0) return { x: current, v: vel };
  const omega = 2 / Math.max(0.01, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (vel + omega * change) * dt;
  const v = (vel - omega * temp) * exp;
  return { x: target + (change + temp) * exp, v };
}

/** dt 秒ぶん描画位置を進める（目標はスナップショットからの予測位置）。 */
export function stepRemoteTrack(track: RemoteTrack, now: number, dt: number, bounds: Bounds): RemoteTrack {
  const target = predictPosition(track.entry, now, bounds);
  const ax = smoothDampAxis(track.rx, target.x, track.rvx, REMOTE_SMOOTH_TIME_SEC, dt);
  const ay = smoothDampAxis(track.ry, target.y, track.rvy, REMOTE_SMOOTH_TIME_SEC, dt);
  return { entry: track.entry, rx: ax.x, ry: ay.x, rvx: ax.v, rvy: ay.v };
}
