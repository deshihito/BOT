"use client";
// ワニワニ。ロジックは lib/crocodile.ts（当たりの歯はシードで決まり、CPU の手も決定的）。
// ベスト記録の設計: localStorage `ago-crocodile-best` に「勝った回数」を保存する。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  createCrocodileGame,
  pressTooth,
  remainingTeeth,
  type CrState,
} from "@/lib/crocodile";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-crocodile-best";
// 上あご7本（index 0〜6）、下あご6本（index 7〜12）の並びで表示する。
const UPPER = [0, 1, 2, 3, 4, 5, 6];
const LOWER = [7, 8, 9, 10, 11, 12];

function newGame(): CrState {
  return createCrocodileGame(Date.now() % 2147483647);
}

export default function CrocodileClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<CrState>(() => newGame());
  const [wins, setWins] = useState(0);
  const countedSeed = useRef<number | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setWins(Number.isFinite(saved) && saved > 0 ? Math.floor(saved) : 0);
    } catch {
      setWins(0);
    }
  }, []);

  useEffect(() => {
    if (state.status !== "won") return;
    if (countedSeed.current === state.seed) return;
    countedSeed.current = state.seed;
    setWins((w) => {
      const next = w + 1;
      try {
        window.localStorage.setItem(BEST_KEY, String(next));
      } catch {
        // 保存失敗はプレイに影響しない。
      }
      return next;
    });
  }, [state.status, state.seed]);

  const restart = () => setState(newGame());

  const remaining = remainingTeeth(state);
  const statusText =
    state.status === "won"
      ? "CPU が当たりの歯を押した！口が閉じて、あなたの勝ちです。"
      : state.status === "lost"
        ? "ガブッ！当たりの歯を押してしまった。あなたの負けです。"
        : state.lastCpu !== null
          ? `CPU は ${state.lastCpu + 1} 番の歯を押して無事だった。残り ${remaining} 本。あなたの番です。`
          : `当たりは1本だけ。歯を1本押してください（残り ${remaining} 本）。`;

  const toothButton = (index: number, upper: boolean) => {
    const pressed = state.pressed[index];
    const isTrapHit = state.status !== "playing" && index === state.trap;
    const isLast = state.lastPlayer === index || state.lastCpu === index;
    return (
      <button
        key={index}
        type="button"
        disabled={pressed || state.status !== "playing"}
        aria-label={`${index + 1} 番の歯${pressed ? "（押した）" : ""}`}
        onClick={() => setState((s) => pressTooth(s, index))}
        style={{
          width: "12%",
          minWidth: 34,
          height: 52,
          border: "1px solid #b8b09a",
          borderRadius: upper ? "4px 4px 14px 14px" : "14px 14px 4px 4px",
          background: isTrapHit ? "#e0483e" : pressed ? "#cfc9b8" : "#fffdf4",
          opacity: pressed && !isTrapHit ? 0.45 : 1,
          transform: pressed ? (upper ? "translateY(-6px) scaleY(0.55)" : "translateY(6px) scaleY(0.55)") : undefined,
          boxShadow: isLast && state.status === "playing" ? "0 0 0 2px #f0a13a" : undefined,
          fontSize: 11,
          color: "#6b6455",
          cursor: pressed || state.status !== "playing" ? "default" : "pointer",
          transition: "transform 0.15s ease, opacity 0.15s ease",
        }}
      >
        {index + 1}
      </button>
    );
  };

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ワニワニ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ワニワニ</h1>
        <p className="muted">
          歯をタップして1本ずつ押していきます。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        残り {remaining} 本 ・ あなたの勝利数 {wins} ・ {statusText}
      </p>

      <div
        role="group"
        aria-label="ワニの口"
        style={{
          maxWidth: 520,
          border: "3px solid #2e7d46",
          borderRadius: 24,
          background: "linear-gradient(#57a773, #3d8b5f)",
          padding: "18px 14px",
          transform: state.status === "lost" ? "scaleY(0.92)" : undefined,
          transition: "transform 0.2s ease",
        }}
      >
        <div style={{ textAlign: "center", fontSize: 40, lineHeight: 1 }} aria-hidden>
          {state.status === "lost" ? "😱" : "🐊"}
        </div>
        <div
          style={{
            background: "#8e2f35",
            borderRadius: 16,
            padding: "10px 8px",
            display: "grid",
            gap: 8,
            marginTop: 10,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 4 }}>
            {UPPER.map((i) => toothButton(i, true))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 4, padding: "0 6%" }}>
            {LOWER.map((i) => toothButton(i, false))}
          </div>
        </div>
        <p style={{ textAlign: "center", margin: "10px 0 0", color: "#eaf7ee", fontSize: 13 }}>
          上あご7本・下あご6本。番号の小さい順に並んでいます。
        </p>
      </div>

      {state.status !== "playing" && (
        <div className="classic-controls" style={{ marginTop: 12 }} role="group" aria-label="再戦">
          <button type="button" className="classic-btn classic-btn-active" style={{ minHeight: 48, minWidth: 140 }} onClick={restart}>
            もう一度遊ぶ
          </button>
        </div>
      )}
    </>
  );
}
