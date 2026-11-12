"use client";
// ナンバーリンク。ロジックは lib/numberlink.ts（解を先に作る生成で必ず解ける）。
// 数字のマスから指（ポインタ）を滑らせて線を引く。他の線を横切ると、その線は切れる。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  applyStroke,
  checkNumberlink,
  clearPath,
  createNumberlink,
  isPairConnected,
  ownerOf,
  type NumberlinkSize,
  type NumberlinkState,
} from "@/lib/numberlink";
import { sfxCorrect, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const PAIR_COLORS = [
  "#e05252",
  "#3f7fbf",
  "#46a758",
  "#e09f3e",
  "#8b5cf6",
  "#ec6fa5",
  "#2aa7a0",
  "#b0722f",
  "#64748b",
  "#84cc16",
];

function pairColor(pair: number): string {
  return PAIR_COLORS[(pair - 1) % PAIR_COLORS.length];
}

export default function NumberLinkClient() {
  const { prefix } = useGamesNav();
  const [size, setSize] = useState<NumberlinkSize>(5);
  const [state, setState] = useState<NumberlinkState>(() =>
    createNumberlink(5, Date.now() % 2147483647),
  );
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const strokeRef = useRef<{ pair: number; cells: number[] } | null>(null);
  const [drawing, setDrawing] = useState(false);

  useEffect(() => {
    if (state.status === "won") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(`ago-numberlink-best-${size}`));
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
      window.localStorage.setItem(`ago-numberlink-best-${size}`, String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best, size]);

  // 勝利への遷移で1回だけジングルを鳴らし、その時点のベストと比較した結果を保持する。
  const prevStatusRef = useRef(state.status);
  const [winResult, setWinResult] = useState<{ newBest: boolean; prevBest: number | null } | null>(null);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (state.status === "won" && prev !== "won") {
      sfxWin();
      setWinResult({ newBest: best === null || seconds < best, prevBest: best });
    }
  }, [state.status, seconds, best]);

  // つながったペア数が増えたら正解音を鳴らす。
  const connected = checkNumberlink(state).connectedPairs;
  const prevConnectedRef = useRef(connected);
  useEffect(() => {
    const prev = prevConnectedRef.current;
    prevConnectedRef.current = connected;
    if (connected > prev) sfxCorrect();
  }, [connected]);

  const restart = (nextSize: NumberlinkSize) => {
    setSize(nextSize);
    setState(createNumberlink(nextSize, Date.now() % 2147483647));
    setSeconds(0);
    strokeRef.current = null;
    setDrawing(false);
    setWinResult(null);
  };

  const cellFromPointer = (e: React.PointerEvent): number | null => {
    const el = boardRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
    const col = Math.floor((x / rect.width) * size);
    const row = Math.floor((y / rect.height) * size);
    return row * size + col;
  };

  const beginStroke = (cell: number) => {
    if (state.status === "won") return;
    const owner = ownerOf(state);
    const pair = state.endpoints[cell] ?? (owner[cell] > 0 ? owner[cell] : null);
    if (pair === null) return;
    sfxTap();
    strokeRef.current = { pair, cells: [cell] };
    setDrawing(true);
    setState((s) => applyStroke(s, pair, [cell]));
  };

  const extendStroke = (cell: number) => {
    const stroke = strokeRef.current;
    if (!stroke) return;
    const last = stroke.cells[stroke.cells.length - 1];
    if (last === cell) return;
    // 速くなぞってマスを飛ばした場合は、直線区間だけ中間マスを補う。
    const lr = Math.floor(last / size);
    const lc = last % size;
    const cr = Math.floor(cell / size);
    const cc = cell % size;
    const adds: number[] = [];
    if (lr === cr || lc === cc) {
      const steps = Math.max(Math.abs(cr - lr), Math.abs(cc - lc));
      for (let k = 1; k <= steps; k++) {
        adds.push(
          (lr + Math.sign(cr - lr) * k) * size + (lc + Math.sign(cc - lc) * k),
        );
      }
    } else if (Math.abs(cr - lr) + Math.abs(cc - lc) === 1) {
      adds.push(cell);
    } else {
      return; // 斜めへ飛んだ動きは無視する（次の移動で拾い直す）。
    }
    // 既に通ったセルへ戻る動きも含め、そのまま列へ追加する（巻き戻しは lib が処理）。
    stroke.cells = [...stroke.cells, ...adds];
    const { pair, cells } = stroke;
    setState((s) => applyStroke(s, pair, cells));
  };

  const endStroke = () => {
    strokeRef.current = null;
    setDrawing(false);
  };

  const check = checkNumberlink(state);
  const owner = ownerOf(state);

  const statusText =
    state.status === "won"
      ? "全部つながった！クリアです。"
      : `つながったペア ${check.connectedPairs}/${check.pairCount} ・ 埋まったマス ${check.filled}/${check.total}`;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ナンバーリンク</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ナンバーリンク</h1>
        <p className="muted">数字のマスから指を滑らせて、同じ数字まで線を引きます。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="盤サイズ">
        {([5, 6] as NumberlinkSize[]).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={size === s}
            className={size === s ? "classic-btn classic-btn-active" : "classic-btn"}
            onClick={() => restart(s)}
          >
            {s}×{s}
          </button>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(size)}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {statusText} ・ {seconds} 秒{best !== null ? ` ・ ベスト ${best} 秒` : ""}
      </p>

      <div
        ref={boardRef}
        role="grid"
        aria-label="ナンバーリンクの盤"
        onPointerDown={(e) => {
          const cell = cellFromPointer(e);
          if (cell !== null) beginStroke(cell);
        }}
        onPointerMove={(e) => {
          if (!drawing) return;
          const cell = cellFromPointer(e);
          if (cell !== null) extendStroke(cell);
        }}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        onPointerLeave={endStroke}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))`,
          gap: 3,
          width: "100%",
          maxWidth: 420,
          margin: "0 auto",
          touchAction: "none",
          userSelect: "none",
        }}
      >
        {Array.from({ length: size * size }, (_, i) => {
          const pair = state.endpoints[i];
          const own = owner[i];
          const connected = pair !== null ? isPairConnected(state, pair) : own > 0 && isPairConnected(state, own);
          return (
            <div
              key={i}
              role="gridcell"
              className={connected && pair !== null ? "juice-pop" : undefined}
              aria-label={
                pair !== null
                  ? `数字 ${pair}${connected ? "（接続済み）" : ""}`
                  : own > 0
                    ? `${own} の線`
                    : "空きマス"
              }
              style={{
                aspectRatio: "1",
                display: "grid",
                placeItems: "center",
                borderRadius: 8,
                border: "1px solid var(--line)",
                background:
                  pair !== null
                    ? pairColor(pair)
                    : own > 0
                      ? `${pairColor(own)}55`
                      : "#fff",
                color: pair !== null ? "#fff" : "inherit",
                fontWeight: 800,
                fontSize: size === 5 ? 20 : 17,
                lineHeight: 1,
              }}
            >
              {pair !== null ? pair : ""}
            </div>
          );
        })}
      </div>

      {state.status === "won" ? (
        <EndScreen
          outcome="win"
          score={seconds}
          scoreLabel="クリアタイム（秒）"
          newBest={winResult?.newBest}
          previousBest={winResult && !winResult.newBest ? winResult.prevBest : undefined}
          onRetry={() => restart(size)}
        >
          <p className="muted">
            全 {check.pairCount} ペア接続 ・ 埋まったマス {check.filled} / {check.total}
          </p>
        </EndScreen>
      ) : null}

      <div
        className="classic-controls"
        role="group"
        aria-label="線を消す"
        style={{ marginTop: 12, flexWrap: "wrap" }}
      >
        <span className="muted" style={{ fontSize: 13 }}>線を消す:</span>
        {Array.from({ length: state.pairCount }, (_, k) => k + 1).map((pair) => (
          <button
            key={pair}
            type="button"
            className="classic-btn"
            style={{ minWidth: 40, borderColor: pairColor(pair), color: pairColor(pair) }}
            onClick={() => {
              sfxTap();
              setState((s) => clearPath(s, pair));
            }}
          >
            {pair}
          </button>
        ))}
      </div>

      <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
        線は数字のマスか、引いた線の途中から引き直せます。他の線を横切ると、その線は切れます。
      </p>
    </>
  );
}
