"use client";
// ソリティア（クロンダイク）。ロジックは lib/solitaire.ts。
// クリックで選択 → 移動先クリックで移動。ダブルクリックで組札へ自動移動。
// ドラッグは使わず、スマホでもタップだけで完結する。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  autoFinishSolitaire,
  autoMoveToFoundation,
  canAutoFinish,
  canStackOnFoundation,
  drawFromStock,
  foundationTotal,
  isRedSuit,
  moveFoundationToTableau,
  moveTableauToFoundation,
  moveTableauToTableau,
  moveWasteToFoundation,
  moveWasteToTableau,
  createSolitaire,
  rankLabel,
  suitSymbol,
  tryMoveToFoundation,
  SUITS,
  type SolCard,
  type SolState,
} from "@/lib/solitaire";
import { useGamesNav } from "../GamesShell";
import { sfxFlip, sfxPlace, sfxTap, sfxWin } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";

type Selection =
  | { kind: "waste" }
  | { kind: "tableau"; col: number; index: number }
  | { kind: "foundation"; pile: number };

const CARD_W = "min(12.6vw, 70px)";

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function SolitaireClient() {
  const { prefix } = useGamesNav();
  const [game, setGame] = useState<SolState>(() => createSolitaire(Date.now() % 2147483647));
  const [history, setHistory] = useState<SolState[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      if (startRef.current !== null && game.status === "playing") {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }
    }, 500);
    return () => clearInterval(id);
  }, [game.status]);

  /** 移動を試みる。合法なら履歴に積んで状態を差し替え、選択は必ず解除する。 */
  const attempt = (next: SolState, silent = false) => {
    setSelection(null);
    if (next === game) return;
    if (next.status === "won") sfxWin();
    else if (!silent) sfxPlace();
    if (startRef.current === null) startRef.current = Date.now();
    setHistory((h) => [...h, game]);
    setGame(next);
  };

  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setGame(prev);
    setSelection(null);
  };

  const restart = () => {
    setGame(createSolitaire(Date.now() % 2147483647));
    setHistory([]);
    setSelection(null);
    setElapsed(0);
    startRef.current = null;
  };

  const autoAll = () => {
    let s = game;
    for (let i = 0; i < 52; i++) {
      const next = autoMoveToFoundation(s);
      if (next === s) break;
      s = next;
    }
    attempt(s);
  };

  const moveSelectionToTableau = (col: number) => {
    if (!selection) return;
    if (selection.kind === "waste") attempt(moveWasteToTableau(game, col));
    else if (selection.kind === "tableau") {
      if (selection.col === col) {
        setSelection(null);
        return;
      }
      attempt(moveTableauToTableau(game, selection.col, selection.index, col));
    } else attempt(moveFoundationToTableau(game, selection.pile, col));
  };

  const moveSelectionToFoundation = () => {
    if (!selection) return;
    if (selection.kind === "waste") attempt(moveWasteToFoundation(game));
    else if (selection.kind === "tableau") {
      const pile = game.tableau[selection.col];
      if (pile && selection.index === pile.length - 1) {
        attempt(moveTableauToFoundation(game, selection.col));
      } else setSelection(null);
    } else setSelection(null);
  };

  const onTableauCard = (col: number, index: number) => {
    const card = game.tableau[col][index];
    if (selection) {
      if (selection.kind === "tableau" && selection.col === col) {
        // 同じ列なら選択し直す（表向きのカードだけ）
        if (card.faceUp) setSelection({ kind: "tableau", col, index });
        return;
      }
      moveSelectionToTableau(col);
      return;
    }
    if (card.faceUp) {
      sfxTap();
      setSelection({ kind: "tableau", col, index });
    }
  };

  const onFoundation = (pile: number) => {
    if (selection && selection.kind !== "foundation") {
      moveSelectionToFoundation();
      return;
    }
    if (game.foundations[pile].length > 0) {
      sfxTap();
      setSelection(
        selection?.kind === "foundation" && selection.pile === pile
          ? null
          : { kind: "foundation", pile },
      );
    }
  };

  const hintFoundation = (card: SolCard | null): boolean =>
    card !== null && game.foundations.some((pile) => canStackOnFoundation(card, pile));

  const cardStyle = (card: SolCard, selected: boolean): CSSProperties => ({
    width: CARD_W,
    aspectRatio: "5 / 7",
    borderRadius: 6,
    border: selected ? "2px solid #d97706" : "1px solid #9ca3af",
    boxShadow: selected ? "0 0 0 3px rgba(245,179,1,0.55)" : "0 1px 2px rgba(0,0,0,0.2)",
    background: card.faceUp
      ? "#ffffff"
      : "repeating-linear-gradient(45deg,#31579e 0 6px,#26467f 6px 12px)",
    color: isRedSuit(card.suit) ? "#c62828" : "#1f2937",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    padding: "2px 4px",
    fontWeight: 700,
    fontSize: "clamp(10px, 2.6vw, 15px)",
    lineHeight: 1.15,
    cursor: "pointer",
    boxSizing: "border-box",
    flexShrink: 0,
    position: "relative",
    zIndex: selected ? 5 : undefined,
    touchAction: "manipulation",
  });

  const slotStyle = (highlight: boolean): CSSProperties => ({
    width: CARD_W,
    aspectRatio: "5 / 7",
    borderRadius: 6,
    border: highlight ? "2px solid #d97706" : "2px dashed rgba(107,114,128,0.6)",
    background: "rgba(255,255,255,0.08)",
    color: "rgba(107,114,128,0.8)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "clamp(12px, 3vw, 20px)",
    cursor: "pointer",
    boxSizing: "border-box",
    flexShrink: 0,
    padding: 0,
    touchAction: "manipulation",
  });

  const btnStyle: CSSProperties = {
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid #9ca3af",
    background: "#ffffff",
    color: "#1f2937",
    fontSize: 14,
    cursor: "pointer",
  };

  // 盤面の左右スワイプ: 左=1手もどる、右=組札へ自動移動（仕上げ可能なら自動で仕上げる）。
  // ジェスチャは横方向だけのため touchAction は pan-y とし、縦スクロールを奪わない。
  const boardGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "left") undo();
      else if (dir === "right") {
        if (canAutoFinish(game)) attempt(autoFinishSolitaire(game));
        else autoAll();
      }
    },
  });

  const wasteTop = game.waste.length > 0 ? game.waste[game.waste.length - 1] : null;
  const stockTop = game.stock.length > 0 ? game.stock[game.stock.length - 1] : null;

  const renderCard = (
    card: SolCard,
    selected: boolean,
    onClick: () => void,
    onDoubleClick?: () => void,
    extra?: CSSProperties,
  ) => (
    <div
      {...tappableProps(onClick)}
      aria-label={
        card.faceUp
          ? `${suitSymbol(card.suit)} ${rankLabel(card.rank)}`
          : "裏向きのカード"
      }
      aria-pressed={selected}
      onDoubleClick={onDoubleClick}
      className={card.faceUp ? "juice-flip" : undefined}
      style={{ ...cardStyle(card, selected), ...extra }}
    >
      {card.faceUp ? (
        <>
          <span>
            {rankLabel(card.rank)}
            {suitSymbol(card.suit)}
          </span>
          <span style={{ fontSize: "clamp(14px, 4vw, 24px)", alignSelf: "center", marginTop: "auto", marginBottom: "auto" }} aria-hidden="true">
            {suitSymbol(card.suit)}
          </span>
        </>
      ) : null}
    </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ソリティア</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ソリティア</h1>
        <p className="muted">
          クロンダイク形式の定番カードゲーム。カードをタップで選んで移動先をタップ。ダブルタップで組札へ送れます。盤面を左スワイプでもどる、右スワイプで組札へ自動移動。
        </p>
      </div>

      <p className="classic-status" role="status">
        {game.moves} 手 ・ 経過 {formatTime(elapsed)} ・ 組札 {foundationTotal(game)} / 52
        {game.status === "won" ? ` ・ 全てそろいました！ ${game.moves} 手、${formatTime(elapsed)} でクリアです。` : ""}
      </p>

      <div {...boardGesture} style={{ maxWidth: 580, margin: "0 auto", padding: "4px 2px", touchAction: "pan-y" }}>
        {/* 上段: ストック / 捨て札 / 組札 */}
        <div style={{ display: "flex", gap: "1.4vw", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ display: "flex", gap: "1.4vw" }}>
            {stockTop ? (
              renderCard(stockTop, false, () => { sfxFlip(); attempt(drawFromStock(game), true); })
            ) : (
              <div
                {...tappableProps(() => { sfxFlip(); attempt(drawFromStock(game), true); })}
                style={slotStyle(false)}
                aria-label="捨て札を戻して再循環"
              >
                ↻
              </div>
            )}
            {wasteTop ? (
              renderCard(
                wasteTop,
                selection?.kind === "waste",
                () => {
                  sfxTap();
                  setSelection(selection?.kind === "waste" ? null : { kind: "waste" });
                },
                () => attempt(tryMoveToFoundation(game, { kind: "waste" })),
              )
            ) : (
              <div style={slotStyle(false)} aria-hidden="true" />
            )}
          </div>
          <div style={{ display: "flex", gap: "1.4vw" }}>
            {game.foundations.map((pile, i) => {
              const top = pile.length > 0 ? pile[pile.length - 1] : null;
              const selected = selection?.kind === "foundation" && selection.pile === i;
              return top ? (
                <span key={i}>{renderCard(top, selected, () => onFoundation(i))}</span>
              ) : (
                <div
                  key={i}
                  {...tappableProps(() => onFoundation(i))}
                  style={slotStyle(selected)}
                  aria-label={`組札 ${i + 1}（空）`}
                >
                  <span style={{ color: isRedSuit(SUITS[i]) ? "#c62828" : "#4b5563" }}>
                    {suitSymbol(SUITS[i])}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 8px" }} role="status">
          山札 {game.stock.length} 枚
          {hintFoundation(wasteTop) ? " ・ 捨て札を組札へ送れます" : ""}
        </p>

        {/* 場札 */}
        <div style={{ display: "flex", gap: "1.4vw", justifyContent: "space-between" }} role="grid" aria-label="ソリティアの場札">
          {game.tableau.map((pile, col) => (
            <div key={col} style={{ display: "flex", flexDirection: "column", width: CARD_W }}>
              {pile.length === 0 ? (
                <div
                  {...tappableProps(() => moveSelectionToTableau(col))}
                  style={slotStyle(selection !== null)}
                  aria-label={`場札 ${col + 1}（空）`}
                >
                  K
                </div>
              ) : (
                pile.map((card, index) => {
                  const selected =
                    selection?.kind === "tableau" &&
                    selection.col === col &&
                    index >= selection.index;
                  const overlap = index === 0 ? 0 : card.faceUp ? -0.95 : -1.1;
                  return (
                    <span
                      key={card.id}
                      style={{
                        marginTop: index === 0 ? 0 : `calc(${CARD_W} * ${overlap})`,
                        display: "block",
                      }}
                    >
                      {renderCard(
                        card,
                        selected,
                        () => onTableauCard(col, index),
                        index === pile.length - 1
                          ? () => attempt(tryMoveToFoundation(game, { kind: "tableau", col }))
                          : undefined,
                      )}
                    </span>
                  );
                })
              )}
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 16 }}>
        <button type="button" style={btnStyle} onClick={restart}>
          もう一度
        </button>
      </div>

      {game.status === "won" ? (
        <div style={{ maxWidth: 580, margin: "16px auto 0" }}>
          <EndScreen outcome="win" title="クリア！" onRetry={restart}>
            <p className="muted" style={{ margin: 0 }}>
              {game.moves} 手、{formatTime(elapsed)} でクリアです。お見事でした。
            </p>
          </EndScreen>
        </div>
      ) : null}
    </>
  );
}
