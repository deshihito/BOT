"use client";
// 2048 方式のスライドパズル。ロジックは lib/slider2048.ts。
// 矢印キー・ボタン・スワイプで操作する。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  continueSlide,
  createSlideGame,
  moveSlide,
  type SlideDir,
  type SlideState,
} from "@/lib/slider2048";
import { useGamesNav } from "../GamesShell";

const KEY_DIRS: Record<string, SlideDir> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

export default function SliderClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<SlideState>(() => createSlideGame(Date.now() % 2147483647));
  const touchRef = useRef<{ x: number; y: number } | null>(null);

  const doMove = useCallback((dir: SlideDir) => {
    setState((s) => moveSlide(s, dir).state);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = KEY_DIRS[e.key];
      if (!dir) return;
      e.preventDefault();
      doMove(dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doMove]);

  const restart = () => setState(createSlideGame(Date.now() % 2147483647));

  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchRef.current;
    touchRef.current = null;
    if (!start) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    doMove(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");
  };

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>2048</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>2048</h1>
        <p className="muted">同じ数字をぶつけて大きくしていくスライドパズル。2048 のタイルを目指そう。</p>
      </div>

      <p className="classic-status" role="status">
        スコア {state.score} ・ {state.moves} 手
        {state.status === "won" ? " ・ 2048 達成！" : ""}
        {state.status === "lost" ? " ・ もう動けません" : ""}
      </p>

      <div
        className="slide-board"
        role="grid"
        aria-label="2048 の盤"
        onTouchStart={(e) => {
          const touch = e.touches[0];
          touchRef.current = { x: touch.clientX, y: touch.clientY };
        }}
        onTouchEnd={onTouchEnd}
      >
        {state.tiles.map((value, i) => (
          <div key={i} role="gridcell" className="slide-tile" data-v={value > 2048 ? "super" : String(value)}>
            {value > 0 ? value : ""}
          </div>
        ))}
      </div>

      {state.status === "won" ? (
        <p className="classic-status">
          2048 のタイルができました。
          <button type="button" className="classic-btn" onClick={() => setState((s) => continueSlide(s))}>
            このまま続ける
          </button>
        </p>
      ) : null}
      {state.status === "lost" ? (
        <p className="classic-status">詰んでしまいました。スコアは {state.score} でした。</p>
      ) : null}

      <div className="classic-controls" role="group" aria-label="移動ボタン">
        <button type="button" className="classic-btn" aria-label="左へ" onClick={() => doMove("left")}>←</button>
        <button type="button" className="classic-btn" aria-label="上へ" onClick={() => doMove("up")}>↑</button>
        <button type="button" className="classic-btn" aria-label="下へ" onClick={() => doMove("down")}>↓</button>
        <button type="button" className="classic-btn" aria-label="右へ" onClick={() => doMove("right")}>→</button>
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>
    </>
  );
}
