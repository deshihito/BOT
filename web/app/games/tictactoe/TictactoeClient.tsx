"use client";
// 三目並べオンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約: board は 9 マス（0=空き, 1=seat0=○, 2=seat1=×）、
// 着手は { type: "place", index }。
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { playSe } from "@/lib/balku-sound";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const TictactoeScene3D = dynamic(() => import("./TictactoeScene3D"), { ssr: false });
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";
import { useRoomJuice } from "../GameJuice";

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
  // 櫻井流バッチ2: 着手の反映に小ヒットストップ、決着に大ヒット＋フラッシュ（音は既存の playSe 系に任せる）。
  useRoomJuice(`${state?.turn ?? ""}`, state?.finished ?? false);
  const mySeat = view.player.seat;
  const [webglFailed, setWebglFailed] = useState(false);
  const finishRef = useRef<string | null>(null);
  const turnRef = useRef<number | null>(null);
  // state に lastMove が無いので、前回盤面との差分で最後に置かれたマスを割り出す
  const prevBoardRef = useRef<number[] | null>(null);
  const prevBoard = prevBoardRef.current;
  useEffect(() => {
    prevBoardRef.current = state?.board ?? null;
  }, [state]);

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
  const lastPlaced =
    prevBoard !== null
      ? state.board.findIndex((v, i) => cellSeat(prevBoard[i] ?? 0) === -1 && cellSeat(v) >= 0)
      : -1;
  const winSet = new Set(state.winCells ?? []);
  const turnName = state.players.find((p) => p.seat === state.turn)?.name ?? `プレイヤー${state.turn + 1}`;
  const winnerName =
    state.winner === "draw"
      ? null
      : state.players.find((p) => p.seat === state.winner)?.name ??
        (typeof state.winner === "number" ? `プレイヤー${state.winner + 1}` : null);

  // 着手ハンドラ（2D のマスボタンと 3D シーンで共有。送信は api.move 経路）。
  const onCell = (index: number) => {
    if (!myTurn) return;
    if (cellSeat(state.board[index]) !== -1) return;
    playSe("play");
    void api.move({ type: "place", index });
  };

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
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
            className={index === lastPlaced ? "juice-pop" : undefined}
            disabled={!playable}
            aria-label={`${Math.floor(index / 3) + 1}行${(index % 3) + 1}列${seat === 0 ? " ○" : seat === 1 ? " ×" : playable ? " 置けます" : ""}`}
            onClick={() => onCell(index)}
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
  );

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
      {webglFailed ? board2d : (
        <div style={{ width: "min(88vw, 360px)", margin: "0 auto" }}>
          <TictactoeScene3D
            board={state.board}
            winCells={state.winCells}
            onCell={onCell}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}
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
