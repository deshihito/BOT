"use client";
// ブロックスパズル。ロジックは lib/blockpuzzle.ts（シード決定的・回転なし）。
// 下のブロックを選んで盤をタップすると配置。縦・横・3x3 がそろうと消える。端末内で完結する。
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  BP_SHAPES,
  BP_SIZE,
  canPlacePiece,
  createBlockPuzzleGame,
  pieceFitsAnywhere,
  placePiece,
  type BpState,
} from "@/lib/blockpuzzle";
import { useGamesNav } from "../GamesShell";

const CELL_COLORS = ["#e2534a", "#3f8f4f", "#3366cc", "#e8a13a", "#8a55c7"];
const BEST_KEY = "ago-blockpuzzle-best";

function newGame(): BpState {
  return createBlockPuzzleGame(Date.now() % 2147483647);
}

export default function BlockPuzzleClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<BpState>(() => newGame());
  const [selected, setSelected] = useState<number | null>(0);
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  useEffect(() => {
    if (state.status !== "over") return;
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
    setSelected(0);
    setHover(null);
  };

  const onCellClick = (r: number, c: number) => {
    if (selected === null || state.status !== "playing") return;
    const next = placePiece(state, selected, r, c);
    if (next === state) return; // 置けない場所は無反応（選択は維持）
    setState(next);
    const nextUnused = next.pieces.findIndex((p) => !p.used);
    setSelected(nextUnused >= 0 ? nextUnused : null);
  };

  // プレビュー表示用: 選択中ブロックが hover 位置に置けるかと、覆うマスの集合。
  let ghost = new Set<number>();
  let ghostOk = false;
  if (selected !== null && hover && state.status === "playing") {
    const piece = state.pieces[selected];
    if (piece && !piece.used) {
      ghostOk = canPlacePiece(state.board, piece.shape, hover.r, hover.c);
      for (const [dr, dc] of BP_SHAPES[piece.shape].cells) {
        const rr = hover.r + dr;
        const cc = hover.c + dc;
        if (rr >= 0 && cc >= 0 && rr < BP_SIZE && cc < BP_SIZE) ghost.add(rr * BP_SIZE + cc);
      }
    }
  }

  const statusText =
    state.status === "over"
      ? "置けるブロックがなくなりました。"
      : selected === null
        ? "下のブロックを選んでください。"
        : "盤をタップして配置。縦・横・3x3 がそろうと消えます。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ブロックスパズル</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ブロックスパズル</h1>
        <p className="muted">下のブロックを選んで、盤をタップして配置します。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        スコア {state.score} ・ 消去 {state.lines} ライン
        {best !== null ? ` ・ ベスト ${best}` : ""} ・ {statusText}
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${BP_SIZE}, minmax(0, 1fr))`,
          gap: 3,
          width: "100%",
          maxWidth: 450,
          margin: "0 auto",
        }}
        role="grid"
        aria-label="ブロックスパズルの盤"
        onMouseLeave={() => setHover(null)}
      >
        {state.board.map((cell, i) => {
          const r = Math.floor(i / BP_SIZE);
          const c = i % BP_SIZE;
          const isGhost = ghost.has(i);
          const boxEdge = {
            borderRight: c % 3 === 2 && c !== BP_SIZE - 1 ? "2px solid #9aa3ad" : undefined,
            borderBottom: r % 3 === 2 && r !== BP_SIZE - 1 ? "2px solid #9aa3ad" : undefined,
          };
          const bg =
            cell !== null
              ? CELL_COLORS[cell]
              : isGhost
                ? ghostOk
                  ? CELL_COLORS[state.pieces[selected ?? 0]?.color ?? 0] + "88"
                  : "#e2534a55"
                : "#eef1f4";
          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              aria-label={cell !== null ? "埋まったマス" : "空きマス"}
              onClick={() => onCellClick(r, c)}
              onMouseEnter={() => setHover({ r, c })}
              onFocus={() => setHover({ r, c })}
              style={{
                aspectRatio: "1",
                minWidth: 0,
                border: "1px solid #d4d9de",
                borderRadius: 4,
                background: bg,
                cursor: selected !== null && state.status === "playing" ? "pointer" : "default",
                padding: 0,
                ...boxEdge,
              }}
            />
          );
        })}
      </div>

      <div
        style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 16, flexWrap: "wrap" }}
        role="group"
        aria-label="置くブロック"
      >
        {state.pieces.map((piece, idx) => {
          const shapeDef = BP_SHAPES[piece.shape];
          const maxR = Math.max(...shapeDef.cells.map(([dr]) => dr)) + 1;
          const maxC = Math.max(...shapeDef.cells.map(([, dc]) => dc)) + 1;
          const filled = new Set(shapeDef.cells.map(([dr, dc]) => dr * maxC + dc));
          const fits = !piece.used && pieceFitsAnywhere(state.board, piece.shape);
          const isSel = selected === idx && !piece.used;
          return (
            <button
              key={idx}
              type="button"
              disabled={piece.used}
              aria-pressed={isSel}
              aria-label={`ブロック ${idx + 1}${piece.used ? "（使用済み）" : fits ? "" : "（置ける場所なし）"}`}
              onClick={() => setSelected(idx)}
              style={{
                padding: 8,
                border: isSel ? "2px solid #3366cc" : "2px solid #d4d9de",
                borderRadius: 8,
                background: piece.used ? "#f3f4f6" : "#fff",
                opacity: piece.used ? 0.35 : fits ? 1 : 0.55,
                cursor: piece.used ? "default" : "pointer",
                minWidth: 76,
                minHeight: 76,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(${maxC}, 14px)`,
                  gap: 2,
                }}
                aria-hidden="true"
              >
                {Array.from({ length: maxR * maxC }, (_, i) => (
                  <span
                    key={i}
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      background: filled.has(i) ? CELL_COLORS[piece.color] : "transparent",
                    }}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      {state.status === "over" ? (
        <p className="classic-status" role="status">
          最終スコア {state.score} 点（配置 {state.placedCells} マス / 消去 {state.lines} ライン）
        </p>
      ) : null}
    </>
  );
}
