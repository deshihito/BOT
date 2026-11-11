"use client";
// ダーツ（カウントアップ）。ロジックは lib/darts.ts。
// 円形ボードを SVG で描き、クリック位置へ投げる。ブレはクライアント側で
// クリック点へ小さな乱数を加える方式（ON/OFF 即時切替、lib は jitter 無効で生成）。
import Link from "next/link";
import { useEffect, useState } from "react";
import { DART_SECTORS, createDartsGame, roundScores, throwDart, type DartsState } from "@/lib/darts";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-darts-best";
const TOTAL_ROUNDS = 8;

function polar(r: number, degFromTop: number): { x: number; y: number } {
  const rad = (degFromTop * Math.PI) / 180;
  return { x: r * Math.sin(rad), y: -r * Math.cos(rad) };
}

function wedgePath(rOuter: number, rInner: number, a0: number, a1: number): string {
  const p0 = polar(rOuter, a0);
  const p1 = polar(rOuter, a1);
  if (rInner <= 0) {
    return `M 0 0 L ${p0.x} ${p0.y} A ${rOuter} ${rOuter} 0 0 1 ${p1.x} ${p1.y} Z`;
  }
  const p2 = polar(rInner, a1);
  const p3 = polar(rInner, a0);
  return `M ${p0.x} ${p0.y} A ${rOuter} ${rOuter} 0 0 1 ${p1.x} ${p1.y} L ${p2.x} ${p2.y} A ${rInner} ${rInner} 0 0 0 ${p3.x} ${p3.y} Z`;
}

function Board({ state, onThrow }: { state: DartsState; onThrow: (x: number, y: number) => void }) {
  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (state.status !== "playing") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 240 - 120;
    const py = ((e.clientY - rect.top) / rect.height) * 240 - 120;
    onThrow(px / 100, -py / 100);
  };
  const darts = state.rounds.flat();
  return (
    <svg
      viewBox="-120 -120 240 240"
      role="img"
      aria-label="ダーツボード"
      onClick={handleClick}
      style={{ width: "min(88vw, 420px)", height: "auto", display: "block", margin: "0 auto", cursor: state.status === "playing" ? "crosshair" : "default", touchAction: "manipulation" }}
    >
      <circle cx={0} cy={0} r={118} fill="#22252a" />
      {DART_SECTORS.map((num, i) => {
        const a0 = i * 18 - 9;
        const a1 = i * 18 + 9;
        const color = i % 2 === 0 ? "#c0392b" : "#1e8449";
        const base = i % 2 === 0 ? "#1b1b1b" : "#e8dcc0";
        const labelPos = polar(110, i * 18);
        return (
          <g key={num}>
            <path d={wedgePath(100, 0, a0, a1)} fill={color} />
            <path d={wedgePath(94, 0, a0, a1)} fill={base} />
            <path d={wedgePath(58, 53, a0, a1)} fill={color} />
            <text x={labelPos.x} y={labelPos.y} fill="#f5f5f5" fontSize={11} fontWeight={700} textAnchor="middle" dominantBaseline="middle">
              {num}
            </text>
          </g>
        );
      })}
      <circle cx={0} cy={0} r={16} fill="#1e8449" />
      <circle cx={0} cy={0} r={7} fill="#c0392b" />
      {darts.map((d, i) => (
        <g key={i}>
          <circle cx={d.x * 100} cy={-d.y * 100} r={3.2} fill="#ffd54a" stroke="#5d4037" strokeWidth={1} />
        </g>
      ))}
    </svg>
  );
}

export default function DartsClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<DartsState>(() => createDartsGame(Date.now() % 2147483647, TOTAL_ROUNDS, false));
  const [jitterOn, setJitterOn] = useState(true);
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      if (Number.isFinite(saved) && saved > 0) setBest(saved);
    } catch {
      /* 保存できない環境では表示なし */
    }
  }, []);

  useEffect(() => {
    if (state.status !== "finished") return;
    if (best !== null && state.totalScore <= best) return;
    setBest(state.totalScore);
    try {
      window.localStorage.setItem(BEST_KEY, String(state.totalScore));
    } catch {
      /* プレイに影響しない */
    }
  }, [state.status, state.totalScore, best]);

  const onThrow = (x: number, y: number) => {
    let tx = x;
    let ty = y;
    if (jitterOn) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * 0.05;
      tx += Math.cos(angle) * dist;
      ty += Math.sin(angle) * dist;
    }
    setState((s) => throwDart(s, tx, ty));
  };

  const restart = () => setState(createDartsGame(Date.now() % 2147483647, TOTAL_ROUNDS, false));
  const scores = roundScores(state);
  const thrown = state.rounds.flat().length;
  const currentRoundNum = Math.min(TOTAL_ROUNDS, Math.floor(thrown / 3) + 1);
  const last = state.rounds.flat()[thrown - 1];

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ダーツ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ダーツ</h1>
        <p className="muted">ボードをタップ（クリック）した位置に投げます。手ブレONのときは着弾点が少しずれます。</p>
      </div>

      <div className="classic-controls">
        <button
          type="button"
          className={jitterOn ? "classic-btn classic-btn-active" : "classic-btn"}
          aria-pressed={jitterOn}
          onClick={() => setJitterOn((v) => !v)}
        >
          手ブレ {jitterOn ? "ON" : "OFF"}
        </button>
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        ラウンド {currentRoundNum} / {TOTAL_ROUNDS} ・ 合計 {state.totalScore} 点
        {best !== null ? ` ・ ベスト ${best} 点` : ""}
        {last ? ` ・ 直前: ${last.label}（${last.score}点）` : ""}
        {state.status === "finished" ? " ・ 終了！" : ""}
      </p>

      <Board state={state} onThrow={onThrow} />

      <div style={{ maxWidth: 420, margin: "12px auto 0", display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center" }} aria-label="ラウンド別スコア">
        {scores.map((s, i) => (
          <span key={i} style={{ padding: "4px 10px", borderRadius: 999, border: "1px solid #d8d8d8", fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
            R{i + 1}: {s}
          </span>
        ))}
      </div>
    </>
  );
}
