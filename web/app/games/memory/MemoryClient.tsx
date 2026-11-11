"use client";
// メモリーマッチ（神経衰弱）。ロジックは lib/memory-match.ts。
// 2枚開いたら、一致はすぐ・不一致は少し見せてから settlePair で照合する。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  createMemoryGame,
  flipCard,
  isPairPending,
  pendingIsMatch,
  settlePair,
  type MemState,
} from "@/lib/memory-match";
import { useGamesNav } from "../GamesShell";

const LEVELS = [
  { key: "easy", label: "かんたん（6ペア）", pairs: 6 },
  { key: "normal", label: "ふつう（8ペア）", pairs: 8 },
] as const;

type LevelKey = (typeof LEVELS)[number]["key"];

export default function MemoryClient() {
  const { prefix } = useGamesNav();
  const [levelKey, setLevelKey] = useState<LevelKey>("normal");
  const pairs = LEVELS.find((l) => l.key === levelKey)?.pairs ?? 8;
  const [state, setState] = useState<MemState>(() => createMemoryGame(Date.now() % 2147483647, 8));
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    if (!isPairPending(state)) return;
    const delay = pendingIsMatch(state) ? 350 : 850;
    const id = setTimeout(() => setState((s) => settlePair(s)), delay);
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

  const restart = (key: LevelKey = levelKey) => {
    const level = LEVELS.find((l) => l.key === key) ?? LEVELS[1];
    setLevelKey(key);
    setState(createMemoryGame(Date.now() % 2147483647, level.pairs));
    setSeconds(0);
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
              className={faceUp ? "mem-card mem-card-up" : "mem-card"}
              aria-label={faceUp ? card.icon : "裏向きのカード"}
              aria-pressed={faceUp}
              onClick={() => setState((s) => flipCard(s, i))}
            >
              <span className="mem-card-inner">
                <span className="mem-face mem-face-back" aria-hidden="true">✦</span>
                <span className="mem-face mem-face-front" aria-hidden="true">{card.icon}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="classic-controls">
        <button type="button" className="classic-btn" onClick={() => restart()}>
          もう一度
        </button>
      </div>
    </>
  );
}
