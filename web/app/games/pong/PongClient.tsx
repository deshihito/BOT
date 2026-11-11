"use client";
// ピンポン（Pong）。canvas で vs CPU。自分のパドルはマウス/タッチ/キー、
// CPU は追従 AI。先に7点で勝利、難易度3段階。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useGamesNav } from "../GamesShell";

const FIELD_W = 800;
const FIELD_H = 480;
const PADDLE_W = 12;
const PADDLE_H = 84;
const BALL_R = 8;
const WIN_SCORE = 7;

type Phase = "ready" | "playing" | "paused" | "finished";
type Difficulty = "easy" | "normal" | "hard";

const DIFFS: { key: Difficulty; label: string; cpuSpeed: number; cpuError: number; ballSpeed: number }[] = [
  { key: "easy", label: "かんたん", cpuSpeed: 260, cpuError: 46, ballSpeed: 340 },
  { key: "normal", label: "ふつう", cpuSpeed: 360, cpuError: 24, ballSpeed: 400 },
  { key: "hard", label: "むずかしい", cpuSpeed: 500, cpuError: 8, ballSpeed: 470 },
];

export default function PongClient() {
  const { prefix } = useGamesNav();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  const mountedRef = useRef(true);
  const keysRef = useRef<{ up: boolean; down: boolean }>({ up: false, down: false });

  const playerRef = useRef({ y: FIELD_H / 2 });
  const cpuRef = useRef({ y: FIELD_H / 2 });
  const ballRef = useRef({ x: FIELD_W / 2, y: FIELD_H / 2, vx: 400, vy: 160 });
  const scoresRef = useRef({ player: 0, cpu: 0 });
  const phaseRef = useRef<Phase>("ready");
  const diffRef = useRef<(typeof DIFFS)[number]>(DIFFS[1]);
  const serveTimerRef = useRef(0);

  const [phase, setPhaseState] = useState<Phase>("ready");
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [scores, setScores] = useState({ player: 0, cpu: 0 });

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    if (mountedRef.current) setPhaseState(p);
  }, []);

  const serve = useCallback((towardPlayer: boolean) => {
    const diff = diffRef.current;
    const angle = (Math.random() * 0.7 - 0.35); // -0.35〜0.35 rad
    const speed = diff.ballSpeed;
    ballRef.current = {
      x: FIELD_W / 2,
      y: FIELD_H / 2,
      vx: (towardPlayer ? -1 : 1) * Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
    };
    serveTimerRef.current = 0.6;
  }, []);

  const resetGame = useCallback(() => {
    scoresRef.current = { player: 0, cpu: 0 };
    if (mountedRef.current) setScores({ player: 0, cpu: 0 });
    playerRef.current.y = FIELD_H / 2;
    cpuRef.current.y = FIELD_H / 2;
    serve(Math.random() < 0.5);
    setPhase("ready");
  }, [serve, setPhase]);

  useEffect(() => {
    mountedRef.current = true;
    serve(false);
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    diffRef.current = DIFFS.find((d) => d.key === difficulty) ?? DIFFS[1];
  }, [difficulty]);

  useEffect(() => {
    let last = performance.now();
    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const diff = diffRef.current;

      if (phaseRef.current === "playing") {
        // プレイヤー（キー）
        const pSpeed = 460;
        if (keysRef.current.up) playerRef.current.y -= pSpeed * dt;
        if (keysRef.current.down) playerRef.current.y += pSpeed * dt;
        playerRef.current.y = Math.max(PADDLE_H / 2, Math.min(FIELD_H - PADDLE_H / 2, playerRef.current.y));

        // CPU 追従 AI（ボールが向かってくる時だけ本気で追う＋誤差）
        const ball = ballRef.current;
        if (serveTimerRef.current > 0) {
          serveTimerRef.current -= dt;
        } else {
          const target = ball.vx > 0 ? ball.y : FIELD_H / 2 + Math.sin(now / 900) * 30;
          const err = Math.sin(ball.x * 0.021 + now / 1400) * diff.cpuError;
          const dy = target + err - cpuRef.current.y;
          const maxMove = diff.cpuSpeed * dt;
          cpuRef.current.y += Math.max(-maxMove, Math.min(maxMove, dy));
          cpuRef.current.y = Math.max(PADDLE_H / 2, Math.min(FIELD_H - PADDLE_H / 2, cpuRef.current.y));

          // ボール
          const steps = Math.max(1, Math.ceil((Math.hypot(ball.vx, ball.vy) * dt) / 6));
          const sdt = dt / steps;
          for (let s = 0; s < steps; s++) {
            ball.x += ball.vx * sdt;
            ball.y += ball.vy * sdt;
            if (ball.y - BALL_R < 0) { ball.y = BALL_R; ball.vy = Math.abs(ball.vy); }
            if (ball.y + BALL_R > FIELD_H) { ball.y = FIELD_H - BALL_R; ball.vy = -Math.abs(ball.vy); }

            // 左パドル（プレイヤー、x = 18）
            if (
              ball.vx < 0 &&
              ball.x - BALL_R <= 18 + PADDLE_W &&
              ball.x - BALL_R >= 18 - 4 &&
              Math.abs(ball.y - playerRef.current.y) <= PADDLE_H / 2 + BALL_R
            ) {
              const rel = Math.max(-1, Math.min(1, (ball.y - playerRef.current.y) / (PADDLE_H / 2)));
              const speed = Math.min(760, Math.hypot(ball.vx, ball.vy) * 1.04);
              const ang = rel * (Math.PI / 3.2);
              ball.vx = Math.cos(ang) * speed;
              ball.vy = Math.sin(ang) * speed;
              ball.x = 18 + PADDLE_W + BALL_R;
            }
            // 右パドル（CPU、x = FIELD_W - 18 - PADDLE_W）
            const cpuX = FIELD_W - 18 - PADDLE_W;
            if (
              ball.vx > 0 &&
              ball.x + BALL_R >= cpuX &&
              ball.x + BALL_R <= cpuX + PADDLE_W + 4 &&
              Math.abs(ball.y - cpuRef.current.y) <= PADDLE_H / 2 + BALL_R
            ) {
              const rel = Math.max(-1, Math.min(1, (ball.y - cpuRef.current.y) / (PADDLE_H / 2)));
              const speed = Math.min(760, Math.hypot(ball.vx, ball.vy) * 1.04);
              const ang = rel * (Math.PI / 3.2);
              ball.vx = -Math.cos(ang) * speed;
              ball.vy = Math.sin(ang) * speed;
              ball.x = cpuX - BALL_R;
            }

            if (ball.x < -20) {
              scoresRef.current = { ...scoresRef.current, cpu: scoresRef.current.cpu + 1 };
              if (mountedRef.current) setScores({ ...scoresRef.current });
              if (scoresRef.current.cpu >= WIN_SCORE || scoresRef.current.player >= WIN_SCORE) setPhase("finished");
              else serve(false);
              break;
            }
            if (ball.x > FIELD_W + 20) {
              scoresRef.current = { ...scoresRef.current, player: scoresRef.current.player + 1 };
              if (mountedRef.current) setScores({ ...scoresRef.current });
              if (scoresRef.current.cpu >= WIN_SCORE || scoresRef.current.player >= WIN_SCORE) setPhase("finished");
              else serve(true);
              break;
            }
          }
        }
      }

      // 描画
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssW = canvas.clientWidth || FIELD_W;
      const scale = cssW / FIELD_W;
      const pxW = Math.round(cssW * dpr);
      const pxH = Math.round(cssW * (FIELD_H / FIELD_W) * dpr);
      if (canvas.width !== pxW || canvas.height !== pxH) { canvas.width = pxW; canvas.height = pxH; }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
      ctx.fillStyle = "#0d1520";
      ctx.fillRect(0, 0, FIELD_W, FIELD_H);
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.setLineDash([8, 10]);
      ctx.beginPath();
      ctx.moveTo(FIELD_W / 2, 0);
      ctx.lineTo(FIELD_W / 2, FIELD_H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = "bold 44px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(scoresRef.current.player), FIELD_W / 2 - 56, 58);
      ctx.fillText(String(scoresRef.current.cpu), FIELD_W / 2 + 56, 58);
      // パドル
      ctx.fillStyle = "#7ee787";
      ctx.beginPath();
      ctx.roundRect(18, playerRef.current.y - PADDLE_H / 2, PADDLE_W, PADDLE_H, 6);
      ctx.fill();
      ctx.fillStyle = "#e85d4a";
      ctx.beginPath();
      ctx.roundRect(FIELD_W - 18 - PADDLE_W, cpuRef.current.y - PADDLE_H / 2, PADDLE_W, PADDLE_H, 6);
      ctx.fill();
      // ボール
      ctx.fillStyle = "#ffd34d";
      ctx.beginPath();
      ctx.arc(ballRef.current.x, ballRef.current.y, BALL_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.font = "13px sans-serif";
      ctx.fillText("あなた", 52, FIELD_H - 12);
      ctx.fillText("CPU", FIELD_W - 52, FIELD_H - 12);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [serve, setPhase]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key.toLowerCase() === "w") { keysRef.current.up = true; e.preventDefault(); }
      if (e.key === "ArrowDown" || e.key.toLowerCase() === "s") { keysRef.current.down = true; e.preventDefault(); }
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (phaseRef.current === "ready") setPhase("playing");
        else if (phaseRef.current === "playing") setPhase("paused");
        else if (phaseRef.current === "paused") setPhase("playing");
      }
      if (e.key.toLowerCase() === "p") {
        if (phaseRef.current === "playing") setPhase("paused");
        else if (phaseRef.current === "paused") setPhase("playing");
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key.toLowerCase() === "w") keysRef.current.up = false;
      if (e.key === "ArrowDown" || e.key.toLowerCase() === "s") keysRef.current.down = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [setPhase]);

  const pointerToY = (clientY: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return FIELD_H / 2;
    const rect = canvas.getBoundingClientRect();
    return ((clientY - rect.top) / rect.height) * FIELD_H;
  };

  const onPointer = (clientY: number) => {
    playerRef.current.y = Math.max(PADDLE_H / 2, Math.min(FIELD_H - PADDLE_H / 2, pointerToY(clientY)));
  };

  const winner = scores.player > scores.cpu ? "あなた" : "CPU";
  const statusText =
    phase === "finished"
      ? `${scores.player} - ${scores.cpu} で${winner}の勝ちです。`
      : phase === "paused"
        ? "一時停止中です。"
        : phase === "ready"
          ? `先に ${WIN_SCORE} 点取った方が勝ち。スタートを押して開始。`
          : `先に ${WIN_SCORE} 点で勝利`;

  const btn: React.CSSProperties = {
    padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.06)", color: "inherit", cursor: "pointer", fontWeight: 700, minHeight: 44, touchAction: "manipulation",
  };
  const activeBtn: React.CSSProperties = { ...btn, background: "#7ee787", color: "#07130c", borderColor: "#7ee787" };

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ピンポン</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ピンポン</h1>
        <p className="muted">CPUと打ち合う元祖ビデオゲーム。パドルでボールを返し、先に7点取れば勝ちです。</p>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }} role="group" aria-label="難易度">
        {DIFFS.map((d) => (
          <button
            key={d.key}
            type="button"
            style={difficulty === d.key ? activeBtn : btn}
            aria-pressed={difficulty === d.key}
            onClick={() => { setDifficulty(d.key); diffRef.current = d; }}
          >
            {d.label}
          </button>
        ))}
      </div>

      <p className="classic-status" role="status">
        あなた {scores.player} - {scores.cpu} CPU ・ {statusText}
      </p>

      <div style={{ maxWidth: 800, margin: "0 auto" }}>
        <canvas
          ref={canvasRef}
          style={{ width: "100%", aspectRatio: `${FIELD_W} / ${FIELD_H}`, display: "block", borderRadius: 12, background: "#0d1520", touchAction: "none" }}
          aria-label="ピンポンの盤"
          onPointerMove={(e) => onPointer(e.clientY)}
          onPointerDown={(e) => { onPointer(e.clientY); if (phase === "ready") setPhase("playing"); }}
          onTouchStart={(e) => onPointer(e.touches[0].clientY)}
          onTouchMove={(e) => onPointer(e.touches[0].clientY)}
        />
      </div>

      {phase === "finished" && (
        <p className="classic-status" role="alert">
          {scores.player > scores.cpu ? "🎉 あなたの勝ち！" : "CPUの勝ち…"} 最終スコア {scores.player} - {scores.cpu}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 14 }}>
        {phase === "ready" || phase === "paused" ? (
          <button type="button" style={activeBtn} onClick={() => setPhase("playing")}>{phase === "paused" ? "再開" : "スタート"}</button>
        ) : phase === "playing" ? (
          <button type="button" style={btn} onClick={() => setPhase("paused")}>ポーズ</button>
        ) : null}
        <button type="button" style={btn} onClick={resetGame}>もう一度</button>
      </div>
      <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
        マウス / タッチ / ↑↓・W S キーで左パドルを操作。スペースで開始・ポーズ。
      </p>
    </>
  );
}
