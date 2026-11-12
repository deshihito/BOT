"use client";
// テリトリオ（オンライン）クライアント。ルーム管理は OnlineShell が担い、
// このコンポーネントは view.state（全公開の盤面）の描画とピース配置の
// 操作だけを持つ。合法判定はモジュールの純粋ヘルパーをそのまま使い、
// サーバー側の判定と一致させる（送信は { type: "place", piece, cells }）。
import { useEffect, useMemo, useRef, useState } from "react";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";
import { playSe } from "@/lib/balku-sound";
import {
  TERRITORY_PIECES,
  TERRITORY_SIZE,
  enumerateTerritoryPlacements,
  isLegalTerritoryPlacement,
  placementCells,
  transformTerritoryPiece,
} from "@/lib/online/games/territory";

type TerritoryState = {
  board: number[];
  used: boolean[][];
  turn: number;
  passStreak: number;
  scores: [number, number];
  finished: boolean;
  winner: number | "draw" | null;
  lastMove: { seat: number; piece: number; cells: number[] } | null;
  lastPassSeat: number | null;
  players: { seat: number; name: string }[];
};

const SEAT_COLORS: readonly string[] = ["#c2504a", "#2f5da8"];
const SEAT_BG: readonly string[] = ["#fbeae8", "#e8eefb"];

export default function TerritoryClient() {
  return (
    <OnlineShell gameId="territory" title="テリトリオ" playerRange={{ min: 2, max: 2 }}>
      {(view, api) => <TerritoryBoard view={view} api={api} />}
    </OnlineShell>
  );
}

