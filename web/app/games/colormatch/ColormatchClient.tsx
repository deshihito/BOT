"use client";
// 色文字マッチ（ストループ課題）。ロジックは lib/colormatch.ts。
// 文字の意味とインクの色が「あっている」かを30秒で何問答えられるか競う。
// ベストスコアは localStorage に保存する。サーバーへ送信しない。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CM_COLORS,
  CM_GAME_SECONDS,
  answerColorMatch,
  createColorMatchGame,
  type CmState,
} from "@/lib/colormatch";
import { sfxCorrect, sfxTap, sfxTick, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-colormatch-best";

type Phase = "ready" | "playing" | "finished";

function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

const answerBtn: React.CSSProperties = {
  flex: "1 1 140px",
  padding: "16px 12px",
  borderRadius: 12,
  border: "1px solid #8a90a3",
  background: "#22304f",
  color: "#fff",
  fontSize: 20,
  fontWeight: 700,
  cursor: "pointer",
  minHeight: 60,
};

export default function ColorMatchClient() {
  const { prefix } = useGamesNav();
  const [phase, setPhase] = useState<Phase>("ready");
  const [state, setState] = useState<CmState>(() => createColorMatchGame(Date.now() % 2147483647));
  const [remainMs, setRemainMs] = useState(CM_GAME_SECONDS * 1000);
  const [best, setBest] = useState(0);
  const [resultInfo, setResultInfo] = useState<{ newBest: boolean; prevBest: number } | null>(null);
  const endAtRef = useRef(0);
  const phaseRef = useRef<Phase>("ready");
  phaseRef.current = phase;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    setBest(loadBest());
  }, []);

  const finish = useCallback(() => {
    setPhase("finished");
    const score = stateRef.current.score;
    const prev = loadBest();
    const isNewBest = score > prev;
    setResultInfo({ newBest: isNewBest, prevBest: prev });
    if (isNewBest) {
      sfxWin();
      setBest(score);
      try {
        localStorage.setItem(BEST_KEY, String(score));
      } catch {
        /* 保存できなくても遊べる */
      }
    }
  }, []);

  // 残り時間の管理（終了時刻ベースでドリフトを避ける）
  useEffect(() => {
    if (phase !== "playing") return;
    const id = window.setInterval(() => {
      const remain = endAtRef.current - Date.now();
      if (remain <= 0) {
        window.clearInterval(id);
        setRemainMs(0);
        finish();
      } else {
        setRemainMs(remain);
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [phase, finish]);

  const start = useCallback(() => {
    sfxTap();
    setResultInfo(null);
    setState(createColorMatchGame(Date.now() % 2147483647));
    endAtRef.current = Date.now() + CM_GAME_SECONDS * 1000;
    setRemainMs(CM_GAME_SECONDS * 1000);
    setPhase("playing");
  }, []);

  const answer = useCallback(
    (saidMatch: boolean) => {
      if (phaseRef.current !== "playing") return;
      if (Date.now() >= endAtRef.current) return;
      const next = answerColorMatch(stateRef.current, saidMatch);
      if (next.lastCorrect) sfxCorrect();
      else sfxWrong();
      setState(next);
    },
    [],
  );

  // キーボード: ← = ちがう、→ = あっている
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phaseRef.current !== "playing") return;
      if (e.key === "ArrowRight") answer(true);
      else if (e.key === "ArrowLeft") answer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answer]);

  const word = CM_COLORS[state.question.wordIndex];
  const ink = CM_COLORS[state.question.inkIndex];
  const remainSec = Math.ceil(remainMs / 1000);

  // 終了間際（残り3秒）だけ秒読み音
  useEffect(() => {
    if (phase === "playing" && remainSec <= 3 && remainSec >= 1) sfxTick();
  }, [remainSec, phase]);
  const feedbackColor =
    state.lastCorrect === null ? undefined : state.lastCorrect ? "#2e9e4f" : "#c62828";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>色文字マッチ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>色文字マッチ</h1>
        <p className="muted">
          色の名前が、その文字の色と「あっている」かどうかを当てる反射神経ゲーム。
          {CM_GAME_SECONDS}秒で何点取れるか挑戦しよう。文字の意味に惑わされないように。
        </p>
      </div>

      <p className="classic-status" role="status">
        {phase === "playing" && (
          <>
            残り {remainSec} 秒 ・ スコア {state.score} ・ コンボ {state.combo}
            {state.lastCorrect !== null && (
              <span style={{ color: feedbackColor, fontWeight: 700 }}>
                {state.lastCorrect ? " ・ 正解！" : " ・ ちがった…"}
              </span>
            )}
          </>
        )}
        {phase === "ready" && <>ベスト {best} 点</>}
        {phase === "finished" && <>終了！</>}
      </p>

      {phase === "finished" && (
        <div style={{ maxWidth: 520, margin: "0 auto 14px" }}>
          <EndScreen
            outcome="finish"
            score={state.score}
            scoreLabel="スコア（点）"
            newBest={resultInfo?.newBest ?? false}
            previousBest={resultInfo ? resultInfo.prevBest : undefined}
            onRetry={start}
          >
            <p className="muted" style={{ margin: 0 }}>
              {state.answered} 問中 {state.correct} 問正解 ・ 最大コンボ {state.maxCombo}
            </p>
          </EndScreen>
        </div>
      )}

      {phase === "playing" && (
        <div style={{ maxWidth: 480, margin: "0 auto", textAlign: "center" }}>
          <div
            key={state.answered}
            className={state.lastCorrect === false ? "juice-shake" : "juice-pop"}
            aria-live="off"
            style={{
              fontSize: "min(22vw, 96px)",
              fontWeight: 900,
              lineHeight: 1.2,
              color: ink.css,
              padding: "24px 0",
              userSelect: "none",
            }}
          >
            {word.name}
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <button type="button" style={answerBtn} onClick={() => answer(false)}>
              ✗ ちがう
            </button>
            <button type="button" style={answerBtn} onClick={() => answer(true)}>
              ✓ あっている
            </button>
          </div>
          <p className="muted" style={{ marginTop: 10, fontSize: 13 }}>
            キーボード: ← = ちがう / → = あっている
          </p>
        </div>
      )}

      <div className="classic-controls" style={{ marginTop: 16 }}>
        {phase !== "playing" && (
          <button
            type="button"
            onClick={start}
            style={{
              padding: "12px 28px",
              borderRadius: 999,
              border: "1px solid #8a90a3",
              background: "#22304f",
              color: "#fff",
              fontSize: 17,
              fontWeight: 700,
              cursor: "pointer",
              minHeight: 48,
            }}
          >
            {phase === "finished" ? "もう一度" : "スタート"}
          </button>
        )}
      </div>
    </>
  );
}
