"use client";
// 氷の迷路。ロジックは lib/icemaze.ts（滑って壁の手前で止まる）。
// ベストは localStorage の ago-icemaze-best に「クリア時の最少滑り回数」を保存する設計。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const IceMazeScene3D = dynamic(() => import("./IceMazeScene3D"), { ssr: false });
import {
  createIceMaze,
  slideIce,
  undoIce,
  type IceDir,
  type IceState,
} from "@/lib/icemaze";
import { sfxSlide, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-icemaze-best";

export default function IceMazeClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [state, setState] = useState<IceState>(() => createIceMaze(Date.now() % 2147483647));
  const [best, setBest] = useState<number | null>(null);
  const touchRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  const prevStatusRef = useRef(state.status);
  const [winPrevBest, setWinPrevBest] = useState<number | null>(null);
  const [winNewBest, setWinNewBest] = useState(false);

  // 終局遷移の捕捉はベスト保存 effect より前に置き、保存前のベストを記録する。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev !== "won" && state.status === "won") {
      setWinPrevBest(best);
      setWinNewBest(best === null || state.moves < best);
      sfxWin();
    }
  }, [state.status, state.moves, best]);

  useEffect(() => {
    if (state.status !== "won") return;
    if (best !== null && state.moves >= best) return;
    setBest(state.moves);
    try {
      window.localStorage.setItem(BEST_KEY, String(state.moves));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, state.moves, best]);

  const restart = useCallback(() => {
    setState(createIceMaze(Date.now() % 2147483647));
    setWinPrevBest(null);
    setWinNewBest(false);
  }, []);

  const slide = useCallback(
    (dir: IceDir) => {
      const next = slideIce(state, dir);
      if (next !== state) {
        sfxSlide();
        setState(next);
      }
    },
    [state],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, IceDir> = {
        ArrowUp: "up",
        ArrowRight: "right",
        ArrowDown: "down",
        ArrowLeft: "left",
      };
      const dir = map[e.key];
      if (dir) {
        e.preventDefault();
        slide(dir);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slide]);

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchRef.current;
    touchRef.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    slide(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");
  };

  const statusText =
    state.status === "won"
      ? `ゴールに止まれた！${state.moves}手でクリア${state.moves <= state.minMoves ? "（最短手数！）" : ""}。`
      : "方向を選ぶと壁の手前まで滑ります。ゴールにぴったり止まれればクリアです。";

  const dirButton = (dir: IceDir, label: string) => (
    <button
      type="button"
      className="classic-btn"
      style={{ minWidth: 52, minHeight: 44, fontSize: 18 }}
      onClick={() => slide(dir)}
      disabled={state.status === "won"}
      aria-label={`${label}へ滑る`}
    >
      {label}
    </button>
  );

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
    <div
      role="grid"
      aria-label="氷の迷路の盤面"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${state.cols}, 1fr)`,
        gap: 2,
        maxWidth: 420,
        margin: "0 auto",
        touchAction: "pan-y",
      }}
    >
      {state.walls.map((wall, i) => {
        const isPlayer = i === state.player;
        const isGoal = i === state.goal;
        const isStart = i === state.start && !isPlayer;
        return (
          <div
            key={i}
            role="gridcell"
            className={isPlayer ? "juice-pop" : isGoal ? "juice-pulse" : undefined}
            aria-label={wall ? "壁" : isPlayer ? "現在位置" : isGoal ? "ゴール" : "床"}
            style={{
              aspectRatio: "1",
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              background: wall
                ? "#5b7ea6"
                : isGoal
                  ? "#ffd54d"
                  : isPlayer
                    ? "#bfe3ff"
                    : "#eaf6ff",
              border: isPlayer ? "2px solid #1565c0" : "1px solid #cfe4f5",
            }}
          >
            {wall ? "" : isPlayer ? <span style={{ color: "#0d47a1" }}>●</span> : isGoal ? <span style={{ color: "#8d6e00" }}>◎</span> : isStart ? "・" : ""}
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
        <span>氷の迷路</span>
      </nav>

      <h1 style={{ fontSize: 22, margin: "8px 0" }}>氷の迷路</h1>
      <p className="og-muted">
        矢印ボタンか方向キー、盤面のスワイプで滑ります。
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0" }}>
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        <button
          type="button"
          className="classic-btn"
          onClick={() => {
            sfxTap();
            setState((s) => undoIce(s));
          }}
          disabled={state.history.length === 0}
        >
          1手戻す
        </button>
      </div>

      <p role="status" style={{ margin: "6px 0" }}>
        {statusText}
      </p>
      <p className="og-muted" style={{ margin: "4px 0 10px" }}>
        手数 {state.moves} / 最短 {state.minMoves} 手
        {best !== null ? ` ・ ベスト ${best} 手` : ""}
      </p>

      {webglFailed ? board2d : (
        <div style={{ width: "100%", maxWidth: 420, margin: "0 auto" }}>
          <IceMazeScene3D
            walls={state.walls}
            cols={state.cols}
            rows={state.rows}
            player={state.player}
            goal={state.goal}
            start={state.start}
            status={state.status}
            onSlide={slide}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 52px)",
          gap: 6,
          justifyContent: "center",
          marginTop: 14,
        }}
      >
        <span />
        {dirButton("up", "↑")}
        <span />
        {dirButton("left", "←")}
        {dirButton("down", "↓")}
        {dirButton("right", "→")}
      </div>

      {state.status === "won" && (
        <div style={{ maxWidth: 420, margin: "14px auto 0" }}>
          <EndScreen
            outcome="win"
            title="ゴールに止まれた！"
            score={state.moves}
            scoreLabel="手数"
            newBest={winNewBest}
            previousBest={winPrevBest}
            onRetry={restart}
            retryLabel="もう一度遊ぶ"
          >
            <p className="muted" style={{ margin: 0 }}>
              {state.moves}手でクリア（最短 {state.minMoves} 手）
              {state.moves <= state.minMoves ? "。最短手数です。" : "。"}
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
