"use client";

// 背景透過の処理ページ（クライアントサイド処理）。
// 画像/GIF の受け取り → ONNX Runtime Web（WASM）で背景除去 →
// α後処理（リマップ＋単色背景デコンタミネーション）→ 用途別エンコード →
// プレビュー／ダウンロード／Discord への投稿、までをブラウザ内で完結させる。
// 純粋ロジック（寸法・上限・後処理・ラダー）は lib/bgcut-core.ts に置く。

import { useRef, useState } from "react";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { decompressFrames, parseGIF } from "gifuct-js";
import UPNG from "upng-js";

import {
  MAX_REMOVAL_FRAMES,
  MODEL_INPUT_SIZE,
  WORK_MAX_EDGE,
  applyMaskToRgba,
  detectFlatBackground,
  emojiGifAttempts,
  emojiStillAttempts,
  fitWithin,
  formatBytes,
  inputGuardError,
  planFrameSampling,
  purposeBudget,
  purposeFilename,
  stickerGifAttempts,
  stickerPlacement,
  stickerStillAttempts,
  stepDurations,
  type BgCutPurpose,
} from "@/lib/bgcut-core";

type OrtModule = typeof import("onnxruntime-web");
type OrtSession = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;

type WorkFrame = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  duration: number;
};

type ProcessedResult = {
  blob: Blob;
  filename: string;
  format: "PNG" | "GIF";
  width: number;
  height: number;
  notes: string[];
};

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; stage: string; done: number; total: number }
  | { kind: "done"; result: ProcessedResult; previewUrl: string }
  | { kind: "error"; message: string };

const MODEL_PREFERENCE = ["silueta", "u2netp"] as const;
const TIME_BUDGET_MS = 90_000;

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToImageData(canvas: HTMLCanvasElement): ImageData {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function imageDataToCanvas(data: ImageData): HTMLCanvasElement {
  const canvas = makeCanvas(data.width, data.height);
  canvas.getContext("2d")!.putImageData(data, 0, 0);
  return canvas;
}

/** Uint8ClampedArray から ImageData を作る（型の都合で必ずコピーを挟む）。 */
function toImageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
  return new ImageData(new Uint8ClampedArray(data), width, height);
}

/** ImageData を目標サイズへ描き直して新しい ImageData を返す。 */
function resizeImageData(data: ImageData, width: number, height: number): ImageData {
  if (data.width === width && data.height === height) return data;
  const out = makeCanvas(width, height);
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(imageDataToCanvas(data), 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** RGBA を 320×320 入力テンソル（CHW, ImageNet 正規化）へ変換する。 */
function toModelTensor(data: ImageData): Float32Array {
  const size = MODEL_INPUT_SIZE;
  const resized = resizeImageData(data, size, size);
  const px = resized.data;
  const out = new Float32Array(3 * size * size);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) {
      out[c * size * size + i] = (px[i * 4 + c] / 255 - mean[c]) / std[c];
    }
  }
  return out;
}

/** モデルの出力マスク（0..1）を作業解像度の α 配列へ広げる。 */
function maskToWorkAlpha(
  mask: Float32Array,
  workWidth: number,
  workHeight: number,
): Float32Array {
  const size = MODEL_INPUT_SIZE;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of mask) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = Math.max(1e-8, max - min);
  const gray = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = Math.round(((mask[i] - min) / range) * 255);
    gray[i * 4] = v;
    gray[i * 4 + 1] = v;
    gray[i * 4 + 2] = v;
    gray[i * 4 + 3] = 255;
  }
  const resized = resizeImageData(new ImageData(gray, size, size), workWidth, workHeight);
  const out = new Float32Array(workWidth * workHeight);
  for (let i = 0; i < out.length; i++) out[i] = resized.data[i * 4] / 255;
  return out;
}

// ------------------------------------------------------------
// 入力デコード（静止画 / GIF）
// ------------------------------------------------------------

async function decodeStill(file: Blob): Promise<{ frames: WorkFrame[]; width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("画像を読み込めませんでした。"));
        img.src = url;
      });
      bitmap = await createImageBitmap(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const width = bitmap.width;
  const height = bitmap.height;
  const guard = inputGuardError({ bytes: file.size, width, height });
  if (guard) throw new Error(guard);
  const work = fitWithin(width, height, WORK_MAX_EDGE);
  const canvas = makeCanvas(work.width, work.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, work.width, work.height);
  bitmap.close();
  const data = ctx.getImageData(0, 0, work.width, work.height);
  return { frames: [{ data: data.data, width: work.width, height: work.height, duration: 0 }], width, height };
}

