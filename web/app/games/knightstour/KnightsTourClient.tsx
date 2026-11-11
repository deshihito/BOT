"use client";
// ナイトツアー。ロジックは lib/knightstour.ts（完全ツアーを構成済みで必ず解ける）。
// 光っているマスをタップしてナイトを進める。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  createKnightsTour,
  legalMoves,
  moveKnight,
  undoMove,
  visitOrder,
  type KtState,
} from "@/lib/knightstour";
import { useGamesNav } from "../GamesShell";

const SIZES = [
  { key: 5, label: "5×5" },
  { key: 6, label: "6×6" },
] as const;

type SizeKey = (typeof SIZES)[number]["key"];

function newGame(size: SizeKey): KtState {
  return createKnightsTour(size, Date.now() % 2147483647);
}

export default function KnightsTourClient() {
  const { prefix } = useGamesNav();
  const [size, setSize] = useState<SizeKey>(5);
  const [state, setState] = useState<KtState>(() => newGame(5));
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    if (state.status !== "playing" || state.path.length <= 1) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status, state.path.length]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(`ago-knightstour-best-${size}`));
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
      window.localStorage.setItem(`ago-knightstour-best-${size}`, String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best, size]);

  const restart = (next: SizeKey) => {
    setSize(next);
    setState(newGame(next));
    setSeconds(0);
  };

  const order = visitOrder(state);
  const moves = state.status === "playing" || state.status === "stuck" ? legalMoves(state) : [];
  const head = state.path[state.path.length - 1];
  const total = state.size * state.size;

  const statusText =
    state.status === "won"
      ? "全マスを巡回できた！クリアです。"
      : state.status === "stuck"
        ? "行き詰まってしまった。1手戻して別の道を試そう。"
        : state.path.length <= 1
          ? "♞ のあるマスがスタートです。"
          : "光っているマスが次に進める場所です。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ナイトツアー</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ナイトツアー</h1>
        <p className="muted">光っているマスをタップして、ナイトを進めます。</p>
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
        <button
          type="button"
          className="classic-btn"
          disabled={state.path.length <= 1}
          onClick={() => setState((s) => undoMove(s))}
        >
          1手戻す
        </button>
      </div>

      <p className="classic-status" role="status">
        {state.path.length} / {total} マス ・ {seconds} 秒
        {best !== null ? ` ・ ベスト ${best} 秒` : ""} ・ {statusText}
      </p>

      <div
        role="grid"
        aria-label="ナイトツアーの盤"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${state.size}, minmax(0, 1fr))`,
          gap: 4,
          maxWidth: 460,
          margin: "0 auto",
        }}
      >
        {order.map((step, i) => {
          const r = Math.floor(i / state.size);
          const c = i % state.size;
          const dark = (r + c) % 2 === 1;
          const isHead = i === head;
          const isMove = moves.includes(i);
          const visited = step > 0;
          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              disabled={!isMove}
              aria-label={
                isHead
                  ? `現在位置（${step}手目）`
                  : visited
                    ? `${step}手目に訪れたマス`
                    : isMove
                      ? "次に進めるマス"
                      : "未訪問のマス"
              }
              onClick={() => setState((s) => moveKnight(s, i))}
              style={{
                aspectRatio: "1",
                borderRadius: 8,
                border: isHead ? "3px solid var(--accent)" : "1px solid var(--line)",
                background: isMove
                  ? "var(--accent-soft)"
                  : visited
                    ? dark
                      ? "#b8a888"
                      : "#d8cbb0"
                    : dark
                      ? "#8a9a7b"
                      : "#e6e2d3",
                color: "#33302a",
                fontSize: state.size === 6 ? 15 : 18,
                fontWeight: isHead ? 800 : 600,
                cursor: isMove ? "pointer" : "default",
                minHeight: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {isHead ? "♞" : visited ? step : isMove ? "・" : ""}
            </button>
          );
        })}
      </div>
    </>
  );
}
