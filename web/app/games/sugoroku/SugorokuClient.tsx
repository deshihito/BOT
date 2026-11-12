"use client";
// すごろく。ロジックは lib/sugoroku.ts（30マス・CPU 2人とのレース）。
// 自分の番はボタンでサイコロを振り、CPU の番と自動進行モードはタイマーで進む。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  SUGOROKU_GOAL,
  createSugorokuGame,
  describeEffect,
  isCpuTurn,
  rollDice,
  squareEffect,
  type SugorokuState,
} from "@/lib/sugoroku";
import { useGamesNav } from "../GamesShell";
import { sfxDice, sfxLose, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";

const PLAYER_COLORS = ["#2563eb", "#dc2626", "#059669"];

/** プレイヤーのコマを色ドットで描く（絵文字は使わない）。 */
function PlayerDot({ index, size = 13 }: { index: number; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: PLAYER_COLORS[index],
        border: "2px solid #ffffff",
        boxShadow: "0 0 0 1px rgba(0,0,0,0.25)",
        verticalAlign: "middle",
      }}
    />
  );
}

function effectIcon(index: number): string {
  if (index === 0) return "";
  if (index === SUGOROKU_GOAL) return "";
  const e = squareEffect(index);
  switch (e.type) {
    case "forward":
      return "»";
    case "back":
      return "«";
    case "skip":
      return "休";
    case "coins":
      return e.amount >= 0 ? "＋" : "－";
    default:
      return "";
  }
}

export default function SugorokuClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<SugorokuState>(() => createSugorokuGame(Date.now() % 2147483647));
  const [auto, setAuto] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  const cpuTurn = isCpuTurn(state);
  const needAutoStep = state.status === "playing" && (cpuTurn || auto);

  useEffect(() => {
    if (!needAutoStep) return;
    const id = setTimeout(() => {
      sfxDice();
      setState((s) => rollDice(s));
    }, cpuTurn ? 900 : 700);
    return () => clearTimeout(id);
  }, [needAutoStep, cpuTurn, state]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.log.length]);

  const restart = () => {
    setState(createSugorokuGame(Date.now() % 2147483647));
  };

  const endSoundRef = useRef<SugorokuState | null>(null);
  useEffect(() => {
    if (state.status !== "finished") return;
    if (endSoundRef.current === state) return;
    endSoundRef.current = state;
    if (state.winner === 0) sfxWin();
    else sfxLose();
  }, [state]);

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>すごろく</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>すごろく</h1>
        <p className="muted">自分の番にサイコロを振って進みます。CPUの番は自動で進行します。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button
          type="button"
          className="classic-btn"
          disabled={state.status !== "playing" || cpuTurn || auto}
          onClick={() => { sfxDice(); setState((s) => rollDice(s)); }}
          style={{ fontWeight: 800 }}
        >
          サイコロを振る
        </button>
        <button
          type="button"
          aria-pressed={auto}
          className={auto ? "classic-btn classic-btn-active" : "classic-btn"}
          onClick={() => setAuto((v) => !v)}
        >
          {auto ? "⏸ 自動進行を止める" : "▶ 自動進行"}
        </button>
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {state.status === "finished"
          ? `${state.winner !== null ? state.players[state.winner].name : ""} の勝ち！`
          : cpuTurn
            ? `${state.players[state.turn].name} の番です…`
            : auto
              ? "自動進行中です。"
              : "あなたの番です。サイコロを振ろう。"}
        {state.lastRoll !== null ? ` 直近の出目: ${state.lastRoll}` : ""}
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "4px 0 12px" }}>
        {state.players.map((p, i) => (
          <span
            key={p.name}
            className={state.turn === i && state.status === "playing" ? "juice-pulse" : undefined}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              border: `2px solid ${PLAYER_COLORS[i]}`,
              background: state.turn === i && state.status === "playing" ? "#fff7d6" : "#fffdf6",
              fontWeight: state.turn === i ? 800 : 400,
              fontSize: 14,
            }}
          >
            <PlayerDot index={i} /> {p.name}: {p.position} マス目 ・ コイン {p.coins} 枚
            {p.skipNext ? " ・ 次は休み" : ""}
          </span>
        ))}
      </div>

      <div
        role="img"
        aria-label="すごろくのコース"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
          gap: 5,
          maxWidth: 640,
          margin: "0 auto",
        }}
      >
        {Array.from({ length: SUGOROKU_GOAL + 1 }, (_, i) => {
          const here = state.players.map((p, pi) => (p.position === i ? pi : -1)).filter((pi) => pi >= 0);
          const e = squareEffect(i);
          const effectText = i === 0 ? "スタート" : i === SUGOROKU_GOAL ? "ゴール" : describeEffect(e);
          return (
            <div
              key={i}
              style={{
                minHeight: 62,
                borderRadius: 8,
                border: i === SUGOROKU_GOAL ? "2px solid #d9a41c" : "1px solid #e0d3b8",
                background: here.length > 0 ? "#eef6ff" : "#fffdf6",
                padding: "4px 5px",
                fontSize: 11,
                lineHeight: 1.35,
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 12 }}>
                {i} {effectIcon(i)}
              </div>
              <div style={{ color: "#666" }}>{effectText}</div>
              <div style={{ fontSize: 14, minHeight: 18 }}>
                {here.map((pi) => (
                  <span key={`${pi}-${state.players[pi].position}`} className="juice-pop" title={state.players[pi].name}>
                    <PlayerDot index={pi} />
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {state.status === "finished" && state.winner !== null ? (
        <div style={{ maxWidth: 640, margin: "0 auto 14px" }}>
          <EndScreen
            outcome={state.winner === 0 ? "win" : "lose"}
            title={`${state.players[state.winner].name} の勝ち！`}
            onRetry={restart}
          >
            <p className="muted" style={{ margin: 0 }}>
              {state.players.map((pl) => `${pl.name}: ${pl.position} マス目 ・ コイン ${pl.coins}`).join(" ／ ")}
            </p>
          </EndScreen>
        </div>
      ) : null}

      <div
        ref={logRef}
        role="log"
        aria-label="進行ログ"
        style={{
          maxWidth: 640,
          margin: "14px auto 0",
          maxHeight: 180,
          overflowY: "auto",
          border: "1px solid #e5e7eb",
          borderRadius: 10,
          background: "#fffdf6",
          padding: "8px 12px",
          fontSize: 13,
          lineHeight: 1.7,
        }}
      >
        {state.log.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </>
  );
}
