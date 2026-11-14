"use client";
// パイプつなぎ。ロジックは lib/pipe.ts（解の存在する生成・回転・水の流れ判定）。
// タイルをタップすると90度回転し、水源から水が届くタイルは色づく。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const PipeScene3D = dynamic(() => import("./PipeScene3D"), { ssr: false });
import { sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
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
  const [webglFailed, setWebglFailed] = useState(false);
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

  const prevStatusRef = useRef(state.status);
  const [winPrevBest, setWinPrevBest] = useState<number | null>(null);
  const [winNewBest, setWinNewBest] = useState(false);

  // 終局遷移の捕捉はベスト保存 effect より前に置き、保存前のベストを記録する。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev !== "won" && state.status === "won") {
      setWinPrevBest(best);
      setWinNewBest(best === null || seconds < best);
      sfxWin();
    }
  }, [state.status, best, seconds]);

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
    setWinPrevBest(null);
    setWinNewBest(false);
  };

  const onTile = (index: number) => {
    if (state.status !== "playing") return;
    sfxTap();
    setState((s) => rotatePipe(s, index));
  };

  const cellLabel = (index: number): string => {
    if (index === state.source) return "水源";
    if (index === state.drain) return "排水口";
    return "パイプ";
  };

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
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
              className={flowing ? "juice-pulse" : undefined}
              onClick={() => onTile(i)}
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
              {isSource && (
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden style={{ position: "absolute", top: 1, left: 2 }}>
                  <path d="M12 2.8C12 2.8 5 11 5 15.4A7 7 0 0 0 19 15.4C19 11 12 2.8 12 2.8Z" fill="#2196f3" stroke="#0d47a1" strokeWidth="1" />
                </svg>
              )}
              {isDrain && <span style={{ position: "absolute", top: 1, right: 3, fontSize: 12, color: "#263238" }}>●</span>}
            </button>
          );
        })}
      </div>
  );

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "16px 12px 40px" }}>
      <p style={{ margin: "0 0 8px" }}>
        <Link href={`${prefix}/games`} style={{ color: "#38bdf8", fontSize: 14 }}>
          ← ゲーム一覧へ
        </Link>
      </p>
      <h1 style={{ fontSize: 22, margin: "0 0 6px" }}>パイプつなぎ</h1>
      <p style={{ margin: "0 0 12px", color: "#64748b", fontSize: 14, lineHeight: 1.6 }}>
        タイルをタップすると90度回転します。左端の水源（青い雫）から右端の排水口（黒い穴）までつなげてください。
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

{webglFailed ? board2d : (
        <div style={{ width: "min(92vw, 440px)", margin: "0 auto" }}>
          <PipeScene3D
            state={state}
            flow={[...flow]}
            onTile={onTile}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      {won && (
        <div style={{ marginTop: 14 }}>
          <EndScreen
            outcome="win"
            title="つながりました！"
            score={seconds}
            scoreLabel="クリアタイム（秒）"
            newBest={winNewBest}
            previousBest={winPrevBest}
            onRetry={restart}
          >
            <p className="muted" style={{ margin: 0 }}>
              {state.moves}手・{seconds}秒でクリアです。
            </p>
          </EndScreen>
        </div>
      )}
    </div>
  );
}
