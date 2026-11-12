"use client";
// 間違い探し。ロジックは lib/spotdiff.ts。
// 左のお手本と右の盤を見比べ、右盤で違っているマスをタップする。端末内で完結する。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  createSpotDiffGame,
  spotDiffSymbol,
  tapSpotDiff,
  type SpotDiffLevelKey,
  type SpotDiffState,
} from "@/lib/spotdiff";
import { sfxCorrect, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const LEVELS: { key: SpotDiffLevelKey; label: string }[] = [
  { key: "easy", label: "かんたん（3つ）" },
  { key: "normal", label: "ふつう（5つ）" },
  { key: "hard", label: "むずかしい（7つ）" },
];

function newGame(level: SpotDiffLevelKey): SpotDiffState {
  return createSpotDiffGame(level, Date.now() % 2147483647);
}

const STAR_POINTS = Array.from({ length: 10 }, (_, i) => {
  const angle = ((i * 36 - 90) * Math.PI) / 180;
  const r = i % 2 === 0 ? 40 : 17;
  return `${(50 + r * Math.cos(angle)).toFixed(1)},${(50 + r * Math.sin(angle)).toFixed(1)}`;
}).join(" ");

/** マスの絵柄（形×色の SVG 図形）。 */
function SpotSymbol({ id }: { id: string }) {
  const s = spotDiffSymbol(id);
  const shape =
    s.shape === "circle" ? (
      <circle cx="50" cy="50" r="36" fill={s.color} />
    ) : s.shape === "triangle" ? (
      <polygon points="50,14 86,80 14,80" fill={s.color} />
    ) : s.shape === "square" ? (
      <rect x="16" y="16" width="68" height="68" rx="6" fill={s.color} />
    ) : s.shape === "star" ? (
      <polygon points={STAR_POINTS} fill={s.color} />
    ) : s.shape === "diamond" ? (
      <polygon points="50,10 88,50 50,90 12,50" fill={s.color} />
    ) : s.shape === "heart" ? (
      <path
        d="M50 86 C18 62 10 44 10 30 C10 17 20 8 32 8 C41 8 47 14 50 21 C53 14 59 8 68 8 C80 8 90 17 90 30 C90 44 82 62 50 86 Z"
        fill={s.color}
      />
    ) : (
      <polygon
        points="38,12 62,12 62,38 88,38 88,62 62,62 62,88 38,88 38,62 12,62 12,38 38,38"
        fill={s.color}
      />
    );
  return (
    <svg width="64%" height="64%" viewBox="0 0 100 100" aria-hidden="true" style={{ display: "block" }}>
      {shape}
    </svg>
  );
}

export default function SpotDiffClient() {
  const { prefix } = useGamesNav();
  const [levelKey, setLevelKey] = useState<SpotDiffLevelKey>("easy");
  const [state, setState] = useState<SpotDiffState>(() => newGame("easy"));
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [lastMiss, setLastMiss] = useState<number | null>(null);
  const [resultNewBest, setResultNewBest] = useState(false);
  const [resultPrevBest, setResultPrevBest] = useState<number | null>(null);
  const prevStatusRef = useRef(state.status);

  // 終局遷移の瞬間だけジングルを鳴らし、その時点（保存前）のベストで更新判定を控える。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev === state.status || state.status !== "won") return;
    const isNew = best === null || seconds < best;
    setResultNewBest(isNew);
    setResultPrevBest(isNew ? null : best);
    sfxWin();
  }, [state.status, seconds, best]);

  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`ago-spotdiff-best-${levelKey}`);
      const saved = raw === null ? NaN : Number(raw);
      // 0秒クリアも正規の記録として扱うため、未保存（null）と 0 を区別する。
      setBest(Number.isFinite(saved) && saved >= 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, [levelKey]);

  useEffect(() => {
    // 保存条件は「勝利したか」で判定する（0秒クリアでも保存される）。
    if (state.status !== "won") return;
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
    setResultNewBest(false);
    setResultPrevBest(null);
  };

  const onTap = (index: number) => {
    const before = state;
    const after = tapSpotDiff(before, index);
    if (after === before) return;
    if (after.found.length > before.found.length) {
      if (after.status !== "won") sfxCorrect();
    } else if (after.mistakes > before.mistakes) {
      sfxWrong();
    }
    setLastMiss(after.mistakes > before.mistakes ? index : null);
    setState(after);
  };

  const statusText =
    state.status === "won"
      ? `全部見つけた！クリアです（ミス ${state.mistakes} 回）。`
      : "右の盤で、お手本と違っているマスをタップしよう。";

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
            {state.base.map((symbol, i) => {
              const found = state.found.includes(i);
              return (
                <div
                  key={i}
                  style={{
                    aspectRatio: "1",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 8,
                    background: "#f6f1e3",
                    border: found ? "2px solid #22c55e" : "2px solid transparent",
                    lineHeight: 1,
                  }}
                >
                  <SpotSymbol id={symbol} />
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
            {state.altered.map((symbol, i) => {
              const found = state.found.includes(i);
              const missed = lastMiss === i;
              return (
                <button
                  key={i}
                  type="button"
                  role="gridcell"
                  aria-label={found ? "見つけた間違い" : `${i + 1}番のマス`}
                  className={found ? "juice-pop" : missed ? "juice-shake" : undefined}
                  onClick={() => onTap(i)}
                  style={{
                    aspectRatio: "1",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 8,
                    background: found ? "#dcfce7" : missed ? "#fee2e2" : "#fffdf6",
                    border: found ? "2px solid #22c55e" : missed ? "2px solid #ef4444" : "2px solid #e3ddc8",
                    lineHeight: 1,
                    cursor: state.status === "playing" && !found ? "pointer" : "default",
                    touchAction: "manipulation",
                    padding: 0,
                  }}
                >
                  <SpotSymbol id={symbol} />
                </button>
              );
            })}
          </div>
        </figure>
      </div>

      {state.status === "won" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen
            outcome="win"
            title="全部見つけた！"
            score={seconds}
            scoreLabel="クリアタイム（秒）"
            newBest={resultNewBest}
            previousBest={resultPrevBest}
            onRetry={() => restart(levelKey)}
          >
            <p className="muted">
              間違い {state.diffIndexes.length} 個をミス {state.mistakes} 回で見つけました。
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
