"use client";
// 詰将棋。王手の連続で玉を詰ませるパズル。ロジックとソルバーは lib/tsume.ts。
// 玉方の応手はソルバーが自動で指す（詰みを逃れられる手があればそれを選ぶ）。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  PIECE_LABEL,
  TSUME_PROBLEMS,
  attackerMoves,
  createTsumeGame,
  playAttackerMove,
  undoAttackerMove,
  type TsumeBasePiece,
  type TsumeGameState,
  type TsumeMove,
} from "@/lib/tsume";
import { useGamesNav } from "../GamesShell";

type Selection =
  | { kind: "board"; from: number }
  | { kind: "hand"; piece: TsumeBasePiece }
  | null;

const HAND_ORDER: TsumeBasePiece[] = ["R", "B", "G", "S", "N", "L", "P"];

export default function TsumeClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<TsumeGameState>(() => createTsumeGame(TSUME_PROBLEMS[0].id));
  const [selection, setSelection] = useState<Selection>(null);
  const [promoteChoice, setPromoteChoice] = useState<TsumeMove[] | null>(null);

  const moves = useMemo(() => (state.status === "playing" ? attackerMoves(state) : []), [state]);

  const targets = useMemo(() => {
    if (!selection) return new Map<number, TsumeMove[]>();
    const map = new Map<number, TsumeMove[]>();
    for (const m of moves) {
      if (selection.kind === "board" && m.from === selection.from) {
        map.set(m.to, [...(map.get(m.to) ?? []), m]);
      } else if (selection.kind === "hand" && m.from === -1 && m.drop === selection.piece) {
        map.set(m.to, [...(map.get(m.to) ?? []), m]);
      }
    }
    return map;
  }, [moves, selection]);

  const startProblem = (id: string) => {
    setState(createTsumeGame(id));
    setSelection(null);
    setPromoteChoice(null);
  };

  const doMove = (m: TsumeMove) => {
    setState((s) => playAttackerMove(s, m));
    setSelection(null);
    setPromoteChoice(null);
  };

  const onCell = (index: number) => {
    if (state.status !== "playing") return;
    if (selection && targets.has(index)) {
      const options = targets.get(index) as TsumeMove[];
      if (options.length > 1) {
        setPromoteChoice(options);
      } else {
        doMove(options[0]);
      }
      return;
    }
    setPromoteChoice(null);
    const cell = state.pos.board[index];
    if (cell && cell.side === "A") {
      setSelection({ kind: "board", from: index });
    } else {
      setSelection(null);
    }
  };

  const remaining = state.problem.moves - state.movesUsed;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>詰将棋</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>詰将棋</h1>
        <p className="muted">持ち駒や盤の駒をタップして選び、光ったマスへ動かします。</p>
      </div>

      <div className="classic-controls" role="group" aria-label="問題">
        {TSUME_PROBLEMS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={state.problem.id === p.id}
            className={state.problem.id === p.id ? "classic-btn classic-btn-active" : "classic-btn"}
            onClick={() => startProblem(p.id)}
          >
            {p.title}（{p.moves}手）
          </button>
        ))}
        <button type="button" className="classic-btn" onClick={() => startProblem(state.problem.id)}>
          もう一度
        </button>
        <button
          type="button"
          className="classic-btn"
          disabled={state.snapshots.length === 0}
          onClick={() => {
            setState((s) => undoAttackerMove(s));
            setSelection(null);
            setPromoteChoice(null);
          }}
        >
          1手戻す
        </button>
      </div>

      <p className="classic-status" role="status">
        {state.status === "cleared"
          ? "🎉 詰み！"
          : state.status === "failed"
            ? "詰みませんでした。"
            : `あと ${remaining} 手で詰ませる問題です。`}{" "}
        {state.message}
      </p>

      <div style={{ maxWidth: 460, margin: "0 auto" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(9, 1fr)",
            fontSize: 11,
            color: "var(--muted, #888)",
            textAlign: "center",
            marginBottom: 2,
          }}
          aria-hidden
        >
          {[9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => (
            <span key={n}>{n}</span>
          ))}
        </div>
        <div
          role="grid"
          aria-label="将棋盤"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(9, minmax(0, 1fr))",
            border: "2px solid #8a6d3b",
            background: "#f2d38a",
          }}
        >
          {state.pos.board.map((cell, i) => {
            const isTarget = targets.has(i);
            const isSelected = selection?.kind === "board" && selection.from === i;
            return (
              <button
                key={i}
                type="button"
                role="gridcell"
                aria-label={
                  cell
                    ? `${Math.floor(i / 9) + 1}段${9 - (i % 9)}筋 ${cell.side === "A" ? "攻め方" : "玉方"} ${PIECE_LABEL[cell.piece]}`
                    : `${Math.floor(i / 9) + 1}段${9 - (i % 9)}筋 空き`
                }
                onClick={() => onCell(i)}
                style={{
                  aspectRatio: "1",
                  minHeight: 36,
                  border: "1px solid rgba(138,109,59,0.55)",
                  background: isSelected
                    ? "#ffd54d"
                    : isTarget
                      ? "#b9e29a"
                      : "transparent",
                  fontSize: "clamp(13px, 4.4vw, 20px)",
                  fontWeight: 700,
                  color: cell && cell.piece.startsWith("+") ? "#c62828" : "#3a2c14",
                  cursor: "pointer",
                  padding: 0,
                  lineHeight: 1.1,
                }}
              >
                {cell ? (
                  <span
                    style={{
                      display: "inline-block",
                      transform: cell.side === "D" ? "rotate(180deg)" : undefined,
                    }}
                  >
                    {PIECE_LABEL[cell.piece]}
                  </span>
                ) : isTarget ? (
                  "・"
                ) : (
                  ""
                )}
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: 10 }}>
          <span style={{ fontSize: 13, marginRight: 8 }}>攻め方の持ち駒:</span>
          {HAND_ORDER.filter((p) => (state.pos.handA[p] ?? 0) > 0).length === 0 && (
            <span style={{ fontSize: 13 }}>なし</span>
          )}
          {HAND_ORDER.filter((p) => (state.pos.handA[p] ?? 0) > 0).map((p) => {
            const selected = selection?.kind === "hand" && selection.piece === p;
            return (
              <button
                key={p}
                type="button"
                aria-pressed={selected}
                className={selected ? "classic-btn classic-btn-active" : "classic-btn"}
                style={{ minWidth: 52, marginRight: 6, marginBottom: 6 }}
                onClick={() => {
                  setPromoteChoice(null);
                  setSelection(selected ? null : { kind: "hand", piece: p });
                }}
              >
                {PIECE_LABEL[p]} × {state.pos.handA[p]}
              </button>
            );
          })}
          {Object.keys(state.pos.handD).length > 0 && (
            <span style={{ fontSize: 13, marginLeft: 8 }}>
              玉方の持ち駒:{" "}
              {HAND_ORDER.filter((p) => (state.pos.handD[p] ?? 0) > 0)
                .map((p) => `${PIECE_LABEL[p]}×${state.pos.handD[p]}`)
                .join(" ")}
            </span>
          )}
        </div>

        {promoteChoice && (
          <div className="classic-controls" role="group" aria-label="成り・不成の選択" style={{ marginTop: 8 }}>
            <span style={{ fontSize: 14 }}>成りますか？</span>
            {promoteChoice.map((m) => (
              <button key={String(m.promote)} type="button" className="classic-btn" onClick={() => doMove(m)}>
                {m.promote ? `${PIECE_LABEL[m.piece]}に成る` : "成らない"}
              </button>
            ))}
            <button type="button" className="classic-btn" onClick={() => setPromoteChoice(null)}>
              やめる
            </button>
          </div>
        )}

        {state.line.length > 0 && (
          <p style={{ fontSize: 13, marginTop: 10 }}>
            手順: {state.line.join(" → ")}
          </p>
        )}
      </div>
    </>
  );
}
