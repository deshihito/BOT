"use client";
// 15パズル。ロジックは lib/fifteen.ts（解可能性を保証するシャッフル）。
// 空白と同じ行・列のタイルをタップするとまとめてスライドする。端末内で完結。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  canSlide,
  createFifteenGame,
  slideTile,
  type FifteenSize,
  type FifteenState,
} from "@/lib/fifteen";
import { sfxSlide, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const SIZES: { key: FifteenSize; label: string }[] = [
  { key: 3, label: "3×3" },
  { key: 4, label: "4×4" },
  { key: 5, label: "5×5" },
];

function newGame(size: FifteenSize): FifteenState {
  return createFifteenGame(size, Date.now() % 2147483647);
}

function formatTime(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function FifteenClient() {
  const { prefix } = useGamesNav();
  const [size, setSize] = useState<FifteenSize>(4);
  const [state, setState] = useState<FifteenState>(() => newGame(4));
  const [seconds, setSeconds] = useState(0);
  const prevStatusRef = useRef(state.status);

  // 終局遷移の瞬間だけジングルを鳴らす。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev !== state.status && state.status === "won") sfxWin();
  }, [state.status]);

  useEffect(() => {
    if (state.status === "won") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  const handleTile = (i: number) => {
    if (!canSlide(state, i)) {
      sfxWrong();
      return;
    }
    const next = slideTile(state, i);
    if (next.status !== "won") sfxSlide();
    setState(next);
  };

  const restart = (nextSize: FifteenSize) => {
    setSize(nextSize);
    setState(newGame(nextSize));
    setSeconds(0);
  };

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>15パズル</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>15パズル</h1>
        <p className="muted">タイルをスライドさせて 1 から順番に並べる定番パズル。空白と同じ行・列ならまとめて動かせます。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="盤のサイズ">
        {SIZES.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-pressed={size === s.key}
            className={size === s.key ? "classic-btn classic-btn-active" : "classic-btn"}
            onClick={() => restart(s.key)}
          >
            {s.label}
          </button>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(size)}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {state.moves} 手 ・ ⏱ {formatTime(seconds)}
        {state.status === "won"
          ? ` ・ 完成！ ${state.moves} 手でクリアです。`
          : " ・ 空白の近くや同じ行・列のタイルをタップしてください。"}
      </p>

      <div
        role="grid"
        aria-label="15パズルの盤"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))`,
          gap: 6,
          maxWidth: 420,
          width: "100%",
        }}
      >
        {state.tiles.map((value, i) => {
          const isBlank = value === 0;
          const correctPos = value !== 0 && value === i + 1;
          const movable = !isBlank && canSlide(state, i);
          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              disabled={isBlank}
              aria-label={isBlank ? "空白" : `タイル ${value}`}
              onClick={() => handleTile(i)}
              style={{
                aspectRatio: "1",
                minHeight: 52,
                borderRadius: 10,
                border: isBlank ? "2px dashed #cbd5e1" : "1px solid #94a3b8",
                background: isBlank ? "#f8fafc" : correctPos ? "#dcfce7" : "#fff",
                color: "#1e293b",
                fontSize: "clamp(18px, 6vw, 28px)",
                fontWeight: 700,
                cursor: isBlank ? "default" : movable ? "pointer" : "default",
                opacity: isBlank ? 0.6 : 1,
              }}
            >
              {isBlank ? "" : value}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 4, marginTop: 14, flexWrap: "wrap" }} aria-hidden="true">
        {Array.from({ length: size * size - 1 }, (_, i) => i + 1).map((n) => (
          <span
            key={n}
            style={{
              fontSize: 11,
              color: "#94a3b8",
              border: "1px solid #e2e8f0",
              borderRadius: 4,
              padding: "1px 5px",
              background: state.tiles[n - 1] === n ? "#f0fdf4" : "#fff",
            }}
          >
            {n}
          </span>
        ))}
        <span style={{ fontSize: 11, color: "#94a3b8" }}>← 完成形の並び</span>
      </div>

      {state.status === "won" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen outcome="win" title="完成！" score={state.moves} scoreLabel="手数" onRetry={() => restart(size)}>
            <p className="muted">
              {size}×{size} の盤を {formatTime(seconds)} でそろえました。
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
