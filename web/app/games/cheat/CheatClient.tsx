"use client";
// ブラフ（オンライン）クライアント。ルーム管理は OnlineShell が担い、
// このコンポーネントは view.state（ゲーム別ビュー）の描画と操作だけを持つ。
// 契約: view.state.yourHand は自分の手札（カード id 配列）、他人は
// others[].count（枚数）だけが見える。場の伏せ札は lastPlay（宣言のみ公開）。
// 操作は { type: "play", cards } / { type: "challenge" }。
// 手番のランクは expectedRank で固定され、出すカード自体は自由（ブラフ可）。
// 直前の宣言にチャレンジしたい場合は、カードを出す前に押す。
import { useEffect, useState } from "react";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

type CheatOther = {
  seat: number;
  name: string;
  count: number;
  rank: number | null;
  left: boolean;
  candidate: boolean;
};
type CheatReveal = {
  seat: number;
  cards: number[];
  rank: number;
  honest: boolean;
  challenger: number;
  taker: number | null;
};
type CheatLogEntry = {
  seat: number;
  kind: "play" | "challenge" | "take" | "finish" | "last" | "left";
  count?: number;
  rank?: number;
  honest?: boolean;
};
type CheatViewState = {
  yourHand: number[];
  others: CheatOther[];
  turn: number;
  expectedRank: number;
  candidate: number | null;
  finishOrder: number[];
  yourRank: number | null;
  lastPlace: number | null;
  finished: boolean;
  pileCount: number;
  lastPlay: { seat: number; rank: number; count: number } | null;
  lastReveal: CheatReveal | null;
  log: CheatLogEntry[];
  players: { seat: number; name: string }[];
};

const RANK_LABELS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];

function rankLabel(rank: number): string {
  return RANK_LABELS[rank - 1] ?? String(rank);
}
function cardSuit(id: number): number {
  return Math.floor(id / 13);
}
function cardRank(id: number): number {
  return (id % 13) + 1;
}

function CardFace({ id, small }: { id: number; small?: boolean }) {
  const suit = cardSuit(id);
  const red = suit === 1 || suit === 2;
  return (
    <span
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        lineHeight: 1.05,
        color: red ? "#dc2626" : "#0f172a",
        fontWeight: 700,
        fontSize: small ? 12 : 15,
      }}
    >
      <span>{rankLabel(cardRank(id))}</span>
      <span style={{ fontSize: small ? 11 : 13 }}>{SUITS[suit]}</span>
    </span>
  );
}

export default function CheatClient() {
  return (
    <OnlineShell gameId="cheat" title="ブラフ" playerRange={{ min: 3, max: 6 }}>
      {(view, api) => <CheatTable view={view} api={api} />}
    </OnlineShell>
  );
}

