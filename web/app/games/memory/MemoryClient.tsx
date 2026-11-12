"use client";
// メモリーマッチ（神経衰弱）。ロジックは lib/memory-match.ts。
// 2枚開いたら、一致はすぐ・不一致は少し見せてから settlePair で照合する。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  createMemoryGame,
  flipCard,
  isPairPending,
  memorySymbol,
  pendingIsMatch,
  settlePair,
  type MemState,
} from "@/lib/memory-match";
import { sfxCorrect, sfxFlip, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const LEVELS = [
  { key: "easy", label: "かんたん（6ペア）", pairs: 6 },
  { key: "normal", label: "ふつう（8ペア）", pairs: 8 },
] as const;

type LevelKey = (typeof LEVELS)[number]["key"];

function polygonPoints(n: number, r: number, innerRatio?: number): string {
  const count = innerRatio === undefined ? n : n * 2;
  return Array.from({ length: count }, (_, i) => {
    const angle = ((i * 360) / count - 90) * (Math.PI / 180);
    const radius = innerRatio === undefined || i % 2 === 0 ? r : r * innerRatio;
    return `${(50 + radius * Math.cos(angle)).toFixed(1)},${(50 + radius * Math.sin(angle)).toFixed(1)}`;
  }).join(" ");
}

/** カードの絵柄（形×色の SVG 図形）。 */
function MemorySymbolIcon({ icon }: { icon: string }) {
  const s = memorySymbol(icon);
  const shape =
    s.shape === "circle" ? (
      <circle cx="50" cy="50" r="36" fill={s.color} />
    ) : s.shape === "triangle" ? (
      <polygon points="50,14 86,80 14,80" fill={s.color} />
    ) : s.shape === "square" ? (
      <rect x="16" y="16" width="68" height="68" rx="6" fill={s.color} />
    ) : s.shape === "star" ? (
      <polygon points={polygonPoints(5, 40, 0.42)} fill={s.color} />
    ) : s.shape === "diamond" ? (
      <polygon points="50,10 88,50 50,90 12,50" fill={s.color} />
    ) : s.shape === "heart" ? (
      <path
        d="M50 86 C18 62 10 44 10 30 C10 17 20 8 32 8 C41 8 47 14 50 21 C53 14 59 8 68 8 C80 8 90 17 90 30 C90 44 82 62 50 86 Z"
        fill={s.color}
      />
    ) : s.shape === "pentagon" ? (
      <polygon points={polygonPoints(5, 38)} fill={s.color} />
    ) : (
      <polygon
        points="38,12 62,12 62,38 88,38 88,62 62,62 62,88 38,88 38,62 12,62 12,38 38,38"
        fill={s.color}
      />
    );
  return (
    <svg width="1.35em" height="1.35em" viewBox="0 0 100 100" aria-hidden="true" style={{ display: "block" }}>
      {shape}
    </svg>
  );
}

export default function MemoryClient() {
  const { prefix } = useGamesNav();
  const [levelKey, setLevelKey] = useState<LevelKey>("normal");
  const pairs = LEVELS.find((l) => l.key === levelKey)?.pairs ?? 8;
  const [state, setState] = useState<MemState>(() => createMemoryGame(Date.now() % 2147483647, 8));
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    if (!isPairPending(state)) return;
    const matched = pendingIsMatch(state);
    const delay = matched ? 350 : 850;
    const id = setTimeout(() => {
      if (matched) {
        sfxCorrect();
      } else {
        sfxWrong();
      }
      setState((s) => settlePair(s));
    }, delay);
    return () => clearTimeout(id);
  }, [state]);

  const started = state.moves > 0 || state.faceUp.length > 0;
  useEffect(() => {
    if (!started || state.status === "won") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [started, state.status]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(`ago-memory-best-${pairs}`));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, [pairs]);

  useEffect(() => {
    if (state.status !== "won") return;
    if (best !== null && state.moves >= best) return;
    setBest(state.moves);
    try {
      window.localStorage.setItem(`ago-memory-best-${pairs}`, String(state.moves));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, state.moves, best, pairs]);

  // 勝利への遷移で1回だけジングルを鳴らし、その時点のベストと比較した結果を保持する。
  const prevStatusRef = useRef(state.status);
  const [winResult, setWinResult] = useState<{ newBest: boolean; prevBest: number | null } | null>(null);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (state.status === "won" && prev !== "won") {
      sfxWin();
      setWinResult({ newBest: best === null || state.moves < best, prevBest: best });
    }
  }, [state.status, state.moves, best]);

  const onFlip = (index: number) => {
    const card = state.cards[index];
    if (
      state.status === "playing" &&
      card &&
      !card.matched &&
      !state.faceUp.includes(index) &&
      state.faceUp.length < 2
    ) {
      sfxFlip();
    }
    setState((s) => flipCard(s, index));
  };

  const restart = (key: LevelKey = levelKey) => {
    const level = LEVELS.find((l) => l.key === key) ?? LEVELS[1];
    setLevelKey(key);
    setState(createMemoryGame(Date.now() % 2147483647, level.pairs));
    setSeconds(0);
    setWinResult(null);
  };

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>メモリーマッチ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>メモリーマッチ</h1>
        <p className="muted">裏返したカードの絵柄を当てる神経衰弱。手数の少なさを目指そう。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="難易度">
        {LEVELS.map((level) => (
          <button
            key={level.key}
            type="button"
            className={levelKey === level.key ? "classic-btn classic-btn-active" : "classic-btn"}
            aria-pressed={levelKey === level.key}
            onClick={() => restart(level.key)}
          >
            {level.label}
          </button>
        ))}
      </div>

      <p className="classic-status" role="status">
        {state.moves} 手 ・ そろったペア {state.matchedPairs} / {pairs} ・ {seconds} 秒
        {best !== null ? ` ・ ベスト ${best} 手` : ""}
        {state.status === "won" ? ` ・ 全ペア制覇！ ${state.moves} 手・${seconds} 秒でクリアです。` : ""}
      </p>

      <div className="mem-board" role="grid" aria-label="メモリーマッチの盤">
        {state.cards.map((card, i) => {
          const faceUp = card.matched || state.faceUp.includes(i);
          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              className={faceUp ? "mem-card mem-card-up juice-flip" : "mem-card"}
              aria-label={faceUp ? memorySymbol(card.icon).label : "裏向きのカード"}
              aria-pressed={faceUp}
              onClick={() => onFlip(i)}
            >
              <span className="mem-card-inner">
                <span className="mem-face mem-face-back" aria-hidden="true">
                  <svg width="1em" height="1em" viewBox="0 0 100 100" style={{ display: "block" }}>
                    <polygon points={polygonPoints(5, 42, 0.42)} fill="#ffffff" />
                  </svg>
                </span>
                <span className="mem-face mem-face-front" aria-hidden="true">
                  <MemorySymbolIcon icon={card.icon} />
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {state.status === "won" ? (
        <EndScreen
          outcome="win"
          score={state.moves}
          scoreLabel="手数"
          newBest={winResult?.newBest}
          previousBest={winResult && !winResult.newBest ? winResult.prevBest : undefined}
          onRetry={() => restart()}
        >
          <p className="muted">
            {seconds} 秒でクリア ・ そろったペア {state.matchedPairs} / {pairs}
          </p>
        </EndScreen>
      ) : null}

      <div className="classic-controls">
        <button type="button" className="classic-btn" onClick={() => restart()}>
          もう一度
        </button>
      </div>
    </>
  );
}
