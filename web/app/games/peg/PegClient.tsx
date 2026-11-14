"use client";
// ペグソリティア（英式33穴）。ロジックは lib/peg.ts。
// ペグを選ぶと移動できる空き穴が光るので、そこを押して飛び越える。端末内で完結。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const PegScene3D = dynamic(() => import("./PegScene3D"), { ssr: false });
import {
  applyPegMove,
  createPegGame,
  isPegHole,
  pegCount,
  pegMovesFrom,
  pegRating,
  PEG_SIZE,
  type PegState,
} from "@/lib/peg";
import { sfxLose, sfxPlace, sfxSlide, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

export default function PegClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [state, setState] = useState<PegState>(() => createPegGame());
  const [selected, setSelected] = useState<number | null>(null);
  const [history, setHistory] = useState<PegState[]>([]);

  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev === state.status) return;
    if (state.status === "cleared") sfxWin();
    else if (state.status === "stuck") sfxLose();
  }, [state.status]);

  const remaining = pegCount(state);
  const destinations = selected !== null ? pegMovesFrom(state, selected) : [];
  const destSet = new Set(destinations.map((m) => m.to));

  const restart = () => {
    setState(createPegGame());
    setSelected(null);
    setHistory([]);
  };

  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    sfxSlide();
    setHistory(history.slice(0, -1));
    setState(prev);
    setSelected(null);
  };

  const onCell = (index: number) => {
    if (state.status !== "playing") return;
    if (selected !== null && destSet.has(index)) {
      const move = destinations.find((m) => m.to === index);
      if (move) {
        const next = applyPegMove(state, move);
        if (next !== state) {
          // 終局時は終局ジングルに任せ、二重に鳴らさない。
          if (next.status === "playing") sfxPlace();
          setHistory((h) => [...h.slice(-99), state]);
          setState(next);
          setSelected(null);
          return;
        }
      }
    }
    if (state.cells[index] === 1) {
      sfxTap();
      setSelected(selected === index ? null : index);
    } else {
      setSelected(null);
    }
  };

  const statusText =
    state.status === "cleared"
      ? `全クリア！ペグを1つだけ残せました。評価: ${pegRating(remaining)}`
      : state.status === "stuck"
        ? `もう動かせません。残り ${remaining} 個。評価: ${pegRating(remaining)}`
        : selected !== null
          ? "光っている空き穴を押すと、その方向へ飛び越えます。"
          : "ペグを押して選んでください。隣のペグを飛び越えて空き穴へ進めます。";

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
      <div
        role="grid"
        aria-label="ペグソリティアの盤"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${PEG_SIZE}, minmax(0, 1fr))`,
          gap: 6,
          width: "min(92vw, 420px)",
          margin: "0 auto",
          padding: 12,
          borderRadius: 14,
          background: "#8a5a2b",
          border: "2px solid #6e4520",
        }}
      >
        {state.cells.map((cell, index) => {
          const r = Math.floor(index / PEG_SIZE);
          const c = index % PEG_SIZE;
          if (!isPegHole(r, c) || cell === 0) {
            return <div key={index} aria-hidden="true" />;
          }
          const isDest = destSet.has(index);
          const isSelected = selected === index;
          const hasPeg = cell === 1;
          return (
            <button
              key={index}
              type="button"
              role="gridcell"
              aria-label={
                hasPeg
                  ? `${r + 1}行${c + 1}列のペグ${isSelected ? "（選択中）" : ""}`
                  : `${r + 1}行${c + 1}列の空き穴${isDest ? "（移動できます）" : ""}`
              }
              onClick={() => onCell(index)}
              className={isSelected ? "juice-pulse" : undefined}
              style={{
                aspectRatio: "1",
                display: "grid",
                placeItems: "center",
                borderRadius: "50%",
                border: isSelected
                  ? "3px solid #ffd94d"
                  : isDest
                    ? "3px solid #7ce38b"
                    : "2px solid #5d3c1a",
                background: "#a06a33",
                boxShadow: "inset 0 2px 5px rgba(0,0,0,0.45)",
                cursor: "pointer",
                padding: 0,
                touchAction: "manipulation",
              }}
            >
              {hasPeg ? (
                <span
                  aria-hidden="true"
                  className="juice-pop"
                  style={{
                    display: "block",
                    width: "72%",
                    height: "72%",
                    borderRadius: "50%",
                    background: isSelected
                      ? "radial-gradient(circle at 35% 30%, #ffe9a8, #e0a92e)"
                      : "radial-gradient(circle at 35% 30%, #f3f6ff, #7d94c4)",
                    boxShadow: "0 2px 4px rgba(0,0,0,0.4)",
                  }}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className={isDest ? "juice-pulse" : undefined}
                  style={{
                    display: "block",
                    width: isDest ? "46%" : "30%",
                    height: isDest ? "46%" : "30%",
                    borderRadius: "50%",
                    background: isDest ? "rgba(124,227,139,0.85)" : "rgba(0,0,0,0.35)",
                  }}
                />
              )}
            </button>
          );
        })}
      </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ペグソリティア</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ペグソリティア</h1>
        <p className="muted">
          残りペグの少なさを競う一人パズル。最後まで動けなくても、残した数で評価が出ます。
        </p>
      </div>

      <p className="classic-status" role="status">
        残りペグ {remaining} 個 ・ {state.moves} 手 ・ {statusText}
      </p>

      {webglFailed ? board2d : (
        <div style={{ width: "min(92vw, 440px)", margin: "0 auto" }}>
          <PegScene3D
            cells={state.cells}
            selected={selected}
            destinations={destinations.map((m) => m.to)}
            status={state.status}
            onCell={onCell}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      <div className="classic-controls">
        <button type="button" className="classic-btn" onClick={undo} disabled={history.length === 0}>
          1手もどす
        </button>
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      {state.status !== "playing" && (
        <div style={{ marginTop: 14 }}>
          <EndScreen
            outcome={state.status === "cleared" ? "win" : "finish"}
            title={state.status === "cleared" ? "全クリア！" : undefined}
            onRetry={restart}
          >
            <p>
              残りペグ {remaining} 個 ・ {state.moves} 手 ・ 評価: {pegRating(remaining)}
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
