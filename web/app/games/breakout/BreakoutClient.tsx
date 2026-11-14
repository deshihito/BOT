"use client";
// ブロック崩し。配置・得点は lib/breakout.ts、物理は canvas の rAF ループ。
// マウス/タッチ/キーでパドルを動かす。残機3、レベル進行あり。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const BreakoutScene3D = dynamic(() => import("./BreakoutScene3D"), { ssr: false });
import {
  BREAKOUT_FIELD_H,
  BREAKOUT_FIELD_W,
  BREAKOUT_LEVELS,
  bricksForLevel,
  damageBrick,
  hasNextLevel,
  isBreakoutCleared,
  type BreakoutBrick,
} from "@/lib/breakout";
import { sfxLose, sfxPop, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

type Phase = "ready" | "playing" | "paused" | "life-lost" | "gameover" | "cleared" | "all-cleared";

type Ball = { x: number; y: number; vx: number; vy: number; r: number };

const PADDLE_H = 12;
const PADDLE_Y = BREAKOUT_FIELD_H - 28;

function initialBall(speed: number): Ball {
  const angle = -Math.PI / 3; // 右上へ
  return {
    x: BREAKOUT_FIELD_W / 2,
    y: PADDLE_Y - 14,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    r: 8,
  };
}

export default function BreakoutClient() {
  const { prefix } = useGamesNav();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  const mountedRef = useRef(true);
  const keysRef = useRef<{ left: boolean; right: boolean }>({ left: false, right: false });
  const paddleRef = useRef({ x: BREAKOUT_FIELD_W / 2, w: BREAKOUT_LEVELS[0].paddleWidth });
  const ballRef = useRef<Ball>(initialBall(BREAKOUT_LEVELS[0].ballSpeed));
  const bricksRef = useRef<BreakoutBrick[]>(bricksForLevel(0));
  const phaseRef = useRef<Phase>("ready");

  const [phase, setPhaseState] = useState<Phase>("ready");
  const [webglFailed, setWebglFailed] = useState(false);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [levelIdx, setLevelIdx] = useState(0);
  const scoreRef = useRef(0);
  const livesRef = useRef(3);
  const levelRef = useRef(0);

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    if (mountedRef.current) setPhaseState(p);
  }, []);

  const resetBallAndPaddle = useCallback((lvl: number) => {
    const def = BREAKOUT_LEVELS[lvl];
    paddleRef.current = { x: BREAKOUT_FIELD_W / 2, w: def.paddleWidth };
    ballRef.current = initialBall(def.ballSpeed);
  }, []);

  const startLevel = useCallback(
    (lvl: number, keepScore: boolean, keepLives: boolean) => {
      levelRef.current = lvl;
      setLevelIdx(lvl);
      bricksRef.current = bricksForLevel(lvl);
      if (!keepScore) {
        scoreRef.current = 0;
        setScore(0);
      }
      if (!keepLives) {
        livesRef.current = 3;
        setLives(3);
      }
      resetBallAndPaddle(lvl);
      setPhase("ready");
    },
    [resetBallAndPaddle, setPhase],
  );

  const startGame = useCallback(() => startLevel(0, false, false), [startLevel]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // 描画＋物理ループ（常時 rAF、phase で物理だけ止める）
  useEffect(() => {
    let last = performance.now();
    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      // 物理は canvas の有無に依存しない (3D 表示時は canvas が無いため、
      // ここで早期 return するとゲーム自体が止まる)。描画だけを下で分岐する。
      const canvas = canvasRef.current;

      // --- 物理 ---
      if (phaseRef.current === "playing") {
        const paddle = paddleRef.current;
        const keySpeed = 520;
        if (keysRef.current.left) paddle.x -= keySpeed * dt;
        if (keysRef.current.right) paddle.x += keySpeed * dt;
        paddle.x = Math.max(paddle.w / 2, Math.min(BREAKOUT_FIELD_W - paddle.w / 2, paddle.x));

        const ball = ballRef.current;
        // 小さい dt でもトンネリングしないよう分割
        const steps = Math.max(1, Math.ceil((Math.hypot(ball.vx, ball.vy) * dt) / 6));
        const sdt = dt / steps;
        let lost = false;
        for (let s = 0; s < steps; s++) {
          ball.x += ball.vx * sdt;
          ball.y += ball.vy * sdt;
          if (ball.x - ball.r < 0) { ball.x = ball.r; ball.vx = Math.abs(ball.vx); }
          if (ball.x + ball.r > BREAKOUT_FIELD_W) { ball.x = BREAKOUT_FIELD_W - ball.r; ball.vx = -Math.abs(ball.vx); }
          if (ball.y - ball.r < 0) { ball.y = ball.r; ball.vy = Math.abs(ball.vy); }
          if (ball.y - ball.r > BREAKOUT_FIELD_H + 20) { lost = true; break; }

          // パドル
          if (
            ball.vy > 0 &&
            ball.y + ball.r >= PADDLE_Y &&
            ball.y + ball.r <= PADDLE_Y + PADDLE_H + 6 &&
            ball.x >= paddle.x - paddle.w / 2 - ball.r &&
            ball.x <= paddle.x + paddle.w / 2 + ball.r
          ) {
            const rel = Math.max(-1, Math.min(1, (ball.x - paddle.x) / (paddle.w / 2)));
            const speed = Math.hypot(ball.vx, ball.vy);
            const angle = rel * (Math.PI / 3); // 最大60度
            ball.vx = Math.sin(angle) * speed;
            ball.vy = -Math.cos(angle) * speed;
            ball.y = PADDLE_Y - ball.r;
            sfxTap();
          }

          // ブロック
          const bricks = bricksRef.current;
          for (let i = 0; i < bricks.length; i++) {
            const b = bricks[i];
            if (!b.alive) continue;
            if (ball.x + ball.r < b.x || ball.x - ball.r > b.x + b.w || ball.y + ball.r < b.y || ball.y - ball.r > b.y + b.h) continue;
            const result = damageBrick(bricks, i);
            bricksRef.current = result.bricks;
            if (result.gained > 0) {
              scoreRef.current += result.gained;
              if (mountedRef.current) setScore(scoreRef.current);
              sfxPop();
            }
            // 反射方向: 前位置から判定（簡易: 侵入量が小さい軸で反射）
            const overlapLeft = ball.x + ball.r - b.x;
            const overlapRight = b.x + b.w - (ball.x - ball.r);
            const overlapTop = ball.y + ball.r - b.y;
            const overlapBottom = b.y + b.h - (ball.y - ball.r);
            const minX = Math.min(overlapLeft, overlapRight);
            const minY = Math.min(overlapTop, overlapBottom);
            if (minX < minY) ball.vx = overlapLeft < overlapRight ? -Math.abs(ball.vx) : Math.abs(ball.vx);
            else ball.vy = overlapTop < overlapBottom ? -Math.abs(ball.vy) : Math.abs(ball.vy);
            break;
          }
        }

        if (lost) {
          livesRef.current -= 1;
          if (mountedRef.current) setLives(livesRef.current);
          if (livesRef.current <= 0) {
            sfxLose();
            setPhase("gameover");
          } else {
            sfxWrong();
            resetBallAndPaddle(levelRef.current);
            setPhase("life-lost");
          }
        } else if (isBreakoutCleared(bricksRef.current)) {
          sfxWin();
          setPhase(hasNextLevel(levelRef.current) ? "cleared" : "all-cleared");
        }
      } else if (phaseRef.current === "ready" || phaseRef.current === "life-lost") {
        // ボールをパドルの上に載せて待機
        ballRef.current.x = paddleRef.current.x;
        ballRef.current.y = PADDLE_Y - ballRef.current.r - 2;
      }

      // --- 描画 (2D フォールバック表示時のみ。3D 時はシーンが getState で追従) ---
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssW = canvas.clientWidth || BREAKOUT_FIELD_W;
      const scale = cssW / BREAKOUT_FIELD_W;
      const pxW = Math.round(cssW * dpr);
      const pxH = Math.round(cssW * (BREAKOUT_FIELD_H / BREAKOUT_FIELD_W) * dpr);
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
      ctx.fillStyle = "#101827";
      ctx.fillRect(0, 0, BREAKOUT_FIELD_W, BREAKOUT_FIELD_H);
      for (const b of bricksRef.current) {
        if (!b.alive) continue;
        ctx.fillStyle = b.color;
        ctx.globalAlpha = b.maxHp > 1 ? 0.55 + 0.45 * (b.hp / b.maxHp) : 1;
        ctx.beginPath();
        ctx.roundRect(b.x, b.y, b.w, b.h, 4);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (b.maxHp > 1) {
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.font = "bold 11px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(String(b.hp), b.x + b.w / 2, b.y + b.h - 6);
        }
      }
      const paddle = paddleRef.current;
      ctx.fillStyle = "#f2f5f9";
      ctx.beginPath();
      ctx.roundRect(paddle.x - paddle.w / 2, PADDLE_Y, paddle.w, PADDLE_H, 6);
      ctx.fill();
      const ball = ballRef.current;
      ctx.fillStyle = "#ffd34d";
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
      ctx.fill();
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [resetBallAndPaddle, setPhase]);

  // キー操作
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key.toLowerCase() === "a") { keysRef.current.left = true; e.preventDefault(); }
      if (e.key === "ArrowRight" || e.key.toLowerCase() === "d") { keysRef.current.right = true; e.preventDefault(); }
      if (e.key === " " || e.key === "Enter") {
        const target = e.target as HTMLElement | null;
        // 「もう一度」ボタンにフォーカスがあるときはネイティブ click に任せ、
        // window 側の発射・次レベル・再開と二重に走らせない（falling / wordle と同じ構図）。
        if (target?.closest?.("[data-breakout-ui]")) return;
        e.preventDefault();
        if (phaseRef.current === "ready" || phaseRef.current === "life-lost") setPhase("playing");
        else if (phaseRef.current === "playing") setPhase("paused");
        else if (phaseRef.current === "paused") setPhase("playing");
        else if (phaseRef.current === "cleared") startLevel(levelRef.current + 1, true, true);
        else if (phaseRef.current === "gameover" || phaseRef.current === "all-cleared") startGame();
      }
      if (e.key.toLowerCase() === "p") {
        if (phaseRef.current === "playing") setPhase("paused");
        else if (phaseRef.current === "paused") setPhase("playing");
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key.toLowerCase() === "a") keysRef.current.left = false;
      if (e.key === "ArrowRight" || e.key.toLowerCase() === "d") keysRef.current.right = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [setPhase, startGame, startLevel]);

  const pointerToFieldX = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return BREAKOUT_FIELD_W / 2;
    const rect = canvas.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * BREAKOUT_FIELD_W;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    paddleRef.current.x = Math.max(
      paddleRef.current.w / 2,
      Math.min(BREAKOUT_FIELD_W - paddleRef.current.w / 2, pointerToFieldX(e.clientX)),
    );
  };

  const launch = () => {
    if (phase === "ready" || phase === "life-lost" || phase === "paused") {
      sfxTap();
      setPhase("playing");
    }
  };

  // 盤面のジェスチャ: タップ = 発射・再開・次レベルへ（onPointerDown 側で処理）、
  // 下スワイプ = ポーズ（プレイ中のみ。横方向のドラッグはパドル移動のため無視）。
  const boardGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "down" && phaseRef.current === "playing") {
        sfxTap();
        setPhase("paused");
      }
    },
  });

  // --- 3D シーンとの接続 (語彙は 2D と同一) ---
  // パドルの目標位置 (フィールド座標 x)。2D の onPointerMove と同じクランプ。
  const handleTarget3D = useCallback((fieldX: number) => {
    paddleRef.current.x = Math.max(
      paddleRef.current.w / 2,
      Math.min(BREAKOUT_FIELD_W - paddleRef.current.w / 2, fieldX),
    );
  }, []);
  // タップ = 発射・再開、クリア時は次のレベルへ (2D の盤面 onPointerDown と同じ)。
  const handlePress3D = useCallback(() => {
    if (phaseRef.current === "ready" || phaseRef.current === "life-lost" || phaseRef.current === "paused") {
      sfxTap();
      setPhase("playing");
    } else if (phaseRef.current === "cleared") {
      startLevel(levelRef.current + 1, true, true);
    }
  }, [setPhase, startLevel]);
  // 下スワイプ = ポーズ (プレイ中のみ。2D の boardGesture と同じ)。
  const handleSwipeDown3D = useCallback(() => {
    if (phaseRef.current === "playing") {
      sfxTap();
      setPhase("paused");
    }
  }, [setPhase]);

  const statusText =
    phase === "gameover"
      ? `ゲームオーバー。スコア ${score} でした。`
      : phase === "all-cleared"
        ? `全レベルクリア！最終スコア ${score}`
        : phase === "cleared"
          ? `レベル ${levelIdx + 1} クリア！`
          : phase === "paused"
            ? "一時停止中です。"
            : phase === "life-lost"
              ? `ミス… 残りライフ ${lives}。タップかスペースで再開。`
              : phase === "ready"
                ? "タップかスペースでボール発射。"
                : `${BREAKOUT_LEVELS[levelIdx].name} ・ スコア ${score}`;

  const btn: React.CSSProperties = {
    padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.06)", color: "inherit", cursor: "pointer", fontWeight: 700, minHeight: 44, touchAction: "manipulation",
  };

  // 既存 2D 表示 (WebGL が使えない環境へのフォールバックとしてシーンへも渡す)。
  const board2d = (
      <div style={{ maxWidth: 800, margin: "0 auto" }}>
        <canvas
          ref={canvasRef}
          style={{ width: "100%", aspectRatio: `${BREAKOUT_FIELD_W} / ${BREAKOUT_FIELD_H}`, display: "block", borderRadius: 12, background: "#101827", touchAction: "none", cursor: "pointer" }}
          aria-label="ブロック崩しの盤（タップで発射・再開・次のレベルへ、下にスワイプでポーズ）"
          onPointerMove={onPointerMove}
          onPointerDown={(e) => {
            onPointerMove(e);
            launch();
            // クリア時は盤面タップで次のレベルへ（旧「次のレベルへ」ボタンの代替）。
            if (phaseRef.current === "cleared") startLevel(levelRef.current + 1, true, true);
            boardGesture.onPointerDown(e);
          }}
          onPointerUp={boardGesture.onPointerUp}
          onPointerCancel={boardGesture.onPointerCancel}
          onTouchStart={(e) => {
            const t = e.touches[0];
            paddleRef.current.x = pointerToFieldX(t.clientX);
          }}
          onTouchMove={(e) => {
            const t = e.touches[0];
            paddleRef.current.x = pointerToFieldX(t.clientX);
          }}
        />
      </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ブロック崩し</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ブロック崩し</h1>
        <p className="muted">パドルでボールを跳ね返してブロックを全部壊す定番アクション。ライフは3つ、全3レベルです。</p>
      </div>

      <p className="classic-status" role="status">
        スコア <span key={score} className="juice-pulse" style={{ display: "inline-block" }}>{score}</span> ・ ライフ {"♥".repeat(Math.max(0, lives)) || "—"} ・ {BREAKOUT_LEVELS[levelIdx].name} ・ {statusText}
      </p>

{webglFailed ? board2d : (
        <div style={{ maxWidth: 800, margin: "0 auto" }}>
          <BreakoutScene3D
            getState={() => ({ ball: ballRef.current, paddle: paddleRef.current, bricks: bricksRef.current })}
            onTarget={handleTarget3D}
            onPress={handlePress3D}
            onSwipeDown={handleSwipeDown3D}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      {(phase === "gameover" || phase === "all-cleared") && (
        <div style={{ maxWidth: 520, margin: "14px auto 0" }}>
          <EndScreen
            outcome={phase === "all-cleared" ? "win" : "lose"}
            title={phase === "all-cleared" ? "全レベルクリア！" : "ゲームオーバー"}
            score={score}
            onRetry={startGame}
          >
            <p className="muted" style={{ margin: 0 }}>
              到達レベル {levelIdx + 1} / {BREAKOUT_LEVELS.length}
            </p>
          </EndScreen>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 14 }}>
        <button type="button" style={btn} onClick={startGame} data-breakout-ui="">
          もう一度
        </button>
      </div>
      <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
        マウス / タッチでパドル移動。盤面タップで発射・再開、クリア時は盤面タップで次のレベルへ。盤面を下へスワイプでポーズ。←→・A D キーでも移動でき、スペースで発射・ポーズ、P キーでもポーズ切替。
      </p>
    </>
  );
}
