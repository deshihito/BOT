"use client";
// 倉庫番。ロジックは lib/sokoban.ts。箱を全部ゴールの上に運ぶ定番パズル。
// 十字ボタンとキーボード（矢印/WASD）で操作。1手戻し・最初から直し対応。
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  SOKOBAN_LEVELS,
  createSokobanGame,
  moveSokoban,
  undoSokoban,
  type SokobanDir,
  type SokobanState,
} from "@/lib/sokoban";
import { useGamesNav } from "../GamesShell";

function bestKey(level: number): string {
  return `ago-sokoban-best-${level}`;
}

export default function SokobanClient() {
  const { prefix } = useGamesNav();
  const [level, setLevel] = useState(0);
  const [state, setState] = useState<SokobanState>(() => createSokobanGame(0));
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(bestKey(level)));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, [level]);

  useEffect(() => {
    if (state.status !== "won") return;
    if (best !== null && state.moves >= best) return;
    setBest(state.moves);
    try {
      window.localStorage.setItem(bestKey(level), String(state.moves));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, state.moves, best, level]);

  const startLevel = useCallback((idx: number) => {
    setLevel(idx);
    setState(createSokobanGame(idx));
  }, []);

  const move = useCallback((dir: SokobanDir) => {
    setState((s) => moveSokoban(s, dir));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, SokobanDir> = {
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
        w: "up",
        s: "down",
        a: "left",
        d: "right",
      };
      const dir = map[e.key];
      if (dir) {
        e.preventDefault();
        move(dir);
      } else if (e.key === "z" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setState((s) => undoSokoban(s));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);

  const cellPx = Math.max(30, Math.min(52, Math.floor(340 / state.width) + 8));

  const renderCell = (i: number) => {
    const wall = state.walls[i];
    const goal = state.goals[i];
    const box = state.boxes.includes(i);
    const player = state.player === i;
    let bg = "#f3ead8";
    if (wall) bg = "#5b4a3a";
    else if (goal) bg = "#fde9c8";
    let content = "";
    if (box && goal) content = "✅";
    else if (box) content = "📦";
    else if (player) content = "🧍";
    else if (goal) content = "◎";
    return (
      <div
        key={i}
        aria-hidden="true"
        style={{
          width: cellPx,
          height: cellPx,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: bg,
          border: wall ? "1px solid #4a3a2d" : "1px solid #e0d3b8",
          borderRadius: wall ? 4 : 2,
          fontSize: cellPx * 0.52,
          lineHeight: 1,
          color: "#d97706",
          fontWeight: 800,
        }}
      >
        {content}
      </div>
    );
  };

  const padButton = (dir: SokobanDir, label: string) => (
    <button
      type="button"
      aria-label={label}
      onClick={() => move(dir)}
      style={{
        width: 60,
        height: 52,
        borderRadius: 10,
        border: "1px solid #d8c9a3",
        background: "#fffdf6",
        fontSize: 20,
        cursor: "pointer",
        touchAction: "manipulation",
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>倉庫番</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>倉庫番</h1>
        <p className="muted">下の十字ボタンかキーボードで移動し、箱を押して運びます。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="面の選択">
        {SOKOBAN_LEVELS.map((lv, i) => (
          <button
            key={lv.name}
            type="button"
            aria-pressed={level === i}
            className={level === i ? "classic-btn classic-btn-active" : "classic-btn"}
            onClick={() => startLevel(i)}
          >
            {lv.name}
          </button>
        ))}
        <button type="button" className="classic-btn" onClick={() => startLevel(level)}>
          もう一度
        </button>
        <button
          type="button"
          className="classic-btn"
          disabled={state.history.length === 0}
          onClick={() => setState((s) => undoSokoban(s))}
        >
          ↩ 1手戻す
        </button>
      </div>

      <p className="classic-status" role="status">
        {SOKOBAN_LEVELS[level].name} ・ {state.moves} 手（箱押し {state.pushes} 回）
        {best !== null ? ` ・ ベスト ${best} 手` : ""} ・{" "}
        {state.status === "won"
          ? "🎉 クリア！全部の箱がゴールの上にあります。"
          : "ゴール ◎ の上に箱を全部のせればクリア。"}
      </p>

      <div
        role="img"
        aria-label="倉庫番の盤面"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${state.width}, ${cellPx}px)`,
          gap: 2,
          justifyContent: "center",
          margin: "10px auto",
          maxWidth: "100%",
          overflowX: "auto",
          padding: 4,
        }}
      >
        {Array.from({ length: state.width * state.height }, (_, i) => renderCell(i))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 60px)",
          gridTemplateRows: "repeat(2, 52px)",
          gap: 6,
          justifyContent: "center",
          marginTop: 8,
        }}
        role="group"
        aria-label="移動ボタン"
      >
        <span />
        {padButton("up", "▲")}
        <span />
        {padButton("left", "◀")}
        {padButton("down", "▼")}
        {padButton("right", "▶")}
      </div>
      <p className="muted" style={{ textAlign: "center" }}>
        キーボードの矢印キー / WASD でも動けます（Ctrl+Z で1手戻し）。
      </p>

      {state.status === "won" && level + 1 < SOKOBAN_LEVELS.length ? (
        <p style={{ textAlign: "center" }}>
          <button type="button" className="classic-btn" onClick={() => startLevel(level + 1)}>
            次の面へ →
          </button>
        </p>
      ) : null}
    </>
  );
}
