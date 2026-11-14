"use client";
// あかり。ロジックは lib/akari.ts（解先行生成・ルール検証で完成判定）。
// 白マスをタップして電球を置く／外す。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createAkariGame,
  evaluateAkari,
  toggleBulb,
  type AkariState,
} from "@/lib/akari";
import { sfxPlace, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const AkariScene3D = dynamic(() => import("./AkariScene3D"), { ssr: false });

const BEST_KEY = "ago-akari-best";

function newGame(): AkariState {
  return createAkariGame(Date.now() % 2147483647);
}

export default function AkariClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [state, setState] = useState<AkariState>(() => newGame());
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
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  useEffect(() => {
    if (state.status !== "won" || seconds <= 0) return;
    if (best !== null && seconds >= best) return;
    setBest(seconds);
    try {
      window.localStorage.setItem(BEST_KEY, String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best]);

  const restart = () => {
    setState(newGame());
    setSeconds(0);
    setResultNewBest(false);
    setResultPrevBest(null);
  };

  const handleCell = (i: number) => {
    const next = toggleBulb(state, i);
    if (next !== state && next.status !== "won") {
      if (next.bulbs.includes(i)) sfxPlace();
      else sfxTap();
    }
    setState(next);
  };

  const evaluation = useMemo(() => evaluateAkari(state), [state]);
  const conflictSet = useMemo(() => new Set(evaluation.conflictBulbs), [evaluation]);
  // 決定的におかしい数字壁（多すぎ／残りマスでも届かない）だけを強調する。
  const badWallSet = useMemo(() => {
    const set = new Set<number>();
    for (const e of evaluation.numberErrors) {
      if (e.actual > e.expected || e.actual + e.adjacentOpen < e.expected) set.add(e.index);
    }
    return set;
  }, [evaluation]);

  const wallSet = useMemo(() => new Set(state.walls), [state.walls]);
  const bulbSet = useMemo(() => new Set(state.bulbs), [state.bulbs]);

  const statusText =
    state.status === "won"
      ? "全部照らせた！クリアです。"
      : evaluation.conflictBulbs.length > 0
        ? "電球同士が照らし合っています。"
        : badWallSet.size > 0
          ? "数字と合わない黒マスがあります。"
          : "全ての白マスを照らし、数字を合わせればクリアです。";

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
      <div
        role="grid"
        aria-label="あかりの盤"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${state.cols}, minmax(0, 1fr))`,
          gap: 4,
          maxWidth: 460,
          margin: "0 auto",
        }}
      >
        {Array.from({ length: state.rows * state.cols }, (_, i) => {
          const r = Math.floor(i / state.cols) + 1;
          const c = (i % state.cols) + 1;
          if (wallSet.has(i)) {
            const num = state.numbers[i];
            return (
              <div
                key={i}
                role="gridcell"
                aria-label={num !== undefined ? `黒マス 数字 ${num}` : "黒マス"}
                style={{
                  aspectRatio: "1",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20,
                  fontWeight: 800,
                  color: "#fff",
                  background: badWallSet.has(i) ? "#b03a2e" : "#26221f",
                  borderRadius: 8,
                }}
              >
                {num ?? ""}
              </div>
            );
          }
          const hasBulb = bulbSet.has(i);
          const lit = evaluation.lit[i];
          const conflict = conflictSet.has(i);
          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              aria-label={`${r}行${c}列 ${hasBulb ? "電球あり" : lit ? "照らされている" : "暗い"}`}
              aria-pressed={hasBulb}
              disabled={state.status === "won"}
              className={conflict ? "juice-shake" : hasBulb ? "juice-pop" : undefined}
              onClick={() => handleCell(i)}
              style={{
                aspectRatio: "1",
                minWidth: 0,
                padding: 0,
                fontSize: 22,
                cursor: "pointer",
                color: "var(--text)",
                background: conflict
                  ? "#f7e3e0"
                  : hasBulb
                    ? "#ffe9a8"
                    : lit
                      ? "#fff6cf"
                      : "#e9e6df",
                border: conflict ? "2px solid #b03a2e" : "1px solid var(--line)",
                borderRadius: 8,
              }}
            >
              {hasBulb ? "●" : ""}
            </button>
          );
        })}
      </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>あかり</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>あかり</h1>
        <p className="muted">
          白マスをタップして電球を置いたり外したりします。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        照らしたマス {evaluation.litCount} / {evaluation.whiteCount} ・ {seconds} 秒
        {best !== null ? ` ・ ベスト ${best} 秒` : ""} ・ {statusText}
      </p>

      {webglFailed ? board2d : (
        <div style={{ width: "100%", maxWidth: 460, margin: "0 auto" }}>
          <AkariScene3D
            rows={state.rows}
            cols={state.cols}
            walls={state.walls}
            numbers={state.numbers}
            bulbs={state.bulbs}
            lit={evaluation.lit}
            conflictBulbs={evaluation.conflictBulbs}
            badWalls={[...badWallSet]}
            status={state.status}
            onCell={handleCell}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}
      {state.status === "won" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen
            outcome="win"
            title="全部照らせた！"
            score={seconds}
            scoreLabel="クリアタイム（秒）"
            newBest={resultNewBest}
            previousBest={resultPrevBest}
            onRetry={restart}
          >
            <p className="muted">
              電球 {state.bulbs.length} 個で全ての白マスを照らしました。
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
