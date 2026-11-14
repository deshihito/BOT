"use client";
// フルーツマージ。ロジックは lib/mergefruit.ts（グリッド版マージ）。
// 列を選んでフルーツを落とし、同じ段階が2個以上くっつくと合体して大きくなる。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const MergeFruitScene3D = dynamic(() => import("./MergeFruitScene3D"), { ssr: false });
import { sfxLose, sfxPop, sfxSlide, sfxTap } from "@/lib/sfx";
import { EndScreen, ScorePop } from "../GameJuice";
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

/** フルーツを色付き円バッジ（色＋頭文字）で描く。絵文字は使わない。 */
function FruitBadge({ level, size }: { level: number; size: number }) {
  const k = FRUIT_KINDS[level];
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        background: k.color,
        color: k.ink,
        fontSize: Math.round(size * 0.52),
        fontWeight: 800,
        lineHeight: 1,
        flex: "0 0 auto",
      }}
    >
      {k.mark}
    </span>
  );
}

export default function MergeFruitClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<MergeFruitState>(() => newGame());
  const [webglFailed, setWebglFailed] = useState(false);
  const [best, setBest] = useState<number | null>(null);
  const [prevBest, setPrevBest] = useState<number | null>(null);
  const [isNewBest, setIsNewBest] = useState(false);
  const [scorePop, setScorePop] = useState<{ amount: number; key: number } | null>(null);
  const [hoverCol, setHoverCol] = useState<number | null>(null);
  const prevRef = useRef<{ score: number; dropped: number; status: string } | null>(null);

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
    setPrevBest(best);
    if (best !== null && state.score <= best) {
      setIsNewBest(false);
      return;
    }
    setIsNewBest(best !== null);
    setBest(state.score);
    try {
      window.localStorage.setItem("ago-mergefruit-best", String(state.score));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
    // ベスト保存はゲームオーバー時に1回だけ行う（best の変化で再実行しない）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.score]);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { score: state.score, dropped: state.dropped, status: state.status };
    if (!prev) return;
    if (state.status === "gameover" && prev.status !== "gameover") {
      sfxLose();
      return;
    }
    if (state.dropped > prev.dropped) {
      if (state.score > prev.score) {
        sfxPop();
        setScorePop({ amount: state.score - prev.score, key: state.dropped });
      } else {
        sfxSlide();
      }
    }
  }, [state.score, state.dropped, state.status]);

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

  // 2D 盤面（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
    <div style={{ flex: "1 1 280px", minWidth: 260 }}>
      <div
        role="grid"
        aria-label="フルーツの箱"
        className={state.status === "gameover" ? "juice-shake" : undefined}
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
              {kind ? <FruitBadge level={v as number} size={30} /> : isGhost ? <FruitBadge level={state.current} size={30} /> : ""}
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
  );

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
            sfxTap();
            setIsNewBest(false);
            setPrevBest(null);
            setScorePop(null);
            prevRef.current = null;
            setState(newGame());
            setHoverCol(null);
          }}
        >
          もう一度
        </button>
        <span className="classic-status" role="status" style={{ margin: 0 }}>
          スコア {state.score}
          {scorePop ? <ScorePop key={scorePop.key} amount={scorePop.amount} /> : null}
          {best !== null ? ` ・ ベスト ${best}` : ""} ・ 落とした数 {state.dropped}
          {state.maxChain >= 2 ? ` ・ 最大${state.maxChain}連鎖` : ""}
        </span>
      </div>

      <p className="classic-status" role="status">
        {statusText}
      </p>

      {state.status === "gameover" && (
        <EndScreen
          outcome="lose"
          title="ゲームオーバー"
          score={state.score}
          scoreLabel="スコア"
          newBest={isNewBest}
          previousBest={isNewBest ? null : prevBest}
          onRetry={() => {
            sfxTap();
            setIsNewBest(false);
            setPrevBest(null);
            setScorePop(null);
            prevRef.current = null;
            setState(newGame());
            setHoverCol(null);
          }}
        >
          <p className="muted" style={{ margin: 0 }}>
            天井まで積み上がってゲームオーバー。落とした数 {state.dropped}
            {state.maxChain >= 2 ? ` ・ 最大${state.maxChain}連鎖` : ""}
          </p>
        </EndScreen>
      )}

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
        {webglFailed ? board2d : (
          <div style={{ flex: "1 1 280px", minWidth: 260 }}>
            <MergeFruitScene3D
              board={state.board}
              current={state.current}
              next={state.next}
              hoverCol={hoverCol}
              status={state.status}
              onHoverCol={setHoverCol}
              onDrop={drop}
              onFail={() => setWebglFailed(true)}
              fallback={board2d}
            />
          </div>
        )}

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
            <div
              key={state.dropped}
              className="juice-pop"
              role="img"
              style={{ lineHeight: 1.2 }}
              aria-label={FRUIT_KINDS[state.current].name}
            >
              <FruitBadge level={state.current} size={44} />
            </div>
            <div style={{ fontSize: 13 }}>{FRUIT_KINDS[state.current].name}</div>
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
              そのつぎ: <FruitBadge level={state.next} size={16} /> {FRUIT_KINDS[state.next].name}
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
              <div key={k.name} style={{ fontWeight: state.maxLevel === i ? 700 : 400, display: "flex", alignItems: "center", gap: 5 }}>
                <FruitBadge level={i} size={17} /> {k.name}
                {i < FRUIT_KINDS.length - 1 ? " →" : ""}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
