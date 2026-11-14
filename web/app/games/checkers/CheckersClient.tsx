"use client";
// チェッカーオンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約: board は 64 マス（0=空, 1=seat0, 2=seat1, 3=seat0キング, 4=seat1キング）、
// yourMoves に合法手（強制取り・連続取り反映済み）が入り、着手は { type: "move", from, to }。
// コマを選ぶと移動可能マスがハイライトされ、連続取り中は同じコマが自動で選択され続ける。
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { playSe } from "@/lib/balku-sound";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const CheckersScene3D = dynamic(() => import("./CheckersScene3D"), { ssr: false });
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

type CheckersMove = { from: number; to: number; captured: number | null; promote: boolean };

type CheckersState = {
  board: number[];
  turn: number;
  mustCaptureFrom: number | null;
  yourMoves: CheckersMove[];
  counts: [number, number];
  lastMove: { from: number; to: number } | null;
  finished: boolean;
  winner: number | "draw" | null;
  players: { seat: number; name: string }[];
};

function ownerOf(value: number): number {
  if (value === 1 || value === 3) return 0;
  if (value === 2 || value === 4) return 1;
  return -1;
}

function isKing(value: number): boolean {
  return value === 3 || value === 4;
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as CheckersState | null;
  const mySeat = view.player.seat;
  const [selected, setSelected] = useState<number | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);
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

  // 連続取り中は同じコマを継続選択し、それ以外で選択中コマに合法手が
  // 無くなったら選択を解除する。
  useEffect(() => {
    if (!state || state.finished || state.turn !== mySeat) {
      if (state?.turn !== mySeat) setSelected(null);
      return;
    }
    if (state.mustCaptureFrom !== null) {
      setSelected(state.mustCaptureFrom);
      return;
    }
    setSelected((cur) => {
      if (cur === null) return null;
      return (state.yourMoves ?? []).some((m) => m.from === cur) ? cur : null;
    });
  }, [state, mySeat]);

  if (!state) return <p className="og-muted">盤面を待っています…</p>;

  const myTurn = !state.finished && state.turn === mySeat;
  const moves = state.yourMoves ?? [];
  const movableFrom = new Set(moves.map((m) => m.from));
  const targets = selected !== null ? moves.filter((m) => m.from === selected) : [];
  const targetSet = new Set(targets.map((m) => m.to));
  const captureTargets = new Set(targets.filter((m) => m.captured !== null).map((m) => m.to));
  const hasCapture = moves.some((m) => m.captured !== null);
  const turnName = state.players.find((p) => p.seat === state.turn)?.name ?? `プレイヤー${state.turn + 1}`;
  const winnerName =
    state.winner === "draw"
      ? null
      : state.players.find((p) => p.seat === state.winner)?.name ??
        (typeof state.winner === "number" ? `プレイヤー${state.winner + 1}` : null);

  const onCell = (index: number) => {
    if (!myTurn) return;
    const value = state.board[index];
    // 移動先としてハイライトされているマスなら着手する。
    if (selected !== null && targetSet.has(index)) {
      playSe("play");
      setSelected(null);
      void api.move({ type: "move", from: selected, to: index });
      return;
    }
    // 自分の動かせるコマなら選択／再選択する。
    if (ownerOf(value) === mySeat && movableFrom.has(index)) {
      playSe("click");
      setSelected(index);
      return;
    }
    // 連続取り中は選択を変えられない。それ以外は選択解除のみ。
    if (state.mustCaptureFrom === null) setSelected(null);
  };

  const board2d = (
    <>
      <div
        role="grid"
        aria-label="チェッカー盤面"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(8, minmax(0, 1fr))",
          gap: 2,
          width: "min(92vw, 520px)",
          margin: "0 auto",
          padding: 8,
          borderRadius: 10,
          background: "#7a4a21",
          border: "2px solid #5d3715",
        }}
      >
        {state.board.map((value, index) => {
          const row = Math.floor(index / 8);
          const col = index % 8;
          const dark = (row + col) % 2 === 1;
          const owner = ownerOf(value);
          const isSelected = selected === index;
          const isTarget = targetSet.has(index);
          const isCaptureTarget = captureTargets.has(index);
          const isLast = state.lastMove !== null && (state.lastMove.from === index || state.lastMove.to === index);
          const canSelect = myTurn && owner === mySeat && movableFrom.has(index);
          const clickable = myTurn && (canSelect || isTarget);
          return (
            <button
              key={index}
              type="button"
              role="gridcell"
              disabled={!clickable}
              aria-label={`${row + 1}行${col + 1}列${
                owner === 0 ? " 先手のコマ" : owner === 1 ? " 後手のコマ" : ""
              }${isKing(value) ? "（キング）" : ""}${isTarget ? " 移動できます" : ""}${isSelected ? " 選択中" : ""}`}
              onClick={() => onCell(index)}
              style={{
                aspectRatio: "1",
                display: "grid",
                placeItems: "center",
                border: "none",
                borderRadius: 4,
                padding: 0,
                background: isSelected
                  ? "#ffd94d"
                  : isCaptureTarget
                    ? "#f2a65a"
                    : isTarget
                      ? "#a8d08d"
                      : isLast
                        ? dark
                          ? "#b08954"
                          : "#e6cf9f"
                        : dark
                          ? "#9c6b30"
                          : "#ecd7ac",
                cursor: clickable ? "pointer" : "default",
                touchAction: "manipulation",
                position: "relative",
              }}
            >
              {owner >= 0 ? (
                <span
                  aria-hidden="true"
                  className={state.lastMove?.to === index ? "juice-pop" : undefined}
                  style={{
                    display: "grid",
                    placeItems: "center",
                    width: "82%",
                    height: "82%",
                    borderRadius: "50%",
                    background:
                      owner === 0
                        ? "radial-gradient(circle at 35% 30%, #55555e, #17171b 72%)"
                        : "radial-gradient(circle at 35% 30%, #f08080, #a93226 72%)",
                    boxShadow: "0 2px 4px rgba(0,0,0,0.45), inset 0 0 0 3px rgba(255,255,255,0.22)",
                    color: "#ffd94d",
                    fontSize: "clamp(11px, 3.4vw, 18px)",
                    fontWeight: 900,
                    lineHeight: 1,
                  }}
                >
                  {isKing(value) ? "♛" : ""}
                </span>
              ) : isTarget ? (
                <span
                  aria-hidden="true"
                  style={{
                    display: "block",
                    width: isCaptureTarget ? "34%" : "26%",
                    height: isCaptureTarget ? "34%" : "26%",
                    borderRadius: "50%",
                    background: isCaptureTarget ? "rgba(169,50,38,0.75)" : "rgba(46,110,46,0.6)",
                    pointerEvents: "none",
                  }}
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </>
  );

  return (
    <div className="og-board-wrap">
      <div className={`og-turn-banner${myTurn ? " og-turn-mine" : ""}${state.finished ? " juice-slide" : myTurn ? " juice-pulse" : ""}`} role="status">
        {state.finished
          ? state.winner === "draw"
            ? "引き分け"
            : `勝者: ${winnerName ?? "—"}${state.winner === mySeat ? "" : ""}`
          : myTurn
            ? state.mustCaptureFrom !== null
              ? "連続取り中です。同じコマで続けて取ってください"
              : hasCapture
                ? "あなたの手番です。取れるコマがあるので取らなければなりません"
                : "あなたの手番です。コマを選んでください"
            : `${turnName} の手番です（待機中）`}
      </div>
      <div className="og-score-row">
        {state.players.map((p) => (
          <span
            key={p.seat}
            className={`og-score${state.turn === p.seat && !state.finished ? " og-score-turn" : ""}`}
          >
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: p.seat === 0 ? "#26262b" : "#c0392b",
                boxShadow: "inset 0 0 0 2px rgba(255,255,255,0.35)",
              }}
            />
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}: {state.counts[p.seat] ?? 0} 個
          </span>
        ))}
      </div>
      {webglFailed ? (
        board2d
      ) : (
        <div style={{ width: "min(94vw, 520px)", margin: "0 auto" }}>
          <CheckersScene3D
            board={state.board}
            selected={selected}
            targets={[...targetSet]}
            captureTargets={[...captureTargets]}
            lastMove={state.lastMove}
            onCell={onCell}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}
      <p className="og-muted" style={{ textAlign: "center" }}>
        {mySeat === 0 ? "あなたは先手（黒）で、下段から上へ進みます。" : "あなたは後手（赤）で、上段から下へ進みます。"}
        取れる手があるときは必ず取らなければならず、続けて取れる場合は連続取りになります。最奥列に届くとキング（♛）になり、全方向へ動けます。
      </p>
    </div>
  );
}

export default function CheckersClient() {
  return (
    <OnlineShell gameId="checkers" title="チェッカー" playerRange={{ min: 2, max: 2 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
