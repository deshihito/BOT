"use client";
// カックロ。ロジックは lib/kakuro.ts（完成盤先行生成・ルール検証で完成判定）。
// マスを選んで下の数字パッドから入力する。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const KakuroScene3D = dynamic(() => import("./KakuroScene3D"), { ssr: false });
import {
  checkKakuro,
  createKakuroGame,
  setKakuroValue,
  type KakuroState,
  type KakuroViolation,
} from "@/lib/kakuro";
import { sfxCorrect, sfxPlace, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-kakuro-best";

function newGame(): KakuroState {
  return createKakuroGame(Date.now() % 2147483647);
}

export default function KakuroClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [state, setState] = useState<KakuroState>(() => newGame());
  const [selected, setSelected] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [checked, setChecked] = useState<KakuroViolation[] | null>(null);
  const [resultNewBest, setResultNewBest] = useState(false);
  const [resultPrevBest, setResultPrevBest] = useState<number | null>(null);
  const prevStatusRef = useRef(state.status);

  // 終局遷移の瞬間だけジングルを鳴らし、その時点（保存前）のベストで更新判定を控える。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev === state.status || state.status !== "won") return;
    const isNew = seconds > 0 && (best === null || seconds < best);
    setResultNewBest(isNew);
    setResultPrevBest(isNew ? null : best);
    sfxWin();
  }, [state.status, seconds, best]);

  // 最初の白マス（与え数字でない）を初期選択にする。
  useEffect(() => {
    const first = state.cells.findIndex((c) => c.kind === "white" && !c.given);
    if (first >= 0) setSelected(first);
    // 初回マウント時のみ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
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
      window.localStorage.setItem(BEST_KEY, String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best]);

  const restart = () => {
    const g = newGame();
    setState(g);
    const first = g.cells.findIndex((c) => c.kind === "white" && !c.given);
    setSelected(first >= 0 ? first : 0);
    setSeconds(0);
    setChecked(null);
    setResultNewBest(false);
    setResultPrevBest(null);
  };

  const input = (value: number) => {
    setChecked(null);
    const next = setKakuroValue(state, selected, value);
    if (next !== state && next.status !== "won") {
      if (value === 0) sfxTap();
      else sfxPlace();
    }
    setState(next);
  };

  const handleCheck = () => {
    const result = checkKakuro(state);
    if (result.violations.length === 0) sfxCorrect();
    else sfxWrong();
    setChecked(result.violations);
  };

  // 盤面の下スワイプ = チェック。子のマスの onClick との二重発火は
  // useGesture の suppressClickAfterSwipe が抑止する。
  const boardGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "down") handleCheck();
    },
  });

  // 物理キーボードでも数字を入れられる（画面パッドの代替）。
  // パッドの div は Enter/Space のみ受けるため数字キーとの二重発火はない。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (/^[1-9]$/.test(e.key)) input(Number(e.key));
      else if (e.key === "Backspace" || e.key === "Delete") input(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [input]);

  const badCells = useMemo(() => {
    const set = new Set<number>();
    if (checked) for (const v of checked) for (const c of v.cells) set.add(c);
    return set;
  }, [checked]);

  const selectCell = (i: number) => {
    const cell = state.cells[i];
    if (!cell || cell.kind !== "white" || cell.given) return;
    sfxTap();
    setSelected(i);
  };

  const size = state.size;
  const statusText =
    state.status === "won"
      ? "完成！クリアです。"
      : checked !== null
        ? checked.length === 0
          ? "いまのところルール違反はありません。"
          : checked[0].message
        : "白マスを選んで、下の数字パッドで入力します。盤面を下にスワイプするとチェックできます。";

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
      <div
        {...boardGesture}
        role="grid"
        aria-label="カックロの盤（下にスワイプでチェック）"
        tabIndex={0}
        onKeyDown={(e) => {
          // 盤面そのものにフォーカスがあるときだけ Enter でチェックする。
          // ガードがないとマスにフォーカスして Enter を押したときに選択と
          // チェックが両方走る（anagram / mastermind と同じ構図）。
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleCheck();
          }
        }}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))`,
          maxWidth: 460,
          margin: "0 auto",
          border: "3px solid var(--text)",
          touchAction: "none",
        }}
      >
        {state.cells.map((cell, i) => {
          const r = Math.floor(i / size);
          const c = i % size;
          if (cell.kind === "black") {
            const clueLabel = [
              cell.across !== null ? `右の合計 ${cell.across}` : null,
              cell.down !== null ? `下の合計 ${cell.down}` : null,
            ]
              .filter(Boolean)
              .join("、");
            return (
              <div
                key={i}
                {...(clueLabel
                  ? { role: "img" as const, "aria-label": clueLabel }
                  : { "aria-hidden": true })}
                style={{
                  position: "relative",
                  aspectRatio: "1",
                  minWidth: 0,
                  background:
                    "linear-gradient(to top right, #2b2f36 49.3%, #9aa0a8 49.3%, #9aa0a8 50.7%, #3a3f47 50.7%)",
                  border: "1px solid #22252a",
                }}
              >
                {cell.across !== null ? (
                  <span
                    style={{
                      position: "absolute",
                      top: 1,
                      right: 4,
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#fff",
                    }}
                  >
                    {cell.across}
                  </span>
                ) : null}
                {cell.down !== null ? (
                  <span
                    style={{
                      position: "absolute",
                      bottom: 1,
                      left: 4,
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#fff",
                    }}
                  >
                    {cell.down}
                  </span>
                ) : null}
              </div>
            );
          }
          const value = state.values[i];
          return (
            <div
              key={i}
              role="gridcell"
              tabIndex={cell.given ? -1 : 0}
              aria-label={`${r + 1}行${c + 1}列${value ? ` ${value}` : ""}${cell.given ? "（はじめから入っている数字）" : ""}`}
              aria-pressed={selected === i}
              aria-disabled={cell.given || undefined}
              className={badCells.has(i) ? "juice-shake" : value !== 0 && !cell.given ? "juice-pop" : undefined}
              onClick={
                cell.given
                  ? undefined
                  : () => {
                      sfxTap();
                      setSelected(i);
                    }
              }
              onKeyDown={
                cell.given
                  ? undefined
                  : (e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      sfxTap();
                      setSelected(i);
                    }
              }
              style={{
                aspectRatio: "1",
                minWidth: 0,
                padding: 0,
                cursor: cell.given ? "default" : "pointer",
                fontSize: 20,
                fontWeight: cell.given ? 800 : 600,
                color: cell.given ? "var(--muted)" : "var(--text)",
                background: badCells.has(i)
                  ? "#f7e3e0"
                  : cell.given
                    ? "var(--soft)"
                    : selected === i
                      ? "var(--accent-soft)"
                      : "#fff",
                border: "1px solid var(--line)",
              }}
            >
              {value !== 0 ? value : ""}
            </div>
          );
        })}
      </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>カックロ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>カックロ</h1>
        <p className="muted">
          黒マスの右上の数字は右方向の合計、左下の数字は下方向の合計です。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {seconds} 秒{best !== null ? ` ・ ベスト ${best} 秒` : ""} ・ {statusText}
      </p>

      {webglFailed ? board2d : (
        <div style={{ width: "100%", maxWidth: 460, margin: "0 auto" }}>
          <KakuroScene3D
            cells={state.cells}
            values={state.values}
            size={size}
            selected={selected}
            badCells={badCells}
            onCell={selectCell}
            onCheck={handleCheck}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}


      <div
        className="classic-controls"
        role="group"
        aria-label="数字入力"
        style={{ justifyContent: "center", marginTop: 14 }}
      >
        {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => (
          <div
            key={n}
            {...tappableProps(() => input(n))}
            className="classic-btn"
            style={{ minWidth: 40, minHeight: 44, fontSize: 17, fontWeight: 700 }}
          >
            {n}
          </div>
        ))}
        <div
          {...tappableProps(() => input(0))}
          className="classic-btn"
          style={{ minWidth: 44, minHeight: 44 }}
        >
          消す
        </div>
      </div>

      {state.status === "won" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen
            outcome="win"
            title="完成！"
            score={seconds}
            scoreLabel="クリアタイム（秒）"
            newBest={resultNewBest}
            previousBest={resultPrevBest}
            onRetry={restart}
          >
            <p className="muted">すべての合計がそろいました。</p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
