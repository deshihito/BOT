"use client";
// モグラたたき。スケジュール/得点は lib/mole.ts。
// 3x3 の穴、30秒制限、通常/金モグラ、コンボ表示、ベストスコア保存。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MOLE_GAME_MS,
  applyMoleHit,
  applyMoleMiss,
  createMoleSchedule,
  type MoleKind,
  type ScheduledMole,
} from "@/lib/mole";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-mole-best";

type Phase = "ready" | "playing" | "finished";
type ActiveMole = ScheduledMole & { id: number; hit: boolean };

function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export default function MoleClient() {
  const { prefix } = useGamesNav();
  const [phase, setPhase] = useState<Phase>("ready");
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [maxCombo, setMaxCombo] = useState(0);
  const [best, setBest] = useState(0);
  const [remainSec, setRemainSec] = useState(30);
  const [active, setActive] = useState<ActiveMole[]>([]);
  const [lastGain, setLastGain] = useState<{ hole: number; gained: number; id: number } | null>(null);

  const mountedRef = useRef(true);
  const rafRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  const startAtRef = useRef(0);
  const activeRef = useRef<ActiveMole[]>([]);
  const scoreRef = useRef(0);
  const comboRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    setBest(loadBest());
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(rafRef.current);
      timersRef.current.forEach((id) => window.clearTimeout(id));
      timersRef.current = [];
    };
  }, []);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
    cancelAnimationFrame(rafRef.current);
  }, []);

  const finish = useCallback(() => {
    clearTimers();
    activeRef.current = [];
    if (!mountedRef.current) return;
    setActive([]);
    setPhase("finished");
    setRemainSec(0);
    if (scoreRef.current > loadBest()) {
      setBest(scoreRef.current);
      try {
        localStorage.setItem(BEST_KEY, String(scoreRef.current));
      } catch {
        /* 保存できなくても遊べる */
      }
    }
  }, [clearTimers]);

  const start = useCallback(() => {
    clearTimers();
    scoreRef.current = 0;
    comboRef.current = 0;
    activeRef.current = [];
    setScore(0);
    setCombo(0);
    setMaxCombo(0);
    setActive([]);
    setLastGain(null);
    setRemainSec(30);
    setPhase("playing");

    const schedule = createMoleSchedule(Date.now() % 2147483647, MOLE_GAME_MS);
    startAtRef.current = performance.now();

    // 残り時間表示ループ
    const tick = () => {
      if (!mountedRef.current) return;
      const elapsed = performance.now() - startAtRef.current;
      const remain = Math.max(0, Math.ceil((MOLE_GAME_MS - elapsed) / 1000));
      setRemainSec(remain);
      if (elapsed < MOLE_GAME_MS) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    schedule.forEach((mole, idx) => {
      const showId = window.setTimeout(() => {
        if (!mountedRef.current) return;
        const entry: ActiveMole = { ...mole, id: idx, hit: false };
        activeRef.current = [...activeRef.current.filter((a) => a.hole !== mole.hole), entry];
        setActive([...activeRef.current]);
      }, mole.spawnAtMs);
      timersRef.current.push(showId);

      const hideId = window.setTimeout(() => {
        if (!mountedRef.current) return;
        const existing = activeRef.current.find((a) => a.id === idx);
        activeRef.current = activeRef.current.filter((a) => a.id !== idx);
        setActive([...activeRef.current]);
        if (existing && !existing.hit) {
          // 見逃しでコンボリセット
          const r = applyMoleMiss(scoreRef.current);
          comboRef.current = r.combo;
          setCombo(r.combo);
        }
      }, mole.spawnAtMs + mole.durationMs);
      timersRef.current.push(hideId);
    });

    const endId = window.setTimeout(finish, MOLE_GAME_MS + 60);
    timersRef.current.push(endId);
  }, [clearTimers, finish]);

  const whack = (hole: number) => {
    if (phase !== "playing") return;
    const target = activeRef.current.find((a) => a.hole === hole && !a.hit);
    if (!target) {
      // 空振り: コンボリセット
      const r = applyMoleMiss(scoreRef.current);
      comboRef.current = r.combo;
      setCombo(0);
      void r;
      return;
    }
    const kind: MoleKind = target.kind;
    const result = applyMoleHit(scoreRef.current, comboRef.current, kind);
    scoreRef.current = result.score;
    comboRef.current = result.combo;
    setScore(result.score);
    setCombo(result.combo);
    setMaxCombo((m) => Math.max(m, result.combo));
    setLastGain({ hole, gained: result.gained, id: target.id });
    activeRef.current = activeRef.current.map((a) => (a.id === target.id ? { ...a, hit: true } : a));
    setActive([...activeRef.current]);
    // ヒット表示を短く見せて消す
    const id = window.setTimeout(() => {
      if (!mountedRef.current) return;
      activeRef.current = activeRef.current.filter((a) => a.id !== target.id);
      setActive([...activeRef.current]);
    }, 160);
    timersRef.current.push(id);
  };

  const btn: React.CSSProperties = {
    padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.06)", color: "inherit", cursor: "pointer", fontWeight: 700, minHeight: 44, touchAction: "manipulation",
  };
  const activeBtn: React.CSSProperties = { ...btn, background: "#e8c832", color: "#1d1700", borderColor: "#e8c832" };

  const statusText =
    phase === "finished"
      ? `終了！スコア ${score}（最大 ${maxCombo} コンボ）でした。`
      : phase === "ready"
        ? "スタートを押すと30秒のモグラたたきが始まります。"
        : `残り ${remainSec} 秒 ・ 金モグラは30点、コンボでボーナス`;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>モグラたたき</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>モグラたたき</h1>
        <p className="muted">穴から顔を出すモグラを、タップ（クリック）で叩きます。金モグラは高得点です。</p>
      </div>

      <p className="classic-status" role="status">
        スコア {score} ・ ベスト {best} ・ {combo > 0 ? `${combo} コンボ！ ・ ` : ""}{statusText}
      </p>

      {/* タイムバー */}
      <div style={{ maxWidth: 420, margin: "0 auto 12px", height: 10, borderRadius: 999, background: "rgba(255,255,255,0.12)", overflow: "hidden" }} aria-hidden="true">
        <div
          style={{
            height: "100%",
            width: phase === "playing" ? `${(remainSec / 30) * 100}%` : phase === "finished" ? "0%" : "100%",
            background: remainSec <= 5 && phase === "playing" ? "#e85d4a" : "#e8c832",
            transition: "width 0.3s linear",
          }}
        />
      </div>

      <div
        style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, maxWidth: 420, margin: "0 auto" }}
        role="grid"
        aria-label="モグラの穴"
      >
        {Array.from({ length: 9 }, (_, hole) => {
          const mole = active.find((a) => a.hole === hole);
          const isGold = mole?.kind === "gold";
          const gain = lastGain && lastGain.hole === hole && mole ? lastGain : null;
          return (
            <button
              key={hole}
              type="button"
              role="gridcell"
              aria-label={mole ? (isGold ? "金モグラ" : "モグラ") : "穴"}
              onPointerDown={() => whack(hole)}
              style={{
                aspectRatio: "1 / 1",
                borderRadius: "50%",
                border: "3px solid rgba(0,0,0,0.35)",
                background: mole
                  ? mole.hit
                    ? "#8a6d3b"
                    : isGold
                      ? "radial-gradient(circle at 50% 35%, #ffe98a, #e8c832 65%, #9a7d12)"
                      : "radial-gradient(circle at 50% 35%, #b08968, #7a5a3e 65%, #4a3421)"
                  : "radial-gradient(circle at 50% 45%, #2a1d12, #17100a 70%)",
                fontSize: "clamp(28px, 9vw, 44px)",
                cursor: "pointer",
                touchAction: "manipulation",
                position: "relative",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transform: mole && !mole.hit ? "translateY(-2px)" : undefined,
                transition: "background 0.08s",
                userSelect: "none",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {mole ? (mole.hit ? "💫" : "🦫") : ""}
              {isGold && !mole?.hit && mole ? <span style={{ position: "absolute", top: 2, right: 6, fontSize: 14 }}>✨</span> : null}
              {gain ? (
                <span style={{ position: "absolute", top: -8, fontSize: 13, fontWeight: 800, color: isGold ? "#e8c832" : "#fff" }}>
                  +{gain.gained}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {phase === "finished" && (
        <p className="classic-status" role="alert">
          ⏱ 終了！ スコア {score} ・ 最大コンボ {maxCombo} ・ ベスト {best}
          {score >= best && score > 0 ? " ・ ベスト更新！" : ""}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 16 }}>
        {phase !== "playing" ? (
          <button type="button" style={activeBtn} onClick={start}>
            {phase === "finished" ? "もう一度遊ぶ" : "スタート（30秒）"}
          </button>
        ) : (
          <button type="button" style={btn} onClick={finish}>やめる</button>
        )}
      </div>
      <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
        穴をタップ / クリックでたたく。通常10点・金30点、5コンボごとに得点アップ。見逃しと空振りでコンボが切れます。
      </p>
    </>
  );
}
