"use client";
// バイナリー（Binairo）。ロジックは lib/binairo.ts（解先行生成・ルール検証で完成判定）。
// マスをタップすると 空き→0→1→空き と切り替わる。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  binairoViolations,
  createBinairoGame,
  cycleBinairoCell,
  type BinairoState,
} from "@/lib/binairo";
import { useGamesNav } from "../GamesShell";

function newGame(): BinairoState {
  return createBinairoGame(Date.now() % 2147483647);
}

export default function BinairoClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<BinairoState>(() => newGame());
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    if (state.status !== "playing" || state.moves === 0) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status, state.moves]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem("ago-binairo-best"));
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
      window.localStorage.setItem("ago-binairo-best", String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best]);

  const restart = () => {
    setState(newGame());
    setSeconds(0);
  };

  const violations = useMemo(() => binairoViolations(state), [state]);
  const badCells = useMemo(() => {
    const set = new Set<number>();
    for (const v of violations) for (const c of v.cells) set.add(c);
    return set;
  }, [violations]);

  const filled = state.board.filter((v) => v !== -1).length;
  const statusText =
    state.status === "won"
      ? "完成！クリアです。"
      : violations.length > 0
        ? violations[0].message
        : "各行・各列で 0 と 1 を3つずつ。同じ数字が3つ並ばないようにしよう。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>バイナリー</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>バイナリー</h1>
        <p className="muted">
          マスをタップすると 空き→0→1→空き と切り替わります。最初から埋まっている太字のマスは固定です。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {filled} / {state.board.length} マス ・ {seconds} 秒
        {best !== null ? ` ・ ベスト ${best} 秒` : ""} ・ {statusText}
      </p>

      <div
        role="grid"
        aria-label="バイナリーの盤"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${state.size}, minmax(0, 1fr))`,
          gap: 4,
          maxWidth: 420,
          margin: "0 auto",
        }}
      >
        {state.board.map((value, i) => {
          const given = state.givens[i];
          const r = Math.floor(i / state.size);
          const c = i % state.size;
          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              aria-label={`${r + 1}行${c + 1}列${given ? "（固定）" : ""} ${value === -1 ? "空き" : value}`}
              disabled={given || state.status === "won"}
              onClick={() => setState((s) => cycleBinairoCell(s, i))}
              style={{
                aspectRatio: "1",
                minWidth: 0,
                padding: 0,
                fontSize: 24,
                fontWeight: given ? 800 : 600,
                cursor: given ? "default" : "pointer",
                color: given ? "var(--text)" : "var(--accent)",
                background: badCells.has(i) ? "#f7e3e0" : given ? "var(--soft)" : "#fff",
                border: "1px solid var(--line)",
                borderRadius: 8,
              }}
            >
              {value === -1 ? "" : value}
            </button>
          );
        })}
      </div>
    </>
  );
}
