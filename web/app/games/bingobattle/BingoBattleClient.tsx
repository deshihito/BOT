"use client";
// ビンゴ対戦 オンラインクライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/bingobattle.ts の viewFor）:
//   drawn は全員共通の公開情報。自分のカードは you.card で全て見えるが、
//   他人のカードは配られず、開いたマス数・リーチ・ビンゴ状態だけが分かる。
//   抽選とマスの開放は自動で進むため、送るアクションは無い。
import { useEffect, useRef } from "react";
import { playSe } from "@/lib/balku-sound";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

type BbViewPlayer = {
  seat: number;
  name: string;
  left: boolean;
  markedCount: number;
  reach: boolean;
  bingo: boolean;
};

type BbStanding = {
  seat: number;
  rank: number;
  markedCount: number;
  bingo: boolean;
  left: boolean;
};

type BbView = {
  phase: "drawing" | "finished";
  drawn: number[];
  lastDrawn: number | null;
  totalDrawn: number;
  maxNumber: number;
  nextDrawAt: number | null;
  you: {
    seat: number;
    left: boolean;
    card: number[];
    marked: boolean[];
    markedCount: number;
    lines: string[];
    reach: boolean;
    bingo: boolean;
  };
  players: BbViewPlayer[];
  winners: number[] | null;
  standings: BbStanding[] | null;
};

const COLUMN_LETTERS = "BINGO";

function ballLabel(n: number): string {
  return `${COLUMN_LETTERS[Math.floor((n - 1) / 15)]}-${n}`;
}

