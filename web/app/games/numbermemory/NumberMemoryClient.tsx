"use client";
// 数字記憶。ロジックは lib/numbermemory.ts。
// 表示された数字を覚えて入力し、正解するたびに桁数が増える。
// ベスト桁数は localStorage に保存する。サーバーへ送信しない。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  NM_START_DIGITS,
  createNumberMemoryGame,
  showDurationMs,
  submitNumberAnswer,
  type NmState,
} from "@/lib/numbermemory";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-numbermemory-best";

type Phase = "ready" | "showing" | "input" | "correct" | "failed";

function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function saveBest(digits: number) {
  if (digits <= loadBest()) return;
  try {
    localStorage.setItem(BEST_KEY, String(digits));
  } catch {
    /* 保存できなくても遊べる */
  }
}

const mainBtn: React.CSSProperties = {
  padding: "12px 28px",
  borderRadius: 999,
  border: "1px solid #8a90a3",
  background: "#22304f",
  color: "#fff",
  fontSize: 17,
  fontWeight: 700,
  cursor: "pointer",
  minHeight: 48,
};

export default function NumberMemoryClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<NmState>(() => createNumberMemoryGame(Date.now() % 2147483647));
  const [phase, setPhase] = useState<Phase>("ready");
  const [input, setInput] = useState("");
  const [best, setBest] = useState(0);
  const [progress, setProgress] = useState(1);
  const timersRef = useRef<number[]>([]);
  const rafRef = useRef(0);

  useEffect(() => {
    setBest(loadBest());
    return () => {
      timersRef.current.forEach((id) => window.clearTimeout(id));
      timersRef.current = [];
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
    cancelAnimationFrame(rafRef.current);
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    timersRef.current.push(id);
  }, []);

  const showNumber = useCallback(
    (s: NmState) => {
      setPhase("showing");
      setProgress(1);
      const duration = showDurationMs(s.digits);
      const started = Date.now();
      const tick = () => {
        const remain = 1 - (Date.now() - started) / duration;
        setProgress(Math.max(0, remain));
        if (remain > 0) rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      later(() => {
        cancelAnimationFrame(rafRef.current);
        setInput("");
        setPhase("input");
      }, duration);
    },
    [later],
  );

  const start = useCallback(() => {
    clearTimers();
    const s = createNumberMemoryGame(Date.now() % 2147483647);
    setState(s);
    showNumber(s);
  }, [clearTimers, showNumber]);

  const submit = useCallback(() => {
    if (phase !== "input") return;
    const { state: next, correct } = submitNumberAnswer(state, input);
    setState(next);
    if (correct) {
      saveBest(next.bestDigits);
      setBest(loadBest());
      setPhase("correct");
      later(() => showNumber(next), 1100);
    } else {
      setPhase("failed");
    }
  }, [phase, state, input, later, showNumber]);

  const bigNumberStyle: React.CSSProperties = {
    fontSize: "min(13vw, 64px)",
    fontWeight: 900,
    letterSpacing: "0.12em",
    textAlign: "center",
    padding: "28px 8px",
    userSelect: "none",
    wordBreak: "break-all",
  };

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>数字記憶</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>数字記憶</h1>
        <p className="muted">
          一瞬だけ表示される数字を覚えて入力する記憶ゲーム。
          正解するたびに桁数が1つ増えていきます。何桁まで覚えられるか挑戦しよう。
        </p>
      </div>

      <p className="classic-status" role="status">
        {phase === "ready" && <>ベスト {best} 桁 ・ 最初は {NM_START_DIGITS} 桁から</>}
        {phase === "showing" && <>{state.digits} 桁の数字を覚えて…</>}
        {phase === "input" && <>{state.digits} 桁の数字を入力してください</>}
        {phase === "correct" && <>正解！ 次は {state.digits} 桁です</>}
        {phase === "failed" && (
          <>
            残念、正解は {state.number} でした。記録は {state.bestDigits} 桁
            （ベスト {Math.max(best, state.bestDigits)} 桁）
          </>
        )}
      </p>

      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        {phase === "showing" && (
          <>
            <div style={bigNumberStyle} aria-label={`${state.digits}桁の数字`}>
              {state.number}
            </div>
            <div
              aria-hidden="true"
              style={{ height: 8, borderRadius: 4, background: "#2a3350", overflow: "hidden" }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${progress * 100}%`,
                  background: "#f2b33d",
                }}
              />
            </div>
          </>
        )}

        {phase === "input" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            style={{ display: "grid", gap: 12, padding: "20px 0" }}
          >
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              aria-label="覚えた数字"
              value={input}
              onChange={(e) => setInput(e.target.value.replace(/[^0-9]/g, "").slice(0, 30))}
              placeholder={"0".repeat(state.digits)}
              style={{
                fontSize: 32,
                fontWeight: 700,
                letterSpacing: "0.12em",
                textAlign: "center",
                padding: "12px",
                borderRadius: 10,
                border: "1px solid #8a90a3",
                background: "#141b2e",
                color: "#fff",
                width: "100%",
                boxSizing: "border-box",
              }}
            />
            <button type="submit" style={mainBtn} disabled={input.length === 0}>
              回答する
            </button>
          </form>
        )}

        {phase === "correct" && (
          <div style={{ ...bigNumberStyle, color: "#2e9e4f" }}>✓</div>
        )}

        {phase === "failed" && (
          <div style={{ ...bigNumberStyle, fontSize: "min(10vw, 44px)" }}>{state.number}</div>
        )}
      </div>

      <div className="classic-controls" style={{ marginTop: 16 }}>
        {(phase === "ready" || phase === "failed") && (
          <button type="button" style={mainBtn} onClick={start}>
            {phase === "failed" ? "もう一度" : "スタート"}
          </button>
        )}
      </div>
    </>
  );
}
