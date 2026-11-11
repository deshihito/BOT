"use client";
// よけゲー（ドッジ）。canvas で上から落ちる障害物を左右移動で避け続け、生存時間を競う。
// 描画と物理はこの Client 内で完結する（純粋 lib は持たない）。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-dodge-best";

const FIELD_W = 400;
const FIELD_H = 560;
const PLAYER_R = 14;
const PLAYER_Y = FIELD_H - 52;

type Phase = "ready" | "playing" | "gameover";
type Obstacle = { x: number; y: number; r: number; vy: number; hue: number };

function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** 経過秒に応じた落下速度の基本値（px/s）。時間とともに加速する。 */
function baseFallSpeed(elapsedSec: number): number {
  return 175 + elapsedSec * 7;
}

/** 経過秒に応じた出現間隔（ms）。時間とともに短くなる（下限あり）。 */
function spawnIntervalMs(elapsedSec: number): number {
  return Math.max(300, 820 - elapsedSec * 16);
}

export default function DodgeClient() {
  const { prefix } = useGamesNav();
  const [phase, setPhase] = useState<Phase>("ready");
  const [scoreSec, setScoreSec] = useState(0);
  const [best, setBest] = useState(0);
  const [dodged, setDodged] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mountedRef = useRef(true);
  const rafRef = useRef(0);
  const phaseRef = useRef<Phase>("ready");
  phaseRef.current = phase;

  const playerXRef = useRef(FIELD_W / 2);
  const targetXRef = useRef(FIELD_W / 2);
  const obstaclesRef = useRef<Obstacle[]>([]);
  const keysRef = useRef<{ left: boolean; right: boolean }>({ left: false, right: false });
  const startAtRef = useRef(0);
  const lastFrameRef = useRef(0);
  const spawnInRef = useRef(0);
  const dodgedRef = useRef(0);
  const lastScorePushRef = useRef(0);

  const draw = useCallback((elapsedSec: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // 解像度に合わせてバックストアを調整する（変更すると canvas はクリアされるが毎フレーム全描画するので問題ない）
    if (canvas.width !== Math.round(FIELD_W * dpr) || canvas.height !== Math.round(FIELD_H * dpr)) {
      canvas.width = Math.round(FIELD_W * dpr);
      canvas.height = Math.round(FIELD_H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 背景
    const grad = ctx.createLinearGradient(0, 0, 0, FIELD_H);
    grad.addColorStop(0, "#0d1526");
    grad.addColorStop(1, "#16233d");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, FIELD_W, FIELD_H);

    // 流れる目安線（スピード感）
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 2;
    const offset = (elapsedSec * baseFallSpeed(elapsedSec)) % 56;
    for (let y = -56 + offset; y < FIELD_H; y += 56) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(FIELD_W, y);
      ctx.stroke();
    }

    // 障害物
    for (const o of obstaclesRef.current) {
      ctx.beginPath();
      ctx.fillStyle = `hsl(${o.hue} 75% 58%)`;
      ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.arc(o.x - o.r * 0.3, o.y - o.r * 0.3, o.r * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }

    // プレイヤー
    const px = playerXRef.current;
    ctx.beginPath();
    ctx.fillStyle = "#ffd23e";
    ctx.arc(px, PLAYER_Y, PLAYER_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = "#1d1700";
    ctx.arc(px - 4.5, PLAYER_Y - 3, 2.2, 0, Math.PI * 2);
    ctx.arc(px + 4.5, PLAYER_Y - 3, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.strokeStyle = "#1d1700";
    ctx.lineWidth = 1.8;
    ctx.arc(px, PLAYER_Y + 2, 6, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }, []);

  const finish = useCallback(
    (elapsedSec: number) => {
      cancelAnimationFrame(rafRef.current);
      if (!mountedRef.current) return;
      setPhase("gameover");
      phaseRef.current = "gameover";
      setScoreSec(Math.round(elapsedSec * 10) / 10);
      setDodged(dodgedRef.current);
      const prev = loadBest();
      if (elapsedSec > prev) {
        const rounded = Math.round(elapsedSec * 10) / 10;
        setBest(rounded);
        try {
          localStorage.setItem(BEST_KEY, String(rounded));
        } catch {
          /* 保存できなくても遊べる */
        }
      }
      draw(elapsedSec);
    },
    [draw],
  );

  const start = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    playerXRef.current = FIELD_W / 2;
    targetXRef.current = FIELD_W / 2;
    obstaclesRef.current = [];
    keysRef.current = { left: false, right: false };
    dodgedRef.current = 0;
    spawnInRef.current = 350;
    setDodged(0);
    setScoreSec(0);
    setPhase("playing");
    phaseRef.current = "playing";
    startAtRef.current = performance.now();
    lastFrameRef.current = startAtRef.current;
    lastScorePushRef.current = 0;

    const loop = (now: number) => {
      if (!mountedRef.current || phaseRef.current !== "playing") return;
      const dtMs = Math.min(50, now - lastFrameRef.current);
      lastFrameRef.current = now;
      const dt = dtMs / 1000;
      const elapsedSec = (now - startAtRef.current) / 1000;

      // キー移動（ターゲット位置を動かす）
      const keySpeed = 340;
      if (keysRef.current.left) targetXRef.current -= keySpeed * dt;
      if (keysRef.current.right) targetXRef.current += keySpeed * dt;
      targetXRef.current = Math.max(PLAYER_R, Math.min(FIELD_W - PLAYER_R, targetXRef.current));

      // プレイヤーはターゲットへ滑らかに追従
      const dx = targetXRef.current - playerXRef.current;
      playerXRef.current += dx * Math.min(1, dt * 14);
      playerXRef.current = Math.max(PLAYER_R, Math.min(FIELD_W - PLAYER_R, playerXRef.current));

      // 出現
      spawnInRef.current -= dtMs;
      if (spawnInRef.current <= 0) {
        const r = 11 + Math.random() * 13;
        obstaclesRef.current.push({
          x: r + Math.random() * (FIELD_W - r * 2),
          y: -r,
          r,
          vy: baseFallSpeed(elapsedSec) * (0.85 + Math.random() * 0.45),
          hue: Math.floor(Math.random() * 360),
        });
        spawnInRef.current = spawnIntervalMs(elapsedSec) * (0.75 + Math.random() * 0.5);
      }

      // 移動と衝突
      let crashed = false;
      const next: Obstacle[] = [];
      for (const o of obstaclesRef.current) {
        const moved = { ...o, y: o.y + o.vy * dt };
        if (moved.y - moved.r > FIELD_H) {
          dodgedRef.current += 1;
          continue;
        }
        const ddx = moved.x - playerXRef.current;
        const ddy = moved.y - PLAYER_Y;
        if (ddx * ddx + ddy * ddy < (moved.r + PLAYER_R - 4) * (moved.r + PLAYER_R - 4)) {
          crashed = true;
        }
        next.push(moved);
      }
      obstaclesRef.current = next;

      draw(elapsedSec);

      // スコア表示は 100ms ごとに更新（再描画を抑える）
      if (now - lastScorePushRef.current >= 100) {
        lastScorePushRef.current = now;
        setScoreSec(Math.round(elapsedSec * 10) / 10);
        setDodged(dodgedRef.current);
      }

      if (crashed) {
        finish(elapsedSec);
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [draw, finish]);

  useEffect(() => {
    mountedRef.current = true;
    setBest(loadBest());
    // 初期画面を描く
    draw(0);
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [draw]);

  // キーボード操作
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") {
        keysRef.current.left = true;
        if (phaseRef.current === "playing") e.preventDefault();
      }
      if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") {
        keysRef.current.right = true;
        if (phaseRef.current === "playing") e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") keysRef.current.left = false;
      if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") keysRef.current.right = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const moveToPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (phaseRef.current !== "playing") return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * FIELD_W;
    targetXRef.current = Math.max(PLAYER_R, Math.min(FIELD_W - PLAYER_R, x));
  };

  const btn: React.CSSProperties = {
    padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.06)", color: "inherit", cursor: "pointer", fontWeight: 700, minHeight: 44, touchAction: "manipulation",
  };
  const activeBtn: React.CSSProperties = { ...btn, background: "#ffd23e", color: "#1d1700", borderColor: "#ffd23e" };

  const statusText =
    phase === "gameover"
      ? `${scoreSec.toFixed(1)} 秒生き残りました（よけた障害物 ${dodged} 個）。`
      : phase === "ready"
        ? "スタートを押すと障害物が落ちてきます。"
        : `${scoreSec.toFixed(1)} 秒 ・ よけた数 ${dodged} ・ 時間とともに速くなります`;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>よけゲー</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>よけゲー</h1>
        <p className="muted">上から落ちてくる障害物を左右に動いて避け続けます。当たったら即終了、生き残った時間がスコアです。</p>
      </div>

      <p className="classic-status" role="status">
        生存 {scoreSec.toFixed(1)} 秒 ・ ベスト {best > 0 ? `${best.toFixed(1)} 秒` : "—"} ・ {statusText}
      </p>

      <div style={{ maxWidth: 400, margin: "0 auto" }}>
        <canvas
          ref={canvasRef}
          width={FIELD_W * 2}
          height={FIELD_H * 2}
          onPointerDown={moveToPointer}
          onPointerMove={(e) => {
            if (e.buttons > 0 || e.pointerType === "touch") moveToPointer(e);
          }}
          aria-label="よけゲーのフィールド。指やマウスで左右に動かします"
          style={{
            width: "100%", height: "auto", display: "block",
            borderRadius: 16, border: "2px solid rgba(255,255,255,0.15)",
            touchAction: "none", userSelect: "none", WebkitTapHighlightColor: "transparent",
            cursor: phase === "playing" ? "ew-resize" : "default",
          }}
        />
      </div>

      {phase === "gameover" && (
        <p className="classic-status" role="alert">
          💥 ぶつかりました！ 生存 {scoreSec.toFixed(1)} 秒 ・ よけた障害物 {dodged} 個 ・ ベスト {best.toFixed(1)} 秒
          {best > 0 && scoreSec >= best ? " ・ ベスト更新！" : ""}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 16 }}>
        {phase !== "playing" ? (
          <button type="button" style={activeBtn} onClick={start}>
            {phase === "gameover" ? "もう一度挑戦" : "スタート"}
          </button>
        ) : (
          <>
            <button type="button" style={btn} onClick={() => { targetXRef.current = Math.max(PLAYER_R, targetXRef.current - 60); }}>← よける</button>
            <button type="button" style={btn} onClick={() => { targetXRef.current = Math.min(FIELD_W - PLAYER_R, targetXRef.current + 60); }}>よける →</button>
          </>
        )}
      </div>
      <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
        フィールド上で指を動かす / マウスを押しながら動かす / ←→キー・A Dキーで移動。時間経過で障害物は速く・多くなります。
      </p>
    </>
  );
}
