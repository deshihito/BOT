"use client";
// ワニワニ（3D）。頭部と歯の描画・タップ判定は CrocodileScene3D（three.js、動的 import）、
// 進行は lib/crocodile.ts（当たりの歯はシードで決まり、CPU の手も決定的）。
// 歯をタップすると指が沈めに行き、当たりなら顎が高速で閉じる。
// ベスト記録の設計: localStorage `ago-crocodile-best` に「勝った回数」を保存する。
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  createCrocodileGame,
  pressTooth,
  remainingTeeth,
  type CrState,
} from "@/lib/crocodile";
import { isSfxMuted, setSfxMuted } from "@/lib/sfx";
import { useGamesNav } from "../GamesShell";

const CrocodileScene3D = dynamic(() => import("./CrocodileScene3D"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        height: 380,
        borderRadius: 24,
        background: "#e9f4ec",
        color: "#2f5d3a",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 14,
      }}
    >
      読み込み中…
    </div>
  ),
});

const BEST_KEY = "ago-crocodile-best";

function newGame(): CrState {
  return createCrocodileGame(Date.now() % 2147483647);
}

export default function CrocodileClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<CrState>(() => newGame());
  const [wins, setWins] = useState(0);
  const [muted, setMuted] = useState(false);
  const countedSeed = useRef<number | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setWins(Number.isFinite(saved) && saved > 0 ? Math.floor(saved) : 0);
    } catch {
      setWins(0);
    }
    setMuted(isSfxMuted());
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

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setSfxMuted(next);
  };

  const remaining = remainingTeeth(state);
  const statusText =
    state.status === "won"
      ? "CPU が当たりの歯を押した！口が閉じて、あなたの勝ちです。"
      : state.status === "lost"
        ? "ガブッ！当たりの歯を押してしまった。あなたの負けです。"
        : state.lastCpu !== null
          ? `CPU は ${state.lastCpu + 1} 番の歯を押して無事だった。残り ${remaining} 本。あなたの番です。`
          : `当たりは1本だけ。歯を1本押してください（残り ${remaining} 本）。`;

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
          ワニの歯をタップして1本ずつ押していきます。当たりの歯は1本だけ。押した方が負けです。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        <button type="button" className="classic-btn" onClick={toggleMute} aria-pressed={muted}>
          音: {muted ? "オフ" : "オン"}
        </button>
      </div>

      <p className="classic-status" role="status">
        残り {remaining} 本 ・ あなたの勝利数 {wins} ・ {statusText}
      </p>

      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        <CrocodileScene3D
          pressed={state.pressed}
          status={state.status}
          lastPlayer={state.lastPlayer}
          lastCpu={state.lastCpu}
          trap={state.trap}
          onPress={(index) => setState((s) => pressTooth(s, index))}
        />
        <p className="muted" style={{ fontSize: 13, marginTop: 8, textAlign: "center" }}>
          上あご7本・下あご6本の歯が対象です。押された歯は沈みます。
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
