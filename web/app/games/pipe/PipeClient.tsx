"use client";
// パイプつなぎ。ロジックは lib/pipe.ts（解の存在する生成・回転・水の流れ判定）。
// タイルをタップすると90度回転し、水源から水が届くタイルは色づく。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  createPipeGame,
  flowIndices,
  pipeOpenings,
  rotatePipe,
  type PipeCell,
  type PipeState,
} from "@/lib/pipe";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-pipe-best";

function loadBest(): number | null {
  try {
    const v = Number(localStorage.getItem(BEST_KEY));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  } catch {
    return null;
  }
}

/** タイル1枚を SVG で描く。開口方向へ中心から線を伸ばす。 */
function TileSvg({ cell, flowing }: { cell: PipeCell; flowing: boolean }) {
  const openings = pipeOpenings(cell);
  const ends: Record<number, [number, number]> = {
    0: [25, 0],
    1: [50, 25],
    2: [25, 50],
    3: [0, 25],
  };
  const stroke = flowing ? "#38bdf8" : "#94a3b8";
  return (
    <svg viewBox="0 0 50 50" width="100%" height="100%" aria-hidden="true">
      {openings.map((d) => (
        <line key={d} x1={25} y1={25} x2={ends[d][0]} y2={ends[d][1]} stroke={stroke} strokeWidth={9} strokeLinecap="round" />
      ))}
      <circle cx={25} cy={25} r={6} fill={stroke} />
    </svg>
  );
}

export default function PipeClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<PipeState>(() => createPipeGame(Date.now() % 2147483647));
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setBest(loadBest());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  useEffect(() => {
    if (!hydrated || state.status !== "won" || seconds <= 0) return;
    if (best !== null && seconds >= best) return;
    setBest(seconds);
    try {
      localStorage.setItem(BEST_KEY, String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [hydrated, state.status, seconds, best]);

  const flow = useMemo(() => new Set(flowIndices(state)), [state]);
  const won = state.status === "won";

  const restart = () => {
    setState(createPipeGame(Date.now() % 2147483647));
    setSeconds(0);
  };

  const cellLabel = (index: number): string => {
    if (index === state.source) return "水源";
    if (index === state.drain) return "排水口";
    return "パイプ";
  };

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "16px 12px 40px" }}>
      <p style={{ margin: "0 0 8px" }}>
        <Link href={`${prefix}/games`} style={{ color: "#38bdf8", fontSize: 14 }}>
          ← ゲーム一覧へ
        </Link>
      </p>
      <h1 style={{ fontSize: 22, margin: "0 0 6px" }}>🚰 パイプつなぎ</h1>
      <p style={{ margin: "0 0 12px", color: "#64748b", fontSize: 14, lineHeight: 1.6 }}>
        タイルをタップすると90度回転します。左端の水源（💧）から右端の排水口（🕳️）までつなげてください。
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 12, fontSize: 14 }}>
        <span>手数: {state.moves}</span>
        <span>時間: {seconds}秒</span>
        <span>ベスト: {best !== null ? `${best}秒` : "—"}</span>
        <button
          type="button"
          onClick={restart}
          style={{
            padding: "8px 18px", borderRadius: 999, border: "1px solid #8a90a3",
            background: "#22304f", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", minHeight: 40,
          }}
        >
          もう一度
        </button>
      </div>

      <p role="status" style={{ minHeight: 22, margin: "0 0 10px", fontWeight: 700, color: won ? "#16a34a" : "#334155" }}>
        {won ? `つながりました！ ${state.moves}手・${seconds}秒でクリアです。` : "水源から排水口までつなげましょう。"}
      </p>

      <div
        role="grid"
        aria-label="パイプの盤面"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${state.size}, 1fr)`,
          gap: 4,
          width: "100%",
          maxWidth: 420,
          margin: "0 auto",
        }}
      >
        {state.cells.map((cell, i) => {
          const isSource = i === state.source;
          const isDrain = i === state.drain;
          const flowing = flow.has(i);
          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              aria-label={`${cellLabel(i)}${flowing ? "（水が流れている）" : ""}`}
              disabled={won}
              onClick={() => setState((s) => rotatePipe(s, i))}
              style={{
                aspectRatio: "1",
                padding: 2,
                borderRadius: 8,
                border: isSource || isDrain ? "2px solid #0284c7" : "1px solid #cbd5e1",
                background: isSource ? "#e0f2fe" : isDrain ? "#fef3c7" : flowing ? "#f0f9ff" : "#f8fafc",
                cursor: won ? "default" : "pointer",
                position: "relative",
                minHeight: 44,
              }}
            >
              <TileSvg cell={cell} flowing={flowing} />
              {isSource && <span style={{ position: "absolute", top: 1, left: 3, fontSize: 12 }}>💧</span>}
              {isDrain && <span style={{ position: "absolute", top: 1, right: 3, fontSize: 12 }}>🕳️</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
