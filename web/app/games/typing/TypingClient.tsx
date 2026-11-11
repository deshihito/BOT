"use client";
// タイピング（60秒計測）。ロジックは lib/typing.ts。
// 初めの1文字で計測開始、60秒経過か課題文の打ち切りで終了する。
// ベスト WPM は localStorage（ago-typing-best）に端末内だけ保存する。
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  createTypingText,
  evaluateTyping,
  isTypingComplete,
  type TypingResult,
} from "@/lib/typing";
import { useGamesNav } from "../GamesShell";

const DURATION_SECONDS = 60;
const BEST_KEY = "ago-typing-best";

type Phase = "ready" | "running" | "done";

export default function TypingClient() {
  const { prefix } = useGamesNav();
  const [prompt, setPrompt] = useState<string>(() => createTypingText(Date.now() % 2147483647));
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<Phase>("ready");
  const [timeLeft, setTimeLeft] = useState(DURATION_SECONDS);
  const [result, setResult] = useState<TypingResult | null>(null);
  const [best, setBest] = useState<number | null>(null);
  const [isNewBest, setIsNewBest] = useState(false);
  const startRef = useRef<number | null>(null);
  const typedRef = useRef("");
  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(BEST_KEY);
      if (saved !== null) {
        const value = Number(saved);
        if (Number.isFinite(value) && value >= 0) setBest(value);
      }
    } catch {
      // 保存が使えなくてもゲームは続けられる
    }
  }, []);

  const finish = (finalTyped: string, elapsedSeconds: number) => {
    const r = evaluateTyping(promptRef.current, finalTyped, elapsedSeconds);
    setResult(r);
    setPhase("done");
    setTimeLeft(Math.max(0, DURATION_SECONDS - Math.ceil(elapsedSeconds)));
    setBest((prev) => {
      if (prev === null || r.wpm > prev) {
        setIsNewBest(r.wpm > 0);
        try {
          window.localStorage.setItem(BEST_KEY, String(r.wpm));
        } catch {
          // 保存できなくても結果表示は行う
        }
        return r.wpm;
      }
      return prev;
    });
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    if (phase !== "running") return;
    const id = setInterval(() => {
      if (startRef.current === null) return;
      const elapsed = (Date.now() - startRef.current) / 1000;
      const remaining = DURATION_SECONDS - elapsed;
      if (remaining <= 0) {
        clearInterval(id);
        finishRef.current(typedRef.current, DURATION_SECONDS);
      } else {
        setTimeLeft(Math.ceil(remaining));
      }
    }, 100);
    return () => clearInterval(id);
  }, [phase]);

  const handleChange = (value: string) => {
    if (phase === "done") return;
    const cleaned = value.replace(/[\r\n]+/g, " ").slice(0, prompt.length);
    if (phase === "ready" && cleaned.length > 0) {
      startRef.current = Date.now();
      setPhase("running");
    }
    typedRef.current = cleaned;
    setTyped(cleaned);
    if (isTypingComplete(prompt, cleaned) && startRef.current !== null) {
      const elapsed = Math.max(0.1, (Date.now() - startRef.current) / 1000);
      finish(cleaned, elapsed);
    }
  };

  const restart = () => {
    const next = createTypingText(Date.now() % 2147483647);
    setPrompt(next);
    promptRef.current = next;
    setTyped("");
    typedRef.current = "";
    setPhase("ready");
    setTimeLeft(DURATION_SECONDS);
    setResult(null);
    setIsNewBest(false);
    startRef.current = null;
  };

  const liveElapsed =
    phase === "running"
      ? DURATION_SECONDS - timeLeft
      : phase === "done" && result
        ? DURATION_SECONDS - timeLeft
        : 0;
  const live = phase !== "ready" ? evaluateTyping(prompt, typed, Math.max(liveElapsed, 0.1)) : null;

  const charStyle = (index: number): CSSProperties => {
    if (index < typed.length) {
      return typed[index] === prompt[index]
        ? { color: "#15803d" }
        : { color: "#b91c1c", background: "#fee2e2" };
    }
    if (index === typed.length && phase !== "done") {
      return { borderBottom: "2px solid #111827" };
    }
    return { color: "#4b5563" };
  };

  const btnStyle: CSSProperties = {
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid #9ca3af",
    background: "#ffffff",
    color: "#1f2937",
    fontSize: 14,
    cursor: "pointer",
  };

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>タイピング</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>タイピング</h1>
        <p className="muted">
          英文を60秒でどれだけ正確に打てるかを測ります。入力を始めると計測スタートです。
        </p>
      </div>

      <p className="classic-status" role="status">
        残り {timeLeft} 秒
        {live ? ` ・ 現在 ${live.wpm} WPM ・ 正確率 ${live.accuracy}%` : ""}
        {best !== null ? ` ・ ベスト ${best} WPM` : ""}
        {phase === "ready" ? " ・ 入力欄に打ち始めると始まります" : ""}
      </p>

      <div
        aria-label="課題文"
        style={{
          maxWidth: 640,
          margin: "12px auto",
          padding: "16px",
          border: "1px solid #d1d5db",
          borderRadius: 10,
          background: "#f9fafb",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "clamp(16px, 3.4vw, 20px)",
          lineHeight: 1.8,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          userSelect: "none",
        }}
      >
        {prompt.split("").map((ch, i) => (
          <span key={i} style={charStyle(i)}>
            {ch}
          </span>
        ))}
      </div>

      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <div
          style={{
            height: 8,
            borderRadius: 4,
            background: "#e5e7eb",
            overflow: "hidden",
            marginBottom: 12,
          }}
          aria-hidden="true"
        >
          <div
            style={{
              height: "100%",
              width: `${(timeLeft / DURATION_SECONDS) * 100}%`,
              background: timeLeft <= 10 ? "#dc2626" : "#2563eb",
              transition: "width 0.2s linear",
            }}
          />
        </div>

        <label htmlFor="typing-input" style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
          ここに入力
        </label>
        <textarea
          id="typing-input"
          value={typed}
          onChange={(e) => handleChange(e.target.value)}
          onPaste={(e) => e.preventDefault()}
          disabled={phase === "done"}
          rows={3}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Type here to start…"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "12px",
            borderRadius: 10,
            border: "1px solid #9ca3af",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 17,
            lineHeight: 1.6,
            resize: "vertical",
          }}
        />
      </div>

      {phase === "done" && result ? (
        <div
          role="status"
          style={{
            maxWidth: 640,
            margin: "16px auto 0",
            padding: "16px",
            border: "1px solid #d1d5db",
            borderRadius: 10,
            textAlign: "center",
          }}
        >
          <p style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>
            結果: {result.wpm} WPM{isNewBest ? " ・ ベスト更新！" : ""}
          </p>
          <p style={{ margin: 0 }}>
            正確率 {result.accuracy}% ・ 打鍵数 {result.totalChars}（正解 {result.correctChars} / ミス{" "}
            {result.incorrectChars}）{best !== null ? ` ・ ベスト ${best} WPM` : ""}
          </p>
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
        <button type="button" style={btnStyle} onClick={restart}>
          別の課題でもう一度
        </button>
      </div>
    </>
  );
}
