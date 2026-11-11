"use client";
// ライアーズダイス オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/liarsdice.ts の viewFor）:
//   you.dice は自分のダイスだけ。他人のダイスは個数（diceCount）しか公開されない。
//   宣言へのアクションは { type: "bid", count, face } / { type: "challenge" }。
//   チャレンジの開示結果は lastReveal（前のラウンドの全ダイスと実際の個数）。
// ルール: 1の目はワイルド。宣言は「個数を上げる」か「同じ個数で数字を上げる」。
import { useMemo, useState } from "react";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

const DICE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

type LdBid = { count: number; face: number; seat: number };
type LdReveal = {
  round: number;
  bid: LdBid;
  actual: number;
  challengerSeat: number;
  loserSeat: number;
  dice: Record<number, number[]>;
};
type LdViewPlayer = {
  seat: number;
  name: string;
  diceCount: number;
  left: boolean;
  eliminated: boolean;
  isCurrent: boolean;
};
type LdView = {
  phase: "bidding" | "finished";
  round: number;
  currentSeat: number;
  currentBid: LdBid | null;
  totalDice: number;
  winner: number | null;
  you: { seat: number; dice: number[]; left: boolean; eliminated: boolean; isYourTurn: boolean };
  players: LdViewPlayer[];
  lastReveal: LdReveal | null;
  standings: { seat: number; rank: number }[] | null;
};

function DiceRow({ dice, size = 30 }: { dice: number[]; size?: number }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      {dice.map((d, i) => (
        <span key={i} role="img" style={{ fontSize: size, lineHeight: 1 }} aria-label={`ダイス ${d}`}>
          {DICE_FACES[d - 1] ?? "?"}
        </span>
      ))}
    </span>
  );
}

