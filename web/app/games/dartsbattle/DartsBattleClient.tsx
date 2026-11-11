"use client";
// ダーツ対戦 オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/dartsbattle.ts の viewFor）:
//   players[]: total / throws（全投擲・公開） / left / rank（終了時のみ）
//   turn / round / throwsThisTurn / lastThrow
// 提出は { type: "throw", x, y }（0〜1000 の正規化座標）。
// 着弾点の微ブレと得点判定はサーバー側で行われる。
import { useEffect, useRef } from "react";
import { playSe } from "@/lib/balku-sound";
import { DART_SECTORS } from "@/lib/darts";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

const SEAT_COLORS = ["#ffd54a", "#4fc3f7", "#ff8a65", "#a5d6a7"];

type DbThrowView = { x: number; y: number; score: number; label: string };

type DbView = {
  players: {
    seat: number;
    name: string;
    total: number;
    throws: DbThrowView[];
    left: boolean;
    rank: number | null;
  }[];
  turn: number;
  round: number;
  totalRounds: number;
  throwsThisTurn: number;
  finished: boolean;
  lastThrow: { seat: number; hit: DbThrowView } | null;
  you: { seat: number; left: boolean };
};

function polar(r: number, degFromTop: number): { x: number; y: number } {
  const rad = (degFromTop * Math.PI) / 180;
  return { x: r * Math.sin(rad), y: -r * Math.cos(rad) };
}

