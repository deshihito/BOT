"use client";
// 2x2 ルービックキューブ。ロジックは lib/cube.ts（ステッカーモデル）。
// 本体は 3D の立方体（CubeScene3D）で、面タップ=時計回り、面スワイプ=その
// 方向への回転、背景ドラッグ=視点回転。WebGL 不可時は展開図＋回転ボタン（2D）
// へフォールバックする。端末内で完結する。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

const CubeScene3D = dynamic(() => import("./CubeScene3D"), { ssr: false });
import { sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
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
  const [webglFailed, setWebglFailed] = useState(false);
  // 3D シーンの回転アニメーション用: 直近に適用した手と連番。
  const [lastMove, setLastMove] = useState<{ move: CubeMove; seq: number } | null>(null);
  const moveSeqRef = useRef(0);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  const prevStatusRef = useRef(state.status);
  const [winPrevBest, setWinPrevBest] = useState<number | null>(null);
  const [winNewBest, setWinNewBest] = useState(false);

  // 終局遷移の捕捉はベスト保存 effect より前に置き、保存前のベストを記録する。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev !== "won" && state.status === "won") {
      setWinPrevBest(best);
      setWinNewBest(best === null || state.moves < best);
      sfxWin();
    }
  }, [state.status, state.moves, best]);

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

  const restart = () => {
    setState(createCubeGame(Date.now() % 2147483647));
    setLastMove(null);
    setWinPrevBest(null);
    setWinNewBest(false);
  };
  const doMove = (move: CubeMove) => {
    // 完成後は lib が手を無効化するので、3D の回転アニメーションも起こさない。
    if (state.status === "won") return;
    sfxTap();
    moveSeqRef.current += 1;
    setLastMove({ move, seq: moveSeqRef.current });
    setState((s) => applyCubeMove(s, move));
  };

  const statusText =
    state.status === "won"
      ? `完成！ ${state.moves} 手でそろえました。`
      : "全ての面を1色にそろえよう。";

  const board2d = (
    <>
      <div
        className={state.status === "won" ? "juice-pop" : undefined}
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

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>2x2キューブ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>2x2キューブ</h1>
        <p className="muted">面をタップで時計回り、面をなぞるとその方向に回ります。背景をドラッグすると視点が回ります。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {state.moves} 手{best !== null ? ` ・ ベスト ${best} 手` : ""} ・ {statusText}
      </p>

      {webglFailed ? board2d : (
        <div style={{ maxWidth: 460, margin: "0 auto" }}>
          <CubeScene3D
            stickers={state.stickers}
            status={state.status}
            lastMove={lastMove}
            onMove={doMove}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      {state.status === "won" && (
        <div style={{ maxWidth: 460, margin: "16px auto 0" }}>
          <EndScreen
            outcome="win"
            title="完成！"
            score={state.moves}
            scoreLabel="手数"
            newBest={winNewBest}
            previousBest={winPrevBest}
            onRetry={restart}
          >
            <p className="muted" style={{ margin: 0 }}>
              {state.moves} 手でそろえました。
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
