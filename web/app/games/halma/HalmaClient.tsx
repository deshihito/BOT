"use client";
// ハルマ（チャイニーズチェッカー2人戦）。ロジックは lib/halma.ts。
// あなたは左下の陣地（青）から右上の陣地を目指す。CPU は赤。
// コマをタップして選び、光ったマスをタップすると移動する。
// ジャンプは隣のコマを飛び越える動きで、1手の中で連鎖できる。
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  HALMA_CELLS,
  HALMA_CAMPS,
  HALMA_TARGETS,
  createHalmaGame,
  halmaApplyMove,
  halmaCpuTurn,
  halmaMovesFrom,
  type HalmaState,
} from "@/lib/halma";
import { sfxLose, sfxSlide, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const CAMP0 = new Set(HALMA_CAMPS[0]);
const CAMP1 = new Set(HALMA_CAMPS[1]);
const TARGET0 = new Set(HALMA_TARGETS[0]);

const BOUNDS = (() => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of HALMA_CELLS) {
    minX = Math.min(minX, c.x);
    maxX = Math.max(maxX, c.x);
    minY = Math.min(minY, c.y);
    maxY = Math.max(maxY, c.y);
  }
  return { minX, maxX, minY, maxY };
})();

function px(x: number): number {
  return ((x - BOUNDS.minX) / (BOUNDS.maxX - BOUNDS.minX)) * 92 + 4;
}
function py(y: number): number {
  return ((y - BOUNDS.minY) / (BOUNDS.maxY - BOUNDS.minY)) * 92 + 4;
}