function TerritoryBoard({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as TerritoryState | null;
  const mySeat = view.player.seat;
  const [selectedPiece, setSelectedPiece] = useState<number | null>(null);
  const [rotation, setRotation] = useState(0);
  const [flip, setFlip] = useState(false);
  const [anchor, setAnchor] = useState<number | null>(null);

  const myTurn = !!state && !state.finished && state.turn === mySeat;

  // 自分が使ったピースは選択から外す
  useEffect(() => {
    if (!state || selectedPiece === null) return;
    if (state.used[mySeat]?.[selectedPiece]) {
      setSelectedPiece(null);
      setAnchor(null);
    }
  }, [state, mySeat, selectedPiece]);

  const prevTurnRef = useRef<number | null>(null);
  useEffect(() => {
    if (!state || state.finished) return;
    const prev = prevTurnRef.current;
    prevTurnRef.current = state.turn;
    if (prev !== null && prev !== state.turn && state.turn === mySeat) playSe("turn");
  }, [state, mySeat]);

  const finishRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state?.finished) return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    playSe(state.winner === "draw" ? "click" : state.winner === mySeat ? "win" : "lose");
  }, [state, mySeat, view.code]);

  const myPlacements = useMemo(() => {
    if (!state || !myTurn) return [];
    return enumerateTerritoryPlacements(state.board, mySeat, state.used[mySeat] ?? []);
  }, [state, mySeat, myTurn]);

  if (!state) {
    return <p className="og-notice">対戦の開始を待っています…</p>;
  }

  const nameOf = (seat: number): string => {
    if (seat === mySeat) return "あなた";
    const p = state.players.find((pl) => pl.seat === seat);
    return p ? p.name : `プレイヤー${seat + 1}`;
  };

  const anchorRow = anchor !== null ? Math.floor(anchor / TERRITORY_SIZE) : 0;
  const anchorCol = anchor !== null ? anchor % TERRITORY_SIZE : 0;
  const previewCells =
    selectedPiece !== null && anchor !== null
      ? placementCells(selectedPiece, rotation, flip, anchorRow, anchorCol)
      : null;
  const previewSet = new Set(previewCells ?? []);
  const previewLegal =
    !!previewCells &&
    selectedPiece !== null &&
    !state.used[mySeat][selectedPiece] &&
    isLegalTerritoryPlacement(state.board, mySeat, previewCells);
  const lastMoveSet = new Set(state.lastMove?.cells ?? []);
  const canPass = myTurn && myPlacements.length === 0;
  const turnName = nameOf(state.turn);
  const winnerName =
    typeof state.winner === "number" ? nameOf(state.winner) : null;

  const selectPiece = (piece: number) => {
    playSe("select");
    setSelectedPiece(piece);
    setAnchor(null);
  };

  const place = () => {
    if (!previewLegal || selectedPiece === null || !previewCells) return;
    playSe("play");
    void api.move({ type: "place", piece: selectedPiece, cells: previewCells });
    setSelectedPiece(null);
    setAnchor(null);
  };

  const pass = () => {
    if (!canPass) return;
    playSe("play");
    void api.move({ type: "pass" });
    setSelectedPiece(null);
    setAnchor(null);
  };

  return (
    <div className="og-game og-territory">
      <div className={`og-turn-banner${myTurn ? " og-turn-mine" : ""}${state.finished ? " juice-slide" : myTurn ? " juice-pulse" : ""}`} role="status" aria-live="polite">
        {state.finished ? (
          <span>
            対戦終了：
            {state.winner === "draw"
              ? `引き分け（${state.scores[0]} 対 ${state.scores[1]}）`
              : `勝者 ${winnerName}（${state.scores[0]} 対 ${state.scores[1]}）`}
            {state.winner === mySeat ? "" : ""}
          </span>
        ) : myTurn ? (
          <span>
            あなたの手番です
            {canPass ? "（置ける場所がありません。パスしてください）" : `（置ける手 ${myPlacements.length} 件）`}
          </span>
        ) : (
          <span>{turnName} の手番です（待機中）</span>
        )}
        {state.lastPassSeat !== null && !state.finished && (
          <span className="og-badge">{nameOf(state.lastPassSeat)} がパスしました</span>
        )}
      </div>

      <div className="og-score-row">
        {state.players.map((p) => {
          const remaining = (state.used[p.seat] ?? []).filter((u) => !u).length;
          return (
            <span
              key={p.seat}
              className={`og-score${state.turn === p.seat && !state.finished ? " og-score-turn" : ""}`}
            >
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  background: SEAT_COLORS[p.seat],
                  verticalAlign: -2,
                }}
              />{" "}
              {p.name}
              {p.seat === mySeat ? "（あなた）" : ""}：{state.scores[p.seat]} マス・残りピース {remaining}
            </span>
          );
        })}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        {/* 盤面 */}
        <div
          role="grid"
          aria-label="テリトリオ盤面"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${TERRITORY_SIZE}, minmax(0, 1fr))`,
            gap: 2,
            width: "min(92vw, 420px)",
            padding: 6,
            borderRadius: 10,
            background: "#ddd3bd",
            border: "2px solid #c9b489",
          }}
        >
          {state.board.map((value, index) => {
            const owner: 0 | 1 | -1 = value === 1 ? 0 : value === 2 ? 1 : -1;
            const inPreview = previewSet.has(index);
            const isLast = lastMoveSet.has(index);
            const isCorner = index === 0 || index === TERRITORY_SIZE * TERRITORY_SIZE - 1;
            const cornerSeat = index === 0 ? 0 : 1;
            let background = "#fffdf6";
            if (owner >= 0) background = SEAT_COLORS[owner];
            else if (inPreview) background = previewLegal ? "#8fce6e" : "#e79a8f";
            else if (isCorner) background = SEAT_BG[cornerSeat];
            return (
              <button
                key={index}
                type="button"
                role="gridcell"
                aria-label={`${Math.floor(index / TERRITORY_SIZE) + 1}行${(index % TERRITORY_SIZE) + 1}列${
                  owner >= 0
                    ? ` ${nameOf(owner)}の陣地`
                    : isCorner
                      ? ` ${cornerSeat === 0 ? state.players[0]?.name ?? "" : state.players[1]?.name ?? ""}の開始角`
                      : ""
                }${inPreview ? " プレビュー中" : ""}`}
                disabled={!myTurn || selectedPiece === null}
                className={owner >= 0 && isLast ? "juice-pop" : undefined}
                onClick={() => {
                  playSe("select");
                  setAnchor(index);
                }}
                style={{
                  aspectRatio: "1",
                  border: isLast ? "2px solid #d9a41c" : "1px solid #d8c9a3",
                  borderRadius: 3,
                  background,
                  boxShadow: inPreview ? "inset 0 0 0 2px rgba(0,0,0,0.35)" : undefined,
                  cursor: myTurn && selectedPiece !== null ? "pointer" : "default",
                  touchAction: "manipulation",
                  padding: 0,
                  fontSize: 10,
                  color: SEAT_COLORS[cornerSeat],
                  lineHeight: 1,
                }}
              >
                {owner < 0 && isCorner ? "☆" : ""}
              </button>
            );
          })}
        </div>

        {/* ピースと操作 */}
        <div style={{ flex: "1 1 220px", minWidth: 220 }}>
          <div role="group" aria-label="ピース選択" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {TERRITORY_PIECES.map((def, piece) => {
              const usedByMe = !!state.used[mySeat]?.[piece];
              const shape = transformTerritoryPiece(piece, rotation, flip);
              const maxR = Math.max(...shape.map(([r]) => r));
              const maxC = Math.max(...shape.map(([, c]) => c));
              const cellSet = new Set(shape.map(([r, c]) => `${r},${c}`));
              const selected = selectedPiece === piece;
              return (
                <button
                  key={piece}
                  type="button"
                  disabled={!myTurn || usedByMe}
                  aria-pressed={selected}
                  aria-label={`${def.name}（${def.cells.length}マス）${usedByMe ? " 使用済み" : ""}`}
                  onClick={() => selectPiece(piece)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 2,
                    padding: "6px 6px 4px",
                    minHeight: 48,
                    borderRadius: 8,
                    border: selected ? `3px solid ${SEAT_COLORS[mySeat]}` : "1px solid #c9b489",
                    background: usedByMe ? "#e8e2d4" : "#fffdf6",
                    opacity: usedByMe ? 0.45 : 1,
                    cursor: !myTurn || usedByMe ? "default" : "pointer",
                    touchAction: "manipulation",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: "grid",
                      gridTemplateColumns: `repeat(${maxC + 1}, 9px)`,
                      gap: 1,
                    }}
                  >
                    {Array.from({ length: (maxR + 1) * (maxC + 1) }, (_, i) => {
                      const r = Math.floor(i / (maxC + 1));
                      const c = i % (maxC + 1);
                      const filled = cellSet.has(`${r},${c}`);
                      return (
                        <span
                          key={i}
                          style={{
                            width: 9,
                            height: 9,
                            borderRadius: 2,
                            background: filled ? SEAT_COLORS[mySeat] : "transparent",
                          }}
                        />
                      );
                    })}
                  </span>
                  <span style={{ fontSize: 10, lineHeight: 1.1 }}>{def.name}</span>
                </button>
              );
            })}
          </div>

          <div className="og-actions" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="og-button"
              disabled={selectedPiece === null}
              onClick={() => {
                playSe("click");
                setRotation((r) => (r + 1) % 4);
              }}
            >
              ↻ 回転
            </button>
            <button
              type="button"
              className="og-button"
              disabled={selectedPiece === null}
              onClick={() => {
                playSe("click");
                setFlip((f) => !f);
              }}
            >
              ⇋ 反転
            </button>
            <button
              type="button"
              className="og-button og-button-primary"
              disabled={!previewLegal || api.busy}
              onClick={place}
            >
              ここに置く
            </button>
            <button type="button" className="og-button" disabled={!canPass || api.busy} onClick={pass}>
              パス
            </button>
          </div>
          <p className="og-muted">
            {myTurn && selectedPiece === null && !canPass
              ? "ピースを選んでから、盤面で置く位置（左上）をタップしてください。"
              : myTurn && selectedPiece !== null
                ? previewCells === null
                  ? "盤面をタップするとプレビューが出ます。はみ出す位置には置けません。"
                  : previewLegal
                    ? "置けます。「ここに置く」で確定します。"
                    : "そこには置けません（自分のピースと角で接し、辺では接しない置き方のみ可）。"
                : "自分の角（☆）から始め、自分のピースと角でのみ接するように広げます。両者とも置けなくなったら終了し、マス数の多い方が勝ちです。"}
          </p>
        </div>
      </div>
    </div>
  );
}
