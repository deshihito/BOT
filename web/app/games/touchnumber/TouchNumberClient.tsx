"use client";
// タッチザナンバー。ロジックは lib/touchnumber.ts。
// 1から順にタップし、ミス1回につき+3秒のペナルティでタイムを競う。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createTouchGame, isCleared, tapCell, touchColumns, type TouchState } from "@/lib/touchnumber";
import { useGamesNav } from "../GamesShell";

const PENALTY_SEC = 3;
const SIZES = [25, 50] as const;

export default function TouchNumberClient() {
  const { prefix } = useGamesNav();
  const [size, setSize] = useState<number>(25);
  const [state, setState] = useState<TouchState>(() => createTouchGame(25, Date.now() % 2147483647));
  const [elapsed, setElapsed] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const startRef = useRef<number | null>(null);

  const started = state.taps > 0;
  const totalSec = elapsed + state.misses * PENALTY_SEC;

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(`ago-touchnumber-best-${size}`));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, [size]);

  useEffect(() => {
    if (!started || state.status === "won") return;
    const id = setInterval(() => {
      if (startRef.current !== null) setElapsed((Date.now() - startRef.current) / 1000);
    }, 100);
    return () => clearInterval(id);
  }, [started, state.status]);

  useEffect(() => {
    if (state.status !== "won") return;
    const total = elapsed + state.misses * PENALTY_SEC;
    if (best !== null && total >= best) return;
    setBest(total);
    try {
      window.localStorage.setItem(`ago-touchnumber-best-${size}`, String(total));
    } catch {
      /* プレイに影響しない */
    }
  }, [state.status, elapsed, state.misses, best, size]);

  const restart = (nextSize: number) => {
    setSize(nextSize);
    setState(createTouchGame(nextSize, Date.now() % 2147483647));
    setElapsed(0);
    startRef.current = null;
  };

  const onTap = (index: number) => {
    if (state.status !== "playing") return;
    if (startRef.current === null) startRef.current = Date.now();
    setState((s) => tapCell(s, index));
  };

  const cols = touchColumns(size);

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>タッチザナンバー</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>タッチザナンバー</h1>
        <p className="muted">最初のタップで計測が始まります。次に押す数字は金色の枠で示されます。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="サイズ">
        {SIZES.map((s) => (
          <button
            key={s}
            type="button"
            className={size === s ? "classic-btn classic-btn-active" : "classic-btn"}
            aria-pressed={size === s}
            onClick={() => restart(s)}
          >
            1〜{s}
          </button>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(size)}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        次は {state.status === "won" ? "—" : state.next} ・ {totalSec.toFixed(1)} 秒（ミス {state.misses} 回）
        {best !== null ? ` ・ ベスト ${best.toFixed(1)} 秒` : ""}
        {state.status === "won" ? ` ・ クリア！記録は ${totalSec.toFixed(1)} 秒です。` : ""}
      </p>

      <div
        role="grid"
        aria-label="数字の盤"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gap: 6,
          maxWidth: 420,
          margin: "0 auto",
        }}
      >
        {state.board.map((value, i) => {
          const cleared = isCleared(state, i);
          const isNext = value === state.next && state.status === "playing";
          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              disabled={cleared}
              onClick={() => onTap(i)}
              aria-label={`数字 ${value}`}
              style={{
                minHeight: size === 50 ? 40 : 52,
                fontSize: size === 50 ? 15 : 18,
                fontWeight: 700,
                borderRadius: 10,
                border: isNext ? "2px solid #d9a41c" : "1px solid #d8d8d8",
                background: cleared ? "#e5e7eb" : "#fffdf6",
                color: cleared ? "#9ca3af" : "#22252a",
                opacity: cleared ? 0.55 : 1,
                cursor: cleared ? "default" : "pointer",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {value}
            </button>
          );
        })}
      </div>
    </>
  );
}
