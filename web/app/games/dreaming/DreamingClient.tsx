"use client";
// WEB ゲーム「dreaming」のメインクライアント（100svh フルブリード独立シェル .dreaming-shell）。
//
// Transformer 以前の生成モデル（小型 LSTM + 文字レベル n-gram + 2D 条件付きマルコフ場）の
// 忘却・滲み・変質反復・崩れを、切れ目のない水彩霧キャンバス・光条・忘却ゴースト・
// 連続環境音・霧に浮くミニマル明朝 UI として体験させる。

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGesture, type GestureDirection } from "@/lib/gesture";
import { isSfxMuted, setSfxMuted } from "@/lib/sfx";
import {
  DOMAIN_IDS,
  DOMAIN_PALETTES,
  MAX_TEMPERATURE,
  MIN_TEMPERATURE,
  blendDomainColors,
  rgbCss,
  type DomainId,
  type TileKind,
} from "@/lib/games/dreaming-model";
import {
  ANCHOR_RADIUS,
  DREAMING_RECORD_KEY,
  DREAM_MOTIFS,
  MAX_ANCHORS,
  VIEW_RADIUS,
  createDreamGame,
  findNearestSignal,
  getAdjacentContext,
  memoryWindowForDepth,
  mergeRecordWithSession,
  moveDream,
  parseDreamRecord,
  pulseDream,
  redriftDream,
  setDreamTemperature,
  toggleAnchor,
  tileKey,
  type DreamDir,
  type DreamRecord,
  type DreamState,
  type DreamTile,
  type MotifId,
} from "@/lib/games/dreaming";
import { useGamesNav } from "../GamesShell";
import {
  sfxDreamAnchor,
  sfxDreamBump,
  sfxDreamCollect,
  sfxDreamDescend,
  sfxDreamPulse,
  sfxDreamStep,
  stopDreamAmbience,
  updateDreamAmbience,
} from "./dreaming-sfx";
import "./dreaming.css";

type RippleFx = {
  wx: number;
  wy: number;
  startMs: number;
  durMs: number;
  maxRadius: number;
  color: string;
};

type ScreenTapFx = {
  sx: number;
  sy: number;
  startMs: number;
  durMs: number;
};

type CharParticle = {
  wx: number;
  wy: number;
  vx: number;
  vy: number;
  char: string;
  startMs: number;
  durMs: number;
  color: string;
  scale?: number;
};

type TileVisualMeta = {
  x: number;
  y: number;
  kind: TileKind;
  bornMs: number;
  glyph: string;
  floorRgb: [number, number, number];
  accentRgb: [number, number, number];
  inkRgb: [number, number, number];
};

type DissolvingGhost = {
  x: number;
  y: number;
  kind: TileKind;
  glyph: string;
  floorRgb: [number, number, number];
  inkRgb: [number, number, number];
  startMs: number;
  durMs: number;
  driftX: number;
  driftY: number;
};

type AmbientMote = {
  x: number;
  y: number;
  speed: number;
  phase: number;
  size: number;
  depth: number;
};

type MistGlyph = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  char: string;
  phase: number;
  size: number;
};

type TrailNode = {
  x: number;
  y: number;
  atMs: number;
};

const KEY_TO_DIR: Record<string, DreamDir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
  W: "up",
  S: "down",
  A: "left",
  D: "right",
};

const FACING_ANGLE: Record<DreamDir, number> = {
  right: 0,
  down: Math.PI * 0.5,
  left: Math.PI,
  up: -Math.PI * 0.5,
};

function romanGeneration(gen: number): string {
  const table = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
  return gen < table.length ? table[gen] : `G${gen}`;
}

function loadStoredRecord(): DreamRecord {
  try {
    const raw = window.localStorage.getItem(DREAMING_RECORD_KEY);
    if (!raw) return parseDreamRecord(null);
    return parseDreamRecord(JSON.parse(raw));
  } catch {
    return parseDreamRecord(null);
  }
}

function saveStoredRecord(rec: DreamRecord): void {
  try {
    window.localStorage.setItem(DREAMING_RECORD_KEY, JSON.stringify(rec));
  } catch {
    // 保存不可環境でもプレイは継続できる
  }
}

function easeOutCubic(t: number): number {
  const u = 1 - Math.max(0, Math.min(1, t));
  return 1 - u * u * u;
}

/** 決定的なタイルハッシュ（毎フレームのチラつきを防ぐ座標由来乱数 0..1）。 */
function tileHash(x: number, y: number, salt = 0): number {
  let n = Math.imul(x + 374761393, 668265263) ^ Math.imul(y + 1274126177, 2246822519) ^ (salt * 1597334677);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** 古い WebView でも確実に動く角丸矩形パス描画（左上・右上・右下・左下個別の半径対応）。 */
function traceRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radii: number | readonly [number, number, number, number],
): void {
  const [tl, tr, br, bl] =
    typeof radii === "number" ? [radii, radii, radii, radii] : radii;
  const maxR = Math.min(w, h) * 0.5;
  const rTL = Math.min(maxR, Math.max(0, tl));
  const rTR = Math.min(maxR, Math.max(0, tr));
  const rBR = Math.min(maxR, Math.max(0, br));
  const rBL = Math.min(maxR, Math.max(0, bl));
  ctx.beginPath();
  ctx.moveTo(x + rTL, y);
  ctx.lineTo(x + w - rTR, y);
  if (rTR > 0) ctx.quadraticCurveTo(x + w, y, x + w, y + rTR);
  ctx.lineTo(x + w, y + h - rBR);
  if (rBR > 0) ctx.quadraticCurveTo(x + w, y + h, x + w - rBR, y + h);
  ctx.lineTo(x + rBL, y + h);
  if (rBL > 0) ctx.quadraticCurveTo(x, y + h, x, y + h - rBL);
  ctx.lineTo(x, y + rTL);
  if (rTL > 0) ctx.quadraticCurveTo(x, y, x + rTL, y);
  ctx.closePath();
}

