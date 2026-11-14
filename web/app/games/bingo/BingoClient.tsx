"use client";
// ビンゴ。ロジックは lib/bingo.ts（5x5カード・抽選1〜75・ライン判定）。
// CPU 3枚と同時に進行し、先にビンゴした方が勝ち。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

const BingoScene3D = dynamic(() => import("./BingoScene3D"), { ssr: false });
import { sfxLose, sfxSpawn, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import {
  BINGO_LINES,
  cardStatus,
  columnLetter,
  createBingoGame,
  drawNext,
  isMarked,
  winnerMessage,
  type BingoState,
} from "@/lib/bingo";
import { useGamesNav } from "../GamesShell";

const CPU_NAMES = ["CPU あお", "CPU あか", "CPU きいろ"];
const CPU_COLORS = ["#33509e", "#b03a3a", "#b5892d"];

const btnStyle: React.CSSProperties = {
  padding: "10px 20px",
  borderRadius: 999,
  border: "1px solid #8a90a3",
  background: "#22304f",
  color: "#fff",
  fontSize: 16,
  fontWeight: 700,
  cursor: "pointer",
  minHeight: 44,
};
export default function BingoClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<BingoState>(() => createBingoGame(Date.now() % 2147483647));
  const [auto, setAuto] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);

  useEffect(() => {
    if (!auto || state.phase !== "playing") return;
    const id = setInterval(() => setState((s) => drawNext(s)), 1100);
    return () => clearInterval(id);
  }, [auto, state.phase]);

  useEffect(() => {
    if (state.phase === "finished") setAuto(false);
  }, [state.phase]);

  const prevDrawnRef = useRef(state.drawn.length);
  useEffect(() => {
    if (state.drawn.length > prevDrawnRef.current) sfxSpawn();
    prevDrawnRef.current = state.drawn.length;
  }, [state.drawn.length]);

  const prevPhaseRef = useRef(state.phase);
  useEffect(() => {
    if (prevPhaseRef.current !== "finished" && state.phase === "finished") {
      if (state.winner?.type === "player") sfxWin();
      else if (state.winner?.type === "cpu") sfxLose();
    }
    prevPhaseRef.current = state.phase;
  }, [state.phase, state.winner]);

  const restart = () => {
    setAuto(false);
    setState(createBingoGame(Date.now() % 2147483647));
  };

  const handleDraw = () => {
    sfxTap();
    setState((s) => drawNext(s));
  };

  const playerStatus = cardStatus(state.playerCard, state.drawn);
  const lineCellSet = new Set<number>();
  for (const line of BINGO_LINES) {
    if (playerStatus.lines.includes(line.id)) {
      for (const i of line.cells) lineCellSet.add(i);
    }
  }
  const lastDrawn = state.drawn[state.drawn.length - 1];
  const playing = state.phase === "playing";

  const board2d = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "14px 18px",
        borderRadius: 12,
        background: "#1d2735",
        color: "#dfe7ef",
        maxWidth: 520,
      }}
      aria-label="抽選機（2D表示）"
    >
      <span
        style={{
          width: 64,
          height: 64,
          borderRadius: 999,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 20,
          fontWeight: 800,
          background: "#f2b33d",
          color: "#1c2333",
          flexShrink: 0,
        }}
      >
        {lastDrawn !== undefined ? `${columnLetter(lastDrawn)}-${lastDrawn}` : "—"}
      </span>
      <span style={{ fontSize: 14 }}>
        {lastDrawn !== undefined
          ? `最新の数字は ${columnLetter(lastDrawn)}-${lastDrawn} です。下の抽選履歴でも確認できます。`
          : "「次の数字を引く」で抽選が始まります。"}
      </span>
    </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ビンゴ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ビンゴ</h1>
        <p className="muted">「次の数字を引く」で1球ずつ進みます。数字は自動でマークされます。</p>
      </div>

      <p className="classic-status" role="status">
        {state.drawn.length} 球目
        {lastDrawn !== undefined ? ` ・ 最新 ${columnLetter(lastDrawn)}-${lastDrawn}` : ""}
        {playing
          ? playerStatus.bingo
            ? ""
            : playerStatus.reach
              ? ` ・ リーチ！ あと1マス（${playerStatus.reachCount}ライン）`
              : ` ・ ビンゴまであと最短 ${playerStatus.minRemaining} マス`
          : ` ・ ${winnerMessage(state, CPU_NAMES)}`}
      </p>

      <div className="classic-controls" style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        {playing ? (
          <>
            <button type="button" style={btnStyle} onClick={handleDraw}>
              次の数字を引く
            </button>
            <button
              type="button"
              style={btnStyle}
              aria-pressed={auto}
              onClick={() => {
                sfxTap();
                setAuto((v) => !v);
              }}
            >
              {auto ? "自動進行を止める" : "自動で進める"}
            </button>
          </>
        ) : null}
      </div>

      {webglFailed ? (
        <div style={{ marginBottom: 16 }}>{board2d}</div>
      ) : (
        <div style={{ maxWidth: 520, marginBottom: 16 }}>
          <BingoScene3D
            drawn={state.drawn}
            canDraw={playing}
            onDraw={handleDraw}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      {!playing && (
        <EndScreen
          outcome={state.winner?.type === "player" ? "win" : state.winner?.type === "cpu" ? "lose" : "draw"}
          title={winnerMessage(state, CPU_NAMES)}
          onRetry={restart}
        >
          <p className="muted">
            {state.drawn.length} 球で決着 ・ 完成ライン {playerStatus.lines.length} ・ マーク {playerStatus.markedCount} / 25
          </p>
        </EndScreen>
      )}

      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
        <section aria-label="あなたのカード">
          <div
            role="grid"
            aria-label="あなたのビンゴカード"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 52px)",
              gap: 5,
              justifyContent: "start",
            }}
          >
            {"BINGO".split("").map((letter) => (
              <div
                key={letter}
                style={{ textAlign: "center", fontWeight: 800, fontSize: 18, color: "#22304f" }}
              >
                {letter}
              </div>
            ))}
            {state.playerCard.cells.map((value, i) => {
              const marked = isMarked(state.playerCard, state.drawn, i);
              const inLine = lineCellSet.has(i);
              return (
                <div
                  key={i}
                  className={inLine ? "juice-pulse" : undefined}
                  role="gridcell"
                  aria-label={value === 0 ? "フリー" : `${value}${marked ? "（的中）" : ""}`}
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 10,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: value === 0 ? 13 : 19,
                    fontWeight: 700,
                    border: "1px solid #b9bdc9",
                    background: inLine ? "#f2b33d" : marked ? "#33509e" : "#ffffff",
                    color: inLine ? "#1c2333" : marked ? "#ffffff" : "#1c2333",
                    userSelect: "none",
                  }}
                >
                  {value === 0 ? "FREE" : value}
                </div>
              );
            })}
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 14 }}>
            完成ライン {playerStatus.lines.length} ・ マーク {playerStatus.markedCount} / 25
          </p>
        </section>

        <section aria-label="CPU の進捗" style={{ minWidth: 230 }}>
          <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>CPU の進捗</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
            {state.cpuCards.map((card, i) => {
              const st = cardStatus(card, state.drawn);
              return (
                <li
                  key={i}
                  style={{
                    border: "1px solid #d5d8e0",
                    borderRadius: 10,
                    padding: "8px 12px",
                    fontSize: 14,
                    background: st.bingo ? "#fdf3d7" : "#ffffff",
                  }}
                >
                  <span style={{ color: CPU_COLORS[i], fontWeight: 800 }}>{CPU_NAMES[i]}</span>
                  {" ・ "}
                  {st.bingo ? (
                    <strong>ビンゴ！</strong>
                  ) : st.reach ? (
                    <strong>リーチ（{st.reachCount}ライン）</strong>
                  ) : (
                    <>あと最短 {st.minRemaining} マス</>
                  )}
                  <span className="muted"> ・ マーク {st.markedCount}</span>
                </li>
              );
            })}
          </ul>

          <h2 style={{ fontSize: 16, margin: "16px 0 8px" }}>抽選履歴</h2>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", maxWidth: 300 }} aria-label="引かれた数字">
            {state.drawn.length === 0 && <span className="muted">まだ引いていません</span>}
            {[...state.drawn].reverse().map((n, i) => (
              <span
                key={`${n}-${i}`}
                className={i === 0 ? "juice-pop" : undefined}
                style={{
                  minWidth: 34,
                  height: 34,
                  padding: "0 4px",
                  borderRadius: 999,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  fontWeight: 700,
                  background: i === 0 ? "#f2b33d" : "#eef0f5",
                  color: "#1c2333",
                  border: "1px solid #d5d8e0",
                }}
              >
                {columnLetter(n)}-{n}
              </span>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
