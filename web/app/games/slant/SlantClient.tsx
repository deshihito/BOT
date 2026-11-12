"use client";
// スラント（ごきげんななめ）。ロジックは lib/slant.ts（解先行生成・ルール検証で完成判定）。
// マスをタップすると 未定→/→\→未定 と切り替わる。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createSlantGame,
  cycleSlantCell,
  slantViolations,
  type SlantState,
} from "@/lib/slant";
import { sfxPlace, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const MARGIN = 30;
const CELL = 56;

function newGame(): SlantState {
  return createSlantGame(Date.now() % 2147483647);
}

export default function SlantClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<SlantState>(() => newGame());
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [resultNewBest, setResultNewBest] = useState(false);
  const [resultPrevBest, setResultPrevBest] = useState<number | null>(null);
  const prevStatusRef = useRef(state.status);

  // 終局遷移の瞬間だけジングルを鳴らし、その時点（保存前）のベストで更新判定を控える。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev === state.status || state.status !== "won") return;
    const isNew = seconds > 0 && (best === null || seconds < best);
    setResultNewBest(isNew);
    setResultPrevBest(isNew ? null : best);
    sfxWin();
  }, [state.status, seconds, best]);

  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem("ago-slant-best"));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  useEffect(() => {
    if (state.status !== "won" || seconds <= 0) return;
    if (best !== null && seconds >= best) return;
    setBest(seconds);
    try {
      window.localStorage.setItem("ago-slant-best", String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best]);

  const restart = () => {
    setState(newGame());
    setSeconds(0);
    setResultNewBest(false);
    setResultPrevBest(null);
  };

  const handleCell = (i: number) => {
    const next = cycleSlantCell(state, i);
    if (next !== state && next.status !== "won") {
      if (next.board[i] === 0) sfxTap();
      else sfxPlace();
    }
    setState(next);
  };

  const violations = useMemo(() => slantViolations(state), [state]);
  const badCells = useMemo(() => {
    const set = new Set<number>();
    for (const v of violations) for (const c of v.cells) set.add(c);
    return set;
  }, [violations]);
  const badPoints = useMemo(() => {
    const set = new Set<number>();
    for (const v of violations) for (const p of v.points) set.add(p);
    return set;
  }, [violations]);

  const filled = state.board.filter((v) => v !== 0).length;
  const statusText =
    state.status === "won"
      ? "完成！クリアです。"
      : violations.length > 0
        ? violations[0].message
        : "点の数字は、その点につながる斜線の数。斜線で輪を作らないようにしよう。";

  const { width, height } = state;
  const viewSize = MARGIN * 2 + CELL * width;
  const px = (pc: number) => MARGIN + pc * CELL;
  const py = (pr: number) => MARGIN + pr * CELL;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>スラント</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>スラント</h1>
        <p className="muted">
          マスをタップすると 未定→ / → \ →未定 と切り替わります。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {filled} / {width * height} マス ・ {seconds} 秒
        {best !== null ? ` ・ ベスト ${best} 秒` : ""} ・ {statusText}
      </p>

      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <svg
          viewBox={`0 0 ${viewSize} ${viewSize}`}
          role="group"
          aria-label="スラントの盤"
          style={{ width: "100%", height: "auto", display: "block", touchAction: "manipulation" }}
        >
          {/* 格子の線 */}
          {Array.from({ length: height + 1 }, (_, pr) => (
            <line
              key={`h${pr}`}
              x1={px(0)}
              y1={py(pr)}
              x2={px(width)}
              y2={py(pr)}
              stroke="var(--line)"
              strokeWidth={1}
            />
          ))}
          {Array.from({ length: width + 1 }, (_, pc) => (
            <line
              key={`v${pc}`}
              x1={px(pc)}
              y1={py(0)}
              x2={px(pc)}
              y2={py(height)}
              stroke="var(--line)"
              strokeWidth={1}
            />
          ))}

          {/* マス（クリック領域と違反ハイライト） */}
          {state.board.map((mark, i) => {
            const r = Math.floor(i / width);
            const c = i % width;
            return (
              <rect
                key={`cell${i}`}
                x={px(c)}
                y={py(r)}
                width={CELL}
                height={CELL}
                fill={badCells.has(i) ? "rgba(217, 72, 55, 0.16)" : "transparent"}
                style={{ cursor: state.status === "won" ? "default" : "pointer" }}
                role="button"
                aria-label={`${r + 1}行${c + 1}列 ${mark === 0 ? "未定" : mark === 1 ? "右上がり" : "右下がり"}`}
                onClick={() => handleCell(i)}
              />
            );
          })}

          {/* 斜線 */}
          {state.board.map((mark, i) => {
            if (mark === 0) return null;
            const r = Math.floor(i / width);
            const c = i % width;
            const x1 = px(c);
            const y1 = mark === 1 ? py(r + 1) : py(r);
            const x2 = px(c + 1);
            const y2 = mark === 1 ? py(r) : py(r + 1);
            return (
              <line
                key={`line${i}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="var(--accent)"
                strokeWidth={3.5}
                strokeLinecap="round"
                pointerEvents="none"
              />
            );
          })}

          {/* 格子点の数字 */}
          {state.clues.map((clue, p) => {
            if (clue === null) return null;
            const pr = Math.floor(p / (width + 1));
            const pc = p % (width + 1);
            const bad = badPoints.has(p);
            return (
              <g key={`pt${p}`} pointerEvents="none">
                <circle
                  cx={px(pc)}
                  cy={py(pr)}
                  r={12}
                  fill={bad ? "#f7e3e0" : "#fff"}
                  stroke={bad ? "#d94837" : "var(--line)"}
                  strokeWidth={bad ? 2 : 1}
                />
                <text
                  x={px(pc)}
                  y={py(pr)}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={14}
                  fontWeight={700}
                  fill={bad ? "#d94837" : "var(--text)"}
                >
                  {clue}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {state.status === "won" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen
            outcome="win"
            title="完成！"
            score={seconds}
            scoreLabel="クリアタイム（秒）"
            newBest={resultNewBest}
            previousBest={resultPrevBest}
            onRetry={restart}
          >
            <p className="muted">すべての点の数字がそろい、輪もできませんでした。</p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
