"use client";
// 四目並べ（コネクト4）オンライン対戦クライアント。
// view.state の契約: board は 42 マス（row0=上、0=空き, 1=seat0, 2=seat1、
// -1=seat1 も許容）。着手は { type: "drop", col }。
import { useEffect, useRef } from "react";
import { playSe } from "@/lib/balku-sound";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

type Connect4State = {
  board: number[];
  turn: number;
  lastMove: number | null;
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
  const state = view.state as Connect4State | null;
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
    state.winner === "draw" ? null : state.players.find((p) => p.seat === state.winner)?.name ?? (typeof state.winner === "number" ? `プレイヤー${state.winner + 1}` : null);
  const columnFull = (col: number) => cellSeat(state.board[col]) !== -1;

  const drop = (col: number) => {
    if (!myTurn || columnFull(col)) return;
    playSe("play");
    void api.move({ type: "drop", col });
  };

  return (
    <div className="og-board-wrap">
      <div className={`og-turn-banner${myTurn ? " og-turn-mine" : ""}${state.finished ? " juice-slide" : myTurn ? " juice-pulse" : ""}`} role="status">
        {state.finished
          ? state.winner === "draw"
            ? "引き分け"
            : `勝者: ${winnerName ?? "—"}${state.winner === mySeat ? "" : ""}`
          : myTurn
            ? "あなたの手番です。列を選んでください"
            : `${turnName} の手番です（待機中）`}
      </div>
      <div className="og-score-row">
        {state.players.map((p) => (
          <span key={p.seat} className={`og-score${state.turn === p.seat && !state.finished ? " og-score-turn" : ""}`}>
            <span className={`og-disc og-disc-${p.seat}`} aria-hidden="true" />
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
          </span>
        ))}
      </div>
      <div className="og-c4-drop-row">
        {Array.from({ length: 7 }, (_, col) => (
          <button
            key={col}
            type="button"
            className="og-c4-drop-btn"
            disabled={!myTurn || columnFull(col)}
            aria-label={`${col + 1}列目に落とす`}
            onClick={() => drop(col)}
          >
            ▼
          </button>
        ))}
      </div>
      <div className="og-c4-board" role="grid" aria-label="四目並べ盤面">
        {state.board.map((value, index) => {
          const seat = cellSeat(value);
          const col = index % 7;
          return (
            <button
              key={index}
              type="button"
              role="gridcell"
              className={`og-cell og-c4-cell${state.lastMove === index ? " og-cell-last" : ""}${winSet.has(index) ? " og-cell-win" : ""}`}
              disabled={!myTurn || columnFull(col)}
              aria-label={`${Math.floor(index / 7) + 1}行${col + 1}列${seat >= 0 ? (seat === 0 ? " 先手の石" : " 後手の石") : ""}`}
              onClick={() => drop(col)}
            >
              {seat >= 0 ? <span className={`og-disc og-disc-${seat}${winSet.has(index) ? " og-disc-win" : ""}${state.lastMove === index ? " juice-pop" : ""}`} aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function Connect4Client() {
  return (
    <OnlineShell gameId="connect4" title="四目並べ" playerRange={{ min: 2, max: 2 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
