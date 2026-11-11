"use client";
// ゴルフ（ソリティア）。ロジックは lib/golf.ts。
// 台札と ±1 の関係にある列の一番下のカードをタップして取る。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useState } from "react";
import {
  createGolf,
  flipGolfStock,
  golfIsRed,
  golfPlayableColumns,
  golfRankLabel,
  golfRemaining,
  golfSuitSymbol,
  golfWasteTop,
  takeGolf,
  type GolfCard,
  type GolfState,
} from "@/lib/golf";
import { useGamesNav } from "../GamesShell";

function newGame(): GolfState {
  return createGolf(Date.now() % 2147483647);
}

function CardFace({ card }: { card: GolfCard }) {
  const red = golfIsRed(card.suit);
  return (
    <span
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "flex-start",
        padding: "3px 5px",
        fontWeight: 700,
        fontSize: 14,
        color: red ? "#dc2626" : "#111827",
      }}
    >
      {golfSuitSymbol(card.suit)}
      {golfRankLabel(card.rank)}
    </span>
  );
}

export default function GolfClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<GolfState>(() => newGame());

  const restart = () => setState(newGame());
  const playable = golfPlayableColumns(state);
  const wasteTop = golfWasteTop(state);
  const remaining = golfRemaining(state);

  const statusText =
    state.status === "won"
      ? "場札を全部取った！クリアです。"
      : state.status === "stuck"
        ? `終了です。残り ${remaining} 枚でした。`
        : playable.length > 0
          ? "光っているカードは台札へ取れます。"
          : state.stock.length > 0
            ? "取れるカードがありません。山札をめくりましょう。"
            : "取れるカードがありません。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ゴルフ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ゴルフソリティア</h1>
        <p className="muted">
          台札と数字が1つ違いのカードが光ります。光ったカードをタップすると台札へ取れます。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        <button
          type="button"
          className="classic-btn"
          onClick={() => setState((s) => flipGolfStock(s))}
          disabled={state.stock.length === 0 || state.status !== "playing"}
        >
          山札をめくる（残り{state.stock.length}枚）
        </button>
      </div>

      <p className="classic-status" role="status">
        手数 {state.moves} ・ 取った枚数 {state.taken} ・ 場の残り {remaining} 枚 ・ {statusText}
      </p>

      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "flex-start",
          justifyContent: "center",
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div
            role="img"
            aria-label={wasteTop ? `台札 ${golfRankLabel(wasteTop.rank)}` : "台札なし"}
            style={{
              width: 62,
              height: 84,
              borderRadius: 8,
              border: "2px solid #2563eb",
              background: "#eff6ff",
              boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
            }}
          >
            {wasteTop ? <CardFace card={wasteTop} /> : null}
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>台札</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div
            aria-hidden="true"
            style={{
              width: 62,
              height: 84,
              borderRadius: 8,
              border: "1px solid #94a3b8",
              background: state.stock.length > 0 ? "#334155" : "#f1f5f9",
              color: "#e2e8f0",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 20,
            }}
          >
            {state.stock.length > 0 ? "🂠" : ""}
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>
            山札 {state.stock.length}枚
          </div>
        </div>
      </div>

      <div
        role="group"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          gap: 4,
          maxWidth: 720,
          margin: "0 auto",
        }}
        aria-label="ゴルフの場札"
      >
        {state.columns.map((pile, col) => (
          <div key={col} style={{ display: "flex", flexDirection: "column" }}>
            {pile.length === 0 ? (
              <div
                style={{
                  height: 62,
                  borderRadius: 7,
                  border: "1px dashed #cbd5e1",
                  background: "#f8fafc",
                  color: "#94a3b8",
                  fontSize: 11,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                空
              </div>
            ) : (
              pile.map((card, index) => {
                const isTop = index === pile.length - 1;
                const canTake = isTop && playable.includes(col);
                return (
                  <button
                    key={card.id}
                    type="button"
                    disabled={!canTake}
                    aria-label={`${golfSuitSymbol(card.suit)}の${golfRankLabel(card.rank)}${canTake ? "（取れます）" : ""}`}
                    onClick={() => setState((s) => takeGolf(s, col))}
                    style={{
                      height: 62,
                      marginTop: index === 0 ? 0 : -38,
                      borderRadius: 7,
                      border: canTake ? "2px solid #d97706" : "1px solid #cbd5e1",
                      background: canTake ? "#fef3c7" : "#ffffff",
                      padding: 0,
                      textAlign: "left",
                      cursor: canTake ? "pointer" : "default",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.10)",
                      zIndex: index,
                      position: "relative",
                      opacity: isTop ? 1 : 0.85,
                    }}
                  >
                    <CardFace card={card} />
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
