"use client";
// ストップウォッチ対戦 オンラインクライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/stopbattle.ts の viewFor）:
//   phase counting: 目標タイムだけが分かり、経過時間は表示されない（ブラインド）。
//     他の人の記録は秘匿で、止めたかどうかだけが公開される。自分の記録は止めた後に見える。
//   phase reveal: 全員の記録・誤差・得点が開示される。
//   phase finished: standings が付く
// アクションは { type: "stop" }。計測はサーバー時刻で行われるため、
// 表示上の精度は通信間隔の範囲に限られる。
import { useEffect, useRef, useState } from "react";
import { playSe } from "@/lib/balku-sound";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

type SbViewPlayer = {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  stopped: boolean;
  elapsedMs?: number | null;
  errorMs?: number | null;
  gained?: number;
  winner?: boolean;
};

type SbView = {
  phase: "counting" | "reveal" | "finished";
  round: number;
  totalRounds: number;
  targetMs: number;
  roundEndsAt: number | null;
  revealEndsAt: number | null;
  you: { seat: number; stopped: boolean; yourElapsedMs: number | null; left: boolean };
  players: SbViewPlayer[];
  standings: { seat: number; score: number; rank: number }[] | null;
};

/** ms を「7.00」のような秒表記にする。 */
function fmtSec(ms: number): string {
  return (ms / 1000).toFixed(2);
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as SbView | null;
  const mySeat = view.player.seat;
  const [now, setNow] = useState(() => Date.now());
  const finishRef = useRef<string | null>(null);
  const turnRef = useRef<string | null>(null);

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

  // 新しいラウンドの計測が始まったら合図を1回だけ鳴らす。
  useEffect(() => {
    if (!state || state.phase !== "counting") return;
    const key = `${view.code}:${state.round}`;
    if (turnRef.current === key) return;
    turnRef.current = key;
    playSe("turn");
  }, [state, view.code]);

  if (!state) return <p className="og-muted">ラウンド開始を待っています…</p>;

  const canStop = state.phase === "counting" && !state.you.stopped && !state.you.left;
  const pulse = Math.floor(now / 600) % 2 === 0;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : ""} ・ {p.score}点
            {state.phase === "counting" ? (p.stopped ? " ・ ストップ済み" : " ・ 計測中") : ""}
          </span>
        ))}
      </div>

      <p className="og-muted" style={{ marginTop: 8 }}>
        ラウンド {state.round + 1} / {state.totalRounds}
      </p>

      {state.phase === "counting" && (
        <div className="juice-slide" style={{ textAlign: "center", padding: "12px 0 4px" }}>
          <p className="og-muted">目標タイム</p>
          <div key={`${state.round}-${state.targetMs}`} className="juice-flip" style={{ fontSize: 56, fontWeight: 800, lineHeight: 1.15 }}>
            {fmtSec(state.targetMs)} 秒
          </div>
          <p style={{ fontSize: 20, margin: "10px 0" }} aria-live="polite">
            <span style={{ opacity: pulse ? 1 : 0.25 }}>●</span> 計測中…
          </p>
          <p className="og-muted">経過時間は表示されません。感覚だけが頼りです。</p>
          {canStop ? (
            <button
              type="button"
              className="classic-btn"
              style={{
                minWidth: 220,
                minHeight: 76,
                fontSize: 26,
                fontWeight: 800,
                marginTop: 14,
                borderRadius: 16,
              }}
              onClick={() => {
                playSe("play");
                void api.move({ type: "stop" });
              }}
            >
              止める！
            </button>
          ) : (
            <p className="og-muted juice-pop" style={{ marginTop: 14 }}>
              {state.you.left
                ? "退出したため、このゲームには参加していません。"
                : `あなたの記録: ${state.you.yourElapsedMs !== null ? `${fmtSec(state.you.yourElapsedMs)} 秒` : "—"}（他の人の記録は締切まで見えません）`}
            </p>
          )}
        </div>
      )}

      {state.phase === "reveal" && (
        <div className="juice-slide" style={{ padding: "12px 0 4px" }}>
          <p style={{ textAlign: "center", fontSize: 20 }}>
            目標は <strong key={state.round} className="juice-pop" style={{ fontSize: 28 }}>{fmtSec(state.targetMs)} 秒</strong>
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0" }}>
            {state.players.map((p) => {
              const early =
                p.elapsedMs !== null && p.elapsedMs !== undefined && p.elapsedMs < state.targetMs;
              return (
                <li
                  key={p.seat}
                  className={p.winner ? "juice-pop" : undefined}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "6px 10px",
                    borderRadius: 8,
                    background: p.winner ? "var(--accent-soft)" : undefined,
                    fontWeight: p.winner ? 700 : 400,
                  }}
                >
                  <span>
                    {p.winner ? "" : ""}
                    {p.name}
                    {p.seat === mySeat ? "（あなた）" : ""}
                    {p.left ? "（退出）" : ""}
                  </span>
                  <span>
                    {p.elapsedMs === null || p.elapsedMs === undefined
                      ? "未送信"
                      : `${fmtSec(p.elapsedMs)} 秒（${fmtSec(p.errorMs ?? 0)} 秒 ${early ? "早い" : "遅い"}）`}
                    {p.gained ? ` ・ +${p.gained}点` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {state.phase === "finished" && (
        <div className="juice-slide" style={{ padding: "12px 0 4px" }}>
          <h2 className="juice-pulse" style={{ textAlign: "center" }}>結果</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0" }}>
            {(state.standings ?? []).map((s) => {
              const p = state.players.find((x) => x.seat === s.seat);
              if (!p) return null;
              return (
                <li
                  key={s.seat}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "6px 10px",
                    fontWeight: s.rank === 1 ? 700 : 400,
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
          <p className="og-muted">全{state.totalRounds}ラウンドが終わりました。再戦は下のボタンからどうぞ。</p>
        </div>
      )}
    </div>
  );
}

export default function StopBattleClient() {
  return (
    <OnlineShell gameId="stopbattle" title="ストップウォッチ対戦" playerRange={{ min: 2, max: 8 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
