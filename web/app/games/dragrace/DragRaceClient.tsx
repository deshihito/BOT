"use client";
// ドラッグレース。ロジックは lib/dragrace.ts（決定的モデル）。
// グリーンへの反応と、各ギアのシフトタイミングだけでタイムが決まる。
// 時刻の計測はここで行い、lib には経過 ms だけを渡す。端末内で完結する。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  GEAR_COUNT,
  OPTIMAL_SHIFT_MS,
  advanceRace,
  beginCountdown,
  cpuProgress,
  foulStart,
  launch,
  playerProgress,
  rpmFraction,
  shift,
  shiftQualityLabel,
  type DragDifficulty,
  type DragState,
  createDragRace,
} from "@/lib/dragrace";
import { useGamesNav } from "../GamesShell";

const DIFFICULTIES: { key: DragDifficulty; label: string }[] = [
  { key: "easy", label: "よわい" },
  { key: "normal", label: "ふつう" },
  { key: "hard", label: "つよい" },
];

function fmt(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  return `${(ms / 1000).toFixed(3)}秒`;
}

export default function DragRaceClient() {
  const { prefix } = useGamesNav();
  const [difficulty, setDifficulty] = useState<DragDifficulty>("normal");
  const [state, setState] = useState<DragState>(() =>
    createDragRace(Date.now() % 2147483647, "normal"),
  );
  const [green, setGreen] = useState(false);
  const [elapsed, setElapsed] = useState(0); // 発進からの経過 ms（表示・操作用）
  const [best, setBest] = useState<number | null>(null);
  const greenAtRef = useRef(0);
  const launchAtRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const savedRef = useRef<string | null>(null);

  const clearTimers = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    timeoutRef.current = null;
    intervalRef.current = null;
  };

  useEffect(() => clearTimers, []);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem("ago-dragrace-best"));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  useEffect(() => {
    if (state.phase !== "finished" || state.playerTotalMs === null) return;
    const key = `${state.seed}:${state.playerTotalMs}`;
    if (savedRef.current === key) return;
    savedRef.current = key;
    if (best !== null && state.playerTotalMs >= best) return;
    setBest(state.playerTotalMs);
    try {
      window.localStorage.setItem("ago-dragrace-best", String(state.playerTotalMs));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.phase, state.playerTotalMs, state.seed, best]);

  const restart = (diff: DragDifficulty) => {
    clearTimers();
    setDifficulty(diff);
    setGreen(false);
    setElapsed(0);
    savedRef.current = null;
    setState(createDragRace(Date.now() % 2147483647, diff));
  };

  const startCountdown = () => {
    clearTimers();
    setGreen(false);
    setElapsed(0);
    setState((s) => {
      const next = beginCountdown(s);
      if (next.phase === "waiting") {
        timeoutRef.current = setTimeout(() => {
          greenAtRef.current = performance.now();
          setGreen(true);
        }, next.waitMs);
      }
      return next;
    });
  };

  const onAction = () => {
    if (state.phase === "waiting") {
      if (!green) {
        // フライング
        clearTimers();
        setState((s) => foulStart(s));
        return;
      }
      const reaction = performance.now() - greenAtRef.current;
      setState((s) => launch(s, reaction));
      launchAtRef.current = performance.now();
      intervalRef.current = setInterval(() => {
        const el = performance.now() - launchAtRef.current;
        setElapsed(el);
        setState((s) => {
          const next = advanceRace(s, el);
          if (next.phase === "finished" && intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          return next;
        });
      }, 50);
      return;
    }
    if (state.phase === "running") {
      const el = performance.now() - launchAtRef.current;
      setElapsed(el);
      setState((s) => shift(s, el));
    }
  };

  const rpm = state.phase === "running" ? rpmFraction(state, elapsed) : 0;
  const inZone = state.phase === "running" && rpm >= 0.85 && state.shiftsDone < GEAR_COUNT - 1;
  const lastError =
    state.shiftsDone > 0 ? state.shiftErrors[state.shiftsDone - 1] : null;
  const raceTotalElapsed =
    state.reactionMs !== null ? state.reactionMs + elapsed : 0;
  const pProg = playerProgress(state, raceTotalElapsed) * 100;
  const cProg = cpuProgress(state, raceTotalElapsed) * 100;

  const statusText =
    state.phase === "ready"
      ? "スタートを押すとライトが点きます。グリーンになったらすぐ押そう。"
      : state.phase === "waiting"
        ? green
          ? "グリーン! 今すぐ押せ!"
          : "…まだ押すな。グリーンを待て。"
        : state.phase === "fouled"
          ? "フライングで失格…グリーンまで待とう。"
          : state.phase === "running"
            ? state.shiftsDone < GEAR_COUNT - 1
              ? `ギア${state.shiftsDone + 1}。メーターが右端のゾーンに入ったらシフト!${
                  lastError !== null ? ` 前回: ${shiftQualityLabel(lastError)}` : ""
                }`
              : "全ギアシフト完了。あとはゴールまで真っ直ぐ!"
            : state.winner === "player"
              ? "勝ち! 相手より速かった。"
              : state.winner === "draw"
                ? "まったくの同タイムで引き分け。"
                : "負け…反応とシフトを磨こう。";

  const actionLabel =
    state.phase === "waiting"
      ? green
        ? "GO!"
        : "まだ…"
      : state.phase === "running"
        ? state.shiftsDone < GEAR_COUNT - 1
          ? "シフト!"
          : "走行中…"
        : "押しても何も起きません";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ドラッグレース</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ドラッグレース</h1>
        <p className="muted">
          大きなボタン1つで、発進とシフトアップを操作します。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="相手の強さ">
        {DIFFICULTIES.map((d) => (
          <button
            key={d.key}
            type="button"
            aria-pressed={difficulty === d.key}
            className={difficulty === d.key ? "classic-btn classic-btn-active" : "classic-btn"}
            onClick={() => restart(d.key)}
          >
            {d.label}
          </button>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(difficulty)}>
          もう一度
        </button>
        <button
          type="button"
          className="classic-btn"
          onClick={startCountdown}
          disabled={state.phase === "waiting" || state.phase === "running"}
        >
          スタート
        </button>
      </div>

      <p className="classic-status" role="status">
        {best !== null ? `ベスト ${fmt(best)} ・ ` : ""}
        {state.phase === "finished" || state.phase === "fouled"
          ? `あなた ${state.phase === "fouled" ? "失格" : fmt(state.playerTotalMs)} / CPU ${fmt(state.cpuTotalMs)} ・ `
          : state.reactionMs !== null
            ? `反応 ${state.reactionMs}ms ・ `
            : ""}
        {statusText}
      </p>

      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        {/* ライト */}
        <div
          role="img"
          aria-label={green ? "グリーンライト" : state.phase === "waiting" ? "レッドライト" : "ライト消灯"}
          style={{ display: "flex", justifyContent: "center", margin: "10px 0" }}
        >
          <span
            aria-hidden
            style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              display: "inline-block",
              background:
                state.phase === "waiting" && !green
                  ? "#e33"
                  : green || state.phase === "running" || state.phase === "finished"
                    ? "#2ecc71"
                    : "#666",
              boxShadow: "0 0 18px rgba(0,0,0,0.35)",
            }}
          />
        </div>

        {/* コース */}
        <div style={{ display: "grid", gap: 10, margin: "8px 0" }}>
          {[
            { label: "あなた", prog: pProg, color: "#2f7fe0" },
            { label: "CPU", prog: cProg, color: "#e05a2f" },
          ].map((lane) => (
            <div key={lane.label}>
              <div style={{ fontSize: 13, marginBottom: 2 }}>{lane.label}</div>
              <div
                aria-hidden
                style={{
                  position: "relative",
                  height: 30,
                  background: "var(--soft)",
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${Math.min(100, lane.prog)}%`,
                    background: lane.color,
                    transition: "width 60ms linear",
                  }}
                />
                <span style={{ position: "absolute", right: 6, top: 4, fontSize: 16 }}>🏎️</span>
              </div>
            </div>
          ))}
        </div>

        {/* RPM メーター */}
        <div style={{ margin: "12px 0 4px", fontSize: 13 }}>
          RPM（ギア {Math.min(GEAR_COUNT, state.shiftsDone + 1)} / {GEAR_COUNT}）
          {state.shiftsDone < GEAR_COUNT - 1 && state.phase === "running"
            ? ` ・ 最適シフトまであと約 ${Math.max(0, Math.round(OPTIMAL_SHIFT_MS[state.shiftsDone] - elapsed))}ms`
            : ""}
        </div>
        <div
          aria-hidden
          style={{
            position: "relative",
            height: 22,
            background: "var(--soft)",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              bottom: 0,
              width: "15%",
              background: "rgba(46, 204, 113, 0.45)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${rpm * 100}%`,
              background: inZone ? "#2ecc71" : "#e0a32f",
              transition: "width 50ms linear",
            }}
          />
        </div>

        <button
          type="button"
          onClick={onAction}
          disabled={state.phase === "ready" || state.phase === "finished" || state.phase === "fouled"}
          style={{
            display: "block",
            width: "100%",
            minHeight: 72,
            marginTop: 16,
            fontSize: 24,
            fontWeight: 800,
            borderRadius: 12,
            border: "none",
            color: "#fff",
            background:
              state.phase === "waiting" && green
                ? "#27ae60"
                : state.phase === "running"
                  ? inZone
                    ? "#27ae60"
                    : "#2f7fe0"
                  : "#888",
            cursor:
              state.phase === "waiting" || state.phase === "running" ? "pointer" : "default",
            touchAction: "manipulation",
          }}
        >
          {actionLabel}
        </button>

        {state.phase === "finished" && (
          <p style={{ textAlign: "center", marginTop: 12 }}>
            あなた {fmt(state.playerTotalMs)}（反応 {state.reactionMs}ms） / CPU {fmt(state.cpuTotalMs)}
            （反応 {state.cpuReactionMs}ms）
          </p>
        )}
      </div>
    </>
  );
}
