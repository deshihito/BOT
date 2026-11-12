"use client";
// 反応速度（リアクション）。状態遷移と集計は lib/reaction.ts。
// 赤く光っている間は待つ → 緑になった瞬間にタップまでの ms を計る。5回計測して平均を出す。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  REACTION_ROUNDS,
  createReactionSession,
  gradeForAverage,
  recordTap,
  signalReady,
  startRound,
  summarizeResults,
  tapTooEarly,
  type ReactionState,
} from "@/lib/reaction";
import { sfxCorrect, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-reaction-best";

function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function saveBest(averageMs: number): number {
  const prev = loadBest();
  const next = prev === 0 || averageMs < prev ? averageMs : prev;
  try {
    localStorage.setItem(BEST_KEY, String(next));
  } catch {
    /* 保存できなくても遊べる */
  }
  return next;
}

export default function ReactionClient() {
  const { prefix } = useGamesNav();
  const [session, setSession] = useState<ReactionState | null>(null);
  const [best, setBest] = useState(0);
  const [isNewBest, setIsNewBest] = useState(false);
  const [prevBestAtDone, setPrevBestAtDone] = useState<number | null>(null);
  const prevPhaseRef = useRef<string>("idle");
  // 画面表示専用: 全体が終わったかどうかは session.phase === "done" で判定する

  // 終局遷移の瞬間だけジングルを鳴らす。
  useEffect(() => {
    const phaseNow = session?.phase ?? "idle";
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phaseNow;
    if (prev === phaseNow || phaseNow !== "done") return;
    if (isNewBest) sfxWin();
    else sfxCorrect();
  }, [session?.phase, isNewBest]);

  const mountedRef = useRef(true);
  const timerRef = useRef<number | null>(null);
  const readyAtRef = useRef(0);
  const sessionRef = useRef<ReactionState | null>(null);
  sessionRef.current = session;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setBest(loadBest());
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  /** ラウンドを開始してタイマーを張る。 */
  const beginRound = useCallback(
    (base: ReactionState) => {
      clearTimer();
      const waiting = startRound(base);
      if (waiting === base || waiting.phase !== "waiting") return;
      sessionRef.current = waiting;
      setSession(waiting);
      timerRef.current = window.setTimeout(() => {
        if (!mountedRef.current) return;
        const cur = sessionRef.current;
        if (!cur || cur.phase !== "waiting") return;
        const ready = signalReady(cur);
        readyAtRef.current = performance.now();
        sessionRef.current = ready;
        setSession(ready);
      }, waiting.currentWaitMs);
    },
    [clearTimer],
  );

  const startSession = useCallback(() => {
    setIsNewBest(false);
    // 開始ボタンにフォーカスが残ると、計測中のスペースがボタンの標準活性化で
    // startSession を再発火させてしまう。開始直後にフォーカスを外す。
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const fresh = createReactionSession(Date.now() % 2147483647, REACTION_ROUNDS);
    beginRound(fresh);
  }, [beginRound]);

  const handleTap = useCallback(() => {
    const cur = sessionRef.current;
    if (!cur) {
      startSession();
      return;
    }
    if (cur.phase === "waiting") {
      clearTimer();
      sfxWrong();
      const foul = tapTooEarly(cur);
      sessionRef.current = foul;
      setSession(foul);
      return;
    }
    if (cur.phase === "tooSoon" || cur.phase === "idle") {
      beginRound(cur);
      return;
    }
    if (cur.phase === "ready") {
      const ms = performance.now() - readyAtRef.current;
      const next = recordTap(cur, ms);
      sessionRef.current = next;
      setSession(next);
      if (next.phase === "done") {
        const summary = summarizeResults(next.results);
        if (summary.count > 0) {
          const prevBest = loadBest();
          const nb = saveBest(summary.averageMs);
          setBest(nb);
          setIsNewBest(prevBest === 0 || summary.averageMs < prevBest);
          setPrevBestAtDone(prevBest === 0 ? null : prevBest);
        }
      } else {
        sfxTap();
      }
      return;
    }
    if (cur.phase === "done") {
      startSession();
    }
  }, [beginRound, clearTimer, startSession]);

  // スペースキーでもタップできる（ボタンにフォーカスがある場合は二重発火を防ぐ）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      if (!e.repeat) handleTap();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleTap]);

  const summary = session ? summarizeResults(session.results) : null;
  const phase = session?.phase ?? "idle";
  const lastResult =
    session && session.results.length > 0 ? session.results[session.results.length - 1] : null;

  const btn: React.CSSProperties = {
    padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.06)", color: "inherit", cursor: "pointer", fontWeight: 700, minHeight: 44, touchAction: "manipulation",
  };
  const activeBtn: React.CSSProperties = { ...btn, background: "#3fae5a", color: "#06130a", borderColor: "#3fae5a" };

  let areaBg = "rgba(255,255,255,0.05)";
  let areaText = "タップしてスタート（全5回計測）";
  let areaSub = "赤くなったら待って、緑になった瞬間にタップ";
  if (session) {
    if (phase === "waiting") {
      areaBg = "#a3271e";
      areaText = "待て…";
      areaSub = "緑になるまで絶対にタップしない";
    } else if (phase === "ready") {
      areaBg = "#2e9e4f";
      areaText = "今！タップ！";
      areaSub = "";
    } else if (phase === "tooSoon") {
      areaBg = "#6b5410";
      areaText = "フライング！早すぎます";
      areaSub = `フライング ${session.fouls} 回目 ・ タップでもう一度このラウンドに挑戦`;
    } else if (phase === "idle") {
      areaBg = "rgba(255,255,255,0.08)";
      areaText = `${lastResult} ms`;
      areaSub = `タップで ${session.round + 1} 回目の計測へ（あと ${session.rounds - session.round} 回）`;
    } else if (phase === "done") {
      areaBg = "#274b8f";
      areaText = `平均 ${summary?.averageMs} ms`;
      areaSub = "タップでもう一度計測する";
    }
  }

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>反応速度</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>反応速度</h1>
        <p className="muted">緑になった瞬間にどれだけ速く反応できるか。5回計測して平均で競います。フライングするとそのラウンドはやり直しです。</p>
      </div>

      <p className="classic-status" role="status">
        {session
          ? `計測 ${session.round} / ${session.rounds} 回 ・ ベスト平均 ${best > 0 ? `${best} ms` : "—"}`
          : `ベスト平均 ${best > 0 ? `${best} ms` : "—"} ・ まだ計測していません`}
      </p>

      <button
        type="button"
        onPointerDown={(e) => {
          e.preventDefault();
          handleTap();
        }}
        aria-label="反応速度の計測エリア"
        style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8,
          width: "100%", maxWidth: 520, margin: "0 auto", minHeight: 260,
          borderRadius: 16, border: "2px solid rgba(255,255,255,0.15)",
          background: areaBg, color: "#fff", cursor: "pointer",
          touchAction: "manipulation", userSelect: "none", WebkitTapHighlightColor: "transparent",
          transition: "background 0.08s",
        }}
      >
        <span style={{ fontSize: "clamp(28px, 7vw, 44px)", fontWeight: 800 }}>{areaText}</span>
        {areaSub ? <span style={{ fontSize: 14, opacity: 0.85 }}>{areaSub}</span> : null}
      </button>

      {session && session.results.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 14 }} aria-label="各回の結果">
          {session.results.map((ms, i) => (
            <span
              key={i}
              className="juice-pop"
              style={{ padding: "6px 10px", borderRadius: 999, background: "rgba(255,255,255,0.08)", fontWeight: 700, fontSize: 14 }}
            >
              {i + 1}回目 {ms} ms
            </span>
          ))}
          {Array.from({ length: session.rounds - session.results.length }, (_, i) => (
            <span
              key={`rest-${i}`}
              style={{ padding: "6px 10px", borderRadius: 999, border: "1px dashed rgba(255,255,255,0.3)", fontSize: 14, opacity: 0.6 }}
            >
              {session.results.length + i + 1}回目 —
            </span>
          ))}
        </div>
      )}

      {session && phase === "done" && summary && (
        <div style={{ maxWidth: 520, margin: "16px auto 0" }}>
          <EndScreen
            outcome="finish"
            title={`評価「${gradeForAverage(summary.averageMs)}」`}
            score={summary.averageMs}
            scoreLabel="平均（ms）"
            newBest={isNewBest}
            previousBest={isNewBest ? null : prevBestAtDone}
            onRetry={startSession}
          >
            <p className="muted">
              最速 {summary.bestMs} ms ・ 最遅 {summary.worstMs} ms
              {session.fouls > 0 ? ` ・ フライング ${session.fouls} 回` : ""}
            </p>
          </EndScreen>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 16 }}>
        <button type="button" style={session && phase !== "done" ? btn : activeBtn} onClick={startSession}>
          {session ? "もう一度" : "計測スタート"}
        </button>
      </div>
      <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
        エリアをタップ / クリック、またはスペースキーで反応。緑になる前に押すとフライングです。
      </p>
    </>
  );
}
