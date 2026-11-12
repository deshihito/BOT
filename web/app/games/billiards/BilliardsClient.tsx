"use client";
// ビリヤード（簡易プール）。ロジックと物理は lib/billiards.ts。
// 角度の規約: 0度が右、90度が下（画面座標 y 下向き）。
// ベスト記録: localStorage `ago-billiards-best` にクリア時の最少スコア
// （打数＋スクラッチ）を保存する。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  BL_BALL_COLORS,
  BL_BALL_RADIUS,
  BL_HEIGHT,
  BL_POCKETS,
  BL_POCKET_RADIUS,
  BL_WIDTH,
  billiardsScore,
  createBilliardsGame,
  remainingBalls,
  shoot,
  type BilliardsState,
  type BlBall,
} from "@/lib/billiards";
import { sfxCorrect, sfxSlide, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-billiards-best";

function loadBest(): number | null {
  try {
    const v = Number(localStorage.getItem(BEST_KEY));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  } catch {
    return null;
  }
}

export default function BilliardsClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<BilliardsState>(() =>
    createBilliardsGame(Date.now() % 2147483647),
  );
  const [angle, setAngle] = useState(0);
  const [power, setPower] = useState(45);
  const [displayBalls, setDisplayBalls] = useState<BlBall[]>(() => state.balls);
  const [rolling, setRolling] = useState(false);
  const [best, setBest] = useState<number | null>(null);
  const [prevBest, setPrevBest] = useState<number | null>(null);
  const [isNewBest, setIsNewBest] = useState(false);
  const animRef = useRef<number | null>(null);
  const savedRef = useRef<number | null>(null);
  const shotSfxRef = useRef<string | null>(null);

  const cue = state.balls.find((b) => b.id === 0) ?? state.balls[0];
  const shownCue = displayBalls.find((b) => b.id === 0) ?? cue;
  const score = billiardsScore(state);
  const remaining = remainingBalls(state);

  useEffect(() => {
    setBest(loadBest());
  }, []);

  useEffect(() => {
    setDisplayBalls(state.balls);
    // 次の狙いの初期値は、一番近い的球の方向にする。
    if (state.phase === "aiming") {
      const c = state.balls.find((b) => b.id === 0);
      const targets = state.balls.filter((b) => b.id > 0 && !b.pocketed);
      if (c && targets.length > 0) {
        let nearest = targets[0];
        let nd = Number.POSITIVE_INFINITY;
        for (const t of targets) {
          const d = Math.hypot(t.x - c.x, t.y - c.y);
          if (d < nd) {
            nd = d;
            nearest = t;
          }
        }
        setAngle(Math.round((Math.atan2(nearest.y - c.y, nearest.x - c.x) * 180) / Math.PI));
      }
    }
  }, [state]);

  useEffect(() => {
    if (state.phase !== "cleared") return;
    if (savedRef.current === state.seed) return;
    savedRef.current = state.seed;
    const cur = loadBest();
    setPrevBest(cur);
    if (cur === null || score < cur) {
      setIsNewBest(cur !== null);
      setBest(score);
      try {
        localStorage.setItem(BEST_KEY, String(score));
      } catch {
        // 保存失敗はプレイに影響しない。
      }
    } else {
      setIsNewBest(false);
    }
  }, [state.phase, state.seed, score]);

  useEffect(() => {
    if (state.shots === 0) return;
    const key = `${state.seed}:${state.shots}`;
    if (shotSfxRef.current === key) return;
    shotSfxRef.current = key;
    if (state.phase === "cleared") sfxWin();
    else if (state.lastScratch) sfxWrong();
    else if (state.lastPocketed.length > 0) sfxCorrect();
  }, [state.seed, state.shots, state.phase, state.lastScratch, state.lastPocketed]);

  useEffect(
    () => () => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    },
    [],
  );

  const restart = () => {
    if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    sfxTap();
    setRolling(false);
    setIsNewBest(false);
    setPrevBest(null);
    setState(createBilliardsGame(Date.now() % 2147483647));
  };

  const doShoot = () => {
    if (state.phase !== "aiming" || rolling) return;
    sfxSlide();
    const { state: next, result } = shoot(state, angle, power);
    if (result.frames.length <= 1) {
      setState(next);
      return;
    }
    setRolling(true);
    const frames = result.frames;
    const started = performance.now();
    const perFrame = 16;
    const tick = (now: number) => {
      const idx = Math.min(frames.length - 1, Math.floor((now - started) / perFrame));
      setDisplayBalls(frames[Math.max(0, idx)]);
      if (idx < frames.length - 1) {
        animRef.current = requestAnimationFrame(tick);
      } else {
        setDisplayBalls(next.balls);
        setState(next);
        setRolling(false);
      }
    };
    animRef.current = requestAnimationFrame(tick);
  };

  const rad = (angle * Math.PI) / 180;
  const guideEnd = {
    x: shownCue.x + Math.cos(rad) * (40 + power * 2.4),
    y: shownCue.y + Math.sin(rad) * (40 + power * 2.4),
  };

  const statusText =
    state.phase === "cleared"
      ? `全部の的球を落としました！ スコア ${score}（${state.shots} 打＋スクラッチ ${state.scratches}）でした。`
      : rolling
        ? "ボールが転がっています…"
        : state.lastScratch
          ? `手球が落ちてスクラッチ。前回は ${state.lastPocketed.length} 個落としました。`
          : state.lastPocketed.length > 0
            ? `前回 ${state.lastPocketed.length} 個落としました。残り ${remaining} 個です。`
            : "的球を全部落とせばクリアです。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ビリヤード</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ビリヤード</h1>
        <p className="muted">
          下のスライダーで角度と強さを決めて、「打つ」ボタンで手球を打ちます。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p
        className={`classic-status${state.lastScratch ? " juice-shake" : state.lastPocketed.length > 0 ? " juice-pulse" : ""}`}
        role="status"
      >
        スコア {score}（{state.shots} 打・スクラッチ {state.scratches}） ・ 残り {remaining} 個
        {best !== null ? ` ・ ベスト ${best}` : ""} ・ {statusText}
      </p>

      {state.phase === "cleared" && (
        <EndScreen
          outcome="win"
          title="全部の的球を落としました！"
          score={score}
          scoreLabel="スコア"
          newBest={isNewBest}
          previousBest={isNewBest ? null : prevBest}
          onRetry={restart}
        >
          <p className="muted" style={{ margin: 0 }}>
            {state.shots} 打 ・ スクラッチ {state.scratches}
          </p>
        </EndScreen>
      )}

      <svg
        viewBox={`0 0 ${BL_WIDTH} ${BL_HEIGHT}`}
        role="img"
        aria-label="ビリヤードのテーブル"
        style={{
          width: "100%",
          maxWidth: BL_WIDTH,
          height: "auto",
          background: "#7a4a21",
          borderRadius: 12,
          display: "block",
        }}
      >
        <rect x={14} y={14} width={BL_WIDTH - 28} height={BL_HEIGHT - 28} fill="#1d7a43" rx={18} />
        {BL_POCKETS.map((p, i) => (
          <circle key={`pocket-${i}`} cx={p.x} cy={p.y} r={BL_POCKET_RADIUS} fill="#101418" stroke="#5f3c1f" strokeWidth={2} />
        ))}
        {state.phase === "aiming" && !rolling && (
          <line
            x1={shownCue.x}
            y1={shownCue.y}
            x2={guideEnd.x}
            y2={guideEnd.y}
            stroke="#ffffff"
            strokeWidth={2}
            strokeDasharray="6 5"
            opacity={0.85}
            aria-hidden="true"
          />
        )}
        {displayBalls
          .filter((b) => !b.pocketed)
          .map((b) => (
            <g key={b.id}>
              <circle
                cx={b.x}
                cy={b.y}
                r={BL_BALL_RADIUS}
                fill={b.id === 0 ? "#ffffff" : BL_BALL_COLORS[b.id]}
                stroke="#222"
                strokeWidth={1}
              />
              {b.id > 0 && (
                <text
                  x={b.x}
                  y={b.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={11}
                  fontWeight={700}
                  fill={b.id === 1 ? "#333" : "#fff"}
                  aria-hidden="true"
                >
                  {b.id}
                </text>
              )}
            </g>
          ))}
      </svg>

      <div
        style={{
          display: "grid",
          gap: 10,
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          margin: "12px 0",
          maxWidth: BL_WIDTH,
        }}
      >
        <label style={{ display: "block" }}>
          角度 {angle}°
          <input
            type="range"
            min={-180}
            max={180}
            value={angle}
            disabled={state.phase !== "aiming" || rolling}
            onChange={(e) => setAngle(Number(e.target.value))}
            style={{ width: "100%", minHeight: 40 }}
            aria-label="角度"
          />
        </label>
        <label style={{ display: "block" }}>
          強さ {power}
          <input
            type="range"
            min={0}
            max={100}
            value={power}
            disabled={state.phase !== "aiming" || rolling}
            onChange={(e) => setPower(Number(e.target.value))}
            style={{ width: "100%", minHeight: 40 }}
            aria-label="強さ"
          />
        </label>
      </div>

      <div className="classic-controls" role="group" aria-label="打つ">
        <button
          type="button"
          className="classic-btn classic-btn-active"
          onClick={doShoot}
          disabled={state.phase !== "aiming" || rolling}
          style={{ minWidth: 140, minHeight: 48, fontSize: 17, fontWeight: 700 }}
        >
          打つ
        </button>
      </div>
    </>
  );
}
