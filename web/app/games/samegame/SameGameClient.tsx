"use client";
// セイムゲーム。ロジックは lib/samegame.ts。
// 同色でつながった2個以上のグループをタップで消す。端末内で完結する。
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  createSameGame,
  removeSameGameGroup,
  sameGameGroupAt,
  sameGameGroupScore,
  sameGameRemaining,
  type SameGameState,
} from "@/lib/samegame";
import { useGamesNav } from "../GamesShell";

const COLOR_STYLES = [
  { bg: "#e2534a", label: "赤" },
  { bg: "#3f7fbf", label: "青" },
  { bg: "#43a35c", label: "緑" },
  { bg: "#e6b93d", label: "黄" },
  { bg: "#8d5bb5", label: "紫" },
];

const BEST_KEY = "ago-samegame-best";

function newGame(): SameGameState {
  return createSameGame(Date.now() % 2147483647);
}

export default function SameGameClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<SameGameState>(() => newGame());
  const [hover, setHover] = useState<number | null>(null);
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  useEffect(() => {
    if (state.status !== "finished") return;
    if (best !== null && state.score <= best) return;
    setBest(state.score);
    try {
      window.localStorage.setItem(BEST_KEY, String(state.score));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, state.score, best]);

  const hoverGroup = useMemo(() => {
    if (hover === null || state.status !== "playing") return [] as number[];
    const g = sameGameGroupAt(state, hover);
    return g.length >= 2 ? g : [];
  }, [hover, state]);
  const hoverSet = useMemo(() => new Set(hoverGroup), [hoverGroup]);
  const remaining = sameGameRemaining(state);

  const statusText =
    state.status === "finished"
      ? remaining === 0
        ? "全部消した！ボーナス1000点です。"
        : `もう消せるグループがありません。残り ${remaining} 個で終了です。`
      : hoverGroup.length >= 2
        ? `${hoverGroup.length} 個つながっています。タップで ${sameGameGroupScore(hoverGroup.length)} 点。`
        : "同色でつながった2個以上のグループをタップして消そう。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>セイムゲーム</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>セイムゲーム</h1>
        <p className="muted">同色でつながったブロックをタップして消します。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={() => { setState(newGame()); setHover(null); }}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        スコア {state.score}
        {state.status === "finished" && state.bonus > 0 ? `（ボーナス +${state.bonus}）` : ""} ・ 残り {remaining} 個
        {best !== null ? ` ・ ベスト ${best}` : ""} ・ {statusText}
      </p>

      <div
        role="grid"
        aria-label="セイムゲームの盤"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${state.cols}, minmax(0, 1fr))`,
          gap: 3,
          width: "100%",
          maxWidth: 560,
          margin: "0 auto",
        }}
      >
        {state.cells.map((color, i) => {
          if (color === null) {
            return <div key={i} style={{ aspectRatio: "1", borderRadius: 6, background: "transparent" }} />;
          }
          const style = COLOR_STYLES[color];
          const highlighted = hoverSet.has(i);
          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              aria-label={`${style.label}のブロック`}
              onClick={() => {
                setState((s) => removeSameGameGroup(s, i));
                setHover(null);
              }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              style={{
                aspectRatio: "1",
                minWidth: 0,
                border: highlighted ? "3px solid #222" : "1px solid rgba(0,0,0,0.25)",
                borderRadius: 6,
                background: style.bg,
                opacity: hoverGroup.length >= 2 && !highlighted ? 0.55 : 1,
                cursor: state.status === "playing" ? "pointer" : "default",
                padding: 0,
              }}
            />
          );
        })}
      </div>
    </>
  );
}
