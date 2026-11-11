"use client";
// フォーリングブロック（落下パズル）。ロジックは lib/falling.ts（純粋関数）。
// キーボードと画面ボタンの両方で操作でき、端末内で完結する（サーバー送信なし）。
// ベストスコアは localStorage の ago-falling-best に保存する。
import Link from "next/link";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
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

const ctrlBtn: CSSProperties = {
  minHeight: 48,
  padding: "8px 10px",
  border: "1px solid #c9c9c9",
  borderRadius: 10,
  background: "#fff",
  fontSize: 15,
  fontWeight: 700,
  cursor: "pointer",
  touchAction: "manipulation",
  userSelect: "none",
  WebkitUserSelect: "none",
};

export default function FallingClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<FallingState>(() => createFallingGame(Date.now() % 2147483647));
  const [paused, setPaused] = useState(false);
  const [best, setBest] = useState(0);

  useEffect(() => {
    setBest(loadBest());
  }, []);

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
    setState(createFallingGame(Date.now() % 2147483647));
  }, []);

  const act = useCallback((fn: (s: FallingState) => FallingState) => {
    setState((s) => (s.status === "playing" ? fn(s) : s));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
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
          act(hardDrop);
          break;
        case "c":
        case "C":
          e.preventDefault();
          act(holdPiece);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, paused]);

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
      ? "一時停止中です。Pキーかボタンで再開できます。"
      : "";

  const press = (fn: (s: FallingState) => FallingState) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      if (!paused) act(fn);
    },
  });

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>フォーリングブロック</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>フォーリングブロック</h1>
        <p className="muted">落ちてくるブロックをそろえてラインを消す落下パズル。キー操作と画面ボタンの両方に対応しています。</p>
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
        <div
          role="grid"
          aria-label="フォーリングブロックの盤"
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
            touchAction: "manipulation",
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

        <div style={{ display: "grid", gap: 14, minWidth: 92, justifyItems: "center" }}>
          <Preview type={state.next} label="NEXT" />
          <Preview type={state.hold} label="HOLD" />
          <button type="button" className="classic-btn" onClick={() => act(holdPiece)} disabled={gameOver || !state.canHold}>
            ホールド（C）
          </button>
          <button
            type="button"
            className="classic-btn"
            aria-pressed={paused}
            onClick={() => setPaused((v) => !v)}
            disabled={gameOver}
          >
            {paused ? "再開（P）" : "一時停止（P）"}
          </button>
          <button type="button" className="classic-btn" onClick={restart}>
            もう一度
          </button>
        </div>
      </div>

      <div
        role="group"
        aria-label="操作ボタン"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
          gap: 8,
          width: "100%",
          maxWidth: 560,
          margin: "16px auto 0",
        }}
      >
        <button type="button" style={ctrlBtn} aria-label="左へ" {...press(moveLeft)}>
          ←
        </button>
        <button type="button" style={ctrlBtn} aria-label="右へ" {...press(moveRight)}>
          →
        </button>
        <button type="button" style={ctrlBtn} aria-label="ソフトドロップ" {...press(softDrop)}>
          ↓
        </button>
        <button type="button" style={ctrlBtn} aria-label="回転" {...press((s) => rotatePiece(s, 1))}>
          ⟳ 回転
        </button>
        <button type="button" style={ctrlBtn} aria-label="ハードドロップ" {...press(hardDrop)}>
          ⤓ 落下
        </button>
        <button type="button" style={ctrlBtn} aria-label="ホールド" {...press(holdPiece)}>
          ホールド
        </button>
      </div>
      <p className="classic-status" style={{ justifyContent: "center" }}>
        操作: ←→ 移動 / ↓ ソフトドロップ / ↑・X 回転 / Z 左回転 / スペース ハードドロップ / C ホールド
      </p>
      {gameOver && (
        <p className="classic-status" style={{ justifyContent: "center" }}>
          <button type="button" className="classic-btn classic-btn-active" onClick={restart}>
            もう一度
          </button>
        </p>
      )}
    </>
  );
}
