// ゲーム共通のジェスチャ判定（タップ / スワイプ / ダブルタップ）。
// 第1バッチのジェスチャ一本化（2026-11-13 ユーザー裁定）で新設した唯一の共通置き場。
// 各ゲームは個別にポインタ判定を書かず、必ずこのヘルパーを使うこと。
// 判定ロジックは React 非依存の純粋関数として切り出し、テストから直接検証できる。
import { useRef } from "react";

export type GestureDirection = "up" | "down" | "left" | "right";

export const GESTURE_DEFAULT_THRESHOLD_PX = 24;
export const GESTURE_DOUBLE_TAP_MS = 320;

/** 移動量からスワイプ方向を返す。閾値未満なら null（=タップ扱い）。 */
export function swipeDirection(
  dx: number,
  dy: number,
  thresholdPx: number = GESTURE_DEFAULT_THRESHOLD_PX,
): GestureDirection | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < thresholdPx) return null;
  return ax > ay ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
}

export type GestureCallbacks = {
  /** 閾値以上の移動があったとき（方向つき）。 */
  onSwipe?: (dir: GestureDirection) => void;
  /** 移動がほぼない単発タップ。onDoubleTap がある場合はダブルタップ猶予後に発火する。 */
  onTap?: () => void;
  /** 短時間の2連続タップ。指定がある場合、単発タップは猶予分だけ遅れて発火する。 */
  onDoubleTap?: () => void;
};

export type GestureOptions = {
  thresholdPx?: number;
  doubleTapMs?: number;
};

type PointerLike = { clientX: number; clientY: number; currentTarget?: EventTarget | null };

/**
 * スワイプ直後の click を1回だけ抑止する。pointerdown/up が同一要素で終わった
 * 場合、ブラウザはその要素へ click も dispatch するため、スワイプする盤面の
 * 子に onClick があるゲーム（solitaire / tsume / sudoku / battleship）では
 * スワイプの処理とタップの処理が両方走って状態を壊す（例: もどる直後に
 * 古い state の手が指されて undo が上書きされる）。click が来なければ
 * タイマーで解除する（後続の正規タップを奪わない）。
 */
export function suppressClickAfterSwipe(el: EventTarget | null | undefined): void {
  if (!el || typeof (el as HTMLElement).addEventListener !== "function") return;
  const target = el as HTMLElement;
  const suppress = (ev: Event) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  target.addEventListener("click", suppress, { capture: true, once: true });
  setTimeout(() => {
    target.removeEventListener("click", suppress, { capture: true });
  }, 100);
}

/**
 * 対象物へ spread するポインタハンドラを返すフック。
 * 使い方: <div {...gesture} style={{ touchAction: "none" }}>対象物</div>
 * コールバックは ref 経由で常に最新を呼ぶため、呼び出し側は毎レンダー新しい関数を渡してよい。
 */
export function useGesture(callbacks: GestureCallbacks, options: GestureOptions = {}) {
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const lastTapAtRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threshold = options.thresholdPx ?? GESTURE_DEFAULT_THRESHOLD_PX;
  const doubleTapMs = options.doubleTapMs ?? GESTURE_DOUBLE_TAP_MS;

  const clearTapTimer = () => {
    if (tapTimerRef.current) {
      clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
    }
  };

  return {
    onPointerDown: (e: PointerLike) => {
      startRef.current = { x: e.clientX, y: e.clientY };
    },
    onPointerCancel: () => {
      startRef.current = null;
    },
    onPointerUp: (e: PointerLike) => {
      const start = startRef.current;
      startRef.current = null;
      if (!start) return;
      const dir = swipeDirection(e.clientX - start.x, e.clientY - start.y, threshold);
      if (dir) {
        clearTapTimer();
        lastTapAtRef.current = 0;
        // スワイプ直後の click（同一要素で終わった場合）を抑止し、子の onClick
        // との二重発火を防ぐ（solitaire / tsume / sudoku / battleship）。
        suppressClickAfterSwipe(e.currentTarget);
        cbRef.current.onSwipe?.(dir);
        return;
      }
      const cb = cbRef.current;
      if (!cb.onDoubleTap) {
        cb.onTap?.();
        return;
      }
      const now = Date.now();
      if (now - lastTapAtRef.current <= doubleTapMs) {
        clearTapTimer();
        lastTapAtRef.current = 0;
        cb.onDoubleTap();
        return;
      }
      lastTapAtRef.current = now;
      clearTapTimer();
      tapTimerRef.current = setTimeout(() => {
        tapTimerRef.current = null;
        lastTapAtRef.current = 0;
        cbRef.current.onTap?.();
      }, doubleTapMs);
    },
  };
}

/**
 * キーボード操作を残すゲーム向け: div を対象物タップと同じ扱いにするための
 * キーハンドラ属性（Enter / Space で onActivate）。role="button" の div に spread する。
 */
export function tappableProps(onActivate: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    },
  };
}
