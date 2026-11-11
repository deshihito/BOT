"use client";
// ストップウォッチチャレンジ。目標は 10.00 秒ぴったりで止めること。
// ブラインドモードでは 5 秒を過ぎると表示が隠れ、感覚だけが頼りになる。
// 端末内で完結し、ベスト誤差は localStorage の ago-stopwatch-best に保存する。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useGamesNav } from "../GamesShell";

const TARGET_MS = 10000;
const BLIND_FROM_MS = 5000;
const BEST_KEY = "ago-stopwatch-best";

type Phase = "idle" | "running" | "stopped";

function evaluate(absDiffMs: number): string {
  if (absDiffMs <= 10) return "完璧！ ほぼ誤差ゼロです";
  if (absDiffMs <= 30) return "神業級の精度です";
  if (absDiffMs <= 50) return "すごい！ あと少しで神業でした";
  if (absDiffMs <= 100) return "なかなか良い感覚です";
  if (absDiffMs <= 250) return "惜しい！ 体内時計を信じて";
  if (absDiffMs <= 500) return "あと少し。数え方を調整してみましょう";
  return "修行中。まずは10秒の感覚をつかみましょう";
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2);
}

export default function StopwatchClient() {
  const { prefix } = useGamesNav();
  const [phase, setPhase] = useState<Phase>("idle");
  const [displayMs, setDisplayMs] = useState(0);
  const [resultMs, setResultMs] = useState<number | null>(null);
  const [blind, setBlind] = useState(false);
  const [best, setBest] = useState<number | null>(null);
  const startRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      if (Number.isFinite(saved) && saved > 0) setBest(saved);
    } catch {
      // 保存できない環境ではベスト表示なしで続行する。
    }
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const start = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    startRef.current = performance.now();
    setResultMs(null);
    setDisplayMs(0);
    setPhase("running");
    const loop = () => {
      setDisplayMs(performance.now() - startRef.current);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  };

  const stop = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    const finalMs = performance.now() - startRef.current;
    setDisplayMs(finalMs);
    setResultMs(finalMs);
    setPhase("stopped");
    const absDiff = Math.abs(finalMs - TARGET_MS);
    if (best === null || absDiff < best) {
      setBest(absDiff);
      try {
        window.localStorage.setItem(BEST_KEY, String(absDiff));
      } catch {
        // 保存失敗はプレイに影響しない。
      }
    }
  };

  const diff = resultMs !== null ? resultMs - TARGET_MS : null;
  const blinded = blind && phase === "running" && displayMs >= BLIND_FROM_MS;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ストップウォッチ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ストップウォッチ</h1>
        <p className="muted">ちょうど10.00秒だと思ったところでストップ。誤差の小ささを競います。</p>
      </div>

      <div style={{ maxWidth: 480, margin: "0 auto", textAlign: "center" }}>
        <div
          aria-live="off"
          style={{
            fontSize: "clamp(56px, 16vw, 88px)",
            fontWeight: 800,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1.1,
            padding: "24px 0 8px",
            color: blinded ? "#9ca3af" : "inherit",
          }}
        >
          {blinded ? "??.??" : formatSeconds(displayMs)}
          <span style={{ fontSize: "0.35em", fontWeight: 700 }}> 秒</span>
        </div>
        <p className="muted" style={{ margin: "0 0 4px" }}>目標 10.00 秒{blind && phase === "running" ? " ・ 5秒から表示が隠れています" : ""}</p>
        <p className="muted" style={{ margin: "0 0 16px" }}>
          {best !== null ? `ベスト誤差 ${(best / 1000).toFixed(3)} 秒（${Math.round(best)}ミリ秒）` : "ベスト誤差はまだありません"}
        </p>

        {phase === "stopped" && diff !== null && resultMs !== null ? (
          <div
            role="status"
            style={{
              padding: "14px 16px",
              borderRadius: 12,
              border: "2px solid #c9b489",
              background: "#fffdf6",
              marginBottom: 16,
            }}
          >
            <p style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800 }}>
              結果 {formatSeconds(resultMs)} 秒 ・ 誤差 {diff >= 0 ? "+" : "−"}
              {(Math.abs(diff) / 1000).toFixed(3)} 秒（{diff >= 0 ? "遅い" : "早い"}）
            </p>
            <p style={{ margin: 0 }}>{evaluate(Math.abs(diff))}</p>
          </div>
        ) : null}

        <div className="classic-controls" style={{ justifyContent: "center" }}>
          {phase !== "running" ? (
            <button type="button" className="classic-btn classic-btn-active" onClick={start} style={{ minWidth: 160, minHeight: 52, fontSize: 17 }}>
              {phase === "stopped" ? "もう一度スタート" : "スタート"}
            </button>
          ) : (
            <button type="button" className="classic-btn classic-btn-active" onClick={stop} style={{ minWidth: 160, minHeight: 52, fontSize: 17 }}>
              ストップ！
            </button>
          )}
        </div>

        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            minHeight: 44,
            cursor: phase === "running" ? "default" : "pointer",
            opacity: phase === "running" ? 0.5 : 1,
          }}
        >
          <input type="checkbox" checked={blind} disabled={phase === "running"} onChange={(e) => setBlind(e.target.checked)} />
          ブラインドモード（5秒から表示を隠す）
        </label>
      </div>
    </>
  );
}
