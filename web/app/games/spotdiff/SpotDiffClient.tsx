"use client";
// 間違い探し。ロジックは lib/spotdiff.ts。
// 左のお手本と右の盤を見比べ、右盤で違っているマスをタップする。端末内で完結する。
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  createSpotDiffGame,
  tapSpotDiff,
  type SpotDiffLevelKey,
  type SpotDiffState,
} from "@/lib/spotdiff";
import { useGamesNav } from "../GamesShell";

const LEVELS: { key: SpotDiffLevelKey; label: string }[] = [
  { key: "easy", label: "かんたん（3つ）" },
  { key: "normal", label: "ふつう（5つ）" },
  { key: "hard", label: "むずかしい（7つ）" },
];

function newGame(level: SpotDiffLevelKey): SpotDiffState {
  return createSpotDiffGame(level, Date.now() % 2147483647);
}

export default function SpotDiffClient() {
  const { prefix } = useGamesNav();
  const [levelKey, setLevelKey] = useState<SpotDiffLevelKey>("easy");
  const [state, setState] = useState<SpotDiffState>(() => newGame("easy"));
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [lastMiss, setLastMiss] = useState<number | null>(null);

  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(`ago-spotdiff-best-${levelKey}`));
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
      window.localStorage.setItem(`ago-spotdiff-best-${levelKey}`, String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best, levelKey]);

  const restart = (key: SpotDiffLevelKey) => {
    setLevelKey(key);
    setState(newGame(key));
    setSeconds(0);
    setLastMiss(null);
  };

  const onTap = (index: number) => {
    const before = state;
    const after = tapSpotDiff(before, index);
    if (after === before) return;
    setLastMiss(after.mistakes > before.mistakes ? index : null);
    setState(after);
  };

  const statusText =
    state.status === "won"
      ? `全部見つけた！クリアです（ミス ${state.mistakes} 回）。`
      : "右の盤で、お手本と違っているマスをタップしよう。";

  const cellFontSize = "clamp(17px, 5.2vw, 30px)";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>間違い探し</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>間違い探し</h1>
        <p className="muted">右の盤をタップして回答。見つけた間違いは両方の盤に緑の枠が付きます。</p>
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
      </div>

      <p className="classic-status" role="status">
        見つけた {state.found.length} / {state.diffIndexes.length} ・ ミス {state.mistakes} 回 ・ {seconds} 秒
        {best !== null ? ` ・ ベスト ${best} 秒` : ""} ・ {statusText}
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <figure style={{ flex: "1 1 260px", margin: 0 }}>
          <figcaption className="muted" style={{ textAlign: "center", marginBottom: 6 }}>
            お手本
          </figcaption>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${state.cols}, minmax(0, 1fr))`,
              gap: 3,
            }}
            role="img"
            aria-label="お手本の盤"
          >
            {state.base.map((emoji, i) => {
              const found = state.found.includes(i);
              return (
                <div
                  key={i}
                  style={{
                    aspectRatio: "1",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: cellFontSize,
                    borderRadius: 8,
                    background: "#f6f1e3",
                    border: found ? "2px solid #22c55e" : "2px solid transparent",
                    lineHeight: 1,
                  }}
                >
                  {emoji}
                </div>
              );
            })}
          </div>
        </figure>

        <figure style={{ flex: "1 1 260px", margin: 0 }}>
          <figcaption className="muted" style={{ textAlign: "center", marginBottom: 6 }}>
            間違いはこっち（タップで回答）
          </figcaption>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${state.cols}, minmax(0, 1fr))`,
              gap: 3,
            }}
            role="grid"
            aria-label="間違い探しの盤"
          >
            {state.altered.map((emoji, i) => {
              const found = state.found.includes(i);
              const missed = lastMiss === i;
              return (
                <button
                  key={i}
                  type="button"
                  role="gridcell"
                  aria-label={found ? "見つけた間違い" : `${i + 1}番のマス`}
                  onClick={() => onTap(i)}
                  style={{
                    aspectRatio: "1",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: cellFontSize,
                    borderRadius: 8,
                    background: found ? "#dcfce7" : missed ? "#fee2e2" : "#fffdf6",
                    border: found ? "2px solid #22c55e" : missed ? "2px solid #ef4444" : "2px solid #e3ddc8",
                    lineHeight: 1,
                    cursor: state.status === "playing" && !found ? "pointer" : "default",
                    touchAction: "manipulation",
                    padding: 0,
                  }}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
        </figure>
      </div>
    </>
  );
}