function CheatTable({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as CheatViewState | null;
  const mySeat = view.player.seat;
  const [selected, setSelected] = useState<number[]>([]);

  // 手札が変わったら、もう持っていないカードの選択を外す。
  useEffect(() => {
    if (!state) return;
    setSelected((prev) => prev.filter((c) => state.yourHand.includes(c)).slice(0, 3));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.yourHand.join(",")]);

  if (!state) return <p className="muted">読み込み中です…</p>;

  const myTurn = !state.finished && state.turn === mySeat;
  const nameOf = (seat: number) =>
    state.players.find((p) => p.seat === seat)?.name ?? `プレイヤー${seat + 1}`;
  const canChallenge =
    myTurn && state.lastPlay !== null && state.lastPlay.seat !== mySeat;
  const iAmCandidate = state.candidate === mySeat;

  const toggleCard = (id: number) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((c) => c !== id);
      if (prev.length >= 3) return prev;
      return [...prev, id];
    });
  };

  const statusText = state.finished
    ? state.yourRank !== null
      ? `結果: あなたは ${state.yourRank} 位です。`
      : "対戦が終了しました。"
    : iAmCandidate
      ? "あなたは上がり候補です。次の人がチャレンジしなければ上がり確定です。"
      : myTurn
        ? canChallenge
          ? `${nameOf(state.lastPlay!.seat)}の宣言「${rankLabel(state.lastPlay!.rank)}を${state.lastPlay!.count}枚」にチャレンジできます。出さずにチャレンジするか、そのままカードを出してください。`
          : `あなたの手番です。「${rankLabel(state.expectedRank)}」の宣言で1〜3枚出してください（中身は自由です）。`
        : `${nameOf(state.turn)}の手番です。`;

  return (
    <div>
      <p className="classic-status" role="status">
        {statusText}
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {state.others.map((o) => (
          <span
            key={o.seat}
            style={{
              border: "1px solid #cbd5e1",
              borderRadius: 999,
              padding: "3px 10px",
              fontSize: 13,
              background:
                state.turn === o.seat && !state.finished ? "#fef3c7" : "#ffffff",
            }}
          >
            {o.name}: 残り{o.count}枚
            {o.candidate ? "（上がり候補）" : ""}
            {o.rank !== null ? `（${o.rank}位）` : ""}
            {o.left ? "（退出）" : ""}
          </span>
        ))}
        <span
          style={{
            border: "1px solid #cbd5e1",
            borderRadius: 999,
            padding: "3px 10px",
            fontSize: 13,
            background: "#f8fafc",
          }}
        >
          場の山 {state.pileCount}枚
        </span>
      </div>

      <div
        role="group"
        aria-label="場の宣言"
        style={{
          border: "1px solid #e2e8f0",
          borderRadius: 10,
          padding: 10,
          background: "#f8fafc",
          marginBottom: 12,
          fontSize: 14,
        }}
      >
        {state.lastPlay ? (
          <span>
            最新の宣言: {nameOf(state.lastPlay.seat)} が「{rankLabel(state.lastPlay.rank)}
            を {state.lastPlay.count} 枚」と宣言（伏せ札）
          </span>
        ) : (
          <span className="muted">場に宣言はまだありません。</span>
        )}
        {!state.finished ? (
          <span style={{ display: "block", marginTop: 4 }}>
            次の宣言ランク: <strong>{rankLabel(state.expectedRank)}</strong>
            {state.candidate !== null
              ? ` ・ ${nameOf(state.candidate)} が上がり候補です`
              : ""}
          </span>
        ) : null}
      </div>

      {state.lastReveal ? (
        <div
          role="group"
          aria-label="チャレンジの開示結果"
          style={{
            border: "1px solid #f59e0b",
            borderRadius: 10,
            padding: 10,
            background: "#fffbeb",
            marginBottom: 12,
            fontSize: 14,
          }}
        >
          <p style={{ margin: "0 0 6px" }}>
            {nameOf(state.lastReveal.challenger)} のチャレンジ: {nameOf(state.lastReveal.seat)}
            の宣言は
            <strong>{state.lastReveal.honest ? "本当でした" : "嘘でした"}</strong>。
            {state.lastReveal.taker !== null
              ? `場の山は ${nameOf(state.lastReveal.taker)} が引き取りました。`
              : "場の山は破棄されました。"}
          </p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {state.lastReveal.cards.map((id) => (
              <span
                key={id}
                style={{
                  border: "1px solid #94a3b8",
                  borderRadius: 6,
                  background: "#fff",
                  padding: "3px 6px",
                }}
              >
                <CardFace id={id} small />
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <h2 style={{ fontSize: 15, margin: "8px 0" }}>
        あなたの手札（{state.yourHand.length}枚）
        {state.yourRank !== null ? ` ・ ${state.yourRank}位確定` : ""}
      </h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {state.yourHand.map((id) => {
          const isSel = selected.includes(id);
          return (
            <button
              key={id}
              type="button"
              disabled={!myTurn}
              aria-pressed={isSel}
              aria-label={`${SUITS[cardSuit(id)]}の${rankLabel(cardRank(id))}`}
              onClick={() => toggleCard(id)}
              style={{
                border: isSel ? "2px solid #d97706" : "1px solid #cbd5e1",
                borderRadius: 8,
                background: isSel ? "#fffbeb" : "#ffffff",
                padding: "5px 7px",
                cursor: myTurn ? "pointer" : "default",
                boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
              }}
            >
              <CardFace id={id} />
            </button>
          );
        })}
        {state.yourHand.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>
            手札はありません。
          </span>
        ) : null}
      </div>

      {myTurn ? (
        <div className="classic-controls" role="group" aria-label="アクション">
          {canChallenge ? (
            <button
              type="button"
              className="classic-btn"
              style={{ borderColor: "#dc2626", color: "#dc2626", fontWeight: 700 }}
              onClick={() => void api.move({ type: "challenge" })}
            >
              チャレンジする
            </button>
          ) : null}
          <button
            type="button"
            className="classic-btn classic-btn-active"
            disabled={selected.length === 0}
            onClick={() => {
              void api.move({ type: "play", cards: selected });
              setSelected([]);
            }}
          >
            「{rankLabel(state.expectedRank)}を{selected.length}枚」と宣言して出す
          </button>
        </div>
      ) : null}

      {state.finished ? (
        <div style={{ marginTop: 12 }}>
          <h2 style={{ fontSize: 15, margin: "8px 0" }}>結果</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {state.players.map((p) => {
              const other = state.others.find((o) => o.seat === p.seat);
              const rank =
                p.seat === mySeat
                  ? state.yourRank
                  : (other?.rank ?? null);
              const left =
                p.seat === mySeat
                  ? false
                  : (other?.left ?? false);
              return (
                <li key={p.seat}>
                  {p.name}: {left ? "退出" : rank !== null ? `${rank}位` : "—"}
                  {rank === 1 ? " 🏆" : ""}
                </li>
              );
            })}
          </ul>
          <p className="muted">再戦は下のボタンからどうぞ。</p>
        </div>
      ) : null}

      {state.log.length > 0 ? (
        <ul
          role="log"
          aria-label="進行ログ"
          style={{ marginTop: 12, paddingLeft: 18, fontSize: 13, color: "#475569" }}
        >
          {state.log.slice(-6).map((entry, i) => (
            <li key={i}>
              {nameOf(entry.seat)}
              {entry.kind === "play"
                ? ` が「${rankLabel(entry.rank ?? 1)}を${entry.count ?? 0}枚」と宣言した`
                : entry.kind === "challenge"
                  ? ` がチャレンジ（宣言は${entry.honest ? "本当" : "嘘"}だった）`
                  : entry.kind === "take"
                    ? ` が場の山 ${entry.count ?? 0}枚を引き取った`
                    : entry.kind === "finish"
                      ? " が上がった"
                      : entry.kind === "last"
                        ? " が最後まで残った"
                        : " が退出した"}
            </li>
          ))}
        </ul>
      ) : null}

      <p style={{ fontSize: 13, color: "#475569", marginTop: 10 }}>
        ルール: 手番のランク（A→2→…→K の順）を宣言して伏せ札を1〜3枚出します。
        中身は宣言と違っても構いません。次の人は出す前にチャレンジでき、
        嘘なら出した人、本当ならチャレンジした人が場の山を全部引き取ります。
        手札を出し切ると上がり候補になり、次の人がチャレンジせずに出せば上がり確定です。
      </p>
    </div>
  );
}
