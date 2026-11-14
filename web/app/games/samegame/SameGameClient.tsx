"use client";
// セイムゲーム。ロジックは lib/samegame.ts。
// 同色でつながった2個以上のグループをタップで消す。端末内で完結する。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const SameGameScene3D = dynamic(() => import("./SameGameScene3D"), { ssr: false });
import {
  createSameGame,
  removeSameGameGroup,
  sameGameGroupAt,
  sameGameGroupScore,
  sameGameRemaining,
  type SameGameState,
} from "@/lib/samegame";
import { sfxCorrect, sfxLose, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
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
  const [webglFailed, setWebglFailed] = useState(false);
  const [state, setState] = useState<SameGameState>(() => newGame());
  const [hover, setHover] = useState<number | null>(null);
  const [best, setBest] = useState<number | null>(null);
  const [resultNewBest, setResultNewBest] = useState(false);
  const [resultPrevBest, setResultPrevBest] = useState<number | null>(null);
  const prevStatusRef = useRef(state.status);

  // 終局遷移の瞬間だけジングルを鳴らし、その時点（保存前）のベストで更新判定を控える。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev === state.status || state.status !== "finished") return;
    const isNew = best === null || state.score > best;
    setResultNewBest(isNew);
    setResultPrevBest(isNew ? null : best);
    if (sameGameRemaining(state) === 0) sfxWin();
    else sfxLose();
  }, [state, best]);

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

  const restart = () => {
    setState(newGame());
    setHover(null);
    setResultNewBest(false);
    setResultPrevBest(null);
  };

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

  // ブロックをタップする現行ハンドラ。2D 盤と 3D 盤の両方がここへ接続する。
  const tapBlockAt = (i: number) => {
    if (state.status === "playing") {
      if (sameGameGroupAt(state, i).length >= 2) sfxCorrect();
      else sfxWrong();
    }
    setState((s) => removeSameGameGroup(s, i));
    setHover(null);
  };

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
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
              className={highlighted ? "juice-pulse" : undefined}
              onClick={() => tapBlockAt(i)}
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
  );

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
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        スコア {state.score}
        {state.status === "finished" && state.bonus > 0 ? `（ボーナス +${state.bonus}）` : ""} ・ 残り {remaining} 個
        {best !== null ? ` ・ ベスト ${best}` : ""} ・ {statusText}
      </p>

      {webglFailed ? board2d : (
        <div style={{ width: "100%", maxWidth: 560, margin: "0 auto" }}>
          <SameGameScene3D
            cells={state.cells}
            cols={state.cols}
            rows={state.rows}
            hoverGroup={hoverGroup}
            onCell={tapBlockAt}
            onHover={setHover}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      {state.status === "finished" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen
            outcome={remaining === 0 ? "win" : "finish"}
            score={state.score}
            scoreLabel="スコア"
            newBest={resultNewBest}
            previousBest={resultPrevBest}
            onRetry={restart}
          >
            <p className="muted">
              消したブロック {state.removed} 個 ・ 残り {remaining} 個
              {state.bonus > 0 ? ` ・ ボーナス +${state.bonus}` : ""}
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
