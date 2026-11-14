"use client";
// フォーリングブロック（落下パズル）。ロジックは lib/falling.ts（純粋関数）。
// キーボードと盤面のスワイプ／タップの両方で操作でき、端末内で完結する（サーバー送信なし）。
// ベストスコアは localStorage の ago-falling-best に保存する。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const FallingScene3D = dynamic(() => import("./FallingScene3D"), { ssr: false });
import {
  FALLING_COLS,
  FALLING_PIECE_COLORS,
  FALLING_ROWS,
  createFallingGame,
  dropIntervalMs,
  getActiveCells,
  getPieceCells,
  ghostY,
  hardDrop,
  holdPiece,
  moveDown,
  moveLeft,
  moveRight,
  rotatePiece,
  softDrop,
  type FallingCell,
  type FallingPieceType,
  type FallingState,
} from "@/lib/falling";
import { sfxCorrect, sfxLose, sfxPlace, sfxTap, sfxWin } from "@/lib/sfx";
import { tappableProps, useGesture, type GestureDirection } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-falling-best";

function loadBest(): number {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function Preview({ type, label }: { type: FallingPieceType | null; label: string }) {
  const cells = type ? getPieceCells(type, 0) : [];
  const keySet = new Set(cells.map((c) => `${c.x},${c.y}`));
  // ピースごとにバウンディングボックスの大きさが違うため、表示は4×3に正規化する。
  const maxX = cells.length ? Math.max(...cells.map((c) => c.x)) : 0;
  const maxY = cells.length ? Math.max(...cells.map((c) => c.y)) : 0;
  const cols = Math.max(1, maxX + 1);
  const rows = Math.max(1, maxY + 1);
  return (
    <div style={{ display: "grid", gap: 4, justifyItems: "center" }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: "#666" }}>{label}</span>
      <div
        aria-label={type ? `${label}: ${type}` : `${label}: なし`}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, 16px)`,
          gridTemplateRows: `repeat(${rows}, 16px)`,
          gap: 2,
          minHeight: 34,
          alignContent: "center",
        }}
      >
        {Array.from({ length: cols * rows }, (_, i) => {
          const x = i % cols;
          const y = Math.floor(i / cols);
          const filled = type !== null && keySet.has(`${x},${y}`);
          return (
            <span
              key={i}
              style={{
                width: 16,
                height: 16,
                borderRadius: 3,
                background: filled ? FALLING_PIECE_COLORS[type as FallingPieceType] : "transparent",
                boxShadow: filled ? "inset 0 0 0 1px rgba(0,0,0,0.25)" : "none",
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

export default function FallingClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [state, setState] = useState<FallingState>(() => createFallingGame(Date.now() % 2147483647));
  const [paused, setPaused] = useState(false);
  const [best, setBest] = useState(0);
  const [resultNewBest, setResultNewBest] = useState(false);
  const [resultPrevBest, setResultPrevBest] = useState<number | null>(null);
  const prevStatusRef = useRef(state.status);
  const prevLinesRef = useRef(state.lines);
  const sessionBestRef = useRef(0);
  const statusRef = useRef(state.status);
  statusRef.current = state.status;
  // 3D シーンが毎フレーム読む最新の状態（React 再描画を介さない）。
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const loaded = loadBest();
    setBest(loaded);
    sessionBestRef.current = loaded;
  }, []);

  // 終局遷移の瞬間だけジングルを鳴らす（ベストは対局開始時点の値で判定する）。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev === state.status || state.status !== "gameover") return;
    const isNew = state.score > sessionBestRef.current;
    setResultNewBest(isNew);
    setResultPrevBest(isNew ? null : sessionBestRef.current > 0 ? sessionBestRef.current : null);
    if (isNew) sfxWin();
    else sfxLose();
  }, [state.status, state.score]);

  // ライン消去の瞬間に正解音を鳴らす。
  useEffect(() => {
    const prev = prevLinesRef.current;
    prevLinesRef.current = state.lines;
    if (state.lines > prev) sfxCorrect();
  }, [state.lines]);

  useEffect(() => {
    if (state.score > best) {
      setBest(state.score);
      try {
        localStorage.setItem(BEST_KEY, String(state.score));
      } catch {
        // 保存できなくてもプレイは続けられる
      }
    }
  }, [state.score, best]);

  // 自動落下（レベルで間隔が短くなる）
  useEffect(() => {
    if (state.status !== "playing" || paused) return;
    const id = setInterval(() => {
      setState((s) => moveDown(s));
    }, dropIntervalMs(state.level));
    return () => clearInterval(id);
  }, [state.level, state.status, paused]);

  const restart = useCallback(() => {
    setPaused(false);
    sessionBestRef.current = loadBest();
    setResultNewBest(false);
    setResultPrevBest(null);
    setState(createFallingGame(Date.now() % 2147483647));
  }, []);

  const act = useCallback((fn: (s: FallingState) => FallingState) => {
    setState((s) => (s.status === "playing" ? fn(s) : s));
  }, []);

  const actHardDrop = useCallback(() => {
    if (statusRef.current !== "playing") return;
    sfxPlace();
    act(hardDrop);
  }, [act]);

  const actHold = useCallback(() => {
    if (statusRef.current !== "playing") return;
    sfxTap();
    act(holdPiece);
  }, [act]);

  // 盤面ジェスチャと 3D シーンで共有する操作ハンドラ:
  // 左右スワイプ=移動、下スワイプ=ソフトドロップ、タップ=回転、
  // 上スワイプ=ハードドロップ（操作パッド廃止）。
  const handleSwipe = useCallback(
    (dir: GestureDirection) => {
      if (paused) return;
      if (dir === "left") act(moveLeft);
      else if (dir === "right") act(moveRight);
      else if (dir === "down") act(softDrop);
      else if (dir === "up") actHardDrop();
    },
    [act, actHardDrop, paused],
  );
  const handleTap = useCallback(() => {
    if (paused) return;
    act((s) => rotatePiece(s, 1));
  }, [act, paused]);

  const boardGesture = useGesture({
    onSwipe: handleSwipe,
    onTap: handleTap,
  });

  // 3D シーンへ渡す表示状態（ゴーストと落下中セルはここで lib の関数で計算する）。
  const getViewState = useCallback(() => {
    const s = stateRef.current;
    const g = s.status === "playing" ? ghostY(s) : s.active.y;
    const ghostCells: Array<{ x: number; y: number; type: FallingPieceType }> = [];
    if (s.status === "playing" && g !== s.active.y) {
      for (const c of getPieceCells(s.active.type, s.active.rotation)) {
        const x = s.active.x + c.x;
        const y = g + c.y;
        if (x >= 0 && x < FALLING_COLS && y >= 0 && y < FALLING_ROWS) ghostCells.push({ x, y, type: s.active.type });
      }
    }
    const activeCells: Array<{ x: number; y: number; type: FallingPieceType }> = [];
    for (const c of getActiveCells(s)) {
      if (c.x >= 0 && c.x < FALLING_COLS && c.y >= 0 && c.y < FALLING_ROWS) {
        activeCells.push({ x: c.x, y: c.y, type: s.active.type });
      }
    }
    return { board: s.board, activeCells, ghostCells, status: s.status, placed: s.placed };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      // HOLD・一時停止の div にフォーカスがあるときの Space は tappableProps が
      // 受けるため、window 側のハードドロップと二重発火しないよう無視する
      // （reaction の Space 二重発火の教訓）。
      if (e.key === " " && target?.closest?.("[data-falling-ui]")) return;
      if (e.key === "p" || e.key === "P") {
        setPaused((v) => !v);
        return;
      }
      if (paused) return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          act(moveLeft);
          break;
        case "ArrowRight":
          e.preventDefault();
          act(moveRight);
          break;
        case "ArrowDown":
          e.preventDefault();
          act(softDrop);
          break;
        case "ArrowUp":
        case "x":
        case "X":
          e.preventDefault();
          act((s) => rotatePiece(s, 1));
          break;
        case "z":
        case "Z":
          e.preventDefault();
          act((s) => rotatePiece(s, -1));
          break;
        case " ":
          e.preventDefault();
          actHardDrop();
          break;
        case "c":
        case "C":
          e.preventDefault();
          actHold();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, actHardDrop, actHold, paused]);

  // 表示用盤面: 固定ブロック + ゴースト + 落下中ピースを重ねる
  const ghost = state.status === "playing" ? ghostY(state) : state.active.y;
  const ghostCells = new Set<string>();
  if (state.status === "playing" && ghost !== state.active.y) {
    for (const c of getPieceCells(state.active.type, state.active.rotation)) {
      ghostCells.add(`${state.active.x + c.x},${ghost + c.y}`);
    }
  }
  const activeCells = new Map<string, FallingPieceType>();
  for (const c of getActiveCells(state)) {
    if (c.y >= 0 && c.y < FALLING_ROWS && c.x >= 0 && c.x < FALLING_COLS) {
      activeCells.set(`${c.x},${c.y}`, state.active.type);
    }
  }

  const gameOver = state.status === "gameover";
  const statusText = gameOver
    ? `ゲームオーバー。スコア ${state.score}（ベスト ${Math.max(best, state.score)}）でした。`
    : paused
      ? "一時停止中です。Pキーか一時停止表示のタップで再開できます。"
      : "";

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
        <div
          {...boardGesture}
          role="grid"
          aria-label="フォーリングブロックの盤（左右スワイプで移動、下スワイプでソフトドロップ、タップで回転、上スワイプでハードドロップ）"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${FALLING_COLS}, minmax(0, 1fr))`,
            gap: 2,
            width: "min(78vw, 320px)",
            aspectRatio: `${FALLING_COLS} / ${FALLING_ROWS}`,
            padding: 6,
            borderRadius: 10,
            background: "#1d2433",
            border: "2px solid #11182a",
            touchAction: "none",
          }}
        >
          {Array.from({ length: FALLING_ROWS * FALLING_COLS }, (_, i) => {
            const x = i % FALLING_COLS;
            const y = Math.floor(i / FALLING_COLS);
            const fixed: FallingCell = state.board[i];
            const activeType = activeCells.get(`${x},${y}`);
            const isGhost = !fixed && !activeType && ghostCells.has(`${x},${y}`);
            const color = activeType
              ? FALLING_PIECE_COLORS[activeType]
              : fixed
                ? FALLING_PIECE_COLORS[fixed]
                : null;
            return (
              <span
                key={i}
                role="gridcell"
                aria-hidden="true"
                style={{
                  borderRadius: 2,
                  background: color ?? (isGhost ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.07)"),
                  boxShadow: color
                    ? "inset 0 0 0 1px rgba(0,0,0,0.3)"
                    : isGhost
                      ? `inset 0 0 0 2px ${FALLING_PIECE_COLORS[state.active.type]}`
                      : "none",
                }}
              />
            );
          })}
        </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>フォーリングブロック</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>フォーリングブロック</h1>
        <p className="muted">落ちてくるブロックをそろえてラインを消す落下パズル。盤面のスワイプ・タップとキー操作に対応しています。</p>
      </div>

      <p className="classic-status" role="status">
        スコア {state.score} ・ ベスト {Math.max(best, state.score)} ・ ライン {state.lines} ・ レベル {state.level}
        {statusText ? ` ・ ${statusText}` : ""}
      </p>

      <div
        style={{
          display: "flex",
          gap: 16,
          justifyContent: "center",
          alignItems: "flex-start",
          flexWrap: "wrap",
          width: "100%",
          maxWidth: 560,
          margin: "0 auto",
        }}
      >
        {webglFailed ? board2d : (
          <div style={{ width: "min(78vw, 320px)" }}>
            <FallingScene3D
              getState={getViewState}
              onSwipe={handleSwipe}
              onTap={handleTap}
              onFail={() => setWebglFailed(true)}
              fallback={board2d}
            />
          </div>
        )}

        <div style={{ display: "grid", gap: 14, minWidth: 92, justifyItems: "center" }}>
          <Preview type={state.next} label="NEXT" />
          <div
            {...tappableProps(() => {
              if (!gameOver && state.canHold) actHold();
            })}
            data-falling-ui
            aria-disabled={gameOver || !state.canHold}
            aria-label="ホールド（タップで入れ替え、Cキーでも可）"
            style={{
              cursor: gameOver || !state.canHold ? "default" : "pointer",
              opacity: gameOver || !state.canHold ? 0.55 : 1,
              borderRadius: 8,
              touchAction: "manipulation",
            }}
          >
            <Preview type={state.hold} label="HOLD" />
          </div>
          <div
            {...tappableProps(() => {
              if (!gameOver) setPaused((v) => !v);
            })}
            data-falling-ui
            aria-pressed={paused}
            aria-disabled={gameOver}
            aria-label={paused ? "再開（P）" : "一時停止（P）"}
            className="classic-btn"
            style={{ opacity: gameOver ? 0.55 : 1 }}
          >
            {paused ? "再開（P）" : "一時停止（P）"}
          </div>
          <button type="button" className="classic-btn" data-falling-ui onClick={restart}>
            もう一度
          </button>
        </div>
      </div>

      <p className="classic-status" style={{ justifyContent: "center" }}>
        操作: 盤面 左右スワイプ 移動 / 下スワイプ ソフトドロップ / タップ 回転 / 上スワイプ
        ハードドロップ / HOLDタップ ホールド。キー: ←→ 移動 / ↓ ソフトドロップ / ↑・X 回転 /
        Z 左回転 / スペース ハードドロップ / C ホールド / P 一時停止
      </p>
      {gameOver && (
        <div style={{ maxWidth: 560, margin: "16px auto 0" }}>
          <EndScreen
            outcome="finish"
            title="ゲームオーバー"
            score={state.score}
            scoreLabel="スコア"
            newBest={resultNewBest}
            previousBest={resultPrevBest}
            onRetry={restart}
          >
            <p className="muted">
              ライン {state.lines} ・ レベル {state.level} まで進みました。
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
