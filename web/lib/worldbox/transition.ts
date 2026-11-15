// AGO WORLD BOX シームレスローディング（B1）: 空間遷移のフェードと先読みの純粋ロジック。
// 描画・DOM・ネットワークには触らない。フェードは描画ループが transitionAlpha を読んで
// キャンバスへ重ね、ワープの切替はフェードアウトの頂点で1回だけ走る。
// 桜井: 遅さは罪 — ワープ全体 360ms 以内、暗転は短く。演出の長さに依存しない。
export const TRANSITION_FADE_OUT_MS = 140;
export const TRANSITION_FADE_IN_MS = 220;
export const TRANSITION_TOTAL_MS = TRANSITION_FADE_OUT_MS + TRANSITION_FADE_IN_MS;
// 初回入場は暗転から明けるだけ（フェードインのみ）。
export const TRANSITION_ENTER_MS = 220;
// 再接続の復帰は薄いパルスだけ（入力は止めない・暗転しない）。
export const RECONNECT_PULSE_MS = 300;
export const RECONNECT_PULSE_ALPHA = 0.25;
// スプライト先読みの上限。超えたら未読込みのまま進む（止まらない）。
export const SPRITE_PRELOAD_TIMEOUT_MS = 2500;
// 暗幕の色は .wb-shell の背景（#0b0e14）と同一にして継ぎ目を消す。
export const TRANSITION_OVERLAY_RGB = "11,14,20";

export type TransitionKind = "warp" | "enter" | "reconnect";

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);
// 滑らかな出入り（smoothstep）。直線だと機械的に見える。
const smooth = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** 遷移の種類ごとの全体時間（ms）。 */
export function transitionTotalMs(kind: TransitionKind): number {
  if (kind === "enter") return TRANSITION_ENTER_MS;
  if (kind === "reconnect") return RECONNECT_PULSE_MS;
  return TRANSITION_TOTAL_MS;
}

/** 経過時間における暗幕の不透明度（0〜1）。0 なら描画しなくてよい。 */
export function transitionAlpha(elapsedMs: number, kind: TransitionKind): number {
  if (elapsedMs < 0) return 0;
  if (kind === "enter") {
    if (elapsedMs >= TRANSITION_ENTER_MS) return 0;
    return 1 - smooth(elapsedMs / TRANSITION_ENTER_MS);
  }
  if (kind === "reconnect") {
    if (elapsedMs >= RECONNECT_PULSE_MS) return 0;
    return RECONNECT_PULSE_ALPHA * (1 - smooth(elapsedMs / RECONNECT_PULSE_MS));
  }
  if (elapsedMs >= TRANSITION_TOTAL_MS) return 0;
  if (elapsedMs < TRANSITION_FADE_OUT_MS) return smooth(elapsedMs / TRANSITION_FADE_OUT_MS);
  return 1 - smooth((elapsedMs - TRANSITION_FADE_OUT_MS) / TRANSITION_FADE_IN_MS);
}

/** ワープの空間切替を実行すべき瞬間（フェードアウトの頂点）に達したか。 */
export function transitionSwapDue(elapsedMs: number): boolean {
  return elapsedMs >= TRANSITION_FADE_OUT_MS;
}

/** 遷移が終わったか（暗幕が消え、入力凍結を解いてよい）。 */
export function transitionDone(elapsedMs: number, kind: TransitionKind): boolean {
  return elapsedMs >= transitionTotalMs(kind);
}

export type PreloadResult = { loaded: string[]; failed: string[]; timedOut: boolean };

export type PreloadImageLike = {
  src: string;
  onload: ((this: GlobalEventHandlers, ev: Event) => unknown) | null;
  onerror: ((this: GlobalEventHandlers, ev: Event) => unknown) | null;
  decode?: () => Promise<void>;
};

export type PreloadOptions = {
  timeoutMs?: number;
  imageFactory?: () => PreloadImageLike;
};

/**
 * 画像 URL 群を先読みする。1枚でも失敗・未完了があっても全体タイムアウトで
 * 必ず解決する（決して reject しない・呼び出し元を止めない）。
 * data: URI は即解決する。decode() がある環境では decode 完了も待つ。
 */
export function preloadImages(srcs: string[], opts: PreloadOptions = {}): Promise<PreloadResult> {
  const timeoutMs = opts.timeoutMs ?? SPRITE_PRELOAD_TIMEOUT_MS;
  const make = opts.imageFactory ?? (() => new Image() as unknown as PreloadImageLike);
  const unique = [...new Set(srcs)];
  if (unique.length === 0) return Promise.resolve({ loaded: [], failed: [], timedOut: false });
  return new Promise<PreloadResult>((resolve) => {
    const loaded: string[] = [];
    const failed: string[] = [];
    let remaining = unique.length;
    let settled = false;
    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ loaded, failed, timedOut });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    for (const src of unique) {
      let done = false;
      const ok = () => {
        if (done || settled) return;
        done = true;
        loaded.push(src);
        remaining -= 1;
        if (remaining <= 0) finish(false);
      };
      const ng = () => {
        if (done || settled) return;
        done = true;
        failed.push(src);
        remaining -= 1;
        if (remaining <= 0) finish(false);
      };
      let img: PreloadImageLike;
      try {
        img = make();
      } catch {
        ng();
        continue;
      }
      img.onload = ok;
      img.onerror = ng;
      try {
        img.src = src;
      } catch {
        ng();
        continue;
      }
      if (typeof img.decode === "function") {
        img.decode().then(ok, ng);
      }
    }
  });
}
