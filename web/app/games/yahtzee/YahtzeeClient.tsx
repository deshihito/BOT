"use client";
// ヤッツィー。ロジックは lib/yahtzee.ts。
// ダイス5個を振り（振り直し最大2回）、13カテゴリへ順に記録していく。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const YahtzeeScene3D = dynamic(() => import("./YahtzeeScene3D"), { ssr: false });
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
import { tappableProps, useGesture } from "@/lib/gesture";
import { sfxDice, sfxPlace, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";

const DICE_FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

export default function YahtzeeClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [state, setState] = useState<YahtzeeState>(() =>
    createYahtzee(Date.now() % 2147483647),
  );
  const [best, setBest] = useState<number | null>(null);
  const prevBestRef = useRef<number | null>(null);
  const endSoundRef = useRef<YahtzeeState | null>(null);

  const totals = yahtzeeTotals(state);
  const finished = state.status === "finished";

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem("ago-yahtzee-best"));
      const loaded = Number.isFinite(saved) && saved > 0 ? saved : null;
      setBest(loaded);
      prevBestRef.current = loaded;
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

  useEffect(() => {
    if (!finished) return;
    if (endSoundRef.current === state) return;
    endSoundRef.current = state;
    sfxWin();
  }, [finished, state]);

  const restart = () => {
    prevBestRef.current = best;
    setState(createYahtzee(Date.now() % 2147483647));
  };

  const roll = () => {
    sfxDice();
    setState((s) => rollYahtzeeDice(s));
  };
  // ダイストレイ（ダイスの下の受け皿）をタップ/フリックで振る。ボタンは置かない。
  const trayGesture = useGesture({
    onTap: () => { if (!finished && rollsLeft > 0) roll(); },
    onSwipe: () => { if (!finished && rollsLeft > 0) roll(); },
  });
  const toggleHold = (i: number) => {
    sfxTap();
    setState((s) => toggleYahtzeeHold(s, i));
  };
  const record = (category: (typeof YAHTZEE_CATEGORIES)[number]) => {
    sfxPlace();
    setState((s) => applyYahtzeeScore(s, category));
  };

  const rollsLeft = MAX_ROLLS_PER_TURN - state.rollsUsed;
  const statusText = finished
    ? `全13ターン終了！ 合計 ${totals.total} 点でした。`
    : state.rollsUsed === 0
      ? `ターン ${state.turnsDone + 1}/13 ・ まずダイスを振ってください。`
      : `ターン ${state.turnsDone + 1}/13 ・ 振り直しはあと ${rollsLeft} 回。記録する役を選んでください。`;

  const diceArea2d = (
    <>
    <div
      style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", margin: "6px 0" }}
      role="group"
      aria-label="ダイス（タップで保持）"
    >
      {state.dice.map((d, i) => {
        const held = state.held[i];
        return (
          <div
            key={`${state.turnsDone}-${state.rollsUsed}-${i}-${d}`}
            className="juice-flip"
            {...tappableProps(() => { if (!finished && state.rollsUsed > 0) toggleHold(i); })}
            aria-disabled={finished || state.rollsUsed === 0}
            aria-pressed={held}
            aria-label={`ダイス ${d}${held ? "（保持中）" : ""}`}
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
          </div>
        );
      })}
    </div>

    <div
      {...trayGesture}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !finished && rollsLeft > 0) { e.preventDefault(); roll(); } }}
      aria-disabled={finished || rollsLeft <= 0}
      aria-label="ダイストレイ（タップで振る）"
      style={{
        maxWidth: 420, margin: "8px auto 14px", padding: "12px 16px", textAlign: "center",
        borderRadius: 12, border: "2px dashed #b9a86a", background: "#fdf6da",
        fontWeight: 700, cursor: finished || rollsLeft <= 0 ? "default" : "pointer",
        opacity: finished || rollsLeft <= 0 ? 0.5 : 1, touchAction: "none", userSelect: "none",
      }}
    >
      ダイストレイ — タップで振る{state.rollsUsed > 0 ? `（あと ${rollsLeft} 回）` : ""}
    </div>
    </>
  );

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

      {webglFailed ? (
        diceArea2d
      ) : (
        <YahtzeeScene3D
          dice={state.dice}
          held={state.held}
          rollsUsed={state.rollsUsed}
          canRoll={!finished && rollsLeft > 0}
          canHold={!finished && state.rollsUsed > 0}
          onToggleHold={toggleHold}
          onRoll={roll}
          onFail={() => setWebglFailed(true)}
          fallback={diceArea2d}
        />
      )}

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
              <div
                {...tappableProps(() => { if (canRecord) record(category); })}
                aria-disabled={!canRecord}
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
              </div>
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

      {finished ? (
        <div style={{ maxWidth: 520, margin: "16px auto 0" }}>
          <EndScreen
            outcome="finish"
            score={totals.total}
            newBest={prevBestRef.current === null || totals.total > prevBestRef.current}
            previousBest={prevBestRef.current}
            onRetry={restart}
          >
            <p className="muted" style={{ margin: 0 }}>
              上段合計 {totals.upper} 点{totals.upperBonus > 0 ? `（ボーナス +${totals.upperBonus}）` : ""} ・ 下段合計 {totals.lower} 点
            </p>
          </EndScreen>
        </div>
      ) : null}
    </>
  );
}
