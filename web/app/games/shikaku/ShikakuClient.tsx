"use client";
// しかく（四角に切れ）。ロジックは lib/shikaku.ts（解を先に作る生成で必ず解ける）。
// マスをタップして始点を決め、もう一度タップしたマスまでを長方形にする。
// 既にある長方形のマスをタップすると、その長方形を取り除く。端末内で完結する。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import {
  applyShikakuRect,
  cluesInRect,
  coveredCount,
  createShikakuGame,
  isShikakuComplete,
  nextShikakuHint,
  rectCells,
  rectIndexAt,
  removeShikakuRectAt,
  shikakuViolations,
  type ShikakuRect,
  type ShikakuSize,
  type ShikakuState,
  type ShikakuViolation,
} from "@/lib/shikaku";
import { sfxCorrect, sfxPlace, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const ShikakuScene3D = dynamic(() => import("./ShikakuScene3D"), { ssr: false });

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

/** 1ゲームで使えるヒントの回数（数独・ライツアウトと同じ作法）。 */
const HINT_LIMIT = 3;

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

export default function ShikakuClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [size, setSize] = useState<ShikakuSize>(5);
  const [state, setState] = useState<ShikakuState>(() => newGame(5));
  const [anchor, setAnchor] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [checkResult, setCheckResult] = useState<ShikakuViolation[] | null>(null);
  const [hintsUsed, setHintsUsed] = useState(0);
  const [hintRect, setHintRect] = useState<ShikakuRect | null>(null);

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
    setHintsUsed(0);
    setHintRect(null);
  };

  // 詰み救済のヒント: 解のうち未完成の長方形を1つだけ範囲で示す（自動では描かない）。
  const onHint = () => {
    if (state.status === "won" || hintsUsed >= HINT_LIMIT) return;
    const rect = nextShikakuHint(state);
    if (!rect) return;
    sfxTap();
    setCheckResult(null);
    setHintRect(rect);
    setHintsUsed((n) => n + 1);
  };

  const onCell = (index: number) => {
    if (state.status === "won") return;
    setCheckResult(null);
    setHintRect(null);
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

  // 3D のドラッグ確定。適用は onCell の2タップ目と同じ applyShikakuRect 経路。
  // 開始セルと終了セルが同じドラッグはタップとみなして onCell に委ねる。
  const handleDragRect = (startIndex: number, endIndex: number) => {
    if (state.status === "won") return;
    if (startIndex === endIndex) {
      onCell(startIndex);
      return;
    }
    setCheckResult(null);
    setHintRect(null);
    setAnchor(null);
    sfxPlace();
    const r1 = Math.floor(startIndex / state.size);
    const c1 = startIndex % state.size;
    const r2 = Math.floor(endIndex / state.size);
    const c2 = endIndex % state.size;
    setState((s) => applyShikakuRect(s, { r1, c1, r2, c2 }));
  };

  const onCheck = () => {
    setHintRect(null);
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

  // 盤面の下スワイプ = チェック。子のマスの onClick との二重発火は
  // useGesture の suppressClickAfterSwipe が抑止する（kenken / kakuro / tents と同じ）。
  const boardGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "down") onCheck();
    },
  });

  const violationCells = new Set((checkResult ?? []).flatMap((v) => v.cells));
  const hintCells = new Set(hintRect ? rectCells(hintRect, state.size) : []);
  const covered = coveredCount(state);
  const total = state.size * state.size;

  const statusText =
    state.status === "won"
      ? `完成！ ${formatTime(seconds)}でクリアです。`
      : hintRect !== null
        ? `ヒント: 数字 ${cluesInRect(state, hintRect)[0]?.value ?? ""} の四角は ${hintRect.r1 + 1}行目${hintRect.c1 + 1}列 〜 ${hintRect.r2 + 1}行目${hintRect.c2 + 1}列 の範囲です。`
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

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
      <div
        {...boardGesture}
        role="grid"
        aria-label="しかくの盤（下にスワイプでチェック）"
        tabIndex={0}
        onKeyDown={(e) => {
          // 盤面そのものにフォーカスがあるときだけ Enter でチェックする。
          // ガードがないとマスにフォーカスして Enter を押したときに選択と
          // チェックが両方走る（anagram / mastermind と同じ構図）。
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onCheck();
          }
        }}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${state.size}, minmax(0, 1fr))`,
          gap: 3,
          width: "100%",
          maxWidth: 460,
          margin: "0 auto",
          touchAction: "none",
        }}
      >
        {state.clues.map((clue, i) => {
          const ri = rectIndexAt(state, i);
          const rect = ri >= 0 ? state.rects[ri] : null;
          const r = Math.floor(i / state.size);
          const c = i % state.size;
          const isAnchor = anchor === i;
          const isViolation = violationCells.has(i);
          const isHint = hintCells.has(i);
          const edge = rect
            ? {
                borderTop: r === rect.r1 ? "2px solid #555" : "2px solid transparent",
                borderBottom: r === rect.r2 ? "2px solid #555" : "2px solid transparent",
                borderLeft: c === rect.c1 ? "2px solid #555" : "2px solid transparent",
                borderRight: c === rect.c2 ? "2px solid #555" : "2px solid transparent",
              }
            : {};
          return (
            <div
              key={i}
              role="gridcell"
              tabIndex={0}
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
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                onCell(i);
              }}
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
                boxShadow: isAnchor
                  ? "0 0 0 2px #e2534a inset"
                  : isHint
                    ? "0 0 0 3px #38bdf8 inset"
                    : undefined,
                fontWeight: clue !== null ? 700 : 400,
                fontSize: 17,
                cursor: "pointer",
                color: "inherit",
              }}
            >
              {clue !== null ? clue : ""}
            </div>
          );
        })}
      </div>
  );

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
          角のマスを2回タップして長方形を描き、盤面を埋めます。盤面を下にスワイプするとチェックします。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="サイズと操作">
        {SIZES.map((s) => (
          <div
            key={s.key}
            {...tappableProps(() => restart(s.key))}
            aria-pressed={size === s.key}
            className={size === s.key ? "classic-btn classic-btn-active" : "classic-btn"}
          >
            {s.label}
          </div>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(size)}>
          もう一度
        </button>
        <div
          {...tappableProps(onHint)}
          aria-disabled={state.status === "won" || hintsUsed >= HINT_LIMIT}
          className="classic-btn"
          style={state.status === "won" || hintsUsed >= HINT_LIMIT ? { opacity: 0.5 } : undefined}
        >
          ヒント（残り {HINT_LIMIT - hintsUsed}）
        </div>
      </div>

      <p className="classic-status" role="status">
        埋めたマス {covered} / {total} ・ {seconds} 秒
        {best !== null ? ` ・ ベスト ${formatTime(best)}` : ""} ・ {statusText}
      </p>

      {webglFailed ? board2d : (
        <div style={{ width: "100%", maxWidth: 460, margin: "0 auto" }}>
          <ShikakuScene3D
            clues={state.clues}
            rects={state.rects}
            size={state.size}
            anchor={anchor}
            violationCells={[...violationCells]}
            status={state.status}
            onCell={onCell}
            onDragRect={handleDragRect}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}
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
