"use client";
// スタッカー。ロジックは lib/stacker.ts。
// 左右に往復するブロックをタイミングよく止めて積み上げ、はみ出しは切り落とされる。
// ベスト段数は localStorage に保存する。サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const StackerScene3D = dynamic(() => import("./StackerScene3D"), { ssr: false });
import {
  advanceStacker,
  createStackerGame,
  dropStacker,
  stackerIntervalMs,
  type StackerState,
} from "@/lib/stacker";
import { sfxCorrect, sfxLose, sfxPlace } from "@/lib/sfx";
import { EndScreen, GoalBand } from "../GameJuice";
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
  const [webglFailed, setWebglFailed] = useState(false);
  const [best, setBest] = useState(0);
  const [prevBest, setPrevBest] = useState<number | null>(null);
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
    setPrevBest(prev);
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
    const cur = stateRef.current;
    if (cur.status !== "playing") return;
    const next = dropStacker(cur);
    if (next.status === "gameover") sfxLose();
    else if (next.lastPerfect) sfxCorrect();
    else sfxPlace();
    setState(next);
  }, []);

  // スペースキーでも落とせる（キーボード経路はこの window リスナ1本に統一する。
  // 盤面 div の onKeyDown を併用すると二重発火するため置かない）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (stateRef.current.status !== "playing") return;
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
        className={!ghost && level === state.rows.length - 1 ? "juice-pop" : undefined}
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

  // 2D 盤面（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
    <div
      role="button"
      aria-label="ブロックを止める"
      tabIndex={0}
      onClick={drop}
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
        <span key={state.score} className="juice-pulse" style={{ display: "inline-block" }}>{state.score}</span> 段 ・ ベスト {Math.max(best, state.score)} 段
        {state.lastPerfect && state.status === "playing" ? <span className="juice-pulse" style={{ display: "inline-block" }}> ・ ぴったり！</span> : ""}
        {state.status === "gameover" ? ` ・ 重ならず落下… ${state.score} 段で終了です。` : ""}
      </p>
      <div style={{ maxWidth: 420, margin: "8px auto 0" }}>
        <GoalBand current={state.score} best={prevBest ?? best} unit=" 段" />
      </div>

      {webglFailed ? board2d : (
        <div style={{ maxWidth: 520, margin: "0 auto" }}>
          <StackerScene3D
            rows={state.rows}
            currentStart={state.currentStart}
            currentWidth={state.currentWidth}
            boardWidth={state.boardWidth}
            status={state.status}
            lastPerfect={state.lastPerfect}
            onDrop={drop}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      {state.status === "gameover" && (
        <div style={{ maxWidth: 520, margin: "14px auto 0" }}>
          <EndScreen
            outcome="finish"
            title="落下… ゲームオーバー"
            score={state.score}
            scoreLabel="積んだ段数"
            newBest={prevBest !== null && state.score > prevBest}
            previousBest={prevBest}
            onRetry={restart}
          />
        </div>
      )}

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
