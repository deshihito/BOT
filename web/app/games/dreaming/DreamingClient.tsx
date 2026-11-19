"use client";
// WEB ゲーム「dreaming」のメインクライアント（100svh フルブリード独立シェル .dreaming-shell）。
//
// ボタン・設定・パネル等のあらゆる UI を廃し、100% 全面の夢空間キャンバスと
// 最低限のアナログジョイスティック移動（画面ドラッグ＆キーボード連動）のみで構成。
//
// Transformer 以前の生成モデル（小型 LSTM + 文字レベル n-gram + 2D 条件付きマルコフ場）の
// 隠れ状態 h_t をそのまま 60fps の連続頂点ワープ場・流体リボン・液状クロスモーフ・
// 残像フィードバックバッファ・自律夢遊ティック（driftDreamTick）へ直結する。
// - 壁へ押し当て続けると夢の波紋で道が溶けて開く（自動パルス救済）
// - 歩いた後に静かに佇むと足元の 5×5 が揺れない「記憶の島（しおり）」として定着する
// - 温度 T は深度と時間波動に応じて自然に呼吸する

import { useCallback, useEffect, useRef } from "react";
import { isSfxMuted, setSfxMuted } from "@/lib/sfx";
import {
  DOMAIN_IDS,
  DOMAIN_PALETTES,
  MAX_TEMPERATURE,
  MIN_TEMPERATURE,
  RNN_DIM,
  blendDomainColors,
  rgbCss,
  type DomainId,
  type TileKind,
} from "@/lib/games/dreaming-model";
import {
  ANCHOR_RADIUS,
  DREAMING_RECORD_KEY,
  DREAM_MOTIFS,
  VIEW_RADIUS,
  ambientTemperatureFor,
  chebyshev,
  createDreamGame,
  driftDreamTick,
  findNearestSignal,
  mergeRecordWithSession,
  moveDream,
  parseDreamRecord,
  pulseDream,
  setDreamTemperature,
  toggleAnchor,
  tileKey,
  type DreamDir,
  type DreamRecord,
  type DreamState,
  type DreamTile,
  type MotifId,
} from "@/lib/games/dreaming";
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
  wallRgb: [number, number, number];
  accentRgb: [number, number, number];
  inkRgb: [number, number, number];
};

/** タイル種別がリアルタイムに書き換わるときの液状クロスモーフ演出。 */
type TileMorphAnim = {
  x: number;
  y: number;
  oldKind: TileKind;
  oldFloorRgb: [number, number, number];
  oldWallRgb: [number, number, number];
  oldAccentRgb: [number, number, number];
  oldGlyph: string;
  startMs: number;
  durMs: number;
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
};

/** LSTM の潜在ベクトル場に沿って画面上をウニョウニョ蛇行する流線リボン。 */
type FlowRibbon = {
  pts: Array<{ x: number; y: number }>;
  age: number;
  maxAge: number;
  speed: number;
  phase: number;
  tint: "accent" | "ink";
};

type TrailNode = {
  x: number;
  y: number;
  atMs: number;
};

type Pt = { x: number; y: number };

const JOY_MAX_RADIUS = 36;
const JOY_DEADZONE = 0.18;
const STILL_ANCHOR_DELAY_SEC = 0.85;
const STILL_ANCHOR_TOTAL_SEC = 2.65;
const BLOCKED_DISSOLVE_SEC = 0.5;

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

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 決定的なタイルハッシュ（毎フレームのチラつきを防ぐ座標由来乱数 0..1）。 */
function tileHash(x: number, y: number, salt = 0): number {
  let n =
    Math.imul(x + 374761393, 668265263) ^
    Math.imul(y + 1274126177, 2246822519) ^
    (salt * 1597334677);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/**
 * 共有ワープ頂点（4隅＋4辺中点）から滑らかな曲線四辺形パスを張る。
 * 隣接タイル同士が同一ワープ座標を共有するため、画面全体が亀裂のない1枚の
 * 液状ファブリックのようにウニョウニョうねる。
 */
function traceWarpedQuad(
  ctx: CanvasRenderingContext2D,
  tl: Pt,
  tm: Pt,
  tr: Pt,
  rm: Pt,
  br: Pt,
  bm: Pt,
  bl: Pt,
  lm: Pt,
  expand = 0,
): void {
  const cx = (tl.x + tr.x + br.x + bl.x) * 0.25;
  const cy = (tl.y + tr.y + br.y + bl.y) * 0.25;
  const ex = (p: Pt): Pt => {
    if (expand === 0) return p;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * expand, y: p.y + (dy / len) * expand };
  };
  const pTL = ex(tl);
  const pTM = ex(tm);
  const pTR = ex(tr);
  const pRM = ex(rm);
  const pBR = ex(br);
  const pBM = ex(bm);
  const pBL = ex(bl);
  const pLM = ex(lm);

  ctx.beginPath();
  ctx.moveTo(pTL.x, pTL.y);
  ctx.quadraticCurveTo(pTM.x, pTM.y, pTR.x, pTR.y);
  ctx.quadraticCurveTo(pRM.x, pRM.y, pBR.x, pBR.y);
  ctx.quadraticCurveTo(pBM.x, pBM.y, pBL.x, pBL.y);
  ctx.quadraticCurveTo(pLM.x, pLM.y, pTL.x, pTL.y);
  ctx.closePath();
}