function Board({ view }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as BbView | null;
  const mySeat = view.player.seat;
  const finishRef = useRef<string | null>(null);
  const reachRef = useRef<string | null>(null);
  const startRef = useRef<string | null>(null);

  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    playSe(state.winners?.includes(mySeat) ? "win" : "click");
  }, [state, mySeat, view.code]);

  // 抽選フェーズの開始（対戦開始）を1回だけ知らせる。自分の操作も手番も無い
  // 自動進行ゲームのため、抽選ごとの発火はせず開始の合図だけに留める。
  useEffect(() => {
    if (!state || state.phase !== "drawing") return;
    if (startRef.current === view.code) return;
    startRef.current = view.code;
    playSe("turn");
  }, [state, view.code]);

  useEffect(() => {
    if (!state || state.phase !== "drawing" || !state.you.reach) return;
    const key = `${view.code}:${state.totalDrawn}`;
    if (reachRef.current === key) return;
    reachRef.current = key;
    playSe("click");
  }, [state, view.code]);

  if (!state) return <p className="og-muted">カードを配っています…</p>;

  const you = state.you;
  const completedCells = new Set<number>();
  // 完成ラインのセルを強調するために、ライン定義を you.lines から復元する。
  const lineCells: Record<string, number[]> = {
    row0: [0, 1, 2, 3, 4],
    row1: [5, 6, 7, 8, 9],
    row2: [10, 11, 12, 13, 14],
    row3: [15, 16, 17, 18, 19],
    row4: [20, 21, 22, 23, 24],
    col0: [0, 5, 10, 15, 20],
    col1: [1, 6, 11, 16, 21],
    col2: [2, 7, 12, 17, 22],
    col3: [3, 8, 13, 18, 23],
    col4: [4, 9, 14, 19, 24],
    diag0: [0, 6, 12, 18, 24],
    diag1: [4, 8, 12, 16, 20],
  };
  for (const id of you.lines) {
    for (const i of lineCells[id] ?? []) completedCells.add(i);
  }

  const recent = state.drawn.slice(-15);
  const myWin = state.winners?.includes(mySeat) ?? false;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : ""} ・ {p.markedCount}マス
            {p.bingo ? " ・ ビンゴ！" : p.reach ? " ・ リーチ！" : ""}
          </span>
        ))}
      </div>

      <div style={{ textAlign: "center", padding: "12px 0 4px" }}>
        {state.phase === "drawing" ? (
          <>
            <p className="og-muted">
              抽選 {state.totalDrawn} / {state.maxNumber} 球目
            </p>
            <div key={state.totalDrawn} className="juice-flip" style={{ fontSize: 44, fontWeight: 800, lineHeight: 1.2 }} aria-live="polite">
              {state.lastDrawn !== null ? ballLabel(state.lastDrawn) : "まもなく開始"}
            </div>
            <p className="og-muted">数字は自動で引かれ、カードのマスも自動で開きます。</p>
          </>
        ) : (
          <p className={myWin ? "juice-pulse" : undefined} style={{ fontSize: 22, fontWeight: 700 }}>
            {state.winners && state.winners.length > 0
              ? myWin
                ? "あなたのビンゴ！優勝です。"
                : "ビンゴが出て終了しました。"
              : "終了しました。"}
          </p>
        )}
      </div>

      {recent.length > 0 && (
        <p style={{ textAlign: "center", margin: "4px 0 10px" }} aria-label="最近引かれた数字">
          {recent.map((n, i) => (
            <span
              key={`${n}-${i}`}
              className={i === recent.length - 1 ? "juice-pop" : undefined}
              style={{
                display: "inline-block",
                minWidth: 34,
                padding: "3px 0",
                margin: 2,
                borderRadius: 999,
                fontSize: 13,
                fontWeight: i === recent.length - 1 ? 800 : 500,
                background: i === recent.length - 1 ? "var(--accent-soft)" : "#f0eee9",
                border: "1px solid var(--line)",
              }}
            >
              {n}
            </span>
          ))}
        </p>
      )}

      <div
        role="grid"
        aria-label="あなたのビンゴカード"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
          gap: 4,
          maxWidth: 380,
          margin: "0 auto",
        }}
      >
        {Array.from({ length: 5 }, (_, col) => (
          <div
            key={`h-${col}`}
            style={{ textAlign: "center", fontWeight: 800, fontSize: 16, color: "var(--muted)" }}
            aria-hidden
          >
            {COLUMN_LETTERS[col]}
          </div>
        ))}
        {you.card.map((value, i) => {
          const marked = you.marked[i];
          const inLine = completedCells.has(i);
          const isFree = value === 0;
          const justMarked = marked && state.lastDrawn !== null && value === state.lastDrawn;
          return (
            <div
              key={i}
              className={justMarked ? "juice-pop" : undefined}
              role="gridcell"
              aria-label={
                isFree ? "フリー" : `${ballLabel(value)} ${marked ? "開いた" : "まだ"}`
              }
              style={{
                aspectRatio: "1",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 19,
                fontWeight: 800,
                color: inLine ? "#fff" : "var(--text)",
                background: inLine
                  ? "var(--accent)"
                  : marked
                    ? "#ffe9a8"
                    : "#fff",
                border: "1px solid var(--line)",
                borderRadius: 8,
              }}
            >
              {isFree ? "★" : value}
            </div>
          );
        })}
      </div>

      <p className={`classic-status${you.bingo ? " juice-pulse" : you.reach ? " juice-pop" : ""}`} role="status" style={{ textAlign: "center" }}>
        {you.bingo
          ? `ビンゴ！ ${you.lines.length}ライン完成`
          : you.reach
            ? "リーチ！ あと1マスです。"
            : `開いたマス ${you.markedCount} / 25`}
        {you.left ? "（退出したため脱落しています）" : ""}
      </p>

      {state.phase === "finished" && state.standings && (
        <div className="juice-slide" style={{ padding: "8px 0 4px" }}>
          <h2 className="juice-pulse" style={{ textAlign: "center" }}>結果</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0" }}>
            {state.standings.map((s) => {
              const p = state.players.find((x) => x.seat === s.seat);
              if (!p) return null;
              return (
                <li
                  key={s.seat}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "6px 10px",
                    fontWeight: s.rank === 1 ? 700 : 400,
                  }}
                >
                  <span>
                    {s.rank}位 {p.name}
                    {s.seat === mySeat ? "（あなた）" : ""}
                    {s.left ? "（退出）" : ""}
                  </span>
                  <strong>
                    {s.markedCount}マス{s.bingo ? " ・ ビンゴ" : ""}
                  </strong>
                </li>
              );
            })}
          </ul>
          <p className="og-muted">
            抽選は {state.totalDrawn} 球目で決着しました。再戦は下のボタンからどうぞ。
          </p>
        </div>
      )}
    </div>
  );
}

export default function BingoBattleClient() {
  return (
    <OnlineShell gameId="bingobattle" title="ビンゴ対戦" playerRange={{ min: 2, max: 8 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
