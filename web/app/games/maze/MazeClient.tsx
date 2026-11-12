"use client";
// めいろ。ロジックは lib/maze.ts（完全迷路を生成し、最短路も lib で求める）。
// 矢印キー／WASD／画面ボタンで移動。ヒントで最短路のマスをうっすら光らせる。端末内で完結。
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createMazeGame,
  movePlayer,
  MAZE_SIZES,
  type MazeDir,
  type MazeSizeKey,
  type MazeState,
} from "@/lib/maze";
import { sfxSlide, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const SIZE_KEYS: MazeSizeKey[] = ["small", "medium", "large"];

function newGame(size: MazeSizeKey): MazeState {
  return createMazeGame(size, Date.now() % 2147483647);
}

function formatTime(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const KEY_TO_DIR: Record<string, MazeDir> = {
  ArrowUp: "up",
  ArrowRight: "right",
  ArrowDown: "down",
  ArrowLeft: "left",
  w: "up",
  d: "right",
  s: "down",
  a: "left",
  W: "up",
  D: "right",
  S: "down",
  A: "left",
};

export default function MazeClient() {
  const { prefix } = useGamesNav();
  const [size, setSize] = useState<MazeSizeKey>("medium");
  const [state, setState] = useState<MazeState>(() => newGame("medium"));
  const [showHint, setShowHint] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const prevStatusRef = useRef(state.status);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

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

  const doMove = (dir: MazeDir) => {
    const current = stateRef.current;
    const next = movePlayer(current, dir);
    if (next === current) return;
    if (next.status !== "won") sfxSlide();
    setState(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = KEY_TO_DIR[e.key];
      if (!dir) return;
      e.preventDefault();
      doMove(dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // doMove は stateRef 経由で最新状態を読むため、登録は初回のみでよい。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restart = (next: MazeSizeKey) => {
    setSize(next);
    setState(newGame(next));
    setSeconds(0);
    setShowHint(false);
  };

  const hintSet = useMemo(() => new Set(state.solution), [state.solution]);
  const maxWidth = Math.min(560, state.cols * 34);

  const padBtn: React.CSSProperties = {
    width: 52,
    height: 52,
    fontSize: 20,
    borderRadius: 10,
    border: "1px solid var(--line)",
    background: "#fff",
    color: "var(--text)",
    cursor: "pointer",
  };

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>めいろ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>めいろ</h1>
        <p className="muted">スタートからゴールまでの道を探す完全迷路。行き止まりは必ずどこかにつながっています。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="迷路のサイズ">
        {SIZE_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={size === key}
            className={size === key ? "classic-btn classic-btn-active" : "classic-btn"}
            onClick={() => restart(key)}
          >
            {MAZE_SIZES[key].label}（{MAZE_SIZES[key].cols}×{MAZE_SIZES[key].rows}）
          </button>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(size)}>
          もう一度
        </button>
        <button
          type="button"
          aria-pressed={showHint}
          className={showHint ? "classic-btn classic-btn-active" : "classic-btn"}
          onClick={() => setShowHint((v) => !v)}
        >
          最短路ヒント
        </button>
      </div>

      <p className="classic-status" role="status">
        {state.moves} 手 ・ ⏱ {formatTime(seconds)}
        {state.status === "won"
          ? ` ・ ゴール！ ${state.moves} 手 / 最短 ${state.solution.length - 1} 手でした。`
          : showHint
            ? " ・ 光っているマスが最短路です。"
            : ""}
      </p>

      <div
        role="grid"
        aria-label="迷路の盤"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${state.cols}, minmax(0, 1fr))`,
          width: "100%",
          maxWidth,
          border: "2px solid var(--text)",
          background: "#fff",
        }}
      >
        {state.walls.map((bits, i) => {
          const isPlayer = i === state.player;
          const isGoal = i === state.goal;
          const onHint = showHint && hintSet.has(i);
          return (
            <div
              key={i}
              role="gridcell"
              className={isPlayer ? "juice-pop" : undefined}
              aria-label={isPlayer ? "現在位置" : isGoal ? "ゴール" : undefined}
              style={{
                aspectRatio: "1",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: `clamp(9px, ${Math.round(340 / state.cols)}px, 20px)`,
                borderTop: bits & 1 ? "2px solid var(--text)" : "2px solid transparent",
                borderRight: bits & 2 ? "2px solid var(--text)" : "2px solid transparent",
                borderBottom: bits & 4 ? "2px solid var(--text)" : "2px solid transparent",
                borderLeft: bits & 8 ? "2px solid var(--text)" : "2px solid transparent",
                background: isPlayer
                  ? "var(--accent-soft)"
                  : onHint
                    ? "#fdf3c7"
                    : isGoal
                      ? "#e6f6e6"
                      : "transparent",
              }}
            >
              {isPlayer ? <span style={{ color: "#1565c0" }}>●</span> : isGoal ? <span style={{ color: "#2e7d32" }}>◎</span> : ""}
            </div>
          );
        })}
      </div>

      <div
        aria-label="移動ボタン"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 52px)",
          gridTemplateRows: "repeat(2, 52px)",
          gap: 6,
          marginTop: 16,
        }}
      >
        <span />
        <button type="button" style={padBtn} aria-label="上へ" onClick={() => doMove("up")}>
          ↑
        </button>
        <span />
        <button type="button" style={padBtn} aria-label="左へ" onClick={() => doMove("left")}>
          ←
        </button>
        <button type="button" style={padBtn} aria-label="下へ" onClick={() => doMove("down")}>
          ↓
        </button>
        <button type="button" style={padBtn} aria-label="右へ" onClick={() => doMove("right")}>
          →
        </button>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
        矢印キー・WASD でも動けます。
      </p>

      {state.status === "won" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen outcome="win" title="ゴール！" score={state.moves} scoreLabel="手数" onRetry={() => restart(size)}>
            <p className="muted">
              最短 {state.solution.length - 1} 手のところを {state.moves} 手・{formatTime(seconds)} でゴールしました。
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
