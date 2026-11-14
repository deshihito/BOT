"use client";
// フリーセル。ロジックは lib/freecell.ts（移動検証・自動送り込み）。
// ドラッグではなくタップ選択式：カード（の山）をタップして選び、置き先をタップする。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const FreeCellScene3D = dynamic(() => import("./FreeCellScene3D"), { ssr: false });
import type { FcDragSource } from "./FreeCellScene3D";
import {
  autoMoveFreecell,
  createFreecell,
  freecellRemaining,
  isValidStack,
  maxMovableCards,
  moveFreecell,
  rankLabel,
  suitSymbol,
  undoFreecell,
  type FcCard,
  type FcSource,
  type FcState,
  type FcTarget,
} from "@/lib/freecell";
import { sfxFlip, sfxPlace, sfxSlide, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
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
    <div
      {...(onClick ? tappableProps(onClick) : { "aria-disabled": true })}
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
    </div>
  );
}

function EmptySlot({ label, onClick, highlight }: { label: string; onClick?: () => void; highlight?: boolean }) {
  return (
    <div
      {...(onClick ? tappableProps(onClick) : { "aria-disabled": true })}
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
    </div>
  );
}

export default function FreeCellClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<FcState>(() => newGame());
  const [webglFailed, setWebglFailed] = useState(false);
  const [selected, setSelected] = useState<Selection>(null);
  const [message, setMessage] = useState<string>("");
  const prevStatusRef = useRef(state.status);

  // 終局遷移の瞬間だけジングルを鳴らす。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev !== state.status && state.status === "won") sfxWin();
  }, [state.status]);

  const restart = () => {
    setState(newGame());
    setSelected(null);
    setMessage("");
  };

  const retrySameDeal = () => {
    setState(createFreecell(state.seed));
    setSelected(null);
    setMessage("同じ盤面で最初からやり直します。");
  };

  const onUndo = () => {
    const next = undoFreecell(state);
    if (next !== state) {
      sfxSlide();
      setState(next);
      setSelected(null);
      setMessage("一手戻しました。");
    }
  };

  const tryMove = (source: FcSource, target: FcTarget, count: number) => {
    const next = moveFreecell(state, source, target, count);
    if (next !== state) {
      if (next.status !== "won") sfxPlace();
      setState(next);
      setSelected(null);
      setMessage(next.status === "won" ? "全部そろいました。クリア！" : "");
      return true;
    }
    sfxWrong();
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
      sfxWrong();
      setMessage("そのカードからは正しい並びで持てません。");
      return;
    }
    if (stack.length > maxMovableCards(state)) {
      sfxTap();
      setMessage(`今は最大 ${maxMovableCards(state)} 枚までしかまとめて動かせません。`);
      // 持てる範囲（先頭=一番手前のカード）に絞って選択する。
      setSelected({ kind: "column", column, startIndex: col.length - 1 });
      return;
    }
    sfxTap();
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
      sfxTap();
      setSelected(selected?.kind === "freecell" && selected.index === index ? null : { kind: "freecell", index });
      setMessage("");
    }
  };

  const onFoundation = (index: number) => {
    if (!selected) return;
    if (selectionCount() !== 1) {
      sfxWrong();
      setMessage("組札へは1枚ずつだけ送れます。");
      return;
    }
    const src = selectionSource();
    if (src) tryMove(src, { kind: "foundation", index }, 1);
  };

  const onAuto = () => {
    const next = autoMoveFreecell(state);
    if (next !== state) {
      if (next.status !== "won") sfxFlip();
      setState(next);
      setSelected(null);
      setMessage(next.status === "won" ? "全部そろいました。クリア！" : "安全に送れるカードを組札へ送りました。");
    } else {
      sfxWrong();
      setMessage("今は安全に送れるカードがありません。");
    }
  };

  const remaining = freecellRemaining(state);

  // 3D シーンのドラッグ落下: タップ移動と同じ tryMove で判定し、成否を返す。
  const onDragDrop = (source: FcDragSource, target: FcTarget): boolean => {
    if (source.kind === "freecell") {
      return tryMove({ kind: "freecell", index: source.index }, target, 1);
    }
    const count = state.columns[source.column].length - source.startIndex;
    if (count < 1) return false;
    return tryMove({ kind: "column", column: source.column }, target, count);
  };

  // 盤面の横スワイプ: 左=1手戻す、右=自動送り（solitaire と同じ）。
  const handleBoardSwipe = (dir: "left" | "right") => {
    if (dir === "left") onUndo();
    else if (dir === "right") onAuto();
  };

  // 子の札の onClick との二重発火は useGesture の suppressClickAfterSwipe が抑止する。
  // 縦スクロールは残すため touchAction は pan-y。
  const boardGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "left" || dir === "right") handleBoardSwipe(dir);
    },
  });

  // U / A キーでも同じ操作ができる（札の div は Enter/Space のみのため二重発火なし）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "u" || e.key === "U") onUndo();
      else if (e.key === "a" || e.key === "A") onAuto();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onUndo, onAuto]);

  // 2D 盤面（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
      <div
        {...boardGesture}
        aria-label="フリーセルの盤（左にスワイプで1手戻す、右にスワイプで自動送り）"
        style={{ maxWidth: 560, margin: "0 auto", touchAction: "pan-y" }}
      >
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
  );

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
          カードをタップして選び、置き先をタップして動かします。色を交互に小さい順に重ね、全カードを組札（A→K）へそろえればクリア。盤面を左にスワイプで1手戻す、右にスワイプで自動送りします。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={retrySameDeal}>
          同じ盤面でもう一度
        </button>
        <button type="button" className="classic-btn" onClick={restart}>
          新しい盤面
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

      {webglFailed ? board2d : (
        <div style={{ maxWidth: 560, margin: "0 auto" }}>
          <FreeCellScene3D
            state={state}
            selected={selected}
            onColumnCardTap={onColumnCard}
            onEmptyColumnTap={onEmptyColumn}
            onFreeCellTap={onFreeCell}
            onFoundationTap={onFoundation}
            onDragDrop={onDragDrop}
            onBoardSwipe={handleBoardSwipe}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      {state.status === "won" && (
        <div style={{ maxWidth: 560, margin: "16px auto 0" }}>
          <EndScreen outcome="win" title="クリア！" score={state.moves} scoreLabel="手数" onRetry={restart} retryLabel="新しい盤面">
            <p className="muted">全カードを組札へそろえました。</p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
