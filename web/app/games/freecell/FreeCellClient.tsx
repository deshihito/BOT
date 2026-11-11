"use client";
// フリーセル。ロジックは lib/freecell.ts（移動検証・自動送り込み）。
// ドラッグではなくタップ選択式：カード（の山）をタップして選び、置き先をタップする。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useState } from "react";
import {
  autoMoveFreecell,
  createFreecell,
  freecellRemaining,
  isValidStack,
  maxMovableCards,
  moveFreecell,
  rankLabel,
  suitSymbol,
  type FcCard,
  type FcSource,
  type FcState,
  type FcTarget,
} from "@/lib/freecell";
import { useGamesNav } from "../GamesShell";

type Selection =
  | { kind: "column"; column: number; startIndex: number }
  | { kind: "freecell"; index: number }
  | null;

function newGame(): FcState {
  return createFreecell(Date.now() % 2147483647);
}

function CardFace({ card, selected, onClick }: { card: FcCard; selected?: boolean; onClick?: () => void }) {
  const red = card.suit === "hearts" || card.suit === "diamonds";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${rankLabel(card.rank)} ${suitSymbol(card.suit)}`}
      style={{
        width: "100%",
        height: 58,
        borderRadius: 7,
        border: selected ? "2px solid #2563eb" : "1px solid #cbd5e1",
        background: selected ? "#dbeafe" : "#ffffff",
        color: red ? "#dc2626" : "#111827",
        fontWeight: 700,
        fontSize: 15,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "flex-start",
        padding: "3px 5px",
        cursor: onClick ? "pointer" : "default",
        boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
      }}
    >
      {rankLabel(card.rank)}
      {suitSymbol(card.suit)}
    </button>
  );
}

function EmptySlot({ label, onClick, highlight }: { label: string; onClick?: () => void; highlight?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      style={{
        width: "100%",
        height: 58,
        borderRadius: 7,
        border: highlight ? "2px solid #2563eb" : "1px dashed #cbd5e1",
        background: "#f8fafc",
        color: "#94a3b8",
        fontSize: 11,
        cursor: onClick ? "pointer" : "default",
        padding: 2,
      }}
    >
      {label}
    </button>
  );
}

export default function FreeCellClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<FcState>(() => newGame());
  const [selected, setSelected] = useState<Selection>(null);
  const [message, setMessage] = useState<string>("");

  const restart = () => {
    setState(newGame());
    setSelected(null);
    setMessage("");
  };

  const tryMove = (source: FcSource, target: FcTarget, count: number) => {
    const next = moveFreecell(state, source, target, count);
    if (next !== state) {
      setState(next);
      setSelected(null);
      setMessage(next.status === "won" ? "全部そろいました。クリア！" : "");
      return true;
    }
    setMessage("そこへは置けません。");
    return false;
  };

  const selectionCount = (): number => {
    if (!selected) return 0;
    if (selected.kind === "freecell") return 1;
    return state.columns[selected.column].length - selected.startIndex;
  };

  const selectionSource = (): FcSource | null => {
    if (!selected) return null;
    return selected.kind === "freecell"
      ? { kind: "freecell", index: selected.index }
      : { kind: "column", column: selected.column };
  };

  const onColumnCard = (column: number, position: number) => {
    // 選択中なら、この列への移動を試みる。
    if (selected && !(selected.kind === "column" && selected.column === column)) {
      const src = selectionSource();
      if (src) {
        tryMove(src, { kind: "column", column }, selectionCount());
        return;
      }
    }
    if (selected && selected.kind === "column" && selected.column === column) {
      setSelected(null);
      return;
    }
    const col = state.columns[column];
    const stack = col.slice(position);
    if (stack.length === 0) return;
    if (!isValidStack(stack)) {
      setMessage("そのカードからは正しい並びで持てません。");
      return;
    }
    if (stack.length > maxMovableCards(state)) {
      setMessage(`今は最大 ${maxMovableCards(state)} 枚までしかまとめて動かせません。`);
      // 持てる範囲（先頭=一番手前のカード）に絞って選択する。
      setSelected({ kind: "column", column, startIndex: col.length - 1 });
      return;
    }
    setMessage("");
    setSelected({ kind: "column", column, startIndex: position });
  };

  const onEmptyColumn = (column: number) => {
    if (!selected) return;
    const src = selectionSource();
    if (src) tryMove(src, { kind: "column", column }, selectionCount());
  };

  const onFreeCell = (index: number) => {
    const card = state.freeCells[index];
    if (selected && selectionCount() === 1 && card === null) {
      const src = selectionSource();
      if (src) {
        tryMove(src, { kind: "freecell", index }, 1);
        return;
      }
    }
    if (card) {
      setSelected(selected?.kind === "freecell" && selected.index === index ? null : { kind: "freecell", index });
      setMessage("");
    }
  };

  const onFoundation = (index: number) => {
    if (!selected) return;
    if (selectionCount() !== 1) {
      setMessage("組札へは1枚ずつだけ送れます。");
      return;
    }
    const src = selectionSource();
    if (src) tryMove(src, { kind: "foundation", index }, 1);
  };

  const onAuto = () => {
    const next = autoMoveFreecell(state);
    if (next !== state) {
      setState(next);
      setSelected(null);
      setMessage(next.status === "won" ? "全部そろいました。クリア！" : "安全に送れるカードを組札へ送りました。");
    } else {
      setMessage("今は安全に送れるカードがありません。");
    }
  };

  const remaining = freecellRemaining(state);

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>フリーセル</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>フリーセル</h1>
        <p className="muted">
          カードをタップして選び、置き先をタップして動かします。色を交互に小さい順に重ね、全カードを組札（A→K）へそろえればクリア。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        <button type="button" className="classic-btn" onClick={onAuto}>
          自動送り
        </button>
      </div>

      <p className="classic-status" role="status">
        <span>
          {state.status === "won" ? "クリア！" : `残り ${remaining} 枚`}
        </span>
        <span>{state.moves}手</span>
        <span>
          まとめて動かせる枚数：最大 {maxMovableCards(state)} 枚
        </span>
        {message ? <span>{message}</span> : null}
      </p>

      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        {/* フリーセルと組札 */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 6, marginBottom: 14 }}>
          {state.freeCells.map((card, i) =>
            card ? (
              <CardFace
                key={card.id}
                card={card}
                selected={selected?.kind === "freecell" && selected.index === i}
                onClick={() => onFreeCell(i)}
              />
            ) : (
              <EmptySlot key={`free-${i}`} label="フリー" onClick={() => onFreeCell(i)} />
            ),
          )}
          {state.foundations.map((pile, i) => {
            const top = pile[pile.length - 1];
            return top ? (
              <CardFace key={top.id} card={top} onClick={() => onFoundation(i)} />
            ) : (
              <EmptySlot key={`found-${i}`} label="A→K" onClick={() => onFoundation(i)} />
            );
          })}
        </div>

        {/* 場札8列 */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 6, alignItems: "start" }}>
          {state.columns.map((col, ci) => (
            <div key={ci} style={{ display: "flex", flexDirection: "column" }}>
              {col.length === 0 ? (
                <EmptySlot label="空き列" onClick={() => onEmptyColumn(ci)} highlight={selected !== null} />
              ) : (
                col.map((card, pi) => {
                  const isSelected =
                    selected?.kind === "column" && selected.column === ci && pi >= selected.startIndex;
                  return (
                    <div
                      key={card.id}
                      style={{ marginTop: pi === 0 ? 0 : -32, zIndex: pi, position: "relative" }}
                    >
                      <CardFace card={card} selected={isSelected} onClick={() => onColumnCard(ci, pi)} />
                    </div>
                  );
                })
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
