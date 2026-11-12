"use client";
// ダイスクエスト。ロジックは lib/dicequest.ts（スコアシート式ソロダイス）。
// 白ダイス2個＋色ダイス4個を振り、各行の候補から1マスだけチェックする。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyDqCheck,
  applyDqPass,
  createDiceQuestGame,
  dqCandidates,
  dqFinalNumber,
  dqIsRowClosed,
  dqRowNumbers,
  dqScore,
  rollDqDice,
  DQ_COLORS,
  DQ_COLOR_LABELS,
  DQ_DIRECTIONS,
  DQ_FINAL_MIN_CHECKS,
  DQ_MAX_FAILURES,
  type DqColor,
  type DqState,
} from "@/lib/dicequest";
import { useGamesNav } from "../GamesShell";
import { sfxDice, sfxPlace, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";

const ROW_STYLES: Record<DqColor, { bg: string; soft: string; text: string }> = {
  red: { bg: "#d64545", soft: "#fbe7e7", text: "#fff" },
  yellow: { bg: "#d9a404", soft: "#fdf3d3", text: "#fff" },
  green: { bg: "#2e8b57", soft: "#e2f2e7", text: "#fff" },
  blue: { bg: "#3b6fd4", soft: "#e3ecfc", text: "#fff" },
};

function DiceFace({ value, bg, label }: { value: number; bg: string; label: string }) {
  return (
    <span
      role="img"
      aria-label={`${label} ${value}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 44,
        height: 44,
        borderRadius: 9,
        background: bg,
        color: bg === "#ffffff" ? "#222" : "#fff",
        border: "2px solid rgba(0,0,0,0.25)",
        fontSize: 22,
        fontWeight: 800,
      }}
    >
      {value}
    </span>
  );
}

export default function DiceQuestClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<DqState>(() => createDiceQuestGame(Date.now() % 2147483647));

  const candidates = useMemo(() => dqCandidates(state), [state]);
  const score = useMemo(() => dqScore(state), [state]);
  const candidateKey = useMemo(
    () => new Set(candidates.map((c) => `${c.color}:${c.value}`)),
    [candidates],
  );

  const restart = () => setState(createDiceQuestGame(Date.now() % 2147483647));

  const endSoundRef = useRef<DqState | null>(null);
  useEffect(() => {
    if (state.phase !== "finished") return;
    if (endSoundRef.current === state) return;
    endSoundRef.current = state;
    sfxWin();
  }, [state]);

  const statusText =
    state.phase === "finished"
      ? "ゲーム終了です。"
      : state.phase === "roll"
        ? "サイコロを振ってください。"
        : candidates.length > 0
          ? "光っているマスから1つ選んでチェックします。"
          : "チェックできるマスがありません。失敗として次へ進みます。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ダイスクエスト</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ダイスクエスト</h1>
        <p className="muted">
          白ダイス2個の合計はどの行でも、色ダイスとの合計はその色の行で使えます。最後の数字は、その行で5つ以上チェック済みのときだけ取れます。チェックしないと失敗（-5点）です。
        </p>
      </div>

      <div className="classic-controls">
        <button
          type="button"
          className="classic-btn"
          disabled={state.phase !== "roll"}
          onClick={() => { sfxDice(); setState((s) => rollDqDice(s)); }}
        >
          サイコロを振る
        </button>
        <button
          type="button"
          className="classic-btn"
          disabled={state.phase !== "choice"}
          onClick={() => { sfxWrong(); setState((s) => applyDqPass(s)); }}
        >
          チェックしない（失敗+1）
        </button>
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        スコア {score.total} 点 ・ {state.rolls} 投目 ・ 失敗{" "}
        {Array.from({ length: DQ_MAX_FAILURES }, (_, i) => (i < state.failures ? "✗" : "・")).join("")} ・{" "}
        {statusText}
      </p>

      {state.dice && (
        <div
          key={state.rolls}
          className="juice-pop"
          role="group"
          aria-label="ダイスの目"
          style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", margin: "6px 0 14px" }}
        >
          <DiceFace value={state.dice.white[0]} bg="#ffffff" label="白ダイス" />
          <DiceFace value={state.dice.white[1]} bg="#ffffff" label="白ダイス" />
          <span className="muted" style={{ margin: "0 2px" }}>
            合計 {state.dice.white[0] + state.dice.white[1]}
          </span>
          {DQ_COLORS.map((color) => (
            <DiceFace
              key={color}
              value={state.dice?.colored[color] ?? 0}
              bg={ROW_STYLES[color].bg}
              label={`${DQ_COLOR_LABELS[color]}ダイス`}
            />
          ))}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {DQ_COLORS.map((color) => {
          const style = ROW_STYLES[color];
          const closed = dqIsRowClosed(state, color);
          const count = state.rows[color].length;
          return (
            <div key={color} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  flex: "0 0 auto",
                  width: 58,
                  textAlign: "center",
                  fontWeight: 700,
                  fontSize: 13,
                  color: style.bg,
                }}
              >
                {DQ_COLOR_LABELS[color]} {DQ_DIRECTIONS[color] === "asc" ? "▶" : "◀"}
                <br />
                <span className="muted" style={{ fontWeight: 400 }}>
                  {score.perRow[color].points}点
                </span>
              </span>
              <div
                role="group"
                aria-label={`${DQ_COLOR_LABELS[color]}の行`}
                style={{ display: "grid", gridTemplateColumns: "repeat(11, minmax(0, 1fr))", gap: 3, flex: 1 }}
              >
                {dqRowNumbers(color).map((value) => {
                  const checked = state.rows[color].includes(value);
                  const isCandidate = candidateKey.has(`${color}:${value}`);
                  const isFinal = value === dqFinalNumber(color);
                  const finalLocked = isFinal && !checked && count < DQ_FINAL_MIN_CHECKS;
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={!isCandidate}
                      aria-pressed={checked}
                      aria-label={`${DQ_COLOR_LABELS[color]} ${value}${checked ? "（チェック済み）" : ""}${isFinal ? "（最後の数字）" : ""}`}
                      onClick={() => { sfxPlace(); setState((s) => applyDqCheck(s, color, value)); }}
                      style={{
                        aspectRatio: "1",
                        minHeight: 34,
                        borderRadius: 6,
                        border: `2px solid ${isCandidate ? style.bg : "var(--line)"}`,
                        background: checked ? style.bg : isCandidate ? style.soft : "#fff",
                        color: checked ? style.text : "#222",
                        fontWeight: 700,
                        fontSize: 14,
                        cursor: isCandidate ? "pointer" : "default",
                        padding: 0,
                        touchAction: "manipulation",
                        boxShadow: isCandidate ? `0 0 0 2px ${style.soft}` : undefined,
                      }}
                      className={isCandidate ? "juice-pulse" : undefined}
                    >
                      {checked ? "✓" : finalLocked ? (
                        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden style={{ display: "block", margin: "0 auto" }}>
                          <path d="M12 2.8a5.2 5.2 0 0 0-5.2 5.2v3H5.6A1.6 1.6 0 0 0 4 12.6v7.8A1.6 1.6 0 0 0 5.6 22h12.8a1.6 1.6 0 0 0 1.6-1.6v-7.8a1.6 1.6 0 0 0-1.6-1.6h-1.2V8A5.2 5.2 0 0 0 12 2.8Zm-3.2 8.2V8a3.2 3.2 0 1 1 6.4 0v3Z" fill="#8a6d3b" />
                        </svg>
                      ) : value}
                    </button>
                  );
                })}
              </div>
              <span className="muted" style={{ flex: "0 0 auto", width: 30, fontSize: 12 }}>
                {closed ? "閉" : `${count}個`}
              </span>
            </div>
          );
        })}
      </div>

      {state.phase === "finished" && (
        <div style={{ marginTop: 18 }}>
          <EndScreen outcome="finish" score={score.total} onRetry={restart}>
            <ul className="muted" style={{ margin: 0, paddingLeft: 18, textAlign: "left" }}>
              {DQ_COLORS.map((color) => (
                <li key={color}>
                  {DQ_COLOR_LABELS[color]}: {score.perRow[color].count} チェックで {score.perRow[color].points} 点
                </li>
              ))}
              <li>失敗 {state.failures} 回で -{score.penalty} 点</li>
            </ul>
          </EndScreen>
        </div>
      )}
    </>
  );
}
