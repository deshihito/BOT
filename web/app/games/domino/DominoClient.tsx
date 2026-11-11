"use client";
// ドミノ（オンライン）クライアント。ルーム管理は OnlineShell が担い、
// このコンポーネントは view.state（ゲーム別ビュー）の描画と操作だけを持つ。
// 契約: view.state.yourHand は自分の手札（牌 id 配列）、他人は others[].count
// （枚数）だけが見える。場は board（向き付きチェーン）、両端は leftEnd/rightEnd。
// 操作は { type: "place", tile, side } / { type: "draw" } / { type: "pass" }。
import { dominoTilePips } from "@/lib/online/games/domino";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

type DominoPlaced = { tile: number; left: number; right: number };
type DominoLogEntry = {
  seat: number;
  kind: "place" | "draw" | "pass" | "finish" | "win" | "left";
  tile?: number;
  side?: "left" | "right";
};
type DominoState = {
  yourHand: number[];
  others: { seat: number; name: string; count: number; left: boolean }[];
  board: DominoPlaced[];
  leftEnd: number | null;
  rightEnd: number | null;
  boneyardCount: number;
  turn: number;
  finished: boolean;
  scores: number[];
  winners: number[];
  yourPlayable: number[];
  canDraw: boolean;
  canPass: boolean;
  log: DominoLogEntry[];
  players: { seat: number; name: string }[];
};

function TileFace({
  a,
  b,
  vertical,
}: {
  a: number;
  b: number;
  vertical?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        flexDirection: vertical ? "column" : "row",
        alignItems: "center",
        gap: 2,
        fontWeight: 700,
        fontSize: 14,
        lineHeight: 1.1,
      }}
    >
      <span>{a}</span>
      <span
        style={{
          display: "block",
          width: vertical ? 14 : 1,
          height: vertical ? 1 : 14,
          background: "#94a3b8",
        }}
      />
      <span>{b}</span>
    </span>
  );
}

export default function DominoClient() {
  return (
    <OnlineShell gameId="domino" title="ドミノ" playerRange={{ min: 2, max: 4 }}>
      {(view, api) => <DominoTable view={view} api={api} />}
    </OnlineShell>
  );
}

