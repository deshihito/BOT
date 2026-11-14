"use client";
// フラッドフィル。ロジックは lib/floodit.ts。
// 左上の領域と同じ色を広げていき、制限手数以内に盤全体を1色にする。
// 制限手数は生成時の貪欲解 + 8手なので、必ず解ける。端末内で完結する。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const FloodItScene3D = dynamic(() => import("./FloodItScene3D"), { ssr: false });
import {
  applyFloodMove,
  createFloodGame,
  floodRegionIndices,
  type FloodState,
} from "@/lib/floodit";
import { sfxLose, sfxPlace, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
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
  const [webglFailed, setWebglFailed] = useState(false);
  const [state, setState] = useState<FloodState>(() => createFloodGame(Date.now() % 2147483647));
  const [best, setBest] = useState<number | null>(null);
  const [resultNewBest, setResultNewBest] = useState(false);
  const [resultPrevBest, setResultPrevBest] = useState<number | null>(null);
  const prevStatusRef = useRef(state.status);

  // 終局遷移の瞬間だけジングルを鳴らし、その時点（保存前）のベストで更新判定を控える。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev === state.status) return;
    if (state.status === "won") {
      const isNew = best === null || state.movesUsed < best;
      setResultNewBest(isNew);
      setResultPrevBest(isNew ? null : best);
      sfxWin();
    } else if (state.status === "lost") {
      setResultNewBest(false);
      setResultPrevBest(best);
      sfxLose();
    }
  }, [state.status, state.movesUsed, best]);

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

  const restart = () => {
    setState(createFloodGame(Date.now() % 2147483647));
    setResultNewBest(false);
    setResultPrevBest(null);
  };

  const region = useMemo(() => new Set(floodRegionIndices(state.cells, state.size)), [state]);
  const regionColor = state.cells[0];
  const remaining = state.maxMoves - state.movesUsed;

  // 色を選ぶ現行ハンドラ。DOM パレットと 3D 盤タップの両方がここへ接続する。
  const pickColor = (color: number) => {
    if (state.status !== "playing" || color === regionColor) return;
    sfxPlace();
    setState((s) => applyFloodMove(s, color));
  };

  // 3D 盤のタップ = そのマスの色を選ぶ（判定は applyFloodMove が担う）。
  const handleCellTap = (index: number) => {
    const color = state.cells[index];
    if (color !== undefined) pickColor(color);
  };

  const statusText =
    state.status === "won"
      ? `全面そろえた！ ${state.movesUsed} 手でクリアです。`
      : state.status === "lost"
        ? "手数を使い切りました。もう一度挑戦してみよう。"
        : "左上の領域とつながったマスが、選んだ色に広がります。";

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
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
            className={region.has(i) ? "juice-pop" : undefined}
            style={{
              aspectRatio: "1",
              borderRadius: 3,
              background: COLOR_DEFS[color].hex,
              boxShadow: region.has(i) ? "inset 0 0 0 2px rgba(255,255,255,0.65)" : undefined,
            }}
          />
        ))}
      </div>
  );

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
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        手数 {state.movesUsed} / {state.maxMoves}（残り {Math.max(0, remaining)}）・ 目安 {state.parMoves} 手
        {best !== null ? ` ・ ベスト ${best} 手` : ""} ・ {statusText}
      </p>

      {webglFailed ? board2d : (
        <div style={{ width: "100%", maxWidth: 480, margin: "0 auto" }}>
          <FloodItScene3D
            cells={state.cells}
            size={state.size}
            region={region}
            onCell={handleCellTap}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

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
              onClick={() => pickColor(color)}
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
        つながっている領域は、2Dでは白い枠、3Dでは高いタイルで示されます。隣の色を取り込むように選ぶのがコツ。
      </p>

      {state.status !== "playing" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen
            outcome={state.status === "won" ? "win" : "lose"}
            score={state.movesUsed}
            scoreLabel="手数"
            newBest={resultNewBest}
            previousBest={resultPrevBest}
            onRetry={restart}
          >
            <p className="muted">
              目安 {state.parMoves} 手 ・ 制限 {state.maxMoves} 手中 {state.movesUsed} 手使いました。
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
