"use client";
// カーリング（CPU 対戦・全2エンド）。ロジックと物理は lib/curling.ts。
// ベスト記録: localStorage `ago-curling-best` に通算勝利数を保存する
// （勝つたびに +1。設計はこのコメントに明示）。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  CU_BACK_Y,
  CU_BUTTON,
  CU_HEIGHT,
  CU_HOG_Y,
  CU_HOUSE_RADII,
  CU_STONES_PER_END,
  CU_STONE_RADIUS,
  CU_THROW_Y,
  CU_WIDTH,
  cpuThrow,
  createCurlingGame,
  nextEnd,
  playerThrow,
  type CuStone,
  type CurlingState,
} from "@/lib/curling";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-curling-best";

function loadWins(): number {
  try {
    const v = Number(localStorage.getItem(BEST_KEY));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  } catch {
    return 0;
  }
}

/** そのエンドで side がすでに投げた数。 */
function thrownBy(state: CurlingState, side: "player" | "cpu"): number {
  const first = state.end % 2 === 1 ? "player" : "cpu";
  let n = 0;
  for (let i = 0; i < state.throwIndex; i++) {
    const thrower = i % 2 === 0 ? first : first === "player" ? "cpu" : "player";
    if (thrower === side) n++;
  }
  return n;
}

