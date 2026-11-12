"use client";
// ウォーターソート。ロジックは lib/watersort.ts（完成状態からの逆操作生成で必ず解ける）。
// ボトルをタップして選び、別のボトルをタップして注ぐ。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  canPour,
  createWaterSortGame,
  pourWater,
  undoWaterSort,
  type WsState,
} from "@/lib/watersort";
import { sfxPlace, sfxSlide, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const LIQUID_COLORS = ["#e2534a", "#3366cc", "#3f9e4d", "#f2c230", "#8a55c7", "#ef7d1a", "#2bb3a3"];
const COLOR_NAMES = ["赤", "青", "緑", "黄", "紫", "オレンジ", "水色"];
const BEST_KEY = "ago-watersort-best";

function newGame(): WsState {
  return createWaterSortGame(Date.now() % 2147483647, 5);
}

export default function WaterSortClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<WsState>(() => newGame());
  const [selected, setSelected] = useState<number | null>(null);
  const [best, setBest] = useState<number | null>(null);
  const [resultNewBest, setResultNewBest] = useState(false);
  const [resultPrevBest, setResultPrevBest] = useState<number | null>(null);
  const prevStatusRef = useRef(state.status);

  // 終局遷移の瞬間だけジングルを鳴らし、その時点（保存前）のベストで更新判定を控える。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev === state.status || state.status !== "won") return;
    const isNew = best === null || state.moves < best;
    setResultNewBest(isNew);
    setResultPrevBest(isNew ? null : best);
    sfxWin();
  }, [state.status, state.moves, best]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  useEffect(() => {
    if (state.status !== "won") return;
    if (best !== null && state.moves >= best) return;
    setBest(state.moves);
    try {
      window.localStorage.setItem(BEST_KEY, String(state.moves));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, state.moves, best]);

  const restart = () => {
    setState(newGame());
    setSelected(null);
    setResultNewBest(false);
    setResultPrevBest(null);
  };

  const onBottle = (index: number) => {
    if (state.status !== "playing") return;
    if (selected === null) {
      if (state.bottles[index].length > 0) {
        sfxTap();
        setSelected(index);
      }
      return;
    }
    if (selected === index) {
      sfxTap();
      setSelected(null);
      return;
    }
    if (canPour(state, selected, index)) {
      sfxPlace();
      setState((s) => pourWater(s, selected, index));
      setSelected(null);
    } else if (state.bottles[index].length > 0) {
      // 注げない場合は、タップしたボトルを選び直す。
      sfxTap();
      setSelected(index);
    } else {
      sfxTap();
      setSelected(null);
    }
  };

  const statusText =
    state.status === "won"
      ? `${state.moves} 手で完成！`
      : selected === null
        ? "ボトルをタップして選び、注ぎ先のボトルをタップします。"
        : "注ぎ先のボトルをタップ。同じボトルをもう一度タップすると選び直せます。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ウォーターソート</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ウォーターソート</h1>
        <p className="muted">ボトルを選んで注ぎ分けます。間違えたら「1手戻す」で戻せます。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        <button
          type="button"
          className="classic-btn"
          disabled={state.history.length === 0}
          onClick={() => {
            sfxSlide();
            setState((s) => undoWaterSort(s));
            setSelected(null);
          }}
        >
          1手戻す
        </button>
      </div>

      <p className="classic-status" role="status">
        {state.moves} 手{best !== null ? ` ・ ベスト ${best} 手` : ""} ・ {statusText}
      </p>

      <div
        style={{
          display: "flex",
          gap: 10,
          justifyContent: "center",
          flexWrap: "wrap",
          maxWidth: 520,
          margin: "0 auto",
        }}
        role="group"
        aria-label="ボトル"
      >
        {state.bottles.map((bottle, i) => {
          const isSel = selected === i;
          // 表示は上→下（配列は底→上なので逆順に描く）。
          const slots = Array.from({ length: state.capacity }, (_, k) => {
            const layer = bottle[state.capacity - 1 - k];
            return layer;
          });
          const topName =
            bottle.length > 0 ? COLOR_NAMES[bottle[bottle.length - 1]] : "空";
          const isComplete =
            bottle.length === state.capacity && bottle.every((c) => c === bottle[0]);
          return (
            <button
              key={i}
              type="button"
              className={isComplete ? "juice-pop" : undefined}
              aria-pressed={isSel}
              aria-label={`ボトル ${i + 1}（${bottle.length} 層、一番上は ${topName}）${isSel ? " 選択中" : ""}`}
              onClick={() => onBottle(i)}
              style={{
                width: 52,
                minHeight: 132,
                padding: "6px 6px 8px",
                border: isSel ? "3px solid #3366cc" : "2px solid #9aa3ad",
                borderTop: "2px solid transparent",
                borderRadius: "6px 6px 18px 18px",
                background: "#f8fafc",
                cursor: "pointer",
                transform: isSel ? "translateY(-8px)" : undefined,
                transition: "transform 120ms ease",
                display: "flex",
                flexDirection: "column",
                gap: 2,
                justifyContent: "flex-start",
              }}
            >
              {slots.map((layer, k) => (
                <span
                  key={k}
                  aria-hidden="true"
                  style={{
                    display: "block",
                    height: 24,
                    borderRadius: k === state.capacity - 1 ? "2px 2px 12px 12px" : 2,
                    background: layer === undefined ? "transparent" : LIQUID_COLORS[layer],
                  }}
                />
              ))}
            </button>
          );
        })}
      </div>

      {state.status === "won" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen
            outcome="win"
            score={state.moves}
            scoreLabel="手数"
            newBest={resultNewBest}
            previousBest={resultPrevBest}
            onRetry={restart}
          >
            <p className="muted">ボトル {state.bottles.length} 本を色ごとにそろえました。</p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
