// 共通「手応え層」（櫻井流バッチ1）。React 非依存の純粋ロジック＋薄い DOM
// ヘルパー。根拠は sakurai スキルの各原則:
// - ヒットストップはジャンルを問わず必ず入れる（#003 / #047）。強さ3段で、
//   受け側は大きく・与え側は小さく震わせる（判定は動かさず見た目だけ）。
// - 画面振動は大中小で揺れのパターン自体を変える（#103）: 小=縦のみ /
//   中=縦横 / 大=ランダム＋収束。カメラ距離補正は three-kit 側の倍率引数。
// - フラッシュは白一色にせず明暗を交互にする（#221）。
// - ヒットマークは衝撃波＋火花の複合、暗色を混ぜ、早く消す（#130）:
//   連続ヒット 120ms / 単発 250ms。
// - スカッシュ＆ストレッチは体積保存（#120）。
// - 押下の即時反応（#049）は globals.css の .juice-pressable が担う。
// すべての DOM ヘルパーは失敗しても例外を投げない（演出が出ないだけ）。

/** 演出の強さ。1=小 / 2=中 / 3=大。 */
export type JuiceIntensity = 1 | 2 | 3;

/** ヒットストップの長さ（ms）。攻撃力相当は power 係数で微調整する。 */
export const HITSTOP_MS: Record<JuiceIntensity, number> = { 1: 40, 2: 70, 3: 120 };

/** 振動1回の継続時間（ms）。 */
export const SHAKE_MS: Record<JuiceIntensity, number> = { 1: 140, 2: 220, 3: 340 };

/** ヒットマークの寿命（ms）。連続ヒット時は短く、単発は少し長く見せる（#130）。 */
export const HITMARK_MS = { continuous: 120, single: 250 } as const;

/** フラッシュの継続時間（ms）。明暗交互は globals.css の keyframes 側。 */
export const FLASH_MS = 180;

/** intensity を 1..3 に丸める（範囲外・NaN は 1）。 */
export function clampIntensity(value: number): JuiceIntensity {
  if (value >= 3) return 3;
  if (value >= 2) return 2;
  return 1;
}

/** ヒットストップ時間（ms）。power は攻撃力係数（0.5〜2 にクランプ）。 */
export function hitstopDurationMs(intensity: JuiceIntensity, power = 1): number {
  const p = Number.isFinite(power) ? Math.min(2, Math.max(0.5, power)) : 1;
  return Math.round(HITSTOP_MS[intensity] * p);
}

/**
 * 微振動の振幅（px）。受け側（target）は大きく、与え側（source）は小さく
 * 震わせる（#047）。振幅は時間とともに大→小へ収束させる前提の最大値。
 */
export function vibrateAmplitudePx(intensity: JuiceIntensity, role: "target" | "source"): number {
  const base = intensity === 1 ? 2 : intensity === 2 ? 3.5 : 5;
  return role === "target" ? base : base * 0.4;
}

export type ShakePattern = "vertical" | "both" | "random";

/** 強さごとの振動パターン（パターン自体を変える、#103）。 */
export function shakePattern(intensity: JuiceIntensity): ShakePattern {
  return intensity === 1 ? "vertical" : intensity === 2 ? "both" : "random";
}

/** 振動の最大振幅（px、DOM版）。3D版は three-kit 側で距離補正倍率を掛ける。 */
export function shakeAmplitudePx(intensity: JuiceIntensity): number {
  return intensity === 1 ? 3 : intensity === 2 ? 6 : 11;
}

/**
 * 振動オフセット列を返す純粋関数。progress 0→1 で振幅が収束する。
 * random パターンだけ rng を使う（テストでは決定的な rng を渡せる）。
 */
