"use client";
// フルーツマージ。ロジックは lib/mergefruit.ts（グリッド版マージ）。
// 列を選んでフルーツを落とし、同じ段階が2個以上くっつくと合体して大きくなる。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  createMergeGame,
  dropFruit,
  FRUIT_KINDS,
  landingRow,
  MERGE_COLS,
  type MergeFruitState,
} from "@/lib/mergefruit";
import { useGamesNav } from "../GamesShell";

function newGame(): MergeFruitState {
  return createMergeGame(Date.now() % 2147483647);
}

export default function MergeFruitClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<MergeFruitState>(() => newGame());
  const [best, setBest] = useState<number | null>(null);
  const [hoverCol, setHoverCol] = useState<number | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem("ago-mergefruit-best"));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  useEffect(() => {
    if (state.status !== "gameover" || state.score <= 0) return;
    if (best !== null && state.score <= best) return;
    setBest(state.score);
    try {
      window.localStorage.setItem("ago-mergefruit-best", String(state.score));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, state.score, best]);

  const drop = useCallback((col: number) => {
    setState((s) => dropFruit(s, col));
  }, []);

  // キーボードの左右で列を選び、Enter/↓で落とす（列ボタンはフォーカス可能）。
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (state.status !== "playing") return;
    const cur = hoverCol ?? Math.floor(MERGE_COLS / 2);
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setHoverCol(Math.max(0, cur - 1));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setHoverCol(Math.min(MERGE_COLS - 1, cur + 1));
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      drop(cur);
    }
  };

  const ghostRow = state.status === "playing" && hoverCol !== null ? landingRow(state.board, hoverCol) : -1;

  const statusText =
    state.status === "gameover"
      ? "天井まで積み上がってゲームオーバー。"
      : "同じフルーツが2個以上くっつくと合体して大きくなります。すいかを目指そう。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>フルーツマージ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>フルーツマージ</h1>
        <p className="muted">
          盤のマスか列のボタンをタップして、フルーツを落とします。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button
          type="button"
          className="classic-btn"
          onClick={() => {
            setState(newGame());
            setHoverCol(null);
          }}
        >
          もう一度
        </button>
        <span className="classic-status" role="status" style={{ margin: 0 }}>
          スコア {state.score}
          {best !== null ? ` ・ ベスト ${best}` : ""} ・ 落とした数 {state.dropped}
          {state.maxChain >= 2 ? ` ・ 最大${state.maxChain}連鎖` : ""}
        </span>
      </div>

      <p className="classic-status" role="status">
        {statusText}
      </p>

      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "flex-start",
          flexWrap: "wrap",
          maxWidth: 520,
          margin: "0 auto",
        }}
      >
        <div style={{ flex: "1 1 280px", minWidth: 260 }}>
          <div
            role="grid"
            aria-label="フルーツの箱"
            tabIndex={0}
            onKeyDown={onKeyDown}
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${MERGE_COLS}, minmax(0, 1fr))`,
              gap: 3,
              padding: 6,
              border: "2px solid var(--line)",
              borderTop: "2px dashed #c0392b",
              borderRadius: 8,
              background: "var(--soft)",
              outlineOffset: 2,
            }}
          >
            {state.board.map((v, i) => {
              const r = Math.floor(i / MERGE_COLS);
              const c = i % MERGE_COLS;
              const isGhost = ghostRow === r && hoverCol === c && v === null;
              const kind = v !== null ? FRUIT_KINDS[v] : null;
              return (
                <div
                  key={i}
                  role="gridcell"
                  aria-label={
                    kind ? `${kind.name}（${r + 1}段目・${c + 1}列目）` : `空き（${r + 1}段目・${c + 1}列目）`
                  }
                  onClick={() => drop(c)}
                  onMouseEnter={() => setHoverCol(c)}
                  style={{
                    aspectRatio: "1",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 6,
                    background: isGhost ? "var(--accent-soft)" : "rgba(127,127,127,0.08)",
                    fontSize: "clamp(18px, 6vw, 30px)",
                    lineHeight: 1,
                    cursor: state.status === "playing" ? "pointer" : "default",
                    opacity: isGhost ? 0.45 : 1,
                  }}
                >
                  {kind ? kind.emoji : isGhost ? FRUIT_KINDS[state.current].emoji : ""}
                </div>
              );
            })}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${MERGE_COLS}, minmax(0, 1fr))`,
              gap: 3,
              padding: "6px 6px 0",
            }}
          >
            {Array.from({ length: MERGE_COLS }, (_, c) => (
              <button
                key={c}
                type="button"
                className={hoverCol === c ? "classic-btn classic-btn-active" : "classic-btn"}
                aria-label={`${c + 1}列目に落とす`}
                disabled={state.status !== "playing"}
                onClick={() => drop(c)}
                onMouseEnter={() => setHoverCol(c)}
                style={{ minHeight: 44, padding: "4px 0" }}
              >
                ↓
              </button>
            ))}
          </div>
        </div>

        <div style={{ flex: "0 1 160px", minWidth: 140 }}>
          <div
            style={{
              border: "1px solid var(--line)",
              borderRadius: 8,
              padding: 10,
              marginBottom: 10,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 12, opacity: 0.75 }}>つぎに落とす</div>
            <div role="img" style={{ fontSize: 40, lineHeight: 1.2 }} aria-label={FRUIT_KINDS[state.current].name}>
              {FRUIT_KINDS[state.current].emoji}
            </div>
            <div style={{ fontSize: 13 }}>{FRUIT_KINDS[state.current].name}</div>
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
              そのつぎ: {FRUIT_KINDS[state.next].emoji} {FRUIT_KINDS[state.next].name}
            </div>
          </div>
          <div
            style={{
              border: "1px solid var(--line)",
              borderRadius: 8,
              padding: 10,
              fontSize: 12,
              lineHeight: 1.9,
            }}
            role="group"
            aria-label="フルーツの進化"
          >
            {FRUIT_KINDS.map((k, i) => (
              <div key={k.name} style={{ fontWeight: state.maxLevel === i ? 700 : 400 }}>
                {k.emoji} {k.name}
                {i < FRUIT_KINDS.length - 1 ? " →" : ""}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
