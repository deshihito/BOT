"use client";
// ノノグラム（お絵かきロジック）。ロジックは lib/nonogram.ts。
// 塗る／×印の2モード。マスを押したままなぞると連続で塗れる（ドラッグ塗り）。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  createNonogramGame,
  nonogramHintSatisfaction,
  nonogramProgress,
  setNonoMark,
  type NonoMark,
  type NonoSize,
  type NonoState,
} from "@/lib/nonogram";
import { sfxPlace, sfxTap, sfxWin } from "@/lib/sfx";
import { tappableProps } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const NonogramScene3D = dynamic(() => import("./NonogramScene3D"), { ssr: false });

type Mode = "fill" | "cross";

const SIZES: { key: NonoSize; label: string }[] = [
  { key: 10, label: "10×10" },
  { key: 15, label: "15×15" },
];

function newGame(size: NonoSize): NonoState {
  return createNonogramGame(Date.now() % 2147483647, size);
}

function formatTime(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function NonogramClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [size, setSize] = useState<NonoSize>(10);
  const [state, setState] = useState<NonoState>(() => newGame(10));
  const [mode, setMode] = useState<Mode>("fill");
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [resultNewBest, setResultNewBest] = useState(false);
  const [resultPrevBest, setResultPrevBest] = useState<number | null>(null);
  const paintingRef = useRef<NonoMark | null>(null);
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
    if (state.status === "won") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(`ago-nonogram-best-${size}`));
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
      window.localStorage.setItem(`ago-nonogram-best-${size}`, String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best, size]);

  useEffect(() => {
    const stop = () => {
      paintingRef.current = null;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const restart = (nextSize: NonoSize) => {
    setSize(nextSize);
    setState(newGame(nextSize));
    setSeconds(0);
    setResultNewBest(false);
    setResultPrevBest(null);
    paintingRef.current = null;
  };

  const startPaint = (index: number) => {
    if (state.status === "won") return;
    const current = state.marks[index];
    const target: NonoMark = mode === "fill" ? (current === 1 ? 0 : 1) : current === 2 ? 0 : 2;
    paintingRef.current = target;
    const next = setNonoMark(state, index, target);
    if (next.status !== "won") {
      if (target === 1) sfxPlace();
      else sfxTap();
    }
    setState(next);
  };

  const continuePaint = (index: number) => {
    const target = paintingRef.current;
    if (target === null || state.status === "won") return;
    setState((s) => setNonoMark(s, index, target));
  };

  // タッチでは pointerenter が各マスに届かないため、指の位置からマスを引く。
  const onBoardPointerMove = (e: React.PointerEvent) => {
    if (paintingRef.current === null) return;
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const holder = el?.closest("[data-nono-index]") as HTMLElement | null;
    if (!holder) return;
    const index = Number(holder.dataset.nonoIndex);
    if (Number.isInteger(index)) continuePaint(index);
  };

  const n = state.size;
  const progress = nonogramProgress(state);
  const satisfaction = useMemo(() => nonogramHintSatisfaction(state), [state]);
  const errorSet = new Set(state.errors);
  const maxColHints = Math.max(...state.colHints.map((h) => h.length));
  const won = state.status === "won";

  const statusText = won
    ? `完成！絵柄は「${state.patternTitle}」でした。`
    : state.moves === 0
      ? "マスを選んで塗り始めてください。数字は、その行（列）で連続して塗るマスの長さです。"
      : "";

  const statusParts = [
    `塗れたマス ${progress.filled} / ${progress.total}`,
    `ミス ${state.mistakes}`,
    formatTime(seconds),
  ];
  if (best !== null) statusParts.push(`ベスト ${formatTime(best)}`);
  if (statusText) statusParts.push(statusText);

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
      <div
        role="grid"
        aria-label="ノノグラムの盤"
        onPointerMove={onBoardPointerMove}
        style={{
          display: "grid",
          gridTemplateColumns: `auto repeat(${n}, minmax(0, 1fr))`,
          gridTemplateRows: `auto repeat(${n}, minmax(0, 1fr))`,
          width: n === 15 ? "min(96vw, 600px)" : "min(94vw, 520px)",
          margin: "0 auto",
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        <div aria-hidden="true" />
        {state.colHints.map((hints, c) => (
          <div
            key={`col-${c}`}
            aria-hidden="true"
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-end",
              alignItems: "center",
              minHeight: maxColHints * (n === 15 ? 13 : 15),
              paddingBottom: 2,
              fontSize: n === 15 ? 10 : 12,
              lineHeight: n === 15 ? "13px" : "15px",
              fontWeight: 600,
              color: "#5a5148",
              background: (c + 1) % 5 === 0 ? "#f3ecdd" : "transparent",
            }}
          >
            {hints.map((h, i) => (
              <span
                key={i}
                style={
                  satisfaction.cols[c][i]
                    ? { opacity: 0.35, fontWeight: 400, textDecoration: "line-through" }
                    : undefined
                }
              >
                {h}
              </span>
            ))}
          </div>
        ))}
        {state.rowHints.map((hints, r) => (
          <Fragment key={`row-${r}`}>
            <div
              aria-hidden="true"
              style={{
                display: "flex",
                justifyContent: "flex-end",
                alignItems: "center",
                gap: n === 15 ? 3 : 5,
                paddingRight: 5,
                fontSize: n === 15 ? 10 : 12,
                fontWeight: 600,
                color: "#5a5148",
                background: (r + 1) % 5 === 0 ? "#f3ecdd" : "transparent",
              }}
            >
              {hints.map((h, i) => (
                <span
                  key={i}
                  style={
                    satisfaction.rows[r][i]
                      ? { opacity: 0.35, fontWeight: 400, textDecoration: "line-through" }
                      : undefined
                  }
                >
                  {h}
                </span>
              ))}
            </div>
            {Array.from({ length: n }, (_, c) => {
              const index = r * n + c;
              const mark = state.marks[index];
              const isError = errorSet.has(index);
              const filled = won ? state.solution[index] : mark === 1;
              return (
                <div
                  key={index}
                  role="gridcell"
                  tabIndex={won ? -1 : 0}
                  data-nono-index={index}
                  aria-label={`${r + 1}行${c + 1}列${filled ? " 塗り" : mark === 2 ? " ×印" : ""}`}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    startPaint(index);
                  }}
                  onPointerEnter={() => continuePaint(index)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    startPaint(index);
                  }}
                  onContextMenu={(e) => e.preventDefault()}
                  className={isError && !won ? "juice-shake" : filled ? "juice-pop" : undefined}
                  style={{
                    aspectRatio: "1",
                    padding: 0,
                    display: "grid",
                    placeItems: "center",
                    borderTop: r % 5 === 0 ? "2px solid #8a7f6d" : "1px solid #d8d2c4",
                    borderLeft: c % 5 === 0 ? "2px solid #8a7f6d" : "1px solid #d8d2c4",
                    borderRight: c === n - 1 ? "2px solid #8a7f6d" : "1px solid #d8d2c4",
                    borderBottom: r === n - 1 ? "2px solid #8a7f6d" : "1px solid #d8d2c4",
                    background: filled
                      ? isError && !won
                        ? "#e5484d"
                        : won
                          ? "#2f6db3"
                          : "#33415c"
                      : "#fffdf6",
                    color: "#b0a58e",
                    fontSize: n === 15 ? 11 : 14,
                    lineHeight: 1,
                    cursor: won ? "default" : "pointer",
                    touchAction: "none",
                  }}
                >
                  {!filled && mark === 2 ? "×" : ""}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ノノグラム</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ノノグラム</h1>
        <p className="muted">数字を手がかりにマスを塗って、絵を完成させるパズルです。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="盤のサイズ">
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
          別の問題
        </button>
      </div>

      <div className="classic-controls" role="group" aria-label="入力モード">
        <div
          {...tappableProps(() => setMode("fill"))}
          aria-pressed={mode === "fill"}
          className={mode === "fill" ? "classic-btn classic-btn-active" : "classic-btn"}
        >
          ■ 塗る
        </div>
        <div
          {...tappableProps(() => setMode("cross"))}
          aria-pressed={mode === "cross"}
          className={mode === "cross" ? "classic-btn classic-btn-active" : "classic-btn"}
        >
          × 印
        </div>
      </div>

      <p className="classic-status" role="status">
        {statusParts.join(" ・ ")}
      </p>

      {webglFailed ? board2d : (
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          {/* ヒント数字は盤外の情報として DOM 併記で担保する（3D は盤面マスのみ）。 */}
          <div style={{ display: "flex", marginLeft: 44 }} aria-hidden="true">
            {state.colHints.map((hints, c) => (
              <div
                key={`col3d-${c}`}
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "flex-end",
                  alignItems: "center",
                  minHeight: maxColHints * (n === 15 ? 13 : 15),
                  paddingBottom: 2,
                  fontSize: n === 15 ? 10 : 12,
                  lineHeight: n === 15 ? "13px" : "15px",
                  fontWeight: 600,
                  color: "#5a5148",
                }}
              >
                {hints.map((h, i) => (
                  <span
                    key={i}
                    style={
                      satisfaction.cols[c][i]
                        ? { opacity: 0.35, fontWeight: 400, textDecoration: "line-through" }
                        : undefined
                    }
                  >
                    {h}
                  </span>
                ))}
              </div>
            ))}
          </div>
          <div style={{ display: "flex" }}>
            <div style={{ width: 44, display: "flex", flexDirection: "column" }} aria-hidden="true">
              {state.rowHints.map((hints, r) => (
                <div
                  key={`row3d-${r}`}
                  style={{
                    flex: 1,
                    display: "flex",
                    justifyContent: "flex-end",
                    alignItems: "center",
                    gap: n === 15 ? 3 : 5,
                    paddingRight: 5,
                    fontSize: n === 15 ? 10 : 12,
                    fontWeight: 600,
                    color: "#5a5148",
                  }}
                >
                  {hints.map((h, i) => (
                    <span
                      key={i}
                      style={
                        satisfaction.rows[r][i]
                          ? { opacity: 0.35, fontWeight: 400, textDecoration: "line-through" }
                          : undefined
                      }
                    >
                      {h}
                    </span>
                  ))}
                </div>
              ))}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <NonogramScene3D
                marks={state.marks}
                solution={state.solution}
                errors={state.errors}
                size={n}
                won={won}
                onPaintStart={startPaint}
                onPaintContinue={continuePaint}
                onFail={() => setWebglFailed(true)}
                fallback={board2d}
              />
            </div>
          </div>
        </div>
      )}
      <p className="muted" style={{ textAlign: "center", marginTop: 10 }}>
        マスを押したままなぞると、まとめて塗ったり消したりできます。×印は「塗らないマス」のメモです。
      </p>

      {won && (
        <div style={{ marginTop: 16 }}>
          <EndScreen
            outcome="win"
            title="完成！"
            score={seconds}
            scoreLabel="クリアタイム（秒）"
            newBest={resultNewBest}
            previousBest={resultPrevBest}
            onRetry={() => restart(size)}
            retryLabel="別の問題"
          >
            <p className="muted">
              絵柄は「{state.patternTitle}」でした。ミス {state.mistakes} 回で完成させました。
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
