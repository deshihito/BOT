"use client";
// 五目並べオンライン対戦クライアント。
// view.state の契約: board は 225 マス（15×15、0=空き, 1=seat0, 2=seat1、
// -1=seat1 も許容）。着手は { type: "place", index }。
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { playSe } from "@/lib/balku-sound";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const GomokuScene3D = dynamic(() => import("./GomokuScene3D"), { ssr: false });
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";
import { useRoomJuice } from "../GameJuice";

type GomokuState = {
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
  const state = view.state as GomokuState | null;
  // 櫻井流バッチ2: 着手の反映に小ヒットストップ、決着に大ヒット＋フラッシュ（音は既存の playSe 系に任せる）。
  useRoomJuice(`${state?.turn ?? ""}`, state?.finished ?? false);
  const mySeat = view.player.seat;
  const finishRef = useRef<string | null>(null);
  const turnRef = useRef<number | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);

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

  const board2d = (
    <div className="og-gomoku-board" role="grid" aria-label="五目並べ盤面">
      {state.board.map((value, index) => {
        const seat = cellSeat(value);
        const playable = myTurn && seat === -1;
        return (
          <button
            key={index}
            type="button"
            role="gridcell"
            className={`og-cell og-gomoku-cell${state.lastMove === index ? " og-cell-last" : ""}${winSet.has(index) ? " og-cell-win" : ""}`}
            disabled={!playable}
            aria-label={`${Math.floor(index / 15) + 1}行${(index % 15) + 1}列${seat >= 0 ? (seat === 0 ? " 先手の石" : " 後手の石") : ""}`}
            onClick={() => {
              playSe("play");
              void api.move({ type: "place", index });
            }}
          >
            {seat >= 0 ? <span className={`og-disc og-disc-${seat}${winSet.has(index) ? " og-disc-win" : ""}${state.lastMove === index ? " juice-pop" : ""}`} aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );

  const place = (index: number) => {
    playSe("play");
    void api.move({ type: "place", index });
  };

  return (
    <div className="og-board-wrap">
      <div className={`og-turn-banner${myTurn ? " og-turn-mine" : ""}${state.finished ? " juice-slide" : myTurn ? " juice-pulse" : ""}`} role="status">
        {state.finished
          ? state.winner === "draw"
            ? "引き分け"
            : `勝者: ${winnerName ?? "—"}${state.winner === mySeat ? "" : ""}`
          : myTurn
            ? "あなたの手番です"
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
      {webglFailed ? (
        board2d
      ) : (
        <div style={{ width: "min(94vw, 520px)", margin: "0 auto" }}>
          <GomokuScene3D
            cells={state.board.map(cellSeat)}
            winCells={state.winCells ?? []}
            lastMove={state.lastMove}
            myTurn={myTurn}
            onPlace={place}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}
    </div>
  );
}

export default function GomokuClient() {
  return (
    <OnlineShell gameId="gomoku" title="五目並べ" playerRange={{ min: 2, max: 2 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
