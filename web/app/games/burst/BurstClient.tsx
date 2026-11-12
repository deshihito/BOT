"use client";
// バースト オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/burst.ts の viewFor）:
//   phase selecting: 自分の手札だけ見える。他人の提出は submitted のみ（秘匿）
//   phase choosing: 列を選ぶ必要がある人のみ pendingCard が自分に届く
//   開示と配置は lastSteps / history で確認できる
//   phase finished: standings が付く
// 提出は { type: "play", card }、列の選択は { type: "takeRow", row }。
import { useEffect, useRef, useState } from "react";
import { playSe } from "@/lib/balku-sound";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

/** サーバー側モジュール（lib/online/games/burst.ts）と一致させること。 */
const BU_SELECT_LIMIT_MS = 30000;

type BurstStep = {
  seat: number;
  card: number;
  row: number;
  took: number[];
  tookPenalty: number;
  forced: boolean;
};

type BurstView = {
  phase: "selecting" | "choosing" | "finished";
  round: number;
  totalRounds: number;
  roundEndsAt: number | null;
  chooseEndsAt: number | null;
  rows: { cards: number[]; last: number | null; count: number; penalty: number }[];
  you: {
    seat: number;
    hand: number[];
    submitted: boolean;
    yourCard: number | null;
    left: boolean;
    choosing: boolean;
    pendingCard: number | null;
  };
  players: {
    seat: number;
    name: string;
    penalty: number;
    takenCount: number;
    handCount: number;
    left: boolean;
    submitted: boolean;
  }[];
  lastSteps: BurstStep[];
  standings: { seat: number; penalty: number; rank: number }[] | null;
};

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as BurstView | null;
  const mySeat = view.player.seat;
  const [selected, setSelected] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const finishRef = useRef<string | null>(null);
  const turnKeyRef = useRef<string | null>(null);
  const chooseRef = useRef<boolean>(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setSelected(null);
  }, [state?.round, state?.phase]);

  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    const myRank = state.standings?.find((s) => s.seat === mySeat)?.rank;
    playSe(myRank === 1 ? "win" : "click");
  }, [state, mySeat, view.code]);

  // 新しいラウンドの選択が始まったら知らせる（ラウンド遷移で1回だけ）
  useEffect(() => {
    if (!state || state.phase !== "selecting") return;
    const key = `${view.code}:${state.round}`;
    const prev = turnKeyRef.current;
    turnKeyRef.current = key;
    if (prev !== null && prev !== key && !state.you.submitted && !state.you.left) playSe("turn");
  }, [state, view.code]);

  // 列を選ぶ番になったら知らせる（choosing への遷移で1回だけ）
  useEffect(() => {
    if (!state) return;
    const choosing = state.phase === "choosing" && state.you.choosing;
    const was = chooseRef.current;
    chooseRef.current = choosing;
    if (!was && choosing) playSe("turn");
  }, [state]);

  if (!state) return <p className="og-muted">対戦の開始を待っています…</p>;

  const nameOf = (seat: number) => state.players.find((p) => p.seat === seat)?.name ?? "?";
  const canPlay = state.phase === "selecting" && !state.you.submitted && !state.you.left;
  const deadline = state.phase === "choosing" ? state.chooseEndsAt : state.roundEndsAt;
  const remainingMs = deadline !== null ? Math.max(0, deadline - now) : null;
  const remainingRatio = remainingMs !== null ? remainingMs / BU_SELECT_LIMIT_MS : 0;

  return (
    <div style={{ maxWidth: 680, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : ""} ・ ペナルティ {p.penalty}点 ・ 手札{p.handCount}枚
            {state.phase === "selecting" ? (p.submitted ? " ・ 出した" : " ・ 考え中") : ""}
          </span>
        ))}
      </div>

      {state.phase === "finished" ? (
        <div className="juice-slide" style={{ textAlign: "center", margin: "16px 0" }}>
          <p className="juice-pulse" style={{ fontSize: 20, fontWeight: 700 }}>対戦終了</p>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {(state.standings ?? []).map((s) => (
              <li key={s.seat} style={{ margin: "4px 0" }}>
                {s.rank}位: {nameOf(s.seat)}
                {s.seat === mySeat ? "（あなた）" : ""} ・ ペナルティ {s.penalty}点
              </li>
            ))}
          </ul>
          <p className="og-muted">再戦は下のボタンからどうぞ。</p>
        </div>
      ) : (
        <>
          <p style={{ textAlign: "center", margin: "12px 0 4px" }}>
            ラウンド {state.round + 1} / {state.totalRounds}
            {remainingMs !== null ? ` ・ 残り ${Math.ceil(remainingMs / 1000)} 秒` : ""}
          </p>
          {remainingMs !== null && (
            <div
              aria-hidden
              style={{ height: 6, background: "#eee", borderRadius: 3, overflow: "hidden", margin: "0 0 10px" }}
            >
              <div style={{ height: "100%", width: `${Math.round(remainingRatio * 100)}%`, background: "#e6b93d" }} />
            </div>
          )}

          <div style={{ display: "grid", gap: 6, margin: "8px 0" }} role="group" aria-label="場の列">
            {state.rows.map((row, i) => {
              const chooseMode = state.you.choosing && state.phase === "choosing";
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "wrap",
                    padding: "6px 8px",
                    border: "1px solid var(--line, #ddd)",
                    borderRadius: 8,
                    background: row.count >= 5 ? "#fdf0ee" : undefined,
                  }}
                >
                  <span style={{ fontWeight: 700, minWidth: 44 }}>列{i + 1}</span>
                  {row.cards.map((card, j) => (
                    <span
                      key={`${state.round}-${j}-${card}`}
                      className="juice-pop"
                      style={{
                        display: "inline-block",
                        minWidth: 36,
                        textAlign: "center",
                        padding: "5px 4px",
                        borderRadius: 6,
                        background: j === row.cards.length - 1 ? "#3f7fbf" : "#e8eef5",
                        color: j === row.cards.length - 1 ? "#fff" : undefined,
                        fontWeight: j === row.cards.length - 1 ? 700 : 400,
                      }}
                    >
                      {card}
                    </span>
                  ))}
                  <span className="og-muted">
                    {row.count}枚 ・ 引き取ると {row.penalty}点
                  </span>
                  {chooseMode && (
                    <button
                      type="button"
                      className="og-btn og-btn-primary"
                      style={{ minHeight: 44 }}
                      onClick={() => {
                        playSe("play");
                        void api.move({ type: "takeRow", row: i });
                      }}
                    >
                      この列を取る
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {state.you.choosing ? (
            <p className="juice-pulse" style={{ textAlign: "center", fontWeight: 700, margin: "10px 0" }} role="alert">
              あなたの {state.you.pendingCard} はどの列にも置けません。取る列を選んでください（時間切れでペナルティ最小の列を自動で取ります）。
            </p>
          ) : canPlay ? (
            <>
              <div
                role="group"
                aria-label="出すカードを選ぶ"
                style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", margin: "10px 0" }}
              >
                {state.you.hand.map((card) => (
                  <button
                    key={card}
                    type="button"
                    aria-pressed={selected === card}
                    className={selected === card ? "og-btn og-btn-primary" : "og-btn"}
                    style={{ minWidth: 48, minHeight: 52, fontWeight: 700, fontSize: 16 }}
                    onClick={() => {
                      playSe("select");
                      setSelected(card);
                    }}
                  >
                    {card}
                  </button>
                ))}
              </div>
              <div style={{ textAlign: "center" }}>
                <button
                  type="button"
                  className="og-btn og-btn-primary"
                  style={{ minWidth: 160, minHeight: 48 }}
                  disabled={selected === null}
                  onClick={() => {
                    if (selected !== null) {
                      playSe("play");
                      void api.move({ type: "play", card: selected });
                    }
                  }}
                >
                  {selected !== null ? `${selected} を出す` : "カードを選んでください"}
                </button>
              </div>
            </>
          ) : (
            <p style={{ textAlign: "center", margin: "10px 0" }}>
              {state.you.left
                ? "退出したため、この対戦には参加していません。"
                : state.phase === "choosing"
                  ? "他のプレイヤーが取る列を選んでいます…"
                  : `あなたは ${state.you.yourCard} を出しました。全員の提出を待っています…`}
            </p>
          )}
        </>
      )}

      {state.lastSteps.length > 0 && state.phase !== "finished" && (
        <div className="juice-slide" style={{ marginTop: 14, borderTop: "1px solid var(--line, #ddd)", paddingTop: 10 }}>
          <p style={{ fontWeight: 700, margin: "0 0 6px" }}>直近の配置結果</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {state.lastSteps.map((s, i) => (
              <li key={i}>
                {nameOf(s.seat)} の {s.card} → 列{s.row + 1}
                {s.took.length > 0 ? `（${s.took.join("・")} を引き取り +${s.tookPenalty}点${s.forced ? "、列を選んで引き取り" : ""}）` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function BurstClient() {
  return (
    <OnlineShell gameId="burst" title="バースト" playerRange={{ min: 2, max: 8 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
