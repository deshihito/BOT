"use client";
// コラムス。ロジックは lib/columns.ts（落下・回転・連鎖消去）。
// ボタン操作とキーボード（←→移動／↑回転／↓ソフトドロップ／スペース=ハードドロップ）。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useState } from "react";
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

const FALL_MS = 650;
const BEST_KEY = "ago-columns-best";

function newGame(): ColumnsState {
  return createColumnsGame(Date.now() % 2147483647);
}

export default function ColumnsClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<ColumnsState>(() => newGame());
  const [best, setBest] = useState<number | null>(null);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!started) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setState((s) => moveColumns(s, -1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setState((s) => moveColumns(s, 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setState((s) => rotateColumns(s));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setState((s) => stepColumns(s));
      } else if (e.key === " ") {
        e.preventDefault();
        setState((s) => dropColumns(s));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [started]);

  const restart = () => {
    setState(newGame());
    setStarted(true);
  };

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

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>コラムス</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>コラムス</h1>
        <p className="muted">ボタンかキーボードで操作します（←→ 移動／↑ 回転／↓ 1段落とす／スペース 一気に落とす）。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          {started ? "もう一度" : "スタート"}
        </button>
        <button type="button" className="classic-btn" onClick={() => setState((s) => moveColumns(s, -1))} disabled={!started}>
          ← 左
        </button>
        <button type="button" className="classic-btn" onClick={() => setState((s) => rotateColumns(s))} disabled={!started}>
          ↻ 回転
        </button>
        <button type="button" className="classic-btn" onClick={() => setState((s) => moveColumns(s, 1))} disabled={!started}>
          右 →
        </button>
        <button type="button" className="classic-btn" onClick={() => setState((s) => stepColumns(s))} disabled={!started}>
          ↓ 落とす
        </button>
        <button type="button" className="classic-btn" onClick={() => setState((s) => dropColumns(s))} disabled={!started}>
          ⤓ 一気に落とす
        </button>
      </div>

      <p className="classic-status" role="status">
        {state.status === "gameover" ? (
          <span>ゲームオーバー。スコア {state.score} 点でした。</span>
        ) : !started ? (
          <span>スタートを押すと始まります。</span>
        ) : null}
        <span>スコア {state.score}</span>
        <span>消去 {state.cleared} 個</span>
        <span>最大 {state.maxChain} 連鎖</span>
        {best !== null ? <span>ベスト {best}</span> : null}
      </p>

      <div style={{ display: "flex", gap: 16, justifyContent: "center", alignItems: "flex-start", flexWrap: "wrap" }}>
        <div
          role="img"
          aria-label="コラムスの盤面"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${COLUMNS_COLS}, 1fr)`,
            gap: 3,
            width: "min(78vw, 300px)",
            padding: 6,
            background: "#1f2937",
            borderRadius: 10,
          }}
        >
          {cells.map((v, i) => (
            <div
              key={i}
              style={{
                aspectRatio: "1",
                borderRadius: "50%",
                background: v === null ? "rgba(255,255,255,0.07)" : GEM_FILL[v],
                boxShadow: v === null ? "none" : "inset -2px -3px 0 rgba(0,0,0,0.18)",
              }}
            />
          ))}
        </div>
        <div style={{ textAlign: "center" }}>
          <p className="muted" style={{ margin: "0 0 6px", fontSize: 13 }}>
            次
          </p>
          <div style={{ display: "grid", gap: 3, justifyContent: "center" }}>
            {state.next.map((g, i) => (
              <div
                key={i}
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
    </>
  );
}
