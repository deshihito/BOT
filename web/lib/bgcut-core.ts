// 背景透過（Web 一時リンク版）の純粋ロジック。
// 寸法・上限・α後処理・単色背景検出・GIF フレーム間引きとラダーの計画だけを
// ここに置き、ブラウザ API（canvas / ORT / fetch）は BgCutClient 側に置く。
// 仕様の正は移行前の bot 側エンジン（PR #803/#810）:
// - 絵文字: PNG ≤256KB・最大128×128 / アニメ GIF ≤256KB
// - スタンプ: 320×320 ちょうど PNG ≤512KB / アニメ GIF ≤512KB
// - 入力ガード: 25MB / 6000万画素、除去フレーム上限 60
// α後処理（カットオフ＋smoothstep リマップ＋背景色デコンタミネーション）は
// 実測で全モデル・全指標を改善した方式（収縮は AA 輪郭を壊すため入れない）。

export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 60_000_000;
export const WORK_MAX_EDGE = 512;
export const MODEL_INPUT_SIZE = 320;
export const MAX_REMOVAL_FRAMES = 60;

export const EMOJI_MAX_BYTES = 256 * 1024;
export const EMOJI_MAX_EDGE = 128;
export const STICKER_MAX_BYTES = 512 * 1024;
export const STICKER_SIZE = 320;

export type BgCutPurpose = "emoji" | "sticker";

export function purposeBudget(purpose: BgCutPurpose): number {
  return purpose === "emoji" ? EMOJI_MAX_BYTES : STICKER_MAX_BYTES;
}

export function purposeFilename(purpose: BgCutPurpose, format: "PNG" | "GIF"): string {
  return `${purpose}.${format.toLowerCase()}`;
}

/** 入力ガード。問題があればユーザー向け文面、無ければ null。 */
export function inputGuardError(input: {
  bytes: number;
  width: number;
  height: number;
}): string | null {
  if (input.bytes > MAX_INPUT_BYTES) {
    return `ファイルが大きすぎます（上限 ${MAX_INPUT_BYTES / (1024 * 1024)}MB）。`;
  }
  if (input.width > 0 && input.height > 0 && input.width * input.height > MAX_INPUT_PIXELS) {
    return "画像の画素数が大きすぎます（上限 6000万画素）。";
  }
  return null;
}

/** アスペクトを保って maxEdge 以下に収める（拡大はしない）。 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** スタンプ用: canvas（320×320）に被写体を歪ませず中央配置する寸法と位置。 */
export function stickerPlacement(
  width: number,
  height: number,
  fitEdge: number = STICKER_SIZE,
  canvas: number = STICKER_SIZE,
): { width: number; height: number; x: number; y: number } {
  const scale = Math.min(fitEdge / width, fitEdge / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { width: w, height: h, x: Math.round((canvas - w) / 2), y: Math.round((canvas - h) / 2) };
}

/**
 * フレーム間引き計画。等間隔に最大 maxFrames 枚を残し、落としたフレームの
 * 表示時間は直前の残フレームへ合算する（総時間は変わらない）。
 */
export function planFrameSampling(
  durations: number[],
  maxFrames: number = MAX_REMOVAL_FRAMES,
): { indices: number[]; durations: number[]; sampled: boolean } {
  const n = durations.length;
  if (n <= maxFrames) {
    return { indices: durations.map((_, i) => i), durations: [...durations], sampled: false };
  }
  const indices: number[] = [];
  for (let i = 0; i < maxFrames; i++) {
    indices.push(Math.floor((i * n) / maxFrames));
  }
  const merged: number[] = [];
  for (let k = 0; k < indices.length; k++) {
    const start = indices[k];
    const end = k + 1 < indices.length ? indices[k + 1] : n;
    let sum = 0;
    for (let i = start; i < end; i++) sum += durations[i];
    merged.push(sum);
  }
  return { indices, durations: merged, sampled: true };
}

/** step 本ごとに1枚残す追加の間引き（処理時間対策）。duration は合算する。 */
export function stepDurations(
  durations: number[],
  step: number,
): { indices: number[]; durations: number[] } {
  if (step <= 1) {
    return { indices: durations.map((_, i) => i), durations: [...durations] };
  }
  const indices: number[] = [];
  const merged: number[] = [];
  for (let i = 0; i < durations.length; i += step) {
    indices.push(i);
    let sum = 0;
    for (let j = i; j < Math.min(durations.length, i + step); j++) sum += durations[j];
    merged.push(sum);
  }
  return { indices, durations: merged };
}

// ------------------------------------------------------------
// 単色背景の検出（四隅サンプリング）
// ------------------------------------------------------------

export type FlatBackground = {
  flat: boolean;
  /** 推定背景色 [r, g, b]（0-255）。 */
  bg: [number, number, number];
  /** 四隅ピクセルのばらつき（チャンネルごとの標準偏差の平均）。小さいほど単色。 */
  spread: number;
};

const FLAT_SPREAD_THRESHOLD = 8;

export function detectFlatBackground(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): FlatBackground {
  const patch = Math.max(1, Math.min(16, Math.floor(Math.min(width, height) / 2)));
  const corners: Array<[number, number]> = [
    [0, 0],
    [width - patch, 0],
    [0, height - patch],
    [width - patch, height - patch],
  ];
  const samples: number[] = [];
  for (const [cx, cy] of corners) {
    for (let y = cy; y < cy + patch; y++) {
      for (let x = cx; x < cx + patch; x++) {
        const i = (y * width + x) * 4;
        if (rgba[i + 3] >= 250) samples.push(rgba[i], rgba[i + 1], rgba[i + 2]);
      }
    }
  }
  if (samples.length < 12) {
    // 四隅がほぼ透明な画像は「単色背景」とは扱わない（デコンタミネーションしない）
    return { flat: false, bg: [0, 0, 0], spread: Number.POSITIVE_INFINITY };
  }
  const count = samples.length / 3;
  const medians: number[] = [];
  let spreadSum = 0;
  for (let c = 0; c < 3; c++) {
    const channel: number[] = [];
    for (let i = c; i < samples.length; i += 3) channel.push(samples[i]);
    const sorted = [...channel].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    medians.push(median);
    let varSum = 0;
    for (const v of channel) varSum += (v - median) * (v - median);
    spreadSum += Math.sqrt(varSum / channel.length);
  }
  const spread = spreadSum / 3;
  return {
    flat: spread <= FLAT_SPREAD_THRESHOLD,
    bg: [medians[0], medians[1], medians[2]],
    spread,
  };
}

// ------------------------------------------------------------
// α後処理: リマップ＋デコンタミネーション
// ------------------------------------------------------------

/** 低αを持ち上げずに切り捨てるリマップ（lo 以下は 0、hi 以上は 1、間は smoothstep）。 */
export function remapAlphaValue(a: number, lo = 0.05, hi = 0.95): number {
  if (a <= lo) return 0;
  if (a >= hi) return 1;
  const t = (a - lo) / (hi - lo);
  return t * t * (3 - 2 * t);
}

/**
 * マスク（0..1 の Float32 配列）を RGBA に適用する。
 * - α は remapAlphaValue で締め直す。
 * - 既存α（透過入力）とは乗算する（元の切り抜きを壊さない）。
 * - bg が与えられた画素（単色背景と判定できた場合）では、半透明画素の色から
 *   背景色を引き剥がす（fg = (rgb - (1-a)*bg) / a）＝ハロ除去。
 * rgba は破壊的に書き換える。mask の値は作業解像度の画素数と一致させること。
 */
export function applyMaskToRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  mask: Float32Array,
  bg: [number, number, number] | null,
): void {
  const n = mask.length;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const sourceAlpha = rgba[i + 3] / 255;
    const a = remapAlphaValue(mask[p]) * sourceAlpha;
    if (a <= 0.003) {
      rgba[i + 3] = 0;
      continue;
    }
    if (a >= 0.999) {
      rgba[i + 3] = 255;
      continue;
    }
    if (bg) {
      for (let c = 0; c < 3; c++) {
        const fg = (rgba[i + c] - (1 - a) * bg[c]) / a;
        rgba[i + c] = Math.max(0, Math.min(255, Math.round(fg)));
      }
    }
    rgba[i + 3] = Math.round(a * 255);
  }
}

