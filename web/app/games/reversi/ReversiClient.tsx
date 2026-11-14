"use client";
// リバーシ（オセロ）オンライン対戦クライアント。盤面は OnlineShell の
// children で描く。view.state の形はモジュール側の契約:
// board は 64 マス（0=空き, 1=seat0, 2=seat1 を基本とし、-1=seat1 も許容）、
// 着手は { type: "place", index }、パスは { type: "pass" }。
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { playSe } from "@/lib/balku-sound";
import { sfxHit } from "@/lib/sfx";
import { juiceFlash, juiceHitstop, type JuiceIntensity } from "@/lib/juice";
import { JuiceHit } from "../GameJuice";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const ReversiScene3D = dynamic(() => import("./ReversiScene3D"), { ssr: false });
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

type ReversiState = {
  board: number[];
  turn: number;
  yourLegalMoves: number[];
  counts: [number, number];
  lastMove: number | null;
  lastPass: number | boolean | null;
  finished: boolean;
  winner: number | "draw" | null;
  players: { seat: number; name: string }[];
};

/** board の値を seat に変換する（空きは -1）。 */
function cellSeat(value: number): number {
  if (value === 1) return 0;
  if (value === 2 || value === -1) return 1;
  return -1;
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as ReversiState | null;
  const mySeat = view.player.seat;
  const finishRef = useRef<string | null>(null);
  const turnRef = useRef<number | null>(null);
  const prevBoardRef = useRef<number[] | null>(null);
  const [flipped, setFlipped] = useState<ReadonlySet<number>>(new Set());
  const [webglFailed, setWebglFailed] = useState(false);
  const boardWrapRef = useRef<HTMLDivElement | null>(null);
  const [burst, setBurst] = useState<{ key: number; x: number; y: number; intensity: JuiceIntensity }>({ key: 0, x: 50, y: 50, intensity: 1 });

  // 前回盤面と比較し、色が変わった石に反転アニメーションを付ける。
  // あわせて手応え層: 反転数で強さを変えたヒット音＋ヒットストップ＋
  // 着手位置のヒットマークを出す（#003/#130）。
  useEffect(() => {
    const cur = state?.board ?? null;
    const prev = prevBoardRef.current;
    if (cur) prevBoardRef.current = [...cur];
    if (!prev || !cur) return;
    const next = new Set<number>();
    for (let i = 0; i < 64; i++) {
      const a = cellSeat(prev[i]);
      const b = cellSeat(cur[i]);
      if (a >= 0 && b >= 0 && a !== b) next.add(i);
    }
    if (next.size === 0) return;
    setFlipped(next);
    const intensity: JuiceIntensity = next.size >= 5 ? 2 : 1;
    sfxHit(intensity);
    juiceHitstop(boardWrapRef.current, intensity);
    if (state?.lastMove != null) {
      setBurst({
        key: Date.now(),
        x: (((state.lastMove % 8) + 0.5) / 8) * 100,
        y: ((Math.floor(state.lastMove / 8) + 0.5) / 8) * 100,
        intensity,
      });
    }
    const timer = setTimeout(() => setFlipped(new Set()), 800);
    return () => clearTimeout(timer);
  }, [state?.board, state?.lastMove]);

  // 自分の手番が来たら知らせる
  useEffect(() => {
    if (!state || state.finished) return;
    const prev = turnRef.current;
    turnRef.current = state.turn;
    if (prev !== null && prev !== state.turn && state.turn === mySeat) playSe("turn");
  }, [state, mySeat]);

  // 終局の勝敗 SE（対局ごとに一度だけ）＋止めのヒットストップとフラッシュ
  useEffect(() => {
    if (!state?.finished) return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    playSe(state.winner === "draw" ? "click" : state.winner === mySeat ? "win" : "lose");
    juiceHitstop(boardWrapRef.current, 2);
    juiceFlash(boardWrapRef.current);
  }, [state?.finished, state?.winner, mySeat, view.code]);

  if (!state) return <p className="og-muted">盤面を待っています…</p>;

  const myTurn = !state.finished && state.turn === mySeat;
  const legal = new Set(state.yourLegalMoves ?? []);
  const turnName = state.players.find((p) => p.seat === state.turn)?.name ?? `プレイヤー${state.turn + 1}`;
  const winnerName =
    state.winner === "draw" ? null : state.players.find((p) => p.seat === state.winner)?.name ?? (typeof state.winner === "number" ? `プレイヤー${state.winner + 1}` : null);

  const board2d = (
    <div className="og-reversi-board" role="grid" aria-label="リバーシ盤面">
      {state.board.map((value, index) => {
        const seat = cellSeat(value);
        const isLegal = myTurn && seat === -1 && legal.has(index);
        return (
          <button
            key={index}
            type="button"
            role="gridcell"
            className={`og-cell og-reversi-cell juice-pressable${state.lastMove === index ? " og-cell-last" : ""}`}
            disabled={!isLegal}
            aria-label={`${Math.floor(index / 8) + 1}行${(index % 8) + 1}列${seat >= 0 ? (seat === 0 ? " 黒" : " 白") : isLegal ? " 置けます" : ""}`}
            onClick={() => {
              playSe("play");
              void api.move({ type: "place", index });
            }}
          >
            {seat >= 0 ? (
              <span
                className={`og-disc og-disc-${seat}${state.lastMove === index ? " juice-pop" : ""}${flipped.has(index) ? " og-disc-flipping" : ""}`}
                style={
                  flipped.has(index) && state.lastMove !== null
                    ? {
                        animationDelay: `${(Math.abs(Math.floor(index / 8) - Math.floor(state.lastMove / 8)) + Math.abs((index % 8) - (state.lastMove % 8))) * 45}ms`,
                      }
                    : undefined
                }
                aria-hidden="true"
              />
            ) : isLegal ? <span className="og-legal-dot" aria-hidden="true" /> : null}
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
            {p.seat === mySeat ? "（あなた）" : ""}: {state.counts[p.seat] ?? 0}
          </span>
        ))}
      </div>
      {state.lastPass != null && state.lastPass !== false && !state.finished && <p className="og-notice-inline">置ける場所がなく、パスしました。</p>}
      <div ref={boardWrapRef} style={{ position: "relative", width: "min(94vw, 560px)", margin: "0 auto" }}>
        {webglFailed ? (
          board2d
        ) : (
          <ReversiScene3D
            cells={state.board.map(cellSeat)}
            legalMoves={[...legal]}
            lastMove={state.lastMove}
            flipped={[...flipped]}
            myTurn={myTurn}
            onPlace={place}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        )}
        <JuiceHit burstKey={burst.key} intensity={burst.intensity} xPct={burst.x} yPct={burst.y} continuous />
      </div>
      {myTurn && legal.size === 0 && (
        <div className="og-actions">
          <button
            type="button"
            className="og-btn og-btn-primary"
            onClick={() => {
              playSe("click");
              void api.move({ type: "pass" });
            }}
          >
            置ける場所がないのでパス
          </button>
        </div>
      )}
    </div>
  );
}

export default function ReversiClient() {
  return (
    <OnlineShell gameId="reversi" title="リバーシ" playerRange={{ min: 2, max: 2 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
