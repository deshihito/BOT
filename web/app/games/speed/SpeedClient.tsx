"use client";
// スピード（トランプ）オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約: you/opponent（hand は場札で公開、stockCount のみ山札）、
// centers は中央2山の一番上と枚数。着手は { type: "play", handIndex, center } か
// { type: "connect" }（つなぎ札）。手番は無く、両者が同時に出せる。
import { useEffect, useRef, useState } from "react";
import { playSe } from "@/lib/balku-sound";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

type SpeedSide = {
  seat: number;
  name: string;
  hand: number[];
  stockCount: number;
  total: number;
  left: boolean;
};

type SpeedState = {
  you: SpeedSide;
  opponent: SpeedSide;
  centers: { top: number | null; count: number }[];
  connectReady: boolean[];
  yourPlays: { handIndex: number; center: number }[];
  youCanConnect: boolean;
  finished: boolean;
  winner: number | null;
  connectCount: number;
  lastPlay: { seat: number; card: number; center: number } | null;
  players: { seat: number; name: string }[];
};

const SUITS = ["♠", "♥", "♦", "♣"] as const;

function cardText(id: number): { label: string; red: boolean } {
  const suit = SUITS[Math.floor(id / 13)] ?? "♠";
  const rank = (id % 13) + 1;
  const rankLabel = rank === 1 ? "A" : rank === 11 ? "J" : rank === 12 ? "Q" : rank === 13 ? "K" : String(rank);
  return { label: `${suit}${rankLabel}`, red: suit === "♥" || suit === "♦" };
}

