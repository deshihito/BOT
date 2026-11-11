"use client";
// フラッグクイズ。ロジックは lib/flagquiz.ts。
// 旗→国名／国名→旗の4択を10問。答えるとその場で正解が分かり、最後に復習リストが出る。
import Link from "next/link";
import { useState } from "react";
import {
  answerFlagQuestion,
  createFlagQuizGame,
  currentFlagQuestion,
  flagQuizCorrectCount,
  nextFlagQuestion,
  FLAG_PAIRS,
  type FlagQuizState,
} from "@/lib/flagquiz";
import { useGamesNav } from "../GamesShell";

function newGame(): FlagQuizState {
  return createFlagQuizGame(Date.now() % 2147483647);
}

export default function FlagQuizClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<FlagQuizState>(() => newGame());

  const q = currentFlagQuestion(state);
  const lastRecord = state.records[state.records.length - 1];
  const revealed = state.phase === "revealed" && q && lastRecord && lastRecord.questionIndex === state.index;
  const isLast = state.index + 1 >= state.questions.length;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>フラッグクイズ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>フラッグクイズ</h1>
        <p className="muted">答えをタップすると、その場で正解が分かります。</p>
      </div>

      {state.phase !== "finished" && q ? (
        <div style={{ maxWidth: 560, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <p style={{ margin: 0, fontWeight: 800 }}>
              第{state.index + 1}問 / {state.questions.length}
            </p>
            <p style={{ margin: 0, fontWeight: 800 }}>{state.score} 点</p>
          </div>
          <div aria-hidden="true" style={{ height: 8, borderRadius: 999, background: "#e5e7eb", margin: "8px 0 18px", overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${((state.index + (state.phase === "revealed" ? 1 : 0)) / state.questions.length) * 100}%`,
                background: "#2e6da4",
                transition: "width 0.2s linear",
              }}
            />
          </div>

          {q.mode === "flagToName" ? (
            <div style={{ textAlign: "center", margin: "10px 0 18px" }}>
              <div role="img" aria-label="問題の国旗" style={{ fontSize: "clamp(80px, 24vw, 128px)", lineHeight: 1.1 }}>
                {FLAG_PAIRS[q.target].flag}
              </div>
              <p style={{ fontWeight: 700, margin: "8px 0 0" }}>この旗の国はどこ？</p>
            </div>
          ) : (
            <div style={{ textAlign: "center", margin: "10px 0 18px" }}>
              <p style={{ fontSize: "clamp(26px, 7vw, 38px)", fontWeight: 800, margin: "18px 0 6px" }}>{FLAG_PAIRS[q.target].name}</p>
              <p style={{ fontWeight: 700, margin: 0 }}>この国の旗はどれ？</p>
            </div>
          )}

          <div style={{ display: "grid", gap: 10 }}>
            {q.choices.map((pairIndex, pos) => {
              const pair = FLAG_PAIRS[pairIndex];
              const isAnswer = pos === q.answerPos;
              const isMine = revealed && lastRecord.picked === pairIndex;
              let bg = "#fffdf6";
              let border = "#d8c9a3";
              if (revealed && isAnswer) {
                bg = "#dcfce7";
                border = "#22c55e";
              } else if (revealed && isMine) {
                bg = "#fee2e2";
                border = "#ef4444";
              }
              return (
                <button
                  key={pos}
                  type="button"
                  aria-label={q.mode === "nameToFlag" ? pair.name : undefined}
                  disabled={state.phase !== "question"}
                  onClick={() => setState((s) => answerFlagQuestion(s, pos))}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: q.mode === "nameToFlag" ? "center" : "flex-start",
                    gap: 10,
                    width: "100%",
                    minHeight: 52,
                    padding: "10px 14px",
                    borderRadius: 12,
                    border: `2px solid ${border}`,
                    background: bg,
                    color: "inherit",
                    fontSize: q.mode === "nameToFlag" ? 34 : 16,
                    textAlign: "left",
                    cursor: state.phase === "question" ? "pointer" : "default",
                    touchAction: "manipulation",
                  }}
                >
                  {q.mode === "flagToName" ? (
                    <span>{pair.name}</span>
                  ) : (
                    <span aria-hidden="true">{pair.flag}</span>
                  )}
                  {revealed && isAnswer ? <span aria-hidden="true" style={{ fontSize: 16 }}>✓</span> : null}
                  {revealed && isMine && !isAnswer ? <span aria-hidden="true" style={{ fontSize: 16 }}>✗</span> : null}
                </button>
              );
            })}
          </div>

          {revealed ? (
            <div style={{ textAlign: "center", marginTop: 18 }}>
              <p role="status" style={{ fontWeight: 800, fontSize: 18, margin: "0 0 6px" }}>
                {lastRecord.correct ? `正解！ +${lastRecord.gained}点` : `残念… 正解は ${FLAG_PAIRS[q.target].flag} ${FLAG_PAIRS[q.target].name}`}
              </p>
              {state.streak >= 2 ? <p className="muted" style={{ margin: "0 0 10px" }}>{state.streak} 連続正解中</p> : null}
              <button
                type="button"
                className="classic-btn"
                style={{ minHeight: 48, padding: "10px 28px", fontSize: 16 }}
                onClick={() => setState((s) => nextFlagQuestion(s))}
              >
                {isLast ? "結果を見る" : "次の問題へ"}
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ maxWidth: 560, margin: "0 auto" }}>
          <div style={{ textAlign: "center" }}>
            <h2 style={{ fontSize: 24, margin: "10px 0" }}>結果発表</h2>
            <p style={{ fontSize: 18, margin: "6px 0" }}>
              {state.questions.length}問中 <strong>{flagQuizCorrectCount(state)}問</strong> 正解 ・ {state.score} 点
            </p>
            <p className="muted" style={{ margin: "4px 0 14px" }}>最大連続正解 {state.bestStreak} 問</p>
            <button
              type="button"
              className="classic-btn"
              style={{ minHeight: 48, padding: "10px 28px", fontSize: 16 }}
              onClick={() => setState(newGame())}
            >
              もう一度
            </button>
          </div>

          <h3 style={{ margin: "26px 0 10px" }}>復習リスト</h3>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
            {state.records.map((record) => {
              const question = state.questions[record.questionIndex];
              const target = FLAG_PAIRS[question.target];
              const picked = FLAG_PAIRS[record.picked];
              return (
                <li
                  key={record.questionIndex}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: `1px solid ${record.correct ? "#bbf7d0" : "#fecaca"}`,
                    background: record.correct ? "#f0fdf4" : "#fef2f2",
                  }}
                >
                  <span style={{ fontSize: 34, lineHeight: 1 }} aria-hidden="true">{target.flag}</span>
                  <span style={{ flex: 1 }}>
                    <strong>{target.name}</strong>
                    {record.correct ? (
                      <span className="muted"> ・ 正解</span>
                    ) : (
                      <span className="muted"> ・ あなたの答え: {picked.flag} {picked.name}</span>
                    )}
                  </span>
                  <span aria-hidden="true">{record.correct ? "✓" : "✗"}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}
