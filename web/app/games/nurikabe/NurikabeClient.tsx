"use client";
// ぬりかべ。ロジックは lib/nurikabe.ts（解を先に作る生成＋ルール検証で完成判定）。
// タップで 未定→海→島→未定 と切り替える。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  checkNurikabe,
  createNurikabeGame,
  cycleNurikabeMark,
  type NurikabeSize,
  type NurikabeState,
  type NurikabeViolation,
} from "@/lib/nurikabe";
import { sfxCorrect, sfxPlace, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const SIZES: { key: NurikabeSize; label: string }[] = [
  { key: 5, label: "5×5" },
  { key: 7, label: "7×7" },
];

function newGame(size: NurikabeSize): NurikabeState {
  return createNurikabeGame(Date.now() % 2147483647, size);
}

export default function NurikabeClient() {
  const { prefix } = useGamesNav();
  const [size, setSize] = useState<NurikabeSize>(5);
  const [state, setState] = useState<NurikabeState>(() => newGame(5));
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [violations, setViolations] = useState<NurikabeViolation[]>([]);

  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(`ago-nurikabe-best-${size}`));
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
      window.localStorage.setItem(`ago-nurikabe-best-${size}`, String(seconds));
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

  const restart = (nextSize: NurikabeSize) => {
    setSize(nextSize);
    setState(newGame(nextSize));
    setSeconds(0);
    setViolations([]);
    setWinResult(null);
  };

  const violationCells = useMemo(() => new Set(violations.flatMap((v) => v.cells)), [violations]);

  const onCell = (index: number) => {
    if (state.status !== "playing" || state.clues[index] !== null) return;
    // 循環の次の印が「未定」に戻る場合はタップ音、それ以外（海・島を置く）は配置音。
    if (state.marks[index] === 2) {
      sfxTap();
    } else {
      sfxPlace();
    }
    setViolations([]);
    setState((s) => cycleNurikabeMark(s, index));
  };

  const onCheck = () => {
    if (state.status !== "playing") return;
    const result = checkNurikabe(state);
    if (result.length === 0) {
      sfxCorrect();
    } else {
      sfxWrong();
    }
    setViolations(result);
  };

  // 盤面の下スワイプ=チェック。盤面フォーカス時の Enter でもチェックできる。
  const boardGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "down") onCheck();
    },
  });

  const statusText =
    state.status === "won"
      ? `クリア！ ${state.moves}手・${seconds}秒でした。`
      : "数字は島の大きさ。島は1つの数字だけを含み、海は全部つながって2x2の塊は禁止です。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ぬりかべ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ぬりかべ</h1>
        <p className="muted">マスをタップするたびに「海（塗り）→島→未定」と切り替わります。盤面を下にスワイプするとチェックします。</p>
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
        <span>{statusText}</span>
        <span>時間 {seconds}秒</span>
        {best !== null ? <span>ベスト {best}秒</span> : null}
      </p>

      {violations.length > 0 ? (
        <div
          role="alert"
          style={{
            maxWidth: 520,
            margin: "0 auto 12px",
            padding: "10px 14px",
            borderRadius: 10,
            background: "#fef2f2",
            border: "1px solid #fca5a5",
            color: "#991b1b",
            fontSize: 14,
          }}
        >
          <strong>ルール違反があります</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {[...new Set(violations.map((v) => v.message))].map((msg) => (
              <li key={msg}>{msg}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div
        {...boardGesture}
        role="grid"
        aria-label="ぬりかべの盤面"
        tabIndex={0}
        onKeyDown={(e) => {
          // 盤面そのものにフォーカスがあるときだけ Enter でチェックする。
          // マスにフォーカスして Enter を押したときはマスの切り替えだけが走る
          // （anagram / mastermind と同じ構図）。
          if (e.target !== e.currentTarget) return;
          if (e.key !== "Enter") return;
          e.preventDefault();
          onCheck();
        }}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${size}, 1fr)`,
          gap: 3,
          width: "100%",
          maxWidth: size === 5 ? 420 : 520,
          margin: "0 auto",
          touchAction: "none",
        }}
      >
        {state.marks.map((mark, i) => {
          const clue = state.clues[i];
          const isClue = clue !== null;
          const bad = violationCells.has(i);
          let bg = "#f3f4f6";
          let color = "#111827";
          let border = "1px solid #d1d5db";
          if (mark === 1) {
            bg = "#334155";
            color = "#e2e8f0";
          } else if (mark === 2) {
            bg = "#ffffff";
          }
          if (isClue) {
            bg = "#fef9c3";
            border = "1px solid #eab308";
          }
          if (bad) {
            border = "2px solid #ef4444";
          }
          const cellDisabled = isClue || state.status === "won";
          return (
            <div
              key={`${i}-${mark}`}
              role="gridcell"
              tabIndex={cellDisabled ? -1 : 0}
              className={bad ? "juice-shake" : mark !== 0 ? "juice-pop" : undefined}
              aria-label={
                isClue
                  ? `数字 ${clue} の島`
                  : mark === 1
                    ? "海"
                    : mark === 2
                      ? "島"
                      : "未定"
              }
              aria-disabled={cellDisabled}
              onClick={cellDisabled ? undefined : () => onCell(i)}
              onKeyDown={
                cellDisabled
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
                border,
                borderRadius: 6,
                background: bg,
                color,
                fontSize: size === 5 ? 20 : 17,
                fontWeight: isClue ? 800 : 400,
                cursor: isClue ? "default" : "pointer",
                padding: 0,
              }}
            >
              {isClue ? clue : mark === 1 ? "〜" : mark === 2 ? "・" : ""}
            </div>
          );
        })}
      </div>

      <p className="muted" style={{ textAlign: "center", marginTop: 12, fontSize: 13 }}>
        凡例：〜=海（塗り）／ ・=島 ／ 数字=島の大きさ（固定）
      </p>

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
            {size}×{size} ・ {state.moves}手でクリア
          </p>
        </EndScreen>
      ) : null}
    </>
  );
}
