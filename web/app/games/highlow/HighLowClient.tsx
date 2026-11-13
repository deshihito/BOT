"use client";
// ハイ＆ロー。ロジックは lib/highlow.ts。
// 次のカードが今より高いか低いかを当て続ける。外すと終了、同数は引き分けで続行。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { sfxCorrect, sfxLose, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
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
import { useGesture } from "@/lib/gesture";

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

  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    if (prevStatusRef.current !== "finished" && state.status === "finished") {
      if (state.finishReason === "cleared") sfxWin();
      else sfxLose();
    }
    prevStatusRef.current = state.status;
  }, [state.status, state.finishReason]);

  const onGuess = (dir: "high" | "low") => {
    if (state.status !== "playing") return;
    const next = guessHighLow(state, dir);
    if (next.last) {
      if (next.last.result === "correct") sfxCorrect();
      else if (next.last.result === "draw") sfxTap();
    }
    setState(next);
  };

  // カードエリアのスワイプに一本化: 上スワイプ=高い / 下スワイプ=低い。
  const cardGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "up") onGuess("high");
      else if (dir === "down") onGuess("low");
    },
  });

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
        <p className="muted">カードを上へスワイプすると「高い」、下へスワイプすると「低い」で、次のカードを予想します。</p>
      </div>

      <p className="classic-status" role="status">
        連続 {state.streak} 回 ・ ベスト {Math.max(best, state.bestStreak)} 回 ・ 残り {highLowRemaining(state)} 枚 ・ {lastText}
        {state.status === "finished"
          ? state.finishReason === "cleared"
            ? " 山札を全部使い切った！クリアです。"
            : " ゲーム終了。"
          : ""}
      </p>

      <div {...cardGesture} style={{ display: "flex", gap: 18, alignItems: "center", justifyContent: "center", margin: "14px 0 20px", flexWrap: "wrap", touchAction: "none", cursor: state.status === "playing" ? "grab" : "default" }} aria-label="カードエリア: 上スワイプで高い、下スワイプで低い">
        <div key={`${current}-${state.streak}`} className="juice-flip" style={{ textAlign: "center" }}>
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
        <div aria-hidden="true" style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <div style={{ padding: "10px 26px", fontSize: 17, fontWeight: 800, borderRadius: 12, border: "2px solid #b3543f", background: "#fdf0ec", color: "#93392a" }}>
            ↑ スワイプ: 高い
          </div>
          <div style={{ padding: "10px 26px", fontSize: 17, fontWeight: 800, borderRadius: 12, border: "2px solid #2e6da4", background: "#ecf4fb", color: "#1d4e79" }}>
            ↓ スワイプ: 低い
          </div>
        </div>
      ) : (
        <EndScreen
          outcome={state.finishReason === "cleared" ? "win" : "lose"}
          title={state.finishReason === "cleared" ? "全カード制覇！" : `連続 ${state.bestStreak} 回で終了`}
          score={state.bestStreak}
          scoreLabel="連続正解"
          previousBest={best > state.bestStreak ? best : undefined}
          onRetry={() => setState(newGame())}
        >
          <p className="muted" style={{ textAlign: "center" }}>正解 {state.correctTotal} 回 ・ ベスト記録 {Math.max(best, state.bestStreak)} 回</p>
        </EndScreen>
      )}
    </>
  );
}
