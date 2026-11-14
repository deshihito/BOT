"use client";
// テントと木。ロジックは lib/tents.ts（解を先に作る生成で必ず解ける）。
// マスをタップすると 未定→テント→草→未定 と切り替わる。端末内で完結する。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const TentsScene3D = dynamic(() => import("./TentsScene3D"), { ssr: false });
import {
  createTentsGame,
  cycleTentsMark,
  isTentsComplete,
  tentsViolations,
  type TentsSize,
  type TentsState,
  type TentsViolation,
} from "@/lib/tents";
import { sfxCorrect, sfxPlace, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const SIZES: { key: TentsSize; label: string }[] = [
  { key: 6, label: "6×6" },
  { key: 8, label: "8×8" },
];

function newGame(size: TentsSize): TentsState {
  return createTentsGame(size, Date.now() % 2147483647);
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

export default function TentsClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [size, setSize] = useState<TentsSize>(6);
  const [state, setState] = useState<TentsState>(() => newGame(6));
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [checkResult, setCheckResult] = useState<TentsViolation[] | null>(null);
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
      const saved = Number(window.localStorage.getItem(`ago-tents-best-${size}`));
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
      window.localStorage.setItem(`ago-tents-best-${size}`, String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best, size]);

  const restart = (nextSize: TentsSize) => {
    sfxTap();
    setSize(nextSize);
    setState(newGame(nextSize));
    setSeconds(0);
    setCheckResult(null);
    setResultNewBest(false);
    setResultPrevBest(null);
  };

  const onCell = (index: number) => {
    setCheckResult(null);
    const next = cycleTentsMark(state, index);
    if (next === state) return;
    if (next.marks[index] === 1) sfxPlace();
    else sfxTap();
    setState(next);
  };

  const onCheck = () => {
    if (isTentsComplete(state)) {
      sfxCorrect();
      setCheckResult([]);
      return;
    }
    const violations = tentsViolations(state);
    if (violations.length === 0) sfxCorrect();
    else sfxWrong();
    setCheckResult(violations);
  };

  // 盤面の下スワイプ = チェック。子のマスの onClick との二重発火は
  // useGesture の suppressClickAfterSwipe が抑止する（kenken / kakuro と同じ）。
  const boardGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "down") onCheck();
    },
  });

  const violationCells = new Set((checkResult ?? []).flatMap((v) => v.cells));
  const placedInRow = (r: number) => {
    let n = 0;
    for (let c = 0; c < state.size; c++) if (state.marks[r * state.size + c] === 1) n++;
    return n;
  };
  const placedInCol = (c: number) => {
    let n = 0;
    for (let r = 0; r < state.size; r++) if (state.marks[r * state.size + c] === 1) n++;
    return n;
  };
  const treeCount = state.trees.filter(Boolean).length;
  const tentCount = state.marks.filter((m) => m === 1).length;

  const statusText =
    state.status === "won"
      ? `完成！ ${formatTime(seconds)}でクリアです。`
      : checkResult !== null
        ? checkResult.length === 0
          ? "ルール違反はありません。このまま完成を目指そう。"
          : `違反が ${checkResult.length} 件あります: ${checkResult[0].message}`
        : "各木のそば（縦横）にテントを1つずつ。テント同士は斜めでも隣り合えません。";

  const countStyle = (placed: number, target: number): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: 14,
    minHeight: 32,
    color: placed === target ? "#43a35c" : placed > target ? "#e2534a" : undefined,
  });

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  // 行・列の数字ヒントは盤外の情報なので、3D でもこの DOM 併記が正。
  const board2d = (
  <div
    {...boardGesture}
    style={{
      display: "grid",
      gridTemplateColumns: `32px repeat(${state.size}, minmax(0, 1fr))`,
      gap: 3,
      width: "100%",
      maxWidth: state.size === 6 ? 420 : 520,
      margin: "0 auto",
      touchAction: "none",
    }}
    role="grid"
    aria-label="テントと木の盤（下にスワイプでチェック）"
    tabIndex={0}
    onKeyDown={(e) => {
      // 盤面そのものにフォーカスがあるときだけ Enter でチェックする。
      // ガードがないとマスにフォーカスして Enter を押したときに切替と
      // チェックが両方走る（anagram / mastermind と同じ構図）。
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onCheck();
      }
    }}
  >
    {/* 左上コーナー + 列の数 */}
    <div />
    {state.colCounts.map((target, c) => (
      <div key={`col-${c}`} style={countStyle(placedInCol(c), target)} role="img" aria-label={`列${c + 1}のテント数 ${target}`}>
        {target}
      </div>
    ))}
    {Array.from({ length: state.size }, (_, r) => [
      <div key={`row-${r}`} style={countStyle(placedInRow(r), state.rowCounts[r])} role="img" aria-label={`行${r + 1}のテント数 ${state.rowCounts[r]}`}>
        {state.rowCounts[r]}
      </div>,
      ...Array.from({ length: state.size }, (_, c) => {
        const i = r * state.size + c;
        const isTree = state.trees[i];
        const mark = state.marks[i];
        const bad = violationCells.has(i);
        return (
          <div
            key={i}
            role="gridcell"
            tabIndex={isTree || state.status !== "playing" ? -1 : 0}
            aria-label={
              isTree ? "木" : mark === 1 ? "テント" : mark === 2 ? "草（テントなし）" : "未定"
            }
            aria-disabled={isTree || state.status !== "playing"}
            className={[mark === 1 ? "juice-pop" : "", bad ? "juice-shake" : ""].filter(Boolean).join(" ") || undefined}
            onClick={isTree || state.status !== "playing" ? undefined : () => onCell(i)}
            onKeyDown={
              isTree || state.status !== "playing"
                ? undefined
                : (e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    onCell(i);
                  }
            }
            style={{
              aspectRatio: "1",
              minWidth: 0,
              minHeight: 40,
              border: bad ? "3px solid #e2534a" : "1px solid var(--line, #ccc)",
              borderRadius: 6,
              background: isTree ? "#e8f3e8" : mark === 1 ? "#fdeeda" : mark === 2 ? "#eef6ee" : "#fff",
              fontSize: state.size === 6 ? 20 : 17,
              cursor: isTree ? "default" : "pointer",
              padding: 0,
            }}
          >
            {isTree ? (
              <svg viewBox="0 0 24 24" width="68%" height="68%" aria-hidden style={{ display: "block", margin: "0 auto" }}>
                <path d="M12 1.5 19 11h-3.6L20 18.5H4L8.6 11H5Z" fill="#2e7d32" />
                <rect x="10.9" y="18.5" width="2.2" height="3.6" fill="#6d4c41" />
              </svg>
            ) : mark === 1 ? (
              <svg viewBox="0 0 24 24" width="68%" height="68%" aria-hidden style={{ display: "block", margin: "0 auto" }}>
                <path d="M12 3.5 22 20H2Z" fill="#ef6c00" />
                <path d="M12 11.5 16.8 20H7.2Z" fill="#8d3b00" />
              </svg>
            ) : mark === 2 ? "・" : ""}
          </div>
        );
      }),
    ])}
  </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>テントと木</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>テントと木</h1>
        <p className="muted">マスをタップすると 未定→テント→草→未定 と切り替わります。盤面を下にスワイプするとチェックします。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="盤の大きさ">
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
      </div>

      <p className="classic-status" role="status">
        テント {tentCount} / {treeCount} ・ {formatTime(seconds)}
        {best !== null ? ` ・ ベスト ${formatTime(best)}` : ""} ・ {statusText}
      </p>

      {webglFailed ? board2d : (
        <div style={{ width: "100%", maxWidth: state.size === 6 ? 420 : 520, margin: "0 auto" }}>
          {/* 行・列ヒントは盤外の情報として DOM 併記で担保する（3D は盤面マスのみ）。 */}
          <div style={{ display: "flex", marginLeft: 36 }} aria-hidden="true">
            {state.colCounts.map((target, c) => (
              <div key={`col3d-${c}`} style={{ flex: 1, ...countStyle(placedInCol(c), target) }}>
                {target}
              </div>
            ))}
          </div>
          <div style={{ display: "flex" }}>
            <div style={{ width: 36, display: "flex", flexDirection: "column" }} aria-hidden="true">
              {state.rowCounts.map((target, r) => (
                <div key={`row3d-${r}`} style={{ flex: 1, ...countStyle(placedInRow(r), target) }}>
                  {target}
                </div>
              ))}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <TentsScene3D
                size={state.size}
                trees={state.trees}
                marks={state.marks}
                violationCells={[...violationCells]}
                status={state.status}
                onCell={onCell}
                onCheck={onCheck}
                onFail={() => setWebglFailed(true)}
                fallback={board2d}
              />
            </div>
          </div>
        </div>
      )}
      <p className="muted" style={{ textAlign: "center", marginTop: 10 }}>
        端の数字が緑になれば、その行・列のテント数は合っています。
      </p>

      {state.status === "won" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen
            outcome="win"
            score={seconds}
            scoreLabel="クリアタイム（秒）"
            newBest={resultNewBest}
            previousBest={resultPrevBest}
            onRetry={() => restart(size)}
          >
            <p className="muted">
              {size}×{size} ・ {formatTime(seconds)}でクリアしました。
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
