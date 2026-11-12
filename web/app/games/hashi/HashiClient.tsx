"use client";
// 橋をかけろ。ロジックは lib/hashi.ts（解の存在を保証する生成）。
// 島と島の間のマスをタップすると橋が 1本→2本→なし と切り替わる。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createHashiGame,
  cycleHashiBridge,
  hashiCandidateEdges,
  hashiCellBridge,
  hashiDegrees,
  hashiEdgeKey,
  hashiTapEdge,
  hashiViolations,
  type HashiEdge,
  type HashiSize,
  type HashiState,
} from "@/lib/hashi";
import { sfxPlace, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const SIZES: { key: HashiSize; label: string }[] = [
  { key: 7, label: "7×7" },
  { key: 9, label: "9×9" },
];

function newGame(size: HashiSize): HashiState {
  return createHashiGame(Date.now() % 2147483647, size);
}

function BridgeLines({ orientation, count }: { orientation: "h" | "v"; count: number }) {
  if (count <= 0) return null;
  const bar =
    orientation === "h"
      ? { width: "100%", height: 3, background: "#4a4a4a", borderRadius: 2 } as const
      : { width: 3, height: "100%", background: "#4a4a4a", borderRadius: 2 } as const;
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: orientation === "h" ? "column" : "row",
        alignItems: "center",
        justifyContent: "center",
        gap: count === 2 ? 5 : 0,
        pointerEvents: "none",
      }}
    >
      <div style={bar} />
      {count === 2 && <div style={bar} />}
    </div>
  );
}