function wedgePath(rOuter: number, rInner: number, a0: number, a1: number): string {
  const p0 = polar(rOuter, a0);
  const p1 = polar(rOuter, a1);
  if (rInner <= 0) {
    return `M 0 0 L ${p0.x} ${p0.y} A ${rOuter} ${rOuter} 0 0 1 ${p1.x} ${p1.y} Z`;
  }
  const p2 = polar(rInner, a1);
  const p3 = polar(rInner, a0);
  return `M ${p0.x} ${p0.y} A ${rOuter} ${rOuter} 0 0 1 ${p1.x} ${p1.y} L ${p2.x} ${p2.y} A ${rInner} ${rInner} 0 0 0 ${p3.x} ${p3.y} Z`;
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as DbView | null;
  const mySeat = view.player.seat;
  const finishRef = useRef<string | null>(null);

  useEffect(() => {
    if (!state || !state.finished) return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    const myRank = state.players.find((p) => p.seat === mySeat)?.rank;
    playSe(myRank === 1 ? "win" : "click");
  }, [state, mySeat, view.code]);

  if (!state) return <p className="og-muted">対戦の開始を待っています…</p>;

  const myTurn = !state.finished && state.turn === mySeat && !state.you.left;
  const turnPlayer = state.players[state.turn];

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!myTurn) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 240 - 120;
    const ny = ((e.clientY - rect.top) / rect.height) * 240 - 120;
    const x = Math.round(((nx + 120) / 240) * 1000);
    const y = Math.round(((ny + 120) / 240) * 1000);
    if (x < 0 || x > 1000 || y < 0 || y > 1000) return;
    playSe("play");
    void api.move({ type: "throw", x, y });
  };

  // このラウンドの投擲だけを盤上に表示する。
  const roundDarts: { hit: DbThrowView; seat: number; key: string }[] = [];
  for (const p of state.players) {
    p.throws.forEach((hit, i) => {
      if (Math.floor(i / 3) === state.round) {
        roundDarts.push({ hit, seat: p.seat, key: `${p.seat}-${i}` });
      }
    });
  }

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: SEAT_COLORS[p.seat % SEAT_COLORS.length],
                border: "1px solid #5d4037",
                marginRight: 4,
              }}
            />
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : ""} ・ {p.total}点
            {!state.finished && state.turn === p.seat ? " ・ 投擲中" : ""}
          </span>
        ))}
      </div>

      {!state.finished ? (
        <>
          <p style={{ margin: "10px 0 4px", fontWeight: 800, textAlign: "center" }}>
            ラウンド {Math.min(state.round + 1, state.totalRounds)} / {state.totalRounds}
            {turnPlayer
              ? ` ・ ${turnPlayer.name}${state.turn === mySeat ? "（あなた）" : ""}の番（あと ${3 - state.throwsThisTurn} 投）`
              : ""}
          </p>
          <p className="og-muted" style={{ textAlign: "center", margin: "0 0 8px" }}>
            {state.you.left
              ? "退出したため、この対戦では投げられません。"
              : myTurn
                ? "ボードをタップして投げてください。着弾点には少しブレがあります。"
                : "相手の投擲を待っています。"}
            {state.lastThrow
              ? ` 直前: ${state.players[state.lastThrow.seat]?.name ?? ""} の ${state.lastThrow.hit.label}（${state.lastThrow.hit.score}点）`
              : ""}
          </p>
          <svg
            viewBox="-120 -120 240 240"
            role="img"
            aria-label="ダーツボード"
            onClick={handleClick}
            style={{
              width: "min(88vw, 420px)",
              height: "auto",
              display: "block",
              margin: "0 auto",
              cursor: myTurn ? "crosshair" : "default",
              touchAction: "manipulation",
            }}
          >
            <circle cx={0} cy={0} r={118} fill="#22252a" />
            {DART_SECTORS.map((num, i) => {
              const a0 = i * 18 - 9;
              const a1 = i * 18 + 9;
              const color = i % 2 === 0 ? "#c0392b" : "#1e8449";
              const base = i % 2 === 0 ? "#1b1b1b" : "#e8dcc0";
              const labelPos = polar(110, i * 18);
              return (
                <g key={num}>
                  <path d={wedgePath(100, 0, a0, a1)} fill={color} />
                  <path d={wedgePath(94, 0, a0, a1)} fill={base} />
                  <path d={wedgePath(58, 53, a0, a1)} fill={color} />
                  <text x={labelPos.x} y={labelPos.y} fill="#f5f5f5" fontSize={11} fontWeight={700} textAnchor="middle" dominantBaseline="middle">
                    {num}
                  </text>
                </g>
              );
            })}
            <circle cx={0} cy={0} r={16} fill="#1e8449" />
            <circle cx={0} cy={0} r={7} fill="#c0392b" />
            {roundDarts.map(({ hit, seat, key }) => (
              <circle
                key={key}
                cx={hit.x * 100}
                cy={-hit.y * 100}
                r={3.4}
                fill={SEAT_COLORS[seat % SEAT_COLORS.length]}
                stroke="#212121"
                strokeWidth={1}
              />
            ))}
          </svg>
        </>
      ) : (
        <div style={{ textAlign: "center" }}>
          <h2 style={{ fontSize: 24, margin: "10px 0" }}>結果発表</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
            {[...state.players]
              .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || b.total - a.total)
              .map((p) => (
                <li
                  key={p.seat}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "12px 16px",
                    borderRadius: 12,
                    border: p.rank === 1 ? "2px solid #d9a41c" : "1px solid #e5e7eb",
                    background: p.rank === 1 ? "#fff3c4" : "#fffdf6",
                    fontWeight: p.seat === mySeat ? 800 : 400,
                  }}
                >
                  <span>
                    {p.rank !== null ? `${p.rank}位 ` : ""}
                    {p.name}
                    {p.seat === mySeat ? "（あなた）🎉" : ""}
                    {p.left ? "（退出）" : ""}
                  </span>
                  <strong>{p.total}点</strong>
                </li>
              ))}
          </ul>
          <p className="og-muted">全{state.totalRounds}ラウンドが終わりました。再戦は下のボタンからどうぞ。</p>
        </div>
      )}
    </div>
  );
}

export default function DartsBattleClient() {
  return (
    <OnlineShell gameId="dartsbattle" title="ダーツ対戦" playerRange={{ min: 2, max: 4 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
