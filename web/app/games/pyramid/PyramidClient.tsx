"use client";
// ピラミッド（ソリティア）。ロジックは lib/pyramid.ts。
// 合計13のペアか K 単体を取り除く。下の2枚が無くなったカードから使える。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useState } from "react";
import {
  canRemove,
  createPyramid,
  exposedSlots,
  flipPyramidStock,
  pyramidIsRed,
  pyramidRankLabel,
  pyramidSlotPos,
  pyramidSuitSymbol,
  removePyramidCards,
  PYRAMID_ROWS,
  PYRAMID_SLOTS,
  type PyramidCard,
  type PyramidState,
  type PyramidTarget,
} from "@/lib/pyramid";
import { useGamesNav } from "../GamesShell";

function CardFace({ card }: { card: PyramidCard }) {
  return (
    <span
      style={{
        display: "grid",
        placeItems: "center",
        width: 46,
        height: 62,
        borderRadius: 7,
        border: "2px solid #c9b489",
        background: "#fffdf6",
        color: pyramidIsRed(card.suit) ? "#c0392b" : "#243447",
        fontWeight: 800,
        fontSize: 16,
        lineHeight: 1.05,
        textAlign: "center",
      }}
    >
      <span>
        {pyramidSuitSymbol(card.suit)}
        <br />
        {pyramidRankLabel(card.rank)}
      </span>
    </span>
  );
}

export default function PyramidClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<PyramidState>(() =>
    createPyramid(Date.now() % 2147483647),
  );
  const [selected, setSelected] = useState<PyramidTarget | null>(null);

  const restart = () => {
    setState(createPyramid(Date.now() % 2147483647));
    setSelected(null);
  };

  const wasteTop = state.waste.length > 0 ? state.waste[state.waste.length - 1] : null;
  const exposed = new Set(exposedSlots(state));

  const onTarget = (target: PyramidTarget, card: PyramidCard) => {
    if (state.status !== "playing") return;
    // K は単体で取り除ける（選択中でも K 自体の除去を優先する）。
    if (card.rank === 13 && canRemove(state, [target])) {
      setState((s) => removePyramidCards(s, [target]));
      setSelected(null);
      return;
    }
    if (selected === null) {
      setSelected(target);
      return;
    }
    const sameTarget =
      selected.kind === target.kind &&
      (selected.kind === "waste" ||
        (target.kind === "pyramid" && selected.slot === target.slot));
    if (sameTarget) {
      setSelected(null);
      return;
    }
    if (canRemove(state, [selected, target])) {
      const pair: [PyramidTarget, PyramidTarget] = [selected, target];
      setState((s) => removePyramidCards(s, pair));
      setSelected(null);
    } else {
      // 合計13にならない場合は、選択を今のカードへ移す。
      setSelected(target);
    }
  };

  const statusText =
    state.status === "won"
      ? "ピラミッドを全部消した！クリアです。"
      : state.status === "stuck"
        ? "取り除ける組み合わせがもうありません。"
        : `残り ${PYRAMID_SLOTS - state.removed} 枚 ・ ${state.moves} 手`;

  const isSelected = (target: PyramidTarget) =>
    selected !== null &&
    selected.kind === target.kind &&
    (selected.kind === "waste" ||
      (target.kind === "pyramid" && selected.slot === target.slot));

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ピラミッド</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ピラミッド</h1>
        <p className="muted">カードをタップで選ぶと、合計13の相方を探せます。選択中のカードをもう一度タップすると解除できます。</p>
      </div>

      <div className="classic-controls">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {statusText}
        {selected !== null ? " ・ もう1枚選んでください（合計13で消えます）" : ""}
      </p>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 4,
          width: "100%",
          overflowX: "auto",
          padding: "4px 0",
        }}
        role="group"
        aria-label="ピラミッド"
      >
        {Array.from({ length: PYRAMID_ROWS }, (_, row) => (
          <div key={row} style={{ display: "flex", gap: 4, justifyContent: "center" }}>
            {Array.from({ length: row + 1 }, (_, col) => {
              const slot = (row * (row + 1)) / 2 + col;
              const card = state.pyramid[slot];
              if (card === null) {
                return <span key={slot} style={{ width: 46, height: 62 }} aria-hidden="true" />;
              }
              const isExposed = exposed.has(slot);
              const sel = isSelected({ kind: "pyramid", slot });
              const pos = pyramidSlotPos(slot);
              return (
                <button
                  key={slot}
                  type="button"
                  disabled={!isExposed || state.status !== "playing"}
                  aria-label={`${pyramidSuitSymbol(card.suit)}${pyramidRankLabel(card.rank)}${isExposed ? "" : "（覆われています）"}`}
                  aria-pressed={sel}
                  onClick={() => onTarget({ kind: "pyramid", slot }, card)}
                  style={{
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    borderRadius: 8,
                    outline: sel ? "3px solid #d9a41c" : "none",
                    outlineOffset: 1,
                    opacity: isExposed ? 1 : 0.45,
                    cursor: isExposed ? "pointer" : "default",
                    touchAction: "manipulation",
                  }}
                  data-row={pos.row}
                  data-col={pos.col}
                >
                  <CardFace card={card} />
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          gap: 20,
          justifyContent: "center",
          alignItems: "flex-start",
          marginTop: 14,
          flexWrap: "wrap",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <button
            type="button"
            className="classic-btn"
            disabled={state.status === "won" || (state.stock.length === 0 && state.waste.length === 0)}
            onClick={() => {
              setState((s) => flipPyramidStock(s));
            }}
            aria-label={state.stock.length > 0 ? "ストックを1枚めくる" : "捨て山を裏返して再利用"}
          >
            {state.stock.length > 0 ? `🂠 めくる（残り ${state.stock.length}）` : "↩ 捨て山を再利用"}
          </button>
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>ストック</p>
        </div>
        <div style={{ textAlign: "center" }}>
          {wasteTop ? (
            <button
              type="button"
              disabled={state.status !== "playing"}
              aria-label={`捨て山の一番上 ${pyramidSuitSymbol(wasteTop.suit)}${pyramidRankLabel(wasteTop.rank)}`}
              aria-pressed={isSelected({ kind: "waste" })}
              onClick={() => onTarget({ kind: "waste" }, wasteTop)}
              style={{
                padding: 0,
                border: "none",
                background: "transparent",
                borderRadius: 8,
                outline: isSelected({ kind: "waste" }) ? "3px solid #d9a41c" : "none",
                outlineOffset: 1,
                cursor: "pointer",
                touchAction: "manipulation",
              }}
            >
              <CardFace card={wasteTop} />
            </button>
          ) : (
            <span
              style={{
                display: "grid",
                placeItems: "center",
                width: 46,
                height: 62,
                borderRadius: 7,
                border: "2px dashed #c9b489",
                color: "#6b5f45",
                fontSize: 12,
              }}
            >
              なし
            </span>
          )}
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
            捨て山（{state.waste.length} 枚）
          </p>
        </div>
      </div>

      <p className="muted" style={{ textAlign: "center", fontSize: 13 }}>
        A=1、J=11、Q=12 として、2枚の合計が13になれば消せます。K は1枚で消えます。
        ストックが尽きたら、捨て山を裏返してもう一度使えます。
      </p>
    </>
  );
}