// ------------------------------------------------------------
// エンコードのラダー（試行順序の計画）
// ------------------------------------------------------------

export type GifAttempt = { maxEdge: number; step: number; colors: number };
export type StickerGifAttempt = { fitEdge: number; step: number; colors: number };

const GIF_FRAME_STEPS = [1, 2, 3, 4];
const GIF_COLOR_STEPS = [256, 128, 64, 32];

/** 絵文字アニメ GIF の試行順（寸法→間引き→色数の優先順リスト）。 */
export function emojiGifAttempts(): GifAttempt[] {
  const attempts: GifAttempt[] = [];
  for (const maxEdge of [128, 96, 80, 64, 48, 32]) {
    for (const step of GIF_FRAME_STEPS) {
      for (const colors of GIF_COLOR_STEPS) {
        attempts.push({ maxEdge, step, colors });
      }
    }
  }
  return attempts;
}

/** スタンプアニメ GIF の試行順（キャンバスは 320 固定、被写体フィットを落とす）。 */
export function stickerGifAttempts(): StickerGifAttempt[] {
  const attempts: StickerGifAttempt[] = [];
  for (const fitEdge of [320, 256, 192, 128, 96]) {
    for (const step of GIF_FRAME_STEPS) {
      for (const colors of GIF_COLOR_STEPS) {
        attempts.push({ fitEdge, step, colors });
      }
    }
  }
  return attempts;
}

/** 静止画スタンプの試行順（被写体スケール×量子化色数。0 は無劣化 PNG）。 */
export function stickerStillAttempts(): Array<{ fitEdge: number; colors: number }> {
  const attempts: Array<{ fitEdge: number; colors: number }> = [{ fitEdge: 320, colors: 0 }];
  for (const fitEdge of [320, 256, 192, 128, 96]) {
    for (const colors of [256, 128, 64, 32]) {
      attempts.push({ fitEdge, colors });
    }
  }
  return attempts;
}

/** 静止画絵文字の試行順（寸法は固定で量子化だけ落とす。0 は無劣化 PNG）。 */
export function emojiStillAttempts(): Array<{ colors: number }> {
  return [0, 256, 128, 64, 32, 16].map((colors) => ({ colors }));
}

/** bot 側の _fmt_bytes と同じ表記。 */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 10 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024).toFixed(1)} KB`;
}
