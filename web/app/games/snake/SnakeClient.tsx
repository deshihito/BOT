"use client";
// スネーク。ロジックは lib/snake.ts（純粋関数）。
// canvas 描画、矢印/WASD＋画面ボタン＋スワイプ操作、ポーズ、ベストスコア保存。
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const touchRef = useRef<{ x: number; y: number } | null>(null);
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
            ? "スタートを押すか、方向キーで開始できます。"
            : `食べた数 ${state.foodsEaten} ・ 速度 Lv.${snakeSpeedLevel(state) + 1}`;

  const btn: React.CSSProperties = {
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.06)",
    color: "inherit",
    cursor: "pointer",
    fontWeight: 700,
    minWidth: 52,
    minHeight: 48,
    touchAction: "manipulation",
  };
  const activeBtn: React.CSSProperties = { ...btn, background: "#3fb56a", color: "#07130c", borderColor: "#3fb56a" };

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
        スコア {state.score} ・ ベスト {best} ・ {statusText}
      </p>

      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <canvas
          ref={canvasRef}
          style={{ width: "100%", aspectRatio: "1 / 1", display: "block", borderRadius: 12, background: "#14231a", touchAction: "none" }}
          aria-label="スネークの盤"
          onTouchStart={(e) => {
            const t = e.touches[0];
            touchRef.current = { x: t.clientX, y: t.clientY };
          }}
          onTouchEnd={(e) => {
            const start = touchRef.current;
            touchRef.current = null;
            if (!start) return;
            const t = e.changedTouches[0];
            const dx = t.clientX - start.x;
            const dy = t.clientY - start.y;
            if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return;
            move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");
          }}
        />
      </div>

      {(state.status === "gameover" || state.status === "won") && (
        <p className="classic-status" role="alert">
          {state.status === "won" ? "🎉 クリア！" : "💥 ゲームオーバー"} スコア {state.score}（ベスト {best}）
        </p>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 14 }}>
        {state.status === "ready" || state.status === "paused" ? (
          <button type="button" style={activeBtn} onClick={() => setState((s) => startSnake(s))}>
            {state.status === "paused" ? "再開" : "スタート"}
          </button>
        ) : (
          <button type="button" style={btn} onClick={() => setState((s) => pauseSnake(s))}>
            ポーズ
          </button>
        )}
        <button type="button" style={btn} onClick={restart}>
          もう一度
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 56px)",
          gridTemplateRows: "repeat(2, 52px)",
          gap: 6,
          justifyContent: "center",
          marginTop: 14,
        }}
        role="group"
        aria-label="方向ボタン"
      >
        <span />
        <button type="button" style={btn} aria-label="上へ" onClick={() => move("up")}>↑</button>
        <span />
        <button type="button" style={btn} aria-label="左へ" onClick={() => move("left")}>←</button>
        <button type="button" style={btn} aria-label="下へ" onClick={() => move("down")}>↓</button>
        <button type="button" style={btn} aria-label="右へ" onClick={() => move("right")}>→</button>
      </div>
      <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
        矢印キー / WASD / スワイプ / ボタンで操作。スペースでポーズ・再開。
      </p>
    </>
  );
}
