"use client";
// クイズ。ロジックは lib/quiz.ts（シード決定的に10問出題、選択肢もシャッフル）。
// 回答すると即フィードバック（正解の選択肢と得点）を表示し、「次の問題」へ進む。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { sfxCorrect, sfxLose, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import {
  answerQuestion,
  createQuizGame,
  currentQuizQuestion,
  nextQuestion,
  quizCategoryStats,
  quizCorrectCount,
  quizGrade,
  type QuizState,
} from "@/lib/quiz";
import { useGamesNav } from "../GamesShell";

const choiceStyle = (bg: string, border: string): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  minHeight: 52,
  padding: "12px 14px",
  borderRadius: 12,
  border: `2px solid ${border}`,
  background: bg,
  color: "inherit",
  fontSize: 16,
  textAlign: "left",
  cursor: "pointer",
  touchAction: "manipulation",
});

export default function QuizClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<QuizState>(() => createQuizGame(Date.now() % 2147483647));

  const restart = () => setState(createQuizGame(Date.now() % 2147483647));

  const prevPhaseRef = useRef(state.phase);
  useEffect(() => {
    if (prevPhaseRef.current !== "finished" && state.phase === "finished") {
      if (quizCorrectCount(state) * 2 >= state.deck.length) sfxWin();
      else sfxLose();
    }
    prevPhaseRef.current = state.phase;
  }, [state]);

  const onAnswer = (i: number) => {
    if (state.phase !== "answering") return;
    const next = answerQuestion(state, i);
    if (next.last) {
      if (next.last.correct) sfxCorrect();
      else sfxWrong();
    }
    setState(next);
  };

  const q = currentQuizQuestion(state);
  const total = state.deck.length;
  const grade = quizGrade(state);
  const stats = quizCategoryStats(state);

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>クイズ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>クイズ</h1>
        <p className="muted">全5カテゴリから10問出題。答えると、その場で正解が分かります。</p>
      </div>

      {state.phase !== "finished" && q ? (
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <p className="classic-status" role="status" style={{ margin: 0 }}>
              第{state.current + 1}問 / {total} ・ スコア {state.score}
              {state.streak >= 2 ? ` ・ ${state.streak}連続正解中` : ""}
            </p>
            <span
              style={{
                padding: "2px 10px",
                borderRadius: 999,
                background: "#eef2ff",
                border: "1px solid #c7d2fe",
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              {q.category}
            </span>
          </div>
          <div
            aria-hidden="true"
            style={{ height: 8, borderRadius: 999, background: "#e5e7eb", margin: "10px 0 18px", overflow: "hidden" }}
          >
            <div
              style={{
                height: "100%",
                width: `${((state.current + (state.phase === "revealed" ? 1 : 0)) / total) * 100}%`,
                background: "#4a6fa5",
                transition: "width 0.3s",
              }}
            />
          </div>

          <h2 style={{ fontSize: 20, lineHeight: 1.5, margin: "0 0 16px" }}>{q.question}</h2>

          <div style={{ display: "grid", gap: 10 }}>
            {q.choices.map((choice, i) => {
              const revealed = state.phase === "revealed" && state.last;
              const isAnswer = i === q.answer;
              const isPicked = revealed ? state.last!.picked === i : false;
              let bg = "#fffdf6";
              let border = "#d8c9a3";
              if (revealed && isAnswer) {
                bg = "#dcfce7";
                border = "#22c55e";
              } else if (revealed && isPicked) {
                bg = "#fee2e2";
                border = "#ef4444";
              }
              return (
                <button
                  key={i}
                  type="button"
                  className={revealed && isAnswer ? "juice-pulse" : revealed && isPicked ? "juice-shake" : undefined}
                  disabled={state.phase !== "answering"}
                  onClick={() => onAnswer(i)}
                  style={choiceStyle(bg, border)}
                >
                  <span style={{ fontWeight: 800, opacity: 0.6 }}>{["A", "B", "C", "D"][i]}</span>
                  <span>{choice}</span>
                  {revealed && isAnswer ? <span aria-hidden="true">✓</span> : null}
                  {revealed && isPicked && !isAnswer ? <span aria-hidden="true">✗</span> : null}
                </button>
              );
            })}
          </div>

          {state.phase === "revealed" && state.last ? (
            <div style={{ marginTop: 16, textAlign: "center" }}>
              <p className="classic-status juice-pop" role="status" style={{ justifyContent: "center" }}>
                {state.last.correct ? `正解！ +${state.last.gained}点` : `残念、正解は「${q.choices[state.last.correctIndex]}」でした`}
              </p>
              <button type="button" className="classic-btn classic-btn-active" onClick={() => { sfxTap(); setState((s) => nextQuestion(s)); }}>
                {state.current + 1 >= total ? "結果を見る" : "次の問題へ"}
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          <EndScreen outcome="finish" title={grade.label} score={state.score} scoreLabel="スコア" onRetry={restart}>
            <p className="classic-status" role="status" style={{ justifyContent: "center", fontSize: 18 }}>
              結果: {quizCorrectCount(state)} / {state.answers.length} 問正解 ・ スコア {state.score} 点
            </p>
            <p className="muted" style={{ textAlign: "center" }}>{grade.comment}</p>
            <p className="muted" style={{ textAlign: "center" }}>最大連続正解: {state.bestStreak} ／ 正答率 {state.answers.length ? Math.round((quizCorrectCount(state) / state.answers.length) * 100) : 0}%</p>

            <div style={{ display: "grid", gap: 8, margin: "20px 0", textAlign: "left" }}>
              {stats.map((s) => (
                <div
                  key={s.category}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 14px",
                    borderRadius: 10,
                    border: "1px solid #e5e7eb",
                    background: "#fffdf6",
                  }}
                >
                  <span style={{ fontWeight: 700 }}>{s.category}</span>
                  <span>
                    {s.correct} / {s.total} 正解（{s.total ? Math.round((s.correct / s.total) * 100) : 0}%）
                  </span>
                </div>
              ))}
            </div>
          </EndScreen>
        </div>
      )}
    </>
  );
}