function decodeGif(buffer: ArrayBuffer, bytes: number): { frames: WorkFrame[]; width: number; height: number } {
  const gif = parseGIF(buffer);
  const rawFrames = decompressFrames(gif, true);
  if (rawFrames.length === 0) throw new Error("GIF のフレームを読み取れませんでした。");
  // 論理画面サイズは先頭フレームの patch では分からないため、全フレームの
  // 到達範囲から決める（通常の GIF は全フレーム同寸法）。
  const logicalW = maxReach(rawFrames, "x");
  const logicalH = maxReach(rawFrames, "y");
  const guard = inputGuardError({ bytes, width: logicalW, height: logicalH });
  if (guard) throw new Error(guard);
  const work = fitWithin(logicalW, logicalH, WORK_MAX_EDGE);
  const scaleX = work.width / logicalW;
  const scaleY = work.height / logicalH;

  const canvas = makeCanvas(work.width, work.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  let snapshot: ImageData | null = null;
  let prev: { disposal: number; x: number; y: number; w: number; h: number } | null = null;
  const frames: WorkFrame[] = [];
  for (const frame of rawFrames) {
    if (prev) {
      if (prev.disposal === 2) {
        ctx.clearRect(prev.x, prev.y, prev.w, prev.h);
      } else if (prev.disposal === 3 && snapshot) {
        ctx.putImageData(snapshot, 0, 0);
      }
    }
    if (frame.disposalType === 3) {
      snapshot = ctx.getImageData(0, 0, work.width, work.height);
    }
    const patchData = toImageData(frame.patch, frame.dims.width, frame.dims.height);
    const patchCanvas = imageDataToCanvas(patchData);
    const dx = Math.round(frame.dims.left * scaleX);
    const dy = Math.round(frame.dims.top * scaleY);
    const dw = Math.max(1, Math.round(frame.dims.width * scaleX));
    const dh = Math.max(1, Math.round(frame.dims.height * scaleY));
    ctx.drawImage(patchCanvas, dx, dy, dw, dh);
    const full = ctx.getImageData(0, 0, work.width, work.height);
    frames.push({
      data: full.data,
      width: work.width,
      height: work.height,
      duration: Math.max(20, frame.delay || 100),
    });
    prev = { disposal: frame.disposalType, x: dx, y: dy, w: dw, h: dh };
  }
  return { frames, width: logicalW, height: logicalH };
}

function maxReach(
  frames: Array<{ dims: { width: number; height: number; top: number; left: number } }>,
  axis: "x" | "y",
): number {
  return Math.max(
    ...frames.map((f) => (axis === "x" ? f.dims.left + f.dims.width : f.dims.top + f.dims.height)),
  );
}

// ------------------------------------------------------------
// エンコード
// ------------------------------------------------------------

function upngBlob(rgba: Uint8ClampedArray, width: number, height: number, colors: number): Blob {
  const buf = UPNG.encode([rgba.buffer as ArrayBuffer], width, height, colors);
  return new Blob([buf], { type: "image/png" });
}

function encodeStillEmoji(frame: WorkFrame): ProcessedResult {
  const dims = fitWithin(frame.width, frame.height, 128);
  const data = resizeImageData(
    toImageData(frame.data, frame.width, frame.height), dims.width, dims.height);
  for (const attempt of emojiStillAttempts()) {
    const blob = upngBlob(data.data, dims.width, dims.height, attempt.colors);
    if (blob.size <= purposeBudget("emoji")) {
      return {
        blob, filename: purposeFilename("emoji", "PNG"), format: "PNG",
        width: dims.width, height: dims.height,
        notes: attempt.colors > 0 ? ["サイズに収めるため色数を減らしました"] : [],
      };
    }
  }
  throw new Error("256KB 以内に収められませんでした。もっと小さい画像でお試しください。");
}

function encodeStillSticker(frame: WorkFrame): ProcessedResult {
  const src = toImageData(frame.data, frame.width, frame.height);
  for (const attempt of stickerStillAttempts()) {
    const place = stickerPlacement(frame.width, frame.height, attempt.fitEdge);
    const canvas = makeCanvas(320, 320);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const subject = resizeImageData(src, place.width, place.height);
    ctx.putImageData(subject, place.x, place.y);
    const out = ctx.getImageData(0, 0, 320, 320);
    const blob = upngBlob(out.data, 320, 320, attempt.colors);
    if (blob.size <= purposeBudget("sticker")) {
      const notes: string[] = [];
      if (attempt.fitEdge < 320) notes.push("サイズに収めるため被写体を縮小しました");
      if (attempt.colors > 0) notes.push("サイズに収めるため色数を減らしました");
      return {
        blob, filename: purposeFilename("sticker", "PNG"), format: "PNG",
        width: 320, height: 320, notes,
      };
    }
  }
  throw new Error("512KB 以内に収められませんでした。もっと小さい画像でお試しください。");
}

function gifBlobFromFrames(
  frames: Array<{ data: ImageData; duration: number }>,
  colors: number,
): Blob {
  const gif = GIFEncoder();
  frames.forEach((frame, i) => {
    const palette = quantize(frame.data.data, colors);
    const index = applyPalette(frame.data.data, palette);
    gif.writeFrame(index, frame.data.width, frame.data.height, {
      palette,
      delay: frame.duration,
      transparent: true,
      ...(i === 0 ? { repeat: 0 } : {}),
    });
  });
  gif.finish();
  const bytes = gif.bytes();
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/gif" });
}

function encodeAnimEmoji(frames: WorkFrame[], durations: number[]): ProcessedResult {
  const resizedCache = new Map<number, ImageData[]>();
  const resizedFor = (maxEdge: number): ImageData[] => {
    let hit = resizedCache.get(maxEdge);
    if (!hit) {
      hit = frames.map((f) => {
        const dims = fitWithin(f.width, f.height, maxEdge);
        return resizeImageData(toImageData(f.data, f.width, f.height), dims.width, dims.height);
      });
      resizedCache.set(maxEdge, hit);
    }
    return hit;
  };
  for (const attempt of emojiGifAttempts()) {
    const picked = stepDurations(durations, attempt.step);
    const resized = resizedFor(attempt.maxEdge);
    const pickedFrames = picked.indices.map((idx, k) => ({
      data: resized[idx],
      duration: picked.durations[k],
    }));
    const blob = gifBlobFromFrames(pickedFrames, attempt.colors);
    if (blob.size <= purposeBudget("emoji")) {
      const notes: string[] = [];
      if (attempt.maxEdge < 128) notes.push("サイズに収めるため画像を縮小しました");
      if (attempt.step > 1) notes.push("サイズに収めるためフレームを間引きました");
      if (attempt.colors < 256) notes.push("サイズに収めるため色数を減らしました");
      const first = pickedFrames[0].data;
      return {
        blob, filename: purposeFilename("emoji", "GIF"), format: "GIF",
        width: first.width, height: first.height, notes,
      };
    }
  }
  throw new Error("256KB 以内に収められませんでした。短い・小さい GIF でお試しください。");
}

function encodeAnimSticker(frames: WorkFrame[], durations: number[]): ProcessedResult {
  const placedCache = new Map<number, ImageData[]>();
  const placedFor = (fitEdge: number): ImageData[] => {
    let hit = placedCache.get(fitEdge);
    if (!hit) {
      hit = frames.map((f) => {
        const place = stickerPlacement(f.width, f.height, fitEdge);
        const canvas = makeCanvas(320, 320);
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        const subject = resizeImageData(
          toImageData(f.data, f.width, f.height), place.width, place.height);
        ctx.putImageData(subject, place.x, place.y);
        return ctx.getImageData(0, 0, 320, 320);
      });
      placedCache.set(fitEdge, hit);
    }
    return hit;
  };
  for (const attempt of stickerGifAttempts()) {
    const picked = stepDurations(durations, attempt.step);
    const placed = placedFor(attempt.fitEdge);
    const pickedFrames = picked.indices.map((idx, k) => ({
      data: placed[idx],
      duration: picked.durations[k],
    }));
    const blob = gifBlobFromFrames(pickedFrames, attempt.colors);
    if (blob.size <= purposeBudget("sticker")) {
      const notes: string[] = [];
      if (attempt.fitEdge < 320) notes.push("サイズに収めるため被写体を縮小しました");
      if (attempt.step > 1) notes.push("サイズに収めるためフレームを間引きました");
      if (attempt.colors < 256) notes.push("サイズに収めるため色数を減らしました");
      return {
        blob, filename: purposeFilename("sticker", "GIF"), format: "GIF",
        width: 320, height: 320, notes,
      };
    }
  }
  throw new Error("512KB 以内に収められませんでした。短い・小さい GIF でお試しください。");
}

// ------------------------------------------------------------
// モデル読み込み（ONNX Runtime Web / WASM）
// ------------------------------------------------------------

async function fetchWithProgress(
  url: string,
  onProgress: (ratio: number) => void,
): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`モデルを取得できませんでした (${res.status})`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      if (total > 0) onProgress(received / total);
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function availableModels(): Promise<string[]> {
  try {
    const res = await fetch("/models/manifest.json", { cache: "no-store" });
    if (res.ok) {
      const manifest = (await res.json()) as { models?: Array<{ name?: string }> };
      const names = (manifest.models ?? [])
        .map((m) => m.name)
        .filter((n): n is string => typeof n === "string");
      if (names.length > 0) {
        return MODEL_PREFERENCE.filter((name) => names.includes(name));
      }
    }
  } catch {
    // マニフェストが無ければ既定の候補順で直接試す
  }
  return [...MODEL_PREFERENCE];
}

async function createBgcutSession(
  onProgress: (stage: string, ratio: number) => void,
): Promise<{ ort: OrtModule; session: OrtSession; model: string }> {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.wasmPaths = "/ort/";
  ort.env.wasm.numThreads =
    typeof crossOriginIsolated !== "undefined" && crossOriginIsolated
      ? Math.min(4, navigator.hardwareConcurrency || 1)
      : 1;
  const models = await availableModels();
  let lastError: unknown = null;
  for (const model of models) {
    try {
      onProgress(`背景除去モデル（${model}）を読み込んでいます`, 0);
      const bytes = await fetchWithProgress(`/models/${model}.onnx`, (ratio) =>
        onProgress(`背景除去モデル（${model}）を読み込んでいます`, ratio),
      );
      try {
        const session = await ort.InferenceSession.create(bytes, {
          executionProviders: ["wasm"],
        });
        return { ort, session, model };
      } catch (firstError) {
        // プロキシ実行が使えない環境ではメインスレッド実行で再試行する
        ort.env.wasm.proxy = false;
        try {
          const session = await ort.InferenceSession.create(bytes, {
            executionProviders: ["wasm"],
          });
          return { ort, session, model };
        } catch {
          throw firstError;
        }
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("背景除去モデルを読み込めませんでした。");
}

// ------------------------------------------------------------
// コンポーネント
// ------------------------------------------------------------

export default function BgCutClient({
  token,
  purpose,
  expiresAt,
}: {
  token: string;
  purpose: BgCutPurpose;
  expiresAt: number;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [modelNote, setModelNote] = useState<string>("");
  const [postState, setPostState] = useState<"none" | "sending" | "sent" | "failed">("none");
  const [dragOver, setDragOver] = useState(false);
  const sessionRef = useRef<Promise<{ ort: OrtModule; session: OrtSession; model: string }> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<{ bytes: number; width: number; height: number } | null>(null);

  const purposeLabel = purpose === "emoji" ? "絵文字用" : "スタンプ用";
  const budget = purposeBudget(purpose);
  const expiresText = new Date(expiresAt * 1000).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });

  function ensureSession(onProgress: (stage: string, ratio: number) => void) {
    if (!sessionRef.current) {
      sessionRef.current = createBgcutSession(onProgress).catch((error) => {
        sessionRef.current = null;
        throw error;
      });
    }
    return sessionRef.current;
  }

  async function handleFile(file: File) {
    setPostState("none");
    try {
      if (file.size > 25 * 1024 * 1024) {
        throw new Error("ファイルが大きすぎます（上限 25MB）。");
      }
      setPhase({ kind: "busy", stage: "画像を読み込んでいます", done: 0, total: 1 });
      const buffer = await file.arrayBuffer();
      const isGif =
        file.type === "image/gif" ||
        new TextDecoder().decode(buffer.slice(0, 3)) === "GIF";
      const decoded = isGif
        ? decodeGif(buffer, file.size)
        : await decodeStill(file);
      sourceRef.current = {
        bytes: file.size,
        width: decoded.width,
        height: decoded.height,
      };
      const animated = decoded.frames.length > 1;

      // フレーム間引き（上限 60 フレーム、超過分は duration 合算）
      const plan = planFrameSampling(decoded.frames.map((f) => f.duration));
      let workFrames = plan.indices.map((idx) => decoded.frames[idx]);
      let durations = plan.durations;
      const removalNotes: string[] = [];
      if (plan.sampled) {
        removalNotes.push(`フレーム数が多いため ${MAX_REMOVAL_FRAMES} 枚に間引きました`);
      }

      const { ort, session, model } = await ensureSession((stage, ratio) =>
        setPhase({ kind: "busy", stage, done: Math.round(ratio * 100), total: 100 }),
      );
      setModelNote(
        model === "u2netp"
          ? "軽量モデル（u2netp）で処理しました"
          : "高精度モデル（silueta）で処理しました",
      );

      // 単色背景の検出（デコンタミネーション用。最初のフレームで判定）
      const flat = detectFlatBackground(
        workFrames[0].data, workFrames[0].width, workFrames[0].height);
      const bg = flat.flat ? flat.bg : null;

      const inputName = session.inputNames[0];
      const outputName = session.outputNames[0];
      const processed: WorkFrame[] = [];
      const outDurations: number[] = [];
      let stride = 1;
      let i = 0;
      while (i < workFrames.length) {
        const frame = workFrames[i];
        const started = performance.now();
        const tensor = toModelTensor(
          toImageData(frame.data, frame.width, frame.height));
        const input = new ort.Tensor(
          "float32", tensor, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
        const outputs = await session.run({ [inputName]: input });
        const maskData = outputs[outputName].data as Float32Array;
        const alpha = maskToWorkAlpha(maskData, frame.width, frame.height);
        const rgba = new Uint8ClampedArray(frame.data);
        applyMaskToRgba(rgba, alpha, bg);
        processed.push({
          data: rgba, width: frame.width, height: frame.height,
          duration: frame.duration,
        });
        let merged = 0;
        for (let k = i; k < Math.min(workFrames.length, i + stride); k++) {
          merged += durations[k];
        }
        outDurations.push(merged);
        const elapsed = performance.now() - started;
        if (i === 0 && workFrames.length > 1) {
          // 残り時間の見込みから間引き幅を決める（上限 4）
          const remaining = workFrames.length - 1;
          if (elapsed * remaining > TIME_BUDGET_MS) {
            stride = Math.min(4, Math.ceil((elapsed * remaining) / TIME_BUDGET_MS));
            if (stride > 1) {
              removalNotes.push("処理時間短縮のためフレームを間引きました");
            }
          }
        }
        i += stride;
        setPhase({
          kind: "busy",
          stage: `背景を透過しています（${processed.length} / ${Math.ceil(workFrames.length / stride)} フレーム）`,
          done: processed.length,
          total: Math.ceil(workFrames.length / stride),
        });
      }
      workFrames = processed;
      durations = outDurations;

      setPhase({ kind: "busy", stage: "仕上げ（圧縮）を行っています", done: 1, total: 1 });
      // 重いエンコードの前に一度描画を挟む
      await new Promise((resolve) => setTimeout(resolve, 30));
      let result: ProcessedResult;
      if (!animated) {
        result = purpose === "emoji"
          ? encodeStillEmoji(workFrames[0])
          : encodeStillSticker(workFrames[0]);
      } else {
        result = purpose === "emoji"
          ? encodeAnimEmoji(workFrames, durations)
          : encodeAnimSticker(workFrames, durations);
      }
      result.notes = [...removalNotes, ...result.notes];
      const previewUrl = URL.createObjectURL(result.blob);
      setPhase({ kind: "done", result, previewUrl });
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : "処理に失敗しました。",
      });
    }
  }

  async function postToDiscord(result: ProcessedResult) {
    const source = sourceRef.current;
    if (!source) return;
    setPostState("sending");
    try {
      const form = new FormData();
      form.set("token", token);
      form.set("meta", JSON.stringify({
        format: result.format,
        filename: result.filename,
        width: result.width,
        height: result.height,
        inBytes: source.bytes,
        inWidth: source.width,
        inHeight: source.height,
        notes: result.notes,
      }));
      form.set("file", result.blob, result.filename);
      const res = await fetch("/api/bgcut/result", { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `投稿に失敗しました (${res.status})`);
      }
      setPostState("sent");
    } catch {
      setPostState("failed");
    }
  }

  const busy = phase.kind === "busy";

  return (
    <div className="bgcut-page">
      <p className="muted">
        用途：{purposeLabel}（{purpose === "emoji" ? "256KB以下・最大128×128" : "512KB以下・320×320"}）
        ／ リンクの有効期限：{expiresText} まで
      </p>
      <p>
        画像や GIF を選ぶと、この端末のブラウザの中で背景透過と圧縮を行います。
        画像がサーバーへ送られることはありません（Discord へ投稿する場合を除く）。
      </p>

      <div
        className={`bgcut-drop${dragOver ? " bgcut-drop-over" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file && !busy) void handleFile(file);
        }}
        role="button"
        tabIndex={0}
      >
        <p>{busy ? "処理中です…" : "タップして画像／GIFを選ぶ（ドラッグ＆ドロップも可）"}</p>
        <p className="muted">上限 25MB / 6000万画素 ・ アニメ GIF 対応</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file && !busy) void handleFile(file);
        }}
      />

      {phase.kind === "busy" && (
        <div className="bgcut-progress">
          <p>{phase.stage}</p>
          <progress value={phase.done} max={Math.max(1, phase.total)} />
        </div>
      )}

      {phase.kind === "error" && (
        <p className="bgcut-error" role="alert">
          {phase.message}
        </p>
      )}

      {phase.kind === "done" && (
        <div className="bgcut-result">
          <div className="bgcut-preview">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={phase.previewUrl} alt="背景透過の結果" />
          </div>
          <ul className="bgcut-meta">
            <li>形式：{phase.result.format}</li>
            <li>
              サイズ：{formatBytes(phase.result.blob.size)}（上限 {formatBytes(budget)}）
            </li>
            <li>
              寸法：{phase.result.width}×{phase.result.height}
            </li>
            {modelNote && <li>{modelNote}</li>}
            {phase.result.notes.map((note) => (
              <li key={note}>※ {note}</li>
            ))}
          </ul>
          <div className="bgcut-actions">
            <a
              className="bgcut-button"
              href={phase.previewUrl}
              download={phase.result.filename}
            >
              ダウンロード
            </a>
            <button
              type="button"
              className="bgcut-button"
              disabled={postState === "sending" || postState === "sent"}
              onClick={() => void postToDiscord(phase.result)}
            >
              {postState === "sent"
                ? "Discord へ投稿しました"
                : postState === "sending"
                  ? "投稿しています…"
                  : "Discord のチャンネルへ投稿"}
            </button>
          </div>
          {postState === "sent" && (
            <p className="muted">
              投稿を受け付けました。数十秒以内に、リンクを発行したチャンネルへ表示されます。
            </p>
          )}
          {postState === "failed" && (
            <p className="bgcut-error" role="alert">
              投稿に失敗しました。ダウンロードはそのまま使えます。
            </p>
          )}
        </div>
      )}

      <style jsx>{`
        .bgcut-drop {
          border: 2px dashed #888;
          border-radius: 12px;
          padding: 28px 16px;
          text-align: center;
          cursor: pointer;
          margin: 16px 0;
        }
        .bgcut-drop-over {
          border-color: #5865f2;
          background: rgba(88, 101, 242, 0.08);
        }
        .bgcut-preview {
          display: grid;
          place-items: center;
          padding: 16px;
          border-radius: 12px;
          background:
            repeating-conic-gradient(#cfcfcf 0% 25%, #f4f4f4 0% 50%) 0 0 / 24px 24px;
        }
        .bgcut-preview img {
          max-width: 100%;
          max-height: 320px;
        }
        .bgcut-meta {
          list-style: none;
          padding: 0;
        }
        .bgcut-actions {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          margin: 12px 0;
        }
        .bgcut-button {
          display: inline-block;
          padding: 10px 18px;
          border-radius: 8px;
          background: #5865f2;
          color: #fff;
          text-decoration: none;
          border: none;
          font-size: 1rem;
          cursor: pointer;
        }
        .bgcut-button:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .bgcut-error {
          color: #c62828;
        }
        progress {
          width: 100%;
          height: 16px;
        }
      `}</style>
    </div>
  );
}