function CardFace({ id, small }: { id: number; small?: boolean }) {
  const { label, red } = cardText(id);
  return (
    <span
      style={{
        display: "inline-grid",
        placeItems: "center",
        minWidth: small ? 40 : 52,
        height: small ? 54 : 70,
        padding: "0 4px",
        borderRadius: 8,
        border: "2px solid #c9b489",
        background: "#fffdf6",
        color: red ? "#c0392b" : "#243447",
        fontWeight: 800,
        fontSize: small ? 15 : 19,
        lineHeight: 1,
      }}
    >
      {label}
    </span>
  );
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as SpeedState | null;
  const mySeat = view.player.seat;
  const [selected, setSelected] = useState<number | null>(null);
  const finishRef = useRef<string | null>(null);

  useEffect(() => {
    setSelected(null);
  }, [view.code, state?.you.hand.join(",")]);

  useEffect(() => {
    if (!state?.finished) return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    playSe(state.winner === mySeat ? "win" : "lose");
  }, [state?.finished, state?.winner, mySeat, view.code]);

  if (!state) return <p className="og-muted">盤面を待っています…</p>;

  const { you, opponent } = state;
  const myTurnFree = !state.finished;
  const legalCentersFor = (handIndex: number) =>
    state.yourPlays.filter((p) => p.handIndex === handIndex).map((p) => p.center);
  const selectedLegal = selected !== null ? legalCentersFor(selected) : [];
  const iAmReady = state.connectReady[mySeat] ?? false;
  const oppReady = state.connectReady[opponent.seat] ?? false;
  const winnerName =
    state.winner === null
      ? null
      : state.players.find((p) => p.seat === state.winner)?.name ?? `プレイヤー${state.winner + 1}`;

  const playTo = (handIndex: number, center: number) => {
    playSe("play");
    setSelected(null);
    void api.move({ type: "play", handIndex, center });
  };

  const onHandCard = (handIndex: number) => {
    if (!myTurnFree) return;
    const legal = legalCentersFor(handIndex);
    if (legal.length === 1) {
      playTo(handIndex, legal[0]);
      return;
    }
    if (legal.length >= 2) {
      setSelected(selected === handIndex ? null : handIndex);
      return;
    }
    setSelected(selected === handIndex ? null : handIndex);
  };

  return (
    <div className="og-board-wrap">
      <div className={`og-turn-banner${state.finished ? "" : " og-turn-mine"}`} role="status">
        {state.finished
          ? `勝者: ${winnerName ?? "—"}${state.winner === mySeat ? " 🎉" : ""}`
          : "同時進行です。出せる札はどんどん出してください。"}
      </div>

      <div className="og-score-row">
        <span className="og-score">
          {opponent.name}
          {opponent.left ? "（退出）" : ""} ・ 残り {opponent.total} 枚（山札 {opponent.stockCount}）
          {oppReady ? " ・ つなぎ準備OK" : ""}
        </span>
        <span className="og-score">
          {you.name}（あなた） ・ 残り {you.total} 枚（山札 {you.stockCount}）
        </span>
      </div>

      <p className="og-muted" style={{ textAlign: "center", margin: "4px 0 2px" }}>
        相手の場札
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", minHeight: 54 }}>
        {opponent.hand.map((id) => (
          <CardFace key={id} id={id} small />
        ))}
        {opponent.hand.length === 0 && <span className="og-muted">場札なし</span>}
      </div>

      <p className="og-muted" style={{ textAlign: "center", margin: "12px 0 2px" }}>
        中央の山（タップで出す）
      </p>
      <div style={{ display: "flex", gap: 16, justifyContent: "center" }}>
        {state.centers.map((pile, center) => {
          const canHere = selected !== null && selectedLegal.includes(center);
          return (
            <button
              key={center}
              type="button"
              disabled={!canHere}
              aria-label={`中央の山${center + 1}${pile.top !== null ? ` 一番上は ${cardText(pile.top).label}` : ""}${canHere ? " 出せます" : ""}`}
              onClick={() => {
                if (selected !== null) playTo(selected, center);
              }}
              style={{
                display: "grid",
                placeItems: "center",
                gap: 4,
                padding: 10,
                borderRadius: 12,
                border: canHere ? "3px solid #46a758" : "2px solid #c9b489",
                background: canHere ? "#eefbf0" : "#f3ead8",
                cursor: canHere ? "pointer" : "default",
                touchAction: "manipulation",
              }}
            >
              {pile.top !== null ? <CardFace id={pile.top} /> : <span className="og-muted">（空）</span>}
              <span style={{ fontSize: 12, color: "#6b5f45" }}>{pile.count} 枚</span>
            </button>
          );
        })}
      </div>

      {state.lastPlay && (
        <p className="og-muted" style={{ textAlign: "center" }}>
          {state.lastPlay.seat === mySeat ? "あなた" : opponent.name} が {cardText(state.lastPlay.card).label}{" "}
          を出しました
        </p>
      )}

      <p className="og-muted" style={{ textAlign: "center", margin: "12px 0 2px" }}>
        あなたの場札（出せる札は枠が光ります）
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", minHeight: 70 }}>
        {you.hand.map((id, handIndex) => {
          const legal = legalCentersFor(handIndex);
          const playable = myTurnFree && legal.length > 0;
          const isSelected = selected === handIndex;
          return (
            <button
              key={id}
              type="button"
              disabled={!myTurnFree}
              aria-label={`場札 ${cardText(id).label}${playable ? " 出せます" : ""}`}
              aria-pressed={isSelected}
              onClick={() => onHandCard(handIndex)}
              style={{
                padding: 0,
                border: "none",
                background: "transparent",
                borderRadius: 10,
                outline: isSelected
                  ? "3px solid #d9a41c"
                  : playable
                    ? "3px solid #46a758"
                    : "2px solid transparent",
                outlineOffset: 2,
                cursor: myTurnFree ? "pointer" : "default",
                touchAction: "manipulation",
              }}
            >
              <CardFace id={id} />
            </button>
          );
        })}
        {you.hand.length === 0 && <span className="og-muted">場札なし</span>}
      </div>

      <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
        {state.finished ? null : iAmReady ? (
          <p className="og-muted" role="status">
            つなぎ札の準備ができています。相手の準備を待っています…
          </p>
        ) : state.youCanConnect ? (
          <button
            type="button"
            className="classic-btn"
            onClick={() => {
              playSe("click");
              void api.move({ type: "connect" });
            }}
          >
            つなぎ札を出す{oppReady ? "（相手は準備OK・今押すと新しい札が出ます）" : ""}
          </button>
        ) : (
          <p className="og-muted">出せる札があります。つなぎ札は、両者とも出せなくなったときだけ使えます。</p>
        )}
      </div>

      <p className="og-muted" style={{ textAlign: "center" }}>
        中央の札とランクが±1つながり（K と A もつながります）の場札を出せます。出した分は山札から補充されます。
        場札と山札を先に全部無くした方が勝ちです。
      </p>
    </div>
  );
}

export default function SpeedClient() {
  return (
    <OnlineShell gameId="speed" title="スピード" playerRange={{ min: 2, max: 2 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
