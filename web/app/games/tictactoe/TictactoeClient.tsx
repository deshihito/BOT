"use client";
// 三目並べオンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約: board は 9 マス（0=空き, 1=seat0=○, 2=seat1=×）、
// 着手は { type: "place", index }。
import { useEffect, useRef } from "react";
import { playSe } from "@/lib/balku-sound";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

type TictactoeState = {
  board: number[];
  turn: number;
  winCells: number[] | null;
  finished: boolean;
  winner: number | "draw" | null;
  players: { seat: number; name: string }[];
};

function cellSeat(value: number): number {
  if (value === 1) return 0;
  if (value === 2 || value === -1) return 1;
  return -1;
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as TictactoeState | null;
  const mySeat = view.player.seat;
  const finishRef = useRef<string | null>(null);
  const turnRef = useRef<number | null>(null);

  useEffect(() => {
    if (!state || state.finished) return;
    const prev = turnRef.current;
    turnRef.current = state.turn;
    if (prev !== null && prev !== state.turn && state.turn === mySeat) playSe("turn");
  }, [state, mySeat]);

  useEffect(() => {
    if (!state?.finished) return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    playSe(state.winner === "draw" ? "click" : state.winner === mySeat ? "win" : "lose");
  }, [state?.finished, state?.winner, mySeat, view.code]);

  if (!state) return <p className="og-muted">盤面を待っています…</p>;

  const myTurn = !state.finished && state.turn === mySeat;
  const winSet = new Set(state.winCells ?? []);
  const turnName = state.players.find((p) => p.seat === state.turn)?.name ?? `プレイヤー${state.turn + 1}`;
  const winnerName =
    state.winner === "draw"
      ? null
      : state.players.find((p) => p.seat === state.winner)?.name ??
        (typeof state.winner === "number" ? `プレイヤー${state.winner + 1}` : null);

  return (
    <div className="og-board-wrap">
      <div className={`og-turn-banner${myTurn ? " og-turn-mine" : ""}`} role="status">
        {state.finished
          ? state.winner === "draw"
            ? "引き分け"
            : `勝者: ${winnerName ?? "—"}${state.winner === mySeat ? " 🎉" : ""}`
          : myTurn
            ? "あなたの手番です"
            : `${turnName} の手番です（待機中）`}
      </div>
      <div className="og-score-row">
        {state.players.map((p) => (
          <span
            key={p.seat}
            className={`og-score${state.turn === p.seat && !state.finished ? " og-score-turn" : ""}`}
          >
            <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1 }}>
              {p.seat === 0 ? "○" : "×"}
            </span>
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
          </span>
        ))}
      </div>
      <div
        role="grid"
        aria-label="三目並べ盤面"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 8,
          width: "min(88vw, 360px)",
          margin: "0 auto",
          padding: 10,
          borderRadius: 12,
          background: "#f3ead8",
          border: "2px solid #c9b489",
        }}
      >
        {state.board.map((value, index) => {
          const seat = cellSeat(value);
          const playable = myTurn && seat === -1;
          const isWin = winSet.has(index);
          return (
            <button
              key={index}
              type="button"
              role="gridcell"
              disabled={!playable}
              aria-label={`${Math.floor(index / 3) + 1}行${(index % 3) + 1}列${seat === 0 ? " ○" : seat === 1 ? " ×" : playable ? " 置けます" : ""}`}
              onClick={() => {
                playSe("play");
                void api.move({ type: "place", index });
              }}
              style={{
                aspectRatio: "1",
                display: "grid",
                placeItems: "center",
                border: isWin ? "3px solid #d9a41c" : "2px solid #d8c9a3",
                borderRadius: 10,
                background: isWin ? "#fff3c4" : "#fffdf6",
                fontSize: "clamp(36px, 12vw, 56px)",
                fontWeight: 800,
                lineHeight: 1,
                color: seat === 0 ? "#c0392b" : seat === 1 ? "#2456a6" : "transparent",
                cursor: playable ? "pointer" : "default",
                touchAction: "manipulation",
              }}
            >
              {seat === 0 ? "○" : seat === 1 ? "×" : "・"}
            </button>
          );
        })}
      </div>
      <p className="og-muted" style={{ textAlign: "center" }}>
        先手が ○、後手が × です。縦・横・斜めのどれか3つを先にそろえた方が勝ちです。相手が CPU の場合は最善手を指してくるので、引き分けに持ち込むのが目標になります。
      </p>
    </div>
  );
}

export default function TictactoeClient() {
  return (
    <OnlineShell gameId="tictactoe" title="三目並べ" playerRange={{ min: 2, max: 2 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