export function shakeOffsetAt(
  intensity: JuiceIntensity,
  progress: number,
  rng: () => number = Math.random,
): { x: number; y: number } {
  const t = Math.min(1, Math.max(0, progress));
  const decay = 1 - t;
  const amp = shakeAmplitudePx(intensity) * decay;
  const pattern = shakePattern(intensity);
  // 位相はステップ関数的に切り替え、滑らかな往復ではなく「震え」にする。
  const step = Math.floor(t * (intensity === 1 ? 4 : 6));
  const sign = step % 2 === 0 ? 1 : -1;
  if (pattern === "vertical") return { x: 0, y: amp * sign };
  if (pattern === "both") return { x: amp * 0.7 * sign, y: amp * sign };
  return { x: amp * (rng() * 2 - 1), y: amp * (rng() * 2 - 1) };
}

/**
 * スカッシュ＆ストレッチのスケール（体積保存: sx * sy = 1、#120）。
 * amount > 0 で縦潰し＋横伸ばし、amount < 0 で逆。amount は ±0.45 にクランプ。
 */
export function squashScales(amount: number): { sx: number; sy: number } {
  const a = Number.isFinite(amount) ? Math.min(0.45, Math.max(-0.45, amount)) : 0;
  const sy = 1 - a;
  return { sx: 1 / sy, sy };
}

/** ヒットマークの寿命（ms）。連続ヒットかどうかで切り替える（#130）。 */
export function hitmarkLifetimeMs(continuous: boolean): number {
  return continuous ? HITMARK_MS.continuous : HITMARK_MS.single;
}

/** フラッシュの明暗ステップ（brightness の列）。白一色にしない（#221）。 */
export function flashBrightnessSteps(): number[] {
  return [1.7, 0.55, 1.35, 1];
}

// ---------------------------------------------------------------------------
// 薄い DOM ヘルパー。対象は最小限の要素インターフェースだけを使う
// （classList / style.setProperty / appendChild / remove）ので、テストから
// フェイク要素でも検証できる。実 DOM では globals.css の juice-* が動く。
// ---------------------------------------------------------------------------

export interface JuiceElementLike {
  classList: {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
  };
  style: { setProperty: (name: string, value: string) => void };
}

type TimerHandle = ReturnType<typeof setTimeout>;

const pendingTimers = new Map<object, TimerHandle[]>();

function schedule(el: object, fn: () => void, ms: number): void {
  try {
    const t = setTimeout(() => {
      const list = pendingTimers.get(el);
      if (list) {
        const i = list.indexOf(t);
        if (i >= 0) list.splice(i, 1);
      }
      fn();
    }, ms);
    const list = pendingTimers.get(el) ?? [];
    list.push(t);
    pendingTimers.set(el, list);
  } catch {
    fn();
  }
}

/** 一時クラスを付け、durationMs 後に外す共通処理。 */
function pulseClass(el: JuiceElementLike, name: string, durationMs: number): void {
  try {
    el.classList.add(name);
    schedule(el, () => {
      try {
        el.classList.remove(name);
      } catch {
        // 要素が消えていても何もしない。
      }
    }, durationMs);
  } catch {
    // 演出が出ないだけ。
  }
}

/**
 * ヒットストップ（DOM版）: 要素配下のアニメーションを一時凍結し、
 * 受け側の微振動クラスを付ける。判定・レイアウトには触らない。
 */
export function juiceHitstop(el: JuiceElementLike | null | undefined, intensity: JuiceIntensity = 2, power = 1): void {
  if (!el) return;
  const ms = hitstopDurationMs(intensity, power);
  try {
    el.style.setProperty("--juice-vibrate-px", `${vibrateAmplitudePx(intensity, "target")}px`);
  } catch {
    // CSS 変数が付けられなくても凍結だけは効かせる。
  }
  pulseClass(el, "juice-hitstop", ms);
  pulseClass(el, "juice-vibrate", ms);
}

/** 画面振動（DOM版）: 強さでクラス＝パターンを切り替える。 */
export function juiceShake(el: JuiceElementLike | null | undefined, intensity: JuiceIntensity = 2): void {
  if (!el) return;
  pulseClass(el, `juice-shake-${intensity}`, SHAKE_MS[intensity]);
}

