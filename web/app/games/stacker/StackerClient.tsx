"use client";
// スタッカー。ロジックは lib/stacker.ts。
// 左右に往復するブロックをタイミングよく止めて積み上げ、はみ出しは切り落とされる。
// ベスト段数は localStorage に保存する。サーバーへ送信しない。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  advanceStacker,
  createStackerGame,
  dropStacker,
  stackerIntervalMs,
  type StackerState,
} from "@/lib/stacker";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-stacker-best";
const VISIBLE_ROWS = 12;
const ROW_COLORS = ["#e86a5e", "#ef9234", "#f2c230", "#5cb85c", "#3f9db8", "#5e7fe8", "#9a5ee8", "#e85ea8"];

function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export default function StackerClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<StackerState>(() => createStackerGame());
  const [best, setBest] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    setBest(loadBest());
  }, []);

  // ブロックの自動移動（段数に応じて速くなる）
  useEffect(() => {
    if (state.status !== "playing") return;
    const id = window.setInterval(() => {
      setState((s) => advanceStacker(s));
    }, stackerIntervalMs(state.score));
    return () => window.clearInterval(id);
  }, [state.status, state.score]);

  // ベスト保存
  useEffect(() => {
    if (state.status !== "gameover") return;
    const prev = loadBest();
    if (state.score > prev) {
      setBest(state.score);
      try {
        localStorage.setItem(BEST_KEY, String(state.score));
      } catch {
        /* 保存できなくても遊べる */
      }
    }
  }, [state.status, state.score]);

  const drop = useCallback(() => {
    setState((s) => dropStacker(s));
  }, []);

  // スペースキーでも落とせる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowDown") {
        e.preventDefault();
        drop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drop]);

  const restart = () => setState(createStackerGame());

  // 表示行: 積み上がった段 + 現在のブロック行を下から VISIBLE_ROWS 行まで
  const totalRows = state.rows.length + (state.status === "playing" ? 1 : 0);
  const startLevel = Math.max(0, totalRows - VISIBLE_ROWS);
  const levels: number[] = [];
  for (let lv = Math.min(totalRows, VISIBLE_ROWS) - 1; lv >= 0; lv--) levels.push(startLevel + lv);

  const cell = 40;
  const boardWidthPx = state.boardWidth * cell;

  const renderRow = (start: number, width: number, level: number, ghost: boolean) => (
    <div key={level} style={{ position: "relative", height: cell, width: boardWidthPx }}>
      <div
        style={{
          position: "absolute",
          left: start * cell,
          top: 2,
          width: width * cell - 4,
          height: cell - 4,
          borderRadius: 6,
          background: ROW_COLORS[level % ROW_COLORS.length],
          opacity: ghost ? 0.95 : 1,
          boxShadow: "inset 0 -3px 0 rgba(0,0,0,0.18)",
        }}
      />
    </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>スタッカー</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>スタッカー</h1>
        <p className="muted">
          左右に動くブロックをタイミングよく止めて積み上げるゲーム。
          はみ出した部分は切り落とされてだんだん細くなります。タップ／クリック／スペースで止めます。
        </p>
      </div>

      <p className="classic-status" role="status">
        {state.score} 段 ・ ベスト {Math.max(best, state.score)} 段
        {state.lastPerfect && state.status === "playing" ? " ・ ぴったり！" : ""}
        {state.status === "gameover" ? ` ・ 重ならず落下… ${state.score} 段で終了です。` : ""}
      </p>

      <div
        role="button"
        aria-label="ブロックを止める"
        tabIndex={0}
        onClick={drop}
        onKeyDown={(e) => {
          if (e.code === "Space") {
            e.preventDefault();
            drop();
          }
        }}
        style={{
          width: boardWidthPx,
          maxWidth: "92vw",
          margin: "0 auto",
          border: "2px solid #3a4560",
          borderRadius: 10,
          background: "linear-gradient(#141b2e, #1d2740)",
          padding: "8px 0",
          cursor: state.status === "playing" ? "pointer" : "default",
          touchAction: "manipulation",
          userSelect: "none",
        }}
      >
        {levels.map((level) => {
          if (level === state.rows.length && state.status === "playing") {
            return renderRow(state.currentStart, state.currentWidth, level, true);
          }
          const row = state.rows[level];
          return row ? renderRow(row.start, row.width, level, false) : null;
        })}
        {levels.length === 0 && <div style={{ height: cell }} />}
      </div>

      <div className="classic-controls" style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
        {state.status === "playing" ? (
          <button
            type="button"
            onClick={drop}
            style={{
              padding: "12px 28px",
              borderRadius: 999,
              border: "1px solid #8a90a3",
              background: "#22304f",
              color: "#fff",
              fontSize: 17,
              fontWeight: 700,
              cursor: "pointer",
              minHeight: 48,
            }}
          >
            止める
          </button>
        ) : (
          <button
            type="button"
            onClick={restart}
            style={{
              padding: "12px 28px",
              borderRadius: 999,
              border: "1px solid #8a90a3",
              background: "#22304f",
              color: "#fff",
              fontSize: 17,
              fontWeight: 700,
              cursor: "pointer",
              minHeight: 48,
            }}
          >
            もう一度
          </button>
        )}
      </div>
    </>
  );
}
