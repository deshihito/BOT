"use client";
// WEB ゲーム「dreaming」のメインクライアント（独立フルビューポートシェル .dreaming-shell）。
//
// Transformer 以前の生成モデル（小型 LSTM + 文字レベル n-gram + 2D 条件付きマルコフ場）
// の内部状態と逐次生成を、Canvas 2D の夢空間＋隠れ状態モニタ＋標本帳として体験させる。
// クリアやゲームオーバーで閉じることはなく、終わりなく潜り・漂い続けられる。

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
} from "@/lib/games/dreaming-model";
import {
  ANCHOR_RADIUS,
  DREAMING_RECORD_KEY,
  DREAM_MOTIFS,
  MAX_ANCHORS,
  VIEW_RADIUS,
  createDreamGame,
  findNearestSignal,
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

type CharParticle = {
  wx: number;
  wy: number;
  vx: number;
  vy: number;
  char: string;
  startMs: number;
  durMs: number;
  color: string;
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

function temperatureLabel(temp: number): string {
  if (temp < 0.68) return "明晰";
  if (temp < 1.2) return "うつつ";
  if (temp < 1.52) return "滲み";
  return "深夢";
}

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
  ctx.lineWidth = Math.max(1.35, r * 0.11);
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

export default function DreamingClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<DreamState>(() => createDreamGame(20261119));
  const [record, setRecord] = useState<DreamRecord>(() => parseDreamRecord(null));
  const [muted, setMuted] = useState(false);
  const [showRnn, setShowRnn] = useState(true);
  const [showArchive, setShowArchive] = useState(false);

  const stateRef = useRef(state);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // 滑らか補間・パーティクル・波紋用のレンダー専用 ref（React 再描画を起こさず 60fps 描画）
  const camRef = useRef({ x: 0, y: 0, px: 0, py: 0, bumpX: 0, bumpY: 0, descendFlash: 0 });
  const ripplesRef = useRef<RippleFx[]>([]);
  const particlesRef = useRef<CharParticle[]>([]);
  const lastEventSeqRef = useRef(-1);
  const savedStepsRef = useRef(0);
  const savedForgottenRef = useRef(0);
  const reducedMotionRef = useRef(false);

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
    camRef.current = { x: 0, y: 0, px: 0, py: 0, bumpX: 0, bumpY: 0, descendFlash: 0 };
    reducedMotionRef.current =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    // モバイル幅では初期表示の視界確保のため RNN パネルを折りたたみ状態にする
    if (typeof window !== "undefined" && window.innerWidth <= 720) {
      setShowRnn(false);
    }
  }, []);

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

  // イベントに応じた視覚波紋・文字粒子・SE を発火
  const handleEventEffects = useCallback((next: DreamState) => {
    const ev = next.lastEvent;
    const now = performance.now();
    const accent = rgbCss(blendDomainColors(next.domainWeights, "accent"), 0.85);
    const ink = rgbCss(blendDomainColors(next.domainWeights, "ink"), 0.9);

    if (ev.kind === "move") {
      sfxDreamStep(next.dominantDomain, next.temperature);
    } else if (ev.kind === "blocked") {
      sfxDreamBump();
      const dx = Math.sign(ev.x - next.player.x);
      const dy = Math.sign(ev.y - next.player.y);
      camRef.current.bumpX = dx * 0.24;
      camRef.current.bumpY = dy * 0.24;
    } else if (ev.kind === "collect" || ev.kind === "reunion") {
      sfxDreamCollect(ev.generation ?? 1);
      ripplesRef.current.push({
        wx: ev.x,
        wy: ev.y,
        startMs: now,
        durMs: ev.kind === "reunion" ? 900 : 650,
        maxRadius: ev.kind === "reunion" ? 3.2 : 2.2,
        color: ev.kind === "reunion" ? "rgba(218,184,110,0.9)" : accent,
      });
      const chars = Array.from(ev.detail ?? "");
      chars.forEach((ch, idx) => {
        const angle = (idx / Math.max(1, chars.length)) * Math.PI * 2 - Math.PI / 2;
        const speed = 0.7 + (idx % 3) * 0.35;
        particlesRef.current.push({
          wx: ev.x,
          wy: ev.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 0.35,
          char: ch,
          startMs: now,
          durMs: 1150,
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
        durMs: 750,
        maxRadius: ANCHOR_RADIUS + 0.6,
        color: "rgba(207,169,96,0.8)",
      });
    } else if (ev.kind === "pulse") {
      sfxDreamPulse();
      ripplesRef.current.push({
        wx: ev.x,
        wy: ev.y,
        startMs: now,
        durMs: 780,
        maxRadius: 3.1,
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
        durMs: 1100,
        maxRadius: 4.5,
        color: "rgba(200,218,228,0.75)",
      });
    }
  }, []);

  const applyTransition = useCallback(
    (fn: (s: DreamState) => DreamState) => {
      const next = fn(stateRef.current);
      stateRef.current = next;
      setState(next);
      lastEventSeqRef.current++;
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
    camRef.current.descendFlash = 0.85;
    setShowArchive(false);
  }, [applyTransition]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    setSfxMuted(next);
  }, [muted]);

  // キーボード操作
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      if (e.key === "Escape" && showArchive) {
        e.preventDefault();
        setShowArchive(false);
        return;
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
  }, [doAnchor, doMove, doPulse, doTempChange, showArchive]);

  // 盤面スワイプは共通 lib/gesture.ts を使う
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
      const dx = pt.x - (rect.left + rect.width / 2);
      const dy = pt.y - (rect.top + rect.height / 2);
      const tilePx = Math.max(36, Math.min(58, Math.min(rect.width, rect.height) / 10.5));
      if (Math.hypot(dx, dy) <= tilePx * 0.85) {
        doPulse();
      } else if (Math.abs(dx) > Math.abs(dy)) {
        doMove(dx > 0 ? "right" : "left");
      } else {
        doMove(dy > 0 ? "down" : "up");
      }
    },
  });

  // Canvas 2D リアルタイム描画ループ
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let rafId = 0;
    let width = 1;
    let height = 1;
    let dpr = 1;

    const resize = () => {
      const rect = stage.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    };
    resize();

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(stage);

    const drawTileDetail = (
      tile: DreamTile,
      sx: number,
      sy: number,
      sz: number,
      tiles: Map<string, DreamTile>,
      timeSec: number,
      alpha: number,
    ) => {
      const floorRgb = blendDomainColors(tile.domainBlend, "floor");
      const wallRgb = blendDomainColors(tile.domainBlend, "wall");
      const accentRgb = blendDomainColors(tile.domainBlend, "accent");
      const inkRgb = blendDomainColors(tile.domainBlend, "ink");

      const pad = 1;
      const x0 = sx + pad;
      const y0 = sy + pad;
      const w = sz - pad * 2;

      // ベース床
      ctx.fillStyle = rgbCss(floorRgb, alpha);
      ctx.fillRect(x0, y0, w, w);

      // 領域固有のささやかな床ディテール
      if (tile.kind === "floor") {
        if (tile.domain === "station" && (tile.x + tile.y) % 4 === 0) {
          ctx.fillStyle = rgbCss(accentRgb, alpha * 0.16);
          ctx.fillRect(x0 + 3, y0 + w - 5, w - 6, 2);
        } else if (tile.domain === "school") {
          ctx.strokeStyle = rgbCss(wallRgb, alpha * 0.25);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x0, y0 + w * 0.5);
          ctx.lineTo(x0 + w, y0 + w * 0.5);
          ctx.stroke();
        } else if (tile.domain === "arcade" && (tile.x * 7 + tile.y * 13) % 5 === 0) {
          ctx.strokeStyle = rgbCss(inkRgb, alpha * 0.14);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.ellipse(sx + sz / 2, sy + sz / 2, w * 0.28, w * 0.14, 0, 0, Math.PI * 2);
          ctx.stroke();
        } else if (tile.domain === "meadow" && (tile.x * 5 + tile.y * 3) % 3 === 0) {
          ctx.strokeStyle = rgbCss(accentRgb, alpha * 0.18);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sx + sz * 0.35, sy + sz * 0.72);
          ctx.lineTo(sx + sz * 0.42, sy + sz * 0.44);
          ctx.moveTo(sx + sz * 0.58, sy + sz * 0.74);
          ctx.lineTo(sx + sz * 0.64, sy + sz * 0.5);
          ctx.stroke();
        }
      } else if (tile.kind === "wall") {
        ctx.fillStyle = rgbCss(wallRgb, alpha);
        ctx.fillRect(x0, y0, w, w);
        ctx.fillStyle = rgbCss(inkRgb, alpha * 0.12);
        ctx.fillRect(x0, y0, w, 3);
        ctx.strokeStyle = rgbCss(inkRgb, alpha * 0.08);
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, w - 1);
      } else if (tile.kind === "water") {
        const deep: [number, number, number] = [
          Math.max(10, Math.round(wallRgb[0] * 0.72)),
          Math.max(18, Math.round(wallRgb[1] * 0.96 + 10)),
          Math.max(28, Math.round(wallRgb[2] * 1.15 + 16)),
        ];
        ctx.fillStyle = rgbCss(deep, alpha);
        ctx.fillRect(x0, y0, w, w);
        const wave = Math.sin(timeSec * 1.6 + tile.x * 0.9 + tile.y * 0.7) * 3;
        ctx.strokeStyle = rgbCss(inkRgb, alpha * 0.24);
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(x0 + w * 0.16, y0 + w * 0.4 + wave * 0.3);
        ctx.lineTo(x0 + w * 0.56, y0 + w * 0.4 + wave * 0.3);
        ctx.moveTo(x0 + w * 0.42, y0 + w * 0.68 - wave * 0.25);
        ctx.lineTo(x0 + w * 0.84, y0 + w * 0.68 - wave * 0.25);
        ctx.stroke();
      } else if (tile.kind === "rail") {
        const hasNS =
          tiles.get(tileKey(tile.x, tile.y - 1))?.kind === "rail" ||
          tiles.get(tileKey(tile.x, tile.y + 1))?.kind === "rail";
        const hasEW =
          tiles.get(tileKey(tile.x - 1, tile.y))?.kind === "rail" ||
          tiles.get(tileKey(tile.x + 1, tile.y))?.kind === "rail";
        const horizontal = hasEW && !hasNS;
        ctx.strokeStyle = rgbCss(wallRgb, alpha * 0.7);
        ctx.lineWidth = 2;
        for (let k = 0.2; k <= 0.85; k += 0.3) {
          ctx.beginPath();
          if (horizontal) {
            ctx.moveTo(x0 + w * k, y0 + w * 0.2);
            ctx.lineTo(x0 + w * k, y0 + w * 0.8);
          } else {
            ctx.moveTo(x0 + w * 0.2, y0 + w * k);
            ctx.lineTo(x0 + w * 0.8, y0 + w * k);
          }
          ctx.stroke();
        }
        ctx.strokeStyle = rgbCss(inkRgb, alpha * 0.48);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        if (horizontal) {
          ctx.moveTo(x0, y0 + w * 0.32);
          ctx.lineTo(x0 + w, y0 + w * 0.32);
          ctx.moveTo(x0, y0 + w * 0.68);
          ctx.lineTo(x0 + w, y0 + w * 0.68);
        } else {
          ctx.moveTo(x0 + w * 0.32, y0);
          ctx.lineTo(x0 + w * 0.32, y0 + w);
          ctx.moveTo(x0 + w * 0.68, y0);
          ctx.lineTo(x0 + w * 0.68, y0 + w);
        }
        ctx.stroke();
      } else if (tile.kind === "shelf") {
        ctx.fillStyle = rgbCss(wallRgb, alpha);
        ctx.fillRect(x0 + 2, y0 + 2, w - 4, w - 4);
        ctx.strokeStyle = rgbCss(accentRgb, alpha * 0.36);
        ctx.lineWidth = 1.4;
        for (let b = 0.2; b <= 0.8; b += 0.2) {
          ctx.beginPath();
          ctx.moveTo(x0 + w * b, y0 + 5);
          ctx.lineTo(x0 + w * b, y0 + w - 5);
          ctx.stroke();
        }
      } else if (tile.kind === "window") {
        ctx.fillStyle = rgbCss(wallRgb, alpha);
        ctx.fillRect(x0, y0, w, w);
        ctx.fillStyle = rgbCss(accentRgb, alpha * 0.22);
        ctx.fillRect(x0 + 5, y0 + 5, w - 10, w - 10);
        ctx.strokeStyle = rgbCss(inkRgb, alpha * 0.35);
        ctx.lineWidth = 1.2;
        ctx.strokeRect(x0 + 5, y0 + 5, w - 10, w - 10);
        ctx.beginPath();
        ctx.moveTo(x0 + w / 2, y0 + 5);
        ctx.lineTo(x0 + w / 2, y0 + w - 5);
        ctx.moveTo(x0 + 5, y0 + w / 2);
        ctx.lineTo(x0 + w - 5, y0 + w / 2);
        ctx.stroke();
      } else if (tile.kind === "lamp") {
        const cx = sx + sz / 2;
        const cy = sy + sz / 2;
        const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, sz * 1.15);
        glow.addColorStop(0, rgbCss(accentRgb, alpha * 0.34));
        glow.addColorStop(1, rgbCss(accentRgb, 0));
        ctx.fillStyle = glow;
        ctx.fillRect(cx - sz * 1.2, cy - sz * 1.2, sz * 2.4, sz * 2.4);
        ctx.fillStyle = rgbCss(accentRgb, alpha * 0.9);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(3, sz * 0.09), 0, Math.PI * 2);
        ctx.fill();
      } else if (tile.kind === "rift") {
        const cx = sx + sz / 2;
        const cy = sy + sz / 2;
        const pulse = 0.85 + Math.sin(timeSec * 2.6) * 0.15;
        const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, sz * 0.56);
        grad.addColorStop(0, "rgba(10, 14, 20, 0.95)");
        grad.addColorStop(0.55, rgbCss(inkRgb, alpha * 0.28));
        grad.addColorStop(1, rgbCss(accentRgb, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, sz * 0.56, 0, Math.PI * 2);
        ctx.fill();

        for (let ring = 0; ring < 3; ring++) {
          ctx.strokeStyle =
            ring === 0 ? rgbCss(accentRgb, alpha * 0.8) : rgbCss(inkRgb, alpha * (0.45 - ring * 0.12));
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          const rad = sz * (0.14 + ring * 0.11) * pulse;
          const a0 = timeSec * (ring % 2 === 0 ? 0.9 : -0.7) + ring * 1.4;
          ctx.arc(cx, cy, rad, a0, a0 + Math.PI * 1.45);
          ctx.stroke();
        }
      }

      // 境界干渉（アンカー保護域の古い領域と今の領域が衝突して滲んでいる帯）
      if (tile.bleedShock > 0.22) {
        ctx.strokeStyle = rgbCss(accentRgb, alpha * tile.bleedShock * 0.42);
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 2, y0 + 2, w - 4, w - 4);
      }

      // 忘却しかけのタイル・高温時の崩れた文字残滓（char-LM 由来）
      const temp = stateRef.current.temperature;
      const showGlyph = tile.memory < 0.66 || (temp > 1.32 && (tile.x * 11 + tile.y * 7) % 5 === 0);
      if (showGlyph && tile.kind !== "rift" && !tile.motif) {
        const gAlpha =
          tile.memory < 0.66
            ? Math.min(0.45, (0.66 - tile.memory) * 0.72) * alpha
            : Math.min(0.24, (temp - 1.32) * 0.45) * alpha;
        ctx.fillStyle = rgbCss(inkRgb, gAlpha);
        ctx.font = `500 ${Math.round(sz * 0.34)}px "Hiragino Maru Gothic ProN", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(tile.glyph, sx + sz / 2, sy + sz / 2);
      }
    };

    const render = (now: number) => {
      const s = stateRef.current;
      const timeSec = now / 1000;
      const cam = camRef.current;

      // 滑らかなカメラ＆プレイヤー補間
      const lerp = reducedMotionRef.current ? 1 : 0.18;
      cam.px += (s.player.x - cam.px) * lerp;
      cam.py += (s.player.y - cam.py) * lerp;
      cam.x += (s.player.x - cam.x) * (lerp * 0.75);
      cam.y += (s.player.y - cam.y) * (lerp * 0.75);
      cam.bumpX *= 0.76;
      cam.bumpY *= 0.76;
      cam.descendFlash = Math.max(0, cam.descendFlash - 0.028);

      ctx.save();
      ctx.scale(dpr, dpr);

      // 背景霧（現在の RNN 領域混合色）
      const fogRgb = blendDomainColors(s.domainWeights, "fog");
      const accentRgb = blendDomainColors(s.domainWeights, "accent");
      const inkRgb = blendDomainColors(s.domainWeights, "ink");
      ctx.fillStyle = rgbCss(fogRgb, 1);
      ctx.fillRect(0, 0, width, height);

      const tileSz = Math.max(36, Math.min(58, Math.min(width, height) / 10.6));
      const centerX = width / 2;
      const centerY = height / 2;
      const worldToScreen = (wx: number, wy: number) => ({
        x: centerX + (wx - cam.x) * tileSz,
        y: centerY + (wy - cam.y) * tileSz,
      });

      // 1. 記憶されているタイル群を描画
      for (const tile of s.tiles.values()) {
        const pos = worldToScreen(tile.x, tile.y);
        const sx = pos.x - tileSz / 2;
        const sy = pos.y - tileSz / 2;
        if (sx + tileSz < -tileSz || sx > width + tileSz || sy + tileSz < -tileSz || sy > height + tileSz) {
          continue;
        }
        const distFromPlayer = Math.hypot(tile.x - cam.px, tile.y - cam.py);
        const visionFade = Math.max(0, Math.min(1, 1 - (distFromPlayer - (VIEW_RADIUS - 1.6)) / 2.6));
        const alpha = Math.max(0.08, Math.min(1, tile.memory * visionFade));
        if (alpha <= 0.04) continue;
        drawTileDetail(tile, sx, sy, tileSz, s.tiles, timeSec, alpha);
      }

      // 2. 記憶のしおり（Anchor）の保護域と標
      for (const anchor of s.anchors) {
        const pos = worldToScreen(anchor.x, anchor.y);
        const boxW = (ANCHOR_RADIUS * 2 + 1) * tileSz;
        const bx = pos.x - boxW / 2;
        const by = pos.y - boxW / 2;
        ctx.save();
        ctx.strokeStyle = "rgba(207, 169, 96, 0.34)";
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(bx + 2, by + 2, boxW - 4, boxW - 4);
        ctx.setLineDash([]);

        // しおり中央の菱形標
        ctx.strokeStyle = "rgba(207, 169, 96, 0.9)";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y - tileSz * 0.24);
        ctx.lineTo(pos.x + tileSz * 0.2, pos.y);
        ctx.lineTo(pos.x, pos.y + tileSz * 0.24);
        ctx.lineTo(pos.x - tileSz * 0.2, pos.y);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }

      // 3. モチーフ描画（プロシージャル線画＋変質世代の二重環＋崩れた名前）
      for (const tile of s.tiles.values()) {
        if (!tile.motif) continue;
        const pos = worldToScreen(tile.x, tile.y);
        const dist = Math.hypot(tile.x - cam.px, tile.y - cam.py);
        const alpha = Math.max(0.15, Math.min(1, tile.memory * (1 - (dist - (VIEW_RADIUS - 1.4)) / 2.6)));
        if (alpha <= 0.08) continue;

        const isReunion = tile.motif.generation >= 2;
        const bob = reducedMotionRef.current ? 0 : Math.sin(timeSec * 2.1 + tile.x + tile.y) * 2.2;
        const my = pos.y + bob;
        const origAccent = DOMAIN_PALETTES[tile.motif.originDomain].accent;
        const curAccent = DOMAIN_PALETTES[tile.motif.domain].accent;

        // 背後の柔らかな光輪
        const halo = ctx.createRadialGradient(pos.x, my, 2, pos.x, my, tileSz * 0.62);
        halo.addColorStop(0, rgbCss(isReunion ? origAccent : curAccent, alpha * 0.34));
        halo.addColorStop(1, rgbCss(curAccent, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(pos.x, my, tileSz * 0.62, 0, Math.PI * 2);
        ctx.fill();

        if (isReunion) {
          ctx.strokeStyle = rgbCss(origAccent, alpha * 0.72);
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.arc(pos.x, my, tileSz * 0.38, 0, Math.PI * 2);
          ctx.stroke();
        }

        drawMotifGlyph(
          ctx,
          tile.motif.id,
          pos.x,
          my,
          tileSz * 0.32,
          rgbCss(inkRgb, alpha * 0.96),
          rgbCss(isReunion ? origAccent : curAccent, alpha * 0.75),
          timeSec,
        );

        // 崩れた名前と変質世代の小さなラベル
        if (dist <= 5.4) {
          const label =
            tile.motif.generation >= 2
              ? `${tile.motif.name} ${romanGeneration(tile.motif.generation)}`
              : tile.motif.name;
          ctx.font = `600 ${Math.max(10, Math.round(tileSz * 0.22))}px "Hiragino Maru Gothic ProN", sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = "rgba(10, 14, 20, 0.72)";
          const tw = ctx.measureText(label).width;
          ctx.fillRect(pos.x - tw / 2 - 4, my + tileSz * 0.36, tw + 8, Math.round(tileSz * 0.3));
          ctx.fillStyle = isReunion
            ? rgbCss(origAccent, alpha * 0.98)
            : rgbCss(inkRgb, alpha * 0.92);
          ctx.fillText(label, pos.x, my + tileSz * 0.38);
        }
      }

      // 4. 波紋エフェクト
      ripplesRef.current = ripplesRef.current.filter((rp) => {
        const t = (now - rp.startMs) / rp.durMs;
        if (t >= 1) return false;
        const pos = worldToScreen(rp.wx, rp.wy);
        const rad = (0.25 + rp.maxRadius * (1 - Math.pow(1 - t, 3))) * tileSz;
        ctx.save();
        ctx.globalAlpha = Math.max(0, (1 - t) * 0.75);
        ctx.strokeStyle = rp.color;
        ctx.lineWidth = 2 * (1 - t * 0.5);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, rad, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        return true;
      });

      // 5. プレイヤー（夢の中を歩く灯火）と残響コンパス弧
      const pPos = worldToScreen(cam.px + cam.bumpX, cam.py + cam.bumpY);
      const signal = findNearestSignal(s);
      if (signal) {
        const angle = Math.atan2(signal.dy, signal.dx);
        ctx.save();
        ctx.strokeStyle =
          signal.kind === "reunion"
            ? "rgba(218, 184, 110, 0.85)"
            : signal.kind === "rift"
              ? "rgba(164, 204, 220, 0.8)"
              : rgbCss(accentRgb, 0.52);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pPos.x, pPos.y, tileSz * 0.52, angle - 0.34, angle + 0.34);
        ctx.stroke();
        ctx.restore();
      }

      // プレイヤーの光輪と本体
      const pHalo = ctx.createRadialGradient(pPos.x, pPos.y, 2, pPos.x, pPos.y, tileSz * 1.4);
      pHalo.addColorStop(0, "rgba(238, 230, 210, 0.22)");
      pHalo.addColorStop(1, "rgba(238, 230, 210, 0)");
      ctx.fillStyle = pHalo;
      ctx.beginPath();
      ctx.arc(pPos.x, pPos.y, tileSz * 1.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#f0eadc";
      ctx.beginPath();
      ctx.arc(pPos.x, pPos.y, tileSz * 0.19, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = rgbCss(accentRgb, 0.85);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(pPos.x, pPos.y, tileSz * 0.28 + Math.sin(timeSec * 3.1) * 1.2, 0, Math.PI * 2);
      ctx.stroke();

      // 6. 舞い散る文字トークン粒子
      particlesRef.current = particlesRef.current.filter((pt) => {
        const t = (now - pt.startMs) / pt.durMs;
        if (t >= 1) return false;
        const elapsed = (now - pt.startMs) / 1000;
        const pos = worldToScreen(pt.wx + pt.vx * elapsed, pt.wy + pt.vy * elapsed);
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - t);
        ctx.fillStyle = pt.color;
        ctx.font = `600 ${Math.round(tileSz * 0.3)}px "Hiragino Maru Gothic ProN", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(pt.char, pos.x, pos.y);
        ctx.restore();
        return true;
      });

      // 7. 周辺ビネット（有限コンテキスト窓の境界を視覚的に包む）
      const vig = ctx.createRadialGradient(
        centerX,
        centerY,
        Math.min(width, height) * 0.26,
        centerX,
        centerY,
        Math.max(width, height) * 0.68,
      );
      vig.addColorStop(0, "rgba(0,0,0,0)");
      vig.addColorStop(1, rgbCss(fogRgb, 0.88));
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, width, height);

      // 8. 潜行時の静かなフェード幕
      if (cam.descendFlash > 0.01) {
        ctx.fillStyle = rgbCss(fogRgb, cam.descendFlash * 0.85);
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

  // 上位 2 つの滲み領域ラベルを整形
  const blendSummary = useMemo(() => {
    const ranked = [...DOMAIN_IDS]
      .map((id) => ({ id, pct: Math.round(state.domainWeights[id] * 100) }))
      .sort((a, b) => b.pct - a.pct);
    const top = ranked.filter((r) => r.pct >= 12).slice(0, 2);
    if (top.length === 0) return DOMAIN_PALETTES[state.dominantDomain].label;
    return top.map((r) => `${DOMAIN_PALETTES[r.id].label} ${r.pct}%`).join(" · ");
  }, [state.domainWeights, state.dominantDomain]);

  const discoveredCount = Math.max(state.discoveredMotifs.length, record.discoveredMotifs.length);
  const discoveredSet = useMemo(
    () => new Set<MotifId>([...record.discoveredMotifs, ...state.discoveredMotifs]),
    [record.discoveredMotifs, state.discoveredMotifs],
  );
  const maxDepthDisplay = Math.max(state.depth, record.maxDepth);

  return (
    <div className="dreaming-shell">
      <header className="dreaming-topbar">
        <div className="dreaming-topbar-left">
          <Link href={`${prefix}/games`} className="dreaming-back">
            ← ゲーム一覧
          </Link>
          <div className="dreaming-place">
            <span className="dreaming-place-name">{state.placeName}</span>
            <span className="dreaming-place-blend">{blendSummary}</span>
          </div>
        </div>

        <div className="dreaming-metrics" aria-label="夢の記録">
          <span className="dreaming-metric dreaming-metric-accent">
            <span>層</span>
            <strong>第{state.depth}層</strong>
            <span>(最深 {maxDepthDisplay})</span>
          </span>
          <span className="dreaming-metric">
            <span>標本</span>
            <strong>
              {discoveredCount}/{DREAM_MOTIFS.length}
            </strong>
          </span>
          <span className="dreaming-metric">
            <span>変質再会</span>
            <strong>{state.echoChain}</strong>
          </span>
          <span className="dreaming-metric">
            <span>忘却</span>
            <strong>{state.forgottenCount}</strong>
          </span>
        </div>

        <div className="dreaming-topbar-tools">
          <button
            type="button"
            className="dreaming-tool-btn"
            aria-pressed={showRnn}
            onClick={() => setShowRnn((v) => !v)}
          >
            隠れ状態
          </button>
          <button
            type="button"
            className="dreaming-tool-btn"
            aria-pressed={showArchive}
            onClick={() => setShowArchive((v) => !v)}
          >
            標本帳
          </button>
          <button
            type="button"
            className="dreaming-tool-btn"
            aria-pressed={!muted}
            onClick={toggleMute}
          >
            {muted ? "無音" : "音あり"}
          </button>
        </div>
      </header>

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

        {state.step < 6 && (
          <div className="dreaming-hint-pill">
            <strong>矢印 / WASD / スワイプ</strong>で歩く · 後ろの道はやがて忘れられ別の景色に変わる ·{" "}
            <strong>しおり</strong>で場所を留め、<strong>温度</strong>で夢の滲みを調律する
          </div>
        )}

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
                    ? rgbCss(DOMAIN_PALETTES[DOMAIN_IDS[i]].accent, 0.85)
                    : "rgba(180, 198, 208, 0.72)";
                return (
                  <div key={i} className="dreaming-rnn-bar-col">
                    <div
                      className="dreaming-rnn-bar"
                      style={{
                        height: `${Math.max(8, Math.round(mag * 100))}%`,
                        backgroundColor: color,
                        opacity: v >= 0 ? 0.95 : 0.35,
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
              <span>保持ゲート {Math.round(state.rnn.lastForgetMean * 100)}%</span>
              <span>残響 {state.echoQueue.length}</span>
            </div>
          </aside>
        )}

        {state.whisper && (
          <div key={`${state.whisper.step}-${state.whisper.text}`} className="dreaming-whisper" aria-live="polite">
            <div className="dreaming-whisper-text">{state.whisper.text}</div>
            {state.whisper.sub && <div className="dreaming-whisper-sub">{state.whisper.sub}</div>}
          </div>
        )}
      </div>

      <footer className="dreaming-controls">
        <label className="dreaming-temp-wrap">
          <span className="dreaming-temp-label">
            <span>温度 T ({temperatureLabel(state.temperature)})</span>
            <strong>{state.temperature.toFixed(2)}</strong>
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
        </label>

        <div className="dreaming-actions">
          <button
            type="button"
            className="dreaming-action-btn dreaming-action-primary"
            onClick={doPulse}
          >
            <span>共鳴 / 再想起</span>
            <span className="dreaming-kbd">Space</span>
          </button>
          <button type="button" className="dreaming-action-btn" onClick={doAnchor}>
            <span>記憶を留める</span>
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
        </div>
      </footer>

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
              <h2>夢の標本帳</h2>
              <button
                type="button"
                className="dreaming-tool-btn"
                onClick={() => setShowArchive(false)}
              >
                閉じる
              </button>
            </div>
            <div className="dreaming-drawer-body">
              <div className="dreaming-summary-grid">
                <div className="dreaming-summary-card">
                  <span>最深深度</span>
                  <strong>第{maxDepthDisplay}層</strong>
                </div>
                <div className="dreaming-summary-card">
                  <span>最深変質世代</span>
                  <strong>
                    {Math.max(state.maxGeneration, record.maxGeneration) > 0
                      ? `第${Math.max(state.maxGeneration, record.maxGeneration)}世代`
                      : "未観測"}
                  </strong>
                </div>
                <div className="dreaming-summary-card">
                  <span>累計歩数</span>
                  <strong>{record.totalSteps}</strong>
                </div>
                <div className="dreaming-summary-card">
                  <span>忘却した景色</span>
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
                        {found ? m.archetypeLabel : "？？？"}
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
                            {entry.generation >= 2
                              ? `第${entry.generation}変質`
                              : "原型"} · 第{entry.depth}層
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
              <button type="button" className="dreaming-tool-btn" onClick={doRedrift}>
                浅い層へ漂い直す
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
