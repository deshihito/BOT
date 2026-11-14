"use client";
// 少数決ゲーム オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/minority.ts の viewFor）:
//   phase question: players[].answered のみ公開、回答内容は秘匿
//   phase reveal: tally（票数）と players[].choice/eliminatedThisRound が開示される
//   phase finished: standings と winners が付く
// 回答は { type: "answer", choice }（0 か 1）。制限時間はサーバー側の tick で締め切られる。
// ルール: 少数派を選んだ人だけが残る。同数／片方だけの票のときは回答者全員が残る。
import { useEffect, useRef, useState } from "react";
import { playSe } from "@/lib/balku-sound";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";
import { useRoomJuice } from "../GameJuice";

/** サーバー側モジュール（lib/online/games/minority.ts の MN_TIME_LIMIT_MS）と一致させること。 */
const MN_TIME_LIMIT_MS = 15000;

type MnViewPlayer = {
  seat: number;
  name: string;
  alive: boolean;
  left: boolean;
  answered: boolean;
  choice?: number | null;
  eliminatedThisRound?: boolean;
};

type MnView = {
  phase: "question" | "reveal" | "finished";
  round: number;
  maxRounds: number;
  questionEndsAt: number | null;
  revealEndsAt: number | null;
  question: { topic: string; choices: [string, string] } | null;
  tally: [number, number] | null;
  lastEliminated: number[] | null;
  you: { seat: number; alive: boolean; answered: boolean; yourChoice: number | null; left: boolean };
  players: MnViewPlayer[];
  winners: number[] | null;
  standings: { seat: number; rank: number; winner: boolean }[] | null;
};

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as MnView | null;
  // 櫻井流バッチ2: 着手の反映に小ヒットストップ、決着に大ヒット＋フラッシュ（音は既存の playSe 系に任せる）。
  useRoomJuice(`${state?.phase ?? ""}:${state?.round ?? ""}`, state?.phase === "finished");
  const mySeat = view.player.seat;
  const [now, setNow] = useState(() => Date.now());
  const finishRef = useRef<string | null>(null);
  const turnKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    playSe(state.winners?.includes(mySeat) ? "win" : "click");
  }, [state, mySeat, view.code]);

  // 新しい問いが来て自分が回答できる番になったら知らせる（ラウンド遷移で1回だけ）
  useEffect(() => {
    if (!state || state.phase !== "question") return;
    const key = `${view.code}:${state.round}`;
    const prev = turnKeyRef.current;
    turnKeyRef.current = key;
    if (prev !== null && prev !== key && state.you.alive && !state.you.answered && !state.you.left) playSe("turn");
  }, [state, view.code]);

  if (!state) return <p className="og-muted">お題を待っています…</p>;

  const remainingMs = state.questionEndsAt !== null ? Math.max(0, state.questionEndsAt - now) : null;
  const remainingRatio = remainingMs !== null ? remainingMs / MN_TIME_LIMIT_MS : 0;
  const revealing = state.phase === "reveal";
  const canAnswer = state.phase === "question" && state.you.alive && !state.you.answered && !state.you.left;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : !p.alive ? "（脱落）" : ""}
            {state.phase === "question" && p.alive ? (p.answered ? " ・ 回答済み" : " ・ 考え中") : ""}
            {revealing && p.eliminatedThisRound ? " ・ 今回脱落" : ""}
          </span>
        ))}
      </div>

      <p className="og-muted" style={{ marginTop: 8 }}>
        ルール：少数派を選んだ人だけが次のラウンドへ残ります。同数や、片方にしか票が入らなかったときは回答した全員が残ります。無回答は脱落です。
      </p>

      {state.phase !== "finished" && state.question ? (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
            <p style={{ margin: 0, fontWeight: 800 }}>
              第{state.round}問 / 最大{state.maxRounds}問 ・ 生存 {state.players.filter((p) => p.alive).length}人
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
                  background: remainingRatio < 0.25 ? "#ef4444" : "#db2777",
                  transition: "width 0.2s linear",
                }}
              />
            </div>
          ) : null}

          <h2 style={{ fontSize: 22, lineHeight: 1.5, margin: "6px 0 16px" }}>{state.question.topic}</h2>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {state.question.choices.map((choice, i) => {
              const isMine = state.you.yourChoice === i;
              const votes = revealing && state.tally ? state.tally[i] : null;
              const isMinority =
                revealing && state.tally !== null && votes !== null &&
                state.tally[0] !== state.tally[1] && votes === Math.min(state.tally[0], state.tally[1]) && votes > 0;
              let bg = "#fffdf6";
              let border = "#d8c9a3";
              if (isMinority) {
                bg = "#dcfce7";
                border = "#22c55e";
              } else if (revealing && isMine) {
                bg = "#fee2e2";
                border = "#ef4444";
              } else if (!revealing && isMine) {
                bg = "#fdf2f8";
                border = "#db2777";
              }
              return (
                <button
                  key={i}
                  type="button"
                  className={revealing ? "juice-flip" : undefined}
                  disabled={!canAnswer}
                  onClick={() => {
                    playSe("play");
                    void api.move({ type: "answer", choice: i });
                  }}
                  style={{
                    minHeight: 72,
                    padding: "12px",
                    borderRadius: 12,
                    border: `2px solid ${border}`,
                    background: bg,
                    fontSize: 18,
                    fontWeight: 800,
                    cursor: canAnswer ? "pointer" : "default",
                  }}
                >
                  {choice}
                  {isMine ? "（あなた）" : ""}
                  {votes !== null ? <div style={{ fontSize: 14, marginTop: 4 }}>{votes}票{isMinority ? " ★少数派" : ""}</div> : null}
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
                      {p.eliminatedThisRound ? " ・ 脱落" : p.left ? " ・ 退出" : ""}
                    </li>
                  );
                })}
              </ul>
              {state.lastEliminated && state.lastEliminated.length === 0 ? (
                <p className="og-muted">このラウンドは脱落者なしでした。</p>
              ) : null}
            </div>
          ) : state.you.answered ? (
            <p className="og-muted" style={{ marginTop: 12 }}>
              回答しました。全員の回答か制限時間で締め切られます。
            </p>
          ) : !state.you.alive ? (
            <p className="og-muted" style={{ marginTop: 12 }}>
              あなたは脱落しました。最後まで見届けましょう。
            </p>
          ) : null}
        </>
      ) : null}

      {state.phase === "finished" && state.standings ? (
        <div className="juice-slide" style={{ marginTop: 16 }}>
          <h2 className="juice-pulse" style={{ fontSize: 20, margin: "0 0 10px" }}>最終結果</h2>
          {state.winners && state.winners.length > 0 ? (
            <p style={{ fontWeight: 800 }}>
              優勝：{state.winners.map((s) => state.players.find((p) => p.seat === s)?.name ?? "").filter(Boolean).join(" さん、")}
              {state.winners.includes(mySeat) ? "（あなたも優勝です）" : ""}
            </p>
          ) : null}
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
            {[...state.standings]
              .sort((a, b) => a.rank - b.rank)
              .map((s) => {
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
                      border: s.seat === mySeat ? "2px solid #db2777" : "1px solid #e5e7eb",
                      background: s.winner ? "#fdf2f8" : "#fff",
                      fontWeight: 700,
                    }}
                  >
                    <span>
                      {s.rank}位 {p.name}
                      {s.seat === mySeat ? "（あなた）" : ""}
                      {p.left ? "（退出）" : ""}
                    </span>
                    <strong>{s.winner ? "優勝" : "脱落"}</strong>
                  </li>
                );
              })}
          </ul>
          <p className="og-muted">再戦は下のボタンからどうぞ。</p>
        </div>
      ) : null}
    </div>
  );
}

export default function MinorityClient() {
  return (
    <OnlineShell gameId="minority" title="少数決ゲーム" playerRange={{ min: 3, max: 8 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}