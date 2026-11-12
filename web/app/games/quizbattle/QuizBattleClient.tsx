"use client";
// クイズバトル オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/quizbattle.ts の viewFor）:
//   phase question: question（正解位置なし）/ players[].answered のみ公開、回答内容は秘匿
//   phase reveal: correctChoice と players[].choice/correct/gained が開示される
//   phase finished: standings が付く
// 回答は { type: "answer", choice }。制限時間はサーバー側の tick で締め切られる。
import { useEffect, useRef, useState } from "react";
import { playSe } from "@/lib/balku-sound";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

/** サーバー側モジュール（lib/online/games/quizbattle.ts の QB_TIME_LIMIT_MS）と一致させること。 */
const QB_TIME_LIMIT_MS = 15000;

type QbViewPlayer = {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  answered: boolean;
  choice?: number | null;
  correct?: boolean;
  gained?: number;
};

type QbView = {
  phase: "question" | "reveal" | "finished";
  index: number;
  totalQuestions: number;
  questionEndsAt: number | null;
  revealEndsAt: number | null;
  question: { category: string; question: string; choices: string[] } | null;
  correctChoice: number | null;
  you: { seat: number; answered: boolean; yourChoice: number | null; left: boolean };
  players: QbViewPlayer[];
  standings: { seat: number; score: number; rank: number }[] | null;
};

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as QbView | null;
  const mySeat = view.player.seat;
  const [now, setNow] = useState(() => Date.now());
  const finishRef = useRef<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    const myRank = state.standings?.find((s) => s.seat === mySeat)?.rank;
    playSe(myRank === 1 ? "win" : "click");
  }, [state, mySeat, view.code]);

  // SE: 新しい問題フェーズが来た遷移で1回だけ鳴らす。
  const prevQuestionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state) return;
    const key = `${view.code}:${state.index}:${state.phase}`;
    const prev = prevQuestionRef.current;
    prevQuestionRef.current = key;
    if (prev !== null && prev !== key && state.phase === "question" && !state.you.left) playSe("turn");
  }, [state, view.code]);

  if (!state) return <p className="og-muted">問題を待っています…</p>;

  const remainingMs = state.questionEndsAt !== null ? Math.max(0, state.questionEndsAt - now) : null;
  const remainingRatio = remainingMs !== null ? remainingMs / QB_TIME_LIMIT_MS : 0;
  const canAnswer = state.phase === "question" && !state.you.answered && !state.you.left;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : ""} ・ {p.score}点
            {state.phase === "question" ? (p.answered ? " ・ 回答済み" : " ・ 考え中") : ""}
          </span>
        ))}
      </div>

      {state.phase !== "finished" && state.question ? (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
            <p style={{ margin: 0, fontWeight: 800 }}>
              第{state.index + 1}問 / {state.totalQuestions}
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
              {state.question.category}
            </span>
            {state.phase === "question" && remainingMs !== null ? (
              <span style={{ fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>残り {(remainingMs / 1000).toFixed(1)} 秒</span>
            ) : null}
          </div>
          {state.phase === "question" ? (
            <div aria-hidden="true" style={{ height: 8, borderRadius: 999, background: "#e5e7eb", margin: "8px 0 14px", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${remainingRatio * 100}%`,
                  background: remainingRatio < 0.25 ? "#ef4444" : "#4a6fa5",
                  transition: "width 0.2s linear",
                }}
              />
            </div>
          ) : null}

          <h2 key={state.index} className="juice-pop" style={{ fontSize: 20, lineHeight: 1.5, margin: "6px 0 16px" }}>{state.question.question}</h2>

          <div style={{ display: "grid", gap: 10 }}>
            {state.question.choices.map((choice, i) => {
              const revealed = state.phase === "reveal";
              const isAnswer = revealed && state.correctChoice === i;
              const isMine = state.you.yourChoice === i;
              let bg = "#fffdf6";
              let border = "#d8c9a3";
              if (isAnswer) {
                bg = "#dcfce7";
                border = "#22c55e";
              } else if (revealed && isMine) {
                bg = "#fee2e2";
                border = "#ef4444";
              }
              return (
                <button
                  key={i}
                  type="button"
                  className={revealed && isAnswer ? "juice-pulse" : undefined}
                  disabled={!canAnswer}
                  onClick={() => {
                    playSe("play");
                    void api.move({ type: "answer", choice: i });
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    minHeight: 52,
                    padding: "12px 14px",
                    borderRadius: 12,
                    border: `2px solid ${isMine && !revealed ? "#4a6fa5" : border}`,
                    background: isMine && !revealed ? "#e0eaff" : bg,
                    color: "inherit",
                    fontSize: 16,
                    textAlign: "left",
                    cursor: canAnswer ? "pointer" : "default",
                    touchAction: "manipulation",
                  }}
                >
                  <span style={{ fontWeight: 800, opacity: 0.6 }}>{["A", "B", "C", "D"][i]}</span>
                  <span>{choice}</span>
                  {isAnswer ? <span aria-hidden="true">✓</span> : null}
                  {revealed && isMine && !isAnswer ? <span aria-hidden="true">✗</span> : null}
                </button>
              );
            })}
          </div>

          {state.phase === "question" ? (
            <p className="og-muted" style={{ textAlign: "center" }}>
              {state.you.left
                ? "退出したため、この対戦では回答できません。"
                : state.you.answered
                  ? "回答を受け付けました。全員の回答か制限時間で締め切られます。"
                  : "正解で100点＋残り秒数×2点。速く正解するほど高得点です。"}
            </p>
          ) : null}

          {state.phase === "reveal" ? (
            <div className="juice-slide" style={{ marginTop: 16 }}>
              <p className="og-turn-banner" role="status">
                正解は「{state.correctChoice !== null ? state.question.choices[state.correctChoice] : "—"}」でした
              </p>
              <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 6 }}>
                {state.players.map((p) => (
                  <li
                    key={p.seat}
                    className="juice-pop"
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 10,
                      border: "1px solid #e5e7eb",
                      background: "#fffdf6",
                    }}
                  >
                    <span>
                      {p.name}
                      {p.seat === mySeat ? "（あなた）" : ""}: {p.choice === null || p.choice === undefined ? "無回答" : state.question!.choices[p.choice]}
                    </span>
                    <strong>{p.correct ? `+${p.gained ?? 0}点` : "0点"}</strong>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <div className="juice-slide" style={{ textAlign: "center" }}>
          <h2 className={state.standings?.find((s) => s.seat === mySeat)?.rank === 1 ? "juice-pulse" : undefined} style={{ fontSize: 24, margin: "10px 0" }}>結果発表</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
            {(state.standings ?? [...state.players].map((p) => ({ seat: p.seat, score: p.score, rank: 0 })))
              .slice()
              .sort((a, b) => a.rank - b.rank || b.score - a.score)
              .map((s) => {
                const p = state.players.find((x) => x.seat === s.seat);
                if (!p) return null;
                return (
                  <li
                    key={s.seat}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "12px 16px",
                      borderRadius: 12,
                      border: s.rank === 1 ? "2px solid #d9a41c" : "1px solid #e5e7eb",
                      background: s.rank === 1 ? "#fff3c4" : "#fffdf6",
                      fontWeight: s.seat === mySeat ? 800 : 400,
                    }}
                  >
                    <span>
                      {s.rank}位 {p.name}
                      {s.seat === mySeat ? "（あなた）" : ""}
                      {p.left ? "（退出）" : ""}
                    </span>
                    <strong>{s.score}点</strong>
                  </li>
                );
              })}
          </ul>
          <p className="og-muted">全{state.totalQuestions}問が終わりました。再戦は下のボタンからどうぞ。</p>
        </div>
      )}
    </div>
  );
}

export default function QuizBattleClient() {
  return (
    <OnlineShell gameId="quizbattle" title="クイズバトル" playerRange={{ min: 2, max: 4 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