/** フラッシュ（DOM版）: 明暗交互の brightness アニメーションを1回かける。 */
export function juiceFlash(el: JuiceElementLike | null | undefined): void {
  if (!el) return;
  pulseClass(el, "juice-flash", FLASH_MS);
}

/** スカッシュ＆ストレッチ（DOM版）: 体積保存スケールを CSS 変数で渡す。 */
export function juiceSquash(el: JuiceElementLike | null | undefined, amount = 0.22, durationMs = 180): void {
  if (!el) return;
  const { sx, sy } = squashScales(amount);
  try {
    el.style.setProperty("--juice-sx", String(sx));
    el.style.setProperty("--juice-sy", String(sy));
  } catch {
    return;
  }
  pulseClass(el, "juice-squash", durationMs);
}

export interface HitmarkOptions {
  /** 要素内座標（%指定、0〜100）。省略時は中央。 */
  xPct?: number;
  yPct?: number;
  /** 連続ヒット中なら寿命を短くする（#130）。 */
  continuous?: boolean;
}

interface HitmarkHostLike extends JuiceElementLike {
  appendChild: (child: unknown) => unknown;
}

/**
 * ヒットマーク（DOM版）: ヒット位置に衝撃波＋火花の複合マークを出す。
 * ホスト要素は position の基準になるよう .juice-hitmark-host を付ける。
 * 戻り値は生成したマーク要素（生成できなければ null）。
 */
export function juiceHitmark(
  host: (JuiceElementLike & { appendChild?: unknown }) | null | undefined,
  intensity: JuiceIntensity = 2,
  opts: HitmarkOptions = {},
): unknown {
  if (!host || typeof document === "undefined") return null;
  const append = (host as HitmarkHostLike).appendChild;
  if (typeof append !== "function") return null;
  try {
    host.classList.add("juice-hitmark-host");
    const mark = document.createElement("span");
    mark.className = `juice-hitmark juice-hitmark-${intensity}`;
    mark.setAttribute("aria-hidden", "true");
    mark.style.setProperty("--juice-mark-x", `${opts.xPct ?? 50}%`);
    mark.style.setProperty("--juice-mark-y", `${opts.yPct ?? 50}%`);
    const ring = document.createElement("span");
    ring.className = "juice-hitmark-ring";
    mark.appendChild(ring);
    for (let i = 0; i < 4; i++) {
      const spark = document.createElement("span");
      spark.className = "juice-hitmark-spark";
      spark.style.setProperty("--juice-spark-angle", `${i * 90 + 24}deg`);
      mark.appendChild(spark);
    }
    (host as HitmarkHostLike).appendChild(mark);
    schedule(host, () => {
      try {
        mark.remove();
      } catch {
        // 既に消えていれば何もしない。
      }
    }, hitmarkLifetimeMs(opts.continuous ?? false));
    return mark;
  } catch {
    return null;
  }
}

/**
 * 「当たった瞬間」の一括ヘルパー: ヒットストップ＋振動＋ヒットマークを
 * 強さに応じて同時に掛ける。与え側の小さい要素があれば source に渡すと
 * 小さく震える（#047 の受け側＞与え側）。
 */
export function juiceHit(
  target: (JuiceElementLike & { appendChild?: unknown }) | null | undefined,
  intensity: JuiceIntensity = 2,
  opts: HitmarkOptions & { source?: JuiceElementLike | null; power?: number } = {},
): void {
  if (!target) return;
  juiceHitstop(target, intensity, opts.power ?? 1);
  if (intensity >= 2) juiceShake(target, intensity === 3 ? 3 : 2);
  juiceHitmark(target, intensity, opts);
  if (opts.source) pulseClass(opts.source, "juice-vibrate-sm", hitstopDurationMs(intensity, opts.power ?? 1));
}
