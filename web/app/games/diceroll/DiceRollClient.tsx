"use client";
// ダイスロール。ロジックは lib/diceroll.ts（ランダムウォークで解を先に作る生成）。
// 矢印ボタンかキーボードの矢印キーで転がす。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { sfxDice, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import {
  createDiceRollGame,
  rollDie,
  type DiceDir,
  type DiceRollState,
} from "@/lib/diceroll";
import { useGamesNav } from "../GamesShell";
import { useGesture } from "@/lib/gesture";

const BEST_KEY = "ago-diceroll-best";

function newGame(): DiceRollState {
  return createDiceRollGame(Date.now() % 2147483647);
}

const KEY_TO_DIR: Record<string, DiceDir> = {
  ArrowUp: "N",
  ArrowRight: "E",
  ArrowDown: "S",
  ArrowLeft: "W",
};

function FaceCell({ value, label, strong }: { value: number; label: string; strong?: boolean }) {
  return (
    <div
      role="img"
      aria-label={`${label} ${value}`}
      style={{
        width: 44,
        height: 44,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: strong ? 22 : 18,
        fontWeight: strong ? 800 : 600,
        color: "var(--text)",
        background: strong ? "var(--accent-soft)" : "#fff",
        border: "1px solid var(--line)",
        borderRadius: 8,
      }}
    >
      {value}
    </div>
  );
}

export default function DiceRollClient() {
  const { prefix } = useGamesNav();
  const [initial, setInitial] = useState<DiceRollState>(() => newGame());
  const [state, setState] = useState<DiceRollState>(initial);
  const [best, setBest] = useState<number | null>(null);
  const [prevBest, setPrevBest] = useState<number | null>(null);
  const [isNewBest, setIsNewBest] = useState(false);
  const wonRef = useRef<number | null>(null);

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
    if (wonRef.current === state.seed) return;
    wonRef.current = state.seed;
    sfxWin();
    setPrevBest(best);
    if (best !== null && state.moves >= best) {
      setIsNewBest(false);
      return;
    }
    setIsNewBest(best !== null);
    setBest(state.moves);
    try {
      window.localStorage.setItem(BEST_KEY, String(state.moves));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, state.moves, state.seed, best]);

  const roll = useCallback(
    (dir: DiceDir) => {
      if (state.status !== "playing") return;
      const next = rollDie(state, dir);
      if (next === state) return;
      sfxDice();
      setState(next);
    },
    [state],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = KEY_TO_DIR[e.key];
      if (!dir) return;
      e.preventDefault();
      roll(dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [roll]);

  const restart = () => {
    sfxTap();
    wonRef.current = null;
    setIsNewBest(false);
    setPrevBest(null);
    const g = newGame();
    setInitial(g);
    setState(g);
  };

  const reset = () => {
    sfxTap();
    wonRef.current = null;
    setIsNewBest(false);
    setPrevBest(null);
    setState(initial);
  };

  // 盤面スワイプ＝その方向へサイコロを転がす（方向ボタンは廃止、矢印キーは残す）。
  const boardGesture = useGesture({
    onSwipe: (dir) => roll(dir === "up" ? "N" : dir === "right" ? "E" : dir === "down" ? "S" : "W"),
  });

  const blockedSet = new Set(state.blocked);
  const o = state.orientation;
  const statusText =
    state.status === "won"
      ? "ゴールの目がそろった！クリアです。"
      : `ゴールに止まったとき、上の目が ${state.targetTop} になればクリアです。`;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ダイスロール</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ダイスロール</h1>
        <p className="muted">
          盤面をスワイプした方向へサイコロが転がります。ゴールまで運びましょう（矢印キーでも転がせます）。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        <button type="button" className="classic-btn" onClick={reset}>
          最初から
        </button>
      </div>

      <p className="classic-status" role="status">
        手数 {state.moves}
        {best !== null ? ` ・ ベスト ${best} 手` : ""} ・ 上の目 {o.top} ・ {statusText}
      </p>

      {state.status === "won" && (
        <EndScreen
          outcome="win"
          title="ゴールの目がそろった！クリアです。"
          score={state.moves}
          scoreLabel="手数"
          newBest={isNewBest}
          previousBest={isNewBest ? null : prevBest}
          onRetry={restart}
        >
          <p className="muted" style={{ margin: 0 }}>
            ゴールの目 {state.targetTop} にそろえて止まりました。
          </p>
        </EndScreen>
      )}

      <div
        {...boardGesture}
        role="grid"
        aria-label="ダイスロールの盤（スワイプした方向へ転がります）"
        style={{
          touchAction: "none",
          cursor: "grab",
          display: "grid",
          gridTemplateColumns: `repeat(${state.cols}, minmax(0, 1fr))`,
          gap: 4,
          maxWidth: 400,
          margin: "0 auto",
        }}
      >
        {Array.from({ length: state.rows * state.cols }, (_, i) => {
          const isDie = state.pos === i;
          const isGoal = state.goal === i;
          const isStart = state.start === i;
          const isBlocked = blockedSet.has(i);
          return (
            <div
              key={isDie ? `die-${state.moves}` : i}
              className={isDie ? "juice-pop" : undefined}
              role="gridcell"
              aria-label={
                isDie
                  ? `サイコロ 上の目 ${o.top}`
                  : isGoal
                    ? `ゴール 必要な目 ${state.targetTop}`
                    : isBlocked
                      ? "障害物"
                      : isStart
                        ? "スタート"
                        : "マス"
              }
              style={{
                aspectRatio: "1",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: isDie ? 26 : 20,
                fontWeight: 800,
                color: isDie ? "#fff" : "var(--text)",
                background: isBlocked
                  ? "#26221f"
                  : isDie
                    ? "var(--accent)"
                    : isGoal
                      ? "#ffe9a8"
                      : "#fff",
                border: isGoal ? "2px solid #d9a400" : "1px solid var(--line)",
                borderRadius: 8,
              }}
            >
              {isDie ? o.top : isGoal ? state.targetTop : isBlocked ? "" : isStart ? "S" : ""}
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          gap: 24,
          justifyContent: "center",
          alignItems: "flex-start",
          flexWrap: "wrap",
          marginTop: 18,
        }}
      >
        <div role="group" aria-label="サイコロの展開図">
          <p className="muted" style={{ textAlign: "center", margin: "0 0 6px" }}>
            いまの向き
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 44px)",
              gap: 4,
              justifyContent: "center",
            }}
          >
            <span />
            <FaceCell value={o.north} label="北の目" />
            <span />
            <FaceCell value={o.west} label="西の目" />
            <FaceCell value={o.top} label="上の目" strong />
            <FaceCell value={o.east} label="東の目" />
            <span />
            <FaceCell value={o.south} label="南の目" />
            <span />
            <span />
            <FaceCell value={o.bottom} label="下の目" />
            <span />
          </div>
        </div>

        <div aria-hidden="true" style={{ textAlign: "center" }}>
          <p className="muted" style={{ margin: "0 0 6px" }}>転がす</p>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>盤面をスワイプした方向へ転がります</p>
        </div>
      </div>
    </>
  );
}
