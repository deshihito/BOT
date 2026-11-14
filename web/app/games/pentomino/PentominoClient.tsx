"use client";
// ペントミノ。ロジックは lib/pentomino.ts。
// パレットでピースを選び、回転・反転してから盤をタップして置く（タップ式）。
// ピース未選択で配置済みのマスをタップすると、そのピースを外せる。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const PentominoScene3D = dynamic(() => import("./PentominoScene3D"), { ssr: false });
import { sfxPlace, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
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
  const [webglFailed, setWebglFailed] = useState(false);
  const [boardKey, setBoardKey] = useState<PentBoardKey>("6x10");
  const [state, setState] = useState<PentState>(() => createPentGame("6x10"));
  const [selected, setSelected] = useState<PentId | null>(null);
  const [orientation, setOrientation] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev !== "won" && state.status === "won") sfxWin();
  }, [state.status]);

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
    sfxTap();
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
        sfxWrong();
        setNotice("そこには置けません（盤の外・他のピースと重なり）。");
        return;
      }
      sfxPlace();
      setNotice(null);
      setState(after);
      if (after.status === "won") setSelected(null);
      return;
    }
    const occupant = occupancy[index];
    if (occupant) {
      sfxTap();
      setState((s) => removePent(s, occupant));
      setNotice(`${occupant} を外しました。`);
    }
  };

  // 選択中ピースの操作: プレビュー表示のタップ=回転、左右スワイプ=反転。
  // 「外す」は選択解除（パレットをもう一度タップ）→ 配置済みマスをタップ、
  // 「選択解除」はパレットの再タップで代替するため両ボタンとも廃止。
  const rotateSelected = () => {
    if (!selected) return;
    sfxTap();
    setOrientation((o) => rotatePentOrientation(selected, o));
  };
  const flipSelected = () => {
    if (!selected) return;
    sfxTap();
    setOrientation((o) => flipPentOrientation(selected, o));
  };
  const previewGesture = useGesture({
    onTap: () => rotateSelected(),
    onSwipe: (dir) => {
      if (dir === "left" || dir === "right") flipSelected();
    },
  });

  const statusText =
    state.status === "won"
      ? "60マス全部が埋まりました。完成です！"
      : notice ??
        (selected
          ? `${selected} を置くマスをタップしてください（タップしたマスにピースの端が乗ります）。上のピース表示をタップで回転、左右スワイプで反転。`
          : "パレットからピースを選んでください。配置済みのマスをタップすると外せます。");

  // 2D 盤（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const board2d = (
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
          <div
            key={index}
            role="gridcell"
            tabIndex={0}
            className={occupant ? "juice-pop" : undefined}
            aria-label={
              occupant ? `ピース ${occupant}` : isPreview ? "配置プレビュー" : "空きマス"
            }
            onClick={() => onCell(index)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onCell(index);
            }}
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
          <div
            key={key}
            {...tappableProps(() => restart(key))}
            aria-pressed={boardKey === key}
            className={boardKey === key ? "classic-btn classic-btn-active" : "classic-btn"}
          >
            {PENT_BOARDS[key].label}
          </div>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(boardKey)}>
          もう一度
        </button>
      </div>

      <p
        className={
          notice?.startsWith("そこには置けません")
            ? "classic-status juice-shake"
            : "classic-status"
        }
        role="status"
      >
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
            <div
              key={def.id}
              {...tappableProps(() => selectPiece(def.id))}
              aria-pressed={isSelected}
              aria-label={`ピース ${def.id}${placed ? "（配置済み）" : ""}`}
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
            </div>
          );
        })}
      </div>

      {/* 選択中ピースの操作 */}
      {selected && selectedCells && (
        <div
          {...previewGesture}
          role="button"
          tabIndex={0}
          aria-label={`${selected} を操作中。タップで回転、左右スワイプで反転`}
          className="classic-controls juice-pop"
          style={{ alignItems: "center", cursor: "pointer", touchAction: "none" }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            rotateSelected();
          }}
        >
          <PiecePreview cells={selectedCells} color={pentPieceDef(selected).color} cellSize={13} />
          <span style={{ fontSize: 13 }}>タップ: 回転 / 左右スワイプ: 反転</span>
        </div>
      )}

      {/* 盤面（3D。WebGL が使えない場合は 2D 盤へフォールバック） */}
      {webglFailed ? board2d : (
        <div style={{ width: "100%", maxWidth: 640, margin: "0 auto" }}>
          <PentominoScene3D
            state={state}
            occupancy={occupancy}
            previewCells={previewCells}
            selected={selected}
            onCell={onCell}
            onHover={setHover}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      {state.status === "won" && (
        <div style={{ marginTop: 14 }}>
          <EndScreen outcome="win" title="完成です！" onRetry={() => restart(boardKey)}>
            <p className="muted" style={{ margin: 0 }}>
              12ピースすべてを配置し、60マス全部が埋まりました。
            </p>
          </EndScreen>
        </div>
      )}
    </>
  );
}
