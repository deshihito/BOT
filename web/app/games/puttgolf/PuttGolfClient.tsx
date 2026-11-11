"use client";
// パットゴルフ（9ホール）。ロジックとコース生成は lib/puttgolf.ts。
// 角度の規約: 0度が右、90度が下（画面座標 y 下向き）、-90度が上。
// ベスト記録: localStorage `ago-puttgolf-best` に9ホールの最少総打数を保存する。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  PG_CUP_RADIUS,
  PG_HEIGHT,
  PG_WIDTH,
  createPuttGame,
  nextHole,
  powerForDistance,
  scoreDiffLabel,
  shoot,
  totalPar,
  type PgPoint,
  type PuttState,
} from "@/lib/puttgolf";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-puttgolf-best";

function angleTo(from: PgPoint, to: PgPoint): number {
  return Math.round((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI);
}

function loadBest(): number | null {
  try {
    const v = Number(localStorage.getItem(BEST_KEY));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  } catch {
    return null;
  }
}

export default function PuttGolfClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<PuttState>(() => createPuttGame(Date.now() % 2147483647));
  const [angle, setAngle] = useState(() => {
    const g = createPuttGame(1);
    return angleTo(g.holes[0].tee, g.holes[0].cup);
  });
  const [power, setPower] = useState(40);
  const [ballPos, setBallPos] = useState<PgPoint>(() => state.ball);
  const [rolling, setRolling] = useState(false);
  const [best, setBest] = useState<number | null>(null);
  const animRef = useRef<number | null>(null);
  const savedRef = useRef<number | null>(null);

  const hole = state.holes[state.holeIndex];

  useEffect(() => {
    setBest(loadBest());
  }, []);

  useEffect(() => {
    setBallPos(state.ball);
    if (state.phase === "playing") {
      const h = state.holes[state.holeIndex];
      setAngle(angleTo(state.ball, h.cup));
      setPower(Math.max(5, Math.round(powerForDistance(Math.hypot(h.cup.x - state.ball.x, h.cup.y - state.ball.y)))));
    }
  }, [state]);

  useEffect(() => {
    if (state.phase !== "finished") return;
    if (savedRef.current === state.seed) return;
    savedRef.current = state.seed;
    const cur = loadBest();
    if (cur === null || state.totalStrokes < cur) {
      setBest(state.totalStrokes);
      try {
        localStorage.setItem(BEST_KEY, String(state.totalStrokes));
      } catch {
        // 保存失敗はプレイに影響しない。
      }
    }
  }, [state.phase, state.seed, state.totalStrokes]);

  useEffect(
    () => () => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    },
    [],
  );

  const restart = () => {
    if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    setRolling(false);
    setState(createPuttGame(Date.now() % 2147483647));
  };

  const doShoot = () => {
    if (state.phase !== "playing" || rolling) return;
    const { state: next, result } = shoot(state, angle, power);
    setRolling(true);
    const pts = result.points;
    const started = performance.now();
    const perPoint = 26;
    const tick = (now: number) => {
      const idx = Math.min(pts.length - 1, Math.floor((now - started) / perPoint));
      setBallPos(pts[Math.max(0, idx)]);
      if (idx < pts.length - 1) {
        animRef.current = requestAnimationFrame(tick);
      } else {
        setBallPos(result.end);
        setState(next);
        setRolling(false);
      }
    };
    animRef.current = requestAnimationFrame(tick);
  };

  const aimAtCup = () => {
    setAngle(angleTo(ballPos, hole.cup));
    setPower(
      Math.max(5, Math.round(powerForDistance(Math.hypot(hole.cup.x - ballPos.x, hole.cup.y - ballPos.y)))),
    );
  };

  const playedHoles = state.holeIndex + (state.phase === "playing" ? 0 : 1);
  const parSoFar = state.holes.slice(0, playedHoles).reduce((s, h) => s + h.par, 0);
  const strokesSoFar = state.strokes.slice(0, playedHoles).reduce((s, v) => s + v, 0);
  const rad = (angle * Math.PI) / 180;
  const guideEnd = {
    x: ballPos.x + Math.cos(rad) * (30 + power * 2.2),
    y: ballPos.y + Math.sin(rad) * (30 + power * 2.2),
  };

  const statusText =
    state.phase === "finished"
      ? `全ホール終了！ 合計 ${state.totalStrokes} 打（パー ${totalPar(state)}、${scoreDiffLabel(state.totalStrokes - totalPar(state))}）でした。`
      : state.phase === "holed"
        ? `ホール ${state.holeIndex + 1} を ${state.strokes[state.holeIndex]} 打でカップイン！`
        : rolling
          ? "ボールが転がっています…"
          : `ホール ${state.holeIndex + 1} / 9（パー ${hole.par}）・ このホール ${state.strokes[state.holeIndex]} 打`;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>パットゴルフ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>パットゴルフ</h1>
        <p className="muted">
          角度と強さは下のスライダーで調整し、「打つ」ボタンで打ちます。矢印のマスは傾斜で、ボールが矢印の向きに流されます。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        <button type="button" className="classic-btn" onClick={aimAtCup} disabled={state.phase !== "playing" || rolling}>
          カップを狙う
        </button>
        {state.phase === "holed" && (
          <button type="button" className="classic-btn classic-btn-active" onClick={() => setState((s) => nextHole(s))}>
            次のホールへ
          </button>
        )}
      </div>

      <p className="classic-status" role="status">
        {statusText}
        {best !== null ? ` ・ ベスト ${best} 打` : ""}
        {playedHoles > 0 && state.phase !== "finished"
          ? ` ・ ここまで ${strokesSoFar} 打（パー ${parSoFar}、${scoreDiffLabel(strokesSoFar - parSoFar)}）`
          : ""}
      </p>

      <svg
        viewBox={`0 0 ${PG_WIDTH} ${PG_HEIGHT}`}
        role="img"
        aria-label={`ホール ${state.holeIndex + 1} のコース`}
        style={{
          width: "100%",
          maxWidth: PG_WIDTH,
          height: "auto",
          background: "#3e8e4f",
          borderRadius: 10,
          display: "block",
        }}
      >
        {hole.slopes.map((s, i) => (
          <g key={`slope-${i}`}>
            <rect x={s.x} y={s.y} width={s.w} height={s.h} fill="#57a463" stroke="#2f6b3a" strokeWidth={1} />
            <text
              x={s.x + s.w / 2}
              y={s.y + s.h / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={26}
              fill="#eaf5ec"
              aria-hidden="true"
            >
              {s.dx === 1 ? "→" : s.dx === -1 ? "←" : s.dy === 1 ? "↓" : "↑"}
            </text>
          </g>
        ))}
        {hole.walls.map((w, i) => (
          <rect key={`wall-${i}`} x={w.x} y={w.y} width={w.w} height={w.h} fill="#8a5a33" stroke="#5f3c1f" strokeWidth={2} rx={3} />
        ))}
        <circle cx={hole.tee.x} cy={hole.tee.y} r={5} fill="#ffffff" opacity={0.6} aria-hidden="true" />
        <circle cx={hole.cup.x} cy={hole.cup.y} r={PG_CUP_RADIUS} fill="#17351d" stroke="#ffffff" strokeWidth={2} />
        {state.phase === "playing" && !rolling && (
          <line
            x1={ballPos.x}
            y1={ballPos.y}
            x2={guideEnd.x}
            y2={guideEnd.y}
            stroke="#ffffff"
            strokeWidth={2}
            strokeDasharray="6 5"
            opacity={0.85}
            aria-hidden="true"
          />
        )}
        <circle cx={ballPos.x} cy={ballPos.y} r={7} fill="#ffffff" stroke="#999" strokeWidth={1} />
      </svg>

      <div
        style={{
          display: "grid",
          gap: 10,
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          margin: "12px 0",
          maxWidth: PG_WIDTH,
        }}
      >
        <label style={{ display: "block" }}>
          角度 {angle}°
          <input
            type="range"
            min={-180}
            max={180}
            value={angle}
            disabled={state.phase !== "playing" || rolling}
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
            disabled={state.phase !== "playing" || rolling}
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
          disabled={state.phase !== "playing" || rolling}
          style={{ minWidth: 140, minHeight: 48, fontSize: 17, fontWeight: 700 }}
        >
          打つ
        </button>
      </div>

      <table
        aria-label="スコアカード"
        style={{ borderCollapse: "collapse", marginTop: 12, maxWidth: "100%", fontSize: 14 }}
      >
        <thead>
          <tr>
            <th style={{ border: "1px solid var(--line, #ccc)", padding: "4px 8px" }}>ホール</th>
            {state.holes.map((h) => (
              <th key={h.index} style={{ border: "1px solid var(--line, #ccc)", padding: "4px 8px" }}>
                {h.index + 1}
              </th>
            ))}
            <th style={{ border: "1px solid var(--line, #ccc)", padding: "4px 8px" }}>合計</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th style={{ border: "1px solid var(--line, #ccc)", padding: "4px 8px" }}>パー</th>
            {state.holes.map((h) => (
              <td key={h.index} style={{ border: "1px solid var(--line, #ccc)", padding: "4px 8px", textAlign: "center" }}>
                {h.par}
              </td>
            ))}
            <td style={{ border: "1px solid var(--line, #ccc)", padding: "4px 8px", textAlign: "center" }}>{totalPar(state)}</td>
          </tr>
          <tr>
            <th style={{ border: "1px solid var(--line, #ccc)", padding: "4px 8px" }}>打数</th>
            {state.holes.map((h, i) => (
              <td
                key={h.index}
                style={{
                  border: "1px solid var(--line, #ccc)",
                  padding: "4px 8px",
                  textAlign: "center",
                  fontWeight: i === state.holeIndex && state.phase !== "finished" ? 700 : 400,
                }}
              >
                {state.strokes[i] > 0 ? state.strokes[i] : "–"}
              </td>
            ))}
            <td style={{ border: "1px solid var(--line, #ccc)", padding: "4px 8px", textAlign: "center" }}>{state.totalStrokes}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
