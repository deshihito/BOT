"use client";
// 2x2 ルービックキューブ。ロジックは lib/cube.ts（ステッカーモデル）。
// 展開図で6面を表示し、面ごとの回転ボタンで操作する。端末内で完結する。
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  CUBE_FACES,
  applyCubeMove,
  createCubeGame,
  type CubeColor,
  type CubeFace,
  type CubeMove,
  type CubeState,
} from "@/lib/cube";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-cube-best";

const COLOR_HEX: Record<CubeColor, string> = {
  white: "#f8f8f8",
  yellow: "#ffd93b",
  green: "#2ecc71",
  blue: "#3498db",
  orange: "#ff8c1a",
  red: "#e74c3c",
};

const FACE_LABEL: Record<CubeFace, string> = {
  U: "上",
  D: "下",
  F: "前",
  B: "後",
  L: "左",
  R: "右",
};

function FaceView({ state, face }: { state: CubeState; face: CubeFace }) {
  const base = CUBE_FACES.indexOf(face) * 4;
  return (
    <div
      role="img"
      aria-label={`${FACE_LABEL[face]}の面`}
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, 1fr)",
        gap: 3,
        padding: 4,
        borderRadius: 8,
        background: "#22252a",
      }}
    >
      {state.stickers.slice(base, base + 4).map((color, i) => (
        <div
          key={i}
          style={{
            aspectRatio: "1",
            borderRadius: 4,
            background: COLOR_HEX[color],
          }}
        />
      ))}
    </div>
  );
}

export default function CubeClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<CubeState>(() => createCubeGame(Date.now() % 2147483647));
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  useEffect(() => {
    if (state.status !== "won") return;
    if (best !== null && state.moves >= best) return;
    setBest(state.moves);
    try {
      window.localStorage.setItem(BEST_KEY, String(state.moves));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, state.moves, best]);

  const restart = () => setState(createCubeGame(Date.now() % 2147483647));
  const doMove = (move: CubeMove) => setState((s) => applyCubeMove(s, move));

  const statusText =
    state.status === "won"
      ? `完成！ ${state.moves} 手でそろえました。`
      : "全ての面を1色にそろえよう。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>2x2キューブ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>2x2キューブ</h1>
        <p className="muted">各面の ⟳⟲ ボタンで90度ずつ回して操作します。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {state.moves} 手{best !== null ? ` ・ ベスト ${best} 手` : ""} ・ {statusText}
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 76px))",
          gap: 8,
          justifyContent: "center",
          margin: "0 auto",
        }}
        role="group"
        aria-label="キューブの展開図"
      >
        <div />
        <FaceView state={state} face="U" />
        <div />
        <div />
        <FaceView state={state} face="L" />
        <FaceView state={state} face="F" />
        <FaceView state={state} face="R" />
        <FaceView state={state} face="B" />
        <div />
        <FaceView state={state} face="D" />
        <div />
        <div />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 8,
          maxWidth: 460,
          margin: "16px auto 0",
        }}
        role="group"
        aria-label="回転ボタン"
      >
        {CUBE_FACES.map((face) => (
          <div
            key={face}
            style={{
              border: "1px solid var(--line)",
              borderRadius: 10,
              padding: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
            }}
          >
            <span style={{ fontWeight: 700, fontSize: 14 }}>
              {FACE_LABEL[face]}（{face}）
            </span>
            <span style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className="classic-btn"
                style={{ minWidth: 44, minHeight: 44, fontSize: 16 }}
                aria-label={`${FACE_LABEL[face]}の面を時計回りに回す`}
                onClick={() => doMove(face)}
              >
                ⟳
              </button>
              <button
                type="button"
                className="classic-btn"
                style={{ minWidth: 44, minHeight: 44, fontSize: 16 }}
                aria-label={`${FACE_LABEL[face]}の面を反時計回りに回す`}
                onClick={() => doMove(`${face}'` as CubeMove)}
              >
                ⟲
              </button>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