export default function HalmaClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<HalmaState>(() =>
    createHalmaGame(Date.now() % 2147483647),
  );
  const [selected, setSelected] = useState<number | null>(null);
  const prevStatusRef = useRef(state.status);

  // 終局遷移の瞬間だけジングルを鳴らす。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev === state.status) return;
    if (state.status === "won") {
      if (state.winner === 0) sfxWin();
      else sfxLose();
    } else if (state.status === "draw") {
      sfxTap();
    }
  }, [state.status, state.winner]);

  // CPU が指し終えた（手番が自分に戻った）瞬間に移動音を鳴らす。
  useEffect(() => {
    if (state.status === "playing" && state.turn === 0 && state.moves > 0) sfxSlide();
  }, [state.moves, state.turn, state.status]);

  const myTurn = state.status === "playing" && state.turn === 0;
  const targets = useMemo(() => {
    if (selected === null || !myTurn) return new Map<number, boolean>();
    return new Map(halmaMovesFrom(state, selected).map((m) => [m.to, m.jump]));
  }, [state, selected, myTurn]);

  // CPU の手番を自動で進める。
  useEffect(() => {
    if (state.status !== "playing" || state.turn !== 1) return;
    const id = setTimeout(() => {
      setState((s) => (s.status === "playing" && s.turn === 1 ? halmaCpuTurn(s) : s));
    }, 650);
    return () => clearTimeout(id);
  }, [state]);

  // 手番が変わったら選択を解除する。
  useEffect(() => {
    setSelected(null);
  }, [state.turn, state.moves]);

  const restart = () => {
    setState(createHalmaGame(Date.now() % 2147483647));
    setSelected(null);
  };

  const onCell = (index: number) => {
    if (!myTurn) return;
    if (targets.has(index) && selected !== null) {
      const next = halmaApplyMove(state, selected, index);
      if (next !== state && next.status === "playing") sfxSlide();
      setState(next);
      setSelected(null);
      return;
    }
    if (state.board[index] === 1) {
      sfxTap();
      setSelected(index === selected ? null : index);
    } else {
      setSelected(null);
    }
  };

  const statusText =
    state.status === "draw"
      ? "引き分けです（同一局面の繰り返し、または手数上限に達しました）。"
      : state.status === "won"
        ? state.winner === 0
          ? "あなたの勝ちです！相手の陣地をすべて占めました。"
          : "CPUの勝ちです。相手陣地を先に占められました。"
        : myTurn
        ? selected !== null
          ? "光ったマスをタップすると移動します（ジャンプ連鎖も1手）。"
          : "あなたの手番です。青いコマを選んでください。"
        : "CPUが考え中です…";

  const inTarget = state.board.filter((v, i) => v === 1 && TARGET0.has(i)).length;

  return (
    <div>
      <p className="classic-status" role="status">
        {statusText}
      </p>
      <p style={{ fontSize: 13, color: "#475569", margin: "4px 0 10px" }}>
        進み具合: あなた {inTarget}/10 ・ 手数 {state.moves}
      </p>

      <div style={{ maxWidth: 540, margin: "0 auto" }}>
        <svg
          viewBox="0 0 100 100"
          role="group"
          aria-label="ハルマの盤面"
          style={{ width: "100%", display: "block", touchAction: "manipulation" }}
        >
          {HALMA_CELLS.map((cell, i) => {
            const isCamp0 = CAMP0.has(i);
            const isCamp1 = CAMP1.has(i);
            const piece = state.board[i];
            const isTarget = targets.has(i);
            const isSelected = selected === i;
            const isLastFrom = state.lastMove?.from === i;
            const isLastTo = state.lastMove?.to === i;
            const fill = isTarget
              ? "#fbbf24"
              : isCamp1
                ? "#fee2e2"
                : isCamp0
                  ? "#dbeafe"
                  : "#e2e8f0";
            return (
              <g key={i}>
                <circle
                  cx={px(cell.x)}
                  cy={py(cell.y)}
                  r={2.5}
                  fill={fill}
                  stroke={isLastFrom || isLastTo ? "#f59e0b" : "#cbd5e1"}
                  strokeWidth={0.35}
                />
                {piece !== 0 ? (
                  <circle
                    cx={px(cell.x)}
                    cy={py(cell.y)}
                    r={2.15}
                    fill={piece === 1 ? "#2563eb" : "#dc2626"}
                    stroke={isSelected ? "#f59e0b" : "#ffffff"}
                    strokeWidth={isSelected ? 0.8 : 0.4}
                    style={{ cursor: myTurn && piece === 1 ? "pointer" : "default" }}
                    onClick={() => onCell(i)}
                    role="button"
                    aria-label={piece === 1 ? "あなたのコマ" : "CPUのコマ"}
                  />
                ) : (
                  <circle
                    cx={px(cell.x)}
                    cy={py(cell.y)}
                    r={2.5}
                    fill="transparent"
                    style={{ cursor: isTarget ? "pointer" : "default" }}
                    onClick={() => onCell(i)}
                    role="button"
                    aria-label={isTarget ? "移動先" : "空きマス"}
                  />
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {state.status === "won" && (
        <div style={{ maxWidth: 540, margin: "16px auto 0" }}>
          <EndScreen
            outcome={state.winner === 0 ? "win" : "lose"}
            title={state.winner === 0 ? "あなたの勝ち！" : "CPUの勝ち…"}
            onRetry={restart}
          >
            <p className="muted">
              手数 {state.moves} ・ あなたの進み具合 {inTarget}/10 でした。
            </p>
          </EndScreen>
        </div>
      )}
      {state.status === "draw" && (
        <div style={{ maxWidth: 540, margin: "16px auto 0" }}>
          <EndScreen outcome="draw" onRetry={restart}>
            <p className="muted">
              同一局面の繰り返し、または手数上限に達しました（手数 {state.moves}）。
            </p>
          </EndScreen>
        </div>
      )}

      <div className="classic-controls" role="group" aria-label="操作" style={{ marginTop: 12 }}>
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        <Link className="classic-btn" href={`${prefix}/games`}>
          ゲーム一覧へ
        </Link>
      </div>
      <p style={{ fontSize: 13, color: "#475569", marginTop: 10 }}>
        ルール: 隣のマスへ1歩、または隣のコマを飛び越えて真後ろの空きマスへ
        ジャンプできます。ジャンプは1手の中で何回でも連鎖できます。
        自分のコマ10個をすべて相手の陣地（右上の赤い一角）へ移せば勝ちです。
      </p>
    </div>
  );
}
