"use client";
// ハゲタカ オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/hagetaka.ts の viewFor）:
//   phase bidding: 場の得点カードと自分の手札は公開、他人の入札は submitted のみ（秘匿）
//   決着は全員提出のタイミングで即座に行われ、前ラウンドの結果は lastResult / history で開示
//   phase finished: standings が付く
// 提出は { type: "bid", card }。
import { useEffect, useRef } from "react";
import { playSe } from "@/lib/balku-sound";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

type HagetakaHistoryEntry = {
  round: number;
  prizes: number[];
  prizeTotal: number;
  bids: { seat: number; card: number | null }[];
  taker: number | null;
  carried: boolean;
};

type HagetakaView = {
  phase: "bidding" | "finished";
  round: number;
  totalRounds: number;
  table: number[];
  tableTotal: number;
  prizesLeft: number;
  you: { seat: number; hand: number[]; submitted: boolean; yourCard: number | null; left: boolean };
  players: { seat: number; name: string; score: number; left: boolean; submitted: boolean; handCount: number }[];
  history: HagetakaHistoryEntry[];
  lastResult: HagetakaHistoryEntry | null;
  standings: { seat: number; score: number; rank: number }[] | null;
};

function prizeLabel(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as HagetakaView | null;
  const mySeat = view.player.seat;
  const finishRef = useRef<string | null>(null);

  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    const myRank = state.standings?.find((s) => s.seat === mySeat)?.rank;
    playSe(myRank === 1 ? "win" : "click");
  }, [state, mySeat, view.code]);

  if (!state) return <p className="og-muted">対戦の開始を待っています…</p>;

  const canBid = state.phase === "bidding" && !state.you.submitted && !state.you.left;
  const last = state.lastResult;
  const lastTakerName = last?.taker !== null && last?.taker !== undefined
    ? state.players.find((p) => p.seat === last.taker)?.name
    : null;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : ""} ・ {p.score}点 ・ 残り{p.handCount}枚
            {state.phase === "bidding" ? (p.submitted ? " ・ 出した" : " ・ 考え中") : ""}
          </span>
        ))}
      </div>

      {state.phase === "finished" ? (
        <div style={{ textAlign: "center", margin: "16px 0" }}>
          <p style={{ fontSize: 20, fontWeight: 700 }}>対戦終了</p>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {(state.standings ?? []).map((s) => {
              const p = state.players.find((x) => x.seat === s.seat);
              return (
                <li key={s.seat} style={{ margin: "4px 0" }}>
                  {s.rank}位: {p?.name}
                  {s.seat === mySeat ? "（あなた）" : ""} ・ {s.score}点
                </li>
              );
            })}
          </ul>
          <p className="og-muted">再戦は下のボタンからどうぞ。</p>
        </div>
      ) : (
        <>
          <p style={{ textAlign: "center", margin: "12px 0 4px" }}>
            ラウンド {state.round + 1} / {state.totalRounds}
          </p>
          <div style={{ textAlign: "center", margin: "8px 0" }} role="group" aria-label="場の得点カード">
            <span className="og-muted">場の得点カード: </span>
            {state.table.map((v, i) => (
              <span
                key={i}
                style={{
                  display: "inline-block",
                  minWidth: 44,
                  padding: "8px 6px",
                  margin: "0 3px",
                  borderRadius: 8,
                  fontWeight: 700,
                  fontSize: 18,
                  color: "#fff",
                  background: v >= 0 ? "#43a35c" : "#e2534a",
                }}
              >
                {prizeLabel(v)}
              </span>
            ))}
            <span style={{ marginLeft: 8, fontWeight: 700 }}>合計 {prizeLabel(state.tableTotal)}</span>
          </div>
          <p className="og-muted" style={{ textAlign: "center" }}>
            {state.tableTotal >= 0
              ? "合計がプラスのときは、一番高い数字を出した人が取ります。"
              : "合計がマイナスのときは、一番低い数字を出した人が引き取ります。"}
            同じ数字同士は無効になり、決着しないと次へ持ち越します。
          </p>

          {canBid ? (
            <div
              role="group"
              aria-label="入札カードを選ぶ"
              style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", margin: "12px 0" }}
            >
              {state.you.hand.map((card) => (
                <button
                  key={card}
                  type="button"
                  className="og-btn"
                  style={{ minWidth: 48, minHeight: 52, fontSize: 17, fontWeight: 700 }}
                  onClick={() => void api.move({ type: "bid", card })}
                >
                  {card}
                </button>
              ))}
            </div>
          ) : (
            <p style={{ textAlign: "center", margin: "12px 0" }}>
              {state.you.left
                ? "退出したため、この対戦には参加していません。"
                : `あなたは ${state.you.yourCard} を出しました。全員の提出を待っています…`}
            </p>
          )}
        </>
      )}

      {last && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--line, #ddd)", paddingTop: 10 }}>
          <p style={{ fontWeight: 700, margin: "0 0 6px" }}>前ラウンド（{last.round + 1}）の結果</p>
          <p style={{ margin: "0 0 6px" }}>
            得点カード {last.prizes.map(prizeLabel).join(" / ")}（合計 {prizeLabel(last.prizeTotal)}）→{" "}
            {last.carried
              ? "全員同じ数字で無効になり、持ち越しになりました"
              : last.taker !== null
                ? `${lastTakerName} が取りました`
                : "誰も取りませんでした"}
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {last.bids.map((b) => {
              const p = state.players.find((x) => x.seat === b.seat);
              return (
                <span key={b.seat} className="og-score">
                  {p?.name}: {b.card !== null ? b.card : "―"}
                  {last.taker === b.seat ? " 🏆" : ""}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function HagetakaClient() {
  return (
    <OnlineShell gameId="hagetaka" title="ハゲタカ" playerRange={{ min: 2, max: 6 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
