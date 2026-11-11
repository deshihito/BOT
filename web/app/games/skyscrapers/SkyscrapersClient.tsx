"use client";
// ビルディング（Skyscrapers）。ロジックは lib/skyscrapers.ts（解先行生成・ルール検証で完成判定）。
// マスを選んで下の数字パッドで高さを入れる。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  createSkyscrapersGame,
  setSkyValue,
  skyViolations,
  type SkyscrapersSize,
  type SkyscrapersState,
} from "@/lib/skyscrapers";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = (size: number) => `ago-skyscrapers-best-${size}`;
/** 難易度「一部隠す」で隠すヒントの数。 */
const HIDE_COUNT = (size: number) => (size === 5 ? 7 : 5);

function newGame(size: SkyscrapersSize, hard: boolean): SkyscrapersState {
  return createSkyscrapersGame(size, Date.now() % 2147483647, hard ? HIDE_COUNT(size) : 0);
}

export default function SkyscrapersClient() {
  const { prefix } = useGamesNav();
  const [size, setSize] = useState<SkyscrapersSize>(4);
  const [hard, setHard] = useState(false);
  const [state, setState] = useState<SkyscrapersState>(() => newGame(4, false));
  const [selected, setSelected] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);

  useEffect(() => {
    if (state.status !== "playing" || state.moves === 0) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status, state.moves]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY(size)));
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
      window.localStorage.setItem(BEST_KEY(size), String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best, size]);

  const restart = (nextSize: SkyscrapersSize, nextHard: boolean) => {
    setSize(nextSize);
    setHard(nextHard);
    setState(newGame(nextSize, nextHard));
    setSelected(null);
    setSeconds(0);
  };

  const violations = useMemo(() => skyViolations(state), [state]);
  const badCells = useMemo(() => {
    const set = new Set<number>();
    for (const v of violations) for (const c of v.cells) set.add(c);
    return set;
  }, [violations]);

  const filled = state.values.filter((v) => v !== 0).length;
  const statusText =
    state.status === "won"
      ? "完成！クリアです。"
      : violations.length > 0
        ? violations[0].message
        : "行と列に同じ高さは1つだけ。外側の数字は、そこから見えるビルの数です。";

  const n = state.size;
  const gridCells: React.ReactNode[] = [];
  for (let gr = 0; gr < n + 2; gr++) {
    for (let gc = 0; gc < n + 2; gc++) {
      const key = `${gr}-${gc}`;
      const isCorner = (gr === 0 || gr === n + 1) && (gc === 0 || gc === n + 1);
      if (isCorner) {
        gridCells.push(<div key={key} aria-hidden />);
        continue;
      }
      if (gr === 0 || gr === n + 1 || gc === 0 || gc === n + 1) {
        // 外周ヒント。隠したヒント（0）だけ aria-hidden にし、表示中のヒントは読み上げ可能にする。
        let clue = 0;
        let clueLabel = "";
        if (gr === 0) {
          clue = state.clues.top[gc - 1];
          clueLabel = `${gc}列目 上のヒント ${clue}`;
        } else if (gr === n + 1) {
          clue = state.clues.bottom[gc - 1];
          clueLabel = `${gc}列目 下のヒント ${clue}`;
        } else if (gc === 0) {
          clue = state.clues.left[gr - 1];
          clueLabel = `${gr}行目 左のヒント ${clue}`;
        } else {
          clue = state.clues.right[gr - 1];
          clueLabel = `${gr}行目 右のヒント ${clue}`;
        }
        gridCells.push(
          <div
            key={key}
            role={clue === 0 ? undefined : "img"}
            aria-hidden={clue === 0}
            aria-label={clue === 0 ? undefined : clueLabel}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 17,
              fontWeight: 700,
              color: clue === 0 ? "transparent" : "var(--muted)",
              minHeight: 40,
            }}
          >
            {clue === 0 ? "・" : clue}
          </div>,
        );
        continue;
      }
      const index = (gr - 1) * n + (gc - 1);
      const value = state.values[index];
      const isSelected = selected === index;
      gridCells.push(
        <button
          key={key}
          type="button"
          role="gridcell"
          aria-label={`${gr}行${gc}列 ${value === 0 ? "空き" : `高さ ${value}`}`}
          aria-pressed={isSelected}
          disabled={state.status === "won"}
          onClick={() => setSelected(index)}
          style={{
            aspectRatio: "1",
            minWidth: 0,
            padding: 0,
            fontSize: 22,
            fontWeight: 700,
            cursor: "pointer",
            color: "var(--text)",
            background: badCells.has(index) ? "#f7e3e0" : isSelected ? "var(--accent-soft)" : "#fff",
            border: isSelected ? "2px solid var(--accent)" : "1px solid var(--line)",
            borderRadius: 8,
          }}
        >
          {value === 0 ? "" : value}
        </button>,
      );
    }
  }

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ビルディング</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ビルディング</h1>
        <p className="muted">
          マスをタップして選び、下の数字パッドでビルの高さを入れます。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        {([4, 5] as SkyscrapersSize[]).map((s) => (
          <button
            key={s}
            type="button"
            className={`classic-btn${size === s ? " classic-btn-active" : ""}`}
            aria-pressed={size === s}
            onClick={() => restart(s, hard)}
          >
            {s}×{s}
          </button>
        ))}
        <button
          type="button"
          className={`classic-btn${hard ? " classic-btn-active" : ""}`}
          aria-pressed={hard}
          onClick={() => restart(size, !hard)}
        >
          ヒント一部隠し
        </button>
        <button type="button" className="classic-btn" onClick={() => restart(size, hard)}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {filled} / {n * n} マス ・ {seconds} 秒
        {best !== null ? ` ・ ベスト ${best} 秒` : ""} ・ {statusText}
      </p>

      <div
        role="grid"
        aria-label="ビルディングの盤"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${n + 2}, minmax(0, 1fr))`,
          gap: 4,
          maxWidth: 460,
          margin: "0 auto",
        }}
      >
        {gridCells}
      </div>

      <div
        role="group"
        aria-label="数字パッド"
        style={{
          display: "flex",
          gap: 6,
          justifyContent: "center",
          flexWrap: "wrap",
          marginTop: 14,
        }}
      >
        {Array.from({ length: n }, (_, i) => i + 1).map((v) => (
          <button
            key={v}
            type="button"
            className="classic-btn"
            style={{ minWidth: 48, minHeight: 48, fontSize: 18, fontWeight: 700 }}
            disabled={selected === null || state.status === "won"}
            onClick={() => selected !== null && setState((s) => setSkyValue(s, selected, v))}
          >
            {v}
          </button>
        ))}
        <button
          type="button"
          className="classic-btn"
          style={{ minWidth: 64, minHeight: 48 }}
          disabled={selected === null || state.status === "won"}
          onClick={() => selected !== null && setState((s) => setSkyValue(s, selected, 0))}
        >
          消す
        </button>
      </div>
    </>
  );
}