export default function CurlingClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<CurlingState>(() =>
    createCurlingGame(Date.now() % 2147483647),
  );
  const [power, setPower] = useState(78);
  const [curl, setCurl] = useState(0);
  const [displayStones, setDisplayStones] = useState<CuStone[]>(() => state.stones);
  const [rolling, setRolling] = useState(false);
  const [wins, setWins] = useState(0);
  const animRef = useRef<number | null>(null);
  const cpuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cpuKeyRef = useRef<string>("");
  const savedRef = useRef<number | null>(null);

  useEffect(() => {
    setWins(loadWins());
  }, []);

  useEffect(() => {
    setDisplayStones(state.stones);
  }, [state]);

  useEffect(() => {
    if (state.phase !== "finished" || state.winner !== "player") return;
    if (savedRef.current === state.seed) return;
    savedRef.current = state.seed;
    const next = loadWins() + 1;
    setWins(next);
    try {
      localStorage.setItem(BEST_KEY, String(next));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.phase, state.winner, state.seed]);

  useEffect(
    () => () => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
      if (cpuTimerRef.current !== null) clearTimeout(cpuTimerRef.current);
    },
    [],
  );

  const animateThrow = (next: CurlingState, frames: CuStone[][]) => {
    if (frames.length <= 1) {
      setState(next);
      return;
    }
    setRolling(true);
    const started = performance.now();
    const perFrame = 16;
    const tick = (now: number) => {
      const idx = Math.min(frames.length - 1, Math.floor((now - started) / perFrame));
      setDisplayStones(frames[Math.max(0, idx)]);
      if (idx < frames.length - 1) {
        animRef.current = requestAnimationFrame(tick);
      } else {
        setDisplayStones(next.stones);
        setState(next);
        setRolling(false);
      }
    };
    animRef.current = requestAnimationFrame(tick);
  };

  // CPU の手番になったら少し間を置いて自動で投げる。
  useEffect(() => {
    if (state.phase !== "aiming" || state.turn !== "cpu" || rolling) return;
    const key = `${state.seed}:${state.end}:${state.throwIndex}`;
    if (cpuKeyRef.current === key) return;
    cpuKeyRef.current = key;
    cpuTimerRef.current = setTimeout(() => {
      const { state: next, result } = cpuThrow(state);
      animateThrow(next, result.frames);
    }, 750);
    return () => {
      if (cpuTimerRef.current !== null) clearTimeout(cpuTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, rolling]);

  const restart = () => {
    if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    if (cpuTimerRef.current !== null) clearTimeout(cpuTimerRef.current);
    cpuKeyRef.current = "";
    setRolling(false);
    setState(createCurlingGame(Date.now() % 2147483647));
  };

  const doThrow = () => {
    if (state.phase !== "aiming" || state.turn !== "player" || rolling) return;
    const { state: next, result } = playerThrow(state, power, curl);
    animateThrow(next, result.frames);
  };

  const playerLeft = CU_STONES_PER_END - thrownBy(state, "player");
  const cpuLeft = CU_STONES_PER_END - thrownBy(state, "cpu");

  const statusText =
    state.phase === "finished"
      ? state.winner === "player"
        ? `あなたの勝ち！ 最終スコア ${state.scores.player} - ${state.scores.cpu} でした。`
        : state.winner === "cpu"
          ? `CPUの勝ち。最終スコア ${state.scores.player} - ${state.scores.cpu} でした。`
          : `引き分け。最終スコア ${state.scores.player} - ${state.scores.cpu} でした。`
      : state.phase === "endScored"
        ? `エンド ${state.end} は あなた ${state.lastEnd?.player ?? 0} - ${state.lastEnd?.cpu ?? 0} CPU でした。`
        : rolling
          ? "ストーンが滑っています…"
          : state.turn === "player"
            ? `エンド ${state.end} / 2 ・ あなたの投げです（残り ${playerLeft} 投）。`
            : `エンド ${state.end} / 2 ・ CPUの投げです（残り ${cpuLeft} 投）。`;

  const houseColors = ["#2456c8", "#f4f4f4", "#d43a2f"];

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>カーリング</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>カーリング</h1>
        <p className="muted">
          下のスライダーで強さとカールを決めて、「投げる」ボタンで投げます。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        {state.phase === "endScored" && (
          <button
            type="button"
            className="classic-btn classic-btn-active"
            onClick={() => setState((s) => nextEnd(s))}
          >
            {state.end >= 2 ? "結果を見る" : "次のエンドへ"}
          </button>
        )}
      </div>

      <p className="classic-status" role="status">
        スコア あなた {state.scores.player} - {state.scores.cpu} CPU
        {wins > 0 ? ` ・ 通算 ${wins} 勝` : ""} ・ {statusText}
      </p>

      <svg
        viewBox={`0 0 ${CU_WIDTH} ${CU_HEIGHT}`}
        role="img"
        aria-label="カーリングのシート"
        style={{
          width: "100%",
          maxWidth: 340,
          height: "auto",
          background: "#dceef7",
          borderRadius: 10,
          display: "block",
        }}
      >
        {/* ハウス */}
        {CU_HOUSE_RADII.map((r, i) => (
          <circle key={`house-${r}`} cx={CU_BUTTON.x} cy={CU_BUTTON.y} r={r} fill={houseColors[i]} />
        ))}
        <circle cx={CU_BUTTON.x} cy={CU_BUTTON.y} r={8} fill="#f4f4f4" />
        {/* ライン類 */}
        <line x1={0} y1={CU_BUTTON.y} x2={CU_WIDTH} y2={CU_BUTTON.y} stroke="#9db8c6" strokeWidth={2} aria-hidden="true" />
        <line x1={0} y1={CU_BACK_Y} x2={CU_WIDTH} y2={CU_BACK_Y} stroke="#9db8c6" strokeWidth={2} strokeDasharray="5 5" aria-hidden="true" />
        <line x1={0} y1={CU_HOG_Y} x2={CU_WIDTH} y2={CU_HOG_Y} stroke="#7d99a8" strokeWidth={2} strokeDasharray="5 5" aria-hidden="true" />
        <text x={6} y={CU_HOG_Y - 6} fontSize={11} fill="#56707e" aria-hidden="true">
          ホッグライン
        </text>
        {/* 投げる位置の目安 */}
        <circle cx={CU_BUTTON.x} cy={CU_THROW_Y} r={5} fill="#56707e" opacity={0.5} aria-hidden="true" />
        {/* ストーン */}
        {displayStones.map((s) => (
          <g key={s.id}>
            <circle
              cx={s.x}
              cy={s.y}
              r={CU_STONE_RADIUS}
              fill={s.side === "player" ? "#d43a2f" : "#f6c90e"}
              stroke="#333"
              strokeWidth={1.5}
            />
            <circle cx={s.x} cy={s.y} r={5.5} fill="#e8e8e8" stroke="#666" strokeWidth={1} />
          </g>
        ))}
        {/* これから投げるストーン（自分の手番で待機中） */}
        {state.phase === "aiming" && state.turn === "player" && !rolling && (
          <g opacity={0.85}>
            <circle cx={CU_BUTTON.x} cy={CU_THROW_Y} r={CU_STONE_RADIUS} fill="#d43a2f" stroke="#333" strokeWidth={1.5} />
            <circle cx={CU_BUTTON.x} cy={CU_THROW_Y} r={5.5} fill="#e8e8e8" stroke="#666" strokeWidth={1} />
          </g>
        )}
      </svg>

      <div
        style={{
          display: "grid",
          gap: 10,
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          margin: "12px 0",
          maxWidth: 680,
        }}
      >
        <label style={{ display: "block" }}>
          強さ {power}（ハウス付近の目安は 75〜82）
          <input
            type="range"
            min={0}
            max={100}
            value={power}
            disabled={state.phase !== "aiming" || state.turn !== "player" || rolling}
            onChange={(e) => setPower(Number(e.target.value))}
            style={{ width: "100%", minHeight: 40 }}
            aria-label="強さ"
          />
        </label>
        <label style={{ display: "block" }}>
          カール {curl > 0 ? `右へ ${curl}` : curl < 0 ? `左へ ${-curl}` : "0"}
          <input
            type="range"
            min={-100}
            max={100}
            value={curl}
            disabled={state.phase !== "aiming" || state.turn !== "player" || rolling}
            onChange={(e) => setCurl(Number(e.target.value))}
            style={{ width: "100%", minHeight: 40 }}
            aria-label="カール"
          />
        </label>
      </div>

      <div className="classic-controls" role="group" aria-label="投げる">
        <button
          type="button"
          className="classic-btn classic-btn-active"
          onClick={doThrow}
          disabled={state.phase !== "aiming" || state.turn !== "player" || rolling}
          style={{ minWidth: 140, minHeight: 48, fontSize: 17, fontWeight: 700 }}
        >
          投げる
        </button>
      </div>

      <table
        aria-label="エンドごとのスコア"
        style={{ borderCollapse: "collapse", marginTop: 12, maxWidth: "100%", fontSize: 14 }}
      >
        <thead>
          <tr>
            <th style={{ border: "1px solid var(--line, #ccc)", padding: "4px 8px" }}>エンド</th>
            <th style={{ border: "1px solid var(--line, #ccc)", padding: "4px 8px" }}>1</th>
            <th style={{ border: "1px solid var(--line, #ccc)", padding: "4px 8px" }}>2</th>
            <th style={{ border: "1px solid var(--line, #ccc)", padding: "4px 8px" }}>合計</th>
          </tr>
        </thead>
        <tbody>
          {(
            [
              ["あなた", "player"],
              ["CPU", "cpu"],
            ] as const
          ).map(([label, side]) => (
            <tr key={side}>
              <th style={{ border: "1px solid var(--line, #ccc)", padding: "4px 8px" }}>{label}</th>
              {[0, 1].map((i) => (
                <td key={i} style={{ border: "1px solid var(--line, #ccc)", padding: "4px 8px", textAlign: "center" }}>
                  {state.endScores[i] ? state.endScores[i][side] : "–"}
                </td>
              ))}
              <td style={{ border: "1px solid var(--line, #ccc)", padding: "4px 8px", textAlign: "center" }}>
                {state.scores[side]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