function nameOf(view: LdView, seat: number): string {
  return view.players.find((p) => p.seat === seat)?.name ?? `プレイヤー${seat + 1}`;
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as LdView | null;
  const mySeat = view.player.seat;
  const [count, setCount] = useState(1);
  const [face, setFace] = useState(2);

  // 宣言フォームの初期値を、現在の宣言より一段強い値に寄せる。
  const suggestion = useMemo(() => {
    if (!state) return { count: 1, face: 2 };
    if (!state.currentBid) return { count: 1, face: 2 };
    if (state.currentBid.face < 6) return { count: state.currentBid.count, face: state.currentBid.face + 1 };
    return { count: state.currentBid.count + 1, face: 2 };
  }, [state]);

  if (!state) return <p className="og-muted">ダイスを待っています…</p>;

  const bid = state.currentBid;
  const isMyTurn = state.phase === "bidding" && state.you.isYourTurn && !state.you.left && !state.you.eliminated;
  const canRaise =
    isMyTurn &&
    count >= 1 &&
    count <= state.totalDice &&
    face >= 2 &&
    face <= 6 &&
    (!bid || count > bid.count || (count === bid.count && face > bid.face));
  const reveal = state.lastReveal;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.isCurrent ? "▶ " : ""}
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : p.eliminated ? "（脱落）" : ""} ・ ダイス {p.diceCount}個
          </span>
        ))}
      </div>

      <p className="og-muted" style={{ marginTop: 8 }}>
        ルール：1の目はワイルドで、どの数字としても数えます。宣言は前の人より「個数を上げる」か「同じ個数で数字を上げる」こと。嘘だと思ったらチャレンジ。
      </p>

      {state.phase === "bidding" ? (
        <>
          <p style={{ fontWeight: 800, margin: "10px 0 4px" }}>第{state.round}ラウンド ・ 場のダイス合計 {state.totalDice}個</p>
          <div style={{ border: "2px solid #d8c9a3", borderRadius: 12, padding: 12, background: "#fffdf6", marginBottom: 12 }}>
            <p style={{ margin: "0 0 6px", fontWeight: 700 }}>あなたのダイス</p>
            {state.you.dice.length > 0 ? (
              <DiceRow dice={state.you.dice} />
            ) : (
              <span className="og-muted">ダイスはありません（{state.you.left ? "退出" : "脱落"}）</span>
            )}
            <p style={{ margin: "10px 0 0" }}>
              {bid ? (
                <>
                  現在の宣言：<strong>{nameOf(state, bid.seat)}さんが「{bid.face} が {bid.count} 個」</strong>
                </>
              ) : (
                "まだ宣言はありません。"
              )}
            </p>
            <p style={{ margin: "4px 0 0" }}>
              {isMyTurn
                ? "あなたの手番です。宣言するか、チャレンジしてください。"
                : `${nameOf(state, state.currentSeat)}さんの手番です。`}
            </p>
          </div>

          {isMyTurn ? (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <label style={{ fontWeight: 700 }}>
                  個数{" "}
                  <select
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                    style={{ minHeight: 44, fontSize: 16, padding: "0 8px" }}
                  >
                    {Array.from({ length: state.totalDice }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}個
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ fontWeight: 700 }}>
                  数字{" "}
                  <select
                    value={face}
                    onChange={(e) => setFace(Number(e.target.value))}
                    style={{ minHeight: 44, fontSize: 16, padding: "0 8px" }}
                  >
                    {[2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={n}>
                        {n} {DICE_FACES[n - 1]}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="og-muted">
                  例：いまは「{suggestion.face} が {suggestion.count} 個」以上が宣言できます
                </span>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  disabled={!canRaise}
                  onClick={() => void api.move({ type: "bid", count, face })}
                  style={{
                    minHeight: 48,
                    padding: "0 20px",
                    borderRadius: 10,
                    border: "2px solid #92400e",
                    background: canRaise ? "#f59e0b" : "#e5e7eb",
                    color: "#111827",
                    fontSize: 16,
                    fontWeight: 800,
                    cursor: canRaise ? "pointer" : "default",
                  }}
                >
                  「{face} が {count} 個」と宣言する
                </button>
                {bid ? (
                  <button
                    type="button"
                    onClick={() => void api.move({ type: "challenge" })}
                    style={{
                      minHeight: 48,
                      padding: "0 20px",
                      borderRadius: 10,
                      border: "2px solid #b91c1c",
                      background: "#ef4444",
                      color: "#fff",
                      fontSize: 16,
                      fontWeight: 800,
                      cursor: "pointer",
                    }}
                  >
                    チャレンジ（嘘だ！）
                  </button>
                ) : null}
              </div>
              {!canRaise && bid ? (
                <p className="og-muted" style={{ margin: 0 }}>
                  前の宣言（{bid.face} が {bid.count} 個）より強い宣言にしてください。
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {reveal ? (
        <div style={{ border: "2px solid #93c5fd", borderRadius: 12, padding: 12, background: "#eff6ff", marginTop: 14 }}>
          <p style={{ fontWeight: 800, margin: "0 0 6px" }}>
            第{reveal.round}ラウンドの開示：{nameOf(state, reveal.bid.seat)}さんの宣言「{reveal.bid.face} が {reveal.bid.count} 個」
            → 実際は {reveal.actual} 個（{reveal.actual >= reveal.bid.count ? "宣言どおり！" : "嘘でした"}）
          </p>
          <p style={{ margin: "0 0 8px" }}>
            {nameOf(state, reveal.challengerSeat)}さんのチャレンジで、{nameOf(state, reveal.loserSeat)}さんがダイスを1個失いました。
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
            {state.players.map((p) => {
              const dice = reveal.dice[p.seat];
              if (!dice) return null;
              return (
                <li key={p.seat} style={{ fontSize: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700 }}>
                    {p.name}
                    {p.seat === mySeat ? "（あなた）" : ""}：
                  </span>
                  <DiceRow dice={dice} size={22} />
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {state.phase === "finished" && state.standings ? (
        <div style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: 20, margin: "0 0 10px" }}>最終結果</h2>
          {state.winner !== null ? (
            <p style={{ fontWeight: 800 }}>
              🏆 優勝は {nameOf(state, state.winner)}
              {state.winner === mySeat ? "（あなた）🎉" : ""} さんです！
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
                      border: s.seat === mySeat ? "2px solid #92400e" : "1px solid #e5e7eb",
                      background: s.rank === 1 ? "#fffbeb" : "#fff",
                      fontWeight: 700,
                    }}
                  >
                    <span>
                      {s.rank}位 {p.name}
                      {s.seat === mySeat ? "（あなた）" : ""}
                      {p.left ? "（退出）" : ""}
                    </span>
                    <strong>ダイス {p.diceCount}個</strong>
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

export default function LiarsDiceClient() {
  return (
    <OnlineShell gameId="liarsdice" title="ライアーズダイス" playerRange={{ min: 2, max: 6 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
