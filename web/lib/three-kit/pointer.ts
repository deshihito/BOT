// レイキャスト入力を既存ジェスチャ（lib/gesture.ts）へ橋渡しする。
// 3D オブジェクトへの操作も、DOM と同じ語彙で扱う:
// - タップ: 同じ対象への pointerdown→up（移動が小さい）
// - ドラッグ: 対象を掴んで平面上を移動（ドラッグ中の点も渡す）
// - フリック/スワイプ: リリース時の速度と方向（swipeDirection で分類）
// ジェスチャの方向判定は lib/gesture の純粋関数を再利用し、二重定義しない。
import * as THREE from "three";
import { swipeDirection, type GestureDirection } from "../gesture";
import type { Stage } from "./stage";

export interface FlickInfo {
  /** 画面座標系の速度 px/s（y は下向き正）。 */
  vxPx: number;
  vyPx: number;
  /** gesture.ts の分類による方向（閾値未満なら null）。 */
  dir: GestureDirection | null;
  durationMs: number;
}

export interface PickPointerHandlers {
  /** タップ（down で掴んだ対象と up の対象が同じ、移動小）。hit は userData を含む。 */
  onTap?: (hit: THREE.Intersection | null) => void;
  /** どこでもタップ（対象外タップも拾いたい場合）。 */
  onTapAnywhere?: () => void;
  onDragStart?: (hit: THREE.Intersection) => void;
  /** planeY 平面上のドラッグ点。 */
  onDragMove?: (point: THREE.Vector3) => void;
  onDragEnd?: (flick: FlickInfo, hit: THREE.Intersection | null) => void;
  /** フリック/スワイプ（掴んでいなくても、画面上の速い移動で発火）。 */
  onFlick?: (flick: FlickInfo) => void;
  onHover?: (hit: THREE.Intersection | null) => void;
}

export interface PickPointerOptions {
  /** ドラッグ判定に使う平面の高さ。 */
  planeY?: number;
  /** これ以上動いたらドラッグ扱い（px）。 */
  dragThresholdPx?: number;
  /** ホバー（pointermove のレイキャスト）も有効にする。 */
  hover?: boolean;
}

/**
 * ステージの canvas にポインタ入力を取り付ける。戻り値は取り外し関数。
 * getTargets は毎回呼ばれるので、動的に増減する対象にも追従できる。
 */
export function attachPickPointer(
  stage: Stage,
  getTargets: () => THREE.Object3D[],
  handlers: PickPointerHandlers,
  options: PickPointerOptions = {},
): () => void {
  const el = stage.canvas;
  const planeY = options.planeY ?? 0;
  const dragThreshold = options.dragThresholdPx ?? 10;
  let downHit: THREE.Intersection | null = null;
  let downX = 0;
  let downY = 0;
  let downT = 0;
  let dragging = false;
  let samples: Array<{ t: number; x: number; y: number }> = [];

  const onDown = (e: PointerEvent) => {
    downHit = stage.pick(getTargets(), e.clientX, e.clientY);
    downX = e.clientX;
    downY = e.clientY;
    downT = performance.now();
    dragging = false;
    samples = [{ t: downT, x: e.clientX, y: e.clientY }];
    try { el.setPointerCapture(e.pointerId); } catch { /* noop */ }
  };

  const onMove = (e: PointerEvent) => {
    if (downT > 0) {
      const now = performance.now();
      samples.push({ t: now, x: e.clientX, y: e.clientY });
      samples = samples.filter((s) => now - s.t <= 180);
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (!dragging && moved > dragThreshold && downHit) {
        dragging = true;
        handlers.onDragStart?.(downHit);
      }
      if (dragging) {
        const p = stage.planePoint(planeY, e.clientX, e.clientY);
        if (p) handlers.onDragMove?.(p);
      }
    } else if (options.hover && handlers.onHover) {
      handlers.onHover(stage.pick(getTargets(), e.clientX, e.clientY));
    }
  };

  const onUp = (e: PointerEvent) => {
    if (downT === 0) return;
    const now = performance.now();
    samples.push({ t: now, x: e.clientX, y: e.clientY });
    samples = samples.filter((s) => now - s.t <= 180);
    const upHit = stage.pick(getTargets(), e.clientX, e.clientY);
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
    let vx = 0;
    let vy = 0;
    if (samples.length >= 2) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt > 0.01) {
        vx = (last.x - first.x) / dt;
        vy = (last.y - first.y) / dt;
      }
    }
    const flick: FlickInfo = {
      vxPx: vx,
      vyPx: vy,
      dir: swipeDirection(e.clientX - downX, e.clientY - downY),
      durationMs: now - downT,
    };
    if (dragging) {
      handlers.onDragEnd?.(flick, upHit);
    } else if (flick.dir !== null && Math.hypot(vx, vy) > 320) {
      handlers.onFlick?.(flick);
    } else if (moved <= dragThreshold) {
      const sameTarget =
        downHit && upHit && (downHit.object === upHit.object || downHit.object.userData.pickId === upHit.object.userData.pickId);
      handlers.onTap?.(sameTarget ? upHit : null);
      handlers.onTapAnywhere?.();
    }
    downT = 0;
    dragging = false;
    downHit = null;
  };

  const onCancel = () => {
    downT = 0;
    dragging = false;
    downHit = null;
  };

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onCancel);
  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancel);
  };
}
