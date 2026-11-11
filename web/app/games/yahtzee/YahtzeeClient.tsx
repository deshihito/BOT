"use client";
// ヤッツィー。ロジックは lib/yahtzee.ts。
// ダイス5個を振り（振り直し最大2回）、13カテゴリへ順に記録していく。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  applyYahtzeeScore,
  createYahtzee,
  rollYahtzeeDice,
  toggleYahtzeeHold,
  yahtzeeScoreFor,
  yahtzeeTotals,
  MAX_ROLLS_PER_TURN,
  UPPER_BONUS,
  UPPER_BONUS_THRESHOLD,
  YAHTZEE_CATEGORIES,
  YAHTZEE_CATEGORY_LABELS,
  type YahtzeeState,
} from "@/lib/yahtzee";
import { useGamesNav } from "../GamesShell";

const DICE_FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

export default function YahtzeeClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<YahtzeeState>(() =>
    createYahtzee(Date.now() % 2147483647),
  );
  const [best, setBest] = useState<number | null>(null);

  const totals = yahtzeeTotals(state);
  const finished = state.status === "finished";

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem("ago-yahtzee-best"));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  useEffect(() => {
    if (!finished) return;
    if (best !== null && totals.total <= best) return;
    setBest(totals.total);
    try {
      window.localStorage.setItem("ago-yahtzee-best", String(totals.total));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [finished, totals.total, best]);

  const restart = () => {
    setState(createYahtzee(Date.now() % 2147483647));
  };

  const rollsLeft = MAX_ROLLS_PER_TURN - state.rollsUsed;
  const statusText = finished
    ? `全13ターン終了！ 合計 ${totals.total} 点でした。`
    : state.rollsUsed === 0
      ? `ターン ${state.turnsDone + 1}/13 ・ まずダイスを振ってください。`
      : `ターン ${state.turnsDone + 1}/13 ・ 振り直しはあと ${rollsLeft} 回。記録する役を選んでください。`;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ヤッツィー</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ヤッツィー</h1>
        <p className="muted">残したいダイスはタップで保持できます。振ったら、下のシートで記録する役を選んでください。</p>
      </div>

      <div className="classic-controls">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {statusText}
        {best !== null ? ` ・ ベスト ${best} 点` : ""}
      </p>

      <div
        style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", margin: "6px 0" }}
        role="group"
        aria-label="ダイス（タップで保持）"
      >
        {state.dice.map((d, i) => {
          const held = state.held[i];
          return (
            <button
              key={i}
              type="button"
              disabled={finished || state.rollsUsed === 0}
              aria-pressed={held}
              aria-label={`ダイス ${d}${held ? "（保持中）" : ""}`}
              onClick={() => setState((s) => toggleYahtzeeHold(s, i))}
              style={{
                width: 58,
                height: 58,
                fontSize: 44,
                lineHeight: 1,
                display: "grid",
                placeItems: "center",
                borderRadius: 12,
                border: held ? "3px solid #d9a41c" : "2px solid var(--line)",
                background: held ? "#fdf3d8" : "#fff",
                color: "#243447",
                cursor: state.rollsUsed > 0 ? "pointer" : "default",
                touchAction: "manipulation",
              }}
            >
              {DICE_FACES[d]}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "center", margin: "8px 0 14px" }}>
        <button
          type="button"
          className="classic-btn"
          disabled={finished || rollsLeft <= 0}
          onClick={() => setState((s) => rollYahtzeeDice(s))}
          style={{ minWidth: 180, fontWeight: 700 }}
        >
          🎲 ダイスを振る{state.rollsUsed > 0 ? `（あと ${rollsLeft} 回）` : ""}
        </button>
      </div>

      <div style={{ maxWidth: 520, margin: "0 auto" }} role="group" aria-label="スコアシート">
        {YAHTZEE_CATEGORIES.map((category, idx) => {
          const recorded = state.scores[idx];
          const candidate =
            recorded === null && state.rollsUsed > 0
              ? yahtzeeScoreFor(state.dice, category)
              : null;
          const canRecord = recorded === null && state.rollsUsed > 0 && !finished;
          return (
            <div key={category}>
              {idx === 6 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "6px 10px",
                    fontSize: 13,
                    color: "var(--muted)",
                    borderTop: "2px solid var(--line)",
                  }}
                >
                  <span>
                    上段合計 {totals.upper} / {UPPER_BONUS_THRESHOLD}（届けばボーナス +{UPPER_BONUS}）
                  </span>
                  <span>{totals.upperBonus > 0 ? `+${totals.upperBonus}` : ""}</span>
                </div>
              )}
              <button
                type="button"
                disabled={!canRecord}
                onClick={() => setState((s) => applyYahtzeeScore(s, category))}
                aria-label={
                  recorded !== null
                    ? `${YAHTZEE_CATEGORY_LABELS[category]} 記録済み ${recorded} 点`
                    : `${YAHTZEE_CATEGORY_LABELS[category]}${candidate !== null ? ` 候補 ${candidate} 点` : ""}`
                }
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  width: "100%",
                  minHeight: 40,
                  padding: "8px 10px",
                  border: "none",
                  borderTop: "1px solid var(--line)",
                  background: canRecord ? "#fff" : "transparent",
                  color: "var(--text)",
                  fontSize: 15,
                  cursor: canRecord ? "pointer" : "default",
                  touchAction: "manipulation",
                }}
              >
                <span>{YAHTZEE_CATEGORY_LABELS[category]}</span>
                <span style={{ fontWeight: 700 }}>
                  {recorded !== null ? (
                    recorded
                  ) : candidate !== null ? (
                    <span style={{ color: "#3f7fbf" }}>{candidate}</span>
                  ) : (
                    "—"
                  )}
                </span>
              </button>
            </div>
          );
        })}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "10px",
            borderTop: "2px solid var(--line)",
            fontWeight: 800,
            fontSize: 16,
          }}
        >
          <span>合計</span>
          <span>{totals.total} 点</span>
        </div>
      </div>

      <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
        青字は今のダイスでその役に記録した場合の点数です。1つの役には1回だけ記録できます。
      </p>
    </>
  );
}
