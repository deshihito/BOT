"use client";
// マインスイーパー。ロジックは lib/minesweeper.ts（初手は必ず安全）。
// タップで開く／旗モードか右クリックで旗を立てる。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  createMsGame,
  revealCell,
  toggleFlag,
  type MsState,
} from "@/lib/minesweeper";
import { useGamesNav } from "../GamesShell";

const LEVELS = [
  { key: "easy", label: "かんたん", rows: 9, cols: 9, mines: 10 },
  { key: "normal", label: "ふつう", rows: 12, cols: 12, mines: 26 },
  { key: "hard", label: "むずかしい", rows: 12, cols: 16, mines: 40 },
] as const;

type LevelKey = (typeof LEVELS)[number]["key"];

function newGame(levelKey: LevelKey): MsState {
  const level = LEVELS.find((l) => l.key === levelKey) ?? LEVELS[0];
  return createMsGame(level.rows, level.cols, level.mines, Date.now() % 2147483647);
}

export default function MinesweeperClient() {
  const { prefix } = useGamesNav();
  const [levelKey, setLevelKey] = useState<LevelKey>("easy");
  const [state, setState] = useState<MsState>(() => newGame("easy"));
  const [flagMode, setFlagMode] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  const restart = (key: LevelKey) => {
    setLevelKey(key);
    setState(newGame(key));
    setSeconds(0);
    setFlagMode(false);
  };

  const onCell = (index: number) => {
    if (flagMode) {
      setState((s) => toggleFlag(s, index));
    } else {
      setState((s) => revealCell(s, index));
    }
  };

  const statusText =
    state.status === "won"
      ? "全部開けた！クリアです。"
      : state.status === "lost"
        ? "地雷を踏んでしまいました。"
        : state.status === "ready"
          ? "マスを選んでスタート。最初のマスは必ず安全です。"
          : "地雷を避けてマスを開けていこう。数字は周囲の地雷の数です。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>マインスイーパー</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>マインスイーパー</h1>
        <p className="muted">地雷を避けてマスを全部開く定番パズル。旗モードならスマホでも旗が立てられます。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="難易度">
        {LEVELS.map((level) => (
          <button
            key={level.key}
            type="button"
            aria-pressed={levelKey === level.key}
            className={levelKey === level.key ? "classic-btn classic-btn-active" : "classic-btn"}
            onClick={() => restart(level.key)}
          >
            {level.label}
          </button>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(levelKey)}>
          もう一度
        </button>
        <button
          type="button"
          aria-pressed={flagMode}
          className={flagMode ? "classic-btn classic-btn-active" : "classic-btn"}
          onClick={() => setFlagMode((v) => !v)}
        >
          🚩 旗モード
        </button>
      </div>

      <p className="classic-status" role="status">
        残りの地雷 {state.mineTotal - state.flags} ・ {seconds} 秒 ・ {statusText}
      </p>

      <div
        className="ms-board"
        style={{ gridTemplateColumns: `repeat(${state.cols}, minmax(0, 1fr))` }}
        role="grid"
        aria-label="マインスイーパーの盤"
      >
        {state.cells.map((cell, i) => {
          const classes = [
            "ms-cell",
            cell.open ? "ms-cell-open" : "",
            cell.open && cell.mine ? "ms-cell-mine" : "",
            state.exploded === i ? "ms-cell-exploded" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              className={classes}
              aria-label={
                cell.open
                  ? cell.mine
                    ? "地雷"
                    : `周囲の地雷 ${cell.count}`
                  : cell.flagged
                    ? "旗"
                    : "閉じたマス"
              }
              onClick={() => onCell(i)}
              onContextMenu={(e) => {
                e.preventDefault();
                setState((s) => toggleFlag(s, i));
              }}
            >
              {cell.open ? (cell.mine ? "💣" : cell.count > 0 ? cell.count : "") : cell.flagged ? "🚩" : ""}
            </button>
          );
        })}
      </div>
    </>
  );
}
