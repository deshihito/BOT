"use client";
// ナイトツアー。ロジックは lib/knightstour.ts（完全ツアーを構成済みで必ず解ける）。
// 光っているマスをタップしてナイトを進める。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const KnightsTourScene3D = dynamic(() => import("./KnightsTourScene3D"), { ssr: false });
import {
  createKnightsTour,
  legalMoves,
  moveKnight,
  undoMove,
  visitOrder,
  type KtState,
} from "@/lib/knightstour";
import { sfxLose, sfxSlide, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const SIZES = [
  { key: 5, label: "5×5" },
  { key: 6, label: "6×6" },
] as const;

type SizeKey = (typeof SIZES)[number]["key"];

function newGame(size: SizeKey): KtState {
  return createKnightsTour(size, Date.now() % 2147483647);
}

export default function KnightsTourClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [size, setSize] = useState<SizeKey>(5);
  const [state, setState] = useState<KtState>(() => newGame(5));
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [resultNewBest, setResultNewBest] = useState(false);
  const [resultPrevBest, setResultPrevBest] = useState<number | null>(null);
  const prevStatusRef = useRef(state.status);

  // 終局遷移の瞬間だけジングルを鳴らし、勝利時はその時点（保存前）のベストで更新判定を控える。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev === state.status) return;
    if (state.status === "won") {
      const isNew = seconds > 0 && (best === null || seconds < best);
      setResultNewBest(isNew);
      setResultPrevBest(isNew ? null : best);
      sfxWin();
    } else if (state.status === "stuck") {
      sfxLose();
    }
  }, [state.status, seconds, best]);

  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(`ago-knightstour-best-${size}`));
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
      window.localStorage.setItem(`ago-knightstour-best-${size}`, String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best, size]);

  const restart = (next: SizeKey) => {
    setSize(next);
    setState(newGame(next));
    setSeconds(0);
    setResultNewBest(false);
    setResultPrevBest(null);
  };

  const handleMove = (i: number) => {
    const next = moveKnight(state, i);
    if (next !== state && next.status === "playing") sfxSlide();
    setState(next);
  };

  const handleUndo = () => {
    sfxTap();
    setState((s) => undoMove(s));
  };

  const order = visitOrder(state);
  const moves = state.status === "playing" || state.status === "stuck" ? legalMoves(state) : [];
  const head = state.path[state.path.length - 1];
  const total = state.size * state.size;

  const statusText =
    state.status === "won"
      ? "全マスを巡回できた！クリアです。"
      : state.status === "stuck"
        ? "行き詰まってしまった。1手戻して別の道を試そう。"
        : state.path.length <= 1
          ? "♞ のあるマスがスタートです。"
          : "光っているマスが次に進める場所です。";

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
  <div
    role="grid"
    aria-label="ナイトツアーの盤"
    style={{
      display: "grid",
      gridTemplateColumns: `repeat(${state.size}, minmax(0, 1fr))`,
      gap: 4,
      maxWidth: 460,
      margin: "0 auto",
    }}
  >
    {order.map((step, i) => {
      const r = Math.floor(i / state.size);
      const c = i % state.size;
      const dark = (r + c) % 2 === 1;
      const isHead = i === head;
      const isMove = moves.includes(i);
      const visited = step > 0;
      return (
        <button
          key={i}
          type="button"
          role="gridcell"
          disabled={!isMove}
          aria-label={
            isHead
              ? `現在位置（${step}手目）`
              : visited
                ? `${step}手目に訪れたマス`
                : isMove
                  ? "次に進めるマス"
                  : "未訪問のマス"
          }
          className={isHead ? "juice-pop" : isMove ? "juice-pulse" : undefined}
          onClick={() => handleMove(i)}
          style={{
            aspectRatio: "1",
            borderRadius: 8,
            border: isHead ? "3px solid var(--accent)" : "1px solid var(--line)",
            background: isMove
              ? "var(--accent-soft)"
              : visited
                ? dark
                  ? "#b8a888"
                  : "#d8cbb0"
                : dark
                  ? "#8a9a7b"
                  : "#e6e2d3",
            color: "#33302a",
            fontSize: state.size === 6 ? 15 : 18,
            fontWeight: isHead ? 800 : 600,
            cursor: isMove ? "pointer" : "default",
            minHeight: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {isHead ? "♞" : visited ? step : isMove ? "・" : ""}
        </button>
      );
    })}
  </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ナイトツアー</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ナイトツアー</h1>
        <p className="muted">光っているマスをタップして、ナイトを進めます。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="盤の大きさ">
        {SIZES.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-pressed={size === s.key}
            className={size === s.key ? "classic-btn classic-btn-active" : "classic-btn"}
            onClick={() => restart(s.key)}
          >
            {s.label}
          </button>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(size)}>
          もう一度
        </button>
        <button
          type="button"
          className="classic-btn"
          disabled={state.path.length <= 1}
          onClick={handleUndo}
        >
          1手戻す
        </button>
      </div>

      <p className="classic-status" role="status">
        {state.path.length} / {total} マス ・ {seconds} 秒
        {best !== null ? ` ・ ベスト ${best} 秒` : ""} ・ {statusText}
      </p>

      {webglFailed ? board2d : (
        <div style={{ width: "100%", maxWidth: 460, margin: "0 auto" }}>
          <KnightsTourScene3D
            size={state.size}
            order={order}
            moves={moves}
            head={head}
            status={state.status}
            onCell={handleMove}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      {state.status === "won" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen
            outcome="win"
            title="全マスを巡回できた！"
            score={seconds}
            scoreLabel="クリアタイム（秒）"
            newBest={resultNewBest}
            previousBest={resultPrevBest}
            onRetry={() => restart(size)}
          >
            <p className="muted">
              {total} マス全てを {state.path.length} 手で巡りました。
            </p>
          </EndScreen>
        </div>
      )}
      {state.status === "stuck" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen outcome="lose" title="行き詰まった…" onRetry={() => restart(size)}>
            <p className="muted">
              {state.path.length} / {total} マスまで進みました。1手戻して別の道も試せます。
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
