"use client";
// エアホッケー。ロジックは lib/airhockey.ts（決定的な固定ステップシミュレーション）。
// 自分のパドルはポインタ位置へ追従する。描画は SVG で、パックとパドルの位置は
// 毎フレーム ref 経由で直接更新し、スコア等の変化だけを React state に同期する。
// ベストの設計: localStorage の ago-airhockey-best に「勝利回数」を保存する。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AIR_FIELD_H,
  AIR_FIELD_W,
  AIR_GOAL_W,
  AIR_PADDLE_R,
  AIR_PUCK_R,
  AIR_WIN_SCORE,
  createAirHockeyGame,
  stepAirHockey,
  type AirDifficulty,
  type AirHockeyState,
} from "@/lib/airhockey";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-airhockey-best";
const STEP_MS = 1000 / 60;

const DIFFS: { key: AirDifficulty; label: string }[] = [
  { key: "easy", label: "かんたん" },
  { key: "normal", label: "ふつう" },
  { key: "hard", label: "むずかしい" },
];

type Phase = "ready" | "playing" | "paused";

export default function AirHockeyClient() {
  const { prefix } = useGamesNav();
  const stateRef = useRef<AirHockeyState>(createAirHockeyGame(1, "normal"));
  const targetRef = useRef<{ x: number; y: number } | null>(null);
  const phaseRef = useRef<Phase>("ready");
  const countedRef = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const puckRef = useRef<SVGCircleElement | null>(null);
  const playerRef = useRef<SVGCircleElement | null>(null);
  const cpuRef = useRef<SVGCircleElement | null>(null);

  const [phase, setPhaseState] = useState<Phase>("ready");
  const [difficulty, setDifficulty] = useState<AirDifficulty>("normal");
  const [display, setDisplay] = useState({ player: 0, cpu: 0, finished: false, winner: null as "player" | "cpu" | null });
  const [wins, setWins] = useState(0);

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setWins(Number.isFinite(saved) && saved > 0 ? Math.floor(saved) : 0);
    } catch {
      setWins(0);
    }
  }, []);

  const newGame = useCallback(
    (diff: AirDifficulty) => {
      const seed = Date.now() % 2147483647;
      stateRef.current = createAirHockeyGame(seed, diff);
      countedRef.current = null;
      targetRef.current = null;
      setDisplay({ player: 0, cpu: 0, finished: false, winner: null });
      setPhase("ready");
    },
    [setPhase],
  );

  // ゲームループ: 固定ステップで進め、描画は DOM を直接更新する。
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      acc += Math.min(250, now - last);
      last = now;
      if (phaseRef.current === "playing") {
        let steps = 0;
        while (acc >= STEP_MS && steps < 6) {
          stateRef.current = stepAirHockey(stateRef.current, targetRef.current);
          acc -= STEP_MS;
          steps++;
          if (stateRef.current.status === "finished") break;
        }
        if (steps === 6) acc = 0;
      } else {
        acc = 0;
      }
      const s = stateRef.current;
      if (puckRef.current) {
        puckRef.current.setAttribute("cx", String(s.puck.x));
        puckRef.current.setAttribute("cy", String(s.puck.y));
      }
      if (playerRef.current) {
        playerRef.current.setAttribute("cx", String(s.player.x));
        playerRef.current.setAttribute("cy", String(s.player.y));
      }
      if (cpuRef.current) {
        cpuRef.current.setAttribute("cx", String(s.cpu.x));
        cpuRef.current.setAttribute("cy", String(s.cpu.y));
      }
      setDisplay((prev) => {
        if (
          prev.player === s.playerScore &&
          prev.cpu === s.cpuScore &&
          prev.finished === (s.status === "finished") &&
          prev.winner === s.winner
        ) {
          return prev;
        }
        return {
          player: s.playerScore,
          cpu: s.cpuScore,
          finished: s.status === "finished",
          winner: s.winner,
        };
      });
      if (s.status === "finished" && s.winner === "player" && countedRef.current !== s.seed) {
        countedRef.current = s.seed;
        setWins((w) => {
          const next = w + 1;
          try {
            window.localStorage.setItem(BEST_KEY, String(next));
          } catch {
            // 保存失敗はプレイに影響しない。
          }
          return next;
        });
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onPointer = (clientX: number, clientY: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    targetRef.current = {
      x: ((clientX - rect.left) / rect.width) * AIR_FIELD_W,
      y: ((clientY - rect.top) / rect.height) * AIR_FIELD_H,
    };
  };

  const finished = display.finished;
  const statusText = finished
    ? display.winner === "player"
      ? "🎉 あなたの勝ち！"
      : "CPUの勝ち…"
    : phase === "ready"
      ? `先に ${AIR_WIN_SCORE} 点で勝ち。スタートを押して開始。`
      : phase === "paused"
        ? "一時停止中です。"
        : "対戦中";

  const btn: React.CSSProperties = {
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid var(--line, rgba(255,255,255,0.18))",
    background: "rgba(127,127,127,0.12)",
    color: "inherit",
    cursor: "pointer",
    fontWeight: 700,
    minHeight: 44,
    touchAction: "manipulation",
  };
  const activeBtn: React.CSSProperties = { ...btn, background: "#38bdf8", color: "#082f49", borderColor: "#38bdf8" };

  const goalX = (AIR_FIELD_W - AIR_GOAL_W) / 2;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>エアホッケー</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>エアホッケー</h1>
        <p className="muted">下のパドルをマウスや指で動かして、飛んでくるパックを打ち返します。</p>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }} role="group" aria-label="難易度">
        {DIFFS.map((d) => (
          <button
            key={d.key}
            type="button"
            style={difficulty === d.key ? activeBtn : btn}
            aria-pressed={difficulty === d.key}
            onClick={() => {
              setDifficulty(d.key);
              newGame(d.key);
            }}
          >
            {d.label}
          </button>
        ))}
      </div>

      <p className="classic-status" role="status">
        あなた {display.player} - {display.cpu} CPU ・ {statusText}
        {wins > 0 ? ` ・ 通算勝利 ${wins} 回` : ""}
      </p>

      <div
        ref={wrapRef}
        style={{ maxWidth: 400, margin: "0 auto", touchAction: "none" }}
        onPointerMove={(e) => onPointer(e.clientX, e.clientY)}
        onPointerDown={(e) => {
          onPointer(e.clientX, e.clientY);
          if (phase === "ready") setPhase("playing");
        }}
      >
        <svg
          viewBox={`0 0 ${AIR_FIELD_W} ${AIR_FIELD_H}`}
          style={{ width: "100%", display: "block", borderRadius: 12, background: "#0b2036" }}
          role="img"
          aria-label="エアホッケーのフィールド"
        >
          {/* ゴール口 */}
          <rect x={goalX} y={0} width={AIR_GOAL_W} height={8} fill="#f87171" />
          <rect x={goalX} y={AIR_FIELD_H - 8} width={AIR_GOAL_W} height={8} fill="#4ade80" />
          {/* センターラインとサークル */}
          <line x1={0} y1={AIR_FIELD_H / 2} x2={AIR_FIELD_W} y2={AIR_FIELD_H / 2} stroke="rgba(255,255,255,0.3)" strokeWidth={2} strokeDasharray="10 8" />
          <circle cx={AIR_FIELD_W / 2} cy={AIR_FIELD_H / 2} r={56} fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={2} />
          {/* パドルとパック */}
          <circle ref={cpuRef} cx={AIR_FIELD_W / 2} cy={92} r={AIR_PADDLE_R} fill="#e85d4a" stroke="#fff" strokeWidth={2} />
          <circle ref={playerRef} cx={AIR_FIELD_W / 2} cy={AIR_FIELD_H - 92} r={AIR_PADDLE_R} fill="#38bdf8" stroke="#fff" strokeWidth={2} />
          <circle ref={puckRef} cx={AIR_FIELD_W / 2} cy={AIR_FIELD_H / 2} r={AIR_PUCK_R} fill="#ffd34d" stroke="#92600a" strokeWidth={2} />
        </svg>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 14 }}>
        {!finished && phase !== "playing" ? (
          <button type="button" style={activeBtn} onClick={() => setPhase("playing")}>
            {phase === "paused" ? "再開" : "スタート"}
          </button>
        ) : !finished ? (
          <button type="button" style={btn} onClick={() => setPhase("paused")}>
            ポーズ
          </button>
        ) : null}
        <button
          type="button"
          style={btn}
          onClick={() => newGame(difficulty)}
        >
          もう一度
        </button>
      </div>
      <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
        パドルを速く動かして打つと、速いシュートになります。
      </p>
    </>
  );
}
