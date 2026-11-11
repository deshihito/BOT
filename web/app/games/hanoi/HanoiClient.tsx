"use client";
// ハノイの塔。ロジックは lib/hanoi.ts。
// 柱を押して円盤を持ち上げ、置きたい柱を押して移す。自動解答の再生もできる。端末内で完結。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  canMoveDisk,
  createHanoiGame,
  hanoiMinMoves,
  hanoiSolution,
  moveDisk,
  type HanoiMove,
  type HanoiState,
} from "@/lib/hanoi";
import { useGamesNav } from "../GamesShell";

const DISK_COUNTS = [3, 4, 5, 6, 7, 8] as const;
const DISK_COLORS = ["#e5484d", "#f76b15", "#ffd60a", "#46a758", "#3e9bdc", "#8e4ec6", "#e93d82", "#697177"];

export default function HanoiClient() {
  const { prefix } = useGamesNav();
  const [disks, setDisks] = useState<number>(5);
  const [state, setState] = useState<HanoiState>(() => createHanoiGame(5));
  const [selected, setSelected] = useState<number | null>(null);
  const [auto, setAuto] = useState(false);
  const solveRef = useRef<{ moves: HanoiMove[]; index: number } | null>(null);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => {
      const plan = solveRef.current;
      if (!plan || plan.index >= plan.moves.length) {
        setAuto(false);
        return;
      }
      const move = plan.moves[plan.index];
      plan.index++;
      setState((s) => moveDisk(s, move.from, move.to));
    }, 550);
    return () => clearInterval(id);
  }, [auto]);

  const restart = (nextDisks: number) => {
    setAuto(false);
    solveRef.current = null;
    setDisks(nextDisks);
    setState(createHanoiGame(nextDisks));
    setSelected(null);
  };

  const startAuto = () => {
    const fresh = createHanoiGame(disks);
    setState(fresh);
    setSelected(null);
    solveRef.current = { moves: hanoiSolution(disks), index: 0 };
    setAuto(true);
  };

  const onPeg = (peg: number) => {
    if (auto) return;
    if (state.status === "solved") return;
    if (selected === null) {
      if (state.pegs[peg].length > 0) setSelected(peg);
      return;
    }
    if (selected === peg) {
      setSelected(null);
      return;
    }
    if (canMoveDisk(state, selected, peg)) {
      setState((s) => moveDisk(s, selected, peg));
      setSelected(null);
    } else if (state.pegs[peg].length > 0) {
      setSelected(peg);
    } else {
      setSelected(null);
    }
  };

  const min = hanoiMinMoves(disks);
  const solved = state.status === "solved";

  const statusText = solved
    ? state.moves === min
      ? `最少手数 ${min} 手でクリア！完璧です。`
      : `${state.moves} 手でクリア（最少は ${min} 手）。`
    : selected !== null
      ? "置きたい柱を押してください（大きい円盤の上には置けません）。"
      : "柱を押すと一番上の円盤を持ち上げます。右端の柱へ全部移せればクリアです。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ハノイの塔</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ハノイの塔</h1>
        <p className="muted">
          大きい円盤の上には小さい円盤しか置けません。最少手数で右端の柱へ移し替えましょう。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="円盤の枚数">
        {DISK_COUNTS.map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={disks === n}
            className={disks === n ? "classic-btn classic-btn-active" : "classic-btn"}
            onClick={() => restart(n)}
          >
            {n}枚
          </button>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(disks)}>
          もう一度
        </button>
        {auto ? (
          <button type="button" className="classic-btn" onClick={() => setAuto(false)}>
            自動解答を止める
          </button>
        ) : (
          <button type="button" className="classic-btn" onClick={startAuto}>
            自動解答を見る
          </button>
        )}
      </div>

      <p className="classic-status" role="status">
        {state.moves} 手 / 最少 {min} 手 ・ {statusText}
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 10,
          width: "min(94vw, 560px)",
          margin: "0 auto",
        }}
      >
        {state.pegs.map((stack, peg) => {
          const topFirst = [...stack].reverse();
          const isSelected = selected === peg;
          return (
            <button
              key={peg}
              type="button"
              aria-label={`${peg + 1}番目の柱${isSelected ? "（選択中）" : ""}`}
              aria-pressed={isSelected}
              onClick={() => onPeg(peg)}
              style={{
                position: "relative",
                height: 240,
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
                alignItems: "center",
                gap: 3,
                padding: "10px 4px 12px",
                borderRadius: 12,
                border: isSelected ? "3px solid #d9a41c" : "2px solid #d8c9a3",
                background: "#fbf7ec",
                cursor: auto || solved ? "default" : "pointer",
                touchAction: "manipulation",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: "50%",
                  bottom: 10,
                  width: 6,
                  height: 200,
                  marginLeft: -3,
                  borderRadius: 3,
                  background: "#b09a6a",
                }}
              />
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: "6%",
                  right: "6%",
                  bottom: 8,
                  height: 6,
                  borderRadius: 3,
                  background: "#8a7a52",
                }}
              />
              {topFirst.map((disk, i) => {
                const isTop = i === 0;
                return (
                  <span
                    key={disk}
                    aria-hidden="true"
                    style={{
                      position: "relative",
                      zIndex: 1,
                      display: "block",
                      width: `${(disk / disks) * 92}%`,
                      height: 22,
                      borderRadius: 6,
                      background: DISK_COLORS[disk - 1] ?? "#697177",
                      border: "1px solid rgba(0,0,0,0.25)",
                      transform: isTop && isSelected ? "translateY(-8px)" : "none",
                      boxShadow: isTop && isSelected ? "0 4px 8px rgba(0,0,0,0.3)" : "none",
                    }}
                  />
                );
              })}
              <span style={{ position: "relative", zIndex: 1, fontSize: 12, color: "#8a7a52", marginTop: 6 }}>
                {peg === 0 ? "スタート" : peg === 2 ? "ゴール" : ""}
              </span>
            </button>
          );
        })}
      </div>
      <p className="muted" style={{ textAlign: "center", marginTop: 10 }}>
        「自動解答を見る」は、最初の配置から再生します。
      </p>
    </>
  );
}
