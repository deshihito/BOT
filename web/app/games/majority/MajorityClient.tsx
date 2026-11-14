"use client";
// 多数決ゲーム オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/majority.ts の viewFor）:
//   phase question: question（お題と選択肢）/ players[].answered のみ公開、回答内容は秘匿
//   phase reveal: tally（得票分布）と players[].choice/gained が開示される
//   phase finished: standings が付く
// 回答は { type: "answer", choice }。制限時間はサーバー側の tick で締め切られる。
// 採点: 最多得票の選択肢を選んだ人全員が「最多得票数 × 10点」。
import { useEffect, useRef, useState } from "react";
import { playSe } from "@/lib/balku-sound";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";
import { useRoomJuice } from "../GameJuice";

/** サーバー側モジュール（lib/online/games/majority.ts の MJ_TIME_LIMIT_MS）と一致させること。 */
const MJ_TIME_LIMIT_MS = 20000;

type MjViewPlayer = {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  answered: boolean;
  choice?: number | null;
  gained?: number;
};

type MjView = {
  phase: "question" | "reveal" | "finished";
  index: number;
  totalQuestions: number;
  questionEndsAt: number | null;
  revealEndsAt: number | null;
  question: { topic: string; choices: string[] } | null;
  tally: number[] | null;
  topVotes: number | null;
  you: { seat: number; answered: boolean; yourChoice: number | null; left: boolean };
  players: MjViewPlayer[];
  standings: { seat: number; score: number; rank: number }[] | null;
};

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as MjView | null;
  // 櫻井流バッチ2: 着手の反映に小ヒットストップ、決着に大ヒット＋フラッシュ（音は既存の playSe 系に任せる）。
  useRoomJuice(`${state?.phase ?? ""}`, state?.phase === "finished");
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

  if (!state) return <p className="og-muted">お題を待っています…</p>;

  const remainingMs = state.questionEndsAt !== null ? Math.max(0, state.questionEndsAt - now) : null;
  const remainingRatio = remainingMs !== null ? remainingMs / MJ_TIME_LIMIT_MS : 0;
  const canAnswer = state.phase === "question" && !state.you.answered && !state.you.left;
  const revealing = state.phase === "reveal";

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

      <p className="og-muted" style={{ marginTop: 8 }}>
        ルール：最多得票の答えを選んだ人全員が「最多得票数 × 10点」をもらえます。
      </p>

      {state.phase !== "finished" && state.question ? (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
            <p style={{ margin: 0, fontWeight: 800 }}>
              第{state.index + 1}問 / {state.totalQuestions}
            </p>
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
                  background: remainingRatio < 0.25 ? "#ef4444" : "#7c3aed",
                  transition: "width 0.2s linear",
                }}
              />
            </div>
          ) : null}

          <h2 key={state.index} className="juice-pop" style={{ fontSize: 22, lineHeight: 1.5, margin: "6px 0 16px" }}>{state.question.topic}</h2>

          <div style={{ display: "grid", gap: 10 }}>
            {state.question.choices.map((choice, i) => {
              const isMine = state.you.yourChoice === i;
              const votes = revealing && state.tally ? state.tally[i] : null;
              const isTop = revealing && state.topVotes !== null && votes !== null && votes === state.topVotes && votes > 0;
              let bg = "#fffdf6";
              let border = "#d8c9a3";
              if (isTop) {
                bg = "#dcfce7";
                border = "#22c55e";
              } else if (revealing && isMine) {
                bg = "#fee2e2";
                border = "#ef4444";
              } else if (!revealing && isMine) {
                bg = "#ede9fe";
                border = "#7c3aed";
              }
              const maxVotes = state.tally ? Math.max(...state.tally, 1) : 1;
              return (
                <button
                  key={i}
                  type="button"
                  className={isTop ? "juice-pulse" : undefined}
                  disabled={!canAnswer}
                  onClick={() => {
                    playSe("play");
                    void api.move({ type: "answer", choice: i });
                  }}
                  style={{
                    position: "relative",
                    minHeight: 52,
                    textAlign: "left",
                    padding: "10px 14px",
                    borderRadius: 12,
                    border: `2px solid ${border}`,
                    background: bg,
                    fontSize: 16,
                    fontWeight: 700,
                    cursor: canAnswer ? "pointer" : "default",
                    overflow: "hidden",
                  }}
                >
                  {revealing && votes !== null ? (
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        inset: 0,
                        width: `${(votes / maxVotes) * 100}%`,
                        background: "rgba(124, 58, 237, 0.12)",
                      }}
                    />
                  ) : null}
                  <span style={{ position: "relative", display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <span>
                      {choice}
                      {isMine ? "（あなた）" : ""}
                    </span>
                    {revealing && votes !== null ? <span>{votes}票{isTop ? " ★最多" : ""}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>

          {revealing ? (
            <div className="juice-slide" style={{ marginTop: 14 }}>
              <p style={{ fontWeight: 700, margin: "0 0 6px" }}>結果</p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
                {state.players.map((p) => {
                  const choiceText =
                    p.choice === null || p.choice === undefined
                      ? "無回答"
                      : (state.question?.choices[p.choice] ?? "?");
                  return (
                    <li key={p.seat} style={{ fontSize: 14 }}>
                      {p.name}
                      {p.seat === mySeat ? "（あなた）" : ""}：{choiceText}
                      {p.gained !== undefined && p.gained > 0 ? ` ・ +${p.gained}点` : ""}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : state.you.answered ? (
            <p className="og-muted" style={{ marginTop: 12 }}>
              回答しました。全員の回答か制限時間で締め切られます。
            </p>
          ) : null}
        </>
      ) : null}

      {state.phase === "finished" && state.standings ? (
        <div className="juice-slide" style={{ marginTop: 16 }}>
          <h2 className={state.standings.find((s) => s.seat === mySeat)?.rank === 1 ? "juice-pulse" : undefined} style={{ fontSize: 20, margin: "0 0 10px" }}>最終結果</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
            {state.standings.map((s) => {
              const p = state.players.find((pl) => pl.seat === s.seat);
              if (!p) return null;
              return (
                <li
                  key={s.seat}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "10px 14px",
                    borderRadius: 10,
                    border: s.seat === mySeat ? "2px solid #7c3aed" : "1px solid #e5e7eb",
                    background: s.rank === 1 ? "#f5f3ff" : "#fff",
                    fontWeight: 700,
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
      ) : null}
    </div>
  );
}

export default function MajorityClient() {
  return (
    <OnlineShell gameId="majority" title="多数決ゲーム" playerRange={{ min: 2, max: 8 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