/** 多葉フーリエ変調で有機的にウニョウニョ脈打つ閉曲線ブロブを描く（水面・溶融モーフ用）。 */
function traceOrganicBlob(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  timeSec: number,
  seed: number,
  wobble: number,
  lobes = 10,
): void {
  const pts: Pt[] = [];
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2;
    const wave =
      1 +
      wobble *
        (0.55 * Math.sin(a * 2 + timeSec * 1.9 + seed * 6.28) +
          0.32 * Math.cos(a * 3 - timeSec * 2.4 + seed * 11.3) +
          0.18 * Math.sin(a * 5 + timeSec * 3.1 - seed * 4.7));
    pts.push({
      x: cx + Math.cos(a) * rx * wave,
      y: cy + Math.sin(a) * ry * wave,
    });
  }
  ctx.beginPath();
  const last = pts[pts.length - 1];
  const first = pts[0];
  ctx.moveTo((last.x + first.x) * 0.5, (last.y + first.y) * 0.5);
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i];
    const nxt = pts[(i + 1) % pts.length];
    ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + nxt.x) * 0.5, (cur.y + nxt.y) * 0.5);
  }
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
  const initialStateRef = useRef<DreamState | null>(null);
  if (!initialStateRef.current) {
    initialStateRef.current = createDreamGame(20261119);
  }
  const stateRef = useRef<DreamState>(initialStateRef.current);
  const recordRef = useRef<DreamRecord>(parseDreamRecord(null));

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dockJoyRef = useRef<HTMLDivElement | null>(null);
  const dockKnobRef = useRef<HTMLDivElement | null>(null);
  const floatRingRef = useRef<HTMLDivElement | null>(null);
  const floatKnobRef = useRef<HTMLDivElement | null>(null);

  // ジョイスティック＆キーボードの連続移動状態（React 再描画ゼロで 60fps 駆動）
  const joyRef = useRef<{
    active: boolean;
    pointerId: number | null;
    mode: "dock" | "float";
    originX: number;
    originY: number;
    nx: number;
    ny: number;
    mag: number;
    floatShown: boolean;
  }>({
    active: false,
    pointerId: null,
    mode: "dock",
    originX: 0,
    originY: 0,
    nx: 0,
    ny: 0,
    mag: 0,
    floatShown: false,
  });

  const keysDownRef = useRef<Set<DreamDir>>(new Set());
  const moveCtrlRef = useRef({
    accumX: 0,
    accumY: 0,
    wasMoving: false,
    pushingBlocked: false,
    blockedHoldSec: 0,
    stillSec: 0,
    lastStepMs: 0,
    lastBumpSfxMs: 0,
  });

  // 滑らか補間・連続 LSTM 状態・液状モーフ・流線リボン・忘却ゴースト用のレンダー専用 ref
  const camRef = useRef({
    x: 0,
    y: 0,
    px: 0,
    py: 0,
    facingAngle: 0,
    bumpX: 0,
    bumpY: 0,
    descendFlash: 0,
    pulseWave: 0,
  });
  const smoothHRef = useRef<number[]>(new Array<number>(RNN_DIM).fill(0));
  const smoothWeightsRef = useRef<Record<DomainId, number>>({ ...stateRef.current.domainWeights });
  const ripplesRef = useRef<RippleFx[]>([]);
  const tapRingsRef = useRef<ScreenTapFx[]>([]);
  const particlesRef = useRef<CharParticle[]>([]);
  const tileVisualRef = useRef<Map<string, TileVisualMeta>>(new Map());
  const morphAnimsRef = useRef<Map<string, TileMorphAnim>>(new Map());
  const dissolvingGhostsRef = useRef<DissolvingGhost[]>([]);
  const trailRef = useRef<TrailNode[]>([]);
  const ambientMotesRef = useRef<AmbientMote[]>([]);
  const mistGlyphsRef = useRef<MistGlyph[]>([]);
  const flowRibbonsRef = useRef<FlowRibbon[]>([]);
  const audioUnlockedRef = useRef(false);
  const savedStepsRef = useRef(0);
  const savedForgottenRef = useRef(0);
  const reducedMotionRef = useRef(false);

  // キャンバス霧の中に溶ける詩的テキスト演出（地名変化・呟き・深度ハイライト）
  const mistTextRef = useRef({
    placeName: stateRef.current.placeName,
    placeChangedMs: 0,
    whisperText: stateRef.current.whisper?.text ?? "",
    whisperShownMs: 0,
    metaHighlightUntilMs: 0,
  });

  // タイル集合の差分を監視し、出現・液状クロスモーフ・忘却ゴーストを視覚化する
  const syncTileVisualDiff = useCallback((next: DreamState, resetAll = false) => {
    const now = performance.now();
    const prevMap = tileVisualRef.current;

    if (resetAll) {
      prevMap.clear();
      morphAnimsRef.current.clear();
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
          wallRgb: blendDomainColors(tile.domainBlend, "wall"),
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
          durMs: 1950,
          driftX: Math.cos(angle) * 0.34,
          driftY: -0.5 - tileHash(oldMeta.x, oldMeta.y, 31) * 0.38,
        });
        prevMap.delete(key);
        morphAnimsRef.current.delete(key);
      }
    }
    if (dissolvingGhostsRef.current.length > 84) {
      dissolvingGhostsRef.current = dissolvingGhostsRef.current.slice(-84);
    }

    // 2. 新規生成＆リアルタイム変容（kind の書き換わり）を検出し、1.5 秒の液状モーフを開始
    for (const [key, tile] of next.tiles) {
      const existing = prevMap.get(key);
      const floorRgb = blendDomainColors(tile.domainBlend, "floor");
      const wallRgb = blendDomainColors(tile.domainBlend, "wall");
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
          wallRgb,
          accentRgb,
          inkRgb,
        });
      } else {
        if (existing.kind !== tile.kind) {
          morphAnimsRef.current.set(key, {
            x: tile.x,
            y: tile.y,
            oldKind: existing.kind,
            oldFloorRgb: existing.floorRgb,
            oldWallRgb: existing.wallRgb,
            oldAccentRgb: existing.accentRgb,
            oldGlyph: existing.glyph,
            startMs: now,
            durMs: 1500,
          });
          ripplesRef.current.push({
            wx: tile.x,
            wy: tile.y,
            startMs: now,
            durMs: 920,
            maxRadius: 1.15,
            color: rgbCss(accentRgb, 0.48),
          });
          particlesRef.current.push({
            wx: tile.x,
            wy: tile.y,
            vx: (tileHash(tile.x, tile.y, next.rnn.steps) - 0.5) * 0.42,
            vy: -0.48,
            char: tile.glyph,
            startMs: now,
            durMs: 1450,
            color: rgbCss(inkRgb, 0.72),
            scale: 0.88,
          });
          existing.bornMs = now;
        }
        existing.kind = tile.kind;
        existing.glyph = tile.glyph;
        existing.floorRgb = floorRgb;
        existing.wallRgb = wallRgb;
        existing.accentRgb = accentRgb;
        existing.inkRgb = inkRgb;
      }
    }
  }, []);

  // 永続記録と霧テキスト演出・環境音の同期
  const syncMetaAndPersistence = useCallback((next: DreamState) => {
    const now = performance.now();
    const mt = mistTextRef.current;

    if (next.placeName !== mt.placeName) {
      mt.placeName = next.placeName;
      mt.placeChangedMs = now;
    }
    const nextWhisperText = next.whisper?.text ?? "";
    if (nextWhisperText && nextWhisperText !== mt.whisperText) {
      mt.whisperText = nextWhisperText;
      mt.whisperShownMs = now;
    }

    const evKind = next.lastEvent.kind;
    if (evKind === "collect" || evKind === "reunion" || evKind === "descend") {
      mt.metaHighlightUntilMs = now + 4500;
    }

    const stepDelta = Math.max(0, next.step - savedStepsRef.current);
    const forgotDelta = Math.max(0, next.forgottenCount - savedForgottenRef.current);
    if (
      stepDelta > 0 ||
      forgotDelta > 0 ||
      evKind === "collect" ||
      evKind === "reunion" ||
      evKind === "descend"
    ) {
      savedStepsRef.current = next.step;
      savedForgottenRef.current = next.forgottenCount;
      const merged = mergeRecordWithSession(recordRef.current, next, stepDelta, forgotDelta);
      recordRef.current = merged;
      saveStoredRecord(merged);
    }

    if (audioUnlockedRef.current && !isSfxMuted()) {
      updateDreamAmbience(next.domainWeights, next.temperature, next.depth);
    }
  }, []);

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
      syncMetaAndPersistence(next);

      if (ev.kind === "move") {
        sfxDreamStep(next.dominantDomain, next.temperature);
        trailRef.current.push({ x: next.player.x, y: next.player.y, atMs: now });
        if (trailRef.current.length > 12) {
          trailRef.current = trailRef.current.slice(-12);
        }
      } else if (ev.kind === "blocked") {
        if (now - moveCtrlRef.current.lastBumpSfxMs >= 380) {
          sfxDreamBump();
          moveCtrlRef.current.lastBumpSfxMs = now;
        }
        const dx = Math.sign(ev.x - next.player.x);
        const dy = Math.sign(ev.y - next.player.y);
        camRef.current.bumpX = dx * 0.22;
        camRef.current.bumpY = dy * 0.22;
      } else if (ev.kind === "collect" || ev.kind === "reunion") {
        sfxDreamCollect(ev.generation ?? 1);
        camRef.current.pulseWave = 1;
        ripplesRef.current.push({
          wx: ev.x,
          wy: ev.y,
          startMs: now,
          durMs: ev.kind === "reunion" ? 1250 : 900,
          maxRadius: ev.kind === "reunion" ? 4.2 : 2.8,
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
            durMs: 1700,
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
          durMs: 980,
          maxRadius: ANCHOR_RADIUS + 0.75,
          color: "rgba(216, 178, 106, 0.82)",
        });
      } else if (ev.kind === "pulse") {
        sfxDreamPulse();
        camRef.current.pulseWave = 1;
        ripplesRef.current.push({
          wx: ev.x,
          wy: ev.y,
          startMs: now,
          durMs: 1040,
          maxRadius: 3.6,
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
          durMs: 1400,
          maxRadius: 5.2,
          color: "rgba(204, 224, 236, 0.82)",
        });
      }
    },
    [syncMetaAndPersistence, syncTileVisualDiff],
  );

  const unlockAudio = useCallback(() => {
    if (!audioUnlockedRef.current) {
      audioUnlockedRef.current = true;
      if (!isSfxMuted()) {
        const cur = stateRef.current;
        updateDreamAmbience(cur.domainWeights, cur.temperature, cur.depth);
      }
    }
  }, []);

  const applyTransition = useCallback(
    (fn: (s: DreamState) => DreamState): DreamState => {
      unlockAudio();
      const next = fn(stateRef.current);
      stateRef.current = next;
      handleEventEffects(next);
      return next;
    },
    [handleEventEffects, unlockAudio],
  );

  // クライアント起動後に実シード生成＋保存済み記録を読み込む
  useEffect(() => {
    const stored = loadStoredRecord();
    recordRef.current = stored;
    const fresh = createDreamGame((Date.now() ^ 0x5a17d3) % 2147483647);
    const hydrated: DreamState = {
      ...fresh,
      discoveredMotifs: stored.discoveredMotifs,
      archive: stored.recentArchive,
      maxGeneration: stored.maxGeneration,
    };
    stateRef.current = hydrated;
    smoothHRef.current = [...hydrated.rnn.h];
    smoothWeightsRef.current = { ...hydrated.domainWeights };
    const now = performance.now();
    mistTextRef.current = {
      placeName: hydrated.placeName,
      placeChangedMs: now,
      whisperText: hydrated.whisper?.text ?? "",
      whisperShownMs: now,
      metaHighlightUntilMs: now + 4500,
    };
    camRef.current = {
      x: 0,
      y: 0,
      px: 0,
      py: 0,
      facingAngle: 0,
      bumpX: 0,
      bumpY: 0,
      descendFlash: 0.72,
      pulseWave: 0,
    };
    syncTileVisualDiff(hydrated, true);
    reducedMotionRef.current =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    return () => {
      stopDreamAmbience();
    };
  }, [syncTileVisualDiff]);

  // リアルタイム自律夢遊ループ：立ち止まっていても LSTM・温度呼吸・周辺地形・語彙が連続変容し続ける
  useEffect(() => {
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const scheduleNext = () => {
      if (cancelled) return;
      const curTemp = stateRef.current.temperature;
      const intervalMs = Math.round(
        Math.max(920, Math.min(2250, 2150 - (curTemp - MIN_TEMPERATURE) * 880)),
      );
      timerId = setTimeout(() => {
        if (cancelled) return;
        if (!reducedMotionRef.current && (typeof document === "undefined" || !document.hidden)) {
          const cur = stateRef.current;
          const breathedTemp = ambientTemperatureFor(cur.depth, cur.rnn.steps);
          const tempered =
            Math.abs(breathedTemp - cur.temperature) >= 0.02
              ? setDreamTemperature(cur, breathedTemp)
              : cur;
          const next = driftDreamTick(tempered);
          stateRef.current = next;
          syncTileVisualDiff(next, false);
          syncMetaAndPersistence(next);
        }
        scheduleNext();
      }, intervalMs);
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (timerId !== null) clearTimeout(timerId);
    };
  }, [syncMetaAndPersistence, syncTileVisualDiff]);

  // キーボード操作（UI ゼロでも矢印・WASD 押しっぱなしでジョイスティックと連動して連続歩行できる）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const dir = KEY_TO_DIR[e.key];
      if (dir) {
        e.preventDefault();
        unlockAudio();
        keysDownRef.current.add(dir);
        return;
      }
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        applyTransition((s) => pulseDream(s));
        return;
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        applyTransition((s) => toggleAnchor(s));
        return;
      }
      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        const nextMuted = !isSfxMuted();
        setSfxMuted(nextMuted);
        if (nextMuted) {
          stopDreamAmbience();
        } else {
          unlockAudio();
          const cur = stateRef.current;
          updateDreamAmbience(cur.domainWeights, cur.temperature, cur.depth);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const dir = KEY_TO_DIR[e.key];
      if (dir) keysDownRef.current.delete(dir);
    };
    const onBlur = () => {
      keysDownRef.current.clear();
      joyRef.current.active = false;
      joyRef.current.pointerId = null;
      joyRef.current.nx = 0;
      joyRef.current.ny = 0;
      joyRef.current.mag = 0;
      joyRef.current.floatShown = false;
      stageRef.current?.setAttribute("data-dragging", "false");
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [applyTransition, unlockAudio]);

  // ジョイスティック＆全面ドラッグ操作（単一ポインターハンドラで定位置・フローティング両対応）
  const updateJoyFromPoint = useCallback((clientX: number, clientY: number) => {
    const joy = joyRef.current;
    const dx = clientX - joy.originX;
    const dy = clientY - joy.originY;
    const dist = Math.hypot(dx, dy);
    if (joy.mode === "float" && !joy.floatShown && dist >= 5) {
      joy.floatShown = true;
    }
    const clamped = Math.min(JOY_MAX_RADIUS, dist);
    if (dist > 0.001) {
      joy.nx = (dx / dist) * (clamped / JOY_MAX_RADIUS);
      joy.ny = (dy / dist) * (clamped / JOY_MAX_RADIUS);
      joy.mag = clamped / JOY_MAX_RADIUS;
    } else {
      joy.nx = 0;
      joy.ny = 0;
      joy.mag = 0;
    }
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (joyRef.current.active) return;

      unlockAudio();
      e.currentTarget.setPointerCapture(e.pointerId);
      stageRef.current?.setAttribute("data-dragging", "true");

      const dockEl = dockJoyRef.current;
      const dockRect = dockEl?.getBoundingClientRect();
      let isOnDock = false;
      let dockCx = 0;
      let dockCy = 0;
      if (dockRect) {
        dockCx = dockRect.left + dockRect.width * 0.5;
        dockCy = dockRect.top + dockRect.height * 0.5;
        isOnDock = Math.hypot(e.clientX - dockCx, e.clientY - dockCy) <= dockRect.width * 0.62;
      }

      const joy = joyRef.current;
      joy.active = true;
      joy.pointerId = e.pointerId;
      if (isOnDock) {
        joy.mode = "dock";
        joy.originX = dockCx;
        joy.originY = dockCy;
        joy.floatShown = false;
        updateJoyFromPoint(e.clientX, e.clientY);
      } else {
        joy.mode = "float";
        joy.originX = e.clientX;
        joy.originY = e.clientY;
        joy.nx = 0;
        joy.ny = 0;
        joy.mag = 0;
        joy.floatShown = false;
        const stageRect = stageRef.current?.getBoundingClientRect();
        if (stageRect) {
          tapRingsRef.current.push({
            sx: e.clientX - stageRect.left,
            sy: e.clientY - stageRect.top,
            startMs: performance.now(),
            durMs: 560,
          });
        }
      }
    },
    [unlockAudio, updateJoyFromPoint],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!joyRef.current.active || joyRef.current.pointerId !== e.pointerId) return;
      updateJoyFromPoint(e.clientX, e.clientY);
    },
    [updateJoyFromPoint],
  );

  const handlePointerEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const joy = joyRef.current;
    if (!joy.active || joy.pointerId !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // すでに解放済みなら無視
    }
    joy.active = false;
    joy.pointerId = null;
    joy.nx = 0;
    joy.ny = 0;
    joy.mag = 0;
    joy.floatShown = false;
    stageRef.current?.setAttribute("data-dragging", "false");
  }, []);

  // Canvas 2D リアルタイム神経流体夢レンダラー ＋ 連続ジョイスティック歩行ループ（60fps）
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 液状残像フィードバック用の軽量 0.5x オフスクリーンキャンバス（2枚スワップ）
    const trailCanvas = document.createElement("canvas");
    const trailSwap = document.createElement("canvas");
    const tCtx = trailCanvas.getContext("2d");
    const sCtx = trailSwap.getContext("2d");

    const grainPattern = createFilmGrainPattern(ctx);
    let rafId = 0;
    let lastFrameMs = performance.now();
    let width = 1;
    let height = 1;
    let dpr = 1;
    let tw = 1;
    let th = 1;

    const spawnRibbon = (w: number, h: number, idx: number): FlowRibbon => {
      const sx = tileHash(idx, Math.floor(performance.now() * 0.01), 97) * w;
      const sy = tileHash(idx, Math.floor(performance.now() * 0.01) + 7, 131) * h;
      return {
        pts: [{ x: sx, y: sy }],
        age: 0,
        maxAge: 70 + Math.round(tileHash(idx, 3, 59) * 90),
        speed: 0.75 + tileHash(idx, 5, 83) * 1.15,
        phase: tileHash(idx, 9, 41) * Math.PI * 2,
        tint: idx % 3 === 0 ? "accent" : "ink",
      };
    };

    const initAmbientField = (w: number, h: number) => {
      ambientMotesRef.current = Array.from({ length: 42 }, (_, i) => ({
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
      }));
      flowRibbonsRef.current = Array.from({ length: 40 }, (_, i) => spawnRibbon(w, h, i));
    };

    const resize = () => {
      const rect = stage.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);

      tw = Math.max(1, Math.floor(width * 0.5));
      th = Math.max(1, Math.floor(height * 0.5));
      trailCanvas.width = tw;
      trailCanvas.height = th;
      trailSwap.width = tw;
      trailSwap.height = th;

      if (ambientMotesRef.current.length === 0) {
        initAmbientField(width, height);
      }
    };
    resize();

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(stage);

    // 1 歩移動の試行（斜め入力での壁スライド＆押し当て自動溶解付き）
    const attemptStep = (primary: DreamDir, secondary: DreamDir | null, now: number) => {
      const mc = moveCtrlRef.current;
      let res = applyTransition((st) => moveDream(st, primary));
      if (res.lastEvent.kind === "blocked" && secondary) {
        const slideRes = applyTransition((st) => moveDream(st, secondary));
        if (slideRes.lastEvent.kind !== "blocked") {
          res = slideRes;
        }
      }
      if (res.lastEvent.kind === "blocked") {
        mc.pushingBlocked = true;
      } else {
        mc.pushingBlocked = false;
        mc.blockedHoldSec = 0;
        mc.lastStepMs = now;
      }
    };

    const render = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameMs) / 1000));
      lastFrameMs = now;

      // 0. ジョイスティック＆キーボード入力の合成・DOM 反映・連続歩行ステップ
      const joy = joyRef.current;
      let ix = 0;
      let iy = 0;
      if (joy.active && joy.mag >= JOY_DEADZONE) {
        ix = joy.nx;
        iy = joy.ny;
      } else if (keysDownRef.current.size > 0) {
        if (keysDownRef.current.has("left")) ix -= 1;
        if (keysDownRef.current.has("right")) ix += 1;
        if (keysDownRef.current.has("up")) iy -= 1;
        if (keysDownRef.current.has("down")) iy += 1;
        const kLen = Math.hypot(ix, iy);
        if (kLen > 0) {
          ix /= kLen;
          iy /= kLen;
        }
      }
      const inMag = Math.hypot(ix, iy);
      const isMoving = inMag >= JOY_DEADZONE;

      // ジョイスティック DOM の 60fps 同期
      const stageRect = stage.getBoundingClientRect();
      const dockEl = dockJoyRef.current;
      const dockKnob = dockKnobRef.current;
      const floatEl = floatRingRef.current;
      const floatKnob = floatKnobRef.current;

      if (joy.active && joy.mode === "float" && joy.floatShown) {
        if (floatEl) {
          floatEl.style.left = `${joy.originX - stageRect.left}px`;
          floatEl.style.top = `${joy.originY - stageRect.top}px`;
          floatEl.setAttribute("data-visible", "true");
        }
        if (floatKnob) {
          floatKnob.setAttribute("data-spring", "false");
          floatKnob.style.transform = `translate3d(${(joy.nx * JOY_MAX_RADIUS).toFixed(1)}px, ${(joy.ny * JOY_MAX_RADIUS).toFixed(1)}px, 0)`;
        }
        if (dockEl) {
          dockEl.setAttribute("data-hidden", "true");
          dockEl.setAttribute("data-active", "false");
        }
      } else {
        if (floatEl) floatEl.setAttribute("data-visible", "false");
        const draggingDock = joy.active && joy.mode === "dock";
        if (dockEl) {
          dockEl.setAttribute("data-hidden", "false");
          dockEl.setAttribute("data-active", draggingDock || isMoving ? "true" : "false");
        }
        if (dockKnob) {
          dockKnob.setAttribute("data-spring", draggingDock ? "false" : "true");
          const visX = draggingDock ? joy.nx : ix * 0.85;
          const visY = draggingDock ? joy.ny : iy * 0.85;
          dockKnob.style.transform = `translate3d(${(visX * JOY_MAX_RADIUS).toFixed(1)}px, ${(visY * JOY_MAX_RADIUS).toFixed(1)}px, 0)`;
        }
      }

      // 連続移動アキュムレータ・壁押し当て溶解・佇み自動しおり
      const mc = moveCtrlRef.current;
      if (isMoving) {
        mc.stillSec = 0;
        const normMag = Math.min(1, (inMag - JOY_DEADZONE) / (1 - JOY_DEADZONE));
        const stepsPerSec = 1.9 + normMag * 3.4;

        const pickDirs = (vx: number, vy: number): [DreamDir, DreamDir | null] => {
          const horiz: DreamDir = vx >= 0 ? "right" : "left";
          const vert: DreamDir = vy >= 0 ? "down" : "up";
          if (Math.abs(vx) >= Math.abs(vy)) {
            return [horiz, Math.abs(vy) >= 0.35 ? vert : null];
          }
          return [vert, Math.abs(vx) >= 0.35 ? horiz : null];
        };

        if (!mc.wasMoving && now - mc.lastStepMs > 120) {
          // 倒し始めの 1 歩は即座に反応
          const [pri, sec] = pickDirs(ix, iy);
          attemptStep(pri, sec, now);
          mc.accumX = 0;
          mc.accumY = 0;
        } else {
          mc.accumX += ix * stepsPerSec * dt;
          mc.accumY += iy * stepsPerSec * dt;
          if (Math.abs(mc.accumX) >= 1 || Math.abs(mc.accumY) >= 1) {
            if (Math.abs(mc.accumX) >= Math.abs(mc.accumY)) {
              const pri: DreamDir = mc.accumX > 0 ? "right" : "left";
              const sec: DreamDir | null = Math.abs(iy) >= 0.35 ? (iy > 0 ? "down" : "up") : null;
              mc.accumX -= Math.sign(mc.accumX);
              attemptStep(pri, sec, now);
            } else {
              const pri: DreamDir = mc.accumY > 0 ? "down" : "up";
              const sec: DreamDir | null = Math.abs(ix) >= 0.35 ? (ix > 0 ? "right" : "left") : null;
              mc.accumY -= Math.sign(mc.accumY);
              attemptStep(pri, sec, now);
            }
          }
        }

        // 壁に押し当て続けると夢の波紋で道が溶け開く（詰みゼロ＋ボタン不要）
        if (mc.pushingBlocked) {
          mc.blockedHoldSec += dt;
          if (mc.blockedHoldSec >= BLOCKED_DISSOLVE_SEC) {
            mc.blockedHoldSec = 0;
            mc.pushingBlocked = false;
            applyTransition((st) => pulseDream(st));
          }
        }
        mc.wasMoving = true;
      } else {
        mc.accumX = 0;
        mc.accumY = 0;
        mc.wasMoving = false;
        mc.pushingBlocked = false;
        mc.blockedHoldSec = 0;

        // 歩いた後に同じ場所で静かに佇むと、足元の記憶が「記憶の島（しおり）」として定着する
        const cur = stateRef.current;
        const alreadyAnchored = cur.anchors.some(
          (a) => chebyshev(a.x, a.y, cur.player.x, cur.player.y) <= 1,
        );
        if (cur.step > 0 && !alreadyAnchored && !document.hidden) {
          mc.stillSec += dt;
          if (mc.stillSec >= STILL_ANCHOR_TOTAL_SEC) {
            mc.stillSec = 0;
            applyTransition((st) => toggleAnchor(st));
          }
        } else {
          mc.stillSec = 0;
        }
      }

      const s = stateRef.current;
      const timeSec = now / 1000;
      const cam = camRef.current;
      const reduced = reducedMotionRef.current;

      // 滑らかなカメラ・視線角・LSTM 隠れ状態・領域重み補間
      const lerp = reduced ? 1 : 0.14;
      cam.px += (s.player.x - cam.px) * lerp;
      cam.py += (s.player.y - cam.py) * lerp;
      cam.x += (s.player.x - cam.x) * (lerp * 0.65);
      cam.y += (s.player.y - cam.y) * (lerp * 0.65);
      cam.bumpX *= 0.76;
      cam.bumpY *= 0.76;
      cam.descendFlash = Math.max(0, cam.descendFlash - 0.02);
      cam.pulseWave = Math.max(0, cam.pulseWave - 0.025);

      const hLerp = reduced ? 1 : 0.055;
      const sh = smoothHRef.current;
      for (let i = 0; i < RNN_DIM; i++) {
        sh[i] += ((s.rnn.h[i] ?? 0) - sh[i]) * hLerp;
      }
      const sw = smoothWeightsRef.current;
      for (const d of DOMAIN_IDS) {
        sw[d] += ((s.domainWeights[d] ?? 0) - sw[d]) * hLerp;
      }

      // ジョイスティックを傾けている間は光錐も滑らかにアナログ角へ追従
      const targetAngle = isMoving ? Math.atan2(iy, ix) : FACING_ANGLE[s.player.facing];
      let angleDiff = targetAngle - cam.facingAngle;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      cam.facingAngle += angleDiff * (reduced ? 1 : 0.18);

      ctx.save();
      ctx.scale(dpr, dpr);

      const fogRgb = blendDomainColors(sw, "fog");
      const accentRgb = blendDomainColors(sw, "accent");
      const inkRgb = blendDomainColors(sw, "ink");

      const tempNorm = Math.max(
        0,
        Math.min(1, (s.temperature - MIN_TEMPERATURE) / (MAX_TEMPERATURE - MIN_TEMPERATURE)),
      );

      // 背景：中心に微かな余韻を帯びた深い夢霧グラデーション
      const bgGrad = ctx.createRadialGradient(
        width * 0.5 + Math.sin(timeSec * 0.35) * 24,
        height * 0.48 + Math.cos(timeSec * 0.28) * 18,
        Math.min(width, height) * 0.08,
        width * 0.5,
        height * 0.5,
        Math.max(width, height) * 0.78,
      );
      bgGrad.addColorStop(
        0,
        rgbCss(
          [
            Math.min(255, fogRgb[0] + 12),
            Math.min(255, fogRgb[1] + 14),
            Math.min(255, fogRgb[2] + 16),
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

      // 視界内の裂け目位置を集める（周囲の空間頂点を渦状に歪ませるため）
      const rifts: Array<{ x: number; y: number }> = [];
      for (const tile of s.tiles.values()) {
        if (tile.kind === "rift") rifts.push({ x: tile.x, y: tile.y });
      }

      // 8 次元 LSTM 隠れ状態 h_t × 温度 T に駆動される連続 2D 流体ワープ場
      const tSlow = timeSec * (0.9 + tempNorm * 0.85);
      const tFast = timeSec * (1.75 + tempNorm * 1.35);
      const baseWarpAmp = reduced
        ? 0
        : tileSz * (0.14 + tempNorm * 0.27 + s.bleedEntropy * 0.14 + cam.pulseWave * 0.08);

      const warpCache = new Map<string, Pt>();
      const warpWorldToScreen = (wx: number, wy: number): Pt => {
        const gx = wx * 2;
        const gy = wy * 2;
        const cacheKey = Number.isInteger(gx) && Number.isInteger(gy) ? `${gx},${gy}` : null;
        if (cacheKey) {
          const cached = warpCache.get(cacheKey);
          if (cached) return cached;
        }

        let sx = centerX + (wx - cam.x) * tileSz;
        let sy = centerY + (wy - cam.y) * tileSz;

        if (baseWarpAmp > 0.01) {
          // 1. しおり（Anchor）の安定化井戸：保護域（5×5）全体ではワープが 7% まで静まる
          let anchorDamp = 1;
          for (const a of s.anchors) {
            const ad = Math.max(Math.abs(wx - a.x), Math.abs(wy - a.y));
            const localDamp = 0.07 + 0.93 * smoothstep(ANCHOR_RADIUS + 0.35, ANCHOR_RADIUS + 1.65, ad);
            if (localDamp < anchorDamp) anchorDamp = localDamp;
          }

          // 2. プレイヤー足元は視認性のため少しだけ落ち着かせつつ周辺へ大きくうねらせる
          const pd = Math.hypot(wx - cam.px, wy - cam.py);
          const radialBoost = 0.42 + 0.88 * smoothstep(0.6, 4.8, pd);

          // 3. 3オクターブの潜在空間カール波動（sh[0..7] が直接位相・うねりを決める）
          const w1x = Math.sin(wy * 0.62 + tSlow + sh[0] * 2.6) * Math.cos(wx * 0.46 - tSlow * 0.72 + sh[1] * 2.2);
          const w1y = Math.cos(wx * 0.62 - tSlow * 0.88 + sh[2] * 2.6) * Math.sin(wy * 0.48 + tSlow * 0.68 + sh[3] * 2.2);
          const w2x = Math.sin((wx + wy) * 1.15 - tFast + sh[4] * 3.1) * 0.5;
          const w2y = Math.cos((wx - wy) * 1.15 + tFast * 1.08 + sh[5] * 3.1) * 0.5;
          const w3x = Math.sin(wy * 1.95 + wx * 0.75 + tFast * 1.3 + sh[6] * 2.8) * 0.25;
          const w3y = Math.cos(wx * 1.85 - wy * 0.85 - tFast * 1.2 + sh[7] * 2.8) * 0.25;

          const amp = baseWarpAmp * anchorDamp * radialBoost;
          sx += (w1x + w2x + w3x) * amp;
          sy += (w1y + w2y + w3y) * amp;

          // 4. 裂け目（rift）の重力渦ワープ：周囲の空間をねじり吸い込む
          for (const rf of rifts) {
            const rdx = wx - rf.x;
            const rdy = wy - rf.y;
            const rd = Math.hypot(rdx, rdy);
            if (rd > 0.08 && rd < 3.1) {
              const pull = Math.pow(1 - rd / 3.1, 2) * tileSz * 0.48 * anchorDamp;
              const ang = Math.atan2(rdy, rdx);
              const swirlAng = ang + 1.15;
              sx += (Math.cos(swirlAng) * 0.78 - Math.cos(ang) * 0.35) * pull;
              sy += (Math.sin(swirlAng) * 0.78 - Math.sin(ang) * 0.35) * pull;
            }
          }
        }

        const out = { x: sx, y: sy };
        if (cacheKey) warpCache.set(cacheKey, out);
        return out;
      };

      const sampleFlowVelocity = (sx: number, sy: number): Pt => {
        const wx = cam.x + (sx - centerX) / tileSz;
        const wy = cam.y + (sy - centerY) / tileSz;
        const ang =
          Math.sin(wx * 0.55 + tSlow * 0.9 + sh[0] * 2.8) * 2.1 +
          Math.cos(wy * 0.58 - tSlow * 0.8 + sh[2] * 2.8) * 2.1 +
          Math.sin((wx - wy) * 0.85 + tFast * 0.5 + sh[4] * 3.0) * 1.3;
        let vx = Math.cos(ang);
        let vy = Math.sin(ang);
        for (const rf of rifts) {
          const dx = rf.x - wx;
          const dy = rf.y - wy;
          const d = Math.hypot(dx, dy);
          if (d > 0.1 && d < 3.8) {
            const w = Math.pow(1 - d / 3.8, 1.5) * 2.2;
            vx += ((dx - dy * 0.9) / d) * w;
            vy += ((dy + dx * 0.9) / d) * w;
          }
        }
        return { x: vx, y: vy };
      };

      const ghostShift = reduced ? 0 : Math.max(0.8, (s.temperature - 0.65) * 4.8 + s.bleedEntropy * 2.6);

      // オフスクリーン残像フィードバックバッファの更新（毎フレーム微妙に流しながら薄める）
      if (tCtx && sCtx && !reduced) {
        sCtx.clearRect(0, 0, tw, th);
        sCtx.globalCompositeOperation = "source-over";
        sCtx.globalAlpha = 0.84 + tempNorm * 0.085;
        sCtx.imageSmoothingEnabled = true;
        const driftAngle = timeSec * 0.45 + sh[0] * 2.2;
        const ox = Math.cos(driftAngle) * (0.45 + tempNorm * 0.95);
        const oy = Math.sin(driftAngle) * (0.45 + tempNorm * 0.95);
        const zoom = 1.003 + tempNorm * 0.004;
        const zw = tw * zoom;
        const zh = th * zoom;
        sCtx.drawImage(trailCanvas, (tw - zw) * 0.5 + ox, (th - zh) * 0.5 + oy, zw, zh);

        tCtx.clearRect(0, 0, tw, th);
        tCtx.globalAlpha = 1;
        tCtx.drawImage(trailSwap, 0, 0);
      }

      // 1. 忘却ゴースト層（evict されたタイルが有機ブロブと文字へ溶けて昇る）
      dissolvingGhostsRef.current = dissolvingGhostsRef.current.filter((g) => {
        const t = (now - g.startMs) / g.durMs;
        if (t >= 1) return false;
        const pos = warpWorldToScreen(g.x + g.driftX * t, g.y + g.driftY * t);
        const a = Math.pow(1 - t, 1.45) * 0.52;
        const rad = tileSz * (0.56 + t * 0.52);

        ctx.fillStyle = rgbCss(g.floorRgb, a * 0.72);
        traceOrganicBlob(ctx, pos.x, pos.y, rad * 0.8, rad * 0.72, timeSec, tileHash(g.x, g.y, 11), 0.24, 9);
        ctx.fill();

        ctx.font = `400 ${Math.round(tileSz * (0.34 + t * 0.16))}px "Shippori Mincho", "Hiragino Mincho ProN", serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = rgbCss(g.inkRgb, a * 1.3);
        ctx.fillText(g.glyph, pos.x, pos.y - t * 18);

        if (tCtx && !reduced) {
          tCtx.fillStyle = rgbCss(g.inkRgb, a * 0.35);
          tCtx.beginPath();
          tCtx.arc(pos.x * 0.5, pos.y * 0.5, rad * 0.22, 0, Math.PI * 2);
          tCtx.fill();
        }
        return true;
      });

      // 2. 記憶されているタイル群を描画（共有頂点ワープ・曲線メッシュ・有機水辺・液状クロスモーフ）
      const lightSources: Array<{
        tile: DreamTile;
        c: Pt;
        alpha: number;
      }> = [];

      for (const tile of s.tiles.values()) {
        const c = warpWorldToScreen(tile.x, tile.y);
        if (
          c.x + tileSz * 1.5 < -tileSz ||
          c.x - tileSz * 1.5 > width + tileSz ||
          c.y + tileSz * 1.5 < -tileSz ||
          c.y - tileSz * 1.5 > height + tileSz
        ) {
          continue;
        }

        const key = tileKey(tile.x, tile.y);
        const meta = tileVisualRef.current.get(key);
        const materialize = meta && !reduced ? easeOutCubic((now - meta.bornMs) / 620) : 1;
        const distFromPlayer = Math.hypot(tile.x - cam.px, tile.y - cam.py);
        const visionFade = Math.max(0, Math.min(1, 1 - (distFromPlayer - (VIEW_RADIUS - 2.0)) / 2.8));
        const alpha = Math.max(0, Math.min(1, tile.memory * visionFade * materialize));
        if (alpha <= 0.025) continue;

        const morph = morphAnimsRef.current.get(key);
        let morphT = 1;
        if (morph) {
          morphT = (now - morph.startMs) / morph.durMs;
          if (morphT >= 1) {
            morphAnimsRef.current.delete(key);
            morphT = 1;
          }
        }

        const floorRgb = blendDomainColors(tile.domainBlend, "floor");
        const wallRgb = blendDomainColors(tile.domainBlend, "wall");
        const accentRgbT = blendDomainColors(tile.domainBlend, "accent");
        const inkRgbT = blendDomainColors(tile.domainBlend, "ink");

        const tl = warpWorldToScreen(tile.x - 0.5, tile.y - 0.5);
        const tm = warpWorldToScreen(tile.x, tile.y - 0.5);
        const tr = warpWorldToScreen(tile.x + 0.5, tile.y - 0.5);
        const rm = warpWorldToScreen(tile.x + 0.5, tile.y);
        const br = warpWorldToScreen(tile.x + 0.5, tile.y + 0.5);
        const bm = warpWorldToScreen(tile.x, tile.y + 0.5);
        const bl = warpWorldToScreen(tile.x - 0.5, tile.y + 0.5);
        const lm = warpWorldToScreen(tile.x - 0.5, tile.y);

        // 2a. シームレス曲面床ベース
        ctx.fillStyle = rgbCss(floorRgb, alpha);
        traceWarpedQuad(ctx, tl, tm, tr, rm, br, bm, bl, lm, 1.35);
        ctx.fill();

        const seed = tileHash(tile.x, tile.y, 7);

        // 領域境界の柔らかい水彩滲みウォッシュ
        const eastNb = s.tiles.get(tileKey(tile.x + 1, tile.y));
        const southNb = s.tiles.get(tileKey(tile.x, tile.y + 1));
        if (
          tile.bleedShock > 0.14 ||
          (eastNb && eastNb.domain !== tile.domain) ||
          (southNb && southNb.domain !== tile.domain)
        ) {
          const bleed = ctx.createRadialGradient(c.x, c.y, tileSz * 0.06, c.x, c.y, tileSz * 1.02);
          bleed.addColorStop(0, rgbCss(accentRgbT, alpha * (0.11 + tile.bleedShock * 0.18)));
          bleed.addColorStop(1, rgbCss(accentRgbT, 0));
          ctx.fillStyle = bleed;
          ctx.beginPath();
          ctx.arc(c.x, c.y, tileSz * 1.02, 0, Math.PI * 2);
          ctx.fill();
        }

        // 2b. タイル種別ごとの有機ディテール
        if (tile.kind === "water") {
          const deep: [number, number, number] = [
            Math.max(8, Math.round(wallRgb[0] * 0.58)),
            Math.max(20, Math.round(wallRgb[1] * 0.94 + 14)),
            Math.max(36, Math.round(wallRgb[2] * 1.2 + 24)),
          ];
          const wN = s.tiles.get(tileKey(tile.x, tile.y - 1))?.kind === "water";
          const wS = s.tiles.get(tileKey(tile.x, tile.y + 1))?.kind === "water";
          const wE = s.tiles.get(tileKey(tile.x + 1, tile.y))?.kind === "water";
          const wW = s.tiles.get(tileKey(tile.x - 1, tile.y))?.kind === "water";
          const rx = tileSz * (wE || wW ? 0.64 : 0.48);
          const ry = tileSz * (wN || wS ? 0.64 : 0.48);

          ctx.fillStyle = rgbCss(deep, alpha * 0.94);
          traceOrganicBlob(ctx, c.x, c.y, rx, ry, timeSec, seed, 0.14 + tempNorm * 0.1, 10);
          ctx.fill();

          const wave = Math.sin(timeSec * 1.65 + tile.x * 0.9 + tile.y * 0.7);
          ctx.strokeStyle = rgbCss(inkRgbT, alpha * (0.18 + Math.abs(wave) * 0.16));
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.moveTo(c.x - tileSz * 0.28, c.y - tileSz * 0.1 + wave * 2.8);
          ctx.quadraticCurveTo(c.x, c.y - tileSz * 0.18 - wave * 2.2, c.x + tileSz * 0.26, c.y - tileSz * 0.08 + wave * 2.0);
          ctx.moveTo(c.x - tileSz * 0.16, c.y + tileSz * 0.18 - wave * 2.2);
          ctx.quadraticCurveTo(c.x + tileSz * 0.1, c.y + tileSz * 0.12 + wave * 2.2, c.x + tileSz * 0.3, c.y + tileSz * 0.2 - wave * 1.6);
          ctx.stroke();
        } else if (tile.kind === "floor" || tile.kind === "lamp") {
          if (tile.domain === "school") {
            ctx.strokeStyle = rgbCss(wallRgb, alpha * 0.17);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(lm.x, lm.y);
            ctx.quadraticCurveTo(c.x, c.y, rm.x, rm.y);
            ctx.stroke();
          } else if (tile.domain === "station" && (tile.x + tile.y) % 4 === 0) {
            ctx.strokeStyle = rgbCss(accentRgbT, alpha * 0.18);
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(bl.x, bl.y);
            ctx.quadraticCurveTo(bm.x, bm.y, br.x, br.y);
            ctx.stroke();
          } else if (tile.domain === "arcade" && seed > 0.62) {
            ctx.fillStyle = rgbCss(accentRgbT, alpha * 0.14);
            traceOrganicBlob(ctx, c.x, c.y, tileSz * 0.34, tileSz * 0.2, timeSec * 1.1, seed, 0.16, 8);
            ctx.fill();
          } else if (tile.domain === "meadow" && seed > 0.38) {
            const sway = Math.sin(timeSec * 1.7 + tile.x * 0.7 + tile.y * 0.4) * 4.2;
            ctx.strokeStyle = rgbCss(accentRgbT, alpha * 0.22);
            ctx.lineWidth = 1.05;
            ctx.beginPath();
            ctx.moveTo(c.x - tileSz * 0.16, c.y + tileSz * 0.22);
            ctx.quadraticCurveTo(c.x - tileSz * 0.12 + sway * 0.5, c.y, c.x - tileSz * 0.08 + sway, c.y - tileSz * 0.15);
            ctx.moveTo(c.x + tileSz * 0.12, c.y + tileSz * 0.25);
            ctx.quadraticCurveTo(c.x + tileSz * 0.15 + sway * 0.5, c.y + tileSz * 0.08, c.x + tileSz * 0.2 + sway, c.y - tileSz * 0.08);
            ctx.stroke();
          }
        } else if (tile.kind === "wall") {
          ctx.fillStyle = rgbCss(wallRgb, alpha * 0.96);
          traceWarpedQuad(ctx, tl, tm, tr, rm, br, bm, bl, lm, 0.8);
          ctx.fill();
          ctx.strokeStyle = rgbCss(inkRgbT, alpha * 0.14);
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(tl.x, tl.y);
          ctx.quadraticCurveTo(tm.x, tm.y, tr.x, tr.y);
          ctx.stroke();
        } else if (tile.kind === "shelf") {
          ctx.fillStyle = rgbCss(wallRgb, alpha * 0.96);
          traceWarpedQuad(ctx, tl, tm, tr, rm, br, bm, bl, lm, -1.8);
          ctx.fill();
          for (let i = 0; i < 4; i++) {
            const f = (i + 0.6) / 4.2;
            const topX = tl.x + (tr.x - tl.x) * f;
            const topY = tl.y + (tr.y - tl.y) * f;
            const botX = bl.x + (br.x - bl.x) * f;
            const botY = bl.y + (br.y - bl.y) * f;
            const hFrac = 0.22 + tileHash(tile.x, tile.y, 10 + i) * 0.24;
            ctx.strokeStyle = i % 2 === 0 ? rgbCss(accentRgbT, alpha * 0.36) : rgbCss(inkRgbT, alpha * 0.22);
            ctx.lineWidth = 1.9;
            ctx.beginPath();
            ctx.moveTo(botX + (topX - botX) * 0.14, botY + (topY - botY) * 0.14);
            ctx.lineTo(botX + (topX - botX) * (1 - hFrac), botY + (topY - botY) * (1 - hFrac));
            ctx.stroke();
          }
        } else if (tile.kind === "window") {
          ctx.fillStyle = rgbCss(wallRgb, alpha * 0.96);
          traceWarpedQuad(ctx, tl, tm, tr, rm, br, bm, bl, lm, 0.6);
          ctx.fill();

          const winGrad = ctx.createLinearGradient(tl.x, tl.y, br.x, br.y);
          winGrad.addColorStop(0, rgbCss(accentRgbT, alpha * 0.62));
          winGrad.addColorStop(1, rgbCss(inkRgbT, alpha * 0.3));
          ctx.fillStyle = winGrad;
          traceWarpedQuad(ctx, tl, tm, tr, rm, br, bm, bl, lm, -5.2);
          ctx.fill();

          ctx.strokeStyle = rgbCss(wallRgb, alpha * 0.72);
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          ctx.moveTo(tm.x, tm.y);
          ctx.quadraticCurveTo(c.x, c.y, bm.x, bm.y);
          ctx.moveTo(lm.x, lm.y);
          ctx.quadraticCurveTo(c.x, c.y, rm.x, rm.y);
          ctx.stroke();
        } else if (tile.kind === "rail") {
          const hasNS =
            s.tiles.get(tileKey(tile.x, tile.y - 1))?.kind === "rail" ||
            s.tiles.get(tileKey(tile.x, tile.y + 1))?.kind === "rail";
          const hasEW =
            s.tiles.get(tileKey(tile.x - 1, tile.y))?.kind === "rail" ||
            s.tiles.get(tileKey(tile.x + 1, tile.y))?.kind === "rail";
          const horizontal = hasEW && !hasNS;
          const glint = 0.4 + Math.max(0, Math.sin(timeSec * 1.6 - (tile.x + tile.y) * 0.55)) * 0.36;

          const lerpPt = (a: Pt, b: Pt, f: number): Pt => ({
            x: a.x + (b.x - a.x) * f,
            y: a.y + (b.y - a.y) * f,
          });
          ctx.strokeStyle = rgbCss(wallRgb, alpha * 0.6);
          ctx.lineWidth = 2;
          for (const f of [0.22, 0.5, 0.78]) {
            ctx.beginPath();
            if (horizontal) {
              const p1 = lerpPt(tl, tr, f);
              const p2 = lerpPt(bl, br, f);
              ctx.moveTo(p1.x + (p2.x - p1.x) * 0.22, p1.y + (p2.y - p1.y) * 0.22);
              ctx.lineTo(p1.x + (p2.x - p1.x) * 0.78, p1.y + (p2.y - p1.y) * 0.78);
            } else {
              const p1 = lerpPt(tl, bl, f);
              const p2 = lerpPt(tr, br, f);
              ctx.moveTo(p1.x + (p2.x - p1.x) * 0.22, p1.y + (p2.y - p1.y) * 0.22);
              ctx.lineTo(p1.x + (p2.x - p1.x) * 0.78, p1.y + (p2.y - p1.y) * 0.78);
            }
            ctx.stroke();
          }
          ctx.strokeStyle = rgbCss(inkRgbT, alpha * glint);
          ctx.lineWidth = 1.5;
          for (const lane of [0.33, 0.67]) {
            ctx.beginPath();
            if (horizontal) {
              const a = lerpPt(tl, bl, lane);
              const b = lerpPt(tr, br, lane);
              const m = lerpPt(tm, bm, lane);
              ctx.moveTo(a.x, a.y);
              ctx.quadraticCurveTo(m.x, m.y, b.x, b.y);
            } else {
              const a = lerpPt(tl, tr, lane);
              const b = lerpPt(bl, br, lane);
              const m = lerpPt(lm, rm, lane);
              ctx.moveTo(a.x, a.y);
              ctx.quadraticCurveTo(m.x, m.y, b.x, b.y);
            }
            ctx.stroke();
          }
        } else if (tile.kind === "rift") {
          const pulse = 0.9 + Math.sin(timeSec * 2.4) * 0.12;
          const grad = ctx.createRadialGradient(c.x, c.y, 2, c.x, c.y, tileSz * 0.92);
          grad.addColorStop(0, "rgba(4, 7, 12, 0.98)");
          grad.addColorStop(0.45, rgbCss(inkRgbT, alpha * 0.3));
          grad.addColorStop(0.75, rgbCss(accentRgbT, alpha * 0.18));
          grad.addColorStop(1, rgbCss(accentRgbT, 0));
          ctx.fillStyle = grad;
          traceOrganicBlob(ctx, c.x, c.y, tileSz * 0.85 * pulse, tileSz * 0.78 * pulse, timeSec * 1.4, seed, 0.18, 12);
          ctx.fill();

          for (let ring = 0; ring < 3; ring++) {
            ctx.strokeStyle =
              ring === 0 ? rgbCss(accentRgbT, alpha * 0.82) : rgbCss(inkRgbT, alpha * (0.5 - ring * 0.12));
            ctx.lineWidth = 1.3;
            ctx.beginPath();
            const rad = tileSz * (0.14 + ring * 0.14) * pulse;
            const a0 = timeSec * (ring % 2 === 0 ? 1.15 : -0.82) + ring * 1.6;
            ctx.arc(c.x, c.y, rad, a0, a0 + Math.PI * 1.35);
            ctx.stroke();
          }

          ctx.font = `400 ${Math.round(tileSz * 0.25)}px "Shippori Mincho", "Hiragino Mincho ProN", serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const orbitAngle = timeSec * 0.95 + tile.x;
          ctx.fillStyle = rgbCss(inkRgbT, alpha * 0.62);
          ctx.fillText(
            tile.glyph,
            c.x + Math.cos(orbitAngle) * tileSz * 0.44,
            c.y + Math.sin(orbitAngle) * tileSz * 0.44,
          );

          if (tCtx && !reduced) {
            tCtx.strokeStyle = rgbCss(inkRgbT, alpha * 0.28);
            tCtx.lineWidth = 1.4;
            tCtx.beginPath();
            tCtx.arc(c.x * 0.5, c.y * 0.5, tileSz * 0.22 * pulse, timeSec * 1.4, timeSec * 1.4 + Math.PI * 1.2);
            tCtx.stroke();
          }
        }

        // 2c. 液状クロスモーフ（別タイル種別へリアルタイム変容中の 1.5 秒間、旧形状が溶けて滲む）
        if (morph && morphT < 1) {
          const remain = Math.pow(1 - morphT, 1.35);
          ctx.save();
          ctx.fillStyle = rgbCss(morph.oldWallRgb, remain * 0.55 * alpha);
          traceOrganicBlob(
            ctx,
            c.x,
            c.y,
            tileSz * (0.52 * remain + 0.12),
            tileSz * (0.48 * remain + 0.1),
            timeSec * 2.1,
            seed + morphT,
            0.32,
            10,
          );
          ctx.fill();

          ctx.strokeStyle = rgbCss(morph.oldAccentRgb, remain * 0.65 * alpha);
          ctx.lineWidth = 1.2;
          traceOrganicBlob(
            ctx,
            c.x,
            c.y,
            tileSz * (0.28 + morphT * 0.45),
            tileSz * (0.24 + morphT * 0.42),
            timeSec * 1.8,
            seed * 2.1,
            0.28,
            10,
          );
          ctx.stroke();
          ctx.restore();

          if (tCtx && !reduced) {
            tCtx.fillStyle = rgbCss(accentRgbT, remain * 0.26);
            tCtx.beginPath();
            tCtx.arc(c.x * 0.5, c.y * 0.5, tileSz * 0.2, 0, Math.PI * 2);
            tCtx.fill();
          }
        }

        // 2d. 忘却しかけ・出現直後・高温時の文字トークン揺らぎ（二重露光）
        const fadingAlpha = tile.memory < 0.76 ? (0.76 - tile.memory) * 0.66 : 0;
        const bornAlpha = materialize < 0.96 ? (1 - materialize) * 0.56 : 0;
        const heatAlpha = s.temperature > 1.08 && seed > 0.72 ? (s.temperature - 1.08) * 0.36 : 0;
        const glyphAlpha = Math.min(0.58, Math.max(fadingAlpha, bornAlpha, heatAlpha)) * alpha;

        if (glyphAlpha > 0.04 && tile.kind !== "rift" && !tile.motif) {
          const wobX = reduced ? 0 : Math.sin(timeSec * 2.1 + tile.x * 1.4 + tile.y) * (1.2 + tempNorm * 2.6);
          const wobY = reduced ? 0 : Math.cos(timeSec * 1.7 + tile.y * 1.3) * (1.0 + tempNorm * 2.2);
          ctx.font = `400 ${Math.round(tileSz * 0.36)}px "Shippori Mincho", "Hiragino Mincho ProN", Georgia, serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          if (ghostShift > 0.5) {
            ctx.fillStyle = rgbCss(accentRgbT, glyphAlpha * 0.46);
            ctx.fillText(tile.glyph, c.x + wobX + ghostShift, c.y + wobY - ghostShift * 0.45);
          }
          ctx.fillStyle = rgbCss(inkRgbT, glyphAlpha);
          ctx.fillText(tile.glyph, c.x + wobX, c.y + wobY);
        }

        if (tile.kind === "window" || tile.kind === "lamp") {
          lightSources.push({ tile, c, alpha });
        }
      }

      // 3. 夢の光学レイヤー（ワープに沿って曲がり揺れる窓の光条＋街灯の呼吸ブルーム）
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const src of lightSources) {
        const lAccent = blendDomainColors(src.tile.domainBlend, "accent");
        const lInk = blendDomainColors(src.tile.domainBlend, "ink");
        if (src.tile.kind === "window") {
          const tip = warpWorldToScreen(src.tile.x + 1.45, src.tile.y + 1.95);
          const bGrad = ctx.createLinearGradient(src.c.x, src.c.y, tip.x, tip.y);
          bGrad.addColorStop(0, rgbCss(lAccent, src.alpha * 0.25));
          bGrad.addColorStop(0.55, rgbCss(lInk, src.alpha * 0.1));
          bGrad.addColorStop(1, rgbCss(lAccent, 0));
          ctx.fillStyle = bGrad;
          ctx.beginPath();
          ctx.moveTo(src.c.x - tileSz * 0.3, src.c.y + tileSz * 0.14);
          ctx.lineTo(src.c.x + tileSz * 0.34, src.c.y - tileSz * 0.22);
          ctx.lineTo(tip.x + tileSz * 0.72, tip.y - tileSz * 0.22);
          ctx.lineTo(tip.x - tileSz * 0.44, tip.y + tileSz * 0.48);
          ctx.closePath();
          ctx.fill();
        } else if (src.tile.kind === "lamp") {
          const breathe = reduced ? 1 : 0.9 + Math.sin(timeSec * 2.2 + src.tile.x * 1.3) * 0.1;
          const rad = tileSz * 2.0 * breathe;
          const glow = ctx.createRadialGradient(src.c.x, src.c.y, 1, src.c.x, src.c.y, rad);
          glow.addColorStop(0, rgbCss(lAccent, src.alpha * 0.42));
          glow.addColorStop(0.35, rgbCss(lAccent, src.alpha * 0.16));
          glow.addColorStop(1, rgbCss(lAccent, 0));
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(src.c.x, src.c.y, rad, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = rgbCss(lInk, src.alpha * 0.92);
          ctx.beginPath();
          ctx.arc(src.c.x, src.c.y, Math.max(2.6, tileSz * 0.075), 0, Math.PI * 2);
          ctx.fill();

          if (tCtx && !reduced) {
            tCtx.fillStyle = rgbCss(lAccent, src.alpha * 0.18);
            tCtx.beginPath();
            tCtx.arc(src.c.x * 0.5, src.c.y * 0.5, tileSz * 0.36, 0, Math.PI * 2);
            tCtx.fill();
          }
        }
      }
      ctx.restore();

      // 4. リアルタイム潜在流線リボン（LSTM の 8 次元ベクトル場に沿って画面中をウニョウニョ蛇行）
      if (!reduced) {
        const ribbonAlphaBase = 0.08 + tempNorm * 0.11 + s.bleedEntropy * 0.07;
        const speedMul = 0.9 + tempNorm * 1.5 + cam.pulseWave * 1.6;

        ctx.save();
        ctx.lineCap = "round";
        for (let i = 0; i < flowRibbonsRef.current.length; i++) {
          const rb = flowRibbonsRef.current[i];
          rb.age++;
          const head = rb.pts[rb.pts.length - 1];
          const vel = sampleFlowVelocity(head.x, head.y);
          const nx = head.x + vel.x * rb.speed * speedMul;
          const ny = head.y + vel.y * rb.speed * speedMul;
          rb.pts.push({ x: nx, y: ny });
          if (rb.pts.length > 11) rb.pts.shift();

          const outOfBounds = nx < -40 || nx > width + 40 || ny < -40 || ny > height + 40;
          if (rb.age > rb.maxAge || outOfBounds) {
            flowRibbonsRef.current[i] = spawnRibbon(width, height, i + Math.floor(timeSec * 7));
            continue;
          }

          if (rb.pts.length >= 3) {
            const lifeFade =
              smoothstep(0, 14, rb.age) * (1 - smoothstep(rb.maxAge - 22, rb.maxAge, rb.age));
            const col = rb.tint === "accent" ? accentRgb : inkRgb;
            ctx.strokeStyle = rgbCss(col, ribbonAlphaBase * lifeFade);
            ctx.lineWidth = 1.05 + tempNorm * 0.65;
            ctx.beginPath();
            ctx.moveTo(rb.pts[0].x, rb.pts[0].y);
            for (let k = 1; k < rb.pts.length - 1; k++) {
              const midX = (rb.pts[k].x + rb.pts[k + 1].x) * 0.5;
              const midY = (rb.pts[k].y + rb.pts[k + 1].y) * 0.5;
              ctx.quadraticCurveTo(rb.pts[k].x, rb.pts[k].y, midX, midY);
            }
            ctx.stroke();

            if (tCtx && i % 2 === 0) {
              tCtx.fillStyle = rgbCss(col, ribbonAlphaBase * lifeFade * 0.55);
              tCtx.beginPath();
              tCtx.arc(nx * 0.5, ny * 0.5, 1.3, 0, Math.PI * 2);
              tCtx.fill();
            }
          }
        }
        ctx.restore();
      }

      // 5. 記憶のしおり（Anchor）の穏やかな安定枠（周囲がうねるほど「ここだけ静かに静止」が際立つ）
      for (const anchor of s.anchors) {
        const pos = warpWorldToScreen(anchor.x, anchor.y);
        const boxW = (ANCHOR_RADIUS * 2 + 1) * tileSz;
        const bx = pos.x - boxW / 2;
        const by = pos.y - boxW / 2;
        ctx.save();
        const corner = tileSz * 0.48;
        ctx.strokeStyle = "rgba(216, 178, 106, 0.46)";
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(bx + 2, by + corner);
        ctx.lineTo(bx + 2, by + 2);
        ctx.lineTo(bx + corner, by + 2);
        ctx.moveTo(bx + boxW - corner, by + 2);
        ctx.lineTo(bx + boxW - 2, by + 2);
        ctx.lineTo(bx + boxW - 2, by + corner);
        ctx.moveTo(bx + boxW - 2, by + boxW - corner);
        ctx.lineTo(bx + boxW - 2, by + boxW - 2);
        ctx.lineTo(bx + boxW - corner, by + boxW - 2);
        ctx.moveTo(bx + corner, by + boxW - 2);
        ctx.lineTo(bx + 2, by + boxW - 2);
        ctx.lineTo(bx + 2, by + boxW - corner);
        ctx.stroke();

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

      // 6. モチーフ描画（線画シルエット＋公転二重露光エコー＋一文字ずつ揺れる明朝ラベル）
      for (const tile of s.tiles.values()) {
        if (!tile.motif) continue;
        const pos = warpWorldToScreen(tile.x, tile.y);
        const dist = Math.hypot(tile.x - cam.px, tile.y - cam.py);
        const alpha = Math.max(0.14, Math.min(1, tile.memory * (1 - (dist - (VIEW_RADIUS - 1.5)) / 2.7)));
        if (alpha <= 0.06) continue;

        const isReunion = tile.motif.generation >= 2;
        const bob = reduced ? 0 : Math.sin(timeSec * 2.1 + tile.x + tile.y) * 3.2;
        const my = pos.y + bob;
        const origAccent = DOMAIN_PALETTES[tile.motif.originDomain].accent;
        const curAccent = DOMAIN_PALETTES[tile.motif.domain].accent;

        const halo = ctx.createRadialGradient(pos.x, my, 2, pos.x, my, tileSz * 0.92);
        halo.addColorStop(0, rgbCss(isReunion ? origAccent : curAccent, alpha * 0.44));
        halo.addColorStop(0.55, rgbCss(curAccent, alpha * 0.15));
        halo.addColorStop(1, rgbCss(curAccent, 0));
        ctx.fillStyle = halo;
        traceOrganicBlob(ctx, pos.x, my, tileSz * 0.85, tileSz * 0.8, timeSec * 1.5, tileHash(tile.x, tile.y, 23), 0.16, 9);
        ctx.fill();

        if (isReunion) {
          ctx.strokeStyle = rgbCss(origAccent, alpha * 0.68);
          ctx.lineWidth = 1.2;
          traceOrganicBlob(
            ctx,
            pos.x,
            my,
            tileSz * 0.42,
            tileSz * 0.4,
            timeSec * 2.0,
            tileHash(tile.x, tile.y, 47),
            0.14,
            10,
          );
          ctx.stroke();
        }

        if (!reduced) {
          const orbitR = (isReunion ? 3.2 : 1.8) + ghostShift * 0.72;
          const ox = Math.cos(timeSec * 1.35 + tile.x * 1.1 + sh[0] * 2) * orbitR;
          const oy = Math.sin(timeSec * 1.15 + tile.y * 1.1 + sh[1] * 2) * orbitR * 0.85;
          drawMotifGlyph(
            ctx,
            tile.motif.id,
            pos.x + ox,
            my + oy,
            tileSz * 0.34,
            rgbCss(origAccent, alpha * (0.28 + tempNorm * 0.18)),
            rgbCss(origAccent, alpha * 0.16),
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
          rgbCss(isReunion ? origAccent : curAccent, alpha * 0.74),
          timeSec,
        );

        if (tCtx && !reduced) {
          tCtx.fillStyle = rgbCss(isReunion ? origAccent : curAccent, alpha * 0.22);
          tCtx.beginPath();
          tCtx.arc(pos.x * 0.5, my * 0.5, tileSz * 0.22, 0, Math.PI * 2);
          tCtx.fill();
        }

        if (dist <= 5.4) {
          const label =
            tile.motif.generation >= 2
              ? `${tile.motif.name} ${romanGeneration(tile.motif.generation)}`
              : tile.motif.name;
          const chars = Array.from(label);
          const fontSize = Math.max(11, Math.round(tileSz * 0.23));
          ctx.save();
          ctx.font = `400 ${fontSize}px "Shippori Mincho", "Hiragino Mincho ProN", serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.shadowColor = "rgba(6, 10, 16, 0.96)";
          ctx.shadowBlur = 10;
          const stepW = fontSize * 0.96;
          const startX = pos.x - ((chars.length - 1) * stepW) * 0.5;
          const baseY = my + tileSz * 0.42;
          const labelAmp = reduced ? 0 : 1.1 + tempNorm * 2.4;

          for (let ci = 0; ci < chars.length; ci++) {
            const cxChar = startX + ci * stepW;
            const cyChar = baseY + Math.sin(timeSec * 2.4 + ci * 0.85 + tile.x) * labelAmp;
            if (!reduced && tempNorm > 0.35) {
              ctx.fillStyle = rgbCss(origAccent, alpha * 0.34);
              ctx.fillText(chars[ci], cxChar + ghostShift * 0.45, cyChar - ghostShift * 0.25);
            }
            ctx.fillStyle = isReunion
              ? rgbCss(origAccent, alpha * 0.98)
              : rgbCss(inkRgb, alpha * 0.94);
            ctx.fillText(chars[ci], cxChar, cyChar);
          }
          ctx.restore();
        }
      }

      // 7. 足跡の記憶軌跡（歩いてきた数歩が背後に淡く光って消えていく）
      trailRef.current = trailRef.current.filter((node) => now - node.atMs < 6500);
      if (trailRef.current.length >= 2) {
        ctx.save();
        for (let i = 0; i < trailRef.current.length; i++) {
          const node = trailRef.current[i];
          const age = (now - node.atMs) / 6500;
          const a = Math.max(0, (1 - age) * 0.24);
          const pos = warpWorldToScreen(node.x, node.y);
          ctx.fillStyle = rgbCss(inkRgb, a);
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, tileSz * (0.065 * (1 - age * 0.4)), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // 8. 波紋エフェクト
      ripplesRef.current = ripplesRef.current.filter((rp) => {
        const t = (now - rp.startMs) / rp.durMs;
        if (t >= 1) return false;
        const pos = warpWorldToScreen(rp.wx, rp.wy);
        const rad = (0.22 + rp.maxRadius * easeOutCubic(t)) * tileSz;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.pow(1 - t, 1.4) * 0.72);
        ctx.strokeStyle = rp.color;
        ctx.lineWidth = 1.8 * (1 - t * 0.5);
        traceOrganicBlob(ctx, pos.x, pos.y, rad, rad * 0.96, timeSec * 1.8, rp.wx * 0.3 + rp.wy, 0.08 + tempNorm * 0.08, 12);
        ctx.stroke();
        ctx.restore();
        return true;
      });

      // 9. プレイヤー（夢の中を漂う灯火・視線光錐・佇みしおり定着弧・集めた記憶の蛍・残響コンパス弧）
      const pPos = warpWorldToScreen(cam.px + cam.bumpX, cam.py + cam.bumpY);

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const coneLen = tileSz * 3.15;
      const coneGrad = ctx.createRadialGradient(pPos.x, pPos.y, 4, pPos.x, pPos.y, coneLen);
      coneGrad.addColorStop(0, "rgba(244, 234, 212, 0.15)");
      coneGrad.addColorStop(1, "rgba(244, 234, 212, 0)");
      ctx.fillStyle = coneGrad;
      ctx.beginPath();
      ctx.moveTo(pPos.x, pPos.y);
      ctx.arc(pPos.x, pPos.y, coneLen, cam.facingAngle - 0.46, cam.facingAngle + 0.46);
      ctx.closePath();
      ctx.fill();

      const pHalo = ctx.createRadialGradient(pPos.x, pPos.y, 2, pPos.x, pPos.y, tileSz * 2.25);
      pHalo.addColorStop(0, "rgba(246, 236, 212, 0.3)");
      pHalo.addColorStop(0.45, rgbCss(accentRgb, 0.11));
      pHalo.addColorStop(1, "rgba(246, 236, 212, 0)");
      ctx.fillStyle = pHalo;
      ctx.beginPath();
      ctx.arc(pPos.x, pPos.y, tileSz * 2.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      const signal = findNearestSignal(s);
      if (signal) {
        const angle = Math.atan2(signal.dy, signal.dx);
        ctx.save();
        ctx.strokeStyle =
          signal.kind === "reunion"
            ? "rgba(228, 194, 118, 0.84)"
            : signal.kind === "rift"
              ? "rgba(156, 206, 224, 0.8)"
              : rgbCss(accentRgb, 0.48);
        ctx.lineWidth = 1.7;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(pPos.x, pPos.y, tileSz * 0.56, angle - 0.3, angle + 0.3);
        ctx.stroke();
        ctx.restore();
      }

      // 佇み定着チャージ弧（ボタン無しで静かに記憶の島を結ぶ気配）
      if (mc.stillSec > STILL_ANCHOR_DELAY_SEC) {
        const charge = Math.min(
          1,
          (mc.stillSec - STILL_ANCHOR_DELAY_SEC) / (STILL_ANCHOR_TOTAL_SEC - STILL_ANCHOR_DELAY_SEC),
        );
        ctx.save();
        ctx.strokeStyle = `rgba(216, 178, 106, ${(0.28 + charge * 0.56).toFixed(3)})`;
        ctx.lineWidth = 1.6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(pPos.x, pPos.y, tileSz * 0.44, -Math.PI * 0.5, -Math.PI * 0.5 + Math.PI * 2 * charge);
        ctx.stroke();
        ctx.restore();
      }

      // 集めた記憶の蛍（発見済み原型モチーフの数だけ小さな光粒がプレイヤーの周囲を静かに巡る）
      const discoveredCount = Math.max(s.discoveredMotifs.length, recordRef.current.discoveredMotifs.length);
      if (discoveredCount > 0 && !reduced) {
        ctx.save();
        for (let i = 0; i < discoveredCount; i++) {
          const a = timeSec * (0.55 + (i % 3) * 0.14) + (i / discoveredCount) * Math.PI * 2;
          const rx = tileSz * (0.48 + (i % 2) * 0.14);
          const ry = tileSz * (0.36 + ((i + 1) % 2) * 0.14);
          const fx = pPos.x + Math.cos(a) * rx;
          const fy = pPos.y + Math.sin(a) * ry;
          const twinkle = 0.45 + 0.45 * Math.sin(timeSec * 2.1 + i * 1.7);
          ctx.fillStyle = rgbCss(accentRgb, 0.58 * twinkle);
          ctx.beginPath();
          ctx.arc(fx, fy, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      const corePulse = reduced ? 1 : 1 + Math.sin(timeSec * 2.8) * 0.08;
      ctx.fillStyle = "#f5efe0";
      ctx.beginPath();
      ctx.arc(pPos.x, pPos.y, tileSz * 0.16 * corePulse, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = rgbCss(accentRgb, 0.74);
      ctx.lineWidth = 1.3;
      traceOrganicBlob(
        ctx,
        pPos.x,
        pPos.y,
        tileSz * 0.28,
        tileSz * 0.28,
        timeSec * 2.2,
        1.7,
        reduced ? 0 : 0.08 + tempNorm * 0.06,
        10,
      );
      ctx.stroke();

      if (tCtx && !reduced) {
        tCtx.fillStyle = "rgba(245, 236, 214, 0.22)";
        tCtx.beginPath();
        tCtx.arc(pPos.x * 0.5, pPos.y * 0.5, tileSz * 0.16, 0, Math.PI * 2);
        tCtx.fill();
      }

      // 10. 液状残像フィードバックバッファをスクリーン合成
      if (tCtx && !reduced) {
        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.globalAlpha = 0.3 + tempNorm * 0.26;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(trailCanvas, 0, 0, width, height);
        ctx.restore();
      }

      // 11. 舞い散る文字トークン粒子
      particlesRef.current = particlesRef.current.filter((pt) => {
        const t = (now - pt.startMs) / pt.durMs;
        if (t >= 1) return false;
        const elapsed = (now - pt.startMs) / 1000;
        const pos = warpWorldToScreen(pt.wx + pt.vx * elapsed, pt.wy + pt.vy * elapsed);
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

      // 12. 領域連動の環境パーティクル（商店街の雨・校舎の光塵・草地の蛍・外縁の漂流仮名）
      if (!reduced) {
        const rainW = sw.arcade ?? 0;
        const dustW = (sw.school ?? 0) + (sw.library ?? 0);
        const fireflyW = sw.meadow ?? 0;

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
            m.x = (m.x + Math.sin(timeSec * 0.35 + m.phase) * 0.35 + m.speed * 0.18 + width) % width;
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

        const whisperChars = Array.from(s.whisper?.text ?? s.placeName);
        ctx.font = `400 17px "Shippori Mincho", "Hiragino Mincho ProN", serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (let i = 0; i < mistGlyphsRef.current.length; i++) {
          const mg = mistGlyphsRef.current[i];
          const fv = sampleFlowVelocity(mg.x, mg.y);
          mg.x = (mg.x + (mg.vx * 0.014 + fv.x * 0.25) + width) % width;
          mg.y = (mg.y + (mg.vy * 0.014 + fv.y * 0.25) + height) % height;
          const edgeDist = Math.hypot((mg.x - centerX) / (width * 0.5), (mg.y - centerY) / (height * 0.5));
          if (edgeDist < 0.6) continue;
          const ch = whisperChars.length > 0 ? whisperChars[i % whisperChars.length] : mg.char;
          const gA = Math.min(0.18, (edgeDist - 0.6) * 0.3) * (0.55 + 0.45 * Math.sin(timeSec * 0.8 + mg.phase));
          ctx.fillStyle = rgbCss(inkRgb, gA);
          ctx.fillText(ch, mg.x, mg.y);
        }
        ctx.restore();
      }

      // 13. 深度に応じてわずかに狭まる周辺霧ビネット（有限コンテキスト窓の体感）
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
      vig.addColorStop(0.72, rgbCss(fogRgb, 0.4));
      vig.addColorStop(1, rgbCss(fogRgb, 0.92));
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, width, height);

      // 14. 35mm フィルム微粒状テクスチャ
      if (grainPattern) {
        ctx.save();
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = grainPattern;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
      }

      // 15. 画面タップ波紋フィードバック
      tapRingsRef.current = tapRingsRef.current.filter((tr) => {
        const t = (now - tr.startMs) / tr.durMs;
        if (t >= 1) return false;
        ctx.save();
        ctx.strokeStyle = rgbCss(inkRgb, (1 - t) * 0.4);
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.arc(tr.sx, tr.sy, 6 + easeOutCubic(t) * 24, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        return true;
      });

      // 16. 霧の中に溶け込むダイエジェティック文字（枠なし・UI なし・時間経過で霧へ馴染む）
      const mt = mistTextRef.current;
      const placeAge = now - mt.placeChangedMs;
      const placeFadeIn = smoothstep(0, 520, placeAge);
      const placeGlow = 0.56 + (1 - smoothstep(400, 3200, placeAge)) * 0.3;
      const placeChars = Array.from(mt.placeName);
      if (placeChars.length > 0) {
        const titleSize = Math.max(15, Math.min(20, Math.round(width * 0.032)));
        const charStep = titleSize * 1.16;
        const startX = centerX - ((placeChars.length - 1) * charStep) * 0.5;
        const titleY = 34;

        ctx.save();
        ctx.font = `400 ${titleSize}px "Shippori Mincho", "Hiragino Mincho ProN", Georgia, serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(6, 10, 16, 0.9)";
        ctx.shadowBlur = 16;

        for (let i = 0; i < placeChars.length; i++) {
          const cxChar = startX + i * charStep;
          const cyChar =
            titleY + (reduced ? 0 : Math.sin(timeSec * 1.55 + i * 0.65 + sh[0] * 2) * (1.0 + tempNorm * 1.6));
          if (!reduced && tempNorm > 0.3) {
            ctx.fillStyle = rgbCss(accentRgb, placeFadeIn * placeGlow * 0.28);
            ctx.fillText(placeChars[i], cxChar + ghostShift * 0.42, cyChar - ghostShift * 0.22);
          }
          ctx.fillStyle = rgbCss(inkRgb, placeFadeIn * placeGlow);
          ctx.fillText(placeChars[i], cxChar, cyChar);
        }

        // 極小の深度・記憶刻印（通常は霧に溶ける 0.26、潜行・採集直後だけ 0.58 にふわっと浮かぶ）
        const metaPulse = now < mt.metaHighlightUntilMs ? 1 - smoothstep(mt.metaHighlightUntilMs - 1600, mt.metaHighlightUntilMs, now) : 0;
        const metaAlpha = 0.26 + metaPulse * 0.34;
        ctx.font = `400 11px "Shippori Mincho", "Hiragino Mincho ProN", serif`;
        ctx.fillStyle = rgbCss(inkRgb, metaAlpha);
        ctx.fillText(`第${s.depth}層 · ${discoveredCount}/${DREAM_MOTIFS.length}`, centerX, titleY + 23);
        ctx.restore();
      }

      // 夢の呟き（char-RNN 生成の 1 行が霧から浮かび、数秒かけて静かに消える）
      if (mt.whisperText) {
        const wAge = now - mt.whisperShownMs;
        if (wAge < 5600) {
          const wAlpha = smoothstep(0, 680, wAge) * (1 - smoothstep(3200, 5600, wAge));
          if (wAlpha > 0.01) {
            const wY = Math.max(height * 0.68, height - 168);
            const wSize = Math.max(13, Math.min(16, Math.round(width * 0.025)));
            ctx.save();
            ctx.font = `400 ${wSize}px "Shippori Mincho", "Hiragino Mincho ProN", Georgia, serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.shadowColor = "rgba(6, 10, 16, 0.94)";
            ctx.shadowBlur = 18;
            ctx.fillStyle = rgbCss(inkRgb, wAlpha * 0.84);
            ctx.fillText(mt.whisperText, centerX, wY + (1 - smoothstep(0, 680, wAge)) * 8, width - 48);
            ctx.restore();
          }
        }
      }

      // 17. 潜行時の静かな霧フェード幕
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
  }, [applyTransition]);

  return (
    <div className="dreaming-shell">
      <div
        ref={stageRef}
        className="dreaming-stage"
        role="application"
        aria-label="dreaming の夢空間"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <canvas ref={canvasRef} className="dreaming-canvas" />

        <div ref={floatRingRef} className="dreaming-joy-float" aria-hidden="true">
          <div className="dreaming-joy-core" />
          <div ref={floatKnobRef} className="dreaming-joy-knob" />
        </div>

        <div ref={dockJoyRef} className="dreaming-joystick" aria-label="移動ジョイスティック">
          <div className="dreaming-joy-core" aria-hidden="true" />
          <div ref={dockKnobRef} className="dreaming-joy-knob" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
