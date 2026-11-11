"use client";
// ペントミノ。ロジックは lib/pentomino.ts。
// パレットでピースを選び、回転・反転してから盤をタップして置く（タップ式）。
// ピース未選択で配置済みのマスをタップすると、そのピースを外せる。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  canPlacePent,
  createPentGame,
  flipPentOrientation,
  pentOccupancy,
  pentOrientationCells,
  pentPieceDef,
  pentRemaining,
  placePent,
  removePent,
  rotatePentOrientation,
  PENTOMINOES,
  PENT_BOARDS,
  type PentBoardKey,
  type PentId,
  type PentState,
} from "@/lib/pentomino";
import { useGamesNav } from "../GamesShell";

const BOARD_KEYS: PentBoardKey[] = ["6x10", "5x12"];

function PiecePreview({
  cells,
  color,
  cellSize,
}: {
  cells: readonly (readonly [number, number])[];
  color: string;
  cellSize: number;
}) {
  const maxR = Math.max(...cells.map((c) => c[0])) + 1;
  const maxC = Math.max(...cells.map((c) => c[1])) + 1;
  const filled = new Set(cells.map(([r, c]) => `${r},${c}`));
  return (
    <div
      aria-hidden
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${maxC}, ${cellSize}px)`,
        gap: 1,
      }}
    >
      {Array.from({ length: maxR * maxC }, (_, i) => {
        const r = Math.floor(i / maxC);
        const c = i % maxC;
        const on = filled.has(`${r},${c}`);
        return (
          <span
            key={i}
            style={{
              width: cellSize,
              height: cellSize,
              borderRadius: 2,
              background: on ? color : "transparent",
            }}
          />
        );
      })}
    </div>
  );
}

export default function PentominoClient() {
  const { prefix } = useGamesNav();
  const [boardKey, setBoardKey] = useState<PentBoardKey>("6x10");
  const [state, setState] = useState<PentState>(() => createPentGame("6x10"));
  const [selected, setSelected] = useState<PentId | null>(null);
  const [orientation, setOrientation] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const occupancy = useMemo(() => pentOccupancy(state), [state]);
  const covered = occupancy.filter(Boolean).length;
  const remaining = useMemo(() => pentRemaining(state), [state]);
  const selectedCells = selected ? pentOrientationCells(selected, orientation) : null;

  const previewCells = useMemo(() => {
    if (!selected || hover === null || state.status === "won") return new Set<number>();
    const r = Math.floor(hover / state.cols);
    const c = hover % state.cols;
    if (!canPlacePent(state, selected, orientation, r, c)) return new Set<number>();
    const cells = pentOrientationCells(selected, orientation);
    if (!cells) return new Set<number>();
    const [ar, ac] = cells[0];
    return new Set(cells.map(([cr, cc]) => (r + (cr - ar)) * state.cols + (c + (cc - ac))));
  }, [selected, hover, state, orientation]);

  const restart = (key: PentBoardKey) => {
    setBoardKey(key);
    setState(createPentGame(key));
    setSelected(null);
    setOrientation(0);
    setNotice(null);
  };

  const selectPiece = (id: PentId) => {
    if (selected === id) {
      setSelected(null);
      return;
    }
    setSelected(id);
    const placed = state.placements[id];
    setOrientation(placed ? placed.orientation : 0);
    setNotice(null);
  };

  const onCell = (index: number) => {
    const r = Math.floor(index / state.cols);
    const c = index % state.cols;
    if (selected) {
      const after = placePent(state, selected, orientation, r, c);
      if (after === state) {
        setNotice("そこには置けません（盤の外・他のピースと重なり）。");
        return;
      }
      setNotice(null);
      setState(after);
      if (after.status === "won") setSelected(null);
      return;
    }
    const occupant = occupancy[index];
    if (occupant) {
      setState((s) => removePent(s, occupant));
      setNotice(`${occupant} を外しました。`);
    }
  };

  const statusText =
    state.status === "won"
      ? "60マス全部が埋まりました。完成です！"
      : notice ??
        (selected
          ? `${selected} を置くマスをタップしてください（タップしたマスにピースの端が乗ります）。`
          : "パレットからピースを選んでください。配置済みのマスをタップすると外せます。");

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ペントミノ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ペントミノ</h1>
        <p className="muted">
          ピースを選んで回転・反転し、盤をタップして置きます。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="盤面">
        {BOARD_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={boardKey === key}
            className={boardKey === key ? "classic-btn classic-btn-active" : "classic-btn"}
            onClick={() => restart(key)}
          >
            {PENT_BOARDS[key].label}
          </button>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(boardKey)}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        配置 {12 - remaining.length}/12 ピース ・ {covered}/60 マス ・ {statusText}
      </p>

      {/* パレット */}
      <div
        role="group"
        aria-label="ピース一覧"
        style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}
      >
        {PENTOMINOES.map((def) => {
          const placed = state.placements[def.id] !== undefined;
          const isSelected = selected === def.id;
          const cells = pentOrientationCells(def.id, 0) ?? def.cells;
          return (
            <button
              key={def.id}
              type="button"
              aria-pressed={isSelected}
              aria-label={`ピース ${def.id}${placed ? "（配置済み）" : ""}`}
              onClick={() => selectPiece(def.id)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
                padding: "6px 8px",
                minWidth: 52,
                minHeight: 40,
                borderRadius: 8,
                border: `2px solid ${isSelected ? def.color : "var(--line)"}`,
                background: isSelected ? "#fff" : placed ? "#f2f2f2" : "#fff",
                opacity: placed && !isSelected ? 0.55 : 1,
                cursor: "pointer",
                touchAction: "manipulation",
              }}
            >
              <PiecePreview cells={cells} color={def.color} cellSize={7} />
              <span style={{ fontSize: 12, fontWeight: 700 }}>{def.id}</span>
            </button>
          );
        })}
      </div>

      {/* 選択中ピースの操作 */}
      {selected && selectedCells && (
        <div
          className="classic-controls"
          style={{ alignItems: "center" }}
          role="group"
          aria-label="ピース操作"
        >
          <PiecePreview cells={selectedCells} color={pentPieceDef(selected).color} cellSize={13} />
          <button
            type="button"
            className="classic-btn"
            onClick={() => setOrientation((o) => rotatePentOrientation(selected, o))}
          >
            ⟳ 回転
          </button>
          <button
            type="button"
            className="classic-btn"
            onClick={() => setOrientation((o) => flipPentOrientation(selected, o))}
          >
            ⇋ 反転
          </button>
          {state.placements[selected] && (
            <button
              type="button"
              className="classic-btn"
              onClick={() => {
                setState((s) => removePent(s, selected));
                setSelected(null);
              }}
            >
              外す
            </button>
          )}
          <button type="button" className="classic-btn" onClick={() => setSelected(null)}>
            選択解除
          </button>
        </div>
      )}

      {/* 盤面 */}
      <div
        role="grid"
        aria-label="ペントミノの盤"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${state.cols}, minmax(0, 1fr))`,
          gap: 2,
          width: "100%",
          maxWidth: 600,
          margin: "0 auto",
        }}
      >
        {occupancy.map((occupant, index) => {
          const isPreview = previewCells.has(index);
          const color = occupant
            ? pentPieceDef(occupant).color
            : isPreview && selected
              ? pentPieceDef(selected).color
              : null;
          return (
            <button
              key={index}
              type="button"
              role="gridcell"
              aria-label={
                occupant ? `ピース ${occupant}` : isPreview ? "配置プレビュー" : "空きマス"
              }
              onClick={() => onCell(index)}
              onMouseEnter={() => setHover(index)}
              onMouseLeave={() => setHover(null)}
              style={{
                aspectRatio: "1",
                borderRadius: 4,
                border: "1px solid var(--line)",
                background: color ?? "#fafafa",
                opacity: isPreview && !occupant ? 0.45 : 1,
                padding: 0,
                cursor: "pointer",
                touchAction: "manipulation",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                fontWeight: 700,
                fontSize: 11,
              }}
            >
              {occupant ?? ""}
            </button>
          );
        })}
      </div>

      {state.status === "won" && (
        <div className="classic-controls" style={{ marginTop: 14 }}>
          <button type="button" className="classic-btn" onClick={() => restart(boardKey)}>
            もう一度
          </button>
        </div>
      )}
    </>
  );
}