function DominoTable({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as DominoState | null;
  const mySeat = view.player.seat;
  if (!state) return <p className="muted">読み込み中です…</p>;

  const myTurn = !state.finished && state.turn === mySeat;
  const nameOf = (seat: number) =>
    state.players.find((p) => p.seat === seat)?.name ?? `プレイヤー${seat + 1}`;

  const placeableSides = (tile: number): ("left" | "right")[] => {
    if (!state.yourPlayable.includes(tile)) return [];
    if (state.board.length === 0) return ["left"];
    const [a, b] = dominoTilePips(tile);
    const sides: ("left" | "right")[] = [];
    if (state.leftEnd !== null && (a === state.leftEnd || b === state.leftEnd)) sides.push("left");
    if (state.rightEnd !== null && (a === state.rightEnd || b === state.rightEnd)) sides.push("right");
    return sides;
  };

  const statusText = state.finished
    ? state.winners.includes(mySeat)
      ? "あなたの勝ちです！"
      : `勝者: ${state.winners.map((s) => nameOf(s)).join("、")}`
    : myTurn
      ? state.yourPlayable.length > 0
        ? "出せる牌が光っています。置く側のボタンを押してください。"
        : state.canDraw
          ? "出せる牌がありません。山から引いてください。"
          : "出せる牌がなく、山も尽きました。パスしてください。"
      : `${nameOf(state.turn)}の手番です。`;

  return (
    <div>
      <p className="classic-status" role="status">
        {statusText}
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {state.others.map((o) => (
          <span
            key={o.seat}
            style={{
              border: "1px solid #cbd5e1",
              borderRadius: 999,
              padding: "3px 10px",
              fontSize: 13,
              background: state.turn === o.seat && !state.finished ? "#fef3c7" : "#ffffff",
            }}
          >
            {o.name}: 残り{o.count}枚{o.left ? "（退出）" : ""}
          </span>
        ))}
        <span
          style={{
            border: "1px solid #cbd5e1",
            borderRadius: 999,
            padding: "3px 10px",
            fontSize: 13,
            background: "#f8fafc",
          }}
        >
          山 {state.boneyardCount}枚
        </span>
      </div>

      <div
        role="group"
        aria-label="場のチェーン"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          alignItems: "center",
          minHeight: 54,
          border: "1px solid #e2e8f0",
          borderRadius: 10,
          padding: 8,
          background: "#f8fafc",
          marginBottom: 12,
        }}
      >
        {state.board.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>
            まだ牌は置かれていません。
          </span>
        ) : (
          state.board.map((p, i) => (
            <span
              key={`${p.tile}-${i}`}
              style={{
                border: "1px solid #94a3b8",
                borderRadius: 6,
                background: "#ffffff",
                padding: "4px 7px",
                boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
              }}
            >
              <TileFace a={p.left} b={p.right} />
            </span>
          ))
        )}
      </div>
      {state.board.length > 0 ? (
        <p className="muted" style={{ fontSize: 13, marginTop: -6, marginBottom: 12 }}>
          左端 {state.leftEnd} ・ 右端 {state.rightEnd}
        </p>
      ) : null}

      <h2 style={{ fontSize: 15, margin: "8px 0" }}>あなたの手札（{state.yourHand.length}枚）</h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {state.yourHand.map((tile) => {
          const [a, b] = dominoTilePips(tile);
          const sides = myTurn ? placeableSides(tile) : [];
          return (
            <span
              key={tile}
              style={{
                display: "inline-flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 3,
                border: sides.length > 0 ? "2px solid #d97706" : "1px solid #cbd5e1",
                borderRadius: 8,
                background: sides.length > 0 ? "#fffbeb" : "#ffffff",
                padding: "5px 7px",
              }}
            >
              <TileFace a={a} b={b} vertical />
              {sides.length > 0 ? (
                <span style={{ display: "flex", gap: 3 }}>
                  {sides.map((side) => (
                    <button
                      key={side}
                      type="button"
                      className="classic-btn"
                      style={{ padding: "2px 8px", fontSize: 12 }}
                      aria-label={`${a}と${b}の牌を${side === "left" ? "左" : "右"}端に置く`}
                      onClick={() => void api.move({ type: "place", tile, side })}
                    >
                      {state.board.length === 0 ? "置く" : side === "left" ? "←左" : "右→"}
                    </button>
                  ))}
                </span>
              ) : null}
            </span>
          );
        })}
      </div>

      {myTurn && (state.canDraw || state.canPass) ? (
        <div className="classic-controls" role="group" aria-label="引く・パス">
          {state.canDraw ? (
            <button
              type="button"
              className="classic-btn classic-btn-active"
              onClick={() => void api.move({ type: "draw" })}
            >
              山から引く
            </button>
          ) : null}
          {state.canPass ? (
            <button
              type="button"
              className="classic-btn classic-btn-active"
              onClick={() => void api.move({ type: "pass" })}
            >
              パスする
            </button>
          ) : null}
        </div>
      ) : null}

      {state.finished ? (
        <div style={{ marginTop: 12 }}>
          <h2 style={{ fontSize: 15, margin: "8px 0" }}>結果（残り手札の目の合計・小さいほど上位）</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {state.players.map((p) => (
              <li key={p.seat}>
                {p.name}: {state.scores[p.seat] >= 9999 ? "退出" : `${state.scores[p.seat]}点`}
                {state.winners.includes(p.seat) ? " 🏆" : ""}
              </li>
            ))}
          </ul>
          <p className="muted">再戦は下のボタンからどうぞ。</p>
        </div>
      ) : null}

      {state.log.length > 0 ? (
        <ul
          aria-label="進行ログ"
          style={{ marginTop: 12, paddingLeft: 18, fontSize: 13, color: "#475569" }}
        >
          {state.log.slice(-6).map((entry, i) => (
            <li key={i}>
              {nameOf(entry.seat)}
              {entry.kind === "place"
                ? ` が牌を${entry.side === "left" ? "左" : "右"}に置いた`
                : entry.kind === "draw"
                  ? " が山から引いた"
                  : entry.kind === "pass"
                    ? " がパスした"
                    : entry.kind === "finish"
                      ? " が手札を出し切った"
                      : entry.kind === "win"
                        ? " の勝ち"
                        : " が退出した"}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
