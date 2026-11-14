"use client";
// レーザーミラー。ロジックは lib/laser.ts（解の光路を先に作るため必ず解ける）。
// 鏡をタップすると / と \ が切り替わる。光路は毎回 traceLaser で描き直す。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const LaserScene3D = dynamic(() => import("./LaserScene3D"), { ssr: false });
import { sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import {
  createLaserPuzzle,
  rotateLaserMirror,
  traceLaser,
  type LaserState,
} from "@/lib/laser";
import { useGamesNav } from "../GamesShell";

const CELL = 92;
const GUTTER = 40;
const BEST_KEY = "ago-laser-best";

const DIR_VECTOR: Record<string, { dx: number; dy: number }> = {
  N: { dx: 0, dy: -1 },
  E: { dx: 1, dy: 0 },
  S: { dx: 0, dy: 1 },
  W: { dx: -1, dy: 0 },
};

export default function LaserClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [state, setState] = useState<LaserState>(() => createLaserPuzzle(Date.now() % 2147483647));
  const [seconds, setSeconds] = useState(0);
  const [started, setStarted] = useState(false);
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
    if (!started || state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [started, state.status]);

  const prevStatusRef = useRef(state.status);
  const [winPrevBest, setWinPrevBest] = useState<number | null>(null);
  const [winNewBest, setWinNewBest] = useState(false);

  // 終局遷移の捕捉はベスト保存 effect より前に置き、保存前のベストを記録する。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev !== "solved" && state.status === "solved") {
      setWinPrevBest(best);
      setWinNewBest(best === null || seconds < best);
      sfxWin();
    }
  }, [state.status, best, seconds]);

  useEffect(() => {
    if (state.status !== "solved" || seconds <= 0) return;
    setBest((prev) => {
      if (prev !== null && prev <= seconds) return prev;
      try {
        window.localStorage.setItem(BEST_KEY, String(seconds));
      } catch {
        // 保存失敗はプレイに影響しない。
      }
      return seconds;
    });
  }, [state.status, seconds]);

  const trace = useMemo(() => traceLaser(state), [state]);
  const mirrorAt = useMemo(() => new Map(state.mirrors.map((m) => [m.index, m.kind])), [state]);

  const restart = () => {
    setState(createLaserPuzzle(Date.now() % 2147483647));
    setSeconds(0);
    setStarted(false);
    setWinPrevBest(null);
    setWinNewBest(false);
  };

  const onMirror = (index: number) => {
    if (state.status === "playing") sfxTap();
    setStarted(true);
    setState((s) => rotateLaserMirror(s, index));
  };

  const size = state.cols * CELL;
  const center = (index: number) => ({
    x: (index % state.cols) * CELL + CELL / 2,
    y: Math.floor(index / state.cols) * CELL + CELL / 2,
  });

  const beamPoints: { x: number; y: number }[] = [{ x: 0, y: state.emitterRow * CELL + CELL / 2 }];
  for (const idx of trace.cells) beamPoints.push(center(idx));
  if (!trace.hitTarget && !trace.looped && trace.cells.length > 0) {
    const last = center(trace.cells[trace.cells.length - 1]);
    const v = DIR_VECTOR[trace.endDir];
    beamPoints.push({ x: last.x + v.dx * (CELL / 2), y: last.y + v.dy * (CELL / 2) });
  }
  const beamPath = beamPoints.map((p) => `${p.x},${p.y}`).join(" ");

  const statusText =
    state.status === "solved"
      ? `的に当たった！ ${seconds} 秒・${state.moves} 回転でクリアです。`
      : trace.looped
        ? "光が輪になってしまいました。どこかの鏡を回してみよう。"
        : "鏡をタップすると向きが切り替わります。光を的まで導こう。";

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <svg
          viewBox={`${-GUTTER} 0 ${size + GUTTER} ${size}`}
          style={{ width: "100%", height: "auto", display: "block" }}
          role="img"
          aria-label="レーザーミラーの盤面"
        >
          {/* セル背景 */}
          {Array.from({ length: state.rows * state.cols }, (_, i) => {
            const x = (i % state.cols) * CELL;
            const y = Math.floor(i / state.cols) * CELL;
            const isTarget = i === state.target;
            return (
              <rect
                key={i}
                x={x + 1}
                y={y + 1}
                width={CELL - 2}
                height={CELL - 2}
                rx={10}
                fill={isTarget ? "#fef3c7" : "#f7f3e8"}
                stroke="#e3dcc4"
              />
            );
          })}
          {/* 発射口 */}
          <polygon
            points={`${-GUTTER + 4},${state.emitterRow * CELL + CELL / 2 - 16} -6,${state.emitterRow * CELL + CELL / 2} ${-GUTTER + 4},${state.emitterRow * CELL + CELL / 2 + 16}`}
            fill="#4b4237"
          />
          {/* 光路 */}
          <polyline
            points={beamPath}
            fill="none"
            stroke="rgba(239,68,68,0.3)"
            strokeWidth={11}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <polyline
            points={beamPath}
            fill="none"
            stroke="#ef4444"
            strokeWidth={4}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* 的（同心円で描く。絵文字は使わない） */}
          <g className="juice-pulse" aria-hidden>
            <circle cx={center(state.target).x} cy={center(state.target).y} r={17} fill="#e53935" />
            <circle cx={center(state.target).x} cy={center(state.target).y} r={11} fill="#ffffff" />
            <circle cx={center(state.target).x} cy={center(state.target).y} r={5.2} fill="#e53935" />
          </g>
          {/* 鏡（タップで回転） */}
          {state.mirrors.map((m) => {
            const x = (m.index % state.cols) * CELL;
            const y = Math.floor(m.index / state.cols) * CELL;
            const pad = 16;
            const line =
              m.kind === "/"
                ? { x1: x + pad, y1: y + CELL - pad, x2: x + CELL - pad, y2: y + pad }
                : { x1: x + pad, y1: y + pad, x2: x + CELL - pad, y2: y + CELL - pad };
            return (
              <g
                key={m.index}
                onClick={() => onMirror(m.index)}
                style={{ cursor: state.status === "playing" ? "pointer" : "default" }}
                role="button"
                aria-label={`鏡（${m.kind === "/" ? "右上がり" : "右下がり"}）を回転`}
              >
                <rect x={x} y={y} width={CELL} height={CELL} fill="transparent" />
                <line {...line} stroke="#2563eb" strokeWidth={9} strokeLinecap="round" />
                <line {...line} stroke="#bfdbfe" strokeWidth={3} strokeLinecap="round" />
              </g>
            );
          })}
          {/* 通過セルの目印（鏡・的以外） */}
          {trace.cells
            .filter((i) => !mirrorAt.has(i) && i !== state.target)
            .map((i) => (
              <circle key={`dot-${i}`} cx={center(i).x} cy={center(i).y} r={4} fill="#ef4444" opacity={0.5} />
            ))}
        </svg>
      </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>レーザーミラー</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>レーザーミラー</h1>
        <p className="muted">鏡を回して光を反射させ、的まで導くパズル。</p>
      </div>

      <div className="classic-controls">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {seconds} 秒 ・ 回転 {state.moves} 回{best !== null ? ` ・ ベスト ${best} 秒` : ""} ・ {statusText}
      </p>

{webglFailed ? board2d : (
        <div style={{ width: "min(92vw, 460px)", margin: "0 auto" }}>
          <LaserScene3D
            state={state}
            trace={trace}
            onMirror={onMirror}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}
      {state.status === "solved" && (
        <div style={{ maxWidth: 560, margin: "14px auto 0" }}>
          <EndScreen
            outcome="win"
            title="的に当たった！"
            score={seconds}
            scoreLabel="クリアタイム（秒）"
            newBest={winNewBest}
            previousBest={winPrevBest}
            onRetry={restart}
          >
            <p className="muted" style={{ margin: 0 }}>
              {seconds} 秒・{state.moves} 回転でクリアです。
            </p>
          </EndScreen>
        </div>
      )}
      <p className="og-muted" style={{ textAlign: "center" }}>
        鏡に当たると光は直角に曲がります。
      </p>
    </>
  );
}
