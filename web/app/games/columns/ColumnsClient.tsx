"use client";
// コラムス。ロジックは lib/columns.ts（落下・回転・連鎖消去）。
// 盤面のスワイプ／タップとキーボード（←→移動／↑回転／↓ソフトドロップ／スペース=ハードドロップ）。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const ColumnsScene3D = dynamic(() => import("./ColumnsScene3D"), { ssr: false });
import {
  COLUMNS_COLS,
  COLUMNS_ROWS,
  GEM_FILL,
  createColumnsGame,
  dropColumns,
  moveColumns,
  rotateColumns,
  stepColumns,
  type ColumnsState,
} from "@/lib/columns";
import { useGamesNav } from "../GamesShell";
import { sfxCorrect, sfxLose, sfxPlace, sfxSlide, sfxTap } from "@/lib/sfx";
import { useGesture, type GestureDirection } from "@/lib/gesture";
import { EndScreen, ScorePop } from "../GameJuice";

const FALL_MS = 650;
const BEST_KEY = "ago-columns-best";

function newGame(): ColumnsState {
  return createColumnsGame(Date.now() % 2147483647);
}

export default function ColumnsClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [state, setState] = useState<ColumnsState>(() => newGame());
  const [best, setBest] = useState<number | null>(null);
  const [started, setStarted] = useState(false);
  const [scorePop, setScorePop] = useState<{ amount: number; key: number } | null>(null);
  const prevBestRef = useRef<number | null>(null);
  const prevScoreRef = useRef(0);
  const prevClearedRef = useRef(0);
  const endSoundRef = useRef<ColumnsState | null>(null);
  // 3D シーンが毎フレーム読む最新の状態（React 再描画を介さない）。
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      const loaded = Number.isFinite(saved) && saved > 0 ? saved : null;
      setBest(loaded);
      prevBestRef.current = loaded;
    } catch {
      setBest(null);
    }
  }, []);

  useEffect(() => {
    if (!started || state.status !== "playing") return;
    const id = setInterval(() => {
      setState((s) => stepColumns(s));
    }, FALL_MS);
    return () => clearInterval(id);
  }, [started, state.status]);

  useEffect(() => {
    if (state.status !== "gameover") return;
    if (best !== null && state.score <= best) return;
    if (state.score <= 0) return;
    setBest(state.score);
    try {
      window.localStorage.setItem(BEST_KEY, String(state.score));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, state.score, best]);

  // スコアが伸びたら ScorePop と効果音、ゲームオーバーで敗北音。
  useEffect(() => {
    if (state.score > prevScoreRef.current) {
      setScorePop({ amount: state.score - prevScoreRef.current, key: state.score });
    }
    prevScoreRef.current = state.score;
    if (state.cleared > prevClearedRef.current) sfxCorrect();
    prevClearedRef.current = state.cleared;
  }, [state.score, state.cleared]);

  useEffect(() => {
    if (state.status !== "gameover") return;
    if (endSoundRef.current === state) return;
    endSoundRef.current = state;
    sfxLose();
  }, [state]);

  const restart = useCallback(() => {
    prevBestRef.current = best;
    prevScoreRef.current = 0;
    prevClearedRef.current = 0;
    setScorePop(null);
    setState(newGame());
    setStarted(true);
  }, [best]);

  const doMove = (dir: -1 | 1) => {
    sfxSlide();
    setState((s) => moveColumns(s, dir));
  };
  const doRotate = () => {
    sfxTap();
    // HEAD ではここが doRotate() の自己再帰になっており、回転ボタン・↑キーで
    // スタックオーバーフローしていた（第5バッチで回転を盤面タップへ移す際に修正）。
    setState((s) => rotateColumns(s));
  };
  const doStep = () => {
    setState((s) => stepColumns(s));
  };
  const doDrop = () => {
    sfxPlace();
    setState((s) => dropColumns(s));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      // 未開始・ゲームオーバー時は Enter / Space で開始する。ボタンにフォーカスが
      // あるときはネイティブの click に任せ、window 側では二重に開始しない。
      if (!started || state.status === "gameover") {
        if (e.key === "Enter" || e.key === " ") {
          if (target && target.tagName === "BUTTON") return;
          e.preventDefault();
          restart();
        }
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        doMove(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        doMove(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        doRotate();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        doStep();
      } else if (e.key === " ") {
        e.preventDefault();
        doDrop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [started, state.status, restart]);

  // 盤面ジェスチャと 3D シーンで共有する操作ハンドラ: 左右スワイプ=移動、
  // 下スワイプ=ソフトドロップ、上スワイプ=ハードドロップ、タップ=回転
  // （falling と同じ対応）。未開始・ゲームオーバー時のタップは開始、
  // スワイプは無効。
  const handleSwipe = (dir: GestureDirection) => {
    if (!started || state.status !== "playing") return;
    if (dir === "left") doMove(-1);
    else if (dir === "right") doMove(1);
    else if (dir === "down") doStep();
    else if (dir === "up") doDrop();
  };
  const handleTap = () => {
    if (!started || state.status === "gameover") {
      restart();
      return;
    }
    if (state.status === "playing") doRotate();
  };

  const boardGesture = useGesture({
    onSwipe: (dir) => {
      handleSwipe(dir);
    },
    onTap: handleTap,
  });

  // 3D シーンへ渡す表示状態（盤・落下中ブロックは lib の状態をそのまま渡す）。
  const getViewState = useCallback(() => {
    const s = stateRef.current;
    return { board: s.board, active: s.active, placed: s.placed, status: s.status };
  }, []);

  // 盤面＋落下中ブロックを合成して描く。
  const cells: (number | null)[] = [...state.board];
  if (state.active) {
    for (let k = 0; k < 3; k++) {
      const row = state.active.y + k;
      if (row >= 0 && row < COLUMNS_ROWS) {
        cells[row * COLUMNS_COLS + state.active.col] = state.active.gems[k];
      }
    }
  }

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
        <div
          {...boardGesture}
          role="img"
          aria-label="コラムスの盤面（スワイプで移動・落とす、タップで回転）"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${COLUMNS_COLS}, 1fr)`,
            gap: 3,
            width: "min(78vw, 300px)",
            padding: 6,
            background: "#1f2937",
            borderRadius: 10,
            touchAction: "none",
          }}
        >
          {cells.map((v, i) => (
            <div
              key={i}
              className={v === null ? undefined : "juice-pop"}
              style={{
                aspectRatio: "1",
                borderRadius: "50%",
                background: v === null ? "rgba(255,255,255,0.07)" : GEM_FILL[v],
                boxShadow: v === null ? "none" : "inset -2px -3px 0 rgba(0,0,0,0.18)",
              }}
            />
          ))}
        </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>コラムス</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>コラムス</h1>
        <p className="muted">盤面をスワイプ／タップして操作します（←→ 移動／↑ 一気に落とす／↓ 1段落とす／タップ 回転）。キーボード（矢印キー／スペース）でも動けます。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          {started ? "もう一度" : "スタート"}
        </button>
      </div>

      <p className="classic-status" role="status">
        {state.status === "gameover" ? (
          <span>ゲームオーバー。スコア {state.score} 点でした。</span>
        ) : !started ? (
          <span>盤面をタップすると始まります。</span>
        ) : null}
        <span>スコア {state.score}{scorePop ? <ScorePop key={scorePop.key} amount={scorePop.amount} /> : null}</span>
        <span>消去 {state.cleared} 個</span>
        <span>最大 {state.maxChain} 連鎖</span>
        {best !== null ? <span>ベスト {best}</span> : null}
      </p>

      <div style={{ display: "flex", gap: 16, justifyContent: "center", alignItems: "flex-start", flexWrap: "wrap" }}>
{webglFailed ? board2d : (
          <div style={{ width: "min(78vw, 300px)" }}>
            <ColumnsScene3D
              getState={getViewState}
              onSwipe={handleSwipe}
              onTap={handleTap}
              onFail={() => setWebglFailed(true)}
              fallback={board2d}
            />
          </div>
        )}
        <div style={{ textAlign: "center" }}>
          <p className="muted" style={{ margin: "0 0 6px", fontSize: 13 }}>
            次
          </p>
          <div style={{ display: "grid", gap: 3, justifyContent: "center" }}>
            {state.next.map((g, i) => (
              <div
                key={`${state.cleared}-${state.score}-${i}-${g}`}
                className="juice-pop"
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  background: GEM_FILL[g],
                  boxShadow: "inset -2px -3px 0 rgba(0,0,0,0.18)",
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {state.status === "gameover" ? (
        <div style={{ maxWidth: 420, margin: "16px auto 0" }}>
          <EndScreen
            outcome="finish"
            title="ゲームオーバー"
            score={state.score}
            newBest={state.score > 0 && (prevBestRef.current === null || state.score > prevBestRef.current)}
            previousBest={prevBestRef.current}
            onRetry={restart}
          >
            <p className="muted" style={{ margin: 0 }}>
              消去 {state.cleared} 個 ・ 最大 {state.maxChain} 連鎖
            </p>
          </EndScreen>
        </div>
      ) : null}
    </>
  );
}