export default function HashiClient() {
  const { prefix } = useGamesNav();
  const [size, setSize] = useState<HashiSize>(7);
  const [state, setState] = useState<HashiState>(() => newGame(7));
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [showCheck, setShowCheck] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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

  const degrees = useMemo(() => hashiDegrees(state), [state]);
  const edges = useMemo(() => hashiCandidateEdges(state), [state]);
  // 交差セルでは候補辺が2本あるため、セル→辺は多重対応で持つ。
  const edgesByCell = useMemo(() => {
    const map = new Map<number, HashiEdge[]>();
    for (const e of edges) {
      for (const cell of e.cells) map.set(cell, [...(map.get(cell) ?? []), e]);
    }
    return map;
  }, [edges]);
  // 交差セルで前回選んだ辺のキー（連続タップで両方の辺に到達するため）。
  const lastTapKeyRef = useRef(new Map<number, string>());
  const islandByIndex = useMemo(
    () => new Map(state.islands.map((i) => [i.index, i])),
    [state.islands],
  );
  const violations = useMemo(
    () => (showCheck && state.status !== "won" ? hashiViolations(state, false) : []),
    [showCheck, state],
  );
  const badIslands = useMemo(
    () => new Set(violations.flatMap((v) => v.islandIds)),
    [violations],
  );
  const satisfied = state.islands.filter((island, i) => degrees[i] === island.need).length;

  useEffect(() => {
    if (state.status !== "playing") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(`ago-hashi-best-${size}`));
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
      window.localStorage.setItem(`ago-hashi-best-${size}`, String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best, size]);

  const restart = (nextSize: HashiSize) => {
    setSize(nextSize);
    setState(newGame(nextSize));
    setSeconds(0);
    setShowCheck(false);
    setNotice(null);
    setResultNewBest(false);
    setResultPrevBest(null);
    lastTapKeyRef.current.clear();
  };

  const onBridgeCell = (a: number, b: number) => {
    const after = cycleHashiBridge(state, a, b);
    if (after === state) {
      sfxWrong();
      setNotice("橋が交差するため、そこには置けません。");
      return;
    }
    if (after.status !== "won") sfxPlace();
    setNotice(null);
    setState(after);
  };

  const onBridgeCellTap = (index: number) => {
    const target = hashiTapEdge(state, index, lastTapKeyRef.current.get(index) ?? null);
    if (!target) return;
    lastTapKeyRef.current.set(index, hashiEdgeKey(target.a, target.b));
    onBridgeCell(target.a, target.b);
  };

  const statusText =
    state.status === "won"
      ? "全部の島がつながりました。クリアです！"
      : notice ??
        `数字はその島から出る橋の総数。島と島の間のマスをタップして橋をかけよう（${satisfied}/${state.islands.length} 島が一致）。`;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>橋をかけろ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>橋をかけろ</h1>
        <p className="muted">
          島と島の間のマスをタップすると、橋が 1本→2本→なし の順に切り替わります。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="盤面サイズ">
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
          aria-pressed={showCheck}
          className={showCheck ? "classic-btn classic-btn-active" : "classic-btn"}
          onClick={() => {
            sfxTap();
            setShowCheck((v) => !v);
          }}
        >
          チェック
        </button>
      </div>

      <p className="classic-status" role="status">
        {seconds} 秒{best !== null ? ` ・ ベスト ${best} 秒` : ""} ・ {statusText}
      </p>

      {violations.length > 0 && (
        <ul className="muted" role="alert" style={{ margin: "4px 0 10px", paddingLeft: 18 }}>
          {violations.map((v, i) => (
            <li key={i}>{v.message}</li>
          ))}
        </ul>
      )}

      <div
        role="grid"
        aria-label="橋をかけろの盤"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${state.size}, minmax(0, 1fr))`,
          gap: 2,
          width: "100%",
          maxWidth: state.size === 7 ? 480 : 560,
          margin: "0 auto",
        }}
      >
        {Array.from({ length: state.size * state.size }, (_, index) => {
          const island = islandByIndex.get(index);
          if (island) {
            const deg = degrees[island.id];
            const isBad = badIslands.has(island.id) || deg > island.need;
            const isDone = deg === island.need;
            return (
              <div
                key={index}
                role="gridcell"
                aria-label={`島 ${island.need}${isDone ? "（一致）" : ""}`}
                style={{
                  aspectRatio: "1",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <span
                  className={isBad ? "juice-shake" : isDone ? "juice-pulse" : undefined}
                  style={{
                    width: "82%",
                    height: "82%",
                    borderRadius: "50%",
                    border: `2px solid ${isBad ? "#c0392b" : isDone ? "#2e8b57" : "#666"}`,
                    background: isBad ? "#fbe3e0" : isDone ? "#dff3e4" : "#fff",
                    color: isBad ? "#c0392b" : "#222",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700,
                    fontSize: state.size === 7 ? 18 : 15,
                  }}
                >
                  {island.need}
                </span>
              </div>
            );
          }
          const bridge = hashiCellBridge(state, index);
          const cellEdges = edgesByCell.get(index);
          if (cellEdges && cellEdges.length > 0) {
            return (
              <button
                key={index}
                type="button"
                role="gridcell"
                aria-label={bridge ? `橋 ${bridge.count}本（タップで変更）` : "橋をかけるマス"}
                className={bridge ? "juice-pop" : undefined}
                onClick={() => onBridgeCellTap(index)}
                style={{
                  aspectRatio: "1",
                  position: "relative",
                  border: "none",
                  borderRadius: 6,
                  background: bridge ? "transparent" : "rgba(0,0,0,0.045)",
                  cursor: "pointer",
                  padding: 0,
                  touchAction: "manipulation",
                }}
              >
                {bridge && <BridgeLines orientation={bridge.orientation} count={bridge.count} />}
              </button>
            );
          }
          return <div key={index} role="gridcell" style={{ aspectRatio: "1" }} />;
        })}
      </div>

      <p className="muted" style={{ marginTop: 12 }}>
        チェックを押すと、数字を超えた島などの間違いを表示します。
      </p>

      {state.status === "won" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen
            outcome="win"
            title="全部の島がつながった！"
            score={seconds}
            scoreLabel="クリアタイム（秒）"
            newBest={resultNewBest}
            previousBest={resultPrevBest}
            onRetry={() => restart(size)}
          >
            <p className="muted">
              {state.islands.length} 個の島を {seconds} 秒でつなぎました。
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
