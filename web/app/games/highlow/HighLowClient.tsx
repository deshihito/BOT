"use client";
// ハイ＆ロー。ロジックは lib/highlow.ts。
// 次のカードが今より高いか低いかを当て続ける。外すと終了、同数は引き分けで続行。
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  createHighLowGame,
  guessHighLow,
  highLowCardName,
  highLowCurrent,
  highLowRankLabel,
  highLowRemaining,
  highLowSuit,
  isHighLowRed,
  type HighLowState,
} from "@/lib/highlow";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-highlow-best";

function CardFace({ card, dim }: { card: number; dim?: boolean }) {
  const red = isHighLowRed(card);
  return (
    <div
      role="img"
      aria-label={highLowCardName(card)}
      style={{
        width: 118,
        height: 164,
        borderRadius: 14,
        border: "2px solid #d8c9a3",
        background: "#fffdf6",
        color: red ? "#dc2626" : "#111827",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 2,
        opacity: dim ? 0.55 : 1,
        boxShadow: "0 4px 14px rgba(60, 45, 10, 0.12)",
        userSelect: "none",
      }}
    >
      <span style={{ fontSize: 44, fontWeight: 800, lineHeight: 1 }}>{highLowRankLabel(card)}</span>
      <span style={{ fontSize: 40, lineHeight: 1 }}>{highLowSuit(card)}</span>
    </div>
  );
}

function newGame(): HighLowState {
  return createHighLowGame(Date.now() % 2147483647);
}

export default function HighLowClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<HighLowState>(() => newGame());
  const [best, setBest] = useState(0);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : 0);
    } catch {
      setBest(0);
    }
  }, []);

  useEffect(() => {
    if (state.bestStreak <= best) return;
    setBest(state.bestStreak);
    try {
      window.localStorage.setItem(BEST_KEY, String(state.bestStreak));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.bestStreak, best]);

  const current = highLowCurrent(state);
  const last = state.last;
  const lastText = !last
    ? "次のカードが今のカードより高いか低いか、当ててみよう。同数は引き分けで続行できます。"
    : last.result === "correct"
      ? `${highLowCardName(last.card)} が出た！当たり。連続 ${state.streak} 回。`
      : last.result === "draw"
        ? `${highLowCardName(last.card)} で同数。引き分けで続行できます。`
        : `${highLowCardName(last.card)} が出て外れ。`;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ハイ＆ロー</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ハイ＆ロー</h1>
        <p className="muted">「高い」「低い」のボタンで、次のカードを予想します。</p>
      </div>

      <p className="classic-status" role="status">
        連続 {state.streak} 回 ・ ベスト {Math.max(best, state.bestStreak)} 回 ・ 残り {highLowRemaining(state)} 枚 ・ {lastText}
        {state.status === "finished"
          ? state.finishReason === "cleared"
            ? " 山札を全部使い切った！クリアです。"
            : " ゲーム終了。"
          : ""}
      </p>

      <div style={{ display: "flex", gap: 18, alignItems: "center", justifyContent: "center", margin: "14px 0 20px", flexWrap: "wrap" }}>
        <div style={{ textAlign: "center" }}>
          {current !== null ? <CardFace card={current} /> : null}
          <p className="muted" style={{ margin: "8px 0 0" }}>
            {last ? "今のカード（前にめくったカード）" : "最初のカード"}
          </p>
        </div>
        <div aria-hidden="true" style={{ fontSize: 30, fontWeight: 800 }}>→</div>
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              width: 118,
              height: 164,
              borderRadius: 14,
              border: "2px dashed #d8c9a3",
              background: "#f6f1e3",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 40,
              userSelect: "none",
            }}
          >
            ？
          </div>
          <p className="muted" style={{ margin: "8px 0 0" }}>次のカード</p>
        </div>
      </div>

      {state.status === "playing" ? (
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            style={{
              minHeight: 56,
              padding: "12px 34px",
              fontSize: 19,
              fontWeight: 800,
              borderRadius: 12,
              border: "2px solid #b3543f",
              background: "#fdf0ec",
              color: "#93392a",
              cursor: "pointer",
              touchAction: "manipulation",
            }}
            onClick={() => setState((s) => guessHighLow(s, "high"))}
          >
            ↑ 高い
          </button>
          <button
            type="button"
            style={{
              minHeight: 56,
              padding: "12px 34px",
              fontSize: 19,
              fontWeight: 800,
              borderRadius: 12,
              border: "2px solid #2e6da4",
              background: "#ecf4fb",
              color: "#1d4e79",
              cursor: "pointer",
              touchAction: "manipulation",
            }}
            onClick={() => setState((s) => guessHighLow(s, "low"))}
          >
            ↓ 低い
          </button>
        </div>
      ) : (
        <div style={{ textAlign: "center" }}>
          <p style={{ fontSize: 20, fontWeight: 800, margin: "6px 0" }}>
            {state.finishReason === "cleared" ? "🎉 全カード制覇！" : `連続 ${state.bestStreak} 回で終了`}
          </p>
          <p className="muted" style={{ margin: "4px 0 14px" }}>正解 {state.correctTotal} 回 ・ ベスト記録 {Math.max(best, state.bestStreak)} 回</p>
          <button
            type="button"
            className="classic-btn"
            style={{ minHeight: 48, padding: "10px 28px", fontSize: 16 }}
            onClick={() => setState(newGame())}
          >
            もう一度
          </button>
        </div>
      )}
    </>
  );
}
