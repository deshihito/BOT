"use client";
// クイーン配置（Nクイーン）。ロジックは lib/queens.ts。
// マスをタップしてクイーンを置く／外す。利き筋と利き合うペアを色で知らせる。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  attackedSquares,
  conflictingQueens,
  createQueensGame,
  toggleQueen,
  type QnState,
} from "@/lib/queens";
import { sfxPlace, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const SIZES = [
  { key: 6, label: "6×6（6個）" },
  { key: 8, label: "8×8（8個）" },
] as const;

type SizeKey = (typeof SIZES)[number]["key"];

function newGame(size: SizeKey): QnState {
  return createQueensGame(size, Date.now() % 2147483647);
}

export default function QueensClient() {
  const { prefix } = useGamesNav();
  const [size, setSize] = useState<SizeKey>(8);
  const [state, setState] = useState<QnState>(() => newGame(8));
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [resultNewBest, setResultNewBest] = useState(false);
  const [resultPrevBest, setResultPrevBest] = useState<number | null>(null);
  const prevStatusRef = useRef(state.status);

  // 終局遷移の瞬間だけジングルを鳴らし、その時点（保存前）のベストで更新判定を控える。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev === state.status || state.status !== "won") return;
    const isNew = seconds > 0 && (best === null || seconds < best);
    setResultNewBest(isNew);
    setResultPrevBest(isNew ? null : best);
    sfxWin();
  }, [state.status, seconds, best]);

  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(`ago-queens-best-${size}`));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, [size]);

  useEffect(() => {
    if (state.status !== "won" || seconds <= 0) return;
    if (best !== null && seconds >= best) return;
    setBest(seconds);
    try {
      window.localStorage.setItem(`ago-queens-best-${size}`, String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best, size]);

  const restart = (next: SizeKey) => {
    setSize(next);
    setState(newGame(next));
    setSeconds(0);
    setResultNewBest(false);
    setResultPrevBest(null);
  };

  const handleCell = (i: number) => {
    const next = toggleQueen(state, i);
    if (next !== state && next.status !== "won") {
      if (next.queens.includes(i)) sfxPlace();
      else sfxTap();
    }
    setState(next);
  };

  const conflicts = useMemo(() => new Set(conflictingQueens(state)), [state]);
  const attacked = useMemo(() => new Set(attackedSquares(state)), [state]);
  const own = useMemo(() => new Set(state.queens), [state]);

  const statusText =
    state.status === "won"
      ? "利き合わない配置が完成！クリアです。"
      : state.queens.length >= state.size
        ? `あと少し。${state.size}個置けましたが、まだ利き合うペアがあります。`
        : conflicts.size > 0
          ? "赤いクイーン同士が利き合っています。どちらかを動かそう。"
          : "薄く色づいたマスは、どこかのクイーンの利き筋です。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>クイーン配置</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>クイーン配置</h1>
        <p className="muted">マスをタップしてクイーンを置いたり外したりします。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="盤の大きさ">
        {SIZES.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-pressed={size === s.key}
            className={size === s.key ? "classic-btn classic-btn-active" : "classic-btn"}
            onClick={() => restart(s.key)}
          >
            {s.label}
          </button>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(size)}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {state.queens.length} / {state.size} 個 ・ {seconds} 秒
        {best !== null ? ` ・ ベスト ${best} 秒` : ""} ・ {statusText}
      </p>

      <div
        role="grid"
        aria-label="クイーン配置の盤"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${state.size}, minmax(0, 1fr))`,
          gap: 3,
          maxWidth: 480,
          margin: "0 auto",
        }}
      >
        {Array.from({ length: state.size * state.size }, (_, i) => {
          const r = Math.floor(i / state.size);
          const c = i % state.size;
          const dark = (r + c) % 2 === 1;
          const has = own.has(i);
          const bad = conflicts.has(i);
          const underAttack = attacked.has(i);
          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              aria-pressed={has}
              aria-label={
                has
                  ? bad
                    ? "クイーン（他のクイーンと利き合っています）"
                    : "クイーン"
                  : underAttack
                    ? "利き筋のマス"
                    : "空きマス"
              }
              className={bad ? "juice-shake" : has ? "juice-pop" : undefined}
              onClick={() => handleCell(i)}
              style={{
                aspectRatio: "1",
                borderRadius: 6,
                border: bad ? "3px solid #c0392b" : "1px solid var(--line)",
                background: bad
                  ? "#f3c1bb"
                  : has
                    ? "var(--accent-soft)"
                    : underAttack
                      ? dark
                        ? "#cbb98f"
                        : "#e3d5ac"
                      : dark
                        ? "#8a9a7b"
                        : "#e6e2d3",
                fontSize: state.size === 8 ? 20 : 26,
                lineHeight: 1,
                cursor: "pointer",
                minHeight: 40,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {has ? "♛" : ""}
            </button>
          );
        })}
      </div>

      {state.status === "won" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen
            outcome="win"
            title="配置が完成！"
            score={seconds}
            scoreLabel="クリアタイム（秒）"
            newBest={resultNewBest}
            previousBest={resultPrevBest}
            onRetry={() => restart(size)}
          >
            <p className="muted">
              {state.size} 個のクイーンが1つも利き合わない配置になりました。
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
