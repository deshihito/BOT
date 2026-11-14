"use client";
// マインスイーパー。ロジックは lib/minesweeper.ts（初手は必ず安全）。
// タップで開く／旗モードか右クリックで旗を立てる。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const MinesweeperScene3D = dynamic(() => import("./MinesweeperScene3D"), { ssr: false });
import {
  chordCell,
  createMsGame,
  revealCell,
  toggleFlag,
  type MsState,
} from "@/lib/minesweeper";
import { sfxFlip, sfxLose, sfxPlace, sfxTap, sfxWin } from "@/lib/sfx";
import { tappableProps } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
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

/** 地雷を SVG で描く（絵文字は使わない）。 */
function MineIcon() {
  return (
    <svg viewBox="0 0 24 24" width="78%" height="78%" aria-hidden style={{ display: "block", margin: "0 auto" }}>
      <g stroke="#212121" strokeWidth="1.8" strokeLinecap="round">
        <path d="M12 2.5v19M2.5 12h19M5.3 5.3l13.4 13.4M18.7 5.3L5.3 18.7" />
      </g>
      <circle cx="12" cy="12" r="6.4" fill="#212121" />
      <circle cx="9.8" cy="9.6" r="1.7" fill="#e0e0e0" />
    </svg>
  );
}

/** 旗を SVG で描く（絵文字は使わない）。 */
function FlagIcon() {
  return (
    <svg viewBox="0 0 24 24" width="78%" height="78%" aria-hidden style={{ display: "block", margin: "0 auto" }}>
      <path d="M6 22V3.5" stroke="#5d4037" strokeWidth="2" strokeLinecap="round" />
      <path d="M6 4c3-1.8 5.5 1.6 9 .4v7.2c-3.5 1.2-6-2.2-9-.4Z" fill="#e53935" />
    </svg>
  );
}

export default function MinesweeperClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [levelKey, setLevelKey] = useState<LevelKey>("easy");
  const [state, setState] = useState<MsState>(() => newGame("easy"));
  const [flagMode, setFlagMode] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(`ago-minesweeper-best-${levelKey}`));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, [levelKey]);

  useEffect(() => {
    if (state.status !== "won" || seconds <= 0) return;
    if (best !== null && seconds >= best) return;
    setBest(seconds);
    try {
      window.localStorage.setItem(`ago-minesweeper-best-${levelKey}`, String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best, levelKey]);

  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev === state.status) return;
    if (state.status === "won") sfxWin();
    else if (state.status === "lost") sfxLose();
  }, [state.status]);

  const restart = (key: LevelKey) => {
    setLevelKey(key);
    setState(newGame(key));
    setSeconds(0);
    setFlagMode(false);
  };

  const toggleFlagWithSound = (index: number) => {
    const cell = state.cells[index];
    if (!cell || cell.open || state.status === "won" || state.status === "lost") return;
    if (cell.flagged) sfxTap();
    else sfxPlace();
    setState((s) => toggleFlag(s, index));
  };

  const onCell = (index: number) => {
    if (flagMode) {
      toggleFlagWithSound(index);
      return;
    }
    const cell = state.cells[index];
    // 開いた数字マスの再タップはコード入力（周囲の旗が合っていれば一括開放）。
    const next = cell?.open ? chordCell(state, index) : revealCell(state, index);
    if (next === state) return;
    // 終局時は終局ジングルに任せ、二重に鳴らさない。
    if (next.status !== "won" && next.status !== "lost") sfxFlip();
    setState(next);
  };

  const statusText =
    state.status === "won"
      ? "全部開けた！クリアです。"
      : state.status === "lost"
        ? "地雷を踏んでしまいました。"
        : state.status === "ready"
          ? "マスを選んでスタート。最初のマスは必ず安全です。"
          : "地雷を避けてマスを開けていこう。数字は周囲の地雷の数です。";

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
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
          cell.open ? "juice-flip" : "",
          state.exploded === i ? "juice-shake" : "",
          !cell.open && cell.flagged ? "juice-pop" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div
            key={i}
            role="gridcell"
            tabIndex={0}
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
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onCell(i);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              toggleFlagWithSound(i);
            }}
          >
            {cell.open ? (cell.mine ? <MineIcon /> : cell.count > 0 ? cell.count : "") : cell.flagged ? <FlagIcon /> : ""}
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>マインスイーパー</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>マインスイーパー</h1>
        <p className="muted">地雷を避けてマスを全部開く定番パズル。盤面は推測なしで最後まで解けるよう生成しています。開いた数字マスをもう一度タップすると、周囲の旗の数が合っているときに残りのマスをまとめて開けます。旗モードならスマホでも旗が立てられます。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="難易度">
        {LEVELS.map((level) => (
          <div
            key={level.key}
            {...tappableProps(() => restart(level.key))}
            aria-pressed={levelKey === level.key}
            className={levelKey === level.key ? "classic-btn classic-btn-active" : "classic-btn"}
          >
            {level.label}
          </div>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(levelKey)}>
          もう一度
        </button>
        <div
          {...tappableProps(() => {
            sfxTap();
            setFlagMode((v) => !v);
          })}
          aria-pressed={flagMode}
          className={flagMode ? "classic-btn classic-btn-active" : "classic-btn"}
        >
          旗モード
        </div>
      </div>

      <p className="classic-status" role="status">
        残りの地雷 {state.mineTotal - state.flags} ・ {seconds} 秒
        {best !== null ? ` ・ ベスト ${best} 秒` : ""} ・ {statusText}
      </p>

      {webglFailed ? board2d : (
        <div style={{ width: "100%", maxWidth: 640, margin: "0 auto" }}>
          <MinesweeperScene3D
            cells={state.cells}
            rows={state.rows}
            cols={state.cols}
            exploded={state.exploded}
            status={state.status}
            onCell={onCell}
            onToggleFlag={toggleFlagWithSound}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      {state.status === "won" && (
        <div style={{ marginTop: 14 }}>
          <EndScreen
            outcome="win"
            title="クリア！"
            score={seconds}
            scoreLabel="クリアタイム（秒）"
            onRetry={() => restart(levelKey)}
          >
            <p>
              {LEVELS.find((l) => l.key === levelKey)?.label ?? levelKey} ・ 地雷 {state.mineTotal} 個
              {best !== null ? ` ・ ベスト ${best} 秒` : ""}
            </p>
          </EndScreen>
        </div>
      )}

      {state.status === "lost" && (
        <div style={{ marginTop: 14 }}>
          <EndScreen outcome="lose" onRetry={() => restart(levelKey)}>
            <p>
              開いたマス {state.opened} / {state.rows * state.cols - state.mineTotal} ・ {seconds} 秒 ・ 地雷{" "}
              {state.mineTotal} 個
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
