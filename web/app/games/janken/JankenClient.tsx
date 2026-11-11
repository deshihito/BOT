"use client";
// じゃんけん大会 オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/janken.ts の viewFor）:
//   phase choosing: players[].submitted のみ公開、手の内容は秘匿（自分の手だけ yourHand）
//   phase reveal: players[].hand / won が開示される
//   phase finished: standings が付く
// 提出は { type: "throw", hand }。制限時間はサーバー側の tick で締め切られる。
import { useEffect, useRef, useState } from "react";
import { playSe } from "@/lib/balku-sound";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

/** サーバー側モジュール（lib/online/games/janken.ts の JK_TIME_LIMIT_MS）と一致させること。 */
const JK_TIME_LIMIT_MS = 15000;

type JankenHand = "rock" | "scissors" | "paper";

const HAND_LABEL: Record<JankenHand, string> = {
  rock: "✊ グー",
  scissors: "✌️ チョキ",
  paper: "🖐️ パー",
};

type JankenViewPlayer = {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  submitted: boolean;
  hand?: JankenHand | null;
  won?: boolean;
};

type JankenView = {
  phase: "choosing" | "reveal" | "finished";
  round: number;
  totalRounds: number;
  roundEndsAt: number | null;
  revealEndsAt: number | null;
  you: { seat: number; submitted: boolean; yourHand: JankenHand | null; left: boolean };
  players: JankenViewPlayer[];
  standings: { seat: number; score: number; rank: number }[] | null;
};

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as JankenView | null;
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

  if (!state) return <p className="og-muted">対戦の開始を待っています…</p>;

  const remainingMs = state.roundEndsAt !== null ? Math.max(0, state.roundEndsAt - now) : null;
  const remainingRatio = remainingMs !== null ? remainingMs / JK_TIME_LIMIT_MS : 0;
  const canThrow = state.phase === "choosing" && !state.you.submitted && !state.you.left;
  const lastWinners = state.phase !== "choosing" ? state.players.filter((p) => p.won) : [];

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : ""} ・ {p.score}点
            {state.phase === "choosing" ? (p.submitted ? " ・ 出した" : " ・ 考え中") : ""}
          </span>
        ))}
      </div>

      {state.phase !== "finished" ? (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
            <p style={{ margin: 0, fontWeight: 800 }}>
              第{state.round + 1}ラウンド / {state.totalRounds}
            </p>
            {state.phase === "choosing" && remainingMs !== null ? (
              <span style={{ fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>残り {(remainingMs / 1000).toFixed(1)} 秒</span>
            ) : null}
          </div>
          {state.phase === "choosing" ? (
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

          <p className="muted" style={{ textAlign: "center" }}>
            出た手が2種類だけのとき、勝つ手を出した全員に1点。1種類か3種類なら、あいこで全員0点です。
          </p>

          <div style={{ display: "flex", gap: 10, justifyContent: "center", margin: "10px 0 6px" }}>
            {(Object.keys(HAND_LABEL) as JankenHand[]).map((hand) => {
              const mine = state.you.yourHand === hand;
              return (
                <button
                  key={hand}
                  type="button"
                  disabled={!canThrow}
                  onClick={() => {
                    playSe("play");
                    void api.move({ type: "throw", hand });
                  }}
                  style={{
                    minWidth: 104,
                    minHeight: 64,
                    padding: "10px 12px",
                    borderRadius: 14,
                    border: `2px solid ${mine ? "#4a6fa5" : "#d8c9a3"}`,
                    background: mine ? "#e0eaff" : "#fffdf6",
                    color: "inherit",
                    fontSize: 19,
                    fontWeight: 800,
                    cursor: canThrow ? "pointer" : "default",
                    touchAction: "manipulation",
                  }}
                >
                  {HAND_LABEL[hand]}
                </button>
              );
            })}
          </div>

          {state.phase === "choosing" ? (
            <p className="og-muted" style={{ textAlign: "center" }}>
              {state.you.left
                ? "退出したため、この対戦では手を出せません。"
                : state.you.submitted
                  ? `「${state.you.yourHand ? HAND_LABEL[state.you.yourHand] : ""}」で提出済み。全員の提出か制限時間で締め切られます。`
                  : "手を選んでください。制限時間までに出さないと、そのラウンドは不参加（0点）です。"}
            </p>
          ) : null}

          {state.phase === "reveal" ? (
            <div style={{ marginTop: 14 }}>
              <p className="og-turn-banner" role="status">
                {lastWinners.length > 0
                  ? `勝ち: ${lastWinners.map((p) => p.name).join("、")}（+1点）`
                  : "あいこ！誰にも点は入りませんでした。"}
              </p>
              <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 6 }}>
                {state.players.map((p) => (
                  <li
                    key={p.seat}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 10,
                      border: p.won ? "2px solid #22c55e" : "1px solid #e5e7eb",
                      background: p.won ? "#dcfce7" : "#fffdf6",
                    }}
                  >
                    <span>
                      {p.name}
                      {p.seat === mySeat ? "（あなた）" : ""}: {p.hand ? HAND_LABEL[p.hand] : p.left ? "退出" : "出さなかった"}
                    </span>
                    <strong>{p.won ? "+1点" : `${p.score}点`}</strong>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <div style={{ textAlign: "center" }}>
          <h2 style={{ fontSize: 24, margin: "10px 0" }}>結果発表</h2>
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
                      {s.seat === mySeat ? "（あなた）🎉" : ""}
                      {p.left ? "（退出）" : ""}
                    </span>
                    <strong>{s.score}点</strong>
                  </li>
                );
              })}
          </ul>
          <p className="og-muted">全{state.totalRounds}ラウンドが終わりました。再戦は下のボタンからどうぞ。</p>
        </div>
      )}
    </div>
  );
}

export default function JankenClient() {
  return (
    <OnlineShell gameId="janken" title="じゃんけん大会" playerRange={{ min: 2, max: 8 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
