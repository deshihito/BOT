"use client";
// スパイダー・ソリティア（1スート簡易版）。ロジックは lib/spider.ts。
// タップ選択式：動かしたい束の先頭カード→置き先の列の順にタップする。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useState } from "react";
import {
  SPIDER_COLUMNS,
  canMoveSpiderRun,
  createSpider,
  dealSpider,
  movableRunLength,
  moveSpider,
  spiderRankLabel,
  spiderStockDeals,
  type SpiderState,
} from "@/lib/spider";
import { useGamesNav } from "../GamesShell";

type Selection = { col: number; index: number } | null;

function newGame(): SpiderState {
  return createSpider(Date.now() % 2147483647);
}

export default function SpiderClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<SpiderState>(() => newGame());
  const [selection, setSelection] = useState<Selection>(null);
  const [message, setMessage] = useState<string | null>(null);

  const restart = () => {
    setState(newGame());
    setSelection(null);
    setMessage(null);
  };

  const onCardClick = (col: number, index: number) => {
    if (state.status !== "playing") return;
    const pile = state.columns[col];
    const card = pile[index];
    if (selection) {
      // 置き先としてこの列が選ばれた
      if (selection.col !== col) {
        if (canMoveSpiderRun(state, selection.col, selection.index, col)) {
          setState((s) => moveSpider(s, selection.col, selection.index, col));
          setMessage(null);
        } else {
          setMessage("そこには置けません。下降順の束と、置き先の数字を確認してください。");
        }
        setSelection(null);
        return;
      }
      // 同じ列をもう一度押したら選択し直し／解除
      if (selection.index === index) {
        setSelection(null);
        return;
      }
    }
    if (!card || !card.faceUp) {
      setSelection(null);
      return;
    }
    // 動かせる束の範囲内なら、その位置から選択する
    const runStart = pile.length - movableRunLength(state, col);
    if (index >= runStart) {
      setSelection({ col, index });
      setMessage(null);
    } else {
      setSelection(null);
      setMessage("まとめて動かせるのは、下降順に続いた部分だけです。");
    }
  };

  const onEmptyColumnClick = (col: number) => {
    if (!selection || state.status !== "playing") return;
    if (canMoveSpiderRun(state, selection.col, selection.index, col)) {
      setState((s) => moveSpider(s, selection.col, selection.index, col));
      setMessage(null);
    } else {
      setMessage("そこには置けません。");
    }
    setSelection(null);
  };

  const onDeal = () => {
    if (state.columns.some((p) => p.length === 0)) {
      setMessage("空の列があるときは配れません。先にカードを置いてください。");
      return;
    }
    setState((s) => dealSpider(s));
    setSelection(null);
    setMessage(null);
  };

  const deals = spiderStockDeals(state);

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>スパイダー</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>スパイダーソリティア</h1>
        <p className="muted">
          動かしたい束の先頭カードをタップし、続けて置き先の列をタップします。全カードがスペードの1スート制です。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        <button
          type="button"
          className="classic-btn"
          onClick={onDeal}
          disabled={deals === 0 || state.status !== "playing"}
        >
          山札から配る（残り{deals}回）
        </button>
      </div>

      <p className="classic-status" role="status">
        手数 {state.moves} ・ 完成 {state.completed} / 8組
        {state.status === "won"
          ? " ・ 全8組そろった！クリアです。"
          : message
            ? ` ・ ${message}`
            : selection
              ? " ・ 置き先の列を選んでください。"
              : " ・ 動かしたいカードを選んでください。"}
      </p>

      <div
        role="group"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${SPIDER_COLUMNS}, minmax(0, 1fr))`,
          gap: 4,
          maxWidth: 860,
          margin: "0 auto",
        }}
        aria-label="スパイダーの場札"
      >
        {state.columns.map((pile, col) => (
          <div key={col} style={{ display: "flex", flexDirection: "column" }}>
            {pile.length === 0 ? (
              <button
                type="button"
                aria-label={`${col + 1}列目（空）`}
                onClick={() => onEmptyColumnClick(col)}
                style={{
                  height: 62,
                  borderRadius: 7,
                  border: "1px dashed #94a3b8",
                  background: "#f1f5f9",
                  color: "#64748b",
                  fontSize: 11,
                  cursor: selection ? "pointer" : "default",
                }}
              >
                空
              </button>
            ) : (
              pile.map((card, index) => {
                const isSelected =
                  selection !== null && selection.col === col && index >= selection.index;
                return (
                  <button
                    key={card.id}
                    type="button"
                    disabled={!card.faceUp}
                    aria-label={
                      card.faceUp
                        ? `スペードの${spiderRankLabel(card.rank)}`
                        : "裏向きのカード"
                    }
                    aria-pressed={isSelected}
                    onClick={() => onCardClick(col, index)}
                    style={{
                      height: 62,
                      marginTop: index === 0 ? 0 : -38,
                      borderRadius: 7,
                      border: isSelected ? "2px solid #2563eb" : "1px solid #cbd5e1",
                      background: card.faceUp
                        ? isSelected
                          ? "#dbeafe"
                          : "#ffffff"
                        : "#334155",
                      color: card.faceUp ? "#111827" : "#e2e8f0",
                      fontWeight: 700,
                      fontSize: 14,
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "flex-start",
                      padding: "3px 5px",
                      cursor: card.faceUp ? "pointer" : "default",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.10)",
                      zIndex: index,
                      position: "relative",
                    }}
                  >
                    {card.faceUp ? `♠${spiderRankLabel(card.rank)}` : "🂠"}
                  </button>
                );
              })
            )}
          </div>
        ))}
      </div>
    </>
  );
}
