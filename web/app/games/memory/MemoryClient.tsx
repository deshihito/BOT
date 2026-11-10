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

export default function MemoryClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<MemState>(() => createMemoryGame(Date.now() % 2147483647));

  useEffect(() => {
    if (!isPairPending(state)) return;
    const delay = pendingIsMatch(state) ? 350 : 850;
    const id = setTimeout(() => setState((s) => settlePair(s)), delay);
    return () => clearTimeout(id);
  }, [state]);

  const restart = () => setState(createMemoryGame(Date.now() % 2147483647));

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>メモリーマッチ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>メモリーマッチ</h1>
        <p className="muted">裏返したカードの絵柄を当てる神経衰弱。8ペア16枚、手数の少なさを目指そう。</p>
      </div>

      <p className="classic-status" role="status">
        {state.moves} 手 ・ そろったペア {state.matchedPairs} / 8
        {state.status === "won" ? ` ・ 全ペア制覇！ ${state.moves} 手でクリアです。` : ""}
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
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>
    </>
  );
}
