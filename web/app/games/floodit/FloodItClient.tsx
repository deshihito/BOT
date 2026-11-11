"use client";
// フラッドフィル。ロジックは lib/floodit.ts。
// 左上の領域と同じ色を広げていき、制限手数以内に盤全体を1色にする。
// 制限手数は生成時の貪欲解 + 8手なので、必ず解ける。端末内で完結する。
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  applyFloodMove,
  createFloodGame,
  floodRegionIndices,
  type FloodState,
} from "@/lib/floodit";
import { useGamesNav } from "../GamesShell";

const COLOR_DEFS = [
  { hex: "#ef4444", name: "赤" },
  { hex: "#f59e0b", name: "オレンジ" },
  { hex: "#eab308", name: "黄色" },
  { hex: "#22c55e", name: "緑" },
  { hex: "#3b82f6", name: "青" },
  { hex: "#a855f7", name: "紫" },
];

const BEST_KEY = "ago-floodit-best";

export default function FloodItClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<FloodState>(() => createFloodGame(Date.now() % 2147483647));
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  useEffect(() => {
    if (state.status !== "won") return;
    setBest((prev) => {
      if (prev !== null && prev <= state.movesUsed) return prev;
      try {
        window.localStorage.setItem(BEST_KEY, String(state.movesUsed));
      } catch {
        // 保存失敗はプレイに影響しない。
      }
      return state.movesUsed;
    });
  }, [state.status, state.movesUsed]);

  const region = useMemo(() => new Set(floodRegionIndices(state.cells, state.size)), [state]);
  const regionColor = state.cells[0];
  const remaining = state.maxMoves - state.movesUsed;

  const statusText =
    state.status === "won"
      ? `全面そろえた！ ${state.movesUsed} 手でクリアです。`
      : state.status === "lost"
        ? "手数を使い切りました。もう一度挑戦してみよう。"
        : "左上の領域とつながったマスが、選んだ色に広がります。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>フラッドフィル</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>フラッドフィル</h1>
        <p className="muted">左上の領域をタップした色に染め替えながら広げていくパズル。</p>
      </div>

      <div className="classic-controls">
        <button
          type="button"
          className="classic-btn"
          onClick={() => setState(createFloodGame(Date.now() % 2147483647))}
        >
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        手数 {state.movesUsed} / {state.maxMoves}（残り {Math.max(0, remaining)}）・ 目安 {state.parMoves} 手
        {best !== null ? ` ・ ベスト ${best} 手` : ""} ・ {statusText}
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${state.size}, minmax(0, 1fr))`,
          gap: 2,
          maxWidth: 480,
          margin: "0 auto",
        }}
        role="img"
        aria-label="フラッドフィルの盤面"
      >
        {state.cells.map((color, i) => (
          <div
            key={i}
            style={{
              aspectRatio: "1",
              borderRadius: 3,
              background: COLOR_DEFS[color].hex,
              boxShadow: region.has(i) ? "inset 0 0 0 2px rgba(255,255,255,0.65)" : undefined,
            }}
          />
        ))}
      </div>

      <div
        style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16, flexWrap: "wrap" }}
        role="group"
        aria-label="色の選択"
      >
        {COLOR_DEFS.slice(0, state.colorCount).map((def, color) => {
          const isCurrent = color === regionColor;
          return (
            <button
              key={color}
              type="button"
              aria-label={def.name}
              aria-pressed={isCurrent}
              disabled={state.status !== "playing" || isCurrent}
              onClick={() => setState((s) => applyFloodMove(s, color))}
              style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                border: `3px solid ${isCurrent ? "#4b4237" : "transparent"}`,
                background: def.hex,
                cursor: state.status === "playing" && !isCurrent ? "pointer" : "default",
                opacity: state.status !== "playing" ? 0.5 : 1,
                touchAction: "manipulation",
              }}
            />
          );
        })}
      </div>
      <p className="og-muted" style={{ textAlign: "center" }}>
        白い枠が今つながっている領域です。隣の色を取り込むように選ぶのがコツ。
      </p>
    </>
  );
}
