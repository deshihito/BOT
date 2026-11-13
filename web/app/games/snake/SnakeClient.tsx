"use client";
// スネーク。ロジックは lib/snake.ts（純粋関数）。
// canvas 描画、盤面スワイプで方向転換・タップで開始/ポーズ（ボタンなし）。矢印/WASDも可。ベストスコア保存。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSnakeGame,
  pauseSnake,
  setSnakeDirection,
  snakeIntervalMs,
  snakeSpeedLevel,
  startSnake,
  tickSnake,
  type SnakeDir,
  type SnakeState,
} from "@/lib/snake";
import { sfxLose, sfxPop, sfxWin } from "@/lib/sfx";
import { useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-snake-best";

const KEY_DIRS: Record<string, SnakeDir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
  W: "up",
  S: "down",
  A: "left",
  D: "right",
};

function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export default function SnakeClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<SnakeState>(() => createSnakeGame(20, 20, Date.now() % 2147483647));
  const [best, setBest] = useState(0);
  const [prevBest, setPrevBest] = useState<number | null>(null);
  const prevFoodsRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mountedRef = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    mountedRef.current = true;
    setBest(loadBest());
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (state.status === "gameover" || state.status === "won") {
      setPrevBest(best);
      if (state.status === "won") sfxWin();
      else sfxLose();
      if (state.score > best) {
        setBest(state.score);
        try {
          localStorage.setItem(BEST_KEY, String(state.score));
        } catch {
          /* 保存できなくても遊べる */
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  // 餌を食べた瞬間だけ音を鳴らす（ループ内では鳴らさない）
  useEffect(() => {
    if (state.foodsEaten > prevFoodsRef.current && state.status === "playing") sfxPop();
    prevFoodsRef.current = state.foodsEaten;
  }, [state.foodsEaten, state.status]);

  // ゲームループ
  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => {
      if (!mountedRef.current) return;
      setState((s) => tickSnake(s));
    }, snakeIntervalMs(state));
    return () => clearInterval(id);
  }, [state.status, state.foodsEaten]);

  // canvas 描画
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const s = stateRef.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssSize = Math.min(canvas.clientWidth || 400, 480);
      const px = Math.round(cssSize * dpr);
      if (canvas.width !== px || canvas.height !== px) {
        canvas.width = px;
        canvas.height = px;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const cell = px / s.cols;
      ctx.fillStyle = "#14231a";
      ctx.fillRect(0, 0, px, px);
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.lineWidth = 1;
      for (let i = 1; i < s.cols; i++) {
        ctx.beginPath();
        ctx.moveTo(i * cell, 0);
        ctx.lineTo(i * cell, px);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * cell);
        ctx.lineTo(px, i * cell);
        ctx.stroke();
      }
      if (s.food) {
        ctx.fillStyle = "#e85d4a";
        ctx.beginPath();
        ctx.arc(s.food.x * cell + cell / 2, s.food.y * cell + cell / 2, cell * 0.38, 0, Math.PI * 2);
        ctx.fill();
      }
      s.snake.forEach((p, i) => {
        ctx.fillStyle = i === 0 ? "#7ee787" : "#3fb56a";
        const pad = i === 0 ? 1 : 2;
        ctx.beginPath();
        ctx.roundRect(p.x * cell + pad, p.y * cell + pad, cell - pad * 2, cell - pad * 2, 4 * dpr);
        ctx.fill();
        if (i === 0) {
          ctx.fillStyle = "#14231a";
          ctx.beginPath();
          ctx.arc(p.x * cell + cell * 0.36, p.y * cell + cell * 0.4, cell * 0.07, 0, Math.PI * 2);
          ctx.arc(p.x * cell + cell * 0.64, p.y * cell + cell * 0.4, cell * 0.07, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    };
    draw();
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [state]);

  const move = useCallback((dir: SnakeDir) => {
    setState((s) => {
      const started = s.status === "ready" ? startSnake(s) : s;
      return setSnakeDirection(started, dir);
    });
  }, []);

  // 盤面ジェスチャ: スワイプ=方向転換（ready なら開始も兼ねる）、タップ=開始/ポーズ/再開。
  const boardGesture = useGesture({
    onSwipe: (dir) => move(dir),
    onTap: () => setState((s) => (s.status === "playing" ? pauseSnake(s) : startSnake(s))),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setState((s) => (s.status === "ready" || s.status === "paused" ? startSnake(s) : pauseSnake(s)));
        return;
      }
      if (e.key.toLowerCase() === "p") {
        setState((s) => pauseSnake(s));
        return;
      }
      const dir = KEY_DIRS[e.key];
      if (!dir) return;
      e.preventDefault();
      move(dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);

  const restart = () => setState(createSnakeGame(20, 20, Date.now() % 2147483647));

  const statusText =
    state.status === "won"
      ? "盤面制覇！クリアです。"
      : state.status === "gameover"
        ? `ゲームオーバー。スコア ${state.score} でした。`
        : state.status === "paused"
          ? "一時停止中です。"
          : state.status === "ready"
            ? "盤面をタップかスワイプ、または方向キーで開始できます。"
            : `食べた数 ${state.foodsEaten} ・ 速度 Lv.${snakeSpeedLevel(state) + 1}`;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>スネーク</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>スネーク</h1>
        <p className="muted">餌を食べて長くなる定番ゲーム。壁と自分にぶつからないよう操作しよう。食べるほど速くなります。</p>
      </div>

      <p className="classic-status" role="status">
        スコア <span key={state.score} className="juice-pulse" style={{ display: "inline-block" }}>{state.score}</span> ・ ベスト {best} ・ {statusText}
      </p>

      <div style={{ maxWidth: 480, margin: "0 auto" }} className={state.status === "gameover" ? "juice-shake" : undefined}>
        <canvas
          ref={canvasRef}
          style={{ width: "100%", aspectRatio: "1 / 1", display: "block", borderRadius: 12, background: "#14231a", touchAction: "none" }}
          aria-label="スネークの盤（スワイプで方向転換、タップで開始・ポーズ）"
          {...boardGesture}
        />
      </div>

      {(state.status === "gameover" || state.status === "won") && (
        <div style={{ maxWidth: 480, margin: "14px auto 0" }}>
          <EndScreen
            outcome={state.status === "won" ? "win" : "lose"}
            title={state.status === "won" ? "クリア！" : "ゲームオーバー"}
            score={state.score}
            newBest={prevBest !== null && state.score > prevBest}
            previousBest={prevBest}
            onRetry={restart}
          >
            <p className="muted" style={{ margin: 0 }}>
              食べた数 {state.foodsEaten} ・ 速度 Lv.{snakeSpeedLevel(state) + 1}
            </p>
          </EndScreen>
        </div>
      )}

      <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
        盤面をスワイプで方向転換、タップで開始・ポーズ。再挑戦は結果画面から。矢印キー / WASD も使えます。
      </p>
    </>
  );
}
