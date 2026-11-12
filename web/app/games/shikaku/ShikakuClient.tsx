"use client";
// しかく（四角に切れ）。ロジックは lib/shikaku.ts（解を先に作る生成で必ず解ける）。
// マスをタップして始点を決め、もう一度タップしたマスまでを長方形にする。
// 既にある長方形のマスをタップすると、その長方形を取り除く。端末内で完結する。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  applyShikakuRect,
  coveredCount,
  createShikakuGame,
  isShikakuComplete,
  rectIndexAt,
  removeShikakuRectAt,
  shikakuViolations,
  type ShikakuSize,
  type ShikakuState,
  type ShikakuViolation,
} from "@/lib/shikaku";
import { sfxCorrect, sfxPlace, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const SIZES: { key: ShikakuSize; label: string }[] = [
  { key: 5, label: "5×5" },
  { key: 6, label: "6×6" },
];

const RECT_COLORS = [
  "rgba(226, 83, 74, 0.20)",
  "rgba(67, 163, 92, 0.22)",
  "rgba(51, 102, 204, 0.20)",
  "rgba(242, 176, 30, 0.25)",
  "rgba(147, 51, 234, 0.18)",
  "rgba(8, 145, 178, 0.20)",
  "rgba(219, 39, 119, 0.16)",
  "rgba(90, 140, 40, 0.22)",
  "rgba(230, 120, 40, 0.22)",
  "rgba(60, 110, 200, 0.16)",
];

function newGame(size: ShikakuSize): ShikakuState {
  return createShikakuGame(size, Date.now() % 2147483647);
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

export default function ShikakuClient() {
  const { prefix } = useGamesNav();
  const [size, setSize] = useState<ShikakuSize>(5);
  const [state, setState] = useState<ShikakuState>(() => newGame(5));
  const [anchor, setAnchor] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [checkResult, setCheckResult] = useState<ShikakuViolation[] | null>(null);

  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(`ago-shikaku-best-${size}`));
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
      window.localStorage.setItem(`ago-shikaku-best-${size}`, String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best, size]);

  // 勝利への遷移で1回だけジングルを鳴らし、その時点のベストと比較した結果を保持する。
  const prevStatusRef = useRef(state.status);
  const [winResult, setWinResult] = useState<{ newBest: boolean; prevBest: number | null } | null>(null);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (state.status === "won" && prev !== "won") {
      sfxWin();
      setWinResult({ newBest: best === null || seconds < best, prevBest: best });
    }
  }, [state.status, seconds, best]);

  const restart = (nextSize: ShikakuSize) => {
    setSize(nextSize);
    setState(newGame(nextSize));
    setAnchor(null);
    setSeconds(0);
    setCheckResult(null);
    setWinResult(null);
  };

  const onCell = (index: number) => {
    if (state.status === "won") return;
    setCheckResult(null);
    if (anchor === null) {
      if (rectIndexAt(state, index) >= 0) {
        sfxTap();
        setState((s) => removeShikakuRectAt(s, index));
      } else {
        sfxTap();
        setAnchor(index);
      }
      return;
    }
    if (index === anchor) {
      // 数字 1 のマスは 1×1 の長方形として確定する（それ以外は従来どおり取り消し）。
      if (state.clues[anchor] === 1) {
        sfxPlace();
        const r = Math.floor(anchor / state.size);
        const c = anchor % state.size;
        setState((s) => applyShikakuRect(s, { r1: r, c1: c, r2: r, c2: c }));
      } else {
        sfxTap();
      }
      setAnchor(null);
      return;
    }
    sfxPlace();
    const r1 = Math.floor(anchor / state.size);
    const c1 = anchor % state.size;
    const r2 = Math.floor(index / state.size);
    const c2 = index % state.size;
    setState((s) => applyShikakuRect(s, { r1, c1, r2, c2 }));
    setAnchor(null);
  };

  const onCheck = () => {
    if (isShikakuComplete(state)) {
      sfxCorrect();
      setCheckResult([]);
      return;
    }
    const violations = shikakuViolations(state);
    if (violations.length === 0) {
      sfxCorrect();
    } else {
      sfxWrong();
    }
    setCheckResult(violations);
  };

  const violationCells = new Set((checkResult ?? []).flatMap((v) => v.cells));
  const covered = coveredCount(state);
  const total = state.size * state.size;

  const statusText =
    state.status === "won"
      ? `完成！ ${formatTime(seconds)}でクリアです。`
      : checkResult !== null
        ? checkResult.length === 0
          ? covered === total
            ? "ルール違反はありません。"
            : `ルール違反はありません。あと ${total - covered} マスです。`
          : `違反が ${checkResult.length} 件あります: ${checkResult[0].message}`
        : anchor !== null
          ? state.clues[anchor] === 1
            ? "数字 1 のマスです。もう一度タップすると 1×1 の四角として確定します。"
            : "長方形の反対側の角をタップ。始点をもう一度タップすると取り消します。"
          : "マスをタップして始点を決め、もう一つの角で長方形を描きます。長方形のマスをタップすると消せます。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>しかく</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>しかく</h1>
        <p className="muted">
          角のマスを2回タップして長方形を描き、盤面を埋めます。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="サイズと操作">
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
        <button type="button" className="classic-btn" onClick={onCheck}>
          チェック
        </button>
      </div>

      <p className="classic-status" role="status">
        埋めたマス {covered} / {total} ・ {seconds} 秒
        {best !== null ? ` ・ ベスト ${formatTime(best)}` : ""} ・ {statusText}
      </p>

      <div
        role="grid"
        aria-label="しかくの盤"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${state.size}, minmax(0, 1fr))`,
          gap: 3,
          width: "100%",
          maxWidth: 460,
          margin: "0 auto",
        }}
      >
        {state.clues.map((clue, i) => {
          const ri = rectIndexAt(state, i);
          const rect = ri >= 0 ? state.rects[ri] : null;
          const r = Math.floor(i / state.size);
          const c = i % state.size;
          const isAnchor = anchor === i;
          const isViolation = violationCells.has(i);
          const edge = rect
            ? {
                borderTop: r === rect.r1 ? "2px solid #555" : "2px solid transparent",
                borderBottom: r === rect.r2 ? "2px solid #555" : "2px solid transparent",
                borderLeft: c === rect.c1 ? "2px solid #555" : "2px solid transparent",
                borderRight: c === rect.c2 ? "2px solid #555" : "2px solid transparent",
              }
            : {};
          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              aria-label={
                clue !== null
                  ? `数字 ${clue} のマス`
                  : ri >= 0
                    ? "長方形の中のマス"
                    : "空きマス"
              }
              className={
                isViolation ? "juice-shake" : isAnchor ? "juice-pulse" : rect ? "juice-pop" : undefined
              }
              onClick={() => onCell(i)}
              style={{
                aspectRatio: "1",
                minHeight: 44,
                borderRadius: 4,
                background: isViolation
                  ? "rgba(226, 83, 74, 0.45)"
                  : rect
                    ? RECT_COLORS[ri % RECT_COLORS.length]
                    : "#fff",
                ...edge,
                border: isAnchor ? "2px solid #e2534a" : undefined,
                boxShadow: isAnchor ? "0 0 0 2px #e2534a inset" : undefined,
                fontWeight: clue !== null ? 700 : 400,
                fontSize: 17,
                cursor: "pointer",
                color: "inherit",
              }}
            >
              {clue !== null ? clue : ""}
            </button>
          );
        })}
      </div>

      {state.status === "won" ? (
        <EndScreen
          outcome="win"
          score={seconds}
          scoreLabel="クリアタイム（秒）"
          newBest={winResult?.newBest}
          previousBest={winResult && !winResult.newBest ? winResult.prevBest : undefined}
          onRetry={() => restart(size)}
        >
          <p className="muted">
            {size}×{size} ・ 手数 {state.moves}
          </p>
        </EndScreen>
      ) : null}
    </>
  );
}
