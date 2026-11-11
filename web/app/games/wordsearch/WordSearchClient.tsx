"use client";
// ワードサーチ。ロジックは lib/wordsearch.ts。端末内で完結し、サーバーへ送信しない。
// 単語の選択は「始点タップ → 終点タップ」の2タップ式（ドラッグ不要でスマホ向け）。
// 選択した直線が配置単語（逆順でも可）と一致すれば発見になる。
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  createWordSearch,
  selectLine,
  wsLineCells,
  type WordSearchState,
} from "@/lib/wordsearch";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-wordsearch-best";

function newGame(): WordSearchState {
  return createWordSearch(Date.now() % 2147483647);
}

export default function WordSearchClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<WordSearchState>(() => newGame());
  const [firstTap, setFirstTap] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, []);

  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

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

  const foundCells = useMemo(() => {
    const set = new Set<number>();
    for (const p of state.placements) {
      if (state.found.includes(p.word)) {
        for (const c of p.cells) set.add(c);
      }
    }
    return set;
  }, [state]);

  // 始点だけ選ばれている間は、直線のプレビューとして始点マスを強調する。
  const previewCells = useMemo(() => {
    if (firstTap === null) return new Set<number>();
    return new Set([firstTap]);
  }, [firstTap]);

  const restart = () => {
    setState(newGame());
    setFirstTap(null);
    setSeconds(0);
    setMessage(null);
  };

  const onCell = (index: number) => {
    if (state.status !== "playing") return;
    if (firstTap === null) {
      setFirstTap(index);
      setMessage("単語の最後の文字をタップしてください。");
      return;
    }
    if (index === firstTap) {
      setFirstTap(null);
      setMessage(null);
      return;
    }
    const line = wsLineCells(firstTap, index, state.size);
    if (!line) {
      // 直線にならない場合は、終点候補を選び直す。
      setFirstTap(index);
      setMessage("縦・横・斜めの直線になるように選んでください。");
      return;
    }
    const before = state.found.length;
    const next = selectLine(state, firstTap, index);
    setState(next);
    setFirstTap(null);
    if (next.found.length > before) {
      const word = next.found[next.found.length - 1];
      setMessage(`「${word}」を見つけました！`);
    } else {
      setMessage("その単語はありませんでした。");
    }
  };

  const statusText =
    state.status === "won"
      ? `全部見つけました！クリアです（${seconds} 秒）。`
      : `${state.found.length} / ${state.placements.length} 語発見 ・ ${seconds} 秒${best !== null ? ` ・ ベスト ${best} 秒` : ""}${state.mistakes > 0 ? ` ・ はずれ ${state.mistakes} 回` : ""}`;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ワードサーチ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ワードサーチ</h1>
        <p className="muted">
          単語の最初の文字、最後の文字の順にタップして選んでください。縦・横・斜めの直線で、逆向きに選んでも見つかります。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {statusText}
        {message ? ` ・ ${message}` : ""}
      </p>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div
          role="grid"
          aria-label="ワードサーチの文字盤"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${state.size}, minmax(0, 1fr))`,
            gap: 3,
            width: "100%",
            maxWidth: 430,
          }}
        >
          {state.grid.map((ch, i) => {
            const isFound = foundCells.has(i);
            const isFirst = previewCells.has(i);
            return (
              <button
                key={i}
                type="button"
                role="gridcell"
                aria-label={`文字 ${ch}`}
                aria-pressed={isFirst}
                onClick={() => onCell(i)}
                style={{
                  aspectRatio: "1",
                  minWidth: 0,
                  border: `2px solid ${isFirst ? "#b45309" : isFound ? "#15803d" : "#d8c9a3"}`,
                  borderRadius: 6,
                  background: isFirst ? "#fef3c7" : isFound ? "#dcfce7" : "#fffdf6",
                  color: "#1f2937",
                  fontSize: 17,
                  fontWeight: 700,
                  lineHeight: 1,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                {ch}
              </button>
            );
          })}
        </div>

        <div style={{ minWidth: 180, flex: "1 1 180px" }}>
          <p style={{ fontWeight: 800, margin: "0 0 8px" }}>探す単語</p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {state.placements.map((p) => {
              const found = state.found.includes(p.word);
              return (
                <li
                  key={p.word}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "1px solid #e5e7eb",
                    background: found ? "#f0fdf4" : "#fff",
                    color: found ? "#15803d" : "#1f2937",
                    textDecoration: found ? "line-through" : "none",
                    fontWeight: 700,
                    letterSpacing: 2,
                  }}
                >
                  {p.word}
                  {found ? " ✓" : ""}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </>
  );
}