/** 12 種類の原型モチーフを絵文字なしで繊細な線画シルエットとして描画する。 */
function drawMotifGlyph(
  ctx: CanvasRenderingContext2D,
  id: MotifId,
  cx: number,
  cy: number,
  r: number,
  stroke: string,
  fill: string,
  timeSec: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = stroke;
  ctx.fillStyle = fill;
  ctx.lineWidth = Math.max(1.3, r * 0.105);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  switch (id) {
    case "payphone": {
      ctx.strokeRect(-r * 0.48, -r * 0.62, r * 0.96, r * 1.24);
      ctx.beginPath();
      ctx.arc(0, -r * 0.08, r * 0.24, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
      ctx.fillRect(-r * 0.24, r * 0.14, r * 0.48, r * 0.26);
      break;
    }
    case "clock": {
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.56, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -r * 0.34);
      ctx.moveTo(0, 0);
      ctx.lineTo(r * 0.26, r * 0.14);
      ctx.stroke();
      break;
    }
    case "vending": {
      ctx.strokeRect(-r * 0.44, -r * 0.62, r * 0.88, r * 1.24);
      ctx.fillRect(-r * 0.3, -r * 0.45, r * 0.6, r * 0.18);
      ctx.fillRect(-r * 0.3, -r * 0.16, r * 0.6, r * 0.18);
      ctx.strokeRect(-r * 0.26, r * 0.22, r * 0.52, r * 0.24);
      break;
    }
    case "aquarium": {
      ctx.strokeRect(-r * 0.62, -r * 0.42, r * 1.24, r * 0.84);
      ctx.beginPath();
      ctx.moveTo(-r * 0.54, -r * 0.08);
      ctx.quadraticCurveTo(0, -r * 0.18 + Math.sin(timeSec * 2.4) * r * 0.06, r * 0.54, -r * 0.08);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(-r * 0.18, r * 0.16, r * 0.07, 0, Math.PI * 2);
      ctx.arc(r * 0.2, r * 0.06, r * 0.05, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "crossing": {
      ctx.beginPath();
      ctx.moveTo(-r * 0.42, -r * 0.52);
      ctx.lineTo(r * 0.42, -r * 0.04);
      ctx.moveTo(r * 0.42, -r * 0.52);
      ctx.lineTo(-r * 0.42, -r * 0.04);
      ctx.moveTo(0, -r * 0.28);
      ctx.lineTo(0, r * 0.58);
      ctx.moveTo(-r * 0.54, r * 0.24);
      ctx.lineTo(r * 0.54, r * 0.02);
      ctx.stroke();
      break;
    }
    case "chalkboard": {
      ctx.strokeRect(-r * 0.64, -r * 0.42, r * 1.28, r * 0.82);
      ctx.beginPath();
      ctx.moveTo(-r * 0.42, -r * 0.14);
      ctx.lineTo(r * 0.28, -r * 0.14);
      ctx.moveTo(-r * 0.42, r * 0.12);
      ctx.lineTo(r * 0.08, r * 0.12);
      ctx.stroke();
      break;
    }
    case "bookshelf": {
      ctx.strokeRect(-r * 0.54, -r * 0.56, r * 1.08, r * 1.12);
      for (const bx of [-0.3, -0.08, 0.14, 0.34]) {
        ctx.beginPath();
        ctx.moveTo(r * bx, -r * 0.46);
        ctx.lineTo(r * bx, -r * 0.04);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(-r * 0.52, 0);
      ctx.lineTo(r * 0.52, 0);
      ctx.moveTo(-r * 0.24, r * 0.1);
      ctx.lineTo(-r * 0.24, r * 0.48);
      ctx.moveTo(r * 0.06, r * 0.1);
      ctx.lineTo(r * 0.22, r * 0.48);
      ctx.stroke();
      break;
    }
    case "umbrella": {
      ctx.beginPath();
      ctx.arc(0, -r * 0.04, r * 0.54, Math.PI, 0);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.04);
      ctx.lineTo(0, r * 0.48);
      ctx.arc(-r * 0.1, r * 0.48, r * 0.1, 0, Math.PI);
      ctx.stroke();
      break;
    }
    case "ticketgate": {
      ctx.strokeRect(-r * 0.62, -r * 0.44, r * 0.34, r * 0.9);
      ctx.strokeRect(r * 0.28, -r * 0.44, r * 0.34, r * 0.9);
      ctx.beginPath();
      ctx.moveTo(-r * 0.14, 0);
      ctx.lineTo(r * 0.14, 0);
      ctx.moveTo(r * 0.02, -r * 0.14);
      ctx.lineTo(r * 0.14, 0);
      ctx.lineTo(r * 0.02, r * 0.14);
      ctx.stroke();
      break;
    }
    case "lighthouse": {
      ctx.beginPath();
      ctx.moveTo(-r * 0.26, r * 0.58);
      ctx.lineTo(-r * 0.14, -r * 0.34);
      ctx.lineTo(r * 0.14, -r * 0.34);
      ctx.lineTo(r * 0.26, r * 0.58);
      ctx.closePath();
      ctx.stroke();
      const beam = Math.sin(timeSec * 1.8) * 0.45;
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.44);
      ctx.lineTo(Math.cos(beam - 0.35) * r * 0.68, -r * 0.44 + Math.sin(beam - 0.35) * r * 0.28);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -r * 0.44, r * 0.12, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "mirror": {
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.4, r * 0.58, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-r * 0.16, -r * 0.26);
      ctx.lineTo(r * 0.14, -r * 0.04);
      ctx.moveTo(-r * 0.12, r * 0.08);
      ctx.lineTo(r * 0.12, r * 0.26);
      ctx.stroke();
      break;
    }
    case "stairwell": {
      ctx.beginPath();
      ctx.moveTo(-r * 0.54, r * 0.48);
      ctx.lineTo(-r * 0.54, r * 0.16);
      ctx.lineTo(-r * 0.18, r * 0.16);
      ctx.lineTo(-r * 0.18, -r * 0.16);
      ctx.lineTo(r * 0.18, -r * 0.16);
      ctx.lineTo(r * 0.18, -r * 0.48);
      ctx.lineTo(r * 0.54, -r * 0.48);
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

/** 35mm フィルム粒状感を作る軽量オフスクリーンパターン（起動時 1 回生成）。 */
function createFilmGrainPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  try {
    const off = document.createElement("canvas");
    off.width = 96;
    off.height = 96;
    const octx = off.getContext("2d");
    if (!octx) return null;
    const img = octx.createImageData(96, 96);
    const d = img.data;
    let seed = 918273;
    for (let i = 0; i < d.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const v = (seed >>> 24) & 255;
      d[i] = v;
      d[i + 1] = Math.max(0, v - 6);
      d[i + 2] = Math.max(0, v - 14);
      d[i + 3] = 20;
    }
    octx.putImageData(img, 0, 0);
    return ctx.createPattern(off, "repeat");
  } catch {
    return null;
  }
}

export default function DreamingClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<DreamState>(() => createDreamGame(20261119));
  const [record, setRecord] = useState<DreamRecord>(() => parseDreamRecord(null));
  const [muted, setMuted] = useState(false);
  // 初期表示は夢空間への没入を最優先し、LSTM デバッグモニタは閉じておく
  const [showRnn, setShowRnn] = useState(false);
  const [showArchive, setShowArchive] = useState(false);

  const stateRef = useRef(state);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // 滑らか補間・忘却ゴースト・軌跡・パーティクル・波紋用のレンダー専用 ref
  const camRef = useRef({
    x: 0,
    y: 0,
    px: 0,
    py: 0,
    facingAngle: 0,
    bumpX: 0,
    bumpY: 0,
    descendFlash: 0,
    breathPhase: 0,
  });
  const ripplesRef = useRef<RippleFx[]>([]);
  const tapRingsRef = useRef<ScreenTapFx[]>([]);
  const particlesRef = useRef<CharParticle[]>([]);
  const tileVisualRef = useRef<Map<string, TileVisualMeta>>(new Map());
  const dissolvingGhostsRef = useRef<DissolvingGhost[]>([]);
  const trailRef = useRef<TrailNode[]>([]);
  const ambientMotesRef = useRef<AmbientMote[]>([]);
  const mistGlyphsRef = useRef<MistGlyph[]>([]);
  const audioUnlockedRef = useRef(false);
  const savedStepsRef = useRef(0);
  const savedForgottenRef = useRef(0);
  const reducedMotionRef = useRef(false);

  // タイル集合の差分を監視し、出現・書き換わり・忘却ゴーストを視覚化する
  const syncTileVisualDiff = useCallback((next: DreamState, resetAll = false) => {
    const now = performance.now();
    const prevMap = tileVisualRef.current;

    if (resetAll) {
      prevMap.clear();
      dissolvingGhostsRef.current = [];
      trailRef.current = [{ x: next.player.x, y: next.player.y, atMs: now }];
      for (const [key, tile] of next.tiles) {
        prevMap.set(key, {
          x: tile.x,
          y: tile.y,
          kind: tile.kind,
          bornMs: now - 160,
          glyph: tile.glyph,
          floorRgb: blendDomainColors(tile.domainBlend, "floor"),
          accentRgb: blendDomainColors(tile.domainBlend, "accent"),
          inkRgb: blendDomainColors(tile.domainBlend, "ink"),
        });
      }
      return;
    }

    // 1. 忘却（evict）されたタイルを「溶ける記憶ゴースト」へ移す
    for (const [key, oldMeta] of prevMap) {
      if (!next.tiles.has(key)) {
        const angle = tileHash(oldMeta.x, oldMeta.y, 19) * Math.PI * 2;
        dissolvingGhostsRef.current.push({
          x: oldMeta.x,
          y: oldMeta.y,
          kind: oldMeta.kind,
          glyph: oldMeta.glyph,
          floorRgb: oldMeta.floorRgb,
          inkRgb: oldMeta.inkRgb,
          startMs: now,
          durMs: 1850,
          driftX: Math.cos(angle) * 0.28,
          driftY: -0.45 - tileHash(oldMeta.x, oldMeta.y, 31) * 0.35,
        });
        prevMap.delete(key);
      }
    }
    if (dissolvingGhostsRef.current.length > 80) {
      dissolvingGhostsRef.current = dissolvingGhostsRef.current.slice(-80);
    }

    // 2. 新規生成＆記憶違い（kind の書き換わり）を検出
    for (const [key, tile] of next.tiles) {
      const existing = prevMap.get(key);
      const floorRgb = blendDomainColors(tile.domainBlend, "floor");
      const accentRgb = blendDomainColors(tile.domainBlend, "accent");
      const inkRgb = blendDomainColors(tile.domainBlend, "ink");

      if (!existing) {
        prevMap.set(key, {
          x: tile.x,
          y: tile.y,
          kind: tile.kind,
          bornMs: now,
          glyph: tile.glyph,
          floorRgb,
          accentRgb,
          inkRgb,
        });
      } else {
        if (existing.kind !== tile.kind) {
          // 視界の縁で密かに記憶違いが起きた／パルスで編み直された瞬間の淡い波紋と文字粒子
          ripplesRef.current.push({
            wx: tile.x,
            wy: tile.y,
            startMs: now,
            durMs: 720,
            maxRadius: 1.05,
            color: rgbCss(accentRgb, 0.55),
          });
          particlesRef.current.push({
            wx: tile.x,
            wy: tile.y,
            vx: (tileHash(tile.x, tile.y, next.step) - 0.5) * 0.45,
            vy: -0.55,
            char: tile.glyph,
            startMs: now,
            durMs: 1300,
            color: rgbCss(inkRgb, 0.72),
            scale: 0.85,
          });
          existing.bornMs = now;
        }
        existing.kind = tile.kind;
        existing.glyph = tile.glyph;
        existing.floorRgb = floorRgb;
        existing.accentRgb = accentRgb;
        existing.inkRgb = inkRgb;
      }
    }
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // クライアント起動後に実シード生成＋保存済み記録＆ミュート設定を読み込む
  useEffect(() => {
    setMuted(isSfxMuted());
    const stored = loadStoredRecord();
    setRecord(stored);
    const fresh = createDreamGame((Date.now() ^ 0x5a17d3) % 2147483647);
    const hydrated: DreamState = {
      ...fresh,
      discoveredMotifs: stored.discoveredMotifs,
      archive: stored.recentArchive,
      maxGeneration: stored.maxGeneration,
    };
    setState(hydrated);
    stateRef.current = hydrated;
    camRef.current = {
      x: 0,
      y: 0,
      px: 0,
      py: 0,
      facingAngle: 0,
      bumpX: 0,
      bumpY: 0,
      descendFlash: 0.65,
      breathPhase: 0,
    };
    syncTileVisualDiff(hydrated, true);
    reducedMotionRef.current =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    return () => {
      stopDreamAmbience();
    };
  }, [syncTileVisualDiff]);

  // 記録の緩やかな自動保存（歩数・深度・標本を端末内へ永続化）
  useEffect(() => {
    const stepDelta = Math.max(0, state.step - savedStepsRef.current);
    const forgotDelta = Math.max(0, state.forgottenCount - savedForgottenRef.current);
    if (
      stepDelta === 0 &&
      forgotDelta === 0 &&
      state.lastEvent.kind !== "collect" &&
      state.lastEvent.kind !== "reunion" &&
      state.lastEvent.kind !== "descend"
    ) {
      return;
    }
    savedStepsRef.current = state.step;
    savedForgottenRef.current = state.forgottenCount;
    setRecord((prev) => {
      const next = mergeRecordWithSession(prev, state, stepDelta, forgotDelta);
      saveStoredRecord(next);
      return next;
    });
  }, [state]);

  // ユーザー操作後に、現在の RNN 領域分布と温度に合わせて連続環境音を調律
  useEffect(() => {
    if (!audioUnlockedRef.current) return;
    if (muted) {
      stopDreamAmbience();
    } else {
      updateDreamAmbience(state.domainWeights, state.temperature, state.depth);
    }
  }, [muted, state.domainWeights, state.temperature, state.depth]);

  // イベントに応じた視覚波紋・文字粒子・足跡軌跡・SE を発火
  const handleEventEffects = useCallback(
    (next: DreamState) => {
      const ev = next.lastEvent;
      const now = performance.now();
      const accent = rgbCss(blendDomainColors(next.domainWeights, "accent"), 0.88);
      const ink = rgbCss(blendDomainColors(next.domainWeights, "ink"), 0.92);

      if (ev.kind === "descend" || ev.kind === "init") {
        syncTileVisualDiff(next, true);
      } else {
        syncTileVisualDiff(next, false);
      }

      if (ev.kind === "move") {
        sfxDreamStep(next.dominantDomain, next.temperature);
        trailRef.current.push({ x: next.player.x, y: next.player.y, atMs: now });
        if (trailRef.current.length > 9) {
          trailRef.current = trailRef.current.slice(-9);
        }
      } else if (ev.kind === "blocked") {
        sfxDreamBump();
        const dx = Math.sign(ev.x - next.player.x);
        const dy = Math.sign(ev.y - next.player.y);
        camRef.current.bumpX = dx * 0.22;
        camRef.current.bumpY = dy * 0.22;
      } else if (ev.kind === "collect" || ev.kind === "reunion") {
        sfxDreamCollect(ev.generation ?? 1);
        ripplesRef.current.push({
          wx: ev.x,
          wy: ev.y,
          startMs: now,
          durMs: ev.kind === "reunion" ? 1150 : 820,
          maxRadius: ev.kind === "reunion" ? 3.8 : 2.5,
          color: ev.kind === "reunion" ? "rgba(228, 194, 118, 0.92)" : accent,
        });
        const chars = Array.from(ev.detail ?? "");
        chars.forEach((ch, idx) => {
          const angle = (idx / Math.max(1, chars.length)) * Math.PI * 2 - Math.PI / 2;
          const speed = 0.55 + (idx % 3) * 0.28;
          particlesRef.current.push({
            wx: ev.x,
            wy: ev.y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 0.42,
            char: ch,
            startMs: now,
            durMs: 1550,
            color: ink,
          });
        });
      } else if (ev.kind === "anchor" || ev.kind === "anchor_evict" || ev.kind === "anchor_remove") {
        sfxDreamAnchor(
          ev.kind === "anchor" ? "place" : ev.kind === "anchor_evict" ? "evict" : "remove",
        );
        ripplesRef.current.push({
          wx: ev.x,
          wy: ev.y,
          startMs: now,
          durMs: 920,
          maxRadius: ANCHOR_RADIUS + 0.7,
          color: "rgba(216, 178, 106, 0.82)",
        });
      } else if (ev.kind === "pulse") {
        sfxDreamPulse();
        ripplesRef.current.push({
          wx: ev.x,
          wy: ev.y,
          startMs: now,
          durMs: 960,
          maxRadius: 3.4,
          color: ink,
        });
      } else if (ev.kind === "descend") {
        sfxDreamDescend();
        camRef.current.x = 0;
        camRef.current.y = 0;
        camRef.current.px = 0;
        camRef.current.py = 0;
        camRef.current.descendFlash = 1;
        ripplesRef.current.push({
          wx: 0,
          wy: 0,
          startMs: now,
          durMs: 1350,
          maxRadius: 5.2,
          color: "rgba(204, 224, 236, 0.82)",
        });
      }
    },
    [syncTileVisualDiff],
  );

  const applyTransition = useCallback(
    (fn: (s: DreamState) => DreamState) => {
      audioUnlockedRef.current = true;
      const next = fn(stateRef.current);
      stateRef.current = next;
      setState(next);
      handleEventEffects(next);
    },
    [handleEventEffects],
  );

  const doMove = useCallback(
    (dir: DreamDir) => {
      applyTransition((s) => moveDream(s, dir));
    },
    [applyTransition],
  );

  const doPulse = useCallback(() => {
    applyTransition((s) => pulseDream(s));
  }, [applyTransition]);

  const doAnchor = useCallback(() => {
    applyTransition((s) => toggleAnchor(s));
  }, [applyTransition]);

  const doTempChange = useCallback(
    (nextTemp: number) => {
      applyTransition((s) => setDreamTemperature(s, nextTemp));
    },
    [applyTransition],
  );

  const doRedrift = useCallback(() => {
    const nextSeed = ((Date.now() ^ (stateRef.current.step * 7919)) >>> 0) || 1;
    savedStepsRef.current = 0;
    applyTransition((s) => redriftDream(s, nextSeed));
    camRef.current.x = 0;
    camRef.current.y = 0;
    camRef.current.px = 0;
    camRef.current.py = 0;
    camRef.current.descendFlash = 0.9;
    setShowArchive(false);
  }, [applyTransition]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    setSfxMuted(next);
    if (next) {
      stopDreamAmbience();
    } else {
      audioUnlockedRef.current = true;
      const cur = stateRef.current;
      updateDreamAmbience(cur.domainWeights, cur.temperature, cur.depth);
    }
  }, [muted]);

  // キーボード操作
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      if (e.key === "Escape") {
        if (showArchive) {
          e.preventDefault();
          setShowArchive(false);
          return;
        }
        if (showRnn) {
          e.preventDefault();
          setShowRnn(false);
          return;
        }
      }
      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        setShowArchive((v) => !v);
        return;
      }
      if (e.key === "h" || e.key === "H") {
        e.preventDefault();
        setShowRnn((v) => !v);
        return;
      }
      if (showArchive) return;

      const dir = KEY_TO_DIR[e.key];
      if (dir) {
        e.preventDefault();
        doMove(dir);
        return;
      }
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        doPulse();
        return;
      }
      if (e.key === "f" || e.key === "F" || e.key === "e" || e.key === "E") {
        e.preventDefault();
        doAnchor();
        return;
      }
      if (e.key === "[" || e.key === "-") {
        e.preventDefault();
        doTempChange(stateRef.current.temperature - 0.12);
        return;
      }
      if (e.key === "]" || e.key === "+" || e.key === "=") {
        e.preventDefault();
        doTempChange(stateRef.current.temperature + 0.12);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [doAnchor, doMove, doPulse, doTempChange, showArchive, showRnn]);

  // 盤面スワイプ・タップは共通 lib/gesture.ts を使う
  const lastPointerPosRef = useRef<{ x: number; y: number } | null>(null);
  const stageGesture = useGesture({
    onSwipe: (dir: GestureDirection) => {
      if (!showArchive) doMove(dir);
    },
    onTap: () => {
      if (showArchive) return;
      const canvas = canvasRef.current;
      const pt = lastPointerPosRef.current;
      if (!canvas || !pt) {
        doPulse();
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const localX = pt.x - rect.left;
      const localY = pt.y - rect.top;
      tapRingsRef.current.push({ sx: localX, sy: localY, startMs: performance.now(), durMs: 520 });

      const dx = localX - rect.width / 2;
      const dy = localY - rect.height / 2;
      const tilePx = Math.max(40, Math.min(64, Math.min(rect.width, rect.height) / 9.8));
      if (Math.hypot(dx, dy) <= tilePx * 0.85) {
        doPulse();
      } else if (Math.abs(dx) > Math.abs(dy)) {
        doMove(dx > 0 ? "right" : "left");
      } else {
        doMove(dy > 0 ? "down" : "up");
      }
    },
  });

  // Canvas 2D 夢フィルム描画ループ（60fps）
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const grainPattern = createFilmGrainPattern(ctx);
    let rafId = 0;
    let width = 1;
    let height = 1;
    let dpr = 1;

    const initAmbientField = (w: number, h: number) => {
      ambientMotesRef.current = Array.from({ length: 46 }, (_, i) => ({
        x: tileHash(i, 1, 7) * w,
        y: tileHash(i, 2, 13) * h,
        speed: 0.25 + tileHash(i, 3, 29) * 0.85,
        phase: tileHash(i, 4, 41) * Math.PI * 2,
        size: 1.1 + tileHash(i, 5, 53) * 2.2,
        depth: 0.4 + tileHash(i, 6, 71) * 0.6,
      }));
      const seedChars = Array.from("ゆめのさかいめきおくのきりとおいおと");
      mistGlyphsRef.current = Array.from({ length: 12 }, (_, i) => ({
        x: tileHash(i, 9, 17) * w,
        y: tileHash(i, 10, 23) * h,
        vx: (tileHash(i, 11, 37) - 0.5) * 9,
        vy: -4 - tileHash(i, 12, 43) * 8,
        char: seedChars[i % seedChars.length],
        phase: tileHash(i, 13, 61) * Math.PI * 2,
        size: 14 + Math.round(tileHash(i, 14, 79) * 10),
      }));
    };

    const resize = () => {
      const rect = stage.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      if (ambientMotesRef.current.length === 0) {
        initAmbientField(width, height);
      }
    };
    resize();

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(stage);

    const drawTileBase = (
      tile: DreamTile,
      cx: number,
      cy: number,
      sz: number,
      tiles: Map<string, DreamTile>,
      timeSec: number,
      alpha: number,
      materialize: number,
      ghostShift: number,
    ) => {
      const floorRgb = blendDomainColors(tile.domainBlend, "floor");
      const wallRgb = blendDomainColors(tile.domainBlend, "wall");
      const accentRgb = blendDomainColors(tile.domainBlend, "accent");
      const inkRgb = blendDomainColors(tile.domainBlend, "ink");

      // グリッド線を消すためタイル同士をわずかに重ねてシームレスに敷く
      const ov = 1.6;
      const sx = cx - sz / 2 - ov * 0.5;
      const sy = cy - sz / 2 - ov * 0.5;
      const w = sz + ov;

      // 領域境界の柔らかい水彩滲みウォッシュ
      const eastNb = tiles.get(tileKey(tile.x + 1, tile.y));
      const southNb = tiles.get(tileKey(tile.x, tile.y + 1));
      const isBorder =
        tile.bleedShock > 0.14 ||
        (eastNb && eastNb.domain !== tile.domain) ||
        (southNb && southNb.domain !== tile.domain);

      if (tile.kind === "water") {
        // 深い水面＋岸辺の柔らかい丸み
        ctx.fillStyle = rgbCss(floorRgb, alpha * 0.72);
        ctx.fillRect(sx, sy, w, w);

        const deep: [number, number, number] = [
          Math.max(8, Math.round(wallRgb[0] * 0.62)),
          Math.max(20, Math.round(wallRgb[1] * 0.94 + 14)),
          Math.max(34, Math.round(wallRgb[2] * 1.18 + 22)),
        ];
        const wN = tiles.get(tileKey(tile.x, tile.y - 1))?.kind === "water";
        const wS = tiles.get(tileKey(tile.x, tile.y + 1))?.kind === "water";
        const wE = tiles.get(tileKey(tile.x + 1, tile.y))?.kind === "water";
        const wW = tiles.get(tileKey(tile.x - 1, tile.y))?.kind === "water";
        const insetN = wN ? 0 : sz * 0.08;
        const insetS = wS ? 0 : sz * 0.08;
        const insetE = wE ? 0 : sz * 0.08;
        const insetW = wW ? 0 : sz * 0.08;
        const rad = sz * 0.24;

        ctx.fillStyle = rgbCss(deep, alpha * 0.94);
        traceRoundedRect(
          ctx,
          sx + insetW,
          sy + insetN,
          w - insetW - insetE,
          w - insetN - insetS,
          [
            !wN && !wW ? rad : 0,
            !wN && !wE ? rad : 0,
            !wS && !wE ? rad : 0,
            !wS && !wW ? rad : 0,
          ],
        );
        ctx.fill();

        // 水面の月光・揺らぎリップル
        const wave = Math.sin(timeSec * 1.45 + tile.x * 0.85 + tile.y * 0.65);
        ctx.strokeStyle = rgbCss(inkRgb, alpha * (0.16 + Math.abs(wave) * 0.14));
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(cx - sz * 0.3, cy - sz * 0.12 + wave * 2.2);
        ctx.quadraticCurveTo(cx, cy - sz * 0.16 - wave * 1.4, cx + sz * 0.26, cy - sz * 0.1 + wave * 1.6);
        ctx.moveTo(cx - sz * 0.18, cy + sz * 0.18 - wave * 1.8);
        ctx.quadraticCurveTo(cx + sz * 0.08, cy + sz * 0.14 + wave * 1.6, cx + sz * 0.32, cy + sz * 0.2 - wave * 1.2);
        ctx.stroke();
      } else {
        // シームレス床ベース
        ctx.fillStyle = rgbCss(floorRgb, alpha);
        ctx.fillRect(sx, sy, w, w);

        // 穏やかな領域固有の床テクスチャ（角ばりを抑えた有機的トーン）
        const h = tileHash(tile.x, tile.y, 3);
        if (tile.kind === "floor" || tile.kind === "lamp") {
          if (tile.domain === "school") {
            // 放課後校舎の艶のある木目フローリング
            ctx.strokeStyle = rgbCss(wallRgb, alpha * 0.18);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(sx, cy - sz * 0.18);
            ctx.lineTo(sx + w, cy - sz * 0.18);
            ctx.moveTo(sx, cy + sz * 0.2);
            ctx.lineTo(sx + w, cy + sz * 0.2);
            ctx.stroke();
          } else if (tile.domain === "station" && (tile.x + tile.y) % 4 === 0) {
            ctx.fillStyle = rgbCss(accentRgb, alpha * 0.14);
            ctx.fillRect(sx + 4, sy + w - 6, w - 8, 2);
          } else if (tile.domain === "arcade" && h > 0.66) {
            // 雨濡れ石畳の淡い水たまり反射
            const pGrad = ctx.createRadialGradient(cx, cy, 1, cx, cy, sz * 0.38);
            pGrad.addColorStop(0, rgbCss(accentRgb, alpha * 0.18));
            pGrad.addColorStop(0.6, rgbCss(inkRgb, alpha * 0.08));
            pGrad.addColorStop(1, rgbCss(inkRgb, 0));
            ctx.fillStyle = pGrad;
            ctx.beginPath();
            ctx.ellipse(cx, cy, sz * 0.36, sz * 0.22, 0.2, 0, Math.PI * 2);
            ctx.fill();
          } else if (tile.domain === "meadow" && h > 0.42) {
            // 夕暮れの草地：風に揺れる草穂
            const sway = Math.sin(timeSec * 1.5 + tile.x * 0.7 + tile.y * 0.4) * 3.2;
            ctx.strokeStyle = rgbCss(accentRgb, alpha * 0.2);
            ctx.lineWidth = 1.05;
            ctx.beginPath();
            ctx.moveTo(cx - sz * 0.16, cy + sz * 0.24);
            ctx.quadraticCurveTo(cx - sz * 0.14 + sway * 0.5, cy + sz * 0.04, cx - sz * 0.09 + sway, cy - sz * 0.12);
            ctx.moveTo(cx + sz * 0.12, cy + sz * 0.28);
            ctx.quadraticCurveTo(cx + sz * 0.14 + sway * 0.5, cy + sz * 0.1, cx + sz * 0.19 + sway, cy - sz * 0.05);
            ctx.stroke();
          } else if (tile.domain === "harbor" && h > 0.7) {
            ctx.fillStyle = rgbCss(inkRgb, alpha * 0.06);
            ctx.beginPath();
            ctx.ellipse(cx, cy, sz * 0.42, sz * 0.28, -0.3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      if (isBorder) {
        const bleed = ctx.createRadialGradient(cx, cy, sz * 0.08, cx, cy, sz * 0.92);
        bleed.addColorStop(0, rgbCss(accentRgb, alpha * (0.1 + tile.bleedShock * 0.16)));
        bleed.addColorStop(1, rgbCss(accentRgb, 0));
        ctx.fillStyle = bleed;
        ctx.beginPath();
        ctx.arc(cx, cy, sz * 0.92, 0, Math.PI * 2);
        ctx.fill();
      }

      // 構造物レイヤー（影＋柔らかい建築ディテール）
      if (tile.kind === "wall" || tile.kind === "shelf" || tile.kind === "window") {
        // 南東側への柔らかい接地影
        const southTile = tiles.get(tileKey(tile.x, tile.y + 1));
        if (southTile && southTile.kind !== "wall" && southTile.kind !== "shelf" && southTile.kind !== "window") {
          const shGrad = ctx.createLinearGradient(0, sy + w - 1, 0, sy + w + sz * 0.34);
          shGrad.addColorStop(0, `rgba(4, 7, 12, ${alpha * 0.38})`);
          shGrad.addColorStop(1, "rgba(4, 7, 12, 0)");
          ctx.fillStyle = shGrad;
          ctx.fillRect(sx, sy + w - 1, w, sz * 0.34);
        }

        if (tile.kind === "wall") {
          ctx.fillStyle = rgbCss(wallRgb, alpha * 0.96);
          ctx.fillRect(sx, sy, w, w);
          // わずかな天面ハイライトで立体感を出す
          ctx.fillStyle = rgbCss(inkRgb, alpha * 0.11);
          ctx.fillRect(sx, sy, w, 2.5);
        } else if (tile.kind === "shelf") {
          ctx.fillStyle = rgbCss(wallRgb, alpha * 0.96);
          traceRoundedRect(ctx, sx + 2, sy + 2, w - 4, w - 4, 4);
          ctx.fill();
          // 不揃いな古書の背表紙
          for (let i = 0; i < 4; i++) {
            const bx = sx + 6 + i * ((w - 12) / 3.6);
            const bh = (w - 14) * (0.72 + tileHash(tile.x, tile.y, 10 + i) * 0.28);
            ctx.strokeStyle = i % 2 === 0 ? rgbCss(accentRgb, alpha * 0.34) : rgbCss(inkRgb, alpha * 0.22);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(bx, sy + w - 6);
            ctx.lineTo(bx, sy + w - 6 - bh);
            ctx.stroke();
          }
        } else if (tile.kind === "window") {
          ctx.fillStyle = rgbCss(wallRgb, alpha * 0.96);
          ctx.fillRect(sx, sy, w, w);
          // 窓枠から漏れ出す淡い夕光／月光
          const winGrad = ctx.createLinearGradient(sx, sy, sx + w, sy + w);
          winGrad.addColorStop(0, rgbCss(accentRgb, alpha * 0.56));
          winGrad.addColorStop(1, rgbCss(inkRgb, alpha * 0.28));
          ctx.fillStyle = winGrad;
          traceRoundedRect(ctx, sx + 5, sy + 5, w - 10, w - 10, 3);
          ctx.fill();
          ctx.strokeStyle = rgbCss(wallRgb, alpha * 0.72);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(cx, sy + 5);
          ctx.lineTo(cx, sy + w - 5);
          ctx.moveTo(sx + 5, cy);
          ctx.lineTo(sx + w - 5, cy);
          ctx.stroke();
        }
      } else if (tile.kind === "rail") {
        const hasNS =
          tiles.get(tileKey(tile.x, tile.y - 1))?.kind === "rail" ||
          tiles.get(tileKey(tile.x, tile.y + 1))?.kind === "rail";
        const hasEW =
          tiles.get(tileKey(tile.x - 1, tile.y))?.kind === "rail" ||
          tiles.get(tileKey(tile.x + 1, tile.y))?.kind === "rail";
        const horizontal = hasEW && !hasNS;
        ctx.strokeStyle = rgbCss(wallRgb, alpha * 0.62);
        ctx.lineWidth = 2.2;
        for (let k = 0.18; k <= 0.86; k += 0.32) {
          ctx.beginPath();
          if (horizontal) {
            ctx.moveTo(sx + w * k, sy + w * 0.22);
            ctx.lineTo(sx + w * k, sy + w * 0.78);
          } else {
            ctx.moveTo(sx + w * 0.22, sy + w * k);
            ctx.lineTo(sx + w * 0.78, sy + w * k);
          }
          ctx.stroke();
        }
        const glint = 0.38 + Math.max(0, Math.sin(timeSec * 1.4 - (tile.x + tile.y) * 0.55)) * 0.34;
        ctx.strokeStyle = rgbCss(inkRgb, alpha * glint);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (horizontal) {
          ctx.moveTo(sx, sy + w * 0.33);
          ctx.lineTo(sx + w, sy + w * 0.33);
          ctx.moveTo(sx, sy + w * 0.67);
          ctx.lineTo(sx + w, sy + w * 0.67);
        } else {
          ctx.moveTo(sx + w * 0.33, sy);
          ctx.lineTo(sx + w * 0.33, sy + w);
          ctx.moveTo(sx + w * 0.67, sy);
          ctx.lineTo(sx + w * 0.67, sy + w);
        }
        ctx.stroke();
      } else if (tile.kind === "rift") {
        // 深層への裂け目：二重露光の墨霧渦＋吸い込まれる文字断片
        const pulse = 0.88 + Math.sin(timeSec * 2.2) * 0.12;
        const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, sz * 0.78);
        grad.addColorStop(0, "rgba(4, 7, 12, 0.96)");
        grad.addColorStop(0.45, rgbCss(inkRgb, alpha * 0.26));
        grad.addColorStop(0.75, rgbCss(accentRgb, alpha * 0.16));
        grad.addColorStop(1, rgbCss(accentRgb, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, sz * 0.78, 0, Math.PI * 2);
        ctx.fill();

        for (let ring = 0; ring < 3; ring++) {
          ctx.strokeStyle =
            ring === 0 ? rgbCss(accentRgb, alpha * 0.75) : rgbCss(inkRgb, alpha * (0.48 - ring * 0.12));
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          const rad = sz * (0.14 + ring * 0.13) * pulse;
          const a0 = timeSec * (ring % 2 === 0 ? 0.85 : -0.62) + ring * 1.6;
          ctx.arc(cx, cy, rad, a0, a0 + Math.PI * 1.35);
          ctx.stroke();
        }

        // 裂け目の周縁を漂う文字トークン
        ctx.font = `400 ${Math.round(sz * 0.24)}px "Shippori Mincho", "Hiragino Mincho ProN", serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const orbitAngle = timeSec * 0.7 + tile.x;
        ctx.fillStyle = rgbCss(inkRgb, alpha * 0.55);
        ctx.fillText(
          tile.glyph,
          cx + Math.cos(orbitAngle) * sz * 0.42,
          cy + Math.sin(orbitAngle) * sz * 0.42,
        );
      }

      // 出現直後（materialize < 1）または忘却しかけ・高温時の char-LM 仮名残滓
      const temp = stateRef.current.temperature;
      const fadingAlpha = tile.memory < 0.72 ? (0.72 - tile.memory) * 0.68 : 0;
      const bornAlpha = materialize < 0.95 ? (1 - materialize) * 0.52 : 0;
      const heatAlpha = temp > 1.22 && tileHash(tile.x, tile.y, 41) > 0.78 ? (temp - 1.22) * 0.34 : 0;
      const glyphAlpha = Math.min(0.55, Math.max(fadingAlpha, bornAlpha, heatAlpha)) * alpha;

      if (glyphAlpha > 0.04 && tile.kind !== "rift" && !tile.motif) {
        ctx.font = `400 ${Math.round(sz * 0.36)}px "Shippori Mincho", "Hiragino Mincho ProN", Georgia, serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        // 高温時は二重露光の文字滲み
        if (ghostShift > 0.5) {
          ctx.fillStyle = rgbCss(accentRgb, glyphAlpha * 0.45);
          ctx.fillText(tile.glyph, cx + ghostShift, cy - ghostShift * 0.4);
        }
        ctx.fillStyle = rgbCss(inkRgb, glyphAlpha);
        ctx.fillText(tile.glyph, cx, cy);
      }
    };

    const render = (now: number) => {
      const s = stateRef.current;
      const timeSec = now / 1000;
      const cam = camRef.current;
      const reduced = reducedMotionRef.current;

      // 滑らかなカメラ・視線角・プレイヤー補間
      const lerp = reduced ? 1 : 0.14;
      cam.px += (s.player.x - cam.px) * lerp;
      cam.py += (s.player.y - cam.py) * lerp;
      cam.x += (s.player.x - cam.x) * (lerp * 0.68);
      cam.y += (s.player.y - cam.y) * (lerp * 0.68);
      cam.bumpX *= 0.76;
      cam.bumpY *= 0.76;
      cam.descendFlash = Math.max(0, cam.descendFlash - 0.02);

      const targetAngle = FACING_ANGLE[s.player.facing];
      let angleDiff = targetAngle - cam.facingAngle;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      cam.facingAngle += angleDiff * (reduced ? 1 : 0.18);

      ctx.save();
      ctx.scale(dpr, dpr);

      const fogRgb = blendDomainColors(s.domainWeights, "fog");
      const accentRgb = blendDomainColors(s.domainWeights, "accent");
      const inkRgb = blendDomainColors(s.domainWeights, "ink");

      // 背景：中心に微かな余韻を帯びた深い夢霧グラデーション
      const bgGrad = ctx.createRadialGradient(
        width * 0.5,
        height * 0.48,
        Math.min(width, height) * 0.08,
        width * 0.5,
        height * 0.5,
        Math.max(width, height) * 0.78,
      );
      bgGrad.addColorStop(
        0,
        rgbCss(
          [
            Math.min(255, fogRgb[0] + 10),
            Math.min(255, fogRgb[1] + 12),
            Math.min(255, fogRgb[2] + 14),
          ],
          1,
        ),
      );
      bgGrad.addColorStop(1, rgbCss(fogRgb, 1));
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      const tileSz = Math.max(40, Math.min(64, Math.min(width, height) / 9.8));
      const centerX = width / 2;
      const centerY = height / 2;

      // 温度と滲みに応じた周辺空間の極緩い夢揺らぎ（低 T ほど静止、高 T ほど水中のように揺れる）
      const dreamIntensity = Math.max(0, (s.temperature - 0.55) * 0.85 + s.bleedEntropy * 0.45);
      const ghostShift = reduced ? 0 : Math.max(0, (s.temperature - 0.95) * 4.2 + s.bleedEntropy * 2.2);

      const worldToScreen = (wx: number, wy: number, applyDreamWarp = false) => {
        let sx = centerX + (wx - cam.x) * tileSz;
        let sy = centerY + (wy - cam.y) * tileSz;
        if (applyDreamWarp && !reduced && dreamIntensity > 0.08) {
          const d = Math.hypot(wx - cam.px, wy - cam.py);
          const factor = Math.max(0, d - 2.1) * dreamIntensity * 1.15;
          sx += Math.sin(timeSec * 0.9 + wy * 0.75 + wx * 0.35) * factor;
          sy += Math.cos(timeSec * 0.75 + wx * 0.7 - wy * 0.4) * factor;
        }
        return { x: sx, y: sy };
      };

      // 1. 忘却ゴースト層（evict されたタイルが霧と文字へ溶けて消える）
      dissolvingGhostsRef.current = dissolvingGhostsRef.current.filter((g) => {
        const t = (now - g.startMs) / g.durMs;
        if (t >= 1) return false;
        const pos = worldToScreen(g.x + g.driftX * t, g.y + g.driftY * t, true);
        const a = Math.pow(1 - t, 1.5) * 0.48;
        const rad = tileSz * (0.58 + t * 0.42);
        const wash = ctx.createRadialGradient(pos.x, pos.y, 1, pos.x, pos.y, rad);
        wash.addColorStop(0, rgbCss(g.floorRgb, a));
        wash.addColorStop(1, rgbCss(g.floorRgb, 0));
        ctx.fillStyle = wash;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, rad, 0, Math.PI * 2);
        ctx.fill();

        ctx.font = `400 ${Math.round(tileSz * (0.34 + t * 0.14))}px "Shippori Mincho", "Hiragino Mincho ProN", serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = rgbCss(g.inkRgb, a * 1.25);
        ctx.fillText(g.glyph, pos.x, pos.y - t * 14);
        return true;
      });

      // 2. 記憶されているタイル群を描画（出現フェード＋忘却フェード）
      const lightSources: Array<{ tile: DreamTile; x: number; y: number; alpha: number }> = [];
      for (const tile of s.tiles.values()) {
        const pos = worldToScreen(tile.x, tile.y, true);
        if (
          pos.x + tileSz < -tileSz ||
          pos.x - tileSz > width + tileSz ||
          pos.y + tileSz < -tileSz ||
          pos.y - tileSz > height + tileSz
        ) {
          continue;
        }
        const meta = tileVisualRef.current.get(tileKey(tile.x, tile.y));
        const materialize = meta && !reduced ? easeOutCubic((now - meta.bornMs) / 540) : 1;
        const distFromPlayer = Math.hypot(tile.x - cam.px, tile.y - cam.py);
        const visionFade = Math.max(0, Math.min(1, 1 - (distFromPlayer - (VIEW_RADIUS - 2.1)) / 2.9));
        const alpha = Math.max(0, Math.min(1, tile.memory * visionFade * materialize));
        if (alpha <= 0.03) continue;

        drawTileBase(tile, pos.x, pos.y, tileSz, s.tiles, timeSec, alpha, materialize, ghostShift);
        if (tile.kind === "window" || tile.kind === "lamp") {
          lightSources.push({ tile, x: pos.x, y: pos.y, alpha });
        }
      }

      // 3. 夢の光学レイヤー（窓からの斜め光条＋街灯の柔らかい加算ブルーム）
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const src of lightSources) {
        const lAccent = blendDomainColors(src.tile.domainBlend, "accent");
        const lInk = blendDomainColors(src.tile.domainBlend, "ink");
        if (src.tile.kind === "window") {
          // 窓から床へ斜めに差し込む夕日／月光のボリューメトリック光条
          const sway = reduced ? 0 : Math.sin(timeSec * 0.65 + src.tile.x) * 4;
          const beamLen = tileSz * 2.5;
          const bx = src.x + tileSz * 0.95 + sway;
          const by = src.y + beamLen * 0.78;
          const bGrad = ctx.createLinearGradient(src.x, src.y, bx, by);
          bGrad.addColorStop(0, rgbCss(lAccent, src.alpha * 0.24));
          bGrad.addColorStop(0.55, rgbCss(lInk, src.alpha * 0.09));
          bGrad.addColorStop(1, rgbCss(lAccent, 0));
          ctx.fillStyle = bGrad;
          ctx.beginPath();
          ctx.moveTo(src.x - tileSz * 0.32, src.y + tileSz * 0.15);
          ctx.lineTo(src.x + tileSz * 0.34, src.y - tileSz * 0.22);
          ctx.lineTo(bx + tileSz * 0.78, by - tileSz * 0.25);
          ctx.lineTo(bx - tileSz * 0.42, by + tileSz * 0.52);
          ctx.closePath();
          ctx.fill();
        } else if (src.tile.kind === "lamp") {
          const breathe = reduced ? 1 : 0.92 + Math.sin(timeSec * 2.1 + src.tile.x * 1.3) * 0.08;
          const rad = tileSz * 1.95 * breathe;
          const glow = ctx.createRadialGradient(src.x, src.y, 1, src.x, src.y, rad);
          glow.addColorStop(0, rgbCss(lAccent, src.alpha * 0.42));
          glow.addColorStop(0.35, rgbCss(lAccent, src.alpha * 0.16));
          glow.addColorStop(1, rgbCss(lAccent, 0));
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(src.x, src.y, rad, 0, Math.PI * 2);
          ctx.fill();

          // ランプの芯
          ctx.fillStyle = rgbCss(lInk, src.alpha * 0.92);
          ctx.beginPath();
          ctx.arc(src.x, src.y, Math.max(2.6, tileSz * 0.075), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();

      // 4. 記憶のしおり（Anchor）の穏やかな保護枠と真鍮の菱形標
      for (const anchor of s.anchors) {
        const pos = worldToScreen(anchor.x, anchor.y, false);
        const boxW = (ANCHOR_RADIUS * 2 + 1) * tileSz;
        const bx = pos.x - boxW / 2;
        const by = pos.y - boxW / 2;
        ctx.save();
        // 角だけの繊細なブックマーク枠（全面の破線より上品で夢を壊さない）
        const corner = tileSz * 0.48;
        ctx.strokeStyle = "rgba(216, 178, 106, 0.44)";
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        // 左上
        ctx.moveTo(bx + 2, by + corner);
        ctx.lineTo(bx + 2, by + 2);
        ctx.lineTo(bx + corner, by + 2);
        // 右上
        ctx.moveTo(bx + boxW - corner, by + 2);
        ctx.lineTo(bx + boxW - 2, by + 2);
        ctx.lineTo(bx + boxW - 2, by + corner);
        // 右下
        ctx.moveTo(bx + boxW - 2, by + boxW - corner);
        ctx.lineTo(bx + boxW - 2, by + boxW - 2);
        ctx.lineTo(bx + boxW - corner, by + boxW - 2);
        // 左下
        ctx.moveTo(bx + corner, by + boxW - 2);
        ctx.lineTo(bx + 2, by + boxW - 2);
        ctx.lineTo(bx + 2, by + boxW - corner);
        ctx.stroke();

        // 中央の呼吸する真鍮菱形
        const pulse = reduced ? 1 : 0.94 + Math.sin(timeSec * 2.2) * 0.08;
        const r = tileSz * 0.22 * pulse;
        ctx.strokeStyle = "rgba(216, 178, 106, 0.88)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y - r);
        ctx.lineTo(pos.x + r * 0.84, pos.y);
        ctx.lineTo(pos.x, pos.y + r);
        ctx.lineTo(pos.x - r * 0.84, pos.y);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }

      // 5. モチーフ描画（線画シルエット＋二重露光エコー＋明朝体ラベル）
      for (const tile of s.tiles.values()) {
        if (!tile.motif) continue;
        const pos = worldToScreen(tile.x, tile.y, true);
        const dist = Math.hypot(tile.x - cam.px, tile.y - cam.py);
        const alpha = Math.max(0.14, Math.min(1, tile.memory * (1 - (dist - (VIEW_RADIUS - 1.5)) / 2.7)));
        if (alpha <= 0.06) continue;

        const isReunion = tile.motif.generation >= 2;
        const bob = reduced ? 0 : Math.sin(timeSec * 1.9 + tile.x + tile.y) * 2.8;
        const my = pos.y + bob;
        const origAccent = DOMAIN_PALETTES[tile.motif.originDomain].accent;
        const curAccent = DOMAIN_PALETTES[tile.motif.domain].accent;

        // 背後の柔らかな光輪
        const halo = ctx.createRadialGradient(pos.x, my, 2, pos.x, my, tileSz * 0.85);
        halo.addColorStop(0, rgbCss(isReunion ? origAccent : curAccent, alpha * 0.42));
        halo.addColorStop(0.55, rgbCss(curAccent, alpha * 0.14));
        halo.addColorStop(1, rgbCss(curAccent, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(pos.x, my, tileSz * 0.85, 0, Math.PI * 2);
        ctx.fill();

        if (isReunion) {
          ctx.strokeStyle = rgbCss(origAccent, alpha * 0.65);
          ctx.lineWidth = 1.15;
          ctx.beginPath();
          ctx.arc(pos.x, my, tileSz * (0.4 + Math.sin(timeSec * 2.4) * 0.03), 0, Math.PI * 2);
          ctx.stroke();
        }

        // 高温・変質時は二重露光の幻影を重ねる
        if ((isReunion || ghostShift > 0.9) && !reduced) {
          const ox = Math.cos(timeSec * 1.1 + tile.x) * (2.2 + ghostShift * 0.65);
          const oy = Math.sin(timeSec * 0.9 + tile.y) * (1.8 + ghostShift * 0.45);
          drawMotifGlyph(
            ctx,
            tile.motif.id,
            pos.x + ox,
            my + oy,
            tileSz * 0.34,
            rgbCss(origAccent, alpha * 0.34),
            rgbCss(origAccent, alpha * 0.18),
            timeSec,
          );
        }

        drawMotifGlyph(
          ctx,
          tile.motif.id,
          pos.x,
          my,
          tileSz * 0.33,
          rgbCss(inkRgb, alpha * 0.96),
          rgbCss(isReunion ? origAccent : curAccent, alpha * 0.72),
          timeSec,
        );

        // 枠のない霧テキストで崩れた名前を浮かべる
        if (dist <= 5.2) {
          const label =
            tile.motif.generation >= 2
              ? `${tile.motif.name} ${romanGeneration(tile.motif.generation)}`
              : tile.motif.name;
          ctx.save();
          ctx.font = `400 ${Math.max(11, Math.round(tileSz * 0.23))}px "Shippori Mincho", "Hiragino Mincho ProN", serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.shadowColor = "rgba(6, 10, 16, 0.95)";
          ctx.shadowBlur = 10;
          ctx.fillStyle = isReunion
            ? rgbCss(origAccent, alpha * 0.98)
            : rgbCss(inkRgb, alpha * 0.92);
          ctx.fillText(label, pos.x, my + tileSz * 0.4);
          ctx.restore();
        }
      }

      // 6. 足跡の記憶軌跡（歩いてきた数歩が背後に淡く光って消えていく）
      trailRef.current = trailRef.current.filter((node) => now - node.atMs < 6500);
      if (trailRef.current.length >= 2) {
        ctx.save();
        for (let i = 0; i < trailRef.current.length; i++) {
          const node = trailRef.current[i];
          const age = (now - node.atMs) / 6500;
          const a = Math.max(0, (1 - age) * 0.24);
          const pos = worldToScreen(node.x, node.y, false);
          ctx.fillStyle = rgbCss(inkRgb, a);
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, tileSz * (0.065 * (1 - age * 0.4)), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // 7. 波紋エフェクト
      ripplesRef.current = ripplesRef.current.filter((rp) => {
        const t = (now - rp.startMs) / rp.durMs;
        if (t >= 1) return false;
        const pos = worldToScreen(rp.wx, rp.wy, false);
        const rad = (0.22 + rp.maxRadius * easeOutCubic(t)) * tileSz;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.pow(1 - t, 1.4) * 0.72);
        ctx.strokeStyle = rp.color;
        ctx.lineWidth = 1.8 * (1 - t * 0.5);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, rad, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        return true;
      });

      // 8. プレイヤー（夢の中を漂う灯火・視線光錐・残響コンパス弧）
      const pPos = worldToScreen(cam.px + cam.bumpX, cam.py + cam.bumpY, false);

      // 進行方向へそっと伸びる柔らかい視線の光錐
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const coneLen = tileSz * 3.1;
      const gx = pPos.x + Math.cos(cam.facingAngle) * coneLen;
      const gy = pPos.y + Math.sin(cam.facingAngle) * coneLen;
      const coneGrad = ctx.createRadialGradient(pPos.x, pPos.y, 4, pPos.x, pPos.y, coneLen);
      coneGrad.addColorStop(0, "rgba(244, 234, 212, 0.14)");
      coneGrad.addColorStop(1, "rgba(244, 234, 212, 0)");
      ctx.fillStyle = coneGrad;
      ctx.beginPath();
      ctx.moveTo(pPos.x, pPos.y);
      ctx.arc(pPos.x, pPos.y, coneLen, cam.facingAngle - 0.46, cam.facingAngle + 0.46);
      ctx.closePath();
      ctx.fill();

      // 周囲の霧を押し返す提灯のような柔光
      const pHalo = ctx.createRadialGradient(pPos.x, pPos.y, 2, pPos.x, pPos.y, tileSz * 2.2);
      pHalo.addColorStop(0, "rgba(246, 236, 212, 0.28)");
      pHalo.addColorStop(0.45, rgbCss(accentRgb, 0.1));
      pHalo.addColorStop(1, "rgba(246, 236, 212, 0)");
      ctx.fillStyle = pHalo;
      ctx.beginPath();
      ctx.arc(pPos.x, pPos.y, tileSz * 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      void gx;
      void gy;

      // 最も近い変質モチーフ／裂け目の方向を示す控えめな弧
      const signal = findNearestSignal(s);
      if (signal) {
        const angle = Math.atan2(signal.dy, signal.dx);
        ctx.save();
        ctx.strokeStyle =
          signal.kind === "reunion"
            ? "rgba(228, 194, 118, 0.85)"
            : signal.kind === "rift"
              ? "rgba(156, 206, 224, 0.8)"
              : rgbCss(accentRgb, 0.5);
        ctx.lineWidth = 1.8;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(pPos.x, pPos.y, tileSz * 0.56, angle - 0.3, angle + 0.3);
        ctx.stroke();
        ctx.restore();
      }

      // 灯火のコア（呼吸する光球）
      const corePulse = reduced ? 1 : 1 + Math.sin(timeSec * 2.8) * 0.08;
      ctx.fillStyle = "#f5efe0";
      ctx.beginPath();
      ctx.arc(pPos.x, pPos.y, tileSz * 0.16 * corePulse, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = rgbCss(accentRgb, 0.72);
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(pPos.x, pPos.y, tileSz * 0.28 + (reduced ? 0 : Math.sin(timeSec * 2.4) * 1.4), 0, Math.PI * 2);
      ctx.stroke();

      // 9. 舞い散る文字トークン粒子
      particlesRef.current = particlesRef.current.filter((pt) => {
        const t = (now - pt.startMs) / pt.durMs;
        if (t >= 1) return false;
        const elapsed = (now - pt.startMs) / 1000;
        const pos = worldToScreen(pt.wx + pt.vx * elapsed, pt.wy + pt.vy * elapsed, false);
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.pow(1 - t, 1.3));
        ctx.fillStyle = pt.color;
        ctx.font = `400 ${Math.round(tileSz * 0.32 * (pt.scale ?? 1))}px "Shippori Mincho", "Hiragino Mincho ProN", serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(pt.char, pos.x, pos.y);
        ctx.restore();
        return true;
      });

      // 10. 領域連動の環境パーティクル（商店街の雨・校舎の塵・草地の蛍・港の霧）
      if (!reduced) {
        const rainW = s.domainWeights.arcade ?? 0;
        const dustW = (s.domainWeights.school ?? 0) + (s.domainWeights.library ?? 0);
        const fireflyW = s.domainWeights.meadow ?? 0;

        ctx.save();
        for (const m of ambientMotesRef.current) {
          if (rainW > 0.32) {
            m.x = (m.x - m.speed * 1.4 + width) % width;
            m.y = (m.y + m.speed * 6.5) % height;
            ctx.strokeStyle = rgbCss(inkRgb, 0.12 + rainW * 0.16);
            ctx.lineWidth = 0.85;
            ctx.beginPath();
            ctx.moveTo(m.x, m.y);
            ctx.lineTo(m.x - 4.5, m.y + 15 * m.depth);
            ctx.stroke();
          } else {
            m.x = (m.x + Math.sin(timeSec * 0.35 + m.phase) * 0.32 + m.speed * 0.18 + width) % width;
            m.y = (m.y - m.speed * (0.14 + dustW * 0.1) + height) % height;
            const twinkle = 0.35 + 0.65 * Math.abs(Math.sin(timeSec * (0.8 + fireflyW * 1.4) + m.phase));
            const r = m.size * (fireflyW > 0.3 ? 1.25 : 1);
            ctx.fillStyle =
              fireflyW > 0.3 || dustW > 0.36
                ? rgbCss(accentRgb, 0.22 * twinkle)
                : rgbCss(inkRgb, 0.16 * twinkle);
            ctx.beginPath();
            ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // 外縁の霧にぼんやり浮かぶ char-LM 断片文字（画面の端だけに控えめに漂う）
        const whisperChars = Array.from(s.whisper?.text ?? s.placeName);
        ctx.font = `400 17px "Shippori Mincho", "Hiragino Mincho ProN", serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (let i = 0; i < mistGlyphsRef.current.length; i++) {
          const mg = mistGlyphsRef.current[i];
          mg.x = (mg.x + mg.vx * 0.016 + width) % width;
          mg.y = (mg.y + mg.vy * 0.016 + height) % height;
          const edgeDist = Math.hypot((mg.x - centerX) / (width * 0.5), (mg.y - centerY) / (height * 0.5));
          if (edgeDist < 0.62) continue;
          const ch = whisperChars.length > 0 ? whisperChars[i % whisperChars.length] : mg.char;
          const gA = Math.min(0.16, (edgeDist - 0.62) * 0.28) * (0.55 + 0.45 * Math.sin(timeSec * 0.7 + mg.phase));
          ctx.fillStyle = rgbCss(inkRgb, gA);
          ctx.fillText(ch, mg.x, mg.y);
        }
        ctx.restore();
      }

      // 11. 深度に応じてわずかに狭まる周辺霧ビネット（有限コンテキスト窓の体感）
      const depthTighten = Math.min(0.1, (s.depth - 1) * 0.014);
      const vig = ctx.createRadialGradient(
        centerX,
        centerY,
        Math.min(width, height) * (0.28 - depthTighten),
        centerX,
        centerY,
        Math.max(width, height) * 0.66,
      );
      vig.addColorStop(0, "rgba(0, 0, 0, 0)");
      vig.addColorStop(0.7, rgbCss(fogRgb, 0.42));
      vig.addColorStop(1, rgbCss(fogRgb, 0.92));
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, width, height);

      // 12. 35mm フィルム微粒状テクスチャ
      if (grainPattern) {
        ctx.save();
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = grainPattern;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
      }

      // 13. 画面タップ波紋フィードバック
      tapRingsRef.current = tapRingsRef.current.filter((tr) => {
        const t = (now - tr.startMs) / tr.durMs;
        if (t >= 1) return false;
        ctx.save();
        ctx.strokeStyle = rgbCss(inkRgb, (1 - t) * 0.45);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(tr.sx, tr.sy, 6 + easeOutCubic(t) * 26, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        return true;
      });

      // 14. 潜行・転寝時の静かな霧フェード幕
      if (cam.descendFlash > 0.01) {
        ctx.fillStyle = rgbCss(fogRgb, cam.descendFlash * 0.9);
        ctx.fillRect(0, 0, width, height);
      }

      ctx.restore();
      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
    };
  }, []);

  // 上位 2 つの滲み領域ラベル
  const blendSummary = useMemo(() => {
    const ranked = [...DOMAIN_IDS]
      .map((id) => ({ id, pct: Math.round(state.domainWeights[id] * 100) }))
      .sort((a, b) => b.pct - a.pct);
    const top = ranked.filter((r) => r.pct >= 14).slice(0, 2);
    if (top.length === 0) return DOMAIN_PALETTES[state.dominantDomain].label;
    return top.map((r) => `${DOMAIN_PALETTES[r.id].label} ${r.pct}%`).join(" / ");
  }, [state.domainWeights, state.dominantDomain]);

  // 周囲 1 マスの文脈（隣接モチーフ／裂け目／しおり有無）
  const adjacent = useMemo(() => getAdjacentContext(state), [state]);

  const discoveredCount = Math.max(state.discoveredMotifs.length, record.discoveredMotifs.length);
  const discoveredSet = useMemo(
    () => new Set<MotifId>([...record.discoveredMotifs, ...state.discoveredMotifs]),
    [record.discoveredMotifs, state.discoveredMotifs],
  );
  const maxDepthDisplay = Math.max(state.depth, record.maxDepth);

  // 文脈に応じた主ボタンのラベル＆発光スタイル
  const primaryLabel = adjacent.motif
    ? adjacent.motif.generation >= 2
      ? `再会「${adjacent.motif.name}」`
      : `「${adjacent.motif.name}」に共鳴`
    : adjacent.hasRift
      ? "深層へ潜る"
      : "波紋";

  const primaryClass = adjacent.motif
    ? "dreaming-dock-btn dreaming-dock-btn-motif"
    : adjacent.hasRift
      ? "dreaming-dock-btn dreaming-dock-btn-rift"
      : "dreaming-dock-btn";

  return (
    <div className="dreaming-shell">
      <div
        ref={stageRef}
        className="dreaming-stage"
        role="application"
        aria-label="dreaming の夢空間（矢印キー・WASD・スワイプ・タップで移動、Spaceで共鳴）"
      >
        <canvas
          ref={canvasRef}
          className="dreaming-canvas"
          {...stageGesture}
          onPointerDown={(e) => {
            if (document.activeElement instanceof HTMLElement) {
              document.activeElement.blur();
            }
            lastPointerPosRef.current = { x: e.clientX, y: e.clientY };
            stageGesture.onPointerDown(e);
          }}
        />
      </div>

      {/* 上部フローティング HUD：左に地名と層、右に極小ピル 3 つだけ */}
      <header className="dreaming-hud-top">
        <div className="dreaming-identity">
          <Link
            href={`${prefix}/games`}
            className="dreaming-back"
            aria-label="ゲーム一覧へ戻る"
            title="ゲーム一覧へ戻る"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M10.5 3.5L5.5 8L10.5 12.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
          <div className="dreaming-place">
            <span className="dreaming-place-name">{state.placeName}</span>
            <div className="dreaming-place-meta">
              <span className="dreaming-layer-tag">第{state.depth}層</span>
              <span className="dreaming-meta-sep" aria-hidden="true">
                ·
              </span>
              <span>{blendSummary}</span>
              {state.echoChain > 0 && (
                <>
                  <span className="dreaming-meta-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="dreaming-chain-tag">再会 {state.echoChain}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="dreaming-utilities">
          <button
            type="button"
            className="dreaming-pill-btn"
            aria-pressed={showArchive}
            onClick={() => setShowArchive((v) => !v)}
          >
            <span>標本</span>
            <span className="dreaming-pill-count">
              {discoveredCount}/{DREAM_MOTIFS.length}
            </span>
          </button>
          <button
            type="button"
            className="dreaming-pill-btn"
            aria-pressed={showRnn}
            onClick={() => setShowRnn((v) => !v)}
            title="小型LSTMの隠れ状態・確率分布を表示 (H)"
          >
            <span>LSTM</span>
          </button>
          <button
            type="button"
            className="dreaming-pill-btn dreaming-icon-btn"
            aria-pressed={!muted}
            aria-label={muted ? "音をオンにする" : "無音にする"}
            title={muted ? "音をオンにする" : "無音にする"}
            onClick={toggleMute}
          >
            {muted ? (
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M3 6.2H5.8L9 3.5V12.5L5.8 9.8H3V6.2Z"
                  stroke="currentColor"
                  strokeWidth="1.35"
                  strokeLinejoin="round"
                />
                <path
                  d="M11.3 6.2L14 8.9M14 6.2L11.3 8.9"
                  stroke="currentColor"
                  strokeWidth="1.35"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M3 6.2H5.8L9 3.5V12.5L5.8 9.8H3V6.2Z"
                  stroke="currentColor"
                  strokeWidth="1.35"
                  strokeLinejoin="round"
                />
                <path
                  d="M11.2 5.6C12.2 6.6 12.2 9.4 11.2 10.4M13 4C14.8 5.9 14.8 10.1 13 12"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </div>
      </header>

      {/* 折りたたみ式 LSTM 隠れ状態インスペクタ（必要なときだけ開く） */}
      {showRnn && (
        <aside className="dreaming-rnn-panel" aria-label="RNN 隠れ状態モニタ">
          <div className="dreaming-rnn-head">
            <span>LSTM HIDDEN STATE</span>
            <span>窓 {memoryWindowForDepth(state.depth)}歩</span>
          </div>
          <div className="dreaming-rnn-bars" aria-hidden="true">
            {state.rnn.h.map((v, i) => {
              const mag = Math.min(1, Math.abs(v));
              const color =
                i < DOMAIN_IDS.length
                  ? rgbCss(DOMAIN_PALETTES[DOMAIN_IDS[i]].accent, 0.88)
                  : "rgba(184, 206, 218, 0.72)";
              return (
                <div key={i} className="dreaming-rnn-bar-col">
                  <div
                    className="dreaming-rnn-bar"
                    style={{
                      height: `${Math.max(10, Math.round(mag * 100))}%`,
                      backgroundColor: color,
                      opacity: v >= 0 ? 0.95 : 0.34,
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div className="dreaming-prob-list">
            {DOMAIN_IDS.map((id) => {
              const pct = Math.round(state.domainWeights[id] * 100);
              return (
                <div key={id} className="dreaming-prob-row">
                  <span className="dreaming-prob-label">{DOMAIN_PALETTES[id].label}</span>
                  <div className="dreaming-prob-track">
                    <div
                      className="dreaming-prob-fill"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: rgbCss(DOMAIN_PALETTES[id].accent, 0.88),
                      }}
                    />
                  </div>
                  <span className="dreaming-prob-pct">{pct}%</span>
                </div>
              );
            })}
          </div>
          <div className="dreaming-rnn-foot">
            <span>滲み {Math.round(state.bleedEntropy * 100)}%</span>
            <span>保持 {Math.round(state.rnn.lastForgetMean * 100)}%</span>
            <span>忘却 {state.forgottenCount}</span>
          </div>
        </aside>
      )}

      {/* 下部フローティングゾーン：霧に直接浮かぶ明朝ウィスパー ＋ スリムな操作ドック */}
      <div className="dreaming-hud-bottom">
        {state.whisper && (
          <div
            key={`${state.whisper.step}-${state.whisper.text}`}
            className="dreaming-whisper"
            aria-live="polite"
          >
            <div className="dreaming-whisper-text">{state.whisper.text}</div>
            {state.whisper.sub && <div className="dreaming-whisper-sub">{state.whisper.sub}</div>}
          </div>
        )}

        {state.step < 2 && (
          <div className="dreaming-first-hint">
            矢印 / WASD / スワイプで歩く · 振り返ると背後の記憶は静かに書き換わる
          </div>
        )}

        <footer className="dreaming-dock" aria-label="夢の操作">
          <button type="button" className={primaryClass} onClick={doPulse}>
            <span>{primaryLabel}</span>
            <span className="dreaming-kbd">Space</span>
          </button>

          <span className="dreaming-dock-sep" aria-hidden="true" />

          <button
            type="button"
            className={
              adjacent.hasAnchor ? "dreaming-dock-btn dreaming-dock-btn-anchored" : "dreaming-dock-btn"
            }
            onClick={doAnchor}
          >
            <span>{adjacent.hasAnchor ? "しおりを外す" : "しおり"}</span>
            <span className="dreaming-anchor-dots" aria-label={`使用中 ${state.anchors.length}/${MAX_ANCHORS}`}>
              {Array.from({ length: MAX_ANCHORS }, (_, i) => (
                <span
                  key={i}
                  className={
                    i < state.anchors.length
                      ? "dreaming-anchor-dot dreaming-anchor-dot-on"
                      : "dreaming-anchor-dot"
                  }
                />
              ))}
            </span>
            <span className="dreaming-kbd">F</span>
          </button>

          <span className="dreaming-dock-sep" aria-hidden="true" />

          <label className="dreaming-temp-dial">
            <span
              className={
                state.temperature < 0.85
                  ? "dreaming-temp-pole dreaming-temp-pole-active"
                  : "dreaming-temp-pole"
              }
            >
              明晰
            </span>
            <input
              type="range"
              className="dreaming-temp-slider"
              min={MIN_TEMPERATURE}
              max={MAX_TEMPERATURE}
              step={0.05}
              value={state.temperature}
              onChange={(e) => doTempChange(Number(e.target.value))}
              onPointerUp={(e) => e.currentTarget.blur()}
              aria-label="サンプリング温度（低いと明晰、高いと夢が滲み崩れる）"
            />
            <span
              className={
                state.temperature > 1.2
                  ? "dreaming-temp-pole dreaming-temp-pole-active"
                  : "dreaming-temp-pole"
              }
            >
              深夢
            </span>
            <span className="dreaming-temp-val" aria-hidden="true">
              {state.temperature.toFixed(2)}
            </span>
          </label>
        </footer>
      </div>

      {/* 夢の標本帳（フィールドノート風スライドドロワー） */}
      {showArchive && (
        <div
          className="dreaming-drawer-backdrop"
          onClick={() => setShowArchive(false)}
          role="dialog"
          aria-modal="true"
          aria-label="夢の標本帳"
        >
          <div className="dreaming-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="dreaming-drawer-head">
              <div className="dreaming-drawer-title-group">
                <h2>夢の標本帳</h2>
                <span className="dreaming-drawer-sub">
                  忘却の縁で拾い上げた記憶と変質の記録
                </span>
              </div>
              <button
                type="button"
                className="dreaming-ghost-btn"
                onClick={() => setShowArchive(false)}
              >
                閉じる
              </button>
            </div>

            <div className="dreaming-drawer-body">
              <div className="dreaming-summary-strip">
                <div className="dreaming-summary-cell">
                  <span>最深深度</span>
                  <strong>第{maxDepthDisplay}層</strong>
                </div>
                <div className="dreaming-summary-cell">
                  <span>最高変質</span>
                  <strong>
                    {Math.max(state.maxGeneration, record.maxGeneration) > 0
                      ? `第${Math.max(state.maxGeneration, record.maxGeneration)}世代`
                      : "未観測"}
                  </strong>
                </div>
                <div className="dreaming-summary-cell">
                  <span>累計歩数</span>
                  <strong>{record.totalSteps}</strong>
                </div>
                <div className="dreaming-summary-cell">
                  <span>忘却風景</span>
                  <strong>{record.totalForgotten}</strong>
                </div>
              </div>

              <section>
                <p className="dreaming-section-title">
                  原型モチーフ（{discoveredCount} / {DREAM_MOTIFS.length}）
                </p>
                <div className="dreaming-archetypes">
                  {DREAM_MOTIFS.map((m) => {
                    const found = discoveredSet.has(m.id);
                    return (
                      <div
                        key={m.id}
                        className={
                          found
                            ? "dreaming-archetype-chip dreaming-archetype-chip-found"
                            : "dreaming-archetype-chip"
                        }
                      >
                        {found ? m.archetypeLabel : "……"}
                      </div>
                    );
                  })}
                </div>
              </section>

              <section>
                <p className="dreaming-section-title">採集した変質記録</p>
                {state.archive.length === 0 ? (
                  <p className="dreaming-log-sub">
                    まだ記録はありません。光るモチーフに触れるか、近くで共鳴してください。
                  </p>
                ) : (
                  <div className="dreaming-log-list">
                    {state.archive.slice(0, 24).map((entry, idx) => (
                      <div key={`${entry.step}-${entry.name}-${idx}`} className="dreaming-log-item">
                        <div className="dreaming-log-top">
                          <span className="dreaming-log-name">{entry.name}</span>
                          <span className="dreaming-log-meta">
                            {entry.generation >= 2 ? `第${entry.generation}変質` : "原型"} · 第{entry.depth}層
                          </span>
                        </div>
                        <div className="dreaming-log-sub">
                          {entry.archetypeLabel}（{DOMAIN_PALETTES[entry.originDomain].label}
                          {entry.originDomain !== entry.domain
                            ? ` → ${DOMAIN_PALETTES[entry.domain].label}`
                            : ""}
                          ）
                        </div>
                        <div className="dreaming-log-frag">{entry.fragment}</div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <div className="dreaming-drawer-foot">
              <span className="dreaming-log-sub">夢に終わりはありません</span>
              <button type="button" className="dreaming-ghost-btn" onClick={doRedrift}>
                浅い層へ漂い直す
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
